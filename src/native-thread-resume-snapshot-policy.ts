import { createHash } from "node:crypto";
import path from "node:path";
import {
  isExactNativeThreadId,
  type ManagedSessionState,
  type ManagedTerminalBinding,
  type NativeThreadCandidate,
  type NativeThreadTransition
} from "./managed-session.js";
import type { TerminalThreadLifecycleCandidateToken } from "./terminal-agent-adapter.js";
import {
  hasCanonicalTerminalEndpoint,
  sameTerminalControlIncarnation,
  terminalControlEvidenceMatches,
  type TerminalControlEvidence,
  type TerminalControlRef
} from "./terminal-control-ref.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export const NATIVE_THREAD_RESUME_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const NATIVE_THREAD_RESUME_SNAPSHOT_SCHEMA =
  "agent-knock-knock/native-thread-resume-snapshot";
export const NATIVE_THREAD_RESUME_SNAPSHOT_VERSION = 2;
export const LEGACY_NATIVE_THREAD_RESUME_SNAPSHOT_VERSION = 1;
const SNAPSHOT_ID_PATTERN = /^rs_[A-Za-z0-9_-]{22}$/u;

export interface NativeThreadResumeSnapshotRow {
  selection_number: number;
  short_id: string;
  selection_handle: string;
  native_thread_id: string;
  candidate_token?: string;
  resumable: boolean;
  unavailable_reason?: string;
}

export interface NativeThreadResumeSnapshot {
  schema: typeof NATIVE_THREAD_RESUME_SNAPSHOT_SCHEMA;
  version:
    | typeof LEGACY_NATIVE_THREAD_RESUME_SNAPSHOT_VERSION
    | typeof NATIVE_THREAD_RESUME_SNAPSHOT_VERSION;
  snapshot_id: string;
  store_key: string;
  selection_scope: string;
  created_at: string;
  expires_at: string;
  terminal_id: string;
  agent: string;
  workspace: string;
  terminal_control: {
    target: string;
    socket_path?: string;
    pane_pid?: number;
    kind?: "tmux" | "herdr";
    session?: string;
    session_dir?: string;
    workspace_id?: string;
    tab_id?: string;
    pane_id?: string;
    terminal_id?: string;
  };
  terminal_endpoint?: TerminalControlEvidence;
  current_session_id?: string;
  current_native_thread_id?: string;
  expected_binding_token: string;
  terminal_action_fingerprint: string;
  candidate_snapshot_fingerprint: string;
  rows: NativeThreadResumeSnapshotRow[];
}

export interface ResumeSnapshotTerminalObservation {
  conversationId: string;
  agent: string;
  terminalControl: TerminalControlRef;
}

export function encodeThreadCandidateToken(
  token: TerminalThreadLifecycleCandidateToken
): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

export function decodeThreadCandidateToken(
  value: string
): TerminalThreadLifecycleCandidateToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("--candidate-token is not a valid AKK candidate token");
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== "agent-knock-knock/thread-candidate-token" ||
    !(parsed.version === 1 || parsed.version === 2) ||
    !["codex", "claude"].includes(String(parsed.agent)) ||
    !isExactNativeThreadId(parsed.nativeThreadId) ||
    !nonBlankString(parsed.cwd) ||
    !["codex_rollout", "claude_transcript"].includes(String(parsed.source)) ||
    !nonBlankString(parsed.agentVersion) ||
    (
      parsed.version === 1
        ? parsed.sourceAgentVersion !== undefined
        : (
            !nonBlankString(parsed.sourceAgentVersion) ||
            parsed.sourceAgentVersion === parsed.agentVersion
          )
    ) ||
    !isRecord(parsed.fileToken) ||
    !nonBlankString(parsed.fileToken.path) ||
    !nonBlankString(parsed.fileToken.device) ||
    !nonBlankString(parsed.fileToken.inode) ||
    !Number.isSafeInteger(Number(parsed.fileToken.size)) ||
    !Number.isFinite(Number(parsed.fileToken.mtimeMs)) ||
    !nonBlankString(parsed.metadataFingerprint)
  ) {
    throw new Error("--candidate-token has an invalid AKK candidate schema");
  }
  return parsed as unknown as TerminalThreadLifecycleCandidateToken;
}

