import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertRealDirectory,
  atomicSaveJsonFile,
  isNodeError,
  readJsonFileNoFollow
} from "./durable-json-file.js";
import type { ExecutorKind } from "./executors.js";
import { isExactNativeThreadId } from "./managed-session.js";
import type { CodexHumanStartedActiveTaskAnchor } from
  "./terminal-submission-acceptance.js";
import type { ClaudeHumanStartedActiveTaskAnchor } from
  "./claude-local-transcript-provider.js";
import {
  assertStoreReadable,
  ensureDir,
  STORE_TERMINAL_WATCHES_DIRECTORY,
  withStoreWriterLease
} from "./store.js";
import {
  terminalEndpointIdentityFromEvidence,
  terminalRouteKeyFromEvidence,
  type TerminalControlEvidence
} from "./terminal-control-ref.js";

export const TERMINAL_WATCH_SCHEMA = "agent-knock-knock/terminal-watch" as const;
export const TERMINAL_WATCH_VERSION = 1 as const;
export const TERMINAL_WATCHES_DIRECTORY =
  STORE_TERMINAL_WATCHES_DIRECTORY;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type TerminalWatchStatus =
  | "active"
  | "completed"
  | "failed"
  | "timed_out"
  | "invalidated"
  | "cancelled";

export type TerminalWatchTerminalStatus = Exclude<TerminalWatchStatus, "active">;

export interface TerminalWatchTerminalIdentity {
  terminal_id: string;
  terminal_endpoint: TerminalControlEvidence;
  agent_pid: number;
  process_uuid: string;
  process_birth: string;
  process_started_at_ms?: number;
  native_thread_id: string;
  workspace: string;
  binding_token: string;
  agent_version: string;
  behavior_profile: string;
}

export interface CodexTerminalWatchAnchor {
  kind: "codex_rollout";
  native_task_id: string;
  captured_at: string;
  request_hash: string;
  codex_version: string;
  rollout: {
    fd: string;
    device: string;
    inode: string;
    path: string;
  };
  task_started_offset_bytes: number;
  user_message_offset_bytes: number;
  observed_end_offset_bytes: number;
  evidence_fingerprint: string;
}

export interface ClaudeTerminalWatchAnchor {
  kind: "claude_transcript";
  root_prompt_uuid: string;
  captured_at: string;
  request_hash: string;
  claude_version: string;
  transcript_file_id: string;
  turn_start_offset_bytes: number;
  transcript: {
    relative_path: string;
    device: string;
    inode: string;
  };
  observed_end_offset_bytes: number;
  evidence_fingerprint: string;
}

export type TerminalWatchAnchor =
  | CodexTerminalWatchAnchor
  | ClaudeTerminalWatchAnchor;

export type TerminalWatchNotificationKind =
  | "approval"
  | TerminalWatchTerminalStatus;

export type TerminalWatchNotificationStatus =
  | "pending"
  | "delivering"
  | "failed"
  | "delivered"
  | "superseded";

/**
 * One immutable notification payload plus its mutable delivery receipt.
 * `notification_id` and `idempotency_key` are deterministic from the Watch,
 * kind, and evidence fingerprint, so a transport retry cannot create a second
 * logical OpenClaw notification.
 */
export interface TerminalWatchNotification {
  notification_id: string;
  idempotency_key: string;
  kind: TerminalWatchNotificationKind;
  evidence_fingerprint: string;
  reason_code?: string;
  status: TerminalWatchNotificationStatus;
  attempts: number;
  created_at: string;
  last_attempt_at?: string;
  attempt_id?: string;
  attempt_lease_expires_at?: string;
  failed_at?: string;
  next_attempt_at?: string;
  last_error_code?: string;
  delivered_at?: string;
  superseded_at?: string;
}

export interface TerminalWatchSettlement {
  kind: TerminalWatchTerminalStatus;
  evidence_fingerprint: string;
  observed_at: string;
  reason_code?: string;
  completion_text?: string;
  completion_id?: string;
  completion_timestamp?: string;
}

/**
 * Durable observation authority for work started by a human in a coding-agent
 * TUI. It is deliberately not a Conversation, Turn, Session, dispatch receipt,
 * or terminal-input authority.
 */
export interface TerminalWatch {
  schema: typeof TERMINAL_WATCH_SCHEMA;
  version: typeof TERMINAL_WATCH_VERSION;
  watch_id: string;
  revision?: number;
  agent: ExecutorKind;
  terminal: TerminalWatchTerminalIdentity;
  anchor: TerminalWatchAnchor;
  openclaw_session: string;
  openclaw_bin: string;
  created_at: string;
  deadline_at: string;
  updated_at: string;
  status: TerminalWatchStatus;
  last_activity_at: string;
  approval_fingerprint?: string;
  settlement?: TerminalWatchSettlement;
  notification_outbox: TerminalWatchNotification[];
}

export interface TerminalWatchSaveOptions {
  /** `null` creates; a positive revision performs an exact CAS update. */
  expectedRevision: number | null;
}

export interface TerminalWatchPaths {
  root: string;
  statePath: string;
  lockPath: string;
}

export interface TerminalWatchFileLockPort {
  acquire(lockPath: string): () => void;
}

export interface TerminalWatchStore {
  list(): TerminalWatch[];
  load(watchId: string): TerminalWatch;
  save(
    watch: TerminalWatch,
    options: TerminalWatchSaveOptions
  ): TerminalWatch;
  withWatchLock<Result>(watchId: string, operation: () => Result): Result;
}

