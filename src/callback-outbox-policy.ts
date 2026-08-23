import {
  nonBlankString as stringValue,
  recordValue
} from "./value-guards.js";
import type { AgentMessage, Conversation } from "./protocol.js";
import {
  parseCallbackAttemptOutcome,
  type CallbackAttemptOutcome,
  type CallbackEnvelopeV1,
  type CallbackRouteV1,
  type CallbackTransportAttemptV1
} from "./callback-transport.js";

export type {
  CallbackAttemptOutcome,
  CallbackEnvelopeV1,
  CallbackRouteV1
} from "./callback-transport.js";

export interface CallbackDeliveryOutcome {
  kind: string;
  injection: Record<string, unknown>;
  wake: Record<string, unknown>;
  run_observation?: Record<string, unknown>;
  /** Generic evidence written alongside the legacy OpenClaw shape. */
  attempt_outcome?: CallbackAttemptOutcome;
}

export interface CallbackProcessFailureObservation {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: { message?: string };
}

/**
 * Fence an advisory outbox when its underlying Turn moves on. Accepted
 * transport evidence is retained for settlement; only unaccepted work is
 * superseded so a late retry cannot notify the previous lifecycle phase.
 */
export function supersedeCallbackNotificationDelivery(
  conversation: Conversation,
  input: { at: string; reason: string }
): Conversation {
  const delivery = recordValue(conversation.callback_notification_delivery);
  if (
    !delivery ||
    !["pending", "failed"].includes(String(delivery.status ?? "")) ||
    callbackDeliveryHasAcceptedTransport(delivery)
  ) {
    return conversation;
  }
  return {
    ...conversation,
    callback_notification_delivery: {
      ...delivery,
      status: "superseded",
      superseded_at: input.at,
      superseded_reason: input.reason,
      attempt_pid: undefined,
      attempt_lease_expires_at: undefined,
      retry_monitor_pid: undefined,
      next_attempt_at: undefined,
      updated_at: input.at
    }
  };
}

export function classifyCallbackProcessFailure(
  result: CallbackProcessFailureObservation
): string | undefined {
  const status = result.status ?? 0;
  const combined = [
    result.error?.message,
    result.stderr,
    result.stdout
  ].filter(Boolean).join("\n").toLowerCase();
  if (!combined && status === 0) {
    return undefined;
  }
  if (isRemoteCompactStreamDisconnect(combined)) {
    return "transient_remote_compact_failure";
  }
  if (
    combined.includes("agent needs reconnect") ||
    combined.includes("internal error")
  ) {
    return "agent_reconnect_required";
  }
  if (
    combined.includes("permission denied") ||
    combined.includes("operation not permitted")
  ) {
    return "permission_denied";
  }
  if (
    combined.includes("sandbox") ||
    combined.includes("outside workspace")
  ) {
    return "sandbox_denied";
  }
  if (combined.includes("timed out") || combined.includes("timeout")) {
    return "timeout";
  }
  return status !== 0 ? "nonzero_exit" : undefined;
}

function isRemoteCompactStreamDisconnect(text: unknown): boolean {
  const value = String(text ?? "").toLowerCase();
  return value.includes("error running remote compact task") &&
    value.includes("stream disconnected") &&
    value.includes("/codex/responses/compact");
}

export interface CallbackDeliveryOptions {
  callbackRoute?: CallbackRouteV1;
  gatewayMethod?: string;
  openclawBin?: string;
  gatewayUrl?: string;
  token?: string;
  gatewaySession?: string;
  openclawSession?: string;
}

export interface DeliverCallbackInput {
  options: CallbackDeliveryOptions;
  statePath: string;
  logPath: string;
  conversation: Conversation;
  message: AgentMessage;
  /** Immutable prepared outbox claim crossing the transport boundary. */
  attempt: CallbackTransportAttemptV1;
  route?: CallbackRouteV1;
  envelope?: CallbackEnvelopeV1;
  onProgress?: (progress: Record<string, unknown>) => void;
  onAccepted?: (outcome: CallbackDeliveryOutcome) => void;
}

