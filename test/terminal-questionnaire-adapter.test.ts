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

const CODEX_FREEFORM = `
  Question 1/1 (1 unanswered)
  Share details.

  › Type your answer (optional)



  enter to submit answer | esc to interrupt
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
←  ☐ Color  ☐ Pets  ✔ Submit  →
Which color do you prefer?
❯ 1. Red
     The color red
  2. Blue
     The color blue
  3. Green
     The color green
  4. Type something.
────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

const CLAUDE_MULTI_SELECT = `
←  ☒ Color  ☐ Pets  ✔ Submit  →
Which pets do you like?
❯ 1. [ ] Cat
  2. [ ] Dog
  3. [ ] Bird
  4. [ ] Type something
────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

const CLAUDE_FINAL_REVIEW = `
←  ☒ Color  ☒ Pets  ✔ Submit  →
Review your answers
 ● Which color do you prefer? → Blue
 ● Which pets do you like? → Cat, Bird
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`;

const CLAUDE_CUSTOM_TEXT_EDIT = `
←  ☐ Drink  ✔ Submit  →
Which drink do you prefer?
❯ 1. Tea
  2. Coffee
  3. Water
  4. Sparkling water
────────────────────────────────
  5. Chat about this
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
  const parsed = actionable(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: CODEX_MULTI_QUESTION
  }));

  assert.equal(parsed.current_step, 1);
  assert.equal(parsed.total_steps, 2);
  assert.equal(parsed.question.response_kind, "single_select");
  assert.equal(parsed.action_plan.kind, "single_select");
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
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: contentAfterFooter
  })).reason, "changed_shape");

  const outOfOrder = CODEX_OPTIONS.replace("    2. Option 2", "    3. Option 2");
  assert.equal(manual(inspectNativeQuestionnaire({
    agent: "codex",
    version: "0.153.4",
    screen: outOfOrder
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
    [1, 3]
  );
  assert.equal(parsed.question.prompt, "Which color do you prefer?");
  assert.deepEqual(
    parsed.question.options?.map((option) => option.label),
    ["Red", "Blue", "Green", "Type something."]
  );
  assert.doesNotMatch(JSON.stringify(parsed.question), /"key"/u);
  assert.equal(parsed.action_plan.kind, "single_select");
  if (parsed.action_plan.kind === "single_select") {
    assert.equal(parsed.action_plan.choices.at(-1)?.outcome, "open_custom_text");
    assert.deepEqual(
      parsed.action_plan.choices.at(-1)?.stages,
      [{ kind: "key", key: "4" }]
    );
  }
  assert.equal(parsed.prompt_evidence.exact_region.startsWith("←  ☐ Color"), true);
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
    ["[ ] Cat", "[ ] Dog", "[ ] Bird", "[ ] Type something"]
  );
  assert.deepEqual(parsed.action_plan, { kind: "manual_only" });
});

test("Claude final review is recognized but remains manual without exact footer proof", () => {
  const parsed = manual(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: CLAUDE_FINAL_REVIEW
  }));

  assert.equal(parsed.reason, "unproven_final_confirmation");
  assert.equal(parsed.question.prompt, "Ready to submit your answers?");
  assert.equal(parsed.question.response_kind, "confirm");
  assert.deepEqual(
    [parsed.current_step, parsed.total_steps],
    [3, 3]
  );
  assert.deepEqual(parsed.action_plan, { kind: "manual_only" });
});

test("Claude custom-text edit state never treats entered text as an option", () => {
  const parsed = manual(inspectNativeQuestionnaire({
    agent: "claude",
    version: "2.1.263",
    screen: CLAUDE_CUSTOM_TEXT_EDIT
  }));

  assert.equal(parsed.reason, "unproven_custom_text_edit");
  assert.equal(parsed.question.response_kind, "free_text");
  assert.equal(parsed.question.options, undefined);
  assert.doesNotMatch(JSON.stringify(parsed.question), /Sparkling water/u);
  assert.deepEqual(parsed.action_plan, { kind: "manual_only" });
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
