import {
  definePluginEntry,
  type OpenClawPluginDefinition
} from "openclaw/plugin-sdk/plugin-entry";
import {
  registerOpenClawCallbackGateway
} from "./openclaw-plugin-callback-adapter.js";
import {
  bindOpenClawRelayPath,
  defaultOpenClawRelayPath,
  registerOpenClawCommands
} from "./openclaw-plugin-command-adapter.js";
import {
  createMonitorReconciliationService,
  MONITOR_SUPERVISOR_INTERVAL_MS
} from "./openclaw-plugin-supervisor.js";

function createPlugin(
  relayPath: string,
  {
    monitorSupervisorIntervalMs = MONITOR_SUPERVISOR_INTERVAL_MS
  }: {
    monitorSupervisorIntervalMs?: number;
  } = {}
): OpenClawPluginDefinition {
  const displayedResumeSnapshots = new Map<
    string,
    { snapshotId: string; expiresAtMs: number }
  >();
  return definePluginEntry({
    id: "agent-knock-knock",
    name: "Agent Knock Knock",
    description:
      "Agent Knock Knock (AKK/akk) lets OpenClaw operate local Codex and Claude Code through shared tmux or Herdr terminals, with visible monitoring, approvals, callbacks, cancellation, and seamless human takeover.",
    register(api) {
      bindOpenClawRelayPath(api, relayPath);
      registerOpenClawCallbackGateway(api);
      try {
        api.registerService?.(
          createMonitorReconciliationService(
            api,
            monitorSupervisorIntervalMs
          )
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn?.(
          `agent-knock-knock monitor reconciliation service was not registered: ${message}`
        );
      }
      registerOpenClawCommands(api, displayedResumeSnapshots);
    }
  });
}

const plugin: OpenClawPluginDefinition = createPlugin(
  defaultOpenClawRelayPath
);

export function createOpenClawPluginForTest(
  relayPath: string,
  options: { monitorSupervisorIntervalMs?: number } = {}
): OpenClawPluginDefinition {
  return createPlugin(relayPath, options);
}

export default plugin;
