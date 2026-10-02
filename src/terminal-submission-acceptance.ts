// Compatibility facade and pre-send acceptance anchors.
import {
  type CodexOpenRootRolloutIdentity,
  type CodexOpenRootRolloutInventory,
} from "./agent-session-provider.js";
import {
  assertPrivateRegularFile,
  fileEndsWithNewline,
  openExactRollout,
  readCodexRolloutHeader,
  sameRolloutFileIdentity,
  sameRolloutIdentity,
  sameStableFile,
} from "./codex-rollout-file.js";
import {
  codexRolloutInodeKey,
  validateCodexOpenRootInventoryForAcceptance,
  validateCodexRecoveryCandidateForAcceptance,
} from "./codex-rollout-inventory.js";
import {
  assertCodexRolloutLegacyHistory,
  exactCodexUserResponseText,
  fingerprintText,
  isRecord,
  optionalString,
} from "./codex-rollout-records.js";
import {
  codexThreadUsesLegacyRollout,
} from "./codex-session-provider.js";
import {
  type CaptureCodexRolloutAcceptanceAnchorOptions,
  type CodexCandidateSetRolloutAcceptanceAnchor,
  type CodexCandidateSetRolloutAcceptanceRequest,
  type CodexCandidateSetRolloutAcceptanceResult,
  type CodexRolloutAcceptanceAnchor,
  type CodexRolloutAcceptanceRequest,
  type CodexRolloutIdentity,
  exactNativeThreadId,
  fingerprint,
  normalizedRolloutIdentity,
  requiredString,
  sha256Value,
  type TerminalSubmissionAcceptanceEvidence,
  validateCodexRolloutAcceptanceAnchor,
  validateTerminalSubmissionAcceptanceEvidence,
  validTimestamp,
} from "./terminal-submission-facts.js";
import fs from "node:fs";

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
export {
  type CodexHumanStartedActiveTaskAnchor,
  type CaptureCodexHumanStartedActiveTaskOptions,
  type ObserveCodexHumanStartedActiveTaskOptions,
  type CodexHumanStartedActiveTaskObservation,
  captureCodexHumanStartedActiveTaskAnchor,
  observeCodexHumanStartedActiveTask,
  validateCodexHumanStartedActiveTaskAnchor,
} from "./codex-rollout-human-task.js";
export {
  type CodexQuestionnaireScreenEvidence,
  type CodexBoundQuestionnaireAttributionResult,
  detectCodexBoundQuestionnaireAttribution,
  readCodexAsyncQuestionDurableEvidence,
} from "./codex-rollout-interaction-evidence.js";
export {
  type CodexBoundRolloutCompletionCode,
  type CodexBoundRolloutCompletionDiagnostics,
  type CodexBoundRolloutCompletionResult,
  detectCodexBoundRolloutCompletion,
} from "./codex-rollout-bound-completion.js";

