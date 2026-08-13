import { sessionShortRef } from "./session-selector.js";

type JsonRecord = Record<string, unknown>;

export interface AvailableListActionFacts {
  terminalBridgeReady: boolean;
  managedApprovalPending: boolean;
  renewEligible: boolean;
  retryCallbackEligible: boolean;
}

const NO_AVAILABLE_LIST_ACTION_FACTS: AvailableListActionFacts = {
  terminalBridgeReady: false,
  managedApprovalPending: false,
  renewEligible: false,
  retryCallbackEligible: false
};

export function renderManagedTurnListEntry(
  task: JsonRecord,
  {
    terminalBridge = false,
    approvalState,
    actionFacts = NO_AVAILABLE_LIST_ACTION_FACTS
  }: {
    terminalBridge?: boolean;
    approvalState?: JsonRecord;
    actionFacts?: AvailableListActionFacts;
  } = {}
): JsonRecord {
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
    ...(approvalState ? { approval_state: approvalState } : {}),
    commands: {
      respond: task.status === "waiting_for_openclaw",
      cancel: isWaitingForAgent(task.status),
      close: task.status !== "closed",
      status: true,
      approve: terminalBridge && isActiveStatus(task.status)
    }
  };
  const availableActions = renderAvailableListActions(entry, actionFacts);
  const { commands: _commands, ...publicEntry } = entry;
  return {
    ...publicEntry,
    available_actions: availableActions
  };
}

