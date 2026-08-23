import {
  callbackDeliveryHasAcceptedTransport,
  type CallbackDeliveryOutcome
} from "./callback-outbox-policy.js";
import {
  parseCallbackAttemptOutcome,
  type CallbackAttemptOutcome,
  type CallbackEnvelopeV1
} from "./callback-transport.js";
import {
  normalizeLegacyCallbackStatus,
  type AgentMessage,
  type Conversation
} from "./protocol.js";
import {
  nonBlankString as stringValue,
  recordValue
} from "./value-guards.js";

export type CallbackOutboxLane = "lifecycle" | "notification";
export type CallbackOutboxField =
  | "callback_delivery"
  | "callback_notification_delivery";

export function callbackOutboxField(
  lane: CallbackOutboxLane
): CallbackOutboxField {
  return lane === "notification"
    ? "callback_notification_delivery"
    : "callback_delivery";
}

export function callbackOutboxEvent(
  lane: CallbackOutboxLane,
  suffix: string
): string {
  return lane === "notification"
    ? `callback_notification_delivery_${suffix}`
    : `callback_delivery_${suffix}`;
}

export interface PreparedCallbackDeliveryClaim {
  options: {
    retryPending?: boolean;
    disableCallbackRetry?: boolean;
  };
  statePath: string;
  logPath: string;
  message: AgentMessage;
  deliveryAttempt: number;
  deliveryAttemptId: string;
  callbackOutboxLane?: CallbackOutboxLane;
  callbackEnvelope?: CallbackEnvelopeV1;
}

export interface CallbackOutboxSettlementStatePort {
  withStateTransaction<Result>(
    statePath: string,
    operation: () => Result
  ): Result;
  load(statePath: string): Conversation;
  save(statePath: string, conversation: Conversation): void;
  append(logPath: string, event: Record<string, unknown>): void;
}

export interface CallbackRetryMonitorPort {
  start(input: {
    statePath: string;
    callbackOutboxLane: CallbackOutboxLane;
  }): { pid?: number | null };
}

export interface CallbackOutboxSettlementPorts {
  state: CallbackOutboxSettlementStatePort;
  retryMonitor: CallbackRetryMonitorPort;
  clock: { now(): Date; nowMs(): number };
  attemptLeaseMs: number;
  retryDelaysMs: readonly number[];
}

export interface CallbackDeliverySettlementResult {
  delivered: boolean;
  error?: unknown;
  delivery?: CallbackDeliveryOutcome;
  /** Authoritative host-neutral result for this single transport attempt. */
  outcome?: CallbackAttemptOutcome;
}

export interface SettleAcceptedCallbackInput {
  conversation: Conversation;
  statePath: string;
  logPath: string;
  expectedMessageId?: string;
  reason: string;
  callbackOutboxLane?: CallbackOutboxLane;
}