const CODEX_ACCEPTANCE_MAX_BYTES = 16 * 1024 * 1024;

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
    if (before.size > 0) {
      assertCodexRolloutLegacyHistory(readCodexRolloutHeader(opened.fd, before.size));
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
      if (before.size > 0) {
        assertCodexRolloutLegacyHistory(readCodexRolloutHeader(opened.fd, before.size));
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
  requestHash: requestHashValue,
  recoveryCandidate: recoveryCandidateValue
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

  let recoveryCandidate: CodexOpenRootRolloutIdentity | undefined;
  if (recoveryCandidateValue) {
    try {
      recoveryCandidate = validateCodexRecoveryCandidateForAcceptance(
        recoveryCandidateValue,
        anchor
      );
    } catch (error) {
      return {
        status: "uncertain",
        code: "candidate_inventory_changed",
        reason: error instanceof Error ? error.message : String(error),
        inspected_candidates: 0,
        exact_matches: 0
      };
    }
  }

  const anchoredByThread = new Map(
    anchor.candidate_rollouts.map((candidate) => [
      candidate.native_thread_id,
      candidate
    ])
  );
  const anchoredByFile = new Map(
    anchor.candidate_rollouts.map((candidate) => [
      codexRolloutInodeKey(candidate.rollout),
      candidate
    ])
  );
  const currentByThread = new Map(
    inventory.roots.map((identity) => [identity.sessionId, identity])
  );
  const currentByFile = new Map(
    inventory.roots.map((identity) => [
      codexRolloutInodeKey(identity.rollout),
      identity
    ])
  );
  for (const identity of [
    ...inventory.roots,
    ...(recoveryCandidate ? [recoveryCandidate] : [])
  ]) {
    const anchored = anchoredByThread.get(identity.sessionId);
    if (
      anchored &&
      !sameRolloutFileIdentity(anchored.rollout, identity.rollout)
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
    const anchoredFile = anchoredByFile.get(
      codexRolloutInodeKey(identity.rollout)
    );
    if (
      anchoredFile &&
      anchoredFile.native_thread_id !== identity.sessionId
    ) {
      return {
        status: "uncertain",
        code: "candidate_inventory_changed",
        reason:
          `Codex candidate rollout changed native thread identity from ` +
          `${anchoredFile.native_thread_id} to ${identity.sessionId} after capture`,
        inspected_candidates: 0,
        exact_matches: 0
      };
    }
  }
  if (recoveryCandidate) {
    const currentThread = currentByThread.get(recoveryCandidate.sessionId);
    const currentFile = currentByFile.get(
      codexRolloutInodeKey(recoveryCandidate.rollout)
    );
    if (
      (currentThread && !sameRolloutFileIdentity(
        currentThread.rollout,
        recoveryCandidate.rollout
      )) ||
      (currentFile && currentFile.sessionId !== recoveryCandidate.sessionId)
    ) {
      return {
        status: "uncertain",
        code: "candidate_inventory_changed",
        reason:
          "persisted Codex recovery candidate conflicts with the current root inventory",
        inspected_candidates: 0,
        exact_matches: 0
      };
    }
  }
  // A Codex thread may close (or reopen) its process FD while the acceptance
  // poll is running. The captured path/device/inode/offset remains the durable
  // read authority in that case, so inspect the union rather than treating a
  // missing lsof row as evidence that the candidate changed identity.
  const candidates: Array<{
    identity: CodexOpenRootRolloutIdentity;
    offsetBytes: number;
    requireFreshHeader: boolean;
    currentlyOpen: boolean;
  }> = [
    ...anchor.candidate_rollouts.map((anchored) => ({
      identity:
        currentByThread.get(anchored.native_thread_id) ??
        (recoveryCandidate?.sessionId === anchored.native_thread_id
          ? recoveryCandidate
          : {
              sessionId: anchored.native_thread_id,
              processUuid: anchor.process_uuid,
              processBirth: anchor.process_birth,
              rollout: anchored.rollout,
              evidence: "codex_open_root_rollout" as const
            }),
      offsetBytes: anchored.offset_bytes,
      requireFreshHeader: false,
      currentlyOpen: currentByThread.has(anchored.native_thread_id)
    })),
    ...inventory.roots
      .filter((identity) => !anchoredByThread.has(identity.sessionId))
      .map((identity) => ({
        identity,
        offsetBytes: 0,
        requireFreshHeader: true,
        currentlyOpen: true
      })),
    ...(recoveryCandidate &&
      !anchoredByThread.has(recoveryCandidate.sessionId) &&
      !currentByThread.has(recoveryCandidate.sessionId)
      ? [{
          identity: recoveryCandidate,
          offsetBytes: 0,
          requireFreshHeader: true,
          currentlyOpen: false
        }]
      : [])
  ];

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
      if (!candidate.currentlyOpen) {
        return {
          status: "uncertain",
          code: "candidate_scan_invalid",
          reason:
            `Codex candidate ${candidate.identity.sessionId} closed with an ` +
            "incomplete rollout record after capture",
          inspected_candidates: candidates.indexOf(candidate) + 1,
          exact_matches: matches.length
        };
      }
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

/** Return a safe bounded suffix length, or wait for its incomplete JSONL tail. */
function codexRolloutAcceptanceReadLength(
  fd: number,
  stat: fs.Stats,
  offsetBytes: number
): number | undefined {
  assertPrivateRegularFile(stat);
  if (stat.size < offsetBytes) {
    throw new Error("Codex rollout was truncated after terminal submission");
  }
  const bytesToRead = stat.size - offsetBytes;
  if (bytesToRead > CODEX_ACCEPTANCE_MAX_BYTES) {
    throw new Error(
      "Codex rollout acceptance suffix exceeded the bounded read limit"
    );
  }
  if (stat.size > 0 && !fileEndsWithNewline(fd, stat.size)) {
    return undefined;
  }
  if (stat.size > 0) {
    assertCodexRolloutLegacyHistory(readCodexRolloutHeader(fd, stat.size));
  }
  return bytesToRead;
}

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
    const bytesToRead = codexRolloutAcceptanceReadLength(opened.fd, before, offsetBytes);
    if (bytesToRead === undefined) {
      return { status: "incomplete" };
    }
    if (bytesToRead === 0) {
      return { status: "pending" };
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
  if (!codexThreadUsesLegacyRollout(payload)) {
    throw new Error("virgin Codex rollout does not use legacy history");
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
