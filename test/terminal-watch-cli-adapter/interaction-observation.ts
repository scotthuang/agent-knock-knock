import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createTerminalWatchCliAdapter
} from "../../src/terminal-watch-cli-adapter.js";
import {
  type TerminalWatchCallbackInput
} from "../../src/terminal-watch-callback-cli-adapter.js";
import type {
  Conversation
} from "../../src/protocol.js";
import {
  createTerminalWatchOpenClawCallbackRoute,
  type CallbackTransportDeliverInput
} from "../../src/callback-transport.js";
import {
  loadTerminalWatch
} from "../../src/terminal-watch-store.js";
import {
  TASK_ID,
  CODEX_FALLBACK_QUESTION_ONE,
  CODEX_ASYNC_QUESTION_COLLAPSED,
  exactTerminalObservation,
  withTerminalWatchScreen,
  createFixture,
  managedTurn,
  managedInteractionTurn,
  record
} from "./fixtures.js";

test("Terminal Watch falls back to a read-only activity epoch and settles after stable idle", async (t) => {
  const fixture = createFixture(t);
  const header = fs.readFileSync(fixture.rolloutPath, "utf8").split("\n")[0];
  fs.writeFileSync(fixture.rolloutPath, `${header}\n`, { mode: 0o600 });
  const activityTerminal = {
    ...fixture.terminal,
    activity_state: "working",
    available_actions: {}
  };
  let terminals: Array<Record<string, any>> = [activityTerminal];
  const printed: unknown[] = [];
  const callbacks: TerminalWatchCallbackInput[] = [];
  let nextWatchUuid = 252;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () =>
      `00000000-0000-4000-8000-000000000${nextWatchUuid++}`,
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({
      state: "conflict",
      conflict: { reason: "ignored" }
    }),
    terminalIncarnationBlockingTurns: () => [managedTurn()],
    printJson: (value) => printed.push(value),
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });

  const options = {
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  };
  await facade.runWatch(options);
  const first = record(record(printed.at(-1)).watch);
  assert.equal(first.watch_mode, "terminal_activity");
  assert.equal(first.confidence, "best_effort");
  assert.match(
    (first.warnings as string[]).join("\n"),
    /exact_task_anchor_unavailable[\s\S]*terminal_activity_fallback/u
  );

  await facade.runWatch(options);
  const repeated = record(record(printed.at(-1)).watch);
  assert.equal(repeated.watch_id, first.watch_id);
  assert.equal(facade.listPublicWatches(fixture.storeDir).length, 1);

  await facade.runWatch({
    ...options,
    openclawSession: "agent:main:another-controller"
  });
  const independent = record(record(printed.at(-1)).watch);
  assert.notEqual(independent.watch_id, first.watch_id);
  assert.equal(
    facade.listPublicWatches(fixture.storeDir).length,
    2,
    "a distinct callback authority may independently observe the same read-only target"
  );

  terminals = [{
    ...activityTerminal,
    native_agent_process_uuid: undefined,
    native_agent_process_birth: undefined
  }];
  await facade.runWatch(options);
  assert.equal(
    record(record(printed.at(-1)).watch).watch_id,
    first.watch_id,
    "temporarily missing optional process identity must reuse the active Watch"
  );
  assert.equal(facade.listPublicWatches(fixture.storeDir).length, 2);
  fixture.advance();
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: String(first.watch_id)
  });
  assert.equal(record(record(printed.at(-1)).watch).status, "active");
  assert.equal(callbacks.length, 0);

  terminals = [{ ...activityTerminal, activity_state: "idle" }];
  fixture.advance();
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(callbacks.length, 0, "one idle sample is not enough");
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(
    callbacks.length,
    1,
    JSON.stringify(printed.slice(-2), null, 2)
  );
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(callbacks.length, 2);
  assert.ok(callbacks.every(({ origin }) =>
    origin === "terminal_activity_fallback"
  ));
  assert.deepEqual(
    callbacks.map(({ event, openclawSession }) => ({ event, openclawSession }))
      .sort((left, right) =>
        String(left.openclawSession).localeCompare(String(right.openclawSession))
      ),
    [
      {
        event: "completed",
        openclawSession: "agent:main:another-controller"
      },
      { event: "completed", openclawSession: "agent:main:main" }
    ]
  );

  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: String(first.watch_id)
  });
  const settled = record(record(printed.at(-1)).watch);
  assert.equal(settled.status, "completed");
  assert.equal(
    record(settled.settlement).reason_code,
    "terminal_activity_became_stably_idle"
  );

  await facade.runWatch(options);
  const armed = record(record(printed.at(-1)).watch);
  assert.equal(armed.watch_mode, "terminal_activity");
  assert.equal(armed.status, "active");
  assert.match(
    (armed.warnings as string[]).join("\n"),
    /terminal_activity_armed_for_next_activity/u
  );
});