export function listActionContracts(): JsonRecord {
  return {
    version: 16,
    instructions: [
      "Treat terminals[] as the primary resource and use only actions present in available_actions, except the snapshot-bound terminals[].handoff_decision.choices.take_over_current.action and an exact terminals[].blocking_turns[].recovery_action. Either nested action requires explicit user confirmation; after it succeeds, refresh list before any follow-current send.",
      "The session_exact scope uses session_id only when it is prefilled by the listed send action. A rollout-backed managed Codex pane instead uses the terminal_follow_current scope with its exact selector plus expected_terminal_token because even one materialized rollout does not prove the current TUI foreground thread. A turn id is never an ordinary send target.",
      "A user-explicit raw terminal selector, or a uniquely delegated raw send with no selector, may omit expected_terminal_token for convenience. If that terminal already has one rollout-backed managed Codex source, AKK captures an equivalent fresh candidate authority under the terminal and Store locks and still uses the same v3 follow-current transfer; it never degrades to sole-root strict continuation. Unmanaged first attach retains its existing behavior.",
      "Read-only native-thread listing targets an exact terminal_id. Native-thread new/resume mutations also use the listed expected_binding_token and never create a Turn.",
      "Native inspection is a separate terminal action: use only its closed inspection enum and current exact terminal_id/token; AKK status does not execute a native slash command.",
      "A verified, idle human native-thread switch may expose a terminal-scoped send with expected_terminal_token; that action atomically adopts the live context before creating its Turn. A conclusively ended Codex rollout may expose the same snapshot-bound send only after AKK proves zero current rollout and an exact empty composer; it detaches the ended Session and creates an isolated virgin Session. A status-card-only zero-rollout source or any otherwise eligible quiescent rollout-backed source with a complete nonempty pinned open-rollout inventory may also expose this exact action. One materialized rollout does not prove the current Codex TUI foreground thread, and a /clear resume hint is diagnostic only. AKK freezes any released predecessor Turn history, submits the ordinary task once, and binds a separate provisional Session only after one post-anchor rollout uniquely accepts that exact request. The accepted UUID may equal or differ from the predecessor without merging their Session lineages, and narrow panes do not require /status. Until that promotion commits, strict session_id send, respond, approve, cancel, native lifecycle, and native_inspect remain unavailable, and the provisional binding has no callback authority. If dispatch, acceptance, or post-submit binding is uncertain, do not retry automatically. An explicitly closed uncertain Turn may authorize only a future candidate send when its exact resolved close ledger, append-only uncertain receipt, frozen predecessor history, and complete current rollout inventory prove that the old bound rollout is absent and every candidate is unclaimed; close never forges the lost callback, and uncertain submissions cannot be renewed. Other binding conflicts remain fail-closed and may expose only exact low-level reconcile_binding recovery.",
      "List resumable threads before resume; use only a complete native_thread_id and the action returned for that candidate.",
      "Use a terminal selector only when explicitly named by the user or prefilled by that terminal row's send action. A handoff action also carries expected_terminal_token; never infer, guess, or reuse either value.",
      "Use respond only for an in-flight turn that is explicitly waiting for OpenClaw.",
      "Approval fingerprint v2 binds stable terminal, process, and action fields plus an unredacted exact prompt-region digest. Whole-screen digests and scrollback excerpts are diagnostic only and never authorize approval. A keys-mode prompt without exact prompt-region evidence is not approvable and exposes no approve action.",
      "Managed controls target turn_id. A raw terminal may be controlled only through its own list-prefilled conversation_id action. When a Codex managed prompt has no usable AKK Turn owner, list may expose one manual terminal-scoped approve carrying expected_terminal_token; copy the complete action after explicit human confirmation. It does not mutate the Turn or Session binding, has no durable dispatch receipt, and is never eligible for automatic approval. If its result is interrupted, refresh status and inspect the live prompt instead of retrying blindly. Never construct, guess, or reuse either selector or token.",
      "Start with the action's prefilled arguments, supply every missing_required field, and consult the top-level action's optional fields only when needed.",
      "Authoritative full IDs are prefilled; short_ref is for display and human input.",
      "Availability is a snapshot. AKK revalidates process, provider-owned terminal identity, workspace, activity, approval, and recovery state before side effects."
    ],
    field_semantics: {
      process_state: {
        terminals: "physical_terminal_process_liveness",
        authoritative_for_tool_calls: false
      },
      status: {
        managed_turns: "managed_turn_lifecycle",
        authoritative_for_tool_calls: false
      },
      activity_state: {
        terminals: "terminal_screen_activity_classification",
        authoritative_for_tool_calls: false
      },
      managed: {
        current_turn: "the authoritative dispatch-ledger owner, never inferred from history",
        recent_turn: "the latest visible non-owning turn in the current managed session",
        session_id:
          "the continuing agent context; it is an ordinary-send target only when the listed send action explicitly prefills it, and rollout-backed Codex uses selector/token instead",
        binding_id: "the immutable terminal-binding generation currently authorized for this Session",
        binding_token: "an optimistic concurrency token required by native-thread mutations",
        history: "older turns, present only with --all"
      },
      available_actions: {
        meaning: "currently_safe_actions",
        authoritative_for_tool_calls: true
      },
      native_agent_identity_observation: {
        meaning:
          "the latest bounded native identity probe; verified_absent is distinct from an unavailable resolver",
        authoritative_for_tool_calls: false
      },
      management_conflict: {
        verified_empty_native_session:
          "a previously bound Codex rollout is conclusively closed; only the exact snapshot-bound send in available_actions may detach it and create an isolated virgin Session"
      },
      handoff_state: {
        meaning:
          "why a conflict-scoped follow-current send is available or blocked",
        verified_empty_native_session_adoptable:
          "the exact current terminal snapshot permits the listed conflict send; availability is revalidated before terminal input"
      },
      handoff_decision: {
        meaning:
          "an explicit human choice required before superseding an active source Turn",
        authoritative_action_path:
          "terminals[].handoff_decision.choices.take_over_current.action",
        requires_explicit_user_confirmation: true,
        after_success: "refresh list before using a follow-current send action"
      },
      blocking_turns: {
        meaning:
          "terminal-incarnation-wide collateral unresolved managed Turns that suppress send, lifecycle, and native-inspection actions; an active human-handoff source Turn is never listed here and remains governed only by handoff_decision",
        authoritative_action_path:
          "terminals[].blocking_turns[].recovery_action",
        requires_explicit_user_confirmation: true,
        after_success: "refresh list before using any terminal action"
      }
    },
    actions: {
      send: {
        tool: "agent_knock_knock_send",
        target_argument: "session_id",
        initial_attach_target_argument: "selector",
        managed_scopes: {
          session_exact: {
            target_arguments: ["session_id"],
            follows_current_terminal: false
          },
          terminal_follow_current: {
            target_arguments: ["selector", "expected_terminal_token"],
            follows_current_terminal: true
          }
        },
        initial_attach_scope:
          "A discovery selector explicitly named by the user, the selector prefilled by an unmanaged raw-terminal row's available send action, or an omitted selector delegated only when exactly one eligible raw pane exists; never infer, guess, or reuse a selector or token. For an already managed rollout-backed Codex pane, an explicit or unique raw delegation without a token internally captures fresh v3 candidate authority under lock; it never becomes a strict Session continuation.",
        required: ["request"],
        optional: [
          "selector",
          "expected_terminal_token",
          "type",
          "idleTimeoutMinutes",
          "agentTimeoutMinutes",
          "agentHardTimeoutMinutes"
        ],
        unsupported: ["timeoutSeconds"],
        status_card_only_deferred_scope:
          "A zero-Turn Codex status-card binding has no rollout; only its listed selector/token send creates an isolated provisional Session and binds it after exact request acceptance. Until promotion commits, strict managed controls, native lifecycle, native_inspect, and callback authority remain unavailable; an uncertain dispatch, acceptance, or post-submit binding must not be retried automatically.",
        candidate_rollout_deferred_scope:
          "A quiescent rollout-backed Codex source uses a listed selector/token send whenever AKK can pin a complete nonempty candidate inventory. Inventory status resolved means only that one rollout is materialized; it does not prove the current TUI foreground thread. Released predecessor Turn history stays read-only while a separate provisional Session sends once and waits for one unique post-anchor request acceptance. A /clear resume hint is diagnostic only and is not token or routing authority. Same-UUID and different-UUID results keep separate Session lineages; zero, multiple, drifted, or uncertain acceptance is never retried blindly. Explicit close can abandon an uncertain receipt for future-send liveness only while the exact resolved close ledger, append-only receipt, frozen history, absent old rollout, and unclaimed candidate set remain authoritative; it never synthesizes callback delivery.",
        ordinary_use:
          "Create a new managed Turn through the exact action listed for the pane. An explicit session_id never follows the pane and is unavailable for rollout-backed Codex Sessions; their listed selector/token action binds only the unique exact rollout that accepts the submitted request. A user-explicit or uniquely delegated raw send without a token receives the same fresh under-lock candidate authority when it resolves to an already managed rollout-backed Codex source. A live terminal selector can also attach an unmanaged pane, adopt one verified human-selected native context, detach a verified-empty Codex source, or replace an eligible status-card/candidate-rollout source."
      },
      new_thread: {
        tool: "agent_knock_knock_new_thread",
        target_argument: "terminal_id",
        required: ["terminal_id", "expected_binding_token"],
        creates_turn: false,
        creates_session: true,
        requires_user_intent: true
      },
      list_resumable_threads: {
        tool: "agent_knock_knock_list_resumable_threads",
        target_argument: "terminal_id",
        required: ["terminal_id"],
        side_effect_free: true
      },
      native_inspect: {
        tool: "agent_knock_knock_native_inspect",
        target_argument: "terminal_id",
        required: ["terminal_id", "inspection", "expected_binding_token"],
        supported_inspections: ["status"],
        creates_turn: false,
        creates_session: false,
        mutates_store: false,
        sends_terminal_input: true,
        candidate_source: "terminals[].available_actions.native_inspect"
      },
      resume_thread: {
        tool: "agent_knock_knock_resume_thread",
        target_argument: "terminal_id",
        required: [
          "terminal_id",
          "native_thread_id",
          "expected_binding_token",
          "candidate_token"
        ],
        creates_turn: false,
        requires_user_intent: true,
        candidate_source: "list_resumable_threads"
      },
      reconcile_binding: {
        tool: "agent_knock_knock_reconcile_binding",
        target_argument: "terminal_id",
        required: [
          "terminal_id",
          "conflicting_session_id",
          "expected_session_revision",
          "expected_binding_token",
          "expected_terminal_token"
        ],
        creates_turn: false,
        sends_terminal_input: false,
        requires_user_intent: true,
        effect:
          "Detach one exactly listed conflicting Session binding without adopting the live replacement thread."
      },
      respond: {
        tool: "agent_knock_knock_respond",
        target_argument: "turn_id",
        required: ["turn_id", "request"],
        ordinary_use:
          "Answer an agent question inside the explicitly selected in-flight turn without creating another turn."
      },
      status: {
        tool: "agent_knock_knock_status",
        target_argument: "turn_id",
        compatibility_target_argument: "conversation_id",
        compatibility_scope:
          "A deprecated legacy Turn alias, or only the exact selector prefilled by an unmanaged raw-terminal row's available status action; never construct, guess, or reuse it.",
        required: ["turn_id"],
        optional: ["idleTimeoutMinutes", "trace"]
      },
      approve: {
        tool: "agent_knock_knock_approve",
        target_argument: "turn_id",
        compatibility_target_argument: "conversation_id",
        compatibility_scope:
          "A deprecated legacy Turn alias, or only the exact selector prefilled by a raw-terminal or manual terminal-scoped Codex approval action; never construct, guess, or reuse it.",
        required: ["turn_id", "expected_approval_fingerprint"],
        optional: ["expected_terminal_token"],
        terminal_scoped_scope:
          "Only the latest list-prefilled Codex conversation_id/token action may approve a managed current prompt without a usable Turn owner. It remains human-confirmed, revalidates exact terminal/process/Session/dispatch/prompt state before keys, never mutates managed state, has no durable dispatch receipt, cannot be auto-approved, and must not be blindly retried after an interrupted result.",
        fingerprint_contract: "v2_prompt_region",
        fingerprint_authority:
          "Stable terminal, process, and action fields plus the unredacted exact prompt-region digest; whole-screen digests and scrollback excerpts are diagnostic only.",
        missing_prompt_region_evidence: "not_approvable",
        requires_explicit_user_confirmation: true,
        requires_fresh_status: true
      },
      cancel: {
        tool: "agent_knock_knock_cancel",
        target_argument: "turn_id",
        compatibility_target_argument: "conversation_id",
        compatibility_scope:
          "A deprecated legacy Turn alias, or only the exact selector prefilled by an unmanaged raw-terminal row's available cancellation action; never construct, guess, or reuse it.",
        required: ["turn_id"],
        optional: ["idleTimeoutMinutes"],
        requires_user_intent: true
      },
      renew: {
        tool: "agent_knock_knock_renew",
        target_argument: "turn_id",
        compatibility_target_argument: "conversation_id",
        compatibility_scope:
          "Deprecated legacy Turn alias only; unmanaged raw-terminal rows never advertise renew.",
        required: ["turn_id"],
        optional: ["minutes"]
      },
      retry_callback: {
        tool: "agent_knock_knock_retry_callback",
        target_argument: "turn_id",
        compatibility_target_argument: "conversation_id",
        compatibility_scope:
          "Deprecated legacy Turn alias only; unmanaged raw-terminal rows never advertise callback retry.",
        required: ["turn_id"]
      },
      close: {
        tool: "agent_knock_knock_close",
        target_argument: "turn_id",
        compatibility_target_argument: "conversation_id",
        compatibility_scope:
          "A deprecated legacy Turn alias, or only the exact selector prefilled by an unmanaged raw-terminal row's orphan-close action; never construct, guess, or reuse it.",
        required: ["turn_id"],
        optional: [
          "reason",
          "expected_message_id",
          "expected_transition_id",
          "expected_handoff_token"
        ],
        requires_explicit_user_confirmation: true,
        handoff_scope:
          "expected_handoff_token is valid only by copying the complete nested action from terminals[].handoff_decision.choices.take_over_current; never construct, guess, or reuse it."
      }
    }
  };
}

