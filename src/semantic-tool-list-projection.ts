import { isAkkModelFacingPrivateAuthorityField } from
  "./semantic-tool-model-facing-field-policy.js";
import { arrayValue, finiteNumber, nonEmptyString, stringArrayValue,
  truncateText } from "./semantic-tool-value-helpers.js";
import { recordValue } from "./value-guards.js";

/**
 * Keep every structured controller-Host List result below its model-output
 * budget without weakening the private action-authority path.
 *
 * The CLI remains the complete operator/debug contract. The controller
 * receives current resource identities and state, action names, and only the
 * dynamic semantic inputs needed to invoke those actions. Static explanations
 * live in the bundled agent-knock-knock skill.
 */
export function compactAkkListModelProjection(
  value: unknown
): Record<string, unknown> {
  const result = recordValue(value) ?? {};
  const actionContracts = recordValue(result.action_contracts);
  const diagnostics = compactAkkListDiagnostics(result);
  const recovery = compactAkkListControlState(result.recovery);
  return {
    projection: {
      schema: "agent-knock-knock/host-list-compact",
      version: 1,
      skill: "agent-knock-knock",
      ...(finiteNumber(actionContracts?.version) !== undefined
        ? { action_contract_version: finiteNumber(actionContracts?.version) }
        : {})
    },
    terminals: arrayValue(result.terminals).map(compactAkkListTerminal),
    terminal_watches: arrayValue(result.terminal_watches)
      .map(compactAkkListWatch),
    unavailable_managed_turns: arrayValue(result.unavailable_managed_turns)
      .map((turn) => compactAkkListTurn(turn, true)),
    ...(recovery ? { recovery } : {}),
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {})
  };
}

function compactAkkListTerminal(
  terminal: Record<string, unknown>
): Record<string, unknown> {
  const output = compactAkkListScalars(terminal, [
    "id",
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
    "handoff_state",
    "confidence"
  ]);
  const workspace = nonEmptyString(terminal.workspace);
  if (workspace && workspace !== nonEmptyString(terminal.cwd)) {
    output.workspace = workspace;
  }
  const command = nonEmptyString(terminal.command);
  if (command) output.command = truncateText(command, 160);

  compactAkkListNested(output, "terminal_control", terminal.terminal_control,
    ["kind", "target"]);
  compactAkkListNested(output, "approval_state", terminal.approval_state, [
    "scanned", "blocked", "approvable", "state", "kind", "decision_mode"
  ]);
  const features = compactAkkListFeatures(terminal);
  if (Object.keys(features).length > 0) output.features = features;

  const managed = compactAkkListManaged(terminal.managed);
  if (managed) output.managed = managed;
  const managementConflict = compactAkkListControlState(
    terminal.management_conflict
  );
  if (managementConflict) output.management_conflict = managementConflict;
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
  return output;
}

function compactAkkListFeatures(
  terminal: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const lifecycle = recordValue(terminal.native_thread_lifecycle);
  const inspection = recordValue(terminal.native_inspection);
  const modelControl = recordValue(terminal.model_control);
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
    "turn_count",
    "hidden_turn_count",
    "session_count"
  ]);
  const currentTurn = recordValue(managed.current_turn);
  const recentTurn = recordValue(managed.recent_turn);
  output.current_turn = currentTurn ? compactAkkListTurn(currentTurn) : null;
  output.recent_turn = recentTurn ? compactAkkListTurn(recentTurn) : null;
  const history = arrayValue(managed.history).map((turn) =>
    compactAkkListTurn(turn)
  );
  if (history.length > 0) output.history = history;
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

function compactAkkListWatch(
  watch: Record<string, unknown>
): Record<string, unknown> {
  const output = compactAkkListScalars(watch, [
    "watch_id",
    "short_ref",
    "source",
    "watch_mode",
    "confidence",
    "interaction_policy",
    "agent",
    "terminal_id",
    "native_thread_id",
    "workspace",
    "status",
    "activity_state",
    "created_at",
    "deadline_at",
    "updated_at",
    "last_activity_at"
  ]);
  compactAkkListNested(output, "capabilities", watch.capabilities, [
    "interaction_notify", "interaction_respond"
  ]);
  compactAkkListNested(output, "callback", watch.callback, [
    "pending", "delivered", "failed", "superseded", "last_error_code"
  ]);
  const interaction = compactAkkListInteraction(watch.interaction_state);
  if (interaction) output.interaction_state = interaction;
  const settlement = recordValue(watch.settlement);
  if (settlement) {
    const compactSettlement = compactAkkListScalars(settlement, [
      "kind", "observed_at", "reason_code", "completion_id",
      "completion_timestamp"
    ]);
    if (Object.keys(compactSettlement).length > 0) {
      output.settlement = compactSettlement;
    }
  }
  Object.assign(output, compactAkkListActions(watch.available_actions, {
    terminal_id: watch.terminal_id,
    watch_id: watch.watch_id
  }));
  addAkkListWarningFlags(output, watch);
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
  const args = compactAkkListActionArguments(action.arguments, name, parentIds);
  if (Object.keys(args).length > 0) output.arguments = args;
  const missingRequired = stringArrayValue(action.missing_required)
    .filter((field) => !isAkkModelFacingPrivateAuthorityField(field));
  if (missingRequired.length > 0) {
    output.missing_required = missingRequired;
  }
  for (const key of ["scope", "decision_mode"] as const) {
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
