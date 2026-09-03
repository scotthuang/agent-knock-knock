import { createHash } from "node:crypto";
import type {
  ActiveTerminalProcess,
  TerminalProcessSnapshot
} from "./terminal-agent-adapter.js";
import { nonBlankString as stringValue } from "./value-guards.js";

export type CodexSessionCapability = "full" | "metadata_only" | "unavailable";
export type CodexProcessKind = "codex_cli";
export type { DiscoveryConfidence, TerminalControlRef } from "./terminal-agent-adapter.js";

export interface CodexThreadRow {
  id?: string;
  cwd?: string;
  rollout_path?: string;
  rolloutPath?: string;
  title?: string;
  preview?: string;
  first_user_message?: string;
  firstUserMessage?: string;
  updated_at_ms?: number;
  updatedAtMs?: number;
  archived?: number | boolean;
}

export interface CodexSessionSummary {
  id: string;
  cwd: string;
  rolloutPath?: string;
  title?: string;
  preview?: string;
  firstUserMessage?: string;
  updatedAtMs?: number;
  archived: boolean;
  capability: CodexSessionCapability;
  capabilityReason?: string;
}

/** @deprecated Import TerminalProcessSnapshot from terminal-agent-adapter instead. */
export type CodexProcessSnapshot = TerminalProcessSnapshot;

/** @deprecated Import ActiveTerminalProcess from terminal-agent-adapter for generic terminal code. */
export type ActiveCodexProcess = ActiveTerminalProcess<CodexProcessKind>;

export interface RolloutMessageExcerpt {
  role: "user" | "assistant" | "tool";
  text: string;
  timestamp?: string;
}

export interface RolloutCommandSummary {
  command: string;
  cwd?: string;
  status?: string;
  timestamp?: string;
}

export interface RolloutTurnSummary {
  userText: string;
  userTextHash: string;
  userTimestamp?: string;
  turnId?: string;
  completedAt?: string;
  lastAssistantMessage?: string;
}

export interface RolloutExcerpt {
  messages: RolloutMessageExcerpt[];
  commands: RolloutCommandSummary[];
  turns: RolloutTurnSummary[];
  skippedLines: number;
  truncated: boolean;
}

export interface ForkContextPackage {
  source: {
    agent: "codex";
    sessionId: string;
    cwd: string;
    title?: string;
    updatedAtMs?: number;
  };
  messages: RolloutMessageExcerpt[];
  commands: RolloutCommandSummary[];
  turns: RolloutTurnSummary[];
  truncated: boolean;
}

export interface RolloutExcerptOptions {
  maxMessages?: number;
  maxCommands?: number;
  maxTextLength?: number;
  maxTurns?: number;
}

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXACT_UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, "i");

const CODEX_NON_INTERACTIVE_SUBCOMMANDS = new Set([
  "agents",
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "mcp-server",
  "app-server",
  "remote-control",
  "app",
  "completion",
  "update",
  "doctor",
  "sandbox",
  "debug",
  "apply",
  "a",
  "queue",
  "archive",
  "delete",
  "migrate-rollouts",
  "unarchive",
  "cloud",
  "exec-server",
  "execpolicy",
  "features",
  "help",
  "responses-api-proxy",
  "stdio-to-uds",
  "cloud-tasks"
]);

const CODEX_NON_INTERACTIVE_FLAGS = new Set([
  "-h",
  "--help",
  "-V",
  "--version"
]);

const CODEX_OPTIONS_WITH_VALUES = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval"
]);

const CODEX_OPTIONS_WITH_MULTIPLE_VALUES = new Set([
  "-i",
  "--image"
]);

export function codexSessionsFromThreadRows(rows: CodexThreadRow[]): CodexSessionSummary[] {
  return rows
    .map((row) => codexSessionFromThreadRow(row))
    .filter((session): session is CodexSessionSummary => session !== undefined)
    .sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
}

export function codexSessionFromThreadRow(row: CodexThreadRow): CodexSessionSummary | undefined {
  const id = stringValue(row.id);
  const cwd = stringValue(row.cwd);
  if (!id || !cwd) {
    return undefined;
  }

  const rolloutPath = stringValue(row.rolloutPath) ?? stringValue(row.rollout_path);
  const updatedAtMs = numberValue(row.updatedAtMs) ?? numberValue(row.updated_at_ms);
  const title = cleanText(stringValue(row.title));
  const preview = cleanText(stringValue(row.preview));
  const firstUserMessage = cleanText(stringValue(row.firstUserMessage) ?? stringValue(row.first_user_message));
  const capability = rolloutPath ? "full" : "metadata_only";

  return {
    id,
    cwd,
    rolloutPath,
    title,
    preview,
    firstUserMessage,
    updatedAtMs,
    archived: row.archived === true || row.archived === 1,
    capability,
    capabilityReason: capability === "full" ? undefined : "missing rollout_path"
  };
}

export function discoverCodexProcesses(processes: CodexProcessSnapshot[]): ActiveCodexProcess[] {
  return processes
    .map((process) => classifyCodexProcess(process))
    .filter((process): process is ActiveCodexProcess => process !== undefined);
}

