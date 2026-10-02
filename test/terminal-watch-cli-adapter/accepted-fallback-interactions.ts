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
  createTerminalWatchOpenClawCallbackRoute,
  type CallbackTransportDeliverInput
} from "../../src/callback-transport.js";
import {
  loadTerminalWatch,
  pathsForTerminalWatch
} from "../../src/terminal-watch-store.js";
import {
  STORE_WRITER_PROTOCOL,
  storeManifestPath
} from "../../src/store.js";
import {
  CODEX_FALLBACK_QUESTION_ONE,
  CODEX_FALLBACK_QUESTION_TWO,
  exactTerminalObservation,
  withTerminalWatchScreen,
  fallbackAcceptedTurnRecords,
  fallbackRequestUserInputRecord,
  createFixture,
  codexInventoryForTerminal,
  record
} from "./fixtures.js";

test("fallback Watch attributes its accepted questionnaire across ambiguous Codex roots", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const otherThreadId = "019f0000-0000-7000-8000-000000000293";
  const otherRolloutPath = path.join(
    path.dirname(fixture.rolloutPath),
    "ambiguous-other-rollout.jsonl"
  );
  fs.writeFileSync(otherRolloutPath, `${JSON.stringify({
    timestamp: "2026-08-21T01:00:00.050Z",
    type: "session_meta",
    payload: {
      id: otherThreadId,
      timestamp: "2026-08-21T01:00:00.050Z",
      cwd: path.dirname(fixture.rolloutPath),
      originator: "codex-tui",
      source: "cli",
      cli_version: "0.153.4"
    }
  })}\n`, { mode: 0o600 });
  const otherStat = fs.statSync(otherRolloutPath);
  const processUuid = String(fixture.terminal.native_agent_process_uuid);
  const processBirth = String(fixture.terminal.native_agent_process_birth);
  const acceptedRoot = {
    sessionId: String(fixture.terminal.native_agent_session_id),
    processUuid,
    processBirth,
    rollout: structuredClone(record(fixture.terminal.native_agent_rollout)),
    evidence: "codex_open_root_rollout" as const
  };
  const otherRoot = {
    sessionId: otherThreadId,
    processUuid,
    processBirth,
    rollout: {
      fd: "52r",
      device: String(otherStat.dev),
      inode: String(otherStat.ino),
      path: otherRolloutPath
    },
    evidence: "codex_open_root_rollout" as const
  };
  let terminal: Record<string, any> = {
    ...fixture.terminal,
    _codex_open_root_rollout_inventory: codexInventoryForTerminal(
      fixture.terminal,
      [acceptedRoot, otherRoot]
    )
  };
  const deliveries: CallbackTransportDeliverInput[] = [];
  const callbackRoute = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: "agent:main:fallback-multi-root-questionnaire",
    openclawBin: "/opt/openclaw/bin/openclaw"
  });
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000293",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
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
  const request = "Ask this exact Codex turn a native question";
  const options = { storeDir: fixture.storeDir, callbackRoute };
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(terminal.id),
      agent: "codex",
      pid: Number(terminal.pid),
      terminalControl: terminal.terminal_control as never
    },
    requestHash: createHash("sha256").update(request).digest("hex"),
    messageId: "message-fallback-multi-root-questionnaire",
    physicalToken: "8".repeat(64)
  });
  assert.ok(prepared);
  await facade.attachUserExplicitFallbackWatch({ options, prepared });

  const acceptedTurnId = "019f0000-0000-7000-8000-000000000292";
  fs.appendFileSync(
    fixture.rolloutPath,
    [
      ...fallbackAcceptedTurnRecords(request, acceptedTurnId),
      fallbackRequestUserInputRecord(
        acceptedTurnId,
        "fallback-questionnaire-call-292"
      )
    ].map((value) => JSON.stringify(value)).join("\n") + "\n"
  );

  fixture.advance();
  await facade.runReconcileWatches(options);
  assert.equal(deliveries.length, 0);
  assert.ok(
    loadTerminalWatch(fixture.storeDir, prepared.watchId)
      .observation_checkpoint &&
      "accepted_identity" in loadTerminalWatch(
        fixture.storeDir,
        prepared.watchId
      ).observation_checkpoint
  );

  const ambiguousAcceptedRoot = {
    ...acceptedRoot,
    rollout: { ...acceptedRoot.rollout, fd: "91r" }
  };
  terminal = withTerminalWatchScreen({
    ...terminal,
    native_agent_session_id: undefined,
    native_agent_rollout: undefined,
    _codex_open_root_rollout_inventory: codexInventoryForTerminal(
      terminal,
      [ambiguousAcceptedRoot, otherRoot]
    )
  }, CODEX_FALLBACK_QUESTION_ONE);
  await facade.runReconcileWatches(options);
  assert.equal(deliveries.length, 1);
  assert.equal(
    deliveries[0].envelope.event.type,
    "interaction_manual_required"
  );
});

