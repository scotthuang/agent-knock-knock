import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeTerminalAgentAdapter,
  claudePermissionCommandForApproval,
  classifyClaudeProcess,
  createClaudeTerminalAgentAdapter,
  detectClaudeApprovalPrompt,
  extractClaudeSessionId,
  inspectClaudeScreen,
  normalizeClaudePermissionCommand
} from "../src/claude-terminal-agent-adapter.js";
import { ClaudeHookStore } from "../src/claude-hook-store.js";
import { terminalControlCapabilitiesForAdapter } from "../src/terminal-agent-adapter.js";

test("classifies only direct interactive Claude CLI processes", () => {
  assert.deepEqual(
    classifyClaudeProcess({ pid: 29466, ppid: 82646, command: "claude", cwd: "/repo" }),
    {
      pid: 29466,
      ppid: 82646,
      command: "claude",
      cwd: "/repo",
      agent: "claude",
      kind: "claude_cli",
      sessionId: undefined,
      confidence: "medium",
      reason: "interactive Claude CLI process without an exact agent metadata row"
    }
  );
  assert.equal(
    classifyClaudeProcess({
      pid: 12,
      command: "/Users/test/.local/bin/claude --permission-mode default"
    })?.kind,
    "claude_cli"
  );

  for (const command of [
    "claude -p 'summarize this'",
    "claude --print=hello",
    "claude --background",
    "claude agents --json --all",
    "claude mcp serve",
    "claude --debug api doctor",
    "claude plugin list",
    "claude ultrareview",
    "claude update",
    "claude upgrade",
    "claude --help",
    "acpx --approve-all claude -s work",
    "node /opt/acpx/dist/index.js claude",
    "claude-code-acp --stdio",
    "/opt/bin/claude-wrapper claude",
    "sh -lc 'claude --resume session-1'",
    "uvx minimax-coding-plan-mcp -y"
  ]) {
    assert.equal(classifyClaudeProcess({ pid: 99, command }), undefined, command);
  }
});

test("parses explicit Claude session and resume flags", () => {
  assert.equal(extractClaudeSessionId("claude --session-id session-explicit"), "session-explicit");
  assert.equal(extractClaudeSessionId("claude --session-id=session-equals"), "session-equals");
  assert.equal(extractClaudeSessionId("claude --resume session-resume"), "session-resume");
  assert.equal(extractClaudeSessionId("claude --resume=session-equals-resume"), "session-equals-resume");
  assert.equal(extractClaudeSessionId("claude -r session-short"), "session-short");
  assert.equal(extractClaudeSessionId("claude -rsession-attached"), "session-attached");
  assert.equal(extractClaudeSessionId("claude --resume --permission-mode default"), undefined);
  assert.equal(
    extractClaudeSessionId("claude --resume old --session-id authoritative"),
    "authoritative"
  );
});

