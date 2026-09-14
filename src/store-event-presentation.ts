import {
  validateMessage,
  type AgentMessage
} from "./protocol.js";

export interface EventRecord {
  event: string;
  [key: string]: unknown;
}

/** Build the durable audit-event projection for one validated Agent message. */
export function messageEvent(message: AgentMessage): EventRecord {
  validateMessage(message);
  return {
    ts: message.ts,
    conversation_id: message.conversation_id,
    session_id: message.session_id ?? message.conversation_id,
    turn_id: message.turn_id ?? message.conversation_id,
    event: "message",
    from: message.from,
    to: message.to,
    type: message.type,
    requires_response: message.requires_response,
    round: message.round,
    body: message.body,
    message
  };
}

/** Build the legacy raw-exchange audit projection without owning persistence. */
export function rawExchangeEvent({
  conversationId,
  from,
  to,
  prompt,
  response,
  round,
  type = "raw_exchange"
}: {
  conversationId: string;
  from: string;
  to: string;
  prompt: string;
  response: string;
  round: number;
  type?: string;
}): EventRecord {
  return {
    ts: new Date().toISOString(),
    conversation_id: conversationId,
    event: type,
    from,
    to,
    round,
    prompt,
    response
  };
}
