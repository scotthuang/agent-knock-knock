import test from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_QUESTIONNAIRE_PROFILES,
  inspectNativeQuestionnaire,
  type NativeQuestionnaireInspection
} from "../src/terminal-questionnaire-adapter.js";

const CODEX_OPTIONS = `
earlier scrollback

  Question 1/1 (1 unanswered)
  Choose an option.

  › 1. Option 1  First choice.
    2. Option 2  Second choice.
    3. Option 3  Third choice.

  tab to add notes | enter to submit answer | esc to interrupt
`;

const CODEX_MULTI_QUESTION = `
  Question 1/2 (2 unanswered)
  Choose an option.

  › 1. Option 1  First choice.
    2. Option 2  Second choice.
    3. Option 3  Third choice.

  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt
`;

const CODEX_MULTI_QUESTION_WRAPPED = CODEX_MULTI_QUESTION.replace(
  "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
  "  tab to add notes | enter to submit answer | ←/→ to navigate questions\n  esc to interrupt"
);

const CODEX_MULTI_LAST_OPTION = CODEX_MULTI_QUESTION
  .replace("Question 1/2 (2 unanswered)", "Question 2/2 (1 unanswered)")
  .replace("Choose an option.", "Choose the final option.")
  .replace("enter to submit answer", "enter to submit all");

const CODEX_MULTI_LAST_OPTION_WRAPPED = CODEX_MULTI_LAST_OPTION.replace(
  "  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt",
  "  tab to add notes | enter to submit all\n  ←/→ to navigate questions | esc to interrupt"
);

const CODEX_FREEFORM = `
  Question 1/1 (1 unanswered)
  Share details.

  › Type your answer (optional)



  enter to submit answer | esc to interrupt
`;

const CODEX_MULTI_FREEFORM = `
  Question 2/2 (2 unanswered)
  Share details.

  › Type your answer (optional)

  enter to submit all | ctrl + p / ctrl + n change question | esc to interrupt
`;

const CODEX_MULTI_FREEFORM_WRAPPED = CODEX_MULTI_FREEFORM.replace(
  "  enter to submit all | ctrl + p / ctrl + n change question | esc to interrupt",
  "  enter to submit all\n  ctrl + p / ctrl + n change question | esc to interrupt"
);

const CODEX_MULTI_FIRST_FREEFORM = CODEX_MULTI_FREEFORM
  .replace("Question 2/2 (2 unanswered)", "Question 1/2 (2 unanswered)")
  .replace("enter to submit all", "enter to submit answer");

const CODEX_CUSTOM_OPTIONS = `
  Question 2/2 (1 unanswered)
  In one sentence: what makes a great developer experience?

  › 1. Fast feedback (Recommended)  Use this concise preset answer.
    2. Type something.  Type a free-form one-sentence answer.
    3. None of the above  Optionally, add details in notes (tab).

  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt
`;

const CODEX_CUSTOM_TEXT_EDIT = `
  Question 2/2 (1 unanswered)
  In one sentence: what makes a great developer experience?

    1. Fast feedback (Recommended)  Use this concise preset answer.
    2. Type something.  Type a free-form one-sentence answer.
  › 3. None of the above  Optionally, add details in notes (tab).

  › Add notes

  tab or esc to clear notes | enter to submit all
`;

const CODEX_NATIVE_OTHER_OPTIONS = `
  Question 2/2 (1 unanswered)
  In one sentence: what makes a great developer experience?

  › 1. Clear defaults (Recommended)  Use the default configuration.
    2. None of the above  Optionally, add details in notes (tab).

  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt
`;

const CODEX_WRAPPED_DESCRIPTION_OPTIONS = `
  Question 2/2 (1 unanswered)
  In one sentence: what makes a great developer experience?

  › 1. Clear defaults (Recommended)  Prioritize predictable behavior and reduce
                                     ambiguity.
    2. Detailed guidance  Explain every relevant tradeoff.
    3. None of the above  Optionally, add details in notes (tab).

  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt
`;