test("normalizes only a trusted source-tagged Tokenjuice Claude wrapper", (t) => {
  const root = temporaryHookStore(t);
  const launcher = path.join(root, "tokenjuice");
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const trustedLaunchers = [{
    configuredPath: launcher,
    canonicalPath: fs.realpathSync(launcher)
  }];
  assert.equal(
    normalizeClaudePermissionCommand(
      `${launcher} wrap --source claude-code -- /bin/sh -lc 'pwd'`,
      trustedLaunchers
    ),
    "pwd"
  );
  assert.equal(
    normalizeClaudePermissionCommand(
      `${launcher} wrap --source=claude-code -- /bin/sh -lc 'pwd'`,
      trustedLaunchers
    ),
    "pwd"
  );
  assert.equal(
    normalizeClaudePermissionCommand("./tokenjuice wrap --source claude-code -- ./zsh -lc 'pwd'", trustedLaunchers),
    "./tokenjuice wrap --source claude-code -- ./zsh -lc 'pwd'"
  );
  const untrustedShell = `${launcher} wrap --source claude-code -- ./zsh -lc 'pwd'`;
  assert.equal(normalizeClaudePermissionCommand(untrustedShell, trustedLaunchers), untrustedShell);

  const launcherAlias = path.join(root, "workspace-tokenjuice");
  const shellAlias = path.join(root, "workspace-zsh");
  fs.symlinkSync(launcher, launcherAlias);
  fs.symlinkSync("/bin/sh", shellAlias);
  const aliasLauncherCommand = `${launcherAlias} wrap --source claude-code -- /bin/sh -lc 'pwd'`;
  assert.equal(
    normalizeClaudePermissionCommand(aliasLauncherCommand, trustedLaunchers),
    aliasLauncherCommand
  );
  const aliasShellCommand = `${launcher} wrap --source claude-code -- ${shellAlias} -lc 'pwd'`;
  assert.equal(
    normalizeClaudePermissionCommand(aliasShellCommand, trustedLaunchers),
    aliasShellCommand
  );

  const dangerous = `pwd${" ".repeat(2_100)}; touch /tmp/should-not-run`;
  const longCommand = claudePermissionCommandForApproval(
    `${launcher} wrap --source claude-code -- /bin/sh -lc '${dangerous}'`,
    trustedLaunchers
  );
  assert.equal(longCommand.command, undefined);
  assert.match(longCommand.display, /^pwd/u);
  assert.ok(longCommand.display.length < dangerous.length);

  const secretCommand = claudePermissionCommandForApproval(
    "echo ARK_API_KEY=ark-test-secret-value",
    trustedLaunchers
  );
  assert.equal(secretCommand.command, undefined);
  assert.doesNotMatch(secretCommand.display, /ark-test-secret-value/u);
});

test("exact PID agent rows supplement session identity, cwd, and confidence", () => {
  const adapter = createClaudeTerminalAgentAdapter({
    agentRows: [
      {
        pid: 29466,
        cwd: "/workspace/from-agents",
        kind: "interactive",
        sessionId: "bb4b7b5b-4d6c-4fe8-929d-79fde1fec93c",
        status: "idle"
      },
      {
        pid: 29467,
        cwd: "/wrong-pid",
        kind: "interactive",
        sessionId: "wrong-session"
      }
    ]
  });
  const process = adapter.classifyProcess({ pid: 29466, command: "claude" });

  assert.equal(process?.sessionId, "bb4b7b5b-4d6c-4fe8-929d-79fde1fec93c");
  assert.equal(process?.cwd, "/workspace/from-agents");
  assert.equal(process?.confidence, "high");
  assert.match(process?.reason ?? "", /exact PID/);

  const exactPidRowWins = adapter.classifyProcess({
    pid: 29466,
    command: "claude --session-id command-session",
    cwd: "/workspace/from-ps"
  });
  assert.equal(exactPidRowWins?.sessionId, "bb4b7b5b-4d6c-4fe8-929d-79fde1fec93c");
  assert.equal(exactPidRowWins?.cwd, "/workspace/from-ps");

  assert.equal(
    createClaudeTerminalAgentAdapter({
      agentRows: [{ pid: 51, kind: "background", sessionId: "background-agent" }]
    }).classifyProcess({ pid: 51, command: "claude" }),
    undefined
  );
});

