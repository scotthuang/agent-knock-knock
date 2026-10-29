import { paginateHostList } from "./semantic-tool-list-budget.js";
import { isAkkModelFacingPrivateAuthorityField } from
  "./semantic-tool-model-facing-field-policy.js";
import { arrayValue, finiteNumber, nonEmptyString, stringArrayValue,
  truncateText } from "./semantic-tool-value-helpers.js";
import { recordValue } from "./value-guards.js";
import { isTerminalSpecificConversationAction } from "./conversation-list.js";
import { withConversationUsage } from "./conversation-usage-guidance.js";

/**
 * Bound structured controller-Host List output before Host serialization,
 * without weakening the private action-authority path.
 *
 * Watch inventory and retained history use the separate watches command. The controller
 * receives current resource identities and state, action names, and only the
 * dynamic semantic inputs needed to invoke those actions. Current-state usage
 * advice stays with each row; shared instructions live in the bundled skill.
 */
export function compactAkkListModelProjection(
  value: unknown,
  params: Record<string, unknown> = {}
): Record<string, unknown> {
  const result = recordValue(value) ?? {};
  const routingDiagnostics = recordValue(result.conversation_presentation)?.mode === "diagnostics";
  const actionContracts = recordValue(result.action_contracts);
  const diagnostics = compactAkkListDiagnostics(result);
  const recovery = compactAkkListControlState(result.recovery);
  const projected = {
    projection: {
      schema: "agent-knock-knock/host-list-compact",
      version: 4,
      skill: "agent-knock-knock",
      ...(finiteNumber(actionContracts?.version) !== undefined
        ? { action_contract_version: finiteNumber(actionContracts?.version) }
        : {})
    },
    ...(Array.isArray(result.desktop_sessions) || recordValue(result.desktop_scan) ? {
      ...(!Array.isArray(result.conversations) ? { desktop_sessions: arrayValue(result.desktop_sessions).map(compactDesktopConversation) } : {}),
      desktop_scan: { ...compactAkkListScalars(recordValue(result.desktop_scan) ?? {}, [
        "view", "total_candidates", "history_candidates", "returned", "next_cursor", "catalog_complete", "live_count", "application_version", "application_build", "write_contract_verified", "approval_contract_verified", "send_contract_verified", "watch_error", "membership_is_not_live_identity",
        "sidebar_status", "sidebar_mode", "sidebar_selection_scope", "live_probe_scope", "compatibility_policy", "application_identity_verified"]),
        limitations: stringArrayValue(recordValue(result.desktop_scan)?.limitations) }
    } : {}),
    ...(Array.isArray(result.codex_cli_sessions) || recordValue(result.codex_cli_scan) ? {
      ...(!Array.isArray(result.conversations) ? { codex_cli_sessions: arrayValue(result.codex_cli_sessions).map(compactNativeConversation) } : {}),
      codex_cli_scan: compactAkkListScalars(recordValue(result.codex_cli_scan) ?? {}, [
        "status", "returned", "loaded_count", "complete", "error", "watch_error"])
    } : {}),
    ...(Array.isArray(result.claude_cli_sessions) || recordValue(result.claude_cli_scan) ? {
      ...(!Array.isArray(result.conversations) ? { claude_cli_sessions: arrayValue(result.claude_cli_sessions).map(compactNativeConversation) } : {}),
      claude_cli_scan: compactClaudeListScan(recordValue(result.claude_cli_scan) ?? {})
    } : {}),
    ...(Array.isArray(result.conversations)
      ? { conversations: arrayValue(result.conversations).map(row => compactConversation(row, routingDiagnostics)),
          conversation_presentation: compactConversationPresentation(result.conversation_presentation),
          ...(routingDiagnostics ? { conversation_routing: compactAkkListScalars(recordValue(result.conversation_routing) ?? {},
            ["policy", "codex", "claude", "exact_associations", "unresolved_terminals"]) } : {}) }
      : { terminals: arrayValue(result.terminals).map(compactAkkListTerminal) }),
    ...(recovery ? { recovery } : {}),
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {})
  };
  return paginateHostList(projected, params);
}

