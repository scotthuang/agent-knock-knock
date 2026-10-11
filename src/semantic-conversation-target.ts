import { normalizedTerminalSendResultContract } from "./terminal-dispatch-presenter.js";

/** Keep legacy terminal authority checks while accepting the List conversation ID. */
export function normalizeTerminalConversationTarget(params: Record<string, any>): Record<string, any> {
  if (typeof params.conversation_id !== "string" || !params.conversation_id.startsWith("terminal:")) return params;
  if (!/^terminal:v[0-9]+:\S+$/u.test(params.conversation_id)) {
    throw new Error("conversation_id must be the exact full identifier returned by AKK List");
  }
  if (["terminal_id", "session_id", "turn_id", "watch_id"].some(key => Object.hasOwn(params, key))) {
    throw new Error("conversation_id accepts no other target");
  }
  const { conversation_id, ...rest } = params;
  return { ...rest, terminal_id: conversation_id };
}

/** A terminal alias may resolve to a backend; never rewrite its exact native receipt. */
export function normalizeConversationSendResult(result: Record<string, any>): Record<string, any> {
  return result.source === "claude_cli" || result.source === "codex_cli" || result.source === "codex_desktop"
    ? result : { ...result, ...normalizedTerminalSendResultContract(result) };
}