export type CallbackRetryDisposition =
  | { state: "retryable"; attempt: number }
  | {
      state: "in_flight";
      attempt: number;
      attempt_pid?: number;
      lease_expires_at?: string;
      next_attempt_at?: string;
    }
  | { state: "accepted"; attempt: number }
  | {
      state: "permanent_failure";
      attempt: number;
      reason: string;
    }
  | {
      state: "uncertain";
      attempt: number;
      reason: string;
    }
  | { state: "exhausted"; attempt: number }
  | { state: "unavailable"; attempt: number; reason: string };

export type CallbackRetryPolicyState =
  | {
      phase: "decided";
      disposition: CallbackRetryDisposition;
    }
  | {
      phase: "observe_process";
      attempt: number;
      attempt_pid: number;
      effective_lease_expires_at_ms?: number;
      persisted_lease_expires_at?: string;
      next_attempt_at?: string;
    }
  | {
      phase: "observe_clock";
      attempt: number;
      attempt_pid: number;
      effective_lease_expires_at_ms: number;
      persisted_lease_expires_at?: string;
      next_attempt_at?: string;
    };

export type CallbackRetryObservation =
  | { kind: "process_alive"; alive: boolean }
  | { kind: "clock"; now_ms: number };

export interface CallbackRetryPolicyLimits {
  attemptLeaseMs: number;
  retryDelayCount: number;
}

/**
 * Classify durable callback-outbox evidence before observing live process or
 * clock state. The returned phase names the first ephemeral observation the
 * caller may need; already-decided states never authorize either observation.
 */
export function beginCallbackRetryPolicy(
  callbackDelivery: unknown,
  limits: CallbackRetryPolicyLimits
): CallbackRetryPolicyState {
  const delivery = recordValue(callbackDelivery);
  const attemptValue = Number(delivery?.attempts ?? 0);
  const attempt = Number.isSafeInteger(attemptValue) && attemptValue >= 0
    ? attemptValue
    : 0;
  if (
    !delivery ||
    !recordValue(delivery.message) ||
    !["pending", "failed"].includes(String(delivery.status ?? ""))
  ) {
    return decided({
      state: "unavailable",
      attempt,
      reason: "no pending or failed callback outbox is available"
    });
  }
  const attemptOutcome = callbackAttemptOutcomeEvidence(delivery);
  if (attemptOutcome.kind === "invalid") {
    return decided({
      state: "unavailable",
      attempt,
      reason: attemptOutcome.reason
    });
  }
  if (attemptOutcome.kind === "present") {
    if (attemptOutcome.outcome.disposition === "accepted") {
      return decided({ state: "accepted", attempt });
    }
    if (attemptOutcome.outcome.disposition === "permanent_failure") {
      return decided({
        state: "permanent_failure",
        attempt,
        reason: attemptOutcome.outcome.error_code
      });
    }
    if (attemptOutcome.outcome.disposition === "uncertain") {
      return decided({
        state: "uncertain",
        attempt,
        reason: attemptOutcome.outcome.error_code
      });
    }
  }
  if (callbackDeliveryHasAcceptedTransport(delivery)) {
    return decided({ state: "accepted", attempt });
  }
  if (!Number.isSafeInteger(attemptValue) || attemptValue < 1) {
    return decided({
      state: "unavailable",
      attempt,
      reason: "callback outbox has invalid attempt metadata"
    });
  }
  if (attemptValue > limits.retryDelayCount) {
    return decided({ state: "exhausted", attempt });
  }
  if (delivery.status === "failed") {
    return decided({ state: "retryable", attempt });
  }

  const attemptPidValue = Number(delivery.attempt_pid);
  const attemptPid = Number.isSafeInteger(attemptPidValue) && attemptPidValue > 0
    ? attemptPidValue
    : undefined;
  if (attemptPid === undefined) {
    return decided({ state: "retryable", attempt });
  }

  const persistedLeaseExpiresAt = stringValue(
    delivery.attempt_lease_expires_at
  );
  const leaseExpiresAtMs = validTimestampMs(persistedLeaseExpiresAt);
  const legacyLastAttemptAtMs = validTimestampMs(delivery.last_attempt_at);
  return {
    phase: "observe_process",
    attempt,
    attempt_pid: attemptPid,
    effective_lease_expires_at_ms: leaseExpiresAtMs ??
      (legacyLastAttemptAtMs === undefined
        ? undefined
        : legacyLastAttemptAtMs + limits.attemptLeaseMs),
    persisted_lease_expires_at: persistedLeaseExpiresAt,
    next_attempt_at: stringValue(delivery.next_attempt_at)
  };
}

