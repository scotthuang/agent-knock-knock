import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  atomicSaveJsonFile,
  isNodeError,
  readJsonFileNoFollow
} from "./durable-json-file.js";
import { isExecutorKind, type ExecutorKind } from "./executors.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { ensureDir } from "./store.js";

export const TERMINAL_DELEGATE_SEND_BINDING_SCHEMA =
  "agent-knock-knock/terminal-delegate-send-binding";
export const TERMINAL_DELEGATE_SEND_BINDING_VERSION = 1;
export const TERMINAL_DELEGATE_SEND_BINDINGS_DIRECTORY =
  "terminal-delegate-send-bindings";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class TerminalDelegateSendBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalDelegateSendBindingConflictError";
  }
}

export class TerminalDelegateSendBindingUncertainError extends Error {
  readonly possibleExistingBinding: boolean;

  constructor(
    message: string,
    options: { cause?: unknown; possibleExistingBinding?: boolean } = {}
  ) {
    super(message, options);
    this.name = "TerminalDelegateSendBindingUncertainError";
    this.possibleExistingBinding = options.possibleExistingBinding ?? true;
  }
}

/** Immutable caller scope for one omitted-target delegate request. */
export interface TerminalDelegateSendRequestBoundary {
  readonly messageId: string;
  readonly requestHash: string;
  readonly requestedWorkspace?: string;
  readonly requestedAgent?: ExecutorKind;
  readonly openclawSession?: string;
}

/** Exact physical target selected while the global message lock is held. */
export interface TerminalDelegateSendTargetBoundary {
  readonly terminalId: string;
  readonly workspace: string;
  readonly terminalRuntimeKey: string;
  readonly physicalToken: string;
}

/** Private immutable binding returned to delegate routing. */
export interface TerminalDelegateSendBinding
  extends TerminalDelegateSendRequestBoundary,
    TerminalDelegateSendTargetBoundary {
  readonly reservedAt: string;
}

export type TerminalDelegateSendBindResult = {
  outcome: "reserved" | "replay";
  binding: TerminalDelegateSendBinding;
};

export interface TerminalDelegateSendBindingRepository {
  pathFor(input: Pick<TerminalDelegateSendRequestBoundary, "messageId">): string;
  /** Hold the global same-message lock across load, discovery, and bind. */
  acquire(messageId: string): () => void;
  load(
    boundary: TerminalDelegateSendRequestBoundary
  ): TerminalDelegateSendBinding | undefined;
  /** Caller must hold acquire(boundary.messageId) until this returns. */
  bind(
    boundary: TerminalDelegateSendRequestBoundary,
    target: TerminalDelegateSendTargetBoundary
  ): TerminalDelegateSendBindResult;
}

interface TerminalDelegateSendBindingRepositoryOptions {
  runtimeDir: string;
  now?: () => Date;
  ensureDirectory?: (directoryPath: string) => void;
  acquireLock?: (lockPath: string) => () => void;
  saveJson?: typeof atomicSaveJsonFile;
}

interface TerminalDelegateSendBindingRecord {
  schema: typeof TERMINAL_DELEGATE_SEND_BINDING_SCHEMA;
  version: typeof TERMINAL_DELEGATE_SEND_BINDING_VERSION;
  message_id: string;
  request_hash: string;
  requested_workspace?: string;
  requested_agent?: ExecutorKind;
  openclaw_session?: string;
  terminal_id: string;
  workspace: string;
  terminal_runtime_key: string;
  physical_token: string;
  reserved_at: string;
}

const ALLOWED_KEYS = new Set([
  "schema",
  "version",
  "message_id",
  "request_hash",
  "requested_workspace",
  "requested_agent",
  "openclaw_session",
  "terminal_id",
  "workspace",
  "terminal_runtime_key",
  "physical_token",
  "reserved_at"
]);

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

