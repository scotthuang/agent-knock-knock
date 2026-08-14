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
  processResults: CallbackSpawnResult[]
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
