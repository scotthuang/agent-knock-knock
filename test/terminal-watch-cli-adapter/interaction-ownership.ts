import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createTerminalWatchCliAdapter
} from "../../src/terminal-watch-cli-adapter.js";
import {
  initialClaudeHumanStartedActiveTaskCheckpoint
} from "../../src/claude-local-transcript-provider.js";
import {
  createTerminalWatchOpenClawCallbackRoute,
  type CallbackTransportDeliverInput
} from "../../src/callback-transport.js";
import {
  createTerminalInteractionAggregate
} from "../../src/terminal-interaction-core.js";
import {
  loadTerminalWatch,
  saveTerminalWatch
} from "../../src/terminal-watch-store.js";
import {
  validateTerminalInteractionSubjectProjection
} from "../../src/terminal-interaction-protocol.js";
import {
  CODEX_FALLBACK_QUESTION_ONE,
  CLAUDE_NATIVE_QUESTION,
  exactTerminalObservation,
  withTerminalWatchScreen,
  createClaudeQuestionnaireFixture,
  createFixture,
  record
} from "./fixtures.js";

test("a newer stale Codex task Watch cannot claim the current surface", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const printed: unknown[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  const controller = "agent:main:watch-stale-codex-task";
  const route = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: controller,
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
    randomUUID: () => "00000000-0000-4000-8000-000000000305",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value)
  });
  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: controller,
    callbackRoute: route
  });
  const watchId = String(record(record(printed.at(-1)).watch).watch_id);
  terminal = withTerminalWatchScreen(terminal, CODEX_FALLBACK_QUESTION_ONE);
  fixture.advance();
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  const current = loadTerminalWatch(fixture.storeDir, watchId);
  assert.equal(
    current.anchor.schema,
    "agent-knock-knock/codex-human-started-active-task-anchor"
  );
  assert.ok(current.current_interaction);
  if (
    current.anchor.schema !==
      "agent-knock-knock/codex-human-started-active-task-anchor" ||
    !current.current_interaction
  ) throw new Error("Codex exact Watch fixture was not captured");
  const { anchor_fingerprint: _oldFingerprint, ...staleAnchorBase } = {
    ...current.anchor,
    turn_id: "019f0000-0000-7000-8000-000000000306"
  };
  const staleAnchor = {
    ...staleAnchorBase,
    anchor_fingerprint: createHash("sha256")
      .update(JSON.stringify(staleAnchorBase))
      .digest("hex")
  };
  const staleId = "terminal-watch-stale-codex-task";
  const staleProjection = validateTerminalInteractionSubjectProjection({
    ...current.current_interaction.projection,
    turn_id: undefined,
    interaction_id: `ti_${"9".repeat(40)}`,
    subject: {
      kind: "terminal_watch" as const,
      watch_id: staleId,
      anchor_fingerprint: staleAnchor.anchor_fingerprint
    }
  });
  const staleCreatedAt = "2026-08-21T01:00:05.000Z";
  const stale = structuredClone(current);
  delete stale.revision;
  stale.watch_id = staleId;
  stale.anchor = staleAnchor;
  stale.created_at = staleCreatedAt;
  stale.updated_at = staleCreatedAt;
  stale.last_activity_at = staleCreatedAt;
  stale.notification_outbox = [];
  stale.current_interaction = {
    projection: staleProjection,
    aggregate: createTerminalInteractionAggregate(
      staleProjection,
      staleCreatedAt
    )
  };
  saveTerminalWatch(fixture.storeDir, stale, { expectedRevision: null });

  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    true,
    "same terminal and surface are insufficient without the exact Codex task"
  );
});

