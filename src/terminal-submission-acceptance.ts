import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactString } from "./runtime-log.js";
import type { TerminalCompletionEvidence } from "./terminal-agent-adapter.js";

export interface TerminalSubmissionAcceptanceEvidence {
  source: "codex_rollout" | "claude_transcript";
  kind: "native_user_turn";
  nativeThreadId: string;
  requestHash: string;
  acceptanceId: string;
  acceptedAt?: string;
  anchorFingerprint: string;
  evidenceFingerprint: string;
  metadata?: Record<string, string | number>;
}

export interface CodexRolloutIdentity {
  fd: string;
  device: string;
  inode: string;
  path: string;
}

export interface CodexRolloutAcceptanceAnchor {
  schema: "agent-knock-knock/codex-rollout-acceptance-anchor";
  version: 1;
  native_thread_id: string;
  process_uuid: string;
  process_birth: string;
  captured_at: string;
  mode: "existing" | "pre_materialization";
  file_existed: boolean;
  offset_bytes: number;
  rollout?: CodexRolloutIdentity;
  expected_empty_native_session?: true;
  anchor_fingerprint: string;
}

export interface CodexRolloutAcceptanceIdentity {
  sessionId: string;
  processUuid?: string;
  processBirth?: string;
  rollout?: CodexRolloutIdentity;
}

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

export function validateTerminalSubmissionAcceptanceEvidence(
  value: unknown,
  expected: {
    source: TerminalSubmissionAcceptanceEvidence["source"];
    nativeThreadId: string;
    requestHash: string;
  }
): TerminalSubmissionAcceptanceEvidence {
  if (!isRecord(value)) {
    throw new Error("native acceptance evidence is unavailable");
  }
  const allowedKeys = new Set([
    "source",
    "kind",
    "nativeThreadId",
    "requestHash",
    "acceptanceId",
    "acceptedAt",
    "anchorFingerprint",
    "evidenceFingerprint",
    "metadata"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("native acceptance evidence contains unsupported fields");
  }
  if (value.source !== expected.source || value.kind !== "native_user_turn") {
    throw new Error("native acceptance evidence has the wrong agent or kind");
  }
  if (
    requiredString(value.nativeThreadId, "native acceptance thread") !==
      requiredString(expected.nativeThreadId, "expected native acceptance thread") ||
    sha256Value(value.requestHash, "native acceptance request hash") !==
      sha256Value(expected.requestHash, "expected native acceptance request hash")
  ) {
    throw new Error("native acceptance evidence does not match the exact request binding");
  }
  requiredString(value.acceptanceId, "native acceptance id");
  sha256Value(value.anchorFingerprint, "native acceptance anchor fingerprint");
  sha256Value(value.evidenceFingerprint, "native acceptance evidence fingerprint");
  if (value.acceptedAt !== undefined && !validTimestamp(value.acceptedAt)) {
    throw new Error("native acceptance evidence timestamp is invalid");
  }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) {
      throw new Error("native acceptance evidence metadata is invalid");
    }
    const allowedMetadata = value.source === "codex_rollout"
      ? new Set([
          "turn_id",
          "anchor_offset_bytes",
          "observed_end_offset_bytes"
        ])
      : new Set([
          "prompt_uuid",
          "claude_version",
          "transcript_file_id",
          "anchor_offset_bytes",
          "observed_end_offset_bytes",
          "agent_started_at_ms"
        ]);
    for (const [key, item] of Object.entries(value.metadata)) {
      if (
        !allowedMetadata.has(key) ||
        !(
          typeof item === "string" ||
          (typeof item === "number" && Number.isFinite(item))
        )
      ) {
        throw new Error("native acceptance evidence metadata is not allowlisted");
      }
    }
  }
  const { evidenceFingerprint, ...base } = value;
  if (fingerprint(base) !== evidenceFingerprint) {
    throw new Error("native acceptance evidence fingerprint does not match");
  }
  return value as unknown as TerminalSubmissionAcceptanceEvidence;
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
  status: "async_pending" | "submission_pending_acceptance" | "submission_uncertain";
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

