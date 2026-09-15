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

for (const [label, acceptedNativeThreadId] of [
  ["same", NATIVE_THREAD_ID],
  ["different", EXTERNAL_THREAD_ID]
] as const) {
  test(
    `terminal-scoped narrow Herdr send defers a ${label} Codex UUID until ` +
      "exact native acceptance",
    async () => {
      const fixture = createNoRolloutFixture({
        codexVersion: "0.147.0",
        terminalKind: "herdr",
        rolloutInitiallyAbsent: true,
        viewportColumns: 54,
        ttyViewportColumns: 51
      });
      try {
        const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
        const listed = await listFixtureTerminal(fixture);
        assert.equal(listed.management_state, "managed");
        assert.equal(listed.managed.session_id, source.session_id);
        const action = listed.available_actions.send;
        assert.ok(action, JSON.stringify(listed, null, 2));
        assert.equal(action.arguments.selector, fixture.terminalId);
        assert.equal("session_id" in action.arguments, false);
        assert.equal(
          typeof action.arguments.expected_terminal_token,
          "string"
        );

        fixture.activeNativeThreadId = acceptedNativeThreadId;
        fixture.activeRolloutPath = path.join(
          path.dirname(fixture.rolloutPath),
          `rollout-2026-08-12T00-00-00-${acceptedNativeThreadId}.jsonl`
        );
        const message = `Bind the ${label} foreground only after acceptance.`;
        const sent = await runCli([
          "send",
          "--conversation",
          String(action.arguments.selector),
          "--expected-terminal-token",
          String(action.arguments.expected_terminal_token),
          "--message",
          message,
          ...codexNoRolloutBackgroundSendArgs(fixture)
        ], codexNativeAcceptanceEnv(fixture.environment));

        assert.equal(sent.status, 0, sent.stderr || sent.stdout);
        const output = JSON.parse(sent.stdout);
        assert.equal(output.delivered, true, sent.stdout);
        assert.equal(output.delivery_receipt, "agent_accepted");
        assert.equal(output.conversation.native_thread_id, acceptedNativeThreadId);
        assert.notEqual(output.session_id, source.session_id);
        const detachedSource = loadManagedSession(
          fixture.storeDir,
          source.session_id
        );
        const target = loadManagedSession(fixture.storeDir, output.session_id);
        assert.equal(detachedSource.status, "detached");
        if (acceptedNativeThreadId === NATIVE_THREAD_ID) {
          assert.equal(detachedSource.binding?.native_thread_id, undefined);
          assert.equal(detachedSource.binding?.native_process.rollout, undefined);
          assert.notEqual(
            detachedSource.binding?.binding_id,
            source.binding?.binding_id
          );
          assert.equal(
            detachedSource.binding?.generation,
            Number(source.binding?.generation) + 1
          );
        } else {
          assert.equal(
            detachedSource.binding?.native_thread_id,
            NATIVE_THREAD_ID
          );
          assert.equal(
            detachedSource.binding?.binding_id,
            source.binding?.binding_id
          );
          assert.equal(
            detachedSource.binding?.generation,
            source.binding?.generation
          );
        }
        assert.equal(target.status, "bound");
        assert.equal(target.binding?.native_thread_id, acceptedNativeThreadId);
        assert.equal(target.lineage.created_by, "attach");
        assert.equal(target.lineage.previous_session_id, source.session_id);

        const sends = readTmuxCalls(fixture.tmuxCallsPath)
          .filter((call) => call.args[0] === "send-keys");
        assert.deepEqual(sends.map((call) => call.args), [
          ["send-keys", "-t", fixture.inputTarget, "-l", message],
          ["send-keys", "-t", fixture.inputTarget, "C-m"]
        ]);
        assert.equal(
          fixture.ttyViewportInspectionPids.length,
          0,
          "ordinary task delivery must not inherit the closed /status viewport gate"
        );
        const persistedTurn = listConversations(fixture.storeDir).find(
          (turn) => turn.turn_id === output.turn_id
        );
        assert.ok(persistedTurn);
        const anchor = (persistedTurn.native_session_takeover as
          Record<string, any>).codex_rollout_acceptance_anchor;
        assert.ok(anchor);
        assert.equal(anchor.version, 2);
        assert.equal(anchor.native_thread_binding, "post_submission");
        assert.equal("native_thread_id" in anchor, false);
        assert.equal(
          output.conversation.native_session_takeover
            .terminal_bridge_submission.acceptance_evidence.nativeThreadId,
          acceptedNativeThreadId
        );
      } finally {
        fixture.cleanup();
      }
    }
  );
}

