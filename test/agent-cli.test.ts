import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const CODEX_ACPX_SELECTOR = ["--agent", "npx -y @agentclientprotocol/codex-acp@^1.1.0"];
const sessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const cwd = "/repo/agent-knock-knock";
const rolloutPath = "/tmp/codex-rollout.jsonl";

test("agent takeover terminal_control attaches tmux pane and send writes to the terminal", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-terminal-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeTmux(fakeBinDir, tmuxCallsPath);

    const plan = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminal_control",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--processes-json",
      JSON.stringify([{
        pid: 1234,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }, {
        pid: 1235,
        ppid: 1234,
        command: `/vendor/bin/codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({ panePid: 999, currentPath: workspace })])
    ]);

    assert.equal(plan.status, 0, plan.stderr || plan.stdout);
    const planned = JSON.parse(plan.stdout);
    assert.equal(planned.status, "requires_confirmation");
    assert.equal(planned.plan.mode, "terminal_control");
    assert.equal(planned.plan.targets.length, 1);
    assert.deepEqual(planned.plan.targets[0].childPids, [1235]);
    assert.equal(planned.plan.targets[0].terminalControl.target, "codex-work:0.0");

    const attached = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminal_control",
      "--create-conversation",
      "--confirm-terminal",
      "--terminal-target",
      "codex-work:0.0",
      "--request",
      "Take over tmux Codex",
      "--store-dir",
      storeDir,
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--processes-json",
      JSON.stringify([{
        pid: 1234,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({ panePid: 999, currentPath: workspace })])
    ]);

    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const parsed = JSON.parse(attached.stdout);
    assert.equal(parsed.status, "attached");
    assert.equal(parsed.conversation.native_session_takeover.strategy, "terminal_control");
    assert.equal(parsed.conversation.native_session_takeover.needs_bootstrap, false);
    assert.equal(parsed.conversation.native_session_takeover.terminal_bridge, true);
    assert.equal(parsed.conversation.native_session_takeover.terminal_control.target, "codex-work:0.0");

    const sent = runAgentCli([
      "send",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "继续当前任务"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.status, "async_pending");
    assert.equal(sentParsed.background, true);
    assert.equal(sentParsed.callback_expected, true);
    assert.equal(sentParsed.openclaw_next_action.action, "yield");
    assert.equal(sentParsed.openclaw_next_action.callback_expected, true);
    assert.equal(sentParsed.terminal_control.target, "codex-work:0.0");
    let calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-2).args, ["send-keys", "-t", "codex-work:0.0", "-l", "继续当前任务"]);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.0", "C-m"]);

    const cancelled = runAgentCli([
      "cancel",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    const cancelledParsed = JSON.parse(cancelled.stdout);
    assert.equal(cancelledParsed.cancel_requested, true);
    assert.equal(cancelledParsed.terminal_control.target, "codex-work:0.0");
    assert.equal(cancelledParsed.key, "C-c");
    assert.equal(cancelledParsed.conversation.status, sentParsed.conversation.status);
    calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.0", "C-c"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("approve sends y only when the terminal screen shows a primary Codex approval option", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-approve-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, [
      "  ARK_API_KEY=ark-test-secret-value",
      "",
      "  Would you like to run the following command?",
      "",
      "  $ curl -I https://example.com",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel"
    ].join("\n"));
    writeFakeTmux(fakeBinDir, tmuxCallsPath, screenPath);

    const attached = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminal_control",
      "--create-conversation",
      "--confirm-terminal",
      "--terminal-target",
      "codex-work:0.0",
      "--store-dir",
      storeDir,
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--processes-json",
      JSON.stringify([{
        pid: 1234,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({ panePid: 999, currentPath: workspace })])
    ]);
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const parsed = JSON.parse(attached.stdout);

    const status = runAgentCli([
      "status",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusParsed = JSON.parse(status.stdout);
    assert.match(statusParsed.terminal_screen.excerpt, /Would you like to run the following command/);
    assert.match(statusParsed.terminal_screen.excerpt, /ARK_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(statusParsed.terminal_screen.excerpt, /ark-test-secret-value/);
    assert.equal(statusParsed.terminal_screen.approval.approvable, true);
    assert.equal(statusParsed.terminal_status.reachable, true);
    assert.equal(statusParsed.terminal_status.target, "codex-work:0.0");
    assert.equal(statusParsed.terminal_status.activity_state, "awaiting_approval");
    assert.equal(statusParsed.terminal_status.approval_state.blocked, true);
    assert.equal(statusParsed.terminal_status.approval_state.approvable, true);

    const approved = runAgentCli([
      "approve",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.key, "y");
    const calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.0", "y"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("approval scan ignores stale Codex prompts left in terminal scrollback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-stale-approve-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, [
      "  Would you like to run the following command?",
      "",
      "  $ git status -sb",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "",
      "✔ You approved codex to run git status -sb",
      "• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
      "",
      "› Find and fix a bug in @filename"
    ].join("\n"));
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:tmux:codex-work:0.1:33389";
    const status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);
    assert.equal(statusParsed.terminal_status.approval_state.approvable, false);
    assert.match(statusParsed.terminal_status.approval_state.reason, /stale/);
    assert.equal(statusParsed.terminal_screen.approval.approvable, false);
    assert.equal(statusParsed.terminal_status.activity_state, "working");

    const approved = runAgentCli([
      "approve",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, false);
    assert.match(approvedParsed.reason, /stale/);
    assert.deepEqual(readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys"), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status detects tmux Codex working idle and unknown activity states", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-activity-state-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const conversationId = "terminal:tmux:codex-work:0.1:33389";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    fs.writeFileSync(screenPath, [
      "• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
      "",
      "› Find and fix a bug in @filename"
    ].join("\n"));
    let status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    let statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "working");
    assert.match(statusParsed.terminal_status.activity_reason, /Working/);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);

    fs.writeFileSync(screenPath, [
      "• Waiting for background terminal · autoreview",
      "  3 background terminals running · /ps to view · /stop to close",
      "",
      "› Steer the current task"
    ].join("\n"));
    status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "working");
    assert.match(statusParsed.terminal_status.activity_reason, /Waiting for background terminal/);

    fs.writeFileSync(screenPath, [
      "The words background terminal running are part of the final answer.",
      "Working is also ordinary prose here, without a Codex status-line shape.",
      "",
      "› "
    ].join("\n"));
    status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "idle");

    fs.writeFileSync(screenPath, [
      "  Model: GPT-5",
      "",
      "› "
    ].join("\n"));
    status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "idle");
    assert.match(statusParsed.terminal_status.activity_reason, /input prompt/);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);

    fs.writeFileSync(screenPath, [
      "last command output",
      "no recognizable Codex tui footer"
    ].join("\n"));
    status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "unknown");
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("approve supports terminal-controlled conversation ids without AKK state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-approve-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, [
      "  Would you like to run the following command?",
      "",
      "  $ ls -la",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)"
    ].join("\n"));
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:tmux:codex-work:0.1:33389";
    const status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.conversation_id, conversationId);
    assert.equal(statusParsed.source, "terminal_control");
    assert.equal(statusParsed.terminal_status.reachable, true);
    assert.equal(statusParsed.terminal_status.approval_state.approvable, true);

    const approved = runAgentCli([
      "approve",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.conversation_id, conversationId);
    assert.equal(approvedParsed.source, "terminal_control");
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.key, "y");
    assert.equal(approvedParsed.terminal_control.target, "codex-work:0.1");

    const calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "y"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("send and cancel support terminal-controlled conversation ids without AKK state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-send-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "Codex is ready\n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:tmux:codex-work:0.1:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      conversationId,
      "--message",
      "你好\n"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.conversation_id, conversationId);
    assert.equal(sentParsed.source, "terminal_control");
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.status, "async_pending");
    assert.equal(sentParsed.background, true);
    assert.equal(sentParsed.callback_expected, false);
    assert.equal(sentParsed.openclaw_next_action.action, "yield");
    assert.equal(sentParsed.openclaw_next_action.callback_expected, false);
    assert.equal(sentParsed.terminal_control.target, "codex-work:0.1");

    const calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-2).args, ["send-keys", "-t", "codex-work:0.1", "-l", "你好"]);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "C-m"]);

    const cancelled = runAgentCli([
      "cancel",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    const cancelledParsed = JSON.parse(cancelled.stdout);
    assert.equal(cancelledParsed.conversation_id, conversationId);
    assert.equal(cancelledParsed.source, "terminal_control");
    assert.equal(cancelledParsed.cancel_requested, true);
    assert.equal(cancelledParsed.key, "C-c");

    const callsAfterCancel = readJsonLines(tmuxCallsPath);
    assert.deepEqual(callsAfterCancel.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "C-c"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("background send to raw terminal id creates managed callback conversation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-background-send-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "Codex is ready\n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
    const rejected = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Do not send this",
      "--background",
      "--store-dir",
      storeDir,
      "--agent-hard-timeout-minutes",
      "0"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /must be a positive number/);
    assert.equal(fs.existsSync(tmuxCallsPath), false);

    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "查一下最新 tag",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.status, "async_pending");
    assert.equal(sentParsed.background, true);
    assert.equal(sentParsed.callback_expected, true);
    assert.equal(sentParsed.openclaw_next_action.action, "yield");
    assert.equal(sentParsed.openclaw_next_action.callback_expected, true);
    assert.notEqual(sentParsed.conversation.conversation_id, rawConversationId);
    assert.equal(sentParsed.conversation.openclaw_session, "agent:channel:original");
    assert.equal(sentParsed.conversation.gateway_session, "agent:channel:original");
    assert.equal(sentParsed.conversation.native_session_takeover.native_session_id, rawConversationId);
    assert.equal(sentParsed.conversation.native_session_takeover.needs_bootstrap, false);
    assert.equal(sentParsed.conversation.native_session_takeover.terminal_bridge, true);
    assert.equal(sentParsed.monitor_pid, null);

    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.conversation_id, sentParsed.conversation.conversation_id);
    assert.equal(typeof state.native_session_takeover.terminal_bridge_started_at, "string");
    assert.equal(state.native_session_takeover.terminal_bridge_message_id, sentParsed.message.id);

    const calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "C-m"]);
    assert.deepEqual(calls.at(-2).args.slice(0, 4), ["send-keys", "-t", "codex-work:0.1", "-l"]);
    const injectedPayload = calls.at(-2).args[4];
    assert.equal(injectedPayload, "查一下最新 tag");
    assert.doesNotMatch(injectedPayload, /callback --state/);
    assert.doesNotMatch(injectedPayload, /agent-knock-knock\.callback/);
    assert.doesNotMatch(injectedPayload, /[\r\n]$/u);

    const idleState = {
      ...state,
      status: "idle",
      idle_since: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(idleState, null, 2)}\n`);

    const listed = runAgentCli([
      "list",
      "--store-dir",
      storeDir,
      "--managed-only"
    ]);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedParsed = JSON.parse(listed.stdout);
    assert.equal(listedParsed.cleanup.closed, 1);
    assert.deepEqual(listedParsed.delegated, []);
    const closedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(closedState.status, "closed");
    assert.equal(closedState.close_reason, "terminal bridge task completed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a newer raw terminal task supersedes the prior screen-only callback boundary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-supersede-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const rawConversationId = "terminal:tmux:codex-work:0.1:33389";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sendTask = (message: string) => runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    const first = sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = path.join(storeDir, firstParsed.conversation.conversation_id, "state.json");
    const firstLogPath = path.join(storeDir, firstParsed.conversation.conversation_id, "events.ndjson");

    const second = sendTask("Second task");
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondParsed = JSON.parse(second.stdout);
    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.status, "closed");
    assert.equal(firstState.superseded_by_conversation_id, secondParsed.conversation.conversation_id);
    assert.match(firstState.close_reason, /superseded by a newer task/);
    assert.match(fs.readFileSync(firstLogPath, "utf8"), /terminal_bridge_superseded/);

    fs.writeFileSync(screenPath, [
      "› First task",
      "The first result completed earlier.",
      "─ Worked for 1m ─────────────────────────────",
      "› Second task",
      "• Working (5s • esc to interrupt) · /stop to close"
    ].join("\n"));
    const oldMonitor = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      firstStatePath,
      "--log",
      firstLogPath,
      "--poll-interval-ms",
      "50",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": fs.readFileSync(screenPath, "utf8") })
    ]);
    assert.equal(oldMonitor.status, 0, oldMonitor.stderr || oldMonitor.stdout);
    const oldMonitorParsed = JSON.parse(oldMonitor.stdout);
    assert.equal(oldMonitorParsed.completed, false);
    assert.equal(oldMonitorParsed.reason, "conversation_no_longer_waiting");
    assert.equal(fs.existsSync(openclawCallsPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a failed replacement send keeps the prior terminal bridge active", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-send-failure-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-send-failure-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const listPanesOutput = `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`;
    writeFakeTmux(fakeBinDir, tmuxCallsPath, undefined, listPanesOutput);

    const sendTask = (message: string) => runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    const first = sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = path.join(storeDir, firstParsed.conversation.conversation_id, "state.json");
    const firstLogPath = path.join(storeDir, firstParsed.conversation.conversation_id, "events.ndjson");

    writeFakeTmux(fakeBinDir, tmuxCallsPath, undefined, listPanesOutput, "Second task");
    const second = sendTask("Second task");
    assert.notEqual(second.status, 0);

    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.status, "waiting_for_agent");
    assert.equal(firstState.superseded_by_conversation_id, undefined);
    assert.doesNotMatch(fs.readFileSync(firstLogPath, "utf8"), /terminal_bridge_superseded/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("concurrent raw terminal sends serialize replacement state and terminal submission", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-concurrent-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-concurrent-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      undefined,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const sendArgs = (message: string) => [
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ];
    const env = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_TMUX_SEND_DELAY_MS: "300"
    };

    const [first, second] = await Promise.all([
      runAgentCliAsync(sendArgs("Concurrent task A"), env),
      runAgentCliAsync(sendArgs("Concurrent task B"), env)
    ]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);

    const states = fs.readdirSync(storeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => JSON.parse(fs.readFileSync(path.join(storeDir, entry.name, "state.json"), "utf8")));
    const active = states.filter((state) => state.status === "waiting_for_agent");
    const closed = states.filter((state) => state.status === "closed");
    assert.equal(active.length, 1);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].superseded_by_conversation_id, active[0].conversation_id);

    const calls = readJsonLines(tmuxCallsPath);
    const literalSendIndexes = calls
      .map((call, index) => call.args.includes("-l") ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(literalSendIndexes.length, 2);
    const firstEnterIndex = calls.findIndex(
      (call, index) => index > literalSendIndexes[0] && call.args.at(-1) === "C-m"
    );
    assert.ok(firstEnterIndex > literalSendIndexes[0]);
    assert.ok(firstEnterIndex < literalSendIndexes[1]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor trusts matching task_complete despite stale working screen text", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-monitor-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "Codex is ready\n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "查一下最新 tag",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const logPath = path.join(storeDir, sentParsed.conversation.conversation_id, "events.ndjson");

    const rollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "查一下最新 tag"
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "最新 tag 是 v0.2.29。The words background terminal running are only part of this final answer."
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-current-task",
          last_agent_message: "最新 tag 是 v0.2.29。The words background terminal running are only part of this final answer."
        }
      })
    ].join("\n");

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace, updated_at_ms: Date.parse("2099-07-04T00:01:00.000Z") })]),
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        pane: 1,
        panePid: 999,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.1": [
          "最新 tag 是 v0.2.29。",
          "The words background terminal running are only part of this final answer.",
          "• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
          "› Steer the current task"
        ].join("\n")
      }),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout })
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.message.type, "done");
    assert.equal(
      parsed.message.body,
      "最新 tag 是 v0.2.29。The words background terminal running are only part of this final answer."
    );
    assert.equal(parsed.message.metadata.match, "rollout_task_complete");
    assert.equal(parsed.message.metadata.rollout_turn_id, "turn-current-task");
    assert.equal(parsed.conversation.status, "closed");
    assert.equal(parsed.conversation.close_reason, "terminal bridge task completed");

    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_completion_detected/);
    assert.match(events, /callback_gateway_method_delivery/);
    const openclawCalls = readJsonLines(openclawCallsPath);
    assert.deepEqual(openclawCalls[0].args.slice(0, 3), ["gateway", "call", "agent-knock-knock.callback"]);
    assert.equal(openclawCalls[0].args.includes("--url"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor rejects task_complete for a different request boundary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-progress-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "• Waited for background terminal · git merge --ff-only origin/main\n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Pull main and inspect the changes",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const logPath = path.join(storeDir, sentParsed.conversation.conversation_id, "events.ndjson");
    const rollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "A different task in the reused Codex session" }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "The different task is complete."
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-different-task",
          last_agent_message: "The different task is complete."
        }
      })
    ].join("\n");

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "0.001",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace, updated_at_ms: Date.parse("2099-07-04T00:01:00.000Z") })]),
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        pane: 1,
        panePid: 999,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.1": "• Waited for background terminal · git merge --ff-only origin/main\n"
      }),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout })
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.stalled, true);
    assert.match(parsed.reason, /observed no activity/);
    const events = fs.readFileSync(logPath, "utf8");
    assert.doesNotMatch(events, /terminal_bridge_completion_detected/);
    const openclawCalls = readJsonLines(openclawCallsPath);
    const callbackParamsIndex = openclawCalls[0].args.indexOf("--params");
    assert.notEqual(callbackParamsIndex, -1);
    const callbackParams = JSON.parse(openclawCalls[0].args[callbackParamsIndex + 1]);
    assert.equal(callbackParams.message.type, "error");
    assert.notEqual(callbackParams.message.type, "done");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge working markers extend inactivity until the hard lifetime", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-activity-timeout-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const workingScreen = [
    "• Waiting for background terminal · autoreview",
    "  3 background terminals running · /ps to view · /stop to close",
    "",
    "› Steer the current task"
  ].join("\n");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, workingScreen);
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Run all review passes",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--agent-timeout-minutes",
      "0.001",
      "--agent-hard-timeout-minutes",
      "0.004",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const logPath = path.join(storeDir, sentParsed.conversation.conversation_id, "events.ndjson");
    const startedAt = JSON.parse(fs.readFileSync(statePath, "utf8"))
      .native_session_takeover.terminal_bridge_started_at;

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "0.001",
      "--agent-hard-timeout-minutes",
      "0.004",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        session: "codex-work",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": workingScreen })
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.stalled, true);
    assert.equal(parsed.hard_timeout, true);
    assert.match(parsed.reason, /hard lifetime/);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.status, "stalled");
    assert.ok(
      Date.parse(state.native_session_takeover.terminal_bridge_last_activity_at) > Date.parse(startedAt)
    );
    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_activity_observed/);
    assert.match(events, /terminal_bridge_inactivity_deadline_extended/);
    assert.match(events, /terminal_bridge_hard_timeout_reached/);
    assert.doesNotMatch(parsed.reason, /no activity/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("renew restarts a stalled terminal bridge without input and completion callbacks once", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-renew-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Finish the long task",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--agent-hard-timeout-minutes",
      "60",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversationId = sentParsed.conversation.conversation_id;
    const statePath = path.join(storeDir, conversationId, "state.json");
    const logPath = path.join(storeDir, conversationId, "events.ndjson");
    const waitingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(statePath, `${JSON.stringify({
      ...waitingState,
      status: "stalled",
      stalled_at: new Date().toISOString(),
      stalled_reason: "test inactivity timeout",
      stalled_notification_sent_at: new Date().toISOString(),
      stalled_notification_message_id: "msg-stalled"
    }, null, 2)}\n`);

    const missingTerminal = runAgentCli([
      "renew",
      "--state",
      statePath,
      "--minutes",
      "5",
      "--terminals-json",
      "[]",
      "--disable-terminal-bridge-monitor"
    ]);
    assert.equal(missingTerminal.status, 1);
    assert.match(missingTerminal.stderr, /no longer available/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).status, "stalled");

    const sendKeyCountBeforeRenew = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const renewed = runAgentCli([
      "renew",
      "--state",
      statePath,
      "--minutes",
      "5",
      "--agent-hard-timeout-minutes",
      "120",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(renewed.status, 0, renewed.stderr || renewed.stdout);
    const renewedParsed = JSON.parse(renewed.stdout);
    assert.equal(renewedParsed.renewed, true);
    assert.equal(renewedParsed.agent_timeout_minutes, 5);
    assert.equal(renewedParsed.agent_hard_timeout_minutes, 60);
    assert.equal(renewedParsed.monitor_pid, null);
    assert.equal(renewedParsed.conversation.status, "waiting_for_agent");
    assert.equal(renewedParsed.conversation.stalled_reason, undefined);
    const sendKeyCountAfterRenew = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    assert.equal(sendKeyCountAfterRenew, sendKeyCountBeforeRenew);

    const rollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Finish the long task" }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "The long task is complete." }
      })
    ].join("\n");
    const monitorArgs = [
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "5",
      "--agent-hard-timeout-minutes",
      "60",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace, updated_at_ms: Date.parse("2099-07-04T00:01:00.000Z") })]),
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        session: "codex-work",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": "› \n" }),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout })
    ];
    const monitored = runAgentCli(monitorArgs);
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.message.body, "The long task is complete.");
    assert.equal(monitoredParsed.conversation.status, "closed");

    const monitoredAgain = runAgentCli(monitorArgs);
    assert.equal(monitoredAgain.status, 0, monitoredAgain.stderr || monitoredAgain.stdout);
    assert.equal(JSON.parse(monitoredAgain.stdout).reason, "conversation_no_longer_waiting");
    assert.equal(readJsonLines(openclawCallsPath).length, 1);
    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_renewed/);
    assert.match(events, /terminal_bridge_completion_detected/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor callbacks when the completed prompt has scrolled out of the screen excerpt", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-screen-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const request = "git pull 完后看一下最近的 commits，告诉我都更新了哪些特性";
    fs.writeFileSync(screenPath, "Codex is ready\n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `my-work\t0\t0\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:my-work:0.0:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      request,
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const logPath = path.join(storeDir, sentParsed.conversation.conversation_id, "events.ndjson");
    assert.equal(
      typeof sentParsed.conversation.native_session_takeover.terminal_bridge_pre_send_screen_fingerprint,
      "string"
    );

    fs.writeFileSync(screenPath, [
      "  这次 pull 实际只更新了 1 个 commit：",
      "",
      "  71afa78 fix(daemon): stop logging client disconnects as connection errors (#328)",
      "",
      "  更新内容：",
      "  - 新增 is_client_disconnect() 识别客户端主动断开连接",
      "  - daemon 不再把 BrokenPipe/ConnectionReset 等正常断连记录为服务端错误",
      "",
      "─ Worked for 4m 48s ───────────────────────────────────────────────",
      "",
      "› Find and fix a bug in @filename",
      "",
      "  gpt-5.6-sol high · ~/github/coven"
    ].join("\n"));

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "my-work:0.0",
        session: "my-work",
        window: 0,
        pane: 0,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "my-work:0.0": fs.readFileSync(screenPath, "utf8")
      })
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.message.type, "done");
    assert.match(parsed.message.body, /这次 pull 实际只更新了 1 个 commit/);
    assert.doesNotMatch(parsed.message.body, /Worked for|Find and fix|gpt-5\.6/);
    assert.equal(parsed.message.metadata.confidence, "screen_only");
    assert.equal(parsed.conversation.status, "closed");
    assert.equal(parsed.conversation.close_reason, "terminal bridge task completed");

    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_completion_detected/);
    assert.match(events, /"match":"terminal_screen"/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor callbacks for Codex approval and approve resumes waiting", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-approval-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const approvalScreen = [
      "  Would you like to run the following command?",
      "",
      "  $ npm install",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel"
    ].join("\n");
    fs.writeFileSync(screenPath, approvalScreen);
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Install dependencies if needed",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversationId = sentParsed.conversation.conversation_id;
    const statePath = path.join(storeDir, conversationId, "state.json");
    const logPath = path.join(storeDir, conversationId, "events.ndjson");

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        session: "codex-work",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.1": approvalScreen
      })
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.message.type, "question");
    assert.equal(monitoredParsed.message.metadata.reason, "approval_required");
    assert.deepEqual(monitoredParsed.message.metadata.approval_candidate, {
      agent: "codex",
      kind: "run_command",
      command: "npm install",
      cwd: workspace,
      fingerprint: monitoredParsed.message.metadata.approval_fingerprint,
      terminal_target: "codex-work:0.1"
    });
    assert.match(monitoredParsed.message.body, new RegExp(`AKK approve ${conversationId}`));
    assert.match(monitoredParsed.message.body, new RegExp(`AKK cancel ${conversationId}`));
    assert.match(monitoredParsed.message.body, /agent_knock_knock_approve/);
    assert.match(monitoredParsed.message.body, /agent_knock_knock_cancel/);
    assert.match(monitoredParsed.message.body, /\$ npm install/);
    assert.equal(monitoredParsed.conversation.status, "waiting_for_openclaw");

    const openclawCalls = readJsonLines(openclawCallsPath);
    const paramsIndex = openclawCalls[0].args.indexOf("--params");
    assert.notEqual(paramsIndex, -1);
    const gatewayParams = JSON.parse(openclawCalls[0].args[paramsIndex + 1]);
    assert.equal(gatewayParams.message.type, "question");
    assert.equal(gatewayParams.message.metadata.approve_command, `AKK approve ${conversationId}`);
    assert.equal(gatewayParams.message.metadata.deny_command, `AKK cancel ${conversationId}`);
    assert.equal(gatewayParams.message.metadata.approval_candidate.command, "npm install");

    const fingerprintMismatch = runAgentCli([
      "approve",
      "--state",
      statePath,
      "--expected-approval-fingerprint",
      "different-fingerprint",
      "--auto-approved",
      "--policy-rule-id",
      "test-rule",
      "--policy-fingerprint",
      "policy-123",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(fingerprintMismatch.status, 0, fingerprintMismatch.stderr || fingerprintMismatch.stdout);
    const mismatchParsed = JSON.parse(fingerprintMismatch.stdout);
    assert.equal(mismatchParsed.approved, false);
    assert.match(mismatchParsed.reason, /fingerprint changed/);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys" && call.args.at(-1) === "y"),
      false
    );

    const approved = runAgentCli([
      "approve",
      "--state",
      statePath,
      "--expected-approval-fingerprint",
      monitoredParsed.message.metadata.approval_fingerprint,
      "--auto-approved",
      "--policy-rule-id",
      "test-rule",
      "--policy-fingerprint",
      "policy-123",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.key, "y");
    assert.equal(approvedParsed.auto_approved, true);
    assert.equal(approvedParsed.policy_rule_id, "test-rule");
    assert.equal(approvedParsed.conversation.status, "waiting_for_agent");
    assert.equal(approvedParsed.conversation.native_session_takeover.terminal_bridge_approval, undefined);
    const calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "y"]);

    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_approval_detected/);
    assert.match(events, /terminal_bridge_approval_notification_recorded/);
    assert.match(events, /terminal_auto_approval_decision/);
    assert.match(events, /"action":"rejected"/);
    assert.match(events, /"action":"approved"/);
    assert.match(events, /callback_gateway_method_delivery/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal-controlled conversation ids use Codex pid, not tmux pane pid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-pid-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "Codex is ready\n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t0\t999\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:tmux:codex-work:0.0:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      conversationId,
      "--message",
      "继续",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "node /Users/scotthuang/.npm-global/bin/codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.0",
        panePid: 999,
        currentPath: workspace
      })])
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.conversation_id, conversationId);
    assert.equal(sentParsed.terminal_control.panePid, 999);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test("agent takeover terminate_then_resume returns a confirmation plan for an exact active session", () => {
  const result = runAgentCli([
    "agent",
    "takeover",
    "--agent",
    "codex",
    "--session-id",
    sessionId,
    "--strategy",
    "terminate_then_resume",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--processes-json",
    JSON.stringify([{
      pid: 2000,
      ppid: 1,
      command: `codex resume ${sessionId}`,
      cwd
    }])
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "requires_confirmation");
  assert.equal(parsed.sideEffectsExecuted, false);
  assert.equal(parsed.plan.mode, "takeover");
  assert.equal(parsed.plan.targets[0].pid, 2000);
  assert.equal(parsed.plan.resumeAfterExit.sessionId, sessionId);
});

test("agent takeover terminate_then_resume requires explicit pid confirmation before terminating", () => {
  const result = runAgentCli([
    "agent",
    "takeover",
    "--agent",
    "codex",
    "--session-id",
    sessionId,
    "--strategy",
    "terminate_then_resume",
    "--create-conversation",
    "--confirm-terminate",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--processes-json",
    JSON.stringify([{
      pid: 2000,
      ppid: 1,
      command: `codex resume ${sessionId}`,
      cwd
    }])
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--expected-pid is required/);
});

test("agent takeover terminate_then_resume can terminate a confirmed process and attach a conversation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-terminate-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const child = spawn("/bin/sleep", ["60"], {
    stdio: "ignore",
    detached: false
  });

  try {
    assert.ok(child.pid);
    const result = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminate_then_resume",
      "--create-conversation",
      "--confirm-terminate",
      "--expected-pid",
      String(child.pid),
      "--terminate-timeout-ms",
      "50",
      "--request",
      "Take over active terminal Codex",
      "--store-dir",
      storeDir,
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: nativeModelRollout() }),
      "--processes-json",
      JSON.stringify([[{
        pid: child.pid,
        ppid: 1,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }], []])
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "attached", result.stdout);
    assert.equal(parsed.sideEffectsExecuted, true);
    assert.equal(parsed.termination.target.pid, child.pid);
    assert.equal(parsed.termination.signals[0].status, "sent");
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(parsed.conversation.executor.session, sessionId);
    assert.equal(parsed.conversation.native_session_takeover.strategy, "terminate_then_resume");
    assert.equal(parsed.conversation.native_session_takeover.needs_bootstrap, true);
  } finally {
    try {
      if (child.pid) {
        process.kill(child.pid, "SIGKILL");
      }
    } catch {
      // Already terminated by the command under test.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent takeover terminate_then_resume can explicitly accept a cwd-only confirmed pid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-cwd-only-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const child = spawn("/bin/sleep", ["60"], {
    stdio: "ignore",
    detached: false
  });

  try {
    assert.ok(child.pid);
    const result = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminate_then_resume",
      "--create-conversation",
      "--confirm-terminate",
      "--allow-cwd-only",
      "--expected-pid",
      String(child.pid),
      "--terminate-timeout-ms",
      "50",
      "--request",
      "Take over cwd-only terminal Codex",
      "--store-dir",
      storeDir,
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: nativeModelRollout() }),
      "--processes-json",
      JSON.stringify([[{
        pid: child.pid,
        ppid: 1,
        command: "codex",
        cwd: workspace
      }], []])
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "attached", result.stdout);
    assert.equal(parsed.matchKind, "cwd_only_confirmed");
    assert.equal(parsed.conversation.native_session_takeover.takeover_match_kind, "cwd_only_confirmed");
    assert.equal(parsed.conversation.native_session_takeover.needs_bootstrap, true);
  } finally {
    try {
      if (child.pid) {
        process.kill(child.pid, "SIGKILL");
      }
    } catch {
      // Already terminated by the command under test.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent takeover fork returns bounded context for OpenClaw summary confirmation", () => {
  const rollout = [
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "review this branch" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "I found one issue." } }),
    JSON.stringify({ type: "response_item", payload: { command: "git status", cwd, status: "0" } })
  ].join("\n");
  const result = runAgentCli([
    "agent",
    "takeover",
    "--agent",
    "codex",
    "--session-id",
    sessionId,
    "--strategy",
    "fork",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--rollouts-json",
    JSON.stringify({ [rolloutPath]: rollout })
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "awaiting_openclaw_summary");
  assert.equal(parsed.sideEffectsExecuted, false);
  assert.equal(parsed.plan.mode, "fork");
  assert.equal(parsed.plan.requiresOpenClawSummary, true);
  assert.equal(parsed.plan.contextPackage.source.sessionId, sessionId);
  assert.equal(parsed.plan.contextPackage.messages.length, 2);
  assert.match(parsed.summaryPrompt, /Produce a concise, user-reviewable summary/);
  assert.match(parsed.summaryPrompt, /do not pass raw rollout history/);
  assert.equal(parsed.nextAction.action, "summarize_and_confirm_fork");
  assert.equal(parsed.nextAction.followUpTool, "agent_knock_knock_agent_takeover");
  assert.deepEqual(parsed.nextAction.followUpParams, {
    agent: "codex",
    sessionId,
    strategy: "fork",
    createConversation: true,
    forkSummary: "<confirmed OpenClaw summary>"
  });
});

