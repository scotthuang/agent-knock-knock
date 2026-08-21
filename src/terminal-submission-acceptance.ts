import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactString } from "./runtime-log.js";
import type {
  CodexOpenRootRolloutIdentity,
  CodexOpenRootRolloutInventory
} from "./agent-session-provider.js";
import type { TerminalCompletionEvidence } from "./terminal-agent-adapter.js";
import {
  exactNativeThreadId, fingerprint, normalizedRolloutIdentity, parsedInteger,
  requiredString, sha256Value, validTimestamp,
  validateCodexRolloutAcceptanceAnchor,
  validateTerminalSubmissionAcceptanceEvidence,
  type CaptureCodexRolloutAcceptanceAnchorOptions,
  type CodexCandidateSetRolloutAcceptanceAnchor,
  type CodexCandidateSetRolloutAcceptanceRequest,
  type CodexCandidateSetRolloutAcceptanceResult,
  type CodexRolloutAcceptanceAnchor,
  type CodexRolloutAcceptanceIdentity,
  type CodexRolloutAcceptanceRequest,
  type CodexRolloutIdentity,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-facts.js";
export {
  validateCodexRolloutAcceptanceAnchor,
  validateTerminalSubmissionAcceptanceEvidence
};
export type {
  CodexBoundRolloutAcceptanceAnchor, CodexCandidateRolloutAcceptanceAnchorEntry,
  CodexCandidateSetRolloutAcceptanceAnchor, CodexRolloutAcceptanceAnchor,
  CodexCandidateSetRolloutAcceptanceResult, CodexRolloutAcceptanceIdentity,
  CodexRolloutIdentity, TerminalSubmissionAcceptanceEvidence,
  CodexVirginRolloutAcceptanceAnchor
} from "./terminal-submission-facts.js";

export type CodexBoundRolloutCompletionCode =
  | "completion_found"
  | "exact_turn_not_complete"
  | "partial_rollout_record"
  | "rollout_changed_during_scan"
  | "invalid_anchor"
  | "invalid_acceptance_evidence"
  | "acceptance_anchor_mismatch"
  | "acceptance_turn_mismatch"
  | "binding_identity_mismatch"
  | "rollout_identity_mismatch"
  | "rollout_unreadable"
  | "rollout_truncated"
  | "scan_limit_exceeded"
  | "invalid_rollout_jsonl"
  | "duplicate_exact_completion"
  | "invalid_exact_completion";

export interface CodexBoundRolloutCompletionDiagnostics {
  detector: "codex_exact_bound_rollout";
  code: CodexBoundRolloutCompletionCode;
  native_thread_id?: string;
  acceptance_id?: string;
  anchor_fingerprint?: string;
  rollout_identity_fingerprint?: string;
  scan_start_offset_bytes?: number;
  observed_end_offset_bytes?: number;
  scanned_records?: number;
  observed_task_complete_records?: number;
  detail?: string;
}

export type CodexBoundRolloutCompletionResult =
  | {
      status: "completed";
      completion: TerminalCompletionEvidence;
      diagnostics: CodexBoundRolloutCompletionDiagnostics;
    }
  | {
      status: "pending";
      diagnostics: CodexBoundRolloutCompletionDiagnostics;
    }
  | {
      status: "failure";
      diagnostics: CodexBoundRolloutCompletionDiagnostics;
    };

/**
 * Durable identity for one already-running Codex task that was started by the
 * human in the TUI. The prompt itself is deliberately omitted; the exact root
 * user row is represented only by its SHA-256 digest and native turn UUID.
 */
export interface CodexHumanStartedActiveTaskAnchor {
  schema: "agent-knock-knock/codex-human-started-active-task-anchor";
  version: 1;
  native_thread_id: string;
  process_uuid: string;
  process_birth: string;
  captured_at: string;
  rollout: CodexRolloutIdentity;
  turn_id: string;
  request_hash: string;
  codex_version: string;
  task_started_offset_bytes: number;
  user_message_offset_bytes: number;
  observed_end_offset_bytes: number;
  anchor_fingerprint: string;
}

export interface CaptureCodexHumanStartedActiveTaskOptions {
  currentIdentity: CodexRolloutAcceptanceIdentity;
  now?: Date;
  maxBytes?: number;
}

export interface ObserveCodexHumanStartedActiveTaskOptions {
  anchor: CodexHumanStartedActiveTaskAnchor;
  currentIdentity: CodexRolloutAcceptanceIdentity;
  maxBytes?: number;
  /** Last complete, stable JSONL boundary returned by a prior observation. */
  resumeOffsetBytes?: number;
}

export type CodexHumanStartedActiveTaskObservation =
  | {
      status: "pending";
      observedEndOffsetBytes: number;
      safeResumeOffsetBytes: number;
    }
  | {
      status: "completed";
      completion: TerminalCompletionEvidence & {
        outcome: "success" | "failure";
      };
    }
  | {
      status: "invalidated";
      reason: string;
    }
  | {
      status: "unavailable";
      reason: string;
      retryable: true;
    };

const CODEX_ACCEPTANCE_MAX_BYTES = 16 * 1024 * 1024;
const CODEX_COMPLETION_MAX_BYTES = 256 * 1024 * 1024;
const CODEX_COMPLETION_MAX_TEXT_LENGTH = 4000;
const CODEX_ACTIVE_TASK_SCAN_CHUNK_BYTES = 64 * 1024;
const CODEX_ACTIVE_TASK_MAX_RECORD_BYTES = 16 * 1024 * 1024;
const CODEX_ROLLOUT_HEADER_MAX_BYTES = 1024 * 1024;
const CODEX_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;

/**
 * Capture the latest active native task in an exact open Codex rollout.
 * This is intentionally separate from the pre-send acceptance anchor: all
 * task-start and root-user evidence already exists when this function runs.
 */
export function captureCodexHumanStartedActiveTaskAnchor(
  options: CaptureCodexHumanStartedActiveTaskOptions
): CodexHumanStartedActiveTaskAnchor | undefined {
  const current = options.currentIdentity;
  const nativeThreadId = exactNativeThreadId(current.sessionId);
  const processUuid = requiredString(current.processUuid, "Codex process UUID");
  const processBirth = requiredString(current.processBirth, "Codex process birth");
  if (!current.rollout) {
    throw new Error("the active Codex task has no exact rollout identity");
  }
  const rollout = normalizedRolloutIdentity(current.rollout);
  const maxBytes = positiveByteLimit(
    options.maxBytes,
    CODEX_COMPLETION_MAX_BYTES,
    "Codex active-task capture"
  );
  const opened = openExactRollout(rollout);
  try {
    const before = opened.stat;
    assertPrivateRegularFile(before);
    if (before.size === 0) {
      return undefined;
    }
    if (!fileEndsWithNewline(opened.fd, before.size)) {
      throw new Error(
        "Codex active-task rollout has an incomplete JSONL tail; retry"
      );
    }
    const header = readCodexRolloutHeader(opened.fd, before.size);
    const codexVersion = assertExistingCodexRolloutHeader(
      header,
      nativeThreadId
    );
    const active = latestCodexHumanStartedActiveTask(
      opened.fd,
      before.size,
      maxBytes
    );
    const after = fs.fstatSync(opened.fd);
    if (!sameStableFile(before, after)) {
      throw new Error(
        "Codex active-task rollout changed while it was captured; retry"
      );
    }
    if (!active) {
      return undefined;
    }
    const base = {
      schema: "agent-knock-knock/codex-human-started-active-task-anchor" as const,
      version: 1 as const,
      native_thread_id: nativeThreadId,
      process_uuid: processUuid,
      process_birth: processBirth,
      captured_at: (options.now ?? new Date()).toISOString(),
      rollout,
      turn_id: active.turnId,
      request_hash: active.requestHash,
      codex_version: codexVersion,
      task_started_offset_bytes: active.taskStartedOffsetBytes,
      user_message_offset_bytes: active.userMessageOffsetBytes,
      observed_end_offset_bytes: before.size
    };
    return {
      ...base,
      anchor_fingerprint: fingerprint(base)
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** Observe only the exact human-started task named by the persisted anchor. */
export function observeCodexHumanStartedActiveTask(
  options: ObserveCodexHumanStartedActiveTaskOptions
): CodexHumanStartedActiveTaskObservation {
  try {
    const anchor = validateCodexHumanStartedActiveTaskAnchor(options.anchor);
    const maxBytes = positiveByteLimit(
      options.maxBytes,
      CODEX_COMPLETION_MAX_BYTES,
      "Codex active-task observation"
    );
    const resumeOffsetBytes = codexActiveTaskResumeOffset(
      anchor,
      options.resumeOffsetBytes
    );
    const opened = openExactRollout(anchor.rollout);
    try {
      const before = opened.stat;
      assertPrivateRegularFile(before);
      if (before.size < anchor.observed_end_offset_bytes) {
        throw new Error("Codex active-task rollout was truncated after capture");
      }
      if (before.size < resumeOffsetBytes) {
        throw new Error("Codex active-task rollout was truncated after observation");
      }
      assertCodexActiveTaskResumeBoundary(opened.fd, resumeOffsetBytes);
      const availableBytes = before.size - resumeOffsetBytes;
      const bytesToRead = Math.min(availableBytes, maxBytes);
      if (bytesToRead === 0) {
        assertCodexHumanStartedIdentity(anchor, options.currentIdentity);
        return {
          status: "pending",
          observedEndOffsetBytes: before.size,
          safeResumeOffsetBytes: resumeOffsetBytes
        };
      }
      const buffer = readExactBytes(
        opened.fd,
        resumeOffsetBytes,
        bytesToRead
      );
      const completeLength = completeJsonlPrefixLength(buffer);
      if (completeLength === 0 && availableBytes > maxBytes) {
        throw new Error(
          "Codex active-task JSONL record exceeded the bounded read limit"
        );
      }
      const completeBuffer = buffer.subarray(0, completeLength);
      const safeResumeOffsetBytes = resumeOffsetBytes + completeLength;
      const after = fs.fstatSync(opened.fd);
      if (!sameStableFile(before, after)) {
        assertCodexHumanStartedIdentity(anchor, options.currentIdentity);
        return {
          status: "pending",
          observedEndOffsetBytes: after.size,
          safeResumeOffsetBytes: resumeOffsetBytes
        };
      }
      const suffixRecords = parseCodexJsonlRecords(
        completeBuffer,
        "active-task suffix"
      );
      const laterTaskOffset = suffixRecords.find(({ value }) =>
        isLaterCodexHumanTaskRecord(value)
      )?.offsetBytes;
      const exactCompletionOffset = suffixRecords.find(({ value }) =>
        isExactCodexTaskCompleteRecord(value, anchor.turn_id)
      )?.offsetBytes;
      const exactAbortRecords = suffixRecords.filter(({ value }) =>
        isExactCodexTurnAbortedRecord(value, anchor.turn_id)
      );
      if (exactAbortRecords.length > 1) {
        throw new Error(
          "the exact Codex active task has duplicate turn_aborted records"
        );
      }
      const exactAbort = exactAbortRecords[0];
      const exactSettlementOffset = [
        exactCompletionOffset,
        exactAbort?.offsetBytes
      ].filter((offset): offset is number => offset !== undefined)
        .sort((left, right) => left - right)[0];
      if (
        laterTaskOffset !== undefined &&
        (exactSettlementOffset === undefined ||
          laterTaskOffset < exactSettlementOffset)
      ) {
        throw new Error(
          "a later Codex human task appeared after the active-task anchor"
        );
      }
      if (
        exactAbort &&
        (exactCompletionOffset === undefined ||
          exactAbort.offsetBytes < exactCompletionOffset)
      ) {
        return codexHumanStartedTaskAbortCompletion(
          anchor,
          exactAbort.value,
          before.size
        );
      }
      const completion = scanExactCodexTaskComplete(
        completeBuffer.toString("utf8"),
        anchor.turn_id
      );
      if (completion.status === "failure") {
        throw new Error(completion.detail);
      }
      if (completion.status === "pending") {
        assertCodexHumanStartedIdentity(anchor, options.currentIdentity);
        return {
          status: "pending",
          observedEndOffsetBytes: before.size,
          safeResumeOffsetBytes
        };
      }
      return {
        status: "completed",
        completion: {
          source: "durable",
          outcome: "success",
          text: truncateCompletionText(redactString(completion.text)),
          ...(completion.timestamp ? { timestamp: completion.timestamp } : {}),
          id: anchor.turn_id,
          confidence: "high",
          metadata: {
            match: "human_started_bound_rollout_task_complete",
            turn_id: anchor.turn_id,
            native_thread_id: anchor.native_thread_id,
            anchor_fingerprint: anchor.anchor_fingerprint,
            observed_end_offset_bytes: before.size
          }
        }
      };
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch (error) {
    if (isRetryableProviderIoError(error)) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
        retryable: true
      };
    }
    return {
      status: "invalidated",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function codexActiveTaskResumeOffset(
  anchor: CodexHumanStartedActiveTaskAnchor,
  value: number | undefined
): number {
  const offset = value === undefined
    ? anchor.observed_end_offset_bytes
    : safeByteOffset(value, "Codex active-task resume offset");
  if (offset < anchor.observed_end_offset_bytes) {
    throw new Error("Codex active-task resume offset predates its anchor");
  }
  return offset;
}

function assertCodexActiveTaskResumeBoundary(fd: number, offset: number): void {
  if (offset > 0 && byteAtOffset(fd, offset - 1) !== 0x0a) {
    throw new Error("Codex active-task resume offset is not a JSONL boundary");
  }
}

function completeJsonlPrefixLength(buffer: Buffer): number {
  if (buffer.length === 0) {
    return 0;
  }
  const newline = buffer.lastIndexOf(0x0a);
  return newline < 0 ? 0 : newline + 1;
}

interface CodexJsonlRecordAtOffset {
  value: Record<string, any>;
  offsetBytes: number;
}

interface CodexHumanStartedTaskMatch {
  turnId: string;
  requestHash: string;
  taskStartedOffsetBytes: number;
  userMessageOffsetBytes: number;
}

interface CodexActiveTaskUserRecord {
  offsetBytes: number;
  turnId: string;
  requestHash?: string;
}

type CodexActiveTaskReverseDecision =
  | { status: "continue" }
  | { status: "resolved"; active?: CodexHumanStartedTaskMatch };

export function validateCodexHumanStartedActiveTaskAnchor(
  value: unknown
): CodexHumanStartedActiveTaskAnchor {
  if (
    !isRecord(value) ||
    value.schema !==
      "agent-knock-knock/codex-human-started-active-task-anchor" ||
    value.version !== 1
  ) {
    throw new Error("Codex human-started active-task anchor is invalid");
  }
  const allowedKeys = new Set([
    "schema", "version", "native_thread_id", "process_uuid", "process_birth",
    "captured_at", "rollout", "turn_id", "request_hash", "codex_version",
    "task_started_offset_bytes", "user_message_offset_bytes",
    "observed_end_offset_bytes", "anchor_fingerprint"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Codex human-started active-task anchor has unsupported fields");
  }
  const nativeThreadId = exactNativeThreadId(value.native_thread_id);
  const turnId = exactNativeThreadId(value.turn_id);
  const capturedAt = value.captured_at;
  if (
    nativeThreadId !== value.native_thread_id ||
    turnId !== value.turn_id ||
    !validTimestamp(capturedAt) ||
    typeof capturedAt !== "string" ||
    new Date(capturedAt).toISOString() !== capturedAt
  ) {
    throw new Error("Codex human-started active-task anchor identity is invalid");
  }
  for (const [field, label] of [
    [value.process_uuid, "Codex active-task process UUID"],
    [value.process_birth, "Codex active-task process birth"]
  ] as const) {
    if (
      requiredString(field, label) !== field ||
      field.includes("\0")
    ) {
      throw new Error(`${label} is not canonical`);
    }
  }
  if (
    sha256Value(value.request_hash, "Codex active-task request hash") !==
      value.request_hash
  ) {
    throw new Error("Codex active-task request hash is not canonical");
  }
  if (
    typeof value.codex_version !== "string" ||
    !CODEX_VERSION_PATTERN.test(value.codex_version)
  ) {
    throw new Error("Codex active-task version is invalid");
  }
  if (
    sha256Value(
      value.anchor_fingerprint,
      "Codex active-task anchor fingerprint"
    ) !== value.anchor_fingerprint
  ) {
    throw new Error("Codex active-task anchor fingerprint is not canonical");
  }
  if (!isRecord(value.rollout)) {
    throw new Error("Codex human-started active-task rollout identity is invalid");
  }
  const rolloutKeys = new Set(["fd", "device", "inode", "path"]);
  if (Object.keys(value.rollout).some((key) => !rolloutKeys.has(key))) {
    throw new Error("Codex human-started active-task rollout has unsupported fields");
  }
  const rollout = normalizedRolloutIdentity(value.rollout);
  if (
    Object.entries(rollout).some(([key, normalized]) =>
      normalized !== value.rollout[key] || normalized.includes("\0")
    ) ||
    !path.isAbsolute(rollout.path)
  ) {
    throw new Error("Codex human-started active-task rollout path is not absolute");
  }
  const taskStartedOffset = safeByteOffset(
    value.task_started_offset_bytes,
    "Codex active-task task_started offset"
  );
  const userMessageOffset = safeByteOffset(
    value.user_message_offset_bytes,
    "Codex active-task user-message offset"
  );
  const observedEndOffset = safeByteOffset(
    value.observed_end_offset_bytes,
    "Codex active-task observed-end offset"
  );
  if (
    userMessageOffset <= taskStartedOffset ||
    observedEndOffset <= userMessageOffset
  ) {
    throw new Error("Codex human-started active-task byte boundaries are inconsistent");
  }
  const { anchor_fingerprint: _anchorFingerprint, ...base } = value;
  if (fingerprint(base) !== value.anchor_fingerprint) {
    throw new Error("Codex human-started active-task anchor fingerprint does not match");
  }
  return value as unknown as CodexHumanStartedActiveTaskAnchor;
}

function assertCodexHumanStartedIdentity(
  anchor: CodexHumanStartedActiveTaskAnchor,
  current: CodexRolloutAcceptanceIdentity
): void {
  if (
    exactNativeThreadId(current.sessionId) !== anchor.native_thread_id ||
    requiredString(current.processUuid, "Codex process UUID") !==
      anchor.process_uuid ||
    requiredString(current.processBirth, "Codex process birth") !==
      anchor.process_birth ||
    !current.rollout ||
    !sameRolloutIdentity(
      normalizedRolloutIdentity(current.rollout),
      anchor.rollout
    )
  ) {
    throw new Error("Codex process, thread, or rollout identity changed after capture");
  }
}

function latestCodexHumanStartedActiveTask(
  fd: number,
  endOffset: number,
  maxBytes: number
): CodexHumanStartedTaskMatch | undefined {
  const lowerBound = Math.max(0, endOffset - maxBytes);
  const terminalTurns = new Map<string, "completed" | "aborted">();
  const userRecords: CodexActiveTaskUserRecord[] = [];
  let cursor = endOffset;
  let leadingRecord = Buffer.alloc(0);

  while (cursor > lowerBound) {
    const readStart = Math.max(
      lowerBound,
      cursor - CODEX_ACTIVE_TASK_SCAN_CHUNK_BYTES
    );
    const chunk = readExactBytes(fd, readStart, cursor - readStart);
    const combined = leadingRecord.length > 0
      ? Buffer.concat([chunk, leadingRecord])
      : chunk;
    let recordsBuffer = combined;
    let recordsOffset = readStart;

    if (readStart > 0) {
      const firstNewline = combined.indexOf(0x0a);
      if (firstNewline < 0) {
        assertBoundedCodexActiveTaskRecord(combined.length);
        leadingRecord = Buffer.from(combined);
        cursor = readStart;
        continue;
      }
      leadingRecord = Buffer.from(combined.subarray(0, firstNewline + 1));
      assertBoundedCodexActiveTaskRecord(leadingRecord.length);
      recordsBuffer = combined.subarray(firstNewline + 1);
      recordsOffset += firstNewline + 1;
    } else {
      leadingRecord = Buffer.alloc(0);
    }

    const records = parseCodexJsonlRecords(
      recordsBuffer,
      "active-task rollout tail"
    );
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      const decision = inspectCodexActiveTaskRecordInReverse(
        {
          value: record.value,
          offsetBytes: recordsOffset + record.offsetBytes
        },
        terminalTurns,
        userRecords
      );
      if (decision.status === "resolved") {
        return decision.active;
      }
    }
    cursor = readStart;
  }

  if (lowerBound > 0) {
    throw new Error(
      "Codex active-task boundary exceeded the bounded reverse scan limit"
    );
  }
  return undefined;
}

function inspectCodexActiveTaskRecordInReverse(
  record: CodexJsonlRecordAtOffset,
  terminalTurns: Map<string, "completed" | "aborted">,
  userRecords: CodexActiveTaskUserRecord[]
): CodexActiveTaskReverseDecision {
  const { value, offsetBytes } = record;
  const payload = isRecord(value.payload) ? value.payload : undefined;
  if (!payload) {
    return { status: "continue" };
  }
  if (
    value.type === "event_msg" &&
    (payload.type === "task_complete" || payload.type === "turn_aborted")
  ) {
    const turnId = exactNativeThreadId(payload.turn_id);
    const kind = payload.type === "task_complete" ? "completed" : "aborted";
    const previous = terminalTurns.get(turnId);
    if (previous) {
      throw new Error(
        previous === kind
          ? `Codex rollout contains duplicate ${String(payload.type)} evidence`
          : "Codex rollout contains conflicting terminal task evidence"
      );
    }
    terminalTurns.set(turnId, kind);
    return { status: "continue" };
  }
  if (
    value.type === "response_item" &&
    payload.type === "message" &&
    payload.role === "user"
  ) {
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : undefined;
    const rawTurnId = optionalString(metadata?.turn_id);
    if (rawTurnId) {
      const text = exactCodexUserResponseText(payload.content);
      userRecords.push({
        offsetBytes,
        turnId: rawTurnId.toLowerCase(),
        ...(text === undefined ? {} : { requestHash: fingerprintText(text) })
      });
    }
    return { status: "continue" };
  }
  if (value.type !== "event_msg" || payload.type !== "task_started") {
    return { status: "continue" };
  }

  const turnId = exactNativeThreadId(payload.turn_id);
  if (terminalTurns.has(turnId)) {
    return { status: "resolved" };
  }
  const matchingUsers = userRecords.filter((user) => user.turnId === turnId);
  if (matchingUsers.length === 0) {
    return { status: "resolved" };
  }
  if (matchingUsers.length !== 1) {
    throw new Error("Codex active task has multiple same-turn root user rows");
  }
  const [user] = matchingUsers;
  if (user.requestHash === undefined) {
    throw new Error("Codex active-task root user row has unsupported prompt content");
  }
  if (user.offsetBytes <= offsetBytes) {
    throw new Error("Codex active-task root user row precedes task_started");
  }
  if (userRecords.some((candidate) =>
    candidate.offsetBytes > user.offsetBytes && candidate.turnId !== turnId
  )) {
    throw new Error("Codex active task is not the latest native human task");
  }
  return {
    status: "resolved",
    active: {
      turnId,
      requestHash: user.requestHash,
      taskStartedOffsetBytes: offsetBytes,
      userMessageOffsetBytes: user.offsetBytes
    }
  };
}

function assertBoundedCodexActiveTaskRecord(length: number): void {
  if (length > CODEX_ACTIVE_TASK_MAX_RECORD_BYTES) {
    throw new Error("Codex active-task JSONL record exceeded the safe read limit");
  }
}

function isLaterCodexHumanTaskRecord(value: Record<string, any>): boolean {
  const payload = isRecord(value.payload) ? value.payload : undefined;
  return Boolean(
    payload &&
    (
      (value.type === "event_msg" && payload.type === "task_started") ||
      (
        value.type === "response_item" &&
        payload.type === "message" &&
        payload.role === "user"
      )
    )
  );
}

function isExactCodexTaskCompleteRecord(
  value: Record<string, any>,
  expectedTurnId: string
): boolean {
  const payload = isRecord(value.payload) ? value.payload : undefined;
  return value.type === "event_msg" &&
    payload?.type === "task_complete" &&
    optionalString(payload.turn_id)?.toLowerCase() === expectedTurnId;
}

function isExactCodexTurnAbortedRecord(
  value: Record<string, any>,
  expectedTurnId: string
): boolean {
  const payload = isRecord(value.payload) ? value.payload : undefined;
  return value.type === "event_msg" &&
    payload?.type === "turn_aborted" &&
    optionalString(payload.turn_id)?.toLowerCase() === expectedTurnId;
}

function codexHumanStartedTaskAbortCompletion(
  anchor: CodexHumanStartedActiveTaskAnchor,
  value: Record<string, any>,
  observedEndOffsetBytes: number
): CodexHumanStartedActiveTaskObservation {
  const payload = isRecord(value.payload) ? value.payload : undefined;
  if (!payload || payload.type !== "turn_aborted") {
    throw new Error("Codex active-task abort evidence is invalid");
  }
  const reason = optionalString(payload.reason) ?? "interrupted";
  if (value.timestamp !== undefined && !validTimestamp(value.timestamp)) {
    throw new Error("Codex active-task turn_aborted record has an invalid timestamp");
  }
  const redactedReason = truncateCompletionText(redactString(reason));
  return {
    status: "completed",
    completion: {
      source: "durable",
      outcome: "failure",
      text: truncateCompletionText(
        redactString(`Codex task stopped: ${redactedReason}`)
      ),
      ...(value.timestamp !== undefined
        ? { timestamp: String(value.timestamp) }
        : {}),
      id: anchor.turn_id,
      confidence: "high",
      metadata: {
        match: "human_started_bound_rollout_turn_aborted",
        turn_id: anchor.turn_id,
        native_thread_id: anchor.native_thread_id,
        anchor_fingerprint: anchor.anchor_fingerprint,
        abort_reason: redactedReason,
        observed_end_offset_bytes: observedEndOffsetBytes
      }
    }
  };
}

function parseCodexJsonlRecords(
  buffer: Buffer,
  label: string
): CodexJsonlRecordAtOffset[] {
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
    throw new Error(`Codex ${label} ends with an incomplete JSONL record`);
  }
  const records: CodexJsonlRecordAtOffset[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) {
      break;
    }
    const recordOffset = offset;
    let lineBuffer = buffer.subarray(offset, newline);
    if (lineBuffer.at(-1) === 0x0d) {
      lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
    }
    offset = newline + 1;
    const line = lineBuffer.toString("utf8");
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Codex ${label} contains invalid JSONL`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`Codex ${label} contains a non-object JSONL record`);
    }
    records.push({ value: parsed, offsetBytes: recordOffset });
  }
  return records;
}

function assertExistingCodexRolloutHeader(
  buffer: Buffer,
  nativeThreadId: string
): string {
  const first = parseCodexJsonlRecords(buffer, "active-task rollout")[0]?.value;
  const payload = first?.type === "session_meta" && isRecord(first.payload)
    ? first.payload
    : undefined;
  if (
    !payload ||
    exactNativeThreadId(payload.id) !== nativeThreadId ||
    payload.originator !== "codex-tui" ||
    payload.source !== "cli"
  ) {
    throw new Error("Codex active-task rollout header does not identify the exact CLI thread");
  }
  const codexVersion = optionalString(payload.cli_version);
  if (!codexVersion || !CODEX_VERSION_PATTERN.test(codexVersion)) {
    throw new Error("Codex active-task rollout header has no exact CLI version");
  }
  return codexVersion;
}

function readCodexRolloutHeader(fd: number, size: number): Buffer {
  const bytesToRead = Math.min(size, CODEX_ROLLOUT_HEADER_MAX_BYTES);
  const buffer = readExactBytes(fd, 0, bytesToRead);
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) {
    throw new Error("Codex active-task rollout header exceeded the safe read limit");
  }
  return buffer.subarray(0, newline + 1);
}

function readExactBytes(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const read = fs.readSync(fd, buffer, total, length - total, offset + total);
    if (read === 0) {
      break;
    }
    total += read;
  }
  if (total !== length) {
    throw new Error("Codex rollout changed while it was being read");
  }
  return buffer;
}

function positiveByteLimit(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} byte limit is invalid`);
  }
  return result;
}

function safeByteOffset(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

export function captureCodexRolloutAcceptanceAnchor(
  options: CaptureCodexRolloutAcceptanceAnchorOptions
): CodexRolloutAcceptanceAnchor {
  const processUuid = requiredString(options.processUuid, "Codex process UUID");
  const processBirth = requiredString(options.processBirth, "Codex process birth");
  const capturedAt = (options.now ?? new Date()).toISOString();
  if (
    options.mode === "pre_materialization" &&
    options.nativeThreadId === undefined
  ) {
    const virginBase = {
      schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
      version: 2 as const,
      process_uuid: processUuid,
      process_birth: processBirth,
      captured_at: capturedAt,
      mode: "pre_materialization" as const,
      native_thread_binding: "post_submission" as const,
      file_existed: false as const,
      offset_bytes: 0 as const,
      expected_empty_native_session: true as const
    };
    return {
      ...virginBase,
      anchor_fingerprint: fingerprint(virginBase)
    };
  }

  const nativeThreadId = exactNativeThreadId(options.nativeThreadId);
  const base = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
    version: 1 as const,
    native_thread_id: nativeThreadId,
    process_uuid: processUuid,
    process_birth: processBirth,
    captured_at: capturedAt
  };

  if (options.mode === "pre_materialization") {
    const withoutFile = {
      ...base,
      mode: "pre_materialization" as const,
      file_existed: false,
      offset_bytes: 0,
      expected_empty_native_session: true as const
    };
    return {
      ...withoutFile,
      anchor_fingerprint: fingerprint(withoutFile)
    };
  }

  const rollout = normalizedRolloutIdentity(options.rollout);
  const opened = openExactRollout(rollout);
  try {
    const before = opened.stat;
    assertPrivateRegularFile(before);
    if (before.size > 0 && !fileEndsWithNewline(opened.fd, before.size)) {
      throw new Error(
        "Codex rollout did not end at a complete JSONL record before terminal submission"
      );
    }
    const after = fs.fstatSync(opened.fd);
    if (!sameStableFile(before, after)) {
      throw new Error("Codex rollout changed while its terminal submission anchor was captured");
    }
    const withFile = {
      ...base,
      mode: "existing" as const,
      file_existed: true,
      offset_bytes: before.size,
      rollout
    };
    return {
      ...withFile,
      anchor_fingerprint: fingerprint(withFile)
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function captureCodexCandidateSetRolloutAcceptanceAnchor({
  inventory: inventoryValue,
  now = new Date()
}: {
  inventory: CodexOpenRootRolloutInventory;
  now?: Date;
}): CodexCandidateSetRolloutAcceptanceAnchor {
  const inventory = validateCodexOpenRootInventoryForAcceptance(
    inventoryValue
  );
  const candidateRollouts = inventory.roots.map((identity) => {
    const rollout = normalizedRolloutIdentity(identity.rollout);
    const opened = openExactRollout(rollout);
    try {
      const before = opened.stat;
      assertPrivateRegularFile(before);
      if (before.size > 0 && !fileEndsWithNewline(opened.fd, before.size)) {
        throw new Error(
          "Codex candidate rollout did not end at a complete JSONL record before terminal submission"
        );
      }
      const after = fs.fstatSync(opened.fd);
      if (!sameStableFile(before, after)) {
        throw new Error(
          "Codex candidate rollout changed while its terminal submission anchor was captured"
        );
      }
      return {
        native_thread_id: exactNativeThreadId(identity.sessionId),
        rollout,
        offset_bytes: before.size
      };
    } finally {
      fs.closeSync(opened.fd);
    }
  });
  const base = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
    version: 3 as const,
    process_uuid: inventory.processUuid,
    process_birth: inventory.processBirth,
    captured_at: now.toISOString(),
    mode: "candidate_set" as const,
    native_thread_binding: "post_submission" as const,
    file_existed: false as const,
    offset_bytes: 0 as const,
    zero_file_baseline: candidateRollouts.length === 0,
    inventory_pid: inventory.pid,
    ...(inventory.cwd ? { inventory_cwd: inventory.cwd } : {}),
    inventory_fingerprint: inventory.inventoryFingerprint,
    candidate_rollouts: candidateRollouts
  };
  return {
    ...base,
    anchor_fingerprint: fingerprint(base)
  };
}

export function detectCodexCandidateSetRolloutAcceptance({
  anchor: anchorValue,
  currentInventory: inventoryValue,
  requestHash: requestHashValue
}: CodexCandidateSetRolloutAcceptanceRequest):
CodexCandidateSetRolloutAcceptanceResult {
  const anchor = validateCodexRolloutAcceptanceAnchor(anchorValue);
  if (anchor.version !== 3) {
    throw new Error("Codex candidate-set acceptance requires a version 3 anchor");
  }
  const inventory = validateCodexOpenRootInventoryForAcceptance(
    inventoryValue
  );
  const requestHash = sha256Value(
    requestHashValue,
    "terminal request hash"
  );
  if (
    inventory.processUuid !== anchor.process_uuid ||
    inventory.processBirth !== anchor.process_birth ||
    inventory.pid !== anchor.inventory_pid ||
    inventory.cwd !== anchor.inventory_cwd
  ) {
    return {
      status: "uncertain",
      code: "candidate_inventory_changed",
      reason:
        "Codex process incarnation changed during candidate-set acceptance polling",
      inspected_candidates: 0,
      exact_matches: 0
    };
  }

  const anchoredByThread = new Map(
    anchor.candidate_rollouts.map((candidate) => [
      candidate.native_thread_id,
      candidate
    ])
  );
  const currentByThread = new Map(
    inventory.roots.map((identity) => [identity.sessionId, identity])
  );
  for (const identity of inventory.roots) {
    const anchored = anchoredByThread.get(identity.sessionId);
    if (
      anchored &&
      !sameRolloutIdentity(anchored.rollout, identity.rollout)
    ) {
      return {
        status: "uncertain",
        code: "candidate_inventory_changed",
        reason:
          `Codex candidate ${identity.sessionId} changed rollout identity after capture`,
        inspected_candidates: 0,
        exact_matches: 0
      };
    }
  }
  for (const anchored of anchor.candidate_rollouts) {
    if (!currentByThread.has(anchored.native_thread_id)) {
      return {
        status: "uncertain",
        code: "candidate_inventory_changed",
        reason:
          `Codex candidate ${anchored.native_thread_id} is no longer open in the exact process inventory`,
        inspected_candidates: 0,
        exact_matches: 0
      };
    }
  }

  const candidates: Array<{
    identity: CodexOpenRootRolloutIdentity;
    offsetBytes: number;
    requireFreshHeader: boolean;
  }> = inventory.roots.map((identity) => {
    const anchored = anchoredByThread.get(identity.sessionId);
    return {
      identity,
      offsetBytes: anchored?.offset_bytes ?? 0,
      requireFreshHeader: anchored === undefined
    };
  });

  const matches: Array<{
    identity: CodexOpenRootRolloutIdentity;
    evidence: TerminalSubmissionAcceptanceEvidence;
  }> = [];
  let incompleteCandidates = 0;
  for (const candidate of candidates) {
    let scan: CodexAcceptanceRolloutScan;
    try {
      scan = scanCodexRolloutAcceptance({
        rollout: candidate.identity.rollout,
        nativeThreadId: candidate.identity.sessionId,
        processUuid: anchor.process_uuid,
        processBirth: anchor.process_birth,
        requestHash,
        anchorFingerprint: anchor.anchor_fingerprint,
        offsetBytes: candidate.offsetBytes,
        requireFreshHeader: candidate.requireFreshHeader,
        capturedAt: anchor.captured_at
      });
    } catch (error) {
      return {
        status: "uncertain",
        code: "candidate_scan_invalid",
        reason: error instanceof Error ? error.message : String(error),
        inspected_candidates: candidates.indexOf(candidate) + 1,
        exact_matches: matches.length
      };
    }
    if (scan.status === "incomplete") {
      incompleteCandidates += 1;
    } else if (scan.status === "accepted") {
      matches.push({
        identity: candidate.identity,
        evidence: scan.evidence
      });
    }
  }
  if (matches.length > 1) {
    return {
      status: "uncertain",
      code: "multiple_exact_request_acceptances",
      reason:
        "multiple Codex root rollouts durably accepted the exact terminal request",
      inspected_candidates: candidates.length,
      exact_matches: matches.length
    };
  }
  if (matches.length === 0 || incompleteCandidates > 0) {
    return {
      status: "pending",
      inspected_candidates: candidates.length,
      exact_matches: matches.length,
      ...(incompleteCandidates > 0
        ? { incomplete_candidates: incompleteCandidates }
        : {})
    };
  }
  return {
    status: "accepted",
    identity: matches[0].identity,
    evidence: matches[0].evidence
  };
}

export function detectCodexRolloutAcceptance(
  options: CodexRolloutAcceptanceRequest
): TerminalSubmissionAcceptanceEvidence | undefined {
  const anchor = validateCodexRolloutAcceptanceAnchor(options.anchor);
  if (anchor.version === 3) {
    throw new Error(
      "Codex candidate-set acceptance requires the inventory-aware detector"
    );
  }
  const requestHash = sha256Value(options.requestHash, "terminal request hash");
  const current = options.currentIdentity;
  const currentNativeThreadId = exactNativeThreadId(current.sessionId);
  const expectedNativeThreadId = anchor.version === 1
    ? anchor.native_thread_id
    : currentNativeThreadId;
  if (
    currentNativeThreadId !== expectedNativeThreadId ||
    current.processUuid !== anchor.process_uuid ||
    current.processBirth !== anchor.process_birth
  ) {
    throw new Error("Codex process or native thread identity changed during acceptance polling");
  }
  if (!current.rollout) {
    return undefined;
  }
  const rollout = normalizedRolloutIdentity(current.rollout);
  if (
    anchor.rollout &&
    !sameRolloutIdentity(anchor.rollout, rollout)
  ) {
    throw new Error("Codex rollout identity changed during acceptance polling");
  }

  const scan = scanCodexRolloutAcceptance({
    rollout,
    nativeThreadId: expectedNativeThreadId,
    processUuid: anchor.process_uuid,
    processBirth: anchor.process_birth,
    requestHash,
    anchorFingerprint: anchor.anchor_fingerprint,
    offsetBytes: anchor.offset_bytes,
    requireFreshHeader: anchor.version === 2,
    capturedAt: anchor.captured_at
  });
  return scan.status === "accepted" ? scan.evidence : undefined;
}

/**
 * Scans the exact rollout and native turn proven by terminal acceptance.
 *
 * Unlike the general Codex context loader, this detector does not retain only
 * a recent-turn window. It starts at the immutable pre-submission byte anchor
 * and matches only the persisted acceptance UUID, so a delayed monitor can
 * recover completion even after later native turns have been appended.
 */
export function detectCodexBoundRolloutCompletion(options: {
  anchor: CodexRolloutAcceptanceAnchor;
  acceptanceEvidence: TerminalSubmissionAcceptanceEvidence;
  currentIdentity: CodexRolloutAcceptanceIdentity;
  requestHash: string;
}): CodexBoundRolloutCompletionResult {
  let anchor: CodexRolloutAcceptanceAnchor;
  try {
    anchor = validateCodexRolloutAcceptanceAnchor(options.anchor);
  } catch (error) {
    return codexCompletionFailure("invalid_anchor", error);
  }

  const initialDiagnostics: Omit<
    CodexBoundRolloutCompletionDiagnostics,
    "code"
  > = {
    detector: "codex_exact_bound_rollout",
    anchor_fingerprint: anchor.anchor_fingerprint,
    scan_start_offset_bytes: anchor.offset_bytes
  };
  let requestHash: string;
  let acceptance: TerminalSubmissionAcceptanceEvidence;
  let expectedNativeThreadId: string;
  try {
    requestHash = sha256Value(options.requestHash, "terminal request hash");
    expectedNativeThreadId = anchor.version === 1
      ? anchor.native_thread_id
      : exactNativeThreadId(options.acceptanceEvidence.nativeThreadId);
    acceptance = validateTerminalSubmissionAcceptanceEvidence(
      options.acceptanceEvidence,
      {
        source: "codex_rollout",
        nativeThreadId: expectedNativeThreadId,
        requestHash
      }
    );
  } catch (error) {
    return codexCompletionFailure(
      "invalid_acceptance_evidence",
      error,
      initialDiagnostics
    );
  }
  const acceptedCandidate = anchor.version === 3
    ? anchor.candidate_rollouts.find((candidate) =>
        candidate.native_thread_id === expectedNativeThreadId
      )
    : undefined;
  const scanStartOffset = acceptedCandidate?.offset_bytes ??
    anchor.offset_bytes;
  const baseDiagnostics = {
    ...initialDiagnostics,
    scan_start_offset_bytes: scanStartOffset,
    native_thread_id: expectedNativeThreadId
  };

  let acceptanceId: string;
  try {
    acceptanceId = exactNativeThreadId(acceptance.acceptanceId);
  } catch (error) {
    return codexCompletionFailure(
      "acceptance_turn_mismatch",
      error,
      baseDiagnostics
    );
  }
  const diagnostics = {
    ...baseDiagnostics,
    acceptance_id: acceptanceId
  };
  if (acceptance.anchorFingerprint !== anchor.anchor_fingerprint) {
    return codexCompletionFailure(
      "acceptance_anchor_mismatch",
      new Error("Codex acceptance evidence belongs to a different byte anchor"),
      diagnostics
    );
  }
  const evidenceTurnId = optionalString(acceptance.metadata?.turn_id);
  if (evidenceTurnId !== undefined) {
    let normalizedEvidenceTurnId: string;
    try {
      normalizedEvidenceTurnId = exactNativeThreadId(evidenceTurnId);
    } catch (error) {
      return codexCompletionFailure(
        "acceptance_turn_mismatch",
        error,
        diagnostics
      );
    }
    if (normalizedEvidenceTurnId !== acceptanceId) {
      return codexCompletionFailure(
        "acceptance_turn_mismatch",
        new Error("Codex acceptance metadata names a different native turn"),
        diagnostics
      );
    }
  }
  let evidenceAnchorOffset: number | undefined;
  try {
    evidenceAnchorOffset = optionalSafeOffset(
      acceptance.metadata?.anchor_offset_bytes
    );
  } catch (error) {
    return codexCompletionFailure(
      "invalid_acceptance_evidence",
      error,
      diagnostics
    );
  }
  if (
    evidenceAnchorOffset !== undefined &&
    evidenceAnchorOffset !== scanStartOffset
  ) {
    return codexCompletionFailure(
      "acceptance_anchor_mismatch",
      new Error("Codex acceptance evidence has a different byte offset"),
      diagnostics
    );
  }

  const current = options.currentIdentity;
  try {
    if (
      exactNativeThreadId(current.sessionId) !== expectedNativeThreadId ||
      requiredString(current.processUuid, "Codex process UUID") !==
        anchor.process_uuid ||
      requiredString(current.processBirth, "Codex process birth") !==
        anchor.process_birth
    ) {
      throw new Error(
        "Codex process or native thread identity changed during completion polling"
      );
    }
  } catch (error) {
    return codexCompletionFailure(
      "binding_identity_mismatch",
      error,
      diagnostics
    );
  }
  if (!current.rollout) {
    return codexCompletionFailure(
      "rollout_identity_mismatch",
      new Error(
        "the accepted Codex Turn lost its persisted exact rollout identity"
      ),
      diagnostics
    );
  }

  let rollout: CodexRolloutIdentity;
  try {
    rollout = normalizedRolloutIdentity(current.rollout);
  } catch (error) {
    return codexCompletionFailure(
      "rollout_identity_mismatch",
      error,
      diagnostics
    );
  }
  const rolloutDiagnostics = {
    ...diagnostics,
    rollout_identity_fingerprint: fingerprint(rollout)
  };
  const anchoredRollout = anchor.version === 3
    ? acceptedCandidate?.rollout
    : anchor.rollout;
  if (anchoredRollout && !sameRolloutIdentity(anchoredRollout, rollout)) {
    return codexCompletionFailure(
      "rollout_identity_mismatch",
      new Error("Codex rollout identity changed after terminal acceptance"),
      rolloutDiagnostics
    );
  }

  let opened: ReturnType<typeof openExactRollout>;
  try {
    opened = openExactRollout(rollout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return codexCompletionFailure(
      /identity does not match/u.test(message)
        ? "rollout_identity_mismatch"
        : "rollout_unreadable",
      error,
      rolloutDiagnostics
    );
  }

  try {
    const before = opened.stat;
    try {
      assertPrivateRegularFile(before);
    } catch (error) {
      return codexCompletionFailure(
        "rollout_unreadable",
        error,
        rolloutDiagnostics
      );
    }
    let evidenceEndOffset: number | undefined;
    try {
      evidenceEndOffset = optionalSafeOffset(
        acceptance.metadata?.observed_end_offset_bytes
      );
    } catch (error) {
      return codexCompletionFailure(
        "invalid_acceptance_evidence",
        error,
        rolloutDiagnostics
      );
    }
    if (
      before.size < scanStartOffset ||
      (evidenceEndOffset !== undefined && before.size < evidenceEndOffset)
    ) {
      return codexCompletionFailure(
        "rollout_truncated",
        new Error("Codex rollout was truncated after native acceptance"),
        {
          ...rolloutDiagnostics,
          observed_end_offset_bytes: before.size
        }
      );
    }
    const bytesToRead = before.size - scanStartOffset;
    const observedDiagnostics = {
      ...rolloutDiagnostics,
      observed_end_offset_bytes: before.size
    };
    if (bytesToRead > CODEX_COMPLETION_MAX_BYTES) {
      return codexCompletionFailure(
        "scan_limit_exceeded",
        new Error("Codex bound completion suffix exceeded the safe scan limit"),
        observedDiagnostics
      );
    }
    if (bytesToRead === 0) {
      return codexCompletionPending(
        "exact_turn_not_complete",
        observedDiagnostics,
        "no post-anchor Codex rollout records are available yet"
      );
    }
    if (!fileEndsWithNewline(opened.fd, before.size)) {
      return codexCompletionPending(
        "partial_rollout_record",
        observedDiagnostics,
        "the exact Codex rollout ends with a partial JSONL record"
      );
    }

    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(
      opened.fd,
      buffer,
      0,
      bytesToRead,
      scanStartOffset
    );
    const after = fs.fstatSync(opened.fd);
    if (bytesRead !== bytesToRead || !sameStableFile(before, after)) {
      return codexCompletionPending(
        "rollout_changed_during_scan",
        observedDiagnostics,
        "the exact Codex rollout changed while completion was scanned"
      );
    }

    const scan = scanExactCodexTaskComplete(
      buffer.toString("utf8"),
      acceptanceId
    );
    const scanDiagnostics = {
      ...observedDiagnostics,
      scanned_records: scan.scannedRecords,
      observed_task_complete_records: scan.observedTaskCompleteRecords
    };
    if (scan.status === "failure") {
      return codexCompletionFailure(scan.code, scan.detail, scanDiagnostics);
    }
    if (scan.status === "pending") {
      return codexCompletionPending(
        "exact_turn_not_complete",
        scanDiagnostics,
        "the accepted Codex native turn has no durable task_complete record yet"
      );
    }

    const completion: TerminalCompletionEvidence = {
      source: "durable",
      outcome: "success",
      text: truncateCompletionText(redactString(scan.text)),
      ...(scan.timestamp ? { timestamp: scan.timestamp } : {}),
      id: acceptanceId,
      confidence: "high",
      metadata: {
        match: "bound_rollout_task_complete",
        turn_id: acceptanceId,
        native_thread_id: expectedNativeThreadId,
        anchor_fingerprint: anchor.anchor_fingerprint,
        rollout_identity_fingerprint:
          rolloutDiagnostics.rollout_identity_fingerprint,
        scan_start_offset_bytes: scanStartOffset,
        observed_end_offset_bytes: before.size,
        scanned_records: scan.scannedRecords,
        observed_task_complete_records: scan.observedTaskCompleteRecords
      }
    };
    return {
      status: "completed",
      completion,
      diagnostics: {
        ...scanDiagnostics,
        code: "completion_found"
      }
    };
  } catch (error) {
    return codexCompletionFailure(
      "rollout_unreadable",
      error,
      rolloutDiagnostics
    );
  } finally {
    try {
      fs.closeSync(opened.fd);
    } catch {
      // The scan result is already fenced by the descriptor identity and both
      // file snapshots. A close failure cannot make it safe to retry a native
      // turn, so do not replace that deterministic result with an exception.
    }
  }
}

type ExactCodexTaskCompleteScan =
  | {
      status: "completed";
      text: string;
      timestamp?: string;
      scannedRecords: number;
      observedTaskCompleteRecords: number;
    }
  | {
      status: "pending";
      scannedRecords: number;
      observedTaskCompleteRecords: number;
    }
  | {
      status: "failure";
      code:
        | "invalid_rollout_jsonl"
        | "duplicate_exact_completion"
        | "invalid_exact_completion";
      detail: string;
      scannedRecords: number;
      observedTaskCompleteRecords: number;
    };

function scanExactCodexTaskComplete(
  text: string,
  acceptanceId: string
): ExactCodexTaskCompleteScan {
  let scannedRecords = 0;
  let observedTaskCompleteRecords = 0;
  const exactMatches: Array<Record<string, any>> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return {
        status: "failure",
        code: "invalid_rollout_jsonl",
        detail: `Codex bound completion suffix contains invalid JSONL at record ${scannedRecords + 1}`,
        scannedRecords,
        observedTaskCompleteRecords
      };
    }
    scannedRecords += 1;
    if (
      !isRecord(value) ||
      value.type !== "event_msg" ||
      !isRecord(value.payload) ||
      value.payload.type !== "task_complete"
    ) {
      continue;
    }
    observedTaskCompleteRecords += 1;
    const turnId = optionalString(value.payload.turn_id)?.toLowerCase();
    if (turnId === acceptanceId) {
      exactMatches.push(value);
    }
  }

  if (exactMatches.length === 0) {
    return {
      status: "pending",
      scannedRecords,
      observedTaskCompleteRecords
    };
  }
  if (exactMatches.length > 1) {
    return {
      status: "failure",
      code: "duplicate_exact_completion",
      detail: "the exact accepted Codex turn has duplicate task_complete records",
      scannedRecords,
      observedTaskCompleteRecords
    };
  }

  const match = exactMatches[0];
  const payload = match.payload as Record<string, any>;
  const textValue = optionalString(payload.last_agent_message);
  if (!textValue) {
    return {
      status: "failure",
      code: "invalid_exact_completion",
      detail: "the exact Codex task_complete record has no final agent message",
      scannedRecords,
      observedTaskCompleteRecords
    };
  }
  if (match.timestamp !== undefined && !validTimestamp(match.timestamp)) {
    return {
      status: "failure",
      code: "invalid_exact_completion",
      detail: "the exact Codex task_complete record has an invalid timestamp",
      scannedRecords,
      observedTaskCompleteRecords
    };
  }
  return {
    status: "completed",
    text: textValue,
    ...(match.timestamp !== undefined
      ? { timestamp: String(match.timestamp) }
      : {}),
    scannedRecords,
    observedTaskCompleteRecords
  };
}

function codexCompletionPending(
  code: Extract<
    CodexBoundRolloutCompletionCode,
    | "exact_turn_not_complete"
    | "partial_rollout_record"
    | "rollout_changed_during_scan"
  >,
  diagnostics: Omit<CodexBoundRolloutCompletionDiagnostics, "code">,
  detail: string
): CodexBoundRolloutCompletionResult {
  return {
    status: "pending",
    diagnostics: {
      ...diagnostics,
      code,
      detail
    }
  };
}

function codexCompletionFailure(
  code: Exclude<
    CodexBoundRolloutCompletionCode,
    | "completion_found"
    | "exact_turn_not_complete"
    | "partial_rollout_record"
    | "rollout_changed_during_scan"
  >,
  error: unknown,
  diagnostics: Omit<CodexBoundRolloutCompletionDiagnostics, "code"> = {
    detector: "codex_exact_bound_rollout"
  }
): CodexBoundRolloutCompletionResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    status: "failure",
    diagnostics: {
      ...diagnostics,
      code,
      detail: truncateCompletionText(redactString(detail))
    }
  };
}

function optionalSafeOffset(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Codex acceptance evidence byte offset is invalid");
  }
  return Number(value);
}

function truncateCompletionText(value: string): string {
  return value.length <= CODEX_COMPLETION_MAX_TEXT_LENGTH
    ? value
    : `${value.slice(0, CODEX_COMPLETION_MAX_TEXT_LENGTH - 1)}…`;
}

function acceptedCodexTurnFromSuffix(
  text: string,
  requestHash: string
): { turnId: string; startedAt?: string; userTimestamp?: string } | undefined {
  const startedTurns = new Map<string, { startedAt?: string }>();
  const matches: Array<{
    turnId: string;
    startedAt?: string;
    userTimestamp?: string;
  }> = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Codex rollout acceptance suffix contains invalid JSONL");
    }
    if (!isRecord(value) || !isRecord(value.payload)) {
      continue;
    }
    const payload = value.payload;
    if (value.type === "event_msg" && payload.type === "task_started") {
      const turnId = exactNativeThreadId(payload.turn_id);
      if (startedTurns.has(turnId)) {
        throw new Error("Codex rollout contains duplicate post-anchor task_started evidence");
      }
      startedTurns.set(turnId, {
        ...(validTimestamp(value.timestamp)
          ? { startedAt: String(value.timestamp) }
          : {})
      });
      continue;
    }
    if (
      value.type !== "response_item" ||
      payload.type !== "message" ||
      payload.role !== "user"
    ) {
      continue;
    }
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : undefined;
    const rawTurnId = optionalString(metadata?.turn_id);
    const userText = exactCodexUserResponseText(payload.content);
    if (!rawTurnId || userText === undefined) {
      continue;
    }
    const turnId = exactNativeThreadId(rawTurnId);
    if (fingerprintText(userText) !== requestHash) {
      continue;
    }
    const started = startedTurns.get(turnId);
    if (!started) {
      throw new Error(
        "matching Codex user response has no same-turn post-anchor task_started evidence"
      );
    }
    matches.push({
      turnId,
      ...started,
      ...(validTimestamp(value.timestamp)
        ? { userTimestamp: String(value.timestamp) }
        : {})
    });
  }
  if (matches.length > 1) {
    throw new Error("multiple Codex native turns matched the terminal request");
  }
  return matches[0];
}