const CODEX_ACCEPTANCE_MAX_BYTES = 16 * 1024 * 1024;
const CODEX_COMPLETION_MAX_BYTES = 256 * 1024 * 1024;
const CODEX_COMPLETION_MAX_TEXT_LENGTH = 4000;
const NATIVE_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;

type CaptureCodexRolloutAcceptanceAnchorOptions = {
  nativeThreadId: string;
  processUuid: string;
  processBirth: string;
  now?: Date;
} & (
  | { mode: "existing"; rollout: CodexRolloutIdentity }
  | { mode: "pre_materialization"; expectedEmptyNativeSession: true }
);

export function captureCodexRolloutAcceptanceAnchor(
  options: CaptureCodexRolloutAcceptanceAnchorOptions
): CodexRolloutAcceptanceAnchor {
  const nativeThreadId = exactNativeThreadId(options.nativeThreadId);
  const processUuid = requiredString(options.processUuid, "Codex process UUID");
  const processBirth = requiredString(options.processBirth, "Codex process birth");
  const capturedAt = (options.now ?? new Date()).toISOString();
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

export function detectCodexRolloutAcceptance(options: {
  anchor: CodexRolloutAcceptanceAnchor;
  currentIdentity: CodexRolloutAcceptanceIdentity;
  requestHash: string;
}): TerminalSubmissionAcceptanceEvidence | undefined {
  const anchor = validateCodexRolloutAcceptanceAnchor(options.anchor);
  const requestHash = sha256Value(options.requestHash, "terminal request hash");
  const current = options.currentIdentity;
  if (
    exactNativeThreadId(current.sessionId) !== anchor.native_thread_id ||
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

  const opened = openExactRollout(rollout);
  try {
    const before = opened.stat;
    assertPrivateRegularFile(before);
    if (before.size < anchor.offset_bytes) {
      throw new Error("Codex rollout was truncated after terminal submission");
    }
    const bytesToRead = before.size - anchor.offset_bytes;
    if (bytesToRead === 0) {
      return undefined;
    }
    if (bytesToRead > CODEX_ACCEPTANCE_MAX_BYTES) {
      throw new Error("Codex rollout acceptance suffix exceeded the bounded read limit");
    }
    if (!fileEndsWithNewline(opened.fd, before.size)) {
      return undefined;
    }
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(
      opened.fd,
      buffer,
      0,
      bytesToRead,
      anchor.offset_bytes
    );
    if (bytesRead !== bytesToRead) {
      return undefined;
    }
    const after = fs.fstatSync(opened.fd);
    if (!sameStableFile(before, after)) {
      return undefined;
    }
    const accepted = acceptedCodexTurnFromSuffix(
      buffer.toString("utf8"),
      requestHash
    );
    if (!accepted) {
      return undefined;
    }
    const evidenceBase = {
      source: "codex_rollout" as const,
      kind: "native_user_turn" as const,
      nativeThreadId: anchor.native_thread_id,
      requestHash,
      acceptanceId: accepted.turnId,
      acceptedAt: accepted.userTimestamp ?? accepted.startedAt,
      anchorFingerprint: anchor.anchor_fingerprint,
      metadata: {
        turn_id: accepted.turnId,
        anchor_offset_bytes: anchor.offset_bytes,
        observed_end_offset_bytes: before.size
      }
    };
    return {
      ...evidenceBase,
      evidenceFingerprint: fingerprint(evidenceBase)
    };
  } finally {
    fs.closeSync(opened.fd);
  }
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

  const baseDiagnostics: Omit<CodexBoundRolloutCompletionDiagnostics, "code"> = {
    detector: "codex_exact_bound_rollout",
    native_thread_id: anchor.native_thread_id,
    anchor_fingerprint: anchor.anchor_fingerprint,
    scan_start_offset_bytes: anchor.offset_bytes
  };
  let requestHash: string;
  let acceptance: TerminalSubmissionAcceptanceEvidence;
  try {
    requestHash = sha256Value(options.requestHash, "terminal request hash");
    acceptance = validateTerminalSubmissionAcceptanceEvidence(
      options.acceptanceEvidence,
      {
        source: "codex_rollout",
        nativeThreadId: anchor.native_thread_id,
        requestHash
      }
    );
  } catch (error) {
    return codexCompletionFailure(
      "invalid_acceptance_evidence",
      error,
      baseDiagnostics
    );
  }

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
    evidenceAnchorOffset !== anchor.offset_bytes
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
      exactNativeThreadId(current.sessionId) !== anchor.native_thread_id ||
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
  if (anchor.rollout && !sameRolloutIdentity(anchor.rollout, rollout)) {
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
      before.size < anchor.offset_bytes ||
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
    const bytesToRead = before.size - anchor.offset_bytes;
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
      anchor.offset_bytes
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
        native_thread_id: anchor.native_thread_id,
        anchor_fingerprint: anchor.anchor_fingerprint,
        rollout_identity_fingerprint:
          rolloutDiagnostics.rollout_identity_fingerprint,
        scan_start_offset_bytes: anchor.offset_bytes,
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

function validateCodexRolloutAcceptanceAnchor(
  value: CodexRolloutAcceptanceAnchor
): CodexRolloutAcceptanceAnchor {
  if (
    !isRecord(value) ||
    value.schema !== "agent-knock-knock/codex-rollout-acceptance-anchor" ||
    value.version !== 1 ||
    !["existing", "pre_materialization"].includes(String(value.mode)) ||
    !Number.isSafeInteger(value.offset_bytes) ||
    value.offset_bytes < 0 ||
    typeof value.file_existed !== "boolean"
  ) {
    throw new Error("Codex rollout acceptance anchor is invalid");
  }
  exactNativeThreadId(value.native_thread_id);
  requiredString(value.process_uuid, "Codex process UUID");
  requiredString(value.process_birth, "Codex process birth");
  if (!validTimestamp(value.captured_at)) {
    throw new Error("Codex acceptance capture timestamp is invalid");
  }
  sha256Value(value.anchor_fingerprint, "Codex acceptance anchor fingerprint");
  const { anchor_fingerprint: _fingerprint, ...base } = value;
  if (fingerprint(base) !== value.anchor_fingerprint) {
    throw new Error("Codex rollout acceptance anchor fingerprint does not match");
  }
  if (
    value.file_existed !== (value.mode === "existing") ||
    value.file_existed !== Boolean(value.rollout)
  ) {
    throw new Error("Codex rollout acceptance anchor file state is inconsistent");
  }
  if (value.mode === "existing" && value.rollout) {
    normalizedRolloutIdentity(value.rollout);
    if (value.expected_empty_native_session !== undefined) {
      throw new Error("existing Codex acceptance anchor has pre-materialization state");
    }
  } else if (
    value.offset_bytes !== 0 ||
    value.rollout !== undefined ||
    value.expected_empty_native_session !== true
  ) {
    throw new Error("Codex pre-materialization acceptance anchor is inconsistent");
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

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function normalizedRolloutIdentity(
  value: CodexRolloutIdentity
): CodexRolloutIdentity {
  const normalized = {
    fd: requiredString(value.fd, "Codex rollout descriptor"),
    device: requiredString(value.device, "Codex rollout device"),
    inode: requiredString(value.inode, "Codex rollout inode"),
    path: requiredString(value.path, "Codex rollout path")
  };
  parsedInteger(normalized.device);
  parsedInteger(normalized.inode);
  return normalized;
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

function exactNativeThreadId(value: unknown): string {
  const text = requiredString(value, "Codex native thread ID").toLowerCase();
  if (!NATIVE_THREAD_ID_PATTERN.test(text)) {
    throw new Error("Codex native thread ID is not an exact UUID");
  }
  return text;
}

function parsedInteger(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error("Codex rollout file identity is not numeric");
  }
}

function sha256Value(value: unknown, label: string): string {
  const text = requiredString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(text)) {
    throw new Error(`${label} is not a SHA-256 value`);
  }
  return text;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is unavailable`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
