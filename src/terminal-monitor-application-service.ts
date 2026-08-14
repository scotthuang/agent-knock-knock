import {
  executorForConversation,
  type Conversation,
  type ConversationStatus,
  type Executor
} from "./protocol.js";
import type {
  TerminalCompletionEvidence,
  TerminalControlRef
} from "./terminal-agent-adapter.js";
import type {
  TerminalBridgeStatus,
  TerminalMonitorPoll
} from "./terminal-agent-bridge.js";
import {
  terminalBridgeCompletionFingerprint,
  type CallbackExecutionResult,
  type PreparedCallback
} from "./callback-outbox-service.js";
import {
  claudeTranscriptApprovalIdentity,
  decideTerminalMonitorAfterEffectsTimeout,
  decideTerminalMonitorApproval,
  reduceTerminalMonitorDecision,
  terminalMonitorActivityFingerprint,
  terminalMonitorApprovalEffectOrder,
  terminalMonitorApprovalFingerprint,
  terminalMonitorScreenFingerprint,
  validTerminalMonitorTimestampMs,
  type TerminalMonitorNextAction
} from "./terminal-monitor-decision-policy.js";
import type { TerminalMonitorPollState } from
  "./terminal-monitor-poll-policy.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

type JsonRecord = Record<string, unknown>;

export interface TerminalMonitorConfiguration {
  pollIntervalMs: number;
  timeoutMinutes: number;
  hardTimeoutMinutes: number;
  activityPersistIntervalMs: number;
}

export type TerminalMonitorPresentation =
  | {
      kind:
        | "generation_replaced"
        | "conversation_no_longer_waiting"
        | "task_replaced"
        | "submission_status_invalid";
      conversation: Conversation;
    }
  | {
      kind: "stalled";
      conversation: Conversation;
      reason?: string;
      hardTimeout?: boolean;
    }
  | {
      kind: "submission_uncertain";
      conversation: Conversation;
      deliveryReceipt?: "text_injected" | "enter_dispatched";
      reason: string;
    }
  | {
      kind: "submission_not_accepted";
      conversation: Conversation;
    }
  | {
      kind: "submission_terminal";
      conversation: Conversation;
      status: string;
      safeToRetry: boolean;
    }
  | {
      kind: "submission_unproven";
      conversation: Conversation;
      status: string;
    }
  | {
      kind: "dispatch_fenced";
      conversation: Conversation;
      ledgerStatus?: string;
    }
  | {
      kind: "approval_duplicate";
      conversation: Conversation;
      terminalControl: TerminalControlRef;
      terminalStatus: TerminalBridgeStatus;
      approvable: boolean;
      reason?: string;
    }
  | {
      kind: "approval_gateway_missing";
      conversation: Conversation;
      callbackMessage?: unknown;
      terminalControl: TerminalControlRef;
      terminalStatus: TerminalBridgeStatus;
      approvable: boolean;
    }
  | {
      kind: "completion_duplicate";
      conversation: Conversation;
      reason: string;
    }
  | {
      kind: "binding_superseded";
      conversation: Conversation;
      detail: string;
    };

export type MonitorSubmissionReconciliation =
  | { outcome: "accepted"; conversation: Conversation }
  | { outcome: "pending" }
  | { outcome: "not_accepted"; conversation: Conversation };

export interface MonitorPollObservation {
  kind: "observed";
  poll: TerminalMonitorPoll;
}

export type MonitorPollResult =
  | MonitorPollObservation
  | { kind: "retry"; conversation: Conversation }
  | { kind: "fenced"; ledgerStatus?: string };

export interface MonitorApprovalCallbackRecord {
  callbackMessage?: unknown;
  prepared?: PreparedCallback;
}

export interface MonitorApprovalNotificationResult {
  conversation: Conversation;
  duplicate: boolean;
  stale: boolean;
  recorded?: MonitorApprovalCallbackRecord;
}

export type MonitorCompletionPreparation =
  | {
      claimed: true;
      conversation: Conversation;
      prepared: PreparedCallback;
    }
  | {
      claimed: false;
      conversation: Conversation;
      reason: string;
    };

export interface MonitorVerifiedDeadResult {
  stalled: boolean;
  reason?: string;
  conversation: Conversation;
  completionPreparation?: MonitorCompletionPreparation;
}

export interface TerminalMonitorServicePorts {
  state: {
    load(): Conversation;
    appendEvent(event: { event: string; [key: string]: unknown }): void;
    markStalled(reason: string, detail: JsonRecord): Conversation;
    persistActivity(input: {
      conversation: Conversation;
      observedAtMs: number;
      reason: string;
      activityState: string;
      timeoutMinutes: number;
      hardTimeoutMinutes: number;
    }): Conversation;
    persistDetectorDiagnostic(input: {
      expectedConversationId: string;
      expectedMessageId?: string;
      limitation?: string;
      fingerprint?: string;
    }): {
      conversation: Conversation;
      diagnostic?: JsonRecord;
    };
    markApprovalPromptCleared(input: {
      expectedConversationId: string;
      expectedMessageId?: string;
    }): { conversation: Conversation; marked: boolean };
    recordApprovalNotification(input: {
      conversation: Conversation;
      executor: Executor;
      terminalControl: TerminalControlRef;
      terminalStatus: TerminalBridgeStatus;
      currentMessageId?: string;
      fingerprint?: string;
      kind: "question" | "error";
      reason?: string;
    }): MonitorApprovalNotificationResult;
  };
  authority: {
    initialize(): void;
    terminalControl(conversation: Conversation): TerminalControlRef | undefined;
    submission(conversation: Conversation): JsonRecord | undefined;
    isWaitingForAgent(status: ConversationStatus): boolean;
    isProcessAlive(pid: number): boolean;
    markAcceptanceUncertain(input: {
      conversation: Conversation;
      terminalControl: TerminalControlRef;
      reason: string;
    }): Conversation;
    reconcileAcceptance(input: {
      conversation: Conversation;
      terminalControl: TerminalControlRef;
      executor: Executor;
      apply(
        reconciliation: MonitorSubmissionReconciliation
      ): "continue" | "finished" | "pending";
      recover(error: unknown): "continue" | "finished";
    }): Promise<"continue" | "finished" | "pending">;
    recoverPreparedSubmission(input: {
      conversation: Conversation;
      terminalControl: TerminalControlRef;
      currentMessageId: string;
      dispatcherPid: number;
    }): Promise<Conversation>;
    assertBindingCurrent(conversation: Conversation): void;
    bindingSuperseded(error: unknown):
      | { code: string; message: string }
      | undefined;
    storeOperationTimeout(error: unknown):
      | { code: string; lockKind: string }
      | undefined;
    storeLeaseTimeout(error: unknown):
      | { code: string; lockKind: string }
      | undefined;
    poll(input: {
      conversation: Conversation;
      terminalControl: TerminalControlRef;
      currentMessageId?: string;
      executor: Executor;
      screenChangedSinceSend: boolean;
      onFenced(ledgerStatus?: string): void;
    }): Promise<MonitorPollResult>;
  };
  callbacks: {
    prepareCompletion(input: {
      conversation: Conversation;
      executor: Executor;
      terminalControl: TerminalControlRef;
      terminalMessageId: string;
      completion: TerminalCompletionEvidence;
      completionFingerprint: string;
    }): MonitorCompletionPreparation;
    verifiedDead(input: {
      conversationId: string;
      messageId?: string;
    }): Promise<MonitorVerifiedDeadResult>;
    run(
      prepared: PreparedCallback,
      options?: { emit?: boolean }
    ): CallbackExecutionResult;
    emit(result: CallbackExecutionResult): void;
  };
  runtime: {
    now(): Date;
    nowMs(): number;
    pid(): number;
    sleep(milliseconds: number): void;
    log(
      level: "info" | "warn" | "error",
      event: string,
      fields: JsonRecord
    ): void;
    exitAfterApprovalCallback(): boolean;
    exit(code: number): never;
  };
  presentation: {
    emit(result: TerminalMonitorPresentation): void;
  };
}

