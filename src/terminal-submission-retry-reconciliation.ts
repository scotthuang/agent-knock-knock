import { createHash } from "node:crypto";
import path from "node:path";

import {
  callbackExpectedForConversation,
  callbackRouteFingerprintForConversation
} from "./callback-route-authority.js";
import {
  deferredForegroundActiveMessageId,
  isDeferredForegroundSubmissionRetryPending,
  type DeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import {
  effectiveTurnStatus,
  executorForConversation,
  isTerminalDispatchOwnerReleasedStatus,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import { appendEvent, loadState, saveState } from "./store.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { TerminalAgentBridge } from "./terminal-agent-bridge.js";
import {
  TERMINAL_SUBMISSION_RETRY_SCHEMA,
  TERMINAL_SUBMISSION_RETRY_VERSION,
  loadTerminalSubmissionRetry,
  projectTerminalSubmissionRetryPending,
  saveTerminalSubmissionRetry,
  terminalSubmissionRetryLedgerFields,
  type TerminalSubmissionRetryRecord
} from "./terminal-submission-retry-service.js";
import {
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
import type {
  CanonicalMutationResources,
  CanonicalMutationScopes,
  CanonicalStateMutationResources,
  CanonicalStateMutationScopes
} from "./mutation-transaction.js";
import {
  assertTerminalDispatchRouteMatches,
  bindTerminalDispatchRoute
} from "./terminal-dispatch-capability.js";
import { terminalMonitorDeadlineAt as deadlineAt } from
  "./terminal-monitor-decision-policy.js";
import {
  sameCanonicalStatePath,
  terminalDispatchLedgerLooksLifecycle,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import type {
  DeferredCodexForegroundBindingBoundary,
  TerminalDispatchTerminal
} from "./terminal-dispatch-composition.js";
import type { DeferredForegroundApplicationScope } from
  "./deferred-foreground-boundary.js";
import { bindDeferredForegroundApplicationScope } from
  "./deferred-foreground-capability.js";
import * as deferredRecoveryAdapter from
  "./deferred-foreground-recovery-cli-adapter.js";
import { deferredForegroundBoundaryProjection } from
  "./deferred-foreground-preparation-cli-adapter.js";
import {
  terminalSubmissionPayload,
  type TerminalDispatchExecutionService
} from "./terminal-dispatch-execution.js";
import {
  terminalSendEnterDispatched,
  terminalSendResultContract
} from "./terminal-dispatch-presenter.js";
import * as dispatchReceipt from "./terminal-dispatch-receipt.js";
import { writeCliJson as printJson } from "./cli-command-runtime.js";
import { cliNow } from "./cli-runtime-context.js";
import type {
  TerminalCommandCliOptions,
  TerminalDispatchRecord
} from "./terminal-command-cli-ports.js";
import type { TerminalSubmissionRetryReconciliationPorts } from
  "./terminal-submission-retry-ports.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";

const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_AGENT_HARD_TIMEOUT_MINUTES = 720;
const terminalBridgeSubmission = dispatchReceipt.terminalBridgeSubmission;
const TERMINAL_SUBMISSION_RETRY_LEDGER_KEYS = [
  "submission_retry_attempt_id",
  "submission_retry_mode",
  "submission_retry_state",
  "submission_retry_revision",
  "submission_retry_original_message_id",
  "submission_retry_active_message_id",
  "submission_retry_reserved_at",
  "submission_retry_replacement_text_reserved_at",
  "submission_retry_replacement_text_injected_at",
  "submission_retry_enter_reserved_at",
  "submission_retry_enter_dispatched_at"
] as const;


export interface TerminalSubmissionRetryDeferredContext {
  scope: DeferredForegroundApplicationScope;
  transfer: DeferredForegroundTransfer;
  boundary: DeferredCodexForegroundBindingBoundary;
}

export interface TerminalSubmissionRetryInvocation {
  options: TerminalCommandCliOptions;
  exactTurnId: string;
  statePath: string;
  logPath: string;
  storeDir: string;
  bridge: TerminalAgentBridge;
  live: TerminalDispatchTerminal;
  terminalControl: TerminalControlRef;
}

export interface TerminalSubmissionRetryLockedAuthority {
  conversation: Conversation;
  takeover?: Record<string, unknown>;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
  attempt?: TerminalSubmissionRetryRecord;
  currentMessageId: string;
  originalMessageId: string;
  requestText: string;
  requestHash: string;
  deferredTransferId?: string;
  lifecycleSettled: boolean;
}

export interface TerminalSubmissionRetryFlowState {
  conversation: Conversation;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
  attempt?: TerminalSubmissionRetryRecord;
}

export interface TerminalSubmissionRetryFlowContext {
  invocation: TerminalSubmissionRetryInvocation;
  scopes: CanonicalStateMutationScopes;
  resources: CanonicalStateMutationResources;
  execution: TerminalDispatchExecutionService;
  deferred?: TerminalSubmissionRetryDeferredContext;
  takeover?: Record<string, unknown>;
  currentMessageId: string;
  originalMessageId: string;
  requestText: string;
  requestHash: string;
}

export class TerminalSubmissionRetryReconciliation {
  constructor(private readonly ports: TerminalSubmissionRetryReconciliationPorts) {}

  terminalSubmissionRetryBaseRecord(input: {
    mode: "exact_draft_enter" | "replacement_send";
    state: TerminalSubmissionRetryRecord["state"];
    attemptId: string;
    storeDir: string;
    statePath: string;
    conversation: Conversation;
    originalMessageId: string;
    activeMessageId: string;
    requestHash: string;
    terminalControl: TerminalControlRef;
    at: string;
    deferredTransferId?: string;
  }): TerminalSubmissionRetryRecord {
    return {
      schema: TERMINAL_SUBMISSION_RETRY_SCHEMA,
      version: TERMINAL_SUBMISSION_RETRY_VERSION,
      revision: 1,
      attempt_id: input.attemptId,
      mode: input.mode,
      state: input.state,
      store_dir: path.resolve(input.storeDir),
      state_path: path.resolve(input.statePath),
      session_id: sessionIdForConversation(input.conversation),
      turn_id: turnIdForConversation(input.conversation),
      original_message_id: input.originalMessageId,
      active_message_id: input.activeMessageId,
      request_hash: input.requestHash,
      terminal_target: input.terminalControl.target,
      callback_route_fingerprint:
        callbackRouteFingerprintForConversation(input.conversation) ?? null,
      deferred_foreground_transfer_id: input.deferredTransferId ?? null,
      reserved_at: input.at,
      updated_at: input.at
    };
  }

  assertTerminalSubmissionRetryAttemptIdentity(input: {
    attempt?: TerminalSubmissionRetryRecord;
    conversation: Conversation;
    storeDir: string;
    statePath: string;
    originalMessageId: string;
    requestHash: string;
    terminalControl: TerminalControlRef;
    deferredTransferId?: string;
  }): void {
    const attempt = input.attempt;
    if (!attempt) return;
    const callbackFingerprint =
      callbackRouteFingerprintForConversation(input.conversation) ?? null;
    if (
      attempt.store_dir !== path.resolve(input.storeDir) ||
      attempt.state_path !== path.resolve(input.statePath) ||
      attempt.session_id !== sessionIdForConversation(input.conversation) ||
      attempt.turn_id !== turnIdForConversation(input.conversation) ||
      attempt.original_message_id !== input.originalMessageId ||
      attempt.request_hash !== input.requestHash ||
      attempt.terminal_target !== input.terminalControl.target ||
      attempt.callback_route_fingerprint !== callbackFingerprint ||
      attempt.deferred_foreground_transfer_id !==
        (input.deferredTransferId ?? null)
    ) {
      throw new Error(
        "terminal submission retry authority changed; no terminal input was sent"
      );
    }
  }

  terminalSubmissionRetryMessageType(
    submission: TerminalDispatchRecord
  ): "task" | "answer" {
    const messageType = stringValue(submission.message_type);
    if (messageType !== "task" && messageType !== "answer") {
      throw new Error(
        "terminal submission retry message type is unavailable; no terminal input was sent"
      );
    }
    return messageType;
  }

  withDeferredTransferSubmissionAuthority(
    conversation: Conversation,
    messageId: string,
    transferId: string
  ): Conversation {
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const submission = terminalBridgeSubmission(conversation);
    if (!takeover || !submission || submission.message_id !== messageId) {
      throw new Error(
        "cannot upgrade deferred transfer authority on a changed submission"
      );
    }
    const existing = stringValue(submission.deferred_foreground_transfer_id);
    if (existing && existing !== transferId) {
      throw new Error("deferred transfer receipt authority conflicts");
    }
    const receiptsValue = takeover.terminal_bridge_submission_receipts;
    if (receiptsValue !== undefined && !Array.isArray(receiptsValue)) {
      throw new Error("terminal submission receipt history is malformed");
    }
    const receipts = (Array.isArray(receiptsValue) ? receiptsValue : []).map(
      (receipt) => {
        if (!isRecord(receipt) || !stringValue(receipt.message_id)) {
          throw new Error("terminal submission receipt history is malformed");
        }
        if (receipt.message_id !== messageId) return receipt;
        const receiptTransferId = stringValue(
          receipt.deferred_foreground_transfer_id
        );
        if (receiptTransferId && receiptTransferId !== transferId) {
          throw new Error("deferred transfer receipt history conflicts");
        }
        return {
          ...receipt,
          deferred_foreground_transfer_id: transferId
        };
      }
    );
    return {
      ...conversation,
      native_session_takeover: {
        ...takeover,
        deferred_foreground_transfer_id: transferId,
        terminal_bridge_submission: {
          ...submission,
          deferred_foreground_transfer_id: transferId
        },
        terminal_bridge_submission_receipts: receipts
      }
    };
  }

  terminalSubmissionRetryUnstalled(
    conversation: Conversation
  ): Conversation {
    const next: Conversation = {
      ...conversation,
      status: "waiting_for_agent"
    };
    delete next.stalled_at;
    delete next.stalled_reason;
    delete next.failed_at;
    delete next.failure_reason;
    delete next.idle_since;
    return next;
  }

  withTerminalSubmissionRetryMonitorEpoch(
    conversation: Conversation,
    at: string
  ): Conversation {
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : {};
    const configuredInactivity = Number(
      takeover.terminal_bridge_inactivity_timeout_minutes
    );
    const configuredHard = Number(
      takeover.terminal_bridge_hard_timeout_minutes
    );
    const inactivityMinutes = Number.isFinite(configuredInactivity) &&
        configuredInactivity > 0
      ? configuredInactivity
      : DEFAULT_AGENT_TIMEOUT_MINUTES;
    const hardMinutes = Number.isFinite(configuredHard) && configuredHard > 0
      ? configuredHard
      : DEFAULT_AGENT_HARD_TIMEOUT_MINUTES;
    return {
      ...conversation,
      native_session_takeover: {
        ...takeover,
        terminal_bridge_started_at: at,
        terminal_bridge_monitor_started_at: at,
        terminal_bridge_last_activity_at: at,
        terminal_bridge_last_activity_reason:
          "submission retry Enter dispatched",
        terminal_bridge_inactivity_timeout_minutes: inactivityMinutes,
        terminal_bridge_hard_timeout_minutes: hardMinutes,
        terminal_bridge_inactivity_deadline_at: deadlineAt(
          at,
          inactivityMinutes
        ),
        terminal_bridge_hard_deadline_at: deadlineAt(at, hardMinutes)
      },
      updated_at: at
    };
  }

  terminalSubmissionRetryAccepted(input: {
    conversation: Conversation;
    submission: TerminalDispatchRecord;
    ledger: TerminalDispatchLedgerDocument;
    evidence: NonNullable<Awaited<ReturnType<
      TerminalDispatchExecutionService["detectAcceptance"]
    >>>;
    requestText: string;
    at: string;
    statePath: string;
    logPath: string;
    scopes: CanonicalMutationScopes;
    resources: CanonicalMutationResources;
    attempt?: TerminalSubmissionRetryRecord;
    terminalInputSent: boolean;
  }): { conversation: Conversation; attempt?: TerminalSubmissionRetryRecord } {
    const currentConversation = this.assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    const messageId = this.ports.required(
      stringValue(input.submission.message_id),
      "terminal submission retry message id is unavailable"
    );
    const preparedAt = this.ports.required(
      stringValue(input.submission.prepared_at),
      "terminal submission retry prepared timestamp is unavailable"
    );
    const acceptedConversation = this.ports.withTerminalBridgeSubmission({
      conversation: this.terminalSubmissionRetryUnstalled(currentConversation),
      messageId,
      messageType: this.terminalSubmissionRetryMessageType(input.submission),
      requestText: input.requestText,
      status: "agent_accepted",
      preparedAt,
      textInjectedAt: stringValue(input.submission.text_injected_at),
      enterDispatchedAt: stringValue(input.submission.enter_dispatched_at),
      agentAcceptedAt: input.at,
      acceptanceEvidence: input.evidence,
      lastProvenStage: "agent_accepted"
    });
    saveState(input.statePath, acceptedConversation);
    let acceptedAttempt = input.attempt;
    if (acceptedAttempt && acceptedAttempt.state !== "agent_accepted") {
      acceptedAttempt = this.saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
        ...acceptedAttempt,
        state: "agent_accepted",
        agent_accepted_at: input.at,
        updated_at: input.at
      }, acceptedAttempt.revision);
    }
    this.ports.mutationDispatchLedger.save(input.scopes, input.resources, {
      ...input.ledger,
      ...terminalSubmissionRetryLedgerFields(acceptedAttempt),
      status: "agent_accepted",
      text_injected_at: stringValue(input.ledger.text_injected_at),
      enter_dispatched_at: stringValue(input.ledger.enter_dispatched_at),
      agent_accepted_at: input.at,
      acceptance_evidence: input.evidence,
      dispatcher_pid: null
    });
    appendEvent(input.logPath, {
      ts: input.at,
      conversation_id: acceptedConversation.conversation_id,
      event: "terminal_submission_retry_agent_accepted",
      message_id: messageId,
      terminal_input_sent: input.terminalInputSent
    });
    return { conversation: acceptedConversation, attempt: acceptedAttempt };
  }

  terminalSubmissionRetryTerminalOutcome(input: {
    conversation: Conversation;
    submission: TerminalDispatchRecord;
    ledger: TerminalDispatchLedgerDocument;
    requestText: string;
    reason: string;
    at: string;
    statePath: string;
    logPath: string;
    scopes: CanonicalMutationScopes;
    resources: CanonicalMutationResources;
    attempt: TerminalSubmissionRetryRecord;
    outcome: "not_accepted" | "uncertain";
  }): Conversation {
    const currentConversation = this.assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    const messageId = this.ports.required(
      stringValue(input.submission.message_id),
      "terminal submission retry message id is unavailable"
    );
    const preparedAt = this.ports.required(
      stringValue(input.submission.prepared_at),
      "terminal submission retry prepared timestamp is unavailable"
    );
    const stalled: Conversation = {
      ...currentConversation,
      status: "stalled",
      stalled_at: input.at,
      stalled_reason: input.reason,
      updated_at: input.at
    };
    const conversation = this.ports.withTerminalBridgeSubmission({
      conversation: stalled,
      messageId,
      messageType: this.terminalSubmissionRetryMessageType(input.submission),
      requestText: input.requestText,
      status: input.outcome,
      preparedAt,
      textInjectedAt: stringValue(input.submission.text_injected_at),
      enterDispatchedAt: stringValue(input.submission.enter_dispatched_at),
      ...(input.outcome === "not_accepted"
        ? { notAcceptedAt: input.at }
        : {
            uncertainAt: input.at,
            error: input.reason,
            safeToRetry: false
          }),
      lastProvenStage: "enter_dispatched"
    });
    saveState(input.statePath, conversation);
    this.ports.mutationDispatchLedger.save(input.scopes, input.resources, {
      ...input.ledger,
      ...terminalSubmissionRetryLedgerFields(input.attempt),
      status: input.outcome,
      ...(input.outcome === "not_accepted"
        ? {
            not_accepted_at: input.at,
            uncertain_at: undefined,
            error: undefined,
            safe_to_retry: undefined
          }
        : {
            not_accepted_at: undefined,
            uncertain_at: input.at,
            error: input.reason,
            safe_to_retry: false
          }),
      acceptance_evidence: undefined,
      agent_accepted_at: undefined,
      dispatcher_pid: null
    });
    appendEvent(input.logPath, {
      ts: input.at,
      conversation_id: conversation.conversation_id,
      event: `terminal_submission_retry_${input.outcome}`,
      message_id: messageId,
      terminal_input_sent: true,
      reason: input.reason,
      do_not_retry: true
    });
    return conversation;
  }

  finalizeDeferredTerminalSubmissionRetryAccepted(input: {
    statePath: string;
    scopes: CanonicalMutationScopes;
    resources: CanonicalMutationResources;
    attempt?: TerminalSubmissionRetryRecord;
  }): { conversation: Conversation; attempt?: TerminalSubmissionRetryRecord } {
    const conversation = loadState(input.statePath);
    if (conversation.status === "closed") {
      throw new Error(
        `cannot finalize submission retry for closed Turn ` +
        `${turnIdForConversation(conversation)}; no retry state was changed`
      );
    }
    if (
      input.attempt &&
      turnIdForConversation(conversation) !== input.attempt.turn_id
    ) {
      throw new Error(
        "Turn identity changed during submission retry finalization; no retry " +
        "state was changed"
      );
    }
    const submission = this.ports.required(
      terminalBridgeSubmission(conversation),
      "deferred submission retry acceptance lost its Turn receipt"
    );
    const ledger = this.ports.required(
      this.ports.mutationDispatchLedger.load(input.scopes, input.resources),
      "deferred submission retry acceptance lost its dispatch ledger"
    );
    if (
      submission.status !== "agent_accepted" ||
      ledger.status !== "agent_accepted"
    ) {
      throw new Error(
        "deferred submission retry acceptance was not durably finalized"
      );
    }
    let attempt = input.attempt;
    if (attempt && attempt.state !== "agent_accepted") {
      const acceptedAt = stringValue(submission.agent_accepted_at) ??
        stringValue(ledger.agent_accepted_at) ?? cliNow().toISOString();
      attempt = this.saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
        ...attempt,
        state: "agent_accepted",
        agent_accepted_at: acceptedAt,
        updated_at: acceptedAt
      }, attempt.revision);
    }
    if (attempt) {
      this.ports.mutationDispatchLedger.save(input.scopes, input.resources, {
        ...ledger,
        ...terminalSubmissionRetryLedgerFields(attempt)
      });
    }
    return { conversation, attempt };
  }

  reconcileTerminalSubmissionRetryPending(input: {
    conversation: Conversation;
    submission: TerminalDispatchRecord;
    ledger: TerminalDispatchLedgerDocument;
    attempt: TerminalSubmissionRetryRecord;
    requestText: string;
    statePath: string;
    logPath: string;
    scopes: CanonicalMutationScopes;
    resources: CanonicalMutationResources;
    deferred?: TerminalSubmissionRetryDeferredContext;
  }): Conversation {
    const currentConversation = this.assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    const { attempt, submission, ledger } = input;
    const projection = projectTerminalSubmissionRetryPending({
      attempt,
      submission,
      ledger
    });
    const {
      messageId,
      preparedAt,
      textInjectedAt,
      enterDispatchedAt
    } = projection;
    if (input.deferred) {
      const transfer = input.deferred.scope.loadTransfer(
        input.deferred.transfer.transfer_id
      );
      if (!isDeferredForegroundSubmissionRetryPending(transfer)) {
        throw new Error(
          "deferred submission retry lacks exact pending transfer authority"
        );
      }
      input.deferred.transfer = transfer;
    }
    const enteredConversation = this.ports.withTerminalBridgeSubmission({
      conversation: this.withTerminalSubmissionRetryMonitorEpoch(
        this.terminalSubmissionRetryUnstalled(currentConversation),
        enterDispatchedAt
      ),
      messageId,
      messageType: this.terminalSubmissionRetryMessageType(submission),
      requestText: input.requestText,
      status: "enter_dispatched",
      preparedAt,
      textInjectedAt,
      enterDispatchedAt,
      lastProvenStage: "enter_dispatched"
    });
    saveState(input.statePath, enteredConversation);
    this.ports.mutationDispatchLedger.save(input.scopes, input.resources, {
      ...ledger,
      ...terminalSubmissionRetryLedgerFields(attempt),
      status: "enter_dispatched",
      text_injected_at: textInjectedAt,
      enter_dispatched_at: enterDispatchedAt,
      enter_not_attempted_at: undefined,
      enter_not_attempted_reason: undefined,
      uncertain_at: undefined,
      safe_to_retry: undefined,
      acceptance_evidence: undefined,
      agent_accepted_at: undefined,
      not_accepted_at: undefined,
      dispatcher_pid: null
    });
    appendEvent(input.logPath, {
      ts: enterDispatchedAt,
      conversation_id: enteredConversation.conversation_id,
      event: "terminal_submission_retry_pending_reconciled",
      message_id: messageId,
      terminal_input_sent: false
    });
    return enteredConversation;
  }

  assertTerminalSubmissionRetryDeferredMirror(input: {
    attempt: TerminalSubmissionRetryRecord;
    transfer: DeferredForegroundTransfer;
    submission: TerminalDispatchRecord;
  }): void {
    const { attempt, transfer, submission } = input;
    const replacement = attempt.mode === "replacement_send";
    const stateRank = this.terminalSubmissionRetryTransportRank(attempt);
    const expectedPreparedAt = stringValue(submission.prepared_at);
    if (
      transfer.status !== "uncertain" ||
      transfer.message_id !== attempt.original_message_id ||
      transfer.submission_retry_attempt_id !== attempt.attempt_id ||
      transfer.submission_retry_mode !== attempt.mode ||
      transfer.submission_retry_message_id !== attempt.active_message_id ||
      transfer.submission_retry_message_id !== transfer.message_id ||
      transfer.submission_retry_prepared_at !== expectedPreparedAt ||
      transfer.submission_retry_prepared_at !== transfer.prepared_at ||
      transfer.submission_retry_text_reserved_at !==
        (replacement && stateRank >= 1
          ? attempt.replacement_text_reserved_at
          : undefined) ||
      transfer.submission_retry_text_injected_at !==
        (replacement && stateRank >= 2
          ? attempt.replacement_text_injected_at
          : undefined) ||
      transfer.submission_retry_enter_reserved_at !==
        (stateRank >= (replacement ? 3 : 0)
          ? attempt.enter_reserved_at
          : undefined) ||
      transfer.submission_retry_enter_dispatched_at !==
        (stateRank >= (replacement ? 4 : 1)
          ? attempt.enter_dispatched_at
          : undefined) ||
      (attempt.state === "enter_dispatched"
        ? transfer.input_stage !== "enter_dispatched" ||
          transfer.enter_dispatched_at !== attempt.enter_dispatched_at
        : transfer.input_stage !== "text_injected")
    ) {
      throw new Error(
        "deferred submission retry mirror conflicts with its durable attempt"
      );
    }
  }

  assertTerminalSubmissionRetryDeferredMirrorCanReconcile(input: {
    attempt: TerminalSubmissionRetryRecord;
    transfer: DeferredForegroundTransfer;
    submission: TerminalDispatchRecord;
  }): void {
    const { attempt, transfer, submission } = input;
    const expectedPreparedAt = stringValue(submission.prepared_at);
    const retryFields = [
      transfer.submission_retry_attempt_id,
      transfer.submission_retry_mode,
      transfer.submission_retry_message_id,
      transfer.submission_retry_prepared_at,
      transfer.submission_retry_text_reserved_at,
      transfer.submission_retry_text_injected_at,
      transfer.submission_retry_enter_reserved_at,
      transfer.submission_retry_enter_dispatched_at
    ];
    if (transfer.submission_retry_attempt_id === undefined) {
      const initialAttempt =
        (attempt.mode === "replacement_send" &&
          attempt.state === "replacement_reserved") ||
        (attempt.mode === "exact_draft_enter" &&
          attempt.state === "enter_reserved");
      if (!initialAttempt || retryFields.some((value) => value !== undefined)) {
        throw new Error(
          "deferred submission retry mirror is missing beyond its first recoverable write"
        );
      }
      return;
    }
    if (
      transfer.submission_retry_attempt_id !== attempt.attempt_id ||
      transfer.submission_retry_mode !== attempt.mode ||
      transfer.submission_retry_message_id !== attempt.active_message_id ||
      transfer.submission_retry_message_id !== transfer.message_id ||
      transfer.submission_retry_prepared_at !== expectedPreparedAt ||
      transfer.submission_retry_prepared_at !== transfer.prepared_at
    ) {
      throw new Error(
        "deferred submission retry mirror identity conflicts with its durable attempt"
      );
    }
    const expectedStages = {
      submission_retry_text_reserved_at:
        attempt.mode === "replacement_send"
          ? attempt.replacement_text_reserved_at
          : undefined,
      submission_retry_text_injected_at:
        attempt.mode === "replacement_send"
          ? attempt.replacement_text_injected_at
          : undefined,
      submission_retry_enter_reserved_at: attempt.enter_reserved_at,
      submission_retry_enter_dispatched_at: attempt.enter_dispatched_at
    } as const;
    for (const field of Object.keys(expectedStages) as
      (keyof typeof expectedStages)[]) {
      const actual = transfer[field];
      const expected = expectedStages[field];
      if (actual !== undefined && actual !== expected) {
        throw new Error(
          "deferred submission retry mirror stage conflicts with its durable attempt"
        );
      }
    }
    const transferRank = attempt.mode === "replacement_send"
      ? transfer.submission_retry_enter_dispatched_at !== undefined
        ? 4
        : transfer.submission_retry_enter_reserved_at !== undefined
          ? 3
          : transfer.submission_retry_text_injected_at !== undefined
            ? 2
            : transfer.submission_retry_text_reserved_at !== undefined
              ? 1
              : 0
      : transfer.submission_retry_enter_dispatched_at !== undefined
        ? 1
        : transfer.submission_retry_enter_reserved_at !== undefined
          ? 0
          : -1;
    const attemptRank = this.terminalSubmissionRetryTransportRank(attempt);
    if (transferRank > attemptRank || attemptRank - transferRank > 1) {
      throw new Error(
        "deferred submission retry mirror is ahead or more than one stage behind"
      );
    }
  }

  terminalSubmissionRetryTransportRank(
    attempt: TerminalSubmissionRetryRecord
  ): number {
    const order = attempt.mode === "replacement_send"
      ? [
          "replacement_reserved", "replacement_text_reserved",
          "replacement_text_injected", "enter_reserved", "enter_dispatched"
        ]
      : ["enter_reserved", "enter_dispatched"];
    return order.indexOf(attempt.state);
  }

  reconcileTerminalSubmissionRetryLedgerPrefix(input: {
    attempt: TerminalSubmissionRetryRecord;
    ledger: TerminalDispatchLedgerDocument;
  }): { ledger: TerminalDispatchLedgerDocument; changed: boolean } {
    const { attempt, ledger } = input;
    if (attempt.state === "agent_accepted") {
      return { ledger, changed: false };
    }
    const currentAttemptId = stringValue(ledger.submission_retry_attempt_id);
    const currentHasRetryFields = TERMINAL_SUBMISSION_RETRY_LEDGER_KEYS.some(
      (key) => ledger[key] !== undefined
    );
    if (!currentAttemptId) {
      if (currentHasRetryFields || attempt.revision !== 1) {
        throw new Error(
          "terminal submission retry ledger has an unsafe missing retry prefix"
        );
      }
      return {
        ledger: { ...ledger, ...terminalSubmissionRetryLedgerFields(attempt) },
        changed: true
      };
    }
    const currentState = stringValue(ledger.submission_retry_state);
    const currentRevision = Number(ledger.submission_retry_revision);
    const allowedStates = this.terminalSubmissionRetryLedgerStates(attempt);
    const same = currentState === attempt.state &&
      currentRevision === attempt.revision;
    const immediatelyLagging = currentState === allowedStates.previous &&
      currentRevision === attempt.revision - 1;
    if (!same && !immediatelyLagging) {
      throw new Error(
        "terminal submission retry ledger is ahead, conflicting, or more than one stage behind"
      );
    }
    const expectedCurrent = this.terminalSubmissionRetryLedgerFieldsAtState(
      attempt,
      currentState as TerminalSubmissionRetryRecord["state"],
      currentRevision
    );
    if (TERMINAL_SUBMISSION_RETRY_LEDGER_KEYS.some(
      (key) => JSON.stringify(ledger[key]) !== JSON.stringify(expectedCurrent[key])
    )) {
      throw new Error(
        "terminal submission retry ledger prefix conflicts with its durable attempt"
      );
    }
    return same
      ? { ledger, changed: false }
      : {
          ledger: { ...ledger, ...terminalSubmissionRetryLedgerFields(attempt) },
          changed: true
        };
  }

  terminalSubmissionRetryLedgerStates(
    attempt: TerminalSubmissionRetryRecord
  ): { previous?: TerminalSubmissionRetryRecord["state"] } {
    const order: TerminalSubmissionRetryRecord["state"][] =
      attempt.mode === "replacement_send"
        ? [
            "replacement_reserved", "replacement_text_reserved",
            "replacement_text_injected", "enter_reserved", "enter_dispatched"
          ]
        : ["enter_reserved", "enter_dispatched"];
    const index = order.indexOf(attempt.state);
    return { previous: index > 0 ? order[index - 1] : undefined };
  }

  terminalSubmissionRetryLedgerFieldsAtState(
    attempt: TerminalSubmissionRetryRecord,
    state: TerminalSubmissionRetryRecord["state"],
    revision: number
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      ...terminalSubmissionRetryLedgerFields(attempt),
      submission_retry_state: state,
      submission_retry_revision: revision
    };
    const rank: Record<TerminalSubmissionRetryRecord["state"], number> = {
      replacement_reserved: 0,
      replacement_text_reserved: 1,
      replacement_text_injected: 2,
      enter_reserved: 3,
      enter_dispatched: 4,
      agent_accepted: 5
    };
    if (rank[state] < rank.replacement_text_reserved) {
      delete fields.submission_retry_replacement_text_reserved_at;
    }
    if (rank[state] < rank.replacement_text_injected) {
      delete fields.submission_retry_replacement_text_injected_at;
    }
    if (rank[state] < rank.enter_reserved) {
      delete fields.submission_retry_enter_reserved_at;
    }
    if (rank[state] < rank.enter_dispatched) {
      delete fields.submission_retry_enter_dispatched_at;
    }
    return fields;
  }

  printTerminalSubmissionRetryOutcome(input: {
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    attempt?: TerminalSubmissionRetryRecord;
    outcome: "agent_accepted" | "enter_dispatched" | "not_accepted" |
      "refused";
    terminalInputSent: boolean;
    reason: string;
  }): void {
    const submission = terminalBridgeSubmission(input.conversation);
    const enterDispatched = input.terminalInputSent ||
      ["agent_accepted", "enter_dispatched", "not_accepted"].includes(
        input.outcome
      ) ||
      terminalSendEnterDispatched(submission) ||
      ["enter_dispatched", "agent_accepted"].includes(
        String(input.attempt?.state ?? "")
      );
    const terminalInputDispatched = enterDispatched ||
      this.ports.durableTerminalInputDispatched(input.conversation);
    const accepted = input.outcome === "agent_accepted";
    const pending = input.outcome === "enter_dispatched";
    const callbackAvailable =
      !isTerminalDispatchOwnerReleasedStatus(input.conversation.status) &&
      (accepted || pending) &&
      callbackExpectedForConversation(input.conversation);
    printJson({
      session_id: sessionIdForConversation(input.conversation),
      turn_id: turnIdForConversation(input.conversation),
      conversation: input.conversation,
      delivered: enterDispatched,
      delivery_receipt: accepted
        ? "agent_accepted"
        : input.outcome === "enter_dispatched" ||
            input.outcome === "not_accepted"
          ? "enter_dispatched"
          : "uncertain",
      status: input.outcome === "agent_accepted"
        ? "async_pending"
        : input.outcome === "enter_dispatched"
          ? "submission_pending"
          : input.outcome === "not_accepted"
            ? "submission_not_accepted"
          : "submission_uncertain",
      submission_outcome: input.outcome === "enter_dispatched"
        ? "pending_acceptance"
        : input.outcome === "not_accepted"
          ? "not_accepted"
        : input.outcome === "refused"
          ? "uncertain"
          : "agent_accepted",
      replayed: true,
      terminal_control: input.terminalControl,
      terminal_input_sent: input.terminalInputSent,
      callback_expected: callbackAvailable,
      ...terminalSendResultContract({
        terminalInputDispatched,
        agentAcceptance: accepted ? "proven" : "unproven",
        managementMode: "managed",
        observationMode: callbackAvailable ? "managed_monitor" : "none",
        callbackAvailable,
        interactionNotificationAvailable: accepted,
        interactionResponseAvailable: accepted
      }),
      ...(input.attempt
        ? {
            submission_retry_attempt_id: input.attempt.attempt_id,
            submission_retry_state: input.attempt.state
          }
        : {}),
      do_not_retry: input.outcome !== "agent_accepted",
      reason: input.reason
    });
  }

  loadExactTerminalSubmissionRetryTurn(input: {
    statePath: string;
    exactTurnId: string;
  }): Conversation {
    const conversation = loadState(input.statePath);
    if (turnIdForConversation(conversation) !== input.exactTurnId) {
      throw new Error(
        "Turn identity changed during submission retry; no terminal input was " +
        "sent and no retry state was changed"
      );
    }
    return conversation;
  }

  assertTerminalSubmissionRetryTurnOpen(input: {
    statePath: string;
    exactTurnId: string;
  }): Conversation {
    const conversation = this.loadExactTerminalSubmissionRetryTurn(input);
    if (conversation.status === "closed") {
      throw new Error(
        `cannot retry submission for closed Turn ${input.exactTurnId}; no ` +
        "terminal input was sent and no retry state was changed"
      );
    }
    return conversation;
  }

  saveTerminalSubmissionRetryForOpenTurn(
    statePath: string,
    candidate: TerminalSubmissionRetryRecord,
    expectedRevision: number | null
  ): TerminalSubmissionRetryRecord {
    this.assertTerminalSubmissionRetryTurnOpen({
      statePath,
      exactTurnId: candidate.turn_id
    });
    return saveTerminalSubmissionRetry(
      statePath,
      candidate,
      expectedRevision
    );
  }

  loadTerminalSubmissionRetryLockedAuthority(input: {
    invocation: TerminalSubmissionRetryInvocation;
    scopes: CanonicalStateMutationScopes;
    resources: CanonicalStateMutationResources;
  }): TerminalSubmissionRetryLockedAuthority {
    const {
      options, exactTurnId, statePath, logPath, storeDir, terminalControl
    } = input.invocation;
    const route = bindTerminalDispatchRoute(input.scopes, input.resources);
    assertTerminalDispatchRouteMatches(route, {
      terminalControl,
      terminalKey: this.ports.terminalBridgeRuntimeKey(terminalControl),
      storeDir,
      statePath,
      logPath
    });
    let conversation = this.assertTerminalSubmissionRetryTurnOpen({
      statePath,
      exactTurnId
    });
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const lockedControl = this.ports.terminalControlFromTakeover(takeover);
    if (
      turnIdForConversation(conversation) !== exactTurnId ||
      executorForConversation(conversation).kind !== "codex" ||
      !lockedControl ||
      !terminalControlsShareIncarnation(lockedControl, terminalControl)
    ) {
      throw new Error(
        "Turn or terminal authority changed before submission retry; no terminal input was sent"
      );
    }
    let submission = terminalBridgeSubmission(conversation);
    if (!submission) {
      throw new Error(
        "Turn has no terminal submission receipt to recover; no terminal input was sent"
      );
    }
    const currentMessageId = this.ports.required(
      stringValue(submission.message_id),
      "terminal submission retry message id is unavailable"
    );
    const attempt = loadTerminalSubmissionRetry(statePath);
    const originalMessageId = attempt?.original_message_id ?? currentMessageId;
    const requestText = terminalSubmissionPayload(this.ports.required(
      stringValue(takeover?.terminal_bridge_request_text),
      "terminal submission retry request text is unavailable"
    ));
    const requestHash = this.ports.required(
      this.ports.terminalBridgeRequestFingerprint(requestText),
      "terminal submission retry request hash is unavailable"
    );
    const messageType = this.terminalSubmissionRetryMessageType(submission);
    const messageBodyHash = createHash("sha256").update(requestText).digest("hex");
    this.ports.validateStoredTerminalSubmissionMatch({
      owner: conversation,
      receipt: submission,
      options,
      terminalControl,
      requestText,
      requestHash,
      expectedStoreDir: storeDir,
      expectedSessionId: sessionIdForConversation(conversation),
      expectedTurnId: exactTurnId,
      expectedMessageType: messageType,
      expectedStatePath: statePath
    });
    const ledger = this.ports.mutationDispatchLedger.load(input.scopes, input.resources);
    this.assertTerminalSubmissionRetryLedgerAuthority({
      ledger,
      conversation,
      exactTurnId,
      currentMessageId,
      messageType,
      messageBodyHash,
      requestHash,
      storeDir,
      statePath,
      terminalControl
    });
    let currentLedger = ledger as TerminalDispatchLedgerDocument;
    const takeoverDeferredTransferId = stringValue(
      takeover?.deferred_foreground_transfer_id
    );
    const ledgerDeferredTransferId = stringValue(
      currentLedger.deferred_foreground_transfer_id
    );
    if (
      takeoverDeferredTransferId &&
      takeoverDeferredTransferId === ledgerDeferredTransferId &&
      stringValue(submission.deferred_foreground_transfer_id) === undefined
    ) {
      conversation = this.withDeferredTransferSubmissionAuthority(
        conversation,
        currentMessageId,
        takeoverDeferredTransferId
      );
      saveState(statePath, conversation);
      submission = this.ports.required(
        terminalBridgeSubmission(conversation),
        "deferred terminal submission receipt upgrade failed"
      );
    }
    const expectedCallbackFingerprint =
      callbackRouteFingerprintForConversation(conversation) ?? null;
    if (
      (currentLedger.callback_route_fingerprint ?? null) !==
        expectedCallbackFingerprint ||
      (submission.callback_route_fingerprint ?? null) !==
        expectedCallbackFingerprint
    ) {
      throw new Error(
        "terminal submission callback route changed; no terminal input was sent"
      );
    }
    const deferredTransferId = this.exactTerminalSubmissionRetryDeferredTransferId({
      takeover,
      submission,
      ledger: currentLedger
    });
    this.assertTerminalSubmissionRetryAttemptIdentity({
      attempt,
      conversation,
      storeDir,
      statePath,
      originalMessageId,
      requestHash,
      terminalControl,
      deferredTransferId
    });
    this.assertTerminalSubmissionRetryGeneration({
      attempt,
      takeover,
      currentMessageId,
      originalMessageId
    });
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    return {
      conversation,
      takeover,
      submission,
      ledger: currentLedger,
      attempt,
      currentMessageId,
      originalMessageId,
      requestText,
      requestHash,
      deferredTransferId,
      lifecycleSettled: callbackDelivery?.status === "delivered" ||
        isTerminalDispatchOwnerReleasedStatus(effectiveTurnStatus(conversation))
    };
  }

  assertTerminalSubmissionRetryLedgerAuthority(input: {
    ledger?: TerminalDispatchLedgerDocument;
    conversation: Conversation;
    exactTurnId: string;
    currentMessageId: string;
    messageType: "task" | "answer";
    messageBodyHash: string;
    requestHash: string;
    storeDir: string;
    statePath: string;
    terminalControl: TerminalControlRef;
  }): asserts input is typeof input & { ledger: TerminalDispatchLedgerDocument } {
    const { ledger } = input;
    if (
      !ledger || terminalDispatchLedgerLooksLifecycle(ledger) ||
      stringValue(ledger.conversation_id) !== input.conversation.conversation_id ||
      stringValue(ledger.session_id) !== sessionIdForConversation(input.conversation) ||
      stringValue(ledger.turn_id) !== input.exactTurnId ||
      stringValue(ledger.generation_id) !== input.currentMessageId ||
      stringValue(ledger.message_id) !== input.currentMessageId ||
      stringValue(ledger.message_type) !== input.messageType ||
      stringValue(ledger.message_body_hash) !== input.messageBodyHash ||
      stringValue(ledger.executor_kind) !== "codex" ||
      stringValue(ledger.request_hash) !== input.requestHash ||
      path.resolve(stringValue(ledger.store_dir) ?? "") !==
        path.resolve(input.storeDir) ||
      !sameCanonicalStatePath(ledger.state_path, input.statePath) ||
      !this.ports.terminalDispatchRecordMatchesControl(ledger, input.terminalControl)
    ) {
      throw new Error(
        "terminal dispatch ledger does not match the exact Turn generation; no terminal input was sent"
      );
    }
  }

  exactTerminalSubmissionRetryDeferredTransferId(input: {
    takeover?: Record<string, unknown>;
    submission: TerminalDispatchRecord;
    ledger: TerminalDispatchLedgerDocument;
  }): string | undefined {
    const references = [
      stringValue(input.takeover?.deferred_foreground_transfer_id),
      stringValue(input.submission.deferred_foreground_transfer_id),
      stringValue(input.ledger.deferred_foreground_transfer_id)
    ];
    const hasDeferred = references.some((value) => value !== undefined);
    if (
      hasDeferred &&
      (references.some((value) => value === undefined) ||
        new Set(references).size !== 1)
    ) {
      throw new Error(
        "deferred transfer references disagree across Turn and ledger; no terminal input was sent"
      );
    }
    return hasDeferred ? references[0] : undefined;
  }

  assertTerminalSubmissionRetryGeneration(input: {
    attempt?: TerminalSubmissionRetryRecord;
    takeover?: Record<string, unknown>;
    currentMessageId: string;
    originalMessageId: string;
  }): void {
    const currentGenerationEligible = input.attempt?.mode === "replacement_send"
      ? input.attempt.state === "replacement_reserved"
        ? [input.attempt.original_message_id, input.attempt.active_message_id]
          .includes(input.currentMessageId)
        : input.currentMessageId === input.attempt.active_message_id
      : input.currentMessageId === input.originalMessageId;
    if (
      stringValue(input.takeover?.terminal_bridge_message_id) !==
        input.currentMessageId ||
      !currentGenerationEligible
    ) {
      throw new Error(
        "terminal submission retry generation changed; no terminal input was sent"
      );
    }
  }

  reconcileTerminalSubmissionRetryDeferredTransfer(input: {
    invocation: TerminalSubmissionRetryInvocation;
    scope: DeferredForegroundApplicationScope;
    boundary: DeferredCodexForegroundBindingBoundary;
    transfer: DeferredForegroundTransfer;
    attempt?: TerminalSubmissionRetryRecord;
    submission: TerminalDispatchRecord;
  }): DeferredForegroundTransfer {
    const { attempt } = input;
    if (!attempt) return input.transfer;
    const application = this.ports.deferredForegroundApplication(
      input.invocation.options,
      input.invocation.live
    );
    const boundary = deferredForegroundBoundaryProjection(input.boundary);
    let transfer = input.transfer;
    if (transfer.submission_retry_attempt_id === undefined) {
      if (
        attempt.mode === "replacement_send" &&
        attempt.state === "replacement_reserved"
      ) {
        transfer = application.reserveSubmissionRetry({
          scope: input.scope,
          boundary,
          attemptId: attempt.attempt_id,
          mode: attempt.mode,
          messageId: attempt.active_message_id,
          preparedAt: this.ports.required(
            stringValue(input.submission.prepared_at),
            "deferred retry prepared timestamp is unavailable"
          )
        });
      } else if (
        attempt.mode === "exact_draft_enter" &&
        attempt.state === "enter_reserved"
      ) {
        transfer = application.reserveSubmissionRetry({
          scope: input.scope,
          boundary,
          attemptId: attempt.attempt_id,
          mode: attempt.mode,
          messageId: attempt.active_message_id,
          preparedAt: this.ports.required(
            stringValue(input.submission.prepared_at),
            "deferred retry prepared timestamp is unavailable"
          )
        });
        transfer = application.advanceSubmissionRetry({
          scope: input.scope,
          boundary,
          attemptId: attempt.attempt_id,
          messageId: attempt.active_message_id,
          stage: "enter_reserved",
          at: attempt.enter_reserved_at as string
        });
      } else {
        throw new Error(
          "deferred retry mirror is incomplete after an irreversible boundary; no terminal input was sent"
        );
      }
    }
    if (!transfer.submission_retry_attempt_id) return transfer;
    if (
      attempt.mode === "replacement_send" &&
      [
        "replacement_text_reserved", "replacement_text_injected",
        "enter_reserved", "enter_dispatched"
      ].includes(attempt.state) &&
      !transfer.submission_retry_text_reserved_at
    ) {
      transfer = application.advanceSubmissionRetry({
        scope: input.scope,
        boundary,
        attemptId: attempt.attempt_id,
        messageId: attempt.active_message_id,
        stage: "text_reserved",
        at: attempt.replacement_text_reserved_at as string
      });
    }
    if (
      ["replacement_text_injected", "enter_reserved", "enter_dispatched"]
        .includes(attempt.state) &&
      !transfer.submission_retry_text_injected_at
    ) {
      transfer = application.advanceSubmissionRetry({
        scope: input.scope,
        boundary,
        attemptId: attempt.attempt_id,
        messageId: attempt.active_message_id,
        stage: "text_injected",
        at: attempt.replacement_text_injected_at ??
          attempt.enter_reserved_at ?? attempt.reserved_at
      });
    }
    if (
      ["enter_reserved", "enter_dispatched"].includes(attempt.state) &&
      !transfer.submission_retry_enter_reserved_at
    ) {
      transfer = application.advanceSubmissionRetry({
        scope: input.scope,
        boundary,
        attemptId: attempt.attempt_id,
        messageId: attempt.active_message_id,
        stage: "enter_reserved",
        at: attempt.enter_reserved_at as string
      });
    }
    if (
      attempt.state === "enter_dispatched" &&
      !transfer.submission_retry_enter_dispatched_at
    ) {
      transfer = application.advanceSubmissionRetry({
        scope: input.scope,
        boundary,
        attemptId: attempt.attempt_id,
        messageId: attempt.active_message_id,
        stage: "enter_dispatched",
        at: attempt.enter_dispatched_at as string
      });
    }
    return transfer;
  }

  prepareTerminalSubmissionRetryDeferredContext(input: {
    invocation: TerminalSubmissionRetryInvocation;
    authority: TerminalSubmissionRetryLockedAuthority;
    scopes: CanonicalStateMutationScopes;
    resources: CanonicalStateMutationResources;
  }): {
    deferred?: TerminalSubmissionRetryDeferredContext;
    ledger: TerminalDispatchLedgerDocument;
  } {
    this.assertTerminalSubmissionRetryTurnOpen({
      statePath: input.invocation.statePath,
      exactTurnId: input.invocation.exactTurnId
    });
    const { deferredTransferId, attempt, submission } = input.authority;
    if (!deferredTransferId) return { ledger: input.authority.ledger };
    const scope = bindDeferredForegroundApplicationScope(
      input.scopes,
      input.resources
    );
    const transfer = scope.loadTransfer(deferredTransferId);
    const boundary = deferredRecoveryAdapter.deferredCodexBoundaryFromTransfer(
      this.ports.deferredForegroundRecoveryAdapterPorts(),
      { terminal: input.invocation.live, transfer }
    );
    const projectedBoundary = deferredForegroundBoundaryProjection(boundary);
    scope.assertBoundary(projectedBoundary);
    if (attempt && attempt.state !== "agent_accepted") {
      this.assertTerminalSubmissionRetryDeferredMirrorCanReconcile({
        attempt,
        transfer,
        submission
      });
    }
    const ledgerMirror = attempt && attempt.state !== "agent_accepted"
      ? this.reconcileTerminalSubmissionRetryLedgerPrefix({
          attempt,
          ledger: input.authority.ledger
        })
      : undefined;
    const currentTransfer = this.reconcileTerminalSubmissionRetryDeferredTransfer({
      invocation: input.invocation,
      scope,
      boundary,
      transfer,
      attempt,
      submission
    });
    this.assertTerminalSubmissionRetryDeferredTransferAuthority({
      invocation: input.invocation,
      authority: input.authority,
      transfer: currentTransfer,
      attempt
    });
    this.ports.deferredForegroundApplication(
      input.invocation.options,
      input.invocation.live
    ).assertTransferAuthority(scope, currentTransfer, projectedBoundary);
    let ledger = input.authority.ledger;
    if (attempt && attempt.state !== "agent_accepted") {
      this.assertTerminalSubmissionRetryDeferredMirror({
        attempt,
        transfer: currentTransfer,
        submission
      });
      if (ledgerMirror?.changed) {
        this.ports.mutationDispatchLedger.save(input.scopes, input.resources,
          ledgerMirror.ledger);
        ledger = ledgerMirror.ledger;
      }
    }
    return {
      deferred: { scope, transfer: currentTransfer, boundary },
      ledger
    };
  }

  assertTerminalSubmissionRetryDeferredTransferAuthority(input: {
    invocation: TerminalSubmissionRetryInvocation;
    authority: TerminalSubmissionRetryLockedAuthority;
    transfer: DeferredForegroundTransfer;
    attempt?: TerminalSubmissionRetryRecord;
  }): void {
    const { transfer, attempt } = input;
    const plannedReplacement = Boolean(
      attempt?.mode === "replacement_send" &&
      attempt.state === "replacement_reserved" &&
      transfer.submission_retry_text_reserved_at === undefined
    );
    const activeMessageId = deferredForegroundActiveMessageId(transfer);
    const currentMessageId = input.authority.currentMessageId;
    if (
      transfer.turn_id !== input.invocation.exactTurnId ||
      transfer.target_session_id !==
        sessionIdForConversation(input.authority.conversation) ||
      transfer.request_hash !== input.authority.requestHash ||
      !sameCanonicalStatePath(transfer.state_path, input.invocation.statePath) ||
      transfer.message_id !== input.authority.originalMessageId ||
      (plannedReplacement
        ? ![input.authority.originalMessageId, attempt!.active_message_id]
          .includes(currentMessageId)
        : activeMessageId !== currentMessageId) ||
      (attempt
        ? transfer.submission_retry_attempt_id !== attempt.attempt_id ||
          transfer.submission_retry_message_id !== attempt.active_message_id
        : transfer.submission_retry_attempt_id !== undefined)
    ) {
      throw new Error(
        "deferred submission retry transfer authority changed; no terminal input was sent"
      );
    }
  }

  reconcileTerminalSubmissionRetryDeferredPending(
    context: TerminalSubmissionRetryFlowContext,
    state: TerminalSubmissionRetryFlowState
  ): boolean {
    if (
      !context.deferred || state.attempt?.state !== "enter_dispatched" ||
      state.submission.status === "agent_accepted" ||
      state.ledger.status === "agent_accepted"
    ) {
      return false;
    }
    state.conversation = this.reconcileTerminalSubmissionRetryPending({
      conversation: state.conversation,
      submission: state.submission,
      ledger: state.ledger,
      attempt: state.attempt,
      requestText: context.requestText,
      statePath: context.invocation.statePath,
      logPath: context.invocation.logPath,
      scopes: context.scopes,
      resources: context.resources,
      deferred: context.deferred
    });
    state.submission = this.ports.required(
      terminalBridgeSubmission(state.conversation),
      "terminal submission retry receipt disappeared during pending reconciliation"
    );
    state.ledger = this.ports.required(
      this.ports.mutationDispatchLedger.load(context.scopes, context.resources),
      "terminal submission retry ledger disappeared during pending reconciliation"
    );
    return true;
  }

  async recoverPartialTerminalSubmissionRetryAcceptance(
    context: TerminalSubmissionRetryFlowContext,
    state: TerminalSubmissionRetryFlowState
  ): Promise<boolean> {
    this.assertTerminalSubmissionRetryTurnOpen({
      statePath: context.invocation.statePath,
      exactTurnId: context.invocation.exactTurnId
    });
    const partialAcceptance =
      state.submission.status === "agent_accepted" ||
      state.ledger.status === "agent_accepted" ||
      state.attempt?.state === "agent_accepted";
    if (!partialAcceptance) return false;
    const {
      options, terminalControl, live, statePath, logPath, storeDir
    } = context.invocation;
    if (
      context.deferred &&
      ["uncertain", "dispatch_started"].includes(context.deferred.transfer.status)
    ) {
      const recovered = await deferredRecoveryAdapter
        .recoverAcceptedDeferredForegroundDispatch(
          this.ports.deferredForegroundRecoveryAdapterPorts(),
          {
            options,
            scope: context.deferred.scope,
            storeDir,
            terminal: live,
            transfer: context.deferred.transfer,
            boundary: context.deferred.boundary
          }
        );
      this.assertTerminalSubmissionRetryTurnOpen({
        statePath,
        exactTurnId: context.invocation.exactTurnId
      });
      if (!recovered) {
        this.printTerminalSubmissionRetryOutcome({
          conversation: state.conversation,
          terminalControl,
          attempt: state.attempt,
          outcome: "refused",
          terminalInputSent: false,
          reason: "Partial deferred acceptance lacks current native evidence; no terminal input was sent."
        });
        return true;
      }
      const finalized = this.finalizeDeferredTerminalSubmissionRetryAccepted({
        statePath,
        scopes: context.scopes,
        resources: context.resources,
        attempt: state.attempt
      });
      state.conversation = finalized.conversation;
      state.attempt = finalized.attempt;
      this.ports.startTerminalBridgeMonitorForConversation({
        conversation: state.conversation,
        statePath,
        logPath,
        options
      });
      this.printTerminalSubmissionRetryOutcome({
        conversation: state.conversation,
        terminalControl,
        attempt: state.attempt,
        outcome: "agent_accepted",
        terminalInputSent: false,
        reason: "Deferred native acceptance, source/target Sessions, and monitoring were reconciled without terminal input."
      });
      return true;
    }
    const durableEvidence = await context.execution.detectAcceptance({
      executor: "codex",
      conversation: state.conversation,
      terminalControl,
      ...this.ports.terminalAcceptanceCompanionFences(state.conversation, terminalControl)
    });
    this.assertTerminalSubmissionRetryTurnOpen({
      statePath,
      exactTurnId: context.invocation.exactTurnId
    });
    if (!durableEvidence) {
      this.printTerminalSubmissionRetryOutcome({
        conversation: state.conversation,
        terminalControl,
        attempt: state.attempt,
        outcome: "refused",
        terminalInputSent: false,
        reason: "Partial acceptance metadata lacks current native evidence; no terminal input was sent."
      });
      return true;
    }
    const repaired = this.terminalSubmissionRetryAccepted({
      conversation: state.conversation,
      submission: state.submission,
      ledger: state.ledger,
      evidence: durableEvidence,
      requestText: context.requestText,
      at: stringValue(state.submission.agent_accepted_at) ??
        stringValue(state.ledger.agent_accepted_at) ?? cliNow().toISOString(),
      statePath,
      logPath,
      scopes: context.scopes,
      resources: context.resources,
      attempt: state.attempt,
      terminalInputSent: false
    });
    state.conversation = repaired.conversation;
    state.attempt = repaired.attempt;
    this.ports.startTerminalBridgeMonitorForConversation({
      conversation: state.conversation,
      statePath,
      logPath,
      options
    });
    this.printTerminalSubmissionRetryOutcome({
      conversation: state.conversation,
      terminalControl,
      attempt: state.attempt,
      outcome: "agent_accepted",
      terminalInputSent: false,
      reason: "Partial durable acceptance was reconciled without terminal input and monitoring was ensured."
    });
    return true;
  }

}
