import path from "node:path";

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import {
  deferredForegroundActivePreparedAt,
  deferredForegroundActiveMessageId,
  type DeferredForegroundTransfer,
  type DeferredForegroundUserAbandonmentLedgerDisposition
} from "./deferred-foreground-transfer.js";
import { callbackExpectedForConversation } from
  "./callback-route-authority.js";
import {
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import { terminalControlEvidenceMatches } from "./terminal-control-ref.js";
import {
  terminalDispatchLedgerLooksLifecycle,
  terminalDispatchReceiptHistory,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import {
  terminalBridgeSubmission,
  validateTerminalSubmissionAcceptanceEvidence,
  validTimestamp
} from "./terminal-submission-facts.js";
import { terminalControlFromTakeover } from
  "./terminal-runtime-cli-adapter.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export interface DeferredForegroundUserAbandonmentLedgerPlan {
  disposition: DeferredForegroundUserAbandonmentLedgerDisposition;
  fingerprint: string;
  next?: TerminalDispatchLedgerDocument;
}

export function deferredForegroundUserAbandonmentLedgerPlan(input: {
  current: TerminalDispatchLedgerDocument | undefined;
  transfer: DeferredForegroundTransfer;
  terminalControl: TerminalControlRef;
  storeDir: string;
  statePath: string;
  logPath: string;
  resolvedAt: string;
  currentOwner?: Conversation;
}): DeferredForegroundUserAbandonmentLedgerPlan {
  const current = input.current;
  if (!current) {
    return {
      disposition: "absent",
      fingerprint: deferredForegroundUserAbandonmentFingerprint({
        status: "absent",
        transfer_id: input.transfer.transfer_id
      })
    };
  }
  const receipts = exactTerminalDispatchReceiptHistory(current, input);
  if (exactDeferredForegroundUserAbandonmentLedger(current, input)) {
    const alreadyReleased = current.status === "resolved";
    const next: TerminalDispatchLedgerDocument = alreadyReleased
      ? { ...current, dispatcher_pid: null, callback_expected: false }
      : {
          ...current,
          status: "resolved",
          resolved_at: input.resolvedAt,
          dispatcher_pid: null,
          callback_expected: false,
          reason: "Turn management explicitly abandoned by user"
        };
    return {
      disposition: alreadyReleased ? "already_released" : "resolved",
      fingerprint: deferredForegroundUserAbandonmentFingerprint(next),
      next
    };
  }
  const matchingReceipts = receipts.filter((receipt) =>
    exactDeferredForegroundUserAbandonmentReceipt(receipt, input)
  );
  if (
    matchingReceipts.length !== 1 ||
    !exactCurrentDeferredForegroundLedgerOwner(
      current,
      input.currentOwner,
      input
    )
  ) {
    throw new Error(
      `deferred foreground transfer ${input.transfer.transfer_id} dispatch ` +
      "ledger is neither its exact generation nor one uniquely preserved " +
      "before a newer generation"
    );
  }
  return {
    disposition: "superseded",
    fingerprint: deferredForegroundUserAbandonmentFingerprint({
      disposition: "superseded",
      transfer_id: input.transfer.transfer_id,
      receipt: matchingReceipts[0]
    })
  };
}

const ORDINARY_LEDGER_STATUSES = new Set([
  "prepared", "text_injected", "enter_dispatched", "agent_accepted",
  "not_accepted", "submitted", "uncertain", "aborted", "resolved"
]);

export function distinctCurrentDeferredForegroundLedgerOwner(
  record: TerminalDispatchLedgerDocument,
  input: Pick<Parameters<
    typeof deferredForegroundUserAbandonmentLedgerPlan
  >[0], "transfer" | "terminalControl" | "storeDir" | "statePath" |
    "logPath">
): boolean {
  const oldMessageId = deferredForegroundActiveMessageId(input.transfer);
  const generationId = nonBlankString(record.generation_id);
  const messageId = nonBlankString(record.message_id);
  const conversationId = nonBlankString(record.conversation_id);
  const turnId = nonBlankString(record.turn_id);
  const sessionId = nonBlankString(record.session_id);
  const requestHash = nonBlankString(record.request_hash);
  const statePath = nonBlankString(record.state_path);
  const logPath = nonBlankString(record.event_log_path);
  const transferId = nonBlankString(record.deferred_foreground_transfer_id);
  const dispatcherPid = record.dispatcher_pid;
  return Boolean(
    (record.version === 1 || record.version === 2) &&
    !terminalDispatchLedgerLooksLifecycle(record) &&
    ORDINARY_LEDGER_STATUSES.has(String(record.status ?? "")) &&
    ordinaryDispatchRecordIsCoherent(record, { currentLedger: true }) &&
    oldMessageId && generationId && messageId &&
    generationId === messageId && messageId !== oldMessageId &&
    conversationId && turnId && conversationId === turnId &&
    turnId !== input.transfer.turn_id &&
    sessionId && requestHash &&
    statePath && logPath &&
    !samePath(statePath, input.statePath) &&
    path.dirname(path.resolve(statePath)) === path.dirname(path.resolve(logPath)) &&
    samePath(record.store_dir, input.storeDir) &&
    typeof record.callback_expected === "boolean" &&
    (
      dispatcherPid === null ||
      (Number.isSafeInteger(Number(dispatcherPid)) && Number(dispatcherPid) > 1)
    ) &&
    (!transferId || transferId !== input.transfer.transfer_id) &&
    terminalControlEvidenceMatches(
      record.terminal_endpoint ?? record.terminal_control,
      input.terminalControl,
      { requireCurrentRoute: true, requireProcessAnchor: false }
    )
  );
}

/**
 * Prove that a structurally newer terminal ledger is owned by one loadable
 * Turn carrying the same ordinary submission and terminal incarnation.
 */
export function exactCurrentDeferredForegroundLedgerOwner(
  record: TerminalDispatchLedgerDocument,
  owner: Conversation | undefined,
  input: Pick<Parameters<
    typeof deferredForegroundUserAbandonmentLedgerPlan
  >[0], "transfer" | "terminalControl" | "storeDir" | "statePath" |
    "logPath">
): boolean {
  return distinctCurrentDeferredForegroundLedgerOwner(record, input) &&
    exactDeferredForegroundLedgerOwner(record, owner, input);
}

export function exactDeferredForegroundLedgerOwner(
  record: TerminalDispatchLedgerDocument,
  owner: Conversation | undefined,
  input: Pick<Parameters<
    typeof deferredForegroundUserAbandonmentLedgerPlan
  >[0], "terminalControl" | "storeDir">
): boolean {
  if (!owner) {
    return false;
  }
  const conversationId = nonBlankString(record.conversation_id);
  const turnId = nonBlankString(record.turn_id);
  const sessionId = nonBlankString(record.session_id);
  const messageId = nonBlankString(record.message_id);
  const requestHash = nonBlankString(record.request_hash);
  const preparedAt = nonBlankString(record.prepared_at);
  const ownerStatePath = nonBlankString(owner.state_path);
  const ownerLogPath = nonBlankString(owner.event_log_path);
  const takeover = isRecord(owner.native_session_takeover)
    ? owner.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(owner);
  const ownerControl = terminalControlFromTakeover(takeover);
  const expectedStatePath = turnId
    ? path.join(input.storeDir, "conversations", turnId, "state.json")
    : undefined;
  const expectedLogPath = turnId
    ? path.join(input.storeDir, "conversations", turnId, "events.ndjson")
    : undefined;
  return Boolean(
    conversationId && turnId && conversationId === turnId &&
    conversationId === turnIdForConversation(owner) &&
    sessionId && sessionId === sessionIdForConversation(owner) &&
    messageId && requestHash && preparedAt &&
    ownerStatePath && ownerLogPath && expectedStatePath && expectedLogPath &&
    samePath(record.store_dir, input.storeDir) &&
    samePath(record.state_path, ownerStatePath) &&
    samePath(record.event_log_path, ownerLogPath) &&
    samePath(ownerStatePath, expectedStatePath) &&
    samePath(ownerLogPath, expectedLogPath) &&
    takeover && submission && ownerControl &&
    nonBlankString(takeover.terminal_bridge_message_id) === messageId &&
    nonBlankString(takeover.terminal_bridge_request_hash) === requestHash &&
    nonBlankString(submission.message_id) === messageId &&
    nonBlankString(submission.message_type) ===
      nonBlankString(record.message_type) &&
    nonBlankString(submission.request_hash) === requestHash &&
    nonBlankString(submission.prepared_at) === preparedAt &&
    (record.status === "resolved" ||
      record.callback_expected === callbackExpectedForConversation(owner)) &&
    terminalControlEvidenceMatches(
      record.terminal_endpoint ?? record.terminal_control,
      ownerControl,
      { requireCurrentRoute: true, requireProcessAnchor: true }
    ) &&
    terminalControlEvidenceMatches(
      record.terminal_endpoint ?? record.terminal_control,
      input.terminalControl,
      { requireCurrentRoute: true, requireProcessAnchor: false }
    )
  );
}

export function exactDeferredForegroundUserAbandonmentLedger(
  record: TerminalDispatchLedgerDocument,
  input: Pick<Parameters<
    typeof deferredForegroundUserAbandonmentLedgerPlan
  >[0], "transfer" | "terminalControl" | "storeDir" | "statePath" |
    "logPath">
): boolean {
  const messageId = deferredForegroundActiveMessageId(input.transfer);
  try {
    exactTerminalDispatchReceiptHistory(record, input);
  } catch {
    return false;
  }
  return Boolean(
    messageId &&
    (record.version === 1 || record.version === 2) &&
    ordinaryDispatchRecordIsCoherent(record, {
      currentLedger: true,
      expectedPreparedAt: deferredForegroundActivePreparedAt(input.transfer),
      expectedRequestHash: input.transfer.request_hash,
      expectedNativeThreadId: input.transfer.target_native_thread_id
    }) &&
    nonBlankString(record.message_type) === "task" &&
    !terminalDispatchLedgerLooksLifecycle(record) &&
    nonBlankString(record.deferred_foreground_transfer_id) ===
      input.transfer.transfer_id &&
    nonBlankString(record.conversation_id) === input.transfer.turn_id &&
    nonBlankString(record.turn_id) === input.transfer.turn_id &&
    nonBlankString(record.session_id) === input.transfer.target_session_id &&
    nonBlankString(record.generation_id) === messageId &&
    nonBlankString(record.message_id) === messageId &&
    nonBlankString(record.request_hash) === input.transfer.request_hash &&
    samePath(record.store_dir, input.storeDir) &&
    samePath(record.state_path, input.statePath) &&
    samePath(record.event_log_path, input.logPath) &&
    terminalControlEvidenceMatches(
      record.terminal_endpoint ?? record.terminal_control,
      input.terminalControl,
      { requireCurrentRoute: true, requireProcessAnchor: false }
    )
  );
}

export function exactDeferredForegroundUserAbandonmentReceipt(
  record: TerminalDispatchLedgerDocument,
  input: Pick<Parameters<
    typeof deferredForegroundUserAbandonmentLedgerPlan
  >[0], "transfer" | "terminalControl" | "storeDir" | "statePath" |
    "logPath">
): boolean {
  const messageId = deferredForegroundActiveMessageId(input.transfer);
  return Boolean(
    messageId &&
    ordinaryDispatchRecordIsCoherent(record, {
      currentLedger: false,
      expectedPreparedAt: deferredForegroundActivePreparedAt(input.transfer),
      expectedRequestHash: input.transfer.request_hash,
      expectedNativeThreadId: input.transfer.target_native_thread_id
    }) &&
    nonBlankString(record.message_type) === "task" &&
    !terminalDispatchLedgerLooksLifecycle(record) &&
    nonBlankString(record.deferred_foreground_transfer_id) ===
      input.transfer.transfer_id &&
    nonBlankString(record.conversation_id) === input.transfer.turn_id &&
    nonBlankString(record.turn_id) === input.transfer.turn_id &&
    nonBlankString(record.session_id) === input.transfer.target_session_id &&
    nonBlankString(record.generation_id) === messageId &&
    nonBlankString(record.message_id) === messageId &&
    nonBlankString(record.request_hash) === input.transfer.request_hash &&
    samePath(record.store_dir, input.storeDir) &&
    samePath(record.state_path, input.statePath) &&
    samePath(record.event_log_path, input.logPath) &&
    terminalControlEvidenceMatches(
      record.terminal_endpoint ?? record.terminal_control,
      input.terminalControl,
      { requireCurrentRoute: true, requireProcessAnchor: false }
    )
  );
}

function exactTerminalDispatchReceiptHistory(
  current: TerminalDispatchLedgerDocument,
  input: Pick<Parameters<
    typeof deferredForegroundUserAbandonmentLedgerPlan
  >[0], "terminalControl">
): TerminalDispatchLedgerDocument[] {
  const receipts = terminalDispatchReceiptHistory(current);
  if (receipts.some((receipt) =>
    !ordinaryDispatchRecordIsCoherent(receipt, { currentLedger: false }) ||
    !terminalControlEvidenceMatches(
      receipt.terminal_endpoint ?? receipt.terminal_control,
      input.terminalControl,
      { requireCurrentRoute: true, requireProcessAnchor: false }
    )
  )) {
    throw new Error("terminal dispatch receipt history is malformed");
  }
  return receipts;
}

interface OrdinaryDispatchCoherenceOptions {
  currentLedger: boolean;
  expectedPreparedAt?: string;
  expectedRequestHash?: string;
  expectedNativeThreadId?: string;
}

const ORDINARY_TIMESTAMP_FIELDS = [
  "text_injected_at", "enter_dispatched_at", "submitted_at",
  "enter_not_attempted_at", "agent_accepted_at", "not_accepted_at",
  "uncertain_at", "aborted_at", "resolved_at"
] as const;
type OrdinaryTimestampField = typeof ORDINARY_TIMESTAMP_FIELDS[number];
type OrdinaryTimestamps = Record<OrdinaryTimestampField, number | undefined>;

function ordinaryDispatchRecordIsCoherent(
  record: TerminalDispatchLedgerDocument,
  options: OrdinaryDispatchCoherenceOptions
): boolean {
  const baseline = ordinaryDispatchBaseline(record, options);
  if (!baseline) return false;
  const timestamps = ordinaryDispatchTimestamps(record, baseline.preparedMs);
  return Boolean(
    timestamps &&
    ordinaryDispatchTimelineIsCoherent(timestamps, baseline.preparedMs) &&
    phaseMatchesStatus(baseline.status, timestamps, options.currentLedger) &&
    ordinaryAcceptanceEvidenceIsCoherent(
      record,
      timestamps,
      baseline.requestHash,
      options.expectedNativeThreadId
    )
  );
}

function ordinaryDispatchBaseline(
  record: TerminalDispatchLedgerDocument,
  options: OrdinaryDispatchCoherenceOptions
): { status: string; preparedMs: number; requestHash: string } | undefined {
  const status = String(record.status ?? "");
  const allowed = options.currentLedger
    ? ORDINARY_LEDGER_STATUSES
    : new Set([
        "text_injected", "enter_dispatched", "submitted", "agent_accepted",
        "not_accepted", "uncertain", "aborted"
      ]);
  const preparedAt = nonBlankString(record.prepared_at);
  const requestHash = nonBlankString(record.request_hash);
  const dispatcherPid = record.dispatcher_pid;
  const requiredIdentity = [
    record.generation_id,
    record.conversation_id,
    record.session_id,
    record.turn_id,
    record.message_id
  ].every((value) => Boolean(nonBlankString(value)));
  if (
    !allowed.has(status) ||
    !requiredIdentity ||
    !["task", "answer"].includes(
      String(nonBlankString(record.message_type) ?? "")
    ) ||
    !requestHash || !/^[0-9a-f]{64}$/u.test(requestHash) ||
    !preparedAt || !validTimestamp(preparedAt) ||
    (options.expectedPreparedAt !== undefined &&
      preparedAt !== options.expectedPreparedAt) ||
    (options.expectedRequestHash !== undefined &&
      requestHash !== options.expectedRequestHash) ||
    typeof record.callback_expected !== "boolean" ||
    !(
      dispatcherPid === null ||
      (Number.isSafeInteger(dispatcherPid) && Number(dispatcherPid) > 1)
    )
  ) {
    return undefined;
  }
  if (status === "aborted" && typeof record.safe_to_retry !== "boolean") {
    return undefined;
  }
  return {
    status,
    preparedMs: Date.parse(preparedAt),
    requestHash
  };
}

function ordinaryDispatchTimestamps(
  record: TerminalDispatchLedgerDocument,
  preparedMs: number
): OrdinaryTimestamps | undefined {
  const timestamps = Object.fromEntries(ORDINARY_TIMESTAMP_FIELDS.map((field) => [
    field,
    record[field] === undefined || !validTimestamp(record[field])
      ? undefined
      : Date.parse(String(record[field]))
  ])) as OrdinaryTimestamps;
  const invalidTimestamp = ORDINARY_TIMESTAMP_FIELDS.some((field) =>
    record[field] !== undefined && timestamps[field] === undefined);
  const beforePreparation = ORDINARY_TIMESTAMP_FIELDS.some((field) =>
    timestamps[field] !== undefined && timestamps[field]! < preparedMs);
  const noEnterAt = timestamps.enter_not_attempted_at;
  const invalidNoEnterProof =
    (noEnterAt === undefined) !==
      (record.enter_not_attempted_reason === undefined) ||
    (noEnterAt !== undefined &&
      record.enter_not_attempted_reason !== "pre_key_failure");
  return invalidTimestamp || beforePreparation || invalidNoEnterProof
    ? undefined
    : timestamps;
}

function ordinaryDispatchTimelineIsCoherent(
  timestamps: OrdinaryTimestamps,
  preparedMs: number
): boolean {
  const textAt = timestamps.text_injected_at;
  const enterAt = timestamps.enter_dispatched_at;
  const submittedAt = timestamps.submitted_at;
  const noEnterAt = timestamps.enter_not_attempted_at;
  const acceptedAt = timestamps.agent_accepted_at;
  const notAcceptedAt = timestamps.not_accepted_at;
  const uncertainAt = timestamps.uncertain_at;
  const abortedAt = timestamps.aborted_at;
  const resolvedAt = timestamps.resolved_at;
  const lastInputAt = Math.max(
    preparedMs,
    textAt ?? preparedMs,
    enterAt ?? preparedMs,
    submittedAt ?? preparedMs,
    noEnterAt ?? preparedMs
  );
  const negativeOutcomeCount = [notAcceptedAt, abortedAt].filter(
    (value) => value !== undefined).length;
  return !(
    (textAt !== undefined && enterAt !== undefined && enterAt < textAt) ||
    (enterAt !== undefined && submittedAt !== undefined &&
      submittedAt < enterAt) ||
    [acceptedAt, notAcceptedAt, uncertainAt, abortedAt].some(
      (value) => value !== undefined && value < lastInputAt
    ) ||
    (acceptedAt !== undefined && uncertainAt !== undefined &&
      acceptedAt < uncertainAt) ||
    (acceptedAt !== undefined && negativeOutcomeCount > 0) ||
    (notAcceptedAt !== undefined &&
      (uncertainAt !== undefined || abortedAt !== undefined)) ||
    (abortedAt !== undefined && uncertainAt !== undefined) ||
    (resolvedAt !== undefined && resolvedAt < Math.max(
      lastInputAt,
      acceptedAt ?? preparedMs,
      notAcceptedAt ?? preparedMs,
      uncertainAt ?? preparedMs,
      abortedAt ?? preparedMs
    ))
  );
}

function ordinaryAcceptanceEvidenceIsCoherent(
  record: TerminalDispatchLedgerDocument,
  timestamps: OrdinaryTimestamps,
  requestHash: string,
  expectedNativeThreadId?: string
): boolean {
  const acceptedAt = timestamps.agent_accepted_at;
  const evidence = record.acceptance_evidence;
  if ((acceptedAt === undefined) !== (evidence === undefined)) {
    return false;
  }
  if (evidence !== undefined) {
    if (!isRecord(evidence) ||
      !["codex_rollout", "claude_transcript"].includes(
        String(evidence.source)
      )) {
      return false;
    }
    const nativeThreadId = nonBlankString(evidence.nativeThreadId);
    if (!nativeThreadId) return false;
    try {
      validateTerminalSubmissionAcceptanceEvidence(evidence, {
        source: evidence.source as "codex_rollout" | "claude_transcript",
        nativeThreadId: expectedNativeThreadId ?? nativeThreadId,
        requestHash
      });
    } catch {
      return false;
    }
  }
  return true;
}

function phaseMatchesStatus(
  status: string,
  timestamps: OrdinaryTimestamps,
  currentLedger: boolean
): boolean {
  const terminalEvidence = [
    timestamps.agent_accepted_at,
    timestamps.not_accepted_at,
    timestamps.uncertain_at,
    timestamps.aborted_at
  ];
  const unresolvedAtIsValid = !currentLedger ||
    timestamps.resolved_at === undefined;
  switch (status) {
    case "prepared":
      return timestamps.text_injected_at === undefined &&
        timestamps.enter_dispatched_at === undefined &&
        timestamps.submitted_at === undefined &&
        timestamps.enter_not_attempted_at === undefined &&
        terminalEvidence.every((value) => value === undefined) &&
        unresolvedAtIsValid;
    case "text_injected":
      return timestamps.text_injected_at !== undefined &&
        timestamps.enter_dispatched_at === undefined &&
        timestamps.submitted_at === undefined &&
        terminalEvidence.every((value) => value === undefined) &&
        unresolvedAtIsValid;
    case "enter_dispatched":
      return timestamps.text_injected_at !== undefined &&
        timestamps.enter_dispatched_at !== undefined &&
        terminalEvidence.every((value) => value === undefined) &&
        unresolvedAtIsValid;
    case "submitted":
      return timestamps.submitted_at !== undefined &&
        terminalEvidence.every((value) => value === undefined) &&
        unresolvedAtIsValid;
    case "agent_accepted":
      return timestamps.agent_accepted_at !== undefined && unresolvedAtIsValid;
    case "not_accepted":
      return timestamps.not_accepted_at !== undefined && unresolvedAtIsValid;
    case "uncertain":
      return timestamps.uncertain_at !== undefined && unresolvedAtIsValid;
    case "aborted":
      return timestamps.aborted_at !== undefined && unresolvedAtIsValid;
    case "resolved":
      return timestamps.resolved_at !== undefined;
    default:
      return false;
  }
}

export function deferredForegroundUserAbandonmentFingerprint(
  value: unknown
): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function samePath(value: unknown, expected: string): boolean {
  const candidate = nonBlankString(value);
  return Boolean(candidate && path.resolve(candidate) === path.resolve(expected));
}
