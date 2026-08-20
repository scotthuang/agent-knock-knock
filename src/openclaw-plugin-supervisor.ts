import {
  pushOptional,
  runCli,
  runCliAsync
} from "./openclaw-plugin-command-adapter.js";
import { resolvePluginStoreDir } from "./openclaw-plugin-helpers.js";
import { isRecord } from "./value-guards.js";

export const MONITOR_SUPERVISOR_INTERVAL_MS = 5_000;

export function createMonitorReconciliationService(
  api,
  configuredIntervalMs: number
) {
  const intervalMs = Number.isFinite(configuredIntervalMs) &&
    configuredIntervalMs > 0
    ? Math.max(50, Math.ceil(configuredIntervalMs))
    : MONITOR_SUPERVISOR_INTERVAL_MS;
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const reconciliationArgs = (reason: string): string[] => {
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    const args = ["reconcile-monitors", "--reason", reason];
    if (reason === "monitor_supervision") {
      args.push("--terminal-monitors-only");
    }
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
  const schedule = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = supervise().finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, intervalMs);
    timer.unref?.();
  };
  const supervise = async (): Promise<void> => {
    try {
      const result = await runCliAsync(
        api,
        reconciliationArgs("monitor_supervision")
      );
      report(result, "monitor_supervision");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn?.(
        `agent-knock-knock monitor supervision deferred after error: ${message}`
      );
    }
  };

  return {
    id: "agent-knock-knock-monitor-reconciliation",
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      try {
        const result = runCli(
          api,
          reconciliationArgs("startup_reconciliation")
        );
        report(result, "startup_reconciliation");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn?.(
          `agent-knock-knock monitor reconciliation skipped after startup error: ${message}`
        );
      }
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await inFlight;
    }
  };
}
