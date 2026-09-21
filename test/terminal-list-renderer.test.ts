import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  actionsForManagedSessionBinding,
  currentTerminalActions,
  exactTerminalWatchAction,
  listActionContracts,
  readOnlyManagedTurn,
  renderAvailableListActions,
  renderCurrentManagedTurn,
  renderManagedTurnListEntry,
  renderTerminalModelControlActions,
  retargetConversationAction,
  safeTerminalActionsDuringConflict,
  safeUnavailableManagedTurnActions,
  sendActionForManagedSession,
  userReleasableManagedTurn,
  withoutGenericHandoffSourceClose,
  withoutInspectionActionsDuringNativeTransition
} from "../src/terminal-list-renderer.js";
import { decideManagedTurnListActions } from
  "../src/terminal-managed-turn-list-action-policy.js";
import {
  managedSessionBindingToken,
  type ManagedSessionState
} from "../src/managed-session.js";

function renderManagedTurnFixture(
  task: Record<string, unknown>,
  options: {
    terminalBridge?: boolean;
    approvalState?: Record<string, unknown>;
    actionFacts: {
      terminalBridgeReady: boolean;
      managedApprovalPending: boolean;
      renewEligible: boolean;
      retryCallbackEligible: boolean;
      retrySubmissionCandidate: boolean;
    };
  }
) {
  return renderManagedTurnListEntry(task, {
    approvalState: options.approvalState,
    actionDecision: decideManagedTurnListActions({
      status: task.status,
      agent: task.agent,
      terminalBridgeAdvertised: options.terminalBridge === true,
      approvalState: options.approvalState,
      orphanedTerminalDispatch:
        typeof task.orphaned_terminal_dispatch === "object" &&
          task.orphaned_terminal_dispatch !== null
          ? task.orphaned_terminal_dispatch as Record<string, unknown>
          : undefined,
      ...options.actionFacts
    })
  });
}

test("raw terminal actions leave model control to its safety decision", () => {
  const actions = renderAvailableListActions({
    id: "terminal:codex:42",
    source: "terminal",
    agent: "codex",
    activity_state: "idle",
    lifecycle_binding_token: "binding-token",
    approval_state: {
      blocked: false,
      approvable: true,
      fingerprint: "approval-fingerprint"
    },
    commands: {
      send: true,
      new_thread: true,
      list_resumable_threads: true,
      native_inspect: true,
      model_options: true,
      approve: true,
      close: true
    }
  });
  assert.deepEqual(Object.keys(actions), [
    "status",
    "send",
    "new_thread",
    "list_resumable_threads",
    "native_inspect",
    "approve",
    "close"
  ]);
  assert.deepEqual(actions.send, {
    tool: "agent_knock_knock_send",
    arguments: { selector: "terminal:codex:42" },
    missing_required: ["request"]
  });
  assert.deepEqual(actions.new_thread, {
    tool: "agent_knock_knock_new_thread",
    arguments: {
      terminal_id: "terminal:codex:42",
      expected_binding_token: "binding-token"
    },
    requires_user_intent: true
  });
  assert.equal(actions.model_options, undefined);
});

test("model-control rendering preserves action order and token domains", () => {
  const base = {
    status: { tool: "status" },
    new_thread: { tool: "new-thread" },
    approve: { tool: "approve" },
    close: { tool: "close" }
  };
  const native = renderTerminalModelControlActions({
    renderedActions: base,
    availability: {
      availability: "open_from_empty",
      authority: "native_session",
      terminalId: "terminal-1",
      expectedBindingToken: "ordinary-token"
    },
    mutationScope: "current_and_new_sessions"
  });
  assert.deepEqual(Object.keys(native), [
    "status", "new_thread", "model_options", "approve", "close"
  ]);
  assert.deepEqual(native.model_options, {
    tool: "agent_knock_knock_model_options",
    arguments: {
      terminal_id: "terminal-1",
      expected_binding_token: "ordinary-token"
    },
    mutation_scope: "current_and_new_sessions",
    requires_user_intent: true
  });

  const residual = renderTerminalModelControlActions({
    renderedActions: base,
    availability: {
      availability: "residual_continuation",
      terminalId: "terminal-1",
      expectedBindingToken: "residual-entry-token",
      repairBindingToken: "repair-token"
    },
    mutationScope: "current_and_new_sessions"
  });
  assert.deepEqual(Object.keys(residual), [
    "status", "new_thread", "approve", "close",
    "model_options", "repair_model_control"
  ]);
  assert.equal(
    (residual.model_options as { arguments: { expected_binding_token: string } })
      .arguments.expected_binding_token,
    "residual-entry-token"
  );
  assert.equal(
    (residual.repair_model_control as {
      arguments: { expected_binding_token: string };
    }).arguments.expected_binding_token,
    "repair-token"
  );
});

