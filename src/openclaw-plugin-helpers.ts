import path from "node:path";
import { recordValue } from "./value-guards.js";

const MODEL_FACING_PRIVATE_AUTHORITY_PARTS = [
  ["expected", "terminal", "token"],
  ["expected", "binding", "token"],
  ["expected", "handoff", "token"],
  ["candidate", "token"],
  ["expected", "approval", "fingerprint"],
  ["approval", "fingerprint"],
  ["expected", "session", "revision"],
  ["lifecycle", "binding", "token"],
  ["binding", "token"],
  ["binding", "id"],
  ["binding", "generation"],
  ["terminal", "binding", "id"],
  ["terminal", "binding", "generation"],
  ["selection", "handle"],
  ["selection", "snapshot"],
  ["selection", "scope"],
  ["expected", "callback", "conversation", "id"],
  ["expected", "callback", "session", "id"],
  ["expected", "callback", "turn", "id"],
  ["expected", "callback", "message", "id"],
  ["expected", "callback", "openclaw", "session"]
] as const;

// The optional separator accepts the three spellings that can be emitted by
// old CLI/JSON diagnostics: snake_case, kebab-case, and camelCase.  These are
// exact AKK authority names rather than generic words such as "token" or
// "revision", so ordinary user and agent text remains intact.
const MODEL_FACING_PRIVATE_AUTHORITY_NAME = `(?:${
  MODEL_FACING_PRIVATE_AUTHORITY_PARTS
    .map((parts) => parts.join("[_-]?"))
    .join("|")
})`;
const MODEL_FACING_SCALAR =
  `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|` +
  "`(?:\\\\.|[^`\\\\])*`|true|false|null|" +
  `-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?|[^\\s,;}\\]]+)`;
const MODEL_FACING_PRIVATE_AUTHORITY_JSON = new RegExp(
  `"${MODEL_FACING_PRIVATE_AUTHORITY_NAME}"\\s*:\\s*${MODEL_FACING_SCALAR}`,
  "giu"
);
const MODEL_FACING_PRIVATE_AUTHORITY_CLI = new RegExp(
  `--${MODEL_FACING_PRIVATE_AUTHORITY_NAME}(?:=|\\s+)${MODEL_FACING_SCALAR}`,
  "giu"
);
const MODEL_FACING_PRIVATE_AUTHORITY_ASSIGNMENT = new RegExp(
  `(^|[^A-Za-z0-9])${MODEL_FACING_PRIVATE_AUTHORITY_NAME}` +
    `\\s*(?:=|:)\\s*${MODEL_FACING_SCALAR}`,
  "gimu"
);
const MODEL_FACING_PRIVATE_AUTHORITY_LINE = new RegExp(
  `^\\s*(?:[-*]\\s*)?(?:` +
    `(?:["']?${MODEL_FACING_PRIVATE_AUTHORITY_NAME}["']?\\s*(?:=|:))|` +
    `(?:--${MODEL_FACING_PRIVATE_AUTHORITY_NAME}(?:=|\\s+)))`,
  "iu"
);
const LEGACY_APPROVAL_TAIL_MARKER =
  "If the user approves, call `agent_knock_knock_approve`";
const LEGACY_APPROVAL_TERMINAL_INSTRUCTION =
  "Do not use raw tmux, shell, or manual key presses for this approval. Do not approve without explicit user confirmation.";

const MODEL_OPAQUE_AUTHORITY_FIELDS = new Set([
  "acceptanceevidence",
  "attemptoutcome",
  "callbackenvelope",
  "callbackroute",
  "candidaterollouts",
  "claudetranscriptanchor",
  "codexopenrootrolloutinventory",
  "codexrolloutacceptanceanchor",
  "challenge",
  "etag",
  "expectedapprovalfingerprint",
  "expectedcallbackconversationid",
  "expectedcallbackmessageid",
  "expectedcallbackopenclawsession",
  "expectedcallbacksessionid",
  "expectedcallbackturnid",
  "generationid",
  "gatewaymethod",
  "gatewaysession",
  "gatewayurl",
  "livenativethreadid",
  "nativesessiontakeover",
  "nonce",
  "openclawbin",
  "openclawsession",
  "proof",
  "selectionhandle",
  "selectionsnapshot",
  "selectionscope",
  "snapshotid"
]);

export function normalizeAkkModelFacingFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function isAkkModelFacingPrivateAuthorityField(key: string): boolean {
  const compact = normalizeAkkModelFacingFieldName(key);
  return compact.endsWith("token") ||
    compact.endsWith("fingerprint") ||
    compact.endsWith("hash") ||
    compact.endsWith("sha256") ||
    compact.endsWith("digest") ||
    compact.endsWith("revision") ||
    compact.endsWith("revisions") ||
    compact.endsWith("bindingid") ||
    compact.endsWith("bindingids") ||
    compact.endsWith("bindinggeneration") ||
    compact.endsWith("bindinggenerations") ||
    compact === "generation" ||
    MODEL_OPAQUE_AUTHORITY_FIELDS.has(compact);
}

