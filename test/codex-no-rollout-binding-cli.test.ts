import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  executeCliCommand,
  parseCliCommand,
  type CliCommandDependencies
} from "../src/cli-core.js";
import type {
  CodexLocalSessionAdapter
} from "../src/codex-local-session-provider.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedSessionState,
  type NativeThreadTransition
} from "../src/managed-session.js";
import {
  listManagedSessions,
  loadManagedSession,
  loadNativeThreadTransition,
  nativeThreadTransitionsDir,
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

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const LIVE_PROCESS_BIRTH = "Thu Aug  6 10:00:00 2026";
const STALE_PROCESS_BIRTH = "Wed Aug  5 10:00:00 2026";
const NATIVE_THREAD_ID = "11111111-1111-4111-8111-111111111111";
const EXTERNAL_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_EXTERNAL_THREAD_ID = "33333333-3333-4333-8333-333333333333";
const FIRST_NATIVE_TURN_ID = "44444444-4444-4444-8444-444444444444";

test("virgin raw Codex attach atomically refines the Session and Turn binding after send", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const sent = runCliSubprocess([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "Start the first native Codex thread.",
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      fixture.target,
      "-l",
      "Start the first native Codex thread."
    ]);
    assert.deepEqual(sends.at(-1)?.args, [
      "send-keys",
      "-t",
      fixture.target,
      "C-m"
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("production-mode virgin Codex first send creates and binds its exact rollout", async () => {
  const fixture = createNoRolloutFixture({ rolloutInitiallyAbsent: true });
  const environment = {
    ...fixture.environment,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
  };
  try {
    assert.equal(fs.existsSync(path.dirname(fixture.rolloutPath)), false);
    const result = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "Open the first real Codex thread.",
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
        fixture.target,
        "-l",
        "Open the first real Codex thread."
      ],
      ["send-keys", "-t", fixture.target, "C-m"]
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
      const crashed = runCliSubprocess([
        "send",
        "--conversation",
        fixture.terminalId,
        "--message",
        `Recover exactly once after ${crashPoint.env}.`,
        "--background",
        "--store-dir",
        fixture.storeDir,
        "--codex-home",
        fixture.codexHome,
        "--openclaw-bin",
        "/usr/bin/true",
        "--disable-terminal-bridge-monitor"
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
        "--store-dir",
        fixture.storeDir,
        "--codex-home",
        fixture.codexHome,
        "--terminal-monitors-only"
      ];
      const recovered = runCliSubprocess(reconcileArgs, fixture.environment);
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);

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

      const recoveredAgain = runCliSubprocess(
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
    const crashed = runCliSubprocess([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      request,
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "1",
      "--agent-hard-timeout-minutes",
      "2"
    ], {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
    });
    assert.equal(monitored.status, 1, monitored.stdout);
    assert.match(
      monitored.stderr,
      /callback delivery requires a configured OpenClaw gateway method/u
    );

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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
  const environment = {
    ...fixture.environment,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
  };
  try {
    const raced = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "This task must not cross a newly materialized identity boundary.",
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
  const productionEnvironment = {
    ...fixture.environment,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
  };
  try {
    fs.writeFileSync(fixture.screenPath, "Ready\n› existing operator draft");
    const rejected = await runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "Blocked by the operator draft before resume.",
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome
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
    // One real process-exit golden proves crash-after-prepared remains fatal.
    const prepared = runCliSubprocess([
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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      "verified_empty_native_session"
    );
    assert.match(
      terminal.management_conflict.recovery,
      /snapshot-bound send action/u
    );
    assert.equal(
      terminal.handoff_state,
      "verified_empty_native_session_adoptable"
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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], fixture.environment);
    assert.equal(explicitOldSession.status, 1);
    assert.match(
      explicitOldSession.stderr,
      /detached|not bound|no longer bound|cannot send/iu
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
        "--background",
        "--store-dir",
        fixture.storeDir,
        "--codex-home",
        fixture.codexHome,
        "--openclaw-bin",
        "/usr/bin/true",
        "--disable-terminal-bridge-monitor"
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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      `To continue this session, run codex resume ${NATIVE_THREAD_ID}\n\n` +
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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
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
      fixture.target,
      "-l",
      "Inspect the repository without changing files."
    ]);
    assert.deepEqual(sends.at(-1)?.args, [
      "send-keys",
      "-t",
      fixture.target,
      "C-m"
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("unmanaged Codex lifecycle token changes when a PID is reused", async () => {
  const fixture = createNoRolloutFixture();
  try {
    const first = await runCli([
      "list",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome
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
    const inspected = runCliSubprocess(
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
      ["send-keys", "-t", fixture.target, "-l", "/status"],
      ["send-keys", "-t", fixture.target, "C-m"]
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome
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
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome
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
      ["send-keys", "-t", fixture.target, "-l", "/status"]
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
        "--store-dir",
        fixture.storeDir,
        "--codex-home",
        fixture.codexHome
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
  terminalId: string;
  terminalControl: TerminalControlRef;
  codexPid: number;
  codexVersion: "0.146.0" | "0.147.0";
  terminalKind: "tmux" | "herdr";
  persistedCandidate: boolean;
  rolloutInitiallyAbsent: boolean;
  materializeRolloutOnProbe?: number;
  appendAcceptanceOnProbe?: number;
  deferredAcceptanceRequest?: string;
  identityObservationError?: string;
  activeNativeThreadId: string;
  activeRolloutPath: string;
  environment: NodeJS.ProcessEnv;
  cleanup(): void;
}

function createNoRolloutFixture(
  {
    codexVersion = "0.146.0",
    materializeRolloutOnProbe,
    persistedCandidate = false,
    rolloutInitiallyAbsent = false,
    terminalKind = "tmux"
  }: {
    codexVersion?: "0.146.0" | "0.147.0";
    materializeRolloutOnProbe?: number;
    persistedCandidate?: boolean;
    rolloutInitiallyAbsent?: boolean;
    terminalKind?: "tmux" | "herdr";
  } = {}
): NoRolloutFixture {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-birth-"));
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
    workspace
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
    terminalId,
    terminalControl,
    codexPid,
    codexVersion,
    terminalKind,
    persistedCandidate,
    rolloutInitiallyAbsent,
    materializeRolloutOnProbe,
    activeNativeThreadId: NATIVE_THREAD_ID,
    activeRolloutPath: rolloutPath,
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
  processBirth: string
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-06T02:00:00.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-codex-status-card",
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId: NATIVE_THREAD_ID,
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
        fd: "24",
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
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fixture.codexHome
  ], fixture.environment);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const terminals = JSON.parse(listed.stdout).terminals;
  assert.equal(terminals.length, 1, listed.stdout);
  return terminals[0];
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
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fixture.codexHome
  ];
}

function persistBlockingTurn(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
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
    status: "waiting_for_agent",
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

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<CliTestResult> {
  const parsed = parseCliCommand(args);
  const storeDir = String(parsed.options.storeDir ?? "");
  const fixture = inProcessFixtures.get(storeDir);
  assert.ok(fixture, `missing in-process fixture for ${storeDir}`);
  try {
    const result = await executeCliCommand(
      parsed.command,
      parsed.options,
      inProcessDependencies(fixture, env)
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
 * Deliberate process-contract golden. Most semantics in this file run through
 * executeCliCommand with injected terminal/process/session seams below.
 */
function runCliSubprocess(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000
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
            }]
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
  env: NodeJS.ProcessEnv
): CliCommandDependencies {
  let nowMs = Date.now();
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
    cwd: fixture.terminalControl.currentPath,
    env,
    now: () => nowMs,
    monotonicNowMs: () => nowMs,
    sleep: async (milliseconds) => {
      nowMs += milliseconds;
    },
    sleepSync: (milliseconds) => {
      nowMs += milliseconds;
    },
    exit: (status) => {
      throw new InProcessCliExit(status);
    },
    runtimeLog: () => undefined
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
    async resolveActiveSessionIdentityForPid(pid) {
      assert.equal(pid, fixture.codexPid);
      if (fixture.identityObservationError) {
        throw new Error(fixture.identityObservationError);
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
          fd: "12",
          device: String(stat.dev),
          inode: String(stat.ino),
          path: fs.realpathSync(fixture.activeRolloutPath)
        },
        evidence: "open_rollout_fd"
      };
    }
  };
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
    return successfulCommand(
      `${fixture.target.split(":")[0]}\t0\t0\t` +
      `${fixture.terminalControl.panePid}\tcodex\t` +
      `${fixture.terminalControl.currentPath}\n`
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
      fs.writeFileSync(
        fixture.screenPath,
        `/status\n╭──────────────────────────────────────────────────╮\n` +
        `│ OpenAI Codex (v${fixture.codexVersion})                       │\n` +
        `│ Session: ${fixture.activeNativeThreadId} │\n` +
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
    `tmux-birth\t0\t0\t${options.panePid}\tcodex\t${options.workspace}\n`
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
    }
  }
} else if (args[0] === "send-keys" && args.at(-1) === "C-m") {
  const pendingInput = fs.existsSync(${JSON.stringify(options.pendingInputPath)})
    ? fs.readFileSync(${JSON.stringify(options.pendingInputPath)}, "utf8")
    : "";
  fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, "");
  if (pendingInput === "/status") {
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, ${JSON.stringify(
      `/status\n╭──────────────────────────────────────────────────╮\n` +
      `│ OpenAI Codex (v${options.codexVersion})                       │\n` +
      `│ Session: ${NATIVE_THREAD_ID} │\n` +
      `│ Account: private@example.com                 │\n` +
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
    const stat = fs.statSync(${JSON.stringify(options.rolloutPath)});
    process.stdout.write("p${options.codexPid}\\nf12u\\ntREG\\nD" + stat.dev +
      "\\ni" + stat.ino + "\\nn${options.rolloutPath}\\n");
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
