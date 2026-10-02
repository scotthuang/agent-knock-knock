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
  createTerminalWatchCallbackCliAdapter,
  resolveTerminalWatchOpenClawCallback,
  type TerminalWatchCallbackCliAdapter,
  type TerminalWatchCallbackInput
} from "../../src/terminal-watch-callback-cli-adapter.js";
import {
  createLegacyOpenClawCallbackRoute
} from "../../src/callback-transport.js";
import {
  loadTerminalWatch,
  pathsForTerminalWatch,
  terminalWatchCallbackEnvelope,
  terminalWatchNotificationId,
  terminalWatchNotificationIdempotencyKey
} from "../../src/terminal-watch-store.js";
import {
  exactTerminalObservation,
  createFixture,
  withCodexCandidateInventory,
  codexInventoryForTerminal,
  record
} from "./fixtures.js";

test("OpenClaw user-explicit fallback snapshots and delivers the Terminal Watch chat.send profile", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  let terminals = [fixture.terminal];
  const openclawSession = "agent:main:fallback-watch-profile";
  const openclawBin = "/opt/openclaw/bin/openclaw";
  const callback = createTerminalWatchCallbackCliAdapter({
    now: fixture.now,
    spawnSync(command, args) {
      calls.push({ command, args });
      const params = record(JSON.parse(String(args[4])));
      return {
        status: 0,
        stdout: JSON.stringify({
          runId: params.idempotencyKey,
          status: "started"
        }),
        stderr: ""
      };
    }
  });
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000297",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value),
    callback
  });
  const request = "Deliver this fallback request and report completion";
  const requestHash = createHash("sha256").update(request).digest("hex");
  const options = {
    storeDir: fixture.storeDir,
    openclawSession,
    gatewaySession: openclawSession,
    gatewayMethod: "agent-knock-knock.callback",
    openclawBin
  };
  assert.equal(
    await facade.prepareUserExplicitFallbackWatch({
      options: { ...options, gatewayUrl: "ws://gateway.example.test" },
      terminal: {
        conversationId: String(fixture.terminal.id),
        agent: "codex",
        pid: Number(fixture.terminal.pid),
        terminalControl: fixture.terminal.terminal_control as never
      },
      requestHash,
      messageId: "message-fallback-watch-custom-gateway",
      physicalToken: "8".repeat(64)
    }),
    undefined,
    "custom Gateway callbacks require an explicit Host route"
  );
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(fixture.terminal.id),
      agent: "codex",
      pid: Number(fixture.terminal.pid),
      terminalControl: fixture.terminal.terminal_control as never
    },
    requestHash,
    messageId: "message-fallback-watch-profile",
    physicalToken: "f".repeat(64)
  });
  assert.ok(prepared);
  assert.deepEqual(
    prepared.callbackRoute,
    resolveTerminalWatchOpenClawCallback({
      openclaw_session: openclawSession,
      openclaw_bin: openclawBin,
      interaction_policy: "respond_when_exact"
    }).route
  );
  assert.notEqual(
    prepared.callbackRoute.profile_revision,
    createLegacyOpenClawCallbackRoute({
      controllerSessionId: openclawSession,
      gatewayMethod: "agent-knock-knock.callback",
      openclawBin
    }).profile_revision
  );

  await facade.attachUserExplicitFallbackWatch({ options, prepared });
  const fallbackTurnId = "019f0000-0000-7000-8000-000000000297";
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
      },
      {
        timestamp: "2026-08-21T01:00:00.300Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: fallbackTurnId,
          last_agent_message: "Fallback completion reached its controller"
        }
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
  terminals = [];
  fixture.advance();
  await facade.runReconcileWatches(options);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, openclawBin);
  assert.deepEqual(calls[0].args.slice(0, 3), [
    "gateway", "call", "chat.send"
  ]);
  const params = record(JSON.parse(String(calls[0].args[4])));
  assert.equal(params.sessionKey, openclawSession);
  assert.equal(params.deliver, true);
  assert.match(String(params.message), /user-explicit unmanaged fallback/u);
  assert.match(
    String(params.message),
    /Fallback completion reached its controller/u
  );

  const settled = loadTerminalWatch(fixture.storeDir, prepared.watchId);
  assert.equal(settled.status, "completed");
  assert.equal(settled.notification_outbox.length, 1);
  assert.equal(settled.notification_outbox[0].status, "delivered");
  assert.equal(settled.notification_outbox[0].attempts, 1);
  assert.equal(
    params.idempotencyKey,
    settled.notification_outbox[0].idempotency_key
  );
  assert.equal(settled.notification_outbox[0].last_error_code, undefined);
  await facade.runWatchStatus({ ...options, watch: prepared.watchId });
  const publicWatch = record(record(printed.at(-1)).watch);
  assert.deepEqual(publicWatch.callback, {
    pending: 0,
    delivered: 1,
    failed: 0,
    superseded: 0
  });
  await facade.runReconcileWatches(options);
  assert.equal(calls.length, 1, "the callback idempotency key is delivered once");
});

