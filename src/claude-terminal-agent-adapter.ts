import { createHash } from "node:crypto";
import path from "node:path";
import { redactString } from "./runtime-log.js";
import type {
  ActiveTerminalProcess,
  TerminalAgentAdapter,
  TerminalApprovalInspection,
  TerminalApprovalPolicyEvidence,
  TerminalDurableCompletionRequest,
  TerminalProcessSnapshot,
  TerminalRuntimeIdentity,
  TerminalScreenInspection,
  TerminalScreenInspectionOptions
} from "./terminal-agent-adapter.js";

export type ClaudeProcessKind = "claude_cli";

/** A row returned by `claude agents --json --all`. Unknown fields are intentionally ignored. */
export interface ClaudeAgentRow {
  pid?: number;
  cwd?: string;
  kind?: string;
  sessionId?: string;
  startedAt?: number;
  status?: string;
}

export interface CreateClaudeTerminalAgentAdapterOptions {
  /**
   * A point-in-time `claude agents --json --all` snapshot. Rows are joined only by an exact PID;
   * names, cwd values, and fuzzy command matches are never used as process identity.
   */
  agentRows?: readonly ClaudeAgentRow[];
  /** Read-only local transcript detector used for durable completion. */
  detectDurableCompletion?: NonNullable<
    TerminalAgentAdapter<ClaudeProcessKind>["detectDurableCompletion"]
  >;
  /**
   * Local transcript evidence for the one pending Bash tool use in the current
   * managed turn. The adapter intersects it with the current strict permission
   * screen before exposing any executor-local policy authority.
   */
  detectPendingApproval?: (
    request: TerminalDurableCompletionRequest
  ) => ClaudePendingApprovalEvidence | undefined;
}

export interface ClaudePendingApprovalEvidence {
  source: "claude_transcript";
  kind: "run_command";
  command: string;
  cwd: string;
  toolName: "Bash";
  toolUseId: string;
  promptUuid: string;
  assistantUuid: string;
  claudeVersion: string;
  transcriptFileId: string;
  commandSha256: string;
  evidenceFingerprint: string;
  observedEndOffsetBytes: number;
}

const CLAUDE_SUBCOMMANDS = new Set([
  "agents",
  "auth",
  "auto-mode",
  "doctor",
  "gateway",
  "install",
  "mcp",
  "plugin",
  "plugins",
  "project",
  "setup-token",
  "ultrareview",
  "update",
  "upgrade"
]);

const NON_INTERACTIVE_FLAGS = new Set([
  "-h",
  "--help",
  "-p",
  "--print",
  "-v",
  "--version",
  "--bg",
  "--background"
]);

const OPTIONS_WITH_VALUES = new Set([
  "--add-dir",
  "--agent",
  "--agents",
  "--allowedTools",
  "--allowed-tools",
  "--append-system-prompt",
  "--betas",
  "--debug-file",
  "--disallowedTools",
  "--disallowed-tools",
  "--effort",
  "--fallback-model",
  "--file",
  "--from-pr",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--mcp-config",
  "--model",
  "-n",
  "--name",
  "--output-format",
  "--permission-mode",
  "--plugin-dir",
  "--plugin-url",
  "--remote-control-session-name-prefix",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--tools"
]);

const OPTIONAL_VALUE_OPTIONS = new Set([
  "-d",
  "--debug",
  "--prompt-suggestions",
  "--remote-control",
  "-w",
  "--worktree"
]);

const CLAUDE_SCREEN_TAIL_LINES = 48;
const CLAUDE_EXCERPT_LINES = 80;
const CLAUDE_PERMISSION_DETAIL_LENGTH = 600;
const CLAUDE_AUTO_APPROVAL_COMMAND_LENGTH = 2000;
const CLAUDE_NATIVE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const ANSI_ESCAPE_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu;

