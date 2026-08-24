import test from "node:test";
import assert from "node:assert/strict";
import {
  beginCallbackRetryPolicy,
  callbackDeliveryHasAcceptedTransport,
  classifyCallbackProcessFailure,
  reduceCallbackRetryPolicy,
  supersedeCallbackNotificationDelivery,
  supersedeUnacceptedCallbackDeliveries,
  type CallbackRetryPolicyState
} from "../src/callback-outbox-policy.js";
import { createConversation, type Conversation } from "../src/protocol.js";
import {
  CALLBACK_ENVELOPE_SCHEMA,
  CALLBACK_ROUTE_SCHEMA,
  createCallbackEnvelope,
  createLegacyOpenClawCallbackRoute,
  parseCallbackAttemptOutcome,
  resolveCallbackRoute,
  type CallbackRouteV1
} from "../src/callback-transport.js";

const LIMITS = {
  attemptLeaseMs: 120_000,
  retryDelayCount: 4
};
const MESSAGE = { id: "callback-message-a" };
const NOW_ISO = "2026-08-14T12:00:00.000Z";

function disposition(state: CallbackRetryPolicyState) {
  assert.equal(state.phase, "decided");
  return state.disposition;
}

test("durable callback evidence decides without requesting runtime observations", () => {
  const cases = [
    {
      delivery: undefined,
      expected: {
        state: "unavailable",
        attempt: 0,
        reason: "no pending or failed callback outbox is available"
      }
    },
    {
      delivery: { status: "pending", attempts: 0, message: MESSAGE },
      expected: {
        state: "unavailable",
        attempt: 0,
        reason: "callback outbox has invalid attempt metadata"
      }
    },
    {
      delivery: {
        status: "pending",
        attempts: 0,
        message: MESSAGE,
        injection: { status: "accepted" }
      },
      expected: { state: "accepted", attempt: 0 }
    },
    {
      delivery: { status: "pending", attempts: 5, message: MESSAGE },
      expected: { state: "exhausted", attempt: 5 }
    },
    {
      delivery: { status: "failed", attempts: 2, message: MESSAGE },
      expected: { state: "retryable", attempt: 2 }
    },
    {
      delivery: { status: "pending", attempts: 2, message: MESSAGE },
      expected: { state: "retryable", attempt: 2 }
    }
  ] as const;

  for (const { delivery, expected } of cases) {
    assert.deepEqual(
      disposition(beginCallbackRetryPolicy(delivery, LIMITS)),
      expected
    );
  }
});

test("pending callback observes process before clock and retains a live lease", () => {
  const initial = beginCallbackRetryPolicy({
    status: "pending",
    attempts: 2,
    message: MESSAGE,
    attempt_pid: 4123,
    attempt_lease_expires_at: "2026-08-14T12:02:00.000Z",
    next_attempt_at: "2026-08-14T12:03:00.000Z"
  }, LIMITS);
  assert.deepEqual(initial, {
    phase: "observe_process",
    attempt: 2,
    attempt_pid: 4123,
    effective_lease_expires_at_ms: Date.parse("2026-08-14T12:02:00.000Z"),
    persisted_lease_expires_at: "2026-08-14T12:02:00.000Z",
    next_attempt_at: "2026-08-14T12:03:00.000Z"
  });

  const live = reduceCallbackRetryPolicy(initial, {
    kind: "process_alive",
    alive: true
  });
  assert.equal(live.phase, "observe_clock");
  assert.deepEqual(
    disposition(reduceCallbackRetryPolicy(live, {
      kind: "clock",
      now_ms: Date.parse("2026-08-14T12:01:00.000Z")
    })),
    {
      state: "in_flight",
      attempt: 2,
      attempt_pid: 4123,
      lease_expires_at: "2026-08-14T12:02:00.000Z",
      next_attempt_at: "2026-08-14T12:03:00.000Z"
    }
  );
});

test("dead process and missing lease stop before a clock observation", () => {
  const withLease = beginCallbackRetryPolicy({
    status: "pending",
    attempts: 1,
    message: MESSAGE,
    attempt_pid: 4123,
    attempt_lease_expires_at: "2026-08-14T12:02:00.000Z"
  }, LIMITS);
  assert.deepEqual(
    disposition(reduceCallbackRetryPolicy(withLease, {
      kind: "process_alive",
      alive: false
    })),
    { state: "retryable", attempt: 1 }
  );

  const withoutLease = beginCallbackRetryPolicy({
    status: "pending",
    attempts: 1,
    message: MESSAGE,
    attempt_pid: 4123
  }, LIMITS);
  assert.deepEqual(
    disposition(reduceCallbackRetryPolicy(withoutLease, {
      kind: "process_alive",
      alive: true
    })),
    { state: "retryable", attempt: 1 }
  );
});

