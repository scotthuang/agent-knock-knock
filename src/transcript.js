import fs from "node:fs";

export function readNdjsonLog(logPath) {
  const text = fs.readFileSync(logPath, "utf8");
  return parseNdjson(text);
}

export function parseNdjson(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid NDJSON at line ${index + 1}: ${error.message}`);
      }
    });
}

export function formatTranscript(events, { includeRaw = false } = {}) {
  const lines = [];

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

function formatConversationCreated(event) {
  const conversation = event.conversation;
  const id = event.conversation_id ?? conversation?.conversation_id ?? "unknown";
  const status = conversation?.status ? ` status=${conversation.status}` : "";
  const request = conversation?.user_request ? `\nRequest: ${conversation.user_request}` : "";
  return `[conversation_created] ${id}${status}${request}`;
}

function formatMessage(event) {
  const label = `${event.from} -> ${event.to}`;
  const flags = [
    `type=${event.type}`,
    `round=${event.round}`,
    `requires_response=${event.requires_response}`
  ].join(" ");

  return `[message] ${label} ${flags}\n${indent(event.body)}`;
}

function formatConversationClosed(event) {
  const parts = [
    `status=${event.status ?? "unknown"}`,
    `rounds=${event.response_rounds_used ?? "unknown"}`
  ];
  const final = event.manager_final ? `\n${indent(event.manager_final)}` : "";
  return `[conversation_closed] ${parts.join(" ")}${final}`;
}

function formatRawEvent(event) {
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

function isDebugEvent(event) {
  return event.event === "raw_exchange" ||
    event.event?.startsWith("developer_step_") ||
    event.event?.startsWith("manager_step_") ||
    event.event === "manager_final" ||
    event.source === "normalized_acpx";
}

function indent(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}
