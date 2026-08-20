import { randomUUID } from "node:crypto";
import {
  ACTORS,
  CODING_AGENT_ACTORS,
  type Actor,
  type Executor,
  type ExecutorKind,
  resolveExecutor
} from "./executors.js";
import { isRecord } from "./value-guards.js";

export type MessageType = "task" | "question" | "answer" | "progress" | "blocked" | "done" | "error" | "control";
/**
 * `callback_pending` and `callback_failed` are retained only so Stores written
 * by earlier releases can still be read. New writes keep callback transport state in
 * `conversation.callback_delivery` and use a TurnPhaseStatus here.
 */
export type ConversationStatus = "created" | "running" | "waiting_for_agent" | "waiting_for_openclaw" | "idle" | "stalled" | "callback_pending" | "callback_failed" | "failed" | "closed" | "cancelled" | "cancelling";
export type TurnPhaseStatus = Exclude<ConversationStatus, "callback_pending" | "callback_failed">;
export type BudgetLevel = "normal" | "converge" | "warning" | "soft_stop" | "hard_stop";
export type { Actor, Executor, ExecutorKind } from "./executors.js";
export { ACTORS, EXECUTORS, resolveExecutor } from "./executors.js";

export interface Conversation {
  /** Authoritative identity for the continuing managed agent context. */
  session_id: string;
  /** Authoritative identity for this accepted dispatch lifecycle. */
  turn_id: string;
  /** Immutable terminal binding that authorized this Turn. */
  terminal_binding_id?: string;
  /** Session-local binding epoch that fences stale asynchronous work. */
  terminal_binding_generation?: number;
  /** Exact native Codex/Claude thread observed when this Turn was created. */
  native_thread_id?: string;
  /** Legacy Store/path alias. New records keep this equal to turn_id. */
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
  openclaw_bin?: string;
  gateway_token?: string;
  store_dir?: string;
  conversation_dir?: string;
  event_log_path?: string;
  state_path?: string;
  [key: string]: unknown;
}

const TURN_PHASE_STATUSES = new Set<TurnPhaseStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "idle",
  "stalled",
  "failed",
  "closed",
  "cancelled",
  "cancelling"
]);

const LEGACY_CALLBACK_STATUSES = new Set<ConversationStatus>([
  "callback_pending",
  "callback_failed"
]);

const FINAL_CONVERSATION_STATUSES = new Set<string>([
  "done",
  "failed",
  "closed",
  "cancelled"
]);

const WAITING_FOR_AGENT_STATUSES = new Set<ConversationStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "cancelling"
]);

const TERMINAL_BRIDGE_CALLBACK_SUPERSEDE_STATUSES = new Set<ConversationStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "stalled",
  "cancelling"
]);

const TERMINAL_DISPATCH_OWNER_RELEASED_STATUSES = new Set<ConversationStatus>([
  "idle",
  "failed",
  "closed",
  "cancelled"
]);

const SESSION_SEND_BLOCKING_STATUSES = new Set<ConversationStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "stalled",
  // Valid legacy records are normalized at the Store read boundary. Retaining
  // them here makes malformed legacy records fail closed.
  "callback_pending",
  "callback_failed",
  "cancelling"
]);

export function isActiveConversationStatus(status: unknown): boolean {
  return typeof status !== "string" ||
    !FINAL_CONVERSATION_STATUSES.has(status);
}

export function isWaitingForAgentStatus(status: unknown): boolean {
  return typeof status === "string" &&
    WAITING_FOR_AGENT_STATUSES.has(status as ConversationStatus);
}

export function isTerminalBridgeCallbackSupersedeStatus(
  status: unknown
): boolean {
  return typeof status === "string" &&
    TERMINAL_BRIDGE_CALLBACK_SUPERSEDE_STATUSES.has(
      status as ConversationStatus
    );
}