/**
 * Deferred zero-input recovery migration inventory:
 *
 * - The four legacy cases below still execute the production reservation,
 *   Store, dispatch-ledger, cleanup, token-refresh, and later-send paths.
 * - Every crash point preserves the exact durable image at exit 86 before
 *   ordinary exception compensation can run. The source-Session reservation
 *   case remains the authoritative real-process boundary; the other three use
 *   the fixture-scoped hard-exit checkpoint described below.
 * - Recovery, retry, close, and later-send steps use the injected command
 *   boundary. All state, ledger, zero-input, single-input, and historical-
 *   liveness assertions stay shared.
 */
for (const crashCase of [
  {
    label: "source Session reservation before its transfer receipt",
    testName: "zero-input deferred source Session reservation before its transfer receipt recovery aborts safely before one refreshed retry",
    hook: "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_SESSION_RESERVED",
    expectedStatus: "prepared",
    addPreparedLedgerWithoutState: false
  },
  {
    label: "source reservation",
    testName: "zero-input deferred source reservation recovery aborts safely before one refreshed retry",
    hook: "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_RESERVED",
    expectedStatus: "source_reserved",
    addPreparedLedgerWithoutState: false
  },
  {
    label: "target preparation",
    testName: "zero-input deferred target preparation recovery aborts safely before one refreshed retry",
    hook: "AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_PREPARED",
    expectedStatus: "target_prepared",
    addPreparedLedgerWithoutState: false
  },
  {
    label: "prepared ledger before Turn state",
    testName: "zero-input deferred prepared ledger before Turn state recovery aborts safely before one refreshed retry",
    hook: "AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_PREPARED",
    expectedStatus: "target_prepared",
    addPreparedLedgerWithoutState: true
  }
] as const) {
  test(
    crashCase.testName,
    async (t) => {
      const fixture = createNoRolloutFixture({
        codexVersion: "0.147.0",
        rolloutInitiallyAbsent: true
      });
      const message = `Recover ${crashCase.label} without duplicate input.`;
      try {
        const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
        const action = await deferredForegroundSendAction(fixture);
        const args = deferredForegroundSendArgs(fixture, action, message);
        const crashEnvironment = {
          ...fixture.environment,
          AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
          AKK_SUBPROCESS_EVIDENCE_TEST_NAME: t.name,
          [crashCase.hook]: "1"
        };
        const crashed = crashCase.testName ===
          "zero-input deferred source Session reservation before its transfer receipt recovery aborts safely before one refreshed retry"
          ? runCliSubprocess(args, crashEnvironment)
          : await runCliCrashCheckpoint(args, crashEnvironment);
        assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);

        const transfer = soleDeferredForegroundTransfer(fixture);
        assert.equal(transfer.status, crashCase.expectedStatus);
        assert.equal(transfer.input_stage, "none");
        assert.equal(
          loadManagedSession(fixture.storeDir, source.session_id).status,
          "transitioning"
        );
        assert.deepEqual(taskInputCalls(fixture, message), []);
        assert.deepEqual(listConversations(fixture.storeDir), []);

        if (crashCase.addPreparedLedgerWithoutState) {
          materializePreparedDeferredLedgerWithoutTurnState({
            fixture,
            transfer,
            message
          });
          assert.equal(
            fs.existsSync(String(transfer.state_path)),
            false,
            "the prepared terminal ledger must remain an orphan fixture"
          );
        }

        // Recovery runs before terminal-token validation. The reservation is
        // durably aborted and the source restored, but that restoration bumps
        // its Session revision, so the old list token is intentionally stale.
        const recoveredWithStaleToken = await runCli(args, codexNativeAcceptanceEnv(fixture.environment));
        assert.equal(
          recoveredWithStaleToken.status,
          1,
          recoveredWithStaleToken.stderr || recoveredWithStaleToken.stdout
        );
        assert.match(
          recoveredWithStaleToken.stderr,
          /fresh exact terminal token|refresh AKK list/iu
        );
        const aborted = soleDeferredForegroundTransfer(fixture);
        assert.equal(aborted.status, "abort_resolved");
        assert.equal(aborted.input_stage, "none");
        assert.ok(aborted.abort_cleanup_completed_at);
        assert.equal(
          loadManagedSession(fixture.storeDir, source.session_id).status,
          "bound"
        );
        if (crashCase.addPreparedLedgerWithoutState) {
          assert.equal(
            loadManagedSession(
              fixture.storeDir,
              transfer.target_session_id
            ).status,
            "detached"
          );
        }
        assert.deepEqual(taskInputCalls(fixture, message), []);
        assert.deepEqual(listConversations(fixture.storeDir), []);

        const refreshedAction = await deferredForegroundSendAction(fixture);
        assert.equal(
          refreshedAction.arguments.expected_terminal_token,
          action.arguments.expected_terminal_token,
          "Store recovery must not stale unchanged physical authority"
        );
        assert.notEqual(
          refreshedAction.arguments.expected_managed_terminal_token,
          action.arguments.expected_managed_terminal_token
        );
        const retried = await runCli(
          deferredForegroundSendArgs(fixture, refreshedAction, message),
          codexNativeAcceptanceEnv(fixture.environment)
        );
        assert.equal(retried.status, 0, retried.stderr || retried.stdout);
        assert.equal(
          JSON.parse(retried.stdout).delivered,
          true,
          retried.stdout
        );
        assertSingleTaskInput(fixture, message);
        assert.deepEqual(
          listDeferredForegroundTransfers(fixture.storeDir).map(
            (candidate) => candidate.status
          ).sort(),
          ["abort_resolved", "resolved"]
        );
        const afterRetryList = await listFixtureTerminal(fixture);
        assert.notEqual(
          afterRetryList.management_state,
          "conflict",
          JSON.stringify(afterRetryList, null, 2)
        );
        const acceptedTurn = listConversations(fixture.storeDir).find(
          (candidate) => candidate.user_request === message
        );
        assert.ok(acceptedTurn);
        appendFixtureCompletion(fixture, NATIVE_THREAD_ID);
        const closed = await runCli([
          "close",
          "--turn",
          String(acceptedTurn.turn_id),
          "--reason",
          "test-only terminalization before historical abort liveness proof",
          "--store-dir",
          fixture.storeDir,
          "--codex-home",
          fs.realpathSync(fixture.codexHome)
        ], fixture.environment);
        assert.equal(closed.status, 0, closed.stderr || closed.stdout);
        assert.equal(JSON.parse(closed.stdout).closed, true, closed.stdout);
        fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
        // This legacy status-card fixture did not expose an lsof inventory
        // provider before its first accepted task materialized the rollout.
        // Subsequent rollout-backed v15 sends require that now-live exact root
        // to be available through the complete inventory seam.
        enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);

        const thirdMessage = `Continue after historical ${crashCase.label}.`;
        const thirdAction = await deferredForegroundSendAction(fixture);
        assert.equal(
          "session_id" in thirdAction.arguments,
          false,
          "rollout-backed Codex must remain terminal-follow-current"
        );
        assert.equal(
          typeof thirdAction.arguments.expected_terminal_token,
          "string"
        );
        const third = await runCli(
          deferredForegroundSendArgs(fixture, thirdAction, thirdMessage),
          codexNativeAcceptanceEnv(fixture.environment)
        );
        assert.equal(third.status, 0, third.stderr || third.stdout);
        assert.equal(JSON.parse(third.stdout).delivered, true, third.stdout);
        assert.deepEqual(taskInputCalls(fixture).map((call) => call.args), [
          ["send-keys", "-t", fixture.inputTarget, "-l", message],
          ["send-keys", "-t", fixture.inputTarget, "C-m"],
          ["send-keys", "-t", fixture.inputTarget, "-l", thirdMessage],
          ["send-keys", "-t", fixture.inputTarget, "C-m"]
        ]);
        const historicalAbort = listDeferredForegroundTransfers(
          fixture.storeDir
        ).find((candidate) => candidate.transfer_id === aborted.transfer_id);
        assert.deepEqual(
          historicalAbort,
          aborted,
          "later Session revisions must not reopen a completed abort receipt"
        );
      } finally {
        fixture.cleanup();
      }
    }
  );
}

