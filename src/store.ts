import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import {
  normalizeLegacyCallbackStatus,
  sessionIdForConversation,
  turnIdForConversation,
  validateMessage,
  type AgentMessage,
  type Conversation
} from "./protocol.js";
import {
  assertManagedSessionState,
  managedSessionStatesFromConversations,
  managedSessionStorageKey,
  type ManagedSessionState
} from "./managed-session.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STORE_SCHEMA = "agent-knock-knock/store";
const STORE_MANIFEST_FILE = "manifest.json";
const STORE_CONVERSATIONS_DIRECTORY = "conversations";
const STORE_RUNTIME_DIRECTORY = "runtime";
const STORE_SESSIONS_DIRECTORY = "sessions";
const STORE_TRANSITIONS_DIRECTORY = "transitions";
export const STORE_DEFERRED_FOREGROUND_TRANSFERS_DIRECTORY =
  "deferred-foreground-transfers";
export const STORE_TERMINAL_WATCHES_DIRECTORY = "terminal-watches";
const STORE_WRITER_LOCK_FILE = ".akk-writer.lock";
const STORE_MANIFEST_TEMP_PREFIX = `.${STORE_MANIFEST_FILE}.`;
const STORE_MANIFEST_TEMP_SUFFIX = ".tmp";
const STORE_LOCK_FILE = ".akk-store.lock";
const STORE_LOCK_RECLAIM_SUFFIX = ".reclaim";
const STORE_LOCK_TIMEOUT_MS = 10_000;
const STORE_LOCK_RETRY_MS = 10;
const STORE_LOCK_INVALID_STALE_MS = 30_000;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;

export const STORE_FORMAT_VERSION = 1;
export const STORE_WRITER_PROTOCOL = 5;
export const STORE_SESSION_AUTHORITY_PROTOCOL = 3;
const STORE_UPGRADEABLE_WRITER_PROTOCOLS = new Set([1, 2, 3, 4]);

export interface StoreManifest {
  schema: typeof STORE_SCHEMA;
  format_version: number;
  writer_protocol: number;
  created_at: string;
}

interface StoreManifestSnapshot {
  manifest: StoreManifest;
  device: bigint;
  inode: bigint;
}

interface UpgradeableStoreStateSnapshot {
  conversation: Conversation;
  statePath: string;
  device: bigint;
  inode: bigint;
  contentsSha256: string;
}

export interface StoreCompatibility {
  status: "uninitialized" | "legacy" | "upgradeable" | "compatible" | "incompatible";
  store_dir: string;
  manifest_path: string;
  readable: boolean;
  writable: boolean;
  upgradeable?: boolean;
  format_version?: number;
  writer_protocol?: number;
  reason?: string;
}

const STORE_WRITER_LEASE_BRAND: unique symbol = Symbol("akk-store-writer-lease");

export interface StoreWriterLease {
  readonly storeDir: string;
  readonly manifest: Readonly<StoreManifest>;
  readonly [STORE_WRITER_LEASE_BRAND]: true;
}

interface ActiveStoreWriterLease extends StoreWriterLease {
  released: boolean;
}

const activeStoreWriterLease = new AsyncLocalStorage<ActiveStoreWriterLease>();

export class StoreCompatibilityError extends Error {
  readonly code = "AKK_STORE_INCOMPATIBLE";
  readonly compatibility: StoreCompatibility;

  constructor(message: string, compatibility: StoreCompatibility) {
    super(message);
    this.name = "StoreCompatibilityError";
    this.compatibility = compatibility;
  }
}

export class StoreLockTimeoutError extends Error {
  readonly code = "AKK_STORE_LOCK_TIMEOUT";
  readonly lockPath: string;
  readonly lockKind: "writer" | "conversation";

  constructor(lockPath: string) {
    const lockKind = path.basename(lockPath) === STORE_WRITER_LOCK_FILE
      ? "writer"
      : "conversation";
    super(`timed out waiting for ${lockKind} store lock: ${lockPath}`);
    this.name = "StoreLockTimeoutError";
    this.lockPath = lockPath;
    this.lockKind = lockKind;
  }
}

export function defaultStoreDir(_workspace = process.cwd()): string {
  return path.join(os.homedir(), ".agent-knock-knock", "store");
}

export function defaultLogDir(workspace = process.cwd()): string {
  return defaultStoreDir(workspace);
}

export function ensureDir(dir: string): void {
  const resolvedDir = path.resolve(dir);
  const missing: string[] = [];
  let cursor = resolvedDir;
  while (true) {
    try {
      const existing = fs.lstatSync(cursor);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(
          `store directory must be a real directory, not a symlink: ${cursor}`
        );
      }
      break;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      missing.unshift(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new Error(`could not find an existing parent directory for ${dir}`);
      }
      cursor = parent;
    }
  }
  for (const directory of missing) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }
    const created = fs.lstatSync(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(
        `store directory must be a real directory, not a symlink: ${directory}`
      );
    }
    fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    // Persist each newly created directory entry before a child entry can be
    // treated as durable. This also covers a recursively new custom Store path.
    fsyncDirectory(path.dirname(directory));
  }
  const stat = fs.lstatSync(resolvedDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`store directory must be a real directory, not a symlink: ${dir}`);
  }
  fs.chmodSync(resolvedDir, PRIVATE_DIRECTORY_MODE);
}

export interface ConversationPaths {
  storeDir: string;
  logDir: string;
  conversationDir: string;
  logPath: string;
  statePath: string;
}

export function storeManifestPath(storeDir = defaultStoreDir()): string {
  return path.join(storeDir, STORE_MANIFEST_FILE);
}

export function storeConversationsDir(storeDir = defaultStoreDir()): string {
  return path.join(storeDir, STORE_CONVERSATIONS_DIRECTORY);
}

export function storeSessionsDir(storeDir = defaultStoreDir()): string {
  return path.join(storeDir, STORE_SESSIONS_DIRECTORY);
}

