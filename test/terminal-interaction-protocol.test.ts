import test from "node:test";
import assert from "node:assert/strict";
import {
  TERMINAL_INTERACTION_LIMITS,
  TERMINAL_INTERACTION_SCHEMA,
  TERMINAL_INTERACTION_VERSION,
  TerminalInteractionValidationError,
  validateTerminalInteractionProjection,
  validateTerminalInteractionResponse
} from "../src/terminal-interaction-protocol.js";
import {
  TERMINAL_INTERACTION_AUTHORITY_SCHEMA,
  TERMINAL_INTERACTION_AUTHORITY_VERSION,
  type TerminalInteractionAuthority
} from "../src/terminal-interaction-authority.js";

function projection(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: TERMINAL_INTERACTION_SCHEMA,
    version: TERMINAL_INTERACTION_VERSION,
    interaction_id: "ti_123",
    turn_id: "turn_123",
    agent: "codex",
    kind: "questionnaire",
    state: "pending",
    step: { index: 1, total: 1 },
    expires_at: "2099-09-08T00:00:00.000Z",
    questions: [
      {
        question_id: "q1",
        header: "Target",
        prompt: "Which target should be used?",
        required: true,
        response_kind: "single_select",
        options: [
          { option_id: "local", label: "Local" },
          {
            option_id: "remote",
            label: "Remote",
            description: "Use the isolated remote target."
          }
        ]
      }
    ],
    capabilities: {
      respond: true,
      batch_response: false,
      free_text: false,
      multi_select: false
    },
    ...overrides
  };
}

function response(
  answers: unknown[],
  overrides: Record<string, unknown> = {}
): unknown {
  return {
    interaction_id: "ti_123",
    turn_id: "turn_123",
    answers,
    ...overrides
  };
}

function expectValidationError(
  operation: () => unknown,
  code: TerminalInteractionValidationError["code"],
  path?: string
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof TerminalInteractionValidationError);
    assert.equal(error.code, code);
    if (path !== undefined) {
      assert.equal(error.path, path);
    }
    return true;
  });
}

test("projection validator rebuilds a closed public projection", () => {
  const input = projection({
    expires_at: "2026-09-08T00:00:00.000Z"
  }) as Record<string, unknown>;
  const parsed = validateTerminalInteractionProjection(input);

  assert.notEqual(parsed, input);
  assert.deepEqual(parsed, input);
  assert.equal(parsed.kind, "questionnaire");
  assert.equal(parsed.state, "pending");
  assert.equal(parsed.questions[0]?.response_kind, "single_select");
});

test("projection validator accepts each explicitly supported response kind", () => {
  const cases = [
    {
      question_id: "single",
      prompt: "Pick one",
      required: true,
      response_kind: "single_select",
      options: [
        { option_id: "a", label: "A" },
        { option_id: "b", label: "B" }
      ]
    },
    {
      question_id: "multi",
      prompt: "Pick several",
      required: true,
      response_kind: "multi_select",
      options: [
        { option_id: "a", label: "A" },
        { option_id: "b", label: "B" }
      ]
    },
    {
      question_id: "text",
      prompt: "Explain",
      required: true,
      response_kind: "free_text",
      placeholder: "Short answer"
    },
    {
      question_id: "confirm",
      prompt: "Continue?",
      required: true,
      response_kind: "confirm"
    }
  ];

  for (const question of cases) {
    const parsed = validateTerminalInteractionProjection(projection({
      questions: [question],
      capabilities: {
        respond: true,
        batch_response: false,
        free_text: question.response_kind === "free_text",
        multi_select: question.response_kind === "multi_select"
      }
    }));
    assert.equal(parsed.questions[0]?.response_kind, question.response_kind);
  }
});

