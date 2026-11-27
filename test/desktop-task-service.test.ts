import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { collectExpiredWatchHistory } from "../src/watch-history-retention.js";
import { createCallbackEnvelope, createTerminalWatchOpenClawCallbackRoute, type CallbackAttemptOutcome, type CallbackTransportDeliverInput } from "../src/callback-transport.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import { desktopStoredAnswerForLookup, desktopTaskProjection } from "../src/desktop-public-projection.js";
import { createDesktopTaskService, desktopTaskNeedsReconciliation, type DesktopTaskServiceDependencies } from "../src/desktop-task-service.js";
import { DesktopIpcError, type DesktopSnapshot, type DesktopTurn } from "../src/desktop-types.js";
import { DesktopEndpointUnavailable } from "../src/desktop-ipc-transport.js";
import { createDesktopQueueObserver, type DesktopQueueObservation } from "../src/desktop-task-queue.js";
import { DESKTOP_CREATION_BUILD, desktopCapabilityProfile } from "../src/desktop-compatibility.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { buildDesktopAsyncReply, desktopAsyncQuestions } from "../src/desktop-async-interactions.js";

const target = { codexHome: "/test/codex", hostId: "local", threadId: "00000000-0000-4000-8000-000000000001" };
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

function queueHarness(t: TestContext) {
  const h = harness(t);
  const admission = { ownerId: "desktop-writer", endpointId: "shared-socket", cwd: "/project", baselineTurnId: "preexisting-turn" };
  const queue = { writes: 0, reads: 0, ackLost: false, client: "", submissions: new Map<string, { prompt: string; queueId?: string }>(),
    observation: { state: "pending", reason: "desktop_queue_turn_not_observed" } as DesktopQueueObservation };
  h.deps.observe = async () => { throw new DesktopEndpointUnavailable("ECONNREFUSED"); };
  h.deps.queue = {
    prepare: async () => admission,
    submit: async (identity, original, { watchId, clientUserMessageId, prompt }) => {
      assert.deepEqual(identity, target); assert.deepEqual(original, admission);
      h.repository.withLock(watchId, () => {
        const task = h.repository.load(watchId)!;
        assert.equal(task.send_intent!.state, "reserved"); assert.equal(task.send_intent!.client_user_message_id, clientUserMessageId);
        assert.equal(task.send_intent!.text, prompt);
        task.send_intent!.state = "uncertain"; h.repository.save(task, task.revision);
      });
      queue.writes++; queue.client = clientUserMessageId;
      const queueId = queue.writes === 1 ? "queue-entry" : `queue-entry-${queue.writes}`;
      queue.submissions.set(clientUserMessageId, { prompt, ...(!queue.ackLost ? { queueId } : {}) });
      if (queue.ackLost) throw new DesktopIpcError("timeout", "Queue add ACK lost", "unknown");
      return { queueId, clientUserMessageId };
    },
    observe: async (identity, witness) => {
      queue.reads++;
      assert.deepEqual(identity, target);
      const origin = queue.submissions.get(witness.clientUserMessageId)!;
      const bound = h.repository.list().find(task => task.send_intent?.client_user_message_id === witness.clientUserMessageId)?.native_turn_id;
      assert.deepEqual(witness, { clientUserMessageId: witness.clientUserMessageId, prompt: origin.prompt, baselineTurnId: "preexisting-turn",
        ...(witness.historyScan === "recover" ? { historyScan: "recover" } : {}),
        ...(bound ? { boundTurnId: bound } : {}),
        ...(origin.queueId ? { acknowledgedQueueId: origin.queueId } : {}),
        expectedCwd: "/project", expectedEndpointId: admission.endpointId });
      return structuredClone(queue.observation);
    }
  };
  return { ...h, queue };
}

