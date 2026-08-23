import test from "node:test";
import assert from "node:assert/strict";
import {
  createCallbackOutboxService,
  resolveCallbackGatewayRoute,
  type CallbackOutboxServicePorts
} from "../src/callback-outbox-service.js";
import {
  createConversation,
  createMessage,
  type Conversation
} from "../src/protocol.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";
import { supersedeUnacceptedCallbackDeliveries } from
  "../src/callback-outbox-policy.js";
import { callbackRouteFingerprint } from
  "../src/callback-route-authority.js";
import {
  CALLBACK_ENVELOPE_SCHEMA,
  CALLBACK_ROUTE_SCHEMA,
  createLegacyOpenClawCallbackRoute,
  type CallbackRouteV1
} from "../src/callback-transport.js";

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
const GENERIC_ROUTE: CallbackRouteV1 = {
  schema: CALLBACK_ROUTE_SCHEMA,
  version: 1,
  transport: "local_ipc_v1",
  profile_id: "desktop-controller",
  profile_revision: "revision-a",
  controller_session_id: "controller-a",
  capabilities: { wake: true, respond: true }
};

test("callback route keeps its gateway URL independent of token rotation", () => {
  assert.deepEqual(resolveCallbackGatewayRoute({
    gatewayUrl: "ws://127.0.0.1:18789"
  }), {
    gatewayUrl: "ws://127.0.0.1:18789",
    token: undefined
  });
  assert.deepEqual(resolveCallbackGatewayRoute(
    { gatewayUrl: "ws://persisted.example" },
    { token: "rotated-private-token" }
  ), {
    gatewayUrl: "ws://persisted.example",
    token: "rotated-private-token"
  });
});

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
  const retryMonitors: Array<Record<string, unknown>> = [];
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
      withWriter(_statePath, operation) {
        order.push("writer:acquire");
        try {
          return operation();
        } finally {
          order.push("writer:release");
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
      resolveCompletionDispatch() {
        order.push("resolve:completion-dispatch");
        return true;
      }
    },
    retry: {
      isProcessAlive() {
        dispositionCalls += 1;
        return false;
      },
      startMonitor(input) {
        order.push("start:retry-monitor");
        retryMonitors.push({ ...input });
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
    }
  };
  return {
    conversation,
    order,
    ports,
    service: createCallbackOutboxService(ports),
    stored: () => stored,
    retryMonitors,
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
    "log:callback_duplicate"
  ]);
  assert.strictEqual(harness.stored(), harness.conversation);
});

test("released callback rejection follows binding and short-circuits persistence", () => {
  const harness = createHarness();
  (harness.conversation as Conversation).status = "idle";
  assert.throws(() => harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(callbackMessage(harness.conversation)),
      preserveMessageId: true
    },
    logPath: LOG_PATH
  }), /refusing late callback .* for released Turn .* \(idle\)/u);
  assert.deepEqual(harness.order, [
    "load",
    "derive:store-dir",
    "assert:no-deferred",
    "read-events",
    "assert:binding"
  ]);
});

test("supersede recovery admits only the dedicated callback status policy", () => {
  const run = (status: Conversation["status"]) => {
    const harness = createHarness();
    (harness.conversation as Conversation).status = status;
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
      allowSupersedeRecovery: true,
      completion: {
        source: "screen",
        text: "Finished.",
        timestamp: NOW.toISOString()
      }
    });
    return { harness, result };
  };

  const superseded = run("waiting_for_openclaw");
  assert.equal(superseded.result.claimed, true);
  const legacyCallback = run("callback_pending");
  assert.deepEqual(legacyCallback.result, {
    claimed: false,
    conversation: legacyCallback.harness.conversation,
    reason: "conversation_no_longer_waiting"
  });
  assert.deepEqual(legacyCallback.harness.order, ["acquire", "load", "release"]);
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

