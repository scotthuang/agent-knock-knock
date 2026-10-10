import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { buildDesktopAsyncReply, desktopAsyncQuestions } from "../src/desktop-async-interactions.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import { createDesktopResponseStore } from "../src/desktop-response-store.js";
import { createDesktopResponseService, type DesktopResponseDependencies, type DesktopResponseInput } from "../src/desktop-response-service.js";
import { createDesktopTaskService } from "../src/desktop-task-service.js";
import { DesktopIpcError, type DesktopSnapshot } from "../src/desktop-types.js";

const target = { codexHome: "/test/codex", hostId: "local", threadId: "thread-exact" };
const desktopId = createDesktopConversationId(target);
function pendingSnapshot(): DesktopSnapshot {
  return { threadId: target.threadId, ownerClientId: "owner-one", revision: 1, runtimeStatus: "active",
    pendingRequests: [], pendingRequestCount: 0, unconfirmedSubmissionCount: 0, tailKnown: true, latestTurnId: "native-one", canSend: false,
    turns: [{ turnId: "native-one", status: "inProgress", itemsComplete: true,
      items: [{ id: "question-one", type: "agentMessage", text: "Choose a color", delivery: "async", phase: "final_answer",
        questions: [{ title: "Choose a color", options: ["Blue", "Green"] }] }] }] };
}
function harness(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-response-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repository = createDesktopResponseStore(dir, { acquire: () => () => {} });
  const tasks = createDesktopStateStore(dir, { acquire: () => () => {} });
  const state = { snapshot: pendingSnapshot(), sends: 0, clientId: "" };
  const question = desktopAsyncQuestions(state.snapshot)[0];
  function echo(answer: string, clientId = state.clientId) {
    state.snapshot.turns[0].items.push({ id: `reply-${state.snapshot.turns[0].items.length}`, type: "userMessage", clientId,
      content: [{ type: "text", text: buildDesktopAsyncReply(question, answer) }] });
  }
  const deps: DesktopResponseDependencies = { repository, tasks, observe: async () => structuredClone(state.snapshot),
    answerAsync: async (_target, options) => {
      assert.equal(repository.list()[0].state, "reserved", "reservation precedes transport preflight");
      await options.beforeDispatch?.(state.snapshot);
      assert.equal(repository.list()[0].state, "uncertain", "dispatch barrier is durable before native mutation");
      state.sends++; state.clientId = options.clientUserMessageId; echo(options.answer);
      return { turnId: options.expectedTurnId, clientUserMessageId: options.clientUserMessageId, revision: 2, atomicTurnPrecondition: false };
    } };
  const input: DesktopResponseInput = { target, desktopId, controllerSession: "controller-one", interactionId: question.id,
    responseId: "response-one", answer: "Green" };
  return { dir, repository, tasks, state, deps, input, question, echo, service: createDesktopResponseService(deps) };
}

test("Desktop async answer is durable and confirmed only from exact native answer evidence", async t => {
  const h = harness(t); const result = await h.service.respond(h.input);
  assert.equal(result.state, "confirmed"); assert.equal(result.evidence, "exact_async_answer_observed");
  assert.equal(result.interaction.turnId, "native-one"); assert.equal(h.state.sends, 1);
  const restarted = createDesktopResponseService(h.deps);
  assert.equal((await restarted.respond({ ...h.input, responseId: "new-request-id",
    target: { threadId: target.threadId, hostId: target.hostId, codexHome: target.codexHome } })).id, result.id);
  assert.equal(h.state.sends, 1);
  await assert.rejects(restarted.respond({ ...h.input, answer: "Blue" }), { code: "desktop_response_conflict" });
  await assert.rejects(restarted.respond({ ...h.input, controllerSession: "another-controller" }), { code: "desktop_response_conflict" });
});

test("one Desktop question shares one answer ledger across two Watches and direct conversation response", async t => {
  const h = harness(t);
  const tasks = createDesktopTaskService({ repository: h.tasks, observe: h.deps.observe, start: async () => { throw new Error("must not start a task"); } });
  const a = await tasks.watch({ target, desktopId, controllerSession: h.input.controllerSession });
  const b = await tasks.watch({ target, desktopId, controllerSession: h.input.controllerSession });
  const first = await h.service.respondWatch(a.id, h.input);
  await tasks.reconcile(a.id); await tasks.reconcile(b.id);
  assert.deepEqual(tasks.status(a.id).pending_async_interactions, []);
  assert.equal((await h.service.respondWatch(b.id, { ...h.input, responseId: "response-two" })).id, first.id);
  assert.equal((await h.service.respond({ ...h.input, responseId: "response-three" })).id, first.id);
  await assert.rejects(h.service.respondWatch(b.id, { ...h.input, answer: "Blue" }), { code: "desktop_response_conflict" });
  await assert.rejects(h.service.respondWatch(b.id, { ...h.input, controllerSession: "other" }), { code: "desktop_controller_mismatch" });
  assert.equal(h.state.sends, 1); assert.equal(h.repository.list().length, 1);
});

test("uncertain Desktop response is observed after restart, never resent with a different response ID", async t => {
  const h = harness(t);
  h.deps.answerAsync = async (_target, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.sends++; h.state.clientId = options.clientUserMessageId;
    throw new DesktopIpcError("closed", "lost answer receipt", "unknown");
  };
  const service = createDesktopResponseService(h.deps); const result = await service.respond(h.input);
  assert.equal(result.state, "uncertain");
  assert.equal((await createDesktopResponseService(h.deps).respond({ ...h.input, responseId: "retry-id" })).state, "uncertain");
  assert.equal(h.state.sends, 1);
  h.echo("Green"); h.state.snapshot.turns[0].status = "completed";
  assert.equal((await service.reconcile(result.id)).state, "confirmed"); assert.equal(h.state.sends, 1);
});

