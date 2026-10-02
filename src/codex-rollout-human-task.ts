// Observation of exact Codex tasks started by the user in the TUI.
import {
  assertPrivateRegularFile,
  byteAtOffset,
  CODEX_COMPLETION_MAX_BYTES,
  fileEndsWithNewline,
  openExactRollout,
  readCodexRolloutHeader,
  readExactBytes,
  sameRolloutIdentity,
  sameStableFile,
} from "./codex-rollout-file.js";
import {
  assertCodexRolloutLegacyHistory,
  assertExistingCodexRolloutHeader,
  CODEX_VERSION_PATTERN,
  type CodexJsonlRecordAtOffset,
  exactCodexUserResponseText,
  fingerprintText,
  isRecord,
  isRetryableProviderIoError,
  optionalString,
  parseCodexJsonlRecords,
  positiveByteLimit,
  safeByteOffset,
  scanExactCodexTaskComplete,
  truncateCompletionText,
} from "./codex-rollout-records.js";
import {
  redactString,
} from "./runtime-log.js";
import {
  type TerminalCompletionEvidence,
} from "./terminal-agent-adapter.js";
import {
  type CodexRolloutAcceptanceIdentity,
  type CodexRolloutIdentity,
  exactNativeThreadId,
  fingerprint,
  normalizedRolloutIdentity,
  requiredString,
  sha256Value,
  validTimestamp,
} from "./terminal-submission-facts.js";
import fs from "node:fs";
import path from "node:path";

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

const CODEX_ACTIVE_TASK_SCAN_CHUNK_BYTES = 64 * 1024;

