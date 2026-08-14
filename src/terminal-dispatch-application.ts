import {
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation,
  type Executor
} from "./protocol.js";
import type { EventRecord } from "./store.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  reduceTerminalZeroInputAbort,
  type TerminalZeroInputAbortOutcome,
  type TerminalZeroInputFailureKind
} from "./terminal-dispatch-abort.js";
import {
  constructTerminalOrdinaryDispatchLedger,
  type TerminalDispatchLedgerDocument,
  type TerminalOrdinaryDispatchPhaseFields,
  type TerminalOrdinaryDispatchPostCallbackFields,
  type TerminalOrdinaryDispatchStatus
} from "./terminal-dispatch-ledger-codec.js";
import {
  applyTerminalBridgeSubmission,
  terminalDispatchTextSummary as textSummary,
  type TerminalBridgeSubmissionMutation
} from "./terminal-dispatch-receipt.js";
import type { TerminalSubmissionAcceptanceEvidence } from
  "./terminal-submission-acceptance.js";
import { isRecord, nonBlankString } from "./value-guards.js";


export interface TerminalDispatchMessage {
  id: string;
  type: "task" | "answer";
  body: string;
}

export type TerminalDispatchAcceptance =
  | {
      outcome: "agent_accepted";
      evidence: TerminalSubmissionAcceptanceEvidence;
    }
  | { outcome: "pending_acceptance" }
  | { outcome: "not_accepted"; reason: string }
  | { outcome: "uncertain"; reason: string };

export interface TerminalDispatchApplicationContext {
  originalConversation: Conversation;
  preparedConversation: Conversation;
  message: TerminalDispatchMessage;
  executor: Executor;
  terminalControl: TerminalControlRef;
  receiptTerminalControl: TerminalControlRef | undefined;
  requestText: string;
  requestHash: string;
  preparedAt: string;
  statePath: string;
  eventLogPath: string;
  previousGenerationId?: string;
  dispatcherPid: number;
  storeDir?: string;
  recordMessageAfterSend: boolean;
  recordRawAttachmentAfterSend: boolean;
  ledgerBindingFields(
    conversation: Conversation
  ): TerminalDispatchLedgerDocument;
}

export interface TerminalDispatchApplicationPorts {
  synchronizeStageProgress(
    conversation: Conversation,
    stage: "text_injected" | "enter_dispatched",
    at: string
  ): void;
  state: {
    save(conversation: Conversation): void;
  };
  ledger: {
    save(
      ledger: TerminalDispatchLedgerDocument,
      phase?: "ordinary" | "final"
    ): void;
    restore(reason: string, terminalInputNotStartedAt?: string): void;
  };
  audit: {
    append(event: EventRecord): void;
    log(
      level: "info" | "warn" | "error",
      event: string,
      fields: { [key: string]: unknown }
    ): void;
    recordBookkeepingFailure(phase: string, error: unknown): void;
    recordPersistenceFailure(
      phase: string,
      error: unknown,
      conversation: Conversation
    ): void;
  };
  rollbackBeforeInput(): boolean;
}

export interface RecordedTerminalZeroInputAbort {
  outcome: TerminalZeroInputAbortOutcome;
  reportedConversation: Conversation;
  receiptConversation: Conversation;
  errorMessage: string;
  dispatchLedgerRestored: boolean;
  abortedStatePersisted: boolean;
  rawAttachRolledBack: boolean;
}

type TerminalSubmissionProgressFields = Pick<
  TerminalBridgeSubmissionMutation,
  | "textInjectedAt"
  | "enterDispatchedAt"
  | "agentAcceptedAt"
  | "notAcceptedAt"
  | "submittedAt"
  | "uncertainAt"
  | "abortedAt"
  | "error"
  | "acceptanceEvidence"
  | "lastProvenStage"
  | "safeToRetry"
>;

interface TerminalDispatchStageRecords {
  state: Conversation;
  ledger: TerminalDispatchLedgerDocument;
  event: EventRecord;
}

/**
 * Orders already-authorized ordinary dispatch writes. Locks, terminal I/O,
 * acceptance observation, raw persistence adapters, and presentation stay in
 * the composition root.
 */
export class TerminalDispatchApplication {
  readonly #context: TerminalDispatchApplicationContext;
  readonly #ports: TerminalDispatchApplicationPorts;
  #stagedConversation: Conversation;
  #textInjectedAt: string | undefined;
  #enterDispatchedAt: string | undefined;