test("RPC acknowledgement, question disappearance and task completion do not prove the supplied answer", async t => {
  const h = harness(t);
  h.deps.answerAsync = async (_target, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.sends++; h.state.clientId = options.clientUserMessageId;
    h.echo("Blue"); h.state.snapshot.turns[0].status = "completed";
    return { turnId: options.expectedTurnId, clientUserMessageId: options.clientUserMessageId, revision: 2, atomicTurnPrecondition: false };
  };
  const result = await createDesktopResponseService(h.deps).respond(h.input);
  assert.equal(result.state, "sent"); assert.equal(result.evidence, undefined);
  assert.equal((await h.service.respond({ ...h.input, responseId: "different-id" })).state, "sent"); assert.equal(h.state.sends, 1);
});

test("only explicitly retried known-not-sent answers can dispatch again and retain attempt history", async t => {
  const h = harness(t); const send = h.deps.answerAsync;
  h.deps.answerAsync = async () => { throw new DesktopIpcError("owner_changed", "owner unavailable before dispatch", "not_sent"); };
  const first = await createDesktopResponseService(h.deps).respond(h.input);
  assert.equal(first.state, "not_sent"); assert.equal(h.state.sends, 0);
  await h.service.reconcile(first.id); assert.equal(h.state.sends, 0);
  h.deps.answerAsync = send;
  const [a, b] = await Promise.all([h.service.respond(h.input), createDesktopResponseService(h.deps).respond(h.input)]);
  assert.equal(a.id, b.id); assert.equal(h.state.sends, 1);
  const record = h.service.status(first.id); assert.equal(record.state, "confirmed"); assert.equal(record.attempts, 2);
  assert.deepEqual(record.not_sent_history, [{ attempt: 1, observed_at: first.updated_at, error_code: "owner_changed" }]);
});

test("a crashed reservation is not replayed or confirmed by a later native answer", async t => {
  const h = harness(t);
  h.deps.answerAsync = async () => { throw new DesktopIpcError("closed", "not dispatched", "not_sent"); };
  const first = await createDesktopResponseService(h.deps).respond(h.input);
  h.repository.save({ ...first, state: "reserved", error_code: undefined }, first.revision);
  h.echo("Green", first.client_user_message_id);
  assert.equal((await h.service.reconcile(first.id)).state, "reserved");
  assert.equal((await h.service.respond(h.input)).state, "reserved"); assert.equal(h.state.sends, 0);
});

test("stale or completed questions and other native Watch turns are rejected before answer reservation", async t => {
  const h = harness(t);
  h.state.snapshot.turns[0].status = "completed"; h.state.snapshot.runtimeStatus = "idle";
  await assert.rejects(h.service.respond(h.input), { code: "stale_interaction" });
  assert.equal(h.repository.list().length, 0);
  h.state.snapshot = pendingSnapshot();
  const tasks = createDesktopTaskService({ repository: h.tasks, observe: h.deps.observe, start: async () => { throw new Error("must not start"); } });
  h.state.snapshot.turns[0].turnId = "another-turn"; h.state.snapshot.latestTurnId = "another-turn";
  const watched = await tasks.watch({ target, desktopId, controllerSession: h.input.controllerSession });
  h.state.snapshot = pendingSnapshot();
  await assert.rejects(h.service.respondWatch(watched.id, h.input), { code: "stale_interaction" });
  assert.equal(h.repository.list().length, 0); assert.equal(h.state.sends, 0);
});

test("Desktop response dispatch barrier rechecks the same owner and native question", async t => {
  const h = harness(t);
  h.deps.answerAsync = async (_target, options) => {
    await options.beforeDispatch?.({ ...h.state.snapshot, ownerClientId: "new-owner" });
    h.state.sends++; throw new Error("must not dispatch");
  };
  const result = await createDesktopResponseService(h.deps).respond(h.input);
  assert.equal(result.state, "not_sent"); assert.equal(result.error_code, "snapshot_changed"); assert.equal(h.state.sends, 0);
});

test("stopped Desktop Watch rejects responses before observation and again at the dispatch barrier", async t => {
  const h = harness(t); let observations = 0;
  h.deps.observe = async () => { observations++; return structuredClone(h.state.snapshot); };
  const tasks = createDesktopTaskService({ repository: h.tasks, observe: h.deps.observe, start: async () => { throw new Error("must not start"); } });
  const watched = await tasks.watch({ target, desktopId, controllerSession: h.input.controllerSession });
  tasks.unwatch(watched.id, { controllerSession: h.input.controllerSession });
  const before = observations;
  await assert.rejects(h.service.respondWatch(watched.id, h.input), { code: "desktop_watch_stopped" });
  assert.equal(observations, before); assert.equal(h.repository.list().length, 0);
  await tasks.renew(watched.id, { controllerSession: h.input.controllerSession });
  h.deps.answerAsync = async (_target, options) => {
    tasks.unwatch(watched.id, { controllerSession: h.input.controllerSession });
    await options.beforeDispatch?.(h.state.snapshot); h.state.sends++;
    throw new Error("must not reach backend dispatch");
  };
  const response = await createDesktopResponseService(h.deps).respondWatch(watched.id, h.input);
  assert.equal(response.state, "not_sent"); assert.equal(response.error_code, "desktop_watch_stopped");
  assert.equal(h.state.sends, 0);
});
