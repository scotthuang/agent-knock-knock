import { randomUUID } from "node:crypto";

export const ACTORS = new Set(["openclaw", "claude-code"]);

export const MESSAGE_TYPES = new Set([
  "task",
  "question",
  "answer",
  "progress",
  "blocked",
  "done",
  "error",
  "control"
]);

export const DEFAULT_REQUIRES_RESPONSE = {
  task: true,
  question: true,
  answer: true,
  progress: false,
  blocked: true,
  done: false,
  error: false,
  control: false
};

export function createConversation({
  userRequest,
  workspace = process.cwd(),
  openclawSession = "agent:main:main",
  claudeSession = "bidirectional",
  softLimit = 50,
  hardLimit = 100,
  now = new Date()
}) {
  const conversationId = `task-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;

  return {
    conversation_id: conversationId,
    user_request: userRequest,
    openclaw_session: openclawSession,
    claude_session: claudeSession,
    workspace,
    status: "created",
    response_rounds_used: 0,
    soft_limit: Number(softLimit),
    hard_limit: Number(hardLimit),
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
}

export function createMessage({
  conversation,
  from,
  to,
  type,
  body,
  requiresResponse,
  metadata = {},
  now = new Date()
}) {
  if (!conversation?.conversation_id) {
    throw new Error("conversation is required");
  }

  const resolvedRequiresResponse =
    typeof requiresResponse === "boolean"
      ? requiresResponse
      : DEFAULT_REQUIRES_RESPONSE[type];

  const message = {
    id: `msg-${randomUUID()}`,
    ts: now.toISOString(),
    conversation_id: conversation.conversation_id,
    from,
    to,
    type,
    requires_response: resolvedRequiresResponse,
    round: nextRound(conversation, resolvedRequiresResponse),
    max_rounds: conversation.soft_limit,
    body,
    metadata: {
      workspace: conversation.workspace,
      task_id: conversation.conversation_id,
      ...metadata
    }
  };

  validateMessage(message);
  return message;
}

export function validateMessage(message) {
  const required = ["id", "conversation_id", "from", "to", "type", "requires_response", "round", "body"];
  for (const key of required) {
    if (!(key in message)) {
      throw new Error(`message.${key} is required`);
    }
  }

  if (!ACTORS.has(message.from)) {
    throw new Error(`invalid sender: ${message.from}`);
  }

  if (!ACTORS.has(message.to)) {
    throw new Error(`invalid receiver: ${message.to}`);
  }

  if (message.from === message.to) {
    throw new Error("sender and receiver must differ");
  }

  if (!MESSAGE_TYPES.has(message.type)) {
    throw new Error(`invalid message type: ${message.type}`);
  }

  if (typeof message.requires_response !== "boolean") {
    throw new Error("message.requires_response must be a boolean");
  }

  if (!Number.isInteger(message.round) || message.round < 0) {
    throw new Error("message.round must be a non-negative integer");
  }

  if (typeof message.body !== "string" || message.body.length === 0) {
    throw new Error("message.body must be a non-empty string");
  }

  return true;
}

export function applyMessageToConversation(conversation, message, now = new Date()) {
  validateMessage(message);

  const next = {
    ...conversation,
    updated_at: now.toISOString()
  };

  if (message.requires_response) {
    next.response_rounds_used = Math.max(next.response_rounds_used + 1, message.round);
  }

  if (message.type === "done") {
    next.status = "done";
  } else if (message.type === "error") {
    next.status = "failed";
  } else if (message.type === "blocked") {
    next.status = "waiting_for_openclaw";
  } else if (message.to === "openclaw" && message.requires_response) {
    next.status = "waiting_for_openclaw";
  } else if (message.to === "claude-code" && message.requires_response) {
    next.status = "waiting_for_claude";
  } else if (next.status === "created") {
    next.status = "running";
  }

  return next;
}

export function budgetAction(conversation) {
  const used = conversation.response_rounds_used;
  const softLimit = conversation.soft_limit;
  const hardLimit = conversation.hard_limit;

  if (used >= hardLimit) {
    return {
      level: "hard_stop",
      message: "Hard response limit reached. End the conversation and summarize failure or final state."
    };
  }

  if (used >= softLimit) {
    return {
      level: "soft_stop",
      message: "Soft response limit reached. End by default unless OpenClaw explicitly extends the budget."
    };
  }

  if (used >= 40) {
    return {
      level: "warning",
      message: "Warn Claude Code to finish, degrade, or provide failure reason within 10 response rounds."
    };
  }

  if (used >= 30) {
    return {
      level: "converge",
      message: "Require Claude Code to converge, list remaining work, and choose the shortest completion path."
    };
  }

  return {
    level: "normal",
    message: "Continue normal managed collaboration."
  };
}

export function parseMessageJson(input) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`invalid JSON message: ${error.message}`);
  }

  validateMessage(parsed);
  return parsed;
}

function nextRound(conversation, requiresResponse) {
  if (!requiresResponse) {
    return conversation.response_rounds_used;
  }

  return conversation.response_rounds_used + 1;
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