test("detects the Claude 2.1.198 idle and working terminal tails", () => {
  const oldCodexScrollback = [
    "Would you like to run the following command?",
    "› 1. Yes, proceed (y)",
    "• Working (12s • esc to interrupt)",
    ...Array.from({ length: 55 }, (_, index) => `old scrollback ${index}`)
  ];
  const idle = [
    ...oldCodexScrollback,
    "╭─── Claude Code v2.1.198 ─────────╮",
    "│ Welcome back!                    │",
    "╰──────────────────────────────────╯",
    "────────────────────────────────────",
    "❯\u00a0",
    "────────────────────────────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"
  ].join("\n");
  const idleInspection = inspectClaudeScreen({ screen: idle });
  assert.equal(idleInspection.activity.state, "idle");
  assert.equal(idleInspection.approval.blocked, false);
  assert.equal(idleInspection.completion, undefined);

  const working = [
    ...oldCodexScrollback,
    "❯ inspect the repository",
    "",
    "✻ Working… (12s · 312 tokens)",
    "  esc to interrupt"
  ].join("\n");
  const workingInspection = inspectClaudeScreen({ screen: working });
  assert.equal(workingInspection.activity.state, "working");
  assert.equal(workingInspection.completion, undefined);

  const codexOnly = inspectClaudeScreen({
    screen: [
      "• Working (12s • esc to interrupt)",
      "› Find and fix a bug"
    ].join("\n")
  });
  assert.equal(codexOnly.activity.state, "unknown");
});

test("approves only the currently highlighted one-time Yes choice", () => {
  const screen = [
    " Bash command",
    "",
    "   printf '%s' \"$ANTHROPIC_API_KEY\"",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for this command",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend"
  ].join("\n");
  const inspection = inspectClaudeScreen({ screen });

  assert.equal(inspection.activity.state, "awaiting_approval");
  assert.equal(inspection.approval.blocked, true);
  assert.equal(inspection.approval.approvable, true);
  if (!inspection.approval.approvable) {
    assert.fail("expected the selected one-time Yes option to be approvable");
  }
  assert.deepEqual(inspection.approval.action.keys, ["C-m"]);
  assert.equal(inspection.approval.action.mode, "keys");
  assert.equal(inspection.approval.action.label, "Yes");
  assert.equal(inspection.approval.promptKind, "claude_permission");
});

test("permission fallback fails closed for persistent, negative, unknown, and stale choices", () => {
  for (const [label, selected] of [
    ["persistent", "❯ 2. Yes, and don't ask again for this command"],
    ["negative", "❯ 3. No"],
    ["unknown", "❯ 1. Allow once"]
  ]) {
    const approval = detectClaudeApprovalPrompt([
      "Do you want to proceed?",
      "  1. Yes",
      selected,
      "  3. No",
      "Esc to cancel"
    ].join("\n"));
    assert.equal(approval.blocked, true, label);
    assert.equal(approval.approvable, false, label);
    assert.equal(approval.action, undefined, label);
  }

  const stale = detectClaudeApprovalPrompt([
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
    "Bash command completed",
    "────────────────────────",
    "❯",
    "────────────────────────",
    "accept edits on"
  ].join("\n"));
  assert.equal(stale.blocked, false);
  assert.equal(stale.approvable, false);
  assert.match(stale.reason, /stale/);

  const staleWithoutIdle = detectClaudeApprovalPrompt([
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
    "Bash command completed after the old dialog"
  ].join("\n"));
  assert.equal(staleWithoutIdle.blocked, false);
  assert.equal(staleWithoutIdle.approvable, false);
  assert.match(staleWithoutIdle.reason, /stale/);

  const prose = detectClaudeApprovalPrompt([
    "The README asks: Do you want to proceed?",
    "This is ordinary assistant prose, not a dialog.",
    "❯"
  ].join("\n"));
  assert.equal(prose.blocked, false);
  assert.equal(prose.approvable, false);
});

