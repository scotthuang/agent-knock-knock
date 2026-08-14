import test from "node:test";
import assert from "node:assert/strict";
import {
  createCallbackOutboxService,
  type CallbackOutboxServicePorts
} from "../src/callback-outbox-service.js";
import {
  createConversation,
  createMessage,
  type Conversation
} from "../src/protocol.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const STATE_PATH = "/store/turn-a/state.json";
const LOG_PATH = "/store/turn-a/events.ndjson";
const TERMINAL_CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "%11",
  session: "akk",
  window: 1,
  pane: 1,
  panePid: 5102,
  capabilities: ["screen_completion", "durable_completion"]
};

function createHarness(events: Array<Record<string, unknown>> = []) {
  const conversation = {
    ...createConversation({
      userRequest: "exercise callback preparation",
      sessionId: "session-a",
      turnId: "turn-a",
      executorKind: "codex",
      now: NOW
    }),
    status: "waiting_for_agent" as const
  };
  let stored: Conversation = conversation;
  const order: string[] = [];
  let dispositionCalls = 0;
  const ports: CallbackOutboxServicePorts = {
    state: {
      load() {
        order.push("load");
        return stored;
      },
      save(_statePath, next) {
        order.push("save");
        stored = next;
      },
      readEvents() {
        order.push("read-events");
        return events;
      },
      append(_logPath, event) {
        order.push(`append:${String(event.event)}`);
      },
      appendMessage() {
        order.push("append:message");
      },
      assertWriterCompatible() {
        order.push("assert:writer-compatible");
      },
      withTransaction(_statePath, operation) {
        order.push("acquire");
        try {
          return operation();
        } finally {
          order.push("release");
        }
      },
      storeDirForStatePath(statePath) {
        order.push("derive:store-dir");
        return statePath.startsWith("/other/") ? "/other" : "/store";
      },
      logPathForStatePath: () => LOG_PATH
    },
    authority: {
      assertNoDeferredTransfer() {
        order.push("assert:no-deferred");
      },
      assertBindingCurrent() {
        order.push("assert:binding");
      },
      isDispatchReleased() {
        order.push("observe:released");
        return false;
      },
      isWaitingForAgent(status) {
        return status === "waiting_for_agent";
      },
      isTerminalBridgeSupersedeStatus() {
        return false;
      }
    },
    retry: {
      isProcessAlive() {
        dispositionCalls += 1;
        return false;
      },
      startMonitor() {
        order.push("start:retry-monitor");
        return { pid: 4102 };
      },
      attemptLeaseMs: 120_000,
      delaysMs: [5_000, 15_000, 60_000, 60_000]
    },
    runtime: {
      now: () => NOW,
      nowMs: () => NOW.getTime(),
      pid: () => 3102,
      log(_level, event) {
        order.push(`log:${event}`);
      },
      textSummary: (value) => value,
      sleepSync() {},
      crashCheckpoint() {
        order.push("crash-checkpoint");
      }
    },
    delivery: {
      deliver() {
        throw new Error("delivery is not expected in preparation tests");
      },
      runTransaction() {
        throw new Error("nested transaction is not expected in preparation tests");
      }
    },
    terminal: {
      resolveCompletionDispatch() {
        order.push("resolve:completion-dispatch");
        return true;
      }
    }
  };
  return {
    conversation,
    order,
    ports,
    service: createCallbackOutboxService(ports),
    stored: () => stored,
    dispositionCalls: () => dispositionCalls
  };
}

function callbackMessage(conversation: Conversation) {
  return createMessage({
    conversation,
    id: "message-a",
    from: "codex",
    to: "openclaw",
    type: "done",
    body: "complete",
    now: NOW
  });
}