test("managed Turn rendering consumes only sampled list facts", () => {
  const entry = renderManagedTurnFixture({
    conversation_id: "turn-1",
    session_id: "session-1",
    status: "waiting_for_openclaw",
    agent: "claude"
  }, {
    terminalBridge: true,
    approvalState: {
      blocked: false,
      approvable: true,
      fingerprint: "approval-fingerprint",
      decision_mode: "keys"
    },
    actionFacts: {
      terminalBridgeReady: true,
      managedApprovalPending: false,
      renewEligible: false,
      retryCallbackEligible: true,
      retrySubmissionCandidate: false
    }
  });
  assert.equal(entry.commands, undefined);
  assert.deepEqual(Object.keys(entry.available_actions as object), [
    "status",
    "respond",
    "approve",
    "cancel",
    "retry_callback",
    "close"
  ]);
  assert.deepEqual(
    (entry.available_actions as Record<string, Record<string, unknown>>)
      .respond.arguments,
    { turn_id: "turn-1" }
  );
});

test("managed Turn renderer formats a decision without rebuilding eligibility", () => {
  const source = fs.readFileSync("src/terminal-list-renderer.ts", "utf8");
  assert.doesNotMatch(source, /\bdecideManagedTurnListActions\b/u);
  const start = source.indexOf("function renderManagedTurnAvailableActions");
  const end = source.indexOf("function renderTerminalApprovalAction", start);
  assert.ok(start >= 0 && end > start);
  const managedRenderer = source.slice(start, end);
  assert.doesNotMatch(
    managedRenderer,
    /entry\.status|approvalState|terminalBridgeReady|managedApprovalPending|Eligible/u
  );
});

