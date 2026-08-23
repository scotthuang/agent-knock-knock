import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenClawCallbackTransport,
  type CallbackProcessDeliveryObservation,
  type CallbackSpawnResult,
  type CallbackSpawnSync,
  type DeliverOpenClawCallbackInput
} from "../src/openclaw-callback-transport.js";
import {
  createCallbackEnvelope,
  createLegacyOpenClawCallbackRoute,
  type CallbackAttemptOutcome,
  type CallbackTransportDeliverInput
} from "../src/callback-transport.js";
import {
  createConversation,
  createMessage,
  type AgentMessage,
  type Conversation
} from "../src/protocol.js";

const BASE_TIME_MS = Date.parse("2026-08-14T08:00:00.000Z");

interface SpawnCall {
  command: string;
  args: string[];
  options: Parameters<CallbackSpawnSync>[2];
}

interface TransportHarness {
  transport: ReturnType<typeof createOpenClawCallbackTransport>;
  conversation: Conversation;
  message: AgentMessage;
  observations: CallbackProcessDeliveryObservation[];
  spawnCalls: SpawnCall[];
  trace: string[];
  environment: NodeJS.ProcessEnv;
  input(
    options?: Partial<DeliverOpenClawCallbackInput["options"]>,
    callbacks?: Pick<
      DeliverOpenClawCallbackInput,
      "onAccepted" | "onProgress"
    >
  ): DeliverOpenClawCallbackInput;
}

function genericInput(
  harness: TransportHarness,
  overrides: Partial<CallbackTransportDeliverInput> = {}
): CallbackTransportDeliverInput {
  const route = createLegacyOpenClawCallbackRoute({
    controllerSessionId: "agent:main:gateway",
    gatewayMethod: "agent.callback",
    openclawBin: "/callback/bin/openclaw",
    gatewayUrl: "ws://127.0.0.1:18789"
  });
  return {
    route,
    envelope: createCallbackEnvelope({
      route,
      deliveryId: "callback-delivery-transport",
      idempotencyKey: "callback-idempotency-transport",
      source: {
        kind: "managed_turn",
        session_id: "session-transport",
        turn_id: "turn-transport",
        conversation_id: "turn-transport"
      },
      event: {
        id: harness.message.id,
        type: harness.message.type,
        body: harness.message.body,
        requires_response: harness.message.requires_response
      }
    }),
    attempt: { number: 1, id: "attempt-transport" },
    context: {
      statePath: "/store/turn/state.json",
      logPath: "/store/turn/events.ndjson",
      conversation: harness.conversation,
      message: harness.message,
      legacyOptions: {
        gatewayMethod: "agent.callback",
        gatewaySession: "agent:main:gateway",
        openclawSession: "agent:main:gateway",
        openclawBin: "/callback/bin/openclaw",
        gatewayUrl: "ws://127.0.0.1:18789",
        token: "callback-token"
      }
    },
    ...overrides
  };
}

function terminalWatchGenericInput(
  overrides: Partial<CallbackTransportDeliverInput> = {}
): CallbackTransportDeliverInput {
  const controllerSessionId = "agent:main:terminal-watch";
  const openclawBin = "/callback/bin/openclaw-terminal-watch";
  const route = {
    ...createLegacyOpenClawCallbackRoute({
      controllerSessionId,
      gatewayMethod: "chat.send",
      openclawBin
    }),
    capabilities: { wake: true, respond: false }
  };
  return {
    route,
    envelope: createCallbackEnvelope({
      route,
      deliveryId: "terminal-watch-notification-transport",
      idempotencyKey:
        "agent-knock-knock:terminal-watch:watch-transport:notification-1",
      source: {
        kind: "terminal_watch",
        watch_id: "terminal-watch-transport",
        terminal_id: "terminal:v2:transport"
      },
      event: {
        id: "terminal-watch-notification-transport",
        type: "completed",
        body: "bounded Terminal Watch completion",
        requires_response: true
      }
    }),
    attempt: { number: 2, id: "attempt-terminal-watch-2" },
    context: {
      legacyOptions: {
        gatewayMethod: "chat.send",
        gatewaySession: controllerSessionId,
        openclawBin
      }
    },
    ...overrides
  };
}