function compactClaudeListScan(scan: Record<string, unknown>): Record<string, unknown> {
  const output = compactAkkListScalars(scan, ["status", "returned", "loaded_count", "complete", "watch_error", "error_count"]);
  const codes = [...new Set(stringArrayValue(scan.error_codes).filter(code => /^[a-z][a-z0-9_]{0,79}$/u.test(code)))].slice(0, 8);
  if (codes.length) output.error_codes = codes;
  const reader = recordValue(scan.reader);
  if (reader && ["option", "environment", "default"].includes(String(reader.source)) &&
      typeof reader.executable === "string" && !/[\\/\u0000-\u001f\u007f]/u.test(reader.executable)) {
    output.reader = { executable: truncateText(reader.executable, 128), source: reader.source,
      path_omitted: reader.path_omitted === true };
  }
  if (scan.next_action === "check_claude_reader_in_host_environment") output.next_action = scan.next_action;
  return output;
}

function compactConversationPresentation(value: unknown): Record<string, unknown> {
  const row = recordValue(value) ?? { mode: "default" };
  return { ...compactAkkListScalars(row, ["mode", "workspace_grouped_connections",
    "unstarted_candidates_count", "unstarted_candidates_omitted"]),
    ...(Number(row.unstarted_candidates_omitted) > 0 ? {
      diagnostic_query: { tool: "agent_knock_knock_list", arguments: { terminalDebug: true } },
      note: "Unnamed, unstarted candidates are folded for display only; frontend attachment is unverified. Exact IDs remain usable."
    } : {}) };
}

function compactDesktopConversation(row: Record<string, unknown>): Record<string, unknown> {
  return withConversationUsage({
    ...compactAkkListScalars(row, ["id", "conversation_id", "title", "cwd", "source", "agent", "native_thread_id",
      "host_id", "updated_at", "catalog_membership", "creator_originator", "connection_state", "activity_state", "native_turn_id", "pending_manual_count", "pending_async_count", "pending_interaction_count",
      "sidebar_section", "sidebar_project_id", "sidebar_project_name", "observation_error", "can_send_reason", "manual_action", "compatibility_policy", "compatibility_warning", "application_identity_verified"]),
    ...(recordValue(row.capability_verification) ? { capability_verification: compactAkkListScalars(recordValue(row.capability_verification)!,
      ["send", "approvals", "blockingAnswers", "asyncAnswers", "nativeControls"]) } : {}),
    capabilities: compactAkkListScalars(recordValue(row.capabilities) ?? {}, ["send", "watch", "status", "interaction_notify", "interaction_respond", "approve", "set_permissions", "set_model", "cancel"]),
    ...compactAkkListActions(row.available_actions, { conversation_id: row.conversation_id })
  }, row);
}

function compactNativeConversation(row: Record<string, unknown>): Record<string, unknown> {
  return withConversationUsage({
    ...compactAkkListScalars(row, ["id", "conversation_id", "title", "cwd", "source", "agent",
      "native_thread_id", "native_turn_id", "native_input_id", "pid", "agent_version", "waiting_for", "manual_required", "activity_state", "connection_state", "backend_version",
      "pending_interaction_count", "interaction_requests_scanned", "history_state", "unstarted_thread", "classification", "frontend_presence",
      "attention_required", "updated_at", "observation_error", "send_blocked_reason", "backend_activity_state", "detail_scan", "send_preflight_required"]),
    ...(recordValue(row.approval_state) ? { approval_state: compactAkkListScalars(recordValue(row.approval_state)!,
      ["scanned", "blocked", "approvable", "prompt_kind"]) } : {}),
    ...(recordValue(row.native_store_authority)
      ? { native_store_authority: compactNativeStoreAuthority(row.native_store_authority) } : {}),
    ...(Array.isArray(row.active_flags) ? { active_flags: row.active_flags } : {}),
    capabilities: compactAkkListScalars(recordValue(row.capabilities) ?? {}, [
      "status", "send", "watch", "interaction_notify", "interaction_respond", "approve", "set_permissions",
      "permission_options", "model_options", "set_model", "cancel", "new_thread", "clear_thread",
      "resume_thread", "list_resumable_threads", "native_inspect", "transfer_store_authority"]),
    ...(Array.isArray(row.terminal_controls)
      ? { terminal_controls: arrayValue(row.terminal_controls).map(compactAkkListTerminal) } : {}),
    ...compactAkkListActions(row.available_actions, { conversation_id: row.conversation_id })
  }, row);
}