export function isTerminalDispatchOwnerReleasedStatus(status: unknown): boolean {
  return typeof status === "string" &&
    TERMINAL_DISPATCH_OWNER_RELEASED_STATUSES.has(status as ConversationStatus);
}

export function isSessionSendBlockingStatus(status: unknown): boolean {
  return typeof status === "string" &&
    SESSION_SEND_BLOCKING_STATUSES.has(status as ConversationStatus);
}

/**
 * Resolve the semantic Turn phase for both current and legacy callback state.
 * Invalid legacy records fail closed instead of guessing that a Turn is idle.
 */
export function effectiveTurnStatus(
  conversation: Partial<Conversation> | null | undefined
): TurnPhaseStatus {
  const status = conversation?.status;
  if (isTurnPhaseStatus(status)) {
    return status;
  }
  if (!status || !LEGACY_CALLBACK_STATUSES.has(status)) {
    throw new Error(`invalid conversation status: ${String(status)}`);
  }

  const delivery = isRecord(conversation?.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const message = isRecord(delivery?.message) ? delivery.message : undefined;
  const expectedDeliveryStatus = status === "callback_pending"
    ? "pending"
    : "failed";
  const finalStatus = delivery?.final_status;
  if (
    !delivery ||
    !message ||
    delivery.status !== expectedDeliveryStatus ||
    !isTurnPhaseStatus(finalStatus)
  ) {
    throw new Error(
      `legacy ${status} conversation is missing a valid ` +
      "callback_delivery.final_status Turn phase, message, or matching transport status"
    );
  }
  if (
    delivery?.close_terminal_bridge_on_done === true &&
    message?.type === "done"
  ) {
    return "closed";
  }
  return finalStatus;
}

/** Materialize a legacy callback-owned status as an ordinary Turn phase. */
export function normalizeLegacyCallbackStatus(
  conversation: Conversation
): Conversation {
  if (!LEGACY_CALLBACK_STATUSES.has(conversation.status)) {
    return conversation;
  }
  const status = effectiveTurnStatus(conversation);
  if (status === conversation.status) {
    return conversation;
  }

  const delivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const transitionAt = nonEmptyString(delivery?.created_at) ??
    nonEmptyString(delivery?.last_attempt_at) ??
    conversation.updated_at;
  const next: Conversation = {
    ...conversation,
    status
  };
  if (status === "idle") {
    next.idle_since = conversation.idle_since ?? transitionAt;
    delete next.closed_at;
    delete next.close_reason;
  } else {
    delete next.idle_since;
  }
  if (status === "closed") {
    next.closed_at = conversation.closed_at ?? transitionAt;
    next.close_reason = conversation.close_reason ??
      "terminal bridge task completed";
  }
  return next;
}

export function isTurnPhaseStatus(value: unknown): value is TurnPhaseStatus {
  return typeof value === "string" &&
    TURN_PHASE_STATUSES.has(value as TurnPhaseStatus);
}

export interface AgentMessage {
  id: string;
  ts: string;
  conversation_id: string;
  /** Authoritative session identity. Optional only when reading legacy messages. */
  session_id?: string;
  /** Exact dispatch identity. Optional only when reading legacy messages. */
  turn_id?: string;
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
  sessionId?: string;
  turnId?: string;
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
  /** Stable internal id used when a persisted callback outbox is reconstructed. */
  id?: string;
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
  sessionId,
  turnId,
  workspace = process.cwd(),
  openclawSession = "agent:main:main",
  claudeSession = "claude",
  executorKind = "claude",
  executorSession,
  softLimit = 50,
  hardLimit = 100,
  now = new Date()
}: CreateConversationOptions): Conversation {
  const resolvedSessionId = sessionId ??
    `session-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const resolvedTurnId = turnId ??
    `turn-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  if (!nonEmptyString(resolvedSessionId)) {
    throw new Error("session_id must be a non-empty string");
  }
  if (!nonEmptyString(resolvedTurnId)) {
    throw new Error("turn_id must be a non-empty string");
  }
  const executor = resolveExecutor({ kind: executorKind, session: executorSession ?? claudeSession });

  return {
    session_id: resolvedSessionId,
    turn_id: resolvedTurnId,
    conversation_id: resolvedTurnId,
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

/**
 * Return the authoritative managed-session identity, falling back to the
 * historical Store alias for records written before session_id existed.
 */
export function sessionIdForConversation(
  conversation: Partial<Conversation> | null | undefined
): string {
  assertConversationIdentityShape(conversation);
  const sessionId = nonEmptyString(conversation?.session_id) ??
    nonEmptyString(conversation?.conversation_id);
  if (!sessionId) {
    throw new Error("conversation session_id is required");
  }
  return sessionId;
}

/**
 * Return the authoritative dispatch identity, falling back to the historical
 * Store alias for records written before turn_id existed.
 */
export function turnIdForConversation(
  conversation: Partial<Conversation> | null | undefined
): string {
  assertConversationIdentityShape(conversation);
  const turnId = nonEmptyString(conversation?.turn_id) ??
    nonEmptyString(conversation?.conversation_id);
  if (!turnId) {
    throw new Error("conversation turn_id is required");
  }
  return turnId;
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
  id,
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

  const sessionId = sessionIdForConversation(conversation);
  const turnId = turnIdForConversation(conversation);

  const resolvedRequiresResponse =
    typeof requiresResponse === "boolean"
      ? requiresResponse
      : DEFAULT_REQUIRES_RESPONSE[type];

  const message = {
    id: id ?? `msg-${randomUUID()}`,
    ts: now.toISOString(),
    conversation_id: conversation.conversation_id,
    session_id: sessionId,
    turn_id: turnId,
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
      ...metadata,
      session_id: sessionId,
      turn_id: turnId
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

  const hasSessionId = Object.hasOwn(message, "session_id");
  const hasTurnId = Object.hasOwn(message, "turn_id");
  if (hasSessionId !== hasTurnId) {
    throw new Error(
      "message.session_id and message.turn_id must either both be present or both be absent"
    );
  }

  if (hasSessionId && !nonEmptyString(message.session_id)) {
    throw new Error("message.session_id must be a non-empty string");
  }

  if (hasTurnId && !nonEmptyString(message.turn_id)) {
    throw new Error("message.turn_id must be a non-empty string");
  }

  if (
    hasTurnId &&
    nonEmptyString(message.turn_id) !== nonEmptyString(message.conversation_id)
  ) {
    throw new Error(
      "message.conversation_id must equal message.turn_id for modern messages"
    );
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

  const sessionId = sessionIdForConversation(conversation);
  if (message.session_id !== undefined && message.session_id !== sessionId) {
    throw new Error(
      `message.session_id ${message.session_id} does not match session ${sessionId}`
    );
  }

  const turnId = turnIdForConversation(conversation);
  if (message.turn_id !== undefined && message.turn_id !== turnId) {
    throw new Error(
      `message.turn_id ${message.turn_id} does not match turn ${turnId}`
    );
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

function assertConversationIdentityShape(
  conversation: Partial<Conversation> | null | undefined
): void {
  const hasSessionId = Boolean(
    conversation && Object.hasOwn(conversation, "session_id")
  );
  const hasTurnId = Boolean(
    conversation && Object.hasOwn(conversation, "turn_id")
  );
  if (hasSessionId !== hasTurnId) {
    throw new Error(
      "conversation session_id and turn_id must either both be present or both be absent"
    );
  }
  if (!hasSessionId) {
    return;
  }
  if (!nonEmptyString(conversation?.session_id)) {
    throw new Error("conversation session_id must be a non-empty string");
  }
  const turnId = nonEmptyString(conversation?.turn_id);
  if (!turnId) {
    throw new Error("conversation turn_id must be a non-empty string");
  }
  if (turnId !== nonEmptyString(conversation?.conversation_id)) {
    throw new Error(
      "conversation.conversation_id must equal turn_id for modern records"
    );
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
