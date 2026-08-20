// Data-only projections shared by status, list, and terminal command facades.
import type {
  ActiveCodexProcess,
  ForkContextPackage
} from "./codex-session-provider.js";
import {
  isExecutorKind
} from "./executors.js";
import {
  executorForConversation,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import type {
  TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import type {
  TerminalControlRef
} from "./terminal-agent-adapter.js";
import type { TranscriptEvent } from "./transcript.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

export interface TerminalStatusJsonObject {
  [key: string]: unknown;
}

export interface CodexTerminalContext extends TerminalStatusJsonObject {
  confidence: "high" | "medium" | "low" | "screen_only";
  about: string;
  limitations: string[];
}

export interface TerminalStatusSummaryPorts {
  callbackRetryDisposition(delivery: unknown): { state: string } | undefined;
  textSummary(value: unknown): unknown;
}

interface CodexHistoryCandidate extends TerminalStatusJsonObject {
  session_id: string;
  cwd: string;
  title?: string;
  updated_at_ms?: number;
  capability: string;
}

export function summarizeConversation(
  conversation: Conversation,
  ports: TerminalStatusSummaryPorts
): TerminalStatusJsonObject {
  const executor = executorForConversation(conversation);
  const callbackDelivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const callbackDisposition = callbackDelivery
    ? ports.callbackRetryDisposition(callbackDelivery)
    : undefined;
  return {
    session_id: sessionIdForConversation(conversation),
    turn_id: turnIdForConversation(conversation),
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor,
    session: executor.session,
    status: conversation.status,
    request: conversation.user_request,
    workspace: conversation.workspace,
    openclaw_session: conversation.openclaw_session,
    response_rounds_used: conversation.response_rounds_used,
    soft_limit: conversation.soft_limit,
    hard_limit: conversation.hard_limit,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    idle_since: conversation.idle_since,
    closed_at: conversation.closed_at,
    ...(callbackDelivery
      ? {
          callback_delivery: {
            status: callbackDelivery.status,
            attempts: callbackDelivery.attempts,
            attempt_state: callbackDisposition?.state,
            attempt_pid: callbackDelivery.attempt_pid,
            lease_expires_at: callbackDelivery.attempt_lease_expires_at,
            next_attempt_at: callbackDelivery.next_attempt_at,
            last_error: callbackDelivery.last_error === undefined
              ? undefined
              : ports.textSummary(String(callbackDelivery.last_error))
          }
        }
      : {}),
    state_path: conversation.state_path,
    event_log_path: conversation.event_log_path
  };
}

export function isDiscoverableTmuxConversation(
  conversation: Conversation
): boolean {
  if (!isRecord(conversation) || !isRecord(conversation.executor)) {
    return false;
  }
  const kind = stringValue(conversation.executor.kind)?.toLowerCase();
  return kind !== undefined &&
    isExecutorKind(kind) &&
    conversation.executor.transport === "tmux";
}

export function persistedExecutorLogFields(conversation: Conversation): {
  agent: string;
  executor_session?: string;
} {
  if (isDiscoverableTmuxConversation(conversation)) {
    const executor = executorForConversation(conversation);
    return {
      agent: executor.kind,
      executor_session: executor.session
    };
  }
  const rawExecutor: { kind?: unknown; session?: unknown } =
    isRecord(conversation?.executor) ? conversation.executor : {};
  return {
    agent: stringValue(rawExecutor.kind) ?? "unsupported",
    executor_session: stringValue(rawExecutor.session)
  };
}

export function summarizeEvent(event: TranscriptEvent): TerminalStatusJsonObject {
  return {
    ts: event.ts,
    event: event.event,
    from: event.from,
    to: event.to,
    type: event.type,
    status: event.status,
    round: event.round,
    body: typeof event.body === "string" ? event.body.slice(0, 500) : undefined
  };
}

export function codexTerminalContextFromHistory(input: {
  id: string;
  confidence: "high" | "medium" | "low";
  match: string;
  process?: ActiveCodexProcess;
  context: ForkContextPackage;
  terminalControl?: TerminalControlRef;
  terminalStatus?: TerminalBridgeStatus;
  limitations: string[];
  candidates?: CodexHistoryCandidate[];
}): CodexTerminalContext {
  const {
    id, confidence, match, process, context, terminalControl, terminalStatus,
    limitations, candidates
  } = input;
  return {
    conversation_id: id,
    source: "terminal_control",
    confidence,
    match,
    about: rolloutAbout(context, terminalStatus),
    codex_session: context.source,
    evidence: {
      process,
      terminal_control: terminalControl,
      terminal_status: terminalStatus,
      initial_request: bestSessionIntent(context),
      title: context.source.title,
      recent_messages: visibleRolloutMessages(context).slice(-8),
      recent_commands: context.commands.slice(-8),
      candidates
    },
    limitations
  };
}

export function managedConversationAbout(
  conversation: Conversation,
  events: TranscriptEvent[],
  terminalStatus?: TerminalBridgeStatus
): string {
  const request = truncateText(String(conversation.user_request ?? "").trim(), 220);
  const recent = recentMessageEvidence(events).at(-1)?.body;
  const parts = [
    request ? `Initial request: ${request}` : undefined,
    recent ? `Latest visible message: ${truncateText(recent, 180)}` : undefined,
    terminalStatus?.activity_state
      ? `Current terminal state: ${terminalStatus.activity_state}.`
      : undefined
  ].filter(Boolean);
  return parts.length > 0
    ? parts.join(" ")
    : "No durable task content is available for this AKK-managed session.";
}

export function rolloutAbout(
  context: ForkContextPackage,
  terminalStatus?: TerminalBridgeStatus
): string {
  const title = truncateText(String(context.source.title ?? "").trim(), 180);
  const intent = bestSessionIntent(context);
  const latestAssistant = [...visibleRolloutMessages(context)].reverse()
    .find((message) => message.role === "assistant")?.text;
  const latestCommand = context.commands.at(-1)?.command;
  const parts = [
    intent
      ? `Initial request: ${truncateText(intent, 220)}`
      : title ? `Codex title: ${title}` : undefined,
    latestAssistant
      ? `Latest visible progress: ${truncateText(latestAssistant, 180)}`
      : undefined,
    latestCommand
      ? `Recent command: ${truncateText(latestCommand, 140)}`
      : undefined,
    terminalStatus?.activity_state
      ? `Current terminal state: ${terminalStatus.activity_state}.`
      : undefined
  ].filter(Boolean);
  return parts.length > 0
    ? parts.join(" ")
    : "Codex history was found, but it did not include enough visible message content to summarize the session.";
}

export function screenOnlyAbout(input: {
  process?: ActiveCodexProcess;
  terminalStatus?: TerminalBridgeStatus;
}): string {
  const { process, terminalStatus } = input;
  const activity = terminalStatus?.activity_reason ?? terminalStatus?.activity_state;
  const excerpt = terminalStatus?.screen?.excerpt;
  const parts = [
    process?.cwd ? `This Codex process is running in ${process.cwd}.` : undefined,
    activity ? `Terminal activity: ${truncateText(String(activity), 180)}` : undefined,
    excerpt ? `Visible screen: ${truncateText(String(excerpt), 220)}` : undefined
  ].filter(Boolean);
  return parts.length > 0
    ? parts.join(" ")
    : "Only active process metadata is available; no Codex conversation history or terminal screen content could be read.";
}

export function bestSessionIntent(
  context: ForkContextPackage
): string | undefined {
  const firstUser = visibleRolloutMessages(context)
    .find((message) => message.role === "user")?.text;
  if (firstUser) {
    return firstUser;
  }
  const title = cleanIntentText(context.source.title);
  if (title) {
    return title;
  }
  return undefined;
}

export function visibleRolloutMessages(context: ForkContextPackage) {
  return context.messages.filter((message) =>
    !isEnvironmentContextMessage(message.text));
}

export function cleanIntentText(value: string | undefined): string | undefined {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text && !isEnvironmentContextMessage(text) ? text : undefined;
}

export function isEnvironmentContextMessage(value: string | undefined): boolean {
  return /^\s*<environment_context[\s>]/u.test(String(value ?? ""));
}

function recentMessageEvidence(events: TranscriptEvent[]) {
  return events
    .filter((event) => event.event === "message" && typeof event.body === "string")
    .slice(-8)
    .map((event) => ({
      ts: event.ts,
      from: event.from,
      to: event.to,
      type: event.type,
      round: event.round,
      body: truncateText(event.body, 800)
    }));
}

export function truncateText(value: unknown, maxLength: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
