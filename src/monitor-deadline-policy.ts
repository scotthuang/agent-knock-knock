/** New monitoring lifetimes only: persisted absolute deadlines are never reinterpreted. */
export const DEFAULT_MONITOR_HARD_TIMEOUT_MINUTES = 720;
const MILLISECONDS_PER_MINUTE = 60_000;

/** Callers select their existing aliases before resolving explicit > configured > default. */
export function resolveMonitorHardTimeoutMinutes(explicit?: unknown, configured?: unknown): number {
  return Number(explicit ?? configured ?? DEFAULT_MONITOR_HARD_TIMEOUT_MINUTES);
}

/** Keep duration units explicit; entry points retain their existing validation contracts. */
export function monitorMinutesToMs(minutes: number): number {
  return minutes * MILLISECONDS_PER_MINUTE;
}

/** Services also use the shared default when called without a CLI/plugin adapter. */
export function resolveMonitorHardTimeoutMs(timeoutMs?: number): number {
  return timeoutMs ?? monitorMinutesToMs(DEFAULT_MONITOR_HARD_TIMEOUT_MINUTES);
}
