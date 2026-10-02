export {
  LsofOpenFileRecord,
  parseLsofOpenFiles,
  resolveCodexOpenRolloutIdentity,
  inspectCodexOpenRootRolloutInventory
} from "./codex-open-rollout-inventory.js";
import {
  LsofOpenFileRecord,
  parseLsofOpenFiles,
  resolveCodexOpenRolloutIdentity,
  inspectCodexOpenRootRolloutInventory,
  selectCodexOpenRolloutIdentity
} from "./codex-open-rollout-inventory.js";
export {
  CodexSqliteOpenMode,
  CodexSqliteThreadQueryRequest,
  CodexThreadQueryFilters,
  CodexSqliteThreadQueryResult,
  CodexSqliteThreadQueryRunner,
  runCodexSqliteThreadQuery,
  latestStateDbPath,
  buildThreadSelect,
  buildThreadByIdSelect
} from "./codex-sqlite-thread-query.js";
import {
  CodexSqliteOpenMode,
  CodexSqliteThreadQueryRequest,
  CodexThreadQueryFilters,
  CodexSqliteThreadQueryResult,
  CodexSqliteThreadQueryRunner,
  NATIVE_THREAD_ID_PATTERN,
  CodexSqliteQueryFailure,
  runCodexSqliteThreadQuery,
  validateCodexThreadQueryResult,
  inspectCodexSqliteFiles,
  assertStableCodexSqliteMain,
  codexSqliteQueryFailure,
  isSqliteCantOpen,
  codexSqliteQueryDiagnosticError,
  latestStateDbPath,
  buildThreadSelect,
  buildThreadByIdSelect
} from "./codex-sqlite-thread-query.js";

import {
  createHash
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ActiveAgentSessionIdentity,
  type CodexOpenRootRolloutInventory
} from "./agent-session-provider.js";
import {
  isValidCodexAgentVersion
} from "./codex-lifecycle-compatibility.js";
import {
  codexThreadUsesLegacyRollout,
  discoverCodexProcesses,
  type CodexProcessSnapshot,
  type CodexThreadRow
} from "./codex-session-provider.js";
import type {
  CodexLocalSessionAdapter
} from "./codex-local-session-provider.js";
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

interface CodexLifecycleThreadRow extends CodexThreadRow {
  source?: string;
  model_provider?: string;
  cli_version?: string;
  name?: string;
}
const MAX_CODEX_SESSION_META_BYTES = 1024 * 1024;
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
    const rows = await this.queryThreadRows({
      maxSessions: this.maxSessions,
      filters: {
        cwd: path.resolve(request.cwd),
        source: "cli",
        archived: false,
        modelProvider: request.modelProvider,
        historyMode: "legacy"
      }
    });
    for (const row of rows as CodexLifecycleThreadRow[]) {
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
        ![1, 2].includes(token.version) ||
        (
          token.version === 1
            ? "sourceAgentVersion" in token
            : (
                !isValidCodexAgentVersion(token.sourceAgentVersion) ||
                token.sourceAgentVersion === token.agentVersion
              )
        ) ||
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
        current.sourceAgentVersion !== candidateSourceAgentVersion(token) ||
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
    const inventory = await this.inspectOpenRootRolloutInventoryForPid(
      pid,
      cwd
    );
    return selectCodexOpenRolloutIdentity({
      inventory,
      preferredSessionId,
      allowedCompanionIdentity,
      allowedAdditionalIdentities
    });
  }

  /**
   * Return a complete, exact inventory of every open Codex TUI root rollout.
   *
   * A successful `unbound` result is deliberately different from an
   * inspection failure: all descriptors and root metadata were verified, but
   * more than one root is open so this layer cannot name the foreground one.
   * Command, descriptor, ownership, cwd, or metadata failures throw and must
   * remain fail-closed at the caller.
   */
  async inspectOpenRootRolloutInventoryForPid(
    pid: number,
    cwd?: string
  ): Promise<CodexOpenRootRolloutInventory> {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error("Codex process pid must be a positive integer greater than 1");
    }
    const readProcessBirth = (): string => {
      const result = this.runCommand("ps", [
        "-o",
        "lstart=",
        "-p",
        String(pid)
      ]);
      const processBirth = result.stdout.trim();
      if (result.status !== 0 || !processBirth) {
        throw new Error(
          result.stderr || result.error?.message ||
          `could not inspect start time for Codex process ${pid}`
        );
      }
      return processBirth;
    };
    const processBirth = readProcessBirth();
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
    const confirmedProcessBirth = readProcessBirth();
    if (confirmedProcessBirth !== processBirth) {
      throw new Error(
        `Codex process ${pid} incarnation changed while open rollouts were inspected`
      );
    }
    return inspectCodexOpenRootRolloutInventory({
      codexHome: this.codexHome,
      pid,
      cwd,
      processBirth,
      lsofOutput: result.stdout
    });
  }

  private async queryThreadRows({
    maxSessions,
    nativeThreadId,
    filters
  }: {
    maxSessions: number;
    nativeThreadId?: string;
    filters?: CodexThreadQueryFilters;
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
          nativeThreadId,
          filters
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
        nativeThreadId,
        filters
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

function waitForMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function assertCodexLifecycleCandidateRequest(
  request: TerminalThreadLifecycleCandidateRequest
): void {
  if (!isValidCodexAgentVersion(request.agentVersion)) {
    throw new Error(
      "Codex lifecycle candidate discovery requires a complete x.y.z agent version"
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
    !codexThreadUsesLegacyRollout(row) ||
    !NATIVE_THREAD_ID_PATTERN.test(nativeThreadId) ||
    !rowCwd ||
    !rolloutPath ||
    !path.isAbsolute(rowCwd) ||
    !path.isAbsolute(rolloutPath) ||
    rowSource !== "cli" ||
    !isValidCodexAgentVersion(rowVersion) ||
    !(
      row.archived === undefined ||
      row.archived === false ||
      row.archived === 0
    ) ||
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
    opened.metadata.cliVersion !== rowVersion ||
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
  const tokenFields = {
    agent: "codex",
    nativeThreadId,
    cwd: path.resolve(request.cwd),
    source: "codex_rollout",
    agentVersion: request.agentVersion,
    fileToken: opened.fileToken,
    metadataFingerprint,
    modelProvider: opened.metadata.modelProvider
  } as const;
  const candidateToken: TerminalThreadLifecycleCandidateToken =
    opened.metadata.cliVersion === request.agentVersion
      ? {
          schema: "agent-knock-knock/thread-candidate-token",
          version: 1,
          ...tokenFields
        }
      : {
          schema: "agent-knock-knock/thread-candidate-token",
          version: 2,
          ...tokenFields,
          sourceAgentVersion: opened.metadata.cliVersion
        };
  return {
    agent: "codex",
    nativeThreadId,
    cwd: path.resolve(request.cwd),
    source: "codex_rollout",
    rootInteractive: true,
    fileToken: opened.fileToken,
    agentVersion: request.agentVersion,
    sourceAgentVersion: opened.metadata.cliVersion,
    title,
    preview,
    updatedAtMs,
    modelProvider: opened.metadata.modelProvider,
    metadataFingerprint,
    candidateToken
  };
}

function candidateSourceAgentVersion(
  token: TerminalThreadLifecycleCandidateToken
): string {
  return token.version === 2 ? token.sourceAgentVersion : token.agentVersion;
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
    if (!codexThreadUsesLegacyRollout(payload)) {
      throw new Error("Codex lifecycle rollout does not use legacy history");
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
