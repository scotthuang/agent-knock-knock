import { TERMINAL_WATCH_ACTION_USE } from "./terminal-action-contracts.js";
export { listActionContracts } from "./terminal-action-contracts.js";
import { sessionShortRef } from "./session-selector.js";
import {
  managedSessionBindingToken,
  type ManagedSessionState
} from "./managed-session.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import type { ModelControlAvailabilityDecision } from
  "./terminal-model-control-availability.js";
import type { TerminalPermissionControlAvailability } from
  "./terminal-permission-control-availability.js";
import type { ManagedTurnListActionDecision } from
  "./terminal-managed-turn-list-action-policy.js";

type JsonRecord = Record<string, unknown>;

export function renderManagedTurnListEntry(
  task: JsonRecord,
  options: {
    approvalState?: JsonRecord;
    actionDecision: ManagedTurnListActionDecision;
  }
): JsonRecord {
  const { approvalState, actionDecision } = options;
  const sessionId = stringValue(task.session_id) ??
    stringValue(task.conversation_id);
  const turnId = stringValue(task.turn_id) ??
    stringValue(task.conversation_id) ??
    String(task.id ?? "");
  const entry = {
    ...task,
    session_id: sessionId,
    turn_id: turnId,
    id: turnId,
    short_ref: sessionShortRef(turnId),
    source: "managed_turn",
    ...(approvalState ? { approval_state: approvalState } : {})
  };
  return {
    ...entry,
    available_actions: renderManagedTurnAvailableActions(turnId, actionDecision)
  };
}

export function renderAvailableListActions(
  entry: JsonRecord
): JsonRecord {
  const id = stringValue(entry.id ?? entry.conversation_id);
  if (!id) {
    return {};
  }
  const commands = isRecord(entry.commands) ? entry.commands : {};
  const targetArguments = { conversation_id: id };
  const actions: JsonRecord = {
    status: {
      tool: "agent_knock_knock_status",
      arguments: targetArguments
    }
  };
  const terminalControlled = entry.source === "terminal";
  const approvalState = isRecord(entry.approval_state)
    ? entry.approval_state
    : {};

  Object.assign(actions, renderTerminalSendAction({
    commands,
    entry,
    id,
    approvalState,
    terminalControlled
  }));

  const lifecycleBindingToken = stringValue(entry.lifecycle_binding_token);
  appendTerminalWatchAction({
    actions,
    commands,
    entry,
    id,
    terminalControlled
  });
  Object.assign(actions, renderTerminalLifecycleActions({
    commands,
    entry,
    id,
    approvalState,
    lifecycleBindingToken,
    terminalControlled
  }));
  const approvalFingerprint = stringValue(approvalState.fingerprint);
  Object.assign(actions, renderTerminalApprovalAction({
    commands,
    entry,
    approvalState,
    approvalFingerprint,
    targetArguments,
    terminalControlled
  }));

  const cancelAction = renderTerminalCancelListAction(
    entry,
    targetArguments,
    approvalState
  );
  if (cancelAction) {
    actions.cancel = cancelAction;
  }
  Object.assign(actions, renderTerminalCloseAction({ commands, entry, id }));
  return actions;
}

