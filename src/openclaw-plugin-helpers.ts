import path from "node:path";
import {
  executorDefinitionForAlias,
  type ExecutorKind
} from "./executors.js";

export const AKK_CALLBACK_METHOD = "agent-knock-knock.callback";

export type AkkCommand =
  | { action: "help" }
  | { action: "list" }
  | { action: "status"; conversationId: string }
  | { action: "describe"; conversationId: string }
  | { action: "send"; conversationId: string; message: string }
  | { action: "cancel"; conversationId: string }
  | { action: "renew"; conversationId: string; minutes?: string }
  | { action: "retry-callback"; conversationId: string }
  | { action: "recover"; conversationId: string }
  | { action: "close"; conversationId: string; reason: string }
  | { action: "delegate"; agent?: ExecutorKind; request: string };

export function parseAkkCommand(args: unknown): AkkCommand {
  const input = String(args ?? "").trim();
  if (!input || input === "help" || input === "-h" || input === "--help") {
    return { action: "help" };
  }

  const { token, rest } = takeToken(input);
  const action = token.toLowerCase();
  if (action === "list" || action === "ls" || action === "tasks") {
    return { action: "list" };
  }
  if (action === "status" || action === "show") {
    const { token: conversationId } = takeRequiredToken(rest, "Usage: /akk status <conversation-id>");
    return { action: "status", conversationId };
  }
  if (action === "describe" || action === "summary" || action === "about") {
    const { token: conversationId } = takeRequiredToken(rest, "Usage: /akk describe <conversation-id>");
    return { action: "describe", conversationId };
  }
  if (action === "send" || action === "reply") {
    const { token: conversationId, rest: message } = takeRequiredToken(
      rest,
      "Usage: /akk send <conversation-id> <message>"
    );
    const body = message.trim();
    if (!body) {
      throw new Error("Usage: /akk send <conversation-id> <message>");
    }
    return { action: "send", conversationId, message: body };
  }
  if (action === "cancel" || action === "stop") {
    const { token: conversationId } = takeRequiredToken(rest, "Usage: /akk cancel <conversation-id>");
    return { action: "cancel", conversationId };
  }
  if (action === "renew") {
    const { token: conversationId, rest: minutesInput } = takeRequiredToken(
      rest,
      "Usage: /akk renew <conversation-id> [minutes]"
    );
    const minutes = minutesInput.trim();
    if (minutes && (!Number.isFinite(Number(minutes)) || Number(minutes) <= 0)) {
      throw new Error("Usage: /akk renew <conversation-id> [positive-minutes]");
    }
    return { action: "renew", conversationId, minutes: minutes || undefined };
  }
  if (action === "retry-callback" || action === "retry") {
    const { token: conversationId } = takeRequiredToken(
      rest,
      "Usage: /akk retry-callback <conversation-id>"
    );
    return { action: "retry-callback", conversationId };
  }
  if (action === "recover") {
    const { token: conversationId } = takeRequiredToken(rest, "Usage: /akk recover <conversation-id>");
    return { action: "recover", conversationId };
  }
  if (action === "close" || action === "done") {
    const { token: conversationId, rest: reason } = takeRequiredToken(
      rest,
      "Usage: /akk close <conversation-id> [reason]"
    );
    return {
      action: "close",
      conversationId,
      reason: reason.trim() || "Closed from /akk command"
    };
  }

  const executorDefinition = executorDefinitionForAlias(action);
  if (executorDefinition) {
    const request = rest.trim();
    if (!request) {
      throw new Error(`Usage: /akk ${executorDefinition.kind} <task>`);
    }
    return {
      action: "delegate",
      agent: executorDefinition.kind,
      request
    };
  }

  // Leaving agent unset is intentional: runDelegate applies the configured
  // defaultAgent and falls back to Codex only when no default is configured.
  return { action: "delegate", request: input };
}

export function akkUsageText(): string {
  return [
    "AKK usage:",
    "/akk <task>",
    "/akk codex <task>",
    "/akk claude <task>",
    "/akk cursor <task>",
    "/akk list",
    "/akk status <conversation-id>",
    "/akk describe <conversation-id>",
    "/akk send <conversation-id> <message>",
    "/akk cancel <conversation-id>",
    "/akk renew <conversation-id> [minutes]",
    "/akk retry-callback <conversation-id>",
    "/akk recover <conversation-id>",
    "/akk close <conversation-id> [reason]"
  ].join("\n");
}

export function formatAkkListCommandResult(result: Record<string, unknown>): string {
  const groups = [
    {
      label: "delegated",
      tasks: arrayValue(result.delegated).length > 0
        ? arrayValue(result.delegated)
        : arrayValue(result.tasks)
    },
    { label: "terminal-controlled", tasks: arrayValue(result.terminal_controlled) },
    { label: "native", tasks: arrayValue(result.native) }
  ].filter((group) => group.tasks.length > 0);
  const total = groups.reduce((count, group) => count + group.tasks.length, 0);
  if (total === 0) {
    return "AKK has no open sessions.";
  }
  return [
    `AKK open sessions (${total}):`,
    ...groups.flatMap((group) => [
      `${group.label}:`,
      ...group.tasks.slice(0, 20).map((task) => `- ${formatTaskLine(task)}`)
    ])
  ].join("\n");
}

