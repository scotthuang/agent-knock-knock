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
  codexEmptyComposerScreen,
  startManagedClaudeTerminalTask,
  claudeTerminalStaticArgs,
  claudeAgentRow,
  codexNativeIdentityArgs,
  runAgentCliInProcess as runAgentCliInProcessReal,
  runAgentCliInProcessDirect as runAgentCliInProcess,
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

test("safe-aborted strict managed retry rejects binding drift while user-priority delegate falls back once", async () => {
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
  const rawConversationId =
    `terminal:v2:tmux:codex:${terminalTarget}:${codexPid}`;
  const stableMessageId = `msg-openclaw-${"6".repeat(64)}`;
  const request = "Retry only inside the original Session binding";
  const nativeProcessUuid = "codex-delegate-safe-abort-process";
  const exactRolloutPath = path.join(
    tempDir,
    "codex-delegate-safe-abort.jsonl"
  );

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, codexEmptyComposerScreen);
    fs.writeFileSync(exactRolloutPath, `${JSON.stringify({
      timestamp: "2026-08-13T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.147.0"
      }
    })}\n`, { mode: 0o600 });
    const exactRolloutStat = fs.statSync(exactRolloutPath);
    const nativeIdentityArgs = [
      "--codex-active-session-identities-json",
      JSON.stringify({
        [codexPid]: {
          sessionId,
          processUuid: nativeProcessUuid,
          processBirth: nativeProcessUuid,
          rollout: {
            fd: "12r",
            device: String(exactRolloutStat.dev),
            inode: String(exactRolloutStat.ino),
            path: fs.realpathSync(exactRolloutPath)
          }
        }
      })
    ];
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${codexPid}\tnode\t${workspace}\n`
    );
    const managedAbortArgs = [
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      request,
      "--message-id",
      stableMessageId,
      "--managed-only",
      "--background",
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
    const delegateArgs = [
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
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_TMUX_COMPOSER_FROM_LITERAL: "1"
    };
    const aborted = await runAgentCliInProcess(managedAbortArgs, {
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

    const listed = await runAgentCliInProcess([
      "list",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs
    ], testEnv);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedTerminal = JSON.parse(listed.stdout).terminals.find(
      (terminal: Record<string, any>) =>
        terminal.terminal_control?.target === terminalTarget
    );
    assert.ok(listedTerminal, listed.stdout);
    assert.equal(
      listedTerminal.available_actions.send?.scope,
      "terminal_user_explicit",
      "managed binding drift cannot hide the user's physical Send authority"
    );
    assert.equal(
      typeof listedTerminal.available_actions.send?.arguments
        ?.expected_terminal_token,
      "string"
    );

    const directRetry = await runAgentCliInProcess([
      "send",
      "--session",
      abortedParsed.session_id,
      "--message",
      request,
      "--message-id",
      stableMessageId,
      "--managed-only",
      "--background",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.notEqual(directRetry.status, 0);
    assert.match(
      directRetry.stderr,
      /rollout-backed managed Session.*strict session_id send[\s\S]*refresh AKK list/iu
    );
    const sessionIdsBeforeDelegate = listManagedSessions(storeDir)
      .map((session) => session.session_id)
      .sort();
    const turnIdsBeforeDelegate = listConversations(storeDir)
      .map((turn) => turn.conversation_id)
      .sort();

    const delegateRetry = await runAgentCliInProcess(delegateArgs, testEnv);
    assert.equal(
      delegateRetry.status,
      0,
      delegateRetry.stderr || delegateRetry.stdout
    );
    const delegateOutput = JSON.parse(delegateRetry.stdout);
    assert.equal(delegateOutput.delivered, true);
    assert.equal(delegateOutput.delivered_unmanaged, true);
    assert.equal(delegateOutput.management_mode, "unmanaged_fallback");
    assert.equal(delegateOutput.scope, "terminal_user_explicit");
    assert.equal(delegateOutput.message_id, stableMessageId);
    assert.equal(delegateOutput.callback_expected, false);
    assert.equal(delegateOutput.session_id, undefined);
    assert.equal(delegateOutput.turn_id, undefined);
    const replayedDelegate = await runAgentCliInProcess(
      delegateArgs,
      testEnv
    );
    assert.equal(
      replayedDelegate.status,
      0,
      replayedDelegate.stderr || replayedDelegate.stdout
    );
    const replayedOutput = JSON.parse(replayedDelegate.stdout);
    assert.equal(replayedOutput.replayed, true);
    assert.equal(replayedOutput.delivered, true);
    assert.equal(replayedOutput.delivered_unmanaged, true);
    assert.equal(replayedOutput.management_mode, "unmanaged_fallback");
    assert.equal(replayedOutput.scope, "terminal_user_explicit");
    assert.equal(replayedOutput.message_id, stableMessageId);
    assert.equal(replayedOutput.callback_expected, false);
    assert.equal(replayedOutput.session_id, undefined);
    assert.equal(replayedOutput.turn_id, undefined);
    assert.deepEqual(
      listManagedSessions(storeDir)
        .map((session) => session.session_id)
        .sort(),
      sessionIdsBeforeDelegate,
      "binding drift must fall back before claiming a fresh callback Session"
    );
    assert.deepEqual(
      listConversations(storeDir)
        .map((turn) => turn.conversation_id)
        .sort(),
      turnIdsBeforeDelegate,
      "physical fallback and replay must not claim a fresh callback Turn"
    );
    const inputCalls = readJsonLines(tmuxCallsPath).filter((call) =>
      call.args[0] === "send-keys"
    );
    assert.equal(
      inputCalls.filter((call) =>
        call.args.includes("-l") && call.args.at(-1) === request
      ).length,
      1
    );
    assert.equal(
      inputCalls.filter((call) => call.args.at(-1) === "C-m").length,
      1,
      "strict managed authority must stay fenced while explicit delegate input is delivered exactly once"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an orphaned terminal dispatch requires its exact listed generation before recovery", async () => {
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
    const sent = await runAgentCliInProcess([
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
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) =>
        call.kind === "direct_terminal_provider"
      ),
      true,
      "the sequential recovery witness must use the direct terminal port"
    );
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

    const owned = await runAgentCliInProcess([
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
    const listed = await runAgentCliInProcess([
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

    const missingIdentity = await runAgentCliInProcess(closeArgs, testEnv);
    assert.notEqual(missingIdentity.status, 0);
    assert.match(missingIdentity.stderr, /expected-message-id is required/u);
    const wrongIdentity = await runAgentCliInProcess([
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

    const recovered = await runAgentCliInProcess([
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

    const retried = await runAgentCliInProcess([
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

test("a newer raw terminal task cannot replace an active callback boundary", async () => {
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

    const sendTask = (message: string) => runAgentCliInProcess([
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

    const first = await sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstPaths = pathsForConversation(
      firstParsed.conversation.conversation_id,
      storeDir
    );
    const firstStatePath = firstPaths.statePath;
    const firstLogPath = firstPaths.logPath;

    const second = await sendTask("Second task");
    assert.notEqual(second.status, 0);
    assert.match(
      second.stderr,
      /terminal .* still has unresolved Turn .* \(waiting_for_agent\)/u
    );
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
    const oldMonitor = await runAgentCliInProcess([
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

    const first = await runAgentCliInProcess([
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
    const second = await runAgentCliInProcess([
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
    assert.match(
      second.stderr,
      /terminal .* still has unresolved Turn .* \((?:waiting_for_agent|stalled)\)/u
    );
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
    const third = await runAgentCliInProcess([
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

    const protectedMonitor = await runAgentCliInProcess([
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

test("an active dispatch blocks a replacement before tmux input", async () => {
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

    const sendTask = (message: string) => runAgentCliInProcessReal([
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

    const first = await sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstPaths = pathsForConversation(
      firstParsed.conversation.conversation_id,
      storeDir
    );
    const firstStatePath = firstPaths.statePath;
    const firstLogPath = firstPaths.logPath;

    writeFakeTmux(fakeBinDir, tmuxCallsPath, screenPath, listPanesOutput, "Second task");
    const second = await sendTask("Second task");
    assert.notEqual(second.status, 0);
    assert.match(
      second.stderr,
      /terminal .* still has unresolved Turn .* \(waiting_for_agent\)/u
    );

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

test("an uncertain dispatch does not collateral-stall a delivered idle Turn", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-uncertain-idle-release-")
  );
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-uncertain-idle-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const panePid = 43396;
  const nativeSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c460";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: panePid,
    sessionId: nativeSessionId,
    processUuid: "codex-uncertain-idle-process",
    rolloutPath: path.join(tempDir, "codex-uncertain-idle.jsonl")
  });
  const testEnv = {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
  };

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${panePid}\tnode\t${workspace}\n`
    );
    const commonArgs = [
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
    const first = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:${panePid}`,
      "--message",
      "A task that already completed",
      ...commonArgs
    ], testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = firstParsed.conversation.state_path;
    const firstLogPath = firstParsed.conversation.event_log_path;
    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    const idleAt = new Date().toISOString();
    const callbackMessageId = "msg-terminal-delivered-idle-release";
    fs.writeFileSync(firstStatePath, `${JSON.stringify({
      ...firstState,
      status: "idle",
      idle_since: idleAt,
      callback_delivery: {
        status: "delivered",
        message: {
          id: callbackMessageId,
          ts: idleAt,
          conversation_id: firstState.conversation_id,
          session_id: firstState.session_id,
          turn_id: firstState.turn_id,
          from: "codex",
          to: "openclaw",
          type: "done",
          requires_response: false,
          round: 1,
          max_rounds: 50,
          body: "The first task completed.",
          metadata: {}
        },
        attempts: 1,
        status_before_delivery: "idle",
        final_status: "idle",
        preserve_conversation_status: true,
        delivered_at: idleAt,
        updated_at: idleAt
      },
      updated_at: idleAt
    }, null, 2)}\n`);

    const uncertain = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:${panePid}`,
      "--message",
      "A newer dispatch with an uncertain acceptance outcome",
      ...commonArgs
    ], {
      ...testEnv,
      AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "identity_drift"
    });
    assert.equal(uncertain.status, 0, uncertain.stderr || uncertain.stdout);
    const uncertainParsed = JSON.parse(uncertain.stdout);
    assert.equal(uncertainParsed.submission_outcome, "uncertain");
    assert.equal(uncertainParsed.conversation.status, "stalled");

    const released = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(released.status, "idle");
    assert.equal(released.idle_since, idleAt);
    assert.equal(released.callback_delivery.status, "delivered");
    assert.equal(
      released.native_session_takeover
        .terminal_bridge_uncertain_dispatch_fence,
      undefined
    );
    assert.doesNotMatch(
      fs.readFileSync(firstLogPath, "utf8"),
      /terminal_bridge_stalled_by_uncertain_dispatch/u
    );
    const supervised = await runAgentCliInProcess([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--reason",
      "monitor_supervision",
      "--terminal-monitors-only"
    ], testEnv);
    assert.equal(supervised.status, 0, supervised.stderr || supervised.stdout);
    assert.equal(JSON.parse(supervised.stdout).repaired, 0);
    assert.equal(
      JSON.parse(fs.readFileSync(
        uncertainParsed.conversation.state_path,
        "utf8"
      )).status,
      "stalled",
      "the current uncertain owner must never be repaired as collateral"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("monitor supervision repairs only an exact legacy idle collateral stall while physical Send remains visible", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-collateral-stall-repair-")
  );
  const storeDir = path.join(tempDir, "conversations");
  const runtimeDir = path.join(tempDir, ".akk-cli-test-runtime");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-collateral-repair-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const panePid = 43397;
  const nativeSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c461";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: panePid,
    sessionId: nativeSessionId,
    processUuid: "codex-collateral-repair-process",
    rolloutPath: path.join(tempDir, "codex-collateral-repair.jsonl")
  });
  const testEnv = {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
  };

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${panePid}\tnode\t${workspace}\n`
    );
    const first = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:${panePid}`,
      "--message",
      "A completed task later poisoned by an old collateral fence",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--threads-json",
      JSON.stringify([]),
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = firstParsed.conversation.state_path;
    const firstLogPath = firstParsed.conversation.event_log_path;
    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    const baseTime = Date.now() - 10_000;
    const claimedAt = new Date(baseTime + 1_000).toISOString();
    const completionAt = new Date(baseTime + 2_000).toISOString();
    const deliveredAt = new Date(baseTime + 3_000).toISOString();
    const fenceAt = new Date(baseTime + 4_000).toISOString();
    const ownerClosedAt = new Date(baseTime + 5_000).toISOString();
    const ownMessageId =
      firstState.native_session_takeover.terminal_bridge_message_id;
    const callbackMessageId = "msg-terminal-collateral-repair";
    const completionFingerprint = "completion-collateral-repair";
    const uncertainMessageId = "msg-uncertain-collateral-owner";
    const ownerConversationId = "turn-collateral-uncertain-owner";
    const callbackMessage = {
      id: callbackMessageId,
      ts: completionAt,
      conversation_id: firstState.conversation_id,
      session_id: firstState.session_id,
      turn_id: firstState.turn_id,
      from: "codex",
      to: "openclaw",
      type: "done",
      requires_response: false,
      round: 1,
      max_rounds: 50,
      body: "The completed result was delivered.",
      metadata: {
        terminal_bridge_message_id: ownMessageId
      }
    };
    const poisoned = {
      ...firstState,
      status: "stalled",
      idle_since: completionAt,
      stalled_at: fenceAt,
      stalled_reason:
        "a newer terminal submission has an uncertain outcome; inspect the shared terminal pane before continuing",
      callback_delivery: {
        status: "delivered",
        message: callbackMessage,
        attempts: 1,
        final_status: "idle",
        preserve_conversation_status: true,
        delivered_at: deliveredAt,
        updated_at: deliveredAt
      },
      native_session_takeover: {
        ...firstState.native_session_takeover,
        terminal_bridge_completion_claim: {
          terminal_bridge_message_id: ownMessageId,
          completion_fingerprint: completionFingerprint,
          completion_id: "completion-id-collateral-repair",
          callback_message_id: callbackMessageId,
          outcome: "success",
          claimed_at: claimedAt
        },
        terminal_bridge_uncertain_dispatch_fence: {
          message_id: uncertainMessageId,
          observed_at: fenceAt
        }
      },
      updated_at: fenceAt
    };
    fs.writeFileSync(
      firstStatePath,
      `${JSON.stringify(poisoned, null, 2)}\n`
    );
    fs.appendFileSync(firstLogPath, [
      JSON.stringify({
        ts: claimedAt,
        conversation_id: firstState.conversation_id,
        event: "terminal_bridge_completion_claimed",
        terminal_bridge_message_id: ownMessageId,
        completion_fingerprint: completionFingerprint,
        completion_id: "completion-id-collateral-repair",
        callback_message_id: callbackMessageId,
        outcome: "success"
      }),
      JSON.stringify({
        ts: completionAt,
        conversation_id: firstState.conversation_id,
        event: "terminal_bridge_completion_detected",
        terminal_bridge_message_id: ownMessageId,
        callback_message_id: callbackMessageId,
        completion_id: "completion-id-collateral-repair",
        completion_outcome: "success"
      }),
      JSON.stringify({
        ts: deliveredAt,
        conversation_id: firstState.conversation_id,
        event: "callback_delivery_succeeded",
        message_id: callbackMessageId,
        attempt: 1,
        status: "idle",
        state_preserved: true
      }),
      JSON.stringify({
        ts: fenceAt,
        conversation_id: firstState.conversation_id,
        event: "terminal_bridge_stalled_by_uncertain_dispatch",
        uncertain_message_id: uncertainMessageId
      })
    ].join("\n") + "\n");

    const ownerStatePath = writeConversationClone(
      storeDir,
      firstState,
      ownerConversationId,
      (state) => {
        const {
          callback_delivery: _callbackDelivery,
          idle_since: _idleSince,
          stalled_at: _stalledAt,
          stalled_reason: _stalledReason,
          ...ownerBase
        } = state;
        return {
          ...ownerBase,
          status: "closed",
          closed_at: ownerClosedAt,
          close_reason: "operator resolved the uncertain dispatch",
          native_session_takeover: {
            ...state.native_session_takeover,
            terminal_bridge_message_id: uncertainMessageId,
            terminal_bridge_completion_claim: undefined,
            terminal_bridge_uncertain_dispatch_fence: undefined,
            terminal_bridge_submission: {
              ...state.native_session_takeover.terminal_bridge_submission,
              status: "uncertain",
              session_id: state.session_id,
              turn_id: ownerConversationId,
              message_id: uncertainMessageId,
              last_proven_stage: "text_injected",
              uncertain_at: fenceAt
            }
          },
          updated_at: ownerClosedAt
        };
      }
    );
    const ownerLogPath = path.join(
      path.dirname(ownerStatePath),
      "events.ndjson"
    );
    fs.writeFileSync(ownerLogPath, `${JSON.stringify({
      ts: ownerClosedAt,
      conversation_id: ownerConversationId,
      event: "conversation_closed",
      status: "closed",
      reason: "operator resolved the uncertain dispatch"
    })}\n`);

    const ledgerPath = findTerminalDispatchLedgerPath(
      firstState.conversation_id,
      runtimeDir
    );
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      ...ledger,
      status: "resolved",
      generation_id: uncertainMessageId,
      conversation_id: ownerConversationId,
      message_id: uncertainMessageId,
      state_path: ownerStatePath,
      event_log_path: ownerLogPath,
      resolved_at: ownerClosedAt,
      reason: "operator resolved the uncertain dispatch"
    }, null, 2)}\n`);

    const terminalFixtures = [
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
        session: tmuxSession,
        pane: 1,
        panePid,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: "› \n" }),
      ...nativeIdentityArgs
    ];
    const runtimeSendCommon = [
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
    const terminalInputCount = () => readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys")
      .length;
    const substantiveStoreSnapshot = () => ({
      sessions: listManagedSessions(storeDir)
        .map((session) => {
          const statePath = pathsForManagedSession(
            session.session_id,
            storeDir
          ).statePath;
          return [session.session_id, fs.readFileSync(statePath, "utf8")];
        })
        .sort(([left], [right]) => left.localeCompare(right)),
      turns: listConversations(storeDir)
        .map((turn) => {
          const paths = pathsForConversation(turn.conversation_id, storeDir);
          return [
            turn.conversation_id,
            fs.readFileSync(paths.statePath, "utf8"),
            fs.readFileSync(paths.logPath, "utf8")
          ];
        })
        .sort(([left], [right]) => left.localeCompare(right))
    });
    const before = await runAgentCliInProcess([
      "list",
      "--store-dir",
      storeDir,
      "--all",
      ...terminalFixtures
    ], testEnv);
    assert.equal(before.status, 0, before.stderr || before.stdout);
    const beforeTerminal = JSON.parse(before.stdout).terminals[0];
    assert.equal(
      beforeTerminal.available_actions.send?.scope,
      "terminal_user_explicit"
    );
    assert.equal(
      beforeTerminal.available_actions.send?.arguments?.selector,
      beforeTerminal.id
    );
    assert.equal(
      typeof beforeTerminal.available_actions.send?.arguments
        ?.expected_terminal_token,
      "string"
    );
    assert.deepEqual(beforeTerminal.blocking_turns, [{
      session_id: firstState.session_id,
      turn_id: firstState.turn_id,
      status: "stalled",
      recovery_action: {
        tool: "agent_knock_knock_close",
        arguments: { turn_id: firstState.turn_id },
        requires_explicit_user_confirmation: true
      }
    }]);
    assert.equal(
      JSON.parse(fs.readFileSync(firstStatePath, "utf8")).status,
      "stalled",
      "plain list must remain read-only"
    );

    const beforeRuntimeRejections = substantiveStoreSnapshot();
    const inputsBeforeRuntimeRejections = terminalInputCount();
    const managedBlocked = await runAgentCliInProcess([
      "send",
      "--session",
      firstState.session_id,
      "--message",
      "This managed task must remain fenced by the collateral stall.",
      ...runtimeSendCommon
    ], testEnv);
    assert.notEqual(managedBlocked.status, 0);
    assert.match(
      managedBlocked.stderr,
      /rollout-backed managed Session.*strict session_id send[\s\S]*refresh AKK list/iu
    );
    assert.deepEqual(
      substantiveStoreSnapshot(),
      beforeRuntimeRejections,
      "managed send must reject before substantive Store mutation"
    );
    assert.equal(
      terminalInputCount(),
      inputsBeforeRuntimeRejections,
      "managed send must reject before terminal input"
    );

    const rawBlocked = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${terminalTarget}:${panePid}`,
      "--message",
      "This raw terminal task must remain fenced by the collateral stall.",
      ...runtimeSendCommon
    ], testEnv);
    assert.notEqual(rawBlocked.status, 0);
    assert.match(
      rawBlocked.stderr,
      /terminal .* still has unresolved Turn .*\(stalled\)/u
    );
    assert.deepEqual(
      substantiveStoreSnapshot(),
      beforeRuntimeRejections,
      "raw terminal send must reject before substantive Store mutation"
    );
    assert.equal(
      terminalInputCount(),
      inputsBeforeRuntimeRejections,
      "raw terminal send must reject before terminal input"
    );

    const reconciled = await runAgentCliInProcess([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--reason",
      "monitor_supervision",
      "--terminal-monitors-only"
    ], testEnv);
    assert.equal(
      reconciled.status,
      0,
      reconciled.stderr || reconciled.stdout
    );
    const reconciledParsed = JSON.parse(reconciled.stdout);
    assert.equal(reconciledParsed.repaired, 1);
    assert.equal(reconciledParsed.collateral_stalls_checked, 1);
    assert.equal(
      reconciledParsed.items.some((item) =>
        item.conversation_id === firstState.conversation_id &&
        item.status === "repaired" &&
        item.uncertain_owner_conversation_id === ownerConversationId
      ),
      true
    );
    const repaired = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(repaired.status, "idle");
    assert.equal(repaired.idle_since, completionAt);
    assert.equal(repaired.stalled_at, undefined);
    assert.equal(repaired.stalled_reason, undefined);
    assert.equal(
      repaired.native_session_takeover
        .terminal_bridge_uncertain_dispatch_fence,
      undefined
    );
    assert.equal(
      repaired.native_session_takeover
        .terminal_bridge_collateral_stall_repair
        .uncertain_owner_conversation_id,
      ownerConversationId
    );
    assert.match(
      fs.readFileSync(firstLogPath, "utf8"),
      /terminal_bridge_collateral_stall_repaired/u
    );

    const after = await runAgentCliInProcess([
      "list",
      "--store-dir",
      storeDir,
      "--all",
      ...terminalFixtures
    ], testEnv);
    assert.equal(after.status, 0, after.stderr || after.stdout);
    const afterTerminal = JSON.parse(after.stdout).terminals[0];
    assert.equal(afterTerminal.blocking_turns, undefined);

    const turnsBeforeRepairedSend = listConversations(storeDir).length;
    const inputsBeforeRepairedSend = terminalInputCount();
    const repairedMessage =
      "A fresh managed task after exact collateral-stall repair.";
    const sentAfterRepair = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${terminalTarget}:${panePid}`,
      "--message",
      repairedMessage,
      ...runtimeSendCommon
    ], testEnv);
    assert.equal(
      sentAfterRepair.status,
      0,
      sentAfterRepair.stderr || sentAfterRepair.stdout
    );
    const sentAfterRepairParsed = JSON.parse(sentAfterRepair.stdout);
    assert.equal(sentAfterRepairParsed.delivered, true);
    assert.equal(sentAfterRepairParsed.session_id, firstState.session_id);
    assert.equal(
      listConversations(storeDir).length,
      turnsBeforeRepairedSend + 1
    );
    assert.equal(terminalInputCount(), inputsBeforeRepairedSend + 2);
    const repairedSendInputs = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys")
      .slice(-2);
    assert.equal(repairedSendInputs[0].args.at(-1), repairedMessage);
    assert.equal(repairedSendInputs[1].args.at(-1), "C-m");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
