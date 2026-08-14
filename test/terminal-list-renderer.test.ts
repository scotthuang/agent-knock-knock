import test from "node:test";
import assert from "node:assert/strict";
import {
  actionsForManagedSessionBinding,
  currentTerminalActions,
  listActionContracts,
  readOnlyManagedTurn,
  renderAvailableListActions,
  renderManagedTurnListEntry,
  retargetConversationAction,
  safeTerminalActionsDuringConflict,
  safeUnavailableManagedTurnActions,
  sendActionForManagedSession,
  withoutGenericHandoffSourceClose
} from "../src/terminal-list-renderer.js";
import {
  managedSessionBindingToken,
  type ManagedSessionState
} from "../src/managed-session.js";

test("raw terminal actions retain their public order and exact selectors", () => {
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
});

test("managed Turn rendering consumes only sampled list facts", () => {
  const entry = renderManagedTurnListEntry({
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
      retryCallbackEligible: true
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

test("the public action contract remains v16 with stable action ordering", () => {
  const contracts = listActionContracts();
  assert.equal(contracts.version, 16);
  assert.deepEqual(
    Object.keys(contracts.actions as object),
    [
      "send",
      "new_thread",
      "list_resumable_threads",
      "native_inspect",
      "resume_thread",
      "reconcile_binding",
      "respond",
      "status",
      "approve",
      "cancel",
      "renew",
      "retry_callback",
      "close"
    ]
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
    close: { tool: "close" },
    malformed: "ignored"
  };

  assert.deepEqual(Object.keys(currentTerminalActions({
    available_actions: actions
  })), ["status", "respond", "approve", "cancel", "renew", "retry_callback"]);
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
    native_inspect: { arguments: { terminal_id: "terminal-1" } }
  }, session);
  assert.deepEqual(bound.send, { arguments: { request: "task" } });
  for (const name of ["new_thread", "resume_thread", "native_inspect"] as const) {
    assert.deepEqual(bound[name], {
      arguments: {
        terminal_id: "terminal-1",
        expected_binding_token: bindingToken
      }
    });
  }

  assert.deepEqual(sendActionForManagedSession({
    tool: "agent_knock_knock_send",
    arguments: { selector: "terminal-1", request: "task" }
  }, "session-1"), {
    tool: "agent_knock_knock_send",
    arguments: { request: "task", session_id: "session-1" }
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
    {
      conversation_id: "turn-1",
      available_actions: { status: { tool: "status" } }
    }
  );
  assert.equal(
    withoutGenericHandoffSourceClose(managedTurn, new Set()),
    managedTurn
  );
});