/** Format an already-authorized model-control decision without policy reads. */
export function renderTerminalModelControlActions(input: {
  readonly renderedActions: JsonRecord;
  readonly availability: ModelControlAvailabilityDecision;
  readonly mutationScope?: unknown;
}): JsonRecord {
  let actions = { ...input.renderedActions };
  delete actions.model_options;
  delete actions.repair_model_control;
  const { availability } = input;
  if (availability.availability === "open_from_empty") {
    const action = {
      tool: "agent_knock_knock_model_options",
      arguments: {
        terminal_id: availability.terminalId,
        expected_binding_token: availability.expectedBindingToken
      },
      ...(availability.authority === "zero_rollout_physical"
        ? { authority_scope: "terminal_user_explicit_model_control" }
        : {}),
      mutation_scope: input.mutationScope,
      requires_user_intent: true
    };
    if (availability.authority === "native_session") {
      actions = modelControlActionBeforePostLifecycleActions(actions, action);
    } else {
      actions.model_options = action;
    }
  }
  if (availability.availability === "residual_continuation") {
    actions.model_options = {
      tool: "agent_knock_knock_model_options",
      arguments: {
        terminal_id: availability.terminalId,
        expected_binding_token: availability.expectedBindingToken
      },
      authority_scope: "terminal_user_explicit_model_control_residual_entry",
      mutation_scope: input.mutationScope,
      requires_user_intent: true
    };
    actions.repair_model_control = modelControlRepairAction(
      availability.terminalId,
      availability.repairBindingToken
    );
  } else if (availability.availability === "repair_only") {
    actions.repair_model_control = modelControlRepairAction(
      availability.terminalId,
      availability.expectedBindingToken
    );
  }
  return actions;
}

export function renderTerminalPermissionControlActions(input: {
  readonly renderedActions: JsonRecord;
  readonly availability: TerminalPermissionControlAvailability;
}): JsonRecord {
  const actions = { ...input.renderedActions };
  delete actions.permission_options;
  if (input.availability.available) {
    actions.permission_options = {
      tool: "agent_knock_knock_permission_options",
      arguments: {
        terminal_id: input.availability.terminalId,
        expected_binding_token: input.availability.expectedBindingToken
      },
      authority_scope: "terminal_user_explicit_permission_control",
      mutation_scope: "current_session",
      requires_user_intent: true
    };
  }
  return actions;
}

/** Keep internal command flags out of the public physical-terminal row. */
export function renderTerminalPhysicalEntry(
  source: JsonRecord,
  actions: JsonRecord,
  userExplicitSendAction?: JsonRecord
): JsonRecord {
  const { commands: _commands, ...entry } = source;
  return {
    ...entry,
    ...(userExplicitSendAction
      ? { _terminal_user_explicit_send_action: userExplicitSendAction }
      : {}),
    available_actions: actions
  };
}

function modelControlRepairAction(
  terminalId: string,
  expectedBindingToken: string
): JsonRecord {
  return {
    tool: "agent_knock_knock_repair_model_control",
    arguments: {
      terminal_id: terminalId,
      expected_binding_token: expectedBindingToken
    },
    authority_scope: "terminal_user_explicit_model_control_repair",
    mutation_scope: "exact_model_control_residual_only",
    requires_user_intent: true
  };
}

function modelControlActionBeforePostLifecycleActions(
  actions: JsonRecord,
  modelOptions: JsonRecord
): JsonRecord {
  const output: JsonRecord = {};
  let inserted = false;
  const postLifecycle = new Set([
    "respond", "approve", "cancel", "renew", "retry_callback",
    "retry_submission", "close"
  ]);
  for (const [name, action] of Object.entries(actions)) {
    if (!inserted && postLifecycle.has(name)) {
      output.model_options = modelOptions;
      inserted = true;
    }
    output[name] = action;
  }
  if (!inserted) output.model_options = modelOptions;
  return output;
}

function renderTerminalSendAction(input: {
  commands: JsonRecord;
  entry: JsonRecord;
  id: string;
  approvalState: JsonRecord;
  terminalControlled: boolean;
}): JsonRecord {
  if (
    !input.terminalControlled ||
    input.commands.send !== true
  ) {
    return {};
  }
  return {
    send: {
      tool: "agent_knock_knock_send",
      arguments: { selector: input.id },
      missing_required: ["request"]
    }
  };
}

function renderTerminalLifecycleActions(input: {
  commands: JsonRecord;
  entry: JsonRecord;
  id: string;
  approvalState: JsonRecord;
  lifecycleBindingToken?: string;
  terminalControlled: boolean;
}): JsonRecord {
  const actions: JsonRecord = {
    ...renderNewThreadAction(input)
  };
  if (input.terminalControlled && input.commands.list_resumable_threads === true) {
    actions.list_resumable_threads = {
      tool: "agent_knock_knock_list_resumable_threads",
      arguments: { terminal_id: input.id },
      ...actionCompatibilityWarning(
        input.entry,
        "native_thread_lifecycle"
      )
    };
  }
  return {
    ...actions,
    ...renderNativeInspectAction(input)
  };
}

