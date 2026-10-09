import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { parseDesktopRequestInteraction } from "../src/desktop-request-interactions.js";
import { createDesktopResponseService, type DesktopResponseDependencies, type DesktopResponseInput } from "../src/desktop-response-service.js";
import { createDesktopResponseStore } from "../src/desktop-response-store.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import { createDesktopTaskService } from "../src/desktop-task-service.js";
import { DesktopIpcError, type DesktopRequestInteraction, type DesktopSnapshot } from "../src/desktop-types.js";

const target = { codexHome: "/test/codex", hostId: "local", threadId: "thread-exact" };
const desktopId = createDesktopConversationId(target);
function pending(kind: DesktopRequestInteraction["kind"]): DesktopSnapshot {
  const method = kind === "command_approval" ? "item/commandExecution/requestApproval"
    : kind === "file_approval" ? "item/fileChange/requestApproval" : "item/tool/requestUserInput";
  const snapshot: DesktopSnapshot = { threadId: target.threadId, ownerClientId: "owner-one", revision: 1, runtimeStatus: "active",
    pendingRequests: [{ kind: kind === "blocking_question" ? "user_input" : "approval", requestId: 7, method, turnId: "native-one" }],
    pendingRequestCount: 1, unconfirmedSubmissionCount: 0, tailKnown: true, latestTurnId: "native-one", canSend: false,
    turns: [{ turnId: "native-one", status: "inProgress", itemsComplete: true, items: [{ id: "request-item",
      type: kind === "command_approval" ? "commandExecution" : kind === "file_approval" ? "fileChange" : "userInput", status: "inProgress" }] }] };
  const request = { id: 7, method, params: { threadId: target.threadId, turnId: "native-one", itemId: "request-item",
    ...(kind === "blocking_question" ? { questions: [{ id: "color", question: "Choose a color", isOther: false,
      options: [{ label: "Blue" }, { label: "Green" }] }] } : { command: "printf OK", availableDecisions: ["accept", "decline"] }) } };
  snapshot.pendingInteractions = [parseDesktopRequestInteraction(request, target.threadId, snapshot.turns)!];
  return snapshot;
}
function harness(t: TestContext, kind: DesktopRequestInteraction["kind"] = "command_approval") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-native-response-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repository = createDesktopResponseStore(dir, { acquire: () => () => {} });
  const tasks = createDesktopStateStore(dir, { acquire: () => () => {} });
  const state = { snapshot: pending(kind), sends: 0 };
  const interaction = state.snapshot.pendingInteractions![0] as DesktopRequestInteraction;
  const clearRequest = () => { state.snapshot.pendingInteractions = []; state.snapshot.pendingRequests = []; state.snapshot.pendingRequestCount = 0; };
  const deps: DesktopResponseDependencies = { repository, tasks, observe: async () => structuredClone(state.snapshot),
    answerAsync: async () => { throw new Error("must not submit a steering answer"); },
    respondRequest: async (_target, options) => {
      assert.equal(repository.list()[0].state, "reserved"); await options.beforeDispatch?.(state.snapshot);
      assert.equal(repository.list()[0].state, "uncertain"); state.sends++; clearRequest();
      if ("answers" in options.response) state.snapshot.turns[0].items.push({ id: "answered-input", type: "userInputResponse",
        requestId: interaction.requestId, turnId: interaction.turnId, completed: true, answers: options.response.answers });
      else state.snapshot.turns[0].items[0].status = options.response.decision === "accept" ? "completed" : "declined";
      return { turnId: interaction.turnId, interactionId: interaction.id, requestId: interaction.requestId, revision: 2, acknowledged: true };
    } };
  const input: DesktopResponseInput = { target, desktopId, controllerSession: "controller-one", interactionId: interaction.id,
    responseId: "response-one", response: kind === "blocking_question" ? { answers: { color: ["Green"] } } : { decision: "accept" } };
  return { repository, tasks, state, deps, input, interaction, clearRequest, service: createDesktopResponseService(deps) };
}

for (const kind of ["command_approval", "file_approval"] as const) {
  for (const decision of ["accept", "decline"] as const) test(`Desktop ${kind} ${decision} confirms exact native item progress and never replays`, async t => {
    const h = harness(t, kind); const input = { ...h.input, response: { decision } };
    const result = await h.service.respond(input);
    assert.equal(result.state, "confirmed"); assert.equal(result.evidence, "exact_approval_item_advanced");
    assert.equal(result.interaction.kind, kind); assert.equal(result.baseline_item_status, "inProgress");
    assert.equal((await createDesktopResponseService(h.deps).respond({ ...input, responseId: "retry-call" })).id, result.id);
    assert.equal(h.state.sends, 1);
    await assert.rejects(h.service.respond({ ...input, response: { decision: decision === "accept" ? "decline" : "accept" } }), { code: "desktop_response_conflict" });
  });
}

test("Desktop native approval acknowledgement and disappearing request do not replace item evidence", async t => {
  const h = harness(t);
  h.deps.respondRequest = async (_target, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.sends++; h.clearRequest(); h.state.snapshot.turns[0].status = "completed";
    return { turnId: h.interaction.turnId, interactionId: h.interaction.id, requestId: h.interaction.requestId, revision: 2, acknowledged: true };
  };
  const result = await h.service.respond(h.input);
  assert.equal(result.state, "sent"); assert.equal(result.evidence, undefined);
  h.state.snapshot.turns[0].items[0].status = "completed";
  assert.equal((await h.service.reconcile(result.id)).state, "confirmed"); assert.equal(h.state.sends, 1);
});