export function createCallbackOutboxSettlement({
  state,
  retryMonitor,
  clock,
  attemptLeaseMs,
  retryDelaysMs
}: CallbackOutboxSettlementPorts) {
  function persistDeliveryProgress(
    prepared: PreparedCallbackDeliveryClaim,
    progress: Record<string, unknown>
  ): void {
    state.withStateTransaction(prepared.statePath, () => {
      const current = state.load(prepared.statePath);
      const currentDelivery = pendingDeliveryClaim(current, prepared);
      if (!currentDelivery) {
        throw new Error(
          `callback delivery claim changed before ${String(
            progress.stage ?? "progress"
          )} acknowledgement`
        );
      }
      const now = clock.now().toISOString();
      const { stage, ...fields } = progress;
      const lane = preparedCallbackOutboxLane(prepared);
      const outboxField = callbackOutboxField(lane);
      state.save(prepared.statePath, {
        ...current,
        [outboxField]: {
          ...currentDelivery,
          ...fields,
          updated_at: now,
          attempt_lease_expires_at: new Date(
            clock.nowMs() + attemptLeaseMs
          ).toISOString()
        }
      });
      state.append(prepared.logPath, {
        ts: now,
        conversation_id: current.conversation_id,
        event: callbackOutboxEvent(
          lane,
          "stage_updated"
        ),
        message_id: prepared.message.id,
        attempt: prepared.deliveryAttempt,
        stage,
        injection_status: recordValue(fields.injection)?.status,
        wake_status: recordValue(fields.wake)?.status,
        run_status: recordValue(fields.run_observation)?.status
      });
    });
  }

  function settleDelivery(
    prepared: PreparedCallbackDeliveryClaim,
    result: CallbackDeliverySettlementResult
  ): Conversation {
    return state.withStateTransaction(prepared.statePath, () => {
      const current = state.load(prepared.statePath);
      const currentDelivery = pendingDeliveryClaim(current, prepared);
      if (!currentDelivery) {
        state.append(prepared.logPath, {
          ts: clock.now().toISOString(),
          conversation_id: current.conversation_id,
          event: callbackOutboxEvent(
            preparedCallbackOutboxLane(prepared),
            "settle_skipped"
          ),
          message_id: prepared.message.id,
          attempt: prepared.deliveryAttempt,
          result: result.delivered ? "delivered" : "failed",
          reason: "callback delivery claim changed before settlement",
          current_status: current.status
        });
        return current;
      }

      const recoveredFromAcceptedEvidence = !result.delivered &&
        callbackDeliveryHasAcceptedTransport(currentDelivery);
      const outcome = settlementAttemptOutcome({
        currentDelivery,
        prepared,
        result,
        now: clock.now(),
        recoveredFromAcceptedEvidence
      });
      if (outcome.disposition === "accepted") {
        return persistDelivered({
          current,
          currentDelivery,
          prepared,
          result,
          outcome,
          recoveredFromAcceptedEvidence
        });
      }
      return persistFailed(
        current,
        currentDelivery,
        prepared,
        result.error,
        outcome
      );
    });
  }

  function settleAcceptedWhileLocked({
    conversation,
    statePath,
    logPath,
    expectedMessageId,
    reason,
    callbackOutboxLane = "lifecycle"
  }: SettleAcceptedCallbackInput): Conversation | undefined {
    const outboxField = callbackOutboxField(callbackOutboxLane);
    const callbackDelivery = recordValue(conversation[outboxField]);
    const callbackMessage = recordValue(callbackDelivery?.message);
    if (
      callbackDelivery?.status !== "pending" ||
      !callbackMessage ||
      (
        expectedMessageId !== undefined &&
        callbackMessage.id !== expectedMessageId
      ) ||
      !callbackDeliveryHasAcceptedTransport(callbackDelivery)
    ) {
      return undefined;
    }

    const deliveredAt = clock.now().toISOString();
    const normalizedConversation = normalizeLegacyCallbackStatus(conversation);
    const acceptedAt = stringValue(callbackDelivery.accepted_at) ??
      callbackDeliveryAcceptedAt(callbackDelivery) ??
      deliveredAt;
    const acceptedOutcome = acceptedAttemptOutcome({
      callbackDelivery,
      messageId: stringValue(callbackMessage.id) ??
        `legacy-callback:${conversation.conversation_id}:` +
          `${String(callbackDelivery.attempts ?? "unknown")}`,
      acceptedAt,
      evidence: { source: "legacy_transport_acceptance_recovery" }
    });
    const settled: Conversation = {
      ...normalizedConversation,
      [outboxField]: {
        ...callbackDelivery,
        status: "delivered",
        accepted_at: acceptedAt,
        attempt_outcome: acceptedOutcome,
        delivered_at: deliveredAt,
        recovered_at: deliveredAt,
        recovery_reason: reason,
        failed_at: undefined,
        last_error: undefined,
        attempt_pid: undefined,
        attempt_lease_expires_at: undefined,
        next_attempt_at: undefined,
        retry_monitor_pid: undefined,
        preserve_conversation_status: true,
        updated_at: deliveredAt
      },
      ...notificationAcceptanceFields(
        callbackOutboxLane,
        callbackMessage,
        acceptedAt
      )
    };
    state.save(statePath, settled);
    state.append(logPath, {
      ts: deliveredAt,
      conversation_id: settled.conversation_id,
      event: callbackOutboxEvent(callbackOutboxLane, "succeeded"),
      message_id: callbackMessage.id,
      attempt: callbackDelivery.attempts,
      status: settled.status,
      state_preserved: true,
      accepted_evidence_recovery: true,
      attempt_disposition: acceptedOutcome.disposition,
      reason,
      legacy_turn_status_migrated:
        normalizedConversation.status !== conversation.status
    });
    return settled;
  }

  function settleAccepted(
    input: Omit<SettleAcceptedCallbackInput, "conversation">
  ): Conversation | undefined {
    return state.withStateTransaction(input.statePath, () =>
      settleAcceptedWhileLocked({
        ...input,
        conversation: state.load(input.statePath)
      })
    );
  }

  function persistDelivered({
    current,
    currentDelivery,
    prepared,
    result,
    outcome,
    recoveredFromAcceptedEvidence
  }: {
    current: Conversation;
    currentDelivery: Record<string, unknown>;
    prepared: PreparedCallbackDeliveryClaim;
    result: CallbackDeliverySettlementResult;
    outcome: Extract<CallbackAttemptOutcome, { disposition: "accepted" }>;
    recoveredFromAcceptedEvidence: boolean;
  }): Conversation {
    const deliveredAt = clock.now().toISOString();
    const normalizedCurrent = normalizeLegacyCallbackStatus(current);
    const lane = preparedCallbackOutboxLane(prepared);
    const outboxField = callbackOutboxField(lane);
    const nextConversation: Conversation = {
      ...normalizedCurrent,
      [outboxField]: {
        ...currentDelivery,
        status: "delivered",
        delivered_at: deliveredAt,
        accepted_at: stringValue(currentDelivery.accepted_at) ??
          outcome.accepted_at,
        attempt_outcome: outcome,
        last_error: undefined,
        attempt_pid: undefined,
        attempt_lease_expires_at: undefined,
        next_attempt_at: undefined,
        retry_monitor_pid: undefined,
        preserve_conversation_status: true,
        updated_at: deliveredAt,
        ...(result.delivery
          ? {
              injection: result.delivery.injection,
              wake: result.delivery.wake,
              run_observation: result.delivery.run_observation
            }
          : {})
      },
      ...notificationAcceptanceFields(
        lane,
        prepared.message,
        outcome.accepted_at
      )
    };
    state.save(prepared.statePath, nextConversation);
    state.append(prepared.logPath, {
      ts: deliveredAt,
      conversation_id: current.conversation_id,
      event: callbackOutboxEvent(
        lane,
        "succeeded"
      ),
      message_id: prepared.message.id,
      attempt: prepared.deliveryAttempt,
      status: nextConversation.status,
      state_preserved: true,
      accepted_evidence_recovery: recoveredFromAcceptedEvidence,
      attempt_disposition: outcome.disposition,
      legacy_turn_status_migrated:
        normalizedCurrent.status !== current.status
    });
    return nextConversation;
  }

  function persistFailed(
    current: Conversation,
    currentDelivery: Record<string, unknown>,
    prepared: PreparedCallbackDeliveryClaim,
    error: unknown,
    outcome: Exclude<CallbackAttemptOutcome, { disposition: "accepted" }>
  ): Conversation {
    const failedAt = clock.now().toISOString();
    const lastError = error === undefined
      ? outcome.error_code
      : error instanceof Error ? error.message : String(error);
    const normalizedCurrent = normalizeLegacyCallbackStatus(current);
    const shouldLaunchRetry = outcome.disposition === "retryable_failure" &&
      prepared.options.retryPending !== true &&
      prepared.options.disableCallbackRetry !== true &&
      prepared.deliveryAttempt <= retryDelaysMs.length;
    const retryDelayMs = retryDelaysMs[
      Math.max(0, prepared.deliveryAttempt - 1)
    ];
    const launchedRetryMonitor = shouldLaunchRetry
      ? retryMonitor.start({
          statePath: prepared.statePath,
          callbackOutboxLane: preparedCallbackOutboxLane(prepared)
        })
      : undefined;
    const nextAttemptAt = launchedRetryMonitor
      ? new Date(clock.nowMs() + retryDelayMs).toISOString()
      : undefined;
    const failedConversation: Conversation = {
      ...normalizedCurrent,
      [callbackOutboxField(preparedCallbackOutboxLane(prepared))]: {
        ...currentDelivery,
        status: "failed",
        failed_at: failedAt,
        last_error: lastError,
        attempt_outcome: outcome,
        preserve_conversation_status: true,
        attempt_pid: undefined,
        attempt_lease_expires_at: undefined,
        retry_monitor_pid: undefined,
        next_attempt_at: undefined,
        updated_at: failedAt,
        ...(launchedRetryMonitor
          ? {
              retry_monitor_pid: launchedRetryMonitor.pid ?? null,
              next_attempt_at: nextAttemptAt
            }
          : {})
      }
    };
    state.save(prepared.statePath, failedConversation);
    state.append(prepared.logPath, {
      ts: failedAt,
      conversation_id: current.conversation_id,
      event: callbackOutboxEvent(
        preparedCallbackOutboxLane(prepared),
        "failed"
      ),
      message_id: prepared.message.id,
      attempt: prepared.deliveryAttempt,
      error: lastError,
      attempt_disposition: outcome.disposition,
      state_preserved: true,
      legacy_turn_status_migrated:
        normalizedCurrent.status !== current.status
    });
    if (launchedRetryMonitor) {
      state.append(prepared.logPath, {
        ts: clock.now().toISOString(),
        conversation_id: current.conversation_id,
        event: preparedCallbackOutboxLane(prepared) === "notification"
          ? "callback_notification_retry_monitor_launched"
          : "callback_retry_monitor_launched",
        message_id: prepared.message.id,
        pid: launchedRetryMonitor.pid ?? null,
        next_attempt_at: nextAttemptAt
      });
    }
    return failedConversation;
  }

  return {
    persistDeliveryProgress,
    settleDelivery,
    settleAcceptedWhileLocked,
    settleAccepted
  };
}

