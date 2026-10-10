import type { CallbackAttemptOutcome } from "./callback-transport.js";

/** Additive fields keep existing v1 backend records readable. Management and observation are separate. */
export interface BackendRecoveryFields {
  closed_at?: string;
  close_reason?: string;
  unwatched_at?: string;
  renewed_at?: string;
  renewal_count?: number;
  recovered_at?: string;
}
export interface BackendRetryFields {
  /** Highest cumulative attempt explicitly authorized by a manual retry. */
  retry_budget_until?: number;
  retry_requested_at?: string;
}
export interface BackendRecoveryNotification extends BackendRetryFields {
  id: string;
  status: string;
  attempts: number;
  retry_at?: string;
  outcome?: CallbackAttemptOutcome;
}
export interface BackendRecoveryTask extends BackendRecoveryFields {
  id: string;
  kind: "send" | "watch";
  status: string;
  controller_session: string;
  deadline_at: string;
  notifications: BackendRecoveryNotification[];
}
export class BackendRecoveryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BackendRecoveryError"; }
}
export function assertBackendRecoveryOwner(task: BackendRecoveryTask, input: { controllerSession: string }): void {
  if (!input.controllerSession?.trim() || input.controllerSession !== task.controller_session) {
    throw new BackendRecoveryError("backend_controller_mismatch", "Only the owning controller can recover this exact task");
  }
}
export function backendObservationStopped(task: BackendRecoveryFields & { status: string }): boolean {
  return Boolean(task.closed_at || task.unwatched_at || task.status === "cancelled");
}
export function assertBackendRecoveryFields(task: BackendRecoveryTask): void {
  assertRecoveryTimes(task);
  if (task.closed_at && task.kind !== "send") throw new Error("Only a managed send can be closed");
  if (task.close_reason !== undefined && (!task.closed_at || typeof task.close_reason !== "string" || !task.close_reason.trim())) throw new Error("Invalid backend close reason");
  if (task.renewal_count !== undefined && (!Number.isSafeInteger(task.renewal_count) || task.renewal_count < 0)) throw new Error("Invalid backend renewal count");
  if (Boolean(task.renewed_at) !== Boolean(task.renewal_count)) throw new Error("Backend renewal must include its time and generation");
  for (const note of task.notifications) assertRetryFields(note);
}
function assertRecoveryTimes(task: BackendRecoveryFields): void {
  for (const field of ["closed_at", "unwatched_at", "renewed_at", "recovered_at"] as const) {
    if (task[field] !== undefined && (typeof task[field] !== "string" || !Number.isFinite(Date.parse(task[field])))) {
      throw new Error(`Invalid backend recovery ${field}`);
    }
  }
}
function assertRetryFields(note: BackendRetryFields): void {
  if (note.retry_budget_until !== undefined && (!Number.isSafeInteger(note.retry_budget_until) || note.retry_budget_until < 1)) throw new Error("Invalid backend callback retry budget");
  if (note.retry_requested_at !== undefined && (typeof note.retry_requested_at !== "string" || !Number.isFinite(Date.parse(note.retry_requested_at)))) throw new Error("Invalid backend callback retry time");
}
export function assertBackendRecoveryUpdate(previous: BackendRecoveryTask, next: BackendRecoveryTask): void {
  if (previous.closed_at && (next.closed_at !== previous.closed_at || next.close_reason !== previous.close_reason)) throw new Error("Closed backend management cannot be reopened");
  const before = previous.renewal_count ?? 0;
  const after = next.renewal_count ?? 0;
  if (after !== before && after !== before + 1) throw new Error("Backend renewal generation must advance once");
  if (previous.deadline_at !== next.deadline_at && (after !== before + 1 ||
    Date.parse(next.deadline_at) < Date.parse(previous.deadline_at) || !next.renewed_at || next.closed_at)) {
    throw new Error("Backend deadline change requires an explicit monotonic renewal");
  }
  if (previous.unwatched_at && !next.unwatched_at && after !== before + 1) throw new Error("Only renewal can resume stopped observation");
  assertNotificationHistory(previous.notifications, next.notifications);
}
function assertNotificationHistory(previous: BackendRecoveryNotification[], next: BackendRecoveryNotification[]): void {
  for (const old of previous) {
    const current = next.find(note => note.id === old.id);
    if (!current || current.attempts < old.attempts || (current.retry_budget_until ?? 0) < (old.retry_budget_until ?? 0)) throw new Error("Backend callback history cannot be reset");
  }
}
export function backendRenewalDeadline(task: BackendRecoveryTask, now: Date, timeoutMs = 3_600_000): string {
  if (task.closed_at) throw new BackendRecoveryError("backend_task_closed", "Closed management cannot be renewed");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 7 * 24 * 3_600_000) {
    throw new BackendRecoveryError("invalid_argument", "Renewal must be between one millisecond and seven days");
  }
  return new Date(Math.max(Date.parse(task.deadline_at), now.getTime() + timeoutMs)).toISOString();
}
export function suppressBackendNotifications(task: BackendRecoveryTask, code: string): void {
  for (const note of task.notifications) if (["ready", "retry_wait"].includes(note.status)) {
    note.status = "failed";
    note.outcome = { disposition: "permanent_failure", error_code: code };
    delete note.retry_at;
  }
}
export function closeBackendManagement(task: BackendRecoveryTask, input: { controllerSession: string; reason?: string }, now: Date): void {
  assertBackendRecoveryOwner(task, input);
  if (task.kind !== "send") throw new BackendRecoveryError("backend_watch_not_managed", "Close requires a managed send; use Unwatch to stop an observation-only Watch");
  if (task.closed_at) return;
  task.closed_at = now.toISOString();
  if (input.reason?.trim()) task.close_reason = input.reason.trim();
  suppressBackendNotifications(task, "backend_management_closed");
}
export function stopBackendObservation(task: BackendRecoveryTask, now: Date): void {
  task.unwatched_at ??= now.toISOString();
  suppressBackendNotifications(task, "backend_watch_stopped");
}
export function isBackendCallbackRetryable(task: BackendRecoveryTask, note: BackendRecoveryNotification): boolean {
  return !backendObservationStopped(task) && ["failed", "retry_wait"].includes(note.status) && note.outcome?.disposition === "retryable_failure";
}
export function prepareBackendCallbackRetry(task: BackendRecoveryTask, input: { controllerSession: string; notificationId?: string }, now: Date): string {
  assertBackendRecoveryOwner(task, input);
  if (backendObservationStopped(task)) throw new BackendRecoveryError("backend_observation_stopped", "Stopped or closed observation cannot retry callbacks");
  const selected = input.notificationId
    ? task.notifications.filter(note => note.id === input.notificationId)
    : task.notifications.filter(note => isBackendCallbackRetryable(task, note));
  if (selected.length !== 1 || !isBackendCallbackRetryable(task, selected[0])) throw new BackendRecoveryError("backend_callback_not_retryable", "Select exactly one known retryable callback; accepted, uncertain, in-flight and obsolete notifications cannot be replayed");
  const note = selected[0];
  note.retry_budget_until = Math.max(note.retry_budget_until ?? 0, note.attempts + 1);
  note.retry_requested_at = now.toISOString();
  note.status = "ready";
  delete note.retry_at;
  return note.id;
}
export function backendCallbackMaxAttempts(note: BackendRetryFields, defaultMax: number): number {
  return Math.max(defaultMax, note.retry_budget_until ?? 0);
}
export function backendTaskRecoveryProjection(task: BackendRecoveryTask) {
  const stopped = backendObservationStopped(task);
  const settled = ["completed", "failed", "interrupted"].includes(task.status);
  const input = { watch_id: task.id };
  const retryable = task.notifications.filter(note => isBackendCallbackRetryable(task, note));
  return {
    task_kind: task.kind,
    ...(task.kind === "send" ? { turn_id: task.id } : {}),
    management_state: task.kind === "watch" ? "unmanaged" : task.closed_at ? "closed" : "managed",
    observation_state: stopped ? "stopped" : task.status === "timed_out" ? "expired" : settled ? "settled" : "watching",
    deadline_at: task.deadline_at, renewal_count: task.renewal_count ?? 0,
    closed_at: task.closed_at, close_reason: task.close_reason, unwatched_at: task.unwatched_at,
    renewed_at: task.renewed_at, recovered_at: task.recovered_at,
    callback_in_flight: task.notifications.some(note => note.status === "leased"),
    retryable_callback_ids: retryable.map(note => note.id),
    recovery_actions: {
      ...(!task.closed_at ? { recover: { tool: "agent_knock_knock_recover", input } } : {}),
      ...(!task.closed_at && !settled ? { renew: { tool: "agent_knock_knock_renew", input } } : {}),
      ...(!stopped ? { unwatch: { tool: "agent_knock_knock_unwatch", input } } : {}),
      ...(task.kind === "send" && !task.closed_at ? { close: { tool: "agent_knock_knock_close", input: { turn_id: task.id } } } : {}),
      ...(retryable.length === 1 ? { retry_callback: { tool: "agent_knock_knock_retry_callback", input: { ...input, notification_id: retryable[0].id } } } : {})
    }
  };
}