function renderNewThreadAction(input: {
  commands: JsonRecord;
  entry: JsonRecord;
  id: string;
  approvalState: JsonRecord;
  lifecycleBindingToken?: string;
  terminalControlled: boolean;
}): JsonRecord {
  if (!terminalIdleLifecycleActionEligible(input, "new_thread")) {
    return {};
  }
  return {
    new_thread: {
      tool: "agent_knock_knock_new_thread",
      arguments: {
        terminal_id: input.id,
        expected_binding_token: input.lifecycleBindingToken
      },
      ...actionCompatibilityWarning(
        input.entry,
        "native_thread_lifecycle"
      ),
      requires_user_intent: true
    }
  };
}

function renderNativeInspectAction(input: {
  commands: JsonRecord;
  entry: JsonRecord;
  id: string;
  approvalState: JsonRecord;
  lifecycleBindingToken?: string;
  terminalControlled: boolean;
}): JsonRecord {
  if (!terminalIdleLifecycleActionEligible(input, "native_inspect")) {
    return {};
  }
  return {
    native_inspect: {
      tool: "agent_knock_knock_native_inspect",
      arguments: {
        terminal_id: input.id,
        inspection: "status",
        expected_binding_token: input.lifecycleBindingToken
      },
      ...actionCompatibilityWarning(input.entry, "native_inspection")
    }
  };
}

function actionCompatibilityWarning(
  entry: JsonRecord,
  capabilityName: "native_thread_lifecycle" | "native_inspection"
): JsonRecord {
  const capability = isRecord(entry[capabilityName])
    ? entry[capabilityName]
    : undefined;
  const warning = stringValue(capability?.compatibilityWarning);
  return warning ? { compatibility_warning: warning } : {};
}

function terminalIdleLifecycleActionEligible(
  input: {
    commands: JsonRecord;
    entry: JsonRecord;
    approvalState: JsonRecord;
    lifecycleBindingToken?: string;
    terminalControlled: boolean;
  },
  command: "new_thread" | "native_inspect"
): boolean {
  return input.terminalControlled &&
    input.commands[command] === true &&
    Boolean(input.lifecycleBindingToken);
}

function renderManagedTurnAvailableActions(
  turnId: string,
  decision: ManagedTurnListActionDecision
): JsonRecord {
  if (!turnId) return {};
  const targetArguments = { turn_id: turnId };
  const actions: JsonRecord = {
    status: {
      tool: "agent_knock_knock_status",
      arguments: targetArguments
    }
  };
  if (decision.respond) {
    actions.respond = {
      tool: "agent_knock_knock_respond",
      arguments: targetArguments,
      missing_required: ["request"]
    };
  }
  if (decision.approval.available) {
    actions.approve = {
      tool: "agent_knock_knock_approve",
      arguments: targetArguments,
      choices: decision.approval.choices.map((choice) => ({ ...choice })),
      missing_required: ["expected_approval_fingerprint"],
      before_call: {
        tool: "agent_knock_knock_status",
        arguments: targetArguments,
        use:
          "After explicit user confirmation, copy the latest " +
            "terminal_status.approval_state.fingerprint into " +
            "expected_approval_fingerprint."
      },
      requires_explicit_user_confirmation: true,
      requires_fresh_status: true
    };
  }
  if (decision.cancel) {
    actions.cancel = {
      tool: "agent_knock_knock_cancel",
      arguments: targetArguments,
      requires_user_intent: true
    };
  }
  if (decision.renew) {
    actions.renew = {
      tool: "agent_knock_knock_renew",
      arguments: targetArguments
    };
  }
  if (decision.retryCallback) {
    actions.retry_callback = {
      tool: "agent_knock_knock_retry_callback",
      arguments: targetArguments
    };
  }
  if (decision.retrySubmission) {
    actions.retry_submission = {
      tool: "agent_knock_knock_send",
      arguments: targetArguments,
      requires_explicit_user_confirmation: true
    };
  }
  if (decision.close.available) {
    actions.close = {
      tool: "agent_knock_knock_close",
      arguments: {
        ...targetArguments,
        ...(decision.close.expectedMessageId
          ? { expected_message_id: decision.close.expectedMessageId }
          : {}),
        ...(decision.close.expectedTransitionId
          ? { expected_transition_id: decision.close.expectedTransitionId }
          : {})
      },
      requires_explicit_user_confirmation: true
    };
  }
  return actions;
}