test("native Desktop queue persists distinct queue and turn identities and settles exactly once across recovery", async t => {
  const h = queueHarness(t);
  const dispatched = { ...input, callbackRoute: route };
  const [one, two] = await Promise.all([h.service.send(dispatched), createDesktopTaskService(h.deps).send(dispatched)]);
  assert.equal(one.id, two.id); assert.equal(h.queue.writes, 1);
  const pending = h.service.status(one.id);
  assert.equal(pending.send_intent?.queue_id, "queue-entry");
  assert.equal(pending.send_intent?.delivery_path, "native_thread_queue");
  assert.equal(pending.native_turn_id, undefined); assert.equal(pending.status, "awaiting_acceptance");
  const restarted = createDesktopTaskService(h.deps);
  await assert.rejects(restarted.watch(dispatched), { code: "no_active_task" });
  assert.equal(h.repository.list().length, 1);
  const owner = { controllerSession: input.controllerSession };
  const deadline = pending.deadline_at;
  assert.equal((await restarted.recover(pending.id, owner)).deadline_at, deadline);
  await assert.rejects(restarted.renew(pending.id, owner), { code: "desktop_exact_task_not_active" });
  h.queue.observation = { state: "matched", turn: turn("execution-turn") };
  const active = await restarted.reconcile(one.id);
  assert.equal(active.native_turn_id, "execution-turn");
  assert.equal(active.send_intent!.queue_id, "queue-entry");
  assert.equal(active.send_intent!.state, "accepted");
  assert.equal((await restarted.watch(dispatched)).id, one.id);
  await assert.rejects(restarted.watch({ ...input, controllerSession: "another-controller" }), { code: "no_active_task" });
  h.state.now += 60000;
  assert.ok(Date.parse((await restarted.renew(one.id, owner)).deadline_at) > Date.parse(deadline));
  const display = { version: 1, mode: "show", trustedContacts: "check" } as const;
  h.queue.observation = { state: "matched", turn: { ...turn("execution-turn", "completed"), items: [
    { id: "progress", type: "agentMessage", phase: "commentary", text: "Progress only" },
    { id: "blocked", type: "agentMessage", phase: "final_answer", text: "RESTRICTED-SIBLING",
      answerDisplay: { version: 1, mode: "block", reason: "protection" } },
    { id: "reply", type: "agentMessage", phase: "final_answer", text: "DONE", answerDisplay: display }
  ] } };
  await Promise.all([restarted.reconcile(one.id), h.service.reconcile(one.id)]);
  const done = await restarted.reconcile(one.id);
  assert.equal(done.status, "completed"); assert.equal(done.final_text, "DONE");
  assert.equal(done.notifications.length, 1); assert.equal(done.notifications[0].status, "accepted");
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].envelope.event.metadata?.turn_id, "execution-turn");
  assert.ok(done.final_text_display?.some(d => d.mode === "show" && d.trustedContacts === "check"));
  const callback = h.state.notifications[0].envelope;
  assert.equal(callback.route.controller_session_id, input.controllerSession);
  assert.deepEqual(callback.event.metadata?.final_text_display, done.final_text_display);
  assert.equal(callback.event.metadata?.trusted_contacts_check_status, "not_performed_by_akk");
  const threadUrl = `codex://threads/${target.threadId}`;
  assert.equal(callback.event.metadata?.desktop_url, threadUrl);
  assert.match(callback.event.body, /completed/);
  assert.ok(callback.event.body.includes("Codex 要求检查可信联系人，AKK 未执行或核实这项检查。"));
  assert.ok(callback.event.body.includes(threadUrl));
  assert.match(callback.event.body, /^DONE$/m);
  assert.doesNotMatch(JSON.stringify(h.state.notifications[0]), /RESTRICTED-SIBLING|Progress only/);
  assert.deepEqual(done.notifications[0].envelope, callback);
  const offline = desktopTaskProjection(h.repository.load(one.id)!, false, input.controllerSession);
  assert.equal(offline.final_text, "DONE");
  assert.equal(offline.final_text_notice, callback.event.metadata?.final_text_notice);
  assert.equal(offline.desktop_url, threadUrl);
  assert.equal(desktopTaskProjection(done, false, "some-other-controller").final_text, "");
  const lookup = desktopStoredAnswerForLookup(h.repository.load(one.id)!);
  assert.equal(lookup.final_text, "DONE");
  assert.equal(lookup.final_text_notice, callback.event.metadata?.final_text_notice);
  assert.doesNotMatch(JSON.stringify(lookup), /RESTRICTED-SIBLING|Progress only/);
  assert.equal((await restarted.send(dispatched)).id, one.id); assert.equal(h.queue.writes, 1); assert.equal(h.state.starts, 0);
  h.deps.queue!.observe = async () => assert.fail("Already settled tasks retain their evidence offline");
  assert.equal((await restarted.recover(one.id, owner)).status, "completed");
  assert.equal((await restarted.reconcile(one.id)).status, "completed");
  assert.equal(h.state.notifications.length, 1);
});