test("close supersedes a prepared callback before transport starts", () => {
  const harness = createHarness();
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(callbackMessage(harness.conversation)),
      preserveMessageId: true
    },
    logPath: LOG_PATH
  });
  assert.equal(prepared.outcome, "deliver");
  if (prepared.outcome !== "deliver") return;
  harness.ports.state.save(STATE_PATH, supersedeUnacceptedCallbackDeliveries(
    harness.stored(),
    { at: NOW.toISOString(), reason: "user_abandoned_management" }
  ));
  let transports = 0;
  harness.ports.delivery.deliver = () => {
    transports += 1;
    throw new Error("superseded delivery must not start transport");
  };

  const result = harness.service.runPrepared(prepared);

  assert.equal(result.delivered, false);
  assert.equal(result.duplicate, true);
  assert.equal(transports, 0);
  assert.equal(
    (harness.stored().callback_delivery as Record<string, unknown>).status,
    "superseded"
  );
});

test("transport-start wins only the external send and close still supersedes settlement", () => {
  const harness = createHarness();
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(callbackMessage(harness.conversation)),
      preserveMessageId: true
    },
    logPath: LOG_PATH
  });
  assert.equal(prepared.outcome, "deliver");
  if (prepared.outcome !== "deliver") return;
  let transports = 0;
  harness.ports.delivery.deliver = () => {
    transports += 1;
    const started = harness.stored().callback_delivery as
      Record<string, unknown>;
    assert.equal(started.transport_started_at, NOW.toISOString());
    assert.equal(started.transport_started_lane, "lifecycle");
    assert.equal(started.transport_started_attempt, prepared.deliveryAttempt);
    assert.equal(started.transport_started_attempt_id,
      prepared.deliveryAttemptId);
    assert.equal(started.transport_started_pid, 3102);
    harness.ports.state.save(STATE_PATH, supersedeUnacceptedCallbackDeliveries(
      harness.stored(),
      { at: NOW.toISOString(), reason: "user_abandoned_management" }
    ));
    return {
      kind: "local_ipc_v1",
      injection: { status: "accepted", accepted_at: NOW.toISOString() },
      wake: { status: "accepted", accepted_at: NOW.toISOString() },
      attempt_outcome: {
        disposition: "accepted",
        accepted_at: NOW.toISOString(),
        acceptance_id: "accepted-after-management-release"
      }
    };
  };

  const result = harness.service.runPrepared(prepared);

  assert.equal(transports, 1);
  assert.equal(result.delivered, true);
  const delivery = harness.stored().callback_delivery as
    Record<string, unknown>;
  assert.equal(delivery.status, "superseded");
  assert.equal(delivery.transport_started_attempt_id,
    prepared.deliveryAttemptId);
  assert.ok(harness.order.includes("append:callback_delivery_settle_skipped"));
  assert.equal(harness.retryMonitors.length, 1);
});

test("prepared transport fails closed on a partial start marker", () => {
  const harness = createHarness();
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(callbackMessage(harness.conversation)),
      preserveMessageId: true
    },
    logPath: LOG_PATH
  });
  assert.equal(prepared.outcome, "deliver");
  if (prepared.outcome !== "deliver") return;
  const delivery = harness.stored().callback_delivery as
    Record<string, unknown>;
  harness.ports.state.save(STATE_PATH, {
    ...harness.stored(),
    callback_delivery: { ...delivery, transport_started_at: NOW.toISOString() }
  });
  let transports = 0;
  harness.ports.delivery.deliver = () => {
    transports += 1;
    throw new Error("malformed start authority must not deliver");
  };

  assert.throws(
    () => harness.service.runPrepared(prepared),
    /callback transport-start authority is invalid/u
  );
  assert.equal(transports, 0);
});

