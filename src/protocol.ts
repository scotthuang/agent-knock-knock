import { randomUUID } from "node:crypto";
import {
  ACTORS,
  CODING_AGENT_ACTORS,
  EXECUTORS,
  type Actor,
  type Executor,
  type ExecutorKind,
  resolveExecutor
} from "./executors.js";

export type MessageType = "task" | "question" | "answer" | "progress" | "blocked" | "done" | "error" | "control";
export type ConversationStatus = "created" | "running" | "waiting_for_agent" | "waiting_for_openclaw" | "idle" | "stalled" | "failed" | "closed" | "cancelled" | "cancelling";
export type BudgetLevel = "normal" | "converge" | "warning" | "soft_stop" | "hard_stop";
export type { Actor, Executor, ExecutorKind } from "./executors.js";
export { ACTORS, EXECUTORS, resolveExecutor } from "./executors.js";

export interface Conversation {
  conversation_id: string;
  user_request: string;
  openclaw_session: string;
  claude_session: string;
  executor: Executor;
  workspace: string;
  status: ConversationStatus;
  response_rounds_used: number;
  soft_limit: number;
  hard_limit: number;
  created_at: string;
  updated_at: string;
  idle_since?: string;
  closed_at?: string;
  close_reason?: string;
  cancel_requested_at?: string;
  gateway_url?: string;
  gateway_method?: string;
  gateway_session?: string;
  callback_command?: string;
  openclaw_bin?: string;
  gateway_token?: string;
  executor_all_proxy?: string;
  executor_model?: string;
  store_dir?: string;
  conversation_dir?: string;
  event_log_path?: string;
  state_path?: string;
  [key: string]: unknown;
}

export interface AgentMessage {
  id: string;
  ts: string;
  conversation_id: string;
  from: Actor;
  to: Actor;
  type: MessageType;
  requires_response: boolean;
  round: number;
  max_rounds: number;
  body: string;
  metadata: Record<string, unknown>;
}

export interface BudgetAction {
  level: BudgetLevel;
  message: string;
}

interface CreateConversationOptions {
  userRequest: string;
  workspace?: string;
  openclawSession?: string;
  claudeSession?: string;
  executorKind?: ExecutorKind | string;
  executorSession?: string;
  softLimit?: number;
  hardLimit?: number;
  now?: Date;
}

interface CreateMessageOptions {
  conversation: Conversation;
  from: Actor;
  to: Actor;
  type: MessageType;
  body: string;
  requiresResponse?: boolean | undefined;
  metadata?: Record<string, unknown>;
  now?: Date;
}

interface ExtractStructuredMessageOptions {
  conversation: Conversation;
  input: string;
  defaultFrom?: Actor;
  defaultTo?: Actor;
  now?: Date;
}

export const MESSAGE_TYPES = new Set<MessageType>([
  "task",
  "question",
  "answer",
  "progress",
  "blocked",
  "done",
  "error",
  "control"
]);

export const DEFAULT_REQUIRES_RESPONSE: Record<MessageType, boolean> = {
  task: true,
  question: true,
  answer: true,
  progress: false,
  blocked: true,
  done: false,
  error: false,
  control: false
};

export const ALLOWED_MESSAGE_TYPES_BY_ROUTE: Record<string, Set<MessageType>> = Object.fromEntries(
  CODING_AGENT_ACTORS.flatMap((actor) => [
    [`openclaw->${actor}`, new Set<MessageType>(["task", "answer", "control", "error"])],
    [`${actor}->openclaw`, new Set<MessageType>(["question", "progress", "blocked", "done", "error"])]
  ])
);

