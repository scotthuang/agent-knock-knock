import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  callbackEnvelopeMatchesRoute,
  createCallbackEnvelope,
  createLegacyOpenClawCallbackRoute,
  createTerminalWatchOpenClawCallbackRoute,
  parseCallbackRoute,
  type CallbackEnvelopeV1,
  type CallbackRouteV1
} from "./callback-transport.js";
import { canonicalJson } from "./canonical-json.js";
import {
  assertRealDirectory,
  atomicSaveJsonFile,
  isNodeError,
  readJsonFileNoFollow
} from "./durable-json-file.js";
import type { ExecutorKind } from "./executors.js";
import {
  claudeTranscriptAnchorFingerprint,
  type ClaudeTranscriptAnchor,
  initialClaudeHumanStartedActiveTaskCheckpoint,
  validateClaudeHumanStartedActiveTaskCheckpoint,
  validateClaudeHumanStartedActiveTaskAnchor,
  type ClaudeHumanStartedActiveTaskAnchor,
  type ClaudeHumanStartedActiveTaskCheckpoint
} from "./claude-local-transcript-provider.js";
import {
  validateCodexHumanStartedActiveTaskAnchor,
  type CodexHumanStartedActiveTaskAnchor
} from "./terminal-submission-acceptance.js";
import {
  exactNativeThreadId,
  normalizedRolloutIdentity,
  validateCodexRolloutAcceptanceAnchor,
  validateTerminalSubmissionAcceptanceEvidence,
  type CodexRolloutAcceptanceAnchor,
  type CodexRolloutIdentity,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-facts.js";
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
import { isRecord } from "./value-guards.js";

export const TERMINAL_WATCH_SCHEMA = "agent-knock-knock/terminal-watch" as const;
export const TERMINAL_WATCH_VERSION = 2 as const;
export const TERMINAL_WATCHES_DIRECTORY =
  STORE_TERMINAL_WATCHES_DIRECTORY;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const TERMINAL_WATCH_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "timed_out",
  "invalidated",
  "cancelled"
] as const;
const TERMINAL_WATCH_STATUSES = [
  "active",
  ...TERMINAL_WATCH_TERMINAL_STATUSES
] as const;
const TERMINAL_WATCH_NOTIFICATION_KINDS = [
  "approval",
  ...TERMINAL_WATCH_TERMINAL_STATUSES
] as const;
const TERMINAL_WATCH_NOTIFICATION_STATUSES = [
  "pending",
  "delivering",
  "failed",
  "delivered",
  "superseded"
] as const;

export type TerminalWatchStatus = typeof TERMINAL_WATCH_STATUSES[number];
export type TerminalWatchTerminalStatus =
  typeof TERMINAL_WATCH_TERMINAL_STATUSES[number];

export interface TerminalWatchTerminalIdentity {
  terminal_id: string;
  terminal_endpoint: TerminalControlEvidence;
  workspace: string;
  binding_token: string;
}

export type TerminalWatchAnchor =
  | CodexHumanStartedActiveTaskAnchor
  | ClaudeHumanStartedActiveTaskAnchor
  | CodexUserExplicitFallbackWatchAnchor
  | ClaudeUserExplicitFallbackWatchAnchor
  | TerminalActivityWatchAnchor;

export type TerminalActivityState =
  | "awaiting_approval"
  | "working"
  | "idle"
  | "unknown";

/**
 * Observation-only fallback for a user-selected live terminal. It deliberately
 * carries no task ownership claim: when a provider artifact cannot name one
 * exact task, the Watch follows only this terminal/process activity epoch.
 */
export interface TerminalActivityWatchAnchor {
  schema: "agent-knock-knock/terminal-activity-watch-anchor";
  version: 1;
  captured_at: string;
  terminal_id: string;
  pid: number;
  initial_activity_state: TerminalActivityState;
  native_process_uuid?: string;
  native_process_birth?: string;
  agent_version?: string;
  anchor_fingerprint: string;
}

export function isTerminalActivityWatch(
  watch: Pick<TerminalWatch, "anchor">
): watch is Pick<TerminalWatch, "anchor"> & {
  anchor: TerminalActivityWatchAnchor;
} {
  return watch.anchor.schema ===
    "agent-knock-knock/terminal-activity-watch-anchor";
}

export function createTerminalActivityWatchAnchor(input: {
  capturedAt: Date;
  terminalId: string;
  pid: number;
  initialActivityState: TerminalActivityState;
  nativeProcessUuid?: string;
  nativeProcessBirth?: string;
  agentVersion?: string;
}): TerminalActivityWatchAnchor {
  const base = {
    schema: "agent-knock-knock/terminal-activity-watch-anchor" as const,
    version: 1 as const,
    captured_at: input.capturedAt.toISOString(),
    terminal_id: nonEmptyString(input.terminalId, "terminal id"),
    pid: positiveIntegerValue(input.pid, "terminal PID"),
    initial_activity_state: input.initialActivityState,
    ...(input.nativeProcessUuid === undefined
      ? {}
      : {
          native_process_uuid: nonEmptyString(
            input.nativeProcessUuid,
            "native process UUID"
          )
        }),
    ...(input.nativeProcessBirth === undefined
      ? {}
      : {
          native_process_birth: nonEmptyString(
            input.nativeProcessBirth,
            "native process birth"
          )
        }),
    ...(input.agentVersion === undefined
      ? {}
      : {
          agent_version: nonEmptyString(input.agentVersion, "agent version")
        })
  };
  return { ...base, anchor_fingerprint: fingerprintValue(base) };
}

export interface CodexUserExplicitFallbackWatchAnchor {
  schema: "agent-knock-knock/codex-user-explicit-fallback-watch-anchor";
  version: 1;
  captured_at: string;
  request_hash: string;
  codex_version: string;
  acceptance_anchor: CodexRolloutAcceptanceAnchor;
  anchor_fingerprint: string;
}

export interface ClaudeUserExplicitFallbackWatchAnchor {
  schema: "agent-knock-knock/claude-user-explicit-fallback-watch-anchor";
  version: 1;
  captured_at: string;
  request_hash: string;
  claude_version: string;
  transcript_anchor: ClaudeTranscriptAnchor;
  anchor_fingerprint: string;
}

export type UserExplicitFallbackWatchAnchor =
  | CodexUserExplicitFallbackWatchAnchor
  | ClaudeUserExplicitFallbackWatchAnchor;

export function isUserExplicitFallbackWatch(
  watch: Pick<TerminalWatch, "anchor">
): watch is Pick<TerminalWatch, "anchor"> & {
  anchor: UserExplicitFallbackWatchAnchor;
} {
  return watch.anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor" ||
    watch.anchor.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor";
}

export function terminalUserExplicitFallbackWatchId(input: {
  messageId: string;
  physicalToken: string;
  requestHash: string;
}): string {
  const digest = createHash("sha256").update(canonicalJson({
    schema: "agent-knock-knock/terminal-user-explicit-fallback-watch-id",
    version: 1,
    message_id: nonEmptyString(input.messageId, "message id"),
    physical_token: nonEmptyString(input.physicalToken, "physical token"),
    request_hash: sha256String(input.requestHash, "request hash")
  })).digest("hex");
  return `terminal-watch-user-send-${digest}`;
}

