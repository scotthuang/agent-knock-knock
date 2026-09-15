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

test("strict Session send keeps the narrow /status viewport gate", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    terminalKind: "herdr",
    viewportColumns: 54,
    ttyViewportColumns: 51
  });
  try {
    const source = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const sent = await runCli([
      "send",
      "--session",
      source.session_id,
      "--message",
      "Strict Session authority still requires an exact UUID.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], codexNativeAcceptanceEnv(fixture.environment));
    assert.equal(sent.status, 1, sent.stdout);
    assert.match(sent.stderr, /at least 80 columns|viewport|widen|zoom/iu);
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.equal(
      loadManagedSession(fixture.storeDir, source.session_id).status,
      "bound"
    );
    assert.deepEqual(listConversations(fixture.storeDir), []);
  } finally {
    fixture.cleanup();
  }
});

test("a submitted status probe reports a truncated Session card without retrying Enter", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  try {
    const session = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const sent = await runCli([
      "send",
      "--session",
      session.session_id,
      "--message",
      "This task must wait for an exact status identity.",
      ...codexNoRolloutBackgroundSendArgs(fixture)
    ], {
      ...fixture.environment,
      AKK_TEST_TRUNCATED_STATUS_CARD: "1"
    });

    assert.equal(sent.status, 1, sent.stdout);
    assert.match(
      sent.stderr,
      /Enter was dispatched exactly once[\s\S]*status card was truncated[\s\S]*widen or zoom[\s\S]*do not retry/iu
    );
    const sends = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(sends.map((call) => call.args), [
      ["send-keys", "-t", fixture.inputTarget, "-l", "/status"],
      ["send-keys", "-t", fixture.inputTarget, "C-m"]
    ]);
    assert.deepEqual(listConversations(fixture.storeDir), []);
  } finally {
    fixture.cleanup();
  }
});

test("unmanaged Codex lifecycle token changes when a PID is reused", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const first = await runCli([
      "list",
      ...codexNoRolloutStoreArgs(fixture),
      "--no-approval-scan"
    ], fixture.environment);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstTerminal = JSON.parse(first.stdout).terminals[0];
    assert.equal(firstTerminal.native_agent_process_birth, LIVE_PROCESS_BIRTH);
    assert.equal(
      firstTerminal.native_agent_process_uuid,
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH)
    );

    fs.writeFileSync(fixture.processBirthPath, STALE_PROCESS_BIRTH);
    const second = await runCli([
      "list",
      ...codexNoRolloutStoreArgs(fixture),
      "--no-approval-scan"
    ], fixture.environment);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondTerminal = JSON.parse(second.stdout).terminals[0];
    assert.equal(secondTerminal.native_agent_process_birth, STALE_PROCESS_BIRTH);
    assert.notEqual(
      secondTerminal.lifecycle_binding_token,
      firstTerminal.lifecycle_binding_token
    );
  } finally {
    fixture.cleanup();
  }
});

test("live-gate New rejects an unmanaged Codex origin that is not persisted", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const listed = await runCli([
      "list",
      ...codexNoRolloutStoreArgs(fixture),
      "--no-approval-scan"
    ], fixture.environment);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const terminal = JSON.parse(listed.stdout).terminals[0];
    const expectedBindingToken = terminal.lifecycle_binding_token;
    assert.equal(typeof expectedBindingToken, "string");

    const rejected = await runCli([
      "new-thread",
      "--terminal",
      fixture.terminalId,
      "--expected-binding-token",
      expectedBindingToken,
      "--require-restorable-origin",
      ...codexNoRolloutStoreArgs(fixture)
    ], {
      ...fixture.environment,
      AKK_TEST_EXIT_AFTER_LIFECYCLE_PREPARED: "1"
    });

    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(
      rejected.stderr,
      /--require-restorable-origin could not prove that the current native thread is a unique persisted resume candidate/u
    );
    const literalSends = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) =>
        call.args[0] === "send-keys" && call.args.includes("-l")
      )
      .map((call) => call.args.at(-1));
    assert.deepEqual(literalSends, ["/status"]);
    assert.equal(literalSends.includes("/clear"), false);
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.equal(listManagedSessions(fixture.storeDir).length, 0);
    const transitionsDir = nativeThreadTransitionsDir(fixture.storeDir);
    assert.equal(
      fs.existsSync(transitionsDir)
        ? fs.readdirSync(transitionsDir).length
        : 0,
      0
    );
  } finally {
    fixture.cleanup();
  }
});

