import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBackendRecoveryFields, assertBackendRecoveryUpdate, backendCallbackMaxAttempts,
  backendTaskRecoveryProjection, closeBackendManagement, prepareBackendCallbackRetry,
  stopBackendObservation, type BackendRecoveryTask
} from "../src/backend-task-recovery.js";

const now = new Date("2026-10-10T01:00:00Z");
const owner = { controllerSession: "test-controller" };
function record(kind: "send" | "watch" = "send"): BackendRecoveryTask {
  return { id: "exact-task", kind, status: "watching", controller_session: owner.controllerSession,
    deadline_at: "2026-10-10T02:00:00Z", notifications: [] };
}

test("stopping observation preserves management while closing requires a managed send", () => {
  const task = record(); stopBackendObservation(task, now);
  let shown = backendTaskRecoveryProjection(task);
  assert.equal(shown.management_state, "managed");
  assert.equal(shown.observation_state, "stopped");
  assert.equal(task.status, "watching", "neither operation fabricates a native task result");
  closeBackendManagement(task, owner, now);
  shown = backendTaskRecoveryProjection(task);
  assert.equal(shown.management_state, "closed");
  assert.equal(shown.recovery_actions.renew, undefined);
  assert.equal(shown.recovery_actions.recover, undefined);
  assert.throws(() => closeBackendManagement(record("watch"), owner, now), { code: "backend_watch_not_managed" });
  assert.throws(() => closeBackendManagement(record(), { controllerSession: "other" }, now), { code: "backend_controller_mismatch" });
});

test("manual retry preserves attempt history, selects exact notification and grants one exhausted attempt", () => {
  const task = record(); task.status = "completed";
  task.notifications = ["one", "two"].map(id => ({ id, attempts: 4, status: "failed",
    outcome: { disposition: "retryable_failure", error_code: "host_unavailable" } }));
  assert.throws(() => prepareBackendCallbackRetry(task, owner, now), { code: "backend_callback_not_retryable" });
  assert.equal(prepareBackendCallbackRetry(task, { ...owner, notificationId: "two" }, now), "two");
  assert.equal(task.notifications[0].status, "failed");
  assert.equal(task.notifications[1].attempts, 4);
  assert.equal(backendCallbackMaxAttempts(task.notifications[1], 4), 5);
  assert.throws(() => prepareBackendCallbackRetry(task, { ...owner, notificationId: "two" }, now), { code: "backend_callback_not_retryable" });
  for (const status of ["accepted", "uncertain", "leased"]) {
    task.notifications[0].status = status;
    assert.throws(() => prepareBackendCallbackRetry(task, { ...owner, notificationId: "one" }, now), { code: "backend_callback_not_retryable" });
  }
});

test("stopping withdraws unsent notifications but cannot recall an in-flight callback", () => {
  const task = record();
  task.notifications = ["ready", "retry_wait", "leased", "accepted"].map((status, index) => ({ id: String(index), attempts: index, status }));
  closeBackendManagement(task, owner, now);
  assert.deepEqual(task.notifications.map(n => n.status), ["failed", "failed", "leased", "accepted"]);
  assert.equal(backendTaskRecoveryProjection(task).callback_in_flight, true);
  assert.throws(() => prepareBackendCallbackRetry(task, { ...owner, notificationId: "0" }, now), { code: "backend_observation_stopped" });
});

test("persisted recovery cannot reopen closed management or silently replace a renewal deadline", () => {
  const task = record(); assertBackendRecoveryFields(task);
  assert.throws(() => assertBackendRecoveryUpdate(task, { ...task, deadline_at: "2026-10-10T03:00:00Z" }), /explicit monotonic renewal/);
  const renewed = { ...task, deadline_at: "2026-10-10T03:00:00Z", renewal_count: 1, renewed_at: now.toISOString() };
  assertBackendRecoveryFields(renewed); assertBackendRecoveryUpdate(task, renewed);
  assert.throws(() => assertBackendRecoveryUpdate(renewed, task), /generation/);
  closeBackendManagement(task, owner, now);
  assert.throws(() => assertBackendRecoveryUpdate(task, record()), /cannot be reopened/);
});
