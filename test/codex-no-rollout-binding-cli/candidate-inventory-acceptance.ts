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

test("an accepted deferred Turn recovers before Session commit without replay", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    rolloutInitiallyAbsent: true
  });
  const message = "Recover an accepted Turn before deferred Session commit.";
  try {
    const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const originalBinding = source.binding;
    const action = await deferredForegroundSendAction(fixture);
    const args = deferredForegroundSendArgs(fixture, action, message);
    const afterEnter = await runCliCrashCheckpoint(args, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_EXIT_AFTER_VIRGIN_ENTER_DISPATCHED: "1"
    });
    assert.equal(afterEnter.status, 86, afterEnter.stderr || afterEnter.stdout);
    assertSingleTaskInput(fixture, message);

    const afterAcceptedTurn = await runCliCrashCheckpoint(args, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_EXIT_AFTER_DEFERRED_ACCEPTED_TURN: "1"
    });
    assert.equal(
      afterAcceptedTurn.status,
      86,
      afterAcceptedTurn.stderr || afterAcceptedTurn.stdout
    );
    assert.equal(soleDeferredForegroundTransfer(fixture).status, "dispatch_started");
    const acceptedTurn = listConversations(fixture.storeDir)[0];
    assert.equal(acceptedTurn.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      (acceptedTurn.native_session_takeover as Record<string, any>)
        .terminal_bridge_submission?.status,
      "agent_accepted"
    );
    assertSingleTaskInput(fixture, message);

    const recovered = await runCli(args, codexNativeAcceptanceEnv(fixture.environment));
    assertRecoveredTurnBlocksDuplicate(recovered);
    assertResolvedSameUuidDeferredTransfer({
      fixture,
      sourceSessionId: source.session_id,
      originalBindingId: String(originalBinding?.binding_id),
      originalGeneration: Number(originalBinding?.generation)
    });
    assertSingleTaskInput(fixture, message);
  } finally {
    fixture.cleanup();
  }
});

test("abandoned deferred history blocks replay but not an explicit terminal send", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    rolloutInitiallyAbsent: true
  });
  const message = "Do not bind an unrelated rollout without request acceptance.";
  try {
    persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const action = await deferredForegroundSendAction(fixture);
    const args = deferredForegroundSendArgs(fixture, action, message);
    const uncertain = await runCli(args, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_SUPPRESS_NATIVE_ACCEPTANCE: "1"
    });
    assert.equal(uncertain.status, 0, uncertain.stderr || uncertain.stdout);
    const output = JSON.parse(uncertain.stdout);
    assert.equal(output.delivered, true);
    assert.equal(output.terminal_input_dispatched, true);
    assert.equal(output.agent_acceptance, "unproven");
    assert.equal(output.status, "submission_uncertain");
    let transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "uncertain");
    assert.equal(transfer.do_not_retry, true);
    assert.equal(transfer.input_stage, "enter_dispatched");
    assertSingleTaskInput(fixture, message);

    const rejected = await runCli(args, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_SUPPRESS_NATIVE_ACCEPTANCE: "1"
    });
    assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
    assert.match(rejected.stderr, /uncertain dispatch|do not retry/iu);
    transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "uncertain");
    assert.equal(transfer.do_not_retry, true);
    assertSingleTaskInput(fixture, message);

    const closed = await runCli([
      "close",
      "--turn",
      String(output.turn_id),
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "user_abandoned");

    const detachedSource = loadManagedSession(
      fixture.storeDir,
      transfer.source_session_id
    );
    assert.equal(detachedSource.status, "detached");
    assert.equal(detachedSource.last_transition_id, transfer.transfer_id);
    assert.ok(detachedSource.binding);
    assert.ok(detachedSource.detached_at);
    const rolloutStat = fs.statSync(fixture.rolloutPath);
    const reattachedAt = new Date(
      Date.parse(detachedSource.detached_at) + 1_000
    );
    const reattached = saveManagedSession(fixture.storeDir, {
      ...detachedSource,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId: fixture.terminalId,
        terminalControl: fixture.terminalControl,
        pid: fixture.codexPid,
        nativeThreadId: NATIVE_THREAD_ID,
        processUuid: processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
        processBirth: LIVE_PROCESS_BIRTH,
        rollout: {
          fd: "24",
          device: String(rolloutStat.dev),
          inode: String(rolloutStat.ino),
          path: fs.realpathSync(fixture.rolloutPath)
        },
        evidence: "codex_open_root_rollout",
        generation: detachedSource.binding.generation + 1,
        now: reattachedAt
      }),
      detached_at: undefined,
      updated_at: reattachedAt.toISOString()
    }, { expectedRevision: detachedSource.revision as number });
    assert.equal(reattached.last_transition_id, transfer.transfer_id);

    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
    const relisted = await listFixtureTerminal(fixture);
    const explicitSend = relisted.available_actions.send;
    assert.ok(explicitSend, JSON.stringify(relisted, null, 2));
    assert.equal(explicitSend.scope, "terminal_user_explicit");
    assert.equal(explicitSend.arguments.selector, fixture.terminalId);
    assert.equal("session_id" in explicitSend.arguments, false);
    assert.equal(
      typeof explicitSend.arguments.expected_terminal_token,
      "string"
    );

    const explicitMessage =
      "Continue after the abandoned deferred transfer was reattached.";
    const callsBeforeExplicitSend = taskInputCalls(fixture).length;
    fixture.acceptanceNativeThreadIdsOnEnter = [NATIVE_THREAD_ID];
    const sent = await runCli(
      userExplicitDeferredForegroundSendArgs(
        fixture,
        explicitSend,
        explicitMessage
      ),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    assert.deepEqual(
      taskInputCalls(fixture).slice(callsBeforeExplicitSend)
        .map((call) => call.args),
      [
        ["send-keys", "-t", fixture.inputTarget, "-l", explicitMessage],
        ["send-keys", "-t", fixture.inputTarget, "C-m"]
      ]
    );
  } finally {
    fixture.cleanup();
  }
});