test("legacy attempt timestamp synthesizes the historical lease deadline", () => {
  const initial = beginCallbackRetryPolicy({
    status: "pending",
    attempts: 1,
    message: MESSAGE,
    attempt_pid: 4123,
    last_attempt_at: "2026-08-14T12:00:00.000Z"
  }, LIMITS);
  const live = reduceCallbackRetryPolicy(initial, {
    kind: "process_alive",
    alive: true
  });
  assert.deepEqual(
    disposition(reduceCallbackRetryPolicy(live, {
      kind: "clock",
      now_ms: Date.parse("2026-08-14T12:01:00.000Z")
    })),
    {
      state: "in_flight",
      attempt: 1,
      attempt_pid: 4123,
      lease_expires_at: "2026-08-14T12:02:00.000Z",
      next_attempt_at: undefined
    }
  );
});

test("policy rejects observations supplied out of phase", () => {
  const initial = beginCallbackRetryPolicy({
    status: "pending",
    attempts: 1,
    message: MESSAGE,
    attempt_pid: 4123,
    attempt_lease_expires_at: "2026-08-14T12:02:00.000Z"
  }, LIMITS);
  assert.throws(
    () => reduceCallbackRetryPolicy(initial, { kind: "clock", now_ms: 0 }),
    /requires a process observation/u
  );
  const decided = beginCallbackRetryPolicy({
    status: "failed",
    attempts: 1,
    message: MESSAGE
  }, LIMITS);
  assert.throws(
    () => reduceCallbackRetryPolicy(decided, {
      kind: "process_alive",
      alive: false
    }),
    /already decided/u
  );
});

test("accepted transport detection keeps injection and wake parity", () => {
  assert.equal(callbackDeliveryHasAcceptedTransport({
    injection: { status: "accepted" }
  }), true);
  assert.equal(callbackDeliveryHasAcceptedTransport({
    wake: { status: "accepted" }
  }), true);
  assert.equal(callbackDeliveryHasAcceptedTransport({
    injection: { status: "failed" },
    wake: { status: "pending" }
  }), false);
});

test("callback process failure classification preserves canonical priority", () => {
  const cases = [
    [{ status: 0 }, undefined],
    [{
      status: 1,
      stderr: "Error running remote compact task: stream disconnected at " +
        "/codex/responses/compact; internal error"
    }, "transient_remote_compact_failure"],
    [{ status: 1, stdout: "Agent needs reconnect" }, "agent_reconnect_required"],
    [{
      status: 1,
      error: { message: "Permission denied outside workspace sandbox" }
    }, "permission_denied"],
    [{ status: 1, stderr: "sandbox rejected this operation" }, "sandbox_denied"],
    [{ status: 1, stdout: "request timed out" }, "timeout"],
    [{ status: 7, stderr: "unclassified failure" }, "nonzero_exit"],
    [{ status: 0, stderr: "warning only" }, undefined]
  ] as const;

  for (const [observation, expected] of cases) {
    assert.equal(classifyCallbackProcessFailure(observation), expected);
  }
});

test("host-neutral callback contract is versioned, deterministic, and secretless", () => {
  const legacyInput = {
    controllerSessionId: "controller-a",
    gatewayMethod: "agent-knock-knock.callback",
    openclawBin: "/opt/openclaw",
    gatewayUrl: "ws://127.0.0.1:18789"
  };
  const route = createLegacyOpenClawCallbackRoute(legacyInput);
  const routeWithIgnoredSecret = createLegacyOpenClawCallbackRoute({
    ...legacyInput,
    token: "must-not-be-persisted"
  } as typeof legacyInput);
  assert.equal(route.schema, CALLBACK_ROUTE_SCHEMA);
  assert.deepEqual(routeWithIgnoredSecret, route);
  assert.equal(JSON.stringify(route).includes("must-not-be-persisted"), false);

  const envelopeInput = {
    route,
    source: {
      kind: "managed_turn" as const,
      session_id: "session-a",
      turn_id: "turn-a",
      conversation_id: "turn-a"
    },
    event: {
      id: "message-a",
      type: "done",
      body: "complete",
      requires_response: false
    }
  };
  const first = createCallbackEnvelope(envelopeInput);
  const second = createCallbackEnvelope(envelopeInput);
  assert.equal(first.schema, CALLBACK_ENVELOPE_SCHEMA);
  assert.deepEqual(second, first);
  assert.match(first.delivery_id, /^callback-delivery-[a-f0-9]{64}$/u);
  assert.match(first.idempotency_key, /^agent-knock-knock:[a-f0-9]{64}$/u);
  for (const event of [
    { ...envelopeInput.event, id: "message-b" },
    { ...envelopeInput.event, type: "error" },
    { ...envelopeInput.event, body: "different completion" },
    { ...envelopeInput.event, metadata: { reason: "different" } }
  ]) {
    const changed = createCallbackEnvelope({ ...envelopeInput, event });
    assert.notEqual(changed.delivery_id, first.delivery_id);
    assert.notEqual(changed.idempotency_key, first.idempotency_key);
  }
});

