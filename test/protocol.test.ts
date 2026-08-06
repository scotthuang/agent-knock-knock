import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMessageToConversation,
  budgetAction,
  createConversation,
  createMessage,
  effectiveTurnStatus,
  extractStructuredMessage,
  normalizeLegacyCallbackStatus,
  sessionIdForConversation,
  turnIdForConversation,
  validateMessage,
  validateMessageForConversation
} from "../src/protocol.js";

test("session and turn ids use local wall-clock time and retain the Store alias", () => {
  withTimezone("Asia/Shanghai", () => {
    const conversation = createConversation({
      userRequest: "Build feature",
      now: new Date("2026-06-20T10:01:56.000Z")
    });

    assert.match(conversation.session_id, /^session-20260620T180156-[0-9a-f]{8}$/);
    assert.match(conversation.turn_id, /^turn-20260620T180156-[0-9a-f]{8}$/);
    assert.equal(conversation.conversation_id, conversation.turn_id);
    assert.equal(sessionIdForConversation(conversation), conversation.session_id);
    assert.equal(turnIdForConversation(conversation), conversation.turn_id);
    assert.equal(conversation.created_at, "2026-06-20T10:01:56.000Z");
  });
});

test("sequential sends use independent turn records in the same session", () => {
  const first = createConversation({
    userRequest: "First request",
    now: new Date("2026-08-05T00:00:00.000Z")
  });
  const second = createConversation({
    userRequest: "Second request",
    sessionId: first.session_id,
    now: new Date("2026-08-05T00:00:04.000Z")
  });

  assert.equal(second.session_id, first.session_id);
  assert.notEqual(second.turn_id, first.turn_id);
  assert.equal(first.conversation_id, first.turn_id);
  assert.equal(second.conversation_id, second.turn_id);
});

test("messages carry the authoritative session and turn ids", () => {
  const conversation = createConversation({
    userRequest: "Build feature",
    sessionId: "session-explicit",
    turnId: "turn-explicit"
  });
  const task = createMessage({
    conversation,
    from: "openclaw",
    to: "claude-code",
    type: "task",
    body: "Build feature",
    metadata: {
      session_id: "spoofed-session",
      turn_id: "spoofed-turn"
    }
  });

  assert.equal(task.session_id, "session-explicit");
  assert.equal(task.turn_id, "turn-explicit");
  assert.equal(task.conversation_id, "turn-explicit");
  assert.equal(task.metadata.session_id, "session-explicit");
  assert.equal(task.metadata.turn_id, "turn-explicit");
});

test("explicit session and turn ids must be non-empty", () => {
  assert.throws(
    () => createConversation({ userRequest: "Build feature", sessionId: "" }),
    /session_id must be a non-empty string/
  );
  assert.throws(
    () => createConversation({ userRequest: "Build feature", turnId: "" }),
    /turn_id must be a non-empty string/
  );
  assert.throws(
    () => createConversation({ userRequest: "Build feature", sessionId: "   " }),
    /session_id must be a non-empty string/
  );
});

test("a stale message from another turn cannot mutate this turn", () => {
  const first = createConversation({
    userRequest: "First request",
    sessionId: "session-shared",
    turnId: "turn-old"
  });
  const second = createConversation({
    userRequest: "Second request",
    sessionId: "session-shared",
    turnId: "turn-new"
  });
  const stale = createMessage({
    conversation: first,
    from: "claude-code",
    to: "openclaw",
    type: "done",
    body: "Late completion."
  });

  assert.throws(
    () => applyMessageToConversation(second, {
      ...stale,
      conversation_id: second.conversation_id
    }),
    /message.conversation_id must equal message.turn_id/
  );
});

test("legacy conversations and messages remain readable", () => {
  const modern = createConversation({ userRequest: "Legacy request" });
  const legacy: any = { ...modern };
  delete legacy.session_id;
  delete legacy.turn_id;

  const modernMessage = createMessage({
    conversation: legacy,
    from: "openclaw",
    to: "claude-code",
    type: "task",
    body: "Legacy request"
  });
  const legacyMessage: any = { ...modernMessage };
  delete legacyMessage.session_id;
  delete legacyMessage.turn_id;

  assert.equal(sessionIdForConversation(legacy), legacy.conversation_id);
  assert.equal(turnIdForConversation(legacy), legacy.conversation_id);
  assert.equal(validateMessageForConversation(legacy, legacyMessage), true);
});

