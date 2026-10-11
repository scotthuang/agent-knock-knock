import path from "node:path";

export interface ClaudeNativeIdentity {
  configDir: string;
  sessionId: string;
  pid: number;
  /** Native registry/OS `LC_ALL=C TZ=UTC ps lstart` value, whitespace normalized. */
  processStart: string;
}
export interface ClaudeNativeCatalogEntry extends ClaudeNativeIdentity {
  nativeId: string;
  cwd: string;
  name?: string;
  version: string;
  socketPath: string;
  peerProtocol: number;
  peerFeatures: string[];
  status: "idle" | "working" | "waiting" | "unknown";
  waitingFor?: string;
  observedAt: string;
}
export class ClaudeNativeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ClaudeNativeError"; }
}
const PREFIX = "claude-cli:v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function isClaudeNativeUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
export function validateClaudeNativeIdentity(value: ClaudeNativeIdentity): ClaudeNativeIdentity {
  if (!value || typeof value.configDir !== "string" || !path.isAbsolute(value.configDir)
    || value.configDir.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value.configDir)
    || !isClaudeNativeUuid(value.sessionId) || !Number.isSafeInteger(value.pid) || value.pid < 1
    || typeof value.processStart !== "string" || value.processStart.length > 128
    || !/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(value.processStart)) {
    throw new ClaudeNativeError("invalid_identity", "Invalid Claude CLI native identity");
  }
  return { configDir: path.resolve(value.configDir), sessionId: value.sessionId,
    pid: value.pid, processStart: value.processStart };
}
export function createClaudeNativeConversationId(value: ClaudeNativeIdentity): string {
  const { configDir, sessionId, pid, processStart } = validateClaudeNativeIdentity(value);
  return PREFIX + Buffer.from(JSON.stringify([configDir, sessionId, pid, processStart])).toString("base64url");
}
export function isClaudeNativeConversationId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}
export function parseClaudeNativeConversationId(value: string): ClaudeNativeIdentity {
  if (!isClaudeNativeConversationId(value) || value.length > 4096 || !/^[\w-]+$/u.test(value.slice(PREFIX.length))) {
    throw new ClaudeNativeError("invalid_identity", "Invalid Claude CLI conversation ID");
  }
  let tuple: unknown;
  try { tuple = JSON.parse(Buffer.from(value.slice(PREFIX.length), "base64url").toString("utf8")); }
  catch { throw new ClaudeNativeError("invalid_identity", "Invalid Claude CLI conversation payload"); }
  if (!Array.isArray(tuple) || tuple.length !== 4) throw new ClaudeNativeError("invalid_identity", "Invalid Claude CLI identity tuple");
  const identity = validateClaudeNativeIdentity({ configDir: tuple[0], sessionId: tuple[1], pid: tuple[2], processStart: tuple[3] });
  if (createClaudeNativeConversationId(identity) !== value) throw new ClaudeNativeError("invalid_identity", "Non-canonical Claude CLI identity");
  return identity;
}
export function isClaudeNativeWatchId(value: unknown): value is string {
  return typeof value === "string" && /^claude-cli-watch:[A-Za-z0-9_-]{8,128}$/u.test(value);
}
