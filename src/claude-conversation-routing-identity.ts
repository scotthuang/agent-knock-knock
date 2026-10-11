import { parseClaudeNativeConversationId } from "./claude-native-identity.js";
import { parseTerminalConversationId } from "./terminal-agent-adapter.js";
import { recordValue } from "./value-guards.js";

type Row = Record<string, unknown>;
const normalized = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : undefined;
const psTimestamp = /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u;
/** Native registry uses TZ=UTC; terminal-process-source uses the host process timezone.
 * Both are full ps lstart values, never elapsed ages or locale-free numeric guesses. */
export function claudeProcessBirthMatches(nativeUtc: string, terminalLocal: unknown): boolean {
  const local = normalized(terminalLocal);
  if (!local || !psTimestamp.test(nativeUtc) || !psTimestamp.test(local)) return false;
  const nativeTime = Date.parse(`${nativeUtc} GMT`), terminalTime = Date.parse(local);
  return Number.isFinite(nativeTime) && Number.isFinite(terminalTime) && nativeTime === terminalTime;
}

/** Never associate by cwd/title: require the same live process incarnation and native session. */
export function exactClaudeTerminal(nativeId: string, terminal: Row): boolean {
  try {
    const native = parseClaudeNativeConversationId(nativeId);
    const terminalId = String(terminal.id ?? terminal.terminal_id ?? "");
    const parsed = parseTerminalConversationId(terminalId);
    const observation = recordValue(terminal.native_agent_identity_observation);
    return terminal.agent === "claude" && parsed?.agent === "claude" && terminal.process_state === "active"
      && terminal.pid === native.pid && claudeProcessBirthMatches(native.processStart,
        terminal._physical_agent_process_birth ?? terminal.native_agent_process_birth)
      && terminal.native_agent_session_id === native.sessionId
      && (observation?.status ?? terminal.native_identity_state) === "resolved";
  } catch { return false; }
}

export function associateClaudeConversationRoutes(terminals: readonly Row[], nativeRows: readonly Row[]) {
  const associations: Array<{ nativeId: string; terminalId: string }> = [];
  for (const native of nativeRows) {
    const id = String(native.conversation_id ?? native.id ?? "");
    if (native.source !== "claude_cli") continue;
    const matches = terminals.filter(terminal => exactClaudeTerminal(id, terminal));
    if (matches.length !== 1) continue;
    if (nativeRows.filter(other => exactClaudeTerminal(String(other.conversation_id ?? other.id ?? ""), matches[0])).length !== 1) continue;
    associations.push({ nativeId: id, terminalId: String(matches[0].id) });
  }
  return associations;
}
