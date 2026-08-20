import { createHash, randomUUID } from "node:crypto";
import {
  applyMessageToConversation,
  createMessage,
  effectiveTurnStatus,
  executorForConversation,
  extractStructuredMessage,
  isTurnPhaseStatus,
  normalizeLegacyCallbackStatus,
  parseMessageJson,
  turnIdForConversation,
  type AgentMessage,
  type Actor,
  type Conversation,
  type ConversationStatus,
  type TurnPhaseStatus
} from "./protocol.js";
import type {
  TerminalCompletionEvidence,
  TerminalControlRef
} from "./terminal-agent-adapter.js";
import type {
  CallbackDeliveryOptions,
  CallbackDeliveryOutcome,
  CallbackRetryDisposition,
  DeliverCallbackInput
} from "./callback-outbox-policy.js";
import {
  beginCallbackRetryPolicy,
  reduceCallbackRetryPolicy
} from "./callback-outbox-policy.js";
import { createCallbackOutboxSettlement } from "./callback-outbox-settlement.js";
import type { TranscriptEvent } from "./transcript.js";
import { canonicalJson } from "./canonical-json.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
type CallbackSettlement = ReturnType<typeof createCallbackOutboxSettlement>;

export interface CallbackPreparationOptions
  extends CallbackDeliveryOptions {
  statePath: string;
  messageJson?: string;
  log?: string;
  conversationOverride?: unknown;
  callbackDeliveryKind?: string;
  allowTerminalCompletionRecoveryStatus?: boolean;
  closeTerminalBridgeOnDone?: boolean;
  disableCallbackRetry?: boolean;
  preserveMessageId?: boolean;
  recordOnly?: boolean;
  recoverMissingOutbox?: boolean;
  recoverTerminalCompletion?: boolean;
  retryPending?: boolean;
}

export interface PrepareCallbackOutboxInput {
  options: CallbackPreparationOptions;
  logPath: string;
}

interface PreparedCallbackBase {
  conversation: Conversation;
  message: AgentMessage;
}

export interface PreparedCallbackWithoutDelivery extends PreparedCallbackBase {
  outcome: "duplicate" | "record_only";
}

export interface PreparedCallbackDelivery extends PreparedCallbackBase {
  outcome: "deliver";
  options: CallbackPreparationOptions;
  statePath: string;
  logPath: string;
  deliveryAttempt: number;
  deliveryAttemptId: string;
}

export type PreparedCallback =
  | PreparedCallbackWithoutDelivery
  | PreparedCallbackDelivery;

type CallbackRetryMonitorObservation =
  | { kind: "stop" }
  | { kind: "accepted"; messageId?: string }
  | { kind: "in_flight" }
  | {
      kind: "retryable";
      conversation: Conversation;
      delivery: Record<string, unknown>;
      attempts: number;
    };

export interface CallbackExecutionResult {
  delivered: boolean;
  duplicate: boolean;
  conversation: Conversation;
  message: unknown;
  delivery?: string;
}

export interface CallbackDeliveryReconciliationInput {
  statePath: string;
  logPath: string;
  delayMs?: unknown;
}

export interface CallbackRetryMonitorInput {
  statePath: string;
  initialDelayMs?: unknown;
}

export interface RetryCallbackInput {
  options: CallbackPreparationOptions;
  conversation: Conversation;
  statePath: string;
  logPath: string;
}

export type RetryCallbackOutcome =
  | { kind: "recovered"; result: CallbackExecutionResult }
  | { kind: "retried"; result: CallbackExecutionResult };

export interface TerminalCompletionPreparationInput {
  options: CallbackPreparationOptions;
  statePath: string;
  logPath: string;
  conversationId: string;
  actor: Actor;
  terminalControl: TerminalControlRef;
  terminalMessageId: string;
  completion: TerminalCompletionEvidence;
  allowSupersedeRecovery?: boolean;
  completionFingerprint?: string;
}

export interface ApprovalNotificationPreparationInput {
  options: CallbackPreparationOptions;
  statePath: string;
  logPath: string;
  conversation: Conversation;
  actor: Actor;
  type: "blocked" | "question";
  body: string;
  metadata: Record<string, unknown>;
  recoverMissingOutbox?: boolean;
}

export interface CallbackOutboxServicePorts {
  state: {
    load(statePath: string): Conversation;
    save(statePath: string, conversation: Conversation): void;
    readEvents(logPath: string): TranscriptEvent[];
    append(logPath: string, event: Record<string, unknown>): void;
    appendMessage(logPath: string, message: AgentMessage): void;
    assertWriterCompatible(storeDir: string): void;
    withTransaction<Result>(
      statePath: string,
      operation: () => Result
    ): Result;
    storeDirForStatePath(statePath: string): string;
    logPathForStatePath(statePath: string): string;
  };
  authority: {
    assertNoDeferredTransfer(input: {
      storeDir: string;
      conversation: Conversation;
      action: string;
    }): void;
    assertBindingCurrent(conversation: Conversation, action: string): void;
    isDispatchReleased(conversation: Conversation): boolean;
    isWaitingForAgent(status: ConversationStatus): boolean;
    isTerminalBridgeSupersedeStatus(status: ConversationStatus): boolean;
    resolveCompletionDispatch(input: {
      terminalControl: TerminalControlRef;
      conversation: Conversation;
      expectedMessageId: string;
      reason: string;
    }): boolean;
  };
  retry: {
    startMonitor(input: {
      statePath: string;
      delayMs: number;
    }): { pid?: number | null };
    isProcessAlive(pid: number): boolean;
    attemptLeaseMs: number;
    delaysMs: readonly number[];
  };
  runtime: {
    now(): Date;
    nowMs(): number;
    pid(): number;
    log(
      level: "info" | "warn" | "error",
      event: string,
      fields: Record<string, unknown>
    ): void;
    textSummary(value: unknown): unknown;
    sleepSync(milliseconds: number): void;
    crashCheckpoint(name: "after_local_completion_state"): void;
  };
  delivery: {
    deliver(input: DeliverCallbackInput): CallbackDeliveryOutcome;
    runTransaction(options: CallbackPreparationOptions): CallbackExecutionResult;
  };
}

