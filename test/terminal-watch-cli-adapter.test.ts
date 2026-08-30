import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTerminalWatchCliAdapter } from
  "../src/terminal-watch-cli-adapter.js";
import {
  createTerminalWatchCallbackCliAdapter,
  resolveTerminalWatchOpenClawCallback,
  type TerminalWatchCallbackCliAdapter,
  type TerminalWatchCallbackInput
} from "../src/terminal-watch-callback-cli-adapter.js";
import type { Conversation } from "../src/protocol.js";
import {
  createLegacyOpenClawCallbackRoute,
  type CallbackTransportDeliverInput
} from "../src/callback-transport.js";
import {
  loadTerminalWatch,
  pathsForTerminalWatch,
  terminalWatchCallbackEnvelope,
  terminalWatchNotificationId,
  terminalWatchNotificationIdempotencyKey,
  terminalWatchesDir
} from "../src/terminal-watch-store.js";

const THREAD_ID = "019f0000-0000-7000-8000-000000000206";
const TASK_ID = "019f0000-0000-7000-8000-000000000207";
const TOKEN = "a".repeat(64);
type RootUserRowOrder = "human-only" | "synthetic-first" | "human-first";

test("user-explicit fallback attaches after terminal exit and recovers completion before its first sweep", async (t) => {
  const fixture = createFixture(t);
  const callbacks: TerminalWatchCallbackInput[] = [];
  const printed: unknown[] = [];
  let terminals = [fixture.terminal];
  const callbackRoute = {
    schema: "agent-knock-knock/callback-route" as const,
    version: 1 as const,
    transport: "openclaw_gateway_v1" as const,
    profile_id: "openclaw",
    profile_revision: "legacy-v1",
    controller_session_id: "agent:main:user-explicit",
    capabilities: { wake: true, respond: true }
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000299",
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
  const request = "User-explicit fallback request";
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
    messageId: "message-user-explicit-fallback-watch",
    physicalToken: "d".repeat(64)
  });
  assert.ok(prepared);

  const fallbackTurnId = "019f0000-0000-7000-8000-000000000299";
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
          last_agent_message: "Fallback Watch recovered exact completion"
        }
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n"
  );

  // The task may finish and the process may disappear in the narrow window
  // between Enter and callback attachment. The pre-Send anchor remains exact.
  terminals = [];
  const receipt = await facade.attachUserExplicitFallbackWatch({
    options,
    prepared
  });
  assert.deepEqual(receipt, {
    callback_expected: true,
    callback_mode: "terminal_watch",
    watch_id: prepared.watchId
  });
  const listed = facade.listPublicWatches(fixture.storeDir);
  assert.equal(listed.length, 1);
  assert.equal(
    listed[0].source,
    "terminal_user_explicit_fallback_watch"
  );

  fixture.advance();
  await facade.runReconcileWatches(options);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event, "completed");
  assert.equal(
    callbacks[0].completionText,
    "Fallback Watch recovered exact completion"
  );
  facade.runWatchStatus({ ...options, watch: prepared.watchId });
  const settled = record(record(printed.at(-1)).watch);
  assert.equal(settled.status, "completed");
  assert.equal(
    facade.userExplicitFallbackWatchReceipt({
      options,
      watchId: prepared.watchId
    })?.watch_id,
    prepared.watchId
  );
});

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
      openclaw_bin: openclawBin
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
  facade.runWatchStatus({ ...options, watch: prepared.watchId });
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
  recoveryFacade.runWatchStatus({
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

test("Claude fallback Watches freeze acceptance before a repeated request and survive terminal exit", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-terminal-watch-claude-fallback-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeHome = path.join(root, ".claude");
  const workspace = path.join(root, "workspace");
  const sessionId = "019f0000-0000-7000-8000-000000000295";
  const projectsDirectory = path.join(
    claudeHome,
    "projects",
    workspace.replace(/[^A-Za-z0-9]/gu, "-")
  );
  const transcriptPath = path.join(projectsDirectory, `${sessionId}.jsonl`);
  const storeDir = path.join(root, "store");
  fs.mkdirSync(projectsDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true });
  const pid = 6295;
  const startedAt = 1784870000000;
  const agentRows = [{
    pid,
    cwd: workspace,
    kind: "interactive" as const,
    sessionId,
    startedAt,
    status: "idle" as const
  }];
  const terminal: Record<string, any> = {
    id: "terminal:v2:claude:fallback-fixture",
    source: "terminal",
    agent: "claude",
    pid,
    workspace,
    cwd: workspace,
    native_agent_session_id: sessionId,
    agent_version: "2.1.237",
    lifecycle_binding_token: "c".repeat(64),
    activity_state: "idle",
    approval_state: { scanned: true, blocked: false, approvable: false },
    terminal_control: {
      kind: "tmux",
      target: "claude-fallback:0.0",
      session: "claude-fallback",
      window: 0,
      pane: 0,
      panePid: 6290,
      currentCommand: "claude",
      currentPath: workspace,
      capabilities: ["screen_status", "durable_completion"]
    }
  };
  let terminals = [terminal];
  let now = new Date("2026-08-21T01:00:00.100Z");
  const callbacks: TerminalWatchCallbackInput[] = [];
  const callbackRoute = {
    schema: "agent-knock-knock/callback-route" as const,
    version: 1 as const,
    transport: "openclaw_gateway_v1" as const,
    profile_id: "openclaw",
    profile_revision: "legacy-v1",
    controller_session_id: "agent:main:claude-fallback",
    capabilities: { wake: true, respond: true }
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => agentRows,
    now: () => new Date(now),
    randomUUID: () => "00000000-0000-4000-8000-000000000295",
    storeDirFromOptions: () => storeDir,
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
  const request = "Return this exact Claude fallback result";
  const requestHash = createHash("sha256").update(request).digest("hex");
  const options = { storeDir, claudeHome, callbackRoute };
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(terminal.id),
      agent: "claude",
      pid,
      terminalControl: terminal.terminal_control as never
    },
    requestHash,
    messageId: "message-claude-fallback-watch",
    physicalToken: "b".repeat(64)
  });
  assert.ok(prepared);
  assert.equal(
    prepared.anchor.schema,
    "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  );

  const promptUuid = "019f0000-0000-7000-8000-000000000294";
  const thinkingUuid = "019f0000-0000-7000-8000-000000000293";
  const textUuid = "019f0000-0000-7000-8000-000000000292";
  const durationUuid = "019f0000-0000-7000-8000-000000000291";
  const messageId = "019f0000-0000-7000-8000-000000000290";
  const base = (
    uuid: string,
    parentUuid: string | null,
    timestamp: string
  ) => ({
    uuid,
    parentUuid,
    isSidechain: false,
    entrypoint: "cli",
    timestamp,
    sessionId,
    version: terminal.agent_version,
    cwd: workspace
  });
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      ...base(promptUuid, null, "2026-08-21T01:00:00.200Z"),
      type: "user",
      promptId: "019f0000-0000-7000-8000-000000000289",
      message: { role: "user", content: request }
    })}\n`,
    { mode: 0o600 }
  );
  await facade.attachUserExplicitFallbackWatch({ options, prepared });
  const repeatedPrepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(terminal.id),
      agent: "claude",
      pid,
      terminalControl: terminal.terminal_control as never
    },
    requestHash,
    messageId: "message-repeated-claude-fallback-watch",
    physicalToken: "8".repeat(64)
  });
  assert.ok(repeatedPrepared);
  assert.equal(callbacks.length, 0);

  const repeatedPromptUuid = "019f0000-0000-7000-8000-000000000288";
  const repeatedTextUuid = "019f0000-0000-7000-8000-000000000286";
  const repeatedDurationUuid = "019f0000-0000-7000-8000-000000000285";
  const repeatedMessageId = "019f0000-0000-7000-8000-000000000284";
  fs.appendFileSync(
    transcriptPath,
    [
      {
        ...base(thinkingUuid, promptUuid, "2026-08-21T01:00:00.250Z"),
        type: "assistant",
        message: {
          role: "assistant",
          id: messageId,
          stop_reason: "end_turn",
          content: [{ type: "thinking", thinking: "not returned" }]
        }
      },
      {
        ...base(textUuid, thinkingUuid, "2026-08-21T01:00:00.300Z"),
        type: "assistant",
        message: {
          role: "assistant",
          id: messageId,
          stop_reason: "end_turn",
          content: [{
            type: "text",
            text: "Claude fallback completion"
          }]
        }
      },
      {
        ...base(durationUuid, textUuid, "2026-08-21T01:00:00.400Z"),
        type: "system",
        subtype: "turn_duration",
        durationMs: 200
      },
      {
        ...base(
          repeatedPromptUuid,
          null,
          "2026-08-21T01:00:00.500Z"
        ),
        type: "user",
        promptId: "019f0000-0000-7000-8000-000000000287",
        message: { role: "user", content: request }
      },
      {
        ...base(
          repeatedTextUuid,
          repeatedPromptUuid,
          "2026-08-21T01:00:00.600Z"
        ),
        type: "assistant",
        message: {
          role: "assistant",
          id: repeatedMessageId,
          stop_reason: "end_turn",
          content: [{
            type: "text",
            text: "Repeated Claude fallback completion"
          }]
        }
      },
      {
        ...base(
          repeatedDurationUuid,
          repeatedTextUuid,
          "2026-08-21T01:00:00.700Z"
        ),
        type: "system",
        subtype: "turn_duration",
        durationMs: 100
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  await facade.attachUserExplicitFallbackWatch({
    options,
    prepared: repeatedPrepared
  });
  terminals = [];
  now = new Date("2026-08-21T01:00:02.000Z");
  await facade.runReconcileWatches(options);
  await facade.runReconcileWatches(options);

  assert.equal(callbacks.length, 2);
  assert.deepEqual(
    callbacks.map(({ completionText }) => completionText).sort(),
    [
      "Claude fallback completion",
      "Repeated Claude fallback completion"
    ]
  );
});

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
  facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
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
  assert.deepEqual(deliveries[0].route, callbackRoute);
  assert.equal(
    deliveries[0].envelope.route.controller_session_id,
    "host-session-1"
  );
  assert.equal(deliveries[0].envelope.source.kind, "terminal_watch");
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
    facade.runWatchStatus({
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
  facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
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
  facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
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
  facade.runWatchStatus({
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
  facade.runWatchStatus({
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

  facade.runWatchStatus({
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

function exactTerminalObservation(
  terminals: Array<Record<string, unknown>>,
  terminalId: string,
  projectedTerminal?: Record<string, unknown>
) {
  const matches = terminals.filter((terminal) => terminal.id === terminalId);
  return matches.length === 1
    ? {
        state: "available" as const,
        rawTerminal: matches[0],
        terminal: projectedTerminal ?? matches[0],
        summary: {}
      }
    : { state: "absent" as const, summary: {} };
}

function createFixture(
  t: test.TestContext,
  rootUserRowOrder: RootUserRowOrder = "human-only",
  codexVersion = "0.148.0"
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-watch-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolloutPath = path.join(root, "rollout.jsonl");
  const request = "Human-started task";
  const humanRootUserRow = {
    timestamp: "2026-08-21T01:00:00.010Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: request }],
      internal_chat_message_metadata_passthrough: { turn_id: TASK_ID }
    }
  };
  const syntheticContextRow = {
    timestamp: rootUserRowOrder === "synthetic-first"
      ? "2026-08-21T01:00:00.009Z"
      : "2026-08-21T01:00:00.012Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `<environment_context>\n  <cwd>${root}</cwd>\n</environment_context>`
      }],
      internal_chat_message_metadata_passthrough: { turn_id: TASK_ID }
    }
  };
  const humanUserMessageEvent = {
    timestamp: "2026-08-21T01:00:00.011Z",
    type: "event_msg",
    payload: { type: "user_message", message: request }
  };
  const rootTaskRecords = rootUserRowOrder === "human-only"
    ? [humanRootUserRow, humanUserMessageEvent]
    : rootUserRowOrder === "synthetic-first"
      ? [syntheticContextRow, humanRootUserRow, humanUserMessageEvent]
      : [humanRootUserRow, humanUserMessageEvent, syntheticContextRow];
  fs.writeFileSync(
    rolloutPath,
    [
      {
        timestamp: "2026-08-21T00:59:59.000Z",
        type: "session_meta",
        payload: {
          id: THREAD_ID,
          timestamp: "2026-08-21T00:00:00.000Z",
          cwd: root,
          originator: "codex-tui",
          source: "cli",
          cli_version: codexVersion
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: TASK_ID }
      },
      ...rootTaskRecords
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    { mode: 0o600 }
  );
  const stat = fs.statSync(rolloutPath);
  let now = new Date("2026-08-21T01:00:00.100Z");
  const processBirth = "Fri Aug 21 08:59:00 2026";
  return {
    rolloutPath,
    storeDir: path.join(root, "store"),
    now: () => new Date(now),
    advance: () => {
      now = new Date("2026-08-21T01:00:02.000Z");
    },
    terminal: {
      id: "terminal:v2:watch-fixture",
      source: "terminal",
      agent: "codex",
      pid: 6206,
      workspace: root,
      cwd: root,
      native_agent_session_id: THREAD_ID,
      native_agent_process_uuid: `codex-pid:6206:birth:${processBirth}`,
      native_agent_process_birth: processBirth,
      native_agent_rollout: {
        fd: "12r",
        device: String(stat.dev),
        inode: String(stat.ino),
        path: rolloutPath
      },
      agent_version: codexVersion,
      native_thread_lifecycle: {
        status: "supported",
        behaviorProfile: codexVersion === "0.148.0"
          ? "codex-tui-0.148.0"
          : "codex-tui-generic-v1",
        versionCompatibility: codexVersion === "0.148.0"
          ? "verified"
          : "unverified",
        ...(codexVersion === "0.148.0"
          ? {}
          : {
              compatibilityWarning:
                `Codex ${codexVersion} has not been regression-tested by AKK`
            })
      },
      lifecycle_binding_token: TOKEN,
      activity_state: "working",
      approval_state: { blocked: false, approvable: false },
      terminal_control: {
        kind: "tmux",
        target: "watch-session:0.0",
        session: "watch-session",
        window: 0,
        pane: 0,
        panePid: 6200,
        currentCommand: "codex",
        currentPath: root,
        capabilities: ["screen_status", "durable_completion"]
      },
      available_actions: {
        watch: {
          tool: "agent_knock_knock_watch",
          arguments: {
            terminal_id: "terminal:v2:watch-fixture"
          },
          ...(codexVersion === "0.148.0"
            ? {}
            : {
                compatibility_warning:
                  `Codex ${codexVersion} has not been regression-tested by AKK`
              }),
          requires_user_intent: true,
          use: "Monitor this human-started external task."
        }
      }
    }
  };
}

function withCodexCandidateInventory(
  terminal: Record<string, any>
): Record<string, any> {
  const processUuid = String(terminal.native_agent_process_uuid);
  const processBirth = String(terminal.native_agent_process_birth);
  const rollout = structuredClone(record(terminal.native_agent_rollout));
  return {
    ...terminal,
    _codex_open_root_rollout_inventory: codexInventoryForTerminal(
      terminal,
      [{
        sessionId: String(terminal.native_agent_session_id),
        processUuid,
        processBirth,
        rollout,
        evidence: "codex_open_root_rollout" as const
      }]
    )
  };
}

function codexInventoryForTerminal(
  terminal: Record<string, any>,
  roots: Array<Record<string, unknown>>
) {
  const authority = {
    schema: "agent-knock-knock/codex-open-root-rollout-inventory" as const,
    version: 1 as const,
    pid: Number(terminal.pid),
    processUuid: String(terminal.native_agent_process_uuid),
    processBirth: String(terminal.native_agent_process_birth),
    roots
  };
  return {
    ...authority,
    status: roots.length === 0 ? "verified_absent" as const :
      "resolved" as const,
    inventoryFingerprint: createHash("sha256")
      .update(JSON.stringify(authority))
      .digest("hex")
  };
}

function managedTurn(): Conversation {
  return {
    session_id: "session-managed-206",
    turn_id: "turn-managed-206",
    conversation_id: "turn-managed-206",
    user_request: "managed request",
    openclaw_session: "agent:main:main",
    claude_session: "",
    executor: { kind: "codex" },
    workspace: "/tmp/managed-watch",
    status: "running",
    response_rounds_used: 0,
    soft_limit: 10,
    hard_limit: 20,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:01.000Z"
  } as Conversation;
}

function record(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}
