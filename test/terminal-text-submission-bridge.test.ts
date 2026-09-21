import test from "node:test";
import assert from "node:assert/strict";
import { codexTerminalAgentAdapter } from
  "../src/codex-terminal-agent-adapter.js";
import type { TerminalAgentAdapter } from
  "../src/terminal-agent-adapter.js";
import type { TerminalControlRef } from
  "../src/terminal-control-ref.js";
import { TerminalTextSubmissionBridge } from
  "../src/terminal-text-submission-bridge.js";
import { codexBlockingModalVisible, currentCodexComposerCapture,
  inspectCodexAsyncQuestionInputMode } from
  "../src/terminal-composer-classifier.js";
import { stripTerminalEscapeSequences } from
  "../src/terminal-native-inspection-bridge.js";
import { CODEX_ASTRA_STYLED_COMPOSER_PHASES } from
  "./support/codex-astra-styled-composer.js";

const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "codex:0.0",
  session: "codex",
  window: 0,
  pane: 0,
  panePid: 101,
  currentCommand: "codex",
  currentPath: "/repo",
  capabilities: ["screen_status", "send_keys"]
};

function idleCodexAdapter(trace: string[]): TerminalAgentAdapter {
  return {
    ...codexTerminalAgentAdapter,
    inspectScreen: ({ screen }) => {
      trace.push("inspect");
      return {
        activity: { state: "idle", reason: "exact test idle frame" },
        approval: {
          blocked: false,
          approvable: false,
          reason: "no approval"
        },
        screenExcerpt: screen
      };
    }
  };
}

function createHarness(options: {
  trace: string[];
  verify?: (
    call: number,
    control: TerminalControlRef
  ) => TerminalControlRef;
  composerDigest?: (call: number) => string;
  screens?: readonly string[];
  screenAfterText?: string;
}) {
  let clock = 0;
  let verifyCalls = 0;
  let composerCalls = 0;
  let captures = 0;
  let textDelivered = false;
  const adapter = options.screens ? codexTerminalAgentAdapter : idleCodexAdapter(options.trace);
  const bridge = new TerminalTextSubmissionBridge({
    runtime: {
      preflight: (_control, operation) => {
        options.trace.push(`preflight:${operation}`);
      },
      verifyIdentity: async (_agent, control) => {
        verifyCalls += 1;
        options.trace.push("verify");
        return options.verify?.(verifyCalls, control) ?? control;
      },
      captureInspection: async (_adapter, control) => {
        options.trace.push("capture-inspection");
        return {
          terminalControl: control,
          screen: "screen",
          inspection: adapter.inspectScreen({ screen: "screen" })
        };
      },
      captureStyled: async () => {
        options.trace.push("capture-styled");
        if (textDelivered && options.screenAfterText) return options.screenAfterText;
        if (options.screens) return options.screens[captures++ % options.screens.length]!;
        return "private draft contents";
      },
      deliverText: async (_control, text) => {
        textDelivered = true;
        options.trace.push(`text:${text}`);
      },
      dispatchEnter: async () => {
        options.trace.push("enter");
      },
      nowMs: () => clock,
      sleep: async (milliseconds) => {
        options.trace.push(`sleep:${milliseconds}`);
        clock += milliseconds;
      }
    },
    classifiers: {
      sameIdentity: (left, right) => left === right,
      stripEscapes: options.screens ? stripTerminalEscapeSequences : (screen) => screen,
      codexBlockingModalVisible: options.screens ? codexBlockingModalVisible : () => false,
      inspectCodexAsyncQuestionInputMode: options.screens ? inspectCodexAsyncQuestionInputMode : () => "absent",
      currentCodexComposer: options.screens ? currentCodexComposerCapture : () => {
        composerCalls += 1;
        return {
          state: "exact_draft",
          digest: options.composerDigest?.(composerCalls) ?? "draft-digest"
        };
      },
      exactTerminalComposer: () => ({ digest: "draft-digest" }),
      exactClaudeComposer: () => undefined,
      exactClaudeInjectedPastePlaceholder: () => undefined
    }
  });
  return { adapter, bridge };
}

test("text submission preserves hook and transport ordering", async () => {
  const trace: string[] = [];
  const { adapter, bridge } = createHarness({ trace });

  const result = await bridge.send(adapter, CONTROL, "hello", {
    beforeText: () => {
      trace.push("before-text");
    },
    beforeEnter: () => {
      trace.push("before-enter");
    },
    onTransportStage: ({ stage }) => {
      trace.push(`stage:${stage}`);
    }
  });

  assert.equal(result.stage, "enter_dispatched");
  assert.deepEqual(trace, [
    "preflight:send",
    "verify",
    "before-text",
    "verify",
    "text:hello",
    "stage:text_injected",
    "verify",
    "before-enter",
    "verify",
    "enter",
    "stage:enter_dispatched"
  ]);
});

test("composer observation fences every capture and redacts draft text", async () => {
  const trace: string[] = [];
  const { adapter, bridge } = createHarness({ trace });

  const result = await bridge.observeCodexComposer(
    adapter,
    CONTROL,
    "private draft contents"
  );

  assert.deepEqual(result, {
    state: "exact_draft",
    terminalControl: CONTROL,
    digest: "draft-digest",
    stableCaptures: 3
  });
  assert.equal(JSON.stringify(result).includes("private draft contents"), false);
  assert.deepEqual(trace, [
    "preflight:observe_composer",
    "verify", "capture-styled", "inspect", "verify",
    "sleep:30",
    "verify", "capture-styled", "inspect", "verify",
    "verify", "capture-styled", "inspect", "verify"
  ]);
});

