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
  runAgentCli,
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

test("an active managed task blocks a follow-up before tmux input", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-managed-send-failure-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-managed-failure-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-active-managed-process",
    rolloutPath: path.join(tempDir, "codex-active-managed-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const listPanesOutput = `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`;
    writeFakeTmux(fakeBinDir, tmuxCallsPath, screenPath, listPanesOutput);
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const first = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "First managed task",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const managedSessionId = firstParsed.conversation.session_id;
    const statePath = firstParsed.conversation.state_path;
    const firstMessageId =
      firstParsed.conversation.native_session_takeover
        .terminal_bridge_message_id;

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      listPanesOutput,
      "Second managed task"
    );
    const second = runAgentCli([
      "send",
      "--session",
      managedSessionId,
      "--message",
      "Second managed task",
      "--background",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.notEqual(second.status, 0);
    assert.match(
      second.stderr,
      /terminal .* still has unresolved Turn .* \(waiting_for_agent\)/u
    );

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      state.native_session_takeover.terminal_bridge_message_id,
      firstMessageId
    );
    assert.equal(
      state.native_session_takeover.terminal_bridge_request_text,
      "First managed task"
    );
    assert.equal(
      state.native_session_takeover.terminal_bridge_submission.status,
      "agent_accepted"
    );
    assert.equal(
      state.native_session_takeover.terminal_bridge_submission.message_id,
      firstMessageId
    );
    assert.equal(state.status, "waiting_for_agent");
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed pre-submit setup failure restores the previous boundary and is retryable", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-managed-send-abort-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-managed-abort-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-managed-abort-process",
    rolloutPath: path.join(tempDir, "codex-managed-abort-rollout.jsonl")
  });
  const stableRetryMessageId = `msg-openclaw-${"9".repeat(64)}`;

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
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const first = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "First managed task",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const managedSessionId = firstParsed.conversation.session_id;
    const statePath = firstParsed.conversation.state_path;
    const firstMessageId =
      firstParsed.conversation.native_session_takeover
        .terminal_bridge_message_id;
    const entersBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    const idleAt = new Date().toISOString();
    const firstState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        ...firstState,
        status: "idle",
        idle_since: idleAt,
        updated_at: idleAt
      }, null, 2)}\n`
    );
    const secondArgs = [
      "send",
      "--session",
      managedSessionId,
      "--message",
      "Second managed task",
      "--message-id",
      stableRetryMessageId,
      "--background",
      "--store-dir",
      storeDir,
      "--idle-timeout-minutes",
      "0",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ];
    const second = runAgentCli(secondArgs, {
      ...testEnv,
      AKK_TEST_TERMINAL_SETUP_FAILURE: "1"
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondParsed = JSON.parse(second.stdout);
    assert.equal(secondParsed.submission_outcome, "aborted");
    assert.equal(secondParsed.safe_to_retry, true);
    assert.equal(secondParsed.delivered, false);
    assert.equal(secondParsed.session_id, managedSessionId);
    assert.notEqual(secondParsed.turn_id, firstParsed.turn_id);
    assert.notEqual(
      secondParsed.conversation.state_path,
      statePath
    );

    const firstAfterFailure = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      firstAfterFailure.native_session_takeover.terminal_bridge_message_id,
      firstMessageId
    );
    assert.equal(
      firstAfterFailure.native_session_takeover.terminal_bridge_request_text,
      "First managed task"
    );
    assert.equal(
      firstAfterFailure.native_session_takeover.terminal_bridge_submission.status,
      "agent_accepted"
    );
    assert.equal(firstAfterFailure.status, "idle");
    const secondState = JSON.parse(
      fs.readFileSync(secondParsed.conversation.state_path, "utf8")
    );
    assert.equal(secondState.user_request, "Second managed task");
    assert.equal(
      secondState.native_session_takeover.terminal_bridge_submission.status,
      "aborted"
    );
    assert.equal(secondState.status, "idle");
    const entersAfter = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    assert.equal(entersAfter, entersBefore);

    const monitoringState = {
      ...secondState,
      status: "waiting_for_agent",
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(
      secondParsed.conversation.state_path,
      `${JSON.stringify(monitoringState, null, 2)}\n`
    );
    const monitoredAbort = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      secondParsed.conversation.state_path,
      "--log",
      secondParsed.conversation.event_log_path,
      "--store-dir",
      storeDir,
      "--poll-interval-ms",
      "50"
    ], testEnv);
    assert.equal(
      monitoredAbort.status,
      0,
      monitoredAbort.stderr || monitoredAbort.stdout
    );
    const monitoredAbortParsed = JSON.parse(monitoredAbort.stdout);
    assert.equal(
      monitoredAbortParsed.submission_outcome,
      "aborted",
      monitoredAbort.stdout
    );
    assert.equal(monitoredAbortParsed.safe_to_retry, true);
    assert.equal(monitoredAbortParsed.do_not_retry, false);
    const unsafeMonitoringState = structuredClone(monitoringState);
    unsafeMonitoringState.native_session_takeover
      .terminal_bridge_submission.safe_to_retry = false;
    unsafeMonitoringState.native_session_takeover
      .terminal_bridge_submission_receipts = unsafeMonitoringState
        .native_session_takeover.terminal_bridge_submission_receipts
        .map((receipt) => receipt.message_id === stableRetryMessageId
          ? { ...receipt, safe_to_retry: false }
          : receipt);
    fs.writeFileSync(
      secondParsed.conversation.state_path,
      `${JSON.stringify(unsafeMonitoringState, null, 2)}\n`
    );
    const monitoredUnsafeAbort = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      secondParsed.conversation.state_path,
      "--log",
      secondParsed.conversation.event_log_path,
      "--store-dir",
      storeDir,
      "--poll-interval-ms",
      "50"
    ], testEnv);
    assert.equal(
      monitoredUnsafeAbort.status,
      0,
      monitoredUnsafeAbort.stderr || monitoredUnsafeAbort.stdout
    );
    const monitoredUnsafeAbortParsed = JSON.parse(
      monitoredUnsafeAbort.stdout
    );
    assert.equal(monitoredUnsafeAbortParsed.submission_outcome, "aborted");
    assert.equal(monitoredUnsafeAbortParsed.safe_to_retry, false);
    assert.equal(monitoredUnsafeAbortParsed.do_not_retry, true);
    fs.writeFileSync(
      secondParsed.conversation.state_path,
      `${JSON.stringify(secondState, null, 2)}\n`
    );

    const retried = runAgentCli(secondArgs, testEnv);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    const retriedParsed = JSON.parse(retried.stdout);
    assert.equal(retriedParsed.delivered, true);
    assert.equal(retriedParsed.delivery_receipt, "agent_accepted");
    assert.equal(retriedParsed.message.id, stableRetryMessageId);
    assert.notEqual(retriedParsed.replayed, true);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      entersBefore + 1,
      "a same-key retry after a proven pre-tmux abort dispatches Enter exactly once"
    );
    const replayedRetry = runAgentCli(secondArgs, testEnv);
    assert.equal(
      replayedRetry.status,
      0,
      replayedRetry.stderr || replayedRetry.stdout
    );
    assert.equal(JSON.parse(replayedRetry.stdout).replayed, true);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      entersBefore + 1
    );

    const retriedStatePath = retriedParsed.conversation.state_path;
    const retriedState = JSON.parse(fs.readFileSync(retriedStatePath, "utf8"));
    const retryIdleAt = new Date().toISOString();
    fs.writeFileSync(
      retriedStatePath,
      `${JSON.stringify({
        ...retriedState,
        status: "idle",
        idle_since: retryIdleAt,
        updated_at: retryIdleAt
      }, null, 2)}\n`
    );
    const unsafeMessageId = `msg-openclaw-${"8".repeat(64)}`;
    const unsafeAbort = runAgentCli([
      "send",
      "--session",
      managedSessionId,
      "--message",
      "Third managed task",
      "--message-id",
      unsafeMessageId,
      "--background",
      "--store-dir",
      storeDir,
      "--idle-timeout-minutes",
      "0",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      ...testEnv,
      AKK_TEST_TERMINAL_SETUP_FAILURE: "1",
      AKK_TEST_ABORTED_STATE_PERSISTENCE_FAILURE: "1"
    });
    assert.equal(unsafeAbort.status, 0, unsafeAbort.stderr || unsafeAbort.stdout);
    const unsafeAbortParsed = JSON.parse(unsafeAbort.stdout);
    assert.equal(unsafeAbortParsed.submission_outcome, "aborted");
    assert.equal(unsafeAbortParsed.safe_to_retry, false);
    assert.equal(unsafeAbortParsed.do_not_retry, true);
    assert.equal(
      unsafeAbortParsed.conversation.native_session_takeover
        .terminal_bridge_submission.safe_to_retry,
      false
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(unsafeAbortParsed.conversation.state_path, "utf8")
      ).native_session_takeover.terminal_bridge_submission.status,
      "prepared",
      "a failed aborted-receipt write must not be reported as a durable safe abort"
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      entersBefore + 1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("concurrent raw terminal sends allow exactly one active generation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-concurrent-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-concurrent-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-concurrent-send-process",
    rolloutPath: path.join(tempDir, "codex-concurrent-send-rollout.jsonl")
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
      "--threads-json",
      JSON.stringify([]),
      ...nativeIdentityArgs,
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
    assert.deepEqual(
      [first.status, second.status].sort(),
      [0, 1]
    );
    const rejected = first.status === 0 ? second : first;
    assert.match(
      rejected.stderr,
      /terminal .* still has unresolved Turn .* \(waiting_for_agent\)/u
    );

    const states = fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(storeConversationsDir(storeDir), entry.name, "state.json"))
      .filter((statePath) => fs.existsSync(statePath))
      .map((statePath) =>
        JSON.parse(fs.readFileSync(statePath, "utf8"))
      );
    const active = states.filter((state) => state.status === "waiting_for_agent");
    assert.equal(active.length, 1);

    const calls = readJsonLines(tmuxCallsPath);
    const literalSendIndexes = calls
      .map((call, index) => call.args.includes("-l") ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(literalSendIndexes.length, 1);
    assert.equal(
      calls.filter((call) =>
        call.args[0] === "send-keys" &&
        call.args.at(-1) === "C-m"
      ).length,
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("native thread Store authority spans concurrent terminal sends", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-cross-store-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-cross-store-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-cross-store-owner-process",
    rolloutPath: path.join(tempDir, "codex-cross-store-owner-rollout.jsonl")
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
    const sendArgs = (message: string, storeDir: string) => [
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ];
    const env = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_TMUX_SEND_DELAY_MS: "300"
    };

    const [first, second] = await Promise.all([
      runAgentCliAsync(sendArgs("Cross-store identical task", firstStoreDir), env),
      runAgentCliAsync(sendArgs("Cross-store identical task", secondStoreDir), env)
    ]);
    assert.deepEqual(
      [first.status, second.status].sort(),
      [0, 1]
    );
    const rejected = first.status === 0 ? second : first;
    const accepted = first.status === 0 ? first : second;
    const acceptedStoreDir = first.status === 0
      ? firstStoreDir
      : secondStoreDir;
    const rejectedStoreDir = first.status === 0
      ? secondStoreDir
      : firstStoreDir;
    assert.match(
      rejected.stderr,
      /authoritative in another Store/u
    );
    const acceptedParsed = JSON.parse(accepted.stdout);
    assert.notEqual(acceptedParsed.replayed, true);
    assert.equal(
      acceptedParsed.message.conversation_id,
      acceptedParsed.conversation.turn_id
    );
    assert.equal(
      acceptedParsed.message.session_id,
      acceptedParsed.conversation.session_id
    );
    assert.equal(
      acceptedParsed.message.turn_id,
      acceptedParsed.conversation.turn_id
    );
    assert.equal(
      listManagedSessions(rejectedStoreDir).length,
      0,
      "the rejected Store must not retain a duplicate Session"
    );
    assert.equal(
      listConversations(rejectedStoreDir).length,
      0,
      "the rejected Store must not retain a duplicate Turn"
    );
    const sessions = [
      ...listManagedSessions(acceptedStoreDir),
      ...listManagedSessions(rejectedStoreDir)
    ];
    assert.equal(sessions.length, 1);
    assert.equal(
      sessions.filter((session) =>
        session.binding?.native_thread_id === sessionId
      ).length,
      1
    );

    const calls = readJsonLines(tmuxCallsPath);
    const literalSendIndexes = calls
      .map((call, index) => call.args.includes("-l") ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(literalSendIndexes.length, 1);
    assert.equal(
      calls.filter((call) =>
        call.args[0] === "send-keys" &&
        call.args.at(-1) === "C-m"
      ).length,
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("only the uncertain owner can resolve its fence without moving native Store authority", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-cross-store-fence-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const thirdStoreDir = path.join(tempDir, "third-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-cross-store-fence-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const listPanesOutput =
    `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-cross-store-fence-process",
    rolloutPath: path.join(tempDir, "codex-cross-store-fence-rollout.jsonl")
  });
  let dispatchLedgerPath: string | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(
      fakeBinDir,
      openclawCallsPath
    );
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      listPanesOutput
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sendArgs = (
      message: string,
      storeDir: string,
      withCallback = false
    ) => [
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      withCallback ? openclawBin : "/usr/bin/true",
      ...(withCallback
        ? [
            "--gateway-method",
            "agent-knock-knock.callback",
            "--gateway-session",
            "agent:channel:original",
            "--openclaw-session",
            "agent:channel:original"
          ]
        : []),
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ];

    const first = runAgentCli(
      sendArgs("First cross-store task", firstStoreDir, true),
      testEnv
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = firstParsed.conversation.state_path;
    dispatchLedgerPath = findTerminalDispatchLedgerPath(
      firstParsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      listPanesOutput,
      "Second cross-store task",
      true
    );
    const second = runAgentCli(
      sendArgs("Second cross-store task", secondStoreDir),
      testEnv
    );
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /authoritative in another Store/u);
    assert.equal(listManagedSessions(secondStoreDir).length, 0);
    assert.equal(listConversations(secondStoreDir).length, 0);
    assert.equal(
      JSON.parse(fs.readFileSync(firstStatePath, "utf8")).status,
      "waiting_for_agent"
    );

    const oldClosed = runAgentCli([
      "close",
      "--conversation",
      firstParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir,
      ...nativeIdentityArgs,
      "--reason",
      "closing the old cross-store generation"
    ], testEnv);
    assert.equal(oldClosed.status, 0, oldClosed.stderr || oldClosed.stdout);
    assert.equal(
      JSON.parse(oldClosed.stdout).terminal_dispatch_resolved,
      true
    );

    const uncertain = runAgentCli(
      sendArgs("Second cross-store task", firstStoreDir),
      testEnv
    );
    assert.equal(
      uncertain.status,
      0,
      uncertain.stderr || uncertain.stdout
    );
    const secondParsed = JSON.parse(uncertain.stdout);
    assert.equal(secondParsed.submission_outcome, "uncertain");
    assert.equal(secondParsed.do_not_retry, true);

    const staleClose = runAgentCli([
      "close",
      "--conversation",
      firstParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir,
      ...nativeIdentityArgs,
      "--reason",
      "stale owner cannot resolve the replacement generation"
    ], testEnv);
    assert.equal(
      staleClose.status,
      0,
      staleClose.stderr || staleClose.stdout
    );
    assert.equal(
      JSON.parse(staleClose.stdout).terminal_dispatch_resolved,
      false
    );

    const blocked = runAgentCli(
      sendArgs("Third cross-store task", thirdStoreDir),
      testEnv
    );
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /authoritative in another Store/u);
    assert.equal(listManagedSessions(thirdStoreDir).length, 0);
    assert.equal(listConversations(thirdStoreDir).length, 0);

    const ownerClosed = runAgentCli([
      "close",
      "--conversation",
      secondParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir,
      ...nativeIdentityArgs,
      "--reason",
      "operator inspected the uncertain terminal dispatch"
    ], testEnv);
    assert.equal(
      ownerClosed.status,
      0,
      ownerClosed.stderr || ownerClosed.stdout
    );
    assert.equal(
      JSON.parse(ownerClosed.stdout).terminal_dispatch_resolved,
      true
    );

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      listPanesOutput
    );
    const third = runAgentCli(
      sendArgs("Third cross-store task", firstStoreDir),
      testEnv
    );
    assert.equal(third.status, 0, third.stderr || third.stdout);
    assert.equal(JSON.parse(third.stdout).delivered, true);
    assert.equal(listManagedSessions(firstStoreDir).length, 1);
    assert.equal(listManagedSessions(secondStoreDir).length, 0);
    assert.equal(listManagedSessions(thirdStoreDir).length, 0);
    assert.equal(listConversations(secondStoreDir).length, 0);
    assert.equal(listConversations(thirdStoreDir).length, 0);
    assert.equal(
      [
        ...listManagedSessions(firstStoreDir),
        ...listManagedSessions(secondStoreDir),
        ...listManagedSessions(thirdStoreDir)
      ].filter((session) =>
        session.binding?.native_thread_id === sessionId
      ).length,
      1
    );
  } finally {
    if (dispatchLedgerPath) {
      fs.rmSync(dispatchLedgerPath, { force: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
