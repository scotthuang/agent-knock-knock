import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
/** The agent-list row and owned registry must describe the same supported inbox. */
function catalogFields(m: Record<string, unknown>, row: Record<string, unknown>, identity: ClaudeNativeIdentity):
  Pick<ClaudeNativeCatalogEntry, "cwd" | "version" | "socketPath" | "peerProtocol" | "peerFeatures"> {
  if (m.pid !== identity.pid || row.pid !== identity.pid || row.sessionId !== identity.sessionId || row.kind !== "interactive"
    || !absolute(m.cwd) || row.cwd !== m.cwd || typeof m.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(m.version)
    || m.peerProtocol !== 1 || !Array.isArray(m.peerFeatures) || !m.peerFeatures.every(x => typeof x === "string")
    || !absolute(m.messagingSocketPath) || path.basename(m.messagingSocketPath) !== `${identity.pid}.sock`) {
    throw new ClaudeNativeError("unsupported_contract", "Claude native registry and agent list do not prove a supported live identity");
  }
  return { cwd: m.cwd, version: m.version, socketPath: m.messagingSocketPath,
    peerProtocol: 1, peerFeatures: m.peerFeatures as string[] };
}
export async function validateClaudeNativeRegistry(configDir: string, row: Record<string, unknown>,
  options: ClaudeNativeDiscoveryOptions = {}): Promise<ClaudeNativeCatalogEntry> {
  const pid = Number(row.pid), m = await readClaudeNativeRegistry(configDir, pid);
  const processStart = typeof m.procStart === "string" ? m.procStart.trim().replace(/\s+/gu, " ") : "";
  const identity = validateClaudeNativeIdentity({ configDir, sessionId: String(m.sessionId), pid, processStart });
  const fields = catalogFields(m, row, identity);
  const run = options.run ?? runClaudeNativeCommand;
  const processInfo = (await run("/bin/ps", ["-p", String(pid), "-o", "uid=", "-o", "lstart="],
    { ...process.env, LC_ALL: "C", TZ: "UTC" })).trim().replace(/\s+/gu, " ");
  if (processInfo !== `${process.getuid?.()} ${processStart}`) throw new ClaudeNativeError("process_changed", "Claude process identity changed");
  const socketPath = fields.socketPath;
  await owned(await realpath(path.dirname(socketPath)), "directory"); await owned(socketPath, "socket");
  const statusMap = { idle: "idle", busy: "working", waiting: "waiting" } as const;
  // Both sources must agree. Unknown or racing state remains observable, never sendable.
  const status = m.status === row.status && typeof m.status === "string"
    ? statusMap[m.status as keyof typeof statusMap] ?? "unknown" : "unknown";
  return { ...identity, ...fields, nativeId: createClaudeNativeConversationId(identity),
    ...(typeof row.name === "string" ? { name: row.name.slice(0, 512) } : {}), status,
    ...(typeof row.waitingFor === "string" ? { waitingFor: row.waitingFor.slice(0, 256) } : {}), observedAt: new Date().toISOString() };
}
export async function discoverClaudeNativeSessions(options: ClaudeNativeDiscoveryOptions = {}): Promise<ClaudeNativeDiscoveryResult> {
  const errors: ClaudeNativeDiscoveryResult["errors"] = [], sessions: ClaudeNativeCatalogEntry[] = [];
  const configDirs = [...new Set(options.configDirs ?? [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")])];
  if ((options.platform ?? process.platform) !== "darwin") return { sessions, errors: [{ configDir: "", code: "unsupported_platform" }] };
  const run = options.run ?? runClaudeNativeCommand;
  for (const configured of configDirs.slice(0, 16)) {
    let configDir = path.resolve(configured);
    try {
      configDir = await realpath(configDir);
      const raw: unknown = JSON.parse(await run(options.claudePath ?? "claude", ["agents", "--json", "--all"],
        { ...process.env, CLAUDE_CONFIG_DIR: configDir }));
      if (!Array.isArray(raw) || raw.length > 4096) throw new ClaudeNativeError("invalid_agent_list", "Invalid Claude agents list");
      for (const value of raw) {
        const row = record(value); if (row.kind !== "interactive") continue;
        try {
          const entry = await validateClaudeNativeRegistry(configDir, row, options);
          if (sessions.some(s => s.nativeId === entry.nativeId)) throw new ClaudeNativeError("duplicate_identity", "Duplicate native agent identity");
          sessions.push(entry);
        } catch (error) { errors.push({ configDir, code: error instanceof ClaudeNativeError ? error.code : "registry_unavailable" }); }
      }
    } catch (error) { errors.push({ configDir, code: error instanceof ClaudeNativeError ? error.code : "discovery_unavailable" }); }
  }
  return { sessions, errors };
}
export async function inspectClaudeNativeSession(identity: ClaudeNativeIdentity,
  options: ClaudeNativeDiscoveryOptions = {}): Promise<ClaudeNativeCatalogEntry> {
  const wanted = validateClaudeNativeIdentity(identity);
  const result = await discoverClaudeNativeSessions({ ...options, configDirs: [wanted.configDir] });
  const found = result.sessions.find(s => s.nativeId === createClaudeNativeConversationId(wanted));
  if (!found) throw new ClaudeNativeError("identity_unavailable", "Exact Claude CLI process/session is no longer available");
  return found;
}
