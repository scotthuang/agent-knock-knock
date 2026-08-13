import test from "node:test";
import assert from "node:assert/strict";
import {
  createCallbackOutboxSettlement,
  type CallbackOutboxSettlementStatePort,
  type PreparedCallbackDeliveryClaim
} from "../src/callback-outbox-settlement.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import {
  createConversation,
  createMessage,
  type Conversation
} from "../src/protocol.js";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const STATE_PATH = "/store/turn-a/state.json";
const LOG_PATH = "/store/turn-a/events.ndjson";

function createHarness({ accepted = false } = {}) {
  const conversation = createConversation({
    userRequest: "exercise the callback outbox",
    sessionId: "session-a",
    turnId: "turn-a",
    executorKind: "codex",
    now: NOW
  });
  const message = createMessage({
    conversation,
    id: "message-a",
    from: "codex",
    to: "openclaw",
    type: "done",
    body: "complete",
    now: NOW
  });
  let stored: Conversation = {
    ...conversation,
    status: "waiting_for_agent",
    callback_delivery: {
      status: "pending",
      message,
      attempts: 2,
      attempt_id: "attempt-a",
      attempt_pid: 4102,
      ...(accepted
        ? {
            injection: {
              status: "accepted",
              accepted_at: "2026-08-14T11:59:59.000Z"
            }
          }
        : {})
    }
  };
  const order: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const state: CallbackOutboxSettlementStatePort = {
    withStateTransaction(_statePath, operation) {
      order.push("lock:enter");
      try {
        return operation();
      } finally {
        order.push("lock:exit");
      }
    },
    load() {
      order.push("load");
      return stored;
    },
    save(_statePath, conversationToSave) {
      order.push("save");
      stored = conversationToSave;
    },
    append(_logPath, event) {
      order.push(`append:${String(event.event)}`);
      events.push(event);
    }
  };
  const service = createCallbackOutboxSettlement({
    state,
    retryMonitor: {
      start() {
        order.push("retry-monitor:start");
        return { pid: 5102 };
      }
    },
    attemptLeaseMs: 120_000,
    retryDelaysMs: [5_000, 15_000, 60_000, 60_000]
  });
  const prepared: PreparedCallbackDeliveryClaim = {
    options: {},
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    message,
    deliveryAttempt: 2,
    deliveryAttemptId: "attempt-a"
  };
  return {
    service,
    prepared,
    order,
    events,
    stored: () => stored
  };
}

async function withFixedClock(operation: () => void): Promise<void> {
  await runCliCommandExecution("callback-settlement-test", {}, {
    now: () => NOW,
    runtimeLog: () => {}
  }, async () => {
    operation();
  });
}

test("callback progress preserves lock, save, then event order", async () => {
  const harness = createHarness();
  await withFixedClock(() => {
    harness.service.persistDeliveryProgress(harness.prepared, {
      stage: "injection_accepted",
      injection: { status: "accepted" }
    });
  });

  assert.deepEqual(harness.order, [
    "lock:enter",
    "load",
    "save",
    "append:callback_delivery_stage_updated",
    "lock:exit"
  ]);
  assert.equal(
    (harness.stored().callback_delivery as Record<string, unknown>)
      .attempt_lease_expires_at,
    "2026-08-14T12:02:00.000Z"
  );
});

test("accepted transport settles durably without launching a retry", async () => {
  const harness = createHarness({ accepted: true });
  await withFixedClock(() => {
    harness.service.settleDelivery(harness.prepared, {
      delivered: false,
      error: new Error("observation failed after acceptance")
    });
  });

  assert.deepEqual(harness.order, [
    "lock:enter",
    "load",
    "save",
    "append:callback_delivery_succeeded",
    "lock:exit"
  ]);
  const delivery = harness.stored().callback_delivery as Record<string, unknown>;
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.accepted_at, "2026-08-14T11:59:59.000Z");
  assert.equal(harness.events[0].accepted_evidence_recovery, true);
});

test("successful delivery persists delivery evidence before its event", async () => {
  const harness = createHarness();
  await withFixedClock(() => {
    harness.service.settleDelivery(harness.prepared, {
      delivered: true,
      delivery: {
        kind: "gateway_method",
        injection: { status: "accepted" },
        wake: { status: "ok" },
        run_observation: { status: "ok" }
      }
    });
  });

  assert.deepEqual(harness.order, [
    "lock:enter",
    "load",
    "save",
    "append:callback_delivery_succeeded",
    "lock:exit"
  ]);
  const delivery = harness.stored().callback_delivery as Record<string, unknown>;
  assert.equal(delivery.status, "delivered");
  assert.deepEqual(delivery.wake, { status: "ok" });
});

test("changed claims append only a skipped-settlement event", async () => {
  const harness = createHarness();
  harness.prepared.deliveryAttemptId = "stale-attempt";
  await withFixedClock(() => {
    const settled = harness.service.settleDelivery(harness.prepared, {
      delivered: true
    });
    assert.strictEqual(settled, harness.stored());
  });

  assert.deepEqual(harness.order, [
    "lock:enter",
    "load",
    "append:callback_delivery_settle_skipped",
    "lock:exit"
  ]);
  assert.equal(
    (harness.stored().callback_delivery as Record<string, unknown>).status,
    "pending"
  );
});

test("failed delivery launches retry before durable failure settlement", async () => {
  const harness = createHarness();
  await withFixedClock(() => {
    harness.service.settleDelivery(harness.prepared, {
      delivered: false,
      error: new Error("gateway unavailable")
    });
  });

  assert.deepEqual(harness.order, [
    "lock:enter",
    "load",
    "retry-monitor:start",
    "save",
    "append:callback_delivery_failed",
    "append:callback_retry_monitor_launched",
    "lock:exit"
  ]);
  const delivery = harness.stored().callback_delivery as Record<string, unknown>;
  assert.equal(delivery.status, "failed");
  assert.equal(delivery.last_error, "gateway unavailable");
  assert.equal(delivery.retry_monitor_pid, 5102);
  assert.equal(delivery.next_attempt_at, "2026-08-14T12:00:15.000Z");
});

test("accepted recovery distinguishes caller-held and service-held locks", async () => {
  const callerHeld = createHarness({ accepted: true });
  await withFixedClock(() => {
    callerHeld.service.settleAcceptedWhileLocked({
      conversation: callerHeld.stored(),
      statePath: STATE_PATH,
      logPath: LOG_PATH,
      expectedMessageId: "message-a",
      reason: "caller_already_holds_lock"
    });
  });
  assert.deepEqual(callerHeld.order, [
    "save",
    "append:callback_delivery_succeeded"
  ]);

  const serviceHeld = createHarness({ accepted: true });
  await withFixedClock(() => {
    serviceHeld.service.settleAccepted({
      statePath: STATE_PATH,
      logPath: LOG_PATH,
      expectedMessageId: "message-a",
      reason: "service_acquires_lock"
    });
  });
  assert.deepEqual(serviceHeld.order, [
    "lock:enter",
    "load",
    "save",
    "append:callback_delivery_succeeded",
    "lock:exit"
  ]);
});
