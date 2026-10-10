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
import {
  type CallbackTransportDeliverInput
} from "../../src/callback-transport.js";
import {
  loadTerminalWatch,
  terminalWatchesDir
} from "../../src/terminal-watch-store.js";
import {
  TASK_ID,
  TOKEN,
  exactTerminalObservation,
  createFixture,
  managedTurn,
  record
} from "./fixtures.js";

test("Terminal Watch CLI observes one exact human-started Codex task and delivers its completion", async (t) => {
  const fixture = createFixture(t);
  assert.equal("commands" in fixture.terminal, false);
  const printed: unknown[] = [];
  const callbacks: TerminalWatchCallbackInput[] = [];
  let terminals = [{
    ...fixture.terminal,
    activity_state: "awaiting_approval",
    approval_state: {
      blocked: true,
      approvable: true,
      fingerprint: "b".repeat(64)
    }
  }];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000206",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value),
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main",
    openclawBin: "/usr/local/bin/openclaw",
    hardTimeoutMinutes: 10
  });
  const created = record(record(printed.at(-1)).watch);
  const watchId = String(created.watch_id);
  const persisted = loadTerminalWatch(fixture.storeDir, watchId);
  assert.equal(Date.parse(persisted.deadline_at) - Date.parse(persisted.created_at), 10 * 60_000);
  assert.match(watchId, /^terminal-watch-/u);
  assert.equal(created.status, "active");
  assert.equal("observation_checkpoint" in created, false);
  assert.equal(record(created.callback).pending, 1);
  assert.equal(callbacks.length, 0);
  assert.equal(facade.listPublicWatches(fixture.storeDir).length, 1);

  fs.appendFileSync(
    fixture.rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-08-21T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: TASK_ID,
        last_agent_message: "Terminal Watch verified completion"
      }
    })}\n`
  );
  // The exact durable completion must still win when the TUI process exits
  // before the next reconciliation discovers it.
  terminals = [];
  fixture.advance();
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event, "completed");
  assert.equal(
    callbacks[0].completionText,
    "Terminal Watch verified completion"
  );
  await facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
  const settled = record(record(printed.at(-1)).watch);
  assert.equal(settled.status, "completed");
  assert.equal(record(settled.callback).superseded, 1);
  assert.deepEqual(facade.listPublicWatches(fixture.storeDir), []);
  assert.equal(
    facade.listPublicWatches(fixture.storeDir, { includeAll: true }).length,
    1
  );
});

test("Terminal Watch accepts an unverified complete Codex version and returns its warning", async (t) => {
  const fixture = createFixture(t, "human-only", "0.150.0");
  const printed: unknown[] = [];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([fixture.terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000250",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value)
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });

  const created = record(record(printed.at(-1)).watch);
  assert.equal(created.status, "active");
  assert.match(created.compatibility_warning, /Codex 0\.150\.0/u);
  assert.match(created.compatibility_warning, /not been regression-tested/u);
  const persisted = loadTerminalWatch(fixture.storeDir, String(created.watch_id));
  assert.equal(Date.parse(persisted.deadline_at) - Date.parse(persisted.created_at), 43_200_000);
});

test("Terminal Watch snapshots and delivers the trusted generic Host route", async (t) => {
  const fixture = createFixture(t);
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminals = [fixture.terminal];
  const callbackRoute = {
    schema: "agent-knock-knock/callback-route" as const,
    version: 1 as const,
    transport: "command_json_v1",
    profile_id: "fixture-host",
    profile_revision: "1",
    controller_session_id: "host-session-1",
    capabilities: { wake: true, respond: true }
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000216",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
    callback: {
      deliver() {
        throw new Error("legacy OpenClaw callback must not run");
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
    callbackRoute
  });
  fs.appendFileSync(
    fixture.rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-08-21T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: TASK_ID,
        last_agent_message: "generic Host completion"
      }
    })}\n`
  );
  terminals = [];
  fixture.advance();
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute
  });

  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].route, {
    ...callbackRoute,
    capabilities: { wake: true, respond: true }
  });
  assert.equal(
    deliveries[0].envelope.route.controller_session_id,
    "host-session-1"
  );
  assert.equal(deliveries[0].envelope.source.kind, "terminal_watch");
});