test("live-gate New first Send accepts B beside seed A and rejects unknown C", async () => {
  for (const inventoryCase of ["exact_companion", "unknown_third"] as const) {
    const fixture = createNoRolloutFixture({ persistedCandidate: true });
    try {
      enableFixtureCandidateInventory(fixture, [NATIVE_THREAD_ID]);
      const listed = await runCli([
        "list",
        ...codexNoRolloutStoreArgs(fixture),
        "--no-approval-scan"
      ], fixture.environment);
      assert.equal(listed.status, 0, listed.stderr || listed.stdout);
      const terminal = JSON.parse(listed.stdout).terminals[0];
      const expectedBindingToken = terminal.lifecycle_binding_token;
      assert.equal(typeof expectedBindingToken, "string");

      const transitioned = await runCli([
        "new-thread",
        "--terminal",
        fixture.terminalId,
        "--expected-binding-token",
        expectedBindingToken,
        "--require-restorable-origin",
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);

      assert.equal(
        transitioned.status,
        0,
        transitioned.stderr || transitioned.stdout
      );
      const transitionOutput = JSON.parse(transitioned.stdout);
      assert.equal(
        transitionOutput.status,
        "committed",
        transitioned.stdout
      );
      assert.equal(transitionOutput.native_thread_id, EXTERNAL_THREAD_ID);
      const literalSends = readTmuxCalls(fixture.tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" && call.args.includes("-l")
        )
        .map((call) => call.args.at(-1));
      assert.deepEqual(literalSends, ["/status", "/clear", "/status"]);
      assert.equal(listConversations(fixture.storeDir).length, 0);
      assert.equal(listManagedSessions(fixture.storeDir).length, 1);
      const transitions = fs.readdirSync(
        nativeThreadTransitionsDir(fixture.storeDir)
      );
      assert.equal(transitions.length, 1);
      assert.equal(
        loadNativeThreadTransition(fixture.storeDir, transitions[0]).status,
        "committed"
      );

      const target = loadManagedSession(
        fixture.storeDir,
        String(transitionOutput.session_id)
      );
      assert.equal(target.binding?.native_thread_id, EXTERNAL_THREAD_ID);
      assert.equal(target.binding?.native_process.rollout, undefined);
      assert.equal(target.last_transition_id, transitions[0]);

      const message = inventoryCase === "exact_companion"
        ? "Accept B while the exact seed A rollout remains open."
        : "Reject B when unknown root C appears after Enter.";
      fixture.acceptanceNativeThreadIdsOnEnter = [EXTERNAL_THREAD_ID];
      fixture.additionalOpenRootNativeThreadIdsOnEnter =
        inventoryCase === "unknown_third"
          ? [SECOND_EXTERNAL_THREAD_ID]
          : [];
      const callsBeforeSend = readTmuxCalls(fixture.tmuxCallsPath).length;
      const sent = await runCli([
        "send",
        "--session",
        target.session_id,
        "--managed-only",
        "--message",
        message,
        ...codexNoRolloutBackgroundSendArgs(fixture)
      ], codexNativeAcceptanceEnv(fixture.environment));
      assert.equal(sent.status, 0, sent.stderr || sent.stdout);
      const output = JSON.parse(sent.stdout);
      if (inventoryCase === "exact_companion") {
        assert.equal(output.delivered, true, sent.stdout);
        assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);
        assert.equal(output.conversation.native_thread_id, EXTERNAL_THREAD_ID);
        const acceptedTurn = listConversations(fixture.storeDir).find((turn) =>
          turn.turn_id === output.turn_id
        );
        assert.ok(acceptedTurn);
        const acceptanceAnchor =
          (acceptedTurn.native_session_takeover as Record<string, any>)
            .codex_rollout_acceptance_anchor;
        assert.equal(
          acceptanceAnchor.version,
          1
        );
        assert.equal(acceptanceAnchor.native_thread_id, EXTERNAL_THREAD_ID);
        assert.deepEqual(
          fixture.openRootRollouts?.map((root) => root.nativeThreadId),
          [NATIVE_THREAD_ID, EXTERNAL_THREAD_ID]
        );
      } else {
        assert.equal(output.delivered, true, sent.stdout);
        assert.equal(output.terminal_input_dispatched, true, sent.stdout);
        assert.equal(output.agent_acceptance, "unproven", sent.stdout);
        assert.equal(output.status, "submission_uncertain", sent.stdout);
        assert.equal(output.submission_outcome, "uncertain", sent.stdout);
        assert.equal(output.do_not_retry, true, sent.stdout);
        assert.deepEqual(
          fixture.openRootRollouts?.map((root) => root.nativeThreadId),
          [NATIVE_THREAD_ID, EXTERNAL_THREAD_ID, SECOND_EXTERNAL_THREAD_ID]
        );
      }
      const taskDispatchCalls = readTmuxCalls(fixture.tmuxCallsPath)
        .slice(callsBeforeSend)
        .filter((call) => call.args[0] === "send-keys")
        .map((call) => call.args);
      assert.deepEqual(taskDispatchCalls,
        [
          ["send-keys", "-t", fixture.inputTarget, "-l", "/status"],
          ["send-keys", "-t", fixture.inputTarget, "C-m"],
          ["send-keys", "-t", fixture.inputTarget, "-l", message],
          ["send-keys", "-t", fixture.inputTarget, "C-m"]
        ]
      );
      // Strict Session identity refresh owns the /status pair above. The task
      // transport itself must remain exactly one literal write plus Enter.
      assert.deepEqual(taskDispatchCalls.slice(-2), [
        ["send-keys", "-t", fixture.inputTarget, "-l", message],
        ["send-keys", "-t", fixture.inputTarget, "C-m"]
      ]);
    } finally {
      fixture.cleanup();
    }
  }
});

