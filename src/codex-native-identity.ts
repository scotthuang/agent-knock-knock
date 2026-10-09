import path from "node:path";
import type { CodexNativeIdentity } from "./codex-native-types.js";

const PREFIX = "codex-cli:v1:";
export function createCodexNativeConversationId(identity: CodexNativeIdentity): string {
  const { codexHome, threadId } = validate(identity);
  return PREFIX + Buffer.from(JSON.stringify([codexHome, threadId])).toString("base64url");
}
export function parseCodexNativeConversationId(value: string): CodexNativeIdentity {
  if (!isCodexNativeConversationId(value) || value.length > 4096) throw new Error("Invalid Codex CLI conversation ID");
  const encoded = value.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error("Invalid Codex CLI conversation encoding");
  let tuple: unknown;
  try { tuple = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid Codex CLI conversation payload"); }
  if (!Array.isArray(tuple) || tuple.length !== 2) throw new Error("Invalid Codex CLI conversation payload");
  const identity = validate({ codexHome: tuple[0], threadId: tuple[1] });
  if (createCodexNativeConversationId(identity) !== value) throw new Error("Non-canonical Codex CLI conversation ID");
  return identity;
}
export function isCodexNativeConversationId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}
/** Both send-derived digest IDs and externally watched task UUIDs are durable Watch IDs. */
export function isCodexNativeWatchId(value: unknown): value is string {
  return typeof value === "string" && /^codex-cli-watch:[A-Za-z0-9_-]{8,128}$/u.test(value);
}
function validate(value: CodexNativeIdentity): CodexNativeIdentity {
  if (typeof value.codexHome !== "string" || !path.isAbsolute(value.codexHome)
    || value.codexHome.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value.codexHome)
    || typeof value.threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,160}$/u.test(value.threadId)) {
    throw new Error("Invalid Codex CLI native identity");
  }
  return { codexHome: path.resolve(value.codexHome), threadId: value.threadId };
}