test("a pre-existing completed approval item cannot prove a new approval response took effect", async t => {
  const h = harness(t); h.state.snapshot.turns[0].items[0].status = "completed";
  const result = await h.service.respond(h.input);
  assert.equal(result.state, "sent"); assert.equal(result.evidence, undefined);
});

test("blocking Desktop answers require exact native completed response, request type, task and answers", async t => {
  const h = harness(t, "blocking_question");
  h.deps.respondRequest = async (_target, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.sends++; h.clearRequest();
    h.state.snapshot.turns[0].items.push({ id: "wrong-request", type: "userInputResponse", requestId: "7", turnId: "native-one",
      completed: true, answers: { color: ["Green"] } }, { id: "wrong-answer", type: "userInputResponse", requestId: 7,
      turnId: "native-one", completed: true, answers: { color: ["Blue"] } });
    return { turnId: h.interaction.turnId, interactionId: h.interaction.id, requestId: 7, revision: 2, acknowledged: true };
  };
  const result = await h.service.respond(h.input);
  assert.equal(result.state, "sent"); assert.equal(result.evidence, undefined);
  h.state.snapshot.turns[0].items.push({ id: "exact-answer", type: "userInputResponse", requestId: 7, turnId: "native-one",
    completed: true, answers: { color: ["Green"] } });
  const confirmed = await h.service.reconcile(result.id);
  assert.equal(confirmed.state, "confirmed"); assert.equal(confirmed.evidence, "exact_blocking_answer_observed");
});

test("invalid Desktop blocking answers fail before creating a durable intent", async t => {
  const h = harness(t, "blocking_question");
  const invalidAnswers: Record<string, string[]>[] = [{ other: ["Green"] }, { color: ["Not an offered option"] }];
  for (const answers of invalidAnswers) {
    await assert.rejects(h.service.respond({ ...h.input, response: { answers } }));
  }
  assert.equal(h.repository.list().length, 0); assert.equal(h.state.sends, 0);
  assert.equal((await h.service.respond(h.input)).state, "confirmed");
});

test("one uncertain request response is shared across two Desktop Watches and the conversation", async t => {
  const h = harness(t);
  const tasks = createDesktopTaskService({ repository: h.tasks, observe: h.deps.observe, start: async () => { throw new Error("must not send task"); } });
  const a = await tasks.watch({ target, desktopId, controllerSession: h.input.controllerSession });
  const b = await tasks.watch({ target, desktopId, controllerSession: h.input.controllerSession });
  h.deps.respondRequest = async (_target, options) => {
    await options.beforeDispatch?.(h.state.snapshot); h.state.sends++;
    throw new DesktopIpcError("closed", "lost native acknowledgement", "unknown");
  };
  const first = await h.service.respondWatch(a.id, h.input); assert.equal(first.state, "uncertain");
  assert.equal((await h.service.respondWatch(b.id, { ...h.input, responseId: "other-call" })).id, first.id);
  assert.equal((await h.service.respond({ ...h.input, responseId: "third-call" })).id, first.id);
  assert.equal(h.state.sends, 1);
  h.clearRequest(); h.state.snapshot.turns[0].items[0].status = "completed";
  assert.equal((await createDesktopResponseService(h.deps).reconcile(first.id)).state, "confirmed");
});

test("Desktop approval preview materialization does not change the pending request or poison its response intent", async t => {
  const h = harness(t, "file_approval"); const send = h.deps.respondRequest!;
  h.deps.respondRequest = async (identity, options) => {
    (h.state.snapshot.pendingInteractions![0] as DesktopRequestInteraction).changes = [{ path: "/tmp/owned-test", kind: "add", diff: "+ok" }];
    return send(identity, options);
  };
  assert.equal((await h.service.respond(h.input)).state, "confirmed"); assert.equal(h.state.sends, 1);
});

test("known-not-sent Desktop request response can be explicitly retried with one durable claim", async t => {
  const h = harness(t); const send = h.deps.respondRequest!;
  h.deps.respondRequest = async () => { throw new DesktopIpcError("owner_changed", "pre-dispatch failure", "not_sent"); };
  const first = await h.service.respond(h.input); assert.equal(first.state, "not_sent");
  h.deps.respondRequest = send;
  const [a, b] = await Promise.all([h.service.respond(h.input), createDesktopResponseService(h.deps).respond(h.input)]);
  assert.equal(a.id, b.id); assert.equal(h.state.sends, 1); assert.equal(h.service.status(first.id).attempts, 2);
});

test("explicit not-sent retry measures native progress from that retry rather than an obsolete item baseline", async t => {
  const h = harness(t); const send = h.deps.respondRequest!;
  h.deps.respondRequest = async () => { throw new DesktopIpcError("owner_changed", "not dispatched", "not_sent"); };
  const first = await h.service.respond(h.input);
  h.state.snapshot.turns[0].items[0].status = "completed"; h.deps.respondRequest = send;
  const retried = await h.service.respond(h.input);
  assert.equal(retried.state, "sent"); assert.equal(retried.evidence, undefined);
  assert.equal(retried.baseline_item_status, "completed");
  assert.equal(retried.not_sent_history?.[0].baseline_item_status, first.baseline_item_status);
});
