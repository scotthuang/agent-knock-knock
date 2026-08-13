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

test("v0.8.1 terminal state without native identity metadata remains bound to its live pane", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-legacy-terminal-binding-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = `akk-legacy-binding-${process.pid}:0.1`;
  const rawConversationId =
    `terminal:v2:tmux:codex:${terminalTarget}:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-legacy-binding-process",
    rolloutPath: path.join(tempDir, "codex-legacy-binding-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${terminalTarget.split(":")[0]}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Legacy managed terminal binding",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const parsed = JSON.parse(sent.stdout);
    const statePath = parsed.conversation.state_path;
    const modernState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const legacyTakeover = { ...modernState.native_session_takeover };
    delete legacyTakeover.terminal_agent_identity_protocol;
    delete legacyTakeover.terminal_agent_session_id;
    delete legacyTakeover.terminal_agent_process_uuid;
    delete legacyTakeover.terminal_agent_process_birth;
    delete legacyTakeover.terminal_agent_rollout;
    delete legacyTakeover.terminal_agent_identity_evidence;
    const {
      session_id: _sessionId,
      turn_id: _turnId,
      ...legacyIdentityState
    } = modernState;
    const idleAt = new Date().toISOString();
    fs.writeFileSync(statePath, `${JSON.stringify({
      ...legacyIdentityState,
      status: "idle",
      idle_since: idleAt,
      updated_at: idleAt,
      native_session_takeover: legacyTakeover
    }, null, 2)}\n`);
    // Recreate the actual predecessor layout: v0.8.1 had neither first-class
    // Session state nor writer protocol 3. Keeping the modern Session beside a
    // stripped legacy Turn would be an impossible mixed-generation Store.
    fs.rmSync(storeSessionsDir(storeDir), { recursive: true, force: true });
    const manifestPath = storeManifestPath(storeDir);
    const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      ...legacyManifest,
      writer_protocol: 2
    }, null, 2)}\n`);
    const ledgerPath = findTerminalDispatchLedgerPath(
      modernState.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      ...ledger,
      status: "resolved",
      resolved_at: idleAt,
      reason: "legacy compatibility fixture"
    }, null, 2)}\n`);

    const listed = runAgentCli([
      "list",
      "--store-dir",
      storeDir,
      "--all",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: terminalTarget,
        session: terminalTarget.split(":")[0],
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: "› \n" }),
      ...nativeIdentityArgs
    ], testEnv);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedParsed = JSON.parse(listed.stdout);
    assert.equal(listedParsed.terminals.length, 1);
    const terminal = listedParsed.terminals[0];
    assert.equal(terminal.managed.session_id, modernState.conversation_id);
    assert.equal(
      terminal.managed.recent_turn.conversation_id,
      modernState.conversation_id
    );
    assert.equal(
      terminal.available_actions.send.arguments.session_id,
      modernState.conversation_id
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raw Claude send fails closed when agent observation fails", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-observer-failure-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "claude-observer-failure:0.0";
  const claudePid = 42377;
  const claudeCallsPath = path.join(tempDir, "claude-agents-called");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-observer-failure\t0\t0\t999\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: claudePid,
      ppid: 999,
      command: "claude",
      cwd: workspace
    }]);
    const fakeClaude = path.join(fakeBinDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(claudeCallsPath)}, "");
process.stderr.write("simulated agents failure\\n");
process.exit(7);
`,
      "utf8"
    );
    fs.chmodSync(fakeClaude, 0o755);
    const sent = runAgentCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:claude:${terminalTarget}:${claudePid}`,
      "--message",
      "This must not reach Claude",
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
    assert.equal(fs.existsSync(claudeCallsPath), true);
    assert.match(sent.stderr, /observation failed|no longer available/u);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys"),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("follow-current sends create distinct successor turns and respond stays on its exact turn", () => {
  const tempDir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "akk-session-turn-send-")
  );
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const codexHome = path.join(tempDir, ".codex");
  const codexSessionsDir = path.join(
    codexHome,
    "sessions",
    "2026",
    "08",
    "13"
  );
  const terminalTarget = `akk-session-turn-${process.pid}:0.1`;
  const codexPid = 33389;
  const rawTerminalId =
    `terminal:v2:tmux:codex:${terminalTarget}:${codexPid}`;
  const nativeSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
  const processBirth = "Thu Aug 13 01:00:00 2026";
  const originalProcessUuid =
    `codex-pid:${codexPid}:birth:${processBirth}`;
  const replacementProcessUuid = `codex-pid:${codexPid}:birth:replacement`;
  const originalRolloutPath = path.join(
    codexSessionsDir,
    `rollout-2026-08-13T01-00-00-${nativeSessionId}.jsonl`
  );

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(codexSessionsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(screenPath, "› \n");
    fs.writeFileSync(originalRolloutPath, `${JSON.stringify({
      timestamp: "2026-08-13T01:00:00.000Z",
      type: "session_meta",
      payload: {
        id: nativeSessionId,
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.147.0"
      }
    })}\n`, { mode: 0o600 });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${terminalTarget.replace(/:\d+$/u, "").replace(/:\d+\.\d+$/u, "")}\t0\t1\t${codexPid}\tnode\t${workspace}\n`
    );
    const rolloutStat = fs.statSync(originalRolloutPath);
    fs.writeFileSync(path.join(fakeBinDir, "ps"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("lstart=")) {
  process.stdout.write(${JSON.stringify(`${processBirth}\n`)});
} else {
  process.stdout.write(${JSON.stringify(
    "  PID  PPID ELAPSED COMMAND\n" +
    `${codexPid} 1 00:01 codex\n`
  )});
}
`, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBinDir, "lsof"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("cwd")) {
  process.stdout.write(${JSON.stringify(
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n" +
    `codex ${codexPid} me cwd DIR 1,18 64 123 ${workspace}\n`
  )});
} else if (args.includes("txt")) {
  process.stdout.write(${JSON.stringify(
    `p${codexPid}\nftxt\nn/opt/akk-test/releases/0.147.0-aarch64-apple-darwin/bin/codex\n`
  )});
} else {
  process.stdout.write(${JSON.stringify(
    `p${codexPid}\nf12r\ntREG\nD${rolloutStat.dev}\n` +
    `i${rolloutStat.ino}\nn${fs.realpathSync(originalRolloutPath)}\n`
  )});
}
`, { mode: 0o755 });
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_CODEX_ACCEPTANCE_ROLLOUT_PATH: originalRolloutPath,
      AKK_TEST_TMUX_COMPOSER_FROM_LITERAL: "1",
      AKK_TEST_TMUX_COMPOSER_AFTER_ENTER: "Working\n"
    };
    const baseCommonArgs = [
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      "--codex-home",
      codexHome
    ];
    const identityArgs = (processUuid: string) => codexNativeIdentityArgs({
      pid: codexPid,
      sessionId: nativeSessionId,
      processUuid,
      rolloutPath: path.join(tempDir, `${processUuid}.jsonl`)
    });
    const commonArgs = [...baseCommonArgs];

    const first = runAgentCli([
      "send",
      "--conversation",
      rawTerminalId,
      "--message",
      "First session turn",
      ...commonArgs
    ], testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    assert.equal(firstParsed.session_id, firstParsed.conversation.session_id);
    assert.equal(firstParsed.turn_id, firstParsed.conversation.turn_id);
    assert.equal(
      firstParsed.conversation.native_session_takeover.terminal_agent_session_id,
      nativeSessionId
    );
    assert.equal(
      firstParsed.conversation.native_session_takeover
        .terminal_agent_identity_protocol,
      1
    );
    assert.equal(
      firstParsed.conversation.native_session_takeover.terminal_agent_process_uuid,
      originalProcessUuid
    );
    assert.equal(
      firstParsed.conversation.native_session_takeover.terminal_agent_process_birth,
      processBirth
    );
    assert.equal(
      firstParsed.conversation.native_session_takeover.terminal_agent_rollout.fd,
      "12r"
    );

    const firstStatePath = firstParsed.conversation.state_path;
    const firstIdle = {
      ...JSON.parse(fs.readFileSync(firstStatePath, "utf8")),
      status: "idle",
      idle_since: new Date().toISOString(),
      callback_delivery: {
        status: "delivered",
        attempts: 1,
        final_status: "idle",
        preserve_conversation_status: true,
        message: {
          id: "msg-first-turn-callback-delivered",
          ts: new Date().toISOString(),
          conversation_id: firstParsed.turn_id,
          session_id: firstParsed.session_id,
          turn_id: firstParsed.turn_id,
          from: "codex",
          to: "openclaw",
          type: "done",
          requires_response: false,
          round: 1,
          max_rounds: 50,
          body: "First session turn completed.",
          metadata: {}
        },
        delivered_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(firstStatePath, `${JSON.stringify(firstIdle, null, 2)}\n`);
    const firstClosed = runAgentCli([
      "close",
      "--state",
      firstStatePath,
      "--store-dir",
      storeDir,
      "--reason",
      "release completed first Turn before follow-current send"
    ], testEnv);
    assert.equal(
      firstClosed.status,
      0,
      firstClosed.stderr || firstClosed.stdout
    );
    assert.equal(
      JSON.parse(firstClosed.stdout).terminal_dispatch_resolved,
      true
    );
    fs.writeFileSync(screenPath, "› \n");

    const keysBeforeWrongType = readJsonLines(tmuxCallsPath).filter(
      (call) => call.args[0] === "send-keys"
    ).length;
    const wrongType = runAgentCli([
      "send",
      "--session",
      firstParsed.session_id,
      "--type",
      "answer",
      "--message",
      "Ordinary send must not continue a Turn",
      ...commonArgs
    ], testEnv);
    assert.notEqual(wrongType.status, 0);
    assert.match(wrongType.stderr, /ordinary send only accepts message type task/u);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter(
        (call) => call.args[0] === "send-keys"
      ).length,
      keysBeforeWrongType
    );

    const listedForSecond = runAgentCli([
      "list",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], testEnv);
    assert.equal(
      listedForSecond.status,
      0,
      listedForSecond.stderr || listedForSecond.stdout
    );
    const secondTerminal = JSON.parse(listedForSecond.stdout).terminals[0];
    const secondAction = secondTerminal.available_actions.send;
    assert.equal(
      typeof secondAction.arguments.expected_terminal_token,
      "string"
    );
    const second = runAgentCli([
      "send",
      "--conversation",
      String(secondAction.arguments.selector),
      "--expected-terminal-token",
      String(secondAction.arguments.expected_terminal_token),
      "--message",
      "Second session turn",
      "--agent-timeout-minutes",
      "7",
      "--agent-hard-timeout-minutes",
      "19",
      ...commonArgs
    ], testEnv);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondParsed = JSON.parse(second.stdout);
    assert.notEqual(secondParsed.session_id, firstParsed.session_id);
    assert.notEqual(secondParsed.turn_id, firstParsed.turn_id);
    assert.notEqual(
      secondParsed.conversation.state_path,
      firstParsed.conversation.state_path
    );
    assert.equal(
      JSON.parse(fs.readFileSync(firstStatePath, "utf8")).status,
      "closed"
    );
    assert.equal(
      fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length,
      2
    );
    const entersBeforeRejectedTurn = readJsonLines(tmuxCallsPath).filter((call) =>
      call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
    ).length;
    const turnTargetRejected = runAgentCli([
      "send",
      "--session",
      firstParsed.turn_id,
      "--message",
      "A turn id must not be a send target",
      ...commonArgs
    ], testEnv);
    assert.notEqual(turnTargetRejected.status, 0);
    assert.match(
      turnTargetRejected.stderr,
      /turn .* is an execution identity, not an ordinary send target/u
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      entersBeforeRejectedTurn
    );

    const secondStatePath = secondParsed.conversation.state_path;
    const waitingForOpenClaw = {
      ...JSON.parse(fs.readFileSync(secondStatePath, "utf8")),
      status: "waiting_for_openclaw",
      callback_delivery: {
        status: "failed",
        attempts: 1,
        final_status: "waiting_for_openclaw",
        preserve_conversation_status: true,
        message: {
          id: "msg-second-turn-question-callback-failed",
          ts: new Date().toISOString(),
          conversation_id: secondParsed.turn_id,
          session_id: secondParsed.session_id,
          turn_id: secondParsed.turn_id,
          from: "codex",
          to: "openclaw",
          type: "question",
          requires_response: true,
          round: 2,
          max_rounds: 50,
          body: "Which release channel should I use?",
          metadata: {}
        }
      },
      updated_at: new Date().toISOString()
    };
    const secondLegStartedAt =
      waitingForOpenClaw.native_session_takeover.terminal_bridge_started_at;
    const respondMessageId = `msg-openclaw-${"c".repeat(64)}`;
    fs.writeFileSync(
      secondStatePath,
      `${JSON.stringify(waitingForOpenClaw, null, 2)}\n`
    );
    fs.writeFileSync(screenPath, "› \n");
    const stateBeforeWrongOpenClawOwner = fs.readFileSync(
      secondStatePath,
      "utf8"
    );
    const logBeforeWrongOpenClawOwner = fs.readFileSync(
      secondParsed.conversation.event_log_path,
      "utf8"
    );
    const entersBeforeWrongOpenClawOwner = readJsonLines(tmuxCallsPath).filter(
      (call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
    ).length;
    const wrongOpenClawOwner = runAgentCli([
      "respond",
      "--turn",
      secondParsed.turn_id,
      "--message",
      "This response belongs to another OpenClaw conversation",
      "--message-id",
      `msg-openclaw-${"d".repeat(64)}`,
      "--openclaw-session",
      "agent:test:other",
      ...commonArgs
    ], testEnv);
    assert.notEqual(wrongOpenClawOwner.status, 0);
    assert.match(
      wrongOpenClawOwner.stderr,
      /belongs to a different OpenClaw session/u
    );
    assert.equal(fs.readFileSync(secondStatePath, "utf8"), stateBeforeWrongOpenClawOwner);
    assert.equal(
      fs.readFileSync(secondParsed.conversation.event_log_path, "utf8"),
      logBeforeWrongOpenClawOwner
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter(
        (call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      entersBeforeWrongOpenClawOwner,
      "an OpenClaw owner mismatch must not dispatch Enter"
    );
    const keysBeforeIdentityChange = readJsonLines(tmuxCallsPath).filter(
      (call) => call.args[0] === "send-keys"
    ).length;
    for (const action of ["approve", "cancel"]) {
      const fenced = runAgentCli([
        action,
        "--turn",
        secondParsed.turn_id,
        ...baseCommonArgs,
        ...identityArgs(replacementProcessUuid)
      ], testEnv);
      assert.notEqual(fenced.status, 0);
      assert.match(
        fenced.stderr,
        /native codex session identity changed|native codex process incarnation cannot be verified/u
      );
      assert.equal(
        readJsonLines(tmuxCallsPath).filter(
          (call) => call.args[0] === "send-keys"
        ).length,
        keysBeforeIdentityChange,
        `${action} must send zero terminal keys after native identity replacement`
      );
    }
    const respondArgs = [
      "respond",
      "--turn",
      secondParsed.turn_id,
      "--message",
      "The requested clarification",
      "--message-id",
      respondMessageId,
      ...commonArgs
    ];
    const responded = runAgentCli(respondArgs, testEnv);
    assert.equal(responded.status, 0, responded.stderr || responded.stdout);
    const respondedParsed = JSON.parse(responded.stdout);
    assert.equal(respondedParsed.session_id, secondParsed.session_id);
    assert.equal(respondedParsed.turn_id, secondParsed.turn_id);
    assert.equal(
      respondedParsed.conversation.state_path,
      secondParsed.conversation.state_path
    );
    assert.equal(respondedParsed.message.type, "answer");
    assert.equal(
      respondedParsed.conversation.native_session_takeover
        .terminal_bridge_inactivity_timeout_minutes,
      7
    );
    assert.equal(
      respondedParsed.conversation.native_session_takeover
        .terminal_bridge_hard_timeout_minutes,
      19
    );
    assert.notEqual(
      respondedParsed.conversation.native_session_takeover
        .terminal_bridge_started_at,
      secondLegStartedAt,
      "respond starts a new response-leg clock while keeping the Turn identity"
    );
    assert.equal(
      fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length,
      2
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      3
    );
    const replayedResponse = runAgentCli(respondArgs, testEnv);
    assert.equal(
      replayedResponse.status,
      0,
      replayedResponse.stderr || replayedResponse.stdout
    );
    const replayedResponseParsed = JSON.parse(replayedResponse.stdout);
    assert.equal(replayedResponseParsed.replayed, true);
    assert.equal(replayedResponseParsed.delivered, true);
    assert.equal(replayedResponseParsed.delivery_receipt, "agent_accepted");
    assert.equal(replayedResponseParsed.message.type, "answer");
    assert.equal(replayedResponseParsed.message.id, respondMessageId);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      3,
      "an idempotent response replay must not dispatch a second Enter"
    );

    const legacySingletonReceiptState = JSON.parse(
      fs.readFileSync(secondStatePath, "utf8")
    );
    delete legacySingletonReceiptState.native_session_takeover
      .terminal_bridge_submission_receipts;
    const waitingForAnotherAnswer = {
      ...legacySingletonReceiptState,
      status: "waiting_for_openclaw",
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(
      secondStatePath,
      `${JSON.stringify(waitingForAnotherAnswer, null, 2)}\n`
    );
    fs.writeFileSync(screenPath, "› \n");
    const secondRespondMessageId = `msg-openclaw-${"f".repeat(64)}`;
    const secondResponse = runAgentCli([
      "respond",
      "--turn",
      secondParsed.turn_id,
      "--message",
      "A later clarification",
      "--message-id",
      secondRespondMessageId,
      ...commonArgs
    ], testEnv);
    assert.equal(
      secondResponse.status,
      0,
      secondResponse.stderr || secondResponse.stdout
    );
    assert.equal(JSON.parse(secondResponse.stdout).message.type, "answer");
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      4
    );

    const oldResponseReplay = runAgentCli(respondArgs, testEnv);
    assert.equal(
      oldResponseReplay.status,
      0,
      oldResponseReplay.stderr || oldResponseReplay.stdout
    );
    const oldResponseReplayParsed = JSON.parse(oldResponseReplay.stdout);
    assert.equal(oldResponseReplayParsed.replayed, true);
    assert.equal(oldResponseReplayParsed.message.id, respondMessageId);
    assert.equal(oldResponseReplayParsed.message.body, "The requested clarification");
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      4,
      "a legacy singleton receipt must remain replayable after a later answer"
    );
    const receiptHistory = JSON.parse(
      fs.readFileSync(secondStatePath, "utf8")
    ).native_session_takeover.terminal_bridge_submission_receipts;
    assert.equal(
      receiptHistory.some((receipt) => receipt.message_id === respondMessageId),
      true
    );
    assert.equal(
      receiptHistory.some((receipt) => receipt.message_id === secondRespondMessageId),
      true
    );

    const incompleteIdentity = JSON.parse(
      fs.readFileSync(secondStatePath, "utf8")
    );
    delete incompleteIdentity.native_session_takeover.terminal_agent_rollout;
    fs.writeFileSync(
      secondStatePath,
      `${JSON.stringify(incompleteIdentity, null, 2)}\n`
    );
    const keysBeforeIncompleteIdentity = readJsonLines(tmuxCallsPath).filter(
      (call) => call.args[0] === "send-keys"
    ).length;
    const incompleteCancel = runAgentCli([
      "cancel",
      "--turn",
      secondParsed.turn_id,
      ...commonArgs
    ], testEnv);
    assert.notEqual(incompleteCancel.status, 0);
    assert.match(
      incompleteCancel.stderr,
      /native Codex session identity changed|rollout incarnation cannot be verified/iu
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter(
        (call) => call.args[0] === "send-keys"
      ).length,
      keysBeforeIncompleteIdentity,
      "an incomplete Codex rollout tuple must authorize zero terminal keys"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("virgin terminal send is uncertain when no exact native session can be bound", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-native-bind-timeout-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const fakeBinDir = path.join(tempDir, "bin");
  const target = "codex-virgin:0.0";
  const pid = 33401;
  const rawTerminalId = `terminal:v2:tmux:codex:${target}:${pid}`;
  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeProcessTools(fakeBinDir, [{
      pid,
      ppid: 1,
      command: "codex",
      cwd: workspace
    }]);
    const startedAt = Date.now();
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawTerminalId,
      "--message",
      "Start the first native session",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      JSON.stringify([{ pid, ppid: 1, command: "codex", cwd: workspace }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target,
        session: "codex-virgin",
        window: 0,
        pane: 0,
        panePid: pid,
        currentCommand: "codex",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({ [target]: "› \n" }),
      "--codex-active-session-identities-json",
      "{}"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const parsed = JSON.parse(sent.stdout);
    assert.equal(parsed.delivered, false);
    assert.equal(parsed.status, "submission_uncertain");
    assert.equal(parsed.do_not_retry, true);
    assert.equal(parsed.conversation.status, "stalled");
    assert.equal(
      parsed.conversation.native_session_takeover.terminal_agent_identity_status,
      "unresolved_after_submit"
    );
    assert.equal(
      parsed.conversation.native_session_takeover.terminal_bridge_submission.status,
      "uncertain"
    );
    assert.ok(
      elapsedMs >= 1_800,
      `native identity binding window ended too early (${elapsedMs}ms)`
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal transport never becomes delivered without native acceptance evidence", async (t) => {
  for (const fixture of [
    {
      outcome: "pending",
      status: "submission_pending_acceptance",
      submission: "enter_dispatched",
      conversationStatus: "waiting_for_agent"
    },
    {
      outcome: "not_accepted",
      status: "submission_not_accepted",
      submission: "not_accepted",
      conversationStatus: "stalled"
    },
    {
      outcome: "identity_drift",
      status: "submission_uncertain",
      submission: "uncertain",
      conversationStatus: "stalled"
    }
  ] as const) {
    await t.test(fixture.outcome, () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `akk-terminal-acceptance-${fixture.outcome}-`)
      );
      const storeDir = path.join(tempDir, "conversations");
      const workspace = path.join(tempDir, "workspace");
      const target = `acceptance-${fixture.outcome}:0.0`;
      const pid = 43389;
      const rawConversationId =
        `terminal:v2:tmux:codex:${target}:${pid}`;
      try {
        fs.mkdirSync(workspace, { recursive: true });
        const result = runAgentCli([
          "send",
          "--conversation",
          rawConversationId,
          "--message",
          "Verify terminal acceptance",
          "--background",
          "--store-dir",
          storeDir,
          "--disable-terminal-bridge-monitor",
          "--terminal-acceptance-timeout-ms",
          "20",
          "--processes-json",
          JSON.stringify([{ pid, ppid: 1, command: "codex", cwd: workspace }]),
          "--terminals-json",
          JSON.stringify([{
            kind: "tmux",
            target,
            session: `acceptance-${fixture.outcome}`,
            window: 0,
            pane: 0,
            panePid: pid,
            currentCommand: "codex",
            currentPath: workspace
          }]),
          "--terminal-screens-json",
          JSON.stringify({ [target]: "› \n" }),
          ...codexNativeIdentityArgs({
            pid,
            sessionId,
            processUuid: `codex-${fixture.outcome}-process`,
            rolloutPath: path.join(tempDir, `rollout-${fixture.outcome}.jsonl`)
          })
        ], {
          AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: fixture.outcome
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.delivered, false);
        assert.equal(parsed.status, fixture.status);
        assert.equal(parsed.do_not_retry, true);
        assert.equal(parsed.conversation.status, fixture.conversationStatus);
        assert.equal(
          parsed.conversation.native_session_takeover
            .terminal_bridge_submission.status,
          fixture.submission
        );
        assert.equal(
          parsed.conversation.native_session_takeover
            .terminal_bridge_submission.last_proven_stage,
          "enter_dispatched"
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});

test("monitor keeps a durable late native ACK when later bookkeeping fails", async (t) => {
  for (const fixture of [
    {
      name: "ledger",
      env: { AKK_TEST_MONITOR_FINAL_TERMINAL_LEDGER_FAILURE: "1" },
      expectedLedgerStatus: "agent_accepted"
    },
    {
      name: "event",
      env: { AKK_TEST_MONITOR_FINAL_EVENT_FAILURE: "1" },
      expectedLedgerStatus: "agent_accepted"
    }
  ] as const) {
    await t.test(fixture.name, () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `akk-monitor-ack-${fixture.name}-`)
      );
      const storeDir = path.join(tempDir, "conversations");
      const fakeBinDir = path.join(tempDir, "bin");
      const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
      const screenPath = path.join(tempDir, "screen.txt");
      const workspace = path.join(tempDir, "workspace");
      const tmuxSession = `akk-monitor-ack-${fixture.name}-${process.pid}`;
      const target = `${tmuxSession}:0.1`;
      const pid = fixture.name === "ledger" ? 43392 : 43393;
      const request = `Late ACK ${fixture.name}`;
      const nativeIdentityArgs = codexNativeIdentityArgs({
        pid,
        sessionId,
        processUuid: `codex-monitor-ack-${fixture.name}`,
        rolloutPath: path.join(tempDir, `rollout-${fixture.name}.jsonl`)
      });
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
        const testEnv = {
          PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
        };
        const sent = runAgentCli([
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
          "--terminal-acceptance-timeout-ms",
          "20",
          ...nativeIdentityArgs,
          "--disable-terminal-bridge-monitor"
        ], {
          ...testEnv,
          AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "pending"
        });
        assert.equal(sent.status, 0, sent.stderr || sent.stdout);
        const sentParsed = JSON.parse(sent.stdout);
        assert.equal(sentParsed.submission_outcome, "pending_acceptance");
        const statePath = sentParsed.conversation.state_path;
        const logPath = sentParsed.conversation.event_log_path;
        const ledgerPath = findTerminalDispatchLedgerPath(
          sentParsed.conversation.conversation_id,
          path.join(tempDir, ".akk-cli-test-runtime")
        );

        const monitored = runAgentCli([
          "monitor",
          "--terminal-bridge",
          "--state",
          statePath,
          "--log",
          logPath,
          "--store-dir",
          storeDir,
          "--poll-interval-ms",
          "50",
          "--agent-timeout-minutes",
          "60",
          "--agent-hard-timeout-minutes",
          "0.001",
          "--terminal-screens-json",
          JSON.stringify({ [target]: "Codex is working\n" }),
          ...nativeIdentityArgs
        ], {
          ...testEnv,
          ...fixture.env
        });
        assert.equal(
          monitored.status,
          0,
          monitored.stderr || monitored.stdout
        );
        const monitoredParsed = JSON.parse(monitored.stdout);
        assert.notEqual(monitoredParsed.submission_outcome, "uncertain");
        assert.equal(monitoredParsed.hard_timeout, true);
        const durableState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(
          durableState.native_session_takeover
            .terminal_bridge_submission.status,
          "agent_accepted"
        );
        assert.equal(
          durableState.native_session_takeover
            .terminal_bridge_submission.acceptance_evidence.source,
          "codex_rollout"
        );
        assert.equal(
          JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
          fixture.expectedLedgerStatus
        );
        assert.equal(
          readJsonLines(tmuxCallsPath).filter((call) =>
            call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
          ).length,
          1,
          "late-ACK bookkeeping recovery must never dispatch another Enter"
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});

test("static terminal fixtures cannot synthesize native acceptance without explicit opt-in", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-no-implicit-acceptance-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const rolloutPath = path.join(tempDir, "rollout.jsonl");
  const target = `no-implicit-acceptance-${process.pid}:0.0`;
  const pid = 43390;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`,
      { mode: 0o600 }
    );
    const rolloutStat = fs.statSync(rolloutPath);
    const result = spawnSync(process.execPath, [binPath,
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${target}:${pid}`,
      "--message",
      "Static fixtures prove transport only",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      "--terminal-acceptance-timeout-ms",
      "20",
      "--processes-json",
      JSON.stringify([{ pid, ppid: 1, command: "codex", cwd: workspace }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target,
        session: "no-implicit-acceptance",
        window: 0,
        pane: 0,
        panePid: pid,
        currentCommand: "codex",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({ [target]: "› \n" }),
      "--codex-active-session-identities-json",
      JSON.stringify({
        [pid]: {
          sessionId,
          processUuid: "codex-no-implicit-acceptance",
          processBirth: "codex-no-implicit-acceptance",
          rollout: {
            fd: "12r",
            device: String(rolloutStat.dev),
            inode: String(rolloutStat.ino),
            path: rolloutPath
          }
        }
      })
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AKK_RUNTIME_DIR: path.join(tempDir, "runtime"),
        AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.delivered, false);
    assert.equal(parsed.status, "submission_pending_acceptance");
    assert.equal(parsed.delivery_receipt, "enter_dispatched");
    assert.equal(parsed.do_not_retry, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
