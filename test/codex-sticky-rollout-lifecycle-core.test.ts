import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  managedSessionBindingToken
} from "../src/managed-session.js";
import {
  listManagedSessions,
  loadNativeThreadTransition,
  pathsForManagedSession
} from "../src/session-store.js";
import { listConversations } from "../src/store.js";
import {
  STICKY_THREAD_IDS,
  StickyRolloutFixture,
  resumeActionCliArgs
} from "./codex-sticky-rollout-fixture.js";

test("sticky lifecycle draft guards fail before mutation", async () => {
  const fixture = stickyRolloutFixture();
  try {
    fixture.setScreen(
      "Ready\n› unsent lifecycle draft\ngpt-5.4 default · 100% left"
    );
    const beforeProbe = await fixture.newThread();
    assert.equal(beforeProbe.status, 1, beforeProbe.stderr);
    assert.match(beforeProbe.stderr, /composer contains non-placeholder input/u);
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.deepEqual(
      listManagedSessions(fixture.storeDir).map((session) => session.status),
      ["bound"]
    );

    fixture.setScreen("Ready\n› ");
    fixture.draftAfterNextStatus = true;
    const beforeTransition = await fixture.newThread();
    assert.equal(beforeTransition.status, 1, beforeTransition.stderr);
    assert.match(
      beforeTransition.stderr,
      /composer contains non-placeholder input/u
    );
    assert.deepEqual(fixture.literalInputs(), ["/status"]);
    assert.equal(fixture.clearCount, 0);
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.deepEqual(
      listManagedSessions(fixture.storeDir).map((session) => session.status),
      ["bound"]
    );
  } finally {
    fixture.cleanup();
  }
});

test("A -> New B isolates the sticky rollout and commits the exact ledger", async () => {
  const fixture = stickyRolloutFixture();
  try {
    const { output, source, target } = await createB(fixture);
    assert.equal(output.previous_session_id, fixture.sourceSessionId);
    assert.equal(output.native_thread_id, STICKY_THREAD_IDS.b);
    assert.equal(output.turn_created, false);
    assert.equal(source.status, "detached");
    assert.equal(target.status, "bound");
    assert.equal(target.binding?.native_thread_id, STICKY_THREAD_IDS.b);
    assert.equal(target.binding?.native_process.rollout, undefined);
    assert.equal(listConversations(fixture.storeDir).length, 0);

    const transition = loadNativeThreadTransition(
      fixture.storeDir,
      output.transition_id
    );
    assert.equal(transition.status, "committed");
    assert.equal(transition.before_native_thread_id, STICKY_THREAD_IDS.a);
    assert.deepEqual(
      transition.before_process_rollout,
      fixture.rolloutIdentity("a")
    );
    assert.equal(
      transition.after_binding?.native_thread_id,
      STICKY_THREAD_IDS.b
    );
    assert.equal(transition.after_binding?.native_process.rollout, undefined);

    const ledger = readOnlyDispatchLedger(fixture.runtimeDir);
    assert.equal(ledger.status, "resolved");
    assert.equal(ledger.target_native_thread_id, STICKY_THREAD_IDS.b);
    assert.equal(ledger.before_process_rollout, undefined);
    assert.equal(ledger.binding.native_thread_id, STICKY_THREAD_IDS.b);
    assert.equal(ledger.binding.native_process.rollout, undefined);

    // Previous is defined by the last committed transition, not stale lineage.
    const targetPath = pathsForManagedSession(
      target.session_id,
      fixture.storeDir
    ).statePath;
    const stale = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    stale.lineage.previous_session_id = "session-lineage-must-not-win";
    fs.writeFileSync(targetPath, `${JSON.stringify(stale, null, 2)}\n`);

    const listed = await fixture.action(["list", "--no-approval-scan"]);
    assert.equal(listed.status, 0, listed.stderr);
    const terminal = JSON.parse(listed.stdout).terminals[0];
    const bindingToken = managedSessionBindingToken(target);
    assert.equal(terminal.managed.session_id, target.session_id);
    assert.equal(terminal.managed.native_thread_id, STICKY_THREAD_IDS.b);
    assert.equal(terminal.managed.binding_token, bindingToken);
    assert.equal(terminal.native_agent_session_id, STICKY_THREAD_IDS.b);
    assert.equal(terminal.native_agent_rollout, undefined);
    assert.equal(terminal.lifecycle_binding_token, bindingToken);

    const resumable = await fixture.listResumable();
    assert.equal(resumable.status, 0, resumable.stderr);
    const choices = JSON.parse(resumable.stdout);
    assert.equal(choices.current_session_id, target.session_id);
    assert.equal(choices.current_native_thread_id, STICKY_THREAD_IDS.b);
    assert.equal(choices.expected_binding_token, bindingToken);
    assert.equal(choices.previous.native_thread_id, STICKY_THREAD_IDS.a);
    const resumeArgs = choices.previous.available_actions.resume_thread.arguments;
    assert.equal(resumeArgs.expected_binding_token, bindingToken);
    const token = JSON.parse(
      Buffer.from(resumeArgs.candidate_token, "base64url").toString("utf8")
    );
    assert.equal(token.version, 2);
    assert.equal(token.agentVersion, "0.146.0");
    assert.equal(token.sourceAgentVersion, "0.140.0");
  } finally {
    fixture.cleanup();
  }
});

