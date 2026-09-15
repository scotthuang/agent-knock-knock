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

test("virgin raw Codex attach atomically refines the Session and Turn binding after send", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const sent = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "Start the first native Codex thread.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], fixture.environment);

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true, sent.stdout);
    assert.equal(output.status, "async_pending");
    assert.equal(output.conversation.status, "waiting_for_agent");
    assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      output.conversation.native_session_takeover.terminal_agent_session_id,
      NATIVE_THREAD_ID
    );

    const session = loadManagedSession(fixture.storeDir, output.session_id);
    assert.equal(session.status, "bound");
    assert.equal(session.binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      session.binding?.binding_id,
      output.conversation.terminal_binding_id
    );
    assert.equal(
      session.binding?.generation,
      output.conversation.terminal_binding_generation
    );
    assert.equal(session.binding?.generation, 1);
    assert.equal(
      session.binding?.native_process.process_birth,
      LIVE_PROCESS_BIRTH
    );
    assert.equal(
      session.binding?.native_process.process_uuid,
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH)
    );
    assert.equal(
      fs.realpathSync(session.binding?.native_process.rollout?.path as string),
      fs.realpathSync(fixture.rolloutPath)
    );

    const turns = listConversations(fixture.storeDir);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].session_id, session.session_id);
    assert.equal(turns[0].turn_id, output.turn_id);
    assert.equal(turns[0].terminal_binding_id, session.binding?.binding_id);
    assert.equal(
      turns[0].terminal_binding_generation,
      session.binding?.generation
    );
    assert.equal(turns[0].native_thread_id, NATIVE_THREAD_ID);

    const sends = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(sends.at(-2)?.args, [
      "send-keys",
      "-t",
      fixture.inputTarget,
      "-l",
      "Start the first native Codex thread."
    ]);
    assert.deepEqual(sends.at(-1)?.args, [
      "send-keys",
      "-t",
      fixture.inputTarget,
      "C-m"
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("production-mode virgin Codex first send creates and binds its exact rollout", async () => {
  const fixture = createNoRolloutFixture({ rolloutInitiallyAbsent: true });
  const environment = codexNativeAcceptanceEnv(fixture.environment);
  try {
    assert.equal(fs.existsSync(path.dirname(fixture.rolloutPath)), false);
    const result = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "Open the first real Codex thread.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], environment);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    const persistedTurn = listConversations(fixture.storeDir)[0];
    const persistedAnchor = (persistedTurn.native_session_takeover as
      Record<string, any>).codex_rollout_acceptance_anchor;
    const rolloutHeader = JSON.parse(
      fs.readFileSync(fixture.rolloutPath, "utf8").split("\n")[0]
    );
    assert.ok(
      Date.parse(rolloutHeader.timestamp) >=
        Date.parse(persistedAnchor.captured_at),
      JSON.stringify({ rolloutHeader, persistedAnchor }, null, 2)
    );
    assert.equal(output.delivered, true, result.stdout);
    assert.equal(output.delivery_receipt, "agent_accepted");
    assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
    const takeover = output.conversation.native_session_takeover;
    assert.equal(takeover.terminal_agent_session_id, NATIVE_THREAD_ID);
    assert.equal(persistedAnchor.version, 2);
    assert.equal(
      persistedAnchor.native_thread_binding,
      "post_submission"
    );
    assert.equal(
      "native_thread_id" in persistedAnchor,
      false
    );
    assert.equal(
      persistedAnchor.process_birth,
      LIVE_PROCESS_BIRTH
    );
    assert.equal(
      takeover.terminal_bridge_submission.acceptance_evidence.nativeThreadId,
      NATIVE_THREAD_ID
    );
    assert.equal(fs.existsSync(fixture.rolloutPath), true);

    const sessions = listManagedSessions(fixture.storeDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, "bound");
    assert.equal(sessions[0].binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      sessions[0].binding?.native_process.process_birth,
      LIVE_PROCESS_BIRTH
    );
    const turns = listConversations(fixture.storeDir);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].native_thread_id, NATIVE_THREAD_ID);

    const taskSends = readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
      call.args[0] === "send-keys" &&
      (
        call.args.includes("-l") ||
        call.args.at(-1) === "C-m"
      )
    );
    assert.deepEqual(taskSends.map((call) => call.args), [
      [
        "send-keys",
        "-t",
        fixture.inputTarget,
        "-l",
        "Open the first real Codex thread."
      ],
      ["send-keys", "-t", fixture.inputTarget, "C-m"]
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("virgin Codex binding recovery closes both post-Enter crash windows without replay", async () => {
  const crashPoints = [
    {
      env: "AKK_TEST_EXIT_AFTER_VIRGIN_ENTER_DISPATCHED",
      expectedSessionThread: undefined
    },
    {
      env: "AKK_TEST_EXIT_AFTER_VIRGIN_SESSION_BINDING",
      expectedSessionThread: NATIVE_THREAD_ID
    }
  ] as const;

  for (const crashPoint of crashPoints) {
    const fixture = createNoRolloutFixture({ rolloutInitiallyAbsent: true });
    const environment = {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      [crashPoint.env]: "1"
    };
    try {
      const crashed = await runCliCrashCheckpoint([
        "send",
        "--conversation",
        fixture.terminalId,
        "--message",
        `Recover exactly once after ${crashPoint.env}.`,
        ...codexNoRolloutBackgroundSendArgs(fixture)
      ], environment);
      assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);

      const beforeTurn = listConversations(fixture.storeDir)[0];
      const beforeSession = listManagedSessions(fixture.storeDir)[0];
      assert.ok(beforeTurn);
      assert.ok(beforeSession);
      assert.equal(beforeTurn.native_thread_id, undefined);
      assert.equal(
        (beforeTurn.native_session_takeover as Record<string, any>)
          .terminal_bridge_submission?.status,
        "enter_dispatched"
      );
      assert.equal(
        beforeSession.binding?.native_thread_id,
        crashPoint.expectedSessionThread
      );
      assert.equal(
        readTmuxCalls(fixture.tmuxCallsPath)
          .filter((call) => call.args.at(-1) === "C-m").length,
        1
      );

      const reconcileArgs = [
        "reconcile-monitors",
        ...codexNoRolloutStoreArgs(fixture),
        "--terminal-monitors-only",
        "--disable-terminal-bridge-monitor"
      ];
      const recovered = await runCli(reconcileArgs, fixture.environment);
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
      assert.equal(JSON.parse(recovered.stdout).launched, 0);

      const afterTurn = listConversations(fixture.storeDir)[0];
      const afterSession = loadManagedSession(
        fixture.storeDir,
        beforeSession.session_id
      );
      assert.equal(
        afterTurn.native_thread_id,
        NATIVE_THREAD_ID,
        `${crashPoint.env}: ${recovered.stdout || recovered.stderr}`
      );
      assert.equal(
        (afterTurn.native_session_takeover as Record<string, any>)
          .terminal_agent_session_id,
        NATIVE_THREAD_ID
      );
      assert.equal(
        (afterTurn.native_session_takeover as Record<string, any>)
          .terminal_bridge_submission?.status,
        "enter_dispatched",
        "binding repair must not forge an acceptance receipt"
      );
      assert.equal(afterSession.status, "bound");
      assert.equal(afterSession.binding?.native_thread_id, NATIVE_THREAD_ID);
      assert.equal(
        afterSession.binding?.binding_id,
        afterTurn.terminal_binding_id
      );
      assert.equal(
        afterSession.binding?.generation,
        afterTurn.terminal_binding_generation
      );
      assert.equal(
        afterSession.binding?.native_process.process_birth,
        LIVE_PROCESS_BIRTH
      );
      assert.equal(
        fs.realpathSync(
          afterSession.binding?.native_process.rollout?.path as string
        ),
        fs.realpathSync(fixture.rolloutPath)
      );

      const callsAfterRecovery = readTmuxCalls(fixture.tmuxCallsPath);
      assert.equal(
        callsAfterRecovery.filter((call) => call.args.at(-1) === "C-m").length,
        1,
        "recovery must never replay Enter"
      );
      assert.equal(
        callsAfterRecovery.filter((call) =>
          call.args.includes(`Recover exactly once after ${crashPoint.env}.`)
        ).length,
        1,
        "recovery must never replay task text"
      );

      const recoveredAgain = await runCli(
        reconcileArgs,
        fixture.environment
      );
      assert.equal(
        recoveredAgain.status,
        0,
        recoveredAgain.stderr || recoveredAgain.stdout
      );
      assert.equal(
        readTmuxCalls(fixture.tmuxCallsPath)
          .filter((call) => call.args.at(-1) === "C-m").length,
        1,
        "idempotent reconciliation must not replay Enter"
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("monitor binds a virgin Codex before accepting evidence that lands between probes", async () => {
  const fixture = createNoRolloutFixture({ rolloutInitiallyAbsent: true });
  const request = "Recover an acceptance record that lands between probes.";
  try {
    const crashed = await runCliCrashCheckpoint([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      request,
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_EXIT_AFTER_VIRGIN_ENTER_DISPATCHED: "1"
    });
    assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);

    const crashedTurn = listConversations(fixture.storeDir)[0];
    assert.ok(crashedTurn);
    const statePath = String(crashedTurn.state_path ?? "");
    const eventLogPath = String(crashedTurn.event_log_path ?? "");
    assert.ok(statePath);
    assert.ok(eventLogPath);
    const takeover = crashedTurn.native_session_takeover as Record<string, any>;
    const header = fs.readFileSync(fixture.rolloutPath, "utf8").split("\n")[0];
    fs.writeFileSync(fixture.rolloutPath, `${header}\n`, { mode: 0o600 });
    fs.writeFileSync(fixture.rolloutProbeCountPath, "0");
    fixture.appendAcceptanceOnProbe = 2;
    fixture.deferredAcceptanceRequest = request;
    fs.writeFileSync(fixture.screenPath, "Working\n");

    const monitored = await runCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      eventLogPath,
      ...codexNoRolloutStoreArgs(fixture),
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "1",
      "--agent-hard-timeout-minutes",
      "2"
    ], codexNativeAcceptanceEnv(fixture.environment));
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);

    const finalTurn = listConversations(fixture.storeDir)[0];
    const finalSession = loadManagedSession(
      fixture.storeDir,
      finalTurn.session_id
    );
    const finalTakeover = finalTurn.native_session_takeover as Record<string, any>;
    assert.equal(finalTurn.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(finalSession.binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      finalTakeover.terminal_bridge_submission?.status,
      "agent_accepted"
    );
    assert.equal(
      finalTakeover.terminal_bridge_submission?.acceptance_evidence
        ?.nativeThreadId,
      NATIVE_THREAD_ID
    );
    assert.equal(finalTurn.status, "idle");
    assert.equal(finalTurn.gateway_method, undefined);
    assert.equal(finalTurn.callback_delivery, undefined);
    assert.doesNotMatch(
      fs.readFileSync(eventLogPath, "utf8"),
      /callback_delivery_(?:pending|failed)|callback_outbox/u
    );
    assert.ok(
      Number(fs.readFileSync(fixture.rolloutProbeCountPath, "utf8")) >= 3,
      "the test must exercise pending recovery, acceptance, then exact rebind"
    );
    const recoveryEvents = fs.readFileSync(
      eventLogPath,
      "utf8"
    )
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) =>
        event.event === "virgin_codex_post_submission_binding_recovered"
      );
    assert.equal(recoveryEvents.length, 1);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .filter((call) => call.args.at(-1) === "C-m").length,
      1,
      "the monitor race repair must never replay Enter"
    );
  } finally {
    fixture.cleanup();
  }
});

test("virgin Codex process drift after Enter quarantines the provisional binding", async () => {
  const fixture = createNoRolloutFixture({ rolloutInitiallyAbsent: true });
  try {
    const result = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "This task must stay pinned to the original Codex process.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0",
      AKK_TEST_PROCESS_BIRTH_AFTER_ENTER: STALE_PROCESS_BIRTH
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.delivered, true);
    assert.equal(output.terminal_input_dispatched, true);
    assert.equal(output.agent_acceptance, "unproven");
    assert.equal(output.status, "submission_uncertain");
    assert.equal(output.do_not_retry, true);
    assert.match(
      output.reason,
      /process or native thread identity changed during acceptance polling/u
    );
    const sessions = listManagedSessions(fixture.storeDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, "quarantined");
    assert.equal(sessions[0].binding?.native_thread_id, undefined);
    assert.equal(
      sessions[0].binding?.native_process.process_birth,
      LIVE_PROCESS_BIRTH
    );
    const turns = listConversations(fixture.storeDir);
    assert.equal(turns.length, 1);
    const takeover = turns[0].native_session_takeover as Record<string, any>;
    assert.equal(
      takeover.terminal_bridge_submission?.status,
      "uncertain"
    );
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .filter((call) => call.args.at(-1) === "C-m").length,
      1,
      "an uncertain first submission must never retry Enter"
    );
  } finally {
    fixture.cleanup();
  }
});