test("generic callback routes are authoritative and fail closed", () => {
  const genericRoute: CallbackRouteV1 = {
    schema: CALLBACK_ROUTE_SCHEMA,
    version: 1,
    transport: "local_ipc_v1",
    profile_id: "desktop-controller",
    profile_revision: "sha256:abc",
    controller_session_id: "controller-a"
  };
  assert.deepEqual(resolveCallbackRoute(
    { callbackRoute: genericRoute },
    {
      legacyOpenClaw: {
        controllerSessionId: "legacy-controller",
        gatewayMethod: "agent-knock-knock.callback"
      }
    }
  ), genericRoute);
  assert.throws(() => resolveCallbackRoute(
    { callbackRoute: { ...genericRoute, version: 99 } },
    {
      legacyOpenClaw: {
        controllerSessionId: "legacy-controller",
        gatewayMethod: "agent-knock-knock.callback"
      }
    }
  ), /unsupported callback_route version 99/u);
  assert.throws(
    () => resolveCallbackRoute({ callbackRoute: undefined }),
    /callback_route must be an object/u
  );
  assert.throws(() => createLegacyOpenClawCallbackRoute({
    controllerSessionId: "legacy-controller"
  }), /legacy OpenClaw gateway method/u);
});

test("generic attempt outcomes make retry safety explicit", () => {
  const cases = [
    {
      outcome: {
        disposition: "accepted",
        accepted_at: NOW_ISO,
        acceptance_id: "delivery-a"
      },
      expected: { state: "accepted", attempt: 2 }
    },
    {
      outcome: {
        disposition: "retryable_failure",
        error_code: "temporarily_unavailable"
      },
      expected: { state: "retryable", attempt: 2 }
    },
    {
      outcome: {
        disposition: "permanent_failure",
        error_code: "profile_not_authorized"
      },
      expected: {
        state: "permanent_failure",
        attempt: 2,
        reason: "profile_not_authorized"
      }
    },
    {
      outcome: {
        disposition: "uncertain",
        error_code: "acceptance_observation_lost",
        observed_at: NOW_ISO
      },
      expected: {
        state: "uncertain",
        attempt: 2,
        reason: "acceptance_observation_lost"
      }
    }
  ] as const;
  for (const entry of cases) {
    assert.deepEqual(
      disposition(beginCallbackRetryPolicy({
        status: "failed",
        attempts: 2,
        message: MESSAGE,
        attempt_outcome: entry.outcome
      }, LIMITS)),
      entry.expected
    );
    assert.deepEqual(parseCallbackAttemptOutcome(entry.outcome), entry.outcome);
  }
  assert.equal(callbackDeliveryHasAcceptedTransport({
    attempt_outcome: cases[0].outcome
  }), true);
  assert.deepEqual(
    disposition(beginCallbackRetryPolicy({
      status: "failed",
      attempts: 2,
      message: MESSAGE,
      attempt_outcome: { disposition: "uncertain" },
      injection: { status: "accepted" }
    }, LIMITS)),
    {
      state: "unavailable",
      attempt: 2,
      reason: "callback outbox has invalid attempt outcome: " +
        "callback error_code must be a non-empty string"
    }
  );
});

