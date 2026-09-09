import test from "node:test";
import assert from "node:assert/strict";
import {
  createTerminalAgentAdapterRegistry,
  terminalControlCapabilitiesForAdapter,
  type TerminalAgentAdapter,
  type TerminalRuntimeIdentity,
  type TerminalScreenInspection
} from "../src/terminal-agent-adapter.js";
import {
  captureTerminalInteractionRuntimeOffer,
  TerminalAgentBridge,
  TerminalInteractionDispatchReservedError,
  TerminalInteractionInputNotStartedError,
  type TerminalIdentityVerifier
} from "../src/terminal-agent-bridge.js";
import { TerminalInteractionValidationError } from
  "../src/terminal-interaction-protocol.js";
import {
  StaticTerminalControlProvider,
  terminalRefFromPane,
  type TerminalPane
} from "../src/terminal-control-provider.js";
import type {
  TerminalControlRef,
  TerminalEndpointRef
} from "../src/terminal-control-ref.js";

const NOW = new Date("2026-09-07T04:00:00.000Z");
const EXPECTED_EXPIRY = "2026-09-07T04:10:00.000Z";
const PANE: TerminalPane = {
  kind: "tmux",
  target: "questionnaire:0.0",
  socketPath: "/tmp/client.sock",
  serverSocketPath: "/tmp/server.sock",
  paneId: "%77",
  session: "questionnaire",
  window: 0,
  pane: 0,
  panePid: 700,
  currentCommand: "codex",
  currentPath: "/repo"
};
const RUNTIME: TerminalRuntimeIdentity = {
  pid: 701,
  agentVersion: "0.153.4",
  turnId: "turn_123",
  messageId: "message_123",
  conversationId: "conversation_123",
  terminalTarget: PANE.target
};

const CODEX_OPTIONS = `
  Question 1/1 (1 unanswered)
  Choose an option.

  › 1. Option 1  First choice.
    2. Option 2  Second choice.
    3. Option 3  Third choice.

  tab to add notes | enter to submit answer | esc to interrupt
`;

const CODEX_FINAL_OPTIONS_WRAPPED = `
  Question 3/3 (1 unanswered)
  Enable test notifications?

  › 1. Enable  Enable notifications for this test.
    2. Disable  Disable notifications for this test.
    3. None of the above  Optionally, add details in notes (tab).

  tab to add notes | enter to submit all
  ←/→ to navigate questions | esc to interrupt
`;

const CODEX_FREEFORM = `
  Question 1/1 (1 unanswered)
  Share details.

  › Type your answer (optional)

  enter to submit answer | esc to interrupt
`;

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

const CODEX_NATIVE_OTHER_TEXT_EDIT = `
  Question 2/2 (1 unanswered)
  In one sentence: what makes a great developer experience?

    1. Clear defaults (Recommended)  Use the default configuration.
  › 2. None of the above  Optionally, add details in notes (tab).

  › Add notes

  tab or esc to clear notes | enter to submit all
`;

const CODEX_CONFIRM = `
  Submit with unanswered questions?
  2 unanswered questions

  › 1. Proceed  Submit with 2 unanswered questions.
    2. Go back  Return to the first unanswered question.

  Press enter to confirm or esc to go back
`;

const CLAUDE_FINAL_CONFIRM = `
←  ☒ Color  ☒ Features  ✔ Submit  →

Review your answers

 ● Which color should the sample use?
   → Red
 ● Which features should be enabled?
   → Fast

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

const CLAUDE_SINGLE_SELECT = `
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

function testAdapter(
  agent: "codex" | "claude" = "codex"
): TerminalAgentAdapter<"test_questionnaire"> {
  return {
    agent,
    displayName: `Test ${agent}`,
    capabilities: {
      processDiscovery: true,
      screenStatus: true,
      terminalApproval: false,
      screenCompletion: false,
      durableCompletion: false,
      cancellation: false
    },
    cancelKeys: [],
    classifyProcess(snapshot) {
      return {
        ...snapshot,
        agent,
        kind: "test_questionnaire",
        confidence: "high",
        reason: "test"
      };
    },
    inspectScreen({ screen }) {
      return inspection(screen);
    }
  };
}

type Operation =
  | { kind: "capture" }
  | { kind: "text"; text: string }
  | { kind: "keys"; keys: string[] };

class InteractionProvider extends StaticTerminalControlProvider {
  readonly operations: Operation[] = [];
  private captureIndex = 0;
  failText = false;
  failKeys = false;

  constructor(private interactionScreens: string[]) {
    super({ panes: [PANE] });
  }

  setScreens(screens: string[]): void {
    this.interactionScreens = screens;
    this.captureIndex = 0;
  }

  clearOperations(): void {
    this.operations.length = 0;
    this.captureIndex = 0;
  }