test("pre-text terminal identity drift immediately aborts a target-prepared transfer", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    rolloutInitiallyAbsent: true
  });
  const message = "Abort before text when terminal identity changes.";
  try {
    const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const action = await deferredForegroundSendAction(fixture);
    const aborted = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      {
        ...fixture.environment,
        AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
        AKK_TEST_DEFERRED_IDENTITY_DRIFT_BEFORE_TEXT: "1"
      }
    );
    assert.equal(aborted.status, 0, aborted.stderr || aborted.stdout);
    const output = JSON.parse(aborted.stdout);
    assert.equal(output.delivered, false);
    assert.equal(output.submission_outcome, "aborted");
    assert.equal(output.safe_to_retry, true);
    assert.equal(output.do_not_retry, false);
    assert.match(output.reason, /terminal input never started/iu);

    const transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "abort_resolved");
    assert.equal(transfer.input_stage, "none");
    assert.equal(transfer.terminal_input_not_started_at, undefined);
    assert.ok(transfer.abort_cleanup_completed_at);
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "bound"
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, transfer.target_session_id).status,
      "detached"
    );
    const turn = listConversations(fixture.storeDir).find(
      (candidate) => candidate.user_request === message
    );
    assert.ok(turn);
    assert.equal(turn.status, "failed");
    assert.equal(
      (turn.native_session_takeover as Record<string, any>)
        .terminal_bridge_submission?.status,
      "aborted"
    );
    const ledger = readSoleTerminalDispatchLedger(fixture);
    assert.equal(ledger.status, "resolved");
    assert.equal(ledger.safe_to_retry, true);
    assert.equal(ledger.text_injected_at, undefined);
    assert.equal(ledger.enter_dispatched_at, undefined);
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.notEqual(
      (await listFixtureTerminal(fixture)).management_state,
      "conflict"
    );
  } finally {
    fixture.cleanup();
  }
});

test("managed deferred tokens fail closed while exact no-token managed routing still works", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    rolloutInitiallyAbsent: true
  });
  try {
    const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const action = await deferredForegroundSendAction(fixture);
    const arbitrary = await runCli(
      deferredForegroundSendArgs(
        fixture,
        {
          ...action,
          arguments: {
            ...action.arguments,
            expected_managed_terminal_token: "arbitrary-terminal-token"
          }
        },
        "An arbitrary token must send no input."
      ),
      fixture.environment
    );
    assert.equal(arbitrary.status, 1, arbitrary.stdout);
    assert.match(arbitrary.stderr, /fresh exact terminal token/iu);

    const current = loadManagedSession(fixture.storeDir, source.session_id);
    saveManagedSession(fixture.storeDir, {
      ...current,
      updated_at: "2026-08-12T03:00:00.000Z"
    }, { expectedRevision: current.revision as number });
    const stale = await runCli(
      deferredForegroundSendArgs(
        fixture,
        action,
        "A stale deferred token must send no input."
      ),
      fixture.environment
    );
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(stale.stderr, /fresh exact terminal token/iu);
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);
  } finally {
    fixture.cleanup();
  }

  const unmanaged = createNoRolloutFixture({ rolloutInitiallyAbsent: true });
  const message = "An exact managed-only selector still needs no handoff token.";
  try {
    const sent = await runCli([
      "send",
      "--conversation",
      unmanaged.terminalId,
      "--message",
      message,
      "--background",
      "--store-dir",
      unmanaged.storeDir,
      "--codex-home",
      unmanaged.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], {
      ...unmanaged.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    assertSingleTaskInput(unmanaged, message);
  } finally {
    unmanaged.cleanup();
  }
});

