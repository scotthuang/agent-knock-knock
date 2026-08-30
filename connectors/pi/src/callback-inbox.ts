import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CallbackRequest } from "./routes.js";

const INBOX_SCHEMA = "agent-knock-knock/pi-callback-inbox";
const INBOX_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

export type CallbackInboxState = "pending" | "delivered";

export interface CallbackInboxEntry extends CallbackRequest {
  readonly fingerprint: string;
  readonly acceptanceId: string;
  readonly state: CallbackInboxState;
  readonly acceptedAt: string;
  readonly deliveredAt?: string;
}

export type CallbackInboxAdmission =
  | {
    readonly disposition: "admitted" | "duplicate";
    readonly entry: CallbackInboxEntry;
  }
  | {
    readonly disposition: "collision";
  };

interface InboxDocument {
  readonly schema: typeof INBOX_SCHEMA;
  readonly version: typeof INBOX_VERSION;
  readonly entries: readonly CallbackInboxEntry[];
}

/**
 * A small, process-owned durable inbox for the last callback hop into Pi.
 *
 * `admit()` returns only after an atomic, fsync-backed file replacement. This
 * lets the callback helper acknowledge connector admission even though Pi's
 * `sendMessage()` API itself does not return an admission receipt.
 */
export class CallbackInbox {
  private entries: Map<string, CallbackInboxEntry>;
  private transactionTail: Promise<void> = Promise.resolve();
  private active = true;

  private readonly filePath: string;
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;

  constructor(options: {
    readonly filePath: string;
    readonly maxEntries?: number;
    readonly maxFileBytes?: number;
  }) {
    if (!path.isAbsolute(options.filePath)) {
      throw new Error("Pi callback inbox path must be absolute");
    }
    this.filePath = options.filePath;
    this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    );
    this.entries = loadInbox(this.filePath, this.maxEntries, this.maxFileBytes);
  }

  admit(request: CallbackRequest): Promise<CallbackInboxAdmission> {
    return this.withTransaction(async () => {
      const key = callbackKey(request.controllerId, request.idempotencyKey);
      const fingerprint = requestFingerprint(request);
      const previous = this.entries.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          return { disposition: "collision" };
        }
        return { disposition: "duplicate", entry: previous };
      }

      const entry: CallbackInboxEntry = Object.freeze({
        ...request,
        fingerprint,
        acceptanceId: `akk-pi-callback:${randomBytes(18).toString("base64url")}`,
        state: "pending",
        acceptedAt: new Date().toISOString(),
      });
      const next = new Map(this.entries);
      pruneDeliveredEntries(next, this.maxEntries - 1);
      if (next.size >= this.maxEntries) {
        throw new Error("Pi callback inbox is full");
      }
      next.set(key, entry);
      await persistInbox(this.filePath, next.values(), this.maxFileBytes);
      this.entries = next;
      return { disposition: "admitted", entry };
    });
  }

  markDelivered(entry: CallbackInboxEntry): Promise<CallbackInboxEntry> {
    return this.withTransaction(async () => {
      const key = callbackKey(entry.controllerId, entry.idempotencyKey);
      const current = this.entries.get(key);
      if (!current || current.fingerprint !== entry.fingerprint) {
        throw new Error("Pi callback inbox entry is no longer current");
      }
      if (current.state === "delivered") return current;

      const delivered: CallbackInboxEntry = Object.freeze({
        ...current,
        state: "delivered",
        deliveredAt: new Date().toISOString(),
      });
      const next = new Map(this.entries);
      next.set(key, delivered);
      await persistInbox(this.filePath, next.values(), this.maxFileBytes);
      this.entries = next;
      return delivered;
    });
  }

  listPending(controllerId?: string): Promise<readonly CallbackInboxEntry[]> {
    return this.withTransaction(() => Promise.resolve(
      [...this.entries.values()].filter((entry) =>
        entry.state === "pending" &&
        (controllerId === undefined || entry.controllerId === controllerId)
      ),
    ));
  }

  async close(): Promise<void> {
    await this.transactionTail;
    this.active = false;
  }

  private withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.transactionTail.then(() => {
      if (!this.active) throw new Error("Pi callback inbox is closed");
      return operation();
    });
    this.transactionTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function loadInbox(
  filePath: string,
  maxEntries: number,
  maxFileBytes: number,
): Map<string, CallbackInboxEntry> {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return new Map();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Pi callback inbox must be a regular file");
  }
  if (stat.size > maxFileBytes) {
    throw new Error("Pi callback inbox exceeded its size limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("Pi callback inbox is invalid");
  }
  if (!isInboxDocument(parsed)) {
    throw new Error("Pi callback inbox is invalid");
  }
  if (parsed.entries.length > maxEntries) {
    throw new Error("Pi callback inbox contains too many entries");
  }

  const entries = new Map<string, CallbackInboxEntry>();
  for (const candidate of parsed.entries) {
    const entry = validateInboxEntry(candidate);
    const key = callbackKey(entry.controllerId, entry.idempotencyKey);
    if (entries.has(key)) throw new Error("Pi callback inbox contains duplicate entries");
    entries.set(key, Object.freeze(entry));
  }
  return entries;
}

