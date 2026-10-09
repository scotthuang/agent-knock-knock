import type { DesktopCatalogEntry } from "./desktop-session-catalog.js";
import type { DesktopSnapshot } from "./desktop-types.js";
import type { DesktopTaskRecord } from "./desktop-state-store.js";

export function desktopSessionProjection(entry: DesktopCatalogEntry, snapshot?: DesktopSnapshot,
  writesVerified = false, observationError?: string): Record<string, unknown> {
  const live = snapshot !== undefined;
  const active = snapshot?.turns.filter(turn => turn.status === "inProgress") ?? [];
  const watch = Boolean(snapshot?.runtimeStatus === "active" && snapshot.tailKnown && active.length === 1 && snapshot.latestTurnId === active[0].turnId);
  const send = Boolean(snapshot?.canSend && writesVerified);
  const capabilities = { status: true, send, watch, interaction_notify: watch, interaction_respond: false, approve: false };
  return {
    id: entry.conversationId, conversation_id: entry.conversationId, source: "codex_desktop", agent: "codex",
    title: snapshot?.title ?? entry.title, cwd: snapshot?.cwd ?? entry.cwd,
    native_thread_id: entry.threadId, host_id: entry.hostId, updated_at: new Date(entry.updatedAtMs).toISOString(),
    catalog_membership: entry.catalogMembership, creator_originator: entry.originator,
    connection_state: live ? "live_owner_verified" : "unconfirmed",
    activity_state: snapshot?.runtimeStatus ?? "unknown",
    ...(snapshot ? { native_turn_id: snapshot.latestTurnId, pending_manual_count: snapshot.pendingRequestCount,
      can_send_reason: snapshot.idleBlockedReason, observed_revision: snapshot.revision } : {}),
    ...(observationError ? { observation_error: observationError } : {}), capabilities,
    available_actions: {
      status: { tool: "agent_knock_knock_status", input: { conversation_id: entry.conversationId } },
      ...(send ? { send: { tool: "agent_knock_knock_send", input: { conversation_id: entry.conversationId } } } : {}),
      ...(watch ? { watch: { tool: "agent_knock_knock_watch", input: { conversation_id: entry.conversationId } } } : {})
    }
  };
}

/** Do not export prompts, internal owner IDs, callback configuration or raw native state. */
export function desktopTaskProjection(task: DesktopTaskRecord): Record<string, unknown> {
  const intent = task.send_intent;
  const terminal = ["completed", "failed", "interrupted", "timed_out", "cancelled"].includes(task.status);
  const notifications = task.notifications.map(n => ({ id: n.id, status: n.status, attempts: n.attempts,
    ...(n.outcome && "error_code" in n.outcome ? { error_code: n.outcome.error_code } : {}) }));
  return {
    watch_id: task.watch_id, conversation_id: task.desktop_id, source: "codex_desktop",
    status: task.status, observation_mode: task.native_turn_id ? "exact_task" : "pending_acceptance",
    anchor_state: task.native_turn_id ? "verified" : "pending", native_thread_id: task.target.threadId,
    native_turn_id: task.native_turn_id ?? null, created_at: task.created_at, updated_at: task.updated_at,
    observed_at: task.observed_at, observation_error: task.observation_error,
    pending_manual_count: task.pending_manual_count, final_text: task.final_text,
    callback_expected: Boolean(task.callback_route && task.status !== "cancelled" &&
      (!terminal || notifications.some(n => ["ready", "retry_wait", "leased"].includes(n.status)))),
    callback_configured: Boolean(task.callback_route), callback_notifications: notifications,
    ...(intent ? { message_id: intent.message_id, delivery_receipt: intent.state === "accepted" ? "native_task_verified"
      : intent.state === "not_sent" ? "not_sent" : "acceptance_unproven",
      delivered: intent.state === "accepted", agent_acceptance: intent.state === "accepted" ? "proven" : "unproven",
      send_state: intent.state, send_error: intent.error_code, resend_allowed: false } : {}),
    capabilities: { callback: Boolean(task.callback_route), interaction_notify: Boolean(task.callback_route), interaction_respond: false, approve: false },
    ...(task.pending_manual_count ? { manual_action: terminal
      ? "Handle any remaining question or approval in Desktop; this Watch has stopped."
      : "Answer the question or approval in Desktop; AKK continues watching this task." } : {})
  };
}