test("composer final recapture fails closed on identity drift", async () => {
  const trace: string[] = [];
  const drifted = { ...CONTROL, panePid: 202 };
  const { adapter, bridge } = createHarness({
    trace,
    verify: (call, control) => call === 6 ? drifted : control
  });

  const result = await bridge.observeCodexComposer(
    adapter,
    CONTROL,
    "private draft contents"
  );

  assert.deepEqual(result, {
    state: "identity_drift",
    reason: "terminal control identity changed across the Codex composer capture"
  });
  assert.equal(trace.includes("enter"), false);
  assert.equal(trace.some((entry) => entry.startsWith("text:")), false);
});

test("managed Composer settling accepts proven empty Astra phases without input", async () => {
  const trace: string[] = [];
  const { adapter, bridge } = createHarness({ trace, screens: CODEX_ASTRA_STYLED_COMPOSER_PHASES });
  const result = await bridge.observeCodexComposer(adapter, CONTROL, "new managed task", {
    agentVersion: "0.155.1"
  });
  assert.equal(result.state, "exact_empty");
  assert.equal(trace.includes("enter"), false);
  assert.equal(trace.some((entry) => entry.startsWith("text:")), false);
});

test("Astra Composer proof never overrides working, approval, or expanded async input", async () => {
  const base = CODEX_ASTRA_STYLED_COMPOSER_PHASES[0];
  const cases = [
    { state: "working", screen: `• Working (esc to interrupt)\n${base}` },
    { state: "approval_or_modal", screen: `${base}\nWould you like to run the following command?\n  $ pwd\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n  Press enter to confirm or esc to cancel` },
    // A hybrid/repainting frame with the old inset statusline remains
    // unclassifiable and cannot acquire exact-empty authority.
    { state: "unavailable", screen: `${base}\n• Queued follow-up inputs\n  1 of 2\n  Choose?\n  › 1. Local\n    2. Remote\n  enter submit   ctrl + ] skip   ⌥ + ↓ prev question` },
    { state: "approval_or_modal", screen: "• Queued follow-up inputs\n  1 of 2\n  Choose?\n  › 1. Local\n    2. Remote\n  enter submit   ctrl + ] skip   ⌥ + ↓ prev question" },
    { state: "approval_or_modal", screen: `${base}\n  Questionnaire\n  Press esc to cancel` }
  ];
  for (const { state, screen } of cases) {
    const trace: string[] = [];
    const { adapter, bridge } = createHarness({ trace, screens: [screen] });
    const result = await bridge.observeCodexComposer(adapter, CONTROL, "new managed task", {
      agentVersion: "0.155.1"
    });
    assert.equal(result.state, state, screen);
    assert.equal(trace.includes("enter"), false);
    assert.equal(trace.some((entry) => entry.startsWith("text:")), false);
  }
});

test("managed user Send crosses the empty Astra boundary once and submits without a post-text Composer veto", async () => {
  const trace: string[] = [];
  const { adapter, bridge } = createHarness({
    trace,
    screens: CODEX_ASTRA_STYLED_COMPOSER_PHASES,
    screenAfterText: CODEX_ASTRA_STYLED_COMPOSER_PHASES[1]
      .replace("Ask Codex to do anything", "a real injected draft ⠁")
  });
  const request = "First request line\nSecond request line";
  const result = await bridge.send(adapter, CONTROL, request, {
    runtime: { agentVersion: "0.155.1" },
    requireExactEmptyComposerBeforeText: true,
    userExplicitEnterAfterTextWithoutComposerVeto: true
  });
  assert.equal(result.stage, "enter_dispatched");
  assert.equal(trace.filter((entry) => entry === `text:${request}`).length, 1);
  assert.equal(trace.filter((entry) => entry === "enter").length, 1);
  const afterText = trace.slice(trace.indexOf(`text:${request}`) + 1);
  assert.equal(afterText.includes("capture-styled"), false);
  assert.ok(afterText.some((entry) => entry.startsWith("sleep:")));
  assert.ok(afterText.indexOf("verify") < afterText.indexOf("enter"));
});

test("managed user Send refuses unproven Astra emptiness before any text or Enter", async () => {
  const base = CODEX_ASTRA_STYLED_COMPOSER_PHASES[0];
  for (const screen of [
    base.replace("Ask Codex to do anything", "human draft ⠁"),
    base.replace("⡀", "⣿"),
    stripTerminalEscapeSequences(base),
    `${base}\n  Press esc to cancel`
  ]) {
    const trace: string[] = [];
    const { adapter, bridge } = createHarness({ trace, screens: [screen] });
    await assert.rejects(bridge.send(adapter, CONTROL, "managed task", {
      runtime: { agentVersion: "0.155.1" },
      requireExactEmptyComposerBeforeText: true,
      userExplicitEnterAfterTextWithoutComposerVeto: true
    }), /not exactly empty/u);
    assert.equal(trace.includes("enter"), false);
    assert.equal(trace.some((entry) => entry.startsWith("text:")), false);
  }
});
