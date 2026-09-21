import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_ASYNC_QUESTION_PROFILES,
  codexAsyncQuestionMainComposerVisible,
  codexAsyncQuestionProfile,
  inspectCodexAsyncQuestion,
  parseCodexAsyncQuestionRecordCandidates,
  verifyCodexAsyncQuestionInjectedText,
  type CodexAsyncQuestionDurableEvidence
} from "../src/codex-async-question-adapter.js";

const EVIDENCE: readonly CodexAsyncQuestionDurableEvidence[] = [{
  itemId: "async-message-call",
  turnId: "turn-1234",
  currentIndex: 0,
  remainingCount: 2,
  questions: [
    {
      title: "Which environment should I use?",
      options: ["Staging", "Production"]
    },
    { title: "What deadline should I use?" }
  ]
}];

const EXPANDED_OPTIONS = [
  "• Queued follow-up inputs",
  "",
  "  1 of 2",
  "",
  "  Which environment should I use?",
  "",
  "  › 1. Staging",
  "    2. Production",
  "    3. Other",
  "",
  "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt   shift + ← next question"
].join("\n");

test("Codex async-question profiles are exact and do not float to unknown versions", () => {
  assert.deepEqual(Object.keys(CODEX_ASYNC_QUESTION_PROFILES), [
    "0.154.0",
    "0.155.1"
  ]);
  assert.equal(
    codexAsyncQuestionProfile("0.155.1"),
    "codex/0.155.1/request-user-input-async-v1"
  );
  assert.equal(codexAsyncQuestionProfile("0.155.2"), undefined);
  assert.deepEqual(
    inspectCodexAsyncQuestion({
      version: "0.155.2",
      screen: EXPANDED_OPTIONS,
      evidence: EVIDENCE
    }),
    { state: "ambiguous", reason: "unsupported_version" }
  );
});

test("pure durable-record parsing retains accepted async calls without returning raw records", () => {
  const argumentsJson = JSON.stringify({
    questions: [
      {
        title: "Which environment should I use?",
        options: ["Staging", "Production"]
      },
      { title: "What deadline should I use?" }
    ]
  });
  const parsed = parseCodexAsyncQuestionRecordCandidates({
    version: "0.155.1",
    records: [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input_async",
          call_id: "async-message-call",
          arguments: argumentsJson,
          internal_chat_message_metadata_passthrough: {
            turn_id: "turn-1234"
          }
        }
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "async-message-call",
          output: "{\"accepted\":true}"
        }
      }
    ]
  });
  assert.equal(parsed.status, "candidates");
  if (parsed.status !== "candidates") return;
  assert.deepEqual(parsed.evidence, [{
    itemId: "async-message-call",
    turnId: "turn-1234",
    questions: [
      {
        title: "Which environment should I use?",
        options: ["Staging", "Production"]
      },
      { title: "What deadline should I use?" }
    ]
  }]);
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes("function_call_output"), false);
  assert.equal(serialized.includes("accepted"), false);
  assert.equal(serialized.includes("arguments"), false);
});

test("durable-record parser fails closed on duplicate identities and malformed questions", () => {
  const record = {
    type: "response_item",
    payload: {
      type: "function_call",
      name: "request_user_input_async",
      call_id: "duplicate",
      arguments: JSON.stringify({ questions: [{ title: "Question?" }] }),
      internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
    }
  };
  assert.deepEqual(
    parseCodexAsyncQuestionRecordCandidates({
      version: "0.154.0",
      records: [record, record]
    }),
    { status: "ambiguous", reason: "duplicate_item_id" }
  );
  assert.deepEqual(
    parseCodexAsyncQuestionRecordCandidates({
      version: "0.154.0",
      records: [{
        ...record,
        payload: { ...record.payload, arguments: "{not-json" }
      }]
    }),
    { status: "ambiguous", reason: "invalid_arguments" }
  );
});