// These two adjacent historical-ledger variants retain the exact durable
// hard-crash checkpoint and use the imported invariant boundary for recovery
// and retry. They uniquely prove that zero-input abort and refreshed retry
// never mutate an exact resolved predecessor ledger.
for (const crashCase of [
  {
    label: "source Session reservation before receipt",
    hook: "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_SESSION_RESERVED",
    expectedStatus: "prepared"
  },
  {
    label: "target preparation",
    hook: "AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_PREPARED",
    expectedStatus: "target_prepared"
  }
] as const) {
  test(
    `resolved dispatch history survives deferred ${crashCase.label} recovery`,
    async () => {
      const fixture = createNoRolloutFixture({
        codexVersion: "0.147.0",
        rolloutInitiallyAbsent: true
      });
      const message = `Send after resolved history and ${crashCase.label}.`;
      try {
        const { source, historicalTurnId } =
          await seedResolvedHistoricalDispatchAndStatusCard(fixture);
        const historicalLedger = readSoleTerminalDispatchLedger(fixture);
        assert.equal(historicalLedger.status, "resolved");
        assert.ok(historicalLedger.resolved_at);
        const callsBeforeCrash = readTmuxCalls(fixture.tmuxCallsPath)
          .filter((call) => call.args[0] === "send-keys");
        const conversationsBeforeCrash = listConversations(
          fixture.storeDir
        ).map((turn) => turn.turn_id);
        assert.deepEqual(conversationsBeforeCrash, [historicalTurnId]);

        const action = await deferredForegroundSendAction(fixture);
        const args = deferredForegroundSendArgs(fixture, action, message);
        const crashed = await runCliCrashCheckpoint(args, {
          ...fixture.environment,
          AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
          [crashCase.hook]: "1"
        });
        assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
        let transfer = soleDeferredForegroundTransfer(fixture);
        assert.equal(transfer.status, crashCase.expectedStatus);
        assert.equal(transfer.previous_dispatch_status, "resolved");
        assert.match(transfer.previous_dispatch_fingerprint, /^[0-9a-f]{64}$/u);
        assert.deepEqual(
          readSoleTerminalDispatchLedger(fixture),
          historicalLedger,
          "a pre-ledger crash must leave exact resolved history untouched"
        );
        assert.deepEqual(
          readTmuxCalls(fixture.tmuxCallsPath)
            .filter((call) => call.args[0] === "send-keys"),
          callsBeforeCrash
        );
        assert.deepEqual(
          listConversations(fixture.storeDir).map((turn) => turn.turn_id),
          conversationsBeforeCrash
        );

        const recoveredWithStaleToken = await runCli(args, codexNativeAcceptanceEnv(fixture.environment));
        assert.equal(
          recoveredWithStaleToken.status,
          1,
          recoveredWithStaleToken.stderr || recoveredWithStaleToken.stdout
        );
        assert.match(
          recoveredWithStaleToken.stderr,
          /fresh exact terminal token|refresh AKK list/iu
        );
        transfer = soleDeferredForegroundTransfer(fixture);
        assert.equal(transfer.status, "abort_resolved");
        assert.equal(transfer.abort_source_after_status, "bound");
        assert.equal(
          loadManagedSession(fixture.storeDir, source.session_id).status,
          "bound"
        );
        assert.deepEqual(
          readSoleTerminalDispatchLedger(fixture),
          historicalLedger
        );
        assert.deepEqual(
          readTmuxCalls(fixture.tmuxCallsPath)
            .filter((call) => call.args[0] === "send-keys"),
          callsBeforeCrash
        );

        const refreshed = await deferredForegroundSendAction(fixture);
        const retried = await runCli(
          deferredForegroundSendArgs(fixture, refreshed, message),
          codexNativeAcceptanceEnv(fixture.environment)
        );
        assert.equal(retried.status, 0, retried.stderr || retried.stdout);
        assert.equal(JSON.parse(retried.stdout).delivered, true, retried.stdout);
        const callsAfterRetry = readTmuxCalls(fixture.tmuxCallsPath)
          .filter((call) => call.args[0] === "send-keys");
        assert.deepEqual(
          callsAfterRetry.slice(callsBeforeCrash.length).map(
            (call) => call.args
          ),
          [
            ["send-keys", "-t", fixture.inputTarget, "-l", message],
            ["send-keys", "-t", fixture.inputTarget, "C-m"]
          ]
        );
        assert.deepEqual(
          listDeferredForegroundTransfers(fixture.storeDir).map(
            (candidate) => candidate.status
          ).sort(),
          ["abort_resolved", "resolved"]
        );
      } finally {
        fixture.cleanup();
      }
    }
  );
}

