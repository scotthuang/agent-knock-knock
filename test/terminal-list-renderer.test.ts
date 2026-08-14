import test from "node:test";
import assert from "node:assert/strict";
import {
  listActionContracts,
  renderAvailableListActions,
  renderManagedTurnListEntry
} from "../src/terminal-list-renderer.js";

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