function processResult(
  stdout: unknown,
  overrides: Partial<CallbackSpawnResult> = {}
): CallbackSpawnResult {
  return {
    status: 0,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
    ...overrides
  };
}

function createHarness(
  processResults: Array<CallbackSpawnResult | Error>
): TransportHarness {
  const conversation = createConversation({
    userRequest: "transport extraction",
    sessionId: "session-transport",
    turnId: "turn-transport",
    openclawSession: "agent:main:transport",
    executorKind: "claude",
    executorSession: "claude-transport",
    now: new Date(BASE_TIME_MS)
  });
  const message = createMessage({
    conversation,
    id: "callback-message-transport",
    from: "claude-code",
    to: "openclaw",
    type: "done",
    body: "finished",
    requiresResponse: false,
    now: new Date(BASE_TIME_MS + 1)
  });
  const observations: CallbackProcessDeliveryObservation[] = [];
  const spawnCalls: SpawnCall[] = [];
  const trace: string[] = [];
  const environment = {
    PATH: "/callback/bin",
    OPENCLAW_GATEWAY_TOKEN: "ambient-token"
  };
  let nowOffset = 0;
  const queue = [...processResults];
  const transport = createOpenClawCallbackTransport({
    now() {
      return new Date(BASE_TIME_MS + nowOffset++ * 1_000);
    },
    environment() {
      return environment;
    },
    redactConversation(value) {
      return {
        conversation_id: value.conversation_id,
        gateway_token: "<redacted-by-port>"
      };
    },
    recordCallbackProcessDelivery(observation) {
      observations.push(observation);
      trace.push(`record:${observation.event}`);
    },
    spawnSync(command, args, options) {
      spawnCalls.push({ command, args, options });
      trace.push(`spawn:${args[2]}`);
      const result = queue.shift();
      assert.ok(result, `missing process result for ${args[2]}`);
      if (result instanceof Error) throw result;
      return result;
    }
  });

  return {
    transport,
    conversation,
    message,
    observations,
    spawnCalls,
    trace,
    environment,
    input(options = {}, callbacks = {}) {
      return {
        options: {
          gatewayMethod: "agent.callback",
          openclawBin: "/callback/bin/openclaw",
          gatewayUrl: "ws://127.0.0.1:18789",
          token: "callback-token",
          gatewaySession: "agent:main:gateway",
          ...options
        },
        statePath: "/store/turn/state.json",
        logPath: "/store/turn/events.ndjson",
        conversation,
        message,
        attempt: { number: 1, id: "attempt-a" },
        ...callbacks
      };
    }
  };
}

function gatewayPlan(
  plan: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ok: true,
    enqueued: true,
    injection_id: "injection-1",
    delivery_required: true,
    delivery_mode: "chat.send",
    chat_send: {
      sessionKey: "agent:main:gateway",
      message: "wake the agent",
      idempotencyKey: "run-1",
      deliver: true
    },
    ...plan
  };
}

test("gateway method preserves payload, redaction, process limits, and token env", () => {
  const harness = createHarness([processResult("gateway-output")]);
  const result = harness.transport.deliverGatewayMethod({
    method: "agent.callback",
    openclawBin: "/custom/openclaw",
    gatewayUrl: "ws://gateway.test",
    token: "explicit-token",
    sessionKey: "agent:main:selected",
    statePath: "/store/state.json",
    logPath: "/store/events.ndjson",
    conversation: harness.conversation,
    message: harness.message
  });

  assert.deepEqual(result, {
    status: 0,
    stdout: "gateway-output",
    stderr: ""
  });
  assert.equal(harness.spawnCalls.length, 1);
  const call = harness.spawnCalls[0];
  assert.equal(call.command, "/custom/openclaw");
  assert.deepEqual(call.args.slice(0, 4), [
    "gateway",
    "call",
    "agent.callback",
    "--params"
  ]);
  assert.deepEqual(call.args.slice(-3), [
    "--json",
    "--url",
    "ws://gateway.test"
  ]);
  assert.deepEqual(JSON.parse(call.args[4]), {
    sessionKey: "agent:main:selected",
    session_id: "session-transport",
    turn_id: "turn-transport",
    statePath: "/store/state.json",
    logPath: "/store/events.ndjson",
    conversation: {
      conversation_id: "turn-transport",
      gateway_token: "<redacted-by-port>"
    },
    message: harness.message
  });
  assert.deepEqual(
    {
      encoding: call.options.encoding,
      maxBuffer: call.options.maxBuffer,
      timeout: call.options.timeout,
      killSignal: call.options.killSignal
    },
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      killSignal: "SIGKILL"
    }
  );
  assert.deepEqual(call.options.env, {
    PATH: "/callback/bin",
    OPENCLAW_GATEWAY_TOKEN: "explicit-token"
  });
  assert.equal(
    harness.environment.OPENCLAW_GATEWAY_TOKEN,
    "ambient-token",
    "token injection must not mutate the execution environment"
  );
});