export interface CallbackGatewayRouteCandidate {
  gatewayUrl?: unknown;
  token?: unknown;
}

export function resolveCallbackGatewayRoute(
  ...candidates: CallbackGatewayRouteCandidate[]
) {
  for (const candidate of candidates) {
    const token = stringValue(candidate.token);
    if (!token || token === "<token>") {
      continue;
    }
    return {
      gatewayUrl: stringValue(candidate.gatewayUrl),
      token
    };
  }
  return {
    gatewayUrl: undefined,
    token: undefined
  };
}

export function createCallbackOutboxService(
  ports: CallbackOutboxServicePorts
) {
  const settlement = createCallbackOutboxSettlement({
    state: {
      withStateTransaction: ports.state.withTransaction,
      load: ports.state.load,
      save: ports.state.save,
      append: ports.state.append
    },
    retryMonitor: {
      start: ({ statePath }) => ports.retry.startMonitor({
        statePath,
        delayMs: ports.retry.delaysMs[0]
      })
    },
    clock: { now: ports.runtime.now, nowMs: ports.runtime.nowMs },
    attemptLeaseMs: ports.retry.attemptLeaseMs,
    retryDelaysMs: ports.retry.delaysMs
  });
  function prepare({
    options,
    logPath
  }: PrepareCallbackOutboxInput): PreparedCallback {
    const messageInput = requiredMessageJson(options.messageJson);
    const loadedConversation = isRecord(options.conversationOverride)
      ? options.conversationOverride
      : ports.state.load(options.statePath);
    const conversation = normalizeLegacyCallbackStatus(
      loadedConversation as Conversation
    );
    const storeDir = ports.state.storeDirForStatePath(options.statePath);
    ports.authority.assertNoDeferredTransfer({
      storeDir,
      conversation,
      action: "prepare callback for"
    });
    const executor = executorForConversation(conversation);
    const persistedGatewayRoute = resolveCallbackGatewayRoute({
      gatewayUrl: options.gatewayUrl,
      token: options.token
    });
    const message = options.retryPending === true ||
        options.preserveMessageId === true
      ? parseMessageJson(messageInput)
      : extractStructuredMessage({
          conversation,
          input: messageInput,
          defaultFrom: executor.actor,
          defaultTo: "openclaw"
        });
    if (message.conversation_id !== conversation.conversation_id) {
      throw new Error(
        `message.conversation_id ${message.conversation_id} does not match conversation ${conversation.conversation_id}`
      );
    }

    const existingEvents = ports.state.readEvents(logPath);
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    const persistedDeliveryMessage = isRecord(callbackDelivery?.message)
      ? callbackDelivery.message
      : undefined;
    const sameDeliveryMessageId = persistedDeliveryMessage?.id === message.id;
    const sameDeliveryMessage = sameDeliveryMessageId &&
      canonicalJson(persistedDeliveryMessage) === canonicalJson(message);
    if (sameDeliveryMessageId && !sameDeliveryMessage) {
      throw new Error(
        `callback message ${message.id} conflicts with its persisted immutable outbox payload`
      );
    }
    const inheritedDelivery = sameDeliveryMessage
      ? callbackDelivery
      : undefined;
    const retryingPending = options.retryPending === true &&
      sameDeliveryMessage &&
      callbackRetryDisposition(ports, inheritedDelivery).state === "retryable";
    if (
      options.retryPending === true &&
      sameDeliveryMessage &&
      !retryingPending
    ) {
      rejectNonRetryableDelivery(
        callbackRetryDisposition(ports, inheritedDelivery)
      );
    }

    const duplicateMessage = isDuplicateMessage(existingEvents, message);
    const recoveryMessageAlreadyLogged = options.recoverMissingOutbox === true
      ? exactLoggedMessageForRecovery(existingEvents, message)
      : false;
    const recoveringMissingOutbox = options.recoverMissingOutbox === true &&
      (
        !isRecord(callbackDelivery?.message) ||
        callbackDelivery.message.id !== message.id
      );
    if (
      !retryingPending &&
      !recoveryMessageAlreadyLogged &&
      !sameDeliveryMessage
    ) {
      ports.authority.assertBindingCurrent(
        conversation,
        "accept callback for"
      );
    }
    if (
      ports.authority.isDispatchReleased(conversation) &&
      !duplicateMessage
    ) {
      throw new Error(
        `refusing late callback ${message.id} for released Turn ` +
        `${turnIdForConversation(conversation)} (${conversation.status})`
      );
    }
    const recoveringTerminalCompletion =
      options.recoverTerminalCompletion === true &&
      duplicateMessage &&
      (
        ports.authority.isWaitingForAgent(conversation.status) ||
        (
          options.allowTerminalCompletionRecoveryStatus === true &&
          ports.authority.isTerminalBridgeSupersedeStatus(conversation.status)
        )
      );
    if (
      duplicateMessage &&
      !retryingPending &&
      !recoveringTerminalCompletion &&
      !recoveringMissingOutbox
    ) {
      ports.runtime.log("info", "callback_duplicate", {
        conversation_id: conversation.conversation_id,
        agent: executor.kind,
        executor_session: executor.session,
        from: message.from,
        type: message.type,
        round: message.round,
        state_path: options.statePath,
        event_log_path: logPath
      });
      return {
        outcome: "duplicate",
        conversation,
        message
      };
    }

    function persistPreparation(): PreparedCallback {
      const closeTerminalBridgeOnDone = message.type === "done" &&
        options.closeTerminalBridgeOnDone === true;
      const requiresDelivery = options.recordOnly !== true;
      const deliveryAttempt = Number(inheritedDelivery?.attempts ?? 0) + 1;
      const deliveryAttemptId = randomUUID();
      let nextConversation: Conversation = retryingPending
        ? conversation
        : applyMessageToConversation(conversation, message);
      if (closeTerminalBridgeOnDone) {
        const closedAt = ports.runtime.now().toISOString();
        nextConversation = {
          ...nextConversation,
          status: "closed",
          closed_at: nextConversation.closed_at ?? closedAt,
          close_reason: nextConversation.close_reason ??
            "terminal bridge task completed",
          updated_at: closedAt
        };
        delete nextConversation.idle_since;
      }
      const storedFinalStatus = stringValue(inheritedDelivery?.final_status);
      const finalStatus: TurnPhaseStatus = storedFinalStatus &&
          isTurnPhaseStatus(storedFinalStatus)
        ? storedFinalStatus
        : effectiveTurnStatus(nextConversation);
      const retryDelayMs = ports.retry.delaysMs[
        Math.min(
          ports.retry.delaysMs.length - 1,
          Math.max(0, deliveryAttempt - 1)
        )
      ];
      const callbackWatchdog = requiresDelivery &&
        !retryingPending &&
        options.disableCallbackRetry !== true &&
        deliveryAttempt <= ports.retry.delaysMs.length
        ? ports.retry.startMonitor({
            statePath: options.statePath,
            delayMs: retryDelayMs
          })
        : undefined;
      if (
        !retryingPending &&
        !recoveringTerminalCompletion &&
        !(recoveringMissingOutbox && recoveryMessageAlreadyLogged)
      ) {
        ports.state.appendMessage(logPath, message);
      }
      if (requiresDelivery) {
        const now = ports.runtime.now().toISOString();
        nextConversation = {
          ...nextConversation,
          callback_delivery: {
            status: "pending",
            message,
            attempts: deliveryAttempt,
            attempt_id: deliveryAttemptId,
            attempt_pid: ports.runtime.pid(),
            attempt_lease_expires_at: new Date(
              ports.runtime.nowMs() + ports.retry.attemptLeaseMs
            ).toISOString(),
            created_at: stringValue(inheritedDelivery?.created_at) ?? now,
            last_attempt_at: now,
            updated_at: now,
            gateway_method: options.gatewayMethod,
            gateway_session: options.gatewaySession ??
              options.openclawSession ?? conversation.openclaw_session,
            gateway_url: persistedGatewayRoute.gatewayUrl,
            openclaw_bin: options.openclawBin ?? conversation.openclaw_bin,
            close_terminal_bridge_on_done: closeTerminalBridgeOnDone,
            track_delivery: true,
            final_status: finalStatus,
            preserve_conversation_status: true,
            kind: stringValue(options.callbackDeliveryKind) ??
              stringValue(inheritedDelivery?.kind),
            ...(callbackWatchdog
              ? {
                  retry_monitor_pid: callbackWatchdog.pid ?? null,
                  next_attempt_at: new Date(
                    ports.runtime.nowMs() + retryDelayMs
                  ).toISOString()
                }
              : {})
          }
        };
        ports.state.append(logPath, {
          ts: now,
          conversation_id: conversation.conversation_id,
          event: retryingPending
            ? "callback_delivery_retry_started"
            : "callback_delivery_pending",
          message_id: message.id,
          attempt: deliveryAttempt
        });
        if (callbackWatchdog) {
          ports.state.append(logPath, {
            ts: ports.runtime.now().toISOString(),
            conversation_id: conversation.conversation_id,
            event: "callback_retry_monitor_launched",
            message_id: message.id,
            pid: callbackWatchdog.pid ?? null,
            next_attempt_at: isRecord(nextConversation.callback_delivery)
              ? nextConversation.callback_delivery.next_attempt_at
              : undefined
          });
        }
      }
      ports.state.save(options.statePath, nextConversation);
      ports.runtime.log("info", "callback_received", {
        conversation_id: conversation.conversation_id,
        agent: executor.kind,
        executor_session: executor.session,
        from: message.from,
        type: message.type,
        round: message.round,
        status: nextConversation.status,
        requires_response: message.requires_response,
        state_path: options.statePath,
        event_log_path: logPath,
        message: ports.runtime.textSummary(message.body)
      });

      if (options.recordOnly) {
        ports.runtime.log("info", "callback_recorded_only", {
          conversation_id: conversation.conversation_id,
          status: nextConversation.status
        });
        return {
          outcome: "record_only",
          conversation: nextConversation,
          message
        };
      }

      return {
        outcome: "deliver",
        options,
        statePath: options.statePath,
        logPath,
        conversation: nextConversation,
        message,
        deliveryAttempt,
        deliveryAttemptId
      };
    }

    return persistPreparation();
  }

  function runPrepared(prepared: PreparedCallback): CallbackExecutionResult {
    if (prepared.outcome !== "deliver") {
      return {
        delivered: false,
        duplicate: prepared.outcome === "duplicate",
        conversation: prepared.conversation,
        message: prepared.message
      };
    }

    ports.state.assertWriterCompatible(
      ports.state.storeDirForStatePath(prepared.statePath)
    );
    let acceptedDelivery: CallbackDeliveryOutcome | undefined;
    try {
      const delivery = ports.delivery.deliver({
        options: prepared.options,
        statePath: prepared.statePath,
        logPath: prepared.logPath,
        conversation: prepared.conversation,
        message: prepared.message,
        onProgress: (progress) => {
          settlement.persistDeliveryProgress(prepared, progress);
        },
        onAccepted: (accepted) => {
          acceptedDelivery = accepted;
        }
      });
      return {
        delivered: true,
        duplicate: false,
        conversation: settlement.settleDelivery(prepared, {
          delivered: true,
          delivery
        }),
        message: prepared.message,
        delivery: delivery.kind
      };
    } catch (error) {
      if (acceptedDelivery) {
        const acceptedAfterError: CallbackDeliveryOutcome = {
          ...acceptedDelivery,
          run_observation: acceptedDelivery.run_observation ?? {
            status: "unavailable",
            source: "post_acceptance_error",
            observed_at: ports.runtime.now().toISOString(),
            error: error instanceof Error ? error.message : String(error)
          }
        };
        return {
          delivered: true,
          duplicate: false,
          conversation: settlement.settleDelivery(prepared, {
            delivered: true,
            delivery: acceptedAfterError
          }),
          message: prepared.message,
          delivery: acceptedAfterError.kind
        };
      }
      const settled = settlement.settleDelivery(prepared, {
        delivered: false,
        error
      });
      const settledDelivery = isRecord(settled.callback_delivery)
        ? settled.callback_delivery
        : undefined;
      if (settledDelivery?.status === "delivered") {
        return {
          delivered: true,
          duplicate: false,
          conversation: settled,
          message: prepared.message,
          delivery: "accepted_before_observation_error"
        };
      }
      throw error;
    }
  }

  return {
    prepare,
    runPrepared,
    reconcileDelivery: (input: CallbackDeliveryReconciliationInput) =>
      reconcileCallbackDelivery(ports, settlement, input),
    runRetryMonitor: (input: CallbackRetryMonitorInput) =>
      runCallbackRetryMonitor(ports, settlement, input),
    retry: (input: RetryCallbackInput) =>
      retryCallback(ports, settlement, input),
    retryDisposition: (delivery: unknown) =>
      callbackRetryDisposition(ports, delivery),
    prepareApprovalNotification: (
      input: ApprovalNotificationPreparationInput
    ) => prepareApprovalNotification(prepare, input),
    prepareTerminalCompletion: (input: TerminalCompletionPreparationInput) =>
      prepareTerminalCompletion(ports, prepare, input)
  };
}

