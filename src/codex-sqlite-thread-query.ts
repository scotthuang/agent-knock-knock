import {
  spawn
} from "node:child_process";
import {
  randomUUID
} from "node:crypto";
import fs from "node:fs";

import path from "node:path";
import {
  pathToFileURL
} from "node:url";

import {
  type CodexThreadRow
} from "./codex-session-provider.js";

/** SQLite command protocol and file-stability evidence; no terminal identity inference. */
export type CodexSqliteOpenMode = "readonly" | "query_only";

export interface CodexSqliteThreadQueryRequest {
  dbPath: string;
  openMode: CodexSqliteOpenMode;
  maxSessions: number;
  nativeThreadId?: string;
  filters?: CodexThreadQueryFilters;
  afterSchema?: (columns: readonly string[]) => void | Promise<void>;
}

export interface CodexThreadQueryFilters {
  cwd?: string;
  source?: string;
  archived?: boolean;
  modelProvider?: string;
  historyMode?: string;
}

export interface CodexSqliteThreadQueryResult {
  columns: string[];
  rows: CodexThreadRow[];
}

export type CodexSqliteThreadQueryRunner = (
  request: CodexSqliteThreadQueryRequest
) => Promise<CodexSqliteThreadQueryResult>;

export const NATIVE_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const MAX_SQLITE_QUERY_OUTPUT_BYTES = 10 * 1024 * 1024;

export const MAX_SQLITE_ERROR_OUTPUT_BYTES = 1024 * 1024;

export const SQLITE_QUERY_TIMEOUT_MS = 10_000;

export interface CodexSqliteFileIdentity {
  path: string;
  exists: boolean;
  kind?: "file" | "directory" | "other";
  device?: string;
  inode?: string;
  size?: number;
  mtimeMs?: number;
  errorCode?: string;
}

export interface CodexSqliteFilesSnapshot {
  dbPath: string;
  main: CodexSqliteFileIdentity;
  wal: CodexSqliteFileIdentity;
  shm: CodexSqliteFileIdentity;
}

export interface CodexSqliteQueryFailure {
  dbPath: string;
  stage: string;
  status: number | null;
  detail: string;
  files: CodexSqliteFilesSnapshot;
  previousFailure?: CodexSqliteQueryFailure;
}

export class CodexSqliteSessionError extends Error {
  readonly status: number | null;
  readonly stage: string;

  constructor({
    message,
    status,
    stage
  }: {
    message: string;
    status: number | null;
    stage: string;
  }) {
    super(message);
    this.name = "CodexSqliteSessionError";
    this.status = status;
    this.stage = stage;
  }
}

