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
  previousWorkspace: string;
  currentWorkspace: string;
  control: TerminalControlRef;
}): TerminalActivityWatchAnchor {
  const uuid = requiredProcessField(input.before.native_agent_process_uuid, "UUID");
  const birth = requiredProcessField(input.before.native_agent_process_birth, "birth");
  if (uuid !== requiredProcessField(input.current.native_agent_process_uuid, "UUID") ||
      birth !== requiredProcessField(input.current.native_agent_process_birth, "birth") ||
      input.previousWorkspace !== input.currentWorkspace) {
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
    nativeProcessUuid: uuid,
    nativeProcessBirth: birth,
    agentVersion: nonBlankString(input.current.agent_version),
    origin: "user_explicit_send",
    requestHash: input.requestHash
  });
}

/** Missing post-Send data may recover; a proven different process cannot. */
export function assertAutomaticActivityWatchIdentity(
  anchor: TerminalActivityWatchAnchor,
  observed: Record<string, unknown>,
  actualWorkspace: string,
  expectedWorkspace: string
): void {
  const uuid = nonBlankString(observed.native_agent_process_uuid);
  const birth = nonBlankString(observed.native_agent_process_birth);
  if ((uuid !== undefined && uuid !== anchor.native_process_uuid) ||
      (birth !== undefined && birth !== anchor.native_process_birth) ||
      actualWorkspace !== expectedWorkspace) {
    throw new Error("terminal process changed before the automatic activity Watch was attached");
  }
}

function requiredProcessField(value: unknown, field: string): string {
  const result = nonBlankString(value);
  if (!result) throw new Error(`native process ${field} is required`);
  return result;
}
