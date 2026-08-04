import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActiveAgentSessionIdentity } from "./agent-session-provider.js";
import { discoverCodexProcesses, type CodexProcessSnapshot, type CodexThreadRow } from "./codex-session-provider.js";
import type { CodexLocalSessionAdapter } from "./codex-local-session-provider.js";
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
  maxSessions?: number;
}

export class CodexStoreAdapter implements CodexLocalSessionAdapter {
  private readonly codexHome: string;
  private readonly runCommand: (command: string, args: string[]) => ProcessCommandResult;
  private readonly maxSessions: number;

  constructor(options: CodexStoreAdapterOptions = {}) {
    this.codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
    this.runCommand = options.runCommand ?? runProcessCommand;
    this.maxSessions = options.maxSessions ?? 100;
  }

  async listThreadRows(): Promise<CodexThreadRow[]> {
    const dbPath = latestStateDbPath(this.codexHome);
    if (!dbPath) {
      throw new Error("no Codex state sqlite database found");
    }

    const columns = this.queryJson<{ name: string }>(dbPath, "pragma table_info(threads)")
      .map((column) => column.name);
    if (!columns.includes("id") || !columns.includes("cwd")) {
      throw new Error("Codex threads table is missing required id or cwd columns");
    }

    return this.queryJson<CodexThreadRow>(dbPath, buildThreadSelect(columns, this.maxSessions));
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
    cwd?: string
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
      processBirth,
      lsofOutput: result.stdout
    });
  }

  private queryJson<T>(dbPath: string, sql: string): T[] {
    const result = this.runCommand("sqlite3", ["-json", dbPath, sql]);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || "sqlite3 query failed");
    }

    return JSON.parse(result.stdout || "[]") as T[];
  }
}

export function latestStateDbPath(codexHome: string): string | undefined {
  if (!fs.existsSync(codexHome)) {
    return undefined;
  }

  return fs.readdirSync(codexHome)
    .filter((entry) => /^state_\d+\.sqlite$/u.test(entry))
    .map((entry) => path.join(codexHome, entry))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
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
  processBirth,
  lsofOutput
}: {
  codexHome: string;
  pid: number;
  cwd?: string;
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
  if (identities.length !== 1) {
    throw new Error(
      `Codex process ${pid} has ${identities.length} open root rollout files; ` +
      "the foreground native session is ambiguous"
    );
  }
  return identities[0];
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
    columnSet.has("archived") ? "archived" : "0 as archived"
  ].join(", ");

  return `select ${select} from threads order by ${updatedAtExpression} desc limit ${Math.max(1, Math.floor(limit))}`;
}