export async function runCodexSqliteThreadQuery(
  request: CodexSqliteThreadQueryRequest
): Promise<CodexSqliteThreadQueryResult> {
  if (request.nativeThreadId && request.filters) {
    throw new Error("Codex thread query cannot combine an exact UUID with lifecycle filters");
  }
  if (
    request.nativeThreadId &&
    !NATIVE_THREAD_ID_PATTERN.test(request.nativeThreadId)
  ) {
    throw new Error("Codex thread lookup requires an exact UUID");
  }
  if (request.filters?.cwd && !path.isAbsolute(request.filters.cwd)) {
    throw new Error("Codex lifecycle thread query requires an absolute cwd");
  }
  const nonce = randomUUID();
  const controlColumn = "__akk_sqlite_control";
  const schemaControl = `schema:${nonce}`;
  const rowsControl = `rows:${nonce}`;
  const schemaMarker = JSON.stringify([{ [controlColumn]: schemaControl }]);
  const rowsMarker = JSON.stringify([{ [controlColumn]: rowsControl }]);
  const databaseArgument = request.openMode === "query_only"
    ? sqliteReadWriteUri(request.dbPath)
    : request.dbPath;
  const args = ["-batch", "-bail", "-json"];
  if (request.openMode === "readonly") {
    args.push("-readonly");
  }
  const parameterCommands = sqliteThreadFilterParameterCommands(request.filters);
  for (const command of parameterCommands) {
    args.push("-cmd", command);
  }
  if (request.openMode === "query_only") {
    // SQLite may materialize WAL/SHM bookkeeping on this mode=rw connection,
    // while query_only forbids business SQL writes for the AKK session.
    // Parameter initialization, when needed, only creates a TEMP table and
    // must precede query_only because SQLite also applies it to TEMP writes.
    args.push("-cmd", "PRAGMA query_only=ON");
  }
  args.push(databaseArgument);

  return new Promise<CodexSqliteThreadQueryResult>((resolve, reject) => {
    const child = spawn("sqlite3", args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let phase: "schema" | "schema_hook" | "rows" | "complete" = "schema";
    let output = "";
    let stderr = "";
    let result: CodexSqliteThreadQueryResult | undefined;
    let authoritativeColumns: string[] = [];
    let terminalError: Error | undefined;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!terminalError) {
        terminalError = new CodexSqliteSessionError({
          message: `sqlite3 thread query timed out after ${SQLITE_QUERY_TIMEOUT_MS}ms`,
          status: null,
          stage: phase
        });
      }
      child.kill("SIGKILL");
    }, SQLITE_QUERY_TIMEOUT_MS);

    const stopWithError = (error: Error): void => {
      if (!terminalError) {
        terminalError = error instanceof CodexSqliteSessionError
          ? error
          : new CodexSqliteSessionError({
            message: error.message,
            status: null,
            stage: phase
          });
      }
      child.kill("SIGKILL");
    };
    const appendOutput = (current: string, chunk: string, limit: number): string => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > limit) {
        throw new Error(`sqlite3 ${phase} output exceeded ${limit} bytes`);
      }
      return next;
    };
    const parseArray = <T>(text: string, label: string): T[] => {
      if (!text.trim()) {
        return [];
      }
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error(`sqlite3 ${label} output was not a JSON array`);
      }
      return parsed as T[];
    };
    const writeRowsQuery = (columns: string[]): void => {
      validateCodexThreadColumns(columns);
      authoritativeColumns = columns;
      const sql = request.nativeThreadId
        ? buildThreadByIdSelect(columns, request.nativeThreadId)
        : buildThreadSelect(columns, request.maxSessions, request.filters);
      phase = "rows";
      child.stdin.write(
        `${sql};\nselect '${rowsControl}' as "${controlColumn}";\n`
      );
    };
    const consumeOutput = (): void => {
      if (phase === "schema") {
        const markerIndex = output.indexOf(schemaMarker);
        if (markerIndex < 0) {
          return;
        }
        const schema = parseArray<{ name?: unknown }>(
          output.slice(0, markerIndex).trim(),
          "schema"
        );
        const columns = schema
          .map((column) => typeof column.name === "string" ? column.name : "")
          .filter(Boolean);
        output = output.slice(markerIndex + schemaMarker.length).trimStart();
        phase = "schema_hook";
        void Promise.resolve(request.afterSchema?.(columns))
          .then(() => writeRowsQuery(columns))
          .catch((error) => stopWithError(
            error instanceof Error ? error : new Error(String(error))
          ));
      }
      if (phase === "rows") {
        const markerIndex = output.indexOf(rowsMarker);
        if (markerIndex < 0) {
          return;
        }
        const rows = parseArray<CodexThreadRow>(
          output.slice(0, markerIndex).trim(),
          "rows"
        );
        result = {
          columns: authoritativeColumns,
          rows
        };
        phase = "complete";
        child.stdin.end("COMMIT;\n.quit\n");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      try {
        output = appendOutput(output, chunk, MAX_SQLITE_QUERY_OUTPUT_BYTES);
        consumeOutput();
      } catch (error) {
        stopWithError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      try {
        stderr = appendOutput(stderr, chunk, MAX_SQLITE_ERROR_OUTPUT_BYTES);
      } catch (error) {
        stopWithError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("error", (error) => {
      if (!terminalError) {
        terminalError = new CodexSqliteSessionError({
          message: error.message,
          status: null,
          stage: phase
        });
      }
    });
    child.stdin.on("error", (error) => {
      if (!terminalError && phase !== "complete") {
        terminalError = error;
      }
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      if (terminalError) {
        reject(terminalError);
        return;
      }
      if (status !== 0) {
        reject(new CodexSqliteSessionError({
          message: stderr.trim() || `sqlite3 exited with status ${status ?? "unknown"}`,
          status,
          stage: phase
        }));
        return;
      }
      if (!result || phase !== "complete") {
        reject(new CodexSqliteSessionError({
          message: "sqlite3 exited before the thread query protocol completed",
          status,
          stage: phase
        }));
        return;
      }
      resolve(result);
    });

    child.stdin.write(
      `BEGIN;\npragma table_info(threads);\n` +
      `select '${schemaControl}' as "${controlColumn}";\n`
    );
  });
}

export function validateCodexThreadQueryResult(
  result: CodexSqliteThreadQueryResult
): CodexThreadRow[] {
  validateCodexThreadColumns(result.columns);
  return result.columns.includes("history_mode")
    ? result.rows.map((row) => ({ ...row, history_mode: row.history_mode ?? null }))
    : result.rows;
}

export function validateCodexThreadColumns(columns: readonly string[]): void {
  if (!columns.includes("id") || !columns.includes("cwd")) {
    throw new Error("Codex threads table is missing required id or cwd columns");
  }
}

export function sqliteReadWriteUri(dbPath: string): string {
  const uri = pathToFileURL(path.resolve(dbPath));
  uri.searchParams.set("mode", "rw");
  return uri.href;
}

export function inspectCodexSqliteFiles(dbPath: string): CodexSqliteFilesSnapshot {
  return {
    dbPath: path.resolve(dbPath),
    main: inspectCodexSqliteFile(dbPath),
    wal: inspectCodexSqliteFile(`${dbPath}-wal`),
    shm: inspectCodexSqliteFile(`${dbPath}-shm`)
  };
}

export function inspectCodexSqliteFile(filePath: string): CodexSqliteFileIdentity {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: path.resolve(filePath),
      exists: true,
      kind: stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "directory"
          : "other",
      device: String(stat.dev),
      inode: String(stat.ino),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
    return {
      path: path.resolve(filePath),
      exists: false,
      ...(code ? { errorCode: code } : {})
    };
  }
}