test("collapsed golden frames recognize both official bindings and keep semantic ids stable", () => {
  const alt = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence: EVIDENCE,
    screen: [
      "• Working (0s • esc to interrupt)",
      "",
      "• Queued follow-up inputs",
      "  ? 2 questions · 15s",
      "    ⌥ + ↑ to answer"
    ].join("\n")
  });
  const shifted = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence: EVIDENCE,
    screen: [
      "• Queued follow-up inputs",
      "  ? 2 questions · 14s",
      "    shift + ← to answer"
    ].join("\n")
  });
  assert.equal(alt.state, "collapsed");
  assert.equal(shifted.state, "collapsed");
  if (alt.state !== "collapsed" || shifted.state !== "collapsed") return;
  assert.equal(alt.pending_count, 2);
  assert.equal(alt.countdown_seconds, 15);
  assert.equal(alt.match?.question.prompt, "Which environment should I use?");
  assert.equal(
    alt.match?.question.question_id,
    shifted.match?.question.question_id
  );
  assert.equal(
    alt.prompt_evidence.semantic_sha256,
    shifted.prompt_evidence.semantic_sha256
  );
  assert.notEqual(
    alt.prompt_evidence.exact_region_sha256,
    shifted.prompt_evidence.exact_region_sha256
  );
  assert.deepEqual(alt.owner_private_action_plan, {
    kind: "open_async_question_editor",
    binding: "alt_up",
    expected_pending_count: 2,
    expected_region_sha256: alt.prompt_evidence.exact_region_sha256
  });
});

test("collapsed pending-count reduction advances the durable question in order", () => {
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence: EVIDENCE,
    screen: [
      "• Queued follow-up inputs",
      "  ? 1 question",
      "    shift + ← to answer"
    ].join("\n")
  });
  assert.equal(inspection.state, "collapsed");
  if (inspection.state === "collapsed") {
    assert.equal(inspection.match?.source_question_index, 1);
    assert.equal(
      inspection.match?.question.prompt,
      "What deadline should I use?"
    );
  }
});

test("ordinary queued follow-up text is not misclassified as an async question", () => {
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence: EVIDENCE,
    screen: [
      "• Queued follow-up inputs",
      "  ↳ queued follow-up",
      "    continuation",
      "    shift + ← edit last queued message",
      "",
      "› existing main draft",
      "gpt-5.6-sol high · /repo"
    ].join("\n")
  });
  assert.deepEqual(inspection, {
    state: "absent",
    reason: "no_async_question_surface"
  });
});

test("expanded option golden frame matches the exact durable question and semantic options", () => {
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence: EVIDENCE,
    screen: EXPANDED_OPTIONS
  });
  assert.equal(inspection.state, "expanded");
  if (inspection.state !== "expanded") return;
  assert.equal(inspection.current_step, 1);
  assert.equal(inspection.total_steps, 2);
  assert.equal(inspection.match.question.response_kind, "single_select");
  assert.deepEqual(
    inspection.match.question.options?.map((option) => [
      option.label,
      option.kind
    ]),
    [
      ["Staging", "suggested"],
      ["Production", "suggested"],
      ["Other", "free_text_entry"]
    ]
  );
  assert.equal(
    inspection.match.selected_option_id,
    inspection.match.question.options?.[0]?.option_id
  );
  assert.equal(
    inspection.owner_private_action_plan.kind,
    "answer_async_question"
  );
  if (inspection.owner_private_action_plan.kind !== "answer_async_question") {
    return;
  }
  assert.deepEqual(
    inspection.owner_private_action_plan.choices.map((choice) => choice.intent),
    ["submit_choice", "submit_choice", "open_free_text"]
  );
  assert.deepEqual(inspection.owner_private_action_plan.delivery, {
    steer_current_turn: "submit",
    queue_next_turn: "queue"
  });
});