test("B send rejects drafts and wrong status, then materializes only B", async () => {
  const fixture = stickyRolloutFixture();
  try {
    const { target } = await createB(fixture);
    const targetPath = pathsForManagedSession(
      target.session_id,
      fixture.storeDir
    ).statePath;
    const pristine = fs.readFileSync(targetPath, "utf8");

    fixture.setScreen("Ready\n› unsent draft");
    const literalsBeforeDraft = fixture.literalInputs().length;
    const draft = await fixture.send(
      target.session_id,
      "This draft-blocked message must never reach the terminal."
    );
    assert.equal(draft.status, 1, draft.stderr);
    assert.match(
      draft.stderr,
      /(?:terminal is unknown, not idle|composer contains non-placeholder input)/u
    );
    assert.equal(fixture.literalInputs().length, literalsBeforeDraft);
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.equal(fs.readFileSync(targetPath, "utf8"), pristine);
    assert.equal(fs.existsSync(fixture.rolloutPaths.b), false);

    fixture.setScreen("Ready\n› ");
    fixture.wrongNextStatus = true;
    const wrong = await fixture.send(
      target.session_id,
      "This wrong-status message must never reach the terminal."
    );
    assert.equal(wrong.status, 1, wrong.stderr);
    assert.match(
      wrong.stderr,
      new RegExp(`Codex /status reports native thread ${STICKY_THREAD_IDS.wrong}`, "u")
    );
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.equal(fs.readFileSync(targetPath, "utf8"), pristine);
    assert.equal(fs.existsSync(fixture.rolloutPaths.b), false);
    assert.deepEqual(fixture.literalInputs().slice(-1), ["/status"]);

    const message = "Report the logical Codex thread after sticky rollout.";
    const sent = await fixture.send(target.session_id, message);
    assert.equal(sent.status, 0, sent.stderr);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true);
    assert.equal(output.session_id, target.session_id);
    assert.equal(output.status, "async_pending");
    const turns = listConversations(fixture.storeDir);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].session_id, target.session_id);
    assert.equal(turns[0].terminal_binding_id, target.binding?.binding_id);
    assert.equal(turns[0].terminal_binding_generation, target.binding?.generation);
    assert.equal(turns[0].native_thread_id, STICKY_THREAD_IDS.b);
    assert.deepEqual(
      (turns[0].native_session_takeover as Record<string, any>)
        .terminal_agent_rollout,
      fixture.rolloutIdentity("b")
    );
    assert.equal(JSON.stringify(turns[0]).includes(fixture.rolloutPaths.a), false);
    const rebound = boundSession(fixture);
    assert.equal(rebound.binding?.native_thread_id, STICKY_THREAD_IDS.b);
    assert.deepEqual(
      rebound.binding?.native_process.rollout,
      fixture.rolloutIdentity("b")
    );
    assert.equal(JSON.stringify(rebound).includes(fixture.rolloutPaths.a), false);

    const closed = await fixture.close(
      output.turn_id,
      "close first B Turn before companion-root projection"
    );
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(JSON.parse(closed.stdout).terminal_dispatch_resolved, true);
    fixture.setScreen(
      "Ready\n› Summarize recent commits\n\ngpt-5.4 default · 100% left"
    );
    const listed = await fixture.action(["list", "--all", "--terminal-debug"]);
    assert.equal(listed.status, 0, listed.stderr);
    const terminal = JSON.parse(listed.stdout).terminals[0];
    assert.equal(terminal.activity_state, "idle");
    assert.equal(terminal.management_state, "managed");
    assert.equal(terminal.managed.session_id, rebound.session_id);
    assert.equal(terminal.managed.native_thread_id, STICKY_THREAD_IDS.b);
    assert.equal(terminal.native_agent_session_id, STICKY_THREAD_IDS.b);
    assert.deepEqual(terminal.native_agent_rollout, fixture.rolloutIdentity("b"));
    assert.equal(
      terminal.lifecycle_binding_token,
      managedSessionBindingToken(rebound)
    );
    assert.equal(
      terminal.available_actions.send.arguments.session_id,
      rebound.session_id
    );

    // This preflight begins with both A and B rollout descriptors open. It
    // must reuse B as the preferred root and never leak A into Turn/binding.
    fixture.setScreen("Ready\n› ");
    const second = await fixture.send(
      rebound.session_id,
      "Send again while both sticky and target rollouts remain open."
    );
    assert.equal(second.status, 0, second.stderr);
    const secondOutput = JSON.parse(second.stdout);
    assert.notEqual(secondOutput.turn_id, output.turn_id);
    const secondTurn = listConversations(fixture.storeDir)
      .find((turn) => turn.turn_id === secondOutput.turn_id);
    assert.equal(secondTurn?.session_id, rebound.session_id);
    assert.equal(secondTurn?.native_thread_id, STICKY_THREAD_IDS.b);
    assert.deepEqual(
      (secondTurn?.native_session_takeover as Record<string, any>)
        .terminal_agent_rollout,
      fixture.rolloutIdentity("b")
    );
    assert.equal(
      JSON.stringify(secondTurn).includes(fixture.rolloutPaths.a),
      false
    );
    const afterSecond = boundSession(fixture);
    assert.equal(afterSecond.binding?.native_thread_id, STICKY_THREAD_IDS.b);
    assert.deepEqual(
      afterSecond.binding?.native_process.rollout,
      fixture.rolloutIdentity("b")
    );
  } finally {
    fixture.cleanup();
  }
});

