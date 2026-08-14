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

test("terminal bridge monitor trusts matching task_complete despite stale working screen text", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-monitor-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-monitor-task-complete-process",
    rolloutPath
  });

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

    const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
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
      openclawBin,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;

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

    const monitored = await runAgentCliInProcess([
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
        panePid: 33389,
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
      JSON.stringify({ [rolloutPath]: rollout }),
      ...nativeIdentityArgs
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
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(typeof parsed.conversation.idle_since, "string");
    const completedLedgerPath = findTerminalDispatchLedgerPath(
      parsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    assert.equal(
      JSON.parse(fs.readFileSync(completedLedgerPath, "utf8")).status,
      "resolved"
    );
    const keysBeforeStaleActions = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys")
      .length;
    const staleApprove = await runAgentCliInProcess([
      "approve",
      "--conversation",
      parsed.conversation.conversation_id,
      "--expected-approval-fingerprint",
      "stale-fingerprint",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs
    ]);
    assert.notEqual(staleApprove.status, 0);
    assert.match(staleApprove.stderr, /conversation is idle/u);
    const staleCancel = await runAgentCliInProcess([
      "cancel",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs
    ]);
    assert.notEqual(staleCancel.status, 0);
    assert.match(staleCancel.stderr, /conversation is idle/u);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) => call.args[0] === "send-keys")
        .length,
      keysBeforeStaleActions
    );

    fs.writeFileSync(screenPath, "› \n");
    const followUp = await runAgentCliInProcess([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Now summarize the release notes",
      "--background",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(followUp.status, 0, followUp.stderr || followUp.stdout);
    const followUpParsed = JSON.parse(followUp.stdout);
    assert.equal(followUpParsed.delivered, true);
    assert.equal(followUpParsed.conversation.status, "waiting_for_agent");
    assert.equal(followUpParsed.session_id, parsed.conversation.session_id);
    assert.notEqual(followUpParsed.turn_id, parsed.conversation.turn_id);
    assert.notEqual(
      followUpParsed.conversation.state_path,
      parsed.conversation.state_path
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      2
    );

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

test("terminal bridge searches all same-cwd rollouts for the matching task_complete", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-cwd-rollouts-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const correctSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44f";
  const newerSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c450";
  const newestSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c451";
  const correctRolloutPath = path.join(tempDir, "correct.jsonl");
  const newerRolloutPath = path.join(tempDir, "newer.jsonl");
  const newestRolloutPath = path.join(tempDir, "newest.jsonl");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId: correctSessionId,
    processUuid: "codex-cwd-rollout-process",
    rolloutPath: correctRolloutPath
  });

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

    const request = "Summarize the release gate";
    const sent = await runAgentCliInProcess([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    fs.writeFileSync(screenPath, "• Working (12s • esc to interrupt)\n");
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;

    const completedRollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: request }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "The release gate is ready."
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-correct-cwd-session",
          last_agent_message: "The release gate is ready."
        }
      })
    ].join("\n");
    const unrelatedRollout = (message: string, turnId: string) => [
      JSON.stringify({
        timestamp: "2099-07-04T00:02:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:03:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: `${message} finished.` }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:03:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turnId,
          last_agent_message: `${message} finished.`
        }
      })
    ].join("\n");

    const monitored = await runAgentCliInProcess([
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
      JSON.stringify([
        {
          id: newestSessionId,
          cwd: workspace,
          rollout_path: newestRolloutPath,
          updated_at_ms: Date.parse("2099-07-04T00:06:00.000Z"),
          archived: false
        },
        {
          id: newerSessionId,
          cwd: workspace,
          rollout_path: newerRolloutPath,
          updated_at_ms: Date.parse("2099-07-04T00:05:00.000Z"),
          archived: false
        },
        {
          id: correctSessionId,
          cwd: workspace,
          rollout_path: correctRolloutPath,
          updated_at_ms: Date.parse("2099-07-04T00:01:01.000Z"),
          archived: false
        }
      ]),
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
        panePid: 999,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": fs.readFileSync(screenPath, "utf8") }),
      "--rollouts-json",
      JSON.stringify({
        [newestRolloutPath]: unrelatedRollout("Newest unrelated task", "turn-newest"),
        [newerRolloutPath]: unrelatedRollout("Newer unrelated task", "turn-newer"),
        [correctRolloutPath]: completedRollout
      }),
      ...nativeIdentityArgs
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.message.body, "The release gate is ready.");
    assert.equal(parsed.message.metadata.match, "rollout_task_complete");
    assert.equal(parsed.message.metadata.context_match, "cwd_request_hash");
    assert.equal(parsed.message.metadata.session.sessionId, correctSessionId);
    assert.equal(parsed.message.metadata.rollout_turn_id, "turn-correct-cwd-session");
    assert.equal(readJsonLines(openclawCallsPath).length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor rejects low-confidence assistant and task_complete for a different request", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-progress-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-low-confidence-process",
    rolloutPath
  });

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

    const sent = await runAgentCliInProcess([
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;
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

    const monitored = await runAgentCliInProcess([
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
        "codex-work:0.1": "› \n"
      }),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout }),
      ...nativeIdentityArgs
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