test("agent takeover fork can create a new AKK conversation from approved summary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-fork-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const acpxCallsPath = path.join(tempDir, "acpx-calls.ndjson");
  const rollout = [
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "raw private source context" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "raw assistant context" } }),
    nativeModelRollout()
  ].join("\n");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const fakeAcpx = path.join(fakeBinDir, "acpx");
    fs.writeFileSync(
      fakeAcpx,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify({
  args: process.argv.slice(2)
}) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const forked = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "fork",
      "--create-conversation",
      "--request",
      "Fork my terminal Codex session",
      "--fork-summary",
      "Approved summary: inspect the ACPX branch and continue carefully.",
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:main:wechat",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout }),
      "--processes-json",
      JSON.stringify([{
        pid: 2000,
        ppid: 1,
        command: "codex",
        cwd: workspace
      }])
    ]);

    assert.equal(forked.status, 0, forked.stderr || forked.stdout);
    const parsed = JSON.parse(forked.stdout);
    assert.equal(parsed.status, "forked");
    assert.equal(parsed.sideEffectsExecuted, true);
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(parsed.conversation.executor.kind, "codex");
    assert.notEqual(parsed.conversation.executor.session, sessionId);
    assert.match(parsed.conversation.executor.session, /^akk-codex-/);
    assert.equal(parsed.conversation.executor_model, "gpt-5.5[medium]");
    assert.equal(parsed.conversation.fork_context_takeover.source_session_id, sessionId);
    assert.equal(parsed.conversation.fork_context_takeover.summary, "Approved summary: inspect the ACPX branch and continue carefully.");
    assert.equal(parsed.conversation.fork_context_takeover.needs_bootstrap, true);

    const sent = runAgentCli([
      "send",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Start from the approved fork summary.",
      "--type",
      "task"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.conversation.fork_context_takeover.needs_bootstrap, false);

    const calls = fs.readFileSync(acpxCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls[0].args, [...CODEX_ACPX_SELECTOR, "sessions", "ensure", "--name", parsed.conversation.executor.session]);
    assert.deepEqual(calls[1].args.slice(0, 7), ["--approve-all", "--model", "gpt-5.5[medium]", ...CODEX_ACPX_SELECTOR, "prompt", "-s"]);
    assert.equal(calls[1].args[7], parsed.conversation.executor.session);
    assert.match(calls[1].args[8], /This AKK conversation is a fork/);
    assert.match(calls[1].args[8], /Approved summary: inspect the ACPX branch/);
    assert.doesNotMatch(calls[1].args[8], /raw private source context/);
    assert.doesNotMatch(calls[1].args[8], /--resume-session/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("describe terminal-controlled Codex session from rollout history", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Add AKK describe command"
      }
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I am wiring the OpenClaw tool."
      }
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:02:00.000Z",
      type: "response_item",
      payload: {
        command: "npm test",
        status: "completed"
      }
    })
  ].join("\n");

  const described = runAgentCli([
    "describe",
    "--conversation",
    "terminal:tmux:codex-work:0.0:33389",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--processes-json",
    JSON.stringify([{
      pid: 33389,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd
    }]),
    "--terminals-json",
    JSON.stringify([tmuxPane()]),
    "--terminal-screens-json",
    JSON.stringify({
      "codex-work:0.0": "Working\n"
    }),
    "--rollouts-json",
    JSON.stringify({ [rolloutPath]: rollout })
  ]);

  assert.equal(described.status, 0, described.stderr || described.stdout);
  const parsed = JSON.parse(described.stdout);
  assert.equal(parsed.source, "terminal_control");
  assert.equal(parsed.confidence, "high");
  assert.equal(parsed.match, "session_id");
  assert.match(parsed.about, /Add AKK describe command/);
  assert.match(parsed.about, /OpenClaw tool/);
  assert.equal(parsed.evidence.initial_request, "Add AKK describe command");
  assert.equal(parsed.evidence.recent_commands.at(-1).command, "npm test");
});