  constructor(
    context: TerminalDispatchApplicationContext,
    ports: TerminalDispatchApplicationPorts
  ) {
    this.#context = context;
    this.#ports = ports;
    this.#stagedConversation = context.preparedConversation;
  }

  persistPrepared(): void {
    const ledger = this.#ledgerFor(
      this.#context.preparedConversation,
      "prepared"
    );
    this.#persistBeforeInput(
      () => this.#ports.ledger.save(ledger),
      "prepared ledger persistence failed before terminal input"
    );
    this.#persistBeforeInput(
      () => this.#ports.state.save(this.#context.preparedConversation),
      "prepared state persistence failed before terminal input"
    );
  }

  recordPreparedBookkeeping(
    messageEvent: EventRecord | undefined,
    injectFailure = false
  ): void {
    if (injectFailure) {
      throw new Error("injected terminal setup failure before terminal input");
    }
    const { originalConversation: conversation } = this.#context;
    if (this.#context.recordRawAttachmentAfterSend) {
      const takeover = isRecord(conversation.native_session_takeover)
        ? conversation.native_session_takeover
        : undefined;
      const sourceConversationId = nonBlankString(
        takeover?.native_session_id
      );
      this.#ports.audit.append({
        ts: this.#context.preparedAt,
        conversation_id: conversation.conversation_id,
        event: "raw_terminal_session_attached",
        source_conversation_id: sourceConversationId,
        agent: this.#context.executor.kind,
        terminal_control: this.#context.terminalControl,
        executor: this.#context.executor
      });
      this.#ports.audit.log("info", "raw_terminal_session_attached", {
        conversation_id: conversation.conversation_id,
        source_conversation_id: sourceConversationId,
        terminal_target: this.#context.terminalControl.target,
        state_path: this.#context.statePath,
        event_log_path: this.#context.eventLogPath
      });
    }
    if (this.#context.recordMessageAfterSend && messageEvent) {
      this.#ports.audit.append(messageEvent);
      this.#ports.audit.log("info", "message_created", {
        conversation_id: conversation.conversation_id,
        agent: this.#context.executor.kind,
        executor_session: this.#context.executor.session,
        message_type: this.#context.message.type,
        state_path: this.#context.statePath,
        event_log_path: this.#context.eventLogPath,
        message: textSummary(this.#context.message.body)
      });
    }
    this.#ports.audit.append(this.#event(
      this.#context.preparedAt,
      "terminal_message_submit_prepared",
      {
        request_hash: this.#context.requestHash,
        dispatcher_pid: this.#context.dispatcherPid
      }
    ));
  }

  async recordTransportStage(
    stage: "text_injected" | "enter_dispatched",
    at: string,
    afterDurable: () => Promise<void> | void
  ): Promise<void> {
    if (stage === "text_injected") {
      this.#textInjectedAt = at;
    } else {
      this.#enterDispatchedAt = at;
    }
    this.#stagedConversation = this.#withSubmission(
      this.#stagedConversation,
      stage,
      this.#progressFields()
    );
    this.#ports.synchronizeStageProgress(this.#stagedConversation, stage, at);
    const ledger = this.#ledgerFor(
      this.#stagedConversation,
      stage,
      this.#phaseFields()
    );
    this.#ports.state.save(this.#stagedConversation);
    this.#ports.ledger.save(ledger);
    await afterDurable();
    try {
      this.#ports.audit.append(this.#event(
        at,
        `terminal_message_${stage}`,
        { request_hash: this.#context.requestHash }
      ));
    } catch (error) {
      this.#ports.audit.recordBookkeepingFailure(stage, error);
    }
  }

  applyIdentityFailure(
    at: string,
    reason: string,
    beforePersist?: (conversation: Conversation) => void
  ): Conversation {
    const takeover = isRecord(this.#stagedConversation.native_session_takeover)
      ? this.#stagedConversation.native_session_takeover
      : {};
    const failureBase: Conversation = {
      ...this.#stagedConversation,
      status: "stalled",
      stalled_at: at,
      stalled_reason: reason,
      native_session_takeover: {
        ...takeover,
        terminal_agent_identity_status: "unresolved_after_submit",
        terminal_agent_identity_error: textSummary(reason)
      },
      updated_at: at
    };
    const uncertain = this.#withSubmission(failureBase, "uncertain", {
      ...this.#progressFields(),
      uncertainAt: at,
      error: reason,
      lastProvenStage: "enter_dispatched"
    });
    beforePersist?.(uncertain);
    this.#persistLedgerFirst({
      state: uncertain,
      ledger: this.#ledgerFor(
        uncertain,
        "uncertain",
        { ...this.#phaseFields(), uncertain_at: at },
        undefined,
        {
          native_identity_status: "unresolved_after_submit",
          error: textSummary(reason)
        },
        false
      ),
      event: this.#event(at, "terminal_agent_identity_binding_failed", {
        error: textSummary(reason),
        delivered: false,
        do_not_retry: true
      })
    });
    this.#ports.audit.log(
      "error",
      "terminal_agent_identity_binding_failed",
      {
        conversation_id: uncertain.conversation_id,
        agent: this.#context.executor.kind,
        terminal_target: this.#context.terminalControl.target,
        error: reason,
        delivered: false,
        do_not_retry: true
      }
    );
    return uncertain;
  }

  applyAcceptance(
    submittedBase: Conversation,
    acceptance: TerminalDispatchAcceptance,
    resolvedAt: string
  ): {
    conversation: Conversation;
    status: TerminalOrdinaryDispatchStatus;
  } {
    const status = acceptance.outcome === "pending_acceptance"
      ? "enter_dispatched"
      : acceptance.outcome;
    const failed = acceptance.outcome === "not_accepted" ||
      acceptance.outcome === "uncertain";
    const base: Conversation = failed
      ? {
          ...submittedBase,
          status: "stalled",
          stalled_at: resolvedAt,
          stalled_reason: acceptance.reason,
          updated_at: resolvedAt
        }
      : submittedBase;
    const receiptFields: Partial<TerminalSubmissionProgressFields> = {
      ...this.#progressFields(),
      ...(acceptance.outcome === "agent_accepted"
        ? {
            agentAcceptedAt: resolvedAt,
            acceptanceEvidence: acceptance.evidence
          }
        : acceptance.outcome === "not_accepted"
          ? { notAcceptedAt: resolvedAt }
          : acceptance.outcome === "uncertain"
            ? {
                uncertainAt: resolvedAt,
                error: acceptance.reason,
                lastProvenStage: "enter_dispatched"
              }
            : {})
    };
    const phaseFields: TerminalOrdinaryDispatchPhaseFields = {
      ...this.#phaseFields(),
      ...(acceptance.outcome === "agent_accepted"
        ? {
            agent_accepted_at: resolvedAt,
            acceptance_evidence: acceptance.evidence
          }
        : acceptance.outcome === "not_accepted"
          ? { not_accepted_at: resolvedAt }
          : acceptance.outcome === "uncertain"
            ? {
                uncertain_at: resolvedAt,
                error: textSummary(acceptance.reason)
              }
            : {})
    };
    const conversation = this.#withSubmission(base, status, receiptFields);
    const ledger = this.#ledgerFor(conversation, status, phaseFields, null);
    this.#ports.state.save(conversation);
    try {
      this.#ports.ledger.save(ledger, "final");
    } catch (error) {
      this.#ports.audit.recordBookkeepingFailure(
        "final_terminal_ledger",
        error
      );
    }
    try {
      this.#ports.audit.append(this.#event(
        resolvedAt,
        acceptance.outcome === "agent_accepted"
          ? "terminal_message_agent_accepted"
          : acceptance.outcome === "pending_acceptance"
            ? "terminal_message_acceptance_pending"
            : `terminal_message_${acceptance.outcome}`,
        {
          delivery_receipt: status,
          do_not_retry: acceptance.outcome !== "agent_accepted"
        }
      ));
    } catch (error) {
      this.#ports.audit.recordBookkeepingFailure(status, error);
    }
    return { conversation, status };
  }

  applyUncertain(at: string, error: unknown): Conversation {
    const errorMessage = errorText(error);
    const stalled: Conversation = {
      ...this.#stagedConversation,
      status: "stalled",
      stalled_at: at,
      stalled_reason:
        "terminal submission outcome is uncertain; inspect the shared terminal pane before continuing",
      updated_at: at
    };
    const uncertain = this.#withSubmission(stalled, "uncertain", {
      ...this.#progressFields(),
      uncertainAt: at,
      error: errorMessage,
      lastProvenStage: this.#enterDispatchedAt
        ? "enter_dispatched"
        : this.#textInjectedAt
          ? "text_injected"
          : "prepared"
    });
    this.#persistLedgerFirst({
      state: uncertain,
      ledger: this.#ledgerFor(uncertain, "uncertain", {
        ...this.#phaseFields(),
        uncertain_at: at
      }, undefined, { error: textSummary(errorMessage) }),
      event: this.#event(at, "terminal_message_submit_uncertain", {
        error: textSummary(errorMessage),
        do_not_retry: true
      })
    }, "terminal_message_submit_uncertain_persist_failed");
    return uncertain;
  }

  recordZeroInputAbort({
    failureKind,
    error,
    abortedAt,
    injectStatePersistenceFailure = false
  }: {
    failureKind: TerminalZeroInputFailureKind;
    error: unknown;
    abortedAt: string;
    injectStatePersistenceFailure?: boolean;
  }): RecordedTerminalZeroInputAbort {
    const transportFailure = failureKind === "transport";
    const errorMessage = errorText(error);
    let dispatchLedgerRestored = false;
    try {
      this.#ports.ledger.restore(
        transportFailure
          ? "terminal transport was proved not to have started"
          : "terminal submission aborted before terminal input",
        transportFailure ? abortedAt : undefined
      );
      dispatchLedgerRestored = true;
    } catch (restoreError) {
      this.#ports.audit.recordPersistenceFailure(
        "terminal_dispatch_ledger_restore_failed",
        restoreError,
        this.#context.originalConversation
      );
    }
    const rawAttachRolledBack = this.#ports.rollbackBeforeInput();
    const prepared = this.#context.preparedConversation;
    const base: Conversation = this.#context.recordRawAttachmentAfterSend
      ? {
          ...prepared,
          status: "failed",
          failed_at: abortedAt,
          failure_reason: transportFailure
            ? "terminal transport failed before terminal input"
            : "terminal submission setup failed before terminal input"
        }
      : {
          ...prepared,
          status: this.#context.originalConversation.status,
          ...(this.#context.originalConversation.idle_since
            ? { idle_since: this.#context.originalConversation.idle_since }
            : {})
        };
    const aborted = this.#withSubmission(base, "aborted", {
      abortedAt,
      error: errorMessage,
      safeToRetry: dispatchLedgerRestored && rawAttachRolledBack
    });
    let abortedStatePersisted = false;
    try {
      if (injectStatePersistenceFailure && !transportFailure) {
        throw new Error(
          "injected aborted submission state persistence failure"
        );
      }
      this.#ports.state.save(aborted);
      abortedStatePersisted = true;
    } catch (persistenceError) {
      this.#ports.audit.recordPersistenceFailure(
        "terminal_message_submit_aborted_persist_failed",
        persistenceError,
        aborted
      );
    }
    const outcome = reduceTerminalZeroInputAbort({
      failureKind,
      dispatchLedgerRestored,
      rawAttachRolledBack,
      abortedStatePersisted
    });
    const reportConversation = (): Conversation => outcome.safeToRetry
      ? aborted
      : this.#withSubmission(aborted, "aborted", {
          abortedAt,
          error: errorMessage,
          safeToRetry: false
        });
    let reported = transportFailure ? reportConversation() : undefined;
    try {
      this.#ports.audit.append({
        ...this.#event(abortedAt, "terminal_message_submit_aborted", {
          error: textSummary(errorMessage),
          safe_to_retry: outcome.safeToRetry
        }),
        ...(transportFailure ? { terminal_input_started: false } : {})
      });
    } catch (eventError) {
      this.#ports.audit.recordPersistenceFailure(
        "terminal_message_submit_aborted_event_failed",
        eventError,
        aborted
      );
    }
    reported ??= reportConversation();
    this.#ports.audit.log("error", "terminal_message_submit_aborted", {
      conversation_id: this.#context.originalConversation.conversation_id,
      terminal_target: this.#context.terminalControl.target,
      error: errorMessage,
      safe_to_retry: outcome.safeToRetry,
      ...(transportFailure ? { terminal_input_started: false } : {}),
      dispatch_ledger_restored: dispatchLedgerRestored,
      aborted_state_persisted: abortedStatePersisted,
      raw_attach_rolled_back: rawAttachRolledBack
    });
    return {
      outcome,
      reportedConversation: reported,
      receiptConversation: transportFailure ? reported : aborted,
      errorMessage,
      dispatchLedgerRestored,
      abortedStatePersisted,
      rawAttachRolledBack
    };
  }

  recordPostSubmissionBookkeeping(
    conversation: Conversation,
    delivered: boolean,
    nowIso: () => string
  ): string | undefined {
    const message = textSummary(this.#context.message.body);
    const payload = textSummary(this.#context.requestText);
    try {
      this.#ports.audit.append({
        ts: nowIso(),
        conversation_id: this.#context.originalConversation.conversation_id,
        event: "terminal_message_send",
        executor: this.#context.executor,
        terminal_control: this.#context.terminalControl,
        message,
        payload
      });
      this.#ports.audit.log("info", "terminal_message_send", {
        conversation_id: this.#context.originalConversation.conversation_id,
        agent: this.#context.executor.kind,
        terminal_target: this.#context.terminalControl.target,
        message,
        payload
      });
      return undefined;
    } catch (error) {
      const warning = errorText(error);
      this.#ports.audit.log(
        "warn",
        "terminal_message_post_submit_bookkeeping_failed",
        {
          conversation_id: conversation.conversation_id,
          terminal_target: this.#context.terminalControl.target,
          error: warning,
          delivered
        }
      );
      try {
        this.#ports.audit.append({
          ts: nowIso(),
          conversation_id: conversation.conversation_id,
          event: "terminal_message_post_submit_bookkeeping_failed",
          terminal_control: this.#context.terminalControl,
          error: textSummary(warning),
          delivered
        });
      } catch {
        // The durable receipt remains authoritative when the event log fails.
      }
      return warning;
    }
  }

  #withSubmission(
    conversation: Conversation,
    status: TerminalOrdinaryDispatchStatus,
    fields: Partial<TerminalSubmissionProgressFields> = {}
  ): Conversation {
    return applyTerminalBridgeSubmission({
      conversation,
      messageId: this.#context.message.id,
      messageType: this.#context.message.type,
      messageBody: this.#context.message.body,
      requestText: this.#context.requestText,
      status,
      preparedAt: this.#context.preparedAt,
      ...fields
    }, {
      dispatcherPid: this.#context.dispatcherPid,
      storeDir: this.#context.storeDir,
      terminalControl: this.#context.receiptTerminalControl
    });
  }

  #ledgerFor(
    conversation: Conversation,
    status: TerminalOrdinaryDispatchStatus,
    phaseFields: TerminalOrdinaryDispatchPhaseFields = {},
    dispatcherPid: number | null = this.#context.dispatcherPid,
    postCallbackFields: TerminalOrdinaryDispatchPostCallbackFields = {},
    callbackExpected = Boolean(conversation.gateway_method)
  ): TerminalDispatchLedgerDocument {
    return constructTerminalOrdinaryDispatchLedger({
      bindingFields: this.#context.ledgerBindingFields(conversation),
      identityFields: {
        status,
        generation_id: this.#context.message.id,
        conversation_id: conversation.conversation_id,
        session_id: sessionIdForConversation(conversation),
        turn_id: turnIdForConversation(conversation),
        message_id: this.#context.message.id,
        message_type: this.#context.message.type,
        request_hash: this.#context.requestHash,
        prepared_at: this.#context.preparedAt
      },
      phaseFields,
      dispatcherPid,
      statePath: this.#context.statePath,
      eventLogPath: this.#context.eventLogPath,
      callbackExpected,
      postCallbackFields,
      previousGenerationId: this.#context.previousGenerationId
    });
  }

  #event(
    at: string,
    event: string,
    fields: { [key: string]: unknown } = {}
  ): EventRecord {
    return {
      ts: at,
      conversation_id: this.#stagedConversation.conversation_id,
      event,
      message_id: this.#context.message.id,
      executor: this.#context.executor,
      terminal_control: this.#context.terminalControl,
      ...fields
    };
  }

  #phaseFields(): TerminalOrdinaryDispatchPhaseFields {
    return {
      ...(this.#textInjectedAt
        ? { text_injected_at: this.#textInjectedAt }
        : {}),
      ...(this.#enterDispatchedAt
        ? { enter_dispatched_at: this.#enterDispatchedAt }
        : {})
    };
  }

  #progressFields(): TerminalSubmissionProgressFields {
    return {
      textInjectedAt: this.#textInjectedAt,
      enterDispatchedAt: this.#enterDispatchedAt
    };
  }

  #persistBeforeInput(action: () => void, reason: string): void {
    try {
      action();
    } catch (error) {
      try {
        this.#ports.ledger.restore(reason);
      } finally {
        this.#ports.rollbackBeforeInput();
      }
      throw error;
    }
  }

  #persistLedgerFirst(
    records: TerminalDispatchStageRecords,
    failurePhase?: string
  ): void {
    try {
      this.#ports.ledger.save(records.ledger);
      this.#ports.state.save(records.state);
      this.#ports.audit.append(records.event);
    } catch (error) {
      if (!failurePhase) {
        throw error;
      }
      this.#ports.audit.recordPersistenceFailure(
        failurePhase,
        error,
        records.state
      );
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