function compactConversation(row: Record<string, unknown>, diagnostics: boolean): Record<string, unknown> {
  const output = row.source === "codex_desktop" ? compactDesktopConversation(row)
    : ["codex_cli", "claude_cli"].includes(String(row.source)) ? compactNativeConversation(row) : compactAkkListTerminal(row);
  output.surface = row.surface ?? (row.source === "codex_desktop" ? "desktop" : "cli");
  if (diagnostics) return { ...output, ...compactAkkListScalars(row, ["conversation_id", "route_preference", "route_status"]),
    ...(Array.isArray(row.terminal_aliases) ? { terminal_aliases: stringArrayValue(row.terminal_aliases) } : {}) };
  const controls = arrayValue(output.terminal_controls);
  const management = controls.map(compactConversationControlRecord).filter(control => Object.keys(control).length > 0);
  if (management.length === 1) Object.assign(output, management[0]);
  else if (management.length > 1) output.control_records = management;
  if (output.surface === "cli") projectCliConnection(output, row);
  for (const field of ["source", "backend_version", "terminal_controls", "terminal_control", "command", "pid",
    "process_state", "screen_state", "durable_activity_state", "native_identity_state"]) delete output[field];
  return withConversationUsage(output, row);
}

function projectCliConnection(output: Record<string, unknown>, row: Record<string, unknown>): void {
  if (row.unstarted_thread === true && stringArrayValue(row.terminal_aliases).length === 0) {
    output.backend_reachable = row.connection_state === "loaded_backend_verified";
    output.frontend_presence = "unverified";
  } else if (["loaded_backend_verified", "native_registry_verified"].includes(String(row.connection_state)) || row.process_state === "active") {
    output.connected = true;
  } else if (row.connection_state === "not_loaded") output.connected = false;
  delete output.connection_state;
  const scoped = compactAkkScopedConversationControls(row);
  if (scoped.length) output.scoped_controls = scoped;
  const actions = recordValue(output.available_actions) ?? {};
  const capabilities = { ...recordValue(output.capabilities) };
  for (const name of ["status", "send", "watch", "approve", "set_permissions", "permission_options", "model_options", "set_model", "cancel",
    "new_thread", "clear_thread", "resume_thread", "list_resumable_threads", "native_inspect"]) {
    if (actions[name] === true) capabilities[name] = true;
  }
  if (actions.respond_interaction === true) capabilities.interaction_respond = true;
  if (Object.keys(capabilities).length) output.capabilities = capabilities;
}

/** Exact connection-scoped controls remain selectable without becoming extra conversations. */
export function compactAkkScopedConversationControls(row: Record<string, unknown>): Record<string, unknown>[] {
  const aliases = new Set(stringArrayValue(row.terminal_aliases));
  const nativeActions = recordValue(row.available_actions) ?? {};
  return arrayValue(row.terminal_controls).flatMap(control => {
    const id = nonEmptyString(control.conversation_id ?? control.id);
    if (!id || !aliases.has(id)) return [];
    const actions: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(recordValue(control.available_actions) ?? {})) {
      const action = recordValue(value);
      if (!action || !isScopedConversationAction(row.agent, name, action)) continue;
      const promoted = recordValue(nativeActions[name]);
      if (promoted && JSON.stringify(compactAkkListActionInput(name, promoted)) === JSON.stringify(compactAkkListActionInput(name, action))) continue;
      actions[name] = action;
    }
    if (Object.keys(actions).length === 0) return [];
    const permission = Object.hasOwn(actions, "permission_options") || Object.hasOwn(actions, "set_permissions")
      ? recordValue(control.permission_control) : undefined;
    return [{ conversation_id: id, ...compactAkkListActions(actions, { conversation_id: id, terminal_id: id }),
      ...(permission ? { permission_control: compactAkkListScalars(permission, ["status", "scope"]) } : {}) }];
  });
}

