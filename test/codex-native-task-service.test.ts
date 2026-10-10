import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createTerminalWatchOpenClawCallbackRoute, type CallbackAttemptOutcome, type CallbackTransportDeliverInput } from "../src/callback-transport.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { createCodexNativeStateStore } from "../src/codex-native-state-store.js";
import { createCodexNativeTaskService, codexNativeTaskNeedsReconciliation, type CodexNativeTaskServiceDependencies } from "../src/codex-native-task-service.js";
import { CodexNativeError, type CodexNativeSnapshot, type CodexNativeTurn, type NativeInteraction } from "../src/codex-native-types.js";

const target = { codexHome: "/test/codex", threadId: "thread-exact" };
const input = { target, nativeId: createCodexNativeConversationId(target), controllerSession: "controller-one", messageId: "message-one", text: "Do this task" };
const route = createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: input.controllerSession });
function turn(id: string, status: CodexNativeTurn["status"] = "inProgress", clientId?: string, text = input.text): CodexNativeTurn {
  return { id, status, itemsComplete: true, items: clientId ? [{ id: `user-${id}`, type: "userMessage", clientId, content: [{ type: "text", text }] }] : [] };
}
function snapshot(turns: CodexNativeTurn[] = [], extra: Partial<CodexNativeSnapshot> = {}): CodexNativeSnapshot {
  const working = turns.some(t => t.status === "inProgress");
  return { threadId: target.threadId, loaded: true, latestTurnId: turns[0]?.id ?? null, turns,
    thread: { id: target.threadId, sessionId: "session", cwd: "/test", historyMode: "paginated", cliVersion: "0.160.0", originator: "codex_cli_rs", source: "cli", turns: [], status: working ? { type: "active", activeFlags: [] } : { type: "idle" } },
    pendingInteractions: [], canSend: !working, ...extra };
}
function harness(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-native-tasks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repository = createCodexNativeStateStore(dir, { acquire: () => () => {} });
  const state = { now: Date.parse("2026-10-09T00:00:00Z"), snapshot: snapshot(), starts: 0, clientId: "", sequence: 0,
    observations: [] as (string | undefined)[], notifications: [] as CallbackTransportDeliverInput[], outcomes: [] as CallbackAttemptOutcome[] };
  const deps: CodexNativeTaskServiceDependencies = { repository, now: () => new Date(state.now),
    acceptancePollAttempts: 3, sleep: async () => {},
    randomUUID: () => `00000000-0000-0000-0000-${String(++state.sequence).padStart(12, "0")}`,
    observe: async (_identity, exact) => { state.observations.push(exact); return structuredClone(state.snapshot); },
    start: async (_identity, options) => {
      assert.equal(repository.list().length, 1, "intent must exist before native mutation");
      await options.beforeDispatch?.(state.snapshot); state.starts++; state.clientId = options.clientUserMessageId;
      assert.equal(repository.list()[0].send_intent?.state, "uncertain");
      state.snapshot = snapshot([turn("native-one", "inProgress", state.clientId)]);
      return { turnId: "native-one", clientUserMessageId: state.clientId };
    },
    deliver: async delivery => { state.notifications.push(delivery); return state.outcomes.shift() ?? { disposition: "accepted", acceptance_id: "callback-one", accepted_at: new Date(state.now).toISOString() }; }
  };
  return { dir, repository, state, deps, service: createCodexNativeTaskService(deps) };
}
function pending(kind: NativeInteraction["kind"] = "blocking_question"): NativeInteraction {
  return { id: "native-interaction:one", kind, threadId: target.threadId, turnId: "native-one", itemId: "question-item", method: "item/tool/requestUserInput", requestId: 7,
    questions: [{ id: "native-question", title: "Choose a color", options: ["Blue", "Green"] }] };
}

