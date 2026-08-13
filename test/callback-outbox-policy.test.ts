import test from "node:test";
import assert from "node:assert/strict";
import {
  beginCallbackRetryPolicy,
  callbackDeliveryHasAcceptedTransport,
  reduceCallbackRetryPolicy,
  type CallbackRetryPolicyState
} from "../src/callback-outbox-policy.js";

const LIMITS = {
  attemptLeaseMs: 120_000,
  retryDelayCount: 4
};
const MESSAGE = { id: "callback-message-a" };

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