test("abandonment intent fences prepared transport before marker or delivery", () => {
  const harness = createHarness();
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(callbackMessage(harness.conversation)),
      preserveMessageId: true
    },
    logPath: LOG_PATH
  });
  assert.equal(prepared.outcome, "deliver");
  if (prepared.outcome !== "deliver") return;
  const before = JSON.stringify(harness.stored());
  harness.ports.authority.assertNoDeferredTransfer = () => {
    throw new Error("linked transfer is user_abandoning");
  };
  let transports = 0;
  harness.ports.delivery.deliver = () => {
    transports += 1;
    throw new Error("abandonment intent must fence transport");
  };

  assert.throws(
    () => harness.service.runPrepared(prepared),
    /linked transfer is user_abandoning/u
  );
  assert.equal(transports, 0);
  assert.equal(JSON.stringify(harness.stored()), before);
  assert.equal(
    (harness.stored().callback_delivery as Record<string, unknown>)
      .transport_started_at,
    undefined
  );
});

test("crash after transport-start leaves a durable uncertain no-retry claim", () => {
  const harness = createHarness();
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(callbackMessage(harness.conversation)),
      preserveMessageId: true
    },
    logPath: LOG_PATH
  });
  assert.equal(prepared.outcome, "deliver");
  if (prepared.outcome !== "deliver") return;
  harness.ports.runtime.crashCheckpoint = (name) => {
    if (name === "after_callback_transport_started") {
      throw new Error("simulated callback process crash");
    }
  };
  let transports = 0;
  harness.ports.delivery.deliver = () => {
    transports += 1;
    throw new Error("crash checkpoint must precede transport");
  };

  assert.throws(
    () => harness.service.runPrepared(prepared),
    /simulated callback process crash/u
  );
  assert.equal(transports, 0);
  const delivery = harness.stored().callback_delivery as
    Record<string, unknown>;
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.transport_started_attempt_id,
    prepared.deliveryAttemptId);
  assert.deepEqual(harness.service.retryDisposition(delivery), {
    state: "uncertain",
    attempt: 1,
    reason: "callback_transport_started_without_final_outcome"
  });
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

test("stall notification preparation uses an independent advisory outbox", () => {
  const harness = createHarness();
  Object.assign(harness.conversation as Conversation, {
    status: "stalled",
    callback_route: GENERIC_ROUTE,
    callback_delivery: {
      status: "pending",
      message: callbackMessage(harness.conversation),
      attempts: 1
    }
  });
  const lifecycleDelivery = (harness.conversation as Conversation)
    .callback_delivery;
  const message = createMessage({
    conversation: harness.conversation,
    id: "stall-message-a",
    from: "codex",
    to: "openclaw",
    type: "error",
    requiresResponse: false,
    body: "The managed terminal task stalled.",
    now: NOW
  });

  const result = harness.service.prepareStallNotification({
    options: { statePath: STATE_PATH },
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    conversation: {
      ...harness.conversation,
      stalled_notification_message_id: message.id
    },
    message
  });

  assert.ok(result.prepared);
  assert.equal(result.prepared.outcome, "deliver");
  if (result.prepared.outcome !== "deliver") return;
  assert.equal(result.prepared.callbackOutboxLane, "notification");
  assert.equal(result.prepared.conversation.status, "stalled");
  assert.strictEqual(
    result.prepared.conversation.callback_delivery,
    lifecycleDelivery
  );
  assert.equal(
    result.prepared.conversation.stalled_notification_sent_at,
    undefined
  );
  const advisory = result.prepared.conversation
    .callback_notification_delivery as Record<string, unknown>;
  assert.equal(advisory.status, "pending");
  assert.equal(advisory.kind, "stall_notification");
  assert.deepEqual(advisory.message, message);
  assert.deepEqual(advisory.callback_route, GENERIC_ROUTE);
  assert.deepEqual(harness.order, [
    "derive:store-dir",
    "assert:no-deferred",
    "read-events",
    "assert:binding",
    "start:retry-monitor",
    "append:message",
    "append:callback_notification_delivery_pending",
    "append:callback_notification_retry_monitor_launched",
    "save",
    "log:callback_received"
  ]);
});

