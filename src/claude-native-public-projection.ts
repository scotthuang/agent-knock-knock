import { backendObservationStopped, backendTaskRecoveryProjection, isBackendCallbackRetryable } from "./backend-task-recovery.js";
import { backendCallbackPublicProjection } from "./backend-callback-public-projection.js";
import { createClaudeNativeConversationId, type ClaudeNativeCatalogEntry } from "./claude-native-identity.js";
import type { ClaudeNativeSnapshot, ClaudeNativePublicProgress } from "./claude-native-observation.js";
import type { ClaudeNativeTaskRecord } from "./claude-native-state-store.js";

const specialCapabilities = {
  interaction_notify: false, interaction_respond: false, approve: false,
  model_options: false, set_model: false, permission_options: false, set_permissions: false,
  cancel: false, new_thread: false, clear_thread: false, resume_thread: false, list_resumable_threads: false
} as const;
const activeStatus = (status: string) => status === "watching" || status === "awaiting_acceptance";
const settledStatus = (status: string) => ["completed", "failed", "interrupted", "exited"].includes(status);
function waitingProjection(waitingFor: string | undefined, waiting: boolean) {
  const kind = waitingFor === "permission prompt" ? "approval" : waitingFor === "input needed" ? "input" : "unknown";
  return { waiting_for: !waiting ? null : kind === "approval" ? "permission prompt" : kind === "input" ? "input needed" : "unknown",
    attention_required: waiting, manual_required: waiting,
    interaction_requests_scanned: false, pending_interaction_count: null,
    ...(waiting ? { interaction_hint: { kind, actionable: false, source: "native_registry" },
      next_action: "return_to_claude_terminal" } : {}) };
}

/** The no-snapshot form is List-safe: no transcript read or progress/answer body. */
export function claudeNativeSessionProjection(entry: ClaudeNativeCatalogEntry, snapshot?: ClaudeNativeSnapshot) {
  const id = createClaudeNativeConversationId(entry);
  const selected = snapshot?.selectedInput;
  const current = selected?.inputUuid === snapshot?.latestInputUuid;
  const watching = entry.status === "working" || entry.status === "waiting";
  const canWatch = watching && (!snapshot || !snapshot.readError && current && selected?.kind === "root_user" && selected.state === "inProgress");
  const canSend = entry.status === "idle";
  return {
    id, conversation_id: id, source: "claude_cli", agent: "claude",
    title: entry.name ?? "Claude Code", cwd: entry.cwd,
    native_thread_id: entry.sessionId, pid: entry.pid, agent_version: entry.version,
    connection_state: "native_registry_verified", activity_state: entry.status, observed_at: entry.observedAt,
    ...waitingProjection(entry.waitingFor, entry.status === "waiting"),
    capabilities: { status: true, send: canSend, watch: canWatch, ...specialCapabilities },
    available_actions: {
      status: { tool: "agent_knock_knock_status", input: { conversation_id: id } },
      ...(canSend ? { send: { tool: "agent_knock_knock_send", input: { conversation_id: id } } } : {}),
      ...(canWatch ? { watch: { tool: "agent_knock_knock_watch", input: { conversation_id: id } } } : {})
    },
    ...(snapshot ? {
      native_input_id: selected?.inputUuid ?? null, task_anchor_kind: "native_input_uuid",
      read_at: snapshot.readAt, observation_error: snapshot.readError ?? selected?.reason,
      input_state: selected?.state ?? "unknown", input_is_latest: current,
      response_text: selected?.responseText ?? "", response_truncated: selected?.responseTruncated ?? false,
      progress: snapshot.progress
    } : {})
  };
}

/** Send's internal Watch is the only completion monitor, never a second hidden subscription. */
export function claudeNativeTaskProjection(task: ClaudeNativeTaskRecord, includeProgress = false) {
  const { recovery_actions: commonActions, ...recovery } = backendTaskRecoveryProjection(task);
  const stopped = backendObservationStopped(task), active = !stopped && activeStatus(task.status);
  const settled = settledStatus(task.status);
  const canRenew = !task.closed_at && !settled;
  const { renew: commonRenew, ...otherActions } = commonActions;
  const recoveryActions = { ...otherActions, ...(canRenew && commonRenew ? { renew: commonRenew } : {}) };
  const nextAction = active ? "wait_or_status" : task.status === "timed_out" && canRenew ? "renew_existing_watch"
    : task.status === "exited" ? "return_to_claude_terminal" : "none";
  return {
    watch_id: task.id, conversation_id: task.native_id, source: "claude_cli", agent: "claude",
    status: task.closed_at ? "closed" : task.status, ...recovery,
    observation_state: stopped ? "stopped" : settled ? "settled" : task.status === "timed_out" ? "expired" : "watching",
    task_origin: task.kind, observation_status: task.status, observation_active: active,
    native_thread_id: task.target.sessionId, native_input_id: task.native_input_id ?? null,
    task_anchor_kind: "native_input_uuid", observation_mode: task.native_input_id ? "exact_task" : "pending_acceptance",
    anchor_state: task.native_input_id ? "verified" : "pending", needs_watch: false, next_action: nextAction,
    created_at: task.created_at, updated_at: task.updated_at, observed_at: task.observed_at,
    observation_error: task.observation_error,
    ...waitingProjection(task.waiting_for, active && Boolean(task.waiting_for)),
    callback_configured: Boolean(task.callback_route), callback_expected: callbackExpected(task, active, stopped),
    ...backendCallbackPublicProjection(task, active, stopped),
    capabilities: { status: true, close: task.kind === "send" && !task.closed_at, unwatch: !stopped,
      renew: canRenew, recover: !task.closed_at,
      retry_callback: task.notifications.some(note => isBackendCallbackRetryable(task, note)),
      callback: Boolean(task.callback_route) && !stopped, ...specialCapabilities },
    available_actions: {
      status: { tool: "agent_knock_knock_status", input: { watch_id: task.id } }, ...recoveryActions
    },
    ...sendProjection(task), ...bodyProjection(task, includeProgress)
  };
}

function sendProjection(task: ClaudeNativeTaskRecord) {
  const intent = task.send_intent;
  if (!intent) return {};
  const accepted = intent.state === "accepted";
  return { message_id: intent.message_id, delivered: accepted, send_state: intent.state,
    delivery_receipt: accepted ? "native_task_verified" : intent.state === "not_sent" ? "not_sent" : "acceptance_unproven",
    agent_acceptance: accepted ? "proven" : "unproven", send_error: intent.error_code, resend_allowed: false };
}
function bodyProjection(task: ClaudeNativeTaskRecord, includeProgress: boolean) {
  return includeProgress ? { response_text: task.response_text ?? "", response_truncated: task.response_truncated ?? false,
    progress: task.progress as ClaudeNativePublicProgress | undefined } : {};
}

function callbackExpected(task: ClaudeNativeTaskRecord, active: boolean, stopped: boolean): boolean {
  const pending = task.notifications.some(note => ["ready", "leased", "retry_wait"].includes(note.status));
  return Boolean(task.callback_route && !stopped && (active || pending));
}
