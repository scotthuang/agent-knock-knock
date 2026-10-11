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
import { buildDesktopAsyncReply, desktopAsyncQuestions } from "../src/desktop-async-interactions.js";

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
  assert.equal(cancelled.status, "failed"); assert.ok(cancelled.unwatched_at); assert.equal(cancelled.send_intent?.state, "not_sent");
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
  const unwatched = h.service.unwatch(sent.id, { controllerSession: input.controllerSession });
  assert.equal(unwatched.status, "watching"); assert.ok(unwatched.unwatched_at);
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

function asyncQuestionTurn(): DesktopTurn {
  return { turnId: "native-one", status: "inProgress", itemsComplete: true,
    items: [{ id: "async-item", type: "agentMessage", text: "Choose a color", phase: "final_answer", delivery: "async",
      questions: [{ title: "Choose a color", options: ["Blue", "Green"] }] }] };
}

test("Desktop async question notifies once with public answer IDs while the same task continues working", async t => {
  const h = harness(t); h.state.snapshot = snapshot([asyncQuestionTurn()]);
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  assert.equal(watched.status, "watching"); assert.equal(watched.pending_manual_count, 0);
  assert.equal(watched.pending_async_interactions?.length, 1); assert.equal(h.state.notifications.length, 1);
  const event = h.state.notifications[0].envelope.event;
  assert.equal(event.requires_response, true); assert.equal(event.type, "desktop_watch.interaction");
  assert.match(event.body, /may continue working/); assert.match(event.body, /Refresh AKK Status/);
  assert.match(event.body, /after the user supplies an answer/); assert.match(event.body, /q:[a-f0-9]{64}/);
  assert.match(event.body, /o:[a-f0-9]{64}/);
  assert.doesNotMatch(JSON.stringify(event), /interaction_prompt_fingerprint|expires_at|available_actions/);
  await createDesktopTaskService(h.deps).reconcile(watched.id);
  assert.equal(h.state.notifications.length, 1); assert.equal(h.service.status(watched.id).notifications.length, 1);
});

test("incomplete Desktop history retains a pending question and retry instead of resolving and losing its notification", async t => {
  const h = harness(t); h.state.snapshot = snapshot([asyncQuestionTurn()]);
  h.state.outcomes.push({ disposition: "retryable_failure", error_code: "temporary_outage" });
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  const originalInteraction = watched.pending_async_interactions![0];
  assert.equal(watched.notifications[0].status, "retry_wait");
  h.state.snapshot.turns[0].itemsComplete = false; h.state.snapshot.turns[0].items = [];
  const partial = await h.service.reconcile(watched.id);
  assert.equal(partial.observation_error, "desktop_async_questions_incomplete");
  assert.deepEqual(partial.pending_async_interactions, [originalInteraction]); assert.equal(partial.notifications[0].status, "retry_wait");
  h.state.snapshot = snapshot([asyncQuestionTurn()]);
  const recovered = await h.service.reconcile(watched.id);
  assert.equal(recovered.observation_error, undefined); assert.equal(recovered.notifications.length, 1);
  assert.equal(recovered.notifications[0].status, "retry_wait"); assert.equal(h.state.notifications.length, 1);
  h.state.now += 6000;
  assert.equal((await h.service.reconcile(watched.id)).notifications[0].status, "accepted");
  assert.equal(h.state.notifications.length, 2); assert.equal(h.state.notifications[0].envelope.event.id, h.state.notifications[1].envelope.event.id);
});

test("accepted async answers revoke undelivered question reminders without cancelling the watched task", async t => {
  const h = harness(t); h.state.snapshot = snapshot([asyncQuestionTurn()]); delete h.deps.deliver;
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  assert.equal(watched.notifications[0].status, "ready");
  const question = desktopAsyncQuestions(h.state.snapshot)[0];
  h.state.snapshot.turns[0].items.push({ id: "answer-item", type: "userMessage", clientId: "human-answer",
    content: [{ type: "text", text: buildDesktopAsyncReply(question, "Green") }] });
  const answered = await h.service.reconcile(watched.id);
  assert.equal(answered.status, "watching"); assert.deepEqual(answered.pending_async_interactions, []);
  assert.equal(answered.notifications[0].status, "failed"); assert.equal(answered.notifications[0].outcome?.disposition, "permanent_failure");
  assert.equal(h.state.starts, 0);
});