function pendingDeliveryClaim(
  conversation: Conversation,
  prepared: PreparedCallbackDeliveryClaim
): Record<string, unknown> | undefined {
  const delivery = recordValue(
    conversation[callbackOutboxField(preparedCallbackOutboxLane(prepared))]
  );
  const message = recordValue(delivery?.message);
  return delivery &&
      message?.id === prepared.message.id &&
      delivery.attempt_id === prepared.deliveryAttemptId &&
      Number(delivery.attempts) === prepared.deliveryAttempt &&
      delivery.status === "pending"
    ? delivery
    : undefined;
}

function preparedCallbackOutboxLane(
  prepared: PreparedCallbackDeliveryClaim
): CallbackOutboxLane {
  return prepared.callbackOutboxLane ?? "lifecycle";
}

function notificationAcceptanceFields(
  lane: CallbackOutboxLane,
  message: { id?: unknown },
  acceptedAt: string
): Record<string, unknown> {
  return lane === "notification"
    ? {
        stalled_notification_sent_at: acceptedAt,
        stalled_notification_message_id: message.id
      }
    : {};
}

function callbackDeliveryAcceptedAt(
  callbackDelivery: Record<string, unknown>
): string | undefined {
  return stringValue(recordValue(callbackDelivery.wake)?.accepted_at) ??
    stringValue(recordValue(callbackDelivery.injection)?.accepted_at);
}