test("legacy failed fallback callback is repaired and delivered once through chat.send", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  let terminals = [fixture.terminal];
  const openclawSession = "agent:main:legacy-fallback-recovery";
  const openclawBin = "/opt/openclaw/bin/openclaw";
  const options = {
    storeDir: fixture.storeDir,
    openclawSession,
    gatewaySession: openclawSession,
    gatewayMethod: "agent-knock-knock.callback",
    openclawBin
  };
  const facadeFor = (callback: TerminalWatchCallbackCliAdapter) =>
    createTerminalWatchCliAdapter({
      acquireFileLock: () => () => {},
      acquireTerminalLock: () => () => {},
      observeExactTerminal: async ({ terminalId }) =>
        exactTerminalObservation(terminals, terminalId),
      loadClaudeAgentRows: () => [],
      now: fixture.now,
      randomUUID: () => "00000000-0000-4000-8000-000000000296",
      storeDirFromOptions: () => fixture.storeDir,
      terminalDispatchOwnership: () => ({ state: "none" }),
      terminalIncarnationBlockingTurns: () => [],
      printJson: (value) => printed.push(value),
      callback
    });
  const seedingFacade = facadeFor({
    deliver() {
      throw new Error("legacy callback path must not run");
    },
    deliverTransport() {
      return {
        disposition: "permanent_failure",
        error_code: "openclaw_callback_profile_changed"
      };
    }
  });
  const request = "Recover this historical fallback completion callback";
  const prepared = await seedingFacade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(fixture.terminal.id),
      agent: "codex",
      pid: Number(fixture.terminal.pid),
      terminalControl: fixture.terminal.terminal_control as never
    },
    requestHash: createHash("sha256").update(request).digest("hex"),
    messageId: "message-legacy-fallback-recovery",
    physicalToken: "9".repeat(64)
  });
  assert.ok(prepared);
  await seedingFacade.attachUserExplicitFallbackWatch({ options, prepared });
  const fallbackTurnId = "019f0000-0000-7000-8000-000000000296";
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
      },
      {
        timestamp: "2026-08-21T01:00:00.300Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: fallbackTurnId,
          last_agent_message: "Historical fallback completion"
        }
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
  terminals = [];
  fixture.advance();
  await seedingFacade.runReconcileWatches(options);
  const failed = loadTerminalWatch(fixture.storeDir, prepared.watchId);
  assert.equal(failed.notification_outbox[0].status, "failed");
  assert.equal(
    failed.notification_outbox[0].last_error_code,
    "callback_permanent_openclaw_callback_profile_changed"
  );

  // Recreate the exact v0.12.19-v0.12.22 persisted bug shape. The failed
  // profile check occurred before any OpenClaw process invocation.
  const misrouted = createLegacyOpenClawCallbackRoute({
    controllerSessionId: openclawSession,
    gatewayMethod: "agent-knock-knock.callback",
    openclawBin
  });
  const legacy = structuredClone(failed);
  legacy.callback_route = misrouted;
  const legacyNotification = legacy.notification_outbox[0];
  legacyNotification.callback_route = misrouted;
  legacyNotification.next_attempt_at = fixture.now().toISOString();
  legacyNotification.callback_envelope = terminalWatchCallbackEnvelope(
    legacy,
    legacyNotification,
    misrouted
  );
  fs.writeFileSync(
    pathsForTerminalWatch(legacy.watch_id, fixture.storeDir).statePath,
    `${JSON.stringify(legacy)}\n`,
    { mode: 0o600 }
  );
  const originalIdentity = {
    notificationId: legacyNotification.notification_id,
    idempotencyKey: legacyNotification.idempotency_key
  };

  const calls: Array<{ command: string; args: string[] }> = [];
  const recoveryFacade = facadeFor(createTerminalWatchCallbackCliAdapter({
    now: fixture.now,
    spawnSync(command, args) {
      calls.push({ command, args });
      const params = record(JSON.parse(String(args[4])));
      return {
        status: 0,
        stdout: JSON.stringify({
          runId: params.idempotencyKey,
          status: "started"
        }),
        stderr: ""
      };
    }
  }));
  await recoveryFacade.runReconcileWatches({ storeDir: fixture.storeDir });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), [
    "gateway", "call", "chat.send"
  ]);
  const params = record(JSON.parse(String(calls[0].args[4])));
  assert.equal(params.idempotencyKey, originalIdentity.idempotencyKey);
  const recovered = loadTerminalWatch(fixture.storeDir, prepared.watchId);
  assert.equal(recovered.notification_outbox.length, 1);
  assert.equal(
    recovered.notification_outbox[0].notification_id,
    originalIdentity.notificationId
  );
  assert.equal(
    recovered.notification_outbox[0].idempotency_key,
    originalIdentity.idempotencyKey
  );
  assert.equal(recovered.notification_outbox[0].attempts, 2);
  assert.equal(recovered.notification_outbox[0].status, "delivered");
  await recoveryFacade.runWatchStatus({
    storeDir: fixture.storeDir,
    watch: prepared.watchId
  });
  assert.deepEqual(record(record(printed.at(-1)).watch).callback, {
    pending: 0,
    delivered: 1,
    failed: 0,
    superseded: 0
  });
  await recoveryFacade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(calls.length, 1);

  const permanentWatchId = "terminal-watch-legacy-profile-permanent";
  const permanentLegacy = structuredClone(legacy);
  permanentLegacy.watch_id = permanentWatchId;
  const permanentNotification = permanentLegacy.notification_outbox[0];
  permanentNotification.notification_id = terminalWatchNotificationId(
    permanentWatchId,
    permanentNotification.kind,
    permanentNotification.evidence_fingerprint
  );
  permanentNotification.idempotency_key =
    terminalWatchNotificationIdempotencyKey(
      permanentWatchId,
      permanentNotification.notification_id
    );
  permanentNotification.callback_envelope = terminalWatchCallbackEnvelope(
    permanentLegacy,
    permanentNotification,
    misrouted
  );
  fs.writeFileSync(
    pathsForTerminalWatch(permanentWatchId, fixture.storeDir).statePath,
    `${JSON.stringify(permanentLegacy)}\n`,
    { mode: 0o600 }
  );
  let permanentAttempts = 0;
  const permanentFacade = facadeFor({
    deliver() {
      throw new Error("legacy callback path must not run");
    },
    deliverTransport(input) {
      permanentAttempts += 1;
      assert.equal(
        input.route.profile_revision,
        resolveTerminalWatchOpenClawCallback({
          openclaw_session: openclawSession,
          openclaw_bin: openclawBin
        }).route.profile_revision
      );
      return {
        disposition: "permanent_failure",
        error_code: "openclaw_callback_delivery_disabled"
      };
    }
  });
  await permanentFacade.runReconcileWatches({ storeDir: fixture.storeDir });
  const permanentlyFailed = loadTerminalWatch(
    fixture.storeDir,
    permanentWatchId
  );
  assert.equal(permanentAttempts, 1);
  assert.equal(permanentlyFailed.notification_outbox[0].attempts, 2);
  assert.equal(
    permanentlyFailed.notification_outbox[0].last_error_code,
    "callback_permanent_openclaw_callback_delivery_disabled"
  );
  await permanentFacade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(
    permanentAttempts,
    1,
    "a repaired route receives only one extra chance after a new permanent failure"
  );
});