test("shared-store Watch workers leave foreign callbacks pending until their matching Host runs", async (t) => {
  const fixture = createFixture(t);
  const deliveries: CallbackTransportDeliverInput[] = [];
  const printed: unknown[] = [];
  let terminals = [fixture.terminal];
  let nonce = 0;
  const firstRoute = {
    schema: "agent-knock-knock/callback-route" as const,
    version: 1 as const,
    transport: "command_json_v1",
    profile_id: "first-host",
    profile_revision: "1",
    controller_session_id: "first-controller",
    capabilities: { wake: true, respond: true }
  };
  const secondRoute = {
    ...firstRoute,
    profile_id: "second-host",
    controller_session_id: "second-controller"
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => `shared-host-${++nonce}`,
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value),
    callback: {
      deliver() {
        throw new Error("transport delivery expected");
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
  const watchIds: string[] = [];
  for (const callbackRoute of [firstRoute, secondRoute, undefined]) {
    await facade.runWatch({
      terminal: fixture.terminal.id as string,
      ...(callbackRoute
        ? { callbackRoute }
        : { openclawSession: "legacy-controller" })
    });
    watchIds.push(String(record(record(printed.at(-1)).watch).watch_id));
  }
  fs.appendFileSync(fixture.rolloutPath, `${JSON.stringify({
    timestamp: "2026-08-21T01:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: TASK_ID,
      last_agent_message: "shared Host completion"
    }
  })}\n`);
  terminals = [];
  fixture.advance();

  // The read-only status path may discover completion without the owner runtime.
  await facade.runWatchStatus({ watch: watchIds[0] });
  const pending = loadTerminalWatch(fixture.storeDir, watchIds[0]);
  assert.equal(pending.status, "completed");
  assert.equal(pending.notification_outbox[0].status, "pending");
  assert.equal(pending.notification_outbox[0].attempts, 0);
  assert.equal(deliveries.length, 0);

  // A legacy worker reaches its own third Watch even with a delivery limit of 1.
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].route.controller_session_id, "legacy-controller");
  assert.equal(record(printed.at(-1)).errors, 0);

  for (const callbackRoute of [
    { ...firstRoute, transport: "unknown_transport_v1" },
    { ...firstRoute, profile_id: "absent-host" },
    { ...firstRoute, profile_revision: "different-revision" },
    { ...firstRoute, controller_session_id: "different-controller" }
  ]) {
    await facade.runReconcileWatches({ callbackRoute });
    assert.equal(record(printed.at(-1)).errors, 0);
    assert.equal(record(printed.at(-1)).callbacks_delivered, 0);
  }
  for (const watchId of watchIds.slice(0, 2)) {
    const stored = loadTerminalWatch(fixture.storeDir, watchId);
    assert.equal(stored.notification_outbox[0].status, "pending");
    assert.equal(stored.notification_outbox[0].attempts, 0);
    assert.equal(stored.notification_outbox[0].attempt_id, undefined);
    assert.equal(stored.notification_outbox[0].last_error_code, undefined);
  }

  for (const callbackRoute of [firstRoute, secondRoute]) {
    await facade.runReconcileWatches({ callbackRoute });
    assert.equal(record(printed.at(-1)).callbacks_delivered, 1);
  }
  assert.deepEqual(deliveries.map(({ route }) => route.controller_session_id), [
    "legacy-controller", "first-controller", "second-controller"
  ]);
  for (const watchId of watchIds) {
    const receipt = loadTerminalWatch(fixture.storeDir, watchId)
      .notification_outbox[0];
    assert.equal(receipt.status, "delivered");
    assert.equal(receipt.attempts, 1);
  }
});