test("legacy callback transport statuses resolve and normalize to their persisted Turn phase", () => {
  const updatedAt = "2026-08-06T04:04:17.678Z";
  const createdAt = "2026-08-06T04:04:17.650Z";
  const cases = [
    {
      legacyStatus: "callback_pending",
      deliveryStatus: "pending",
      finalStatus: "idle"
    },
    {
      legacyStatus: "callback_failed",
      deliveryStatus: "failed",
      finalStatus: "waiting_for_openclaw"
    },
    {
      legacyStatus: "callback_pending",
      deliveryStatus: "pending",
      finalStatus: "waiting_for_agent"
    },
    {
      legacyStatus: "callback_failed",
      deliveryStatus: "failed",
      finalStatus: "failed"
    }
  ] as const;

  for (const testCase of cases) {
    const conversation: any = {
      ...createConversation({ userRequest: `Normalize ${testCase.legacyStatus}` }),
      status: testCase.legacyStatus,
      updated_at: updatedAt,
      idle_since: "2026-08-06T03:00:00.000Z",
      callback_delivery: {
        status: testCase.deliveryStatus,
        final_status: testCase.finalStatus,
        created_at: createdAt,
        message: {
          id: `message-${testCase.legacyStatus}-${testCase.finalStatus}`,
          type: testCase.finalStatus === "idle" ? "done" : "blocked"
        }
      }
    };

    assert.equal(effectiveTurnStatus(conversation), testCase.finalStatus);
    const normalized = normalizeLegacyCallbackStatus(conversation);
    assert.equal(normalized.status, testCase.finalStatus);
    assert.deepEqual(normalized.callback_delivery, conversation.callback_delivery);
    if (testCase.finalStatus === "idle") {
      assert.equal(normalized.idle_since, conversation.idle_since);
    } else {
      assert.equal(normalized.idle_since, undefined);
    }
  }
});

test("legacy callback status normalization fails closed without a valid final Turn phase", () => {
  const invalidFinalStatuses = [
    undefined,
    "callback_pending",
    "callback_failed",
    "not-a-turn-phase"
  ];

  for (const finalStatus of invalidFinalStatuses) {
    const conversation: any = {
      ...createConversation({ userRequest: "Reject ambiguous legacy phase" }),
      status: "callback_failed",
      callback_delivery: {
        status: "failed",
        ...(finalStatus === undefined ? {} : { final_status: finalStatus })
      }
    };
    assert.throws(
      () => effectiveTurnStatus(conversation),
      /missing a valid callback_delivery\.final_status Turn phase/u
    );
    assert.throws(
      () => normalizeLegacyCallbackStatus(conversation),
      /missing a valid callback_delivery\.final_status Turn phase/u
    );
  }

  const invalidCloseShortcut: any = {
    ...createConversation({ userRequest: "Reject an ambiguous legacy close" }),
    status: "callback_failed",
    callback_delivery: {
      status: "failed",
      close_terminal_bridge_on_done: true,
      final_status: "not-a-turn-phase",
      message: { id: "message-invalid-close", type: "done" }
    }
  };
  assert.throws(
    () => effectiveTurnStatus(invalidCloseShortcut),
    /missing a valid callback_delivery\.final_status Turn phase/u
  );

  const mismatchedTransport: any = {
    ...createConversation({ userRequest: "Reject mismatched legacy transport" }),
    status: "callback_failed",
    callback_delivery: {
      status: "delivered",
      final_status: "idle",
      message: { id: "message-mismatched-transport", type: "done" }
    }
  };
  assert.throws(
    () => normalizeLegacyCallbackStatus(mismatchedTransport),
    /matching transport status/u
  );
});

test("legacy callback status normalization is idempotent", () => {
  const conversation: any = {
    ...createConversation({ userRequest: "Normalize once" }),
    status: "callback_pending",
    callback_delivery: {
      status: "pending",
      final_status: "idle",
      created_at: "2026-08-06T04:04:17.650Z",
      message: { id: "message-normalize-once", type: "done" }
    }
  };

  const normalized = normalizeLegacyCallbackStatus(conversation);
  const normalizedAgain = normalizeLegacyCallbackStatus(normalized);
  assert.strictEqual(normalizedAgain, normalized);
  assert.deepEqual(normalizedAgain, normalized);
  assert.equal(normalizedAgain.status, "idle");
  assert.equal(normalizedAgain.idle_since, "2026-08-06T04:04:17.650Z");
});

test("partially modern conversation identities fail closed", () => {
  const modern = createConversation({ userRequest: "Identity shape" });
  const missingSession: any = { ...modern };
  delete missingSession.session_id;
  const missingTurn: any = { ...modern };
  delete missingTurn.turn_id;

  for (const partial of [missingSession, missingTurn]) {
    assert.throws(
      () => sessionIdForConversation(partial),
      /session_id and turn_id must either both be present or both be absent/u
    );
    assert.throws(
      () => turnIdForConversation(partial),
      /session_id and turn_id must either both be present or both be absent/u
    );
  }
});

test("partially modern message identities fail closed", () => {
  const conversation = createConversation({ userRequest: "Identity shape" });
  const modern = createMessage({
    conversation,
    from: "openclaw",
    to: "codex",
    type: "task",
    body: "Identity shape"
  });
  const missingSession: any = { ...modern };
  delete missingSession.session_id;
  const missingTurn: any = { ...modern };
  delete missingTurn.turn_id;

  for (const partial of [missingSession, missingTurn]) {
    assert.throws(
      () => validateMessage(partial),
      /session_id and message.turn_id must either both be present or both be absent/u
    );
  }
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