export function isAkkModelFacingDiagnosticField(key: string | undefined): boolean {
  if (!key) return false;
  const separated = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
  return /(?:^|[_-])(?:reasons?|errors?|warnings?|diagnostics?)$/u.test(
    separated
  ) || /(?:^|[_-])(?:error|warning|diagnostic)_message$/u.test(separated);
}

function sanitizeAkkModelFacingEmbeddedAuthorityText(
  value: string
): string {
  return value
    .replace(
      MODEL_FACING_PRIVATE_AUTHORITY_JSON,
      '"internal_authority":"[retained by AKK]"'
    )
    .replace(
      MODEL_FACING_PRIVATE_AUTHORITY_CLI,
      "[AKK internal authority omitted]"
    )
    .replace(
      MODEL_FACING_PRIVATE_AUTHORITY_ASSIGNMENT,
      (_match, prefix: string) =>
        `${prefix}[AKK internal authority omitted]`
    );
}

/**
 * Remove only AKK-generated pre-v18 authority instructions from callback/event
 * text.  Exact authority-looking text outside one of these fixed machine-owned
 * forms is business content and must remain byte-for-byte visible.
 */
export function sanitizeAkkModelFacingLegacyAuthorityInstructionText(
  value: string
): string {
  const reviewOnly = stripAkkLegacyApprovalInstructionTail(value);
  let machineAuthorityBlock = false;
  return reviewOnly.split("\n").map((line) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const carriageReturn = line.endsWith("\r") ? "\r" : "";
    if (
      /^\s*(?:\[?AKK\]?\s+)?(?:approval|internal) authority\s*:?\s*$/iu
        .test(text)
    ) {
      machineAuthorityBlock = true;
      return line;
    }
    if (text.trim().length === 0) {
      machineAuthorityBlock = false;
      return line;
    }
    const fixedCommand = /^\s*(?:equivalent (?:user )?command|AKK (?:approval )?command)\s*:/iu
      .test(text) && containsEmbeddedPrivateAuthority(text);
    const blockAuthority = machineAuthorityBlock &&
      containsEmbeddedPrivateAuthority(text);
    if (fixedCommand || blockAuthority) {
      return `${text.match(/^\s*/u)?.[0] ?? ""}` +
        `[AKK internal authority omitted]${carriageReturn}`;
    }
    if (machineAuthorityBlock) machineAuthorityBlock = false;
    return line;
  }).join("\n");
}

/** Remove only the exact legacy approval instruction appended by AKK. */
export function stripAkkLegacyApprovalInstructionTail(value: string): string {
  const markerIndex = value.lastIndexOf(LEGACY_APPROVAL_TAIL_MARKER);
  const markerSuffix = markerIndex === -1 ? "" : value.slice(markerIndex);
  const fixedTail = markerIndex !== -1 && (
    markerSuffix.trimEnd().endsWith(LEGACY_APPROVAL_TERMINAL_INSTRUCTION) ||
    markerSuffix.split(/\r?\n/u).some(isLegacyMachineAuthorityLine)
  );
  return fixedTail ? value.slice(0, markerIndex) : value;
}

function isLegacyMachineAuthorityLine(line: string): boolean {
  return containsEmbeddedPrivateAuthority(line) && (
    MODEL_FACING_PRIVATE_AUTHORITY_LINE.test(line) ||
    /^\s*(?:equivalent (?:user )?command|AKK (?:approval )?command)\s*:/iu
      .test(line)
  );
}

function containsEmbeddedPrivateAuthority(value: string): boolean {
  return sanitizeAkkModelFacingEmbeddedAuthorityText(value) !== value;
}

export function sanitizeAkkModelFacingDiagnosticText(
  message: string
): string {
  const sanitized = sanitizeAkkModelFacingEmbeddedAuthorityText(message);
  if (
    sanitized !== message ||
    /(?:\bexpected\s+(?:session\s+)?revision\b|\bactual\s+(?:session\s+)?revision\b|\b(?:terminal|binding|handoff|candidate)\s+token\b|\bapproval\s+fingerprint\b|\bbinding\s+(?:id|generation)\b|\bcompare-and-swap\b|\bCAS\b)/iu.test(
      message
    )
  ) {
    return "AKK's private authority changed or could not be verified. Refresh AKK list/status and retry only the currently advertised semantic action.";
  }
  return sanitized;
}

