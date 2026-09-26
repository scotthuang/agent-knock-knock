import test from "node:test";
import assert from "node:assert/strict";
import type {
  TerminalRuntimeIdentity,
  TerminalScreenInspection
} from "../src/terminal-agent-adapter.js";
import {
  captureTerminalInteractionRuntimeOffer,
  TerminalInteractionDispatchReservedError,
  TerminalInteractionInputNotStartedError,
  TerminalInteractionResponseBridge,
  type TerminalInteractionResponseInput
} from "../src/terminal-interaction-response-bridge.js";
import {
  StaticTerminalControlProvider,
  type TerminalPane
} from "../src/terminal-control-provider.js";
import type {
  TerminalControlRef,
  TerminalEndpointRef
} from "../src/terminal-control-ref.js";
import type { CodexAsyncQuestionDurableEvidence } from
  "../src/codex-async-question-adapter.js";

const NOW = new Date("2026-09-07T04:00:00.000Z");
const PANE: TerminalPane = {
  kind: "tmux",
  target: "questionnaire-response:0.0",
  socketPath: "/tmp/client.sock",
  serverSocketPath: "/tmp/server.sock",
  paneId: "%88",
  session: "questionnaire-response",
  window: 0,
  pane: 0,
  panePid: 800,
  currentCommand: "codex",
  currentPath: "/repo"
};
const RUNTIME: TerminalRuntimeIdentity = {
  pid: 801,
  agentVersion: "0.153.4",
  turnId: "turn_response_1",
  nativeTaskId: "native_turn_async_1",
  messageId: "message_response_1",
  conversationId: "conversation_response_1",
  terminalTarget: PANE.target
};
const OPTIONS_SCREEN = `
  Question 1/1 (1 unanswered)
  Choose an option.

  › 1. Option 1  First choice.
    2. Option 2  Second choice.

  tab to add notes | enter to submit answer | esc to interrupt
`;
const CHANGED_SCREEN = OPTIONS_SCREEN.replace("Choose an option.", "Choose again.");
const FREE_TEXT_SCREEN = `
  Question 1/1 (1 unanswered)
  Share details.

  › Type your answer (optional)

  enter to submit answer | esc to interrupt
`;

type Event =
  | "capture"
  | "authorize"
  | "reserve"
  | "verify"
  | `text:${string}`
  | `keys:${string}`
  | `sleep:${number}`;

class RecordingProvider extends StaticTerminalControlProvider {
  readonly events: Event[];
  failText = false;
  failKeys = false;

  constructor(events: Event[]) {
    super({ panes: [PANE] });
    this.events = events;
  }

  override async sendText(
    _terminal: TerminalEndpointRef,
    text: string
  ): Promise<void> {
    this.events.push(`text:${text}`);
    if (this.failText) {
      throw new Error("text result unknown");
    }
  }

  override async sendKeys(
    _terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    this.events.push(`keys:${keys.join(",")}`);
    if (this.failKeys) throw new Error("key result unknown");
  }
}

function inspection(screen: string): TerminalScreenInspection {
  return {
    activity: { state: "idle", reason: "test questionnaire" },
    approval: {
      blocked: false,
      approvable: false,
      reason: "not a permission prompt"
    },
    screenExcerpt: screen
  };
}

