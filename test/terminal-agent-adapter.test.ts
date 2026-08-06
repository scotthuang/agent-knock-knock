import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createCodexTerminalAgentAdapter,
  codexTerminalAgentAdapter,
  detectCodexApprovalPrompt,
  detectCodexDurableCompletion,
  inspectCodexScreen,
  observeCodexThreadLifecycle,
  planCodexThreadLifecycle,
  probeCodexThreadLifecycle
} from "../src/codex-terminal-agent-adapter.js";
import { claudeTerminalAgentAdapter } from "../src/claude-terminal-agent-adapter.js";
import { terminalAgentAdapterFor } from "../src/terminal-agent-registry.js";
import {
  createTerminalAgentAdapterRegistry,
  formatTerminalConversationId,
  parseTerminalConversationId,
  terminalControlCapabilitiesForAdapter,
  type TerminalAgentAdapter
} from "../src/terminal-agent-adapter.js";

const UNKNOWN_AGENT = "unknown-agent" as never;

test("agent-aware terminal conversation ids round-trip and legacy ids remain Codex", () => {
  const id = formatTerminalConversationId({
    agent: "claude",
    target: "claude-work:2.1",
    pid: 417
  });
  assert.equal(id, "terminal:v2:tmux:claude:claude-work:2.1:417");
  assert.deepEqual(parseTerminalConversationId(id), {
    conversationId: id,
    kind: "tmux",
    agent: "claude",
    target: "claude-work:2.1",
    pid: 417,
    legacy: false
  });

  const legacy = "terminal:tmux:codex-work:0.0:2222";
  assert.deepEqual(parseTerminalConversationId(legacy), {
    conversationId: legacy,
    kind: "tmux",
    agent: "codex",
    target: "codex-work:0.0",
    pid: 2222,
    legacy: true
  });
});

test("legacy target named codex is not confused with an agent marker", () => {
  const legacy = "terminal:tmux:codex:0.1:333";
  const parsed = parseTerminalConversationId(legacy);

  assert.equal(parsed?.legacy, true);
  assert.equal(parsed?.agent, "codex");
  assert.equal(parsed?.target, "codex:0.1");
});

test("malformed and unsupported agent-aware ids fail closed", () => {
  assert.throws(
    () => parseTerminalConversationId("terminal:v2:tmux:other:work:0.1:333"),
    /unsupported terminal agent.*other/
  );
  assert.throws(
    () => parseTerminalConversationId("terminal:v2:tmux:codex:work:0.1:not-a-pid"),
    /invalid terminal-controlled conversation id/
  );
});

test("registry dispatches a test-only adapter and fails closed for missing adapters", () => {
  const calls: string[] = [];
  const recordingAdapter: TerminalAgentAdapter<"test_cli"> = {
    agent: "claude",
    displayName: "Recording adapter",
    capabilities: {
      processDiscovery: true,
      screenStatus: true,
      terminalApproval: false,
      screenCompletion: false,
      durableCompletion: false,
      cancellation: true
    },
    cancelKeys: ["Escape", "C-c"],
    classifyProcess(snapshot) {
      calls.push(`process:${snapshot.pid}`);
      return {
        ...snapshot,
        agent: "claude",
        kind: "test_cli",
        confidence: "high",
        reason: "recorded"
      };
    },
    inspectScreen({ screen }) {
      calls.push(`screen:${screen}`);
      return {
        activity: { state: "idle", reason: "recorded" },
        approval: { blocked: false, approvable: false, reason: "unsupported" },
        screenExcerpt: screen
      };
    }
  };
  const registry = createTerminalAgentAdapterRegistry([recordingAdapter]);

  assert.equal(registry.require("claude"), recordingAdapter);
  assert.equal(registry.require("claude").classifyProcess({ pid: 7, command: "test" })?.kind, "test_cli");
  assert.equal(registry.require("claude").inspectScreen({ screen: "ready" }).activity.state, "idle");
  assert.deepEqual(calls, ["process:7", "screen:ready"]);
  assert.throws(
    () => registry.require(UNKNOWN_AGENT),
    /terminal agent adapter is not registered for unknown-agent/
  );
});