export function assertResumeSnapshotMatchesTerminal(
  snapshot: NativeThreadResumeSnapshot,
  terminal: ResumeSnapshotTerminalObservation,
  cwd: () => string
): void {
  const currentWorkspace = path.resolve(
    terminal.terminalControl.currentPath ?? cwd()
  );
  const terminalMatches = terminalControlEvidenceMatches(
    snapshot.version === 2
      ? snapshot.terminal_endpoint
      : snapshot.terminal_control,
    terminal.terminalControl
  );
  if (
    (snapshot.version === 1 && snapshot.terminal_id !== terminal.conversationId) ||
    snapshot.agent !== terminal.agent ||
    path.resolve(snapshot.workspace) !== currentWorkspace ||
    !terminalMatches
  ) {
    throw new Error(
      "resume selection terminal, process, or workspace changed; run /akk threads again"
    );
  }
}

export function assertResumeSnapshotActionFingerprint(
  snapshot: NativeThreadResumeSnapshot,
  ledger: unknown
): void {
  if (terminalActionFingerprint(ledger) !== snapshot.terminal_action_fingerprint) {
    throw new Error(
      "terminal action history changed after the resume snapshot; run /akk threads again"
    );
  }
}

export function assertResumeSnapshotCandidates(
  snapshot: NativeThreadResumeSnapshot,
  candidates: readonly NativeThreadCandidate[]
): void {
  if (
    nativeThreadCandidateSnapshotFingerprint(candidates) !==
      snapshot.candidate_snapshot_fingerprint
  ) {
    throw new Error(
      "resume candidates changed or reordered after the snapshot; run /akk threads again"
    );
  }
  if (!nativeThreadResumeSnapshotRowsMatchCandidates(snapshot, candidates)) {
    throw new Error(
      "resume selection rows no longer match the exact candidate snapshot; run /akk threads again"
    );
  }
}

export function assertResumeSnapshotNotExpired(
  snapshot: NativeThreadResumeSnapshot,
  clock: () => number
): void {
  const expiresAtMs = Date.parse(snapshot.expires_at);
  const nowMs = clock();
  if (expiresAtMs <= nowMs) {
    throw new Error("resume selection snapshot expired; run /akk threads again");
  }
}

export function sortNativeThreadCandidates(
  candidates: readonly NativeThreadCandidate[]
): NativeThreadCandidate[] {
  return [...candidates].sort((left, right) => {
    const timestampDifference =
      Number(right.updated_at_ms ?? 0) - Number(left.updated_at_ms ?? 0);
    return timestampDifference ||
      left.native_thread_id.localeCompare(right.native_thread_id);
  });
}

export function collisionSafeNativeThreadShortIds(
  nativeThreadIds: readonly string[]
): Map<string, string> {
  const normalized = nativeThreadIds.map((value) =>
    value.toLowerCase().replaceAll("-", "")
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("resume snapshot contains duplicate native thread ids");
  }
  const result = new Map<string, string>();
  for (let index = 0; index < normalized.length; index += 1) {
    const compact = normalized[index];
    let length = 8;
    while (
      length <= compact.length &&
      normalized.some((other, otherIndex) =>
        otherIndex !== index &&
        other.startsWith(compact.slice(0, length))
      )
    ) {
      length += 1;
    }
    if (length > compact.length) {
      throw new Error("resume snapshot short ids cannot be made unique");
    }
    result.set(nativeThreadIds[index].toLowerCase(), `@${compact.slice(0, length)}`);
  }
  return result;
}

export function canonicalNativeThreadResumeSnapshotRows(
  snapshotId: string,
  candidates: readonly NativeThreadCandidate[]
): NativeThreadResumeSnapshotRow[] {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error("resume selection snapshot id is malformed");
  }
  const ordered = sortNativeThreadCandidates(candidates);
  const shortIds = collisionSafeNativeThreadShortIds(
    ordered.map((candidate) => candidate.native_thread_id)
  );
  return ordered.map((candidate, index): NativeThreadResumeSnapshotRow => ({
    selection_number: index + 1,
    short_id: shortIds.get(candidate.native_thread_id.toLowerCase()) as string,
    selection_handle: `${snapshotId}:${index + 1}`,
    native_thread_id: candidate.native_thread_id,
    candidate_token: candidate.candidate_token,
    resumable: candidate.resumable,
    unavailable_reason: candidate.unavailable_reason
  }));
}

export function nativeThreadResumeSnapshotRowsMatchCandidates(
  snapshot: NativeThreadResumeSnapshot,
  candidates: readonly NativeThreadCandidate[]
): boolean {
  return JSON.stringify(canonicalNativeThreadResumeSnapshotRows(
    snapshot.snapshot_id,
    candidates
  )) === JSON.stringify(snapshot.rows);
}

