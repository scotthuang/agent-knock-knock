import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  atomicSaveJsonFile,
  isNodeError,
  readJsonFileNoFollow
} from "./durable-json-file.js";
import { ensureDir } from "./store.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";

export const TERMINAL_USER_SEND_INTENT_SCHEMA =
  "agent-knock-knock/terminal-user-send-intent";
export const TERMINAL_USER_SEND_INTENT_VERSION = 1;
export const TERMINAL_USER_SEND_INTENTS_DIRECTORY =
  "terminal-user-send-intents";

export type TerminalUserSendIntentStage =
  | "reserved"
  | "zero_input_cancelled"
  | "enter_dispatched";

export type TerminalUserSendDeliveryMode = "managed" | "unmanaged";

export class TerminalUserSendIntentBoundaryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalUserSendIntentBoundaryConflictError";
  }
}

export class TerminalUserSendIntentUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalUserSendIntentUncertainError";
  }
}

export interface TerminalUserSendIntentBoundary {
  terminalRuntimeKey: string;
  physicalToken: string;
  messageId: string;
  requestHash: string;
}

export interface TerminalUserSendIntent {
  schema: typeof TERMINAL_USER_SEND_INTENT_SCHEMA;
  version: typeof TERMINAL_USER_SEND_INTENT_VERSION;
  terminal_runtime_key: string;
  physical_token: string;
  message_id: string;
  request_hash: string;
  stage: TerminalUserSendIntentStage;
  reserved_at: string;
  zero_input_cancelled_at?: string;
  enter_dispatched_at?: string;
  delivery_mode?: TerminalUserSendDeliveryMode;
}

export type TerminalUserSendIntentReserveResult =
  | { outcome: "reserved"; intent: TerminalUserSendIntent }
  | {
      outcome: "replay" | "uncertain";
      stage: TerminalUserSendIntentStage;
      intent: TerminalUserSendIntent;
    };

export interface TerminalUserSendIntentRepository {
  pathFor(
    input: Pick<TerminalUserSendIntentBoundary, "messageId">
  ): string;
  load(input: TerminalUserSendIntentBoundary):
    TerminalUserSendIntent | undefined;
  reserve(input: TerminalUserSendIntentBoundary):
    TerminalUserSendIntentReserveResult;
  cancelProvenZeroInput(input: TerminalUserSendIntentBoundary): boolean;
  complete(
    input: TerminalUserSendIntentBoundary,
    deliveryMode: TerminalUserSendDeliveryMode
  ): TerminalUserSendIntent;
}

interface TerminalUserSendIntentRepositoryOptions {
  runtimeDir: string;
  now?: () => Date;
  ensureDirectory?: (directoryPath: string) => void;
  acquireLock?: (lockPath: string) => () => void;
  saveJson?: typeof atomicSaveJsonFile;
}

