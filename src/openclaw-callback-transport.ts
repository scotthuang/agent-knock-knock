import { spawnSync } from "node:child_process";
import type {
  CallbackDeliveryOptions,
  CallbackDeliveryOutcome,
  DeliverCallbackInput
} from "./callback-outbox-policy.js";
import {
  callbackEnvelopeMatchesRoute,
  createLegacyOpenClawCallbackRoute,
  parseCallbackRoute,
  type CallbackAttemptOutcome,
  type CallbackEnvelopeV1,
  type CallbackRouteV1,
  type CallbackTransport,
  type CallbackTransportDeliverInput
} from "./callback-transport.js";
import {
  sessionIdForConversation,
  turnIdForConversation,
  type AgentMessage,
  type Conversation
} from "./protocol.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

const CALLBACK_DELIVERY_TIMEOUT_MS = 30_000;
const CALLBACK_AGENT_WAIT_TIMEOUT_MS = 20_000;
const CALLBACK_AGENT_WAIT_CLI_TIMEOUT_MS = 25_000;
const CALLBACK_AGENT_WAIT_PROCESS_TIMEOUT_MS = 30_000;
const CALLBACK_PROCESS_MAX_BUFFER = 1024 * 1024 * 10;
const DEFAULT_OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";

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

export type OpenClawCallbackDeliveryOptions = CallbackDeliveryOptions;
export type DeliverOpenClawCallbackInput = DeliverCallbackInput;

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

export interface OpenClawCallbackTransport extends CallbackTransport {
  readonly kind: "openclaw_gateway_v1";
  deliver(input: CallbackTransportDeliverInput): CallbackAttemptOutcome;
  deliverCallback(input: DeliverOpenClawCallbackInput): CallbackDeliveryOutcome;
  deliverGatewayMethod(input: DeliverGatewayMethodInput): CallbackProcessDelivery;
  deliverChatSend(input: DeliverChatSendInput): CallbackProcessDelivery;
}

export interface CallbackWakeAcknowledgement {
  runId: string;
  status: CallbackWakeAcknowledgementStatus;
}

class OpenClawCallbackPlanError extends Error {
  readonly disposition: "permanent_failure" | "uncertain";
  readonly errorCode: string;

  constructor(input: {
    message: string;
    disposition: "permanent_failure" | "uncertain";
    errorCode: string;
  }) {
    super(input.message);
    this.name = "OpenClawCallbackPlanError";
    this.disposition = input.disposition;
    this.errorCode = input.errorCode;
  }
}

function permanentFailure(errorCode: string): CallbackAttemptOutcome {
  return {
    disposition: "permanent_failure",
    error_code: errorCode
  };
}

function sameOpenClawProfile(
  actual: CallbackRouteV1,
  expected: CallbackRouteV1
): boolean {
  return actual.transport === expected.transport &&
    actual.profile_id === expected.profile_id &&
    actual.profile_revision === expected.profile_revision &&
    actual.controller_session_id === expected.controller_session_id;
}

function acceptedOutcome(
  envelope: CallbackEnvelopeV1,
  outcome: CallbackDeliveryOutcome,
  observedAt: Date
): CallbackAttemptOutcome {
  const injectionId = stringValue(outcome.injection.injection_id);
  const acceptedAt = stringValue(outcome.wake.accepted_at) ??
    stringValue(outcome.injection.accepted_at) ??
    observedAt.toISOString();
  return {
    disposition: "accepted",
    accepted_at: acceptedAt,
    // Injection acceptance is the first authoritative side effect and remains
    // stable across later wake/run observations for the same delivery.
    acceptance_id: injectionId ?? envelope.delivery_id,
    evidence: {
      transport: "openclaw_gateway_v1",
      delivery_kind: outcome.kind,
      injection_status: stringValue(outcome.injection.status) ?? "unknown",
      wake_status: stringValue(outcome.wake.status) ?? "unknown",
      // Opaque adapter evidence retained only so the compatibility projection
      // can keep writing the pre-existing OpenClaw receipt shape. Generic core
      // policy never reads this transport-private payload.
      legacy_delivery: outcome
    }
  };
}