test("native status inspection is snapshot-bound, settles the slash composer, and does not mutate the Store", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  try {
    assert.equal(fs.existsSync(fixture.storeDir), false);
    const listed = await listFixtureTerminal(fixture);
    assert.equal(listed.native_inspection.status, "supported");
    assert.equal(listed.native_inspection.agentVersion, "0.147.0");
    assert.deepEqual(
      listed.available_actions.native_inspect.arguments,
      {
        terminal_id: fixture.terminalId,
        inspection: "status",
        expected_binding_token: listed.lifecycle_binding_token
      }
    );
    const nativeInspectArguments = (token: string) => [
      "native-inspect",
      "--terminal",
      fixture.terminalId,
      "--inspection",
      "status",
      "--expected-binding-token",
      token,
      ...codexNoRolloutStoreArgs(fixture)
    ];

    const stale = await runCli(
      nativeInspectArguments("stale-binding-token"),
      fixture.environment
    );
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(stale.stderr, /binding changed after it was listed/u);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false
    );

    fs.writeFileSync(fixture.screenPath, [
      "Ready",
      "\u001b[1m›\u001b[0m \u001b[2mImprove documentation in @filename\u001b[0m",
      "  \u001b[38;2;246;226;183mgpt-5.6-sol high\u001b[2m\u001b[39m · \u001b[0m/workspace"
    ].join("\n"));
    const suggested = await listFixtureTerminal(fixture);
    assert.equal(suggested.activity_state, "idle");
    assert.deepEqual(
      suggested.available_actions.native_inspect.arguments,
      {
        terminal_id: fixture.terminalId,
        inspection: "status",
        expected_binding_token: suggested.lifecycle_binding_token
      }
    );

    fs.writeFileSync(fixture.screenPath, [
      "Ready",
      "› human draft",
      "gpt-5.6-sol high · /workspace"
    ].join("\n"));
    const drafted = await listFixtureTerminal(fixture);
    assert.equal(drafted.activity_state, "idle");
    assert.equal(drafted.available_actions.native_inspect, undefined);
    const nonempty = await runCli(
      nativeInspectArguments(listed.lifecycle_binding_token),
      fixture.environment
    );
    assert.equal(nonempty.status, 1, nonempty.stdout);
    assert.match(
      nonempty.stderr,
      /not at a verified idle prompt|composer contains non-placeholder input/u
    );
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false
    );

    fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
    const inspected = await runCli(
      nativeInspectArguments(listed.lifecycle_binding_token),
      fixture.environment
    );
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    const result = JSON.parse(inspected.stdout);
    assert.equal(result.status, "observed");
    assert.equal(result.inspection, "status");
    assert.equal(result.agent, "codex");
    assert.equal(result.agent_version, "0.147.0");
    assert.equal(result.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(result.terminal_submission.command, "/status");
    assert.equal(result.terminal_submission.enter_count, 1);
    assert.equal(result.store_mutation, false);
    assert.equal(result.session_created, false);
    assert.equal(result.turn_created, false);
    assert.equal(result.receipt_created, false);
    assert.equal(result.monitor_created, false);
    assert.equal(result.callback_created, false);
    assert.equal(
      result.native_status.fields.find(
        (field: Record<string, unknown>) => field.name === "Account"
      )?.value,
      "[REDACTED]"
    );

    const sends = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(sends.map((call) => call.args), [
      ["send-keys", "-t", fixture.inputTarget, "-l", "/status"],
      ["send-keys", "-t", fixture.inputTarget, "C-m"]
    ]);
    assert.ok(
      Number(sends[1].at) - Number(sends[0].at) >= 121,
      "the only Enter must be dispatched after the Codex suppression boundary"
    );
    assert.equal(
      fs.existsSync(fixture.storeDir),
      false,
      "native inspection must not initialize or mutate the AKK Store"
    );
    assert.deepEqual(listConversations(fixture.storeDir), []);
    assert.deepEqual(listManagedSessions(fixture.storeDir), []);
  } finally {
    fixture.cleanup();
  }
});