async function fixture(
  screens: readonly string[],
  asyncEvidence?: readonly CodexAsyncQuestionDurableEvidence[],
  options: {
    failVerifyAt?: number;
    driftCaptureAt?: number;
    evidenceByCapture?: readonly (readonly CodexAsyncQuestionDurableEvidence[])[];
    evidenceAfterNavigation?: readonly CodexAsyncQuestionDurableEvidence[];
  } = {}
) {
  const events: Event[] = [];
  const provider = new RecordingProvider(events);
  const endpoint = (await provider.listTerminals())[0];
  assert.ok(endpoint);
  const control = provider.toControlRef(endpoint, ["screen_status", "send_keys"]);
  let captureIndex = 0;
  let verifyIndex = 0;
  const service = new TerminalInteractionResponseBridge(provider, {
    captureInspection: async (_agent, currentControl) => {
      events.push("capture");
      const screen = screens[Math.min(captureIndex, screens.length - 1)] ?? "";
      captureIndex += 1;
      return {
        terminalControl: captureIndex === options.driftCaptureAt
          ? { ...currentControl, target: "different:0.0" }
          : currentControl,
        screen,
        inspection: inspection(screen)
      };
    },
    verifyIdentity: async (_agent, currentControl) => {
      events.push("verify");
      verifyIndex += 1;
      if (verifyIndex === options.failVerifyAt) {
        throw new Error("identity changed during response");
      }
      return currentControl;
    },
    now: () => new Date(NOW),
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
    },
    ...(asyncEvidence === undefined
      ? {}
      : { captureCodexAsyncQuestionEvidence: () =>
          options.evidenceByCapture?.[captureIndex - 1] ??
          (captureIndex >= 4 && options.evidenceAfterNavigation
            ? options.evidenceAfterNavigation
            : asyncEvidence) })
  });
  return { events, provider, service, control };
}

const ASYNC_EVIDENCE: readonly CodexAsyncQuestionDurableEvidence[] = [{
  itemId: "call_async_1",
  turnId: "native_turn_async_1",
  currentIndex: 0,
  remainingCount: 1,
  questions: [{
    title: "Which target should I use?",
    options: ["Local", "Remote"]
  }]
}];
const ASYNC_COLLAPSED_SCREEN = [
  "• Working (3s • esc to interrupt)",
  "",
  "• Queued follow-up inputs",
  "  ? 1 question",
  "    shift + ← to answer"
].join("\n");
const ASYNC_EXPANDED_SCREEN = [
  "• Queued follow-up inputs",
  "",
  "  Which target should I use?",
  "",
  "  › 1. Local",
  "    2. Remote",
  "    3. Other",
  "",
  "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt"
].join("\n");
const ASYNC_COMPLETED_SCREEN = [
  "• Working (4s • esc to interrupt)",
  "",
  "› Implement the current task",
  "gpt-6-astra high · /repo"
].join("\n");
const ASYNC_OTHER_SCREEN = ASYNC_EXPANDED_SCREEN
  .replace("  › 1. Local", "    1. Local")
  .replace("    3. Other", "  › 3. Other");

async function answerAsyncFixture(
  harness: Awaited<ReturnType<typeof fixture>>,
  screen: string,
  answer: { option?: number; text?: string },
  deliveryMode: "steer_current_turn" | "queue_next_turn" = "steer_current_turn",
  evidence = ASYNC_EVIDENCE
) {
  const runtime = { ...RUNTIME, agentVersion: "0.155.1" };
  const offer = captureTerminalInteractionRuntimeOffer({
    agent: "codex",
    terminalControl: harness.control,
    screen,
    runtime,
    now: NOW,
    codexAsyncQuestionEvidence: evidence
  });
  assert.ok(offer);
  const question = offer.projection.questions[0];
  assert.ok(question);
  if (answer.text === undefined) assert.equal(question.response_kind, "single_select");
  const response: TerminalInteractionResponseInput["answers"][number] = answer.text !== undefined
    ? {
        question_id: question.question_id,
        response_kind: "free_text" as const,
        text: answer.text
      }
    : {
        question_id: question.question_id,
        response_kind: "single_select" as const,
        selected_option_ids: [question.response_kind === "single_select"
          ? question.options[answer.option ?? 0]!.option_id
          : "unreachable"]
      };
  return harness.service.respond("codex", harness.control, {
    ...responseFor(offer, response),
    delivery_mode: deliveryMode
  }, {
    agentVersion: "0.155.1",
    expectedFingerprint: offer.promptFingerprint,
    expectedExpiresAt: offer.projection.expires_at,
    runtime,
    authorize: () => ({ approved: true }),
    beforeDispatch: () => { harness.events.push("reserve"); }
  });
}

