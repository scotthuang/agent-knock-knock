import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createTerminalWatchOpenClawCallbackRoute, type CallbackAttemptOutcome, type CallbackTransportDeliverInput } from "../src/callback-transport.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import { createDesktopTaskService, desktopTaskNeedsReconciliation, type DesktopTaskServiceDependencies } from "../src/desktop-task-service.js";
import { DesktopIpcError, type DesktopSnapshot, type DesktopTurn } from "../src/desktop-types.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";

const target = { codexHome: "/test/codex", hostId: "local", threadId: "thread-exact" };
const input = { target, desktopId: createDesktopConversationId(target), controllerSession: "controller-one", messageId: "message-one", text: "Do the exact task" };
const route = createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: input.controllerSession });
function turn(id: string, status: DesktopTurn["status"] = "inProgress", clientId?: string, text = input.text): DesktopTurn {
  return { turnId: id, status, itemsComplete: true,
    items: clientId ? [{ id: `user-${id}`, type: "userMessage", clientId, content: [{ type: "text", text }] }] : [] };
}
function snapshot(turns: DesktopTurn[] = [], extra: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return { threadId: target.threadId, ownerClientId: "owner-one", revision: 1,
    runtimeStatus: turns.some(t => t.status === "inProgress") ? "active" : "idle",
    pendingRequests: [], pendingRequestCount: 0, unconfirmedSubmissionCount: 0,
    tailKnown: true, latestTurnId: turns.at(-1)?.turnId ?? null, turns,
    canSend: !turns.some(t => t.status === "inProgress"), ...extra };
}
function harness(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repository = createDesktopStateStore(dir, { acquire: () => () => {} });
  const state = { now: Date.parse("2026-10-09T00:00:00Z"), snapshot: snapshot(), starts: 0, observes: 0,
    clientId: "", notifications: [] as CallbackTransportDeliverInput[], outcomes: [] as CallbackAttemptOutcome[], sequence: 0 };
  const deps: DesktopTaskServiceDependencies = {
    repository, now: () => new Date(state.now), randomUUID: () => `00000000-0000-0000-0000-${String(++state.sequence).padStart(12, "0")}`,
    observe: async () => { state.observes++; return structuredClone(state.snapshot); },
    start: async (_identity, options) => {
      assert.equal(repository.list().length, 1, "intent persisted before native mutation");
      await options.beforeDispatch?.(state.snapshot);
      state.starts++; state.clientId = options.clientUserMessageId;
      state.snapshot = snapshot([turn("native-one", "inProgress", state.clientId)]);
      return { turnId: "native-one", clientUserMessageId: state.clientId, revision: 2, atomicIdlePrecondition: false };
    },
    deliver: async delivery => {
      state.notifications.push(delivery);
      return state.outcomes.shift() ?? { disposition: "accepted", accepted_at: new Date(state.now).toISOString(), acceptance_id: "callback-one" };
    }
  };
  return { dir, repository, state, deps, service: createDesktopTaskService(deps) };
}

test("Desktop send persists its intent, binds exact native turn, and never replays a message ID", async t => {
  const h = harness(t);
  const sent = await h.service.send(input);
  assert.match(sent.watch_id, /^desktop-watch:/);
  assert.equal(sent.status, "watching"); assert.equal(sent.native_turn_id, "native-one");
  assert.equal(sent.send_intent?.state, "accepted");
  const restarted = createDesktopTaskService(h.deps);
  assert.equal((await restarted.send(input)).id, sent.id);
  assert.equal(h.state.starts, 1);
  await assert.rejects(restarted.send({ ...input, text: "Different work" }), { code: "desktop_message_id_conflict" });
  await assert.rejects(restarted.send({ ...input, target: { ...target, threadId: "other-thread" } }), { code: "desktop_message_id_conflict" });
  assert.equal(h.state.starts, 1);
});

test("concurrent duplicate send calls share one durable reservation", async t => {
  const h = harness(t);
  const [one, two] = await Promise.all([h.service.send(input), createDesktopTaskService(h.deps).send(input)]);
  assert.equal(one.id, two.id); assert.equal(h.state.starts, 1); assert.equal(h.repository.list().length, 1);
});

test("distinct concurrent sends cannot both reserve the same idle Desktop target", async t => {
  const h = harness(t);
  let release!: () => void; let dispatched!: () => void;
  const releaseStart = new Promise<void>(resolve => { release = resolve; });
  const startPending = new Promise<void>(resolve => { dispatched = resolve; });
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++; dispatched();
    await releaseStart;
    h.state.snapshot = snapshot([turn("native-one", "inProgress", options.clientUserMessageId)]);
    return { turnId: "native-one", clientUserMessageId: options.clientUserMessageId, revision: 2, atomicIdlePrecondition: false };
  };
  const sending = createDesktopTaskService(h.deps).send(input);
  await startPending;
  await assert.rejects(createDesktopTaskService(h.deps).send({ ...input, messageId: "second-message" }), { code: "desktop_send_pending" });
  release();
  assert.equal((await sending).status, "watching"); assert.equal(h.state.starts, 1);
});