test("placeholder tokens preserve the execution environment by reference", () => {
  const harness = createHarness([processResult({ ok: true })]);
  harness.transport.deliverChatSend({
    params: { idempotencyKey: "run-placeholder" },
    token: "<token>"
  });

  const call = harness.spawnCalls[0];
  assert.equal(call.command, "openclaw");
  assert.equal(call.options.env, harness.environment);
  assert.deepEqual(call.args, [
    "gateway",
    "call",
    "chat.send",
    "--params",
    JSON.stringify({ idempotencyKey: "run-placeholder" }),
    "--json"
  ]);
});

test("chat wake keeps accepted, progress, record, and agent wait order", () => {
  const harness = createHarness([
    processResult(gatewayPlan()),
    processResult({ runId: "run-1", status: "started" }),
    processResult({
      runId: "run-1",
      status: "ok",
      stopReason: "completed",
      timeoutPhase: "none",
      providerStarted: true
    })
  ]);
  const result = harness.transport.deliverCallback(harness.input({}, {
    onAccepted(outcome) {
      harness.trace.push(`accepted:${String(outcome.wake.status)}`);
    },
    onProgress(progress) {
      harness.trace.push(`progress:${String(progress.stage)}`);
    }
  }));

  assert.deepEqual(harness.trace, [
    "spawn:agent.callback",
    "accepted:not_attempted",
    "progress:gateway_injection",
    "record:callback_gateway_method_delivery",
    "spawn:chat.send",
    "accepted:accepted",
    "record:callback_chat_send_delivery",
    "progress:wake_accepted",
    "spawn:agent.wait",
    "record:callback_agent_wait_delivery",
    "accepted:accepted",
    "progress:agent_run_observed"
  ]);
  assert.deepEqual(result, {
    kind: "gateway_method+chat_send",
    injection: {
      status: "accepted",
      enqueued: true,
      injection_id: "injection-1",
      accepted_at: "2026-08-14T08:00:00.000Z",
      evidence: "next_turn_injection_enqueued"
    },
    wake: {
      status: "accepted",
      mode: "chat.send",
      run_id: "run-1",
      acknowledgement_status: "started",
      idempotency_key: "run-1",
      accepted_at: "2026-08-14T08:00:01.000Z"
    },
    run_observation: {
      status: "ok",
      run_id: "run-1",
      observed_at: "2026-08-14T08:00:02.000Z",
      stop_reason: "completed",
      timeout_phase: "none",
      provider_started: true
    }
  });
  assert.deepEqual(
    harness.spawnCalls.map((call) => ({
      method: call.args[2],
      timeout: call.options.timeout,
      maxBuffer: call.options.maxBuffer,
      killSignal: call.options.killSignal
    })),
    [
      {
        method: "agent.callback",
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        killSignal: "SIGKILL"
      },
      {
        method: "chat.send",
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        killSignal: "SIGKILL"
      },
      {
        method: "agent.wait",
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        killSignal: "SIGKILL"
      }
    ]
  );
  assert.deepEqual(JSON.parse(harness.spawnCalls[2].args[4]), {
    runId: "run-1",
    timeoutMs: 20_000
  });
  assert.deepEqual(harness.spawnCalls[2].args.slice(5), [
    "--json",
    "--timeout",
    "25000",
    "--url",
    "ws://127.0.0.1:18789"
  ]);
});