export function createCodexUserExplicitFallbackWatchAnchor(input: {
  acceptanceAnchor: CodexRolloutAcceptanceAnchor;
  requestHash: string;
  codexVersion: string;
}): CodexUserExplicitFallbackWatchAnchor {
  const acceptanceAnchor = validateCodexRolloutAcceptanceAnchor(
    input.acceptanceAnchor
  );
  const base = {
    schema:
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor" as const,
    version: 1 as const,
    captured_at: acceptanceAnchor.captured_at,
    request_hash: sha256String(input.requestHash, "request hash"),
    codex_version: nonEmptyString(input.codexVersion, "Codex version"),
    acceptance_anchor: acceptanceAnchor
  };
  return { ...base, anchor_fingerprint: fingerprintValue(base) };
}

export function createClaudeUserExplicitFallbackWatchAnchor(input: {
  transcriptAnchor: ClaudeTranscriptAnchor;
  requestHash: string;
  claudeVersion: string;
}): ClaudeUserExplicitFallbackWatchAnchor {
  const transcriptAnchor = validatedClaudeTranscriptAnchor(
    input.transcriptAnchor
  );
  const base = {
    schema:
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor" as const,
    version: 1 as const,
    captured_at: transcriptAnchor.captured_at,
    request_hash: sha256String(input.requestHash, "request hash"),
    claude_version: nonEmptyString(input.claudeVersion, "Claude version"),
    transcript_anchor: transcriptAnchor
  };
  return { ...base, anchor_fingerprint: fingerprintValue(base) };
}

/**
 * Mutable, privacy-safe progress through the append-only provider artifact.
 * The immutable anchor continues to name the exact task; this cursor may only
 * advance after a provider proves a complete, stable JSONL boundary.
 */
export interface CodexTerminalWatchObservationCheckpoint {
  safe_resume_offset_bytes: number;
}

export interface CodexUserExplicitFallbackWatchAcceptedIdentity {
  native_thread_id: string;
  process_uuid: string;
  process_birth: string;
  rollout: CodexRolloutIdentity;
}

export interface CodexUserExplicitFallbackWatchObservationCheckpoint {
  schema:
    "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint";
  version: 1;
  safe_resume_offset_bytes: number;
  acceptance_evidence?: TerminalSubmissionAcceptanceEvidence;
  accepted_identity?: CodexUserExplicitFallbackWatchAcceptedIdentity;
}

export interface ClaudeUserExplicitFallbackWatchObservationCheckpoint {
  schema:
    "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint";
  version: 1;
  safe_resume_offset_bytes: number;
  acceptance_evidence?: TerminalSubmissionAcceptanceEvidence;
  accepted_prompt_uuid?: string;
}

export interface TerminalActivityWatchObservationCheckpoint {
  schema: "agent-knock-knock/terminal-activity-watch-checkpoint";
  version: 1;
  safe_resume_offset_bytes: 0;
  has_seen_activity: boolean;
  consecutive_idle_observations: number;
  last_activity_state: TerminalActivityState;
}

export type TerminalWatchObservationCheckpoint =
  | CodexTerminalWatchObservationCheckpoint
  | CodexUserExplicitFallbackWatchObservationCheckpoint
  | ClaudeUserExplicitFallbackWatchObservationCheckpoint
  | ClaudeHumanStartedActiveTaskCheckpoint
  | TerminalActivityWatchObservationCheckpoint;

export function initialTerminalWatchObservationCheckpoint(
  anchor: TerminalWatchAnchor
): TerminalWatchObservationCheckpoint {
  if (
    anchor.schema === "agent-knock-knock/terminal-activity-watch-anchor"
  ) {
    return {
      schema: "agent-knock-knock/terminal-activity-watch-checkpoint",
      version: 1,
      safe_resume_offset_bytes: 0,
      has_seen_activity:
        anchor.initial_activity_state === "working" ||
        anchor.initial_activity_state === "awaiting_approval",
      consecutive_idle_observations: 0,
      last_activity_state: anchor.initial_activity_state
    };
  }
  if (
    anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    return initialClaudeHumanStartedActiveTaskCheckpoint(anchor);
  }
  if (
    anchor.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  ) {
    return {
      schema:
        "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint",
      version: 1,
      safe_resume_offset_bytes: anchor.transcript_anchor.offset_bytes
    };
  }
  if (
    anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    return {
      schema:
        "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint",
      version: 1,
      safe_resume_offset_bytes: anchor.acceptance_anchor.offset_bytes
    };
  }
  return {
    safe_resume_offset_bytes:
      validateCodexHumanStartedActiveTaskAnchor(anchor)
        .observed_end_offset_bytes
  };
}

export type TerminalWatchNotificationKind =
  typeof TERMINAL_WATCH_NOTIFICATION_KINDS[number];
export type TerminalWatchNotificationStatus =
  typeof TERMINAL_WATCH_NOTIFICATION_STATUSES[number];

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
  callback_route?: CallbackRouteV1;
  callback_envelope?: CallbackEnvelopeV1;
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
  observation_checkpoint: TerminalWatchObservationCheckpoint;
  /** Immutable creation-time diagnostics; none of these veto observation. */
  warnings?: string[];
  /** Immutable callback authority captured by a native Host at Watch creation. */
  callback_route?: CallbackRouteV1;
  openclaw_session: string;
  openclaw_bin: string;
  created_at: string;
  deadline_at: string;
  updated_at: string;
  status: TerminalWatchStatus;
  last_activity_at: string;
  settlement?: TerminalWatchSettlement;
  notification_outbox: TerminalWatchNotification[];
}

export type TerminalWatchCallbackEvent =
  | "approval_required"
  | TerminalWatchTerminalStatus;

export interface TerminalWatchCallbackMessageInput {
  watchId: string;
  event: TerminalWatchCallbackEvent;
  agent: ExecutorKind;
  terminalId: string;
  origin?:
    | "user_selected_terminal"
    | "terminal_user_explicit_fallback"
    | "terminal_activity_fallback";
  detail?: string;
  completionText?: string;
}

export function terminalWatchCallbackEnvelope(
  watch: TerminalWatch,
  notification: TerminalWatchNotification,
  route: CallbackRouteV1
): CallbackEnvelopeV1 {
  const event: TerminalWatchCallbackEvent = notification.kind === "approval"
    ? "approval_required"
    : notification.kind;
  const reasonCode = notification.kind === "approval"
    ? notification.reason_code
    : notification.reason_code ?? watch.settlement?.reason_code;
  return createCallbackEnvelope({
    route,
    deliveryId: notification.notification_id,
    idempotencyKey: notification.idempotency_key,
    source: {
      kind: "terminal_watch",
      watch_id: watch.watch_id,
      terminal_id: watch.terminal.terminal_id
    },
    event: {
      id: notification.notification_id,
      type: event,
      body: terminalWatchCallbackMessage({
        watchId: watch.watch_id,
        event,
        agent: watch.agent,
        terminalId: watch.terminal.terminal_id,
        origin: isUserExplicitFallbackWatch(watch)
          ? "terminal_user_explicit_fallback"
          : isTerminalActivityWatch(watch)
            ? "terminal_activity_fallback"
            : "user_selected_terminal",
        detail: reasonCode,
        completionText: notification.kind === "completed" ||
            notification.kind === "failed"
          ? watch.settlement?.completion_text
          : undefined
      }),
      requires_response: true,
      metadata: {
        agent: watch.agent,
        watch_origin: isUserExplicitFallbackWatch(watch)
          ? "terminal_user_explicit_fallback"
          : isTerminalActivityWatch(watch)
            ? "terminal_activity_fallback"
            : "user_selected_terminal",
        watch_mode: isTerminalActivityWatch(watch)
          ? "terminal_activity"
          : "exact_task",
        confidence: isTerminalActivityWatch(watch)
          ? "best_effort"
          : "exact",
        ...(reasonCode
          ? { reason_code: reasonCode }
          : {}),
        ...((notification.kind === "completed" ||
              notification.kind === "failed") &&
            watch.settlement?.completion_text
          ? { completion_text: watch.settlement.completion_text }
          : {})
      }
    }
  });
}

