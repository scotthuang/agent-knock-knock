import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson } from "./canonical-json.js";
import { createCallbackEnvelope, parseCallbackRoute, type CallbackRouteV1 } from "./callback-transport.js";
import { resolveMonitorHardTimeoutMs } from "./monitor-deadline-policy.js";
import { assertBackendRecoveryOwner, backendObservationStopped, backendRenewalDeadline,
  closeBackendManagement, prepareBackendCallbackRetry, stopBackendObservation } from "./backend-task-recovery.js";
import { createClaudeNativeConversationId, ClaudeNativeError, type ClaudeNativeCatalogEntry, type ClaudeNativeIdentity } from "./claude-native-identity.js";
import type { ClaudeNativeClient } from "./claude-native-client.js";
import type { ClaudeNativeSnapshot, ClaudeNativeObservationOptions } from "./claude-native-observation.js";
import { createClaudeNativeNotificationOutbox, type ClaudeNativeOutboxDependencies } from "./claude-native-outbox.js";
import type { ClaudeNativeTaskRecord } from "./claude-native-state-store.js";

export interface ClaudeNativeTaskInput {
  target: ClaudeNativeIdentity; nativeId: string; controllerSession: string;
  callbackRoute?: CallbackRouteV1; timeoutMs?: number;
}
export interface ClaudeNativeTaskDependencies extends ClaudeNativeOutboxDependencies {
  inspect(identity: ClaudeNativeIdentity): Promise<ClaudeNativeCatalogEntry>;
  observe(entry: ClaudeNativeCatalogEntry, options: ClaudeNativeObservationOptions): Promise<ClaudeNativeSnapshot>;
  send: ClaudeNativeClient["send"];
  acceptancePollAttempts?: number; acceptancePollIntervalMs?: number;
  sleep?(ms: number): Promise<void>;
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const active = (task: ClaudeNativeTaskRecord) => !backendObservationStopped(task) && ["watching", "awaiting_acceptance"].includes(task.status);
const unresolved = (task: ClaudeNativeTaskRecord) => task.kind === "send" && !task.closed_at && !task.native_input_id &&
  ["reserved", "uncertain", "held"].includes(task.send_intent?.state ?? "");
export function claudeNativeTaskNeedsReconciliation(task: ClaudeNativeTaskRecord): boolean {
  return task.notifications.some(n => n.status === "leased") || !backendObservationStopped(task) &&
    (active(task) || task.notifications.some(n => ["ready", "retry_wait"].includes(n.status)));
}
export function claudeNativeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[\w-]{1,100}$/u.test(code) ? code : "claude_observation_unavailable";
}
export function createClaudeNativeTaskService(deps: ClaudeNativeTaskDependencies) {
  return new ClaudeNativeTasks(deps);
}
export class ClaudeNativeTasks {
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly outbox: ReturnType<typeof createClaudeNativeNotificationOutbox>;
  constructor(private readonly deps: ClaudeNativeTaskDependencies) {
    this.now = deps.now ?? (() => new Date()); this.uuid = deps.randomUUID ?? randomUUID;
    this.outbox = createClaudeNativeNotificationOutbox(deps);
  }
  status(id: string): ClaudeNativeTaskRecord {
    const task = this.deps.repository.load(id);
    if (!task) throw new ClaudeNativeError("watch_not_found", "Claude native Watch was not found"); return task;
  }
  list() { return this.deps.repository.list(); }
  shouldMonitor(id: string) { return claudeNativeTaskNeedsReconciliation(this.status(id)); }
  private update(id: string, operation: (task: ClaudeNativeTaskRecord) => void) {
    return this.deps.repository.withLock(id, () => {
      const task = this.status(id); operation(task); task.updated_at = this.now().toISOString();
      return this.deps.repository.save(task, task.revision);
    });
  }
  private make(input: ClaudeNativeTaskInput, id: string, kind: "send" | "watch", entry: ClaudeNativeCatalogEntry): ClaudeNativeTaskRecord {
    if (!input.controllerSession?.trim() || createClaudeNativeConversationId(input.target) !== input.nativeId || entry.nativeId !== input.nativeId) {
      throw new ClaudeNativeError("invalid_argument", "Claude task requires an exact identity and controller");
    }
    const timeout = resolveMonitorHardTimeoutMs(input.timeoutMs);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 7 * 24 * 3600000) throw new ClaudeNativeError("invalid_argument", "Claude timeout must be within seven days");
    const route = input.callbackRoute ? parseCallbackRoute(input.callbackRoute) : undefined;
    if (route && route.controller_session_id !== input.controllerSession) throw new ClaudeNativeError("controller_mismatch", "Callback owner differs");
    const timestamp = this.now().toISOString();
    return { schema: "agent-knock-knock/claude-native-task", version: 1, revision: 1, id, watch_id: id,
      native_id: input.nativeId, target: structuredClone(input.target), entry: structuredClone(entry),
      controller_session: input.controllerSession, kind, status: kind === "send" ? "awaiting_acceptance" : "watching",
      created_at: timestamp, updated_at: timestamp, deadline_at: new Date(this.now().getTime() + timeout).toISOString(),
      ...(route ? { callback_route: route } : {}), notifications: [] };
  }
  private notify(task: ClaudeNativeTaskRecord, key: string, message: string) {
    if (!task.callback_route || backendObservationStopped(task)) return;
    const id = `${task.id}:${key}`; if (task.notifications.some(n => n.id === id)) return;
    task.notifications.push({ id, attempts: 0, status: "ready", envelope: createCallbackEnvelope({ route: task.callback_route,
      source: { kind: "claude_native_watch", watch_id: task.id, native_id: task.native_id },
      event: { id, type: `claude_native_watch.${key.split(":")[0]}`, body: message, requires_response: false,
        metadata: { watch_id: task.id, conversation_id: task.native_id, session_id: task.target.sessionId,
          ...(task.native_input_id ? { native_input_id: task.native_input_id } : {}), status: task.status } } }) });
  }
  private sameSend(old: ClaudeNativeTaskRecord, input: ClaudeNativeTaskInput & { messageId: string; text: string }) {
    if (old.kind !== "send" || old.native_id !== input.nativeId || old.controller_session !== input.controllerSession ||
      old.send_intent?.message_id !== input.messageId || old.send_intent.text !== input.text ||
      !isDeepStrictEqual(old.callback_route, input.callbackRoute ? parseCallbackRoute(input.callbackRoute) : undefined)) {
      throw new ClaudeNativeError("idempotency_conflict", "Message ID was already used with different content or target");
    }
    return old;
  }
  async send(input: ClaudeNativeTaskInput & { messageId: string; text: string }): Promise<ClaudeNativeTaskRecord> {
    if (!input.messageId?.trim() || !input.text?.trim() || Buffer.byteLength(input.text) > 256 * 1024) throw new ClaudeNativeError("invalid_argument", "Claude Send requires bounded text and a message ID");
    const id = `claude-cli-watch:${digest([input.controllerSession, input.messageId])}`;
    const previous = this.deps.repository.load(id); if (previous) return this.sameSend(previous, input);
    const entry = await this.deps.inspect(input.target);
    if (entry.status !== "idle") throw new ClaudeNativeError("session_not_idle", "Claude is busy, waiting, or unknown; a standalone task cannot be sent");
    for (const old of this.list().filter(t => t.native_id === input.nativeId && active(t))) await this.reconcile(old.id);
    let created = false;
    const reserved = this.deps.repository.withLock(`claude-cli-watch:target-${digest(input.target)}`, () => {
      const raced = this.deps.repository.load(id); if (raced) return this.sameSend(raced, input);
      if (this.list().some(t => t.native_id === input.nativeId && (active(t) || unresolved(t)))) {
        throw new ClaudeNativeError("send_unresolved", "An earlier exact task or send outcome is still unresolved; do not resend");
      }
      const task = this.make(input, id, "send", entry);
      task.send_intent = { message_id: input.messageId, text: input.text, client_user_message_id: this.uuid(),
        native_message_id: this.uuid(), state: "reserved", dispatched_at: task.created_at };
      const saved = this.deps.repository.save(task, null); created = true; return saved;
    });
    if (!created) return reserved;
    let receipt;
    try {
      receipt = await this.deps.send(input.target, { text: input.text, inputUuid: reserved.send_intent!.client_user_message_id,
        messageId: reserved.send_intent!.native_message_id,
        beforeDispatch: async (current, senderPid) => {
          if (current.nativeId !== input.nativeId || current.status !== "idle" || !Number.isSafeInteger(senderPid) || senderPid! < 1) {
            throw new ClaudeNativeError("sender_identity_unavailable", "Exact Claude sender identity must be persisted before input");
          }
          this.update(id, task => {
            if (!active(task) || task.send_intent?.state !== "reserved") throw new ClaudeNativeError("send_stopped", "Send reservation is no longer active");
            task.send_intent.state = "uncertain"; task.send_intent.sender_pid = senderPid;
          });
        } });
    } catch {
      receipt = { dispatchState: "uncertain" as const, errorCode: "send_outcome_unknown" };
    }
    this.update(id, task => {
      const intent = task.send_intent!;
      // A concurrent observer can prove acceptance while the transport receipt is still pending.
      if (!active(task) || task.native_input_id || intent.state === "accepted") return;
      if (receipt.dispatchState === "not_sent" || ["refused", "expired"].includes(receipt.deliveryStatus ?? "")) {
        intent.state = receipt.dispatchState === "not_sent" ? "not_sent" : "refused";
        intent.error_code = receipt.errorCode ?? receipt.deliveryStatus ?? "not_sent";
        task.status = "failed"; task.observation_error = intent.error_code;
      } else {
        intent.state = receipt.deliveryStatus === "held" ? "held" : "uncertain";
        if (receipt.errorCode) intent.error_code = receipt.errorCode;
      }
    });
    const attempts = Math.max(1, this.deps.acceptancePollAttempts ?? 5);
    for (let i = 0; i < attempts; i++) {
      const current = await this.reconcile(id);
      if (current.status !== "awaiting_acceptance") return current;
      if (i + 1 < attempts) await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(this.deps.acceptancePollIntervalMs ?? 100);
    }
    return this.status(id);
  }
  async watch(input: ClaudeNativeTaskInput): Promise<ClaudeNativeTaskRecord> {
    const entry = await this.deps.inspect(input.target);
    if (!["working", "waiting"].includes(entry.status)) throw new ClaudeNativeError("no_active_task", "No active Claude task can be anchored");
    const snapshot = await this.deps.observe(entry, {}), selected = snapshot.selectedInput;
    if (snapshot.readError || !selected || selected.inputUuid !== snapshot.latestInputUuid || selected.kind !== "root_user" || selected.state !== "inProgress") {
      throw new ClaudeNativeError("task_anchor_unavailable", "Current Claude input is not a verified active root task");
    }
    return this.deps.repository.withLock(`claude-cli-watch:target-${digest(input.target)}`, () => {
      const old = this.list().find(t => t.native_id === input.nativeId && t.controller_session === input.controllerSession &&
        t.native_input_id === selected.inputUuid && active(t));
      if (old) {
        if (!isDeepStrictEqual(old.callback_route, input.callbackRoute)) throw new ClaudeNativeError("callback_route_conflict", "Existing task callback route differs");
        return old;
      }
      const task = this.make(input, `claude-cli-watch:${this.uuid()}`, "watch", entry);
      task.native_input_id = selected.inputUuid; task.source = snapshot.source;
      task.progress = snapshot.progress; task.observed_at = snapshot.readAt;
      return this.deps.repository.save(task, null);
    });
  }
  private apply(task: ClaudeNativeTaskRecord, snapshot: ClaudeNativeSnapshot) {
    if (createClaudeNativeConversationId(snapshot.identity) !== task.native_id) { task.observation_error = "identity_mismatch"; return; }
    task.observed_at = snapshot.readAt;
    if (snapshot.readError) { task.observation_error = snapshot.readError; task.progress = snapshot.progress; return; }
    const expected = task.native_input_id ?? task.send_intent?.client_user_message_id;
    const selected = snapshot.selectedInput;
    if (!selected || selected.inputUuid !== expected) { task.observation_error = "missing_exact_input"; return; }
    if (task.send_intent && (selected.messageId !== task.send_intent.native_message_id || selected.origin !== "peer" ||
      !task.send_intent.sender_pid || selected.verifiedPeerPid !== task.send_intent.sender_pid)) {
      task.observation_error = "input_provenance_mismatch"; return;
    }
    if (selected.kind !== "root_user") {
      if (task.send_intent) task.send_intent.state = "attached";
      task.status = "failed"; task.observation_error = "input_joined_existing_task";
      this.notify(task, "settled", `Claude input was absorbed into an existing task. Independent completion is unproven. Do not resend. Watch: ${task.id}`); return;
    }
    task.native_input_id = selected.inputUuid; task.source ??= snapshot.source;
    if (task.send_intent) task.send_intent.state = "accepted";
    task.status = "watching"; delete task.observation_error;
    task.progress = snapshot.progress;
    task.response_text = selected.responseText; task.response_truncated = selected.responseTruncated;
    if (["completed", "failed", "interrupted"].includes(selected.state)) {
      task.status = selected.state as "completed" | "failed" | "interrupted";
      delete task.waiting_for;
      this.notify(task, "settled", `Claude task ${task.status}.\nwatch_id: ${task.id}\nnative_input_id: ${task.native_input_id}\n${task.response_text ?? ""}`);
    } else if (selected.state === "unknown") task.observation_error = selected.reason ?? "native_result_unknown";
  }
  async reconcile(id: string): Promise<ClaudeNativeTaskRecord> {
    const before = this.status(id);
    if (active(before)) {
      let snapshot: ClaudeNativeSnapshot | undefined, error: string | undefined, entry: ClaudeNativeCatalogEntry | undefined;
      try {
        // Observe only the original PID/start/session. An exited original cannot be completed from a resumed process.
        snapshot = await this.deps.observe(before.entry, { exactInputUuid: before.native_input_id ?? before.send_intent?.client_user_message_id,
          messageId: before.send_intent?.native_message_id, expectedPeerPid: before.send_intent?.sender_pid, source: before.source });
        entry = await this.deps.inspect(before.target);
      } catch (e) { error = claudeNativeErrorCode(e); }
      this.update(id, task => {
        if (!active(task)) return;
        if (error === "process_exited" || error === "process_changed") {
          task.status = "exited"; task.observation_error = error;
          this.notify(task, "settled", `Original Claude process exited or changed. Task completion is unproven. Watch: ${task.id}`);
        } else if (error) task.observation_error = error;
        else if (snapshot) {
          this.apply(task, snapshot);
          task.waiting_for = active(task) && entry?.status === "waiting" && snapshot.latestInputUuid === task.native_input_id
            ? entry.waitingFor ?? "manual_interaction" : undefined;
        }
        if (active(task) && Date.parse(task.deadline_at) <= this.now().getTime()) {
          task.status = "timed_out";
          this.notify(task, `timed_out${task.renewal_count ? `:${task.renewal_count}` : ""}`, `Claude Watch expired; the native task may still be running. Watch: ${task.id}`);
        }
      });
    }
    await this.outbox.deliverPending(id); return this.status(id);
  }
  async reconcileAll() {
    const scan = this.deps.repository.scanForReconciliation(); const tasks: ClaudeNativeTaskRecord[] = [], errors = [...scan.errors];
    for (const task of scan.tasks) {
      try { tasks.push(claudeNativeTaskNeedsReconciliation(task) ? await this.reconcile(task.id) : task); }
      catch (error) { errors.push({ id: task.id, error_code: claudeNativeErrorCode(error) }); }
    }
    return { tasks, errors };
  }
  unwatch(id: string, input: { controllerSession: string }) {
    return this.update(id, task => { assertBackendRecoveryOwner(task, input); stopBackendObservation(task, this.now()); });
  }
  close(id: string, input: { controllerSession: string; reason?: string }) {
    return this.update(id, task => closeBackendManagement(task, input, this.now()));
  }
  async renew(id: string, input: { controllerSession: string; timeoutMs?: number }) {
    const task = this.status(id); assertBackendRecoveryOwner(task, input);
    if (["completed", "failed", "interrupted", "exited"].includes(task.status)) throw new ClaudeNativeError("task_settled", "Settled Claude task cannot renew");
    const deadline = backendRenewalDeadline(task, this.now(), input.timeoutMs);
    const entry = await this.deps.inspect(task.target);
    const snapshot = await this.deps.observe(entry, { exactInputUuid: task.native_input_id ?? task.send_intent?.client_user_message_id,
      messageId: task.send_intent?.native_message_id, expectedPeerPid: task.send_intent?.sender_pid, source: task.source });
    if (snapshot.readError || snapshot.selectedInput?.state !== "inProgress" || snapshot.selectedInput.kind !== "root_user" ||
      snapshot.selectedInput.inputUuid !== snapshot.latestInputUuid ||
      snapshot.selectedInput.inputUuid !== (task.native_input_id ?? task.send_intent?.client_user_message_id)) {
      throw new ClaudeNativeError("renewal_anchor_unavailable", "Renew requires the same verified active native task");
    }
    return this.update(id, current => {
      assertBackendRecoveryOwner(current, input);
      if (current.closed_at || ["completed", "failed", "interrupted", "exited"].includes(current.status)) throw new ClaudeNativeError("task_settled", "Task is closed or settled");
      current.deadline_at = deadline; current.renewed_at = this.now().toISOString(); current.renewal_count = (current.renewal_count ?? 0) + 1;
      delete current.unwatched_at; current.status = current.native_input_id ? "watching" : "awaiting_acceptance";
    });
  }
  async recover(id: string, input: { controllerSession: string }) {
    assertBackendRecoveryOwner(this.status(id), input);
    this.update(id, task => { task.recovered_at = this.now().toISOString(); });
    return this.reconcile(id);
  }
  async retryCallback(id: string, input: { controllerSession: string; notificationId?: string }) {
    let notificationId = "";
    this.update(id, task => { notificationId = prepareBackendCallbackRetry(task, input, this.now()); });
    await this.outbox.deliverPending(id, notificationId); return this.status(id);
  }
}
