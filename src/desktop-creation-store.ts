import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { atomicSaveJsonFile, readJsonFileNoFollow, isNodeError } from "./durable-json-file.js";
import { assertStoreReadable, ensureDir, withStoreWriterLease } from "./store.js";
import type { CallbackRouteV1 } from "./callback-transport.js";

export interface DesktopCreationRequest {
  codexHome: string; project?: string; cwd?: string; title: string; request?: string;
  timeoutMs: number; callbackRoute?: CallbackRouteV1;
}
export interface DesktopCreationRecord {
  schema: "agent-knock-knock/desktop-creation"; version: 1;
  id: string; controllerSession: string; input: DesktopCreationRequest;
  status: "prepared" | "creating" | "created" | "opening" | "ready" | "uncertain" | "failed";
  createdAt: string; updatedAt: string;
  threadId?: string; cwd?: string; projectId?: string | null; projectName?: string;
  openedAt?: string; errorCode?: string; watchId?: string;
  requestState?: "not_sent" | "uncertain" | "accepted";
  nativeTitle?: string | null;
  /** Reservation for one live invocation; dead workers are reconciled, never blindly replayed. */
  worker?: { pid: number; token: string; startedAt: string };
}
export interface DesktopCreationStore {
  load(id: string): DesktopCreationRecord | undefined;
  update(id: string, change: (record: DesktopCreationRecord | undefined) => DesktopCreationRecord): DesktopCreationRecord;
}
export function assertDesktopCreationId(value: string): void {
  if (!/^desktop-create:[0-9a-f]{64}$/u.test(value)) throw new Error("Invalid Desktop creation operation ID");
}
function validInput(input: DesktopCreationRequest | undefined): boolean {
  return Boolean(input && typeof input.codexHome === "string" && path.isAbsolute(input.codexHome)
    && typeof input.title === "string" && input.title.trim()
    && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0
    && (input.cwd === undefined || typeof input.cwd === "string" && path.isAbsolute(input.cwd))
    && (input.project === undefined || typeof input.project === "string" && !!input.project.trim())
    && (input.request === undefined || typeof input.request === "string" && !!input.request.trim()));
}
function validWorker(worker: DesktopCreationRecord["worker"]): boolean {
  return worker === undefined || Boolean(worker && Number.isSafeInteger(worker.pid) && worker.pid > 0
    && typeof worker.token === "string" && worker.token && Number.isFinite(Date.parse(worker.startedAt)));
}
function validTarget(r: DesktopCreationRecord): boolean {
  if (r.threadId !== undefined && !/^[0-9a-f-]{36}$/iu.test(r.threadId)) return false;
  if (r.cwd !== undefined && (typeof r.cwd !== "string" || !path.isAbsolute(r.cwd))) return false;
  if (r.projectId !== undefined && r.projectId !== null && !/^[0-9a-f-]{36}$/iu.test(r.projectId)) return false;
  return !["created", "opening", "ready"].includes(r.status) || Boolean(r.threadId && r.cwd);
}
function validProgress(r: DesktopCreationRecord): boolean {
  if (r.openedAt !== undefined && !Number.isFinite(Date.parse(r.openedAt))) return false;
  if (r.requestState !== undefined && !["not_sent", "uncertain", "accepted"].includes(r.requestState)) return false;
  return r.nativeTitle === undefined || r.nativeTitle === null || typeof r.nativeTitle === "string";
}
function validate(value: unknown, id: string): asserts value is DesktopCreationRecord {
  const r = value as DesktopCreationRecord;
  if (!r || r.schema !== "agent-knock-knock/desktop-creation" || r.version !== 1 || r.id !== id
    || typeof r.controllerSession !== "string" || !r.controllerSession.trim() || !validInput(r.input)
    || !["prepared", "creating", "created", "opening", "ready", "uncertain", "failed"].includes(r.status)
    || !Number.isFinite(Date.parse(r.createdAt)) || !Number.isFinite(Date.parse(r.updatedAt))
    || !validWorker(r.worker) || !validTarget(r) || !validProgress(r)) {
    throw new Error("Invalid Desktop creation record");
  }
}
/** Short synchronous store leases protect reservations; no lock is held across native I/O. */
export function createDesktopCreationStore(storeDir: string): DesktopCreationStore {
  const root = path.join(storeDir, "desktop-creations");
  const file = (id: string) => { assertDesktopCreationId(id); return path.join(root, `${id}.json`); };
  const load = (id: string): DesktopCreationRecord | undefined => {
    assertStoreReadable(storeDir);
    try {
      const name = file(id), stat = fs.lstatSync(name);
      if ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error("Desktop creation record must be private");
      const r = readJsonFileNoFollow(name, "Desktop creation"); validate(r, id); return r;
    } catch (error) { if (isNodeError(error, "ENOENT")) return undefined; throw error; }
  };
  return { load, update(id, change) { return withStoreWriterLease(storeDir, () => {
    const old = load(id), next = change(old && structuredClone(old)); validate(next, id);
    if (old) {
      for (const key of ["id", "controllerSession", "input", "createdAt"] as const) {
        if (!isDeepStrictEqual(old[key], next[key])) throw new Error("Desktop creation immutable input changed");
      }
      if (old.threadId && old.threadId !== next.threadId) throw new Error("Desktop creation thread cannot change");
      if (old.watchId && old.watchId !== next.watchId) throw new Error("Desktop creation Watch cannot change");
      if (old.cwd && old.cwd !== next.cwd || old.projectId !== undefined && old.projectId !== next.projectId) {
        throw new Error("Desktop creation resolved target cannot change");
      }
      if (["failed", "uncertain"].includes(old.status) && old.status !== next.status) {
        throw new Error("Desktop creation failed or uncertain operation cannot be replayed");
      }
      if (old.openedAt && old.openedAt !== next.openedAt) throw new Error("Desktop creation open reservation cannot change");
    }
    atomicSaveJsonFile(file(id), next, { rootLabel: "AKK store", directoryLabel: "Desktop creations", fileLabel: "Desktop creation", ensureDirectory: ensureDir });
    return next;
  }); } };
}