test("Desktop completion revokes async attention and excludes async question text from the final result", async t => {
  const h = harness(t); h.state.snapshot = snapshot([asyncQuestionTurn()]); delete h.deps.deliver;
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  h.state.snapshot.turns[0].status = "completed";
  h.state.snapshot.turns[0].items.push({ id: "final-answer", type: "agentMessage", phase: "final_answer", text: "The actual completed result" });
  const completed = await h.service.reconcile(watched.id);
  assert.equal(completed.final_text, "The actual completed result"); assert.deepEqual(completed.pending_async_interactions, []);
  assert.equal(completed.notifications[0].status, "failed");
  assert.equal(completed.notifications[1].envelope.event.type, "desktop_watch.settled");
});

test("timeout and Unwatch withdraw queued async offers without changing the native task", async t => {
  const h = harness(t); h.state.snapshot = snapshot([asyncQuestionTurn()]); delete h.deps.deliver;
  const timeout = await h.service.watch({ ...input, callbackRoute: route, timeoutMs: 1 });
  const cancelled = await h.service.watch({ ...input, callbackRoute: route });
  const stopped = h.service.unwatch(cancelled.id, { controllerSession: input.controllerSession });
  assert.equal(stopped.status, "watching"); assert.ok(stopped.unwatched_at); assert.deepEqual(stopped.pending_async_interactions, []);
  assert.equal(stopped.notifications[0].status, "failed");
  h.state.now += 2;
  const expired = await h.service.reconcile(timeout.id);
  assert.equal(expired.status, "timed_out"); assert.deepEqual(expired.pending_async_interactions, []);
  assert.equal(expired.notifications[0].status, "failed");
  assert.equal(h.state.snapshot.turns[0].status, "inProgress"); assert.equal(h.state.starts, 0);
});


const controller = { controllerSession: input.controllerSession };
test("Desktop unresolved sends retain management across timeout and Unwatch until explicit Close", async t => {
  const h = harness(t);
  h.deps.start = async (_target, options) => { await options.beforeDispatch?.(h.state.snapshot); h.state.starts++; throw new DesktopIpcError("timeout", "unknown", "unknown"); };
  const service = createDesktopTaskService(h.deps);
  const sent = await service.send({ ...input, timeoutMs: 1 }); h.state.now += 2;
  assert.equal((await service.reconcile(sent.id)).status, "timed_out");
  service.unwatch(sent.id, controller);
  await assert.rejects(service.send({ ...input, messageId: "another-message" }), { code: "desktop_send_pending" });
  const before = h.state.observes;
  assert.throws(() => service.close(sent.id, { controllerSession: "other" }), { code: "desktop_controller_mismatch" });
  await assert.rejects(service.recover(sent.id, { controllerSession: "other" }), { code: "desktop_controller_mismatch" });
  await assert.rejects(service.renew(sent.id, { controllerSession: "other" }), { code: "desktop_controller_mismatch" });
  await assert.rejects(service.retryCallback(sent.id, { controllerSession: "other" }), { code: "desktop_controller_mismatch" });
  assert.equal(h.state.observes, before);
  const closed = service.close(sent.id, { ...controller, reason: "abandoned by controller" });
  assert.equal(closed.status, "timed_out"); assert.equal(closed.close_reason, "abandoned by controller"); assert.ok(closed.closed_at);
  for (const operation of [service.recover, service.renew, service.retryCallback]) await assert.rejects(operation(sent.id, controller), { code: "desktop_task_closed" });
  assert.equal(h.state.observes, before);
  assert.equal((await createDesktopTaskService(h.deps).send({ ...input, messageId: "another-message" })).send_intent?.state, "uncertain");
  assert.equal(h.state.starts, 2);
});

test("Desktop Recover reads the original send after timeout and Unwatch without adopting the latest turn", async t => {
  const h = harness(t);
  h.deps.start = async (_target, options) => { await options.beforeDispatch?.(h.state.snapshot); h.state.starts++; h.state.clientId = options.clientUserMessageId; throw new DesktopIpcError("timeout", "unknown", "unknown"); };
  const service = createDesktopTaskService(h.deps);
  const sent = await service.send({ ...input, timeoutMs: 1, callbackRoute: route }); h.state.now += 2;
  await service.reconcile(sent.id); const stopped = service.unwatch(sent.id, controller);
  h.state.snapshot = snapshot([turn("unrelated", "inProgress", "human")]);
  const missing = await createDesktopTaskService(h.deps).recover(sent.id, controller);
  assert.equal(missing.native_turn_id, undefined); assert.equal(missing.status, "timed_out");
  const original = turn("original-exact", "completed", h.state.clientId); original.items.push({ id: "final", type: "agentMessage", text: "Original result" });
  h.state.snapshot = snapshot([original, turn("new-latest", "inProgress", "human")]);
  const recovered = await createDesktopTaskService(h.deps).recover(sent.id, controller);
  assert.equal(recovered.native_turn_id, "original-exact"); assert.equal(recovered.status, "completed");
  assert.equal(recovered.final_text, "Original result"); assert.equal(recovered.deadline_at, stopped.deadline_at);
  assert.equal(recovered.unwatched_at, stopped.unwatched_at); assert.ok(recovered.recovered_at);
  assert.equal(desktopTaskNeedsReconciliation(recovered), false); assert.equal(h.state.starts, 1);
});