function settlementAttemptOutcome(input: {
  currentDelivery: Record<string, unknown>;
  prepared: PreparedCallbackDeliveryClaim;
  result: CallbackDeliverySettlementResult;
  now: Date;
  recoveredFromAcceptedEvidence: boolean;
}): CallbackAttemptOutcome {
  if (input.recoveredFromAcceptedEvidence) {
    return acceptedAttemptOutcome({
      callbackDelivery: input.currentDelivery,
      callbackEnvelope: input.prepared.callbackEnvelope,
      messageId: input.prepared.message.id,
      acceptedAt: callbackDeliveryAcceptedAt(input.currentDelivery) ??
        input.now.toISOString(),
      evidence: { source: "legacy_transport_acceptance_recovery" }
    });
  }
  const explicit = input.result.outcome ??
    input.result.delivery?.attempt_outcome;
  if (explicit !== undefined) {
    return parseCallbackAttemptOutcome(explicit);
  }
  if (input.result.delivered) {
    return acceptedAttemptOutcome({
      callbackDelivery: input.currentDelivery,
      callbackEnvelope: input.prepared.callbackEnvelope,
      messageId: input.prepared.message.id,
      acceptedAt: callbackDeliveryAcceptedAt(input.currentDelivery) ??
        input.now.toISOString(),
      evidence: {
        source: "legacy_delivery_result",
        ...(stringValue(input.result.delivery?.kind)
          ? { transport_kind: input.result.delivery?.kind }
          : {})
      }
    });
  }
  return {
    disposition: "retryable_failure",
    error_code: "callback_delivery_failed",
    evidence: { source: "legacy_delivery_exception" }
  };
}

function acceptedAttemptOutcome(input: {
  callbackDelivery: Record<string, unknown>;
  callbackEnvelope?: CallbackEnvelopeV1;
  messageId: string;
  acceptedAt: string;
  evidence: Record<string, unknown>;
}): Extract<CallbackAttemptOutcome, { disposition: "accepted" }> {
  if (Object.hasOwn(input.callbackDelivery, "attempt_outcome")) {
    const existing = parseCallbackAttemptOutcome(
      input.callbackDelivery.attempt_outcome
    );
    if (existing.disposition === "accepted") {
      return existing;
    }
  }
  const persistedEnvelope = recordValue(
    input.callbackDelivery.callback_envelope
  );
  return {
    disposition: "accepted",
    accepted_at: input.acceptedAt,
    acceptance_id: input.callbackEnvelope?.delivery_id ??
      stringValue(persistedEnvelope?.delivery_id) ??
      input.messageId,
    evidence: input.evidence
  };
}
