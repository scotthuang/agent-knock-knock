import { sessionShortRef } from "./session-selector.js";
import {
  managedSessionBindingToken,
  type ManagedSessionState
} from "./managed-session.js";
import {
  isActiveConversationStatus,
  isWaitingForAgentStatus
} from "./protocol.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

type JsonRecord = Record<string, unknown>;

const TERMINAL_WATCH_ACTION_USE =
  "Monitor this human-started external task and notify OpenClaw when it " +
  "needs attention or finishes, instead of polling. Do not use Terminal " +
  "Watch for an AKK-managed Turn. Call agent_knock_knock_watch with this " +
  "exact terminal_id; AKK refreshes and revalidates current observation " +
  "authority internally.";

export interface AvailableListActionFacts {
  terminalBridgeReady: boolean;
  managedApprovalPending: boolean;
  renewEligible: boolean;
  retryCallbackEligible: boolean;
  retrySubmissionCandidate: boolean;
}

const NO_AVAILABLE_LIST_ACTION_FACTS: AvailableListActionFacts = {
  terminalBridgeReady: false,
  managedApprovalPending: false,
  renewEligible: false,
  retryCallbackEligible: false,
  retrySubmissionCandidate: false
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
      cancel: isWaitingForAgentStatus(task.status),
      close: task.status !== "closed",
      status: true,
      approve: terminalBridge && isActiveConversationStatus(task.status)
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
    version: 19,
    instructions: [
      "Treat terminals[] as the primary resource and use only actions present in available_actions, except the snapshot-bound terminals[].handoff_decision.choices.take_over_current.action and an exact terminals[].blocking_turns[].recovery_action. Either nested action requires explicit user confirmation; after it succeeds, refresh list before any follow-current send.",
      "A terminal_user_explicit send is the user's physical-terminal authority. A new user Send is gated only by one exact live physical prompt, no active approval prompt, and an exactly empty composer; AKK Turn, Session, deferred-transfer, transition, ledger, and Store health are not eligibility vetoes. AKK tries the managed fast path first. If AKK internal state prevents that path, it delivers the request once as unmanaged work, then best-effort releases the conflicting AKK management. When runtime durability is available, an omitted target binds its message_id to the first selected physical terminal and an existing or possibly existing same-ID record rejects automatic replay. If no record exists and durability is unavailable, user priority wins: AKK proceeds with a warning, and callers must not automatically retry that degraded result. The fallback creates no callback Turn and sends no callback; refresh list afterward and use Watch to observe the still-running task.",
      "The session_exact scope uses session_id only when it is prefilled by the listed send action. A rollout-backed managed Codex pane instead uses the terminal_follow_current scope with its exact terminal_id because even one materialized rollout does not prove the current TUI foreground thread. AKK derives and revalidates current terminal authority internally. A turn id is never an ordinary send target.",
      "A user-explicit raw terminal selector, or a uniquely delegated raw send with no selector, is only a discovery choice. If that terminal already has one rollout-backed managed Codex source, the managed fast path captures fresh candidate authority under the terminal and Store locks and still uses the same v3 follow-current transfer; it never degrades to sole-root strict continuation. If that managed path proves zero input and fails, the separate terminal_user_explicit path may deliver once as unmanaged work.",
      "Read-only native-thread listing targets an exact terminal_id. Native-thread new/resume mutations use terminal_id and, for resume, one complete native_thread_id; AKK resolves and revalidates current lifecycle authority internally. They never create a Turn.",
      "Native inspection is a separate terminal action: use only its closed inspection enum and current exact terminal_id. AKK resolves current lifecycle authority internally, and AKK status does not execute a native slash command.",
      "Terminal Watch observes one exact human-started active task without sending terminal input or creating an AKK Session or Turn. Start it only from terminals[].available_actions.watch, pass that action's exact terminal_id, and use watch_id for later status or unwatch operations. AKK refreshes and revalidates current observation authority internally.",
      "A verified, idle human native-thread switch may expose a terminal-scoped send; that action atomically adopts the live context before creating its Turn. A conclusively ended Codex rollout may expose the same snapshot-bound operation only after AKK proves zero current rollout and an exact empty composer; it detaches the ended Session and creates an isolated virgin Session. A status-card-only zero-rollout source or any otherwise eligible quiescent rollout-backed source with a complete nonempty pinned open-rollout inventory may also expose this exact action. One materialized rollout does not prove the current Codex TUI foreground thread, and a /clear resume hint is diagnostic only. AKK freezes any released predecessor Turn history, submits the ordinary task once, and binds a separate provisional Session only after one post-anchor rollout uniquely accepts that exact request. The accepted UUID may equal or differ from the predecessor without merging their Session lineages, and narrow panes do not require /status. Until that promotion commits, strict session_id send, respond, approve, cancel, native lifecycle, and native_inspect remain unavailable, and the provisional binding has no callback authority. If dispatch, acceptance, or post-submit binding is uncertain, do not retry automatically. Explicit Close always honors the user's decision to release AKK management of the selected Turn; it sends no terminal input, never stops the coding agent or pane, and reports best-effort cleanup warnings without vetoing the Close. Refresh list afterward and use Watch when the coding agent is still working. Other input-producing binding actions remain fail-closed.",
      "List resumable threads before resume; use only a complete native_thread_id and the action returned for that candidate.",
      "Structured follow-current actions use only the exact terminal_id prefilled by that terminal row. Human slash commands may use an explicitly named discovery selector. AKK resolves and revalidates current action authority internally; never infer or guess a target.",
      "Use respond only for an in-flight turn that is explicitly waiting for OpenClaw.",
      "Retry submission is never automatic. Only when the current exact Turn exposes available_actions.retry_submission, ask for explicit user confirmation and call its prefilled agent_knock_knock_send {turn_id} form unchanged. It never accepts replacement text or caller-selected terminal, Session, timeout, or callback route data, and execution revalidates the durable submission and live terminal under lock before any input.",
      "Manual approval binds the exact prompt the user reviewed. After explicit confirmation, call only the currently advertised approve action; AKK keeps the prompt authority private and recaptures the exact terminal, process, request, and prompt before sending a decision key. A prompt without complete exact evidence is not approvable.",
      "Managed controls target turn_id. A raw terminal may be controlled only through its own list-prefilled conversation_id action. When a Codex managed prompt has no usable AKK Turn owner, list may expose one manual terminal-scoped approve action after exact observation. It does not mutate the Turn or Session binding, has no durable dispatch receipt, and is never eligible for automatic approval. If its result is interrupted, refresh status and inspect the live prompt instead of retrying blindly.",
      "Start with the action's prefilled arguments, supply every missing_required field, and consult the top-level action's optional fields only when needed.",
      "Authoritative full IDs are prefilled; short_ref is for display and human input.",
      "Availability is a snapshot. terminal_user_explicit revalidates the exact live process and provider-owned terminal identity, approval observation, and empty composer; activity and AKK recovery state never veto it. Other actions revalidate their action-specific workspace, activity, management, and recovery authority before side effects."
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
          "the continuing agent context; it is an ordinary-send target only when the listed send action explicitly prefills it, and rollout-backed Codex uses the listed follow-current terminal action instead",
        binding_id: "the immutable terminal-binding generation currently authorized for this Session",
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
          "why a managed conflict-scoped follow-current send is available or blocked; it does not veto terminal_user_explicit physical Send",
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
          "terminal-incarnation-wide unresolved managed Turns that suppress managed send, lifecycle, and native-inspection actions but never terminal_user_explicit physical Send; each exact Turn remains explicitly closable even during a deferred transfer or human handoff",
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
        initial_attach_target_argument: "terminal_id",
        managed_scopes: {
          session_exact: {
            target_arguments: ["session_id"],
            follows_current_terminal: false
          },
          terminal_follow_current: {
            target_arguments: ["terminal_id"],
            follows_current_terminal: true
          }
        },
        initial_attach_scope:
          "A terminal_user_explicit structured call uses the terminal_id prefilled by an exact live terminal row's available send action, or omits the target only when exactly one send-ready pane exists. Human slash commands may preserve a discovery selector explicitly named by the user. This user-priority scope depends only on the exact live physical prompt, no active approval prompt, and an exactly empty composer. AKK first attempts the managed fast path; if AKK internal state blocks it, AKK delivers once as unmanaged work with no callback Turn or callback, then best-effort releases that management. Refresh list afterward and use Watch to observe the task.",
        required: ["request"],
        optional: [
          "session_id",
          "terminal_id",
          "type",
          "idleTimeoutMinutes",
          "agentTimeoutMinutes",
          "agentHardTimeoutMinutes"
        ],
        unsupported: ["timeoutSeconds"],
        status_card_only_deferred_scope:
          "A zero-Turn Codex status-card binding has no rollout; only its listed follow-current send creates an isolated provisional Session and binds it after exact request acceptance. Until promotion commits, strict managed controls, native lifecycle, native_inspect, and callback authority remain unavailable; an uncertain dispatch, acceptance, or post-submit binding must not be retried automatically.",
        candidate_rollout_deferred_scope:
          "A quiescent rollout-backed Codex source uses a listed follow-current send whenever AKK can pin a complete nonempty candidate inventory. Inventory status resolved means only that one rollout is materialized; it does not prove the current TUI foreground thread. Released predecessor Turn history stays read-only while a separate provisional Session sends once and waits for one unique post-anchor request acceptance. A /clear resume hint is diagnostic only and is not routing authority. Same-UUID and different-UUID results keep separate Session lineages; zero, multiple, drifted, or uncertain acceptance is never retried blindly. Explicit Close is the user-owned escape hatch: it closes the AKK Turn first, then best-effort releases only linked AKK metadata without terminal input or coding-agent interruption.",
        ordinary_use:
          "Create a new managed Turn through the exact action listed for the pane when the managed fast path succeeds. An explicit session_id never follows the pane and is unavailable for rollout-backed Codex Sessions; their listed follow-current action binds only the unique exact rollout that accepts the submitted request. The managed path can attach an unmanaged pane, adopt one verified human-selected native context, detach a verified-empty Codex source, or replace an eligible status-card/candidate-rollout source. A terminal_user_explicit action gives the user's selected exact live physical prompt priority over broken AKK internal state: it may deliver once as unmanaged work with no callback Turn or callback, then best-effort release that management. Refresh list and use Watch for that still-running task."
      },
      retry_submission: {
        tool: "agent_knock_knock_send",
        target_argument: "turn_id",
        required: ["turn_id"],
        accepts_only: ["turn_id"],
        creates_turn: false,
        caller_supplies_request_text: false,
        may_retransmit_original_request_text: true,
        retransmit_condition:
          "durable structured proof that Enter was never attempted plus a positively empty live composer",
        requires_explicit_user_confirmation: true,
        candidate_source:
          "the current exact managed Turn's available_actions.retry_submission",
        scope:
          "Recover only the original durable submission whose text injection is proven but Enter dispatch remains uncertain. AKK either submits the proven exact existing draft once, or retransmits the immutable original request once only after structured no-Enter proof and a positively empty live composer. It revalidates all terminal, identity, route, composer, and one-shot authority under lock and otherwise fails closed."
      },
      watch: {
        tool: "agent_knock_knock_watch",
        target_argument: "terminal_id",
        required: ["terminal_id"],
        optional: ["hardTimeoutMinutes"],
        creates_turn: false,
        creates_session: false,
        sends_terminal_input: false,
        candidate_source: "terminals[].available_actions.watch",
        scope:
          "Observe only the exact supported human-started task already active in this terminal. It never adopts the task as AKK work or blocks later human terminal use."
      },
      unwatch: {
        tool: "agent_knock_knock_unwatch",
        target_argument: "watch_id",
        required: ["watch_id"],
        creates_turn: false,
        creates_session: false,
        sends_terminal_input: false,
        requires_user_intent: true
      },
      new_thread: {
        tool: "agent_knock_knock_new_thread",
        target_argument: "terminal_id",
        required: ["terminal_id"],
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
        required: ["terminal_id", "inspection"],
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
          "native_thread_id"
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
          "conflicting_session_id"
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
        target_arguments: {
          exactly_one_of: ["turn_id", "conversation_id", "watch_id"]
        },
        managed_target_argument: "turn_id",
        watch_target_argument: "watch_id",
        watch_scope:
          "Use only the authoritative watch_id prefilled by a current Terminal Watch row.",
        compatibility_target_argument: "conversation_id",
        compatibility_scope:
          "A deprecated legacy Turn alias, or only the exact selector prefilled by an unmanaged raw-terminal row's available status action; never construct, guess, or reuse it.",
        required: [],
        optional: ["idleTimeoutMinutes", "trace"]
      },
      approve: {
        tool: "agent_knock_knock_approve",
        target_arguments: {
          exactly_one_of: ["turn_id", "terminal_id"]
        },
        managed_target_argument: "turn_id",
        terminal_target_argument: "terminal_id",
        required: [],
        optional: [],
        terminal_scoped_scope:
          "Only the latest list-prefilled Codex terminal_id action may approve a managed current prompt without a usable Turn owner. It remains human-confirmed, uses private server-bound reviewed-prompt authority, revalidates exact terminal/process/Session/dispatch/prompt state before keys, never mutates managed state, has no durable dispatch receipt, cannot be auto-approved, and must not be blindly retried after an interrupted result.",
        approval_authority: "private_server_bound_reviewed_prompt",
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
          "expected_transition_id"
        ],
        requires_explicit_user_confirmation: true,
        user_priority: true,
        sends_terminal_input: false,
        stops_coding_agent: false,
        cleanup_policy:
          "Close the selected AKK Turn first. Linked transfer, Session, ledger, and callback cleanup is best-effort; missing, stale, malformed, or newer metadata is preserved and reported as a warning rather than blocking Close.",
        handoff_scope:
          "After explicit confirmation, a handoff Close follows the same user-priority management-release path and does not depend on a private live-terminal fence."
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
    lifecycleBindingToken,
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
  Object.assign(actions, renderManagedRespondAction({
    commands,
    entry,
    id,
    approvalState,
    managed,
    managedApprovalPending,
    terminalBridgeReady
  }));

  const approvalFingerprint = stringValue(approvalState.fingerprint);
  const managedApprovalEligible =
    terminalBridgeReady &&
    entry.status === "waiting_for_openclaw" &&
    (
      entry.agent !== "claude" ||
      approvalState.decision_mode === "keys"
    );
  Object.assign(actions, renderApprovalAction({
    commands,
    entry,
    approvalState,
    approvalFingerprint,
    managedApprovalEligible,
    targetArguments,
    terminalControlled
  }));

  const cancelAction = renderCancelListAction(
    entry,
    facts,
    targetArguments,
    approvalState
  );
  if (cancelAction) {
    actions.cancel = cancelAction;
  }
  Object.assign(
    actions,
    renderManagedRecoveryActions({ entry, facts, id, managed, targetArguments })
  );
  Object.assign(actions, renderCloseAction({ commands, entry, id, managed }));
  return actions;
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
    input.commands.send !== true ||
    input.entry.activity_state !== "idle" ||
    input.approvalState.blocked === true
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
      arguments: { terminal_id: input.id }
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
      }
    }
  };
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
    input.entry.activity_state === "idle" &&
    input.approvalState.blocked !== true &&
    Boolean(input.lifecycleBindingToken);
}