export class TerminalWatchConflictError extends Error {
  readonly code = "AKK_TERMINAL_WATCH_CONFLICT";
  readonly watchId: string;
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(
    watchId: string,
    expectedRevision: number | null,
    actualRevision: number | null,
    detail?: string
  ) {
    super(
      `terminal Watch ${watchId} changed concurrently` +
      ` (expected revision ${String(expectedRevision)}, actual ` +
      `${String(actualRevision)})` +
      (detail ? `: ${detail}` : "")
    );
    this.name = "TerminalWatchConflictError";
    this.watchId = watchId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function createTerminalWatchId(): string {
  return `terminal-watch-${randomUUID()}`;
}

export function terminalWatchesDir(storeDir: string): string {
  return path.join(storeDir, TERMINAL_WATCHES_DIRECTORY);
}

export function pathsForTerminalWatch(
  watchId: string,
  storeDir: string
): TerminalWatchPaths {
  assertRecordId(watchId, "terminal Watch id");
  const root = terminalWatchesDir(storeDir);
  const statePath = path.join(root, `${watchId}.json`);
  assertContained(statePath, root, "terminal Watch state");
  return { root, statePath, lockPath: `${statePath}.lock` };
}

/**
 * Acquire the Store writer lease before the per-Watch state lock. This keeps
 * the repository compatible with the canonical `writer -> state` lock order.
 */
export function withTerminalWatchLock<Result>(
  storeDir: string,
  watchId: string,
  locks: TerminalWatchFileLockPort,
  operation: () => Result
): Result {
  const paths = pathsForTerminalWatch(watchId, storeDir);
  return withStoreWriterLease(storeDir, () => {
    ensureDir(paths.root);
    assertOwnerPrivateDirectory(paths.root, "terminal Watch root");
    const release = locks.acquire(paths.lockPath);
    try {
      return operation();
    } finally {
      release();
    }
  });
}

export function createTerminalWatchStore(
  storeDir: string,
  locks: TerminalWatchFileLockPort
): TerminalWatchStore {
  return Object.freeze({
    list: () => listTerminalWatches(storeDir),
    load: (watchId: string) => loadTerminalWatch(storeDir, watchId),
    save: (watch: TerminalWatch, options: TerminalWatchSaveOptions) =>
      saveTerminalWatch(storeDir, watch, options),
    withWatchLock: <Result>(watchId: string, operation: () => Result) =>
      withTerminalWatchLock(storeDir, watchId, locks, operation)
  });
}

export function terminalWatchNotificationId(
  watchId: string,
  kind: TerminalWatchNotificationKind,
  evidenceFingerprint: string
): string {
  assertRecordId(watchId, "terminal Watch id");
  assertNotificationKind(kind);
  assertSha256(evidenceFingerprint, "notification evidence fingerprint");
  const digest = createHash("sha256")
    .update(JSON.stringify({
      schema: "agent-knock-knock/terminal-watch-notification",
      version: 1,
      watch_id: watchId,
      kind,
      evidence_fingerprint: evidenceFingerprint
    }))
    .digest("hex");
  return `terminal-watch-notification-${digest}`;
}

export function terminalWatchNotificationIdempotencyKey(
  watchId: string,
  notificationId: string
): string {
  assertRecordId(watchId, "terminal Watch id");
  assertRecordId(notificationId, "terminal Watch notification id");
  return `agent-knock-knock:terminal-watch:${watchId}:${notificationId}`;
}

export function terminalWatchIdentityFingerprint(
  watch: Pick<TerminalWatch, "agent" | "terminal" | "anchor">
): string {
  const endpoint = terminalEndpointIdentityFromEvidence(
    watch.terminal.terminal_endpoint
  );
  if (!endpoint) {
    throw new Error("terminal Watch endpoint identity is invalid");
  }
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      agent: watch.agent,
      terminal_id: watch.terminal.terminal_id,
      endpoint,
      process_anchor_pid:
        watch.terminal.terminal_endpoint.process_anchor_pid,
      agent_pid: watch.terminal.agent_pid,
      process_uuid: watch.terminal.process_uuid,
      process_birth: watch.terminal.process_birth,
      process_started_at_ms: watch.terminal.process_started_at_ms ?? null,
      native_thread_id: watch.terminal.native_thread_id,
      workspace: watch.terminal.workspace,
      binding_token: watch.terminal.binding_token,
      agent_version: watch.terminal.agent_version,
      behavior_profile: watch.terminal.behavior_profile,
      anchor_kind: watch.anchor.kind,
      native_task_id: watch.anchor.kind === "codex_rollout"
        ? watch.anchor.native_task_id
        : watch.anchor.root_prompt_uuid,
      request_hash: watch.anchor.request_hash,
      native_file_identity: watch.anchor.kind === "codex_rollout"
        ? {
            device: watch.anchor.rollout.device,
            inode: watch.anchor.rollout.inode
          }
        : {
            device: watch.anchor.transcript.device,
            inode: watch.anchor.transcript.inode,
            transcript_file_id: watch.anchor.transcript_file_id
          }
    }))
    .digest("hex");
}

/** Losslessly reconstruct the provider-owned Codex anchor without raw prompt text. */
export function codexActiveTaskAnchorForTerminalWatch(
  watch: Pick<TerminalWatch, "agent" | "terminal" | "anchor">
): CodexHumanStartedActiveTaskAnchor {
  if (watch.agent !== "codex" || watch.anchor.kind !== "codex_rollout") {
    throw new Error("terminal Watch does not carry a Codex active-task anchor");
  }
  const anchor = {
    schema: "agent-knock-knock/codex-human-started-active-task-anchor",
    version: 1,
    native_thread_id: watch.terminal.native_thread_id,
    process_uuid: watch.terminal.process_uuid,
    process_birth: watch.terminal.process_birth,
    captured_at: watch.anchor.captured_at,
    rollout: watch.anchor.rollout,
    turn_id: watch.anchor.native_task_id,
    request_hash: watch.anchor.request_hash,
    codex_version: watch.anchor.codex_version,
    task_started_offset_bytes: watch.anchor.task_started_offset_bytes,
    user_message_offset_bytes: watch.anchor.user_message_offset_bytes,
    observed_end_offset_bytes: watch.anchor.observed_end_offset_bytes,
    anchor_fingerprint: watch.anchor.evidence_fingerprint
  };
  return anchor as unknown as CodexHumanStartedActiveTaskAnchor;
}