for (const [label, viewportColumns] of [
  ["narrow", 54],
  ["unavailable", null]
] as const) {
  test(
    `native status inspection rejects ${label === "unavailable" ? "an" : "a"} ` +
      `${label} viewport before slash input`,
    async () => {
      const fixture = createNoRolloutFixture({
        codexVersion: "0.147.0",
        viewportColumns
      });
      try {
        const listed = await listFixtureTerminal(fixture);
        const inspected = await runCli([
          "native-inspect",
          "--terminal",
          fixture.terminalId,
          "--inspection",
          "status",
          "--expected-binding-token",
          String(listed.lifecycle_binding_token),
          ...codexNoRolloutStoreArgs(fixture)
        ], fixture.environment);

        assert.equal(inspected.status, 1, inspected.stdout);
        assert.match(
          inspected.stderr,
          /viewport|widen|zoom|geometry/iu
        );
        assert.equal(
          readTmuxCalls(fixture.tmuxCallsPath)
            .some((call) => call.args[0] === "send-keys"),
          false,
          "a viewport AKK cannot prove must fail before /status text or Enter"
        );
        assert.equal(fs.existsSync(fixture.storeDir), false);
      } finally {
        fixture.cleanup();
      }
    }
  );
}

test("Herdr zoomed focused effective area gates closed Codex status at the exact boundary", async () => {
  const fixture = createNoRolloutFixture({
    codexVersion: "0.147.0",
    terminalKind: "herdr",
    viewportColumns: 54,
    viewportZoomed: false,
    viewportFocusedPaneId: "w1:p1",
    viewportAreaColumns: 108,
    viewportAreaRows: 40,
    ttyViewportColumns: 51,
    ttyViewportRows: 38
  });
  try {
    const listed = await listFixtureTerminal(fixture);
    const nativeInspectArguments = [
      "native-inspect",
      "--terminal",
      fixture.terminalId,
      "--inspection",
      "status",
      "--expected-binding-token",
      String(listed.lifecycle_binding_token),
      ...codexNoRolloutStoreArgs(fixture)
    ];

    const inspect = () => runCli(nativeInspectArguments, fixture.environment);
    const statusSends = () => readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    const assertNewTtyInspectionsUseShellPid = (before: number) => {
      const inspectedPids = fixture.ttyViewportInspectionPids.slice(before);
      assert.ok(inspectedPids.length > 0);
      assert.equal(
        inspectedPids.every((pid) => pid === fixture.terminalControl.panePid),
        true
      );
    };

    let ttyInspectionsBefore = fixture.ttyViewportInspectionPids.length;
    const unzoomed = await inspect();
    assert.equal(unzoomed.status, 1, unzoomed.stdout);
    assert.match(unzoomed.stderr, /at least 80 columns.*observed 51/iu);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false,
      "an unzoomed pane with an exact 51-column TTY must fail before input"
    );
    assertNewTtyInspectionsUseShellPid(ttyInspectionsBefore);

    // Keep the exact terminal/socket/pane/layout identity and geometry. Only
    // Herdr's zoom state and exact TTY authority change. The 108-column outer
    // area remains only visibility evidence; the inspector proves 105 columns.
    fixture.viewportZoomed = true;
    fixture.ttyViewportColumns = 105;
    ttyInspectionsBefore = fixture.ttyViewportInspectionPids.length;
    const zoomed = await inspect();
    assert.equal(zoomed.status, 0, zoomed.stderr || zoomed.stdout);
    const output = JSON.parse(zoomed.stdout);
    assert.equal(output.status, "observed");
    assert.equal(output.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(output.terminal_submission.command, "/status");
    assert.equal(output.terminal_submission.enter_count, 1);
    assert.equal(output.store_mutation, false);
    assertNewTtyInspectionsUseShellPid(ttyInspectionsBefore);

    assert.deepEqual(statusSends().map((call) => call.args), [
      ["send-keys", "-t", fixture.inputTarget, "-l", "/status"],
      ["send-keys", "-t", fixture.inputTarget, "C-m"]
    ]);
    let sends = statusSends();
    assert.ok(
      Number(sends[1].at) - Number(sends[0].at) >= 121,
      "the zoomed Herdr path must retain the Codex suppression boundary"
    );

    fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
    // Direct-attach simulation: Herdr still reports a visible 108-column
    // outer layout, but the exact PTY is only 77 columns. Layout geometry must
    // never upgrade or override that narrower authority.
    fixture.ttyViewportColumns = 77;
    ttyInspectionsBefore = fixture.ttyViewportInspectionPids.length;
    const directAttachNarrow = await inspect();
    assert.equal(
      directAttachNarrow.status,
      1,
      directAttachNarrow.stdout
    );
    assert.match(
      directAttachNarrow.stderr,
      /at least 80 columns.*observed 77/iu
    );
    assertNewTtyInspectionsUseShellPid(ttyInspectionsBefore);
    assert.equal(
      statusSends().length,
      2,
      "a visible 108-column layout with an exact 77-column TTY must not input"
    );

    fixture.ttyViewportColumns = 80;
    ttyInspectionsBefore = fixture.ttyViewportInspectionPids.length;
    const atBoundary = await inspect();
    assert.equal(atBoundary.status, 0, atBoundary.stderr || atBoundary.stdout);
    assert.equal(JSON.parse(atBoundary.stdout).status, "observed");
    assertNewTtyInspectionsUseShellPid(ttyInspectionsBefore);
    sends = statusSends();
    assert.equal(sends.length, 4);
    assert.deepEqual(sends.slice(-2).map((call) => call.args), [
      ["send-keys", "-t", fixture.inputTarget, "-l", "/status"],
      ["send-keys", "-t", fixture.inputTarget, "C-m"]
    ]);
    assert.ok(
      Number(sends[3].at) - Number(sends[2].at) >= 121,
      "the exact 80-column TTY must preserve the Codex suppression boundary"
    );

    fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
    fixture.viewportFocusedPaneId = "w1:p2";
    fixture.viewportPaneFocused = false;
    ttyInspectionsBefore = fixture.ttyViewportInspectionPids.length;
    const otherFocused = await inspect();
    assert.equal(otherFocused.status, 1, otherFocused.stdout);
    assert.match(
      otherFocused.stderr,
      /exact terminal viewport geometry|could not prove|unavailable/iu
    );
    assert.equal(
      statusSends().length,
      4,
      "a zoomed layout focused on another pane must fail before input"
    );
    assert.equal(
      fixture.ttyViewportInspectionPids.length,
      ttyInspectionsBefore,
      "a hidden zoomed pane must return unknown before consulting its TTY"
    );
    assert.equal(fs.existsSync(fixture.storeDir), false);
  } finally {
    fixture.cleanup();
  }
});