interface MonitorLoopState {
  conversation: Conversation;
  executor: Executor;
  monitorMessageId: string;
  taskStartedAtMs: number;
  lastActivityAtMs: number;
  lastPersistedActivityAtMs: number;
  persistedActivityReason?: string;
  persistedDetectorDiagnosticFingerprint?: string;
  persistedDetectorDiagnosticStatus?: string;
  preSendScreenFingerprint?: string;
  pollPolicyState: TerminalMonitorPollState;
  bindingCheckDeferredAttempts: number;
  bindingCheckFirstDeferredAt?: string;
}

export interface RunTerminalMonitorInput {
  initialConversation: Conversation;
  expectedTerminalMessageId: string;
  configuration(): TerminalMonitorConfiguration;
  lifecycle: { startedRecorded: boolean };
  ports: TerminalMonitorServicePorts;
}

export interface TerminalMonitorDeferralPorts {
  state: {
    load(): Conversation;
    appendEvent(event: { event: string; [key: string]: unknown }): void;
  };
  authority: {
    terminalControl(conversation: Conversation): TerminalControlRef | undefined;
    bindingSuperseded(error: unknown): { code: string; message: string } | undefined;
    storeOperationTimeout(error: unknown):
      | { code: string; lockKind: string }
      | undefined;
  };
  runtime: TerminalMonitorServicePorts["runtime"];
  presentation: TerminalMonitorServicePorts["presentation"];
}

/** Retry Store contention without releasing the singleton monitor owner. */
export async function runTerminalMonitorWithStoreDeferral(input: {
  initialConversation: Conversation;
  terminalMessageId: string;
  run(): Promise<void>;
  ports: TerminalMonitorDeferralPorts;
}): Promise<void> {
  let attempts = 0;
  let firstDeferredAt: string | undefined;
  while (true) {
    try {
      if (attempts > 0) {
        const resumed = resumeDeferredStoreOperation(input, {
          attempts,
          firstDeferredAt
        });
        if (!resumed) {
          return;
        }
        attempts = 0;
        firstDeferredAt = undefined;
      }
      await input.run();
      return;
    } catch (error) {
      const superseded = input.ports.authority.bindingSuperseded(error);
      if (superseded) {
        presentBindingSuperseded(input, superseded);
        return;
      }
      const timeout = input.ports.authority.storeOperationTimeout(error);
      if (!timeout) {
        throw error;
      }
      attempts += 1;
      firstDeferredAt ??= input.ports.runtime.now().toISOString();
      const retryInMs = Math.min(
        5_000,
        250 * (2 ** Math.min(5, attempts - 1))
      );
      input.ports.runtime.log("warn", "terminal_bridge_monitor_store_operation_deferred", {
        conversation_id: input.initialConversation.conversation_id,
        terminal_bridge_message_id: input.terminalMessageId,
        error_code: timeout.code,
        lock_kind: timeout.lockKind,
        attempt: attempts,
        retry_in_ms: retryInMs
      });
      input.ports.runtime.sleep(retryInMs);
    }
  }
}

function resumeDeferredStoreOperation(
  input: Parameters<typeof runTerminalMonitorWithStoreDeferral>[0],
  deferral: { attempts: number; firstDeferredAt?: string }
): boolean {
  const resumedAt = input.ports.runtime.now().toISOString();
  const conversation = input.ports.state.load();
  const takeover = takeoverFor(conversation);
  if (
    stringValue(takeover?.terminal_bridge_message_id) !== input.terminalMessageId
  ) {
    input.ports.runtime.log("info", "terminal_bridge_monitor_finished", {
      conversation_id: conversation.conversation_id,
      terminal_bridge_message_id: input.terminalMessageId,
      reason: "terminal_bridge_generation_replaced_during_store_deferral"
    });
    input.ports.presentation.emit({ kind: "generation_replaced", conversation });
    return false;
  }
  input.ports.state.appendEvent({
    ts: resumedAt,
    conversation_id: conversation.conversation_id,
    event: "terminal_bridge_monitor_store_operation_deferred",
    terminal_bridge_message_id: input.terminalMessageId,
    error_code: "AKK_STORE_LOCK_TIMEOUT",
    first_deferred_at: deferral.firstDeferredAt,
    resumed_at: resumedAt,
    attempts: deferral.attempts,
    outcome: "resumed"
  });
  input.ports.runtime.log("info", "terminal_bridge_monitor_store_operation_resumed", {
    conversation_id: conversation.conversation_id,
    terminal_bridge_message_id: input.terminalMessageId,
    attempts: deferral.attempts,
    first_deferred_at: deferral.firstDeferredAt
  });
  return true;
}

