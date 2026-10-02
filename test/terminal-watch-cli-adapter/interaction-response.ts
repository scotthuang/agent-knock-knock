import test from "node:test";
import assert from "node:assert/strict";
import {
  createTerminalWatchCliAdapter
} from "../../src/terminal-watch-cli-adapter.js";
import type {
  Conversation
} from "../../src/protocol.js";
import {
  createTerminalWatchOpenClawCallbackRoute
} from "../../src/callback-transport.js";
import {
  createTerminalInteractionAggregate
} from "../../src/terminal-interaction-core.js";
import {
  loadTerminalWatch,
  saveTerminalWatch,
  terminalWatchRevision
} from "../../src/terminal-watch-store.js";
import {
  validateTerminalInteractionSubjectProjection,
  type TerminalInteractionSubjectProjection
} from "../../src/terminal-interaction-protocol.js";
import {
  CODEX_FALLBACK_QUESTION_ONE,
  exactTerminalObservation,
  withTerminalWatchScreen,
  createFixture,
  managedTurn,
  managedInteractionTurn,
  managedConsumedInteractionTurn,
  watchInteractionBridge,
  watchInteractionResponse,
  record
} from "./fixtures.js";

test("Watch respond_interaction live-revalidates an expired offer and consumes one reservation", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const printed: unknown[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  let watchId = "";
  let terminalInputs = 0;
  let terminalLocks = 0;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => {
      terminalLocks += 1;
      return () => {};
    },
    createBridge: () => watchInteractionBridge({
      storeDir: fixture.storeDir,
      watchId: () => watchId,
      mode: "success",
      onTerminalInput: () => {
        terminalInputs += 1;
      }
    }),
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000273",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value)
  });
  const controller = "agent:main:watch-response-success";
  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: controller
  });
  watchId = String(record(record(printed.at(-1)).watch).watch_id);
  terminal = withTerminalWatchScreen(terminal, CODEX_FALLBACK_QUESTION_ONE);
  fixture.advance();
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  const offered = loadTerminalWatch(fixture.storeDir, watchId)
    .current_interaction!.projection;
  fixture.setNow("2026-08-21T01:11:30.000Z");
  await facade.runRespondInteraction({
    storeDir: fixture.storeDir,
    watch: watchId,
    interaction: offered.interaction_id,
    expectedInteractionFingerprint: offered.prompt_fingerprint,
    expectedInteractionExpiresAt: offered.expires_at,
    responseJson: watchInteractionResponse(offered),
    openclawSession: controller
  });
  assert.equal(terminalInputs, 1);
  assert.equal(terminalLocks, 1);
  const consumed = loadTerminalWatch(fixture.storeDir, watchId);
  assert.equal(consumed.current_interaction?.aggregate.state, "consumed");
  assert.equal(
    consumed.current_interaction?.aggregate.reservation?.response_hash.length,
    64
  );
  assert.equal(
    consumed.current_interaction?.projection.expires_at === offered.expires_at,
    false,
    "live status recapture must refresh stale offer freshness"
  );
  assert.equal(record(printed.at(-1)).responded, true);
});

