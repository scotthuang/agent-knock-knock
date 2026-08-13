import {
  callbackDeliveryHasAcceptedTransport
} from "./callback-outbox-policy.js";
import type { CallbackDeliveryOutcome } from "./openclaw-callback-transport.js";
import {
  normalizeLegacyCallbackStatus,
  type AgentMessage,
  type Conversation
} from "./protocol.js";

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
  start(input: { statePath: string }): { pid?: number | null };
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
}

export interface SettleAcceptedCallbackInput {
  conversation: Conversation;
  statePath: string;
  logPath: string;
  expectedMessageId?: string;
  reason: string;
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
      state.save(prepared.statePath, {
        ...current,
        callback_delivery: {
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
        event: "callback_delivery_stage_updated",
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
          event: "callback_delivery_settle_skipped",
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
      if (result.delivered || recoveredFromAcceptedEvidence) {
        return persistDelivered({
          current,
          currentDelivery,
          prepared,
          result,
          recoveredFromAcceptedEvidence
        });
      }
      return persistFailed(current, currentDelivery, prepared, result.error);
    });
  }

  function settleAcceptedWhileLocked({
    conversation,
    statePath,
    logPath,
    expectedMessageId,
    reason
  }: SettleAcceptedCallbackInput): Conversation | undefined {
    const callbackDelivery = recordValue(conversation.callback_delivery);
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
    const settled: Conversation = {
      ...normalizedConversation,
      callback_delivery: {
        ...callbackDelivery,
        status: "delivered",
        accepted_at: stringValue(callbackDelivery.accepted_at) ??
          callbackDeliveryAcceptedAt(callbackDelivery) ??
          deliveredAt,
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
      }
    };
    state.save(statePath, settled);
    state.append(logPath, {
      ts: deliveredAt,
      conversation_id: settled.conversation_id,
      event: "callback_delivery_succeeded",
      message_id: callbackMessage.id,
      attempt: callbackDelivery.attempts,
      status: settled.status,
      state_preserved: true,
      accepted_evidence_recovery: true,
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
    recoveredFromAcceptedEvidence
  }: {
    current: Conversation;
    currentDelivery: Record<string, unknown>;
    prepared: PreparedCallbackDeliveryClaim;
    result: CallbackDeliverySettlementResult;
    recoveredFromAcceptedEvidence: boolean;
  }): Conversation {
    const deliveredAt = clock.now().toISOString();
    const normalizedCurrent = normalizeLegacyCallbackStatus(current);
    const nextConversation: Conversation = {
      ...normalizedCurrent,
      callback_delivery: {
        ...currentDelivery,
        status: "delivered",
        delivered_at: deliveredAt,
        accepted_at: stringValue(currentDelivery.accepted_at) ??
          callbackDeliveryAcceptedAt(currentDelivery) ??
          deliveredAt,
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
      }
    };
    state.save(prepared.statePath, nextConversation);
    state.append(prepared.logPath, {
      ts: deliveredAt,
      conversation_id: current.conversation_id,
      event: "callback_delivery_succeeded",
      message_id: prepared.message.id,
      attempt: prepared.deliveryAttempt,
      status: nextConversation.status,
      state_preserved: true,
      accepted_evidence_recovery: recoveredFromAcceptedEvidence,
      legacy_turn_status_migrated:
        normalizedCurrent.status !== current.status
    });
    return nextConversation;
  }

  function persistFailed(
    current: Conversation,
    currentDelivery: Record<string, unknown>,
    prepared: PreparedCallbackDeliveryClaim,
    error: unknown
  ): Conversation {
    const failedAt = clock.now().toISOString();
    const lastError = error instanceof Error ? error.message : String(error);
    const normalizedCurrent = normalizeLegacyCallbackStatus(current);
    const shouldLaunchRetry = prepared.options.retryPending !== true &&
      prepared.options.disableCallbackRetry !== true &&
      prepared.deliveryAttempt <= retryDelaysMs.length;
    const retryDelayMs = retryDelaysMs[
      Math.max(0, prepared.deliveryAttempt - 1)
    ];
    const launchedRetryMonitor = shouldLaunchRetry
      ? retryMonitor.start({ statePath: prepared.statePath })
      : undefined;
    const nextAttemptAt = launchedRetryMonitor
      ? new Date(clock.nowMs() + retryDelayMs).toISOString()
      : undefined;
    const failedConversation: Conversation = {
      ...normalizedCurrent,
      callback_delivery: {
        ...currentDelivery,
        status: "failed",
        failed_at: failedAt,
        last_error: lastError,
        preserve_conversation_status: true,
        attempt_pid: undefined,
        attempt_lease_expires_at: undefined,
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
      event: "callback_delivery_failed",
      message_id: prepared.message.id,
      attempt: prepared.deliveryAttempt,
      error: lastError,
      state_preserved: true,
      legacy_turn_status_migrated:
        normalizedCurrent.status !== current.status
    });
    if (launchedRetryMonitor) {
      state.append(prepared.logPath, {
        ts: clock.now().toISOString(),
        conversation_id: current.conversation_id,
        event: "callback_retry_monitor_launched",
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
  const delivery = recordValue(conversation.callback_delivery);
  const message = recordValue(delivery?.message);
  return delivery &&
      message?.id === prepared.message.id &&
      delivery.attempt_id === prepared.deliveryAttemptId &&
      Number(delivery.attempts) === prepared.deliveryAttempt &&
      delivery.status === "pending"
    ? delivery
    : undefined;
}

function callbackDeliveryAcceptedAt(
  callbackDelivery: Record<string, unknown>
): string | undefined {
  return stringValue(recordValue(callbackDelivery.wake)?.accepted_at) ??
    stringValue(recordValue(callbackDelivery.injection)?.accepted_at);
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