export function createClaudeTerminalAgentAdapter(
  options: CreateClaudeTerminalAgentAdapterOptions = {}
): TerminalAgentAdapter<ClaudeProcessKind> {
  const agentRows = options.agentRows ?? [];
  const transcriptCompletionDetector = options.detectDurableCompletion;
  const transcriptApprovalDetector = options.detectPendingApproval;
  const durableCompletion =
    transcriptCompletionDetector !== undefined;
  return {
    agent: "claude",
    displayName: "Claude Code",
    capabilities: {
      processDiscovery: true,
      screenStatus: true,
      terminalApproval: true,
      // A visible idle prompt is not durable proof that the requested turn completed.
      screenCompletion: false,
      durableCompletion,
      cancellation: true
    },
    cancelKeys: ["Escape"],
    classifyProcess(snapshot) {
      return classifyClaudeProcess(snapshot, agentRows);
    },
    inspectScreen(screenOptions) {
      return transcriptApprovalScreenInspection(
        inspectClaudeScreen(screenOptions),
        screenOptions,
        transcriptApprovalDetector
      );
    },
    ...(durableCompletion
      ? {
          async detectDurableCompletion(request: TerminalDurableCompletionRequest) {
            return transcriptCompletionDetector?.(request);
          }
        }
      : {})
  };
}

export const claudeTerminalAgentAdapter = createClaudeTerminalAgentAdapter();

export function classifyClaudeProcess(
  snapshot: TerminalProcessSnapshot,
  agentRows: readonly ClaudeAgentRow[] = []
): ActiveTerminalProcess<ClaudeProcessKind> | undefined {
  const tokens = tokenizeCommand(snapshot.command);
  if (tokens.length === 0 || !isClaudeExecutable(tokens[0])) {
    return undefined;
  }

  const args = tokens.slice(1);
  if (args.some((token) => isNonInteractiveFlag(token))) {
    return undefined;
  }
  if (findClaudeSubcommand(args)) {
    return undefined;
  }

  const agentRow = exactInteractiveAgentRow(snapshot.pid, agentRows);
  if (agentRow === null) {
    return undefined;
  }
  const commandSessionId = extractClaudeSessionId(snapshot.command);
  // `--resume` can retain an old argv value after Claude changes sessions. Exact-PID agent
  // metadata is the current runtime identity and therefore wins on conflict.
  const sessionId = nonEmptyString(agentRow?.sessionId) ?? commandSessionId;
  const cwd = nonEmptyString(snapshot.cwd) ?? nonEmptyString(agentRow?.cwd);
  const confidence = agentRow
    ? "high" as const
    : sessionId
      ? "high" as const
      : cwd
        ? "medium" as const
        : "low" as const;
  const reason = agentRow
    ? "interactive Claude CLI matched an exact PID from claude agents --json --all"
    : sessionId
      ? "interactive Claude CLI command includes a session id"
      : "interactive Claude CLI process without an exact agent metadata row";

  return {
    ...snapshot,
    cwd,
    agent: "claude",
    kind: "claude_cli",
    sessionId,
    confidence,
    reason
  };
}

function isClaudeExecutable(executable: string): boolean {
  if (path.basename(executable) === "claude") {
    return true;
  }
  if (!path.isAbsolute(executable)) {
    return false;
  }

  const segments = executable.split(path.sep);
  const version = segments.at(-1);
  return version !== undefined &&
    CLAUDE_NATIVE_VERSION_PATTERN.test(version) &&
    segments.slice(-5, -1).join("/") === ".local/share/claude/versions";
}

export function extractClaudeSessionId(command: string): string | undefined {
  const args = tokenizeCommand(command).slice(1);
  return optionValue(args, "--session-id") ??
    optionValue(args, "--resume") ??
    shortOptionValue(args, "-r");
}

