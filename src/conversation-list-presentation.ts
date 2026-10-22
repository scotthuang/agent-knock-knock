import path from "node:path";
import { claudeProcessBirthMatches } from "./claude-conversation-routing-identity.js";
import { parseClaudeNativeConversationId } from "./claude-native-identity.js";
import { parseCodexNativeConversationId } from "./codex-native-identity.js";
import { hostListWatchNeedsAttention } from "./semantic-tool-list-budget.js";
import { recordValue } from "./value-guards.js";

type Row = Record<string, unknown>;
export interface ConversationListPresentationOptions { diagnostics?: boolean }
type WorkspaceGroup = { terminal_conversation_id: string; native_conversation_id: string };

/** Prefer a verified backend for an unambiguous project display, without creating a routing alias. */
export function presentConversationList(conversations: readonly Row[], physicalTerminals: readonly Row[],
  options: ConversationListPresentationOptions = {}) {
  const unstarted = unstartedDisplayCandidates(conversations, physicalTerminals);
  const candidates = new Set(unstarted.map(row => String(row.conversation_id)));
  const preferred = conversations.filter(row => !candidates.has(String(row.conversation_id)));
  const groups = workspaceGroups(preferred, physicalTerminals);
  const hidden = new Set(options.diagnostics ? [] : [...candidates, ...groups.map(group => group.terminal_conversation_id)]);
  return {
    conversations: conversations.filter(row => !hidden.has(String(row.conversation_id)))
      .map((row): Row => ({ ...row, surface: row.source === "codex_desktop" ? "desktop" : "cli",
        ...(options.diagnostics && candidates.has(String(row.conversation_id))
          ? { classification: "unstarted_candidate", frontend_presence: "unverified" } : {}) })),
    conversation_presentation: {
      mode: options.diagnostics ? "diagnostics" : "default",
      workspace_grouped_connections: options.diagnostics ? 0 : groups.length,
      ...(unstarted.length ? { unstarted_candidates_count: unstarted.length,
        unstarted_candidates_omitted: options.diagnostics ? 0 : unstarted.length,
        ...(!options.diagnostics ? { diagnostic_query: { tool: "agent_knock_knock_list", arguments: { terminalDebug: true } } } : {}) } : {}),
      ...(options.diagnostics ? { workspace_groups: groups } : {})
    }
  };
}

/** A display preference, never proof that an unstarted thread is orphaned or a routing alias. */
function unstartedDisplayCandidates(conversations: readonly Row[], terminals: readonly Row[]): Row[] {
  const native = conversations.filter(row => row.source === "codex_cli" && row.agent === "codex");
  return native.filter(candidate => {
    if (!unstartedCandidate(candidate)) return false;
    const identity = codexDisplayIdentity(candidate), key = workspaceKey(candidate);
    if (!identity || !key) return false;
    const peers = native.filter(row => workspaceKey(row) === key);
    if (peers.some(row => codexDisplayIdentity(row)?.codexHome !== identity.codexHome)
      || peers.filter(row => row.conversation_id === candidate.conversation_id).length !== 1) return false;
    const established = peers.filter(hasEstablishedTask);
    if (established.length !== 1) return false;
    const physical = terminals.filter(row => workspaceKey(row) === key);
    if (physical.length > 1 || physical.some(row => row.process_state !== "active")) return false;
    const projected = conversations.filter(row => String(row.conversation_id).startsWith("terminal:") && workspaceKey(row) === key);
    if ([...physical, ...projected].some(row => !canGroup(row, established[0]) || needsOwnTerminalEntry(row))) return false;
    return ![...terminals, ...projected].some(row => terminalNamesThread(row, identity.threadId));
  });
}

function unstartedCandidate(row: Row): boolean {
  return row.unstarted_thread === true && row.history_state === "unmaterialized"
    && row.native_turn_id === null && row.latest_turn === null && row.activity_state === "idle"
    && row.observation_error === undefined && !needsOwnTerminalEntry(row)
    && emptyArray(row.terminal_aliases) && emptyArray(row.terminal_controls)
    && emptyArray(row.active_flags) && emptyArray(row.interaction_state);
}

function emptyArray(value: unknown): boolean { return value === undefined || Array.isArray(value) && value.length === 0; }

function hasEstablishedTask(row: Row): boolean {
  const turn = recordValue(row.latest_turn);
  return row.history_state !== "unmaterialized" && row.observation_error === undefined
    && typeof row.native_turn_id === "string" && row.native_turn_id.length > 0 && turn?.id === row.native_turn_id;
}

function codexDisplayIdentity(row: Row): ReturnType<typeof parseCodexNativeConversationId> | undefined {
  if (row.connection_state !== "loaded_backend_verified") return undefined;
  try {
    const identity = parseCodexNativeConversationId(String(row.conversation_id ?? ""));
    return row.native_thread_id === identity.threadId ? identity : undefined;
  } catch { return undefined; }
}

function terminalNamesThread(row: Row, threadId: string): boolean {
  return [row.native_agent_session_id, row.native_agent_status_card_session_id, row._routing_inspection_thread_id]
    .some(value => typeof value === "string" && value.toLowerCase() === threadId.toLowerCase());
}

function workspaceGroups(conversations: readonly Row[], physicalTerminals: readonly Row[]): WorkspaceGroup[] {
  const nativeRows = conversations.filter(row => ["codex_cli", "claude_cli"].includes(String(row.source)));
  const groups: WorkspaceGroup[] = [];
  for (const terminal of physicalTerminals) {
    const key = workspaceKey(terminal);
    if (!key || terminal.process_state !== "active") continue;
    const terminalId = String(terminal.id ?? "");
    const visible = conversations.find(row => row.conversation_id === terminalId);
    if (!visible || !terminalId.startsWith("terminal:") || workspaceKey(visible) !== key ||
      needsOwnTerminalEntry(terminal) || needsOwnTerminalEntry(visible)) continue;
    // Count all observed connections, including already-associated ones, rather than arbitrarily pairing a subset.
    if (physicalTerminals.filter(row => workspaceKey(row) === key).length !== 1) continue;
    const candidates = nativeRows.filter(row => workspaceKey(row) === key);
    if (candidates.length !== 1) continue;
    const native = candidates[0];
    if ((Array.isArray(native.terminal_aliases) && native.terminal_aliases.length > 0) ||
      !canGroup(terminal, native) || !canGroup(visible, native)) continue;
    groups.push({ terminal_conversation_id: terminalId, native_conversation_id: String(native.conversation_id) });
  }
  return groups;
}

/** Workspace preference cannot hide an independently owned turn or a terminal-only decision. */
function needsOwnTerminalEntry(row: Row): boolean {
  const managed = recordValue(row.managed);
  const approval = recordValue(row.approval_state);
  const interaction = recordValue(row.interaction_state);
  const managedHistory = [managed?.recent_turn, ...(Array.isArray(managed?.history) ? managed.history : [])]
    .map(recordValue).filter((turn): turn is Row => Boolean(turn));
  return row.management_state === "conflict" || row.management_state === "unavailable" ||
    Boolean(managed?.current_turn || row.management_conflict || row.management_unavailable || row.handoff_state || row.handoff_decision) ||
    managedHistory.some(hostListWatchNeedsAttention) ||
    Array.isArray(row.blocking_turns) && row.blocking_turns.length > 0 ||
    approval?.blocked === true || approval?.approvable === true || row.attention_required === true ||
    ["pending_manual_count", "pending_async_count", "pending_interaction_count"].some(key => Number(row[key]) > 0) ||
    Boolean(interaction && !["none", "resolved", "answered", "closed"].includes(String(interaction.state)));
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
