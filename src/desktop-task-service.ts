import { resolveMonitorHardTimeoutMs } from "./monitor-deadline-policy.js";
import { backendCallbackMaxAttempts } from "./backend-task-recovery.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createCallbackEnvelope, parseCallbackAttemptOutcome, parseCallbackRoute,
  type CallbackAttemptOutcome, type CallbackRouteV1,
  type CallbackTransportContextV1, type CallbackTransportDeliverInput
} from "./callback-transport.js";
import { createDurableNotificationLease, decideDurableNotificationRetry, reduceDurableNotificationSettlement } from "./durable-notification-kernel.js";
import type { DesktopSnapshot, DesktopThreadIdentity, DesktopTransportPort, DesktopTurn } from "./desktop-types.js";
import { findDesktopSubmission } from "./desktop-snapshot.js";
import { parseDesktopConversationId } from "./desktop-identity.js";
import type { DesktopNotification, DesktopStateRepository, DesktopTaskRecord } from "./desktop-state-store.js";
import { createDesktopTaskRecovery, DesktopTaskError, desktopLive as live, desktopObservationStopped, desktopUnresolvedSend, desktopNotificationObsolete, suppressDesktopNotifications, type DesktopRecoveryInput } from "./desktop-task-recovery.js";
export { DesktopTaskError } from "./desktop-task-recovery.js";
import { clearDesktopInteractionAttention, desktopManualRequests, revokeObsoleteDesktopManualAttention, updateDesktopInteractionAttention } from "./desktop-task-interactions.js";

