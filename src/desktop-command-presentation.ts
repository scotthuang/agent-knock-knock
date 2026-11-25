import { isRecord, nonBlankString } from "./value-guards.js";
import { backendCallbackSummaryLines } from "./backend-callback-public-projection.js";
import { desktopDisplayNotice } from "./desktop-final-answer.js";

/** Desktop commands have native task identities, never fabricated managed Session or Turn ids. */
export function formatDesktopCommandResult(result: Record<string, unknown>, action: string): string {
  const state = nonBlankString(result.state) ?? nonBlankString(result.status) ?? nonBlankString(result.outcome) ?? nonBlankString(result.activity_state) ?? "unknown";
  return [`AKK Desktop ${action}: ${state}`,
    `conversation: ${nonBlankString(result.conversation_id) ?? "unknown"}`,
    ...optionalLine(result, "watch_id", "watch"), ...optionalLine(result, "native_turn_id", "native task"),
    ...queueLines(result),
    ...modelLines(result), ...effectLines(result, state), ...backendCallbackSummaryLines(result),
    ...answerLines(result)].join("\n");
}
function answerLines(result: Record<string, unknown>): string[] {
  const latest = result.latest_turn ?? (isRecord(result.persisted_history) ? result.persisted_history.latest_turn : undefined);
  const answer = isRecord(latest) && Array.isArray(latest.final_text_display) ? latest : result;
  const displays = answer.final_text_display;
  const notice = Array.isArray(displays) && !displays.some(item => !isRecord(item)) ? desktopDisplayNotice(displays) : "";
  return [...optionalLine(answer, "final_text", "result"), ...(notice ? [notice] : [])];
}
function queueLines(result: Record<string, unknown>): string[] {
  if (result.delivery_path !== "native_thread_queue") {
    if (result.can_send_reason === "native_queue_available") {
      const lines = ["Send appends one task to this thread's queue. Keep the returned Watch to follow execution."];
      if (Array.isArray(result.queue_notices) && result.queue_notices.includes("desktop_queue_question_pending")) {
        lines.push("A Desktop question may still need your answer. Appending a task leaves it for you to handle.");
      }
      return lines;
    }
    return result.connection_state === "desktop_queue_admission_blocked" ? optionalLine(result, "can_send_reason", "queue restriction") : [];
  }
  const lines = optionalLine(result, "observation_error", "queue observation");
  if (result.observation_error === "desktop_queue_entry_not_observed") {
    lines.push("The acknowledged entry is no longer visible. It may have been consumed or removed; AKK has no matching turn yet.");
  } else if (result.observation_error === "desktop_queue_entry_conflict") {
    lines.push("The visible queue entry conflicts with the original submission. AKK cannot attribute it to this task.");
  } else if (result.observation_error === "desktop_queue_history_requires_recover") {
    lines.push("Use Recover on this Watch for a deeper read of the original submission. Keep the same receipt.");
  } else if (result.observation_error === "desktop_queue_recovery_scan_limit" || result.observation_error === "desktop_queue_recovery_read_deadline") {
    lines.push("The deeper read exhausted its history or time budget before confirming attribution. Keep this Watch; do not resend.");
  }
  if (result.delivery_receipt === "native_queue_accepted") {
    lines.push("The original thread accepted the queue entry. Execution remains unconfirmed. Keep the existing Watch; do not resend.");
  } else if (result.send_state === "uncertain" && result.native_turn_id == null) {
    lines.push("The original queue acknowledgement is unconfirmed. Use the existing Watch for read-only reconciliation; do not resend.");
  }
  lines.push("If you manually reopen this thread in another client, that client may execute its queued work.");
  return lines;
}
function optionalLine(result: Record<string, unknown>, field: string, label: string): string[] {
  const value = nonBlankString(result[field]);
  return value ? [`${label}: ${value}`] : [];
}
function modelLines(result: Record<string, unknown>): string[] {
  if (result.catalog_available !== false) return [];
  const current = isRecord(result.current) ? result.current : {};
  return ["The Desktop owner exposes current settings, not an available model catalog.",
    `current model: ${nonBlankString(current.model) ?? "unknown"}`,
    `current reasoning: ${nonBlankString(current.reasoning_effort) ?? "unknown"}`,
    `current collaboration mode: ${nonBlankString(current.collaboration_mode) ?? "unknown"}`,
    "Use only a model/effort explicitly requested by the user."];
}
function effectLines(result: Record<string, unknown>, state: string): string[] {
  const effective = isRecord(result.effective) ? result.effective : {};
  return [...(Object.keys(effective).length ? [`verified effective settings: ${JSON.stringify(effective)}`] : []),
    ...optionalLine(result, "evidence", "evidence"),
    ...(result.do_not_retry === true || state === "uncertain" ? ["The native effect is unconfirmed. Refresh Status; do not retry automatically."] : []),
    ...(state === "sent" ? ["The response was dispatched; native acceptance has not yet been confirmed."] : [])];
}