test("Watch response rejects controller mismatch and managed precedence before terminal input", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const printed: unknown[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  let watchId = "";
  let terminalInputs = 0;
  let blockers: Conversation[] = [];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    createBridge: () => watchInteractionBridge({
      storeDir: fixture.storeDir,
      watchId: () => watchId,
      mode: "success",
      onTerminalInput: () => {
        terminalInputs += 1;
      }
    }),
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000274",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => blockers,
    printJson: (value) => printed.push(value)
  });
  const controller = "agent:main:watch-response-owner";
  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: controller
  });
  watchId = String(record(record(printed.at(-1)).watch).watch_id);
  terminal = withTerminalWatchScreen(terminal, CODEX_FALLBACK_QUESTION_ONE);
  fixture.advance();
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  const offered = loadTerminalWatch(fixture.storeDir, watchId)
    .current_interaction!.projection;
  const responseOptions = {
    storeDir: fixture.storeDir,
    watch: watchId,
    interaction: offered.interaction_id,
    expectedInteractionFingerprint: offered.prompt_fingerprint,
    expectedInteractionExpiresAt: offered.expires_at,
    responseJson: watchInteractionResponse(offered)
  };
  await assert.rejects(
    () => facade.runRespondInteraction({
      ...responseOptions,
      openclawSession: "agent:main:not-owner"
    }),
    /different controller session; no terminal input was sent/u
  );
  blockers = [managedTurn()];
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    true,
    "a managed Turn without a private surface claim must not suppress Watch"
  );
  blockers = [managedInteractionTurn(
    "tis_0000000000000000000000000000000000000000",
    offered.prompt_fingerprint,
    controller
  )];
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    true,
    "a managed claim for another surface must not suppress Watch"
  );
  blockers = [managedInteractionTurn(
    offered.surface_id,
    offered.prompt_fingerprint,
    "agent:main:another-controller"
  )];
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  const crossController = loadTerminalWatch(fixture.storeDir, watchId);
  assert.equal(
    crossController.current_interaction?.projection.capabilities.respond,
    false,
    "another controller's exact managed claim must leave this Watch notify-only"
  );
  assert.equal(
    crossController.notification_outbox.at(-1)?.kind,
    "interaction_manual_required"
  );
  blockers = [managedInteractionTurn(
    offered.surface_id,
    offered.prompt_fingerprint,
    controller,
    { respond: false }
  )];
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    true,
    "a managed manual-only projection must not claim response authority"
  );
  blockers = [managedInteractionTurn(
    offered.surface_id,
    offered.prompt_fingerprint,
    controller,
    { state: "manual_required" }
  )];
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    true,
    "a non-pending managed projection must not claim response authority"
  );
  blockers = [managedInteractionTurn(
    offered.surface_id,
    offered.prompt_fingerprint,
    controller,
    { omitNotifiedAt: true }
  )];
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    true,
    "a managed claim without notified_at must fail closed"
  );
  blockers = [managedConsumedInteractionTurn(
    offered.surface_id,
    offered.prompt_fingerprint,
    controller
  )];
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    false,
    "a consumed managed response must fence the still-visible native surface"
  );
  blockers = [];
  await facade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: watchId,
    openclawSession: controller
  });
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    true,
    "removing the consumed surface owner restores exact Watch authority"
  );
  blockers = [managedInteractionTurn(
    offered.surface_id,
    offered.prompt_fingerprint,
    controller
  )];
  await assert.rejects(
    () => facade.runRespondInteraction({
      ...responseOptions,
      openclawSession: controller
    }),
    /no matching executable interaction offer/u
  );
  assert.equal(terminalInputs, 0);
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.aggregate
      .state,
    "pending"
  );
  assert.equal(
    loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.projection
      .capabilities.respond,
    false,
    "managed precedence must revoke the stale executable offer"
  );
});

test("Watch response re-arbitrates managed and newer Watch claims after authorization", async (t) => {
  for (const scenario of ["managed", "newer_watch"] as const) {
    const fixture = createFixture(t, "human-only", "0.153.4");
    const printed: unknown[] = [];
    let terminal: Record<string, any> = fixture.terminal;
    let watchId = "";
    let siblingId = "";
    let offered: TerminalInteractionSubjectProjection | undefined;
    let blockers: Conversation[] = [];
    let terminalInputs = 0;
    const controller = `agent:main:watch-race-${scenario}`;
    const route = createTerminalWatchOpenClawCallbackRoute({
      controllerSessionId: controller,
      openclawBin: "/opt/openclaw/bin/openclaw",
      respond: true
    });
    const facade = createTerminalWatchCliAdapter({
      acquireFileLock: () => () => {},
      acquireTerminalLock: () => () => {},
      createBridge: () => watchInteractionBridge({
        storeDir: fixture.storeDir,
        watchId: () => watchId,
        mode: "success",
        onTerminalInput: () => {
          terminalInputs += 1;
        },
        afterAuthorize: () => {
          assert.ok(offered);
          if (scenario === "managed") {
            blockers = [managedInteractionTurn(
              offered.surface_id,
              offered.prompt_fingerprint,
              controller
            )];
            return;
          }
          const sibling = loadTerminalWatch(fixture.storeDir, siblingId);
          const siblingProjection = validateTerminalInteractionSubjectProjection({
            ...offered,
            turn_id: undefined,
            interaction_id: `ti_${"8".repeat(40)}`,
            subject: {
              kind: "terminal_watch" as const,
              watch_id: siblingId,
              anchor_fingerprint: sibling.anchor.anchor_fingerprint
            }
          });
          const insertedAt = "2026-08-21T01:00:03.000Z";
          saveTerminalWatch(fixture.storeDir, {
            ...sibling,
            current_interaction: {
              projection: siblingProjection,
              aggregate: createTerminalInteractionAggregate(
                siblingProjection,
                insertedAt
              )
            },
            updated_at: insertedAt,
            last_activity_at: insertedAt
          }, { expectedRevision: terminalWatchRevision(sibling) });
        }
      }),
      observeExactTerminal: async ({ terminalId }) =>
        exactTerminalObservation([terminal], terminalId),
      loadClaudeAgentRows: () => [],
      now: fixture.now,
      randomUUID: () => scenario === "managed"
        ? "00000000-0000-4000-8000-000000000307"
        : "00000000-0000-4000-8000-000000000308",
      storeDirFromOptions: () => fixture.storeDir,
      terminalDispatchOwnership: () => ({ state: "none" }),
      terminalIncarnationBlockingTurns: () => blockers,
      printJson: (value) => printed.push(value)
    });
    await facade.runWatch({
      terminal: fixture.terminal.id as string,
      openclawSession: controller,
      callbackRoute: route
    });
    watchId = String(record(record(printed.at(-1)).watch).watch_id);
    terminal = withTerminalWatchScreen(terminal, CODEX_FALLBACK_QUESTION_ONE);
    fixture.advance();
    await facade.runWatchStatus({
      storeDir: fixture.storeDir,
      watch: watchId,
      openclawSession: controller
    });
    offered = loadTerminalWatch(fixture.storeDir, watchId)
      .current_interaction?.projection;
    assert.ok(offered);
    if (scenario === "newer_watch") {
      const current = loadTerminalWatch(fixture.storeDir, watchId);
      const sibling = structuredClone(current);
      delete sibling.revision;
      siblingId = "terminal-watch-authorize-race-newer";
      sibling.watch_id = siblingId;
      sibling.created_at = "2026-08-21T01:00:03.000Z";
      sibling.updated_at = sibling.created_at;
      sibling.last_activity_at = sibling.created_at;
      sibling.current_interaction = undefined;
      sibling.notification_outbox = [];
      saveTerminalWatch(fixture.storeDir, sibling, { expectedRevision: null });
    }

    await assert.rejects(
      () => facade.runRespondInteraction({
        storeDir: fixture.storeDir,
        watch: watchId,
        interaction: offered!.interaction_id,
        expectedInteractionFingerprint: offered!.prompt_fingerprint,
        expectedInteractionExpiresAt: offered!.expires_at,
        responseJson: watchInteractionResponse(offered!),
        openclawSession: controller
      }),
      /interaction ownership changed before dispatch/u
    );
    assert.equal(terminalInputs, 0, `${scenario} race must send zero input`);
    assert.equal(
      loadTerminalWatch(fixture.storeDir, watchId).current_interaction?.aggregate
        .state,
      "pending",
      "failed arbitration must not persist a dispatch reservation"
    );
  }
});