test("collapsed Codex async question opens, recaptures, and steers once", async () => {
  const runtime = { ...RUNTIME, agentVersion: "0.155.1" };
  const { events, service, control } = await fixture([
    ASYNC_COLLAPSED_SCREEN,
    ASYNC_COLLAPSED_SCREEN,
    ASYNC_COLLAPSED_SCREEN,
    ASYNC_EXPANDED_SCREEN,
    ASYNC_COMPLETED_SCREEN
  ], ASYNC_EVIDENCE);
  const offer = captureTerminalInteractionRuntimeOffer({
    agent: "codex",
    terminalControl: control,
    screen: ASYNC_COLLAPSED_SCREEN,
    runtime,
    now: NOW,
    codexAsyncQuestionEvidence: ASYNC_EVIDENCE
  });
  assert.ok(offer);
  const question = offer.projection.questions[0];
  assert.equal(question?.response_kind, "single_select");
  if (question?.response_kind !== "single_select") return;

  const result = await service.respond(
    "codex",
    control,
    {
      ...responseFor(offer, {
        question_id: question.question_id,
        response_kind: "single_select",
        selected_option_ids: [question.options[0]!.option_id]
      }),
      delivery_mode: "steer_current_turn"
    },
    {
      agentVersion: "0.155.1",
      expectedFingerprint: offer.promptFingerprint,
      expectedExpiresAt: offer.projection.expires_at,
      runtime,
      authorize: () => {
        events.push("authorize");
        return { approved: true };
      },
      beforeDispatch: () => {
        events.push("reserve");
      }
    }
  );

  assert.equal(result.responded, true);
  assert.equal(result.outcome, "submitted_or_advanced");
  assert.deepEqual(events, [
    "capture",
    "authorize",
    "capture",
    "reserve",
    "capture",
    "verify",
    "keys:S-Left",
    "sleep:121",
    "capture",
    "verify",
    "keys:1",
    "sleep:121",
    "capture",
    "verify"
  ]);
});

test("Codex async question waits for a delayed editor redraw without another open key", async () => {
  const harness = await fixture([
    ASYNC_COLLAPSED_SCREEN,
    ASYNC_COLLAPSED_SCREEN,
    ASYNC_COLLAPSED_SCREEN,
    ASYNC_COLLAPSED_SCREEN,
    ASYNC_EXPANDED_SCREEN,
    ASYNC_COMPLETED_SCREEN
  ], ASYNC_EVIDENCE);
  const result = await answerAsyncFixture(
    harness, ASYNC_COLLAPSED_SCREEN, { option: 0 }
  );

  assert.equal(result.responded, true);
  assert.deepEqual(harness.events.filter((event) => event.startsWith("keys:")), [
    "keys:S-Left", "keys:1"
  ]);
  assert.equal(harness.events.filter((event) => event === "sleep:121").length, 3);
});

test("Codex async question stops after one open key if the editor changes question", async () => {
  const changedEvidence: readonly CodexAsyncQuestionDurableEvidence[] = [{
    ...ASYNC_EVIDENCE[0]!,
    questions: [{ title: "Which other target?", options: ["Local", "Remote"] }]
  }];
  const changedEditor = ASYNC_EXPANDED_SCREEN.replace(
    "Which target should I use?", "Which other target?"
  );
  const harness = await fixture([
    ASYNC_COLLAPSED_SCREEN,
    ASYNC_COLLAPSED_SCREEN,
    ASYNC_COLLAPSED_SCREEN,
    changedEditor
  ], ASYNC_EVIDENCE, { evidenceAfterNavigation: changedEvidence });

  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_COLLAPSED_SCREEN, { option: 0 }),
    (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry && error.stage === "key_uncertain"
  );
  assert.deepEqual(harness.events.filter((event) => event.startsWith("keys:")), [
    "keys:S-Left"
  ]);
  assert.equal(harness.events.filter((event) => event === "sleep:121").length, 1);
});

