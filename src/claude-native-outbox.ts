import { backendCallbackMaxAttempts, backendObservationStopped } from "./backend-task-recovery.js";
import { randomUUID } from "node:crypto";
import { parseCallbackAttemptOutcome, type CallbackAttemptOutcome, type CallbackTransportContextV1, type CallbackTransportDeliverInput } from "./callback-transport.js";
import { canSettleExpiredNotificationAttempt, createDurableNotificationLease, decideDurableNotificationRetry, reduceDurableNotificationSettlement } from "./durable-notification-kernel.js";
import type { ClaudeNativeStateRepository, ClaudeNativeTaskRecord } from "./claude-native-state-store.js";
import type { CodexNativeNotification } from "./codex-native-state-store.js";

export interface ClaudeNativeOutboxDependencies {
  repository: ClaudeNativeStateRepository;
  deliver?(input: CallbackTransportDeliverInput): CallbackAttemptOutcome | Promise<CallbackAttemptOutcome>;
  resolveCallbackContext?(task: ClaudeNativeTaskRecord): CallbackTransportContextV1 | undefined;
  now?(): Date;
  randomUUID?(): string;
  deliveryLeaseMs?: number;
  retryDelayMs?: number;
  maxDeliveryAttempts?: number;
}
/** Lease and durable checkpoint semantics are shared with the other AKK transports. */
export function createClaudeNativeNotificationOutbox(deps: ClaudeNativeOutboxDependencies) {
  const now = deps.now ?? (() => new Date());
  const uuid = deps.randomUUID ?? randomUUID;
  const maxAttempts = deps.maxDeliveryAttempts ?? 4;
  function update(id: string, operation: (task: ClaudeNativeTaskRecord) => void) {
    return deps.repository.withLock(id, () => {
      const task = deps.repository.load(id); if (!task) throw new Error("Claude native Watch not found");
      operation(task); task.updated_at = now().toISOString(); return deps.repository.save(task, task.revision);
    });
  }
  function stale(task: ClaudeNativeTaskRecord, note: CodexNativeNotification): boolean {
    if (note.envelope.event.type === "claude_native_watch.timed_out") {
      const expected = `${task.id}:timed_out${task.renewal_count ? `:${task.renewal_count}` : ""}`;
      if (task.status !== "timed_out" || note.id !== expected) return true;
    }
    const interactionId = note.envelope.event.metadata?.interaction_id;
    return typeof interactionId === "string"; // This route never publishes actionable native interactions.
  }
  function settle(id: string, notificationId: string, attemptId: string, outcome: CallbackAttemptOutcome) {
    update(id, task => {
      const n = task.notifications.find(candidate => candidate.id === notificationId);
      if (!n || n.attempt_id !== attemptId) return;
      const definitiveLateOutcome = canSettleExpiredNotificationAttempt({ status: n.status, previousOutcome: n.outcome,
        leaseExpiredCode: "claude_native_callback_lease_expired", outcome, attemptId,
        deliveryId: n.envelope.delivery_id, idempotencyKey: n.envelope.idempotency_key });
      if (n.status !== "leased" && !definitiveLateOutcome) return;
      if (outcome.disposition === "retryable_failure" && stale(task, n)) {
        n.status = "failed"; n.outcome = { disposition: "permanent_failure", error_code: "claude_native_callback_stale" }; delete n.retry_at; return;
      }
      delete n.retry_at;
      const result = reduceDurableNotificationSettlement({ attempt: n.attempts, outcome, retryEnabled: !backendObservationStopped(task) && !stale(task, n),
        maxRetryAttempts: backendCallbackMaxAttempts(n, maxAttempts) - 1 });
      n.outcome = result.outcome;
      if (result.state === "accepted") n.status = "accepted";
      else if (result.state === "failed" && result.retryAuthorized) {
        n.status = "retry_wait"; n.retry_at = new Date(now().getTime() + (deps.retryDelayMs ?? 5000) * 2 ** (n.attempts - 1)).toISOString();
      } else n.status = outcome.disposition === "uncertain" ? "uncertain" : "failed";
    });
  }
  return {
    async deliverPending(id: string, notificationId?: string): Promise<void> {
      let claimed: { task: ClaudeNativeTaskRecord; notification: CodexNativeNotification } | undefined;
      update(id, task => {
        for (const n of task.notifications) {
          if (notificationId && n.id !== notificationId) continue;
          if (n.status === "leased" && Date.parse(n.lease_expires_at!) <= now().getTime()) {
            n.status = "uncertain"; n.outcome = { disposition: "uncertain", error_code: "claude_native_callback_lease_expired", observed_at: now().toISOString() }; continue;
          }
          if (backendObservationStopped(task) || !deps.deliver) continue;
          if (["ready", "retry_wait"].includes(n.status) && stale(task, n)) {
            n.status = "failed"; n.outcome = { disposition: "permanent_failure", error_code: "claude_native_callback_stale" }; delete n.retry_at; continue;
          }
          const decision = decideDurableNotificationRetry(n.status === "ready"
            ? { phase: "ready", attempt: n.attempts, maxAttempts: backendCallbackMaxAttempts(n, maxAttempts) - 1 }
            : n.status === "retry_wait"
              ? { phase: "retry_wait", attempt: n.attempts, maxAttempts: backendCallbackMaxAttempts(n, maxAttempts) - 1, nowMs: now().getTime(), retryAt: n.retry_at, retryAuthorized: true }
              : { phase: "settled", attempt: n.attempts });
          if (decision.state !== "retryable") continue;
          const lease = createDurableNotificationLease({ previousAttempts: n.attempts, attemptId: uuid(), attemptedAt: now().toISOString(),
            leaseBaseMs: now().getTime(), leaseMs: deps.deliveryLeaseMs ?? 30_000 });
          n.status = "leased"; n.attempts = lease.attempt; n.attempt_id = lease.attemptId; n.lease_expires_at = lease.leaseExpiresAt;
          claimed = { task: structuredClone(task), notification: structuredClone(n) }; break;
        }
      });
      if (!claimed) return;
      const { task, notification: n } = claimed;
      let outcome: CallbackAttemptOutcome;
      try {
        const context = deps.resolveCallbackContext?.(task);
        const current = deps.repository.load(id);
        if (!current || backendObservationStopped(current) || stale(current, n)) {
          settle(id, n.id, n.attempt_id!, { disposition: "permanent_failure", error_code: "claude_native_callback_stopped" }); return;
        }
        outcome = parseCallbackAttemptOutcome(await deps.deliver!({ route: task.callback_route!, envelope: n.envelope,
          attempt: { number: n.attempts, id: n.attempt_id! }, context,
          reportCheckpoint: checkpoint => {
            const parsed = parseCallbackAttemptOutcome(checkpoint);
            if (parsed.disposition === "accepted") settle(id, n.id, n.attempt_id!, parsed);
          } }));
      } catch { outcome = { disposition: "uncertain", error_code: "claude_native_callback_outcome_unknown", observed_at: now().toISOString() }; }
      settle(id, n.id, n.attempt_id!, outcome);
    }
  };
}