const CODEX_NATIVE_OTHER_TEXT_EDIT = `
  Question 2/2 (1 unanswered)
  In one sentence: what makes a great developer experience?

    1. Clear defaults (Recommended)  Use the default configuration.
  › 2. None of the above  Optionally, add details in notes (tab).

  › Add notes

  tab or esc to clear notes | enter to submit all
`;

const CODEX_UNANSWERED_CONFIRM = `
  Submit with unanswered questions?
  2 unanswered questions

  › 1. Proceed  Submit with 2 unanswered questions.
    2. Go back  Return to the first unanswered question.




  Press enter to confirm or esc to go back
`;

const CLAUDE_SINGLE_SELECT = `
old conversation output
 ☐ Color

Which color do you prefer?

❯ 1. Red
     The color red
  2. Blue
     The color blue
  3. Type something.
────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const CLAUDE_MULTI_SELECT = `
←  ☒ Color  ☐ Pets  ✔ Submit  →

Which pets do you like?

❯ 1. [ ] Cat
  Cat description
  2. [ ] Dog
  Dog description
  3. [ ] Type something
     Submit
────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

const CLAUDE_FINAL_REVIEW = `
←  ☒ Color  ☒ Pets  ✔ Submit  →

Review your answers

 ● Which color do you prefer?
   → Blue
 ● Which pets do you like?
   → Cat, Bird

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`;

const CLAUDE_CUSTOM_TEXT_EDIT = `
 ☐ Color

Which color do you prefer?

  1. Red
     The color red
  2. Blue
     The color blue
❯ 3. Type something.
────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel
`;

function actionable(
  inspection: NativeQuestionnaireInspection
): Extract<NativeQuestionnaireInspection, { status: "actionable" }> {
  assert.equal(inspection.status, "actionable");
  return inspection as Extract<
    NativeQuestionnaireInspection,
    { status: "actionable" }
  >;
}

function manual(
  inspection: NativeQuestionnaireInspection
): Extract<NativeQuestionnaireInspection, { status: "manual_required" }> {
  assert.equal(inspection.status, "manual_required");
  return inspection as Extract<
    NativeQuestionnaireInspection,
    { status: "manual_required" }
  >;
}

test("Codex 0.153.4 exact option snapshot yields one semantic question", () => {
  const parsed = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_OPTIONS
  }));

  assert.equal(parsed.profile, NATIVE_QUESTIONNAIRE_PROFILES.codex);
  assert.deepEqual(
    [parsed.current_step, parsed.total_steps],
    [1, 1]
  );
  assert.equal(parsed.question.prompt, "Choose an option.");
  assert.equal(parsed.question.response_kind, "single_select");
  assert.deepEqual(
    parsed.question.options?.map((option) => option.label),
    ["Option 1", "Option 2", "Option 3"]
  );
  assert.ok(parsed.question.options?.every((option) =>
    option.option_id.startsWith("option_") && !/^option_[1-3]$/u.test(option.option_id)
  ));
  assert.doesNotMatch(JSON.stringify(parsed.question), /"key"/u);
  assert.deepEqual(parsed.action_plan, {
    kind: "single_select",
    choices: parsed.question.options?.map((option, index) => ({
      option_id: option.option_id,
      outcome: "submit_or_advance",
      stages: [{ kind: "key", key: String(index + 1) }]
    }))
  });
  assert.match(parsed.prompt_evidence.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(parsed.prompt_evidence.footer,
    "  tab to add notes | enter to submit answer | esc to interrupt");
});

test("Codex official multi-question header preserves current step and total", () => {
  const unwrapped = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_MULTI_QUESTION
  }));
  const wrapped = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_MULTI_QUESTION_WRAPPED
  }));

  assert.equal(unwrapped.current_step, 1);
  assert.equal(unwrapped.total_steps, 2);
  assert.equal(unwrapped.question.response_kind, "single_select");
  assert.equal(unwrapped.action_plan.kind, "single_select");
  assert.deepEqual(wrapped.question, unwrapped.question);
  assert.deepEqual(wrapped.action_plan, unwrapped.action_plan);
  assert.notEqual(
    wrapped.prompt_evidence.sha256,
    unwrapped.prompt_evidence.sha256
  );
  assert.equal(
    wrapped.prompt_evidence.footer,
    "  tab to add notes | enter to submit answer | ←/→ to navigate questions\n  esc to interrupt"
  );
});

