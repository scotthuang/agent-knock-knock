import nodeTest, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  executeCliCommand,
  parseCliCommand,
  type CliCommandDependencies
} from "../../src/cli-core.js";
import type {
  CodexLocalSessionAdapter
} from "../../src/codex-local-session-provider.js";
import type {
  CodexOpenRootRolloutInventory
} from "../../src/agent-session-provider.js";
import {
  inspectCodexOpenRootRolloutInventory
} from "../../src/codex-store-adapter.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedSessionState,
  type NativeThreadTransition
} from "../../src/managed-session.js";
import {
  createDeferredForegroundTransferId,
  DEFERRED_FOREGROUND_TRANSFER_SCHEMA,
  DEFERRED_FOREGROUND_TRANSFER_VERSION,
  listDeferredForegroundTransfers,
  saveDeferredForegroundTransfer,
  pathsForDeferredForegroundTransfer,
  type DeferredForegroundTransfer
} from "../../src/deferred-foreground-transfer.js";
import {
  listManagedSessions,
  loadManagedSession,
  loadNativeThreadTransition,
  nativeThreadTransitionsDir,
  pathsForManagedSession,
  saveManagedSession,
  saveNativeThreadTransition
} from "../../src/session-store.js";
import {
  ensureStoreWritable,
  listConversations,
  pathsForConversation,
  saveState
} from "../../src/store.js";
import { createConversation } from "../../src/protocol.js";
import {
  createTerminalControlProviderRegistry,
  TmuxTerminalControlProvider,
  type CommandResult
} from "../../src/terminal-control-provider.js";
import {
  HERDR_EXACT_PROTOCOL,
  HERDR_EXACT_VERSION,
  HerdrTerminalControlProvider,
  type HerdrWireRequest
} from "../../src/herdr-terminal-control-provider.js";
import { StaticTerminalProcessSource } from "../../src/terminal-process-source.js";
import type {
  TerminalControlRef,
  TerminalThreadLifecycleCandidate,
  TerminalThreadLifecycleCandidateProvider,
  TerminalThreadLifecycleCandidateRequest,
  TerminalThreadLifecycleCandidateToken
} from "../../src/terminal-agent-adapter.js";
import {
  createTerminalEndpointRef,
  terminalEndpointIdentityFromEvidence,
  terminalEndpointIdentityKey,
  tmuxTerminalRouteKey
} from "../../src/terminal-control-ref.js";
import {
  codexNativeAcceptanceEnv,
  codexNoRolloutBackgroundSendArgs,
  codexNoRolloutManagedStateMachineArgs,
  codexNoRolloutStoreArgs
} from "../support/codex-no-rollout-cli-harness.js";

import {
  test,
  binPath,
  LIVE_PROCESS_BIRTH,
  STALE_PROCESS_BIRTH,
  NATIVE_THREAD_ID,
  EXTERNAL_THREAD_ID,
  SECOND_EXTERNAL_THREAD_ID,
  FIRST_NATIVE_TURN_ID,
  FIXTURE_TMUX_PANE_ID,
  SIMULATED_DEAD_CLI_PID,
  CODEX_TEST_COMPOSER_FOOTER,
  codexTestComposerScreen,
  createNoRolloutFixture,
  persistStatusCardSession,
  persistExactEndedRolloutSession,
  persistDetachedRolloutCompanion,
  persistConflictSession,
  listFixtureTerminal,
  deferredForegroundSendAction,
  assertTerminalUserExplicitSendAction,
  deferredForegroundSendArgs,
  userExplicitDeferredForegroundSendArgs,
  seedStatusCardManagedApproval,
  approvalKeyCalls,
  codexApprovalScreen,
  soleDeferredForegroundTransfer,
  taskInputCalls,
  assertSingleTaskInput,
  persistedCodexV3AcceptanceAnchor,
  assertRecoveredTurnBlocksDuplicate,
  readSoleTerminalDispatchLedger,
  soleTerminalDispatchLedgerPath,
  seedResolvedHistoricalDispatchAndStatusCard,
  materializePreparedDeferredLedgerWithoutTurnState,
  assertExactDeferredZeroInputAbortLedger,
  assertResolvedSameUuidDeferredTransfer,
  reconcileArguments,
  persistBlockingTurn,
  persistLegacyV1UncertainTurn,
  persistReleasedCandidateSourceTurns,
  persistUnresolvedTransition,
  persistUnresolvedDispatchLedger,
  processUuid,
  InProcessCliExit,
  rewriteSnapshotLockOwners,
  restoreDirectorySnapshot,
  fixtureMutableCheckpoint,
  restoreFixtureMutableCheckpoint,
  runCli,
  runCliCrashCheckpoint,
  runCliSubprocess,
  spawnFixtureNodeEval,
  inProcessFixtures,
  fixtureHerdrResponse,
  createFixtureHerdrProvider,
  inProcessDependencies,
  fixtureProcessSnapshots,
  createFixtureCodexAdapter,
  fixtureCodexOpenRootInventory,
  createFixtureLifecycleProvider,
  runInProcessTmux,
  successfulCommand,
  errorMessage,
  writeFakeTmux,
  writeFakeProcessTools,
  writeFakeSqlite,
  readTmuxCalls,
  appendNativeAcceptance,
  enableFixtureCandidateInventory,
  ensureFixtureCandidateRollout,
  appendFixtureCompletion,
  waitForFixtureConversation,
  waitForProcessExit,
  type NoRolloutFixture,
  type CliTestResult,
  type FixtureMutableCheckpoint,
  type CapturedInProcessExit,
  type CodexNoRolloutTestDefinition,
} from "../support/codex-no-rollout-binding-cli-support.js";