test("direct CLI send persists once and only binds exact native user-message acceptance", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  assert.equal(sent.native_turn_id, "native-one"); assert.equal(sent.send_intent?.state, "accepted");
  assert.equal(sent.status, "watching");
  const restarted = createCodexNativeTaskService(h.deps);
  assert.equal((await restarted.send(input)).id, sent.id); assert.equal(h.state.starts, 1);
  await assert.rejects(restarted.send({ ...input, text: "different" }), { code: "codex_native_message_id_conflict" });
  await assert.rejects(restarted.send({ ...input, target: { ...target, threadId: "other-thread" } }), { code: "codex_native_message_id_conflict" });
});

test("concurrent send IDs share a reservation and never dispatch the same native task twice", async t => {
  const h = harness(t);
  const results = await Promise.all([h.service.send(input), createCodexNativeTaskService(h.deps).send(input)]);
  assert.equal(results[0].id, results[1].id); assert.equal(h.state.starts, 1);
});

test("uncertain send recovers exact history after restart without replay, title or cwd inference", async t => {
  const h = harness(t);
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++; h.state.clientId = options.clientUserMessageId;
    h.state.snapshot = snapshot([turn("native-other", "completed", "someone-else")]);
    throw new CodexNativeError("timeout", "lost receipt", "unknown");
  };
  const sent = await createCodexNativeTaskService(h.deps).send(input);
  assert.equal(sent.send_intent?.state, "uncertain"); assert.equal(sent.native_turn_id, undefined);
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  h.state.snapshot.turns[0].items.push({ id: "answer", type: "agentMessage", phase: "final_answer", text: "Finished exact task" });
  const recovered = await createCodexNativeTaskService(h.deps).reconcile(sent.id);
  assert.equal(recovered.native_turn_id, "native-one"); assert.equal(recovered.status, "completed");
  assert.equal(recovered.final_text, "Finished exact task"); assert.equal(h.state.starts, 1);
});

test("receipt alone and text-only matches cannot establish native acceptance", async t => {
  const h = harness(t);
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++;
    h.state.snapshot = snapshot([turn("native-one", "completed", "wrong-client")]);
    return { turnId: "native-one", clientUserMessageId: options.clientUserMessageId };
  };
  const sent = await createCodexNativeTaskService(h.deps).send(input);
  assert.equal(sent.send_intent?.state, "uncertain"); assert.equal(sent.native_turn_id, undefined);
  assert.equal(sent.send_intent?.receipt_turn_id, "native-one");
});

test("a native receipt waits briefly for exact user-message history without replaying the task", async t => {
  const h = harness(t); let sleeps = 0; let receiptReads = 0;
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++; h.state.clientId = options.clientUserMessageId;
    return { turnId: "native-one", clientUserMessageId: options.clientUserMessageId };
  };
  h.deps.observe = async (_identity, exact) => {
    if (exact === "native-one") receiptReads++;
    return structuredClone(h.state.snapshot);
  };
  h.deps.sleep = async delay => {
    assert.equal(delay, 100); sleeps++;
    h.state.snapshot = snapshot([turn("native-one", "inProgress", h.state.clientId)]);
  };
  const result = await createCodexNativeTaskService(h.deps).send(input);
  assert.equal(result.native_turn_id, "native-one"); assert.equal(result.send_intent?.state, "accepted");
  assert.equal(result.status, "watching"); assert.equal(sleeps, 1); assert.ok(receiptReads >= 2);
  assert.equal(h.state.starts, 1);
});

test("acceptance polling is bounded and does not wait on an ambiguous send without a native receipt", async t => {
  const h = harness(t); let sleeps = 0;
  h.deps.sleep = async () => { sleeps++; };
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++;
    return { turnId: "native-one", clientUserMessageId: options.clientUserMessageId };
  };
  const service = createCodexNativeTaskService(h.deps);
  const unmaterialized = await service.send(input);
  assert.equal(unmaterialized.send_intent?.state, "uncertain"); assert.equal(unmaterialized.native_turn_id, undefined);
  assert.equal(sleeps, 2); assert.equal(h.state.starts, 1);
  // Retire this managed task so the independent uncertainty case can reserve this idle thread.
  service.close(unmaterialized.id, { controllerSession: input.controllerSession });
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++; throw new CodexNativeError("timeout", "missing receipt", "unknown");
  };
  const unknown = await service.send({ ...input, messageId: "unknown-message" });
  assert.equal(unknown.send_intent?.receipt_turn_id, undefined); assert.equal(sleeps, 2); assert.equal(h.state.starts, 2);
});

