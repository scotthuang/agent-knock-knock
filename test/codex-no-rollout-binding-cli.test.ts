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
} from "../src/cli-core.js";
import type {
  CodexLocalSessionAdapter
} from "../src/codex-local-session-provider.js";
import type {
  CodexOpenRootRolloutInventory
} from "../src/agent-session-provider.js";
import {
  inspectCodexOpenRootRolloutInventory
} from "../src/codex-store-adapter.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedSessionState,
  type NativeThreadTransition
} from "../src/managed-session.js";
import {
  createDeferredForegroundTransferId,
  DEFERRED_FOREGROUND_TRANSFER_SCHEMA,
  DEFERRED_FOREGROUND_TRANSFER_VERSION,
  listDeferredForegroundTransfers,
  saveDeferredForegroundTransfer,
  pathsForDeferredForegroundTransfer,
  type DeferredForegroundTransfer
} from "../src/deferred-foreground-transfer.js";
import {
  listManagedSessions,
  loadManagedSession,
  loadNativeThreadTransition,
  nativeThreadTransitionsDir,
  pathsForManagedSession,
  saveManagedSession,
  saveNativeThreadTransition
} from "../src/session-store.js";
import {
  ensureStoreWritable,
  listConversations,
  pathsForConversation,
  saveState
} from "../src/store.js";
import { createConversation } from "../src/protocol.js";
import {
  createTerminalControlProviderRegistry,
  TmuxTerminalControlProvider,
  type CommandResult
} from "../src/terminal-control-provider.js";
import {
  HERDR_EXACT_PROTOCOL,
  HERDR_EXACT_VERSION,
  HerdrTerminalControlProvider,
  type HerdrWireRequest
} from "../src/herdr-terminal-control-provider.js";
import { StaticTerminalProcessSource } from "../src/terminal-process-source.js";
import type {
  TerminalControlRef,
  TerminalThreadLifecycleCandidate,
  TerminalThreadLifecycleCandidateProvider,
  TerminalThreadLifecycleCandidateRequest,
  TerminalThreadLifecycleCandidateToken
} from "../src/terminal-agent-adapter.js";
import {
  createTerminalEndpointRef,
  terminalEndpointIdentityFromEvidence,
  terminalEndpointIdentityKey,
  tmuxTerminalRouteKey
} from "../src/terminal-control-ref.js";
import {
  codexNativeAcceptanceEnv,
  codexNoRolloutBackgroundSendArgs,
  codexNoRolloutStoreArgs
} from "./support/codex-no-rollout-cli-harness.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const LIVE_PROCESS_BIRTH = "Thu Aug  6 10:00:00 2026";
const STALE_PROCESS_BIRTH = "Wed Aug  5 10:00:00 2026";
const NATIVE_THREAD_ID = "11111111-1111-4111-8111-111111111111";
const EXTERNAL_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_EXTERNAL_THREAD_ID = "33333333-3333-4333-8333-333333333333";
const FIRST_NATIVE_TURN_ID = "44444444-4444-4444-8444-444444444444";
const FIXTURE_TMUX_PANE_ID = "%42";
const SIMULATED_DEAD_CLI_PID = 2_147_483_647;

interface CodexNoRolloutShardExpansion {
  canonical_source: string;
  compiled_shards: string[];
  declaration_shards: number[];
}

interface TestFileShardConfig {
  schema: string;
  version: number;
  expansions: CodexNoRolloutShardExpansion[];
}

const shardConfig = JSON.parse(fs.readFileSync(
  new URL("../../config/test-file-shards.json", import.meta.url),
  "utf8"
)) as TestFileShardConfig;
if (
  shardConfig.schema !== "agent-knock-knock/test-file-shards" ||
  shardConfig.version !== 1 ||
  !Array.isArray(shardConfig.expansions)
) {
  throw new Error("Codex no-rollout test shard config is malformed");
}
const shardExpansion = shardConfig.expansions.find((candidate) =>
  candidate.canonical_source ===
    "test/codex-no-rollout-binding-cli.test.ts"
);
if (
  !shardExpansion ||
  !Array.isArray(shardExpansion.compiled_shards) ||
  shardExpansion.compiled_shards.length < 5 ||
  !Array.isArray(shardExpansion.declaration_shards)
) {
  throw new Error("Codex no-rollout canonical test shard expansion is missing");
}
const activeShardExpansion: CodexNoRolloutShardExpansion = shardExpansion;
const shardParameters = new URL(import.meta.url).searchParams;
const shardQueryValues = shardParameters.getAll("akk-shard");
if (
  shardQueryValues.length > 1 ||
  [...shardParameters.keys()].some((key) => key !== "akk-shard")
) {
  throw new Error("Codex no-rollout test shard query is malformed");
}
const shardQuery = shardQueryValues[0] ?? null;
if (shardQuery !== null && !/^(?:0|[1-9][0-9]*)$/u.test(shardQuery)) {
  throw new Error(`invalid Codex no-rollout test shard ${shardQuery}`);
}
const selectedShard = shardQuery === null ? undefined : Number(shardQuery);
if (
  selectedShard !== undefined &&
  (
    !Number.isSafeInteger(selectedShard) ||
    selectedShard < 0 ||
    selectedShard >= activeShardExpansion.compiled_shards.length
  )
) {
  throw new Error(`invalid Codex no-rollout test shard ${shardQuery}`);
}
const shardWorkerEntry = process.argv[1]
  ? path.relative(
      fileURLToPath(new URL("../../", import.meta.url)),
      path.resolve(process.argv[1])
    ).split(path.sep).join("/")
  : undefined;
const workerEntryShard = shardWorkerEntry === undefined
  ? -1
  : activeShardExpansion.compiled_shards.indexOf(shardWorkerEntry);
if (
  (selectedShard === undefined && workerEntryShard !== -1) ||
  (selectedShard !== undefined && workerEntryShard !== selectedShard)
) {
  throw new Error(
    `Codex no-rollout shard query ${String(selectedShard)} does not match ` +
      `worker entry ${String(shardWorkerEntry)}`
  );
}
let declaredTestCount = 0;

function test(
  name: string,
  body: (context: TestContext) => void | Promise<void>
): void {
  const declarationIndex = declaredTestCount;
  declaredTestCount += 1;
  const assignedShard =
    activeShardExpansion.declaration_shards[declarationIndex];
  if (
    !Number.isSafeInteger(assignedShard) ||
    assignedShard < 0 ||
    assignedShard >= activeShardExpansion.compiled_shards.length
  ) {
    throw new Error(
      `Codex no-rollout test declaration ${declarationIndex} has no valid shard`
    );
  }
  if (selectedShard === undefined || assignedShard === selectedShard) {
    void nodeTest(name, body);
  }
}

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
    assert.equal(output.delivered, false);
    assert.equal(output.status, "submission_uncertain");
    assert.equal(output.do_not_retry, true);
    assert.match(output.reason, /process incarnation changed/u);
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
    fs.writeFileSync(fixture.screenPath, "Ready\n› existing operator draft");
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
    fs.writeFileSync(fixture.screenPath, "Ready\n› ");

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
      "Ready\n› another existing operator draft"
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
    fs.writeFileSync(newFixture.screenPath, "Ready\n› ");

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

test("a provisional attach orphan exposes one fenced reconcile action and detaches without terminal input", async () => {
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
      "reconcile_binding"
    ]);
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
      "› \u001b[2mRun /review on my current changes\u001b[0m"
    );

    const terminal = await listFixtureTerminal(fixture);
    assert.equal(terminal.activity_state, "unknown");
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

