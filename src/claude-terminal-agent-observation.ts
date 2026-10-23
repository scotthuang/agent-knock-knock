import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import { resolveExecutable } from "./cli-command-runtime.js";
import { cliEnv, cliRuntimeLog } from "./cli-runtime-context.js";
import { claudeReaderConfiguration, claudeReaderDiagnostic, claudeReaderNextAction,
  type ClaudeReaderDiagnostic } from "./claude-reader-configuration.js";
import { observeClaudeTerminalRegistry } from "./claude-terminal-registry-observation.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export interface ClaudeTerminalAgentObservation {
  rows: ClaudeAgentRow[]; rejectedPids: number[]; errors: string[];
  reader?: ClaudeReaderDiagnostic;
  next_action?: string;
}

export function claudeTerminalObservationFailure(result: ClaudeTerminalAgentObservation): string {
  const reader = result.reader ? `; reader=${JSON.stringify(result.reader.executable)} source=${result.reader.source}` : "";
  const hint = result.next_action ? "; check AKK_NATIVE_CLAUDE_BIN in the environment that starts this Host (a separate shell export does not update a running Host)" : "";
  return `Claude agent session observation failed (${result.errors.join(", ")}${reader})${hint}; refusing to treat the process as a virgin session`;
}
/** Static fixtures never gain registry authority from caller-supplied metadata. */
export function normalizeClaudeAgentRows(rows: readonly unknown[]): ClaudeAgentRow[] {
  return rows.flatMap((row): ClaudeAgentRow[] => {
    if (!isRecord(row) || !Number.isSafeInteger(Number(row.pid)) || Number(row.pid) < 1) return [];
    return [{ pid: Number(row.pid),
      ...(nonBlankString(row.cwd) ? { cwd: nonBlankString(row.cwd) } : {}),
      ...(nonBlankString(row.kind) ? { kind: nonBlankString(row.kind) } : {}),
      ...(nonBlankString(row.sessionId) ? { sessionId: nonBlankString(row.sessionId) } : {}),
      ...(Number.isSafeInteger(Number(row.startedAt)) && Number(row.startedAt) > 0
        ? { startedAt: Number(row.startedAt) } : {}),
      ...(nonBlankString(row.status) ? { status: nonBlankString(row.status) } : {}),
      ...(nonBlankString(row.waitingFor) ? { waitingFor: nonBlankString(row.waitingFor) } : {}) }];
  });
}
function canonicalRoot(root: string): string {
  try { return fs.realpathSync(root); } catch { return root; }
}
function resolveReader(reader: string): string {
  try {
    const executable = resolveExecutable(reader);
    fs.accessSync(executable, fs.constants.X_OK);
    if (!fs.statSync(executable).isFile()) throw new Error("not executable file");
    return executable;
  } catch { throw new Error("claude_reader_unavailable"); }
}
function readerRows(reader: string, root: string): ClaudeAgentRow[] {
  const command = spawnSync(reader, ["agents", "--json", "--all"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 10 * 1024 * 1024,
    env: { ...cliEnv(), CLAUDE_CONFIG_DIR: root }
  });
  if (command.error || command.status !== 0) throw new Error("claude_reader_failed");
  let raw: unknown;
  try { raw = JSON.parse(command.stdout); }
  catch { throw new Error("claude_reader_invalid_json"); }
  const values = Array.isArray(raw) ? raw : isRecord(raw) ? raw.agents : undefined;
  if (!Array.isArray(values) || values.length > 4096) throw new Error("claude_reader_invalid_shape");
  return normalizeClaudeAgentRows(values).filter(row => !row.kind || row.kind === "interactive");
}
function bindRegistryRows(root: string, legacyRoot: string, pid: number, rows: ClaudeAgentRow[]): ClaudeAgentRow[] {
  const registry = observeClaudeTerminalRegistry({ configDir: root, pid, rows });
  if (registry.state === "invalid") throw new Error(`claude_registry_${registry.reason}`);
  if (registry.state === "absent") {
    if (root !== legacyRoot) throw new Error("claude_registry_root_unverified");
    return rows;
  }
  return rows.map(row => ({ ...row, configDir: registry.configDir, version: registry.version,
    processStart: registry.processStart }));
}
/** Never infer a session directory from the reader's install layout. */
export function readClaudeTerminalAgents(options: Readonly<Record<string, unknown>>): ClaudeTerminalAgentObservation {
  const result: ClaudeTerminalAgentObservation = { rows: [], rejectedPids: [], errors: [] };
  const fail = (code: string) => {
    if (result.errors.includes(code)) return;
    result.errors.push(code);
    result.next_action = claudeReaderNextAction(result.errors);
    cliRuntimeLog("warn", "claude_agents_list_failed", { code,
      ...(result.reader ? { reader: result.reader } : {}),
      ...(result.next_action ? { next_action: result.next_action } : {}) });
  };
  let config: ReturnType<typeof claudeReaderConfiguration>;
  let legacyRoot: string;
  try {
    config = claudeReaderConfiguration(options);
    result.reader = claudeReaderDiagnostic(config);
    legacyRoot = canonicalRoot(claudeReaderConfiguration({ ...options,
      claudeHome: options.claudeHome ?? cliEnv().CLAUDE_CONFIG_DIR ??
        path.join(cliEnv().HOME ?? os.homedir(), ".claude") }).configDirs[0]);
  } catch { fail("claude_reader_invalid_configuration"); return result; }
  let reader: string;
  try { reader = resolveReader(config.reader); }
  catch { fail("claude_reader_unavailable"); return result; }
  const sources = new Map<number, Set<string>>();
  for (const root of new Set(config.configDirs.map(canonicalRoot))) {
    let rows: ClaudeAgentRow[];
    try { rows = readerRows(reader, root); }
    catch (error) { fail((error as Error).message); continue; }
    for (const pid of new Set(rows.map(row => row.pid!))) {
      const locations = sources.get(pid) ?? new Set<string>();
      locations.add(root); sources.set(pid, locations);
      try { result.rows.push(...bindRegistryRows(root, legacyRoot, pid, rows.filter(row => row.pid === pid))); }
      catch (error) { result.rejectedPids.push(pid); fail((error as Error).message); }
    }
  }
  for (const [pid, roots] of sources) {
    if (roots.size > 1) { result.rejectedPids.push(pid); fail("claude_registry_conflicting_roots"); }
  }
  result.rejectedPids = [...new Set(result.rejectedPids)];
  result.rows = result.rows.filter(row => !result.rejectedPids.includes(row.pid!));
  return result;
}
