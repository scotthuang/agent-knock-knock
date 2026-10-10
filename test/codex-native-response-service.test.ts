import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { createCodexNativeStateStore } from "../src/codex-native-state-store.js";
import { createCodexNativeTaskService } from "../src/codex-native-task-service.js";
import { createCodexNativeResponseService, createCodexNativeResponseStore, type NativeResponseDependencies, type NativeResponseInput } from "../src/codex-native-response-service.js";
import { buildNativeAsyncReply } from "../src/codex-native-client-interactions.js";
import { CodexNativeError, type NativeInteraction, type CodexNativeSnapshot } from "../src/codex-native-types.js";

const target = { codexHome: "/test/codex", threadId: "thread-exact" };
const nativeId = createCodexNativeConversationId(target);
function interaction(kind: NativeInteraction["kind"] = "command_approval"): NativeInteraction {
  return { id: "native-interaction:one", kind, threadId: target.threadId, turnId: "native-one", itemId: "request-item", method: kind === "command_approval" ? "item/commandExecution/requestApproval" : "item/tool/requestUserInput", requestId: 7,
    ...(kind === "command_approval" ? { command: "printf OK", availableDecisions: ["accept", "decline"] } : {}),
    questions: kind.endsWith("question") ? [{ id: kind === "async_question" ? JSON.stringify(["request_user_input_async", "request-item", 0]) : "color", title: "Choose a color", options: ["Blue", "Green"] }] : [] };
}
function harness(t: TestContext, pending = interaction()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-native-responses-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repository = createCodexNativeResponseStore(dir, { acquire: () => () => {} });
  const tasks = createCodexNativeStateStore(dir, { acquire: () => () => {} });
  const snapshot: CodexNativeSnapshot = { threadId: target.threadId, loaded: true, latestTurnId: "native-one", canSend: false,
    thread: { id: target.threadId, sessionId: "session-one", cwd: "/test", historyMode: "paginated", cliVersion: "0.160.0", originator: "codex-tui", source: "cli", turns: [], status: { type: "active", activeFlags: ["waitingOnApproval"] } },
    turns: [{ id: "native-one", status: "inProgress", itemsComplete: true, items: [{ id: "request-item", type: "commandExecution", status: "inProgress" }] }], pendingInteractions: [pending] };
  const state = { snapshot, responses: 0, asyncAnswers: 0, clientId: "" };
  const deps: NativeResponseDependencies = { repository, tasks,
    observe: async () => structuredClone(state.snapshot),
    respond: async () => {
      assert.equal(repository.list()[0].state, "uncertain", "durable intent precedes native response"); state.responses++;
      state.snapshot.pendingInteractions = []; state.snapshot.turns[0].items[0].status = "completed";
      return { dispatchState: "sent" };
    },
    answerAsync: async (_target, question, input) => {
      assert.equal(repository.list()[0].state, "uncertain"); state.asyncAnswers++; state.clientId = input.clientUserMessageId;
      state.snapshot.pendingInteractions = [];
      state.snapshot.turns[0].items.push({ id: "answer-user", type: "userMessage", clientId: input.clientUserMessageId, content: [{ type: "text", text: buildNativeAsyncReply(question, input.answer) }] });
      return { turnId: question.turnId, clientUserMessageId: input.clientUserMessageId };
    } };
  const input: NativeResponseInput = { target, nativeId, controllerSession: "controller-one", interactionId: pending.id, responseId: "response-one", response: { decision: "accept" } };
  return { dir, repository, tasks, state, deps, input, service: createCodexNativeResponseService(deps) };
}

test("approval response persists once, uses fresh connection identity, and requires actual item progress", async t => {
  const h = harness(t); const result = await h.service.respond(h.input);
  assert.equal(result.state, "confirmed"); assert.equal(result.evidence, "native_item_advanced");
  assert.equal(Object.hasOwn(result.interaction, "requestId"), false);
  assert.equal((await createCodexNativeResponseService(h.deps).respond(h.input)).id, result.id); assert.equal(h.state.responses, 1);
  await assert.rejects(h.service.respond({ ...h.input, response: { decision: "decline" } }), { code: "codex_native_response_conflict" });
});

test("pending-request disappearance alone does not claim a successful native answer", async t => {
  const h = harness(t);
  h.deps.respond = async () => { h.state.responses++; h.state.snapshot.pendingInteractions = []; return { dispatchState: "sent" }; };
  const result = await createCodexNativeResponseService(h.deps).respond(h.input);
  assert.equal(result.state, "sent"); assert.equal(result.evidence, undefined);
  h.state.snapshot.turns[0].status = "completed";
  const observed = await h.service.reconcile(result.id); assert.equal(observed.state, "confirmed"); assert.equal(observed.evidence, "native_turn_settled");
});