test("verified-empty handoff stays fail-closed for a real draft, resolver failure, stale token, and active Turn", async () => {
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
      if (blocker === "draft" || blocker === "resolver" || blocker === "active_turn") {
        assert.equal(terminal.available_actions.send, undefined, blocker);
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
      const current = loadManagedSession(fixture.storeDir, source.session_id);
      saveManagedSession(fixture.storeDir, {
        ...current,
        updated_at: "2026-08-11T03:10:00.000Z"
      }, { expectedRevision: current.revision as number });
      const rejected = await runCli([
        "send",
        "--conversation",
        fixture.terminalId,
        "--expected-terminal-token",
        String(action.arguments.expected_terminal_token),
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
      "› \u001b[2mRun /review on my current changes\u001b[0m"
    );
    const terminal = await listFixtureTerminal(fixture);
    assert.equal(terminal.terminal_control.kind, "herdr");
    assert.equal(terminal.activity_state, "unknown");
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

test("ambiguous and unverifiable binding claims never advertise reconciliation", async () => {
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
      assert.deepEqual(Object.keys(terminal.available_actions), ["status"]);
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
      `/status\nSession: ${EXTERNAL_THREAD_ID}\n› `
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

test("blocking Turns, unresolved transitions, and dispatch ledgers suppress binding reconciliation", async () => {
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
      assert.equal(blocked.available_actions.send, undefined, blocker);
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
        assert.notEqual(
          refreshedAction.arguments.expected_terminal_token,
          action.arguments.expected_terminal_token
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
        fs.writeFileSync(fixture.screenPath, "Ready\n› ");
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
        fs.writeFileSync(fixture.screenPath, "Ready\n› ");
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
    fs.writeFileSync(fixture.screenPath, "Ready\n› ");
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

test("deferred send without exact request acceptance stays uncertain and blocks replay", async () => {
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
    assert.equal(output.delivered, false);
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

test("deferred terminal tokens fail closed while an unmanaged no-token send still works", async () => {
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
            expected_terminal_token: "arbitrary-terminal-token"
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
  const message = "A normal unmanaged selector still needs no handoff token.";
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
    assert.equal(pendingOutput.delivered, false);
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
    lockReleaser = spawn(process.execPath, ["-e", releaseScript], {
      stdio: "ignore"
    });

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
  test(`one exact open root uses snapshot-bound candidate send when identity is ${identityCase}`, async () => {
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
        identityCase
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
          "› \u001b[2mAsk Codex anything\u001b[0m"
        ].join("\n"));
      } else {
        fs.writeFileSync(
          fixture.screenPath,
          "Ready after /clear\n› \u001b[2mAsk Codex anything\u001b[0m"
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
    const aborted = await runCli(delegateArgs, {
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
    const retried = await runCli(delegateArgs, codexNativeAcceptanceEnv(fixture.environment));
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

    const retried = await runCli(delegateArgs, codexNativeAcceptanceEnv(fixture.environment));
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    const output = JSON.parse(retried.stdout);
    assert.equal(output.delivery_receipt, "agent_accepted", retried.stdout);
    assert.equal(output.message.id, messageId);
    assert.notEqual(output.turn_id, abortedTurnId);
    assert.equal(output.session_id, source.session_id);
    assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      output.conversation.gateway_method,
      "agent-knock-knock.callback"
    );
    assert.equal(output.conversation.gateway_session, gatewaySession);
    assert.deepEqual(
      listDeferredForegroundTransfers(fixture.storeDir),
      [abortTransfer],
      "the retry must preserve the completed abort and reuse its restored source"
    );
    const refinedSource = loadManagedSession(
      fixture.storeDir,
      source.session_id
    );
    assert.equal(refinedSource.status, "bound");
    assert.equal(refinedSource.binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.ok(refinedSource.binding?.native_process.rollout);
    assert.equal(
      loadManagedSession(
        fixture.storeDir,
        abortTransfer.target_session_id
      ).status,
      "detached"
    );

    const finalTaskCalls = taskInputCalls(fixture, message);
    assert.equal(
      finalTaskCalls.filter((call) => call.args.at(-1) === "C-m").length,
      2,
      "status-card retry performs one /status Enter and one task Enter"
    );
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
        call.args.includes("-l") && call.args.at(-1) === "/status"
      ).length,
      1,
      "the restored status-card source is revalidated exactly once"
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
      "› \u001b[2mAsk Codex anything\u001b[0m"
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
      "Ready after scrollback advanced\n› \u001b[2mAsk Codex anything\u001b[0m"
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
      "Ready\n› \u001b[2mAsk Codex anything\u001b[0m"
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
      "› \u001b[2mAsk Codex anything\u001b[0m"
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
      "Ready\n› \u001b[2mAsk Codex anything\u001b[0m"
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

test("abandoned predecessor does not advertise a candidate already claimed by a detached Session", async () => {
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
      "Ready\n› \u001b[2mAsk Codex anything\u001b[0m"
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
    assert.equal(listed.available_actions.send, undefined);
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

test("a non-companion bound candidate claim suppresses present multi-root send and rejects a cached token before input", async () => {
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
    assert.equal(listed.available_actions.send, undefined);
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);

    const rejected = await runCli(
      deferredForegroundSendArgs(fixture, cachedAction, message),
      codexNativeAcceptanceEnv(fixture.environment)
    );
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(
      rejected.stderr,
      /multiple bound managed Session claims|candidate.*claimed|authority|refresh/iu
    );
    assert.deepEqual(taskInputCalls(fixture), []);
    assert.deepEqual(listDeferredForegroundTransfers(fixture.storeDir), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);
  } finally {
    fixture.cleanup();
  }
});

test("a stalled Turn suppresses one-root candidate send while released history does not", async () => {
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
    assert.equal(terminal.available_actions.send, undefined);
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

test("live-gate New accepts a persisted unmanaged Codex origin", async () => {
  const fixture = createNoRolloutFixture({ persistedCandidate: true });
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
  } finally {
    fixture.cleanup();
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

    fs.writeFileSync(fixture.screenPath, "Ready\n› ");
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

    fs.writeFileSync(fixture.screenPath, "Ready\n› ");
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

    fs.writeFileSync(fixture.screenPath, "Ready\n› ");
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

if (declaredTestCount !== activeShardExpansion.declaration_shards.length) {
  throw new Error(
    "Codex no-rollout test shard plan covers " +
      `${activeShardExpansion.declaration_shards.length} declarations, ` +
      `but the canonical suite declares ${declaredTestCount}`
  );
}

interface NoRolloutFixture {
  tempDir: string;
  storeDir: string;
  codexHome: string;
  rolloutPath: string;
  materializedPath: string;
  rolloutProbeCountPath: string;
  screenPath: string;
  processBirthPath: string;
  tmuxCallsPath: string;
  target: string;
  inputTarget: string;
  terminalId: string;
  terminalControl: TerminalControlRef;
  codexPid: number;
  cliPid?: number;
  clockMs: number;
  codexVersion: "0.146.0" | "0.147.0";
  terminalKind: "tmux" | "herdr";
  persistedCandidate: boolean;
  rolloutInitiallyAbsent: boolean;
  materializeRolloutOnProbe?: number;
  appendAcceptanceOnProbe?: number;
  deferredAcceptanceRequest?: string;
  identityObservationError?: string;
  openRootRollouts?: Array<{
    nativeThreadId: string;
    rolloutPath: string;
    fd: string;
  }>;
  acceptanceNativeThreadIdsOnEnter?: string[];
  activeNativeThreadId: string;
  activeRolloutPath: string;
  viewportColumns: number | null;
  viewportRows: number;
  viewportZoomed: boolean;
  viewportPaneFocused: boolean;
  viewportFocusedPaneId?: string;
  viewportAreaColumns?: number;
  viewportAreaRows?: number;
  ttyViewportColumns: number | null;
  ttyViewportRows: number;
  ttyViewportInspectionPids: number[];
  runtimeLogs: Array<{
    level: "debug" | "info" | "warn" | "error";
    event: string;
    fields: Record<string, unknown>;
  }>;
  environment: NodeJS.ProcessEnv;
  cleanup(): void;
}

function createNoRolloutFixture(
  {
    codexVersion = "0.146.0",
    materializeRolloutOnProbe,
    persistedCandidate = false,
    rolloutInitiallyAbsent = false,
    terminalKind = "tmux",
    viewportColumns = 100,
    viewportZoomed = false,
    viewportPaneFocused = true,
    viewportFocusedPaneId,
    viewportAreaColumns,
    viewportAreaRows = 40,
    ttyViewportColumns,
    ttyViewportRows
  }: {
    codexVersion?: "0.146.0" | "0.147.0";
    materializeRolloutOnProbe?: number;
    persistedCandidate?: boolean;
    rolloutInitiallyAbsent?: boolean;
    terminalKind?: "tmux" | "herdr";
    /** `null` simulates a provider that cannot prove exact viewport geometry. */
    viewportColumns?: number | null;
    viewportZoomed?: boolean;
    viewportPaneFocused?: boolean;
    viewportFocusedPaneId?: string;
    viewportAreaColumns?: number;
    viewportAreaRows?: number;
    ttyViewportColumns?: number | null;
    ttyViewportRows?: number;
  } = {}
): NoRolloutFixture {
  const tempDir = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "akk-codex-birth-"
  ));
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime");
  const codexHome = path.join(tempDir, ".codex");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "08", "06");
  const screenPath = path.join(tempDir, "screen.txt");
  const pendingInputPath = path.join(tempDir, "pending-input.txt");
  const materializedPath = path.join(tempDir, "materialized");
  const rolloutProbeCountPath = path.join(tempDir, "rollout-probe-count.txt");
  const processBirthPath = path.join(tempDir, "process-birth.txt");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const target = terminalKind === "herdr"
    ? "default:w1:p1"
    : "tmux-birth:0.0";
  const panePid = 72_000;
  const codexPid = 72_001;
  const terminalId =
    `terminal:v2:${terminalKind}:codex:${target}:${codexPid}`;
  const rolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-00-00-${NATIVE_THREAD_ID}.jsonl`
  );
  const executablePath =
    `/opt/akk-test/releases/${codexVersion}-aarch64-apple-darwin/bin/codex`;
  const exactTtyViewportColumns = ttyViewportColumns === undefined
    ? viewportColumns === null
      ? null
      : viewportColumns - 3
    : ttyViewportColumns;
  const exactTtyViewportRows = ttyViewportRows ?? 38;

  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(
    rolloutInitiallyAbsent ? codexHome : sessionsDir,
    { recursive: true, mode: 0o700 }
  );
  fs.writeFileSync(screenPath, "Ready\n› ");
  fs.writeFileSync(processBirthPath, LIVE_PROCESS_BIRTH);
  if (!rolloutInitiallyAbsent) {
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: "2026-08-06T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: NATIVE_THREAD_ID,
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: codexVersion
      }
    })}\n`, { mode: 0o600 });
  }
  if (persistedCandidate) {
    fs.writeFileSync(path.join(codexHome, "state_1.sqlite"), "", {
      mode: 0o600
    });
    writeFakeSqlite({
      fakeBinDir,
      nativeThreadId: NATIVE_THREAD_ID,
      rolloutPath,
      workspace
    });
  }
  writeFakeTmux({
    fakeBinDir,
    callsPath: tmuxCallsPath,
    screenPath,
    pendingInputPath,
    materializedPath,
    processBirthPath,
    rolloutPath,
    codexVersion,
    target,
    panePid,
    workspace,
    viewportColumns,
    viewportRows: 40
  });
  writeFakeProcessTools({
    fakeBinDir,
    materializedPath,
    materializeRolloutOnProbe,
    processBirthPath,
    rolloutProbeCountPath,
    rolloutPath,
    executablePath,
    workspace,
    panePid,
    codexPid
  });

  const capabilities = [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "screen_completion",
    "durable_completion",
    "terminal_cancel"
  ] as const;
  const terminalControl: TerminalControlRef = terminalKind === "herdr"
    ? {
        kind: "herdr",
        target,
        socketPath: path.join(tempDir, "herdr.sock"),
        session: "default",
        sessionDir: path.join(tempDir, "herdr-session"),
        workspaceId: "w1",
        tabId: "w1:t1",
        paneId: "w1:p1",
        terminalId: "term-fixture-codex",
        panePid,
        currentCommand: "codex --yolo",
        currentPath: workspace,
        capabilities: [...capabilities]
      }
    : {
        kind: "tmux",
        target,
        session: "tmux-birth",
        window: 0,
        pane: 0,
        panePid,
        currentCommand: "codex",
        currentPath: workspace,
        capabilities: [...capabilities]
      };
  if (terminalControl.kind === "tmux") {
    const endpointKey = "default-server-route";
    createTerminalEndpointRef({
      identity: {
        providerKind: "tmux",
        endpointKey,
        resourceKey: `pane-id:${FIXTURE_TMUX_PANE_ID}`
      },
      route: {
        routeKey: tmuxTerminalRouteKey(
          endpointKey,
          terminalControl.target,
          terminalControl.socketPath
        ),
        label: terminalControl.target,
        currentCommand: terminalControl.currentCommand,
        currentPath: terminalControl.currentPath
      },
      processAnchorPid: terminalControl.panePid,
      capabilities: terminalControl.capabilities,
      providerRef: terminalControl
    });
  }
  const fixture: NoRolloutFixture = {
    tempDir,
    storeDir,
    codexHome,
    rolloutPath,
    materializedPath,
    rolloutProbeCountPath,
    screenPath,
    processBirthPath,
    tmuxCallsPath,
    target,
    inputTarget: terminalKind === "tmux" ? FIXTURE_TMUX_PANE_ID : target,
    terminalId,
    terminalControl,
    codexPid,
    clockMs: Date.now(),
    codexVersion,
    terminalKind,
    persistedCandidate,
    rolloutInitiallyAbsent,
    materializeRolloutOnProbe,
    activeNativeThreadId: NATIVE_THREAD_ID,
    activeRolloutPath: rolloutPath,
    viewportColumns,
    viewportRows: 40,
    viewportZoomed,
    viewportPaneFocused,
    viewportFocusedPaneId,
    viewportAreaColumns,
    viewportAreaRows,
    ttyViewportColumns: exactTtyViewportColumns,
    ttyViewportRows: exactTtyViewportRows,
    ttyViewportInspectionPids: [],
    runtimeLogs: [],
    environment: {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
      AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
    },
    cleanup() {
      inProcessFixtures.delete(storeDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
  inProcessFixtures.set(storeDir, fixture);
  return fixture;
}

function persistStatusCardSession(
  fixture: NoRolloutFixture,
  processBirth: string,
  nativeThreadId = NATIVE_THREAD_ID,
  sessionId = "session-codex-status-card"
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-06T02:00:00.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId,
      processUuid: processUuid(fixture.codexPid, processBirth),
      processBirth,
      evidence: "codex_status_card",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

function persistExactEndedRolloutSession(
  fixture: NoRolloutFixture,
  sessionId = "session-codex-ended-rollout"
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-11T02:36:56.000Z");
  const stat = fs.statSync(fixture.rolloutPath);
  const openRoot = fixture.openRootRollouts?.find((candidate) =>
    candidate.nativeThreadId === NATIVE_THREAD_ID &&
    fs.realpathSync(candidate.rolloutPath) ===
      fs.realpathSync(fixture.rolloutPath)
  );
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId: NATIVE_THREAD_ID,
      processUuid: processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
      processBirth: LIVE_PROCESS_BIRTH,
      rollout: {
        fd: openRoot?.fd ?? "24",
        device: String(stat.dev),
        inode: String(stat.ino),
        path: fs.realpathSync(fixture.rolloutPath)
      },
      evidence: "codex_open_root_rollout",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

function persistDetachedRolloutCompanion(
  fixture: NoRolloutFixture,
  nativeThreadId: string,
  sessionId: string
): ManagedSessionState {
  const root = fixture.openRootRollouts?.find((candidate) =>
    candidate.nativeThreadId === nativeThreadId
  );
  assert.ok(root, `missing fixture rollout for ${nativeThreadId}`);
  const stat = fs.statSync(root.rolloutPath);
  const now = new Date("2026-08-11T02:37:56.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "detached",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId,
      processUuid: processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
      processBirth: LIVE_PROCESS_BIRTH,
      rollout: {
        fd: root.fd,
        device: String(stat.dev),
        inode: String(stat.ino),
        path: fs.realpathSync(root.rolloutPath)
      },
      evidence: "codex_open_root_rollout",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    detached_at: now.toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

function persistConflictSession(
  fixture: NoRolloutFixture,
  options: {
    sessionId: string;
    nativeThreadId?: string;
    processBirth?: string;
  }
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-06T02:30:00.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: options.sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId: options.nativeThreadId,
      processUuid: options.processBirth
        ? processUuid(fixture.codexPid, options.processBirth)
        : undefined,
      processBirth: options.processBirth,
      evidence: options.nativeThreadId
        ? "codex_status_card"
        : "raw_terminal_attach",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

async function listFixtureTerminal(
  fixture: NoRolloutFixture
): Promise<Record<string, any>> {
  const listed = await runCli([
    "list",
    ...codexNoRolloutStoreArgs(fixture)
  ], fixture.environment);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const terminals = JSON.parse(listed.stdout).terminals;
  assert.equal(terminals.length, 1, listed.stdout);
  return terminals[0];
}

async function deferredForegroundSendAction(
  fixture: NoRolloutFixture
): Promise<Record<string, any>> {
  const terminal = await listFixtureTerminal(fixture);
  const action = terminal.available_actions.send;
  assert.ok(action, JSON.stringify(terminal, null, 2));
  assert.equal(action.arguments.selector, fixture.terminalId);
  assert.equal("session_id" in action.arguments, false);
  assert.equal(
    typeof action.arguments.expected_terminal_token,
    "string"
  );
  return action;
}

function deferredForegroundSendArgs(
  fixture: NoRolloutFixture,
  action: Record<string, any>,
  message: string
): string[] {
  return [
    "send",
    "--conversation",
    String(action.arguments.selector),
    "--expected-terminal-token",
    String(action.arguments.expected_terminal_token),
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
  ];
}

async function seedStatusCardManagedApproval(
  fixture: NoRolloutFixture
): Promise<{ session: ManagedSessionState; turn: Record<string, any> }> {
  const sent = await runCli([
    "send",
    "--conversation",
    fixture.terminalId,
    "--message",
    "Prepare one permission request for explicit human review.",
    ...codexNoRolloutBackgroundSendArgs(fixture)
  ], fixture.environment);
  assert.equal(sent.status, 0, sent.stderr || sent.stdout);
  const output = JSON.parse(sent.stdout);
  assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);

  const originalSession = loadManagedSession(
    fixture.storeDir,
    String(output.session_id)
  );
  assert.ok(originalSession.binding);
  const statusCardAt = new Date().toISOString();
  const sessionSnapshot: ManagedSessionState = {
    ...originalSession,
    revision: (originalSession.revision as number) + 1,
    binding: {
      ...originalSession.binding,
      native_process: {
        ...originalSession.binding.native_process,
        rollout: undefined,
        evidence: "codex_status_card"
      }
    },
    updated_at: statusCardAt
  };
  // This fixture models a Store snapshot written by an older status-card
  // binder. The current CAS API intentionally forbids degrading a verified
  // rollout, so write the historical snapshot directly and immediately load
  // it through today's validator before exercising list/runtime behavior.
  fs.writeFileSync(
    pathsForManagedSession(
      originalSession.session_id,
      fixture.storeDir
    ).statePath,
    `${JSON.stringify(sessionSnapshot, null, 2)}\n`,
    { mode: 0o600 }
  );
  const session = loadManagedSession(
    fixture.storeDir,
    originalSession.session_id
  );

  const turn = listConversations(fixture.storeDir)[0];
  assert.ok(turn);
  const takeover = turn.native_session_takeover as Record<string, any>;
  const statusCardTurn = {
    ...turn,
    native_session_takeover: {
      ...takeover,
      terminal_agent_rollout: undefined
    },
    updated_at: statusCardAt
  };
  saveState(turn.state_path as string, statusCardTurn);
  fixture.identityObservationError =
    "injected Codex rollout observation unavailable";
  fs.rmSync(fixture.materializedPath, { force: true });
  fs.writeFileSync(fixture.screenPath, [
    "  Would you like to run the following command?",
    "",
    "  $ npm test",
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)"
  ].join("\n"));
  return {
    session: loadManagedSession(fixture.storeDir, session.session_id),
    turn: listConversations(fixture.storeDir)[0]
  };
}

function approvalKeyCalls(
  fixture: NoRolloutFixture
): Array<{ args: string[]; at?: number }> {
  return readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
    call.args[0] === "send-keys" && call.args.at(-1) === "y"
  );
}

function codexApprovalScreen(command: string): string {
  return [
    "  Would you like to run the following command?",
    "",
    `  $ ${command}`,
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)"
  ].join("\n");
}

function soleDeferredForegroundTransfer(
  fixture: NoRolloutFixture
): DeferredForegroundTransfer {
  const transfers = listDeferredForegroundTransfers(fixture.storeDir);
  assert.equal(transfers.length, 1, JSON.stringify(transfers, null, 2));
  return transfers[0];
}

function taskInputCalls(
  fixture: NoRolloutFixture,
  message?: string
): Array<{ args: string[]; at?: number }> {
  return readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
    call.args[0] === "send-keys" &&
    (
      call.args.at(-1) === "C-m" ||
      (
        call.args.includes("-l") &&
        call.args.at(-1) !== "/status" &&
        (message === undefined || call.args.at(-1) === message)
      )
    )
  );
}

function assertSingleTaskInput(
  fixture: NoRolloutFixture,
  message: string
): void {
  assert.deepEqual(taskInputCalls(fixture, message).map((call) => call.args), [
    ["send-keys", "-t", fixture.inputTarget, "-l", message],
    ["send-keys", "-t", fixture.inputTarget, "C-m"]
  ]);
}

function persistedCodexV3AcceptanceAnchor(
  fixture: NoRolloutFixture,
  turnId: string
): Record<string, any> {
  const persisted = listConversations(fixture.storeDir).find((turn) =>
    turn.turn_id === turnId
  );
  assert.ok(persisted, `missing persisted Turn ${turnId}`);
  const takeover = persisted.native_session_takeover as Record<string, any>;
  const anchor = takeover.codex_rollout_acceptance_anchor;
  assert.equal(anchor?.version, 3);
  return anchor;
}

function assertRecoveredTurnBlocksDuplicate(result: CliTestResult): void {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /unresolved Turn|waiting_for_agent/iu);
  assert.doesNotMatch(
    result.stderr,
    /uncertain dispatch|do not retry|multiple unresolved deferred/iu
  );
}

function readSoleTerminalDispatchLedger(
  fixture: NoRolloutFixture
): Record<string, any> {
  return JSON.parse(
    fs.readFileSync(soleTerminalDispatchLedgerPath(fixture), "utf8")
  );
}

function soleTerminalDispatchLedgerPath(
  fixture: NoRolloutFixture
): string {
  const ledgerDir = path.join(
    String(fixture.environment.AKK_RUNTIME_DIR),
    "terminal-dispatch"
  );
  const paths = fs.existsSync(ledgerDir)
    ? fs.readdirSync(ledgerDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(ledgerDir, name))
    : [];
  assert.equal(paths.length, 1, JSON.stringify(paths));
  return paths[0];
}

async function seedResolvedHistoricalDispatchAndStatusCard(
  fixture: NoRolloutFixture
): Promise<{ source: ManagedSessionState; historicalTurnId: string }> {
  const historicalMessage = "Create one exact resolved historical dispatch.";
  const sent = await runCli([
    "send",
    "--conversation",
    fixture.terminalId,
    "--message",
    historicalMessage,
    "--background",
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome),
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ], codexNativeAcceptanceEnv(fixture.environment));
  assert.equal(sent.status, 0, sent.stderr || sent.stdout);
  const output = JSON.parse(sent.stdout);
  assert.equal(output.delivered, true, sent.stdout);
  const historicalTurnId = String(output.turn_id);
  const closed = await runCli([
    "close",
    "--turn",
    historicalTurnId,
    "--reason",
    "test-only resolved dispatch history fixture",
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome)
  ], fixture.environment);
  assert.equal(closed.status, 0, closed.stderr || closed.stdout);
  assert.equal(JSON.parse(closed.stdout).terminal_dispatch_resolved, true);

  const previousSession = loadManagedSession(
    fixture.storeDir,
    String(output.session_id)
  );
  const detachedAt = new Date().toISOString();
  assert.ok(previousSession.binding);
  const retiredBinding = terminalBindingFrom({
    terminalId: previousSession.binding.terminal_id,
    terminalControl: previousSession.binding.terminal_control,
    pid: previousSession.binding.native_process.pid,
    processUuid: previousSession.binding.native_process.process_uuid,
    processBirth: previousSession.binding.native_process.process_birth,
    evidence: "test_resolved_history_retired",
    generation: previousSession.binding.generation + 1,
    now: new Date(detachedAt)
  });
  saveManagedSession(fixture.storeDir, {
    ...previousSession,
    status: "detached",
    binding: retiredBinding,
    detached_at: detachedAt,
    updated_at: detachedAt
  }, { expectedRevision: previousSession.revision as number });
  fs.rmSync(fixture.rolloutPath, { force: true });
  fs.rmSync(fixture.materializedPath, { force: true });
  fs.writeFileSync(fixture.screenPath, "Ready\n› ");
  return {
    source: persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH),
    historicalTurnId
  };
}

function materializePreparedDeferredLedgerWithoutTurnState({
  fixture,
  transfer,
  message
}: {
  fixture: NoRolloutFixture;
  transfer: DeferredForegroundTransfer;
  message: string;
}): void {
  const binding = transfer.target_before_binding;
  const preparedAt = transfer.target_prepared_at;
  const messageId = transfer.message_id;
  const turnId = transfer.turn_id;
  const statePath = transfer.state_path;
  assert.ok(binding);
  assert.ok(preparedAt);
  assert.ok(messageId);
  assert.ok(turnId);
  assert.ok(statePath);
  saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: transfer.target_session_id,
    agent: "codex",
    workspace: transfer.workspace,
    status: "transitioning",
    binding,
    lineage: {
      created_by: "attach",
      previous_session_id: transfer.source_session_id,
      transition_id: transfer.transfer_id
    },
    last_transition_id: transfer.transfer_id,
    created_at: preparedAt,
    updated_at: preparedAt
  }, { expectedRevision: null });

  const identity = terminalEndpointIdentityFromEvidence(
    transfer.terminal_endpoint
  );
  assert.ok(identity);
  const terminalKey = createHash("sha256")
    .update(terminalEndpointIdentityKey(identity))
    .digest("hex")
    .slice(0, 20);
  const ledgerDir = path.join(
    String(fixture.environment.AKK_RUNTIME_DIR),
    "terminal-dispatch"
  );
  const ledgerPath = path.join(
    ledgerDir,
    `terminal-dispatch-${terminalKey}.json`
  );
  fs.mkdirSync(ledgerDir, { recursive: true });
  const control = binding.terminal_control;
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    version: 2,
    terminal_key: terminalKey,
    terminal_control: {
      kind: control.kind,
      target: control.target,
      socket_path: control.socketPath ?? null,
      pane_pid: control.panePid ?? null,
      current_path: control.currentPath ?? null
    },
    terminal_endpoint: transfer.terminal_endpoint,
    status: "prepared",
    generation_id: messageId,
    conversation_id: turnId,
    session_id: transfer.target_session_id,
    turn_id: turnId,
    message_id: messageId,
    message_type: "task",
    message_body_hash: createHash("sha256").update(message).digest("hex"),
    request_hash: transfer.request_hash,
    executor_kind: "codex",
    store_dir: path.resolve(fixture.storeDir),
    state_path: path.resolve(statePath),
    event_log_path: path.join(path.dirname(statePath), "events.ndjson"),
    deferred_foreground_transfer_id: transfer.transfer_id,
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    prepared_at: preparedAt,
    dispatcher_pid: transfer.dispatcher_pid,
    callback_expected: false
  }, null, 2)}\n`, { mode: 0o600 });
}

function assertExactDeferredZeroInputAbortLedger({
  fixture,
  transfer,
  ledger
}: {
  fixture: NoRolloutFixture;
  transfer: DeferredForegroundTransfer;
  ledger: Record<string, any>;
}): void {
  const binding = transfer.target_before_binding;
  assert.ok(binding);
  assert.equal(ledger.status, "resolved");
  assert.equal(ledger.safe_to_retry, true);
  assert.equal(ledger.dispatcher_pid, null);
  assert.equal(ledger.deferred_foreground_transfer_id, transfer.transfer_id);
  assert.equal(ledger.generation_id, transfer.message_id);
  assert.equal(ledger.conversation_id, transfer.turn_id);
  assert.equal(ledger.session_id, transfer.target_session_id);
  assert.equal(ledger.turn_id, transfer.turn_id);
  assert.equal(ledger.message_id, transfer.message_id);
  assert.equal(ledger.message_type, "task");
  assert.equal(ledger.request_hash, transfer.request_hash);
  assert.equal(ledger.executor_kind, "codex");
  assert.equal(ledger.binding_id, binding.binding_id);
  assert.equal(ledger.binding_generation, binding.generation);
  assert.equal(ledger.native_thread_id, undefined);
  assert.equal(path.resolve(ledger.store_dir), path.resolve(fixture.storeDir));
  assert.equal(path.resolve(ledger.state_path), path.resolve(String(
    transfer.state_path
  )));
  assert.ok(ledger.aborted_at);
  assert.ok(ledger.resolved_at);
  assert.equal(ledger.aborted_at, ledger.resolved_at);

  const forbiddenInputFields = [
    "dispatch_started_at",
    "text_injected_at",
    "enter_dispatched_at",
    "submitted_at",
    "agent_accepted_at",
    "not_accepted_at",
    "uncertain_at",
    "acceptance_evidence"
  ];
  for (const field of forbiddenInputFields) {
    assert.equal(ledger[field], undefined, field);
  }
  const receipts = ledger.terminal_submission_receipts;
  assert.ok(Array.isArray(receipts));
  const ownReceipts = receipts.filter(
    (receipt: Record<string, any>) => receipt.message_id === transfer.message_id
  );
  assert.equal(ownReceipts.length, 1, JSON.stringify(receipts, null, 2));
  const receipt = ownReceipts[0];
  assert.equal(receipt.status, "aborted");
  assert.equal(receipt.safe_to_retry, true);
  assert.equal(receipt.aborted_at, ledger.aborted_at);
  assert.equal(receipt.resolved_at, ledger.resolved_at);
  for (const field of [
    "terminal_control",
    "terminal_endpoint",
    "generation_id",
    "conversation_id",
    "session_id",
    "turn_id",
    "message_id",
    "message_type",
    "message_body_hash",
    "request_hash",
    "executor_kind",
    "store_dir",
    "state_path",
    "event_log_path",
    "deferred_foreground_transfer_id",
    "binding_id",
    "binding_generation",
    "native_thread_id",
    "callback_expected",
    "dispatcher_pid"
  ]) {
    assert.deepEqual(receipt[field], ledger[field], field);
  }
  for (const field of forbiddenInputFields) {
    assert.equal(receipt[field], undefined, `receipt ${field}`);
  }
}

function assertResolvedSameUuidDeferredTransfer({
  fixture,
  sourceSessionId,
  originalBindingId,
  originalGeneration
}: {
  fixture: NoRolloutFixture;
  sourceSessionId: string;
  originalBindingId: string;
  originalGeneration: number;
}): void {
  const transfers = listDeferredForegroundTransfers(fixture.storeDir);
  const transfer = transfers.find((candidate) =>
    candidate.status === "resolved"
  );
  assert.ok(transfer, JSON.stringify(transfers, null, 2));
  assert.equal(transfer.source_retirement, "binding_scrubbed_same_native_thread");
  assert.equal(transfer.target_native_thread_id, NATIVE_THREAD_ID);

  const source = loadManagedSession(fixture.storeDir, sourceSessionId);
  const target = loadManagedSession(
    fixture.storeDir,
    transfer.target_session_id
  );
  assert.equal(source.status, "detached");
  assert.equal(source.binding?.native_thread_id, undefined);
  assert.equal(source.binding?.native_process.rollout, undefined);
  assert.notEqual(source.binding?.binding_id, originalBindingId);
  assert.equal(source.binding?.generation, originalGeneration + 1);
  assert.equal(target.status, "bound");
  assert.equal(target.binding?.native_thread_id, NATIVE_THREAD_ID);
  assert.equal(
    listManagedSessions(fixture.storeDir).filter(
      (session) => session.binding?.native_thread_id === NATIVE_THREAD_ID
    ).map((session) => session.session_id).join(","),
    target.session_id,
    "the accepted native UUID must have exactly one Store owner"
  );
  const turn = listConversations(fixture.storeDir).find(
    (candidate) => candidate.session_id === target.session_id
  );
  assert.ok(turn);
  assert.equal(turn.native_thread_id, NATIVE_THREAD_ID);
  assert.equal(
    (turn.native_session_takeover as Record<string, any>)
      .terminal_bridge_submission?.status,
    "agent_accepted"
  );
}

function reconcileArguments(
  fixture: NoRolloutFixture,
  argumentsValue: Record<string, unknown>
): string[] {
  return [
    "reconcile-binding",
    "--terminal",
    String(argumentsValue.terminal_id),
    "--conflicting-session",
    String(argumentsValue.conflicting_session_id),
    "--expected-session-revision",
    String(argumentsValue.expected_session_revision),
    "--expected-binding-token",
    String(argumentsValue.expected_binding_token),
    "--expected-terminal-token",
    String(argumentsValue.expected_terminal_token),
    ...codexNoRolloutStoreArgs(fixture)
  ];
}

function persistBlockingTurn(
  fixture: NoRolloutFixture,
  session: ManagedSessionState,
  status: "waiting_for_agent" | "stalled" = "waiting_for_agent"
): void {
  const now = new Date("2026-08-06T02:31:00.000Z");
  const base = createConversation({
    userRequest: "This unresolved Turn must block binding reconciliation.",
    sessionId: session.session_id,
    executorKind: "codex",
    executorSession: "codex-reconcile-blocker",
    now
  });
  const paths = pathsForConversation(base.conversation_id, fixture.storeDir);
  saveState(paths.statePath, {
    ...base,
    status,
    ...(status === "stalled"
      ? {
          stalled_at: now.toISOString(),
          stalled_reason: "test-only unresolved Codex dispatch"
        }
      : {}),
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: `message-${base.conversation_id}`,
      terminal_bridge_started_at: now.toISOString(),
      terminal_agent_session_id: NATIVE_THREAD_ID,
      terminal_control: fixture.terminalControl
    },
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath,
    updated_at: now.toISOString()
  });
}

function persistLegacyV1UncertainTurn(
  fixture: NoRolloutFixture,
  session: ManagedSessionState,
  message: string
): string {
  const binding = session.binding;
  assert.ok(binding);
  assert.ok(binding.native_thread_id);
  assert.ok(binding.terminal_endpoint);
  const preparedAt = "2026-08-12T01:33:47.000Z";
  const textInjectedAt = "2026-08-12T01:33:47.010Z";
  const enterDispatchedAt = "2026-08-12T01:33:47.020Z";
  const uncertainAt = "2026-08-12T01:33:47.030Z";
  const base = createConversation({
    userRequest: message,
    sessionId: session.session_id,
    executorKind: "codex",
    executorSession: "codex-legacy-v1-uncertain",
    workspace: session.workspace,
    now: new Date(preparedAt)
  });
  const turnId = base.turn_id;
  const messageId = `message-${turnId}`;
  const requestHash = createHash("sha256").update(message).digest("hex");
  const messageBodyHash = createHash("sha256").update(message).digest("hex");
  const paths = pathsForConversation(turnId, fixture.storeDir);
  const submission = {
    status: "uncertain",
    session_id: session.session_id,
    turn_id: turnId,
    message_id: messageId,
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    message_type: "task",
    message_body_hash: messageBodyHash,
    request_hash: requestHash,
    executor_kind: "codex",
    openclaw_session: base.openclaw_session,
    store_dir: path.resolve(fixture.storeDir),
    native_thread_id: binding.native_thread_id,
    terminal_target: fixture.terminalControl.target,
    terminal_socket_path: fixture.terminalControl.socketPath ?? null,
    terminal_pane_pid: fixture.terminalControl.panePid,
    terminal_endpoint: binding.terminal_endpoint,
    prepared_at: preparedAt,
    text_injected_at: textInjectedAt,
    enter_dispatched_at: enterDispatchedAt,
    uncertain_at: uncertainAt,
    dispatcher_pid: process.pid,
    last_proven_stage: "enter_dispatched",
    error: "legacy v1 acceptance could not attribute the post-clear rollout"
  };
  saveState(paths.statePath, {
    ...base,
    status: "stalled",
    stalled_at: uncertainAt,
    stalled_reason:
      "terminal submission outcome is uncertain; inspect the shared terminal pane before continuing",
    terminal_binding_id: binding.binding_id,
    terminal_binding_generation: binding.generation,
    native_thread_id: binding.native_thread_id,
    native_session_takeover: {
      agent: "codex",
      terminal_agent_identity_protocol: 1,
      native_session_id: fixture.terminalId,
      terminal_agent_pid: fixture.codexPid,
      terminal_agent_session_id: binding.native_thread_id,
      terminal_agent_process_uuid: binding.native_process.process_uuid,
      terminal_agent_process_birth: binding.native_process.process_birth,
      terminal_agent_rollout: binding.native_process.rollout,
      terminal_agent_identity_evidence: binding.native_process.evidence,
      source_cwd: session.workspace,
      strategy: "terminal_control",
      terminal_control: fixture.terminalControl,
      terminal_endpoint: binding.terminal_endpoint,
      terminal_bridge: true,
      terminal_bridge_started_at: preparedAt,
      terminal_bridge_message_id: messageId,
      terminal_bridge_request_text: message,
      terminal_bridge_request_hash: requestHash,
      terminal_bridge_submission: submission,
      terminal_bridge_submission_receipts: [submission]
    },
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath,
    updated_at: uncertainAt
  });

  const identity = terminalEndpointIdentityFromEvidence(
    binding.terminal_endpoint
  );
  assert.ok(identity);
  const terminalKey = createHash("sha256")
    .update(terminalEndpointIdentityKey(identity))
    .digest("hex")
    .slice(0, 20);
  const ledgerDir = path.join(
    String(fixture.environment.AKK_RUNTIME_DIR),
    "terminal-dispatch"
  );
  const ledgerPath = path.join(
    ledgerDir,
    `terminal-dispatch-${terminalKey}.json`
  );
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    version: 2,
    terminal_key: terminalKey,
    terminal_control: {
      kind: fixture.terminalControl.kind,
      target: fixture.terminalControl.target,
      socket_path: fixture.terminalControl.socketPath ?? null,
      pane_pid: fixture.terminalControl.panePid ?? null,
      current_path: fixture.terminalControl.currentPath ?? null
    },
    terminal_endpoint: binding.terminal_endpoint,
    status: "uncertain",
    generation_id: messageId,
    conversation_id: turnId,
    session_id: session.session_id,
    turn_id: turnId,
    message_id: messageId,
    message_type: "task",
    message_body_hash: messageBodyHash,
    request_hash: requestHash,
    executor_kind: "codex",
    openclaw_session: base.openclaw_session,
    store_dir: path.resolve(fixture.storeDir),
    state_path: path.resolve(paths.statePath),
    event_log_path: path.resolve(paths.logPath),
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    native_thread_id: binding.native_thread_id,
    prepared_at: preparedAt,
    text_injected_at: textInjectedAt,
    enter_dispatched_at: enterDispatchedAt,
    uncertain_at: uncertainAt,
    dispatcher_pid: process.pid,
    callback_expected: false,
    error: submission.error
  }, null, 2)}\n`, { mode: 0o600 });
  return turnId;
}

function persistReleasedCandidateSourceTurns(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
): void {
  const statuses = ["idle", "closed", "cancelled", "failed"] as const;
  statuses.forEach((status, index) => {
    const now = new Date(Date.UTC(2026, 7, 12, 1, index, 0));
    const base = createConversation({
      userRequest: `Released candidate history ${status}.`,
      sessionId: session.session_id,
      executorKind: "codex",
      executorSession: `codex-candidate-history-${status}`,
      workspace: session.workspace,
      now
    });
    const paths = pathsForConversation(base.conversation_id, fixture.storeDir);
    saveState(paths.statePath, {
      ...base,
      status,
      ...(status === "idle" ? { idle_since: now.toISOString() } : {}),
      ...(status === "closed"
        ? {
            closed_at: now.toISOString(),
            close_reason: "test-only released candidate history"
          }
        : {}),
      terminal_binding_id: session.binding?.binding_id,
      terminal_binding_generation: session.binding?.generation,
      native_thread_id: session.binding?.native_thread_id,
      native_session_takeover: {
        agent: "codex",
        terminal_agent_identity_protocol: 1,
        native_session_id: fixture.terminalId,
        terminal_agent_pid: fixture.codexPid,
        terminal_agent_session_id: session.binding?.native_thread_id,
        terminal_agent_process_uuid:
          session.binding?.native_process.process_uuid,
        terminal_agent_process_birth:
          session.binding?.native_process.process_birth,
        terminal_agent_rollout: session.binding?.native_process.rollout,
        terminal_agent_identity_evidence:
          session.binding?.native_process.evidence,
        source_cwd: session.workspace,
        strategy: "terminal_control",
        terminal_control: fixture.terminalControl,
        terminal_bridge: true
      },
      store_dir: paths.storeDir,
      conversation_dir: paths.conversationDir,
      event_log_path: paths.logPath,
      state_path: paths.statePath,
      updated_at: now.toISOString()
    });
  });
}

function persistUnresolvedTransition(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
): NativeThreadTransition {
  const preparedAt = new Date("2026-08-06T02:32:00.000Z");
  return saveNativeThreadTransition(fixture.storeDir, {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: "transition-reconcile-blocker",
    operation: "new_thread",
    status: "prepared",
    terminal_id: fixture.terminalId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    source_session_id: session.session_id,
    source_expected_revision: session.revision,
    target_session_id: "session-reconcile-transition-target",
    target_expected_revision: null,
    before_native_thread_id:
      session.binding?.native_thread_id ?? EXTERNAL_THREAD_ID,
    before_process_uuid:
      session.binding?.native_process.process_uuid ??
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
    before_process_birth:
      session.binding?.native_process.process_birth ?? LIVE_PROCESS_BIRTH,
    before_binding: session.binding,
    adapter_version: "0.146.1",
    command_fingerprint: createHash("sha256")
      .update("fixture-reconcile-transition")
      .digest("hex"),
    dispatcher_pid: process.pid,
    prepared_at: preparedAt.toISOString()
  }, { expectedRevision: null });
}

function persistUnresolvedDispatchLedger(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
): void {
  const terminalKey = createHash("sha256")
    .update(JSON.stringify({
      target: fixture.terminalControl.target,
      socket_path: null
    }))
    .digest("hex")
    .slice(0, 20);
  const runtimeDir = String(fixture.environment.AKK_RUNTIME_DIR);
  const ledgerPath = path.join(
    runtimeDir,
    "terminal-dispatch",
    `terminal-dispatch-${terminalKey}.json`
  );
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    version: 1,
    terminal_key: terminalKey,
    terminal_control: {
      kind: "tmux",
      target: fixture.terminalControl.target,
      socket_path: null,
      pane_pid: fixture.terminalControl.panePid,
      current_path: fixture.terminalControl.currentPath
    },
    kind: "turn",
    generation_id: "message-reconcile-ledger-blocker",
    conversation_id: `turn-for-${session.session_id}`,
    message_id: "message-reconcile-ledger-blocker",
    status: "uncertain",
    prepared_at: "2026-08-06T02:33:00.000Z",
    uncertain_at: "2026-08-06T02:33:01.000Z"
  })}\n`, { mode: 0o600 });
}

function processUuid(pid: number, processBirth: string): string {
  return `codex-pid:${pid}:birth:${processBirth}`;
}

interface CliTestResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

class InProcessCliExit extends Error {
  constructor(readonly status: number) {
    super(`in-process CLI exit ${status}`);
  }
}

interface FixtureMutableCheckpoint {
  activeNativeThreadId: string;
  activeRolloutPath: string;
  appendAcceptanceOnProbe?: number;
  deferredAcceptanceRequest?: string;
  openRootRollouts?: Array<{
    nativeThreadId: string;
    rolloutPath: string;
    fd: string;
  }>;
  acceptanceNativeThreadIdsOnEnter?: string[];
  clockMs: number;
  runtimeLogCount: number;
  ttyViewportInspectionCount: number;
}

interface CapturedInProcessExit {
  status: number;
  snapshotRoot: string;
  snapshotPath: string;
}

function rewriteSnapshotLockOwners(
  directory: string,
  deadPid: number
): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteSnapshotLockOwners(entryPath, deadPid);
      continue;
    }
    if (!entry.isFile() || !/\.(?:lock|reclaim)$/u.test(entry.name)) {
      continue;
    }
    const contents = fs.readFileSync(entryPath, "utf8").trim();
    try {
      const owner = JSON.parse(contents) as Record<string, unknown>;
      if (owner.pid === process.pid) {
        fs.writeFileSync(
          entryPath,
          `${JSON.stringify({ ...owner, pid: deadPid })}\n`,
          "utf8"
        );
      }
    } catch {
      if (Number(contents) === process.pid) {
        fs.writeFileSync(entryPath, `${deadPid}\n`, "utf8");
      }
    }
  }
}

function restoreDirectorySnapshot(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  const sourceEntries = new Map(
    fs.readdirSync(source, { withFileTypes: true }).map((entry) => [
      entry.name,
      entry
    ])
  );
  for (const destinationEntry of fs.readdirSync(destination, {
    withFileTypes: true
  })) {
    if (!sourceEntries.has(destinationEntry.name)) {
      fs.rmSync(path.join(destination, destinationEntry.name), {
        recursive: true,
        force: true
      });
    }
  }
  for (const [name, sourceEntry] of sourceEntries) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const destinationStat = (() => {
      try {
        return fs.lstatSync(destinationPath);
      } catch {
        return undefined;
      }
    })();
    if (sourceEntry.isDirectory()) {
      if (destinationStat && !destinationStat.isDirectory()) {
        fs.rmSync(destinationPath, { recursive: true, force: true });
      }
      restoreDirectorySnapshot(sourcePath, destinationPath);
      continue;
    }
    if (sourceEntry.isFile() && destinationStat?.isFile()) {
      const sourceStat = fs.statSync(sourcePath);
      fs.copyFileSync(sourcePath, destinationPath);
      fs.chmodSync(destinationPath, sourceStat.mode);
      fs.utimesSync(destinationPath, sourceStat.atime, sourceStat.mtime);
      continue;
    }
    if (destinationStat) {
      fs.rmSync(destinationPath, { recursive: true, force: true });
    }
    fs.cpSync(sourcePath, destinationPath, {
      recursive: sourceEntry.isDirectory(),
      preserveTimestamps: true
    });
  }
}

function fixtureMutableCheckpoint(
  fixture: NoRolloutFixture
): FixtureMutableCheckpoint {
  return {
    activeNativeThreadId: fixture.activeNativeThreadId,
    activeRolloutPath: fixture.activeRolloutPath,
    ...(fixture.appendAcceptanceOnProbe === undefined
      ? {}
      : { appendAcceptanceOnProbe: fixture.appendAcceptanceOnProbe }),
    ...(fixture.deferredAcceptanceRequest === undefined
      ? {}
      : { deferredAcceptanceRequest: fixture.deferredAcceptanceRequest }),
    ...(fixture.openRootRollouts === undefined
      ? {}
      : {
          openRootRollouts: fixture.openRootRollouts.map((candidate) => ({
            ...candidate
          }))
        }),
    ...(fixture.acceptanceNativeThreadIdsOnEnter === undefined
      ? {}
      : {
          acceptanceNativeThreadIdsOnEnter:
            [...fixture.acceptanceNativeThreadIdsOnEnter]
        }),
    clockMs: fixture.clockMs,
    runtimeLogCount: fixture.runtimeLogs.length,
    ttyViewportInspectionCount: fixture.ttyViewportInspectionPids.length
  };
}

function restoreFixtureMutableCheckpoint(
  fixture: NoRolloutFixture,
  checkpoint: FixtureMutableCheckpoint
): void {
  fixture.activeNativeThreadId = checkpoint.activeNativeThreadId;
  fixture.activeRolloutPath = checkpoint.activeRolloutPath;
  if (checkpoint.appendAcceptanceOnProbe === undefined) {
    delete fixture.appendAcceptanceOnProbe;
  } else {
    fixture.appendAcceptanceOnProbe = checkpoint.appendAcceptanceOnProbe;
  }
  if (checkpoint.deferredAcceptanceRequest === undefined) {
    delete fixture.deferredAcceptanceRequest;
  } else {
    fixture.deferredAcceptanceRequest = checkpoint.deferredAcceptanceRequest;
  }
  fixture.openRootRollouts = checkpoint.openRootRollouts?.map((candidate) => ({
    ...candidate
  }));
  fixture.acceptanceNativeThreadIdsOnEnter =
    checkpoint.acceptanceNativeThreadIdsOnEnter === undefined
      ? undefined
      : [...checkpoint.acceptanceNativeThreadIdsOnEnter];
  fixture.clockMs = checkpoint.clockMs;
  fixture.runtimeLogs.length = checkpoint.runtimeLogCount;
  fixture.ttyViewportInspectionPids.length =
    checkpoint.ttyViewportInspectionCount;
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  onExit?: (status: number) => never
): Promise<CliTestResult> {
  const parsed = parseCliCommand(args);
  const storeDir = String(parsed.options.storeDir ?? "");
  const fixture = inProcessFixtures.get(storeDir);
  assert.ok(fixture, `missing in-process fixture for ${storeDir}`);
  try {
    const result = await executeCliCommand(
      parsed.command,
      parsed.options,
      inProcessDependencies(fixture, env, onExit)
    );
    return {
      status: result.exitCode,
      stdout: result.stdout,
      stderr: ""
    };
  } catch (error) {
    return {
      status: error instanceof InProcessCliExit ? error.status : 1,
      stdout: "",
      stderr: error instanceof InProcessCliExit ? "" : errorMessage(error)
    };
  }
}

/**
 * Execute through the imported command and virtual clock, but freeze the exact
 * durable checkpoint observed by cliExit before ordinary exception unwinding
 * can compensate it. Restoring that snapshot after the command unwinds models
 * the state a hard process exit leaves for the next recovery invocation.
 */
async function runCliCrashCheckpoint(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<CliTestResult> {
  const parsed = parseCliCommand(args);
  const storeDir = String(parsed.options.storeDir ?? "");
  const fixture = inProcessFixtures.get(storeDir);
  assert.ok(fixture, `missing in-process fixture for ${storeDir}`);
  const mutableCheckpoint = fixtureMutableCheckpoint(fixture);
  const previousCliPid = fixture.cliPid;
  fixture.cliPid = SIMULATED_DEAD_CLI_PID;
  let captured: CapturedInProcessExit | undefined;
  try {
    const result = await runCli(args, env, (status) => {
      if (!captured) {
        const snapshotRoot = fs.mkdtempSync(
          path.join(os.tmpdir(), "akk-in-process-cli-exit-")
        );
        const snapshotPath = path.join(snapshotRoot, "fixture");
        try {
          fs.cpSync(fixture.tempDir, snapshotPath, {
            recursive: true,
            preserveTimestamps: true
          });
          rewriteSnapshotLockOwners(snapshotPath, SIMULATED_DEAD_CLI_PID);
          captured = { status, snapshotRoot, snapshotPath };
        } catch (error) {
          fs.rmSync(snapshotRoot, { recursive: true, force: true });
          throw error;
        }
      }
      throw new InProcessCliExit(status);
    });
    if (!captured) {
      return result;
    }
    restoreDirectorySnapshot(captured.snapshotPath, fixture.tempDir);
    restoreFixtureMutableCheckpoint(fixture, mutableCheckpoint);
    return { status: captured.status, stdout: "", stderr: "" };
  } finally {
    if (captured) {
      fs.rmSync(captured.snapshotRoot, { recursive: true, force: true });
    }
    if (previousCliPid === undefined) {
      delete fixture.cliPid;
    } else {
      fixture.cliPid = previousCliPid;
    }
  }
}

/** Deliberate crash/exit and detached child-lifecycle process goldens. */
function runCliSubprocess(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000
  });
}

const inProcessFixtures = new Map<string, NoRolloutFixture>();

function fixtureHerdrResponse(
  request: HerdrWireRequest,
  result: Record<string, unknown>
): Record<string, unknown> {
  return { id: request.id, result };
}

function createFixtureHerdrProvider(
  fixture: NoRolloutFixture,
  env: NodeJS.ProcessEnv,
  nowMs: () => number
): HerdrTerminalControlProvider {
  const control = fixture.terminalControl;
  assert.equal(control.kind, "herdr");
  const sessionList = JSON.stringify({
    sessions: [{
      name: control.session,
      default: true,
      running: true,
      socket_path: control.socketPath,
      session_dir: control.sessionDir
    }]
  });
  return new HerdrTerminalControlProvider({
    command: "herdr-fixture",
    runCommand: (_command, args) =>
      args[0] === "--version"
        ? successfulCommand(`herdr ${HERDR_EXACT_VERSION}\n`)
        : successfulCommand(sessionList),
    statSocket: () => ({
      device: "1",
      inode: "7001",
      ctimeNs: "1000000",
      ownerUid: 501
    }),
    inspectTtyViewport: (shellPid) => {
      fixture.ttyViewportInspectionPids.push(shellPid);
      return fixture.ttyViewportColumns === null
        ? undefined
        : {
            columns: fixture.ttyViewportColumns,
            rows: fixture.ttyViewportRows
          };
    },
    request: async (_socketPath, request) => {
      if (request.method === "ping") {
        return fixtureHerdrResponse(request, {
          type: "pong",
          version: HERDR_EXACT_VERSION,
          protocol: HERDR_EXACT_PROTOCOL,
          capabilities: {
            live_handoff: true,
            detached_server_daemon: true
          }
        });
      }
      if (request.method === "session.snapshot") {
        return fixtureHerdrResponse(request, {
          type: "session_snapshot",
          snapshot: {
            version: HERDR_EXACT_VERSION,
            protocol: HERDR_EXACT_PROTOCOL,
            panes: [{
              pane_id: control.paneId,
              terminal_id: control.terminalId,
              workspace_id: control.workspaceId,
              tab_id: control.tabId,
              cwd: control.currentPath,
              focused: true,
              agent_status: null,
              revision: 1
            }],
            ...(fixture.viewportColumns === null
              ? {}
              : {
                  layouts: [{
                    workspace_id: control.workspaceId,
                    tab_id: control.tabId,
                    zoomed: fixture.viewportZoomed,
                    ...(fixture.viewportFocusedPaneId
                      ? { focused_pane_id: fixture.viewportFocusedPaneId }
                      : {}),
                    ...(fixture.viewportAreaColumns === undefined ||
                      fixture.viewportAreaRows === undefined
                      ? {}
                      : {
                          area: {
                            x: 0,
                            y: 0,
                            width: fixture.viewportAreaColumns,
                            height: fixture.viewportAreaRows
                          }
                        }),
                    panes: [{
                      pane_id: control.paneId,
                      focused: fixture.viewportPaneFocused,
                      rect: {
                        x: 0,
                        y: 0,
                        width: fixture.viewportColumns,
                        height: fixture.viewportRows
                      }
                    }],
                    splits: []
                  }]
                })
          }
        });
      }
      if (request.method === "pane.process_info") {
        return fixtureHerdrResponse(request, {
          type: "pane_process_info",
          process_info: {
            pane_id: control.paneId,
            shell_pid: control.panePid,
            foreground_process_group_id: fixture.codexPid,
            foreground_processes: [{
              pid: fixture.codexPid,
              name: "codex",
              argv0: "codex",
              argv: ["codex", "--yolo"],
              cmdline: "codex --yolo",
              cwd: control.currentPath
            }]
          }
        });
      }
      if (request.method === "pane.read") {
        const screen = fs.readFileSync(fixture.screenPath, "utf8");
        const preserveEscapes = request.params.source === "visible" &&
          request.params.format === "ansi";
        return fixtureHerdrResponse(request, {
          type: "pane_read",
          read: {
            pane_id: control.paneId,
            workspace_id: control.workspaceId,
            tab_id: control.tabId,
            source: request.params.source,
            format: request.params.format,
            text: preserveEscapes
              ? screen
              : screen.replace(/\u001b\[[0-9;]*m/gu, ""),
            revision: 1,
            truncated: false
          }
        });
      }
      if (request.method === "pane.send_input") {
        const text = typeof request.params.text === "string"
          ? request.params.text
          : undefined;
        const keys = Array.isArray(request.params.keys)
          ? request.params.keys
          : [];
        if (
          text !== undefined &&
          env.AKK_TEST_TMUX_TEXT_FAILURE === "1" &&
          text !== "/status"
        ) {
          fs.appendFileSync(
            fixture.tmuxCallsPath,
            `${JSON.stringify({
              args: ["send-keys", "-t", fixture.target, "-l", text],
              at: nowMs()
            })}\n`
          );
          return {
            id: request.id,
            error: {
              code: "pane_send_failed",
              message: "injected Herdr text failure before input"
            }
          };
        }
        const result = text !== undefined
          ? runInProcessTmux(
              fixture,
              env,
              ["send-keys", "-t", fixture.target, "-l", text],
              nowMs()
            )
          : keys.includes("enter")
            ? runInProcessTmux(
                fixture,
                env,
                ["send-keys", "-t", fixture.target, "C-m"],
                nowMs()
              )
            : successfulCommand();
        if (result.status !== 0) {
          throw new Error(result.stderr || "fixture Herdr input failed");
        }
        return fixtureHerdrResponse(request, { type: "ok" });
      }
      throw new Error(`unexpected fixture Herdr request ${request.method}`);
    }
  });
}

function inProcessDependencies(
  fixture: NoRolloutFixture,
  env: NodeJS.ProcessEnv,
  onExit?: (status: number) => never
): CliCommandDependencies {
  // A fixture can invoke the CLI multiple times to simulate a restart. Keep its
  // virtual clock monotonic across those invocations: sleep advances virtual
  // time without blocking, so resetting to a faster wall clock can otherwise
  // make a later acceptance appear to precede the persisted Enter dispatch.
  let nowMs = Math.max(Date.now(), fixture.clockMs);
  fixture.clockMs = nowMs;
  const provider = fixture.terminalKind === "herdr"
    ? createFixtureHerdrProvider(fixture, env, () => nowMs)
    : new TmuxTerminalControlProvider({
        commands: ["tmux"],
        socketPaths: [],
        runCommand: (_command, args) =>
          runInProcessTmux(fixture, env, args, nowMs)
      });
  return {
    terminalControlProviderRegistry:
      createTerminalControlProviderRegistry([provider]),
    terminalProcessSource: new StaticTerminalProcessSource(
      fixtureProcessSnapshots(fixture)
    ),
    codexLocalSessionAdapter: createFixtureCodexAdapter(fixture),
    codexThreadLifecycleProvider: createFixtureLifecycleProvider(fixture),
    loadClaudeAgentRows: () => [],
    agentVersionForRunningProcess: () => fixture.codexVersion,
    codexProcessBirthForPid: () =>
      fs.readFileSync(fixture.processBirthPath, "utf8").trim(),
    ...(fixture.cliPid ? { pid: fixture.cliPid } : {}),
    cwd: fixture.terminalControl.currentPath,
    env,
    now: () => nowMs,
    monotonicNowMs: () => nowMs,
    sleep: async (milliseconds) => {
      nowMs += milliseconds;
      fixture.clockMs = nowMs;
    },
    sleepSync: (milliseconds) => {
      nowMs += milliseconds;
      fixture.clockMs = nowMs;
    },
    exit: onExit ?? ((status) => {
      throw new InProcessCliExit(status);
    }),
    runtimeLog: (level, event, fields) => {
      fixture.runtimeLogs.push({ level, event, fields });
    }
  };
}

function fixtureProcessSnapshots(fixture: NoRolloutFixture) {
  const panePid = fixture.terminalControl.panePid;
  const workspace = fixture.terminalControl.currentPath;
  return [
    {
      pid: panePid,
      ppid: 1,
      command: "zsh",
      cwd: workspace,
      elapsed: "00:10"
    },
    {
      pid: fixture.codexPid,
      ppid: panePid,
      command:
        `/opt/akk-test/releases/${fixture.codexVersion}-aarch64-apple-darwin/bin/codex`,
      cwd: workspace,
      elapsed: "00:09"
    }
  ];
}

function createFixtureCodexAdapter(
  fixture: NoRolloutFixture
): CodexLocalSessionAdapter {
  return {
    async listThreadRows() {
      if (!fixture.persistedCandidate) {
        return [];
      }
      return [{
        id: NATIVE_THREAD_ID,
        cwd: fixture.terminalControl.currentPath,
        rollout_path: fixture.rolloutPath,
        updated_at_ms: 1_786_000_000_000,
        archived: 0
      }];
    },
    async readRollout(rolloutPath) {
      return fs.existsSync(rolloutPath)
        ? fs.readFileSync(rolloutPath, "utf8")
        : undefined;
    },
    async listProcessSnapshots() {
      return fixtureProcessSnapshots(fixture);
    },
    ...(fixture.openRootRollouts !== undefined
      ? {
          async inspectOpenRootRolloutInventoryForPid(pid: number, cwd?: string) {
            assert.equal(pid, fixture.codexPid);
            return fixtureCodexOpenRootInventory(fixture, cwd);
          }
        }
      : {}),
    async resolveActiveSessionIdentityForPid(
      pid,
      cwd,
      preferredSessionId,
      allowedCompanionIdentity,
      allowedAdditionalIdentities
    ) {
      assert.equal(pid, fixture.codexPid);
      if (fixture.identityObservationError) {
        throw new Error(fixture.identityObservationError);
      }
      if (fixture.openRootRollouts !== undefined) {
        const inventory = fixtureCodexOpenRootInventory(fixture, cwd);
        const roots = inventory.roots;
        if (roots.length === 0) {
          return undefined;
        }
        if (!preferredSessionId) {
          if (roots.length !== 1) {
            throw new Error(
              `fixture Codex process has ${roots.length} ambiguous open roots`
            );
          }
          return roots[0];
        }
        const preferred = roots.find((root) =>
          root.sessionId === preferredSessionId
        );
        const allowed = [
          allowedCompanionIdentity,
          ...(allowedAdditionalIdentities ?? [])
        ].flatMap((candidate) => candidate ? [candidate] : []);
        const exactAllowed = roots.filter((root) => allowed.some((candidate) =>
          candidate.sessionId === root.sessionId &&
          candidate.processUuid === root.processUuid &&
          candidate.processBirth === root.processBirth &&
          candidate.rollout?.fd === root.rollout.fd &&
          candidate.rollout?.device === root.rollout.device &&
          candidate.rollout?.inode === root.rollout.inode &&
          candidate.rollout?.path === root.rollout.path
        ));
        if (roots.some((root) => root !== preferred && !exactAllowed.includes(root))) {
          throw new Error("fixture Codex process has an unexpected open root");
        }
        if (preferred) {
          return preferred;
        }
        if (exactAllowed[0]) {
          return exactAllowed[0];
        }
        throw new Error("fixture Codex preferred open root is unavailable");
      }
      const probeCount = fs.existsSync(fixture.rolloutProbeCountPath)
        ? Number(fs.readFileSync(fixture.rolloutProbeCountPath, "utf8"))
        : 0;
      const nextProbeCount = probeCount + 1;
      fs.writeFileSync(fixture.rolloutProbeCountPath, String(nextProbeCount));
      if (fixture.materializeRolloutOnProbe === nextProbeCount) {
        fs.writeFileSync(fixture.materializedPath, "ready");
      }
      if (!fs.existsSync(fixture.materializedPath)) {
        return undefined;
      }
      if (
        fixture.appendAcceptanceOnProbe === nextProbeCount &&
        fixture.deferredAcceptanceRequest
      ) {
        appendNativeAcceptance(
          fixture.activeRolloutPath,
          fixture.deferredAcceptanceRequest,
          FIRST_NATIVE_TURN_ID,
          {
            nativeThreadId: fixture.activeNativeThreadId,
            workspace: String(fixture.terminalControl.currentPath),
            codexVersion: fixture.codexVersion,
            timestamp: new Date().toISOString()
          }
        );
        fs.appendFileSync(
          fixture.activeRolloutPath,
          `${JSON.stringify({
            timestamp: "2026-08-06T00:00:02.000Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: FIRST_NATIVE_TURN_ID,
              last_agent_message: "Recovered exact result"
            }
          })}\n`
        );
        fs.writeFileSync(fixture.screenPath, "Recovered exact result\n› ");
        fixture.appendAcceptanceOnProbe = undefined;
      }
      const processBirth = fs.readFileSync(
        fixture.processBirthPath,
        "utf8"
      ).trim();
      const stat = fs.statSync(fixture.activeRolloutPath);
      return {
        sessionId: fixture.activeNativeThreadId,
        processUuid: processUuid(pid, processBirth),
        processBirth,
        rollout: {
          fd: "12u",
          device: String(stat.dev),
          inode: String(stat.ino),
          path: fs.realpathSync(fixture.activeRolloutPath)
        },
        evidence: "open_rollout_fd"
      };
    }
  };
}

function fixtureCodexOpenRootInventory(
  fixture: NoRolloutFixture,
  cwd = String(fixture.terminalControl.currentPath)
): CodexOpenRootRolloutInventory {
  const records = [`p${fixture.codexPid}`];
  for (const root of fixture.openRootRollouts ?? []) {
    const rolloutPath = fs.realpathSync(root.rolloutPath);
    const stat = fs.statSync(rolloutPath);
    records.push(
      `f${root.fd}`,
      "tREG",
      `D${stat.dev}`,
      `i${stat.ino}`,
      `n${rolloutPath}`
    );
  }
  return inspectCodexOpenRootRolloutInventory({
    codexHome: fixture.codexHome,
    pid: fixture.codexPid,
    cwd,
    processBirth: fs.readFileSync(
      fixture.processBirthPath,
      "utf8"
    ).trim(),
    lsofOutput: `${records.join("\n")}\n`
  });
}

function createFixtureLifecycleProvider(
  fixture: NoRolloutFixture
): TerminalThreadLifecycleCandidateProvider {
  const currentCandidate = (
    request: TerminalThreadLifecycleCandidateRequest
  ): TerminalThreadLifecycleCandidate | undefined => {
    if (
      !fixture.persistedCandidate ||
      path.resolve(request.cwd) !==
        path.resolve(String(fixture.terminalControl.currentPath))
    ) {
      return undefined;
    }
    const rolloutPath = fs.realpathSync(fixture.rolloutPath);
    const stat = fs.statSync(rolloutPath);
    const fileToken = {
      path: rolloutPath,
      device: String(stat.dev),
      inode: String(stat.ino),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
    const metadataFingerprint = createHash("sha256")
      .update(JSON.stringify({
        nativeThreadId: NATIVE_THREAD_ID,
        cwd: path.resolve(String(fixture.terminalControl.currentPath)),
        originator: "codex-tui",
        source: "cli",
        cliVersion: fixture.codexVersion,
        modelProvider: null,
        rolloutPath
      }))
      .digest("hex");
    const candidateToken = {
      schema: "agent-knock-knock/thread-candidate-token" as const,
      version: 1 as const,
      agent: "codex" as const,
      nativeThreadId: NATIVE_THREAD_ID,
      cwd: path.resolve(String(fixture.terminalControl.currentPath)),
      source: "codex_rollout" as const,
      agentVersion: request.agentVersion,
      fileToken,
      metadataFingerprint
    };
    return {
      agent: "codex",
      nativeThreadId: NATIVE_THREAD_ID,
      cwd: candidateToken.cwd,
      source: "codex_rollout",
      rootInteractive: true,
      fileToken,
      agentVersion: request.agentVersion,
      sourceAgentVersion: fixture.codexVersion,
      updatedAtMs: 1_786_000_000_000,
      metadataFingerprint,
      candidateToken
    };
  };
  return {
    async listThreadLifecycleCandidates(request) {
      const candidate = currentCandidate(request);
      return candidate ? [candidate] : [];
    },
    async revalidateThreadLifecycleCandidate(candidateOrToken, request) {
      const current = currentCandidate(request);
      if (!current) {
        return { status: "unavailable", reason: "fixture candidate unavailable" };
      }
      const supplied = "candidateToken" in candidateOrToken
        ? candidateOrToken.candidateToken
        : candidateOrToken as TerminalThreadLifecycleCandidateToken;
      return JSON.stringify(supplied) === JSON.stringify(current.candidateToken)
        ? { status: "valid", candidate: current }
        : { status: "changed", reason: "fixture candidate token changed" };
    }
  };
}

function runInProcessTmux(
  fixture: NoRolloutFixture,
  env: NodeJS.ProcessEnv,
  args: string[],
  nowMs: number
): CommandResult {
  fs.appendFileSync(
    fixture.tmuxCallsPath,
    `${JSON.stringify({ args, at: nowMs })}\n`
  );
  if (args[0] === "list-panes") {
    const injectDeferredIdentityDrift =
      env.AKK_TEST_DEFERRED_IDENTITY_DRIFT_BEFORE_TEXT === "1" &&
      listDeferredForegroundTransfers(fixture.storeDir).some(
        (transfer) =>
          transfer.status === "target_prepared" &&
          transfer.input_stage === "none"
      ) &&
      listConversations(fixture.storeDir).some((conversation) =>
        (conversation.native_session_takeover as Record<string, any> | undefined)
          ?.terminal_bridge_submission?.status === "prepared"
      );
    return successfulCommand(
      `${fixture.target.split(":")[0]}\t0\t0\t` +
      `${injectDeferredIdentityDrift
        ? Number(fixture.terminalControl.panePid) + 1
        : fixture.terminalControl.panePid}\tcodex\t` +
      `${fixture.terminalControl.currentPath}\t` +
      `\t${FIXTURE_TMUX_PANE_ID}\n`
    );
  }
  if (args[0] === "display-message") {
    return successfulCommand(
      fixture.viewportColumns === null
        ? ""
        : `${fixture.viewportColumns}\t${fixture.viewportRows}\n`
    );
  }
  if (args[0] === "capture-pane") {
    const screen = fs.readFileSync(fixture.screenPath, "utf8");
    return successfulCommand(
      args.includes("-e")
        ? screen
        : screen.replace(/\u001b\[[0-9;]*m/gu, "")
    );
  }
  if (args[0] === "send-keys" && args.includes("-l")) {
    const text = String(args.at(-1) ?? "");
    if (env.AKK_TEST_TMUX_TEXT_FAILURE === "1" && text !== "/status") {
      return {
        status: 1,
        stdout: "",
        stderr: "injected tmux text failure"
      };
    }
    const pendingInputPath = path.join(fixture.tempDir, "pending-input.txt");
    fs.writeFileSync(pendingInputPath, text);
    if (text !== "/status") {
      fs.writeFileSync(fixture.screenPath, `Ready\n› ${text}`);
    }
    if (
      text !== "/status" &&
      env.AKK_TEST_MATERIALIZE_ROLLOUT_AFTER_TEXT === "1"
    ) {
      fs.writeFileSync(fixture.materializedPath, "ready");
      appendNativeAcceptance(
        fixture.activeRolloutPath,
        text,
        FIRST_NATIVE_TURN_ID,
        {
          nativeThreadId: fixture.activeNativeThreadId,
          workspace: String(fixture.terminalControl.currentPath),
          codexVersion: fixture.codexVersion,
          timestamp: new Date(nowMs).toISOString()
        }
      );
    }
    if (text === "/status") {
      fs.writeFileSync(
        fixture.screenPath,
        fixture.codexVersion === "0.147.0"
          ? "Ready\n› /status\n\n" +
            "  /status      show current session configuration and token usage\n" +
            "  /statusline  configure which items appear in the status line\n"
          : "Ready\n› /status\n\n" +
            "  /status  show current session configuration and token usage\n"
      );
      if (env.AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT) {
        fs.writeFileSync(
          fixture.processBirthPath,
          env.AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT
        );
      }
    }
    return successfulCommand();
  }
  if (args[0] === "send-keys" && args.at(-1) === "C-m") {
    const pendingInputPath = path.join(fixture.tempDir, "pending-input.txt");
    const pendingInput = fs.existsSync(pendingInputPath)
      ? fs.readFileSync(pendingInputPath, "utf8")
      : "";
    fs.writeFileSync(pendingInputPath, "");
    if (pendingInput === "/status") {
      const statusSession = env.AKK_TEST_TRUNCATED_STATUS_CARD === "1"
        ? `${fixture.activeNativeThreadId.slice(0, 10)}...`
        : fixture.activeNativeThreadId;
      fs.writeFileSync(
        fixture.screenPath,
        `/status\n╭──────────────────────────────────────────────────╮\n` +
        `│ OpenAI Codex (v${fixture.codexVersion})                       │\n` +
        `│ Session: ${statusSession} │\n` +
        "│ Account: private@example.com                 │\n" +
        `╰──────────────────────────────────────────────────╯\n› `
      );
    } else if (pendingInput === "/clear") {
      const nextRolloutPath = path.join(
        path.dirname(fixture.rolloutPath),
        `rollout-2026-08-06T01-00-00-${EXTERNAL_THREAD_ID}.jsonl`
      );
      fs.writeFileSync(nextRolloutPath, `${JSON.stringify({
        timestamp: "2026-08-06T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: EXTERNAL_THREAD_ID,
          cwd: fixture.terminalControl.currentPath,
          originator: "codex-tui",
          source: "cli",
          cli_version: fixture.codexVersion
        }
      })}\n`, { mode: 0o600 });
      fixture.activeNativeThreadId = EXTERNAL_THREAD_ID;
      fixture.activeRolloutPath = nextRolloutPath;
      fs.writeFileSync(fixture.materializedPath, "ready");
      fs.writeFileSync(
        fixture.screenPath,
        `New Codex thread ${EXTERNAL_THREAD_ID}\n› `
      );
    } else {
      if (env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER) {
        fs.writeFileSync(
          fixture.processBirthPath,
          env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER
        );
      }
      fs.writeFileSync(fixture.materializedPath, "ready");
      if (
        env.AKK_TEST_SUPPRESS_NATIVE_ACCEPTANCE === "1" ||
        fixture.acceptanceNativeThreadIdsOnEnter?.length === 0
      ) {
        if (!fs.existsSync(fixture.activeRolloutPath)) {
          fs.mkdirSync(path.dirname(fixture.activeRolloutPath), {
            recursive: true,
            mode: 0o700
          });
          fs.writeFileSync(fixture.activeRolloutPath, `${JSON.stringify({
            timestamp: new Date(nowMs).toISOString(),
            type: "session_meta",
            payload: {
              id: fixture.activeNativeThreadId,
              cwd: fixture.terminalControl.currentPath,
              originator: "codex-tui",
              source: "cli",
              cli_version: fixture.codexVersion
            }
          })}\n`, { mode: 0o600 });
        }
      } else if (fixture.acceptanceNativeThreadIdsOnEnter) {
        for (const nativeThreadId of fixture.acceptanceNativeThreadIdsOnEnter) {
          const rolloutPath = ensureFixtureCandidateRollout(
            fixture,
            nativeThreadId,
            new Date(nowMs).toISOString()
          );
          appendNativeAcceptance(
            rolloutPath,
            pendingInput,
            FIRST_NATIVE_TURN_ID,
            {
              nativeThreadId,
              workspace: String(fixture.terminalControl.currentPath),
              codexVersion: fixture.codexVersion,
              timestamp: new Date(nowMs).toISOString()
            }
          );
        }
        fixture.activeNativeThreadId =
          fixture.acceptanceNativeThreadIdsOnEnter[0];
        fixture.activeRolloutPath = ensureFixtureCandidateRollout(
          fixture,
          fixture.activeNativeThreadId,
          new Date(nowMs).toISOString()
        );
      } else {
        appendNativeAcceptance(
          fixture.activeRolloutPath,
          pendingInput,
          FIRST_NATIVE_TURN_ID,
          {
            nativeThreadId: fixture.activeNativeThreadId,
            workspace: String(fixture.terminalControl.currentPath),
            codexVersion: fixture.codexVersion,
            timestamp: new Date(nowMs).toISOString()
          }
        );
      }
      fs.writeFileSync(fixture.screenPath, "Working\n");
    }
    return successfulCommand();
  }
  return successfulCommand();
}

function successfulCommand(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeFakeTmux(options: {
  fakeBinDir: string;
  callsPath: string;
  screenPath: string;
  pendingInputPath: string;
  materializedPath: string;
  processBirthPath: string;
  rolloutPath: string;
  codexVersion: "0.146.0" | "0.147.0";
  target: string;
  panePid: number;
  workspace: string;
  viewportColumns: number | null;
  viewportRows: number;
}): void {
  const statusPopup = options.codexVersion === "0.147.0"
    ? "Ready\n› /status\n\n" +
      "  /status      show current session configuration and token usage\n" +
      "  /statusline  configure which items appear in the status line\n"
    : "Ready\n› /status\n\n" +
      "  /status  show current session configuration and token usage\n";
  const fakeTmux = path.join(options.fakeBinDir, "tmux");
  fs.writeFileSync(fakeTmux, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.callsPath)}, JSON.stringify({ args, at: Date.now() }) + "\\n");
if (args[0] === "list-panes") {
  process.stdout.write(${JSON.stringify(
    `tmux-birth\t0\t0\t${options.panePid}\tcodex\t${options.workspace}` +
      `\t\t${FIXTURE_TMUX_PANE_ID}\n`
  )});
} else if (args[0] === "display-message") {
  process.stdout.write(${JSON.stringify(
    options.viewportColumns === null
      ? ""
      : `${options.viewportColumns}\t${options.viewportRows}\n`
  )});
} else if (args[0] === "capture-pane") {
  const screen = fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8");
  process.stdout.write(
    args.includes("-e")
      ? screen
      : screen.replace(/\\u001b\\[[0-9;]*m/g, "")
  );
} else if (args[0] === "send-keys" && args.includes("-l")) {
  if (
    process.env.AKK_TEST_TMUX_TEXT_FAILURE === "1" &&
    args.at(-1) !== "/status"
  ) {
    process.stderr.write("injected tmux text failure");
    process.exitCode = 1;
  } else {
    fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, args.at(-1));
    if (args.at(-1) === "/status") {
      fs.writeFileSync(${JSON.stringify(options.screenPath)},
        ${JSON.stringify(statusPopup)});
      const driftedProcessBirth =
        process.env.AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT;
      if (driftedProcessBirth) {
        fs.writeFileSync(
          ${JSON.stringify(options.processBirthPath)},
          driftedProcessBirth
        );
      }
    } else {
      fs.writeFileSync(
        ${JSON.stringify(options.screenPath)},
        "Ready\\n› " + String(args.at(-1) ?? "")
      );
    }
  }
} else if (args[0] === "send-keys" && args.at(-1) === "C-m") {
  const pendingInput = fs.existsSync(${JSON.stringify(options.pendingInputPath)})
    ? fs.readFileSync(${JSON.stringify(options.pendingInputPath)}, "utf8")
    : "";
  fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, "");
  if (pendingInput === "/status") {
    const statusSession = process.env.AKK_TEST_TRUNCATED_STATUS_CARD === "1"
      ? ${JSON.stringify(`${NATIVE_THREAD_ID.slice(0, 10)}...`)}
      : ${JSON.stringify(NATIVE_THREAD_ID)};
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, ${JSON.stringify(
      `/status\n╭──────────────────────────────────────────────────╮\n` +
      `│ OpenAI Codex (v${options.codexVersion})                       │\n` +
      `│ Session: `
    )} + statusSession + ${JSON.stringify(
      ` │\n│ Account: private@example.com                 │\n` +
      `╰──────────────────────────────────────────────────╯\n› `
    )});
  } else {
    if (process.env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER) {
      fs.writeFileSync(
        ${JSON.stringify(options.processBirthPath)},
        process.env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER
      );
    }
    fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
    const rolloutPath = ${JSON.stringify(options.rolloutPath)};
    if (rolloutPath && pendingInput) {
      const turnId = ${JSON.stringify(FIRST_NATIVE_TURN_ID)};
      if (!fs.existsSync(rolloutPath)) {
        fs.mkdirSync(require("node:path").dirname(rolloutPath), {
          recursive: true,
          mode: 0o700
        });
        fs.writeFileSync(rolloutPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "session_meta",
          payload: {
            id: ${JSON.stringify(NATIVE_THREAD_ID)},
            cwd: ${JSON.stringify(options.workspace)},
            originator: "codex-tui",
            source: "cli",
            cli_version: ${JSON.stringify(options.codexVersion)}
          }
        }) + "\\n", { mode: 0o600 });
      }
      if (process.env.AKK_TEST_SUPPRESS_NATIVE_ACCEPTANCE !== "1") {
        const records = [
          {
            timestamp: "2026-08-06T00:00:01.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: turnId }
          },
          {
            timestamp: "2026-08-06T00:00:01.010Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: pendingInput }],
              internal_chat_message_metadata_passthrough: { turn_id: turnId }
            }
          }
        ];
        fs.appendFileSync(
          rolloutPath,
          records.map((record) => JSON.stringify(record)).join("\\n") + "\\n"
        );
      }
    }
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Working\\n");
  }
}
`, { mode: 0o755 });
}

function writeFakeProcessTools(options: {
  fakeBinDir: string;
  materializedPath: string;
  materializeRolloutOnProbe?: number;
  processBirthPath: string;
  rolloutProbeCountPath: string;
  rolloutPath: string;
  executablePath: string;
  workspace: string;
  panePid: number;
  codexPid: number;
}): void {
  const fakePs = path.join(options.fakeBinDir, "ps");
  fs.writeFileSync(fakePs, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("lstart=")) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(options.processBirthPath)}, "utf8") + "\\n");
} else {
  process.stdout.write("  PID  PPID ELAPSED COMMAND\\n" +
    ${JSON.stringify(`${options.panePid} 1 00:10 zsh\n`)} +
    ${JSON.stringify(`${options.codexPid} ${options.panePid} 00:09 ${options.executablePath}\n`)});
}
`, { mode: 0o755 });

  const fakeLsof = path.join(options.fakeBinDir, "lsof");
  fs.writeFileSync(fakeLsof, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("cwd")) {
  process.stdout.write("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n" +
    "codex ${options.codexPid} me cwd DIR 1,18 64 123 ${options.workspace}\\n");
} else if (args.includes("txt")) {
  process.stdout.write("p${options.codexPid}\\nftxt\\nn${options.executablePath}\\n");
} else {
  const probeCountPath = ${JSON.stringify(options.rolloutProbeCountPath)};
  const probeCount = fs.existsSync(probeCountPath)
    ? Number(fs.readFileSync(probeCountPath, "utf8"))
    : 0;
  const nextProbeCount = probeCount + 1;
  fs.writeFileSync(probeCountPath, String(nextProbeCount));
  const materializeOnProbe = ${JSON.stringify(
    options.materializeRolloutOnProbe ?? null
  )};
  if (materializeOnProbe === nextProbeCount) {
    fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
  }
  if (fs.existsSync(${JSON.stringify(options.materializedPath)})) {
    const canonicalRolloutPath = fs.realpathSync(
      ${JSON.stringify(options.rolloutPath)}
    );
    const stat = fs.statSync(canonicalRolloutPath);
    process.stdout.write("p${options.codexPid}\\nf12u\\ntREG\\nD" + stat.dev +
      "\\ni" + stat.ino + "\\nn" + canonicalRolloutPath + "\\n");
  }
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
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const sql = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!sql || sql === "BEGIN;" || sql === "COMMIT;" || sql === ".quit") {
      continue;
    }
    if (sql === "pragma table_info(threads);") {
      process.stdout.write(${JSON.stringify(JSON.stringify(columns) + "\n")});
      continue;
    }
    const control = /^select '([^']+)' as "__akk_sqlite_control";$/u.exec(sql);
    if (control) {
      process.stdout.write(JSON.stringify([{
        __akk_sqlite_control: control[1]
      }]) + "\\n");
      continue;
    }
    if (sql.startsWith("select id")) {
      process.stdout.write(${JSON.stringify(JSON.stringify(rows) + "\n")});
      continue;
    }
    process.stderr.write("unexpected sqlite query: " + sql);
    process.exitCode = 1;
  }
});
process.stdin.resume();
`, { mode: 0o755 });
}