test("default registry exposes Codex and Claude and rejects unsupported terminal agents", () => {
  assert.equal(terminalAgentAdapterFor("codex"), codexTerminalAgentAdapter);
  assert.equal(terminalAgentAdapterFor("claude"), claudeTerminalAgentAdapter);
  assert.throws(
    () => terminalAgentAdapterFor(UNKNOWN_AGENT),
    /terminal agent adapter is not registered for unknown-agent/
  );
});

test("Codex adapter preserves approval detection with an ordered key action", () => {
  const screen = [
    "  ARK_API_KEY=ark-test-secret-value",
    "  Would you like to run the following command?",
    "",
    "  $ curl -I https://example.com",
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)",
    "  Press enter to confirm or esc to cancel"
  ].join("\n");
  const inspection = inspectCodexScreen({ screen });

  assert.equal(inspection.activity.state, "awaiting_approval");
  assert.equal(inspection.approval.blocked, true);
  assert.equal(inspection.approval.approvable, true);
  if (!inspection.approval.approvable) {
    assert.fail("expected approvable Codex prompt");
  }
  assert.deepEqual(inspection.approval.action.keys, ["y"]);
  assert.equal(inspection.approval.action.label, "Yes, proceed");
  assert.equal(inspection.approval.promptKind, "run_command");
  assert.equal(inspection.approval.command, "curl -I https://example.com");
  assert.match(inspection.screenExcerpt, /ARK_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(inspection.screenExcerpt, /ark-test-secret-value/);
});

test("Codex adapter accepts current and legacy composer markers without weakening state precedence", () => {
  for (const marker of ["›", "»"]) {
    const idle = inspectCodexScreen({
      screen: [
        "The previous turn is complete.",
        "",
        `${marker} Find and fix a bug in @filename`,
        "",
        "gpt-5.6-sol high · /repo"
      ].join("\n")
    });
    assert.equal(idle.activity.state, "idle", marker);

    const emptyComposer = inspectCodexScreen({
      screen: `Model: GPT-5\n\n${marker} `
    });
    assert.equal(emptyComposer.activity.state, "idle", `${marker}:empty`);

    const working = inspectCodexScreen({
      screen: [
        "• Working (12s • esc to interrupt)",
        "",
        `${marker} Steer the current task`
      ].join("\n")
    });
    assert.equal(working.activity.state, "working", `${marker}:working`);
    assert.equal(working.completion, undefined);
  }

  const inlineMarker = inspectCodexScreen({
    screen: "The final answer contains an inline » symbol.\nNo Codex composer is visible."
  });
  assert.equal(inlineMarker.activity.state, "unknown");

  const lineLeadingMarker = inspectCodexScreen({
    screen: [
      "Codex is explaining typography.",
      "» This line is part of the response.",
      "Still generating more output..."
    ].join("\n")
  });
  assert.equal(lineLeadingMarker.activity.state, "unknown");

  const indentedMarker = inspectCodexScreen({
    screen: [
      "Codex is still producing output.",
      "  » This indented line is quoted output."
    ].join("\n")
  });
  assert.equal(indentedMarker.activity.state, "unknown");

  const numberedChoice = inspectCodexScreen({
    screen: "A menu without a recognized approval marker\n» 1. First choice"
  });
  assert.equal(numberedChoice.activity.state, "unknown");
});

test("Codex adapter parses and invalidates approval prompts with the current composer marker", () => {
  const currentApproval = inspectCodexScreen({
    screen: [
      "Would you like to run the following command?",
      "",
      "  $ git diff",
      "    --stat",
      "",
      "» 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)"
    ].join("\n")
  });
  assert.equal(currentApproval.activity.state, "awaiting_approval");
  assert.equal(currentApproval.approval.approvable, true);
  if (!currentApproval.approval.approvable) {
    assert.fail("expected current-marker approval to be approvable");
  }
  assert.deepEqual(currentApproval.approval.action.keys, ["y"]);
  assert.equal(currentApproval.approval.command, "git diff --stat");

  const stale = detectCodexApprovalPrompt([
    "Would you like to run the following command?",
    "» 1. Yes, proceed (y)",
    "✔ You approved codex to run git status -sb",
    "» Start another task"
  ].join("\n"));
  assert.equal(stale.approvable, false);
  assert.match(stale.approvable ? "" : stale.reason, /appears stale/);
});

