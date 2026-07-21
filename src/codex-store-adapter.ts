import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
