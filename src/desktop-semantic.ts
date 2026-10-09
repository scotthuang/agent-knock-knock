import { isDesktopConversationId, parseDesktopConversationId } from "./desktop-identity.js";
import { requiredString, pushOptional, numberString } from "./semantic-tool-arguments.js";
import { resolvePluginStoreDir } from "./semantic-tool-command-helpers.js";

/** Separate Desktop addressing from all terminal/managed-turn authority paths. */
export function desktopSendToolArgs(params: Record<string, unknown>, config: Record<string, unknown>,
  context: { sessionKey?: unknown }, messageId?: string): string[] | undefined {
  if (!Object.hasOwn(params, "conversation_id")) return undefined;
  const id = requiredString(params.conversation_id, "conversation_id");
  if (!isDesktopConversationId(id)) throw new Error("Send conversation_id must be an exact Desktop ID from List");
  parseDesktopConversationId(id);
  if (["turn_id", "terminal_id", "session_id"].some(key => Object.hasOwn(params, key))) {
    throw new Error("Desktop Send accepts one conversation_id and no other target");
  }
  if (params.type !== undefined && params.type !== "task") throw new Error("Desktop v1 sends tasks only");
  const args = ["send", "--conversation", id, "--message", requiredString(params.request, "request"), "--background",
    "--openclaw-session", requiredString(context.sessionKey, "controller session")];
  args.push("--message-id", requiredString(messageId, "stable Desktop tool call identity"));
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--openclaw-bin", config.openclawBin);
  pushOptional(args, "--agent-hard-timeout-minutes", numberString(params.agentHardTimeoutMinutes) ?? numberString(config.agentHardTimeoutMinutes));
  return args;
}

export function desktopWatchTarget(params: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(params, "conversation_id")) return undefined;
  if (Object.hasOwn(params, "terminal_id")) throw new Error("Watch accepts one terminal_id or Desktop conversation_id");
  const id = requiredString(params.conversation_id, "conversation_id");
  parseDesktopConversationId(id);
  return id;
}

export function isDesktopWatchId(value: unknown): value is string {
  return typeof value === "string" && /^desktop-watch:[A-Za-z0-9_-]{8,128}$/u.test(value);
}

export function validatedDesktopWatchId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("desktop-watch:")) return undefined;
  if (!isDesktopWatchId(value)) throw new Error("Invalid Desktop Watch ID");
  return value;
}