test("describe native Codex session falls back to cwd match", () => {
  const otherSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44f";
  const otherRolloutPath = "/tmp/other-codex-rollout.jsonl";
  const rollout = JSON.stringify({
    timestamp: "2026-07-04T00:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      message: "Most recent cwd task"
    }
  });

  const described = runAgentCli([
    "describe",
    "--conversation",
    "native:codex:4444",
    "--threads-json",
    JSON.stringify([
      threadRow({ updated_at_ms: 1000, title: "older task" }),
      {
        id: otherSessionId,
        cwd,
        rollout_path: otherRolloutPath,
        title: "newer task",
        updated_at_ms: 2000,
        archived: false
      }
    ]),
    "--processes-json",
    JSON.stringify([{
      pid: 4444,
      ppid: 1,
      command: "codex",
      cwd
    }]),
    "--rollouts-json",
    JSON.stringify({ [otherRolloutPath]: rollout })
  ]);

  assert.equal(described.status, 0, described.stderr || described.stdout);
  const parsed = JSON.parse(described.stdout);
  assert.equal(parsed.source, "native_active");
  assert.equal(parsed.confidence, "low");
  assert.equal(parsed.match, "cwd_latest");
  assert.match(parsed.about, /Most recent cwd task/);
  assert.equal(parsed.evidence.candidates.length, 2);
  assert.match(parsed.limitations[0], /most recent of 2 sessions/);
});