  override async capture(
    _terminal: TerminalEndpointRef,
    _options: { scrollbackLines?: number; preserveEscapes?: boolean } = {}
  ): Promise<string> {
    this.operations.push({ kind: "capture" });
    const screen = this.interactionScreens[
      Math.min(this.captureIndex, this.interactionScreens.length - 1)
    ] ?? "";
    this.captureIndex += 1;
    return screen;
  }

  override async sendText(
    _terminal: TerminalEndpointRef,
    text: string
  ): Promise<void> {
    this.operations.push({ kind: "text", text });
    if (this.failText) {
      throw new Error("text result unknown");
    }
  }

  override async sendKeys(
    _terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    this.operations.push({ kind: "keys", keys: [...keys] });
    if (this.failKeys) {
      throw new Error("key result unknown");
    }
  }
}

async function fixture(
  screen = CODEX_OPTIONS,
  options: {
    verifyIdentity?: TerminalIdentityVerifier;
    agent?: "codex" | "claude";
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => Date;
  } = {}
): Promise<{
  adapter: TerminalAgentAdapter;
  provider: InteractionProvider;
  bridge: TerminalAgentBridge;
  control: TerminalControlRef;
}> {
  const adapter = testAdapter(options.agent);
  const provider = new InteractionProvider([screen]);
  const endpoint = (await provider.listTerminals())[0];
  assert.ok(endpoint);
  const control = provider.toControlRef(
    endpoint,
    terminalControlCapabilitiesForAdapter(adapter)
  );
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    verifyIdentity: options.verifyIdentity,
    sleep: options.sleep,
    now: options.now ?? (() => new Date(NOW))
  });
  return { adapter, provider, bridge, control };
}

async function offerFor(screen = CODEX_OPTIONS) {
  const result = await fixture(screen);
  const status = await result.bridge.status("codex", result.control, {
    runtime: RUNTIME
  });
  assert.ok(status.interaction_state);
  assert.ok(status.interaction_prompt_fingerprint);
  result.provider.clearOperations();
  return {
    ...result,
    projection: status.interaction_state,
    fingerprint: status.interaction_prompt_fingerprint
  };
}

function selectResponse(
  projection: NonNullable<Awaited<ReturnType<typeof offerFor>>["projection"]>,
  optionIndex = 0
) {
  const question = projection.questions[0];
  assert.equal(question?.response_kind, "single_select");
  if (question?.response_kind !== "single_select") {
    throw new Error("test expected a single-select question");
  }
  return {
    interaction_id: projection.interaction_id,
    turn_id: projection.turn_id,
    answers: [{
      question_id: question.question_id,
      response_kind: "single_select" as const,
      selected_option_ids: [question.options[optionIndex]!.option_id] as [string]
    }]
  };
}

test("status and monitor project only safe semantics with a stable exact offer", async () => {
  const { bridge, control } = await fixture();
  const first = await bridge.status("codex", control, { runtime: RUNTIME });
  const second = await bridge.status("codex", control, { runtime: RUNTIME });

  assert.ok(first.interaction_state);
  assert.equal(first.interaction_state?.state, "pending");
  assert.equal(first.interaction_state?.expires_at, EXPECTED_EXPIRY);
  assert.equal(first.interaction_state?.interaction_id,
    second.interaction_state?.interaction_id);
  assert.equal(first.interaction_prompt_fingerprint,
    second.interaction_prompt_fingerprint);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /exact_region|action_plan|"key"/u);
  assert.match(first.interaction_prompt_fingerprint ?? "", /^[0-9a-f]{64}$/u);

  const poll = await bridge.monitorPoll({
    agent: "codex",
    terminalControl: control,
    screenOptions: { runtime: RUNTIME }
  });
  assert.equal(
    poll.status.interaction_state?.interaction_id,
    first.interaction_state?.interaction_id
  );
});

