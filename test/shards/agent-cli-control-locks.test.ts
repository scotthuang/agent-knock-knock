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
import { terminalBindingFrom } from "../../src/managed-session.js";
import type { TerminalControlRef } from "../../src/terminal-agent-adapter.js";
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

test("managed terminal send cannot overwrite a concurrent terminal cancellation", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-send-cancel-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxSession = `akk-send-cancel-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const terminalKey = createHash("sha256")
    .update(JSON.stringify({
      target: terminalTarget,
      socket_path: null
    }))
    .digest("hex")
    .slice(0, 20);
  const terminalLockPath = path.join(
    tempDir,
    ".akk-cli-test-runtime",
    "terminal-locks",
    `terminal-bridge-send-${terminalKey}.lock`
  );
  const racedMessage = "This prepared message must never reach tmux";
  const codexIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId: "019ee559-7bb8-7fd1-970c-0f7b6978c450",
    processUuid: "codex-send-cancel-process",
    rolloutPath: path.join(tempDir, "codex-send-cancel-rollout.jsonl")
  });
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sendingStopped = false;

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
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_SUBPROCESS_EVIDENCE_TEST_NAME: t.name
    };
    const managed = await runAgentCliInProcess([
      "send",
      "--conversation",
      rawConversationId,
      "--managed-only",
      "--message",
      "Initial managed terminal task",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...codexIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(managed.status, 0, managed.stderr || managed.stdout);
    const managedParsed = JSON.parse(managed.stdout);
    const turnId = managedParsed.conversation.turn_id;
    const statePath = managedParsed.conversation.state_path;
    const waitingState = {
      ...JSON.parse(fs.readFileSync(statePath, "utf8")),
      status: "waiting_for_openclaw",
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(waitingState, null, 2)}\n`);
    const initialRounds = waitingState.response_rounds_used;
    const initialStateRaw = fs.readFileSync(statePath, "utf8");
    fs.writeFileSync(tmuxCallsPath, "");

    fs.mkdirSync(path.dirname(terminalLockPath), { recursive: true });
    fs.writeFileSync(
      terminalLockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "send-cancel-race-owner",
        created_at: new Date().toISOString()
      })}\n`,
      { mode: 0o600 }
    );

    let cancelSettled = false;
    const cancelling = runAgentCliAsync([
      "cancel",
      "--turn",
      turnId,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs
    ], testEnv).finally(() => {
      cancelSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(cancelSettled, false, "cancel must wait behind the gated terminal owner");

    sending = spawnAgentCliCaptured([
      "respond",
      "--turn",
      turnId,
      "--message",
      racedMessage,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      sending.child.exitCode,
      null,
      "managed send must wait behind the current terminal owner"
    );
    assert.equal(
      fs.readFileSync(statePath, "utf8"),
      initialStateRaw,
      "a send waiting for the terminal lock must not prepare or persist its message"
    );
    assert.ok(sending.child.pid);
    process.kill(sending.child.pid, "SIGSTOP");
    sendingStopped = true;
    fs.rmSync(terminalLockPath, { force: true });
    const cancelled = await cancelling;
    assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    const cancelledParsed = JSON.parse(cancelled.stdout);
    assert.equal(cancelledParsed.cancel_requested, true);
    assert.equal(cancelledParsed.conversation.status, "cancelled");
    assert.equal(cancelledParsed.key, "C-c");

    process.kill(sending.child.pid, "SIGCONT");
    sendingStopped = false;
    const sendResult = await sending.result;
    assert.notEqual(sendResult.status, 0);
    assert.match(sendResult.stderr, /turn is cancelled|conversation is cancelled/u);

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "cancelled");
    assert.equal(finalState.response_rounds_used, initialRounds);
    assert.equal(finalState.cancelled_at, cancelledParsed.conversation.cancelled_at);
    assert.equal(finalState.updated_at, cancelledParsed.conversation.updated_at);
    const calls = readJsonLines(tmuxCallsPath);
    assert.equal(
      calls.some((call) =>
        call.args[0] === "send-keys" &&
        call.args.includes("-l") &&
        call.args.at(-1) === racedMessage
      ),
      false,
      "a stale prepared send must not write its message to tmux"
    );
    assert.equal(
      calls.filter((call) =>
        call.args[0] === "send-keys" &&
        call.args[1] === "-t" &&
        call.args[2] === terminalTarget &&
        call.args.at(-1) === "C-c"
      ).length,
      1,
      "the concurrent cancellation should be the only control action after the gate"
    );
  } finally {
    fs.rmSync(terminalLockPath, { force: true });
    if (sendingStopped && sending?.child.pid) {
      try {
        process.kill(sending.child.pid, "SIGCONT");
      } catch {
        // The send process already exited.
      }
    }
    killPidBestEffort(sending?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed Close uses the Store writer rather than the terminal lock and prevents queued sends or approvals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-close-terminal-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxSession = `akk-close-race-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const terminalLockDir = path.join(
    tempDir,
    ".akk-cli-test-runtime",
    "terminal-locks"
  );
  const writerLockPath = path.join(storeDir, ".akk-writer.lock");
  const racedMessage = "This message must never be sent after close";
  const codexIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId: "019ee559-7bb8-7fd1-970c-0f7b6978c451",
    processUuid: "codex-close-race-process",
    rolloutPath: path.join(tempDir, "codex-close-race-rollout.jsonl")
  });
  let closing: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sendingStopped = false;
  let stateLockHeld = false;
  let stateLockPath = "";

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
    const managed = await runAgentCliInProcess([
      "send",
      "--conversation",
      rawConversationId,
      "--managed-only",
      "--message",
      "Initial managed terminal task",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...codexIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(managed.status, 0, managed.stderr || managed.stdout);
    const managedParsed = JSON.parse(managed.stdout);
    const turnId = managedParsed.conversation.turn_id;
    const statePath = managedParsed.conversation.state_path;
    const waitingState = {
      ...JSON.parse(fs.readFileSync(statePath, "utf8")),
      status: "waiting_for_openclaw",
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(waitingState, null, 2)}\n`);
    stateLockPath = `${statePath}.lock`;
    fs.writeFileSync(tmuxCallsPath, "");

    fs.writeFileSync(
      stateLockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "close-race-owner",
        created_at: new Date().toISOString()
      })}\n`,
      { mode: 0o600 }
    );
    stateLockHeld = true;

    closing = spawnAgentCliCaptured([
      "close",
      "--turn",
      turnId,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs,
      "--reason",
      "closed during terminal mutation race"
    ], testEnv);
    await waitForCondition(() => {
      if (!fs.existsSync(writerLockPath)) {
        return false;
      }
      const owner = JSON.parse(fs.readFileSync(writerLockPath, "utf8"));
      return owner.pid === closing?.child.pid;
    }, "Close to acquire the Store writer before waiting for state");
    assert.equal(closing.child.exitCode, null);
    const closeOwnedTerminalLocks = fs.existsSync(terminalLockDir)
      ? fs.readdirSync(terminalLockDir)
          .filter((name) =>
            name.startsWith("terminal-bridge-send-") &&
            name.endsWith(".lock")
          )
          .filter((name) => {
            const owner = JSON.parse(
              fs.readFileSync(path.join(terminalLockDir, name), "utf8")
            );
            return owner.pid === closing?.child.pid;
          })
      : [];
    assert.deepEqual(
      closeOwnedTerminalLocks,
      [],
      "management-only Close must not acquire the terminal input lock"
    );

    sending = spawnAgentCliCaptured([
      "respond",
      "--turn",
      turnId,
      "--message",
      racedMessage,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sending.child.exitCode, null);
    assert.ok(sending.child.pid);
    process.kill(sending.child.pid, "SIGSTOP");
    sendingStopped = true;

    const concurrentState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    concurrentState.close_race_marker =
      "state written while Close held the Store writer";
    concurrentState.updated_at = new Date().toISOString();
    fs.writeFileSync(statePath, `${JSON.stringify(concurrentState, null, 2)}\n`);
    fs.unlinkSync(stateLockPath);
    stateLockHeld = false;

    const closeResult = await closing.result;
    assert.equal(closeResult.status, 0, closeResult.stderr || closeResult.stdout);
    const closeParsed = JSON.parse(closeResult.stdout);
    assert.equal(closeParsed.closed, true);
    assert.equal(closeParsed.management_released, true);
    assert.equal(closeParsed.terminal_input_sent, false);
    assert.equal(closeParsed.conversation.status, "closed");
    assert.equal(
      closeParsed.conversation.close_race_marker,
      "state written while Close held the Store writer",
      "close must reload state after acquiring the state lock"
    );

    process.kill(sending.child.pid, "SIGCONT");
    sendingStopped = false;
    const sendResult = await sending.result;
    assert.notEqual(sendResult.status, 0);
    assert.match(sendResult.stderr, /turn is closed|conversation is closed/u);

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "closed");
    assert.equal(finalState.close_reason, "closed during terminal mutation race");
    assert.equal(
      finalState.close_race_marker,
      "state written while Close held the Store writer"
    );
    const sendKeyCalls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.equal(
      sendKeyCalls.some((call) => call.args.includes("-l") && call.args.at(-1) === racedMessage),
      false,
      "a send queued behind close must not write its payload to tmux"
    );

    const approval = await runAgentCliInProcess([
      "approve",
      "--turn",
      turnId,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs
    ], testEnv);
    assert.notEqual(approval.status, 0);
    assert.match(approval.stderr, /conversation is closed/u);
    const afterApprovalCalls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(
      afterApprovalCalls,
      sendKeyCalls,
      "approval after close must not send any terminal keys"
    );
  } finally {
    if (stateLockHeld && stateLockPath) {
      fs.rmSync(stateLockPath, { force: true });
    }
    if (sendingStopped && sending?.child.pid) {
      try {
        process.kill(sending.child.pid, "SIGCONT");
      } catch {
        // The send process already exited.
      }
    }
    killPidBestEffort(closing?.child.pid);
    killPidBestEffort(sending?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("idle cleanup locks and reloads a stale candidate before closing it", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-idle-cleanup-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const fakeBinDir = path.join(tempDir, "bin");
  const preloadPath = path.join(tempDir, "state-read-gate.cjs");
  const snapshotReadPath = path.join(tempDir, "snapshot-read");
  const snapshotReleasePath = path.join(tempDir, "snapshot-release");
  const lockAttemptPath = path.join(tempDir, "state-lock-attempted");
  let listing: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let stateLockHeld = false;
  let stateLockPath = "";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeProcessTools(fakeBinDir, [{
      pid: 33389,
      ppid: 999,
      command: "codex",
      cwd: workspace
    }]);
    const created = await runAgentCliInProcess([
      "send",
      "--conversation",
      "terminal:v2:tmux:codex:codex-work:0.0:33389",
      "--message",
      "idle cleanup race",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:main",
      "--openclaw-session",
      "agent:test:main",
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.0",
        panePid: 999,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": "› "
      })
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const parsed = JSON.parse(created.stdout);
    const statePath = parsed.conversation.state_path;
    const eventLogPath = parsed.conversation.event_log_path;
    stateLockPath = `${statePath}.lock`;
    const staleState = {
      ...JSON.parse(fs.readFileSync(statePath, "utf8")),
      status: "idle",
      idle_since: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    };
    fs.writeFileSync(statePath, `${JSON.stringify(staleState, null, 2)}\n`);
    fs.writeFileSync(
      stateLockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "idle-cleanup-race-owner",
        created_at: new Date().toISOString()
      })}\n`,
      { mode: 0o600 }
    );
    stateLockHeld = true;
    fs.writeFileSync(
      preloadPath,
      `const fs = require("node:fs");
const path = require("node:path");
const target = path.resolve(process.env.AKK_TEST_STATE_READ_TARGET);
const targetLock = target + ".lock";
const snapshotReadPath = process.env.AKK_TEST_STATE_SNAPSHOT_READ_PATH;
const snapshotReleasePath = process.env.AKK_TEST_STATE_SNAPSHOT_RELEASE_PATH;
const lockAttemptPath = process.env.AKK_TEST_STATE_LOCK_ATTEMPT_PATH;
const originalOpenSync = fs.openSync;
const originalReadFileSync = fs.readFileSync;
const originalCloseSync = fs.closeSync;
const trackedStateFds = new Set();
let snapshotCaptured = false;
let lockAttemptReported = false;
fs.openSync = function(file, ...args) {
  const resolved = typeof file === "string" ? path.resolve(file) : "";
  if (resolved === targetLock && !lockAttemptReported) {
    lockAttemptReported = true;
    fs.writeFileSync(lockAttemptPath, "");
  }
  const fd = originalOpenSync.call(this, file, ...args);
  if (resolved === target) {
    trackedStateFds.add(fd);
  }
  return fd;
};
fs.readFileSync = function(file, ...args) {
  const value = originalReadFileSync.call(this, file, ...args);
  const idleCleanupRead = new Error().stack?.includes("reconcileIdleConversations") === true;
  if (
    !snapshotCaptured &&
    idleCleanupRead &&
    typeof file === "number" &&
    trackedStateFds.has(file)
  ) {
    snapshotCaptured = true;
    fs.writeFileSync(snapshotReadPath, "");
    while (!fs.existsSync(snapshotReleasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return value;
};
fs.closeSync = function(fd, ...args) {
  trackedStateFds.delete(fd);
  return originalCloseSync.call(this, fd, ...args);
};
`,
      "utf8"
    );

    let settled = false;
    listing = spawnAgentCliCaptured([
      "list",
      "--reconcile",
      "--store-dir",
      storeDir,
      "--idle-timeout-minutes",
      "1",
      "--managed-only",
      "--all"
    ], {
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--require=${preloadPath}`
      ].filter(Boolean).join(" "),
      AKK_TEST_STATE_READ_TARGET: statePath,
      AKK_TEST_STATE_SNAPSHOT_READ_PATH: snapshotReadPath,
      AKK_TEST_STATE_SNAPSHOT_RELEASE_PATH: snapshotReleasePath,
      AKK_TEST_STATE_LOCK_ATTEMPT_PATH: lockAttemptPath
    });
    void listing.result.finally(() => {
      settled = true;
    });
    await waitForCondition(
      () => fs.existsSync(snapshotReadPath),
      "idle cleanup to capture its stale candidate snapshot"
    );

    const activeState = {
      ...staleState,
      status: "waiting_for_agent",
      cleanup_race_marker: "became active while cleanup held a stale snapshot",
      updated_at: new Date().toISOString()
    };
    delete activeState.idle_since;
    fs.writeFileSync(statePath, `${JSON.stringify(activeState, null, 2)}\n`);
    fs.writeFileSync(snapshotReleasePath, "");
    await waitForCondition(
      () => fs.existsSync(lockAttemptPath),
      "idle cleanup to attempt the candidate state lock"
    );
    assert.equal(
      settled,
      false,
      "cleanup must wait for the candidate state lock before acting on its snapshot"
    );

    fs.unlinkSync(stateLockPath);
    stateLockHeld = false;
    const result = await listing.result;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const listed = JSON.parse(result.stdout);
    assert.equal(listed.reconciliation.closed, 0);
    assert.equal(listed.unavailable_managed_turns.length, 1);
    assert.equal(
      listed.unavailable_managed_turns[0].status,
      "waiting_for_agent"
    );

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "waiting_for_agent");
    assert.equal(
      finalState.cleanup_race_marker,
      "became active while cleanup held a stale snapshot"
    );
    assert.equal(finalState.closed_at, undefined);
    assert.doesNotMatch(
      fs.readFileSync(eventLogPath, "utf8"),
      /"event":"conversation_closed"/u
    );
  } finally {
    fs.writeFileSync(snapshotReleasePath, "");
    if (stateLockHeld && stateLockPath) {
      fs.rmSync(stateLockPath, { force: true });
    }
    killPidBestEffort(listing?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("approve sends y only when the terminal screen shows a primary Codex approval option", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-approve-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const approvalScreen = [
      "  ARK_API_KEY=ark-test-secret-value",
      "",
      "  Would you like to run the following command?",
      "",
      "  $ curl -I https://example.com",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel"
    ].join("\n");
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: 1234,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd: workspace
    }]);

    const rawConversationId =
      "terminal:v2:tmux:codex:codex-work:0.0:1234";
    const terminalControl = tmuxPane({
      panePid: 999,
      currentPath: workspace,
      capabilities: [
        "screen_status",
        "send_keys",
        "terminal_approval",
        "screen_completion",
        "durable_completion",
        "terminal_cancel"
      ]
    }) as TerminalControlRef;
    ensureStoreWritable(storeDir);
    const now = new Date().toISOString();
    saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: "session-ownerless-manual-approval",
      agent: "codex",
      workspace,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId: rawConversationId,
        terminalControl,
        pid: 1234,
        nativeThreadId: sessionId,
        processUuid: "codex-pid:1234:birth:Thu Aug  6 10:00:00 2026",
        processBirth: "Thu Aug  6 10:00:00 2026",
        evidence: "codex_status_card",
        generation: 1
      }),
      lineage: { created_by: "attach" },
      created_at: now,
      updated_at: now
    }, { expectedRevision: null });
    fs.writeFileSync(screenPath, approvalScreen);

    const listed = await runAgentCliInProcess([
      "list",
      "--store-dir",
      storeDir,
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--processes-json",
      JSON.stringify([{
        pid: 1234,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({ panePid: 999, currentPath: workspace })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.0": approvalScreen })
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedTerminal = JSON.parse(listed.stdout).terminals[0];
    const approvalAction = listedTerminal.available_actions.approve;
    assert.ok(approvalAction, listed.stdout);
    assert.equal(approvalAction.authority, "managed_session_no_dispatch_owner");
    assert.deepEqual(approvalAction.arguments, {
      conversation_id: rawConversationId,
      expected_terminal_token:
        approvalAction.arguments.expected_terminal_token
    });
    assert.equal(
      typeof approvalAction.arguments.expected_terminal_token,
      "string"
    );

    const rawStatus = await runAgentCliInProcess([
      "status",
      "--conversation",
      rawConversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(rawStatus.status, 0, rawStatus.stderr || rawStatus.stdout);
    const rawStatusParsed = JSON.parse(rawStatus.stdout);
    assert.match(rawStatusParsed.terminal_screen.excerpt, /Would you like to run the following command/);
    assert.match(rawStatusParsed.terminal_screen.excerpt, /ARK_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(rawStatusParsed.terminal_screen.excerpt, /ark-test-secret-value/);
    assert.equal(rawStatusParsed.terminal_screen.approval.approvable, true);
    assert.equal(rawStatusParsed.terminal_status.reachable, true);
    assert.equal(rawStatusParsed.terminal_status.target, "codex-work:0.0");
    assert.equal(rawStatusParsed.terminal_status.activity_state, "awaiting_approval");
    assert.equal(rawStatusParsed.terminal_status.approval_state.blocked, true);
    assert.equal(rawStatusParsed.terminal_status.approval_state.approvable, true);
    const sessionsBeforeApproval = listManagedSessions(storeDir);
    const turnsBeforeApproval = listConversations(storeDir);
    assert.equal(sessionsBeforeApproval.length, 1);
    assert.equal(
      sessionsBeforeApproval[0].session_id,
      "session-ownerless-manual-approval"
    );
    assert.deepEqual(turnsBeforeApproval, []);
    const sessionStatePath = pathsForManagedSession(
      "session-ownerless-manual-approval",
      storeDir
    ).statePath;
    const sessionStateBeforeApproval = fs.readFileSync(sessionStatePath, "utf8");
    const approvalKeysBefore = readJsonLines(tmuxCallsPath).filter((call) =>
      call.args[0] === "send-keys" && call.args.at(-1) === "y"
    ).length;
    const approved = await runAgentCliInProcess([
      "approve",
      "--conversation",
      String(approvalAction.arguments.conversation_id),
      "--expected-terminal-token",
      String(approvalAction.arguments.expected_terminal_token),
      "--expected-approval-fingerprint",
      rawStatusParsed.terminal_status.approval_state.fingerprint,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.conversation_id, rawConversationId);
    assert.equal(approvedParsed.key, "y");
    const calls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.0", "y"]);
    assert.equal(
      calls.filter((call) => call.args.at(-1) === "y").length,
      approvalKeysBefore + 1
    );
    assert.deepEqual(listManagedSessions(storeDir), sessionsBeforeApproval);
    assert.deepEqual(listConversations(storeDir), turnsBeforeApproval);
    assert.equal(
      fs.readFileSync(sessionStatePath, "utf8"),
      sessionStateBeforeApproval
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("approval scan ignores stale Codex prompts left in terminal scrollback", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-stale-approve-"));
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
      "  $ git status -sb",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "",
      "✔ You approved codex to run git status -sb",
      "• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
      "",
      "› Find and fix a bug in @filename"
    ].join("\n"));
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const conversationId = "terminal:v2:tmux:codex:codex-work:0.1:33389";
    const status = await runAgentCliInProcess([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);
    assert.equal(statusParsed.terminal_status.approval_state.approvable, false);
    assert.match(statusParsed.terminal_status.approval_state.reason, /stale/);
    assert.equal(statusParsed.terminal_screen.approval.approvable, false);
    assert.equal(statusParsed.terminal_status.activity_state, "working");

    const approved = await runAgentCliInProcess([
      "approve",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, false);
    assert.match(approvedParsed.reason, /stale/);
    assert.deepEqual(readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys"), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status detects tmux Codex working idle and unknown activity states", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-activity-state-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const codexHome = path.join(tempDir, "empty-codex-home");
  const conversationId = "terminal:tmux:codex-work:0.1:33389";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    fs.writeFileSync(screenPath, [
      "• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
      "",
      "› Find and fix a bug in @filename"
    ].join("\n"));
    let status = await runAgentCliInProcess([
      "status",
      "--conversation",
      conversationId,
      "--codex-home",
      codexHome
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    let statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "working");
    assert.match(statusParsed.terminal_status.activity_reason, /Working/);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);
    assert.equal(statusParsed.confidence, "low");
    assert.match(
      statusParsed.limitations[0],
      /historical session context is unavailable/iu
    );

    fs.writeFileSync(screenPath, [
      "• Waiting for background terminal · autoreview",
      "  3 background terminals running · /ps to view · /stop to close",
      "",
      "› Steer the current task"
    ].join("\n"));
    status = await runAgentCliInProcess([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "working");
    assert.match(statusParsed.terminal_status.activity_reason, /Waiting for background terminal/);

    fs.writeFileSync(screenPath, [
      "The words background terminal running are part of the final answer.",
      "Working is also ordinary prose here, without a Codex status-line shape.",
      "",
      "› "
    ].join("\n"));
    status = await runAgentCliInProcess([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "idle");

    fs.writeFileSync(screenPath, [
      "  Model: GPT-5",
      "",
      "› "
    ].join("\n"));
    status = await runAgentCliInProcess([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "idle");
    assert.match(statusParsed.terminal_status.activity_reason, /input prompt/);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);

    fs.writeFileSync(screenPath, [
      "last command output",
      "no recognizable Codex tui footer"
    ].join("\n"));
    status = await runAgentCliInProcess([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "unknown");
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