test("Codex 0.146.0 native status inspection remains backward compatible", async () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.146.0" });
  try {
    const listed = await listFixtureTerminal(fixture);
    assert.equal(listed.native_inspection.status, "supported");
    assert.equal(listed.native_inspection.agentVersion, "0.146.0");
    const inspected = await runCli([
      "native-inspect",
      "--terminal",
      fixture.terminalId,
      "--inspection",
      "status",
      "--expected-binding-token",
      String(listed.lifecycle_binding_token),
      ...codexNoRolloutStoreArgs(fixture)
    ], fixture.environment);
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    const result = JSON.parse(inspected.stdout);
    assert.equal(result.agent_version, "0.146.0");
    assert.equal(result.behavior_profile, "codex-tui-0.146.0");
    assert.equal(result.terminal_submission.enter_count, 1);
  } finally {
    fixture.cleanup();
  }
});

test("native status inspection sends no Enter after post-injection process drift", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const listed = await listFixtureTerminal(fixture);
    const inspected = await runCli([
      "native-inspect",
      "--terminal",
      fixture.terminalId,
      "--inspection",
      "status",
      "--expected-binding-token",
      String(listed.lifecycle_binding_token),
      ...codexNoRolloutStoreArgs(fixture)
    ], {
      ...fixture.environment,
      AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT: STALE_PROCESS_BIRTH
    });

    assert.equal(inspected.status, 1, inspected.stdout);
    assert.match(
      inspected.stderr,
      /did not cross a proven completion boundary; do not retry automatically/u
    );
    const sends = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(sends.map((call) => call.args), [
      ["send-keys", "-t", fixture.inputTarget, "-l", "/status"]
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("native status inspection is withheld and rejects a cached action while managed work is unresolved", async () => {
  for (const blocker of ["turn", "transition"] as const) {
    const fixture = createNoRolloutFixture();
    try {
      fs.writeFileSync(fixture.materializedPath, "ready");
      const session = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
      const listed = await listFixtureTerminal(fixture);
      const advertised = listed.available_actions.native_inspect;
      assert.ok(advertised, blocker);

      if (blocker === "turn") {
        persistBlockingTurn(fixture, session);
      } else {
        persistUnresolvedTransition(fixture, session);
      }

      const blocked = await listFixtureTerminal(fixture);
      assert.equal(
        blocked.available_actions.native_inspect,
        undefined,
        blocker
      );
      const rejected = await runCli([
        "native-inspect",
        "--terminal",
        fixture.terminalId,
        "--inspection",
        "status",
        "--expected-binding-token",
        String(advertised.arguments.expected_binding_token),
        ...codexNoRolloutStoreArgs(fixture)
      ], fixture.environment);
      assert.equal(rejected.status, 1, `${blocker}: ${rejected.stdout}`);
      assert.match(
        rejected.stderr,
        blocker === "turn"
          ? /still has unresolved Turn/u
          : /has an unresolved native-thread transition/u,
        blocker
      );
      assert.equal(
        readTmuxCalls(fixture.tmuxCallsPath)
          .some((call) => call.args[0] === "send-keys"),
        false,
        blocker
      );
    } finally {
      fixture.cleanup();
    }
  }
});
