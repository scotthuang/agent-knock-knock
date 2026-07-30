import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-management-cli-runtime-")
);
process.env.AKK_RUNTIME_DIR = testRuntimeDir;
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
});

test("list exposes only tmux-controlled sessions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-groups-"));
  const storeDir = path.join(tempDir, "conversations");
  const nativeWorkspace = path.join(tempDir, "native");
  const tmuxWorkspace = path.join(tempDir, "tmux");
  const approvalScreen = [
    "Would you like to run the following command?",
    "",
    "› 1. Yes, allow (y)",
    "  2. No (n)"
  ].join("\n");

  try {
    fs.mkdirSync(nativeWorkspace, { recursive: true });
    fs.mkdirSync(tmuxWorkspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([
        {
          pid: 1234,
          ppid: 1,
          elapsed: "00:12",
          command: "codex",
          cwd: nativeWorkspace
        },
        {
          pid: 2222,
          ppid: 3333,
          elapsed: "00:30",
          command: "codex",
          cwd: tmuxWorkspace
        },
        {
          pid: 3333,
          ppid: 9999,
          elapsed: "00:31",
          command: "zsh -lc launch-agent",
          cwd: tmuxWorkspace
        }
      ]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: "codex-work:0.0",
        session: "codex-work",
        window: 0,
        pane: 0,
        panePid: 9999,
        currentCommand: "node",
        currentPath: tmuxWorkspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": approvalScreen
      })
    ]);

    assert.deepEqual(listed.tasks, []);
    assert.deepEqual(listed.delegated, []);
    assert.equal("native" in listed, false);
    assert.equal(listed.terminal_controlled.length, 1);
    assert.equal(listed.terminal_controlled[0].id, "terminal:v2:tmux:codex:codex-work:0.0:2222");
    assert.equal(listed.terminal_controlled[0].terminal_control.target, "codex-work:0.0");
    assert.equal(listed.terminal_controlled[0].activity_state, "awaiting_approval");
    assert.match(listed.terminal_controlled[0].activity_reason, /approval prompt/);
    assert.equal(listed.terminal_controlled[0].approval_state.blocked, true);
    assert.equal(listed.terminal_controlled[0].approval_state.approvable, true);
    assert.equal(listed.terminal_controlled[0].commands.send, true);
    assert.equal(listed.terminal_controlled[0].commands.approve, true);
    assert.equal(listed.terminal_controlled[0].commands.cancel, true);
    assert.equal(listed.terminal_controlled[0].commands.status, true);
    assert.equal("capture_screen" in listed.terminal_controlled[0].commands, false);
    assert.equal("detach" in listed.terminal_controlled[0].commands, false);
    assert.equal(listed.action_contracts.version, 1);
    assert.deepEqual(
      Object.keys(listed.action_contracts.actions),
      [
        "send",
        "status",
        "approve",
        "cancel",
        "renew",
        "retry_callback",
        "close"
      ]
    );
    assert.equal(
      listed.action_contracts.actions.send.target_argument,
      "selector"
    );
    assert.deepEqual(
      listed.action_contracts.actions.send.required,
      ["request"]
    );
    assert.equal(
      listed.action_contracts.actions.send.optional.includes("selector"),
      true
    );
    assert.deepEqual(
      listed.action_contracts.actions.send.unsupported,
      ["timeoutSeconds"]
    );
    assert.equal(
      listed.action_contracts.actions.approve.target_argument,
      "conversation_id"
    );
    const approvalActions = listed.terminal_controlled[0].available_actions;
    assert.deepEqual(
      approvalActions.status.arguments,
      { conversation_id: listed.terminal_controlled[0].id }
    );
    assert.equal(approvalActions.send, undefined);
    assert.deepEqual(
      approvalActions.approve.arguments,
      { conversation_id: listed.terminal_controlled[0].id }
    );
    assert.deepEqual(
      approvalActions.approve.missing_required,
      ["expected_approval_fingerprint"]
    );
    assert.deepEqual(
      approvalActions.approve.before_call.arguments,
      { conversation_id: listed.terminal_controlled[0].id }
    );
    assert.equal(approvalActions.approve.requires_explicit_user_confirmation, true);
    assert.deepEqual(
      approvalActions.cancel.arguments,
      { conversation_id: listed.terminal_controlled[0].id }
    );
    assert.equal(approvalActions.close, undefined);
    assert.equal(listed.terminal_scan.terminal_controlled_count, 1);

    const debugListed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--terminal-debug",
      "--processes-json",
      JSON.stringify([{
        pid: 2222,
        ppid: 9999,
        elapsed: "00:30",
        command: "codex",
        cwd: tmuxWorkspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: "codex-work:0.0",
        session: "codex-work",
        window: 0,
        pane: 0,
        panePid: 9999,
        currentCommand: "node",
        currentPath: tmuxWorkspace
      }])
    ]);
    assert.equal(debugListed.terminal_scan.diagnostics.provider, "static");
    assert.equal(debugListed.terminal_scan.diagnostics.paneCount, 1);

    const managedOnly = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--managed-only",
      "--processes-json",
      JSON.stringify([{
        pid: 1234,
        ppid: 1,
        elapsed: "00:12",
        command: "codex",
        cwd: nativeWorkspace
      }])
    ]);
    assert.deepEqual(managedOnly.delegated, []);
    assert.equal("native" in managedOnly, false);
    assert.deepEqual(managedOnly.terminal_controlled, []);
    assert.equal(managedOnly.terminal_scan.enabled, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list keeps same-named targets from distinct tmux servers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-multi-tmux-"));
  const storeDir = path.join(tempDir, "conversations");
  const firstWorkspace = path.join(tempDir, "first");
  const secondWorkspace = path.join(tempDir, "second");

  try {
    fs.mkdirSync(firstWorkspace, { recursive: true });
    fs.mkdirSync(secondWorkspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([
        {
          pid: 2201,
          ppid: 9001,
          elapsed: "00:20",
          command: "codex",
          cwd: firstWorkspace
        },
        {
          pid: 2202,
          ppid: 9002,
          elapsed: "00:21",
          command: "codex",
          cwd: secondWorkspace
        }
      ]),
      "--terminals-json",
      JSON.stringify([
        {
          kind: "tmux",
          target: "work:0.0",
          socketPath: "/tmp/tmux-first",
          session: "work",
          window: 0,
          pane: 0,
          panePid: 9001,
          currentCommand: "node",
          currentPath: firstWorkspace
        },
        {
          kind: "tmux",
          target: "work:0.0",
          socketPath: "/tmp/tmux-second",
          session: "work",
          window: 0,
          pane: 0,
          panePid: 9002,
          currentCommand: "node",
          currentPath: secondWorkspace
        }
      ])
    ]);

    assert.equal(listed.terminal_controlled.length, 2);
    assert.deepEqual(
      listed.terminal_controlled.map((entry: any) => entry.terminal_control.panePid).sort(),
      [9001, 9002]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list exposes terminal-controlled Codex working activity state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-activity-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const workingScreen = [
    "• Working (8s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    "",
    "› Continue implementation"
  ].join("\n");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([{
        pid: 2222,
        ppid: 9999,
        elapsed: "00:30",
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: "codex-work:0.0",
        session: "codex-work",
        window: 0,
        pane: 0,
        panePid: 9999,
        currentCommand: "node",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": workingScreen
      })
    ]);

    assert.equal(listed.terminal_controlled.length, 1);
    assert.equal(listed.terminal_controlled[0].activity_state, "working");
    assert.match(listed.terminal_controlled[0].activity_reason, /Working/);
    assert.equal(listed.terminal_controlled[0].approval_state.blocked, false);
    assert.equal(listed.terminal_controlled[0].approval_state.approvable, false);
    assert.equal(listed.terminal_controlled[0].commands.approve, false);
    assert.equal(listed.terminal_controlled[0].available_actions.send, undefined);
    assert.deepEqual(
      listed.terminal_controlled[0].available_actions.cancel.arguments,
      { conversation_id: listed.terminal_controlled[0].id }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list never advertises raw Claude approval or ambiguous cancellation", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-list-raw-claude-approval-")
  );
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "claude-raw:0.0";
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

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([{
        pid: 5201,
        ppid: 9002,
        elapsed: "00:30",
        command: "claude",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: terminalTarget,
        session: "claude-raw",
        window: 0,
        pane: 0,
        panePid: 9002,
        currentCommand: "node",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: approvalScreen }),
      "--claude-agents-json",
      JSON.stringify([{
        kind: "interactive",
        pid: 5201,
        sessionId: "claude-session-raw-approval",
        cwd: workspace,
        status: "idle"
      }])
    ]);

    assert.equal(listed.terminal_controlled.length, 1);
    const entry = listed.terminal_controlled[0];
    assert.equal(entry.agent, "claude");
    assert.equal(entry.available_actions.approve, undefined);
    assert.equal(entry.available_actions.cancel, undefined);
    assert.deepEqual(
      Object.keys(entry.available_actions),
      ["status"]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list discovers Claude and Codex tmux sessions from static runtime snapshots", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-claude-tmux-"));
  const storeDir = path.join(tempDir, "conversations");
  const codexWorkspace = path.join(tempDir, "codex-workspace");
  const claudeWorkspace = path.join(tempDir, "claude-workspace");

  try {
    fs.mkdirSync(codexWorkspace, { recursive: true });
    fs.mkdirSync(claudeWorkspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([{
        pid: 5101,
        ppid: 9001,
        elapsed: "00:20",
        command: "codex",
        cwd: codexWorkspace
      }, {
        pid: 5201,
        ppid: 9002,
        elapsed: "00:30",
        command: "claude",
        cwd: claudeWorkspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: "codex-work:0.0",
        session: "codex-work",
        window: 0,
        pane: 0,
        panePid: 9001,
        currentCommand: "node",
        currentPath: codexWorkspace
      }, {
        kind: "tmux",
        target: "claude-work:1.0",
        session: "claude-work",
        window: 1,
        pane: 0,
        panePid: 9002,
        currentCommand: "node",
        currentPath: claudeWorkspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": "› ",
        "claude-work:1.0": "❯ "
      }),
      "--claude-agents-json",
      JSON.stringify([{
        kind: "interactive",
        pid: 5201,
        sessionId: "claude-session-list",
        cwd: claudeWorkspace,
        status: "idle"
      }])
    ]);

    assert.equal(listed.terminal_scan.active_count, 2);
    assert.equal(listed.terminal_scan.terminal_controlled_count, 2);
    assert.deepEqual(listed.terminal_scan.agents, ["codex", "claude"]);
    assert.deepEqual(listed.terminal_controlled.map((entry: any) => entry.agent).sort(), ["claude", "codex"]);

    const codex = listed.terminal_controlled.find((entry: any) => entry.agent === "codex");
    assert.equal(codex.id, "terminal:v2:tmux:codex:codex-work:0.0:5101");
    assert.equal(codex.commands.send, true);
    assert.equal(codex.commands.cancel, true);
    assert.deepEqual(
      codex.available_actions.send.arguments,
      { selector: codex.id }
    );
    assert.deepEqual(
      codex.available_actions.send.missing_required,
      ["request"]
    );
    assert.equal(codex.available_actions.cancel, undefined);
    assert.equal(codex.terminal_control.capabilities.includes("screen_completion"), true);

    const claude = listed.terminal_controlled.find((entry: any) => entry.agent === "claude");
    assert.equal(claude.id, "terminal:v2:tmux:claude:claude-work:1.0:5201");
    assert.equal(claude.session_id, "claude-session-list");
    assert.equal(claude.confidence, "high");
    assert.equal(claude.activity_state, "idle");
    assert.equal(claude.commands.send, true);
    assert.equal(claude.commands.cancel, true);
    assert.equal(claude.commands.approve, false);
    assert.deepEqual(
      claude.available_actions.send.arguments,
      { selector: claude.id }
    );
    assert.equal(claude.available_actions.cancel, undefined);
    assert.equal(claude.terminal_control.capabilities.includes("durable_completion"), true);
    assert.equal(claude.terminal_control.capabilities.includes("screen_completion"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: process.env
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
