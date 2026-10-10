import { resolveMonitorHardTimeoutMs } from "./monitor-deadline-policy.js";
import { backendObservationStopped, backendRenewalDeadline, isBackendCallbackRetryable,
  prepareBackendCallbackRetry, stopBackendObservation, closeBackendManagement } from "./backend-task-recovery.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createCallbackEnvelope, parseCallbackRoute, type CallbackRouteV1 } from "./callback-transport.js";
import { canonicalJson } from "./canonical-json.js";
import { createNativeNotificationOutbox, type NativeOutboxDependencies } from "./codex-native-outbox.js";
import { nativeInteractionProjection } from "./codex-native-public-projection.js";
import { assertNativeIdentity, persistNativeInteraction, type CodexNativeTaskRecord } from "./codex-native-state-store.js";
import type { CodexNativeIdentity, CodexNativeReceipt, CodexNativeSnapshot, CodexNativeTurn, NativeInteraction } from "./codex-native-types.js";

export interface CodexNativeTaskInput {
  target: CodexNativeIdentity;
  nativeId: string;
  controllerSession: string;
  callbackRoute?: CallbackRouteV1;
  timeoutMs?: number;
}
export interface CodexNativeSendInput extends CodexNativeTaskInput { messageId: string; text: string }
export interface CodexNativeTransportPort {
  observe(identity: CodexNativeIdentity, exactTurnId?: string): Promise<CodexNativeSnapshot>;
  start(identity: CodexNativeIdentity, input: { text: string; clientUserMessageId: string;
    beforeDispatch?(snapshot: CodexNativeSnapshot): Promise<void> }): Promise<CodexNativeReceipt>;
}
export interface CodexNativeTaskServiceDependencies extends CodexNativeTransportPort, NativeOutboxDependencies {
  /** Briefly observe a returned native receipt while history materializes; never retry the send. */
  acceptancePollAttempts?: number;
  acceptancePollIntervalMs?: number;
  sleep?(milliseconds: number): Promise<void>;
}
export class CodexNativeTaskError extends Error {
  constructor(public readonly code: string, message: string, public readonly dispatchState?: "not_sent") { super(message); this.name = "CodexNativeTaskError"; }
}
export interface CodexNativeTaskService {
  send(input: CodexNativeSendInput): Promise<CodexNativeTaskRecord>;
  watch(input: CodexNativeTaskInput): Promise<CodexNativeTaskRecord>;
  status(id: string): CodexNativeTaskRecord;
  list(): CodexNativeTaskRecord[];
  reconcile(id: string): Promise<CodexNativeTaskRecord>;
  reconcileAll(): Promise<{ tasks: CodexNativeTaskRecord[]; errors: { id: string; error_code: string }[] }>;
  unwatch(id: string, input: { controllerSession: string }): CodexNativeTaskRecord;
  close(id: string, input: { controllerSession: string; reason?: string }): CodexNativeTaskRecord;
  renew(id: string, input: { controllerSession: string; timeoutMs?: number }): Promise<CodexNativeTaskRecord>;
  recover(id: string, input: { controllerSession: string }): Promise<CodexNativeTaskRecord>;
  retryCallback(id: string, input: { controllerSession: string; notificationId?: string }): Promise<CodexNativeTaskRecord>;
}
export const nativeDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const stopped = backendObservationStopped;
const live = (task: CodexNativeTaskRecord) => !stopped(task) && (task.status === "awaiting_acceptance" || task.status === "watching");
const unresolvedSend = (task: CodexNativeTaskRecord) => task.kind === "send" && !task.closed_at &&
  !task.native_turn_id && ["reserved", "uncertain"].includes(task.send_intent?.state ?? "");