test("managed Turn action projection preserves exact JSON bytes across eligibility states", () => {
  const fixtures = [
    {
      task: {
        conversation_id: "turn-1",
        session_id: "session-1",
        status: "waiting_for_openclaw",
        agent: "claude"
      },
      options: {
        terminalBridge: true,
        approvalState: {
          blocked: false,
          approvable: true,
          fingerprint: "approval-fingerprint",
          decision_mode: "keys",
          choices: [
            { decision: "approve_once", label: "Yes" },
            { decision: "reject", label: "No" },
            { decision: "always", label: "Never expose" }
          ]
        },
        actionFacts: {
          terminalBridgeReady: true,
          managedApprovalPending: false,
          renewEligible: false,
          retryCallbackEligible: true,
          retrySubmissionCandidate: false
        }
      },
      expected:
        '{"conversation_id":"turn-1","session_id":"session-1","status":"waiting_for_openclaw","agent":"claude","turn_id":"turn-1","id":"turn-1","short_ref":"@b9cf0ff1a5","source":"managed_turn","approval_state":{"blocked":false,"approvable":true,"fingerprint":"approval-fingerprint","decision_mode":"keys","choices":[{"decision":"approve_once","label":"Yes"},{"decision":"reject","label":"No"},{"decision":"always","label":"Never expose"}]},"available_actions":{"status":{"tool":"agent_knock_knock_status","arguments":{"turn_id":"turn-1"}},"respond":{"tool":"agent_knock_knock_respond","arguments":{"turn_id":"turn-1"},"missing_required":["request"]},"approve":{"tool":"agent_knock_knock_approve","arguments":{"turn_id":"turn-1"},"choices":[{"decision":"approve_once","label":"Yes"},{"decision":"reject","label":"No"}],"missing_required":["expected_approval_fingerprint"],"before_call":{"tool":"agent_knock_knock_status","arguments":{"turn_id":"turn-1"},"use":"After explicit user confirmation, copy the latest terminal_status.approval_state.fingerprint into expected_approval_fingerprint."},"requires_explicit_user_confirmation":true,"requires_fresh_status":true},"cancel":{"tool":"agent_knock_knock_cancel","arguments":{"turn_id":"turn-1"},"requires_user_intent":true},"retry_callback":{"tool":"agent_knock_knock_retry_callback","arguments":{"turn_id":"turn-1"}},"close":{"tool":"agent_knock_knock_close","arguments":{"turn_id":"turn-1"},"requires_explicit_user_confirmation":true}}}'
    },
    {
      task: {
        conversation_id: "turn-2",
        session_id: "session-2",
        status: "stalled",
        agent: "codex",
        orphaned_terminal_dispatch: {
          message_id: "message-2",
          transition_id: "transition-2"
        }
      },
      options: {
        terminalBridge: true,
        approvalState: { blocked: false, approvable: false },
        actionFacts: {
          terminalBridgeReady: true,
          managedApprovalPending: false,
          renewEligible: true,
          retryCallbackEligible: true,
          retrySubmissionCandidate: true
        }
      },
      expected:
        '{"conversation_id":"turn-2","session_id":"session-2","status":"stalled","agent":"codex","orphaned_terminal_dispatch":{"message_id":"message-2","transition_id":"transition-2"},"turn_id":"turn-2","id":"turn-2","short_ref":"@39dccc8f29","source":"managed_turn","approval_state":{"blocked":false,"approvable":false},"available_actions":{"status":{"tool":"agent_knock_knock_status","arguments":{"turn_id":"turn-2"}},"renew":{"tool":"agent_knock_knock_renew","arguments":{"turn_id":"turn-2"}},"retry_callback":{"tool":"agent_knock_knock_retry_callback","arguments":{"turn_id":"turn-2"}},"retry_submission":{"tool":"agent_knock_knock_send","arguments":{"turn_id":"turn-2"},"requires_explicit_user_confirmation":true},"close":{"tool":"agent_knock_knock_close","arguments":{"turn_id":"turn-2","expected_message_id":"message-2","expected_transition_id":"transition-2"},"requires_explicit_user_confirmation":true}}}'
    },
    {
      task: {
        conversation_id: "turn-3",
        status: "waiting_for_agent",
        agent: "codex"
      },
      options: {
        terminalBridge: true,
        approvalState: { blocked: true, approvable: false },
        actionFacts: {
          terminalBridgeReady: true,
          managedApprovalPending: true,
          renewEligible: false,
          retryCallbackEligible: false,
          retrySubmissionCandidate: false
        }
      },
      expected:
        '{"conversation_id":"turn-3","status":"waiting_for_agent","agent":"codex","session_id":"turn-3","turn_id":"turn-3","id":"turn-3","short_ref":"@22ffb6e248","source":"managed_turn","approval_state":{"blocked":true,"approvable":false},"available_actions":{"status":{"tool":"agent_knock_knock_status","arguments":{"turn_id":"turn-3"}},"close":{"tool":"agent_knock_knock_close","arguments":{"turn_id":"turn-3"},"requires_explicit_user_confirmation":true}}}'
    },
    {
      task: {
        conversation_id: "turn-4",
        status: "closed",
        agent: "claude"
      },
      options: {
        terminalBridge: true,
        actionFacts: {
          terminalBridgeReady: true,
          managedApprovalPending: false,
          renewEligible: false,
          retryCallbackEligible: false,
          retrySubmissionCandidate: false
        }
      },
      expected:
        '{"conversation_id":"turn-4","status":"closed","agent":"claude","session_id":"turn-4","turn_id":"turn-4","id":"turn-4","short_ref":"@7af8c102b0","source":"managed_turn","available_actions":{"status":{"tool":"agent_knock_knock_status","arguments":{"turn_id":"turn-4"}}}}'
    }
  ] as const;

  for (const fixture of fixtures) {
    assert.equal(
      JSON.stringify(renderManagedTurnFixture(fixture.task, fixture.options)),
      fixture.expected
    );
  }
});

