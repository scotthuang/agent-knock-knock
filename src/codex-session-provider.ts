export type CodexSessionCapability = "full" | "metadata_only" | "unavailable";
export type CodexProcessKind = "codex_cli" | "codex_acp";
export type DiscoveryConfidence = "high" | "medium" | "low";

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

export interface CodexSessionModelInfo {
  model: string;
  acpxModel: string;
  source: "turn_context" | "session_meta";
}

export interface CodexProcessSnapshot {
  pid: number;
  ppid?: number;
  command: string;
  cwd?: string;
  elapsed?: string;
}

export interface ActiveCodexProcess {
  pid: number;
  ppid?: number;
  command: string;
  cwd?: string;
  elapsed?: string;
  kind: CodexProcessKind;
  sessionId?: string;
  confidence: DiscoveryConfidence;
  reason: string;
  terminalControl?: TerminalControlRef;
}

export interface TerminalControlRef {
  kind: "tmux";
  target: string;
  socketPath?: string;
  session: string;
  window: number;
  pane: number;
  panePid: number;
  currentCommand?: string;
  currentPath?: string;
  capabilities: ("capture_screen" | "send_keys" | "terminal_approval")[];
}

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

export interface RolloutExcerpt {
  messages: RolloutMessageExcerpt[];
  commands: RolloutCommandSummary[];
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
  truncated: boolean;
}

export interface RolloutExcerptOptions {
  maxMessages?: number;
  maxCommands?: number;
  maxTextLength?: number;
}

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RESUME_SESSION_REGEX = new RegExp(`(?:^|\\s)resume\\s+(${UUID_PATTERN})(?:\\s|$)`, "i");

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

  if (/\bcodex-acp(?:\s|$)/i.test(command) || /@agentclientprotocol\/codex-acp|@zed-industries\/codex-acp/i.test(command)) {
    return {
      ...baseProcess(process),
      kind: "codex_acp",
      sessionId: extractResumeSessionId(command),
      confidence: "medium",
      reason: "codex ACP adapter process"
    };
  }

  if (!commandInvokesCodexCli(command)) {
    return undefined;
  }
  if (commandInvokesCodexAppServer(command)) {
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
  return RESUME_SESSION_REGEX.exec(command)?.[1];
}

export function parseCodexRolloutJsonl(text: string, options: RolloutExcerptOptions = {}): RolloutExcerpt {
  const maxMessages = options.maxMessages ?? 12;
  const maxCommands = options.maxCommands ?? 8;
  const maxTextLength = options.maxTextLength ?? 1200;
  const messages: RolloutMessageExcerpt[] = [];
  const commands: RolloutCommandSummary[] = [];
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
    skippedLines,
    truncated
  };
}

export function parseCodexRolloutModel(text: string): CodexSessionModelInfo | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const record = asRecord(event);
    const payload = asRecord(record?.payload);
    if (!record || !payload) {
      continue;
    }

    const directModel = stringValue(payload.model);
    if (directModel && (record.type === "turn_context" || record.type === "session_meta")) {
      return {
        model: directModel,
        acpxModel: normalizeCodexAcpxModel(directModel),
        source: record.type
      };
    }

    if (record.type === "turn_context") {
      const collaborationMode = asRecord(payload.collaboration_mode);
      const settings = asRecord(collaborationMode?.settings);
      const settingsModel = stringValue(settings?.model);
      if (settingsModel) {
        return {
          model: settingsModel,
          acpxModel: normalizeCodexAcpxModel(settingsModel),
          source: "turn_context"
        };
      }
    }
  }

  return undefined;
}

export function normalizeCodexAcpxModel(model: string): string {
  const cleaned = model.trim();
  if (!cleaned || cleaned.includes("[")) {
    return cleaned;
  }

  return /^gpt-/i.test(cleaned) ? `${cleaned}[medium]` : cleaned;
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
    truncated: rollout.truncated
  };
}

function baseProcess(process: CodexProcessSnapshot): Omit<ActiveCodexProcess, "kind" | "confidence" | "reason"> {
  return {
    pid: process.pid,
    ppid: process.ppid,
    command: process.command,
    cwd: process.cwd,
    elapsed: process.elapsed
  };
}

function commandInvokesCodexCli(command: string): boolean {
  const tokens = command.split(/\s+/).filter(Boolean);
  const firstCommandIndex = tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  if (firstCommandIndex < 0) {
    return false;
  }

  const first = tokens[firstCommandIndex];
  const second = tokens[firstCommandIndex + 1];
  if (pathBasename(first) === "codex") {
    return true;
  }

  return pathBasename(first) === "node" && pathBasename(second) === "codex";
}

function commandInvokesCodexAppServer(command: string): boolean {
  const tokens = command.split(/\s+/).filter(Boolean);
  const codexIndex = tokens.findIndex((token) => pathBasename(token) === "codex");
  return codexIndex >= 0 && tokens.slice(codexIndex + 1).includes("app-server");
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