for (const [label, acceptedNativeThreadId] of [
  ["lingering old root", NATIVE_THREAD_ID],
  ["new status-card root", EXTERNAL_THREAD_ID]
] as const) {
  test(
    `candidate-set narrow Herdr send binds one ${label} acceptance without /status`,
    async () => {
      const fixture = createNoRolloutFixture({
        codexVersion: "0.147.0",
        terminalKind: "herdr",
        viewportColumns: 54,
        ttyViewportColumns: 51
      });
      const message = `Route once through the ${label}.`;
      try {
        enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
        const source = persistStatusCardSession(
          fixture,
          LIVE_PROCESS_BIRTH,
          EXTERNAL_THREAD_ID,
          `session-candidate-status-card-${label.replaceAll(" ", "-")}`
        );
        fixture.identityObservationError =
          "fixture foreground identity is unavailable while inventory is exact";
        fixture.acceptanceNativeThreadIdsOnEnter = [acceptedNativeThreadId];

        const action = await deferredForegroundSendAction(fixture);
        const sent = await runCli(
          deferredForegroundSendArgs(fixture, action, message),
          codexNativeAcceptanceEnv(fixture.environment)
        );
        assert.equal(sent.status, 0, sent.stderr || sent.stdout);
        const output = JSON.parse(sent.stdout);
        assert.equal(output.delivered, true, sent.stdout);
        assert.equal(output.delivery_receipt, "agent_accepted");
        assert.equal(
          output.conversation.native_thread_id,
          acceptedNativeThreadId
        );
        assert.notEqual(output.session_id, source.session_id);

        const sourceAfter = loadManagedSession(
          fixture.storeDir,
          source.session_id
        );
        const target = loadManagedSession(
          fixture.storeDir,
          String(output.session_id)
        );
        assert.equal(sourceAfter.status, "detached");
        if (acceptedNativeThreadId === EXTERNAL_THREAD_ID) {
          assert.equal(sourceAfter.binding?.native_thread_id, undefined);
          assert.equal(sourceAfter.binding?.native_process.rollout, undefined);
          assert.equal(
            sourceAfter.binding?.generation,
            Number(source.binding?.generation) + 1
          );
        } else {
          assert.equal(
            sourceAfter.binding?.native_thread_id,
            EXTERNAL_THREAD_ID
          );
          assert.equal(
            sourceAfter.binding?.generation,
            source.binding?.generation
          );
        }
        assert.equal(target.status, "bound");
        assert.equal(target.binding?.native_thread_id, acceptedNativeThreadId);
        assert.equal(
          listManagedSessions(fixture.storeDir).filter((session) =>
            session.status === "bound" &&
            session.binding?.native_thread_id === acceptedNativeThreadId
          ).length,
          1
        );

        const transfer = soleDeferredForegroundTransfer(fixture);
        assert.equal(transfer.status, "resolved");
        assert.equal(transfer.source_kind, "status_card_only");
        const anchor = persistedCodexV3AcceptanceAnchor(
          fixture,
          String(output.turn_id)
        );
        assert.equal(anchor.candidate_rollouts.length, 1);
        assertSingleTaskInput(fixture, message);
        assert.equal(
          readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
            call.args.includes("/status")
          ),
          false
        );
        assert.deepEqual(fixture.ttyViewportInspectionPids, []);
      } finally {
        fixture.cleanup();
      }
    }
  );
}

for (const [label, acceptedNativeThreadId] of [
  ["same UUID", NATIVE_THREAD_ID],
  ["different UUID", EXTERNAL_THREAD_ID]
] as const) {
  test(
    `quiescent rollout candidate send preserves released history for ${label}`,
    async () => {
      const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
      const message = `Accept the multi-root request on the ${label} candidate.`;
      try {
        enableFixtureCandidateInventory(fixture, [
          NATIVE_THREAD_ID,
          EXTERNAL_THREAD_ID
        ]);
        const source = persistExactEndedRolloutSession(
          fixture,
          `session-quiescent-candidate-${label.replaceAll(" ", "-")}`
        );
        persistReleasedCandidateSourceTurns(fixture, source);
        fixture.acceptanceNativeThreadIdsOnEnter = [acceptedNativeThreadId];

        const terminal = await listFixtureTerminal(fixture);
        assert.equal(
          terminal.native_agent_identity_observation.status,
          "unavailable"
        );
        const action = terminal.available_actions.send;
        assert.ok(action, JSON.stringify(terminal, null, 2));
        assert.equal(action.arguments.selector, fixture.terminalId);
        assert.equal("session_id" in action.arguments, false);
        assert.equal(
          typeof action.arguments.expected_terminal_token,
          "string"
        );

        const sent = await runCli(
          deferredForegroundSendArgs(fixture, action, message),
          codexNativeAcceptanceEnv(fixture.environment)
        );
        assert.equal(sent.status, 0, sent.stderr || sent.stdout);
        const output = JSON.parse(sent.stdout);
        assert.equal(output.delivered, true, sent.stdout);
        assert.equal(output.conversation.native_thread_id, acceptedNativeThreadId);

        const sourceAfter = loadManagedSession(
          fixture.storeDir,
          source.session_id
        );
        const target = loadManagedSession(
          fixture.storeDir,
          String(output.session_id)
        );
        assert.equal(sourceAfter.status, "detached");
        assert.equal(target.status, "bound");
        assert.equal(target.binding?.native_thread_id, acceptedNativeThreadId);
        if (acceptedNativeThreadId === NATIVE_THREAD_ID) {
          assert.equal(sourceAfter.binding?.native_thread_id, undefined);
          assert.equal(
            sourceAfter.binding?.generation,
            Number(source.binding?.generation) + 1
          );
        } else {
          assert.equal(sourceAfter.binding?.native_thread_id, NATIVE_THREAD_ID);
          assert.equal(
            sourceAfter.binding?.generation,
            source.binding?.generation
          );
        }
        assert.deepEqual(
          listConversations(fixture.storeDir)
            .filter((turn) => turn.session_id === source.session_id)
            .map((turn) => turn.status)
            .sort(),
          ["cancelled", "closed", "failed", "idle"]
        );
        const transfer = soleDeferredForegroundTransfer(fixture);
        assert.equal(transfer.status, "resolved");
        assert.equal(transfer.source_kind, "candidate_rollout_quiescent");
        assert.equal(transfer.source_turn_history?.length, 4);
        assertSingleTaskInput(fixture, message);
      } finally {
        fixture.cleanup();
      }
    }
  );
}

