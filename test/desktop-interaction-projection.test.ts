import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { desktopInteractionFingerprint, desktopInteractionProjection, desktopQuestionAnswer, desktopQuestionResponse,
  validateDesktopInteractionProjections } from "../src/desktop-interaction-projection.js";
import { desktopTaskProjection } from "../src/desktop-public-projection.js";
import type { DesktopAsyncInteraction, DesktopRequestInteraction } from "../src/desktop-types.js";
import type { DesktopTaskRecord } from "../src/desktop-state-store.js";

const target = { codexHome: "/test/codex", hostId: "local", threadId: "thread-one" };
const id = createDesktopConversationId(target);
const question: DesktopAsyncInteraction = { id: `desktop-async-interaction:${"a".repeat(64)}`, kind: "async_question",
  threadId: target.threadId, turnId: "turn-one", itemId: "item-one", method: "request_user_input_async",
  questions: [{ id: '["request_user_input_async","item-one",0]', title: "Pick a color", options: ["Green", "Blue"], isOther: true }] };

test("Desktop async answers resolve current semantic options and preserve structured multiline free text", () => {
  const projected = desktopInteractionProjection(question, id);
  const selected = { interaction_id: question.id, answers: [{ question_id: projected.questions[0].question_id,
    response_kind: "single_select", selected_option_ids: [projected.questions[0].options[0].option_id] }] };
  assert.equal(desktopQuestionAnswer(question, selected), "Green");
  assert.equal(desktopQuestionAnswer(question, { interaction_id: question.id, answers: [{
    question_id: projected.questions[0].question_id, response_kind: "free_text", text: "Free\ntext\tvalue" }] }), "Free\ntext\tvalue");
  assert.throws(() => desktopQuestionAnswer(question, { ...selected, delivery_mode: "queue_next_turn" }), /one current/);
  assert.throws(() => desktopQuestionAnswer(question, { ...selected, answers: [{ ...selected.answers[0], selected_option_ids: ["Green"] }] }), /absent/);
  assert.throws(() => desktopQuestionAnswer(question, { ...selected, answers: [{ ...selected.answers[0], question_id: "q:wrong" }] }), /does not match/);
  assert.equal(desktopInteractionFingerprint({ ...question, revision: 99 } as DesktopAsyncInteraction), desktopInteractionFingerprint(question));
  assert.notEqual(desktopInteractionFingerprint({ ...question, questions: [{ ...question.questions[0], title: "Changed question" }] }), desktopInteractionFingerprint(question));
});

test("Desktop projection binds its exact subject and cannot present a different task as current", () => {
  const projected = desktopInteractionProjection(question, id, "desktop-watch:abcdefgh");
  assert.equal(validateDesktopInteractionProjections([projected], id, "desktop-watch:abcdefgh", "turn-one").length, 1);
  assert.throws(() => validateDesktopInteractionProjections([projected], id, "desktop-watch:otherone", "turn-one"), /identity mismatch/);
  assert.throws(() => validateDesktopInteractionProjections([projected], id, "desktop-watch:abcdefgh", "turn-two"), /identity mismatch/);
  assert.throws(() => validateDesktopInteractionProjections([{ ...projected, kind: "blocking_question" }], id, "desktop-watch:abcdefgh"), /identity mismatch/);
});

test("unknown Desktop observation retains uncertainty without an executable stale question", () => {
  const task: DesktopTaskRecord = { schema: "agent-knock-knock/desktop-task", version: 1, revision: 1,
    id: "desktop-watch:abcdefgh", watch_id: "desktop-watch:abcdefgh", desktop_id: id, target,
    controller_session: "controller", kind: "watch", status: "watching", native_turn_id: "turn-one",
    created_at: "2026-10-09T00:00:00.000Z", updated_at: "2026-10-09T00:00:00.000Z", deadline_at: "2026-10-09T01:00:00.000Z",
    pending_manual_count: 0, pending_async_interactions: [question], notifications: [] };
  const current = desktopTaskProjection(task);
  assert.equal((current.capabilities as { interaction_respond: boolean }).interaction_respond, true);
  const unknown = desktopTaskProjection({ ...task, observation_error: "desktop_async_questions_incomplete" });
  assert.deepEqual(unknown.interaction_state, []);
  assert.equal(unknown.pending_async_count, null);
  assert.equal(unknown.async_interactions_state, "unknown");
  assert.equal((unknown.capabilities as { interaction_respond: boolean }).interaction_respond, false);
  assert.equal(task.pending_async_interactions!.length, 1);
});

test("Desktop blocking questionnaires resolve all opaque answers in one exact request, retaining per-question free-text rules", () => {
  const blocking: DesktopRequestInteraction = { id: `desktop-request-interaction:${"b".repeat(64)}`, kind: "blocking_question",
    threadId: target.threadId, turnId: "turn-one", itemId: "blocking-one", requestId: 42,
    method: "item/tool/requestUserInput", questions: [
      { id: "color", title: "Color", options: ["Green", "Blue"] },
      { id: "reason", title: "Reason", options: [], isSecret: true }
    ] };
  const projected = desktopInteractionProjection(blocking, id);
  const value = { interaction_id: blocking.id, answers: [
    { question_id: projected.questions[0].question_id, response_kind: "single_select", selected_option_ids: [projected.questions[0].options[1].option_id] },
    { question_id: projected.questions[1].question_id, response_kind: "free_text", text: "Two\nlines" }
  ] };
  assert.equal(projected.questions[1].is_secret, true);
  assert.deepEqual(desktopQuestionResponse(blocking, value), { answers: { color: ["Blue"], reason: ["Two\nlines"] } });
  assert.equal(validateDesktopInteractionProjections([projected], id, undefined, "turn-one").length, 1);
  assert.throws(() => desktopQuestionResponse(blocking, { ...value, answers: value.answers.slice(0, 1) }), /every question/);
  assert.throws(() => desktopQuestionResponse(blocking, { ...value, answers: [value.answers[0], value.answers[0]] }), /duplicated/);
  assert.throws(() => desktopQuestionResponse(blocking, { ...value, answers: [
    { question_id: projected.questions[0].question_id, response_kind: "free_text", text: "Other" }, value.answers[1] ] }), /free-text/);
  assert.throws(() => desktopQuestionResponse(blocking, { ...value, delivery_mode: "steer_current_turn" }), /async delivery/);
});