test("not-sent and unknown-acceptance timeout callbacks survive durable serialization without an anchor", async t => {
  const h = harness(t);
  h.deps.start = async () => { throw new CodexNativeError("thread_not_idle", "busy before dispatch", "not_sent"); };
  const notSent = await createCodexNativeTaskService(h.deps).send({ ...input, callbackRoute: route });
  assert.equal(notSent.status, "failed"); assert.equal(notSent.notifications[0].status, "accepted");
  assert.equal(h.repository.load(notSent.id)?.native_turn_id, undefined);
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); throw new CodexNativeError("timeout", "lost receipt", "unknown");
  };
  const uncertain = await createCodexNativeTaskService(h.deps).send({ ...input, messageId: "timeout-message", callbackRoute: route, timeoutMs: 1 });
  h.state.now += 2;
  const expired = await h.service.reconcile(uncertain.id);
  assert.equal(expired.status, "timed_out"); assert.equal(expired.notifications[0].status, "accepted");
});

test("post-receipt reconciliation reads exact old turn even when another task becomes the latest", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  const watched = turn("native-one", "completed", h.state.clientId);
  watched.items.push({ id: "answer", type: "agentMessage", text: "exact final", phase: "final_answer" });
  h.state.snapshot = snapshot([turn("newer-task")], { selectedTurn: watched });
  const result = await h.service.reconcile(sent.id);
  assert.equal(h.state.observations.at(-1), "native-one"); assert.equal(result.final_text, "exact final");
  assert.equal(result.status, "completed"); assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].envelope.source.kind, "codex_native_watch");
});

test("Watch binds one active turn, emits actionable questions once, and omits transient RPC IDs", async t => {
  const h = harness(t); h.state.snapshot = snapshot([turn("native-one")], { pendingInteractions: [pending()] });
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  assert.equal(watched.native_turn_id, "native-one"); assert.equal(watched.pending_interactions.length, 1);
  assert.equal(Object.hasOwn(watched.pending_interactions[0], "requestId"), false);
  const event = h.state.notifications[0].envelope.event;
  assert.equal(event.requires_response, true); assert.equal(event.metadata?.interaction_id, "native-interaction:one");
  const advertised = event.metadata?.interaction as { questions: { question_id: string }[]; available_actions: unknown };
  assert.match(advertised.questions[0].question_id, /^q:/); assert.ok(advertised.available_actions);
  assert.ok(event.body.includes(advertised.questions[0].question_id), "chat.send carries the body, so answer IDs must be present there too");
  await h.service.reconcile(watched.id); assert.equal(h.state.notifications.length, 1);
  h.state.snapshot = snapshot([turn("native-one", "completed")]);
  const done = await h.service.reconcile(watched.id);
  assert.equal(done.pending_interactions.length, 0); assert.equal(done.status, "completed");
});

test("inactive and ambiguous native tasks cannot become exact Watch anchors", async t => {
  const h = harness(t);
  await assert.rejects(h.service.watch(input), { code: "no_active_task" });
  h.state.snapshot = snapshot([turn("native-one"), turn("native-two")]);
  await assert.rejects(h.service.watch(input), { code: "no_active_task" });
  assert.equal(h.repository.list().length, 0);
});

test("partial history never settles a Watch and retryable callbacks use durable retry authorization", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([{ ...turn("native-one", "completed", h.state.clientId), itemsComplete: false }]);
  assert.equal((await h.service.reconcile(sent.id)).status, "watching"); assert.equal(h.state.notifications.length, 0);
  h.state.snapshot.turns[0].itemsComplete = true;
  h.state.outcomes.push({ disposition: "retryable_failure", error_code: "unavailable_before_dispatch" });
  const failed = await h.service.reconcile(sent.id); assert.equal(failed.notifications[0].status, "retry_wait");
  await h.service.reconcile(sent.id); assert.equal(h.state.notifications.length, 1);
  h.state.now += 5000;
  const accepted = await h.service.reconcile(sent.id); assert.equal(accepted.notifications[0].status, "accepted");
  assert.equal(h.state.notifications.length, 2); assert.equal(codexNativeTaskNeedsReconciliation(accepted), false);
});

