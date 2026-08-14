import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  ensureStoreWritable,
  listConversations,
  pathsForConversation,
  storeConversationsDir,
  storeManifestPath,
  storeSessionsDir
} from "../../src/store.js";
import {
  listManagedSessions,
  loadManagedSession,
  pathsForManagedSession,
  saveManagedSession,
  tryLoadManagedSession
} from "../../src/session-store.js";
import {
  captureCodexRolloutAcceptanceAnchor,
  detectCodexRolloutAcceptance
} from "../../src/terminal-submission-acceptance.js";
import { createOpenClawPluginForTest } from "../../src/openclaw-plugin.js";
import {
  binPath,
  cwd,
  sessionId,
  rolloutPath,
  startManagedClaudeTerminalTask,
  claudeTerminalStaticArgs,
  claudeAgentRow,
  codexNativeIdentityArgs,
  runAgentCliInProcess,
  runAgentCliAsync,
  spawnAgentCliCaptured,
  spawnAgentCliProcess,
  waitForCondition,
  waitForChildExit,
  waitForPidExit,
  pidIsAlive,
  killPidBestEffort,
  eventCount,
  writeConversationClone,
  threadRow,
  tmuxPane,
  writeFakeTmux,
  writeFakeProcessTools,
  writeTrackedFakeProcessTools,
  writeFakeOpenClaw,
  writeFakeClaudeAgents,
  currentClaudeApprovalScreenForTest,
  writeAutoApprovingFakeOpenClaw,
  writeSequentialAutoApprovingFakeOpenClaw,
  findTerminalDispatchLedgerPath,
  readJsonLines
} from "../agent-cli-fixtures.js";

