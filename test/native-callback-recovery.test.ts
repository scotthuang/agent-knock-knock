import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createCallbackEnvelope, createTerminalWatchOpenClawCallbackRoute, type CallbackAttemptOutcome, type CallbackTransportDeliverInput } from "../src/callback-transport.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { createNativeNotificationOutbox, type NativeOutboxDependencies } from "../src/codex-native-outbox.js";
import { createCodexNativeStateStore, type CodexNativeTaskRecord } from "../src/codex-native-state-store.js";
import { codexNativeTaskNeedsReconciliation } from "../src/codex-native-task-service.js";
import { createFileLockCliAdapter } from "../src/file-lock-cli-adapter.js";
import { createOpenClawCallbackTransport, type CallbackSpawnResult } from "../src/openclaw-callback-transport.js";

const id = "codex-cli-watch:isolated-callback-recovery";
const controller = "controller-isolated";
const route = createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: controller });
const target = { codexHome: "/isolated/codex", threadId: "isolated-native-thread" };
const nativeId = createCodexNativeConversationId(target);
const notificationId = `${id}:settled`;
const envelope = createCallbackEnvelope({ route,
  source: { kind: "codex_native_watch", watch_id: id, native_id: nativeId },
  event: { id: notificationId, type: "codex_native_watch.settled", body: "Isolated result", requires_response: false }
});

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = Date.parse("2026-10-11T00:00:00Z");
  const now = () => new Date(time);
  const locks = createFileLockCliAdapter({ now, nowMs: () => time, pid: () => process.pid,
    sleepSync: () => { throw new Error("Unexpected contention inside a synchronous claim"); } });
  const repository = () => createCodexNativeStateStore(dir, locks);
  const task: CodexNativeTaskRecord = { schema: "agent-knock-knock/codex-native-task", version: 1, revision: 1,
    id, watch_id: id, native_id: nativeId, target, controller_session: controller, kind: "watch", status: "completed",
    native_turn_id: "isolated-native-turn", created_at: now().toISOString(), updated_at: now().toISOString(),
    deadline_at: new Date(time + 720 * 60_000).toISOString(), callback_route: route, pending_interactions: [], final_text: "Isolated result",
    notifications: [{ id: notificationId, envelope, attempts: 0, status: "ready" }] };
  repository().withLock(id, () => repository().save(task, null));
  const deps: NativeOutboxDependencies = { repository: repository(), now,
    resolveCallbackContext: () => ({ legacyOptions: { gatewayMethod: "chat.send", openclawSession: controller } }) };
  const fresh = () => createNativeNotificationOutbox({ ...deps, repository: repository() });
  const note = () => repository().load(id)!.notifications[0];
  return { deps, fresh, note, now, advance: (ms: number) => { time += ms; }, task: () => repository().load(id)! };
}

function connectFailure(): CallbackSpawnResult {
  return { status: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: {
    type: "gateway_transport_error", kind: "closed",
    message: "Gateway not reachable at ws://127.0.0.1:18789 (ETIMEDOUT).", reason: "Opening handshake has timed out"
  } }) };
}
function accepted(now: () => Date): CallbackAttemptOutcome {
  return { disposition: "accepted", accepted_at: now().toISOString(), acceptance_id: envelope.idempotency_key };
}
function notDispatched(input: CallbackTransportDeliverInput): CallbackAttemptOutcome {
  return { disposition: "retryable_failure", error_code: "openclaw_callback_not_dispatched", evidence: {
    request_dispatched: false, request_phase: "connection_handshake", attempt_id: input.attempt.id,
    delivery_id: input.envelope.delivery_id, idempotency_key: input.envelope.idempotency_key
  } };
}

test("opening handshake failure retries the same notification after restart, then one concurrent recovery submits it", async t => {
  const h = setup(t);
  let chatAttempts = 0; let acceptedCalls = 0;
  const keys: string[] = [];
  const transport = createOpenClawCallbackTransport({ now: h.now, environment: () => ({}), redactConversation: value => value,
    recordCallbackProcessDelivery: () => {}, spawnSync: (_command, args) => {
      assert.equal(args[2], "chat.send", "pre-dispatch failure needs no ambiguous-acceptance lookup");
      const params = JSON.parse(args[args.indexOf("--params") + 1]) as { idempotencyKey: string };
      keys.push(params.idempotencyKey); chatAttempts++;
      if (chatAttempts === 1) return connectFailure();
      acceptedCalls++;
      return { status: 0, stdout: JSON.stringify({ runId: params.idempotencyKey, status: "started" }), stderr: "" };
    } });
  h.deps.deliver = request => transport.deliver(request);
  await h.fresh().deliverPending(id);
  assert.equal(h.note().status, "retry_wait");
  assert.equal(h.note().outcome?.evidence?.request_dispatched, false);
  assert.equal(h.note().attempts, 1);
  assert.equal(Date.parse(h.note().retry_at!) - h.now().getTime(), 5000);
  await h.fresh().deliverPending(id); assert.equal(chatAttempts, 1);
  h.advance(5000);
  await Promise.all([h.fresh().deliverPending(id), h.fresh().deliverPending(id)]);
  assert.equal(h.note().status, "accepted"); assert.equal(h.note().attempts, 2);
  assert.equal(acceptedCalls, 1); assert.equal(chatAttempts, 2);
  assert.deepEqual(keys, [envelope.idempotency_key, envelope.idempotency_key]);
  assert.deepEqual(h.note().envelope, envelope); assert.equal(h.note().id, notificationId);
  assert.equal(h.note().retry_at, undefined);
  await h.fresh().deliverPending(id); assert.equal(chatAttempts, 2);
  assert.equal(codexNativeTaskNeedsReconciliation(h.task()), false);
});