test("fallback Watch never attributes a questionnaire from another Codex thread", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  const callbackRoute = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: "agent:main:fallback-context-fence",
    openclawBin: "/opt/openclaw/bin/openclaw"
  });
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000294",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
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
  const request = "Keep this fallback Watch on its exact Codex context";
  const requestHash = createHash("sha256").update(request).digest("hex");
  const options = { storeDir: fixture.storeDir, callbackRoute };
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(fixture.terminal.id),
      agent: "codex",
      pid: Number(fixture.terminal.pid),
      terminalControl: fixture.terminal.terminal_control as never
    },
    requestHash,
    messageId: "message-fallback-context-fence",
    physicalToken: "7".repeat(64)
  });
  assert.ok(prepared);
  await facade.attachUserExplicitFallbackWatch({ options, prepared });

  const acceptedTurnId = "019f0000-0000-7000-8000-000000000294";
  fs.appendFileSync(
    fixture.rolloutPath,
    fallbackAcceptedTurnRecords(request, acceptedTurnId)
      .map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
  terminal = withTerminalWatchScreen(
    fixture.terminal,
    CODEX_FALLBACK_QUESTION_ONE
  );
  fixture.advance();
  await facade.runReconcileWatches(options);
  assert.equal(deliveries.length, 1);
  assert.equal(
    deliveries[0].envelope.event.type,
    "interaction_manual_required"
  );

  const otherThreadId = "019f0000-0000-7000-8000-000000000293";
  const otherRolloutPath = path.join(
    path.dirname(fixture.rolloutPath),
    "other-rollout.jsonl"
  );
  fs.writeFileSync(otherRolloutPath, `${JSON.stringify({
    timestamp: "2026-08-21T01:00:01.000Z",
    type: "session_meta",
    payload: {
      id: otherThreadId,
      timestamp: "2026-08-21T01:00:01.000Z",
      cwd: path.dirname(fixture.rolloutPath),
      originator: "codex-tui",
      source: "cli",
      cli_version: "0.153.4"
    }
  })}\n`, { mode: 0o600 });
  const otherStat = fs.statSync(otherRolloutPath);
  terminal = withTerminalWatchScreen({
    ...fixture.terminal,
    native_agent_session_id: otherThreadId,
    native_agent_rollout: {
      fd: "52r",
      device: String(otherStat.dev),
      inode: String(otherStat.ino),
      path: otherRolloutPath
    }
  }, CODEX_FALLBACK_QUESTION_TWO);
  await facade.runReconcileWatches(options);
  assert.equal(
    deliveries.length,
    1,
    "a different thread in the same pane/process cannot inherit the old Watch"
  );

  terminal = withTerminalWatchScreen({
    ...fixture.terminal,
    native_agent_session_id: undefined,
    native_agent_rollout: undefined
  }, CODEX_FALLBACK_QUESTION_TWO);
  await facade.runReconcileWatches(options);
  assert.equal(
    deliveries.length,
    1,
    "ambiguous or unavailable live identity fails closed for screen attribution"
  );

  fs.appendFileSync(fixture.rolloutPath, `${JSON.stringify({
    timestamp: "2026-08-21T01:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: acceptedTurnId,
      last_agent_message: "Old exact rollout still completed"
    }
  })}\n`);
  await facade.runReconcileWatches(options);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].envelope.event.type, "completed");
  assert.equal(
    deliveries[1].envelope.event.metadata?.completion_text,
    "Old exact rollout still completed"
  );
});

