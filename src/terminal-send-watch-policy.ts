import { isCodexPaginatedReadCandidate } from "./codex-lifecycle-compatibility.js";
const CODEX_PRE_READ_CONTRACT_PAGINATED_VERSIONS = new Set(["0.157.0", "0.157.1"]);

/** New physical Sends can acquire a paginated task anchor before task input. */
export function codexPhysicalSendUsesPaginatedWatch(agentVersion?: string): boolean {
  return isCodexPaginatedReadCandidate(agentVersion);
}

export function codexManagedSendRequiresLegacyHistory(agentVersion?: string): boolean {
  return isCodexPaginatedReadCandidate(agentVersion) ||
    CODEX_PRE_READ_CONTRACT_PAGINATED_VERSIONS.has(agentVersion ?? "");
}

/** Managed Monitor still consumes legacy rollouts, never paginated thread data. */
export function assertCodexManagedSendHasLegacyHistory(input: {
  agentVersion?: string;
  verifiedLegacyRootCount: number;
}): void {
  if (!codexManagedSendRequiresLegacyHistory(input.agentVersion)) return;
  if (Number.isSafeInteger(input.verifiedLegacyRootCount) &&
      input.verifiedLegacyRootCount > 0) return;
  throw new Error(
    "Codex " + input.agentVersion + " has no verified legacy rollout for " +
    "managed Send and Monitor. Refresh AKK list and use the exact physical " +
    "terminal selector with its expected_terminal_token for Send and Watch. " +
    "No Turn was created and no task input was sent."
  );
}

export type CodexUserExplicitSendWatchSource =
  | { source: "codex_paginated" }
  | { source: "codex_rollout" }
  | {
      source: "none";
      reasonCode: "codex_paginated_history_anchor_unavailable";
      warning: string;
    };

/** A missing rollout on paginated clients is not a future-rollout promise. */
export function selectCodexUserExplicitSendWatchSource(input: {
  agentVersion?: string;
  /** Count of independently verified legacy open-root rollouts, if observed. */
  legacyRootCount?: number;
  /** True only after capturing an exact, validated paginated history anchor. */
  paginatedAnchorAvailable: boolean;
}): CodexUserExplicitSendWatchSource {
  if (input.paginatedAnchorAvailable) return { source: "codex_paginated" };
  if (
    codexManagedSendRequiresLegacyHistory(input.agentVersion) &&
    !(Number.isSafeInteger(input.legacyRootCount) &&
      Number(input.legacyRootCount) > 0)
  ) {
    return {
      source: "none",
      reasonCode: "codex_paginated_history_anchor_unavailable",
      warning: `Codex ${input.agentVersion} has no verified legacy root ` +
        "rollout or exact paginated history anchor. The message can still be " +
        "sent, but no exact-task completion callback can be established. " +
        "A best-effort terminal-activity Watch may still be attached after " +
        "physical identity and screen-status validation."
    };
  }
  return { source: "codex_rollout" };
}

export interface TerminalSendFallbackWatchReceipt {
  callback_expected: boolean;
  callback_mode: "terminal_watch";
  watch_id: string;
  watch_mode?: "exact_task" | "terminal_activity";
  confidence?: "exact" | "best_effort";
}

export function terminalSendFallbackWatchPresentation(
  receipt: TerminalSendFallbackWatchReceipt | undefined
): {
  callbackAvailable: boolean;
  receiptFields: Record<string, unknown>;
  summary: string;
  nextAction: string;
} {
  if (!receipt?.callback_expected) {
    return {
      callbackAvailable: false,
      receiptFields: { callback_expected: false },
      summary: "No callback Watch could be attached.",
      nextAction: "refresh AKK list; the live coding agent continues " +
        "independently of AKK callback state"
    };
  }
  // Old persisted receipts and test adapters lack these optional fields.
  // Any explicit best-effort signal is kept conservative on presentation.
  const activity = receipt.watch_mode === "terminal_activity" ||
    receipt.confidence === "best_effort";
  return {
    callbackAvailable: true,
    receiptFields: {
      ...receipt,
      watch_mode: activity ? "terminal_activity" : "exact_task",
      confidence: activity ? "best_effort" : "exact"
    },
    summary: activity
      ? `Terminal Watch ${receipt.watch_id} reports terminal activity and ` +
        "stable idle on a best-effort basis. It cannot prove this request's " +
        "exact completion or answer native questions automatically."
      : `Terminal Watch ${receipt.watch_id} observes this request's native ` +
        "acceptance and completion; no managed Turn was claimed.",
    nextAction: activity
      ? `follow Terminal Watch ${receipt.watch_id} activity notifications or ` +
        "inspect the exact shared pane; stable idle is not proof of this " +
        "request's completion"
      : `wait for Terminal Watch ${receipt.watch_id} callback; ` +
        "watch-status remains available for recovery"
  };
}
