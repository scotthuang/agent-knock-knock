import {
  createHostLifecycleService,
  HOST_LIFECYCLE_INTERVAL_MS,
  type HostLifecyclePhaseError,
  type HostLifecycleSchedule,
  type HostLifecycleSweepReason
} from "./host-lifecycle-service.js";
import { pushOptional } from "./semantic-tool-arguments.js";
import { runCliAsync } from "./semantic-tool-relay.js";
import { resolvePluginStoreDir } from "./semantic-tool-command-helpers.js";
import { isRecord } from "./value-guards.js";

export const HOST_MONITOR_RECONCILIATION_INTERVAL_MS =
  HOST_LIFECYCLE_INTERVAL_MS;

const MANAGED_MONITOR_PHASE = "managed_turn_monitors";
const TERMINAL_WATCH_PHASE = "terminal_watches";
const DESKTOP_WATCH_PHASE = "desktop_watches";
const CODEX_NATIVE_WATCH_PHASE = "codex_native_watches";
const CLAUDE_NATIVE_WATCH_PHASE = "claude_native_watches";

const scheduleUnref: HostLifecycleSchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function createHostMonitorReconciliationService(
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
  const nativeWatchReconciliationArgs = (command: string): string[] => {
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    const args = [command];
    pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
    pushOptional(args, "--openclaw-bin", config.openclawBin);
    pushOptional(args, "--codex-home", config.codexHome);
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
    reason: string,
    kind: "Terminal Watch" | "Desktop Watch" | "Codex CLI Watch" | "Claude CLI Watch" = "Terminal Watch"
  ): void => {
    if (
      reason === "startup_reconciliation" ||
      Number(result.changed ?? 0) > 0 ||
      Number(result.callbacks_delivered ?? 0) > 0 ||
      Number(result.errors ?? 0) > 0
    ) {
      api.logger.info?.(
        `agent-knock-knock ${kind} ${reason}: ` +
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
    if (phase === TERMINAL_WATCH_PHASE) {
      api.logger.warn?.(
        reason === "startup"
          ? `agent-knock-knock Terminal Watch reconciliation skipped after startup error: ${message}`
          : `agent-knock-knock Terminal Watch supervision deferred after error: ${message}`
      );
      return;
    }
    const label = phase === CODEX_NATIVE_WATCH_PHASE ? "Codex CLI Watch" : phase === CLAUDE_NATIVE_WATCH_PHASE ? "Claude CLI Watch" : "Desktop Watch";
    api.logger.warn?.(
      reason === "startup"
        ? `agent-knock-knock ${label} reconciliation skipped after startup error: ${message}`
        : `agent-knock-knock ${label} supervision deferred after error: ${message}`
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
      },
      {
        name: DESKTOP_WATCH_PHASE,
        async run({ reason }) {
          const reconciliationReason = watchReason(reason);
          const result = await runCliAsync(api, nativeWatchReconciliationArgs("reconcile-desktop-watches"));
          reportWatches(result, reconciliationReason, "Desktop Watch");
        }
      },
      {
        name: CODEX_NATIVE_WATCH_PHASE,
        async run({ reason }) {
          const result = await runCliAsync(api, nativeWatchReconciliationArgs("reconcile-codex-native-watches"));
          reportWatches(result, watchReason(reason), "Codex CLI Watch");
        }
      },
      {
        name: CLAUDE_NATIVE_WATCH_PHASE,
        async run({ reason }) {
          const result = await runCliAsync(api, nativeWatchReconciliationArgs("reconcile-claude-native-watches"));
          reportWatches(result, watchReason(reason), "Claude CLI Watch");
        }
      }
    ]
  });

  return {
    id: "agent-knock-knock-monitor-reconciliation",
    ...lifecycle
  };
}
