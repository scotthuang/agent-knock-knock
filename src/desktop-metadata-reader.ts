import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { latestStateDbPath } from "./codex-sqlite-thread-query.js";

export type DesktopMetadataRow = Record<string, unknown>;
export type DesktopMetadataKind = "desktop_catalog" | "state";
export interface DesktopMetadataSource {
  database: string;
  codexHome: string;
  kind: DesktopMetadataKind;
  status: "ok" | "absent" | "error";
  rowCount?: number;
  pageCount?: number;
  columns?: string[];
  error?: string;
  snapshot?: "stable_copy";
}
export interface DesktopMetadataBatch {
  source: DesktopMetadataSource;
  rows: DesktopMetadataRow[];
  hosts?: Record<string, string>;
}
export type DesktopMetadataReader = (codexHome: string) => Promise<DesktopMetadataBatch[]>;
export type DesktopSnapshotQuery = (database: string, sql: string) => Promise<DesktopMetadataRow[]>;
export interface DesktopMetadataReaderOptions {
  querySnapshot?: DesktopSnapshotQuery;
  temporaryRoot?: string;
  maxRows?: number;
}
const PAGE_SIZE = 100;
const STATE_COLUMNS = [
  "id", "cwd", "title", "name", "updated_at", "updated_at_ms", "originator",
  "archived", "source", "thread_source", "project_id", "parent_thread_id",
  "is_pinned", "thread_section_id", "section_position", "recency_at_ms"
] as const;
const CATALOG_COLUMNS = [
  "host_id", "thread_id", "display_title", "cwd", "source_updated_at",
  "source_kind", "thread_source", "missing_candidate", "project_id"
] as const;

/** Reads metadata only. Original SQLite files are never opened by SQLite. */
export async function readDesktopMetadata(
  codexHome: string,
  options: DesktopMetadataReaderOptions = {}
): Promise<DesktopMetadataBatch[]> {
  const home = path.resolve(codexHome);
  const statePath = latestStateDbPath(home);
  const sources: Array<{ database: string; kind: DesktopMetadataKind }> = [
    { database: path.join(home, "sqlite", "codex.db"), kind: "desktop_catalog" },
    { database: path.join(home, "sqlite", "codex-dev.db"), kind: "desktop_catalog" },
    { database: statePath ?? path.join(home, "state_*.sqlite"), kind: "state" }
  ];
  const result: DesktopMetadataBatch[] = [];
  for (const source of sources) {
    const metadata: DesktopMetadataSource = { ...source, codexHome: home, status: "absent" };
    if (source.kind === "state" && !statePath) {
      result.push({ source: metadata, rows: [] });
      continue;
    }
    try {
      const batch = await withDesktopMetadataSnapshot(source.database, async (copy) => {
        const query = options.querySnapshot ?? queryDesktopSnapshot;
        const checks = await query(copy, "PRAGMA quick_check");
        if (checks.length !== 1 || Object.values(checks[0])[0] !== "ok") {
          throw new Error("Metadata snapshot failed SQLite quick_check");
        }
        return readSnapshot(copy, metadata, query, options.maxRows ?? 100_000);
      }, options.temporaryRoot);
      result.push(batch ?? { source: metadata, rows: [] });
    } catch (error) {
      result.push({ source: { ...metadata, status: "error", error: error instanceof Error ? error.message : String(error) }, rows: [] });
    }
  }
  return result;
}

async function readSnapshot(
  copy: string, source: DesktopMetadataSource, query: DesktopSnapshotQuery, maxRows: number
): Promise<DesktopMetadataBatch> {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error("Invalid metadata row limit");
  const isState = source.kind === "state";
  const table = isState ? "threads" : "local_thread_catalog";
  const columns = await schemaColumns(copy, table, query);
  const required = isState
    ? ["id", "cwd", "title", "archived", "source"]
    : ["host_id", "thread_id", "display_title", "cwd", "source_updated_at", "source_kind", "missing_candidate"];
  if (isState && !columns.includes("updated_at") && !columns.includes("updated_at_ms")) {
    throw new Error("Unsupported threads schema: missing update timestamp");
  }
  requireColumns(table, columns, required);
  const selected = selectedColumns(isState ? STATE_COLUMNS : CATALOG_COLUMNS, columns);
  // Archived metadata is needed to reject stale sidebar assignments and pins.
  // Content/history tables are never read; the catalog filters these rows later.
  const predicate = isState ? "1 = 1" : "missing_candidate = 0";
  const order = isState ? "id" : "host_id, thread_id";
  const { rows, pageCount } = await scanSnapshotRows(copy, query, { table, selected, predicate, order, maxRows });
  const hosts = isState ? Object.create(null) : await readCatalogHosts(copy, query);
  return { source: { ...source, status: "ok", rowCount: rows.length, pageCount, columns, snapshot: "stable_copy" }, rows, hosts };
}