/** Losslessly reconstruct the provider-owned Claude anchor without raw prompt text. */
export function claudeActiveTaskAnchorForTerminalWatch(
  watch: Pick<TerminalWatch, "agent" | "terminal" | "anchor">
): ClaudeHumanStartedActiveTaskAnchor {
  if (watch.agent !== "claude" || watch.anchor.kind !== "claude_transcript") {
    throw new Error("terminal Watch does not carry a Claude active-task anchor");
  }
  const startedAt = watch.terminal.process_started_at_ms;
  if (!isPositiveSafeInteger(startedAt)) {
    throw new Error("Claude terminal Watch has no exact process start time");
  }
  const anchor = {
    schema: "agent-knock-knock/claude-human-started-active-task-anchor",
    version: 1,
    session_id: watch.terminal.native_thread_id,
    cwd: watch.terminal.workspace,
    pid: watch.terminal.agent_pid,
    agent_started_at_ms: startedAt,
    captured_at: watch.anchor.captured_at,
    relative_path: watch.anchor.transcript.relative_path,
    device: watch.anchor.transcript.device,
    inode: watch.anchor.transcript.inode,
    prompt_uuid: watch.anchor.root_prompt_uuid,
    request_hash: watch.anchor.request_hash,
    claude_version: watch.anchor.claude_version,
    transcript_file_id: watch.anchor.transcript_file_id,
    turn_start_offset_bytes: watch.anchor.turn_start_offset_bytes,
    observed_end_offset_bytes: watch.anchor.observed_end_offset_bytes,
    anchor_fingerprint: watch.anchor.evidence_fingerprint
  };
  return anchor as unknown as ClaudeHumanStartedActiveTaskAnchor;
}

export function activeTaskAnchorForTerminalWatch(
  watch: Pick<TerminalWatch, "agent" | "terminal" | "anchor">
): CodexHumanStartedActiveTaskAnchor | ClaudeHumanStartedActiveTaskAnchor {
  return watch.agent === "codex"
    ? codexActiveTaskAnchorForTerminalWatch(watch)
    : claudeActiveTaskAnchorForTerminalWatch(watch);
}

export function terminalWatchRevision(watch: TerminalWatch): number {
  if (!isPositiveSafeInteger(watch.revision)) {
    throw new Error(`terminal Watch ${watch.watch_id} has no valid revision`);
  }
  return watch.revision;
}

export function assertTerminalWatch(
  value: unknown,
  expectedWatchId?: string,
  options: { allowMissingRevision?: boolean } = {}
): asserts value is TerminalWatch {
  if (!isRecord(value)) {
    throw new Error("terminal Watch must be an object");
  }
  assertOnlyKeys(value, [
    "schema",
    "version",
    "watch_id",
    "revision",
    "agent",
    "terminal",
    "anchor",
    "openclaw_session",
    "openclaw_bin",
    "created_at",
    "deadline_at",
    "updated_at",
    "status",
    "last_activity_at",
    "approval_fingerprint",
    "settlement",
    "notification_outbox"
  ], "terminal Watch");
  if (
    value.schema !== TERMINAL_WATCH_SCHEMA ||
    value.version !== TERMINAL_WATCH_VERSION
  ) {
    throw new Error("terminal Watch has an unsupported schema or version");
  }
  assertRecordId(value.watch_id, "terminal Watch id");
  if (expectedWatchId !== undefined && value.watch_id !== expectedWatchId) {
    throw new Error(
      `terminal Watch id ${String(value.watch_id)} does not match ${expectedWatchId}`
    );
  }
  if (
    value.revision === undefined
      ? !options.allowMissingRevision
      : !isPositiveSafeInteger(value.revision)
  ) {
    throw new Error("terminal Watch revision must be a positive safe integer");
  }
  if (!isExecutorKind(value.agent)) {
    throw new Error("terminal Watch agent must be codex or claude");
  }
  assertTerminalIdentity(value.terminal);
  assertTerminalWatchAnchor(
    value.anchor,
    value.agent,
    value.terminal as unknown as TerminalWatchTerminalIdentity
  );
  assertNonEmptyString(value.openclaw_session, "terminal Watch OpenClaw session");
  assertNonEmptyString(value.openclaw_bin, "terminal Watch OpenClaw binary");
  assertTimestamp(value.created_at, "terminal Watch created_at");
  assertTimestamp(value.deadline_at, "terminal Watch deadline_at");
  assertTimestamp(value.updated_at, "terminal Watch updated_at");
  assertTimestamp(value.last_activity_at, "terminal Watch last_activity_at");
  if (
    Date.parse(value.deadline_at) <= Date.parse(value.created_at) ||
    Date.parse(value.updated_at) < Date.parse(value.created_at) ||
    Date.parse(value.last_activity_at) > Date.parse(value.updated_at)
  ) {
    throw new Error("terminal Watch timestamps are not monotonic");
  }
  const anchorCapturedAt = (value.anchor as unknown as TerminalWatchAnchor)
    .captured_at;
  const processStartedAt = (value.terminal as unknown as TerminalWatchTerminalIdentity)
    .process_started_at_ms;
  if (
    Date.parse(anchorCapturedAt) > Date.parse(String(value.created_at)) ||
    (
      processStartedAt !== undefined &&
      processStartedAt > Date.parse(String(value.created_at))
    )
  ) {
    throw new Error("terminal Watch cannot predate its exact observation anchor");
  }
  if (!isWatchStatus(value.status)) {
    throw new Error("terminal Watch status is invalid");
  }
  assertOptionalSha256(
    value.approval_fingerprint,
    "terminal Watch approval fingerprint"
  );
  assertSettlement(value.settlement, value.status);
  if (
    isRecord(value.settlement) &&
    (
      Date.parse(String(value.settlement.observed_at)) >
        Date.parse(String(value.updated_at)) ||
      (
        value.settlement.completion_timestamp !== undefined &&
        Date.parse(String(value.settlement.completion_timestamp)) >
          Date.parse(String(value.updated_at))
      )
    )
  ) {
    throw new Error("terminal Watch settlement cannot be newer than its state");
  }
  assertNotificationOutbox(value);
}