function isScopedConversationAction(agent: unknown, name: string, action: Record<string, unknown>): boolean {
  if (isTerminalSpecificConversationAction(agent, name)) return true;
  if (agent !== "codex") return false;
  if (name === "permission_options") return true;
  return name === "set_permissions" && recordValue(action.arguments ?? action.input)?.mode === "approve_for_me";
}

/** Keep actionable managed records without presenting another endpoint as a conversation. */
function compactConversationControlRecord(control: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of ["managed", "management_conflict", "management_unavailable", "native_store_authority", "handoff_decision", "blocking_turns",
    "managed_send_readiness", "thread_lifecycle_readiness"]) {
    if (control[field] !== undefined) output[field] = control[field];
  }
  return output;
}

function compactAkkListTerminal(
  terminal: Record<string, unknown>
): Record<string, unknown> {
  const output = compactAkkListScalars(terminal, [
    "id",
    "conversation_id",
    "title",
    "short_ref",
    "source",
    "agent",
    "agent_version",
    "pid",
    "cwd",
    "process_state",
    "screen_state",
    "activity_state",
    "durable_activity_state",
    "native_identity_state",
    "native_agent_session_id",
    "management_state",
    "detail_scan",
    "send_blocked_reason",
    "handoff_state",
    "confidence"
  ]);
  const workspace = nonEmptyString(terminal.workspace);
  if (workspace && workspace !== nonEmptyString(terminal.cwd)) {
    output.workspace = workspace;
  }
  const command = nonEmptyString(terminal.command);
  if (command) output.command = truncateText(command, 160);

  compactAkkListNested(output, "physical_send_readiness", terminal.physical_send_readiness,
    ["ready", "reason", "message"]);
  for (const name of ["managed_send_readiness", "thread_lifecycle_readiness"]) {
    compactAkkListNested(output, name, terminal[name], ["ready", "reason", "message"]);
  }
  compactAkkListNested(output, "terminal_control", terminal.terminal_control,
    ["kind", "target"]);
  compactAkkListNested(output, "approval_state", terminal.approval_state, [
    "scanned", "blocked", "approvable", "state", "kind", "decision_mode", "prompt_kind"
  ]);
  const features = compactAkkListFeatures(terminal);
  if (Object.keys(features).length > 0) output.features = features;

  const managed = compactAkkListManaged(terminal.managed);
  if (managed) output.managed = managed;
  const managementConflict = compactAkkListControlState(
    terminal.management_conflict
  );
  if (managementConflict) output.management_conflict = managementConflict;
  if (recordValue(terminal.native_store_authority)) {
    output.native_store_authority = compactNativeStoreAuthority(terminal.native_store_authority);
  }
  const managementUnavailable = recordValue(terminal.management_unavailable);
  if (managementUnavailable) output.management_unavailable = true;
  const handoffDecision = compactAkkListHandoffDecision(
    terminal.handoff_decision
  );
  if (handoffDecision) output.handoff_decision = handoffDecision;
  const blockingTurns = arrayValue(terminal.blocking_turns)
    .map(compactAkkListBlockingTurn);
  if (blockingTurns.length > 0) output.blocking_turns = blockingTurns;

  const managedRecord = recordValue(terminal.managed);
  const currentTurn = recordValue(managedRecord?.current_turn);
  Object.assign(output, compactAkkListActions(terminal.available_actions, {
    terminal_id: terminal.id,
    conversation_id: terminal.id,
    session_id: managedRecord?.session_id,
    turn_id: currentTurn?.turn_id ?? currentTurn?.conversation_id ??
      currentTurn?.id
  }));
  addAkkListWarningFlags(output, terminal);
  return withConversationUsage(output, terminal);
}

