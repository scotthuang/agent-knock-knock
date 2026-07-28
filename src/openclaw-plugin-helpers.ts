import path from "node:path";
import {
  executorDefinitionForAlias,
  type ExecutorKind
} from "./executors.js";

export const AKK_CALLBACK_METHOD = "agent-knock-knock.callback";

export type AkkCommand =
  | { action: "help" }
  | { action: "doctor" }
  | { action: "list" }
  | { action: "status"; conversationId?: string }
  | { action: "describe"; conversationId?: string }
  | { action: "send"; conversationId: string; message: string }
  | {
      action: "approve";
      conversationId: string;
      expectedApprovalFingerprint: string;
    }
  | { action: "cancel"; conversationId: string }
  | { action: "renew"; conversationId: string; minutes?: string }
  | { action: "retry-callback"; conversationId: string }
  | {
      action: "close";
      conversationId: string;
      reason: string;
      expectedMessageId?: string;
    }
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
  if (action === "doctor" || action === "check") {
    if (rest.trim()) {
      throw new Error("Usage: /akk doctor");
    }
    return { action: "doctor" };
  }
  if (action === "status" || action === "show") {
    const { token: conversationId, rest: extra } = takeToken(rest);
    if (extra.trim()) {
      throw new Error("Usage: /akk status [session-selector]");
    }
    return { action: "status", conversationId: conversationId || undefined };
  }
  if (action === "describe" || action === "summary" || action === "about") {
    const { token: conversationId, rest: extra } = takeToken(rest);
    if (extra.trim()) {
      throw new Error("Usage: /akk describe [session-selector]");
    }
    return { action: "describe", conversationId: conversationId || undefined };
  }
  if (action === "send" || action === "reply") {
    const { token: conversationId, rest: message } = takeRequiredToken(
      rest,
      "Usage: /akk send <session-selector>: <message>"
    );
    const body = message.trim();
    if (!body) {
      throw new Error("Usage: /akk send <session-selector>: <message>");
    }
    return {
      action: "send",
      conversationId: conversationId.replace(/:$/u, ""),
      message: body
    };
  }
  if (action === "approve") {
    const { token: conversationId, rest: approvalInput } = takeRequiredToken(
      rest,
      "Usage: /akk approve <session-selector> --expected-approval-fingerprint <fingerprint>"
    );
    const approval = /^--expected-approval-fingerprint\s+(\S+)$/u.exec(
      approvalInput.trim()
    );
    if (!approval) {
      throw new Error(
        "Usage: /akk approve <session-selector> --expected-approval-fingerprint <fingerprint>"
      );
    }
    return {
      action: "approve",
      conversationId,
      expectedApprovalFingerprint: approval[1]
    };
  }
  if (action === "cancel" || action === "stop") {
    const { token: conversationId } = takeRequiredToken(rest, "Usage: /akk cancel <session-selector>");
    return { action: "cancel", conversationId };
  }
  if (action === "renew") {
    const { token: conversationId, rest: minutesInput } = takeRequiredToken(
      rest,
      "Usage: /akk renew <session-selector> [minutes]"
    );
    const minutes = minutesInput.trim();
    if (minutes && (!Number.isFinite(Number(minutes)) || Number(minutes) <= 0)) {
      throw new Error("Usage: /akk renew <session-selector> [positive-minutes]");
    }
    return { action: "renew", conversationId, minutes: minutes || undefined };
  }
  if (action === "retry-callback" || action === "retry") {
    const { token: conversationId } = takeRequiredToken(
      rest,
      "Usage: /akk retry-callback <session-selector>"
    );
    return { action: "retry-callback", conversationId };
  }
  if (action === "close" || action === "done") {
    const { token: conversationId, rest: reason } = takeRequiredToken(
      rest,
      "Usage: /akk close <session-selector> [--expected-message-id <id>] [reason]"
    );
    const recovery = /^--expected-message-id\s+(\S+)(?:\s+([\s\S]*))?$/u.exec(
      reason.trim()
    );
    return {
      action: "close",
      conversationId,
      reason:
        recovery?.[2]?.trim() ||
        (recovery
          ? "Orphaned terminal dispatch resolved from /akk command"
          : reason.trim() || "Closed from /akk command"),
      ...(recovery?.[1]
        ? { expectedMessageId: recovery[1] }
        : {})
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
    "/akk list",
    "/akk doctor",
    "/akk status [only|latest|codex|claude|@short-ref]",
    "/akk describe [session-selector]",
    "/akk send <session-selector>: <message>",
    "/akk approve <session-selector> --expected-approval-fingerprint <fingerprint>",
    "/akk cancel <session-selector>",
    "/akk renew <session-selector> [minutes]",
    "/akk retry-callback <session-selector>",
    "/akk close <session-selector> [--expected-message-id <id>] [reason]"
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
      ...group.tasks.slice(0, 20).flatMap((task) => {
        const recovery = orphanedTerminalDispatchRecovery(task);
        return [
          `- ${formatTaskLine(task)}`,
          ...(recovery ? [`  recovery: ${recovery}`] : [])
        ];
      })
    ])
  ].join("\n");
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
    case "doctor":
      return withOptionalArgs(
        ["doctor"],
        ["--workspace", nonEmptyString(config.workspace)],
        ["--openclaw-bin", nonEmptyString(config.openclawBin)]
      );
    case "list":
      return withOptionalArgs(
        ["list"],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes]
      );
    case "status":
    case "describe":
      return withOptionalArgs(
        [
          command.action,
          ...(command.conversationId
            ? ["--conversation", command.conversationId]
            : [])
        ],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes]
      );
    case "send": {
      const openclawSession =
        nonEmptyString(context.sessionKey) ??
        "agent:main:main";
      return withOptionalArgs(
        [
          "send",
          "--conversation",
          command.conversationId,
          "--message",
          command.message,
          "--background"
        ],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes],
        ["--agent-timeout-minutes", finiteNumberString(config.agentTimeoutMinutes)],
        ["--agent-hard-timeout-minutes", finiteNumberString(config.agentHardTimeoutMinutes)],
        ["--openclaw-session", openclawSession],
        ["--gateway-method", AKK_CALLBACK_METHOD],
        ["--gateway-session", openclawSession],
        ["--openclaw-bin", nonEmptyString(config.openclawBin)]
      );
    }
    case "approve":
      return withOptionalArgs(
        [
          "approve",
          "--conversation",
          command.conversationId,
          "--expected-approval-fingerprint",
          command.expectedApprovalFingerprint
        ],
        ["--store-dir", storeDir]
      );
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
      return withOptionalArgs(
        ["cancel", "--conversation", command.conversationId],
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
        ["--expected-message-id", command.expectedMessageId],
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
  const terminalControl = task.terminal_control !== null &&
    typeof task.terminal_control === "object" &&
    !Array.isArray(task.terminal_control)
    ? task.terminal_control as Record<string, unknown>
    : {};
  const context = nonEmptyString(task.request) ??
    [
      nonEmptyString(terminalControl.target)
        ? `tmux ${nonEmptyString(terminalControl.target)}`
        : undefined,
      nonEmptyString(task.command),
      nonEmptyString(task.workspace) ?? nonEmptyString(task.cwd)
    ].filter((value): value is string => Boolean(value)).join(" · ");
  return [
    nonEmptyString(task.short_ref) ??
      nonEmptyString(task.conversation_id) ??
      nonEmptyString(task.id) ??
      "unknown",
    nonEmptyString(task.agent) ?? nonEmptyString(executor.kind) ?? "agent",
    nonEmptyString(task.status) ?? "unknown",
    truncateText(context, 90)
  ].filter(Boolean).join(" | ");
}

function orphanedTerminalDispatchRecovery(
  task: Record<string, unknown>
): string | undefined {
  const orphaned = task.orphaned_terminal_dispatch !== null &&
    typeof task.orphaned_terminal_dispatch === "object" &&
    !Array.isArray(task.orphaned_terminal_dispatch)
    ? task.orphaned_terminal_dispatch as Record<string, unknown>
    : undefined;
  return orphaned
    ? nonEmptyString(orphaned.recovery)
    : undefined;
}

function truncateText(value: unknown, maxLength: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}