test("uncertain callback and expired delivery lease are never automatically replayed", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  h.state.outcomes.push({ disposition: "uncertain", error_code: "lost_ack", observed_at: new Date(h.state.now).toISOString() });
  const uncertain = await h.service.reconcile(sent.id); assert.equal(uncertain.notifications[0].status, "uncertain");
  await createCodexNativeTaskService(h.deps).reconcile(sent.id); assert.equal(h.state.notifications.length, 1);
  const record = h.repository.load(sent.id)!; record.notifications[0].status = "leased";
  record.notifications[0].attempt_id = "old-attempt"; record.notifications[0].lease_expires_at = new Date(h.state.now - 1).toISOString();
  h.repository.save(record, record.revision);
  const expired = await h.service.reconcile(sent.id); assert.equal(expired.notifications[0].status, "uncertain");
  assert.equal(h.state.notifications.length, 1);
});

test("durable accepted transport checkpoint wins over a later ambiguous return", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  h.deps.deliver = async delivery => {
    delivery.reportCheckpoint?.({ disposition: "accepted", acceptance_id: "gateway-run", accepted_at: new Date(h.state.now).toISOString() });
    throw new Error("lost final transport output");
  };
  const result = await createCodexNativeTaskService(h.deps).reconcile(sent.id);
  assert.equal(result.notifications[0].status, "accepted");
});

test("late accepted checkpoint settles the same expired delivery attempt without resending", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  let release!: (outcome: CallbackAttemptOutcome) => void;
  const delivery = new Promise<CallbackAttemptOutcome>(resolve => { release = resolve; });
  let announce!: () => void; const dispatched = new Promise<void>(resolve => { announce = resolve; });
  let request!: CallbackTransportDeliverInput;
  h.deps.deliver = async value => { request = value; h.state.notifications.push(value); announce(); return delivery; };
  const original = createCodexNativeTaskService(h.deps).reconcile(sent.id);
  await dispatched;
  h.state.now += 30_001;
  const expired = await h.service.reconcile(sent.id);
  assert.equal(expired.notifications[0].status, "uncertain");
  assert.equal(expired.notifications[0].outcome?.disposition, "uncertain");
  assert.equal(h.state.notifications.length, 1);
  request.reportCheckpoint?.({ disposition: "accepted", acceptance_id: "late-gateway-ack", accepted_at: new Date(h.state.now).toISOString() });
  release({ disposition: "uncertain", error_code: "lost_final_output", observed_at: new Date(h.state.now).toISOString() });
  const settled = await original;
  assert.equal(settled.notifications[0].status, "accepted"); assert.equal(settled.notifications[0].attempts, 1);
  assert.equal(settled.notifications[0].attempt_id, expired.notifications[0].attempt_id);
  assert.equal(h.state.notifications.length, 1);
});

test("Unwatch revokes queued callbacks without cancelling or sending to the native task", async t => {
  const h = harness(t); h.state.snapshot = snapshot([turn("native-one")]);
  const watched = await h.service.watch(input);
  assert.throws(() => h.service.unwatch(watched.id, { controllerSession: "wrong-controller" }), { code: "codex_native_controller_mismatch" });
  assert.ok(h.service.unwatch(watched.id, { controllerSession: input.controllerSession }).unwatched_at);
  assert.equal(h.service.status(watched.id).status, "watching");
  assert.equal(h.state.starts, 0); assert.equal(h.state.snapshot.turns[0].status, "inProgress");
});

