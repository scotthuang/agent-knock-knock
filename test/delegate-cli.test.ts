import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runInProcessCli,
  VirtualClock
} from "./in-process-cli-fixtures.js";

const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-delegate-cli-runtime-")
);
const CLAUDE_EXACT_IDLE_COMPOSER = [
  "────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"
].join("\n");
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
});

test("delegate routes asynchronously to the only idle matching tmux pane", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-tmux-"));
  const workspace = path.join(tempDir, "workspace");
  const otherWorkspace = path.join(tempDir, "other-workspace");
  const storeDir = path.join(tempDir, "conversations");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(otherWorkspace, { recursive: true });
    const result = await runDelegate([
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
      }),
      "--codex-active-session-identities-json",
      JSON.stringify({
        5101: codexNativeIdentityFixture({
          workspace,
          codexPid: 5101
        }),
        5102: codexNativeIdentityFixture({
          workspace: otherWorkspace,
          codexPid: 5102
        })
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

test("a recreated pane keeps the prior receipt immutable while accepting a new delegate", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-delegate-recreated-pane-")
  );
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-recreated-receipt:0.0";
  const send = (options: {
    request: string;
    storeDir: string;
    codexPid: number;
    panePid: number;
  }) => runDelegate([
    "--agent",
    "codex",
    "--request",
    options.request,
    "--workspace",
    workspace,
    "--store-dir",
    options.storeDir,
    "--background",
    "--disable-terminal-bridge-monitor",
    "--processes-json",
    JSON.stringify([{
      pid: options.codexPid,
      ppid: options.panePid,
      elapsed: "00:20",
      command: "codex",
      cwd: workspace
    }]),
    "--terminals-json",
    JSON.stringify([tmuxPane({
      target: terminalTarget,
      session: "codex-recreated-receipt",
      panePid: options.panePid,
      currentPath: workspace
    })]),
    "--terminal-screens-json",
    JSON.stringify({ [terminalTarget]: "› " }),
    "--codex-active-session-identities-json",
    JSON.stringify({
      [options.codexPid]: codexNativeIdentityFixture({
        workspace,
        codexPid: options.codexPid
      })
    })
  ]);

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const first = await send({
      request: "First pane incarnation",
      storeDir: path.join(tempDir, "first-store"),
      codexPid: 6101,
      panePid: 9601
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);

    const second = await send({
      request: "Replacement pane incarnation",
      storeDir: path.join(tempDir, "second-store"),
      codexPid: 6102,
      panePid: 9602
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const parsed = JSON.parse(second.stdout);
    assert.equal(parsed.delivered, true);
    assert.notEqual(parsed.replayed, true);
    assert.equal(parsed.terminal_control.target, terminalTarget);
    assert.equal(parsed.terminal_control.panePid, 9602);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delegate without an agent selects the only idle supported pane", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-any-agent-"));
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const result = await runDelegate([
      "--request",
      "Review the tmux-only delegate flow",
      "--workspace",
      workspace,
      "--store-dir",
      path.join(tempDir, "conversations"),
      "--background",
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      JSON.stringify([{
        pid: 5101,
        ppid: 9101,
        elapsed: "00:20",
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.0",
        panePid: 9101,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": "› "
      })
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.conversation.executor.kind, "codex");
    assert.equal(parsed.terminal_control.target, "codex-work:0.0");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delegate without --workspace routes to the only idle pane in its own cwd", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-any-workspace-"));
  const paneWorkspace = path.join(tempDir, "pane-workspace");

  try {
    fs.mkdirSync(paneWorkspace, { recursive: true });
    const result = await runDelegate([
      "--request",
      "Review the pane workspace without a global workspace filter",
      "--store-dir",
      path.join(tempDir, "conversations"),
      "--background",
      "--disable-terminal-bridge-monitor",
      ...terminalFixtureArgs({
        processes: [{
          pid: 5301,
          ppid: 9301,
          elapsed: "00:20",
          command: "codex",
          cwd: paneWorkspace
        }],
        panes: [tmuxPane({
          target: "codex-any-workspace:0.0",
          session: "codex-any-workspace",
          panePid: 9301,
          currentPath: paneWorkspace
        })],
        screens: {
          "codex-any-workspace:0.0": "› "
        }
      })
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.conversation.executor.kind, "codex");
    assert.equal(parsed.conversation.workspace, paneWorkspace);
    assert.equal(
      parsed.terminal_control.target,
      "codex-any-workspace:0.0"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delegate without an agent gives setup guidance when no idle pane exists", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-no-pane-"));
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const result = await runDelegate([
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
    assert.match(result.stderr, /No send-ready Codex or Claude Code pane is available/);
    assert.match(result.stderr, /Start codex or claude inside tmux/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bare delegate without --workspace fails closed across idle pane workspaces", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-cross-workspace-"));
  const firstWorkspace = path.join(tempDir, "first-workspace");
  const secondWorkspace = path.join(tempDir, "second-workspace");

  try {
    fs.mkdirSync(firstWorkspace, { recursive: true });
    fs.mkdirSync(secondWorkspace, { recursive: true });
    const result = await runDelegate([
      "--request",
      "Do not guess which project should receive this task",
      "--store-dir",
      path.join(tempDir, "conversations"),
      "--background",
      ...terminalFixtureArgs({
        processes: [
          {
            pid: 5401,
            ppid: 9401,
            elapsed: "00:20",
            command: "codex",
            cwd: firstWorkspace
          },
          {
            pid: 5402,
            ppid: 9402,
            elapsed: "00:21",
            command: "codex",
            cwd: secondWorkspace
          }
        ],
        panes: [
          tmuxPane({
            target: "codex-first-workspace:0.0",
            session: "codex-first-workspace",
            panePid: 9401,
            currentPath: firstWorkspace
          }),
          tmuxPane({
            target: "codex-second-workspace:0.0",
            session: "codex-second-workspace",
            panePid: 9402,
            currentPath: secondWorkspace
          })
        ],
        screens: {
          "codex-first-workspace:0.0": "› ",
          "codex-second-workspace:0.0": "› "
        }
      })
    ]);

    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stderr,
      /Multiple send-ready coding-agent panes are available across workspaces/u
    );
    assert.match(result.stderr, /codex-first-workspace:0\.0/u);
    assert.match(result.stderr, /codex-second-workspace:0\.0/u);
    assert.equal(result.stderr.includes(firstWorkspace), true);
    assert.equal(result.stderr.includes(secondWorkspace), true);
    assert.match(result.stderr, /\/akk @short-ref: <message>/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delegate fails closed when multiple idle matching tmux panes exist", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-ambiguous-"));
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const result = await runDelegate([
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
    assert.match(result.stderr, /Multiple send-ready Codex panes match/);
    assert.match(result.stderr, /\/akk codex: <task>/);
    assert.match(result.stderr, /\/akk @short-ref: <message>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an exact short selector can send across cwd without --workspace", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-send-cross-workspace-"));
  const firstWorkspace = path.join(tempDir, "first-workspace");
  const selectedWorkspace = path.join(tempDir, "selected-workspace");
  const storeDir = path.join(tempDir, "conversations");

  try {
    fs.mkdirSync(firstWorkspace, { recursive: true });
    fs.mkdirSync(selectedWorkspace, { recursive: true });
    const runtimeArgs = terminalFixtureArgs({
      processes: [
        {
          pid: 5501,
          ppid: 9501,
          elapsed: "00:20",
          command: "codex",
          cwd: firstWorkspace
        },
        {
          pid: 5502,
          ppid: 9502,
          elapsed: "00:21",
          command: "codex",
          cwd: selectedWorkspace
        }
      ],
      panes: [
        tmuxPane({
          target: "codex-first-selector:0.0",
          session: "codex-first-selector",
          panePid: 9501,
          currentPath: firstWorkspace
        }),
        tmuxPane({
          target: "codex-selected:0.0",
          session: "codex-selected",
          panePid: 9502,
          currentPath: selectedWorkspace
        })
      ],
      screens: {
        "codex-first-selector:0.0": "› ",
        "codex-selected:0.0": "› "
      }
    });
    const listed = await runCli("list", [
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const selected = JSON.parse(listed.stdout).terminals.find(
      (entry: Record<string, any>) =>
        entry.terminal_control?.target === "codex-selected:0.0"
    );
    assert.match(selected?.short_ref ?? "", /^@[0-9a-f]{10}$/u);

    const sent = await runCli("send", [
      "--conversation",
      selected.short_ref,
      "--message",
      "Inspect only the explicitly selected project",
      "--store-dir",
      storeDir,
      "--background",
      "--disable-terminal-bridge-monitor",
      ...runtimeArgs
    ]);

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const parsed = JSON.parse(sent.stdout);
    assert.equal(parsed.conversation.workspace, selectedWorkspace);
    assert.equal(parsed.terminal_control.target, "codex-selected:0.0");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delegate without an agent fails closed across mixed idle panes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-mixed-ambiguous-"));
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const result = await runDelegate([
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
          pid: 5201,
          ppid: 9002,
          elapsed: "00:21",
          command: "claude",
          cwd: workspace
        }
      ]),
      "--terminals-json",
      JSON.stringify([
        tmuxPane({
          target: "codex-mixed-work:0.0",
          session: "codex-mixed-work",
          panePid: 9001,
          currentPath: workspace
        }),
        tmuxPane({
          target: "claude-work:0.0",
          session: "claude-work",
          panePid: 9002,
          currentPath: workspace
        })
      ]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-mixed-work:0.0": "› ",
        "claude-work:0.0": CLAUDE_EXACT_IDLE_COMPOSER
      })
    ]);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Multiple send-ready coding-agent panes match/);
    assert.match(result.stderr, /\(codex, codex-mixed-work:0\.0\)/);
    assert.match(result.stderr, /\(claude, claude-work:0\.0\)/);
    assert.match(result.stderr, /\/akk claude: <task>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit selectors cannot send outside the configured workspace", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-send-workspace-boundary-"));
  const workspace = path.join(tempDir, "workspace");
  const otherWorkspace = path.join(tempDir, "other-workspace");
  const storeDir = path.join(tempDir, "conversations");
  const processSnapshot = JSON.stringify([{
    pid: 5102,
    ppid: 9002,
    elapsed: "00:20",
    command: "codex",
    cwd: otherWorkspace
  }]);
  const terminalSnapshot = JSON.stringify([tmuxPane({
    target: "codex-other:0.0",
    session: "codex-other",
    panePid: 9002,
    currentPath: otherWorkspace
  })]);
  const commonArgs = [
    "--message",
    "Do not send this outside the configured workspace",
    "--workspace",
    workspace,
    "--store-dir",
    storeDir,
    "--background",
    "--disable-terminal-bridge-monitor",
    "--processes-json",
    processSnapshot,
    "--terminals-json",
    terminalSnapshot,
    "--terminal-screens-json",
    JSON.stringify({ "codex-other:0.0": "› " })
  ];

  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(otherWorkspace, { recursive: true });

    const agentSelector = await runCli("send", [
      "--conversation",
      "codex",
      ...commonArgs
    ]);
    assert.equal(agentSelector.status, 1, agentSelector.stdout);
    assert.match(
      agentSelector.stderr,
      /no actionable sessions|does not match|unknown session selector/iu
    );

    const fullId = await runCli("send", [
      "--conversation",
      "terminal:v2:tmux:codex:codex-other:0.0:5102",
      ...commonArgs
    ]);
    assert.equal(fullId.status, 1, fullId.stdout);
    assert.match(
      fullId.stderr,
      /workspace|no longer available/iu
    );

    const mismatchedIdentity = await runCli("send", [
      "--conversation",
      "terminal:v2:tmux:codex:codex-other:0.0:5102",
      "--message",
      "Do not trust only the tmux pane path",
      "--workspace",
      workspace,
      "--store-dir",
      storeDir,
      "--background",
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      processSnapshot,
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-other:0.0",
        session: "codex-other",
        panePid: 9002,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-other:0.0": "› " })
    ]);
    assert.equal(mismatchedIdentity.status, 1, mismatchedIdentity.stdout);
    assert.match(
      mismatchedIdentity.stderr,
      /workspace|no longer available/iu
    );
    if (fs.existsSync(storeDir)) {
      assert.deepEqual(fs.readdirSync(storeDir), []);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runDelegate(args: string[]) {
  return runCli("delegate", args);
}

function runCli(command: string, args: string[]) {
  const clock = new VirtualClock();
  return runInProcessCli([command, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AKK_RUNTIME_DIR: testRuntimeDir,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
      AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
    },
    processBirthForPid: (pid) => `fixture-process-birth-${pid}`,
    codexProcessBirthForPid: (pid) => `fixture-process-birth-${pid}`,
    now: clock.now,
    monotonicNowMs: clock.nowMs,
    sleep: clock.sleep,
    sleepSync: clock.sleepSync,
    runtimeLog() {}
  });
}

function terminalFixtureArgs(options: {
  processes: Array<Record<string, unknown>>;
  panes: Array<Record<string, unknown>>;
  screens: Record<string, string>;
}): string[] {
  return [
    "--processes-json",
    JSON.stringify(options.processes),
    "--terminals-json",
    JSON.stringify(options.panes),
    "--terminal-screens-json",
    JSON.stringify(options.screens)
  ];
}

function codexNativeIdentityFixture(options: {
  workspace: string;
  codexPid: number;
}): Record<string, unknown> {
  const sessionId =
    `00000000-0000-4000-8000-${String(options.codexPid).padStart(12, "0")}`;
  const rolloutPath = path.join(
    options.workspace,
    ".codex",
    "sessions",
    `${sessionId}.jsonl`
  );
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-08-21T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        cwd: options.workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.148.0"
      }
    })}\n`,
    { mode: 0o600 }
  );
  const rolloutStat = fs.statSync(rolloutPath);
  return {
    sessionId,
    processUuid: `codex-process-${options.codexPid}`,
    processBirth: `fixture-process-birth-${options.codexPid}`,
    rollout: {
      fd: "17",
      device: String(rolloutStat.dev),
      inode: String(rolloutStat.ino),
      path: rolloutPath
    },
    evidence: "static_exact_fixture"
  };
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