function prepareApprovalNotification(
  prepare: (input: PrepareCallbackOutboxInput) => PreparedCallback,
  input: ApprovalNotificationPreparationInput
) {
  const identity = terminalApprovalCallbackIdentity(input.conversation);
  const callbackMessage = createMessage({
    conversation: input.conversation,
    id: identity.id,
    from: input.actor,
    to: "openclaw",
    type: input.type,
    requiresResponse: true,
    body: input.body,
    metadata: input.metadata,
    now: identity.now
  });
  if (!input.conversation.gateway_method) {
    return {
      callbackMessage,
      delivered: false as const
    };
  }
  return {
    callbackMessage,
    prepared: prepare({
      options: {
        ...input.options,
        statePath: input.statePath,
        log: input.logPath,
        messageJson: JSON.stringify(callbackMessage),
        gatewayMethod: input.conversation.gateway_method,
        gatewaySession: input.conversation.gateway_session,
        openclawSession: input.conversation.openclaw_session,
        openclawBin: input.conversation.openclaw_bin,
        gatewayUrl: stringValue(input.conversation.gateway_token)
          ? input.conversation.gateway_url
          : undefined,
        token: stringValue(input.conversation.gateway_token),
        preserveMessageId: true,
        callbackDeliveryKind: "approval_notification",
        recoverMissingOutbox: input.recoverMissingOutbox === true,
        conversationOverride: input.conversation
      },
      logPath: input.logPath
    })
  };
}

