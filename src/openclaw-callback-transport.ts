import { spawnSync } from "node:child_process";
import type { CallbackDeliveryOutcome } from "./callback-outbox-policy.js";
import {
  sessionIdForConversation,
  turnIdForConversation,
  type AgentMessage,
  type Conversation
} from "./protocol.js";

const CALLBACK_DELIVERY_TIMEOUT_MS = 30_000;
const CALLBACK_AGENT_WAIT_TIMEOUT_MS = 20_000;
const CALLBACK_AGENT_WAIT_CLI_TIMEOUT_MS = 25_000;
const CALLBACK_AGENT_WAIT_PROCESS_TIMEOUT_MS = 30_000;
const CALLBACK_PROCESS_MAX_BUFFER = 1024 * 1024 * 10;

export type CallbackWakeAcknowledgementStatus =
  | "started"
  | "in_flight"
  | "ok"
  | "error"
  | "timeout";

export interface CallbackProcessDelivery {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CallbackSpawnResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}

interface CallbackSpawnOptions {
  encoding: "utf8";
  maxBuffer: number;
  timeout: number;
  killSignal: "SIGKILL";
  env: NodeJS.ProcessEnv;
}

export type CallbackSpawnSync = (
  command: string,
  args: string[],
  options: CallbackSpawnOptions
) => CallbackSpawnResult;

export interface CallbackProcessDeliveryObservation {
  logPath: string;
  conversation: Conversation;
  message: AgentMessage;
  event: string;
  runtimeEvent: string;
  delivery: CallbackProcessDelivery;
  detail?: Record<string, unknown>;
}

export interface OpenClawCallbackTransportPorts {
  now(): Date;
  environment(): NodeJS.ProcessEnv;
  redactConversation(conversation: Conversation): unknown;
  recordCallbackProcessDelivery(
    observation: CallbackProcessDeliveryObservation
  ): void;
  spawnSync?: CallbackSpawnSync;
}

export interface OpenClawCallbackDeliveryOptions {
  gatewayMethod?: string;
  openclawBin?: string;
  gatewayUrl?: string;
  token?: string;
  gatewaySession?: string;
  openclawSession?: string;
}

export interface DeliverOpenClawCallbackInput {
  options: OpenClawCallbackDeliveryOptions;
  statePath: string;
  logPath: string;
  conversation: Conversation;
  message: AgentMessage;
  onProgress?: (progress: Record<string, unknown>) => void;
  onAccepted?: (outcome: CallbackDeliveryOutcome) => void;
}

export interface DeliverGatewayMethodInput {
  method: string;
  openclawBin?: string;
  gatewayUrl?: string;
  token?: string;
  sessionKey?: string;
  statePath: string;
  logPath: string;
  conversation: Conversation;
  message: AgentMessage;
}

export interface DeliverChatSendInput {
  openclawBin?: string;
  gatewayUrl?: string;
  token?: string;
  params: Record<string, unknown>;
}

export interface OpenClawCallbackTransport {
  deliverCallback(input: DeliverOpenClawCallbackInput): CallbackDeliveryOutcome;
  deliverGatewayMethod(input: DeliverGatewayMethodInput): CallbackProcessDelivery;
  deliverChatSend(input: DeliverChatSendInput): CallbackProcessDelivery;
}

interface CallbackWakeAcknowledgement {
  runId: string;
  status: CallbackWakeAcknowledgementStatus;
}

interface DeliverAgentWaitInput {
  openclawBin?: string;
  gatewayUrl?: string;
  token?: string;
  runId: string;
}

type DeliverAgentWait = (
  input: DeliverAgentWaitInput
) => CallbackProcessDelivery;

interface ObserveCallbackAgentRunInput {
  options: OpenClawCallbackDeliveryOptions;
  logPath: string;
  conversation: Conversation;
  message: AgentMessage;
  wakeAck: CallbackWakeAcknowledgement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function cleanProcessText(text: unknown): string | undefined {
  const value = String(text ?? "").trim();
  return value ? value.slice(0, 2000) : undefined;
}

function parseOptionalJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    return undefined;
  }
}