test("pending legacy callbacks keep their delivery identity and replace cached checked text at dispatch", async t => {
  for (const savedDirective of ["task", "envelope"] as const) {
    const h = harness(t);
    h.deps.canDeliver = () => false;
    const sent = await h.service.send({ ...input, callbackRoute: route });
    const final = turn("native-one", "completed", h.state.clientId);
    h.state.snapshot = snapshot([final]);
    const done = await h.service.reconcile(sent.id);
    const pending = done.notifications[0];
    assert.equal(pending.status, "ready");
    const displays = [{ version: 1, mode: "show", trustedContacts: "check" }] as const;
    const marker = "SYNTHETIC-CACHED-FINAL";
    done.final_text = marker;
    if (savedDirective === "task") done.final_text_display = [...displays];
    pending.envelope = createCallbackEnvelope({ route, source: pending.envelope.source, event: {
      ...pending.envelope.event, body: `Legacy completion with ${marker}`, metadata: {
        ...pending.envelope.event.metadata, ...(savedDirective === "envelope" ? { final_text_display: displays } : {}) } } });
    h.repository.save(done, done.revision);
    const cached = desktopTaskProjection(done, false, input.controllerSession);
    assert.equal(cached.final_text, "");
    assert.equal(cached.desktop_url, `codex://threads/${target.threadId}`);
    assert.ok(!JSON.stringify(cached).includes(marker));
    assert.equal(desktopTaskProjection(done).desktop_url, undefined);
    const lookup = desktopStoredAnswerForLookup(done);
    assert.equal(lookup.final_text, "");
    assert.equal(lookup.trusted_contacts_check_status, "not_performed_by_akk");
    assert.ok(!JSON.stringify(lookup).includes(marker));
    h.deps.canDeliver = () => true;
    const restarted = createDesktopTaskService(h.deps);
    await restarted.reconcile(done.id);
    await restarted.reconcile(done.id);
    assert.equal(h.state.notifications.length, 1);
    const delivered = h.state.notifications[0].envelope;
    assert.equal(delivered.delivery_id, pending.envelope.delivery_id);
    assert.equal(delivered.idempotency_key, pending.envelope.idempotency_key);
    assert.equal(delivered.event.id, `${done.id}:settled`);
    assert.equal(delivered.route.controller_session_id, input.controllerSession);
    assert.ok(delivered.event.body.includes(`codex://threads/${target.threadId}`));
    assert.ok(!JSON.stringify(delivered).includes(marker));
    assert.equal(restarted.status(done.id).notifications[0].status, "accepted");
  }
});

test("independent queue requests survive an older ACK loss; changing just the message ID cannot replay it", async t => {
  const h = queueHarness(t), restarted = createDesktopTaskService(h.deps);
  h.queue.ackLost = true;
  const keyed = { ...input, requestId: "original-instruction" };
  const unknown = await h.service.send(keyed);
  assert.equal(unknown.send_intent?.queue_id, undefined);
  assert.equal((await restarted.send(keyed)).id, unknown.id);
  assert.equal((await restarted.send({ ...keyed, messageId: "retry-with-different-id" })).id, unknown.id);
  assert.equal(h.queue.writes, 1);
  h.queue.ackLost = false;
  const next = { ...input, messageId: "independent", requestId: "independent-authorized-request", text: "different follow-up" };
  const [a, b] = await Promise.all([h.service.send(next), restarted.send(next)]);
  assert.equal(a.id, b.id);
  const other = await restarted.send({ ...next, messageId: "third", requestId: "third-independent-request", text: "third follow-up" });
  assert.equal(h.queue.writes, 3);
  const confirmed = h.service.status(a.id);
  assert.equal(confirmed.send_intent?.queue_id, "queue-entry-2");
  assert.equal(other.send_intent?.queue_id, "queue-entry-3");
  assert.notEqual(confirmed.send_intent?.client_user_message_id, other.send_intent?.client_user_message_id);
  assert.equal(confirmed.native_turn_id, undefined);
  assert.equal(restarted.status(unknown.id).send_intent?.queue_id, undefined);
});

