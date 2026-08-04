import path from "node:path";

export const AKK_CALLBACK_METHOD = "agent-knock-knock.callback";
export type AkkCommand =
  | { action: "help" }
  | { action: "doctor" }
  | { action: "list" }
  | { action: "status"; turnId?: string }
  | { action: "send"; selector: string; message: string }
  | { action: "respond"; turnId: string; message: string }
  | {
      action: "approve";
      turnId: string;
      expectedApprovalFingerprint: string;
    }
  | { action: "cancel"; turnId: string }
  | { action: "renew"; turnId: string; minutes?: string }
  | { action: "retry-callback"; turnId: string }
  | {
      action: "close";
      turnId: string;
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
      selector: selectorMessage.selector,
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
    const { token: turnId, rest: extra } = takeToken(rest);
    if (extra.trim()) {
      throw new Error("Usage: /akk status [turn-selector]");
    }
    return { action: "status", turnId: turnId || undefined };
  }
  if (action === "describe" || action === "summary" || action === "about") {
    throw new Error(
      "AKK describe was removed; use /akk status [turn-selector]"
    );
  }
  if (action === "respond") {
    const response = parseTurnResponse(rest);
    return {
      action: "respond",
      turnId: response.selector,
      message: response.message
    };
  }
  if (action === "send") {
    throw new Error(
      "AKK send syntax changed; use /akk <session-selector>: <message>"
    );
  }
  if (action === "reply") {
    throw new Error(
      "AKK reply syntax changed; use /akk respond <turn-selector>: <answer>"
    );
  }
  if (action === "approve") {
    const { token: turnId, rest: approvalInput } = takeRequiredToken(
      rest,
      "Usage: /akk approve <turn-selector> --expected-approval-fingerprint <fingerprint>"
    );
    const approval = /^--expected-approval-fingerprint\s+(\S+)$/u.exec(
      approvalInput.trim()
    );
    if (!approval) {
      throw new Error(
        "Usage: /akk approve <turn-selector> --expected-approval-fingerprint <fingerprint>"
      );
    }
    return {
      action: "approve",
      turnId,
      expectedApprovalFingerprint: approval[1]
    };
  }
  if (action === "cancel" || action === "stop") {
    const { token: turnId } = takeRequiredToken(rest, "Usage: /akk cancel <turn-selector>");
    return { action: "cancel", turnId };
  }
  if (action === "renew") {
    const { token: turnId, rest: minutesInput } = takeRequiredToken(
      rest,
      "Usage: /akk renew <turn-selector> [minutes]"
    );
    const minutes = minutesInput.trim();
    if (minutes && (!Number.isFinite(Number(minutes)) || Number(minutes) <= 0)) {
      throw new Error("Usage: /akk renew <turn-selector> [positive-minutes]");
    }
    return { action: "renew", turnId, minutes: minutes || undefined };
  }
  if (action === "retry-callback" || action === "retry") {
    const { token: turnId } = takeRequiredToken(
      rest,
      "Usage: /akk retry-callback <turn-selector>"
    );
    return { action: "retry-callback", turnId };
  }
  if (action === "close" || action === "done") {
    const { token: turnId, rest: reason } = takeRequiredToken(
      rest,
      "Usage: /akk close <turn-selector> [--expected-message-id <id>] [reason]"
    );
    const recovery = /^--expected-message-id\s+(\S+)(?:\s+([\s\S]*))?$/u.exec(
      reason.trim()
    );
    return {
      action: "close",
      turnId,
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
    "/akk <request>",
    "/akk codex: <request>",
    "/akk claude: <request>",
    "/akk <session-selector>: <message>",
    "/akk list",
    "/akk doctor",
    "/akk status [turn-selector]",
    "/akk respond <turn-selector>: <answer>",
    "/akk approve <turn-selector> --expected-approval-fingerprint <fingerprint>",
    "/akk cancel <turn-selector>"
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
    const sessionId = nonEmptyString(managed.session_id);
    const sessionShortRef = nonEmptyString(managed.session_short_ref);
    const hiddenTurnCount = finiteNumber(managed.hidden_turn_count) ?? 0;
    const recovery = orphanedTerminalDispatchRecovery(terminal);
    return [
      `- ${formatTerminalLine(terminal)}`,
      ...(sessionId || sessionShortRef
        ? [`  AKK session: ${sessionShortRef ?? sessionId}`]
        : []),
      ...formatAvailableActions("terminal actions", terminal),
      ...(currentTurn
        ? [
            `  current turn: ${formatManagedTurnLine(currentTurn)}`,
            ...formatAvailableActions("current turn actions", currentTurn)
          ]
        : []),
      ...(recentTurn
        ? [
            `  recent turn: ${formatManagedTurnLine(recentTurn)}`,
            ...formatAvailableActions("recent turn actions", recentTurn)
          ]
        : []),
      ...history.slice(0, 20).flatMap(
        (turn) => [
          `  history: ${formatManagedTurnLine(turn)}`,
          ...formatAvailableActions("history actions", turn)
        ]
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
          ...unavailableManagedTurns.slice(0, 20).flatMap(
            (turn) => [
              `- ${formatManagedTurnLine(turn)}`,
              ...formatAvailableActions("  actions", turn)
            ]
          )
        ]
      : [])
  ].join("\n");
}