function renderTerminalApprovalAction(input: {
  commands: JsonRecord;
  entry: JsonRecord;
  approvalState: JsonRecord;
  approvalFingerprint?: string;
  targetArguments: JsonRecord;
  terminalControlled: boolean;
}): JsonRecord {
  if (
    input.commands.approve !== true ||
    input.approvalState.approvable !== true ||
    !input.approvalFingerprint ||
    !input.terminalControlled ||
    input.entry.agent !== "codex"
  ) {
    return {};
  }
  return {
    approve: {
      tool: "agent_knock_knock_approve",
      arguments: input.targetArguments,
      choices: Array.isArray(input.approvalState.choices)
        ? input.approvalState.choices.flatMap((choice) =>
            isRecord(choice) &&
              (choice.decision === "approve_once" || choice.decision === "reject") &&
              choice.decision !== "reject"
              ? [{
                  decision: choice.decision,
                  label: stringValue(choice.label)
                }]
              : []
          )
        : [{
            decision: "approve_once",
            label: stringValue(input.approvalState.label)
          }],
      missing_required: ["expected_approval_fingerprint"],
      before_call: {
        tool: "agent_knock_knock_status",
        arguments: input.targetArguments,
        use:
          "After explicit user confirmation, copy the latest " +
            "terminal_status.approval_state.fingerprint into " +
            "expected_approval_fingerprint."
      },
      requires_explicit_user_confirmation: true,
      requires_fresh_status: true
    }
  };
}

function renderTerminalCloseAction(input: {
  commands: JsonRecord;
  entry: JsonRecord;
  id: string;
}): JsonRecord {
  if (input.commands.close !== true) {
    return {};
  }
  const orphanedDispatch = isRecord(input.entry.orphaned_terminal_dispatch)
    ? input.entry.orphaned_terminal_dispatch
    : undefined;
  const expectedMessageId = stringValue(orphanedDispatch?.message_id);
  const expectedTransitionId = stringValue(orphanedDispatch?.transition_id);
  return {
    close: {
      tool: "agent_knock_knock_close",
      arguments: {
        conversation_id: input.id,
        ...(expectedMessageId ? { expected_message_id: expectedMessageId } : {}),
        ...(expectedTransitionId
          ? { expected_transition_id: expectedTransitionId }
          : {})
      },
      requires_explicit_user_confirmation: true
    }
  };
}

function appendTerminalWatchAction(input: {
  actions: JsonRecord;
  commands: JsonRecord;
  entry: JsonRecord;
  id: string;
  terminalControlled: boolean;
}): void {
  if (
    !input.terminalControlled ||
    input.commands.watch !== true
  ) {
    return;
  }
  input.actions.watch = {
    tool: "agent_knock_knock_watch",
    arguments: {
      terminal_id: input.id
    },
    ...actionCompatibilityWarning(
      input.entry,
      "native_thread_lifecycle"
    ),
    requires_user_intent: true,
    use: TERMINAL_WATCH_ACTION_USE
  };
}

