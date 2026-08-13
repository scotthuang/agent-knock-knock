/**
 * Pure ordinary-dispatch gate. The caller owns every Store/terminal read and
 * supplies only the facts observed at the existing preflight boundary.
 */

const TERMINAL_LEVEL_BLOCKING_STATUSES = new Set([
  "prepared",
  "text_injected",
  "dispatching",
  "uncertain",
  "not_accepted"
]);

export type TerminalDispatchReceiptStatus =
  | "submitted"
  | "enter_dispatched"
  | "agent_accepted";

export interface TerminalDispatchLedgerFacts {
  readonly status?: string;
  readonly lifecycle: boolean;
  readonly transitionId?: string;
  readonly ownerConversationId?: string;
}

export interface TerminalDispatchOwnerFacts {
  readonly conversationId: string;
  readonly status: string;
  readonly released: boolean;
  readonly continuingSameTurn: boolean;
  readonly exactReplay: boolean;
}

export interface TerminalDispatchPreflightFacts {
  readonly ledger: TerminalDispatchLedgerFacts;
  readonly owner?: TerminalDispatchOwnerFacts;
}

export type TerminalDispatchPreflightPlan =
  | {
      action: "proceed";
      basis:
        | "no_blocking_dispatch"
        | "released_owner"
        | "continuing_same_turn";
    }
  | {
      action: "reject";
      reason:
        | "unresolved_lifecycle"
        | "terminal_level_dispatch"
        | "owner_unavailable"
        | "active_owner";
      status?: string;
      transitionId?: string;
      ownerConversationId?: string;
      ownerStatus?: string;
    }
  | {
      action: "replay";
      proofLevel: "submitted" | "enter_dispatched" | "agent_accepted";
    };

export interface TerminalDispatchReplayAcceptance {
  readonly accepted: boolean;
  readonly invalid: boolean;
}

/**
 * Preserve the legacy lazy Store read: only an ordinary active receipt status
 * reaches owner loading, and an unresolved lifecycle ledger wins first.
 */
export function terminalDispatchPreflightRequiresOwner(
  ledger: TerminalDispatchLedgerFacts
): boolean {
  return !(
    ledger.lifecycle && ledger.status !== "resolved"
  ) && terminalDispatchReceiptStatus(ledger.status) !== undefined;
}

/**
 * Reduce already-observed dispatch facts to one side-effect-free next action.
 * Error wording, output envelopes and replay receipt construction remain in
 * the CLI compatibility shell.
 */
export function decideTerminalDispatchPreflight(
  facts: TerminalDispatchPreflightFacts
): TerminalDispatchPreflightPlan {
  const { ledger } = facts;
  if (ledger.lifecycle && ledger.status !== "resolved") {
    return {
      action: "reject",
      reason: "unresolved_lifecycle",
      status: ledger.status,
      transitionId: ledger.transitionId
    };
  }

  if (TERMINAL_LEVEL_BLOCKING_STATUSES.has(ledger.status ?? "")) {
    return {
      action: "reject",
      reason: "terminal_level_dispatch",
      status: ledger.status,
      ownerConversationId: ledger.ownerConversationId
    };
  }

  const receiptStatus = terminalDispatchReceiptStatus(ledger.status);
  if (!receiptStatus) {
    return { action: "proceed", basis: "no_blocking_dispatch" };
  }

  const owner = facts.owner;
  if (!owner) {
    return {
      action: "reject",
      reason: "owner_unavailable",
      status: ledger.status
    };
  }
  if (owner.released) {
    return { action: "proceed", basis: "released_owner" };
  }
  if (owner.continuingSameTurn) {
    return { action: "proceed", basis: "continuing_same_turn" };
  }
  if (owner.exactReplay) {
    return {
      action: "replay",
      proofLevel: receiptStatus
    };
  }
  return {
    action: "reject",
    reason: "active_owner",
    status: ledger.status,
    ownerConversationId: owner.conversationId,
    ownerStatus: owner.status
  };
}

function terminalDispatchReceiptStatus(
  status: string | undefined
): TerminalDispatchReceiptStatus | undefined {
  return status === "submitted" ||
    status === "enter_dispatched" ||
    status === "agent_accepted"
    ? status
    : undefined;
}

export function decideTerminalDispatchReplayAcceptance({
  delivered,
  submissionOutcome
}: {
  delivered: boolean;
  submissionOutcome: string;
}): TerminalDispatchReplayAcceptance {
  return {
    accepted: delivered,
    invalid: submissionOutcome === "uncertain"
  };
}