test("sessions.send acknowledgements can complete without agent.wait", () => {
  const harness = createHarness([
    processResult(gatewayPlan({
      delivery_mode: "sessions.send",
      chat_send: undefined,
      session_send: {
        key: "agent:main:gateway",
        message: "wake the agent",
        idempotencyKey: "session-run-1"
      }
    })),
    processResult({ runId: "session-run-1", status: "ok" })
  ]);
  const result = harness.transport.deliverCallback(harness.input());

  assert.deepEqual(
    harness.spawnCalls.map((call) => call.args[2]),
    ["agent.callback", "sessions.send"]
  );
  assert.equal(result.kind, "gateway_method+sessions_send");
  assert.deepEqual(result.run_observation, {
    status: "ok",
    source: "wake_acknowledgement",
    observed_at: "2026-08-14T08:00:02.000Z"
  });
  assert.equal(
    harness.observations[1].event,
    "callback_session_send_delivery"
  );
});

test("legacy no-wake acknowledgement records before transport acceptance", () => {
  const harness = createHarness([
    processResult({ ok: true })
  ]);
  const result = harness.transport.deliverCallback(harness.input({}, {
    onAccepted(outcome) {
      harness.trace.push(`accepted:${String(outcome.wake.status)}`);
    },
    onProgress(progress) {
      harness.trace.push(`progress:${String(progress.stage)}`);
    }
  }));

  assert.deepEqual(harness.trace, [
    "spawn:agent.callback",
    "progress:gateway_injection",
    "record:callback_gateway_method_delivery",
    "accepted:not_required",
    "progress:wake_not_required"
  ]);
  assert.deepEqual(result.injection, {
    status: "accepted",
    enqueued: undefined,
    injection_id: undefined,
    observed_at: "2026-08-14T08:00:00.000Z",
    accepted_at: "2026-08-14T08:00:01.000Z",
    evidence: "legacy_gateway_ok_without_wake_plan"
  });
  assert.deepEqual(result.wake, {
    status: "not_required",
    accepted_at: "2026-08-14T08:00:02.000Z"
  });
});

test("an accepted injection survives wake process failure with exact ordering", () => {
  const harness = createHarness([
    processResult(gatewayPlan()),
    processResult("", { status: 7, stderr: "wake failed" })
  ]);
  const result = harness.transport.deliverCallback(harness.input({}, {
    onAccepted(outcome) {
      harness.trace.push(`accepted:${String(outcome.wake.status)}`);
    },
    onProgress(progress) {
      harness.trace.push(`progress:${String(progress.stage)}`);
    }
  }));

  assert.equal(result.wake.status, "failed");
  assert.equal(result.wake.error, "wake failed");
  assert.deepEqual(harness.trace, [
    "spawn:agent.callback",
    "accepted:not_attempted",
    "progress:gateway_injection",
    "record:callback_gateway_method_delivery",
    "spawn:chat.send",
    "accepted:failed",
    "record:callback_chat_send_delivery",
    "progress:wake_failed"
  ]);
});

test("invalid accepted wake acknowledgement is recorded as uncertain", () => {
  const harness = createHarness([
    processResult(gatewayPlan()),
    processResult({ runId: "a-different-run", status: "started" })
  ]);
  const result = harness.transport.deliverCallback(harness.input());

  assert.equal(result.wake.status, "uncertain");
  assert.match(
    String(result.wake.error),
    /runId does not match its idempotencyKey/u
  );
  assert.equal(harness.spawnCalls.length, 2);
  assert.match(
    String(harness.observations[1].detail?.acknowledgement_error),
    /runId does not match/u
  );
});

test("agent.wait process and payload failures remain observations, not delivery failures", () => {
  const processFailure = createHarness([
    processResult(gatewayPlan()),
    processResult({ runId: "run-1", status: "started" }),
    processResult("", { status: 9, stderr: "wait unavailable" })
  ]);
  const unavailable = processFailure.transport.deliverCallback(
    processFailure.input()
  );
  assert.deepEqual(unavailable.run_observation, {
    status: "unavailable",
    run_id: "run-1",
    observed_at: "2026-08-14T08:00:02.000Z",
    error: "wait unavailable"
  });

  const invalidPayload = createHarness([
    processResult(gatewayPlan()),
    processResult({ runId: "run-1", status: "started" }),
    processResult({ runId: "run-other", status: "ok" })
  ]);
  const invalid = invalidPayload.transport.deliverCallback(
    invalidPayload.input()
  );
  assert.equal(invalid.run_observation?.status, "invalid");
  assert.match(
    String(invalid.run_observation?.error),
    /different runId/u
  );
  assert.match(
    String(invalidPayload.observations[2].detail?.observation_error),
    /different runId/u
  );
});