export function formatAkkRespondCommandResult(
  result: Record<string, unknown>
): { text: string; isError: boolean } {
  const conversation = recordValue(result.conversation) ?? {};
  const compatibilityId =
    nonEmptyString(conversation.conversation_id) ??
    nonEmptyString(result.conversation_id) ??
    "unknown";
  const sessionId =
    nonEmptyString(conversation.session_id) ??
    nonEmptyString(result.session_id) ??
    compatibilityId;
  const turnId =
    nonEmptyString(conversation.turn_id) ??
    nonEmptyString(result.turn_id) ??
    compatibilityId;
  const status =
    nonEmptyString(conversation.status) ??
    nonEmptyString(result.status) ??
    "unknown";
  const identityLines = [
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `status: ${status}`
  ];

  if (result.submission_outcome === "submitted") {
    return {
      text: ["AKK response sent.", ...identityLines].join("\n"),
      isError: false
    };
  }
  if (result.submission_outcome === "uncertain") {
    return {
      text: [
        "AKK may have delivered the response, but its submission outcome is uncertain.",
        ...identityLines,
        "next: do not retry automatically; inspect this Turn and the shared tmux pane."
      ].join("\n"),
      isError: true
    };
  }
  if (result.submission_outcome === "aborted") {
    return {
      text: [
        "AKK response was not sent.",
        ...identityLines,
        "next: it is safe to retry this response."
      ].join("\n"),
      isError: true
    };
  }
  return {
    text: [
      "AKK could not confirm the response submission outcome.",
      ...identityLines,
      "next: do not retry automatically; inspect this Turn and the shared tmux pane."
    ].join("\n"),
    isError: true
  };
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
          ...(command.turnId
            ? ["--turn", command.turnId]
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
          "--session",
          command.selector,
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
    case "respond":
      return withOptionalArgs(
        [
          "respond",
          "--turn",
          command.turnId,
          "--message",
          command.message
        ],
        ["--store-dir", storeDir]
      );
    case "approve":
      return withOptionalArgs(
        [
          "approve",
          "--turn",
          command.turnId,
          "--expected-approval-fingerprint",
          command.expectedApprovalFingerprint
        ],
        ["--store-dir", storeDir]
      );
    case "renew":
      return withOptionalArgs(
        ["renew", "--turn", command.turnId],
        [
          "--minutes",
          command.minutes ?? finiteNumberString(config.agentTimeoutMinutes)
        ],
        ["--store-dir", storeDir]
      );
    case "retry-callback":
      return withOptionalArgs(
        ["retry-callback", "--turn", command.turnId],
        ["--store-dir", storeDir]
      );
    case "cancel": {
      return withOptionalArgs(
        ["cancel", "--turn", command.turnId],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes]
      );
    }
    case "close":
      return withOptionalArgs(
        [
          "close",
          "--turn",
          command.turnId,
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

function parseTurnResponse(
  input: string
): { selector: string; message: string } {
  const match = /^(\S+)\s*:\s*([\s\S]*)$/u.exec(input.trim());
  const selector = match?.[1]?.trim();
  const message = match?.[2]?.trim();
  if (!selector || !message) {
    throw new Error("Usage: /akk respond <turn-selector>: <answer>");
  }
  return { selector, message };
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
      nonEmptyString(turn.turn_id) ??
      nonEmptyString(turn.conversation_id) ??
      nonEmptyString(turn.id) ??
      "unknown",
    nonEmptyString(turn.agent) ?? nonEmptyString(executor.kind) ?? "agent",
    nonEmptyString(turn.lifecycle_state) ?? nonEmptyString(turn.status) ?? "unknown",
    truncateText(context, 90)
  ].filter(Boolean).join(" | ");
}

function formatAvailableActions(
  label: string,
  resource: Record<string, unknown>
): string[] {
  const actions = recordValue(resource.available_actions);
  if (!actions) {
    return [];
  }
  const displayedActions = new Set([
    "send",
    "respond",
    "status",
    "approve",
    "cancel",
    "renew",
    "retry_callback",
    "close"
  ]);
  const names = Object.keys(actions)
    .filter((name) => displayedActions.has(name))
    .sort();
  return names.length > 0 ? [`  ${label}: ${names.join(", ")}`] : [];
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
