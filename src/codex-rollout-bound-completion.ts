// Completion proof for one already-accepted legacy Codex turn.
import {
  assertPrivateRegularFile,
  CODEX_COMPLETION_MAX_BYTES,
  fileEndsWithNewline,
  openExactRollout,
  readCodexRolloutHeader,
  sameRolloutFileIdentity,
  sameRolloutIdentity,
  sameStableFile,
} from "./codex-rollout-file.js";
import {
  assertCodexRolloutLegacyHistory,
  optionalString,
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
  type CodexCandidateRolloutAcceptanceAnchorEntry,
  type CodexRolloutAcceptanceAnchor,
  type CodexRolloutAcceptanceIdentity,
  type CodexRolloutIdentity,
  exactNativeThreadId,
  fingerprint,
  normalizedRolloutIdentity,
  requiredString,
  sha256Value,
  type TerminalSubmissionAcceptanceEvidence,
  validateCodexRolloutAcceptanceAnchor,
  validateTerminalSubmissionAcceptanceEvidence,
} from "./terminal-submission-facts.js";
import fs from "node:fs";

export type CodexBoundRolloutCompletionCode =
  | "completion_found"
  | "abort_found"
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
  | "duplicate_exact_abort"
  | "conflicting_exact_settlement"
  | "later_turn_started"
  | "invalid_exact_completion"
  | "invalid_exact_abort";

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
  observed_turn_aborted_records?: number;
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

interface CompletionRequest {
  anchor: CodexRolloutAcceptanceAnchor;
  acceptanceEvidence: TerminalSubmissionAcceptanceEvidence;
  currentIdentity: CodexRolloutAcceptanceIdentity;
  requestHash: string;
}

type CompletionDiagnostics = Omit<CodexBoundRolloutCompletionDiagnostics, "code">;
type CompletionProofStep<T> = CodexBoundRolloutCompletionResult |
  { status: "ready"; context: T };

interface CompletionAcceptanceContext {
  anchor: CodexRolloutAcceptanceAnchor;
  acceptance: TerminalSubmissionAcceptanceEvidence;
  acceptedCandidate?: CodexCandidateRolloutAcceptanceAnchorEntry;
  expectedNativeThreadId: string;
  scanStartOffset: number;
  baseDiagnostics: CompletionDiagnostics;
}

interface ValidatedCompletionContext extends CompletionAcceptanceContext {
  acceptanceId: string;
  diagnostics: CompletionDiagnostics;
}

interface BoundCompletionContext extends ValidatedCompletionContext {
  rollout: CodexRolloutIdentity;
  rolloutDiagnostics: CompletionDiagnostics;
}

interface CompletionSuffix {
  buffer: Buffer;
  observedEndOffsetBytes: number;
  observedDiagnostics: CompletionDiagnostics;
}

/**
 * Scans the exact rollout and native turn proven by terminal acceptance.
 *
 * Unlike the general Codex context loader, this detector does not retain only
 * a recent-turn window. It starts at the immutable pre-submission byte anchor
 * and matches only the persisted acceptance UUID, so a delayed monitor can
 * recover completion even after later native turns have been appended.
 */