test("Watch response releases a proven pre-input failure and freezes uncertain input", async (t) => {
  for (const scenario of [
    { mode: "input_not_started" as const, expected: "pending", inputs: 0 },
    { mode: "input_uncertain" as const, expected: "response_uncertain", inputs: 1 }
  ]) {
    const fixture = createFixture(t, "human-only", "0.153.4");
    const printed: unknown[] = [];
    let terminal: Record<string, any> = fixture.terminal;
    let watchId = "";
    let terminalInputs = 0;
    const facade = createTerminalWatchCliAdapter({
      acquireFileLock: () => () => {},
      acquireTerminalLock: () => () => {},
      createBridge: () => watchInteractionBridge({
        storeDir: fixture.storeDir,
        watchId: () => watchId,
        mode: scenario.mode,
        onTerminalInput: () => {
          terminalInputs += 1;
        }
      }),
      observeExactTerminal: async ({ terminalId }) =>
        exactTerminalObservation([terminal], terminalId),
      loadClaudeAgentRows: () => [],
      now: fixture.now,
      randomUUID: () => scenario.mode === "input_not_started"
        ? "00000000-0000-4000-8000-000000000275"
        : "00000000-0000-4000-8000-000000000276",
      storeDirFromOptions: () => fixture.storeDir,
      terminalDispatchOwnership: () => ({ state: "none" }),
      terminalIncarnationBlockingTurns: () => [],
      printJson: (value) => printed.push(value)
    });
    const controller = `agent:main:watch-${scenario.mode}`;
    await facade.runWatch({
      terminal: fixture.terminal.id as string,
      openclawSession: controller
    });
    watchId = String(record(record(printed.at(-1)).watch).watch_id);
    terminal = withTerminalWatchScreen(terminal, CODEX_FALLBACK_QUESTION_ONE);
    fixture.advance();
    await facade.runWatchStatus({
      storeDir: fixture.storeDir,
      watch: watchId,
      openclawSession: controller
    });
    const offered = loadTerminalWatch(fixture.storeDir, watchId)
      .current_interaction!.projection;
    await assert.rejects(() => facade.runRespondInteraction({
      storeDir: fixture.storeDir,
      watch: watchId,
      interaction: offered.interaction_id,
      expectedInteractionFingerprint: offered.prompt_fingerprint,
      expectedInteractionExpiresAt: offered.expires_at,
      responseJson: watchInteractionResponse(offered),
      openclawSession: controller
    }));
    const settled = loadTerminalWatch(fixture.storeDir, watchId)
      .current_interaction!;
    assert.equal(settled.aggregate.state, scenario.expected, scenario.mode);
    assert.equal(terminalInputs, scenario.inputs, scenario.mode);
    assert.equal(
      settled.projection.capabilities.respond,
      scenario.mode === "input_not_started",
      scenario.mode
    );
  }
});