test("Desktop Renew extends the same exact task and gives each deadline a distinct timeout notification", async t => {
  const h = harness(t); delete h.deps.deliver;
  const sent = await createDesktopTaskService(h.deps).send({ ...input, callbackRoute: route, timeoutMs: 1 });
  h.state.now += 2;
  const expired = await h.service.reconcile(sent.id); const first = expired.notifications.find(note => note.envelope.event.type === "desktop_watch.timed_out")!;
  h.service.unwatch(sent.id, controller);
  const restarted = createDesktopTaskService(h.deps);
  const renewed = await restarted.renew(sent.id, { ...controller, timeoutMs: 10 });
  assert.equal(renewed.status, "watching"); assert.equal(renewed.native_turn_id, sent.native_turn_id);
  assert.equal(renewed.unwatched_at, undefined); assert.equal(renewed.renewal_count, 1);
  assert.ok(Date.parse(renewed.deadline_at) > Date.parse(expired.deadline_at));
  assert.equal(renewed.notifications.find(note => note.id === first.id)?.outcome?.disposition, "permanent_failure");
  h.state.now += 11;
  const second = await restarted.reconcile(sent.id);
  const timeouts = second.notifications.filter(note => note.envelope.event.type === "desktop_watch.timed_out");
  assert.equal(timeouts.length, 2); assert.notEqual(timeouts[0].id, timeouts[1].id);
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId), turn("new-task", "inProgress", "human")]);
  const complete = await restarted.renew(sent.id, { ...controller, timeoutMs: 100 });
  assert.equal(complete.status, "completed"); assert.equal(complete.deadline_at, second.deadline_at);
  assert.equal(complete.renewal_count, 1); assert.equal(h.state.starts, 1);
});

test("Desktop recovery refuses stale observations racing with Close and never reopens the task", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  let release!: (value: DesktopSnapshot) => void;
  h.deps.observe = () => new Promise(resolve => { release = resolve; });
  const service = createDesktopTaskService(h.deps); const pending = service.renew(sent.id, controller);
  service.close(sent.id, controller); release(h.state.snapshot);
  await assert.rejects(pending, { code: "desktop_task_closed" });
  const current = service.status(sent.id); assert.ok(current.closed_at); assert.equal(current.deadline_at, sent.deadline_at);
  assert.equal(h.state.starts, 1);
});

test("Desktop retry grants one extra exhausted attempt while retaining notification identity and attempt history", async t => {
  const h = harness(t); h.deps.maxDeliveryAttempts = 1;
  h.state.snapshot = snapshot([turn("native-one")]);
  const service = createDesktopTaskService(h.deps); const watched = await service.watch({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("native-one", "completed")]);
  h.state.outcomes.push({ disposition: "retryable_failure", error_code: "temporary" });
  const failed = await service.reconcile(watched.id); const note = failed.notifications[0];
  assert.equal(note.status, "failed"); assert.equal(note.attempts, 1);
  const retried = await createDesktopTaskService(h.deps).retryCallback(watched.id, { ...controller, notificationId: note.id });
  assert.equal(retried.notifications[0].status, "accepted"); assert.equal(retried.notifications[0].attempts, 2);
  assert.deepEqual(retried.notifications[0].envelope, note.envelope); assert.equal(retried.notifications[0].id, note.id);
  await assert.rejects(service.retryCallback(watched.id, controller), { code: "desktop_callback_not_retryable" });
  assert.equal(h.state.starts, 0);
});

test("Desktop Close blocks future retries after an in-flight callback fails", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  let release!: (outcome: CallbackAttemptOutcome) => void; let signal!: () => void;
  const pending = new Promise<void>(resolve => { signal = resolve; });
  h.deps.deliver = () => new Promise(resolve => { release = resolve; signal(); });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  const service = createDesktopTaskService(h.deps); const settling = service.reconcile(sent.id);
  await pending; service.close(sent.id, controller);
  release({ disposition: "retryable_failure", error_code: "temporary" });
  const closed = await settling; assert.equal(closed.notifications[0].status, "failed");
  assert.ok(closed.closed_at); assert.equal(desktopTaskNeedsReconciliation(closed), false);
  assert.equal(h.state.starts, 1);
});

