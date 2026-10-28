import { associateClaudeConversationRoutes } from "./claude-conversation-routing-identity.js";
import { claudeNativeControlCapabilities } from "./claude-native-public-projection.js";
import { claudeManagedSendRoute, claudeManagedTerminalSendBlockReason, claudeUserExplicitTerminalSendOffer, withClaudeManagedSendAuthority } from "./claude-managed-send-route.js";
import { associateConversationRoutes, type ConversationRoutingIdentityOptions } from "./conversation-routing-identity.js";
import { presentConversationList, type ConversationListPresentationOptions } from "./conversation-list-presentation.js";
import { withConversationUsage } from "./conversation-usage-guidance.js";
import { recordValue } from "./value-guards.js";
import { withNativeStoreAuthorityConflict } from "./native-store-authority-projection.js";
import { codexFolderTrustBlocked } from "./codex-folder-trust-surface.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => recordValue(item)) : [];
const terminalOnlyActions = new Set(["native_inspect", "model_options", "set_model", "cancel", "new_thread", "clear_thread",
  "resume_thread", "list_resumable_threads", "identify_foreground", "repair_model_control", "reconcile_binding", "transfer_store_authority", "close"]);
const claudeSpecialActions = new Set(["approve", "respond", "respond_interaction", "permission_options", "set_permissions"]);
const folderTrustInputActions = new Set(["send", "approve", "respond", "respond_interaction", "interaction_respond",
  "set_permissions", "model_options", "set_model", "cancel", "new_thread", "clear_thread", "resume_thread",
  "list_resumable_threads", "identify_foreground", "repair_model_control", "retry_submission"]);

export function isTerminalSpecificConversationAction(agent: unknown, name: string): boolean {
  return terminalOnlyActions.has(name) || agent === "claude" && claudeSpecialActions.has(name);
}

/** Ordinary Claude Send keeps its canonical selector while choosing a managed terminal first. */
export function withClaudeSendRouteProjection(native: Row, terminals: readonly Row[]): Row {
  if (native.source !== "claude_cli") return native;
  const id = String(native.conversation_id ?? native.id ?? "");
  const route = claudeManagedSendRoute(id, terminals);
  if (route.kind === "native") return { ...native, route_preference: "claude_native", route_status: "backend_available" };
  const actions = { ...recordValue(native.available_actions) };
  const send = route.kind === "managed";
  if (send) actions.send = { tool: "agent_knock_knock_send", input: { conversation_id: id } };
  else delete actions.send;
  return { ...native, route_preference: "managed_terminal", route_status: send ? "terminal_available" : "terminal_blocked",
    capabilities: { ...recordValue(native.capabilities), send }, available_actions: actions,
    ...(route.kind === "blocked" ? { send_blocked_reason: route.reason } : {}) };
}

/** Use the physical incarnation with the Store-filtered action offers from the same scan. */
function claudeSendTerminals(physical: readonly Row[], projected: readonly Row[], writable: boolean): Row[] {
  return physical.map(terminal => {
    const matches = projected.filter(row => row.id === terminal.id);
    return withClaudeManagedSendAuthority(terminal, matches.length === 1 ? matches[0] : undefined, writable);
  });
}

function standaloneActions(terminal: Row, physicalSend: Row | undefined, blocked: string | undefined): Row {
  const actions = { ...recordValue(terminal.available_actions) };
  if (blocked) delete actions.send;
  for (const name of ["send", "status", "watch", "native_inspect", "permission_options", "model_options"]) {
    const action = recordValue(actions[name]);
    if (action) actions[name] = { tool: action.tool, input: { conversation_id: terminal.id,
      ...(name === "native_inspect" ? { inspection: "status" } : {}) } };
  }
  if (physicalSend) actions.send = { tool: physicalSend.tool, arguments: { terminal_id: terminal.id },
    missing_required: ["request"], scope: "terminal_user_explicit", requires_user_intent: true,
    ...(physicalSend.composer_policy ? { composer_policy: physicalSend.composer_policy } : {}) };
  return actions;
}