test("managed and Watch runtimes share one native surface identity", async () => {
  for (const scenario of [
    {
      agent: "codex" as const,
      version: "0.153.4",
      screen: CODEX_OPTIONS,
      nativeSessionId: "018f0000-0000-7000-8000-000000000001",
      nativeProcessUuid: "codex-process-1",
      nativeProcessBirth: "codex-birth-1",
      nativeRollout: {
        fd: "12",
        device: "16777234",
        inode: "4242",
        path: "/tmp/rollout-1.jsonl"
      }
    },
    {
      agent: "claude" as const,
      version: "2.1.267",
      screen: CLAUDE_SINGLE_SELECT,
      nativeSessionId: "claude-session-1",
      nativeProcessUuid: "claude-process-1",
      nativeProcessBirth: "claude-birth-1",
      nativeRollout: undefined
    }
  ]) {
    const { control } = await fixture(scenario.screen, {
      agent: scenario.agent
    });
    const native = {
      pid: 701,
      agentVersion: scenario.version,
      nativeSessionId: scenario.nativeSessionId,
      nativeProcessUuid: scenario.nativeProcessUuid,
      nativeProcessBirth: scenario.nativeProcessBirth,
      ...(scenario.nativeRollout
        ? { nativeRollout: scenario.nativeRollout }
        : {}),
      terminalTarget: PANE.target
    };
    const managed = captureTerminalInteractionRuntimeOffer({
      agent: scenario.agent,
      terminalControl: control,
      screen: scenario.screen,
      runtime: {
        ...native,
        turnId: "turn_surface_1",
        messageId: "message_surface_1"
      },
      now: NOW
    });
    const watch = captureTerminalInteractionRuntimeOffer({
      agent: scenario.agent,
      terminalControl: control,
      screen: scenario.screen,
      runtime: {
        ...native,
        // Exact Watch discovery has this extra live identity fence while the
        // durable managed-Turn takeover currently does not.
        nativeProcessStartedAt: 1_788_888_888_000,
        interactionSubject: {
          kind: "terminal_watch",
          watch_id: "terminal-watch-surface-1",
          anchor_fingerprint: "a".repeat(64)
        },
        interactionResponseAuthority: "executable"
      },
      now: NOW
    });

    assert.ok(managed, `${scenario.agent} managed offer`);
    assert.ok(watch, `${scenario.agent} Watch offer`);
    assert.equal(managed.surfaceId, watch.surfaceId, scenario.agent);
    assert.equal(managed.promptFingerprint, watch.promptFingerprint);
    assert.notEqual(
      managed.projection.interaction_id,
      watch.projection.interaction_id
    );
  }
});

test("status requires agent version, safe Turn id, and canonical process identity", async () => {
  const { bridge, control } = await fixture();
  const missingVersion = await bridge.status("codex", control, {
    runtime: { ...RUNTIME, agentVersion: undefined }
  });
  const unsafeTurn = await bridge.status("codex", control, {
    runtime: { ...RUNTIME, turnId: "bad turn" }
  });
  const rawTerminalOnly = await bridge.status("codex", control, {
    runtime: { ...RUNTIME, turnId: undefined }
  });
  assert.equal(missingVersion.interaction_state, undefined);
  assert.equal(unsafeTurn.interaction_state, undefined);
  assert.equal(rawTerminalOnly.interaction_state, undefined);

  const adapter = testAdapter();
  const legacyPane = {
    ...PANE,
    serverSocketPath: undefined,
    paneId: undefined,
    panePid: 0
  };
  const provider = new StaticTerminalControlProvider({
    panes: [legacyPane],
    screens: { [PANE.target]: CODEX_OPTIONS }
  });
  const legacyBridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    now: () => new Date(NOW)
  });
  const legacyControl = terminalRefFromPane(
    legacyPane,
    terminalControlCapabilitiesForAdapter(adapter)
  );
  const legacy = await legacyBridge.status("codex", legacyControl, {
    runtime: RUNTIME
  });
  assert.equal(legacy.interaction_state, undefined);
});

test("status makes a reserved or uncertain interaction dispatch non-retryable", async () => {
  const { bridge, control } = await fixture();
  for (const interactionDispatchState of ["reserved", "uncertain"] as const) {
    const status = await bridge.status("codex", control, {
      runtime: { ...RUNTIME, interactionDispatchState }
    });
    assert.equal(status.interaction_state?.state, "response_uncertain");
    assert.equal(status.interaction_state?.capabilities.respond, false);
  }
});

test("respondInteraction recaptures around hooks and dispatches one semantic key", async () => {
  const { bridge, provider, control, projection, fingerprint } = await offerFor();
  const timeline: string[] = [];
  const response = selectResponse(projection, 1);
  const result = await bridge.respondInteraction("codex", control, response, {
    agentVersion: "0.153.4",
    expectedFingerprint: fingerprint,
    expectedExpiresAt: projection.expires_at,
    runtime: RUNTIME,
    authorize(context) {
      timeline.push("authorize");
      assert.equal(context.fingerprint, fingerprint);
      assert.equal(context.projection.interaction_id, response.interaction_id);
      return { approved: true };
    },
    beforeDispatch(context) {
      timeline.push("reserve");
      assert.equal(context.terminalControl.target, control.target);
      assert.equal(context.projection.interaction_id, response.interaction_id);
    }
  });

  assert.deepEqual(result, {
    responded: true,
    blocked: false,
    interactionId: response.interaction_id,
    questionId: response.answers[0].question_id,
    responseKind: "single_select",
    outcome: "submitted_or_advanced"
  });
  assert.deepEqual(timeline, ["authorize", "reserve"]);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "capture").length,
    3
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    [{ kind: "keys", keys: ["2"] }]
  );
  assert.doesNotMatch(JSON.stringify(result), /keys?|fingerprint/u);
});