export function saveTerminalWatch(
  storeDir: string,
  watch: TerminalWatch,
  options: TerminalWatchSaveOptions
): TerminalWatch {
  assertTerminalWatch(watch, undefined, { allowMissingRevision: true });
  assertExpectedRevision(options?.expectedRevision);
  const paths = pathsForTerminalWatch(watch.watch_id, storeDir);
  return withStoreWriterLease(storeDir, () => {
    const current = tryLoadTerminalWatch(storeDir, watch.watch_id);
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== options.expectedRevision) {
      throw new TerminalWatchConflictError(
        watch.watch_id,
        options.expectedRevision,
        actualRevision
      );
    }
    if (
      watch.revision !== undefined &&
      watch.revision !== (options.expectedRevision ?? 1)
    ) {
      throw new TerminalWatchConflictError(
        watch.watch_id,
        options.expectedRevision,
        actualRevision,
        `candidate carries revision ${watch.revision}`
      );
    }
    if (current) {
      assertTerminalWatchAdvance(current, watch);
    } else if (watch.status !== "active" || watch.settlement !== undefined) {
      throw new Error("a terminal Watch must be created active and unsettled");
    }
    const next: TerminalWatch = {
      ...watch,
      revision: (actualRevision ?? 0) + 1
    };
    assertTerminalWatch(next, watch.watch_id);
    atomicSaveTerminalWatch(paths.statePath, next);
    return next;
  });
}

export function loadTerminalWatch(
  storeDir: string,
  watchId: string
): TerminalWatch {
  assertStoreReadable(storeDir);
  const paths = pathsForTerminalWatch(watchId, storeDir);
  assertOwnerPrivateDirectory(paths.root, "terminal Watch root");
  assertOwnerPrivateFile(paths.statePath, "terminal Watch state");
  const value = readJsonFileNoFollow(paths.statePath, "terminal Watch state");
  assertTerminalWatch(value, watchId);
  return value;
}

export function tryLoadTerminalWatch(
  storeDir: string,
  watchId: string
): TerminalWatch | undefined {
  try {
    return loadTerminalWatch(storeDir, watchId);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export function listTerminalWatches(storeDir: string): TerminalWatch[] {
  if (!fs.existsSync(storeDir)) {
    return [];
  }
  assertStoreReadable(storeDir);
  const root = terminalWatchesDir(storeDir);
  if (!fs.existsSync(root)) {
    return [];
  }
  assertOwnerPrivateDirectory(root, "terminal Watch root");
  const watches: TerminalWatch[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        `terminal Watch root contains an invalid entry: ${entryPath}`
      );
    }
    if (
      isRecognizedWatchLockFile(entry.name) ||
      isRecognizedWatchTemporaryFile(entry.name)
    ) {
      assertPrivateTransientEntry(entryPath);
      continue;
    }
    if (!entry.name.endsWith(".json")) {
      throw new Error(
        `terminal Watch root contains an unknown file: ${entryPath}`
      );
    }
    const watchId = entry.name.slice(0, -".json".length);
    assertRecordId(watchId, "terminal Watch id");
    watches.push(loadTerminalWatch(storeDir, watchId));
  }
  return watches.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at) ||
    left.watch_id.localeCompare(right.watch_id)
  );
}

function assertTerminalIdentity(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("terminal Watch terminal identity must be an object");
  }
  assertOnlyKeys(value, [
    "terminal_id",
    "terminal_endpoint",
    "agent_pid",
    "process_uuid",
    "process_birth",
    "process_started_at_ms",
    "native_thread_id",
    "workspace",
    "binding_token",
    "agent_version",
    "behavior_profile"
  ], "terminal Watch terminal identity");
  assertNonEmptyString(value.terminal_id, "terminal Watch terminal id");
  assertTerminalEndpoint(value.terminal_endpoint);
  if (!isPositiveSafeInteger(value.agent_pid)) {
    throw new Error("terminal Watch agent PID must be positive");
  }
  assertNonEmptyString(value.process_uuid, "terminal Watch process UUID");
  assertNonEmptyString(value.process_birth, "terminal Watch process birth");
  if (
    value.process_started_at_ms !== undefined &&
    !isPositiveSafeInteger(value.process_started_at_ms)
  ) {
    throw new Error("terminal Watch process start time must be positive");
  }
  if (!isExactNativeThreadId(value.native_thread_id)) {
    throw new Error("terminal Watch native thread id must be exact");
  }
  if (typeof value.workspace !== "string" || !path.isAbsolute(value.workspace)) {
    throw new Error("terminal Watch workspace must be absolute");
  }
  assertSha256(value.binding_token, "terminal Watch binding token");
  assertNonEmptyString(value.agent_version, "terminal Watch agent version");
  assertNonEmptyString(value.behavior_profile, "terminal Watch behavior profile");
}

function assertTerminalEndpoint(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("terminal Watch endpoint must be an object");
  }
  assertOnlyKeys(value, [
    "schema",
    "version",
    "kind",
    "endpoint_key",
    "resource_key",
    "route_key",
    "process_anchor_pid",
    "target",
    "socket_path",
    "pane_pid",
    "server_socket_path",
    "pane_id",
    "session_name",
    "session_dir",
    "workspace_id",
    "tab_id",
    "terminal_id",
    "current_path"
  ], "terminal Watch endpoint");
  if (
    value.schema !== "agent-knock-knock/terminal-endpoint" ||
    value.version !== 1 ||
    !terminalEndpointIdentityFromEvidence(value) ||
    !terminalRouteKeyFromEvidence(value) ||
    !isPositiveSafeInteger(value.process_anchor_pid)
  ) {
    throw new Error("terminal Watch endpoint evidence is not exact");
  }
  for (const key of [
    "target",
    "socket_path",
    "server_socket_path",
    "pane_id",
    "session_name",
    "session_dir",
    "workspace_id",
    "tab_id",
    "terminal_id",
    "current_path"
  ]) {
    const candidate = value[key];
    if (
      candidate !== undefined &&
      candidate !== null &&
      (typeof candidate !== "string" || candidate.includes("\0"))
    ) {
      throw new Error(`terminal Watch endpoint ${key} is invalid`);
    }
  }
  if (
    value.pane_pid !== undefined &&
    value.pane_pid !== null &&
    !isPositiveSafeInteger(value.pane_pid)
  ) {
    throw new Error("terminal Watch endpoint pane_pid is invalid");
  }
}

