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
  type TerminalWatchCallbackInput
} from "../../src/terminal-watch-callback-cli-adapter.js";
import {
  createTerminalWatchOpenClawCallbackRoute,
  type CallbackTransportDeliverInput
} from "../../src/callback-transport.js";
import {
  loadTerminalWatch,
  terminalWatchCallbackEnvelope
} from "../../src/terminal-watch-store.js";
import {
  createCodexPaginatedTaskAnchor
} from "../../src/codex-paginated-task.js";
import {
  THREAD_ID,
  TASK_ID,
  CODEX_FALLBACK_QUESTION_ONE,
  CODEX_FALLBACK_QUESTION_TWO,
  exactTerminalObservation,
  withTerminalWatchScreen,
  createFixture,
  record
} from "./fixtures.js";

for (const agent of ["codex", "claude"] as const) {
  test(`${agent} automatic Send falls back to a post-dispatch activity epoch without exact task or answer authority`, async (t) => {
    const fixture = createFixture(t, "human-only", "0.159.2");
    const callbacks: TerminalWatchCallbackInput[] = [];
    let terminal: Record<string, any> = {
      ...fixture.terminal, agent,
      agent_version: agent === "codex" ? "0.159.2" : "2.1.999",
      native_agent_session_id: undefined, native_agent_rollout: undefined,
      activity_state: "working"
    };
    let exactAttempts = 0;
    const facade = createTerminalWatchCliAdapter({
      acquireFileLock: () => () => {}, acquireTerminalLock: () => () => {},
      observeExactTerminal: async ({ terminalId }) => exactTerminalObservation([terminal], terminalId),
      loadClaudeAgentRows: () => [], now: fixture.now,
      randomUUID: () => "00000000-0000-4000-8000-000000000421",
      storeDirFromOptions: () => fixture.storeDir,
      terminalDispatchOwnership: () => ({ state: "none" }), terminalIncarnationBlockingTurns: () => [],
      printJson: () => {},
      capturePaginatedAnchor: async () => {
        exactAttempts += 1;
        throw new Error("app-server protocol capability unavailable");
      },
      callback: { deliver(input) { callbacks.push(input); return { runId: input.idempotencyKey, status: "started" }; } }
    });
    const options = { storeDir: fixture.storeDir,
      callbackRoute: createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: "agent:main:activity-send", respond: true }) };
    const prepared = await facade.prepareUserExplicitFallbackWatch({ options,
      terminal: { conversationId: terminal.id, agent, pid: terminal.pid, terminalControl: terminal.terminal_control },
      requestHash: "d".repeat(64), messageId: "automatic-activity", physicalToken: "c".repeat(64) });
    assert.ok(prepared);
    assert.equal(exactAttempts, agent === "codex" ? 1 : 0, "provider-specific exact observation is attempted first");
    assert.equal(prepared.anchor.schema, "agent-knock-knock/terminal-activity-watch-anchor");
    assert.deepEqual(facade.listPublicWatches(fixture.storeDir), [], "capture cannot attach a callback before task dispatch");
    assert.match(prepared.warnings!.join("\n"), /exact_task_anchor_unavailable[\s\S]*terminal_activity_fallback/u);
    assert.equal(prepared.callbackRoute.capabilities?.respond, false);

    // The preceding pane was already working, but that is not proof of work
    // caused by this Send. Attachment and repeated idle samples stay pending.
    terminal = { ...terminal, activity_state: "idle" };
    const receipt = await facade.attachUserExplicitFallbackWatch({ options, prepared });
    assert.equal(receipt.watch_mode, "terminal_activity");
    assert.equal(receipt.confidence, "best_effort");
    assert.deepEqual(await facade.attachUserExplicitFallbackWatch({ options, prepared }), receipt);
    assert.deepEqual(facade.userExplicitFallbackWatchReceipt({ options, watchId: prepared.watchId }), receipt);
    for (let i = 0; i < 3; i += 1) await facade.runReconcileWatches(options);
    assert.equal(callbacks.length, 0, "idle without post-Send activity is not completion");
    assert.equal(loadTerminalWatch(fixture.storeDir, prepared.watchId).interaction_policy, "notify_only");
    terminal = { ...terminal, activity_state: "working" };
    await facade.runReconcileWatches(options);
    terminal = { ...terminal, activity_state: "idle" };
    await facade.runReconcileWatches(options);
    assert.equal(callbacks.length, 0, "one idle sample cannot settle an activity epoch");
    await facade.runReconcileWatches(options);
    await facade.runReconcileWatches(options);
    assert.equal(callbacks.length, 1, "stable idle notification is idempotent");
    assert.equal(callbacks[0].origin, "terminal_activity_fallback");
    assert.equal(callbacks[0].completionText, undefined);
    const settled = loadTerminalWatch(fixture.storeDir, prepared.watchId);
    assert.equal(settled.settlement?.reason_code, "terminal_activity_became_stably_idle");
    assert.equal(settled.settlement?.completion_id, undefined);
    const envelope = terminalWatchCallbackEnvelope(settled, settled.notification_outbox[0], prepared.callbackRoute);
    assert.equal(envelope.event.metadata?.watch_mode, "terminal_activity");
    assert.equal(envelope.event.metadata?.confidence, "best_effort");
    assert.match(envelope.event.body, /not an exact task completion proof/u);
  });
}

