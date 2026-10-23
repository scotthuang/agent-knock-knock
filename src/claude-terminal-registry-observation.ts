import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { validateClaudeNativeIdentity } from "./claude-native-identity.js";

export interface ClaudeTerminalRegistryRow {
  pid?: number;
  cwd?: string;
  kind?: string;
  sessionId?: string;
  startedAt?: number;
  status?: string;
}

export type ClaudeTerminalRegistryObservation =
  | { state: "verified"; configDir: string; pid: number; sessionId: string; cwd: string;
      startedAt: number; processStart: string; version: string }
  | { state: "absent" }
  | { state: "invalid"; reason: "invalid_identity" | "unsafe_metadata" | "invalid_registry"
      | "conflicting_rows" | "registry_mismatch" | "process_changed" | "registry_unavailable" };

const MAX_REGISTRY_BYTES = 64 * 1024;
class RegistryError extends Error {
  constructor(readonly reason: Extract<ClaudeTerminalRegistryObservation, { state: "invalid" }>["reason"]) {
    super(reason);
  }
}
function absolute(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function statusShape(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function owned(stat: Stats, kind: "file" | "directory"): void {
  if (typeof process.getuid !== "function" || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0
    || stat.isSymbolicLink() || !(kind === "file" ? stat.isFile() : stat.isDirectory())) {
    throw new RegistryError("unsafe_metadata");
  }
}
function readRegistry(configDir: string, pid: number): Record<string, unknown> {
  owned(lstatSync(configDir), "directory");
  owned(lstatSync(path.join(configDir, "sessions")), "directory");
  const file = path.join(configDir, "sessions", `${pid}.json`), before = lstatSync(file);
  owned(before, "file");
  if (before.size > MAX_REGISTRY_BYTES) throw new RegistryError("invalid_registry");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new RegistryError("registry_unavailable"); }
  try {
    const opened = fstatSync(fd); owned(opened, "file");
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_REGISTRY_BYTES) {
      throw new RegistryError("unsafe_metadata");
    }
    const bytes = Buffer.alloc(MAX_REGISTRY_BYTES + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count > MAX_REGISTRY_BYTES || count !== after.size || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) throw new RegistryError("invalid_registry");
    const parsed: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RegistryError("invalid_registry");
    return parsed as Record<string, unknown>;
  } finally { closeSync(fd); }
}

type SelectedClaudeRow = ClaudeTerminalRegistryRow & { cwd: string; startedAt: number };
type VerifiedObservation = Extract<ClaudeTerminalRegistryObservation, { state: "verified" }>;

function selectExactRow(allRows: readonly ClaudeTerminalRegistryRow[], pid: number): SelectedClaudeRow {
  const rows = allRows.filter(row => row.pid === pid), row = rows[0];
  if (!row || row.kind !== "interactive" || !absolute(row.cwd)
    || !Number.isSafeInteger(row.startedAt) || (row.startedAt ?? 0) <= 0 || !statusShape(row.status)) {
    throw new RegistryError("invalid_identity");
  }
  if (rows.some(candidate => candidate.sessionId !== row.sessionId || candidate.cwd !== row.cwd
    || candidate.startedAt !== row.startedAt || candidate.kind !== "interactive" || !statusShape(candidate.status))) {
    throw new RegistryError("conflicting_rows");
  }
  return row as SelectedClaudeRow;
}

function bindRegistry(configDir: string, pid: number, registry: Record<string, unknown>, row: SelectedClaudeRow): VerifiedObservation {
  const processStart = typeof registry.procStart === "string" ? registry.procStart.trim().replace(/\s+/gu, " ") : "";
  let identity;
  try { identity = validateClaudeNativeIdentity({ configDir, pid,
    sessionId: String(registry.sessionId), processStart }); }
  catch { throw new RegistryError("invalid_identity"); }
  if (registry.pid !== pid || registry.sessionId !== row.sessionId || registry.cwd !== row.cwd
    || !Number.isSafeInteger(registry.startedAt) || registry.startedAt !== row.startedAt
    || !statusShape(registry.status) || typeof registry.version !== "string" || registry.version.length > 128
    || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(registry.version)) {
    throw new RegistryError("registry_mismatch");
  }
  return { state: "verified", ...identity, cwd: row.cwd, startedAt: row.startedAt, version: registry.version };
}

function assertCurrentProcess(identity: Pick<VerifiedObservation, "pid" | "processStart">): void {
  const result = spawnSync("/bin/ps", ["-p", String(identity.pid), "-o", "uid=", "-o", "lstart="], {
    encoding: "utf8", timeout: 2000, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
  });
  const processInfo = result.stdout?.trim().replace(/\s+/gu, " ");
  if (result.error || result.status !== 0 || processInfo !== `${process.getuid?.()} ${identity.processStart}`) {
    throw new RegistryError("process_changed");
  }
}

/** Read-only version/root evidence; this does not verify a native socket or authorize sending. */
export function observeClaudeTerminalRegistry(input: {
  configDir: string;
  pid: number;
  rows: readonly ClaudeTerminalRegistryRow[];
}): ClaudeTerminalRegistryObservation {
  if (!absolute(input.configDir) || !Number.isSafeInteger(input.pid) || input.pid < 1) {
    return { state: "invalid", reason: "invalid_identity" };
  }
  try {
    const configDir = realpathSync(input.configDir), registry = readRegistry(configDir, input.pid);
    const row = selectExactRow(input.rows, input.pid);
    const bound = bindRegistry(configDir, input.pid, registry, row);
    assertCurrentProcess(bound);
    return bound;
  } catch (error) {
    if (error instanceof RegistryError) return { state: "invalid", reason: error.reason };
    if (error instanceof SyntaxError) return { state: "invalid", reason: "invalid_registry" };
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
    return { state: "invalid", reason: "registry_unavailable" };
  }
}
