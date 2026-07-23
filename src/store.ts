import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, Conversation } from "./protocol.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STORE_LOCK_FILE = ".akk-store.lock";
const STORE_LOCK_RECLAIM_SUFFIX = ".reclaim";
const STORE_LOCK_TIMEOUT_MS = 10_000;
const STORE_LOCK_RETRY_MS = 10;
const STORE_LOCK_INVALID_STALE_MS = 30_000;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;

export function defaultStoreDir(_workspace = process.cwd()): string {
  return path.join(os.homedir(), ".agent-knock-knock", "conversations");
}

export function defaultLogDir(workspace = process.cwd()): string {
  return defaultStoreDir(workspace);
}

export function ensureDir(dir: string): void {
  const resolvedDir = path.resolve(dir);
  assertNotSymlink(resolvedDir, "store directory");
  fs.mkdirSync(resolvedDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
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

export interface EventRecord {
  event: string;
  [key: string]: unknown;
}

export function pathsForConversation(conversationId: string, storeDir = defaultStoreDir()): ConversationPaths {
  const validated = validateConversationPath(conversationId, storeDir);
  const conversationDir = path.join(storeDir, conversationId);
  assertNotSymlink(validated.resolvedStoreDir, "store directory");
  assertNotSymlink(validated.resolvedConversationDir, "conversation directory");
  return {
    storeDir,
    logDir: storeDir,
    conversationDir,
    logPath: path.join(conversationDir, "events.ndjson"),
    statePath: path.join(conversationDir, "state.json")
  };
}

export function pathsForConversationDir(conversationDir: string): ConversationPaths {
  const resolvedConversationDir = path.resolve(conversationDir);
  const resolvedStoreDir = path.dirname(resolvedConversationDir);
  if (resolvedConversationDir === resolvedStoreDir) {
    throw new Error(`conversation directory must be contained by a store directory: ${conversationDir}`);
  }
  assertNotSymlink(resolvedStoreDir, "store directory");
  assertNotSymlink(resolvedConversationDir, "conversation directory");
  return {
    storeDir: path.dirname(conversationDir),
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
  validateConversationId(conversation.conversation_id);
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

export function loadState(statePath: string): Conversation {
  assertNotSymlink(path.dirname(statePath), "conversation directory");
  const fd = openRegularFileNoFollow(statePath, fs.constants.O_RDONLY, "state file");
  try {
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    return JSON.parse(fs.readFileSync(fd, "utf8")) as Conversation;
  } finally {
    fs.closeSync(fd);
  }
}

export function statePathForConversationId(conversationId: string, storeDir = defaultStoreDir()): string {
  return pathsForConversation(conversationId, storeDir).statePath;
}

export function loadConversationById(conversationId: string, storeDir = defaultStoreDir()): Conversation {
  return loadState(statePathForConversationId(conversationId, storeDir));
}

export function listConversations(storeDir = defaultStoreDir()): Conversation[] {
  if (!fs.existsSync(storeDir)) {
    return [];
  }

  assertNotSymlink(path.resolve(storeDir), "store directory");
  return fs.readdirSync(storeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => pathsForConversation(entry.name, storeDir).statePath)
    .filter((statePath) => fs.existsSync(statePath))
    .map((statePath) => {
      const conversation = loadState(statePath);
      return {
        ...conversation,
        state_path: conversation.state_path ?? statePath,
        event_log_path: conversation.event_log_path ?? logPathForStatePath(statePath),
        conversation_dir: conversation.conversation_dir ?? path.dirname(statePath)
      };
    })
    .sort((left: Conversation, right: Conversation) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
}

export function appendEvent(logPath: string, event: EventRecord): void {
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
  resolvedConversationDir: string;
} {
  validateConversationId(conversationId);
  const resolvedStoreDir = path.resolve(storeDir);
  const resolvedConversationDir = path.resolve(resolvedStoreDir, conversationId);
  if (path.dirname(resolvedConversationDir) !== resolvedStoreDir) {
    throw new Error(`conversation id escapes the store directory: ${conversationId}`);
  }
  return {
    resolvedStoreDir,
    resolvedConversationDir
  };
}

function prepareDataDirectory(dataPath: string): void {
  const directory = path.dirname(dataPath);
  if (path.basename(dataPath) === "state.json" || path.basename(dataPath) === "events.ndjson") {
    assertNotSymlink(path.resolve(path.dirname(directory)), "store directory");
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
  if (
    typeof conversation.store_dir !== "string" ||
    typeof conversation.conversation_dir !== "string" ||
    typeof conversation.state_path !== "string"
  ) {
    return;
  }

  const paths = pathsForConversation(conversation.conversation_id, conversation.store_dir);
  if (
    path.resolve(paths.conversationDir) !== path.resolve(conversation.conversation_dir) ||
    path.resolve(paths.statePath) !== path.resolve(conversation.state_path) ||
    path.resolve(paths.statePath) !== path.resolve(statePath)
  ) {
    return;
  }

  ensureStoreDir(paths.storeDir, paths.conversationDir);
  ensureDir(paths.conversationDir);
}

function secureEventStorageMetadata(logPath: string, event: EventRecord): void {
  if (typeof event.conversation_id !== "string") {
    return;
  }
  const conversationDir = path.dirname(logPath);
  validateConversationId(event.conversation_id);
  if (path.basename(conversationDir) !== event.conversation_id) {
    return;
  }
  const storeDir = path.dirname(conversationDir);
  const paths = pathsForConversation(event.conversation_id, storeDir);
  if (path.resolve(paths.logPath) !== path.resolve(logPath)) {
    return;
  }

  ensureStoreDir(paths.storeDir, paths.conversationDir);
  ensureDir(paths.conversationDir);
}

function ensureStoreDir(storeDir: string, currentConversationDir: string): void {
  const resolvedStoreDir = path.resolve(storeDir);
  assertNotSymlink(resolvedStoreDir, "store directory");
  if (!fs.existsSync(resolvedStoreDir)) {
    ensureDir(resolvedStoreDir);
    return;
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
  const looksDedicated = resolvedStoreDir === path.resolve(defaultStoreDir()) ||
    entries.length === 0 ||
    entries.every((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const entryPath = path.join(resolvedStoreDir, entry.name);
      return entryPath === resolvedCurrentConversationDir ||
        fs.existsSync(path.join(entryPath, "state.json")) ||
        fs.existsSync(path.join(entryPath, "events.ndjson"));
    });
  if (!looksDedicated) {
    throw new Error(
      `refusing to change permissions on a non-dedicated store directory; use a private 0700 directory: ${storeDir}`
    );
  }
  fs.chmodSync(resolvedStoreDir, PRIVATE_DIRECTORY_MODE);
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
      throw new Error(`timed out waiting for conversation store lock: ${lockPath}`);
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
  return {
    ts: message.ts,
    conversation_id: message.conversation_id,
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