test("previous toggles A -> B without creating a Turn", async () => {
  const fixture = stickyRolloutFixture();
  try {
    const { target } = await createB(fixture);
    const materialized = await fixture.send(target.session_id, "Materialize B.");
    assert.equal(materialized.status, 0, materialized.stderr);
    await fixture.close(JSON.parse(materialized.stdout).turn_id);
    fixture.setScreen("Ready\n› ");
    const turnsBefore = listConversations(fixture.storeDir).length;
    const aChoice = JSON.parse((await fixture.listResumable()).stdout).previous;
    assert.equal(aChoice.native_thread_id, STICKY_THREAD_IDS.a);
    const toA = await fixture.action([
      "resume-thread",
      ...resumeActionCliArgs(aChoice.available_actions.resume_thread.arguments)
    ]);
    assert.equal(toA.status, 0, toA.stderr);
    const aOutput = JSON.parse(toA.stdout);
    assert.equal(aOutput.status, "committed");
    assert.equal(aOutput.operation, "resume_thread");
    assert.equal(aOutput.native_thread_id, STICKY_THREAD_IDS.a);
    assert.equal(aOutput.turn_created, false);
    assert.equal(listConversations(fixture.storeDir).length, turnsBefore);

    const bChoice = JSON.parse((await fixture.listResumable()).stdout).previous;
    assert.equal(bChoice.native_thread_id, STICKY_THREAD_IDS.b);
    const toB = await fixture.action([
      "resume-thread",
      ...resumeActionCliArgs(bChoice.available_actions.resume_thread.arguments)
    ]);
    assert.equal(toB.status, 0, toB.stderr);
    const bOutput = JSON.parse(toB.stdout);
    assert.equal(bOutput.status, "committed");
    assert.equal(bOutput.native_thread_id, STICKY_THREAD_IDS.b);
    assert.equal(bOutput.turn_created, false);
    assert.equal(listConversations(fixture.storeDir).length, turnsBefore);
    assert.equal(
      JSON.parse((await fixture.listResumable()).stdout).previous.native_thread_id,
      STICKY_THREAD_IDS.a
    );
    assert.equal(boundSession(fixture).session_id, target.session_id);
    assert.deepEqual(
      fixture.literalInputs().filter((text) => text !== "/status"),
      [
        "/clear",
        "Materialize B.",
        `/resume ${STICKY_THREAD_IDS.a}`,
        `/resume ${STICKY_THREAD_IDS.b}`
      ]
    );
  } finally {
    fixture.cleanup();
  }
});