test("route-bound Watch reconciliation keeps each initiating controller session", async (t) => {
  const fixture = createFixture(t);
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminals = [fixture.terminal];
  const initiatingRoute = {
    schema: "agent-knock-knock/callback-route" as const,
    version: 1 as const,
    transport: "command_json_v1",
    profile_id: "fixture-native-host",
    profile_revision: "instance-1",
    controller_session_id: "exact-agent-incarnation-a",
    capabilities: { wake: true, respond: true }
  };
  const lifecycleTemplate = {
    ...initiatingRoute,
    profile_revision: "instance-after-host-restart",
    controller_session_id: "host-lifecycle-placeholder"
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000217",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
    callback: {
      deliver() {
        throw new Error("legacy OpenClaw callback must not run");
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
    callbackRoute: initiatingRoute,
    callbackRouteControllerScope: "route_bound_v1"
  });
  fs.appendFileSync(
    fixture.rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-08-21T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: TASK_ID,
        last_agent_message: "route-bound completion"
      }
    })}\n`
  );
  terminals = [];
  fixture.advance();
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute: lifecycleTemplate,
    callbackRouteControllerScope: "route_bound_v1"
  });
  assert.equal(deliveries.length, 0, "a different Profile revision cannot claim");
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute: {
      ...lifecycleTemplate,
      profile_revision: initiatingRoute.profile_revision
    },
    callbackRouteControllerScope: "route_bound_v1"
  });

  assert.equal(deliveries.length, 1);
  assert.equal(
    deliveries[0].route.controller_session_id,
    initiatingRoute.controller_session_id
  );
  assert.equal(
    deliveries[0].envelope.route.controller_session_id,
    initiatingRoute.controller_session_id
  );
  assert.equal(deliveries[0].route.profile_id, initiatingRoute.profile_id);
  assert.equal(
    deliveries[0].route.profile_revision,
    initiatingRoute.profile_revision
  );
});

test("Terminal Watch accepts a paired human prompt beside a same-turn synthetic Codex context row", async (t) => {
  for (const rootUserRowOrder of [
    "synthetic-first",
    "human-first"
  ] as const) {
    const fixture = createFixture(t, rootUserRowOrder);
    const printed: unknown[] = [];
    const callbacks: TerminalWatchCallbackInput[] = [];
    const facade = createTerminalWatchCliAdapter({
      acquireFileLock: () => () => {},
      acquireTerminalLock: () => () => {},
      observeExactTerminal: async ({ terminalId }) =>
        exactTerminalObservation([fixture.terminal], terminalId),
      loadClaudeAgentRows: () => [],
      now: fixture.now,
      randomUUID: () => rootUserRowOrder === "synthetic-first"
        ? "00000000-0000-4000-8000-000000000214"
        : "00000000-0000-4000-8000-000000000215",
      storeDirFromOptions: () => fixture.storeDir,
      terminalDispatchOwnership: () => ({ state: "none" }),
      terminalIncarnationBlockingTurns: () => [],
      printJson: (value) => printed.push(value),
      callback: {
        deliver(input) {
          callbacks.push(input);
          return { runId: input.idempotencyKey, status: "started" };
        }
      }
    });

    await facade.runWatch({
      terminal: fixture.terminal.id as string,
      openclawSession: "agent:main:main"
    });
    const created = record(record(printed.at(-1)).watch);
    assert.equal(created.status, "active", rootUserRowOrder);
    assert.equal(record(created.callback).pending, 0, rootUserRowOrder);
    assert.equal(callbacks.length, 0, rootUserRowOrder);

    fs.appendFileSync(
      fixture.rolloutPath,
      `${JSON.stringify({
        timestamp: "2026-08-21T01:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: TASK_ID,
          last_agent_message: `Completed with ${rootUserRowOrder} context`
        }
      })}\n`
    );
    fixture.advance();
    await facade.runReconcileWatches({ storeDir: fixture.storeDir });

    assert.equal(callbacks.length, 1, rootUserRowOrder);
    assert.equal(callbacks[0].event, "completed", rootUserRowOrder);
    assert.equal(
      callbacks[0].completionText,
      `Completed with ${rootUserRowOrder} context`,
      rootUserRowOrder
    );
    await facade.runWatchStatus({
      storeDir: fixture.storeDir,
      watch: String(created.watch_id)
    });
    assert.equal(
      record(record(printed.at(-1)).watch).status,
      "completed",
      rootUserRowOrder
    );
  }
});

test("exact durable completion wins when the terminal switches before reconciliation", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  const callbacks: TerminalWatchCallbackInput[] = [];
  let terminals = [fixture.terminal];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000208",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value),
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  fs.appendFileSync(
    fixture.rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-08-21T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: TASK_ID,
        last_agent_message: "Completion survived terminal drift"
      }
    })}\n`
  );
  terminals = [{
    ...fixture.terminal,
    lifecycle_binding_token: "c".repeat(64),
    native_agent_process_uuid: "codex-pid:9999:birth:replacement"
  }];
  fixture.advance();
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });

  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event, "completed");
  assert.equal(callbacks[0].completionText, "Completion survived terminal drift");
  const watchId = String(record(record(printed[0]).watch).watch_id);
  await facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
  assert.equal(record(record(printed.at(-1)).watch).status, "completed");
});

test("an unavailable exact terminal observation is retryable", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  let unavailable = false;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) => unavailable
      ? {
          state: "unavailable" as const,
          reason: "process discovery failed",
          summary: { error: "process discovery failed" }
        }
      : exactTerminalObservation([fixture.terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000213",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value)
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  const watchId = String(record(record(printed.at(-1)).watch).watch_id);
  unavailable = true;
  fixture.advance();
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  await facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
  assert.equal(record(record(printed.at(-1)).watch).status, "active");
});

test("unwatch persists cancellation and leaves callback delivery to supervision", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  const callbacks: TerminalWatchCallbackInput[] = [];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([fixture.terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000209",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value),
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  const watchId = String(record(record(printed.at(-1)).watch).watch_id);
  await facade.runUnwatch({ storeDir: fixture.storeDir, watch: watchId });
  const cancelled = record(record(printed.at(-1)).watch);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(record(cancelled.callback).pending, 1);
  assert.equal(callbacks.length, 0);

  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event, "cancelled");
});

