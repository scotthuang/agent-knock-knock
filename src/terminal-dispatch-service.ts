import {
  sessionIdForConversation,
  turnIdForConversation,
  type AgentMessage,
  type Conversation,
  type Executor
} from "./protocol.js";
import { type EventRecord } from "./store.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import type {
  TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import type {
  TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-acceptance.js";

export type TerminalBridgeSubmissionStatus =
  | "prepared"
  | "text_injected"
  | "enter_dispatched"
  | "agent_accepted"
  | "not_accepted"
  | "submitted"
  | "uncertain"
  | "aborted";

export type TerminalAcceptancePollResult =
  | {
      outcome: "agent_accepted";
      evidence: TerminalSubmissionAcceptanceEvidence;
    }
  | { outcome: "pending_acceptance" }
  | { outcome: "not_accepted"; reason: string }
  | { outcome: "uncertain"; reason: string };

export interface TerminalBridgeSubmissionMutation {
  conversation: Conversation;
  messageId: string;
  messageType?: "task" | "answer";
  messageBody?: string;
  requestText: string;
  status: TerminalBridgeSubmissionStatus;
  preparedAt: string;
  textInjectedAt?: string;
  enterDispatchedAt?: string;
  agentAcceptedAt?: string;
  notAcceptedAt?: string;
  submittedAt?: string;
  uncertainAt?: string;
  abortedAt?: string;
  error?: string;
  acceptanceEvidence?: TerminalSubmissionAcceptanceEvidence;
  lastProvenStage?:
    | "prepared"
    | "text_injected"
    | "enter_dispatched"
    | "agent_accepted";
  safeToRetry?: boolean;
}

export type TerminalDispatchMonitorHandle = { pid?: number };

type TerminalDispatchMessage = AgentMessage & { type: "task" | "answer" };

export interface TerminalDispatchServiceContext {
  bridgeEnabled: boolean;
  conversation: Conversation;
  preparedConversation: Conversation;
  message: TerminalDispatchMessage;
  executor: Executor;
  terminalControl: TerminalControlRef;
  terminalPayload: string;
  terminalRequestHash: string;
  bridgeStartedAt: string;
  statePath: string;
  logPath: string;
  previousDispatchLedger?: TerminalDispatchLedgerDocument;
  recordMessageAfterSend: boolean;
  recordRawAttachmentAfterSend: boolean;
  setupFailureInjected: boolean;
  abortedStatePersistenceFailureInjected: boolean;
  finalLedgerFailureInjected: boolean;
  dispatcherPid: number;
  agentTimeoutMinutes: number;
  agentHardTimeoutMinutes: number;
  deferredTransferId?: string;
}

export interface TerminalDispatchServicePorts {
  nowIso(): string;
  withSubmission(
    mutation: TerminalBridgeSubmissionMutation
  ): Conversation;
  ledgerFields(conversation: Conversation): Record<string, unknown>;
  saveState(conversation: Conversation): void;
  saveLedger(ledger: Record<string, unknown>): void;
  appendEvent(event: EventRecord): void;
  appendMessage(message: AgentMessage): void;
  log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>
  ): void;
  print(value: Record<string, unknown>): void;
  abortDeferredPreInput(terminalInputNotStartedAt?: string): boolean;
  rollbackRawAttach(): boolean;
  markDeferredUncertain(reason: string): void;
  stallOtherConversations(): string[];
  startMonitor(
    conversation: Conversation
  ): TerminalDispatchMonitorHandle | undefined;
}

export interface TerminalTransportStageHooks {
  advanceDeferred?(stage: "text_injected" | "enter_dispatched", at: string): void;
  assertBoundary?(stage: "text_injected" | "enter_dispatched"): Promise<void>;
}

export interface TerminalDispatchProgress {
  stagedConversation: Conversation;
  textInjectedAt?: string;
  enterDispatchedAt?: string;
}

/**
 * Owns the durable ordinary-dispatch phase machine after all terminal, Turn,
 * and Store locks have already been acquired by the CLI shell. The service
 * deliberately performs no locking and never reads process or terminal state.
 */
export class TerminalDispatchService {
  readonly #context: TerminalDispatchServiceContext;
  readonly #ports: TerminalDispatchServicePorts;
  #progress: TerminalDispatchProgress;
  #monitor: TerminalDispatchMonitorHandle | undefined;
  #bookkeepingWarning: string | undefined;