test("projection enums are closed", () => {
  for (const [field, value] of [
    ["agent", "shell"],
    ["kind", "approval"],
    ["state", "resolved"]
  ] as const) {
    expectValidationError(
      () => validateTerminalInteractionProjection(projection({ [field]: value })),
      "invalid_value",
      `$.${field}`
    );
  }
  const input = projection() as Record<string, any>;
  input.questions[0].response_kind = "choice";
  expectValidationError(
    () => validateTerminalInteractionProjection(input),
    "invalid_value",
    "$.questions[0].response_kind"
  );
});

test("projection rejects unknown fields and private authority material", () => {
  expectValidationError(
    () => validateTerminalInteractionProjection(projection({ native_thread_id: "native" })),
    "unknown_field",
    "$.native_thread_id"
  );

  const authority: TerminalInteractionAuthority = {
    authority_schema: TERMINAL_INTERACTION_AUTHORITY_SCHEMA,
    authority_version: TERMINAL_INTERACTION_AUTHORITY_VERSION,
    interaction_id: "ti_123",
    turn_id: "turn_123",
    agent: "codex",
    state: "stable_pending",
    source_interaction_id: "call_123",
    native_turn_id: "native_turn",
    native_thread_id: "native_thread",
    source_file_identity: "private-file-token",
    source_fingerprint: "private-fingerprint",
    live_frame_fingerprint: "private-frame-fingerprint",
    runtime_profile: "codex-0.153.4-request-user-input-v1",
    process_incarnation: "pid:123@private-birth",
    owner_session: "agent:main:main",
    turn_revision: "private-turn-revision",
    terminal_binding_id: "private-binding",
    terminal_binding_generation: 2,
    current_step: 1,
    created_at: "2026-09-07T00:00:00.000Z",
    expires_at: "2026-09-07T00:10:00.000Z"
  };
  expectValidationError(
    () => validateTerminalInteractionProjection({
      ...(projection() as Record<string, unknown>),
      ...authority
    }),
    "unknown_field",
    "$.authority_schema"
  );
});

test("projection fails closed on secret markers and unsafe control characters", () => {
  const secret = projection() as Record<string, any>;
  secret.questions[0].isSecret = false;
  expectValidationError(
    () => validateTerminalInteractionProjection(secret),
    "secret_not_allowed",
    "$.questions[0].isSecret"
  );

  const control = projection() as Record<string, any>;
  control.questions[0].prompt = "Approve\u001b[2J?";
  expectValidationError(
    () => validateTerminalInteractionProjection(control),
    "control_character",
    "$.questions[0].prompt"
  );
});

test("projection enforces question, option, identifier, and text limits", () => {
  expectValidationError(
    () => validateTerminalInteractionProjection(projection({ questions: [] })),
    "limit_exceeded",
    "$.questions"
  );
  expectValidationError(
    () => validateTerminalInteractionProjection(projection({
      questions: Array.from(
        { length: TERMINAL_INTERACTION_LIMITS.maxQuestions + 1 },
        (_, index) => ({
          question_id: `q${index}`,
          prompt: "Choose",
          required: false,
          response_kind: "confirm"
        })
      ),
      capabilities: {
        respond: true,
        batch_response: true,
        free_text: false,
        multi_select: false
      }
    })),
    "limit_exceeded",
    "$.questions"
  );

  const tooManyOptions = projection() as Record<string, any>;
  tooManyOptions.questions[0].options = Array.from(
    { length: TERMINAL_INTERACTION_LIMITS.maxOptionsPerQuestion + 1 },
    (_, index) => ({ option_id: `o${index}`, label: `Option ${index}` })
  );
  expectValidationError(
    () => validateTerminalInteractionProjection(tooManyOptions),
    "limit_exceeded",
    "$.questions[0].options"
  );

  const longPrompt = projection() as Record<string, any>;
  longPrompt.questions[0].prompt = "x".repeat(
    TERMINAL_INTERACTION_LIMITS.maxPromptLength + 1
  );
  expectValidationError(
    () => validateTerminalInteractionProjection(longPrompt),
    "limit_exceeded",
    "$.questions[0].prompt"
  );

  expectValidationError(
    () => validateTerminalInteractionProjection(projection({ interaction_id: "bad id" })),
    "invalid_value",
    "$.interaction_id"
  );
});