function renderManagedRespondAction(input: {
  commands: JsonRecord;
  entry: JsonRecord;
  id: string;
  approvalState: JsonRecord;
  managed: boolean;
  managedApprovalPending: boolean;
  terminalBridgeReady: boolean;
}): JsonRecord {
  if (
    !input.managed ||
    input.commands.respond !== true ||
    !input.terminalBridgeReady ||
    input.entry.status !== "waiting_for_openclaw" ||
    input.managedApprovalPending ||
    input.approvalState.blocked === true
  ) {
    return {};
  }
  return {
    respond: {
      tool: "agent_knock_knock_respond",
      arguments: { turn_id: input.id },
      missing_required: ["request"]
    }
  };
}

function renderApprovalAction(input: {
  commands: JsonRecord;
  entry: JsonRecord;
  approvalState: JsonRecord;
  approvalFingerprint?: string;
  managedApprovalEligible: boolean;
  targetArguments: JsonRecord;
  terminalControlled: boolean;
}): JsonRecord {
  if (
    input.commands.approve !== true ||
    input.approvalState.approvable !== true ||
    !input.approvalFingerprint ||
    !(
      input.terminalControlled && input.entry.agent === "codex" ||
      input.managedApprovalEligible
    )
  ) {
    return {};
  }
  return {
    approve: {
      tool: "agent_knock_knock_approve",
      arguments: input.targetArguments,
      missing_required: ["expected_approval_fingerprint"],
      before_call: {
        tool: "agent_knock_knock_status",
        arguments: input.targetArguments,
        use:
          "After explicit user confirmation, copy the latest terminal_status.approval_state.fingerprint into expected_approval_fingerprint."
      },
      requires_explicit_user_confirmation: true,
      requires_fresh_status: true
    }
  };
}

