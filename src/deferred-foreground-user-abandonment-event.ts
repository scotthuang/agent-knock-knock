import { canonicalJson } from "./canonical-json.js";
import type { DeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import type { Conversation } from "./protocol.js";
import { appendEvent, type EventRecord } from "./store.js";
import { readNdjsonLog } from "./transcript.js";
import { isRecord } from "./value-guards.js";

export interface DeferredForegroundUserAbandonmentCloseEventPlan {
  disposition: "missing" | "exact";
  expected: EventRecord;
}

function expectedCloseEvent(input: {
  conversationId: string;
  transferId: string;
  requestedAt: string;
  closeReason: string;
}): EventRecord {
  return {
    ts: input.requestedAt,
    conversation_id: input.conversationId,
    event: "conversation_closed",
    status: "closed",
    reason: input.closeReason,
    disposition: "user_abandoned_management",
    transfer_id: input.transferId,
    terminal_input_sent: false,
    coding_agent_stopped: false,
    management_release_pending: true
  };
}

function closeEventDisposition(input: {
  logPath: string;
  expected: EventRecord;
}): "missing" | "exact" {
  let events: ReturnType<typeof readNdjsonLog> = [];
  try {
    events = readNdjsonLog(input.logPath);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  const existing = events.filter((event) =>
    event.event === input.expected.event &&
    event.conversation_id === input.expected.conversation_id &&
    event.transfer_id === input.expected.transfer_id
  );
  if (existing.length > 1) {
    throw new Error(
      `deferred foreground transfer ${input.expected.transfer_id} has ` +
      "duplicate user abandonment close events"
    );
  }
  if (
    existing.length === 1 &&
    canonicalJson(existing[0]) !== canonicalJson(input.expected)
  ) {
    throw new Error(
      `deferred foreground transfer ${input.expected.transfer_id} user ` +
      "abandonment close event conflicts with its durable intent"
    );
  }
  return existing.length === 1 ? "exact" : "missing";
}

export function preflightDeferredForegroundUserAbandonmentCloseEvent(input: {
  logPath: string;
  conversationId: string;
  transferId: string;
  requestedAt: string;
  closeReason: string;
}): DeferredForegroundUserAbandonmentCloseEventPlan {
  const expected = expectedCloseEvent(input);
  return {
    expected,
    disposition: closeEventDisposition({ logPath: input.logPath, expected })
  };
}

export function ensureDeferredForegroundUserAbandonmentCloseEvent(input: {
  logPath: string;
  conversation: Conversation;
  transfer: DeferredForegroundTransfer;
  plan?: DeferredForegroundUserAbandonmentCloseEventPlan;
  append?: (event: EventRecord) => void;
}): void {
  const requestedAt = input.transfer.user_abandonment_requested_at;
  const closeReason = input.transfer.user_abandonment_close_reason;
  if (!requestedAt || !closeReason) {
    throw new Error(
      `deferred foreground transfer ${input.transfer.transfer_id} lost its ` +
      "user abandonment close authority"
    );
  }
  const expected = expectedCloseEvent({
    conversationId: input.conversation.conversation_id,
    transferId: input.transfer.transfer_id,
    requestedAt,
    closeReason
  });
  if (
    input.plan && canonicalJson(input.plan.expected) !== canonicalJson(expected)
  ) {
    throw new Error(
      `deferred foreground transfer ${input.transfer.transfer_id} close ` +
      "event plan changed after preflight"
    );
  }
  if (closeEventDisposition({ logPath: input.logPath, expected }) === "exact") {
    return;
  }
  (input.append ?? ((event) => appendEvent(input.logPath, event)))(expected);
}

export function assertDeferredForegroundUserAbandonmentCloseEvent(input: {
  logPath: string;
  conversation: Conversation;
  transfer: DeferredForegroundTransfer;
  plan?: DeferredForegroundUserAbandonmentCloseEventPlan;
}): void {
  const requestedAt = input.transfer.user_abandonment_requested_at;
  const closeReason = input.transfer.user_abandonment_close_reason;
  if (!requestedAt || !closeReason) {
    throw new Error(
      `deferred foreground transfer ${input.transfer.transfer_id} lost its ` +
      "user abandonment close authority"
    );
  }
  const expected = expectedCloseEvent({
    conversationId: input.conversation.conversation_id,
    transferId: input.transfer.transfer_id,
    requestedAt,
    closeReason
  });
  if (
    input.plan && canonicalJson(input.plan.expected) !== canonicalJson(expected)
  ) {
    throw new Error(
      `deferred foreground transfer ${input.transfer.transfer_id} close ` +
      "event plan changed after preflight"
    );
  }
  if (closeEventDisposition({ logPath: input.logPath, expected }) !== "exact") {
    throw new Error(
      `deferred foreground transfer ${input.transfer.transfer_id} final ` +
      "user abandonment is missing its exact close event"
    );
  }
}
