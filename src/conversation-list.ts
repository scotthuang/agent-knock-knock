import { associateClaudeConversationRoutes } from "./claude-conversation-routing-identity.js";
import { associateConversationRoutes, type ConversationRoutingIdentityOptions } from "./conversation-routing-identity.js";
import { recordValue } from "./value-guards.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => recordValue(item)) : [];

/** Public conversation inventory; legacy endpoint arrays remain private-action/diagnostic inputs. */
export function unifiedConversationList(result: Row, terminals: readonly Row[], identityOptions: ConversationRoutingIdentityOptions = {}) {
  const native = rows(result.codex_cli_sessions);
  const association = associateConversationRoutes(terminals, native, identityOptions);
  const claude = rows(result.claude_cli_sessions);
  const claudeAssociations = associateClaudeConversationRoutes(terminals, claude);
  const linked = new Set([...association.associations, ...claudeAssociations].map(item => item.terminalId));
  const conversations: Row[] = native.map(row => ({ ...row, route_preference: "codex_backend",
    route_status: row.connection_state === "loaded_backend_verified" ? "backend_available" : "backend_unavailable",
    terminal_aliases: association.associations.filter(item => item.nativeId === row.conversation_id).map(item => item.terminalId),
    terminal_controls: rows(result.terminals).filter(terminal => association.associations.some(item => item.nativeId === row.conversation_id && item.terminalId === terminal.id)) }));
  conversations.push(...claude.map(row => ({ ...row, route_preference: "claude_native", route_status: "backend_available",
    terminal_aliases: claudeAssociations.filter(item => item.nativeId === row.conversation_id).map(item => item.terminalId),
    terminal_controls: rows(result.terminals).filter(terminal => claudeAssociations.some(item => item.nativeId === row.conversation_id && item.terminalId === terminal.id)) })));
  for (const terminal of rows(result.terminals)) {
    if (linked.has(String(terminal.id))) continue;
    const actions = { ...recordValue(terminal.available_actions) };
    for (const name of ["send", "status", "watch", "native_inspect", "permission_options", "model_options"]) {
      const action = recordValue(actions[name]);
      if (action) actions[name] = { tool: action.tool, input: { conversation_id: terminal.id,
        ...(name === "native_inspect" ? { inspection: "status" } : {}) } };
    }
    conversations.push({ ...terminal, conversation_id: terminal.id, title: terminal.workspace ?? terminal.cwd ?? terminal.id,
      route_preference: terminal.agent === "codex" ? "codex_backend" : "terminal", route_status: terminal.agent === "codex" ? "identity_unresolved" : "terminal_only", available_actions: actions });
  }
  conversations.push(...rows(result.desktop_sessions).map(row => ({ ...row, route_preference: "desktop_ipc" })));
  return { ...result, conversations, conversation_routing: { policy: "backend_first", exact_associations: association.associations.length + claudeAssociations.length,
    unresolved_terminals: association.unassociated.filter(item => terminals.some(t => t.id === item.terminalId && t.agent === "codex")).length } };
}