export function codexNativeTaskNeedsReconciliation(task: CodexNativeTaskRecord): boolean {
  return task.notifications.some(n => n.status === "leased") ||
    !stopped(task) && (live(task) || task.notifications.some(n => ["ready", "retry_wait"].includes(n.status)));
}
export function nativeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(code) ? code : "codex_native_observation_unavailable";
}
export function nativeTurn(snapshot: CodexNativeSnapshot, turnId: string): CodexNativeTurn | undefined {
  const turns = snapshot.turns.filter(turn => turn.id === turnId);
  if (turns.length > 1) return undefined;
  return turns[0] ?? (snapshot.selectedTurn?.id === turnId ? snapshot.selectedTurn : undefined);
}
function assertSnapshot(target: CodexNativeIdentity, snapshot: CodexNativeSnapshot): void {
  if (snapshot.threadId !== target.threadId || snapshot.thread.id !== target.threadId) throw new CodexNativeTaskError("codex_native_identity_mismatch", "Native observation did not match the exact thread");
}
function submission(snapshot: CodexNativeSnapshot, clientId: string, text: string): CodexNativeTurn | undefined {
  const matches = snapshot.turns.flatMap(turn => turn.items.filter(item => item.type === "userMessage" && item.clientId === clientId)
    .map(item => ({ turn, item })));
  if (snapshot.selectedTurn && !snapshot.turns.some(turn => turn.id === snapshot.selectedTurn!.id)) {
    matches.push(...snapshot.selectedTurn.items.filter(item => item.type === "userMessage" && item.clientId === clientId).map(item => ({ turn: snapshot.selectedTurn!, item })));
  }
  if (matches.length !== 1 || !matches[0].turn.itemsComplete) return undefined;
  const itemText = matches[0].item.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n") ?? matches[0].item.text;
  return itemText === text ? matches[0].turn : undefined;
}
function finalText(turn: CodexNativeTurn): string {
  const messages = turn.items.filter(item => item.type === "agentMessage" && typeof item.text === "string");
  const final = messages.filter(item => item.phase === "final_answer");
  return (final.length ? final : messages.filter(item => item.phase == null)).map(item => item.text).join("\n\n");
}
function interactionMessage(task: CodexNativeTaskRecord, interaction: NativeInteraction): string {
  const summary = interaction.kind.endsWith("approval")
    ? `${interaction.kind}: ${interaction.command ?? interaction.reason ?? interaction.itemId}`
    : interaction.questions.map(question => `${question.title}${question.options.length ? ` (${question.options.join(" / ")})` : ""}`).join("\n");
  return `Codex CLI task ${task.id} needs a response.\n${summary}\n` +
    `conversation_id: ${task.native_id}\nwatch_id: ${task.id}\ninteraction_id: ${interaction.id}\n` +
    `Use AKK ${interaction.kind.endsWith("approval") ? "Approve" : "Respond"} with this exact interaction_id. AKK continues watching the same task.\n` +
    JSON.stringify(nativeInteractionProjection(interaction, task.native_id, task.id));
}

export function createCodexNativeTaskService(deps: CodexNativeTaskServiceDependencies): CodexNativeTaskService {
  return new CodexNativeTaskRuntime(deps);
}