test("a rollout appearing between raw discovery and send preflight fails cleanly", async () => {
  const fixture = createNoRolloutFixture({
    materializeRolloutOnProbe: 2,
    persistedCandidate: true
  });
  const environment = codexNativeAcceptanceEnv(fixture.environment);
  try {
    const raced = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "This task must not cross a newly materialized identity boundary.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], environment);

    assert.equal(raced.status, 1, raced.stdout);
    assert.match(
      raced.stderr,
      /native agent session appeared while preparing an unmaterialized terminal binding/u
    );
    assert.equal(fs.existsSync(fixture.materializedPath), true);
    assert.equal(
      Number(fs.readFileSync(fixture.rolloutProbeCountPath, "utf8")),
      2
    );
    assert.deepEqual(listManagedSessions(fixture.storeDir), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false,
      "neither task text nor Enter may cross the identity race"
    );

    const terminal = await listFixtureTerminal({ ...fixture, environment });
    assert.equal(terminal.management_state, "unmanaged");
    assert.ok(terminal.available_actions.new_thread);
    assert.ok(terminal.available_actions.list_resumable_threads);
    assert.equal(terminal.available_actions.reconcile_binding, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("a virgin attach setup failure CAS-detaches the Session before any task input", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const aborted = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "This task must stop during pre-transport setup.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], {
      ...fixture.environment,
      AKK_TEST_TERMINAL_SETUP_FAILURE: "1"
    });
    assert.equal(aborted.status, 0, aborted.stderr || aborted.stdout);
    const output = JSON.parse(aborted.stdout);
    assert.equal(output.submission_outcome, "aborted");
    assert.equal(output.delivered, false);
    assert.equal(output.safe_to_retry, true);
    const sessions = listManagedSessions(fixture.storeDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, "detached");
    assert.equal(sessions[0].binding?.native_thread_id, undefined);
    assert.equal(listConversations(fixture.storeDir).length, 1);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).some((call) =>
        call.args[0] === "send-keys" &&
        call.args.includes("-l") &&
        call.args.at(-1) ===
          "This task must stop during pre-transport setup."
      ),
      false
    );
    const terminal = await listFixtureTerminal(fixture);
    assert.notEqual(terminal.management_state, "conflict");
    assert.equal(terminal.available_actions.reconcile_binding, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("a proved tmux text-dispatch failure also detaches the virgin Session", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const aborted = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "This text dispatch must fail before reaching the composer.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], {
      ...fixture.environment,
      AKK_TEST_TMUX_TEXT_FAILURE: "1"
    });
    assert.equal(aborted.status, 0, aborted.stderr || aborted.stdout);
    const output = JSON.parse(aborted.stdout);
    assert.equal(output.submission_outcome, "aborted");
    assert.equal(output.safe_to_retry, true);
    assert.equal(output.delivered, false);
    const sessions = listManagedSessions(fixture.storeDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, "detached");
    assert.equal(sessions[0].binding?.native_thread_id, undefined);
    assert.equal(fs.existsSync(fixture.materializedPath), false);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args.at(-1) === "C-m"),
      false
    );
    assert.notEqual(
      (await listFixtureTerminal(fixture)).management_state,
      "conflict"
    );
  } finally {
    fixture.cleanup();
  }
});

