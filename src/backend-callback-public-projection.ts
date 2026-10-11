import type { BackendRecoveryNotification } from "./backend-task-recovery.js";

type CallbackSummaryInput = {
  callback_route?: unknown;
  notifications: BackendRecoveryNotification[];
};

/** Task completion, controller acceptance and downstream channel delivery are independent facts. */
export function backendCallbackPublicProjection(task: CallbackSummaryInput, active: boolean, stopped: boolean) {
  return {
    callback_state: callbackState(task, active, stopped),
    callback_delivery_scope: "controller_acceptance_only" as const,
    channel_delivery_state: "unknown" as const,
    callback_notifications: task.notifications.map(notificationProjection)
  };
}

function acceptanceConfirmed(note: BackendRecoveryNotification): boolean {
  return note.status === "accepted" && note.outcome?.disposition === "accepted";
}

function callbackState(task: CallbackSummaryInput, active: boolean, stopped: boolean): string {
  if (!task.callback_route) return "not_configured";
  // A completed task or an accepted earlier interaction cannot hide an unresolved notification.
  if (task.notifications.some(note => note.status === "uncertain" ||
    note.status === "accepted" && !acceptanceConfirmed(note))) return "uncertain";
  if (task.notifications.some(note => note.status === "failed")) return "failed";
  for (const [status, label] of [["leased", "in_flight"], ["retry_wait", "retry_wait"], ["ready", "pending"]]) {
    if (task.notifications.some(note => note.status === status)) return label;
  }
  if (active) return "monitoring";
  if (task.notifications.length && task.notifications.every(acceptanceConfirmed)) return "accepted";
  return stopped ? "stopped" : "not_pending";
}

function notificationProjection(note: BackendRecoveryNotification) {
  const evidence = note.outcome?.evidence;
  const phase = evidence?.request_phase;
  return {
    id: note.id, notification_id: note.id, status: note.status, attempts: note.attempts,
    controller_acceptance: acceptanceConfirmed(note) ? "confirmed" : "unconfirmed",
    ...(note.outcome && "error_code" in note.outcome ? { error_code: note.outcome.error_code } : {}),
    ...(typeof evidence?.request_dispatched === "boolean" ? { request_dispatched: evidence.request_dispatched } : {}),
    ...(typeof phase === "string" && ["connection_handshake", "before_dispatch", "submitted", "unknown"].includes(phase)
      ? { request_phase: phase } : {}),
    ...(typeof evidence?.retry_budget_exhausted === "boolean" ? { retry_budget_exhausted: evidence.retry_budget_exhausted } : {}),
    ...(Number.isSafeInteger(evidence?.max_delivery_attempts) && Number(evidence?.max_delivery_attempts) > 0
      ? { max_delivery_attempts: Number(evidence?.max_delivery_attempts) } : {}),
    ...(note.retry_at ? { next_attempt_at: note.retry_at } : {}),
    ...(note.status === "failed" && note.outcome?.disposition === "retryable_failure"
      ? { automatic_retry_stopped: true } : {})
  };
}

export function backendCallbackSummaryLines(result: Record<string, unknown>): string[] {
  if (result.callback_delivery_scope !== "controller_acceptance_only") return [];
  return [
    `callback state: ${typeof result.callback_state === "string" ? result.callback_state : "unknown"}`,
    "Callback acceptance only confirms controller acceptance; user-channel delivery is unknown."
  ];
}