test("screen excerpts redact secrets and idle never becomes completion evidence", () => {
  const screen = [
    "ANTHROPIC_API_KEY=sk-ant-api03-super-secret-value",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "❯",
    "accept edits on"
  ].join("\n");
  const inspection = inspectClaudeScreen({
    screen,
    requestText: "finish the task",
    screenChangedSinceSend: true
  });

  assert.equal(inspection.activity.state, "idle");
  assert.equal(inspection.completion, undefined);
  assert.doesNotMatch(inspection.screenExcerpt, /super-secret-value/);
  assert.doesNotMatch(inspection.screenExcerpt, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(inspection.screenExcerpt, /\[REDACTED\]/);
});

test("structured hook permissions take priority and bind one-time allow to the managed turn", async (t) => {
  const store = new ClaudeHookStore({ rootDir: temporaryHookStore(t) });
  const runtime = {
    sessionId: "session-structured",
    pid: 7201,
    cwd: "/workspace/structured",
    conversationId: "conversation-structured",
    messageId: "message-structured",
    terminalTarget: "claude-work:0.0"
  };
  store.activateLease({
    sessionId: runtime.sessionId,
    pid: runtime.pid,
    cwd: runtime.cwd,
    conversationId: runtime.conversationId,
    messageId: runtime.messageId,
    terminalTarget: runtime.terminalTarget
  });
  const pending = store.record(claudePermissionInput(
    runtime.sessionId,
    runtime.cwd,
    "npm test"
  ), { claudePid: runtime.pid }).permission;
  assert.ok(pending);

  const adapter = createClaudeTerminalAgentAdapter({ hookStore: store });
  const inspection = adapter.inspectScreen({
    // The screen fallback itself is deliberately non-approvable. The structured hook wins.
    screen: claudePermissionScreen("❯ 2. Yes, and don't ask again for this command"),
    runtime
  });
  assert.equal(inspection.activity.state, "awaiting_approval");
  assert.equal(inspection.approval.approvable, true);
  if (!inspection.approval.approvable) {
    assert.fail("expected a structured Claude permission request");
  }
  assert.equal(inspection.approval.promptKind, "run_command");
  assert.equal(inspection.approval.command, "npm test");
  assert.equal(inspection.approval.toolName, "Bash");
  assert.deepEqual(inspection.approval.action, {
    mode: "structured",
    keys: [],
    label: "Allow once",
    requestId: pending.requestId
  });

  const resolution = await adapter.resolveApproval?.({
    decision: "allow",
    expectedFingerprint: "current-bridge-fingerprint",
    actualFingerprint: "current-bridge-fingerprint",
    inspection,
    runtime
  });
  assert.equal(resolution?.resolved, true);
  assert.equal(resolution?.requestId, pending.requestId);
  const decidedPending = adapter.inspectScreen({
    screen: claudePermissionScreen("❯ 1. Yes"),
    runtime
  });
  assert.equal(decidedPending.approval.blocked, true);
  assert.equal(decidedPending.approval.approvable, false);
  assert.match(decidedPending.approval.reason, /waiting for hook consumption/u);
  const consumed = store.consumePermissionDecision({
    sessionId: pending.sessionId,
    requestId: pending.requestId,
    fingerprint: pending.fingerprint,
    conversationId: pending.conversationId,
    messageId: pending.messageId
  });
  assert.equal(consumed?.behavior, "allow");
  assert.deepEqual(consumed?.hookOutput, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" }
    }
  });
});

test("structured non-Bash permissions expose only a safe target summary", (t) => {
  const store = new ClaudeHookStore({ rootDir: temporaryHookStore(t) });
  const runtime = {
    sessionId: "session-write",
    pid: 7251,
    cwd: "/workspace/write",
    conversationId: "conversation-write",
    messageId: "message-write",
    terminalTarget: "claude-work:0.0"
  };
  store.activateLease({ ...runtime });
  store.record({
    ...claudeHookBase(runtime.sessionId, runtime.cwd),
    hook_event_name: "PermissionRequest",
    prompt_id: "turn-write",
    tool_name: "Write",
    tool_input: {
      file_path: "/workspace/write/notes.md",
      content: "private file body that must not be disclosed"
    }
  }, { claudePid: runtime.pid });

  const inspection = createClaudeTerminalAgentAdapter({ hookStore: store }).inspectScreen({
    screen: "Do you want to create notes.md?",
    runtime
  });
  assert.equal(inspection.approval.approvable, true);
  if (!inspection.approval.approvable) {
    assert.fail("expected a structured Write permission request");
  }
  assert.equal(inspection.approval.promptKind, "tool_permission");
  assert.equal(inspection.approval.toolName, "Write");
  assert.equal(inspection.approval.requestDetail, "File: /workspace/write/notes.md");
  assert.equal(inspection.approval.command, undefined);
  assert.doesNotMatch(JSON.stringify(inspection.approval), /private file body/u);
});