test("Codex async question stops after bounded read-only captures if opening never renders", async () => {
  const harness = await fixture(
    Array.from({ length: 6 }, () => ASYNC_COLLAPSED_SCREEN),
    ASYNC_EVIDENCE
  );

  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_COLLAPSED_SCREEN, { option: 0 }),
    (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry && error.stage === "key_uncertain"
  );
  assert.deepEqual(harness.events.filter((event) => event.startsWith("keys:")), [
    "keys:S-Left"
  ]);
  assert.equal(harness.events.filter((event) => event === "sleep:121").length, 3);
});

test("collapsed Codex async countdown redraws 15 to 14 to 13 preserve dispatch", async () => {
  const countdownScreens = [15, 14, 13].map((seconds) =>
    ASYNC_COLLAPSED_SCREEN.replace("? 1 question", `? 1 question · ${seconds}s`)
  );
  const harness = await fixture([
    ...countdownScreens, ASYNC_EXPANDED_SCREEN, ASYNC_COMPLETED_SCREEN
  ], ASYNC_EVIDENCE);
  const result = await answerAsyncFixture(
    harness, countdownScreens[0]!, { option: 0 }
  );
  assert.equal(result.responded, true);
  assert.equal(result.outcome, "submitted_or_advanced");
  assert.equal(harness.events.filter((event) => event === "reserve").length, 1);
  assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), [
    "keys:S-Left", "keys:1"
  ]);
});

for (const change of ["pending count", "question", "binding"] as const) {
  for (const changedCapture of [2, 3]) {
    test(`collapsed Codex async ${change} change at capture ${changedCapture} is zero-input`, async () => {
      const changedEvidence: readonly CodexAsyncQuestionDurableEvidence[] =
        change === "pending count"
          ? [{
              ...ASYNC_EVIDENCE[0]!,
              remainingCount: 2,
              questions: [
                ...ASYNC_EVIDENCE[0]!.questions,
                { title: "Add a short note." }
              ]
            }]
          : change === "question"
            ? [{
                ...ASYNC_EVIDENCE[0]!,
                questions: [{
                  title: "Which environment should I use?",
                  options: ["Local", "Remote"]
                }]
              }]
            : ASYNC_EVIDENCE;
      const changedScreen = change === "pending count"
        ? ASYNC_COLLAPSED_SCREEN.replace("? 1 question", "? 2 questions")
        : change === "binding"
          ? ASYNC_COLLAPSED_SCREEN.replace("shift + ←", "⌥ + ↑")
          : ASYNC_COLLAPSED_SCREEN;
      const harness = await fixture(
        Array.from({ length: 3 }, (_, index) =>
          index + 1 >= changedCapture ? changedScreen : ASYNC_COLLAPSED_SCREEN
        ),
        ASYNC_EVIDENCE,
        { evidenceByCapture: Array.from({ length: 3 }, (_, index) =>
            index + 1 >= changedCapture ? changedEvidence : ASYNC_EVIDENCE
          ) }
      );
      const response = answerAsyncFixture(
        harness, ASYNC_COLLAPSED_SCREEN, { option: 0 }
      );
      if (changedCapture === 3) {
        await assert.rejects(response, (error: unknown) =>
          error instanceof TerminalInteractionInputNotStartedError &&
          error.requiresFreshOffer
        );
      } else {
        const result = await response;
        assert.equal(result.responded, false);
        assert.equal(result.blocked, true);
      }
      assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), []);
    });
  }
}