test("native record store rejects anchor changes and isolates malformed records during recovery", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  assert.throws(() => h.repository.save({ ...sent, native_turn_id: "different-turn" }, sent.revision), /anchor cannot change/);
  const root = path.join(h.dir, "codex-native-tasks");
  const corrupt = path.join(root, "codex-cli-watch:corrupt00.json"); fs.writeFileSync(corrupt, "{", { mode: 0o600 });
  const scan = h.repository.scanForReconciliation(); assert.equal(scan.tasks.length, 1); assert.equal(scan.errors.length, 1);
  assert.throws(() => h.repository.list());
  fs.unlinkSync(corrupt); fs.symlinkSync(path.join(root, `${sent.id}.json`), corrupt);
  assert.throws(() => h.repository.scanForReconciliation(), /owner-private/);
});

test("send management remains owned after Unwatch, while Close permanently retires the original task", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  const unwatched = h.service.unwatch(sent.id, { controllerSession: input.controllerSession });
  assert.equal(unwatched.status, "watching"); assert.ok(unwatched.unwatched_at);
  const reads = h.state.observations.length;
  await h.service.reconcile(sent.id);
  assert.equal(h.state.observations.length, reads); assert.equal(codexNativeTaskNeedsReconciliation(unwatched), false);
  const closed = h.service.close(sent.id, { controllerSession: input.controllerSession, reason: "Owner finished" });
  assert.equal(closed.status, "watching"); assert.equal(closed.close_reason, "Owner finished"); assert.ok(closed.closed_at);
  for (const operation of [() => h.service.renew(sent.id, { controllerSession: input.controllerSession }),
    () => h.service.recover(sent.id, { controllerSession: input.controllerSession }),
    () => h.service.retryCallback(sent.id, { controllerSession: input.controllerSession })]) {
    await assert.rejects(operation(), { code: "codex_native_task_closed" });
  }
  assert.equal(h.state.observations.length, reads); assert.equal(h.state.starts, 1);
  const passive = await h.service.watch(input);
  assert.throws(() => h.service.close(passive.id, { controllerSession: input.controllerSession }), { code: "codex_native_unmanaged_watch" });
});

test("all owner-only task mutations fail before transport observation or callback delivery", async t => {
  const h = harness(t); const sent = await h.service.send(input); const reads = h.state.observations.length;
  const foreign = { controllerSession: "another-owner" };
  assert.throws(() => h.service.close(sent.id, foreign), { code: "codex_native_controller_mismatch" });
  assert.throws(() => h.service.unwatch(sent.id, foreign), { code: "codex_native_controller_mismatch" });
  for (const operation of [h.service.renew.bind(h.service), h.service.recover.bind(h.service), h.service.retryCallback.bind(h.service)]) {
    await assert.rejects(operation(sent.id, foreign), { code: "codex_native_controller_mismatch" });
  }
  assert.equal(h.state.observations.length, reads); assert.equal(h.state.notifications.length, 0);
});

test("expired recovery reads the original turn, preserves deadline, and does not follow a newer task", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, timeoutMs: 1 });
  h.state.now += 2; assert.equal((await h.service.reconcile(sent.id)).status, "timed_out");
  h.state.snapshot = snapshot([turn("newer-task")], { selectedTurn: turn("native-one", "completed", h.state.clientId) });
  h.state.snapshot.selectedTurn!.items.push({ id: "answer", type: "agentMessage", text: "original result", phase: "final_answer" });
  const recovered = await createCodexNativeTaskService(h.deps).recover(sent.id, { controllerSession: input.controllerSession });
  assert.equal(recovered.status, "completed"); assert.equal(recovered.final_text, "original result");
  assert.equal(recovered.deadline_at, sent.deadline_at); assert.ok(recovered.recovered_at);
  assert.equal(h.state.observations.at(-1), "native-one"); assert.equal(h.state.starts, 1);
});

test("unwatched recovery refreshes original evidence without resuming observation or callbacks", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  h.service.unwatch(sent.id, { controllerSession: input.controllerSession });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  const recovered = await h.service.recover(sent.id, { controllerSession: input.controllerSession });
  assert.equal(recovered.status, "completed"); assert.ok(recovered.unwatched_at);
  assert.equal(recovered.notifications.length, 0); assert.equal(codexNativeTaskNeedsReconciliation(recovered), false);
});