test("structured approval fails closed for changed, stale, unknown, and ambiguous identity", async (t) => {
  let nowMs = Date.parse("2026-07-23T05:00:00.000Z");
  const store = new ClaudeHookStore({
    rootDir: temporaryHookStore(t),
    now: () => new Date(nowMs)
  });
  const runtime = {
    sessionId: "session-revalidate",
    pid: 7301,
    cwd: "/workspace/revalidate",
    conversationId: "conversation-revalidate",
    messageId: "message-revalidate",
    terminalTarget: "claude-work:0.0"
  };
  store.activateLease({ ...runtime });
  store.record(
    claudePermissionInput(runtime.sessionId, runtime.cwd, "git push"),
    { claudePid: runtime.pid, permissionLeaseMs: 1_000 }
  );
  const adapter = createClaudeTerminalAgentAdapter({ hookStore: store });
  const inspection = adapter.inspectScreen({ screen: claudePermissionScreen("❯ 1. Yes"), runtime });
  assert.equal(inspection.approval.approvable, true);

  const changed = await adapter.resolveApproval?.({
    decision: "allow",
    expectedFingerprint: "old",
    actualFingerprint: "new",
    inspection,
    runtime
  });
  assert.equal(changed?.resolved, false);
  assert.match(changed?.reason ?? "", /fingerprint changed/u);

  const wrongTurn = await adapter.resolveApproval?.({
    decision: "allow",
    expectedFingerprint: "same",
    actualFingerprint: "same",
    inspection,
    runtime: { ...runtime, messageId: "different-message" }
  });
  assert.equal(wrongTurn?.resolved, false);
  assert.match(wrongTurn?.reason ?? "", /different conversation message|managed lease/u);

  nowMs += 1_001;
  const stale = adapter.inspectScreen({
    screen: claudePermissionScreen("❯ 1. Yes"),
    runtime
  });
  assert.equal(stale.approval.blocked, true);
  assert.equal(stale.approval.approvable, false);
  assert.match(stale.approval.reason, /no current structured hook request/u);

  const unknown = adapter.inspectScreen({
    screen: claudePermissionScreen("❯ 1. Yes"),
    runtime: { ...runtime, sessionId: "unknown-session", pid: undefined }
  });
  assert.equal(unknown.approval.blocked, true);
  assert.equal(unknown.approval.approvable, false);

  const ambiguousStore = new ClaudeHookStore({ rootDir: temporaryHookStore(t) });
  ambiguousStore.record(claudeSessionStartInput("ambiguous-a", "/workspace/shared"), { claudePid: 7401 });
  ambiguousStore.record(claudeSessionStartInput("ambiguous-b", "/workspace/shared"), { claudePid: 7401 });
  const ambiguous = createClaudeTerminalAgentAdapter({ hookStore: ambiguousStore }).inspectScreen({
    screen: claudePermissionScreen("❯ 1. Yes"),
    runtime: { pid: 7401, cwd: "/workspace/shared" }
  });
  assert.equal(ambiguous.approval.blocked, true);
  assert.equal(ambiguous.approval.approvable, false);
  assert.match(ambiguous.approval.reason, /multiple Claude sessions/u);
});

