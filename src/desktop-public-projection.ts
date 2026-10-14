import { desktopInteractionResponseVerified, desktopProjectionCapabilities, type DesktopCapabilityProfile } from "./desktop-compatibility.js";
import { backendTaskRecoveryProjection } from "./backend-task-recovery.js";
import { backendCallbackPublicProjection } from "./backend-callback-public-projection.js";
import { desktopObservationStopped } from "./desktop-task-recovery.js";
import { desktopInteractionIsApproval, desktopInteractionProjection } from "./desktop-interaction-projection.js";
import type { DesktopCatalogEntry } from "./desktop-session-catalog.js";
import type { DesktopInteraction, DesktopSnapshot } from "./desktop-types.js";
import type { DesktopTaskRecord } from "./desktop-state-store.js";

export function desktopSessionProjection(entry: DesktopCatalogEntry, snapshot?: DesktopSnapshot,
  writesVerified: DesktopCapabilityProfile | boolean = false, observationError?: string): Record<string, unknown> {
  const profile = desktopProjectionCapabilities(writesVerified);
  const live = snapshot !== undefined;
  const activeTurn = activeDesktopTurn(snapshot);
  const watch = Boolean(activeTurn);
  const send = Boolean(snapshot?.canSend && profile.send);
  const interactions = activeTurn ? (snapshot?.pendingInteractions ?? snapshot?.asyncQuestions ?? [])
    .filter(item => item.turnId === activeTurn) : [];
  const supportedInteractions = interactions.filter(item => desktopInteractionResponseVerified(profile, item.kind));
  const settings = Boolean(profile.nativeControls && snapshot?.canSend && snapshot.runtimeStatus === "idle");
  const capabilities = { status: true, send, watch, interaction_notify: watch, ...interactionCapabilities(supportedInteractions),
    set_permissions: settings, set_model: settings, cancel: profile.nativeControls && watch };
  return {
    id: entry.conversationId, conversation_id: entry.conversationId, source: "codex_desktop", agent: "codex",
    title: snapshot?.title ?? entry.title, cwd: snapshot?.cwd ?? entry.cwd,
    native_thread_id: entry.threadId, host_id: entry.hostId, updated_at: new Date(entry.updatedAtMs).toISOString(),
    catalog_membership: entry.catalogMembership, creator_originator: entry.originator,
    ...(entry.sidebar ? { sidebar_section: entry.sidebar.section, sidebar_project_id: entry.sidebar.projectId,
      sidebar_project_name: entry.sidebar.projectName } : {}),
    connection_state: live ? "live_owner_verified" : "unconfirmed",
    activity_state: snapshot?.runtimeStatus ?? "unknown",
    ...sessionObservation(snapshot, profile),
    ...sessionSendAvailability(snapshot, profile.send, observationError),
    ...(observationError ? { observation_error: observationError } : {}), capabilities,
    ...(supportedInteractions.length < interactions.length ? { manual_action: "Handle interactions without an available AKK action in Desktop; their response control is not verified for this build." } : {}),
    pending_async_count: interactions.filter(item => item.kind === "async_question").length,
    pending_interaction_count: interactions.length,
    interaction_state: interactions.map(item => desktopInteractionProjection(item, entry.conversationId, undefined, profile)),
    available_actions: sessionActions(entry.conversationId, { live, send, watch, nativeControls: profile.nativeControls, cancel: profile.nativeControls && watch }, activeTurn)

  };
}

function sessionSendAvailability(snapshot: DesktopSnapshot | undefined, writesVerified: boolean, observationError?: string) {
  if (!snapshot) return { can_send_reason: observationError ?? "live_owner_not_confirmed",
    ...(observationError === "no_live_owner" ? {
      manual_action: "Open this conversation in Desktop, then refresh AKK List. It is listed but cannot currently receive tasks."
    } : {}) };
  return { can_send_reason: !writesVerified ? "desktop_write_contract_unverified"
    : snapshot.canSend ? "ready" : snapshot.idleBlockedReason ?? "desktop_not_sendable" };
}

/** Do not export prompts, internal owner IDs, callback configuration or raw native state. */
export function desktopTaskProjection(task: DesktopTaskRecord, writesVerified: DesktopCapabilityProfile | boolean = true): Record<string, unknown> {
  const profile = desktopProjectionCapabilities(writesVerified);
  const terminal = desktopObservationStopped(task) || ["completed", "failed", "interrupted", "timed_out", "cancelled"].includes(task.status);
  const interactions = !terminal ? actionableTaskInteractions(task) : [];
  const supportedInteractions = interactions.filter(item => desktopInteractionResponseVerified(profile, item.kind));
  const manualCount = task.pending_manual_count + interactions.length - supportedInteractions.length;
  const callback = backendCallbackPublicProjection(task, !terminal, desktopObservationStopped(task));
  const canCancel = profile.nativeControls && !terminal && Boolean(task.native_turn_id);
  const { recovery_actions, ...recovery } = backendTaskRecoveryProjection(task);
  return {
    watch_id: task.watch_id, conversation_id: task.desktop_id, source: "codex_desktop",
    status: task.closed_at ? "closed" : task.status, observation_status: task.status,
    ...recovery,
    observation_mode: task.native_turn_id ? "exact_task" : "pending_acceptance",
    anchor_state: task.native_turn_id ? "verified" : "pending", native_thread_id: task.target.threadId,
    native_turn_id: task.native_turn_id ?? null, created_at: task.created_at, updated_at: task.updated_at,
    observed_at: task.observed_at, observation_error: task.observation_error,
    pending_manual_count: manualCount, final_text: task.final_text,
    ...taskInteractionCounts(task, interactions),
    interaction_state: interactions.map(item => desktopInteractionProjection(item, task.desktop_id, task.watch_id, profile)),
    callback_expected: callbackExpected(task, terminal),
    callback_configured: Boolean(task.callback_route), ...callback,
    ...desktopSendReceiptProjection(task.send_intent),
    capabilities: { callback: Boolean(task.callback_route), interaction_notify: Boolean(task.callback_route),
      ...interactionCapabilities(supportedInteractions), cancel: canCancel, ...desktopRecoveryCapabilities(task) },
    available_actions: { ...recovery_actions, status: { tool: "agent_knock_knock_status", input: { watch_id: task.watch_id } },
      ...(canCancel ? { cancel: { tool: "agent_knock_knock_cancel", input: { watch_id: task.watch_id } } } : {}) },
    ...(manualCount ? { manual_action: terminal
      ? "Handle any remaining question or approval in Desktop; this Watch has stopped."
      : "Handle interactions without an available AKK action in Desktop; AKK continues watching this task." } : {})
  };
}