test("Codex final option question accepts exact submit-all footers", () => {
  const unwrapped = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_MULTI_LAST_OPTION
  }));
  const wrapped = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_MULTI_LAST_OPTION_WRAPPED
  }));

  assert.deepEqual([unwrapped.current_step, unwrapped.total_steps], [2, 2]);
  assert.equal(unwrapped.question.response_kind, "single_select");
  assert.equal(unwrapped.action_plan.kind, "single_select");
  assert.deepEqual(wrapped.question, unwrapped.question);
  assert.deepEqual(wrapped.action_plan, unwrapped.action_plan);
  assert.notEqual(
    wrapped.prompt_evidence.sha256,
    unwrapped.prompt_evidence.sha256
  );
});

test("Codex exact freeform snapshot yields a bounded text-then-Enter plan", () => {
  const parsed = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_FREEFORM
  }));

  assert.equal(parsed.question.response_kind, "free_text");
  assert.equal(parsed.question.required, false);
  assert.deepEqual(parsed.action_plan, {
    kind: "free_text",
    stages: [
      { kind: "answer_text", single_line: true, max_characters: 4_096 },
      { kind: "key", key: "C-m" }
    ]
  });
});

test("Codex exact multi-question freeform is actionable one step at a time", () => {
  const unwrapped = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_MULTI_FREEFORM
  }));
  const wrapped = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_MULTI_FREEFORM_WRAPPED
  }));
  const first = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_MULTI_FIRST_FREEFORM
  }));

  assert.deepEqual([unwrapped.current_step, unwrapped.total_steps], [2, 2]);
  assert.equal(unwrapped.question.response_kind, "free_text");
  assert.equal(unwrapped.action_plan.kind, "free_text");
  assert.deepEqual(wrapped.question, unwrapped.question);
  assert.deepEqual(wrapped.action_plan, unwrapped.action_plan);
  assert.notEqual(
    wrapped.prompt_evidence.sha256,
    unwrapped.prompt_evidence.sha256
  );
  assert.deepEqual([first.current_step, first.total_steps], [1, 2]);
  assert.equal(first.question.response_kind, "free_text");
});

test("Codex guarded custom choices open notes before exposing free text", () => {
  assert.equal(
    NATIVE_QUESTIONNAIRE_PROFILES.codex,
    "codex/0.153.4/request-user-input-v3"
  );
  const choice = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_CUSTOM_OPTIONS
  }));
  assert.equal(choice.question.response_kind, "single_select");
  assert.deepEqual(
    choice.question.options?.map((option) => option.label),
    ["Fast feedback (Recommended)", "Type something.", "None of the above"]
  );
  assert.equal(choice.action_plan.kind, "single_select");
  if (choice.action_plan.kind === "single_select") {
    assert.deepEqual(choice.action_plan.choices.map((item) => ({
      outcome: item.outcome,
      keys: item.stages.map((stage) =>
        stage.kind === "key" ? stage.key : "text"
      )
    })), [
      { outcome: "submit_or_advance", keys: ["1"] },
      { outcome: "open_custom_text", keys: ["Down", "Down", "C-m"] },
      { outcome: "submit_or_advance", keys: ["3"] }
    ]);
  }

  const editor = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_CUSTOM_TEXT_EDIT
  }));
  assert.equal(editor.question.response_kind, "free_text");
  assert.equal(editor.question.required, true);
  assert.equal(editor.question.options, undefined);
  assert.deepEqual(editor.action_plan, {
    kind: "free_text",
    stages: [
      { kind: "answer_text", single_line: true, max_characters: 4_096 },
      { kind: "key", key: "C-m" }
    ]
  });
  assert.notEqual(editor.question.question_id, choice.question.question_id);
  assert.notEqual(editor.prompt_evidence.sha256, choice.prompt_evidence.sha256);
});

