import { extractJsonObject } from "./protocol.js";

export function normalizeAcpxOutput({
  conversationId,
  from,
  to,
  round,
  output,
  now = new Date()
}) {
  const events = [];
  const lines = String(output ?? "").split(/\r?\n/);

  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      continue;
    }

    const jsonEvent = normalizeJsonLine({ conversationId, from, to, round, text, now });
    if (jsonEvent) {
      events.push(jsonEvent);
      continue;
    }

    const textEvent = normalizeTextLine({ conversationId, from, to, round, text, now });
    if (textEvent) {
      events.push(textEvent);
    }
  }

  return events;
}

function normalizeJsonLine({ conversationId, from, to, round, text, now }) {
  let parsed;
  try {
    parsed = extractJsonObject(text);
  } catch {
    return null;
  }

  if (parsed.type && parsed.from && parsed.to && "body" in parsed) {
    return baseEvent({
      event: "message",
      conversationId,
      from: parsed.from,
      to: parsed.to,
      round,
      now,
      type: parsed.type,
      requires_response: parsed.requires_response,
      body: typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body),
      source: "normalized_acpx",
      raw: parsed
    });
  }

  const eventName = eventNameFromJson(parsed);
  if (!eventName) {
    return null;
  }

  return baseEvent({
    event: eventName,
    conversationId,
    from: parsed.from ?? from,
    to: parsed.to ?? to,
    round: parsed.round ?? round,
    now,
    status: parsed.status,
    tool_name: parsed.tool_name ?? parsed.tool ?? parsed.name,
    permission: parsed.permission ?? parsed.permission_name,
    body: parsed.body ?? parsed.message ?? parsed.text,
    source: "normalized_acpx",
    raw: parsed
  });
}

function normalizeTextLine({ conversationId, from, to, round, text, now }) {
  const lower = text.toLowerCase();

  if (isPermissionRequest(lower)) {
    return baseEvent({
      event: "permission_request",
      conversationId,
      from,
      to,
      round,
      now,
      source: "normalized_acpx",
      body: text
    });
  }

  const toolStarted = matchToolStarted(text);
  if (toolStarted) {
    return baseEvent({
      event: "tool_call_started",
      conversationId,
      from,
      to,
      round,
      now,
      tool_name: toolStarted,
      source: "normalized_acpx",
      body: text
    });
  }

  const toolFinished = matchToolFinished(text);
  if (toolFinished) {
    return baseEvent({
      event: "tool_call_finished",
      conversationId,
      from,
      to,
      round,
      now,
      tool_name: toolFinished,
      source: "normalized_acpx",
      body: text
    });
  }

  if (isAgentStatus(lower)) {
    return baseEvent({
      event: "agent_status",
      conversationId,
      from,
      to,
      round,
      now,
      status: statusFromText(lower),
      source: "normalized_acpx",
      body: text
    });
  }

  return null;
}

function eventNameFromJson(parsed) {
  const value = String(parsed.event ?? parsed.kind ?? "").toLowerCase();
  if (["tool_call_started", "tool_call_finished", "permission_request", "agent_status"].includes(value)) {
    return value;
  }

  if (value === "tool_call" && parsed.status === "started") {
    return "tool_call_started";
  }

  if (value === "tool_call" && ["finished", "completed", "done"].includes(parsed.status)) {
    return "tool_call_finished";
  }

  return null;
}

function isPermissionRequest(lower) {
  return lower.includes("permission") && (
    lower.includes("request") ||
    lower.includes("requires") ||
    lower.includes("approve") ||
    lower.includes("allow")
  );
}

function matchToolStarted(text) {
  const patterns = [
    /tool(?: call)? (?:started|starting):?\s*([A-Za-z0-9_.:-]+)/i,
    /(?:running|started|starting) tool:?\s*([A-Za-z0-9_.:-]+)/i,
    /tool_use(?:\.start)?:?\s*([A-Za-z0-9_.:-]+)/i
  ];
  return firstMatch(text, patterns);
}

function matchToolFinished(text) {
  const patterns = [
    /tool(?: call)? (?:finished|completed|succeeded|failed):?\s*([A-Za-z0-9_.:-]+)/i,
    /(?:finished|completed|succeeded|failed) tool:?\s*([A-Za-z0-9_.:-]+)/i,
    /tool_use(?:\.finish|\.end)?:?\s*([A-Za-z0-9_.:-]+)/i
  ];
  return firstMatch(text, patterns);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function isAgentStatus(lower) {
  return lower.includes("session") ||
    lower.includes("agent") ||
    lower.includes("thinking") ||
    lower.includes("queued") ||
    lower.includes("running") ||
    lower.includes("completed") ||
    lower.includes("failed") ||
    lower.includes("timed out") ||
    lower.includes("timeout");
}

function statusFromText(lower) {
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "timeout";
  }
  if (lower.includes("failed") || lower.includes("error")) {
    return "failed";
  }
  if (lower.includes("completed") || lower.includes("done") || lower.includes("finished")) {
    return "completed";
  }
  if (lower.includes("queued")) {
    return "queued";
  }
  if (lower.includes("thinking")) {
    return "thinking";
  }
  if (lower.includes("running")) {
    return "running";
  }
  return "status";
}

function baseEvent({
  event,
  conversationId,
  from,
  to,
  round,
  now,
  ...rest
}) {
  return {
    ts: now.toISOString(),
    conversation_id: conversationId,
    event,
    from,
    to,
    round,
    ...dropUndefined(rest)
  };
}

function dropUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}
