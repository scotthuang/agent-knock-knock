import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCodexProcesses, type CodexProcessSnapshot, type CodexThreadRow } from "./codex-session-provider.js";
import type { CodexLocalSessionAdapter } from "./codex-local-session-provider.js";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CodexStoreAdapterOptions {
  codexHome?: string;
  runCommand?: (command: string, args: string[]) => CommandResult;
  maxSessions?: number;
}

export class CodexStoreAdapter implements CodexLocalSessionAdapter {
  private readonly codexHome: string;
  private readonly runCommand: (command: string, args: string[]) => CommandResult;
  private readonly maxSessions: number;

  constructor(options: CodexStoreAdapterOptions = {}) {
    this.codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
    this.runCommand = options.runCommand ?? runCommand;
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
    const ps = this.runCommand("ps", ["-axo", "pid,ppid,etime,command"]);
    if (ps.status !== 0) {
      throw new Error(ps.stderr || ps.error?.message || "ps failed");
    }

    const snapshots = parsePsProcessSnapshots(ps.stdout);
    const codexSnapshots = snapshots.filter((snapshot) => discoverCodexProcesses([snapshot]).length > 0);
    if (codexSnapshots.length === 0) {
      return [];
    }

    const lsof = this.runCommand("lsof", ["-a", "-d", "cwd", "-p", codexSnapshots.map((snapshot) => String(snapshot.pid)).join(",")]);
    if (lsof.status !== 0) {
      return codexSnapshots;
    }

    const cwdByPid = parseLsofCwdMap(lsof.stdout);
    return codexSnapshots.map((snapshot) => ({
      ...snapshot,
      cwd: snapshot.cwd ?? cwdByPid.get(snapshot.pid)
    }));
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

export function parsePsProcessSnapshots(output: string): CodexProcessSnapshot[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsed: match[3],
      command: match[4]
    }));
}

export function parseLsofCwdMap(output: string): Map<number, string> {
  const cwdByPid = new Map<number, string>();
  for (const line of output.split(/\r?\n/).slice(1)) {
    const match = /^\S+\s+(\d+)\s+\S+\s+cwd\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+?)\s*$/u.exec(line);
    if (match) {
      cwdByPid.set(Number(match[1]), match[2]);
    }
  }
  return cwdByPid;
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

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}