export function resolveConversationOverrides(
  params: Record<string, unknown>,
  config: Record<string, unknown>
): { allProxy?: string; model?: string } {
  return {
    allProxy: nonEmptyString(params.allProxy) ?? nonEmptyString(config.allProxy),
    model: nonEmptyString(params.model) ?? nonEmptyString(config.model)
  };
}

export function buildAkkCommandCliArgs(
  command: AkkCommand,
  config: Record<string, unknown>,
  context: { sessionKey?: unknown } = {}
): string[] | undefined {
  const storeDir = resolvePluginStoreDir(config);
  const idleTimeoutMinutes = finiteNumberString(config.idleTimeoutMinutes);

  switch (command.action) {
    case "help":
    case "delegate":
      return undefined;
    case "list":
      return withOptionalArgs(
        ["list"],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes]
      );
    case "status":
    case "describe":
      return withOptionalArgs(
        [command.action, "--conversation", command.conversationId],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes]
      );
    case "send": {
      const openclawSession =
        nonEmptyString(context.sessionKey) ??
        nonEmptyString(config.openclawSession) ??
        "agent:main:main";
      const overrides = resolveConversationOverrides({}, config);
      return withOptionalArgs(
        [
          "send",
          "--conversation",
          command.conversationId,
          "--message",
          command.message,
          "--background"
        ],
        ["--all-proxy", overrides.allProxy],
        ["--model", overrides.model],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes],
        ["--agent-timeout-minutes", finiteNumberString(config.agentTimeoutMinutes)],
        ["--agent-hard-timeout-minutes", finiteNumberString(config.agentHardTimeoutMinutes)],
        ["--openclaw-session", openclawSession],
        ["--gateway-method", AKK_CALLBACK_METHOD],
        ["--gateway-session", openclawSession],
        ["--openclaw-bin", nonEmptyString(config.openclawBin)],
        ["--callback-command", nonEmptyString(config.callbackCommand)],
        ["--soft-limit", finiteNumberString(config.softLimit)],
        ["--hard-limit", finiteNumberString(config.hardLimit)]
      );
    }
    case "renew":
      return withOptionalArgs(
        ["renew", "--conversation", command.conversationId],
        [
          "--minutes",
          command.minutes ?? finiteNumberString(config.agentTimeoutMinutes)
        ],
        ["--store-dir", storeDir]
      );
    case "retry-callback":
      return withOptionalArgs(
        ["retry-callback", "--conversation", command.conversationId],
        ["--store-dir", storeDir]
      );
    case "cancel": {
      const overrides = resolveConversationOverrides({}, config);
      return withOptionalArgs(
        ["cancel", "--conversation", command.conversationId],
        ["--all-proxy", overrides.allProxy],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes]
      );
    }
    case "recover": {
      const overrides = resolveConversationOverrides({}, config);
      return withOptionalArgs(
        ["recover", "--conversation", command.conversationId, "--background"],
        ["--all-proxy", overrides.allProxy],
        ["--model", overrides.model],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes]
      );
    }
    case "close":
      return withOptionalArgs(
        [
          "close",
          "--conversation",
          command.conversationId,
          "--reason",
          command.reason
        ],
        ["--store-dir", storeDir]
      );
  }
}

export function resolvePluginStoreDir(
  config: Record<string, unknown>,
  gatewayCwd = process.cwd()
): string | undefined {
  const configured = nonEmptyString(config.storeDir);
  if (!configured) {
    return undefined;
  }
  if (path.isAbsolute(configured)) {
    return path.normalize(configured);
  }
  const configuredWorkspace = nonEmptyString(config.workspace);
  const workspace = configuredWorkspace
    ? path.resolve(gatewayCwd, configuredWorkspace)
    : path.resolve(gatewayCwd);
  return path.resolve(workspace, configured);
}

function takeRequiredToken(input: unknown, usage: string): { token: string; rest: string } {
  const parsed = takeToken(input);
  if (!parsed.token) {
    throw new Error(usage);
  }
  return parsed;
}

function takeToken(input: unknown): { token: string; rest: string } {
  const value = String(input ?? "").trimStart();
  const match = value.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { token: "", rest: "" };
  }
  return {
    token: match[1],
    rest: match[2] ?? ""
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function finiteNumberString(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

function withOptionalArgs(
  args: string[],
  ...optionalArgs: Array<[flag: string, value: string | undefined]>
): string[] {
  for (const [flag, value] of optionalArgs) {
    if (value !== undefined && value !== "") {
      args.push(flag, value);
    }
  }
  return args;
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

function formatTaskLine(task: Record<string, unknown>): string {
  const executor = task.executor !== null &&
    typeof task.executor === "object" &&
    !Array.isArray(task.executor)
    ? task.executor as Record<string, unknown>
    : {};
  return [
    nonEmptyString(task.conversation_id) ?? nonEmptyString(task.id) ?? "unknown",
    nonEmptyString(task.agent) ?? nonEmptyString(executor.kind) ?? "agent",
    nonEmptyString(task.status) ?? "unknown",
    truncateText(task.request, 90)
  ].filter(Boolean).join(" | ");
}

function truncateText(value: unknown, maxLength: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}
