import test from "node:test";
import assert from "node:assert/strict";
import {
  createDurableNotificationLease,
  decideDurableNotificationRetry,
  reduceDurableNotificationSettlement
} from "../src/durable-notification-kernel.js";

const NOW = "2026-08-21T00:00:00.000Z";

test("durable notification lease is Store-neutral and monotonic", () => {
  assert.deepEqual(createDurableNotificationLease({
    previousAttempts: 2,
    attemptId: "attempt-3",
    attemptedAt: NOW,
    leaseBaseMs: Date.parse(NOW),
    leaseMs: 30_000
  }), {
    attempt: 3,
    attemptId: "attempt-3",
    attemptedAt: NOW,
    leaseExpiresAt: "2026-08-21T00:00:30.000Z"
  });
});

test("durable notification retry preserves lease and schedule boundaries", () => {
  assert.deepEqual(decideDurableNotificationRetry({
    phase: "leased",
    attempt: 1,
    nowMs: Date.parse(NOW),
    leaseExpiresAt: "2026-08-21T00:00:01.000Z"
  }), {
    state: "in_flight",
    attempt: 1,
    lease_expires_at: "2026-08-21T00:00:01.000Z"
  });
  assert.deepEqual(decideDurableNotificationRetry({
    phase: "leased",
    attempt: 1,
    nowMs: Date.parse("2026-08-21T00:00:01.000Z"),
    leaseExpiresAt: "2026-08-21T00:00:01.000Z"
  }), { state: "retryable", attempt: 1 });
  assert.deepEqual(decideDurableNotificationRetry({
    phase: "retry_wait",
    attempt: 2,
    nowMs: Date.parse(NOW),
    retryAt: "2026-08-21T00:00:01.000Z",
    retryAuthorized: true
  }), {
    state: "waiting",
    attempt: 2,
    retry_at: "2026-08-21T00:00:01.000Z"
  });
  assert.deepEqual(decideDurableNotificationRetry({
    phase: "retry_wait",
    attempt: 2,
    nowMs: Date.parse(NOW),
    retryAt: "2026-08-21T00:00:01.000Z",
    retryAuthorized: false
  }), { state: "non_retryable", attempt: 2 });
  assert.deepEqual(decideDurableNotificationRetry({
    phase: "ready",
    attempt: 5,
    maxAttempts: 4
  }), { state: "exhausted", attempt: 5 });
});

test("durable notification settlement centralizes retry authorization", () => {
  assert.deepEqual(reduceDurableNotificationSettlement({
    attempt: 2,
    outcome: {
      disposition: "accepted",
      accepted_at: NOW,
      acceptance_id: "accepted-2"
    },
    retryEnabled: true,
    maxRetryAttempts: 4
  }), {
    state: "accepted",
    outcome: {
      disposition: "accepted",
      accepted_at: NOW,
      acceptance_id: "accepted-2"
    }
  });
  assert.deepEqual(reduceDurableNotificationSettlement({
    attempt: 2,
    outcome: {
      disposition: "retryable_failure",
      error_code: "transport_failed"
    },
    retryEnabled: true,
    maxRetryAttempts: 4
  }), {
    state: "failed",
    outcome: {
      disposition: "retryable_failure",
      error_code: "transport_failed"
    },
    retryAuthorized: true
  });
  const uncertain = {
    disposition: "uncertain" as const,
    error_code: "acceptance_observation_lost",
    observed_at: NOW
  };
  assert.deepEqual(reduceDurableNotificationSettlement({
    attempt: 2,
    outcome: uncertain,
    retryEnabled: true,
    supersede: true
  }), { state: "superseded", outcome: uncertain });
});
