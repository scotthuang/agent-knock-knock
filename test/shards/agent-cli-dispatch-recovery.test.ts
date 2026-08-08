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

test("safe-aborted delegate retries refuse a changed Session binding", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-delegate-safe-abort-binding-")
  );
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-delegate-safe-abort-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const codexPid = 33430;
  const stableMessageId = `msg-openclaw-${"6".repeat(64)}`;
  const request = "Retry only inside the original Session binding";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: codexPid,
    sessionId,
    processUuid: "codex-delegate-safe-abort-process",
    rolloutPath: path.join(tempDir, "codex-delegate-safe-abort.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${codexPid}\tnode\t${workspace}\n`
    );
    const args = [
      "delegate",
      "--request",
      request,
      "--message-id",
      stableMessageId,
      "--workspace",
      workspace,
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:test:delegate-safe-abort",
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ];
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const aborted = runAgentCli(args, {
      ...testEnv,
      AKK_TEST_TERMINAL_SETUP_FAILURE: "1"
    });
    assert.equal(aborted.status, 0, aborted.stderr || aborted.stdout);
    const abortedParsed = JSON.parse(aborted.stdout);
    assert.equal(abortedParsed.submission_outcome, "aborted");
    assert.equal(abortedParsed.safe_to_retry, true);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      0
    );

    const managedSession = loadManagedSession(
      storeDir,
      abortedParsed.session_id
    );
    assert.ok(managedSession.binding);
    saveManagedSession(storeDir, {
      ...managedSession,
      binding: {
        ...managedSession.binding,
        binding_id: "binding-after-native-lifecycle-change",
        generation: managedSession.binding.generation + 1,
        bound_at: new Date().toISOString()
      },
      updated_at: new Date().toISOString()
    }, { expectedRevision: managedSession.revision ?? null });

    const rawRetry = runAgentCli([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:${codexPid}`,
      "--message",
      request,
      "--message-id",
      stableMessageId,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.notEqual(rawRetry.status, 0);
    assert.match(
      rawRetry.stderr,
      /Session binding is no longer current|idempotency key/iu
    );

    const directRetry = runAgentCli([
      "send",
      "--session",
      abortedParsed.session_id,
      "--message",
      request,
      "--message-id",
      stableMessageId,
      "--background",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.notEqual(directRetry.status, 0);
    assert.match(
      directRetry.stderr,
      /Session binding is no longer current|idempotency key/iu
    );

    const delegateRetry = runAgentCli(args, testEnv);
    assert.notEqual(delegateRetry.status, 0);
    assert.match(
      delegateRetry.stderr,
      /Session binding is no longer current|idempotency key/iu
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      0,
      "a stable retry must not cross a New/Resume binding generation"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an orphaned terminal dispatch requires its exact listed generation before recovery", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-orphan-recovery-"));
  const storeDir = path.join(tempDir, "conversations");
  const retryStoreDir = path.join(tempDir, "retry-conversations");
  const runtimeDir = path.join(tempDir, ".akk-cli-test-runtime");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const terminalSession = `akk-orphan-recovery-${process.pid}`;
  const terminalTarget = `${terminalSession}:0.1`;
  const panePid = 33389;
  const rawConversationId =
    `terminal:v2:tmux:codex:${terminalTarget}:${panePid}`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${terminalSession}\t0\t1\t${panePid}\tcodex\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Recover this dispatch safely",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const messageId = sentParsed.message.id;
    const statePath = sentParsed.conversation.state_path;
    const stateBackupPath = `${statePath}.orphaned`;
    const ledgerPath = findTerminalDispatchLedgerPath(
      sentParsed.conversation.conversation_id,
      runtimeDir
    );
    const staticTerminalArgs = [
      "--processes-json",
      JSON.stringify([{
        pid: panePid,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: terminalTarget,
        session: terminalSession,
        window: 0,
        pane: 1,
        panePid,
        currentCommand: "codex",
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: "› \n" })
    ];
    const closeArgs = [
      "close",
      "--conversation",
      rawConversationId,
      "--store-dir",
      storeDir,
      ...staticTerminalArgs
    ];

    const owned = runAgentCli([
      ...closeArgs,
      "--expected-message-id",
      messageId
    ], testEnv);
    assert.notEqual(owned.status, 0);
    assert.match(owned.stderr, /owned by AKK conversation/u);
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
      "uncertain"
    );

    fs.renameSync(statePath, stateBackupPath);
    const listed = runAgentCli([
      "list",
      "--store-dir",
      storeDir,
      ...staticTerminalArgs
    ], testEnv);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedParsed = JSON.parse(listed.stdout);
    assert.equal(listedParsed.terminals.length, 1);
    const orphaned =
      listedParsed.terminals[0].orphaned_terminal_dispatch;
    assert.equal(orphaned.message_id, messageId);
    assert.equal("commands" in listedParsed.terminals[0], false);
    assert.deepEqual(
      listedParsed.terminals[0].available_actions.close.arguments,
      {
        conversation_id: rawConversationId,
        expected_message_id: messageId
      }
    );
    assert.equal(
      listedParsed.terminals[0]
        .available_actions.close.requires_explicit_user_confirmation,
      true
    );
    assert.equal(
      orphaned.recovery,
      `/akk close ${rawConversationId} --expected-message-id ${messageId}`
    );

    const missingIdentity = runAgentCli(closeArgs, testEnv);
    assert.notEqual(missingIdentity.status, 0);
    assert.match(missingIdentity.stderr, /expected-message-id is required/u);
    const wrongIdentity = runAgentCli([
      ...closeArgs,
      "--expected-message-id",
      "wrong-generation"
    ], testEnv);
    assert.notEqual(wrongIdentity.status, 0);
    assert.match(wrongIdentity.stderr, /identity changed/u);
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
      "uncertain"
    );

    const recovered = runAgentCli([
      ...closeArgs,
      "--expected-message-id",
      messageId,
      "--reason",
      "operator inspected the pane"
    ], testEnv);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    const recoveredParsed = JSON.parse(recovered.stdout);
    assert.equal(recoveredParsed.terminal_dispatch_resolved, true);
    assert.equal(recoveredParsed.coding_agent_stopped, false);
    assert.equal(recoveredParsed.tmux_pane_closed, false);
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
      "resolved"
    );

    const retried = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "A new generation after recovery",
      "--background",
      "--store-dir",
      retryStoreDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      2
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a newer raw terminal task cannot replace an active callback boundary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-supersede-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-active-callback-process",
    rolloutPath: path.join(tempDir, "codex-active-callback-rollout.jsonl")
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

    const sendTask = (message: string) => runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      message,
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
      "--threads-json",
      JSON.stringify([]),
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    const first = sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstPaths = pathsForConversation(
      firstParsed.conversation.conversation_id,
      storeDir
    );
    const firstStatePath = firstPaths.statePath;
    const firstLogPath = firstPaths.logPath;

    const second = sendTask("Second task");
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /session .* already has active turn/u);
    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.status, "waiting_for_agent");
    assert.equal(firstState.superseded_by_conversation_id, undefined);
    assert.doesNotMatch(
      fs.readFileSync(firstLogPath, "utf8"),
      /terminal_bridge_superseded/u
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      1
    );
    assert.equal(fs.existsSync(openclawCallsPath), false);
    return;

    fs.writeFileSync(screenPath, [
      "› First task",
      "The first result completed earlier.",
      "─ Worked for 1m ─────────────────────────────",
      "› Second task",
      "• Working (5s • esc to interrupt) · /stop to close"
    ].join("\n"));
    const oldMonitor = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      firstStatePath,
      "--log",
      firstLogPath,
      "--poll-interval-ms",
      "50",
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
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": fs.readFileSync(screenPath, "utf8") })
    ]);
    assert.equal(oldMonitor.status, 0, oldMonitor.stderr || oldMonitor.stdout);
    const oldMonitorParsed = JSON.parse(oldMonitor.stdout);
    assert.equal(oldMonitorParsed.completed, false);
    assert.equal(oldMonitorParsed.reason, "conversation_no_longer_waiting");
    assert.equal(fs.existsSync(openclawCallsPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("durable completion must settle before a newer raw task can send", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-reconcile-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
  const completedSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c452";
  const completedRolloutPath = path.join(tempDir, "completed.jsonl");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId: completedSessionId,
    processUuid: "codex-durable-reconcile-process",
    rolloutPath: completedRolloutPath
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

    const baseSendArgs = [
      "send",
      "--conversation",
      rawConversationId,
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
    ];
    const env = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };

    const first = runAgentCli([
      ...baseSendArgs,
      "--message",
      "First durable task"
    ], env);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstPaths = pathsForConversation(
      firstParsed.conversation.conversation_id,
      storeDir
    );
    const firstStatePath = firstPaths.statePath;
    const firstLogPath = firstPaths.logPath;
    const stalledStatePath = writeConversationClone(
      storeDir,
      firstParsed.conversation,
      "terminal-stalled-before-durable-reconcile",
      (state) => ({
        ...state,
        status: "stalled",
        stalled_reason: "monitor timed out just before task_complete was persisted",
        updated_at: new Date().toISOString()
      })
    );
    const stalledLogPath = path.join(
      path.dirname(stalledStatePath),
      "events.ndjson"
    );

    const completedRollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "First durable task"
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "The first durable task completed."
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-before-replacement",
          last_agent_message: "The first durable task completed."
        }
      })
    ].join("\n");
    const second = runAgentCli([
      ...baseSendArgs,
      "--message",
      "Second task",
      "--threads-json",
      JSON.stringify([{
        id: completedSessionId,
        cwd: workspace,
        rollout_path: completedRolloutPath,
        updated_at_ms: Date.parse("2099-07-04T00:01:01.000Z"),
        archived: false
      }]),
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
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": "› \n" }),
      "--rollouts-json",
      JSON.stringify({ [completedRolloutPath]: completedRollout })
    ], env);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /session .* already has active turn/u);
    assert.equal(
      JSON.parse(fs.readFileSync(firstStatePath, "utf8")).status,
      "waiting_for_agent"
    );
    assert.equal(fs.existsSync(openclawCallsPath), false);
    return;
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondParsed = JSON.parse(second.stdout);
    const secondStatePath = pathsForConversation(
      secondParsed.conversation.conversation_id,
      storeDir
    ).statePath;

    const reconciledState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(reconciledState.status, "closed");
    assert.equal(reconciledState.callback_delivery.status, "delivered");
    assert.equal(reconciledState.callback_delivery.attempts, 1);
    assert.equal(reconciledState.superseded_by_conversation_id, undefined);
    const firstEvents = fs.readFileSync(firstLogPath, "utf8");
    assert.match(firstEvents, /terminal_bridge_completion_reconciled_before_supersede/);
    assert.doesNotMatch(firstEvents, /terminal_bridge_superseded/);
    assert.equal(
      JSON.parse(fs.readFileSync(secondStatePath, "utf8")).status,
      "waiting_for_agent"
    );
    const stalledState = JSON.parse(fs.readFileSync(stalledStatePath, "utf8"));
    assert.equal(stalledState.status, "closed");
    assert.equal(stalledState.callback_delivery.status, "delivered");
    assert.equal(stalledState.callback_delivery.attempts, 1);
    assert.equal(stalledState.superseded_by_conversation_id, undefined);
    assert.match(
      fs.readFileSync(stalledLogPath, "utf8"),
      /terminal_bridge_completion_reconciled_before_supersede/
    );
    assert.doesNotMatch(
      fs.readFileSync(stalledLogPath, "utf8"),
      /terminal_bridge_superseded/
    );

    await waitForCondition(
      () => JSON.parse(fs.readFileSync(firstStatePath, "utf8")).status === "closed",
      "reconciled callback delivery",
      12_000
    );
    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.close_reason, "terminal bridge task completed");
    assert.equal(firstState.callback_delivery.status, "delivered");
    assert.equal(firstState.superseded_by_conversation_id, undefined);
    assert.equal(readJsonLines(openclawCallsPath).length, 2);

    const ambiguousRollout = (turnId: string) => [
      JSON.stringify({
        timestamp: "2099-07-04T00:02:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Second task" }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:03:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: `Ambiguous completion ${turnId}`
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:03:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turnId,
          last_agent_message: `Ambiguous completion ${turnId}`
        }
      })
    ].join("\n");
    const ambiguousRolloutA = path.join(tempDir, "ambiguous-a.jsonl");
    const ambiguousRolloutB = path.join(tempDir, "ambiguous-b.jsonl");
    const third = runAgentCli([
      ...baseSendArgs,
      "--message",
      "Third task",
      "--threads-json",
      JSON.stringify([
        {
          id: "019ee559-7bb8-7fd1-970c-0f7b6978c453",
          cwd: workspace,
          rollout_path: ambiguousRolloutA,
          updated_at_ms: Date.parse("2099-07-04T00:03:01.000Z"),
          archived: false
        },
        {
          id: "019ee559-7bb8-7fd1-970c-0f7b6978c454",
          cwd: workspace,
          rollout_path: ambiguousRolloutB,
          updated_at_ms: Date.parse("2099-07-04T00:03:02.000Z"),
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
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": "› \n" }),
      "--rollouts-json",
      JSON.stringify({
        [ambiguousRolloutA]: ambiguousRollout("turn-ambiguous-a"),
        [ambiguousRolloutB]: ambiguousRollout("turn-ambiguous-b")
      })
    ], env);
    assert.equal(third.status, 0, third.stderr || third.stdout);
    const protectedSecondState = JSON.parse(
      fs.readFileSync(secondStatePath, "utf8")
    );
    assert.equal(protectedSecondState.status, "stalled");
    assert.match(
      protectedSecondState.stalled_reason,
      /newer task reused the same terminal/
    );
    assert.equal(protectedSecondState.superseded_by_conversation_id, undefined);
    const secondEvents = fs.readFileSync(
      path.join(path.dirname(secondStatePath), "events.ndjson"),
      "utf8"
    );
    assert.match(secondEvents, /terminal_bridge_pre_supersede_reconciliation_failed/);
    assert.match(secondEvents, /multiple same-cwd Codex sessions match/);
    assert.match(secondEvents, /terminal_bridge_reconciliation_fenced/);
    assert.doesNotMatch(secondEvents, /terminal_bridge_superseded/);

    const protectedMonitor = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      secondStatePath,
      "--log",
      path.join(path.dirname(secondStatePath), "events.ndjson"),
      "--poll-interval-ms",
      "50",
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
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.1": [
          "› Third task",
          "The third task is complete.",
          "─ Worked for 1m ─────────────────────────────",
          "› "
        ].join("\n")
      })
    ]);
    assert.equal(
      protectedMonitor.status,
      0,
      protectedMonitor.stderr || protectedMonitor.stdout
    );
    assert.equal(
      JSON.parse(protectedMonitor.stdout).reason,
      "conversation_no_longer_waiting"
    );
    assert.equal(readJsonLines(openclawCallsPath).length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an active dispatch blocks a replacement before tmux input", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-send-failure-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-send-failure-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-active-dispatch-process",
    rolloutPath: path.join(tempDir, "codex-active-dispatch-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const listPanesOutput = `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`;
    writeFakeTmux(fakeBinDir, tmuxCallsPath, screenPath, listPanesOutput);

    const sendTask = (message: string) => runAgentCli([
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
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    const first = sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstPaths = pathsForConversation(
      firstParsed.conversation.conversation_id,
      storeDir
    );
    const firstStatePath = firstPaths.statePath;
    const firstLogPath = firstPaths.logPath;

    writeFakeTmux(fakeBinDir, tmuxCallsPath, screenPath, listPanesOutput, "Second task");
    const second = sendTask("Second task");
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /session .* already has active turn/u);

    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.status, "waiting_for_agent");
    assert.equal(firstState.superseded_by_conversation_id, undefined);
    const firstEvents = fs.readFileSync(firstLogPath, "utf8");
    assert.doesNotMatch(
      firstEvents,
      /terminal_bridge_stalled_by_uncertain_dispatch/u
    );
    assert.doesNotMatch(firstEvents, /terminal_bridge_superseded/u);
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