test("wrapped Codex final option footer projects and dispatches one semantic key", async () => {
  const { provider, control, bridge, projection, fingerprint } =
    await offerFor(CODEX_FINAL_OPTIONS_WRAPPED);
  assert.deepEqual(projection.step, { index: 3, total: 3 });
  assert.equal(projection.state, "pending");
  assert.equal(projection.capabilities.respond, true);

  const result = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(projection),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME
    }
  );

  assert.equal(result.responded, true);
  assert.equal(result.outcome, "submitted_or_advanced");
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [{ kind: "keys", keys: ["1"] }]
  );
});

test("Codex custom choice opens notes before a separate free-text response", async () => {
  const { bridge, provider, control } = await fixture(CODEX_CUSTOM_OPTIONS);
  const choiceStatus = await bridge.status("codex", control, { runtime: RUNTIME });
  const choiceProjection = choiceStatus.interaction_state;
  const choiceFingerprint = choiceStatus.interaction_prompt_fingerprint;
  assert.ok(choiceProjection);
  assert.ok(choiceFingerprint);
  assert.equal(choiceProjection.questions[0]?.response_kind, "single_select");
  provider.clearOperations();

  const opened = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(choiceProjection, 1),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: choiceFingerprint,
      expectedExpiresAt: choiceProjection.expires_at,
      runtime: RUNTIME
    }
  );
  assert.equal(opened.responded, true);
  assert.equal(opened.outcome, "custom_text_opened");
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [{ kind: "keys", keys: ["Down", "Down", "C-m"] }]
  );

  provider.setScreens([CODEX_CUSTOM_TEXT_EDIT]);
  provider.operations.length = 0;
  const textStatus = await bridge.status("codex", control, { runtime: RUNTIME });
  const textProjection = textStatus.interaction_state;
  const textFingerprint = textStatus.interaction_prompt_fingerprint;
  assert.ok(textProjection);
  assert.ok(textFingerprint);
  assert.notEqual(textProjection.interaction_id, choiceProjection.interaction_id);
  assert.equal(textProjection.questions[0]?.response_kind, "free_text");
  assert.equal(textProjection.capabilities.free_text, true);
  provider.clearOperations();

  const textQuestion = textProjection.questions[0]!;
  const answered = await bridge.respondInteraction("codex", control, {
    interaction_id: textProjection.interaction_id,
    turn_id: textProjection.turn_id,
    answers: [{
      question_id: textQuestion.question_id,
      response_kind: "free_text",
      text: "Fast feedback makes a great developer experience."
    }]
  }, {
    agentVersion: "0.153.4",
    expectedFingerprint: textFingerprint,
    expectedExpiresAt: textProjection.expires_at,
    runtime: RUNTIME
  });
  assert.equal(answered.responded, true);
  assert.equal(answered.outcome, "submitted_or_advanced");
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [
      {
        kind: "text",
        text: "Fast feedback makes a great developer experience."
      },
      { kind: "keys", keys: ["C-m"] }
    ]
  );
});

test("Codex derived custom choice enters native Other Notes and accepts free text", async () => {
  const { bridge, provider, control } = await fixture(CODEX_NATIVE_OTHER_OPTIONS);
  const choiceStatus = await bridge.status("codex", control, { runtime: RUNTIME });
  const choiceProjection = choiceStatus.interaction_state;
  const choiceFingerprint = choiceStatus.interaction_prompt_fingerprint;
  assert.ok(choiceProjection);
  assert.ok(choiceFingerprint);
  const choiceQuestion = choiceProjection.questions[0];
  assert.ok(choiceQuestion);
  assert.equal(choiceQuestion.response_kind, "single_select");
  assert.ok("options" in choiceQuestion);
  assert.deepEqual(
    choiceQuestion.options.map((option) => option.label),
    [
      "Clear defaults (Recommended)",
      "Type something.",
      "None of the above"
    ]
  );
  provider.clearOperations();

  const opened = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(choiceProjection, 1),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: choiceFingerprint,
      expectedExpiresAt: choiceProjection.expires_at,
      runtime: RUNTIME
    }
  );
  assert.equal(opened.responded, true);
  assert.equal(opened.outcome, "custom_text_opened");
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [{ kind: "keys", keys: ["Down", "C-m"] }]
  );

  provider.setScreens([CODEX_NATIVE_OTHER_TEXT_EDIT]);
  provider.clearOperations();
  const textStatus = await bridge.status("codex", control, { runtime: RUNTIME });
  const textProjection = textStatus.interaction_state;
  const textFingerprint = textStatus.interaction_prompt_fingerprint;
  assert.ok(textProjection);
  assert.ok(textFingerprint);
  const textQuestion = textProjection.questions[0];
  assert.ok(textQuestion);
  assert.equal(textQuestion.response_kind, "free_text");
  assert.equal(textProjection.capabilities.free_text, true);
  provider.clearOperations();

  const answered = await bridge.respondInteraction("codex", control, {
    interaction_id: textProjection.interaction_id,
    turn_id: textProjection.turn_id,
    answers: [{
      question_id: textQuestion.question_id,
      response_kind: "free_text",
      text: "Clear defaults with room for explicit overrides."
    }]
  }, {
    agentVersion: "0.153.4",
    expectedFingerprint: textFingerprint,
    expectedExpiresAt: textProjection.expires_at,
    runtime: RUNTIME
  });
  assert.equal(answered.responded, true);
  assert.equal(answered.outcome, "submitted_or_advanced");
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [
      {
        kind: "text",
        text: "Clear defaults with room for explicit overrides."
      },
      { kind: "keys", keys: ["C-m"] }
    ]
  );
});

