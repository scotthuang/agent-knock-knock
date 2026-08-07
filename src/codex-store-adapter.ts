import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ActiveAgentSessionIdentity } from "./agent-session-provider.js";
import {
  codexLifecycleBehaviorProfile,
  supportedCodexLifecycleVersions
} from "./codex-lifecycle-compatibility.js";
import { discoverCodexProcesses, type CodexProcessSnapshot, type CodexThreadRow } from "./codex-session-provider.js";
import type { CodexLocalSessionAdapter } from "./codex-local-session-provider.js";
import type {
  TerminalThreadLifecycleCandidate,
  TerminalThreadLifecycleCandidateProvider,
  TerminalThreadLifecycleCandidateRequest,
  TerminalThreadLifecycleCandidateToken,
  TerminalThreadLifecycleCandidateValidation,
  TerminalThreadFileToken
} from "./terminal-agent-adapter.js";
import {
  SystemTerminalProcessSource,
  runProcessCommand,
  type ProcessCommandResult
} from "./terminal-process-source.js";

export {
  parseLsofCwdMap,
  parsePsProcessSnapshots,
  type ProcessCommandResult as CommandResult
} from "./terminal-process-source.js";

export interface CodexStoreAdapterOptions {
  codexHome?: string;
  runCommand?: (command: string, args: string[]) => ProcessCommandResult;
  runSqliteThreadQuery?: CodexSqliteThreadQueryRunner;
  sqliteCantOpenRetryDelaysMs?: readonly number[];
  sleep?: (milliseconds: number) => Promise<void>;
  maxSessions?: number;
}

export type CodexSqliteOpenMode = "readonly" | "query_only";

export interface CodexSqliteThreadQueryRequest {
  dbPath: string;
  openMode: CodexSqliteOpenMode;
  maxSessions: number;
  nativeThreadId?: string;
  afterSchema?: (columns: readonly string[]) => void | Promise<void>;
}

export interface CodexSqliteThreadQueryResult {
  columns: string[];
  rows: CodexThreadRow[];
}

export type CodexSqliteThreadQueryRunner = (
  request: CodexSqliteThreadQueryRequest
) => Promise<CodexSqliteThreadQueryResult>;

interface CodexLifecycleThreadRow extends CodexThreadRow {
  source?: string;
  model_provider?: string;
  cli_version?: string;
  name?: string;
}

const NATIVE_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_CODEX_SESSION_META_BYTES = 1024 * 1024;
const MAX_SQLITE_QUERY_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_SQLITE_ERROR_OUTPUT_BYTES = 1024 * 1024;
const SQLITE_QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_SQLITE_CANTOPEN_RETRY_DELAYS_MS = [25, 75, 150] as const;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;