test("Desktop queue Watch rejects a replaced or unverifiable shared daemon on either side of its read", async t => {
  const h = queueHarness(t), port = h.deps.queue!, read = port.observe;
  const task = await h.service.send({ ...input, callbackRoute: route });
  h.queue.observation = { state: "matched", turn: turn("would-appear-completed", "completed") };
  for (const [checks, expectedReads, reason] of [
    [["changed"], 0, "desktop_queue_endpoint_changed"], [["shared-socket", "changed"], 1, "desktop_queue_endpoint_changed"],
    [["shared-socket", "unavailable"], 1, "desktop_queue_endpoint_unverified"]
  ] as const) {
    let count = 0;
    port.observe = createDesktopQueueObserver(async () => {
      const value = checks[count++];
      if (value === "unavailable") throw new Error("daemon disappeared");
      return value!;
    }, read);
    const before = h.queue.reads, pending = await createDesktopTaskService(h.deps).reconcile(task.id);
    assert.equal(h.queue.reads - before, expectedReads); assert.equal(pending.observation_error, reason);
    assert.equal(pending.native_turn_id, undefined); assert.equal(pending.notifications.length, 0); assert.equal(h.queue.writes, 1);
  }
});

test("lost native queue add ACK does not replay, bind conflicting history or consume a different turn", async t => {
  const h = queueHarness(t);
  h.queue.ackLost = true;
  let result = await h.service.send({ ...input, callbackRoute: route });
  assert.equal(result.send_intent?.queue_id, undefined);
  assert.equal(result.send_intent?.state, "uncertain"); assert.equal(result.status, "awaiting_acceptance");
  const restarted = createDesktopTaskService(h.deps);
  h.queue.observation = { state: "uncertain", reason: "desktop_queue_submission_conflict" };
  result = await restarted.reconcile(result.id);
  assert.equal(result.observation_error, "desktop_queue_submission_conflict"); assert.equal(result.native_turn_id, undefined);
  assert.equal((await restarted.send({ ...input, callbackRoute: route })).id, result.id);
  h.queue.observation = { state: "matched", turn: turn("actual", "unknown") };
  result = await restarted.reconcile(result.id);
  assert.equal(result.native_turn_id, "actual"); assert.equal(result.status, "watching");
  assert.equal(result.observation_error, "desktop_queue_turn_status_unconfirmed");
  await assert.rejects(restarted.watch({ ...input, callbackRoute: route }), { code: "no_active_task" });
  h.queue.observation = { state: "matched", turn: turn("replacement", "completed") };
  result = await restarted.reconcile(result.id);
  assert.equal(result.observation_error, "desktop_submission_turn_conflict"); assert.equal(result.native_turn_id, "actual");
  assert.equal(result.notifications.length, 0); assert.equal(h.queue.writes, 1);
});

test("an uncertain legacy request or unsafe legacy connection never opens the native Desktop queue", async t => {
  const h = queueHarness(t);
  h.deps.queue!.prepare = async () => assert.fail("unsafe route switch");
  for (const error of [new DesktopIpcError("timeout", "Unknown", "unknown"), new DesktopIpcError("unsafe_socket", "Unsafe")]) {
    h.deps.observe = async () => { throw error; };
    await assert.rejects(h.service.send(input), err => err === error);
  }
  assert.deepEqual(h.repository.list(), []); assert.equal(h.queue.writes, 0);
});

test("Desktop callback reconciliation preserves unclaimed foreign routes for an authorized Host", async t => {
  const h = harness(t);
  h.deps.canDeliver = () => false;
  const sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  const pendingTask = await h.service.reconcile(sent.id);
  assert.equal(pendingTask.status, "completed");
  assert.equal(pendingTask.notifications[0].status, "ready");
  assert.equal(pendingTask.notifications[0].attempts, 0);
  assert.equal(h.state.notifications.length, 0);
  const envelope = structuredClone(pendingTask.notifications[0].envelope);
  h.deps.canDeliver = () => { throw new Error("recovery catalogue unavailable"); };
  assert.deepEqual((await h.service.reconcile(sent.id)).notifications, pendingTask.notifications);
  h.deps.canDeliver = candidate => candidate?.controller_session_id === input.controllerSession;
  const accepted = await h.service.reconcile(sent.id);
  assert.equal(accepted.notifications[0].status, "accepted");
  assert.equal(accepted.notifications[0].attempts, 1);
  assert.deepEqual(h.state.notifications[0].envelope, envelope);
});