  constructor(
    context: TerminalDispatchServiceContext,
    ports: TerminalDispatchServicePorts
  ) {
    this.#context = context;
    this.#ports = ports;
    this.#progress = { stagedConversation: context.preparedConversation };
  }

  progress(): TerminalDispatchProgress {
    return { ...this.#progress };
  }

  persistPrepared(): void {
    this.#persistBeforeInput(
      () => this.#ports.saveLedger(this.#ledgerFor(
        this.#context.preparedConversation,
        "prepared"
      )),
      "prepared ledger persistence failed before terminal input"
    );
    this.#persistBeforeInput(
      () => this.#ports.saveState(this.#context.preparedConversation),
      "prepared state persistence failed before terminal input"
    );
  }

  recordPreparedBookkeeping(): boolean {
    const {
      bridgeStartedAt,
      conversation,
      executor,
      logPath,
      message,
      recordMessageAfterSend,
      recordRawAttachmentAfterSend,
      statePath,
      terminalControl,
      terminalRequestHash
    } = this.#context;
    try {
      if (this.#context.setupFailureInjected) {
        throw new Error("injected terminal setup failure before terminal input");
      }
      if (recordRawAttachmentAfterSend) {
        const takeover = isRecord(conversation.native_session_takeover)
          ? conversation.native_session_takeover
          : undefined;
        const sourceConversationId = stringValue(takeover?.native_session_id);
        this.#ports.appendEvent({
          ts: bridgeStartedAt,
          conversation_id: conversation.conversation_id,
          event: "raw_terminal_session_attached",
          source_conversation_id: sourceConversationId,
          agent: executor.kind,
          terminal_control: terminalControl,
          executor
        });
        this.#ports.log("info", "raw_terminal_session_attached", {
          conversation_id: conversation.conversation_id,
          source_conversation_id: sourceConversationId,
          terminal_target: terminalControl.target,
          state_path: statePath,
          event_log_path: logPath
        });
      }
      if (recordMessageAfterSend) {
        this.#ports.appendMessage(message);
        this.#ports.log("info", "message_created", {
          conversation_id: conversation.conversation_id,
          agent: executor.kind,
          executor_session: executor.session,
          message_type: message.type,
          state_path: statePath,
          event_log_path: logPath,
          message: textSummary(message.body)
        });
      }
      this.#ports.appendEvent({
        ts: bridgeStartedAt,
        conversation_id: conversation.conversation_id,
        event: "terminal_message_submit_prepared",
        message_id: message.id,
        executor,
        terminal_control: terminalControl,
        request_hash: terminalRequestHash,
        dispatcher_pid: this.#context.dispatcherPid
      });
      return false;
    } catch (error) {
      this.#recordAbort(error, "setup");
      return true;
    }
  }

  async recordTransportStage(
    stage: "text_injected" | "enter_dispatched",
    hooks: TerminalTransportStageHooks = {}
  ): Promise<void> {
    const at = this.#ports.nowIso();
    if (stage === "text_injected") {
      this.#progress.textInjectedAt = at;
    } else {
      this.#progress.enterDispatchedAt = at;
    }
    const stagedConversation = this.#ports.withSubmission({
      conversation: this.#progress.stagedConversation,
      ...this.#submissionIdentity(),
      status: stage,
      textInjectedAt: this.#progress.textInjectedAt,
      enterDispatchedAt: this.#progress.enterDispatchedAt
    });
    this.#progress.stagedConversation = stagedConversation;
    this.#ports.saveState(stagedConversation);
    this.#ports.saveLedger(this.#ledgerFor(
      stagedConversation,
      stage,
      {
        text_injected_at: this.#progress.textInjectedAt,
        enter_dispatched_at: this.#progress.enterDispatchedAt
      }
    ));
    hooks.advanceDeferred?.(stage, at);
    await hooks.assertBoundary?.(stage);
    try {
      this.#ports.appendEvent({
        ts: at,
        conversation_id: stagedConversation.conversation_id,
        event: `terminal_message_${stage}`,
        message_id: this.#context.message.id,
        executor: this.#context.executor,
        terminal_control: this.#context.terminalControl,
        request_hash: this.#context.terminalRequestHash
      });
    } catch (error) {
      this.#recordPostTransportBookkeepingFailure(stage, error);
    }
  }

  commitAcceptance(
    submittedBase: Conversation,
    acceptance: TerminalAcceptancePollResult
  ) {
    const resolvedAt = this.#ports.nowIso();
    const terminalStatus: TerminalBridgeSubmissionStatus =
      acceptance.outcome === "pending_acceptance"
        ? "enter_dispatched"
        : acceptance.outcome;
    const outcomeBase = acceptance.outcome === "not_accepted" ||
        acceptance.outcome === "uncertain"
      ? {
          ...submittedBase,
          status: "stalled" as const,
          stalled_at: resolvedAt,
          stalled_reason: acceptance.reason,
          updated_at: resolvedAt
        }
      : submittedBase;
    const deliveredConversation = this.#ports.withSubmission({
      conversation: outcomeBase,
      ...this.#submissionIdentity(),
      status: terminalStatus,
      textInjectedAt: this.#progress.textInjectedAt,
      enterDispatchedAt: this.#progress.enterDispatchedAt,
      ...(acceptance.outcome === "agent_accepted"
        ? {
            agentAcceptedAt: resolvedAt,
            acceptanceEvidence: acceptance.evidence
          }
        : {}),
      ...(acceptance.outcome === "not_accepted"
        ? { notAcceptedAt: resolvedAt }
        : {}),
      ...(acceptance.outcome === "uncertain"
        ? {
            uncertainAt: resolvedAt,
            error: acceptance.reason,
            lastProvenStage: "enter_dispatched" as const
          }
        : {})
    });
    this.#ports.saveState(deliveredConversation);
    try {
      if (this.#context.finalLedgerFailureInjected) {
        throw new Error("injected final terminal ledger persistence failure");
      }
      this.#ports.saveLedger(this.#ledgerFor(
        deliveredConversation,
        terminalStatus,
        {
          text_injected_at: this.#progress.textInjectedAt,
          enter_dispatched_at: this.#progress.enterDispatchedAt,
          ...(acceptance.outcome === "agent_accepted"
            ? {
                agent_accepted_at: resolvedAt,
                acceptance_evidence: acceptance.evidence
              }
            : {}),
          ...(acceptance.outcome === "not_accepted"
            ? { not_accepted_at: resolvedAt }
            : {}),
          ...(acceptance.outcome === "uncertain"
            ? {
                uncertain_at: resolvedAt,
                error: textSummary(acceptance.reason)
              }
            : {}),
          dispatcher_pid: null
        }
      ));
    } catch (error) {
      this.#recordPostTransportBookkeepingFailure(
        "final_terminal_ledger",
        error
      );
    }
    try {
      this.#ports.appendEvent({
        ts: resolvedAt,
        conversation_id: deliveredConversation.conversation_id,
        event: acceptance.outcome === "agent_accepted"
          ? "terminal_message_agent_accepted"
          : acceptance.outcome === "pending_acceptance"
            ? "terminal_message_acceptance_pending"
            : `terminal_message_${acceptance.outcome}`,
        message_id: this.#context.message.id,
        executor: this.#context.executor,
        terminal_control: this.#context.terminalControl,
        delivery_receipt: terminalStatus,
        do_not_retry: acceptance.outcome !== "agent_accepted"
      });
    } catch (error) {
      this.#recordPostTransportBookkeepingFailure(terminalStatus, error);
    }
    if (
      this.#context.bridgeEnabled &&
      (acceptance.outcome === "agent_accepted" ||
        acceptance.outcome === "pending_acceptance")
    ) {
      try {
        this.#monitor = this.#ports.startMonitor(deliveredConversation);
        if (this.#monitor) {
          this.#ports.appendEvent({
            ts: this.#ports.nowIso(),
            conversation_id: deliveredConversation.conversation_id,
            event: "terminal_bridge_monitor_launch",
            pid: this.#monitor.pid ?? null,
            terminal_control: this.#context.terminalControl,
            phase: acceptance.outcome,
            agent_timeout_minutes: this.#context.agentTimeoutMinutes,
            agent_hard_timeout_minutes: this.#context.agentHardTimeoutMinutes
          });
        }
      } catch (error) {
        this.#recordPostTransportBookkeepingFailure("monitor_launch", error);
      }
    }
    return {
      deliveredConversation,
      monitor: this.#monitor,
      bookkeepingWarning: this.#bookkeepingWarning
    };
  }

  handleTransportFailure(error: unknown, provedNotStarted: boolean): void {
    if (!this.#progress.textInjectedAt && provedNotStarted) {
      this.#recordAbort(error, "transport", this.#ports.nowIso());
      return;
    }
    this.#recordUncertain(error);
  }

  #recordAbort(
    error: unknown,
    kind: "setup" | "transport",
    terminalInputNotStartedAt?: string
  ): void {
    const transportFailure = kind === "transport";
    const abortedAt = terminalInputNotStartedAt ?? this.#ports.nowIso();
    const errorMessage = error instanceof Error ? error.message : String(error);
    let dispatchLedgerRestored = true;
    try {
      if (!this.#ports.abortDeferredPreInput(
        terminalInputNotStartedAt
      )) {
        this.#restorePreviousLedger(
          transportFailure
            ? "terminal transport was proved not to have started"
            : "terminal submission aborted before terminal input"
        );
      }
    } catch (ledgerError) {
      dispatchLedgerRestored = false;
      this.#logConversationFailure(
        "terminal_dispatch_ledger_restore_failed",
        this.#context.conversation.conversation_id,
        ledgerError
      );
    }
    const rawAttachRolledBack = this.#ports.rollbackRawAttach();
    const durableAbortCanBeRetryable =
      dispatchLedgerRestored && rawAttachRolledBack;
    const failureBase = this.#context.recordRawAttachmentAfterSend
      ? {
          ...this.#context.preparedConversation,
          status: "failed" as const,
          failed_at: abortedAt,
          failure_reason: transportFailure
            ? "terminal transport failed before terminal input"
            : "terminal submission setup failed before terminal input"
        }
      : {
          ...this.#context.preparedConversation,
          status: this.#context.conversation.status,
          ...(this.#context.conversation.idle_since
            ? { idle_since: this.#context.conversation.idle_since }
            : {})
        };
    const abortedConversation = this.#ports.withSubmission({
      conversation: failureBase,
      ...this.#submissionIdentity(),
      status: "aborted",
      abortedAt,
      error: errorMessage,
      safeToRetry: durableAbortCanBeRetryable
    });
    let abortedStatePersisted = false;
    try {
      if (
        !transportFailure &&
        this.#context.abortedStatePersistenceFailureInjected
      ) {
        throw new Error(
          "injected aborted submission state persistence failure"
        );
      }
      this.#ports.saveState(abortedConversation);
      abortedStatePersisted = true;
    } catch (persistenceError) {
      this.#logConversationFailure(
        "terminal_message_submit_aborted_persist_failed",
        abortedConversation.conversation_id,
        persistenceError
      );
    }
    const safeToRetry = durableAbortCanBeRetryable && abortedStatePersisted;
    const reportedConversation = safeToRetry
      ? abortedConversation
      : this.#ports.withSubmission({
          conversation: abortedConversation,
          ...this.#submissionIdentity(),
          status: "aborted",
          abortedAt,
          error: errorMessage,
          safeToRetry: false
        });
    try {
      this.#ports.appendEvent({
        ts: abortedAt,
        conversation_id: abortedConversation.conversation_id,
        event: "terminal_message_submit_aborted",
        message_id: this.#context.message.id,
        executor: this.#context.executor,
        terminal_control: this.#context.terminalControl,
        error: textSummary(errorMessage),
        safe_to_retry: safeToRetry,
        ...(transportFailure
          ? { terminal_input_started: false }
          : {})
      });
    } catch (persistenceError) {
      this.#logConversationFailure(
        "terminal_message_submit_aborted_event_failed",
        abortedConversation.conversation_id,
        persistenceError
      );
    }
    this.#ports.log("error", "terminal_message_submit_aborted", {
      conversation_id: abortedConversation.conversation_id,
      terminal_target: this.#context.terminalControl.target,
      error: errorMessage,
      safe_to_retry: safeToRetry,
      ...(transportFailure
        ? { terminal_input_started: false }
        : {}),
      dispatch_ledger_restored: dispatchLedgerRestored,
      aborted_state_persisted: abortedStatePersisted,
      raw_attach_rolled_back: rawAttachRolledBack
    });
    const failureKind = !dispatchLedgerRestored
      ? "ledger"
      : !rawAttachRolledBack
        ? "rollback"
        : "state";
    this.#ports.print({
      session_id: sessionIdForConversation(
        transportFailure
          ? reportedConversation
          : abortedConversation
      ),
      turn_id: turnIdForConversation(
        transportFailure
          ? reportedConversation
          : abortedConversation
      ),
      conversation: reportedConversation,
      message: this.#context.message,
      delivered: false,
      status: "submission_aborted",
      submission_outcome: "aborted",
      background: true,
      callback_expected: false,
      terminal_control: this.#context.terminalControl,
      monitor_pid: this.#monitor?.pid ?? null,
      executor: this.#context.executor,
      safe_to_retry: safeToRetry,
      do_not_retry: !safeToRetry,
      reason: safeToRetry
        ? transportFailure
          ? "AKK proved that terminal input never started; this submission may be retried."
          : "AKK failed before terminal input; this terminal submission was not sent and may be retried."
        : transportFailure
          ? "AKK proved terminal input never started but could not make every abort receipt and Session rollback durable; inspect before retrying."
          : failureKind === "ledger"
            ? "AKK failed before terminal input but could not restore the terminal dispatch ledger; inspect and close the conversation before retrying."
            : failureKind === "rollback"
              ? "AKK failed before terminal input but could not detach the provisional raw-attach Session; inspect its exact binding before retrying."
              : "AKK failed before terminal input but could not persist the aborted receipt; inspect the conversation before retrying.",
      openclaw_next_action: {
        action: safeToRetry ? "retry" : "inspect",
        conversation_id: abortedConversation.conversation_id,
        session_id: sessionIdForConversation(reportedConversation),
        turn_id: turnIdForConversation(reportedConversation),
        safe_to_retry: safeToRetry,
        do_not_retry: !safeToRetry,
        reason: safeToRetry
          ? transportFailure
            ? "The terminal transport failed before any input operation succeeded."
            : "The failure occurred before any terminal input."
          : transportFailure
            ? "The pre-input failure could not be fully reconciled in durable state."
            : failureKind === "ledger"
              ? "The terminal ledger could not be restored automatically."
              : failureKind === "rollback"
                ? "The provisional raw-attach Session could not be detached automatically."
                : "The aborted receipt could not be made durable."
      }
    });
  }

  #recordUncertain(error: unknown): void {
    const uncertainAt = this.#ports.nowIso();
    const errorMessage = errorText(error);
    if (this.#context.deferredTransferId) {
      try {
        this.#ports.markDeferredUncertain(errorMessage);
      } catch (transferError) {
        this.#ports.log(
          "error",
          "deferred_codex_foreground_uncertain_persist_failed",
          {
            transfer_id: this.#context.deferredTransferId,
            error: errorText(transferError)
          }
        );
      }
    }
    const stalledFailureBase = {
      ...this.#progress.stagedConversation,
      status: "stalled" as const,
      stalled_at: uncertainAt,
      stalled_reason:
        "terminal submission outcome is uncertain; inspect the shared terminal pane before continuing",
      updated_at: uncertainAt
    };
    const uncertainConversation = this.#ports.withSubmission({
      conversation: stalledFailureBase,
      ...this.#submissionIdentity(),
      status: "uncertain",
      textInjectedAt: this.#progress.textInjectedAt,
      enterDispatchedAt: this.#progress.enterDispatchedAt,
      uncertainAt,
      error: errorMessage,
      lastProvenStage: this.#progress.enterDispatchedAt
        ? "enter_dispatched"
        : this.#progress.textInjectedAt
          ? "text_injected"
          : "prepared"
    });
    try {
      this.#ports.saveLedger(this.#ledgerFor(
        uncertainConversation,
        "uncertain",
        {
          text_injected_at: this.#progress.textInjectedAt,
          enter_dispatched_at: this.#progress.enterDispatchedAt,
          uncertain_at: uncertainAt,
          error: textSummary(errorMessage)
        }
      ));
      this.#ports.saveState(uncertainConversation);
      this.#ports.appendEvent({
        ts: uncertainAt,
        conversation_id: uncertainConversation.conversation_id,
        event: "terminal_message_submit_uncertain",
        message_id: this.#context.message.id,
        executor: this.#context.executor,
        terminal_control: this.#context.terminalControl,
        error: textSummary(errorMessage),
        do_not_retry: true
      });
    } catch (persistenceError) {
      this.#logConversationFailure(
        "terminal_message_submit_uncertain_persist_failed",
        uncertainConversation.conversation_id,
        persistenceError
      );
    }
    const stalledConversationIds =
      this.#ports.stallOtherConversations();
    this.#ports.log("error", "terminal_message_submit_uncertain", {
      conversation_id: uncertainConversation.conversation_id,
      agent: this.#context.executor.kind,
      terminal_target: this.#context.terminalControl.target,
      error: errorMessage,
      do_not_retry: true,
      stalled_conversation_ids: stalledConversationIds
    });
    this.#ports.print({
      session_id: sessionIdForConversation(uncertainConversation),
      turn_id: turnIdForConversation(uncertainConversation),
      conversation: uncertainConversation,
      message: this.#context.message,
      delivered: false,
      status: "submission_uncertain",
      submission_outcome: "uncertain",
      background: true,
      callback_expected: Boolean(uncertainConversation.gateway_method),
      terminal_control: this.#context.terminalControl,
      monitor_pid: this.#monitor?.pid ?? null,
      executor: this.#context.executor,
      do_not_retry: true,
      stalled_conversation_ids: stalledConversationIds,
      reason: this.#progress.enterDispatchedAt
        ? "AKK dispatched Enter but native acceptance or its exact identity became uncertain. Do not retry automatically; inspect this conversation and pane."
        : this.#progress.textInjectedAt
          ? "AKK injected text but could not prove that Enter was dispatched. Do not retry automatically; inspect this conversation and pane."
          : "AKK could not prove that terminal input remained untouched. Inspect this conversation before retrying.",
      openclaw_next_action: {
        action: "inspect",
        conversation_id: uncertainConversation.conversation_id,
        session_id: sessionIdForConversation(uncertainConversation),
        turn_id: turnIdForConversation(uncertainConversation),
        do_not_retry: true,
        reason:
          "The terminal submission outcome is uncertain. Inspect AKK status and the shared terminal pane before deciding whether to close or continue."
      }
    });
  }

  #recordPostTransportBookkeepingFailure(
    phase: string,
    error: unknown
  ): void {
    const message = errorText(error);
    this.#bookkeepingWarning ??= message;
    this.#ports.log(
      "warn",
      "terminal_message_post_transport_bookkeeping_failed",
      {
        conversation_id: this.#progress.stagedConversation.conversation_id,
        terminal_target: this.#context.terminalControl.target,
        phase,
        error: message
      }
    );
  }

  #logConversationFailure(
    event: string,
    conversationId: string,
    error: unknown
  ): void {
    this.#ports.log("error", event, {
      conversation_id: conversationId,
      terminal_target: this.#context.terminalControl.target,
      error: errorText(error)
    });
  }

  #persistBeforeInput(action: () => void, reason: string): void {
    try {
      action();
    } catch (error) {
      try {
        if (!this.#ports.abortDeferredPreInput()) {
          this.#restorePreviousLedger(reason);
        }
      } finally {
        this.#ports.rollbackRawAttach();
      }
      throw error;
    }
  }

  #restorePreviousLedger(reason: string): void {
    this.#ports.saveLedger(this.#context.previousDispatchLedger ?? {
      status: "resolved",
      resolved_at: this.#ports.nowIso(),
      reason
    });
  }

  #submissionIdentity(): Omit<
    TerminalBridgeSubmissionMutation,
    "conversation" | "status"
  > {
    return {
      messageId: this.#context.message.id,
      messageType: this.#context.message.type,
      messageBody: this.#context.message.body,
      requestText: this.#context.terminalPayload,
      preparedAt: this.#context.bridgeStartedAt
    };
  }

  #ledgerFor(
    conversation: Conversation,
    status: TerminalBridgeSubmissionStatus,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      ...this.#ports.ledgerFields(conversation),
      status,
      generation_id: this.#context.message.id,
      conversation_id: conversation.conversation_id,
      session_id: sessionIdForConversation(conversation),
      turn_id: turnIdForConversation(conversation),
      message_id: this.#context.message.id,
      message_type: this.#context.message.type,
      request_hash: this.#context.terminalRequestHash,
      prepared_at: this.#context.bridgeStartedAt,
      dispatcher_pid: this.#context.dispatcherPid,
      state_path: this.#context.statePath,
      event_log_path: this.#context.logPath,
      callback_expected: Boolean(conversation.gateway_method),
      previous_generation_id:
        stringValue(this.#context.previousDispatchLedger?.generation_id) ??
        stringValue(this.#context.previousDispatchLedger?.message_id),
      ...Object.fromEntries(
        Object.entries(overrides).filter(([, entry]) => entry !== undefined)
      )
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textSummary(
  text: unknown,
  maxLength = 240
): { length: number; preview?: string } {
  const value = String(text ?? "");
  return {
    length: value.length,
    preview: value ? value.slice(0, maxLength) : undefined
  };
}
