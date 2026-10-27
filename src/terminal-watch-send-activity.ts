import { knownIdentityDifference, terminalWatchProcessEvidence } from "./terminal-watch-identity-evidence.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import {
  createTerminalActivityWatchAnchor,
  isPaginatedSendWatch,
  isTerminalActivityWatch,
  isUserExplicitFallbackWatch,
  type TerminalActivityWatchAnchor,
  type TerminalWatch
} from "./terminal-watch-record.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export interface UserExplicitFallbackWatchReceipt {
  callback_expected: true;
  callback_mode: "terminal_watch";
  watch_id: string;
  watch_mode?: "exact_task" | "terminal_activity";
  confidence?: "exact" | "best_effort";
}

/** Native input uncertainty is never permission to fall back and send text. */
export function unsafeFallbackWatchPreparation(error: unknown): boolean {
  return isRecord(error) && (error.doNotRetry === true ||
    error.diagnostic === "identity_unverified" || error.diagnostic === "composer_not_ready");
}

export function isAutomaticSendWatch(watch: Pick<TerminalWatch, "anchor">): boolean {
  return isUserExplicitFallbackWatch(watch) || isPaginatedSendWatch(watch) ||
    (isTerminalActivityWatch(watch) && watch.anchor.origin === "user_explicit_send");
}

/** The same persisted Watch produces identical initial and replay receipts. */
export function automaticSendWatchReceipt(watch: TerminalWatch): UserExplicitFallbackWatchReceipt {
  const activity = isTerminalActivityWatch(watch);
  return {
    callback_expected: true as const,
    callback_mode: "terminal_watch" as const,
    watch_id: watch.watch_id,
    watch_mode: activity ? "terminal_activity" as const : "exact_task" as const,
    confidence: activity ? "best_effort" as const : "exact" as const
  };
}

/** Capture only a stable physical observer, never a native task identity. */
export function createAutomaticActivityWatchAnchor(input: {
  terminalId: string;
  pid: number;
  requestHash: string;
  capturedAt: Date;
  before: Record<string, unknown>;
  current: Record<string, unknown>;
  previousWorkspace?: string;
  currentWorkspace?: string;
  control: TerminalControlRef;
}): TerminalActivityWatchAnchor {
  const before = terminalWatchProcessEvidence(input.before);
  const current = terminalWatchProcessEvidence(input.current);
  if (knownIdentityDifference(before.uuid, current.uuid) ||
      knownIdentityDifference(before.birth, current.birth) ||
      knownIdentityDifference(input.previousWorkspace, input.currentWorkspace)) {
    throw new Error("terminal process changed before the automatic activity Watch was prepared");
  }
  if (!input.control.capabilities.includes("screen_status")) {
    throw new Error("automatic activity callback requires exact terminal screen-status observation");
  }
  return createTerminalActivityWatchAnchor({
    capturedAt: input.capturedAt,
    terminalId: input.terminalId,
    pid: input.pid,
    // Earlier pane activity does not prove this Send ran. Arm before dispatch
    // and require post-Send activity before stable idle can settle the Watch.
    initialActivityState: "unknown",
    nativeProcessUuid: before.uuid ?? current.uuid,
    nativeProcessBirth: before.birth ?? current.birth,
    agentVersion: nonBlankString(input.current.agent_version),
    origin: "user_explicit_send",
    requestHash: input.requestHash
  });
}

/** Missing post-Send data may recover; a proven different process cannot. */
export function assertAutomaticActivityWatchIdentity(
  anchor: TerminalActivityWatchAnchor,
  observed: Record<string, unknown>,
  actualWorkspace: string | undefined,
  expectedWorkspace: string
): void {
  const { uuid, birth } = terminalWatchProcessEvidence(observed);
  if (knownIdentityDifference(uuid, anchor.native_process_uuid) ||
      knownIdentityDifference(birth, anchor.native_process_birth) ||
      knownIdentityDifference(actualWorkspace, expectedWorkspace)) {
    throw new Error("terminal process changed before the automatic activity Watch was attached");
  }
}