export function createConversation({
  userRequest,
  workspace = process.cwd(),
  openclawSession = "agent:main:main",
  claudeSession = "bidirectional",
  executorKind = "claude",
  executorSession,
  softLimit = 50,
  hardLimit = 100,
  now = new Date()
}: CreateConversationOptions): Conversation {
  const conversationId = `task-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const executor = resolveExecutor({ kind: executorKind, session: executorSession ?? claudeSession });

  return {
    conversation_id: conversationId,
    user_request: userRequest,
    openclaw_session: openclawSession,
    claude_session: executor.kind === "claude" ? executor.session : claudeSession,
    executor,
    workspace,
    status: "created",
    response_rounds_used: 0,
    soft_limit: Number(softLimit),
    hard_limit: Number(hardLimit),
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
}

export function executorForConversation(conversation: Partial<Conversation> | null | undefined): Executor {
  if (conversation?.executor) {
    return resolveExecutor(conversation.executor);
  }

  return resolveExecutor({
    kind: "claude",
    session: conversation?.claude_session
  });
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
}: CreateMessageOptions): AgentMessage {
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

export function validateMessage(message: unknown): message is AgentMessage {
  if (!isRecord(message)) {
    throw new Error("message must be an object");
  }

  const required = ["id", "conversation_id", "from", "to", "type", "requires_response", "round", "body"];
  for (const key of required) {
    if (!(key in message)) {
      throw new Error(`message.${key} is required`);
    }
  }

  if (!isActor(message.from)) {
    throw new Error(`invalid sender: ${message.from}`);
  }

  if (!isActor(message.to)) {
    throw new Error(`invalid receiver: ${message.to}`);
  }

  if (message.from === message.to) {
    throw new Error("sender and receiver must differ");
  }

  if (!isMessageType(message.type)) {
    throw new Error(`invalid message type: ${message.type}`);
  }

  if (typeof message.requires_response !== "boolean") {
    throw new Error("message.requires_response must be a boolean");
  }

  if (!Number.isInteger(message.round) || typeof message.round !== "number" || message.round < 0) {
    throw new Error("message.round must be a non-negative integer");
  }

  if (typeof message.body !== "string" || message.body.length === 0) {
    throw new Error("message.body must be a non-empty string");
  }

  return true;
}

export function validateMessageForConversation(conversation: Conversation, message: AgentMessage): true {
  if (!conversation?.conversation_id) {
    throw new Error("conversation is required");
  }

  validateMessage(message);

  if (message.conversation_id !== conversation.conversation_id) {
    throw new Error(`message.conversation_id ${message.conversation_id} does not match conversation ${conversation.conversation_id}`);
  }

  const route = `${message.from}->${message.to}`;
  const allowedTypes = ALLOWED_MESSAGE_TYPES_BY_ROUTE[route];
  if (!allowedTypes) {
    throw new Error(`invalid message route: ${route}`);
  }

  if (!allowedTypes.has(message.type)) {
    throw new Error(`message type ${message.type} is not allowed for route ${route}`);
  }

  return true;
}

export function applyMessageToConversation(conversation: Conversation, message: AgentMessage, now = new Date()): Conversation {
  validateMessageForConversation(conversation, message);

  const next = {
    ...conversation,
    updated_at: now.toISOString()
  };

  if (message.requires_response) {
    next.response_rounds_used = Math.max(next.response_rounds_used + 1, message.round);
  }

  if (message.type === "done") {
    next.status = "idle";
    next.idle_since = now.toISOString();
  } else if (message.type === "error") {
    next.status = "failed";
    delete next.idle_since;
  } else if (message.type === "blocked") {
    next.status = "waiting_for_openclaw";
    delete next.idle_since;
  } else if (message.to === "openclaw" && message.requires_response) {
    next.status = "waiting_for_openclaw";
    delete next.idle_since;
  } else if (message.to !== "openclaw" && message.requires_response) {
    next.status = "waiting_for_agent";
    delete next.idle_since;
  } else if (next.status === "created") {
    next.status = "running";
    delete next.idle_since;
  }

  return next;
}

export function budgetAction(conversation: Conversation): BudgetAction {
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

export function parseMessageJson(input: string): AgentMessage {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`invalid JSON message: ${error instanceof Error ? error.message : String(error)}`);
  }

  validateMessage(parsed);
  return parsed;
}

export function extractStructuredMessage({
  conversation,
  input,
  defaultFrom = "claude-code",
  defaultTo = "openclaw",
  now = new Date()
}: ExtractStructuredMessageOptions): AgentMessage {
  const parsed = extractJsonObject(input);

  const from = isActor(parsed.from) ? parsed.from : defaultFrom;
  const to = isActor(parsed.to) ? parsed.to : defaultTo;
  const type = requiredMessageType(parsed.type);
  const body = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body);

  const createOptions: CreateMessageOptions = {
    conversation,
    from,
    to,
    type,
    body,
    metadata: isRecord(parsed.metadata) ? parsed.metadata : {},
    now
  };
  if (typeof parsed.requires_response === "boolean") {
    createOptions.requiresResponse = parsed.requires_response;
  }
  return createMessage(createOptions);
}

export function extractJsonObject(input: string): Record<string, unknown> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("structured message input must be a non-empty string");
  }

  const candidates = [
    input.trim(),
    ...jsonFenceCandidates(input),
    ...balancedObjectCandidates(input)
  ];

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      errors.push("candidate is not a JSON object");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`no structured JSON message found: ${errors[0] ?? "no candidates"}`);
}

function nextRound(conversation: Conversation, requiresResponse: boolean): number {
  if (!requiresResponse) {
    return conversation.response_rounds_used;
  }

  return conversation.response_rounds_used + 1;
}

function formatTimestamp(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}${second}`;
}

function jsonFenceCandidates(input: string): string[] {
  const matches = input.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  return Array.from(matches, (match) => match[1]?.trim() ?? "").filter(Boolean);
}

function balancedObjectCandidates(input: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (depth === 0) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
    } else if (char === "\\" && inString) {
      escaped = true;
    } else if (char === "\"") {
      inString = !inString;
    } else if (!inString && char === "{") {
      depth += 1;
    } else if (!inString && char === "}") {
      depth -= 1;
      if (depth === 0) {
        candidates.push(input.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function isActor(value: unknown): value is Actor {
  return typeof value === "string" && ACTORS.has(value as Actor);
}

function isMessageType(value: unknown): value is MessageType {
  return typeof value === "string" && MESSAGE_TYPES.has(value as MessageType);
}

function requiredMessageType(value: unknown): MessageType {
  if (!isMessageType(value)) {
    throw new Error(`invalid message type: ${String(value)}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
