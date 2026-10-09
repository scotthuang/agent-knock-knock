import { createCallbackEnvelope } from "./callback-transport.js";
import { desktopInteractions } from "./desktop-request-interactions.js";
import { persistDesktopInteraction } from "./desktop-interaction-state.js";
import { desktopInteractionProjection } from "./desktop-interaction-projection.js";
import type { DesktopAsyncInteraction, DesktopInteraction, DesktopPendingRequest, DesktopSnapshot } from "./desktop-types.js";
import type { DesktopTaskRecord } from "./desktop-state-store.js";

function callbackInteraction(task: DesktopTaskRecord, interaction: DesktopInteraction) {
  const projected: Record<string, unknown> = { ...desktopInteractionProjection(interaction, task.desktop_id, task.id) };
  const output: Record<string, unknown> = { conversation_id: task.desktop_id, watch_id: task.id };
  for (const key of ["interaction_id", "kind", "status", "native_thread_id", "native_turn_id", "questions",
    "command", "reason", "cwd", "file_changes", "network", "available_decisions", "decisions"]) if (projected[key] !== undefined) output[key] = projected[key];
  return output;
}

function interactionBody(task: DesktopTaskRecord, interaction: DesktopInteraction): string {
  const approval = interaction.kind === "command_approval" || interaction.kind === "file_approval";
  const summary = approval ? interaction.command ?? interaction.reason ?? "Review the pending file changes."
    : interaction.questions.map(question => `${question.title}${question.options.length ? `\nOptions: ${question.options.join(" / ")}` : ""}`).join("\n");
  const state = interaction.kind === "async_question" ? "has a question awaiting your reply. The task may continue working."
    : approval ? "is waiting for approval." : "is waiting for an answer before it can continue.";
  return `Desktop task ${task.id} ${state}\n${summary}\n` +
    `Refresh AKK Status for this exact conversation or Watch to confirm that the interaction is still current, then ask the user. ` +
    (approval ? "Use AKK Approve only with the user's decision; do not approve automatically.\n"
      : "Only use AKK Respond after the user supplies an answer; do not choose an answer automatically.\n") +
    JSON.stringify(callbackInteraction(task, interaction));
}

/** Native pending requests and asynchronous questions have distinct completeness evidence. */
export function updateDesktopInteractionAttention(task: DesktopTaskRecord, snapshot: DesktopSnapshot): void {
  const turn = snapshot.turns.find(candidate => candidate.turnId === task.native_turn_id);
  // A partial history is missing evidence, not proof that a question was answered.
  if (!turn || turn.status === "unknown") {
    task.observation_error = "desktop_interactions_incomplete";
    return;
  }
  const pending = turn.status === "inProgress" ? desktopInteractions(snapshot, task.native_turn_id)
    .filter(interaction => interaction.threadId === task.target.threadId) : [];
  if (turn.status === "inProgress" && !turn.itemsComplete) {
    task.observation_error = "desktop_async_questions_incomplete";
    pending.push(...(task.pending_async_interactions ?? []).filter(previous => !pending.some(current => current.id === previous.id)));
  }
  task.pending_interactions = pending.map(persistDesktopInteraction);
  task.pending_async_interactions = task.pending_interactions.filter((interaction): interaction is DesktopAsyncInteraction => interaction.kind === "async_question");
  revokeInteractionNotifications(task, pending, "desktop_interaction_resolved");
  if (!task.callback_route) return;
  for (const interaction of pending) {
    const id = `${task.id}:interaction:${interaction.id}`;
    if (task.notifications.some(notification => notification.id === id)) continue;
    task.notifications.push({ id, attempts: 0, status: "ready", envelope: createCallbackEnvelope({ route: task.callback_route,
      source: { kind: "desktop_watch", watch_id: task.id, desktop_id: task.desktop_id },
      event: { id, type: "desktop_watch.interaction", body: interactionBody(task, interaction), requires_response: true,
        metadata: { watch_id: task.id, desktop_id: task.desktop_id, thread_id: task.target.threadId, turn_id: task.native_turn_id,
          interaction_id: interaction.id, interaction: callbackInteraction(task, interaction),
          action: interaction.kind.endsWith("approval") ? "approve" : "respond" } }
    }) });
  }
}

function revokeInteractionNotifications(task: DesktopTaskRecord, pending: DesktopInteraction[], errorCode: string): void {
  for (const notification of task.notifications) {
    const interactionId = notification.envelope.event.metadata?.interaction_id;
    if (notification.envelope.event.type === "desktop_watch.interaction" && typeof interactionId === "string" &&
      !pending.some(interaction => interaction.id === interactionId) && ["ready", "retry_wait"].includes(notification.status)) {
      notification.status = "failed";
      notification.outcome = { disposition: "permanent_failure", error_code: errorCode };
    }
  }
}

/** Stopping observation never implies that the original task or native question stopped. */
export function clearDesktopInteractionAttention(task: DesktopTaskRecord, errorCode: string): void {
  task.pending_async_interactions = [];
  task.pending_interactions = [];
  revokeInteractionNotifications(task, [], errorCode);
}

/** Keep unsupported special forms manual; supported requests already have actionable notifications. */
export function desktopManualRequests(task: DesktopTaskRecord, snapshot: DesktopSnapshot): DesktopPendingRequest[] {
  const turn = snapshot.turns.find(candidate => candidate.turnId === task.native_turn_id);
  if (turn?.status !== "inProgress") return [];
  return snapshot.pendingRequests.filter(request => (request.turnId === task.native_turn_id ||
    !request.turnId && snapshot.latestTurnId === task.native_turn_id) && !(task.pending_interactions ?? []).some(interaction =>
      interaction.kind !== "async_question" && interaction.method === request.method && interaction.requestId === request.requestId));
}

/** A request promoted to an actionable interaction must not also deliver an old manual-only notice. */
export function revokeObsoleteDesktopManualAttention(task: DesktopTaskRecord): void {
  const currentId = task.pending_manual_fingerprint ? `${task.id}:manual:${task.pending_manual_fingerprint}` : undefined;
  for (const notification of task.notifications) {
    if (notification.envelope.event.type === "desktop_watch.manual" && notification.id !== currentId &&
      ["ready", "retry_wait"].includes(notification.status)) {
      notification.status = "failed";
      notification.outcome = { disposition: "permanent_failure", error_code: "desktop_manual_attention_changed" };
    }
  }
}