function callbackFailureOutcome(
  error: unknown,
  observedAt: Date,
  fallbackDisposition: "retryable_failure" | "uncertain" =
    "retryable_failure"
): CallbackAttemptOutcome {
  const errorMessage = (error instanceof Error ? error.message : String(error))
    .slice(0, 4_000);
  if (error instanceof OpenClawCallbackPlanError) {
    return error.disposition === "uncertain"
      ? {
          disposition: "uncertain",
          error_code: error.errorCode,
          observed_at: observedAt.toISOString(),
          evidence: { error_message: errorMessage }
        }
      : {
          disposition: "permanent_failure",
          error_code: error.errorCode,
          evidence: { error_message: errorMessage }
        };
  }
  const systemErrorCode = error instanceof Error
    ? stringValue((error as NodeJS.ErrnoException).code)
    : isRecord(error)
      ? stringValue(error.code)
      : undefined;
  const message = `${systemErrorCode ?? ""} ${errorMessage}`.toLowerCase();
  const evidence = { error_message: errorMessage };
  if (
    message.includes("eacces") ||
    message.includes("eperm") ||
    message.includes("enoent") ||
    message.includes("enotdir") ||
    message.includes("permission denied") ||
    message.includes("operation not permitted") ||
    message.includes("command not found") ||
    message.includes("not found") ||
    message.includes("unsupported") ||
    message.includes("invalid url") ||
    message.includes("unknown option")
  ) {
    return {
      disposition: "permanent_failure",
      error_code: "openclaw_callback_configuration_error",
      evidence
    };
  }
  if (
    message.includes("etimedout") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("epipe") ||
    message.includes("socket hang up") ||
    message.includes("connection closed") ||
    message.includes("malformed json") ||
    message.includes("did not confirm") ||
    message.includes("enqueue unconfirmed") ||
    message.includes("acknowledgement")
  ) {
    return {
      disposition: "uncertain",
      error_code: "openclaw_callback_acceptance_uncertain",
      observed_at: observedAt.toISOString(),
      evidence
    };
  }
  if (
    message.includes("econnrefused") ||
    message.includes("enetunreach") ||
    message.includes("ehostunreach") ||
    message.includes("enotfound") ||
    message.includes("connection refused") ||
    message.includes("network is unreachable") ||
    message.includes("no route to host") ||
    message.includes("failed to connect")
  ) {
    return {
      disposition: "retryable_failure",
      error_code: "openclaw_callback_delivery_failed",
      evidence
    };
  }
  if (fallbackDisposition === "uncertain") {
    return {
      disposition: "uncertain",
      error_code: "openclaw_callback_acceptance_uncertain",
      observed_at: observedAt.toISOString(),
      evidence
    };
  }
  return {
    disposition: "retryable_failure",
    error_code: "openclaw_callback_delivery_failed",
    evidence
  };
}

function deliverGenericOpenClawCallback(input: {
  request: CallbackTransportDeliverInput;
  now(): Date;
  deliverCallback(input: DeliverOpenClawCallbackInput): CallbackDeliveryOutcome;
  deliverChatSend(input: DeliverChatSendInput): CallbackProcessDelivery;
}): CallbackAttemptOutcome {
  const { request } = input;
  const route = parseCallbackRoute(request.route);
  if (route.transport !== "openclaw_gateway_v1") {
    return permanentFailure("unsupported_callback_transport");
  }
  if (!callbackEnvelopeMatchesRoute(request.envelope, route)) {
    return permanentFailure("callback_envelope_route_mismatch");
  }
  if (request.envelope.source.kind === "terminal_watch") {
    return deliverGenericTerminalWatchCallback({
      request,
      route,
      now: input.now,
      deliverChatSend: input.deliverChatSend
    });
  }
  if (request.envelope.source.kind !== "managed_turn") {
    return permanentFailure("unsupported_callback_envelope_source");
  }
  const conversation = isRecord(request.context?.conversation)
    ? request.context.conversation as unknown as Conversation
    : undefined;
  const message = isRecord(request.context?.message)
    ? request.context.message as unknown as AgentMessage
    : undefined;
  const legacyOptions = isRecord(request.context?.legacyOptions)
    ? request.context.legacyOptions
    : undefined;
  const statePath = stringValue(request.context?.statePath);
  const logPath = stringValue(request.context?.logPath);
  if (!conversation || !message || !legacyOptions || !statePath || !logPath) {
    return permanentFailure("openclaw_callback_context_missing");
  }
  if (message.id !== request.envelope.event.id) {
    return permanentFailure("callback_envelope_message_mismatch");
  }
  const gatewayMethod = stringValue(legacyOptions.gatewayMethod);
  if (!gatewayMethod) {
    return permanentFailure("openclaw_gateway_method_missing");
  }
  const controllerSessionId = stringValue(legacyOptions.gatewaySession) ??
    stringValue(legacyOptions.openclawSession);
  if (!controllerSessionId) {
    return permanentFailure("openclaw_controller_session_missing");
  }
  if (route.controller_session_id !== controllerSessionId) {
    return permanentFailure("openclaw_controller_session_changed");
  }
  const expectedRoute = createLegacyOpenClawCallbackRoute({
    controllerSessionId,
    gatewayMethod,
    openclawBin: legacyOptions.openclawBin,
    gatewayUrl: legacyOptions.gatewayUrl
  });
  if (!sameOpenClawProfile(route, expectedRoute)) {
    return permanentFailure("openclaw_callback_profile_changed");
  }
  const options: CallbackDeliveryOptions = {
    callbackRoute: route,
    gatewayMethod,
    gatewaySession: route.controller_session_id,
    openclawSession: route.controller_session_id,
    openclawBin: stringValue(legacyOptions.openclawBin),
    gatewayUrl: openClawGatewayUrlForInvocation(legacyOptions.gatewayUrl),
    token: stringValue(legacyOptions.token)
  };
  let acceptedCheckpoint: CallbackAttemptOutcome | undefined;
  try {
    const legacyOutcome = input.deliverCallback({
      options,
      statePath,
      logPath,
      conversation,
      message,
      attempt: request.attempt,
      onAccepted(outcome) {
        acceptedCheckpoint = acceptedOutcome(
          request.envelope,
          outcome,
          input.now()
        );
        request.reportCheckpoint?.(acceptedCheckpoint);
      }
    });
    return acceptedOutcome(request.envelope, legacyOutcome, input.now());
  } catch (error) {
    if (acceptedCheckpoint) return acceptedCheckpoint;
    // deliverCallback is an opaque host invocation boundary. Without an
    // accepted checkpoint, a generic throw still cannot prove that the host
    // did not accept the idempotency key before the observation was lost.
    return callbackFailureOutcome(error, input.now(), "uncertain");
  }
}