test("Desktop interaction callback retry requires the original interaction to remain freshly pending", async t => {
  const h = harness(t); h.state.snapshot = snapshot([asyncQuestionTurn()]); h.deps.maxDeliveryAttempts = 1;
  h.state.outcomes.push({ disposition: "retryable_failure", error_code: "temporary" });
  const service = createDesktopTaskService(h.deps); const watched = await service.watch({ ...input, callbackRoute: route });
  assert.equal(watched.notifications[0].status, "failed");
  h.state.snapshot.turns[0].items = [];
  await assert.rejects(service.retryCallback(watched.id, controller), { code: "desktop_interaction_not_pending" });
  assert.equal(service.status(watched.id).notifications[0].outcome?.disposition, "permanent_failure");
  await service.reconcile(watched.id); assert.equal(h.state.notifications.length, 1); assert.equal(h.state.starts, 0);
  assert.throws(() => service.close(watched.id, controller), { code: "desktop_close_requires_send" });
});

test("Desktop timeout callback cannot rearm after renewal while its first attempt is in flight", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route, timeoutMs: 1 });
  let release!: (outcome: CallbackAttemptOutcome) => void; let signal!: () => void;
  const pending = new Promise<void>(resolve => { signal = resolve; });
  h.deps.deliver = () => new Promise(resolve => { release = resolve; signal(); });
  const service = createDesktopTaskService(h.deps); h.state.now += 2;
  const timeout = service.reconcile(sent.id); await pending;
  const renewed = await service.renew(sent.id, { ...controller, timeoutMs: 1000 });
  assert.equal(renewed.renewal_count, 1); assert.equal(renewed.notifications[0].id, `${sent.id}:timed_out`);
  release({ disposition: "retryable_failure", error_code: "temporary" });
  const final = await timeout; assert.equal(final.status, "watching");
  assert.equal(final.notifications[0].status, "failed"); assert.equal(final.notifications[0].outcome?.disposition, "permanent_failure");
  await assert.rejects(service.retryCallback(sent.id, controller), { code: "desktop_callback_not_retryable" });
});

test("Desktop keeps late callback acceptance after the same attempt lease was marked uncertain", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  let release!: (outcome: CallbackAttemptOutcome) => void; let signal!: () => void;
  const pending = new Promise<void>(resolve => { signal = resolve; });
  h.deps.deliver = () => new Promise(resolve => { release = resolve; signal(); });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  const service = createDesktopTaskService(h.deps); const settling = service.reconcile(sent.id); await pending;
  h.state.now += 31_000;
  assert.equal((await service.reconcile(sent.id)).notifications[0].status, "uncertain");
  release({ disposition: "accepted", accepted_at: new Date(h.state.now).toISOString(), acceptance_id: "late-accepted" });
  const accepted = await settling; assert.equal(accepted.notifications[0].status, "accepted"); assert.equal(accepted.notifications[0].attempts, 1);
});

test("Desktop expired callback can retry after exact original-attempt proof of no dispatch", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  let release!: (outcome: CallbackAttemptOutcome) => void; let signal!: () => void;
  let request!: CallbackTransportDeliverInput;
  const pending = new Promise<void>(resolve => { signal = resolve; });
  h.deps.deliver = delivery => new Promise(resolve => { request = delivery; release = resolve; signal(); });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  const service = createDesktopTaskService(h.deps); const settling = service.reconcile(sent.id); await pending;
  h.state.now += 31_000;
  assert.equal((await service.reconcile(sent.id)).notifications[0].status, "uncertain");
  release({ disposition: "retryable_failure", error_code: "connection_unavailable", evidence: { request_dispatched: false,
    request_phase: "connection_handshake", attempt_id: request.attempt.id, delivery_id: request.envelope.delivery_id,
    idempotency_key: request.envelope.idempotency_key } });
  const waiting = await settling;
  assert.equal(waiting.notifications[0].status, "retry_wait"); assert.equal(waiting.notifications[0].attempts, 1);
  assert.equal(Date.parse(waiting.notifications[0].retry_at!) - h.state.now, 5000);
});