test("lifecycle changes supersede only unaccepted notification deliveries", () => {
  const conversation = createConversation({
    userRequest: "exercise advisory supersede",
    sessionId: "session-a",
    turnId: "turn-a",
    executorKind: "codex",
    now: new Date(NOW_ISO)
  });
  const pending: Conversation = {
    ...conversation,
    callback_notification_delivery: {
      status: "pending",
      attempts: 1,
      attempt_pid: 4102,
      attempt_lease_expires_at: "2026-08-14T12:02:00.000Z",
      retry_monitor_pid: 4103,
      next_attempt_at: "2026-08-14T12:03:00.000Z",
      message: MESSAGE
    }
  };

  const superseded = supersedeCallbackNotificationDelivery(pending, {
    at: NOW_ISO,
    reason: "superseded_by_terminal_monitor_renewal"
  });
  const delivery = superseded.callback_notification_delivery as
    Record<string, unknown>;
  assert.equal(delivery.status, "superseded");
  assert.equal(delivery.superseded_at, NOW_ISO);
  assert.equal(delivery.superseded_reason,
    "superseded_by_terminal_monitor_renewal");
  assert.equal(delivery.attempt_pid, undefined);
  assert.equal(delivery.retry_monitor_pid, undefined);

  const accepted: Conversation = {
    ...pending,
    callback_notification_delivery: {
      ...(pending.callback_notification_delivery as Record<string, unknown>),
      attempt_outcome: {
        disposition: "accepted",
        accepted_at: NOW_ISO,
        acceptance_id: "accepted-a"
      }
    }
  };
  assert.strictEqual(
    supersedeCallbackNotificationDelivery(accepted, {
      at: NOW_ISO,
      reason: "superseded_by_conversation_close"
    }),
    accepted
  );
});

test("explicit Close supersedes both unaccepted callback lanes", () => {
  const conversation = createConversation({
    userRequest: "exercise explicit close",
    sessionId: "session-a",
    turnId: "turn-a",
    executorKind: "codex",
    now: new Date(NOW_ISO)
  });
  const pending = {
    status: "pending",
    attempts: 1,
    attempt_pid: 4102,
    message: MESSAGE,
    transport_started_at: NOW_ISO
  };
  const closed = supersedeUnacceptedCallbackDeliveries({
    ...conversation,
    callback_delivery: pending,
    callback_notification_delivery: { ...pending }
  }, {
    at: NOW_ISO,
    reason: "superseded_by_conversation_close"
  });

  for (const field of [
    "callback_delivery",
    "callback_notification_delivery"
  ] as const) {
    const delivery = closed[field] as Record<string, unknown>;
    assert.equal(delivery.status, "superseded");
    assert.equal(delivery.transport_started_at, NOW_ISO);
    assert.equal(delivery.attempt_pid, undefined);
  }
});

test("transport-started callback reports a live attempt but never becomes retryable", () => {
  const live = beginCallbackRetryPolicy({
    status: "pending",
    attempts: 1,
    attempt_pid: 4102,
    attempt_lease_expires_at: "2026-08-14T12:02:00.000Z",
    message: MESSAGE,
    transport_started_at: NOW_ISO
  }, LIMITS);
  assert.equal(live.phase, "observe_process");
  if (live.phase !== "observe_process") return;
  const clock = reduceCallbackRetryPolicy(live, {
    kind: "process_alive",
    alive: true
  });
  assert.equal(clock.phase, "observe_clock");
  if (clock.phase !== "observe_clock") return;
  assert.deepEqual(disposition(reduceCallbackRetryPolicy(clock, {
    kind: "clock",
    now_ms: Date.parse("2026-08-14T12:01:00.000Z")
  })), {
    state: "in_flight",
    attempt: 1,
    attempt_pid: 4102,
    lease_expires_at: "2026-08-14T12:02:00.000Z",
    next_attempt_at: undefined
  });

  const expiredLive = beginCallbackRetryPolicy({
    status: "pending",
    attempts: 1,
    attempt_pid: 4102,
    attempt_lease_expires_at: "2026-08-14T12:02:00.000Z",
    message: MESSAGE,
    transport_started_at: NOW_ISO
  }, LIMITS);
  assert.equal(expiredLive.phase, "observe_process");
  if (expiredLive.phase !== "observe_process") return;
  const expiredClock = reduceCallbackRetryPolicy(expiredLive, {
    kind: "process_alive",
    alive: true
  });
  assert.equal(expiredClock.phase, "observe_clock");
  if (expiredClock.phase !== "observe_clock") return;
  assert.deepEqual(disposition(reduceCallbackRetryPolicy(expiredClock, {
    kind: "clock",
    now_ms: Date.parse("2026-08-14T12:03:00.000Z")
  })), {
    state: "uncertain",
    attempt: 1,
    reason: "callback transport started without a durable final outcome"
  });

  const orphaned = beginCallbackRetryPolicy({
    status: "pending",
    attempts: 1,
    attempt_pid: 999999,
    message: MESSAGE,
    transport_started_at: NOW_ISO
  }, LIMITS);
  assert.equal(orphaned.phase, "observe_process");
  if (orphaned.phase !== "observe_process") return;
  assert.deepEqual(disposition(reduceCallbackRetryPolicy(orphaned, {
    kind: "process_alive",
    alive: false
  })), {
    state: "uncertain",
    attempt: 1,
    reason: "callback transport started without a durable final outcome"
  });
});