test("Terminal Watch rejects only when neither durable task nor screen activity can be observed", async (t) => {
  const fixture = createFixture(t);
  const terminal = {
    ...fixture.terminal,
    native_agent_rollout: undefined,
    terminal_control: {
      ...record(fixture.terminal.terminal_control),
      capabilities: []
    },
    available_actions: {}
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000253",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {}
  });

  await assert.rejects(
    () => facade.runWatch({
      terminal: fixture.terminal.id as string,
      openclawSession: "agent:main:main"
    }),
    /neither a durable task anchor nor a read-only screen-status observation path/u
  );
  assert.deepEqual(facade.listPublicWatches(fixture.storeDir), []);
});

test("exact Watch Status projects an actionable questionnaire and cursor redraw notifies once", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const printed: unknown[] = [];
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  let blockers: Conversation[] = [];
  const callbackRoute = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: "agent:main:exact-questionnaire",
    openclawBin: "/opt/openclaw/bin/openclaw",
    respond: true
  });
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000271",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => blockers,
    printJson: (value) => printed.push(value),
    callback: {
      deliver() {
        throw new Error("legacy callback path must not run");
      },
      deliverTransport(input) {
        deliveries.push(input);
        return {
          disposition: "accepted",
          accepted_at: fixture.now().toISOString(),
          acceptance_id: input.envelope.delivery_id
        };
      }
    }
  });
  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: callbackRoute.controller_session_id,
    callbackRoute
  });
  const watchId = String(record(record(printed.at(-1)).watch).watch_id);
  terminal = withTerminalWatchScreen(terminal, CODEX_FALLBACK_QUESTION_ONE);
  fixture.advance();
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: callbackRoute.controller_session_id,
    callbackRoute
  });
  const publicWatch = record(record(printed.at(-1)).watch);
  const projection = record(publicWatch.interaction_state);
  assert.equal(publicWatch.interaction_policy, "respond_when_exact");
  assert.equal(record(publicWatch.capabilities).interaction_respond, true);
  assert.equal(projection.version, 2);
  assert.equal(record(projection.subject).kind, "terminal_watch");
  assert.equal(record(projection.subject).watch_id, watchId);
  assert.equal(projection.response_authority, "executable");
  assert.equal(record(projection.capabilities).respond, true);
  assert.equal(Object.hasOwn(projection, "turn_id"), false);

  await facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
  const anonymousStatus = record(record(printed.at(-1)).watch);
  assert.equal(record(anonymousStatus.capabilities).interaction_respond, false);
  assert.equal(Object.hasOwn(anonymousStatus, "interaction_state"), false);
  assert.equal(
    Object.hasOwn(anonymousStatus, "interaction_prompt_fingerprint"),
    false
  );
  assert.equal(
    Object.hasOwn(record(anonymousStatus.available_actions), "respond_interaction"),
    false
  );
  const listed = record(
    facade.listPublicWatches(fixture.storeDir)
      .find((candidate) => candidate.watch_id === watchId)
  );
  assert.equal(Object.hasOwn(listed, "interaction_state"), false);
  assert.equal(Object.hasOwn(listed, "interaction_prompt_fingerprint"), false);
  assert.equal(
    Object.hasOwn(record(listed.available_actions), "respond_interaction"),
    false
  );
  await assert.rejects(
    () => facade.runWatchStatus({
      storeDir: fixture.storeDir,
      watch: watchId,
      openclawSession: "agent:main:not-owner"
    }),
    /different controller session; executable interaction details were not disclosed/u
  );

  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].envelope.event.type, "interaction_required");
  blockers = [managedInteractionTurn(
    String(projection.surface_id),
    String(projection.prompt_fingerprint),
    callbackRoute.controller_session_id
  )];
  fixture.setNow("2026-08-21T01:00:03.000Z");
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: callbackRoute.controller_session_id,
    callbackRoute
  });
  const suppressed = record(record(printed.at(-1)).watch);
  assert.equal(record(suppressed.capabilities).interaction_respond, false);
  assert.equal(
    record(record(suppressed.interaction_state).capabilities).respond,
    false
  );
  assert.equal(
    record(suppressed.interaction_state).response_authority,
    "notify_only"
  );
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute
  });
  assert.equal(deliveries.length, 1, "managed precedence must not add a callback");

  blockers = [];
  fixture.setNow("2026-08-21T01:00:04.000Z");
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: callbackRoute.controller_session_id,
    callbackRoute
  });
  const restored = record(record(printed.at(-1)).watch);
  assert.equal(record(restored.capabilities).interaction_respond, true);
  assert.equal(
    record(restored.interaction_state).response_authority,
    "executable"
  );
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute
  });
  assert.equal(deliveries.length, 1, "restoring one surface must not repeat callback");
  terminal = withTerminalWatchScreen(
    terminal,
    CODEX_FALLBACK_QUESTION_ONE
      .replace("› 1. React", "  1. React")
      .replace("  2. Vue", "› 2. Vue")
  );
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute
  });
  assert.equal(deliveries.length, 1, "cursor redraw must keep one surface event");
});