export function terminalWatchCallbackMessage(
  input: TerminalWatchCallbackMessageInput
): string {
  const userExplicitFallback =
    input.origin === "terminal_user_explicit_fallback";
  const terminalActivityFallback =
    input.origin === "terminal_activity_fallback";
  const eventInstruction = input.event === "approval_required"
    ? "Tell the user that the observed TUI task is waiting for approval and ask the human to inspect and decide in the named live TUI. Do not call any AKK approval tool or action, do not send approval keys, and do not use autoApprove."
    : input.event === "completed"
      ? userExplicitFallback
        ? "Tell the user that the request delivered through AKK's user-explicit unmanaged fallback completed and summarize only the bounded completion text below."
        : terminalActivityFallback
          ? "Tell the user that the selected terminal's observed activity became idle. Explain that this was a best-effort terminal-activity Watch, not an exact task completion proof."
          : "Tell the user that the exact task anchor in the selected TUI completed and summarize only the bounded completion text below."
      : "Tell the user that Terminal Watch stopped without a verified successful completion and explain the exact reason below.";
  return [
    "Continue this controller conversation from the Agent Knock Knock Terminal Watch event below.",
    userExplicitFallback
      ? "AKK delivered this exact request through terminal_user_explicit unmanaged fallback and then attached Terminal Watch. It is not a managed AKK Turn."
      : terminalActivityFallback
        ? "This is a read-only best-effort observation of the exact selected terminal/process activity epoch. It is not an AKK Turn and AKK did not send terminal input."
        : "This is a read-only observation of an exact task anchor in the terminal selected by the user. Terminal Watch itself did not send, adopt, or mutate the task; the task may independently have an AKK-managed Turn.",
    eventInstruction,
    "Do not poll files, processes, terminal panes, stdout, or stderr. Use only this structured event.",
    "",
    `[AKK Terminal Watch: ${input.event}]`,
    `Watch: ${input.watchId}`,
    `Terminal: ${input.terminalId}`,
    `Agent: ${input.agent}`,
    ...(input.detail ? [`Detail: ${input.detail}`] : []),
    ...(input.completionText
      ? ["", "Bounded completion text:", input.completionText]
      : [])
  ].join("\n");
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
  scanForReconciliation(): TerminalWatchReconciliationScan;
  load(watchId: string): TerminalWatch;
  save(
    watch: TerminalWatch,
    options: TerminalWatchSaveOptions
  ): TerminalWatch;
  withWatchLock<Result>(watchId: string, operation: () => Result): Result;
}

export interface TerminalWatchReconciliationScanError {
  watch_id: string;
  error_code: "terminal_watch_record_invalid";
}

export interface TerminalWatchReconciliationScan {
  watches: TerminalWatch[];
  errors: TerminalWatchReconciliationScanError[];
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
    scanForReconciliation: () => scanTerminalWatchesForReconciliation(storeDir),
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
      workspace: watch.terminal.workspace,
      binding_token: watch.terminal.binding_token,
      anchor_fingerprint: watch.anchor.anchor_fingerprint
    }))
    .digest("hex");
}

export function terminalWatchRevision(watch: TerminalWatch): number {
  if (!isPositiveSafeInteger(watch.revision)) {
    throw new Error(`terminal Watch ${watch.watch_id} has no valid revision`);
  }
  return watch.revision;
}

type FieldGuard = (value: unknown, label: string) => void;
type StrictShape = Readonly<Record<string, FieldGuard>>;

