import { deferredForegroundUserAbandonmentFingerprint } from
  "./deferred-foreground-user-abandonment-ledger.js";
import type { DeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import { turnIdForConversation, type Conversation } from "./protocol.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export function exactDeferredForegroundUserAbandonmentTurnReceipt(
  conversation: Conversation,
  transfer: DeferredForegroundTransfer
): boolean {
  const receipt = isRecord(conversation.management_abandonment)
    ? conversation.management_abandonment
    : undefined;
  return Boolean(
    conversation.status === "closed" &&
    conversation.disposition === "user_abandoned_management" &&
    conversation.callback_expected === false &&
    conversation.closed_at === transfer.user_abandonment_requested_at &&
    conversation.close_reason === transfer.user_abandonment_close_reason &&
    turnIdForConversation(conversation) === transfer.turn_id &&
    transfer.user_abandonment_turn_id === transfer.turn_id &&
    receipt?.version === 1 &&
    receipt.disposition === "user_abandoned_management" &&
    nonBlankString(receipt.transfer_id) === transfer.transfer_id &&
    Number(receipt.transfer_origin_revision) ===
      transfer.user_abandonment_origin_revision &&
    nonBlankString(receipt.turn_fingerprint) ===
      transfer.user_abandonment_turn_fingerprint &&
    nonBlankString(receipt.requested_at) ===
      transfer.user_abandonment_requested_at &&
    nonBlankString(receipt.close_reason) ===
      transfer.user_abandonment_close_reason
  );
}

export function deferredForegroundUserAbandonmentTurnAuthority(
  conversation: Conversation,
  transfer: DeferredForegroundTransfer
): { turnFingerprint: string } {
  if (isRecord(conversation.management_abandonment)) {
    if (!exactDeferredForegroundUserAbandonmentTurnReceipt(
      conversation,
      transfer
    )) {
      throw new Error(
        `Turn ${turnIdForConversation(conversation)} management abandonment ` +
        "authority changed"
      );
    }
    return {
      turnFingerprint: transfer.user_abandonment_turn_fingerprint as string
    };
  }
  if (conversation.status === "closed") {
    throw new Error(
      `closed Turn ${turnIdForConversation(conversation)} has no exact ` +
      "deferred management abandonment receipt"
    );
  }
  if (transfer.status === "user_abandoning") {
    const frozen = transfer.user_abandonment_turn_fingerprint;
    if (!frozen) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} lost its ` +
        "frozen Turn abandonment authority"
      );
    }
    return { turnFingerprint: frozen };
  }
  return {
    turnFingerprint: deferredForegroundUserAbandonmentFingerprint(conversation)
  };
}