type CodexAcceptanceRolloutScan =
  | { status: "pending" }
  | { status: "incomplete" }
  | {
      status: "accepted";
      evidence: TerminalSubmissionAcceptanceEvidence;
    };

function scanCodexRolloutAcceptance({
  rollout: rolloutValue,
  nativeThreadId: nativeThreadIdValue,
  processUuid: processUuidValue,
  processBirth: processBirthValue,
  requestHash,
  anchorFingerprint,
  offsetBytes,
  requireFreshHeader,
  capturedAt
}: {
  rollout: CodexRolloutIdentity;
  nativeThreadId: string;
  processUuid: string;
  processBirth: string;
  requestHash: string;
  anchorFingerprint: string;
  offsetBytes: number;
  requireFreshHeader: boolean;
  capturedAt: string;
}): CodexAcceptanceRolloutScan {
  const rollout = normalizedRolloutIdentity(rolloutValue);
  const nativeThreadId = exactNativeThreadId(nativeThreadIdValue);
  requiredString(processUuidValue, "Codex process UUID");
  requiredString(processBirthValue, "Codex process birth");
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
    throw new Error("Codex rollout acceptance byte offset is invalid");
  }
  const opened = openExactRollout(rollout);
  try {
    const before = opened.stat;
    assertPrivateRegularFile(before);
    if (before.size < offsetBytes) {
      throw new Error("Codex rollout was truncated after terminal submission");
    }
    const bytesToRead = before.size - offsetBytes;
    if (bytesToRead === 0) {
      return { status: "pending" };
    }
    if (bytesToRead > CODEX_ACCEPTANCE_MAX_BYTES) {
      throw new Error(
        "Codex rollout acceptance suffix exceeded the bounded read limit"
      );
    }
    if (!fileEndsWithNewline(opened.fd, before.size)) {
      return { status: "incomplete" };
    }
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(
      opened.fd,
      buffer,
      0,
      bytesToRead,
      offsetBytes
    );
    if (bytesRead !== bytesToRead) {
      return { status: "incomplete" };
    }
    const after = fs.fstatSync(opened.fd);
    if (!sameStableFile(before, after)) {
      return { status: "incomplete" };
    }
    const suffix = buffer.toString("utf8");
    if (requireFreshHeader) {
      assertVirginRolloutHeader({
        text: suffix,
        nativeThreadId,
        capturedAt
      });
    }
    const accepted = acceptedCodexTurnFromSuffix(suffix, requestHash);
    if (!accepted) {
      return { status: "pending" };
    }
    const evidenceBase = {
      source: "codex_rollout" as const,
      kind: "native_user_turn" as const,
      nativeThreadId,
      requestHash,
      acceptanceId: accepted.turnId,
      acceptedAt: accepted.userTimestamp ?? accepted.startedAt,
      anchorFingerprint,
      metadata: {
        turn_id: accepted.turnId,
        anchor_offset_bytes: offsetBytes,
        observed_end_offset_bytes: before.size
      }
    };
    return {
      status: "accepted",
      evidence: {
        ...evidenceBase,
        evidenceFingerprint: fingerprint(evidenceBase)
      }
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function exactCodexUserResponseText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }
  const item = content[0];
  return isRecord(item) && item.type === "input_text" &&
    typeof item.text === "string"
    ? item.text
    : undefined;
}