/**
 * Advance one callback retry observation without performing I/O. A live
 * process advances to a clock observation only when usable lease evidence is
 * present, preserving the legacy short-circuit order.
 */
export function reduceCallbackRetryPolicy(
  state: CallbackRetryPolicyState,
  observation: CallbackRetryObservation
): CallbackRetryPolicyState {
  if (state.phase === "decided") {
    throw new Error("callback retry policy is already decided");
  }
  if (state.phase === "observe_process") {
    if (observation.kind !== "process_alive") {
      throw new Error("callback retry policy requires a process observation");
    }
    if (!observation.alive || state.effective_lease_expires_at_ms === undefined) {
      return decided({ state: "retryable", attempt: state.attempt });
    }
    return {
      phase: "observe_clock",
      attempt: state.attempt,
      attempt_pid: state.attempt_pid,
      effective_lease_expires_at_ms: state.effective_lease_expires_at_ms,
      persisted_lease_expires_at: state.persisted_lease_expires_at,
      next_attempt_at: state.next_attempt_at
    };
  }
  if (observation.kind !== "clock") {
    throw new Error("callback retry policy requires a clock observation");
  }
  if (state.effective_lease_expires_at_ms > observation.now_ms) {
    return decided({
      state: "in_flight",
      attempt: state.attempt,
      attempt_pid: state.attempt_pid,
      lease_expires_at: state.persisted_lease_expires_at ??
        new Date(state.effective_lease_expires_at_ms).toISOString(),
      next_attempt_at: state.next_attempt_at
    });
  }
  return decided({ state: "retryable", attempt: state.attempt });
}

export function callbackDeliveryHasAcceptedTransport(
  callbackDelivery: unknown
): boolean {
  const delivery = recordValue(callbackDelivery);
  const attemptOutcome = callbackAttemptOutcomeEvidence(delivery);
  if (attemptOutcome.kind === "invalid") {
    return false;
  }
  if (
    attemptOutcome.kind === "present" &&
    attemptOutcome.outcome.disposition === "accepted"
  ) {
    return true;
  }
  const injection = recordValue(delivery?.injection);
  const wake = recordValue(delivery?.wake);
  return injection?.status === "accepted" || wake?.status === "accepted";
}

export function callbackDeliveryAttemptOutcome(
  callbackDelivery: unknown
): CallbackAttemptOutcome | undefined {
  const delivery = recordValue(callbackDelivery);
  if (!delivery || !Object.hasOwn(delivery, "attempt_outcome")) {
    return undefined;
  }
  return parseCallbackAttemptOutcome(delivery.attempt_outcome);
}

type CallbackAttemptOutcomeEvidence =
  | { kind: "missing" }
  | { kind: "present"; outcome: CallbackAttemptOutcome }
  | { kind: "invalid"; reason: string };

function callbackAttemptOutcomeEvidence(
  delivery: Record<string, unknown> | undefined
): CallbackAttemptOutcomeEvidence {
  if (!delivery || !Object.hasOwn(delivery, "attempt_outcome")) {
    return { kind: "missing" };
  }
  try {
    return {
      kind: "present",
      outcome: parseCallbackAttemptOutcome(delivery.attempt_outcome)
    };
  } catch (error) {
    return {
      kind: "invalid",
      reason: "callback outbox has invalid attempt outcome: " +
        (error instanceof Error ? error.message : String(error))
    };
  }
}

function decided(
  disposition: CallbackRetryDisposition
): CallbackRetryPolicyState {
  return { phase: "decided", disposition };
}


function validTimestampMs(value: unknown): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}
