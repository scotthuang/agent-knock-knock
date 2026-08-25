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
import {
  createTerminalControlProviderRegistry,
  TmuxTerminalControlProvider
} from "../../src/terminal-control-provider.js";
import { SystemTerminalProcessSource } from "../../src/terminal-process-source.js";
import { createOpenClawPluginForTest } from "../../src/openclaw-plugin.js";
import {
  cwd,
  sessionId,
  rolloutPath,
  startManagedClaudeTerminalTask,
  claudeTerminalStaticArgs,
  claudeAgentRow,
  codexNativeIdentityArgs,
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
import { runInProcessCli } from "../in-process-cli-fixtures.js";

test("CLI reports a multilingual multiline draft left in Codex after one Enter", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-multiline-not-accepted-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const rolloutPath = path.join(tempDir, "rollout.jsonl");
  const runtimeDir = path.join(tempDir, "runtime");
  const tmuxSession = `akk-multiline-not-accepted-${process.pid}`;
  const target = `${tmuxSession}:0.1`;
  const pid = 43391;
  const request = "第一行：请检查状态\nSecond line with  two spaces.";
  const exactComposer = [
    "Ready",
    "› 第一行：请检查状态",
    "  Second line with  two spaces.",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  const composerAfterEnter = [
    "Ready",
    "› 第一行：请检查状态",
    "  Second line with  two spaces.",
    "  ",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`,
      { mode: 0o600 }
    );
    const rolloutStat = fs.statSync(rolloutPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${pid}\tnode\t${workspace}\n`
    );
    const args = [
      "send",
      "--conversation",
      `terminal:tmux:${target}:${pid}`,
      "--message",
      request,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      "--terminal-acceptance-timeout-ms",
      "20",
      "--codex-active-session-identities-json",
      JSON.stringify({
        [pid]: {
          sessionId,
          processUuid: "codex-multiline-not-accepted",
          processBirth: "codex-multiline-not-accepted",
          rollout: {
            fd: "12r",
            device: String(rolloutStat.dev),
            inode: String(rolloutStat.ino),
            path: rolloutPath
          }
        }
      })
    ];
    const commandEnvironment = {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_TMUX_COMPOSER_AFTER_PASTE: exactComposer,
      AKK_TEST_TMUX_COMPOSER_AFTER_ENTER: composerAfterEnter
    };
    const runCommand = (command: string, commandArgs: string[]) => {
      const completed = spawnSync(command, commandArgs, {
        encoding: "utf8",
        env: commandEnvironment
      });
      return {
        status: completed.status,
        stdout: completed.stdout ?? "",
        stderr: completed.stderr ?? "",
        ...(completed.error ? { error: completed.error } : {})
      };
    };
    const result = await runInProcessCli(args, {
      env: commandEnvironment,
      terminalControlProviderRegistry: createTerminalControlProviderRegistry([
        new TmuxTerminalControlProvider({
          commands: ["tmux"],
          runCommand,
          socketPaths: []
        })
      ]),
      terminalProcessSource: new SystemTerminalProcessSource({ runCommand })
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.delivered, false);
    assert.equal(parsed.status, "submission_not_accepted");
    assert.equal(parsed.submission_outcome, "not_accepted");
    assert.equal(parsed.do_not_retry, true);
    assert.equal(
      parsed.conversation.native_session_takeover.terminal_bridge_submission.status,
      "not_accepted"
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
        .length,
      1,
      "AKK must never send a blind second Enter"
    );
    const ledgerPath = findTerminalDispatchLedgerPath(
      parsed.conversation.conversation_id,
      runtimeDir
    );
    const closed = await runAgentCliInProcess([
      "close",
      "--state",
      parsed.conversation.state_path,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir
    });
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    const resolvedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    assert.equal(resolvedLedger.status, "resolved");
    const preservedReceipt = resolvedLedger.terminal_submission_receipts
      .find((receipt) => receipt.message_id === parsed.message.id);
    assert.equal(preservedReceipt.status, "not_accepted");
    assert.equal(typeof preservedReceipt.not_accepted_at, "string");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI accepts a visually wrapped Codex multiline composer with exactly one Enter", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-wrapped-composer-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-wrapped-composer-${process.pid}`;
  const target = `${tmuxSession}:0.1`;
  const pid = 43394;
  const request = [
    "请核对这次投递，并保持下面内容逐字不变。",
    "   - 碰撞安全的短 ID 只用于展示；实际 resume 仍用完整 UUID + fresh tokens。",
    "Second line with  two spaces.",
    "",
    "完成后只回复 ACK。"
  ].join("\n");
  const wrappedComposer = [
    "Ready",
    "› 请核对这次投递，并保持下面内容",
    "  逐字不变。",
    "     - 碰撞安全的短 ID 只用于展示；实际 resume 仍用完整",
    "  UUID + fresh tokens。",
    "  Second line with  two spaces.",
    "  ",
    "  完成后只回复 ACK。",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${pid}\tnode\t${workspace}\n`
    );
    const result = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:tmux:${target}:${pid}`,
      "--message",
      request,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      ...codexNativeIdentityArgs({
        pid,
        sessionId,
        processUuid: "codex-wrapped-composer",
        rolloutPath: path.join(tempDir, "rollout.jsonl")
      })
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_TMUX_COMPOSER_AFTER_PASTE: wrappedComposer
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) =>
        call.kind === "direct_terminal_provider"
      ),
      true,
      "the wrapped-composer witness must use the direct terminal port"
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.delivery_receipt, "agent_accepted");
    assert.deepEqual(
      readJsonLines(parsed.conversation.event_log_path)
        .map((event) => event.event)
        .filter((event) => [
          "terminal_message_submit_prepared",
          "terminal_message_text_injected",
          "terminal_message_enter_dispatched",
          "terminal_message_agent_accepted"
        ].includes(event)),
      [
        "terminal_message_submit_prepared",
        "terminal_message_text_injected",
        "terminal_message_enter_dispatched",
        "terminal_message_agent_accepted"
      ]
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("modern Claude send requires a session id and process-incarnation timestamp", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-incarnation-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const target = "claude-incarnation:0.0";
  const pid = 33402;
  const sessionId = "66666666-6666-4666-8666-666666666666";
  const rawTerminalId = `terminal:v2:tmux:claude:${target}:${pid}`;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    const sent = await runAgentCliInProcess([
      "send",
      "--conversation",
      rawTerminalId,
      "--message",
      "Do not trust a reusable numeric PID",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      JSON.stringify([{ pid, ppid: 1, command: "claude", cwd: workspace }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target,
        session: "claude-incarnation",
        window: 0,
        pane: 0,
        panePid: pid,
        currentCommand: "claude",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({ [target]: "❯ " }),
      "--claude-agents-json",
      JSON.stringify([{ pid, cwd: workspace, sessionId }])
    ]);
    assert.notEqual(sent.status, 0);
    assert.match(
      sent.stderr,
      /native Claude process incarnation cannot be verified|process-incarnation startedAt is unavailable|no longer available/u
    );
    const stateFiles = fs.existsSync(storeConversationsDir(storeDir))
      ? fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(
            storeConversationsDir(storeDir),
            entry.name,
            "state.json"
          ))
          .filter((statePath) => fs.existsSync(statePath))
      : [];
    assert.deepEqual(
      stateFiles,
      [],
      "the incomplete Claude identity must fail before a managed Turn is persisted"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raw background send durably prepares its terminal submission before tmux accepts it", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-submit-prepare-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxGatePath = path.join(tempDir, "tmux-send-gate");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-submit-prepare-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-submit-prepare-process",
    rolloutPath: path.join(tempDir, "codex-submit-prepare-rollout.jsonl")
  });
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;

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

    sending = spawnAgentCliCaptured([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Persist before sending",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_TMUX_SEND_GATE_PATH: tmuxGatePath,
      AKK_SUBPROCESS_EVIDENCE_TEST_NAME: t.name
    });

    await waitForCondition(
      () => fs.existsSync(`${tmuxGatePath}.entered`),
      "terminal submission to enter the fake tmux gate",
      15_000
    );

    const conversationDirs = fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    assert.equal(conversationDirs.length, 1);
    const conversationDir = path.join(
      storeConversationsDir(storeDir),
      conversationDirs[0].name
    );
    const statePath = path.join(conversationDir, "state.json");
    const logPath = path.join(conversationDir, "events.ndjson");
    const preparedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      preparedState.native_session_takeover.terminal_bridge_submission.status,
      "prepared"
    );
    assert.equal(
      preparedState.native_session_takeover.terminal_bridge_submission.message_id,
      preparedState.native_session_takeover.terminal_bridge_message_id
    );
    assert.equal(
      typeof preparedState.native_session_takeover.terminal_bridge_submission.request_hash,
      "string"
    );
    const preparedEvents = readJsonLines(logPath);
    assert.equal(
      preparedEvents.some((event) => event.event === "terminal_message_submit_prepared"),
      true
    );
    assert.equal(
      preparedEvents.some((event) => event.event === "terminal_message_send"),
      false
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).some(
        (call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ),
      false
    );

    fs.writeFileSync(`${tmuxGatePath}.release`, "");
    const result = await sending.result;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const submittedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      submittedState.native_session_takeover.terminal_bridge_submission.status,
      "agent_accepted"
    );
    assert.equal(
      submittedState.native_session_takeover.terminal_bridge_submission
        .acceptance_evidence.source,
      "codex_rollout"
    );
    assert.match(
      submittedState.native_session_takeover.terminal_bridge_submission
        .acceptance_evidence.requestHash,
      /^[0-9a-f]{64}$/u
    );
    assert.equal(
      readJsonLines(logPath).some((event) => event.event === "terminal_message_send"),
      true
    );
  } finally {
    if (sending?.child.exitCode === null) {
      fs.writeFileSync(`${tmuxGatePath}.release`, "");
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an orphaned prepared submission becomes uncertain without terminal attribution", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-submit-orphan-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-orphan:0.1";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-orphan-submission-process",
    rolloutPath: path.join(tempDir, "codex-orphan-submission-rollout.jsonl")
  });
  let dispatchLedgerPath: string | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-orphan\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sent = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:33389`,
      "--message",
      "Original AKK task",
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
    const statePath = sentParsed.conversation.state_path;
    const logPath = sentParsed.conversation.event_log_path;
    const submittedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const submitted =
      submittedState.native_session_takeover.terminal_bridge_submission;
    const {
      submitted_at: _submittedAt,
      text_injected_at: _textInjectedAt,
      enter_dispatched_at: _enterDispatchedAt,
      agent_accepted_at: _agentAcceptedAt,
      acceptance_evidence: _acceptanceEvidence,
      ...preparedSubmission
    } = submitted;
    const preparedReceipt = {
      ...preparedSubmission,
      status: "prepared",
      dispatcher_pid: 99999999,
      last_proven_stage: "prepared"
    };
    const preparedState = {
      ...submittedState,
      native_session_takeover: {
        ...submittedState.native_session_takeover,
        terminal_bridge_submission: preparedReceipt,
        terminal_bridge_submission_receipts: [preparedReceipt]
      },
      updated_at: submitted.prepared_at
    };
    fs.writeFileSync(statePath, `${JSON.stringify(preparedState, null, 2)}\n`);
    dispatchLedgerPath = findTerminalDispatchLedgerPath(
      sentParsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const submittedLedger = JSON.parse(
      fs.readFileSync(dispatchLedgerPath, "utf8")
    );
    const {
      submitted_at: _ledgerSubmittedAt,
      text_injected_at: _ledgerTextInjectedAt,
      enter_dispatched_at: _ledgerEnterDispatchedAt,
      agent_accepted_at: _ledgerAgentAcceptedAt,
      acceptance_evidence: _ledgerAcceptanceEvidence,
      terminal_submission_receipts: _ledgerReceipts,
      ...preparedLedger
    } = submittedLedger;
    fs.writeFileSync(
      dispatchLedgerPath,
      `${JSON.stringify({
        ...preparedLedger,
        status: "prepared",
        dispatcher_pid: 99999999,
        last_proven_stage: "prepared"
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
    fs.writeFileSync(screenPath, [
      "A human completed an unrelated task.",
      "─ Worked for 1m ─────────────────────────────",
      "› "
    ].join("\n"));

    const monitored = await runAgentCliInProcess([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
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
        target: terminalTarget,
        session: "codex-orphan",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: fs.readFileSync(screenPath, "utf8") }),
      ...nativeIdentityArgs
    ]);
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.completed, false);
    assert.equal(monitoredParsed.submission_outcome, "uncertain");
    assert.equal(monitoredParsed.do_not_retry, true);

    const uncertainState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const uncertain =
      uncertainState.native_session_takeover.terminal_bridge_submission;
    assert.equal(uncertain.status, "uncertain");
    assert.equal(typeof uncertain.uncertain_at, "string");
    assert.equal(uncertainState.updated_at, uncertain.uncertain_at);
    const entersBeforeConflictingSend = readJsonLines(tmuxCallsPath)
      .filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length;
    const conflictingSend = await runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:33389`,
      "--message",
      "Original AKK task",
      "--message-id",
      `msg-openclaw-${"f".repeat(64)}`,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      openclawBin,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.notEqual(conflictingSend.status, 0);
    assert.match(
      conflictingSend.stderr,
      /uncertain|unresolved Turn|still owned by active AKK conversation/iu
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      entersBeforeConflictingSend,
      "an active uncertain submission must not dispatch another Enter"
    );
    assert.equal(fs.existsSync(openclawCallsPath), false);
    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /dispatcher_exited_before_submitted_receipt/u);
    assert.doesNotMatch(events, /terminal_bridge_completion_detected/u);
    assert.doesNotMatch(events, /terminal_bridge_approval_detected/u);
  } finally {
    if (dispatchLedgerPath) {
      fs.rmSync(dispatchLedgerPath, { force: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a released Turn replays one stable dispatch while a new id starts a new Turn", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-submit-receipt-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxGatePath = path.join(tempDir, "tmux-send-gate");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-submit-receipt-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const request = "Do this exactly once";
  const stableMessageId = `msg-openclaw-${"a".repeat(64)}`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-submit-receipt-process",
    rolloutPath: path.join(tempDir, "codex-submit-receipt-rollout.jsonl")
  });
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let dispatchLedgerPath: string | undefined;

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
    const args = [
      "send",
      "--conversation",
      rawConversationId,
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
    ];
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    sending = spawnAgentCliCaptured(args, {
      ...testEnv,
      AKK_TEST_TMUX_SEND_GATE_PATH: tmuxGatePath,
      AKK_TEST_FINAL_TERMINAL_LEDGER_FAILURE: "1"
    });
    await waitForCondition(
      () => fs.existsSync(`${tmuxGatePath}.entered`),
      "terminal submission to enter the post-submit receipt gate",
      15_000
    );

    const conversationDir = path.join(
      storeConversationsDir(storeDir),
      fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
        .find((entry) => entry.isDirectory())!.name
    );
    const statePath = path.join(conversationDir, "state.json");
    const logPath = path.join(conversationDir, "events.ndjson");
    fs.appendFileSync(logPath, "{invalid-event\n");
    fs.writeFileSync(`${tmuxGatePath}.release`, "");

    const result = await sending.result;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.delivered, true, result.stdout || result.stderr);
    assert.equal(parsed.delivery_receipt, "agent_accepted");
    assert.ok(parsed.bookkeeping_warning);
    fs.writeFileSync(
      logPath,
      fs.readFileSync(logPath, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line !== "{invalid-event")
        .filter(Boolean)
        .map((line) => `${line}\n`)
        .join("")
    );
    const submittedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      submittedState.native_session_takeover.terminal_bridge_submission.status,
      "agent_accepted"
    );
    dispatchLedgerPath = findTerminalDispatchLedgerPath(
      parsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const acceptedLedger = JSON.parse(
      fs.readFileSync(dispatchLedgerPath, "utf8")
    );
    assert.equal(
      acceptedLedger.status,
      "enter_dispatched",
      "the injected final-ledger failure leaves transport proof behind"
    );
    const entersBeforeAcceptedReplay = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    assert.equal(entersBeforeAcceptedReplay, 1);

    const acceptedReplay = await runAgentCliInProcess(args, testEnv);
    assert.equal(
      acceptedReplay.status,
      0,
      acceptedReplay.stderr || acceptedReplay.stdout
    );
    const acceptedReplayParsed = JSON.parse(acceptedReplay.stdout);
    assert.equal(acceptedReplayParsed.replayed, true);
    assert.equal(acceptedReplayParsed.delivered, true);
    assert.equal(acceptedReplayParsed.submission_outcome, "agent_accepted");
    assert.equal(acceptedReplayParsed.delivery_receipt, "agent_accepted");
    assert.equal(acceptedReplayParsed.message.id, stableMessageId);
    assert.equal(
      acceptedReplayParsed.message.body,
      request,
      "replay must preserve the exact durable message body"
    );
    const replayedLogMessages = readJsonLines(logPath)
      .filter((event) => event.message?.id === stableMessageId)
      .map((event) => event.message);
    assert.equal(replayedLogMessages.length, 1);
    assert.equal(
      replayedLogMessages[0].body,
      request,
      "replay output and the one durable log message must have identical bytes"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(dispatchLedgerPath, "utf8")).status,
      "agent_accepted",
      "stable replay repairs a ledger that lagged the authoritative accepted state"
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      1,
      "an accepted idempotent replay must not submit a second Enter"
    );

    const submittedAt =
      submittedState.native_session_takeover.terminal_bridge_submission
        .enter_dispatched_at ?? new Date().toISOString();
    const transportOnlyState = structuredClone(submittedState);
    transportOnlyState.native_session_takeover.terminal_bridge_submission = {
      ...transportOnlyState.native_session_takeover.terminal_bridge_submission,
      status: "submitted",
      submitted_at: submittedAt,
      last_proven_stage: "enter_dispatched"
    };
    delete transportOnlyState.native_session_takeover.terminal_bridge_submission
      .agent_accepted_at;
    delete transportOnlyState.native_session_takeover.terminal_bridge_submission
      .acceptance_evidence;
    delete transportOnlyState.native_session_takeover.terminal_bridge_submission
      .message_type;
    for (const field of [
      "binding_id",
      "binding_generation",
      "message_body_hash",
      "executor_kind",
      "openclaw_session",
      "store_dir",
      "native_thread_id",
      "terminal_target",
      "terminal_socket_path",
      "terminal_pane_pid"
    ]) {
      delete transportOnlyState.native_session_takeover
        .terminal_bridge_submission[field];
    }
    delete transportOnlyState.native_session_takeover
      .terminal_bridge_submission_receipts;
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(transportOnlyState, null, 2)}\n`
    );
    const transportOnlyLedger = {
      ...acceptedLedger,
      status: "submitted",
      submitted_at: submittedAt,
      last_proven_stage: "enter_dispatched"
    };
    delete transportOnlyLedger.agent_accepted_at;
    delete transportOnlyLedger.acceptance_evidence;
    delete transportOnlyLedger.message_type;
    delete transportOnlyLedger.message_body_hash;
    delete transportOnlyLedger.openclaw_session;
    delete transportOnlyLedger.terminal_submission_receipts;
    fs.writeFileSync(
      dispatchLedgerPath,
      `${JSON.stringify(transportOnlyLedger, null, 2)}\n`
    );

    const transportOnlyReplay = await runAgentCliInProcess(args, testEnv);
    assert.equal(
      transportOnlyReplay.status,
      0,
      transportOnlyReplay.stderr || transportOnlyReplay.stdout
    );
    const transportOnlyReplayParsed = JSON.parse(transportOnlyReplay.stdout);
    assert.equal(transportOnlyReplayParsed.replayed, true);
    assert.equal(transportOnlyReplayParsed.delivered, false);
    assert.equal(
      transportOnlyReplayParsed.submission_outcome,
      "pending_acceptance"
    );
    assert.equal(transportOnlyReplayParsed.delivery_receipt, "submitted");
    assert.equal(transportOnlyReplayParsed.do_not_retry, true);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      1,
      "a transport-only idempotent replay must preserve proof and send no Enter"
    );

    const legacyClosedAt = new Date().toISOString();
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        ...transportOnlyState,
        status: "closed",
        closed_at: legacyClosedAt,
        updated_at: legacyClosedAt
      }, null, 2)}\n`
    );
    const releasedLegacyReplay = await runAgentCliInProcess(args, testEnv);
    assert.equal(
      releasedLegacyReplay.status,
      0,
      releasedLegacyReplay.stderr || releasedLegacyReplay.stdout
    );
    const releasedLegacyParsed = JSON.parse(releasedLegacyReplay.stdout);
    assert.equal(releasedLegacyParsed.replayed, true);
    assert.equal(releasedLegacyParsed.delivered, false);
    assert.equal(releasedLegacyParsed.delivery_receipt, "submitted");
    assert.equal(releasedLegacyParsed.do_not_retry, true);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      1,
      "a released v0.10.1-style transport receipt must not dispatch Enter"
    );

    fs.writeFileSync(statePath, `${JSON.stringify(submittedState, null, 2)}\n`);
    const preparedLedger = structuredClone(acceptedLedger);
    delete preparedLedger.agent_accepted_at;
    delete preparedLedger.acceptance_evidence;
    fs.writeFileSync(
      dispatchLedgerPath,
      `${JSON.stringify({
        ...preparedLedger,
        status: "enter_dispatched"
      }, null, 2)}\n`
    );
    const workingScreen = [
      "• Working on the task",
      "",
      "› Steer the current task"
    ].join("\n");
    const recovered = await runAgentCliInProcess([
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
      "--agent-hard-timeout-minutes",
      "0.001",
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
        session: tmuxSession,
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: workingScreen }),
      ...nativeIdentityArgs
    ], testEnv);
    assert.equal(
      recovered.status,
      0,
      recovered.stderr || recovered.stdout
    );
    assert.equal(JSON.parse(recovered.stdout).hard_timeout, true);
    assert.equal(
      JSON.parse(fs.readFileSync(dispatchLedgerPath, "utf8")).status,
      "agent_accepted",
      "a durable native acceptance state must repair a lagging enter-dispatched ledger"
    );
    const entersBeforeRetry = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    assert.equal(entersBeforeRetry, 1);

    const releasedAt = new Date().toISOString();
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        ...submittedState,
        status: "idle",
        idle_since: releasedAt,
        updated_at: releasedAt
      }, null, 2)}\n`
    );
    const resolvedLedger = JSON.parse(
      fs.readFileSync(dispatchLedgerPath, "utf8")
    );
    fs.writeFileSync(
      dispatchLedgerPath,
      `${JSON.stringify({
        ...resolvedLedger,
        status: "resolved",
        resolved_at: releasedAt,
        reason: "simulated durable completion"
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
    const closedReplay = await runAgentCliInProcess(args, testEnv);
    assert.equal(
      closedReplay.status,
      0,
      closedReplay.stderr || closedReplay.stdout
    );
    const closedReplayParsed = JSON.parse(closedReplay.stdout);
    assert.equal(closedReplayParsed.replayed, true);
    assert.equal(closedReplayParsed.delivered, true);
    assert.equal(closedReplayParsed.delivery_receipt, "agent_accepted");
    assert.equal(
      closedReplayParsed.conversation.conversation_id,
      parsed.conversation.conversation_id
    );
    assert.equal(listConversations(storeDir).length, 1);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
        .length,
      1,
      "an idle Turn's accepted receipt must remain idempotent"
    );
    const conflictingArgs = [...args];
    conflictingArgs[conflictingArgs.indexOf("--message") + 1] =
      "Reuse the same key for different input";
    const conflictingReplay = await runAgentCliInProcess(conflictingArgs, testEnv);
    assert.notEqual(conflictingReplay.status, 0);
    assert.match(
      conflictingReplay.stderr,
      /idempotency key .*different message|does not match its original|durable terminal receipt/iu
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
        .length,
      1,
      "a conflicting reuse of a released idempotency key must send no Enter"
    );
    const retryArgs = [...args];
    retryArgs[retryArgs.indexOf("--message-id") + 1] =
      `msg-openclaw-${"b".repeat(64)}`;
    const retried = await runAgentCliInProcess(retryArgs, testEnv);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    const retriedParsed = JSON.parse(retried.stdout);
    assert.equal(
      retriedParsed.delivered,
      true,
      retried.stdout || retried.stderr
    );
    assert.notEqual(retriedParsed.replayed, true);
    assert.equal(retriedParsed.delivery_receipt, "agent_accepted");
    assert.notEqual(
      retriedParsed.conversation.conversation_id,
      parsed.conversation.conversation_id
    );
    assert.equal(
      retriedParsed.conversation.session_id,
      parsed.conversation.session_id,
      "a released Turn must continue the native thread in its authoritative Store Session"
    );
    assert.notEqual(retriedParsed.message.id, parsed.message.id);
    assert.equal(listManagedSessions(storeDir).length, 1);
    assert.equal(listConversations(storeDir).length, 2);
    const releasedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(releasedState.status, "idle");
    assert.equal(
      releasedState.native_session_takeover.terminal_bridge_submission.status,
      "agent_accepted",
      "starting a later Turn must not rewrite the released Turn's acceptance proof"
    );
    const entersAfterRetry = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    assert.equal(entersAfterRetry, 2);
    const historicalCrossStoreArgs = [...args];
    historicalCrossStoreArgs[
      historicalCrossStoreArgs.indexOf("--store-dir") + 1
    ] = path.join(tempDir, "other-conversations");
    const historicalCrossStore = await runAgentCliInProcess(
      historicalCrossStoreArgs,
      testEnv
    );
    assert.notEqual(historicalCrossStore.status, 0);
    assert.match(
      historicalCrossStore.stderr,
      /durable terminal receipt|idempotency key/iu
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      2,
      "an old id hidden by a newer ledger generation cannot cross Store authority"
    );

    const currentLedger = JSON.parse(
      fs.readFileSync(dispatchLedgerPath, "utf8")
    );
    const originalReceipt = currentLedger.terminal_submission_receipts
      .find((receipt) => receipt.message_id === stableMessageId);
    assert.equal(originalReceipt.status, "agent_accepted");
    fs.writeFileSync(
      dispatchLedgerPath,
      `${JSON.stringify({
        ...currentLedger,
        ...originalReceipt,
        status: "resolved",
        resolved_at: new Date().toISOString(),
        reason: "simulated release with missing owner state",
        terminal_submission_receipts:
          currentLedger.terminal_submission_receipts
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
    fs.renameSync(statePath, `${statePath}.orphaned`);
    const orphanedReplay = await runAgentCliInProcess(args, testEnv);
    assert.notEqual(orphanedReplay.status, 0);
    assert.match(
      orphanedReplay.stderr,
      /durable .*receipt|idempotency key/iu
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
        ).length,
      2,
      "a resolved receipt with a missing owner State must fail closed without another Enter"
    );
  } finally {
    if (sending?.child.exitCode === null) {
      fs.writeFileSync(`${tmuxGatePath}.release`, "");
    }
    if (dispatchLedgerPath) {
      fs.rmSync(dispatchLedgerPath, { force: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("default delegate retries route to the original active receipt before idle discovery", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-replay-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-delegate-replay-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const codexPid = 33429;
  const nativeSessionId = "77777777-7777-4777-8777-777777777777";
  const rolloutPath = path.join(tempDir, "codex-delegate-replay.jsonl");
  const stableMessageId = `msg-openclaw-${"7".repeat(64)}`;
  const request = "Run the default delegate request exactly once";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: "2026-08-21T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: nativeSessionId,
          cwd: workspace,
          originator: "codex-tui",
          source: "cli",
          cli_version: "0.148.0"
        }
      })}\n`,
      { mode: 0o600 }
    );
    const rolloutStat = fs.statSync(rolloutPath);
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
      "agent:test:delegate-replay",
      "--openclaw-bin",
      "/usr/bin/true",
      "--codex-active-session-identities-json",
      JSON.stringify({
        [codexPid]: {
          sessionId: nativeSessionId,
          processUuid: "codex-delegate-replay-process",
          processBirth: "codex-delegate-replay-process",
          rollout: {
            fd: "12r",
            device: String(rolloutStat.dev),
            inode: String(rolloutStat.ino),
            path: rolloutPath
          }
        }
      }),
      "--disable-terminal-bridge-monitor"
    ];
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const first = await runAgentCliInProcess(args, testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    assert.equal(firstParsed.delivered, true);
    assert.equal(firstParsed.message.id, stableMessageId);
    const delegateBindingDigest = createHash("sha256")
      .update(stableMessageId)
      .digest("hex");
    const delegateBindingPath = path.join(
      tempDir,
      ".akk-cli-test-runtime",
      "terminal-delegate-send-bindings",
      delegateBindingDigest.slice(0, 2),
      `terminal-delegate-send-binding-${delegateBindingDigest}.json`
    );
    const delegateBinding = JSON.parse(
      fs.readFileSync(delegateBindingPath, "utf8")
    );
    assert.equal(
      delegateBinding.terminal_id,
      `terminal:v2:tmux:codex:${terminalTarget}:${codexPid}`
    );
    assert.equal(typeof delegateBinding.physical_token, "string");
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      1
    );

    fs.writeFileSync(screenPath, "Working on the delegated request\n");
    const replay = await runAgentCliInProcess(args, testEnv);
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    const replayParsed = JSON.parse(replay.stdout);
    assert.equal(replayParsed.replayed, true);
    assert.equal(replayParsed.delivered, false);
    assert.equal(replayParsed.status, "submission_pending_acceptance");
    assert.equal(replayParsed.submission_outcome, "pending_acceptance");
    assert.equal(replayParsed.delivery_receipt, "enter_dispatched");
    assert.equal(replayParsed.do_not_retry, true);
    assert.equal(replayParsed.management_mode, "managed");
    assert.equal(replayParsed.scope, "terminal_user_explicit");
    assert.equal(replayParsed.message_id, stableMessageId);
    assert.equal(replayParsed.session_id, undefined);
    assert.equal(replayParsed.turn_id, undefined);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      1,
      "physical delegate replay must bypass idle selection and send no second Enter"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
