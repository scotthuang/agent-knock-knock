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

test("terminal receipt fingerprints preserve exact whitespace", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-exact-receipt-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-exact-receipt-${process.pid}`;
  const rawConversationId =
    `terminal:tmux:${tmuxSession}:0.1:33389`;

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
      AKK_TEST_TMUX_COMPOSER_AFTER_PASTE: [
        "Ready",
        "› Review:",
        "    alpha",
        "gpt-5.6-sol high · /repo"
      ].join("\n")
    };
    const send = (
      message: string,
      storeDir: string,
      nativeSessionId: string,
      processUuid: string
    ) => runAgentCliInProcess([
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
      ...codexNativeIdentityArgs({
        pid: 33389,
        sessionId: nativeSessionId,
        processUuid,
        rolloutPath: path.join(tempDir, `${processUuid}.jsonl`)
      }),
      "--disable-terminal-bridge-monitor"
    ], testEnv);

    const first = await send(
      "Review:\n  alpha",
      firstStoreDir,
      "55555555-5555-4555-8555-555555555555",
      "codex-exact-receipt-first"
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) =>
        call.kind === "direct_terminal_provider"
      ),
      true,
      "the receipt witness must use the direct terminal port"
    );
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = firstParsed.conversation.state_path;
    const firstState = JSON.parse(
      fs.readFileSync(firstStatePath, "utf8")
    );
    const closedAt = new Date().toISOString();
    fs.writeFileSync(
      firstStatePath,
      `${JSON.stringify({
        ...firstState,
        status: "closed",
        closed_at: closedAt,
        updated_at: closedAt
      }, null, 2)}\n`
    );
    fs.writeFileSync(screenPath, "› \n");

    const second = await send(
      "Review: alpha",
      secondStoreDir,
      "66666666-6666-4666-8666-666666666666",
      "codex-exact-receipt-second"
    );
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.notEqual(JSON.parse(second.stdout).replayed, true);
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

test("a recreated tmux pane does not replay the prior incarnation receipt", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-pane-incarnation-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-pane-incarnation-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const stableMessageId = `msg-openclaw-${"d".repeat(64)}`;
  const firstNativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId: "88888888-8888-4888-8888-888888888888",
    processUuid: "codex-pane-incarnation-first",
    rolloutPath: path.join(tempDir, "codex-pane-incarnation-first.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const send = (
      panePid: number,
      storeDir: string
    ) => runAgentCliInProcess([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:${panePid}`,
      "--message",
      "Run the same request",
      "--message-id",
      stableMessageId,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...firstNativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const first = await send(33389, firstStoreDir);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const closed = await runAgentCliInProcess([
      "close",
      "--turn",
      firstParsed.turn_id,
      "--store-dir",
      firstStoreDir,
      "--reason",
      "release the original pane generation",
      ...firstNativeIdentityArgs
    ], testEnv);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    assert.equal(JSON.parse(closed.stdout).terminal_dispatch_resolved, true);

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t44489\tnode\t${workspace}\n`
    );
    const second = await send(44489, firstStoreDir);
    assert.notEqual(second.status, 0);
    assert.match(
      second.stderr,
      /prior tmux pane incarnation|durable terminal receipt|does not match its original Store, Session, Turn, controller session, or terminal binding/u
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      1,
      "a stable dispatch id must not execute again in a recreated pane"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an identical stable dispatch id cannot replay across Store authority", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-cross-store-replay-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-cross-store-replay-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const stableMessageId = `msg-openclaw-${"e".repeat(64)}`;

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
    const send = (storeDir: string) => runAgentCliInProcess([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "One Store owns this exact dispatch",
      "--message-id",
      stableMessageId,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], testEnv);

    const first = await send(firstStoreDir);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const entersBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    assert.equal(entersBefore, 1);

    const crossStore = await send(secondStoreDir);
    assert.notEqual(crossStore.status, 0);
    assert.match(
      crossStore.stderr,
      /another AKK store|owned by|authority|durable terminal receipt/iu
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
        .length,
      1,
      "cross-Store replay must neither reuse the receipt nor dispatch input"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an orphaned prepared ledger without owner state is safely abandoned", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-orphan-ledger-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-orphan-ledger-${process.pid}`;
  const rawConversationId =
    `terminal:tmux:${tmuxSession}:0.1:33389`;

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
    const send = (
      message: string,
      storeDir: string,
      nativeSessionId: string,
      processUuid: string
    ) => runAgentCliInProcess([
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
      ...codexNativeIdentityArgs({
        pid: 33389,
        sessionId: nativeSessionId,
        processUuid,
        rolloutPath: path.join(tempDir, `${processUuid}.jsonl`)
      }),
      "--disable-terminal-bridge-monitor"
    ], testEnv);

    const first = await send(
      "First task",
      firstStoreDir,
      "11111111-1111-4111-8111-111111111111",
      "codex-orphan-ledger-first"
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const ledgerPath = findTerminalDispatchLedgerPath(
      firstParsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    delete ledger.submitted_at;
    fs.writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        ...ledger,
        status: "prepared",
        dispatcher_pid: 99999999
      }, null, 2)}\n`
    );
    fs.rmSync(firstParsed.conversation.state_path, { force: true });

    const second = await send(
      "Second task",
      secondStoreDir,
      "22222222-2222-4222-8222-222222222222",
      "codex-orphan-ledger-second"
    );
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(JSON.parse(second.stdout).delivered, true);
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

test("stale managed approve and cancel cannot control a newer cross-store generation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-stale-control-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-stale-control-${process.pid}`;
  const rawConversationId =
    `terminal:tmux:${tmuxSession}:0.1:33389`;

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
    const send = (
      message: string,
      storeDir: string,
      nativeSessionId: string,
      processUuid: string
    ) => runAgentCliInProcess([
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
      ...codexNativeIdentityArgs({
        pid: 33389,
        sessionId: nativeSessionId,
        processUuid,
        rolloutPath: path.join(tempDir, `${processUuid}.jsonl`)
      }),
      "--disable-terminal-bridge-monitor"
    ], testEnv);

    const first = await send(
      "First task",
      firstStoreDir,
      "33333333-3333-4333-8333-333333333333",
      "codex-stale-control-first"
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = firstParsed.conversation.state_path;
    const firstState = JSON.parse(
      fs.readFileSync(firstStatePath, "utf8")
    );
    const idleAt = new Date().toISOString();
    fs.writeFileSync(
      firstStatePath,
      `${JSON.stringify({
        ...firstState,
        status: "idle",
        idle_since: idleAt,
        updated_at: idleAt
      }, null, 2)}\n`
    );

    const second = await send(
      "Second task",
      secondStoreDir,
      "44444444-4444-4444-8444-444444444444",
      "codex-stale-control-second"
    );
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const staleAt = new Date().toISOString();
    fs.writeFileSync(
      firstStatePath,
      `${JSON.stringify({
        ...firstState,
        status: "waiting_for_openclaw",
        updated_at: staleAt
      }, null, 2)}\n`
    );
    fs.writeFileSync(screenPath, [
      "Would you like to run the following command?",
      "",
      "› 1. Yes, allow (y)",
      "  2. No (n)"
    ].join("\n"));
    const keysBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys")
      .length;

    const approved = await runAgentCliInProcess([
      "approve",
      "--conversation",
      firstParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir
    ], testEnv);
    assert.notEqual(approved.status, 0);
    assert.match(
      approved.stderr,
      /Session binding generation is no longer current|does not own the current terminal dispatch generation/u
    );

    const cancelled = await runAgentCliInProcess([
      "cancel",
      "--conversation",
      firstParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir
    ], testEnv);
    assert.notEqual(cancelled.status, 0);
    assert.match(
      cancelled.stderr,
      /Session binding generation is no longer current|does not own the current terminal dispatch generation/u
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) => call.args[0] === "send-keys")
        .length,
      keysBefore
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
