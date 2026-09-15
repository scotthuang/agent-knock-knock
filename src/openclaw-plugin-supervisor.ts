import {
  createHostMonitorReconciliationService,
  HOST_MONITOR_RECONCILIATION_INTERVAL_MS
} from "./host-monitor-reconciliation.js";

/** OpenClaw adapter name retained as a compatibility boundary. */
export const MONITOR_SUPERVISOR_INTERVAL_MS =
  HOST_MONITOR_RECONCILIATION_INTERVAL_MS;

/** OpenClaw adapter for the shared Host lifecycle implementation. */
export const createMonitorReconciliationService =
  createHostMonitorReconciliationService;
