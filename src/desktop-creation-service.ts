import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createDesktopConversationId } from "./desktop-identity.js";
import { DesktopCreationNativeError, type DesktopCreationNative, type DesktopCreatedThread } from "./desktop-creation-native.js";
import type { DesktopCreationStore, DesktopCreationRecord, DesktopCreationRequest } from "./desktop-creation-store.js";
import type { DesktopSnapshot, DesktopThreadIdentity } from "./desktop-types.js";
import type { DesktopTaskService } from "./desktop-task-service.js";

export interface DesktopCreationServiceDependencies {
  store: DesktopCreationStore;
  connect(codexHome: string): Promise<DesktopCreationNative>;
  defaultDirectory(operationId: string): string;
  open(threadId: string): Promise<void>;
  observe(target: DesktopThreadIdentity): Promise<DesktopSnapshot>;
  tasks: Pick<DesktopTaskService, "send" | "status">;
  now?(): Date;
  sleep?(ms: number): Promise<void>;
  ownerAttempts?: number;
  processId?: number;
  isProcessAlive?(pid: number): boolean;
}
export interface DesktopCreationRun {
  operationId: string; controllerSession: string; input?: DesktopCreationRequest; resume?: boolean;
}
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_-]{1,80}$/u.test(code) ? code : "desktop_creation_failed";
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as { code?: string }).code !== "ESRCH"; }
}
function identity(r: DesktopCreationRecord): DesktopThreadIdentity {
  if (!r.threadId) throw new Error("Desktop creation has no native thread");
  return { codexHome: r.input.codexHome, hostId: "local", threadId: r.threadId };
}
const identityErrors = new Set(["creation_identity_mismatch", "thread_target_mismatch", "desktop_identity_mismatch", "process_exit_unconfirmed"]);
/** Each invocation owns a durable claim, but no file lock spans native I/O. */
export function createDesktopCreationService(deps: DesktopCreationServiceDependencies) {
  return { run: (input: DesktopCreationRun) => new DesktopCreationInvocation(deps, input).run() };
}
class DesktopCreationInvocation {
  private readonly token = randomUUID();
  private r!: DesktopCreationRecord;
  constructor(private readonly deps: DesktopCreationServiceDependencies, private readonly input: DesktopCreationRun) {}
  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }
  private current(): DesktopCreationRecord {
    const record = this.deps.store.load(this.r.id);
    if (!record) throw new Error("Desktop creation operation not found");
    return record;
  }
  private claim(): boolean {
    let claimed = false;
    const input = this.input;
    this.r = this.deps.store.update(input.operationId, old => {
      if (old) {
        if (old.controllerSession !== input.controllerSession || (!input.resume && !isDeepStrictEqual(old.input, input.input))
          || (input.resume && input.input !== undefined && !isDeepStrictEqual(old.input, input.input))) {
          throw new Error("Desktop creation operation belongs to different immutable input or controller");
        }
        if (["failed", "uncertain"].includes(old.status)
          || old.worker && (this.deps.isProcessAlive ?? processAlive)(old.worker.pid)) return old;
      } else if (input.resume || !input.input) {
        throw new Error("Desktop creation operation not found; recovery cannot create a new conversation");
      }
      const next: DesktopCreationRecord = old ?? { schema: "agent-knock-knock/desktop-creation", version: 1, id: input.operationId,
        controllerSession: input.controllerSession, input: input.input!, status: "prepared", createdAt: this.now(), updatedAt: this.now() };
      next.worker = { token: this.token, pid: this.deps.processId ?? process.pid, startedAt: this.now() };
      next.updatedAt = this.now(); claimed = true;
      return next;
    });
    return claimed;
  }
  private update(change: (record: DesktopCreationRecord) => void): DesktopCreationRecord {
    return this.deps.store.update(this.r.id, latest => {
      if (!latest || latest.worker?.token !== this.token) throw new Error("Desktop creation invocation lost its reservation");
      change(latest); latest.updatedAt = this.now(); return latest;
    });
  }
  private recordError(error: unknown, status?: DesktopCreationRecord["status"]): DesktopCreationRecord {
    return this.update(latest => {
      if (latest.status === "uncertain") return;
      latest.errorCode = errorCode(error);
      if (identityErrors.has(latest.errorCode)) latest.status = "uncertain";
      else if (status) latest.status = status;
    });
  }
  async run(): Promise<DesktopCreationRecord> {
    if (!this.claim()) return this.r;
    try {
      if (this.r.status === "prepared") await this.create();
      else if (this.r.status === "creating" && !this.r.threadId) {
        this.update(latest => { latest.status = "uncertain"; latest.errorCode = "creation_receipt_missing"; });
      } else if (["creating", "created", "opening"].includes(this.r.status)) await this.verifyCreated();
      this.r = this.current();
      if (["created", "opening"].includes(this.r.status) && !this.r.errorCode) await this.handoff();
      this.r = this.current();
      if (this.r.status === "ready" && this.r.input.request && !this.r.watchId) {
        try {
          this.update(latest => { latest.requestState = "uncertain"; });
          const task = await this.deps.tasks.send({ target: identity(this.r), desktopId: createDesktopConversationId(identity(this.r)),
            controllerSession: this.r.controllerSession, messageId: this.r.id, text: this.r.input.request,
            timeoutMs: this.r.input.timeoutMs, callbackRoute: this.r.input.callbackRoute, requireEmptyThread: true });
          this.update(latest => { latest.watchId = task.id;
            latest.requestState = task.send_intent?.state === "accepted" ? "accepted"
              : task.send_intent?.state === "not_sent" ? "not_sent" : "uncertain";
            delete latest.errorCode; });
        } catch (error) { this.update(latest => {
          latest.errorCode = errorCode(error);
          if ((error as { dispatchState?: string })?.dispatchState === "not_sent") latest.requestState = "not_sent";
        }); }
      }
    } finally {
      // If a process dies, its PID remains on disk and the next invocation can reconcile exactly this UUID.
      this.update(latest => { delete latest.worker; });
    }
    return this.current();
  }
  private async create(): Promise<void> {
    let native: DesktopCreationNative | undefined, dispatched = false, completed = false;
    try {
      native = await this.deps.connect(this.r.input.codexHome);
      let cwd = this.r.input.cwd, projectId: string | undefined, projectName: string | undefined;
      if (this.r.input.project) {
        const selected = await native.resolveProject({ ...(/^[0-9a-f-]{36}$/iu.test(this.r.input.project)
          ? { projectId: this.r.input.project } : { projectName: this.r.input.project }), ...(cwd ? { cwd } : {}) });
        cwd = selected.cwd; projectId = selected.project.id; projectName = selected.project.name;
      }
      cwd ??= this.deps.defaultDirectory(this.r.id);
      cwd = fs.realpathSync(cwd);
      const receipt = await native.create({ cwd, projectId, title: this.r.input.title,
        sandbox: "workspace-write", approvalPolicy: "on-request",
        beforeDispatch: () => { this.update(latest => {
          if (latest.status !== "prepared") throw new Error("Creation already reserved");
          latest.status = "creating"; latest.cwd = cwd; latest.projectId = projectId ?? null;
          latest.projectName = projectName; delete latest.errorCode; dispatched = true;
        }); },
        onCreated: receipt => {
          const latest = this.update(record => {
            record.threadId = receipt.threadId;
            record.nativeTitle = receipt.title;
            try { validateReceipt(record, receipt); }
            catch { record.status = "uncertain"; record.errorCode = "creation_identity_mismatch"; }
          });
          if (latest.status === "uncertain") throw new DesktopCreationNativeError("creation_identity_mismatch", "Created Desktop identity differs", "created", receipt.threadId);
        }
      });
      this.update(latest => { validateReceipt(latest, receipt); latest.threadId = receipt.threadId; latest.nativeTitle = receipt.title; });
      completed = true;
    } catch (error) {
      const latest = this.current();
      if (latest.status !== "uncertain") this.update(record => {
        const stage = (error as { dispatchState?: unknown })?.dispatchState;
        record.errorCode = errorCode(error);
        const threadId = (error as { threadId?: unknown })?.threadId;
        if (!record.threadId && typeof threadId === "string" && /^[0-9a-f-]{36}$/iu.test(threadId)) record.threadId = threadId;
        record.status = identityErrors.has(record.errorCode) ? "uncertain"
          : record.threadId ? "creating" : dispatched && stage !== "not_sent" ? "uncertain" : "failed";
      });
    } finally {
      try { await native?.close(); }
      catch (error) { completed = false; this.recordError(error); }
    }
    if (completed) this.update(latest => { latest.status = "created"; delete latest.errorCode; });
  }
  private async verifyCreated(): Promise<void> {
    let native: DesktopCreationNative | undefined, verified = false;
    try {
      native = await this.deps.connect(this.r.input.codexHome);
      const receipt = await native.read(this.r.threadId!);
      validateReceipt(this.r, receipt);
      this.update(latest => { latest.nativeTitle = receipt.title; });
      verified = true;
    } catch (error) { this.recordError(error); }
    finally {
      try { await native?.close(); } catch (error) { verified = false; this.recordError(error); }
    }
    if (verified) this.update(latest => { latest.status = latest.openedAt ? "opening" : "created"; delete latest.errorCode; });
  }
  private async handoff(): Promise<void> {
    this.r = this.current();
    if (!this.r.openedAt) {
      this.update(latest => { latest.openedAt = this.now(); latest.status = "opening"; });
      try { await this.deps.open(this.r.threadId!); }
      catch (error) { this.recordError(error); return; }
    }
    for (let attempt = 0; attempt < (this.deps.ownerAttempts ?? 3); attempt++) {
      try {
        const snapshot = await this.deps.observe(identity(this.r));
        if (snapshot.threadId !== this.r.threadId || snapshot.cwd !== undefined && snapshot.cwd !== this.r.cwd) {
          throw Object.assign(new Error("Desktop owner identity is not verified"), { code: "desktop_identity_mismatch" });
        }
        if (!snapshot.ownerClientId || !snapshot.cwd || !snapshot.tailKnown) {
          throw Object.assign(new Error("Desktop owner is still loading"), { code: "desktop_owner_not_ready" });
        }
        this.update(latest => { latest.status = "ready"; delete latest.errorCode; }); return;
      } catch (error) {
        const latest = this.recordError(error);
        if (latest.status === "uncertain") return;
      }
      if (attempt + 1 < (this.deps.ownerAttempts ?? 3)) await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(300);
    }
  }
}

function validateReceipt(r: DesktopCreationRecord, receipt: DesktopCreatedThread): void {
  if (receipt.cwd !== r.cwd || receipt.projectId !== r.projectId || r.threadId && r.threadId !== receipt.threadId) {
    throw new DesktopCreationNativeError("creation_identity_mismatch", "Created Desktop thread identity or project differs", "created", r.threadId);
  }
}