test("first follower revision growth permits send but changed owner or pending input does not", async t => {
  const h = harness(t);
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.({ ...h.state.snapshot, revision: 2 }); h.state.starts++;
    h.state.snapshot = snapshot([turn("native-one", "inProgress", options.clientUserMessageId)], { revision: 3 });
    return { turnId: "native-one", clientUserMessageId: options.clientUserMessageId, revision: 2, atomicIdlePrecondition: false };
  };
  assert.equal((await createDesktopTaskService(h.deps).send(input)).status, "watching");
  h.state.snapshot = snapshot();
  for (const fresh of [{ ...h.state.snapshot, ownerClientId: "different-owner" }, { ...h.state.snapshot, pendingRequestCount: 1 }]) {
    h.deps.start = async (_identity, options) => { await options.beforeDispatch?.(fresh); throw new Error("must not dispatch"); };
    const rejected = await createDesktopTaskService(h.deps).send({ ...input, messageId: `blocked-${fresh.ownerClientId}-${fresh.pendingRequestCount}` });
    assert.equal(rejected.send_intent?.state, "not_sent"); assert.equal(rejected.status, "failed");
  }
  assert.equal(h.state.starts, 1);
});

test("monitor acceptance and completion cannot be demoted by a later send receipt", async t => {
  const h = harness(t);
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++;
    h.state.snapshot = snapshot([turn("native-one", "completed", options.clientUserMessageId)]);
    await createDesktopTaskService(h.deps).reconcile(h.repository.list()[0].id);
    return { turnId: "native-one", clientUserMessageId: options.clientUserMessageId, revision: 2, atomicIdlePrecondition: false };
  };
  const completed = await createDesktopTaskService(h.deps).send(input);
  assert.equal(completed.status, "completed"); assert.equal(completed.send_intent?.state, "accepted");
  assert.equal(completed.native_turn_id, "native-one");
});

test("cancelling a reservation before dispatch never sends or revives its Watch", async t => {
  const h = harness(t);
  h.deps.start = async (_identity, options) => {
    h.service.unwatch(h.repository.list()[0].id, { controllerSession: input.controllerSession });
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++;
    throw new Error("must not dispatch");
  };
  const cancelled = await createDesktopTaskService(h.deps).send(input);
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.send_intent?.state, "not_sent");
  assert.equal(h.state.starts, 0);
});

test("uncertain native send is reconciled by client ID and exact text across process restart", async t => {
  const h = harness(t);
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot);
    h.state.starts++; h.state.clientId = options.clientUserMessageId;
    throw new DesktopIpcError("timeout", "receipt missing", "unknown");
  };
  const uncertain = await createDesktopTaskService(h.deps).send(input);
  assert.equal(uncertain.status, "awaiting_acceptance"); assert.equal(uncertain.send_intent?.state, "uncertain");
  h.state.snapshot = snapshot([turn("accepted-after-timeout", "inProgress", h.state.clientId)]);
  const restarted = createDesktopTaskService(h.deps);
  const accepted = await restarted.reconcile(uncertain.id);
  assert.equal(accepted.native_turn_id, "accepted-after-timeout");
  assert.equal(accepted.status, "watching");
  await restarted.send(input); assert.equal(h.state.starts, 1);
});

test("later native turns cannot replace the original exact task or its final text", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  const original = turn("native-one", "completed", h.state.clientId);
  original.items.push({ id: "answer", type: "agentMessage", phase: "final_answer", text: "Original task output" });
  const later = turn("native-two", "completed", "human-client", "Later task");
  later.items.push({ id: "later-answer", type: "agentMessage", text: "Do not attribute this" });
  h.state.snapshot = snapshot([original, later]);
  const result = await h.service.reconcile(sent.id);
  assert.equal(result.status, "completed"); assert.equal(result.native_turn_id, "native-one");
  assert.equal(result.final_text, "Original task output");
});

test("commentary and analysis never become final output or stale manual-action callbacks", async t => {
  const h = harness(t); h.state.snapshot = snapshot([turn("human-active")]);
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  const complete = turn("human-active", "completed");
  complete.items.push({ id: "progress", type: "agentMessage", phase: "commentary", text: "Still working" },
    { id: "analysis", type: "agentMessage", phase: "analysis", text: "Internal reasoning" });
  h.state.snapshot = snapshot([complete], { pendingRequests: [{ kind: "approval", requestId: "stale", turnId: "human-active" }], pendingRequestCount: 1 });
  const result = await h.service.reconcile(watched.id);
  assert.equal(result.final_text, ""); assert.equal(result.pending_manual_count, 0);
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].envelope.event.type, "desktop_watch.settled");
});