function requiredDigest(value: unknown, label: string): string {
  const normalized = requiredString(value, label);
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  if (
    Number.isNaN(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalExecutor(value: unknown): ExecutorKind | undefined {
  if (value === undefined) return undefined;
  const agent = requiredString(value, "requested_agent");
  if (!isExecutorKind(agent)) {
    throw new Error("requested_agent must identify a supported executor");
  }
  return agent;
}

function parseRecord(value: unknown): TerminalDelegateSendBindingRecord {
  if (!isRecord(value)) {
    throw new Error("terminal delegate send binding must contain a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `terminal delegate send binding contains unsupported field ${key}`
      );
    }
  }
  if (
    value.schema !== TERMINAL_DELEGATE_SEND_BINDING_SCHEMA ||
    value.version !== TERMINAL_DELEGATE_SEND_BINDING_VERSION
  ) {
    throw new Error("terminal delegate send binding has an unsupported schema");
  }
  requiredString(value.message_id, "message_id");
  requiredDigest(value.request_hash, "request_hash");
  optionalString(value.requested_workspace, "requested_workspace");
  optionalExecutor(value.requested_agent);
  optionalString(value.openclaw_session, "openclaw_session");
  requiredString(value.terminal_id, "terminal_id");
  requiredString(value.workspace, "workspace");
  requiredString(value.terminal_runtime_key, "terminal_runtime_key");
  requiredDigest(value.physical_token, "physical_token");
  canonicalTimestamp(value.reserved_at, "reserved_at");
  return value as unknown as TerminalDelegateSendBindingRecord;
}

function canonicalRequestBoundary(
  value: TerminalDelegateSendRequestBoundary
): TerminalDelegateSendRequestBoundary {
  const requestedAgent = optionalExecutor(value.requestedAgent);
  return {
    messageId: requiredString(value.messageId, "messageId"),
    requestHash: requiredDigest(value.requestHash, "requestHash"),
    ...(value.requestedWorkspace === undefined
      ? {}
      : {
          requestedWorkspace: path.resolve(requiredString(
            value.requestedWorkspace,
            "requestedWorkspace"
          ))
        }),
    ...(requestedAgent === undefined ? {} : { requestedAgent }),
    ...(value.openclawSession === undefined
      ? {}
      : {
          openclawSession: requiredString(
            value.openclawSession,
            "openclawSession"
          )
        })
  };
}

function canonicalTargetBoundary(
  value: TerminalDelegateSendTargetBoundary
): TerminalDelegateSendTargetBoundary {
  return {
    terminalId: requiredString(value.terminalId, "terminalId"),
    workspace: path.resolve(requiredString(value.workspace, "workspace")),
    terminalRuntimeKey: requiredString(
      value.terminalRuntimeKey,
      "terminalRuntimeKey"
    ),
    physicalToken: requiredDigest(value.physicalToken, "physicalToken")
  };
}

function bindingFromRecord(
  record: TerminalDelegateSendBindingRecord
): TerminalDelegateSendBinding {
  return {
    messageId: record.message_id,
    requestHash: record.request_hash,
    ...(record.requested_workspace === undefined
      ? {}
      : { requestedWorkspace: record.requested_workspace }),
    ...(record.requested_agent === undefined
      ? {}
      : { requestedAgent: record.requested_agent }),
    ...(record.openclaw_session === undefined
      ? {}
      : { openclawSession: record.openclaw_session }),
    terminalId: record.terminal_id,
    workspace: record.workspace,
    terminalRuntimeKey: record.terminal_runtime_key,
    physicalToken: record.physical_token,
    reservedAt: record.reserved_at
  };
}

function recordFromBinding(
  binding: TerminalDelegateSendBinding
): TerminalDelegateSendBindingRecord {
  return {
    schema: TERMINAL_DELEGATE_SEND_BINDING_SCHEMA,
    version: TERMINAL_DELEGATE_SEND_BINDING_VERSION,
    message_id: binding.messageId,
    request_hash: binding.requestHash,
    ...(binding.requestedWorkspace === undefined
      ? {}
      : { requested_workspace: binding.requestedWorkspace }),
    ...(binding.requestedAgent === undefined
      ? {}
      : { requested_agent: binding.requestedAgent }),
    ...(binding.openclawSession === undefined
      ? {}
      : { openclaw_session: binding.openclawSession }),
    terminal_id: binding.terminalId,
    workspace: binding.workspace,
    terminal_runtime_key: binding.terminalRuntimeKey,
    physical_token: binding.physicalToken,
    reserved_at: binding.reservedAt
  };
}

function assertRequestMatches(
  binding: TerminalDelegateSendBinding,
  boundary: TerminalDelegateSendRequestBoundary
): void {
  if (binding.messageId !== boundary.messageId) {
    throw new TerminalDelegateSendBindingConflictError(
      "terminal delegate send binding identity does not match"
    );
  }
  if (binding.requestHash !== boundary.requestHash) {
    throw new TerminalDelegateSendBindingConflictError(
      "messageId is already bound to a different delegate request hash"
    );
  }
  if (
    binding.requestedWorkspace !== boundary.requestedWorkspace ||
    binding.requestedAgent !== boundary.requestedAgent ||
    binding.openclawSession !== boundary.openclawSession
  ) {
    throw new TerminalDelegateSendBindingConflictError(
      "messageId is already bound to a different delegate request scope"
    );
  }
}

function assertTargetMatches(
  binding: TerminalDelegateSendBinding,
  target: TerminalDelegateSendTargetBoundary
): void {
  if (
    binding.terminalId !== target.terminalId ||
    binding.workspace !== target.workspace ||
    binding.terminalRuntimeKey !== target.terminalRuntimeKey ||
    binding.physicalToken !== target.physicalToken
  ) {
    throw new TerminalDelegateSendBindingConflictError(
      "messageId is already bound to a different physical terminal"
    );
  }
}

function nowTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("now() must return a valid Date");
  }
  return value.toISOString();
}