test("Codex async single-select advances to a standalone free-text second question at 1 of 1", async () => {
  const evidence: readonly CodexAsyncQuestionDurableEvidence[] = [{
    ...ASYNC_EVIDENCE[0]!,
    remainingCount: 2,
    questions: [
      ...ASYNC_EVIDENCE[0]!.questions,
      { title: "Add a short note." }
    ]
  }];
  const collapsed = ASYNC_COLLAPSED_SCREEN.replace("? 1 question", "? 2 questions");
  const firstExpanded = ASYNC_EXPANDED_SCREEN.replace(
    "  Which target", "  1 of 2\n\n  Which target"
  );
  const secondExpanded = [
    "• Queued follow-up inputs",
    "",
    "  1 of 1",
    "",
    "  Add a short note.",
    "",
    "  Type your answer",
    "",
    "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt"
  ].join("\n");
  const harness = await fixture([
    collapsed, collapsed, collapsed, firstExpanded, secondExpanded,
    secondExpanded, secondExpanded, secondExpanded,
    secondExpanded.replace("Type your answer", "AKK_ASYNC_LIVE_TEXT_OK"),
    ASYNC_COMPLETED_SCREEN
  ], evidence);
  const first = await answerAsyncFixture(
    harness, collapsed, { option: 0 }, "steer_current_turn", evidence
  );
  const second = await answerAsyncFixture(
    harness, secondExpanded, { text: "AKK_ASYNC_LIVE_TEXT_OK" },
    "steer_current_turn", evidence
  );
  assert.equal(first.outcome, "submitted_or_advanced");
  assert.equal(second.outcome, "submitted_or_advanced");
  assert.equal(second.responseKind, "free_text");
  assert.notEqual(first.interactionId, second.interactionId);
  assert.notEqual(first.questionId, second.questionId);
  assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), [
    "keys:S-Left", "keys:1", "text:AKK_ASYNC_LIVE_TEXT_OK", "keys:C-m"
  ]);
});

test("Codex async Other opens a separately authorized text step without submitting", async () => {
  const harness = await fixture([
    ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN,
    ASYNC_OTHER_SCREEN
  ], ASYNC_EVIDENCE);
  const result = await answerAsyncFixture(harness, ASYNC_EXPANDED_SCREEN, { option: 2 });
  assert.equal(result.outcome, "custom_text_opened");
  assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), [
    "keys:3"
  ]);
});

test("queued Codex async suggestion uses Other, verifies injected label, then Tab once", async () => {
  const harness = await fixture([
    ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN,
    ASYNC_OTHER_SCREEN,
    ASYNC_OTHER_SCREEN.replace("› 3. Other", "› 3. Local"),
    ASYNC_COMPLETED_SCREEN
  ], ASYNC_EVIDENCE);
  const result = await answerAsyncFixture(
    harness, ASYNC_EXPANDED_SCREEN, { option: 0 }, "queue_next_turn"
  );
  assert.equal(result.outcome, "submitted_or_advanced");
  assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), [
    "keys:3", "text:Local", "keys:Tab"
  ]);
});

for (const [deliveryMode, submitKey] of [
  ["steer_current_turn", "C-m"], ["queue_next_turn", "Tab"]
] as const) {
  test(`Codex async free text verifies owned editor before ${submitKey}`, async () => {
    const harness = await fixture([
      ASYNC_OTHER_SCREEN, ASYNC_OTHER_SCREEN, ASYNC_OTHER_SCREEN,
      ASYNC_OTHER_SCREEN.replace("› 3. Other", "› 3. Development"),
      ASYNC_COMPLETED_SCREEN
    ], ASYNC_EVIDENCE);
    const result = await answerAsyncFixture(
      harness, ASYNC_OTHER_SCREEN, { text: "Development" }, deliveryMode
    );
    assert.equal(result.outcome, "submitted_or_advanced");
    assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), [
      "text:Development", `keys:${submitKey}`
    ]);
  });
}

test("Codex async text uncertainty never sends Enter or retries the text", async () => {
  const harness = await fixture([ASYNC_OTHER_SCREEN], ASYNC_EVIDENCE);
  harness.provider.failText = true;
  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_OTHER_SCREEN, { text: "Development" }),
    (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry && error.stage === "text_uncertain"
  );
  assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), [
    "text:Development"
  ]);
});

test("Codex async multiline answer is rejected before any input", async () => {
  const harness = await fixture([ASYNC_OTHER_SCREEN], ASYNC_EVIDENCE);
  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_OTHER_SCREEN, { text: "Development\nProduction" }),
    /must be a single line without terminal control characters/u
  );
  assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), []);
});

