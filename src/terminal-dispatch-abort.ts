export type TerminalZeroInputFailureKind = "setup" | "transport";

export type TerminalZeroInputAbortBlocker =
  | "dispatch_ledger_restore"
  | "raw_attach_rollback"
  | "aborted_state_persistence";

interface TerminalZeroInputAbortOutcomeBase {
  failureKind: TerminalZeroInputFailureKind;
}

export type TerminalZeroInputAbortOutcome =
  | TerminalZeroInputAbortOutcomeBase & {
      disposition: "retry";
      safeToRetry: true;
    }
  | TerminalZeroInputAbortOutcomeBase & {
      disposition: "inspect";
      safeToRetry: false;
      blocker: TerminalZeroInputAbortBlocker;
    };

export interface ReduceTerminalZeroInputAbortOptions {
  failureKind: TerminalZeroInputFailureKind;
  dispatchLedgerRestored: boolean;
  rawAttachRolledBack: boolean;
  abortedStatePersisted: boolean;
}

/** Reduce durable zero-input evidence without performing recovery or writes. */
export function reduceTerminalZeroInputAbort(
  options: ReduceTerminalZeroInputAbortOptions
): TerminalZeroInputAbortOutcome {
  const base = { failureKind: options.failureKind };
  if (!options.dispatchLedgerRestored) {
    return {
      ...base,
      disposition: "inspect",
      safeToRetry: false,
      blocker: "dispatch_ledger_restore"
    };
  }
  if (!options.rawAttachRolledBack) {
    return {
      ...base,
      disposition: "inspect",
      safeToRetry: false,
      blocker: "raw_attach_rollback"
    };
  }
  if (!options.abortedStatePersisted) {
    return {
      ...base,
      disposition: "inspect",
      safeToRetry: false,
      blocker: "aborted_state_persistence"
    };
  }
  return { ...base, disposition: "retry", safeToRetry: true };
}
