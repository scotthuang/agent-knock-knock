import type { ExecutorKind } from "./executors.js";
import {
  parseTerminalConversationId,
  type ActiveTerminalProcess,
  type TerminalAgentAdapterRegistry,
  type TerminalControlRef,
  type TerminalProcessSnapshot
} from "./terminal-agent-adapter.js";
import type { TerminalAgentBridge } from "./terminal-agent-bridge.js";
import { selectRootTerminalProcesses } from "./terminal-authority-policy.js";
import type { TerminalControlProvider } from "./terminal-control-provider.js";
import type { TerminalProcessSource } from "./terminal-process-source.js";

export interface TerminalListInventoryEntry {
  agent?: string;
  activity_state?: string;
  durable_activity_reason?: string;
  durable_activity_state?: string;
  cwd?: string;
  id?: string;
  native_identity_state?: string;
  screen_reason?: string;
  screen_state?: string;
  short_ref?: string;
  terminal_control?: TerminalControlRef | {
    target?: string;
    [field: string]: unknown;
  };
  workspace?: string;
  [field: string]: unknown;
}

export interface TerminalListInventoryScan {
  terminalControlled: TerminalListInventoryEntry[];
  summary: {
    error?: string;
    [field: string]: unknown;
  };
}

export interface TerminalListInventoryOptions {
  managedOnly?: boolean;
  noApprovalScan?: boolean;
  terminalDebug?: boolean;
}

export interface TerminalListInventoryPorts<
  Options extends TerminalListInventoryOptions
> {
  createRegistry(options: Options): TerminalAgentAdapterRegistry;
  createBridge(
    options: Options,
    provider: TerminalControlProvider,
    registry: TerminalAgentAdapterRegistry
  ): TerminalAgentBridge;
  createProvider(options: Options): TerminalControlProvider;
  createProcessSource(options: Options): TerminalProcessSource;
  projectTerminal(input: {
    session: ActiveTerminalProcess;
    activeSessions: ActiveTerminalProcess[];
    options: Options;
    bridge: TerminalAgentBridge;
  }): Promise<TerminalListInventoryEntry>;
  log(
    level: "info",
    event: string,
    fields: Record<string, unknown>
  ): void;
}

/**
 * Collect one physical process/terminal inventory without consulting Store
 * ownership or public action policy. Every selected process is projected by
 * exactly one caller-supplied per-terminal observation operation.
 */
export async function collectTerminalListInventory<
  Options extends TerminalListInventoryOptions