test("automatic activity fallback refuses missing or changed physical identity and uncertain native probes", async (t) => {
  for (const failure of ["no-process", "observation-unavailable", "changed-process", "changed-endpoint", "no-screen", "uncertain-probe", "unsafe-composer"]) {
    await t.test(failure, async (nested) => {
      const fixture = createFixture(nested, "human-only", "0.159.2");
      let observations = 0;
      const terminal: Record<string, any> = { ...fixture.terminal, native_agent_rollout: undefined,
        ...(failure === "no-process" ? { native_agent_process_uuid: undefined } : {}),
        ...(failure === "no-screen" ? { terminal_control: { ...fixture.terminal.terminal_control, capabilities: [] } } : {}) };
      const facade = createTerminalWatchCliAdapter({
        acquireFileLock: () => () => {}, acquireTerminalLock: () => () => {},
        observeExactTerminal: async ({ terminalId }) => {
          observations += 1;
          if (observations > 1 && failure === "observation-unavailable") return { state: "unavailable", summary: {} };
          const current = observations > 1 && failure === "changed-process"
            ? { ...terminal, native_agent_process_birth: "different birth" }
            : observations > 1 && failure === "changed-endpoint"
              ? { ...terminal, terminal_control: { ...terminal.terminal_control, panePid: 7777 } }
              : terminal;
          return exactTerminalObservation([current], terminalId);
        },
        loadClaudeAgentRows: () => [], now: fixture.now, randomUUID: () => "00000000-0000-4000-8000-000000000422",
        storeDirFromOptions: () => fixture.storeDir, terminalDispatchOwnership: () => ({ state: "none" }),
        terminalIncarnationBlockingTurns: () => [], printJson: () => {},
        capturePaginatedAnchor: async () => {
          throw Object.assign(new Error("exact probe unavailable"),
            failure === "uncertain-probe" ? { doNotRetry: true } :
            failure === "unsafe-composer" ? { diagnostic: "composer_not_ready" } : {});
        }
      });
      await assert.rejects(() => facade.prepareUserExplicitFallbackWatch({
        options: { callbackRoute: createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: "agent:main:safety" }) },
        terminal: { conversationId: terminal.id, agent: "codex", pid: terminal.pid, terminalControl: terminal.terminal_control },
        requestHash: "d".repeat(64), messageId: "unsafe-activity", physicalToken: "c".repeat(64)
      }));
      assert.deepEqual(facade.listPublicWatches(fixture.storeDir), []);
      if (failure === "uncertain-probe" || failure === "unsafe-composer") {
        assert.equal(observations, 1, "unsafe native input cannot be reinterpreted as an observation-only fallback");
      }
    });
  }
});