test("accepted stall notification settles sent evidence without changing Turn phase", () => {
  const harness = createHarness();
  Object.assign(harness.conversation as Conversation, {
    status: "stalled",
    callback_route: GENERIC_ROUTE
  });
  const message = createMessage({
    conversation: harness.conversation,
    id: "stall-message-accepted",
    from: "codex",
    to: "openclaw",
    type: "error",
    requiresResponse: false,
    body: "The managed terminal task stalled.",
    now: NOW
  });
  const preparation = harness.service.prepareStallNotification({
    options: { statePath: STATE_PATH },
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    conversation: {
      ...harness.conversation,
      stalled_notification_message_id: message.id
    },
    message
  });
  assert.ok(preparation.prepared);
  if (!preparation.prepared || preparation.prepared.outcome !== "deliver") {
    return;
  }
  harness.ports.delivery.deliver = () => ({
    kind: "local_ipc_v1",
    injection: { status: "accepted", accepted_at: NOW.toISOString() },
    wake: { status: "accepted", accepted_at: NOW.toISOString() },
    attempt_outcome: {
      disposition: "accepted",
      accepted_at: NOW.toISOString(),
      acceptance_id: "acceptance-stall-a"
    }
  });

  const result = harness.service.runPrepared(preparation.prepared);

  assert.equal(result.delivered, true);
  assert.equal(result.conversation.status, "stalled");
  assert.equal(
    result.conversation.stalled_notification_sent_at,
    NOW.toISOString()
  );
  assert.equal(
    result.conversation.stalled_notification_message_id,
    message.id
  );
  assert.equal(
    (result.conversation.callback_notification_delivery as
      Record<string, unknown>).status,
    "delivered"
  );
});