export const AKK_CALLBACK_METHOD = "agent-knock-knock.callback";
export type AkkResumeSelection =
  | { kind: "exact"; nativeThreadId: string }
  | { kind: "previous" }
  | { kind: "number"; selectionNumber: number }
  | { kind: "short-id"; shortId: string };
type AkkCloseCommand = {
  action: "close";
  turnId: string;
  reason: string;
} & (
  | {
      expectedMessageId?: undefined;
      expectedTransitionId?: undefined;
    }
  | {
      expectedMessageId: string;
      expectedTransitionId?: never;
    }
  | {
      expectedMessageId?: never;
      expectedTransitionId: string;
    }
);

export type AkkCommand =
  | { action: "help" }
  | { action: "doctor" }
  | { action: "list" }
  | { action: "watch"; terminalId: string }
  | { action: "unwatch"; watchId: string }
  | { action: "list-resumable-threads"; terminalId: string }
  | { action: "new-thread"; terminalId: string }
  | {
      action: "resume-thread";
      terminalId: string;
      selection?: AkkResumeSelection;
    }
  | { action: "status"; turnId?: string; watchId?: never }
  | { action: "status"; watchId: string; turnId?: never }
  | { action: "send"; selector: string; message: string }
  | { action: "respond"; turnId: string; message: string }
  | {
      action: "approve";
      turnId: string;
    }
  | { action: "cancel"; turnId: string }
  | { action: "renew"; turnId: string; minutes?: string }
  | { action: "retry-callback"; turnId: string }
  | AkkCloseCommand
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
  const lifecycleCommand = parseAkkLifecycleCommand(action, rest);
  if (lifecycleCommand) {
    return lifecycleCommand;
  }
  const turnCommand = parseAkkTurnCommand(action, rest);
  return turnCommand ?? { action: "delegate", request: input };
}

function parseAkkLifecycleCommand(
  action: string,
  rest: string
): AkkCommand | undefined {
  if (action === "list" || action === "ls" || action === "tasks") {
    return { action: "list" };
  }
  if (action === "doctor" || action === "check") {
    if (rest.trim()) {
      throw new Error("Usage: /akk doctor");
    }
    return { action: "doctor" };
  }
  if (action === "watch") {
    const usage = "Usage: /akk watch <exact-terminal-id>";
    const { token: terminalId, rest: extra } = takeRequiredToken(rest, usage);
    assertExactTerminalId(terminalId, usage);
    if (extra.trim()) {
      throw new Error(usage);
    }
    return { action: "watch", terminalId };
  }
  if (action === "unwatch") {
    const usage = "Usage: /akk unwatch <watch-id>";
    const { token: watchId, rest: extra } = takeRequiredToken(rest, usage);
    if (extra.trim() || !isTerminalWatchId(watchId)) {
      throw new Error(usage);
    }
    return { action: "unwatch", watchId };
  }
  if (action === "threads" || action === "list-resumable-threads") {
    const usage = "Usage: /akk threads <exact-terminal-id>";
    const { token: terminalId, rest: extra } = takeRequiredToken(rest, usage);
    assertExactTerminalId(terminalId, usage);
    if (extra.trim()) {
      throw new Error(usage);
    }
    return { action: "list-resumable-threads", terminalId };
  }
  if (action === "new-thread" || action === "clear-thread") {
    const usage = `Usage: /akk ${action} <exact-terminal-id>`;
    const { token: terminalId, rest: extra } = takeRequiredToken(rest, usage);
    assertExactTerminalId(terminalId, usage);
    if (extra.trim()) {
      throw new Error(usage);
    }
    return { action: "new-thread", terminalId };
  }
  if (action === "resume-thread") {
    const usage =
      "Usage: /akk resume-thread <exact-terminal-id> " +
      "[native-thread-uuid|previous|刚才那个|number|@short-id]";
    const { token: terminalId, rest: nativeInput } = takeRequiredToken(
      rest,
      usage
    );
    assertExactTerminalId(terminalId, usage);
    const { token: selectionInput, rest: extra } = takeToken(nativeInput);
    if (extra.trim()) {
      throw new Error(usage);
    }
    const selection = selectionInput
      ? parseAkkResumeSelection(selectionInput, usage)
      : undefined;
    return {
      action: "resume-thread",
      terminalId,
      ...(selection
        ? { selection }
      : {})
    };
  }
  return undefined;
}