for (const version of ["0.158.0", "0.159.0", "0.159.2"] as const) {
  test(`paginated ${version} Send retains an exact callback across terminal exit and callback replay`, async (t) => {
    const fixture = createFixture(t, "human-only", version);
    const callbacks: TerminalWatchCallbackInput[] = [];
    let terminals: Record<string, unknown>[] = [{ ...fixture.terminal, native_agent_rollout: undefined }];
    let completed = false;
    const request = "Exact paginated task";
    const requestHash = createHash("sha256").update(request).digest("hex");
    const nativeAnchor = createCodexPaginatedTaskAnchor({
      origin: "user_explicit_send", captured_at: fixture.now().toISOString(),
      codex_home: "/codex", codex_version: version, native_thread_id: THREAD_ID,
      process_uuid: fixture.terminal.native_agent_process_uuid,
      process_birth: fixture.terminal.native_agent_process_birth, pid: fixture.terminal.pid,
      request_hash: requestHash
    });
    const facade = createTerminalWatchCliAdapter({
      acquireFileLock: () => () => {}, acquireTerminalLock: () => () => {},
      observeExactTerminal: async ({ terminalId }) => exactTerminalObservation(terminals, terminalId),
      loadClaudeAgentRows: () => [], now: fixture.now,
      randomUUID: () => "00000000-0000-4000-8000-000000000300",
      storeDirFromOptions: () => fixture.storeDir,
      terminalDispatchOwnership: () => ({ state: "none" }), terminalIncarnationBlockingTurns: () => [],
      printJson: () => {}, capturePaginatedAnchor: async (input) => {
        assert.equal(input.requestHash, requestHash, "native whitespace normalization precedes anchoring");
        return nativeAnchor;
      },
      readPaginatedSnapshot: async () => ({
        codexHome: "/codex", serverVersion: version, completeToBoundary: true,
        thread: { id: THREAD_ID, sessionId: THREAD_ID, cwd: fixture.terminal.workspace,
          historyMode: "paginated", cliVersion: version, originator: "codex-tui",
          source: "vscode", status: { type: completed ? "idle" : "active", activeFlags: [] }, turns: [] },
        turns: [{ id: TASK_ID, status: completed ? "completed" : "inProgress", itemsView: "full",
          startedAt: 1787274001, completedAt: completed ? 1787274002 : null,
          durationMs: completed ? 1000 : null, error: null,
          items: [{ id: "user-exact", type: "userMessage", content: [{ type: "text", text: request }] },
            ...(completed ? [{ id: "final-exact", type: "agentMessage", phase: "final_answer", text: "Paginated result" }] : [])] }]
      }),
      callback: { deliver(input) { callbacks.push(input); return { runId: input.idempotencyKey, status: "started" }; } }
    });
    const options = { storeDir: fixture.storeDir, openclawSession: "agent:main:paginated",
      callbackRoute: createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: "agent:main:paginated", respond: true }) };
    const prepared = await facade.prepareUserExplicitFallbackWatch({ options,
      terminal: { conversationId: fixture.terminal.id, agent: "codex", pid: fixture.terminal.pid,
        terminalControl: fixture.terminal.terminal_control as never },
      requestHash: createHash("sha256").update("  " + request).digest("hex"), requestText: "  " + request + "\r\n",
      messageId: "paginated-send", physicalToken: "c".repeat(64) });
    assert.ok(prepared);
    const receipt = await facade.attachUserExplicitFallbackWatch({ options, prepared });
    assert.equal(receipt.watch_mode, "exact_task");
    await facade.runReconcileWatches(options);
    assert.equal(callbacks.length, 0);
    const accepted = loadTerminalWatch(fixture.storeDir, prepared.watchId);
    assert.equal(record(accepted.observation_checkpoint).acceptance_evidence.source, "codex_paginated");
    completed = true;
    terminals = [];
    fixture.advance();
    await facade.runReconcileWatches(options);
    await facade.runReconcileWatches(options);
    assert.equal(callbacks.length, 1, "native completion is delivered once despite terminal exit and repeated sweeps");
    const settled = loadTerminalWatch(fixture.storeDir, prepared.watchId);
    assert.equal(settled.status, "completed");
    assert.equal(settled.settlement?.completion_id, TASK_ID);
    assert.equal(settled.settlement?.completion_text, "Paginated result");
    assert.deepEqual(facade.userExplicitFallbackWatchReceipt({ options, watchId: prepared.watchId }), receipt);
    assert.equal(facade.listPublicWatches(fixture.storeDir, { includeAll: true })[0].source, "terminal_user_explicit_fallback_watch");
  });

}

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
  assert.deepEqual(
    prepared.callbackRoute.capabilities,
    { wake: true, respond: true },
    "a new exact fallback Watch preserves its trusted response-capable route"
  );

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
    watch_id: prepared.watchId,
    watch_mode: "exact_task",
    confidence: "exact"
  });
  const listed = facade.listPublicWatches(fixture.storeDir);
  assert.equal(listed.length, 1);
  assert.equal(
    listed[0].source,
    "terminal_user_explicit_fallback_watch"
  );
  assert.deepEqual(
    loadTerminalWatch(fixture.storeDir, prepared.watchId)?.callback_route
      ?.capabilities,
    { wake: true, respond: true }
  );

  fixture.advance();
  await facade.runReconcileWatches(options);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event, "completed");
  assert.equal(
    callbacks[0].completionText,
    "Fallback Watch recovered exact completion"
  );
  await facade.runWatchStatus({ ...options, watch: prepared.watchId });
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

