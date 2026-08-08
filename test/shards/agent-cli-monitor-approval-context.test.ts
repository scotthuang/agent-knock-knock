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

test("terminal bridge monitor callbacks when the completed prompt has scrolled out of the screen excerpt", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-screen-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-screen-completion-process",
    rolloutPath: path.join(tempDir, "codex-screen-completion-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const request = "git pull 完后看一下最近的 commits，告诉我都更新了哪些特性";
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `my-work\t0\t0\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:my-work:0.0:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
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
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;
    assert.equal(
      typeof sentParsed.conversation.native_session_takeover.terminal_bridge_pre_send_screen_fingerprint,
      "string"
    );

    fs.writeFileSync(screenPath, [
      "  这次 pull 实际只更新了 1 个 commit：",
      "",
      "  71afa78 fix(daemon): stop logging client disconnects as connection errors (#328)",
      "",
      "  更新内容：",
      "  - 新增 is_client_disconnect() 识别客户端主动断开连接",
      "  - daemon 不再把 BrokenPipe/ConnectionReset 等正常断连记录为服务端错误",
      "",
      "─ Worked for 4m 48s ───────────────────────────────────────────────",
      "",
      "› Find and fix a bug in @filename",
      "",
      "  gpt-5.6-sol high · ~/github/coven"
    ].join("\n"));

    const monitored = runAgentCli([
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
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "my-work:0.0",
        session: "my-work",
        window: 0,
        pane: 0,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "my-work:0.0": fs.readFileSync(screenPath, "utf8")
      }),
      ...nativeIdentityArgs
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.message.type, "done");
    assert.match(parsed.message.body, /这次 pull 实际只更新了 1 个 commit/);
    assert.doesNotMatch(parsed.message.body, /Worked for|Find and fix|gpt-5\.6/);
    assert.equal(parsed.message.metadata.confidence, "screen_only");
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(typeof parsed.conversation.idle_since, "string");

    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_completion_detected/);
    assert.match(events, /"match":"terminal_screen"/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal approval notification releases the state lock during callback delivery and preserves concurrent close", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-approval-callback-close-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const openclawGatePath = path.join(tempDir, "openclaw-gate");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "codex-approval-lock:0.1";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-approval-close-race-process",
    rolloutPath: path.join(tempDir, "codex-approval-close-race-rollout.jsonl")
  });
  const approvalScreen = [
    "  Would you like to run the following command?",
    "",
    "  $ npm install",
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel"
  ].join("\n");
  let monitoring: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let closing: ReturnType<typeof spawnAgentCliCaptured> | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-approval-lock\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:33389`,
      "--message",
      "Install dependencies if needed",
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
    fs.writeFileSync(screenPath, approvalScreen);
    const conversationId = sentParsed.conversation.conversation_id;
    const statePath = sentParsed.conversation.state_path;
    const logPath = sentParsed.conversation.event_log_path;
    const stateLockPath = `${statePath}.lock`;

    monitoring = spawnAgentCliCaptured([
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
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: terminalTarget,
        session: "codex-approval-lock",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: approvalScreen }),
      ...nativeIdentityArgs
    ], {
      ...testEnv,
      AKK_TEST_OPENCLAW_GATE_PATH: openclawGatePath
    });
    await waitForCondition(
      () => fs.existsSync(`${openclawGatePath}.entered`),
      "approval callback delivery to enter the OpenClaw gate"
    );

    assert.equal(
      fs.existsSync(stateLockPath),
      false,
      "the monitor must release the notification state lock before calling OpenClaw"
    );
    const pendingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(pendingState.status, "waiting_for_openclaw");
    assert.equal(pendingState.callback_delivery.status, "pending");
    assert.equal(pendingState.callback_delivery.kind, "approval_notification");
    assert.equal(pendingState.callback_delivery.preserve_conversation_status, true);
    assert.equal(pendingState.callback_delivery.attempt_pid, monitoring.child.pid);
    assert.equal(typeof pendingState.callback_delivery.attempt_id, "string");

    closing = spawnAgentCliCaptured([
      "close",
      "--conversation",
      conversationId,
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--reason",
      "closed while approval callback was in flight"
    ], testEnv);
    await waitForChildExit(closing.child);
    const closed = await closing.result;
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    const closedParsed = JSON.parse(closed.stdout);
    assert.equal(closedParsed.conversation.status, "closed");
    assert.equal(
      monitoring.child.exitCode,
      null,
      "the callback should remain blocked while close completes independently"
    );
    const closedWhilePending = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(closedWhilePending.status, "closed");
    assert.equal(closedWhilePending.callback_delivery.status, "pending");

    fs.writeFileSync(`${openclawGatePath}.release`, "");
    const monitored = await monitoring.result;
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.conversation.status, "closed");
    assert.equal(monitoredParsed.conversation.callback_delivery.status, "delivered");

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "closed");
    assert.equal(finalState.callback_delivery.status, "delivered");
    assert.equal(finalState.closed_at, closedParsed.conversation.closed_at);
    assert.equal(finalState.updated_at, closedParsed.conversation.updated_at);
    assert.equal(finalState.close_reason, "closed while approval callback was in flight");
    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_approval_notification_recorded/u);
    assert.match(events, /callback_gateway_method_delivery/u);
    assert.match(events, /"state_preserved":true/u);
    assert.match(events, /conversation_closed/u);
  } finally {
    fs.writeFileSync(`${openclawGatePath}.release`, "");
    killPidBestEffort(monitoring?.child.pid);
    killPidBestEffort(closing?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor callbacks for Codex approval and approve resumes waiting", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-approval-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-approval-monitor-process",
    rolloutPath: path.join(tempDir, "codex-approval-monitor-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const approvalScreen = [
      "  Would you like to run the following command?",
      "",
      "  $ npm install",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel"
    ].join("\n");
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Install dependencies if needed",
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
    fs.writeFileSync(screenPath, approvalScreen);
    const conversationId = sentParsed.conversation.conversation_id;
    const storedPaths = pathsForConversation(conversationId, storeDir);
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;

    const monitored = runAgentCli([
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
      JSON.stringify({
        "codex-work:0.1": approvalScreen
      }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.message.type, "question");
    assert.equal(monitoredParsed.message.metadata.reason, "approval_required");
    assert.deepEqual(monitoredParsed.message.metadata.approval_candidate, {
      agent: "codex",
      kind: "run_command",
      command: "npm install",
      cwd: workspace,
      fingerprint: monitoredParsed.message.metadata.approval_fingerprint,
      terminal_target: "codex-work:0.1",
      decision_mode: "keys"
    });
    assert.match(monitoredParsed.message.body, new RegExp(`AKK approve ${conversationId}`));
    assert.match(monitoredParsed.message.body, new RegExp(`AKK cancel ${conversationId}`));
    assert.match(monitoredParsed.message.body, /agent_knock_knock_approve/);
    assert.match(monitoredParsed.message.body, /agent_knock_knock_cancel/);
    assert.match(monitoredParsed.message.body, /\$ npm install/);
    assert.equal(monitoredParsed.conversation.status, "waiting_for_openclaw");

    const openclawCalls = readJsonLines(openclawCallsPath);
    const paramsIndex = openclawCalls[0].args.indexOf("--params");
    assert.notEqual(paramsIndex, -1);
    const gatewayParams = JSON.parse(openclawCalls[0].args[paramsIndex + 1]);
    assert.equal(gatewayParams.message.type, "question");
    assert.equal(
      gatewayParams.message.metadata.approve_command,
      `AKK approve ${conversationId} --expected-approval-fingerprint ${monitoredParsed.message.metadata.approval_fingerprint}`
    );
    assert.equal(gatewayParams.message.metadata.deny_command, `AKK cancel ${conversationId}`);
    assert.equal(gatewayParams.message.metadata.approval_candidate.command, "npm install");

    const writeApprovalRecoveryClone = (
      name: string,
      mutate: (state: any) => any
    ) => writeConversationClone(
      path.join(tempDir, `${name}-store`),
      monitoredParsed.conversation,
      monitoredParsed.conversation.conversation_id,
      mutate
    );
    const recoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-outbox-recovery",
      (state) => {
        const { callback_delivery: _missingOutbox, ...withoutOutbox } = state;
        return {
          ...withoutOutbox,
          status: "waiting_for_agent",
          response_rounds_used: Math.max(
            0,
            monitoredParsed.message.round - 1
          ),
          updated_at:
            state.native_session_takeover.terminal_bridge_approval.notified_at
        };
      }
    );
    const recoveryLogPath = path.join(
      path.dirname(recoveryStatePath),
      "events.ndjson"
    );
    const recoveryMessage = {
      ...monitoredParsed.message,
      conversation_id: monitoredParsed.conversation.conversation_id
    };
    fs.writeFileSync(recoveryLogPath, `${JSON.stringify({
      ts: recoveryMessage.ts,
      conversation_id: monitoredParsed.conversation.conversation_id,
      event: "message",
      from: recoveryMessage.from,
      to: recoveryMessage.to,
      type: recoveryMessage.type,
      requires_response: recoveryMessage.requires_response,
      round: recoveryMessage.round,
      body: recoveryMessage.body,
      message: recoveryMessage
    })}\n`, { mode: 0o600 });
    const recoveredNotification = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      recoveryStatePath,
      "--log",
      recoveryLogPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      recoveredNotification.status,
      0,
      recoveredNotification.stderr || recoveredNotification.stdout
    );
    const recoveredParsed = JSON.parse(recoveredNotification.stdout);
    assert.equal(recoveredParsed.delivered, true);
    assert.equal(recoveredParsed.message.id, monitoredParsed.message.id);
    assert.equal(recoveredParsed.conversation.callback_delivery.status, "delivered");
    const recoveryEvents = readJsonLines(recoveryLogPath);
    assert.equal(
      recoveryEvents.filter((event) => event.event === "message").length,
      1,
      "outbox recovery must not duplicate the fixed callback message"
    );
    assert.equal(
      recoveryEvents.some((event) =>
        event.event === "terminal_bridge_approval_notification_outbox_recovered"
      ),
      true
    );

    const markerOnlyRecoveryMessageId =
      "msg-approval-marker-before-message-event";
    const markerOnlyRecoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-marker-only-recovery",
      (state) => {
        const {
          callback_delivery: _missingOutbox,
          ...withoutOutbox
        } = state;
        return {
          ...withoutOutbox,
          status: "waiting_for_agent",
          response_rounds_used: Math.max(
            0,
            monitoredParsed.message.round - 1
          ),
          native_session_takeover: {
            ...state.native_session_takeover,
            terminal_bridge_approval: {
              ...state.native_session_takeover.terminal_bridge_approval,
              callback_message_id: markerOnlyRecoveryMessageId
            }
          },
          updated_at:
            state.native_session_takeover.terminal_bridge_approval.notified_at
        };
      }
    );
    const markerOnlyRecoveryLogPath = path.join(
      path.dirname(markerOnlyRecoveryStatePath),
      "events.ndjson"
    );
    const markerOnlyRecovered = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      markerOnlyRecoveryStatePath,
      "--log",
      markerOnlyRecoveryLogPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      markerOnlyRecovered.status,
      0,
      markerOnlyRecovered.stderr || markerOnlyRecovered.stdout
    );
    const markerOnlyRecoveredParsed = JSON.parse(
      markerOnlyRecovered.stdout
    );
    assert.equal(markerOnlyRecoveredParsed.delivered, true);
    assert.equal(
      markerOnlyRecoveredParsed.message.id,
      markerOnlyRecoveryMessageId
    );
    const markerOnlyRecoveryEvents = readJsonLines(
      markerOnlyRecoveryLogPath
    );
    assert.equal(
      markerOnlyRecoveryEvents.filter((event) =>
        event.event === "message"
      ).length,
      1,
      "recovery after the stable marker save must create one message event"
    );
    assert.equal(
      markerOnlyRecoveryEvents.some((event) =>
        event.event ===
          "terminal_bridge_approval_notification_outbox_recovered"
      ),
      true
    );

    const recoveredCallbackMessageId = "msg-new-approval-after-crash";
    const staleOutboxRecoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-stale-outbox-recovery",
      (state) => {
        const approval = {
          ...state.native_session_takeover.terminal_bridge_approval,
          callback_message_id: recoveredCallbackMessageId
        };
        return {
          ...state,
          status: "waiting_for_agent",
          updated_at: approval.notified_at,
          native_session_takeover: {
            ...state.native_session_takeover,
            terminal_bridge_approval: approval
          },
          callback_delivery: {
            ...state.callback_delivery,
            status: "delivered",
            attempts: 3,
            final_status: "closed",
            kind: "completion",
            message: {
              ...state.callback_delivery.message,
              id: "msg-old-delivered-callback"
            }
          }
        };
      }
    );
    const staleOutboxRecoveryLogPath = path.join(
      path.dirname(staleOutboxRecoveryStatePath),
      "events.ndjson"
    );
    const staleOutboxRecovered = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      staleOutboxRecoveryStatePath,
      "--log",
      staleOutboxRecoveryLogPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      staleOutboxRecovered.status,
      0,
      staleOutboxRecovered.stderr || staleOutboxRecovered.stdout
    );
    const staleOutboxRecoveredParsed = JSON.parse(staleOutboxRecovered.stdout);
    assert.equal(staleOutboxRecoveredParsed.delivered, true);
    assert.equal(
      staleOutboxRecoveredParsed.message.id,
      recoveredCallbackMessageId
    );
    assert.equal(
      staleOutboxRecoveredParsed.conversation.callback_delivery.attempts,
      1,
      "a new approval notification must not inherit stale callback attempts"
    );
    assert.equal(
      staleOutboxRecoveredParsed.conversation.callback_delivery.kind,
      "approval_notification"
    );
    assert.equal(
      staleOutboxRecoveredParsed.conversation.callback_delivery.final_status,
      "waiting_for_openclaw"
    );
    const staleOutboxRecoveryEvents = readJsonLines(
      staleOutboxRecoveryLogPath
    );
    assert.equal(
      staleOutboxRecoveryEvents.filter((event) => event.event === "message").length,
      1
    );
    assert.equal(
      staleOutboxRecoveryEvents.some((event) =>
        event.event === "terminal_bridge_approval_notification_outbox_recovered"
      ),
      true
    );
    assert.equal(
      staleOutboxRecoveryEvents.some((event) =>
        event.event === "callback_retry_monitor_launched"
      ),
      true,
      "the fresh first attempt must retain callback retry coverage"
    );

    const exhaustedCallbackMessageId =
      "msg-new-approval-after-exhausted-callback";
    const exhaustedOutboxRecoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-exhausted-outbox-recovery",
      (state) => {
        const approval = {
          ...state.native_session_takeover.terminal_bridge_approval,
          callback_message_id: exhaustedCallbackMessageId
        };
        return {
          ...state,
          status: "waiting_for_agent",
          updated_at: approval.notified_at,
          native_session_takeover: {
            ...state.native_session_takeover,
            terminal_bridge_approval: approval
          },
          callback_delivery: {
            ...state.callback_delivery,
            status: "failed",
            attempts: 5,
            final_status: "closed",
            kind: "completion",
            message: {
              ...state.callback_delivery.message,
              id: "msg-exhausted-failed-callback"
            }
          }
        };
      }
    );
    const exhaustedOutboxRecoveryLogPath = path.join(
      path.dirname(exhaustedOutboxRecoveryStatePath),
      "events.ndjson"
    );
    const olderSameBodyMessage = {
      ...monitoredParsed.message,
      id: "msg-older-same-body-callback"
    };
    fs.writeFileSync(exhaustedOutboxRecoveryLogPath, `${JSON.stringify({
      ts: olderSameBodyMessage.ts,
      conversation_id: monitoredParsed.conversation.conversation_id,
      event: "message",
      from: olderSameBodyMessage.from,
      to: olderSameBodyMessage.to,
      type: olderSameBodyMessage.type,
      requires_response: olderSameBodyMessage.requires_response,
      round: olderSameBodyMessage.round,
      body: olderSameBodyMessage.body,
      message: olderSameBodyMessage
    })}\n`, { mode: 0o600 });
    const exhaustedOutboxRecovered = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      exhaustedOutboxRecoveryStatePath,
      "--log",
      exhaustedOutboxRecoveryLogPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      exhaustedOutboxRecovered.status,
      0,
      exhaustedOutboxRecovered.stderr || exhaustedOutboxRecovered.stdout
    );
    const exhaustedOutboxRecoveredParsed = JSON.parse(
      exhaustedOutboxRecovered.stdout
    );
    assert.equal(exhaustedOutboxRecoveredParsed.delivered, true);
    assert.equal(
      exhaustedOutboxRecoveredParsed.message.id,
      exhaustedCallbackMessageId
    );
    assert.equal(
      exhaustedOutboxRecoveredParsed.conversation.callback_delivery.attempts,
      1
    );
    const exhaustedRecoveryEvents = readJsonLines(
      exhaustedOutboxRecoveryLogPath
    );
    assert.equal(
      exhaustedRecoveryEvents.some((event) =>
        event.event === "terminal_bridge_approval_notification_outbox_recovered"
      ),
      true
    );
    assert.equal(
      exhaustedRecoveryEvents.filter((event) => event.event === "message").length,
      2,
      "a same-body event with another id must not suppress the fixed recovery message"
    );
    assert.equal(
      exhaustedRecoveryEvents.some((event) =>
        event.event === "message" &&
        event.message?.id === exhaustedCallbackMessageId
      ),
      true
    );

    const conflictingCallbackMessageId =
      "msg-conflicting-approval-recovery";
    const conflictingRecoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-conflicting-log-recovery",
      (state) => {
        const approval = {
          ...state.native_session_takeover.terminal_bridge_approval,
          callback_message_id: conflictingCallbackMessageId
        };
        return {
          ...state,
          status: "waiting_for_agent",
          updated_at: approval.notified_at,
          native_session_takeover: {
            ...state.native_session_takeover,
            terminal_bridge_approval: approval
          },
          callback_delivery: {
            ...state.callback_delivery,
            status: "delivered",
            message: {
              ...state.callback_delivery.message,
              id: "msg-old-before-conflicting-recovery"
            }
          }
        };
      }
    );
    const conflictingRecoveryLogPath = path.join(
      path.dirname(conflictingRecoveryStatePath),
      "events.ndjson"
    );
    const conflictingLoggedMessage = {
      ...monitoredParsed.message,
      id: conflictingCallbackMessageId,
      body: "A different payload was already logged under this stable id."
    };
    fs.writeFileSync(conflictingRecoveryLogPath, `${JSON.stringify({
      ts: conflictingLoggedMessage.ts,
      conversation_id: monitoredParsed.conversation.conversation_id,
      event: "message",
      from: conflictingLoggedMessage.from,
      to: conflictingLoggedMessage.to,
      type: conflictingLoggedMessage.type,
      requires_response: conflictingLoggedMessage.requires_response,
      round: conflictingLoggedMessage.round,
      body: conflictingLoggedMessage.body,
      message: conflictingLoggedMessage
    })}\n`, { mode: 0o600 });
    const openclawCallCountBeforeConflict =
      readJsonLines(openclawCallsPath).length;
    const conflictingRecovery = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      conflictingRecoveryStatePath,
      "--log",
      conflictingRecoveryLogPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.notEqual(conflictingRecovery.status, 0);
    assert.match(
      conflictingRecovery.stderr,
      /conflicts with its logged payload/u
    );
    assert.equal(
      readJsonLines(openclawCallsPath).length,
      openclawCallCountBeforeConflict,
      "a conflicting stable message id must fail before Gateway delivery"
    );

    fs.writeFileSync(screenPath, approvalScreen.replace("$ npm install", "$ npm install left-pad"));
    const persistedFingerprintMismatch = runAgentCli([
      "approve",
      "--state",
      statePath,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      persistedFingerprintMismatch.status,
      0,
      persistedFingerprintMismatch.stderr || persistedFingerprintMismatch.stdout
    );
    assert.match(JSON.parse(persistedFingerprintMismatch.stdout).reason, /fingerprint changed/);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys" && call.args.at(-1) === "y"),
      false
    );
    fs.writeFileSync(screenPath, approvalScreen);

    const fingerprintMismatch = runAgentCli([
      "approve",
      "--state",
      statePath,
      "--expected-approval-fingerprint",
      "different-fingerprint",
      "--auto-approved",
      "--policy-rule-id",
      "test-rule",
      "--policy-fingerprint",
      "policy-123",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(fingerprintMismatch.status, 0, fingerprintMismatch.stderr || fingerprintMismatch.stdout);
    const mismatchParsed = JSON.parse(fingerprintMismatch.stdout);
    assert.equal(mismatchParsed.approved, false);
    assert.match(mismatchParsed.reason, /fingerprint changed/);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys" && call.args.at(-1) === "y"),
      false
    );

    const forgedCallbackPolicy = {
      enabled: true,
      rules: [{
        id: "test-rule",
        agents: ["codex"],
        workspaces: [workspace],
        commands: [["pwd"]]
      }]
    };
    const executorSideRejected = runAgentCli([
      "approve",
      "--state",
      statePath,
      "--expected-approval-fingerprint",
      monitoredParsed.message.metadata.approval_fingerprint,
      "--auto-approved",
      "--policy-rule-id",
      "test-rule",
      "--auto-approval-policy-json",
      JSON.stringify(forgedCallbackPolicy),
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      executorSideRejected.status,
      0,
      executorSideRejected.stderr || executorSideRejected.stdout
    );
    assert.equal(JSON.parse(executorSideRejected.stdout).approved, false);
    assert.match(
      JSON.parse(executorSideRejected.stdout).reason,
      /executor-side auto-approval policy rejected/
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).some(
        (call) => call.args[0] === "send-keys" && call.args.at(-1) === "y"
      ),
      false,
      "a callback-declared safe command must not authorize the different live prompt"
    );

    const safePolicy = {
      enabled: true,
      rules: [{
        id: "test-rule",
        agents: ["codex"],
        workspaces: [workspace],
        commands: [["npm", "install"]]
      }]
    };
    const approved = runAgentCli([
      "approve",
      "--state",
      statePath,
      "--expected-approval-fingerprint",
      monitoredParsed.message.metadata.approval_fingerprint,
      "--auto-approved",
      "--policy-rule-id",
      "test-rule",
      "--auto-approval-policy-json",
      JSON.stringify(safePolicy),
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.key, "y");
    assert.equal(approvedParsed.auto_approved, true);
    assert.equal(approvedParsed.policy_rule_id, "test-rule");
    assert.equal(approvedParsed.conversation.status, "waiting_for_agent");
    assert.equal(approvedParsed.conversation.native_session_takeover.terminal_bridge_approval, undefined);
    const calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "y"]);

    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_approval_detected/);
    assert.match(events, /terminal_bridge_approval_notification_recorded/);
    assert.match(events, /terminal_auto_approval_decision/);
    assert.match(events, /"action":"rejected"/);
    assert.match(events, /"action":"approved"/);
    assert.match(events, /callback_gateway_method_delivery/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal-controlled conversation ids use Codex pid, not tmux pane pid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-pid-"));
  const storeDir = path.join(tempDir, "conversations");
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
      `codex-work\t0\t0\t999\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:tmux:codex-work:0.0:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      conversationId,
      "--message",
      "继续",
      "--background",
      "--store-dir",
      storeDir,
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "node /Users/scotthuang/.npm-global/bin/codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.0",
        panePid: 999,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.0": "› \n" })
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(
      sentParsed.conversation.native_session_takeover.native_session_id,
      conversationId
    );
    assert.equal(
      sentParsed.conversation.native_session_takeover.terminal_agent_pid,
      33389
    );
    assert.equal(sentParsed.terminal_control.panePid, 999);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status includes terminal-controlled Codex context from rollout history", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Add AKK status context"
      }
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I am wiring the OpenClaw tool."
      }
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:02:00.000Z",
      type: "response_item",
      payload: {
        command: "npm test",
        status: "completed"
      }
    })
  ].join("\n");

  const status = runAgentCli([
    "status",
    "--conversation",
    "terminal:tmux:codex-work:0.0:33389",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--processes-json",
    JSON.stringify([{
      pid: 33389,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd
    }]),
    "--terminals-json",
    JSON.stringify([tmuxPane()]),
    "--terminal-screens-json",
    JSON.stringify({
      "codex-work:0.0": "Working\n"
    }),
    "--rollouts-json",
    JSON.stringify({ [rolloutPath]: rollout })
  ]);

  assert.equal(status.status, 0, status.stderr || status.stdout);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.source, "terminal_control");
  assert.equal(parsed.confidence, "high");
  assert.match(parsed.about, /Add AKK status context/);
  assert.match(parsed.about, /OpenClaw tool/);
  assert.deepEqual(parsed.limitations, []);
});

test("status context prefers Codex title over injected environment context", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "<environment_context> <cwd>/repo/project</cwd> </environment_context>"
      }
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I checked the README and summarized the project."
      }
    })
  ].join("\n");

  const status = runAgentCli([
    "status",
    "--conversation",
    "terminal:tmux:codex-work:0.0:33389",
    "--threads-json",
    JSON.stringify([threadRow({ title: "Read the README and explain this project" })]),
    "--processes-json",
    JSON.stringify([{
      pid: 33389,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd
    }]),
    "--terminals-json",
    JSON.stringify([tmuxPane()]),
    "--terminal-screens-json",
    JSON.stringify({
      "codex-work:0.0": "Codex is ready\n"
    }),
    "--rollouts-json",
    JSON.stringify({ [rolloutPath]: rollout })
  ]);

  assert.equal(status.status, 0, status.stderr || status.stdout);
  const parsed = JSON.parse(status.stdout);
  assert.match(parsed.about, /Read the README and explain this project/);
  assert.doesNotMatch(parsed.about, /environment_context/);
});