test("a newer stale Claude prompt Watch cannot claim the current surface", async (t) => {
  const fixture = createClaudeQuestionnaireFixture(t);
  const printed: unknown[] = [];
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminal = fixture.terminal;
  const controller = "agent:main:watch-stale-claude-task";
  const route = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: controller,
    openclawBin: "/opt/openclaw/bin/openclaw",
    respond: true
  });
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => fixture.agentRows,
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000309",
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
    openclawSession: controller,
    callbackRoute: route,
    claudeHome: fixture.claudeHome
  });
  const watchId = String(record(record(printed.at(-1)).watch).watch_id);
  terminal = withTerminalWatchScreen(terminal, CLAUDE_NATIVE_QUESTION);
  fixture.advance();
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller,
    claudeHome: fixture.claudeHome
  });
  const current = loadTerminalWatch(fixture.storeDir, watchId);
  assert.equal(
    current.current_interaction?.projection.capabilities.respond,
    true,
    "the current Claude prompt must begin with exact response authority"
  );
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute: route
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].envelope.event.type, "interaction_required");
  assert.equal(
    current.anchor.schema,
    "agent-knock-knock/claude-human-started-active-task-anchor"
  );
  assert.ok(current.current_interaction);
  if (
    current.anchor.schema !==
      "agent-knock-knock/claude-human-started-active-task-anchor" ||
    !current.current_interaction
  ) throw new Error("Claude exact Watch fixture was not captured");
  assert.equal(current.anchor.claude_version, "2.1.267");
  const { anchor_fingerprint: _oldFingerprint, ...staleAnchorBase } = {
    ...current.anchor,
    prompt_uuid: "019f0000-0000-7000-8000-000000000310",
    request_hash: "7".repeat(64)
  };
  const staleAnchor = {
    ...staleAnchorBase,
    anchor_fingerprint: createHash("sha256")
      .update(JSON.stringify(staleAnchorBase))
      .digest("hex")
  };
  const staleId = "terminal-watch-stale-claude-task";
  const staleProjection = validateTerminalInteractionSubjectProjection({
    ...current.current_interaction.projection,
    turn_id: undefined,
    interaction_id: `ti_${"7".repeat(40)}`,
    subject: {
      kind: "terminal_watch",
      watch_id: staleId,
      anchor_fingerprint: staleAnchor.anchor_fingerprint
    }
  });
  const staleCreatedAt = "2026-08-21T01:00:05.000Z";
  const stale = structuredClone(current);
  delete stale.revision;
  stale.watch_id = staleId;
  stale.anchor = staleAnchor;
  stale.observation_checkpoint =
    initialClaudeHumanStartedActiveTaskCheckpoint(staleAnchor);
  stale.created_at = staleCreatedAt;
  stale.updated_at = staleCreatedAt;
  stale.last_activity_at = staleCreatedAt;
  stale.notification_outbox = [];
  stale.current_interaction = {
    projection: staleProjection,
    aggregate: createTerminalInteractionAggregate(
      staleProjection,
      staleCreatedAt
    )
  };
  saveTerminalWatch(fixture.storeDir, stale, { expectedRevision: null });

  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller,
    claudeHome: fixture.claudeHome
  });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    true,
    "same Claude session and surface are insufficient without the exact prompt"
  );
});