test("Codex canonical Other remains a distinct direct literal choice", async () => {
  const { bridge, provider, control } = await fixture(CODEX_NATIVE_OTHER_OPTIONS);
  const status = await bridge.status("codex", control, { runtime: RUNTIME });
  const projection = status.interaction_state;
  const fingerprint = status.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  provider.clearOperations();

  const result = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(projection, 2),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME
    }
  );

  assert.equal(result.responded, true);
  assert.equal(result.outcome, "submitted_or_advanced");
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [{ kind: "keys", keys: ["2"] }]
  );
});

test("Codex custom navigation is one non-retryable key dispatch", async () => {
  const { bridge, provider, control } = await fixture(CODEX_CUSTOM_OPTIONS);
  const status = await bridge.status("codex", control, { runtime: RUNTIME });
  const projection = status.interaction_state;
  const fingerprint = status.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  provider.clearOperations();
  provider.failKeys = true;

  await assert.rejects(
    bridge.respondInteraction(
      "codex",
      control,
      selectResponse(projection, 1),
      {
        agentVersion: "0.153.4",
        expectedFingerprint: fingerprint,
        expectedExpiresAt: projection.expires_at,
        runtime: RUNTIME,
        beforeDispatch() {}
      }
    ),
    (error: unknown) =>
      error instanceof TerminalInteractionDispatchReservedError &&
      error.stage === "key_uncertain" &&
      error.doNotRetry
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [{ kind: "keys", keys: ["Down", "Down", "C-m"] }]
  );
});

for (const version of ["2.1.263", "2.1.266", "2.1.267"] as const) {
  test(`Claude ${version} custom choice retains its exact direct-digit transition`, async () => {
    const { bridge, provider, control } = await fixture(CLAUDE_SINGLE_SELECT, {
      agent: "claude"
    });
    const runtime = { ...RUNTIME, agentVersion: version };
    const status = await bridge.status("claude", control, { runtime });
    const projection = status.interaction_state;
    const fingerprint = status.interaction_prompt_fingerprint;
    assert.ok(projection);
    assert.ok(fingerprint);
    provider.clearOperations();

    const opened = await bridge.respondInteraction(
      "claude",
      control,
      selectResponse(projection, 2),
      {
        agentVersion: version,
        expectedFingerprint: fingerprint,
        expectedExpiresAt: projection.expires_at,
        runtime
      }
    );
    assert.equal(opened.responded, true);
    assert.equal(opened.outcome, "custom_text_opened");
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind !== "capture"),
      [{ kind: "keys", keys: ["3"] }]
    );
  });
}

test("Claude interaction offers cannot cross an exact client-version change", async () => {
  const { bridge, provider, control } = await fixture(CLAUDE_SINGLE_SELECT, {
    agent: "claude"
  });
  const originalRuntime = { ...RUNTIME, agentVersion: "2.1.266" };
  const offered = await bridge.status("claude", control, {
    runtime: originalRuntime
  });
  const projection = offered.interaction_state;
  const fingerprint = offered.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  provider.clearOperations();

  const changedRuntime = { ...RUNTIME, agentVersion: "2.1.267" };
  const result = await bridge.respondInteraction(
    "claude",
    control,
    selectResponse(projection),
    {
      agentVersion: "2.1.267",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: changedRuntime
    }
  );
  assert.equal(result.responded, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /fingerprint changed/u);
  assert.equal(provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);
});

test("a pre-expiry reservation remains valid across the exact expiry bucket boundary", async () => {
  let nowMs = Date.parse("2026-09-07T04:09:59.900Z");
  const { bridge, provider, control } = await fixture(CODEX_OPTIONS, {
    now: () => new Date(nowMs)
  });
  const status = await bridge.status("codex", control, { runtime: RUNTIME });
  const projection = status.interaction_state;
  const fingerprint = status.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  assert.equal(projection.expires_at, EXPECTED_EXPIRY);
  provider.clearOperations();

  const result = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(projection, 1),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME,
      beforeDispatch(context) {
        assert.equal(context.projection.expires_at, EXPECTED_EXPIRY);
        assert.ok(nowMs < Date.parse(context.projection.expires_at));
        nowMs = Date.parse("2026-09-07T04:10:00.001Z");
      }
    }
  );

  assert.equal(result.responded, true);
  assert.equal(result.outcome, "submitted_or_advanced");
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "capture").length,
    3
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [{ kind: "keys", keys: ["2"] }]
  );
});