const CODEX_ACTIVE_TASK_MAX_RECORD_BYTES = 16 * 1024 * 1024;

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
      assertCodexRolloutLegacyHistory(readCodexRolloutHeader(opened.fd, before.size));
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
        isLaterCodexHumanTaskStartedRecord(value)
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
      if (completion.status === "aborted") {
        throw new Error(
          "Codex active-task abort evidence escaped its exact lifecycle fence"
        );
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
  pairingIssue?: "hash_mismatch" | "turn_mismatch" | "unsupported";
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
  let userMessageRecordCount = 0;
  let cursor = endOffset;
  let leadingRecord = Buffer.alloc(0);
  let followingRecord: CodexJsonlRecordAtOffset | undefined;

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
      const absoluteRecord = {
        value: record.value,
        offsetBytes: recordsOffset + record.offsetBytes
      };
      if (isCodexUserMessageRecord(absoluteRecord.value)) {
        userMessageRecordCount += 1;
      }
      const decision = inspectCodexActiveTaskRecordInReverse(
        absoluteRecord,
        terminalTurns,
        userRecords,
        userMessageRecordCount,
        followingRecord
      );
      if (decision.status === "resolved") {
        return decision.active;
      }
      followingRecord = absoluteRecord;
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
  userRecords: CodexActiveTaskUserRecord[],
  userMessageRecordCount: number,
  followingRecord: CodexJsonlRecordAtOffset | undefined
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
  if (isCodexUserResponseRecord(value)) {
    const userRecord = pairedCodexActiveTaskUserRecord(
      record,
      followingRecord
    );
    if (userRecord) {
      userRecords.push(userRecord);
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
  if (userMessageRecordCount === 0) {
    return { status: "resolved" };
  }
  if (userMessageRecordCount !== 1) {
    throw new Error("Codex active task has multiple user_message events");
  }
  const matchingUsers = userRecords.filter((user) => user.turnId === turnId);
  if (matchingUsers.length === 0) {
    throw new Error(
      "Codex active task has no exact adjacent root user row for its user_message event"
    );
  }
  if (matchingUsers.length !== 1) {
    throw new Error("Codex active task has multiple same-turn root user rows");
  }
  const [user] = matchingUsers;
  if (user.pairingIssue === "hash_mismatch") {
    throw new Error(
      "Codex active-task root user row does not match its user_message event"
    );
  }
  if (user.pairingIssue === "turn_mismatch") {
    throw new Error(
      "Codex active-task root user row does not match its adjacent UserMessage turn"
    );
  }
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

function pairedCodexActiveTaskUserRecord(
  record: CodexJsonlRecordAtOffset,
  followingRecord: CodexJsonlRecordAtOffset | undefined
): CodexActiveTaskUserRecord | undefined {
  const payload = isRecord(record.value.payload)
    ? record.value.payload
    : undefined;
  const metadata = payload &&
      isRecord(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : undefined;
  const rawTurnId = optionalString(metadata?.turn_id);
  // Codex writes one provider-owned user-message event immediately after the
  // human root response row. Older rollouts use event_msg.user_message; newer
  // Codex surfaces use event_msg.item_completed with item.type=UserMessage.
  // Synthetic user-role context has no such adjacent proof.
  if (
    !payload ||
    !rawTurnId ||
    !isCodexUserMessageRecord(followingRecord?.value)
  ) {
    return undefined;
  }
  const text = exactCodexUserResponseText(payload.content);
  const requestHash = text === undefined ? undefined : fingerprintText(text);
  const userMessageHash = codexUserMessageHash(followingRecord?.value);
  const adjacentTurnId = codexUserMessageTurnId(followingRecord?.value);
  const rootTurnId = exactNativeThreadId(rawTurnId);
  const pairingIssue = adjacentTurnId !== undefined &&
      exactNativeThreadId(adjacentTurnId) !== rootTurnId
    ? "turn_mismatch" as const
    : requestHash === undefined || userMessageHash === undefined
    ? "unsupported" as const
    : requestHash !== userMessageHash
      ? "hash_mismatch" as const
      : undefined;
  return {
    offsetBytes: record.offsetBytes,
    turnId: rootTurnId,
    ...(pairingIssue ? { pairingIssue } : { requestHash })
  };
}

function isCodexUserResponseRecord(value: Record<string, any>): boolean {
  const payload = isRecord(value.payload) ? value.payload : undefined;
  return value.type === "response_item" &&
    payload?.type === "message" &&
    payload.role === "user";
}

function codexUserMessageHash(
  value: Record<string, any> | undefined
): string | undefined {
  const payload = value && isRecord(value.payload) ? value.payload : undefined;
  if (
    value?.type === "event_msg" &&
    payload?.type === "user_message" &&
    typeof payload.message === "string"
  ) {
    return fingerprintText(payload.message);
  }
  const item = payload?.type === "item_completed" && isRecord(payload.item)
    ? payload.item
    : undefined;
  const content = item?.type === "UserMessage" && Array.isArray(item.content)
    ? item.content
    : undefined;
  if (!content || content.length !== 1) return undefined;
  const text = content[0];
  return isRecord(text) && text.type === "text" &&
      typeof text.text === "string"
    ? fingerprintText(text.text)
    : undefined;
}

function codexUserMessageTurnId(
  value: Record<string, any> | undefined
): string | undefined {
  const payload = value && isRecord(value.payload) ? value.payload : undefined;
  return value?.type === "event_msg" &&
      payload?.type === "item_completed" &&
      isRecord(payload.item) &&
      payload.item.type === "UserMessage"
    ? optionalString(payload.turn_id)
    : undefined;
}

function isCodexUserMessageRecord(
  value: Record<string, any> | undefined
): boolean {
  const payload = value && isRecord(value.payload) ? value.payload : undefined;
  return value?.type === "event_msg" &&
    (
      payload?.type === "user_message" ||
      (
        payload?.type === "item_completed" &&
        isRecord(payload.item) &&
        payload.item.type === "UserMessage"
      )
    );
}

function isLaterCodexHumanTaskStartedRecord(
  value: Record<string, any>
): boolean {
  const payload = isRecord(value.payload) ? value.payload : undefined;
  // User-role response rows can be same-turn synthetic context. Only a fresh
  // task_started record is authoritative evidence that the anchor was passed.
  return value.type === "event_msg" &&
    payload?.type === "task_started";
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