export function terminalWatchDiscoveryHint(terminalId: string): JsonRecord {
  return {
    kind: "terminal_watch_discovery",
    terminal_id: terminalId,
    command: `/akk watch ${terminalId}`,
    available_action_required: false,
    instruction:
      "Refresh agent_knock_knock_list to confirm and copy this exact terminal. " +
      "The advertised action is discovery help, not authorization: Watch is " +
      "read-only, prefers an exact task anchor, and otherwise follows the " +
      "selected terminal activity epoch with best-effort confidence."
  };
}

export function exactTerminalWatchAction(
  entry: unknown,
  terminalId: string
): JsonRecord | undefined {
  if (!isRecord(entry) || !isRecord(entry.available_actions)) {
    return undefined;
  }
  const watch = isRecord(entry.available_actions.watch)
    ? entry.available_actions.watch
    : undefined;
  const args = isRecord(watch?.arguments) ? watch.arguments : undefined;
  return watch?.tool === "agent_knock_knock_watch" &&
    watch.requires_user_intent === true &&
    args?.terminal_id === terminalId &&
    Object.keys(args).length === 1
    ? watch
    : undefined;
}

const CURRENT_TURN_ACTIONS = [
  "status", "respond", "approve", "cancel", "renew", "retry_callback",
  "retry_submission", "close"
] as const;

export function currentTerminalActions(currentTurn: JsonRecord | undefined): JsonRecord {
  if (!currentTurn || !isRecord(currentTurn.available_actions)) {
    return {};
  }
  const actions: JsonRecord = {};
  for (const action of CURRENT_TURN_ACTIONS) {
    if (isRecord(currentTurn.available_actions[action])) {
      actions[action] = currentTurn.available_actions[action];
    }
  }
  return actions;
}

export function safeTerminalActionsDuringConflict(rawActions: JsonRecord): JsonRecord {
  const actions: JsonRecord = {};
  for (const action of ["status", "close"] as const) {
    if (isRecord(rawActions[action])) {
      actions[action] = rawActions[action];
    }
  }
  return actions;
}

export function sendActionForManagedSession(action: JsonRecord, sessionId: string): JsonRecord {
  const { selector: _selector, ...existingArguments } = isRecord(action.arguments)
    ? action.arguments
    : {};
  return {
    ...action,
    arguments: {
      ...existingArguments,
      session_id: sessionId
    }
  };
}

export function actionsForManagedSessionBinding(
  actions: JsonRecord,
  session: ManagedSessionState
): JsonRecord {
  const token = managedSessionBindingToken(session);
  const next = { ...actions };
  for (const actionName of [
    "new_thread", "resume_thread", "native_inspect", "model_options"
  ] as const) {
    const action = isRecord(next[actionName]) ? next[actionName] : undefined;
    if (!action) {
      continue;
    }
    if (
      actionName === "model_options" &&
      (
        action.authority_scope === "terminal_user_explicit_model_control" ||
        action.authority_scope ===
          "terminal_user_explicit_model_control_residual_entry"
      )
    ) {
      continue;
    }
    next[actionName] = {
      ...action,
      arguments: {
        ...(isRecord(action.arguments) ? action.arguments : {}),
        expected_binding_token: token
      }
    };
  }
  return next;
}

export function safeUnavailableManagedTurnActions(actionsValue: JsonRecord): JsonRecord {
  const actions: JsonRecord = {};
  for (const action of ["status", "retry_callback", "close"] as const) {
    if (isRecord(actionsValue[action])) {
      actions[action] = actionsValue[action];
    }
  }
  return actions;
}

export function withoutInspectionActionsDuringNativeTransition(
  actions: JsonRecord
): JsonRecord {
  return Object.fromEntries(Object.entries(actions).filter(
    ([actionName]) =>
      actionName !== "native_inspect" &&
      actionName !== "permission_options" &&
      actionName !== "model_options" &&
      actionName !== "repair_model_control"
  ));
}

export function renderHistoricalManagedTurn(
  managedTurn: JsonRecord
): JsonRecord {
  const availableActions = isRecord(managedTurn.available_actions)
    ? managedTurn.available_actions
    : {};
  return {
    ...managedTurn,
    available_actions: safeUnavailableManagedTurnActions(availableActions)
  };
}

