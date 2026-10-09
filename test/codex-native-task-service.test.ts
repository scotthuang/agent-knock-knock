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
  // Cancel observation so the independent uncertainty case can reserve this idle thread.
  service.unwatch(unmaterialized.id, { controllerSession: input.controllerSession });
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
  assert.equal(h.service.unwatch(watched.id, { controllerSession: input.controllerSession }).status, "cancelled");
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
