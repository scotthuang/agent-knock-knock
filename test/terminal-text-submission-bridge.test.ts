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
}) {
  let clock = 0;
  let verifyCalls = 0;
  let composerCalls = 0;
  const adapter = idleCodexAdapter(options.trace);
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
        return "private draft contents";
      },
      deliverText: async (_control, text) => {
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
      stripEscapes: (screen) => screen,
      codexBlockingModalVisible: () => false,
      inspectCodexAsyncQuestionInputMode: () => "absent",
      currentCodexComposer: () => {
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
