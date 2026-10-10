import { resolveMonitorHardTimeoutMinutes } from "./monitor-deadline-policy.js";
import { pushOptional, requiredControllerSessionKey, requiredString } from "./semantic-tool-arguments.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export type BackendRecoveryCommand = "renew" | "close" | "recover" | "retry-callback";
const commands = new Set<string>(["renew", "close", "recover", "retry-callback"]);
const backendIdentity = /^(?:desktop|codex-cli):/u;
const backendWatchPrefix = /^(?:desktop-watch|codex-cli-watch):/u;
const backendWatch = /^(?:desktop-watch|codex-cli-watch):[A-Za-z0-9_-]{8,128}$/u;

export function isBackendTaskWatchId(value: unknown): value is string {
  return typeof value === "string" && backendWatch.test(value);
}

export function normalizeBackendStatusTarget(params: Record<string, unknown>): Record<string, unknown> {
  if (typeof params.turn_id !== "string" || !backendWatchPrefix.test(params.turn_id.trim())) return params;
  if (Object.hasOwn(params, "watch_id") || Object.hasOwn(params, "conversation_id")) throw new Error("status accepts exactly one of turn_id, conversation_id, or watch_id");
  if (!backendWatch.test(params.turn_id)) throw new Error("status requires an exact backend Watch ID");
  const { turn_id, ...rest } = params;
  return { ...rest, watch_id: turn_id };
}

/** Backend maintenance is anchored to one persisted task, never the thread's current task. */
export function backendRecoveryTarget(params: Record<string, unknown>, command: BackendRecoveryCommand): string | undefined {
  const targets = ["watch_id", "turn_id", "conversation_id"].filter(key => Object.hasOwn(params, key));
  if (targets.length !== 1) throw new Error(`${command} accepts exactly one of watch_id, turn_id or conversation_id`);
  const field = targets[0];
  const id = requiredString(params[field], field);
  if (backendIdentity.test(id.trim()) || field === "conversation_id" && backendWatchPrefix.test(id.trim())) {
    throw new Error(`${command} requires the exact backend watch_id or send-produced turn_id; conversation_id cannot select a backend task`);
  }
  if (backendWatchPrefix.test(id.trim()) || field === "watch_id" || command === "recover") {
    if (!backendWatch.test(id)) throw new Error(`${command} requires an exact backend Watch ID`);
    return id;
  }
  return undefined;
}

export function backendRecoveryToolArgs(command: BackendRecoveryCommand, params: Record<string, unknown>,
  context: { sessionKey?: unknown }, options: { storeDir?: string; codexHome?: string; defaultMinutes?: number } = {}): string[] | undefined {
  const id = backendRecoveryTarget(params, command);
  if (!id) {
    if (Object.hasOwn(params, "notification_id")) throw new Error("notification_id is supported only for backend callback recovery");
    return undefined;
  }
  const fields = command === "renew" ? ["minutes"] : command === "close" ? ["reason"] : command === "retry-callback" ? ["notification_id"] : [];
  const allowed = new Set(["watch_id", "turn_id", ...fields]);
  const extra = Object.keys(params).filter(key => !allowed.has(key));
  if (extra.length) throw new Error(`Unsupported backend ${command} parameters: ${extra.join(", ")}`);
  const args = [command, "--watch", id, "--openclaw-session", requiredControllerSessionKey(context.sessionKey)];
  pushOptional(args, "--store-dir", options.storeDir);
  pushOptional(args, "--codex-home", options.codexHome);
  if (command === "renew") {
    const supplied = params.minutes ?? options.defaultMinutes;
    if (supplied !== undefined && (typeof supplied !== "number" || !Number.isFinite(supplied) || supplied <= 0)) {
      throw new Error("minutes must be a positive number");
    }
    args.push("--minutes", String(resolveMonitorHardTimeoutMinutes(params.minutes, options.defaultMinutes)));
  }
  if (Object.hasOwn(params, "reason")) args.push("--reason", requiredString(params.reason, "reason"));
  if (Object.hasOwn(params, "notification_id")) args.push("--notification-id", requiredString(params.notification_id, "notification_id"));
  return args;
}

/** Run before conversation routing, which must never reinterpret a backend recovery target. */
export function assertBackendRecoveryCliTarget(command: string | undefined, options: Record<string, unknown>): void {
  if (!command || !commands.has(command)) return;
  const fields = ["watch", "turn", "conversation", "conversationId", "terminal", "session"];
  const targets = fields.filter(key => Object.hasOwn(options, key));
  const hasBackend = targets.some(key => typeof options[key] === "string" &&
    (backendIdentity.test((options[key] as string).trim()) || backendWatchPrefix.test((options[key] as string).trim())));
  if (command !== "recover" && !hasBackend && !Object.hasOwn(options, "watch")) {
    if (Object.hasOwn(options, "notificationId")) throw new Error("--notification-id is supported only for backend callback recovery");
    return;
  }
  if (targets.length !== 1 || !["watch", "turn"].includes(targets[0]) || !backendWatch.test(String(options[targets[0]]))) {
    throw new Error(`${command} requires exactly one --watch or --turn containing an exact backend Watch ID`);
  }
  requiredControllerSessionKey(options.openclawSession);
  const fences = Object.keys(options).filter(key => /^expected/u.test(key));
  if (fences.length) throw new Error(`Backend ${command} does not accept terminal recovery fences: ${fences.join(", ")}`);
  if (command !== "retry-callback" && Object.hasOwn(options, "notificationId")) {
    throw new Error("--notification-id is supported only by retry-callback");
  }
  if (Object.hasOwn(options, "notificationId")) requiredString(options.notificationId, "notification-id");
}

/** Report observed delivery state without turning a retry attempt into a delivery receipt. */
export function formatBackendRecoveryCommandResult(result: unknown, command: BackendRecoveryCommand): string | undefined {
  if (!isRecord(result) || !backendWatch.test(String(result.watch_id))) return undefined;
  const fields = ["watch_id", "turn_id", "task_kind", "native_turn_id", "status", "management_state", "observation_state", "closed_at", "unwatched_at", "hard_timeout_at", "deadline_at"];
  const lines = fields.flatMap(field => {
    const value = nonBlankString(result[field]);
    return value ? [`${field}: ${value}`] : [];
  });
  if (Array.isArray(result.callback_notifications)) {
    for (const notification of result.callback_notifications) {
      if (!isRecord(notification)) continue;
      const id = nonBlankString(notification.notification_id) ?? nonBlankString(notification.id);
      const status = nonBlankString(notification.status);
      if (id && status) lines.push(`callback ${id}: ${status}`);
    }
  }
  return [`AKK backend ${command}.`, ...lines].join("\n");
}