test("exact Status can settle a queue turn found by Recover after expiry while unattended observation remains stopped", async t => {
  const h = queueHarness(t);
  const queued = await h.service.send({ ...input, callbackRoute: route, timeoutMs: 100 });
  const service = createDesktopTaskService(h.deps);
  h.state.now += 101;
  const expired = await service.reconcile(queued.id);
  assert.equal(expired.status, "timed_out");
  assert.equal(desktopTaskNeedsReconciliation(expired), false);
  h.queue.observation = { state: "matched", turn: turn("late-turn") };
  const bound = await service.recover(queued.id, controller);
  assert.equal(bound.native_turn_id, "late-turn");
  assert.equal(bound.status, "timed_out");
  assert.equal(desktopTaskProjection(bound).callback_expected, false);
  const before = h.queue.reads;
  h.queue.observation = { state: "matched", turn: { ...turn("late-turn", "completed"),
    items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "late result" }] } };
  assert.equal((await service.reconcileAll()).tasks[0].status, "timed_out");
  assert.equal(h.queue.reads, before);
  const done = await service.reconcile(queued.id);
  assert.equal(done.status, "completed");
  assert.equal(done.deadline_at, queued.deadline_at);
  assert.equal(done.renewal_count, undefined);
  assert.equal(done.final_text, "late result");
  await createDesktopTaskService(h.deps).reconcile(queued.id);
  assert.deepEqual(h.state.notifications.map(n => n.envelope.event.id), [queued.id + ":timed_out", queued.id + ":settled"]);
  assert.equal(h.queue.writes, 1);
});

test("Renew resumes the original waiting queue entry before a turn exists only with fresh receipt and entry proof", async t => {
  const h = queueHarness(t), service = h.service;
  h.queue.observation = { state: "pending", reason: "desktop_queue_entry_waiting" };
  const queued = await service.send({ ...input, callbackRoute: route, timeoutMs: 100 });
  h.state.now += 101;
  const expired = await service.reconcile(queued.id);
  assert.equal(expired.status, "timed_out");
  assert.equal((desktopTaskProjection(expired).capabilities as Record<string, boolean>).renew, true);
  assert.ok((desktopTaskProjection(expired).available_actions as Record<string, unknown>).renew);
  for (const reason of ["desktop_queue_entry_conflict", "desktop_queue_entry_not_observed", "desktop_queue_entry_unconfirmed_ack"]) {
    h.queue.observation = { state: "uncertain", reason };
    await assert.rejects(service.renew(queued.id, controller), { code: "desktop_exact_task_not_active" });
    assert.equal(service.status(queued.id).deadline_at, expired.deadline_at);
  }
  h.queue.observation = { state: "pending", reason: "desktop_queue_entry_waiting" };
  const renewed = await service.renew(queued.id, { ...controller, timeoutMs: 1_000 });
  assert.equal(renewed.status, "awaiting_acceptance");
  assert.equal(renewed.native_turn_id, undefined);
  assert.equal(renewed.watch_id, queued.watch_id);
  assert.equal(Date.parse(renewed.deadline_at), h.state.now + 1_000);
  assert.equal(renewed.renewal_count, 1);
  assert.equal(desktopTaskNeedsReconciliation(renewed), true);
  h.queue.observation = { state: "matched", turn: turn("later-active") };
  assert.equal((await service.reconcileAll()).tasks[0].status, "watching");
  h.queue.observation = { state: "matched", turn: turn("later-active", "completed") };
  assert.equal((await service.reconcileAll()).tasks[0].status, "completed");
  assert.deepEqual(h.state.notifications.map(n => n.envelope.event.id), [queued.id + ":timed_out", queued.id + ":settled"]);
  assert.equal(h.queue.writes, 1);
});

test("Desktop queue Recover and Renew tolerate identical monitor polls but retain control and observation fences", async t => {
  for (const [method, concurrent] of [
    ["recover", "poll"], ["renew", "poll"], ["recover", "unwatch"], ["renew", "changed-observation"]
  ] as const) {
    const h = queueHarness(t), monitor = createDesktopTaskService(h.deps);
    h.queue.observation = { state: "uncertain", reason: "desktop_queue_history_requires_recover" };
    const task = await h.service.send({ ...input, callbackRoute: route });
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const port = h.deps.queue!, read = port.observe;
    port.observe = async (identity, witness) => {
      if (witness.historyScan !== "recover") return read(identity, witness);
      entered(); await gate;
      return method === "recover"
        ? { state: "matched", turn: turn("deep-turn", "completed") }
        : { state: "pending", reason: "desktop_queue_entry_waiting" };
    };
    const result = h.service[method](task.id, controller);
    await reading;
    try {
      h.state.now += 2500;
      if (concurrent === "changed-observation") {
        h.queue.observation = { state: "uncertain", reason: "desktop_queue_endpoint_changed" };
      }
      const polled = await monitor.reconcile(task.id, "monitor");
      assert.ok(polled.revision > task.revision);
      assert.notEqual(polled.observed_at, task.observed_at);
      if (concurrent === "unwatch") monitor.unwatch(task.id, controller);
    } finally { release(); }
    if (concurrent === "poll") {
      const recovered = await result;
      if (method === "recover") {
        assert.equal(recovered.native_turn_id, "deep-turn");
        assert.equal(recovered.status, "completed");
      } else {
        assert.equal(recovered.status, "awaiting_acceptance");
        assert.equal(recovered.renewal_count, 1);
      }
    } else {
      await assert.rejects(result, { code: "desktop_task_changed" });
      const retained = monitor.status(task.id);
      if (concurrent === "unwatch") assert.ok(retained.unwatched_at);
      else assert.equal(retained.observation_error, "desktop_queue_endpoint_changed");
      assert.equal(retained.native_turn_id, undefined);
      assert.equal(retained.renewal_count, undefined);
    }
    assert.equal(h.queue.writes, 1);
  }
});