test("Terminal Watch uses one read-only terminal observation without mutation authority", async (t) => {
  const fixture = createFixture(t);
  let scans = 0;
  let terminalLocks = 0;
  const printed: unknown[] = [];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => {
      terminalLocks += 1;
      return () => {};
    },
    observeExactTerminal: async ({ terminalId }) => {
      scans += 1;
      return exactTerminalObservation([{
          ...fixture.terminal,
          lifecycle_binding_token:
            scans === 1 ? TOKEN : "b".repeat(64)
        }], terminalId);
    },
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000206",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value),
    callback: {
      deliver(input) {
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });
  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  assert.equal(scans, 1);
  assert.equal(terminalLocks, 0);
  assert.equal(record(record(printed.at(-1)).watch).status, "active");
});

test("Terminal Watch ignores an invalid sibling record during user-requested creation", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  let nextWatchUuid = 211;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([fixture.terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () =>
      `00000000-0000-4000-8000-000000000${nextWatchUuid++}`,
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value)
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  const firstWatchId = String(record(record(printed.at(-1)).watch).watch_id);
  fs.writeFileSync(
    path.join(
      terminalWatchesDir(fixture.storeDir),
      "terminal-watch-corrupt.json"
    ),
    "{not-valid-watch\n",
    { mode: 0o600 }
  );
  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:another-controller"
  });

  const created = record(record(printed.at(-1)).watch);
  assert.equal(created.status, "active");
  assert.notEqual(created.watch_id, firstWatchId);
  assert.match(
    (created.warnings as string[]).join("\n"),
    /terminal_watch_store_entries_skipped/u
  );
  const tolerant = facade.scanPublicWatchesForExactObservation(
    fixture.storeDir
  );
  assert.equal(tolerant.watches.length, 2);
  assert.equal(tolerant.activeOverlayTrusted, false);
});

test("Terminal Watch derives read-only identity when the lifecycle token is malformed", async (t) => {
  const fixture = createFixture(t);
  const abbreviatedToken = "a".repeat(6) + "…" + "b".repeat(6);
  let scans = 0;
  const printed: unknown[] = [];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) => {
      scans += 1;
      return exactTerminalObservation([{
          ...fixture.terminal,
          lifecycle_binding_token: abbreviatedToken
        }], terminalId);
    },
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000212",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value)
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  assert.equal(scans, 1);
  const created = record(record(printed.at(-1)).watch);
  assert.equal(created.status, "active");
  assert.match(
    (created.warnings as string[]).join("\n"),
    /lifecycle_binding_token_unavailable/u
  );
  fixture.advance();
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: String(created.watch_id)
  });
  assert.equal(
    record(record(printed.at(-1)).watch).status,
    "active",
    "missing binding metadata must remain warning-only during reconciliation"
  );
});

test("Terminal Watch keeps exact observation across running and artifact version drift", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  const driftedTerminal = {
    ...fixture.terminal,
    agent_version: "0.150.0",
    native_thread_lifecycle: {
      status: "supported",
      behaviorProfile: "codex-tui-generic-v1",
      versionCompatibility: "unverified"
    }
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([driftedTerminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000251",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value)
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  const created = record(record(printed.at(-1)).watch);
  assert.equal(created.watch_mode, "exact_task");
  assert.equal(created.confidence, "exact");
  assert.match(
    (created.warnings as string[]).join("\n"),
    /artifact reports 0\.148\.0.*running coding-agent version 0\.150\.0.*advisory/u
  );
});

test("Terminal Watch remains available beside an active managed Turn", async (t) => {
  const fixture = createFixture(t);
  const events: string[] = [];
  let scans = 0;
  let ownershipReads = 0;
  const printed: unknown[] = [];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => {
      events.push("terminal-lock:acquired");
      return () => events.push("terminal-lock:released");
    },
    observeExactTerminal: async ({ terminalId }) => {
      scans += 1;
      events.push(`scan:${scans}`);
      return exactTerminalObservation([fixture.terminal], terminalId);
    },
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000210",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => {
      ownershipReads += 1;
      return { state: "none" };
    },
    terminalIncarnationBlockingTurns: () => {
      events.push("managed-authority:checked");
      return [managedTurn()];
    },
    printJson: (value) => printed.push(value)
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  assert.deepEqual(events, ["scan:1"]);
  assert.equal(ownershipReads, 0);
  assert.equal(record(record(printed.at(-1)).watch).status, "active");
});

test("Terminal Watch treats the public action as discovery rather than authority", async (t) => {
  const fixture = createFixture(t);
  const projectedTerminal = structuredClone(fixture.terminal);
  record(record(projectedTerminal.available_actions).watch).arguments = {
    terminal_id: projectedTerminal.id,
    expected_binding_token: "b".repeat(64)
  };
  let released = false;
  const printed: unknown[] = [];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {
      released = true;
    },
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(
        [fixture.terminal],
        terminalId,
        projectedTerminal
      ),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000211",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value)
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  assert.equal(released, false);
  assert.equal(record(record(printed.at(-1)).watch).status, "active");
});
