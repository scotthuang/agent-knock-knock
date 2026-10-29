import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readClaudeAgentDiscovery } from "./claude-agent-discovery-cache.js";
import { cliExecutionMemoAsync } from "./cli-runtime-context.js";
import { ClaudeNativeError, createClaudeNativeConversationId, validateClaudeNativeIdentity,
  type ClaudeNativeCatalogEntry, type ClaudeNativeIdentity } from "./claude-native-identity.js";

const execFile = promisify(execFileCallback);
export interface ClaudeNativeDiscoveryOptions {
  configDirs?: string[];
  claudePath?: string;
  platform?: NodeJS.Platform;
  /** Test seam: command output must retain the real agents/registry contract. */
  run?: (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
}
export interface ClaudeNativeDiscoveryResult {
  sessions: ClaudeNativeCatalogEntry[];
  errors: Array<{ configDir: string; code: string }>;
}
export async function runClaudeNativeCommand(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFile(file, args, { env, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
  return result.stdout;
}
/** Only an executable launch failure establishes that the configured reader is unavailable. */
async function readClaudeNativeAgentOutput(configDir: string, options: ClaudeNativeDiscoveryOptions): Promise<string> {
  try {
    const output = await readClaudeAgentDiscovery(configDir, options.claudePath ?? "claude", options.run);
    if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw new Error("Claude native discovery exceeds its output limit");
    return output;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") {
      throw new ClaudeNativeError("claude_reader_unavailable", "The configured Claude reader could not be executed");
    }
    throw error;
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClaudeNativeError("invalid_registry", "Invalid native session metadata");
  return value as Record<string, unknown>;
}
function absolute(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}
async function owned(p: string, kind: "file" | "directory" | "socket") {
  const s = await lstat(p);
  if (s.uid !== process.getuid?.() || (s.mode & 0o022) !== 0 || s.isSymbolicLink()
    || !(kind === "file" ? s.isFile() : kind === "socket" ? s.isSocket() : s.isDirectory())) {
    throw new ClaudeNativeError("unsafe_metadata", "Claude native metadata or socket ownership is unsafe");
  }
  return s;
}
export async function readClaudeNativeRegistry(configDir: string, pid: number): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new ClaudeNativeError("invalid_identity", "Invalid native PID");
  await owned(configDir, "directory"); await owned(path.join(configDir, "sessions"), "directory");
  const file = path.join(configDir, "sessions", `${pid}.json`), stat = await owned(file, "file");
  if (stat.size > 64 * 1024) throw new ClaudeNativeError("invalid_registry", "Native registry entry exceeds limit");
  return record(JSON.parse(await readFile(file, "utf8")));
}
type NativeFields = Pick<ClaudeNativeCatalogEntry, "cwd" | "version" | "socketPath" | "peerProtocol" | "peerFeatures">;
function registryIdentity(configDir: string, m: Record<string, unknown>, pid: number): ClaudeNativeIdentity {
  const processStart = typeof m.procStart === "string" ? m.procStart.trim().replace(/\s+/gu, " ") : "";
  return validateClaudeNativeIdentity({ configDir, sessionId: String(m.sessionId), pid, processStart });
}
function registryFields(m: Record<string, unknown>, identity: ClaudeNativeIdentity): NativeFields {
  if (m.pid !== identity.pid || !absolute(m.cwd)
    || typeof m.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(m.version)
    || m.peerProtocol !== 1 || !Array.isArray(m.peerFeatures) || !m.peerFeatures.every(x => typeof x === "string")
    || !absolute(m.messagingSocketPath) || path.basename(m.messagingSocketPath) !== `${identity.pid}.sock`) {
    throw new ClaudeNativeError("unsupported_contract", "Claude native registry does not prove a supported live identity");
  }
  return { cwd: m.cwd, version: m.version, socketPath: m.messagingSocketPath,
    peerProtocol: 1, peerFeatures: m.peerFeatures as string[] };
}
/** Never cache execution fences: every targeted inspection observes the current process and socket. */
async function assertLiveNativeRegistry(identity: ClaudeNativeIdentity, fields: NativeFields,
  options: ClaudeNativeDiscoveryOptions): Promise<void> {
  const run = options.run ?? runClaudeNativeCommand;
  const processInfo = (await run("/bin/ps", ["-p", String(identity.pid), "-o", "uid=", "-o", "lstart="],
    { ...process.env, LC_ALL: "C", TZ: "UTC" })).trim().replace(/\s+/gu, " ");
  if (processInfo !== `${process.getuid?.()} ${identity.processStart}`) throw new ClaudeNativeError("process_changed", "Claude process identity changed");
  await owned(await realpath(path.dirname(fields.socketPath)), "directory"); await owned(fields.socketPath, "socket");
}
function catalogEntry(identity: ClaudeNativeIdentity, fields: NativeFields, row: Record<string, unknown>,
  status: unknown): ClaudeNativeCatalogEntry {
  const statusMap = { idle: "idle", busy: "working", waiting: "waiting" } as const;
  return { ...identity, ...fields, nativeId: createClaudeNativeConversationId(identity),
    ...(typeof row.name === "string" ? { name: row.name.slice(0, 512) } : {}),
    status: typeof status === "string" ? statusMap[status as keyof typeof statusMap] ?? "unknown" : "unknown",
    ...(typeof row.waitingFor === "string" ? { waitingFor: row.waitingFor.slice(0, 256) } : {}), observedAt: new Date().toISOString() };
}
/** The agent-list row and owned registry must describe the same supported inbox. */
export async function validateClaudeNativeRegistry(configDir: string, row: Record<string, unknown>,
  options: ClaudeNativeDiscoveryOptions = {}): Promise<ClaudeNativeCatalogEntry> {
  const pid = Number(row.pid), m = await readClaudeNativeRegistry(configDir, pid);
  const identity = registryIdentity(configDir, m, pid), fields = registryFields(m, identity);
  if (row.pid !== identity.pid || row.sessionId !== identity.sessionId || row.kind !== "interactive" || row.cwd !== m.cwd) {
    throw new ClaudeNativeError("unsupported_contract", "Claude native registry and agent list do not prove a supported live identity");
  }
  await assertLiveNativeRegistry(identity, fields, options);
  // Both sources must agree. Unknown or racing state remains observable, never sendable.
  return catalogEntry(identity, fields, row, m.status === row.status ? m.status : undefined);
}
async function discoverConfigDirectory(configured: string, options: ClaudeNativeDiscoveryOptions): Promise<ClaudeNativeDiscoveryResult> {
  const errors: ClaudeNativeDiscoveryResult["errors"] = [], sessions: ClaudeNativeCatalogEntry[] = [];
  let configDir = path.resolve(configured);
  try {
    configDir = await realpath(configDir);
    const raw: unknown = JSON.parse(await readClaudeNativeAgentOutput(configDir, options));
    if (!Array.isArray(raw) || raw.length > 4096) throw new ClaudeNativeError("invalid_agent_list", "Invalid Claude agents list");
    // Bounded parallel PID checks retain input ordering without spawning one process per row at once.
    for (let index = 0; index < raw.length; index += 8) {
      const pending: Array<Promise<ClaudeNativeCatalogEntry | { configDir: string; code: string }>> = [];
      let malformed: unknown;
      for (const value of raw.slice(index, index + 8)) {
        let row: Record<string, unknown>;
        try { row = record(value); } catch (error) { malformed = error; break; }
        if (row.kind !== "interactive") continue;
        pending.push(validateClaudeNativeRegistry(configDir, row, options).catch(error => ({ configDir,
          code: error instanceof ClaudeNativeError ? error.code : "registry_unavailable" })));
      }
      for (const value of await Promise.all(pending)) {
        if ("nativeId" in value) sessions.push(value); else errors.push(value);
      }
      if (malformed) throw malformed;
    }
  } catch (error) { errors.push({ configDir, code: error instanceof ClaudeNativeError ? error.code : "discovery_unavailable" }); }
  return { sessions, errors };
}
async function discoverConfiguredSessions(configDirs: string[], options: ClaudeNativeDiscoveryOptions): Promise<ClaudeNativeDiscoveryResult> {
  const errors: ClaudeNativeDiscoveryResult["errors"] = [], sessions: ClaudeNativeCatalogEntry[] = [], seen = new Set<string>();
  for (let index = 0; index < configDirs.length; index += 4) {
    const results = await Promise.all(configDirs.slice(index, index + 4).map(dir => discoverConfigDirectory(dir, options)));
    for (const result of results) {
      errors.push(...result.errors);
      for (const entry of result.sessions) {
        if (seen.has(entry.nativeId)) errors.push({ configDir: entry.configDir, code: "duplicate_identity" });
        else { seen.add(entry.nativeId); sessions.push(entry); }
      }
    }
  }
  return { sessions, errors };
}
export async function discoverClaudeNativeSessions(options: ClaudeNativeDiscoveryOptions = {}): Promise<ClaudeNativeDiscoveryResult> {
  const configDirs = [...new Set(options.configDirs ?? [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")])].slice(0, 16);
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { sessions: [], errors: [{ configDir: "", code: "unsupported_platform" }] };
  const namespace = `claude-native-discovery:${JSON.stringify([configDirs, options.claudePath ?? "claude", platform])}`;
  const snapshot = await cliExecutionMemoAsync(namespace, options.run ?? runClaudeNativeCommand,
    () => discoverConfiguredSessions(configDirs, options));
  return structuredClone(snapshot);
}
export async function inspectClaudeNativeSession(identity: ClaudeNativeIdentity,
  options: ClaudeNativeDiscoveryOptions = {}): Promise<ClaudeNativeCatalogEntry> {
  const wanted = validateClaudeNativeIdentity(identity);
  if ((options.platform ?? process.platform) !== "darwin") throw new ClaudeNativeError("unsupported_platform", "Claude native inspection is currently validated on macOS only");
  const configDir = await realpath(wanted.configDir), m = await readClaudeNativeRegistry(configDir, wanted.pid);
  const current = registryIdentity(configDir, m, wanted.pid);
  if (createClaudeNativeConversationId(current) !== createClaudeNativeConversationId(wanted)) {
    throw new ClaudeNativeError("identity_unavailable", "Exact Claude CLI process/session is no longer available");
  }
  // Interactive registry ownership is the targeted counterpart of the agents-row filter.
  // A parked foreground process displays a background job; it is not that job's inbox.
  if (m.kind !== "interactive" || m.parkedJobId !== undefined
    || m.pidDomain !== undefined && m.pidDomain !== (options.platform ?? process.platform)) {
    throw new ClaudeNativeError("unsupported_contract", "Claude target is not an ordinary interactive session");
  }
  const fields = registryFields(m, current);
  await assertLiveNativeRegistry(current, fields, options);
  return catalogEntry(current, fields, m, m.status);
}