function renderManagedRecoveryActions(input: {
  entry: JsonRecord;
  facts: AvailableListActionFacts;
  id: string;
  managed: boolean;
  targetArguments: JsonRecord;
}): JsonRecord {
  const actions: JsonRecord = {};
  if (input.managed && input.facts.renewEligible) {
    actions.renew = {
      tool: "agent_knock_knock_renew",
      arguments: input.targetArguments
    };
  }
  if (input.managed && input.facts.retryCallbackEligible) {
    actions.retry_callback = {
      tool: "agent_knock_knock_retry_callback",
      arguments: input.targetArguments
    };
  }
  if (
    input.managed &&
    input.entry.agent === "codex" &&
    input.facts.retrySubmissionCandidate
  ) {
    actions.retry_submission = {
      tool: "agent_knock_knock_send",
      arguments: { turn_id: input.id },
      requires_explicit_user_confirmation: true
    };
  }
  return actions;
}

function renderCloseAction(input: {
  commands: JsonRecord;
  entry: JsonRecord;
  id: string;
  managed: boolean;
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
        ...(input.managed ? { turn_id: input.id } : { conversation_id: input.id }),
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
  lifecycleBindingToken?: string;
  terminalControlled: boolean;
}): void {
  if (
    !input.terminalControlled ||
    input.commands.watch !== true ||
    !["working", "awaiting_approval"].includes(
      String(input.entry.activity_state ?? "")
    ) ||
    !input.lifecycleBindingToken
  ) {
    return;
  }
  input.actions.watch = {
    tool: "agent_knock_knock_watch",
    arguments: {
      terminal_id: input.id
    },
    requires_user_intent: true,
    use: TERMINAL_WATCH_ACTION_USE
  };
}

export function terminalWatchDiscoveryHint(terminalId: string): JsonRecord {
  return {
    kind: "terminal_watch_discovery",
    terminal_id: terminalId,
    command: `/akk watch ${terminalId}`,
    available_action_required: true,
    instruction:
      "Refresh agent_knock_knock_list and use only this terminal's current " +
      "available_actions.watch. Terminal Watch is only for human-started " +
      "external work, never an AKK-managed Turn."
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
  for (const actionName of ["new_thread", "resume_thread", "native_inspect"] as const) {
    const action = isRecord(next[actionName]) ? next[actionName] : undefined;
    if (!action) {
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

function renderCancelListAction(
  entry: JsonRecord,
  facts: AvailableListActionFacts,
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
  const managedCancellable =
    entry.source === "managed_turn" &&
    facts.terminalBridgeReady &&
    ["waiting_for_agent", "waiting_for_openclaw"].includes(
      String(entry.status)
    ) &&
    !(
      facts.managedApprovalPending &&
      approvalState.approvable !== true
    );
  if (!rawCancellable && !managedCancellable) {
    return undefined;
  }
  return {
    tool: "agent_knock_knock_cancel",
    arguments: targetArguments,
    requires_user_intent: true
  };
}