test("Codex fallback Watches freeze acceptance before a repeated request", async (t) => {
  const fixture = createFixture(t);
  const terminal = withCodexCandidateInventory(fixture.terminal);
  let terminals = [terminal];
  const callbacks: TerminalWatchCallbackInput[] = [];
  const callbackRoute = {
    schema: "agent-knock-knock/callback-route" as const,
    version: 1 as const,
    transport: "openclaw_gateway_v1" as const,
    profile_id: "openclaw",
    profile_revision: "legacy-v1",
    controller_session_id: "agent:main:candidate-fallback",
    capabilities: { wake: true, respond: true }
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000298",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });
  const request = "Bind this request across the exact Codex rollout set";
  const requestHash = createHash("sha256").update(request).digest("hex");
  const options = { storeDir: fixture.storeDir, callbackRoute };
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(terminal.id),
      agent: "codex",
      pid: Number(terminal.pid),
      terminalControl: terminal.terminal_control as never
    },
    requestHash,
    messageId: "message-candidate-fallback-watch",
    physicalToken: "e".repeat(64)
  });
  assert.ok(prepared);
  assert.equal(
    prepared.anchor.schema,
    "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  );
  if (
    prepared.anchor.schema !==
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    throw new Error("expected a Codex fallback Watch anchor");
  }
  assert.equal(prepared.anchor.acceptance_anchor.version, 3);

  const turnId = "019f0000-0000-7000-8000-000000000298";
  fs.appendFileSync(
    fixture.rolloutPath,
    [
      {
        timestamp: "2026-08-21T01:00:00.200Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId }
      },
      {
        timestamp: "2026-08-21T01:00:00.201Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: request }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.202Z",
        type: "event_msg",
        payload: { type: "user_message", message: request }
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
  await facade.attachUserExplicitFallbackWatch({ options, prepared });
  const repeatedPrepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(terminal.id),
      agent: "codex",
      pid: Number(terminal.pid),
      terminalControl: terminal.terminal_control as never
    },
    requestHash,
    messageId: "message-repeated-candidate-fallback-watch",
    physicalToken: "9".repeat(64)
  });
  assert.ok(repeatedPrepared);
  assert.equal(callbacks.length, 0);
  assert.equal(facade.listPublicWatches(fixture.storeDir)[0].status, "active");

  const repeatedTurnId = "019f0000-0000-7000-8000-000000000289";
  fs.appendFileSync(
    fixture.rolloutPath,
    [
      {
        timestamp: "2026-08-21T01:00:00.300Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turnId,
          last_agent_message: "Candidate-set fallback completion"
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.400Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: repeatedTurnId }
      },
      {
        timestamp: "2026-08-21T01:00:00.401Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: request }],
          internal_chat_message_metadata_passthrough: {
            turn_id: repeatedTurnId
          }
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.402Z",
        type: "event_msg",
        payload: { type: "user_message", message: request }
      },
      {
        timestamp: "2026-08-21T01:00:00.500Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: repeatedTurnId,
          last_agent_message: "Repeated candidate fallback completion"
        }
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
  await facade.attachUserExplicitFallbackWatch({
    options,
    prepared: repeatedPrepared
  });
  fixture.advance();
  await facade.runReconcileWatches(options);
  await facade.runReconcileWatches(options);

  assert.equal(callbacks.length, 2);
  assert.deepEqual(
    callbacks.map(({ event, completionText, detail }) => ({
      event,
      completionText,
      detail
    })),
    [
      {
        event: "completed",
        completionText: "Candidate-set fallback completion",
        detail: "anchored_task_completed"
      },
      {
        event: "completed",
        completionText: "Repeated candidate fallback completion",
        detail: "anchored_task_completed"
      }
    ]
  );
});