test("the public action contract v30 exposes semantic arguments only", () => {
  const contracts = listActionContracts();
  assert.equal(contracts.version, 30);
  assert.deepEqual(
    Object.keys(contracts.actions as object),
    [
      "send",
      "retry_submission",
      "watch",
      "unwatch",
      "new_thread",
      "list_resumable_threads",
      "native_inspect",
      "model_options",
      "repair_model_control",
      "set_model",
      "identify_foreground",
      "identify_and_send",
      "resume_thread",
      "reconcile_binding",
      "respond",
      "respond_interaction",
      "status",
      "approve",
      "cancel",
      "renew",
      "retry_callback",
      "close"
    ]
  );
  assert.deepEqual(
    (contracts.actions as Record<string, any>).status.target_arguments,
    { exactly_one_of: ["turn_id", "conversation_id", "watch_id"] }
  );
  assert.deepEqual(
    (contracts.actions as Record<string, any>).status.required,
    []
  );
  const encoded = JSON.stringify(contracts);
  for (const forbidden of [
    "expected_terminal_token",
    "expected_binding_token",
    "candidate_token",
    "expected_handoff_token",
    "expected_approval_fingerprint",
    "expected_interaction_fingerprint",
    "interaction_prompt_fingerprint",
    "binding_token",
    "lifecycle_binding_token"
  ]) {
    assert.equal(encoded.includes(forbidden), false, forbidden);
  }
  const actions = contracts.actions as Record<string, any>;
  assert.deepEqual(actions.repair_model_control.required, ["terminal_id"]);
  assert.equal(
    actions.repair_model_control.authority_scope,
    "terminal_user_explicit_model_control_repair"
  );
  assert.equal(
    actions.repair_model_control.uncertain_retry_allowed,
    false
  );
  assert.equal(actions.identify_foreground.proof_ttl_ms, 30000);
  assert.equal(actions.identify_foreground.proof_grants_authority, false);
  assert.equal(actions.identify_and_send.unmanaged_fallback, false);
  assert.equal(
    actions.identify_and_send.final_identity_source,
    "unique_exact_request_acceptance"
  );
  assert.match(
    (contracts.instructions as string[]).join("\n"),
    /native interaction response[\s\S]*same controller conversation[\s\S]*managed Turn or response-capable exact Watch[\s\S]*current pending interaction_state[\s\S]*turn_id or watch_id[\s\S]*async_question[\s\S]*delivery_mode[\s\S]*one call resolves only the current step[\s\S]*refresh status[\s\S]*manual_required interactions are notification-only[\s\S]*retry/iu
  );
  assert.deepEqual(actions.respond_interaction, {
    tool: "agent_knock_knock_respond_interaction",
    target_arguments: {
      exactly_one_of: ["turn_id", "watch_id"]
    },
    managed_target_argument: "turn_id",
    watch_target_argument: "watch_id",
    interaction_argument: "interaction_id",
    required: ["interaction_id", "answers"],
    optional: ["delivery_mode"],
    candidate_source:
      "terminal_status.interaction_state for a managed Turn or watch.interaction_state for a response-capable exact Watch, returned by agent_knock_knock_status in the same controller conversation",
    watch_scope:
      "Only an exact current Watch interaction whose Status projection advertises capabilities.respond=true may use watch_id. Terminal-activity and manual_required Watch interactions remain notification-only.",
    answer_contract:
      "Use only the current projection's opaque question_id and option_id values, or its bounded typed free_text answer. An async_question defaults to advertised steer_current_turn or accepts explicit advertised queue_next_turn as delivery_mode; questionnaire forbids delivery_mode. Raw terminal keys, menu indexes, rendered labels, prompt fingerprints, versions, and terminal commands are not accepted.",
    one_step_per_call: true,
    requires_fresh_status: true,
    requires_same_controller_conversation: true,
    manual_required_sends_input: false,
    uncertain_retry_allowed: false
  });
  assert.match(
    (contracts.instructions as string[]).join("\n"),
    /terminal_user_explicit[\s\S]*exact live physical terminal\/process[\s\S]*scanned, non-blocked approval state[\s\S]*Composer visibility, stability, exactness, or existing draft contents do not veto[\s\S]*C-u[\s\S]*Claude Code[\s\S]*sentinel-backed native C-s stash-clear transaction[\s\S]*cursor position[\s\S]*proves? the main Composer empty[\s\S]*paste window[\s\S]*Enter exactly once[\s\S]*no Composer observation may veto Enter[\s\S]*Terminal Watch callback[\s\S]*no managed callback Turn[\s\S]*failure is reported/u
  );
  assert.match(
    (contracts.instructions as string[]).join("\n"),
    /parsed working activity and Codex rollout ambiguity do not veto/u
  );
  assert.match(
    actions.send.initial_attach_scope,
    /terminal_user_explicit[\s\S]*exact live physical terminal\/process[\s\S]*scanned, non-blocked approval state[\s\S]*C-u[\s\S]*Claude Code[\s\S]*sentinel-backed native C-s stash-clear transaction[\s\S]*cursor position[\s\S]*proves? the main Composer empty[\s\S]*paste window[\s\S]*Enter exactly once[\s\S]*without a post-text Composer veto[\s\S]*managed fast path[\s\S]*unmanaged work[\s\S]*Terminal Watch callback/u
  );
  assert.equal(
    actions.send.terminal_user_explicit_composer_policy,
    "replace_current_composer_and_submit"
  );
  assert.equal(
    actions.send.codex_terminal_user_explicit_composer_policy,
    "replace_current_composer_and_submit"
  );
  assert.deepEqual(actions.retry_submission, {
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
  });
  assert.deepEqual(actions.send.managed_scopes.terminal_follow_current, {
    target_arguments: ["terminal_id"],
    follows_current_terminal: true
  });
  assert.deepEqual(actions.new_thread.required, ["terminal_id"]);
  assert.deepEqual(actions.native_inspect.required, [
    "terminal_id",
    "inspection"
  ]);
  assert.deepEqual(actions.model_options.required, ["terminal_id"]);
  assert.deepEqual(actions.resume_thread.required, [
    "terminal_id",
    "native_thread_id"
  ]);
  assert.deepEqual(actions.reconcile_binding.required, [
    "terminal_id",
    "conflicting_session_id"
  ]);
  assert.deepEqual(actions.approve.target_arguments, {
    exactly_one_of: ["turn_id", "terminal_id"]
  });
  assert.deepEqual(actions.close.optional, [
    "reason",
    "expected_message_id",
    "expected_transition_id"
  ]);
});