test("callbackless candidate pending acceptance restarts into one local completion", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Reconcile this callbackless candidate request after restart.";
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    const source = persistStatusCardSession(
      fixture,
      LIVE_PROCESS_BIRTH,
      EXTERNAL_THREAD_ID,
      "session-candidate-callbackless-source"
    );
    fixture.identityObservationError =
      "fixture foreground identity is unavailable while inventory is exact";
    fixture.acceptanceNativeThreadIdsOnEnter = [];
    fixture.cliPid = process.pid + 500_000;
    const action = await deferredForegroundSendAction(fixture);

    const pending = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(pending.status, 0, pending.stderr || pending.stdout);
    const pendingOutput = JSON.parse(pending.stdout);
    assert.equal(pendingOutput.delivered, true);
    assert.equal(pendingOutput.terminal_input_dispatched, true);
    assert.equal(pendingOutput.agent_acceptance, "unproven");
    assert.equal(pendingOutput.status, "submission_pending_acceptance");
    assert.equal(pendingOutput.submission_outcome, "pending_acceptance");
    assert.equal(pendingOutput.callback_expected, false);
    assert.equal(soleDeferredForegroundTransfer(fixture).status, "dispatch_started");
    assertSingleTaskInput(fixture, message);

    appendNativeAcceptance(
      fixture.rolloutPath,
      message,
      FIRST_NATIVE_TURN_ID,
      {
        nativeThreadId: NATIVE_THREAD_ID,
        workspace: String(fixture.terminalControl.currentPath),
        codexVersion: fixture.codexVersion,
        timestamp: "2026-08-12T00:00:01.000Z"
      }
    );
    appendFixtureCompletion(fixture, NATIVE_THREAD_ID);
    fixture.identityObservationError = undefined;
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
    assert.equal(
      finalTurn.status,
      "idle",
      JSON.stringify({
        monitored: monitored.stdout || monitored.stderr,
        stalled_reason: finalTurn.stalled_reason,
        takeover: finalTurn.native_session_takeover
      }, null, 2)
    );
    assert.equal(finalTurn.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(finalTurn.callback_delivery, undefined);
    assert.equal(finalTurn.gateway_method, undefined);
    assert.equal(soleDeferredForegroundTransfer(fixture).status, "resolved");
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "detached"
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, String(pendingOutput.session_id))
        .binding?.native_thread_id,
      NATIVE_THREAD_ID
    );
    assert.equal(readSoleTerminalDispatchLedger(fixture).status, "resolved");
    const events = fs.readFileSync(String(finalTurn.event_log_path), "utf8");
    assert.doesNotMatch(events, /callback_delivery_(?:pending|failed)|callback_outbox/u);
    assertSingleTaskInput(fixture, message);
  } finally {
    fixture.cleanup();
  }
});