const ALLOWED_KEYS = new Set([
  "schema",
  "version",
  "terminal_runtime_key",
  "physical_token",
  "message_id",
  "request_hash",
  "stage",
  "reserved_at",
  "zero_input_cancelled_at",
  "enter_dispatched_at",
  "delivery_mode"
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

function parseIntent(value: unknown): TerminalUserSendIntent {
  if (!isRecord(value)) {
    throw new Error("terminal user-send intent must contain a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `terminal user-send intent contains unsupported field ${key}`
      );
    }
  }
  if (
    value.schema !== TERMINAL_USER_SEND_INTENT_SCHEMA ||
    value.version !== TERMINAL_USER_SEND_INTENT_VERSION
  ) {
    throw new Error("terminal user-send intent has an unsupported schema");
  }
  const stage = value.stage;
  if (
    stage !== "reserved" &&
    stage !== "zero_input_cancelled" &&
    stage !== "enter_dispatched"
  ) {
    throw new Error("terminal user-send intent stage is invalid");
  }
  requiredString(value.terminal_runtime_key, "terminal_runtime_key");
  requiredString(value.physical_token, "physical_token");
  requiredString(value.message_id, "message_id");
  requiredString(value.request_hash, "request_hash");
  canonicalTimestamp(value.reserved_at, "reserved_at");
  if (stage === "enter_dispatched") {
    canonicalTimestamp(value.enter_dispatched_at, "enter_dispatched_at");
    if (value.delivery_mode !== "managed" && value.delivery_mode !== "unmanaged") {
      throw new Error("a completed terminal user-send intent needs a delivery mode");
    }
    if (value.zero_input_cancelled_at !== undefined) {
      throw new Error(
        "a completed terminal user-send intent cannot claim zero-input cancellation"
      );
    }
  } else if (stage === "zero_input_cancelled") {
    canonicalTimestamp(
      value.zero_input_cancelled_at,
      "zero_input_cancelled_at"
    );
    if (
      value.enter_dispatched_at !== undefined ||
      value.delivery_mode !== undefined
    ) {
      throw new Error(
        "a zero-input terminal user-send intent cannot claim delivery"
      );
    }
  } else if (
    value.zero_input_cancelled_at !== undefined ||
    value.enter_dispatched_at !== undefined ||
    value.delivery_mode !== undefined
  ) {
    throw new Error(
      "a reserved terminal user-send intent cannot claim delivery"
    );
  }
  return value as unknown as TerminalUserSendIntent;
}

function assertBoundaryMatches(
  intent: TerminalUserSendIntent,
  input: TerminalUserSendIntentBoundary
): void {
  if (
    intent.terminal_runtime_key !== input.terminalRuntimeKey ||
    intent.message_id !== input.messageId
  ) {
    throw new TerminalUserSendIntentBoundaryConflictError(
      "terminal user-send intent identity does not match"
    );
  }
  if (intent.physical_token !== input.physicalToken) {
    throw new TerminalUserSendIntentBoundaryConflictError(
      "messageId is already reserved for a different physical terminal"
    );
  }
  if (intent.request_hash !== input.requestHash) {
    throw new TerminalUserSendIntentBoundaryConflictError(
      "messageId is already reserved for a different request hash"
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

function requiredDeliveryMode(
  value: unknown
): TerminalUserSendDeliveryMode {
  if (value !== "managed" && value !== "unmanaged") {
    throw new Error("terminal user-send delivery mode is invalid");
  }
  return value;
}

function syncSleep(milliseconds: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds
  );
}

function finalIntentPathDefinitelyAbsent(filePath: string): boolean | undefined {
  try {
    lstatSync(filePath);
    return false;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return true;
    }
    return undefined;
  }
}

function classifyIntentStorageError(
  error: unknown,
  filePath: string
): unknown {
  const definitelyAbsent = finalIntentPathDefinitelyAbsent(filePath);
  if (definitelyAbsent === true) return error;
  return new TerminalUserSendIntentUncertainError(
    `${definitelyAbsent === false ? "existing" : "possibly existing"} ` +
    `same-id terminal user-Send intent cannot be verified: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

/**
 * Store-independent global idempotency for one explicit physical-terminal
 * Send. The path is keyed only by host message id, so the same id cannot move
 * between explicit, delegated, or differently targeted terminal entry points.
 *
 * The caller owns the physical-terminal lock. A reserved record means the
 * previous managed or unmanaged attempt may have started input; only a
 * completed record is safe to replay as success. The request body is never
 * stored.
 */
export function createTerminalUserSendIntentRepository(
  options: TerminalUserSendIntentRepositoryOptions
): TerminalUserSendIntentRepository {
  const runtimeDir = path.resolve(options.runtimeDir);
  const intentsDir = path.join(runtimeDir, TERMINAL_USER_SEND_INTENTS_DIRECTORY);
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
    input: Pick<TerminalUserSendIntentBoundary, "messageId">
  ): string {
    const messageId = requiredString(input.messageId, "messageId");
    return path.join(
      intentsDir,
      `terminal-user-send-intent-${digest(messageId)}.json`
    );
  }

  function withMessageLock<Result>(
    messageId: string,
    operation: () => Result
  ): Result {
    const messageKey = digest(requiredString(messageId, "messageId"));
    if (heldMessages.has(messageKey)) {
      throw new TerminalUserSendIntentUncertainError(
        "terminal user-Send intent lock is already held"
      );
    }
    const filePath = pathFor({ messageId });
    let release: (() => void) | undefined;
    let operationStarted = false;
    try {
      ensureDirectory(path.dirname(filePath));
      release = acquireLock(`${filePath}.lock`);
      heldMessages.add(messageKey);
      operationStarted = true;
      return operation();
    } catch (error) {
      if (
        error instanceof TerminalUserSendIntentBoundaryConflictError ||
        error instanceof TerminalUserSendIntentUncertainError
      ) {
        throw error;
      }
      if (isRecord(error) && error.code === "LOCK_TIMEOUT") {
        throw new TerminalUserSendIntentUncertainError(
          `terminal user-Send intent lock is busy: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (operationStarted) throw error;
      throw classifyIntentStorageError(error, filePath);
    } finally {
      heldMessages.delete(messageKey);
      try {
        release?.();
      } catch {
        // Releasing a completed lock is cleanup, not Send authority. A stale
        // file is reclaimed by the normal owner/age protocol on a later call.
      }
    }
  }

  function load(
    input: TerminalUserSendIntentBoundary
  ): TerminalUserSendIntent | undefined {
    const filePath = pathFor(input);
    try {
      const intent = parseIntent(
        readJsonFileNoFollow(filePath, "terminal user-send intent")
      );
      assertBoundaryMatches(intent, input);
      return intent;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      if (
        error instanceof TerminalUserSendIntentBoundaryConflictError ||
        error instanceof TerminalUserSendIntentUncertainError
      ) {
        throw error;
      }
      throw classifyIntentStorageError(error, filePath);
    }
  }

  function save(intent: TerminalUserSendIntent): void {
    saveJson(pathFor({ messageId: intent.message_id }), intent, {
      rootLabel: "terminal user-send intent root",
      directoryLabel: "terminal user-send intent directory",
      fileLabel: "terminal user-send intent",
      ensureDirectory,
      fsyncNewRootParent: true,
      fsyncNewDirectoryParent: true
    });
  }

  function reserve(
    input: TerminalUserSendIntentBoundary
  ): TerminalUserSendIntentReserveResult {
    return withMessageLock(input.messageId, () => {
      const existing = load(input);
      if (existing?.stage === "enter_dispatched") {
        return {
          outcome: "replay",
          stage: existing.stage,
          intent: existing
        };
      }
      if (existing?.stage === "reserved") {
        return {
          outcome: "uncertain",
          stage: existing.stage,
          intent: existing
        };
      }
      const intent: TerminalUserSendIntent = {
        schema: TERMINAL_USER_SEND_INTENT_SCHEMA,
        version: TERMINAL_USER_SEND_INTENT_VERSION,
        terminal_runtime_key: requiredString(
          input.terminalRuntimeKey,
          "terminalRuntimeKey"
        ),
        physical_token: requiredString(input.physicalToken, "physicalToken"),
        message_id: requiredString(input.messageId, "messageId"),
        request_hash: requiredString(input.requestHash, "requestHash"),
        stage: "reserved",
        reserved_at: nowTimestamp(now)
      };
      save(intent);
      return { outcome: "reserved", intent };
    });
  }

  function complete(
    input: TerminalUserSendIntentBoundary,
    deliveryMode: TerminalUserSendDeliveryMode
  ): TerminalUserSendIntent {
    return withMessageLock(input.messageId, () => {
      const mode = requiredDeliveryMode(deliveryMode);
      const existing = load(input);
      if (!existing) {
        throw new Error(
          "terminal user-send intent must be reserved before completion"
        );
      }
      if (existing.stage === "enter_dispatched") {
        if (existing.delivery_mode !== mode) {
          throw new Error(
            "terminal user-send intent already completed in another mode"
          );
        }
        return existing;
      }
      const completed: TerminalUserSendIntent = {
        ...existing,
        stage: "enter_dispatched",
        enter_dispatched_at: nowTimestamp(now),
        delivery_mode: mode
      };
      save(completed);
      return completed;
    });
  }

  function cancelProvenZeroInput(
    input: TerminalUserSendIntentBoundary
  ): boolean {
    return withMessageLock(input.messageId, () => {
      const existing = load(input);
      if (!existing) return false;
      if (existing.stage === "zero_input_cancelled") return false;
      if (existing.stage === "enter_dispatched") {
        throw new Error(
          "a completed terminal user-send intent cannot be cancelled"
        );
      }
      save({
        ...existing,
        stage: "zero_input_cancelled",
        zero_input_cancelled_at: nowTimestamp(now)
      });
      return true;
    });
  }

  return { pathFor, load, reserve, cancelProvenZeroInput, complete };
}