/** Keep task delivery evidence distinct from current interaction availability. */
function desktopSendReceiptProjection(intent: DesktopTaskRecord["send_intent"]): Record<string, unknown> {
  if (!intent) return {};
  const accepted = intent.state === "accepted";
  return { message_id: intent.message_id, delivery_receipt: accepted ? "native_task_verified"
    : intent.state === "not_sent" ? "not_sent" : "acceptance_unproven",
    delivered: accepted, agent_acceptance: accepted ? "proven" : "unproven",
    send_state: intent.state, send_error: intent.error_code, resend_allowed: false };
}

function actionableTaskInteractions(task: DesktopTaskRecord): DesktopInteraction[] {
  const items = task.pending_interactions ?? task.pending_async_interactions ?? [];
  if (!task.observation_error) return items;
  // The owner request list is independently fresh even when async turn history is partial.
  return task.observation_error === "desktop_async_questions_incomplete" ? items.filter(item => item.kind !== "async_question") : [];
}

function activeDesktopTurn(snapshot: DesktopSnapshot | undefined): string | undefined {
  if (!snapshot || snapshot.runtimeStatus !== "active" || !snapshot.tailKnown) return undefined;
  const active = snapshot.turns.filter(turn => turn.status === "inProgress");
  return active.length === 1 && snapshot.latestTurnId === active[0].turnId ? active[0].turnId : undefined;
}
function interactionCapabilities(interactions: DesktopInteraction[]) {
  return { interaction_respond: interactions.some(item => !desktopInteractionIsApproval(item)),
    approve: interactions.some(desktopInteractionIsApproval) };
}
function sessionObservation(snapshot: DesktopSnapshot | undefined, profile: DesktopCapabilityProfile) {
  if (!snapshot) return {};
  const actionable = (snapshot.pendingInteractions ?? []).filter(item => item.kind !== "async_question" && desktopInteractionResponseVerified(profile, item.kind)).length;
  return { native_turn_id: snapshot.latestTurnId, pending_manual_count: Math.max(0, snapshot.pendingRequestCount - actionable)
      + (snapshot.pendingInteractions ?? snapshot.asyncQuestions ?? []).filter(item => item.kind === "async_question"
        && !desktopInteractionResponseVerified(profile, item.kind)).length,
    observed_revision: snapshot.revision };
}
function sessionActions(id: string, capabilities: { live: boolean; send: boolean; watch: boolean; cancel: boolean; nativeControls: boolean }, activeTurn?: string) {
  const input = { conversation_id: id };
  return { status: { tool: "agent_knock_knock_status", input },
    ...(capabilities.send ? { send: { tool: "agent_knock_knock_send", input } } : {}),
    ...(capabilities.watch ? { watch: { tool: "agent_knock_knock_watch", input } } : {}),
    ...(capabilities.cancel ? { cancel: { tool: "agent_knock_knock_cancel", input: { ...input, expected_native_turn_id: activeTurn } } } : {}),
    ...(capabilities.live ? { native_inspect: { tool: "agent_knock_knock_native_inspect", input: { ...input, inspection: "status" } } } : {}),
    ...(capabilities.live && capabilities.nativeControls ? { permission_options: { tool: "agent_knock_knock_permission_options", input },
      model_options: { tool: "agent_knock_knock_model_options", input } } : {}) };
}
function callbackExpected(task: DesktopTaskRecord, terminal: boolean): boolean {
  return Boolean(task.callback_route && !desktopObservationStopped(task) &&
    (!terminal || task.notifications.some(note => ["ready", "retry_wait", "leased"].includes(note.status))));
}
function taskInteractionCounts(task: DesktopTaskRecord, items: DesktopInteraction[]) {
  return { pending_async_count: task.observation_error ? null : (task.pending_async_interactions ?? []).length,
    async_interactions_state: task.observation_error ? "unknown" : "current",
    pending_interaction_count: task.observation_error ? null : items.length };
}

function desktopRecoveryCapabilities(task: DesktopTaskRecord) {
  const stopped = desktopObservationStopped(task);
  return { close: task.kind === "send" && !task.closed_at, unwatch: !stopped,
    recover: !task.closed_at, renew: !task.closed_at && !["completed", "failed", "interrupted"].includes(task.status),
    retry_callback: !stopped && task.notifications.some(notification =>
      ["failed", "retry_wait"].includes(notification.status) && notification.outcome?.disposition === "retryable_failure") };
}