test("Codex derives a Notes choice while preserving native Other direct selection", () => {
  const choice = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_NATIVE_OTHER_OPTIONS
  }));
  assert.deepEqual(
    choice.question.options?.map((option) => option.label),
    [
      "Clear defaults (Recommended)",
      "Type something.",
      "None of the above"
    ]
  );
  assert.equal(choice.action_plan.kind, "single_select");
  if (choice.action_plan.kind === "single_select") {
    assert.deepEqual(choice.action_plan.choices.map((item) => ({
      outcome: item.outcome,
      keys: item.stages.map((stage) =>
        stage.kind === "key" ? stage.key : "text"
      )
    })), [
      { outcome: "submit_or_advance", keys: ["1"] },
      { outcome: "open_custom_text", keys: ["Down", "C-m"] },
      { outcome: "submit_or_advance", keys: ["2"] }
    ]);
  }

  const editor = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_NATIVE_OTHER_TEXT_EDIT
  }));
  assert.equal(editor.question.response_kind, "free_text");
  assert.equal(editor.question.required, true);
  assert.equal(editor.action_plan.kind, "free_text");
});

test("Codex joins exact-column wrapped option descriptions on the final question", () => {
  const wrapped = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_WRAPPED_DESCRIPTION_OPTIONS
  }));
  const unwrapped = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_WRAPPED_DESCRIPTION_OPTIONS.replace(
      "reduce\n                                     ambiguity.",
      "reduce ambiguity."
    )
  }));

  assert.deepEqual([wrapped.current_step, wrapped.total_steps], [2, 2]);
  assert.equal(
    wrapped.prompt_evidence.footer,
    "  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt"
  );
  assert.deepEqual(wrapped.question, unwrapped.question);
  assert.deepEqual(wrapped.action_plan, unwrapped.action_plan);
  assert.equal(
    wrapped.question.options?.[0]?.description,
    "Prioritize predictable behavior and reduce ambiguity."
  );
  assert.notEqual(
    wrapped.prompt_evidence.sha256,
    unwrapped.prompt_evidence.sha256
  );
});

test("Codex rejects malformed option-description continuation indentation", () => {
  const changed = manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_WRAPPED_DESCRIPTION_OPTIONS.replace(
      "                                     ambiguity.",
      "                                    ambiguity."
    )
  }));
  assert.equal(changed.reason, "changed_shape");
  assert.deepEqual(changed.action_plan, { kind: "manual_only" });
});

test("Codex custom-text aliases require the exact native Other authority", () => {
  const aliasOnly = manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_OPTIONS.replace("Option 2", "Type something.")
  }));
  assert.equal(aliasOnly.reason, "changed_shape");
  assert.deepEqual(aliasOnly.action_plan, { kind: "manual_only" });

  const changedOther = CODEX_CUSTOM_OPTIONS.replace(
    "Optionally, add details in notes (tab).",
    "Add a custom answer."
  );
  const changed = manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: changedOther
  }));
  assert.equal(changed.reason, "changed_shape");
  assert.deepEqual(changed.action_plan, { kind: "manual_only" });

  const typedDraft = CODEX_CUSTOM_TEXT_EDIT.replace(
    "  › Add notes",
    "  › existing human draft"
  );
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: typedDraft
  })).reason, "changed_shape");
});

test("Codex exact unanswered confirmation has closed confirm/cancel plans", () => {
  const parsed = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_UNANSWERED_CONFIRM
  }));

  assert.equal(parsed.question.response_kind, "confirm");
  assert.deepEqual(parsed.action_plan, {
    kind: "confirm",
    confirm_stages: [{ kind: "key", key: "C-m" }],
    cancel_stages: [{ kind: "key", key: "Escape" }]
  });
});