for (const historyCase of [
  {
    label: "no previous dispatch",
    seedResolvedHistory: false,
    previousDispatchStatus: "none"
  },
  {
    label: "a resolved previous dispatch",
    seedResolvedHistory: true,
    previousDispatchStatus: "resolved"
  }
] as const) {
  test(
    `pre-input abort receipts recover ${historyCase.label} without replay`,
    async () => {
      const fixture = createNoRolloutFixture({
        codexVersion: "0.147.0",
        rolloutInitiallyAbsent: true
      });
      const message = `Recover abort receipts after ${historyCase.label}.`;
      try {
        const source = historyCase.seedResolvedHistory
          ? (await seedResolvedHistoricalDispatchAndStatusCard(fixture)).source
          : persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
        const callsBeforeCrash = taskInputCalls(fixture);
        const action = await deferredForegroundSendAction(fixture);
        const args = deferredForegroundSendArgs(fixture, action, message);
        const crashed = await runCliCrashCheckpoint(args, {
          ...fixture.environment,
          AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
          AKK_TEST_TERMINAL_SETUP_FAILURE: "1",
          AKK_TEST_EXIT_AFTER_DEFERRED_PREINPUT_ABORT_RECEIPTS: "1"
        });
        assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);

        let transfer = soleDeferredForegroundTransfer(fixture);
        assert.equal(transfer.status, "target_prepared");
        assert.equal(transfer.input_stage, "none");
        assert.equal(
          transfer.previous_dispatch_status,
          historyCase.previousDispatchStatus
        );
        assert.equal(
          loadManagedSession(fixture.storeDir, source.session_id).status,
          "transitioning"
        );
        assert.equal(
          loadManagedSession(
            fixture.storeDir,
            transfer.target_session_id
          ).status,
          "transitioning"
        );
        const abortedTurn = listConversations(fixture.storeDir).find(
          (candidate) => candidate.user_request === message
        );
        assert.ok(abortedTurn);
        assert.equal(abortedTurn.status, "failed");
        const abortedSubmission = (
          abortedTurn.native_session_takeover as Record<string, any>
        ).terminal_bridge_submission;
        assert.equal(abortedSubmission.status, "aborted");
        assert.equal(abortedSubmission.safe_to_retry, true);
        assert.equal(abortedSubmission.text_injected_at, undefined);
        assert.equal(abortedSubmission.enter_dispatched_at, undefined);
        const abortLedger = readSoleTerminalDispatchLedger(fixture);
        assert.equal(abortLedger.status, "resolved");
        assert.equal(abortLedger.safe_to_retry, true);
        assert.ok(abortLedger.aborted_at);
        assert.equal(abortLedger.text_injected_at, undefined);
        assert.equal(abortLedger.enter_dispatched_at, undefined);
        assert.deepEqual(taskInputCalls(fixture), callsBeforeCrash);

        const recoveredWithStaleToken = await runCli(args, codexNativeAcceptanceEnv(fixture.environment));
        assert.equal(
          recoveredWithStaleToken.status,
          1,
          recoveredWithStaleToken.stderr || recoveredWithStaleToken.stdout
        );
        assert.match(
          recoveredWithStaleToken.stderr,
          /fresh exact terminal token|refresh AKK list/iu
        );
        transfer = soleDeferredForegroundTransfer(fixture);
        assert.equal(transfer.status, "abort_resolved");
        assert.equal(transfer.input_stage, "none");
        assert.ok(transfer.abort_cleanup_completed_at);
        assert.equal(
          loadManagedSession(fixture.storeDir, source.session_id).status,
          "bound"
        );
        assert.equal(
          loadManagedSession(
            fixture.storeDir,
            transfer.target_session_id
          ).status,
          "detached"
        );
        assert.deepEqual(taskInputCalls(fixture), callsBeforeCrash);

        const refreshedAction = await deferredForegroundSendAction(fixture);
        const retried = await runCli(
          deferredForegroundSendArgs(fixture, refreshedAction, message),
          codexNativeAcceptanceEnv(fixture.environment)
        );
        assert.equal(retried.status, 0, retried.stderr || retried.stdout);
        assert.equal(JSON.parse(retried.stdout).delivered, true, retried.stdout);
        assert.deepEqual(
          taskInputCalls(fixture).slice(callsBeforeCrash.length)
            .map((call) => call.args),
          [
            ["send-keys", "-t", fixture.inputTarget, "-l", message],
            ["send-keys", "-t", fixture.inputTarget, "C-m"]
          ]
        );
        assert.deepEqual(
          listDeferredForegroundTransfers(fixture.storeDir).map(
            (candidate) => candidate.status
          ).sort(),
          ["abort_resolved", "resolved"]
        );
        const afterRetryList = await listFixtureTerminal(fixture);
        assert.notEqual(
          afterRetryList.management_state,
          "conflict",
          JSON.stringify(afterRetryList, null, 2)
        );
        const acceptedTurn = listConversations(fixture.storeDir).find(
          (candidate) =>
            candidate.user_request === message &&
            candidate.status === "waiting_for_agent"
        );
        assert.ok(acceptedTurn);
        appendFixtureCompletion(fixture, NATIVE_THREAD_ID);
        const closed = await runCli([
          "close",
          "--turn",
          acceptedTurn.turn_id,
          "--reason",
          "test-only terminalization after pre-input abort receipt recovery",
          "--store-dir",
          fixture.storeDir,
          "--codex-home",
          fs.realpathSync(fixture.codexHome)
        ], fixture.environment);
        assert.equal(closed.status, 0, closed.stderr || closed.stdout);
        fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
        enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);

        const thirdMessage =
          `Continue after abort receipts with ${historyCase.label}.`;
        const thirdAction = await deferredForegroundSendAction(fixture);
        assert.equal(
          "session_id" in thirdAction.arguments,
          false,
          "rollout-backed Codex must remain terminal-follow-current"
        );
        assert.equal(
          typeof thirdAction.arguments.expected_terminal_token,
          "string"
        );
        const third = await runCli(
          deferredForegroundSendArgs(fixture, thirdAction, thirdMessage),
          codexNativeAcceptanceEnv(fixture.environment)
        );
        assert.equal(third.status, 0, third.stderr || third.stdout);
        assert.equal(JSON.parse(third.stdout).delivered, true, third.stdout);
        assert.deepEqual(
          taskInputCalls(fixture).slice(callsBeforeCrash.length)
            .map((call) => call.args),
          [
            ["send-keys", "-t", fixture.inputTarget, "-l", message],
            ["send-keys", "-t", fixture.inputTarget, "C-m"],
            ["send-keys", "-t", fixture.inputTarget, "-l", thirdMessage],
            ["send-keys", "-t", fixture.inputTarget, "C-m"]
          ]
        );
        assert.deepEqual(
          listDeferredForegroundTransfers(fixture.storeDir).find(
            (candidate) => candidate.transfer_id === transfer.transfer_id
          ),
          transfer,
          "later sends must not reopen the completed abort receipt"
        );
      } finally {
        fixture.cleanup();
      }
    }
  );
}

