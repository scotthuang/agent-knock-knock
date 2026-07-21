import { createHash } from "node:crypto";
import type { ExecutorKind } from "./executors.js";
import {
  formatTerminalConversationId,
  parseTerminalConversationId,
  terminalControlCapabilitiesForAdapter,
  type ActiveTerminalProcess,
  type TerminalAgentAdapter,
  type TerminalAgentAdapterCapabilities,
  type TerminalAgentAdapterRegistry,
  type TerminalCompletionEvidence,
  type TerminalControlRef,
  type TerminalDurableCompletionRequest,
  type TerminalProcessSnapshot,
  type TerminalScreenInspection
} from "./terminal-agent-adapter.js";
import {
  enrichActiveProcessesWithTerminalControl,
  terminalRefFromPane,
  type TerminalControlProvider
} from "./terminal-control-provider.js";

export interface TerminalBridgeStatus {
  provider: "tmux";
  target: string;
  agent: ExecutorKind;
  reachable: boolean;
  capabilities: Readonly<TerminalAgentAdapterCapabilities>;
  activity_state: "awaiting_approval" | "working" | "idle" | "unknown";
  activity_reason: string;
  approval_state: {
    scanned: boolean;
    blocked: boolean;
    approvable: boolean;
    key?: string;
    keys?: readonly string[];
    label?: string;
    prompt_kind?: string;
    command?: string;
    reason?: string;
    fingerprint?: string;
  };
  screen: {
    excerpt?: string;
    approval?: Record<string, unknown>;
    error?: string;
  };
  capability_limitation?: string;
}

export interface ResolvedTerminalConversation {
  conversationId: string;
  agent: ExecutorKind;
  pid: number;
  legacy: boolean;
  adapter: TerminalAgentAdapter;
  terminalControl: TerminalControlRef;
}

export interface TerminalApprovalExecution {
  approved: boolean;
  blocked: boolean;
  reason?: string;
  key?: string;
  keys?: readonly string[];
  label?: string;
  promptKind?: string;
  command?: string;
  fingerprint?: string;
  screenExcerpt?: string;
}

export interface TerminalMonitorPoll {
  status: TerminalBridgeStatus;
  inspection?: TerminalScreenInspection;
  completion?: TerminalCompletionEvidence;
  durableCompletion?: TerminalCompletionEvidence;
}

export class TerminalAgentBridge {
  readonly registry: TerminalAgentAdapterRegistry;
  readonly terminalProvider: TerminalControlProvider;

  constructor(options: {
    registry: TerminalAgentAdapterRegistry;
    terminalProvider: TerminalControlProvider;
  }) {
    this.registry = options.registry;
    this.terminalProvider = options.terminalProvider;
  }

  adapterFor(agent: ExecutorKind | string): TerminalAgentAdapter {
    return this.registry.require(agent);
  }

  async listProcesses(
    snapshots: readonly TerminalProcessSnapshot[],
    agents?: readonly ExecutorKind[]
  ): Promise<ActiveTerminalProcess[]> {
    const adapters = agents
      ? agents.map((agent) => this.registry.require(agent))
      : this.registry.list();
    const discovered: ActiveTerminalProcess[] = [];
    for (const adapter of adapters) {
      if (!adapter.capabilities.processDiscovery) {
        continue;
      }
      const classified = snapshots
        .map((snapshot) => adapter.classifyProcess(snapshot))
        .filter((process): process is ActiveTerminalProcess => process !== undefined)
        .map((process) => ({ ...process, agent: adapter.agent }));
      discovered.push(...await this.attachProcesses(adapter.agent, classified));
    }
    return discovered;
  }

  async discoverProcesses(
    snapshots: readonly TerminalProcessSnapshot[],
    agents?: readonly ExecutorKind[]
  ): Promise<ActiveTerminalProcess[]> {
    return this.listProcesses(snapshots, agents);
  }

  async attachProcesses<T extends ActiveTerminalProcess>(
    agent: ExecutorKind,
    processes: T[]
  ): Promise<T[]> {
    const adapter = this.registry.require(agent);
    return enrichActiveProcessesWithTerminalControl(processes, this.terminalProvider, {
      capabilities: terminalControlCapabilitiesForAdapter(adapter)
    });
  }

