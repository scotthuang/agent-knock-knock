import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  managedSessionBindingToken,
  terminalBindingFrom
} from "../src/managed-session.js";
import {
  listManagedSessions,
  loadNativeThreadTransition,
  pathsForManagedSession,
  saveManagedSession
} from "../src/session-store.js";
import { ensureStoreWritable, listConversations } from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

test("Codex new-thread does not attach a sticky before-thread rollout to the new Session", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-codex-sticky-rollout-")
  );
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime");
  const codexHome = path.join(tempDir, ".codex");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "08", "06");
  const screenPath = path.join(tempDir, "screen.txt");
  const statusCountPath = path.join(tempDir, "status-count.txt");
  const clearCountPath = path.join(tempDir, "clear-count.txt");
  const wrongNextStatusPath = path.join(tempDir, "wrong-next-status");
  const draftAfterNextStatusPath = path.join(
    tempDir,
    "draft-after-next-status"
  );
  const blankRowsAfterNextStatusPath = path.join(
    tempDir,
    "blank-rows-after-next-status"
  );
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const target = "tmux-sticky-rollout:0.0";
  const panePid = 73_000;
  const codexPid = 73_001;
  const processBirth = "Thu Aug  6 11:00:00 2026";
  const beforeNativeThreadId = "11111111-1111-4111-8111-111111111111";
  const afterNativeThreadId = "22222222-2222-4222-8222-222222222222";
  const unexpectedNativeThreadId = "33333333-3333-4333-8333-333333333333";
  const thirdNativeThreadId = "44444444-4444-4444-8444-444444444444";
  const unknownNativeThreadId = "55555555-5555-4555-8555-555555555555";
  const terminalId = `terminal:v2:tmux:codex:${target}:${codexPid}`;
  const executablePath =
    "/opt/akk-test/releases/0.146.0-aarch64-apple-darwin/bin/codex";
  const beforeRolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-00-00-${beforeNativeThreadId}.jsonl`
  );
  const afterRolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-01-00-${afterNativeThreadId}.jsonl`
  );
  const afterRolloutMaterializedPath = path.join(
    tempDir,
    "after-rollout-materialized"
  );
  const thirdRolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-02-00-${thirdNativeThreadId}.jsonl`
  );
  const unknownRolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-03-00-${unknownNativeThreadId}.jsonl`
  );
  const stateDbPath = path.join(codexHome, "state_1.sqlite");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(screenPath, "Ready\n› ");
    fs.writeFileSync(beforeRolloutPath, `${JSON.stringify({
      timestamp: "2026-08-06T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: beforeNativeThreadId,
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.146.0"
      }
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(stateDbPath, "", { mode: 0o600 });
    writeFakeSqlite({
      fakeBinDir,
      nativeThreadId: beforeNativeThreadId,
      rolloutPath: beforeRolloutPath,
      workspace
    });
    writeFakeTmux({
      fakeBinDir,
      callsPath: tmuxCallsPath,
      screenPath,
      statusCountPath,
      clearCountPath,
      wrongNextStatusPath,
      draftAfterNextStatusPath,
      blankRowsAfterNextStatusPath,
      target,
      panePid,
      workspace,
      beforeNativeThreadId,
      afterNativeThreadId,
      unexpectedNativeThreadId,
      thirdNativeThreadId,
      afterRolloutPath,
      afterRolloutMaterializedPath,
      afterRolloutContents: `${JSON.stringify({
        timestamp: "2026-08-06T00:01:00.000Z",
        type: "session_meta",
        payload: {
          id: afterNativeThreadId,
          cwd: workspace,
          originator: "codex-tui",
          source: "cli",
          cli_version: "0.146.0"
        }
      })}\n`,
      thirdRolloutPath,
      thirdRolloutContents: `${JSON.stringify({
        timestamp: "2026-08-06T00:02:00.000Z",
        type: "session_meta",
        payload: {
          id: thirdNativeThreadId,
          cwd: workspace,
          originator: "codex-tui",
          source: "cli",
          cli_version: "0.146.0"
        }
      })}\n`
    });
    writeFakeProcessTools({
      fakeBinDir,
      beforeRolloutPath,
      afterRolloutPath,
      afterRolloutMaterializedPath,
      thirdRolloutPath,
      unknownRolloutPath,
      executablePath,
      workspace,
      panePid,
      codexPid,
      processBirth
    });

    const terminalControl: TerminalControlRef = {
      kind: "tmux",
      target,
      session: "tmux-sticky-rollout",
      window: 0,
      pane: 0,
      panePid,
      currentCommand: "codex",
      currentPath: workspace,
      capabilities: [
        "screen_status",
        "send_keys",
        "terminal_approval",
        "screen_completion",
        "durable_completion",
        "terminal_cancel"
      ]
    };
    const environment = {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
      AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
    };
    const rolloutRealPath = fs.realpathSync(beforeRolloutPath);
    const rolloutStat = fs.statSync(rolloutRealPath);
    const beforeRollout = {
      fd: "12u",
      device: String(rolloutStat.dev),
      inode: String(rolloutStat.ino),
      path: rolloutRealPath
    };

    ensureStoreWritable(storeDir);
    const sourceSessionId = "session-codex-sticky-rollout-source";
    const now = new Date("2026-08-06T03:00:00.000Z");
    const sourceSession = saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: sourceSessionId,
      agent: "codex",
      workspace,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId,
        terminalControl,
        pid: codexPid,
        nativeThreadId: beforeNativeThreadId,
        processUuid: `codex-pid:${codexPid}:birth:${processBirth}`,
        processBirth,
        rollout: beforeRollout,
        evidence: "codex_rollout_fd",
        generation: 1,
        now
      }),
      lineage: { created_by: "attach" },
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    }, { expectedRevision: null });

    const expectedSourceBindingToken = managedSessionBindingToken(sourceSession);
    fs.writeFileSync(
      screenPath,
      "Ready\n› unsent lifecycle draft\ngpt-5.4 default · 100% left"
    );
    const draftBeforeProbe = runCli([
      "new-thread",
      "--terminal",
      terminalId,
      "--expected-binding-token",
      expectedSourceBindingToken,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(
      draftBeforeProbe.status,
      1,
      draftBeforeProbe.stderr || draftBeforeProbe.stdout
    );
    assert.match(
      draftBeforeProbe.stderr,
      /composer contains non-placeholder input/u
    );
    assert.deepEqual(readLiteralSends(tmuxCallsPath), []);
    assert.equal(listConversations(storeDir).length, 0);
    assert.equal(listManagedSessions(storeDir).length, 1);
    assert.equal(listManagedSessions(storeDir)[0].status, "bound");

    fs.writeFileSync(screenPath, "Ready\n› ");
    fs.writeFileSync(draftAfterNextStatusPath, "draft");
    const draftBeforeTransition = runCli([
      "new-thread",
      "--terminal",
      terminalId,
      "--expected-binding-token",
      expectedSourceBindingToken,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(
      draftBeforeTransition.status,
      1,
      draftBeforeTransition.stderr || draftBeforeTransition.stdout
    );
    assert.match(
      draftBeforeTransition.stderr,
      /composer contains non-placeholder input/u
    );
    assert.deepEqual(readLiteralSends(tmuxCallsPath), ["/status"]);
    assert.equal(fs.existsSync(clearCountPath), false);
    assert.equal(listConversations(storeDir).length, 0);
    assert.equal(listManagedSessions(storeDir).length, 1);
    assert.equal(listManagedSessions(storeDir)[0].status, "bound");

    fs.writeFileSync(statusCountPath, "0");
    fs.writeFileSync(screenPath, `Ready\n› \n${"\n".repeat(30)}`);
    fs.writeFileSync(blankRowsAfterNextStatusPath, "ready");
    const result = runCli([
      "new-thread",
      "--terminal",
      terminalId,
      "--expected-binding-token",
      expectedSourceBindingToken,
      "--require-restorable-origin",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(
      result.status,
      0,
      `${result.stderr}${result.stdout}\n${JSON.stringify({
        runtime: debugJsonFiles(runtimeDir),
        store: debugJsonFiles(storeDir)
      }, null, 2)}`
    );
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "committed");
    assert.equal(output.previous_session_id, sourceSessionId);
    assert.equal(output.native_thread_id, afterNativeThreadId);
    assert.equal(output.turn_created, false);

    const sessions = listManagedSessions(storeDir);
    assert.equal(sessions.length, 2);
    const detachedSource = sessions.find((entry) =>
      entry.session_id === sourceSessionId
    );
    const boundTarget = sessions.find((entry) =>
      entry.session_id === output.session_id
    );
    assert.equal(detachedSource?.status, "detached");
    assert.equal(boundTarget?.status, "bound");
    assert.ok(boundTarget);
    assert.equal(boundTarget?.binding?.native_thread_id, afterNativeThreadId);
    assert.equal(boundTarget?.binding?.native_process.rollout, undefined);
    assert.equal(listConversations(storeDir).length, 0);
    const targetBindingToken = managedSessionBindingToken(boundTarget);

    const transition = loadNativeThreadTransition(
      storeDir,
      output.transition_id
    );
    assert.equal(transition.status, "committed");
    assert.equal(transition.before_native_thread_id, beforeNativeThreadId);
    assert.deepEqual(transition.before_process_rollout, beforeRollout);
    assert.equal(
      transition.after_binding?.native_thread_id,
      afterNativeThreadId
    );
    assert.equal(transition.after_binding?.native_process.rollout, undefined);
    assert.equal(
      transition.after_binding?.binding_id,
      boundTarget?.binding?.binding_id
    );

    const ledgerKey = createHash("sha256")
      .update(JSON.stringify({ target, socket_path: null }))
      .digest("hex")
      .slice(0, 20);
    const ledger = JSON.parse(fs.readFileSync(path.join(
      runtimeDir,
      "terminal-dispatch",
      `terminal-dispatch-${ledgerKey}.json`
    ), "utf8"));
    assert.equal(ledger.status, "resolved");
    assert.equal(ledger.target_native_thread_id, afterNativeThreadId);
    assert.equal(ledger.before_process_rollout, undefined);
    assert.equal(ledger.binding.native_thread_id, afterNativeThreadId);
    assert.equal(ledger.binding.native_process.rollout, undefined);

    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--no-approval-scan"
    ], environment);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedTerminal = JSON.parse(listed.stdout).terminals[0];
    assert.equal(listedTerminal.managed.session_id, boundTarget.session_id);
    assert.equal(
      listedTerminal.managed.native_thread_id,
      afterNativeThreadId
    );
    assert.equal(listedTerminal.managed.binding_token, targetBindingToken);

    const resumable = runCli([
      "list-resumable-threads",
      "--terminal",
      terminalId,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(resumable.status, 0, resumable.stderr || resumable.stdout);
    const resumableOutput = JSON.parse(resumable.stdout);
    assert.equal(resumableOutput.current_session_id, boundTarget.session_id);
    assert.equal(
      resumableOutput.current_native_thread_id,
      afterNativeThreadId
    );
    assert.equal(resumableOutput.expected_binding_token, targetBindingToken);

    // The raw resolver still sees the sticky before-thread rollout. Public
    // discovery must nevertheless project the authoritative logical Session.
    assert.equal(
      listedTerminal.native_agent_session_id,
      afterNativeThreadId
    );
    assert.equal(listedTerminal.native_agent_rollout, undefined);
    assert.equal(
      listedTerminal.lifecycle_binding_token,
      targetBindingToken
    );

    const message = "Report the logical Codex thread after sticky rollout.";
    const targetStatePath = pathsForManagedSession(
      boundTarget.session_id,
      storeDir
    ).statePath;
    const targetStateBeforeRejectedSend = fs.readFileSync(
      targetStatePath,
      "utf8"
    );
    const literalCountBeforeDraft = readLiteralSends(tmuxCallsPath).length;
    fs.writeFileSync(screenPath, "Ready\n› unsent draft");
    const draftRejected = runCli([
      "send",
      "--session",
      boundTarget.session_id,
      "--message",
      "This draft-blocked message must never reach tmux.",
      "--background",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--disable-terminal-bridge-monitor"
    ], environment);
    assert.equal(
      draftRejected.status,
      1,
      draftRejected.stderr || draftRejected.stdout
    );
    assert.match(
      draftRejected.stderr,
      /(?:terminal is unknown, not idle|composer contains non-placeholder input)/u
    );
    assert.equal(
      readLiteralSends(tmuxCallsPath).length,
      literalCountBeforeDraft
    );
    assert.equal(listConversations(storeDir).length, 0);
    assert.equal(
      fs.readFileSync(targetStatePath, "utf8"),
      targetStateBeforeRejectedSend
    );
    assert.equal(fs.existsSync(afterRolloutPath), false);

    fs.writeFileSync(screenPath, "Ready\n› ");
    fs.writeFileSync(wrongNextStatusPath, "wrong");
    const rejected = runCli([
      "send",
      "--session",
      boundTarget.session_id,
      "--message",
      "This user message must never reach tmux.",
      "--background",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--disable-terminal-bridge-monitor"
    ], environment);
    assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
    assert.match(
      rejected.stderr,
      new RegExp(
        `Codex /status reports native thread ${unexpectedNativeThreadId}`,
        "u"
      )
    );
    assert.equal(listConversations(storeDir).length, 0);
    assert.equal(
      fs.readFileSync(targetStatePath, "utf8"),
      targetStateBeforeRejectedSend
    );
    assert.equal(fs.existsSync(afterRolloutPath), false);
    assert.deepEqual(
      readLiteralSends(tmuxCallsPath).slice(-1),
      ["/status"]
    );

    const sent = runCli([
      "send",
      "--session",
      boundTarget.session_id,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--disable-terminal-bridge-monitor"
    ], environment);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentOutput = JSON.parse(sent.stdout);
    assert.equal(sentOutput.delivered, true, sent.stdout);
    assert.equal(sentOutput.session_id, boundTarget.session_id);
    assert.equal(sentOutput.status, "async_pending");
    const turns = listConversations(storeDir);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].session_id, boundTarget.session_id);
    assert.equal(
      turns[0].terminal_binding_id,
      boundTarget.binding?.binding_id
    );
    assert.equal(
      turns[0].terminal_binding_generation,
      boundTarget.binding?.generation
    );
    assert.equal(
      (turns[0].native_session_takeover as Record<string, unknown>)
        ?.terminal_agent_session_id,
      afterNativeThreadId
    );
    assert.equal(turns[0].native_thread_id, afterNativeThreadId);
    const afterRolloutRealPath = fs.realpathSync(afterRolloutPath);
    const afterRolloutStat = fs.statSync(afterRolloutRealPath);
    const afterRollout = {
      fd: "13u",
      device: String(afterRolloutStat.dev),
      inode: String(afterRolloutStat.ino),
      path: afterRolloutRealPath
    };
    assert.deepEqual(
      (turns[0].native_session_takeover as Record<string, any>)
        ?.terminal_agent_rollout,
      afterRollout
    );
    const targetAfterSend = listManagedSessions(storeDir).find((entry) =>
      entry.session_id === boundTarget.session_id
    );
    assert.ok(targetAfterSend);
    assert.equal(targetAfterSend?.status, "bound");
    assert.equal(
      targetAfterSend?.binding?.native_thread_id,
      afterNativeThreadId
    );
    assert.deepEqual(
      targetAfterSend?.binding?.native_process.rollout,
      afterRollout
    );
    assert.equal(
      JSON.stringify(targetAfterSend).includes(beforeRollout.path),
      false
    );
    assert.equal(
      JSON.stringify(turns[0]).includes(beforeRollout.path),
      false
    );

    const closed = runCli([
      "close",
      "--turn",
      sentOutput.turn_id,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--reason",
      "close first sticky-rollout Turn before the second send"
    ], environment);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    const closedOutput = JSON.parse(closed.stdout);
    assert.equal(closedOutput.closed, true);
    assert.equal(closedOutput.terminal_dispatch_resolved, true);
    assert.equal(closedOutput.conversation.status, "closed");

    // A completed Turn leaves both the previous A rollout and current B
    // rollout open while the TUI returns to a fresh composer. Generic Codex
    // discovery is intentionally ambiguous here; plain list must reuse only
    // the exact committed managed lineage and continue to project B.
    fs.writeFileSync(
      screenPath,
      "Ready\n› Summarize recent commits\n\ngpt-5.4 default · 100% left"
    );
    const listedAfterCompletedTurn = runCli([
      "list",
      "--all",
      "--terminal-debug",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(
      listedAfterCompletedTurn.status,
      0,
      listedAfterCompletedTurn.stderr || listedAfterCompletedTurn.stdout
    );
    const completedTurnTerminal = JSON.parse(
      listedAfterCompletedTurn.stdout
    ).terminals[0];
    assert.equal(
      completedTurnTerminal.activity_state,
      "idle",
      JSON.stringify({
        activity_reason: completedTurnTerminal.activity_reason,
        approval_state: completedTurnTerminal.approval_state,
        terminal_control: completedTurnTerminal.terminal_control
      })
    );
    assert.equal(completedTurnTerminal.management_state, "managed");
    assert.equal(
      completedTurnTerminal.managed.session_id,
      targetAfterSend.session_id
    );
    assert.equal(
      completedTurnTerminal.managed.native_thread_id,
      afterNativeThreadId
    );
    assert.equal(
      completedTurnTerminal.native_agent_session_id,
      afterNativeThreadId
    );
    assert.deepEqual(completedTurnTerminal.native_agent_rollout, afterRollout);
    assert.equal(
      completedTurnTerminal.lifecycle_binding_token,
      managedSessionBindingToken(targetAfterSend)
    );
    assert.equal(
      completedTurnTerminal.available_actions.send.arguments.session_id,
      targetAfterSend.session_id
    );

    fs.writeFileSync(screenPath, "Ready\n› ");
    const secondMessage =
      "Send again while both the sticky and target rollout FDs remain open.";
    const secondSent = runCli([
      "send",
      "--session",
      boundTarget.session_id,
      "--message",
      secondMessage,
      "--background",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--disable-terminal-bridge-monitor"
    ], environment);
    assert.equal(
      secondSent.status,
      0,
      secondSent.stderr || secondSent.stdout
    );
    const secondOutput = JSON.parse(secondSent.stdout);
    assert.equal(secondOutput.delivered, true, secondSent.stdout);
    assert.equal(secondOutput.status, "async_pending");
    assert.equal(secondOutput.session_id, boundTarget.session_id);
    assert.notEqual(secondOutput.turn_id, sentOutput.turn_id);
    const turnsAfterSecondSend = listConversations(storeDir);
    assert.equal(turnsAfterSecondSend.length, 2);
    const secondTurn = turnsAfterSecondSend.find((entry) =>
      entry.turn_id === secondOutput.turn_id
    );
    assert.equal(secondTurn?.session_id, boundTarget.session_id);
    assert.equal(secondTurn?.native_thread_id, afterNativeThreadId);
    assert.deepEqual(
      (secondTurn?.native_session_takeover as Record<string, any>)
        ?.terminal_agent_rollout,
      afterRollout
    );
    assert.equal(
      JSON.stringify(secondTurn).includes(beforeRollout.path),
      false
    );
    const targetAfterSecondSend = listManagedSessions(storeDir).find((entry) =>
      entry.session_id === boundTarget.session_id
    );
    assert.ok(targetAfterSecondSend);
    assert.equal(
      targetAfterSecondSend?.binding?.native_thread_id,
      afterNativeThreadId
    );
    assert.deepEqual(
      targetAfterSecondSend?.binding?.native_process.rollout,
      afterRollout
    );

    const closedSecond = runCli([
      "close",
      "--turn",
      secondOutput.turn_id,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--reason",
      "close second sticky-rollout Turn before another new-thread"
    ], environment);
    assert.equal(
      closedSecond.status,
      0,
      closedSecond.stderr || closedSecond.stdout
    );
    assert.equal(JSON.parse(closedSecond.stdout).closed, true);
    assert.equal(
      JSON.parse(closedSecond.stdout).terminal_dispatch_resolved,
      true
    );

    fs.writeFileSync(screenPath, "Ready\n› ");
    const secondNew = runCli([
      "new-thread",
      "--terminal",
      terminalId,
      "--expected-binding-token",
      managedSessionBindingToken(targetAfterSecondSend),
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(
      secondNew.status,
      0,
      `${secondNew.stderr}${secondNew.stdout}\n${JSON.stringify({
        runtime: debugJsonFiles(runtimeDir),
        store: debugJsonFiles(storeDir)
      }, null, 2)}`
    );
    const secondNewOutput = JSON.parse(secondNew.stdout);
    assert.equal(secondNewOutput.status, "committed");
    assert.equal(
      secondNewOutput.previous_session_id,
      boundTarget.session_id
    );
    assert.equal(secondNewOutput.native_thread_id, thirdNativeThreadId);
    assert.equal(secondNewOutput.turn_created, false);
    const sessionsAfterSecondNew = listManagedSessions(storeDir);
    assert.equal(sessionsAfterSecondNew.length, 3);
    assert.equal(
      sessionsAfterSecondNew.find((entry) =>
        entry.session_id === boundTarget.session_id
      )?.status,
      "detached"
    );
    const thirdSession = sessionsAfterSecondNew.find((entry) =>
      entry.session_id === secondNewOutput.session_id
    );
    assert.equal(thirdSession?.status, "bound");
    assert.ok(thirdSession);
    assert.equal(
      thirdSession.binding?.native_thread_id,
      thirdNativeThreadId
    );
    assert.equal(thirdSession.binding?.native_process.rollout, undefined);
    const secondTransition = loadNativeThreadTransition(
      storeDir,
      secondNewOutput.transition_id
    );
    assert.equal(secondTransition.status, "committed");
    assert.equal(
      secondTransition.before_native_thread_id,
      afterNativeThreadId
    );
    assert.deepEqual(secondTransition.before_process_rollout, afterRollout);
    assert.equal(
      secondTransition.after_binding?.native_thread_id,
      thirdNativeThreadId
    );
    assert.equal(
      secondTransition.after_binding?.native_process.rollout,
      undefined
    );

    const thirdMessage =
      "Bind this message to the third logical Session with old rollouts open.";
    const thirdSent = runCli([
      "send",
      "--session",
      thirdSession.session_id,
      "--message",
      thirdMessage,
      "--background",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--disable-terminal-bridge-monitor"
    ], environment);
    assert.equal(thirdSent.status, 0, thirdSent.stderr || thirdSent.stdout);
    const thirdOutput = JSON.parse(thirdSent.stdout);
    assert.equal(thirdOutput.delivered, true, thirdSent.stdout);
    assert.equal(thirdOutput.status, "async_pending");
    assert.equal(thirdOutput.session_id, thirdSession.session_id);
    const turnsAfterThirdSend = listConversations(storeDir);
    assert.equal(turnsAfterThirdSend.length, 3);
    const thirdTurn = turnsAfterThirdSend.find((entry) =>
      entry.turn_id === thirdOutput.turn_id
    );
    assert.equal(thirdTurn?.session_id, thirdSession.session_id);
    assert.equal(thirdTurn?.native_thread_id, thirdNativeThreadId);
    const thirdRolloutRealPath = fs.realpathSync(thirdRolloutPath);
    const thirdRolloutStat = fs.statSync(thirdRolloutRealPath);
    const thirdRollout = {
      fd: "14u",
      device: String(thirdRolloutStat.dev),
      inode: String(thirdRolloutStat.ino),
      path: thirdRolloutRealPath
    };
    assert.deepEqual(
      (thirdTurn?.native_session_takeover as Record<string, any>)
        ?.terminal_agent_rollout,
      thirdRollout
    );
    const thirdSessionAfterSend = listManagedSessions(storeDir).find((entry) =>
      entry.session_id === thirdSession.session_id
    );
    assert.equal(
      thirdSessionAfterSend?.binding?.native_thread_id,
      thirdNativeThreadId
    );
    assert.deepEqual(
      thirdSessionAfterSend?.binding?.native_process.rollout,
      thirdRollout
    );
    assert.equal(
      JSON.stringify(thirdSessionAfterSend).includes(beforeRollout.path),
      false
    );
    assert.equal(
      JSON.stringify(thirdSessionAfterSend).includes(afterRollout.path),
      false
    );

    // Keep both detached rollout roots open while the active third Turn is
    // monitored. The monitor must carry the same exact companion fences as
    // send/status; otherwise Codex identity verification degrades to
    // "ambiguous" and terminal_activity_state becomes "unknown".
    fs.writeFileSync(screenPath, "Ready\n› ");
    const monitoredThird = runCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      thirdOutput.conversation.state_path,
      "--log",
      thirdOutput.conversation.event_log_path,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "0.001",
      "--agent-hard-timeout-minutes",
      "10",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(
      monitoredThird.status,
      0,
      monitoredThird.stderr || monitoredThird.stdout
    );
    const monitoredThirdOutput = JSON.parse(monitoredThird.stdout);
    assert.equal(monitoredThirdOutput.monitored, true);
    assert.equal(monitoredThirdOutput.terminal_bridge, true);
    assert.equal(monitoredThirdOutput.stalled, true);
    assert.equal(monitoredThirdOutput.conversation.status, "stalled");
    assert.match(monitoredThirdOutput.reason, /observed no activity/u);
    const thirdMonitorEvents = fs.readFileSync(
      thirdOutput.conversation.event_log_path,
      "utf8"
    )
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const thirdMonitorStalledEvent = thirdMonitorEvents
      .filter((event) => event.event === "conversation_stalled")
      .at(-1);
    assert.equal(
      thirdMonitorStalledEvent?.terminal_activity_state,
      "idle",
      JSON.stringify(thirdMonitorStalledEvent)
    );

    const closedThird = runCli([
      "close",
      "--turn",
      thirdOutput.turn_id,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--reason",
      "close third sticky-rollout Turn before unknown-root rejection"
    ], environment);
    assert.equal(
      closedThird.status,
      0,
      closedThird.stderr || closedThird.stdout
    );
    assert.equal(JSON.parse(closedThird.stdout).closed, true);
    fs.writeFileSync(unknownRolloutPath, `${JSON.stringify({
      timestamp: "2026-08-06T00:03:00.000Z",
      type: "session_meta",
      payload: {
        id: unknownNativeThreadId,
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.146.0"
      }
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(screenPath, "Ready\n› ");
    const listedWithUnknownRoot = runCli([
      "list",
      "--all",
      "--terminal-debug",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(
      listedWithUnknownRoot.status,
      0,
      listedWithUnknownRoot.stderr || listedWithUnknownRoot.stdout
    );
    const unknownRootTerminal = JSON.parse(
      listedWithUnknownRoot.stdout
    ).terminals[0];
    assert.notEqual(
      unknownRootTerminal.managed.session_id,
      thirdSession.session_id
    );
    assert.notEqual(
      unknownRootTerminal.native_agent_session_id,
      thirdNativeThreadId
    );
    assert.notEqual(
      unknownRootTerminal.available_actions.send?.arguments?.session_id,
      thirdSession.session_id
    );
    const thirdStatePath = pathsForManagedSession(
      thirdSession.session_id,
      storeDir
    ).statePath;
    const thirdStateBeforeUnknown = fs.readFileSync(thirdStatePath, "utf8");
    const turnsBeforeUnknown = listConversations(storeDir).length;
    const literalsBeforeUnknown = readLiteralSends(tmuxCallsPath).length;
    const unknownRejected = runCli([
      "send",
      "--session",
      thirdSession.session_id,
      "--message",
      "This message must not pass an unknown fourth root rollout.",
      "--background",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--disable-terminal-bridge-monitor"
    ], environment);
    assert.equal(
      unknownRejected.status,
      1,
      unknownRejected.stderr || unknownRejected.stdout
    );
    assert.match(
      unknownRejected.stderr,
      /(?:unexpected open root rollout|no longer available)/u
    );
    assert.equal(listConversations(storeDir).length, turnsBeforeUnknown);
    assert.equal(
      fs.readFileSync(thirdStatePath, "utf8"),
      thirdStateBeforeUnknown
    );
    assert.equal(readLiteralSends(tmuxCallsPath).length, literalsBeforeUnknown);

    const literalSends = readLiteralSends(tmuxCallsPath);
    assert.deepEqual(literalSends, [
      "/status",
      "/status",
      "/clear",
      "/status",
      "/status",
      "/status",
      message,
      "/status",
      secondMessage,
      "/status",
      "/clear",
      "/status",
      "/status",
      thirdMessage
    ]);
    assert.equal(fs.readFileSync(statusCountPath, "utf8"), "8");
    assert.equal(fs.readFileSync(clearCountPath, "utf8"), "2");
    assert.equal(literalSends.filter((text) => text === "/clear").length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000
  });
}

function writeFakeTmux(options: {
  fakeBinDir: string;
  callsPath: string;
  screenPath: string;
  statusCountPath: string;
  clearCountPath: string;
  wrongNextStatusPath: string;
  draftAfterNextStatusPath: string;
  blankRowsAfterNextStatusPath: string;
  target: string;
  panePid: number;
  workspace: string;
  beforeNativeThreadId: string;
  afterNativeThreadId: string;
  unexpectedNativeThreadId: string;
  thirdNativeThreadId: string;
  afterRolloutPath: string;
  afterRolloutMaterializedPath: string;
  afterRolloutContents: string;
  thirdRolloutPath: string;
  thirdRolloutContents: string;
}): void {
  fs.writeFileSync(path.join(options.fakeBinDir, "tmux"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.callsPath)}, JSON.stringify({ args }) + "\\n");
if (args[0] === "list-panes") {
  process.stdout.write(${JSON.stringify(
    `tmux-sticky-rollout\t0\t0\t${options.panePid}\tcodex\t${options.workspace}\n`
  )});
  process.exit(0);
}
if (args[0] === "capture-pane") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8"));
  process.exit(0);
}
if (args[0] === "send-keys" && args.includes("-l")) {
  const text = args[args.length - 1];
  if (text === "/status") {
    const count = fs.existsSync(${JSON.stringify(options.statusCountPath)})
      ? Number(fs.readFileSync(${JSON.stringify(options.statusCountPath)}, "utf8"))
      : 0;
    const next = count + 1;
    fs.writeFileSync(${JSON.stringify(options.statusCountPath)}, String(next));
    const wrongNext = fs.existsSync(${JSON.stringify(options.wrongNextStatusPath)});
    if (wrongNext) {
      fs.unlinkSync(${JSON.stringify(options.wrongNextStatusPath)});
    }
    const draftAfterStatus = fs.existsSync(${JSON.stringify(options.draftAfterNextStatusPath)});
    if (draftAfterStatus) {
      fs.unlinkSync(${JSON.stringify(options.draftAfterNextStatusPath)});
    }
    const blankRowsAfterStatus = fs.existsSync(${JSON.stringify(options.blankRowsAfterNextStatusPath)});
    if (blankRowsAfterStatus) {
      fs.unlinkSync(${JSON.stringify(options.blankRowsAfterNextStatusPath)});
    }
    const clearCount = fs.existsSync(${JSON.stringify(options.clearCountPath)})
      ? Number(fs.readFileSync(${JSON.stringify(options.clearCountPath)}, "utf8"))
      : 0;
    const id = wrongNext
      ? ${JSON.stringify(options.unexpectedNativeThreadId)}
      : next === 1
        ? ${JSON.stringify(options.beforeNativeThreadId)}
        : clearCount >= 2
          ? ${JSON.stringify(options.thirdNativeThreadId)}
          : ${JSON.stringify(options.afterNativeThreadId)};
    fs.writeFileSync(${JSON.stringify(options.screenPath)},
      "/status\\nprobe-" + next + "\\nSession: " + id +
      (draftAfterStatus
        ? "\\n› unsent lifecycle draft\\ngpt-5.4 default · 100% left"
        : "\\n› " + (blankRowsAfterStatus ? "\\n".repeat(30) : "")));
  } else if (text === "/clear") {
    const clearCount = fs.existsSync(${JSON.stringify(options.clearCountPath)})
      ? Number(fs.readFileSync(${JSON.stringify(options.clearCountPath)}, "utf8"))
      : 0;
    fs.writeFileSync(
      ${JSON.stringify(options.clearCountPath)},
      String(clearCount + 1)
    );
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Cleared\\n› ");
  } else {
    const clearCount = fs.existsSync(${JSON.stringify(options.clearCountPath)})
      ? Number(fs.readFileSync(${JSON.stringify(options.clearCountPath)}, "utf8"))
      : 0;
    if (clearCount >= 2) {
      fs.writeFileSync(
        ${JSON.stringify(options.thirdRolloutPath)},
        ${JSON.stringify(options.thirdRolloutContents)},
        { mode: 384 }
      );
    } else {
      fs.writeFileSync(
        ${JSON.stringify(options.afterRolloutPath)},
        ${JSON.stringify(options.afterRolloutContents)},
        { mode: 384 }
      );
      fs.writeFileSync(
        ${JSON.stringify(options.afterRolloutMaterializedPath)},
        "ready"
      );
    }
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Working\\n");
  }
}
`, { mode: 0o755 });
}

function writeFakeProcessTools(options: {
  fakeBinDir: string;
  beforeRolloutPath: string;
  afterRolloutPath: string;
  afterRolloutMaterializedPath: string;
  thirdRolloutPath: string;
  unknownRolloutPath: string;
  executablePath: string;
  workspace: string;
  panePid: number;
  codexPid: number;
  processBirth: string;
}): void {
  fs.writeFileSync(path.join(options.fakeBinDir, "ps"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("lstart=")) {
  process.stdout.write(${JSON.stringify(`${options.processBirth}\n`)});
} else {
  process.stdout.write("  PID  PPID ELAPSED COMMAND\\n" +
    ${JSON.stringify(`${options.panePid} 1 00:10 zsh\n`)} +
    ${JSON.stringify(`${options.codexPid} ${options.panePid} 00:09 ${options.executablePath}\n`)});
}
`, { mode: 0o755 });

  fs.writeFileSync(path.join(options.fakeBinDir, "lsof"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("cwd")) {
  process.stdout.write("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n" +
    "codex ${options.codexPid} me cwd DIR 1,18 64 123 ${options.workspace}\\n");
} else if (args.includes("txt")) {
  process.stdout.write("p${options.codexPid}\\nftxt\\nn${options.executablePath}\\n");
} else {
  const beforeStat = fs.statSync(${JSON.stringify(options.beforeRolloutPath)});
  let output = "p${options.codexPid}\\nf12u\\ntREG\\nD" + beforeStat.dev +
    "\\ni" + beforeStat.ino + "\\nn${options.beforeRolloutPath}\\n";
  if (fs.existsSync(${JSON.stringify(options.afterRolloutMaterializedPath)})) {
    const afterStat = fs.statSync(${JSON.stringify(options.afterRolloutPath)});
    output += "f13u\\ntREG\\nD" + afterStat.dev + "\\ni" + afterStat.ino +
      "\\nn${options.afterRolloutPath}\\n";
  }
  if (fs.existsSync(${JSON.stringify(options.thirdRolloutPath)})) {
    const thirdStat = fs.statSync(${JSON.stringify(options.thirdRolloutPath)});
    output += "f14u\\ntREG\\nD" + thirdStat.dev + "\\ni" + thirdStat.ino +
      "\\nn${options.thirdRolloutPath}\\n";
  }
  if (fs.existsSync(${JSON.stringify(options.unknownRolloutPath)})) {
    const unknownStat = fs.statSync(${JSON.stringify(options.unknownRolloutPath)});
    output += "f15u\\ntREG\\nD" + unknownStat.dev + "\\ni" + unknownStat.ino +
      "\\nn${options.unknownRolloutPath}\\n";
  }
  process.stdout.write(output);
}
`, { mode: 0o755 });
}

function writeFakeSqlite(options: {
  fakeBinDir: string;
  nativeThreadId: string;
  rolloutPath: string;
  workspace: string;
}): void {
  const columns = [
    "id",
    "cwd",
    "rollout_path",
    "updated_at_ms",
    "archived",
    "source",
    "cli_version"
  ].map((name) => ({ name }));
  const rows = [{
    id: options.nativeThreadId,
    cwd: options.workspace,
    rollout_path: options.rolloutPath,
    updated_at_ms: 1_786_000_000_000,
    archived: 0,
    source: "cli",
    cli_version: "0.146.0"
  }];
  fs.writeFileSync(path.join(options.fakeBinDir, "sqlite3"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const sql = args[3] || "";
if (sql === "pragma table_info(threads)") {
  process.stdout.write(${JSON.stringify(JSON.stringify(columns))});
} else if (sql.startsWith("select id")) {
  process.stdout.write(${JSON.stringify(JSON.stringify(rows))});
} else {
  process.stderr.write("unexpected sqlite query: " + sql);
  process.exit(1);
}
`, { mode: 0o755 });
}

function readJsonLines(filePath: string): Array<{ args: string[] }> {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readLiteralSends(filePath: string): Array<string | undefined> {
  return readJsonLines(filePath)
    .filter((call) => call.args[0] === "send-keys" && call.args.includes("-l"))
    .map((call) => call.args.at(-1));
}

function debugJsonFiles(root: string): Record<string, unknown> {
  if (!fs.existsSync(root)) {
    return {};
  }
  return Object.fromEntries(
    fs.readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((entry) => String(entry).endsWith(".json"))
      .map((entry) => {
        const relative = String(entry);
        try {
          return [
            relative,
            JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"))
          ];
        } catch {
          return [relative, "unreadable"];
        }
      })
  );
}