test("a missing deferred Turn survives a second crash after its exact ledger abort", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    rolloutInitiallyAbsent: true
  });
  const message = "Recover a missing Turn across two pre-input crashes.";
  try {
    const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const action = await deferredForegroundSendAction(fixture);
    const args = deferredForegroundSendArgs(fixture, action, message);
    const afterTargetPrepared = await runCliCrashCheckpoint(args, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_PREPARED: "1"
    });
    assert.equal(
      afterTargetPrepared.status,
      86,
      afterTargetPrepared.stderr || afterTargetPrepared.stdout
    );
    let transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "target_prepared");
    assert.equal(transfer.input_stage, "none");
    materializePreparedDeferredLedgerWithoutTurnState({
      fixture,
      transfer,
      message
    });
    assert.equal(fs.existsSync(String(transfer.state_path)), false);
    assert.equal(readSoleTerminalDispatchLedger(fixture).status, "prepared");
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);

    const afterLedgerAbort = await runCliCrashCheckpoint(args, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_EXIT_AFTER_DEFERRED_LEDGER_ABORT_WITHOUT_STATE: "1"
    });
    assert.equal(
      afterLedgerAbort.status,
      86,
      afterLedgerAbort.stderr || afterLedgerAbort.stdout
    );
    transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "target_prepared");
    assert.equal(transfer.input_stage, "none");
    assert.equal(fs.existsSync(String(transfer.state_path)), false);
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "transitioning"
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, transfer.target_session_id).status,
      "transitioning"
    );
    const abortedLedger = readSoleTerminalDispatchLedger(fixture);
    assertExactDeferredZeroInputAbortLedger({
      fixture,
      transfer,
      ledger: abortedLedger
    });
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);

    const recoveredWithStaleToken = await runCli(args, codexNativeAcceptanceEnv(fixture.environment));
    assert.equal(
      recoveredWithStaleToken.status,
      1,
      recoveredWithStaleToken.stderr || recoveredWithStaleToken.stdout
    );
    assert.match(
      recoveredWithStaleToken.stderr,
      /fresh exact terminal token|refresh AKK list/iu
    );
    transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "abort_resolved");
    assert.equal(transfer.input_stage, "none");
    assert.ok(transfer.abort_cleanup_completed_at);
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "bound"
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, transfer.target_session_id).status,
      "detached"
    );
    assert.deepEqual(readSoleTerminalDispatchLedger(fixture), abortedLedger);
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);

    const refreshedAction = await deferredForegroundSendAction(fixture);
    const retried = await runCli(
      deferredForegroundSendArgs(fixture, refreshedAction, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(JSON.parse(retried.stdout).delivered, true, retried.stdout);
    assertSingleTaskInput(fixture, message);
    const acceptedTurn = listConversations(fixture.storeDir).find(
      (candidate) =>
        candidate.user_request === message &&
        candidate.status === "waiting_for_agent"
    );
    assert.ok(acceptedTurn);
    appendFixtureCompletion(fixture, NATIVE_THREAD_ID);
    const closed = await runCli([
      "close",
      "--turn",
      acceptedTurn.turn_id,
      "--reason",
      "test-only terminalization after missing-Turn double-crash recovery",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fs.realpathSync(fixture.codexHome)
    ], fixture.environment);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    assert.equal(JSON.parse(closed.stdout).closed, true, closed.stdout);
    fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
    enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);

    const thirdMessage = "Continue after the missing-Turn abort receipt.";
    const thirdAction = await deferredForegroundSendAction(fixture);
    assert.equal(
      "session_id" in thirdAction.arguments,
      false,
      "rollout-backed Codex must remain terminal-follow-current"
    );
    assert.equal(
      typeof thirdAction.arguments.expected_terminal_token,
      "string"
    );
    const third = await runCli(
      deferredForegroundSendArgs(fixture, thirdAction, thirdMessage),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(third.status, 0, third.stderr || third.stdout);
    assert.equal(JSON.parse(third.stdout).delivered, true, third.stdout);
    assert.deepEqual(taskInputCalls(fixture).map((call) => call.args), [
      ["send-keys", "-t", fixture.inputTarget, "-l", message],
      ["send-keys", "-t", fixture.inputTarget, "C-m"],
      ["send-keys", "-t", fixture.inputTarget, "-l", thirdMessage],
      ["send-keys", "-t", fixture.inputTarget, "C-m"]
    ]);
    assert.deepEqual(
      listDeferredForegroundTransfers(fixture.storeDir).find(
        (candidate) => candidate.transfer_id === transfer.transfer_id
      ),
      transfer,
      "later sends must not reopen the double-crash abort receipt"
    );
  } finally {
    fixture.cleanup();
  }
});