export function renderAvailableListActions(
  entry: JsonRecord,
  facts: AvailableListActionFacts = NO_AVAILABLE_LIST_ACTION_FACTS
): JsonRecord {
  const id = stringValue(entry.id ?? entry.conversation_id);
  if (!id) {
    return {};
  }
  const commands = isRecord(entry.commands) ? entry.commands : {};
  const managed = entry.source === "managed_turn";
  const targetArguments = managed
    ? { turn_id: id }
    : { conversation_id: id };
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
  const managedApprovalPending = facts.managedApprovalPending;
  const terminalBridgeReady = managed && facts.terminalBridgeReady;

  if (
    terminalControlled &&
    commands.send === true &&
    entry.activity_state === "idle" &&
    approvalState.blocked !== true
  ) {
    actions.send = {
      tool: "agent_knock_knock_send",
      arguments: { selector: id },
      missing_required: ["request"]
    };
  }

  const lifecycleBindingToken = stringValue(entry.lifecycle_binding_token);
  if (
    terminalControlled &&
    commands.new_thread === true &&
    entry.activity_state === "idle" &&
    approvalState.blocked !== true &&
    lifecycleBindingToken
  ) {
    actions.new_thread = {
      tool: "agent_knock_knock_new_thread",
      arguments: {
        terminal_id: id,
        expected_binding_token: lifecycleBindingToken
      },
      requires_user_intent: true
    };
  }
  if (
    terminalControlled &&
    commands.list_resumable_threads === true
  ) {
    actions.list_resumable_threads = {
      tool: "agent_knock_knock_list_resumable_threads",
      arguments: { terminal_id: id }
    };
  }
  if (
    terminalControlled &&
    commands.native_inspect === true &&
    entry.activity_state === "idle" &&
    approvalState.blocked !== true &&
    lifecycleBindingToken
  ) {
    actions.native_inspect = {
      tool: "agent_knock_knock_native_inspect",
      arguments: {
        terminal_id: id,
        inspection: "status",
        expected_binding_token: lifecycleBindingToken
      }
    };
  }

  if (
    managed &&
    commands.respond === true &&
    terminalBridgeReady &&
    entry.status === "waiting_for_openclaw" &&
    !managedApprovalPending &&
    approvalState.blocked !== true
  ) {
    actions.respond = {
      tool: "agent_knock_knock_respond",
      arguments: { turn_id: id },
      missing_required: ["request"]
    };
  }

  const approvalFingerprint = stringValue(approvalState.fingerprint);
  const managedApprovalEligible =
    terminalBridgeReady &&
    entry.status === "waiting_for_openclaw" &&
    (
      entry.agent !== "claude" ||
      approvalState.decision_mode === "keys"
    );
  if (
    commands.approve === true &&
    approvalState.approvable === true &&
    approvalFingerprint &&
    (
      (
        terminalControlled &&
        entry.agent === "codex"
      ) ||
      managedApprovalEligible
    )
  ) {
    actions.approve = {
      tool: "agent_knock_knock_approve",
      arguments: targetArguments,
      missing_required: ["expected_approval_fingerprint"],
      before_call: {
        tool: "agent_knock_knock_status",
        arguments: targetArguments,
        use:
          "After explicit user confirmation, copy the latest terminal_status.approval_state.fingerprint into expected_approval_fingerprint."
      },
      requires_explicit_user_confirmation: true,
      requires_fresh_status: true
    };
  }

  const rawCancellable =
    terminalControlled &&
    commands.cancel === true &&
    (
      entry.activity_state === "working" ||
      (
        approvalState.blocked === true &&
        approvalState.approvable === true
      )
    );
  const managedCancellable =
    terminalBridgeReady &&
    ["waiting_for_agent", "waiting_for_openclaw"].includes(
      String(entry.status)
    ) &&
    !(
      managedApprovalPending &&
      approvalState.approvable !== true
    );
  if (rawCancellable || managedCancellable) {
    actions.cancel = {
      tool: "agent_knock_knock_cancel",
      arguments: targetArguments,
      requires_user_intent: true
    };
  }
  if (managed && facts.renewEligible) {
    actions.renew = {
      tool: "agent_knock_knock_renew",
      arguments: targetArguments
    };
  }
  if (managed && facts.retryCallbackEligible) {
    actions.retry_callback = {
      tool: "agent_knock_knock_retry_callback",
      arguments: targetArguments
    };
  }
  if (commands.close === true) {
    const orphanedDispatch = isRecord(entry.orphaned_terminal_dispatch)
      ? entry.orphaned_terminal_dispatch
      : undefined;
    const expectedMessageId = stringValue(orphanedDispatch?.message_id);
    const expectedTransitionId = stringValue(
      orphanedDispatch?.transition_id
    );
    actions.close = {
      tool: "agent_knock_knock_close",
      arguments: {
        ...(managed ? { turn_id: id } : { conversation_id: id }),
        ...(expectedMessageId
          ? { expected_message_id: expectedMessageId }
          : {}),
        ...(expectedTransitionId
          ? { expected_transition_id: expectedTransitionId }
          : {})
      },
      requires_explicit_user_confirmation: true
    };
  }
  return actions;
}

function isActiveStatus(status: unknown): boolean {
  return !["done", "failed", "closed", "cancelled"].some(
    (terminalStatus) => terminalStatus === status
  );
}

function isWaitingForAgent(status: unknown): boolean {
  return ["created", "running", "waiting_for_agent", "cancelling"].some(
    (terminalStatus) => terminalStatus === status
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
