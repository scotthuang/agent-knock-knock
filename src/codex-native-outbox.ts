import { randomUUID } from "node:crypto";
import { parseCallbackAttemptOutcome, type CallbackAttemptOutcome, type CallbackTransportContextV1, type CallbackTransportDeliverInput } from "./callback-transport.js";
import { createDurableNotificationLease, decideDurableNotificationRetry, reduceDurableNotificationSettlement } from "./durable-notification-kernel.js";
import type { CodexNativeNotification, CodexNativeStateRepository, CodexNativeTaskRecord } from "./codex-native-state-store.js";

export interface NativeOutboxDependencies {
  repository: CodexNativeStateRepository;
  deliver?(input: CallbackTransportDeliverInput): CallbackAttemptOutcome | Promise<CallbackAttemptOutcome>;
  resolveCallbackContext?(task: CodexNativeTaskRecord): CallbackTransportContextV1 | undefined;
  now?(): Date;
  randomUUID?(): string;
  deliveryLeaseMs?: number;
  retryDelayMs?: number;
  maxDeliveryAttempts?: number;
}
/** Lease and durable checkpoint semantics are shared with the other AKK transports. */
export function createNativeNotificationOutbox(deps: NativeOutboxDependencies) {
  const now = deps.now ?? (() => new Date());
  const uuid = deps.randomUUID ?? randomUUID;
  const maxAttempts = deps.maxDeliveryAttempts ?? 4;
  function update(id: string, operation: (task: CodexNativeTaskRecord) => void) {
    return deps.repository.withLock(id, () => {
      const task = deps.repository.load(id); if (!task) throw new Error("Codex native Watch not found");
      operation(task); task.updated_at = now().toISOString(); return deps.repository.save(task, task.revision);
    });
  }
  function settle(id: string, notificationId: string, attemptId: string, outcome: CallbackAttemptOutcome) {
    update(id, task => {
      const n = task.notifications.find(candidate => candidate.id === notificationId);
      if (!n || n.attempt_id !== attemptId) return;
      const lateAcceptance = outcome.disposition === "accepted" && n.status === "uncertain" &&
        n.outcome?.disposition === "uncertain" && n.outcome.error_code === "codex_native_callback_lease_expired";
      if (n.status !== "leased" && !lateAcceptance) return;
      n.outcome = outcome;
      const result = reduceDurableNotificationSettlement({ attempt: n.attempts, outcome, retryEnabled: true, maxRetryAttempts: maxAttempts - 1 });
      if (result.state === "accepted") n.status = "accepted";
      else if (result.state === "failed" && result.retryAuthorized) {
        n.status = "retry_wait"; n.retry_at = new Date(now().getTime() + (deps.retryDelayMs ?? 5000) * 2 ** (n.attempts - 1)).toISOString();
      } else n.status = outcome.disposition === "uncertain" ? "uncertain" : "failed";
    });
  }
  return {
    async deliverPending(id: string): Promise<void> {
      if (!deps.deliver) return;
      let claimed: { task: CodexNativeTaskRecord; notification: CodexNativeNotification } | undefined;
      update(id, task => {
        for (const n of task.notifications) {
          if (n.status === "leased" && Date.parse(n.lease_expires_at!) <= now().getTime()) {
            n.status = "uncertain"; n.outcome = { disposition: "uncertain", error_code: "codex_native_callback_lease_expired", observed_at: now().toISOString() }; continue;
          }
          const decision = decideDurableNotificationRetry(n.status === "ready"
            ? { phase: "ready", attempt: n.attempts, maxAttempts: maxAttempts - 1 }
            : n.status === "retry_wait"
              ? { phase: "retry_wait", attempt: n.attempts, maxAttempts: maxAttempts - 1, nowMs: now().getTime(), retryAt: n.retry_at, retryAuthorized: true }
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
        outcome = parseCallbackAttemptOutcome(await deps.deliver({ route: task.callback_route!, envelope: n.envelope,
          attempt: { number: n.attempts, id: n.attempt_id! }, context: deps.resolveCallbackContext?.(task),
          reportCheckpoint: checkpoint => {
            const parsed = parseCallbackAttemptOutcome(checkpoint);
            if (parsed.disposition === "accepted") settle(id, n.id, n.attempt_id!, parsed);
          } }));
      } catch { outcome = { disposition: "uncertain", error_code: "codex_native_callback_outcome_unknown", observed_at: now().toISOString() }; }
      settle(id, n.id, n.attempt_id!, outcome);
    }
  };
}