function presentBindingSuperseded(
  input: Parameters<typeof runTerminalMonitorWithStoreDeferral>[0],
  error: { code: string; message: string }
): void {
  const control = input.ports.authority.terminalControl(input.initialConversation);
  input.ports.runtime.log("warn", "terminal_bridge_monitor_binding_superseded", {
    conversation_id: input.initialConversation.conversation_id,
    terminal_target: control?.target,
    reason: error.message
  });
  try {
    input.ports.state.appendEvent({
      ts: input.ports.runtime.now().toISOString(),
      conversation_id: input.initialConversation.conversation_id,
      event: "terminal_bridge_monitor_binding_superseded",
      terminal_control: control,
      error_code: error.code,
      reason: error.message
    });
  } catch (diagnosticError) {
    input.ports.runtime.log("warn", "terminal_bridge_monitor_diagnostic_write_failed", {
      conversation_id: input.initialConversation.conversation_id,
      terminal_target: control?.target,
      diagnostic_event: "terminal_bridge_monitor_binding_superseded",
      reason: diagnosticError instanceof Error
        ? diagnosticError.message
        : String(diagnosticError)
    });
  }
  input.ports.presentation.emit({
    kind: "binding_superseded",
    conversation: input.initialConversation,
    detail: error.message
  });
}

/**
 * Run one exact terminal-monitor generation after the composition root has
 * acquired the singleton owner lock. All terminal, Store, state-lock, process,
 * callback and presentation effects remain behind typed ports.
 */
export async function runTerminalMonitor(
  input: RunTerminalMonitorInput
): Promise<{ startedRecorded: boolean }> {
  const initialized = initializeMonitor(input);
  if (initialized.kind === "finished") {
    input.ports.presentation.emit(initialized.presentation);
    return { startedRecorded: input.lifecycle.startedRecorded };
  }
  const { configuration, state } = initialized;
  input.ports.authority.initialize();
  if (!input.lifecycle.startedRecorded) {
    recordMonitorStarted(state, configuration, input.ports);
    input.lifecycle.startedRecorded = true;
  }
  while (true) {
    const iteration = await runMonitorIteration(
      state,
      configuration,
      input.ports
    );
    if (iteration === "finished") {
      return { startedRecorded: input.lifecycle.startedRecorded };
    }
  }
}

type MonitorInitialization =
  | {
      kind: "ready";
      configuration: TerminalMonitorConfiguration;
      state: MonitorLoopState;
    }
  | { kind: "finished"; presentation: TerminalMonitorPresentation };

function initializeMonitor(input: RunTerminalMonitorInput): MonitorInitialization {
  const conversation = input.initialConversation;
  const takeover = takeoverFor(conversation);
  if (
    stringValue(takeover?.terminal_bridge_message_id) !==
    input.expectedTerminalMessageId
  ) {
    input.ports.runtime.log("info", "terminal_bridge_monitor_finished", {
      conversation_id: conversation.conversation_id,
      terminal_bridge_message_id: input.expectedTerminalMessageId,
      reason: "terminal_bridge_generation_replaced_before_monitor_restart"
    });
    return {
      kind: "finished",
      presentation: { kind: "generation_replaced", conversation }
    };
  }
  const configuration = input.configuration();
  const nowMs = input.ports.runtime.nowMs();
  const taskStartedAtMs = validTerminalMonitorTimestampMs(
    takeover?.terminal_bridge_started_at
  ) ?? nowMs;
  const lastActivityAtMs =
    validTerminalMonitorTimestampMs(takeover?.terminal_bridge_last_activity_at) ??
      taskStartedAtMs;
  const initialDiagnostic = isRecord(takeover?.terminal_bridge_detector_diagnostic)
    ? takeover.terminal_bridge_detector_diagnostic
    : undefined;
  const preSendScreenFingerprint = stringValue(
    takeover?.terminal_bridge_pre_send_screen_fingerprint
  );
  return {
    kind: "ready",
    configuration,
    state: {
      conversation,
      executor: executorForConversation(conversation),
      monitorMessageId: input.expectedTerminalMessageId,
      taskStartedAtMs,
      lastActivityAtMs,
      lastPersistedActivityAtMs: lastActivityAtMs,
      persistedActivityReason: stringValue(
        takeover?.terminal_bridge_last_activity_reason
      ),
      persistedDetectorDiagnosticFingerprint: stringValue(
        initialDiagnostic?.fingerprint
      ),
      persistedDetectorDiagnosticStatus: stringValue(initialDiagnostic?.status),
      preSendScreenFingerprint,
      pollPolicyState: { previousScreenFingerprint: preSendScreenFingerprint },
      bindingCheckDeferredAttempts: 0
    }
  };
}

function recordMonitorStarted(
  state: MonitorLoopState,
  configuration: TerminalMonitorConfiguration,
  ports: TerminalMonitorServicePorts
): void {
  const now = ports.runtime.now().toISOString();
  ports.state.appendEvent({
    ts: now,
    conversation_id: state.conversation.conversation_id,
    event: "terminal_bridge_monitor_started",
    monitor_pid: ports.runtime.pid(),
    executor: state.executor,
    agent_timeout_minutes: configuration.timeoutMinutes,
    agent_hard_timeout_minutes: configuration.hardTimeoutMinutes,
    poll_interval_ms: configuration.pollIntervalMs,
    task_started_at: new Date(state.taskStartedAtMs).toISOString(),
    last_activity_at: new Date(state.lastActivityAtMs).toISOString(),
    inactivity_deadline_at: configuration.timeoutMinutes > 0
      ? new Date(
          state.lastActivityAtMs + configuration.timeoutMinutes * 60 * 1000
        ).toISOString()
      : null,
    hard_deadline_at: configuration.hardTimeoutMinutes > 0
      ? new Date(
          state.taskStartedAtMs + configuration.hardTimeoutMinutes * 60 * 1000
        ).toISOString()
      : null
  });
  ports.runtime.log("info", "terminal_bridge_monitor_started", {
    conversation_id: state.conversation.conversation_id,
    monitor_pid: ports.runtime.pid(),
    agent: state.executor.kind,
    executor_session: state.executor.session,
    agent_timeout_minutes: configuration.timeoutMinutes,
    agent_hard_timeout_minutes: configuration.hardTimeoutMinutes
  });
}