const IGNORE_VALUE: FieldGuard = () => {};
const POSITIVE_INTEGER: FieldGuard = (value, label) => {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`${label} must be a positive safe integer`);
  }
};
const NON_NEGATIVE_INTEGER: FieldGuard = (value, label) => {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
};
const ARRAY_VALUE: FieldGuard = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
};
const WARNING_LIST: FieldGuard = (value, label) => {
  if (
    !Array.isArray(value) ||
    value.some((warning) =>
      typeof warning !== "string" || warning.trim().length === 0
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must contain unique non-empty strings`);
  }
};
const ABSOLUTE_PATH: FieldGuard = (value, label) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
};
const NULLABLE_ENDPOINT_STRING: FieldGuard = optionalGuard((value, label) => {
  if (
    value !== null &&
    (typeof value !== "string" || value.includes("\0"))
  ) {
    throw new Error(`${label} is invalid`);
  }
});

const WATCH_FIELDS = {
  schema: literalGuard(TERMINAL_WATCH_SCHEMA),
  version: literalGuard(TERMINAL_WATCH_VERSION),
  watch_id: assertRecordId,
  revision: optionalGuard(POSITIVE_INTEGER),
  agent: oneOfGuard(["codex", "claude"]),
  terminal: assertTerminalIdentity,
  anchor: IGNORE_VALUE,
  observation_checkpoint: IGNORE_VALUE,
  warnings: optionalGuard(WARNING_LIST),
  callback_route: optionalGuard(IGNORE_VALUE),
  openclaw_session: assertNonEmptyString,
  openclaw_bin: assertNonEmptyString,
  created_at: assertTimestamp,
  deadline_at: assertTimestamp,
  updated_at: assertTimestamp,
  status: oneOfGuard(TERMINAL_WATCH_STATUSES),
  last_activity_at: assertTimestamp,
  settlement: IGNORE_VALUE,
  notification_outbox: ARRAY_VALUE
} satisfies StrictShape;

const TERMINAL_IDENTITY_FIELDS = {
  terminal_id: assertNonEmptyString,
  terminal_endpoint: assertTerminalEndpoint,
  workspace: ABSOLUTE_PATH,
  binding_token: assertSha256
} satisfies StrictShape;

const TERMINAL_ENDPOINT_FIELDS = {
  schema: literalGuard("agent-knock-knock/terminal-endpoint"),
  version: literalGuard(1),
  kind: IGNORE_VALUE,
  endpoint_key: IGNORE_VALUE,
  resource_key: IGNORE_VALUE,
  route_key: IGNORE_VALUE,
  process_anchor_pid: POSITIVE_INTEGER,
  target: NULLABLE_ENDPOINT_STRING,
  socket_path: NULLABLE_ENDPOINT_STRING,
  pane_pid: optionalGuard(nullableGuard(POSITIVE_INTEGER)),
  server_socket_path: NULLABLE_ENDPOINT_STRING,
  pane_id: NULLABLE_ENDPOINT_STRING,
  session_name: NULLABLE_ENDPOINT_STRING,
  session_dir: NULLABLE_ENDPOINT_STRING,
  workspace_id: NULLABLE_ENDPOINT_STRING,
  tab_id: NULLABLE_ENDPOINT_STRING,
  terminal_id: NULLABLE_ENDPOINT_STRING,
  current_path: NULLABLE_ENDPOINT_STRING
} satisfies StrictShape;

const SETTLEMENT_FIELDS = {
  kind: oneOfGuard(TERMINAL_WATCH_TERMINAL_STATUSES),
  evidence_fingerprint: assertSha256,
  observed_at: assertTimestamp,
  reason_code: optionalGuard(assertReasonCode),
  completion_text: optionalGuard(assertCompletionText),
  completion_id: optionalGuard(assertNonEmptyString),
  completion_timestamp: optionalGuard(assertTimestamp)
} satisfies StrictShape;

const NOTIFICATION_RECEIPT_FIELDS = {
  last_attempt_at: optionalGuard(assertTimestamp),
  attempt_id: optionalGuard(assertNonEmptyString),
  attempt_lease_expires_at: optionalGuard(assertTimestamp),
  failed_at: optionalGuard(assertTimestamp),
  next_attempt_at: optionalGuard(assertTimestamp),
  last_error_code: optionalGuard(assertReasonCode),
  delivered_at: optionalGuard(assertTimestamp),
  superseded_at: optionalGuard(assertTimestamp)
} satisfies StrictShape;

const NOTIFICATION_FIELDS = {
  notification_id: assertNonEmptyString,
  idempotency_key: assertNonEmptyString,
  kind: oneOfGuard(TERMINAL_WATCH_NOTIFICATION_KINDS),
  evidence_fingerprint: assertSha256,
  reason_code: optionalGuard(assertReasonCode),
  callback_route: IGNORE_VALUE,
  callback_envelope: IGNORE_VALUE,
  status: oneOfGuard(TERMINAL_WATCH_NOTIFICATION_STATUSES),
  attempts: NON_NEGATIVE_INTEGER,
  created_at: assertTimestamp,
  ...NOTIFICATION_RECEIPT_FIELDS
} satisfies StrictShape;

type NotificationReceiptField = keyof typeof NOTIFICATION_RECEIPT_FIELDS;
const NOTIFICATION_SHAPES = {
  pending: [0, []],
  delivering: [1, [
    "last_attempt_at",
    "attempt_id",
    "attempt_lease_expires_at"
  ]],
  failed: [1, [
    "last_attempt_at",
    "failed_at",
    "next_attempt_at",
    "last_error_code"
  ]],
  delivered: [1, ["last_attempt_at", "delivered_at"]],
  superseded: [0, ["superseded_at"]]
} as const satisfies Record<
  TerminalWatchNotificationStatus,
  readonly [number, readonly NotificationReceiptField[]]
>;

export function assertTerminalWatch(
  value: unknown,
  expectedWatchId?: string,
  options: { allowMissingRevision?: boolean } = {}
): asserts value is TerminalWatch {
  assertStrictRecord(value, "terminal Watch", WATCH_FIELDS);
  if (expectedWatchId !== undefined && value.watch_id !== expectedWatchId) {
    throw new Error(
      `terminal Watch id ${String(value.watch_id)} does not match ${expectedWatchId}`
    );
  }
  if (value.revision === undefined && !options.allowMissingRevision) {
    throw new Error("terminal Watch revision must be a positive safe integer");
  }
  const watch = value as unknown as TerminalWatch;
  assertTerminalWatchAnchor(
    watch.anchor,
    watch.agent,
    watch.terminal
  );
  assertTerminalWatchObservationCheckpoint(
    watch.observation_checkpoint,
    watch.anchor
  );
  const checkpoint = watch.observation_checkpoint;
  if (
    isTerminalActivityWatch(watch) &&
    "schema" in checkpoint &&
    checkpoint.schema ===
      "agent-knock-knock/terminal-activity-watch-checkpoint" &&
    watch.status === "active" &&
    checkpoint.consecutive_idle_observations > 1
  ) {
    throw new Error(
      "an active terminal activity Watch cannot already carry stable-idle settlement evidence"
    );
  }
  if (watch.callback_route !== undefined) {
    const route = parseCallbackRoute(watch.callback_route);
    if (route.controller_session_id !== watch.openclaw_session) {
      throw new Error(
        "terminal Watch callback route does not match its controller session"
      );
    }
  }
  const minimumCheckpointOffset = watch.anchor.schema ===
      "agent-knock-knock/terminal-activity-watch-anchor"
    ? 0
    : watch.anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
      ? watch.anchor.turn_start_offset_bytes
      : watch.anchor.schema ===
          "agent-knock-knock/codex-human-started-active-task-anchor"
        ? watch.anchor.observed_end_offset_bytes
        : watch.anchor.schema ===
            "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
          ? watch.anchor.transcript_anchor.offset_bytes
          : watch.anchor.acceptance_anchor.offset_bytes;
  if (
    watch.observation_checkpoint.safe_resume_offset_bytes <
      minimumCheckpointOffset
  ) {
    throw new Error(
      "terminal Watch observation checkpoint cannot predate its task anchor"
    );
  }
  if (
    Date.parse(watch.deadline_at) <= Date.parse(watch.created_at) ||
    Date.parse(watch.updated_at) < Date.parse(watch.created_at) ||
    Date.parse(watch.last_activity_at) > Date.parse(watch.updated_at)
  ) {
    throw new Error("terminal Watch timestamps are not monotonic");
  }
  const processStartedAt = watch.anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
      ? watch.anchor.agent_started_at_ms
      : watch.anchor.schema ===
          "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
        ? watch.anchor.transcript_anchor.agent_started_at_ms
        : undefined;
  if (
    Date.parse(watch.anchor.captured_at) > Date.parse(watch.created_at) ||
    (
      processStartedAt !== undefined &&
      processStartedAt > Date.parse(watch.created_at)
    )
  ) {
    throw new Error("terminal Watch cannot predate its exact observation anchor");
  }
  assertSettlement(watch.settlement, watch.status);
  if (
    watch.settlement &&
    (
      Date.parse(watch.settlement.observed_at) > Date.parse(watch.updated_at) ||
      (
        watch.settlement.completion_timestamp !== undefined &&
        Date.parse(watch.settlement.completion_timestamp) >
          Date.parse(watch.updated_at)
      )
    )
  ) {
    throw new Error("terminal Watch settlement cannot be newer than its state");
  }
  assertNotificationOutbox(watch);
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
  return decodeTerminalWatch(value, watchId);
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
  const scan = scanTerminalWatchDirectory(storeDir, false);
  return scan.watches;
}

/**
 * Reconciliation isolates only malformed contents of an already-named JSON
 * record. Directory shape, symlinks, unknown entries, permissions, and I/O
 * failures remain global fail-closed boundaries.
 */
export function scanTerminalWatchesForReconciliation(
  storeDir: string
): TerminalWatchReconciliationScan {
  return scanTerminalWatchDirectory(storeDir, true);
}

function scanTerminalWatchDirectory(
  storeDir: string,
  isolateInvalidRecord: boolean
): TerminalWatchReconciliationScan {
  if (!fs.existsSync(storeDir)) {
    return { watches: [], errors: [] };
  }
  assertStoreReadable(storeDir);
  const root = terminalWatchesDir(storeDir);
  if (!fs.existsSync(root)) {
    return { watches: [], errors: [] };
  }
  assertOwnerPrivateDirectory(root, "terminal Watch root");
  const watches: TerminalWatch[] = [];
  const errors: TerminalWatchReconciliationScanError[] = [];
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
    if (!isolateInvalidRecord) {
      watches.push(loadTerminalWatch(storeDir, watchId));
      continue;
    }
    // Establish the filesystem/security boundary before isolating JSON syntax
    // or schema errors. A race, permission failure, or non-regular replacement
    // must still abort the whole scan.
    assertOwnerPrivateFile(entryPath, "terminal Watch state");
    let value: unknown;
    try {
      value = readJsonFileNoFollow(entryPath, "terminal Watch state");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      errors.push({
        watch_id: watchId,
        error_code: "terminal_watch_record_invalid"
      });
      continue;
    }
    try {
      watches.push(decodeTerminalWatch(value, watchId));
    } catch {
      errors.push({
        watch_id: watchId,
        error_code: "terminal_watch_record_invalid"
      });
    }
  }
  watches.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at) ||
    left.watch_id.localeCompare(right.watch_id)
  );
  errors.sort((left, right) => left.watch_id.localeCompare(right.watch_id));
  return { watches, errors };
}

function decodeTerminalWatch(
  value: unknown,
  expectedWatchId: string
): TerminalWatch {
  const sourceVersion = isRecord(value) ? value.version : undefined;
  const normalized = normalizeLegacyTerminalWatch(value);
  assertTerminalWatch(normalized, expectedWatchId);
  const repaired = sourceVersion === TERMINAL_WATCH_VERSION
    ? repairMisroutedUserExplicitFallbackCallback(normalized)
    : normalized;
  assertTerminalWatch(repaired, expectedWatchId);
  return repaired;
}

const MISROUTED_FALLBACK_CALLBACK_ERROR =
  "callback_permanent_openclaw_callback_profile_changed";
const REPAIRED_FALLBACK_CALLBACK_ERROR =
  "callback_route_repaired_after_openclaw_profile_mismatch";
const REPAIRED_FALLBACK_CALLBACK_WARNING =
  "legacy_openclaw_fallback_callback_route_repaired";

/**
 * v0.12.19-v0.12.22 accidentally snapshotted the managed Send Gateway
 * method for user-explicit fallback Watches. That profile is rejected before
 * callback I/O, so this exact shape is safe to redirect and retry with the
 * original idempotency key. Every ambiguous or side-effect-capable state is
 * left untouched.
 */
function repairMisroutedUserExplicitFallbackCallback(
  watch: TerminalWatch
): TerminalWatch {
  if (!isUserExplicitFallbackWatch(watch) || !watch.callback_route) {
    return watch;
  }
  const misrouted = createLegacyOpenClawCallbackRoute({
    controllerSessionId: watch.openclaw_session,
    gatewayMethod: "agent-knock-knock.callback",
    openclawBin: watch.openclaw_bin
  });
  if (canonicalJson(watch.callback_route) !== canonicalJson(misrouted)) {
    return watch;
  }
  for (const notification of watch.notification_outbox) {
    const hasSnapshot = notification.callback_route !== undefined;
    if (
      notification.status === "delivered" ||
      notification.status === "delivering" ||
      (
        notification.status === "failed" &&
        (
          !hasSnapshot ||
          notification.last_error_code !== MISROUTED_FALLBACK_CALLBACK_ERROR
        )
      ) ||
      (
        notification.status === "pending" &&
        hasSnapshot
      )
    ) {
      return watch;
    }
    if (
      notification.callback_route !== undefined &&
      canonicalJson(notification.callback_route) !== canonicalJson(misrouted)
    ) {
      return watch;
    }
  }

  const route = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: watch.openclaw_session,
    openclawBin: watch.openclaw_bin
  });
  const repairedWatch: TerminalWatch = {
    ...watch,
    warnings: [...new Set([
      ...(watch.warnings ?? []),
      REPAIRED_FALLBACK_CALLBACK_WARNING
    ])],
    callback_route: route,
    notification_outbox: []
  };
  repairedWatch.notification_outbox = watch.notification_outbox.map(
    (notification) => {
      const repaired = notification.status === "failed"
        ? {
            ...notification,
            last_error_code: REPAIRED_FALLBACK_CALLBACK_ERROR
          }
        : { ...notification };
      if (notification.callback_route === undefined) return repaired;
      return {
        ...repaired,
        callback_route: route,
        callback_envelope: terminalWatchCallbackEnvelope(
          repairedWatch,
          repaired,
          route
        )
      };
    }
  );
  return repairedWatch;
}

function normalizeLegacyTerminalWatch(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.schema !== TERMINAL_WATCH_SCHEMA ||
    (value.version !== 1 && value.version !== TERMINAL_WATCH_VERSION) ||
    !isRecord(value.anchor)
  ) {
    return value;
  }
  const versionNormalized = value.version === TERMINAL_WATCH_VERSION
    ? value
    : { ...value, version: TERMINAL_WATCH_VERSION };
  if (value.observation_checkpoint !== undefined) {
    return versionNormalized;
  }
  const anchor = value.anchor;
  if (
    anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    const validated = validateClaudeHumanStartedActiveTaskAnchor(anchor);
    return {
      ...versionNormalized,
      observation_checkpoint: initialTerminalWatchObservationCheckpoint(
        validated
      )
    };
  }
  if (
    anchor.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
  ) {
    const validated = validateCodexHumanStartedActiveTaskAnchor(anchor);
    return {
      ...versionNormalized,
      observation_checkpoint:
        initialTerminalWatchObservationCheckpoint(validated)
    };
  }
  return versionNormalized;
}

export function assertTerminalWatchObservationCheckpoint(
  value: unknown,
  anchor: TerminalWatchAnchor
): asserts value is TerminalWatchObservationCheckpoint {
  if (
    anchor.schema === "agent-knock-knock/terminal-activity-watch-anchor"
  ) {
    assertStrictRecord(value, "terminal activity Watch checkpoint", {
      schema: literalGuard(
        "agent-knock-knock/terminal-activity-watch-checkpoint"
      ),
      version: literalGuard(1),
      safe_resume_offset_bytes: literalGuard(0),
      has_seen_activity: (candidate, label) => {
        if (typeof candidate !== "boolean") {
          throw new Error(`${label} must be boolean`);
        }
      },
      consecutive_idle_observations: NON_NEGATIVE_INTEGER,
      last_activity_state: oneOfGuard([
        "awaiting_approval", "working", "idle", "unknown"
      ])
    });
    const checkpoint = value as unknown as
      TerminalActivityWatchObservationCheckpoint;
    if (
      checkpoint.consecutive_idle_observations > 0 &&
      (
        !checkpoint.has_seen_activity ||
        checkpoint.last_activity_state !== "idle"
      )
    ) {
      throw new Error(
        "terminal activity Watch idle observations require prior activity and an idle state"
      );
    }
    if (
      checkpoint.last_activity_state !== "idle" &&
      checkpoint.consecutive_idle_observations !== 0
    ) {
      throw new Error(
        "terminal activity Watch non-idle checkpoint cannot retain idle observations"
      );
    }
    return;
  }
  if (
    anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    validateClaudeHumanStartedActiveTaskCheckpoint(value, anchor);
    return;
  }
  if (
    anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    assertCodexUserExplicitFallbackWatchCheckpoint(value, anchor);
    return;
  }
  if (
    anchor.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  ) {
    assertClaudeUserExplicitFallbackWatchCheckpoint(value, anchor);
    return;
  }
  assertStrictRecord(value, "terminal Watch observation checkpoint", {
    safe_resume_offset_bytes: NON_NEGATIVE_INTEGER
  });
}

function assertCodexUserExplicitFallbackWatchCheckpoint(
  value: unknown,
  anchor: CodexUserExplicitFallbackWatchAnchor
): asserts value is CodexUserExplicitFallbackWatchObservationCheckpoint {
  assertStrictRecord(value, "Codex fallback Watch checkpoint", {
    schema: literalGuard(
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint"
    ),
    version: literalGuard(1),
    safe_resume_offset_bytes: NON_NEGATIVE_INTEGER,
    acceptance_evidence: optionalGuard(IGNORE_VALUE),
    accepted_identity: optionalGuard(IGNORE_VALUE)
  });
  const acceptanceValue = value.acceptance_evidence;
  const identityValue = value.accepted_identity;
  if ((acceptanceValue === undefined) !== (identityValue === undefined)) {
    throw new Error(
      "Codex fallback Watch checkpoint acceptance identity is incomplete"
    );
  }
  if (acceptanceValue === undefined || identityValue === undefined) {
    return;
  }
  assertStrictRecord(
    identityValue,
    "Codex fallback Watch accepted identity",
    {
      native_thread_id: assertNonEmptyString,
      process_uuid: assertNonEmptyString,
      process_birth: assertNonEmptyString,
      rollout: IGNORE_VALUE
    }
  );
  const nativeThreadId = exactNativeThreadId(
    identityValue.native_thread_id
  );
  if (!isRecord(identityValue.rollout)) {
    throw new Error("Codex fallback Watch accepted rollout is invalid");
  }
  const rollout = normalizedRolloutIdentity(identityValue.rollout);
  if (
    identityValue.native_thread_id !== nativeThreadId ||
    JSON.stringify(identityValue.rollout) !== JSON.stringify(rollout) ||
    !path.isAbsolute(rollout.path) ||
    identityValue.process_uuid !== anchor.acceptance_anchor.process_uuid ||
    identityValue.process_birth !== anchor.acceptance_anchor.process_birth
  ) {
    throw new Error(
      "Codex fallback Watch accepted identity does not match its anchor"
    );
  }
  const acceptance = validateTerminalSubmissionAcceptanceEvidence(
    acceptanceValue,
    {
      source: "codex_rollout",
      nativeThreadId,
      requestHash: anchor.request_hash
    }
  );
  if (
    acceptance.anchorFingerprint !==
      anchor.acceptance_anchor.anchor_fingerprint
  ) {
    throw new Error(
      "Codex fallback Watch acceptance evidence does not match its anchor"
    );
  }
  const observedEndOffset = acceptance.metadata?.observed_end_offset_bytes;
  if (
    typeof observedEndOffset !== "number" ||
    !Number.isSafeInteger(observedEndOffset) ||
    observedEndOffset <= anchor.acceptance_anchor.offset_bytes ||
    Number(value.safe_resume_offset_bytes) < observedEndOffset
  ) {
    throw new Error(
      "Codex fallback Watch acceptance checkpoint offset is invalid"
    );
  }
}

function assertClaudeUserExplicitFallbackWatchCheckpoint(
  value: unknown,
  anchor: ClaudeUserExplicitFallbackWatchAnchor
): asserts value is ClaudeUserExplicitFallbackWatchObservationCheckpoint {
  assertStrictRecord(value, "Claude fallback Watch checkpoint", {
    schema: literalGuard(
      "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint"
    ),
    version: literalGuard(1),
    safe_resume_offset_bytes: NON_NEGATIVE_INTEGER,
    acceptance_evidence: optionalGuard(IGNORE_VALUE),
    accepted_prompt_uuid: optionalGuard(IGNORE_VALUE)
  });
  const acceptanceValue = value.acceptance_evidence;
  const promptUuidValue = value.accepted_prompt_uuid;
  if ((acceptanceValue === undefined) !== (promptUuidValue === undefined)) {
    throw new Error(
      "Claude fallback Watch checkpoint acceptance identity is incomplete"
    );
  }
  if (acceptanceValue === undefined || promptUuidValue === undefined) {
    return;
  }
  const acceptedPromptUuid = exactUuid(
    promptUuidValue,
    "Claude fallback accepted prompt UUID"
  );
  const acceptance = validateTerminalSubmissionAcceptanceEvidence(
    acceptanceValue,
    {
      source: "claude_transcript",
      nativeThreadId: anchor.transcript_anchor.session_id,
      requestHash: anchor.request_hash
    }
  );
  const metadata = acceptance.metadata;
  const observedEndOffset = metadata?.observed_end_offset_bytes;
  if (
    acceptance.acceptanceId !== acceptedPromptUuid ||
    metadata?.prompt_uuid !== acceptedPromptUuid ||
    metadata?.claude_version !== anchor.claude_version ||
    metadata?.anchor_offset_bytes !== anchor.transcript_anchor.offset_bytes ||
    metadata?.agent_started_at_ms !==
      anchor.transcript_anchor.agent_started_at_ms ||
    acceptance.anchorFingerprint !==
      claudeTranscriptAnchorFingerprint(anchor.transcript_anchor) ||
    typeof observedEndOffset !== "number" ||
    !Number.isSafeInteger(observedEndOffset) ||
    observedEndOffset <= anchor.transcript_anchor.offset_bytes ||
    Number(value.safe_resume_offset_bytes) < observedEndOffset
  ) {
    throw new Error(
      "Claude fallback Watch acceptance checkpoint does not match its anchor"
    );
  }
}

function assertTerminalIdentity(
  value: unknown
): asserts value is TerminalWatchTerminalIdentity {
  assertStrictRecord(
    value,
    "terminal Watch terminal identity",
    TERMINAL_IDENTITY_FIELDS
  );
}

function assertTerminalEndpoint(value: unknown): void {
  assertStrictRecord(value, "terminal Watch endpoint", TERMINAL_ENDPOINT_FIELDS);
  if (
    !terminalEndpointIdentityFromEvidence(value) ||
    !terminalRouteKeyFromEvidence(value)
  ) {
    throw new Error("terminal Watch endpoint evidence is not exact");
  }
}

function assertTerminalWatchAnchor(
  value: unknown,
  agent: ExecutorKind,
  terminal: TerminalWatchTerminalIdentity
): asserts value is TerminalWatchAnchor {
  if (!isRecord(value)) {
    throw new Error("terminal Watch anchor must be an object");
  }
  if (
    value.schema === "agent-knock-knock/terminal-activity-watch-anchor"
  ) {
    assertStrictRecord(value, "terminal activity Watch anchor", {
      schema: literalGuard(
        "agent-knock-knock/terminal-activity-watch-anchor"
      ),
      version: literalGuard(1),
      captured_at: assertTimestamp,
      terminal_id: assertNonEmptyString,
      pid: POSITIVE_INTEGER,
      initial_activity_state: oneOfGuard([
        "awaiting_approval", "working", "idle", "unknown"
      ]),
      native_process_uuid: optionalGuard(assertNonEmptyString),
      native_process_birth: optionalGuard(assertNonEmptyString),
      agent_version: optionalGuard(assertNonEmptyString),
      anchor_fingerprint: assertSha256
    });
    if (value.terminal_id !== terminal.terminal_id) {
      throw new Error(
        "terminal activity Watch id does not match its terminal identity"
      );
    }
    assertAnchorFingerprint(value, "terminal activity Watch anchor");
    return;
  }
  if (
    value.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
  ) {
    if (agent !== "codex") {
      throw new Error("Codex Watch anchor cannot belong to another agent");
    }
    validateCodexHumanStartedActiveTaskAnchor(value);
    return;
  }
  if (
    value.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    if (agent !== "claude") {
      throw new Error("Claude Watch anchor cannot belong to another agent");
    }
    const anchor = validateClaudeHumanStartedActiveTaskAnchor(value);
    if (anchor.cwd !== terminal.workspace) {
      throw new Error("Claude Watch workspace does not match its task anchor");
    }
    return;
  }
  if (
    value.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    if (agent !== "codex") {
      throw new Error("Codex fallback Watch anchor cannot belong to another agent");
    }
    assertStrictRecord(value, "Codex fallback Watch anchor", {
      schema: literalGuard(
        "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
      ),
      version: literalGuard(1),
      captured_at: assertTimestamp,
      request_hash: assertSha256,
      codex_version: assertNonEmptyString,
      acceptance_anchor: IGNORE_VALUE,
      anchor_fingerprint: assertSha256
    });
    const acceptance = validateCodexRolloutAcceptanceAnchor(
      value.acceptance_anchor
    );
    if (acceptance.captured_at !== value.captured_at) {
      throw new Error(
        "Codex fallback Watch capture time does not match its acceptance anchor"
      );
    }
    assertAnchorFingerprint(value, "Codex fallback Watch anchor");
    return;
  }
  if (
    value.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  ) {
    if (agent !== "claude") {
      throw new Error(
        "Claude fallback Watch anchor cannot belong to another agent"
      );
    }
    assertStrictRecord(value, "Claude fallback Watch anchor", {
      schema: literalGuard(
        "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
      ),
      version: literalGuard(1),
      captured_at: assertTimestamp,
      request_hash: assertSha256,
      claude_version: assertNonEmptyString,
      transcript_anchor: IGNORE_VALUE,
      anchor_fingerprint: assertSha256
    });
    const transcript = validatedClaudeTranscriptAnchor(
      value.transcript_anchor
    );
    if (
      transcript.captured_at !== value.captured_at ||
      transcript.cwd !== terminal.workspace
    ) {
      throw new Error(
        "Claude fallback Watch transcript anchor does not match its Watch"
      );
    }
    assertAnchorFingerprint(value, "Claude fallback Watch anchor");
    return;
  }
  throw new Error("terminal Watch anchor schema is unsupported");
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
  assertStrictRecord(value, "terminal Watch settlement", SETTLEMENT_FIELDS);
  if (value.kind !== status) {
    throw new Error("terminal Watch settlement kind must match its status");
  }
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

function assertNotificationOutbox(watch: TerminalWatch): void {
  const seenIds = new Set<string>();
  const seenEvidence = new Set<string>();
  let previousCreatedAt = Date.parse(watch.created_at);
  for (const notification of watch.notification_outbox) {
    assertNotification(notification, watch);
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
      createdAt > Date.parse(watch.updated_at)
    ) {
      throw new Error("terminal Watch notification timestamps are not monotonic");
    }
    previousCreatedAt = createdAt;
    seenIds.add(notification.notification_id);
    seenEvidence.add(evidenceKey);
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

function assertNotification(value: unknown, watch: TerminalWatch): void {
  assertStrictRecord(value, "terminal Watch notification", NOTIFICATION_FIELDS);
  const notification = value as unknown as TerminalWatchNotification;
  const expectedId = terminalWatchNotificationId(
    watch.watch_id,
    notification.kind,
    notification.evidence_fingerprint
  );
  if (
    notification.notification_id !== expectedId ||
    notification.idempotency_key !==
      terminalWatchNotificationIdempotencyKey(watch.watch_id, expectedId)
  ) {
    throw new Error("terminal Watch notification identity is not deterministic");
  }
  const [minimumAttempts, receiptFields] =
    NOTIFICATION_SHAPES[notification.status];
  assertNotificationShape(value, minimumAttempts, receiptFields);
  terminalWatchNotificationCallbackSnapshot(watch, notification);
}

export interface TerminalWatchNotificationCallbackSnapshot {
  route: CallbackRouteV1;
  envelope: CallbackEnvelopeV1;
}

/**
 * Parse one optional v1 callback snapshot. Legacy notifications may omit both
 * fields; a partial or malformed snapshot is never treated as legacy.
 */
export function terminalWatchNotificationCallbackSnapshot(
  watch: TerminalWatch,
  notification: TerminalWatchNotification
): TerminalWatchNotificationCallbackSnapshot | undefined {
  const hasRoute = Object.hasOwn(notification, "callback_route");
  const hasEnvelope = Object.hasOwn(notification, "callback_envelope");
  if (hasRoute !== hasEnvelope) {
    throw new Error(
      "terminal Watch notification callback snapshot must contain both route and envelope"
    );
  }
  if (!hasRoute) return undefined;

  const route = parseCallbackRoute(notification.callback_route);
  const rawEnvelope = notification.callback_envelope;
  if (!isRecord(rawEnvelope)) {
    throw new Error("terminal Watch notification callback_envelope must be an object");
  }
  const normalizedEnvelope = createCallbackEnvelope({
    route,
    deliveryId: typeof rawEnvelope.delivery_id === "string"
      ? rawEnvelope.delivery_id
      : undefined,
    idempotencyKey: typeof rawEnvelope.idempotency_key === "string"
      ? rawEnvelope.idempotency_key
      : undefined,
    source: rawEnvelope.source as CallbackEnvelopeV1["source"],
    event: rawEnvelope.event as CallbackEnvelopeV1["event"]
  });
  const envelope = strictJsonClone(
    normalizedEnvelope,
    "terminal Watch notification callback_envelope"
  );
  if (
    canonicalJson(envelope) !== canonicalJson(rawEnvelope) ||
    !callbackEnvelopeMatchesRoute(envelope, route)
  ) {
    throw new Error(
      "terminal Watch notification callback_envelope is malformed or does not match callback_route"
    );
  }
  const expectedEvent = notification.kind === "approval"
    ? "approval_required"
    : notification.kind;
  const expectedEnvelope = terminalWatchCallbackEnvelope(
    watch,
    notification,
    route
  );
  const watchRoute = watch.callback_route === undefined
    ? undefined
    : parseCallbackRoute(watch.callback_route);
  if (
    envelope.delivery_id !== notification.notification_id ||
    envelope.idempotency_key !== notification.idempotency_key ||
    envelope.source.kind !== "terminal_watch" ||
    envelope.source.watch_id !== watch.watch_id ||
    envelope.source.terminal_id !== watch.terminal.terminal_id ||
    route.controller_session_id !== watch.openclaw_session ||
    (
      watchRoute !== undefined &&
      canonicalJson(route) !== canonicalJson(watchRoute)
    ) ||
    envelope.event.id !== notification.notification_id ||
    envelope.event.type !== expectedEvent ||
    envelope.event.requires_response !== true ||
    canonicalJson(envelope) !== canonicalJson(expectedEnvelope)
  ) {
    throw new Error(
      "terminal Watch notification callback snapshot does not match its immutable identity"
    );
  }
  return { route, envelope };
}

function strictJsonClone<Value>(value: Value, label: string): Value {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must contain only JSON values`);
  }
  if (encoded === undefined) {
    throw new Error(`${label} must contain only JSON values`);
  }
  const cloned = JSON.parse(encoded) as Value;
  if (canonicalJson(cloned) !== canonicalJson(value)) {
    throw new Error(`${label} must contain only exact JSON values`);
  }
  return cloned;
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
  const allowed = new Set<string>(required);
  for (const key of Object.keys(NOTIFICATION_RECEIPT_FIELDS)) {
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
    ["warnings", current.warnings, candidate.warnings],
    ["callback_route", current.callback_route, candidate.callback_route],
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
    candidate.observation_checkpoint.safe_resume_offset_bytes <
      current.observation_checkpoint.safe_resume_offset_bytes
  ) {
    throw new Error("terminal Watch observation checkpoint cannot move backwards");
  }
  assertFallbackCheckpointAdvance(
    current.observation_checkpoint,
    candidate.observation_checkpoint
  );
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
      candidate.last_activity_at !== current.last_activity_at ||
      JSON.stringify(candidate.observation_checkpoint) !==
        JSON.stringify(current.observation_checkpoint) ||
      candidate.notification_outbox.length !== current.notification_outbox.length
    ) {
      throw new Error(
        "a settled terminal Watch may change only notification delivery receipts"
      );
    }
  } else if (
    candidate.notification_outbox.length >
      current.notification_outbox.length + 1
  ) {
    throw new Error(
      "terminal Watch may append at most one notification per update"
    );
  }
  assertNotificationAdvance(current.notification_outbox, candidate.notification_outbox);
}