async function persistInbox(
  filePath: string,
  entries: Iterable<CallbackInboxEntry>,
  maxFileBytes: number,
): Promise<void> {
  const document: InboxDocument = {
    schema: INBOX_SCHEMA,
    version: INBOX_VERSION,
    entries: [...entries],
  };
  const body = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(body, "utf8") > maxFileBytes) {
    throw new Error("Pi callback inbox exceeded its size limit");
  }

  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporaryPath, filePath);
    await fs.promises.chmod(filePath, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      !isNodeError(error) ||
      !["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code ?? "")
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function pruneDeliveredEntries(
  entries: Map<string, CallbackInboxEntry>,
  targetSize: number,
): void {
  if (entries.size <= targetSize) return;
  const delivered = [...entries.entries()]
    .filter(([, entry]) => entry.state === "delivered")
    .sort((left, right) => left[1].acceptedAt.localeCompare(right[1].acceptedAt));
  for (const [key] of delivered) {
    if (entries.size <= targetSize) return;
    entries.delete(key);
  }
}

function requestFingerprint(request: CallbackRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([
      request.controllerId,
      request.deliveryId,
      request.messageId,
      request.idempotencyKey,
      request.body,
    ]))
    .digest("hex");
}

function callbackKey(controllerId: string, idempotencyKey: string): string {
  return `${controllerId}\u0000${idempotencyKey}`;
}

function isInboxDocument(value: unknown): value is InboxDocument {
  if (!isRecord(value)) return false;
  return value.schema === INBOX_SCHEMA &&
    value.version === INBOX_VERSION &&
    Array.isArray(value.entries) &&
    Object.keys(value).every((key) => ["schema", "version", "entries"].includes(key));
}

function validateInboxEntry(value: unknown): CallbackInboxEntry {
  if (!isRecord(value)) throw new Error("Pi callback inbox entry is invalid");
  const requiredStrings = [
    "controllerId",
    "deliveryId",
    "messageId",
    "idempotencyKey",
    "body",
    "fingerprint",
    "acceptanceId",
    "acceptedAt",
  ] as const;
  if (requiredStrings.some((key) => typeof value[key] !== "string")) {
    throw new Error("Pi callback inbox entry is invalid");
  }
  if (value.state !== "pending" && value.state !== "delivered") {
    throw new Error("Pi callback inbox entry is invalid");
  }
  if (value.deliveredAt !== undefined && typeof value.deliveredAt !== "string") {
    throw new Error("Pi callback inbox entry is invalid");
  }
  const allowedKeys = new Set([...requiredStrings, "state", "deliveredAt"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Pi callback inbox entry is invalid");
  }
  const entry = value as unknown as CallbackInboxEntry;
  if (
    !validIdentity(entry.controllerId) ||
    !validIdentity(entry.deliveryId) ||
    !validIdentity(entry.messageId) ||
    !validIdentity(entry.idempotencyKey) ||
    !/^[a-f0-9]{64}$/u.test(entry.fingerprint) ||
    !validIdentity(entry.acceptanceId) ||
    !validDate(entry.acceptedAt) ||
    (entry.state === "delivered" && !entry.deliveredAt) ||
    (entry.deliveredAt !== undefined && !validDate(entry.deliveredAt)) ||
    requestFingerprint(entry) !== entry.fingerprint
  ) {
    throw new Error("Pi callback inbox entry is invalid");
  }
  return entry;
}

function validIdentity(value: string): boolean {
  return value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Pi callback inbox ${name} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