function syncSleep(milliseconds: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds
  );
}

function finalBindingPathDefinitelyAbsent(
  filePath: string
): boolean | undefined {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return true;
    }
    return undefined;
  }
}

/**
 * Store-independent immutable routing for omitted-target Send.
 *
 * The message lock spans discovery because no terminal lock exists until a
 * target is chosen. The request body is never persisted. Once bound, retries
 * must return to the same physical/runtime boundary; the per-terminal Send
 * intent remains responsible for delivery replay versus uncertainty.
 */
export function createTerminalDelegateSendBindingRepository(
  options: TerminalDelegateSendBindingRepositoryOptions
): TerminalDelegateSendBindingRepository {
  const runtimeDir = path.resolve(options.runtimeDir);
  const bindingsDir = path.join(
    runtimeDir,
    TERMINAL_DELEGATE_SEND_BINDINGS_DIRECTORY
  );
  const now = options.now ?? (() => new Date());
  const ensureDirectory = options.ensureDirectory ?? ensureDir;
  const saveJson = options.saveJson ?? atomicSaveJsonFile;
  const fileLock = createFileLockCliAdapter({
    now: () => new Date(),
    nowMs: Date.now,
    pid: () => process.pid,
    sleepSync: syncSleep
  });
  const acquireLock = options.acquireLock ?? ((lockPath: string) =>
    fileLock.acquire(lockPath));
  const heldMessages = new Set<string>();

  function pathFor(
    input: Pick<TerminalDelegateSendRequestBoundary, "messageId">
  ): string {
    const messageId = requiredString(input.messageId, "messageId");
    const messageDigest = digest(messageId);
    return path.join(
      bindingsDir,
      messageDigest.slice(0, 2),
      `terminal-delegate-send-binding-${messageDigest}.json`
    );
  }

  function acquire(messageId: string): () => void {
    const filePath = pathFor({ messageId });
    const messageKey = digest(messageId);
    if (heldMessages.has(messageKey)) {
      throw new TerminalDelegateSendBindingUncertainError(
        "terminal delegate send binding lock is already held by this repository"
      );
    }
    let releaseFileLock: (() => void) | undefined;
    try {
      ensureDirectory(path.dirname(filePath));
      releaseFileLock = acquireLock(`${filePath}.lock`);
      heldMessages.add(messageKey);
    } catch (error) {
      const definitelyAbsent = finalBindingPathDefinitelyAbsent(filePath);
      throw new TerminalDelegateSendBindingUncertainError(
        `terminal delegate send binding lock is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          cause: error,
          possibleExistingBinding:
            (isRecord(error) && error.code === "LOCK_TIMEOUT") ||
            definitelyAbsent !== true
        }
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      heldMessages.delete(messageKey);
      releaseFileLock?.();
    };
  }

  function load(
    input: TerminalDelegateSendRequestBoundary
  ): TerminalDelegateSendBinding | undefined {
    const boundary = canonicalRequestBoundary(input);
    const filePath = pathFor(boundary);
    try {
      const binding = bindingFromRecord(parseRecord(
        readJsonFileNoFollow(filePath, "terminal delegate send binding")
      ));
      assertRequestMatches(binding, boundary);
      return binding;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      if (
        error instanceof TerminalDelegateSendBindingConflictError ||
        error instanceof TerminalDelegateSendBindingUncertainError
      ) {
        throw error;
      }
      const definitelyAbsent = finalBindingPathDefinitelyAbsent(filePath);
      throw new TerminalDelegateSendBindingUncertainError(
        `${definitelyAbsent === true
          ? "missing"
          : definitelyAbsent === false
            ? "existing same-id"
            : "possibly existing same-id"} terminal delegate send ` +
        `binding cannot be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          cause: error,
          possibleExistingBinding: definitelyAbsent !== true
        }
      );
    }
  }

  function save(binding: TerminalDelegateSendBinding): void {
    saveJson(pathFor(binding), recordFromBinding(binding), {
      rootLabel: "terminal delegate send binding root",
      directoryLabel: "terminal delegate send binding shard directory",
      fileLabel: "terminal delegate send binding",
      ensureDirectory,
      fsyncNewRootParent: true,
      fsyncNewDirectoryParent: true
    });
  }

  function bind(
    input: TerminalDelegateSendRequestBoundary,
    targetInput: TerminalDelegateSendTargetBoundary
  ): TerminalDelegateSendBindResult {
    const boundary = canonicalRequestBoundary(input);
    const target = canonicalTargetBoundary(targetInput);
    if (!heldMessages.has(digest(boundary.messageId))) {
      throw new TerminalDelegateSendBindingUncertainError(
        "terminal delegate send binding requires its global message lock"
      );
    }
    try {
      const existing = load(boundary);
      if (existing) {
        assertTargetMatches(existing, target);
        return { outcome: "replay", binding: existing };
      }
      const binding: TerminalDelegateSendBinding = {
        ...boundary,
        ...target,
        reservedAt: nowTimestamp(now)
      };
      save(binding);
      return { outcome: "reserved", binding };
    } catch (error) {
      if (
        error instanceof TerminalDelegateSendBindingConflictError ||
        error instanceof TerminalDelegateSendBindingUncertainError
      ) {
        throw error;
      }
      throw new TerminalDelegateSendBindingUncertainError(
        `terminal delegate send binding reservation is uncertain: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          cause: error,
          // load() proved this id fresh while its global lock was held. Even
          // if atomic replacement reached the final path before a chmod/fsync
          // tail failure, that record belongs to this pre-input route.
          possibleExistingBinding: false
        }
      );
    }
  }

  return { pathFor, acquire, load, bind };
}
