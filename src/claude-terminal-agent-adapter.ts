import fs from "node:fs";
import path from "node:path";
import {
  ClaudeHookStore,
  type ClaudeCompletionInspection,
  type ClaudePermissionInspection,
  type ClaudeSessionIdentity
} from "./claude-hook-store.js";
import { redactString } from "./runtime-log.js";
import type {
  ActiveTerminalProcess,
  TerminalAgentAdapter,
  TerminalApprovalDecisionRequest,
  TerminalApprovalDecisionResult,
  TerminalApprovalInspection,
  TerminalCompletionEvidence,
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
  status?: string;
}

export interface CreateClaudeTerminalAgentAdapterOptions {
  /**
   * A point-in-time `claude agents --json --all` snapshot. Rows are joined only by an exact PID;
   * names, cwd values, and fuzzy command matches are never used as process identity.
   */
  agentRows?: readonly ClaudeAgentRow[];
  /** Structured Claude hook state used for one-time permission decisions and durable completion. */
  hookStore?: ClaudeHookStore;
  /** Canonical launchers explicitly configured by Claude's trusted Tokenjuice PreToolUse hook. */
  trustedTokenjuiceLaunchers?: readonly ClaudeTrustedTokenjuiceLauncher[];
}

export interface ClaudeTrustedTokenjuiceLauncher {
  configuredPath: string;
  canonicalPath: string;
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
const TRUSTED_CLAUDE_SHELL_PATHS = new Set([
  "/bin/bash",
  "/bin/dash",
  "/bin/sh",
  "/bin/zsh",
  "/usr/bin/bash",
  "/usr/bin/dash",
  "/usr/bin/sh",
  "/usr/bin/zsh"
]);
const TRUSTED_CLAUDE_SHELL_TARGETS = new Set([...TRUSTED_CLAUDE_SHELL_PATHS].flatMap((shell) => {
  try {
    return [fs.realpathSync(shell)];
  } catch {
    return [];
  }
}));
const ANSI_ESCAPE_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu;

export function createClaudeTerminalAgentAdapter(
  options: CreateClaudeTerminalAgentAdapterOptions = {}
): TerminalAgentAdapter<ClaudeProcessKind> {
  const agentRows = options.agentRows ?? [];
  const hookStore = options.hookStore;
  const trustedTokenjuiceLaunchers = options.trustedTokenjuiceLaunchers ?? [];
  return {
    agent: "claude",
    displayName: "Claude Code",
    capabilities: {
      processDiscovery: true,
      screenStatus: true,
      terminalApproval: true,
      // A visible idle prompt is not durable proof that the requested turn completed.
      screenCompletion: false,
      durableCompletion: hookStore !== undefined,
      cancellation: true
    },
    cancelKeys: ["Escape"],
    classifyProcess(snapshot) {
      return classifyClaudeProcess(snapshot, agentRows);
    },
    inspectScreen(screenOptions) {
      return inspectClaudeScreenWithHooks(
        screenOptions,
        hookStore,
        trustedTokenjuiceLaunchers
      );
    },
    ...(hookStore
      ? {
          async resolveApproval(request: TerminalApprovalDecisionRequest) {
            return resolveClaudeHookApproval(hookStore, request);
          },
          async detectDurableCompletion(request: TerminalDurableCompletionRequest) {
            return detectClaudeHookCompletion(hookStore, request);
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
  const approval = detectClaudeApprovalPrompt(options.screen);
  return {
    activity: detectClaudeActivityState(options.screen, approval),
    approval,
    screenExcerpt: claudeScreenExcerpt(options.screen, options.maxExcerptLength ?? 4000)
    // Deliberately no screen completion: idle alone can follow cancellation, errors, or old output.
  };
}

function inspectClaudeScreenWithHooks(
  options: TerminalScreenInspectionOptions,
  hookStore: ClaudeHookStore | undefined,
  trustedTokenjuiceLaunchers: readonly ClaudeTrustedTokenjuiceLauncher[]
): TerminalScreenInspection {
  const screenInspection = inspectClaudeScreen(options);
  if (!hookStore) {
    return screenInspection;
  }

  const identity = exactClaudeHookIdentity(options.runtime);
  if (!identity) {
    return screenInspection.approval.blocked
      ? unverifiedHookApproval(
          screenInspection,
          "Claude hook permission could not be verified without an exact session id or pid"
        )
      : screenInspection;
  }

  let hookInspection: ClaudePermissionInspection;
  try {
    hookInspection = hookStore.inspectPermission(identity);
  } catch (error) {
    return screenInspection.approval.blocked
      ? unverifiedHookApproval(
          screenInspection,
          `Claude hook permission identity could not be verified: ${errorMessage(error)}`
        )
      : screenInspection;
  }

  if (hookInspection.blocked) {
    return hookPermissionScreenInspection(
      screenInspection,
      hookInspection,
      trustedTokenjuiceLaunchers
    );
  }
  if (screenInspection.approval.blocked) {
    return unverifiedHookApproval(
      screenInspection,
      `Claude terminal permission is visible but no current structured hook request matched: ${hookInspection.reason}`
    );
  }
  return screenInspection;
}

function hookPermissionScreenInspection(
  screenInspection: TerminalScreenInspection,
  hookInspection: Extract<ClaudePermissionInspection, { blocked: true }>,
  trustedTokenjuiceLaunchers: readonly ClaudeTrustedTokenjuiceLauncher[]
): TerminalScreenInspection {
  if (!hookInspection.approvable) {
    return {
      ...screenInspection,
      activity: {
        state: "awaiting_approval",
        reason: hookInspection.reason
      },
      approval: {
        blocked: true,
        approvable: false,
        reason: hookInspection.reason,
        promptKind: "claude_permission"
      }
    };
  }
  const display = claudePermissionDisplay(hookInspection.toolName, hookInspection.toolInput);
  const command = hookInspection.command === undefined
    ? undefined
    : claudePermissionCommandForApproval(
        hookInspection.command,
        trustedTokenjuiceLaunchers
      );
  const requestDetail = command && command.command === undefined
    ? [
        command.display ? `Command: ${command.display}` : undefined,
        display.requestDetail
      ].filter((value): value is string => Boolean(value))
      .join("; ")
      .slice(0, CLAUDE_PERMISSION_DETAIL_LENGTH)
    : display.requestDetail;
  return {
    ...screenInspection,
    activity: {
      state: "awaiting_approval",
      reason: hookInspection.reason
    },
    approval: {
      blocked: true,
      approvable: true,
      promptKind: hookInspection.promptKind,
      cwd: hookInspection.cwd,
      toolName: display.toolName,
      ...(requestDetail ? { requestDetail } : {}),
      ...(command?.command === undefined ? {} : { command: command.command }),
      action: {
        mode: "structured",
        keys: [],
        label: "Allow once",
        requestId: hookInspection.requestId
      }
    }
  };
}

/**
 * Tokenjuice's official Claude PreToolUse hook wraps Bash through a login shell before
 * PermissionRequest runs. Recover only that exact, source-tagged shape so policy matching
 * sees Claude's original command; every other wrapper remains visible and fails closed.
 */
export function normalizeClaudePermissionCommand(
  command: string,
  trustedTokenjuiceLaunchers: readonly ClaudeTrustedTokenjuiceLauncher[] = []
): string {
  const tokens = tokenizeTrustedWrapperCommand(command);
  let normalized = command;
  const launcher = tokens?.[0];
  const canonicalLauncher = launcher && path.isAbsolute(launcher)
    ? realpathOrUndefined(launcher)
    : undefined;
  const trustedLauncher = launcher
    ? trustedTokenjuiceLaunchers.find((candidate) => candidate.configuredPath === launcher)
    : undefined;
  if (
    tokens &&
    canonicalLauncher &&
    trustedLauncher?.canonicalPath === canonicalLauncher &&
    tokens[1] === "wrap"
  ) {
    let index = 2;
    if (tokens[index] === "--source" && tokens[index + 1] === "claude-code") {
      index += 2;
    } else if (tokens[index] === "--source=claude-code") {
      index += 1;
    } else {
      return command;
    }
    const shell = tokens[index + 1];
    const canonicalShell = shell && path.isAbsolute(shell)
      ? realpathOrUndefined(shell)
      : undefined;
    if (
      tokens[index] === "--" &&
      shell !== undefined &&
      TRUSTED_CLAUDE_SHELL_PATHS.has(shell) &&
      canonicalShell !== undefined &&
      TRUSTED_CLAUDE_SHELL_TARGETS.has(canonicalShell) &&
      tokens[index + 2] === "-lc" &&
      tokens.length === index + 4 &&
      tokens[index + 3]
    ) {
      normalized = tokens[index + 3];
    }
  }
  return normalized;
}

export function claudePermissionCommandForApproval(
  command: string,
  trustedTokenjuiceLaunchers: readonly ClaudeTrustedTokenjuiceLauncher[] = []
): { command?: string; display: string } {
  const normalized = normalizeClaudePermissionCommand(command, trustedTokenjuiceLaunchers);
  const redacted = redactString(normalized);
  const display = singleLineClaudePermissionValue(redacted, CLAUDE_PERMISSION_DETAIL_LENGTH - 20);
  const policySafe = normalized.length <= CLAUDE_AUTO_APPROVAL_COMMAND_LENGTH && redacted === normalized;
  return {
    ...(policySafe && normalized.trim() ? { command: normalized } : {}),
    display
  };
}

function claudePermissionDisplay(
  toolName: string,
  toolInput: unknown
): { toolName: string; requestDetail?: string } {
  const safeToolName = singleLineClaudePermissionValue(toolName, 120) || "Unknown Claude tool";
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return { toolName: safeToolName };
  }

  const input = toolInput as Record<string, unknown>;
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["file_path", "File"],
    ["path", "Path"],
    ["notebook_path", "Notebook"],
    ["url", "URL"],
    ["query", "Query"],
    ["pattern", "Pattern"],
    ["description", "Description"],
    ["domain", "Domain"]
  ];
  const details: string[] = [];
  for (const [key, label] of fields) {
    const value = input[key];
    if (typeof value !== "string") {
      continue;
    }
    const safeValue = singleLineClaudePermissionValue(value, 300);
    if (safeValue) {
      details.push(`${label}: ${safeValue}`);
    }
    if (details.length === 3) {
      break;
    }
  }
  const requestDetail = details.join("; ").slice(0, CLAUDE_PERMISSION_DETAIL_LENGTH);
  return requestDetail ? { toolName: safeToolName, requestDetail } : { toolName: safeToolName };
}

function singleLineClaudePermissionValue(value: string, maxLength: number): string {
  return redactString(value)
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function unverifiedHookApproval(
  screenInspection: TerminalScreenInspection,
  reason: string
): TerminalScreenInspection {
  return {
    ...screenInspection,
    activity: {
      state: "awaiting_approval",
      reason
    },
    approval: {
      blocked: true,
      approvable: false,
      reason,
      promptKind: screenInspection.approval.promptKind ?? "claude_permission",
      ...(screenInspection.approval.command === undefined
        ? {}
        : { command: screenInspection.approval.command })
    }
  };
}

async function resolveClaudeHookApproval(
  hookStore: ClaudeHookStore,
  request: TerminalApprovalDecisionRequest
): Promise<TerminalApprovalDecisionResult> {
  if (request.expectedFingerprint !== request.actualFingerprint) {
    return {
      resolved: false,
      reason: "Claude approval fingerprint changed before the structured decision"
    };
  }
  if (!request.inspection.approval.approvable ||
      request.inspection.approval.action.mode !== "structured" ||
      !request.inspection.approval.action.requestId) {
    return {
      resolved: false,
      reason: "Claude approval is not a current structured hook request"
    };
  }

  const runtime = request.runtime;
  const identity = exactClaudeHookIdentity(runtime);
  if (!identity || !runtime?.conversationId || !runtime.messageId) {
    return {
      resolved: false,
      requestId: request.inspection.approval.action.requestId,
      reason: "Claude structured approval requires exact session or pid plus conversation and message identity"
    };
  }

  try {
    const current = hookStore.inspectPermission(identity);
    if (!current.blocked || !current.approvable) {
      return {
        resolved: false,
        requestId: request.inspection.approval.action.requestId,
        reason: current.reason
      };
    }
    if (current.requestId !== request.inspection.approval.action.requestId) {
      return {
        resolved: false,
        requestId: current.requestId,
        reason: "Claude permission request changed before the structured decision"
      };
    }
    if (current.conversationId !== runtime.conversationId || current.messageId !== runtime.messageId) {
      return {
        resolved: false,
        requestId: current.requestId,
        reason: "Claude permission request belongs to a different conversation message"
      };
    }
    if (runtime.sessionId !== undefined && current.sessionId !== runtime.sessionId) {
      return {
        resolved: false,
        requestId: current.requestId,
        reason: "Claude permission request belongs to a different session"
      };
    }

    const lease = hookStore.resolveLease(identity);
    if (!lease?.authorizationEligible ||
        lease.lease.conversationId !== runtime.conversationId ||
        lease.lease.messageId !== runtime.messageId ||
        (runtime.terminalTarget !== undefined && lease.lease.terminalTarget !== runtime.terminalTarget)) {
      return {
        resolved: false,
        requestId: current.requestId,
        reason: "Claude managed lease no longer matches the terminal conversation"
      };
    }

    hookStore.decidePermission({
      sessionId: current.sessionId,
      requestId: current.requestId,
      fingerprint: current.fingerprint,
      conversationId: runtime.conversationId,
      messageId: runtime.messageId,
      decision: request.decision,
      ...(request.decision === "deny" && request.interrupt !== undefined
        ? { interrupt: request.interrupt }
        : {})
    });
    return {
      resolved: true,
      requestId: current.requestId,
      reason: request.decision === "allow"
        ? "Claude one-time permission was allowed through the structured hook"
        : "Claude permission was denied through the structured hook"
    };
  } catch (error) {
    return {
      resolved: false,
      requestId: request.inspection.approval.action.requestId,
      reason: `Claude structured permission could not be resolved: ${errorMessage(error)}`
    };
  }
}

async function detectClaudeHookCompletion(
  hookStore: ClaudeHookStore,
  request: TerminalDurableCompletionRequest
): Promise<TerminalCompletionEvidence | undefined> {
  if (!request.startedAt) {
    return undefined;
  }
  const runtime = completionRuntime(request.context);
  if (!runtime.conversationId || !runtime.messageId) {
    return undefined;
  }
  const identity = {
    ...(runtime.sessionId ?? request.sessionId
      ? { sessionId: runtime.sessionId ?? request.sessionId }
      : {}),
    ...(runtime.pid === undefined ? {} : { pid: runtime.pid }),
    ...(runtime.cwd ?? request.cwd ? { cwd: runtime.cwd ?? request.cwd } : {}),
    requireUnique: true
  } satisfies ClaudeSessionIdentity;
  if (!identity.sessionId && identity.pid === undefined && !identity.cwd) {
    return undefined;
  }

  let completion: ClaudeCompletionInspection;
  try {
    completion = hookStore.detectCompletion({
      ...identity,
      startedAt: request.startedAt,
      ...(runtime.promptId === undefined ? {} : { promptId: runtime.promptId }),
      conversationId: runtime.conversationId,
      messageId: runtime.messageId
    });
  } catch {
    return undefined;
  }
  if (completion.status === "done") {
    return {
      source: "durable",
      outcome: "success",
      text: completion.text,
      timestamp: completion.timestamp,
      id: completion.eventId,
      confidence: "high",
      metadata: {
        match: "claude_stop_hook",
        session_id: completion.sessionId,
        prompt_id: completion.promptId,
        cwd: completion.cwd
      }
    };
  }
  if (completion.status === "failed") {
    return {
      source: "durable",
      outcome: "failure",
      text: claudeFailureText(completion),
      timestamp: completion.failure.receivedAt,
      id: completion.failure.eventId,
      confidence: "high",
      metadata: {
        match: "claude_stop_failure_hook",
        session_id: completion.sessionId,
        prompt_id: completion.promptId,
        error: completion.failure.code,
        ...(completion.failure.details === undefined
          ? {}
          : { error_details: completion.failure.details })
      }
    };
  }
  // Pending background work and unknown/incomplete hook payloads are not completion evidence.
  return undefined;
}

function exactClaudeHookIdentity(
  runtime: TerminalRuntimeIdentity | undefined
): ClaudeSessionIdentity | undefined {
  if (!runtime || (runtime.sessionId === undefined && runtime.pid === undefined)) {
    return undefined;
  }
  return {
    ...(runtime.sessionId === undefined ? {} : { sessionId: runtime.sessionId }),
    ...(runtime.pid === undefined ? {} : { pid: runtime.pid }),
    ...(runtime.cwd === undefined ? {} : { cwd: runtime.cwd }),
    requireUnique: true
  };
}

function completionRuntime(context: unknown): {
  sessionId?: string;
  pid?: number;
  cwd?: string;
  promptId?: string;
  conversationId?: string;
  messageId?: string;
} {
  const direct = recordValue(context);
  const nativeTakeover = recordValue(direct?.nativeTakeover);
  const conversation = recordValue(direct?.conversation);
  return {
    sessionId: nonEmptyString(nativeTakeover?.terminal_agent_session_id) ??
      nonEmptyString(direct?.sessionId),
    pid: positiveInteger(nativeTakeover?.terminal_agent_pid) ?? positiveInteger(direct?.pid),
    cwd: nonEmptyString(nativeTakeover?.source_cwd) ?? nonEmptyString(direct?.cwd),
    promptId: nonEmptyString(nativeTakeover?.terminal_agent_prompt_id) ??
      nonEmptyString(direct?.promptId) ??
      nonEmptyString(direct?.prompt_id),
    conversationId: nonEmptyString(direct?.conversationId) ??
      nonEmptyString(conversation?.conversation_id),
    messageId: nonEmptyString(direct?.messageId) ??
      nonEmptyString(nativeTakeover?.terminal_bridge_message_id)
  };
}

function claudeFailureText(
  completion: Extract<ClaudeCompletionInspection, { status: "failed" }>
): string {
  const details = completion.failure.details === undefined
    ? undefined
    : typeof completion.failure.details === "string"
      ? completion.failure.details
      : JSON.stringify(completion.failure.details);
  return [
    `Claude Code turn failed (${completion.failure.code}).`,
    completion.failure.message,
    details === undefined ? undefined : `Details: ${details}`
  ].filter((part): part is string => Boolean(part)).join(" ");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function detectClaudeApprovalPrompt(screen: string): TerminalApprovalInspection {
  const lines = claudeDetectionTail(screen);
  const markerIndex = findLastIndex(lines, (line) => /\bDo you want to proceed\?\s*$/iu.test(line));
  if (markerIndex < 0) {
    return {
      blocked: false,
      approvable: false,
      reason: "no current Claude Code permission dialog was detected in the terminal tail"
    };
  }

  const region = lines.slice(markerIndex);
  const highlighted = findHighlightedChoice(region);
  const newerStateIndex = findLastIndex(region, (line, index) =>
    index > (highlighted?.index ?? -1) && (isClaudeIdlePromptLine(line) || isClaudeWorkingLine(line))
  );
  const hasPermissionChoices = region.some((line) => isPermissionChoice(line));
  const hasUnexpectedTrailingContent = highlighted
    ? region.slice(highlighted.index + 1).some((line) => !isPermissionDialogTrailingLine(line))
    : false;

  if (newerStateIndex >= 0 || hasUnexpectedTrailingContent || !hasPermissionChoices) {
    return {
      blocked: false,
      approvable: false,
      reason: newerStateIndex >= 0 || hasUnexpectedTrailingContent
        ? "the Claude Code permission dialog appears stale"
        : "the matching text is not a recognized Claude Code permission dialog"
    };
  }

  if (!highlighted) {
    return {
      blocked: true,
      approvable: false,
      reason: "the current Claude Code permission dialog has no recognized highlighted choice",
      promptKind: "claude_permission"
    };
  }

  if (!isOneTimeYesChoice(highlighted.label)) {
    return {
      blocked: true,
      approvable: false,
      reason: isPersistentPermissionChoice(highlighted.label)
        ? "the highlighted Claude Code choice would persist permission"
        : "the highlighted Claude Code choice is not the one-time Yes option",
      promptKind: "claude_permission"
    };
  }

  return {
    blocked: true,
    approvable: true,
    promptKind: "claude_permission",
    action: {
      mode: "keys",
      keys: ["C-m"],
      label: "Yes"
    }
  };
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

function realpathOrUndefined(value: string): string | undefined {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

function tokenizeTrustedWrapperCommand(command: string): string[] | undefined {
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
  if (escaped || quote) {
    return undefined;
  }
  if (started) {
    tokens.push(token);
  }
  return tokens;
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

function isPermissionChoice(line: string): boolean {
  const choice = choiceLabel(line);
  return choice !== undefined && (
    isOneTimeYesChoice(choice) ||
    isPersistentPermissionChoice(choice) ||
    /^No(?:\b|,)/iu.test(choice)
  );
}

function isPermissionDialogTrailingLine(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed ||
    isPermissionChoice(line) ||
    /^(?:Esc|Enter|Tab|Shift\+Tab)\b.*(?:cancel|confirm|amend|select|cycle)/iu.test(trimmed) ||
    /^[─━═╌╍┄┅┈┉\s]+$/u.test(trimmed);
}

function findHighlightedChoice(lines: readonly string[]): { index: number; label: string } | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*❯\s*(?:\d+\.\s*)?(.+?)\s*$/u.exec(lines[index]);
    const label = nonEmptyString(match?.[1]);
    if (label) {
      return { index, label };
    }
  }
  return undefined;
}

function choiceLabel(line: string): string | undefined {
  const match = /^\s*(?:❯\s*)?(?:\d+\.\s*)?(.+?)\s*$/u.exec(line);
  return nonEmptyString(match?.[1]);
}

function isOneTimeYesChoice(label: string): boolean {
  return /^Yes\s*$/iu.test(label);
}

function isPersistentPermissionChoice(label: string): boolean {
  return /(?:don['’]t ask again|always allow|allow (?:this|the).*(?:session|project|directory)|yes,\s*and)/iu.test(label);
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
