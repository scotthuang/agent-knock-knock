import fs from "node:fs";
import path from "node:path";
import { assertRealDirectory, atomicSaveJsonFile, isNodeError, readJsonFileNoFollow } from "./durable-json-file.js";
import { assertStoreReadable, ensureDir, withStoreWriterLease } from "./store.js";

export interface NativeDurableRecord { id: string; revision: number; created_at: string }
export interface NativeRecordRepository<T extends NativeDurableRecord> {
  load(id: string): T | undefined;
  list(): T[];
  scanForReconciliation(): { tasks: T[]; errors: { id: string; error_code: string }[] };
  save(record: T, expectedRevision: number | null): T;
  withLock<R>(id: string, operation: () => R): R;
}
function privatePath(file: string, directory: boolean): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Codex native state must be an owner-private regular " + (directory ? "directory" : "file"));
  }
}

/** Native task and response ledgers share atomic writes, private paths and CAS. */
export function createNativeRecordRepository<T extends NativeDurableRecord>(options: {
  storeDir: string; directory: string; prefix: string;
  acquire(lockPath: string): () => void;
  assert(value: unknown): asserts value is T;
  assertUpdate(previous: T, next: T): void;
}): NativeRecordRepository<T> {
  const root = path.join(options.storeDir, options.directory);
  const validId = new RegExp(`^${options.prefix}[a-zA-Z0-9_-]{8,128}$`);
  function statePath(id: string): string {
    if (!validId.test(id)) throw new Error("Invalid Codex native state ID");
    return path.join(root, `${id}.json`);
  }
  function load(id: string): T | undefined {
    const file = statePath(id);
    if (!fs.existsSync(options.storeDir)) return undefined;
    assertStoreReadable(options.storeDir);
    try {
      assertRealDirectory(root, "Codex native state"); privatePath(root, true); privatePath(file, false);
      const record = readJsonFileNoFollow(file, "Codex native state"); options.assert(record);
      if (record.id !== id) throw new Error("Codex native record filename identity mismatch");
      return record;
    } catch (error) { if (isNodeError(error, "ENOENT")) return undefined; throw error; }
  }
  function scan(isolate: boolean) {
    const result: { tasks: T[]; errors: { id: string; error_code: string }[] } = { tasks: [], errors: [] };
    if (!fs.existsSync(options.storeDir)) return result;
    assertStoreReadable(options.storeDir);
    if (!fs.existsSync(root)) return result;
    privatePath(root, true);
    for (const entry of fs.readdirSync(root)) {
      const file = path.join(root, entry);
      try { privatePath(file, false); } catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
      if (entry.endsWith(".json.lock") || entry.endsWith(".json.lock.reclaim") || entry.startsWith(".") && entry.endsWith(".tmp")) continue;
      if (!entry.endsWith(".json")) throw new Error("Unknown Codex native state file");
      const id = entry.slice(0, -5); statePath(id);
      try {
        const record = readJsonFileNoFollow(file, "Codex native state"); options.assert(record);
        if (record.id !== id) throw new Error("Codex native record filename identity mismatch");
        result.tasks.push(record);
      } catch (error) {
        if (!isolate || isNodeError(error, "EACCES") || isNodeError(error, "ELOOP")) throw error;
        result.errors.push({ id, error_code: "codex_native_record_invalid" });
      }
    }
    result.tasks.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return result;
  }
  return {
    load, list: () => scan(false).tasks, scanForReconciliation: () => scan(true),
    withLock: (id, operation) => withStoreWriterLease(options.storeDir, () => {
      const file = statePath(id); ensureDir(root); privatePath(root, true);
      const release = options.acquire(`${file}.lock`);
      try { return operation(); } finally { release(); }
    }),
    save: (record, revision) => withStoreWriterLease(options.storeDir, () => {
      const previous = load(record.id);
      if ((previous?.revision ?? null) !== revision) throw new Error("Codex native state revision conflict");
      if (previous) options.assertUpdate(previous, record);
      const saved = { ...record, revision: (revision ?? 0) + 1 }; options.assert(saved);
      atomicSaveJsonFile(statePath(saved.id), saved, {
        rootLabel: "AKK store", directoryLabel: "Codex native state", fileLabel: "Codex native record", ensureDirectory: ensureDir
      });
      return saved;
    })
  };
}