>(input: {
  options: Options;
  agentFilter?: ExecutorKind;
  terminalId?: string;
  ports: TerminalListInventoryPorts<Options>;
}): Promise<TerminalListInventoryScan> {
  const { options, agentFilter, terminalId, ports } = input;
  const empty: TerminalListInventoryScan = {
    terminalControlled: [],
    summary: {
      enabled: false,
      agents: [],
      error: undefined
    }
  };
  if (options.managedOnly) return empty;

  const registry = ports.createRegistry(options);
  const adapters = agentFilter
    ? [registry.get(agentFilter)].filter((adapter) => adapter !== undefined)
    : registry.list();
  if (agentFilter && adapters.length === 0) {
    return {
      ...empty,
      summary: {
        enabled: true,
        agents: [],
        skipped: `terminal agent adapter is not registered for ${agentFilter}`
      }
    };
  }

  const terminalProvider = ports.createProvider(options);
  const bridge = ports.createBridge(options, terminalProvider, registry);
  const terminalDiagnostics = options.terminalDebug
    ? await terminalProvider.diagnostics()
    : undefined;
  const exactTarget = terminalId
    ? exactTerminalTargetDiagnostic(terminalId)
    : undefined;
  if (terminalId) {
    ports.log("info", "terminal_exact_scan", {
      stage: "started",
      terminal_id: terminalId,
      target: exactTarget
    });
  }

  const terminalControlled: TerminalListInventoryEntry[] = [];
  let activeCount = 0;
  const errors: string[] = [];
  try {
    const processSource = ports.createProcessSource(options);
    const snapshots = await processSource.listProcessSnapshots((snapshot) =>
      adapters.some((adapter) =>
        adapter.capabilities.processDiscovery &&
          adapter.classifyProcess(snapshot) !== undefined
      ),
      { includeAncestors: true }
    );
    logExactProcessInventory(ports, terminalId, exactTarget, snapshots);

    const activeSessions = await bridge.listProcesses(
      snapshots,
      adapters.map((adapter) => adapter.agent)
    );
    const rootSessions = selectRootTerminalProcesses(activeSessions, snapshots);
    const controlledSessions = rootSessions.filter(
      (session) => session.terminalControl !== undefined
    );
    logExactProcessAssociation({
      ports,
      terminalId,
      exactTarget,
      activeSessions,
      rootSessions,
      controlledSessions,
      bridge
    });
    activeCount = controlledSessions.length;
    const selectedSessions = terminalId
      ? activeSessions.filter(
          (session) => session.terminalControl !== undefined &&
            bridge.terminalConversationId(session) === terminalId
        )
      : controlledSessions;
    for (const session of selectedSessions) {
      try {
        terminalControlled.push(await ports.projectTerminal({
          session,
          activeSessions,
          options,
          bridge
        }));
      } catch (error) {
        errors.push(
          `terminal process ${session.pid}: ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (terminalId) {
    ports.log("info", "terminal_exact_scan", {
      stage: "complete",
      terminal_id: terminalId,
      controlled_process_count: activeCount,
      terminal_row_count: terminalControlled.length,
      terminal_row_ids: terminalControlled.map((terminal) => terminal.id),
      errors
    });
  }
  return {
    terminalControlled,
    summary: {
      enabled: true,
      agents: adapters.map((adapter) => adapter.agent),
      active_count: activeCount,
      terminal_count: terminalControlled.length,
      approval_scan: options.noApprovalScan ? "disabled" : "enabled",
      diagnostics: terminalDiagnostics,
      error: errors.length > 0 ? errors.join("; ") : undefined
    }
  };
}

function logExactProcessInventory<Options extends TerminalListInventoryOptions>(
  ports: TerminalListInventoryPorts<Options>,
  terminalId: string | undefined,
  exactTarget: ReturnType<typeof exactTerminalTargetDiagnostic>,
  snapshots: readonly TerminalProcessSnapshot[]
): void {
  if (!terminalId) return;
  const targetPid = exactTarget?.pid;
  ports.log("info", "terminal_exact_scan", {
    stage: "process_inventory",
    terminal_id: terminalId,
    target_pid: targetPid,
    snapshot_count: snapshots.length,
    target_process_found: targetPid === undefined
      ? undefined
      : snapshots.some((snapshot) => snapshot.pid === targetPid),
    target_process_snapshots: targetPid === undefined
      ? []
      : snapshots
        .filter((snapshot) => snapshot.pid === targetPid)
        .map((snapshot) => ({ pid: snapshot.pid, ppid: snapshot.ppid }))
  });
}

function logExactProcessAssociation<Options extends TerminalListInventoryOptions>(
  input: {
    ports: TerminalListInventoryPorts<Options>;
    terminalId?: string;
    exactTarget: ReturnType<typeof exactTerminalTargetDiagnostic>;
    activeSessions: ActiveTerminalProcess[];
    rootSessions: ActiveTerminalProcess[];
    controlledSessions: ActiveTerminalProcess[];
    bridge: TerminalAgentBridge;
  }
): void {
  if (!input.terminalId) return;
  const targetPid = input.exactTarget?.pid;
  const targetSessions = targetPid === undefined
    ? []
    : input.activeSessions.filter((session) => session.pid === targetPid);
  input.ports.log("info", "terminal_exact_scan", {
    stage: "process_classification_and_association",
    terminal_id: input.terminalId,
    target_pid: targetPid,
    classified_process_count: input.activeSessions.length,
    root_process_count: input.rootSessions.length,
    controlled_process_count: input.controlledSessions.length,
    target_classified_count: targetSessions.length,
    target_controlled_count: targetSessions.filter(
      (session) => session.terminalControl !== undefined
    ).length,
    target_sessions: targetSessions.map((session) => ({
      agent: session.agent,
      pid: session.pid,
      ppid: session.ppid,
      kind: session.kind,
      confidence: session.confidence,
      selected_as_root: input.rootSessions.includes(session),
      terminal_conversation_id: session.terminalControl
        ? input.bridge.terminalConversationId(session)
        : undefined,
      terminal_control: terminalControlScanDiagnostic(session.terminalControl)
    }))
  });
}

function exactTerminalTargetDiagnostic(
  terminalId: string
): {
  provider?: string;
  agent?: string;
  route?: string;
  pid?: number;
  parse_error?: string;
} | undefined {
  try {
    const parsed = parseTerminalConversationId(terminalId);
    return parsed ? {
      provider: parsed.kind,
      agent: parsed.agent,
      route: parsed.target,
      pid: parsed.pid
    } : undefined;
  } catch (error) {
    return {
      parse_error: error instanceof Error ? error.message : String(error)
    };
  }
}

function terminalControlScanDiagnostic(
  terminalControl: TerminalControlRef | undefined
): Record<string, unknown> | undefined {
  if (!terminalControl) return undefined;
  const control = terminalControl as unknown as Record<string, unknown>;
  return {
    kind: terminalControl.kind,
    target: terminalControl.target,
    pane_pid: control.panePid,
    process_anchor_pid: control.processAnchorPid,
    endpoint_key: control.endpointKey,
    resource_key: control.resourceKey,
    terminal_id: control.terminalId
  };
}