test("Codex adapter rejects stale approval prompts without returning keys", () => {
  const screen = [
    "Would you like to run the following command?",
    "› 1. Yes, proceed (y)",
    "✔ You approved codex to run git status -sb",
    "• Working (12s • esc to interrupt)",
    "› Find and fix a bug"
  ].join("\n");
  const approval = detectCodexApprovalPrompt(screen);
  const inspection = inspectCodexScreen({ screen });

  assert.equal(approval.approvable, false);
  assert.match(approval.approvable ? "" : approval.reason, /appears stale/);
  assert.equal(inspection.approval.approvable, false);
  assert.equal(inspection.approval.action, undefined);
});

test("Codex adapter detects screen and durable completion evidence", async () => {
  const requestText = "Check the latest changes";
  const screen = [
    `› ${requestText}`,
    "The implementation is complete and all relevant tests now pass successfully.",
    "─ Worked for 1m ─────────────────────────────",
    "›",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  const inspection = inspectCodexScreen({ screen, requestText });
  assert.equal(inspection.activity.state, "idle");
  assert.equal(inspection.completion?.source, "screen");
  assert.match(inspection.completion?.text ?? "", /implementation is complete/);

  const userTimestamp = "2026-07-22T10:00:00.000Z";
  const completedAt = "2026-07-22T10:00:02.000Z";
  const durable = detectCodexDurableCompletion({
    requestText,
    startedAt: "2026-07-22T09:59:59.000Z",
    context: {
      source: { agent: "codex", sessionId: "session-1", cwd: "/repo" },
      messages: [],
      commands: [],
      turns: [{
        userText: requestText,
        userTextHash: createHash("sha256").update(requestText).digest("hex"),
        userTimestamp,
        turnId: "turn-1",
        completedAt,
        lastAssistantMessage: "All tests pass."
      }],
      truncated: false
    }
  });
  assert.deepEqual(durable, {
    source: "durable",
    text: "All tests pass.",
    timestamp: completedAt,
    id: "turn-1",
    confidence: "high",
    metadata: {
      match: "rollout_task_complete",
      userTimestamp,
      session: { agent: "codex", sessionId: "session-1", cwd: "/repo" }
    }
  });

  let composedRequest: unknown;
  const composed = createCodexTerminalAgentAdapter({
    async detectDurableCompletion(request) {
      composedRequest = request;
      return { source: "durable", text: "from provider" };
    }
  });
  assert.equal((await composed.detectDurableCompletion?.({ sessionId: "session-2" }))?.text, "from provider");
  assert.deepEqual(composedRequest, { sessionId: "session-2" });
});

test("Codex adapter extracts completion across mixed composer marker generations", () => {
  const requestText = "Check the current changes";
  const currentScreen = [
    `» ${requestText}`,
    "The implementation is complete and the focused tests pass.",
    "» Use /skills to list available skills",
    "─ Worked for 20s ─────────────────────────────",
    "»",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  const current = inspectCodexScreen({ screen: currentScreen, requestText });
  assert.equal(current.activity.state, "idle");
  assert.equal(current.completion?.source, "screen");
  assert.match(current.completion?.text ?? "", /implementation is complete/);
  assert.doesNotMatch(current.completion?.text ?? "", /Use \/skills/);

  const mixedHistory = [
    "› First request",
    "The first response is old.",
    "─ Worked for 10s ─────────────────────────────",
    "» Second request",
    "The second response is the only current completion.",
    "» This marker is quoted output, not another composer.",
    "The response continues after the quoted marker.",
    "─ Worked for 12s ─────────────────────────────",
    "»",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  const fallback = inspectCodexScreen({
    screen: mixedHistory,
    screenChangedSinceSend: true
  });
  assert.equal(fallback.activity.state, "idle");
  assert.match(fallback.completion?.text ?? "", /second response/);
  assert.match(fallback.completion?.text ?? "", /quoted output/);
  assert.match(fallback.completion?.text ?? "", /response continues/);
  assert.doesNotMatch(fallback.completion?.text ?? "", /first response/);
});

test("adapter capabilities advertise semantic terminal behavior explicitly", () => {
  assert.deepEqual(terminalControlCapabilitiesForAdapter(codexTerminalAgentAdapter), [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "screen_completion",
    "durable_completion",
    "terminal_cancel"
  ]);
  assert.deepEqual(codexTerminalAgentAdapter.cancelKeys, ["C-c"]);
  assert.equal(
    codexTerminalAgentAdapter.classifyProcess({ pid: 42, command: "codex", cwd: "/repo" })?.kind,
    "codex_cli"
  );
});

test("verified Codex lifecycle profiles use closed status-clear-status steps", () => {
  const legacyCapabilities = probeCodexThreadLifecycle("0.146.0");
  assert.equal(legacyCapabilities.status, "supported");
  assert.equal(
    legacyCapabilities.behaviorProfile,
    "codex-tui-0.146.0"
  );

  const capabilities = probeCodexThreadLifecycle("0.146.1");
  assert.equal(capabilities.status, "supported");
  assert.equal(
    capabilities.behaviorProfile,
    "codex-tui-0.146.1"
  );
  assert.equal(probeCodexThreadLifecycle("0.146.2").status, "unsupported");
  assert.equal(probeCodexThreadLifecycle(undefined).status, "unknown");

  const fresh = planCodexThreadLifecycle(
    { kind: "new_thread" },
    capabilities
  );
  assert.deepEqual(fresh.steps, [
    {
      kind: "identity_probe_before",
      command: "/status",
      effect: "read_only",
      requiresIdle: true
    },
    {
      kind: "transition",
      command: "/clear",
      effect: "thread_transition",
      requiresIdle: true
    },
    {
      kind: "identity_probe_after",
      command: "/status",
      effect: "read_only",
      requiresIdle: true
    }
  ]);

  const target = "11111111-1111-4111-8111-111111111111";
  const resume = planCodexThreadLifecycle(
    { kind: "resume_thread", nativeThreadId: target },
    capabilities
  );
  assert.deepEqual(
    resume.steps.map((step) => [step.kind, step.command]),
    [
      ["transition", `/resume ${target}`],
      ["identity_probe_after", "/status"]
    ]
  );
  assert.throws(
    () => planCodexThreadLifecycle(
      { kind: "resume_thread", nativeThreadId: "partial" },
      capabilities
    ),
    /complete native thread UUID/u
  );
});

test("Codex lifecycle observer verifies only a fresh exact status UUID", () => {
  const before = "11111111-1111-4111-8111-111111111111";
  const after = "22222222-2222-4222-8222-222222222222";
  const statusScreen = [
    "/status",
    "╭────────────────────────────────────╮",
    `│  Session:          ${after} │`,
    "╰────────────────────────────────────╯"
  ].join("\n");
  assert.deepEqual(
    observeCodexThreadLifecycle({
      operation: { kind: "new_thread" },
      phase: "after",
      beforeNativeThreadId: before,
      screen: statusScreen
    }),
    {
      status: "verified",
      nativeThreadId: after,
      evidence: "codex_status_card"
    }
  );
  assert.equal(
    observeCodexThreadLifecycle({
      operation: { kind: "new_thread" },
      phase: "after",
      beforeNativeThreadId: after,
      screen: statusScreen
    }).status,
    "mismatch"
  );
  assert.equal(
    observeCodexThreadLifecycle({
      operation: { kind: "resume_thread", nativeThreadId: before },
      phase: "after",
      expectedNativeThreadId: before,
      screen: statusScreen
    }).status,
    "mismatch"
  );
  assert.equal(
    observeCodexThreadLifecycle({
      operation: { kind: "resume_thread", nativeThreadId: after },
      phase: "after",
      screen: statusScreen
    }).status,
    "verified"
  );
  assert.equal(
    observeCodexThreadLifecycle({
      operation: { kind: "resume_thread", nativeThreadId: after },
      phase: "after",
      screen: `Session: ${after}`
    }).status,
    "missing"
  );
  assert.equal(
    observeCodexThreadLifecycle({
      operation: { kind: "new_thread" },
      phase: "after",
      beforeNativeThreadId: before,
      screen: [
        "/status",
        `Session: ${after}`,
        "/clear",
        "Cleared",
        "› "
      ].join("\n")
    }).status,
    "missing"
  );

  const ambiguous = [
    "/status",
    `Session: ${before}`,
    `Session: ${after}`
  ].join("\n");
  assert.equal(
    observeCodexThreadLifecycle({
      operation: { kind: "new_thread" },
      phase: "after",
      beforeNativeThreadId: before,
      screen: ambiguous
    }).status,
    "ambiguous"
  );
});