export function inspectStoreCompatibility(
  storeDir = defaultStoreDir()
): StoreCompatibility {
  const resolvedStoreDir = path.resolve(storeDir);
  const manifestPath = storeManifestPath(resolvedStoreDir);
  if (!fs.existsSync(resolvedStoreDir)) {
    return {
      status: "uninitialized",
      store_dir: storeDir,
      manifest_path: manifestPath,
      readable: true,
      writable: true
    };
  }

  assertNotSymlink(resolvedStoreDir, "store directory");
  const storeStat = fs.lstatSync(resolvedStoreDir);
  if (!storeStat.isDirectory()) {
    throw new Error(`store directory must be a real directory: ${storeDir}`);
  }
  let manifestStat: fs.Stats | undefined;
  try {
    manifestStat = fs.lstatSync(manifestPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
  if (!manifestStat) {
    if (storeHasConversationData(resolvedStoreDir)) {
      return {
        status: "legacy",
        store_dir: storeDir,
        manifest_path: manifestPath,
        readable: false,
        writable: false,
        reason: "store contains conversation data but has no AKK manifest"
      };
    }
    return {
      status: "uninitialized",
      store_dir: storeDir,
      manifest_path: manifestPath,
      readable: true,
      writable: true
    };
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error(`store manifest must be a regular file: ${manifestPath}`);
  }

  const manifest = readStoreManifest(manifestPath);
  const readable = manifest.format_version === STORE_FORMAT_VERSION;
  const compatible = readable && manifest.writer_protocol === STORE_WRITER_PROTOCOL;
  const upgradeable =
    readable &&
    STORE_UPGRADEABLE_WRITER_PROTOCOLS.has(manifest.writer_protocol);
  const writable = compatible || upgradeable;
  return {
    status: compatible
      ? "compatible"
      : upgradeable
        ? "upgradeable"
        : "incompatible",
    store_dir: storeDir,
    manifest_path: manifestPath,
    readable,
    writable,
    upgradeable,
    format_version: manifest.format_version,
    writer_protocol: manifest.writer_protocol,
    ...(!readable
      ? {
          reason:
            `store format ${manifest.format_version} is not readable by format ${STORE_FORMAT_VERSION}`
        }
      : !writable
        ? {
            reason:
              `store writer protocol ${manifest.writer_protocol} is not writable by protocol ${STORE_WRITER_PROTOCOL}`
          }
        : {})
  };
}

export function assertStoreReadable(storeDir = defaultStoreDir()): StoreCompatibility {
  const compatibility = inspectStoreCompatibility(storeDir);
  if (!compatibility.readable) {
    throw new StoreCompatibilityError(
      `${compatibility.reason}; use an empty AKK store created by the installed package`,
      compatibility
    );
  }
  return compatibility;
}

/**
 * Validate whether this binary may write the selected store without creating or
 * repairing anything. An absent or empty store is writable because its first
 * real mutation may initialize the manifest.
 */
export function assertStoreWriterCompatible(
  storeDir = defaultStoreDir()
): StoreCompatibility {
  const compatibility = inspectStoreCompatibility(storeDir);
  assertWritableCompatibility(compatibility);
  return compatibility;
}

export function ensureStoreWritable(storeDir = defaultStoreDir()): StoreManifest {
  return withStoreWriterLease(storeDir, (lease) => ({ ...lease.manifest }));
}

/**
 * Hold the store's writer lock for one synchronous mutation boundary. Nested
 * calls for the same store reuse the active lease, so saveState/appendEvent can
 * safely enforce the guard without deadlocking a command-level lease.
 */
export function withStoreWriterLease<T>(
  storeDir: string,
  action: (lease: StoreWriterLease) => T
): T {
  const resolvedStoreDir = path.resolve(storeDir);
  const current = activeStoreWriterLease.getStore();
  if (current && !current.released) {
    assertSameStoreLease(current, resolvedStoreDir);
    revalidateStoreWriterLease(current);
    return action(current);
  }

  prepareStoreRootForWriterLock(resolvedStoreDir);
  const lockPath = path.join(resolvedStoreDir, STORE_WRITER_LOCK_FILE);
  const token = randomUUID();
  acquireConversationLock(
    lockPath,
    token,
    Date.now() + STORE_LOCK_TIMEOUT_MS
  );
  let lease: ActiveStoreWriterLease | undefined;
  try {
    const manifest = ensureStoreWritableWhileLocked(resolvedStoreDir);
    lease = {
      storeDir: resolvedStoreDir,
      manifest: Object.freeze({ ...manifest }),
      [STORE_WRITER_LEASE_BRAND]: true,
      released: false
    };
    return activeStoreWriterLease.run(lease, () => action(lease!));
  } finally {
    if (lease) {
      lease.released = true;
    }
    releaseConversationLock(lockPath, token);
  }
}

/** Hold the store writer lease until an asynchronous side effect and commit finish. */
export async function withStoreWriterLeaseAsync<T>(
  storeDir: string,
  action: (lease: StoreWriterLease) => Promise<T>
): Promise<T> {
  const resolvedStoreDir = path.resolve(storeDir);
  const current = activeStoreWriterLease.getStore();
  if (current && !current.released) {
    assertSameStoreLease(current, resolvedStoreDir);
    revalidateStoreWriterLease(current);
    return action(current);
  }

  prepareStoreRootForWriterLock(resolvedStoreDir);
  const lockPath = path.join(resolvedStoreDir, STORE_WRITER_LOCK_FILE);
  const token = randomUUID();
  acquireConversationLock(
    lockPath,
    token,
    Date.now() + STORE_LOCK_TIMEOUT_MS
  );
  let lease: ActiveStoreWriterLease | undefined;
  try {
    const manifest = ensureStoreWritableWhileLocked(resolvedStoreDir);
    lease = {
      storeDir: resolvedStoreDir,
      manifest: Object.freeze({ ...manifest }),
      [STORE_WRITER_LEASE_BRAND]: true,
      released: false
    };
    return await activeStoreWriterLease.run(lease, () => action(lease!));
  } finally {
    if (lease) {
      lease.released = true;
    }
    releaseConversationLock(lockPath, token);
  }
}

export interface EventRecord {
  event: string;
  [key: string]: unknown;
}

export function pathsForConversation(conversationId: string, storeDir = defaultStoreDir()): ConversationPaths {
  const validated = validateConversationPath(conversationId, storeDir);
  const conversationsDir = storeConversationsDir(storeDir);
  const conversationDir = path.join(conversationsDir, conversationId);
  assertNotSymlink(validated.resolvedStoreDir, "store directory");
  assertNotSymlink(validated.resolvedConversationsDir, "conversations directory");
  assertNotSymlink(validated.resolvedConversationDir, "conversation directory");
  return {
    storeDir,
    logDir: conversationsDir,
    conversationDir,
    logPath: path.join(conversationDir, "events.ndjson"),
    statePath: path.join(conversationDir, "state.json")
  };
}

export function pathsForConversationDir(conversationDir: string): ConversationPaths {
  const resolvedConversationDir = path.resolve(conversationDir);
  validateConversationId(path.basename(resolvedConversationDir));
  const resolvedConversationsDir = path.dirname(resolvedConversationDir);
  const resolvedStoreDir = path.dirname(resolvedConversationsDir);
  if (
    path.basename(resolvedConversationsDir) !== STORE_CONVERSATIONS_DIRECTORY ||
    resolvedConversationDir === resolvedConversationsDir ||
    resolvedConversationsDir === resolvedStoreDir
  ) {
    throw new Error(
      `conversation directory must be contained by an AKK store conversations directory: ${conversationDir}`
    );
  }
  assertNotSymlink(resolvedStoreDir, "store directory");
  assertNotSymlink(resolvedConversationsDir, "conversations directory");
  assertNotSymlink(resolvedConversationDir, "conversation directory");
  return {
    storeDir: path.dirname(path.dirname(conversationDir)),
    logDir: path.dirname(conversationDir),
    conversationDir,
    logPath: path.join(conversationDir, "events.ndjson"),
    statePath: path.join(conversationDir, "state.json")
  };
}

export function logPathForStatePath(statePath: string): string {
  if (path.basename(statePath) === "state.json") {
    return path.join(path.dirname(statePath), "events.ndjson");
  }

  return statePath.replace(/\.state\.json$/, ".ndjson");
}

export function saveState(statePath: string, conversation: Conversation): void {
  // Validate the state identity before acquiring a writer lease. In particular,
  // a malformed state must not initialize or upgrade the Store manifest.
  assertConversationStateIdentity(conversation);
  const paths = assertCanonicalConversationDataPath(statePath, "state.json");
  assertConversationStateIdentity(
    conversation,
    path.basename(paths.conversationDir)
  );
  assertConversationStorageMetadata(statePath, conversation);
  withStoreWriterLease(paths.storeDir, () => {
    assertConversationNotReservedByDeferredSourceHistory(
      paths.storeDir,
      conversation.conversation_id
    );
    saveStateWithWriterLease(statePath, conversation);
  });
}

/**
 * Persist the user-facing half of an explicit management-only Close even when
 * this Turn is frozen in deferred source history. All ordinary state/path
 * checks remain in force; only this exact closed disposition bypasses the
 * source-history mutation fence.
 */
export function saveExplicitUserCloseState(
  statePath: string,
  conversation: Conversation
): void {
  assertExplicitUserCloseState(conversation);
  assertConversationStateIdentity(conversation);
  const paths = assertCanonicalConversationDataPath(statePath, "state.json");
  assertConversationStateIdentity(
    conversation,
    path.basename(paths.conversationDir)
  );
  assertConversationStorageMetadata(statePath, conversation);
  withStoreWriterLease(paths.storeDir, () => {
    saveStateWithWriterLease(statePath, conversation);
  });
}

function saveStateWithWriterLease(
  statePath: string,
  conversation: Conversation
): void {
  assertExplicitUserCloseNotReopened(statePath, conversation);
  secureConversationStorageMetadata(statePath, conversation);
  prepareDataDirectory(statePath);
  const serialized = `${JSON.stringify(conversation, null, 2)}\n`;

  withConversationLock(statePath, () => {
    assertWritableDataPath(statePath, "state file");
    const tempPath = path.join(
      path.dirname(statePath),
      `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`
    );
    let tempFd: number | undefined;
    try {
      tempFd = fs.openSync(
        tempPath,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          NO_FOLLOW_FLAG,
        PRIVATE_FILE_MODE
      );
      fs.fchmodSync(tempFd, PRIVATE_FILE_MODE);
      fs.writeFileSync(tempFd, serialized, "utf8");
      fs.fsyncSync(tempFd);
      fs.closeSync(tempFd);
      tempFd = undefined;

      assertWritableDataPath(statePath, "state file");
      fs.renameSync(tempPath, statePath);
      fsyncDirectory(path.dirname(statePath));
    } finally {
      if (tempFd !== undefined) {
        fs.closeSync(tempFd);
      }
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      }
    }
  });
}

/** Once the user has explicitly released AKK management, stale writers may
 * still settle audit-only fields but may never reopen the Turn. */
function assertExplicitUserCloseNotReopened(
  statePath: string,
  next: Conversation
): void {
  if (!fs.existsSync(statePath)) return;
  let current: Conversation;
  try {
    current = loadState(statePath);
  } catch {
    // Preserve the existing Store behavior for malformed files; ordinary
    // validation and write-path guards decide whether they are replaceable.
    return;
  }
  if (current.disposition !== "user_abandoned_management") return;
  if (
    current.status !== "closed" ||
    next.status !== "closed" ||
    next.disposition !== "user_abandoned_management" ||
    next.callback_expected !== false
  ) {
    throw new Error(
      `explicitly closed Turn ${current.conversation_id} cannot be reopened`
    );
  }
}

export function loadState(statePath: string): Conversation {
  assertNotSymlink(path.dirname(statePath), "conversation directory");
  const fd = openRegularFileNoFollow(statePath, fs.constants.O_RDONLY, "state file");
  try {
    return withConversationIdentity(
      JSON.parse(fs.readFileSync(fd, "utf8")) as Conversation
    );
  } finally {
    fs.closeSync(fd);
  }
}

export function statePathForConversationId(conversationId: string, storeDir = defaultStoreDir()): string {
  return pathsForConversation(conversationId, storeDir).statePath;
}

export function loadConversationById(conversationId: string, storeDir = defaultStoreDir()): Conversation {
  const resolvedStoreDir = path.resolve(storeDir);
  assertStoreReadable(resolvedStoreDir);
  const paths = pathsForConversation(conversationId, resolvedStoreDir);
  return withCanonicalConversationStorage(loadState(paths.statePath), paths);
}

export function listConversations(storeDir = defaultStoreDir()): Conversation[] {
  const resolvedStoreDir = path.resolve(storeDir);
  if (!fs.existsSync(resolvedStoreDir)) {
    return [];
  }

  assertStoreReadable(resolvedStoreDir);
  assertNotSymlink(resolvedStoreDir, "store directory");
  const conversationsDir = storeConversationsDir(resolvedStoreDir);
  if (!fs.existsSync(conversationsDir)) {
    return [];
  }
  assertNotSymlink(path.resolve(conversationsDir), "conversations directory");
  return fs.readdirSync(conversationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => pathsForConversation(entry.name, resolvedStoreDir))
    .filter((paths) => fs.existsSync(paths.statePath))
    .map((paths) => withCanonicalConversationStorage(loadState(paths.statePath), paths))
    .sort((left: Conversation, right: Conversation) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
}

function withCanonicalConversationStorage(
  conversation: Conversation,
  paths: ConversationPaths
): Conversation {
  const canonical = pathsForConversation(
    conversation.conversation_id,
    paths.storeDir
  );
  if (path.resolve(canonical.statePath) !== path.resolve(paths.statePath)) {
    throw new Error(
      `conversation id does not match its store directory: ${paths.statePath}`
    );
  }
  return {
    ...conversation,
    store_dir: path.resolve(paths.storeDir),
    conversation_dir: path.resolve(paths.conversationDir),
    state_path: path.resolve(paths.statePath),
    event_log_path: path.resolve(paths.logPath)
  };
}

function withConversationIdentity(conversation: Conversation): Conversation {
  const { sessionId, turnId } = assertConversationStateIdentity(conversation);
  const identified = {
    ...conversation,
    session_id: sessionId,
    turn_id: turnId
  };
  try {
    return normalizeLegacyCallbackStatus(identified);
  } catch (error) {
    if (!["callback_pending", "callback_failed"].includes(identified.status)) {
      throw error;
    }
    // One malformed legacy callback record must not poison Store-wide list or
    // recovery. Keep its transport-owned status as a fail-closed phase and
    // surface a durable in-memory diagnostic to callers.
    return {
      ...identified,
      legacy_callback_status_error:
        error instanceof Error ? error.message : String(error)
    };
  }
}

function assertConversationStateIdentity(
  value: unknown,
  expectedConversationId?: string
): { conversation: Conversation; sessionId: string; turnId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("conversation state must be an object");
  }
  const conversation = value as Conversation;
  validateConversationId(conversation.conversation_id);
  const sessionId = sessionIdForConversation(conversation);
  const turnId = turnIdForConversation(conversation);
  if (turnId !== conversation.conversation_id) {
    throw new Error(
      `conversation turn_id ${turnId} does not match its store identity ${conversation.conversation_id}`
    );
  }
  if (
    expectedConversationId !== undefined &&
    conversation.conversation_id !== expectedConversationId
  ) {
    throw new Error(
      `conversation id ${conversation.conversation_id} does not match its store directory ${expectedConversationId}`
    );
  }
  return { conversation, sessionId, turnId };
}

export function appendEvent(logPath: string, event: EventRecord): void {
  const paths = assertCanonicalConversationDataPath(logPath, "events.ndjson");
  withStoreWriterLease(paths.storeDir, () => {
    assertConversationNotReservedByDeferredSourceHistory(
      paths.storeDir,
      String(event.conversation_id)
    );
    appendEventWithWriterLease(logPath, event);
  });
}

/** Append only the exact audit event paired with saveExplicitUserCloseState. */
export function appendExplicitUserCloseEvent(
  logPath: string,
  event: EventRecord
): void {
  assertExplicitUserCloseEvent(event);
  const paths = assertCanonicalConversationDataPath(logPath, "events.ndjson");
  if (event.conversation_id !== path.basename(paths.conversationDir)) {
    throw new Error(
      "explicit user Close event must match its conversation directory"
    );
  }
  withStoreWriterLease(paths.storeDir, () => {
    appendEventWithWriterLease(logPath, event);
  });
}

function assertExplicitUserCloseState(conversation: Conversation): void {
  if (
    conversation.status !== "closed" ||
    typeof conversation.closed_at !== "string" ||
    !Number.isFinite(Date.parse(conversation.closed_at)) ||
    typeof conversation.close_reason !== "string" ||
    conversation.close_reason.trim().length === 0 ||
    conversation.disposition !== "user_abandoned_management" ||
    conversation.callback_expected !== false
  ) {
    throw new Error(
      "explicit user Close state must be closed management-only authority"
    );
  }
}

function assertExplicitUserCloseEvent(event: EventRecord): void {
  if (
    event.event !== "conversation_closed" ||
    typeof event.conversation_id !== "string" ||
    event.conversation_id.trim().length === 0 ||
    event.status !== "closed" ||
    typeof event.ts !== "string" ||
    !Number.isFinite(Date.parse(event.ts)) ||
    typeof event.reason !== "string" ||
    event.reason.trim().length === 0 ||
    event.disposition !== "user_abandoned_management" ||
    event.terminal_input_sent !== false ||
    event.coding_agent_stopped !== false
  ) {
    throw new Error(
      "explicit user Close event must record management-only closure"
    );
  }
}

/**
 * Protocol 5 makes a candidate-rollout deferred transfer's historical source
 * Turns read-only until the transfer reaches a terminal receipt.  Keeping the
 * fence at the Store write boundary covers foreground commands, monitors,
 * callback reconciliation, and supervisor repair uniformly; no individual
 * caller may accidentally mutate a source Turn while its binding is reserved.
 *
 * This deliberately performs a narrow, fail-closed read rather than importing
 * the transfer module (which itself depends on Store writer leases).
 */
function assertConversationNotReservedByDeferredSourceHistory(
  storeDir: string,
  conversationId: string
): void {
  const root = path.join(
    storeDir,
    STORE_DEFERRED_FOREGROUND_TRANSFERS_DIRECTORY
  );
  if (!fs.existsSync(root)) {
    return;
  }
  assertNotSymlink(root, "deferred foreground transfer root");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory()) {
    throw new Error("deferred foreground transfer root must be a directory");
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(
        "deferred foreground transfer root may contain only real record directories"
      );
    }
    const recordDir = path.join(root, entry.name);
    const statePath = path.join(recordDir, "state.json");
    assertNotSymlink(recordDir, "deferred foreground transfer directory");
    const fd = openRegularFileNoFollow(
      statePath,
      fs.constants.O_RDONLY,
      "deferred foreground transfer state"
    );
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
    if (
      !isStoreRecord(value) ||
      value.schema !== "agent-knock-knock/deferred-foreground-transfer" ||
      value.transfer_id !== entry.name ||
      ![1, 2].includes(Number(value.version)) ||
      ![
        "prepared",
        "source_reserved",
        "target_prepared",
        "dispatch_started",
        "committed",
        "resolved",
        "uncertain",
        "aborted",
        "abort_resolved",
        "user_abandoned"
      ].includes(String(value.status)) ||
      (
        Number(value.version) === 2 &&
        !["status_card_only", "candidate_rollout_quiescent"].includes(
          String(value.source_kind)
        )
      ) ||
      (
        Number(value.version) === 1 &&
        (
          value.source_kind !== undefined ||
          value.source_turn_history !== undefined
        )
      ) ||
      (
        Number(value.version) === 2 &&
        value.source_kind === "status_card_only" &&
        value.source_turn_history !== undefined
      ) ||
      (
        Number(value.version) === 2 &&
        value.source_kind === "candidate_rollout_quiescent" &&
        (
          !Array.isArray(value.source_turn_history) ||
          value.source_turn_history.length > 128
        )
      )
    ) {
      throw new Error(
        `deferred foreground transfer ${entry.name} is malformed`
      );
    }
    if (
      isFinalDeferredForegroundTransferStatus(value.status) ||
      Number(value.version) < 2 ||
      value.source_kind !== "candidate_rollout_quiescent"
    ) {
      continue;
    }
    if (value.source_turn_history.some((turn) =>
      isStoreRecord(turn) && turn.turn_id === conversationId
    )) {
      throw new Error(
        `cannot mutate Turn ${conversationId} while deferred foreground ` +
        `transfer ${entry.name} is ${value.status}`
      );
    }
    if (value.source_turn_history.some((turn) =>
      !isStoreRecord(turn) ||
      typeof turn.turn_id !== "string" ||
      turn.turn_id.length === 0 ||
      typeof turn.binding_id !== "string" ||
      !Number.isSafeInteger(Number(turn.binding_generation)) ||
      typeof turn.native_thread_id !== "string" ||
      typeof turn.turn_fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(turn.turn_fingerprint)
    )) {
      throw new Error(
        `deferred foreground transfer ${entry.name} has invalid source Turn authority`
      );
    }
  }
}

function isStoreRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function appendEventWithWriterLease(logPath: string, event: EventRecord): void {
  const serialized = `${JSON.stringify(event)}\n`;
  secureEventStorageMetadata(logPath, event);
  prepareDataDirectory(logPath);

  withConversationLock(logPath, () => {
    assertWritableDataPath(logPath, "event log");
    const fd = openRegularFileNoFollow(
      logPath,
      fs.constants.O_CREAT |
        fs.constants.O_RDWR |
        fs.constants.O_APPEND,
      "event log",
      PRIVATE_FILE_MODE
    );
    try {
      fs.fchmodSync(fd, PRIVATE_FILE_MODE);
      const existing = fs.readFileSync(fd, "utf8");
      assertValidEventLog(existing);
      const separator = existing.trim().length > 0 && !existing.endsWith("\n")
        ? "\n"
        : "";
      fs.writeFileSync(fd, `${separator}${serialized}`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  });
}

export function assertAppendableEventLog(logPath: string): true {
  let fd: number;
  try {
    fd = openRegularFileNoFollow(logPath, fs.constants.O_RDONLY, "event log");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
  try {
    const text = fs.readFileSync(fd, "utf8");
    assertValidEventLog(text);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function assertValidEventLog(text: string): true {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`event log is not valid NDJSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.event !== "string") {
      throw new Error(`event log line ${index + 1} is not an event object`);
    }
  }

  return true;
}

function validateConversationId(conversationId: string): void {
  if (
    typeof conversationId !== "string" ||
    conversationId.length === 0 ||
    conversationId === "." ||
    conversationId === ".." ||
    conversationId.includes("\0") ||
    path.posix.basename(conversationId) !== conversationId ||
    path.win32.basename(conversationId) !== conversationId ||
    path.posix.isAbsolute(conversationId) ||
    path.win32.isAbsolute(conversationId)
  ) {
    throw new Error(`invalid conversation id: ${JSON.stringify(conversationId)}`);
  }
}

function validateConversationPath(
  conversationId: string,
  storeDir: string
): {
  resolvedStoreDir: string;
  resolvedConversationsDir: string;
  resolvedConversationDir: string;
} {
  validateConversationId(conversationId);
  const resolvedStoreDir = path.resolve(storeDir);
  const resolvedConversationsDir = path.resolve(
    resolvedStoreDir,
    STORE_CONVERSATIONS_DIRECTORY
  );
  const resolvedConversationDir = path.resolve(
    resolvedConversationsDir,
    conversationId
  );
  if (path.dirname(resolvedConversationDir) !== resolvedConversationsDir) {
    throw new Error(`conversation id escapes the store directory: ${conversationId}`);
  }
  return {
    resolvedStoreDir,
    resolvedConversationsDir,
    resolvedConversationDir
  };
}

function prepareDataDirectory(dataPath: string): void {
  const directory = path.dirname(dataPath);
  if (path.basename(dataPath) === "state.json" || path.basename(dataPath) === "events.ndjson") {
    const paths = pathsForConversationDir(directory);
    ensureStoreWritable(paths.storeDir);
    ensureDir(directory);
    return;
  }

  const resolvedDirectory = path.resolve(directory);
  assertNotSymlink(resolvedDirectory, "data directory");
  if (!fs.existsSync(resolvedDirectory)) {
    fs.mkdirSync(resolvedDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
}

function secureConversationStorageMetadata(
  statePath: string,
  conversation: Conversation
): void {
  const paths = assertConversationStorageMetadata(statePath, conversation);
  ensureStoreWritable(paths.storeDir);
  ensureStoreDir(paths.storeDir, paths.conversationDir);
  ensureDir(paths.conversationDir);
}

function assertConversationStorageMetadata(
  statePath: string,
  conversation: Conversation
): ConversationPaths {
  if (
    typeof conversation.store_dir !== "string" ||
    typeof conversation.conversation_dir !== "string" ||
    typeof conversation.state_path !== "string"
  ) {
    throw new Error(
      `conversation storage metadata is required for state writes: ${statePath}`
    );
  }

  const paths = pathsForConversation(conversation.conversation_id, conversation.store_dir);
  if (
    path.resolve(paths.conversationDir) !== path.resolve(conversation.conversation_dir) ||
    path.resolve(paths.statePath) !== path.resolve(conversation.state_path) ||
    path.resolve(paths.statePath) !== path.resolve(statePath)
  ) {
    throw new Error(
      `conversation storage metadata does not match state path: ${statePath}`
    );
  }
  return paths;
}

function secureEventStorageMetadata(logPath: string, event: EventRecord): void {
  if (typeof event.conversation_id !== "string") {
    throw new Error(`conversation_id is required for event writes: ${logPath}`);
  }
  const conversationDir = path.dirname(logPath);
  validateConversationId(event.conversation_id);
  if (path.basename(conversationDir) !== event.conversation_id) {
    throw new Error(`event conversation_id does not match its directory: ${logPath}`);
  }
  const conversationsDir = path.dirname(conversationDir);
  if (path.basename(conversationsDir) !== STORE_CONVERSATIONS_DIRECTORY) {
    throw new Error(`event log is outside an AKK conversations directory: ${logPath}`);
  }
  const storeDir = path.dirname(conversationsDir);
  const paths = pathsForConversation(event.conversation_id, storeDir);
  if (path.resolve(paths.logPath) !== path.resolve(logPath)) {
    throw new Error(`event storage metadata does not match log path: ${logPath}`);
  }

  ensureStoreWritable(paths.storeDir);
  ensureStoreDir(paths.storeDir, paths.conversationDir);
  ensureDir(paths.conversationDir);
}

function assertCanonicalConversationDataPath(
  dataPath: string,
  expectedBasename: "state.json" | "events.ndjson"
): ConversationPaths {
  if (path.basename(dataPath) !== expectedBasename) {
    throw new Error(
      `AKK ${expectedBasename} writes require <store>/conversations/<id>/${expectedBasename}: ${dataPath}`
    );
  }
  const paths = pathsForConversationDir(path.dirname(dataPath));
  const canonical = pathsForConversation(
    path.basename(paths.conversationDir),
    paths.storeDir
  );
  const expectedPath = expectedBasename === "state.json"
    ? canonical.statePath
    : canonical.logPath;
  if (path.resolve(expectedPath) !== path.resolve(dataPath)) {
    throw new Error(`AKK conversation data path is not canonical: ${dataPath}`);
  }
  return canonical;
}

function managedSessionStatePath(storeDir: string, sessionId: string): string {
  return path.join(
    storeSessionsDir(storeDir),
    managedSessionStorageKey(sessionId),
    "state.json"
  );
}

function tryReadMaterializedManagedSession(
  statePath: string,
  expectedSessionId: string
): ManagedSessionState | undefined {
  try {
    const fd = openRegularFileNoFollow(
      statePath,
      fs.constants.O_RDONLY,
      "managed session state"
    );
    try {
      const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
      assertManagedSessionState(parsed, expectedSessionId);
      return parsed;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function materializeManagedSessionStatesWhileLocked(
  storeDir: string,
  states: readonly ManagedSessionState[],
  replaceMigrationRevisionOne: boolean
): void {
  const sessionsDir = storeSessionsDir(storeDir);
  assertNotSymlink(sessionsDir, "managed sessions directory");
  ensureDir(sessionsDir);

  const writes: Array<{ path: string; state: ManagedSessionState }> = [];
  for (const state of states) {
    assertManagedSessionState(state, state.session_id);
    const statePath = managedSessionStatePath(storeDir, state.session_id);
    const existing = tryReadMaterializedManagedSession(
      statePath,
      state.session_id
    );
    if (existing && JSON.stringify(existing) === JSON.stringify(state)) {
      continue;
    }
    if (
      existing &&
      !(
        replaceMigrationRevisionOne &&
        existing.revision === 1 &&
        existing.lineage.created_by === "migration"
      )
    ) {
      throw new Error(
        `managed Session ${state.session_id} already has non-migration state; ` +
        "refusing to overwrite it during Store materialization"
      );
    }
    writes.push({ path: statePath, state });
  }

  for (const write of writes) {
    atomicSaveManagedSessionState(write.path, write.state);
  }
  // Record-directory creation and every state rename are durable before a
  // target protocol manifest can become visible.
  fsyncDirectory(sessionsDir);
  fsyncDirectory(storeDir);
}

function assertUpgradeableManagedSessionTree(
  storeDir: string,
  expectedStates: readonly ManagedSessionState[]
): void {
  const sessionsDir = storeSessionsDir(storeDir);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(sessionsDir);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      `managed sessions directory must be a real directory: ${sessionsDir}`
    );
  }
  const expectedByKey = new Map(
    expectedStates.map((state) => [managedSessionStorageKey(state.session_id), state])
  );
  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    const entryPath = path.join(sessionsDir, entry.name);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !/^[0-9a-f]{64}$/u.test(entry.name)
    ) {
      throw new Error(
        `predecessor Store contains an invalid managed Session entry: ${entryPath}`
      );
    }
    const expected = expectedByKey.get(entry.name);
    if (!expected) {
      throw new Error(
        `predecessor Store contains unexpected managed Session state: ${entryPath}`
      );
    }
    const statePath = path.join(entryPath, "state.json");
    // An expected empty record directory is a recoverable crash residue. Any
    // present state must already be a strict, correctly keyed Session record.
    tryReadMaterializedManagedSession(statePath, expected.session_id);
  }
}

function atomicSaveManagedSessionState(
  statePath: string,
  state: ManagedSessionState
): void {
  const recordDir = path.dirname(statePath);
  const sessionsDir = path.dirname(recordDir);
  assertNotSymlink(sessionsDir, "managed sessions directory");
  ensureDir(recordDir);
  assertNotSymlink(recordDir, "managed session directory");
  const recordStat = fs.lstatSync(recordDir);
  if (!recordStat.isDirectory()) {
    throw new Error(`managed session directory must be a real directory: ${recordDir}`);
  }
  assertWritableDataPath(statePath, "managed session state");
  const tempPath = path.join(
    recordDir,
    `.state.json.${process.pid}.${randomUUID()}.tmp`
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
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertWritableDataPath(statePath, "managed session state");
    fs.renameSync(tempPath, statePath);
    fs.chmodSync(statePath, PRIVATE_FILE_MODE);
    fsyncDirectory(recordDir);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

function ensureStoreDir(storeDir: string, currentConversationDir: string): void {
  const resolvedStoreDir = path.resolve(storeDir);
  assertNotSymlink(resolvedStoreDir, "store directory");
  if (!fs.existsSync(resolvedStoreDir)) {
    prepareStoreRootForWriterLock(resolvedStoreDir);
  }

  const stat = fs.lstatSync(resolvedStoreDir);
  if (!stat.isDirectory()) {
    throw new Error(`store directory must be a real directory: ${storeDir}`);
  }
  if ((stat.mode & 0o777) === PRIVATE_DIRECTORY_MODE) {
    return;
  }

  const entries = fs.readdirSync(resolvedStoreDir, { withFileTypes: true });
  const resolvedCurrentConversationDir = path.resolve(currentConversationDir);
  const resolvedConversationsDir = path.resolve(storeConversationsDir(resolvedStoreDir));
  const looksDedicated = entries.length === 0 || entries.every((entry) => {
    const entryPath = path.join(resolvedStoreDir, entry.name);
    if (entry.name === STORE_MANIFEST_FILE && entry.isFile()) {
      return true;
    }
    if (entry.name === STORE_RUNTIME_DIRECTORY && entry.isDirectory()) {
      return true;
    }
    if (
      (entry.name === STORE_SESSIONS_DIRECTORY ||
        entry.name === STORE_TRANSITIONS_DIRECTORY ||
        entry.name === STORE_DEFERRED_FOREGROUND_TRANSFERS_DIRECTORY ||
        entry.name === STORE_TERMINAL_WATCHES_DIRECTORY) &&
      entry.isDirectory()
    ) {
      return true;
    }
    if (entryPath !== resolvedConversationsDir || !entry.isDirectory()) {
      return false;
    }
    return fs.readdirSync(resolvedConversationsDir, { withFileTypes: true })
      .every((conversationEntry) => {
        if (!conversationEntry.isDirectory()) {
          return false;
        }
        const conversationEntryPath = path.join(
          resolvedConversationsDir,
          conversationEntry.name
        );
        return conversationEntryPath === resolvedCurrentConversationDir ||
          fs.existsSync(path.join(conversationEntryPath, "state.json")) ||
          fs.existsSync(path.join(conversationEntryPath, "events.ndjson"));
      });
  });
  if (!looksDedicated) {
    throw new Error(
      `refusing to change permissions on a non-dedicated store directory; use a private 0700 directory: ${storeDir}`
    );
  }
  fs.chmodSync(resolvedStoreDir, PRIVATE_DIRECTORY_MODE);
}

function prepareStoreRootForWriterLock(storeDir: string): void {
  const resolvedStoreDir = path.resolve(storeDir);
  if (!fs.existsSync(resolvedStoreDir)) {
    ensureDir(resolvedStoreDir);
  }
  assertNotSymlink(resolvedStoreDir, "store directory");
  const stat = fs.lstatSync(resolvedStoreDir);
  if (!stat.isDirectory()) {
    throw new Error(`store directory must be a real directory: ${storeDir}`);
  }

  // This preliminary, non-mutating check prevents a bad custom --store-dir
  // from being chmodded or receiving a lock file before it fails closed.
  assertWritableCompatibility(inspectStoreCompatibility(resolvedStoreDir));
}

function ensureStoreWritableWhileLocked(storeDir: string): StoreManifest {
  let compatibility = inspectStoreCompatibility(storeDir);
  if (compatibility.status === "uninitialized") {
    createStoreManifest(storeDir);
    compatibility = inspectStoreCompatibility(storeDir);
  } else if (compatibility.status === "upgradeable") {
    upgradeStoreWriterProtocolWhileLocked(storeDir);
    compatibility = inspectStoreCompatibility(storeDir);
  }
  assertWritableCompatibility(compatibility);

  // Permission repair is a write and therefore happens only after the
  // manifest has been validated under the root writer lock.
  fs.chmodSync(storeDir, PRIVATE_DIRECTORY_MODE);
  ensureDir(storeConversationsDir(storeDir));
  ensureDir(storeSessionsDir(storeDir));
  return readStoreManifest(storeManifestPath(storeDir));
}

function assertWritableCompatibility(
  compatibility: StoreCompatibility
): asserts compatibility is StoreCompatibility & { writable: true } {
  if (!compatibility.writable) {
    throw new StoreCompatibilityError(
      `${compatibility.reason}; refusing to mutate the AKK store`,
      compatibility
    );
  }
}

function assertSameStoreLease(
  lease: ActiveStoreWriterLease,
  requestedStoreDir: string
): void {
  if (path.resolve(lease.storeDir) !== path.resolve(requestedStoreDir)) {
    throw new Error(
      `cannot acquire AKK store writer lease for ${requestedStoreDir} while holding ${lease.storeDir}`
    );
  }
}

function revalidateStoreWriterLease(lease: ActiveStoreWriterLease): void {
  const compatibility = inspectStoreCompatibility(lease.storeDir);
  assertWritableCompatibility(compatibility);
  if (
    compatibility.format_version !== lease.manifest.format_version ||
    compatibility.writer_protocol !== lease.manifest.writer_protocol
  ) {
    throw new StoreCompatibilityError(
      "AKK store manifest changed while its writer lease was active",
      compatibility
    );
  }
}

function storeHasConversationData(storeDir: string): boolean {
  const conversationsDir = storeConversationsDir(storeDir);
  if (!fs.existsSync(conversationsDir)) {
    return fs.readdirSync(storeDir).some((entry) =>
      !isStoreInitializationEntry(entry)
    );
  }
  assertNotSymlink(conversationsDir, "conversations directory");
  const conversationsStat = fs.lstatSync(conversationsDir);
  if (!conversationsStat.isDirectory()) {
    return true;
  }
  return fs.readdirSync(conversationsDir).length > 0 ||
    fs.readdirSync(storeDir).some((entry) =>
      entry !== STORE_CONVERSATIONS_DIRECTORY &&
      !isStoreInitializationEntry(entry)
    );
}

function isStoreInitializationEntry(entry: string): boolean {
  return entry === STORE_MANIFEST_FILE ||
    entry === STORE_RUNTIME_DIRECTORY ||
    entry === STORE_WRITER_LOCK_FILE ||
    entry === `${STORE_WRITER_LOCK_FILE}${STORE_LOCK_RECLAIM_SUFFIX}` ||
    (
      entry.startsWith(STORE_MANIFEST_TEMP_PREFIX) &&
      entry.endsWith(STORE_MANIFEST_TEMP_SUFFIX)
    );
}

function createStoreManifest(storeDir: string): void {
  if (storeHasConversationData(storeDir)) {
    const compatibility = inspectStoreCompatibility(storeDir);
    throw new StoreCompatibilityError(
      "refusing to adopt a non-empty manifestless AKK store; choose an empty store directory",
      compatibility
    );
  }
  const manifestPath = storeManifestPath(storeDir);
  const manifest: StoreManifest = {
    schema: STORE_SCHEMA,
    format_version: STORE_FORMAT_VERSION,
    writer_protocol: STORE_WRITER_PROTOCOL,
    created_at: new Date().toISOString()
  };
  const tempPath = path.join(
    storeDir,
    `${STORE_MANIFEST_TEMP_PREFIX}${process.pid}.${randomUUID()}${STORE_MANIFEST_TEMP_SUFFIX}`
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
    fs.writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // linkSync publishes the already-fsynced inode without ever exposing a
    // partially written manifest and, unlike rename, never replaces one.
    fs.linkSync(tempPath, manifestPath);
    fs.unlinkSync(tempPath);
    fsyncDirectory(storeDir);
  } catch (error) {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      if (!isNodeError(cleanupError, "ENOENT")) {
        throw cleanupError;
      }
    }
    if (isNodeError(error, "EEXIST")) {
      return;
    }
    throw error;
  }
}

/** Upgrade one explicitly supported predecessor while holding the root lock. */
function upgradeStoreWriterProtocolWhileLocked(storeDir: string): void {
  const manifestPath = storeManifestPath(storeDir);
  const previous = readStoreManifestSnapshot(manifestPath);
  assertUpgradeableStoreManifest(previous.manifest, storeDir);

  // Protocol 3 already has authoritative Session state. Protocols 3/4 only
  // publish the newer writer fence atomically; protocols 1/2 still need the
  // one-time Session materialization before publication.
  const requiresSessionMaterialization = previous.manifest.writer_protocol <
    STORE_SESSION_AUTHORITY_PROTOCOL;
  const stateSnapshots = requiresSessionMaterialization
    ? readUpgradeableStoreStateSnapshots(storeDir)
    : [];
  if (requiresSessionMaterialization) {
    const sessions = managedSessionStatesFromConversations(
      stateSnapshots.map(({ conversation }) => conversation)
    );
    assertUpgradeableManagedSessionTree(storeDir, sessions);
    materializeManagedSessionStatesWhileLocked(storeDir, sessions, true);
  }

  const upgraded: StoreManifest = {
    ...previous.manifest,
    writer_protocol: STORE_WRITER_PROTOCOL,
    created_at: previous.manifest.created_at
  };
  const tempPath = path.join(
    storeDir,
    `${STORE_MANIFEST_TEMP_PREFIX}${process.pid}.${randomUUID()}${STORE_MANIFEST_TEMP_SUFFIX}`
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
    fs.writeFileSync(fd, `${JSON.stringify(upgraded, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    // A process that ignores the root writer lock must not trick us into
    // replacing a different manifest. Re-check both file identity and the
    // supported predecessor immediately before the atomic rename.
    if (requiresSessionMaterialization) {
      revalidateUpgradeableStoreStateSnapshots(storeDir, stateSnapshots);
    }
    const current = readStoreManifestSnapshot(manifestPath);
    if (
      current.device !== previous.device ||
      current.inode !== previous.inode ||
      current.manifest.schema !== previous.manifest.schema ||
      current.manifest.format_version !== previous.manifest.format_version ||
      current.manifest.writer_protocol !== previous.manifest.writer_protocol ||
      current.manifest.created_at !== previous.manifest.created_at
    ) {
      throw new Error(
        "AKK store manifest changed while upgrading writer protocol; refusing to replace it"
      );
    }
    const manifestPathStat = fs.lstatSync(manifestPath, { bigint: true });
    if (
      manifestPathStat.isSymbolicLink() ||
      !manifestPathStat.isFile() ||
      manifestPathStat.dev !== current.device ||
      manifestPathStat.ino !== current.inode
    ) {
      throw new Error(
        "AKK store manifest path changed while upgrading writer protocol; refusing to replace it"
      );
    }

    fs.renameSync(tempPath, manifestPath);
    fsyncDirectory(storeDir);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

function assertUpgradeableStoreManifest(
  manifest: StoreManifest,
  storeDir: string
): void {
  if (
    manifest.schema !== STORE_SCHEMA ||
    manifest.format_version !== STORE_FORMAT_VERSION ||
    !STORE_UPGRADEABLE_WRITER_PROTOCOLS.has(manifest.writer_protocol)
  ) {
    throw new StoreCompatibilityError(
      `store is not one of the supported writer protocol predecessors ${[
        ...STORE_UPGRADEABLE_WRITER_PROTOCOLS
      ].join(", ")}`,
      inspectStoreCompatibility(storeDir)
    );
  }
}

function readUpgradeableStoreStateSnapshots(
  storeDir: string
): UpgradeableStoreStateSnapshot[] {
  const conversationsDir = storeConversationsDir(storeDir);
  let conversationsStat: fs.Stats;
  try {
    conversationsStat = fs.lstatSync(conversationsDir);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  if (conversationsStat.isSymbolicLink() || !conversationsStat.isDirectory()) {
    throw new Error(
      `conversations directory must be a real directory: ${conversationsDir}`
    );
  }

  const snapshots: UpgradeableStoreStateSnapshot[] = [];
  for (const entry of fs.readdirSync(conversationsDir, { withFileTypes: true })) {
    const conversationDir = path.join(conversationsDir, entry.name);
    const conversationStat = fs.lstatSync(conversationDir);
    if (conversationStat.isSymbolicLink()) {
      throw new Error(
        `conversation directory must not be a symlink: ${conversationDir}`
      );
    }
    if (!conversationStat.isDirectory()) {
      continue;
    }

    const statePath = path.join(conversationDir, "state.json");
    let stateStat: fs.Stats;
    try {
      stateStat = fs.lstatSync(statePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (stateStat.isSymbolicLink() || !stateStat.isFile()) {
      throw new Error(`state file must be a regular file: ${statePath}`);
    }
    const stateFd = openRegularFileNoFollow(
      statePath,
      fs.constants.O_RDONLY,
      "state file"
    );
    try {
      let parsed: unknown;
      let contents: string;
      try {
        contents = fs.readFileSync(stateFd, "utf8");
        parsed = JSON.parse(contents);
      } catch (error) {
        throw new Error(
          `invalid conversation state during Store upgrade: ${statePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const identity = assertConversationStateIdentity(parsed, entry.name);
      const stat = fs.fstatSync(stateFd, { bigint: true });
      snapshots.push({
        conversation: {
          ...identity.conversation,
          session_id: identity.sessionId,
          turn_id: identity.turnId
        },
        statePath,
        device: stat.dev,
        inode: stat.ino,
        contentsSha256: createHash("sha256").update(contents).digest("hex")
      });
    } finally {
      fs.closeSync(stateFd);
    }
  }
  return snapshots;
}

function revalidateUpgradeableStoreStateSnapshots(
  storeDir: string,
  snapshots: readonly UpgradeableStoreStateSnapshot[]
): void {
  const current = readUpgradeableStoreStateSnapshots(storeDir);
  const expectedByPath = new Map(
    snapshots.map((snapshot) => [snapshot.statePath, snapshot])
  );
  if (current.length !== snapshots.length) {
    throw new Error("conversation set changed during Store upgrade");
  }
  for (const actual of current) {
    const expected = expectedByPath.get(actual.statePath);
    if (
      !expected ||
      actual.device !== expected.device ||
      actual.inode !== expected.inode ||
      actual.contentsSha256 !== expected.contentsSha256
    ) {
      throw new Error(
        `conversation state changed during Store upgrade: ${actual.statePath}`
      );
    }
  }
}

function readStoreManifest(manifestPath: string): StoreManifest {
  return readStoreManifestSnapshot(manifestPath).manifest;
}

function readStoreManifestSnapshot(manifestPath: string): StoreManifestSnapshot {
  const fd = openRegularFileNoFollow(
    manifestPath,
    fs.constants.O_RDONLY,
    "store manifest"
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<StoreManifest>;
    if (
      parsed.schema !== STORE_SCHEMA ||
      !Number.isSafeInteger(parsed.format_version) ||
      !Number.isSafeInteger(parsed.writer_protocol) ||
      typeof parsed.created_at !== "string"
    ) {
      throw new Error(`invalid AKK store manifest: ${manifestPath}`);
    }
    return {
      manifest: parsed as StoreManifest,
      device: stat.dev,
      inode: stat.ino
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertNotSymlink(targetPath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${targetPath}`);
  }
}

function assertWritableDataPath(dataPath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dataPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${dataPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${dataPath}`);
  }
}

function openRegularFileNoFollow(
  filePath: string,
  flags: number,
  label: string,
  mode?: number
): number {
  const fd = fs.openSync(filePath, flags | NO_FOLLOW_FLAG, mode);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return fd;
}

function withConversationLock<T>(dataPath: string, action: () => T): T {
  const lockPath = path.join(path.dirname(dataPath), STORE_LOCK_FILE);
  const token = randomUUID();
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  acquireConversationLock(lockPath, token, deadline);
  try {
    return action();
  } finally {
    releaseConversationLock(lockPath, token);
  }
}

function acquireConversationLock(lockPath: string, token: string, deadline: number): void {
  while (true) {
    assertNotSymlink(lockPath, "conversation lock");
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          NO_FOLLOW_FLAG,
        PRIVATE_FILE_MODE
      );
      fs.fchmodSync(fd, PRIVATE_FILE_MODE);
      fs.writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() })}\n`,
        "utf8"
      );
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }

    if (removeStaleConversationLock(lockPath)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new StoreLockTimeoutError(lockPath);
    }
    sleepSync(STORE_LOCK_RETRY_MS);
  }
}

function removeStaleConversationLock(lockPath: string): boolean {
  const reclaimPath = `${lockPath}${STORE_LOCK_RECLAIM_SUFFIX}`;
  let reclaimFd: number | undefined;
  try {
    reclaimFd = fs.openSync(
      reclaimPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        NO_FOLLOW_FLAG,
      PRIVATE_FILE_MODE
    );
    fs.fchmodSync(reclaimFd, PRIVATE_FILE_MODE);
    fs.writeFileSync(reclaimFd, `${process.pid}\n`, "utf8");
    fs.fsyncSync(reclaimFd);
  } catch (error) {
    if (reclaimFd !== undefined) {
      fs.closeSync(reclaimFd);
    }
    if (isNodeError(error, "EEXIST")) {
      return false;
    }
    throw error;
  }

  try {
    return removeStaleConversationLockAsReclaimer(lockPath);
  } finally {
    fs.closeSync(reclaimFd);
    try {
      fs.unlinkSync(reclaimPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

function removeStaleConversationLockAsReclaimer(lockPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`conversation lock must be a regular file, not a symlink: ${lockPath}`);
  }

  const ageMs = Date.now() - stat.mtimeMs;
  let ownerPid: number | undefined;
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (Number.isInteger(owner.pid) && Number(owner.pid) > 0) {
      ownerPid = Number(owner.pid);
    }
  } catch {
    // A creator may still be writing the lock. Only reclaim invalid data after a grace period.
  }

  const stale =
    (ownerPid !== undefined && !processExists(ownerPid)) ||
    (ownerPid === undefined && ageMs >= STORE_LOCK_INVALID_STALE_MS);
  if (!stale) {
    return false;
  }

  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

function releaseConversationLock(lockPath: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown };
    if (owner.token !== token) {
      return;
    }
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    fs.fsyncSync(fd);
  } catch (error) {
    if (
      !isNodeError(error, "EINVAL") &&
      !isNodeError(error, "ENOTSUP") &&
      !isNodeError(error, "EPERM") &&
      !isNodeError(error, "EISDIR")
    ) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function messageEvent(message: AgentMessage): EventRecord {
  validateMessage(message);
  return {
    ts: message.ts,
    conversation_id: message.conversation_id,
    session_id: message.session_id ?? message.conversation_id,
    turn_id: message.turn_id ?? message.conversation_id,
    event: "message",
    from: message.from,
    to: message.to,
    type: message.type,
    requires_response: message.requires_response,
    round: message.round,
    body: message.body,
    message
  };
}

export function rawExchangeEvent({
  conversationId,
  from,
  to,
  prompt,
  response,
  round,
  type = "raw_exchange"
}: {
  conversationId: string;
  from: string;
  to: string;
  prompt: string;
  response: string;
  round: number;
  type?: string;
}): EventRecord {
  return {
    ts: new Date().toISOString(),
    conversation_id: conversationId,
    event: type,
    from,
    to,
    round,
    prompt,
    response
  };
}