test("fallback Watch settles an aborted Codex turn before reading later screens", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  const callbackRoute = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: "agent:main:fallback-abort",
    openclawBin: "/opt/openclaw/bin/openclaw"
  });
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000292",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
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
  const request = "Stop this fallback Watch on exact native abort";
  const options = { storeDir: fixture.storeDir, callbackRoute };
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(fixture.terminal.id),
      agent: "codex",
      pid: Number(fixture.terminal.pid),
      terminalControl: fixture.terminal.terminal_control as never
    },
    requestHash: createHash("sha256").update(request).digest("hex"),
    messageId: "message-fallback-abort",
    physicalToken: "5".repeat(64)
  });
  assert.ok(prepared);
  await facade.attachUserExplicitFallbackWatch({ options, prepared });

  const acceptedTurnId = "019f0000-0000-7000-8000-000000000292";
  fs.appendFileSync(
    fixture.rolloutPath,
    fallbackAcceptedTurnRecords(request, acceptedTurnId)
      .map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
  terminal = withTerminalWatchScreen(
    fixture.terminal,
    CODEX_FALLBACK_QUESTION_ONE
  );
  fixture.advance();
  await facade.runReconcileWatches(options);
  assert.equal(deliveries.length, 1);

  fs.appendFileSync(fixture.rolloutPath, `${JSON.stringify({
    timestamp: "2026-08-21T01:00:01.900Z",
    type: "event_msg",
    payload: {
      type: "turn_aborted",
      turn_id: acceptedTurnId,
      reason: "interrupted"
    }
  })}\n`);
  terminal = withTerminalWatchScreen(
    fixture.terminal,
    CODEX_FALLBACK_QUESTION_TWO
  );
  await facade.runReconcileWatches(options);
  assert.equal(
    loadTerminalWatch(fixture.storeDir, prepared.watchId).status,
    "failed"
  );
  if (deliveries.length === 1) {
    await facade.runReconcileWatches(options);
  }
  assert.deepEqual(
    deliveries.map((delivery) => delivery.envelope.event.type),
    ["interaction_manual_required", "failed"]
  );
  await facade.runReconcileWatches(options);
  assert.equal(deliveries.length, 2, "an aborted Watch cannot read later screens");
});

test("fallback Watch invalidates when a later Codex turn crosses its open turn", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  const callbackRoute = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: "agent:main:fallback-later-turn",
    openclawBin: "/opt/openclaw/bin/openclaw"
  });
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000291",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
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
  const request = "Invalidate this Watch if another turn overtakes it";
  const options = { storeDir: fixture.storeDir, callbackRoute };
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(fixture.terminal.id),
      agent: "codex",
      pid: Number(fixture.terminal.pid),
      terminalControl: fixture.terminal.terminal_control as never
    },
    requestHash: createHash("sha256").update(request).digest("hex"),
    messageId: "message-fallback-later-turn",
    physicalToken: "4".repeat(64)
  });
  assert.ok(prepared);
  await facade.attachUserExplicitFallbackWatch({ options, prepared });

  const acceptedTurnId = "019f0000-0000-7000-8000-000000000291";
  fs.appendFileSync(
    fixture.rolloutPath,
    [
      ...fallbackAcceptedTurnRecords(request, acceptedTurnId),
      {
        timestamp: "2026-08-21T01:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "019f0000-0000-7000-8000-000000000290"
        }
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
  terminal = withTerminalWatchScreen(
    fixture.terminal,
    CODEX_FALLBACK_QUESTION_ONE
  );
  fixture.advance();
  await facade.runReconcileWatches(options);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].envelope.event.type, "invalidated");
  assert.equal(
    deliveries[0].envelope.event.metadata?.reason_code,
    "native_completion_later_turn_started"
  );
  assert.equal(
    loadTerminalWatch(fixture.storeDir, prepared.watchId).status,
    "invalidated"
  );
});

