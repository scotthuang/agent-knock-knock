import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMessageToConversation,
  budgetAction,
  createConversation,
  createMessage
} from "../src/protocol.js";

test("only response-requiring messages consume rounds", () => {
  let conversation = createConversation({
    userRequest: "Build feature",
    now: new Date("2026-05-16T00:00:00.000Z")
  });

  const task = createMessage({
    conversation,
    from: "openclaw",
    to: "claude-code",
    type: "task",
    body: "Build feature"
  });
  conversation = applyMessageToConversation(conversation, task);

  const progress = createMessage({
    conversation,
    from: "claude-code",
    to: "openclaw",
    type: "progress",
    body: "I am working on it."
  });
  conversation = applyMessageToConversation(conversation, progress);

  assert.equal(task.round, 1);
  assert.equal(progress.round, 1);
  assert.equal(conversation.response_rounds_used, 1);
});

test("budget action escalates at documented thresholds", () => {
  const base = createConversation({ userRequest: "Build feature" });

  assert.equal(budgetAction({ ...base, response_rounds_used: 29 }).level, "normal");
  assert.equal(budgetAction({ ...base, response_rounds_used: 30 }).level, "converge");
  assert.equal(budgetAction({ ...base, response_rounds_used: 40 }).level, "warning");
  assert.equal(budgetAction({ ...base, response_rounds_used: 50 }).level, "soft_stop");
  assert.equal(budgetAction({ ...base, response_rounds_used: 100 }).level, "hard_stop");
});

test("done message closes conversation without consuming a new round", () => {
  let conversation = createConversation({ userRequest: "Build feature" });
  const done = createMessage({
    conversation,
    from: "claude-code",
    to: "openclaw",
    type: "done",
    body: "Completed."
  });

  conversation = applyMessageToConversation(conversation, done);

  assert.equal(done.requires_response, false);
  assert.equal(conversation.response_rounds_used, 0);
  assert.equal(conversation.status, "done");
});