test("native New and Resume remain reachable after draft-blocked virgin attaches", async () => {
  const fixture = createNoRolloutFixture({ persistedCandidate: true });
  const productionEnvironment = codexNativeAcceptanceEnv(fixture.environment);
  try {
    fs.writeFileSync(
      fixture.screenPath,
      codexTestComposerScreen("existing operator draft")
    );
    const rejected = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "Blocked by the operator draft before resume.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], productionEnvironment);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(
      rejected.stderr,
      /terminal is unknown, not idle|composer contains non-placeholder input/u
    );
    assert.deepEqual(listManagedSessions(fixture.storeDir), []);
    fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());

    const terminal = await listFixtureTerminal({
      ...fixture,
      environment: productionEnvironment
    });
    assert.equal(terminal.management_state, "unmanaged");
    const listed = await runCli([
      "list-resumable-threads",
      "--terminal",
      fixture.terminalId,
      ...codexNoRolloutStoreArgs(fixture)
    ], productionEnvironment);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const snapshot = JSON.parse(listed.stdout);
    const candidate = snapshot.threads.find(
      (entry: Record<string, unknown>) => entry.resumable === true
    );
    assert.ok(candidate, listed.stdout);
    const resumed = await runCli([
      "resume-thread",
      "--terminal",
      fixture.terminalId,
      "--native-thread",
      String(candidate.native_thread_id),
      "--expected-binding-token",
      String(snapshot.expected_binding_token),
      "--candidate-token",
      String(candidate.candidate_token),
      ...codexNoRolloutStoreArgs(fixture)
    ], productionEnvironment);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.equal(JSON.parse(resumed.stdout).status, "already_active");
    assert.doesNotMatch(
      `${resumed.stderr}\n${resumed.stdout}`,
      /changed native thread outside AKK|must be reconciled explicitly/u
    );
  } finally {
    fixture.cleanup();
  }

  const newFixture = createNoRolloutFixture({ persistedCandidate: true });
  const newEnvironment = {
    ...newFixture.environment,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
  };
  try {
    fs.writeFileSync(
      newFixture.screenPath,
      codexTestComposerScreen("another existing operator draft")
    );
    const rejected = await runCli([
      "send",
      "--conversation",
      newFixture.terminalId,
      "--message",
      "Blocked by the operator draft before new.",
      "--background",
      "--store-dir",
      newFixture.storeDir,
      "--codex-home",
      newFixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], newEnvironment);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(
      rejected.stderr,
      /terminal is unknown, not idle|composer contains non-placeholder input/u
    );
    assert.deepEqual(listManagedSessions(newFixture.storeDir), []);
    fs.writeFileSync(newFixture.screenPath, codexTestComposerScreen());

    const terminal = await listFixtureTerminal({
      ...newFixture,
      environment: newEnvironment
    });
    const action = terminal.available_actions.new_thread;
    assert.ok(action, JSON.stringify(terminal.available_actions));
    const prepared = await runCliCrashCheckpoint([
      "new-thread",
      "--terminal",
      newFixture.terminalId,
      "--expected-binding-token",
      String(action.arguments.expected_binding_token),
      "--store-dir",
      newFixture.storeDir,
      "--codex-home",
      newFixture.codexHome
    ], {
      ...newEnvironment,
      AKK_TEST_EXIT_AFTER_LIFECYCLE_PREPARED: "1"
    });
    assert.equal(prepared.status, 86, prepared.stderr || prepared.stdout);
    assert.doesNotMatch(prepared.stderr, /changed native thread outside AKK/u);
  } finally {
    newFixture.cleanup();
  }
});

