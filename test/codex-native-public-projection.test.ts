import assert from "node:assert/strict";
import test from "node:test";
import { nativeInteractionProjection, nativeQuestionResponse } from "../src/codex-native-public-projection.js";
import type { NativeInteraction } from "../src/codex-native-types.js";

const interaction: NativeInteraction = { id: `codex-native-interaction:${"a".repeat(64)}`, kind: "blocking_question",
  threadId: "thread", turnId: "turn", itemId: "item", method: "item/tool/requestUserInput", questions: [
    { id: "color", title: "Color?", options: ["Blue", "Green"], isOther: true },
    { id: "description", title: "Description?", options: [] }
  ] };

test("native question envelope binds every public question/option to current native IDs", () => {
  const projected = nativeInteractionProjection(interaction, "fixture");
  const answer = { interaction_id: interaction.id, answers: [
    { question_id: projected.questions[0].question_id, response_kind: "single_select", selected_option_ids: [projected.questions[0].options[1].option_id] },
    { question_id: projected.questions[1].question_id, response_kind: "free_text", text: "User supplied description" }
  ] };
  assert.deepEqual(nativeQuestionResponse(interaction, answer), { answers: { color: ["Green"], description: ["User supplied description"] } });
  assert.throws(() => nativeQuestionResponse(interaction, { ...answer, answers: answer.answers.slice(0, 1) }), /every question/);
  assert.throws(() => nativeQuestionResponse(interaction, { ...answer, answers: [answer.answers[0], answer.answers[0]] }), /duplicated/);
  assert.throws(() => nativeQuestionResponse(interaction, { ...answer, delivery_mode: "steer_current_turn" }), /delivery mode/);
  const foreign = structuredClone(answer); foreign.answers[0].selected_option_ids = ["Green"];
  assert.throws(() => nativeQuestionResponse(interaction, foreign), /no longer available/);
});