function deliverGenericTerminalWatchCallback(input: {
  request: CallbackTransportDeliverInput;
  route: CallbackRouteV1;
  now(): Date;
  deliverChatSend(input: DeliverChatSendInput): CallbackProcessDelivery;
}): CallbackAttemptOutcome {
  const { request, route } = input;
  const legacyOptions = isRecord(request.context?.legacyOptions)
    ? request.context.legacyOptions
    : undefined;
  if (!legacyOptions) {
    return permanentFailure("openclaw_callback_context_missing");
  }
  const gatewayMethod = stringValue(legacyOptions.gatewayMethod);
  if (!gatewayMethod) {
    return permanentFailure("openclaw_gateway_method_missing");
  }
  if (gatewayMethod !== "chat.send") {
    return permanentFailure("openclaw_callback_profile_changed");
  }
  const controllerSessionId = stringValue(legacyOptions.gatewaySession) ??
    stringValue(legacyOptions.openclawSession);
  if (!controllerSessionId) {
    return permanentFailure("openclaw_controller_session_missing");
  }
  if (route.controller_session_id !== controllerSessionId) {
    return permanentFailure("openclaw_controller_session_changed");
  }
  const expectedRoute = createLegacyOpenClawCallbackRoute({
    controllerSessionId,
    gatewayMethod,
    openclawBin: legacyOptions.openclawBin,
    gatewayUrl: legacyOptions.gatewayUrl
  });
  if (!sameOpenClawProfile(route, expectedRoute)) {
    return permanentFailure("openclaw_callback_profile_changed");
  }

  let delivery: CallbackProcessDelivery;
  try {
    delivery = input.deliverChatSend({
      openclawBin: stringValue(legacyOptions.openclawBin),
      gatewayUrl: openClawGatewayUrlForInvocation(legacyOptions.gatewayUrl),
      token: stringValue(legacyOptions.token),
      params: {
        sessionKey: route.controller_session_id,
        message: request.envelope.event.body,
        idempotencyKey: request.envelope.idempotency_key,
        deliver: true
      }
    });
  } catch (error) {
    // deliverChatSend is one opaque invocation boundary. Once entered, an
    // unexpected throw cannot prove that chat.send did not reach the Gateway.
    return callbackFailureOutcome(error, input.now(), "uncertain");
  }

  let acknowledgement: CallbackWakeAcknowledgement;
  if (delivery.status !== 0) {
    try {
      // A matching acknowledgement is stronger evidence than the CLI exit
      // code: the Gateway established this exact idempotency key.
      acknowledgement = parseChatSendAcknowledgement(
        delivery.stdout,
        request.envelope.idempotency_key
      );
    } catch {
      const detail = cleanProcessText(delivery.stderr) ??
        cleanProcessText(delivery.stdout) ??
        `chat.send failed with status ${delivery.status}`;
      return callbackFailureOutcome(
        new Error(detail),
        input.now(),
        "uncertain"
      );
    }
  } else {
    try {
      acknowledgement = parseChatSendAcknowledgement(
        delivery.stdout,
        request.envelope.idempotency_key
      );
    } catch {
      return {
        disposition: "uncertain",
        error_code: "openclaw_chat_send_ack_uncertain",
        observed_at: input.now().toISOString()
      };
    }
  }
  const outcome: CallbackAttemptOutcome = {
    disposition: "accepted",
    accepted_at: input.now().toISOString(),
    acceptance_id: acknowledgement.runId,
    evidence: { status: acknowledgement.status }
  };
  try {
    request.reportCheckpoint?.(outcome);
  } catch {
    // The authoritative chat.send acknowledgement still wins. Returning the
    // accepted outcome gives the caller one final chance to durably settle it.
  }
  return outcome;
}