test("an expired displayed offer is live-recaptured before one exact response", async () => {
  let nowMs = Date.parse("2026-09-07T04:09:59.900Z");
  const { bridge, provider, control } = await fixture(CODEX_OPTIONS, {
    now: () => new Date(nowMs)
  });
  const status = await bridge.status("codex", control, { runtime: RUNTIME });
  const projection = status.interaction_state;
  const fingerprint = status.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  provider.clearOperations();
  nowMs = Date.parse("2026-09-07T04:10:00.001Z");

  const result = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(projection),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME
    }
  );

  assert.equal(result.responded, true);
  assert.equal(result.blocked, false);
  assert.equal(result.outcome, "submitted_or_advanced");
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "capture").length,
    3
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [{ kind: "keys", keys: ["1"] }]
  );
});

test("an expired displayed offer still fails closed when the live prompt changed", async () => {
  let nowMs = Date.parse("2026-09-07T04:09:59.900Z");
  const { bridge, provider, control } = await fixture(CODEX_OPTIONS, {
    now: () => new Date(nowMs)
  });
  const status = await bridge.status("codex", control, { runtime: RUNTIME });
  const projection = status.interaction_state;
  const fingerprint = status.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  provider.setScreens([
    CODEX_OPTIONS.replace("Choose an option.", "Choose another option.")
  ]);
  provider.clearOperations();
  nowMs = Date.parse("2026-09-07T04:10:00.001Z");

  const result = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(projection),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME
    }
  );

  assert.equal(result.responded, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /fingerprint changed/u);
  assert.equal(provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);
});

test("a mismatched future expiry remains invalid without terminal input", async () => {
  const { bridge, provider, control, projection, fingerprint } = await offerFor();
  const result = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(projection),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: "2026-09-07T04:20:00.000Z",
      runtime: RUNTIME
    }
  );

  assert.equal(result.responded, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /expiry changed/u);
  assert.equal(provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);
});

test("stale fingerprint is blocked before authorization and terminal input", async () => {
  const { bridge, provider, control, projection } = await offerFor();
  let authorizeCalls = 0;
  const result = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(projection),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: "f".repeat(64),
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME,
      authorize() {
        authorizeCalls += 1;
        return { approved: true };
      }
    }
  );

  assert.equal(result.responded, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /fingerprint changed/u);
  assert.equal(authorizeCalls, 0);
  assert.equal(provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);
});

test("version drift and manual profiles send zero input", async () => {
  const { bridge, provider, control, projection, fingerprint } = await offerFor();
  const versionResult = await bridge.respondInteraction(
    "codex",
    control,
    selectResponse(projection),
    {
      agentVersion: "0.153.5",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME
    }
  );
  assert.equal(versionResult.responded, false);
  assert.match(versionResult.reason ?? "", /version/u);

  const manualStatus = await bridge.status("codex", control, {
    runtime: { ...RUNTIME, agentVersion: "0.153.5" }
  });
  assert.equal(manualStatus.interaction_state?.state, "manual_required");
  assert.equal(manualStatus.interaction_state?.capabilities.respond, false);
  assert.equal(provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);
});

test("malformed semantic answers are rejected before terminal input", async () => {
  const { bridge, provider, control, projection, fingerprint } = await offerFor();
  const malformed = selectResponse(projection);
  malformed.answers[0].selected_option_ids = ["option_unknown"];

  await assert.rejects(
    bridge.respondInteraction("codex", control, malformed, {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME
    }),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionValidationError);
      assert.equal(error.code, "unknown_option");
      return true;
    }
  );
  assert.equal(provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);
});

test("free text sends text then one Enter and returns no transport details", async () => {
  let providerForVerification: InteractionProvider | undefined;
  let verifiedAfterText = false;
  const settleDelays: number[] = [];
  const { bridge, provider, control } = await fixture(CODEX_FREEFORM, {
    async verifyIdentity(request) {
      if (providerForVerification?.operations.some((operation) =>
        operation.kind === "text")) {
        verifiedAfterText = true;
      }
      return { terminalControl: request.terminalControl };
    },
    async sleep(milliseconds) {
      settleDelays.push(milliseconds);
    }
  });
  providerForVerification = provider;
  const status = await bridge.status("codex", control, { runtime: RUNTIME });
  const projection = status.interaction_state;
  const fingerprint = status.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  provider.clearOperations();
  const question = projection.questions[0];
  assert.equal(question?.response_kind, "free_text");
  const response = {
    interaction_id: projection.interaction_id,
    turn_id: projection.turn_id,
    answers: [{
      question_id: question!.question_id,
      response_kind: "free_text" as const,
      text: "Use the isolated target"
    }]
  };
  const result = await bridge.respondInteraction("codex", control, response, {
    agentVersion: "0.153.4",
    expectedFingerprint: fingerprint,
    expectedExpiresAt: projection.expires_at,
    runtime: RUNTIME,
    beforeDispatch() {}
  });

  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [
      { kind: "text", text: "Use the isolated target" },
      { kind: "keys", keys: ["C-m"] }
    ]
  );
  assert.equal(result.responded, true);
  assert.equal(result.outcome, "submitted_or_advanced");
  assert.equal(verifiedAfterText, true);
  assert.deepEqual(settleDelays, [121]);
  assert.doesNotMatch(JSON.stringify(result), /C-m|Use the isolated/u);
});