test("projection rejects batched questions and duplicate option ids", () => {
  const batchedQuestions = projection({
    questions: [
      {
        question_id: "first",
        prompt: "First?",
        required: true,
        response_kind: "confirm"
      },
      {
        question_id: "second",
        prompt: "Second?",
        required: true,
        response_kind: "confirm"
      }
    ]
  });
  expectValidationError(
    () => validateTerminalInteractionProjection(batchedQuestions),
    "limit_exceeded",
    "$.questions"
  );

  const duplicateOptions = projection() as Record<string, any>;
  duplicateOptions.questions[0].options[1].option_id = "local";
  expectValidationError(
    () => validateTerminalInteractionProjection(duplicateOptions),
    "duplicate_id",
    "$.questions[0].options"
  );
});

test("projection validates step, capabilities, and expiry", () => {
  expectValidationError(
    () => validateTerminalInteractionProjection(projection({
      step: { index: 2, total: 1 }
    })),
    "limit_exceeded",
    "$.step.index"
  );
  expectValidationError(
    () => validateTerminalInteractionProjection(projection({
      questions: [{
        question_id: "q1",
        prompt: "Explain",
        required: true,
        response_kind: "free_text"
      }]
    })),
    "invalid_value",
    "$.capabilities.free_text"
  );
  expectValidationError(
    () => validateTerminalInteractionProjection(projection({ expires_at: "not-a-date" })),
    "invalid_value",
    "$.expires_at"
  );
});

test("response validator accepts one typed current-step answer", () => {
  const questions = [{
    question_id: "q1",
    prompt: "Pick any",
    required: true,
    response_kind: "multi_select",
    options: [
      { option_id: "a", label: "A" },
      { option_id: "b", label: "B" }
    ]
  }];
  const inputProjection = projection({
    questions,
    capabilities: {
      respond: true,
      batch_response: false,
      free_text: false,
      multi_select: true
    }
  });
  const inputResponse = response([{
    question_id: "q1",
    response_kind: "multi_select",
    selected_option_ids: ["a", "b"]
  }]);

  assert.deepEqual(
    validateTerminalInteractionResponse(inputResponse, inputProjection),
    inputResponse
  );
});

test("response answer shapes are mutually exclusive and kind checked", () => {
  expectValidationError(
    () => validateTerminalInteractionResponse(response([{
      question_id: "q1",
      response_kind: "single_select",
      selected_option_ids: ["local"],
      text: "also inject text"
    }]), projection()),
    "unknown_field",
    "$.answers[0].text"
  );
  expectValidationError(
    () => validateTerminalInteractionResponse(response([{
      question_id: "q1",
      response_kind: "confirm",
      confirm: true
    }]), projection()),
    "answer_kind_mismatch",
    "$.answers[0].response_kind"
  );
});

test("response rejects unknown, duplicate, or missing question and option ids", () => {
  expectValidationError(
    () => validateTerminalInteractionResponse(response([{
      question_id: "unknown",
      response_kind: "confirm",
      confirm: true
    }]), projection()),
    "unknown_question",
    "$.answers[0].question_id"
  );
  expectValidationError(
    () => validateTerminalInteractionResponse(response([{
      question_id: "q1",
      response_kind: "single_select",
      selected_option_ids: ["unknown"]
    }]), projection()),
    "unknown_option",
    "$.answers[0].selected_option_ids"
  );
  expectValidationError(
    () => validateTerminalInteractionResponse(response([]), projection()),
    "missing_answer",
    "$.answers"
  );

  const inputProjection = projection({
    questions: [{
      question_id: "q1",
      prompt: "Confirm",
      required: true,
      response_kind: "confirm"
    }]
  });
  expectValidationError(
    () => validateTerminalInteractionResponse(response([
      { question_id: "q1", response_kind: "confirm", confirm: true },
      { question_id: "q1", response_kind: "confirm", confirm: false }
    ]), inputProjection),
    "duplicate_id",
    "$.answers"
  );
});