function assertTerminalWatchAnchor(
  value: unknown,
  agent: ExecutorKind,
  terminal: TerminalWatchTerminalIdentity
): void {
  if (!isRecord(value)) {
    throw new Error("terminal Watch anchor must be an object");
  }
  if (value.kind === "codex_rollout") {
    if (agent !== "codex") {
      throw new Error("Codex Watch anchor cannot belong to another agent");
    }
    assertOnlyKeys(value, [
      "kind",
      "native_task_id",
      "captured_at",
      "request_hash",
      "codex_version",
      "rollout",
      "task_started_offset_bytes",
      "user_message_offset_bytes",
      "observed_end_offset_bytes",
      "evidence_fingerprint"
    ], "Codex terminal Watch anchor");
    if (!isExactNativeThreadId(value.native_task_id)) {
      throw new Error("Codex Watch native task id must be exact");
    }
    assertTimestamp(value.captured_at, "Codex Watch captured_at");
    assertSha256(value.request_hash, "Codex Watch request hash");
    if (
      typeof value.codex_version !== "string" ||
      value.codex_version !== terminal.agent_version
    ) {
      throw new Error("Codex Watch anchor version must match terminal version");
    }
    assertRollout(value.rollout);
    assertCodexAnchorOffsets(
      value.task_started_offset_bytes,
      value.user_message_offset_bytes,
      value.observed_end_offset_bytes,
    );
    assertSha256(value.evidence_fingerprint, "Codex Watch anchor fingerprint");
    const anchor = codexActiveTaskAnchorForTerminalWatch({
      agent,
      terminal,
      anchor: value as unknown as CodexTerminalWatchAnchor
    });
    assertProviderAnchorFingerprint(anchor, "Codex Watch");
    return;
  }
  if (value.kind === "claude_transcript") {
    if (agent !== "claude") {
      throw new Error("Claude Watch anchor cannot belong to another agent");
    }
    assertOnlyKeys(value, [
      "kind",
      "root_prompt_uuid",
      "captured_at",
      "request_hash",
      "claude_version",
      "transcript_file_id",
      "turn_start_offset_bytes",
      "transcript",
      "observed_end_offset_bytes",
      "evidence_fingerprint"
    ], "Claude terminal Watch anchor");
    if (!isExactNativeThreadId(value.root_prompt_uuid)) {
      throw new Error("Claude Watch root prompt UUID must be exact");
    }
    assertTimestamp(value.captured_at, "Claude Watch captured_at");
    assertSha256(value.request_hash, "Claude Watch request hash");
    if (
      typeof value.claude_version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value.claude_version) ||
      value.claude_version !== terminal.agent_version
    ) {
      throw new Error("Claude Watch version is invalid");
    }
    if (
      typeof value.transcript_file_id !== "string" ||
      !/^[0-9a-f]{24}$/u.test(value.transcript_file_id)
    ) {
      throw new Error("Claude Watch transcript file id is invalid");
    }
    assertTranscript(value.transcript);
    if (
      !isNonNegativeSafeInteger(value.turn_start_offset_bytes) ||
      !isPositiveSafeInteger(value.observed_end_offset_bytes) ||
      value.observed_end_offset_bytes <= value.turn_start_offset_bytes
    ) {
      throw new Error("Claude Watch turn byte boundaries are invalid");
    }
    assertSha256(value.evidence_fingerprint, "Claude Watch anchor fingerprint");
    if (!isPositiveSafeInteger(terminal.process_started_at_ms)) {
      throw new Error("Claude Watch requires exact process start time");
    }
    const expectedTranscriptFileId = createHash("sha256")
      .update(
        `${terminal.native_thread_id}\0${String(value.transcript.device)}:` +
        String(value.transcript.inode)
      )
      .digest("hex")
      .slice(0, 24);
    if (value.transcript_file_id !== expectedTranscriptFileId) {
      throw new Error("Claude Watch transcript file identity does not match");
    }
    const anchor = claudeActiveTaskAnchorForTerminalWatch({
      agent,
      terminal,
      anchor: value as unknown as ClaudeTerminalWatchAnchor
    });
    assertProviderAnchorFingerprint(anchor, "Claude Watch");
    return;
  }
  throw new Error("terminal Watch anchor kind is unsupported");
}

function assertRollout(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("Codex Watch rollout must be an object");
  }
  assertOnlyKeys(value, ["fd", "device", "inode", "path"], "Codex Watch rollout");
  assertNonEmptyString(value.fd, "Codex Watch rollout fd");
  assertNonEmptyString(value.device, "Codex Watch rollout device");
  assertNonEmptyString(value.inode, "Codex Watch rollout inode");
  if (typeof value.path !== "string" || !path.isAbsolute(value.path)) {
    throw new Error("Codex Watch rollout path must be absolute");
  }
  try {
    BigInt(value.device);
    BigInt(value.inode);
  } catch {
    throw new Error("Codex Watch rollout file identity must be numeric");
  }
}