for (const crashPoint of [
  "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_SCRUBBED",
  "AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_ACCEPTED"
] as const) {
  test(
    `same-UUID deferred recovery rolls forward ${crashPoint} without replay`,
    async () => {
      const fixture = createNoRolloutFixture({
        codexVersion: "0.147.0",
        rolloutInitiallyAbsent: true
      });
      const message = `Recover the same UUID after ${crashPoint}.`;
      try {
        const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
        const originalBinding = source.binding;
        const action = await deferredForegroundSendAction(fixture);
        const args = deferredForegroundSendArgs(fixture, action, message);
        const crashed = await runCliCrashCheckpoint(args, {
          ...fixture.environment,
          AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
          [crashPoint]: "1"
        });
        assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
        assertSingleTaskInput(fixture, message);

        const transfer = soleDeferredForegroundTransfer(fixture);
        assert.equal(transfer.status, "dispatch_started");
        assert.equal(transfer.input_stage, "enter_dispatched");
        const scrubbed = loadManagedSession(
          fixture.storeDir,
          source.session_id
        );
        assert.equal(scrubbed.status, "transitioning");
        assert.equal(scrubbed.binding?.native_thread_id, undefined);
        assert.equal(scrubbed.binding?.native_process.rollout, undefined);
        assert.notEqual(
          scrubbed.binding?.binding_id,
          originalBinding?.binding_id
        );
        assert.equal(
          scrubbed.binding?.generation,
          Number(originalBinding?.generation) + 1
        );

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
    }
  );
}

for (const crashPoint of [
  "AKK_TEST_EXIT_AFTER_DEFERRED_COMMITTED",
  "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_DETACHED",
  "AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_BOUND"
] as const) {
  test(
    `committed deferred recovery rolls forward ${crashPoint} without replay`,
    async () => {
      const fixture = createNoRolloutFixture({
        codexVersion: "0.147.0",
        rolloutInitiallyAbsent: true
      });
      const message = `Resolve the committed crash ${crashPoint}.`;
      try {
        const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
        const originalBinding = source.binding;
        const action = await deferredForegroundSendAction(fixture);
        const args = deferredForegroundSendArgs(fixture, action, message);
        const crashed = await runCliCrashCheckpoint(args, {
          ...fixture.environment,
          AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
          [crashPoint]: "1"
        });
        assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
        assert.equal(
          soleDeferredForegroundTransfer(fixture).status,
          "committed"
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
    }
  );
}

test("committed acceptance backfill survives a second recovery crash without replay", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    rolloutInitiallyAbsent: true
  });
  const message = "Recover committed acceptance across two crashes.";
  try {
    const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const originalBinding = source.binding;
    const action = await deferredForegroundSendAction(fixture);
    const args = deferredForegroundSendArgs(fixture, action, message);
    const afterCommit = await runCliCrashCheckpoint(args, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_EXIT_AFTER_DEFERRED_COMMITTED: "1"
    });
    assert.equal(afterCommit.status, 86, afterCommit.stderr || afterCommit.stdout);
    let transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "committed");
    assertSingleTaskInput(fixture, message);

    const afterAcceptanceBackfill = await runCliCrashCheckpoint(args, {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_EXIT_AFTER_DEFERRED_COMMITTED_ACCEPTANCE_BACKFILL: "1"
    });
    assert.equal(
      afterAcceptanceBackfill.status,
      86,
      afterAcceptanceBackfill.stderr || afterAcceptanceBackfill.stdout
    );
    transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "committed");
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "transitioning"
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, transfer.target_session_id).status,
      "transitioning"
    );
    const acceptedTurn = listConversations(fixture.storeDir).find(
      (candidate) => candidate.turn_id === transfer.turn_id
    );
    assert.ok(acceptedTurn);
    assert.equal(acceptedTurn.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      (acceptedTurn.native_session_takeover as Record<string, any>)
        .terminal_bridge_submission?.status,
      "agent_accepted"
    );
    const acceptedLedger = readSoleTerminalDispatchLedger(fixture);
    assert.equal(acceptedLedger.status, "agent_accepted");
    assert.equal(acceptedLedger.dispatcher_pid, null);
    assert.equal(
      acceptedLedger.deferred_foreground_transfer_id,
      transfer.transfer_id
    );
    assert.equal(acceptedLedger.generation_id, transfer.message_id);
    assert.equal(acceptedLedger.conversation_id, transfer.turn_id);
    assert.equal(acceptedLedger.session_id, transfer.target_session_id);
    assert.equal(acceptedLedger.turn_id, transfer.turn_id);
    assert.equal(acceptedLedger.message_id, transfer.message_id);
    assert.equal(acceptedLedger.request_hash, transfer.request_hash);
    assert.equal(acceptedLedger.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      acceptedLedger.binding_id,
      transfer.target_accepted_binding?.binding_id
    );
    assert.equal(
      acceptedLedger.binding_generation,
      transfer.target_accepted_binding?.generation
    );
    assert.equal(acceptedLedger.agent_accepted_at, transfer.agent_accepted_at);
    assert.equal(
      acceptedLedger.acceptance_evidence?.nativeThreadId,
      NATIVE_THREAD_ID
    );
    assert.equal(
      acceptedLedger.acceptance_evidence?.requestHash,
      transfer.request_hash
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
    assert.deepEqual(readSoleTerminalDispatchLedger(fixture), acceptedLedger);
    assertSingleTaskInput(fixture, message);
  } finally {
    fixture.cleanup();
  }
});

