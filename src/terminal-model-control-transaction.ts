export const TERMINAL_MODEL_CONTROL_TRANSACTION_PHASES = [
  "no_input",
  "reversible_input",
  "commit_attempted",
  "postcondition_proven"
] as const;

export type TerminalModelControlTransactionPhase =
  typeof TERMINAL_MODEL_CONTROL_TRANSACTION_PHASES[number];

export type TerminalModelControlTransactionEvent =
  | "reversible_input_attempted"
  | "commit_attempted"
  | "postcondition_proven";

export type TerminalModelControlCleanupOutcome =
  | "not_attempted"
  | "proven"
  | "failed";

export interface TerminalModelControlFailureDecision {
  readonly unwind: boolean;
  readonly outcome: "throw" | "uncertain";
  readonly doNotRetry: boolean;
  /** Repair authority can only come from a later exact live residual scan. */
  readonly residualRepair: "none" | "fresh_inspection_required";
}

/** Pure monotonic reducer for every native model-control input boundary. */
export function reduceTerminalModelControlTransactionPhase(
  phase: TerminalModelControlTransactionPhase,
  event: TerminalModelControlTransactionEvent
): TerminalModelControlTransactionPhase {
  if (phase === "postcondition_proven") {
    throw new Error(
      "model-control transaction cannot accept input after its postcondition"
    );
  }
  if (event === "postcondition_proven") return "postcondition_proven";
  if (phase === "commit_attempted" || event === "commit_attempted") {
    return "commit_attempted";
  }
  return "reversible_input";
}

/**
 * One failure policy for unwind, uncertainty and automatic-retry safety.
 * A failed cleanup never grants repair directly; List must freshly inspect an
 * exact residual before advertising its separately fenced repair action.
 */
export function decideTerminalModelControlFailure(
  phase: TerminalModelControlTransactionPhase,
  cleanup: TerminalModelControlCleanupOutcome
): TerminalModelControlFailureDecision {
  const reversible = phase === "reversible_input";
  const committed = phase === "commit_attempted";
  const inputAttempted = reversible || committed;
  const cleanupFailedAfterInput = inputAttempted && cleanup === "failed";
  const uncertain = committed || cleanupFailedAfterInput;
  return {
    unwind: inputAttempted && cleanup === "not_attempted",
    outcome: uncertain ? "uncertain" : "throw",
    doNotRetry: uncertain,
    residualRepair: cleanupFailedAfterInput
      ? "fresh_inspection_required"
      : "none"
  };
}
