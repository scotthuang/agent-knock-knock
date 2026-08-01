import path from "node:path";

export const AKK_CALLBACK_METHOD = "agent-knock-knock.callback";
export type AkkCommand =
  | { action: "help" }
  | { action: "doctor" }
  | { action: "list" }
  | { action: "status"; conversationId?: string }
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
  | { action: "delegate"; request: string };

export function parseAkkCommand(args: unknown): AkkCommand {
  const input = String(args ?? "").trim();
  if (!input || input === "help" || input === "-h" || input === "--help") {
    return { action: "help" };
  }

  const selectorMessage = parseSelectorMessage(input);
  if (selectorMessage) {
    return {
      action: "send",
      conversationId: selectorMessage.selector,
      message: selectorMessage.message
    };
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
    throw new Error(
      "AKK describe was removed; use /akk status [session-selector]"
    );
  }
  if (action === "send" || action === "reply") {
    throw new Error(
      "AKK send syntax changed; use /akk <session-selector>: <message>"
    );
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

  return { action: "delegate", request: input };
}

export function akkUsageText(): string {
  return [
    "AKK usage:",
    "/akk <task>",
    "/akk codex: <task>",
    "/akk claude: <task>",
    "/akk <only|latest|@short-ref>: <message>",
    "/akk list",
    "/akk doctor",
    "/akk status [only|latest|codex|claude|@short-ref]",
    "/akk approve <session-selector> --expected-approval-fingerprint <fingerprint>",
    "/akk cancel <session-selector>"
  ].join("\n");
}

export function formatAkkListCommandResult(result: Record<string, unknown>): string {
  const terminals = arrayValue(result.terminals);
  const unavailableManagedTurns = arrayValue(result.unavailable_managed_turns);
  if (terminals.length === 0 && unavailableManagedTurns.length === 0) {
    return "AKK found no live terminals or unavailable managed turns.";
  }

  const terminalLines = terminals.slice(0, 20).flatMap((terminal) => {
    const managed = recordValue(terminal.managed) ?? {};
    const managementConflict = recordValue(terminal.management_conflict);
    const currentTurn = recordValue(managed.current_turn);
    const recentTurn = recordValue(managed.recent_turn);
    const history = arrayValue(managed.history);
    const hiddenTurnCount = finiteNumber(managed.hidden_turn_count) ?? 0;
    const recovery = orphanedTerminalDispatchRecovery(terminal);
    return [
      `- ${formatTerminalLine(terminal)}`,
      ...(currentTurn
        ? [`  current turn: ${formatManagedTurnLine(currentTurn)}`]
        : []),
      ...(recentTurn
        ? [`  recent turn: ${formatManagedTurnLine(recentTurn)}`]
        : []),
      ...history.slice(0, 20).map(
        (turn) => `  history: ${formatManagedTurnLine(turn)}`
      ),
      ...(hiddenTurnCount > 0 && history.length === 0
        ? [`  older managed turns: ${hiddenTurnCount} (use all=true to include)`]
        : []),
      ...(managementConflict
        ? [
            `  management conflict: ${nonEmptyString(managementConflict.reason) ?? "current terminal ownership is unresolved"}`,
            ...(nonEmptyString(managementConflict.recovery)
              ? [`  recovery: ${nonEmptyString(managementConflict.recovery)}`]
              : [])
          ]
        : []),
      ...(recovery ? [`  recovery: ${recovery}`] : [])
    ];
  });

  return [
    `AKK terminals (${terminals.length} live, ${unavailableManagedTurns.length} unavailable managed turns):`,
    ...(terminalLines.length > 0
      ? ["live terminals:", ...terminalLines]
      : []),
    ...(unavailableManagedTurns.length > 0
      ? [
          "unavailable managed turns:",
          ...unavailableManagedTurns.slice(0, 20).map(
            (turn) => `- ${formatManagedTurnLine(turn)}`
          )
        ]
      : [])
  ].join("\n");
}

export function buildAkkCommandCliArgs(
  command: AkkCommand,
  config: Record<string, unknown>,
  context: { sessionKey?: unknown } = {}
): string[] | undefined {
  switch (command.action) {
    case "help":
    case "delegate":
      return undefined;
    case "doctor":
      return withOptionalArgs(
        ["doctor"],
        ["--openclaw-bin", nonEmptyString(config.openclawBin)]
      );
  }

  const storeDir = resolvePluginStoreDir(config);
  const idleTimeoutMinutes = finiteNumberString(config.idleTimeoutMinutes);

  switch (command.action) {
    case "list":
      return withOptionalArgs(
        ["list", "--reconcile"],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes]
      );
    case "status":
      return withOptionalArgs(
        [
          "status",
          "--reconcile",
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

function parseSelectorMessage(
  input: string
): { selector: string; message: string } | undefined {
  const match =
    /^((?:(?:codex|claude):latest|only|latest|codex|claude|@[0-9a-f]+))\s*:\s*([\s\S]*)$/iu.exec(
      input
    );
  const message = match?.[2]?.trim();
  if (!match) {
    return undefined;
  }
  if (!message) {
    throw new Error("Usage: /akk <session-selector>: <message>");
  }
  return {
    selector: match[1].toLowerCase(),
    message
  };
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
  return path.resolve(gatewayCwd, configured);
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function formatTerminalLine(terminal: Record<string, unknown>): string {
  const terminalControl = recordValue(terminal.terminal_control) ?? {};
  const context = [
    nonEmptyString(terminalControl.target)
      ? `tmux ${nonEmptyString(terminalControl.target)}`
      : undefined,
    nonEmptyString(terminal.command),
    nonEmptyString(terminal.workspace) ?? nonEmptyString(terminal.cwd)
  ].filter((value): value is string => Boolean(value)).join(" · ");
  return [
    nonEmptyString(terminal.short_ref) ??
      nonEmptyString(terminal.id) ??
      "unknown",
    nonEmptyString(terminal.agent) ?? "agent",
    nonEmptyString(terminal.process_state) ?? "unknown",
    nonEmptyString(terminal.activity_state),
    truncateText(context, 90)
  ].filter(Boolean).join(" | ");
}

function formatManagedTurnLine(turn: Record<string, unknown>): string {
  const executor = recordValue(turn.executor) ?? {};
  const context = nonEmptyString(turn.request) ??
    [
      nonEmptyString(turn.workspace),
      nonEmptyString(turn.callback_state)
    ].filter((value): value is string => Boolean(value)).join(" · ");
  return [
    nonEmptyString(turn.short_ref) ??
      nonEmptyString(turn.conversation_id) ??
      nonEmptyString(turn.id) ??
      "unknown",
    nonEmptyString(turn.agent) ?? nonEmptyString(executor.kind) ?? "agent",
    nonEmptyString(turn.lifecycle_state) ?? nonEmptyString(turn.status) ?? "unknown",
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