test("Claude oversized custom text is blocked before reservation or input", async () => {
  const { bridge, provider, control } = await fixture(
    CLAUDE_CUSTOM_TEXT_EDIT,
    { agent: "claude" }
  );
  const runtime = { ...RUNTIME, agentVersion: "2.1.263" };
  const status = await bridge.status("claude", control, { runtime });
  const projection = status.interaction_state;
  const fingerprint = status.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  provider.clearOperations();
  let reserved = false;
  const result = await bridge.respondInteraction("claude", control, {
    interaction_id: projection.interaction_id,
    turn_id: projection.turn_id,
    answers: [{
      question_id: projection.questions[0]!.question_id,
      response_kind: "free_text",
      text: "x".repeat(800)
    }]
  }, {
    agentVersion: "2.1.263",
    expectedFingerprint: fingerprint,
    expectedExpiresAt: projection.expires_at,
    runtime,
    beforeDispatch() {
      reserved = true;
    }
  });

  assert.equal(result.responded, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /verified native limit of 799/u);
  assert.equal(reserved, false);
  assert.equal(provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);
});

test("free text identity drift after text is uncertain and never sends Enter", async () => {
  let providerForVerification: InteractionProvider | undefined;
  const { bridge, provider, control } = await fixture(CODEX_FREEFORM, {
    async verifyIdentity(request) {
      if (providerForVerification?.operations.some((operation) =>
        operation.kind === "text")) {
        throw new Error("post-text identity drift");
      }
      return { terminalControl: request.terminalControl };
    }
  });
  providerForVerification = provider;
  const status = await bridge.status("codex", control, { runtime: RUNTIME });
  const projection = status.interaction_state;
  const fingerprint = status.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  provider.clearOperations();
  const question = projection.questions[0]!;

  await assert.rejects(
    bridge.respondInteraction("codex", control, {
      interaction_id: projection.interaction_id,
      turn_id: projection.turn_id,
      answers: [{
        question_id: question.question_id,
        response_kind: "free_text",
        text: "one identity-bound attempt"
      }]
    }, {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME,
      beforeDispatch() {}
    }),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionDispatchReservedError);
      assert.equal(error.stage, "text_uncertain");
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "text").length,
    1
  );
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "keys").length,
    0
  );
});

test("a possibly delivered free-text write is terminally uncertain and never sends Enter", async () => {
  const { bridge, provider, control, projection, fingerprint } =
    await offerFor(CODEX_FREEFORM);
  const question = projection.questions[0]!;
  provider.failText = true;
  await assert.rejects(
    bridge.respondInteraction("codex", control, {
      interaction_id: projection.interaction_id,
      turn_id: projection.turn_id,
      answers: [{
        question_id: question.question_id,
        response_kind: "free_text",
        text: "one attempt only"
      }]
    }, {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME,
      beforeDispatch() {}
    }),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionDispatchReservedError);
      assert.equal(error.stage, "text_uncertain");
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "text").length,
    1
  );
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "keys").length,
    0
  );
});