test("Codex requires bottom-most exact footer and strict ordered numbering", () => {
  const changedFooter = CODEX_OPTIONS.replace(
    "enter to submit answer",
    "enter to choose"
  );
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: changedFooter
  })).reason, "changed_shape");

  const contentAfterFooter = `${CODEX_OPTIONS.trimEnd()}\nnew output below`;
  assert.equal(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: contentAfterFooter
  }).status, "none");

  const outOfOrder = CODEX_OPTIONS.replace("    2. Option 2", "    3. Option 2");
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: outOfOrder
  })).reason, "changed_shape");

  const earlySubmitAll = CODEX_MULTI_QUESTION.replace(
    "enter to submit answer",
    "enter to submit all"
  );
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: earlySubmitAll
  })).reason, "changed_shape");

  const finalSubmitAnswer = CODEX_MULTI_LAST_OPTION.replace(
    "enter to submit all",
    "enter to submit answer"
  );
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: finalSubmitAnswer
  })).reason, "changed_shape");

  const reorderedWrappedTips = CODEX_MULTI_QUESTION_WRAPPED.replace(
    "tab to add notes | enter to submit answer",
    "enter to submit answer | tab to add notes"
  );
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: reorderedWrappedTips
  })).reason, "changed_shape");

  const splitInsideTip = CODEX_MULTI_QUESTION_WRAPPED.replace(
    "enter to submit answer",
    "enter to submit\n  answer"
  );
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: splitInsideTip
  })).reason, "changed_shape");
});

test("Codex false positives remain absent and changed versions fail closed", () => {
  assert.deepEqual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: "The docs say Question 1/1 and enter to submit answer."
  }), {
    status: "none",
    agent: "codex",
    reason: "no_questionnaire_surface"
  });

  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.154.0",
    screen: CODEX_OPTIONS
  })).reason, "unsupported_version");
});

test("Codex explicit or visible secret questions are never actionable", () => {
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_OPTIONS,
    secret: true
  })).reason, "secret_input");

  const password = CODEX_FREEFORM.replace("Share details.", "Enter password.");
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: password
  })).reason, "secret_input");
});

test("Claude 2.1.263 exact framed choice exposes only semantic option ids", () => {
  const parsed = actionable(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: CLAUDE_SINGLE_SELECT
  }));

  assert.equal(parsed.profile, NATIVE_QUESTIONNAIRE_PROFILES.claude);
  assert.deepEqual(
    [parsed.current_step, parsed.total_steps],
    [1, 1]
  );
  assert.equal(parsed.question.prompt, "Which color do you prefer?");
  assert.deepEqual(
    parsed.question.options?.map((option) => option.label),
    ["Red", "Blue", "Type something."]
  );
  assert.doesNotMatch(JSON.stringify(parsed.question), /"key"/u);
  assert.equal(parsed.action_plan.kind, "single_select");
  if (parsed.action_plan.kind === "single_select") {
    assert.equal(parsed.action_plan.choices.at(-1)?.outcome, "open_custom_text");
    assert.deepEqual(
      parsed.action_plan.choices.at(-1)?.stages,
      [{ kind: "key", key: "3" }]
    );
  }
  assert.equal(parsed.prompt_evidence.exact_region.startsWith(" ☐ Color"), true);
  assert.equal(parsed.prompt_evidence.exact_region.includes("old conversation"), false);
});

test("Claude exact multi-select is detected but mutation fails closed", () => {
  const parsed = manual(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: CLAUDE_MULTI_SELECT
  }));

  assert.equal(parsed.reason, "unsupported_multi_select");
  assert.deepEqual(
    [parsed.current_step, parsed.total_steps],
    [2, 3]
  );
  assert.equal(parsed.question.response_kind, "multi_select");
  assert.deepEqual(
    parsed.question.options?.map((option) => option.label),
    ["[ ] Cat", "[ ] Dog", "[ ] Type something"]
  );
  assert.deepEqual(parsed.action_plan, { kind: "manual_only" });
});

test("Claude exact final review exposes closed submit and cancel actions", () => {
  const parsed = actionable(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: CLAUDE_FINAL_REVIEW
  }));

  assert.equal(parsed.question.prompt, "Ready to submit your answers?");
  assert.equal(parsed.question.response_kind, "confirm");
  assert.deepEqual(
    [parsed.current_step, parsed.total_steps],
    [3, 3]
  );
  assert.deepEqual(parsed.action_plan, {
    kind: "confirm",
    confirm_stages: [{ kind: "key", key: "1" }],
    cancel_stages: [{ kind: "key", key: "2" }]
  });
});