test("durable Claude completion requires explicit empty background state", async (t) => {
  let nowMs = Date.parse("2026-07-23T06:00:00.000Z");
  const store = new ClaudeHookStore({
    rootDir: temporaryHookStore(t),
    now: () => new Date(nowMs)
  });
  const adapter = createClaudeTerminalAgentAdapter({ hookStore: store });
  const sessionId = "session-completion-adapter";
  const cwd = "/workspace/completion-adapter";
  const pid = 7501;
  const conversationId = "conversation-completion-adapter";
  let activeLeaseId: string | undefined;
  const bindMessage = (messageId: string) => {
    if (activeLeaseId) {
      store.releaseLease({ leaseId: activeLeaseId });
    }
    const lease = store.activateLease({
      sessionId,
      pid,
      cwd,
      conversationId,
      messageId,
      terminalTarget: "claude-work:0.0"
    });
    activeLeaseId = lease.id;
    return {
      sessionId,
      pid,
      cwd,
      conversationId,
      messageId,
      promptId: messageId.replace("message", "turn")
    };
  };

  const unknownRuntime = bindMessage("message-unknown");
  store.record(claudePromptInput(sessionId, cwd, "turn-unknown"), { claudePid: pid });
  nowMs += 10;
  store.record(claudeStopInput(sessionId, cwd, "turn-unknown", {
    last_assistant_message: "This is not verified without the background fields."
  }), { claudePid: pid });
  assert.equal(await adapter.detectDurableCompletion?.({
    sessionId,
    cwd,
    startedAt: "2026-07-23T06:00:00.000Z",
    context: unknownRuntime
  }), undefined);

  nowMs += 10;
  const backgroundStartedAt = new Date(nowMs).toISOString();
  const backgroundRuntime = bindMessage("message-background");
  store.record(claudePromptInput(sessionId, cwd, "turn-background"), { claudePid: pid });
  nowMs += 10;
  store.record(claudeStopInput(sessionId, cwd, "turn-background", {
    last_assistant_message: "A task remains active.",
    background_tasks: [{ id: "task-1", type: "bash", status: "running", description: "tests" }],
    session_crons: []
  }), { claudePid: pid });
  assert.equal(await adapter.detectDurableCompletion?.({
    sessionId,
    cwd,
    startedAt: backgroundStartedAt,
    context: backgroundRuntime
  }), undefined);

  nowMs += 10;
  const completedStartedAt = new Date(nowMs).toISOString();
  const completedRuntime = bindMessage("message-done");
  store.record(claudePromptInput(sessionId, cwd, "turn-done"), { claudePid: pid });
  nowMs += 10;
  const stop = store.record(claudeStopInput(sessionId, cwd, "turn-done", {
    last_assistant_message: "Implementation complete; all tests pass.",
    background_tasks: [],
    session_crons: []
  }), { claudePid: pid });
  const completed = await adapter.detectDurableCompletion?.({
    sessionId: "terminal:v2:tmux:claude:work:0.0:7501",
    cwd,
    startedAt: completedStartedAt,
    context: completedRuntime
  });
  assert.deepEqual(completed, {
    source: "durable",
    outcome: "success",
    text: "Implementation complete; all tests pass.",
    timestamp: stop.event.received_at,
    id: stop.event.id,
    confidence: "high",
    metadata: {
      match: "claude_stop_hook",
      session_id: sessionId,
      prompt_id: "turn-done",
      cwd
    }
  });
});