test("startup reconciliation restarts only the notification lane", () => {
  const harness = createHarness();
  const message = createMessage({
    conversation: harness.conversation,
    id: "stall-message-reconcile",
    from: "codex",
    to: "openclaw",
    type: "error",
    requiresResponse: false,
    body: "The managed terminal task stalled.",
    now: NOW
  });
  const lifecycleDelivery = {
    status: "delivered",
    attempts: 1,
    message: callbackMessage(harness.conversation)
  };
  Object.assign(harness.conversation as Conversation, {
    status: "stalled",
    callback_route: GENERIC_ROUTE,
    callback_delivery: lifecycleDelivery,
    callback_notification_delivery: {
      status: "failed",
      attempts: 1,
      message,
      attempt_outcome: {
        disposition: "retryable_failure",
        error_code: "temporarily_unavailable"
      }
    }
  });

  const result = harness.service.reconcileDelivery({
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    delayMs: 7_000,
    callbackOutboxLane: "notification"
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, "launched");
  assert.equal(result.reason,
    "callback_notification_delivery_reconciliation");
  assert.deepEqual(harness.retryMonitors, [{
    statePath: STATE_PATH,
    delayMs: 7_000,
    callbackOutboxLane: "notification"
  }]);
  assert.strictEqual(harness.stored().callback_delivery, lifecycleDelivery);
  const advisory = harness.stored().callback_notification_delivery as
    Record<string, unknown>;
  assert.equal(advisory.retry_monitor_pid, 4102);
  assert.equal(advisory.next_attempt_at, "2026-08-14T12:00:07.000Z");
});

test("notification retry reuses its durable payload and settles acceptance", () => {
  const harness = createHarness();
  Object.assign(harness.conversation as Conversation, {
    status: "stalled",
    callback_route: GENERIC_ROUTE,
    callback_delivery: {
      status: "delivered",
      attempts: 1,
      message: callbackMessage(harness.conversation)
    }
  });
  const message = createMessage({
    conversation: harness.conversation,
    id: "stall-message-retry",
    from: "codex",
    to: "openclaw",
    type: "error",
    requiresResponse: false,
    body: "The managed terminal task stalled.",
    now: NOW
  });
  const preparation = harness.service.prepareStallNotification({
    options: { statePath: STATE_PATH },
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    conversation: {
      ...harness.conversation,
      stalled_notification_message_id: message.id
    },
    message
  });
  assert.ok(preparation.prepared);
  if (!preparation.prepared || preparation.prepared.outcome !== "deliver") {
    return;
  }
  harness.ports.delivery.deliver = () => ({
    kind: "local_ipc_v1",
    injection: { status: "failed" },
    wake: { status: "not_attempted" },
    attempt_outcome: {
      disposition: "retryable_failure",
      error_code: "temporarily_unavailable"
    }
  });
  assert.throws(
    () => harness.service.runPrepared(preparation.prepared),
    /temporarily_unavailable/u
  );
  assert.equal(
    (harness.stored().callback_notification_delivery as
      Record<string, unknown>).status,
    "failed"
  );
  assert.equal(harness.stored().stalled_notification_sent_at, undefined);

  let retriedMessageId: string | undefined;
  harness.ports.delivery.deliver = (input) => {
    retriedMessageId = input.message.id;
    assert.equal(input.attempt.number, 2);
    return {
      kind: "local_ipc_v1",
      injection: { status: "accepted", accepted_at: NOW.toISOString() },
      wake: { status: "accepted", accepted_at: NOW.toISOString() },
      attempt_outcome: {
        disposition: "accepted",
        accepted_at: NOW.toISOString(),
        acceptance_id: "notification-retry-accepted"
      }
    };
  };
  harness.ports.delivery.runTransaction = (options) => {
    const prepared = harness.service.prepare({ options, logPath: LOG_PATH });
    return harness.service.runPrepared(prepared);
  };

  harness.service.runRetryMonitor({
    statePath: STATE_PATH,
    initialDelayMs: 0,
    callbackOutboxLane: "notification"
  });

  assert.equal(retriedMessageId, message.id);
  assert.equal(harness.stored().status, "stalled");
  assert.equal(
    (harness.stored().callback_notification_delivery as
      Record<string, unknown>).status,
    "delivered"
  );
  assert.equal(
    harness.stored().stalled_notification_sent_at,
    NOW.toISOString()
  );
  assert.equal(
    (harness.stored().callback_delivery as Record<string, unknown>).status,
    "delivered"
  );
});

test("generic callback-only preparation persists an immutable route and envelope", () => {
  const harness = createHarness();
  const message = callbackMessage(harness.conversation);
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(message),
      preserveMessageId: true,
      callbackRoute: GENERIC_ROUTE
    },
    logPath: LOG_PATH
  });

  assert.equal(prepared.outcome, "deliver");
  if (prepared.outcome !== "deliver") return;
  assert.deepEqual(prepared.callbackRoute, GENERIC_ROUTE);
  const delivery = harness.stored().callback_delivery as Record<string, unknown>;
  assert.deepEqual(delivery.callback_route, GENERIC_ROUTE);
  const envelope = delivery.callback_envelope as Record<string, unknown>;
  assert.equal(envelope.schema, CALLBACK_ENVELOPE_SCHEMA);
  assert.deepEqual(envelope.route, {
    transport: GENERIC_ROUTE.transport,
    profile_id: GENERIC_ROUTE.profile_id,
    profile_revision: GENERIC_ROUTE.profile_revision,
    controller_session_id: GENERIC_ROUTE.controller_session_id
  });
  assert.deepEqual(envelope.source, {
    kind: "managed_turn",
    session_id: "session-a",
    turn_id: "turn-a",
    conversation_id: "turn-a"
  });
  assert.equal(JSON.stringify(delivery).includes("token"), false);
});

test("fresh raw callback backfills trusted legacy options from its immutable Turn", () => {
  const harness = createHarness();
  const legacy = {
    gateway_method: "agent-knock-knock.callback",
    gateway_session: "agent:main:controller",
    openclaw_session: "agent:main:controller",
    openclaw_bin: "/trusted/bin/openclaw",
    gateway_url: "ws://127.0.0.1:18789"
  };
  Object.assign(harness.conversation as Conversation, {
    ...legacy,
    callback_route: createLegacyOpenClawCallbackRoute({
      controllerSessionId: legacy.gateway_session,
      gatewayMethod: legacy.gateway_method,
      openclawBin: legacy.openclaw_bin,
      gatewayUrl: legacy.gateway_url
    })
  });
  const prepared = harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(callbackMessage(harness.conversation)),
      preserveMessageId: true
    },
    logPath: LOG_PATH
  });

  assert.equal(prepared.outcome, "deliver");
  if (prepared.outcome !== "deliver") return;
  assert.equal(prepared.options.gatewayMethod, legacy.gateway_method);
  assert.equal(prepared.options.gatewaySession, legacy.gateway_session);
  assert.equal(prepared.options.openclawSession, legacy.openclaw_session);
  assert.equal(prepared.options.openclawBin, legacy.openclaw_bin);
  assert.equal(prepared.options.gatewayUrl, legacy.gateway_url);
  assert.deepEqual(
    prepared.options.callbackRoute,
    (harness.conversation as Conversation).callback_route
  );
});

