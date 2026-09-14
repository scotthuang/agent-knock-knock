import type { CallbackAttemptOutcome } from "./callback-transport.js";

/**
 * Store-neutral claim metadata shared by durable callback and Watch outboxes.
 * Persistence adapters deliberately choose their own status names and fields.
 */
export interface DurableNotificationLease {
  attempt: number;
  attemptId: string;
  attemptedAt: string;
  leaseExpiresAt: string;
}

export function createDurableNotificationLease(input: {
  previousAttempts: number;
  attemptId: string;
  attemptedAt: string;
  leaseBaseMs: number;
  leaseMs: number;
}): DurableNotificationLease {
  return {
    attempt: input.previousAttempts + 1,
    attemptId: input.attemptId,
    attemptedAt: input.attemptedAt,
    leaseExpiresAt: new Date(
      input.leaseBaseMs + input.leaseMs
    ).toISOString()
  };
}

export type DurableNotificationRetryDecision =
  | { state: "retryable"; attempt: number }
  | { state: "waiting"; attempt: number; retry_at?: string }
  | { state: "in_flight"; attempt: number; lease_expires_at?: string }
  | { state: "non_retryable"; attempt: number }
  | { state: "settled"; attempt: number }
  | { state: "exhausted"; attempt: number };

export type DurableNotificationRetryFacts =
  | {
      phase: "ready";
      attempt: number;
      maxAttempts?: number;
    }
  | {
      phase: "retry_wait";
      attempt: number;
      nowMs: number;
      retryAt?: string;
      retryAuthorized: boolean;
      maxAttempts?: number;
    }
  | {
      phase: "leased";
      attempt: number;
      nowMs: number;
      leaseExpiresAt?: string;
      maxAttempts?: number;
    }
  | {
      phase: "settled";
      attempt: number;
    };

/**
 * Decide whether a durable notification attempt may be claimed. The caller
 * supplies only persisted facts plus its clock observation; no I/O or Store
 * shape is owned here.
 */
export function decideDurableNotificationRetry(
  facts: DurableNotificationRetryFacts
): DurableNotificationRetryDecision {
  if (
    facts.phase !== "settled" &&
    facts.maxAttempts !== undefined &&
    facts.attempt > facts.maxAttempts
  ) {
    return { state: "exhausted", attempt: facts.attempt };
  }
  if (facts.phase === "ready") {
    return { state: "retryable", attempt: facts.attempt };
  }
  if (facts.phase === "retry_wait") {
    if (!facts.retryAuthorized) {
      return { state: "non_retryable", attempt: facts.attempt };
    }
    const retryAtMs = Date.parse(facts.retryAt ?? "");
    return retryAtMs <= facts.nowMs
      ? { state: "retryable", attempt: facts.attempt }
      : {
          state: "waiting",
          attempt: facts.attempt,
          retry_at: facts.retryAt
        };
  }
  if (facts.phase === "leased") {
    const leaseExpiresAtMs = Date.parse(facts.leaseExpiresAt ?? "");
    return leaseExpiresAtMs <= facts.nowMs
      ? { state: "retryable", attempt: facts.attempt }
      : {
          state: "in_flight",
          attempt: facts.attempt,
          lease_expires_at: facts.leaseExpiresAt
        };
  }
  return { state: "settled", attempt: facts.attempt };
}

export type DurableNotificationSettlement =
  | {
      state: "accepted";
      outcome: Extract<CallbackAttemptOutcome, { disposition: "accepted" }>;
    }
  | {
      state: "superseded";
      outcome: Exclude<CallbackAttemptOutcome, { disposition: "accepted" }>;
    }
  | {
      state: "failed";
      outcome: Exclude<CallbackAttemptOutcome, { disposition: "accepted" }>;
      retryAuthorized: boolean;
    };

/**
 * Reduce one authoritative transport outcome into a Store-neutral settlement.
 * Conversation and Watch adapters retain their distinct status/error schemas.
 */
export function reduceDurableNotificationSettlement(input: {
  attempt: number;
  outcome: CallbackAttemptOutcome;
  retryEnabled: boolean;
  maxRetryAttempts?: number;
  supersede?: boolean;
}): DurableNotificationSettlement {
  if (input.outcome.disposition === "accepted") {
    return { state: "accepted", outcome: input.outcome };
  }
  if (input.supersede === true) {
    return { state: "superseded", outcome: input.outcome };
  }
  return {
    state: "failed",
    outcome: input.outcome,
    retryAuthorized: input.outcome.disposition === "retryable_failure" &&
      input.retryEnabled &&
      (
        input.maxRetryAttempts === undefined ||
        input.attempt <= input.maxRetryAttempts
      )
  };
}