test("gateway process failures record once and preserve the public error", () => {
  const harness = createHarness([
    processResult("gateway stdout", {
      status: null,
      stderr: "ignored stderr",
      error: new Error("spawn gateway ENOENT")
    })
  ]);
  assert.throws(
    () => harness.transport.deliverCallback(harness.input()),
    /spawn gateway ENOENT/u
  );
  assert.equal(harness.observations.length, 1);
  assert.equal(
    harness.observations[0].event,
    "callback_gateway_method_delivery"
  );
  assert.deepEqual(harness.observations[0].delivery, {
    status: 1,
    stdout: "gateway stdout",
    stderr: "spawn gateway ENOENT"
  });
});

test("gateway callback plan validation remains fail-closed before recording", () => {
  const cases = [
    {
      payload: "not-json",
      error: /gateway callback returned malformed JSON/u
    },
    {
      payload: { ok: false, error: "rejected" },
      error: /gateway callback was not accepted: rejected/u
    },
    {
      payload: { ok: true, delivery_required: "yes" },
      error: /invalid delivery_required/u
    },
    {
      payload: { ok: true, delivery_required: true },
      error: /requires delivery but returned no supported/u
    },
    {
      payload: {
        ...gatewayPlan(),
        session_send: {
          key: "agent:main:gateway",
          message: "wake",
          idempotencyKey: "run-1"
        }
      },
      error: /multiple delivery plans/u
    },
    {
      payload: gatewayPlan({
        chat_send: {
          sessionKey: "agent:main:gateway",
          message: "wake",
          idempotencyKey: "run-1",
          deliver: false
        }
      }),
      error: /invalid chat_send delivery plan/u
    }
  ];

  for (const fixture of cases) {
    const stdout = typeof fixture.payload === "string"
      ? fixture.payload
      : JSON.stringify(fixture.payload);
    const harness = createHarness([processResult(stdout)]);
    assert.throws(
      () => harness.transport.deliverCallback(harness.input()),
      fixture.error
    );
    assert.equal(
      harness.observations.length,
      0,
      `unexpected record for ${stdout}`
    );
  }
});

test("unconfirmed injection rejects a failed wake instead of claiming acceptance", () => {
  const harness = createHarness([
    processResult(gatewayPlan({ enqueued: false })),
    processResult("", { status: 2 })
  ]);
  assert.throws(
    () => harness.transport.deliverCallback(harness.input()),
    /callback wake delivery failed with status 2/u
  );
  assert.deepEqual(
    harness.observations.map((observation) => observation.event),
    ["callback_gateway_method_delivery", "callback_chat_send_delivery"]
  );
});

test("generic callback transport preserves OpenClaw acceptance checkpoints", () => {
  const harness = createHarness([
    processResult(gatewayPlan()),
    processResult({ runId: "run-1", status: "started" }),
    processResult({
      runId: "run-1",
      status: "ok",
      stopReason: "completed",
      timeoutPhase: "none",
      providerStarted: true
    })
  ]);
  const checkpoints: CallbackAttemptOutcome[] = [];
  const result = harness.transport.deliver(genericInput(harness, {
    reportCheckpoint(outcome) {
      checkpoints.push(outcome);
    }
  }));

  assert.equal(result.disposition, "accepted");
  assert.equal(
    result.disposition === "accepted" ? result.acceptance_id : undefined,
    "injection-1"
  );
  assert.equal(
    result.disposition === "accepted"
      ? (result.evidence?.legacy_delivery as { kind?: unknown } | undefined)
          ?.kind
      : undefined,
    "gateway_method+chat_send"
  );
  assert.ok(checkpoints.length >= 2);
  assert.ok(checkpoints.every((checkpoint) =>
    checkpoint.disposition === "accepted"
  ));
  assert.deepEqual(
    harness.spawnCalls.map((call) => call.args[2]),
    ["agent.callback", "chat.send", "agent.wait"]
  );
});

