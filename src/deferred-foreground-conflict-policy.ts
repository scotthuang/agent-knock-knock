import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import { listDeferredForegroundTransfers,
  loadDeferredForegroundTransfer } from "./deferred-foreground-transfer.js";
import { turnIdForConversation, type Conversation } from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import { terminalControlEvidenceMatches } from "./terminal-control-ref.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";

/**
 * Keep a Turn immutable while it is reserved by a nonterminal deferred
 * foreground transfer. This guard observes Store state only and never sends
 * terminal input.
 */
export function assertConversationHasNoNonterminalDeferredForegroundTransfer({
  storeDir,
  conversation,
  action
}: {
  storeDir: string;
  conversation: Conversation;
  action: string;
}): void {
  const turnId = turnIdForConversation(conversation);
  const sourceTransfer = listDeferredForegroundTransfers(storeDir).find(
    (candidate) =>
      candidate.version === 2 &&
      candidate.source_kind === "candidate_rollout_quiescent" &&
      !isFinalDeferredForegroundTransferStatus(candidate.status) &&
      (candidate.source_turn_history ?? []).some(
        (sourceTurn) => sourceTurn.turn_id === turnId
      )
  );
  if (sourceTransfer) {
    throw new Error(
      `cannot ${action} Turn ${turnId} while deferred foreground transfer ` +
      `${sourceTransfer.transfer_id} reserves it as immutable source ` +
      `history in ${sourceTransfer.status}; dedicated transfer recovery ` +
      "must finish first"
    );
  }
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const transferId = stringValue(takeover?.deferred_foreground_transfer_id);
  if (!transferId) {
    return;
  }
  const transfer = loadDeferredForegroundTransfer(storeDir, transferId);
  if (!isFinalDeferredForegroundTransferStatus(transfer.status)) {
    throw new Error(
      `cannot ${action} Turn ${turnId} while deferred foreground transfer ` +
      `${transfer.transfer_id} is ${transfer.status}; dedicated transfer ` +
      "recovery must finish first"
    );
  }
}

/**
 * Keep one exact physical terminal immutable while a deferred foreground
 * transfer still owns its lifecycle boundary.
 */
export function assertTerminalHasNoNonterminalDeferredForegroundTransfer({
  storeDir,
  pid,
  terminalControl,
  action
}: {
  storeDir: string;
  pid: number;
  terminalControl: TerminalControlRef;
  action: string;
}): void {
  const transfer = listDeferredForegroundTransfers(storeDir).find(
    (candidate) =>
      !isFinalDeferredForegroundTransferStatus(candidate.status) &&
      candidate.process_pid === pid &&
      terminalControlEvidenceMatches(
        candidate.terminal_endpoint,
        terminalControl
      )
  );
  if (!transfer) {
    return;
  }
  throw new Error(
    `cannot ${action} terminal ${terminalControl.target} while deferred ` +
    `foreground transfer ${transfer.transfer_id} is ${transfer.status}; ` +
    "dedicated transfer recovery must finish first"
  );
}