function compactAkkListFeatures(
  terminal: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const lifecycle = recordValue(terminal.native_thread_lifecycle);
  const inspection = recordValue(terminal.native_inspection);
  const modelControl = recordValue(terminal.model_control);
  const permissionControl = recordValue(terminal.permission_control);
  if (typeof lifecycle?.status === "string") {
    output.native_threads = lifecycle.status;
  }
  if (typeof inspection?.status === "string") {
    output.native_inspection = inspection.status;
  }
  if (typeof modelControl?.status === "string") {
    const model = compactAkkListScalars(modelControl, ["status", "scope"]);
    output.model_control = Object.keys(model).length === 1
      ? model.status
      : model;
  }
  if (typeof permissionControl?.status === "string") {
    output.permission_control = compactAkkListScalars(permissionControl, ["status", "scope"]);
  }
  return output;
}

function compactAkkListManaged(
  value: unknown
): Record<string, unknown> | undefined {
  const managed = recordValue(value);
  if (!managed) return undefined;
  const output = compactAkkListScalars(managed, [
    "session_id",
    "session_short_ref",
    "native_thread_id",
    "binding_status",
    "session_count"
  ]);
  const currentTurn = recordValue(managed.current_turn);
  output.current_turn = currentTurn ? compactAkkListTurn(currentTurn) : null;
  return output;
}

function compactAkkListTurn(
  turn: Record<string, unknown>,
  standalone = false
): Record<string, unknown> {
  const output = compactAkkListScalars(turn, [
    "short_ref",
    "status",
    "lifecycle_state",
    "session_id",
    "turn_id",
    "updated_at",
    "response_rounds_used"
  ]);
  compactAkkListNested(output, "callback_delivery", turn.callback_delivery,
    ["status", "attempts", "attempt_state", "next_attempt_at"]);
  const turnId = nonEmptyString(
    turn.turn_id ?? turn.conversation_id ?? turn.id
  );
  if (turnId) output.turn_id = turnId;
  if (standalone) {
    Object.assign(output, compactAkkListScalars(turn, [
      "source", "agent", "workspace", "created_at"
    ]));
  }
  compactAkkListNested(output, "approval_state", turn.approval_state, [
    "scanned", "blocked", "approvable", "state", "kind", "decision_mode"
  ]);
  const interaction = compactAkkListInteraction(turn.interaction_state);
  if (interaction) output.interaction_state = interaction;
  const terminalAvailability = compactAkkListControlState(
    turn.terminal_availability
  );
  if (terminalAvailability) {
    output.terminal_availability = terminalAvailability;
  } else if (
    typeof turn.terminal_availability === "string" ||
    typeof turn.terminal_availability === "boolean"
  ) {
    output.terminal_availability = turn.terminal_availability;
  }
  Object.assign(output, compactAkkListActions(turn.available_actions, {
    session_id: turn.session_id,
    turn_id: turnId,
    conversation_id: turnId
  }));
  addAkkListWarningFlags(output, turn);
  return output;
}

function compactAkkListInteraction(
  value: unknown
): Record<string, unknown> | undefined {
  const interaction = recordValue(value);
  if (!interaction) return undefined;
  const output = compactAkkListScalars(interaction, [
    "state", "response_kind", "current_step", "total_steps",
    "response_authority"
  ]);
  compactAkkListNested(output, "capabilities", interaction.capabilities, [
    "respond", "single_select", "multi_select", "free_text", "confirm"
  ]);
  return Object.keys(output).length > 0 ? output : undefined;
}

function compactAkkListActions(
  value: unknown,
  parentIds: Record<string, unknown> = {}
): Record<string, unknown> {
  const actions = recordValue(value);
  if (!actions) return {};
  const availableActions: Record<string, true> = {};
  const actionInputs: Record<string, unknown> = {};
  for (const [name, actionValue] of Object.entries(actions)) {
    const action = recordValue(actionValue);
    if (!action) continue;
    availableActions[name] = true;
    const input = compactAkkListActionInput(name, action, parentIds);
    if (Object.keys(input).length > 0) actionInputs[name] = input;
  }
  return {
    ...(Object.keys(availableActions).length > 0
      ? { available_actions: availableActions }
      : {}),
    ...(Object.keys(actionInputs).length > 0
      ? { action_inputs: actionInputs }
      : {})
  };
}