test("Desktop Recover retains stopped observation for legacy cancelled records", async t => {
  const h = harness(t); h.state.snapshot = snapshot([turn("native-one")]); delete h.deps.deliver;
  const service = createDesktopTaskService(h.deps); const watched = await service.watch({ ...input, callbackRoute: route });
  h.repository.save({ ...watched, status: "cancelled" }, watched.revision);
  h.state.snapshot = snapshot([turn("native-one", "completed")]);
  const recovered = await createDesktopTaskService(h.deps).recover(watched.id, controller);
  assert.equal(recovered.status, "completed"); assert.ok(recovered.unwatched_at);
  assert.equal(recovered.notifications.length, 0); assert.equal(desktopTaskNeedsReconciliation(recovered), false);
});

test("stopped Desktop tasks only expire crashed callback leases without observing or dispatching", async t => {
  const h = harness(t); delete h.deps.deliver;
  const service = createDesktopTaskService(h.deps); const sent = await service.send({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  const completed = await service.reconcile(sent.id); const notification = completed.notifications[0];
  notification.status = "leased"; notification.attempts = 1; notification.attempt_id = "crashed-attempt";
  notification.lease_expires_at = new Date(h.state.now + 1).toISOString();
  h.repository.save(completed, completed.revision);
  const closed = service.close(sent.id, controller); assert.equal(desktopTaskNeedsReconciliation(closed), true);
  h.state.now += 2; const observes = h.state.observes;
  h.deps.deliver = async () => { throw new Error("must not dispatch"); };
  const expired = await createDesktopTaskService(h.deps).reconcile(sent.id);
  assert.equal(expired.notifications[0].status, "uncertain"); assert.equal(desktopTaskNeedsReconciliation(expired), false);
  assert.equal(h.state.observes, observes); assert.equal(h.state.starts, 1);
});

test("Desktop Recover records an overdue active task as timed out without extending its deadline", async t => {
  const h = harness(t); delete h.deps.deliver;
  const service = createDesktopTaskService(h.deps);
  const sent = await service.send({ ...input, callbackRoute: route, timeoutMs: 1 });
  h.state.now += 2;
  const recovered = await createDesktopTaskService(h.deps).recover(sent.id, controller);
  assert.equal(recovered.status, "timed_out"); assert.equal(recovered.deadline_at, sent.deadline_at);
  assert.equal(recovered.native_turn_id, sent.native_turn_id); assert.ok(recovered.recovered_at);
  assert.equal(recovered.notifications[0].id, `${sent.id}:timed_out`);
  assert.equal(recovered.renewal_count, undefined); assert.equal(h.state.starts, 1);
});


test("Desktop service Send and Watch share 12-hour defaults and exact expiry boundaries", async t => {
  for (const kind of ["send", "watch"] as const) {
    const h = harness(t);
    if (kind === "watch") h.state.snapshot = snapshot([turn("native-one")]);
    const startedAt = h.state.now;
    const task = await h.service[kind](input);
    assert.equal(Date.parse(task.deadline_at) - startedAt, 43_200_000);
    h.state.now = startedAt + 3_600_000;
    assert.equal((await h.service.reconcile(task.id)).status, "watching", "60 minutes is not a backend inactivity deadline");
    h.state.now = startedAt + 43_200_000 - 1;
    assert.equal((await h.service.reconcile(task.id)).status, "watching");
    h.state.now++;
    assert.equal((await h.service.reconcile(task.id)).status, "timed_out");
  }
});

test("Desktop preserves existing short deadlines through restart, replay and Recover; only Renew extends", async t => {
  const h = harness(t);
  const sent = await h.service.send({ ...input, callbackRoute: route, timeoutMs: 3_600_000 });
  h.state.now += 3_600_000;
  const service = createDesktopTaskService(h.deps);
  const expired = await service.reconcile(sent.id);
  assert.equal(expired.status, "timed_out");
  const accepted = expired.notifications.filter(note => note.status === "accepted").map(note => note.id);
  assert.equal(accepted.length, 1);
  const replay = await service.send({ ...input, callbackRoute: route });
  assert.equal(replay.deadline_at, sent.deadline_at);
  assert.equal(replay.status, "timed_out");
  const recovered = await service.recover(sent.id, { controllerSession: input.controllerSession });
  assert.equal(recovered.deadline_at, sent.deadline_at);
  assert.equal(recovered.status, "timed_out");
  const renewed = await service.renew(sent.id, { controllerSession: input.controllerSession });
  assert.equal(Date.parse(renewed.deadline_at) - h.state.now, 43_200_000);
  assert.equal(renewed.renewal_count, 1);
  assert.equal(h.state.starts, 1);
  assert.deepEqual(renewed.notifications.filter(note => note.status === "accepted").map(note => note.id), accepted);
  await service.reconcile(sent.id);
  assert.equal(h.state.notifications.length, 1, "accepted timeout notification is neither revived nor redelivered");
});