  terminalConversationId(process: Pick<ActiveTerminalProcess, "agent" | "pid" | "terminalControl">): string {
    if (!process.terminalControl) {
      throw new Error(`process ${process.pid} is not terminal-controlled`);
    }
    this.registry.require(process.agent);
    return formatTerminalConversationId({
      agent: process.agent,
      target: process.terminalControl.target,
      pid: process.pid
    });
  }

  async resolveConversationId(conversationId: string | undefined): Promise<ResolvedTerminalConversation | undefined> {
    const parsed = parseTerminalConversationId(conversationId);
    if (!parsed) {
      return undefined;
    }
    const adapter = this.registry.require(parsed.agent);
    const panes = await this.terminalProvider.listPanes();
    const pane = panes.find((candidate) => candidate.kind === parsed.kind && candidate.target === parsed.target);
    if (!pane) {
      throw new Error(`terminal-controlled session ${parsed.conversationId} is no longer available`);
    }
    return {
      conversationId: parsed.conversationId,
      agent: parsed.agent,
      pid: parsed.pid,
      legacy: parsed.legacy,
      adapter,
      terminalControl: terminalRefFromPane(
        pane,
        terminalControlCapabilitiesForAdapter(adapter)
      )
    };
  }

  async status(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    options: { scrollbackLines?: number } = {}
  ): Promise<TerminalBridgeStatus> {
    const adapter = this.registry.require(agent);
    if (!adapter.capabilities.screenStatus) {
      return unsupportedScreenStatus(adapter, terminalControl);
    }
    try {
      const { inspection } = await this.captureInspection(adapter, terminalControl, options);
      return statusFromInspection(adapter, terminalControl, inspection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        provider: terminalControl.kind,
        target: terminalControl.target,
        agent: adapter.agent,
        reachable: false,
        capabilities: adapter.capabilities,
        activity_state: "unknown",
        activity_reason: message,
        approval_state: {
          scanned: false,
          blocked: false,
          approvable: false,
          reason: message
        },
        screen: { error: message }
      };
    }
  }

  async send(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    text: string
  ): Promise<void> {
    const adapter = this.registry.require(agent);
    if (!terminalControl.capabilities.includes("send_keys")) {
      throw new Error(`${adapter.displayName} terminal input is not supported`);
    }
    const normalized = text.trimEnd();
    if (!normalized) {
      throw new Error("terminal message is empty");
    }
    await this.terminalProvider.sendText(terminalControl.target, normalized, {
      socketPath: terminalControl.socketPath
    });
    await this.terminalProvider.sendKeys(terminalControl.target, ["C-m"], {
      socketPath: terminalControl.socketPath
    });
  }

  async cancel(agent: ExecutorKind, terminalControl: TerminalControlRef): Promise<{
    cancelRequested: boolean;
    key?: string;
    keys?: readonly string[];
    reason?: string;
  }> {
    const adapter = this.registry.require(agent);
    if (!adapter.capabilities.cancellation || adapter.cancelKeys.length === 0) {
      return {
        cancelRequested: false,
        reason: `${adapter.displayName} terminal cancellation is not supported`
      };
    }
    await this.terminalProvider.sendKeys(terminalControl.target, adapter.cancelKeys, {
      socketPath: terminalControl.socketPath
    });
    return {
      cancelRequested: true,
      key: adapter.cancelKeys.length === 1 ? adapter.cancelKeys[0] : undefined,
      keys: adapter.cancelKeys
    };
  }