async function runMonitorIteration(
  state: MonitorLoopState,
  configuration: TerminalMonitorConfiguration,
  ports: TerminalMonitorServicePorts
): Promise<"continue" | "finished"> {
  state.conversation = ports.state.load();
  if (!ports.authority.isWaitingForAgent(state.conversation.status)) {
    ports.runtime.log("info", "terminal_bridge_monitor_finished", {
      conversation_id: state.conversation.conversation_id,
      status: state.conversation.status,
      reason: "conversation_no_longer_waiting"
    });
    ports.presentation.emit({
      kind: "conversation_no_longer_waiting",
      conversation: state.conversation
    });
    return "finished";
  }

  let takeover = takeoverFor(state.conversation);
  const currentMessageId = stringValue(takeover?.terminal_bridge_message_id);
  if (currentMessageId !== state.monitorMessageId) {
    ports.state.appendEvent({
      ts: ports.runtime.now().toISOString(),
      conversation_id: state.conversation.conversation_id,
      event: "terminal_bridge_monitor_superseded",
      monitor_message_id: state.monitorMessageId,
      current_message_id: currentMessageId
    });
    ports.presentation.emit({ kind: "task_replaced", conversation: state.conversation });
    return "finished";
  }
  const terminalControl = ports.authority.terminalControl(state.conversation);
  if (!terminalControl || takeover?.terminal_bridge !== true) {
    const stalled = ports.state.markStalled(
      "terminal bridge monitor could not find terminal bridge metadata",
      { terminal_bridge: true }
    );
    ports.presentation.emit({
      kind: "stalled",
      conversation: stalled,
      reason: stringValue(stalled.stalled_reason)
    });
    return "finished";
  }

  const submissionResult = await reconcileSubmissionPhase({
    state,
    configuration,
    ports,
    terminalControl,
    currentMessageId
  });
  if (submissionResult !== "proceed") {
    return submissionResult;
  }
  const observed = await observeMonitorPoll({
    state,
    configuration,
    ports,
    terminalControl,
    currentMessageId
  });
  if (observed.kind !== "observed") {
    return observed.kind;
  }
  takeover = takeoverFor(state.conversation);
  return handleObservedPoll({
    state,
    configuration,
    ports,
    terminalControl,
    currentMessageId,
    takeover,
    poll: observed.poll
  });
}

function takeoverFor(conversation: Conversation): JsonRecord | undefined {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
}

interface SubmissionPhaseInput {
  state: MonitorLoopState;
  configuration: TerminalMonitorConfiguration;
  ports: TerminalMonitorServicePorts;
  terminalControl: TerminalControlRef;
  currentMessageId?: string;
}

async function reconcileSubmissionPhase({
  state,
  configuration,
  ports,
  terminalControl,
  currentMessageId
}: SubmissionPhaseInput): Promise<"proceed" | "continue" | "finished"> {
  const submission = ports.authority.submission(state.conversation);
  if (
    !currentMessageId ||
    !submission ||
    stringValue(submission.message_id) !== currentMessageId
  ) {
    return "proceed";
  }
  const status = stringValue(submission.status);
  if (status === "text_injected" || status === "enter_dispatched") {
    return reconcileDispatchedSubmission({
      state,
      configuration,
      ports,
      terminalControl,
      currentMessageId,
      submission,
      status
    });
  }
  if (status === "prepared") {
    return recoverPreparedSubmission({
      state,
      configuration,
      ports,
      terminalControl,
      currentMessageId,
      submission
    });
  }
  if (status === "not_accepted" || status === "uncertain" || status === "aborted") {
    const safeToRetry = status === "aborted" && submission.safe_to_retry === true;
    ports.presentation.emit({
      kind: "submission_terminal",
      conversation: state.conversation,
      status,
      safeToRetry
    });
    return "finished";
  }
  if (status !== "submitted" && status !== "agent_accepted") {
    ports.presentation.emit({
      kind: "submission_status_invalid",
      conversation: state.conversation
    });
    return "finished";
  }
  return "proceed";
}

async function reconcileDispatchedSubmission({
  state,
  configuration,
  ports,
  terminalControl,
  currentMessageId,
  submission,
  status
}: SubmissionPhaseInput & {
  currentMessageId: string;
  submission: JsonRecord;
  status: "text_injected" | "enter_dispatched";
}): Promise<"continue" | "finished"> {
  const dispatcherPid = Number(submission.dispatcher_pid);
  if (
    Number.isSafeInteger(dispatcherPid) &&
    dispatcherPid > 1 &&
    ports.authority.isProcessAlive(dispatcherPid)
  ) {
    ports.runtime.sleep(configuration.pollIntervalMs);
    return "continue";
  }
  if (status === "text_injected") {
    state.conversation = ports.authority.markAcceptanceUncertain({
      conversation: state.conversation,
      terminalControl,
      reason:
        "terminal dispatcher exited after text injection but before Enter dispatch was durably proven"
    });
    ports.presentation.emit({
      kind: "submission_uncertain",
      conversation: state.conversation,
      deliveryReceipt: "text_injected",
      reason: "text was injected but native submission was not proven; inspect the composer"
    });
    return "finished";
  }
  const result = await ports.authority.reconcileAcceptance({
    conversation: state.conversation,
    terminalControl,
    executor: state.executor,
    apply: (reconciliation) => {
      if (reconciliation.outcome === "accepted") {
        state.conversation = reconciliation.conversation;
        return "continue";
      }
      if (reconciliation.outcome === "not_accepted") {
        ports.presentation.emit({
          kind: "submission_not_accepted",
          conversation: reconciliation.conversation
        });
        return "finished";
      }
      return "pending";
    },
    recover: (error) => {
      if (ports.authority.storeOperationTimeout(error)) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      state.conversation = ports.authority.markAcceptanceUncertain({
        conversation: state.conversation,
        terminalControl,
        reason
      });
      ports.presentation.emit({
        kind: "submission_uncertain",
        conversation: state.conversation,
        deliveryReceipt: "enter_dispatched",
        reason
      });
      return "finished";
    }
  });
  if (result === "pending") {
    ports.runtime.sleep(configuration.pollIntervalMs);
    return "continue";
  }
  return result;
}