test("raw terminals expose an exact read-only watch action without lifecycle vetoes", () => {
  const working = renderAvailableListActions({
    id: "terminal:v2:tmux:codex:work:0.0:1234",
    source: "terminal",
    agent: "codex",
    activity_state: "working",
    lifecycle_binding_token: "fresh-binding-token",
    approval_state: { blocked: false },
    commands: { watch: true }
  });
  assert.deepEqual(working.watch, {
    tool: "agent_knock_knock_watch",
    arguments: {
      terminal_id: "terminal:v2:tmux:codex:work:0.0:1234"
    },
    requires_user_intent: true,
    use:
      "Observe this exact terminal without sending input. AKK uses an exact " +
      "task anchor when available and otherwise falls back to best-effort " +
      "terminal activity. Call agent_knock_knock_watch with this exact " +
      "terminal_id; version, ownership, and artifact uncertainty are warnings " +
      "rather than Watch vetoes."
  });
  assert.equal(exactTerminalWatchAction({
    available_actions: working
  }, "terminal:v2:tmux:codex:work:0.0:1234"),
  working.watch);
  assert.equal(exactTerminalWatchAction({
    available_actions: working
  }, "terminal:v2:tmux:codex:work:0.0:9999"),
  undefined);

  const awaitingApproval = renderAvailableListActions({
    id: "terminal:v2:tmux:claude:work:0.1:5678",
    source: "terminal",
    agent: "claude",
    activity_state: "awaiting_approval",
    lifecycle_binding_token: "approval-binding-token",
    approval_state: { blocked: true },
    commands: { watch: true }
  });
  assert.equal(Object.hasOwn(awaitingApproval, "watch"), true);

  for (const entry of [
    {
      id: "terminal:v2:tmux:codex:work:0.0:1234",
      source: "terminal",
      activity_state: "idle",
      lifecycle_binding_token: "fresh-binding-token",
      commands: { watch: true }
    },
    {
      id: "terminal:v2:tmux:codex:work:0.0:1234",
      source: "terminal",
      activity_state: "working",
      commands: { watch: true }
    }
  ]) {
    assert.equal(
      Object.hasOwn(renderAvailableListActions(entry), "watch"),
      true
    );
  }
});

