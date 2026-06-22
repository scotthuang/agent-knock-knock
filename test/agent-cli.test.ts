import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const sessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const cwd = "/repo/agent-knock-knock";
const rolloutPath = "/tmp/codex-rollout.jsonl";

test("agent discover lists Codex historical sessions from injected rows", () => {
  const result = runAgentCli([
    "agent",
    "discover",
    "--agent",
    "codex",
    "--scope",
    "sessions",
    "--threads-json",
    JSON.stringify([threadRow()])
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.agent, "codex");
  assert.equal(parsed.scope, "sessions");
  assert.equal(parsed.capabilities.historicalSessions, "full");
  assert.equal(parsed.capabilities.takeover, "plan_only");
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].id, sessionId);
  assert.equal(parsed.sessions[0].cwd, cwd);
});

test("agent discover lists active Codex CLI processes from injected process snapshots", () => {
  const result = runAgentCli([
    "agent",
    "discover",
    "--agent",
    "codex",
    "--scope",
    "active",
    "--processes-json",
    JSON.stringify([{
      pid: 1234,
      ppid: 1,
      elapsed: "00:12",
      command: `codex resume ${sessionId}`,
      cwd
    }])
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.scope, "active");
  assert.equal(parsed.active.length, 1);
  assert.equal(parsed.active[0].pid, 1234);
  assert.equal(parsed.active[0].sessionId, sessionId);
  assert.equal(parsed.active[0].kind, "codex_cli");
});

test("agent discover enriches active Codex processes with tmux terminal control", () => {
  const result = runAgentCli([
    "agent",
    "discover",
    "--agent",
    "codex",
    "--scope",
    "active",
    "--processes-json",
    JSON.stringify([{
      pid: 1234,
      ppid: 999,
      elapsed: "00:12",
      command: `codex resume ${sessionId}`,
      cwd
    }]),
    "--terminals-json",
    JSON.stringify([tmuxPane({ panePid: 999 })])
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.active[0].terminalControl.target, "codex-work:0.0");
  assert.deepEqual(parsed.active[0].terminalControl.capabilities, ["capture_screen", "send_keys", "terminal_approval"]);
});

test("agent takeover safe_resume is ready when no active CLI matches", () => {
  const result = runAgentCli([
    "agent",
    "takeover",
    "--agent",
    "codex",
    "--session-id",
    sessionId,
    "--strategy",
    "safe_resume",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--processes-json",
    "[]"
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.sideEffectsExecuted, false);
  assert.equal(parsed.plan.mode, "safe_resume");
  assert.equal(parsed.plan.resume.sessionId, sessionId);
});

test("agent takeover safe_resume can attach a native session as an AKK conversation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-attach-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const codexCallsPath = path.join(tempDir, "codex-calls.ndjson");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const fakeCodex = path.join(fakeBinDir, "codex");
    fs.writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(codexCallsPath)}, JSON.stringify({
  args: process.argv.slice(2),
  allProxy: process.env.ALL_PROXY
}) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeCodex, 0o755);

    const attached = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "safe_resume",
      "--create-conversation",
      "--request",
      "Continue my terminal Codex session",
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:main:wechat",
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:wechat",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: nativeModelRollout() }),
      "--processes-json",
      "[]"
    ]);

    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const parsed = JSON.parse(attached.stdout);
    assert.equal(parsed.status, "attached");
    assert.equal(parsed.sideEffectsExecuted, true);
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(parsed.conversation.executor.kind, "codex");
    assert.equal(parsed.conversation.executor.session, sessionId);
    assert.equal(parsed.conversation.executor_model, "gpt-5.5[medium]");
    assert.equal(parsed.conversation.native_session_takeover.needs_bootstrap, true);
    assert.equal(parsed.conversation.native_session_takeover.native_model, "gpt-5.5");
    assert.equal(parsed.conversation.native_session_takeover.acpx_model, "gpt-5.5[medium]");

    const sent = runAgentCli([
      "send",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "继续检查当前分支",
      "--type",
      "task"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.conversation.native_session_takeover.needs_bootstrap, false);

    const calls = fs.readFileSync(codexCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 6), ["exec", "resume", "--model", "gpt-5.5", "--skip-git-repo-check", sessionId]);
    assert.match(calls[0].args[6], /managed by OpenClaw/);
    assert.match(calls[0].args[6], /agent-knock-knock\.callback/);
    assert.match(calls[0].args[6], /Initial AKK takeover message/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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
    assert.equal(sentParsed.terminal_control.target, "codex-work:0.0");
    const calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-2).args, ["send-keys", "-t", "codex-work:0.0", "-l", "继续当前任务"]);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.0", "Enter"]);
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
    assert.equal(statusParsed.terminal_screen.approval.approvable, true);

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
    assert.deepEqual(calls[0].args, ["codex", "sessions", "ensure", "--name", parsed.conversation.executor.session]);
    assert.deepEqual(calls[1].args.slice(0, 6), ["--approve-all", "--model", "gpt-5.5[medium]", "codex", "-s", parsed.conversation.executor.session]);
    assert.match(calls[1].args[6], /This AKK conversation is a fork/);
    assert.match(calls[1].args[6], /Approved summary: inspect the ACPX branch/);
    assert.doesNotMatch(calls[1].args[6], /raw private source context/);
    assert.doesNotMatch(calls[1].args[6], /--resume-session/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

function writeFakeTmux(fakeBinDir: string, callsPath: string, screenPath?: string) {
  const fakeTmux = path.join(fakeBinDir, "tmux");
  fs.writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + "\\n", "utf8");
if (args[0] === "capture-pane") {
  process.stdout.write(fs.existsSync(${JSON.stringify(screenPath ?? "")}) ? fs.readFileSync(${JSON.stringify(screenPath ?? "")}, "utf8") : "");
}
`,
    "utf8"
  );
  fs.chmodSync(fakeTmux, 0o755);
}

function readJsonLines(filePath: string) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
