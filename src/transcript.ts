import fs from "node:fs";

export interface TranscriptEvent {
  event?: string;
  conversation?: Record<string, unknown>;
  conversation_id?: string;
  from?: string;
  to?: string;
  type?: string;
  round?: number;
  requires_response?: boolean;
  body?: string;
  status?: string;
  response_rounds_used?: number;
  manager_final?: string;
  response?: string;
  tool_name?: string;
  permission?: string;
  source?: string;
  [key: string]: unknown;
}

export function readNdjsonLog(logPath: string): TranscriptEvent[] {
  const text = fs.readFileSync(logPath, "utf8");
  return parseNdjson(text);
}

export function parseNdjson(text: string): TranscriptEvent[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid NDJSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export function formatTranscript(events: TranscriptEvent[], { includeRaw = false }: { includeRaw?: boolean } = {}): string {
  const lines: string[] = [];

  for (const event of events) {
    if (event.event === "conversation_created") {
      lines.push(formatConversationCreated(event));
    } else if (event.event === "message" && event.source !== "normalized_acpx") {
      lines.push(formatMessage(event));
    } else if (event.event === "conversation_closed") {
      lines.push(formatConversationClosed(event));
    } else if (includeRaw && isDebugEvent(event)) {
      lines.push(formatRawEvent(event));
    }
  }

  return `${lines.filter(Boolean).join("\n\n")}\n`;
}

function formatConversationCreated(event: TranscriptEvent): string {
  const conversation = event.conversation;
  const id = event.conversation_id ?? conversation?.conversation_id ?? "unknown";
  const status = typeof conversation?.status === "string" ? ` status=${conversation.status}` : "";
  const request = typeof conversation?.user_request === "string" ? `\nRequest: ${conversation.user_request}` : "";
  return `[conversation_created] ${id}${status}${request}`;
}

function formatMessage(event: TranscriptEvent): string {
  const label = `${event.from} -> ${event.to}`;
  const flags = [
    `type=${event.type}`,
    `round=${event.round}`,
    `requires_response=${event.requires_response}`
  ].join(" ");

  return `[message] ${label} ${flags}\n${indent(event.body)}`;
}

function formatConversationClosed(event: TranscriptEvent): string {
  const parts = [
    `status=${event.status ?? "unknown"}`,
    `rounds=${event.response_rounds_used ?? "unknown"}`
  ];
  const final = event.manager_final ? `\n${indent(event.manager_final)}` : "";
  return `[conversation_closed] ${parts.join(" ")}${final}`;
}

function formatRawEvent(event: TranscriptEvent): string {
  const label = `${event.from ?? "unknown"} -> ${event.to ?? "unknown"}`;
  const details = [
    event.type ? `type=${event.type}` : null,
    event.status ? `status=${event.status}` : null,
    event.tool_name ? `tool=${event.tool_name}` : null,
    event.permission ? `permission=${event.permission}` : null
  ].filter(Boolean);
  const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
  const body = event.response ?? event.body;
  const formattedBody = body ? `\n${indent(body)}` : "";
  return `[${event.event}] ${label} round=${event.round ?? "unknown"}${suffix}${formattedBody}`;
}

function isDebugEvent(event: TranscriptEvent): boolean {
  return event.event === "raw_exchange" ||
    event.event?.startsWith("developer_step_") ||
    event.event?.startsWith("manager_step_") ||
    event.event === "manager_final" ||
    event.source === "normalized_acpx";
}

function indent(value: unknown): string {
  return String(value)
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}