function compactAkkListActionInput(
  name: string,
  action: Record<string, unknown>,
  parentIds: Record<string, unknown> = {}
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const tool = nonEmptyString(action.tool);
  const expectedTool = name === "retry_submission"
    ? "agent_knock_knock_send"
    : `agent_knock_knock_${name}`;
  if (tool && tool !== expectedTool) output.tool = tool;
  const args = compactAkkListActionArguments(action.arguments ?? action.input, name, parentIds);
  if (Object.keys(args).length > 0) output.arguments = args;
  const missingRequired = stringArrayValue(action.missing_required)
    .filter((field) => !isAkkModelFacingPrivateAuthorityField(field));
  if (missingRequired.length > 0) {
    output.missing_required = missingRequired;
  }
  for (const key of ["scope", "decision_mode", "requires_user_intent"] as const) {
    const item = action[key];
    if (
      typeof item === "string" ||
      typeof item === "boolean" ||
      typeof item === "number"
    ) output[key] = item;
  }
  for (const key of ["decisions", "choices"] as const) {
    const values = stringArrayValue(action[key]);
    if (values.length > 0) output[key] = values;
  }
  return output;
}

function compactAkkListActionArguments(
  value: unknown,
  actionName: string,
  parentIds: Record<string, unknown>
): Record<string, unknown> {
  const args = recordValue(value);
  if (!args) return {};
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(args)) {
    if (
      isAkkModelFacingPrivateAuthorityField(key) ||
      ["request", "text", "body", "description", "instruction", "use"]
        .includes(key)
    ) continue;
    const compact = compactAkkListSemanticValue(item, 0);
    if (compact !== undefined) output[key] = compact;
  }
  const selector = nonEmptyString(output.selector);
  if (
    actionName === "send" &&
    selector &&
    /^terminal:v[0-9]+:\S+$/u.test(selector)
  ) {
    delete output.selector;
    output.terminal_id = selector;
  }
  const conversationId = nonEmptyString(output.conversation_id);
  if (
    actionName === "approve" &&
    conversationId &&
    /^terminal:v[0-9]+:\S+$/u.test(conversationId)
  ) {
    delete output.conversation_id;
    output.terminal_id = conversationId;
  }
  for (const key of [
    "terminal_id", "session_id", "turn_id", "conversation_id", "watch_id"
  ]) {
    if (output[key] !== undefined && output[key] === parentIds[key]) {
      delete output[key];
    }
  }
  return output;
}

function compactAkkListSemanticValue(value: unknown, depth: number): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 32).flatMap((item) => {
      const compact = compactAkkListSemanticValue(item, depth + 1);
      return compact === undefined ? [] : [compact];
    });
  }
  const record = recordValue(value);
  if (!record) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (isAkkModelFacingPrivateAuthorityField(key)) continue;
    const compact = compactAkkListSemanticValue(item, depth + 1);
    if (compact !== undefined) output[key] = compact;
  }
  return output;
}