test("user-explicit fallback Watch binds the first Codex rollout after Send", async (t) => {
  const fixture = createFixture(t);
  const beforeTerminal: Record<string, any> = structuredClone(
    fixture.terminal
  );
  delete beforeTerminal.native_agent_session_id;
  delete beforeTerminal.native_agent_rollout;
  beforeTerminal._codex_open_root_rollout_inventory =
    codexInventoryForTerminal(beforeTerminal, []);
  let terminal = beforeTerminal;
  const callbacks: TerminalWatchCallbackInput[] = [];
  const callbackRoute = {
    schema: "agent-knock-knock/callback-route" as const,
    version: 1 as const,
    transport: "openclaw_gateway_v1" as const,
    profile_id: "openclaw",
    profile_revision: "legacy-v1",
    controller_session_id: "agent:main:virgin-fallback",
    capabilities: { wake: true, respond: true }
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000297",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });
  const request = "Create and bind the first Codex rollout";
  const options = { storeDir: fixture.storeDir, callbackRoute };
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(beforeTerminal.id),
      agent: "codex",
      pid: Number(beforeTerminal.pid),
      terminalControl: beforeTerminal.terminal_control as never
    },
    requestHash: createHash("sha256").update(request).digest("hex"),
    messageId: "message-virgin-fallback-watch",
    physicalToken: "f".repeat(64)
  });
  assert.ok(prepared);
  if (
    prepared.anchor.schema !==
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    throw new Error("expected a Codex fallback Watch anchor");
  }
  assert.equal(prepared.anchor.acceptance_anchor.version, 3);
  if (prepared.anchor.acceptance_anchor.version !== 3) {
    throw new Error("expected a candidate-set acceptance anchor");
  }
  assert.equal(prepared.anchor.acceptance_anchor.zero_file_baseline, true);

  const nativeThreadId = "019f0000-0000-7000-8000-000000000297";
  const turnId = "019f0000-0000-7000-8000-000000000296";
  const rolloutPath = path.join(
    path.dirname(fixture.rolloutPath),
    "first-rollout.jsonl"
  );
  fs.writeFileSync(
    rolloutPath,
    [
      {
        timestamp: "2026-08-21T01:00:00.150Z",
        type: "session_meta",
        payload: {
          id: nativeThreadId,
          timestamp: "2026-08-21T01:00:00.150Z",
          cwd: beforeTerminal.workspace,
          originator: "codex-tui",
          source: "cli",
          cli_version: beforeTerminal.agent_version
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.200Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId }
      },
      {
        timestamp: "2026-08-21T01:00:00.201Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: request }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.202Z",
        type: "event_msg",
        payload: { type: "user_message", message: request }
      },
      {
        timestamp: "2026-08-21T01:00:00.300Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turnId,
          last_agent_message: "First-rollout fallback completion"
        }
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    { mode: 0o600 }
  );
  const rolloutStat = fs.statSync(rolloutPath);
  const processUuid = String(beforeTerminal.native_agent_process_uuid);
  const processBirth = String(beforeTerminal.native_agent_process_birth);
  const rollout = {
    fd: "13r",
    device: String(rolloutStat.dev),
    inode: String(rolloutStat.ino),
    path: rolloutPath
  };
  terminal = {
    ...beforeTerminal,
    native_agent_session_id: nativeThreadId,
    native_agent_rollout: rollout,
    _codex_open_root_rollout_inventory: codexInventoryForTerminal(
      beforeTerminal,
      [{
        sessionId: nativeThreadId,
        processUuid,
        processBirth,
        rollout,
        evidence: "codex_open_root_rollout"
      }]
    )
  };

  await facade.attachUserExplicitFallbackWatch({ options, prepared });
  fixture.advance();
  await facade.runReconcileWatches(options);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event, "completed");
  assert.equal(
    callbacks[0].completionText,
    "First-rollout fallback completion"
  );
});