for (const text of [" Development", "Development ", "Development\tserver"]) {
  test(`Codex async unprovable whitespace answer ${JSON.stringify(text)} is zero-input`, async () => {
    const harness = await fixture([ASYNC_OTHER_SCREEN], ASYNC_EVIDENCE);
    await assert.rejects(
      answerAsyncFixture(harness, ASYNC_OTHER_SCREEN, { text }),
      /verifiable rendered line|single line without terminal control characters/u
    );
    assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), []);
  });
}

test("Codex async queued suggestion rejects an unprovable label before opening Other", async () => {
  const evidence: readonly CodexAsyncQuestionDurableEvidence[] = [{
    ...ASYNC_EVIDENCE[0]!,
    questions: [{ title: "Which target should I use?", options: ["Local\tserver", "Remote"] }]
  }];
  const harness = await fixture([ASYNC_COLLAPSED_SCREEN], evidence);
  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_COLLAPSED_SCREEN, { option: 0 }, "queue_next_turn", evidence),
    /verifiable rendered line/u
  );
  assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), []);
});

for (const option of [0, 2]) {
  test(`Codex async Other transition for option ${option} rejects another source with the same prompt`, async () => {
    const harness = await fixture([
      ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN,
      ASYNC_OTHER_SCREEN
    ], ASYNC_EVIDENCE, {
      evidenceAfterNavigation: [{ ...ASYNC_EVIDENCE[0]!, itemId: "call_replacement" }]
    });
    await assert.rejects(
      answerAsyncFixture(harness, ASYNC_EXPANDED_SCREEN, { option }, "queue_next_turn"),
      (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
        error.doNotRetry
    );
    assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), ["keys:3"]);
  });
}

test("Codex async injected text falling into the main composer cannot be submitted", async () => {
  const harness = await fixture([
    ASYNC_OTHER_SCREEN, ASYNC_OTHER_SCREEN, ASYNC_OTHER_SCREEN,
    ASYNC_COMPLETED_SCREEN.replace("Implement the current task", "Development")
  ], ASYNC_EVIDENCE);
  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_OTHER_SCREEN, { text: "Development" }),
    (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry && error.stage === "text_uncertain"
  );
  assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), [
    "text:Development"
  ]);
});

test("queued Codex async suggestion stops after Other if the exact editor is missing", async () => {
  const harness = await fixture([
    ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN,
    ASYNC_COMPLETED_SCREEN
  ], ASYNC_EVIDENCE);
  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_EXPANDED_SCREEN, { option: 0 }, "queue_next_turn"),
    (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry
  );
  assert.deepEqual(harness.events.filter((event) => /^(keys|text):/u.test(event)), [
    "keys:3"
  ]);
});

test("Codex async native opening input uncertainty is reserved and never retried", async () => {
  const harness = await fixture([ASYNC_COLLAPSED_SCREEN], ASYNC_EVIDENCE);
  harness.provider.failKeys = true;
  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_COLLAPSED_SCREEN, { option: 0 }),
    (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry && error.stage === "key_uncertain"
  );
  assert.deepEqual(harness.events.filter((event) => event.startsWith("keys:")), [
    "keys:S-Left"
  ]);
});

test("Codex async response checks identity again after native submission", async () => {
  const harness = await fixture([
    ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN,
    ASYNC_COMPLETED_SCREEN
  ], ASYNC_EVIDENCE, { failVerifyAt: 2 });
  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_EXPANDED_SCREEN, { option: 0 }),
    (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry
  );
  assert.deepEqual(harness.events.filter((event) => event.startsWith("keys:")), [
    "keys:1"
  ]);
});