function terminalApprovalCallbackIdentity(conversation: Conversation): {
  id: string;
  now: Date;
} {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const approval = isRecord(nativeTakeover?.terminal_bridge_approval)
    ? nativeTakeover.terminal_bridge_approval
    : undefined;
  const id = stringValue(approval?.callback_message_id);
  const timestamp = stringValue(approval?.callback_message_ts);
  const timestampMs = Date.parse(String(timestamp ?? ""));
  if (!id || !Number.isFinite(timestampMs)) {
    throw new Error(
      "terminal approval notification has no stable callback identity"
    );
  }
  return { id, now: new Date(timestampMs) };
}

export function deterministicTerminalCallbackMessageId(input: {
  conversationId: string;
  terminalMessageId: string;
  completionFingerprint: string;
  outcome: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      conversation_id: input.conversationId,
      terminal_message_id: input.terminalMessageId,
      completion_fingerprint: input.completionFingerprint,
      outcome: input.outcome
    }))
    .digest("hex")
    .slice(0, 32);
  return `msg-terminal-${digest}`;
}

export function terminalBridgeCompletionFingerprint(input: {
  completion: TerminalCompletionEvidence;
  terminalMessageId?: string;
}): string {
  const metadata = isRecord(input.completion.metadata)
    ? input.completion.metadata
    : {};
  const match = stringValue(metadata.match) ??
    (input.completion.source === "screen"
      ? "terminal_screen"
      : "durable_completion");
  return createHash("sha256")
    .update(JSON.stringify({
      text: input.completion.text,
      timestamp: input.completion.timestamp,
      match,
      source: input.completion.source,
      id: input.completion.id,
      message_id: input.terminalMessageId
    }))
    .digest("hex");
}