export function detectCodexBoundRolloutCompletion(
  options: CompletionRequest
): CodexBoundRolloutCompletionResult {
  const prepared = prepareCompletionAcceptance(options);
  if (prepared.status !== "ready") return prepared;
  const accepted = validateCompletionAcceptanceMetadata(prepared.context);
  if (accepted.status !== "ready") return accepted;
  const bound = bindCompletionRollout(options.currentIdentity, accepted.context);
  if (bound.status !== "ready") return bound;
  const context = bound.context;
  const { rollout, rolloutDiagnostics, acceptanceId } = context;
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
    const suffix = readCompletionSuffix(opened, context);
    if (suffix.status !== "ready") return suffix;
    const scan = scanExactCodexTaskComplete(
      suffix.context.buffer.toString("utf8"),
      acceptanceId
    );
    return projectCompletionScan(scan, context, suffix.context);

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

function prepareCompletionAcceptance(
  options: CompletionRequest
): CompletionProofStep<CompletionAcceptanceContext> {
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

  return {
    status: "ready",
    context: {
      anchor, acceptance, acceptedCandidate, expectedNativeThreadId,
      scanStartOffset, baseDiagnostics
    }
  };
}

function validateCompletionAcceptanceMetadata(
  context: CompletionAcceptanceContext
): CompletionProofStep<ValidatedCompletionContext> {
  const { anchor, acceptance, scanStartOffset, baseDiagnostics } = context;
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

  return {
    status: "ready",
    context: { ...context, acceptanceId, diagnostics }
  };
}

function bindCompletionRollout(
  current: CodexRolloutAcceptanceIdentity,
  context: ValidatedCompletionContext
): CompletionProofStep<BoundCompletionContext> {
  const { anchor, acceptedCandidate, expectedNativeThreadId, diagnostics } = context;
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
  const anchoredRolloutMatches = !anchoredRollout || (
    anchor.version === 3
      ? sameRolloutFileIdentity(anchoredRollout, rollout)
      : sameRolloutIdentity(anchoredRollout, rollout)
  );
  if (!anchoredRolloutMatches) {
    return codexCompletionFailure(
      "rollout_identity_mismatch",
      new Error("Codex rollout identity changed after terminal acceptance"),
      rolloutDiagnostics
    );
  }

  return {
    status: "ready",
    context: { ...context, rollout, rolloutDiagnostics }
  };
}

function readCompletionSuffix(
  opened: ReturnType<typeof openExactRollout>,
  context: BoundCompletionContext
): CompletionProofStep<CompletionSuffix> {
  const { acceptance, scanStartOffset, rolloutDiagnostics } = context;
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
  try {
    if (before.size > 0) {
      assertCodexRolloutLegacyHistory(readCodexRolloutHeader(opened.fd, before.size));
    }
  } catch (error) {
    return codexCompletionFailure("rollout_unreadable", error, observedDiagnostics);
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
  return {
    status: "ready",
    context: { buffer, observedEndOffsetBytes: before.size, observedDiagnostics }
  };
}

function projectCompletionScan(
  scan: ReturnType<typeof scanExactCodexTaskComplete>,
  context: BoundCompletionContext,
  suffix: CompletionSuffix
): CodexBoundRolloutCompletionResult {
  const { acceptanceId, expectedNativeThreadId, anchor, rolloutDiagnostics,
    scanStartOffset } = context;
  const { observedDiagnostics, observedEndOffsetBytes } = suffix;
  const scanDiagnostics = {
    ...observedDiagnostics,
    scanned_records: scan.scannedRecords,
    observed_task_complete_records: scan.observedTaskCompleteRecords,
    observed_turn_aborted_records: scan.observedTurnAbortedRecords
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
  if (scan.status === "aborted") {
    const reason = truncateCompletionText(
      redactString(scan.reason ?? "interrupted")
    );
    const completion: TerminalCompletionEvidence = {
      source: "durable",
      outcome: "failure",
      text: truncateCompletionText(
        redactString(`Codex task stopped: ${reason}`)
      ),
      ...(scan.timestamp ? { timestamp: scan.timestamp } : {}),
      id: acceptanceId,
      confidence: "high",
      metadata: {
        match: "bound_rollout_turn_aborted",
        turn_id: acceptanceId,
        native_thread_id: expectedNativeThreadId,
        anchor_fingerprint: anchor.anchor_fingerprint,
        rollout_identity_fingerprint:
          rolloutDiagnostics.rollout_identity_fingerprint,
        abort_reason: reason,
        scan_start_offset_bytes: scanStartOffset,
        observed_end_offset_bytes: observedEndOffsetBytes,
        scanned_records: scan.scannedRecords,
        observed_task_complete_records: scan.observedTaskCompleteRecords,
        observed_turn_aborted_records: scan.observedTurnAbortedRecords
      }
    };
    return {
      status: "completed",
      completion,
      diagnostics: {
        ...scanDiagnostics,
        code: "abort_found"
      }
    };
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
      observed_end_offset_bytes: observedEndOffsetBytes,
      scanned_records: scan.scannedRecords,
      observed_task_complete_records: scan.observedTaskCompleteRecords,
      observed_turn_aborted_records: scan.observedTurnAbortedRecords
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
    | "abort_found"
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
