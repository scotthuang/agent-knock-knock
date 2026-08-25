import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  callbackEnvelopeMatchesRoute,
  createCallbackEnvelope,
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
export const TERMINAL_WATCH_VERSION = 1 as const;
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
  | ClaudeHumanStartedActiveTaskAnchor;

/**
 * Mutable, privacy-safe progress through the append-only provider artifact.
 * The immutable anchor continues to name the exact task; this cursor may only
 * advance after a provider proves a complete, stable JSONL boundary.
 */
export interface CodexTerminalWatchObservationCheckpoint {
  safe_resume_offset_bytes: number;
}

export type TerminalWatchObservationCheckpoint =
  | CodexTerminalWatchObservationCheckpoint
  | ClaudeHumanStartedActiveTaskCheckpoint;

export function initialTerminalWatchObservationCheckpoint(
  anchor: TerminalWatchAnchor
): TerminalWatchObservationCheckpoint {
  if (
    anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    return initialClaudeHumanStartedActiveTaskCheckpoint(anchor);
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
        detail: reasonCode,
        completionText: notification.kind === "completed" ||
            notification.kind === "failed"
          ? watch.settlement?.completion_text
          : undefined
      }),
      requires_response: true,
      metadata: {
        agent: watch.agent,
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
  const eventInstruction = input.event === "approval_required"
    ? "Tell the user that the observed TUI task is waiting for approval and ask the human to inspect and decide in the named live TUI. Do not call any AKK approval tool or action, do not send approval keys, and do not use autoApprove."
    : input.event === "completed"
      ? "Tell the user that the human-started TUI task completed and summarize only the bounded completion text below."
      : "Tell the user that Terminal Watch stopped without a verified successful completion and explain the exact reason below.";
  return [
    "Continue this controller conversation from the Agent Knock Knock Terminal Watch event below.",
    "This is an observation of a task started by the human directly in Codex or Claude Code. It is not an AKK Turn and AKK did not send terminal input.",
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
  assertObservationCheckpoint(
    watch.observation_checkpoint,
    watch.anchor
  );
  if (watch.callback_route !== undefined) {
    const route = parseCallbackRoute(watch.callback_route);
    if (route.controller_session_id !== watch.openclaw_session) {
      throw new Error(
        "terminal Watch callback route does not match its controller session"
      );
    }
  }
  const minimumCheckpointOffset = watch.anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
      ? watch.anchor.turn_start_offset_bytes
      : watch.anchor.observed_end_offset_bytes;
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
  const normalized = normalizeLegacyTerminalWatch(value);
  assertTerminalWatch(normalized, expectedWatchId);
  return normalized;
}

function normalizeLegacyTerminalWatch(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.schema !== TERMINAL_WATCH_SCHEMA ||
    value.version !== TERMINAL_WATCH_VERSION ||
    value.observation_checkpoint !== undefined ||
    !isRecord(value.anchor)
  ) {
    return value;
  }
  const anchor = value.anchor;
  if (
    anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    const validated = validateClaudeHumanStartedActiveTaskAnchor(anchor);
    return {
      ...value,
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
      ...value,
      observation_checkpoint:
        initialTerminalWatchObservationCheckpoint(validated)
    };
  }
  return value;
}

function assertObservationCheckpoint(
  value: unknown,
  anchor: TerminalWatchAnchor
): asserts value is TerminalWatchObservationCheckpoint {
  if (
    anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    validateClaudeHumanStartedActiveTaskCheckpoint(value, anchor);
    return;
  }
  assertStrictRecord(value, "terminal Watch observation checkpoint", {
    safe_resume_offset_bytes: NON_NEGATIVE_INTEGER
  });
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

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
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