test("fresh callback preparation preserves watchdog, event, state, and log order", () => {
  const harness = createHarness();
  const message = callbackMessage(harness.conversation);
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(message),
      preserveMessageId: true,
      gatewayMethod: "agent-knock-knock.callback"
    },
    logPath: LOG_PATH
  });

  assert.equal(prepared.outcome, "deliver");
  assert.deepEqual(harness.order, [
    "load",
    "derive:store-dir",
    "assert:no-deferred",
    "read-events",
    "assert:binding",
    "observe:released",
    "start:retry-monitor",
    "append:message",
    "append:callback_delivery_pending",
    "append:callback_retry_monitor_launched",
    "save",
    "log:callback_received"
  ]);
  const delivery = harness.stored().callback_delivery as Record<string, unknown>;
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.attempt_pid, 3102);
  assert.equal(delivery.retry_monitor_pid, 4102);
  assert.equal(delivery.attempt_lease_expires_at, "2026-08-14T12:02:00.000Z");
});

test("duplicate callback logs without mutating its durable outbox", () => {
  const initial = createHarness();
  const message = callbackMessage(initial.conversation);
  const harness = createHarness([{
    event: "message",
    message
  }]);
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(message),
      preserveMessageId: true
    },
    logPath: LOG_PATH
  });

  assert.equal(prepared.outcome, "duplicate");
  assert.deepEqual(harness.order, [
    "load",
    "derive:store-dir",
    "assert:no-deferred",
    "read-events",
    "assert:binding",
    "observe:released",
    "log:callback_duplicate"
  ]);
  assert.strictEqual(harness.stored(), harness.conversation);
});

test("callback preparation validates its message before state path derivation", () => {
  const harness = createHarness();

  assert.throws(() => harness.service.prepare({
    options: { statePath: STATE_PATH },
    logPath: LOG_PATH
  }), /--message-json is required/u);
  assert.deepEqual(harness.order, []);
});

test("prepared delivery derives writer authority from its current state path", () => {
  const harness = createHarness();
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(callbackMessage(harness.conversation)),
      preserveMessageId: true,
      gatewayMethod: "agent-knock-knock.callback"
    },
    logPath: LOG_PATH
  });
  assert.equal(prepared.outcome, "deliver");
  if (prepared.outcome !== "deliver") {
    return;
  }

  prepared.statePath = "/other/turn-a/state.json";
  let assertedStoreDir: string | undefined;
  harness.ports.state.assertWriterCompatible = (storeDir) => {
    assertedStoreDir = storeDir;
    throw new Error("stop after writer authority check");
  };
  assert.throws(
    () => harness.service.runPrepared(prepared),
    /stop after writer authority check/u
  );
  assert.equal(assertedStoreDir, "/other");
});

test("non-retryable requests preserve the two fresh disposition observations", () => {
  const harness = createHarness();
  const message = callbackMessage(harness.conversation);
  (harness.conversation as Conversation).callback_delivery = {
    status: "pending",
    message,
    attempts: 1,
    attempt_pid: 4102,
    attempt_lease_expires_at: "2026-08-14T12:02:00.000Z"
  };
  let dispositionCalls = 0;
  harness.ports.retry.isProcessAlive = () => {
    dispositionCalls += 1;
    return true;
  };

  assert.throws(() => harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(message),
      retryPending: true
    },
    logPath: LOG_PATH
  }), /callback attempt 1 is already in flight \(pid 4102\)/u);
  assert.equal(dispositionCalls, 2);
});

test("terminal completion holds the state claim through outbox preparation", () => {
  const harness = createHarness();
  (harness.conversation as Conversation).native_session_takeover = {
    terminal_bridge_message_id: "terminal-message-a"
  };

  const result = harness.service.prepareTerminalCompletion({
    options: { statePath: STATE_PATH },
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    conversationId: harness.conversation.conversation_id,
    actor: "codex",
    terminalControl: TERMINAL_CONTROL,
    terminalMessageId: "terminal-message-a",
    completion: {
      source: "durable",
      outcome: "success",
      id: "completion-a",
      text: "Finished exactly once.",
      timestamp: NOW.toISOString(),
      confidence: "high",
      metadata: { match: "exact_bound_rollout" }
    }
  });

  assert.equal(result.claimed, true);
  assert.equal(result.prepared.outcome, "record_only");
  assert.deepEqual(harness.order, [
    "acquire",
    "load",
    "save",
    "append:terminal_bridge_completion_claimed",
    "append:terminal_bridge_completion_detected",
    "load",
    "derive:store-dir",
    "assert:no-deferred",
    "read-events",
    "assert:binding",
    "observe:released",
    "append:message",
    "save",
    "log:callback_received",
    "log:callback_recorded_only",
    "crash-checkpoint",
    "release",
    "resolve:completion-dispatch"
  ]);
});