function prepareTerminalCompletion(
  ports: CallbackOutboxServicePorts,
  prepare: (input: PrepareCallbackOutboxInput) => PreparedCallback,
  input: TerminalCompletionPreparationInput
) {
  const completionFingerprint = input.completionFingerprint ??
    terminalBridgeCompletionFingerprint(input);
  const completionMetadata = isRecord(input.completion.metadata)
    ? input.completion.metadata
    : {};
  const completionMatch = stringValue(completionMetadata.match) ??
    (input.completion.source === "screen"
      ? "terminal_screen"
      : "durable_completion");
  const completionOutcome = input.completion.outcome === "failure"
    ? "failure"
    : "success";
  const callbackMessageId = deterministicTerminalCallbackMessageId({
    conversationId: input.conversationId,
    terminalMessageId: input.terminalMessageId,
    completionFingerprint,
    outcome: completionOutcome
  });
  const transaction = ports.state.withTransaction(input.statePath, () => {
    const claim = claimTerminalCompletion(ports, {
      statePath: input.statePath,
      logPath: input.logPath,
      terminalMessageId: input.terminalMessageId,
      completionFingerprint,
      completionId: input.completion.id,
      callbackMessageId,
      outcome: completionOutcome,
      allowSupersedeRecovery: input.allowSupersedeRecovery === true
    });
    if (!claim.claimed) {
      return claim;
    }
    ports.state.append(input.logPath, {
      ts: ports.runtime.now().toISOString(),
      conversation_id: claim.conversation.conversation_id,
      event: "terminal_bridge_completion_detected",
      terminal_control: input.terminalControl,
      match: completionMatch,
      completion_source: input.completion.source,
      completion_outcome: completionOutcome,
      completion_id: input.completion.id,
      terminal_session: completionMetadata.session,
      context_match: completionMetadata.context_match,
      assistant_timestamp: input.completion.timestamp,
      rollout_turn_id: input.completion.source === "durable"
        ? input.completion.id
        : undefined,
      terminal_bridge_message_id: input.terminalMessageId,
      callback_message_id: callbackMessageId
    });
    const callbackMessage = {
      ...createMessage({
        conversation: claim.conversation,
        from: input.actor,
        to: "openclaw",
        type: completionOutcome === "failure" ? "error" : "done",
        requiresResponse: false,
        body: input.completion.text,
        metadata: {
          source: "terminal_bridge",
          terminal_control: input.terminalControl,
          ...completionMetadata,
          completion_source: input.completion.source,
          completion_outcome: completionOutcome,
          completion_id: input.completion.id,
          terminal_session: completionMetadata.session,
          confidence: input.completion.confidence,
          match: completionMatch,
          assistant_timestamp: input.completion.timestamp,
          rollout_turn_id: input.completion.source === "durable"
            ? input.completion.id
            : undefined,
          terminal_bridge_message_id: input.terminalMessageId
        }
      }),
      id: callbackMessageId
    };
    const prepared = prepare({
      options: {
        ...input.options,
        statePath: input.statePath,
        log: input.logPath,
        closeTerminalBridgeOnDone: false,
        recoverTerminalCompletion: claim.resumed,
        allowTerminalCompletionRecoveryStatus:
          input.allowSupersedeRecovery === true,
        preserveMessageId: true,
        messageJson: JSON.stringify(callbackMessage),
        gatewayMethod: claim.conversation.gateway_method,
        gatewaySession: claim.conversation.gateway_session,
        openclawSession: claim.conversation.openclaw_session,
        openclawBin: claim.conversation.openclaw_bin,
        gatewayUrl: stringValue(claim.conversation.gateway_token)
          ? claim.conversation.gateway_url
          : undefined,
        token: stringValue(claim.conversation.gateway_token),
        recordOnly: !stringValue(claim.conversation.gateway_method)
      },
      logPath: input.logPath
    });
    if (prepared.outcome === "record_only") {
      ports.runtime.crashCheckpoint("after_local_completion_state");
    }
    return {
      claimed: true as const,
      conversation: claim.conversation,
      prepared,
      callbackMessageId
    };
  });
  if (!transaction.claimed) {
    return transaction;
  }
  if (!ports.authority.resolveCompletionDispatch({
    terminalControl: input.terminalControl,
    conversation: transaction.conversation,
    expectedMessageId: input.terminalMessageId,
    reason: "terminal bridge task reached durable completion"
  })) {
    throw new Error(
      `terminal completion ${transaction.conversation.conversation_id} ` +
      "changed before its dispatch ledger could be settled"
    );
  }
  return transaction;
}

interface TerminalCompletionClaimInput {
  statePath: string;
  logPath: string;
  terminalMessageId: string;
  completionFingerprint: string;
  completionId?: string;
  callbackMessageId: string;
  outcome: string;
  allowSupersedeRecovery: boolean;
}