test("Codex async response rejects a post-input pane drift without another write", async () => {
  const harness = await fixture([
    ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN, ASYNC_EXPANDED_SCREEN,
    ASYNC_COMPLETED_SCREEN
  ], ASYNC_EVIDENCE, { driftCaptureAt: 4 });
  await assert.rejects(
    answerAsyncFixture(harness, ASYNC_EXPANDED_SCREEN, { option: 0 }),
    (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry
  );
  assert.deepEqual(harness.events.filter((event) => event.startsWith("keys:")), [
    "keys:1"
  ]);
});

test("executable Codex async questions require the exact native task id", async () => {
  const runtime = {
    ...RUNTIME,
    agentVersion: "0.155.1",
    nativeTaskId: undefined
  };
  const offer = captureTerminalInteractionRuntimeOffer({
    agent: "codex",
    terminalControl: (await fixture([], ASYNC_EVIDENCE)).control,
    screen: ASYNC_COLLAPSED_SCREEN,
    runtime,
    now: NOW,
    codexAsyncQuestionEvidence: ASYNC_EVIDENCE
  });
  assert.equal(offer, undefined);
});

test("async authority absence does not suppress a blocking Codex questionnaire", async () => {
  const offer = captureTerminalInteractionRuntimeOffer({
    agent: "codex",
    terminalControl: (await fixture([])).control,
    screen: OPTIONS_SCREEN,
    runtime: { ...RUNTIME, agentVersion: "0.155.1", nativeTaskId: undefined },
    now: NOW,
    codexAsyncQuestionEvidence: []
  });
  assert.ok(offer);
  assert.equal(offer.projection.kind, "questionnaire");
  assert.equal(offer.projection.capabilities.respond, true);
});

test("notify-only exact Watch cannot observe another native task's async question", async () => {
  const runtime = {
    ...RUNTIME,
    agentVersion: "0.155.1",
    interactionResponseAuthority: "notify_only" as const,
    nativeTaskId: "native_turn_other"
  };
  const offer = captureTerminalInteractionRuntimeOffer({
    agent: "codex",
    terminalControl: (await fixture([], ASYNC_EVIDENCE)).control,
    screen: ASYNC_COLLAPSED_SCREEN,
    runtime,
    now: NOW,
    codexAsyncQuestionEvidence: ASYNC_EVIDENCE
  });
  assert.equal(offer, undefined);
});

test("taskless activity Watch may notify but never answer an async question", async () => {
  const runtime = {
    ...RUNTIME,
    agentVersion: "0.155.1",
    interactionResponseAuthority: "notify_only" as const,
    nativeTaskId: undefined
  };
  const offer = captureTerminalInteractionRuntimeOffer({
    agent: "codex",
    terminalControl: (await fixture([], ASYNC_EVIDENCE)).control,
    screen: ASYNC_COLLAPSED_SCREEN,
    runtime,
    now: NOW,
    codexAsyncQuestionEvidence: ASYNC_EVIDENCE
  });
  assert.ok(offer);
  assert.equal(offer.projection.kind, "async_question");
  assert.equal(offer.projection.response_authority, "notify_only");
  assert.equal(offer.projection.capabilities.respond, false);
});

function offerFor(screen: string, control: TerminalControlRef) {
  const offer = captureTerminalInteractionRuntimeOffer({
    agent: "codex",
    terminalControl: control,
    screen,
    runtime: RUNTIME,
    now: NOW
  });
  assert.ok(offer);
  return offer;
}

function responseFor(
  offer: NonNullable<ReturnType<typeof captureTerminalInteractionRuntimeOffer>>,
  answer: TerminalInteractionResponseInput["answers"][number]
): TerminalInteractionResponseInput {
  return {
    interaction_id: offer.projection.interaction_id,
    ...(offer.projection.version === 2
      ? { subject: offer.projection.subject }
      : { turn_id: offer.projection.turn_id }),
    answers: [answer]
  };
}

test("semantic choice preserves capture, authorization, reservation, and one-dispatch order", async () => {
  const { events, service, control } = await fixture([OPTIONS_SCREEN]);
  const offer = offerFor(OPTIONS_SCREEN, control);
  const question = offer.projection.questions[0];
  assert.equal(question?.response_kind, "single_select");
  if (question?.response_kind !== "single_select") return;

  const result = await service.respond(
    "codex",
    control,
    responseFor(offer, {
      question_id: question.question_id,
      response_kind: "single_select",
      selected_option_ids: [question.options[0]!.option_id]
    }),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: offer.promptFingerprint,
      expectedExpiresAt: offer.projection.expires_at,
      runtime: RUNTIME,
      authorize: () => {
        events.push("authorize");
        return { approved: true };
      },
      beforeDispatch: () => {
        events.push("reserve");
      }
    }
  );

  assert.deepEqual(result, {
    responded: true,
    blocked: false,
    interactionId: offer.projection.interaction_id,
    questionId: question.question_id,
    responseKind: "single_select",
    outcome: "submitted_or_advanced"
  });
  assert.deepEqual(events, [
    "capture",
    "authorize",
    "capture",
    "reserve",
    "capture",
    "verify",
    "keys:1"
  ]);
});

