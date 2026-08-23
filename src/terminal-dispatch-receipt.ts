import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { callbackRouteFingerprintForConversation } from
  "./callback-route-authority.js";
import {
  executorForConversation,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalControlEvidence
} from "./terminal-control-ref.js";
import type { TerminalOrdinaryDispatchStatus } from
  "./terminal-dispatch-ledger-codec.js";
import {
  terminalBridgeSubmission,
  validateTerminalSubmissionAcceptanceEvidence,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-facts.js";
import {
  isRecord,
  nonBlankString,
  type UnknownRecord
} from "./value-guards.js";

export interface TerminalBridgeStateInput {
  conversation: Conversation;
  message: { id: string };
  requestText: string;
  startedAt: string;
  agentTimeoutMinutes: number;
  agentHardTimeoutMinutes: number;
  monitorLockVersion: number;
  preSendScreenFingerprint?: string;
  codexRolloutAcceptanceAnchor?: unknown;
  claudeTranscriptAnchor?: unknown;
  claudeHome?: string;
}

export interface TerminalBridgeSubmissionMutation {
  conversation: Conversation;
  messageId: string;
  messageType?: "task" | "answer";
  messageBody?: string;
  requestText: string;
  status: TerminalOrdinaryDispatchStatus;
  preparedAt: string;
  textInjectedAt?: string;
  enterDispatchedAt?: string;
  /** Structured bridge proof that no Enter key call began for this generation. */
  enterNotAttemptedAt?: string;
  enterNotAttemptedReason?: "pre_key_failure";
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

export interface TerminalBridgeSubmissionContext {
  dispatcherPid: number;
  storeDir?: string;
  terminalControl?: TerminalControlRef;
}

export function withTerminalBridgeState({
  conversation,
  message,
  requestText,
  startedAt,
  agentTimeoutMinutes,
  agentHardTimeoutMinutes,
  monitorLockVersion,
  preSendScreenFingerprint,
  codexRolloutAcceptanceAnchor,
  claudeTranscriptAnchor,
  claudeHome
}: TerminalBridgeStateInput): Conversation {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
  return {
    ...conversation,
    native_session_takeover: {
      ...takeover,
      terminal_bridge: true,
      terminal_bridge_started_at: startedAt,
      terminal_bridge_message_id: message.id,
      terminal_bridge_request_text: requestText,
      terminal_bridge_request_hash: terminalBridgeRequestFingerprint(requestText),
      terminal_bridge_pre_send_screen_fingerprint: preSendScreenFingerprint,
      codex_rollout_acceptance_anchor: codexRolloutAcceptanceAnchor,
      claude_transcript_anchor: claudeTranscriptAnchor,
      claude_home: claudeHome,
      terminal_bridge_completion_claim: undefined,
      terminal_bridge_approval_dispatch: undefined,
      terminal_bridge_detector_diagnostic: undefined,
      terminal_bridge_monitor_lock_version: monitorLockVersion,
      terminal_bridge_monitor_started_at: startedAt,
      terminal_bridge_last_activity_at: startedAt,
      terminal_bridge_inactivity_timeout_minutes: agentTimeoutMinutes,
      terminal_bridge_hard_timeout_minutes: agentHardTimeoutMinutes,
      terminal_bridge_inactivity_deadline_at: deadlineAt(
        startedAt,
        agentTimeoutMinutes
      ),
      terminal_bridge_hard_deadline_at: deadlineAt(
        startedAt,
        agentHardTimeoutMinutes
      )
    },
    updated_at: startedAt
  };
}

export function applyTerminalBridgeSubmission(
  mutation: TerminalBridgeSubmissionMutation,
  context: TerminalBridgeSubmissionContext
): Conversation {
  const {
    conversation,
    messageId,
    messageType,
    messageBody,
    requestText,
    status,
    preparedAt,
    textInjectedAt,
    enterDispatchedAt,
    enterNotAttemptedAt,
    enterNotAttemptedReason,
    agentAcceptedAt,
    notAcceptedAt,
    submittedAt,
    uncertainAt,
    abortedAt,
    error,
    acceptanceEvidence,
    lastProvenStage,
    safeToRetry
  } = mutation;
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
  const previousSubmission = isRecord(takeover.terminal_bridge_submission)
    ? takeover.terminal_bridge_submission
    : undefined;
  const storedReceipts = storedTerminalBridgeSubmissionReceipts(takeover);
  const storedReceiptIds = new Set(
    storedReceipts.map((receipt) => String(receipt.message_id))
  );
  const previousSubmissionId = nonBlankString(previousSubmission?.message_id);
  const previousReceipts = previousSubmissionId &&
      !storedReceiptIds.has(previousSubmissionId)
    ? [...storedReceipts, previousSubmission as UnknownRecord]
    : storedReceipts;
  const matchingReceipts = previousReceipts.filter(
    (receipt) => nonBlankString(receipt.message_id) === messageId
  );
  if (matchingReceipts.length > 1) {
    throw new Error(`terminal submission receipt ${messageId} is duplicated`);
  }
  const previousReceipt = matchingReceipts[0];
  const previousGenerationSubmission = previousSubmissionId === messageId
    ? previousSubmission
    : undefined;
  if (
    previousReceipt &&
    previousGenerationSubmission &&
    canonicalJson(previousReceipt) !== canonicalJson(previousGenerationSubmission)
  ) {
    throw new Error(
      `terminal submission receipt ${messageId} conflicts with its current generation`
    );
  }
  const durableMessageType = messageType ?? storedMessageType(previousReceipt) ??
    storedMessageType(previousGenerationSubmission);
  const messageBodyHash = messageBody !== undefined
    ? createHash("sha256").update(messageBody).digest("hex")
    : nonBlankString(previousReceipt?.message_body_hash) ??
      nonBlankString(previousGenerationSubmission?.message_body_hash);
  const previousDispatcherPid = Number(
    previousGenerationSubmission?.dispatcher_pid
  );
  const dispatcherPid = status === "prepared" ||
      !Number.isSafeInteger(previousDispatcherPid) ||
      previousDispatcherPid <= 1
    ? context.dispatcherPid
    : previousDispatcherPid;
  const provenStage = lastProvenStage ?? terminalSubmissionLastProvenStage(
    status,
    nonBlankString(previousGenerationSubmission?.last_proven_stage)
  );
  const validatedAcceptanceEvidence = status === "agent_accepted"
    ? terminalAcceptanceEvidenceForConversation(
        conversation,
        requestText,
        acceptanceEvidence
      )
    : undefined;
  const requestHash = terminalBridgeRequestFingerprint(requestText);
  const callbackRouteFingerprint =
    callbackRouteFingerprintForConversation(conversation);
  const control = context.terminalControl;
  const candidateImmutableReceiptFields: UnknownRecord = {
    session_id: sessionIdForConversation(conversation),
    turn_id: turnIdForConversation(conversation),
    message_id: messageId,
    binding_id: nonBlankString(conversation.terminal_binding_id),
    binding_generation: Number.isSafeInteger(
      Number(conversation.terminal_binding_generation)
    )
      ? Number(conversation.terminal_binding_generation)
      : undefined,
    ...(durableMessageType ? { message_type: durableMessageType } : {}),
    ...(messageBodyHash ? { message_body_hash: messageBodyHash } : {}),
    request_hash: requestHash,
    executor_kind: executorForConversation(conversation).kind,
    openclaw_session: conversation.openclaw_session,
    callback_route_fingerprint: callbackRouteFingerprint ?? null,
    ...(nonBlankString(takeover.deferred_foreground_transfer_id)
      ? {
          deferred_foreground_transfer_id:
            nonBlankString(takeover.deferred_foreground_transfer_id)
        }
      : {}),
    store_dir: context.storeDir,
    native_thread_id:
      nonBlankString(conversation.native_thread_id) ??
      nonBlankString(takeover.terminal_agent_session_id) ??
      nonBlankString(takeover.terminal_agent_expected_session_id),
    terminal_target: control?.target,
    terminal_socket_path: control?.socketPath ?? null,
    terminal_pane_pid: control?.panePid,
    terminal_endpoint:
      control && hasCanonicalTerminalEndpoint(control)
        ? terminalControlEvidence(control)
        : previousReceipt?.terminal_endpoint
  };
  const immutableReceiptFields = Object.fromEntries(
    Object.entries(candidateImmutableReceiptFields).map(([key, value]) => [
      key,
      value === undefined && previousReceipt?.[key] !== undefined
        ? previousReceipt[key]
        : value
    ])
  );
  assertImmutableReceiptFields(
    messageId,
    previousReceipt,
    candidateImmutableReceiptFields
  );
  const nextSubmission = {
    status,
    ...immutableReceiptFields,
    prepared_at: preparedAt,
    dispatcher_pid: dispatcherPid,
    last_proven_stage: provenStage,
    ...(textInjectedAt ? { text_injected_at: textInjectedAt } : {}),
    ...(enterDispatchedAt ? { enter_dispatched_at: enterDispatchedAt } : {}),
    ...(enterNotAttemptedAt
      ? {
          enter_not_attempted_at: enterNotAttemptedAt,
          enter_not_attempted_reason:
            enterNotAttemptedReason ?? "pre_key_failure"
        }
      : {}),
    ...(agentAcceptedAt ? { agent_accepted_at: agentAcceptedAt } : {}),
    ...(notAcceptedAt ? { not_accepted_at: notAcceptedAt } : {}),
    ...(submittedAt ? { submitted_at: submittedAt } : {}),
    ...(uncertainAt ? { uncertain_at: uncertainAt } : {}),
    ...(abortedAt ? { aborted_at: abortedAt } : {}),
    ...(error ? { error: terminalDispatchTextSummary(error) } : {}),
    ...(safeToRetry !== undefined ? { safe_to_retry: safeToRetry } : {}),
    ...(validatedAcceptanceEvidence
      ? { acceptance_evidence: validatedAcceptanceEvidence }
      : {})
  };
  const nextReceipts = previousReceipt
    ? previousReceipts.map((receipt) =>
        nonBlankString(receipt.message_id) === messageId
          ? nextSubmission
          : receipt
      )
    : [...previousReceipts, nextSubmission];
  return {
    ...conversation,
    native_session_takeover: {
      ...takeover,
      terminal_bridge_submission: nextSubmission,
      terminal_bridge_submission_receipts: nextReceipts
    },
    updated_at:
      agentAcceptedAt ?? notAcceptedAt ?? uncertainAt ?? abortedAt ??
      enterDispatchedAt ?? textInjectedAt ?? submittedAt ?? preparedAt
  };
}

export function terminalAcceptanceEvidenceForConversation(
  conversation: Conversation,
  requestText: string,
  evidence: unknown
): TerminalSubmissionAcceptanceEvidence {
  return validateTerminalSubmissionAcceptanceEvidence(
    evidence,
    terminalAcceptanceEvidenceExpectation(conversation, requestText)
  );
}

export function terminalAcceptanceEvidenceExpectation(
  conversation: Conversation,
  requestText: string
): {
  source: TerminalSubmissionAcceptanceEvidence["source"];
  nativeThreadId: string;
  requestHash: string;
} {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const nativeThreadId = nonBlankString(conversation.native_thread_id) ??
    nonBlankString(takeover?.terminal_agent_session_id) ??
    nonBlankString(takeover?.terminal_agent_expected_session_id);
  if (!nativeThreadId) {
    throw new Error(
      "native acceptance evidence cannot be bound without an exact native thread"
    );
  }
  const requestHash = terminalBridgeRequestFingerprint(requestText);
  if (!requestHash) {
    throw new Error("native acceptance evidence has no exact request hash");
  }
  return {
    source: executorForConversation(conversation).kind === "codex"
      ? "codex_rollout"
      : "claude_transcript",
    nativeThreadId,
    requestHash
  };
}

export function terminalSubmissionReplayReceipt(options: {
  proofLevel: "submitted" | "enter_dispatched" | "agent_accepted";
  evidence?: unknown;
  expected: {
    source: TerminalSubmissionAcceptanceEvidence["source"];
    nativeThreadId: string;
    requestHash: string;
  };
}): {
  replayed: true;
  delivered: boolean;
  status: "async_pending" | "submission_pending_acceptance" |
    "submission_uncertain";
  submission_outcome: "agent_accepted" | "pending_acceptance" | "uncertain";
  delivery_receipt: "agent_accepted" | "enter_dispatched" | "submitted";
  do_not_retry?: true;
  evidence_error?: string;
} {
  if (options.proofLevel !== "agent_accepted") {
    return {
      replayed: true,
      delivered: false,
      status: "submission_pending_acceptance",
      submission_outcome: "pending_acceptance",
      delivery_receipt: options.proofLevel,
      do_not_retry: true
    };
  }
  try {
    validateTerminalSubmissionAcceptanceEvidence(
      options.evidence,
      options.expected
    );
    return {
      replayed: true,
      delivered: true,
      status: "async_pending",
      submission_outcome: "agent_accepted",
      delivery_receipt: "agent_accepted"
    };
  } catch (error) {
    return {
      replayed: true,
      delivered: false,
      status: "submission_uncertain",
      submission_outcome: "uncertain",
      delivery_receipt: "enter_dispatched",
      do_not_retry: true,
      evidence_error: error instanceof Error ? error.message : String(error)
    };
  }
}

function storedTerminalBridgeSubmissionReceipts(
  takeover: UnknownRecord | undefined
): UnknownRecord[] {
  const value = takeover?.terminal_bridge_submission_receipts;
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error("terminal submission receipt history is malformed");
  }
  const receipts = (Array.isArray(value) ? value : []).map((receipt) => {
    if (!isRecord(receipt) || !nonBlankString(receipt.message_id)) {
      throw new Error("terminal submission receipt history is malformed");
    }
    return receipt;
  });
  const ids = new Set<string>();
  for (const receipt of receipts) {
    const id = String(receipt.message_id);
    if (ids.has(id)) {
      throw new Error(`terminal submission receipt ${id} is duplicated`);
    }
    ids.add(id);
  }
  return receipts;
}

function storedMessageType(
  receipt: UnknownRecord | undefined
): "task" | "answer" | undefined {
  const value = nonBlankString(receipt?.message_type);
  return value === "task" || value === "answer" ? value : undefined;
}

function assertImmutableReceiptFields(
  messageId: string,
  previousReceipt: UnknownRecord | undefined,
  candidate: UnknownRecord
): void {
  if (!previousReceipt) {
    return;
  }
  for (const [key, value] of Object.entries(candidate)) {
    if (
      previousReceipt[key] !== undefined &&
      value !== undefined &&
      canonicalJson(previousReceipt[key]) !== canonicalJson(value)
    ) {
      throw new Error(
        `terminal submission receipt ${messageId} changed immutable ${key}`
      );
    }
  }
}

function terminalSubmissionLastProvenStage(
  status: TerminalOrdinaryDispatchStatus,
  previous?: string
): "prepared" | "text_injected" | "enter_dispatched" | "agent_accepted" {
  if (status === "agent_accepted") {
    return "agent_accepted";
  }
  if (["enter_dispatched", "submitted", "not_accepted"].includes(status)) {
    return "enter_dispatched";
  }
  if (
    status === "uncertain" &&
    ["prepared", "text_injected", "enter_dispatched", "agent_accepted"]
      .includes(previous ?? "")
  ) {
    return previous as
      | "prepared"
      | "text_injected"
      | "enter_dispatched"
      | "agent_accepted";
  }
  return status === "text_injected" ? "text_injected" : "prepared";
}

export function terminalBridgeRequestFingerprint(
  value: unknown
): string | undefined {
  const text = String(value ?? "");
  return text
    ? createHash("sha256").update(text).digest("hex")
    : undefined;
}

export function terminalDispatchTextSummary(text: unknown, maxLength = 240): {
  length: number;
  preview?: string;
} {
  const value = String(text ?? "");
  return {
    length: value.length,
    preview: value ? value.slice(0, maxLength) : undefined
  };
}

function deadlineAt(
  startedAt: unknown,
  timeoutMinutes: number
): string | undefined {
  const startedAtMs = Date.parse(String(startedAt ?? ""));
  return Number.isFinite(startedAtMs) &&
      Number.isFinite(timeoutMinutes) &&
      timeoutMinutes > 0
    ? new Date(startedAtMs + timeoutMinutes * 60 * 1000).toISOString()
    : undefined;
}

export function terminalBridgeEnabled(conversation: unknown): boolean {
  const record = isRecord(conversation) ? conversation : undefined;
  const takeover = isRecord(record?.native_session_takeover)
    ? record.native_session_takeover
    : undefined;
  return takeover?.terminal_bridge === true;
}

export { terminalBridgeSubmission };

export function terminalBridgeSubmissionReceipts(
  conversation: Conversation
): UnknownRecord[] {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const receipts = storedTerminalBridgeSubmissionReceipts(takeover);
  const ids = new Set(receipts.map((receipt) => String(receipt.message_id)));
  const current = terminalBridgeSubmission(conversation);
  const currentId = nonBlankString(current?.message_id);
  if (current && currentId && ids.has(currentId)) {
    const historical = receipts.find(
      (receipt) => nonBlankString(receipt.message_id) === currentId
    );
    if (!historical || canonicalJson(historical) !== canonicalJson(current)) {
      throw new Error(
        `terminal submission receipt ${currentId} conflicts with its current generation`
      );
    }
  }
  return current && currentId && !ids.has(currentId)
    ? [...receipts, current]
    : receipts;
}

export function unresolvedTerminalBridgeSubmission(
  conversation: Conversation
): UnknownRecord | undefined {
  const submission = terminalBridgeSubmission(conversation);
  return submission &&
      ["prepared", "text_injected", "enter_dispatched", "not_accepted", "uncertain"]
        .includes(String(submission.status))
    ? submission
    : undefined;
}