test("Terminal Watch generic delivery uses the shared OpenClaw transport", () => {
  const input = terminalWatchGenericInput();
  const harness = createHarness([
    processResult({
      runId: input.envelope.idempotency_key,
      status: "started"
    })
  ]);
  const checkpoints: CallbackAttemptOutcome[] = [];
  const request = {
    ...input,
    reportCheckpoint(outcome: CallbackAttemptOutcome) {
      checkpoints.push(outcome);
      throw new Error("simulate a failed first durable observation");
    }
  };

  const result = harness.transport.deliver(request);

  assert.deepEqual(result, {
    disposition: "accepted",
    accepted_at: "2026-08-14T08:00:00.000Z",
    acceptance_id: input.envelope.idempotency_key,
    evidence: { status: "started" }
  });
  assert.deepEqual(checkpoints, [result]);
  assert.equal(harness.spawnCalls.length, 1);
  const call = harness.spawnCalls[0];
  assert.equal(call.command, "/callback/bin/openclaw-terminal-watch");
  assert.deepEqual(call.args.slice(0, 3), [
    "gateway",
    "call",
    "chat.send"
  ]);
  assert.deepEqual(JSON.parse(String(call.args[4])), {
    sessionKey: input.route.controller_session_id,
    message: input.envelope.event.body,
    idempotencyKey: input.envelope.idempotency_key,
    deliver: true
  });
});

test("Terminal Watch generic delivery reports thrown and malformed attempts as uncertain", () => {
  const cases = [
    {
      result: new Error("spawn observation failed"),
      errorCode: "openclaw_callback_acceptance_uncertain",
      evidence: { error_message: "spawn observation failed" }
    },
    {
      result: processResult("not-json"),
      errorCode: "openclaw_chat_send_ack_uncertain",
      evidence: undefined
    }
  ];
  for (const fixture of cases) {
    const harness = createHarness([fixture.result]);
    assert.deepEqual(
      harness.transport.deliver(terminalWatchGenericInput()),
      {
        disposition: "uncertain",
        error_code: fixture.errorCode,
        observed_at: "2026-08-14T08:00:00.000Z",
        ...(fixture.evidence ? { evidence: fixture.evidence } : {})
      }
    );
    assert.equal(harness.spawnCalls.length, 1);
  }
});

test("Terminal Watch generic process failures preserve safe retry boundaries", () => {
  const cases: Array<{
    name: string;
    result: CallbackSpawnResult | Error;
    disposition: "permanent_failure" | "retryable_failure" | "uncertain";
    errorCode: string;
  }> = [
    {
      name: "spawn timeout",
      result: Object.assign(new Error("spawnSync openclaw failed"), {
        code: "ETIMEDOUT"
      }),
      disposition: "uncertain",
      errorCode: "openclaw_callback_acceptance_uncertain"
    },
    {
      name: "missing executable",
      result: Object.assign(new Error("spawnSync openclaw failed"), {
        code: "ENOENT"
      }),
      disposition: "permanent_failure",
      errorCode: "openclaw_callback_configuration_error"
    },
    {
      name: "connection refused before request dispatch",
      result: processResult("", {
        status: 1,
        stderr: "connect ECONNREFUSED 127.0.0.1:18789"
      }),
      disposition: "retryable_failure",
      errorCode: "openclaw_callback_delivery_failed"
    },
    {
      name: "unknown nonzero result after invocation",
      result: processResult("", {
        status: 7,
        stderr: "gateway process exited after dispatch"
      }),
      disposition: "uncertain",
      errorCode: "openclaw_callback_acceptance_uncertain"
    }
  ];

  for (const fixture of cases) {
    const harness = createHarness([fixture.result]);
    const outcome = harness.transport.deliver(terminalWatchGenericInput());
    assert.equal(outcome.disposition, fixture.disposition, fixture.name);
    assert.equal(outcome.error_code, fixture.errorCode, fixture.name);
    assert.equal(harness.spawnCalls.length, 1, fixture.name);
  }
});

test("Terminal Watch matching terminal acknowledgements settle the idempotency key", () => {
  for (const status of ["error", "timeout"] as const) {
    const input = terminalWatchGenericInput();
    const harness = createHarness([
      processResult({
        runId: input.envelope.idempotency_key,
        status
      }, { status: status === "error" ? 1 : 0 })
    ]);
    const checkpoints: CallbackAttemptOutcome[] = [];
    const outcome = harness.transport.deliver({
      ...input,
      reportCheckpoint(checkpoint) {
        checkpoints.push(checkpoint);
      }
    });

    assert.deepEqual(outcome, {
      disposition: "accepted",
      accepted_at: "2026-08-14T08:00:00.000Z",
      acceptance_id: input.envelope.idempotency_key,
      evidence: { status }
    });
    assert.deepEqual(checkpoints, [outcome]);
    assert.equal(harness.spawnCalls.length, 1);
  }
});

