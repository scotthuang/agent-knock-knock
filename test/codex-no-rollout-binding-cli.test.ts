import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const LIVE_PROCESS_BIRTH = "Thu Aug  6 10:00:00 2026";
const STALE_PROCESS_BIRTH = "Wed Aug  5 10:00:00 2026";
const NATIVE_THREAD_ID = "11111111-1111-4111-8111-111111111111";
const EXTERNAL_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_EXTERNAL_THREAD_ID = "33333333-3333-4333-8333-333333333333";

test("virgin raw Codex attach atomically refines the Session and Turn binding after send", () => {
  const fixture = createNoRolloutFixture();
  try {
    const sent = runCli([
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

test("production-mode virgin Codex preflight failure leaves no bound attach orphan", () => {
  const fixture = createNoRolloutFixture({ persistedCandidate: true });
  const environment = {
    ...fixture.environment,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
  };
  const sendArguments = (message: string) => [
    "send",
    "--conversation",
    fixture.terminalId,
    "--message",
    message,
    "--background",
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fixture.codexHome,
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ];
  try {
    const first = runCli(
      sendArguments("This production preflight must not reach Codex."),
      environment
    );
    assert.equal(first.status, 1, first.stdout);
    assert.match(
      first.stderr,
      /Codex native acceptance anchor requires an exact thread and process incarnation/u
    );
    assert.doesNotMatch(first.stderr, /changed native thread outside AKK/u);
    assert.deepEqual(listManagedSessions(fixture.storeDir), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false,
      "a rejected production preflight must not inject task text or Enter"
    );

    const second = runCli(
      sendArguments("A clean retry must reach the same safe preflight."),
      environment
    );
    assert.equal(second.status, 1, second.stdout);
    assert.match(
      second.stderr,
      /Codex native acceptance anchor requires an exact thread and process incarnation/u
    );
    assert.doesNotMatch(second.stderr, /changed native thread outside AKK/u);
    assert.deepEqual(listManagedSessions(fixture.storeDir), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false,
      "a retry after the rejected attach must not be poisoned or dispatched"
    );

    const listed = runCli([
      "list",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--no-approval-scan"
    ], environment);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedTerminal = JSON.parse(listed.stdout).terminals[0];
    assert.equal(listedTerminal.id, fixture.terminalId);
    assert.equal(listedTerminal.management_state, "unmanaged");
    assert.deepEqual(
      listedTerminal.available_actions.list_resumable_threads.arguments,
      { terminal_id: fixture.terminalId }
    );
    assert.equal(listedTerminal.available_actions.reconcile_binding, undefined);

    const resumable = runCli([
      "list-resumable-threads",
      "--terminal",
      fixture.terminalId,
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome
    ], environment);
    assert.equal(resumable.status, 0, resumable.stderr || resumable.stdout);
    const resumableOutput = JSON.parse(resumable.stdout);
    assert.equal(resumableOutput.terminal_id, fixture.terminalId);
    assert.equal(
      resumableOutput.threads.some(
        (entry: Record<string, unknown>) =>
          entry.native_thread_id === NATIVE_THREAD_ID
      ),
      true,
      resumable.stdout
    );
    assert.deepEqual(listManagedSessions(fixture.storeDir), []);
    assert.deepEqual(listConversations(fixture.storeDir), []);
  } finally {
    fixture.cleanup();
  }
});

test("a rollout appearing between raw discovery and send preflight fails cleanly", () => {
  const fixture = createNoRolloutFixture({
    materializeRolloutOnProbe: 2,
    persistedCandidate: true
  });
  const environment = {
    ...fixture.environment,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
  };
  try {
    const raced = runCli([
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

    const terminal = listFixtureTerminal({ ...fixture, environment });
    assert.equal(terminal.management_state, "unmanaged");
    assert.ok(terminal.available_actions.new_thread);
    assert.ok(terminal.available_actions.list_resumable_threads);
    assert.equal(terminal.available_actions.reconcile_binding, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("a virgin attach setup failure CAS-detaches the Session before any task input", () => {
  const fixture = createNoRolloutFixture();
  try {
    const aborted = runCli([
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
    const terminal = listFixtureTerminal(fixture);
    assert.notEqual(terminal.management_state, "conflict");
    assert.equal(terminal.available_actions.reconcile_binding, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("a proved tmux text-dispatch failure also detaches the virgin Session", () => {
  const fixture = createNoRolloutFixture();
  try {
    const aborted = runCli([
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
    assert.notEqual(listFixtureTerminal(fixture).management_state, "conflict");
  } finally {
    fixture.cleanup();
  }
});

test("native lifecycle commands remain reachable after a rejected virgin attach", () => {
  for (const operation of ["new", "resume"] as const) {
    const fixture = createNoRolloutFixture({ persistedCandidate: true });
    const productionEnvironment = {
      ...fixture.environment,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
    };
    try {
      const rejected = runCli([
        "send",
        "--conversation",
        fixture.terminalId,
        "--message",
        `Rejected before ${operation}.`,
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
      assert.deepEqual(listManagedSessions(fixture.storeDir), []);

      const terminal = listFixtureTerminal({
        ...fixture,
        environment: productionEnvironment
      });
      assert.equal(terminal.management_state, "unmanaged");
      if (operation === "new") {
        const action = terminal.available_actions.new_thread;
        assert.ok(action, JSON.stringify(terminal.available_actions));
        const prepared = runCli([
          "new-thread",
          "--terminal",
          fixture.terminalId,
          "--expected-binding-token",
          String(action.arguments.expected_binding_token),
          "--store-dir",
          fixture.storeDir,
          "--codex-home",
          fixture.codexHome
        ], {
          ...productionEnvironment,
          AKK_TEST_EXIT_AFTER_LIFECYCLE_PREPARED: "1"
        });
        assert.equal(prepared.status, 86, prepared.stderr || prepared.stdout);
        assert.doesNotMatch(prepared.stderr, /changed native thread outside AKK/u);
      } else {
        const listed = runCli([
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
        const resumed = runCli([
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
        ], {
          ...productionEnvironment,
          AKK_TEST_EXIT_AFTER_LIFECYCLE_PREPARED: "1"
        });
        assert.doesNotMatch(
          `${resumed.stderr}\n${resumed.stdout}`,
          /changed native thread outside AKK|must be reconciled explicitly/u
        );
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test("a provisional attach orphan exposes one fenced reconcile action and detaches without terminal input", () => {
  const fixture = createNoRolloutFixture();
  try {
    const orphan = persistConflictSession(fixture, {
      sessionId: "session-provisional-attach-orphan"
    });
    const terminal = listFixtureTerminal(fixture);
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

    const staleSession = runCli(reconcileArguments(fixture, {
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

    const stale = runCli(reconcileArguments(fixture, {
      ...action.arguments,
      expected_terminal_token: "stale-terminal-token"
    }), fixture.environment);
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(stale.stderr, /terminal identity changed.*refresh AKK list/u);
    assert.equal(
      loadManagedSession(fixture.storeDir, orphan.session_id).status,
      "bound"
    );

    const reconciled = runCli(
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

    const refreshed = listFixtureTerminal(fixture);
    assert.equal(refreshed.management_state, "unmanaged");
    assert.equal(refreshed.available_actions.reconcile_binding, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("a same-process external native-thread change stays fail-closed until exact reconcile", () => {
  const fixture = createNoRolloutFixture();
  try {
    fs.writeFileSync(fixture.materializedPath, "ready");
    const session = persistConflictSession(fixture, {
      sessionId: "session-live-external-thread",
      nativeThreadId: EXTERNAL_THREAD_ID,
      processBirth: LIVE_PROCESS_BIRTH
    });
    const terminal = listFixtureTerminal(fixture);
    assert.equal(terminal.native_agent_session_id, NATIVE_THREAD_ID);
    assert.equal(terminal.management_state, "conflict");
    assert.equal(
      terminal.management_conflict.kind,
      "live_external_thread_change"
    );
    assert.deepEqual(Object.keys(terminal.available_actions), [
      "status",
      "reconcile_binding"
    ]);

    const reconciled = runCli(
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

test("a proved Codex PID reuse ignores the stale binding without adopting its native thread", () => {
  const fixture = createNoRolloutFixture();
  try {
    fs.writeFileSync(fixture.materializedPath, "ready");
    const stale = persistConflictSession(fixture, {
      sessionId: "session-reused-pid-stale-incarnation",
      nativeThreadId: EXTERNAL_THREAD_ID,
      processBirth: STALE_PROCESS_BIRTH
    });
    const terminal = listFixtureTerminal(fixture);
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

    const sent = runCli([
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

test("ambiguous and unverifiable binding claims never advertise reconciliation", () => {
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
      const terminal = listFixtureTerminal(fixture);
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

test("a /status card that disagrees with the open rollout is projected as unverifiable", () => {
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
    const terminal = listFixtureTerminal(fixture);
    assert.equal(terminal.native_agent_session_id, NATIVE_THREAD_ID);
    assert.equal(
      terminal.native_agent_status_card_session_id,
      EXTERNAL_THREAD_ID
    );
    assert.equal(terminal.management_state, "conflict");
    assert.equal(terminal.management_conflict.kind, "unverifiable");
    assert.deepEqual(Object.keys(terminal.available_actions), ["status"]);
  } finally {
    fixture.cleanup();
  }
});

test("blocking Turns, unresolved transitions, and dispatch ledgers suppress binding reconciliation", () => {
  for (const blocker of ["turn", "transition", "ledger"] as const) {
    const fixture = createNoRolloutFixture();
    try {
      fs.writeFileSync(fixture.materializedPath, "ready");
      const session = persistConflictSession(fixture, {
        sessionId: `session-reconcile-${blocker}-blocker`,
        nativeThreadId: EXTERNAL_THREAD_ID,
        processBirth: LIVE_PROCESS_BIRTH
      });
      const before = listFixtureTerminal(fixture);
      const advertised = before.available_actions.reconcile_binding;
      assert.ok(advertised, blocker);
      if (blocker === "turn") {
        persistBlockingTurn(fixture, session);
      } else if (blocker === "transition") {
        persistUnresolvedTransition(fixture, session);
      } else {
        persistUnresolvedDispatchLedger(fixture, session);
      }

      const blocked = listFixtureTerminal(fixture);
      assert.equal(blocked.management_state, "conflict", blocker);
      assert.equal(blocked.available_actions.reconcile_binding, undefined, blocker);
      assert.equal(blocked.available_actions.send, undefined, blocker);
      assert.equal(blocked.available_actions.new_thread, undefined, blocker);
      assert.equal(
        blocked.available_actions.list_resumable_threads,
        undefined,
        blocker
      );

      const staleAction = runCli(
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

test("Codex status-card binding rejects the same PID with a different process birth", () => {
  const fixture = createNoRolloutFixture();
  try {
    const session = persistStatusCardSession(fixture, STALE_PROCESS_BIRTH);
    const sent = runCli([
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

test("Codex status-card binding with the same process birth authorizes and refines the Turn", () => {
  const fixture = createNoRolloutFixture();
  try {
    const session = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const sent = runCli([
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

test("unmanaged Codex lifecycle token changes when a PID is reused", () => {
  const fixture = createNoRolloutFixture();
  try {
    const first = runCli([
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
    const second = runCli([
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

test("live-gate New rejects an unmanaged Codex origin that is not persisted", () => {
  const fixture = createNoRolloutFixture();
  try {
    const listed = runCli([
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

    const rejected = runCli([
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

test("live-gate New accepts a persisted unmanaged Codex origin", () => {
  const fixture = createNoRolloutFixture({ persistedCandidate: true });
  try {
    const listed = runCli([
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

    const prepared = runCli([
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

    assert.equal(prepared.status, 86, prepared.stderr || prepared.stdout);
    const literalSends = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) =>
        call.args[0] === "send-keys" && call.args.includes("-l")
      )
      .map((call) => call.args.at(-1));
    assert.deepEqual(literalSends, ["/status"]);
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.equal(listManagedSessions(fixture.storeDir).length, 0);
    const transitions = fs.readdirSync(
      nativeThreadTransitionsDir(fixture.storeDir)
    );
    assert.equal(transitions.length, 1);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, transitions[0]).status,
      "prepared"
    );
  } finally {
    fixture.cleanup();
  }
});

test("native status inspection is snapshot-bound, settles the slash composer, and does not mutate the Store", () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.147.0" });
  try {
    assert.equal(fs.existsSync(fixture.storeDir), false);
    const listed = listFixtureTerminal(fixture);
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

    const stale = runCli(
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
    const suggested = listFixtureTerminal(fixture);
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
    const drafted = listFixtureTerminal(fixture);
    assert.equal(drafted.activity_state, "idle");
    assert.equal(drafted.available_actions.native_inspect, undefined);
    const nonempty = runCli(
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
    const inspected = runCli(
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

test("Codex 0.146.0 native status inspection remains backward compatible", () => {
  const fixture = createNoRolloutFixture({ codexVersion: "0.146.0" });
  try {
    const listed = listFixtureTerminal(fixture);
    assert.equal(listed.native_inspection.status, "supported");
    assert.equal(listed.native_inspection.agentVersion, "0.146.0");
    const inspected = runCli([
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

test("native status inspection sends no Enter after post-injection process drift", () => {
  const fixture = createNoRolloutFixture();
  try {
    const listed = listFixtureTerminal(fixture);
    const inspected = runCli([
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

test("native status inspection is withheld and rejects a cached action while managed work is unresolved", () => {
  for (const blocker of ["turn", "transition"] as const) {
    const fixture = createNoRolloutFixture();
    try {
      fs.writeFileSync(fixture.materializedPath, "ready");
      const session = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
      const listed = listFixtureTerminal(fixture);
      const advertised = listed.available_actions.native_inspect;
      assert.ok(advertised, blocker);

      if (blocker === "turn") {
        persistBlockingTurn(fixture, session);
      } else {
        persistUnresolvedTransition(fixture, session);
      }

      const blocked = listFixtureTerminal(fixture);
      assert.equal(
        blocked.available_actions.native_inspect,
        undefined,
        blocker
      );
      const rejected = runCli([
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
  environment: NodeJS.ProcessEnv;
  cleanup(): void;
}

function createNoRolloutFixture(
  {
    codexVersion = "0.146.0",
    materializeRolloutOnProbe,
    persistedCandidate = false
  }: {
    codexVersion?: "0.146.0" | "0.147.0";
    materializeRolloutOnProbe?: number;
    persistedCandidate?: boolean;
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
  const target = "tmux-birth:0.0";
  const panePid = 72_000;
  const codexPid = 72_001;
  const terminalId = `terminal:v2:tmux:codex:${target}:${codexPid}`;
  const rolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-00-00-${NATIVE_THREAD_ID}.jsonl`
  );
  const executablePath =
    `/opt/akk-test/releases/${codexVersion}-aarch64-apple-darwin/bin/codex`;

  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(screenPath, "Ready\n› ");
  fs.writeFileSync(processBirthPath, LIVE_PROCESS_BIRTH);
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

  const terminalControl: TerminalControlRef = {
    kind: "tmux",
    target,
    session: "tmux-birth",
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
  return {
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
    environment: {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
      AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
    },
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
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

function listFixtureTerminal(fixture: NoRolloutFixture): Record<string, any> {
  const listed = runCli([
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
  pendingInputPath: string;
  materializedPath: string;
  processBirthPath: string;
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
    fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
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