test("accepted unmanaged fallback notifies each Codex questionnaire once without response authority", async (t) => {
  const fixture = createFixture(t, "human-only", "0.153.4");
  const deliveries: CallbackTransportDeliverInput[] = [];
  let terminal: Record<string, any> = fixture.terminal;
  const callbackRoute = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: "agent:main:fallback-questionnaire",
    openclawBin: "/opt/openclaw/bin/openclaw"
  });
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000298",
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
  const request = "Ask two harmless native questions";
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
    messageId: "message-fallback-questionnaire",
    physicalToken: "9".repeat(64)
  });
  assert.ok(prepared);
  await facade.attachUserExplicitFallbackWatch({ options, prepared });

  terminal = withTerminalWatchScreen(
    fixture.terminal,
    CODEX_FALLBACK_QUESTION_ONE
  );
  fixture.advance();
  await facade.runReconcileWatches(options);
  assert.equal(
    deliveries.length,
    0,
    "a visible questionnaire cannot notify before exact request acceptance"
  );

  const fallbackTurnId = "019f0000-0000-7000-8000-000000000298";
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

  await facade.runReconcileWatches(options);
  assert.equal(deliveries.length, 1);
  const first = deliveries[0];
  assert.equal(first.envelope.event.type, "interaction_manual_required");
  assert.deepEqual(first.route.capabilities, { wake: true, respond: false });
  assert.deepEqual(first.envelope.event.metadata?.manual_interaction, {
    kind: "questionnaire",
    response_kind: "single_select",
    required: true,
    current_step: 1,
    total_steps: 2,
    parser_status: "actionable",
    prompt: "Choose a framework.",
    options: [
      { label: "React", description: "Component model." },
      { label: "Vue", description: "Progressive framework." }
    ]
  });
  assert.doesNotMatch(
    JSON.stringify(first.envelope),
    /prompt_evidence|exact_region|action_plan|prompt_fingerprint|option_id|"key"/u
  );

  terminal = withTerminalWatchScreen(
    fixture.terminal,
    CODEX_FALLBACK_QUESTION_ONE
      .replace("› 1. React", "  1. React")
      .replace("  2. Vue", "› 2. Vue")
  );
  await facade.runReconcileWatches(options);
  assert.equal(
    deliveries.length,
    1,
    "moving the native cursor does not create a new logical question"
  );

  terminal = withTerminalWatchScreen(
    {
      ...fixture.terminal,
      native_agent_rollout: {
        ...record(fixture.terminal.native_agent_rollout),
        fd: "41r"
      }
    },
    CODEX_FALLBACK_QUESTION_TWO
  );
  await facade.runReconcileWatches(options);
  assert.equal(deliveries.length, 2);
  assert.equal(
    deliveries[1].envelope.event.metadata?.manual_interaction &&
      record(deliveries[1].envelope.event.metadata?.manual_interaction)
        .current_step,
    2
  );
});