test("selected native Other becomes a distinct free-text interaction step", () => {
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence: EVIDENCE,
    screen: EXPANDED_OPTIONS
      .replace("  › 1. Staging", "    1. Staging")
      .replace("    3. Other", "  › 3. Other")
  });
  assert.equal(inspection.state, "expanded");
  if (inspection.state === "expanded") {
    assert.equal(inspection.match.question.response_kind, "free_text");
    assert.equal(inspection.match.selected_option_id, undefined);
    assert.equal(
      inspection.owner_private_action_plan.kind === "answer_async_question"
        ? inspection.owner_private_action_plan.free_text.intent
        : undefined,
      "enter_free_text"
    );
  }
});

test("expanded free-text golden frame matches after the first question is consumed", () => {
  const evidence: readonly CodexAsyncQuestionDurableEvidence[] = [{
    ...EVIDENCE[0]!,
    currentIndex: 1,
    remainingCount: 1
  }];
  const inspection = inspectCodexAsyncQuestion({
    version: "0.154.0",
    evidence,
    screen: [
      "• Queued follow-up inputs",
      "",
      "  What deadline should I use?",
      "",
      "  Type your answer",
      "",
      "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt"
    ].join("\n")
  });
  assert.equal(inspection.state, "expanded");
  if (inspection.state !== "expanded") return;
  assert.equal(inspection.current_step, 1);
  assert.equal(inspection.total_steps, 1);
  assert.equal(inspection.match.source_question_index, 1);
  assert.equal(inspection.match.question.response_kind, "free_text");
  assert.equal(inspection.match.question.options, undefined);
  assert.deepEqual(
    inspection.owner_private_action_plan.kind === "answer_async_question"
      ? inspection.owner_private_action_plan.free_text
      : undefined,
    { intent: "enter_free_text", max_characters: 4_096 }
  );
});

test("expanded remaining question uses the original durable item after native removal", () => {
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence: EVIDENCE,
    screen: [
      "• Queued follow-up inputs",
      "",
      "  What deadline should I use?",
      "",
      "  Type your answer",
      "",
      "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt"
    ].join("\n")
  });
  assert.equal(inspection.state, "expanded");
  if (inspection.state !== "expanded") return;
  assert.equal(inspection.current_step, 1);
  assert.equal(inspection.total_steps, 1);
  assert.equal(inspection.match.source_question_index, 1);
  assert.equal(inspection.match.question.response_kind, "free_text");
});

test("expanded mutable queue progress permits sequential removal and manual navigation", () => {
  const evidence: readonly CodexAsyncQuestionDurableEvidence[] = [{
    ...EVIDENCE[0]!,
    remainingCount: 3,
    questions: [...EVIDENCE[0]!.questions, { title: "Who is the owner?" }]
  }];
  for (const [progress, prompt, sourceIndex] of [
    ["1 of 2", "What deadline should I use?", 1],
    ["2 of 3", "What deadline should I use?", 1],
    ["2 of 2", "Who is the owner?", 2]
  ] as const) {
    const inspection = inspectCodexAsyncQuestion({
      version: "0.155.1",
      evidence,
      screen: [
        `  ${progress}`,
        "",
        `  ${prompt}`,
        "",
        "  Type your answer",
        "",
        "  enter submit   ctrl + ] skip   ⌥ + ↓ prev question"
      ].join("\n")
    });
    assert.equal(inspection.state, "expanded", progress);
    if (inspection.state === "expanded") {
      assert.equal(inspection.match.source_question_index, sourceIndex);
    }
  }
});

test("expanded progress counts the combined native queue across durable items", () => {
  const evidence: readonly CodexAsyncQuestionDurableEvidence[] = [
    EVIDENCE[0]!,
    {
      itemId: "later-question-call",
      turnId: EVIDENCE[0]!.turnId,
      currentIndex: 0,
      remainingCount: 1,
      questions: [{ title: "Who is the owner?" }]
    }
  ];
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence,
    screen: [
      "  3 of 3",
      "",
      "  Who is the owner?",
      "",
      "  Type your answer",
      "",
      "  enter submit   ctrl + ] skip   ⌥ + ↓ prev question"
    ].join("\n")
  });
  assert.equal(inspection.state, "expanded");
  if (inspection.state === "expanded") {
    assert.equal(inspection.current_step, 3);
    assert.equal(inspection.total_steps, 3);
    assert.equal(inspection.match.source_question_index, 0);
  }
});