function parseAkkTurnCommand(
  action: string,
  rest: string
): AkkCommand | undefined {
  if (action === "status" || action === "show") {
    const { token: turnId, rest: extra } = takeToken(rest);
    if (extra.trim()) {
      throw new Error(
        "Usage: /akk status [turn-selector|terminal-watch-id]"
      );
    }
    return turnId && isTerminalWatchId(turnId)
      ? { action: "status", watchId: turnId }
      : { action: "status", turnId: turnId || undefined };
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
      "Usage: /akk approve <turn-selector>"
    );
    if (approvalInput.trim()) {
      throw new Error("Usage: /akk approve <turn-selector>");
    }
    return {
      action: "approve",
      turnId
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
    return parseAkkCloseCommand(rest);
  }
  return undefined;
}

function parseAkkCloseCommand(rest: string): AkkCloseCommand {
  const usage =
    "Usage: /akk close <turn-selector> " +
    "[(--expected-message-id <id> | --expected-transition-id <id>)] [reason]";
  const { token: turnId, rest: reasonInput } = takeRequiredToken(
    rest,
    usage
  );
  const recoveryInput = reasonInput.trim();
  const recoveryFlags = recoveryInput.match(
    /(?:^|\s)--expected-(?:message|transition)-id(?=\s|$)/gu
  ) ?? [];
  if (recoveryFlags.length > 1) {
    throw new Error(
      `${usage}; expected-message-id and expected-transition-id are mutually exclusive`
    );
  }
  const recovery =
    /^--expected-(message|transition)-id\s+(\S+)(?:\s+([\s\S]*))?$/u.exec(
      recoveryInput
    );
  if (recoveryFlags.length === 1 && !recovery) {
    throw new Error(usage);
  }
  const recoveryKind = recovery?.[1];
  const recoveryId = recovery?.[2];
  const recoveryReason = recovery?.[3]?.trim();
  const defaultRecoveryReason = recoveryKind === "transition"
    ? "Native-thread lifecycle transition recovered from /akk command"
    : "Orphaned terminal dispatch resolved from /akk command";
  return {
    action: "close",
    turnId,
    reason:
      recoveryReason ||
      (recovery
        ? defaultRecoveryReason
        : recoveryInput || "Closed from /akk command"),
    ...(recoveryKind === "message" && recoveryId
      ? { expectedMessageId: recoveryId }
      : {}),
    ...(recoveryKind === "transition" && recoveryId
      ? { expectedTransitionId: recoveryId }
      : {})
  } as AkkCloseCommand;
}

export function akkUsageText(): string {
  return [
    "AKK usage:",
    "/akk <request>",
    "/akk codex: <request>",
    "/akk claude: <request>",
    "/akk <session-selector>: <message>",
    "/akk list",
    "/akk watch <exact-terminal-id>",
    "/akk unwatch <watch-id>",
    "/akk threads <exact-terminal-id>",
    "/akk new-thread <exact-terminal-id>",
    "/akk clear-thread <exact-terminal-id>",
    "/akk resume-thread <exact-terminal-id> [uuid|previous|number|@short-id]",
    "/akk doctor",
    "/akk status [turn-selector|terminal-watch-id]",
    "/akk respond <turn-selector>: <answer>",
    "/akk approve <turn-selector>",
    "/akk cancel <turn-selector>"
  ].join("\n");
}