test("Unwatch and Close prevent late queue completion from restarting observation or notifying", async t => {
  for (const stop of ["unwatch", "close"] as const) {
    const h = queueHarness(t);
    const task = await h.service.send({ ...input, callbackRoute: route, timeoutMs: 100 });
    h.state.now += 101;
    await h.service.reconcile(task.id);
    h.service[stop](task.id, controller);
    h.queue.observation = { state: "matched", turn: turn("late", "completed") };
    const reads = h.queue.reads;
    const service = createDesktopTaskService(h.deps);
    await service.reconcileAll();
    assert.equal((await service.reconcile(task.id)).status, "timed_out");
    assert.equal(h.queue.reads, reads);
    if (stop === "close") {
      await assert.rejects(service.recover(task.id, controller), { code: "desktop_task_closed" });
    } else {
      const recovered = await service.recover(task.id, controller);
      assert.equal(recovered.status, "completed");
      assert.ok(recovered.unwatched_at);
      assert.equal(desktopTaskNeedsReconciliation(recovered), false);
    }
    assert.deepEqual(h.state.notifications.map(n => n.envelope.event.id), [task.id + ":timed_out"]);
    assert.equal(h.queue.writes, 1);
  }
});

test("expired Desktop Send history cannot become another native task or callback", async t => {
  const h = harness(t), request = { ...input, callbackRoute: route };
  const sent = await h.service.send(request);
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  assert.equal((await h.service.reconcile(sent.id)).status, "completed");
  const before = { starts: h.state.starts, observes: h.state.observes, deliveries: h.state.notifications.length };
  h.state.now += 48 * 3_600_000;
  assert.equal(collectExpiredWatchHistory({ storeDir: h.dir, now: new Date(h.state.now) }).deleted, 1);
  assert.deepEqual(h.repository.list(), []);
  const restored = createDesktopTaskService(h.deps);
  assert.throws(() => restored.status(sent.id), { code: "watch_history_expired", replay_forbidden: true });
  await assert.rejects(restored.send(request), { code: "watch_history_expired" });
  await assert.rejects(restored.send({ ...request, text: "Changed replay" }), { code: "watch_history_expired" });
  assert.deepEqual({ starts: h.state.starts, observes: h.state.observes, deliveries: h.state.notifications.length }, before);
});

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
  await assert.rejects(createDesktopTaskService(h.deps).send({ ...input, messageId: "second-message", requestId: "second-instruction" }), { code: "desktop_send_pending" });
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
    const rejected = await createDesktopTaskService(h.deps).send({ ...input, messageId: `blocked-${fresh.ownerClientId}-${fresh.pendingRequestCount}`, requestId: `intent-${fresh.ownerClientId}-${fresh.pendingRequestCount}` });
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