test("Codex free text is one text write, paste settle, identity proof, then one Enter", async () => {
  const { events, service, control } = await fixture([FREE_TEXT_SCREEN]);
  const offer = offerFor(FREE_TEXT_SCREEN, control);
  const question = offer.projection.questions[0];
  assert.equal(question?.response_kind, "free_text");
  if (question?.response_kind !== "free_text") return;

  const result = await service.respond(
    "codex",
    control,
    responseFor(offer, {
      question_id: question.question_id,
      response_kind: "free_text",
      text: "typed answer"
    }),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: offer.promptFingerprint,
      expectedExpiresAt: offer.projection.expires_at,
      runtime: RUNTIME,
      authorize: () => {
        events.push("authorize");
        return { approved: true };
      },
      beforeDispatch: () => {
        events.push("reserve");
      }
    }
  );

  assert.equal(result.outcome, "submitted_or_advanced");
  assert.deepEqual(events, [
    "capture",
    "authorize",
    "capture",
    "reserve",
    "capture",
    "verify",
    "text:typed answer",
    "sleep:121",
    "verify",
    "keys:C-m"
  ]);
});

test("post-reservation drift proves zero input while a possible text write stays uncertain", async () => {
  const drift = await fixture([OPTIONS_SCREEN, OPTIONS_SCREEN, CHANGED_SCREEN]);
  const choiceOffer = offerFor(OPTIONS_SCREEN, drift.control);
  const choice = choiceOffer.projection.questions[0];
  assert.equal(choice?.response_kind, "single_select");
  if (choice?.response_kind !== "single_select") return;

  await assert.rejects(
    drift.service.respond(
      "codex",
      drift.control,
      responseFor(choiceOffer, {
        question_id: choice.question_id,
        response_kind: "single_select",
        selected_option_ids: [choice.options[0]!.option_id]
      }),
      {
        agentVersion: "0.153.4",
        expectedFingerprint: choiceOffer.promptFingerprint,
        expectedExpiresAt: choiceOffer.projection.expires_at,
        runtime: RUNTIME,
        beforeDispatch: () => {
          drift.events.push("reserve");
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionInputNotStartedError);
      assert.equal(
        error.message,
        "native questionnaire changed after dispatch reservation"
      );
      return true;
    }
  );
  assert.deepEqual(drift.events, [
    "capture",
    "capture",
    "reserve",
    "capture"
  ]);

  const uncertain = await fixture([FREE_TEXT_SCREEN]);
  uncertain.provider.failText = true;
  const textOffer = offerFor(FREE_TEXT_SCREEN, uncertain.control);
  const textQuestion = textOffer.projection.questions[0];
  assert.equal(textQuestion?.response_kind, "free_text");
  if (textQuestion?.response_kind !== "free_text") return;

  await assert.rejects(
    uncertain.service.respond(
      "codex",
      uncertain.control,
      responseFor(textOffer, {
        question_id: textQuestion.question_id,
        response_kind: "free_text",
        text: "possibly delivered"
      }),
      {
        agentVersion: "0.153.4",
        expectedFingerprint: textOffer.promptFingerprint,
        expectedExpiresAt: textOffer.projection.expires_at,
        runtime: RUNTIME,
        beforeDispatch: () => {
          uncertain.events.push("reserve");
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionDispatchReservedError);
      assert.equal(error.stage, "text_uncertain");
      assert.equal(
        error.message,
        "terminal interaction text dispatch is uncertain: text result unknown"
      );
      return true;
    }
  );
  assert.equal(uncertain.events.includes("keys:C-m"), false);
});
