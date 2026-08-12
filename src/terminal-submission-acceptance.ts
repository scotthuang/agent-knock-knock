import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactString } from "./runtime-log.js";
import type {
  CodexOpenRootRolloutIdentity,
  CodexOpenRootRolloutInventory
} from "./agent-session-provider.js";
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

interface CodexRolloutAcceptanceAnchorBase {
  schema: "agent-knock-knock/codex-rollout-acceptance-anchor";
  process_uuid: string;
  process_birth: string;
  captured_at: string;
  file_existed: boolean;
  offset_bytes: number;
  anchor_fingerprint: string;
}

export interface CodexBoundRolloutAcceptanceAnchor
  extends CodexRolloutAcceptanceAnchorBase {
  version: 1;
  native_thread_id: string;
  mode: "existing" | "pre_materialization";
  rollout?: CodexRolloutIdentity;
  expected_empty_native_session?: true;
}

/**
 * A process-bound anchor for a genuinely virgin Codex TUI. Codex does not
 * assign a native thread UUID or open a rollout until its first prompt is
 * submitted, so the UUID cannot safely be named before transport. The exact
 * process incarnation is still pinned here; acceptance must additionally
 * prove the newly materialized UUID, rollout, and request hash.
 */
export interface CodexVirginRolloutAcceptanceAnchor
  extends CodexRolloutAcceptanceAnchorBase {
  version: 2;
  mode: "pre_materialization";
  native_thread_id?: never;
  native_thread_binding: "post_submission";
  file_existed: false;
  offset_bytes: 0;
  rollout?: never;
  expected_empty_native_session: true;
}

export interface CodexCandidateRolloutAcceptanceAnchorEntry {
  native_thread_id: string;
  rollout: CodexRolloutIdentity;
  offset_bytes: number;
}

/**
 * A process-bound pre-submit snapshot for a terminal whose open-root
 * inventory is exact but cannot name one foreground root. Existing roots are
 * fenced at their byte offsets; roots opened after capture are admitted only
 * with a fresh exact session_meta header. No candidate is selected by mtime.
 */
export interface CodexCandidateSetRolloutAcceptanceAnchor
  extends CodexRolloutAcceptanceAnchorBase {
  version: 3;
  mode: "candidate_set";
  native_thread_binding: "post_submission";
  file_existed: false;
  offset_bytes: 0;
  zero_file_baseline: boolean;
  inventory_pid: number;
  inventory_cwd?: string;
  inventory_fingerprint: string;
  candidate_rollouts: CodexCandidateRolloutAcceptanceAnchorEntry[];
}

export type CodexRolloutAcceptanceAnchor =
  | CodexBoundRolloutAcceptanceAnchor
  | CodexVirginRolloutAcceptanceAnchor
  | CodexCandidateSetRolloutAcceptanceAnchor;

