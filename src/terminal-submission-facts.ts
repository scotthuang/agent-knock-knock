import { createHash } from "node:crypto";
import path from "node:path";
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