export function nativeThreadCandidateSnapshotFingerprint(
  candidates: readonly NativeThreadCandidate[]
): string {
  return createHash("sha256")
    .update(stableStringify(candidates.map((candidate) => ({
      native_thread_id: candidate.native_thread_id,
      candidate_token: candidate.candidate_token ?? null,
      agent: candidate.agent,
      workspace: path.resolve(candidate.workspace),
      title: candidate.title ?? null,
      preview: candidate.preview ?? null,
      updated_at: candidate.updated_at ?? null,
      updated_at_ms: candidate.updated_at_ms ?? null,
      archived: candidate.archived ?? false,
      active_elsewhere: candidate.active_elsewhere ?? false,
      managed_session_id: candidate.managed_session_id ?? null,
      resumable: candidate.resumable,
      unavailable_reason: candidate.unavailable_reason ?? null
    }))))
    .digest("hex");
}

export function terminalActionFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value ?? null))
    .digest("hex");
}

export function verifiedPreviousResumeCandidate({
  terminalId,
  agent,
  workspace,
  currentSession,
  transition,
  candidates
}: {
  terminalId: string;
  agent: string;
  workspace: string;
  currentSession?: ManagedSessionState;
  transition?: NativeThreadTransition;
  candidates: readonly NativeThreadCandidate[];
}): NativeThreadCandidate | undefined {
  const binding = currentSession?.binding;
  const after = transition?.after_binding;
  if (
    currentSession?.status !== "bound" ||
    !binding ||
    !currentSession.last_transition_id ||
    !transition ||
    transition.transition_id !== currentSession.last_transition_id ||
    transition.status !== "committed" ||
    transition.target_session_id !== currentSession.session_id ||
    !after ||
    (
      transition.terminal_id !== terminalId &&
      !(
        hasCanonicalTerminalEndpoint(after.terminal_control) &&
        hasCanonicalTerminalEndpoint(binding.terminal_control)
      )
    ) ||
    transition.agent !== agent ||
    path.resolve(transition.workspace) !== path.resolve(workspace) ||
    path.resolve(currentSession.workspace) !== path.resolve(workspace) ||
    !lifecycleAfterBindingMatchesCurrent(after, binding)
  ) {
    return undefined;
  }
  const sourceNativeThreadId = transition.before_native_thread_id.toLowerCase();
  if (
    !isExactNativeThreadId(sourceNativeThreadId) ||
    sourceNativeThreadId === binding.native_thread_id?.toLowerCase()
  ) {
    return undefined;
  }
  const matches = candidates.filter((candidate) =>
    candidate.native_thread_id === sourceNativeThreadId
  );
  if (matches.length !== 1) {
    return undefined;
  }
  const candidate = matches[0];
  if (
    candidate.resumable !== true ||
    candidate.active_elsewhere === true ||
    !candidate.candidate_token ||
    (
      transition.source_session_id
        ? candidate.managed_session_id !== transition.source_session_id
        : candidate.managed_session_id !== undefined
    )
  ) {
    return undefined;
  }
  return candidate;
}

export function lifecycleAfterBindingMatchesCurrent(
  after: ManagedTerminalBinding,
  current: ManagedTerminalBinding
): boolean {
  const afterProcess = after.native_process;
  const currentProcess = current.native_process;
  return (
    after.binding_id === current.binding_id &&
    after.generation === current.generation &&
    (
      after.terminal_id === current.terminal_id ||
      (
        hasCanonicalTerminalEndpoint(after.terminal_control) &&
        hasCanonicalTerminalEndpoint(current.terminal_control)
      )
    ) &&
    sameTerminalControlIncarnation(
      after.terminal_control,
      current.terminal_control
    ) &&
    after.native_thread_id?.toLowerCase() ===
      current.native_thread_id?.toLowerCase() &&
    afterProcess.pid === currentProcess.pid &&
    (
      !afterProcess.process_uuid ||
      afterProcess.process_uuid === currentProcess.process_uuid
    ) &&
    (
      !afterProcess.process_birth ||
      afterProcess.process_birth === currentProcess.process_birth
    ) &&
    (
      !afterProcess.rollout ||
      JSON.stringify(afterProcess.rollout) ===
        JSON.stringify(currentProcess.rollout)
    )
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
