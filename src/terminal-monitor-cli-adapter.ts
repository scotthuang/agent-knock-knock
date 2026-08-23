import type { Executor } from "./executors.js";
import {
  callbackExpectedForConversation,
  callbackRouteFingerprintForConversation,
  callbackRouteFingerprintFromRecord,
  callbackRouteFingerprintLedgerFields
} from
  "./callback-route-authority.js";
import type { Conversation, ConversationStatus } from "./protocol.js";
import type {
  TerminalControlRef,
  TerminalDurableCompletionRequest,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import type {
  TerminalAgentBridge,
  TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import type { TerminalBridgeSubmissionMutation } from
  "./terminal-dispatch-receipt.js";
import type { TerminalSubmissionAcceptanceEvidence } from
  "./terminal-submission-facts.js";
import { StoreLockTimeoutError } from "./store.js";
import type {
  MonitorApprovalCallbackRecord,
  MonitorApprovalNotificationResult,
  MonitorPollResult,
  MonitorSubmissionReconciliation,
  TerminalMonitorPresentation
} from "./terminal-monitor-application-service.js";
import {
  isRecord,
  nonBlankString,
  type UnknownRecord
} from "./value-guards.js";

type Release = () => void;
type EventRecord = { event: string; [key: string]: unknown };
type MonitorUserAbandonmentStatus = "user_abandoning" | "user_abandoned";

export function terminalMonitorStoreOperationTimeout(error: unknown):
  | { code: string; lockKind: string }
  | undefined {
  if (
    !(error instanceof StoreLockTimeoutError) &&
    !(isRecord(error) && error.code === "LOCK_TIMEOUT")
  ) {
    return undefined;
  }
  return {
    code: isRecord(error)
      ? nonBlankString(error.code) ?? "LOCK_TIMEOUT"
      : "LOCK_TIMEOUT",
    lockKind: error instanceof StoreLockTimeoutError
      ? error.lockKind
      : "conversation"
  };
}

export function terminalMonitorStoreLeaseTimeout(error: unknown):
  | { code: string; lockKind: string }
  | undefined {
  return error instanceof StoreLockTimeoutError
    ? { code: error.code, lockKind: error.lockKind }
    : undefined;
}

export interface PreparedMonitorRecoveryPorts {
  acquireTerminal(control: TerminalControlRef): Release;
  withWriter<T>(use: () => Promise<T>): Promise<T>;
  acquireState(): Release;
  loadConversation(): Conversation;
  userAbandonmentStatus(
    conversation: Conversation
  ): MonitorUserAbandonmentStatus | undefined;
  loadLedger(control: TerminalControlRef): UnknownRecord | undefined;
  saveLedger(control: TerminalControlRef, ledger: UnknownRecord): void;
  saveConversation(conversation: Conversation): void;
  submission(conversation: Conversation): UnknownRecord | undefined;
  applySubmission(mutation: TerminalBridgeSubmissionMutation): Conversation;
  requestFingerprint(requestText: string): string | undefined;
  now(): Date;
  appendEvent(event: EventRecord): void;
  stallCollateral(input: {
    terminalControl: TerminalControlRef;
    currentConversationId: string;
    uncertainMessageId: string;
  }): void;
}

export interface RecoverPreparedMonitorInput {
  conversation: Conversation;
  statePath: string;
  logPath: string;
  terminalControl: TerminalControlRef;
  currentMessageId: string;
  dispatcherPid: number;
  ports: PreparedMonitorRecoveryPorts;
}

export interface LaggingAcceptedMonitorAuthorityRepairPorts {
  acquireTerminal(control: TerminalControlRef): Release;
  withWriter<T>(use: () => Promise<T>): Promise<T>;
  acquireState(): Release;
  loadConversation(): Conversation;
  userAbandonmentStatus(
    conversation: Conversation
  ): MonitorUserAbandonmentStatus | undefined;
  loadLedger(control: TerminalControlRef): UnknownRecord | undefined;
  reconcileLedger(
    control: TerminalControlRef,
    ledger?: UnknownRecord
  ): UnknownRecord | undefined;
  submission(conversation: Conversation): UnknownRecord | undefined;
}

/**
 * Repair the one legacy migration window that otherwise reaches acceptance
 * observation first: an enter-dispatched Turn without route authority and an
 * accepted ledger that already owns the canonical authority. The existing
 * lagging-dispatch recovery performs all identity/evidence validation while
 * these locks prevent either durable image from changing underneath it.
 */
export async function repairLaggingAcceptedMonitorAuthority(input: {
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  currentMessageId: string;
  ports: LaggingAcceptedMonitorAuthorityRepairPorts;
}): Promise<Conversation> {
  if (!isLegacyEnterDispatchedAuthorityGap(
    input.ports.submission(input.conversation),
    input.currentMessageId
  )) {
    return input.conversation;
  }
  let conversation = input.conversation;
  const releaseTerminal = input.ports.acquireTerminal(input.terminalControl);
  try {
    await input.ports.withWriter(async () => {
      const releaseState = input.ports.acquireState();
      try {
        const current = input.ports.loadConversation();
        if (input.ports.userAbandonmentStatus(current)) {
          conversation = current;
          return;
        }
        const submission = input.ports.submission(current);
        if (!isLegacyEnterDispatchedAuthorityGap(
          submission,
          input.currentMessageId
        )) {
          conversation = current;
          return;
        }
        const ledger = input.ports.loadLedger(input.terminalControl);
        assertLaggingAcceptedAuthorityGap({
          conversation: current,
          ledger,
          messageId: input.currentMessageId
        });
        input.ports.reconcileLedger(input.terminalControl, ledger);
        const repaired = input.ports.loadConversation();
        const repairedLedger = input.ports.loadLedger(input.terminalControl);
        assertRepairedMonitorAuthority({
          conversation: repaired,
          submission: input.ports.submission(repaired),
          ledger: repairedLedger,
          messageId: input.currentMessageId
        });
        conversation = repaired;
      } finally {
        releaseState();
      }
    });
    return conversation;
  } finally {
    releaseTerminal();
  }
}

/** Recover one abandoned prepared receipt while the CLI owns all raw locks. */
export async function recoverPreparedMonitorSubmission(
  input: RecoverPreparedMonitorInput
): Promise<Conversation> {
  let conversation = input.conversation;
  let abandonmentFenced = false;
  const releaseTerminal = input.ports.acquireTerminal(input.terminalControl);
  try {
    await input.ports.withWriter(async () => {
      const releaseState = input.ports.acquireState();
      try {
        const current = input.ports.loadConversation();
        if (input.ports.userAbandonmentStatus(current)) {
          conversation = current;
          abandonmentFenced = true;
          return;
        }
        const ledger = input.ports.loadLedger(input.terminalControl);
        const submission = input.ports.submission(current);
        const takeover = takeoverFor(current);
        if (!isExpectedPrepared(input.currentMessageId, takeover, submission)) {
          conversation = current;
          return;
        }
        const requestText = String(
          takeover?.terminal_bridge_request_text ?? current.user_request ?? ""
        );
        const recovered = recoverFromLedger({
          input,
          current,
          submission: submission!,
          ledger,
          requestText
        });
        conversation = recovered ?? recordUncertainPrepared({
          input,
          current,
          submission: submission!,
          ledger,
          requestText
        });
        input.ports.saveConversation(conversation);
      } finally {
        releaseState();
      }
      if (
        !abandonmentFenced &&
        input.ports.submission(conversation)?.status === "uncertain"
      ) {
        input.ports.stallCollateral({
          terminalControl: input.terminalControl,
          currentConversationId: conversation.conversation_id,
          uncertainMessageId: input.currentMessageId
        });
      }
    });
    return conversation;
  } finally {
    releaseTerminal();
  }
}

function isExpectedPrepared(
  messageId: string,
  takeover: UnknownRecord | undefined,
  submission: UnknownRecord | undefined
): boolean {
  return nonBlankString(takeover?.terminal_bridge_message_id) === messageId &&
    nonBlankString(submission?.message_id) === messageId &&
    submission?.status === "prepared";
}

function isLegacyEnterDispatchedAuthorityGap(
  submission: UnknownRecord | undefined,
  messageId: string
): boolean {
  return Boolean(
    submission?.status === "enter_dispatched" &&
    nonBlankString(submission.message_id) === messageId &&
    !Object.hasOwn(submission, "callback_route_fingerprint")
  );
}

function assertLaggingAcceptedAuthorityGap(input: {
  conversation: Conversation;
  ledger?: UnknownRecord;
  messageId: string;
}): void {
  if (
    input.ledger?.status !== "agent_accepted" ||
    nonBlankString(input.ledger.message_id) !== input.messageId ||
    !Object.hasOwn(input.ledger, "callback_route_fingerprint")
  ) {
    throw new Error(
      "lagging accepted monitor authority no longer owns its exact dispatch ledger"
    );
  }
  const ledgerAuthority = callbackRouteFingerprintFromRecord(input.ledger);
  const conversationAuthority =
    callbackRouteFingerprintForConversation(input.conversation) ?? null;
  if (ledgerAuthority === undefined || ledgerAuthority !== conversationAuthority) {
    throw new Error(
      "lagging accepted monitor authority conflicts with the current callback route"
    );
  }
}

function assertRepairedMonitorAuthority(input: {
  conversation: Conversation;
  submission?: UnknownRecord;
  ledger?: UnknownRecord;
  messageId: string;
}): void {
  if (
    input.submission?.status !== "agent_accepted" ||
    nonBlankString(input.submission.message_id) !== input.messageId ||
    input.ledger?.status !== "agent_accepted" ||
    nonBlankString(input.ledger.message_id) !== input.messageId
  ) {
    throw new Error(
      "lagging accepted monitor authority recovery did not converge"
    );
  }
  const stateAuthority = callbackRouteFingerprintFromRecord(input.submission);
  const ledgerAuthority = callbackRouteFingerprintFromRecord(input.ledger);
  const conversationAuthority =
    callbackRouteFingerprintForConversation(input.conversation) ?? null;
  if (
    stateAuthority === undefined ||
    ledgerAuthority === undefined ||
    stateAuthority !== conversationAuthority ||
    ledgerAuthority !== conversationAuthority
  ) {
    throw new Error(
      "lagging accepted monitor authority recovery did not converge"
    );
  }
}

function recoverFromLedger(input: {
  input: RecoverPreparedMonitorInput;
  current: Conversation;
  submission: UnknownRecord;
  ledger?: UnknownRecord;
  requestText: string;
}): Conversation | undefined {
  const { ledger } = input;
  if (
    !ledger ||
    !["submitted", "agent_accepted"].includes(String(ledger.status)) ||
    nonBlankString(ledger.message_id) !== input.input.currentMessageId
  ) {
    return undefined;
  }
  const at = nonBlankString(ledger.agent_accepted_at) ??
    nonBlankString(ledger.submitted_at) ?? input.input.ports.now().toISOString();
  const agentAccepted = ledger.status === "agent_accepted";
  const recovered = input.input.ports.applySubmission({
    conversation: input.current,
    messageId: input.input.currentMessageId,
    requestText: input.requestText,
    status: agentAccepted ? "agent_accepted" : "submitted",
    preparedAt: nonBlankString(input.submission.prepared_at) ?? at,
    ...(agentAccepted
      ? {
          agentAcceptedAt: at,
          acceptanceEvidence: ledger.acceptance_evidence as
            TerminalSubmissionAcceptanceEvidence | undefined
        }
      : { submittedAt: at })
  });
  const callbackRouteLedgerFields = callbackRouteFingerprintLedgerFields({
    receipt: input.input.ports.submission(recovered),
    ledger,
    context: "prepared monitor recovery"
  });
  if (
    Object.hasOwn(callbackRouteLedgerFields, "callback_route_fingerprint") &&
    !Object.hasOwn(ledger, "callback_route_fingerprint")
  ) {
    // Ledger first makes an interrupted state write recoverable: the prepared
    // Turn can replay this exact authority on the next monitor invocation.
    input.input.ports.saveLedger(input.input.terminalControl, {
      ...ledger,
      ...callbackRouteLedgerFields
    });
  }
  return recovered;
}

function recordUncertainPrepared(input: {
  input: RecoverPreparedMonitorInput;
  current: Conversation;
  submission: UnknownRecord;
  ledger?: UnknownRecord;
  requestText: string;
}): Conversation {
  const at = input.input.ports.now().toISOString();
  const conversation = input.input.ports.applySubmission({
    conversation: {
      ...input.current,
      status: "stalled",
      stalled_at: at,
      stalled_reason:
        "terminal dispatcher exited before AKK could prove the terminal submission",
      updated_at: at
    },
    messageId: input.input.currentMessageId,
    requestText: input.requestText,
    status: "uncertain",
    preparedAt: nonBlankString(input.submission.prepared_at) ?? at,
    uncertainAt: at,
    error:
      "the terminal dispatcher exited before AKK could persist a submitted receipt"
  });
  saveUncertainLedger(input, conversation, at);
  input.input.ports.appendEvent({
    ts: at,
    conversation_id: conversation.conversation_id,
    event: "terminal_message_submit_uncertain",
    message_id: input.input.currentMessageId,
    reason: "dispatcher_exited_before_submitted_receipt",
    dispatcher_pid: validDispatcherPid(input.input.dispatcherPid),
    do_not_retry: true
  });
  return conversation;
}

function saveUncertainLedger(
  input: Parameters<typeof recordUncertainPrepared>[0],
  conversation: Conversation,
  at: string
): void {
  if (
    input.ledger &&
    nonBlankString(input.ledger.message_id) !== input.input.currentMessageId
  ) {
    return;
  }
  input.input.ports.saveLedger(input.input.terminalControl, {
    ...(input.ledger ?? {}),
    status: "uncertain",
    generation_id: input.input.currentMessageId,
    conversation_id: conversation.conversation_id,
    message_id: input.input.currentMessageId,
    request_hash: input.input.ports.requestFingerprint(input.requestText),
    prepared_at: nonBlankString(input.submission.prepared_at) ?? at,
    uncertain_at: at,
    dispatcher_pid: validDispatcherPid(input.input.dispatcherPid),
    state_path: input.input.statePath,
    event_log_path: input.input.logPath,
    callback_expected: callbackExpectedForConversation(conversation),
    reason: "dispatcher_exited_before_submitted_receipt"
  });
}

const validDispatcherPid = (pid: number): number | null =>
  Number.isSafeInteger(pid) && pid > 1 ? pid : null;

export interface MonitorPollAdapterPorts {
  acquireTerminal(control: TerminalControlRef): Release;
  reconcileLedger(
    control: TerminalControlRef,
    ledger?: UnknownRecord
  ): UnknownRecord | undefined;
  loadLedger(control: TerminalControlRef): UnknownRecord | undefined;
  saveLedger(control: TerminalControlRef, ledger: UnknownRecord): void;
  submission(conversation: Conversation): UnknownRecord | undefined;
  loadConversation(): Conversation;
  userAbandonmentStatus(
    conversation: Conversation
  ): MonitorUserAbandonmentStatus | undefined;
  terminalControl(conversation: Conversation): TerminalControlRef | undefined;
  sameIncarnation(left: TerminalControlRef, right: TerminalControlRef): boolean;
  runtime(
    conversation: Conversation,
    control: TerminalControlRef
  ): TerminalRuntimeIdentity;
  durableRequest(
    conversation: Conversation,
    control: TerminalControlRef
  ): TerminalDurableCompletionRequest;
  appendEvent(event: EventRecord): void;
  now(): Date;
}

export async function reconcileMonitorAcceptance(
  input: {
    terminalControl: TerminalControlRef;
    acquireTerminal(control: TerminalControlRef): Release;
    reconcile(): Promise<MonitorSubmissionReconciliation>;
    apply(
      reconciliation: MonitorSubmissionReconciliation
    ): "continue" | "finished" | "pending";
    recover(error: unknown): "continue" | "finished";
  }
): Promise<"continue" | "finished" | "pending"> {
  const release = input.acquireTerminal(input.terminalControl);
  try {
    try {
      return input.apply(await input.reconcile());
    } catch (error) {
      return input.recover(error);
    }
  } finally {
    release();
  }
}

export async function pollTerminalMonitor(input: {
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  currentMessageId?: string;
  executor: Executor;
  screenChangedSinceSend: boolean;
  scrollbackLines: number;
  terminalBridge: TerminalAgentBridge;
  onFenced(ledgerStatus?: string): void;
  ports: MonitorPollAdapterPorts;
}): Promise<MonitorPollResult> {
  const release = input.ports.acquireTerminal(input.terminalControl);
  try {
    const current = input.ports.loadConversation();
    const abandonmentStatus = input.ports.userAbandonmentStatus(current);
    if (abandonmentStatus) {
      input.onFenced(abandonmentStatus);
      return { kind: "fenced", ledgerStatus: abandonmentStatus };
    }
    const ledger = repairPollLedger(input);
    const ledgerStatus = nonBlankString(ledger?.status);
    const ledgerMessageId = nonBlankString(ledger?.message_id);
    if (ledger && (
      !["submitted", "agent_accepted"].includes(ledgerStatus ?? "") ||
      ledgerMessageId !== input.currentMessageId
    )) {
      input.ports.appendEvent({
        ts: input.ports.now().toISOString(),
        conversation_id: input.conversation.conversation_id,
        event: "terminal_bridge_monitor_dispatch_fenced",
        monitor_message_id: input.currentMessageId,
        dispatch_message_id: ledgerMessageId,
        dispatch_status: ledgerStatus
      });
      input.onFenced(ledgerStatus);
      return { kind: "fenced", ledgerStatus };
    }
    return await pollFreshConversation(input);
  } finally {
    release();
  }
}

function repairPollLedger(
  input: Parameters<typeof pollTerminalMonitor>[0]
): UnknownRecord | undefined {
  let ledger = input.ports.reconcileLedger(
    input.terminalControl,
    input.ports.loadLedger(input.terminalControl)
  );
  const submission = input.ports.submission(input.conversation);
  if (
    ledger?.status !== "prepared" ||
    nonBlankString(ledger.message_id) !== input.currentMessageId ||
    !submission ||
    !["submitted", "agent_accepted"].includes(String(submission.status)) ||
    nonBlankString(submission.message_id) !== input.currentMessageId
  ) {
    return ledger;
  }
  const at = nonBlankString(submission.agent_accepted_at) ??
    nonBlankString(submission.submitted_at) ?? input.ports.now().toISOString();
  const callbackRouteLedgerFields = callbackRouteFingerprintLedgerFields({
    receipt: submission,
    ledger,
    context: "terminal monitor poll recovery"
  });
  input.ports.saveLedger(input.terminalControl, {
    ...ledger,
    status: submission.status,
    ...(submission.status === "agent_accepted"
      ? {
          agent_accepted_at: at,
          acceptance_evidence: submission.acceptance_evidence
        }
      : { submitted_at: at }),
    ...callbackRouteLedgerFields,
    reason: "recovered from the durable conversation submission receipt"
  });
  ledger = input.ports.loadLedger(input.terminalControl);
  return ledger;
}

async function pollFreshConversation(
  input: Parameters<typeof pollTerminalMonitor>[0]
): Promise<MonitorPollResult> {
  const locked = input.ports.loadConversation();
  const takeover = takeoverFor(locked);
  const lockedControl = input.ports.terminalControl(locked);
  if (
    locked.status !== input.conversation.status ||
    locked.updated_at !== input.conversation.updated_at ||
    nonBlankString(takeover?.terminal_bridge_message_id) !==
      input.currentMessageId ||
    !lockedControl ||
    !input.ports.sameIncarnation(lockedControl, input.terminalControl)
  ) {
    return { kind: "retry", conversation: locked };
  }
  const requestText = String(
    takeover?.terminal_bridge_request_text ?? locked.user_request ?? ""
  );
  const poll = await input.terminalBridge.monitorPoll({
    agent: input.executor.kind,
    terminalControl: input.terminalControl,
    screenOptions: {
      scrollbackLines: input.scrollbackLines,
      requestText,
      screenChangedSinceSend: input.screenChangedSinceSend,
      runtime: input.ports.runtime(locked, input.terminalControl)
    },
    durableRequest: input.ports.durableRequest(locked, input.terminalControl)
  });
  return { kind: "observed", poll };
}

export interface ApprovalNotificationAdapterPorts {
  record(input: {
    terminalControl: TerminalControlRef;
    terminalStatus: TerminalBridgeStatus;
    fingerprint?: string;
    expectedConversation: {
      conversationId: string;
      status: ConversationStatus;
      updatedAt: string;
      messageId?: string;
    };
    onRecorded(
      conversation: Conversation,
      context?: { recoverMissingOutbox?: boolean }
    ): MonitorApprovalCallbackRecord;
  }): MonitorApprovalNotificationResult;
  prepare(input: {
    conversation: Conversation;
    actor: Executor["actor"];
    type: "question" | "blocked";
    body: string;
    metadata: UnknownRecord;
    recoverMissingOutbox: boolean;
  }): MonitorApprovalCallbackRecord;
  approvalInstructions(input: {
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    terminalStatus: TerminalBridgeStatus;
  }): string;
  approvalCandidate(input: {
    executorKind: Executor["kind"];
    terminalControl: TerminalControlRef;
    terminalStatus: TerminalBridgeStatus;
    fingerprint?: string;
  }): UnknownRecord | undefined;
}

export function recordMonitorApprovalNotification(input: {
  conversation: Conversation;
  executor: Executor;
  terminalControl: TerminalControlRef;
  terminalStatus: TerminalBridgeStatus;
  currentMessageId?: string;
  fingerprint?: string;
  kind: "question" | "error";
  reason?: string;
  ports: ApprovalNotificationAdapterPorts;
}): MonitorApprovalNotificationResult {
  const question = input.kind === "question";
  return input.ports.record({
    terminalControl: input.terminalControl,
    terminalStatus: input.terminalStatus,
    fingerprint: input.fingerprint,
    expectedConversation: {
      conversationId: input.conversation.conversation_id,
      status: input.conversation.status,
      updatedAt: input.conversation.updated_at,
      messageId: input.currentMessageId
    },
    onRecorded: (conversation, context) => input.ports.prepare({
      conversation,
      actor: input.executor.actor,
      type: question ? "question" : "blocked",
      body: approvalBody(input, conversation),
      metadata: approvalMetadata(input, conversation),
      recoverMissingOutbox: context?.recoverMissingOutbox === true
    })
  });
}

function approvalBody(
  input: Parameters<typeof recordMonitorApprovalNotification>[0],
  conversation: Conversation
): string {
  if (input.kind === "question") {
    return input.ports.approvalInstructions({
      conversation,
      terminalControl: input.terminalControl,
      terminalStatus: input.terminalStatus
    });
  }
  return [
    `${input.executor.display_name} is waiting at a permission state that AKK cannot safely approve.`,
    input.reason,
    "",
    `Conversation: ${conversation.conversation_id}`,
    `Terminal: ${input.terminalControl.target}`,
    "Review and resolve this dialog in the terminal manually. AKK intentionally sends no key when the request identity cannot be revalidated."
  ].join("\n");
}

function approvalMetadata(
  input: Parameters<typeof recordMonitorApprovalNotification>[0],
  conversation: Conversation
): UnknownRecord {
  const base = {
    source: "terminal_bridge",
    reason: input.kind === "question"
      ? "approval_required"
      : "approval_not_approvable",
    terminal_control: input.terminalControl,
    terminal_status: input.terminalStatus,
    approval_fingerprint: input.fingerprint
  };
  return input.kind === "error" ? base : {
    ...base,
    approval_candidate: input.ports.approvalCandidate({
      executorKind: input.executor.kind,
      terminalControl: input.terminalControl,
      terminalStatus: input.terminalStatus,
      fingerprint: input.fingerprint
    }),
    approve_command:
      `AKK approve ${conversation.conversation_id}`,
    deny_command: `AKK cancel ${conversation.conversation_id}`,
    approve_tool: "agent_knock_knock_approve",
    deny_tool: "agent_knock_knock_cancel"
  };
}

export function presentTerminalMonitor(
  result: TerminalMonitorPresentation,
  write: (value: UnknownRecord) => void
): void {
  const base = {
    conversation: result.conversation,
    monitored: true,
    terminal_bridge: true
  };
  switch (result.kind) {
    case "generation_replaced":
    case "conversation_no_longer_waiting":
    case "task_replaced":
    case "submission_status_invalid":
      write({
        ...base,
        completed: false,
        reason: simplePresentationReason(result.kind)
      });
      return;
    case "stalled":
      write({
        ...base,
        stalled: true,
        ...(result.hardTimeout ? { hard_timeout: true } : {}),
        reason: result.reason
      });
      return;
    case "submission_uncertain":
      write({
        ...base,
        completed: false,
        submission_outcome: "uncertain",
        ...(result.deliveryReceipt
          ? { delivery_receipt: result.deliveryReceipt }
          : {}),
        do_not_retry: true,
        reason: result.reason
      });
      return;
    case "submission_not_accepted":
      write({
        ...base,
        completed: false,
        submission_outcome: "not_accepted",
        delivery_receipt: "enter_dispatched",
        do_not_retry: true,
        reason: "the exact managed draft remains in the terminal composer"
      });
      return;
    case "submission_terminal":
      write({
        ...base,
        completed: false,
        submission_outcome: result.status,
        do_not_retry: !result.safeToRetry,
        safe_to_retry: result.safeToRetry,
        reason: terminalSubmissionReason(result.status, result.safeToRetry)
      });
      return;
    case "submission_unproven":
      write({
        ...base,
        completed: false,
        submission_outcome: result.status,
        do_not_retry: true,
        reason:
          "terminal submission outcome is not proven; inspect the shared terminal pane before deciding how to continue"
      });
      return;
    case "dispatch_fenced":
      write({
        ...base,
        completed: false,
        submission_outcome:
          result.ledgerStatus === "uncertain" ? "uncertain" : undefined,
        do_not_retry: result.ledgerStatus === "uncertain",
        reason: ["prepared", "uncertain"].includes(result.ledgerStatus ?? "")
          ? "terminal_dispatch_not_proven"
          : "terminal_bridge_generation_replaced"
      });
      return;
    case "approval_duplicate":
    case "approval_gateway_missing":
      presentApproval(result, write, base);
      return;
    case "completion_duplicate":
      write({ ...base, completed: false, duplicate: true, reason: result.reason });
      return;
    case "binding_superseded":
      write({
        ...base,
        completed: false,
        reason: "session_binding_superseded",
        detail: result.detail
      });
  }
}

function presentApproval(
  result: Extract<TerminalMonitorPresentation, {
    kind: "approval_duplicate" | "approval_gateway_missing";
  }>,
  write: (value: UnknownRecord) => void,
  base: UnknownRecord
): void {
  write({
    ...base,
    awaiting_approval: true,
    ...(!result.approvable ? { approvable: false } : {}),
    ...(result.kind === "approval_duplicate"
      ? {
          duplicate: true,
          ...(!result.approvable ? { reason: result.reason } : {})
        }
      : {
          delivered: false,
          message: result.callbackMessage,
          reason: "gateway_method_missing"
        }),
    terminal_control: result.terminalControl,
    terminal_status: result.terminalStatus
  });
}

function simplePresentationReason(
  kind: "generation_replaced" | "conversation_no_longer_waiting" |
    "task_replaced" | "submission_status_invalid"
): string {
  return {
    generation_replaced: "terminal_bridge_generation_replaced",
    conversation_no_longer_waiting: "conversation_no_longer_waiting",
    task_replaced: "terminal_bridge_task_replaced",
    submission_status_invalid: "terminal_submission_status_invalid"
  }[kind];
}

function terminalSubmissionReason(status: string, safeToRetry: boolean): string {
  if (status === "not_accepted") {
    return "the exact terminal draft was not accepted; automatic retry is disabled";
  }
  if (status === "uncertain") {
    return "terminal submission outcome is uncertain; automatic completion and approval attribution are disabled";
  }
  return safeToRetry
    ? "terminal submission was durably aborted before terminal input"
    : "terminal submission was aborted but safe retry was not durably proven";
}

function takeoverFor(conversation: Conversation): UnknownRecord | undefined {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
}