test("a crash before the response dispatch boundary cannot become confirmation when the native task ends", async t => {
  const h = harness(t);
  h.deps.respond = async () => { throw new CodexNativeError("stale_interaction", "never dispatched", "not_sent"); };
  const first = await createCodexNativeResponseService(h.deps).respond(h.input);
  // Model the durable reservation left by a process that never reached the dispatch-state write.
  h.repository.save({ ...first, state: "reserved", error_code: undefined }, first.revision);
  h.state.snapshot.pendingInteractions = []; h.state.snapshot.turns[0].status = "interrupted";
  const recovered = await createCodexNativeResponseService(h.deps).reconcile(first.id);
  assert.equal(recovered.state, "reserved"); assert.equal(recovered.evidence, undefined); assert.equal(h.state.responses, 0);
  assert.equal((await h.service.respond(h.input)).state, "reserved"); assert.equal(h.state.responses, 0);
});

test("uncertain response never replays after connection loss and can recover native continuation", async t => {
  const h = harness(t);
  h.deps.respond = async () => { h.state.responses++; throw new CodexNativeError("closed", "lost response", "unknown"); };
  const result = await createCodexNativeResponseService(h.deps).respond(h.input); assert.equal(result.state, "uncertain");
  await h.service.respond(h.input); assert.equal(h.state.responses, 1);
  h.state.snapshot.pendingInteractions = []; h.state.snapshot.turns[0].status = "completed";
  assert.equal((await h.service.reconcile(result.id)).state, "confirmed"); assert.equal(h.state.responses, 1);
});

test("explicit identical retry can recover a proven not-sent response while preserving the failed attempt", async t => {
  const h = harness(t); const answer = h.deps.respond;
  h.deps.respond = async () => { throw new CodexNativeError("unsupported_capability", "preview not materialized", "not_sent"); };
  const rejected = await createCodexNativeResponseService(h.deps).respond(h.input);
  assert.equal(rejected.state, "not_sent"); assert.equal(rejected.attempts, 1); assert.equal(h.state.responses, 0);
  await h.service.reconcile(rejected.id); assert.equal(h.state.responses, 0, "observation never retries");
  await assert.rejects(h.service.respond({ ...h.input, response: { decision: "decline" } }), { code: "codex_native_response_conflict" });
  h.deps.respond = answer;
  const retried = await createCodexNativeResponseService(h.deps).respond(h.input);
  assert.equal(retried.id, rejected.id); assert.equal(retried.state, "confirmed"); assert.equal(retried.attempts, 2);
  assert.deepEqual(retried.not_sent_history, [{ attempt: 1, observed_at: rejected.updated_at, error_code: "unsupported_capability" }]);
  assert.equal(h.state.responses, 1);
  await h.service.respond(h.input); assert.equal(h.state.responses, 1);
});

test("known-not-sent retry still requires the current interaction and a single concurrent dispatch claim", async t => {
  const h = harness(t); const answer = h.deps.respond;
  h.deps.respond = async () => { throw new CodexNativeError("stale_interaction", "not delivered", "not_sent"); };
  const rejected = await createCodexNativeResponseService(h.deps).respond(h.input);
  h.state.snapshot.pendingInteractions = [];
  await assert.rejects(h.service.respond(h.input), { code: "stale_interaction" });
  assert.equal(h.service.status(rejected.id).attempts, 1);
  h.state.snapshot.pendingInteractions = [interaction()]; h.deps.respond = answer;
  const [a, b] = await Promise.all([h.service.respond(h.input), createCodexNativeResponseService(h.deps).respond(h.input)]);
  assert.equal(a.id, b.id); assert.equal(h.state.responses, 1); assert.equal(h.service.status(rejected.id).attempts, 2);
});

test("concurrent responders cannot approve the same interaction twice", async t => {
  const h = harness(t); const [a, b] = await Promise.all([h.service.respond(h.input), createCodexNativeResponseService(h.deps).respond(h.input)]);
  assert.equal(a.id, b.id); assert.equal(h.state.responses, 1);
});

