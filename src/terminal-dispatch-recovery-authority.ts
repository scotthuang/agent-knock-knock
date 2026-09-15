import path from "node:path";

import { canonicalJson } from "./canonical-json.js";
import type { PreparedCallback } from "./callback-outbox-service.js";
import { callbackExpectedForConversation,
  callbackRouteFingerprintFromRecord } from "./callback-route-authority.js";
import { loadDeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import { executorForConversation, sessionIdForConversation,
  turnIdForConversation, type Conversation } from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import { terminalEndpointFromControlRef } from "./terminal-control-ref.js";
import { sameCanonicalStatePath, terminalDispatchLedgerLooksLifecycle,
  terminalDispatchReceiptHistory,
  type TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import type { TerminalDispatchRepositoryCliAdapter } from
  "./terminal-dispatch-repository-cli-adapter.js";
import { type LocalCompletionRecoveryResult,
  type TerminalBindingLedgerFacts,
  type TerminalSubmissionRecoveryFacts,
  type VerifiedDeadRecoveryResult } from
  "./terminal-dispatch-recovery-service.js";
import { terminalAcceptanceEvidenceForConversation,
  terminalBridgeRequestFingerprint, terminalBridgeSubmission,
  terminalBridgeSubmissionReceipts } from "./terminal-dispatch-receipt.js";
import type { TerminalSubmissionAcceptanceEvidence } from
  "./terminal-submission-facts.js";
import { decideAcceptedTurnDeadAgentStall } from
  "./verified-dead-agent-policy.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export interface VerifiedDeadDispatchRequest {
  terminalControl: TerminalControlRef;
  conversation: Conversation;
  storeDir: string;
  statePath: string;
  logPath: string;
  expectedMessageId: string;
}

export function submissionFacts(value: unknown):
TerminalSubmissionRecoveryFacts {
  const submission = isRecord(value) ? value : undefined;
  return {
    status: nonBlankString(submission?.status),
    messageId: nonBlankString(submission?.message_id),
    preparedAt: nonBlankString(submission?.prepared_at),
    textInjectedAt: nonBlankString(submission?.text_injected_at),
    enterDispatchedAt: nonBlankString(submission?.enter_dispatched_at),
    submittedAt: nonBlankString(submission?.submitted_at),
    agentAcceptedAt: nonBlankString(submission?.agent_accepted_at),
    notAcceptedAt: nonBlankString(submission?.not_accepted_at),
    uncertainAt: nonBlankString(submission?.uncertain_at),
    abortedAt: nonBlankString(submission?.aborted_at),
    lastProvenStage: nonBlankString(submission?.last_proven_stage),
    callbackRouteFingerprint:
      callbackRouteFingerprintFromRecord(submission),
    acceptanceEvidence: submission?.acceptance_evidence as
      TerminalSubmissionAcceptanceEvidence | undefined
  };
}

export function bindingCompatible(
  ledger: TerminalDispatchLedgerDocument,
  binding: TerminalBindingLedgerFacts
): boolean {
  for (const key of [
    "binding_id",
    "binding_generation",
    "native_thread_id",
    "store_dir"
  ] as const) {
    if (
      ledger[key] !== undefined && binding[key] !== undefined &&
      String(ledger[key]) !== String(binding[key])
    ) return false;
  }
  return true;
}

export function acceptanceProjection(
  conversation: Conversation,
  requestText: string,
  ledgerStatus: string,
  submission: TerminalDispatchLedgerDocument | undefined,
  ledger: TerminalDispatchLedgerDocument
): {
  state?: TerminalSubmissionAcceptanceEvidence;
  ledger?: TerminalSubmissionAcceptanceEvidence;
  ledgerError?: string;
} {
  let state: TerminalSubmissionAcceptanceEvidence | undefined;
  if (submission?.status === "agent_accepted") {
    try {
      state = terminalAcceptanceEvidenceForConversation(
        conversation,
        requestText,
        submission.acceptance_evidence
      );
    } catch {
      state = undefined;
    }
  }
  let durable: TerminalSubmissionAcceptanceEvidence | undefined;
  let ledgerError: string | undefined;
  if (ledgerStatus === "agent_accepted") {
    try {
      durable = terminalAcceptanceEvidenceForConversation(
        conversation,
        requestText,
        ledger.acceptance_evidence
      );
    } catch (error) {
      ledgerError = error instanceof Error ? error.message : String(error);
    }
  }
  return { state, ledger: durable, ledgerError };
}

export function acceptedTurnCanBeStalled(
  storeDir: string,
  conversation: Conversation
): boolean {
  const takeover = takeoverFor(conversation);
  const submission = terminalBridgeSubmission(conversation);
  const messageId = nonBlankString(takeover?.terminal_bridge_message_id);
  const transferId = nonBlankString(takeover?.deferred_foreground_transfer_id);
  const base = {
    conversationStatus: conversation.status,
    terminalBridge: takeover?.terminal_bridge === true,
    messageId,
    submissionStatus: nonBlankString(submission?.status),
    submissionMessageId: nonBlankString(submission?.message_id),
    deferredTransferId: transferId
  };
  const decision = decideAcceptedTurnDeadAgentStall(base);
  if (decision.status !== "requires_deferred_transfer") {
    return decision.status === "applicable";
  }
  const transfer = loadDeferredForegroundTransfer(storeDir, decision.transferId);
  return decideAcceptedTurnDeadAgentStall({
    ...base,
    deferredTransferStatus: transfer.status
  }).status === "applicable";
}

export function unchangedVerifiedDead(
  conversation: Conversation,
  reason: string
): VerifiedDeadRecoveryResult<PreparedCallback> {
  return { stalled: false, conversation, reason };
}

export function localNotApplicable(): LocalCompletionRecoveryResult {
  return {
    handled: false,
    recovered: false,
    reason: "local_completion_not_applicable"
  };
}

export function takeoverFor(conversation: Conversation) {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
}

export function completionClaim(conversation: Conversation) {
  const takeover = takeoverFor(conversation);
  return isRecord(takeover?.terminal_bridge_completion_claim)
    ? takeover.terminal_bridge_completion_claim
    : undefined;
}

export function processDisposition(
  conversation: Conversation | Record<string, any>
) {
  return isRecord(conversation.terminal_agent_process_disposition)
    ? conversation.terminal_agent_process_disposition
    : undefined;
}

export function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function required<Value>(
  value: Value | null | undefined,
  message: string
): Value {
  if (value === undefined || value === null || value === "") {
    throw new Error(message);
  }
  return value;
}

export function acceptedDispatchExpectation(
  input: VerifiedDeadDispatchRequest,
  takeover: Record<string, unknown> | undefined,
  submission: TerminalDispatchLedgerDocument | undefined
) {
  const conversation = input.conversation;
  return {
    requestText: String(
      takeover?.terminal_bridge_request_text ?? conversation.user_request ?? ""
    ),
    sessionId: sessionIdForConversation(conversation),
    turnId: turnIdForConversation(conversation),
    bindingId: nonBlankString(conversation.terminal_binding_id),
    bindingGeneration: Number(conversation.terminal_binding_generation),
    nativeThreadId: nonBlankString(conversation.native_thread_id) ??
      nonBlankString(takeover?.terminal_agent_session_id),
    endpointAnchor: terminalEndpointFromControlRef(
      input.terminalControl
    ).processAnchorPid,
    submission
  };
}

export function stateDispatchCoreAuthorityExact(
  input: VerifiedDeadDispatchRequest,
  submission: TerminalDispatchLedgerDocument | undefined,
  expected: ReturnType<typeof acceptedDispatchExpectation>
): boolean {
  const requestHash = terminalBridgeRequestFingerprint(expected.requestText);
  const takeover = takeoverFor(input.conversation);
  return Boolean(
    input.expectedMessageId &&
    nonBlankString(takeover?.terminal_bridge_message_id) ===
      input.expectedMessageId &&
    submission?.status === "agent_accepted" &&
    nonBlankString(submission.message_id) === input.expectedMessageId &&
    nonBlankString(submission.session_id) === expected.sessionId &&
    nonBlankString(submission.turn_id) === expected.turnId &&
    nonBlankString(submission.binding_id) === expected.bindingId &&
    Number(submission.binding_generation) === expected.bindingGeneration &&
    requestHash && nonBlankString(submission.request_hash) === requestHash &&
    expected.bindingId && Number.isSafeInteger(expected.bindingGeneration) &&
    expected.bindingGeneration >= 1 && expected.nativeThreadId &&
    Number.isSafeInteger(expected.endpointAnchor) &&
    Number(expected.endpointAnchor) >= 1 &&
    sameCanonicalStatePath(input.conversation.state_path, input.statePath) &&
    path.resolve(nonBlankString(input.conversation.event_log_path) ?? "") ===
      path.resolve(input.logPath)
  );
}

export function stateDispatchReceiptAuthorityExact(
  input: VerifiedDeadDispatchRequest,
  submission: TerminalDispatchLedgerDocument | undefined
): boolean {
  const takeover = takeoverFor(input.conversation);
  const rawHistory = takeover?.terminal_bridge_submission_receipts;
  const rawReceipts = Array.isArray(rawHistory)
    ? rawHistory.filter((receipt) => isRecord(receipt) &&
        nonBlankString(receipt.message_id) === input.expectedMessageId)
    : [];
  const validatedReceipts = terminalBridgeSubmissionReceipts(
    input.conversation
  ).filter((receipt) =>
    nonBlankString(receipt.message_id) === input.expectedMessageId
  );
  return Boolean(
    Array.isArray(rawHistory) && rawReceipts.length === 1 &&
    validatedReceipts.length === 1 &&
    canonicalJson(rawReceipts[0]) === canonicalJson(submission) &&
    canonicalJson(validatedReceipts[0]) === canonicalJson(submission)
  );
}

export function ledgerDispatchCoreAuthorityExact(
  input: VerifiedDeadDispatchRequest,
  ledger: TerminalDispatchLedgerDocument | undefined,
  expected: ReturnType<typeof acceptedDispatchExpectation>,
  repository: TerminalDispatchRepositoryCliAdapter
): boolean {
  return Boolean(
    ledger && !terminalDispatchLedgerLooksLifecycle(ledger) &&
    ["agent_accepted", "resolved"].includes(String(ledger.status)) &&
    ledgerDispatchRecordMatches(
      input,
      ledger,
      expected,
      repository,
      ledger.status === "resolved" ? "resolved" : "agent_accepted"
    ) &&
    (ledger.status !== "resolved" ||
      validTimestamp(nonBlankString(ledger.resolved_at) ?? ""))
  );
}

export function ledgerDispatchReceiptAuthority(
  input: VerifiedDeadDispatchRequest,
  ledger: TerminalDispatchLedgerDocument,
  expected: ReturnType<typeof acceptedDispatchExpectation>,
  repository: TerminalDispatchRepositoryCliAdapter
): { exact: boolean; receipt?: TerminalDispatchLedgerDocument } {
  const rawHistory = ledger.terminal_submission_receipts;
  const rawReceipts = Array.isArray(rawHistory)
    ? rawHistory.filter((receipt) => isRecord(receipt) &&
        nonBlankString(receipt.message_id) === input.expectedMessageId)
    : [];
  const validated = terminalDispatchReceiptHistory(ledger).filter((receipt) =>
    nonBlankString(receipt.message_id) === input.expectedMessageId
  );
  const receipt = rawReceipts[0];
  return {
    exact: Boolean(
      rawReceipts.length === 1 && validated.length === 1 &&
      canonicalJson(rawReceipts[0]) === canonicalJson(validated[0]) &&
      ledgerDispatchRecordMatches(
        input,
        receipt,
        expected,
        repository,
        "agent_accepted"
      )
    ),
    receipt
  };
}

function ledgerDispatchRecordMatches(
  input: VerifiedDeadDispatchRequest,
  record: TerminalDispatchLedgerDocument | undefined,
  expected: ReturnType<typeof acceptedDispatchExpectation>,
  repository: TerminalDispatchRepositoryCliAdapter,
  status: "agent_accepted" | "resolved"
): boolean {
  const requestHash = terminalBridgeRequestFingerprint(expected.requestText);
  return Boolean(record &&
    record.status === status &&
    nonBlankString(record.generation_id) === input.expectedMessageId &&
    nonBlankString(record.conversation_id) ===
      input.conversation.conversation_id &&
    nonBlankString(record.session_id) === expected.sessionId &&
    nonBlankString(record.turn_id) === expected.turnId &&
    nonBlankString(record.message_id) === input.expectedMessageId &&
    nonBlankString(record.request_hash) === requestHash &&
    sameCanonicalStatePath(record.state_path, input.statePath) &&
    path.resolve(nonBlankString(record.store_dir) ?? "") ===
      path.resolve(input.storeDir) &&
    path.resolve(nonBlankString(record.event_log_path) ?? "") ===
      path.resolve(input.logPath) &&
    nonBlankString(record.binding_id) === expected.bindingId &&
    Number(record.binding_generation) === expected.bindingGeneration &&
    nonBlankString(record.native_thread_id) === expected.nativeThreadId &&
    nonBlankString(record.executor_kind) ===
      executorForConversation(input.conversation).kind &&
    (nonBlankString(record.openclaw_session) ?? undefined) ===
      (nonBlankString(input.conversation.openclaw_session) ?? undefined) &&
    Boolean(record.callback_expected) ===
      callbackExpectedForConversation(input.conversation) &&
    (nonBlankString(record.message_type) ?? undefined) ===
      (nonBlankString(expected.submission?.message_type) ?? undefined) &&
    (nonBlankString(record.message_body_hash) ?? undefined) ===
      (nonBlankString(expected.submission?.message_body_hash) ?? undefined) &&
    isRecord(record.terminal_endpoint) &&
    repository.matchesControl(record, input.terminalControl, {
      requireProcessAnchor: true
    }) &&
    repository.processAnchor(record) === expected.endpointAnchor
  );
}

export function stateDispatchAuthorityError(conversationId: string): Error {
  return new Error(
    `verified-dead Turn ${conversationId} has no exact accepted submission authority`
  );
}

export function ledgerDispatchAuthorityError(conversationId: string): Error {
  return new Error(
    `verified-dead Turn ${conversationId} no longer owns one exact terminal dispatch receipt`
  );
}

export function acceptanceAgreement(
  conversation: Conversation,
  requestText: string,
  stateValue: unknown,
  ledgerValue: unknown,
  receiptValue: unknown
): { status: "valid"; allEqual: boolean } |
{ status: "invalid"; reason: string } {
  try {
    const state = terminalAcceptanceEvidenceForConversation(
      conversation, requestText, stateValue
    );
    const ledger = terminalAcceptanceEvidenceForConversation(
      conversation, requestText, ledgerValue
    );
    const receipt = terminalAcceptanceEvidenceForConversation(
      conversation, requestText, receiptValue
    );
    return {
      status: "valid",
      allEqual: canonicalJson(state) === canonicalJson(ledger) &&
        canonicalJson(state) === canonicalJson(receipt)
    };
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