test("human terminal Send keeps managed ownership across transient writer contention", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Keep this explicit Send managed after the writer lease clears.";
  const writerLockPath = path.join(fixture.storeDir, ".akk-writer.lock");
  let lockReleaser: ReturnType<typeof spawn> | undefined;
  try {
    enableFixtureCandidateInventory(fixture, [
      NATIVE_THREAD_ID,
      EXTERNAL_THREAD_ID
    ]);
    const terminal = await listFixtureTerminal(fixture);
    const action = assertTerminalUserExplicitSendAction(terminal);
    fs.mkdirSync(fixture.storeDir, {
      recursive: true,
      mode: 0o700
    });
    fs.writeFileSync(writerLockPath, `${JSON.stringify({
      pid: process.pid,
      token: "human-send-transient-writer-contention",
      created_at: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    lockReleaser = spawnFixtureNodeEval(`
      const fs = require("node:fs");
      const writerLockPath = ${JSON.stringify(writerLockPath)};
      const terminalLockDir = ${JSON.stringify(path.join(
        String(fixture.environment.AKK_RUNTIME_DIR),
        "terminal-locks"
      ))};
      const deadline = Date.now() + 5000;
      const releaseAfterTerminalLock = () => {
        const locks = fs.existsSync(terminalLockDir)
          ? fs.readdirSync(terminalLockDir).filter((name) =>
              name.startsWith("terminal-bridge-send-") && name.endsWith(".lock")
            )
          : [];
        if (locks.length >= 2) {
          setTimeout(() => fs.unlinkSync(writerLockPath), 50);
          return;
        }
        if (Date.now() >= deadline) process.exit(2);
        setTimeout(releaseAfterTerminalLock, 5);
      };
      releaseAfterTerminalLock();
    `);
    fixture.acceptanceNativeThreadIdsOnEnter = [NATIVE_THREAD_ID];

    const sendArgs = userExplicitDeferredForegroundSendArgs(
      fixture,
      action,
      message
    );
    sendArgs.push(
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:writer-grace",
      "--openclaw-session",
      "agent:test:writer-grace"
    );
    const sent = await runCli(
      sendArgs,
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);
    assert.equal(output.management_mode, "managed", sent.stdout);
    assert.equal(output.agent_acceptance, "proven", sent.stdout);
    assert.equal(output.delivered_unmanaged, undefined);
    assert.deepEqual(output.capabilities, {
      callback: true,
      interaction_notify: true,
      interaction_respond: true
    });
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
    assert.equal(listConversations(fixture.storeDir).length, 1);
    assert.equal(
      loadManagedSession(fixture.storeDir, String(output.session_id))
        .binding?.native_thread_id,
      NATIVE_THREAD_ID
    );
    assertSingleTaskInput(fixture, message);
  } finally {
    if (lockReleaser && lockReleaser.exitCode === null) {
      lockReleaser.kill("SIGKILL");
    }
    fs.rmSync(writerLockPath, { force: true });
    fixture.cleanup();
  }
});

for (const sourceLessCase of [
  {
    label: "ambiguous multi-root inventory",
    roots: [NATIVE_THREAD_ID, EXTERNAL_THREAD_ID],
    accepted: SECOND_EXTERNAL_THREAD_ID
  },
  {
    label: "stale sole-root observation",
    roots: [NATIVE_THREAD_ID],
    accepted: EXTERNAL_THREAD_ID
  }
] as const) {
  test(`human terminal Send binds without a claimed source from ${sourceLessCase.label}`, async () => {
    const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
    const message = `Bind a source-less Send from ${sourceLessCase.label}.`;
    try {
      enableFixtureCandidateInventory(fixture, [...sourceLessCase.roots]);
      const terminal = await listFixtureTerminal(fixture);
      const action = assertTerminalUserExplicitSendAction(terminal);
      assert.deepEqual(listManagedSessions(fixture.storeDir), []);
      assert.deepEqual(listConversations(fixture.storeDir), []);

      fixture.acceptanceNativeThreadIdsOnEnter = [sourceLessCase.accepted];
      const sent = await runCli(
        userExplicitDeferredForegroundSendArgs(
          fixture,
          action,
          message
        ),
        codexNativeAcceptanceEnv(fixture.environment)
      );
      assert.equal(sent.status, 0, sent.stderr || sent.stdout);
      const output = JSON.parse(sent.stdout);
      assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);
      assert.equal(output.conversation.native_thread_id, sourceLessCase.accepted);
      assert.equal(output.delivered_unmanaged, undefined);
      assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
      assert.equal(listManagedSessions(fixture.storeDir).length, 1);
      assert.equal(
        loadManagedSession(fixture.storeDir, String(output.session_id))
          .binding?.native_thread_id,
        sourceLessCase.accepted
      );
      const anchor = persistedCodexV3AcceptanceAnchor(
        fixture,
        String(output.turn_id)
      );
      assert.deepEqual(
        anchor.candidate_rollouts.map(
          (candidate: Record<string, any>) => candidate.native_thread_id
        ),
        [...sourceLessCase.roots]
      );
      assertSingleTaskInput(fixture, message);
      assert.equal(
        readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
          call.args.includes("/status")
        ),
        false
      );
    } finally {
      fixture.cleanup();
    }
  });
}

test("source-less human Send recovers a zero-match candidate without replay", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Recover this source-less candidate after its first poll.";
  try {
    enableFixtureCandidateInventory(fixture, [
      NATIVE_THREAD_ID,
      EXTERNAL_THREAD_ID
    ]);
    const terminal = await listFixtureTerminal(fixture);
    const action = assertTerminalUserExplicitSendAction(terminal);
    fixture.acceptanceNativeThreadIdsOnEnter = [];
    fixture.cliPid = process.pid + 500_000;

    const pending = await runCli(
      userExplicitDeferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(pending.status, 0, pending.stderr || pending.stdout);
    const pendingOutput = JSON.parse(pending.stdout);
    assert.equal(pendingOutput.status, "submission_pending_acceptance");
    assert.equal(pendingOutput.submission_outcome, "pending_acceptance");
    assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
    assertSingleTaskInput(fixture, message);

    appendNativeAcceptance(
      fixture.rolloutPath,
      message,
      FIRST_NATIVE_TURN_ID,
      {
        nativeThreadId: NATIVE_THREAD_ID,
        workspace: String(fixture.terminalControl.currentPath),
        codexVersion: fixture.codexVersion,
        timestamp: new Date().toISOString()
      }
    );
    appendFixtureCompletion(fixture, NATIVE_THREAD_ID);
    const pendingTurn = listConversations(fixture.storeDir).find((turn) =>
      turn.turn_id === pendingOutput.turn_id
    );
    assert.ok(pendingTurn);
    const monitored = await runCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      String(pendingTurn.state_path),
      "--log",
      String(pendingTurn.event_log_path),
      ...codexNoRolloutStoreArgs(fixture),
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "1",
      "--agent-hard-timeout-minutes",
      "2"
    ], codexNativeAcceptanceEnv(fixture.environment));
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const finalTurn = listConversations(fixture.storeDir).find((turn) =>
      turn.turn_id === pendingOutput.turn_id
    );
    assert.ok(finalTurn);
    assert.equal(finalTurn.status, "idle");
    assert.equal(finalTurn.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      loadManagedSession(fixture.storeDir, String(pendingOutput.session_id))
        .binding?.native_thread_id,
      NATIVE_THREAD_ID
    );
    assertSingleTaskInput(fixture, message);
  } finally {
    fixture.cleanup();
  }
});

test("source-less human Send with a stable id makes multiple exact candidate matches uncertain without redispatch", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Never guess between two source-less exact acceptors.";
  const messageId = `msg-openclaw-${"8".repeat(64)}`;
  try {
    enableFixtureCandidateInventory(fixture, [
      NATIVE_THREAD_ID,
      EXTERNAL_THREAD_ID
    ]);
    const terminal = await listFixtureTerminal(fixture);
    const action = assertTerminalUserExplicitSendAction(terminal);
    fixture.acceptanceNativeThreadIdsOnEnter = [
      NATIVE_THREAD_ID,
      EXTERNAL_THREAD_ID
    ];
    const args = [
      ...userExplicitDeferredForegroundSendArgs(fixture, action, message),
      "--message-id",
      messageId
    ];
    const sent = await runCli(
      args,
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true, sent.stdout);
    assert.equal(output.terminal_input_dispatched, true, sent.stdout);
    assert.equal(output.agent_acceptance, "unproven", sent.stdout);
    assert.equal(output.status, "submission_uncertain");
    assert.equal(output.submission_outcome, "uncertain");
    assert.equal(output.do_not_retry, true);
    assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
    assertSingleTaskInput(fixture, message);

    const replay = await runCli(
      args,
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    const replayOutput = JSON.parse(replay.stdout);
    assert.equal(replayOutput.replayed, true, replay.stdout);
    assert.equal(replayOutput.delivered, true, replay.stdout);
    assert.equal(replayOutput.terminal_input_dispatched, true, replay.stdout);
    assert.equal(replayOutput.agent_acceptance, "unproven", replay.stdout);
    assert.equal(
      replayOutput.status,
      "submission_pending_acceptance",
      replay.stdout
    );
    assert.equal(
      replayOutput.submission_outcome,
      "pending_acceptance",
      replay.stdout
    );
    assert.equal(replayOutput.delivery_receipt, "enter_dispatched", replay.stdout);
    assert.equal(replayOutput.do_not_retry, true, replay.stdout);
    assert.equal(replayOutput.management_mode, "managed", replay.stdout);
    assert.equal(replayOutput.message_id, messageId, replay.stdout);
    assertSingleTaskInput(fixture, message);
  } finally {
    fixture.cleanup();
  }
});

for (const routeCase of ["exact_selector", "unique_delegate"] as const) {
  test(`managed rollout-backed ${routeCase} without a token uses v3 candidate attribution`, async () => {
    const fixture = createNoRolloutFixture({
      codexVersion: "0.147.0",
      terminalKind: "herdr",
      viewportColumns: 55,
      ttyViewportColumns: 52
    });
    const message = routeCase === "exact_selector"
      ? "Route this exact raw selector through same-root v3 attribution."
      : "Route this unique untargeted delegate through fresh-root v3 attribution.";
    const acceptedNativeThreadId = routeCase === "exact_selector"
      ? NATIVE_THREAD_ID
      : EXTERNAL_THREAD_ID;
    try {
      enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
      const source = persistExactEndedRolloutSession(
        fixture,
        `session-managed-no-token-${routeCase}`
      );
      fixture.acceptanceNativeThreadIdsOnEnter = [acceptedNativeThreadId];

      const args = routeCase === "exact_selector"
        ? [
            "send",
            "--conversation",
            fixture.terminalId,
            "--message",
            message,
            "--background",
            "--store-dir",
            fixture.storeDir,
            "--codex-home",
            fs.realpathSync(fixture.codexHome),
            "--openclaw-bin",
            "/usr/bin/true",
            "--disable-terminal-bridge-monitor"
          ]
        : [
            "delegate",
            "--request",
            message,
            "--store-dir",
            fixture.storeDir,
            "--codex-home",
            fs.realpathSync(fixture.codexHome),
            "--openclaw-bin",
            "/usr/bin/true",
            "--disable-terminal-bridge-monitor"
          ];
      assert.equal(args.includes("--expected-terminal-token"), false);
      if (routeCase === "unique_delegate") {
        for (const targetFlag of [
          "--conversation",
          "--session",
          "--agent",
          "--workspace"
        ]) {
          assert.equal(args.includes(targetFlag), false, targetFlag);
        }
      }
      const sent = await runCli(args, codexNativeAcceptanceEnv(fixture.environment));
      assert.equal(sent.status, 0, sent.stderr || sent.stdout);
      const output = JSON.parse(sent.stdout);
      assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);
      assert.notEqual(output.session_id, source.session_id);
      assert.equal(
        output.conversation.native_thread_id,
        acceptedNativeThreadId
      );
      const transfer = soleDeferredForegroundTransfer(fixture);
      assert.equal(transfer.status, "resolved");
      assert.equal(transfer.source_kind, "candidate_rollout_quiescent");
      assert.equal(transfer.source_rollout_authority ?? "present", "present");
      assert.equal(transfer.target_native_thread_id, acceptedNativeThreadId);
      const anchor = persistedCodexV3AcceptanceAnchor(
        fixture,
        String(output.turn_id)
      );
      assert.deepEqual(
        anchor.candidate_rollouts?.map(
          (candidate: Record<string, any>) => candidate.native_thread_id
        ),
        [NATIVE_THREAD_ID]
      );
      assert.equal(
        loadManagedSession(fixture.storeDir, source.session_id).status,
        "detached"
      );
      assert.equal(
        loadManagedSession(fixture.storeDir, String(output.session_id))
          .binding?.native_thread_id,
        acceptedNativeThreadId
      );
      assert.equal(
        readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
          call.args.includes("/status")
        ),
        false
      );
      assert.deepEqual(fixture.ttyViewportInspectionPids, []);
      assertSingleTaskInput(fixture, message);
    } finally {
      fixture.cleanup();
    }
  });
}

async function assertSafeAbortedRolloutDelegateRetry(
  abortCase: {
    failureEnv: Record<string, string>;
    expectedInputStage: "none" | "dispatch_started";
    failedLiteralAttempt: boolean;
  }
): Promise<void> {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    terminalKind: "herdr",
    viewportColumns: 55,
    ttyViewportColumns: 52
  });
  const message = "Retry this safe-aborted delegate only through fresh v3 authority.";
  const messageId = `msg-openclaw-${"7".repeat(64)}`;
  const gatewaySession = "agent:test:safe-aborted-rollout-delegate";
  const delegateArgs = [
    "delegate",
    "--request",
    message,
    "--message-id",
    messageId,
    "--openclaw-session",
    gatewaySession,
    "--gateway-method",
    "agent-knock-knock.callback",
    "--gateway-session",
    gatewaySession,
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome),
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ];
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-safe-aborted-rollout-delegate"
    );
    const bindingBefore = source.binding;
    assert.ok(bindingBefore);
    const action = await deferredForegroundSendAction(fixture);
    const firstSendArgs = [
      ...deferredForegroundSendArgs(fixture, action, message),
      "--message-id",
      messageId,
      "--openclaw-session",
      gatewaySession,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      gatewaySession
    ];
    const aborted = await runCli(firstSendArgs, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      ...abortCase.failureEnv
    });
    assert.equal(aborted.status, 0, aborted.stderr || aborted.stdout);
    const abortedOutput = JSON.parse(aborted.stdout);
    assert.equal(abortedOutput.delivered, false, aborted.stdout);
    assert.equal(abortedOutput.submission_outcome, "aborted");
    assert.equal(abortedOutput.safe_to_retry, true);
    assert.equal(abortedOutput.do_not_retry, false);
    assert.equal(abortedOutput.message.id, messageId);
    assert.notEqual(abortedOutput.session_id, source.session_id);

    const abortTransfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(abortTransfer.status, "abort_resolved");
    assert.equal(abortTransfer.input_stage, abortCase.expectedInputStage);
    assert.equal(abortTransfer.text_injected_at, undefined);
    assert.equal(abortTransfer.enter_dispatched_at, undefined);
    assert.equal(abortTransfer.agent_accepted_at, undefined);
    if (abortCase.failedLiteralAttempt) {
      assert.ok(abortTransfer.dispatch_started_at);
      assert.ok(abortTransfer.terminal_input_not_started_at);
    } else {
      assert.equal(abortTransfer.dispatch_started_at, undefined);
      assert.equal(abortTransfer.terminal_input_not_started_at, undefined);
    }
    assert.equal(abortTransfer.source_kind, "candidate_rollout_quiescent");
    assert.equal(
      abortTransfer.source_rollout_authority ?? "present",
      "present"
    );
    assert.equal(abortTransfer.source_session_id, source.session_id);
    assert.equal(abortTransfer.target_session_id, abortedOutput.session_id);
    assert.equal(abortTransfer.abort_source_after_status, "bound");
    assert.equal(abortTransfer.abort_target_after_status, "detached");
    assert.ok(abortTransfer.abort_cleanup_completed_at);
    const sourceAfterAbort = loadManagedSession(
      fixture.storeDir,
      source.session_id
    );
    assert.equal(sourceAfterAbort.status, "bound");
    assert.deepEqual(
      sourceAfterAbort.binding,
      JSON.parse(JSON.stringify(bindingBefore)),
      "zero-input cleanup restores the exact persisted status-card binding"
    );
    const firstTargetAfterAbort = loadManagedSession(
      fixture.storeDir,
      abortTransfer.target_session_id
    );
    assert.equal(firstTargetAfterAbort.status, "detached");
    assert.equal(firstTargetAfterAbort.binding?.native_thread_id, undefined);
    assert.equal(
      firstTargetAfterAbort.binding?.native_process.rollout,
      undefined
    );
    const abortedTurnId = String(abortedOutput.turn_id);
    const abortedTurn = listConversations(fixture.storeDir).find((turn) =>
      turn.turn_id === abortedTurnId
    );
    assert.ok(abortedTurn);
    assert.equal(abortedTurn.status, "failed");
    assert.equal(abortedTurn.gateway_method, "agent-knock-knock.callback");
    assert.equal(abortedTurn.gateway_session, gatewaySession);
    const abortedSubmission = (
      abortedTurn.native_session_takeover as Record<string, any>
    ).terminal_bridge_submission;
    assert.equal(abortedSubmission.message_id, messageId);
    assert.equal(abortedSubmission.status, "aborted");
    assert.equal(abortedSubmission.safe_to_retry, true);
    assert.ok(abortedSubmission.aborted_at);
    assert.equal(abortedSubmission.text_injected_at, undefined);
    assert.equal(abortedSubmission.enter_dispatched_at, undefined);
    assert.equal(abortedSubmission.submitted_at, undefined);
    assert.equal(abortedSubmission.agent_accepted_at, undefined);
    assert.equal(abortedSubmission.acceptance_evidence, undefined);
    const abortedLedger = readSoleTerminalDispatchLedger(fixture);
    assert.equal(abortedLedger.status, "resolved");
    assert.equal(abortedLedger.safe_to_retry, true);
    assert.equal(abortedLedger.callback_expected, true);
    assert.equal(abortedLedger.text_injected_at, undefined);
    assert.equal(abortedLedger.enter_dispatched_at, undefined);
    assert.equal(abortedLedger.submitted_at, undefined);
    assert.equal(abortedLedger.agent_accepted_at, undefined);
    assert.equal(abortedLedger.acceptance_evidence, undefined);
    if (abortCase.failedLiteralAttempt) {
      assert.equal(
        abortTransfer.terminal_input_not_started_at,
        abortedSubmission.aborted_at
      );
      assert.equal(abortedLedger.aborted_at, abortedSubmission.aborted_at);
      assert.deepEqual(
        taskInputCalls(fixture, message).map((call) => call.args),
        [["send-keys", "-t", fixture.inputTarget, "-l", message]]
      );
    } else {
      assert.deepEqual(taskInputCalls(fixture, message), []);
    }
    assert.equal(
      taskInputCalls(fixture, message).filter((call) =>
        call.args.at(-1) === "C-m"
      ).length,
      0
    );

    fixture.acceptanceNativeThreadIdsOnEnter = [NATIVE_THREAD_ID];
    const retried = await runCli(
      delegateArgs,
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    const output = JSON.parse(retried.stdout);
    assert.equal(output.delivery_receipt, "agent_accepted", retried.stdout);
    assert.equal(output.message.id, messageId);
    assert.notEqual(output.turn_id, abortedTurnId);
    assert.notEqual(output.session_id, source.session_id);
    assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      output.conversation.gateway_method,
      "agent-knock-knock.callback"
    );
    assert.equal(output.conversation.gateway_session, gatewaySession);

    const anchor = persistedCodexV3AcceptanceAnchor(
      fixture,
      String(output.turn_id)
    );
    assert.deepEqual(
      anchor.candidate_rollouts.map(
        (candidate: Record<string, any>) => candidate.native_thread_id
      ),
      [NATIVE_THREAD_ID]
    );
    const transfers = listDeferredForegroundTransfers(fixture.storeDir);
    assert.equal(transfers.length, 2, JSON.stringify(transfers, null, 2));
    const preservedAbort = transfers.find((candidate) =>
      candidate.transfer_id === abortTransfer.transfer_id
    );
    assert.deepEqual(preservedAbort, abortTransfer);
    const transfer = transfers.find((candidate) =>
      candidate.turn_id === output.turn_id
    );
    assert.ok(transfer, JSON.stringify(transfers, null, 2));
    assert.equal(transfer.status, "resolved");
    assert.equal(transfer.source_kind, "candidate_rollout_quiescent");
    assert.equal(transfer.source_rollout_authority ?? "present", "present");
    assert.equal(transfer.source_session_id, source.session_id);
    assert.equal(transfer.target_native_thread_id, NATIVE_THREAD_ID);
    assert.notEqual(transfer.target_session_id, abortTransfer.target_session_id);
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "detached"
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, String(output.session_id))
        .binding?.native_thread_id,
      NATIVE_THREAD_ID
    );
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
        call.args.includes("/status")
      ),
      false
    );
    assert.deepEqual(fixture.ttyViewportInspectionPids, []);
    const finalTaskCalls = taskInputCalls(fixture, message);
    assert.equal(
      finalTaskCalls.filter((call) => call.args.at(-1) === "C-m").length,
      1
    );
    assert.equal(
      finalTaskCalls.filter((call) =>
        call.args.includes("-l") && call.args.at(-1) === message
      ).length,
      abortCase.failedLiteralAttempt ? 2 : 1
    );
    assert.deepEqual(finalTaskCalls.slice(-2).map((call) => call.args), [
      ["send-keys", "-t", fixture.inputTarget, "-l", message],
      ["send-keys", "-t", fixture.inputTarget, "C-m"]
    ]);
  } finally {
    fixture.cleanup();
  }
}

test("safe-aborted unchanged rollout-backed delegate retries the same message id through v3", async () => {
  await assertSafeAbortedRolloutDelegateRetry({
    failureEnv: { AKK_TEST_TERMINAL_SETUP_FAILURE: "1" },
    expectedInputStage: "none",
    failedLiteralAttempt: false
  });
});

test("safe-aborted text-dispatch failure retries the same message id through v3", async () => {
  await assertSafeAbortedRolloutDelegateRetry({
    failureEnv: { AKK_TEST_TMUX_TEXT_FAILURE: "1" },
    expectedInputStage: "dispatch_started",
    failedLiteralAttempt: true
  });
});

async function assertSafeAbortedStatusCardDelegateRetry(
  abortCase: {
    failureEnv: Record<string, string>;
    expectedInputStage: "none" | "dispatch_started";
    failedLiteralAttempt: boolean;
  }
): Promise<void> {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    rolloutInitiallyAbsent: true
  });
  const message =
    "Retry this safe-aborted status-card delegate through its restored source.";
  const messageId = `msg-openclaw-${"8".repeat(64)}`;
  const gatewaySession = "agent:test:safe-aborted-status-card-delegate";
  const delegateArgs = [
    "delegate",
    "--request",
    message,
    "--message-id",
    messageId,
    "--openclaw-session",
    gatewaySession,
    "--gateway-method",
    "agent-knock-knock.callback",
    "--gateway-session",
    gatewaySession,
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome),
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ];
  try {
    const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const bindingBefore = source.binding;
    assert.ok(bindingBefore);
    assert.equal(bindingBefore.native_process.rollout, undefined);
    const action = await deferredForegroundSendAction(fixture);
    const firstSendArgs = [
      ...deferredForegroundSendArgs(fixture, action, message),
      "--message-id",
      messageId,
      "--openclaw-session",
      gatewaySession,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      gatewaySession
    ];

    const aborted = await runCli(firstSendArgs, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      ...abortCase.failureEnv
    });
    assert.equal(aborted.status, 0, aborted.stderr || aborted.stdout);
    const abortedOutput = JSON.parse(aborted.stdout);
    assert.equal(abortedOutput.delivered, false, aborted.stdout);
    assert.equal(abortedOutput.submission_outcome, "aborted");
    assert.equal(abortedOutput.safe_to_retry, true);
    assert.equal(abortedOutput.do_not_retry, false);
    assert.equal(abortedOutput.message.id, messageId);
    assert.notEqual(abortedOutput.session_id, source.session_id);

    const abortTransfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(abortTransfer.status, "abort_resolved");
    assert.equal(abortTransfer.input_stage, abortCase.expectedInputStage);
    assert.equal(abortTransfer.source_kind, "status_card_only");
    assert.equal(abortTransfer.source_session_id, source.session_id);
    assert.equal(abortTransfer.target_session_id, abortedOutput.session_id);
    assert.equal(abortTransfer.text_injected_at, undefined);
    assert.equal(abortTransfer.enter_dispatched_at, undefined);
    assert.equal(abortTransfer.agent_accepted_at, undefined);
    assert.equal(abortTransfer.abort_source_after_status, "bound");
    assert.equal(abortTransfer.abort_target_after_status, "detached");
    assert.ok(abortTransfer.abort_cleanup_completed_at);
    if (abortCase.failedLiteralAttempt) {
      assert.ok(abortTransfer.dispatch_started_at);
      assert.ok(abortTransfer.terminal_input_not_started_at);
    } else {
      assert.equal(abortTransfer.dispatch_started_at, undefined);
      assert.equal(abortTransfer.terminal_input_not_started_at, undefined);
    }

    const sourceAfterAbort = loadManagedSession(
      fixture.storeDir,
      source.session_id
    );
    assert.equal(sourceAfterAbort.status, "bound");
    assert.deepEqual(
      sourceAfterAbort.binding,
      JSON.parse(JSON.stringify(bindingBefore)),
      "zero-input cleanup restores the exact persisted status-card binding"
    );
    const targetAfterAbort = loadManagedSession(
      fixture.storeDir,
      abortTransfer.target_session_id
    );
    assert.equal(targetAfterAbort.status, "detached");
    assert.equal(targetAfterAbort.binding?.native_thread_id, undefined);
    assert.equal(targetAfterAbort.binding?.native_process.rollout, undefined);

    const abortedTurnId = String(abortedOutput.turn_id);
    const abortedTurn = listConversations(fixture.storeDir).find((turn) =>
      turn.turn_id === abortedTurnId
    );
    assert.ok(abortedTurn);
    assert.equal(abortedTurn.status, "failed");
    assert.equal(abortedTurn.session_id, abortTransfer.target_session_id);
    assert.notEqual(abortedTurn.session_id, source.session_id);
    assert.equal(abortedTurn.gateway_method, "agent-knock-knock.callback");
    assert.equal(abortedTurn.gateway_session, gatewaySession);
    const abortedSubmission = (
      abortedTurn.native_session_takeover as Record<string, any>
    ).terminal_bridge_submission;
    assert.equal(abortedSubmission.message_id, messageId);
    assert.equal(abortedSubmission.status, "aborted");
    assert.equal(abortedSubmission.safe_to_retry, true);
    assert.equal(abortedSubmission.text_injected_at, undefined);
    assert.equal(abortedSubmission.enter_dispatched_at, undefined);
    assert.equal(abortedSubmission.agent_accepted_at, undefined);
    const abortedLedger = readSoleTerminalDispatchLedger(fixture);
    assert.equal(abortedLedger.status, "resolved");
    assert.equal(abortedLedger.safe_to_retry, true);
    assert.equal(abortedLedger.callback_expected, true);
    assert.equal(abortedLedger.text_injected_at, undefined);
    assert.equal(abortedLedger.enter_dispatched_at, undefined);
    assert.equal(abortedLedger.agent_accepted_at, undefined);
    if (abortCase.failedLiteralAttempt) {
      assert.equal(
        abortTransfer.terminal_input_not_started_at,
        abortedSubmission.aborted_at
      );
      assert.equal(abortedLedger.aborted_at, abortedSubmission.aborted_at);
      assert.deepEqual(
        taskInputCalls(fixture, message).map((call) => call.args),
        [["send-keys", "-t", fixture.inputTarget, "-l", message]]
      );
    } else {
      assert.deepEqual(taskInputCalls(fixture, message), []);
    }
    assert.equal(
      taskInputCalls(fixture, message).filter((call) =>
        call.args.at(-1) === "C-m"
      ).length,
      0
    );

    const retried = await runCli(
      delegateArgs,
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    const output = JSON.parse(retried.stdout);
    assert.equal(output.delivery_receipt, "agent_accepted", retried.stdout);
    assert.equal(output.message.id, messageId);
    assert.notEqual(output.turn_id, abortedTurnId);
    assert.notEqual(output.session_id, source.session_id);
    assert.notEqual(output.session_id, abortTransfer.target_session_id);
    assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      output.conversation.gateway_method,
      "agent-knock-knock.callback"
    );
    assert.equal(output.conversation.gateway_session, gatewaySession);
    const transfers = listDeferredForegroundTransfers(fixture.storeDir);
    assert.equal(transfers.length, 2, JSON.stringify(transfers, null, 2));
    const preservedAbort = transfers.find((candidate) =>
      candidate.transfer_id === abortTransfer.transfer_id
    );
    assert.deepEqual(preservedAbort, abortTransfer);
    const transfer = transfers.find((candidate) =>
      candidate.turn_id === output.turn_id
    );
    assert.ok(transfer, JSON.stringify(transfers, null, 2));
    assert.equal(transfer.status, "resolved");
    assert.equal(transfer.source_kind, "status_card_only");
    assert.equal(transfer.source_session_id, source.session_id);
    assert.equal(transfer.target_session_id, output.session_id);
    assert.equal(transfer.target_native_thread_id, NATIVE_THREAD_ID);
    assert.notEqual(transfer.target_session_id, abortTransfer.target_session_id);
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "detached"
    );
    const acceptedTarget = loadManagedSession(
      fixture.storeDir,
      String(output.session_id)
    );
    assert.equal(acceptedTarget.status, "bound");
    assert.equal(acceptedTarget.binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.ok(acceptedTarget.binding?.native_process.rollout);
    assert.equal(
      loadManagedSession(
        fixture.storeDir,
        abortTransfer.target_session_id
      ).status,
      "detached"
    );

    const replayed = await runCli(
      delegateArgs,
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
    const replayedOutput = JSON.parse(replayed.stdout);
    assert.equal(replayedOutput.replayed, true, replayed.stdout);
    assert.equal(replayedOutput.delivered, true, replayed.stdout);
    assert.equal(replayedOutput.terminal_input_dispatched, true);
    assert.equal(replayedOutput.agent_acceptance, "unproven");
    assert.equal(replayedOutput.status, "submission_pending_acceptance");
    assert.equal(replayedOutput.submission_outcome, "pending_acceptance");
    assert.equal(replayedOutput.delivery_receipt, "enter_dispatched");
    assert.equal(replayedOutput.do_not_retry, true);
    assert.equal(replayedOutput.management_mode, "managed");
    assert.equal(replayedOutput.scope, "terminal_user_explicit");
    assert.equal(replayedOutput.message_id, messageId);
    assert.equal(replayedOutput.session_id, undefined);
    assert.equal(replayedOutput.turn_id, undefined);
    assert.deepEqual(
      listDeferredForegroundTransfers(fixture.storeDir),
      transfers,
      "delegate intent replay must not create another managed transfer"
    );

    const finalTaskCalls = taskInputCalls(fixture, message);
    assert.equal(
      finalTaskCalls.filter((call) => call.args.at(-1) === "C-m").length,
      1,
      "the accepted provisional retry dispatches the task Enter exactly once"
    );
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
        call.args.includes("-l") && call.args.at(-1) === "/status"
      ).length,
      0,
      "durable status-card authority does not require a native /status probe"
    );
    assert.equal(
      finalTaskCalls.filter((call) =>
        call.args.includes("-l") && call.args.at(-1) === message
      ).length,
      abortCase.failedLiteralAttempt ? 2 : 1
    );
    assert.deepEqual(finalTaskCalls.slice(-2).map((call) => call.args), [
      ["send-keys", "-t", fixture.inputTarget, "-l", message],
      ["send-keys", "-t", fixture.inputTarget, "C-m"]
    ]);
  } finally {
    fixture.cleanup();
  }
}

test("safe-aborted status-card setup failure retries the same delegate message once", async () => {
  await assertSafeAbortedStatusCardDelegateRetry({
    failureEnv: { AKK_TEST_TERMINAL_SETUP_FAILURE: "1" },
    expectedInputStage: "none",
    failedLiteralAttempt: false
  });
});

test("safe-aborted status-card text failure retries the same delegate message once", async () => {
  await assertSafeAbortedStatusCardDelegateRetry({
    failureEnv: { AKK_TEST_TMUX_TEXT_FAILURE: "1" },
    expectedInputStage: "dispatch_started",
    failedLiteralAttempt: true
  });
});

test("a listed visible clear hint may disappear before token send while exact inventory stays unchanged", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    terminalKind: "herdr",
    viewportColumns: 55,
    ttyViewportColumns: 52
  });
  const message = "Use the pinned inventory after the diagnostic clear hint scrolls away.";
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-visible-hint-disappears"
    );
    const wrappedResumeFirstLine =
      `To continue this session, run codex resume ${NATIVE_THREAD_ID.slice(0, 9)}`;
    assert.equal([...wrappedResumeFirstLine].length, 52);
    fs.writeFileSync(fixture.screenPath, [
      wrappedResumeFirstLine,
      NATIVE_THREAD_ID.slice(9),
      "",
      "› \u001b[2mAsk Codex anything\u001b[0m",
      CODEX_TEST_COMPOSER_FOOTER
    ].join("\n"));

    const action = await deferredForegroundSendAction(fixture);
    assert.ok(
      fixture.runtimeLogs.some((entry) =>
        entry.event === "terminal_codex_latent_clear_hint_observed" &&
        entry.fields.source_session_id === source.session_id &&
        entry.fields.source_native_thread_id === NATIVE_THREAD_ID
      ),
      JSON.stringify(fixture.runtimeLogs, null, 2)
    );

    // The hint is diagnostic and transient. The exact rollout inventory and
    // every durable source fence remain unchanged between list and send.
    fs.writeFileSync(
      fixture.screenPath,
      "Ready after scrollback advanced\n› \u001b[2mAsk Codex anything\u001b[0m\n" +
      CODEX_TEST_COMPOSER_FOOTER
    );
    fixture.acceptanceNativeThreadIdsOnEnter = [EXTERNAL_THREAD_ID];
    const sent = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);
    assert.equal(output.conversation.native_thread_id, EXTERNAL_THREAD_ID);
    const transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "resolved");
    assert.equal(transfer.source_kind, "candidate_rollout_quiescent");
    assert.equal(transfer.source_rollout_authority ?? "present", "present");
    assert.equal(transfer.target_native_thread_id, EXTERNAL_THREAD_ID);
    const anchor = persistedCodexV3AcceptanceAnchor(
      fixture,
      String(output.turn_id)
    );
    assert.deepEqual(
      anchor.candidate_rollouts?.map(
        (candidate: Record<string, any>) => candidate.native_thread_id
      ),
      [NATIVE_THREAD_ID]
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "detached"
    );
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
        call.args.includes("/status")
      ),
      false
    );
    assert.deepEqual(fixture.ttyViewportInspectionPids, []);
    assertSingleTaskInput(fixture, message);
  } finally {
    fixture.cleanup();
  }
});

test("rollout-backed strict Session send rejects before input and directs callers to refresh list", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    terminalKind: "herdr",
    viewportColumns: 55,
    ttyViewportColumns: 52
  });
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-rollout-backed-strict-rejected"
    );
    const beforeSessions = listManagedSessions(fixture.storeDir);
    const ledgerDir = path.join(
      String(fixture.environment.AKK_RUNTIME_DIR),
      "terminal-dispatch"
    );
    const beforeLedgerPaths = fs.existsSync(ledgerDir)
      ? fs.readdirSync(ledgerDir).sort()
      : [];
    const sent = await runCli([
      "send",
      "--session",
      source.session_id,
      "--message",
      "A stale strict caller must refresh before this task is injected.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], fixture.environment);
    assert.equal(sent.status, 1, sent.stdout);
    assert.match(sent.stderr, /refresh.*list|list.*selector|follow-current/iu);
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);
    assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
    assert.deepEqual(listManagedSessions(fixture.storeDir), beforeSessions);
    assert.deepEqual(
      fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).sort() : [],
      beforeLedgerPaths
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "bound"
    );
  } finally {
    fixture.cleanup();
  }
});

test("explicit close of a v1 uncertain clear dispatch restores only future candidate send", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const lostMessage = "This task crosses the latent clear boundary.";
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-closed-latent-clear-source"
    );
    // Preserve an exact v0.12.6-era v1 uncertain dispatch as migration input.
    // New rollout-backed strict sends are rejected before terminal input, so
    // this recovery proof must not manufacture its predecessor through the
    // current send path.
    const turnId = persistLegacyV1UncertainTurn(
      fixture,
      source,
      lostMessage
    );
    const stalled = listConversations(fixture.storeDir).find((turn) =>
      turn.turn_id === turnId
    );
    assert.equal(stalled?.status, "stalled");
    assert.equal(
      (stalled?.native_session_takeover as Record<string, any>)
        .terminal_bridge_submission?.status,
      "uncertain"
    );

    const listedWhileStalled = await listFixtureTerminal(fixture);
    const blocking = listedWhileStalled.blocking_turns?.find(
      (turn: Record<string, any>) => turn.turn_id === turnId
    );
    assert.ok(blocking, JSON.stringify(listedWhileStalled, null, 2));
    assert.equal(listedWhileStalled.available_actions?.renew, undefined);
    const renewed = await runCli([
      "renew",
      "--turn",
      turnId,
      "--store-dir",
      fixture.storeDir
    ], fixture.environment);
    assert.equal(renewed.status, 1, renewed.stdout);
    assert.match(renewed.stderr, /submission is uncertain/iu);

    // The post-/clear rollout remains open while Codex has now closed the old
    // predecessor FD, matching the live recovery topology before the human
    // explicitly abandons the unattributed result.
    enableFixtureCandidateInventory(fixture, [EXTERNAL_THREAD_ID]);
    fixture.identityObservationError =
      "Codex process has an unexpected open root rollout outside the preferred and exact companion identities";
    fs.writeFileSync(
      fixture.screenPath,
      "Ready\n› \u001b[2mAsk Codex anything\u001b[0m\n" +
      CODEX_TEST_COMPOSER_FOOTER
    );

    const closed = await runCli([
      "close",
      "--turn",
      turnId,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    assert.equal(JSON.parse(closed.stdout).terminal_dispatch_resolved, true);
    const closedTurn = listConversations(fixture.storeDir).find((turn) =>
      turn.turn_id === turnId
    );
    assert.equal(closedTurn?.status, "closed");
    assert.equal(closedTurn?.callback_delivery, undefined);
    assert.equal(
      (closedTurn?.native_session_takeover as Record<string, any>)
        .terminal_bridge_submission?.status,
      "uncertain",
      "explicit close must not forge native acceptance or callback delivery"
    );

    fs.writeFileSync(
      fixture.screenPath,
      "Ready\nCompleted outside AKK attribution\n" +
      "› \u001b[2mAsk Codex anything\u001b[0m\n" +
      CODEX_TEST_COMPOSER_FOOTER
    );
    // Codex eventually closes the predecessor FD while retaining only the
    // post-/clear rollout. That current root already contains the lost task,
    // so the next candidate anchor must begin at its EOF and may safely prove
    // a repeated request only from a new append.
    const futureAction = await deferredForegroundSendAction(fixture);
    assert.equal(futureAction.arguments.selector, fixture.terminalId);
    assert.equal(
      typeof futureAction.arguments.expected_terminal_token,
      "string"
    );
    const listedAfterClose = await listFixtureTerminal(fixture);
    assert.equal(listedAfterClose.management_state, "conflict");
    assert.equal(
      listedAfterClose.management_conflict?.kind,
      "explicitly_abandoned_predecessor_adoptable"
    );
    assert.equal(listedAfterClose.managed.session_id, null);

    fixture.acceptanceNativeThreadIdsOnEnter = [EXTERNAL_THREAD_ID];
    const recovered = await runCli(
      deferredForegroundSendArgs(fixture, futureAction, lostMessage),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    const recoveredOutput = JSON.parse(recovered.stdout);
    assert.equal(recoveredOutput.delivery_receipt, "agent_accepted");
    assert.equal(
      recoveredOutput.conversation.native_thread_id,
      EXTERNAL_THREAD_ID
    );
    const recoveredAnchor = persistedCodexV3AcceptanceAnchor(
      fixture,
      String(recoveredOutput.turn_id)
    );
    assert.deepEqual(
      recoveredAnchor.candidate_rollouts?.map(
        (candidate: Record<string, any>) => candidate.native_thread_id
      ),
      [EXTERNAL_THREAD_ID]
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "detached"
    );
    const recoveredSession = loadManagedSession(
      fixture.storeDir,
      String(recoveredOutput.session_id)
    );
    assert.equal(recoveredSession.status, "bound");
    assert.equal(
      recoveredSession.binding?.native_thread_id,
      EXTERNAL_THREAD_ID
    );
    const transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "resolved");
    assert.equal(
      transfer.source_rollout_authority,
      "explicitly_abandoned_predecessor"
    );
    assert.match(
      String(transfer.source_abandonment_fingerprint),
      /^[0-9a-f]{64}$/u
    );
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
        call.args.includes("/status")
      ),
      false
    );
    assert.deepEqual(taskInputCalls(fixture, lostMessage).map((call) => call.args), [
      ["send-keys", "-t", fixture.inputTarget, "-l", lostMessage],
      ["send-keys", "-t", fixture.inputTarget, "C-m"]
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("abandoned predecessor candidate token fails closed when exact authority drifts", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Do not send after abandoned predecessor authority drift.";
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-abandoned-drift-source"
    );
    const turnId = persistLegacyV1UncertainTurn(fixture, source, message);
    enableFixtureCandidateInventory(fixture, [EXTERNAL_THREAD_ID]);
    fixture.identityObservationError =
      "Codex process has an unexpected open root rollout outside the preferred and exact companion identities";
    fs.writeFileSync(
      fixture.screenPath,
      "Ready\n› \u001b[2mAsk Codex anything\u001b[0m\n" +
      CODEX_TEST_COMPOSER_FOOTER
    );
    const closed = await runCli([
      "close", "--turn", String(turnId), "--store-dir", fixture.storeDir,
      "--codex-home", fixture.codexHome
    ], fixture.environment);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    const inventoryBoundAction = await deferredForegroundSendAction(fixture);
    const inputsBefore = taskInputCalls(fixture).map((call) => call.args);

    enableFixtureCandidateInventory(fixture, [
      EXTERNAL_THREAD_ID,
      SECOND_EXTERNAL_THREAD_ID
    ]);
    const inventoryDrift = await runCli(
      deferredForegroundSendArgs(fixture, inventoryBoundAction, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(inventoryDrift.status, 1, inventoryDrift.stdout);
    assert.match(
      inventoryDrift.stderr,
      /token|inventory|authority|refresh/iu
    );
    assert.deepEqual(
      taskInputCalls(fixture).map((call) => call.args),
      inputsBefore
    );

    enableFixtureCandidateInventory(fixture, [EXTERNAL_THREAD_ID]);
    const action = await deferredForegroundSendAction(fixture);

    const ledgerPath = soleTerminalDispatchLedgerPath(fixture);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    ledger.request_hash = "f".repeat(64);
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

    const rejected = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(
      rejected.stderr,
      /token|authority|abandon|dispatch|refresh/iu
    );
    assert.deepEqual(
      taskInputCalls(fixture).map((call) => call.args),
      inputsBefore
    );
  } finally {
    fixture.cleanup();
  }
});

test("a detached candidate claim cannot hide user-priority physical Send", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Keep detached candidate ownership fail closed.";
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-abandoned-claimed-source"
    );
    const turnId = persistLegacyV1UncertainTurn(fixture, source, message);
    enableFixtureCandidateInventory(fixture, [EXTERNAL_THREAD_ID]);
    fixture.identityObservationError = "fixture unavailable foreground";
    fs.writeFileSync(
      fixture.screenPath,
      "Ready\n› \u001b[2mAsk Codex anything\u001b[0m\n" +
      CODEX_TEST_COMPOSER_FOOTER
    );
    const closed = await runCli([
      "close", "--turn", turnId,
      "--store-dir", fixture.storeDir, "--codex-home", fixture.codexHome
    ], fixture.environment);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    persistDetachedRolloutCompanion(
      fixture,
      EXTERNAL_THREAD_ID,
      "session-detached-current-candidate"
    );
    const listed = await listFixtureTerminal(fixture);
    assertTerminalUserExplicitSendAction(listed);
    assert.deepEqual(taskInputCalls(fixture, message), []);
  } finally {
    fixture.cleanup();
  }
});

test("closed detached Codex history does not force /status on a narrow candidate send", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    terminalKind: "herdr",
    viewportColumns: 54,
    ttyViewportColumns: 51
  });
  const message = "Continue on the one exact open Codex rollout.";
  try {
    enableFixtureCandidateInventory(fixture, [
      NATIVE_THREAD_ID,
      EXTERNAL_THREAD_ID,
      SECOND_EXTERNAL_THREAD_ID
    ]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-single-open-root-with-closed-history"
    );
    const sourceBindingId = source.binding?.binding_id;
    const sourceGeneration = source.binding?.generation;
    assert.ok(sourceBindingId);
    assert.ok(sourceGeneration);
    const firstHistorical = persistDetachedRolloutCompanion(
      fixture,
      EXTERNAL_THREAD_ID,
      "session-closed-detached-history-one"
    );
    const secondHistorical = persistDetachedRolloutCompanion(
      fixture,
      SECOND_EXTERNAL_THREAD_ID,
      "session-closed-detached-history-two"
    );
    // Keep the historical rollout files and Store bindings, but model the
    // physical Codex process after those roots have closed their descriptors.
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);

    const terminal = await listFixtureTerminal(fixture);
    const action = terminal.available_actions.send;
    assert.ok(action, JSON.stringify(terminal, null, 2));
    assert.equal(action.arguments.selector, fixture.terminalId);
    assert.equal("session_id" in action.arguments, false);
    assert.equal(typeof action.arguments.expected_terminal_token, "string");

    fixture.acceptanceNativeThreadIdsOnEnter = [NATIVE_THREAD_ID];
    const sent = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.notEqual(output.session_id, source.session_id);
    assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
    const transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "resolved");
    assert.equal(transfer.source_kind, "candidate_rollout_quiescent");
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
        call.args.includes("/status")
      ),
      false
    );
    assert.deepEqual(fixture.ttyViewportInspectionPids, []);
    assertSingleTaskInput(fixture, message);
    const anchor = persistedCodexV3AcceptanceAnchor(
      fixture,
      String(output.turn_id)
    );
    assert.deepEqual(
      anchor.candidate_rollouts.map(
        (candidate: Record<string, any>) => candidate.native_thread_id
      ),
      [NATIVE_THREAD_ID]
    );
    assertResolvedSameUuidDeferredTransfer({
      fixture,
      sourceSessionId: source.session_id,
      originalBindingId: sourceBindingId,
      originalGeneration: sourceGeneration
    });
    assert.equal(
      loadManagedSession(fixture.storeDir, firstHistorical.session_id).status,
      "detached"
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, secondHistorical.session_id).status,
      "detached"
    );
  } finally {
    fixture.cleanup();
  }
});

test("known detached companion roots use the terminal-scoped human-priority route", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    terminalKind: "herdr",
    viewportColumns: 54,
    ttyViewportColumns: 51
  });
  const message = "Route this task without probing the narrow status card.";
  try {
    enableFixtureCandidateInventory(fixture, [
      NATIVE_THREAD_ID,
      EXTERNAL_THREAD_ID
    ]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-known-companion-source"
    );
    persistReleasedCandidateSourceTurns(fixture, source);
    persistDetachedRolloutCompanion(
      fixture,
      EXTERNAL_THREAD_ID,
      "session-known-detached-companion"
    );
    fixture.acceptanceNativeThreadIdsOnEnter = [NATIVE_THREAD_ID];

    const terminal = await listFixtureTerminal(fixture);
    assert.equal(
      terminal.native_agent_identity_observation.status,
      "resolved"
    );
    assert.equal(
      terminal.native_agent_session_id,
      NATIVE_THREAD_ID
    );
    const action = terminal.available_actions.send;
    assert.ok(action, JSON.stringify(terminal, null, 2));
    assert.equal(action.arguments.selector, fixture.terminalId);
    assert.equal("session_id" in action.arguments, false);
    assert.equal(typeof action.arguments.expected_terminal_token, "string");

    const sent = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true, sent.stdout);
    assert.notEqual(output.session_id, source.session_id);
    assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      soleDeferredForegroundTransfer(fixture).source_kind,
      "candidate_rollout_quiescent"
    );
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
        call.args.includes("/status")
      ),
      false
    );
    assert.deepEqual(fixture.ttyViewportInspectionPids, []);
    assertSingleTaskInput(fixture, message);
  } finally {
    fixture.cleanup();
  }
});

test("a non-companion bound candidate claim cannot hide or stale user-priority physical Send", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Do not cross a competing bound candidate claim.";
  try {
    enableFixtureCandidateInventory(fixture, [
      NATIVE_THREAD_ID,
      EXTERNAL_THREAD_ID
    ]);
    persistExactEndedRolloutSession(
      fixture,
      "session-present-multi-root-source"
    );
    const cachedAction = await deferredForegroundSendAction(fixture);
    const detachedClaim = persistDetachedRolloutCompanion(
      fixture,
      EXTERNAL_THREAD_ID,
      "session-competing-bound-candidate"
    );
    const {
      detached_at: _detachedAt,
      ...claimWithoutDetachedAt
    } = detachedClaim;
    saveManagedSession(fixture.storeDir, {
      ...claimWithoutDetachedAt,
      status: "bound",
      updated_at: new Date().toISOString()
    }, { expectedRevision: detachedClaim.revision as number });

    const listed = await listFixtureTerminal(fixture);
    const currentAction = assertTerminalUserExplicitSendAction(listed);
    assert.equal(
      currentAction.arguments.expected_terminal_token,
      cachedAction.arguments.expected_terminal_token,
      "managed claim changes must not stale unchanged physical authority"
    );
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);

    const sent = await runCli(
      userExplicitDeferredForegroundSendArgs(
        fixture,
        cachedAction,
        message
      ),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true, sent.stdout);
    assert.equal(output.delivered_unmanaged, true, sent.stdout);
    assert.equal(output.management_mode, "unmanaged", sent.stdout);
    assert.equal(
      output.legacy_management_mode,
      "unmanaged_fallback",
      sent.stdout
    );
    assertSingleTaskInput(fixture, message);
    assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);
  } finally {
    fixture.cleanup();
  }
});

test("a stalled Turn remains visible but cannot suppress user-priority physical Send", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-candidate-blocking-turn"
    );
    persistReleasedCandidateSourceTurns(fixture, source);
    persistBlockingTurn(fixture, source, "stalled");
    const terminal = await listFixtureTerminal(fixture);
    assertTerminalUserExplicitSendAction(terminal);
    assert.ok(
      terminal.blocking_turns?.some((turn: Record<string, any>) =>
        turn.status === "stalled"
      ),
      JSON.stringify(terminal, null, 2)
    );
    assert.deepEqual(taskInputCalls(fixture), []);
  } finally {
    fixture.cleanup();
  }
});