test("repeated proved pre-dispatch failures exhaust four attempts with 5/10/20-second backoff and no acceptance", async t => {
  const h = setup(t); const attempts: CallbackTransportDeliverInput[] = [];
  h.deps.deliver = request => { attempts.push(request); return notDispatched(request); };
  await h.fresh().deliverPending(id);
  for (const delay of [5000, 10_000, 20_000]) {
    assert.equal(h.note().status, "retry_wait");
    assert.equal(Date.parse(h.note().retry_at!) - h.now().getTime(), delay);
    h.advance(delay - 1); await h.fresh().deliverPending(id);
    const before = attempts.length; h.advance(1); await h.fresh().deliverPending(id);
    assert.equal(attempts.length, before + 1);
  }
  assert.equal(attempts.length, 4); assert.equal(h.note().status, "failed");
  assert.equal(h.note().outcome?.disposition, "retryable_failure");
  assert.equal(h.note().outcome?.evidence?.request_dispatched, false);
  assert.equal(h.note().outcome?.evidence?.retry_budget_exhausted, true);
  assert.equal(h.note().outcome?.evidence?.max_delivery_attempts, 4);
  assert.equal(h.note().retry_at, undefined);
  assert.ok(attempts.every(request => request.envelope.idempotency_key === envelope.idempotency_key));
  h.advance(86_400_000); await Promise.all([h.fresh().deliverPending(id), h.fresh().deliverPending(id)]);
  assert.equal(attempts.length, 4); assert.equal(h.task().status, "completed");
  assert.equal(codexNativeTaskNeedsReconciliation(h.task()), false);
});

test("post-dispatch lost ACK and legacy unknown outcomes stay uncertain across concurrent restoration", async t => {
  for (const evidence of [undefined, { request_dispatched: true, request_phase: "submitted" }]) {
    const h = setup(t); let calls = 0;
    h.deps.deliver = () => { calls++; return { disposition: "uncertain", error_code: "openclaw_callback_acceptance_uncertain", observed_at: h.now().toISOString(), ...(evidence ? { evidence } : {}) }; };
    await h.fresh().deliverPending(id); h.advance(60_000);
    await Promise.all([h.fresh().deliverPending(id), h.fresh().deliverPending(id)]);
    assert.equal(h.task().status, "completed"); assert.equal(h.note().status, "uncertain");
    assert.equal(h.note().attempts, 1); assert.equal(calls, 1);
    assert.equal(h.note().outcome?.disposition, "uncertain");
    assert.equal(codexNativeTaskNeedsReconciliation(h.task()), false);
  }
});

test("same expired attempt may supply exact late pre-dispatch proof without unlocking unknown attempts", async t => {
  const h = setup(t); let calls = 0;
  let request!: CallbackTransportDeliverInput; let finish!: (outcome: CallbackAttemptOutcome) => void;
  h.deps.deliver = input => { calls++; request = input; return new Promise(resolve => { finish = resolve; }); };
  const pending = h.fresh().deliverPending(id);
  assert.equal(h.note().status, "leased");
  h.advance(30_001); await h.fresh().deliverPending(id);
  assert.equal(h.note().status, "uncertain"); assert.equal(calls, 1);
  finish(notDispatched(request)); await pending;
  assert.equal(h.note().status, "retry_wait"); assert.equal(h.note().attempts, 1);
  h.advance(5000); h.deps.deliver = () => { calls++; return accepted(h.now); };
  await Promise.all([h.fresh().deliverPending(id), h.fresh().deliverPending(id)]);
  assert.equal(h.note().status, "accepted"); assert.equal(calls, 2);
});

test("late outcome with missing proof or a different attempt cannot unfreeze an expired lease", async t => {
  for (const corrupt of ["missing", "wrong-attempt", "submitted"] as const) {
    const h = setup(t); let request!: CallbackTransportDeliverInput; let finish!: (outcome: CallbackAttemptOutcome) => void;
    h.deps.deliver = input => { request = input; return new Promise(resolve => { finish = resolve; }); };
    const pending = h.fresh().deliverPending(id); h.advance(30_001); await h.fresh().deliverPending(id);
    const outcome = notDispatched(request);
    if (corrupt === "missing") delete outcome.evidence;
    else if (corrupt === "wrong-attempt") outcome.evidence!.attempt_id = "another-attempt";
    else outcome.evidence!.request_dispatched = true;
    finish(outcome); await pending;
    assert.equal(h.note().status, "uncertain"); assert.equal(h.note().attempts, 1);
  }
});