test("StopFailure maps to actionable durable failure evidence", async (t) => {
  let nowMs = Date.parse("2026-07-23T07:00:00.000Z");
  const store = new ClaudeHookStore({
    rootDir: temporaryHookStore(t),
    now: () => new Date(nowMs)
  });
  const sessionId = "session-failure-adapter";
  const cwd = "/workspace/failure-adapter";
  const pid = 7601;
  const conversationId = "conversation-failure-adapter";
  const messageId = "message-failure-adapter";
  store.activateLease({
    sessionId,
    pid,
    cwd,
    conversationId,
    messageId,
    terminalTarget: "claude-work:0.0"
  });
  store.record(claudePromptInput(sessionId, cwd, "turn-failure"), { claudePid: pid });
  nowMs += 20;
  const failed = store.record({
    ...claudeHookBase(sessionId, cwd),
    hook_event_name: "StopFailure",
    prompt_id: "turn-failure",
    error: "server_error",
    error_details: { status: 503, retryable: true },
    last_assistant_message: "API Error: service unavailable"
  }, { claudePid: pid });

  const evidence = await createClaudeTerminalAgentAdapter({ hookStore: store })
    .detectDurableCompletion?.({
      sessionId,
      cwd,
      startedAt: "2026-07-23T07:00:00.000Z",
      context: {
        sessionId,
        pid,
        cwd,
        conversationId,
        messageId,
        promptId: "turn-failure"
      }
    });
  assert.equal(evidence?.source, "durable");
  assert.equal(evidence?.outcome, "failure");
  assert.equal(evidence?.id, failed.event.id);
  assert.match(evidence?.text ?? "", /server_error/u);
  assert.match(evidence?.text ?? "", /service unavailable/u);
  assert.match(evidence?.text ?? "", /503/u);
  assert.deepEqual(evidence?.metadata, {
    match: "claude_stop_failure_hook",
    session_id: sessionId,
    prompt_id: "turn-failure",
    error: "server_error",
    error_details: { status: 503, retryable: true }
  });
});

test("Claude terminal capabilities keep completion hook-only and cancel with Escape", () => {
  assert.deepEqual(terminalControlCapabilitiesForAdapter(claudeTerminalAgentAdapter), [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "terminal_cancel"
  ]);
  assert.deepEqual(claudeTerminalAgentAdapter.cancelKeys, ["Escape"]);
  assert.equal(claudeTerminalAgentAdapter.capabilities.screenCompletion, false);
  assert.equal(claudeTerminalAgentAdapter.capabilities.durableCompletion, false);
  assert.equal(claudeTerminalAgentAdapter.detectDurableCompletion, undefined);

  const hookAdapter = createClaudeTerminalAgentAdapter({
    hookStore: new ClaudeHookStore({ rootDir: path.join(os.tmpdir(), "unused-claude-hook-store") })
  });
  assert.equal(hookAdapter.capabilities.durableCompletion, true);
  assert.equal(typeof hookAdapter.detectDurableCompletion, "function");
  assert.equal(typeof hookAdapter.resolveApproval, "function");
});

function temporaryHookStore(t: test.TestContext): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-adapter-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function claudeHookBase(sessionId: string, cwd: string) {
  return {
    session_id: sessionId,
    transcript_path: path.join(cwd, ".claude", `${sessionId}.jsonl`),
    cwd,
    permission_mode: "default"
  };
}

function claudeSessionStartInput(sessionId: string, cwd: string) {
  return {
    ...claudeHookBase(sessionId, cwd),
    hook_event_name: "SessionStart" as const,
    source: "startup" as const,
    model: "claude-opus-4-6"
  };
}

function claudePromptInput(sessionId: string, cwd: string, promptId: string) {
  return {
    ...claudeHookBase(sessionId, cwd),
    hook_event_name: "UserPromptSubmit" as const,
    prompt_id: promptId,
    prompt: `prompt for ${promptId}`
  };
}

function claudePermissionInput(sessionId: string, cwd: string, command: string) {
  return {
    ...claudeHookBase(sessionId, cwd),
    hook_event_name: "PermissionRequest" as const,
    prompt_id: "turn-permission",
    tool_name: "Bash",
    tool_input: { command }
  };
}

function claudeStopInput(
  sessionId: string,
  cwd: string,
  promptId: string,
  fields: Record<string, unknown>
) {
  return {
    ...claudeHookBase(sessionId, cwd),
    hook_event_name: "Stop" as const,
    prompt_id: promptId,
    stop_hook_active: false,
    ...fields
  };
}

function claudePermissionScreen(selected: string): string {
  return [
    "Bash command",
    "npm test",
    "Do you want to proceed?",
    "  1. Yes",
    selected,
    "  3. No",
    "Esc to cancel"
  ].join("\n");
}