test("terminal completion claim conflict releases without preparing an outbox", () => {
  const harness = createHarness();
  (harness.conversation as Conversation).native_session_takeover = {
    terminal_bridge_message_id: "terminal-message-a",
    terminal_bridge_completion_claim: {
      terminal_bridge_message_id: "terminal-message-a",
      completion_fingerprint: "different",
      callback_message_id: "different",
      outcome: "success",
      claimed_at: NOW.toISOString()
    }
  };

  const result = harness.service.prepareTerminalCompletion({
    options: { statePath: STATE_PATH },
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    conversationId: harness.conversation.conversation_id,
    actor: "codex",
    terminalControl: TERMINAL_CONTROL,
    terminalMessageId: "terminal-message-a",
    completion: {
      source: "screen",
      text: "Finished.",
      timestamp: NOW.toISOString()
    }
  });

  assert.deepEqual(result, {
    claimed: false,
    conversation: harness.conversation,
    reason: "terminal_bridge_completion_claim_conflict"
  });
  assert.deepEqual(harness.order, ["acquire", "load", "release"]);
});

test("approval preparation reuses its persisted callback identity", () => {
  const harness = createHarness();
  Object.assign(harness.conversation as Conversation, {
    gateway_method: "agent-knock-knock.callback",
    native_session_takeover: {
      terminal_bridge_approval: {
        callback_message_id: "approval-message-a",
        callback_message_ts: "2026-08-14T11:58:00.000Z"
      }
    }
  });

  const result = harness.service.prepareApprovalNotification({
    options: { statePath: STATE_PATH },
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    conversation: harness.conversation,
    actor: "codex",
    type: "question",
    body: "Approve this request?",
    metadata: { source: "terminal_bridge" }
  });

  assert.equal(result.callbackMessage.id, "approval-message-a");
  assert.equal(result.callbackMessage.ts, "2026-08-14T11:58:00.000Z");
  assert.ok(result.prepared);
  assert.equal(result.prepared.outcome, "deliver");
  assert.deepEqual(harness.order, [
    "derive:store-dir",
    "assert:no-deferred",
    "read-events",
    "assert:binding",
    "observe:released",
    "start:retry-monitor",
    "append:message",
    "append:callback_delivery_pending",
    "append:callback_retry_monitor_launched",
    "save",
    "log:callback_received"
  ]);
  const delivery = harness.stored().callback_delivery as Record<string, unknown>;
  assert.equal(delivery.kind, "approval_notification");
  assert.deepEqual(delivery.message, result.callbackMessage);
});

test("approval without a gateway keeps the stable message out of the outbox", () => {
  const harness = createHarness();
  Object.assign(harness.conversation as Conversation, {
    native_session_takeover: {
      terminal_bridge_approval: {
        callback_message_id: "approval-message-a",
        callback_message_ts: "2026-08-14T11:58:00.000Z"
      }
    }
  });

  const result = harness.service.prepareApprovalNotification({
    options: { statePath: STATE_PATH },
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    conversation: harness.conversation,
    actor: "codex",
    type: "blocked",
    body: "Resolve this request in the terminal.",
    metadata: { source: "terminal_bridge" }
  });

  assert.equal(result.delivered, false);
  assert.equal(result.callbackMessage.id, "approval-message-a");
  assert.deepEqual(harness.order, []);
  assert.strictEqual(harness.stored(), harness.conversation);
});