test("unverified agent versions warn without hiding eligible native actions", () => {
  const lifecycleWarning =
    "Codex 0.150.0 has not been regression-tested by AKK";
  const inspectionWarning =
    "Codex 0.150.0 native status uses optimistic runtime validation";
  const idle = renderAvailableListActions({
    id: "terminal:v2:tmux:codex:future:0.0:1500",
    source: "terminal",
    agent: "codex",
    activity_state: "idle",
    lifecycle_binding_token: "future-binding-token",
    approval_state: { blocked: false },
    native_thread_lifecycle: {
      status: "supported",
      compatibilityWarning: lifecycleWarning
    },
    native_inspection: {
      status: "supported",
      compatibilityWarning: inspectionWarning
    },
    commands: {
      new_thread: true,
      list_resumable_threads: true,
      native_inspect: true
    }
  }) as Record<string, any>;

  assert.equal(idle.new_thread.compatibility_warning, lifecycleWarning);
  assert.equal(
    idle.list_resumable_threads.compatibility_warning,
    lifecycleWarning
  );
  assert.equal(
    idle.native_inspect.compatibility_warning,
    inspectionWarning
  );

  const working = renderAvailableListActions({
    id: "terminal:v2:tmux:codex:future:0.0:1500",
    source: "terminal",
    agent: "codex",
    activity_state: "working",
    lifecycle_binding_token: "future-binding-token",
    approval_state: { blocked: false },
    native_thread_lifecycle: {
      status: "supported",
      compatibilityWarning: lifecycleWarning
    },
    commands: { watch: true }
  }) as Record<string, any>;
  assert.equal(working.watch.compatibility_warning, lifecycleWarning);
  assert.ok(exactTerminalWatchAction({
    available_actions: working
  }, "terminal:v2:tmux:codex:future:0.0:1500"));
});

test("submission retry is a confirmed exact-Turn form of the existing send tool", () => {
  const entry = renderManagedTurnFixture({
    conversation_id: "turn-uncertain",
    session_id: "session-uncertain",
    status: "stalled",
    agent: "codex"
  }, {
    terminalBridge: true,
    actionFacts: {
      terminalBridgeReady: true,
      managedApprovalPending: false,
      renewEligible: false,
      retryCallbackEligible: false,
      retrySubmissionCandidate: true
    }
  });
  const retry = (entry.available_actions as Record<string, any>)
    .retry_submission;
  assert.deepEqual(retry, {
    tool: "agent_knock_knock_send",
    arguments: { turn_id: "turn-uncertain" },
    requires_explicit_user_confirmation: true
  });
  assert.deepEqual(currentTerminalActions(entry).retry_submission, retry);
  assert.equal(
    safeUnavailableManagedTurnActions(
      entry.available_actions as Record<string, any>
    ).retry_submission,
    undefined
  );
  const claude = renderManagedTurnFixture({
    conversation_id: "turn-claude-uncertain",
    status: "stalled",
    agent: "claude"
  }, {
    actionFacts: {
      terminalBridgeReady: true,
      managedApprovalPending: false,
      renewEligible: false,
      retryCallbackEligible: false,
      retrySubmissionCandidate: true
    }
  });
  assert.equal(
    (claude.available_actions as Record<string, any>).retry_submission,
    undefined
  );
});

test("terminal list action policies expose only their exact safe subsets", () => {
  const actions = {
    status: { tool: "status" },
    send: { tool: "send" },
    respond: { tool: "respond" },
    approve: { tool: "approve" },
    cancel: { tool: "cancel" },
    renew: { tool: "renew" },
    retry_callback: { tool: "retry" },
    retry_submission: { tool: "send", arguments: { turn_id: "turn-1" } },
    close: { tool: "close" },
    malformed: "ignored"
  };

  assert.deepEqual(Object.keys(currentTerminalActions({
    available_actions: actions
  })), [
    "status", "respond", "approve", "cancel", "renew", "retry_callback",
    "retry_submission", "close"
  ]);
  assert.deepEqual(
    Object.keys(safeTerminalActionsDuringConflict(actions)),
    ["status", "close"]
  );
  assert.deepEqual(
    Object.keys(safeUnavailableManagedTurnActions(actions)),
    ["status", "retry_callback", "close"]
  );
  assert.deepEqual(readOnlyManagedTurn({
    conversation_id: "turn-1",
    available_actions: actions
  }), {
    conversation_id: "turn-1",
    available_actions: { status: { tool: "status" } }
  });
  assert.deepEqual(userReleasableManagedTurn({
    conversation_id: "turn-closed-crash-lag",
    status: "closed",
    available_actions: { status: { tool: "status" } }
  }).available_actions, {
    status: { tool: "status" },
    close: {
      tool: "agent_knock_knock_close",
      arguments: { turn_id: "turn-closed-crash-lag" },
      requires_explicit_user_confirmation: true
    }
  });
});