test("response rejects duplicate selected options", () => {
  const multiProjection = projection({
    questions: [{
      question_id: "q1",
      prompt: "Pick any",
      required: true,
      response_kind: "multi_select",
      options: [
        { option_id: "a", label: "A" },
        { option_id: "b", label: "B" }
      ]
    }],
    capabilities: {
      respond: true,
      batch_response: false,
      free_text: false,
      multi_select: true
    }
  });
  expectValidationError(
    () => validateTerminalInteractionResponse(response([{
      question_id: "q1",
      response_kind: "multi_select",
      selected_option_ids: ["a", "a"]
    }]), multiProjection),
    "duplicate_id",
    "$.answers[0].selected_option_ids"
  );

});

test("response is fenced to its exact pending interaction and rejects secrets", () => {
  expectValidationError(
    () => validateTerminalInteractionResponse(
      response([], { interaction_id: "ti_other" }),
      projection({ questions: [{
        question_id: "optional",
        prompt: "Optional",
        required: false,
        response_kind: "confirm"
      }] })
    ),
    "interaction_mismatch",
    "$.interaction_id"
  );
  expectValidationError(
    () => validateTerminalInteractionResponse(response([{
      question_id: "q1",
      response_kind: "single_select",
      selected_option_ids: ["local"],
      secret: true
    }]), projection()),
    "secret_not_allowed",
    "$.answers[0].secret"
  );
  expectValidationError(
    () => validateTerminalInteractionResponse(response([{
      question_id: "q1",
      response_kind: "single_select",
      selected_option_ids: ["local"]
    }]), projection({ state: "manual_required" })),
    "response_not_allowed",
    "$.state"
  );
});

test("response rejects expired, disabled, batched, and multiline input", () => {
  const selectAnswer = {
    question_id: "q1",
    response_kind: "single_select",
    selected_option_ids: ["local"]
  };
  expectValidationError(
    () => validateTerminalInteractionResponse(
      response([selectAnswer]),
      projection({ expires_at: "2026-09-07T00:00:00.000Z" }),
      { now: new Date("2026-09-07T00:00:01.000Z") }
    ),
    "expired",
    "$.expires_at"
  );
  assert.deepEqual(
    validateTerminalInteractionResponse(
      response([selectAnswer]),
      projection({ expires_at: "2026-09-07T00:00:00.000Z" }),
      {
        now: new Date("2026-09-07T00:00:01.000Z"),
        allowExpiredForLiveRecapture: true
      }
    ).answers,
    [selectAnswer]
  );
  expectValidationError(
    () => validateTerminalInteractionResponse(
      response([selectAnswer]),
      projection({
        capabilities: {
          respond: false,
          batch_response: false,
          free_text: false,
          multi_select: false
        }
      })
    ),
    "response_not_allowed",
    "$.capabilities.respond"
  );

  const textProjection = projection({
    questions: [{
      question_id: "q1",
      prompt: "Explain",
      required: true,
      response_kind: "free_text"
    }],
    capabilities: {
      respond: true,
      batch_response: false,
      free_text: true,
      multi_select: false
    }
  });
  expectValidationError(
    () => validateTerminalInteractionResponse(response([{
      question_id: "q1",
      response_kind: "free_text",
      text: "first line\nsecond line"
    }]), textProjection),
    "control_character",
    "$.answers[0].text"
  );

  expectValidationError(
    () => validateTerminalInteractionProjection(projection({
      capabilities: {
        respond: true,
        batch_response: true,
        free_text: false,
        multi_select: false
      }
    })),
    "invalid_value",
    "$.capabilities.batch_response"
  );
});