test("B -> New C keeps multiple roots as exact companions", async () => {
  const fixture = stickyRolloutFixture();
  try {
    const { target } = await createB(fixture);
    const bSent = await fixture.send(target.session_id, "Materialize B.");
    assert.equal(bSent.status, 0, bSent.stderr);
    await fixture.close(JSON.parse(bSent.stdout).turn_id);
    fixture.setScreen("Ready\n› ");

    const newC = await fixture.newThread();
    assert.equal(newC.status, 0, newC.stderr);
    const output = JSON.parse(newC.stdout);
    assert.equal(output.status, "committed");
    assert.equal(output.previous_session_id, target.session_id);
    assert.equal(output.native_thread_id, STICKY_THREAD_IDS.c);
    assert.equal(output.turn_created, false);
    const sessions = listManagedSessions(fixture.storeDir);
    assert.equal(sessions.length, 3);
    assert.equal(
      sessions.find((session) => session.session_id === target.session_id)?.status,
      "detached"
    );
    const c = sessions.find((session) => session.session_id === output.session_id);
    assert.ok(c);
    assert.equal(c.status, "bound");
    assert.equal(c.binding?.native_thread_id, STICKY_THREAD_IDS.c);
    assert.equal(c.binding?.native_process.rollout, undefined);
    const transition = loadNativeThreadTransition(
      fixture.storeDir,
      output.transition_id
    );
    assert.equal(transition.before_native_thread_id, STICKY_THREAD_IDS.b);
    assert.deepEqual(
      transition.before_process_rollout,
      fixture.rolloutIdentity("b")
    );
    assert.equal(transition.after_binding?.native_thread_id, STICKY_THREAD_IDS.c);
    assert.equal(transition.after_binding?.native_process.rollout, undefined);

    const cSent = await fixture.send(c.session_id, "Materialize only C.");
    assert.equal(cSent.status, 0, cSent.stderr);
    const cTurn = listConversations(fixture.storeDir)
      .find((turn) => turn.turn_id === JSON.parse(cSent.stdout).turn_id);
    assert.equal(cTurn?.native_thread_id, STICKY_THREAD_IDS.c);
    assert.deepEqual(
      (cTurn?.native_session_takeover as Record<string, any>)
        .terminal_agent_rollout,
      fixture.rolloutIdentity("c")
    );
    assert.equal(JSON.stringify(cTurn).includes(fixture.rolloutPaths.a), false);
    assert.equal(JSON.stringify(cTurn).includes(fixture.rolloutPaths.b), false);
  } finally {
    fixture.cleanup();
  }
});

test("monitor preserves sticky companion fences for the active C Turn", async () => {
  const fixture = stickyRolloutFixture();
  try {
    const { c, cTurn } = await createActiveC(fixture);
    fixture.setScreen("Ready\n› ");
    const monitored = await fixture.action([
      "monitor",
      "--terminal-bridge",
      "--state",
      cTurn.conversation.state_path,
      "--log",
      cTurn.conversation.event_log_path,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "0.001",
      "--agent-hard-timeout-minutes",
      "10"
    ]);
    assert.equal(monitored.status, 0, monitored.stderr);
    const output = JSON.parse(monitored.stdout);
    assert.equal(output.monitored, true);
    assert.equal(output.terminal_bridge, true);
    assert.equal(output.stalled, true);
    assert.equal(output.conversation.status, "stalled");
    assert.match(output.reason, /observed no activity/u);
    const events = fs.readFileSync(cTurn.conversation.event_log_path, "utf8")
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const stalled = events.filter((event) =>
      event.event === "conversation_stalled"
    ).at(-1);
    assert.equal(stalled.terminal_activity_state, "idle", JSON.stringify(stalled));
    assert.equal(boundSession(fixture).session_id, c.session_id);
  } finally {
    fixture.cleanup();
  }
});