export function renderCurrentManagedTurn(
  managedTurn: JsonRecord,
  facts: {
    isCodex: boolean;
    ownerId: string;
    rawApproval?: JsonRecord;
    terminalApprovalState?: () => JsonRecord | undefined;
  }
): JsonRecord {
  if (!facts.rawApproval || !facts.isCodex) return managedTurn;
  const approve = retargetConversationAction(facts.rawApproval, facts.ownerId);
  const terminalApprovalState = facts.terminalApprovalState?.();
  return {
    ...managedTurn,
    ...(terminalApprovalState
      ? { approval_state: terminalApprovalState }
      : {}),
    available_actions: {
      ...(isRecord(managedTurn.available_actions)
        ? managedTurn.available_actions
        : {}),
      approve
    }
  };
}

export function readOnlyListActions(actionsValue: JsonRecord): JsonRecord {
  return isRecord(actionsValue.status)
    ? { status: actionsValue.status }
    : {};
}

/**
 * A deferred transfer may suppress every mutation except the user's explicit
 * request to release AKK management. Close never sends terminal input or stops
 * the coding agent, so it remains available while transfer cleanup is pending.
 */
export function userReleaseListActions(
  actionsValue: JsonRecord,
  turnId?: string
): JsonRecord {
  const actions = readOnlyListActions(actionsValue);
  if (isRecord(actionsValue.close)) {
    actions.close = actionsValue.close;
  } else if (turnId) {
    actions.close = {
      tool: "agent_knock_knock_close",
      arguments: { turn_id: turnId },
      requires_explicit_user_confirmation: true
    };
  }
  return actions;
}

export function readOnlyManagedTurn(managedTurn: JsonRecord): JsonRecord {
  return {
    ...managedTurn,
    available_actions: readOnlyListActions(
      isRecord(managedTurn.available_actions)
        ? managedTurn.available_actions
        : {}
    )
  };
}

export function userReleasableManagedTurn(managedTurn: JsonRecord): JsonRecord {
  const turnId = stringValue(
    managedTurn.turn_id ?? managedTurn.conversation_id ?? managedTurn.id
  );
  return {
    ...managedTurn,
    available_actions: userReleaseListActions(
      isRecord(managedTurn.available_actions)
        ? managedTurn.available_actions
        : {},
      turnId
    )
  };
}

export function withoutGenericHandoffSourceClose(
  managedTurn: JsonRecord,
  _blockingHandoffTurnIds: ReadonlySet<string>
): JsonRecord {
  // Explicit Close releases only AKK metadata. A live handoff no longer
  // revokes the user's ability to abandon the selected managed Turn.
  return managedTurn;
}

export function retargetConversationAction(
  action: JsonRecord,
  conversationId: string
): JsonRecord {
  const beforeCall = isRecord(action.before_call)
    ? action.before_call
    : undefined;
  return {
    ...action,
    arguments: {
      ...(isRecord(action.arguments) ? action.arguments : {}),
      turn_id: conversationId,
      conversation_id: undefined
    },
    ...(beforeCall
      ? {
          before_call: {
            ...beforeCall,
            arguments: {
              ...(isRecord(beforeCall.arguments)
                ? beforeCall.arguments
                : {}),
              turn_id: conversationId,
              conversation_id: undefined
            }
          }
        }
      : {})
  };
}

function renderTerminalCancelListAction(
  entry: JsonRecord,
  targetArguments: JsonRecord,
  approvalState: JsonRecord
): JsonRecord | undefined {
  const rawCancellable =
    entry.source === "terminal" &&
    isRecord(entry.commands) &&
    entry.commands.cancel === true &&
    (
      entry.activity_state === "working" ||
      (
        approvalState.blocked === true &&
        approvalState.approvable === true
      )
    );
  if (!rawCancellable) {
    return undefined;
  }
  return {
    tool: "agent_knock_knock_cancel",
    arguments: targetArguments,
    requires_user_intent: true
  };
}