export function listActiveCodexCli(processes: CodexProcessSnapshot[]): ActiveCodexProcess[] {
  return discoverCodexProcesses(processes).filter((process) => process.kind === "codex_cli");
}

export function classifyCodexProcess(process: CodexProcessSnapshot): ActiveCodexProcess | undefined {
  const command = process.command.trim();
  if (!command) {
    return undefined;
  }

  if (!commandInvokesCodexCli(command)) {
    return undefined;
  }
  if (!commandInvokesInteractiveCodexCli(command)) {
    return undefined;
  }

  const sessionId = extractResumeSessionId(command);
  return {
    ...baseProcess(process),
    kind: "codex_cli",
    sessionId,
    confidence: sessionId ? "high" : process.cwd ? "medium" : "low",
    reason: sessionId ? "codex resume command includes session id" : "codex CLI process without visible session id"
  };
}

export function extractResumeSessionId(command: string): string | undefined {
  const args = codexCliArguments(command);
  if (!args) {
    return undefined;
  }
  const inspection = inspectCodexTopLevelArguments(args);
  if (
    inspection.hasExitFlag ||
    inspection.firstPositionalIndex === undefined ||
    args[inspection.firstPositionalIndex] !== "resume"
  ) {
    return undefined;
  }
  const candidate = args[inspection.firstPositionalIndex + 1];
  return candidate && EXACT_UUID_REGEX.test(candidate) ? candidate : undefined;
}

export function parseCodexRolloutJsonl(text: string, options: RolloutExcerptOptions = {}): RolloutExcerpt {
  const maxMessages = options.maxMessages ?? 12;
  const maxCommands = options.maxCommands ?? 8;
  const maxTextLength = options.maxTextLength ?? 1200;
  const maxTurns = options.maxTurns ?? 12;
  const messages: RolloutMessageExcerpt[] = [];
  const commands: RolloutCommandSummary[] = [];
  const turns: RolloutTurnSummary[] = [];
  let skippedLines = 0;
  let truncated = false;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }

    const record = asRecord(event);
    if (!record) {
      skippedLines += 1;
      continue;
    }

    const message = messageExcerptFromRolloutRecord(record, maxTextLength);
    if (message) {
      if (messages.length < maxMessages) {
        messages.push(message);
      } else {
        truncated = true;
      }
    }

    const userTurn = userTurnFromRolloutRecord(record, maxTextLength);
    if (userTurn) {
      turns.push(userTurn);
      if (turns.length > maxTurns) {
        turns.shift();
        truncated = true;
      }
    }

    const completion = taskCompletionFromRolloutRecord(record, maxTextLength);
    if (completion && turns.length > 0) {
      Object.assign(turns[turns.length - 1], completion);
    }

    const command = commandSummaryFromRolloutRecord(record, maxTextLength);
    if (command) {
      if (commands.length < maxCommands) {
        commands.push(command);
      } else {
        truncated = true;
      }
    }
  }

  return {
    messages,
    commands,
    turns,
    skippedLines,
    truncated
  };
}

export function buildForkContextPackage(session: CodexSessionSummary, rollout: RolloutExcerpt): ForkContextPackage {
  return {
    source: {
      agent: "codex",
      sessionId: session.id,
      cwd: session.cwd,
      title: session.title ?? session.preview ?? session.firstUserMessage,
      updatedAtMs: session.updatedAtMs
    },
    messages: rollout.messages,
    commands: rollout.commands,
    turns: rollout.turns,
    truncated: rollout.truncated
  };
}

function baseProcess(process: CodexProcessSnapshot): Omit<ActiveCodexProcess, "kind" | "confidence" | "reason"> {
  return {
    agent: "codex",
    pid: process.pid,
    ppid: process.ppid,
    command: process.command,
    cwd: process.cwd,
    elapsed: process.elapsed
  };
}

function commandInvokesCodexCli(command: string): boolean {
  return codexCliArguments(command) !== undefined;
}

function codexCliArguments(command: string): readonly string[] | undefined {
  const tokens = tokenizeCommand(command);
  const firstCommandIndex = tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  if (firstCommandIndex < 0) {
    return undefined;
  }

  const first = tokens[firstCommandIndex];
  const second = tokens[firstCommandIndex + 1];
  if (pathBasename(first) === "codex") {
    return tokens.slice(firstCommandIndex + 1);
  }

  return pathBasename(first) === "node" && pathBasename(second) === "codex"
    ? tokens.slice(firstCommandIndex + 2)
    : undefined;
}

function commandInvokesInteractiveCodexCli(command: string): boolean {
  const args = codexCliArguments(command);
  if (!args) {
    return false;
  }
  const inspection = inspectCodexTopLevelArguments(args);
  if (inspection.hasExitFlag) {
    return false;
  }
  if (inspection.firstPositionalIndex === undefined) {
    return true;
  }
  return !CODEX_NON_INTERACTIVE_SUBCOMMANDS.has(
    args[inspection.firstPositionalIndex]
  );
}

