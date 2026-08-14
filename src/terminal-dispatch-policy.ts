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

export type TerminalDispatchLedgerAuthority =
  | "absent"
  | "unreadable"
  | "resolved"
  | "stale_process_incarnation"
  | "inactive_status"
  | "active";

export type TerminalDispatchOwnerAuthority =
  | "unavailable"
  | "released"
  | "terminal_mismatch"
  | "generation_mismatch"
  | "current";

export function decideTerminalDispatchOwnership(
  ledger: TerminalDispatchLedgerAuthority,
  owner?: TerminalDispatchOwnerAuthority
) {
  if (ledger === "unreadable") {
    return { state: "conflict" as const, code: "ledger_unreadable" as const };
  }
  if (ledger !== "active") return { state: "none" as const, basis: ledger };
  if (!owner) return { state: "needs_owner" as const };
  if (owner === "unavailable") {
    return { state: "conflict", code: "owner_unavailable" } as const;
  }
  if (owner === "released") {
    return { state: "none" as const, basis: "released_owner" as const };
  }
  if (owner === "terminal_mismatch") {
    return {
      state: "conflict" as const,
      code: "owner_terminal_mismatch" as const
    };
  }
  return owner === "current"
    ? { state: "current" as const }
    : {
        state: "conflict" as const,
        code: "owner_generation_mismatch" as const
      };
}

export interface TerminalSendAuthorityFacts {
  readonly ownership: "none" | "current" | "conflict";
  readonly verifiedEmpty?: boolean;
  readonly externalHandoff?: boolean;
  readonly deferred?: boolean;
  readonly deferredToken?: string;
  readonly externalToken?: string;
  readonly verifiedEmptyToken?: string;
  readonly managedSendSessionId?: string;
}

export function decideTerminalSendAuthority(facts: TerminalSendAuthorityFacts) {
  if (facts.ownership === "current") return { mode: "current" as const };
  const verifiedEmpty = facts.verifiedEmpty ??
    facts.verifiedEmptyToken !== undefined;
  const externalHandoff = facts.externalHandoff ??
    facts.externalToken !== undefined;
  const deferred = facts.deferred ?? facts.deferredToken !== undefined;
  const conflictMode = verifiedEmpty
    ? { mode: "verified_empty" as const, token: facts.verifiedEmptyToken }
    : externalHandoff
      ? { mode: "external_handoff" as const, token: facts.externalToken }
      : deferred
        ? { mode: "deferred" as const, token: facts.deferredToken }
        : undefined;
  if (facts.ownership === "conflict") {
    return conflictMode ?? { mode: "conflict" as const };
  }
  if (deferred) {
    return { mode: "deferred" as const, token: facts.deferredToken };
  }
  return facts.managedSendSessionId
    ? { mode: "managed" as const, sessionId: facts.managedSendSessionId }
    : { mode: "raw" as const };
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