class CodexNativeTaskRuntime implements CodexNativeTaskService {
  private readonly repo: CodexNativeTaskServiceDependencies["repository"];
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly outbox: ReturnType<typeof createNativeNotificationOutbox>;
  constructor(private readonly deps: CodexNativeTaskServiceDependencies) {
    this.repo = deps.repository;
    this.now = deps.now ?? (() => new Date());
    this.uuid = deps.randomUUID ?? randomUUID;
    this.outbox = createNativeNotificationOutbox(deps);
  }
  status(id: string): CodexNativeTaskRecord {
    const task = this.repo.load(id); if (!task) throw new CodexNativeTaskError("codex_native_watch_not_found", "Codex CLI Watch was not found"); return task;
  }
  private update(id: string, operation: (task: CodexNativeTaskRecord) => void): CodexNativeTaskRecord {
    return this.repo.withLock(id, () => { const task = this.status(id); operation(task); task.updated_at = this.now().toISOString(); return this.repo.save(task, task.revision); });
  }
  private notify(task: CodexNativeTaskRecord, key: string, body: string, interaction?: NativeInteraction) {
    if (!task.callback_route || stopped(task)) return;
    const id = `${task.id}:${key}`; if (task.notifications.some(n => n.id === id)) return;
    task.notifications.push({ id, attempts: 0, status: "ready", envelope: createCallbackEnvelope({ route: task.callback_route,
      source: { kind: "codex_native_watch", watch_id: task.id, native_id: task.native_id },
      event: { id, type: `codex_native_watch.${key.split(":")[0]}`, body, requires_response: Boolean(interaction),
        metadata: { watch_id: task.id, conversation_id: task.native_id, thread_id: task.target.threadId,
          ...(task.native_turn_id ? { turn_id: task.native_turn_id } : {}),
          ...(interaction ? { interaction_id: interaction.id, interaction: nativeInteractionProjection(interaction, task.native_id, task.id), action: interaction.kind.endsWith("approval") ? "approve" : "respond" } : {}) } }
    }) });
  }
  private make(input: CodexNativeTaskInput, id: string, kind: "send" | "watch"): CodexNativeTaskRecord {
    if (!input.controllerSession?.trim()) throw new CodexNativeTaskError("invalid_argument", "Native task controller is required");
    assertNativeIdentity(input.nativeId, input.target);
    const timeout = resolveMonitorHardTimeoutMs(input.timeoutMs);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 7 * 24 * 3_600_000) throw new CodexNativeTaskError("invalid_argument", "Native Watch timeout must be between one millisecond and seven days");
    const route = input.callbackRoute === undefined ? undefined : parseCallbackRoute(input.callbackRoute);
    if (route && route.controller_session_id !== input.controllerSession) throw new CodexNativeTaskError("callback_controller_mismatch", "Native callback belongs to a different controller");
    const date = this.now();
    return { schema: "agent-knock-knock/codex-native-task", version: 1, revision: 1, id, watch_id: id, native_id: input.nativeId,
      target: structuredClone(input.target), controller_session: input.controllerSession, kind,
      status: kind === "send" ? "awaiting_acceptance" : "watching", created_at: date.toISOString(), updated_at: date.toISOString(),
      deadline_at: new Date(date.getTime() + timeout).toISOString(), ...(route ? { callback_route: route } : {}), pending_interactions: [], notifications: [] };
  }
  private duplicate(task: CodexNativeTaskRecord, input: CodexNativeSendInput) {
    if (task.kind !== "send" || task.controller_session !== input.controllerSession || !isDeepStrictEqual(task.target, input.target) ||
      task.native_id !== input.nativeId || task.send_intent?.message_id !== input.messageId || task.send_intent.text !== input.text ||
      !isDeepStrictEqual(task.callback_route, input.callbackRoute)) throw new CodexNativeTaskError("codex_native_message_id_conflict", "Message ID is already bound to different immutable send input");
    return task;
  }
  private bindSubmission(task: CodexNativeTaskRecord, snapshot: CodexNativeSnapshot): void {
    const intent = task.send_intent;
    if (intent && !task.native_turn_id) {
      const turn = submission(snapshot, intent.client_user_message_id, intent.text);
      if (turn && !intent.baseline_turn_ids.includes(turn.id) && (!intent.receipt_turn_id || intent.receipt_turn_id === turn.id)) {
        task.native_turn_id = turn.id; intent.state = "accepted"; task.status = "watching";
      } else {
        if (intent.state !== "reserved") intent.state = "uncertain";
        task.observation_error = turn ? "codex_native_submission_turn_conflict" : "codex_native_submission_not_observed";
      }
    }
  }
  private apply(task: CodexNativeTaskRecord, snapshot: CodexNativeSnapshot, refresh = false) {
    assertSnapshot(task.target, snapshot); task.observed_at = this.now().toISOString(); delete task.observation_error;
    if (task.closed_at || ["completed", "failed", "interrupted"].includes(task.status) || !refresh && !live(task)) return;
    this.bindSubmission(task, snapshot);
    if (!task.native_turn_id) return;
    const turn = nativeTurn(snapshot, task.native_turn_id);
    if (!turn) { task.observation_error = "codex_native_exact_turn_unavailable"; return; }
    const pending = turn.status === "inProgress" ? snapshot.pendingInteractions.filter(i => i.threadId === task.target.threadId && i.turnId === task.native_turn_id) : [];
    task.pending_interactions = pending.map(persistNativeInteraction);
    for (const n of task.notifications) {
      const pendingId = n.envelope.event.metadata?.interaction_id;
      if (typeof pendingId === "string" && !pending.some(i => i.id === pendingId) && ["ready", "retry_wait"].includes(n.status)) {
        n.status = "failed"; n.outcome = { disposition: "permanent_failure", error_code: "codex_native_interaction_resolved" };
      }
    }
    for (const interaction of pending) this.notify(task, `interaction:${interaction.id}`, interactionMessage(task, interaction), interaction);
    if (["completed", "failed", "interrupted"].includes(turn.status)) {
      if (!turn.itemsComplete) { task.observation_error = "codex_native_exact_items_incomplete"; return; }
      task.status = turn.status as "completed" | "failed" | "interrupted"; task.final_text = finalText(turn);
      this.notify(task, "settled", `Codex CLI task ${task.id} ${task.status}.\n${task.final_text || turn.error || "No final text was recorded."}`);
    }
  }
  async reconcile(id: string): Promise<CodexNativeTaskRecord> {
    const previous = this.status(id);
    const recover = !stopped(previous) && previous.status === "timed_out" && unresolvedSend(previous);
    if (live(previous) || recover) {
      let snapshot: CodexNativeSnapshot | undefined; let error: string | undefined;
      try { snapshot = await this.deps.observe(previous.target, previous.native_turn_id ?? previous.send_intent?.receipt_turn_id); }
      catch (caught) { error = nativeErrorCode(caught); }
      this.update(id, task => {
        if (stopped(task) || !live(task) && !(recover && task.status === "timed_out")) return;
        if (task.revision !== previous.revision) return;
        if (snapshot) { if (recover) task.status = "awaiting_acceptance"; this.apply(task, snapshot); }
        else task.observation_error = error;
        if (live(task) && this.now().getTime() >= Date.parse(task.deadline_at)) {
          task.status = "timed_out"; this.notify(task, task.renewal_count ? `timed_out:${task.renewal_count}` : "timed_out", `Codex CLI Watch ${task.id} reached its deadline. The native task may still run; an uncertain send will not be replayed.`);
        }
      });
    }
    await this.outbox.deliverPending(id); return this.status(id);
  }
  private async settleAcceptance(id: string): Promise<void> {
    const attempts = this.deps.acceptancePollAttempts ?? 16;
    const intervalMs = this.deps.acceptancePollIntervalMs ?? 100;
    const deadline = this.now().getTime() + Math.max(0, attempts - 1) * intervalMs;
    const sleep = this.deps.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    for (let attempt = 0; attempt < attempts; attempt++) {
      const task = this.status(id);
      if (stopped(task) || task.status !== "awaiting_acceptance" || task.native_turn_id || !task.send_intent?.receipt_turn_id ||
        this.now().getTime() >= Date.parse(task.deadline_at)) return;
      if (attempt > 0) {
        if (this.now().getTime() >= deadline) return;
        await sleep(Math.min(intervalMs, deadline - this.now().getTime()));
      }
      try {
        const snapshot = await this.deps.observe(task.target, task.send_intent.receipt_turn_id);
        this.update(id, current => { if (live(current) && current.revision === task.revision) this.apply(current, snapshot); });
      } catch (error) {
        this.update(id, current => { if (live(current)) current.observation_error = nativeErrorCode(error); });
      }
    }
  }
  list(): CodexNativeTaskRecord[] { return this.repo.list(); }
  async send(input: CodexNativeSendInput): Promise<CodexNativeTaskRecord> {
    if (!input.messageId?.trim() || !input.text?.trim()) throw new CodexNativeTaskError("invalid_argument", "Send requires stable message ID and nonempty text");
    const id = `codex-cli-watch:${nativeDigest([input.controllerSession, input.messageId])}`;
    const previous = this.repo.load(id); if (previous) return this.duplicate(previous, input);
    const task = this.make(input, id, "send");
    const snapshot = await this.deps.observe(input.target); assertSnapshot(input.target, snapshot);
    if (!snapshot.loaded || !snapshot.canSend) throw new CodexNativeTaskError("thread_not_idle", "Codex CLI thread must be loaded and idle before send");
    task.send_intent = { message_id: input.messageId, client_user_message_id: this.uuid(), text: input.text,
      baseline_turn_ids: snapshot.turns.map(turn => turn.id), state: "reserved", dispatched_at: this.now().toISOString() };
    let created = false;
    const reserved = this.repo.withLock(id, () => {
      const existing = this.repo.load(id); if (existing) return this.duplicate(existing, input);
      if (this.repo.list().some(other => unresolvedSend(other) && isDeepStrictEqual(other.target, input.target))) {
        throw new CodexNativeTaskError("codex_native_send_pending", "A previous send to this exact thread is awaiting acceptance");
      }
      created = true; return this.repo.save(task, null);
    });
    if (!created) return reserved;
    try {
      const receipt = await this.deps.start(input.target, { text: input.text, clientUserMessageId: task.send_intent.client_user_message_id,
        beforeDispatch: async fresh => {
          assertSnapshot(task.target, fresh);
          if (!fresh.loaded || !fresh.canSend) throw new CodexNativeTaskError("thread_not_idle", "Codex CLI thread became busy before send", "not_sent");
          this.update(id, current => {
            if (stopped(current) || current.status !== "awaiting_acceptance" || current.send_intent?.state !== "reserved") throw new CodexNativeTaskError("codex_native_send_cancelled", "Native send is no longer dispatchable", "not_sent");
            current.send_intent.state = "uncertain";
          });
        } });
      this.update(id, current => {
        const intent = current.send_intent!;
        if (receipt.clientUserMessageId !== intent.client_user_message_id || !receipt.turnId || intent.baseline_turn_ids.includes(receipt.turnId) ||
          current.native_turn_id && current.native_turn_id !== receipt.turnId) { intent.error_code = "codex_native_submission_turn_conflict"; return; }
        intent.receipt_turn_id = receipt.turnId; intent.state = current.native_turn_id ? "accepted" : "uncertain";
      });
    } catch (error) {
      this.update(id, current => {
        const intent = current.send_intent!; intent.error_code = nativeErrorCode(error);
        if (current.native_turn_id) return;
        if ((error as { dispatchState?: string })?.dispatchState === "not_sent") {
          intent.state = "not_sent"; if (live(current)) { current.status = "failed"; this.notify(current, "settled", `Codex CLI task ${id} was not sent (${intent.error_code}). This message ID will not be replayed.`); }
        } else intent.state = "uncertain";
      });
    }
    await this.settleAcceptance(id);
    return this.reconcile(id);
  }
  async watch(input: CodexNativeTaskInput): Promise<CodexNativeTaskRecord> {
    const task = this.make(input, `codex-cli-watch:${this.uuid()}`, "watch");
    const snapshot = await this.deps.observe(input.target); assertSnapshot(input.target, snapshot);
    const active = snapshot.turns.filter(turn => turn.status === "inProgress");
    if (!snapshot.loaded || active.length !== 1 || snapshot.latestTurnId !== active[0].id) throw new CodexNativeTaskError("no_active_task", "Codex CLI has no unique active native task to Watch");
    task.native_turn_id = active[0].id; this.apply(task, snapshot); this.repo.withLock(task.id, () => this.repo.save(task, null));
    await this.outbox.deliverPending(task.id); return this.status(task.id);
  }
  async reconcileAll() {
    const scan = this.repo.scanForReconciliation();
    const result = { tasks: [] as CodexNativeTaskRecord[], errors: [...scan.errors] };
    for (const task of scan.tasks) {
      if (!codexNativeTaskNeedsReconciliation(task)) continue;
      try { result.tasks.push(await this.reconcile(task.id)); }
      catch (error) { result.errors.push({ id: task.id, error_code: nativeErrorCode(error) }); }
    }
    return result;
  }
  private owned(id: string, controllerSession: string): CodexNativeTaskRecord {
    const task = this.status(id); this.assertOwner(task, controllerSession); return task;
  }
  private assertOwner(task: CodexNativeTaskRecord, controllerSession: string): void {
    if (task.controller_session !== controllerSession) throw new CodexNativeTaskError("codex_native_controller_mismatch", "Only the owning controller can manage this task");
  }
  private assertOpen(task: CodexNativeTaskRecord): void {
    if (task.closed_at) throw new CodexNativeTaskError("codex_native_task_closed", "Closed tasks cannot resume observation or callbacks");
  }
  private suppress(task: CodexNativeTaskRecord, errorCode: string, timeoutOnly = false): void {
    for (const n of task.notifications) if ((!timeoutOnly || n.envelope.event.type === "codex_native_watch.timed_out") &&
      ["ready", "retry_wait", "failed"].includes(n.status) && n.outcome?.disposition !== "permanent_failure") {
      n.status = "failed"; n.outcome = { disposition: "permanent_failure", error_code: errorCode }; delete n.retry_at;
    }
  }
  unwatch(id: string, input: { controllerSession: string }): CodexNativeTaskRecord {
    this.owned(id, input.controllerSession);
    return this.update(id, task => {
      this.assertOwner(task, input.controllerSession);
      if (task.closed_at) return;
      stopBackendObservation(task, this.now());
      this.suppress(task, "codex_native_watch_cancelled");
    });
  }
  close(id: string, input: { controllerSession: string; reason?: string }): CodexNativeTaskRecord {
    this.owned(id, input.controllerSession);
    if (input.reason !== undefined && !input.reason.trim()) throw new CodexNativeTaskError("invalid_argument", "Close reason must be nonempty");
    return this.update(id, task => {
      this.assertOwner(task, input.controllerSession);
      if (task.kind !== "send") throw new CodexNativeTaskError("codex_native_unmanaged_watch", "Passive Watch must use Unwatch");
      if (task.closed_at) return;
      closeBackendManagement(task, input, this.now());
      this.suppress(task, "codex_native_task_closed");
    });
  }
  async recover(id: string, input: { controllerSession: string }): Promise<CodexNativeTaskRecord> {
    const previous = this.owned(id, input.controllerSession); this.assertOpen(previous);
    const snapshot = await this.deps.observe(previous.target, previous.native_turn_id ?? previous.send_intent?.receipt_turn_id);
    const refreshed = this.update(id, task => {
      this.assertOwner(task, input.controllerSession); this.assertOpen(task);
      if (task.revision !== previous.revision) throw new CodexNativeTaskError("codex_native_task_changed", "Task changed during recovery; retry against current state");
      const priorStatus = task.status;
      if (priorStatus === "cancelled") task.unwatched_at ??= task.updated_at;
      this.apply(task, snapshot, true);
      if (["timed_out", "cancelled"].includes(priorStatus) && task.status === "watching") task.status = priorStatus;
      if (live(task) && this.now().getTime() >= Date.parse(task.deadline_at)) {
        task.status = "timed_out"; this.notify(task, task.renewal_count ? `timed_out:${task.renewal_count}` : "timed_out",
          `Codex CLI Watch ${task.id} reached its deadline. The native task may still run; an uncertain send will not be replayed.`);
      }
      task.recovered_at = this.now().toISOString();
      if (["completed", "failed", "interrupted"].includes(task.status)) this.suppress(task, "codex_native_timeout_superseded", true);
    });
    if (!stopped(refreshed)) await this.outbox.deliverPending(id);
    return this.status(id);
  }
  async renew(id: string, input: { controllerSession: string; timeoutMs?: number }): Promise<CodexNativeTaskRecord> {
    const previous = this.owned(id, input.controllerSession); this.assertOpen(previous);
    backendRenewalDeadline(previous, this.now(), input.timeoutMs);
    const snapshot = await this.deps.observe(previous.target, previous.native_turn_id ?? previous.send_intent?.receipt_turn_id);
    let unavailable = false;
    const refreshed = this.update(id, task => {
      this.assertOwner(task, input.controllerSession); this.assertOpen(task);
      if (task.revision !== previous.revision) throw new CodexNativeTaskError("codex_native_task_changed", "Task changed during renewal; retry against current state");
      const priorStatus = task.status;
      if (priorStatus === "cancelled") task.unwatched_at ??= task.updated_at;
      this.apply(task, snapshot, true);
      if (["completed", "failed", "interrupted"].includes(task.status)) { this.suppress(task, "codex_native_timeout_superseded", true); return; }
      const exact = task.native_turn_id ? nativeTurn(snapshot, task.native_turn_id) : undefined;
      if (!exact || exact.status === "inProgress" && !snapshot.loaded) { task.status = priorStatus; unavailable = true; return; }
      if (exact.status !== "inProgress") {
        if (!exact.itemsComplete) unavailable = true;
        else this.suppress(task, "codex_native_timeout_superseded", true);
        return;
      }
      task.deadline_at = backendRenewalDeadline(task, this.now(), input.timeoutMs);
      task.renewed_at = this.now().toISOString(); task.renewal_count = (task.renewal_count ?? 0) + 1;
      delete task.unwatched_at; task.status = "watching";
      this.suppress(task, "codex_native_timeout_superseded", true);
      this.apply(task, snapshot);
    });
    if (unavailable) throw new CodexNativeTaskError("codex_native_exact_turn_unavailable", "Renew requires proof of the original native task");
    if (!stopped(refreshed)) await this.outbox.deliverPending(id);
    return this.status(id);
  }
  async retryCallback(id: string, input: { controllerSession: string; notificationId?: string }): Promise<CodexNativeTaskRecord> {
    const previous = this.owned(id, input.controllerSession); this.assertOpen(previous);
    if (stopped(previous)) throw new CodexNativeTaskError("codex_native_watch_unwatched", "Renew observation before retrying callbacks");
    const eligible = (task: CodexNativeTaskRecord) => task.notifications.filter(note =>
      (!input.notificationId || note.id === input.notificationId) && isBackendCallbackRetryable(task, note));
    const candidates = eligible(previous);
    if (candidates.length !== 1) throw new CodexNativeTaskError("codex_native_callback_not_retryable", "Select exactly one callback with a retryable failure");
    const selected = candidates[0];
    const interactionId = selected.envelope.event.metadata?.interaction_id;
    const snapshot = typeof interactionId === "string"
      ? await this.deps.observe(previous.target, previous.native_turn_id ?? previous.send_intent?.receipt_turn_id) : undefined;
    let stale = false;
    this.update(id, task => {
      this.assertOwner(task, input.controllerSession); this.assertOpen(task);
      if (stopped(task)) throw new CodexNativeTaskError("codex_native_watch_unwatched", "Renew observation before retrying callbacks");
      const note = eligible(task).find(candidate => candidate.id === selected.id);
      if (!note || note.attempts !== selected.attempts) throw new CodexNativeTaskError("codex_native_callback_not_retryable", "Callback changed before retry authorization");
      if (snapshot) {
        if (task.revision !== previous.revision) throw new CodexNativeTaskError("codex_native_task_changed", "Task changed while checking callback freshness; retry against current state");
        const priorStatus = task.status;
        this.apply(task, snapshot, true);
        if (priorStatus === "timed_out" && task.status === "watching") task.status = priorStatus;
        if (!snapshot.loaded || !task.native_turn_id || nativeTurn(snapshot, task.native_turn_id)?.status !== "inProgress" ||
          !snapshot.pendingInteractions.some(item => item.id === interactionId && item.threadId === task.target.threadId && item.turnId === task.native_turn_id)) {
          note.status = "failed"; note.outcome = { disposition: "permanent_failure", error_code: "codex_native_interaction_resolved" }; stale = true; return;
        }
      }
      prepareBackendCallbackRetry(task, { ...input, notificationId: selected.id }, this.now());
    });
    if (stale) throw new CodexNativeTaskError("codex_native_callback_stale", "The callback interaction is no longer pending on the original task");
    await this.outbox.deliverPending(id, selected.id); return this.status(id);
  }
}
