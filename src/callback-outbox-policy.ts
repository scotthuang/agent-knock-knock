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
  const injection = recordValue(delivery?.injection);
  const wake = recordValue(delivery?.wake);
  return injection?.status === "accepted" || wake?.status === "accepted";
}

function decided(
  disposition: CallbackRetryDisposition
): CallbackRetryPolicyState {
  return { phase: "decided", disposition };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function validTimestampMs(value: unknown): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}
