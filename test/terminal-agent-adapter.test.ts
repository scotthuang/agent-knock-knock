import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createCodexTerminalAgentAdapter,
  codexTerminalAgentAdapter,
  detectCodexApprovalPrompt,
  detectCodexDurableCompletion,
  inspectCodexScreen
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
    () => parseTerminalConversationId("terminal:v2:tmux:cursor:work:0.1:not-a-pid"),
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
    () => registry.require("cursor"),
    /terminal agent adapter is not registered for cursor/
  );
});

test("default registry exposes Codex and Claude and rejects unsupported terminal agents", () => {
  assert.equal(terminalAgentAdapterFor("codex"), codexTerminalAgentAdapter);
  assert.equal(terminalAgentAdapterFor("claude"), claudeTerminalAgentAdapter);
  assert.throws(
    () => terminalAgentAdapterFor("cursor"),
    /terminal agent adapter is not registered for cursor/
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
  assert.equal(
    codexTerminalAgentAdapter.classifyProcess({ pid: 43, command: "codex-acp", cwd: "/repo" }),
    undefined
  );
});
