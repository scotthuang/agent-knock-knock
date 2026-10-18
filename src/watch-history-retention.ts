import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertCodexNativeTaskRecord } from "./codex-native-state-store.js";
import { assertClaudeNativeTaskRecord } from "./claude-native-state-store.js";
import { assertDesktopTaskRecord } from "./desktop-state-store.js";
import { assertTerminalWatch } from "./terminal-watch-codec.js";
import { TERMINAL_WATCHES_DIRECTORY, TERMINAL_WATCH_VERSION } from "./terminal-watch-record.js";
import { atomicSaveJsonFile, isNodeError, readJsonFileNoFollow } from "./durable-json-file.js";
import { assertStoreReadable, ensureDir, withStoreWriterLease } from "./store.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { recordValue } from "./value-guards.js";
import { WATCH_HISTORY_MAINTENANCE_BATCH, WATCH_HISTORY_MAINTENANCE_INTERVAL_MS,
  watchHistoryExpired, watchHistorySettledAt } from "./watch-history-policy.js";
import { assertPrivateHistoryPath, loadWatchHistoryReceipt, saveWatchHistoryReceipt,
  WATCH_HISTORY_RECEIPTS_DIRECTORY, type WatchHistoryProvider } from "./watch-history-receipt.js";

interface Provider {
  name: WatchHistoryProvider;
  directory: string;
  assert(value: unknown): void;
}
const PROVIDERS: Provider[] = [
  { name: "codex", directory: "codex-native-tasks", assert: assertCodexNativeTaskRecord },
  { name: "claude", directory: "claude-native-tasks", assert: assertClaudeNativeTaskRecord },
  { name: "desktop", directory: "desktop-tasks", assert: assertDesktopTaskRecord },
  { name: "terminal", directory: TERMINAL_WATCHES_DIRECTORY, assert: value => {
    if (recordValue(value)?.version !== TERMINAL_WATCH_VERSION) throw new Error("Legacy Watch history is retained");
    assertTerminalWatch(value);
  } }
];
interface MaintenanceState {
  schema: "agent-knock-knock/watch-history-maintenance";
  version: 1;
  last_run_at: string;
  cursor?: string;
}
export interface WatchHistoryMaintenanceResult {
  checked: number;
  deleted: number;
  skipped: number;
  errors: number;
  throttled: boolean;
}

function maintenancePath(storeDir: string): string {
  return path.join(storeDir, WATCH_HISTORY_RECEIPTS_DIRECTORY, "maintenance.json");
}
function loadMaintenance(storeDir: string): MaintenanceState | undefined {
  const file = maintenancePath(storeDir);
  try {
    assertPrivateHistoryPath(path.dirname(file), true); assertPrivateHistoryPath(file, false);
    const value = readJsonFileNoFollow(file, "Watch history maintenance") as MaintenanceState;
    if (value?.schema !== "agent-knock-knock/watch-history-maintenance" || value.version !== 1 ||
      !Number.isFinite(Date.parse(value.last_run_at)) || value.cursor !== undefined &&
      (typeof value.cursor !== "string" || value.cursor.length > 512)) throw new Error("Invalid Watch history maintenance state");
    return value;
  } catch (error) { if (isNodeError(error, "ENOENT")) return undefined; throw error; }
}
function entries(storeDir: string) {
  return PROVIDERS.flatMap(provider => {
    const directory = path.join(storeDir, provider.directory);
    try { assertPrivateHistoryPath(directory, true); }
    catch (error) { if (isNodeError(error, "ENOENT")) return []; throw error; }
    return fs.readdirSync(directory).filter(name => !name.startsWith(".") && name.endsWith(".json"))
      .map(name => ({ provider, name, key: `${provider.name}:${name}`, file: path.join(directory, name) }));
  }).sort((a, b) => a.key.localeCompare(b.key));
}