test("legacy raw callback route uses the same Turn fallbacks as delivery options", () => {
  for (const supplied of [
    { gatewayMethod: "agent-knock-knock.callback" },
    {
      gatewayMethod: "agent-knock-knock.callback",
      gatewaySession: "agent:main:controller",
      openclawBin: "/trusted/bin/openclaw"
    }
  ]) {
    const harness = createHarness();
    const legacy = {
      gateway_method: "agent-knock-knock.callback",
      gateway_session: "agent:main:controller",
      openclaw_session: "agent:main:legacy-fallback",
      openclaw_bin: "/trusted/bin/openclaw",
      gateway_url: "ws://configured.example:18789"
    };
    Object.assign(harness.conversation as Conversation, legacy);
    assert.equal(
      Object.hasOwn(harness.conversation as Conversation, "callback_route"),
      false
    );
    const prepared = harness.service.prepare({
      options: {
        statePath: STATE_PATH,
        messageJson: JSON.stringify(callbackMessage(harness.conversation)),
        preserveMessageId: true,
        ...supplied
      },
      logPath: LOG_PATH
    });

    assert.equal(prepared.outcome, "deliver");
    if (prepared.outcome !== "deliver") continue;
    const expectedRoute = createLegacyOpenClawCallbackRoute({
      controllerSessionId: legacy.gateway_session,
      gatewayMethod: legacy.gateway_method,
      openclawBin: legacy.openclaw_bin,
      gatewayUrl: legacy.gateway_url
    });
    assert.deepEqual(prepared.callbackRoute, expectedRoute);
    assert.deepEqual(prepared.options.callbackRoute, expectedRoute);
    assert.equal(prepared.options.gatewaySession, legacy.gateway_session);
    assert.equal(prepared.options.gatewayUrl, legacy.gateway_url);
  }
});

test("first outbox prepare rejects dispatch route drift before persistence", () => {
  const changedRoute: CallbackRouteV1 = {
    ...GENERIC_ROUTE,
    profile_revision: "revision-b",
    controller_session_id: "controller-b"
  };
  for (const currentRoute of [changedRoute, GENERIC_ROUTE] as const) {
    const harness = createHarness();
    (harness.conversation as Conversation).callback_route = currentRoute;
    (harness.conversation as Conversation).native_session_takeover = {
      terminal_bridge_submission: {
        callback_route_fingerprint: currentRoute === GENERIC_ROUTE
          ? null
          : callbackRouteFingerprint(GENERIC_ROUTE)
      }
    };

    assert.throws(() => harness.service.prepare({
      options: {
        statePath: STATE_PATH,
        messageJson: JSON.stringify(callbackMessage(harness.conversation)),
        preserveMessageId: true
      },
      logPath: LOG_PATH
    }), /conflicts with immutable terminal dispatch authority/u);
    assert.equal(harness.order.includes("save"), false);
    assert.equal(harness.order.includes("append:message"), false);
    assert.equal(harness.order.includes("start:retry-monitor"), false);
  }
});