function assertFallbackCheckpointAdvance(
  current: TerminalWatchObservationCheckpoint,
  candidate: TerminalWatchObservationCheckpoint
): void {
  if (!("schema" in current)) {
    return;
  }
  if (
    current.schema ===
      "agent-knock-knock/terminal-activity-watch-checkpoint"
  ) {
    if (
      !("schema" in candidate) ||
      candidate.schema !== current.schema
    ) {
      throw new Error("terminal activity Watch checkpoint schema cannot change");
    }
    if (current.has_seen_activity && !candidate.has_seen_activity) {
      throw new Error(
        "terminal activity Watch cannot forget observed activity"
      );
    }
    if (
      candidate.consecutive_idle_observations >
        current.consecutive_idle_observations + 1
    ) {
      throw new Error(
        "terminal activity Watch idle observations cannot skip supervision sweeps"
      );
    }
    return;
  }
  const fallbackSchema = current.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint" ||
    current.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint";
  if (!fallbackSchema) return;
  if (
    !("schema" in candidate) ||
    candidate.schema !== current.schema
  ) {
    throw new Error("fallback Watch checkpoint schema cannot change");
  }
  if (current.acceptance_evidence === undefined) {
    return;
  }
  const currentIdentity = current.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint"
    ? current.accepted_identity
    : current.accepted_prompt_uuid;
  const candidateIdentity = candidate.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint"
    ? candidate.accepted_identity
    : candidate.accepted_prompt_uuid;
  if (
    canonicalJson(candidate.acceptance_evidence) !==
      canonicalJson(current.acceptance_evidence) ||
    canonicalJson(candidateIdentity) !== canonicalJson(currentIdentity)
  ) {
    throw new Error(
      "fallback Watch accepted identity cannot change"
    );
  }
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
    for (const key of ["callback_route", "callback_envelope"] as const) {
      const existed = Object.hasOwn(before, key);
      const exists = Object.hasOwn(after, key);
      if (!existed && exists) {
        const reclaimed = before.status === "delivering" &&
          after.status === "delivering" &&
          after.attempt_id !== before.attempt_id;
        const claimed = (before.status === "pending" ||
            before.status === "failed") &&
          after.status === "delivering";
        if (!claimed && !reclaimed) {
          throw new Error(
            "terminal Watch notification callback snapshot may be backfilled only while claiming delivery"
          );
        }
      }
      if (existed && (!exists || canonicalJson(before[key]) !== canonicalJson(after[key]))) {
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
    delivering: [
      "delivering", "failed", "delivered", "superseded"
    ],
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

function assertStrictRecord(
  value: unknown,
  label: string,
  shape: StrictShape
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).find((key) => !Object.hasOwn(shape, key));
  if (unknown) {
    throw new Error(`${label} contains unsupported field ${unknown}`);
  }
  for (const [key, guard] of Object.entries(shape)) {
    guard(value[key], `${label} ${key}`);
  }
}

function literalGuard(expected: unknown): FieldGuard {
  return (value, label) => {
    if (value !== expected) throw new Error(`${label} is invalid`);
  };
}

function oneOfGuard(allowed: readonly unknown[]): FieldGuard {
  return (value, label) => {
    if (!allowed.includes(value)) throw new Error(`${label} is invalid`);
  };
}

function optionalGuard(guard: FieldGuard): FieldGuard {
  return (value, label) => {
    if (value !== undefined) guard(value, label);
  };
}

function nullableGuard(guard: FieldGuard): FieldGuard {
  return (value, label) => {
    if (value !== null) guard(value, label);
  };
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

function assertNotificationKind(
  value: unknown
): asserts value is TerminalWatchNotificationKind {
  if (!TERMINAL_WATCH_NOTIFICATION_KINDS.includes(
    value as TerminalWatchNotificationKind
  )) {
    throw new Error("terminal Watch notification kind is invalid");
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveIntegerValue(value: unknown, label: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
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

function nonEmptyString(value: unknown, label: string): string {
  assertNonEmptyString(value, label);
  return value;
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function sha256String(value: unknown, label: string): string {
  assertSha256(value, label);
  return value;
}

function exactUuid(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      .test(text)
  ) {
    throw new Error(`${label} must be an exact lowercase UUID`);
  }
  return text;
}

function fingerprintValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertAnchorFingerprint(
  value: Record<string, unknown>,
  label: string
): void {
  const { anchor_fingerprint: actual, ...base } = value;
  if (actual !== fingerprintValue(base)) {
    throw new Error(`${label} fingerprint does not match`);
  }
}

function validatedClaudeTranscriptAnchor(
  value: unknown
): ClaudeTranscriptAnchor {
  assertStrictRecord(value, "Claude fallback transcript anchor", {
    schema_version: literalGuard(1),
    session_id: assertNonEmptyString,
    cwd: ABSOLUTE_PATH,
    pid: POSITIVE_INTEGER,
    agent_started_at_ms: POSITIVE_INTEGER,
    captured_at: assertTimestamp,
    relative_path: assertNonEmptyString,
    offset_bytes: NON_NEGATIVE_INTEGER,
    file_existed: oneOfGuard([true, false]),
    device: optionalGuard(assertNonEmptyString),
    inode: optionalGuard(assertNonEmptyString)
  });
  const anchor = value as unknown as ClaudeTranscriptAnchor;
  if (
    anchor.file_existed !==
      (anchor.device !== undefined && anchor.inode !== undefined) ||
    (anchor.device === undefined) !== (anchor.inode === undefined)
  ) {
    throw new Error(
      "Claude fallback transcript file identity does not match file_existed"
    );
  }
  return anchor;
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

function assertReasonCode(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9_.:-]*$/u.test(value)
  ) {
    throw new Error(`${label} must be a privacy-safe reason code`);
  }
}

function assertCompletionText(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    value.length > 4000 ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be redacted and at most 4k`);
  }
}