test("Terminal Watch generic delivery rejects trusted profile drift before I/O", () => {
  for (const drift of [
    "profile",
    "controller",
    "method",
    "trusted_options"
  ] as const) {
    const harness = createHarness([]);
    const input = terminalWatchGenericInput();
    const route = drift === "controller"
      ? { ...input.route, controller_session_id: "agent:other:session" }
      : drift === "profile"
        ? {
            ...input.route,
            profile_revision: `sha256:${"f".repeat(64)}`
          }
        : drift === "method"
          ? {
              ...createLegacyOpenClawCallbackRoute({
                controllerSessionId: input.route.controller_session_id,
                gatewayMethod: "agent.callback",
                openclawBin: "/callback/bin/openclaw-terminal-watch"
              }),
              capabilities: input.route.capabilities
            }
          : input.route;
    const context = drift === "trusted_options" || drift === "method"
      ? {
          ...input.context,
          legacyOptions: {
            ...input.context?.legacyOptions,
            ...(drift === "method"
              ? { gatewayMethod: "agent.callback" }
              : { openclawBin: "/callback/bin/redirected-openclaw" })
          }
        }
      : input.context;
    const result = harness.transport.deliver({
      ...input,
      route,
      envelope: {
        ...input.envelope,
        route: {
          ...input.envelope.route,
          profile_revision: route.profile_revision,
          controller_session_id: route.controller_session_id
        }
      },
      context
    });

    assert.deepEqual(result, {
      disposition: "permanent_failure",
      error_code: drift === "controller"
        ? "openclaw_controller_session_changed"
        : "openclaw_callback_profile_changed"
    });
    assert.equal(harness.spawnCalls.length, 0);
  }
});

test("generic callback transport rejects route/profile drift before delivery", () => {
  const harness = createHarness([]);
  const input = genericInput(harness);
  const result = harness.transport.deliver({
    ...input,
    route: {
      ...input.route,
      profile_revision: `sha256:${"f".repeat(64)}`
    }
  });

  assert.deepEqual(result, {
    disposition: "permanent_failure",
    error_code: "callback_envelope_route_mismatch"
  });
  assert.equal(harness.spawnCalls.length, 0);
});

test("generic OpenClaw transport cannot redirect its controller session", () => {
  const harness = createHarness([]);
  const input = genericInput(harness);
  const redirectedRoute = {
    ...input.route,
    controller_session_id: "agent:other:session"
  };
  const result = harness.transport.deliver({
    ...input,
    route: redirectedRoute,
    envelope: {
      ...input.envelope,
      route: {
        ...input.envelope.route,
        controller_session_id: redirectedRoute.controller_session_id
      }
    }
  });

  assert.deepEqual(result, {
    disposition: "permanent_failure",
    error_code: "openclaw_controller_session_changed"
  });
  assert.equal(harness.spawnCalls.length, 0);
});

test("generic callback transport treats an unparseable response as uncertain", () => {
  const harness = createHarness([processResult("not-json")]);
  const result = harness.transport.deliver(genericInput(harness));

  assert.equal(result.disposition, "uncertain");
  assert.equal(
    result.disposition === "uncertain" ? result.error_code : undefined,
    "openclaw_callback_acceptance_uncertain"
  );
  assert.match(
    result.disposition === "uncertain"
      ? String(result.evidence?.error_message)
      : "",
    /malformed JSON/u
  );
});

test("generic managed delivery never retries an opaque post-invocation throw", () => {
  const harness = createHarness([
    new Error("host transport disconnected after dispatch")
  ]);
  const checkpoints: CallbackAttemptOutcome[] = [];
  const result = harness.transport.deliver(genericInput(harness, {
    reportCheckpoint(outcome) {
      checkpoints.push(outcome);
    }
  }));

  assert.deepEqual(result, {
    disposition: "uncertain",
    error_code: "openclaw_callback_acceptance_uncertain",
    observed_at: "2026-08-14T08:00:00.000Z",
    evidence: {
      error_message: "host transport disconnected after dispatch"
    }
  });
  assert.deepEqual(checkpoints, []);
  assert.deepEqual(
    harness.spawnCalls.map((call) => call.args[2]),
    ["agent.callback"]
  );
});

