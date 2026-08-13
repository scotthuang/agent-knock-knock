import { createHash } from "node:crypto";

type OwnershipEvent = Readonly<Record<string, unknown>>;

export const LOCK_VERSION = 1;

export interface TerminalMonitorOwnershipItem {
  status: "already_running" | "skipped";
  reason: string;
  monitor_owner_pid?: number | null;
  monitor_lock_version?: number;
}

export type TerminalMonitorOwnershipDecision =
  | { action: "reconcile" }
  | { action: "inspect_legacy" }
  | { action: "stop"; item: TerminalMonitorOwnershipItem };

function monitorMessageKey(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex").slice(0, 20);
}

export function lockPath(
  statePath: string,
  messageId: string
): string {
  return `${statePath}.terminal-bridge-monitor-${monitorMessageKey(messageId)}.lock`;
}

export function handoffLockPath(
  statePath: string,
  messageId: string
): string {
  return `${statePath}.terminal-bridge-monitor-handoff-${monitorMessageKey(messageId)}.lock`;
}

export function latestLaunchPid(
  events: readonly OwnershipEvent[]
): number | undefined {
  const owner = [...events].reverse().find((event) =>
    event.event === "terminal_bridge_monitor_launch" ||
    event.event === "terminal_bridge_monitor_started"
  );
  const pid = Number(
    owner?.event === "terminal_bridge_monitor_started" ? owner.monitor_pid : owner?.pid
  );
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

export function decideCurrent(input: {
  currentOwnerPresent: boolean;
  currentOwnerPid?: number;
  monitorLockVersion: unknown;
}): TerminalMonitorOwnershipDecision {
  if (input.currentOwnerPresent) {
    return {
      action: "stop",
      item: {
        status: "already_running",
        reason: "monitor_lock_owner_alive",
        monitor_owner_pid: input.currentOwnerPid ?? null
      }
    };
  }
  const version = Number(input.monitorLockVersion);
  if (version === LOCK_VERSION) {
    return { action: "reconcile" };
  }
  if (Number.isFinite(version)) {
    return {
      action: "stop",
      item: {
        status: "skipped",
        reason: "monitor_lock_version_unsupported",
        monitor_lock_version: version
      }
    };
  }
  return { action: "inspect_legacy" };
}

export function decideLegacy(input: {
  latestLaunchPid?: number;
  launchProcessAlive: boolean;
}): Exclude<TerminalMonitorOwnershipDecision, { action: "inspect_legacy" }> {
  if (input.latestLaunchPid === undefined) {
    return {
      action: "stop",
      item: { status: "skipped", reason: "legacy_monitor_ownership_unknown" }
    };
  }
  if (input.launchProcessAlive) {
    return {
      action: "stop",
      item: {
        status: "already_running",
        reason: "legacy_monitor_launch_pid_alive",
        monitor_owner_pid: input.latestLaunchPid
      }
    };
  }
  return { action: "reconcile" };
}