function assertVirginRolloutHeader(options: {
  text: string;
  nativeThreadId: string;
  capturedAt: string;
}): void {
  const firstLine = options.text.split("\n").find((line) => line.trim() !== "");
  if (!firstLine) {
    throw new Error("virgin Codex rollout has no session metadata");
  }
  let record: unknown;
  try {
    record = JSON.parse(firstLine);
  } catch {
    throw new Error("virgin Codex rollout starts with invalid session metadata");
  }
  const payload = isRecord(record) && record.type === "session_meta" &&
    isRecord(record.payload)
    ? record.payload
    : undefined;
  if (
    !payload ||
    exactNativeThreadId(String(payload.id ?? "")) !== options.nativeThreadId ||
    payload.originator !== "codex-tui" ||
    payload.source !== "cli"
  ) {
    throw new Error(
      "virgin Codex rollout metadata does not identify the newly materialized CLI thread"
    );
  }
  const materializedAt = isRecord(record) ? record.timestamp : undefined;
  if (
    !validTimestamp(materializedAt) ||
    Date.parse(String(materializedAt)) < Date.parse(options.capturedAt)
  ) {
    throw new Error(
      "virgin Codex rollout predates its terminal submission anchor"
    );
  }
}

function validateCodexOpenRootInventoryForAcceptance(
  value: CodexOpenRootRolloutInventory
): CodexOpenRootRolloutInventory {
  if (
    !isRecord(value) ||
    value.schema !==
      "agent-knock-knock/codex-open-root-rollout-inventory" ||
    value.version !== 1 ||
    !["verified_absent", "resolved", "unbound"].includes(
      String(value.status)
    ) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    !Array.isArray(value.roots) ||
    value.roots.length > 128 ||
    !/^[0-9a-f]{64}$/u.test(String(value.inventoryFingerprint))
  ) {
    throw new Error("Codex open-root rollout inventory is invalid");
  }
  requiredString(value.processUuid, "Codex process UUID");
  requiredString(value.processBirth, "Codex process birth");
  if (
    value.processUuid !==
      `codex-pid:${value.pid}:birth:${value.processBirth}`
  ) {
    throw new Error("Codex open-root rollout inventory process UUID is inconsistent");
  }
  if (value.cwd !== undefined && !path.isAbsolute(value.cwd)) {
    throw new Error("Codex open-root rollout inventory cwd is not absolute");
  }
  if (
    (value.status === "verified_absent" && value.roots.length !== 0) ||
    (value.status === "resolved" && value.roots.length !== 1) ||
    (
      value.status === "unbound" &&
      (
        value.roots.length < 2 ||
        value.reason !== "multiple_open_root_rollouts"
      )
    )
  ) {
    throw new Error("Codex open-root rollout inventory status is inconsistent");
  }
  const seenThreads = new Set<string>();
  const seenFiles = new Set<string>();
  for (const identity of value.roots) {
    if (!isRecord(identity)) {
      throw new Error("Codex open-root rollout inventory identity is invalid");
    }
    const nativeThreadId = exactNativeThreadId(identity.sessionId);
    if (
      identity.processUuid !== value.processUuid ||
      identity.processBirth !== value.processBirth ||
      identity.evidence !== "codex_open_root_rollout"
    ) {
      throw new Error(
        "Codex open-root rollout inventory has mixed process authority"
      );
    }
    const rollout = normalizedRolloutIdentity(identity.rollout);
    if (
      seenThreads.has(nativeThreadId) ||
      seenFiles.has(`${rollout.device}:${rollout.inode}`)
    ) {
      throw new Error("Codex open-root rollout inventory is ambiguous");
    }
    seenThreads.add(nativeThreadId);
    seenFiles.add(`${rollout.device}:${rollout.inode}`);
  }
  const { status: _status, inventoryFingerprint, reason: _reason, ...authority } =
    value as CodexOpenRootRolloutInventory & { reason?: string };
  if (fingerprint(authority) !== inventoryFingerprint) {
    throw new Error(
      "Codex open-root rollout inventory fingerprint does not match"
    );
  }
  return value;
}