test("v3 acceptance monitor defers a contended writer without weakening durable evidence", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Recover this candidate only after the Store writer is released.";
  let lockReleaser: ReturnType<typeof spawn> | undefined;
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    persistStatusCardSession(
      fixture,
      LIVE_PROCESS_BIRTH,
      EXTERNAL_THREAD_ID,
      "session-candidate-writer-contention"
    );
    fixture.identityObservationError =
      "fixture foreground identity is unavailable while inventory is exact";
    fixture.acceptanceNativeThreadIdsOnEnter = [];
    fixture.cliPid = process.pid + 500_000;
    const action = await deferredForegroundSendAction(fixture);
    const pending = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(pending.status, 0, pending.stderr || pending.stdout);
    const pendingOutput = JSON.parse(pending.stdout);
    assert.equal(pendingOutput.status, "submission_pending_acceptance");
    const transfer = soleDeferredForegroundTransfer(fixture);
    const turn = listConversations(fixture.storeDir).find((candidate) =>
      candidate.turn_id === pendingOutput.turn_id
    );
    assert.ok(turn);
    const statePath = String(turn.state_path);
    const logPath = String(turn.event_log_path);
    const transferPath = pathsForDeferredForegroundTransfer(
      transfer.transfer_id,
      fixture.storeDir
    ).statePath;
    const ledgerPath = soleTerminalDispatchLedgerPath(fixture);
    const snapshotPath = path.join(
      fixture.tempDir,
      "writer-contention-snapshot.json"
    );
    const writerLockPath = path.join(fixture.storeDir, ".akk-writer.lock");
    fs.writeFileSync(writerLockPath, `${JSON.stringify({
      pid: process.pid,
      token: "candidate-v3-writer-contention",
      created_at: new Date().toISOString()
    })}\n`, { mode: 0o600 });

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
    fixture.identityObservationError = undefined;

    const durablePaths = [statePath, transferPath, ledgerPath];
    const before = Object.fromEntries(durablePaths.map((filePath) => [
      filePath,
      fs.readFileSync(filePath, "utf8")
    ]));
    const releaseScript = `
      const fs = require("node:fs");
      const durablePaths = ${JSON.stringify(durablePaths)};
      const snapshotPath = ${JSON.stringify(snapshotPath)};
      const writerLockPath = ${JSON.stringify(writerLockPath)};
      setTimeout(() => {
        const snapshot = Object.fromEntries(durablePaths.map((filePath) => [
          filePath,
          fs.readFileSync(filePath, "utf8")
        ]));
        fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
        fs.unlinkSync(writerLockPath);
      }, 10250);
    `;
    lockReleaser = spawnFixtureNodeEval(releaseScript);

    const monitored = await runCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      ...codexNoRolloutStoreArgs(fixture),
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "1",
      "--agent-hard-timeout-minutes",
      "2"
    ], codexNativeAcceptanceEnv(fixture.environment));
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")), before);
    assert.ok(
      fixture.runtimeLogs.some((entry) =>
        entry.event === "terminal_bridge_monitor_store_operation_deferred" &&
        entry.fields.error_code === "AKK_STORE_LOCK_TIMEOUT"
      ),
      JSON.stringify(fixture.runtimeLogs, null, 2)
    );
    const finalTurn = listConversations(fixture.storeDir).find((candidate) =>
      candidate.turn_id === pendingOutput.turn_id
    );
    assert.ok(finalTurn);
    assert.equal(finalTurn.status, "idle");
    assert.equal(finalTurn.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(finalTurn.callback_delivery, undefined);
    assert.equal(soleDeferredForegroundTransfer(fixture).status, "resolved");
    assert.equal(readSoleTerminalDispatchLedger(fixture).status, "resolved");
    assertSingleTaskInput(fixture, message);
  } finally {
    if (lockReleaser && lockReleaser.exitCode === null) {
      lockReleaser.kill("SIGKILL");
    }
    fs.rmSync(path.join(fixture.storeDir, ".akk-writer.lock"), {
      force: true
    });
    fixture.cleanup();
  }
});

test("raw terminal cancel cannot bypass a pending candidate transfer after a route rename", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Keep this candidate request pending while cancel is fenced.";
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    persistStatusCardSession(
      fixture,
      LIVE_PROCESS_BIRTH,
      EXTERNAL_THREAD_ID,
      "session-candidate-cancel-source"
    );
    fixture.identityObservationError =
      "fixture foreground identity is unavailable while inventory is exact";
    fixture.acceptanceNativeThreadIdsOnEnter = [];
    const action = await deferredForegroundSendAction(fixture);
    const pending = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(pending.status, 0, pending.stderr || pending.stdout);
    assert.equal(JSON.parse(pending.stdout).status, "submission_pending_acceptance");
    const beforeTransfer = soleDeferredForegroundTransfer(fixture);
    const beforeTurns = listConversations(fixture.storeDir);
    assert.equal(beforeTransfer.status, "dispatch_started");
    assertSingleTaskInput(fixture, message);

    assert.equal(fixture.terminalControl.kind, "tmux");
    const renamedTarget = "tmux-renamed:0.0";
    fixture.target = renamedTarget;
    fixture.terminalControl = {
      ...fixture.terminalControl,
      target: renamedTarget,
      session: "tmux-renamed"
    };
    fixture.terminalId =
      `terminal:v2:tmux:codex:${renamedTarget}:${fixture.codexPid}`;

    const cancelled = await runCli([
      "cancel",
      "--conversation",
      fixture.terminalId,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(cancelled.status, 1, cancelled.stdout);
    assert.match(
      cancelled.stderr,
      /cannot cancel terminal.*deferred foreground transfer.*dispatch_started/iu
    );
    assert.deepEqual(soleDeferredForegroundTransfer(fixture), beforeTransfer);
    assert.deepEqual(listConversations(fixture.storeDir), beforeTurns);
    assertSingleTaskInput(fixture, message);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
        ["C-c", "Escape"].includes(String(call.args.at(-1)))
      ),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("raw terminal cancel remains direct after a candidate transfer resolves", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Resolve this candidate request before raw cancel.";
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    persistStatusCardSession(
      fixture,
      LIVE_PROCESS_BIRTH,
      EXTERNAL_THREAD_ID,
      "session-resolved-cancel-source"
    );
    fixture.identityObservationError =
      "fixture foreground identity is unavailable while inventory is exact";
    fixture.acceptanceNativeThreadIdsOnEnter = [NATIVE_THREAD_ID];
    const action = await deferredForegroundSendAction(fixture);
    const sent = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    assert.equal(soleDeferredForegroundTransfer(fixture).status, "resolved");
    const keyCountBefore = readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
      ["C-c", "Escape"].includes(String(call.args.at(-1)))
    ).length;

    const cancelled = await runCli([
      "cancel",
      "--conversation",
      fixture.terminalId,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    const output = JSON.parse(cancelled.stdout);
    assert.equal(output.source, "terminal_control");
    assert.equal(output.cancel_requested, true);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
        ["C-c", "Escape"].includes(String(call.args.at(-1)))
      ).length,
      keyCountBefore + 1
    );
  } finally {
    fixture.cleanup();
  }
});