function claimTerminalCompletion(
  ports: CallbackOutboxServicePorts,
  input: TerminalCompletionClaimInput
) {
  const conversation = ports.state.load(input.statePath);
    const nativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : {};
    if (
      !ports.authority.isWaitingForAgent(conversation.status) &&
      !(
        input.allowSupersedeRecovery &&
        ports.authority.isTerminalBridgeSupersedeStatus(conversation.status)
      )
    ) {
      return {
        claimed: false as const,
        conversation,
        reason: "conversation_no_longer_waiting"
      };
    }
    if (
      stringValue(nativeTakeover.terminal_bridge_message_id) !==
      input.terminalMessageId
    ) {
      return {
        claimed: false as const,
        conversation,
        reason: "terminal_bridge_task_replaced"
      };
    }
    const existing = isRecord(
      nativeTakeover.terminal_bridge_completion_claim
    )
      ? nativeTakeover.terminal_bridge_completion_claim
      : undefined;
    if (existing) {
      if (
        existing.callback_message_id === input.callbackMessageId &&
        existing.terminal_bridge_message_id === input.terminalMessageId &&
        existing.completion_fingerprint === input.completionFingerprint &&
        existing.outcome === input.outcome
      ) {
        ports.state.append(input.logPath, {
          ts: ports.runtime.now().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_completion_claim_resumed",
          terminal_bridge_message_id: input.terminalMessageId,
          completion_fingerprint: input.completionFingerprint,
          callback_message_id: input.callbackMessageId,
          outcome: input.outcome
        });
        return {
          claimed: true as const,
          resumed: true as const,
          conversation
        };
      }
      return {
        claimed: false as const,
        conversation,
        reason: "terminal_bridge_completion_claim_conflict"
      };
    }

    const claimedAt = ports.runtime.now().toISOString();
    const claimedConversation: Conversation = {
      ...conversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_completion_claim: {
          terminal_bridge_message_id: input.terminalMessageId,
          completion_fingerprint: input.completionFingerprint,
          completion_id: input.completionId,
          callback_message_id: input.callbackMessageId,
          outcome: input.outcome,
          claimed_at: claimedAt
        }
      },
      updated_at: claimedAt
    };
    ports.state.save(input.statePath, claimedConversation);
    ports.state.append(input.logPath, {
      ts: claimedAt,
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_completion_claimed",
      terminal_bridge_message_id: input.terminalMessageId,
      completion_fingerprint: input.completionFingerprint,
      completion_id: input.completionId,
      callback_message_id: input.callbackMessageId,
      outcome: input.outcome
    });
    return {
      claimed: true as const,
      resumed: false as const,
      conversation: claimedConversation
    };
}

function retryCallback(
  ports: CallbackOutboxServicePorts,
  settlement: CallbackSettlement,
  { options, conversation, statePath, logPath }: RetryCallbackInput
): RetryCallbackOutcome {
  const callbackDelivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const legacyStatusError = stringValue(
    conversation.legacy_callback_status_error
  );
  if (legacyStatusError) {
    throw new Error(
      `cannot retry callback for ${conversation.conversation_id}; ` +
      `legacy Turn phase is ambiguous: ${legacyStatusError}`
    );
  }
  const disposition = callbackRetryDisposition(ports, callbackDelivery);
  if (disposition.state === "accepted") {
    const recovered = settlement.settleAccepted({
      statePath,
      logPath,
      expectedMessageId: isRecord(callbackDelivery?.message)
        ? stringValue(callbackDelivery.message.id)
        : undefined,
      reason: "manual_retry_observed_accepted_transport"
    });
    if (!recovered) {
      throw new Error(
        `cannot retry callback for ${conversation.conversation_id}; ` +
        "callback delivery changed while accepted transport was being recovered"
      );
    }
    return {
      kind: "recovered",
      result: {
        delivered: true,
        duplicate: false,
        conversation: recovered,
        message: callbackDelivery?.message,
        delivery: "accepted_transport_recovered"
      }
    };
  }
  rejectManualRetryDisposition(conversation, disposition);
  if (!callbackDelivery || !isRecord(callbackDelivery.message)) {
    throw new Error(
      `cannot retry callback for ${conversation.conversation_id}; pending callback is missing`
    );
  }

  const gatewayRoute = resolveCallbackGatewayRoute(
    { gatewayUrl: options.gatewayUrl, token: options.token },
    {
      gatewayUrl: callbackDelivery.gateway_url,
      token: callbackDelivery.gateway_token
    },
    {
      gatewayUrl: conversation.gateway_url,
      token: conversation.gateway_token
    }
  );
  return {
    kind: "retried",
    result: ports.delivery.runTransaction({
      ...options,
      statePath,
      messageJson: JSON.stringify(callbackDelivery.message),
      gatewayMethod: stringValue(callbackDelivery.gateway_method) ??
        conversation.gateway_method,
      gatewaySession: stringValue(callbackDelivery.gateway_session) ??
        conversation.gateway_session,
      openclawSession: conversation.openclaw_session,
      openclawBin: stringValue(callbackDelivery.openclaw_bin) ??
        conversation.openclaw_bin,
      gatewayUrl: gatewayRoute.gatewayUrl,
      token: gatewayRoute.token,
      closeTerminalBridgeOnDone:
        callbackDelivery.close_terminal_bridge_on_done === true,
      retryPending: true
    })
  };
}

function callbackRetryDisposition(
  ports: CallbackOutboxServicePorts,
  callbackDelivery: unknown
): CallbackRetryDisposition {
  let policy = beginCallbackRetryPolicy(callbackDelivery, {
    attemptLeaseMs: ports.retry.attemptLeaseMs,
    retryDelayCount: ports.retry.delaysMs.length
  });
  if (policy.phase === "decided") {
    return policy.disposition;
  }
  policy = reduceCallbackRetryPolicy(policy, {
    kind: "process_alive",
    alive: ports.retry.isProcessAlive(policy.attempt_pid)
  });
  if (policy.phase === "decided") {
    return policy.disposition;
  }
  policy = reduceCallbackRetryPolicy(policy, {
    kind: "clock",
    now_ms: ports.runtime.nowMs()
  });
  if (policy.phase !== "decided") {
    throw new Error("callback retry policy did not reach a decision");
  }
  return policy.disposition;
}