test("Claude final review containing a secret answer stays manual", () => {
  const explicitSecret = manual(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: CLAUDE_FINAL_REVIEW,
    secret: true
  }));
  assert.equal(explicitSecret.reason, "secret_input");

  const visibleSecret = manual(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: CLAUDE_FINAL_REVIEW.replace(
      "Which color do you prefer?",
      "Enter the OTP to continue?"
    )
  }));
  assert.equal(visibleSecret.reason, "secret_input");
  assert.deepEqual(visibleSecret.action_plan, { kind: "manual_only" });
});

test("Claude exact custom-text edit state exposes bounded free text", () => {
  const parsed = actionable(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: CLAUDE_CUSTOM_TEXT_EDIT
  }));

  assert.equal(parsed.question.response_kind, "free_text");
  assert.equal(parsed.question.options, undefined);
  assert.deepEqual(parsed.action_plan, {
    kind: "free_text",
    stages: [
      { kind: "answer_text", single_line: true, max_characters: 799 },
      { kind: "key", key: "C-m" }
    ]
  });
});

test("Claude custom-text edit keeps explicit and visible secret input manual", () => {
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: CLAUDE_CUSTOM_TEXT_EDIT,
    secret: true
  })).reason, "secret_input");

  const password = CLAUDE_CUSTOM_TEXT_EDIT.replace(
    "Which color do you prefer?",
    "Enter the password to continue."
  );
  const visibleSecret = manual(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: password
  }));
  assert.equal(visibleSecret.reason, "secret_input");
  assert.deepEqual(visibleSecret.action_plan, { kind: "manual_only" });
});

test("Claude selection rejects changed footer, frame, numbering, and cursor state", () => {
  for (const changed of [
    CLAUDE_SINGLE_SELECT.replace("Esc to cancel", "Esc to close"),
    CLAUDE_SINGLE_SELECT.replace("────────────────────────────────", "--------"),
    CLAUDE_SINGLE_SELECT.replace("  2. Blue", "  3. Blue"),
    CLAUDE_SINGLE_SELECT.replace("❯ 1. Red", "  1. Red")
  ]) {
    assert.equal(manual(inspectNativeQuestionnaire({
      agent: "claude",
      version: "2.1.263",
      screen: changed
    })).reason, "changed_shape");
  }
});

test("Claude unsupported versions and secret questions fail closed", () => {
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.264",
    screen: CLAUDE_SINGLE_SELECT
  })).reason, "unsupported_version");

  const secret = CLAUDE_SINGLE_SELECT.replace(
    "Which color do you prefer?",
    "Which API key should be used?"
  );
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: secret
  })).reason, "secret_input");
});

test("ANSI is stripped before exact evidence and unrelated Claude text stays absent", () => {
  const ansiScreen = CLAUDE_SINGLE_SELECT.replace(
    "Which color do you prefer?",
    "\u001b[31mWhich color do you prefer?\u001b[0m"
  );
  const parsed = actionable(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: ansiScreen
  }));
  assert.equal(parsed.question.prompt, "Which color do you prefer?");
  assert.doesNotMatch(parsed.prompt_evidence.exact_region, /\u001b/u);

  assert.equal(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: "Claude discussed a survey and then returned to its normal composer."
  }).status, "none");

  assert.equal(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: `${CLAUDE_SINGLE_SELECT.trimEnd()}\n\n❯ ordinary composer`
  }).status, "none");
});

test("evidence fingerprint is stable and binds exact visible prompt content", () => {
  const first = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_OPTIONS
  }));
  const second = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_OPTIONS
  }));
  const changed = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_OPTIONS.replace("Choose an option.", "Choose a target.")
  }));

  assert.equal(first.prompt_evidence.sha256, second.prompt_evidence.sha256);
  assert.notEqual(first.prompt_evidence.sha256, changed.prompt_evidence.sha256);
});