test("startup reconciliation relaunches one pending candidate monitor without replay", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Relaunch this pending candidate monitor after startup.";
  let monitorPid: number | undefined;
  try {
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
    const source = persistStatusCardSession(
      fixture,
      LIVE_PROCESS_BIRTH,
      EXTERNAL_THREAD_ID,
      "session-candidate-startup-reconcile"
    );
    fixture.identityObservationError =
      "fixture foreground identity is unavailable while inventory is exact";
    fixture.acceptanceNativeThreadIdsOnEnter = [];
    fixture.cliPid = process.pid;
    const action = await deferredForegroundSendAction(fixture);
    const pending = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(pending.status, 0, pending.stderr || pending.stdout);
    const pendingOutput = JSON.parse(pending.stdout);
    assert.equal(pendingOutput.status, "submission_pending_acceptance");
    assert.equal(pendingOutput.monitor_pid, null);
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
    const pendingTurn = listConversations(fixture.storeDir).find((turn) =>
      turn.turn_id === pendingOutput.turn_id
    );
    assert.ok(pendingTurn);
    const statePath = String(pendingTurn.state_path);
    const logPath = String(pendingTurn.event_log_path);
    fixture.identityObservationError = undefined;

    const reconciled = runCliSubprocess([
      "reconcile-monitors",
      ...codexNoRolloutStoreArgs(fixture),
      "--reason",
      "test_candidate_startup_reconcile",
      "--terminal-monitors-only",
      "--monitor-poll-interval-ms",
      "50"
    ], {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      PATH: fixture.environment.PATH
    });
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const reconciliation = JSON.parse(reconciled.stdout);
    assert.equal(reconciliation.errors, 0, reconciled.stdout);
    assert.equal(reconciliation.launched, 1, reconciled.stdout);
    monitorPid = Number(
      reconciliation.items.find((item: Record<string, any>) =>
        item.status === "launched"
      )?.monitor_pid
    );
    assert.ok(Number.isInteger(monitorPid) && monitorPid > 0, reconciled.stdout);

    await waitForFixtureConversation(
      statePath,
      (conversation) =>
        conversation.native_session_takeover?.terminal_bridge_submission
          ?.status === "agent_accepted",
      5_000
    );
    appendFixtureCompletion(fixture, NATIVE_THREAD_ID);

    const settled = await waitForFixtureConversation(
      statePath,
      (conversation) => conversation.status === "idle",
      5_000
    );
    assert.equal(settled.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(settled.callback_delivery, undefined);
    assert.equal(settled.gateway_method, undefined);
    assert.equal(soleDeferredForegroundTransfer(fixture).status, "resolved");
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "detached"
    );
    await waitForProcessExit(monitorPid, 5_000);
    monitorPid = undefined;
    assert.equal(readSoleTerminalDispatchLedger(fixture).status, "resolved");
    assert.doesNotMatch(
      fs.readFileSync(logPath, "utf8"),
      /callback_delivery_(?:pending|failed)|callback_outbox/u
    );
    assertSingleTaskInput(fixture, message);
  } finally {
    if (monitorPid) {
      await waitForProcessExit(monitorPid, 5_000);
    }
    fixture.cleanup();
  }
});

test("active candidate transfer protects expired idle source history from reconciliation", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  const message = "Keep frozen source history while candidate acceptance is pending.";
  try {
    enableFixtureCandidateInventory(fixture, [
      NATIVE_THREAD_ID,
      EXTERNAL_THREAD_ID
    ]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-candidate-idle-cleanup-source"
    );
    persistReleasedCandidateSourceTurns(fixture, source);
    fixture.acceptanceNativeThreadIdsOnEnter = [];
    fixture.cliPid = process.pid;
    const action = await deferredForegroundSendAction(fixture);
    const pending = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(pending.status, 0, pending.stderr || pending.stdout);
    assert.equal(
      JSON.parse(pending.stdout).status,
      "submission_pending_acceptance"
    );
    const transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "dispatch_started");
    assert.equal(transfer.source_turn_history?.length, 4);
    const idleTurn = listConversations(fixture.storeDir).find((turn) =>
      turn.session_id === source.session_id && turn.status === "idle"
    );
    assert.ok(idleTurn);
    const statePath = String(idleTurn.state_path);
    const logPath = String(idleTurn.event_log_path);
    const beforeState = fs.readFileSync(statePath);
    const beforeEvents = fs.existsSync(logPath)
      ? fs.readFileSync(logPath)
      : Buffer.alloc(0);

    const listed = await runCli([
      "list",
      "--reconcile",
      "--all",
      ...codexNoRolloutStoreArgs(fixture),
      "--idle-timeout-minutes",
      "1",
      "--disable-terminal-bridge-monitor"
    ], fixture.environment);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const output = JSON.parse(listed.stdout);
    assert.equal(output.reconciliation.status, "completed");
    assert.equal(output.reconciliation.closed, 0);
    assert.equal(output.reconciliation.monitors_launched, 0);
    assert.ok(output.reconciliation.skipped >= 1, listed.stdout);
    assert.deepEqual(fs.readFileSync(statePath), beforeState);
    assert.deepEqual(
      fs.existsSync(logPath) ? fs.readFileSync(logPath) : Buffer.alloc(0),
      beforeEvents
    );
    assert.equal(soleDeferredForegroundTransfer(fixture).status, "dispatch_started");
    assertSingleTaskInput(fixture, message);
  } finally {
    fixture.cleanup();
  }
});