test("managed approve and cancel cannot bypass committed deferred recovery", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    rolloutInitiallyAbsent: true
  });
  const message = "Fence managed controls until committed recovery finishes.";
  try {
    persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const action = await deferredForegroundSendAction(fixture);
    const args = deferredForegroundSendArgs(fixture, action, message);
    const committedCrash = await runCliCrashCheckpoint(
      args,
      {
        ...fixture.environment,
        AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
        AKK_TEST_EXIT_AFTER_DEFERRED_COMMITTED: "1"
      }
    );
    assert.equal(
      committedCrash.status,
      86,
      committedCrash.stderr || committedCrash.stdout
    );
    const targetBoundCrash = await runCliCrashCheckpoint(
      args,
      {
        ...fixture.environment,
        AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
        AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_BOUND: "1"
      }
    );
    assert.equal(
      targetBoundCrash.status,
      86,
      targetBoundCrash.stderr || targetBoundCrash.stdout
    );

    const transfer = soleDeferredForegroundTransfer(fixture);
    assert.equal(transfer.status, "committed");
    assert.equal(
      loadManagedSession(fixture.storeDir, transfer.target_session_id).status,
      "bound"
    );
    const turn = listConversations(fixture.storeDir)[0];
    assert.ok(turn);
    assert.equal(turn.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      (turn.native_session_takeover as Record<string, any>)
        .terminal_bridge_submission?.status,
      "agent_accepted"
    );
    assert.equal(readSoleTerminalDispatchLedger(fixture).status, "agent_accepted");
    const sendsBeforeControls = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");

    for (const command of ["approve", "cancel"] as const) {
      const blocked = await runCli([
        command,
        "--turn",
        turn.turn_id,
        "--store-dir",
        fixture.storeDir,
        "--codex-home",
        fs.realpathSync(fixture.codexHome),
        "--disable-terminal-bridge-monitor"
      ], fixture.environment);
      assert.equal(blocked.status, 1, blocked.stdout);
      assert.match(
        blocked.stderr,
        new RegExp(
          `cannot ${command} Turn .* while deferred foreground transfer .* ` +
            "is committed; dedicated transfer recovery must finish first",
          "u"
        )
      );
      assert.deepEqual(
        readTmuxCalls(fixture.tmuxCallsPath)
          .filter((call) => call.args[0] === "send-keys"),
        sendsBeforeControls,
        `${command} must send zero terminal keys before dedicated recovery`
      );
      assert.deepEqual(soleDeferredForegroundTransfer(fixture), transfer);
    }
  } finally {
    fixture.cleanup();
  }
});