test("uncertain native reservations remain blocking after timeout and Unwatch until explicitly closed", async t => {
  const h = harness(t);
  h.deps.start = async (_identity, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.starts++;
    throw new CodexNativeError("timeout", "lost receipt", "unknown");
  };
  const service = createCodexNativeTaskService(h.deps);
  const sent = await service.send({ ...input, timeoutMs: 1 });
  h.state.now += 2; await service.reconcile(sent.id);
  await assert.rejects(service.send({ ...input, messageId: "new-message" }), { code: "codex_native_send_pending" });
  service.unwatch(sent.id, { controllerSession: input.controllerSession });
  await assert.rejects(createCodexNativeTaskService(h.deps).send({ ...input, messageId: "new-message" }), { code: "codex_native_send_pending" });
  service.close(sent.id, { controllerSession: input.controllerSession });
  await service.send({ ...input, messageId: "new-message" });
  assert.equal(h.state.starts, 2);
});

test("Renew resumes only the original active turn and retires each older timeout generation", async t => {
  const h = harness(t); h.deps.deliver = undefined;
  const service = createCodexNativeTaskService(h.deps);
  const sent = await service.send({ ...input, callbackRoute: route, timeoutMs: 1 });
  h.state.now += 2; const expired = await service.reconcile(sent.id);
  assert.equal(expired.status, "timed_out"); assert.equal(expired.notifications[0].status, "ready");
  service.unwatch(sent.id, { controllerSession: input.controllerSession });
  h.state.snapshot = snapshot([turn("newer-task")], { selectedTurn: turn("native-one", "inProgress", h.state.clientId) });
  const renewed = await createCodexNativeTaskService(h.deps).renew(sent.id, { controllerSession: input.controllerSession, timeoutMs: 10 });
  assert.equal(renewed.status, "watching"); assert.equal(renewed.unwatched_at, undefined); assert.equal(renewed.renewal_count, 1);
  assert.ok(Date.parse(renewed.deadline_at) > Date.parse(expired.deadline_at));
  assert.equal(renewed.notifications[0].outcome?.disposition, "permanent_failure");
  h.state.now += 11; const reexpired = await service.reconcile(sent.id);
  assert.equal(reexpired.notifications.length, 2); assert.notEqual(reexpired.notifications[0].id, reexpired.notifications[1].id);
  assert.equal(reexpired.notifications[1].status, "ready"); assert.equal(h.state.starts, 1);
  for (const timeoutMs of [0, 604_800_001, 1.5]) await assert.rejects(service.renew(sent.id, { controllerSession: input.controllerSession, timeoutMs }), { code: "invalid_argument" });
});

test("Renew records original completion without inventing an active observation or extending its deadline", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, timeoutMs: 1 });
  h.state.now += 2; await h.service.reconcile(sent.id);
  h.state.snapshot = snapshot([turn("newer-task")], { selectedTurn: turn("native-one", "completed", h.state.clientId) });
  const done = await h.service.renew(sent.id, { controllerSession: input.controllerSession, timeoutMs: 100 });
  assert.equal(done.status, "completed"); assert.equal(done.deadline_at, sent.deadline_at); assert.equal(done.renewal_count, undefined);
  assert.equal(codexNativeTaskNeedsReconciliation(done), false);
});

test("Close wins over an in-flight recovery and a failed in-flight callback never restarts retries", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  let finishObservation!: (value: CodexNativeSnapshot) => void;
  h.deps.observe = async () => new Promise(resolve => { finishObservation = resolve; });
  const service = createCodexNativeTaskService(h.deps);
  const recovering = service.recover(sent.id, { controllerSession: input.controllerSession });
  service.close(sent.id, { controllerSession: input.controllerSession });
  finishObservation(snapshot([turn("native-one", "completed", h.state.clientId)]));
  await assert.rejects(recovering, { code: "codex_native_task_closed" });
  assert.equal(service.status(sent.id).status, "watching"); assert.equal(h.state.notifications.length, 0);
});

