import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CodexOpenRootRolloutIdentity,
  CodexOpenRootRolloutInventory
} from "./agent-session-provider.js";
import { isRecord, type UnknownRecord } from "./value-guards.js";

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

export type CaptureCodexRolloutAcceptanceAnchorOptions = {
  processUuid: string;
  processBirth: string;
  now?: Date;
} & (
  | { nativeThreadId: string; mode: "existing"; rollout: CodexRolloutIdentity }
  | {
      nativeThreadId?: string;
      mode: "pre_materialization";
      expectedEmptyNativeSession: true;
    }
);

export interface CodexCandidateSetRolloutAcceptanceRequest {
  anchor: CodexCandidateSetRolloutAcceptanceAnchor;
  currentInventory: CodexOpenRootRolloutInventory;
  requestHash: string;
}

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
      code: "multiple_exact_request_acceptances" |
        "candidate_inventory_changed" | "candidate_scan_invalid";
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

export interface CodexRolloutAcceptanceRequest {
  anchor: CodexRolloutAcceptanceAnchor;
  currentIdentity: CodexRolloutAcceptanceIdentity;
  requestHash: string;
}

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
    "source", "kind", "nativeThreadId", "requestHash", "acceptanceId",
    "acceptedAt", "anchorFingerprint", "evidenceFingerprint", "metadata"
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
          "turn_id", "anchor_offset_bytes", "observed_end_offset_bytes"
        ])
      : new Set([
          "prompt_uuid", "claude_version", "transcript_file_id",
          "anchor_offset_bytes", "observed_end_offset_bytes",
          "agent_started_at_ms"
        ]);
    for (const [key, item] of Object.entries(value.metadata)) {
      if (
        !allowedMetadata.has(key) ||
        !(typeof item === "string" ||
          (typeof item === "number" && Number.isFinite(item)))
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

const NATIVE_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function terminalBridgeSubmission(
  conversation: unknown
): UnknownRecord | undefined {
  const record = isRecord(conversation) ? conversation : undefined;
  const takeover = isRecord(record?.native_session_takeover)
    ? record.native_session_takeover
    : undefined;
  return isRecord(takeover?.terminal_bridge_submission)
    ? takeover.terminal_bridge_submission
    : undefined;
}

export function validateCodexRolloutAcceptanceAnchor(
  value: unknown
): CodexRolloutAcceptanceAnchor {
  if (
    !isRecord(value) ||
    value.schema !== "agent-knock-knock/codex-rollout-acceptance-anchor" ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !["existing", "pre_materialization", "candidate_set"].includes(
      String(value.mode)
    ) ||
    !Number.isSafeInteger(value.offset_bytes) ||
    (value.offset_bytes as number) < 0 ||
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
    (value.inventory_pid as number) <= 1 ||
    !isOptionalAbsolutePath(value.inventory_cwd) ||
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
    for (const candidate of value.candidate_rollouts as unknown[]) {
      const candidateRecord = isRecord(candidate) ? candidate : undefined;
      const rolloutValue = candidateRecord?.rollout;
      if (!candidateRecord || !isRecord(rolloutValue)) {
        throw new Error("Codex candidate-set rollout entry is invalid");
      }
      const nativeThreadId = exactNativeThreadId(candidateRecord.native_thread_id);
      const rollout = normalizedRolloutIdentity(rolloutValue);
      if (
        !Number.isSafeInteger(candidateRecord.offset_bytes) ||
        (candidateRecord.offset_bytes as number) < 0 ||
        seenThreads.has(nativeThreadId) ||
        seenFiles.has(`${rollout.device}:${rollout.inode}`)
      ) {
        throw new Error("Codex candidate-set rollout entries are ambiguous");
      }
      seenThreads.add(nativeThreadId);
      seenFiles.add(`${rollout.device}:${rollout.inode}`);
    }
  } else {
    const rollout = "rollout" in value ? value.rollout : undefined;
    if (value.file_existed !== (value.mode === "existing")) {
      throw new Error("Codex rollout acceptance anchor file state is inconsistent");
    }
    if (value.mode === "existing") {
      if (!isRecord(rollout)) {
        throw new Error("Codex rollout acceptance anchor file state is inconsistent");
      }
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
  }
  return value as unknown as CodexRolloutAcceptanceAnchor;
}

export function normalizedRolloutIdentity(
  value: CodexRolloutIdentity | UnknownRecord
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

function isOptionalAbsolutePath(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "string" && path.isAbsolute(value));
}

export function exactNativeThreadId(value: unknown): string {
  const text = requiredString(value, "Codex native thread ID").toLowerCase();
  if (!NATIVE_THREAD_ID_PATTERN.test(text)) {
    throw new Error("Codex native thread ID is not an exact UUID");
  }
  return text;
}

export function sha256Value(value: unknown, label: string): string {
  const text = requiredString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(text)) {
    throw new Error(`${label} is not a SHA-256 value`);
  }
  return text;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is unavailable`);
  }
  return value.trim();
}

export function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parsedInteger(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error("Codex rollout file identity is not numeric");
  }
}