test("blocking response correlates every question, and only records continuation evidence", async t => {
  const h = harness(t, interaction("blocking_question"));
  const input = { ...h.input, response: { answers: { color: ["Green"] } } };
  h.deps.respond = async (_target, _interaction, response) => {
    assert.deepEqual(response, { answers: { color: ["Green"] } }); h.state.responses++;
    h.state.snapshot.pendingInteractions = [];
    h.state.snapshot.turns[0].items.push({ id: "after-answer", type: "agentMessage", text: "Continuing" }); return { dispatchState: "sent" };
  };
  const result = await createCodexNativeResponseService(h.deps).respond(input);
  assert.equal(result.state, "confirmed"); assert.equal(result.evidence, "native_task_continued");
});

test("async response is confirmed by exact client ID, turn and native question answer envelope", async t => {
  const h = harness(t, interaction("async_question"));
  const input = { ...h.input, response: { answer: "Green" } };
  const result = await h.service.respond(input);
  assert.equal(result.state, "confirmed"); assert.equal(result.evidence, "exact_async_answer_observed");
  assert.equal(h.state.asyncAnswers, 1); assert.equal(h.state.responses, 0);
  assert.equal((await h.service.respond(input)).id, result.id); assert.equal(h.state.asyncAnswers, 1);
});

test("async RPC receipt and wrong answer text cannot stand in for exact answer history", async t => {
  const h = harness(t, interaction("async_question"));
  h.deps.answerAsync = async (_target, question, input) => {
    h.state.asyncAnswers++; h.state.snapshot.pendingInteractions = [];
    h.state.snapshot.turns[0].items.push({ id: "wrong-answer", type: "userMessage", clientId: input.clientUserMessageId, content: [{ type: "text", text: buildNativeAsyncReply(question, "Blue") }] });
    return { turnId: question.turnId, clientUserMessageId: input.clientUserMessageId };
  };
  const result = await createCodexNativeResponseService(h.deps).respond({ ...h.input, response: { answer: "Green" } });
  assert.equal(result.state, "sent"); assert.equal(result.evidence, undefined);
});

test("wrong controller and other native turn cannot answer through a Watch", async t => {
  const h = harness(t);
  const tasks = createCodexNativeTaskService({ repository: h.tasks, observe: h.deps.observe, start: async () => { throw new Error("must not send"); } });
  const watched = await tasks.watch({ target, nativeId, controllerSession: "controller-one" });
  await assert.rejects(h.service.respondWatch(watched.id, { ...h.input, controllerSession: "other-controller" }), { code: "codex_native_controller_mismatch" });
  await assert.rejects(h.service.respondWatch(watched.id, { ...h.input, interactionId: "other-interaction" }), { code: "stale_interaction" });
  const result = await h.service.respondWatch(watched.id, h.input); assert.equal(result.state, "confirmed");
  await tasks.reconcile(watched.id);
  assert.equal(tasks.status(watched.id).pending_interactions.length, 0);
  assert.equal((await h.service.respondWatch(watched.id, h.input)).id, result.id);
  await assert.rejects(h.service.respondWatch(watched.id, { ...h.input, response: { decision: "decline" } }), { code: "codex_native_response_conflict" });
  assert.equal(h.state.responses, 1);
});

test("missing question IDs fail before a durable response reservation or native dispatch", async t => {
  const h = harness(t, interaction("blocking_question"));
  await assert.rejects(h.service.respond({ ...h.input, response: { answers: { other: ["Green"] } } }), { code: "invalid_argument" });
  assert.equal(h.repository.list().length, 0); assert.equal(h.state.responses, 0);
});

test("stopped Watch response authority is checked before observation and again after an in-flight read", async t => {
  const h = harness(t);
  const tasks = createCodexNativeTaskService({ repository: h.tasks, observe: h.deps.observe,
    start: async () => { throw new Error("unused"); } });
  const watched = await tasks.watch({ target, nativeId, controllerSession: h.input.controllerSession });
  let finish!: (snapshot: CodexNativeSnapshot) => void; let reads = 0;
  h.deps.observe = async () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  const service = createCodexNativeResponseService(h.deps);
  const answering = service.respondWatch(watched.id, h.input);
  tasks.unwatch(watched.id, { controllerSession: h.input.controllerSession });
  finish(structuredClone(h.state.snapshot));
  await assert.rejects(answering, { code: "codex_native_watch_stopped" });
  await assert.rejects(service.respondWatch(watched.id, h.input), { code: "codex_native_watch_stopped" });
  assert.equal(reads, 1); assert.equal(h.state.responses, 0); assert.equal(h.repository.list().length, 0);
});