function assertTranscript(
  value: unknown
): asserts value is ClaudeTerminalWatchAnchor["transcript"] {
  if (!isRecord(value)) {
    throw new Error("Claude Watch transcript must be an object");
  }
  assertOnlyKeys(
    value,
    ["relative_path", "device", "inode"],
    "Claude Watch transcript"
  );
  if (!isSafeRelativePath(value.relative_path)) {
    throw new Error("Claude Watch transcript path must be safe and relative");
  }
  assertNonEmptyString(value.device, "Claude Watch transcript device");
  assertNonEmptyString(value.inode, "Claude Watch transcript inode");
  if (
    !/^(?:0|[1-9]\d*)$/u.test(String(value.device)) ||
    !/^(?:0|[1-9]\d*)$/u.test(String(value.inode))
  ) {
    throw new Error("Claude Watch transcript file identity must be decimal");
  }
}

function assertCodexAnchorOffsets(
  taskStartedOffset: unknown,
  userMessageOffset: unknown,
  observedEndOffset: unknown,
): void {
  if (
    !isNonNegativeSafeInteger(taskStartedOffset) ||
    !isNonNegativeSafeInteger(userMessageOffset) ||
    !isNonNegativeSafeInteger(observedEndOffset) ||
    userMessageOffset <= taskStartedOffset ||
    observedEndOffset <= userMessageOffset
  ) {
    throw new Error("Codex Watch anchor offsets are invalid");
  }
}

function assertProviderAnchorFingerprint(
  anchor: CodexHumanStartedActiveTaskAnchor | ClaudeHumanStartedActiveTaskAnchor,
  label: string
): void {
  const { anchor_fingerprint: fingerprint, ...base } = anchor;
  const actual = createHash("sha256")
    .update(JSON.stringify(base))
    .digest("hex");
  if (actual !== fingerprint) {
    throw new Error(`${label} provider anchor fingerprint does not match`);
  }
}

function assertSettlement(
  value: unknown,
  status: TerminalWatchStatus
): void {
  if (status === "active") {
    if (value !== undefined) {
      throw new Error("an active terminal Watch cannot carry a settlement");
    }
    return;
  }
  if (!isRecord(value)) {
    throw new Error("a terminal Watch outcome requires durable settlement");
  }
  assertOnlyKeys(
    value,
    [
      "kind",
      "evidence_fingerprint",
      "observed_at",
      "reason_code",
      "completion_text",
      "completion_id",
      "completion_timestamp"
    ],
    "terminal Watch settlement"
  );
  if (value.kind !== status) {
    throw new Error("terminal Watch settlement kind must match its status");
  }
  assertSha256(value.evidence_fingerprint, "terminal Watch settlement fingerprint");
  assertTimestamp(value.observed_at, "terminal Watch settlement observed_at");
  assertOptionalReasonCode(value.reason_code, "terminal Watch settlement reason");
  if (
    value.completion_text !== undefined &&
    (
      typeof value.completion_text !== "string" ||
      value.completion_text.length > 4000 ||
      value.completion_text.includes("\0")
    )
  ) {
    throw new Error("terminal Watch completion text must be redacted and at most 4k");
  }
  assertOptionalNonEmptyString(
    value.completion_id,
    "terminal Watch completion id"
  );
  assertOptionalTimestamp(
    value.completion_timestamp,
    "terminal Watch completion timestamp"
  );
  if (
    !["completed", "failed"].includes(status) &&
    (
      value.completion_text !== undefined ||
      value.completion_id !== undefined ||
      value.completion_timestamp !== undefined
    )
  ) {
    throw new Error(
      "only completed or failed terminal Watches may carry completion output"
    );
  }
}

function assertNotificationOutbox(watch: Record<string, unknown>): void {
  if (!Array.isArray(watch.notification_outbox)) {
    throw new Error("terminal Watch notification outbox must be an array");
  }
  const seenIds = new Set<string>();
  const seenEvidence = new Set<string>();
  let previousCreatedAt = Date.parse(String(watch.created_at));
  for (const notification of watch.notification_outbox) {
    assertNotification(notification, String(watch.watch_id));
    if (seenIds.has(notification.notification_id)) {
      throw new Error("terminal Watch notification ids must be unique");
    }
    const evidenceKey = `${notification.kind}:${notification.evidence_fingerprint}`;
    if (seenEvidence.has(evidenceKey)) {
      throw new Error("terminal Watch notification evidence must be unique");
    }
    const createdAt = Date.parse(notification.created_at);
    if (
      createdAt < previousCreatedAt ||
      createdAt > Date.parse(String(watch.updated_at))
    ) {
      throw new Error("terminal Watch notification timestamps are not monotonic");
    }
    previousCreatedAt = createdAt;
    seenIds.add(notification.notification_id);
    seenEvidence.add(evidenceKey);
  }
  const approvalFingerprint = optionalString(watch.approval_fingerprint);
  if (
    approvalFingerprint &&
    !watch.notification_outbox.some((notification) =>
      notification.kind === "approval" &&
      notification.evidence_fingerprint === approvalFingerprint
    )
  ) {
    throw new Error("terminal Watch approval fingerprint has no notification");
  }
  if (watch.status !== "active") {
    const settlement = watch.settlement as TerminalWatchSettlement;
    const terminalNotifications = watch.notification_outbox.filter(
      (notification) => notification.kind !== "approval"
    );
    if (
      terminalNotifications.length !== 1 ||
      terminalNotifications[0].kind !== watch.status ||
      terminalNotifications[0].evidence_fingerprint !==
        settlement.evidence_fingerprint
    ) {
      throw new Error("terminal Watch settlement must have exactly one notification");
    }
  } else if (
    watch.notification_outbox.some((notification) =>
      notification.kind !== "approval"
    )
  ) {
    throw new Error("an active terminal Watch cannot have an outcome notification");
  }
}