test("a failed callback already in flight may settle after Unwatch but cannot restart retries", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  let release!: (outcome: CallbackAttemptOutcome) => void;
  let announce!: () => void; const dispatched = new Promise<void>(resolve => { announce = resolve; });
  h.deps.deliver = async value => { h.state.notifications.push(value); announce(); return new Promise(resolve => { release = resolve; }); };
  const service = createCodexNativeTaskService(h.deps); const reconciling = service.reconcile(sent.id);
  await dispatched; service.unwatch(sent.id, { controllerSession: input.controllerSession });
  release({ disposition: "retryable_failure", error_code: "temporarily_unavailable" });
  const stopped = await reconciling;
  assert.equal(stopped.notifications[0].status, "failed"); assert.ok(stopped.unwatched_at);
  h.state.now += 100_000; await service.reconcile(sent.id); assert.equal(h.state.notifications.length, 1);
});

test("manual retry preserves callback identity and cumulative attempts with exactly one exhausted-budget grant", async t => {
  const h = harness(t); h.deps.maxDeliveryAttempts = 1;
  h.deps.deliver = async value => { h.state.notifications.push(value); return { disposition: "retryable_failure", error_code: "temporarily_unavailable" }; };
  const service = createCodexNativeTaskService(h.deps); const sent = await service.send({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  const failed = await service.reconcile(sent.id); assert.equal(failed.notifications[0].status, "failed");
  const note = failed.notifications[0];
  const retried = await createCodexNativeTaskService(h.deps).retryCallback(sent.id, { controllerSession: input.controllerSession, notificationId: note.id });
  assert.equal(retried.notifications[0].attempts, 2); assert.equal(retried.notifications[0].status, "failed");
  assert.deepEqual(retried.notifications[0].envelope, note.envelope); assert.equal(retried.notifications[0].id, note.id);
  h.state.now += 100_000; await service.reconcile(sent.id); assert.equal(h.state.notifications.length, 2);
  assert.equal(h.state.notifications[0].attempt.number, 1); assert.equal(h.state.notifications[1].attempt.number, 2);
  assert.equal(h.state.starts, 1);
});

test("manual callback retry rejects accepted, uncertain, and stale interaction delivery", async t => {
  const h = harness(t); h.state.snapshot = snapshot([turn("native-one")], { pendingInteractions: [pending()] });
  h.state.outcomes.push({ disposition: "retryable_failure", error_code: "temporarily_unavailable" });
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  h.state.snapshot.pendingInteractions = [];
  await assert.rejects(h.service.retryCallback(watched.id, { controllerSession: input.controllerSession }), { code: "codex_native_callback_stale" });
  assert.equal(h.state.observations.at(-1), "native-one"); assert.equal(h.state.notifications.length, 1);
  assert.equal(h.service.status(watched.id).notifications[0].outcome?.disposition, "permanent_failure");
  for (const disposition of ["accepted", "uncertain"] as const) {
    h.state.snapshot.pendingInteractions = [pending()];
    h.state.outcomes.push(disposition === "accepted" ? { disposition, acceptance_id: "receipt", accepted_at: new Date(h.state.now).toISOString() }
      : { disposition, error_code: "lost_ack", observed_at: new Date(h.state.now).toISOString() });
    const other = await h.service.watch({ ...input, callbackRoute: route });
    const count = h.state.observations.length;
    await assert.rejects(h.service.retryCallback(other.id, { controllerSession: input.controllerSession }), { code: "codex_native_callback_not_retryable" });
    assert.equal(h.state.observations.length, count);
  }
});

test("renewal rejects a stale observation when Unwatch takes effect while the original turn is read", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  let finish!: (value: CodexNativeSnapshot) => void;
  h.deps.observe = async () => new Promise(resolve => { finish = resolve; });
  const service = createCodexNativeTaskService(h.deps);
  const renewing = service.renew(sent.id, { controllerSession: input.controllerSession });
  const stopped = service.unwatch(sent.id, { controllerSession: input.controllerSession });
  finish(structuredClone(h.state.snapshot));
  await assert.rejects(renewing, { code: "codex_native_task_changed" });
  assert.equal(service.status(sent.id).unwatched_at, stopped.unwatched_at);
  assert.equal(service.status(sent.id).renewal_count, undefined);
});

test("failed in-flight timeout delivery cannot retry an obsolete renewal generation", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route, timeoutMs: 1 });
  let release!: (outcome: CallbackAttemptOutcome) => void;
  let announce!: () => void; const dispatched = new Promise<void>(resolve => { announce = resolve; });
  h.deps.deliver = async value => { h.state.notifications.push(value); announce(); return new Promise(resolve => { release = resolve; }); };
  const service = createCodexNativeTaskService(h.deps); h.state.now += 2;
  const timingOut = service.reconcile(sent.id); await dispatched;
  const renewed = await service.renew(sent.id, { controllerSession: input.controllerSession, timeoutMs: 100_000 });
  assert.equal(renewed.renewal_count, 1);
  release({ disposition: "retryable_failure", error_code: "temporarily_unavailable" });
  const settled = await timingOut;
  assert.equal(settled.notifications[0].outcome?.disposition, "permanent_failure");
  await assert.rejects(service.retryCallback(sent.id, { controllerSession: input.controllerSession }), { code: "codex_native_callback_not_retryable" });
  assert.equal(h.state.notifications.length, 1);
});