function rejectManualRetryDisposition(
  conversation: Conversation,
  disposition: Exclude<CallbackRetryDisposition, { state: "accepted" }>
): void {
  if (disposition.state === "in_flight") {
    throw new Error(
      `cannot retry callback for ${conversation.conversation_id}; callback ` +
      `attempt ${disposition.attempt} is in flight` +
      (disposition.attempt_pid === undefined
        ? ""
        : ` (pid ${disposition.attempt_pid})`) +
      (disposition.lease_expires_at
        ? ` with lease until ${disposition.lease_expires_at}`
        : "") +
      (disposition.next_attempt_at
        ? `; automatic retry is scheduled for ${disposition.next_attempt_at}`
        : "")
    );
  }
  if (disposition.state === "exhausted") {
    throw new Error(
      `cannot retry callback for ${conversation.conversation_id}; callback ` +
      `delivery retries are exhausted after attempt ${disposition.attempt}`
    );
  }
  if (disposition.state !== "retryable") {
    throw new Error(
      `cannot retry callback for ${conversation.conversation_id}; ` +
      disposition.reason
    );
  }
}

function reconcileCallbackDelivery(
  ports: CallbackOutboxServicePorts,
  settlement: CallbackSettlement,
  { statePath, logPath, delayMs }: CallbackDeliveryReconciliationInput
) {
  return ports.state.withTransaction(statePath, () => {
    const conversation = ports.state.load(statePath);
    const legacyStatusError = stringValue(
      conversation.legacy_callback_status_error
    );
    if (legacyStatusError) {
      return {
        handled: true as const,
        conversationId: conversation.conversation_id,
        status: "skipped",
        reason: "legacy_callback_status_ambiguous",
        diagnostic: legacyStatusError
      };
    }
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    if (
      !["pending", "failed"].includes(
        String(callbackDelivery?.status ?? "")
      )
    ) {
      return { handled: false as const };
    }
    ports.authority.assertNoDeferredTransfer({
      storeDir: ports.state.storeDirForStatePath(statePath),
      conversation,
      action: "reconcile callback delivery for"
    });

    const conversationId = stringValue(conversation.conversation_id) ??
      "unknown";
    const attempts = Number(callbackDelivery?.attempts ?? 0);
    if (
      !["pending", "failed"].includes(
        String(callbackDelivery?.status ?? "")
      ) ||
      !isRecord(callbackDelivery?.message)
    ) {
      return {
        handled: true as const,
        conversationId,
        status: "skipped",
        reason: "callback_delivery_metadata_missing"
      };
    }
    const disposition = callbackRetryDisposition(ports, callbackDelivery);
    if (disposition.state === "accepted") {
      const settled = settlement.settleAcceptedWhileLocked({
        conversation,
        statePath,
        logPath,
        expectedMessageId: stringValue(callbackDelivery.message.id),
        reason: "startup_reconciliation_observed_accepted_transport"
      });
      return {
        handled: true as const,
        conversationId,
        status: settled ? "recovered" : "skipped",
        reason: settled
          ? "callback_delivery_accepted_recovered"
          : "callback_delivery_changed_before_recovery"
      };
    }
    if (disposition.state === "in_flight") {
      return {
        handled: true as const,
        conversationId,
        status: "already_running",
        reason: "callback_delivery_attempt_in_flight",
        attempt: disposition.attempt,
        attemptPid: disposition.attempt_pid,
        leaseExpiresAt: disposition.lease_expires_at,
        nextAttemptAt: disposition.next_attempt_at
      };
    }
    if (disposition.state === "exhausted") {
      return {
        handled: true as const,
        conversationId,
        status: "skipped",
        reason: "callback_delivery_retries_exhausted"
      };
    }
    if (disposition.state !== "retryable") {
      return {
        handled: true as const,
        conversationId,
        status: "skipped",
        reason: disposition.reason
      };
    }

    const configuredDelayMs = Number(delayMs);
    const retryDelayMs = Number.isFinite(configuredDelayMs) &&
      configuredDelayMs >= 0
      ? configuredDelayMs
      : ports.retry.delaysMs[Math.max(0, attempts - 1)];
    const retryMonitor = ports.retry.startMonitor({ statePath, delayMs: retryDelayMs });
    const launchedAt = ports.runtime.now().toISOString();
    const nextAttemptAt = new Date(
      ports.runtime.nowMs() + retryDelayMs
    ).toISOString();
    ports.state.save(statePath, {
      ...conversation,
      callback_delivery: {
        ...callbackDelivery,
        retry_monitor_pid: retryMonitor.pid ?? null,
        next_attempt_at: nextAttemptAt,
        updated_at: launchedAt
      }
    });
    ports.state.append(logPath, {
      ts: launchedAt,
      conversation_id: conversationId,
      event: "callback_retry_monitor_launched",
      message_id: callbackDelivery.message.id,
      pid: retryMonitor.pid ?? null,
      next_attempt_at: nextAttemptAt,
      reason: "startup_reconciliation"
    });
    return {
      handled: true as const,
      conversationId,
      status: "launched",
      reason: "callback_delivery_reconciliation",
      monitorPid: retryMonitor.pid
    };
  });
}

function runCallbackRetryMonitor(
  ports: CallbackOutboxServicePorts,
  settlement: CallbackSettlement,
  { statePath, initialDelayMs }: CallbackRetryMonitorInput
): void {
  const configuredDelayMs = Number(initialDelayMs);
  ports.runtime.sleepSync(Math.max(
    0,
    Number.isFinite(configuredDelayMs)
      ? configuredDelayMs
      : ports.retry.delaysMs[0]
  ));

  while (true) {
    const observed = observeCallbackRetryMonitor(ports, statePath);
    if (observed.kind === "stop") {
      return;
    }
    if (observed.kind === "accepted") {
      settleRetryMonitorAcceptance(
        ports,
        settlement,
        statePath,
        observed.messageId
      );
      return;
    }
    if (observed.kind === "in_flight") {
      ports.runtime.sleepSync(1000);
      continue;
    }
    try {
      ports.delivery.runTransaction(
        retryMonitorDeliveryOptions(statePath, observed)
      );
      return;
    } catch {
      // The failed attempt is persisted before the next bounded retry.
    }

    const latest = observeCallbackRetryMonitor(ports, statePath);
    if (latest.kind === "accepted") {
      settleRetryMonitorAcceptance(
        ports,
        settlement,
        statePath,
        latest.messageId
      );
      return;
    }
    if (
      latest.kind !== "retryable" ||
      latest.attempts > ports.retry.delaysMs.length ||
      latest.attempts <= observed.attempts
    ) {
      return;
    }
    ports.runtime.sleepSync(
      ports.retry.delaysMs[Math.max(0, latest.attempts - 1)]
    );
  }
}