  async approve(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    options: { expectedFingerprint?: string; scrollbackLines?: number } = {}
  ): Promise<TerminalApprovalExecution> {
    const adapter = this.registry.require(agent);
    if (!adapter.capabilities.terminalApproval) {
      return {
        approved: false,
        blocked: true,
        reason: `${adapter.displayName} terminal approval is not supported`
      };
    }
    const { inspection } = await this.captureInspection(adapter, terminalControl, options);
    if (!inspection.approval.approvable) {
      return {
        approved: false,
        blocked: inspection.approval.blocked,
        reason: inspection.approval.reason,
        promptKind: inspection.approval.promptKind,
        command: inspection.approval.command,
        screenExcerpt: inspection.screenExcerpt
      };
    }
    if (inspection.approval.action.keys.length === 0) {
      return {
        approved: false,
        blocked: true,
        reason: `${adapter.displayName} approval action has no keys`,
        label: inspection.approval.action.label,
        promptKind: inspection.approval.promptKind,
        command: inspection.approval.command,
        screenExcerpt: inspection.screenExcerpt
      };
    }
    const fingerprint = terminalApprovalFingerprint(adapter.agent, terminalControl, inspection);
    if (options.expectedFingerprint && options.expectedFingerprint !== fingerprint) {
      return {
        approved: false,
        blocked: true,
        reason: "approval fingerprint changed before execution",
        key: inspection.approval.action.keys.length === 1
          ? inspection.approval.action.keys[0]
          : undefined,
        keys: inspection.approval.action.keys,
        label: inspection.approval.action.label,
        promptKind: inspection.approval.promptKind,
        command: inspection.approval.command,
        fingerprint,
        screenExcerpt: inspection.screenExcerpt
      };
    }
    await this.terminalProvider.sendKeys(
      terminalControl.target,
      inspection.approval.action.keys,
      { socketPath: terminalControl.socketPath }
    );
    return {
      approved: true,
      blocked: false,
      key: inspection.approval.action.keys.length === 1
        ? inspection.approval.action.keys[0]
        : undefined,
      keys: inspection.approval.action.keys,
      label: inspection.approval.action.label,
      promptKind: inspection.approval.promptKind,
      command: inspection.approval.command,
      fingerprint,
      screenExcerpt: inspection.screenExcerpt
    };
  }

  async monitorPoll(options: {
    agent: ExecutorKind;
    terminalControl: TerminalControlRef;
    screenOptions?: {
      scrollbackLines?: number;
      requestText?: string;
      screenChangedSinceSend?: boolean;
      maxExcerptLength?: number;
    };
    durableRequest?: TerminalDurableCompletionRequest;
  }): Promise<TerminalMonitorPoll> {
    const adapter = this.registry.require(options.agent);
    let inspection: TerminalScreenInspection | undefined;
    let status = unsupportedScreenStatus(adapter, options.terminalControl);
    if (adapter.capabilities.screenStatus) {
      try {
        const captured = await this.captureInspection(
          adapter,
          options.terminalControl,
          options.screenOptions
        );
        inspection = captured.inspection;
        status = statusFromInspection(adapter, options.terminalControl, inspection);
      } catch (error) {
        status = failedScreenStatus(adapter, options.terminalControl, error);
      }
    }

    let durableCompletion: TerminalCompletionEvidence | undefined;
    let durableError: string | undefined;
    try {
      durableCompletion = adapter.capabilities.durableCompletion && options.durableRequest
        ? await adapter.detectDurableCompletion?.(options.durableRequest)
        : undefined;
    } catch (error) {
      durableError = error instanceof Error ? error.message : String(error);
    }

    const screenCompletion = adapter.capabilities.screenCompletion
      ? inspection?.completion
      : undefined;
    const limitations = [
      status.capability_limitation,
      durableError ? `durable completion failed: ${durableError}` : undefined,
      !adapter.capabilities.screenCompletion && !adapter.capabilities.durableCompletion
        ? `${adapter.displayName} terminal completion detection is not supported`
        : undefined
    ].filter((value): value is string => Boolean(value));
    return {
      status: limitations.length > 0
        ? { ...status, capability_limitation: limitations.join("; ") }
        : status,
      inspection,
      durableCompletion,
      completion: durableCompletion ?? screenCompletion
    };
  }

