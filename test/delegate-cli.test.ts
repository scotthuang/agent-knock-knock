import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-delegate-cli-runtime-")
);
process.env.AKK_RUNTIME_DIR = testRuntimeDir;
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
});

test("delegate routes asynchronously to the only idle matching tmux pane", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-tmux-"));
  const workspace = path.join(tempDir, "workspace");
  const otherWorkspace = path.join(tempDir, "other-workspace");
  const storeDir = path.join(tempDir, "conversations");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(otherWorkspace, { recursive: true });
    const result = runDelegate([
      "--agent",
      "codex",
      "--request",
      "Implement the tmux-only delegate flow",
      "--workspace",
      workspace,
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:test:main",
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:main",
      "--background",
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      JSON.stringify([
        {
          pid: 5101,
          ppid: 9001,
          elapsed: "00:20",
          command: "codex",
          cwd: workspace
        },
        {
          pid: 5102,
          ppid: 9002,
          elapsed: "00:20",
          command: "codex",
          cwd: otherWorkspace
        }
      ]),
      "--terminals-json",
      JSON.stringify([
        tmuxPane({
          target: "codex-work:0.0",
          panePid: 9001,
          currentPath: workspace
        }),
        tmuxPane({
          target: "codex-other:0.0",
          session: "codex-other",
          panePid: 9002,
          currentPath: otherWorkspace
        })
      ]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": "› ",
        "codex-other:0.0": "› "
      })
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.status, "async_pending");
    assert.equal(parsed.background, true);
    assert.equal(parsed.callback_expected, true);
    assert.equal(parsed.conversation.executor.kind, "codex");
    assert.equal(parsed.terminal_control.target, "codex-work:0.0");
    assert.equal(parsed.terminal_control.panePid, 9001);
    assert.equal(fs.existsSync(parsed.conversation.state_path), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delegate fails with setup guidance when no idle matching tmux pane exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-no-pane-"));
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const result = runDelegate([
      "--agent",
      "codex",
      "--request",
      "Implement the requested change",
      "--workspace",
      workspace,
      "--store-dir",
      path.join(tempDir, "conversations"),
      "--background",
      "--processes-json",
      "[]",
      "--terminals-json",
      "[]",
      "--terminal-screens-json",
      "{}"
    ]);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /No idle Codex pane is available/);
    assert.match(result.stderr, /Start codex inside tmux/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delegate fails closed when multiple idle matching tmux panes exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-ambiguous-"));
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const result = runDelegate([
      "--agent",
      "codex",
      "--request",
      "Implement the requested change",
      "--workspace",
      workspace,
      "--store-dir",
      path.join(tempDir, "conversations"),
      "--background",
      "--processes-json",
      JSON.stringify([
        {
          pid: 5101,
          ppid: 9001,
          elapsed: "00:20",
          command: "codex",
          cwd: workspace
        },
        {
          pid: 5102,
          ppid: 9002,
          elapsed: "00:21",
          command: "codex",
          cwd: workspace
        }
      ]),
      "--terminals-json",
      JSON.stringify([
        tmuxPane({
          target: "codex-first:0.0",
          session: "codex-first",
          panePid: 9001,
          currentPath: workspace
        }),
        tmuxPane({
          target: "codex-second:0.0",
          session: "codex-second",
          panePid: 9002,
          currentPath: workspace
        })
      ]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-first:0.0": "› ",
        "codex-second:0.0": "› "
      })
    ]);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Multiple idle Codex panes match/);
    assert.match(result.stderr, /\/akk list/);
    assert.match(result.stderr, /\/akk send/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runDelegate(args: string[]) {
  return spawnSync(process.execPath, [binPath, "delegate", ...args], {
    encoding: "utf8",
    env: process.env
  });
}

function tmuxPane(overrides: Record<string, unknown> = {}) {
  return {
    kind: "tmux",
    target: "codex-work:0.0",
    session: "codex-work",
    window: 0,
    pane: 0,
    panePid: 9001,
    currentCommand: "node",
    currentPath: "/repo/workspace",
    ...overrides
  };
}