function parseRequiredGatewayDeliveryPayload(
  text: unknown
): Record<string, unknown> {
  const payload = parseOptionalJson(text);
  if (!isRecord(payload)) {
    throw new Error("gateway callback returned malformed JSON");
  }
  if (payload.ok !== true) {
    throw new Error(
      `gateway callback was not accepted: ${
        stringValue(payload.error) ??
        stringValue(payload.message) ??
        "ok was not true"
      }`
    );
  }
  if (
    payload.delivery_required !== undefined &&
    typeof payload.delivery_required !== "boolean"
  ) {
    throw new Error(
      "gateway callback returned an invalid delivery_required value"
    );
  }
  return payload;
}

function parseGatewayCallbackDeliveryPlan(
  payload: Record<string, unknown>
): {
  chatSendParams?: Record<string, unknown>;
  sessionSendParams?: Record<string, unknown>;
} {
  const chatSendParams = isRecord(payload.chat_send)
    ? payload.chat_send
    : undefined;
  const sessionSendParams = isRecord(payload.session_send)
    ? payload.session_send
    : undefined;
  if (chatSendParams && sessionSendParams) {
    throw new Error("gateway callback returned multiple delivery plans");
  }

  const deliveryRequired = payload.delivery_required === true;
  const deliveryExplicitlyNotRequired = payload.delivery_required === false;
  const deliveryMode = stringValue(payload.delivery_mode);
  if (deliveryRequired && !chatSendParams && !sessionSendParams) {
    throw new Error(
      "gateway callback requires delivery but returned no supported " +
        "chat_send or session_send plan"
    );
  }
  if (deliveryExplicitlyNotRequired && (chatSendParams || sessionSendParams)) {
    throw new Error(
      "gateway callback returned a delivery plan without delivery_required"
    );
  }
  if (deliveryMode && deliveryMode !== "none") {
    const expectedMode = chatSendParams
      ? "chat.send"
      : sessionSendParams
        ? "sessions.send"
        : undefined;
    if (deliveryMode !== expectedMode) {
      throw new Error(
        "gateway callback delivery_mode does not match its delivery plan"
      );
    }
  }
  if (deliveryMode === "none" && deliveryRequired) {
    throw new Error(
      "gateway callback delivery_mode none cannot require delivery"
    );
  }

  if (chatSendParams) {
    if (
      !stringValue(chatSendParams.sessionKey) ||
      !stringValue(chatSendParams.message) ||
      !stringValue(chatSendParams.idempotencyKey) ||
      chatSendParams.deliver !== true
    ) {
      throw new Error(
        "gateway callback returned an invalid chat_send delivery plan"
      );
    }
  }
  if (sessionSendParams) {
    if (
      !stringValue(sessionSendParams.key) ||
      !stringValue(sessionSendParams.message) ||
      !stringValue(sessionSendParams.idempotencyKey)
    ) {
      throw new Error(
        "gateway callback returned an invalid session_send delivery plan"
      );
    }
  }
  return { chatSendParams, sessionSendParams };
}

function parseChatSendAcknowledgement(
  text: unknown,
  expectedRunId: string
): CallbackWakeAcknowledgement {
  const payload = parseOptionalJson(text);
  if (!isRecord(payload)) {
    throw new Error("chat.send returned malformed JSON");
  }
  const runId = stringValue(payload.runId);
  const status = stringValue(payload.status);
  if (!runId) {
    throw new Error("chat.send acknowledgement is missing runId");
  }
  if (runId !== expectedRunId) {
    throw new Error(
      "chat.send acknowledgement runId does not match its idempotencyKey"
    );
  }
  if (
    !status ||
    !["started", "in_flight", "ok", "error", "timeout"].includes(status)
  ) {
    throw new Error(
      `chat.send returned unexpected status ${JSON.stringify(status ?? null)}`
    );
  }
  return {
    runId,
    status: status as CallbackWakeAcknowledgementStatus
  };
}