test("describe prefers Codex title over injected environment context", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "<environment_context> <cwd>/repo/project</cwd> </environment_context>"
      }
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I checked the README and summarized the project."
      }
    })
  ].join("\n");

  const described = runAgentCli([
    "describe",
    "--conversation",
    "terminal:tmux:codex-work:0.0:33389",
    "--threads-json",
    JSON.stringify([threadRow({ title: "Read the README and explain this project" })]),
    "--processes-json",
    JSON.stringify([{
      pid: 33389,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd
    }]),
    "--terminals-json",
    JSON.stringify([tmuxPane()]),
    "--terminal-screens-json",
    JSON.stringify({
      "codex-work:0.0": "Codex is ready\n"
    }),
    "--rollouts-json",
    JSON.stringify({ [rolloutPath]: rollout })
  ]);

  assert.equal(described.status, 0, described.stderr || described.stdout);
  const parsed = JSON.parse(described.stdout);
  assert.equal(parsed.evidence.initial_request, "Read the README and explain this project");
  assert.match(parsed.about, /Read the README and explain this project/);
  assert.doesNotMatch(parsed.about, /environment_context/);
  assert.equal(parsed.evidence.recent_messages.some((message) => message.text.includes("environment_context")), false);
});

function runAgentCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

function runAgentCliAsync(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: {
        ...process.env,
        ...env
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    cwd,
    rollout_path: rolloutPath,
    title: "review current branch",
    updated_at_ms: 1000,
    archived: false,
    ...overrides
  };
}