async function recoverPreparedSubmission({
  state,
  configuration,
  ports,
  terminalControl,
  currentMessageId,
  submission
}: SubmissionPhaseInput & {
  currentMessageId: string;
  submission: JsonRecord;
}): Promise<"continue" | "finished"> {
  const dispatcherPid = Number(submission.dispatcher_pid);
  if (
    Number.isSafeInteger(dispatcherPid) &&
    dispatcherPid > 1 &&
    ports.authority.isProcessAlive(dispatcherPid)
  ) {
    ports.runtime.sleep(configuration.pollIntervalMs);
    return "continue";
  }
  state.conversation = await ports.authority.recoverPreparedSubmission({
    conversation: state.conversation,
    terminalControl,
    currentMessageId,
    dispatcherPid
  });
  const recovered = ports.authority.submission(state.conversation);
  const recoveredStatus = stringValue(recovered?.status) ?? "uncertain";
  if (
    stringValue(recovered?.message_id) === currentMessageId &&
    (recoveredStatus === "submitted" || recoveredStatus === "agent_accepted")
  ) {
    return "continue";
  }
  ports.presentation.emit({
    kind: "submission_unproven",
    conversation: state.conversation,
    status: recoveredStatus
  });
  return "finished";
}

interface ObserveMonitorPollInput extends SubmissionPhaseInput {
  currentMessageId?: string;
}

async function observeMonitorPoll({
  state,
  configuration,
  ports,
  terminalControl,
  currentMessageId
}: ObserveMonitorPollInput): Promise<
  | { kind: "observed"; poll: TerminalMonitorPoll }
  | { kind: "continue" }
  | { kind: "finished" }