test("explicit Watch reads share a native-visible answer while directed callbacks stay with the original Send", async t => {
  const h = harness(t);
  const sent = await h.service.send({ ...input, callbackRoute: route });
  const controllerSession = "passive-controller";
  const watched = await h.service.watch({ ...input, controllerSession,
    callbackRoute: createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: controllerSession }) });
  assert.equal(watched.native_turn_id, sent.native_turn_id);
  const complete = turn("native-one", "completed", h.state.clientId);
  complete.items.push({ id: "final", type: "agentMessage", phase: "final_answer",
    answerDisplay: { version: 1, mode: "show", trustedContacts: "skip" }, text: "REQUESTER-ONLY" });
  h.state.snapshot = snapshot([complete]);
  const observer = await h.service.reconcile(watched.id);
  assert.equal(observer.status, "completed");
  assert.equal(desktopStoredAnswerForLookup(h.repository.load(watched.id)!).final_text, "REQUESTER-ONLY");
  assert.doesNotMatch(JSON.stringify(desktopTaskProjection(observer)), /REQUESTER-ONLY/);
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].route.controller_session_id, controllerSession);
  assert.doesNotMatch(JSON.stringify(h.state.notifications[0].envelope), /REQUESTER-ONLY/);
  assert.equal((await h.service.reconcile(sent.id)).final_text, "REQUESTER-ONLY");
  assert.equal(h.state.notifications.length, 2);
  assert.equal(h.state.notifications[1].route.controller_session_id, input.controllerSession);
  assert.match(h.state.notifications[1].envelope.event.body, /REQUESTER-ONLY/);
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
  assert.equal(event.metadata?.response_contract_verified, false);
  assert.match(event.body, /may continue working/); assert.match(event.body, /Refresh AKK Status/);
  assert.match(event.body, /after the user supplies an answer/); assert.match(event.body, /q:[a-f0-9]{64}/);
  assert.match(event.body, /o:[a-f0-9]{64}/);
  assert.doesNotMatch(JSON.stringify(event), /interaction_prompt_fingerprint|expires_at|available_actions/);
  await createDesktopTaskService(h.deps).reconcile(watched.id);
  assert.equal(h.state.notifications.length, 1); assert.equal(h.service.status(watched.id).notifications.length, 1);
});