function standaloneConversation(terminal: Row, physical?: Row): Row {
  const claude = terminal.agent === "claude", codex = terminal.agent === "codex";
  const sendFacts = { ...(physical ?? terminal), available_actions: terminal.available_actions };
  const physicalSend = claude ? claudeUserExplicitTerminalSendOffer(sendFacts) : undefined;
  const readiness = recordValue(terminal.physical_send_readiness);
  const blocked = claude && !physicalSend ? readiness?.ready === false && typeof readiness.reason === "string"
    ? `terminal_${readiness.reason}` : claudeManagedTerminalSendBlockReason(sendFacts) : undefined;
  const { send_blocked_reason: _terminalBlocked, ...unblockedTerminal } = terminal;
  const conversation = { ...(physicalSend ? unblockedTerminal : terminal), conversation_id: terminal.id, title: terminal.workspace ?? terminal.cwd ?? terminal.id,
    route_preference: codex ? "codex_backend" : claude && !physicalSend ? "managed_terminal" : "terminal",
    route_status: codex ? "identity_unresolved" : "terminal_only", available_actions: standaloneActions(terminal, physicalSend, blocked),
    ...(claude ? { capabilities: { ...recordValue(terminal.capabilities), send: !blocked } } : {}),
    ...(blocked ? { send_blocked_reason: blocked } : {}) };
  return folderTrustTerminalControls(conversation);
}

/** A single proven terminal may offer its own special controls; its exact action targets stay unchanged. */
export function withExactTerminalActions(native: Row): Row {
  if (!["codex_cli", "claude_cli"].includes(String(native.source))) return native;
  const controls = rows(native.terminal_controls).map(folderTrustTerminalControls);
  native = { ...native, terminal_controls: controls };
  if (native.source === "codex_cli") {
    // A backend's own version and a saved thread's cliVersion are not the
    // currently attached frontend executable version.
    if (controls.length === 1 && typeof controls[0].agent_version === "string") {
      native = { ...native, agent_version: controls[0].agent_version };
    }
  }
  if (controls.length !== 1) return withExactControlRestrictions(native, controls);
  const actions = { ...recordValue(native.available_actions) };
  const capabilities = { ...recordValue(native.capabilities) };
  for (const [name, action] of Object.entries(recordValue(controls[0].available_actions) ?? {})) {
    const special = isTerminalSpecificConversationAction(native.agent, name);
    if (special && !Object.hasOwn(actions, name) && recordValue(action)) {
      actions[name] = action;
      capabilities[name === "respond_interaction" ? "interaction_respond" : name] = true;
    }
  }
  if (native.source === "claude_cli") Object.assign(capabilities, claudeNativeControlCapabilities(actions, controls[0]));
  const actionable = capabilities.interaction_respond === true || capabilities.approve === true;
  return withExactControlRestrictions({ ...native, available_actions: actions, capabilities,
    ...(native.source === "claude_cli" && native.attention_required === true && actionable ? {
      manual_required: false, next_action: "respond_to_interaction",
      interaction_hint: { ...recordValue(native.interaction_hint), actionable: true, source: "verified_terminal" }
    } : {}) }, controls);
}

function withFolderTrustBlock(native: Row, terminal: Row): Row {
  const backendId = native.source === "codex_cli" ? String(native.conversation_id ?? native.id) : undefined;
  const controls = folderTrustActionProjection(native, backendId);
  return { ...native, ...controls,
    ...(backendId ? { backend_activity_state: native.backend_activity_state ?? native.activity_state } : {}), activity_state: "blocked",
    approval_state: terminal.approval_state, manual_required: true, attention_required: true,
    waiting_for: "folder access decision", send_blocked_reason: "codex_folder_trust_required",
    ...(Array.isArray(native.interaction_state) ? { interaction_state: native.interaction_state.map(value => {
      const interaction = recordValue(value);
      return interaction ? { ...interaction, ...folderTrustActionProjection(interaction, backendId) } : value;
    }) } : {}) };
}