function selectedColumns(wanted: readonly string[], available: string[]): string {
  return wanted.map((column) => {
    if (!available.includes(column)) return `NULL AS "${column}"`;
    if (["title", "name", "display_title"].includes(column)) return `substr("${column}",1,160) AS "${column}"`;
    return `"${column}"`;
  }).join(", ");
}

async function scanSnapshotRows(copy: string, query: DesktopSnapshotQuery,
  { table, selected, predicate, order, maxRows }: {
    table: string; selected: string; predicate: string; order: string; maxRows: number;
  }): Promise<{ rows: DesktopMetadataRow[]; pageCount: number }> {
  const counts = await query(copy, `SELECT count(*) AS count FROM "${table}" WHERE ${predicate}`);
  const count = counts[0]?.count;
  if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > maxRows) {
    throw new Error(`Metadata row count is invalid or exceeds ${maxRows}; discovery is incomplete`);
  }
  const rows: DesktopMetadataRow[] = [];
  let pageCount = 0;
  while (rows.length < Number(count)) {
    const page = await query(copy,
      `SELECT ${selected} FROM "${table}" WHERE ${predicate} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${rows.length}`);
    if (page.length === 0 || page.length > PAGE_SIZE) throw new Error("Metadata page count mismatch");
    rows.push(...page);
    pageCount += 1;
  }
  if (rows.length !== count) throw new Error("Metadata scan count mismatch");
  return { rows, pageCount };
}

async function readCatalogHosts(copy: string, query: DesktopSnapshotQuery): Promise<Record<string, string>> {
  const hosts: Record<string, string> = Object.create(null);
  const hostColumns = await schemaColumns(copy, "local_thread_catalog_hosts", query);
  requireColumns("local_thread_catalog_hosts", hostColumns, ["host_id", "host_kind"]);
  for (const row of await query(copy, "SELECT host_id, host_kind FROM local_thread_catalog_hosts")) {
    if (typeof row.host_id !== "string" || typeof row.host_kind !== "string") throw new Error("Invalid catalog host metadata");
    hosts[row.host_id] = row.host_kind;
  }
  return hosts;
}

async function schemaColumns(copy: string, table: string, query: DesktopSnapshotQuery): Promise<string[]> {
  return (await query(copy, `PRAGMA table_info("${table}")`)).map((row) => String(row.name));
}
function requireColumns(table: string, actual: string[], required: string[]): void {
  const missing = required.filter((column) => !actual.includes(column));
  if (missing.length) throw new Error(`Unsupported ${table} schema: missing ${missing.join(", ")}`);
}
async function signature(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file, { bigint: true });
    if (!stat.isFile()) throw new Error("Metadata path is not a regular file");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Sequential DB/WAL copy with stat guards, not an atomic SQLite backup. */
export async function withDesktopMetadataSnapshot<T>(
  database: string, read: (copy: string) => Promise<T>, temporaryRoot = os.tmpdir()
): Promise<T | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const files = [database, `${database}-wal`];
    const before = await Promise.all(files.map(signature));
    if (before[0] === null) return undefined;
    const directory = await fs.mkdtemp(path.join(temporaryRoot, "akk-desktop-metadata-"));
    try {
      await fs.chmod(directory, 0o700);
      const copy = path.join(directory, path.basename(database));
      for (let index = 0; index < files.length; index += 1) {
        if (before[index] === null) continue;
        const destination = `${copy}${index === 0 ? "" : "-wal"}`;
        await fs.copyFile(files[index], destination);
        await fs.chmod(destination, 0o600);
      }
      const after = await Promise.all(files.map(signature));
      if (before.some((value, index) => value !== after[index])) continue;
      return await read(copy);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  throw new Error("Metadata database/WAL changed during every snapshot attempt");
}

export function queryDesktopSnapshot(database: string, sql: string): Promise<DesktopMetadataRow[]> {
  return new Promise((resolve, reject) => {
    execFile("sqlite3", ["-batch", "-bail", "-readonly", "-json", "-cmd", "PRAGMA query_only=ON", database, sql], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 10 * 1024 * 1024
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`SQLite metadata query failed (${error.code ?? "unknown"})`));
        return;
      }
      try {
        const rows: unknown = stdout.trim() ? JSON.parse(stdout) : [];
        if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
          throw new Error("SQLite metadata output is not an array of records");
        }
        resolve(rows);
      } catch (error) { reject(error); }
    });
  });
}