test("expanded progress still rejects impossible or truncated native counts", () => {
  for (const progress of ["3 of 2", "1 of 3", "2 of", "2 of 2 clipped"]) {
    const inspection = inspectCodexAsyncQuestion({
      version: "0.155.1",
      evidence: EVIDENCE,
      screen: EXPANDED_OPTIONS.replace("1 of 2", progress)
    });
    assert.equal(inspection.state, "ambiguous", progress);
  }
});

test("owned free-text proof requires the same expanded question and complete input row", () => {
  const evidence = [EVIDENCE[0]!];
  const empty = [
    "  What deadline should I use?",
    "",
    "  Type your answer",
    "",
    "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt"
  ].join("\n");
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1", screen: empty, evidence
  });
  assert.equal(inspection.state, "expanded");
  if (inspection.state !== "expanded") return;
  const expectedQuestionId = inspection.match.question.question_id;
  const text = "Friday afternoon";
  const filled = empty.replace("Type your answer", text);
  const verify = (screen: string, expectedText = text) =>
    verifyCodexAsyncQuestionInjectedText({
      version: "0.155.1", screen, evidence, expectedQuestionId, expectedText
    });
  assert.equal(verify(filled), true);
  assert.equal(inspectCodexAsyncQuestion({
    version: "0.155.1", screen: filled, evidence
  }).state, "ambiguous", "ordinary observation must still reject a draft");
  assert.equal(verify(empty), false);
  assert.equal(verify(filled.replace(text, "Friday  afternoon")), false);
  assert.equal(verify(filled.replace(text, "Friday\n  afternoon")), false);
  assert.equal(verify(filled.replace("deadline", "owner")), false);
  assert.equal(verify(filled.replace("enter submit", "f9 submit")), false);
  assert.equal(verify(`${empty}\n› ${text}`), false);
  assert.equal(verify(`› ${text}\ngpt-5.6-sol high · /repo`), false);
  assert.equal(verify(empty, "Type your answer"), false);
});

test("owned Other proof rejects text in named options and accepts only its selected input", () => {
  const empty = EXPANDED_OPTIONS
    .replace("  › 1. Staging", "    1. Staging")
    .replace("    3. Other", "  › 3. Other");
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1", screen: empty, evidence: EVIDENCE
  });
  assert.equal(inspection.state, "expanded");
  if (inspection.state !== "expanded") return;
  const expectedQuestionId = inspection.match.question.question_id;
  const verify = (screen: string, expectedText = "Development") =>
    verifyCodexAsyncQuestionInjectedText({
      version: "0.155.1", screen, evidence: EVIDENCE,
      expectedQuestionId, expectedText
    });
  assert.equal(verify(empty.replace("3. Other", "3. Development")), true);
  assert.equal(verify(empty.replace("1. Staging", "1. Development")), false);
  assert.equal(verify(empty), false);
  assert.equal(verify(empty, "Other"), false);
  assert.equal(verify(empty.replace("3. Other", "3. Dev\n       elopment")), false);
  assert.equal(verify(empty.replace("3. Other", "3. Development\n       extra")), false);
});