export function formatAkkListCommandResult(result: Record<string, unknown>): string {
  const terminals = arrayValue(result.terminals);
  const terminalWatches = arrayValue(result.terminal_watches);
  const unavailableManagedTurns = arrayValue(result.unavailable_managed_turns);
  if (
    terminals.length === 0 &&
    terminalWatches.length === 0 &&
    unavailableManagedTurns.length === 0
  ) {
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
    const terminalId = nonEmptyString(terminal.id);
    const availableActions = recordValue(terminal.available_actions) ?? {};
    const hasLifecycleAction = [
      "list_resumable_threads",
      "new_thread",
      "resume_thread"
    ].some((name) => Object.hasOwn(availableActions, name));
    const hasWatchAction = Object.hasOwn(availableActions, "watch");
    return [
      `- ${formatTerminalLine(terminal)}`,
      ...compatibilityWarningLines(terminal),
      ...(hasLifecycleAction && terminalId
        ? [`  lifecycle terminal_id: ${terminalId}`]
        : []),
      ...(hasWatchAction && terminalId
        ? [`  AKK Watch available: /akk watch ${terminalId} — monitor this human-started task and receive attention/completion callbacks without polling.`]
        : []),
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

  const watchLines = terminalWatches.slice(0, 20).flatMap((watch) => [
    `- ${formatTerminalWatchLine(watch)}`,
    ...compatibilityWarningLines(watch),
    ...formatAvailableActions("  actions", watch)
  ]);

  const heading = terminalWatches.length > 0
    ? `AKK terminals (${terminals.length} live, ${terminalWatches.length} terminal watches, ${unavailableManagedTurns.length} unavailable managed turns):`
    : `AKK terminals (${terminals.length} live, ${unavailableManagedTurns.length} unavailable managed turns):`;

  return [
    heading,
    ...(terminalLines.length > 0
      ? ["live terminals:", ...terminalLines]
      : []),
    ...(watchLines.length > 0
      ? ["terminal watches:", ...watchLines]
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

export function formatAkkWatchCommandResult(
  result: Record<string, unknown>
): string {
  const watch = terminalWatchRecord(result);
  return [
    "AKK Terminal Watch started:",
    `watch: ${nonEmptyString(watch.watch_id) ?? "unknown"}`,
    `terminal: ${nonEmptyString(watch.terminal_id) ?? "unknown"}`,
    `agent: ${nonEmptyString(watch.agent) ?? "unknown"}`,
    `status: ${nonEmptyString(watch.status) ?? "watching"}`,
    ...compatibilityWarningLines(watch),
    "AKK did not send or adopt this task; it is observing work the human started in the terminal."
  ].join("\n");
}

export function formatAkkUnwatchCommandResult(
  result: Record<string, unknown>
): string {
  const watch = terminalWatchRecord(result);
  return [
    "AKK Terminal Watch stopped:",
    `watch: ${nonEmptyString(watch.watch_id) ?? "unknown"}`,
    `status: ${nonEmptyString(watch.status) ?? "cancelled"}`,
    "The terminal and its task were not interrupted."
  ].join("\n");
}

export function formatAkkWatchStatusCommandResult(
  result: Record<string, unknown>
): string {
  const watch = terminalWatchRecord(result);
  const userExplicitFallback = watch.source ===
    "terminal_user_explicit_fallback_watch";
  const settlement = recordValue(watch.settlement) ?? {};
  const reason = nonEmptyString(settlement.reason_code) ??
    nonEmptyString(watch.reason);
  const completionText = nonEmptyString(settlement.completion_text);
  return [
    "AKK Terminal Watch status:",
    `watch: ${nonEmptyString(watch.watch_id) ?? "unknown"}`,
    `terminal: ${nonEmptyString(watch.terminal_id) ?? "unknown"}`,
    `agent: ${nonEmptyString(watch.agent) ?? "unknown"}`,
    `status: ${nonEmptyString(watch.status) ?? "unknown"}`,
    ...compatibilityWarningLines(watch),
    ...(reason
      ? [`reason: ${reason}`]
      : []),
    ...(completionText
      ? [`completion: ${truncateText(completionText, 500)}`]
      : []),
    userExplicitFallback
      ? "AKK sent this exact request through user-explicit unmanaged fallback and attached Watch for its callback; no managed Turn was created."
      : "This is observed external work; AKK did not send or adopt the task."
  ].join("\n");
}

export function formatAkkTerminalWatchHint(
  result: Record<string, unknown>
): string[] {
  const hint = recordValue(result.terminal_watch_hint);
  if (
    hint?.kind !== "terminal_watch_discovery" ||
    hint.available_action_required !== true
  ) {
    return [];
  }
  const command = nonEmptyString(hint.command);
  const instruction = nonEmptyString(hint.instruction);
  if (!command || !instruction) {
    return [];
  }
  return [
    `AKK Watch available: ${command}`,
    `next: ${instruction}`
  ];
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

  if (isAkkNativeSubmissionAccepted(result)) {
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
        "next: do not retry automatically; inspect this Turn and the shared terminal pane."
      ].join("\n"),
      isError: true
    };
  }
  if (result.submission_outcome === "aborted") {
    const safeToRetry =
      result.safe_to_retry === true && result.do_not_retry !== true;
    return {
      text: [
        "AKK response was not sent.",
        ...identityLines,
        safeToRetry
          ? "next: the aborted receipt is durable, so it is safe to retry this response."
          : "next: do not retry automatically; a durable safe abort was not proven, so inspect this Turn and its terminal dispatch ledger."
      ].join("\n"),
      isError: true
    };
  }
  if (result.submission_outcome === "pending_acceptance") {
    return {
      text: [
        "AKK dispatched the response, but native acceptance is still pending.",
        ...identityLines,
        "next: do not retry automatically; wait for native acceptance or inspect the shared terminal pane."
      ].join("\n"),
      isError: true
    };
  }
  if (result.submission_outcome === "not_accepted") {
    return {
      text: [
        "AKK proved that the coding agent did not accept the response draft.",
        ...identityLines,
        "next: do not retry automatically; inspect the exact composer draft."
      ].join("\n"),
      isError: true
    };
  }
  return {
    text: [
      "AKK could not confirm the response submission outcome.",
      ...identityLines,
      "next: do not retry automatically; inspect this Turn and the shared terminal pane."
    ].join("\n"),
    isError: true
  };
}

export function isAkkNativeSubmissionAccepted(
  result: Record<string, unknown>
): boolean {
  return result.submission_outcome === "agent_accepted" &&
    result.delivery_receipt === "agent_accepted" &&
    result.delivered === true;
}

export function formatAkkThreadsCommandResult(
  result: Record<string, unknown>
): string {
  const terminalId = nonEmptyString(result.terminal_id) ?? "unknown";
  const currentSessionId = nonEmptyString(result.current_session_id);
  const currentNativeThreadId = nonEmptyString(
    result.current_native_thread_id
  );
  const threads = arrayValue(result.threads);
  const resumableCount = threads.filter(
    (thread) => thread.resumable === true
  ).length;
  const previous = recordValue(result.previous);
  const previousNativeThreadId = nonEmptyString(previous?.native_thread_id);
  const selectionSnapshot = recordValue(result.selection_snapshot);
  const threadLines = threads.slice(0, 30).flatMap((thread) => {
    const nativeThreadId =
      nonEmptyString(thread.native_thread_id) ?? "unknown";
    const selectionNumber = finiteNumber(thread.selection_number);
    const shortId = nonEmptyString(thread.short_id);
    const status = thread.resumable === true
      ? "resumable"
      : nonEmptyString(thread.unavailable_reason) ?? "unavailable";
    const context = [
      nonEmptyString(thread.title),
      nonEmptyString(thread.preview)
    ].filter((value): value is string => Boolean(value)).join(" · ");
    const selector = selectionNumber !== undefined || shortId
      ? [
          selectionNumber !== undefined ? `${selectionNumber}.` : undefined,
          shortId
        ].filter(Boolean).join(" ")
      : `- ${nativeThreadId}`;
    const previousMarker = nativeThreadId === previousNativeThreadId
      ? " | previous / 刚才那个"
      : "";
    return [
      `${selector} | ${status}${previousMarker}`,
      `  full UUID: ${nativeThreadId}`,
      ...(nonEmptyString(thread.updated_at)
        ? [`  updated: ${nonEmptyString(thread.updated_at)}`]
        : []),
      ...(context ? [`  context: ${truncateText(context, 180)}`] : [])
    ];
  });
  return [
    `AKK native threads (${threads.length} found, ${resumableCount} resumable):`,
    `terminal: ${terminalId}`,
    `current session: ${currentSessionId ?? "none"}`,
    `current native thread: ${currentNativeThreadId ?? "none"}`,
    ...(nonEmptyString(selectionSnapshot?.expires_at)
      ? [`selection expires: ${nonEmptyString(selectionSnapshot?.expires_at)}`]
      : []),
    ...compatibilityWarningLines(result),
    ...(threadLines.length > 0
      ? ["threads:", ...threadLines]
      : ["threads: none"]),
    ...(resumableCount > 0
      ? [
          `next: /akk resume-thread ${terminalId} <native-thread-uuid>`,
          `shortcuts: /akk resume-thread ${terminalId} <number|@short-id>`,
          ...(previousNativeThreadId
            ? [`previous: /akk resume-thread ${terminalId} previous`]
            : []),
          "Numbers and short IDs refer only to this displayed snapshot; relist after expiry or any terminal change."
        ]
      : []),
    "Listing or switching native threads does not create an AKK Turn."
  ].join("\n");
}

export function formatAkkThreadTransitionCommandResult(
  result: Record<string, unknown>
): string {
  if (!isAkkThreadTransitionSuccess(result)) {
    const status = nonEmptyString(result.status) ?? "unknown";
    const heading = status === "verified_recovery_required"
      ? "AKK verified the native thread transition, but its Session commit requires recovery."
      : "AKK could not verify the native thread transition outcome.";
    return [
      heading,
      `status: ${status}`,
      `terminal: ${nonEmptyString(result.terminal_id) ?? "unknown"}`,
      ...(nonEmptyString(result.transition_id)
        ? [`transition: ${nonEmptyString(result.transition_id)}`]
        : []),
      ...(nonEmptyString(result.reason)
        ? [
            `reason: ${sanitizeAkkModelFacingDiagnosticText(
              nonEmptyString(result.reason) ?? ""
            )}`
          ]
        : []),
      ...compatibilityWarningLines(result),
      "No AKK Turn was created.",
      "Next: do not retry automatically; refresh /akk list and use only its exact lifecycle recovery action."
    ].join("\n");
  }
  const alreadyActive = result.status === "already_active";
  const operation = nonEmptyString(result.operation) ?? "resume_thread";
  const heading = alreadyActive
    ? "AKK native thread was already active; no switch was needed."
    : operation === "new_thread"
      ? "AKK started and verified a new native thread."
      : "AKK resumed and verified the selected native thread.";
  return [
    heading,
    `terminal: ${nonEmptyString(result.terminal_id) ?? "unknown"}`,
    ...(nonEmptyString(result.previous_session_id)
      ? [`previous session: ${nonEmptyString(result.previous_session_id)}`]
      : []),
    `session: ${nonEmptyString(result.session_id) ?? "none"}`,
    ...(nonEmptyString(result.previous_native_thread_id)
      ? [
          `previous native thread: ${nonEmptyString(result.previous_native_thread_id)}`
        ]
      : []),
    `native thread: ${nonEmptyString(result.native_thread_id) ?? "unknown"}`,
    ...compatibilityWarningLines(result),
    "No AKK Turn was created. The next ordinary send creates the first Turn in this native context."
  ].join("\n");
}

export function isAkkThreadTransitionSuccess(
  result: unknown
): boolean {
  const record = recordValue(result);
  return record?.status === "committed" || record?.status === "already_active";
}

export function buildAkkCommandCliArgs(
  command: AkkCommand,
  config: Record<string, unknown>,
  context: {
    sessionKey?: unknown;
    expectedBindingToken?: unknown;
    candidateToken?: unknown;
    messageId?: unknown;
    selectionScope?: unknown;
    selectionSnapshotId?: unknown;
  } = {}
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
  const codexHome = nonEmptyString(config.codexHome);
  const idleTimeoutMinutes = finiteNumberString(config.idleTimeoutMinutes);

  switch (command.action) {
    case "list":
      return withOptionalArgs(
        ["list", "--reconcile"],
        ["--store-dir", storeDir],
        ["--idle-timeout-minutes", idleTimeoutMinutes]
      );
    case "watch": {
      const openclawSession =
        nonEmptyString(context.sessionKey) ??
        "agent:main:main";
      return withOptionalArgs(
        [
          "watch-terminal",
          "--terminal",
          command.terminalId
        ],
        ["--store-dir", storeDir],
        [
          "--hard-timeout-minutes",
          finiteNumberString(config.agentHardTimeoutMinutes)
        ],
        ["--openclaw-session", openclawSession],
        ["--openclaw-bin", nonEmptyString(config.openclawBin)]
      );
    }
    case "unwatch":
      return withOptionalArgs(
        ["unwatch-terminal", "--watch", command.watchId],
        ["--store-dir", storeDir]
      );
    case "list-resumable-threads":
      return withOptionalArgs(
        [
          "list-resumable-threads",
          "--terminal",
          command.terminalId
        ],
        ["--store-dir", storeDir],
        ["--codex-home", codexHome],
        ["--selection-scope", nonEmptyString(context.selectionScope)]
      );
    case "new-thread":
      return withOptionalArgs(
        [
          "new-thread",
          "--terminal",
          command.terminalId,
          "--expected-binding-token",
          requiredExpectedBindingToken(context.expectedBindingToken)
        ],
        ["--store-dir", storeDir],
        ["--codex-home", codexHome]
      );
    case "resume-thread":
      if (!command.selection || command.selection.kind === "previous") {
        return withOptionalArgs(
          [
            "list-resumable-threads",
            "--terminal",
            command.terminalId
          ],
          ["--store-dir", storeDir],
          ["--codex-home", codexHome],
          ["--selection-scope", nonEmptyString(context.selectionScope)]
        );
      }
      if (command.selection.kind === "number") {
        return withOptionalArgs(
          [
            "resume-thread",
            "--terminal",
            command.terminalId,
            "--selection-snapshot",
            requiredSelectionSnapshotId(context.selectionSnapshotId),
            "--selection-number",
            String(command.selection.selectionNumber),
            "--selection-scope",
            requiredSelectionScope(context.selectionScope)
          ],
          ["--store-dir", storeDir],
          ["--codex-home", codexHome]
        );
      }
      if (command.selection.kind === "short-id") {
        return withOptionalArgs(
          [
            "resume-thread",
            "--terminal",
            command.terminalId,
            "--selection-snapshot",
            requiredSelectionSnapshotId(context.selectionSnapshotId),
            "--selection-short-id",
            command.selection.shortId,
            "--selection-scope",
            requiredSelectionScope(context.selectionScope)
          ],
          ["--store-dir", storeDir],
          ["--codex-home", codexHome]
        );
      }
      return withOptionalArgs(
        [
          "resume-thread",
          "--terminal",
          command.terminalId,
          "--native-thread",
          command.selection.nativeThreadId,
          "--expected-binding-token",
          requiredExpectedBindingToken(context.expectedBindingToken),
          "--candidate-token",
          requiredCandidateToken(context.candidateToken)
        ],
        ["--store-dir", storeDir],
        ["--codex-home", codexHome]
      );
    case "status":
      if (command.watchId) {
        return withOptionalArgs(
          ["watch-status", "--watch", command.watchId],
          ["--store-dir", storeDir]
        );
      }
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
        ["--message-id", nonEmptyString(context.messageId)],
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
      // The OpenClaw command adapter resolves the current private approval
      // authority immediately before invoking the CLI.
      return undefined;
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
        ["--expected-transition-id", command.expectedTransitionId],
        ["--store-dir", storeDir]
      );
  }
}

function isTerminalWatchId(value: string): boolean {
  return /^terminal-watch-[A-Za-z0-9._:-]+$/u.test(value);
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

function assertExactTerminalId(value: string, usage: string): void {
  if (!/^terminal:v\d+:[^\s]+$/u.test(value)) {
    throw new Error(
      `${usage}; use the exact terminal_id returned by /akk list`
    );
  }
}

function isExactNativeThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value
  );
}

function parseAkkResumeSelection(
  value: string,
  usage: string
): AkkResumeSelection {
  const normalized = value.toLowerCase();
  if (normalized === "previous" || normalized === "prev" || value === "刚才那个") {
    return { kind: "previous" };
  }
  if (isExactNativeThreadId(value)) {
    return { kind: "exact", nativeThreadId: normalized };
  }
  if (/^[1-9][0-9]*$/u.test(value)) {
    const selectionNumber = Number(value);
    if (Number.isSafeInteger(selectionNumber)) {
      return { kind: "number", selectionNumber };
    }
  }
  if (/^@[a-f0-9]{8,32}$/u.test(normalized)) {
    return { kind: "short-id", shortId: normalized };
  }
  throw new Error(
    `${usage}; use a complete UUID or a selection exactly returned by /akk threads`
  );
}

function requiredExpectedBindingToken(value: unknown): string {
  const token = nonEmptyString(value);
  if (!token) {
    throw new Error(
      "expected binding token is required; refresh the lifecycle snapshot before switching native threads"
    );
  }
  return token;
}

function requiredCandidateToken(value: unknown): string {
  const token = nonEmptyString(value);
  if (!token) {
    throw new Error(
      "candidate token is required; select an exact resumable row from the current lifecycle snapshot"
    );
  }
  return token;
}

function requiredSelectionScope(value: unknown): string {
  const scope = nonEmptyString(value);
  if (!scope) {
    throw new Error(
      "snapshot-bound resume requires the current controller session scope; run /akk threads again"
    );
  }
  return scope;
}

function requiredSelectionSnapshotId(value: unknown): string {
  const snapshotId = nonEmptyString(value);
  if (!snapshotId) {
    throw new Error(
      "snapshot-bound resume requires the last displayed snapshot; run /akk threads again"
    );
  }
  return snapshotId;
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

function terminalWatchRecord(
  result: Record<string, unknown>
): Record<string, unknown> {
  return recordValue(result.watch) ??
    recordValue(result.terminal_watch) ??
    result;
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
      ? `${nonEmptyString(terminalControl.kind) ?? "tmux"} ${nonEmptyString(terminalControl.target)}`
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

function formatTerminalWatchLine(watch: Record<string, unknown>): string {
  return [
    nonEmptyString(watch.short_ref) ??
      nonEmptyString(watch.watch_id) ??
      "unknown",
    nonEmptyString(watch.agent) ?? "agent",
    nonEmptyString(watch.status) ?? "unknown",
    nonEmptyString(watch.terminal_id)
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
    "watch",
    "unwatch",
    "respond",
    "status",
    "approve",
    "cancel",
    "renew",
    "retry_callback",
    "close",
    "list_resumable_threads",
    "new_thread",
    "resume_thread",
    "native_inspect"
  ]);
  const names = Object.keys(actions)
    .filter((name) => displayedActions.has(name))
    .sort();
  return names.length > 0 ? [`  ${label}: ${names.join(", ")}`] : [];
}

function compatibilityWarningLines(
  resource: Record<string, unknown>
): string[] {
  const capability = recordValue(resource.capability);
  const warnings = [
    nonEmptyString(resource.compatibility_warning),
    nonEmptyString(capability?.compatibilityWarning),
    ...(Array.isArray(resource.compatibility_warnings)
      ? resource.compatibility_warnings
        .map(nonEmptyString)
        .filter((value): value is string => Boolean(value))
      : [])
  ].filter((value): value is string => Boolean(value));
  return [...new Set(warnings)].map((warning) =>
    `compatibility warning: ${truncateText(
      sanitizeAkkModelFacingDiagnosticText(warning),
      300
    )}`
  );
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
