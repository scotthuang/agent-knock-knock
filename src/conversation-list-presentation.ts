import path from "node:path";
import { claudeProcessBirthMatches } from "./claude-conversation-routing-identity.js";
import { parseClaudeNativeConversationId } from "./claude-native-identity.js";
import { parseCodexNativeConversationId } from "./codex-native-identity.js";

type Row = Record<string, unknown>;
export interface ConversationListPresentationOptions { diagnostics?: boolean }
type WorkspaceGroup = { terminal_conversation_id: string; native_conversation_id: string };

/** Workspace grouping changes only the inventory presentation, never routing identity or authority. */
export function presentConversationList(conversations: readonly Row[], physicalTerminals: readonly Row[],
  options: ConversationListPresentationOptions = {}) {
  const groups = workspaceGroups(conversations, physicalTerminals);
  const hidden = new Set(options.diagnostics ? [] : groups.map(group => group.native_conversation_id));
  return {
    conversations: conversations.filter(row => !hidden.has(String(row.conversation_id)))
      .map((row): Row => ({ ...row, surface: row.source === "codex_desktop" ? "desktop" : "cli" })),
    conversation_presentation: {
      mode: options.diagnostics ? "diagnostics" : "default",
      workspace_grouped_connections: hidden.size,
      ...(options.diagnostics ? { workspace_groups: groups } : {})
    }
  };
}

function workspaceGroups(conversations: readonly Row[], physicalTerminals: readonly Row[]): WorkspaceGroup[] {
  const nativeRows = conversations.filter(row => ["codex_cli", "claude_cli"].includes(String(row.source)));
  const groups: WorkspaceGroup[] = [];
  for (const terminal of physicalTerminals) {
    const key = workspaceKey(terminal);
    if (!key || terminal.process_state !== "active") continue;
    const terminalId = String(terminal.id ?? "");
    const visible = conversations.find(row => row.conversation_id === terminalId);
    if (!visible || !terminalId.startsWith("terminal:") || workspaceKey(visible) !== key) continue;
    // Count all observed connections, including already-associated ones, rather than arbitrarily pairing a subset.
    if (physicalTerminals.filter(row => workspaceKey(row) === key).length !== 1) continue;
    const candidates = nativeRows.filter(row => workspaceKey(row) === key);
    if (candidates.length !== 1) continue;
    const native = candidates[0];
    if ((Array.isArray(native.terminal_aliases) && native.terminal_aliases.length > 0) || !canGroup(terminal, native)) continue;
    groups.push({ terminal_conversation_id: terminalId, native_conversation_id: String(native.conversation_id) });
  }
  return groups;
}

function workspaceKey(row: Row): string | undefined {
  if (!["codex", "claude"].includes(String(row.agent))) return undefined;
  const cwd = absolutePath(row.cwd);
  return cwd ? JSON.stringify([row.agent, cwd]) : undefined;
}

function canGroup(terminal: Row, native: Row): boolean {
  try {
    const nativeId = String(native.conversation_id ?? "");
    if (native.agent === "codex" && native.connection_state === "loaded_backend_verified") {
      const identity = parseCodexNativeConversationId(nativeId);
      if (native.native_thread_id !== identity.threadId || threadConflict(terminal, identity.threadId)) return false;
      return [terminal.codex_home, terminal.native_agent_codex_home, terminal._codex_home]
        .every(home => home === undefined || absolutePath(home) === identity.codexHome);
    }
    if (native.agent === "claude" && native.connection_state === "native_registry_verified") {
      const identity = parseClaudeNativeConversationId(nativeId);
      const birth = terminal._physical_agent_process_birth ?? terminal.native_agent_process_birth;
      return native.native_thread_id === identity.sessionId && native.pid === identity.pid && terminal.pid === identity.pid
        && !threadConflict(terminal, identity.sessionId)
        && (birth === undefined || typeof birth === "string" && claudeProcessBirthMatches(identity.processStart, birth));
    }
  } catch { /* Malformed identity is not a presentation candidate. */ }
  return false;
}

function threadConflict(terminal: Row, nativeThreadId: string): boolean {
  return [terminal.native_agent_session_id, terminal.native_agent_status_card_session_id,
    terminal._routing_inspection_thread_id].some(value => value !== undefined && value !== null &&
      (typeof value !== "string" || value.toLowerCase() !== nativeThreadId.toLowerCase()));
}

function absolutePath(value: unknown): string | undefined {
  return typeof value === "string" && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value)
    ? path.resolve(value) : undefined;
}