test("withdraw-only main Composer proof rejects unavailable, partial, and question frames", () => {
  const main = "• Working (5s • esc to interrupt)\n\n› \n\ngpt-5.6-sol high · /repo";
  assert.equal(codexAsyncQuestionMainComposerVisible({
    version: "0.155.1", screen: main
  }), true);
  for (const screen of [
    "", "• Working (5s • esc to interrupt)", "› ",
    main.replace("gpt-5.6-sol high · /repo", "gpt-5.6-sol high ·"),
    EXPANDED_OPTIONS,
    `• Queued follow-up inputs\n  ? 1 question\n    shift + ← to answer\n${main}`
  ]) {
    assert.equal(codexAsyncQuestionMainComposerVisible({
      version: "0.155.1", screen
    }), false, screen);
  }
  assert.equal(codexAsyncQuestionMainComposerVisible({
    version: "0.155.2", screen: main
  }), false);
});

test("wrapped prompts and options match normalized durable semantics", () => {
  const evidence: readonly CodexAsyncQuestionDurableEvidence[] = [{
    itemId: "wrapped-call",
    turnId: "turn-wrapped",
    currentIndex: 0,
    remainingCount: 1,
    questions: [{
      title: "Which environment should I use for this deployment?",
      options: [
        "A suggested answer that is long enough to wrap across multiple rows"
      ]
    }]
  }];
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence,
    screen: [
      "  Which environment should I use for",
      "  this deployment?",
      "",
      "  › 1. A suggested answer that is long enough to",
      "       wrap across multiple rows",
      "    2. Other",
      "",
      "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt"
    ].join("\n")
  });
  assert.equal(inspection.state, "expanded");
  if (inspection.state === "expanded") {
    assert.equal(
      inspection.match.question.options?.[0]?.label,
      "A suggested answer that is long enough to wrap across multiple rows"
    );
  }
});

test("clipped, narrow, partial, unknown, and mismatched surfaces fail closed", () => {
  const cases = [
    {
      expected: "clipped_question",
      screen: [
        "  Second",
        "",
        "  › 2. A suggested answer that is long enough to",
        "       wrap across multiple rows",
        "",
        "  Expand terminal to read the entire option"
      ].join("\n")
    },
    {
      expected: "partial_or_unknown_surface",
      screen: [
        "  2 of",
        "  Secon",
        "  d",
        "  › x",
        "  ente…",
        "  ctrl…"
      ].join("\n")
    },
    {
      expected: "partial_or_unknown_surface",
      screen: [
        "• Queued follow-up inputs",
        "  ? 2 questions",
        "    shortcut unavailable"
      ].join("\n")
    },
    {
      expected: "question_match_missing",
      screen: EXPANDED_OPTIONS.replace(
        "Which environment should I use?",
        "Which production account should I use?"
      )
    },
    {
      expected: "unsupported_keymap",
      screen: EXPANDED_OPTIONS.replace("enter submit", "f9 submit")
    }
  ];
  for (const fixture of cases) {
    const inspection = inspectCodexAsyncQuestion({
      version: "0.155.1",
      evidence: EVIDENCE,
      screen: fixture.screen
    });
    assert.equal(inspection.state, "ambiguous", fixture.expected);
    if (inspection.state === "ambiguous") {
      assert.equal(inspection.reason, fixture.expected);
    }
  }
});

test("duplicate semantic questions remain ambiguous instead of guessing a source", () => {
  const duplicated: readonly CodexAsyncQuestionDurableEvidence[] = [
    {
      itemId: "one",
      turnId: "turn-1",
      questions: [{
        title: "Which environment should I use?",
        options: ["Staging", "Production"]
      }]
    },
    {
      itemId: "two",
      turnId: "turn-1",
      questions: [{
        title: "Which environment should I use?",
        options: ["Staging", "Production"]
      }]
    }
  ];
  const screen = EXPANDED_OPTIONS
    .replace("  1 of 2\n\n", "")
    .replace("   shift + ← next question", "");
  const inspection = inspectCodexAsyncQuestion({
    version: "0.155.1",
    evidence: duplicated,
    screen
  });
  assert.deepEqual(inspection, {
    state: "ambiguous",
    reason: "question_match_ambiguous",
    profile: "codex/0.155.1/request-user-input-async-v1"
  });
});