test("raw and managed Codex sends fail closed unless the locked pane is verifiably idle", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-send-idle-gate-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-idle-gate-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId =
    `terminal:v2:tmux:codex:${terminalTarget}:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-idle-gate-process",
    rolloutPath: path.join(tempDir, "codex-idle-gate-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const baseEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const managed = await runAgentCliInProcess([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Create the managed turn",
      "--background",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], baseEnv);
    assert.equal(managed.status, 0, managed.stderr || managed.stdout);
    const managedParsed = JSON.parse(managed.stdout);
    const managedConversationId = managedParsed.conversation.conversation_id;
    const managedSessionId = managedParsed.conversation.session_id;
    const managedStatePath = managedParsed.conversation.state_path;
    const completedAt = new Date().toISOString();
    const managedState = JSON.parse(
      fs.readFileSync(managedStatePath, "utf8")
    );
    fs.writeFileSync(
      managedStatePath,
      `${JSON.stringify({
        ...managedState,
        status: "idle",
        idle_since: completedAt,
        updated_at: completedAt
      }, null, 2)}\n`
    );
    const managedLedgerPath = findTerminalDispatchLedgerPath(
      managedConversationId,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const managedLedger = JSON.parse(
      fs.readFileSync(managedLedgerPath, "utf8")
    );
    fs.writeFileSync(
      managedLedgerPath,
      `${JSON.stringify({
        ...managedLedger,
        status: "resolved",
        resolved_at: completedAt,
        reason: "simulated durable completion"
      }, null, 2)}\n`
    );

    const scenarios = [
      {
        name: "working",
        screen: "• Working (12s • esc to interrupt)\n\n› Steer the current task\n",
        env: {},
        expected: /Codex terminal is working, not idle/u
      },
      {
        name: "unknown",
        screen: "last command output\nno recognizable Codex TUI footer\n",
        env: {},
        expected: /Codex terminal is unknown, not idle/u
      },
      {
        name: "capture failure",
        screen: "› \n",
        env: { AKK_TEST_TMUX_CAPTURE_FAIL: "1" },
        expected: /Codex terminal status is unavailable/u
      }
    ];

    for (const scenario of scenarios) {
      fs.writeFileSync(screenPath, scenario.screen);
      const scenarioEnv = { ...baseEnv, ...scenario.env };

      for (const target of [
        {
          option: "--conversation",
          id: rawConversationId,
          expected: scenario.expected
        },
        {
          option: "--session",
          id: managedSessionId,
          expected:
            /rollout-backed managed Session.*strict session_id send[\s\S]*refresh AKK list/iu
        }
      ]) {
        fs.writeFileSync(tmuxCallsPath, "");
        const sendArgs = [
          "send",
          target.option,
          target.id,
          "--message",
          `Must not send while terminal status is ${scenario.name}`,
          "--background",
          "--store-dir",
          storeDir,
          ...nativeIdentityArgs,
          "--disable-terminal-bridge-monitor"
        ];
        const sent = await runAgentCliInProcess(sendArgs, scenarioEnv);

        assert.notEqual(
          sent.status,
          0,
          `${scenario.name} ${target.id}: ${sent.stderr || sent.stdout}`
        );
        assert.match(sent.stderr, target.expected);
        assert.equal(
          readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys"),
          false,
          `${scenario.name} ${target.id} must not write terminal keys`
        );
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raw terminal send rejects a stale agent pid without sending tmux keys", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-stale-pid-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "$ ");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tzsh\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: 33389,
      ppid: 1,
      command: "zsh",
      cwd: workspace
    }]);

    const sent = await runAgentCliInProcess([
      "send",
      "--conversation",
      "terminal:v2:tmux:codex:codex-work:0.1:33389",
      "--message",
      "printf should-not-run"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /no longer available|no longer active/u);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys"),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raw terminal send uses the target pid cwd from partial lsof output", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-partial-lsof-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const processCallsPath = path.join(tempDir, "process-calls.ndjson");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-partial-lsof-${process.pid}`;
  const targetPid = 5101;
  const panePid = 9001;
  const unrelatedPid = 7777;
  const terminalTarget = `${tmuxSession}:0.1`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: targetPid,
    sessionId,
    processUuid: "codex-partial-lsof-process",
    rolloutPath: path.join(tempDir, "codex-partial-lsof-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${panePid}\tzsh\t${workspace}\n`
    );
    writeTrackedFakeProcessTools({
      fakeBinDir,
      callsPath: processCallsPath,
      processes: [
        { pid: panePid, ppid: 1, command: "zsh", cwd: workspace },
        {
          pid: targetPid,
          ppid: panePid,
          command: `codex resume ${sessionId}`,
          cwd: workspace
        },
        {
          pid: unrelatedPid,
          ppid: 1,
          command: "unrelated-worker",
          cwd: path.join(tempDir, "unrelated")
        }
      ],
      lsofStatus: 1,
      lsofRows: [
        {
          command: "codex",
          pid: targetPid,
          cwd: workspace
        }
      ]
    });

    const sent = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${terminalTarget}:${targetPid}`,
      "--message",
      "Verify partial lsof handling",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const processCalls = readJsonLines(processCallsPath);
    const lsofCalls = processCalls.filter((call) => call.command === "lsof");
    assert.ok(
      lsofCalls.length >= 2,
      "raw resolution and the pre-send identity gate must both verify cwd"
    );
    for (const call of lsofCalls) {
      assert.deepEqual(call.args.slice(-2), ["-p", String(targetPid)]);
      assert.equal(call.args.includes(String(unrelatedPid)), false);
      assert.equal(call.args.includes(String(panePid)), false);
    }

    const tmuxSends = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(
      tmuxSends.at(-2)?.args,
      ["send-keys", "-t", terminalTarget, "-l", "Verify partial lsof handling"]
    );
    assert.deepEqual(
      tmuxSends.at(-1)?.args,
      ["send-keys", "-t", terminalTarget, "C-m"]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raw terminal send fails closed when partial lsof output omits the target pid", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-missing-lsof-cwd-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const processCallsPath = path.join(tempDir, "process-calls.ndjson");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-missing-lsof-cwd-${process.pid}`;
  const targetPid = 5201;
  const panePid = 9002;
  const unrelatedPid = 8888;
  const terminalTarget = `${tmuxSession}:0.1`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${panePid}\tzsh\t${workspace}\n`
    );
    writeTrackedFakeProcessTools({
      fakeBinDir,
      callsPath: processCallsPath,
      processes: [
        { pid: panePid, ppid: 1, command: "zsh", cwd: workspace },
        {
          pid: targetPid,
          ppid: panePid,
          command: `codex resume ${sessionId}`,
          cwd: workspace
        },
        {
          pid: unrelatedPid,
          ppid: 1,
          command: "unrelated-worker",
          cwd: workspace
        }
      ],
      lsofStatus: 1,
      lsofRows: [
        {
          command: "worker",
          pid: unrelatedPid,
          cwd: workspace
        }
      ]
    });

    const sent = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${terminalTarget}:${targetPid}`,
      "--message",
      "Must not reach tmux without a verified cwd",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /no longer available/u);
    const lsofCalls = readJsonLines(processCallsPath)
      .filter((call) => call.command === "lsof");
    assert.equal(lsofCalls.length, 1);
    assert.deepEqual(lsofCalls[0].args.slice(-2), ["-p", String(targetPid)]);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false
    );
    assert.equal(fs.existsSync(storeDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("approve supports terminal-controlled conversation ids without AKK state", async () => {
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
    const status = await runAgentCliInProcess([
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

    const approved = await runAgentCliInProcess([
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

test("raw terminal send requires managed background mode while cancel remains direct", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-send-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:tmux:codex-work:0.1:33389";
    const sent = await runAgentCliInProcess([
      "send",
      "--conversation",
      conversationId,
      "--message",
      "你好\n"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /raw terminal sends require --background/u);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys"),
      false
    );

    const cancelled = await runAgentCliInProcess([
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

test("background send to raw terminal id creates managed callback conversation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-background-send-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-background-send-process",
    rolloutPath: path.join(tempDir, "codex-background-send-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: 33389,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd: workspace
    }]);

    const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
    const rejected = await runAgentCliInProcess([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Do not send this",
      "--background",
      "--store-dir",
      storeDir,
      "--agent-hard-timeout-minutes",
      "0",
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /must be a positive number/);
    assert.equal(fs.existsSync(tmuxCallsPath), false);

    const sent = await runAgentCliInProcess([
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
      ...nativeIdentityArgs,
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

    const statePath = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    ).statePath;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.conversation_id, sentParsed.conversation.conversation_id);
    assert.equal(typeof state.native_session_takeover.terminal_bridge_started_at, "string");
    assert.equal(state.native_session_takeover.terminal_bridge_message_id, sentParsed.message.id);
    assert.equal(
      state.native_session_takeover.terminal_bridge_submission.status,
      "agent_accepted"
    );
    assert.equal(
      state.native_session_takeover.terminal_bridge_submission.message_id,
      sentParsed.message.id
    );
    assert.equal(
      typeof state.native_session_takeover.terminal_bridge_submission.prepared_at,
      "string"
    );
    assert.equal(
      typeof state.native_session_takeover.terminal_bridge_submission.agent_accepted_at,
      "string"
    );

    const events = readJsonLines(path.join(path.dirname(statePath), "events.ndjson"));
    const messageIndex = events.findIndex((event) => event.event === "message");
    const preparedIndex = events.findIndex(
      (event) => event.event === "terminal_message_submit_prepared"
    );
    const sentIndex = events.findIndex((event) => event.event === "terminal_message_send");
    assert.ok(messageIndex >= 0);
    assert.ok(preparedIndex > messageIndex);
    assert.ok(sentIndex > preparedIndex);

    const calls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
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
      idle_since: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(idleState, null, 2)}\n`);

    const listed = await runAgentCliInProcess([
      "list",
      "--reconcile",
      "--store-dir",
      storeDir,
      "--idle-timeout-minutes",
      "1",
      "--managed-only"
    ]);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedParsed = JSON.parse(listed.stdout);
    assert.equal(listedParsed.reconciliation.closed, 1);
    assert.deepEqual(listedParsed.unavailable_managed_turns, []);
    const closedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(closedState.status, "closed");
    assert.equal(closedState.close_reason, "idle timeout after 1 minutes");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
