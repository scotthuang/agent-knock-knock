import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isExactNativeThreadId,
  type ManagedSessionState,
  type ManagedTerminalBinding,
  type NativeThreadCandidate,
  type NativeThreadTransition
} from "./managed-session.js";

export const NATIVE_THREAD_RESUME_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const NATIVE_THREAD_RESUME_SNAPSHOT_SCHEMA =
  "agent-knock-knock/native-thread-resume-snapshot";
export const NATIVE_THREAD_RESUME_SNAPSHOT_VERSION = 1;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;
const SNAPSHOT_ID_PATTERN = /^rs_[A-Za-z0-9_-]{22}$/u;
const SNAPSHOT_HANDLE_PATTERN = /^(rs_[A-Za-z0-9_-]{22}):([1-9][0-9]*)$/u;
const SHORT_ID_PATTERN = /^@[a-f0-9]{8,32}$/u;

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
  version: typeof NATIVE_THREAD_RESUME_SNAPSHOT_VERSION;
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
  };
  current_session_id?: string;
  current_native_thread_id?: string;
  expected_binding_token: string;
  terminal_action_fingerprint: string;
  candidate_snapshot_fingerprint: string;
  rows: NativeThreadResumeSnapshotRow[];
}

export interface NativeThreadResumeSelection {
  snapshot: NativeThreadResumeSnapshot;
  row: NativeThreadResumeSnapshotRow;
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
  assertSnapshotId(snapshotId);
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
    transition.terminal_id !== terminalId ||
    transition.agent !== agent ||
    path.resolve(transition.workspace) !== path.resolve(workspace) ||
    path.resolve(currentSession.workspace) !== path.resolve(workspace) ||
    !after ||
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
    after.terminal_id === current.terminal_id &&
    terminalControlKey(after.terminal_control) ===
      terminalControlKey(current.terminal_control) &&
    after.terminal_control.panePid === current.terminal_control.panePid &&
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

export function createNativeThreadResumeSnapshot({
  storeDir,
  selectionScope,
  terminalId,
  agent,
  workspace,
  terminalControl,
  currentSessionId,
  currentNativeThreadId,
  expectedBindingToken,
  terminalActionFingerprint: actionFingerprint,
  candidates,
  now = new Date(),
  ttlMs = NATIVE_THREAD_RESUME_SNAPSHOT_TTL_MS
}: {
  storeDir: string;
  selectionScope: string;
  terminalId: string;
  agent: string;
  workspace: string;
  terminalControl: {
    target: string;
    socketPath?: string;
    panePid?: number;
  };
  currentSessionId?: string;
  currentNativeThreadId?: string;
  expectedBindingToken: string;
  terminalActionFingerprint: string;
  candidates: readonly NativeThreadCandidate[];
  now?: Date;
  ttlMs?: number;
}): NativeThreadResumeSnapshot {
  if (!selectionScope.trim()) {
    throw new Error("resume snapshot selection scope is required");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("resume snapshot TTL must be a positive integer");
  }
  const ordered = sortNativeThreadCandidates(candidates);
  const snapshotId = `rs_${randomBytes(16).toString("base64url")}`;
  const rows = canonicalNativeThreadResumeSnapshotRows(snapshotId, ordered);
  return {
    schema: NATIVE_THREAD_RESUME_SNAPSHOT_SCHEMA,
    version: NATIVE_THREAD_RESUME_SNAPSHOT_VERSION,
    snapshot_id: snapshotId,
    store_key: resumeSnapshotStoreKey(storeDir),
    selection_scope: selectionScope,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    terminal_id: terminalId,
    agent,
    workspace: path.resolve(workspace),
    terminal_control: {
      target: terminalControl.target,
      socket_path: terminalControl.socketPath,
      pane_pid: terminalControl.panePid
    },
    current_session_id: currentSessionId,
    current_native_thread_id: currentNativeThreadId,
    expected_binding_token: expectedBindingToken,
    terminal_action_fingerprint: actionFingerprint,
    candidate_snapshot_fingerprint:
      nativeThreadCandidateSnapshotFingerprint(ordered),
    rows
  };
}

export function saveNativeThreadResumeSnapshot(
  runtimeDir: string,
  storeDir: string,
  snapshot: NativeThreadResumeSnapshot,
  now = new Date()
): void {
  assertNativeThreadResumeSnapshot(snapshot, storeDir);
  const directory = resumeSnapshotDirectory(runtimeDir, storeDir);
  ensurePrivateDirectory(directory);
  cleanupExpiredResumeSnapshots(directory, now);
  const filePath = resumeSnapshotPath(runtimeDir, storeDir, snapshot.snapshot_id);
  assertRegularOrAbsent(filePath);
  const tempPath = path.join(
    directory,
    `.${snapshot.snapshot_id}.${process.pid}.${randomUUID()}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        NO_FOLLOW_FLAG,
      PRIVATE_FILE_MODE
    );
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertRegularOrAbsent(filePath);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    fs.rmSync(tempPath, { force: true });
  }
}

export function loadNativeThreadResumeSnapshot(
  runtimeDir: string,
  storeDir: string,
  snapshotId: string,
  now = new Date()
): NativeThreadResumeSnapshot {
  assertSnapshotId(snapshotId);
  const filePath = resumeSnapshotPath(runtimeDir, storeDir, snapshotId);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "resume selection snapshot is missing; run /akk threads again"
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("resume selection snapshot is not a regular file");
    }
    parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch {
    throw new Error(
      "resume selection snapshot is unreadable; run /akk threads again"
    );
  } finally {
    fs.closeSync(fd);
  }
  assertNativeThreadResumeSnapshot(parsed, storeDir, snapshotId);
  if (Date.parse(parsed.created_at) > now.getTime()) {
    throw new Error(
      "resume selection snapshot is from the future; run /akk threads again"
    );
  }
  if (Date.parse(parsed.expires_at) <= now.getTime()) {
    throw new Error("resume selection snapshot expired; run /akk threads again");
  }
  return parsed;
}

export function resolveNativeThreadResumeSelection({
  runtimeDir,
  storeDir,
  terminalId,
  selectionScope,
  snapshotId,
  selectionNumber,
  shortId,
  selectionHandle,
  now = new Date()
}: {
  runtimeDir: string;
  storeDir: string;
  terminalId: string;
  selectionScope: string;
  snapshotId?: string;
  selectionNumber?: number;
  shortId?: string;
  selectionHandle?: string;
  now?: Date;
}): NativeThreadResumeSelection {
  const handleMatch = selectionHandle
    ? SNAPSHOT_HANDLE_PATTERN.exec(selectionHandle)
    : undefined;
  if (selectionHandle && !handleMatch) {
    throw new Error("resume selection handle is malformed; run /akk threads again");
  }
  if (selectionHandle && snapshotId) {
    throw new Error(
      "resume selection handle cannot be combined with a snapshot id"
    );
  }
  const resolvedSnapshotId = handleMatch?.[1] ?? snapshotId;
  if (!resolvedSnapshotId) {
    throw new Error("resume selection snapshot is required; run /akk threads again");
  }
  const selectors = [
    handleMatch ? "handle" : undefined,
    selectionNumber !== undefined ? "number" : undefined,
    shortId !== undefined ? "short" : undefined
  ].filter(Boolean);
  if (selectors.length !== 1) {
    throw new Error("exactly one snapshot-bound resume selection is required");
  }
  const snapshot = loadNativeThreadResumeSnapshot(
    runtimeDir,
    storeDir,
    resolvedSnapshotId,
    now
  );
  if (
    snapshot.terminal_id !== terminalId ||
    snapshot.selection_scope !== selectionScope
  ) {
    throw new Error(
      "resume selection belongs to another terminal or OpenClaw session; run /akk threads again"
    );
  }
  const handleNumber = handleMatch ? Number(handleMatch[2]) : undefined;
  const normalizedShortId = shortId?.toLowerCase();
  if (normalizedShortId && !SHORT_ID_PATTERN.test(normalizedShortId)) {
    throw new Error("resume short id is malformed; run /akk threads again");
  }
  const row = snapshot.rows.find((candidate) =>
    handleNumber !== undefined
      ? candidate.selection_number === handleNumber &&
        candidate.selection_handle === selectionHandle
      : selectionNumber !== undefined
        ? candidate.selection_number === selectionNumber
        : candidate.short_id === normalizedShortId
  );
  if (!row) {
    throw new Error("resume selection is not in the referenced snapshot; run /akk threads again");
  }
  if (!row.resumable || !row.candidate_token) {
    throw new Error(
      `selected native thread is not resumable: ${row.unavailable_reason ?? "unavailable"}`
    );
  }
  return { snapshot, row };
}

function resumeSnapshotStoreKey(storeDir: string): string {
  return createHash("sha256")
    .update(path.resolve(storeDir))
    .digest("hex")
    .slice(0, 20);
}

function resumeSnapshotDirectory(runtimeDir: string, storeDir: string): string {
  return path.join(
    path.resolve(runtimeDir),
    "resume-snapshots",
    resumeSnapshotStoreKey(storeDir)
  );
}

function resumeSnapshotPath(
  runtimeDir: string,
  storeDir: string,
  snapshotId: string
): string {
  assertSnapshotId(snapshotId);
  return path.join(
    resumeSnapshotDirectory(runtimeDir, storeDir),
    `${snapshotId}.json`
  );
}

function assertSnapshotId(snapshotId: string): void {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error("resume selection snapshot id is malformed");
  }
}

function assertNativeThreadResumeSnapshot(
  value: unknown,
  storeDir: string,
  expectedSnapshotId?: string
): asserts value is NativeThreadResumeSnapshot {
  if (
    !isRecord(value) ||
    value.schema !== NATIVE_THREAD_RESUME_SNAPSHOT_SCHEMA ||
    value.version !== NATIVE_THREAD_RESUME_SNAPSHOT_VERSION ||
    typeof value.snapshot_id !== "string" ||
    !SNAPSHOT_ID_PATTERN.test(value.snapshot_id) ||
    (
      expectedSnapshotId !== undefined &&
      value.snapshot_id !== expectedSnapshotId
    ) ||
    value.store_key !== resumeSnapshotStoreKey(storeDir) ||
    !nonEmptyString(value.selection_scope) ||
    !validIsoDate(value.created_at) ||
    !validIsoDate(value.expires_at) ||
    Date.parse(String(value.expires_at)) <= Date.parse(String(value.created_at)) ||
    Date.parse(String(value.expires_at)) - Date.parse(String(value.created_at)) >
      NATIVE_THREAD_RESUME_SNAPSHOT_TTL_MS ||
    !nonEmptyString(value.terminal_id) ||
    !nonEmptyString(value.agent) ||
    !nonEmptyString(value.workspace) ||
    !isRecord(value.terminal_control) ||
    !nonEmptyString(value.terminal_control.target) ||
    !nonEmptyString(value.expected_binding_token) ||
    !hexDigest(value.terminal_action_fingerprint) ||
    !hexDigest(value.candidate_snapshot_fingerprint) ||
    !Array.isArray(value.rows)
  ) {
    throw new Error("resume selection snapshot is malformed");
  }
  const numbers = new Set<number>();
  const shortIds = new Set<string>();
  const handles = new Set<string>();
  for (const row of value.rows) {
    if (
      !isRecord(row) ||
      !Number.isSafeInteger(row.selection_number) ||
      Number(row.selection_number) < 1 ||
      !nonEmptyString(row.short_id) ||
      !SHORT_ID_PATTERN.test(String(row.short_id)) ||
      !nonEmptyString(row.selection_handle) ||
      row.selection_handle !== `${value.snapshot_id}:${row.selection_number}` ||
      !nonEmptyString(row.native_thread_id) ||
      !isExactNativeThreadId(row.native_thread_id) ||
      typeof row.resumable !== "boolean" ||
      (row.candidate_token !== undefined && !nonEmptyString(row.candidate_token)) ||
      (row.resumable === true && !nonEmptyString(row.candidate_token))
    ) {
      throw new Error("resume selection snapshot row is malformed");
    }
    const number = Number(row.selection_number);
    const shortId = String(row.short_id);
    const handle = String(row.selection_handle);
    if (numbers.has(number) || shortIds.has(shortId) || handles.has(handle)) {
      throw new Error("resume selection snapshot contains duplicate selectors");
    }
    numbers.add(number);
    shortIds.add(shortId);
    handles.add(handle);
  }
  if (
    value.rows.some((row, index) => row.selection_number !== index + 1)
  ) {
    throw new Error("resume selection snapshot numbering is not contiguous");
  }
  const expectedShortIds = collisionSafeNativeThreadShortIds(
    value.rows.map((row) => row.native_thread_id)
  );
  if (value.rows.some((row) =>
    expectedShortIds.get(row.native_thread_id.toLowerCase()) !== row.short_id
  )) {
    throw new Error("resume selection snapshot short ids are inconsistent");
  }
}

function cleanupExpiredResumeSnapshots(directory: string, now: Date): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^rs_[A-Za-z0-9_-]{22}\.json$/u.test(entry.name)) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        continue;
      }
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (validIsoDate(value?.expires_at) && Date.parse(value.expires_at) <= now.getTime()) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Invalid files are never trusted or removed by opportunistic cleanup.
    }
  }
}

function ensurePrivateDirectory(directory: string): void {
  const runtimeDir = path.dirname(path.dirname(directory));
  fs.mkdirSync(runtimeDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const hierarchy = [runtimeDir];
  for (const current of [
    path.join(runtimeDir, "resume-snapshots"),
    directory
  ]) {
    try {
      fs.mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    hierarchy.push(current);
  }
  for (const current of hierarchy) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `resume snapshot directory must be a real directory: ${current}`
      );
    }
    if (current !== runtimeDir) {
      fs.chmodSync(current, PRIVATE_DIRECTORY_MODE);
    }
  }
}

function assertRegularOrAbsent(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("resume selection snapshot path is not a regular file");
  }
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

function terminalControlKey(value: {
  target: string;
  socketPath?: string;
}): string {
  return JSON.stringify({
    target: value.target,
    socket_path: value.socketPath ?? null
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validIsoDate(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function hexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