test("legacy gateway ok without enqueued stays uncertain after wake refusal", () => {
  const harness = createHarness([
    processResult(gatewayPlan({
      enqueued: undefined,
      injection_id: undefined
    })),
    processResult("", {
      status: 7,
      stderr: "connect ECONNREFUSED 127.0.0.1:18789"
    })
  ]);

  const result = harness.transport.deliver(genericInput(harness));

  assert.deepEqual(result, {
    disposition: "uncertain",
    error_code: "openclaw_callback_acceptance_uncertain",
    observed_at: "2026-08-14T08:00:02.000Z",
    evidence: {
      error_message: "connect ECONNREFUSED 127.0.0.1:18789"
    }
  });
  assert.deepEqual(
    harness.spawnCalls.map((call) => call.args[2]),
    ["agent.callback", "chat.send"]
  );
});

test("explicit enqueued false keeps pre-acceptance wake refusal retryable", () => {
  const harness = createHarness([
    processResult(gatewayPlan({
      enqueued: false,
      injection_id: undefined
    })),
    processResult("", {
      status: 7,
      stderr: "connect ECONNREFUSED 127.0.0.1:18789"
    })
  ]);

  const result = harness.transport.deliver(genericInput(harness));

  assert.deepEqual(result, {
    disposition: "retryable_failure",
    error_code: "openclaw_callback_delivery_failed",
    evidence: {
      error_message: "connect ECONNREFUSED 127.0.0.1:18789"
    }
  });
  assert.deepEqual(
    harness.spawnCalls.map((call) => call.args[2]),
    ["agent.callback", "chat.send"]
  );
});

test("generic callback transport keeps an accepted injection when wake fails", () => {
  const harness = createHarness([
    processResult(gatewayPlan()),
    processResult("", { status: 7, stderr: "wake failed" })
  ]);
  const checkpoints: CallbackAttemptOutcome[] = [];
  const result = harness.transport.deliver(genericInput(harness, {
    reportCheckpoint(outcome) {
      checkpoints.push(outcome);
    }
  }));

  assert.equal(result.disposition, "accepted");
  assert.ok(checkpoints.some((checkpoint) =>
    checkpoint.disposition === "accepted"
  ));
  assert.equal(harness.spawnCalls.length, 2);
});

test("chat.send plan cannot redirect before any accepted side effect", () => {
  const harness = createHarness([
    processResult(gatewayPlan({
      enqueued: false,
      injection_id: undefined,
      chat_send: {
        sessionKey: "agent:other:session",
        message: "wake the wrong agent",
        idempotencyKey: "run-redirected-chat",
        deliver: true
      }
    }))
  ]);

  const result = harness.transport.deliver(genericInput(harness));

  assert.deepEqual(result, {
    disposition: "permanent_failure",
    error_code: "openclaw_callback_target_mismatch",
    evidence: {
      error_message:
        "gateway callback delivery target does not match the immutable callback route"
    }
  });
  assert.deepEqual(
    harness.spawnCalls.map((call) => call.args[2]),
    ["agent.callback"]
  );
});

test("sessions.send redirect after possible injection is uncertain and not woken", () => {
  const harness = createHarness([
    processResult(gatewayPlan({
      delivery_mode: "sessions.send",
      chat_send: undefined,
      session_send: {
        key: "agent:other:session",
        message: "wake the wrong agent",
        idempotencyKey: "run-redirected-session"
      }
    }))
  ]);

  const result = harness.transport.deliver(genericInput(harness));

  assert.deepEqual(result, {
    disposition: "uncertain",
    error_code:
      "openclaw_callback_target_mismatch_after_possible_acceptance",
    observed_at: "2026-08-14T08:00:00.000Z",
    evidence: {
      error_message:
        "gateway callback delivery target does not match the immutable callback route"
    }
  });
  assert.deepEqual(
    harness.spawnCalls.map((call) => call.args[2]),
    ["agent.callback"]
  );
});
