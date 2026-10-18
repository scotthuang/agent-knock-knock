import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicSaveJsonFile, isNodeError, readJsonFileNoFollow } from "./durable-json-file.js";
import { ensureDir } from "./store.js";

export type WatchHistoryProvider = "codex" | "claude" | "desktop" | "terminal";
export const WATCH_HISTORY_RECEIPTS_DIRECTORY = "watch-history-receipts";
export interface WatchHistoryReceipt {
  schema: "agent-knock-knock/watch-history-receipt";
  version: 1;
  provider: WatchHistoryProvider;
  watch_id: string;
  status: "completed";
  settled_at: string;
  deleted_at: string;
  record_sha256: string;
}

export class WatchHistoryExpiredError extends Error {
  readonly code = "watch_history_expired";
  readonly replay_forbidden = true;
  readonly history_state = "expired";
  readonly original_watch_id: string;
  readonly task_status = "completed";
  constructor(readonly receipt: WatchHistoryReceipt) {
    super(`[watch_history_expired] Watch history expired for ${receipt.watch_id}; the completed request must not be replayed.`);
    this.name = "WatchHistoryExpiredError";
    this.original_watch_id = receipt.watch_id;
  }
}

export function watchHistoryReceiptPath(storeDir: string, provider: WatchHistoryProvider, id: string): string {
  const key = createHash("sha256").update(`${provider}\0${id}`).digest("hex");
  return path.join(storeDir, WATCH_HISTORY_RECEIPTS_DIRECTORY, `${key}.json`);
}

export function assertPrivateHistoryPath(file: string, directory: boolean): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) {
    throw new Error("Watch history paths must be owner-private regular files or directories");
  }
}

export function loadWatchHistoryReceipt(storeDir: string, provider: WatchHistoryProvider, id: string): WatchHistoryReceipt | undefined {
  const file = watchHistoryReceiptPath(storeDir, provider, id);
  try {
    assertPrivateHistoryPath(path.dirname(file), true);
    assertPrivateHistoryPath(file, false);
    const receipt = readJsonFileNoFollow(file, "Watch history receipt") as WatchHistoryReceipt;
    if (receipt?.schema !== "agent-knock-knock/watch-history-receipt" || receipt.version !== 1 ||
      receipt.provider !== provider || receipt.watch_id !== id || receipt.status !== "completed" ||
      typeof receipt.settled_at !== "string" || typeof receipt.deleted_at !== "string" ||
      !Number.isFinite(Date.parse(receipt.settled_at)) || !Number.isFinite(Date.parse(receipt.deleted_at)) ||
      !/^[a-f0-9]{64}$/u.test(receipt.record_sha256)) throw new Error("Invalid Watch history receipt");
    return { schema: receipt.schema, version: receipt.version, provider, watch_id: id, status: receipt.status,
      settled_at: receipt.settled_at, deleted_at: receipt.deleted_at, record_sha256: receipt.record_sha256 };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function assertWatchHistoryNotExpired(storeDir: string, provider: WatchHistoryProvider, id: string): void {
  const receipt = loadWatchHistoryReceipt(storeDir, provider, id);
  if (receipt) throw new WatchHistoryExpiredError(receipt);
}

/** Caller holds Store writer + exact record lock; receipt must be durable before unlink. */
export function saveWatchHistoryReceipt(storeDir: string, receipt: WatchHistoryReceipt): void {
  const existing = loadWatchHistoryReceipt(storeDir, receipt.provider, receipt.watch_id);
  if (existing) {
    if (existing.record_sha256 !== receipt.record_sha256) throw new Error("Expired Watch body changed after its deletion receipt");
    return;
  }
  atomicSaveJsonFile(watchHistoryReceiptPath(storeDir, receipt.provider, receipt.watch_id), receipt, {
    rootLabel: "AKK Store", directoryLabel: "Watch history receipts", fileLabel: "Watch history receipt",
    ensureDirectory: ensureDir, fsyncNewDirectoryParent: true
  });
}
