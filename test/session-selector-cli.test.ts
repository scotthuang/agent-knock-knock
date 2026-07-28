import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyMessageToConversation,
  createConversation,
  createMessage,
  type ExecutorKind
} from "../src/protocol.js";
import {
  appendEvent,
  messageEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-selector-cli-runtime-")
);
process.env.AKK_RUNTIME_DIR = testRuntimeDir;
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
});

test("CLI omission and short refs resolve one actionable managed session", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-only-"));

  try {
    const created = storeConversationFixture({
      storeDir,
      request: "Review the selector",
      agent: "codex"
    });
    const listed = runCli(["list", "--managed-only", "--store-dir", storeDir]);
    assert.equal(listed.delegated.length, 1);
    assert.match(listed.delegated[0].short_ref, /^@[0-9a-f]{10}$/u);
    assert.equal(
      listed.delegated[0].conversation_id,
      created.conversation.conversation_id
    );

    const implicit = runCli(["status", "--managed-only", "--store-dir", storeDir]);
    assert.equal(
      implicit.summary.conversation_id,
      created.conversation.conversation_id
    );

    const short = runCli([
      "status",
      "--conversation",
      listed.delegated[0].short_ref,
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(
      short.summary.conversation_id,
      created.conversation.conversation_id
    );
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("CLI latest is deterministic and omission fails closed on ambiguity", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-latest-"));

  try {
    const older = storeConversationFixture({
      storeDir,
      request: "Older task",
      agent: "claude"
    });
    const newer = storeConversationFixture({
      storeDir,
      request: "Newer task",
      agent: "codex"
    });
    updateTimestamp(older.conversation.state_path, "2026-07-28T01:00:00.000Z");
    updateTimestamp(newer.conversation.state_path, "2026-07-28T02:00:00.000Z");

    const latest = runCli([
      "status",
      "--conversation",
      "latest",
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(
      latest.summary.conversation_id,
      newer.conversation.conversation_id
    );

    const ambiguous = spawnCli([
      "status",
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /omitted session selector is ambiguous/u);
    assert.match(ambiguous.stderr, /@[\da-f]{10}/u);
    assert.match(ambiguous.stderr, /Older task/u);
    assert.match(ambiguous.stderr, /Newer task/u);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("CLI only prefers an active managed terminal bridge over its raw tmux pane", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-managed-pane-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-managed:0.0";
  const codexPid = 2222;
  const runtimeArgs = codexTerminalStaticArgs({
    workspace,
    terminalTarget,
    codexPid,
    screen: "› Ready for the next task"
  });

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const sent = runCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${terminalTarget}:${codexPid}`,
      "--message",
      "Continue the managed task",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:selector",
      "--openclaw-session",
      "agent:test:selector",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      ...runtimeArgs
    ]);
    const managedId = sent.conversation.conversation_id;
    assert.notEqual(managedId, sent.conversation.native_session_takeover.native_session_id);

    const status = runCli([
      "status",
      "--conversation",
      "only",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);

    assert.equal(status.summary.conversation_id, managedId);
    assert.equal(status.conversation.conversation_id, managedId);
    assert.equal(status.terminal_status.target, terminalTarget);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI approve only and short refs stay on the managed Claude approval path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-managed-approve-"));
  const storeDir = path.join(tempDir, "conversations");
  const claudeHome = path.join(tempDir, ".claude");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "claude-managed:0.0";
  const claudePid = 42300;
  const claudeSessionId = "44444444-4444-4444-8444-444444444444";
  const approvalScreen = [
    " Bash command",
    "",
    "   npm test",
    "",
    " This command requires approval",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No"
  ].join("\n");
  const sendRuntimeArgs = claudeTerminalStaticArgs({
    workspace,
    terminalTarget,
    claudePid,
    claudeSessionId,
    screen: "❯ "
  });
  const approvalRuntimeArgs = claudeTerminalStaticArgs({
    workspace,
    terminalTarget,
    claudePid,
    claudeSessionId,
    screen: approvalScreen
  });

  try {
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    const sent = runCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:claude:${terminalTarget}:${claudePid}`,
      "--message",
      "Run the focused tests",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:selector",
      "--openclaw-session",
      "agent:test:selector",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      "--claude-home",
      claudeHome,
      ...sendRuntimeArgs
    ]);
    const managedId = sent.conversation.conversation_id;
    const listed = runCli([
      "list",
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(listed.delegated.length, 1);
    assert.equal(listed.delegated[0].conversation_id, managedId);

    for (const selector of ["only", listed.delegated[0].short_ref]) {
      const approved = runCli([
        "approve",
        "--conversation",
        selector,
        "--store-dir",
        storeDir,
        "--disable-terminal-bridge-monitor",
        "--claude-home",
        claudeHome,
        ...approvalRuntimeArgs
      ]);

      assert.equal(approved.conversation.conversation_id, managedId, selector);
      assert.equal(approved.approved, false, selector);
      assert.equal(approved.blocked, true, selector);
      assert.match(
        approved.reason,
        /current managed-turn approval notification/u,
        selector
      );
      assert.doesNotMatch(approved.reason, /send --background/u, selector);
      assert.equal(approved.source, undefined, selector);
      assert.equal(approved.conversation_id, undefined, selector);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function updateTimestamp(statePath: string, timestamp: string): void {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.updated_at = timestamp;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function storeConversationFixture(options: {
  storeDir: string;
  request: string;
  agent: ExecutorKind;
}) {
  const now = new Date("2026-07-28T00:00:00.000Z");
  const base = createConversation({
    userRequest: options.request,
    executorKind: options.agent,
    executorSession: `${options.agent}-selector`,
    now
  });
  const message = createMessage({
    conversation: base,
    from: "openclaw",
    to: base.executor.actor,
    type: "task",
    body: options.request,
    now
  });
  const paths = pathsForConversation(base.conversation_id, options.storeDir);
  const conversation = {
    ...applyMessageToConversation(base, message, now),
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
  saveState(paths.statePath, conversation);
  appendEvent(paths.logPath, {
    ts: now.toISOString(),
    conversation_id: conversation.conversation_id,
    event: "conversation_created",
    conversation
  });
  appendEvent(paths.logPath, messageEvent(message));
  return { conversation, paths };
}

function runCli(args: string[]): Record<string, any> {
  const result = spawnCli(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function spawnCli(args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8"
  });
}

function codexTerminalStaticArgs(options: {
  workspace: string;
  terminalTarget: string;
  codexPid: number;
  screen: string;
}): string[] {
  return [
    "--processes-json",
    JSON.stringify([{
      pid: options.codexPid,
      ppid: 999,
      elapsed: "00:30",
      command: "codex",
      cwd: options.workspace
    }]),
    "--terminals-json",
    JSON.stringify([terminalPane(options.terminalTarget, options.workspace)]),
    "--terminal-screens-json",
    JSON.stringify({ [options.terminalTarget]: options.screen })
  ];
}

function claudeTerminalStaticArgs(options: {
  workspace: string;
  terminalTarget: string;
  claudePid: number;
  claudeSessionId: string;
  screen: string;
}): string[] {
  return [
    "--processes-json",
    JSON.stringify([{
      pid: options.claudePid,
      ppid: 999,
      elapsed: "00:30",
      command: "claude",
      cwd: options.workspace
    }]),
    "--terminals-json",
    JSON.stringify([terminalPane(options.terminalTarget, options.workspace)]),
    "--terminal-screens-json",
    JSON.stringify({ [options.terminalTarget]: options.screen }),
    "--claude-agents-json",
    JSON.stringify([{
      kind: "interactive",
      pid: options.claudePid,
      sessionId: options.claudeSessionId,
      startedAt: 1784870000000,
      cwd: options.workspace,
      status: "idle"
    }])
  ];
}

function terminalPane(target: string, workspace: string) {
  const match = /^([^:]+):(\d+)\.(\d+)$/u.exec(target);
  assert.ok(match, `invalid test terminal target: ${target}`);
  return {
    kind: "tmux",
    target,
    session: match[1],
    window: Number(match[2]),
    pane: Number(match[3]),
    panePid: 999,
    currentCommand: "node",
    currentPath: workspace
  };
}