function folderTrustActionProjection(row: Row, backendId?: string): Row {
  const original = recordValue(row.available_actions) ?? {};
  const actions = Object.fromEntries(Object.entries(original).filter(([name, action]) =>
    folderTrustActionAllowed(name, action, backendId)));
  const capabilities = { ...recordValue(row.capabilities) };
  for (const name of new Set([...Object.keys(capabilities), ...Object.keys(original), "send", "approve", "interaction_respond", "set_permissions"])) {
    if (!folderTrustActionAllowed(name, original[name], backendId)) capabilities[name] = false;
  }
  return { available_actions: actions, capabilities };
}

function folderTrustActionAllowed(name: string, action: unknown, backendId?: string): boolean {
  if (folderTrustInputActions.has(name)) return false;
  const offer = recordValue(action), input = recordValue(offer?.input ?? offer?.arguments);
  if (name === "close" && input?.expected_transition_id) return false;
  if (!["native_inspect", "permission_options"].includes(name)) return true;
  if (!backendId || input?.conversation_id !== backendId || input?.terminal_id) return false;
  return name !== "native_inspect" || ["status", "permissions"].includes(String(input.inspection ?? input.action ?? "status"));
}

function folderTrustTerminalControls(terminal: Row): Row {
  return terminal.agent === "codex" && codexFolderTrustBlocked(terminal.approval_state)
    ? withFolderTrustBlock(terminal, terminal) : terminal;
}

/** Apply restrictions after action promotion so terminal offers cannot revive input. */
function withExactControlRestrictions(native: Row, controls: readonly Row[]): Row {
  const projected = withExactStoreAuthority(native, controls);
  const blocked = native.source === "codex_cli" && controls.find(control => codexFolderTrustBlocked(control.approval_state));
  return blocked ? withFolderTrustBlock(projected, blocked) : projected;
}

function withExactStoreAuthority(native: Row, controls: readonly Row[]): Row {
  const conflicted = controls.find(control => ["conflict", "transferring"].includes(
    String(recordValue(control.native_store_authority)?.state)));
  if (!conflicted) return native;
  const transfer = recordValue(recordValue(conflicted.available_actions)?.transfer_store_authority);
  const authority = native.source === "codex_cli"
    ? { ...recordValue(conflicted.native_store_authority), send_after_transfer: false } : conflicted.native_store_authority;
  return withNativeStoreAuthorityConflict(native, authority,
    controls.length === 1 && transfer ? { transfer_store_authority: transfer } : {});
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
  const transfer = recordValue(recordValue(terminal.available_actions)?.transfer_store_authority);
  return folderTrustTerminalControls(withNativeStoreAuthorityConflict({ ...terminal, available_actions: actions, ...(capabilities ? { capabilities } : {}) },
    recordValue(terminal.native_store_authority) ? { ...recordValue(terminal.native_store_authority), send_after_transfer: false } : undefined,
    transfer ? { transfer_store_authority: transfer } : {}));
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
  const claudeSendTargets = claudeSendTerminals(terminals, rows(result.terminals), recordValue(result.store)?.writable !== false);
  conversations.push(...claude.map(row => withClaudeSendRouteProjection({ ...row,
    terminal_aliases: claudeAssociations.filter(item => item.nativeId === row.conversation_id).map(item => item.terminalId),
    terminal_controls: rows(result.terminals).filter(terminal => claudeAssociations.some(item => item.nativeId === row.conversation_id && item.terminalId === terminal.id)) }, claudeSendTargets)));
  for (const terminal of rows(result.terminals)) {
    if (linked.has(String(terminal.id))) continue;
    conversations.push(standaloneConversation(terminal, claudeSendTargets.find(row => row.id === terminal.id)));
  }
  conversations.push(...rows(result.desktop_sessions).map(row => ({ ...row, route_preference: "desktop_ipc" })));
  const presentation = presentConversationList(conversations.map(withExactTerminalActions), terminals, presentationOptions);
  return { ...result, ...presentation, conversations: presentation.conversations.map(row => withConversationUsage(row)),
    conversation_routing: { policy: "agent_specific", codex: "backend_first", claude: "managed_terminal_first",
    exact_associations: association.associations.length + claudeAssociations.length,
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
