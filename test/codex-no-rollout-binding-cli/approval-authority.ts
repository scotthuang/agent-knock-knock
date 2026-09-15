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

test("unmanaged Codex approval remains raw while arbitrary terminal authority is rejected", async () => {
  const fixture = createNoRolloutFixture();
  try {
    fs.writeFileSync(fixture.screenPath, [
      "  Would you like to run the following command?",
      "",
      "  $ npm test",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)"
    ].join("\n"));
    const terminal = await listFixtureTerminal(fixture);
    assert.ok(terminal.available_actions.approve);
    assert.deepEqual(terminal.available_actions.approve.arguments, {
      conversation_id: fixture.terminalId
    });
    const status = await runCli([
      "status",
      "--conversation",
      fixture.terminalId,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const fingerprint = String(
      JSON.parse(status.stdout).terminal_status.approval_state.fingerprint
    );
    const keysBefore = approvalKeyCalls(fixture).length;

    const forgedAuthority = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      "forged-terminal-authority",
      "--expected-approval-fingerprint",
      fingerprint,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(forgedAuthority.status, 1, forgedAuthority.stdout);
    assert.match(
      forgedAuthority.stderr,
      /does not match an advertised terminal-scoped Codex approval/iu
    );
    assert.equal(approvalKeyCalls(fixture).length, keysBefore);

    const rawApproval = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-approval-fingerprint",
      fingerprint,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(rawApproval.status, 0, rawApproval.stderr || rawApproval.stdout);
    const output = JSON.parse(rawApproval.stdout);
    assert.equal(output.approved, true);
    assert.equal(output.terminal_scoped, false);
    assert.deepEqual(
      approvalKeyCalls(fixture).slice(keysBefore).map((call) => call.args),
      [["send-keys", "-t", fixture.inputTarget, "y"]]
    );
  } finally {
    fixture.cleanup();
  }
});

test("human-confirmed Codex approval falls back to the exact terminal when managed rollout identity is unavailable", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const seeded = await seedStatusCardManagedApproval(fixture);
    const terminal = await listFixtureTerminal(fixture);
    assert.equal(terminal.management_state, "conflict");
    assert.equal(terminal.managed.current_turn, null);
    const action = terminal.available_actions.approve;
    assert.ok(action, JSON.stringify(terminal, null, 2));
    assert.deepEqual(action.arguments, {
      conversation_id: fixture.terminalId,
      expected_terminal_token: action.arguments.expected_terminal_token
    });
    assert.equal(typeof action.arguments.expected_terminal_token, "string");
    assert.deepEqual(action.before_call.arguments, {
      conversation_id: fixture.terminalId
    });
    assert.equal(action.requires_explicit_user_confirmation, true);
    assert.equal(action.requires_fresh_status, true);
    assert.equal(action.scope, "terminal_current_prompt");

    const status = await runCli([
      "status",
      "--conversation",
      fixture.terminalId,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusOutput = JSON.parse(status.stdout);
    const fingerprint = String(
      statusOutput.terminal_status.approval_state.fingerprint
    );
    assert.equal(statusOutput.source, "terminal_control");
    assert.match(fingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(
      terminal.approval_state.fingerprint,
      fingerprint,
      "list/status must share the canonical terminal approval runtime identity"
    );

    const keysBefore = approvalKeyCalls(fixture).length;
    const aliasedSelector = await runCli([
      "approve",
      "--conversation",
      "codex",
      "--expected-terminal-token",
      String(action.arguments.expected_terminal_token),
      "--expected-approval-fingerprint",
      fingerprint,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(aliasedSelector.status, 1, aliasedSelector.stdout);
    assert.match(aliasedSelector.stderr, /exact full terminal.*selector/iu);
    assert.equal(approvalKeyCalls(fixture).length, keysBefore);

    const automatic = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      String(action.arguments.expected_terminal_token),
      "--expected-approval-fingerprint",
      fingerprint,
      "--auto-approved",
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(automatic.status, 1, automatic.stdout);
    assert.match(automatic.stderr, /automatic approval.*managed Turn/iu);
    assert.equal(approvalKeyCalls(fixture).length, keysBefore);

    const stale = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      String(action.arguments.expected_terminal_token),
      "--expected-approval-fingerprint",
      "0".repeat(64),
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(stale.status, 0, stale.stderr || stale.stdout);
    assert.equal(JSON.parse(stale.stdout).approved, false);
    assert.match(JSON.parse(stale.stdout).reason, /fingerprint changed/iu);
    assert.equal(approvalKeyCalls(fixture).length, keysBefore);

    const approved = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      String(action.arguments.expected_terminal_token),
      "--expected-approval-fingerprint",
      fingerprint,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const output = JSON.parse(approved.stdout);
    assert.equal(output.source, "terminal_control");
    assert.equal(output.approved, true);
    assert.equal(output.key, "y");
    assert.equal(output.terminal_scoped, true);
    assert.deepEqual(
      approvalKeyCalls(fixture).slice(keysBefore).map((call) => call.args),
      [["send-keys", "-t", fixture.inputTarget, "y"]]
    );
    assert.deepEqual(
      loadManagedSession(fixture.storeDir, seeded.session.session_id),
      seeded.session
    );
    assert.deepEqual(
      listConversations(fixture.storeDir)[0],
      seeded.turn
    );
  } finally {
    fixture.cleanup();
  }
});

test("human-confirmed Codex approval can target a managed pane with no AKK dispatch owner", async () => {
  for (const dispatchHistory of ["none", "resolved"] as const) {
    const fixture = createNoRolloutFixture({
      rolloutInitiallyAbsent: dispatchHistory === "resolved"
    });
    try {
      let session: ManagedSessionState;
      if (dispatchHistory === "resolved") {
        session = (await seedResolvedHistoricalDispatchAndStatusCard(fixture)).source;
      } else {
        session = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
      }
      fixture.identityObservationError =
        "injected Codex rollout observation unavailable";
      fs.rmSync(fixture.materializedPath, { force: true });
      fs.writeFileSync(fixture.screenPath, codexApprovalScreen("npm test"));

      const sessionsBefore = JSON.parse(JSON.stringify(
        listManagedSessions(fixture.storeDir)
      ));
      const turnsBefore = JSON.parse(JSON.stringify(
        listConversations(fixture.storeDir)
      ));
      const ledgerBefore = dispatchHistory === "resolved"
        ? readSoleTerminalDispatchLedger(fixture)
        : undefined;
      const terminal = await listFixtureTerminal(fixture);
      assert.equal(terminal.management_state, "managed", dispatchHistory);
      assert.equal(terminal.managed.current_turn, null, dispatchHistory);
      const action = terminal.available_actions.approve;
      assert.ok(action, `${dispatchHistory}: ${JSON.stringify(terminal, null, 2)}`);
      assert.equal(
        action.authority,
        "managed_session_no_dispatch_owner",
        dispatchHistory
      );
      assert.deepEqual(action.arguments, {
        conversation_id: fixture.terminalId,
        expected_terminal_token: action.arguments.expected_terminal_token
      });
      assert.equal(action.requires_explicit_user_confirmation, true);
      assert.equal(action.requires_fresh_status, true);
      assert.equal(action.managed_state_unchanged, true);
      assert.equal(action.automatic_approval_eligible, false);
      assert.equal(action.durable_dispatch_receipt, false);
      assert.match(action.uncertain_outcome_recovery, /do not retry blindly/iu);

      const status = await runCli([
        "status",
        "--conversation",
        fixture.terminalId,
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(status.status, 0, status.stderr || status.stdout);
      const statusOutput = JSON.parse(status.stdout);
      const statusFingerprint = String(
        statusOutput.terminal_status.approval_state.fingerprint
      );
      assert.equal(
        terminal.approval_state.fingerprint,
        statusFingerprint,
        "list/status must share the canonical terminal approval runtime identity"
      );

      const keysBefore = approvalKeyCalls(fixture).length;
      const approved = await runCli([
        "approve",
        "--conversation",
        fixture.terminalId,
        "--expected-terminal-token",
        String(action.arguments.expected_terminal_token),
        "--expected-approval-fingerprint",
        statusFingerprint,
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(approved.status, 0, approved.stderr || approved.stdout);
      const output = JSON.parse(approved.stdout);
      assert.equal(output.approved, true);
      assert.equal(output.terminal_scoped, true);
      assert.equal(output.durable_dispatch_receipt, false);
      assert.match(output.uncertain_outcome_recovery, /do not retry blindly/iu);
      assert.deepEqual(
        approvalKeyCalls(fixture).slice(keysBefore).map((call) => call.args),
        [["send-keys", "-t", fixture.inputTarget, "y"]]
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(listManagedSessions(fixture.storeDir))),
        sessionsBefore
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(listConversations(fixture.storeDir))),
        turnsBefore
      );
      assert.deepEqual(
        dispatchHistory === "resolved"
          ? readSoleTerminalDispatchLedger(fixture)
          : undefined,
        ledgerBefore
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(
          loadManagedSession(fixture.storeDir, session.session_id)
        )),
        JSON.parse(JSON.stringify(session))
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("terminal-scoped Codex approval fingerprint and token ignore output outside the exact prompt region", async () => {
  const fixture = createNoRolloutFixture();
  try {
    persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    fixture.identityObservationError =
      "injected Codex rollout observation unavailable";
    fs.rmSync(fixture.materializedPath, { force: true });
    const prompt = codexApprovalScreen("npm test");
    fs.writeFileSync(
      fixture.screenPath,
      `background test output before list\n${prompt}`
    );

    const first = await listFixtureTerminal(fixture);
    const firstAction = first.available_actions.approve;
    assert.ok(firstAction, JSON.stringify(first, null, 2));
    const firstToken = String(firstAction.arguments.expected_terminal_token);
    const firstFingerprint = String(first.approval_state.fingerprint);
    assert.match(firstToken, /^[0-9a-f]{64}$/u);
    assert.match(firstFingerprint, /^[0-9a-f]{64}$/u);

    fs.writeFileSync(
      fixture.screenPath,
      `different background test output after list\n${prompt}`
    );
    const second = await listFixtureTerminal(fixture);
    const secondAction = second.available_actions.approve;
    assert.ok(secondAction, JSON.stringify(second, null, 2));
    assert.equal(second.approval_state.fingerprint, firstFingerprint);
    assert.equal(
      secondAction.arguments.expected_terminal_token,
      firstToken,
      "diagnostic scrollback must not invalidate terminal-scoped approval authority"
    );

    const keysBefore = approvalKeyCalls(fixture).length;
    const approved = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      firstToken,
      "--expected-approval-fingerprint",
      firstFingerprint,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    assert.equal(JSON.parse(approved.stdout).approved, true);
    assert.equal(approvalKeyCalls(fixture).length, keysBefore + 1);
  } finally {
    fixture.cleanup();
  }
});

test("terminal-scoped Codex approval token binds the exact current prompt with or without a dispatch owner", async () => {
  for (const authority of [
    "managed_session_no_dispatch_owner",
    "current_dispatch_owner"
  ] as const) {
    const fixture = createNoRolloutFixture();
    try {
      if (authority === "current_dispatch_owner") {
        await seedStatusCardManagedApproval(fixture);
      } else {
        persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
        fixture.identityObservationError =
          "injected Codex rollout observation unavailable";
        fs.rmSync(fixture.materializedPath, { force: true });
      }
      fs.writeFileSync(fixture.screenPath, codexApprovalScreen("npm test"));
      const terminal = await listFixtureTerminal(fixture);
      const action = terminal.available_actions.approve;
      assert.ok(action, `${authority}: ${JSON.stringify(terminal, null, 2)}`);
      assert.equal(action.authority, authority);
      const staleFingerprint = String(terminal.approval_state.fingerprint);
      assert.match(staleFingerprint, /^[0-9a-f]{64}$/u);

      fs.writeFileSync(fixture.screenPath, codexApprovalScreen("npm run lint"));
      const keysBefore = approvalKeyCalls(fixture).length;
      const stalePromptAuthority = await runCli([
        "approve",
        "--conversation",
        fixture.terminalId,
        "--expected-terminal-token",
        String(action.arguments.expected_terminal_token),
        "--expected-approval-fingerprint",
        staleFingerprint,
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(
        stalePromptAuthority.status,
        1,
        stalePromptAuthority.stdout
      );
      assert.match(
        stalePromptAuthority.stderr,
        /token is missing or stale|authority changed/iu
      );
      assert.equal(approvalKeyCalls(fixture).length, keysBefore);

      const status = await runCli([
        "status",
        "--conversation",
        fixture.terminalId,
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(status.status, 0, status.stderr || status.stdout);
      const freshFingerprint = String(
        JSON.parse(status.stdout).terminal_status.approval_state.fingerprint
      );
      assert.notEqual(freshFingerprint, terminal.approval_state.fingerprint);

      const rejected = await runCli([
        "approve",
        "--conversation",
        fixture.terminalId,
        "--expected-terminal-token",
        String(action.arguments.expected_terminal_token),
        "--expected-approval-fingerprint",
        freshFingerprint,
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(rejected.status, 1, rejected.stdout);
      assert.match(
        rejected.stderr,
        /token is missing or stale|authority changed/iu
      );
      assert.equal(approvalKeyCalls(fixture).length, keysBefore);
    } finally {
      fixture.cleanup();
    }
  }
});

test("managed no-owner Codex approval waits for aborted deferred cleanup before recovering", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const session = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    fixture.identityObservationError =
      "injected Codex rollout observation unavailable";
    fs.rmSync(fixture.materializedPath, { force: true });
    fs.writeFileSync(fixture.screenPath, codexApprovalScreen("npm test"));
    const listed = await listFixtureTerminal(fixture);
    const staleAction = listed.available_actions.approve;
    assert.ok(staleAction, JSON.stringify(listed, null, 2));
    const status = await runCli([
      "status",
      "--conversation",
      fixture.terminalId,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const fingerprint = String(
      JSON.parse(status.stdout).terminal_status.approval_state.fingerprint
    );
    const binding = session.binding;
    assert.ok(binding?.terminal_endpoint);
    const now = new Date().toISOString();
    const prepared = saveDeferredForegroundTransfer(fixture.storeDir, {
      schema: DEFERRED_FOREGROUND_TRANSFER_SCHEMA,
      version: DEFERRED_FOREGROUND_TRANSFER_VERSION,
      transfer_id: createDeferredForegroundTransferId(),
      status: "prepared",
      input_stage: "none",
      terminal_id: fixture.terminalId,
      terminal_endpoint: binding.terminal_endpoint,
      process_pid: binding.native_process.pid,
      process_uuid: String(binding.native_process.process_uuid),
      process_birth: String(binding.native_process.process_birth),
      workspace: session.workspace,
      source_session_id: session.session_id,
      source_expected_revision: session.revision as number,
      source_binding_token: managedSessionBindingToken(session),
      source_before_binding: binding,
      source_kind: "status_card_only",
      target_session_id: `${session.session_id}-deferred-target`,
      target_expected_revision: null,
      previous_dispatch_status: "none",
      previous_dispatch_fingerprint: "a".repeat(64),
      request_hash: "b".repeat(64),
      dispatcher_pid: process.pid,
      prepared_at: now
    }, { expectedRevision: null });
    const aborted = saveDeferredForegroundTransfer(fixture.storeDir, {
      ...prepared,
      status: "aborted",
      aborted_at: now,
      error: "test-only abort intent awaiting cleanup"
    }, { expectedRevision: prepared.revision as number });
    const keysBefore = approvalKeyCalls(fixture).length;

    const blockedList = await listFixtureTerminal(fixture);
    assert.equal(blockedList.available_actions.approve, undefined);
    const blocked = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      String(staleAction.arguments.expected_terminal_token),
      "--expected-approval-fingerprint",
      fingerprint,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(blocked.status, 1, blocked.stdout);
    assert.match(blocked.stderr, /managed recovery|deferred foreground/iu);
    assert.equal(approvalKeyCalls(fixture).length, keysBefore);

    const cleanupAt = new Date(Date.now() + 1).toISOString();
    saveDeferredForegroundTransfer(fixture.storeDir, {
      ...aborted,
      status: "abort_resolved",
      abort_cleanup_completed_at: cleanupAt,
      abort_source_after_revision: session.revision as number,
      abort_source_after_status: "bound",
      abort_source_after_binding_token: managedSessionBindingToken(session),
      abort_source_after_binding: binding,
      abort_target_after_status: "absent"
    }, { expectedRevision: aborted.revision as number });
    const recoveredList = await listFixtureTerminal(fixture);
    const recoveredAction = recoveredList.available_actions.approve;
    assert.ok(recoveredAction, JSON.stringify(recoveredList, null, 2));
    const approved = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      String(recoveredAction.arguments.expected_terminal_token),
      "--expected-approval-fingerprint",
      fingerprint,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    assert.equal(JSON.parse(approved.stdout).approved, true);
    assert.deepEqual(
      approvalKeyCalls(fixture).slice(keysBefore).map((call) => call.args),
      [["send-keys", "-t", fixture.inputTarget, "y"]]
    );
  } finally {
    fixture.cleanup();
  }
});

test("managed no-owner Codex approval fails closed when Store or native authority drifts", async () => {
  for (const drift of [
    "blocking_turn",
    "native_transition",
    "uncertain_orphan",
    "multiple_bound_sessions",
    "session_revision",
    "native_thread",
    "process"
  ] as const) {
    const fixture = createNoRolloutFixture();
    try {
      const session = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
      fixture.identityObservationError =
        "injected Codex rollout observation unavailable";
      fs.rmSync(fixture.materializedPath, { force: true });
      fs.writeFileSync(fixture.screenPath, codexApprovalScreen("npm test"));
      const terminal = await listFixtureTerminal(fixture);
      const action = terminal.available_actions.approve;
      assert.ok(action, `${drift}: ${JSON.stringify(terminal, null, 2)}`);
      const status = await runCli([
        "status",
        "--conversation",
        fixture.terminalId,
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(status.status, 0, `${drift}: ${status.stderr || status.stdout}`);
      const fingerprint = String(
        JSON.parse(status.stdout).terminal_status.approval_state.fingerprint
      );
      const now = new Date("2026-08-12T05:00:00.000Z");

      if (drift === "blocking_turn") {
        persistBlockingTurn(fixture, session);
      } else if (drift === "native_transition") {
        persistUnresolvedTransition(fixture, session);
      } else if (drift === "uncertain_orphan") {
        persistUnresolvedDispatchLedger(fixture, session);
      } else if (drift === "multiple_bound_sessions") {
        saveManagedSession(fixture.storeDir, {
          schema: "agent-knock-knock/session",
          version: 1,
          session_id: "session-codex-second-owner",
          agent: "codex",
          workspace: session.workspace,
          status: "bound",
          binding: terminalBindingFrom({
            terminalId: fixture.terminalId,
            terminalControl: fixture.terminalControl,
            pid: fixture.codexPid,
            nativeThreadId: EXTERNAL_THREAD_ID,
            processUuid: processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
            processBirth: LIVE_PROCESS_BIRTH,
            evidence: "codex_status_card",
            generation: 1,
            now
          }),
          lineage: { created_by: "attach" },
          created_at: now.toISOString(),
          updated_at: now.toISOString()
        }, { expectedRevision: null });
      } else if (drift === "session_revision") {
        saveManagedSession(fixture.storeDir, {
          ...session,
          updated_at: now.toISOString()
        }, { expectedRevision: session.revision as number });
      } else if (drift === "native_thread") {
        fixture.identityObservationError = undefined;
        fixture.activeNativeThreadId = EXTERNAL_THREAD_ID;
        fixture.activeRolloutPath = path.join(
          path.dirname(fixture.rolloutPath),
          `rollout-2026-08-12T00-00-00-${EXTERNAL_THREAD_ID}.jsonl`
        );
        fs.writeFileSync(fixture.activeRolloutPath, `${JSON.stringify({
          timestamp: now.toISOString(),
          type: "session_meta",
          payload: {
            id: EXTERNAL_THREAD_ID,
            cwd: fixture.terminalControl.currentPath,
            originator: "codex-tui",
            source: "cli",
            cli_version: fixture.codexVersion
          }
        })}\n`);
        fs.writeFileSync(fixture.materializedPath, "ready");
      } else {
        fs.writeFileSync(fixture.processBirthPath, STALE_PROCESS_BIRTH);
      }

      const relisted = await listFixtureTerminal(fixture);
      const relistedApproval = relisted.available_actions.approve;
      if (drift === "session_revision") {
        assert.ok(relistedApproval, JSON.stringify(relisted, null, 2));
        assert.notEqual(
          relistedApproval.arguments.expected_terminal_token,
          action.arguments.expected_terminal_token
        );
      } else {
        assert.equal(
          relistedApproval?.arguments?.expected_terminal_token,
          undefined,
          drift
        );
      }
      const keysBefore = approvalKeyCalls(fixture).length;
      const rejected = await runCli([
        "approve",
        "--conversation",
        fixture.terminalId,
        "--expected-terminal-token",
        String(action.arguments.expected_terminal_token),
        "--expected-approval-fingerprint",
        fingerprint,
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(rejected.status, 1, `${drift}: ${rejected.stdout}`);
      assert.match(
        rejected.stderr,
        /managed recovery|unresolved|uncertain|ambiguous|token is missing or stale|different native thread|no single exact managed Session|process incarnation|dispatch owner/iu,
        drift
      );
      assert.equal(approvalKeyCalls(fixture).length, keysBefore, drift);
    } finally {
      fixture.cleanup();
    }
  }
});

test("terminal-scoped Codex approval rejects a known native-thread handoff and process drift before keys", async () => {
  for (const drift of ["native_thread", "process"] as const) {
    const fixture = createNoRolloutFixture();
    try {
      await seedStatusCardManagedApproval(fixture);
      const terminal = await listFixtureTerminal(fixture);
      const action = terminal.available_actions.approve;
      assert.ok(action, `${drift}: ${JSON.stringify(terminal, null, 2)}`);
      const status = await runCli([
        "status",
        "--conversation",
        fixture.terminalId,
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(status.status, 0, status.stderr || status.stdout);
      const fingerprint = JSON.parse(status.stdout)
        .terminal_status.approval_state.fingerprint;
      const keysBefore = approvalKeyCalls(fixture).length;

      if (drift === "native_thread") {
        fixture.identityObservationError = undefined;
        fixture.activeNativeThreadId = EXTERNAL_THREAD_ID;
        fixture.activeRolloutPath = path.join(
          path.dirname(fixture.rolloutPath),
          `rollout-2026-08-12T00-00-00-${EXTERNAL_THREAD_ID}.jsonl`
        );
        fs.writeFileSync(fixture.activeRolloutPath, `${JSON.stringify({
          timestamp: "2026-08-12T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: EXTERNAL_THREAD_ID,
            cwd: fixture.terminalControl.currentPath,
            originator: "codex-tui",
            source: "cli",
            cli_version: fixture.codexVersion
          }
        })}\n`);
        fs.writeFileSync(fixture.materializedPath, "ready");
      } else {
        fs.writeFileSync(fixture.processBirthPath, STALE_PROCESS_BIRTH);
      }

      const relisted = await listFixtureTerminal(fixture);
      assert.equal(relisted.available_actions.approve, undefined, drift);
      const rejected = await runCli([
        "approve",
        "--conversation",
        fixture.terminalId,
        "--expected-terminal-token",
        String(action.arguments.expected_terminal_token),
        "--expected-approval-fingerprint",
        String(fingerprint),
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(rejected.status, 1, `${drift}: ${rejected.stdout}`);
      assert.match(
        rejected.stderr,
        drift === "native_thread"
          ? /native.*thread.*changed|different native.*thread/iu
          : /process incarnation changed|no single current managed owner/iu
      );
      assert.equal(approvalKeyCalls(fixture).length, keysBefore, drift);
    } finally {
      fixture.cleanup();
    }
  }
});

test("terminal-scoped Codex approval rejects uncertain dispatch ownership before keys", async () => {
  const fixture = createNoRolloutFixture();
  try {
    await seedStatusCardManagedApproval(fixture);
    const terminal = await listFixtureTerminal(fixture);
    const action = terminal.available_actions.approve;
    assert.ok(action, JSON.stringify(terminal, null, 2));
    const status = await runCli([
      "status",
      "--conversation",
      fixture.terminalId,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    const fingerprint = JSON.parse(status.stdout)
      .terminal_status.approval_state.fingerprint;
    const ledger = readSoleTerminalDispatchLedger(fixture);
    const ledgerPath = soleTerminalDispatchLedgerPath(fixture);
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      ...ledger,
      status: "uncertain",
      uncertain_at: new Date().toISOString(),
      do_not_retry: true
    }, null, 2)}\n`);
    const keysBefore = approvalKeyCalls(fixture).length;

    const relisted = await listFixtureTerminal(fixture);
    assert.equal(relisted.available_actions.approve, undefined);
    const rejected = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      String(action.arguments.expected_terminal_token),
      "--expected-approval-fingerprint",
      String(fingerprint),
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(rejected.stderr, /uncertain.*dispatch|dispatch.*uncertain/iu);
    assert.equal(approvalKeyCalls(fixture).length, keysBefore);
  } finally {
    fixture.cleanup();
  }
});

test("terminal-scoped Codex approval rejects a nonterminal deferred transfer before keys", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const seeded = await seedStatusCardManagedApproval(fixture);
    const terminal = await listFixtureTerminal(fixture);
    const action = terminal.available_actions.approve;
    assert.ok(action, JSON.stringify(terminal, null, 2));
    const status = await runCli([
      "status",
      "--conversation",
      fixture.terminalId,
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const fingerprint = JSON.parse(status.stdout)
      .terminal_status.approval_state.fingerprint;
    const binding = seeded.session.binding;
    assert.ok(binding?.terminal_endpoint);
    const transferId = createDeferredForegroundTransferId();
    saveDeferredForegroundTransfer(fixture.storeDir, {
      schema: DEFERRED_FOREGROUND_TRANSFER_SCHEMA,
      version: DEFERRED_FOREGROUND_TRANSFER_VERSION,
      transfer_id: transferId,
      status: "prepared",
      input_stage: "none",
      terminal_id: fixture.terminalId,
      terminal_endpoint: binding.terminal_endpoint,
      process_pid: binding.native_process.pid,
      process_uuid: String(binding.native_process.process_uuid),
      process_birth: String(binding.native_process.process_birth),
      workspace: seeded.session.workspace,
      source_session_id: seeded.session.session_id,
      source_expected_revision: seeded.session.revision as number,
      source_binding_token: managedSessionBindingToken(seeded.session),
      source_before_binding: binding,
      source_kind: "status_card_only",
      target_session_id: `${seeded.session.session_id}-deferred-target`,
      target_expected_revision: null,
      previous_dispatch_status: "resolved",
      previous_dispatch_fingerprint: "a".repeat(64),
      request_hash: "b".repeat(64),
      dispatcher_pid: process.pid,
      prepared_at: new Date().toISOString()
    }, { expectedRevision: null });
    const keysBefore = approvalKeyCalls(fixture).length;

    const relisted = await listFixtureTerminal(fixture);
    assert.equal(relisted.available_actions.approve, undefined);
    const rejected = await runCli([
      "approve",
      "--conversation",
      fixture.terminalId,
      "--expected-terminal-token",
      String(action.arguments.expected_terminal_token),
      "--expected-approval-fingerprint",
      String(fingerprint),
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(rejected.stderr, /managed recovery|deferred foreground transfer/iu);
    assert.equal(approvalKeyCalls(fixture).length, keysBefore);
  } finally {
    fixture.cleanup();
  }
});