function openExactRollout(rollout: CodexRolloutIdentity): {
  fd: number;
  stat: fs.Stats;
} {
  if (!path.isAbsolute(rollout.path)) {
    throw new Error("Codex rollout path is not absolute");
  }
  const before = fs.lstatSync(rollout.path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Codex rollout path is not a regular file");
  }
  const fd = fs.openSync(
    rollout.path,
    fs.constants.O_RDONLY | NO_FOLLOW_FLAG
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      BigInt(stat.dev) !== parsedInteger(rollout.device) ||
      BigInt(stat.ino) !== parsedInteger(rollout.inode)
    ) {
      throw new Error("Codex rollout descriptor identity does not match its open file");
    }
    return { fd, stat };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertPrivateRegularFile(stat: fs.Stats): void {
  if (!stat.isFile()) {
    throw new Error("Codex rollout is not a regular file");
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error("Codex rollout is not owned by the current user");
  }
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error("Codex rollout is writable by another user");
  }
}

function fileEndsWithNewline(fd: number, size: number): boolean {
  if (size <= 0) {
    return true;
  }
  const last = Buffer.allocUnsafe(1);
  return fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a;
}

function byteAtOffset(fd: number, offset: number): number | undefined {
  const buffer = Buffer.allocUnsafe(1);
  return fs.readSync(fd, buffer, 0, 1, offset) === 1
    ? buffer[0]
    : undefined;
}

function isRetryableProviderIoError(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== "string") {
    return false;
  }
  return new Set([
    "EACCES", "EAGAIN", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOENT",
    "EPERM", "ESTALE", "ETIMEDOUT"
  ]).has(error.code);
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function sameRolloutIdentity(
  left: CodexRolloutIdentity,
  right: CodexRolloutIdentity
): boolean {
  return left.fd === right.fd &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.path === right.path;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