test("matching and legacy-missing dispatch route authority remain compatible", () => {
  for (const authority of [
    callbackRouteFingerprint(GENERIC_ROUTE),
    undefined
  ]) {
    const harness = createHarness();
    (harness.conversation as Conversation).callback_route = GENERIC_ROUTE;
    (harness.conversation as Conversation).native_session_takeover = {
      terminal_bridge_submission: {
        ...(authority !== undefined
          ? { callback_route_fingerprint: authority }
          : {})
      }
    };

    const prepared = harness.service.prepare({
      options: {
        statePath: STATE_PATH,
        messageJson: JSON.stringify(callbackMessage(harness.conversation)),
        preserveMessageId: true
      },
      logPath: LOG_PATH
    });
    assert.equal(prepared.outcome, "deliver");
  }
});

test("malformed generic route never falls back to legacy OpenClaw fields", () => {
  const harness = createHarness();
  Object.assign(harness.conversation as Conversation, {
    callback_route: { ...GENERIC_ROUTE, version: 99 },
    gateway_method: "agent-knock-knock.callback"
  });
  assert.throws(() => harness.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(callbackMessage(harness.conversation)),
      preserveMessageId: true
    },
    logPath: LOG_PATH
  }), /unsupported callback_route version 99/u);
});

test("persisted generic and legacy routes beat changed current routing", () => {
  const changedOptionsRoute: CallbackRouteV1 = {
    ...GENERIC_ROUTE,
    profile_revision: "changed-options",
    controller_session_id: "changed-options-controller"
  };
  const changedConversationRoute: CallbackRouteV1 = {
    ...GENERIC_ROUTE,
    profile_revision: "changed-conversation",
    controller_session_id: "changed-conversation-controller"
  };

  const generic = createHarness();
  const genericMessage = callbackMessage(generic.conversation);
  (generic.conversation as Conversation).callback_route =
    changedConversationRoute;
  (generic.conversation as Conversation).callback_delivery = {
    status: "failed",
    message: genericMessage,
    attempts: 1,
    callback_route: GENERIC_ROUTE
  };
  const genericPrepared = generic.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(genericMessage),
      preserveMessageId: true,
      retryPending: true,
      callbackRoute: changedOptionsRoute
    },
    logPath: LOG_PATH
  });
  assert.equal(genericPrepared.outcome, "deliver");
  if (genericPrepared.outcome !== "deliver") return;
  assert.deepEqual(genericPrepared.callbackRoute, GENERIC_ROUTE);
  assert.deepEqual(genericPrepared.options.callbackRoute, GENERIC_ROUTE);

  const legacy = createHarness();
  const legacyMessage = callbackMessage(legacy.conversation);
  (legacy.conversation as Conversation).callback_route =
    changedConversationRoute;
  (legacy.conversation as Conversation).callback_delivery = {
    status: "failed",
    message: legacyMessage,
    attempts: 1,
    gateway_method: "persisted.callback",
    gateway_session: "persisted-controller",
    openclaw_bin: "/persisted/openclaw",
    gateway_url: "ws://persisted.invalid"
  };
  const legacyPrepared = legacy.service.prepare({
    options: {
      statePath: STATE_PATH,
      messageJson: JSON.stringify(legacyMessage),
      preserveMessageId: true,
      retryPending: true,
      callbackRoute: changedOptionsRoute,
      gatewayMethod: "changed.callback",
      gatewaySession: "changed-controller",
      openclawBin: "/changed/openclaw",
      gatewayUrl: "ws://changed.invalid"
    },
    logPath: LOG_PATH
  });
  assert.equal(legacyPrepared.outcome, "deliver");
  if (legacyPrepared.outcome !== "deliver") return;
  assert.deepEqual(legacyPrepared.callbackRoute,
    createLegacyOpenClawCallbackRoute({
      controllerSessionId: "persisted-controller",
      gatewayMethod: "persisted.callback",
      openclawBin: "/persisted/openclaw",
      gatewayUrl: "ws://persisted.invalid"
    })
  );
  assert.equal(legacyPrepared.options.gatewayMethod, "persisted.callback");
  assert.equal(legacyPrepared.options.gatewaySession, "persisted-controller");
  assert.equal(legacyPrepared.options.openclawBin, "/persisted/openclaw");
  assert.equal(legacyPrepared.options.gatewayUrl, "ws://persisted.invalid");
});