export function inspectClaudeScreen(
  options: TerminalScreenInspectionOptions
): TerminalScreenInspection {
  const detectedApproval = detectClaudeApprovalPrompt(options.screen);
  const approval = detectedApproval.approvable && !hasManagedClaudeApprovalIdentity(options.runtime)
    ? {
        blocked: true as const,
        approvable: false as const,
        reason: "Claude screen approval requires an active AKK-managed turn with exact process and message identity",
        promptKind: detectedApproval.promptKind,
        command: detectedApproval.command,
        cwd: detectedApproval.cwd,
        toolName: detectedApproval.toolName,
        requestDetail: detectedApproval.requestDetail
      }
    : detectedApproval;
  return {
    activity: detectClaudeActivityState(options.screen, approval),
    approval,
    screenExcerpt: claudeScreenExcerpt(options.screen, options.maxExcerptLength ?? 4000)
    // Deliberately no screen completion: idle alone can follow cancellation, errors, or old output.
  };
}

function hasManagedClaudeApprovalIdentity(
  runtime: TerminalRuntimeIdentity | undefined
): boolean {
  return Number.isInteger(runtime?.pid) &&
    Number(runtime?.pid) > 0 &&
    Boolean(nonEmptyString(runtime?.conversationId)) &&
    Boolean(nonEmptyString(runtime?.messageId)) &&
    Boolean(nonEmptyString(runtime?.terminalTarget));
}

function transcriptApprovalScreenInspection(
  screenInspection: TerminalScreenInspection,
  options: TerminalScreenInspectionOptions,
  detector: CreateClaudeTerminalAgentAdapterOptions["detectPendingApproval"]
): TerminalScreenInspection {
  const managedPermissionInspection =
    (options.managedRequest || hasManagedClaudeApprovalIdentity(options.runtime)) &&
    screenInspection.approval.blocked &&
    screenInspection.approval.promptKind === "claude_permission"
      ? privacySafeManagedClaudePermissionInspection(
          screenInspection,
          options.screen,
          options.maxExcerptLength ?? 4000
        )
      : screenInspection;
  if (
    !detector ||
    !options.managedRequest ||
    !hasManagedClaudeApprovalIdentity(options.runtime) ||
    !screenInspection.approval.approvable ||
    screenInspection.approval.action.mode !== "keys"
  ) {
    return managedPermissionInspection;
  }

  let evidence: ClaudePendingApprovalEvidence | undefined;
  try {
    evidence = detector(options.managedRequest);
  } catch {
    // Transcript uncertainty must never remove the user's ability to make the
    // already-validated one-time decision manually.
    return managedPermissionInspection;
  }
  const visibleCommand = claudePermissionVisibleCommandLine(options.screen);
  const policyCommand = evidence
    ? claudePermissionCommandForApproval(evidence.command)
    : undefined;
  const evidenceCwd = evidence && path.isAbsolute(evidence.cwd)
    ? path.resolve(evidence.cwd)
    : undefined;
  const managedRequestCwd =
    nonEmptyString(options.managedRequest.cwd) &&
    path.isAbsolute(options.managedRequest.cwd ?? "")
      ? path.resolve(options.managedRequest.cwd as string)
      : undefined;
  const runtimeCwd =
    nonEmptyString(options.runtime?.cwd) &&
    path.isAbsolute(options.runtime?.cwd ?? "")
      ? path.resolve(options.runtime?.cwd as string)
      : undefined;
  if (
    !evidence ||
    evidence.source !== "claude_transcript" ||
    evidence.kind !== "run_command" ||
    evidence.toolName !== "Bash" ||
    !evidenceCwd ||
    !managedRequestCwd ||
    !runtimeCwd ||
    evidenceCwd !== managedRequestCwd ||
    evidenceCwd !== runtimeCwd ||
    evidence.command.trim() !== evidence.command ||
    policyCommand?.command !== evidence.command ||
    visibleCommand !== evidence.command ||
    sha256Hex(evidence.command) !== evidence.commandSha256 ||
    !isSha256Hex(evidence.evidenceFingerprint) ||
    !nonEmptyString(evidence.toolUseId) ||
    !nonEmptyString(evidence.promptUuid) ||
    !nonEmptyString(evidence.assistantUuid) ||
    !nonEmptyString(evidence.claudeVersion) ||
    !nonEmptyString(evidence.transcriptFileId) ||
    !Number.isSafeInteger(evidence.observedEndOffsetBytes) ||
    evidence.observedEndOffsetBytes <= 0
  ) {
    return managedPermissionInspection;
  }

  const policyEvidence: TerminalApprovalPolicyEvidence = {
    source: "claude_transcript",
    kind: "run_command",
    command: evidence.command,
    cwd: evidenceCwd,
    toolName: "Bash",
    requestId: evidence.toolUseId,
    commandSha256: evidence.commandSha256,
    evidenceFingerprint: evidence.evidenceFingerprint,
    metadata: {
      prompt_uuid: evidence.promptUuid,
      assistant_uuid: evidence.assistantUuid,
      claude_version: evidence.claudeVersion,
      transcript_file_id: evidence.transcriptFileId,
      observed_end_offset_bytes: evidence.observedEndOffsetBytes
    }
  };
  return {
    ...managedPermissionInspection,
    approval: {
      ...screenInspection.approval,
      command: undefined,
      cwd: policyEvidence.cwd,
      toolName: "Bash",
      requestDetail:
        `Verified local Bash request (sha256:${policyEvidence.commandSha256.slice(0, 12)})`,
      policyEvidence,
      action: {
        ...screenInspection.approval.action,
        requestId: policyEvidence.requestId
      }
    },
    screenExcerpt: omitClaudePermissionDetails(
      options.screen,
      policyEvidence.commandSha256,
      options.maxExcerptLength ?? 4000
    )
  };
}