function assertNotification(value: unknown, watchId: string): void {
  if (!isRecord(value)) {
    throw new Error("terminal Watch notification must be an object");
  }
  assertOnlyKeys(value, [
    "notification_id",
    "idempotency_key",
    "kind",
    "evidence_fingerprint",
    "reason_code",
    "status",
    "attempts",
    "created_at",
    "last_attempt_at",
    "attempt_id",
    "attempt_lease_expires_at",
    "failed_at",
    "next_attempt_at",
    "last_error_code",
    "delivered_at",
    "superseded_at"
  ], "terminal Watch notification");
  assertNotificationKind(value.kind);
  assertSha256(
    value.evidence_fingerprint,
    "terminal Watch notification fingerprint"
  );
  const expectedId = terminalWatchNotificationId(
    watchId,
    value.kind,
    value.evidence_fingerprint
  );
  if (
    value.notification_id !== expectedId ||
    value.idempotency_key !==
      terminalWatchNotificationIdempotencyKey(watchId, expectedId)
  ) {
    throw new Error("terminal Watch notification identity is not deterministic");
  }
  assertOptionalReasonCode(value.reason_code, "terminal Watch notification reason");
  if (!isNotificationStatus(value.status)) {
    throw new Error("terminal Watch notification status is invalid");
  }
  if (!isNonNegativeSafeInteger(value.attempts)) {
    throw new Error("terminal Watch notification attempts are invalid");
  }
  assertTimestamp(value.created_at, "terminal Watch notification created_at");
  assertOptionalTimestamp(
    value.last_attempt_at,
    "terminal Watch notification last_attempt_at"
  );
  assertOptionalTimestamp(
    value.attempt_lease_expires_at,
    "terminal Watch notification attempt lease"
  );
  assertOptionalTimestamp(value.failed_at, "terminal Watch notification failed_at");
  assertOptionalTimestamp(
    value.next_attempt_at,
    "terminal Watch notification next_attempt_at"
  );
  assertOptionalTimestamp(
    value.delivered_at,
    "terminal Watch notification delivered_at"
  );
  assertOptionalTimestamp(
    value.superseded_at,
    "terminal Watch notification superseded_at"
  );
  assertOptionalReasonCode(
    value.last_error_code,
    "terminal Watch notification error code"
  );
  assertOptionalNonEmptyString(
    value.attempt_id,
    "terminal Watch notification attempt id"
  );
  if (value.status === "pending") {
    assertNotificationShape(value, 0, []);
  } else if (value.status === "delivering") {
    assertNotificationShape(value, 1, [
      "last_attempt_at",
      "attempt_id",
      "attempt_lease_expires_at"
    ]);
  } else if (value.status === "failed") {
    assertNotificationShape(value, 1, [
      "last_attempt_at",
      "failed_at",
      "next_attempt_at",
      "last_error_code"
    ]);
  } else if (value.status === "superseded") {
    assertNotificationShape(value, 0, ["superseded_at"]);
  } else {
    assertNotificationShape(value, 1, ["last_attempt_at", "delivered_at"]);
  }
}

function assertNotificationShape(
  value: Record<string, unknown>,
  minimumAttempts: number,
  required: readonly string[]
): void {
  if (Number(value.attempts) < minimumAttempts) {
    throw new Error(`terminal Watch ${String(value.status)} notification has no attempt`);
  }
  for (const key of required) {
    if (value[key] === undefined) {
      throw new Error(
        `terminal Watch ${String(value.status)} notification requires ${key}`
      );
    }
  }
  const allowed = new Set(required);
  for (const key of [
    "last_attempt_at",
    "attempt_id",
    "attempt_lease_expires_at",
    "failed_at",
    "next_attempt_at",
    "last_error_code",
    "delivered_at",
    "superseded_at"
  ]) {
    if (value[key] !== undefined && !allowed.has(key)) {
      throw new Error(
        `terminal Watch ${String(value.status)} notification cannot carry ${key}`
      );
    }
  }
}

function assertTerminalWatchAdvance(
  current: TerminalWatch,
  candidate: TerminalWatch
): void {
  for (const [label, before, after] of [
    ["schema", current.schema, candidate.schema],
    ["version", current.version, candidate.version],
    ["watch_id", current.watch_id, candidate.watch_id],
    ["agent", current.agent, candidate.agent],
    ["terminal", current.terminal, candidate.terminal],
    ["anchor", current.anchor, candidate.anchor],
    ["openclaw_session", current.openclaw_session, candidate.openclaw_session],
    ["openclaw_bin", current.openclaw_bin, candidate.openclaw_bin],
    ["created_at", current.created_at, candidate.created_at],
    ["deadline_at", current.deadline_at, candidate.deadline_at]
  ] as const) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`terminal Watch cannot change immutable ${label}`);
    }
  }
  if (
    Date.parse(candidate.updated_at) < Date.parse(current.updated_at) ||
    Date.parse(candidate.last_activity_at) < Date.parse(current.last_activity_at)
  ) {
    throw new Error("terminal Watch update cannot move time backwards");
  }
  if (
    current.status !== "active" &&
    candidate.status !== current.status
  ) {
    throw new Error("a settled terminal Watch cannot change outcome");
  }
  if (
    current.settlement !== undefined &&
    JSON.stringify(candidate.settlement) !== JSON.stringify(current.settlement)
  ) {
    throw new Error("terminal Watch settlement is immutable");
  }
  if (current.status !== "active") {
    if (
      candidate.approval_fingerprint !== current.approval_fingerprint ||
      candidate.last_activity_at !== current.last_activity_at ||
      candidate.notification_outbox.length !== current.notification_outbox.length
    ) {
      throw new Error(
        "a settled terminal Watch may change only notification delivery receipts"
      );
    }
  } else if (
    candidate.approval_fingerprint !== current.approval_fingerprint
  ) {
    const added = candidate.notification_outbox.slice(
      current.notification_outbox.length
    );
    if (
      candidate.status !== "active" ||
      added.length !== 1 ||
      added[0].kind !== "approval" ||
      added[0].evidence_fingerprint !== candidate.approval_fingerprint
    ) {
      throw new Error(
        "terminal Watch approval fingerprint requires one appended notification"
      );
    }
  }
  assertNotificationAdvance(current.notification_outbox, candidate.notification_outbox);
}

