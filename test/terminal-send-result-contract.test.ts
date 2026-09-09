import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizedTerminalSendResultContract,
  presentTerminalDispatchReplay,
  terminalSendEnterDispatched,
  terminalSendResultContract
} from "../src/terminal-dispatch-presenter.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import type { AgentMessage, Conversation, Executor } from
  "../src/protocol.js";

test("Send contract keeps physical dispatch independent from native acceptance", () => {
  assert.deepEqual(terminalSendResultContract({
    terminalInputDispatched: true,
    agentAcceptance: "unproven",
    managementMode: "unmanaged",
    observationMode: "terminal_watch",
    callbackAvailable: true,
    interactionNotificationAvailable: true
  }), {
    terminal_input_dispatched: true,
    agent_acceptance: "unproven",
    management_mode: "unmanaged",
    observation_mode: "terminal_watch",
    capabilities: {
      callback: true,
      interaction_notify: true,
      interaction_respond: false
    },
    legacy_management_mode: "unmanaged_fallback"
  });
});

test("Send contract does not advertise capabilities without observation", () => {
  assert.deepEqual(terminalSendResultContract({
    terminalInputDispatched: false,
    agentAcceptance: "unproven",
    managementMode: "managed",
    observationMode: "none",
    callbackAvailable: true,
    interactionNotificationAvailable: true,
    interactionResponseAvailable: true
  }), {
    terminal_input_dispatched: false,
    agent_acceptance: "unproven",
    management_mode: "managed",
    observation_mode: "none",
    capabilities: {
      callback: false,
      interaction_notify: false,
      interaction_respond: false
    },
    legacy_management_mode: "managed"
  });
});

test("Send contract requires proven acceptance for interaction response", () => {
  const result = terminalSendResultContract({
    terminalInputDispatched: true,
    agentAcceptance: "unproven",
    managementMode: "managed",
    observationMode: "managed_monitor",
    callbackAvailable: true,
    interactionNotificationAvailable: true,
    interactionResponseAvailable: true
  });
  assert.deepEqual(result.capabilities, {
    callback: true,
    interaction_notify: true,
    interaction_respond: false
  });
});

test("old unmanaged Send receipts normalize to the orthogonal contract", () => {
  assert.deepEqual(normalizedTerminalSendResultContract({
    delivered: true,
    delivered_unmanaged: true,
    callback_expected: true,
    callback_mode: "terminal_watch",
    management_mode: "unmanaged_fallback",
    scope: "terminal_user_explicit"
  }), {
    delivered: true,
    terminal_input_dispatched: true,
    agent_acceptance: "unproven",
    management_mode: "unmanaged",
    observation_mode: "terminal_watch",
    capabilities: {
      callback: true,
      interaction_notify: false,
      interaction_respond: false
    },
    legacy_management_mode: "unmanaged_fallback"
  });
});

test("transport-only managed receipts never become proven acceptance", () => {
  assert.deepEqual(normalizedTerminalSendResultContract({
    delivered: false,
    callback_expected: true,
    delivery_receipt: "enter_dispatched",
    submission_outcome: "pending_acceptance"
  }), {
    delivered: true,
    terminal_input_dispatched: true,
    agent_acceptance: "unproven",
    management_mode: "managed",
    observation_mode: "managed_monitor",
    capabilities: {
      callback: true,
      interaction_notify: true,
      interaction_respond: false
    },
    legacy_management_mode: "managed"
  });
});

test("text-only uncertainty is input without legacy delivery", () => {
  assert.deepEqual(normalizedTerminalSendResultContract({
    delivered: false,
    delivery_receipt: "text_injected",
    submission_outcome: "uncertain",
    callback_expected: false
  }), {
    delivered: false,
    terminal_input_dispatched: true,
    agent_acceptance: "unproven",
    management_mode: "managed",
    observation_mode: "none",
    capabilities: {
      callback: false,
      interaction_notify: false,
      interaction_respond: false
    },
    legacy_management_mode: "managed"
  });
});

test("legacy post-Enter outcomes retain delivery proof", () => {
  for (const fixture of [
    {
      delivered: false,
      delivery_receipt: "not_accepted",
      submission_outcome: "not_accepted"
    },
    {
      delivered: false,
      delivery_receipt: "uncertain",
      submission_outcome: "uncertain"
    }
  ]) {
    assert.equal(terminalSendEnterDispatched(fixture), true);
    assert.equal(
      normalizedTerminalSendResultContract(fixture).delivered,
      true
    );
  }
  assert.equal(terminalSendEnterDispatched({
    delivered: false,
    delivery_receipt: "uncertain",
    submission_outcome: "uncertain",
    terminal_input_sent: false
  }), false);
});

test("released replay never advertises a callback or response authority", () => {
  const owner = {
    session_id: "session-released",
    turn_id: "turn-released",
    conversation_id: "turn-released",
    user_request: "old task",
    openclaw_session: "agent:main:main",
    claude_session: "claude-released",
    executor: { kind: "claude", session: "claude-released" },
    workspace: "/tmp/workspace",
    status: "closed",
    response_rounds_used: 0,
    soft_limit: 8,
    hard_limit: 12,
    created_at: "2026-09-09T00:00:00.000Z",
    updated_at: "2026-09-09T00:01:00.000Z"
  } as Conversation;
  let output: Record<string, unknown> | undefined;
  presentTerminalDispatchReplay({
    owner,
    receipt: {
      replayed: true,
      delivered: true,
      status: "async_pending",
      submission_outcome: "agent_accepted",
      delivery_receipt: "agent_accepted"
    },
    accepted: true,
    acceptanceInvalid: false,
    receiptConversationId: owner.conversation_id,
    receiptMessageId: "message-released",
    callbackExpected: true,
    userExplicit: {
      terminalId: "terminal:v2:tmux:claude:test:0.0:1234",
      messageId: "message-released"
    }
  }, {
    message: {
      id: "message-released",
      conversation_id: owner.conversation_id,
      session_id: owner.session_id,
      turn_id: owner.turn_id,
      from: "openclaw",
      to: "claude-code",
      type: "task",
      body: "old task",
      requires_response: false,
      ts: "2026-09-09T00:00:00.000Z",
      round: 0,
      max_rounds: 12,
      metadata: {}
    } as AgentMessage,
    executor: owner.executor as Executor,
    terminalControl: {
      kind: "tmux",
      target: "test:0.0",
      session: "test",
      window: 0,
      pane: 0,
      panePid: 1234,
      capabilities: ["send_keys", "screen_status"]
    } as TerminalControlRef
  }, {
    write(value) {
      output = value;
    },
    budget() {
      return {};
    },
    nextAction() {
      return { action: "yield" };
    },
    summarize(value) {
      return value;
    }
  });

  assert.ok(output);
  assert.equal(output.callback_expected, false);
  assert.equal(output.observation_mode, "none");
  assert.equal(output.scope, "terminal_user_explicit");
  assert.deepEqual(output.capabilities, {
    callback: false,
    interaction_notify: false,
    interaction_respond: false
  });
  assert.equal(
    (output.openclaw_next_action as Record<string, unknown>).action,
    "inspect"
  );
});