test("terminal bridge working markers extend inactivity until the hard lifetime", async () => {
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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-working-timeout-process",
    rolloutPath: path.join(tempDir, "codex-working-timeout-rollout.jsonl")
  });

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

    const sent = await runAgentCliInProcess([
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    fs.writeFileSync(screenPath, workingScreen);
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;
    const startedAt = JSON.parse(fs.readFileSync(statePath, "utf8"))
      .native_session_takeover.terminal_bridge_started_at;

    const monitored = await runAgentCliInProcess([
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
      JSON.stringify({ "codex-work:0.1": workingScreen }),
      ...nativeIdentityArgs
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

test("renew restarts a stalled terminal bridge without input and completion callbacks once", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-renew-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-renew-process",
    rolloutPath
  });

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

    const sent = await runAgentCliInProcess([
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversationId = sentParsed.conversation.conversation_id;
    const storedPaths = pathsForConversation(conversationId, storeDir);
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;
    const waitingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(statePath, `${JSON.stringify({
      ...waitingState,
      status: "stalled",
      stalled_at: new Date().toISOString(),
      stalled_reason: "test inactivity timeout",
      stalled_notification_sent_at: new Date().toISOString(),
      stalled_notification_message_id: "msg-stalled"
    }, null, 2)}\n`);

    const missingTerminal = await runAgentCliInProcess([
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
    const renewed = await runAgentCliInProcess([
      "renew",
      "--state",
      statePath,
      "--minutes",
      "5",
      "--agent-hard-timeout-minutes",
      "120",
      ...nativeIdentityArgs,
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
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-renewed-task",
          last_agent_message: "The long task is complete."
        }
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
      ...nativeIdentityArgs,
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout })
    ];
    const monitored = await runAgentCliInProcess(monitorArgs);
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.message.body, "The long task is complete.");
    assert.equal(monitoredParsed.conversation.status, "idle");
    assert.equal(typeof monitoredParsed.conversation.idle_since, "string");

    const monitoredAgain = await runAgentCliInProcess(monitorArgs);
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

test("renew reloads stalled state after pane discovery and cannot overwrite a concurrent close", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-renew-close-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxListGatePath = path.join(tempDir, "tmux-list-gate");
  const terminalTarget = "codex-renew-race:0.1";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-renew-race-process",
    rolloutPath
  });
  let renewing: ReturnType<typeof spawnAgentCliCaptured> | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-renew-race\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:33389`,
      "--message",
      "Create a terminal task that will become stalled",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversationId = sentParsed.conversation.conversation_id;
    const statePath = sentParsed.conversation.state_path;
    const logPath = sentParsed.conversation.event_log_path;
    const waitingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      waitingState.native_session_takeover?.terminal_bridge_submission?.status,
      "agent_accepted"
    );
    fs.writeFileSync(statePath, `${JSON.stringify({
      ...waitingState,
      status: "stalled",
      stalled_at: new Date().toISOString(),
      stalled_reason: "race test inactivity timeout",
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);

    renewing = spawnAgentCliCaptured([
      "renew",
      "--state",
      statePath,
      "--minutes",
      "5",
      "--disable-terminal-bridge-monitor"
    ], {
      ...testEnv,
      AKK_TEST_TMUX_LIST_GATE_PATH: tmuxListGatePath
    });
    const renewDiscovery = await Promise.race([
      waitForCondition(
        () => fs.existsSync(`${tmuxListGatePath}.entered`),
        "renew to load its stale snapshot and enter pane discovery",
        15_000
      ).then(() => ({ kind: "entered" as const })),
      renewing.result.then((result) => ({ kind: "exited" as const, result }))
    ]);
    assert.equal(
      renewDiscovery.kind,
      "entered",
      renewDiscovery.kind === "exited"
        ? renewDiscovery.result.stderr || renewDiscovery.result.stdout
        : undefined
    );

    const closed = await runAgentCliAsync([
      "close",
      "--conversation",
      conversationId,
      "--store-dir",
      storeDir,
      "--reason",
      "closed while renew was checking the pane"
    ], testEnv);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    const closedParsed = JSON.parse(closed.stdout);
    assert.equal(closedParsed.conversation.status, "closed");

    fs.writeFileSync(`${tmuxListGatePath}.release`, "");
    const renewed = await renewing.result;
    assert.notEqual(renewed.status, 0);
    assert.match(renewed.stderr, /conversation is closed, not stalled/u);

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "closed");
    assert.equal(finalState.closed_at, closedParsed.conversation.closed_at);
    assert.equal(finalState.updated_at, closedParsed.conversation.updated_at);
    assert.equal(finalState.close_reason, "closed while renew was checking the pane");
    assert.doesNotMatch(
      fs.readFileSync(logPath, "utf8"),
      /"event":"terminal_bridge_renewed"/u
    );
  } finally {
    fs.writeFileSync(`${tmuxListGatePath}.release`, "");
    killPidBestEffort(renewing?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