function openClawGatewayUrlForInvocation(value: unknown): string | undefined {
  const gatewayUrl = stringValue(value);
  return gatewayUrl === DEFAULT_OPENCLAW_GATEWAY_URL ? undefined : gatewayUrl;
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

function assertGatewayCallbackPlanTarget(input: {
  chatSendParams?: Record<string, unknown>;
  sessionSendParams?: Record<string, unknown>;
  expectedControllerSessionId: string;
  sideEffectPossible: boolean;
}): void {
  const actualControllerSessionId = input.chatSendParams
    ? stringValue(input.chatSendParams.sessionKey)
    : input.sessionSendParams
      ? stringValue(input.sessionSendParams.key)
      : undefined;
  if (
    actualControllerSessionId === undefined ||
    actualControllerSessionId === input.expectedControllerSessionId
  ) {
    return;
  }
  throw new OpenClawCallbackPlanError({
    message:
      "gateway callback delivery target does not match the immutable callback route",
    disposition: input.sideEffectPossible ? "uncertain" : "permanent_failure",
    errorCode: input.sideEffectPossible
      ? "openclaw_callback_target_mismatch_after_possible_acceptance"
      : "openclaw_callback_target_mismatch"
  });
}

function callbackPlanValidationError(
  error: unknown,
  sideEffectPossible: boolean
): OpenClawCallbackPlanError {
  const detail = error instanceof Error ? error.message : String(error);
  return new OpenClawCallbackPlanError({
    message: detail,
    disposition: sideEffectPossible ? "uncertain" : "permanent_failure",
    errorCode: sideEffectPossible
      ? "openclaw_callback_plan_invalid_after_possible_acceptance"
      : "openclaw_callback_plan_invalid"
  });
}

export function parseChatSendAcknowledgement(
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

    const expectedControllerSessionId =
      stringValue(options.gatewaySession) ??
      stringValue(options.openclawSession) ??
      stringValue(conversation.openclaw_session);
    if (!expectedControllerSessionId) {
      throw new Error("callback delivery requires a controller session");
    }
    const delivery = deliverGatewayMethod({
      method: options.gatewayMethod,
      openclawBin: options.openclawBin,
      gatewayUrl: options.gatewayUrl,
      token: options.token,
      sessionKey: expectedControllerSessionId,
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
    const explicitlyEnqueued =
      typeof gatewayPayload.enqueued === "boolean"
        ? gatewayPayload.enqueued
        : undefined;
    const gatewayHandledWithoutInjection =
      gatewayPayload.auto_approved === true ||
      gatewayPayload.approval_already_handled === true;
    const sideEffectPossible = explicitlyEnqueued !== false ||
      gatewayHandledWithoutInjection ||
      stringValue(gatewayPayload.injection_id) !== undefined;
    let chatSendParams: Record<string, unknown> | undefined;
    let sessionSendParams: Record<string, unknown> | undefined;
    try {
      ({ chatSendParams, sessionSendParams } =
        parseGatewayCallbackDeliveryPlan(gatewayPayload));
      assertGatewayCallbackPlanTarget({
        chatSendParams,
        sessionSendParams,
        expectedControllerSessionId,
        sideEffectPossible
      });
    } catch (error) {
      throw error instanceof OpenClawCallbackPlanError
        ? error
        : callbackPlanValidationError(error, sideEffectPossible);
    }
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
      const wakeError =
        wakeDelivery.stderr ||
        wakeDelivery.stdout ||
        `callback wake delivery failed with status ${wakeDelivery.status}`;
      const wake = {
        status: "failed",
        mode: wakePlan.mode,
        failed_at: ports.now().toISOString(),
        error: cleanProcessText(wakeError)
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
      if (injection.status === "unconfirmed") {
        // Older Gateway callback methods can return a wake plan without the
        // `enqueued` field. Once that opaque method has returned `ok`, a later
        // wake failure cannot prove the injection did not already happen.
        throw new OpenClawCallbackPlanError({
          message: wakeError,
          disposition: "uncertain",
          errorCode: "openclaw_callback_acceptance_uncertain"
        });
      }
      throw new Error(wakeError);
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
    kind: "openclaw_gateway_v1",
    deliver: (input) => deliverGenericOpenClawCallback({
      request: input,
      now: ports.now,
      deliverCallback,
      deliverChatSend
    }),
    deliverCallback,
    deliverGatewayMethod,
    deliverChatSend
  };
}