for (const acceptanceCase of ["zero", "multiple"] as const) {
  test(`candidate ${acceptanceCase} acceptance never replays terminal input`, async () => {
    const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
    const message = `Do not replay a ${acceptanceCase} candidate acceptance.`;
    try {
      enableFixtureCandidateInventory(fixture, acceptanceCase === "multiple"
        ? [NATIVE_THREAD_ID, EXTERNAL_THREAD_ID]
        : [NATIVE_THREAD_ID]);
      persistStatusCardSession(
        fixture,
        LIVE_PROCESS_BIRTH,
        SECOND_EXTERNAL_THREAD_ID,
        `session-candidate-${acceptanceCase}-source`
      );
      fixture.identityObservationError =
        "fixture foreground identity is unavailable while inventory is exact";
      fixture.acceptanceNativeThreadIdsOnEnter = acceptanceCase === "multiple"
        ? [NATIVE_THREAD_ID, EXTERNAL_THREAD_ID]
        : [];
      const action = await deferredForegroundSendAction(fixture);
      const args = deferredForegroundSendArgs(fixture, action, message);
      const first = await runCli(args, codexNativeAcceptanceEnv(fixture.environment));
      assert.equal(first.status, 0, first.stderr || first.stdout);
      const output = JSON.parse(first.stdout);
      if (acceptanceCase === "zero") {
        assert.equal(output.status, "submission_pending_acceptance");
        assert.equal(output.submission_outcome, "pending_acceptance");
        assert.equal(soleDeferredForegroundTransfer(fixture).status, "dispatch_started");
      } else {
        assert.equal(output.status, "submission_uncertain");
        assert.equal(output.submission_outcome, "uncertain");
        assert.equal(output.do_not_retry, true);
        assert.equal(soleDeferredForegroundTransfer(fixture).status, "uncertain");
      }
      assertSingleTaskInput(fixture, message);

      const replay = await runCli(args, codexNativeAcceptanceEnv(fixture.environment));
      assert.equal(replay.status, 1, replay.stdout);
      assert.match(
        replay.stderr,
        acceptanceCase === "zero"
          ? /still dispatch_started|pending|dispatch ledger|exact Turn authority|refresh|unresolved Turn.*waiting_for_agent/iu
          : /uncertain|do not retry/iu
      );
      assertSingleTaskInput(fixture, message);
    } finally {
      fixture.cleanup();
    }
  });
}