export function assertStableCodexSqliteMain({
  baseline,
  current,
  stage,
  selectedPath = current.dbPath
}: {
  baseline: CodexSqliteFilesSnapshot;
  current: CodexSqliteFilesSnapshot;
  stage: string;
  selectedPath?: string;
}): void {
  const samePath = Boolean(
    selectedPath &&
    path.resolve(selectedPath) === baseline.dbPath &&
    current.dbPath === baseline.dbPath
  );
  const sameFile = Boolean(
    baseline.main.exists &&
    baseline.main.kind === "file" &&
    current.main.exists &&
    current.main.kind === "file" &&
    baseline.main.device === current.main.device &&
    baseline.main.inode === current.main.inode
  );
  if (samePath && sameFile) {
    return;
  }
  throw new Error(
    `Codex SQLite main database changed during ${stage}; refusing stale ` +
    `thread discovery (selected_db=${selectedPath ?? "missing"}, ` +
    `baseline_db=${baseline.dbPath}, current_db=${current.dbPath}; ` +
    `${formatCodexSqliteFiles(current)})`
  );
}

export function codexSqliteQueryFailure(
  error: unknown,
  context: {
    dbPath: string;
    stage: string;
    files: CodexSqliteFilesSnapshot;
    previousFailure?: CodexSqliteQueryFailure;
  }
): CodexSqliteQueryFailure {
  const errorRecord = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
  const reportedStatus = typeof errorRecord?.status === "number"
    ? errorRecord.status
    : null;
  const reportedStage = typeof errorRecord?.stage === "string"
    ? errorRecord.stage
    : undefined;
  return {
    dbPath: path.resolve(context.dbPath),
    stage: reportedStage
      ? `${context.stage}:${reportedStage}`
      : context.stage,
    status: reportedStatus !== null && Number.isInteger(reportedStatus)
      ? reportedStatus
      : null,
    detail: error instanceof Error ? error.message : String(error),
    files: context.files,
    previousFailure: context.previousFailure
  };
}

export function isSqliteCantOpen(failure: CodexSqliteQueryFailure): boolean {
  return failure.status === 14 ||
    /(?:SQLITE_CANTOPEN|unable to open database file|\(14\))/iu.test(
      failure.detail
    );
}

export function codexSqliteQueryDiagnosticError(
  failure: CodexSqliteQueryFailure
): Error {
  const prior = failure.previousFailure
    ? `; previous=[stage=${failure.previousFailure.stage},status=` +
      `${failure.previousFailure.status ?? "unknown"},` +
      `${formatCodexSqliteFiles(failure.previousFailure.files)}]`
    : "";
  return new Error(
    `Codex SQLite thread query failed ` +
    `(stage=${failure.stage}, db=${failure.dbPath}, ` +
    `status=${failure.status ?? "unknown"}${prior}; ` +
    `${formatCodexSqliteFiles(failure.files)}): ` +
    failure.detail.replace(/\s+/gu, " ").trim()
  );
}

export function formatCodexSqliteFiles(snapshot: CodexSqliteFilesSnapshot): string {
  return [
    ["main", snapshot.main],
    ["wal", snapshot.wal],
    ["shm", snapshot.shm]
  ].map(([label, value]) => {
    const file = value as CodexSqliteFileIdentity;
    if (!file.exists) {
      return `${label}=missing${file.errorCode ? `(${file.errorCode})` : ""}`;
    }
    return `${label}=${file.kind}(dev=${file.device},ino=${file.inode},` +
      `size=${file.size},mtime_ms=${Math.trunc(file.mtimeMs ?? 0)})`;
  }).join(" ");
}

