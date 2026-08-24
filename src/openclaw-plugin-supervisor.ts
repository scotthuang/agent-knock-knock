import {
  createHostLifecycleService,
  HOST_LIFECYCLE_INTERVAL_MS,
  type HostLifecyclePhaseError,
  type HostLifecycleSchedule,
  type HostLifecycleSweepReason
} from "./host-lifecycle-service.js";
import {
  pushOptional,
  runCliAsync
} from "./openclaw-plugin-command-adapter.js";
import { resolvePluginStoreDir } from "./openclaw-plugin-helpers.js";
import { isRecord } from "./value-guards.js";

export const MONITOR_SUPERVISOR_INTERVAL_MS = HOST_LIFECYCLE_INTERVAL_MS;

const MANAGED_MONITOR_PHASE = "managed_turn_monitors";
const TERMINAL_WATCH_PHASE = "terminal_watches";

const scheduleUnref: HostLifecycleSchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function createMonitorReconciliationService(
  api,
  configuredIntervalMs: number
) {
  const reconciliationArgs = (reason: string): string[] => {
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    const args = ["reconcile-monitors", "--reason", reason];
    if (reason === "monitor_supervision") {
      args.push("--terminal-monitors-only");
    }
    pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
    return args;
  };
  const watchReconciliationArgs = (): string[] => {
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    const args = ["reconcile-watches"];
    pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
    return args;
  };
  const report = (result: Record<string, unknown>, reason: string): void => {
    if (
      reason === "startup_reconciliation" ||
      Number(result.launched ?? 0) > 0 ||
      Number(result.errors ?? 0) > 0
    ) {
      const label = reason === "startup_reconciliation"
        ? "monitor reconciliation"
        : `monitor ${reason}`;
      api.logger.info?.(
        `agent-knock-knock ${label}: ` +
        `checked=${result.checked ?? 0} launched=${result.launched ?? 0} ` +
        `already_running=${result.already_running ?? 0} skipped=${result.skipped ?? 0} ` +
        `errors=${result.errors ?? 0}`
      );
    }
  };
  const reportWatches = (
    result: Record<string, unknown>,
    reason: string
  ): void => {
    if (
      reason === "startup_reconciliation" ||
      Number(result.changed ?? 0) > 0 ||
      Number(result.callbacks_delivered ?? 0) > 0 ||
      Number(result.errors ?? 0) > 0
    ) {
      api.logger.info?.(
        `agent-knock-knock Terminal Watch ${reason}: ` +
        `checked=${result.checked ?? 0} changed=${result.changed ?? 0} ` +
        `callbacks_delivered=${result.callbacks_delivered ?? 0} ` +
        `errors=${result.errors ?? 0}`
      );
    }
  };
  const managedReason = (reason: HostLifecycleSweepReason): string =>
    reason === "startup" ? "startup_reconciliation" : "monitor_supervision";
  const watchReason = (reason: HostLifecycleSweepReason): string =>
    reason === "startup" ? "startup_reconciliation" : "watch_supervision";
  const onPhaseError = ({
    phase,
    reason,
    error
  }: HostLifecyclePhaseError): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (phase === MANAGED_MONITOR_PHASE) {
      api.logger.warn?.(
        reason === "startup"
          ? `agent-knock-knock monitor reconciliation skipped after startup error: ${message}`
          : `agent-knock-knock monitor supervision deferred after error: ${message}`
      );
      return;
    }
    api.logger.warn?.(
      reason === "startup"
        ? `agent-knock-knock Terminal Watch reconciliation skipped after startup error: ${message}`
        : `agent-knock-knock Terminal Watch supervision deferred after error: ${message}`
    );
  };

  const lifecycle = createHostLifecycleService({
    intervalMs: configuredIntervalMs,
    schedule: scheduleUnref,
    onPhaseError,
    phases: [
      {
        name: MANAGED_MONITOR_PHASE,
        async run({ reason }) {
          const reconciliationReason = managedReason(reason);
          const result = await runCliAsync(
            api,
            reconciliationArgs(reconciliationReason)
          );
          report(result, reconciliationReason);
        }
      },
      {
        name: TERMINAL_WATCH_PHASE,
        async run({ reason }) {
          const reconciliationReason = watchReason(reason);
          const result = await runCliAsync(api, watchReconciliationArgs());
          reportWatches(result, reconciliationReason);
        }
      }
    ]
  });

  return {
    id: "agent-knock-knock-monitor-reconciliation",
    ...lifecycle
  };
}