test("exact Watch projects one response-capable Codex async question while working", async (t) => {
  const fixture = createFixture(t, "human-only", "0.155.1");
  const printed: unknown[] = [];
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  const callbackRoute = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: "agent:main:exact-async-question",
    openclawBin: "/opt/openclaw/bin/openclaw",
    respond: true
  });
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000382",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value),
    callback: {
      deliver() {
        throw new Error("legacy callback path must not run");
      },
      deliverTransport(input) {
        deliveries.push(input);
        return {
          disposition: "accepted",
          accepted_at: fixture.now().toISOString(),
          acceptance_id: input.envelope.delivery_id
        };
      }
    }
  });
  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: callbackRoute.controller_session_id,
    callbackRoute
  });
  const watchId = String(record(record(printed.at(-1)).watch).watch_id);
  fs.appendFileSync(fixture.rolloutPath, `${JSON.stringify({
    timestamp: "2026-08-21T01:00:00.050Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: TASK_ID,
      item: {
        type: "AgentMessage",
        id: "async-question-watch-1",
        delivery: "async",
        questions: [{
          title: "Which target should I use?",
          options: ["Local", "Remote"]
        }]
      }
    }
  })}\n`);
  terminal = withTerminalWatchScreen(
    terminal,
    CODEX_ASYNC_QUESTION_COLLAPSED
  );
  fixture.advance();
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: callbackRoute.controller_session_id,
    callbackRoute
  });
  const publicWatch = record(record(printed.at(-1)).watch);
  const projection = record(publicWatch.interaction_state);
  assert.equal(publicWatch.status, "active");
  assert.equal(publicWatch.interaction_policy, "respond_when_exact");
  assert.equal(record(publicWatch.capabilities).interaction_respond, true);
  assert.equal(projection.kind, "async_question");
  assert.equal(projection.response_authority, "executable");
  assert.deepEqual(projection.delivery_modes, [
    "steer_current_turn",
    "queue_next_turn"
  ]);
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].envelope.event.type, "interaction_required");
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute
  });
  assert.equal(deliveries.length, 1, "the same async question must notify once");

  fs.appendFileSync(fixture.rolloutPath, `${JSON.stringify({
    timestamp: "2026-08-21T01:00:02.050Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: TASK_ID,
      item: {
        type: "AgentMessage",
        id: "async-question-watch-2",
        delivery: "async",
        questions: [{ title: "Which project name should I use?" }]
      }
    }
  })}\n`);
  terminal = withTerminalWatchScreen(
    terminal,
    CODEX_ASYNC_QUESTION_COLLAPSED.replace("1 question", "2 questions")
  );
  await facade.runReconcileWatches({ storeDir: fixture.storeDir, callbackRoute });
  assert.equal(deliveries.length, 1, "an added pending question must not repeat Q1");

  terminal = withTerminalWatchScreen(terminal, [
    "  Which project name should I use?",
    "",
    "  Type your answer",
    "",
    "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt"
  ].join("\n"));
  await facade.runReconcileWatches({ storeDir: fixture.storeDir, callbackRoute });
  assert.equal(deliveries.length, 2, "advancing to Q2 must notify once");
  assert.equal(loadTerminalWatch(fixture.storeDir, watchId).status, "active");

  for (const excerpt of ["", "• Working (4s • esc to interrupt)"]) {
    terminal = withTerminalWatchScreen(terminal, excerpt);
    await facade.runReconcileWatches({ storeDir: fixture.storeDir, callbackRoute });
    assert.equal(
      loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.aggregate.state,
      "pending",
      "missing or clipped captures cannot prove the question disappeared"
    );
  }
  terminal = withTerminalWatchScreen(terminal, [
    "• Working (5s • esc to interrupt)", "", "› ", "",
    "gpt-5.6-sol high · /workspace/project"
  ].join("\n"));
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: callbackRoute.controller_session_id,
    callbackRoute
  });
  const cleared = record(record(printed.at(-1)).watch);
  assert.equal(cleared.status, "active");
  assert.equal(cleared.interaction_state, undefined);
  assert.equal(record(cleared.capabilities).interaction_respond, false);
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.aggregate.state,
    "superseded"
  );
  assert.equal(deliveries.length, 2);

  fs.appendFileSync(fixture.rolloutPath, `${JSON.stringify({
    timestamp: "2026-08-21T01:00:05.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: TASK_ID, last_agent_message: "Done" }
  })}\n`);
  fixture.setNow("2026-08-21T01:00:06.000Z");
  await facade.runReconcileWatches({ storeDir: fixture.storeDir, callbackRoute });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).status,
    "completed",
    JSON.stringify(printed.at(-1))
  );
  assert.equal(deliveries.at(-1)?.envelope.event.type, "completed");
});