test("Desktop target identity must agree with the canonical conversation ID", async t => {
  const h = harness(t);
  await assert.rejects(h.service.send({ ...input, target: { ...target, threadId: "different-thread" } }), { code: "desktop_identity_mismatch" });
  assert.equal(h.state.observes, 0); assert.equal(h.state.starts, 0);
  const sent = await h.service.send(input);
  const filePath = path.join(h.dir, "desktop-tasks", `${sent.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ ...sent, target: { ...target, codexHome: "/another/home" } }));
  assert.throws(() => h.repository.load(sent.id), /does not match native target/);
});

test("explicit Desktop Watch refuses idle history and binds only the uniquely active tail", async t => {
  const h = harness(t);
  h.state.snapshot = snapshot([turn("old-completed", "completed")]);
  await assert.rejects(h.service.watch(input), { code: "no_active_task" });
  assert.equal(h.repository.list().length, 0);
  h.state.snapshot = snapshot([turn("old-completed", "completed"), turn("human-active")]);
  const watched = await h.service.watch(input);
  assert.equal(watched.native_turn_id, "human-active"); assert.equal(h.state.starts, 0);
});

test("questions and approvals are notification-only, deduplicated, and never answered", async t => {
  const h = harness(t);
  h.state.snapshot = snapshot([turn("human-active")], {
    pendingRequests: [{ kind: "approval", requestId: "approval-one", turnId: "human-active" }], pendingRequestCount: 1
  });
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  assert.equal(watched.pending_manual_count, 1); assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].envelope.event.requires_response, false);
  assert.match(h.state.notifications[0].envelope.event.body, /manually in Desktop/);
  await h.service.reconcile(watched.id);
  assert.equal(h.state.notifications.length, 1); assert.equal(h.state.starts, 0);
});

test("callback retry survives reload and uses the same durable envelope idempotency key", async t => {
  const h = harness(t);
  h.state.snapshot = snapshot([turn("human-active")]);
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("human-active", "completed")]);
  h.state.outcomes.push({ disposition: "retryable_failure", error_code: "gateway_unavailable" });
  const failed = await h.service.reconcile(watched.id);
  assert.equal(failed.notifications[0].status, "retry_wait"); assert.equal(desktopTaskNeedsReconciliation(failed), true);
  await createDesktopTaskService(h.deps).reconcile(watched.id); assert.equal(h.state.notifications.length, 1);
  h.state.now += 5_000;
  const recovered = await createDesktopTaskService(h.deps).reconcile(watched.id);
  assert.equal(recovered.notifications[0].status, "accepted"); assert.equal(h.state.notifications.length, 2);
  assert.equal(h.state.notifications[0].envelope.idempotency_key, h.state.notifications[1].envelope.idempotency_key);
  assert.notEqual(h.state.notifications[0].attempt.id, h.state.notifications[1].attempt.id);
  assert.equal(desktopTaskNeedsReconciliation(recovered), false);
});

test("uncertain callback outcomes do not automatically retry", async t => {
  const h = harness(t); h.state.snapshot = snapshot([turn("human-active")]);
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("human-active", "completed")]);
  h.deps.deliver = async delivery => { h.state.notifications.push(delivery); throw new Error("transport lost after side effect"); };
  const service = createDesktopTaskService(h.deps);
  assert.equal((await service.reconcile(watched.id)).notifications[0].status, "uncertain");
  h.state.now += 60_000; await createDesktopTaskService(h.deps).reconcile(watched.id);
  assert.equal(h.state.notifications.length, 1);
});

test("accepted transport checkpoint survives a subsequent delivery throw", async t => {
  const h = harness(t); h.state.snapshot = snapshot([turn("human-active")]);
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("human-active", "completed")]);
  h.deps.deliver = delivery => {
    delivery.reportCheckpoint?.({ disposition: "accepted", accepted_at: new Date(h.state.now).toISOString(), acceptance_id: "checkpoint" });
    throw new Error("crashed after acceptance checkpoint");
  };
  const final = await createDesktopTaskService(h.deps).reconcile(watched.id);
  assert.equal(final.notifications[0].status, "accepted");
});

test("expired callback lease becomes uncertain instead of issuing a duplicate delivery", async t => {
  const h = harness(t); h.state.snapshot = snapshot([turn("human-active")]);
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("human-active", "completed")]);
  const noTransport = createDesktopTaskService({ ...h.deps, deliver: undefined });
  const pending = await noTransport.reconcile(watched.id);
  pending.notifications[0].status = "leased"; pending.notifications[0].attempts = 1;
  pending.notifications[0].attempt_id = "lost-process";
  pending.notifications[0].lease_expires_at = new Date(h.state.now - 1).toISOString();
  h.repository.withLock(pending.id, () => h.repository.save(pending, pending.revision));
  const final = await h.service.reconcile(pending.id);
  assert.equal(final.notifications[0].status, "uncertain"); assert.equal(h.state.notifications.length, 0);
});

test("incomplete exact turn and unavailable owner cannot falsely complete a Watch", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  h.state.snapshot = snapshot([{ ...turn("native-one", "completed", h.state.clientId), itemsComplete: false }]);
  assert.equal((await h.service.reconcile(sent.id)).status, "watching");
  h.deps.observe = async () => { throw new DesktopIpcError("owner_changed", "owner changed"); };
  const unavailable = await createDesktopTaskService(h.deps).reconcile(sent.id);
  assert.equal(unavailable.status, "watching"); assert.equal(unavailable.observation_error, "owner_changed");
});

test("human race with multiple user messages never claims a mixed turn as the submitted task", async t => {
  const h = harness(t);
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++;
    const mixed = turn("human-race", "inProgress", options.clientUserMessageId);
    mixed.items.unshift({ id: "human-message", type: "userMessage", clientId: "human", content: [{ type: "text", text: "Human concurrent work" }] });
    h.state.snapshot = snapshot([mixed]);
    return { turnId: "human-race", clientUserMessageId: options.clientUserMessageId, revision: 2, atomicIdlePrecondition: false };
  };
  const result = await createDesktopTaskService(h.deps).send(input);
  assert.equal(result.status, "awaiting_acceptance"); assert.equal(result.native_turn_id, undefined);
  assert.equal(h.state.starts, 1);
});

test("an uncertain send can still reconcile after its observation deadline without resending", async t => {
  const h = harness(t);
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++; h.state.clientId = options.clientUserMessageId;
    throw new DesktopIpcError("timeout", "unknown", "unknown");
  };
  const service = createDesktopTaskService(h.deps);
  const sent = await service.send({ ...input, timeoutMs: 100 });
  h.state.now += 100;
  assert.equal((await service.reconcile(sent.id)).status, "timed_out");
  const completed = turn("eventually-visible", "completed", h.state.clientId);
  completed.items.push({ id: "answer", type: "agentMessage", text: "Recovered" });
  h.state.snapshot = snapshot([completed]);
  const recovered = await createDesktopTaskService(h.deps).reconcile(sent.id);
  assert.equal(recovered.status, "completed"); assert.equal(recovered.final_text, "Recovered"); assert.equal(h.state.starts, 1);
});

test("only the owning controller can unwatch and cancellation never interrupts the native task", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  assert.throws(() => h.service.unwatch(sent.id, { controllerSession: "foreign-controller" }), { code: "desktop_controller_mismatch" });
  assert.equal(h.service.unwatch(sent.id, { controllerSession: input.controllerSession }).status, "cancelled");
  assert.equal(h.state.starts, 1); assert.equal(h.state.snapshot.turns[0].status, "inProgress");
});

test("Desktop state rejects anchor mutation and isolates corrupt records without hiding symlinks", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  assert.throws(() => h.repository.save({ ...sent, native_turn_id: "different" }, sent.revision), /anchor cannot change/);
  const badId = "desktop-watch:00000000-0000-0000-0000-999999999999";
  const root = path.join(h.dir, "desktop-tasks"); const badPath = path.join(root, `${badId}.json`);
  fs.writeFileSync(badPath, "{bad", { mode: 0o600 });
  const scan = h.repository.scanForReconciliation(); assert.equal(scan.tasks.length, 1); assert.equal(scan.errors[0].id, badId);
  fs.unlinkSync(badPath); fs.symlinkSync(path.join(root, `${sent.id}.json`), badPath);
  assert.throws(() => h.repository.scanForReconciliation(), /owner-private/);
});

test("separate Desktop repositories reject a stale save instead of losing another worker's anchor", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  const other = createDesktopStateStore(h.dir, { acquire: () => () => {} });
  const stale = other.load(sent.id)!;
  const completed = turn("native-one", "completed", h.state.clientId);
  h.state.snapshot = snapshot([completed]);
  await h.service.reconcile(sent.id);
  assert.throws(() => other.save(stale, stale.revision), /revision conflict/);
  assert.equal(other.load(sent.id)?.status, "completed");
  assert.equal(other.load(sent.id)?.native_turn_id, "native-one");
});