test("response-capable fallback Watch preserves its route for questionnaire delivery", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  const legacyHostRoute = {
    schema: "agent-knock-knock/callback-route" as const,
    version: 1 as const,
    transport: "command_json_v1" as const,
    profile_id: "protocol-6-host",
    profile_revision: "1",
    controller_session_id: "agent:main:protocol-6-fallback",
    capabilities: { wake: true, respond: true }
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000295",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
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
  const request = "Ask one harmless native question";
  const options = { storeDir: fixture.storeDir, callbackRoute: legacyHostRoute };
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(fixture.terminal.id),
      agent: "codex",
      pid: Number(fixture.terminal.pid),
      terminalControl: fixture.terminal.terminal_control as never
    },
    requestHash: createHash("sha256").update(request).digest("hex"),
    messageId: "message-protocol-6-questionnaire",
    physicalToken: "6".repeat(64)
  });
  assert.ok(prepared);
  await facade.attachUserExplicitFallbackWatch({ options, prepared });

  // Recreate an active predecessor Watch whose trusted Host route still
  // carried response authority. Protocol 6 did not know about questionnaire
  // notifications, so only the top-level creation route needs migration at
  // the new notification claim boundary.
  const watchPath = pathsForTerminalWatch(
    prepared.watchId,
    fixture.storeDir
  ).statePath;
  const predecessor = JSON.parse(fs.readFileSync(watchPath, "utf8"));
  predecessor.callback_route = legacyHostRoute;
  fs.writeFileSync(watchPath, `${JSON.stringify(predecessor)}\n`, { mode: 0o600 });
  const manifestPath = storeManifestPath(fixture.storeDir);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.writer_protocol = 6;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600
  });

  const readablePredecessor = loadTerminalWatch(
    fixture.storeDir,
    prepared.watchId
  );
  assert.deepEqual(
    readablePredecessor.callback_route?.capabilities,
    { wake: true, respond: true },
    "the predecessor remains readable without rewriting its creation route"
  );

  const fallbackTurnId = "019f0000-0000-7000-8000-000000000295";
  fs.appendFileSync(
    fixture.rolloutPath,
    [
      {
        timestamp: "2026-08-21T01:00:00.200Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: fallbackTurnId }
      },
      {
        timestamp: "2026-08-21T01:00:00.201Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: request }],
          internal_chat_message_metadata_passthrough: {
            turn_id: fallbackTurnId
          }
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.202Z",
        type: "event_msg",
        payload: { type: "user_message", message: request }
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
  terminal = withTerminalWatchScreen(
    fixture.terminal,
    CODEX_FALLBACK_QUESTION_ONE
  );
  fixture.advance();
  await facade.runReconcileWatches(options);

  assert.equal(deliveries.length, 1);
  assert.equal(
    deliveries[0].envelope.event.type,
    "interaction_required"
  );
  assert.deepEqual(deliveries[0].route, legacyHostRoute);
  assert.equal(
    Object.hasOwn(deliveries[0].envelope.route, "capabilities"),
    false,
    "the canonical envelope references the profile without duplicating authority"
  );
  const upgraded = loadTerminalWatch(fixture.storeDir, prepared.watchId);
  assert.deepEqual(
    upgraded.callback_route?.capabilities,
    { wake: true, respond: true },
    "the immutable predecessor route is retained for backward readability"
  );
  assert.deepEqual(
    upgraded.notification_outbox[0].callback_route?.capabilities,
    { wake: true, respond: true }
  );
  assert.equal(
    Object.hasOwn(
      upgraded.notification_outbox[0].callback_envelope?.route ?? {},
      "capabilities"
    ),
    false
  );
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")).writer_protocol,
    STORE_WRITER_PROTOCOL
  );
});
