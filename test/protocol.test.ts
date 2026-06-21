import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMessageToConversation,
  budgetAction,
  createConversation,
  createMessage,
  extractStructuredMessage,
  validateMessageForConversation
} from "../src/protocol.js";

test("conversation ids use local wall-clock time", () => {
  withTimezone("Asia/Shanghai", () => {
    const conversation = createConversation({
      userRequest: "Build feature",
      now: new Date("2026-06-20T10:01:56.000Z")
    });

    assert.match(conversation.conversation_id, /^task-20260620T180156-[0-9a-f]{8}$/);
    assert.equal(conversation.created_at, "2026-06-20T10:01:56.000Z");
  });
});

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

test("done message idles conversation without consuming a new round", () => {
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
  assert.equal(conversation.status, "idle");
  assert.ok(conversation.idle_since);
  assert.match(conversation.idle_since, /^\d{4}-\d{2}-\d{2}T/);
});

test("extracts structured message from plain JSON", () => {
  const conversation = createConversation({ userRequest: "Build feature" });
  const message = extractStructuredMessage({
    conversation,
    input: '{"from":"claude-code","to":"openclaw","type":"done","requires_response":false,"body":"Completed."}'
  });

  assert.equal(message.from, "claude-code");
  assert.equal(message.to, "openclaw");
  assert.equal(message.type, "done");
  assert.equal(message.requires_response, false);
  assert.equal(message.body, "Completed.");
});

test("extracts structured message from markdown JSON fence", () => {
  const conversation = createConversation({ userRequest: "Build feature" });
  const message = extractStructuredMessage({
    conversation,
    input: [
      "Here is the message:",
      "```json",
      '{"from":"claude-code","to":"openclaw","type":"progress","body":"Working."}',
      "```"
    ].join("\n")
  });

  assert.equal(message.type, "progress");
  assert.equal(message.requires_response, false);
  assert.equal(message.body, "Working.");
});

test("extracts structured message from surrounding text", () => {
  const conversation = createConversation({ userRequest: "Build feature" });
  const message = extractStructuredMessage({
    conversation,
    input: 'Result "follows": {"from":"claude-code","to":"openclaw","type":"question","body":"Should this support CSV export?"} Thanks.'
  });

  assert.equal(message.type, "question");
  assert.equal(message.requires_response, true);
  assert.equal(message.body, "Should this support CSV export?");
});

test("structured blocked messages default to requiring a response", () => {
  const conversation = createConversation({ userRequest: "Build feature" });
  const message = extractStructuredMessage({
    conversation,
    input: '{"from":"claude-code","to":"openclaw","type":"blocked","body":"Need a product decision."}'
  });

  assert.equal(message.type, "blocked");
  assert.equal(message.requires_response, true);
});

test("rejects output without a structured JSON message", () => {
  const conversation = createConversation({ userRequest: "Build feature" });

  assert.throws(
    () => extractStructuredMessage({
      conversation,
      input: "I completed the task but did not return JSON."
    }),
    /no structured JSON message found/
  );
});

test("validates messages against their conversation id", () => {
  const conversation = createConversation({ userRequest: "Build feature" });
  const otherConversation = createConversation({ userRequest: "Other feature" });
  const message = createMessage({
    conversation: otherConversation,
    from: "claude-code",
    to: "openclaw",
    type: "question",
    body: "Which scope?"
  });

  assert.throws(
    () => validateMessageForConversation(conversation, message),
    /does not match conversation/
  );
});

test("allows protocol message types for each route", () => {
  const conversation = createConversation({ userRequest: "Build feature" });
  const progress = createMessage({
    conversation,
    from: "claude-code",
    to: "openclaw",
    type: "progress",
    body: "Working."
  });
  const answer = createMessage({
    conversation,
    from: "openclaw",
    to: "claude-code",
    type: "answer",
    body: "Keep the MVP scope."
  });

  assert.equal(validateMessageForConversation(conversation, progress), true);
  assert.equal(validateMessageForConversation(conversation, answer), true);
});

test("rejects message types on the wrong route", () => {
  const conversation = createConversation({ userRequest: "Build feature" });
  const invalidDeveloperAnswer = {
    ...createMessage({
      conversation,
      from: "claude-code",
      to: "openclaw",
      type: "question",
      body: "Which scope?"
    }),
    type: "answer"
  };
  const invalidManagerDone = {
    ...createMessage({
      conversation,
      from: "openclaw",
      to: "claude-code",
      type: "answer",
      body: "Keep going."
    }),
    type: "done"
  };

  assert.throws(
    () => validateMessageForConversation(conversation, invalidDeveloperAnswer as any),
    /message type answer is not allowed for route claude-code->openclaw/
  );
  assert.throws(
    () => validateMessageForConversation(conversation, invalidManagerDone as any),
    /message type done is not allowed for route openclaw->claude-code/
  );
});

function withTimezone(timezone, fn) {
  const previousTimezone = process.env.TZ;
  process.env.TZ = timezone;
  try {
    fn();
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
}
