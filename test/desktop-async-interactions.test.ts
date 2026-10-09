import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopAsyncReply, desktopAsyncQuestions, findDesktopAsyncAnswer } from "../src/desktop-async-interactions.js";
import { reduceDesktopSnapshot } from "../src/desktop-snapshot.js";

const identity = { threadId: "thread-one", ownerClientId: "owner-one", revision: 3 };
const question = () => ({ id: "async-question", type: "agentMessage", text: "Choose a color",
  delivery: "async", phase: "final_answer", questions: [{ title: "Choose a color", options: ["Blue", "Green"] }] });
const state = (items: unknown[] = [question()]) => ({ id: identity.threadId, hostId: "local", mode: "default", resumeState: "resumed",
  threadRuntimeStatus: { type: "active" }, requests: [], turns: [{ turnId: "turn-one", status: "inProgress", items }] });
const snapshot = () => reduceDesktopSnapshot(state(), identity);
const interaction = () => desktopAsyncQuestions(snapshot())[0];
const replyText = () => buildDesktopAsyncReply(interaction(), "Green");
const steering = (overrides: Record<string, unknown> = {}) => ({ id: "steering-one", type: "steeringUserMessage",
  status: "accepted", targetTurnId: "turn-one", clientUserMessageId: "reply-client", serverClientUserMessageId: "reply-client",
  input: [{ type: "text", text: replyText() }], ...overrides });
const evidence = () => ({ turnId: "turn-one", interaction: interaction(), answer: "Green", clientUserMessageId: "reply-client" });

test("Desktop discovers async questions without a pending RPC and preserves exact native identities", () => {
  const value = snapshot();
  assert.equal(value.pendingRequestCount, 0);
  assert.equal(value.asyncQuestions?.length, 1);
  const valueQuestion = value.asyncQuestions![0];
  assert.equal(valueQuestion.questions[0].id, JSON.stringify(["request_user_input_async", "async-question", 0]));
  assert.deepEqual(valueQuestion.questions[0].options, ["Blue", "Green"]);
  assert.equal(valueQuestion.questions[0].isOther, true);
  assert.equal(value.turns[0].items[0].delivery, "async");
  assert.equal(desktopAsyncQuestions(reduceDesktopSnapshot(state(), { ...identity, revision: 25 }))[0].id, valueQuestion.id);
  assert.equal(desktopAsyncQuestions(value, "another-turn").length, 0);
});

test("Desktop indexes each question separately and supports free text including newlines", () => {
  const value = reduceDesktopSnapshot(state([{ ...question(), questions: [{ title: "One" }, { title: "Two", options: [] }] }]), identity);
  const questions = value.asyncQuestions!;
  assert.equal(questions.length, 2);
  assert.notEqual(questions[0].id, questions[1].id);
  assert.equal(questions[1].questions[0].id, JSON.stringify(["request_user_input_async", "async-question", 1]));
  assert.match(buildDesktopAsyncReply(questions[0], "First\nSecond"), /First\\nSecond/u);
});

test("Desktop hides accepted replies, while pending, failed and wrong-turn steering remain unanswered", () => {
  assert.equal(reduceDesktopSnapshot(state([question(), steering()]), identity).asyncQuestions!.length, 0);
  for (const overrides of [{ status: "pending" }, { status: "failed" }, { targetTurnId: "other-turn" }]) {
    const value = reduceDesktopSnapshot(state([question(), steering(overrides)]), identity);
    assert.equal(value.asyncQuestions!.length, 1);
    assert.equal(findDesktopAsyncAnswer(value, evidence()), null);
  }
  const malformed = steering({ input: [{ type: "text", text: "<send_user_message_question_reply>broken</send_user_message_question_reply>" }] });
  assert.equal(reduceDesktopSnapshot(state([question(), malformed]), identity).asyncQuestions!.length, 1);
});

test("Desktop accepts its native legacy source-item reply identity for already-answered discovery", () => {
  const text = replyText().replace(JSON.stringify(interaction().questions[0].id), JSON.stringify("async-question"));
  const value = reduceDesktopSnapshot(state([question(), steering({ input: [{ type: "text", text }] })]), identity);
  assert.equal(value.asyncQuestions!.length, 0);
  // A legacy human answer is not evidence of AKK's exact tuple response.
  assert.equal(findDesktopAsyncAnswer(value, evidence()), null);
});

test("Desktop exact response proof survives accepted steering materialization into a canonical user item", () => {
  const canonical = { id: "server-message", type: "userMessage", clientId: "reply-client", content: [{ type: "text", text: replyText() }] };
  for (const items of [[steering()], [canonical], [steering({ serverUserMessageId: "server-message" }), canonical]]) {
    const raw = state([question(), ...items]); raw.turns[0].status = "completed";
    const value = reduceDesktopSnapshot(raw, identity);
    assert.ok(findDesktopAsyncAnswer(value, evidence()));
    assert.equal(value.asyncQuestions!.length, 0);
  }
});

test("Desktop exact response evidence requires matching task, payload and native client identity", () => {
  const good = reduceDesktopSnapshot(state([question(), steering()]), identity);
  assert.ok(findDesktopAsyncAnswer(good, evidence()));
  for (const input of [{ ...evidence(), answer: "Blue" }, { ...evidence(), turnId: "other-turn" },
    { ...evidence(), clientUserMessageId: "another-client" }]) assert.equal(findDesktopAsyncAnswer(good, input), null);
  for (const overrides of [{ serverClientUserMessageId: "another-client" },
    { input: [{ type: "text", text: replyText().replace("Choose a color", "Changed question") }] }]) {
    assert.equal(findDesktopAsyncAnswer(reduceDesktopSnapshot(state([question(), steering(overrides)]), identity), evidence()), null);
  }
});

test("Desktop does not offer or confirm questions from incomplete items or ambiguous duplicated receipts", () => {
  const raw = state([question(), steering()]);
  Object.assign(raw.turns[0], { itemsView: "summary" });
  const partial = reduceDesktopSnapshot(raw, identity);
  assert.equal(partial.asyncQuestions!.length, 0);
  assert.equal(findDesktopAsyncAnswer(partial, evidence()), null);
  const duplicate = reduceDesktopSnapshot(state([question(), steering(), steering({ id: "second-steering" })]), identity);
  assert.equal(findDesktopAsyncAnswer(duplicate, evidence()), null);
});

test("Desktop rejects malformed async question fields instead of projecting guessed choices", () => {
  for (const malformed of [{ questions: "invalid" }, { questions: [{ title: 1 }] },
    { questions: [{ title: "Question", options: [42] }] }, { delivery: 42 }]) {
    assert.throws(() => reduceDesktopSnapshot(state([{ ...question(), ...malformed }]), identity), /Invalid Desktop/u);
  }
  assert.doesNotThrow(() => reduceDesktopSnapshot(state([question(), {
    id: "tool-call", type: "dynamicToolCall", input: { query: "tool-specific input" }
  }]), identity));
});