/** Bounded maintenance of AKK-owned healthy history. Never reads or mutates a native agent. */
export function collectExpiredWatchHistory(options: {
  storeDir: string;
  now?: Date;
  limit?: number;
  locks?: { acquire(file: string): () => void };
}): WatchHistoryMaintenanceResult {
  const result = { checked: 0, deleted: 0, skipped: 0, errors: 0, throttled: false };
  const now = options.now ?? new Date(), limit = options.limit ?? WATCH_HISTORY_MAINTENANCE_BATCH;
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid Watch maintenance bound");
  if (!fs.existsSync(options.storeDir)) return result;
  assertStoreReadable(options.storeDir);
  const previous = loadMaintenance(options.storeDir);
  if (previous && now.getTime() - Date.parse(previous.last_run_at) < WATCH_HISTORY_MAINTENANCE_INTERVAL_MS) {
    result.throttled = true; return result;
  }
  const adapter = createFileLockCliAdapter({ now: () => new Date(), nowMs: Date.now, pid: () => process.pid,
    sleepSync: () => { throw new Error("Watch maintenance never waits for an occupied record lock"); } });
  const locks = options.locks ?? { acquire: (file: string) => adapter.acquire(file, { timeoutMs: 0 }) };
  return withStoreWriterLease(options.storeDir, () => {
    // Persisted throttling and cursor also coordinate old/new plugin generations and independent processes.
    const state = loadMaintenance(options.storeDir);
    if (state && now.getTime() - Date.parse(state.last_run_at) < WATCH_HISTORY_MAINTENANCE_INTERVAL_MS) {
      result.throttled = true; return result;
    }
    const inventory = entries(options.storeDir);
    let remaining = state?.cursor ? inventory.filter(entry => entry.key.localeCompare(state.cursor!) > 0) : inventory;
    if (!remaining.length) remaining = inventory;
    const selected = remaining.slice(0, limit);
    for (const entry of selected) {
      result.checked++;
      let release: (() => void) | undefined;
      try {
        assertPrivateHistoryPath(entry.file, false);
        release = locks.acquire(`${entry.file}.lock`);
        // Re-read only after the same record lock used by observers and callback settlement.
        assertPrivateHistoryPath(entry.file, false);
        const record = readJsonFileNoFollow(entry.file, "Watch history");
        entry.provider.assert(record);
        const raw = recordValue(record)!;
        const id = String(raw.watch_id);
        if (entry.name !== `${id}.json`) throw new Error("Watch history filename identity mismatch");
        const fingerprint = createHash("sha256").update(JSON.stringify(record)).digest("hex");
        const existing = loadWatchHistoryReceipt(options.storeDir, entry.provider.name, id);
        if (existing && existing.record_sha256 !== fingerprint) throw new Error("Expired Watch body changed");
        if (!watchHistoryExpired(record, now)) { result.skipped++; continue; }
        saveWatchHistoryReceipt(options.storeDir, { schema: "agent-knock-knock/watch-history-receipt", version: 1,
          provider: entry.provider.name, watch_id: id, status: "completed", settled_at: watchHistorySettledAt(record)!,
          deleted_at: now.toISOString(), record_sha256: fingerprint });
        fs.unlinkSync(entry.file);
        const directoryFd = fs.openSync(path.dirname(entry.file), fs.constants.O_RDONLY);
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
        result.deleted++;
      } catch (error) {
        if (isNodeError(error, "ENOENT") || isNodeError(error, "LOCK_TIMEOUT")) result.skipped++;
        else result.errors++;
      } finally { release?.(); }
    }
    const cursor = selected.length && selected.length < remaining.length ? selected.at(-1)!.key : undefined;
    atomicSaveJsonFile(maintenancePath(options.storeDir), {
      schema: "agent-knock-knock/watch-history-maintenance", version: 1, last_run_at: now.toISOString(), ...(cursor ? { cursor } : {})
    } satisfies MaintenanceState, { rootLabel: "AKK Store", directoryLabel: "Watch history receipts", fileLabel: "Watch history maintenance",
      ensureDirectory: ensureDir, fsyncNewDirectoryParent: true });
    return result;
  });
}