export interface DesktopTaskInput {
  target: DesktopThreadIdentity;
  desktopId: string;
  controllerSession: string;
  callbackRoute?: CallbackRouteV1;
  timeoutMs?: number;
}
export interface DesktopSendInput extends DesktopTaskInput { messageId: string; text: string }
export interface DesktopTaskServiceDependencies extends DesktopTransportPort {
  repository: DesktopStateRepository;
  deliver?(input: CallbackTransportDeliverInput): CallbackAttemptOutcome | Promise<CallbackAttemptOutcome>;
  resolveCallbackContext?(task: DesktopTaskRecord): CallbackTransportContextV1 | undefined;
  now?(): Date;
  randomUUID?(): string;
  deliveryLeaseMs?: number;
  retryDelayMs?: number;
  maxDeliveryAttempts?: number;
}
export interface DesktopTaskService {
  send(input: DesktopSendInput): Promise<DesktopTaskRecord>;
  watch(input: DesktopTaskInput): Promise<DesktopTaskRecord>;
  status(id: string): DesktopTaskRecord;
  list(): DesktopTaskRecord[];
  reconcile(id: string): Promise<DesktopTaskRecord>;
  reconcileAll(): Promise<{ tasks: DesktopTaskRecord[]; errors: { id: string; error_code: string }[] }>;
  unwatch(id: string, input: DesktopRecoveryInput): DesktopTaskRecord;
  close(id: string, input: DesktopRecoveryInput & { reason?: string }): DesktopTaskRecord;
  renew(id: string, input: DesktopRecoveryInput & { timeoutMs?: number }): Promise<DesktopTaskRecord>;
  recover(id: string, input: DesktopRecoveryInput): Promise<DesktopTaskRecord>;
  retryCallback(id: string, input: DesktopRecoveryInput & { notificationId?: string }): Promise<DesktopTaskRecord>;
}
/** Includes outbox work after the native task has settled. */
export function desktopTaskNeedsReconciliation(task: DesktopTaskRecord): boolean {
  return task.notifications.some(notification => notification.status === "leased") || !desktopObservationStopped(task) &&
    (live(task) || task.notifications.some(notification => ["ready", "retry_wait"].includes(notification.status)));
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function sendId(controllerSession: string, messageId: string): string {
  const hash = digest([controllerSession, messageId]);
  return `desktop-watch:${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(code) ? code : "desktop_observation_unavailable";
}
/** Require exactly one native user message, not title/text matching or a steering alias. */
function submissionTurn(snapshot: DesktopSnapshot, clientId: string, text: string): DesktopTurn | undefined {
  return findDesktopSubmission(snapshot, clientId, text)?.turn;
}
function finalText(turn: DesktopTurn): string {
  const messages = turn.items.filter(item => item.type === "agentMessage" && item.delivery !== "async" && typeof item.text === "string");
  const finals = messages.filter(item => item.phase === "final_answer");
  // Older snapshots can omit phase; explicit commentary/analysis must never
  // become the task's final result when no final answer exists.
  return (finals.length ? finals : messages.filter(item => item.phase == null)).map(item => item.text).join("\n\n");
}
function assertSnapshot(task: Pick<DesktopTaskRecord, "target">, snapshot: DesktopSnapshot): void {
  if (snapshot.threadId !== task.target.threadId || !snapshot.ownerClientId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new DesktopTaskError("desktop_identity_mismatch", "Desktop observation did not match the exact thread");
}
function idle(snapshot: DesktopSnapshot): boolean {
  return snapshot.canSend && snapshot.runtimeStatus === "idle" && snapshot.tailKnown &&
    snapshot.pendingRequestCount === 0 && snapshot.unconfirmedSubmissionCount === 0 &&
    !snapshot.turns.some(turn => turn.status === "inProgress");
}

export function createDesktopTaskService(deps: DesktopTaskServiceDependencies): DesktopTaskService {
  const service = new DesktopTaskServiceRuntime(deps);
  return {
    send: input => service.send(input), watch: input => service.watch(input),
    status: id => service.status(id), list: () => service.list(),
    reconcile: id => service.reconcile(id), reconcileAll: () => service.reconcileAll(),
    unwatch: (id, input) => service.unwatch(id, input), close: (id, input) => service.close(id, input),
    renew: (id, input) => service.renew(id, input), recover: (id, input) => service.recover(id, input),
    retryCallback: (id, input) => service.retryCallback(id, input)
  };
}

/** Persisted task transitions and delivery claims share one repository boundary. */
class DesktopTaskServiceRuntime implements DesktopTaskService {
  private readonly repo: DesktopStateRepository;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly maxAttempts: number;
  private readonly recovery: ReturnType<typeof createDesktopTaskRecovery>;
  constructor(private readonly deps: DesktopTaskServiceDependencies) {
    this.repo = deps.repository;
    this.now = deps.now ?? (() => new Date());
    this.uuid = deps.randomUUID ?? randomUUID;
    this.leaseMs = deps.deliveryLeaseMs ?? 30_000;
    this.retryMs = deps.retryDelayMs ?? 5_000;
    this.maxAttempts = deps.maxDeliveryAttempts ?? 4;
    this.recovery = createDesktopTaskRecovery({ status: id => this.status(id), update: (id, op) => this.update(id, op),
      observe: target => deps.observe(target), applySnapshot: (task, snapshot, recover) => this.applySnapshot(task, snapshot, recover),
      deliverPending: (id, notificationId) => this.deliverPending(id, notificationId), now: this.now, expire: task => this.expire(task) });
  }
  status(id: string): DesktopTaskRecord {
    const task = this.repo.load(id);
    if (!task) throw new DesktopTaskError("desktop_watch_not_found", "Desktop Watch was not found");
    return task;
  }
  private update(id: string, operation: (task: DesktopTaskRecord) => void): DesktopTaskRecord {
    return this.repo.withLock(id, () => {
      const task = this.status(id); operation(task); task.updated_at = this.now().toISOString();
      return this.repo.save(task, task.revision);
    });
  }
  private notify(task: DesktopTaskRecord, key: string, body: string): void {
    if (!task.callback_route || desktopObservationStopped(task)) return;
    const id = `${task.id}:${key}`;
    if (task.notifications.some(n => n.id === id)) return;
    task.notifications.push({ id, attempts: 0, status: "ready", envelope: createCallbackEnvelope({
      route: task.callback_route,
      source: { kind: "desktop_watch", watch_id: task.id, desktop_id: task.desktop_id },
      event: { id, type: `desktop_watch.${key.split(":")[0]}`, body, requires_response: false,
        metadata: { watch_id: task.id, desktop_id: task.desktop_id, thread_id: task.target.threadId,
          ...(task.native_turn_id ? { turn_id: task.native_turn_id } : {}) } }
    }) });
  }
  private make(input: DesktopTaskInput, id: string, kind: "send" | "watch"): DesktopTaskRecord {
    if (!input.controllerSession?.trim() || !input.desktopId?.trim() || !input.target?.threadId?.trim()) throw new DesktopTaskError("invalid_argument", "Desktop identity and controller session are required");
    if (!isDeepStrictEqual(parseDesktopConversationId(input.desktopId), input.target)) throw new DesktopTaskError("desktop_identity_mismatch", "Desktop conversation ID does not match its native target");
    const timeout = resolveMonitorHardTimeoutMs(input.timeoutMs);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 7 * 24 * 3_600_000) throw new DesktopTaskError("invalid_argument", "Desktop Watch timeout must be between 1 millisecond and 7 days");
    const route = input.callbackRoute === undefined ? undefined : parseCallbackRoute(input.callbackRoute);
    if (route && (route.controller_session_id !== input.controllerSession || route.capabilities?.respond === true)) throw new DesktopTaskError("callback_controller_mismatch", "Desktop callbacks must be notification-only and belong to the controller");
    const date = this.now();
    return { schema: "agent-knock-knock/desktop-task", version: 1, revision: 1,
      id, watch_id: id, desktop_id: input.desktopId, target: structuredClone(input.target),
      controller_session: input.controllerSession, kind, status: kind === "send" ? "awaiting_acceptance" : "watching",
      created_at: date.toISOString(), updated_at: date.toISOString(), deadline_at: new Date(date.getTime() + timeout).toISOString(),
      ...(route ? { callback_route: route } : {}), pending_manual_count: 0, pending_async_interactions: [], pending_interactions: [], notifications: [] };
  }
  private duplicate(task: DesktopTaskRecord, input: DesktopSendInput): DesktopTaskRecord {
    if (task.kind !== "send" || task.controller_session !== input.controllerSession ||
      !isDeepStrictEqual(task.target, input.target) || task.desktop_id !== input.desktopId ||
      task.send_intent?.message_id !== input.messageId || task.send_intent.text !== input.text ||
      !isDeepStrictEqual(task.callback_route, input.callbackRoute)) {
      throw new DesktopTaskError("desktop_message_id_conflict", "This message ID is already bound to different immutable Desktop send input");
    }
    return task;
  }
  private settleDelivery(id: string, notificationId: string, attemptId: string, outcome: CallbackAttemptOutcome): void {
    this.update(id, task => {
      const notification = task.notifications.find(n => n.id === notificationId);
      if (!notification || notification.attempt_id !== attemptId || notification.status !== "leased" && !(notification.status === "uncertain" && outcome.disposition === "accepted")) return;
      if (outcome.disposition === "retryable_failure" && desktopNotificationObsolete(task, notification)) outcome = { disposition: "permanent_failure", error_code: "desktop_notification_obsolete" };
      const settlement = reduceDurableNotificationSettlement({ attempt: notification.attempts, outcome,
        retryEnabled: !desktopObservationStopped(task), maxRetryAttempts: backendCallbackMaxAttempts(notification, this.maxAttempts) - 1 });
      notification.outcome = outcome;
      if (settlement.state === "accepted") notification.status = "accepted";
      else if (settlement.state === "failed" && settlement.retryAuthorized) {
        notification.status = "retry_wait";
        notification.retry_at = new Date(this.now().getTime() + this.retryMs * 2 ** (notification.attempts - 1)).toISOString();
      } else notification.status = outcome.disposition === "uncertain" ? "uncertain" : "failed";
    });
  }
  private async deliverPending(id: string, notificationId?: string): Promise<void> {
    // One attempt per reconciliation keeps a stalled callback from starving other tasks.
    let claimed: { task: DesktopTaskRecord; notification: DesktopNotification } | undefined;
    this.repo.withLock(id, () => {
      const task = this.status(id); let dirty = false;
      for (const notification of task.notifications) {
        if (notificationId && notification.id !== notificationId) continue;
        if (notification.status === "leased" && Date.parse(notification.lease_expires_at!) <= this.now().getTime()) {
          notification.status = "uncertain";
          notification.outcome = { disposition: "uncertain", error_code: "desktop_delivery_lease_expired", observed_at: this.now().toISOString() };
          dirty = true; continue;
        }
        if (desktopObservationStopped(task) || !this.deps.deliver) continue;
        if (["ready", "retry_wait"].includes(notification.status) && desktopNotificationObsolete(task, notification)) {
          notification.status = "failed"; notification.outcome = { disposition: "permanent_failure", error_code: "desktop_notification_obsolete" }; dirty = true; continue;
        }
        if (notification.envelope.event.requires_response && task.observation_error) continue;
        const decision = decideDurableNotificationRetry(notification.status === "ready"
          ? { phase: "ready", attempt: notification.attempts, maxAttempts: backendCallbackMaxAttempts(notification, this.maxAttempts) - 1 }
          : notification.status === "retry_wait"
            ? { phase: "retry_wait", attempt: notification.attempts, maxAttempts: backendCallbackMaxAttempts(notification, this.maxAttempts) - 1, nowMs: this.now().getTime(), retryAt: notification.retry_at, retryAuthorized: true }
            : { phase: "settled", attempt: notification.attempts });
        if (decision.state !== "retryable") continue;
        const lease = createDurableNotificationLease({ previousAttempts: notification.attempts, attemptId: this.uuid(),
          attemptedAt: this.now().toISOString(), leaseBaseMs: this.now().getTime(), leaseMs: this.leaseMs });
        notification.attempts = lease.attempt; notification.attempt_id = lease.attemptId;
        notification.lease_expires_at = lease.leaseExpiresAt; notification.status = "leased";
        claimed = { task, notification: structuredClone(notification) }; dirty = true; break;
      }
      if (dirty) { task.updated_at = this.now().toISOString(); this.repo.save(task, task.revision); }
    });
    if (!claimed || !this.deps.deliver) return;
    const { task, notification } = claimed;
    const uncertain = (code: string): CallbackAttemptOutcome => ({ disposition: "uncertain", error_code: code, observed_at: this.now().toISOString() });
    let outcome: CallbackAttemptOutcome;
    try {
      const context = this.deps.resolveCallbackContext?.(task);
      const current = this.status(id);
      if (desktopObservationStopped(current) || desktopNotificationObsolete(current, notification)) {
        this.settleDelivery(id, notification.id, notification.attempt_id!, { disposition: "permanent_failure", error_code: "desktop_watch_stopped" }); return;
      }
      outcome = parseCallbackAttemptOutcome(await this.deps.deliver({ route: task.callback_route!, envelope: notification.envelope,
        attempt: { number: notification.attempts, id: notification.attempt_id! }, context,
        reportCheckpoint: checkpoint => {
          const parsed = parseCallbackAttemptOutcome(checkpoint);
          if (parsed.disposition === "accepted") this.settleDelivery(id, notification.id, notification.attempt_id!, parsed);
        } }));
    } catch { outcome = uncertain("desktop_callback_outcome_unknown"); }
    this.settleDelivery(id, notification.id, notification.attempt_id!, outcome);
  }
  private bindObservedSubmission(task: DesktopTaskRecord, snapshot: DesktopSnapshot): void {
    const intent = task.send_intent;
    if (!intent || task.native_turn_id) return;
    const accepted = submissionTurn(snapshot, intent.client_user_message_id, intent.text);
    if (accepted && !intent.baseline_turn_ids.includes(accepted.turnId) &&
      (!intent.receipt_turn_id || intent.receipt_turn_id === accepted.turnId)) {
      task.native_turn_id = accepted.turnId; intent.state = "accepted"; task.status = "watching";
    } else {
      // A monitor can observe the reservation while the sender is still doing
      // its pre-dispatch check. It must not consume the sender's barrier.
      if (intent.state !== "reserved") intent.state = "uncertain";
      task.observation_error = accepted ? "desktop_submission_turn_conflict" : "desktop_submission_not_observed";
    }
  }
  private applySnapshot(task: DesktopTaskRecord, snapshot: DesktopSnapshot, recover = false): void {
    assertSnapshot(task, snapshot);
    if (recover && task.status === "cancelled") task.unwatched_at ??= task.updated_at;
    task.observed_at = this.now().toISOString(); delete task.observation_error;
    if (!live(task) && (!recover || ["completed", "failed", "interrupted"].includes(task.status))) return;
    const previousStatus = task.status;
    this.bindObservedSubmission(task, snapshot);
    if (recover && !live({ ...task, status: previousStatus })) task.status = previousStatus;
    if (task.native_turn_id) {
      const matchingTurns = snapshot.turns.filter(turn => turn.turnId === task.native_turn_id);
      const turn = matchingTurns.length === 1 ? matchingTurns[0] : undefined;
      if (!turn) task.observation_error = "desktop_exact_turn_unavailable";
      else {
        if (!desktopObservationStopped(task) && live(task)) updateDesktopInteractionAttention(task, snapshot);
        const requests = desktopObservationStopped(task) || !live(task) ? [] : desktopManualRequests(task, snapshot);
        task.pending_manual_count = requests.length;
        if (requests.length) {
          const fingerprint = digest(requests.map(request => [request.kind, request.requestId, request.method, request.turnId]).sort());
          task.pending_manual_fingerprint = fingerprint;
          this.notify(task, `manual:${fingerprint}`, `Desktop task ${task.id} is waiting for a question or approval. Handle it manually in Desktop. AKK will continue watching this exact task.`);
        } else delete task.pending_manual_fingerprint;
        revokeObsoleteDesktopManualAttention(task);
        if (["completed", "failed", "interrupted"].includes(turn.status)) {
          if (!turn.itemsComplete) task.observation_error = "desktop_exact_turn_items_incomplete";
          else {
            task.status = turn.status as "completed" | "failed" | "interrupted";
            suppressDesktopNotifications(task, "desktop_timeout_superseded", notification => notification.envelope.event.type === "desktop_watch.timed_out");
            task.final_text = finalText(turn); task.pending_manual_count = 0;
            this.notify(task, "settled", `Desktop task ${task.id} ${task.status}.\n${task.final_text || "No assistant text was returned for this exact turn."}`);
          }
        }
      }
    }
  }
  private expire(task: DesktopTaskRecord): void {
    if (!desktopObservationStopped(task) && live(task) && this.now().getTime() >= Date.parse(task.deadline_at)) {
      task.status = "timed_out";
      clearDesktopInteractionAttention(task, "desktop_watch_timed_out");
      this.notify(task, `timed_out${task.renewal_count ? `:${task.renewal_count}` : ""}`, `Desktop Watch ${task.id} reached its deadline. This does not mean the native task stopped or that an uncertain send was rejected. AKK will not resend it.`);
    }
  }
  async reconcile(id: string): Promise<DesktopTaskRecord> {
    const initial = this.status(id);
    const recoverUncertain = initial.status === "timed_out" && !initial.native_turn_id &&
      initial.send_intent && ["reserved", "uncertain"].includes(initial.send_intent.state);
    if (!desktopObservationStopped(initial) && (live(initial) || recoverUncertain)) {
      let snapshot: DesktopSnapshot | undefined; let observationError: string | undefined;
      try { snapshot = await this.deps.observe(initial.target); assertSnapshot(initial, snapshot); }
      catch (error) { observationError = errorCode(error); }
      this.update(id, task => {
        if (desktopObservationStopped(task) || !live(task) && !(recoverUncertain && task.status === "timed_out")) return;
        // A concurrent monitor may have advanced a receipt/anchor. Apply only against the observed revision.
        if (task.revision !== initial.revision) return;
        if (snapshot) {
          this.applySnapshot(task, snapshot, recoverUncertain);
        } else task.observation_error = observationError;
        this.expire(task);
      });
    }
    await this.deliverPending(id);
    return this.status(id);
  }
  list(): DesktopTaskRecord[] { return this.repo.list(); }
  async send(input: DesktopSendInput): Promise<DesktopTaskRecord> {
    if (!input.messageId?.trim() || !input.text?.trim()) throw new DesktopTaskError("invalid_argument", "Desktop send needs a stable message ID and non-empty text");
    const id = sendId(input.controllerSession, input.messageId);
    const previous = this.repo.load(id); if (previous) return this.duplicate(previous, input);
    const task = this.make(input, id, "send");
    const snapshot = await this.deps.observe(input.target); assertSnapshot(task, snapshot);
    if (!idle(snapshot)) throw new DesktopTaskError("thread_not_idle", "Desktop thread must be confirmed idle before send");
    task.send_intent = { message_id: input.messageId, client_user_message_id: this.uuid(), text: input.text,
      owner_client_id: snapshot.ownerClientId, baseline_turn_ids: snapshot.turns.map(turn => turn.turnId),
      state: "reserved", dispatched_at: this.now().toISOString() };
    let created = false;
    const reserved = this.repo.withLock(id, () => {
      const existing = this.repo.load(id); if (existing) return this.duplicate(existing, input);
      // withLock also holds the global store writer lease. This check and the
      // reservation are atomic across distinct message IDs and CLI workers.
      if (this.repo.list().some(other => desktopUnresolvedSend(other) && isDeepStrictEqual(other.target, input.target))) {
        throw new DesktopTaskError("desktop_send_pending", "Another Desktop send is awaiting acceptance for this exact conversation");
      }
      const saved = this.repo.save(task, null); created = true; return saved;
    });
    if (!created) return reserved;
    // Durable, non-replayable reservation precedes all native mutation. Even a crash here never retries start.
    try {
      const receipt = await this.deps.start(input.target, { threadId: input.target.threadId,
        ownerClientId: snapshot.ownerClientId, expectedRevision: snapshot.revision,
        expectedLatestTurnId: snapshot.latestTurnId, prompt: input.text,
        clientUserMessageId: task.send_intent.client_user_message_id,
        beforeDispatch: async fresh => {
          assertSnapshot(task, fresh);
          if (fresh.ownerClientId !== snapshot.ownerClientId || fresh.revision < snapshot.revision ||
            fresh.latestTurnId !== snapshot.latestTurnId || !idle(fresh)) throw new DesktopTaskError("snapshot_changed", "Desktop changed before durable dispatch", "not_sent");
          this.update(id, current => {
            if (desktopObservationStopped(current) || current.status !== "awaiting_acceptance" || current.send_intent?.state !== "reserved") throw new DesktopTaskError("desktop_send_cancelled", "Desktop send intent is no longer dispatchable", "not_sent");
            current.send_intent.state = "uncertain";
          });
        } });
      this.update(id, current => {
        const intent = current.send_intent!;
        if (receipt.clientUserMessageId !== intent.client_user_message_id || !receipt.turnId || intent.baseline_turn_ids.includes(receipt.turnId) ||
          (current.native_turn_id && current.native_turn_id !== receipt.turnId)) {
          if (!current.native_turn_id) intent.state = "uncertain";
          intent.error_code = "desktop_submission_turn_conflict"; return;
        }
        intent.receipt_turn_id = receipt.turnId;
        // A monitor may already have verified native acceptance while the
        // sender was awaiting the receipt. Never demote that durable proof.
        intent.state = current.native_turn_id ? "accepted" : "uncertain";
      });
    } catch (error) {
      this.update(id, current => {
        const intent = current.send_intent!; intent.error_code = errorCode(error);
        if (current.native_turn_id) return;
        if ((error as { dispatchState?: string })?.dispatchState === "not_sent") {
          intent.state = "not_sent";
          if (live(current)) { current.status = "failed"; this.notify(current, "settled", `Desktop task ${current.id} was not sent (${intent.error_code}). The same message ID will not be retried.`); }
        } else intent.state = "uncertain";
      });
    }
    return this.reconcile(id);
  }
  async watch(input: DesktopTaskInput): Promise<DesktopTaskRecord> {
    const task = this.make(input, `desktop-watch:${this.uuid()}`, "watch");
    const snapshot = await this.deps.observe(input.target); assertSnapshot(task, snapshot);
    const active = snapshot.turns.filter(turn => turn.status === "inProgress");
    if (!snapshot.tailKnown || snapshot.runtimeStatus !== "active" || active.length !== 1 || snapshot.latestTurnId !== active[0].turnId) throw new DesktopTaskError("no_active_task", "Desktop has no uniquely confirmed active task to watch");
    task.native_turn_id = active[0].turnId; this.applySnapshot(task, snapshot);
    this.repo.withLock(task.id, () => this.repo.save(task, null));
    await this.deliverPending(task.id); return this.status(task.id);
  }
  async reconcileAll() {
    const scan = this.repo.scanForReconciliation();
    const result: { tasks: DesktopTaskRecord[]; errors: { id: string; error_code: string }[] } = { tasks: [], errors: [...scan.errors] };
    for (const task of scan.tasks) {
      try { result.tasks.push(await this.reconcile(task.id)); }
      catch (error) { result.errors.push({ id: task.id, error_code: errorCode(error) }); }
    }
    return result;
  }
  unwatch(id: string, input: DesktopRecoveryInput) { return this.recovery.unwatch(id, input); }
  close(id: string, input: DesktopRecoveryInput & { reason?: string }) { return this.recovery.close(id, input); }
  renew(id: string, input: DesktopRecoveryInput & { timeoutMs?: number }) { return this.recovery.renew(id, input); }
  recover(id: string, input: DesktopRecoveryInput) { return this.recovery.recover(id, input); }
  retryCallback(id: string, input: DesktopRecoveryInput & { notificationId?: string }) { return this.recovery.retryCallback(id, input); }
}
