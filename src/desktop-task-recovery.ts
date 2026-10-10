import { resolveMonitorHardTimeoutMs } from "./monitor-deadline-policy.js";
import { backendObservationStopped, backendRenewalDeadline, prepareBackendCallbackRetry } from "./backend-task-recovery.js";
import { clearDesktopInteractionAttention } from "./desktop-task-interactions.js";
import { desktopInteractions } from "./desktop-request-interactions.js";
import type { DesktopNotification, DesktopTaskRecord } from "./desktop-state-store.js";
import type { DesktopSnapshot, DesktopThreadIdentity } from "./desktop-types.js";

export class DesktopTaskError extends Error {
  constructor(public readonly code: string, message: string, public readonly dispatchState?: "not_sent") { super(message); this.name = "DesktopTaskError"; }
}
export interface DesktopRecoveryInput { controllerSession: string }
export interface DesktopRecoveryHost {
  status(id: string): DesktopTaskRecord;
  update(id: string, operation: (task: DesktopTaskRecord) => void): DesktopTaskRecord;
  observe(target: DesktopThreadIdentity): Promise<DesktopSnapshot>;
  applySnapshot(task: DesktopTaskRecord, snapshot: DesktopSnapshot, recover?: boolean): void;
  deliverPending(id: string, notificationId?: string): Promise<void>;
  now(): Date;
  expire(task: DesktopTaskRecord): void;
}
export const desktopObservationStopped = backendObservationStopped;
export const desktopLive = (task: DesktopTaskRecord): boolean => task.status === "awaiting_acceptance" || task.status === "watching";
export function desktopUnresolvedSend(task: DesktopTaskRecord): boolean {
  return task.kind === "send" && !task.closed_at && !task.native_turn_id &&
    Boolean(task.send_intent && ["reserved", "uncertain"].includes(task.send_intent.state));
}
function owner(task: DesktopTaskRecord, input: DesktopRecoveryInput): void {
  if (!input.controllerSession?.trim() || task.controller_session !== input.controllerSession) {
    throw new DesktopTaskError("desktop_controller_mismatch", "Only the owning controller can manage this Desktop task");
  }
}
function open(task: DesktopTaskRecord): void {
  if (task.closed_at) throw new DesktopTaskError("desktop_task_closed", "This Desktop task has been closed");
}
export function desktopNotificationObsolete(task: DesktopTaskRecord, notification: DesktopNotification): boolean {
  const event = notification.envelope.event;
  if (event.type === "desktop_watch.timed_out") {
    const expected = `${task.id}:timed_out${task.renewal_count ? `:${task.renewal_count}` : ""}`;
    return task.status !== "timed_out" || notification.id !== expected;
  }
  if (event.requires_response) return !(task.pending_interactions ?? task.pending_async_interactions ?? [])
    .some(interaction => interaction.id === event.metadata?.interaction_id && interaction.turnId === task.native_turn_id);
  return false;
}
export function suppressDesktopNotifications(task: DesktopTaskRecord, code: string, predicate = (_notification: DesktopNotification) => true): void {
  for (const notification of task.notifications) if (predicate(notification) && ["ready", "retry_wait", "failed"].includes(notification.status)) {
    notification.status = "failed";
    notification.outcome = { disposition: "permanent_failure", error_code: code };
    delete notification.retry_at;
  }
}
function exactTurn(task: DesktopTaskRecord, snapshot: DesktopSnapshot) {
  if (snapshot.threadId !== task.target.threadId || !snapshot.ownerClientId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new DesktopTaskError("desktop_identity_mismatch", "Desktop observation did not match the original thread");
  }
  const matching = snapshot.turns.filter(turn => turn.turnId === task.native_turn_id);
  return matching.length === 1 ? matching[0] : undefined;
}
function fresh(task: DesktopTaskRecord, initial: DesktopTaskRecord, input: DesktopRecoveryInput): void {
  owner(task, input); open(task);
  if (task.revision !== initial.revision) throw new DesktopTaskError("desktop_task_changed", "Desktop task changed during recovery; refresh Status");
}
function timeoutMs(value?: number): number {
  const timeout = resolveMonitorHardTimeoutMs(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 7 * 24 * 3_600_000) throw new DesktopTaskError("invalid_argument", "Desktop Watch timeout must be between 1 millisecond and 7 days");
  return timeout;
}
function retryNotification(task: DesktopTaskRecord, id?: string): DesktopNotification {
  const eligible = task.notifications.filter(notification => (!id || notification.id === id) &&
    ["failed", "retry_wait"].includes(notification.status) && notification.outcome?.disposition === "retryable_failure");
  if (eligible.length !== 1) throw new DesktopTaskError("desktop_callback_not_retryable", "Select one persisted callback with a retryable failure");
  return eligible[0];
}
export function createDesktopTaskRecovery(host: DesktopRecoveryHost) {
  const initial = (id: string, input: DesktopRecoveryInput) => { const task = host.status(id); owner(task, input); open(task); return task; };
  return {
    close(id: string, input: DesktopRecoveryInput & { reason?: string }): DesktopTaskRecord {
      const task = host.status(id); owner(task, input);
      if (task.kind !== "send") throw new DesktopTaskError("desktop_close_requires_send", "Observer Watches must use Unwatch");
      if (input.reason !== undefined && !input.reason.trim()) throw new DesktopTaskError("invalid_argument", "Close reason must be non-empty");
      return host.update(id, current => {
        owner(current, input);
        if (current.closed_at) return;
        current.closed_at = host.now().toISOString();
        if (input.reason !== undefined) current.close_reason = input.reason;
        clearDesktopInteractionAttention(current, "desktop_task_closed");
        suppressDesktopNotifications(current, "desktop_task_closed");
      });
    },
    unwatch(id: string, input: DesktopRecoveryInput): DesktopTaskRecord {
      owner(host.status(id), input);
      return host.update(id, task => {
        owner(task, input); task.unwatched_at ??= host.now().toISOString();
        clearDesktopInteractionAttention(task, "desktop_watch_unwatched");
        suppressDesktopNotifications(task, "desktop_watch_unwatched");
      });
    },
    async recover(id: string, input: DesktopRecoveryInput): Promise<DesktopTaskRecord> {
      const task = initial(id, input); const snapshot = await host.observe(task.target);
      return host.update(id, current => {
        fresh(current, task, input); host.applySnapshot(current, snapshot, true);
        host.expire(current); current.recovered_at = host.now().toISOString();
      });
    },
    async renew(id: string, input: DesktopRecoveryInput & { timeoutMs?: number }): Promise<DesktopTaskRecord> {
      const task = initial(id, input); const timeout = timeoutMs(input.timeoutMs);
      const snapshot = await host.observe(task.target);
      return host.update(id, current => {
        fresh(current, task, input); host.applySnapshot(current, snapshot, true);
        const turn = exactTurn(current, snapshot);
        if (["completed", "failed", "interrupted"].includes(current.status)) return;
        if (!turn || turn.status !== "inProgress" || snapshot.runtimeStatus !== "active") {
          throw new DesktopTaskError("desktop_exact_task_not_active", "Renew needs fresh active evidence for the original Desktop task");
        }
        current.deadline_at = backendRenewalDeadline(current, host.now(), timeout);
        current.renewed_at = host.now().toISOString(); current.renewal_count = (current.renewal_count ?? 0) + 1;
        current.status = "watching"; delete current.unwatched_at;
        suppressDesktopNotifications(current, "desktop_timeout_superseded", notification => notification.envelope.event.type === "desktop_watch.timed_out");
        host.applySnapshot(current, snapshot);
      });
    },
    async retryCallback(id: string, input: DesktopRecoveryInput & { notificationId?: string }): Promise<DesktopTaskRecord> {
      const task = initial(id, input);
      if (desktopObservationStopped(task)) throw new DesktopTaskError("desktop_watch_unwatched", "Renew observation before retrying its callback");
      const notification = retryNotification(task, input.notificationId);
      const interactionId = notification.envelope.event.metadata?.interaction_id;
      const snapshot = notification.envelope.event.requires_response ? await host.observe(task.target) : undefined;
      let obsolete = false;
      host.update(id, current => {
        fresh(current, task, input);
        if (desktopObservationStopped(current)) throw new DesktopTaskError("desktop_watch_unwatched", "This Desktop Watch was stopped");
        const currentNotification = retryNotification(current, notification.id);
        if (snapshot) {
          const turn = exactTurn(current, snapshot);
          if (!turn || turn.status !== "inProgress" || !turn.itemsComplete || !desktopInteractions(snapshot, current.native_turn_id)
            .some(interaction => interaction.id === interactionId && interaction.threadId === current.target.threadId && interaction.turnId === current.native_turn_id)) {
            currentNotification.status = "failed"; currentNotification.outcome = { disposition: "permanent_failure", error_code: "desktop_interaction_not_pending" };
            delete currentNotification.retry_at; obsolete = true; return;
          }
        }
        if (snapshot) host.applySnapshot(current, snapshot, true);
        prepareBackendCallbackRetry(current, { ...input, notificationId: currentNotification.id }, host.now());
      });
      if (obsolete) throw new DesktopTaskError("desktop_interaction_not_pending", "The original Desktop interaction is no longer confirmed pending");
      await host.deliverPending(id, notification.id); return host.status(id);
    }
  };
}