export class CodexStoreAdapter implements
  CodexLocalSessionAdapter,
  TerminalThreadLifecycleCandidateProvider {
  private readonly codexHome: string;
  private readonly runCommand: (command: string, args: string[]) => ProcessCommandResult;
  private readonly runSqliteThreadQuery: CodexSqliteThreadQueryRunner;
  private readonly sqliteCantOpenRetryDelaysMs: readonly number[];
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxSessions: number;

  constructor(options: CodexStoreAdapterOptions = {}) {
    this.codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
    this.runCommand = options.runCommand ?? runProcessCommand;
    this.runSqliteThreadQuery = options.runSqliteThreadQuery ??
      runCodexSqliteThreadQuery;
    this.sqliteCantOpenRetryDelaysMs =
      options.sqliteCantOpenRetryDelaysMs ??
      DEFAULT_SQLITE_CANTOPEN_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? waitForMilliseconds;
    this.maxSessions = options.maxSessions ?? 100;
  }

  async listThreadRows(): Promise<CodexThreadRow[]> {
    return this.queryThreadRows({ maxSessions: this.maxSessions });
  }

  async listThreadLifecycleCandidates(
    request: TerminalThreadLifecycleCandidateRequest
  ): Promise<TerminalThreadLifecycleCandidate[]> {
    assertCodexLifecycleCandidateRequest(request);
    const candidates: TerminalThreadLifecycleCandidate[] = [];
    for (const row of await this.listThreadRows() as CodexLifecycleThreadRow[]) {
      try {
        const candidate = codexLifecycleCandidateFromRow({
          row,
          codexHome: this.codexHome,
          request
        });
        if (candidate) {
          candidates.push(candidate);
        }
      } catch {
        // Historical rows are untrusted discovery input. Unsafe or unstable rows
        // are hidden and can never become resume targets.
      }
    }
    return candidates.sort((left, right) =>
      Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0)
    );
  }

  async revalidateThreadLifecycleCandidate(
    candidate: TerminalThreadLifecycleCandidate | TerminalThreadLifecycleCandidateToken,
    request: TerminalThreadLifecycleCandidateRequest
  ): Promise<TerminalThreadLifecycleCandidateValidation> {
    try {
      assertCodexLifecycleCandidateRequest(request);
      const token = "candidateToken" in candidate
        ? candidate.candidateToken
        : candidate;
      if (
        token.schema !== "agent-knock-knock/thread-candidate-token" ||
        token.version !== 1 ||
        token.agent !== "codex" ||
        token.source !== "codex_rollout" ||
        token.agentVersion !== request.agentVersion ||
        !path.isAbsolute(token.cwd) ||
        path.resolve(token.cwd) !== path.resolve(request.cwd) ||
        !NATIVE_THREAD_ID_PATTERN.test(token.nativeThreadId)
      ) {
        return {
          status: "unsafe",
          reason: "candidate is not an exact Codex root-thread identity"
        };
      }
      const row = await this.getThreadRow(token.nativeThreadId);
      if (!row) {
        return {
          status: "unavailable",
          reason: "the Codex thread row no longer exists"
        };
      }
      const current = codexLifecycleCandidateFromRow({
        row,
        codexHome: this.codexHome,
        request
      });
      if (!current) {
        return {
          status: "unavailable",
          reason: "the Codex thread is no longer a resumable root CLI session"
        };
      }
      if (
        !sameThreadFileToken(current.fileToken, token.fileToken) ||
        current.metadataFingerprint !== token.metadataFingerprint ||
        current.modelProvider !== token.modelProvider
      ) {
        return {
          status: "changed",
          candidate: current,
          reason: "the Codex rollout changed after candidate discovery"
        };
      }
      return { status: "valid", candidate: current };
    } catch (error) {
      return {
        status: "unsafe",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async getThreadRow(
    nativeThreadId: string
  ): Promise<CodexLifecycleThreadRow | undefined> {
    if (!NATIVE_THREAD_ID_PATTERN.test(nativeThreadId)) {
      throw new Error("Codex thread lookup requires an exact UUID");
    }
    return (await this.queryThreadRows({
      maxSessions: 1,
      nativeThreadId
    }) as CodexLifecycleThreadRow[])[0];
  }

  async readRollout(rolloutPath: string): Promise<string | undefined> {
    if (!fs.existsSync(rolloutPath)) {
      return undefined;
    }

    return fs.readFileSync(rolloutPath, "utf8");
  }

  async listProcessSnapshots(): Promise<CodexProcessSnapshot[]> {
    return new SystemTerminalProcessSource({ runCommand: this.runCommand })
      .listProcessSnapshots((snapshot) => discoverCodexProcesses([snapshot]).length > 0);
  }

  async resolveActiveSessionIdentityForPid(
    pid: number,
    cwd?: string,
    preferredSessionId?: string,
    allowedCompanionIdentity?: ActiveAgentSessionIdentity,
    allowedAdditionalIdentities?: readonly ActiveAgentSessionIdentity[]
  ): Promise<ActiveAgentSessionIdentity | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error("Codex process pid must be a positive integer greater than 1");
    }
    const birthResult = this.runCommand("ps", ["-o", "lstart=", "-p", String(pid)]);
    const processBirth = birthResult.stdout.trim();
    if (birthResult.status !== 0 || !processBirth) {
      throw new Error(
        birthResult.stderr || birthResult.error?.message ||
        `could not inspect start time for Codex process ${pid}`
      );
    }
    const result = this.runCommand("lsof", [
      "-a",
      "-p",
      String(pid),
      "-FnfDit"
    ]);
    if (result.status !== 0) {
      throw new Error(
        result.stderr || result.error?.message ||
        `could not inspect open rollout files for Codex process ${pid}`
      );
    }
    return resolveCodexOpenRolloutIdentity({
      codexHome: this.codexHome,
      pid,
      cwd,
      preferredSessionId,
      allowedCompanionIdentity,
      allowedAdditionalIdentities,
      processBirth,
      lsofOutput: result.stdout
    });
  }

  private async queryThreadRows({
    maxSessions,
    nativeThreadId
  }: {
    maxSessions: number;
    nativeThreadId?: string;
  }): Promise<CodexThreadRow[]> {
    const dbPath = latestStateDbPath(this.codexHome);
    if (!dbPath) {
      throw new Error("no Codex state sqlite database found");
    }
    const baseline = inspectCodexSqliteFiles(dbPath);
    assertStableCodexSqliteMain({
      baseline,
      current: baseline,
      stage: "initial"
    });

    let lastFailure: CodexSqliteQueryFailure | undefined;
    const attempts = this.sqliteCantOpenRetryDelaysMs.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.sqliteCantOpenRetryDelaysMs[attempt - 1]);
      }
      const currentPath = latestStateDbPath(this.codexHome);
      const before = inspectCodexSqliteFiles(currentPath ?? dbPath);
      assertStableCodexSqliteMain({
        baseline,
        current: before,
        stage: `readonly_attempt_${attempt + 1}`,
        selectedPath: currentPath
      });
      let result: CodexSqliteThreadQueryResult;
      try {
        result = await this.runSqliteThreadQuery({
          dbPath,
          openMode: "readonly",
          maxSessions,
          nativeThreadId
        });
      } catch (error) {
        const failedPath = latestStateDbPath(this.codexHome);
        const failedFiles = inspectCodexSqliteFiles(failedPath ?? dbPath);
        assertStableCodexSqliteMain({
          baseline,
          current: failedFiles,
          stage: `readonly_attempt_${attempt + 1}_failed`,
          selectedPath: failedPath
        });
        const failure = codexSqliteQueryFailure(error, {
          dbPath,
          stage: `readonly_attempt_${attempt + 1}`,
          files: failedFiles
        });
        if (!isSqliteCantOpen(failure)) {
          throw codexSqliteQueryDiagnosticError(failure);
        }
        lastFailure = failure;
        continue;
      }
      const completedPath = latestStateDbPath(this.codexHome);
      assertStableCodexSqliteMain({
        baseline,
        current: inspectCodexSqliteFiles(completedPath ?? dbPath),
        stage: `readonly_attempt_${attempt + 1}_complete`,
        selectedPath: completedPath
      });
      return validateCodexThreadQueryResult(result);
    }

    const currentPath = latestStateDbPath(this.codexHome);
    const beforeMaterialization = inspectCodexSqliteFiles(currentPath ?? dbPath);
    assertStableCodexSqliteMain({
      baseline,
      current: beforeMaterialization,
      stage: "query_only_materialization",
      selectedPath: currentPath
    });
    let materializedResult: CodexSqliteThreadQueryResult;
    try {
      materializedResult = await this.runSqliteThreadQuery({
        dbPath,
        openMode: "query_only",
        maxSessions,
        nativeThreadId
      });
    } catch (error) {
      const failedPath = latestStateDbPath(this.codexHome);
      const failedFiles = inspectCodexSqliteFiles(failedPath ?? dbPath);
      assertStableCodexSqliteMain({
        baseline,
        current: failedFiles,
        stage: "query_only_materialization_failed",
        selectedPath: failedPath
      });
      throw codexSqliteQueryDiagnosticError(codexSqliteQueryFailure(error, {
        dbPath,
        stage: "query_only_materialization",
        files: failedFiles,
        previousFailure: lastFailure
      }));
    }
    const completedPath = latestStateDbPath(this.codexHome);
    assertStableCodexSqliteMain({
      baseline,
      current: inspectCodexSqliteFiles(completedPath ?? dbPath),
      stage: "query_only_materialization_complete",
      selectedPath: completedPath
    });
    return validateCodexThreadQueryResult(materializedResult);
  }
}

