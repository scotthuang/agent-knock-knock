import { codexTerminalAgentAdapter } from "./codex-terminal-agent-adapter.js";
import {
  createTerminalAgentAdapterRegistry,
  type TerminalAgentAdapter
} from "./terminal-agent-adapter.js";
import type { ExecutorKind } from "./executors.js";

/** New production terminal agents opt in once here after providing a complete adapter. */
const productionTerminalAgentAdapters: readonly TerminalAgentAdapter[] = [
  codexTerminalAgentAdapter
];

export function createProductionTerminalAgentRegistry(options: {
  overrides?: readonly TerminalAgentAdapter[];
} = {}) {
  const overrides = new Map(
    (options.overrides ?? []).map((adapter) => [adapter.agent, adapter])
  );
  const adapters = productionTerminalAgentAdapters.map(
    (adapter) => overrides.get(adapter.agent) ?? adapter
  );
  const productionAgents = new Set(adapters.map((adapter) => adapter.agent));
  for (const adapter of overrides.values()) {
    if (!productionAgents.has(adapter.agent)) {
      adapters.push(adapter);
    }
  }
  return createTerminalAgentAdapterRegistry(adapters);
}

export const terminalAgentAdapterRegistry = createProductionTerminalAgentRegistry();

export function terminalAgentAdapterFor(agent: ExecutorKind | string): TerminalAgentAdapter {
  return terminalAgentAdapterRegistry.require(agent);
}