function nativeModelRollout() {
  return JSON.stringify({
    timestamp: "2026-06-20T14:05:25.758Z",
    type: "turn_context",
    payload: {
      model: "gpt-5.5"
    }
  });
}

function tmuxPane(overrides: Record<string, unknown> = {}) {
  return {
    kind: "tmux",
    target: "codex-work:0.0",
    session: "codex-work",
    window: 0,
    pane: 0,
    panePid: 999,
    currentCommand: "node",
    currentPath: cwd,
    ...overrides
  };
}

function writeFakeTmux(
  fakeBinDir: string,
  callsPath: string,
  screenPath?: string,
  listPanesOutput = "",
  failSendText = ""
) {
  const fakeTmux = path.join(fakeBinDir, "tmux");
  fs.writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + "\\n", "utf8");
if (${JSON.stringify(failSendText)} && args.includes(${JSON.stringify(failSendText)})) {
  process.exit(1);
}
if (args[0] === "send-keys" && args.includes("-l")) {
  const delayMs = Number(process.env.AKK_TEST_TMUX_SEND_DELAY_MS || 0);
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}
if (args[0] === "capture-pane") {
  process.stdout.write(fs.existsSync(${JSON.stringify(screenPath ?? "")}) ? fs.readFileSync(${JSON.stringify(screenPath ?? "")}, "utf8") : "");
} else if (args[0] === "list-panes") {
  process.stdout.write(${JSON.stringify(listPanesOutput)});
}
`,
    "utf8"
  );
  fs.chmodSync(fakeTmux, 0o755);
}

function writeFakeOpenClaw(fakeBinDir: string, callsPath: string) {
  const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + "\\n", "utf8");
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeOpenClaw, 0o755);
  return fakeOpenClaw;
}

function readJsonLines(filePath: string) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