test("managed binding actions are retargeted without weakening snapshot authority", () => {
  const session: ManagedSessionState = {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-1",
    agent: "codex",
    workspace: "/workspace",
    status: "detached",
    lineage: { created_by: "attach" },
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z"
  };
  const bindingToken = managedSessionBindingToken(session);
  const bound = actionsForManagedSessionBinding({
    send: { arguments: { request: "task" } },
    new_thread: { arguments: { terminal_id: "terminal-1" } },
    resume_thread: { arguments: { terminal_id: "terminal-1" } },
    native_inspect: { arguments: { terminal_id: "terminal-1" } },
    model_options: { arguments: { terminal_id: "terminal-1" } }
  }, session);
  assert.deepEqual(bound.send, { arguments: { request: "task" } });
  for (const name of [
    "new_thread", "resume_thread", "native_inspect", "model_options"
  ] as const) {
    assert.deepEqual(bound[name], {
      arguments: {
        terminal_id: "terminal-1",
        expected_binding_token: bindingToken
      }
    });
  }
  const residualToken = "residual-entry-token";
  const residualBound = actionsForManagedSessionBinding({
    model_options: {
      arguments: {
        terminal_id: "terminal-1",
        expected_binding_token: residualToken
      },
      authority_scope:
        "terminal_user_explicit_model_control_residual_entry"
    }
  }, session);
  assert.deepEqual(residualBound.model_options, {
    arguments: {
      terminal_id: "terminal-1",
      expected_binding_token: residualToken
    },
    authority_scope:
      "terminal_user_explicit_model_control_residual_entry"
  });

  assert.deepEqual(sendActionForManagedSession({
    tool: "agent_knock_knock_send",
    arguments: { selector: "terminal-1", request: "task" }
  }, "session-1"), {
    tool: "agent_knock_knock_send",
    arguments: { request: "task", session_id: "session-1" }
  });
});

test("unresolved native transitions suppress every read operation that sends terminal input", () => {
  assert.deepEqual(withoutInspectionActionsDuringNativeTransition({
    status: { tool: "status" },
    watch: { tool: "watch" },
    native_inspect: { tool: "native-inspect" },
    model_options: { tool: "model-options" },
    close: { tool: "close" }
  }), {
    status: { tool: "status" },
    watch: { tool: "watch" },
    close: { tool: "close" }
  });
});

test("approval and handoff action rewrites preserve nested command shape", () => {
  const retargeted = retargetConversationAction({
    tool: "agent_knock_knock_approve",
    arguments: {
      conversation_id: "terminal-1",
      expected_approval_fingerprint: "fingerprint"
    },
    before_call: {
      tool: "agent_knock_knock_status",
      arguments: { conversation_id: "terminal-1" }
    }
  }, "turn-1");
  assert.deepEqual(retargeted, {
    tool: "agent_knock_knock_approve",
    arguments: {
      conversation_id: undefined,
      expected_approval_fingerprint: "fingerprint",
      turn_id: "turn-1"
    },
    before_call: {
      tool: "agent_knock_knock_status",
      arguments: {
        conversation_id: undefined,
        turn_id: "turn-1"
      }
    }
  });

  const managedTurn = {
    conversation_id: "turn-1",
    available_actions: {
      status: { tool: "status" },
      close: { tool: "close" }
    }
  };
  assert.deepEqual(
    withoutGenericHandoffSourceClose(managedTurn, new Set(["turn-1"])),
    managedTurn
  );
  assert.equal(
    withoutGenericHandoffSourceClose(managedTurn, new Set()),
    managedTurn
  );
});

test("current approval retargets before reading terminal approval state", () => {
  let retargeted = false;
  const rawApproval = {
    tool: "agent_knock-knock_approve",
    get arguments() {
      retargeted = true;
      return { conversation_id: "terminal-1" };
    }
  };
  const rendered = renderCurrentManagedTurn({
    conversation_id: "turn-1",
    available_actions: { status: { tool: "status" } }
  }, {
    isCodex: true,
    ownerId: "turn-1",
    rawApproval,
    terminalApprovalState: () => {
      assert.equal(retargeted, true);
      return { blocked: true };
    }
  });
  assert.deepEqual(rendered.approval_state, { blocked: true });
  assert.deepEqual(
    (rendered.available_actions as Record<string, Record<string, unknown>>)
      .approve.arguments,
    { conversation_id: undefined, turn_id: "turn-1" }
  );
});
