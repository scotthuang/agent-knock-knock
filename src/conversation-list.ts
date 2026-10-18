import { associateClaudeConversationRoutes } from "./claude-conversation-routing-identity.js";
import { associateConversationRoutes, type ConversationRoutingIdentityOptions } from "./conversation-routing-identity.js";
import { presentConversationList, type ConversationListPresentationOptions } from "./conversation-list-presentation.js";
import { recordValue } from "./value-guards.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => recordValue(item)) : [];
const terminalOnlyActions = new Set(["native_inspect", "model_options", "set_model", "cancel", "new_thread", "clear_thread",
  "resume_thread", "list_resumable_threads", "identify_foreground", "repair_model_control", "reconcile_binding", "close"]);
const claudeSpecialActions = new Set(["approve", "respond", "respond_interaction", "permission_options", "set_permissions"]);

export function isTerminalSpecificConversationAction(agent: unknown, name: string): boolean {
  return terminalOnlyActions.has(name) || agent === "claude" && claudeSpecialActions.has(name);
}

/** A single proven terminal may offer its own special controls; its exact action targets stay unchanged. */
function withExactTerminalActions(native: Row): Row {
  if (!["codex_cli", "claude_cli"].includes(String(native.source))) return native;
  const controls = rows(native.terminal_controls);
  if (controls.length !== 1) return native;
  const actions = { ...recordValue(native.available_actions) };
  const capabilities = { ...recordValue(native.capabilities) };
  for (const [name, action] of Object.entries(recordValue(controls[0].available_actions) ?? {})) {
    const special = isTerminalSpecificConversationAction(native.agent, name);
    if (special && !Object.hasOwn(actions, name) && recordValue(action)) {
      actions[name] = action;
      capabilities[name === "respond_interaction" ? "interaction_respond" : name] = true;
    }
  }
  return { ...native, available_actions: actions, capabilities };
}

/** Send/Watch on a proven alias select this backend; an old physical offer cannot bypass it. */
function routedTerminalControls(terminal: Row, native: Row): Row {
  if (native.connection_state !== "loaded_backend_verified") return terminal;
  const actions = { ...recordValue(terminal.available_actions) };
  const nativeActions = recordValue(native.available_actions);
  const nativeCapabilities = recordValue(native.capabilities);
  const terminalCapabilities = recordValue(terminal.capabilities);
  const capabilities = terminalCapabilities ? { ...terminalCapabilities } : undefined;
  for (const name of ["send", "watch"]) {
    const available = nativeCapabilities?.[name] === true && recordValue(nativeActions?.[name]);
    if (available) actions[name] = nativeActions![name];
    else delete actions[name];
    if (capabilities) capabilities[name] = Boolean(available);
  }
  return { ...terminal, available_actions: actions, ...(capabilities ? { capabilities } : {}) };
}

/** Public conversation inventory; legacy endpoint arrays remain private-action/diagnostic inputs. */
export function unifiedConversationList(result: Row, terminals: readonly Row[], identityOptions: ConversationRoutingIdentityOptions = {},
  presentationOptions: ConversationListPresentationOptions = {}) {
  const native = rows(result.codex_cli_sessions);
  const association = associateConversationRoutes(terminals, native, identityOptions);
  const claude = rows(result.claude_cli_sessions);
  const claudeAssociations = associateClaudeConversationRoutes(terminals, claude);
  const linked = new Set([...association.associations, ...claudeAssociations].map(item => item.terminalId));
  const conversations: Row[] = native.map(row => ({ ...row, route_preference: "codex_backend",
    route_status: row.connection_state === "loaded_backend_verified" ? "backend_available" : "backend_unavailable",
    terminal_aliases: association.associations.filter(item => item.nativeId === row.conversation_id).map(item => item.terminalId),
    terminal_controls: rows(result.terminals).filter(terminal => association.associations.some(item => item.nativeId === row.conversation_id && item.terminalId === terminal.id))
      .map(terminal => routedTerminalControls(terminal, row)) }));
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
  return { ...result, ...presentConversationList(conversations.map(withExactTerminalActions), terminals, presentationOptions),
    conversation_routing: { policy: "backend_first", exact_associations: association.associations.length + claudeAssociations.length,
    unresolved_terminals: association.unassociated.filter(item => terminals.some(t => t.id === item.terminalId && t.agent === "codex")).length } };
}

/** Remove historical output only after exact association and blocking checks have run. */
export function withoutListHistory(value: Row, keepManagedCounts = false): Row {
  const result = { ...value };
  for (const key of ["terminal_watches", "codex_cli_watches", "claude_cli_watches", "desktop_watches", "unavailable_managed_turns", "managed_turns", "watch_summary"]) delete result[key];
  for (const field of ["conversations", "terminals", "codex_cli_sessions", "claude_cli_sessions", "terminal_controls", "control_records"]) {
    if (Array.isArray(result[field])) result[field] = (result[field] as Row[]).map(row => withoutListHistory(row, keepManagedCounts));
  }
  if (result.managed && typeof result.managed === "object" && !Array.isArray(result.managed)) {
    const managed = { ...result.managed as Row };
    for (const key of ["recent_turn", "history", "hidden_turn_count"]) delete managed[key];
    if (!keepManagedCounts) delete managed.turn_count;
    result.managed = managed;
  }
  return result;
}