export type CodexCandidateSetRolloutAcceptanceResult =
  | {
      status: "accepted";
      identity: CodexOpenRootRolloutIdentity;
      evidence: TerminalSubmissionAcceptanceEvidence;
    }
  | {
      status: "pending";
      inspected_candidates: number;
      exact_matches: number;
      incomplete_candidates?: number;
    }
  | {
      status: "uncertain";
      code:
        | "multiple_exact_request_acceptances"
        | "candidate_inventory_changed"
        | "candidate_scan_invalid";
      reason: string;
      inspected_candidates: number;
      exact_matches: number;
    };

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
  processUuid: string;
  processBirth: string;
  now?: Date;
} & (
  | {
      nativeThreadId: string;
      mode: "existing";
      rollout: CodexRolloutIdentity;
    }
  | {
      nativeThreadId: string;
      mode: "pre_materialization";
      expectedEmptyNativeSession: true;
    }
  | {
      nativeThreadId?: undefined;
      mode: "pre_materialization";
      expectedEmptyNativeSession: true;
    }
);

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
}: {
  anchor: CodexCandidateSetRolloutAcceptanceAnchor;
  currentInventory: CodexOpenRootRolloutInventory;
  requestHash: string;
}): CodexCandidateSetRolloutAcceptanceResult {
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

export function detectCodexRolloutAcceptance(options: {
  anchor: CodexRolloutAcceptanceAnchor;
  currentIdentity: CodexRolloutAcceptanceIdentity;
  requestHash: string;
}): TerminalSubmissionAcceptanceEvidence | undefined {
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

export function validateCodexRolloutAcceptanceAnchor(
  value: CodexRolloutAcceptanceAnchor
): CodexRolloutAcceptanceAnchor {
  if (
    !isRecord(value) ||
    value.schema !== "agent-knock-knock/codex-rollout-acceptance-anchor" ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !["existing", "pre_materialization", "candidate_set"].includes(
      String(value.mode)
    ) ||
    !Number.isSafeInteger(value.offset_bytes) ||
    value.offset_bytes < 0 ||
    typeof value.file_existed !== "boolean"
  ) {
    throw new Error("Codex rollout acceptance anchor is invalid");
  }
  if (value.version === 1) {
    exactNativeThreadId(value.native_thread_id);
    if ("native_thread_binding" in value) {
      throw new Error("bound Codex acceptance anchor has deferred binding state");
    }
  } else if (value.version === 2 && (
    value.mode !== "pre_materialization" ||
    value.native_thread_binding !== "post_submission" ||
    "native_thread_id" in value
  )) {
    throw new Error("virgin Codex acceptance anchor is inconsistent");
  } else if (value.version === 3 && (
    value.mode !== "candidate_set" ||
    value.native_thread_binding !== "post_submission" ||
    "native_thread_id" in value ||
    value.file_existed !== false ||
    value.offset_bytes !== 0 ||
    typeof value.zero_file_baseline !== "boolean" ||
    !Number.isSafeInteger(value.inventory_pid) ||
    value.inventory_pid <= 1 ||
    (
      value.inventory_cwd !== undefined &&
      !path.isAbsolute(value.inventory_cwd)
    ) ||
    !/^[0-9a-f]{64}$/u.test(String(value.inventory_fingerprint)) ||
    !Array.isArray(value.candidate_rollouts) ||
    value.candidate_rollouts.length > 128 ||
    value.zero_file_baseline !== (value.candidate_rollouts.length === 0)
  )) {
    throw new Error("candidate-set Codex acceptance anchor is inconsistent");
  }
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
  if (value.version === 3) {
    const seenThreads = new Set<string>();
    const seenFiles = new Set<string>();
    for (const candidate of value.candidate_rollouts) {
      if (!isRecord(candidate)) {
        throw new Error("Codex candidate-set rollout entry is invalid");
      }
      const nativeThreadId = exactNativeThreadId(
        candidate.native_thread_id
      );
      const rollout = normalizedRolloutIdentity(candidate.rollout);
      if (
        !Number.isSafeInteger(candidate.offset_bytes) ||
        candidate.offset_bytes < 0 ||
        seenThreads.has(nativeThreadId) ||
        seenFiles.has(`${rollout.device}:${rollout.inode}`)
      ) {
        throw new Error("Codex candidate-set rollout entries are ambiguous");
      }
      seenThreads.add(nativeThreadId);
      seenFiles.add(`${rollout.device}:${rollout.inode}`);
    }
    return value;
  }
  const rollout = "rollout" in value ? value.rollout : undefined;
  if (
    value.file_existed !== (value.mode === "existing") ||
    value.file_existed !== Boolean(rollout)
  ) {
    throw new Error("Codex rollout acceptance anchor file state is inconsistent");
  }
  if (value.mode === "existing" && rollout) {
    normalizedRolloutIdentity(rollout);
    if (value.expected_empty_native_session !== undefined) {
      throw new Error("existing Codex acceptance anchor has pre-materialization state");
    }
  } else if (
    value.offset_bytes !== 0 ||
    rollout !== undefined ||
    value.expected_empty_native_session !== true
  ) {
    throw new Error("Codex pre-materialization acceptance anchor is inconsistent");
  }
  return value;
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