test("stopped callbacks finish expired leases locally without native observation or replay", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  h.deps.deliver = undefined;
  const service = createCodexNativeTaskService(h.deps); const settled = await service.reconcile(sent.id);
  settled.notifications[0].status = "leased"; settled.notifications[0].attempts = 1;
  settled.notifications[0].attempt_id = "interrupted-process";
  settled.notifications[0].lease_expires_at = new Date(h.state.now + 30_000).toISOString();
  h.repository.save(settled, settled.revision);
  const stopped = service.close(sent.id, { controllerSession: input.controllerSession });
  assert.equal(codexNativeTaskNeedsReconciliation(stopped), true);
  const reads = h.state.observations.length; h.state.now += 30_001;
  const expired = await createCodexNativeTaskService(h.deps).reconcile(sent.id);
  assert.equal(expired.notifications[0].status, "uncertain"); assert.equal(codexNativeTaskNeedsReconciliation(expired), false);
  assert.equal(h.state.observations.length, reads); assert.equal(h.state.notifications.length, 0);
});

test("Recover keeps legacy cancelled records stopped when the original task completes", async t => {
  const h = harness(t); const sent = await h.service.send({ ...input, callbackRoute: route });
  const legacy = { ...sent, status: "cancelled" as const }; h.repository.save(legacy, legacy.revision);
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  const recovered = await h.service.recover(sent.id, { controllerSession: input.controllerSession });
  assert.equal(recovered.status, "completed"); assert.equal(recovered.unwatched_at, legacy.updated_at);
  assert.equal(recovered.notifications.length, 0); assert.equal(codexNativeTaskNeedsReconciliation(recovered), false);
});

test("Renew preserves durable settled proof when the original turn appears active in a stale snapshot", async t => {
  const h = harness(t); const sent = await h.service.send(input);
  h.state.snapshot = snapshot([turn("native-one", "completed", h.state.clientId)]);
  h.state.snapshot.turns[0].items.push({ id: "final", type: "agentMessage", phase: "final_answer", text: "Durable completion" });
  const completed = await h.service.reconcile(sent.id);
  h.state.snapshot = snapshot([turn("native-one", "inProgress", h.state.clientId)]);
  const renewed = await h.service.renew(sent.id, { controllerSession: input.controllerSession, timeoutMs: 604_800_000 });
  assert.equal(renewed.status, "completed"); assert.equal(renewed.final_text, "Durable completion");
  assert.equal(renewed.deadline_at, completed.deadline_at); assert.equal(renewed.renewal_count, undefined);
  assert.equal(codexNativeTaskNeedsReconciliation(renewed), false); assert.equal(h.state.starts, 1);
});
