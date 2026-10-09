import { isRecord, nonBlankString } from "./value-guards.js";

/** Desktop commands have native task identities, never fabricated managed Session or Turn ids. */
export function formatDesktopCommandResult(result: Record<string, unknown>, action: string): string {
  const state = nonBlankString(result.state) ?? nonBlankString(result.status) ?? nonBlankString(result.outcome) ?? nonBlankString(result.activity_state) ?? "unknown";
  return [`AKK Desktop ${action}: ${state}`,
    `conversation: ${nonBlankString(result.conversation_id) ?? "unknown"}`,
    ...optionalLine(result, "watch_id", "watch"), ...optionalLine(result, "native_turn_id", "native task"),
    ...modelLines(result), ...effectLines(result, state), ...optionalLine(result, "final_text", "result")].join("\n");
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