function readTmuxCalls(
  filePath: string
): Array<{ args: string[]; at?: number }> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendNativeAcceptance(
  rolloutPath: string,
  request: string,
  turnId: string,
  metadata: {
    nativeThreadId: string;
    workspace: string;
    codexVersion: string;
    timestamp: string;
  }
): void {
  if (!request) {
    return;
  }
  if (!fs.existsSync(rolloutPath)) {
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: metadata.timestamp,
      type: "session_meta",
      payload: {
        id: metadata.nativeThreadId,
        cwd: metadata.workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: metadata.codexVersion
      }
    })}\n`, { mode: 0o600 });
  }
  const records = [
    {
      timestamp: "2026-08-06T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId }
    },
    {
      timestamp: "2026-08-06T00:00:01.010Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: request }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    }
  ];
  fs.appendFileSync(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  );
}

function enableFixtureCandidateInventory(
  fixture: NoRolloutFixture,
  nativeThreadIds: string[]
): void {
  fixture.openRootRollouts = [];
  for (const nativeThreadId of nativeThreadIds) {
    ensureFixtureCandidateRollout(fixture, nativeThreadId);
  }
}

function ensureFixtureCandidateRollout(
  fixture: NoRolloutFixture,
  nativeThreadId: string,
  materializedAt = new Date().toISOString()
): string {
  const existing = fixture.openRootRollouts?.find((candidate) =>
    candidate.nativeThreadId === nativeThreadId
  );
  if (existing) {
    return existing.rolloutPath;
  }
  const rolloutPath = nativeThreadId === NATIVE_THREAD_ID
    ? fixture.rolloutPath
    : path.join(
        path.dirname(fixture.rolloutPath),
        `rollout-2026-08-12T00-00-00-${nativeThreadId}.jsonl`
      );
  if (!fs.existsSync(rolloutPath)) {
    fs.mkdirSync(path.dirname(rolloutPath), {
      recursive: true,
      mode: 0o700
    });
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: materializedAt,
      type: "session_meta",
      payload: {
        id: nativeThreadId,
        cwd: fixture.terminalControl.currentPath,
        originator: "codex-tui",
        source: "cli",
        cli_version: fixture.codexVersion
      }
    })}\n`, { mode: 0o600 });
  }
  fixture.openRootRollouts?.push({
    nativeThreadId,
    rolloutPath,
    fd: `${12 + (fixture.openRootRollouts?.length ?? 0)}u`
  });
  return rolloutPath;
}

function appendFixtureCompletion(
  fixture: NoRolloutFixture,
  nativeThreadId: string,
  text = "Candidate rollout completed exactly once."
): void {
  const rolloutPath = ensureFixtureCandidateRollout(
    fixture,
    nativeThreadId
  );
  fs.appendFileSync(rolloutPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: FIRST_NATIVE_TURN_ID,
      last_agent_message: text
    }
  })}\n`);
  fs.writeFileSync(fixture.screenPath, `${text}\n› `);
}

async function waitForFixtureConversation(
  statePath: string,
  predicate: (conversation: Record<string, any>) => boolean,
  timeoutMs: number
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, any> | undefined;
  while (Date.now() < deadline) {
    const current = JSON.parse(
      fs.readFileSync(statePath, "utf8")
    ) as Record<string, any>;
    latest = current;
    if (predicate(current)) {
      return current;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `fixture conversation did not settle before ${timeoutMs}ms: ` +
      JSON.stringify({
        status: latest?.status,
        stalled_reason: latest?.stalled_reason,
        native_session_takeover: latest?.native_session_takeover
      }, null, 2)
  );
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture process ${pid} did not exit before ${timeoutMs}ms`);
}
