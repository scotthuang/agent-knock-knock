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
  const approvalScreen = [
    "Would you like to run the following command?",
    "",
    "› 1. Yes, allow (y)",
    "  2. No (n)"
  ].join("\n");

  try {
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
          cwd: "/repo/native"
        },
        {
          pid: 2222,
          ppid: 3333,
          elapsed: "00:30",
          command: "codex",
          cwd: "/repo/tmux"
        },
        {
          pid: 3333,
          ppid: 9999,
          elapsed: "00:31",
          command: "zsh -lc launch-agent",
          cwd: "/repo/tmux"
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
        currentPath: "/repo/tmux"
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
        cwd: "/repo/tmux"
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
        currentPath: "/repo/tmux"
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
        cwd: "/repo/native"
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

  try {
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
          cwd: "/repo/first"
        },
        {
          pid: 2202,
          ppid: 9002,
          elapsed: "00:21",
          command: "codex",
          cwd: "/repo/second"
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
          currentPath: "/repo/first"
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
          currentPath: "/repo/second"
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
  const workingScreen = [
    "• Working (8s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    "",
    "› Continue implementation"
  ].join("\n");

  try {
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
        cwd: "/repo/tmux"
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
        currentPath: "/repo/tmux"
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
    assert.equal(codex.terminal_control.capabilities.includes("screen_completion"), true);

    const claude = listed.terminal_controlled.find((entry: any) => entry.agent === "claude");
    assert.equal(claude.id, "terminal:v2:tmux:claude:claude-work:1.0:5201");
    assert.equal(claude.session_id, "claude-session-list");
    assert.equal(claude.confidence, "high");
    assert.equal(claude.activity_state, "idle");
    assert.equal(claude.commands.send, true);
    assert.equal(claude.commands.cancel, true);
    assert.equal(claude.commands.approve, false);
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