function observeCallbackRetryMonitor(
  ports: CallbackOutboxServicePorts,
  statePath: string
): CallbackRetryMonitorObservation {
  const conversation = ports.state.load(statePath);
  if (stringValue(conversation.legacy_callback_status_error)) {
    return { kind: "stop" };
  }
  const delivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  if (
    !delivery ||
    !isRecord(delivery.message) ||
    !["pending", "failed"].includes(String(delivery.status ?? ""))
  ) {
    return { kind: "stop" };
  }
  const disposition = callbackRetryDisposition(ports, delivery);
  if (disposition.state === "accepted") {
    return {
      kind: "accepted",
      messageId: stringValue(delivery.message.id)
    };
  }
  if (disposition.state === "in_flight") {
    return { kind: "in_flight" };
  }
  if (disposition.state !== "retryable") {
    return { kind: "stop" };
  }
  return {
    kind: "retryable",
    conversation,
    delivery,
    attempts: Number(delivery.attempts ?? 0)
  };
}

function retryMonitorDeliveryOptions(
  statePath: string,
  observed: Extract<CallbackRetryMonitorObservation, { kind: "retryable" }>
): CallbackPreparationOptions {
  const { conversation, delivery } = observed;
  const gatewayRoute = resolveCallbackGatewayRoute(
    {
      gatewayUrl: delivery.gateway_url,
      token: delivery.gateway_token
    },
    {
      gatewayUrl: conversation.gateway_url,
      token: conversation.gateway_token
    }
  );
  return {
    statePath,
    messageJson: JSON.stringify(delivery.message),
    gatewayMethod: stringValue(delivery.gateway_method) ??
      conversation.gateway_method,
    gatewaySession: stringValue(delivery.gateway_session) ??
      conversation.gateway_session,
    openclawSession: conversation.openclaw_session,
    openclawBin: stringValue(delivery.openclaw_bin) ?? conversation.openclaw_bin,
    gatewayUrl: gatewayRoute.gatewayUrl,
    token: gatewayRoute.token,
    closeTerminalBridgeOnDone:
      delivery.close_terminal_bridge_on_done === true,
    retryPending: true,
    disableCallbackRetry: true
  };
}

function settleRetryMonitorAcceptance(
  ports: CallbackOutboxServicePorts,
  settlement: CallbackSettlement,
  statePath: string,
  expectedMessageId: string | undefined
): void {
  settlement.settleAccepted({
    statePath,
    logPath: ports.state.logPathForStatePath(statePath),
    expectedMessageId,
    reason: "retry_monitor_observed_accepted_transport"
  });
}

function requiredMessageJson(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error("--message-json is required");
  }
  return value;
}

function rejectNonRetryableDelivery(
  disposition: CallbackRetryDisposition
): never {
  if (disposition.state === "in_flight") {
    throw new Error(
      `callback attempt ${disposition.attempt} is already in flight` +
      (disposition.attempt_pid === undefined
        ? ""
        : ` (pid ${disposition.attempt_pid})`) +
      (disposition.lease_expires_at
        ? ` with lease until ${disposition.lease_expires_at}`
        : "")
    );
  }
  if (disposition.state === "accepted") {
    throw new Error(
      "callback transport was already accepted and must be settled, not retried"
    );
  }
  if (disposition.state === "exhausted") {
    throw new Error(
      `callback retries are exhausted after attempt ${disposition.attempt}`
    );
  }
  throw new Error(
    disposition.state === "unavailable"
      ? disposition.reason
      : "callback delivery is not retryable"
  );
}

function isDuplicateMessage(
  events: TranscriptEvent[],
  message: AgentMessage
): boolean {
  return events.some((event) => {
    if (event.event !== "message") {
      return false;
    }
    const existing = (event.message ?? event) as Record<string, unknown>;
    if (existing.id && existing.id === message.id) {
      return true;
    }
    return messageFingerprint(existing) === messageFingerprint(message);
  });
}

function exactLoggedMessageForRecovery(
  events: TranscriptEvent[],
  message: AgentMessage
): boolean {
  const matchingId = events
    .filter((event) => event.event === "message")
    .map((event) => (event.message ?? event) as Record<string, unknown>)
    .filter((existing) => existing.id === message.id);
  if (matchingId.length === 0) {
    return false;
  }
  if (
    matchingId.length !== 1 ||
    canonicalJson(matchingId[0]) !== canonicalJson(message)
  ) {
    throw new Error(
      `callback recovery message ${message.id} conflicts with its logged payload`
    );
  }
  return true;
}

function messageFingerprint(message: {
  session_id?: unknown;
  turn_id?: unknown;
  conversation_id?: unknown;
  from?: unknown;
  to?: unknown;
  type?: unknown;
  requires_response?: unknown;
  body?: unknown;
}): string {
  return JSON.stringify({
    session_id: message.session_id,
    turn_id: message.turn_id,
    conversation_id: message.conversation_id,
    from: message.from,
    to: message.to,
    type: message.type,
    requires_response: message.requires_response,
    body: message.body
  });
}