interface CodexSqliteFileIdentity {
  path: string;
  exists: boolean;
  kind?: "file" | "directory" | "other";
  device?: string;
  inode?: string;
  size?: number;
  mtimeMs?: number;
  errorCode?: string;
}

interface CodexSqliteFilesSnapshot {
  dbPath: string;
  main: CodexSqliteFileIdentity;
  wal: CodexSqliteFileIdentity;
  shm: CodexSqliteFileIdentity;
}

interface CodexSqliteQueryFailure {
  dbPath: string;
  stage: string;
  status: number | null;
  detail: string;
  files: CodexSqliteFilesSnapshot;
  previousFailure?: CodexSqliteQueryFailure;
}

class CodexSqliteSessionError extends Error {
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
  if (
    request.nativeThreadId &&
    !NATIVE_THREAD_ID_PATTERN.test(request.nativeThreadId)
  ) {
    throw new Error("Codex thread lookup requires an exact UUID");
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
  } else {
    // This is the first SQL statement for the mode=rw connection. It lets
    // SQLite materialize WAL/SHM bookkeeping while forbidding business SQL
    // writes for the entire AKK session.
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
        : buildThreadSelect(columns, request.maxSessions);
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

function validateCodexThreadQueryResult(
  result: CodexSqliteThreadQueryResult
): CodexThreadRow[] {
  validateCodexThreadColumns(result.columns);
  return result.rows;
}

function validateCodexThreadColumns(columns: readonly string[]): void {
  if (!columns.includes("id") || !columns.includes("cwd")) {
    throw new Error("Codex threads table is missing required id or cwd columns");
  }
}

function sqliteReadWriteUri(dbPath: string): string {
  const uri = pathToFileURL(path.resolve(dbPath));
  uri.searchParams.set("mode", "rw");
  return uri.href;
}

function waitForMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function inspectCodexSqliteFiles(dbPath: string): CodexSqliteFilesSnapshot {
  return {
    dbPath: path.resolve(dbPath),
    main: inspectCodexSqliteFile(dbPath),
    wal: inspectCodexSqliteFile(`${dbPath}-wal`),
    shm: inspectCodexSqliteFile(`${dbPath}-shm`)
  };
}

function inspectCodexSqliteFile(filePath: string): CodexSqliteFileIdentity {
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

function assertStableCodexSqliteMain({
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

function codexSqliteQueryFailure(
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

function isSqliteCantOpen(failure: CodexSqliteQueryFailure): boolean {
  return failure.status === 14 ||
    /(?:SQLITE_CANTOPEN|unable to open database file|\(14\))/iu.test(
      failure.detail
    );
}

function codexSqliteQueryDiagnosticError(
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

function formatCodexSqliteFiles(snapshot: CodexSqliteFilesSnapshot): string {
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

export interface LsofOpenFileRecord {
  fd?: string;
  type?: string;
  device?: string;
  inode?: string;
  path?: string;
}

export function parseLsofOpenFiles(text: string): LsofOpenFileRecord[] {
  const records: LsofOpenFileRecord[] = [];
  let current: LsofOpenFileRecord | undefined;
  const flush = () => {
    if (current) {
      records.push(current);
    }
  };
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("f")) {
      flush();
      current = { fd: line.slice(1) };
    } else if (current && line.startsWith("t")) {
      current.type = line.slice(1);
    } else if (current && line.startsWith("D")) {
      current.device = line.slice(1);
    } else if (current && line.startsWith("i")) {
      current.inode = line.slice(1);
    } else if (current && line.startsWith("n")) {
      current.path = line.slice(1);
    }
  }
  flush();
  return records;
}

export function resolveCodexOpenRolloutIdentity({
  codexHome,
  pid,
  cwd,
  preferredSessionId,
  allowedCompanionIdentity,
  allowedAdditionalIdentities,
  processBirth,
  lsofOutput
}: {
  codexHome: string;
  pid: number;
  cwd?: string;
  preferredSessionId?: string;
  allowedCompanionIdentity?: ActiveAgentSessionIdentity;
  allowedAdditionalIdentities?: readonly ActiveAgentSessionIdentity[];
  processBirth: string;
  lsofOutput: string;
}): ActiveAgentSessionIdentity | undefined {
  const rolloutFiles = parseLsofOpenFiles(lsofOutput).filter((openFile) => {
    if (!openFile.path) {
      return false;
    }
    const openPath = openFile.path.replace(/\s+\(deleted\)$/u, "");
    return /^rollout-.*\.jsonl$/u.test(path.basename(openPath));
  });
  // An absent sessions directory is only evidence of a virgin process when lsof
  // also reported no rollout descriptor at all. Once a rollout FD exists, every
  // part of its identity must be verified or the send fence fails closed.
  if (rolloutFiles.length === 0) {
    return undefined;
  }

  const configuredSessionsRoot = path.join(codexHome, "sessions");
  let sessionsRoot: string;
  try {
    sessionsRoot = fs.realpathSync(configuredSessionsRoot);
  } catch {
    throw new Error(
      `Codex process ${pid} has open rollout files but CODEX_HOME/sessions is unavailable`
    );
  }
  const expectedCwd = cwd ? path.resolve(cwd) : undefined;
  const identities: ActiveAgentSessionIdentity[] = [];
  for (const openFile of rolloutFiles) {
    const openPath = openFile.path!;
    const descriptorPath = openPath.replace(/\s+\(deleted\)$/u, "");
    const lexicalRelative = path.relative(
      path.resolve(configuredSessionsRoot),
      path.resolve(descriptorPath)
    );
    if (
      !lexicalRelative ||
      lexicalRelative.startsWith("..") ||
      path.isAbsolute(lexicalRelative)
    ) {
      throw new Error(
        `Codex process ${pid} has an open rollout outside CODEX_HOME/sessions`
      );
    }
    if (
      openFile.type !== "REG" ||
      !openFile.fd ||
      !openFile.device ||
      !openFile.inode ||
      /\s+\(deleted\)$/u.test(openPath)
    ) {
      throw new Error(
        `Codex process ${pid} has an unverifiable open rollout descriptor`
      );
    }
    let realPath: string;
    try {
      realPath = fs.realpathSync(descriptorPath);
    } catch {
      throw new Error(
        `Codex process ${pid} has an unreadable open rollout descriptor`
      );
    }
    const relative = path.relative(sessionsRoot, realPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Codex process ${pid} has an open rollout outside CODEX_HOME/sessions`
      );
    }
    const expectedDevice = parseLsofInteger(openFile.device);
    const expectedInode = parseLsofInteger(openFile.inode);
    const metadata = readCodexSessionMetadata(
      descriptorPath,
      expectedDevice,
      expectedInode,
      pid
    );
    let confirmedRealPath: string;
    try {
      confirmedRealPath = fs.realpathSync(descriptorPath);
    } catch {
      throw new Error(
        `Codex process ${pid} has an unreadable open rollout descriptor`
      );
    }
    if (confirmedRealPath !== realPath) {
      throw new Error(
        `Codex process ${pid} rollout path changed while it was being verified`
      );
    }
    const filenameSessionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu
      .exec(path.basename(descriptorPath))?.[1];
    if (!metadata || metadata.id !== filenameSessionId) {
      throw new Error(
        `Codex process ${pid} has invalid rollout session metadata`
      );
    }
    if (
      typeof metadata.source === "object" &&
      metadata.source !== null &&
      "subagent" in metadata.source
    ) {
      continue;
    }
    if (
      metadata.originator !== "codex-tui" ||
      metadata.source !== "cli" ||
      (expectedCwd && path.resolve(metadata.cwd) !== expectedCwd)
    ) {
      throw new Error(
        `Codex process ${pid} has an indeterminate open root rollout`
      );
    }
    identities.push({
      sessionId: metadata.id,
      processUuid: `codex-pid:${pid}:birth:${processBirth}`,
      processBirth,
      rollout: {
        fd: openFile.fd,
        device: openFile.device,
        inode: openFile.inode,
        path: confirmedRealPath
      },
      evidence: "codex_open_root_rollout"
    });
  }
  if (identities.length === 0) {
    throw new Error(
      `Codex process ${pid} has open rollout files but no exact TUI root identity`
    );
  }
  if (preferredSessionId) {
    const preferred = identities.filter((identity) =>
      identity.sessionId === preferredSessionId
    );
    if (preferred.length > 1) {
      throw new Error(
        `Codex process ${pid} has multiple open root rollouts for preferred ` +
        `session ${preferredSessionId}`
      );
    }
    if (allowedCompanionIdentity) {
      const allowedConstraints = [
        allowedCompanionIdentity,
        ...(allowedAdditionalIdentities ?? [])
      ];
      const allowedMatches: ActiveAgentSessionIdentity[] = [];
      for (const constraint of allowedConstraints) {
        const matches = identities.filter((identity) =>
          sameActiveCodexIdentity(identity, constraint)
        );
        if (matches.length > 1) {
          throw new Error(
            `Codex process ${pid} has multiple open root rollouts for an ` +
            "allowed companion session"
          );
        }
        if (matches[0] && !allowedMatches.includes(matches[0])) {
          allowedMatches.push(matches[0]);
        }
      }
      const unexpected = identities.filter((identity) =>
        identity !== preferred[0] && !allowedMatches.includes(identity)
      );
      if (unexpected.length > 0) {
        throw new Error(
          `Codex process ${pid} has an unexpected open root rollout outside ` +
          "the preferred and exact companion identities"
        );
      }
      if (preferred.length === 1) {
        return preferred[0];
      }
      const primaryCompanion = identities.find((identity) =>
        sameActiveCodexIdentity(identity, allowedCompanionIdentity)
      );
      if (primaryCompanion) {
        return primaryCompanion;
      }
      if (allowedMatches.length > 0) {
        // The immediately preceding rollout can close while an older,
        // independently verified managed ancestor remains open. Constraint
        // order is authoritative and deterministic; unknown roots were
        // rejected above, so the first surviving exact companion is safe
        // process-incarnation evidence for a fresh status-card proof.
        return allowedMatches[0];
      }
      throw new Error(
        `Codex process ${pid} has neither the preferred session nor an ` +
        "exact managed companion rollout open"
      );
    } else if (preferred.length === 1 && identities.length === 1) {
      return preferred[0];
    } else {
      throw new Error(
        `Codex process ${pid} does not have the preferred session as its ` +
        "sole open root rollout"
      );
    }
  }
  if (identities.length !== 1) {
    throw new Error(
      `Codex process ${pid} has ${identities.length} open root rollout files; ` +
      "the foreground native session is ambiguous"
    );
  }
  return identities[0];
}

function sameActiveCodexIdentity(
  left: ActiveAgentSessionIdentity,
  right: ActiveAgentSessionIdentity
): boolean {
  return Boolean(
    left.sessionId === right.sessionId &&
    left.processUuid === right.processUuid &&
    left.processBirth === right.processBirth &&
    left.rollout?.fd === right.rollout?.fd &&
    left.rollout?.device === right.rollout?.device &&
    left.rollout?.inode === right.rollout?.inode &&
    left.rollout?.path === right.rollout?.path
  );
}

function parseLsofInteger(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return -1n;
  }
}

function readCodexSessionMetadata(
  filePath: string,
  expectedDevice: bigint,
  expectedInode: bigint,
  pid: number
): {
  id: string;
  cwd: string;
  originator: string;
  source: unknown;
} | undefined {
  let fd: number;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
  } catch {
    throw new Error(
      `Codex process ${pid} has an unreadable open rollout descriptor`
    );
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.dev !== expectedDevice ||
      stat.ino !== expectedInode
    ) {
      throw new Error(
        `Codex process ${pid} rollout descriptor no longer matches its file`
      );
    }
    const buffer = Buffer.alloc(1024 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0 && bytesRead === buffer.length) {
      throw new Error(`Codex session metadata line is too large: ${filePath}`);
    }
    const parsed = JSON.parse(newline >= 0 ? text.slice(0, newline) : text);
    const payload = parsed?.type === "session_meta" ? parsed.payload : undefined;
    if (
      typeof payload?.id !== "string" ||
      typeof payload?.cwd !== "string" ||
      typeof payload?.originator !== "string"
    ) {
      return undefined;
    }
    return {
      id: payload.id,
      cwd: payload.cwd,
      originator: payload.originator,
      source: payload.source
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function buildThreadSelect(columns: string[], limit: number): string {
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
    columnSet.has("name") ? "name" : "null as name"
  ].join(", ");

  return `select ${select} from threads order by ${updatedAtExpression} desc limit ${Math.max(1, Math.floor(limit))}`;
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

function assertCodexLifecycleCandidateRequest(
  request: TerminalThreadLifecycleCandidateRequest
): void {
  if (!codexLifecycleBehaviorProfile(request.agentVersion)) {
    throw new Error(
      "Codex lifecycle candidates require one of the supported exact versions: " +
      supportedCodexLifecycleVersions().join(", ")
    );
  }
  if (!request.cwd || !path.isAbsolute(request.cwd)) {
    throw new Error("Codex lifecycle candidate discovery requires an absolute cwd");
  }
}

function codexLifecycleCandidateFromRow({
  row,
  codexHome,
  request
}: {
  row: CodexLifecycleThreadRow;
  codexHome: string;
  request: TerminalThreadLifecycleCandidateRequest;
}): TerminalThreadLifecycleCandidate | undefined {
  const nativeThreadId = stringField(row.id)?.toLowerCase();
  const rowCwd = stringField(row.cwd);
  const rolloutPath = stringField(row.rollout_path ?? row.rolloutPath);
  const rowSource = stringField(row.source);
  const rowVersion = stringField(row.cli_version);
  const rowModelProvider = stringField(row.model_provider);
  if (
    !nativeThreadId ||
    !NATIVE_THREAD_ID_PATTERN.test(nativeThreadId) ||
    !rowCwd ||
    !rolloutPath ||
    !path.isAbsolute(rowCwd) ||
    !path.isAbsolute(rolloutPath) ||
    rowSource !== "cli" ||
    rowVersion !== request.agentVersion ||
    row.archived === true ||
    row.archived === 1 ||
    path.resolve(rowCwd) !== path.resolve(request.cwd) ||
    (
      request.modelProvider !== undefined &&
      rowModelProvider !== request.modelProvider
    )
  ) {
    return undefined;
  }

  const opened = readCodexLifecycleMetadata({
    codexHome,
    rolloutPath,
    nativeThreadId
  });
  if (
    opened.metadata.id !== nativeThreadId ||
    !path.isAbsolute(opened.metadata.cwd) ||
    path.resolve(opened.metadata.cwd) !== path.resolve(request.cwd) ||
    opened.metadata.originator !== "codex-tui" ||
    opened.metadata.source !== "cli" ||
    opened.metadata.cliVersion !== request.agentVersion ||
    (
      rowModelProvider !== undefined &&
      opened.metadata.modelProvider !== rowModelProvider
    ) ||
    (
      request.modelProvider !== undefined &&
      opened.metadata.modelProvider !== request.modelProvider
    )
  ) {
    return undefined;
  }
  const title = boundedCandidateText(row.name ?? row.title);
  const preview = boundedCandidateText(
    row.preview ?? row.first_user_message ?? row.firstUserMessage
  );
  const updatedAtMs = finiteNumber(row.updated_at_ms ?? row.updatedAtMs) ??
    opened.fileToken.mtimeMs;
  const metadataFingerprint = createHash("sha256")
    .update(JSON.stringify({
      nativeThreadId,
      cwd: path.resolve(opened.metadata.cwd),
      originator: opened.metadata.originator,
      source: opened.metadata.source,
      cliVersion: opened.metadata.cliVersion,
      modelProvider: opened.metadata.modelProvider ?? null,
      rolloutPath: opened.fileToken.path
    }))
    .digest("hex");
  const candidateToken: TerminalThreadLifecycleCandidateToken = {
    schema: "agent-knock-knock/thread-candidate-token",
    version: 1,
    agent: "codex",
    nativeThreadId,
    cwd: path.resolve(request.cwd),
    source: "codex_rollout",
    agentVersion: request.agentVersion,
    fileToken: opened.fileToken,
    metadataFingerprint,
    modelProvider: opened.metadata.modelProvider
  };
  return {
    agent: "codex",
    nativeThreadId,
    cwd: path.resolve(request.cwd),
    source: "codex_rollout",
    rootInteractive: true,
    fileToken: opened.fileToken,
    agentVersion: request.agentVersion,
    title,
    preview,
    updatedAtMs,
    modelProvider: opened.metadata.modelProvider,
    metadataFingerprint,
    candidateToken
  };
}

function readCodexLifecycleMetadata({
  codexHome,
  rolloutPath,
  nativeThreadId
}: {
  codexHome: string;
  rolloutPath: string;
  nativeThreadId: string;
}): {
  fileToken: TerminalThreadFileToken;
  metadata: {
    id: string;
    cwd: string;
    originator: string;
    source: string;
    cliVersion: string;
    modelProvider?: string;
  };
} {
  const configuredRoot = path.resolve(codexHome, "sessions");
  const lexicalRelative = path.relative(configuredRoot, path.resolve(rolloutPath));
  if (
    !lexicalRelative ||
    lexicalRelative.startsWith("..") ||
    path.isAbsolute(lexicalRelative)
  ) {
    throw new Error("Codex lifecycle rollout is outside CODEX_HOME/sessions");
  }
  const sessionsRoot = fs.realpathSync(configuredRoot);
  const lstat = fs.lstatSync(rolloutPath);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw new Error("Codex lifecycle rollout must be a non-symlink regular file");
  }
  const realPath = fs.realpathSync(rolloutPath);
  const realRelative = path.relative(sessionsRoot, realPath);
  if (
    !realRelative ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative)
  ) {
    throw new Error("Codex lifecycle rollout resolves outside CODEX_HOME/sessions");
  }
  const filenameId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu
    .exec(path.basename(realPath))?.[1]?.toLowerCase();
  if (filenameId !== nativeThreadId) {
    throw new Error("Codex lifecycle rollout filename does not match its thread UUID");
  }

  const fd = fs.openSync(realPath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || !Number.isSafeInteger(before.size)) {
      throw new Error("Codex lifecycle rollout has an invalid file identity");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      before.uid !== process.getuid()
    ) {
      throw new Error("Codex lifecycle rollout is not owned by the current user");
    }
    if (process.platform !== "win32" && (before.mode & 0o022) !== 0) {
      throw new Error("Codex lifecycle rollout is writable by another user");
    }
    const bytesToRead = Math.min(before.size, MAX_CODEX_SESSION_META_BYTES);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0 && before.size > bytesRead) {
      throw new Error("Codex lifecycle session metadata line exceeds the read limit");
    }
    const parsed = JSON.parse(newline >= 0 ? text.slice(0, newline) : text);
    const payload = parsed?.type === "session_meta" ? parsed.payload : undefined;
    const id = stringField(payload?.id)?.toLowerCase();
    const cwd = stringField(payload?.cwd);
    const originator = stringField(payload?.originator);
    const source = stringField(payload?.source);
    const cliVersion = stringField(payload?.cli_version);
    const modelProvider = stringField(payload?.model_provider);
    if (!id || !cwd || !originator || !source || !cliVersion) {
      throw new Error("Codex lifecycle rollout has incomplete session metadata");
    }
    const after = fs.fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      fs.realpathSync(realPath) !== realPath
    ) {
      throw new Error("Codex lifecycle rollout changed while it was inspected");
    }
    return {
      fileToken: {
        path: realPath,
        device: String(before.dev),
        inode: String(before.ino),
        size: before.size,
        mtimeMs: before.mtimeMs
      },
      metadata: { id, cwd, originator, source, cliVersion, modelProvider }
    };
  } finally {
    fs.closeSync(fd);
  }
}

function sameThreadFileToken(
  left: TerminalThreadFileToken,
  right: TerminalThreadFileToken
): boolean {
  return left.path === right.path &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boundedCandidateText(value: unknown): string | undefined {
  const text = stringField(value)?.replace(/\s+/gu, " ");
  if (!text) {
    return undefined;
  }
  return text.length <= 400 ? text : `${text.slice(0, 399)}…`;
}
