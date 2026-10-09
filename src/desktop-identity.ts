import path from "node:path";
import type { DesktopThreadIdentity } from "./desktop-types.js";

const PREFIX = "desktop:v1:";

/** Desktop identity is independent of a window, mutable title, or current IPC owner. */
export function createDesktopConversationId(identity: DesktopThreadIdentity): string {
  const value = validate(identity);
  return PREFIX + Buffer.from(JSON.stringify([value.codexHome, value.hostId, value.threadId])).toString("base64url");
}

export function parseDesktopConversationId(value: string): DesktopThreadIdentity {
  if (!isDesktopConversationId(value) || value.length > 4096) throw new Error("Invalid Desktop conversation ID");
  const encoded = value.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error("Invalid Desktop conversation ID encoding");
  let tuple: unknown;
  try { tuple = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid Desktop conversation ID payload"); }
  if (!Array.isArray(tuple) || tuple.length !== 3) throw new Error("Invalid Desktop conversation ID payload");
  const identity = validate({ codexHome: tuple[0], hostId: tuple[1], threadId: tuple[2] });
  if (createDesktopConversationId(identity) !== value) throw new Error("Non-canonical Desktop conversation ID");
  return identity;
}

export function isDesktopConversationId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function validate(value: DesktopThreadIdentity): DesktopThreadIdentity {
  if (typeof value.codexHome !== "string" || !path.isAbsolute(value.codexHome) ||
      /[\u0000-\u001f\u007f]/u.test(value.codexHome) || value.codexHome.length > 2048 ||
      typeof value.hostId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.hostId) ||
      typeof value.threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,160}$/u.test(value.threadId)) {
    throw new Error("Invalid Desktop native identity");
  }
  return { codexHome: path.resolve(value.codexHome), hostId: value.hostId, threadId: value.threadId };
}