test("a provisional attach orphan keeps fenced reconciliation alongside user-priority Send", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const orphan = persistConflictSession(fixture, {
      sessionId: "session-provisional-attach-orphan"
    });
    const terminal = await listFixtureTerminal(fixture);
    assert.equal(terminal.management_state, "conflict");
    assert.equal(terminal.management_conflict.kind, "provisional_orphan");
    assert.deepEqual(Object.keys(terminal.available_actions), [
      "status",
      "identify_foreground",
      "identify_and_send",
      "reconcile_binding",
      "send"
    ]);
    assertTerminalUserExplicitSendAction(terminal);
    const action = terminal.available_actions.reconcile_binding;
    assert.equal(action.requires_user_intent, true);
    assert.deepEqual(action.arguments, {
      terminal_id: fixture.terminalId,
      conflicting_session_id: orphan.session_id,
      expected_session_revision: orphan.revision,
      expected_binding_token: managedSessionBindingToken(orphan),
      expected_terminal_token: terminal.lifecycle_binding_token
    });

    const staleSession = await runCli(reconcileArguments(fixture, {
      ...action.arguments,
      expected_session_revision: (orphan.revision as number) + 1
    }), fixture.environment);
    assert.equal(staleSession.status, 1, staleSession.stdout);
    assert.match(
      staleSession.stderr,
      /managed Session binding changed.*refresh AKK list/u
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, orphan.session_id).status,
      "bound"
    );

    const stale = await runCli(reconcileArguments(fixture, {
      ...action.arguments,
      expected_terminal_token: "stale-terminal-token"
    }), fixture.environment);
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(stale.stderr, /terminal identity changed.*refresh AKK list/u);
    assert.equal(
      loadManagedSession(fixture.storeDir, orphan.session_id).status,
      "bound"
    );

    const reconciled = await runCli(
      reconcileArguments(fixture, action.arguments),
      fixture.environment
    );
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const output = JSON.parse(reconciled.stdout);
    assert.equal(output.status, "reconciled");
    assert.equal(output.conflict_kind, "provisional_orphan");
    assert.equal(output.terminal_input_sent, false);
    assert.equal(output.turn_created, false);
    const detached = loadManagedSession(fixture.storeDir, orphan.session_id);
    assert.equal(detached.status, "detached");
    assert.equal(detached.revision, (orphan.revision as number) + 1);
    assert.equal(detached.binding?.binding_id, orphan.binding?.binding_id);
    assert.deepEqual(listConversations(fixture.storeDir), []);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false
    );

    const refreshed = await listFixtureTerminal(fixture);
    assert.equal(refreshed.management_state, "unmanaged");
    assert.equal(refreshed.available_actions.reconcile_binding, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("a same-process external native-thread change keeps exact reconcile alongside handoff send", async () => {
  const fixture = createNoRolloutFixture();
  try {
    fs.writeFileSync(fixture.materializedPath, "ready");
    const session = persistConflictSession(fixture, {
      sessionId: "session-live-external-thread",
      nativeThreadId: EXTERNAL_THREAD_ID,
      processBirth: LIVE_PROCESS_BIRTH
    });
    const terminal = await listFixtureTerminal(fixture);
    assert.equal(terminal.native_agent_session_id, NATIVE_THREAD_ID);
    assert.equal(terminal.management_state, "conflict");
    assert.equal(
      terminal.management_conflict.kind,
      "live_external_thread_change"
    );
    assert.equal(terminal.handoff_state, "external_handoff_adoptable");
    assert.deepEqual(Object.keys(terminal.available_actions), [
      "status",
      "send",
      "reconcile_binding"
    ]);
    assert.equal(
      terminal.available_actions.send.arguments.selector,
      fixture.terminalId
    );
    assert.equal(
      typeof terminal.available_actions.send.arguments.expected_terminal_token,
      "string"
    );

    const reconciled = await runCli(
      reconcileArguments(
        fixture,
        terminal.available_actions.reconcile_binding.arguments
      ),
      fixture.environment
    );
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    assert.equal(
      JSON.parse(reconciled.stdout).conflict_kind,
      "live_external_thread_change"
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, session.session_id).status,
      "detached"
    );
    assert.deepEqual(listConversations(fixture.storeDir), []);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("a proved Codex PID reuse ignores the stale binding without adopting its native thread", async () => {
  const fixture = createNoRolloutFixture();
  try {
    fs.writeFileSync(fixture.materializedPath, "ready");
    const stale = persistConflictSession(fixture, {
      sessionId: "session-reused-pid-stale-incarnation",
      nativeThreadId: EXTERNAL_THREAD_ID,
      processBirth: STALE_PROCESS_BIRTH
    });
    const terminal = await listFixtureTerminal(fixture);
    assert.equal(terminal.management_state, "unmanaged");
    assert.equal(terminal.managed.session_id, null);
    assert.equal(terminal.available_actions.reconcile_binding, undefined);
    assert.equal(
      terminal.available_actions.list_resumable_threads.arguments.terminal_id,
      fixture.terminalId
    );
    const unchanged = loadManagedSession(fixture.storeDir, stale.session_id);
    assert.equal(unchanged.status, "bound");
    assert.equal(unchanged.binding?.native_thread_id, EXTERNAL_THREAD_ID);

    const sent = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "Control the proved replacement process without adopting stale history.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], fixture.environment);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true);
    assert.notEqual(output.session_id, stale.session_id);
    assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(listManagedSessions(fixture.storeDir).length, 2);
    assert.equal(
      loadManagedSession(fixture.storeDir, stale.session_id).status,
      "bound"
    );
  } finally {
    fixture.cleanup();
  }
});

test("a verified-empty Codex process detaches its ended rollout and starts one isolated virgin Session", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  try {
    const source = persistExactEndedRolloutSession(fixture);
    fs.writeFileSync(
      fixture.screenPath,
      "Token usage: 1,234\n" +
      `To continue this session, run codex resume ${NATIVE_THREAD_ID}\n\n` +
      "› \u001b[2mRun /review on my current changes\u001b[0m\n" +
      CODEX_TEST_COMPOSER_FOOTER
    );

    const terminal = await listFixtureTerminal(fixture);
    assert.equal(terminal.activity_state, "idle");
    assert.equal(
      terminal.native_agent_identity_observation.status,
      "verified_absent"
    );
    assert.equal(terminal.management_state, "conflict");
    assert.equal(
      terminal.management_conflict.kind,
      "verified_empty_native_session",
      JSON.stringify(terminal, null, 2)
    );
    assert.match(
      terminal.management_conflict.recovery,
      /snapshot-bound send action/u
    );
    assert.equal(
      terminal.handoff_state,
      "verified_empty_native_session_adoptable",
      JSON.stringify(terminal, null, 2)
    );
    const action = terminal.available_actions.send;
    assert.equal(action.arguments.selector, fixture.terminalId);
    assert.equal(typeof action.arguments.expected_terminal_token, "string");

    fixture.activeNativeThreadId = EXTERNAL_THREAD_ID;
    fixture.activeRolloutPath = path.join(
      path.dirname(fixture.rolloutPath),
      `rollout-2026-08-11T03-00-00-${EXTERNAL_THREAD_ID}.jsonl`
    );
    const sent = await runCli([
      "send",
      "--conversation",
      String(action.arguments.selector),
      "--expected-terminal-token",
      String(action.arguments.expected_terminal_token),
      "--message",
      "Continue in a fresh Codex thread without reusing the ended binding.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], fixture.environment);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true, sent.stdout);
    assert.equal(output.conversation.native_thread_id, EXTERNAL_THREAD_ID);
    assert.notEqual(output.session_id, source.session_id);

    const sessions = listManagedSessions(fixture.storeDir);
    const detachedSource = sessions.find((candidate) =>
      candidate.session_id === source.session_id
    );
    const attachedTarget = sessions.find((candidate) =>
      candidate.session_id === output.session_id
    );
    assert.equal(detachedSource?.status, "detached");
    assert.equal(detachedSource?.binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(attachedTarget?.status, "bound");
    assert.equal(
      attachedTarget?.binding?.native_thread_id,
      EXTERNAL_THREAD_ID
    );
    assert.equal(attachedTarget?.binding?.generation, 1);

    const taskInput = readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
      call.args[0] === "send-keys" &&
      (call.args.includes("-l") || call.args.at(-1) === "C-m")
    );
    assert.equal(
      taskInput.filter((call) => call.args.includes("-l")).length,
      1
    );
    assert.equal(
      taskInput.filter((call) => call.args.at(-1) === "C-m").length,
      1
    );

    const explicitOldSession = await runCli([
      "send",
      "--session",
      source.session_id,
      "--message",
      "This must never follow the pane into the new thread.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], fixture.environment);
    assert.equal(explicitOldSession.status, 1);
    assert.match(
      explicitOldSession.stderr,
      /detached|not bound|no longer bound|cannot send|unresolved Turn/iu
    );
  } finally {
    fixture.cleanup();
  }
});

test("verified-empty physical Send advertises replacement over a real draft and ignores resolver or Turn state while rejecting a stale token", async () => {
  for (const blocker of ["draft", "resolver", "stale_token", "active_turn"] as const) {
    const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
    try {
      const source = persistExactEndedRolloutSession(
        fixture,
        `session-verified-empty-${blocker}`
      );
      fs.writeFileSync(
        fixture.screenPath,
        blocker === "draft"
          ? "Ready\n› preserve this real operator draft\n\n  gpt-5.6 · 90% left"
          : "Ready\n› \u001b[2mRun /review on my current changes\u001b[0m\n\n" +
            "  gpt-5.6 · 90% left"
      );
      if (blocker === "resolver") {
        fixture.identityObservationError = "injected lsof observation failure";
      } else if (blocker === "active_turn") {
        persistBlockingTurn(fixture, source);
      }
      const terminal = await listFixtureTerminal(fixture);
      if (blocker === "resolver") {
        assert.equal(
          terminal.native_agent_identity_observation.status,
          "unavailable"
        );
      }
      if (blocker === "draft") {
        const action = assertTerminalUserExplicitSendAction(terminal);
        assert.equal(
          action.composer_policy,
          "replace_current_composer_and_submit",
          blocker
        );
        assert.equal(
          loadManagedSession(fixture.storeDir, source.session_id).status,
          "bound",
          blocker
        );
        assert.equal(
          readTmuxCalls(fixture.tmuxCallsPath)
            .some((call) => call.args[0] === "send-keys"),
          false,
          blocker
        );
        continue;
      }
      if (blocker === "resolver" || blocker === "active_turn") {
        assertTerminalUserExplicitSendAction(terminal);
        assert.equal(
          loadManagedSession(fixture.storeDir, source.session_id).status,
          "bound",
          blocker
        );
        assert.equal(
          readTmuxCalls(fixture.tmuxCallsPath)
            .some((call) => call.args[0] === "send-keys"),
          false,
          blocker
        );
        continue;
      }

      const action = terminal.available_actions.send;
      assert.ok(action, JSON.stringify(terminal));
      const stalePhysicalToken = createHash("sha256")
        .update("stale verified-empty physical terminal authority")
        .digest("hex");
      assert.notEqual(
        stalePhysicalToken,
        action.arguments.expected_terminal_token
      );
      const rejected = await runCli([
        "send",
        "--conversation",
        fixture.terminalId,
        "--expected-terminal-token",
        stalePhysicalToken,
        "--message",
        "A stale list token must not detach the source.",
        ...codexNoRolloutBackgroundSendArgs(fixture)
      ], fixture.environment);
      assert.equal(rejected.status, 1, rejected.stdout);
      assert.match(rejected.stderr, /fresh exact terminal token|refresh/iu);
      assert.equal(
        loadManagedSession(fixture.storeDir, source.session_id).status,
        "bound"
      );
      assert.equal(
        readTmuxCalls(fixture.tmuxCallsPath)
          .some((call) => call.args[0] === "send-keys"),
        false
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("verified-empty handoff sends no Enter when a native rollout appears after text injection", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  try {
    const source = persistExactEndedRolloutSession(fixture);
    fs.writeFileSync(
      fixture.screenPath,
      "Ready\n› \u001b[2mRun /review on my current changes\u001b[0m\n\n" +
      "  gpt-5.6 · 90% left"
    );
    const terminal = await listFixtureTerminal(fixture);
    const action = terminal.available_actions.send;
    assert.ok(action, JSON.stringify(terminal));
    fixture.activeNativeThreadId = EXTERNAL_THREAD_ID;
    fixture.activeRolloutPath = path.join(
      path.dirname(fixture.rolloutPath),
      `rollout-2026-08-11T03-20-00-${EXTERNAL_THREAD_ID}.jsonl`
    );
    const sent = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      String(action.arguments.expected_terminal_token),
      "--message",
      "Race with a human-created native thread after text injection.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], {
      ...fixture.environment,
      AKK_TEST_MATERIALIZE_ROLLOUT_AFTER_TEXT: "1"
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.submission_outcome, "uncertain");
    assert.equal(output.do_not_retry, true);
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "detached"
    );
    const sends = readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
      call.args[0] === "send-keys"
    );
    assert.equal(sends.filter((call) => call.args.includes("-l")).length, 1);
    assert.equal(sends.filter((call) => call.args.at(-1) === "C-m").length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("Herdr uses the same verified-empty Codex handoff fence and virgin post-submit binding", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    terminalKind: "herdr"
  });
  try {
    const source = persistExactEndedRolloutSession(fixture);
    fs.writeFileSync(
      fixture.screenPath,
      `Ready\nTo continue this session, run codex resume ${NATIVE_THREAD_ID}\n\n` +
      "› \u001b[2mRun /review on my current changes\u001b[0m\n" +
      CODEX_TEST_COMPOSER_FOOTER
    );
    const terminal = await listFixtureTerminal(fixture);
    assert.equal(terminal.terminal_control.kind, "herdr");
    assert.equal(terminal.activity_state, "idle");
    assert.equal(
      terminal.handoff_state,
      "verified_empty_native_session_adoptable"
    );
    const action = terminal.available_actions.send;
    assert.ok(action, JSON.stringify(terminal));

    fixture.activeNativeThreadId = EXTERNAL_THREAD_ID;
    fixture.activeRolloutPath = path.join(
      path.dirname(fixture.rolloutPath),
      `rollout-2026-08-11T03-30-00-${EXTERNAL_THREAD_ID}.jsonl`
    );
    const sent = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      String(action.arguments.expected_terminal_token),
      "--message",
      "Deliver this task through the Herdr provider.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], fixture.environment);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true, sent.stdout);
    assert.equal(output.terminal_control.kind, "herdr");
    assert.equal(output.conversation.native_thread_id, EXTERNAL_THREAD_ID);
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "detached"
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, output.session_id)
        .binding?.native_thread_id,
      EXTERNAL_THREAD_ID
    );
    const input = readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
      call.args[0] === "send-keys"
    );
    assert.equal(input.filter((call) => call.args.includes("-l")).length, 1);
    assert.equal(input.filter((call) => call.args.at(-1) === "C-m").length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("ambiguous and unverifiable binding claims hide reconciliation but not user-priority Send", async () => {
  for (const kind of ["ambiguous", "unverifiable"] as const) {
    const fixture = createNoRolloutFixture();
    try {
      fs.writeFileSync(fixture.materializedPath, "ready");
      persistConflictSession(fixture, {
        sessionId: `session-${kind}-claim-a`,
        nativeThreadId: EXTERNAL_THREAD_ID,
        processBirth: kind === "ambiguous" ? LIVE_PROCESS_BIRTH : undefined
      });
      if (kind === "ambiguous") {
        persistConflictSession(fixture, {
          sessionId: "session-ambiguous-claim-b",
          nativeThreadId: SECOND_EXTERNAL_THREAD_ID,
          processBirth: LIVE_PROCESS_BIRTH
        });
      }
      const terminal = await listFixtureTerminal(fixture);
      assert.equal(terminal.management_state, "conflict", kind);
      assert.equal(
        terminal.management_conflict.kind,
        kind === "ambiguous" ? "ambiguous_bound_claims" : "unverifiable",
        kind
      );
      assert.deepEqual(
        Object.keys(terminal.available_actions),
        ["status", "send"]
      );
      assertTerminalUserExplicitSendAction(terminal);
    } finally {
      fixture.cleanup();
    }
  }
});

test("a fresh /status card that supersedes the open rollout is projected as an adoptable handoff", async () => {
  const fixture = createNoRolloutFixture();
  try {
    fs.writeFileSync(fixture.materializedPath, "ready");
    persistConflictSession(fixture, {
      sessionId: "session-status-rollout-disagreement",
      nativeThreadId: NATIVE_THREAD_ID,
      processBirth: LIVE_PROCESS_BIRTH
    });
    fs.writeFileSync(
      fixture.screenPath,
      `/status\nSession: ${EXTERNAL_THREAD_ID}\n` +
      codexTestComposerScreen()
    );
    const terminal = await listFixtureTerminal(fixture);
    assert.equal(terminal.native_agent_session_id, NATIVE_THREAD_ID);
    assert.equal(
      terminal.native_agent_status_card_session_id,
      EXTERNAL_THREAD_ID
    );
    assert.equal(terminal.management_state, "conflict");
    assert.equal(
      terminal.management_conflict.kind,
      "live_external_thread_change"
    );
    assert.equal(terminal.handoff_state, "external_handoff_adoptable");
    assert.deepEqual(Object.keys(terminal.available_actions), [
      "status",
      "send",
      "reconcile_binding"
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("managed blockers suppress reconciliation but not user-priority physical Send", async () => {
  for (const blocker of ["turn", "transition", "ledger"] as const) {
    const fixture = createNoRolloutFixture();
    try {
      fs.writeFileSync(fixture.materializedPath, "ready");
      const session = persistConflictSession(fixture, {
        sessionId: `session-reconcile-${blocker}-blocker`,
        nativeThreadId: EXTERNAL_THREAD_ID,
        processBirth: LIVE_PROCESS_BIRTH
      });
      const before = await listFixtureTerminal(fixture);
      const advertised = before.available_actions.reconcile_binding;
      assert.ok(advertised, blocker);
      if (blocker === "turn") {
        persistBlockingTurn(fixture, session);
      } else if (blocker === "transition") {
        persistUnresolvedTransition(fixture, session);
      } else {
        persistUnresolvedDispatchLedger(fixture, session);
      }

      const blocked = await listFixtureTerminal(fixture);
      assert.equal(blocked.management_state, "conflict", blocker);
      assert.equal(blocked.available_actions.reconcile_binding, undefined, blocker);
      assertTerminalUserExplicitSendAction(blocked);
      assert.equal(blocked.available_actions.new_thread, undefined, blocker);
      assert.equal(
        blocked.available_actions.list_resumable_threads,
        undefined,
        blocker
      );

      const staleAction = await runCli(
        reconcileArguments(fixture, advertised.arguments),
        fixture.environment
      );
      assert.equal(staleAction.status, 1, `${blocker}: ${staleAction.stdout}`);
      assert.equal(
        loadManagedSession(fixture.storeDir, session.session_id).status,
        "bound",
        blocker
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("Codex status-card binding rejects the same PID with a different process birth", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const session = persistStatusCardSession(fixture, STALE_PROCESS_BIRTH);
    const sent = await runCli([
      "send",
      "--session",
      session.session_id,
      "--message",
      "This must not reach the reused Codex PID.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], fixture.environment);

    assert.equal(sent.status, 1, sent.stdout);
    assert.match(
      sent.stderr,
      /changed native thread outside AKK|identity changed/u
    );
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("Codex status-card binding with the same process birth authorizes and refines the Turn", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const session = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const sent = await runCli([
      "send",
      "--session",
      session.session_id,
      "--message",
      "Inspect the repository without changing files.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], fixture.environment);

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true);
    const takeover = output.conversation.native_session_takeover;
    assert.equal(takeover.terminal_agent_session_id, NATIVE_THREAD_ID);
    assert.equal(takeover.terminal_agent_process_birth, LIVE_PROCESS_BIRTH);
    assert.equal(
      takeover.terminal_agent_process_uuid,
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH)
    );
    assert.equal(
      fs.realpathSync(takeover.terminal_agent_rollout.path),
      fs.realpathSync(fixture.rolloutPath)
    );

    const refined = loadManagedSession(fixture.storeDir, session.session_id);
    assert.equal(refined.status, "bound");
    assert.equal(refined.binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      refined.binding?.native_process.process_birth,
      LIVE_PROCESS_BIRTH
    );
    assert.equal(
      refined.binding?.native_process.process_uuid,
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH)
    );
    assert.equal(
      fs.realpathSync(refined.binding?.native_process.rollout?.path as string),
      fs.realpathSync(fixture.rolloutPath)
    );

    const sends = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(sends.at(-2)?.args, [
      "send-keys",
      "-t",
      fixture.inputTarget,
      "-l",
      "Inspect the repository without changing files."
    ]);
    assert.deepEqual(sends.at(-1)?.args, [
      "send-keys",
      "-t",
      fixture.inputTarget,
      "C-m"
    ]);
  } finally {
    fixture.cleanup();
  }
});
