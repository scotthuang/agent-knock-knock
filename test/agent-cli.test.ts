import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