for (const identityCase of ["resolved", "unavailable"] as const) {
  test(`one exact open root keeps snapshot-bound candidate send when the constrained identity is ${identityCase}`, async () => {
    const fixture = createNoRolloutFixture({
      codexVersion: "0.147.0",
      terminalKind: "herdr",
      viewportColumns: 55,
      ttyViewportColumns: 52
    });
    const message = `Continue through the ${identityCase} one-root snapshot.`;
    try {
      enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
      const source = persistExactEndedRolloutSession(
        fixture,
        `session-single-exact-root-${identityCase}`
      );
      const sourceBindingId = source.binding?.binding_id;
      const sourceGeneration = source.binding?.generation;
      assert.ok(sourceBindingId);
      assert.ok(sourceGeneration);
      if (identityCase === "unavailable") {
        fixture.identityObservationError =
          "fixture foreground identity is unavailable while inventory is exact";
      }

      const terminal = await listFixtureTerminal(fixture);
      assert.equal(
        terminal.native_agent_identity_observation.status,
        "resolved"
      );
      assert.equal(terminal.management_state, "managed");
      assert.equal(terminal.managed.session_id, source.session_id);
      const action = terminal.available_actions.send;
      assert.ok(action, JSON.stringify(terminal, null, 2));
      assert.equal(action.arguments.selector, fixture.terminalId);
      assert.equal("session_id" in action.arguments, false);
      assert.equal(typeof action.arguments.expected_terminal_token, "string");
      assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
      assert.deepEqual(taskInputCalls(fixture), []);

      fixture.acceptanceNativeThreadIdsOnEnter = [NATIVE_THREAD_ID];
      const sent = await runCli(
        deferredForegroundSendArgs(fixture, action, message),
        codexNativeAcceptanceEnv(fixture.environment)
      );
      assert.equal(sent.status, 0, sent.stderr || sent.stdout);
      const output = JSON.parse(sent.stdout);
      assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);
      assert.notEqual(output.session_id, source.session_id);
      assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
      const transfer = soleDeferredForegroundTransfer(fixture);
      assert.equal(transfer.status, "resolved");
      assert.equal(transfer.source_kind, "candidate_rollout_quiescent");
      assert.equal(transfer.source_rollout_authority ?? "present", "present");
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
      assertResolvedSameUuidDeferredTransfer({
        fixture,
        sourceSessionId: source.session_id,
        originalBindingId: sourceBindingId,
        originalGeneration: sourceGeneration
      });
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

for (const hintCase of ["absent", "aged"] as const) {
  test(`manual Codex clear adopts the root materialized after Enter when its resume hint is ${hintCase}`, async () => {
    const fixture = createNoRolloutFixture({
      codexVersion: "0.147.0",
      terminalKind: "herdr",
      viewportColumns: 55,
      ttyViewportColumns: 52
    });
    const message =
      `Bind the first task after a manual clear with an ${hintCase} hint.`;
    try {
      enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
      const source = persistExactEndedRolloutSession(
        fixture,
        `session-latent-clear-source-${hintCase}`
      );
      if (hintCase === "aged") {
        const wrappedResumeFirstLine =
          `To continue this session, run codex resume ${NATIVE_THREAD_ID.slice(0, 9)}`;
        assert.equal([...wrappedResumeFirstLine].length, 52);
        fs.writeFileSync(fixture.screenPath, [
          wrappedResumeFirstLine,
          NATIVE_THREAD_ID.slice(9),
          ...Array.from(
            { length: 30 },
            (_, index) => `post-clear terminal output line ${index + 1}`
          ),
          "› \u001b[2mAsk Codex anything\u001b[0m",
          CODEX_TEST_COMPOSER_FOOTER
        ].join("\n"));
      } else {
        fs.writeFileSync(
          fixture.screenPath,
          "Ready after /clear\n› \u001b[2mAsk Codex anything\u001b[0m\n" +
          CODEX_TEST_COMPOSER_FOOTER
        );
      }

      const listed = await listFixtureTerminal(fixture);
      assert.equal(
        listed.native_agent_identity_observation.status,
        "resolved"
      );
      const action = listed.available_actions.send;
      assert.ok(action, JSON.stringify(listed, null, 2));
      assert.equal(action.arguments.selector, fixture.terminalId);
      assert.equal("session_id" in action.arguments, false);
      assert.equal(typeof action.arguments.expected_terminal_token, "string");

      fixture.acceptanceNativeThreadIdsOnEnter = [EXTERNAL_THREAD_ID];
      const sent = await runCli(
        deferredForegroundSendArgs(fixture, action, message),
        codexNativeAcceptanceEnv(fixture.environment)
      );
      assert.equal(sent.status, 0, sent.stderr || sent.stdout);
      const output = JSON.parse(sent.stdout);
      assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);
      assert.notEqual(output.session_id, source.session_id);
      assert.equal(output.conversation.native_thread_id, EXTERNAL_THREAD_ID);
      const transfer = soleDeferredForegroundTransfer(fixture);
      assert.equal(transfer.status, "resolved");
      assert.equal(transfer.target_native_thread_id, EXTERNAL_THREAD_ID);
      assert.equal(transfer.source_rollout_authority ?? "present", "present");
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
}

test("multi-root unavailable identity uses the exact inventory token and binds the sole post-Enter acceptor", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    terminalKind: "herdr",
    viewportColumns: 55,
    ttyViewportColumns: 52
  });
  const message = "Bind only the root that accepts after this exact inventory anchor.";
  try {
    enableFixtureCandidateInventory(fixture, [
      NATIVE_THREAD_ID,
      EXTERNAL_THREAD_ID
    ]);
    const source = persistExactEndedRolloutSession(
      fixture,
      "session-multi-root-unavailable-source"
    );

    const listed = await listFixtureTerminal(fixture);
    assert.equal(
      listed.native_agent_identity_observation.status,
      "unavailable"
    );
    const action = listed.available_actions.send;
    assert.ok(action, JSON.stringify(listed, null, 2));
    assert.equal(action.arguments.selector, fixture.terminalId);
    assert.equal("session_id" in action.arguments, false);
    assert.equal(typeof action.arguments.expected_terminal_token, "string");

    fixture.acceptanceNativeThreadIdsOnEnter = [SECOND_EXTERNAL_THREAD_ID];
    const sent = await runCli(
      deferredForegroundSendArgs(fixture, action, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);
    assert.notEqual(output.session_id, source.session_id);
    assert.equal(
      output.conversation.native_thread_id,
      SECOND_EXTERNAL_THREAD_ID
    );
    const transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "resolved");
    assert.equal(transfer.source_kind, "candidate_rollout_quiescent");
    assert.equal(transfer.source_rollout_authority ?? "present", "present");
    assert.equal(transfer.target_native_thread_id, SECOND_EXTERNAL_THREAD_ID);
    const anchor = persistedCodexV3AcceptanceAnchor(
      fixture,
      String(output.turn_id)
    );
    assert.deepEqual(
      anchor.candidate_rollouts?.map(
        (candidate: Record<string, any>) => candidate.native_thread_id
      ),
      [NATIVE_THREAD_ID, EXTERNAL_THREAD_ID]
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