test("Desktop async question notifications retain per-kind verification without suppressing response attempts", async t => {
  for (const asyncAnswers of [true, false]) {
    const h = harness(t); h.state.snapshot = snapshot([asyncQuestionTurn()]);
    const service = createDesktopTaskService({ ...h.deps, interactionResponsesVerified: {
      ...desktopCapabilityProfile(DESKTOP_CREATION_BUILD), blockingAnswers: !asyncAnswers, asyncAnswers } });
    const watched = await service.watch({ ...input, callbackRoute: route });
    assert.equal(watched.pending_async_interactions?.length, 1);
    const event = h.state.notifications[0].envelope.event;
    assert.equal(event.metadata?.action, "respond");
    assert.equal(event.metadata?.response_contract_verified, asyncAnswers);
    await service.reconcile(watched.id);
    assert.equal(h.state.notifications.length, 1);
  }
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
test("Desktop uncertain Sends retain their original management while new instructions can still reach an idle owner", async t => {
  const h = harness(t);
  h.deps.start = async (_target, options) => { await options.beforeDispatch?.(h.state.snapshot); h.state.starts++; throw new DesktopIpcError("timeout", "unknown", "unknown"); };
  const service = createDesktopTaskService(h.deps);
  const sent = await service.send({ ...input, timeoutMs: 1 }); h.state.now += 2;
  assert.equal((await service.reconcile(sent.id)).status, "timed_out");
  service.unwatch(sent.id, controller);
  const independent = { ...input, messageId: "another-message" };
  const next = await service.send(independent);
  assert.notEqual(next.id, sent.id); assert.equal(next.send_intent?.state, "uncertain");
  assert.equal(h.state.starts, 2);
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
  assert.equal((await createDesktopTaskService(h.deps).send(independent)).id, next.id);
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

test("an optional business key recovers a lost outer result across new tool calls and later settlement", async t => {
  const h = queueHarness(t);
  const restart = () => createDesktopTaskService(h.deps);
  const keyed = { ...input, requestId: "original-user-request" };
  const first = await h.service.send(keyed); // Discard outer result from the caller's perspective.
  assert.ok(first.send_intent?.queue_id);
  assert.equal((await restart().send({ ...keyed, messageId: "new-tool-call" })).id, first.id);
  await assert.rejects(restart().send({ ...keyed, messageId: "new-tool-call", text: "paraphrased retry" }), { code: "desktop_message_id_conflict" });
  await assert.rejects(restart().send({ ...keyed, controllerSession: "different-caller", messageId: "foreign-tool-call" }),
    { code: "desktop_message_id_conflict" });
  // A concurrent replay with a different tool id and the same business key still returns the first Watch.
  const repeated = await Promise.all(["retry-a", "retry-b"].map(messageId => restart().send({ ...keyed, messageId })));
  assert.ok(repeated.every(task => task.id === first.id));
  assert.equal(h.queue.writes, 1);
  h.queue.observation = { state: "matched", turn: turn("actual-turn", "completed") };
  assert.equal((await restart().reconcile(first.id)).status, "completed");
  assert.equal((await restart().send({ ...keyed, messageId: "retry-after-settlement" })).id, first.id);
  assert.equal(h.queue.writes, 1);
  // A different, independently authorized instruction can intentionally contain exactly the same text.
  h.queue.observation = { state: "pending", reason: "desktop_queue_turn_not_observed" };
  const second = await restart().send({ ...keyed, controllerSession: "different-caller", messageId: "independent-tool",
    requestId: "separate-user-instruction" });
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.send_intent!.client_user_message_id, first.send_intent!.client_user_message_id);
  assert.equal(h.queue.writes, 2);
});

test("an uncertain owner IPC request recovers on its original identity while independent queue instructions may use the same text", async t => {
  for (const keyed of [true, false]) {
    const h = queueHarness(t), queueOnly = h.deps.observe;
    h.deps.observe = async () => snapshot();
    h.deps.start = async (_target, options) => {
      await options.beforeDispatch?.(snapshot());
      h.state.starts++;
      throw new DesktopIpcError("timeout", "Original owner's acknowledgement was lost", "unknown");
    };
    const original = { ...input, ...(keyed ? {requestId: "previous-user-instruction"} : {}) };
    const old = await h.service.send(original);
    assert.equal(old.send_intent?.state, "uncertain");
    h.deps.observe = queueOnly;
    const rebooted = createDesktopTaskService(h.deps);
    assert.equal((await rebooted.send(original)).id, old.id);
    if (keyed) {
      assert.equal((await rebooted.send({ ...original, messageId: "new-invocation" })).id, old.id);
      await assert.rejects(rebooted.send({ ...original, messageId: "new-invocation", controllerSession: "another" }), { code: "desktop_message_id_conflict" });
    }
    await assert.rejects(rebooted.send({ ...original, text: "changed" }), { code: "desktop_message_id_conflict" });
    assert.equal(h.queue.writes, 0);
    const independent = { ...input, messageId: "independent-tool", requestId: "independent-request" };
    const next = await rebooted.send(independent);
    assert.notEqual(next.id, old.id);
    // A known business key wins if its new invocation ID previously belonged to another task.
    assert.equal((await rebooted.send({ ...independent, messageId: original.messageId })).id, next.id);
    for (const messageId of [original.messageId, independent.messageId]) {
      await assert.rejects(rebooted.send({ ...independent, messageId, requestId: "never-bound-request" }),
        { code: "desktop_message_id_conflict" });
    }
    assert.equal(h.queue.writes, 1);
    const ordinary = { ...input, messageId: "independent-ordinary-send" };
    const sameText = await rebooted.send(ordinary);
    assert.notEqual(sameText.id, old.id);
    assert.equal((await rebooted.send(ordinary)).id, sameText.id);
    const otherController = await rebooted.send({ ...ordinary, controllerSession: "another" });
    assert.notEqual(otherController.id, sameText.id);
    assert.equal(rebooted.status(old.id).send_intent?.delivery_path, undefined);
    assert.equal(rebooted.status(old.id).send_intent?.state, "uncertain");
    assert.equal(h.state.starts, 1);
    assert.equal(h.queue.writes, 3);
  }
});

test("a documented pre-dispatch legacy rejection leaves an independent queue Send available", async t => {
  const h = queueHarness(t), queueOnly = h.deps.observe;
  h.deps.observe = async () => snapshot();
  h.deps.start = async () => { throw new DesktopIpcError("owner_changed", "Owner changed before dispatch", "not_sent"); };
  const original = { ...input, requireEmptyThread: false };
  const old = await h.service.send(original);
  assert.equal(old.send_intent?.state, "not_sent");
  h.deps.observe = queueOnly;
  const restarted = createDesktopTaskService(h.deps);
  assert.equal((await restarted.send(input)).id, old.id);
  assert.equal(h.queue.writes, 0);
  const independent = { ...input, messageId: "new-invocation-with-its-own-key", requestId: "another-user-instruction" };
  const queued = await restarted.send(independent);
  assert.notEqual(queued.id, old.id);
  assert.ok(queued.send_intent?.queue_id);
  assert.equal((await restarted.send({ ...independent, messageId: original.messageId })).id, queued.id);
  assert.equal(h.queue.writes, 1);
});
