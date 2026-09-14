import fs from "node:fs";
import path from "node:path";
import {
  assertRealDirectory,
  atomicSaveJsonFile,
  isNodeError,
  readJsonFileNoFollow
} from "./durable-json-file.js";
import {
  assertStoreReadable,
  ensureDir,
  withStoreWriterLease
} from "./store.js";
import {
  TERMINAL_WATCHES_DIRECTORY,
  assertContained,
  assertExpectedRevision,
  assertRecordId,
  type TerminalWatch,
  type TerminalWatchNotificationKind
} from "./terminal-watch-record.js";
import {
  assertTerminalWatch,
  assertTerminalWatchAdvance,
  decodeTerminalWatch
} from "./terminal-watch-codec.js";

export {
  TERMINAL_WATCH_INTERACTION_POLICIES,
  TERMINAL_WATCH_SCHEMA,
  TERMINAL_WATCH_VERSION,
  TERMINAL_WATCHES_DIRECTORY,
  createClaudeUserExplicitFallbackWatchAnchor,
  createCodexUserExplicitFallbackWatchAnchor,
  createTerminalActivityWatchAnchor,
  initialTerminalWatchInteractionPolicy,
  initialTerminalWatchObservationCheckpoint,
  isTerminalActivityWatch,
  isUserExplicitFallbackWatch,
  terminalUserExplicitFallbackWatchId,
  terminalWatchCallbackEnvelope,
  terminalWatchCallbackMessage,
  terminalWatchIdentityFingerprint,
  terminalWatchNotificationCallbackSnapshot,
  terminalWatchNotificationId,
  terminalWatchNotificationIdempotencyKey,
  terminalWatchNotificationOnlyRoute,
  terminalWatchRevision,
  type ClaudeUserExplicitFallbackWatchAnchor,
  type ClaudeUserExplicitFallbackWatchObservationCheckpoint,
  type CodexTerminalWatchObservationCheckpoint,
  type CodexUserExplicitFallbackWatchAcceptedIdentity,
  type CodexUserExplicitFallbackWatchAnchor,
  type CodexUserExplicitFallbackWatchObservationCheckpoint,
  type TerminalActivityState,
  type TerminalActivityWatchAnchor,
  type TerminalActivityWatchObservationCheckpoint,
  type TerminalWatch,
  type TerminalWatchAnchor,
  type TerminalWatchCallbackEvent,
  type TerminalWatchCallbackMessageInput,
  type TerminalWatchCurrentInteraction,
  type TerminalWatchInteractionPolicy,
  type TerminalWatchManualInteractionOption,
  type TerminalWatchManualInteractionResponseKind,
  type TerminalWatchManualInteractionSummary,
  type TerminalWatchNotification,
  type TerminalWatchNotificationCallbackSnapshot,
  type TerminalWatchNotificationKind,
  type TerminalWatchNotificationStatus,
  type TerminalWatchObservationCheckpoint,
  type TerminalWatchSettlement,
  type TerminalWatchStatus,
  type TerminalWatchTerminalIdentity,
  type TerminalWatchTerminalStatus,
  type UserExplicitFallbackWatchAnchor
} from "./terminal-watch-record.js";
export {
  assertTerminalWatch,
  assertTerminalWatchCurrentInteraction,
  assertTerminalWatchManualInteractionSummary,
  assertTerminalWatchObservationCheckpoint
} from "./terminal-watch-codec.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

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
  /**
   * Hold the canonical Store writer lease while a caller inserts an
   * interaction-authority lock before acquiring the per-Watch state lock.
   * The scope is synchronous and becomes invalid when this callback returns.
   */
  withWriterLease<Result>(
    operation: (scope: TerminalWatchWriterScope) => Result
  ): Result;
}

export interface TerminalWatchWriterScope {
  list(): TerminalWatch[];
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
  return withStoreWriterLease(storeDir, () =>
    withTerminalWatchStateLock(storeDir, watchId, locks, operation));
}

function withTerminalWatchStateLock<Result>(
  storeDir: string,
  watchId: string,
  locks: TerminalWatchFileLockPort,
  operation: () => Result
): Result {
  const paths = pathsForTerminalWatch(watchId, storeDir);
  ensureDir(paths.root);
  assertOwnerPrivateDirectory(paths.root, "terminal Watch root");
  const release = locks.acquire(paths.lockPath);
  try {
    return operation();
  } finally {
    release();
  }
}

export function createTerminalWatchStore(
  storeDir: string,
  locks: TerminalWatchFileLockPort
): TerminalWatchStore {
  const withWriterLease = <Result>(
    operation: (scope: TerminalWatchWriterScope) => Result
  ): Result => withStoreWriterLease(storeDir, () => {
    let active = true;
    const assertActive = (): void => {
      if (!active) {
        throw new Error("terminal Watch writer scope is no longer active");
      }
    };
    const scope: TerminalWatchWriterScope = Object.freeze({
      list: () => {
        assertActive();
        return listTerminalWatches(storeDir);
      },
      load: (watchId: string) => {
        assertActive();
        return loadTerminalWatch(storeDir, watchId);
      },
      save: (
        watch: TerminalWatch,
        options: TerminalWatchSaveOptions
      ) => {
        assertActive();
        return saveTerminalWatch(storeDir, watch, options);
      },
      withWatchLock: <ScopeResult>(
        watchId: string,
        inner: () => ScopeResult
      ) => {
        assertActive();
        return withTerminalWatchStateLock(storeDir, watchId, locks, inner);
      }
    });
    try {
      return operation(scope);
    } finally {
      active = false;
    }
  });
  return Object.freeze({
    list: () => listTerminalWatches(storeDir),
    scanForReconciliation: () => scanTerminalWatchesForReconciliation(storeDir),
    load: (watchId: string) => loadTerminalWatch(storeDir, watchId),
    save: (watch: TerminalWatch, options: TerminalWatchSaveOptions) =>
      saveTerminalWatch(storeDir, watch, options),
    withWatchLock: <Result>(watchId: string, operation: () => Result) =>
      withTerminalWatchLock(storeDir, watchId, locks, operation),
    withWriterLease
  });
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
