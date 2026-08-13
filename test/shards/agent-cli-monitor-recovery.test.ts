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
import { detectClaudeTranscriptAcceptance } from "../../src/claude-local-transcript-provider.js";
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

test("terminal bridge monitor singleton rejects a live owner and reclaims a dead owner", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-monitor-singleton-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const runtimeLogDir = path.join(tempDir, "runtime-logs");
  const workspace = path.join(tempDir, "workspace");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-monitor-singleton-process",
    rolloutPath: path.join(tempDir, "codex-monitor-singleton-rollout.jsonl")
  });
  const childProcesses: Array<ReturnType<typeof spawn>> = [];
  let supervisedMonitorPid: number | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const workingScreen =
      "• Working (12s • esc to interrupt) · 1 background terminal running\n› Steer the current task\n";
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_LOG_DIR: runtimeLogDir
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Keep working while AKK monitors",
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
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    fs.writeFileSync(screenPath, workingScreen);
    const statePath = sentParsed.conversation.state_path;
    const logPath = sentParsed.conversation.event_log_path;
    const monitorArgs = [
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      ...nativeIdentityArgs
    ];
    const sendKeysBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;

    const first = spawnAgentCliProcess(monitorArgs, testEnv);
    childProcesses.push(first);
    await waitForCondition(
      () => eventCount(logPath, "terminal_bridge_monitor_started") === 1,
      "first terminal bridge monitor to start"
    );
    const lockFiles = fs.readdirSync(path.dirname(statePath))
      .filter((name) => name.includes(".terminal-bridge-monitor-") && name.endsWith(".lock"));
    assert.equal(lockFiles.length, 1);
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        conversation_id: sentParsed.conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: first.pid,
        reason: "issue_93_test_initial_launch"
      })}\n`
    );

    const writerLockPath = path.join(storeDir, ".akk-writer.lock");
    fs.writeFileSync(
      writerLockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "issue-93-live-writer-contention",
        created_at: new Date().toISOString()
      })}\n`,
      { mode: 0o600 }
    );
    await waitForCondition(
      () => fs.existsSync(runtimeLogDir) &&
        fs.readdirSync(runtimeLogDir).some((name) => {
          if (!name.endsWith(".ndjson")) {
            return false;
          }
          const contents = fs.readFileSync(
            path.join(runtimeLogDir, name),
            "utf8"
          );
          return contents.includes(
            '"event":"terminal_bridge_monitor_binding_check_deferred"'
          ) || contents.includes(
            '"event":"terminal_bridge_monitor_store_operation_deferred"'
          );
        }),
      "the monitor to observe an actual Store-lock timeout",
      45_000
    );
    assert.equal(
      first.exitCode,
      null,
      "a Store writer timeout must defer the binding check, not stop monitoring"
    );
    fs.unlinkSync(writerLockPath);
    await waitForCondition(
      () =>
        eventCount(
          logPath,
          "terminal_bridge_monitor_binding_check_deferred"
        ) === 1 ||
        eventCount(
          logPath,
          "terminal_bridge_monitor_store_operation_deferred"
        ) === 1,
      "the deferred monitor Store operation to resume after lock release"
    );
    assert.equal(
      eventCount(logPath, "terminal_bridge_monitor_binding_superseded"),
      0
    );

    const duplicate = runAgentCli(monitorArgs, testEnv);
    assert.equal(duplicate.status, 0, duplicate.stderr || duplicate.stdout);
    const duplicateParsed = JSON.parse(duplicate.stdout);
    assert.equal(duplicateParsed.already_running, true);
    assert.equal(duplicateParsed.reason, "terminal_bridge_monitor_already_running");
    assert.equal(eventCount(logPath, "terminal_bridge_monitor_started"), 1);

    first.kill("SIGKILL");
    await waitForChildExit(first);
    assert.equal(fs.existsSync(path.join(path.dirname(statePath), lockFiles[0])), true);

    const reconciled = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--reason",
      "monitor_supervision",
      "--monitor-poll-interval-ms",
      "20",
      ...nativeIdentityArgs
    ], testEnv);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const reconciledParsed = JSON.parse(reconciled.stdout);
    assert.equal(reconciledParsed.launched, 1);
    assert.equal(reconciledParsed.items[0]?.reason, "unexpected_exit_recovery");
    const replacementPid = Number(reconciledParsed.items[0]?.monitor_pid);
    assert.equal(
      Number.isSafeInteger(replacementPid) && replacementPid > 0,
      true,
      `expected a concrete replacement monitor pid, got ${String(replacementPid)}`
    );
    supervisedMonitorPid = replacementPid;
    await waitForCondition(
      () => eventCount(logPath, "terminal_bridge_monitor_started") === 2,
      "replacement terminal bridge monitor to reclaim the stale lock"
    );
    assert.equal(
      eventCount(logPath, "terminal_bridge_monitor_exit_observed"),
      1
    );
    const managedSession = loadManagedSession(
      storeDir,
      sentParsed.conversation.session_id
    );
    const managedSessionPath = pathsForManagedSession(
      managedSession.session_id,
      storeDir
    ).statePath;
    const managedSessionSnapshot = fs.readFileSync(managedSessionPath, "utf8");
    const managedBinding = managedSession.binding;
    assert.ok(managedBinding);
    const managedRevision = Number(managedSession.revision);
    assert.equal(Number.isSafeInteger(managedRevision), true);
    saveManagedSession(
      storeDir,
      {
        ...managedSession,
        binding: {
          ...managedBinding,
          binding_id: "binding-issue-93-superseded",
          generation: managedBinding.generation + 1
        }
      },
      { expectedRevision: managedRevision }
    );
    await waitForCondition(
      () =>
        eventCount(
          logPath,
          "terminal_bridge_monitor_binding_superseded"
        ) === 1,
      "the replacement monitor to record binding supersession"
    );
    await waitForPidExit(replacementPid);
    supervisedMonitorPid = undefined;
    assert.equal(
      eventCount(logPath, "terminal_bridge_monitor_binding_superseded"),
      1
    );
    const fencedReconciliation = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--reason",
      "monitor_supervision"
    ], testEnv);
    assert.equal(
      fencedReconciliation.status,
      0,
      fencedReconciliation.stderr || fencedReconciliation.stdout
    );
    const fencedParsed = JSON.parse(fencedReconciliation.stdout);
    assert.equal(fencedParsed.launched, 0);
    assert.equal(fencedParsed.errors, 0);
    assert.equal(
      fencedParsed.items.some((item) =>
        item.conversation_id === sentParsed.conversation.conversation_id &&
        item.status === "skipped" &&
        item.reason === "session_binding_superseded"
      ),
      true
    );
    fs.writeFileSync(managedSessionPath, managedSessionSnapshot);

    const finalReplacement = spawnAgentCliProcess(monitorArgs, testEnv);
    childProcesses.push(finalReplacement);
    await waitForCondition(
      () => eventCount(logPath, "terminal_bridge_monitor_started") === 3,
      "monitor to restart after the real supersession fence test"
    );
    const closed = runAgentCli([
      "close",
      "--state",
      statePath,
      ...nativeIdentityArgs,
      "--reason",
      "singleton test cleanup"
    ]);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    await waitForChildExit(finalReplacement);
    assert.equal(
      fs.readdirSync(path.dirname(statePath))
        .some((name) => name.includes(".terminal-bridge-monitor-") && name.endsWith(".lock")),
      false
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBefore
    );

    const handoffStatePath = writeConversationClone(
      storeDir,
      sentParsed.conversation,
      "terminal-handoff-transient-callback",
      (state) => ({
        ...state,
        status: "waiting_for_openclaw",
        updated_at: new Date().toISOString()
      })
    );
    const handoffLogPath = path.join(
      path.dirname(handoffStatePath),
      "events.ndjson"
    );
    const handoffMessageId =
      sentParsed.conversation.native_session_takeover
        .terminal_bridge_message_id;
    const handoffLedgerPath = findTerminalDispatchLedgerPath(
      sentParsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const handoffState = JSON.parse(
      fs.readFileSync(handoffStatePath, "utf8")
    );
    const handoffLedger = JSON.parse(
      fs.readFileSync(handoffLedgerPath, "utf8")
    );
    delete handoffLedger.resolved_at;
    delete handoffLedger.reason;
    fs.writeFileSync(
      handoffLedgerPath,
      `${JSON.stringify({
        ...handoffLedger,
        status: "submitted",
        conversation_id: handoffState.conversation_id,
        session_id: handoffState.session_id,
        turn_id: handoffState.turn_id,
        state_path: handoffStatePath,
        event_log_path: handoffLogPath,
        store_dir: handoffState.store_dir,
        binding_id: handoffState.terminal_binding_id,
        binding_generation: handoffState.terminal_binding_generation,
        native_thread_id: handoffState.native_thread_id,
        message_id: handoffMessageId,
        submitted_at: new Date().toISOString()
      }, null, 2)}\n`
    );
    const handoffArgs = [
      "monitor",
      "--terminal-bridge-handoff",
      "--state",
      handoffStatePath,
      "--log",
      handoffLogPath,
      "--expected-terminal-message-id",
      handoffMessageId,
      "--monitor-handoff-poll-interval-ms",
      "20",
      "--monitor-poll-interval-ms",
      "20",
      ...nativeIdentityArgs
    ];
    const handoff = spawnAgentCliCaptured(handoffArgs, testEnv);
    childProcesses.push(handoff.child);
    await waitForCondition(
      () =>
        eventCount(
          handoffLogPath,
          "terminal_bridge_monitor_handoff_watchdog_started"
        ) === 1,
      "handoff watchdog to stay alive across the callback state"
    );
    const duplicateHandoff = runAgentCli(handoffArgs, testEnv);
    assert.equal(
      duplicateHandoff.status,
      0,
      duplicateHandoff.stderr || duplicateHandoff.stdout
    );
    assert.equal(
      JSON.parse(duplicateHandoff.stdout).reason,
      "terminal_bridge_monitor_handoff_watchdog_already_running"
    );
    const transientState = JSON.parse(
      fs.readFileSync(handoffStatePath, "utf8")
    );
    fs.writeFileSync(
      handoffStatePath,
      `${JSON.stringify({
        ...transientState,
        status: "waiting_for_agent",
        updated_at: new Date().toISOString()
      }, null, 2)}\n`
    );
    const handoffResult = await handoff.result;
    assert.equal(
      handoffResult.status,
      0,
      handoffResult.stderr || handoffResult.stdout
    );
    const handoffParsed = JSON.parse(handoffResult.stdout);
    assert.equal(handoffParsed.launched, true);
    assert.equal(
      handoffParsed.reason,
      "approval_handoff_reconciliation"
    );
    assert.equal(
      eventCount(handoffLogPath, "terminal_bridge_monitor_launch"),
      1,
      "the original watchdog must survive the transient callback state and take over"
    );
    const handoffClosed = runAgentCli([
      "close",
      "--state",
      handoffStatePath,
      ...nativeIdentityArgs,
      "--reason",
      "handoff transient test cleanup"
    ], testEnv);
    assert.equal(
      handoffClosed.status,
      0,
      handoffClosed.stderr || handoffClosed.stdout
    );
    await waitForPidExit(handoffParsed.monitor_pid);

    for (const finalCallbackStatus of ["callback_pending", "callback_failed"]) {
      const completedCallbackStatePath = writeConversationClone(
        storeDir,
        sentParsed.conversation,
        `terminal-handoff-${finalCallbackStatus}`,
        (state) => ({
          ...state,
          status: finalCallbackStatus,
          updated_at: new Date().toISOString()
        })
      );
      const completedCallbackLogPath = path.join(
        path.dirname(completedCallbackStatePath),
        "events.ndjson"
      );
      const completedCallbackHandoff = runAgentCli([
        "monitor",
        "--terminal-bridge-handoff",
        "--state",
        completedCallbackStatePath,
        "--log",
        completedCallbackLogPath,
        "--expected-terminal-message-id",
        handoffMessageId,
        "--monitor-handoff-poll-interval-ms",
        "20",
        "--monitor-poll-interval-ms",
        "20"
      ], testEnv);
      assert.equal(
        completedCallbackHandoff.status,
        0,
        completedCallbackHandoff.stderr || completedCallbackHandoff.stdout
      );
      assert.equal(
        eventCount(
          completedCallbackLogPath,
          "terminal_bridge_monitor_handoff_watchdog_finished"
        ),
        1
      );
      assert.equal(
        eventCount(completedCallbackLogPath, "terminal_bridge_monitor_launch"),
        0,
        `${finalCallbackStatus} is a terminal callback state, not an approval handoff`
      );
    }
  } finally {
    killPidBestEffort(supervisedMonitorPid);
    for (const child of childProcesses) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervised Codex monitor retains detector diagnostics and completes the exact bound Turn once", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-monitor-exact-recovery-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const exactRolloutPath = path.join(tempDir, "exact-bound-rollout.jsonl");
  const processUuid = "codex-exact-recovery-process";
  const processBirth = "codex-exact-recovery-birth";
  const exactTurnId = "019f0000-0000-7000-8000-000000000093";
  let missingAnchorMonitor: ReturnType<typeof spawn> | undefined;
  let firstMonitor: ReturnType<typeof spawn> | undefined;
  let recoveredMonitorPid: number | undefined;
  let supervisorService: {
    start?(): void;
    stop?(): void | Promise<void>;
  } | undefined;
  const originalPath = process.env.PATH;
  const originalRuntimeDir = process.env.AKK_RUNTIME_DIR;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    fs.writeFileSync(
      exactRolloutPath,
      `${JSON.stringify({
        timestamp: "2026-08-07T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          cwd: workspace,
          originator: "codex-tui",
          source: "cli",
          cli_version: "0.146.1"
        }
      })}\n`,
      { mode: 0o600 }
    );
    const rolloutStat = fs.statSync(exactRolloutPath);
    const rolloutIdentity = {
      fd: "12r",
      device: String(rolloutStat.dev),
      inode: String(rolloutStat.ino),
      path: exactRolloutPath
    };
    const nativeIdentityArgs = [
      "--codex-active-session-identities-json",
      JSON.stringify({
        33389: {
          sessionId,
          processUuid,
          processBirth,
          rollout: rolloutIdentity
        }
      })
    ];
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const request = "Prove the exact recovered native completion";
    const sent = runAgentCli([
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
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = sentParsed.conversation.state_path;
    const logPath = sentParsed.conversation.event_log_path;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const takeover = state.native_session_takeover;
    const requestHash = takeover.terminal_bridge_request_hash;
    const requestText = takeover.terminal_bridge_request_text;
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: sessionId,
      processUuid,
      processBirth,
      mode: "existing",
      rollout: rolloutIdentity
    });
    fs.appendFileSync(
      exactRolloutPath,
      [
        {
          timestamp: "2026-08-07T01:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: exactTurnId }
        },
        {
          timestamp: "2026-08-07T01:00:01.010Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: requestText }],
            internal_chat_message_metadata_passthrough: {
              turn_id: exactTurnId
            }
          }
        },
        {
          timestamp: "2026-08-07T01:00:01.011Z",
          type: "event_msg",
          payload: { type: "user_message", message: requestText }
        }
      ].map((record) => JSON.stringify(record)).join("\n") + "\n"
    );
    const acceptanceEvidence = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId,
        processUuid,
        processBirth,
        rollout: rolloutIdentity
      },
      requestHash
    });
    assert.ok(acceptanceEvidence);
    const currentSubmission = takeover.terminal_bridge_submission;
    const exactSubmission = {
      ...currentSubmission,
      acceptance_evidence: acceptanceEvidence
    };
    const exactState = {
      ...state,
      native_session_takeover: {
        ...takeover,
        codex_rollout_acceptance_anchor: anchor,
        terminal_bridge_submission: exactSubmission,
        terminal_bridge_submission_receipts:
          takeover.terminal_bridge_submission_receipts.map((receipt) =>
            receipt.message_id === exactSubmission.message_id
              ? exactSubmission
              : receipt
          )
      }
    };
    const monitorArgs = [
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      ...nativeIdentityArgs
    ];
    const missingAnchorState = structuredClone(exactState);
    delete missingAnchorState.native_session_takeover
      .codex_rollout_acceptance_anchor;
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(missingAnchorState, null, 2)}\n`
    );
    fs.writeFileSync(
      screenPath,
      "• Working (12s • esc to interrupt)\n› Steer the current task\n"
    );
    missingAnchorMonitor = spawnAgentCliProcess(monitorArgs, {
      ...testEnv,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
    });
    await waitForCondition(
      () => eventCount(logPath, "terminal_bridge_completion_detector_limited") === 1,
      "the missing modern exact anchor to be retained as a limitation"
    );
    const missingAnchorDiagnostic = JSON.parse(
      fs.readFileSync(statePath, "utf8")
    ).native_session_takeover.terminal_bridge_detector_diagnostic;
    assert.match(
      missingAnchorDiagnostic.detail,
      /codex_exact_bound_rollout:invalid_anchor/u
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(
      JSON.parse(fs.readFileSync(statePath, "utf8")).status,
      "waiting_for_agent"
    );
    assert.equal(fs.existsSync(openclawCallsPath), false);
    missingAnchorMonitor.kill("SIGKILL");
    await waitForChildExit(missingAnchorMonitor);
    missingAnchorMonitor = undefined;

    fs.writeFileSync(statePath, `${JSON.stringify(exactState, null, 2)}\n`);
    fs.chmodSync(exactRolloutPath, 0o666);
    firstMonitor = spawnAgentCliProcess(monitorArgs, testEnv);
    await waitForCondition(
      () => eventCount(logPath, "terminal_bridge_completion_detector_limited") === 2,
      "the exact detector limitation to be retained"
    );
    let limitedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      limitedState.native_session_takeover.terminal_bridge_detector_diagnostic.status,
      "limited"
    );
    assert.match(
      limitedState.native_session_takeover.terminal_bridge_detector_diagnostic.detail,
      /codex_exact_bound_rollout:rollout_unreadable/u
    );
    fs.chmodSync(exactRolloutPath, 0o600);
    await waitForCondition(
      () => eventCount(logPath, "terminal_bridge_completion_detector_recovered") === 1,
      "the exact detector limitation to recover"
    );
    limitedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      limitedState.native_session_takeover.terminal_bridge_detector_diagnostic.status,
      "recovered"
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(
      JSON.parse(fs.readFileSync(statePath, "utf8")).status,
      "waiting_for_agent"
    );
    assert.equal(fs.existsSync(openclawCallsPath), false);
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        conversation_id: sentParsed.conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: firstMonitor.pid,
        reason: "issue_93_exact_recovery_test"
      })}\n`
    );
    process.env.PATH = testEnv.PATH;
    process.env.AKK_RUNTIME_DIR = path.join(tempDir, ".akk-cli-test-runtime");
    (
      createOpenClawPluginForTest(binPath, {
        monitorSupervisorIntervalMs: 50
      }) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: { storeDir },
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService(value: typeof supervisorService) {
        supervisorService = value;
      },
      registerCommand() {},
      registerTool() {}
    });
    assert.equal(typeof supervisorService?.start, "function");
    supervisorService?.start?.();
    firstMonitor.kill("SIGKILL");
    await waitForChildExit(firstMonitor);
    firstMonitor = undefined;

    const laterCompletions = Array.from({ length: 20 }, (_, index) => ({
      timestamp: "2026-08-07T01:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: `019f0000-0000-7000-8000-${String(200 + index).padStart(12, "0")}`,
        last_agent_message: `Later native result ${index}`
      }
    }));
    fs.appendFileSync(
      exactRolloutPath,
      [
        {
          timestamp: "2026-08-07T01:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: exactTurnId,
            last_agent_message: "Recovered exact completion."
          }
        },
        ...laterCompletions
      ].map((record) => JSON.stringify(record)).join("\n") + "\n"
    );

    await waitForCondition(
      () =>
        eventCount(logPath, "terminal_bridge_monitor_started") === 3 &&
        readJsonLines(logPath).filter((event) =>
          event.event === "terminal_bridge_monitor_launch"
        ).length >= 2,
      "the OpenClaw supervisor to recover the killed monitor",
      10_000
    );
    const recoveryLaunches = readJsonLines(logPath).filter((event) =>
      event.event === "terminal_bridge_monitor_launch"
    );
    const recoveryLaunch = recoveryLaunches.at(-1);
    assert.equal(recoveryLaunch.reason, "unexpected_exit_recovery");
    recoveredMonitorPid = Number(recoveryLaunch.pid);
    assert.equal(eventCount(logPath, "terminal_bridge_monitor_exit_observed"), 1);
    await waitForCondition(
      () => JSON.parse(fs.readFileSync(statePath, "utf8")).status === "idle",
      "the supervised monitor to deliver the exact done callback",
      30_000
    );
    await waitForPidExit(recoveredMonitorPid);
    recoveredMonitorPid = undefined;
    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "idle");
    const callbackCalls = readJsonLines(openclawCallsPath);
    assert.equal(callbackCalls.length, 1);
    const callbackParamsIndex = callbackCalls[0].args.indexOf("--params");
    assert.notEqual(callbackParamsIndex, -1);
    const callbackParams = JSON.parse(
      callbackCalls[0].args[callbackParamsIndex + 1]
    );
    assert.equal(callbackParams.message.type, "done");
    assert.equal(callbackParams.message.body, "Recovered exact completion.");
    assert.equal(
      callbackParams.message.metadata.context_match,
      "exact_bound_rollout"
    );
    assert.equal(eventCount(logPath, "terminal_bridge_completion_detected"), 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(eventCount(logPath, "terminal_bridge_monitor_started"), 3);
    assert.equal(readJsonLines(openclawCallsPath).length, 1);
  } finally {
    await supervisorService?.stop?.();
    if (missingAnchorMonitor && missingAnchorMonitor.exitCode === null) {
      missingAnchorMonitor.kill("SIGKILL");
    }
    if (firstMonitor && firstMonitor.exitCode === null) {
      firstMonitor.kill("SIGKILL");
    }
    killPidBestEffort(recoveredMonitorPid);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalRuntimeDir === undefined) {
      delete process.env.AKK_RUNTIME_DIR;
    } else {
      process.env.AKK_RUNTIME_DIR = originalRuntimeDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-monitors launches only recoverable waiting terminal bridges", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-monitor-reconcile-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-monitor-reconcile-process",
    rolloutPath: path.join(tempDir, "codex-monitor-reconcile-rollout.jsonl")
  });
  let monitorPid: number | undefined;

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
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Finish the restart-safe task",
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
      "1",
      "--agent-hard-timeout-minutes",
      "2",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const baseStatePath = JSON.parse(sent.stdout).conversation.state_path;
    const baseState = JSON.parse(fs.readFileSync(baseStatePath, "utf8"));
    const expiredStartedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const expiredActivityAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const recoverableState = {
      ...baseState,
      native_session_takeover: {
        ...baseState.native_session_takeover,
        terminal_bridge_started_at: expiredStartedAt,
        terminal_bridge_last_activity_at: expiredActivityAt,
        terminal_bridge_inactivity_timeout_minutes: 1,
        terminal_bridge_hard_timeout_minutes: 2,
        terminal_bridge_inactivity_deadline_at: new Date(
          Date.parse(expiredActivityAt) + 60_000
        ).toISOString(),
        terminal_bridge_hard_deadline_at: new Date(
          Date.parse(expiredStartedAt) + 2 * 60_000
        ).toISOString()
      }
    };
    fs.writeFileSync(baseStatePath, `${JSON.stringify(recoverableState, null, 2)}\n`);

    writeConversationClone(storeDir, recoverableState, "waiting-for-openclaw", (state) => ({
      ...state,
      status: "waiting_for_openclaw"
    }));
    writeConversationClone(storeDir, recoverableState, "already-stalled", (state) => ({
      ...state,
      status: "stalled"
    }));
    writeConversationClone(storeDir, recoverableState, "missing-gateway", (state) => ({
      ...state,
      gateway_method: undefined
    }));
    writeConversationClone(storeDir, recoverableState, "legacy-owner-unknown", (state) => {
      const nativeTakeover = { ...state.native_session_takeover };
      delete nativeTakeover.terminal_bridge_monitor_lock_version;
      return {
        ...state,
        native_session_takeover: nativeTakeover
      };
    });
    writeConversationClone(storeDir, recoverableState, "non-terminal-task", (state) => ({
      ...state,
      native_session_takeover: {
        ...state.native_session_takeover,
        terminal_bridge: false
      }
    }));

    const sendKeysBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const reconciled = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--monitor-poll-interval-ms",
      "20",
      ...nativeIdentityArgs
    ], testEnv);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const parsed = JSON.parse(reconciled.stdout);
    assert.equal(parsed.checked, 6);
    assert.equal(parsed.ignored, 1);
    assert.equal(parsed.launched, 1);
    assert.equal(parsed.already_running, 0);
    assert.equal(parsed.skipped, 4);
    assert.equal(parsed.errors, 0);
    assert.equal(
      parsed.items.find((item) => item.conversation_id === "legacy-owner-unknown")?.reason,
      "terminal_dispatch_agent_accepted"
    );
    const launchedItem = parsed.items.find((item) =>
      item.status === "launched" &&
      item.conversation_id === recoverableState.conversation_id
    );
    assert.equal(launchedItem.conversation_id, recoverableState.conversation_id);
    monitorPid = launchedItem.monitor_pid;

    await waitForCondition(
      () => JSON.parse(fs.readFileSync(baseStatePath, "utf8")).status === "stalled",
      "reconciled monitor to classify the elapsed deadline"
    );
    await waitForPidExit(monitorPid);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBefore
    );
    assert.equal(
      JSON.parse(fs.readFileSync(pathsForConversation("waiting-for-openclaw", storeDir).statePath, "utf8")).status,
      "waiting_for_openclaw"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(pathsForConversation("already-stalled", storeDir).statePath, "utf8")).status,
      "stalled"
    );
  } finally {
    killPidBestEffort(monitorPid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("callbackless completion crash resumes local settlement without outbox or replay", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-local-completion-recovery-"));
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, ".akk-cli-test-runtime");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const exactRolloutPath = path.join(tempDir, "callbackless-rollout.jsonl");
  const nativeThreadId = "77777777-7777-4777-8777-777777777777";
  const processUuid = "codex-callbackless-completion-process";
  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    fs.writeFileSync(
      exactRolloutPath,
      `${JSON.stringify({
        timestamp: "2026-08-12T05:00:00.000Z",
        type: "session_meta",
        payload: {
          id: nativeThreadId,
          cwd: workspace,
          originator: "codex-tui",
          source: "cli",
          cli_version: "0.147.0"
        }
      })}\n`,
      { mode: 0o600 }
    );
    const rolloutStat = fs.statSync(exactRolloutPath);
    const rollout = {
      fd: "12r",
      device: String(rolloutStat.dev),
      inode: String(rolloutStat.ino),
      path: exactRolloutPath
    };
    const nativeIdentityArgs = [
      "--codex-active-session-identities-json",
      JSON.stringify({
        43389: {
          sessionId: nativeThreadId,
          processUuid,
          processBirth: processUuid,
          rollout
        }
      })
    ];
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-local\t0\t1\t43389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-local:0.1:43389",
      "--message",
      "Complete locally without a callback route",
      "--background",
      "--store-dir",
      storeDir,
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentOutput = JSON.parse(sent.stdout).conversation;
    const statePath = sentOutput.state_path;
    const sentState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const logPath = sentState.event_log_path;
    const terminalMessageId = sentState.native_session_takeover
      .terminal_bridge_message_id;
    const exactAnchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId,
      processUuid,
      processBirth: processUuid,
      mode: "existing",
      rollout
    });
    const acceptedTurnId = "88888888-8888-4888-8888-888888888888";
    fs.appendFileSync(exactRolloutPath, [
      {
        timestamp: "2026-08-12T05:00:00.500Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: acceptedTurnId }
      },
      {
        timestamp: "2026-08-12T05:00:00.600Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: sentState.native_session_takeover
              .terminal_bridge_request_text
          }],
          internal_chat_message_metadata_passthrough: {
            turn_id: acceptedTurnId
          }
        }
      },
      {
        timestamp: "2026-08-12T05:00:00.700Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: sentState.native_session_takeover
            .terminal_bridge_request_text
        }
      },
      {
        timestamp: "2026-08-12T05:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: acceptedTurnId,
          last_agent_message: "Completed without an OpenClaw callback."
        }
      }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const exactAcceptance = detectCodexRolloutAcceptance({
      anchor: exactAnchor,
      currentIdentity: {
        sessionId: nativeThreadId,
        processUuid,
        processBirth: processUuid,
        rollout
      },
      requestHash: sentState.native_session_takeover
        .terminal_bridge_request_hash
    });
    assert.ok(exactAcceptance);
    const exactSubmission = {
      ...sentState.native_session_takeover.terminal_bridge_submission,
      acceptance_evidence: exactAcceptance
    };
    const exactState = {
      ...sentState,
      native_session_takeover: {
        ...sentState.native_session_takeover,
        codex_rollout_acceptance_anchor: exactAnchor,
        terminal_bridge_submission: exactSubmission,
        terminal_bridge_submission_receipts:
          sentState.native_session_takeover
            .terminal_bridge_submission_receipts.map((receipt) =>
              receipt.message_id === terminalMessageId
                ? exactSubmission
                : receipt
            )
      }
    };
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(exactState, null, 2)}\n`
    );
    fs.writeFileSync(screenPath, "› \n");
    const inputCount = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const crashed = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      ...nativeIdentityArgs
    ], {
      ...testEnv,
      AKK_TEST_EXIT_AFTER_LOCAL_COMPLETION_STATE: "1"
    });
    assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
    const finalBeforeRecovery = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalBeforeRecovery.status, "idle");
    assert.equal(finalBeforeRecovery.callback_delivery, undefined);
    assert.ok(
      finalBeforeRecovery.native_session_takeover.terminal_bridge_completion_claim
    );
    const ledgerPath = findTerminalDispatchLedgerPath(
      finalBeforeRecovery.conversation_id,
      runtimeDir
    );
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
      "agent_accepted"
    );

    const firstRecovery = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs
    ], testEnv);
    assert.equal(firstRecovery.status, 0, firstRecovery.stderr || firstRecovery.stdout);
    const firstParsed = JSON.parse(firstRecovery.stdout);
    assert.equal(
      firstParsed.items.find((item) =>
        item.conversation_id === finalBeforeRecovery.conversation_id
      )?.reason,
      "local_terminal_completion_ledger_recovered"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
      "resolved"
    );
    const stateAfterFirst = fs.readFileSync(statePath, "utf8");
    const ledgerAfterFirst = fs.readFileSync(ledgerPath, "utf8");
    const eventsAfterFirst = fs.readFileSync(logPath, "utf8");

    const secondRecovery = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs
    ], testEnv);
    assert.equal(secondRecovery.status, 0, secondRecovery.stderr || secondRecovery.stdout);
    assert.equal(fs.readFileSync(statePath, "utf8"), stateAfterFirst);
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerAfterFirst);
    assert.equal(fs.readFileSync(logPath, "utf8"), eventsAfterFirst);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) => call.args[0] === "send-keys").length,
      inputCount
    );
    assert.equal(
      readJsonLines(logPath).filter((event) =>
        event.event === "terminal_bridge_local_completion_settled"
      ).length,
      1
    );
    assert.equal(
      readJsonLines(logPath).some((event) =>
        String(event.event).startsWith("callback_delivery_")
      ),
      false
    );
    assert.equal(terminalMessageId.length > 0, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("event polling ignores only an unterminated trailing record", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-event-poll-"));
  const logPath = path.join(tempDir, "events.ndjson");
  try {
    fs.writeFileSync(
      logPath,
      `${JSON.stringify({ event: "terminal_bridge_monitor_started" })}\n{"event":`,
      "utf8"
    );
    assert.equal(eventCount(logPath, "terminal_bridge_monitor_started"), 1);

    fs.appendFileSync(logPath, "}\n", "utf8");
    assert.throws(
      () => eventCount(logPath, "terminal_bridge_monitor_started"),
      SyntaxError
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function persistAnchoredClaudePromptAcceptance(options: {
  statePath: string;
  ledgerPath: string;
  claudeHome: string;
  workspace: string;
  claudePid: number;
  claudeSessionId: string;
  promptUuid: string;
  promptId: string;
}): string {
  const state = JSON.parse(fs.readFileSync(options.statePath, "utf8"));
  const takeover = state.native_session_takeover;
  const anchor = takeover.claude_transcript_anchor;
  assert.equal(anchor.session_id, options.claudeSessionId);
  assert.equal(anchor.pid, options.claudePid);
  assert.equal(anchor.file_existed, false);
  assert.equal(anchor.offset_bytes, 0);
  const request = String(takeover.terminal_bridge_request_text ?? "");
  assert.ok(request);
  const projectDirectory = path.join(
    options.claudeHome,
    "projects",
    options.workspace.replace(/[^A-Za-z0-9]/gu, "-")
  );
  fs.mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
  const transcriptPath = path.join(
    projectDirectory,
    `${options.claudeSessionId}.jsonl`
  );
  const promptAt = new Date(Date.parse(anchor.captured_at) + 100).toISOString();
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    uuid: options.promptUuid,
    parentUuid: null,
    isSidechain: false,
    entrypoint: "cli",
    timestamp: promptAt,
    cwd: options.workspace,
    sessionId: options.claudeSessionId,
    version: "2.1.218",
    type: "user",
    promptId: options.promptId,
    message: { role: "user", content: request }
  })}\n`, { mode: 0o600 });
  fs.chmodSync(transcriptPath, 0o600);

  const acceptanceEvidence = detectClaudeTranscriptAcceptance({
    sessionId: options.claudeSessionId,
    cwd: String(takeover.source_cwd ?? options.workspace),
    requestText: request,
    requestHash: takeover.terminal_bridge_request_hash,
    startedAt: takeover.terminal_bridge_started_at,
    context: {
      pid: options.claudePid,
      sessionId: options.claudeSessionId,
      conversation: state,
      nativeTakeover: takeover
    }
  }, {
    claudeHome: options.claudeHome,
    agentRows: [claudeAgentRow(
      options.claudePid,
      options.claudeSessionId,
      options.workspace
    )]
  });
  assert.ok(acceptanceEvidence);
  const messageId = String(takeover.terminal_bridge_message_id ?? "");
  const submission = takeover.terminal_bridge_submission;
  assert.equal(submission.status, "agent_accepted");
  const stateReceipts = takeover.terminal_bridge_submission_receipts;
  assert.equal(
    stateReceipts.filter((receipt) => receipt.message_id === messageId).length,
    1
  );
  const exactSubmission = {
    ...submission,
    acceptance_evidence: acceptanceEvidence
  };
  fs.writeFileSync(options.statePath, `${JSON.stringify({
    ...state,
    native_session_takeover: {
      ...takeover,
      terminal_bridge_submission: exactSubmission,
      terminal_bridge_submission_receipts: stateReceipts.map((receipt) =>
        receipt.message_id === messageId ? exactSubmission : receipt
      )
    }
  }, null, 2)}\n`);

  const ledger = JSON.parse(fs.readFileSync(options.ledgerPath, "utf8"));
  assert.equal(ledger.status, "agent_accepted");
  const ledgerReceipts = ledger.terminal_submission_receipts;
  assert.equal(
    ledgerReceipts.filter((receipt) => receipt.message_id === messageId).length,
    1
  );
  fs.writeFileSync(options.ledgerPath, `${JSON.stringify({
    ...ledger,
    acceptance_evidence: acceptanceEvidence,
    terminal_submission_receipts: ledgerReceipts.map((receipt) =>
      receipt.message_id === messageId
        ? { ...receipt, acceptance_evidence: acceptanceEvidence }
        : receipt
    )
  }, null, 2)}\n`);
  return transcriptPath;
}