function privacySafeManagedClaudePermissionInspection(
  screenInspection: TerminalScreenInspection,
  screen: string,
  maxExcerptLength: number
): TerminalScreenInspection {
  return {
    ...screenInspection,
    approval: {
      ...screenInspection.approval,
      command: undefined,
      requestDetail:
        "Bash request details omitted; inspect the live terminal pane directly"
    },
    screenExcerpt: omitClaudePermissionDetails(
      screen,
      undefined,
      maxExcerptLength
    )
  };
}

export function claudePermissionCommandForApproval(
  command: string
): { command?: string; display: string } {
  const normalized = command;
  const redacted = redactString(normalized);
  const display = singleLineClaudePermissionValue(redacted, CLAUDE_PERMISSION_DETAIL_LENGTH - 20);
  const policySafe = normalized.length <= CLAUDE_AUTO_APPROVAL_COMMAND_LENGTH && redacted === normalized;
  return {
    ...(policySafe && normalized.trim() ? { command: normalized } : {}),
    display
  };
}

function singleLineClaudePermissionValue(value: string, maxLength: number): string {
  return redactString(value)
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function detectClaudeApprovalPrompt(screen: string): TerminalApprovalInspection {
  const lines = claudeDetectionTail(screen);
  const markerIndexes = lines
    .map((line, index) => /^\s*Do you want to proceed\?\s*$/iu.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (markerIndexes.length === 0) {
    return {
      blocked: false,
      approvable: false,
      reason: "no current Claude Code permission dialog was detected in the terminal tail"
    };
  }
  if (markerIndexes.length !== 1) {
    return {
      blocked: true,
      approvable: false,
      reason: "multiple Claude Code permission markers are visible; resolve the dialog manually",
      promptKind: "claude_permission"
    };
  }

  const markerIndex = markerIndexes[0];
  const region = lines.slice(markerIndex);
  const lastChoiceLikeIndex = findLastIndex(
    region,
    (line) => /^\s*(?:❯\s*)?[1-3]\.\s*.+?\s*$/u.test(line)
  );
  const newerStateIndex = findLastIndex(region, (line, index) =>
    index > lastChoiceLikeIndex &&
    (isClaudeIdlePromptLine(line) || isClaudeWorkingLine(line))
  );
  const unexpectedTrailingAfterChoices = lastChoiceLikeIndex >= 0 &&
    region.slice(lastChoiceLikeIndex + 1).some((line) => {
      const trimmed = line.trim();
      return Boolean(trimmed) &&
        !isClaudePermissionFooterLine(line) &&
        !/^[─━═╌╍┄┅┈┉\s]+$/u.test(trimmed);
    });
  if (newerStateIndex >= 0) {
    return {
      blocked: false,
      approvable: false,
      reason: "the Claude Code permission dialog appears stale"
    };
  }
  if (unexpectedTrailingAfterChoices) {
    return {
      blocked: true,
      approvable: false,
      reason: "the visible Claude Code permission text does not match the supported current Bash dialog exactly; resolve it manually",
      promptKind: "claude_permission"
    };
  }
  const headerIndex = findLastIndex(
    lines.slice(Math.max(0, markerIndex - 16), markerIndex),
    (line) => /^\s*Bash command\s*$/iu.test(line)
  );
  const absoluteHeaderIndex = headerIndex < 0
    ? -1
    : Math.max(0, markerIndex - 16) + headerIndex;
  const choiceRows = region.flatMap((line, index) => {
    const match = /^\s*(❯\s*)?([1-3])\.\s*(.+?)\s*$/u.exec(line);
    return match
      ? [{
          index,
          highlighted: Boolean(match[1]),
          number: Number(match[2]),
          label: match[3].trim()
        }]
      : [];
  });
  const highlightedRows = choiceRows.filter((choice) => choice.highlighted);
  const footerIndexes = region
    .map((line, index) =>
      isClaudePermissionFooterLine(line) ? index : -1
    )
    .filter((index) => index >= 0);
  const orderedChoices = choiceRows.length === 3 &&
    choiceRows.every((choice, index) => choice.number === index + 1) &&
    choiceRows.every((choice, index) =>
      index === 0 || choice.index > choiceRows[index - 1].index
    );
  const exactLabels = orderedChoices &&
    isOneTimeYesChoice(choiceRows[0].label) &&
    isPersistentPermissionChoice(choiceRows[1].label) &&
    /^No(?:\b|,)/iu.test(choiceRows[2].label);
  const exactChoiceSpacing = orderedChoices && [
    region.slice(1, choiceRows[0].index),
    region.slice(choiceRows[0].index + 1, choiceRows[1].index),
    region.slice(choiceRows[1].index + 1, choiceRows[2].index)
  ].every((gap) => gap.every((line) => !line.trim()));
  const footerIndex = footerIndexes[0] ?? -1;
  const footerAfterChoices = footerIndexes.length === 1 &&
    footerIndex > (choiceRows.at(-1)?.index ?? Number.MAX_SAFE_INTEGER);
  const trailingIsDecorative = footerAfterChoices &&
    region.slice(footerIndex + 1).every((line) => {
      const trimmed = line.trim();
      return !trimmed || /^[─━═╌╍┄┅┈┉\s]+$/u.test(trimmed);
    });
  const markerNearBottom = markerIndex >= Math.max(0, lines.length - 12);
  const detailLines = absoluteHeaderIndex >= 0
    ? lines.slice(absoluteHeaderIndex + 1, markerIndex)
      .map((line) => line.trim())
      .filter(Boolean)
    : [];
  const hasExactDialogShape =
    absoluteHeaderIndex >= 0 &&
    markerNearBottom &&
    orderedChoices &&
    exactLabels &&
    exactChoiceSpacing &&
    footerAfterChoices &&
    trailingIsDecorative &&
    highlightedRows.length === 1 &&
    detailLines.length > 0;

  if (!hasExactDialogShape) {
    return {
      blocked: true,
      approvable: false,
      reason: "the visible Claude Code permission text does not match the supported current Bash dialog exactly; resolve it manually",
      promptKind: "claude_permission"
    };
  }

  const highlighted = highlightedRows[0];
  if (highlighted.number !== 1 || !isOneTimeYesChoice(highlighted.label)) {
    return {
      blocked: true,
      approvable: false,
      reason: isPersistentPermissionChoice(highlighted.label)
        ? "the highlighted Claude Code choice would persist permission"
        : "the highlighted Claude Code choice is not the one-time Yes option",
      promptKind: "claude_permission"
    };
  }

  const requestDetail = redactString(detailLines.join("\n"))
    .slice(0, CLAUDE_PERMISSION_DETAIL_LENGTH);
  return {
    blocked: true,
    approvable: true,
    promptKind: "claude_permission",
    requestDetail,
    toolName: "Bash",
    action: {
      mode: "keys",
      keys: ["C-m"],
      label: "Yes"
    }
  };
}

function claudePermissionVisibleCommandLine(screen: string): string | undefined {
  const lines = claudeDetectionTail(screen);
  const markerIndex = findLastIndex(
    lines,
    (line) => /^\s*Do you want to proceed\?\s*$/iu.test(line)
  );
  if (markerIndex < 0) {
    return undefined;
  }
  const searchStart = Math.max(0, markerIndex - 16);
  const relativeHeaderIndex = findLastIndex(
    lines.slice(searchStart, markerIndex),
    (line) => /^\s*Bash command\s*$/iu.test(line)
  );
  if (relativeHeaderIndex < 0) {
    return undefined;
  }
  return lines
    .slice(searchStart + relativeHeaderIndex + 1, markerIndex)
    .map((line) => line.trim())
    .find(Boolean);
}

function omitClaudePermissionDetails(
  screen: string,
  commandSha256: string | undefined,
  maxLength: number
): string {
  const placeholder = commandSha256
    ? `<verified Bash request omitted; sha256:${commandSha256.slice(0, 12)}>`
    : "<Bash request details omitted; inspect live pane>";
  const lines = normalizedScreenLines(screen);
  const markerIndex = findLastIndex(
    lines,
    (line) => /^\s*Do you want to proceed\?\s*$/iu.test(line)
  );
  let sanitizedScreen: string;
  if (markerIndex < 0) {
    sanitizedScreen = placeholder;
  } else {
    const searchStart = Math.max(0, markerIndex - 16);
    const relativeHeaderIndex = findLastIndex(
      lines.slice(searchStart, markerIndex),
      (line) => /^\s*Bash command\s*$/iu.test(line)
    );
    if (relativeHeaderIndex < 0) {
      sanitizedScreen = placeholder;
    } else {
      const headerIndex = searchStart + relativeHeaderIndex;
      // Start at the live dialog header instead of retaining scrollback. The
      // same raw command may have been echoed earlier and terminal wrapping can
      // split it across physical lines, making exact-string replacement unsafe.
      sanitizedScreen = [
        lines[headerIndex],
        `  ${placeholder}`,
        lines[markerIndex],
        "  <permission options omitted; inspect live pane>"
      ].join("\n");
    }
  }
  const sanitizedLines = normalizedScreenLines(sanitizedScreen);
  const excerpt = sanitizedLines
    .slice(Math.max(0, sanitizedLines.length - CLAUDE_EXCERPT_LINES))
    .join("\n");
  return redactString(excerpt).slice(-Math.max(0, maxLength));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function detectClaudeActivityState(
  screen: string,
  approval = detectClaudeApprovalPrompt(screen)
): { state: "awaiting_approval" | "working" | "idle" | "unknown"; reason: string } {
  if (approval.blocked) {
    return {
      state: "awaiting_approval",
      reason: approval.approvable
        ? "current Claude Code one-time permission prompt is highlighted"
        : "current Claude Code permission dialog requires manual review"
    };
  }

  const lines = claudeDetectionTail(screen);
  const idleIndex = findLastIndex(lines, (line) => isClaudeIdlePromptLine(line));
  const workingIndex = findLastIndex(lines, (line) => isClaudeWorkingLine(line));
  if (idleIndex > workingIndex && idleIndex >= Math.max(0, lines.length - 10)) {
    return {
      state: "idle",
      reason: "current Claude Code input prompt is visible near the end of the terminal tail"
    };
  }
  if (workingIndex >= 0 && workingIndex >= idleIndex) {
    return {
      state: "working",
      reason: "current Claude Code interruptible working marker is visible in the terminal tail"
    };
  }
  return {
    state: "unknown",
    reason: "no current Claude Code idle, working, or permission marker was detected in the terminal tail"
  };
}

export function claudeScreenExcerpt(screen: string, maxLength = 4000): string {
  const lines = normalizedScreenLines(screen);
  const excerpt = lines.slice(Math.max(0, lines.length - CLAUDE_EXCERPT_LINES)).join("\n");
  return redactString(excerpt).slice(-Math.max(0, maxLength));
}

function exactInteractiveAgentRow(
  pid: number,
  rows: readonly ClaudeAgentRow[]
): ClaudeAgentRow | undefined | null {
  const row = rows.find((candidate) =>
    Number.isInteger(candidate.pid) && candidate.pid === pid
  );
  if (!row) {
    return undefined;
  }
  return row.kind && row.kind !== "interactive" ? null : row;
}

function isNonInteractiveFlag(token: string): boolean {
  const flag = token.split("=", 1)[0];
  return NON_INTERACTIVE_FLAGS.has(flag) || /^-p.+/u.test(token);
}

function findClaudeSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      return undefined;
    }
    if (!token.startsWith("-")) {
      return CLAUDE_SUBCOMMANDS.has(token) ? token : undefined;
    }
    const flag = token.split("=", 1)[0];
    if (!token.includes("=") && OPTIONS_WITH_VALUES.has(flag)) {
      index += 1;
      continue;
    }
    if (!token.includes("=") && OPTIONAL_VALUE_OPTIONS.has(flag)) {
      const possibleValue = args[index + 1];
      if (possibleValue && !possibleValue.startsWith("-") && !CLAUDE_SUBCOMMANDS.has(possibleValue)) {
        index += 1;
      }
    }
  }
  return undefined;
}