function parseAgentWaitResult(
  text: unknown,
  expectedRunId: string
): Record<string, unknown> {
  const payload = parseOptionalJson(text);
  if (!isRecord(payload)) {
    throw new Error("agent.wait returned malformed JSON");
  }
  if (stringValue(payload.runId) !== expectedRunId) {
    throw new Error("agent.wait returned a result for a different runId");
  }
  const status = stringValue(payload.status);
  if (!status || !["ok", "error", "timeout", "pending"].includes(status)) {
    throw new Error(
      `agent.wait returned unexpected status ${JSON.stringify(status ?? null)}`
    );
  }
  return payload;
}

function normalizeCallbackProcessDelivery(
  result: CallbackSpawnResult
): CallbackProcessDelivery {
  if (result.error) {
    return {
      status: 1,
      stdout: result.stdout ?? "",
      stderr: result.error.message
    };
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function observeCallbackAgentRun(
  ports: OpenClawCallbackTransportPorts,
  deliverAgentWait: DeliverAgentWait,
  {
    options,
    logPath,
    conversation,
    message,
    wakeAck
  }: ObserveCallbackAgentRunInput
): Record<string, unknown> {
  if (["ok", "error", "timeout"].includes(wakeAck.status)) {
    return {
      status: wakeAck.status,
      source: "wake_acknowledgement",
      observed_at: ports.now().toISOString()
    };
  }

  const agentWaitDelivery = deliverAgentWait({
    openclawBin: options.openclawBin,
    gatewayUrl: options.gatewayUrl,
    token: options.token,
    runId: wakeAck.runId
  });
  if (agentWaitDelivery.status !== 0) {
    ports.recordCallbackProcessDelivery({
      logPath,
      conversation,
      message,
      event: "callback_agent_wait_delivery",
      runtimeEvent: "callback_agent_wait_delivery",
      delivery: agentWaitDelivery,
      detail: { run_id: wakeAck.runId }
    });
    return {
      status: "unavailable",
      run_id: wakeAck.runId,
      observed_at: ports.now().toISOString(),
      error: cleanProcessText(
        agentWaitDelivery.stderr ||
          agentWaitDelivery.stdout ||
          `agent.wait failed with status ${agentWaitDelivery.status}`
      )
    };
  }

  let waitResult: Record<string, unknown>;
  try {
    waitResult = parseAgentWaitResult(
      agentWaitDelivery.stdout,
      wakeAck.runId
    );
  } catch (error) {
    ports.recordCallbackProcessDelivery({
      logPath,
      conversation,
      message,
      event: "callback_agent_wait_delivery",
      runtimeEvent: "callback_agent_wait_delivery",
      delivery: agentWaitDelivery,
      detail: {
        run_id: wakeAck.runId,
        observation_error: String(error)
      }
    });
    return {
      status: "invalid",
      run_id: wakeAck.runId,
      observed_at: ports.now().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
  }

  ports.recordCallbackProcessDelivery({
    logPath,
    conversation,
    message,
    event: "callback_agent_wait_delivery",
    runtimeEvent: "callback_agent_wait_delivery",
    delivery: agentWaitDelivery,
    detail: {
      run_id: wakeAck.runId,
      run_status: waitResult.status
    }
  });
  return {
    status: waitResult.status,
    run_id: wakeAck.runId,
    observed_at: ports.now().toISOString(),
    ...(stringValue(waitResult.error)
      ? { error: stringValue(waitResult.error) }
      : {}),
    ...(stringValue(waitResult.stopReason)
      ? { stop_reason: stringValue(waitResult.stopReason) }
      : {}),
    ...(stringValue(waitResult.timeoutPhase)
      ? { timeout_phase: stringValue(waitResult.timeoutPhase) }
      : {}),
    ...(typeof waitResult.providerStarted === "boolean"
      ? { provider_started: waitResult.providerStarted }
      : {})
  };
}

export function createOpenClawCallbackTransport(
  ports: OpenClawCallbackTransportPorts
): OpenClawCallbackTransport {
  const runSync: CallbackSpawnSync = ports.spawnSync ??
    ((command, args, options) => spawnSync(command, args, options));

  function openClawGatewayEnvironment(token?: string): NodeJS.ProcessEnv {
    if (!token || token === "<token>") {
      return ports.environment();
    }
    return {
      ...ports.environment(),
      OPENCLAW_GATEWAY_TOKEN: token
    };
  }

  function deliverGatewayMethod({
    method,
    openclawBin,
    gatewayUrl,
    token,
    sessionKey,
    statePath,
    logPath,
    conversation,
    message
  }: DeliverGatewayMethodInput): CallbackProcessDelivery {
    const args = [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify({
        sessionKey,
        session_id: sessionIdForConversation(conversation),
        turn_id: turnIdForConversation(conversation),
        statePath,
        logPath,
        conversation: ports.redactConversation(conversation),
        message
      }),
      "--json"
    ];

    if (gatewayUrl) {
      args.push("--url", gatewayUrl);
    }

    const result = runSync(openclawBin ?? "openclaw", args, {
      encoding: "utf8",
      maxBuffer: CALLBACK_PROCESS_MAX_BUFFER,
      timeout: CALLBACK_DELIVERY_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: openClawGatewayEnvironment(token)
    });

    return normalizeCallbackProcessDelivery(result);
  }

  function deliverSessionSend({
    openclawBin,
    gatewayUrl,
    token,
    params
  }: DeliverChatSendInput): CallbackProcessDelivery {
    const args = [
      "gateway",
      "call",
      "sessions.send",
      "--params",
      JSON.stringify(params),
      "--json"
    ];

    if (gatewayUrl) {
      args.push("--url", gatewayUrl);
    }

    const result = runSync(openclawBin ?? "openclaw", args, {
      encoding: "utf8",
      maxBuffer: CALLBACK_PROCESS_MAX_BUFFER,
      timeout: CALLBACK_DELIVERY_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: openClawGatewayEnvironment(token)
    });

    return normalizeCallbackProcessDelivery(result);
  }

  function deliverChatSend({
    openclawBin,
    gatewayUrl,
    token,
    params
  }: DeliverChatSendInput): CallbackProcessDelivery {
    const args = [
      "gateway",
      "call",
      "chat.send",
      "--params",
      JSON.stringify(params),
      "--json"
    ];

    if (gatewayUrl) {
      args.push("--url", gatewayUrl);
    }

    const result = runSync(openclawBin ?? "openclaw", args, {
      encoding: "utf8",
      maxBuffer: CALLBACK_PROCESS_MAX_BUFFER,
      timeout: CALLBACK_DELIVERY_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: openClawGatewayEnvironment(token)
    });

    return normalizeCallbackProcessDelivery(result);
  }

  function deliverAgentWait({
    openclawBin,
    gatewayUrl,
    token,
    runId
  }: DeliverAgentWaitInput): CallbackProcessDelivery {
    const args = [
      "gateway",
      "call",
      "agent.wait",
      "--params",
      JSON.stringify({
        runId,
        timeoutMs: CALLBACK_AGENT_WAIT_TIMEOUT_MS
      }),
      "--json",
      "--timeout",
      String(CALLBACK_AGENT_WAIT_CLI_TIMEOUT_MS)
    ];

    if (gatewayUrl) {
      args.push("--url", gatewayUrl);
    }

    const result = runSync(openclawBin ?? "openclaw", args, {
      encoding: "utf8",
      maxBuffer: CALLBACK_PROCESS_MAX_BUFFER,
      timeout: CALLBACK_AGENT_WAIT_PROCESS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: openClawGatewayEnvironment(token)
    });

    return normalizeCallbackProcessDelivery(result);
  }

  function deliverCallback({
    options,
    statePath,
    logPath,
    conversation,
    message,
    onProgress,
    onAccepted
  }: DeliverOpenClawCallbackInput): CallbackDeliveryOutcome {
    if (!options.gatewayMethod) {
      throw new Error(
        "callback delivery requires a configured OpenClaw gateway method"
      );
    }

    const delivery = deliverGatewayMethod({
      method: options.gatewayMethod,
      openclawBin: options.openclawBin,
      gatewayUrl: options.gatewayUrl,
      token: options.token,
      sessionKey:
        options.gatewaySession ??
        options.openclawSession ??
        conversation.openclaw_session,
      statePath,
      logPath,
      conversation,
      message
    });
    if (delivery.status !== 0) {
      ports.recordCallbackProcessDelivery({
        logPath,
        conversation,
        message,
        event: "callback_gateway_method_delivery",
        runtimeEvent: "callback_gateway_method_delivery",
        delivery,
        detail: { method: options.gatewayMethod }
      });
      throw new Error(
        delivery.stderr ||
          delivery.stdout ||
          `gateway method delivery failed with status ${delivery.status}`
      );
    }

    const gatewayPayload = parseRequiredGatewayDeliveryPayload(delivery.stdout);
    const { chatSendParams, sessionSendParams } =
      parseGatewayCallbackDeliveryPlan(gatewayPayload);
    const explicitlyEnqueued =
      typeof gatewayPayload.enqueued === "boolean"
        ? gatewayPayload.enqueued
        : undefined;
    const gatewayHandledWithoutInjection =
      gatewayPayload.auto_approved === true ||
      gatewayPayload.approval_already_handled === true;
    const injectionObservedAt = ports.now().toISOString();
    let injection: Record<string, unknown> = {
      status:
        gatewayHandledWithoutInjection || explicitlyEnqueued === true
          ? "accepted"
          : explicitlyEnqueued === false
            ? "uncertain"
            : "unconfirmed",
      enqueued: explicitlyEnqueued,
      injection_id: stringValue(gatewayPayload.injection_id),
      ...(gatewayHandledWithoutInjection || explicitlyEnqueued === true
        ? { accepted_at: injectionObservedAt }
        : { observed_at: injectionObservedAt }),
      evidence: gatewayHandledWithoutInjection
        ? "gateway_handled_callback_without_injection"
        : explicitlyEnqueued === true
          ? "next_turn_injection_enqueued"
          : explicitlyEnqueued === false
            ? "gateway_ok_but_enqueue_unconfirmed"
            : "legacy_gateway_ack_without_enqueue_field"
    };

    const wakePlan = chatSendParams
      ? {
          mode: "chat.send",
          params: chatSendParams,
          event: "callback_chat_send_delivery",
          deliver: deliverChatSend,
          kind: "gateway_method+chat_send"
        }
      : sessionSendParams
        ? {
            mode: "sessions.send",
            params: sessionSendParams,
            event: "callback_session_send_delivery",
            deliver: deliverSessionSend,
            kind: "gateway_method+sessions_send"
          }
        : undefined;
    const initialWake = wakePlan
      ? {
          status: "not_attempted",
          mode: wakePlan.mode,
          observed_at: injectionObservedAt
        }
      : {
          status: "not_required",
          observed_at: injectionObservedAt
        };
    if (injection.status === "accepted") {
      onAccepted?.({
        kind: wakePlan?.kind ?? "gateway_method",
        injection,
        wake: initialWake
      });
    }
    onProgress?.({
      stage: "gateway_injection",
      injection
    });
    ports.recordCallbackProcessDelivery({
      logPath,
      conversation,
      message,
      event: "callback_gateway_method_delivery",
      runtimeEvent: "callback_gateway_method_delivery",
      delivery,
      detail: { method: options.gatewayMethod }
    });

    if (!wakePlan) {
      if (explicitlyEnqueued === false && !gatewayHandledWithoutInjection) {
        throw new Error(
          "gateway callback returned ok but did not confirm that its " +
            "injection was enqueued"
        );
      }
      if (injection.status === "unconfirmed") {
        injection = {
          ...injection,
          status: "accepted",
          accepted_at: ports.now().toISOString(),
          evidence: "legacy_gateway_ok_without_wake_plan"
        };
      }
      const wake = {
        status: "not_required",
        accepted_at: ports.now().toISOString()
      };
      const outcome = { kind: "gateway_method", injection, wake };
      onAccepted?.(outcome);
      onProgress?.({ stage: "wake_not_required", injection, wake });
      return outcome;
    }

    const wakeDelivery = wakePlan.deliver({
      openclawBin: options.openclawBin,
      gatewayUrl: options.gatewayUrl,
      token: options.token,
      params: wakePlan.params
    });
    if (wakeDelivery.status !== 0) {
      const wake = {
        status: "failed",
        mode: wakePlan.mode,
        failed_at: ports.now().toISOString(),
        error: cleanProcessText(
          wakeDelivery.stderr ||
            wakeDelivery.stdout ||
            `wake delivery failed with status ${wakeDelivery.status}`
        )
      };
      const outcome = { kind: wakePlan.kind, injection, wake };
      if (injection.status === "accepted") {
        onAccepted?.(outcome);
      }
      ports.recordCallbackProcessDelivery({
        logPath,
        conversation,
        message,
        event: wakePlan.event,
        runtimeEvent: wakePlan.event,
        delivery: wakeDelivery
      });
      onProgress?.({
        stage: "wake_failed",
        injection,
        wake
      });
      if (injection.status === "accepted") {
        return outcome;
      }
      throw new Error(
        wakeDelivery.stderr ||
          wakeDelivery.stdout ||
          `callback wake delivery failed with status ${wakeDelivery.status}`
      );
    }

    let wakeAck: CallbackWakeAcknowledgement;
    try {
      wakeAck = parseChatSendAcknowledgement(
        wakeDelivery.stdout,
        String(wakePlan.params.idempotencyKey)
      );
    } catch (error) {
      const wake = {
        status: "uncertain",
        mode: wakePlan.mode,
        observed_at: ports.now().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      const outcome = { kind: wakePlan.kind, injection, wake };
      if (injection.status === "accepted") {
        onAccepted?.(outcome);
      }
      ports.recordCallbackProcessDelivery({
        logPath,
        conversation,
        message,
        event: wakePlan.event,
        runtimeEvent: wakePlan.event,
        delivery: wakeDelivery,
        detail: { acknowledgement_error: String(error) }
      });
      onProgress?.({
        stage: "wake_acknowledgement_invalid",
        injection,
        wake
      });
      if (injection.status === "accepted") {
        return outcome;
      }
      throw error;
    }

    const wake = {
      status: "accepted",
      mode: wakePlan.mode,
      run_id: wakeAck.runId,
      acknowledgement_status: wakeAck.status,
      idempotency_key: String(wakePlan.params.idempotencyKey),
      accepted_at: ports.now().toISOString()
    };
    onAccepted?.({ kind: wakePlan.kind, injection, wake });
    ports.recordCallbackProcessDelivery({
      logPath,
      conversation,
      message,
      event: wakePlan.event,
      runtimeEvent: wakePlan.event,
      delivery: wakeDelivery,
      detail: {
        run_id: wakeAck.runId,
        run_status: wakeAck.status
      }
    });
    onProgress?.({ stage: "wake_accepted", injection, wake });

    const runObservation = observeCallbackAgentRun(
      ports,
      deliverAgentWait,
      {
        options,
        logPath,
        conversation,
        message,
        wakeAck
      }
    );
    const outcome = {
      kind: wakePlan.kind,
      injection,
      wake,
      run_observation: runObservation
    };
    onAccepted?.(outcome);
    onProgress?.({
      stage: "agent_run_observed",
      injection,
      wake,
      run_observation: runObservation
    });
    return outcome;
  }

  return {
    deliverCallback,
    deliverGatewayMethod,
    deliverChatSend
  };
}