test("an unknown fourth open rollout fails closed without mutation", async () => {
  const fixture = stickyRolloutFixture();
  try {
    const { c, cTurn } = await createActiveC(fixture);
    await fixture.close(cTurn.turn_id);
    fixture.writeRollout("unknown");
    fixture.setScreen("Ready\n› ");

    const listed = await fixture.action(["list", "--all", "--terminal-debug"]);
    assert.equal(listed.status, 0, listed.stderr);
    const terminal = JSON.parse(listed.stdout).terminals[0];
    assert.notEqual(terminal.managed.session_id, c.session_id);
    assert.notEqual(terminal.native_agent_session_id, STICKY_THREAD_IDS.c);
    assert.notEqual(
      terminal.available_actions.send?.arguments?.session_id,
      c.session_id
    );

    const statePath = pathsForManagedSession(c.session_id, fixture.storeDir).statePath;
    const beforeState = fs.readFileSync(statePath, "utf8");
    const turnsBefore = listConversations(fixture.storeDir).length;
    const literalsBefore = fixture.literalInputs().length;
    const rejected = await fixture.send(
      c.session_id,
      "This message must not pass an unknown fourth root rollout."
    );
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /(?:unexpected open root rollout|no longer available)/u);
    assert.equal(listConversations(fixture.storeDir).length, turnsBefore);
    assert.equal(fs.readFileSync(statePath, "utf8"), beforeState);
    assert.equal(fixture.literalInputs().length, literalsBefore);
  } finally {
    fixture.cleanup();
  }
});

async function createB(fixture: StickyRolloutFixture) {
  fixture.setScreen(`Ready\n› \n${"\n".repeat(30)}`);
  fixture.blankRowsAfterNextStatus = true;
  const result = await fixture.newThread({ requireRestorable: true });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "committed");
  const sessions = listManagedSessions(fixture.storeDir);
  const source = sessions.find((session) =>
    session.session_id === fixture.sourceSessionId
  );
  const target = sessions.find((session) =>
    session.session_id === output.session_id
  );
  assert.ok(source);
  assert.ok(target);
  return { output, source, target };
}

async function createActiveC(fixture: StickyRolloutFixture) {
  const { target } = await createB(fixture);
  const bSent = await fixture.send(target.session_id, "Materialize B.");
  assert.equal(bSent.status, 0, bSent.stderr);
  await fixture.close(JSON.parse(bSent.stdout).turn_id);
  fixture.setScreen("Ready\n› ");
  const newC = await fixture.newThread();
  assert.equal(newC.status, 0, newC.stderr);
  const c = boundSession(fixture);
  const sent = await fixture.send(c.session_id, "Materialize C.");
  assert.equal(sent.status, 0, sent.stderr);
  return { c, cTurn: JSON.parse(sent.stdout) };
}

function boundSession(fixture: StickyRolloutFixture) {
  const session = listManagedSessions(fixture.storeDir)
    .find((candidate) => candidate.status === "bound");
  assert.ok(session);
  return session;
}

function stickyRolloutFixture(): StickyRolloutFixture {
  return new StickyRolloutFixture({ exactStatusProbe: true });
}

function readOnlyDispatchLedger(runtimeDir: string): Record<string, any> {
  const ledgerDir = path.join(runtimeDir, "terminal-dispatch");
  const names = fs.readdirSync(ledgerDir)
    .filter((name) => /^terminal-dispatch-[0-9a-f]{20}\.json$/u.test(name));
  assert.equal(names.length, 1);
  return JSON.parse(fs.readFileSync(path.join(ledgerDir, names[0]), "utf8"));
}