> {
  try {
    ports.authority.assertBindingCurrent(state.conversation);
  } catch (error) {
    const lockTimeout = ports.authority.storeLeaseTimeout(error);
    if (!lockTimeout) {
      if (!ports.authority.bindingSuperseded(error)) {
        ports.runtime.log("error", "terminal_bridge_monitor_binding_check_failed", {
          conversation_id: state.conversation.conversation_id,
          terminal_target: terminalControl.target,
          error_code: isRecord(error) ? stringValue(error.code) : undefined,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
    state.bindingCheckDeferredAttempts += 1;
    state.bindingCheckFirstDeferredAt ??= ports.runtime.now().toISOString();
    const backoffMs = Math.min(
      5_000,
      250 * (2 ** Math.min(5, state.bindingCheckDeferredAttempts - 1))
    );
    ports.runtime.log("warn", "terminal_bridge_monitor_binding_check_deferred", {
      conversation_id: state.conversation.conversation_id,
      terminal_target: terminalControl.target,
      error_code: lockTimeout.code,
      lock_kind: lockTimeout.lockKind,
      attempt: state.bindingCheckDeferredAttempts,
      retry_in_ms: backoffMs
    });
    ports.runtime.sleep(backoffMs);
    return { kind: "continue" };
  }

  if (!recordBindingCheckResumed(state, configuration, ports, terminalControl)) {
    return { kind: "continue" };
  }
  const screenChangedSinceSend =
    state.preSendScreenFingerprint !== undefined &&
    state.pollPolicyState.previousScreenFingerprint !== undefined &&
    state.pollPolicyState.previousScreenFingerprint !==
      state.preSendScreenFingerprint;
  const result = await ports.authority.poll({
    conversation: state.conversation,
    terminalControl,
    currentMessageId,
    executor: state.executor,
    screenChangedSinceSend,
    onFenced: (ledgerStatus) => ports.presentation.emit({
      kind: "dispatch_fenced",
      conversation: state.conversation,
      ledgerStatus
    })
  });
  if (result.kind === "retry") {
    state.conversation = result.conversation;
    return { kind: "continue" };
  }
  if (result.kind === "fenced") {
    return { kind: "finished" };
  }
  return result;
}

function recordBindingCheckResumed(
  state: MonitorLoopState,
  configuration: TerminalMonitorConfiguration,
  ports: TerminalMonitorServicePorts,
  terminalControl: TerminalControlRef
): boolean {
  if (state.bindingCheckDeferredAttempts === 0) {
    return true;
  }
  const resumedAt = ports.runtime.now().toISOString();
  try {
    ports.state.appendEvent({
      ts: resumedAt,
      conversation_id: state.conversation.conversation_id,
      event: "terminal_bridge_monitor_binding_check_deferred",
      terminal_control: terminalControl,
      error_code: "AKK_STORE_LOCK_TIMEOUT",
      lock_kind: "writer",
      first_deferred_at: state.bindingCheckFirstDeferredAt,
      resumed_at: resumedAt,
      attempts: state.bindingCheckDeferredAttempts,
      outcome: "resumed"
    });
    ports.runtime.log("info", "terminal_bridge_monitor_binding_check_resumed", {
      conversation_id: state.conversation.conversation_id,
      terminal_target: terminalControl.target,
      attempts: state.bindingCheckDeferredAttempts,
      first_deferred_at: state.bindingCheckFirstDeferredAt
    });
    state.bindingCheckDeferredAttempts = 0;
    state.bindingCheckFirstDeferredAt = undefined;
    return true;
  } catch (error) {
    const lockTimeout = ports.authority.storeLeaseTimeout(error);
    if (!lockTimeout) {
      throw error;
    }
    ports.runtime.log("warn", "terminal_bridge_monitor_diagnostic_write_deferred", {
      conversation_id: state.conversation.conversation_id,
      terminal_target: terminalControl.target,
      error_code: lockTimeout.code,
      lock_kind: lockTimeout.lockKind
    });
    ports.runtime.sleep(Math.max(250, configuration.pollIntervalMs));
    return false;
  }
}

interface ObservedPollInput extends SubmissionPhaseInput {
  currentMessageId?: string;
  takeover?: JsonRecord;
  poll: TerminalMonitorPoll;
}

interface SampledPollInput extends ObservedPollInput {
  terminalStatus: TerminalBridgeStatus;
  currentScreenFingerprint?: string;
}

interface CompletionPollInput extends SampledPollInput {
  durableFingerprint?: string;
  completion?: TerminalCompletionEvidence;
  completionMetadata: JsonRecord;
  completionFingerprint?: string;
}

async function handleObservedPoll(
  input: ObservedPollInput
): Promise<"continue" | "finished"> {
  const terminalStatus = input.poll.status;
  const sampledStatus = { ...input, terminalStatus };
  const diagnostic = persistDetectorDiagnostic(sampledStatus);
  if (!diagnostic.proceed) {
    return "continue";
  }
  const currentScreenFingerprint = terminalScreenFingerprint(terminalStatus);
  const sampledApproval = {
    ...sampledStatus,
    currentScreenFingerprint
  };
  const approval = handleApprovalObservation({
    ...sampledApproval,
    takeover: diagnostic.takeover
  });
  if (approval !== "proceed") {
    return approval;
  }
  const durable = input.poll.durableCompletion;
  const durableFingerprint = durable
    ? terminalMonitorActivityFingerprint(JSON.stringify({
        text: durable.text,
        timestamp: durable.timestamp,
        id: durable.id,
        metadata: durable.metadata
      }))
    : undefined;
  const completion = input.poll.completion;
  const completionMetadata = isRecord(completion?.metadata)
    ? completion.metadata
    : {};
  const completionFingerprint = completion
    ? terminalBridgeCompletionFingerprint({
        completion,
        terminalMessageId: input.currentMessageId
      })
    : undefined;
  return handleCompletionAndTimeout({
    ...sampledApproval,
    durableFingerprint,
    completion,
    completionMetadata,
    completionFingerprint
  });
}

function persistDetectorDiagnostic(input: SampledPollInput): {
  proceed: boolean;
  takeover?: JsonRecord;
} {
  const {
    state,
    configuration,
    ports,
    terminalControl,
    currentMessageId,
    terminalStatus
  } = input;
  const limitation = stringValue(terminalStatus.capability_limitation);
  const fingerprint = limitation
    ? terminalMonitorActivityFingerprint(limitation)
    : undefined;
  const changed = limitation
    ? fingerprint !== state.persistedDetectorDiagnosticFingerprint ||
      state.persistedDetectorDiagnosticStatus !== "limited"
    : state.persistedDetectorDiagnosticStatus === "limited";
  if (!changed) {
    return { proceed: true, takeover: input.takeover };
  }
  try {
    const persisted = ports.state.persistDetectorDiagnostic({
      expectedConversationId: state.conversation.conversation_id,
      expectedMessageId: currentMessageId,
      limitation,
      fingerprint
    });
    if (persisted.diagnostic) {
      state.conversation = persisted.conversation;
      const takeover = takeoverFor(state.conversation);
      state.persistedDetectorDiagnosticFingerprint = stringValue(
        persisted.diagnostic.fingerprint
      );
      state.persistedDetectorDiagnosticStatus = stringValue(
        persisted.diagnostic.status
      );
      return { proceed: true, takeover };
    }
    return { proceed: true, takeover: input.takeover };
  } catch (error) {
    const lockTimeout = ports.authority.storeLeaseTimeout(error);
    if (!lockTimeout) {
      throw error;
    }
    ports.runtime.log("warn", "terminal_bridge_detector_diagnostic_deferred", {
      conversation_id: state.conversation.conversation_id,
      terminal_target: terminalControl.target,
      error_code: lockTimeout.code,
      lock_kind: lockTimeout.lockKind
    });
    ports.runtime.sleep(Math.max(250, configuration.pollIntervalMs));
    return { proceed: false, takeover: input.takeover };
  }
}

function handleApprovalObservation(
  input: SampledPollInput
): "proceed" | "continue" | "finished" {
  const {
    state,
    configuration,
    ports,
    terminalControl,
    terminalStatus,
    currentMessageId,
    currentScreenFingerprint
  } = input;
  const approval = terminalStatus.approval_state;
  const currentScreenChangedSinceSend =
    state.preSendScreenFingerprint !== undefined &&
    currentScreenFingerprint !== undefined &&
    currentScreenFingerprint !== state.preSendScreenFingerprint;
  const claudePermissionVisible =
    state.executor.kind === "claude" &&
    approval.blocked === true &&
    approval.prompt_kind === "claude_permission";
  const observedFingerprint = claudePermissionVisible
    ? terminalMonitorApprovalFingerprint({ terminalControl, terminalStatus })
    : undefined;
  const decision = decideTerminalMonitorApproval({
    executorKind: state.executor.kind,
    executorDisplayName: state.executor.display_name,
    terminalReachable: terminalStatus.reachable,
    approval,
    nativeTakeover: input.takeover,
    currentMessageId,
    currentScreenFingerprint,
    currentScreenChangedSinceSend,
    observedFingerprint,
    transcriptIdentity: claudePermissionVisible
      ? claudeTranscriptApprovalIdentity(approval)
      : undefined
  });
  if (decision.markPromptCleared) {
    const cleared = ports.state.markApprovalPromptCleared({
      expectedConversationId: state.conversation.conversation_id,
      expectedMessageId: currentMessageId
    });
    if (cleared.marked) {
      state.conversation = cleared.conversation;
    }
  }
  for (const suppression of decision.suppressions) {
    state.pollPolicyState = {
      ...state.pollPolicyState,
      previousScreenFingerprint: currentScreenFingerprint
    };
    logApprovalSuppression(input, suppression);
  }
  if (decision.notification.kind === "none") {
    return "proceed";
  }
  return deliverApprovalNotification({
    state,
    configuration,
    ports,
    terminalControl,
    terminalStatus,
    currentMessageId,
    currentScreenFingerprint,
    notification: decision.notification.kind === "question"
      ? { kind: "question" }
      : {
          kind: "error",
          reason: decision.notification.reason ??
            "Claude Code permission state cannot be safely resolved through AKK"
        }
  });
}

function logApprovalSuppression(
  input: ObservedPollInput,
  suppression: ReturnType<
    typeof decideTerminalMonitorApproval
  >["suppressions"][number]
): void {
  const detail = {
    conversation_id: input.state.conversation.conversation_id,
    terminal_target: input.terminalControl.target
  };
  if (suppression.kind === "screen_not_new") {
    input.ports.runtime.log("warn", "claude_screen_approval_not_new", {
      ...detail,
      reason:
        "permission screen is not proven to have changed since the managed send"
    });
    return;
  }
  input.ports.runtime.log("info", "claude_consumed_approval_screen_still_visible", {
    ...detail,
    fingerprint: suppression.fingerprint,
    screen_digest: suppression.screenDigest,
    reason: suppression.reason
  });
}

function deliverApprovalNotification(input: {
  state: MonitorLoopState;
  configuration: TerminalMonitorConfiguration;
  ports: TerminalMonitorServicePorts;
  terminalControl: TerminalControlRef;
  terminalStatus: TerminalBridgeStatus;
  currentMessageId?: string;
  currentScreenFingerprint?: string;
  notification:
    | { kind: "question" }
    | { kind: "error"; reason: string };
}): "continue" | "finished" {
  const {
    state,
    configuration,
    ports,
    terminalControl,
    terminalStatus,
    currentMessageId,
    currentScreenFingerprint
  } = input;
  const question = input.notification.kind === "question";
  const reason = input.notification.kind === "error"
    ? input.notification.reason
    : undefined;
  const order = terminalMonitorApprovalEffectOrder(
    question ? "question" : "error"
  );
  let fingerprint = order[0] === "fingerprint"
    ? terminalMonitorApprovalFingerprint({ terminalControl, terminalStatus })
    : undefined;
  appendApprovalEvent(input, question, fingerprint, reason);
  if (order[1] === "fingerprint") {
    fingerprint = terminalMonitorApprovalFingerprint({
      terminalControl,
      terminalStatus
    });
  }
  const notification = ports.state.recordApprovalNotification({
    conversation: state.conversation,
    executor: state.executor,
    terminalControl,
    terminalStatus,
    currentMessageId,
    fingerprint,
    kind: question ? "question" : "error",
    reason
  });
  if (notification.stale) {
    state.pollPolicyState = {
      ...state.pollPolicyState,
      previousScreenFingerprint: currentScreenFingerprint
    };
    ports.runtime.sleep(configuration.pollIntervalMs);
    return "continue";
  }
  if (notification.duplicate) {
    ports.presentation.emit({
      kind: "approval_duplicate",
      conversation: notification.conversation,
      terminalControl,
      terminalStatus,
      approvable: question,
      ...(!question ? { reason } : {})
    });
    return "finished";
  }
  const prepared = notification.recorded?.prepared;
  if (!prepared) {
    ports.presentation.emit({
      kind: "approval_gateway_missing",
      conversation: notification.conversation,
      callbackMessage: notification.recorded?.callbackMessage,
      terminalControl,
      terminalStatus,
      approvable: question
    });
    return "finished";
  }
  if (!question) {
    ports.callbacks.run(prepared);
    return "finished";
  }
  return runApprovableCallback({
    ...input,
    fingerprint,
    prepared
  });
}

function appendApprovalEvent(
  input: Pick<
    ObservedPollInput,
    "state" | "ports" | "terminalControl"
  > & { terminalStatus: TerminalBridgeStatus },
  question: boolean,
  fingerprint?: string,
  reason?: string
): void {
  input.ports.state.appendEvent(question
    ? {
        ts: input.ports.runtime.now().toISOString(),
        conversation_id: input.state.conversation.conversation_id,
        event: "terminal_bridge_approval_detected",
        terminal_control: input.terminalControl,
        activity_state: input.terminalStatus.activity_state,
        activity_reason: input.terminalStatus.activity_reason,
        fingerprint
      }
    : {
        ts: input.ports.runtime.now().toISOString(),
        conversation_id: input.state.conversation.conversation_id,
        event: "terminal_bridge_approval_not_approvable",
        terminal_control: input.terminalControl,
        activity_state: input.terminalStatus.activity_state,
        reason
      });
}

function runApprovableCallback(input: {
  state: MonitorLoopState;
  configuration: TerminalMonitorConfiguration;
  ports: TerminalMonitorServicePorts;
  terminalControl: TerminalControlRef;
  terminalStatus: TerminalBridgeStatus;
  currentMessageId?: string;
  currentScreenFingerprint?: string;
  fingerprint?: string;
  prepared: PreparedCallback;
}): "continue" | "finished" {
  const {
    state,
    configuration,
    ports,
    terminalControl,
    currentMessageId,
    currentScreenFingerprint,
    fingerprint,
    prepared
  } = input;
  const result = ports.callbacks.run(prepared, { emit: false });
  if (result.delivered && ports.runtime.exitAfterApprovalCallback()) {
    ports.state.appendEvent({
      ts: ports.runtime.now().toISOString(),
      conversation_id: state.conversation.conversation_id,
      event: "terminal_bridge_test_exit_after_approval_callback_delivered",
      terminal_control: terminalControl,
      fingerprint
    });
    ports.runtime.exit(86);
  }
  const afterCallback = ports.state.load();
  const takeover = takeoverFor(afterCallback);
  const consumed =
    ports.authority.isWaitingForAgent(afterCallback.status) &&
    takeover?.terminal_bridge_approval === undefined &&
    stringValue(takeover?.terminal_bridge_message_id) === currentMessageId &&
    stringValue(takeover?.terminal_bridge_last_approval_message_id) ===
      currentMessageId &&
    stringValue(takeover?.terminal_bridge_last_approval_fingerprint) ===
      fingerprint;
  if (!consumed) {
    ports.callbacks.emit(result);
    return "finished";
  }
  state.conversation = afterCallback;
  state.pollPolicyState = {
    previousScreenFingerprint: currentScreenFingerprint
  };
  state.lastActivityAtMs =
    validTerminalMonitorTimestampMs(
      takeover?.terminal_bridge_last_activity_at
    ) ??
    ports.runtime.nowMs();
  state.lastPersistedActivityAtMs = state.lastActivityAtMs;
  state.persistedActivityReason = stringValue(
    takeover?.terminal_bridge_last_activity_reason
  );
  ports.state.appendEvent({
    ts: ports.runtime.now().toISOString(),
    conversation_id: afterCallback.conversation_id,
    event: "terminal_bridge_monitor_continued_after_approval",
    terminal_control: terminalControl,
    fingerprint
  });
  ports.runtime.sleep(configuration.pollIntervalMs);
  return "continue";
}

async function handleCompletionAndTimeout(
  input: CompletionPollInput
): Promise<"continue" | "finished"> {
  const {
    state,
    configuration,
    ports,
    terminalStatus,
    currentScreenFingerprint,
    durableFingerprint,
    completion,
    completionFingerprint
  } = input;
  const decision = reduceTerminalMonitorDecision({
    state: state.pollPolicyState,
    activityState: terminalStatus.activity_state,
    activityReason: terminalStatus.activity_reason,
    screenFingerprint: currentScreenFingerprint,
    durableFingerprint,
    completionPresent: Boolean(completion),
    completionFingerprint
  });
  state.pollPolicyState = decision.state;
  if (decision.activity.activityReason !== undefined) {
    const observedAtMs = ports.runtime.nowMs();
    state.lastActivityAtMs = observedAtMs;
    if (
      state.persistedActivityReason === undefined ||
      observedAtMs - state.lastPersistedActivityAtMs >=
        configuration.activityPersistIntervalMs
    ) {
      state.conversation = ports.state.persistActivity({
        conversation: state.conversation,
        observedAtMs,
        reason: decision.activity.activityReason,
        activityState: terminalStatus.activity_state,
        timeoutMinutes: configuration.timeoutMinutes,
        hardTimeoutMinutes: configuration.hardTimeoutMinutes
      });
      state.lastPersistedActivityAtMs = observedAtMs;
      state.persistedActivityReason = decision.activity.activityReason;
      if (!ports.authority.isWaitingForAgent(state.conversation.status)) {
        return "continue";
      }
    }
  }
  return applyMonitorNextAction({
    ...input,
    completion,
    nextAction: decision.next
  });
}

async function applyMonitorNextAction(
  input: CompletionPollInput & {
    nextAction: TerminalMonitorNextAction;
  }
): Promise<"continue" | "finished"> {
  const { state, ports, terminalControl, currentMessageId } = input;
  if (input.completion && input.nextAction.kind === "complete") {
    const prepared = ports.callbacks.prepareCompletion({
      conversation: state.conversation,
      executor: state.executor,
      terminalControl,
      terminalMessageId: currentMessageId ?? state.monitorMessageId,
      completion: input.completion,
      completionFingerprint: input.nextAction.completionFingerprint
    });
    if (!prepared.claimed) {
      ports.presentation.emit({
        kind: "completion_duplicate",
        conversation: prepared.conversation,
        reason: prepared.reason
      });
      return "finished";
    }
    ports.callbacks.run(prepared.prepared);
    return "finished";
  }
  if (input.nextAction.kind === "verify_dead") {
    const dead = await ports.callbacks.verifiedDead({
      conversationId: state.conversation.conversation_id,
      messageId: currentMessageId
    });
    if (dead.completionPreparation) {
      const preparation = dead.completionPreparation;
      if (!preparation.claimed) {
        ports.presentation.emit({
          kind: "completion_duplicate",
          conversation: preparation.conversation,
          reason: preparation.reason
        });
        return "finished";
      }
      ports.callbacks.run(preparation.prepared);
      return "finished";
    }
    if (dead.stalled) {
      ports.presentation.emit({
        kind: "stalled",
        conversation: dead.conversation,
        reason: dead.reason
      });
      return "finished";
    }
  }
  return handleTimeout(input);
}

function handleTimeout(
  input: CompletionPollInput
): "continue" | "finished" {
  const {
    state,
    configuration,
    ports,
    terminalControl,
    terminalStatus,
    completionMetadata
  } = input;
  const nowMs = ports.runtime.nowMs();
  const decision = decideTerminalMonitorAfterEffectsTimeout({
    nowMs,
    taskStartedAtMs: state.taskStartedAtMs,
    lastActivityAtMs: state.lastActivityAtMs,
    hardTimeoutMinutes: configuration.hardTimeoutMinutes,
    inactivityTimeoutMinutes: configuration.timeoutMinutes
  });
  if (decision.kind === "poll") {
    ports.runtime.sleep(configuration.pollIntervalMs);
    return "continue";
  }
  if (decision.kind === "hard_timeout") {
    ports.state.appendEvent({
      ts: new Date(nowMs).toISOString(),
      conversation_id: state.conversation.conversation_id,
      event: "terminal_bridge_hard_timeout_reached",
      terminal_control: terminalControl,
      task_started_at: new Date(state.taskStartedAtMs).toISOString(),
      hard_deadline_at: new Date(
        decision.deadlineAtMs
      ).toISOString(),
      agent_hard_timeout_minutes: configuration.hardTimeoutMinutes,
      last_activity_at: new Date(state.lastActivityAtMs).toISOString(),
      terminal_activity_state: terminalStatus.activity_state
    });
    const stalled = ports.state.markStalled(
      `terminal bridge reached its hard lifetime of ${configuration.hardTimeoutMinutes} minutes`,
      {
        terminal_bridge: true,
        terminal_control: terminalControl,
        task_started_at: new Date(state.taskStartedAtMs).toISOString(),
        last_activity_at: new Date(state.lastActivityAtMs).toISOString(),
        agent_hard_timeout_minutes: configuration.hardTimeoutMinutes,
        terminal_activity_state: terminalStatus.activity_state
      }
    );
    ports.presentation.emit({
      kind: "stalled",
      conversation: stalled,
      hardTimeout: true,
      reason: stringValue(stalled.stalled_reason)
    });
    return "finished";
  }
  const stalled = ports.state.markStalled(
    `terminal bridge observed no activity for ${configuration.timeoutMinutes} minutes`,
    {
      terminal_bridge: true,
      terminal_control: terminalControl,
      match: completionMetadata.context_match,
      terminal_activity_state: terminalStatus.activity_state,
      last_activity_at: new Date(state.lastActivityAtMs).toISOString(),
      inactivity_deadline_at: new Date(decision.deadlineAtMs).toISOString(),
      agent_timeout_minutes: configuration.timeoutMinutes
    }
  );
  ports.presentation.emit({
    kind: "stalled",
    conversation: stalled,
    reason: stringValue(stalled.stalled_reason)
  });
  return "finished";
}

function terminalScreenFingerprint(
  status: TerminalBridgeStatus
): string | undefined {
  return stringValue(status.screen.digest) ??
    terminalMonitorScreenFingerprint(status.screen.excerpt);
}