function assertNotificationAdvance(
  current: readonly TerminalWatchNotification[],
  candidate: readonly TerminalWatchNotification[]
): void {
  if (candidate.length < current.length) {
    throw new Error("terminal Watch notification outbox is append-only");
  }
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index];
    const after = candidate[index];
    for (const key of [
      "notification_id",
      "idempotency_key",
      "kind",
      "evidence_fingerprint",
      "reason_code",
      "created_at"
    ] as const) {
      if (before[key] !== after[key]) {
        throw new Error(`terminal Watch notification cannot change immutable ${key}`);
      }
    }
    assertNotificationStatusAdvance(before, after);
  }
  for (const added of candidate.slice(current.length)) {
    if (added.status !== "pending" || added.attempts !== 0) {
      throw new Error("a terminal Watch notification must be appended pending");
    }
  }
}

function assertNotificationStatusAdvance(
  current: TerminalWatchNotification,
  candidate: TerminalWatchNotification
): void {
  const allowed: Record<TerminalWatchNotificationStatus, readonly TerminalWatchNotificationStatus[]> = {
    pending: ["pending", "delivering", "superseded"],
    delivering: ["delivering", "failed", "delivered", "superseded"],
    failed: ["failed", "delivering", "superseded"],
    delivered: ["delivered"],
    superseded: ["superseded"]
  };
  if (!allowed[current.status].includes(candidate.status)) {
    throw new Error(
      `terminal Watch notification cannot advance ${current.status} to ${candidate.status}`
    );
  }
  const reclaimed = current.status === "delivering" &&
    candidate.status === "delivering" &&
    candidate.attempt_id !== current.attempt_id;
  const claimed = ["pending", "failed"].includes(current.status) &&
    candidate.status === "delivering";
  const expectedAttempts = claimed || reclaimed
    ? current.attempts + 1
    : current.attempts;
  if (candidate.attempts !== expectedAttempts) {
    throw new Error("terminal Watch notification attempt count is not monotonic");
  }
  if (
    current.status === candidate.status &&
    !reclaimed &&
    JSON.stringify(current) !== JSON.stringify(candidate)
  ) {
    throw new Error(
      "terminal Watch notification receipt cannot change without a phase advance"
    );
  }
}

function atomicSaveTerminalWatch(filePath: string, watch: TerminalWatch): void {
  atomicSaveJsonFile(filePath, watch, {
    rootLabel: "AKK Store",
    directoryLabel: "terminal Watch root",
    fileLabel: "terminal Watch state",
    ensureDirectory: ensureDir,
    fsyncNewDirectoryParent: true
  });
  assertOwnerPrivateDirectory(path.dirname(filePath), "terminal Watch root");
  assertOwnerPrivateFile(filePath, "terminal Watch state");
}

function isRecognizedWatchLockFile(name: string): boolean {
  const suffix = name.endsWith(".json.lock.reclaim")
    ? ".json.lock.reclaim"
    : name.endsWith(".json.lock")
      ? ".json.lock"
      : undefined;
  if (!suffix) {
    return false;
  }
  const watchId = name.slice(0, -suffix.length);
  try {
    assertRecordId(watchId, "terminal Watch lock id");
    return true;
  } catch {
    return false;
  }
}

function isRecognizedWatchTemporaryFile(name: string): boolean {
  const match = /^\.(.+)\.json\.([1-9]\d*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u.exec(
    name
  );
  if (!match) return false;
  try {
    assertRecordId(match[1], "terminal Watch temporary id");
    return true;
  } catch {
    return false;
  }
}

function assertPrivateTransientEntry(filePath: string): void {
  try {
    assertOwnerPrivateFile(filePath, "terminal Watch transient file");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function assertOwnerPrivateDirectory(directory: string, label: string): void {
  assertRealDirectory(directory, label);
  const mode = fs.lstatSync(directory).mode & 0o777;
  if (mode !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`${label} must have owner-private 0700 permissions: ${directory}`);
  }
}

function assertOwnerPrivateFile(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error(`${label} must have owner-private 0600 permissions: ${filePath}`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new Error(`${label} contains unsupported field ${unknown}`);
  }
}

function assertExpectedRevision(value: unknown): asserts value is number | null {
  if (value !== null && !isPositiveSafeInteger(value)) {
    throw new Error("expectedRevision must be null or a positive safe integer");
  }
}

function assertRecordId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    value === "." ||
    value === ".." ||
    path.posix.basename(value) !== value ||
    path.win32.basename(value) !== value ||
    path.isAbsolute(value)
  ) {
    throw new Error(`${label} is not safe for storage: ${String(value)}`);
  }
}

function assertContained(candidate: string, parent: string, label: string): void {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate === resolvedParent ||
    !resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`)
  ) {
    throw new Error(`${label} escapes its Store root: ${candidate}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isExecutorKind(value: unknown): value is ExecutorKind {
  return value === "codex" || value === "claude";
}

function isWatchStatus(value: unknown): value is TerminalWatchStatus {
  return [
    "active",
    "completed",
    "failed",
    "timed_out",
    "invalidated",
    "cancelled"
  ].includes(String(value));
}

function assertNotificationKind(
  value: unknown
): asserts value is TerminalWatchNotificationKind {
  if (![
    "approval",
    "completed",
    "failed",
    "timed_out",
    "invalidated",
    "cancelled"
  ].includes(String(value))) {
    throw new Error("terminal Watch notification kind is invalid");
  }
}

function isNotificationStatus(
  value: unknown
): value is TerminalWatchNotificationStatus {
  return [
    "pending",
    "delivering",
    "failed",
    "delivered",
    "superseded"
  ].includes(
    String(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
}

function assertOptionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined) {
    assertNonEmptyString(value, label);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertOptionalSha256(value: unknown, label: string): void {
  if (value !== undefined) {
    assertSha256(value, label);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

function assertOptionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined) {
    assertTimestamp(value, label);
  }
}

function assertOptionalReasonCode(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9_.:-]*$/u.test(value)
  ) {
    throw new Error(`${label} must be a privacy-safe reason code`);
  }
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split(/[\\/]/u);
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