function compactAkkListHandoffDecision(
  value: unknown
): Record<string, unknown> | undefined {
  const decision = recordValue(value);
  if (!decision) return undefined;
  const output = compactAkkListScalars(decision, [
    "kind", "source_session_id", "source_turn_id"
  ]);
  const choices = recordValue(decision.choices);
  if (choices) {
    const compactChoices: Record<string, unknown> = {};
    for (const [name, choiceValue] of Object.entries(choices)) {
      const choice = recordValue(choiceValue);
      if (!choice) continue;
      const action = compactAkkListNamedAction(choice.action);
      compactChoices[name] = action ? { action } : true;
    }
    if (Object.keys(compactChoices).length > 0) output.choices = compactChoices;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function compactAkkListBlockingTurn(
  value: Record<string, unknown>
): Record<string, unknown> {
  const output = compactAkkListScalars(value, [
    "session_id", "turn_id", "status"
  ]);
  const recoveryAction = compactAkkListNamedAction(value.recovery_action);
  if (recoveryAction) output.recovery_action = recoveryAction;
  return output;
}

function compactAkkListNamedAction(
  value: unknown
): Record<string, unknown> | undefined {
  const action = recordValue(value);
  if (!action) return undefined;
  const tool = nonEmptyString(action.tool);
  const name = tool?.replace(/^agent_knock_knock_/u, "") ?? "action";
  const input = compactAkkListActionInput(name, action);
  return {
    name,
    ...(Object.keys(input).length > 0 ? input : {})
  };
}

function compactNativeStoreAuthority(value: unknown): Record<string, unknown> {
  return compactAkkListScalars(recordValue(value) ?? {}, [
    "state", "reason", "session_id", "owner_status", "transfer_eligible", "automatic_eligible", "send_after_transfer"
  ]);
}

function compactAkkListControlState(
  value: unknown
): Record<string, unknown> | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      isAkkModelFacingPrivateAuthorityField(key) ||
      /(?:reason|recovery|instruction|description|evidence|path)$/iu.test(key)
    ) continue;
    const keep = /(?:^|_)(?:id|state|status|kind|mode|scope|code|count|owner)$/u
      .test(key) || typeof item === "boolean" || typeof item === "number";
    if (!keep) continue;
    const compact = compactAkkListSemanticValue(item, 0);
    if (compact !== undefined) output[key] = compact;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function compactAkkListDiagnostics(
  result: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  compactAkkListNested(output, "store", result.store, [
    "status", "readable", "writable", "upgradeable", "format_version",
    "writer_protocol"
  ]);
  const reconciliation = recordValue(result.reconciliation);
  if (reconciliation) {
    const compact = compactAkkListDiagnosticRecord(reconciliation);
    if (Object.keys(compact).length > 0) output.reconciliation = compact;
  }
  const scan = recordValue(result.terminal_scan);
  if (scan) {
    const compact = compactAkkListDiagnosticRecord(scan);
    if (Array.isArray(scan.agents)) {
      compact.agents = scan.agents.filter((item): item is string =>
        typeof item === "string"
      );
    }
    if (scan.diagnostics !== undefined) compact.provider_diagnostics = true;
    if (Object.keys(compact).length > 0) output.terminal_scan = compact;
  }
  return output;
}

function compactAkkListDiagnosticRecord(
  value: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "reason" ||
      key === "diagnostics" ||
      /(?:^|_)(?:path|dir)$/u.test(key)
    ) continue;
    if (
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)) ||
      (typeof item === "string" && key !== "error")
    ) output[key] = item;
    if (key === "error" && typeof item === "string") {
      output.error = truncateText(item, 300);
    }
    if (Array.isArray(item) && key === "errors") {
      output.error_count = item.length;
    }
  }
  if (
    nonEmptyString(value.reason) &&
    !["ok", "healthy", "compatible", "disabled"]
      .includes(nonEmptyString(value.status) ?? "")
  ) {
    output.message = truncateText(value.reason, 300);
  }
  return output;
}

function compactAkkListScalars(
  value: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const item = value[key];
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) output[key] = item;
  }
  return output;
}

function compactAkkListNested(
  output: Record<string, unknown>,
  key: string,
  value: unknown,
  keys: readonly string[]
): void {
  const record = recordValue(value);
  if (!record) return;
  const compact = compactAkkListScalars(record, keys);
  if (Object.keys(compact).length > 0) output[key] = compact;
}

function addAkkListWarningFlags(
  output: Record<string, unknown>,
  value: Record<string, unknown>
): void {
  const compatibilityWarnings = [
    nonEmptyString(value.compatibility_warning),
    ...stringArrayValue(value.compatibility_warnings)
  ].filter((item): item is string => Boolean(item));
  if (compatibilityWarnings.length > 0) output.compatibility_warning = true;
  const warnings = stringArrayValue(value.warnings);
  if (warnings.length > 0) output.warning_count = warnings.length;
}