function optionValue(args: readonly string[], option: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === option) {
      const value = args[index + 1];
      return value && !value.startsWith("-") ? nonEmptyString(value) : undefined;
    }
    if (token.startsWith(`${option}=`)) {
      return nonEmptyString(token.slice(option.length + 1));
    }
  }
  return undefined;
}

function shortOptionValue(args: readonly string[], option: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === option) {
      const value = args[index + 1];
      return value && !value.startsWith("-") ? nonEmptyString(value) : undefined;
    }
    if (token.startsWith(option) && token.length > option.length) {
      return nonEmptyString(token.slice(option.length));
    }
  }
  return undefined;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped) {
    token += "\\";
  }
  if (started) {
    tokens.push(token);
  }
  return tokens;
}

function claudeDetectionTail(screen: string): string[] {
  const lines = normalizedScreenLines(screen);
  return lines.slice(Math.max(0, lines.length - CLAUDE_SCREEN_TAIL_LINES));
}

function normalizedScreenLines(screen: string): string[] {
  return stripAnsi(String(screen || ""))
    .replace(/\r/g, "")
    .trimEnd()
    .split("\n");
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function isClaudeIdlePromptLine(line: string): boolean {
  return /^\s*❯[\s\u00a0]*$/u.test(line);
}

function isClaudeWorkingLine(line: string): boolean {
  // Codex also renders the words "esc to interrupt". Requiring Claude's spinner prevents
  // a recently reused tmux pane from inheriting a stale Codex working state.
  return /^\s*[✻✽✢✣✤✥✦✧]\s+.+(?:…|\.\.\.|\([^)]*(?:tokens?|\d+s|esc to interrupt)[^)]*\))\s*$/iu.test(line);
}

function isOneTimeYesChoice(label: string): boolean {
  return /^Yes\s*$/iu.test(label);
}

function isPersistentPermissionChoice(label: string): boolean {
  return /(?:don['’]t ask again|always allow|allow (?:this|the).*(?:session|project|directory)|yes,\s*and)/iu.test(label);
}

function isClaudePermissionFooterLine(line: string): boolean {
  return /^\s*Esc to cancel(?:\s*·\s*Tab to amend(?:\s*·\s*ctrl\+e to explain)?)?\s*$/iu
    .test(line);
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) {
      return index;
    }
  }
  return -1;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