test("newer exact Watch wins one surface while loser notification follows controller scope", async (t) => {
  for (const sameController of [true, false]) {
    const fixture = createFixture(t, "human-only", "0.153.4");
    const printed: unknown[] = [];
    let terminal: Record<string, any> = fixture.terminal;
    const firstController = `agent:main:watch-election-${sameController}`;
    const secondController = sameController
      ? firstController
      : "agent:main:watch-election-other";
    const firstRoute = createTerminalWatchOpenClawCallbackRoute({
      controllerSessionId: firstController,
      openclawBin: "/opt/openclaw/bin/openclaw",
      respond: true
    });
    const secondRoute = createTerminalWatchOpenClawCallbackRoute({
      controllerSessionId: secondController,
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
      randomUUID: () => sameController
        ? "00000000-0000-4000-8000-000000000281"
        : "00000000-0000-4000-8000-000000000282",
      storeDirFromOptions: () => fixture.storeDir,
      terminalDispatchOwnership: () => ({ state: "none" }),
      terminalIncarnationBlockingTurns: () => [],
      printJson: (value) => printed.push(value)
    });
    await facade.runWatch({
      terminal: fixture.terminal.id as string,
      openclawSession: firstController,
      callbackRoute: firstRoute
    });
    const firstId = String(record(record(printed.at(-1)).watch).watch_id);
    const first = loadTerminalWatch(fixture.storeDir, firstId);
    const secondId = `terminal-watch-newer-election-${sameController}`;
    const secondCreatedAt = "2026-08-21T01:00:01.000Z";
    const second = structuredClone(first);
    delete second.revision;
    second.watch_id = secondId;
    second.callback_route = secondRoute;
    second.openclaw_session = secondController;
    second.created_at = secondCreatedAt;
    second.updated_at = secondCreatedAt;
    second.last_activity_at = secondCreatedAt;
    second.notification_outbox = [];
    second.current_interaction = undefined;
    saveTerminalWatch(fixture.storeDir, second, { expectedRevision: null });

    terminal = withTerminalWatchScreen(terminal, CODEX_FALLBACK_QUESTION_ONE);
    fixture.setNow("2026-08-21T01:00:02.000Z");
    await facade.runWatchStatus({
      storeDir: fixture.storeDir,
      watch: firstId,
      openclawSession: firstController
    });
    await facade.runWatchStatus({
      storeDir: fixture.storeDir,
      watch: secondId,
      openclawSession: secondController
    });
    await facade.runWatchStatus({
      storeDir: fixture.storeDir,
      watch: firstId,
      openclawSession: firstController
    });

    const older = loadTerminalWatch(fixture.storeDir, firstId);
    const newer = loadTerminalWatch(fixture.storeDir, secondId);
    assert.equal(older.current_interaction?.projection.capabilities.respond, false);
    assert.equal(newer.current_interaction?.projection.capabilities.respond, true);
    assert.equal(newer.notification_outbox[0]?.kind, "interaction_required");
    if (sameController) {
      assert.equal(
        older.notification_outbox.every((notification) =>
          notification.status === "superseded"),
        true,
        "same-controller loser must suppress its duplicate callback"
      );
    } else {
      assert.equal(
        older.notification_outbox.at(-1)?.kind,
        "interaction_manual_required",
        "another controller may observe the surface without response authority"
      );
    }
  }
});

test("terminal-activity Watch projects questionnaire notification without response authority", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const header = fs.readFileSync(fixture.rolloutPath, "utf8").split("\n")[0];
  fs.writeFileSync(fixture.rolloutPath, `${header}\n`, { mode: 0o600 });
  const printed: unknown[] = [];
  const deliveries: CallbackTransportDeliverInput[] = [];
  const callbackRoute = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: "agent:main:activity-questionnaire",
    openclawBin: "/opt/openclaw/bin/openclaw",
    respond: true
  });
  const terminal = withTerminalWatchScreen(
    { ...fixture.terminal, available_actions: {}, activity_state: "working" },
    CODEX_FALLBACK_QUESTION_ONE
  );
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000272",
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
    terminal: terminal.id as string,
    openclawSession: callbackRoute.controller_session_id,
    callbackRoute
  });
  const watchId = String(record(record(printed.at(-1)).watch).watch_id);
  fixture.advance();
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: callbackRoute.controller_session_id,
    callbackRoute
  });
  const publicWatch = record(record(printed.at(-1)).watch);
  const projection = record(publicWatch.interaction_state);
  assert.equal(publicWatch.watch_mode, "terminal_activity");
  assert.equal(publicWatch.interaction_policy, "notify_only");
  assert.equal(record(publicWatch.capabilities).interaction_respond, false);
  assert.equal(projection.response_authority, "notify_only");
  assert.equal(record(projection.capabilities).respond, false);
  await facade.runReconcileWatches({
    storeDir: fixture.storeDir,
    callbackRoute
  });
  assert.equal(deliveries.length, 1);
  assert.equal(
    deliveries[0].envelope.event.type,
    "interaction_manual_required"
  );
  assert.deepEqual(deliveries[0].route.capabilities, {
    wake: true,
    respond: false
  });
});