export function latestStateDbPath(codexHome: string): string | undefined {
  if (!fs.existsSync(codexHome)) {
    return undefined;
  }

  return fs.readdirSync(codexHome)
    .filter((entry) => /^state_\d+\.sqlite$/u.test(entry))
    .map((entry) => path.join(codexHome, entry))
    .flatMap((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? [{ filePath, mtimeMs: stat.mtimeMs }] : [];
      } catch {
        // Codex may rotate a versioned state database while discovery is
        // enumerating it. The caller will re-resolve and validate identity.
        return [];
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.filePath;
}

export function buildThreadSelect(
  columns: string[],
  limit: number,
  filters: CodexThreadQueryFilters = {}
): string {
  const columnSet = new Set(columns);
  const updatedAtExpression = columnSet.has("updated_at_ms")
    ? "updated_at_ms"
    : columnSet.has("updated_at")
      ? "updated_at * 1000"
      : "0";
  const select = [
    "id",
    "cwd",
    columnSet.has("rollout_path") ? "rollout_path" : "null as rollout_path",
    columnSet.has("title") ? "title" : "null as title",
    columnSet.has("preview") ? "preview" : "null as preview",
    columnSet.has("first_user_message") ? "first_user_message" : "null as first_user_message",
    columnSet.has("updated_at_ms") ? "updated_at_ms" : columnSet.has("updated_at") ? "updated_at * 1000 as updated_at_ms" : "null as updated_at_ms",
    columnSet.has("archived") ? "archived" : "0 as archived",
    columnSet.has("source") ? "source" : "null as source",
    columnSet.has("model_provider") ? "model_provider" : "null as model_provider",
    columnSet.has("cli_version") ? "cli_version" : "null as cli_version",
    columnSet.has("name") ? "name" : "null as name",
    columnSet.has("history_mode") ? "history_mode" : "'legacy' as history_mode"
  ].join(", ");

  const predicates: string[] = [];
  if (filters.cwd !== undefined) {
    predicates.push("cwd collate binary = :akk_cwd");
  }
  if (filters.source !== undefined) {
    predicates.push(columnSet.has("source")
      ? "source collate binary = :akk_source"
      : "0 = 1");
  }
  if (filters.archived !== undefined) {
    if (columnSet.has("archived")) {
      predicates.push(`archived = ${filters.archived ? "1" : "0"}`);
    } else if (filters.archived) {
      predicates.push("0 = 1");
    }
  }
  if (filters.modelProvider !== undefined) {
    predicates.push(columnSet.has("model_provider")
      ? "model_provider collate binary = :akk_model_provider"
      : "0 = 1");
  }
  if (filters.historyMode !== undefined) {
    if (columnSet.has("history_mode")) {
      predicates.push("history_mode collate binary = :akk_history_mode");
    } else if (filters.historyMode !== "legacy") {
      predicates.push("0 = 1");
    }
  }
  const where = predicates.length > 0
    ? ` where ${predicates.join(" and ")}`
    : "";

  const deterministicTieBreak = predicates.length > 0 ? ", id desc" : "";
  return `select ${select} from threads${where} order by ${updatedAtExpression} desc${deterministicTieBreak} limit ${Math.max(1, Math.floor(limit))}`;
}

export function sqliteThreadFilterParameterCommands(
  filters: CodexThreadQueryFilters | undefined
): string[] {
  if (!filters) {
    return [];
  }
  const values: Array<[string, string | undefined]> = [
    ["akk_cwd", filters.cwd],
    ["akk_source", filters.source],
    ["akk_model_provider", filters.modelProvider],
    ["akk_history_mode", filters.historyMode]
  ];
  const present = values.filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  );
  if (present.length === 0) {
    return [];
  }
  return [
    ".parameter init",
    ...present.map(([name, value]) => {
      const hex = Buffer.from(value, "utf8").toString("hex");
      return `.parameter set :${name} "CAST(X'${hex}' AS TEXT)"`;
    })
  ];
}

export function buildThreadByIdSelect(
  columns: string[],
  nativeThreadId: string
): string {
  if (!NATIVE_THREAD_ID_PATTERN.test(nativeThreadId)) {
    throw new Error("Codex thread lookup requires an exact UUID");
  }
  const base = buildThreadSelect(columns, 1);
  return base.replace(
    " from threads order by ",
    ` from threads where id = '${nativeThreadId.toLowerCase()}' order by `
  );
}