test("post-reservation prompt drift proves terminal input never started", async () => {
  const { bridge, provider, control, projection, fingerprint } = await offerFor();
  provider.setScreens([
    CODEX_OPTIONS,
    CODEX_OPTIONS,
    CODEX_OPTIONS.replace("Choose an option.", "Choose another option.")
  ]);
  let reservations = 0;
  await assert.rejects(
    bridge.respondInteraction("codex", control, selectResponse(projection), {
      agentVersion: "0.153.4",
      expectedFingerprint: fingerprint,
      expectedExpiresAt: projection.expires_at,
      runtime: RUNTIME,
      beforeDispatch() {
        reservations += 1;
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionInputNotStartedError);
      assert.equal(error.code, "AKK_TERMINAL_INTERACTION_INPUT_NOT_STARTED");
      assert.equal(error.stage, "input_not_started");
      return true;
    }
  );
  assert.equal(reservations, 1);
  assert.equal(provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);
});

test("semantic cursor identity stays stable while final action-plan drift sends no input", async () => {
  const movedCursor = CLAUDE_SINGLE_SELECT
    .replace("❯ 1. Red", "  1. Red")
    .replace("  2. Blue", "❯ 2. Blue");
  const runtime: TerminalRuntimeIdentity = {
    ...RUNTIME,
    agentVersion: "2.1.263"
  };
  const { bridge, provider, control } = await fixture(CLAUDE_SINGLE_SELECT, {
    agent: "claude"
  });
  const initial = captureTerminalInteractionRuntimeOffer({
    agent: "claude",
    terminalControl: control,
    screen: CLAUDE_SINGLE_SELECT,
    runtime,
    now: NOW
  });
  const moved = captureTerminalInteractionRuntimeOffer({
    agent: "claude",
    terminalControl: control,
    screen: movedCursor,
    runtime,
    now: NOW
  });
  assert.ok(initial);
  assert.ok(moved);
  assert.equal(initial.promptFingerprint, moved.promptFingerprint);
  assert.equal(initial.surfaceId, moved.surfaceId);
  assert.notDeepEqual(initial.actionPlan, moved.actionPlan);

  provider.setScreens([
    CLAUDE_SINGLE_SELECT,
    CLAUDE_SINGLE_SELECT,
    movedCursor
  ]);
  provider.clearOperations();
  let reservations = 0;
  await assert.rejects(
    bridge.respondInteraction(
      "claude",
      control,
      selectResponse(initial.projection),
      {
        agentVersion: "2.1.263",
        expectedFingerprint: initial.promptFingerprint,
        expectedExpiresAt: initial.projection.expires_at,
        runtime,
        beforeDispatch() {
          reservations += 1;
        }
      }
    ),
    TerminalInteractionInputNotStartedError
  );
  assert.equal(reservations, 1);
  assert.equal(provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);
});

test("reservation hook failure and key uncertainty are both at-most-once errors", async () => {
  const reserved = await offerFor();
  await assert.rejects(
    reserved.bridge.respondInteraction(
      "codex",
      reserved.control,
      selectResponse(reserved.projection),
      {
        agentVersion: "0.153.4",
        expectedFingerprint: reserved.fingerprint,
        expectedExpiresAt: reserved.projection.expires_at,
        runtime: RUNTIME,
        beforeDispatch() {
          throw new Error("reservation write result unknown");
        }
      }
    ),
    (error: unknown) =>
      error instanceof TerminalInteractionDispatchReservedError &&
      error.stage === "reservation_uncertain" &&
      error.doNotRetry
  );
  assert.equal(reserved.provider.operations.some((operation) =>
    operation.kind === "text" || operation.kind === "keys"), false);

  const keyed = await offerFor();
  keyed.provider.failKeys = true;
  await assert.rejects(
    keyed.bridge.respondInteraction(
      "codex",
      keyed.control,
      selectResponse(keyed.projection),
      {
        agentVersion: "0.153.4",
        expectedFingerprint: keyed.fingerprint,
        expectedExpiresAt: keyed.projection.expires_at,
        runtime: RUNTIME,
        beforeDispatch() {}
      }
    ),
    (error: unknown) =>
      error instanceof TerminalInteractionDispatchReservedError &&
      error.stage === "key_uncertain" &&
      error.doNotRetry
  );
  assert.equal(
    keyed.provider.operations.filter((operation) => operation.kind === "keys").length,
    1
  );
});

test("verified confirmation dispatches exactly one closed key", async () => {
  const { bridge, provider, control, projection, fingerprint } =
    await offerFor(CODEX_CONFIRM);
  const question = projection.questions[0]!;
  const result = await bridge.respondInteraction("codex", control, {
    interaction_id: projection.interaction_id,
    turn_id: projection.turn_id,
    answers: [{
      question_id: question.question_id,
      response_kind: "confirm",
      confirm: false
    }]
  }, {
    agentVersion: "0.153.4",
    expectedFingerprint: fingerprint,
    expectedExpiresAt: projection.expires_at,
    runtime: RUNTIME,
    beforeDispatch() {}
  });

  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    [{ kind: "keys", keys: ["Escape"] }]
  );
});

test("Claude final review uses one exact semantic cancel key", async () => {
  const { bridge, provider, control } = await fixture(
    CLAUDE_FINAL_CONFIRM,
    { agent: "claude" }
  );
  const runtime = { ...RUNTIME, agentVersion: "2.1.263" };
  const status = await bridge.status("claude", control, { runtime });
  const projection = status.interaction_state;
  const fingerprint = status.interaction_prompt_fingerprint;
  assert.ok(projection);
  assert.ok(fingerprint);
  provider.clearOperations();
  const question = projection.questions[0]!;

  const result = await bridge.respondInteraction("claude", control, {
    interaction_id: projection.interaction_id,
    turn_id: projection.turn_id,
    answers: [{
      question_id: question.question_id,
      response_kind: "confirm",
      confirm: false
    }]
  }, {
    agentVersion: "2.1.263",
    expectedFingerprint: fingerprint,
    expectedExpiresAt: projection.expires_at,
    runtime,
    beforeDispatch() {}
  });

  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    [{ kind: "keys", keys: ["2"] }]
  );
});