function inspectCodexTopLevelArguments(args: readonly string[]): {
  firstPositionalIndex?: number;
  hasExitFlag: boolean;
} {
  let firstPositionalIndex: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      break;
    }
    const flag = codexOptionFlag(token);
    if (CODEX_NON_INTERACTIVE_FLAGS.has(flag)) {
      return { firstPositionalIndex, hasExitFlag: true };
    }
    if (firstPositionalIndex !== undefined) {
      continue;
    }
    if (token.startsWith("-")) {
      if (
        CODEX_OPTIONS_WITH_MULTIPLE_VALUES.has(flag) &&
        !codexOptionHasInlineValue(token, flag)
      ) {
        while (args[index + 1] && !args[index + 1].startsWith("-")) {
          index += 1;
        }
        continue;
      }
      if (
        CODEX_OPTIONS_WITH_VALUES.has(flag) &&
        !codexOptionHasInlineValue(token, flag)
      ) {
        index += 1;
      }
      continue;
    }
    firstPositionalIndex = index;
  }
  return { firstPositionalIndex, hasExitFlag: false };
}

function codexOptionFlag(token: string): string {
  if (token.startsWith("--")) {
    return token.split("=", 1)[0];
  }
  return token.length > 2 ? token.slice(0, 2) : token;
}

function codexOptionHasInlineValue(token: string, flag: string): boolean {
  return flag.startsWith("--") ? token.includes("=") : token.length > 2;
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

function userTurnFromRolloutRecord(
  record: Record<string, unknown>,
  maxTextLength: number
): RolloutTurnSummary | undefined {
  if (record.type !== "event_msg") {
    return undefined;
  }
  const payload = asRecord(record.payload);
  if (payload?.type !== "user_message") {
    return undefined;
  }
  const userText = cleanText(stringValue(payload.message));
  if (!userText) {
    return undefined;
  }
  return {
    userText: truncateText(userText, maxTextLength),
    userTextHash: createHash("sha256").update(userText).digest("hex"),
    userTimestamp: stringValue(record.timestamp)
  };
}

function taskCompletionFromRolloutRecord(
  record: Record<string, unknown>,
  maxTextLength: number
): Partial<RolloutTurnSummary> | undefined {
  if (record.type !== "event_msg") {
    return undefined;
  }
  const payload = asRecord(record.payload);
  if (payload?.type !== "task_complete") {
    return undefined;
  }
  const lastAssistantMessage = cleanText(stringValue(payload.last_agent_message));
  return {
    turnId: stringValue(payload.turn_id),
    completedAt: stringValue(record.timestamp),
    lastAssistantMessage: lastAssistantMessage
      ? truncateText(lastAssistantMessage, maxTextLength)
      : undefined
  };
}

function pathBasename(value: string | undefined): string | undefined {
  return value?.split("/").at(-1)?.toLowerCase();
}

function messageExcerptFromRolloutRecord(record: Record<string, unknown>, maxTextLength: number): RolloutMessageExcerpt | undefined {
  const timestamp = stringValue(record.timestamp);
  const payload = asRecord(record.payload);
  if (!payload) {
    return undefined;
  }

  if (record.type === "event_msg") {
    if (payload.type === "user_message") {
      return message("user", stringValue(payload.message), timestamp, maxTextLength);
    }
    if (payload.type === "agent_message") {
      return message("assistant", stringValue(payload.message), timestamp, maxTextLength);
    }
  }

  if (record.type !== "response_item") {
    return undefined;
  }

  if (payload.type === "message") {
    const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : undefined;
    const text = textFromContentArray(payload.content);
    return role ? message(role, text, timestamp, maxTextLength) : undefined;
  }

  if (payload.type === "function_call_output") {
    return message("tool", stringValue(payload.output), timestamp, maxTextLength);
  }

  return undefined;
}

function commandSummaryFromRolloutRecord(record: Record<string, unknown>, maxTextLength: number): RolloutCommandSummary | undefined {
  const payload = asRecord(record.payload);
  if (!payload) {
    return undefined;
  }

  const timestamp = stringValue(record.timestamp);
  const command = stringValue(payload.command) ?? stringValue(payload.cmd);
  if (command) {
    return {
      command: truncateText(command, maxTextLength),
      cwd: stringValue(payload.cwd),
      status: stringValue(payload.status),
      timestamp
    };
  }

  const call = asRecord(payload.call) ?? asRecord(payload.tool_call);
  const callCommand = stringValue(call?.command) ?? stringValue(call?.cmd);
  if (!callCommand) {
    return undefined;
  }

  return {
    command: truncateText(callCommand, maxTextLength),
    cwd: stringValue(call?.cwd),
    status: stringValue(call?.status),
    timestamp
  };
}

function message(role: RolloutMessageExcerpt["role"], text: string | undefined, timestamp: string | undefined, maxTextLength: number): RolloutMessageExcerpt | undefined {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return undefined;
  }

  return {
    role,
    text: truncateText(cleaned, maxTextLength),
    timestamp
  };
}

function textFromContentArray(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content
    .map((item) => {
      const record = asRecord(item);
      return stringValue(record?.text);
    })
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 15)).trimEnd()}... [truncated]`;
}

function cleanText(text: string | undefined): string | undefined {
  const cleaned = text?.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