  private async captureInspection(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    options: {
      scrollbackLines?: number;
      requestText?: string;
      screenChangedSinceSend?: boolean;
      maxExcerptLength?: number;
    } = {}
  ): Promise<{ screen: string; inspection: TerminalScreenInspection }> {
    const screen = await this.terminalProvider.capture(terminalControl.target, {
      scrollbackLines: options.scrollbackLines ?? 120,
      socketPath: terminalControl.socketPath
    });
    return {
      screen,
      inspection: adapter.inspectScreen({
        screen,
        requestText: options.requestText,
        screenChangedSinceSend: options.screenChangedSinceSend,
        maxExcerptLength: options.maxExcerptLength
      })
    };
  }
}

export function terminalApprovalFingerprint(
  agent: ExecutorKind,
  terminalControl: Pick<TerminalControlRef, "target">,
  inspection: TerminalScreenInspection
): string | undefined {
  if (!inspection.approval.approvable) {
    return undefined;
  }
  return createHash("sha256")
    .update(JSON.stringify({
      agent,
      provider: "tmux",
      target: terminalControl.target,
      keys: inspection.approval.action.keys,
      label: inspection.approval.action.label,
      prompt_kind: inspection.approval.promptKind,
      command: inspection.approval.command,
      screen_excerpt: inspection.screenExcerpt
    }))
    .digest("hex");
}

function statusFromInspection(
  adapter: TerminalAgentAdapter,
  terminalControl: TerminalControlRef,
  inspection: TerminalScreenInspection
): TerminalBridgeStatus {
  const approval = inspection.approval;
  const fingerprint = terminalApprovalFingerprint(adapter.agent, terminalControl, inspection);
  return {
    provider: terminalControl.kind,
    target: terminalControl.target,
    agent: adapter.agent,
    reachable: true,
    capabilities: adapter.capabilities,
    activity_state: inspection.activity.state,
    activity_reason: inspection.activity.reason,
    approval_state: {
      scanned: true,
      blocked: approval.blocked,
      approvable: approval.approvable,
      key: approval.approvable && approval.action.keys.length === 1
        ? approval.action.keys[0]
        : undefined,
      keys: approval.approvable ? approval.action.keys : undefined,
      label: approval.approvable ? approval.action.label : undefined,
      prompt_kind: approval.promptKind,
      command: approval.command,
      reason: approval.approvable ? undefined : approval.reason,
      fingerprint
    },
    screen: {
      excerpt: inspection.screenExcerpt,
      approval: approvalOutput(approval)
    }
  };
}

function failedScreenStatus(
  adapter: TerminalAgentAdapter,
  terminalControl: TerminalControlRef,
  error: unknown
): TerminalBridgeStatus {
  const message = error instanceof Error ? error.message : String(error);
  return {
    provider: terminalControl.kind,
    target: terminalControl.target,
    agent: adapter.agent,
    reachable: false,
    capabilities: adapter.capabilities,
    activity_state: "unknown",
    activity_reason: message,
    approval_state: {
      scanned: false,
      blocked: false,
      approvable: false,
      reason: message
    },
    screen: { error: message }
  };
}

function approvalOutput(approval: TerminalScreenInspection["approval"]): Record<string, unknown> {
  if (!approval.approvable) {
    return {
      blocked: approval.blocked,
      approvable: false,
      reason: approval.reason,
      promptKind: approval.promptKind,
      command: approval.command
    };
  }
  return {
    blocked: true,
    approvable: true,
    key: approval.action.keys.length === 1 ? approval.action.keys[0] : undefined,
    keys: approval.action.keys,
    label: approval.action.label,
    promptKind: approval.promptKind,
    command: approval.command
  };
}

function unsupportedScreenStatus(
  adapter: TerminalAgentAdapter,
  terminalControl: TerminalControlRef
): TerminalBridgeStatus {
  const reason = `${adapter.displayName} terminal screen status is not supported`;
  return {
    provider: terminalControl.kind,
    target: terminalControl.target,
    agent: adapter.agent,
    reachable: true,
    capabilities: adapter.capabilities,
    activity_state: "unknown",
    activity_reason: reason,
    approval_state: {
      scanned: false,
      blocked: false,
      approvable: false,
      reason
    },
    screen: {},
    capability_limitation: reason
  };
}