test("reconcile-monitors stalls a verified-dead Claude Turn without relaunch or input", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-dead-reconcile-"));
  const storeDir = path.join(tempDir, "conversations");
  const runtimeDir = path.join(tempDir, ".akk-cli-test-runtime");
  const claudeHome = path.join(tempDir, ".claude");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42313;
  const claudeSessionId = "33333333-3333-4333-8333-333333333333";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    const task = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      claudeHome,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: "Leave this accepted Claude task without a live process"
    });
    const ledgerPath = findTerminalDispatchLedgerPath(
      task.conversation.conversation_id,
      runtimeDir
    );
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status, "agent_accepted");
    persistAnchoredClaudePromptAcceptance({
      statePath: task.statePath,
      ledgerPath,
      claudeHome,
      workspace,
      claudePid,
      claudeSessionId,
      promptUuid: "00000000-0000-4000-8000-000000000021",
      promptId: "00000000-0000-4000-8000-000000000221"
    });

    writeFakeProcessTools(fakeBinDir, [{
      pid: 998,
      ppid: 1,
      command: "zsh",
      cwd: workspace
    }]);
    fs.writeFileSync(tmuxCallsPath, "");
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const reconcileArgs = [
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--terminal-monitors-only",
      "--disable-terminal-bridge-monitor",
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify([claudeAgentRow(claudePid, claudeSessionId, workspace)])
    ];

    const first = runAgentCli(reconcileArgs, testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstOutput = JSON.parse(first.stdout);
    assert.equal(firstOutput.launched, 0);
    assert.equal(firstOutput.errors, 0);
    assert.equal(
      firstOutput.items.some((item) =>
        item.conversation_id === task.conversation.conversation_id &&
        item.reason === "bound_agent_process_verified_dead"
      ),
      true,
      first.stdout
    );
    const stalled = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    assert.equal(stalled.status, "stalled");
    assert.match(
      String(stalled.stalled_reason ?? ""),
      /bound terminal agent process is verified dead/iu
    );
    assert.equal(stalled.terminal_agent_process_disposition?.status, "verified_dead");
    assert.equal(
      readJsonLines(task.logPath).filter((event) =>
        event.event === "terminal_agent_process_verified_dead"
      ).length,
      1
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      0
    );

    const stateAfterFirst = fs.readFileSync(task.statePath, "utf8");
    const eventsAfterFirst = fs.readFileSync(task.logPath, "utf8");
    const second = runAgentCli(reconcileArgs, testEnv);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(JSON.parse(second.stdout).launched, 0);
    assert.equal(fs.readFileSync(task.statePath, "utf8"), stateAfterFirst);
    assert.equal(fs.readFileSync(task.logPath, "utf8"), eventsAfterFirst);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      0
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("missing Claude transcript stalls with unverifiable completion evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-dead-missing-"));
  const storeDir = path.join(tempDir, "conversations");
  const runtimeDir = path.join(tempDir, ".akk-cli-test-runtime");
  const claudeHome = path.join(tempDir, ".claude");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42315;
  const claudeSessionId = "55555555-5555-4555-8555-555555555555";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    const task = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      claudeHome,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: "Keep the orphan unresolved when its transcript disappears"
    });
    const ledgerPath = findTerminalDispatchLedgerPath(
      task.conversation.conversation_id,
      runtimeDir
    );
    const transcriptPath = persistAnchoredClaudePromptAcceptance({
      statePath: task.statePath,
      ledgerPath,
      claudeHome,
      workspace,
      claudePid,
      claudeSessionId,
      promptUuid: "00000000-0000-4000-8000-000000000031",
      promptId: "00000000-0000-4000-8000-000000000231"
    });
    fs.rmSync(transcriptPath);
    writeFakeProcessTools(fakeBinDir, [{
      pid: 998,
      ppid: 1,
      command: "zsh",
      cwd: workspace
    }]);
    fs.writeFileSync(tmuxCallsPath, "");
    const stateBefore = fs.readFileSync(task.statePath, "utf8");
    const eventsBefore = fs.readFileSync(task.logPath, "utf8");
    const reconcileArgs = [
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--terminal-monitors-only",
      "--disable-terminal-bridge-monitor",
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      "[]"
    ];
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };

    const reconciled = runAgentCli(reconcileArgs, testEnv);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const output = JSON.parse(reconciled.stdout);
    assert.equal(output.launched, 0);
    assert.equal(output.errors, 0);
    assert.equal(
      output.items.some((item) =>
        item.conversation_id === task.conversation.conversation_id &&
        item.status === "stalled" &&
        item.reason ===
          "bound_agent_process_verified_dead_completion_unverifiable"
      ),
      true,
      reconciled.stdout
    );
    assert.notEqual(fs.readFileSync(task.statePath, "utf8"), stateBefore);
    assert.notEqual(fs.readFileSync(task.logPath, "utf8"), eventsBefore);
    const stalled = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    assert.equal(stalled.status, "stalled");
    assert.match(
      String(stalled.stalled_reason ?? ""),
      /bound terminal agent process is verified dead/iu
    );
    assert.equal(stalled.terminal_agent_process_disposition?.status, "verified_dead");
    assert.equal(
      stalled.terminal_agent_process_disposition
        ?.completion_observation?.status,
      "unverifiable"
    );
    assert.equal(eventCount(task.logPath, "terminal_agent_process_verified_dead"), 1);
    assert.equal(eventCount(task.logPath, "conversation_stalled"), 1);
    assert.equal(
      readJsonLines(task.logPath).find((event) =>
        event.event === "conversation_stalled"
      )?.completion_observation,
      "unverifiable"
    );
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status, "agent_accepted");
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      0
    );

    const stateAfterFirst = fs.readFileSync(task.statePath, "utf8");
    const eventsAfterFirst = fs.readFileSync(task.logPath, "utf8");
    const second = runAgentCli(reconcileArgs, testEnv);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(JSON.parse(second.stdout).launched, 0);
    assert.equal(fs.readFileSync(task.statePath, "utf8"), stateAfterFirst);
    assert.equal(fs.readFileSync(task.logPath, "utf8"), eventsAfterFirst);
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status, "agent_accepted");
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      0
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("durable Claude transcript completion wins over verified process death", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-dead-complete-"));
  const storeDir = path.join(tempDir, "conversations");
  const runtimeDir = path.join(tempDir, ".akk-cli-test-runtime");
  const claudeHome = path.join(tempDir, ".claude");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42314;
  const claudeSessionId = "44444444-4444-4444-8444-444444444444";
  const request = "Complete this Claude task durably before process exit";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    const task = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      claudeHome,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: request
    });
    const accepted = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    const anchor = accepted.native_session_takeover.claude_transcript_anchor;
    assert.equal(anchor.session_id, claudeSessionId);
    assert.equal(anchor.pid, claudePid);
    assert.equal(anchor.file_existed, false);
    assert.equal(anchor.offset_bytes, 0);

    const promptAt = new Date(Date.parse(anchor.captured_at) + 100).toISOString();
    const completedAt = new Date(Date.parse(promptAt) + 100).toISOString();
    const promptUuid = "00000000-0000-4000-8000-000000000011";
    const thinkingUuid = "00000000-0000-4000-8000-000000000012";
    const textUuid = "00000000-0000-4000-8000-000000000013";
    const durationUuid = "00000000-0000-4000-8000-000000000014";
    const messageId = "00000000-0000-4000-8000-000000000111";
    const base = (uuid: string, parentUuid: string | null, timestamp: string) => ({
      uuid,
      parentUuid,
      isSidechain: false,
      entrypoint: "cli",
      timestamp,
      cwd: workspace,
      sessionId: claudeSessionId,
      version: "2.1.218"
    });
    const ledgerPath = findTerminalDispatchLedgerPath(
      task.conversation.conversation_id,
      runtimeDir
    );
    const transcriptPath = persistAnchoredClaudePromptAcceptance({
      statePath: task.statePath,
      ledgerPath,
      claudeHome,
      workspace,
      claudePid,
      claudeSessionId,
      promptUuid,
      promptId: "00000000-0000-4000-8000-000000000211"
    });
    fs.appendFileSync(transcriptPath, [
      {
        ...base(thinkingUuid, promptUuid, promptAt),
        type: "assistant",
        message: {
          role: "assistant",
          id: messageId,
          stop_reason: "end_turn",
          content: [{ type: "thinking", thinking: "not returned" }]
        }
      },
      {
        ...base(textUuid, thinkingUuid, completedAt),
        type: "assistant",
        message: {
          role: "assistant",
          id: messageId,
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Claude completed before exiting." }]
        }
      },
      {
        ...base(durationUuid, textUuid, completedAt),
        type: "system",
        subtype: "turn_duration",
        durationMs: 100
      }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
    fs.chmodSync(transcriptPath, 0o600);

    writeFakeProcessTools(fakeBinDir, [{
      pid: 998,
      ppid: 1,
      command: "zsh",
      cwd: workspace
    }]);
    fs.writeFileSync(tmuxCallsPath, "");
    const reconciled = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--terminal-monitors-only",
      "--disable-terminal-bridge-monitor",
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      "[]"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const output = JSON.parse(reconciled.stdout);
    assert.equal(output.launched, 0);
    assert.equal(output.errors, 0);
    assert.equal(
      output.items.some((item) =>
        item.conversation_id === task.conversation.conversation_id &&
        item.status === "recovered" &&
        item.reason === "bound_agent_process_dead_completion_recovered" &&
        item.delivered === true
      ),
      true,
      reconciled.stdout
    );

    const completed = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    assert.equal(completed.status, "idle");
    assert.equal(completed.terminal_agent_process_disposition, undefined);
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
      "resolved"
    );
    assert.equal(eventCount(task.logPath, "terminal_bridge_completion_detected"), 1);
    assert.equal(eventCount(task.logPath, "terminal_agent_process_verified_dead"), 0);
    assert.equal(eventCount(task.logPath, "conversation_stalled"), 0);
    assert.equal(readJsonLines(openclawCallsPath).length, 1);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      0
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-monitors restarts transcript-backed Claude bridges without sending terminal input", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-reconcile-"));
  const storeDir = path.join(tempDir, "conversations");
  const claudeHome = path.join(tempDir, ".claude");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42311;
  const claudeSessionId = "66666666-6666-4666-8666-666666666666";
  let monitorPid: number | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    const task = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      claudeHome,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: "Continue the transcript-backed task after restart"
    });
    const storedAfterSend = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    const nativeTakeover = storedAfterSend.native_session_takeover;
    assert.equal(typeof nativeTakeover.claude_transcript_anchor, "object");
    assert.deepEqual(
      Object.keys(nativeTakeover).filter((key) => key.startsWith("claude_hook_")),
      []
    );
    const sendKeysBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };

    const reconciled = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--monitor-poll-interval-ms",
      "20"
    ], testEnv);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const parsed = JSON.parse(reconciled.stdout);
    assert.equal(parsed.checked, 1);
    assert.equal(parsed.launched, 1);
    assert.equal(parsed.skipped, 0);
    assert.equal(parsed.errors, 0);
    monitorPid = parsed.items[0]?.monitor_pid;
    await waitForCondition(
      () => eventCount(task.logPath, "terminal_bridge_monitor_started") === 1,
      "Claude transcript monitor to start after reconciliation"
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBefore
    );
    const reconciledState = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    assert.deepEqual(
      Object.keys(reconciledState.native_session_takeover)
        .filter((key) => key.startsWith("claude_hook_")),
      []
    );
    assert.doesNotMatch(fs.readFileSync(task.logPath, "utf8"), /claude_hook_/u);

    const closed = runAgentCli([
      "close",
      "--state",
      task.statePath,
      "--reason",
      "Claude transcript reconciliation test cleanup"
    ]);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    await waitForPidExit(monitorPid);
  } finally {
    killPidBestEffort(monitorPid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
