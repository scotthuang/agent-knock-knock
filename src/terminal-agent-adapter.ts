import { isExecutorKind, type ExecutorKind } from "./executors.js";

export type DiscoveryConfidence = "high" | "medium" | "low";

export interface TerminalProcessSnapshot {
  pid: number;
  ppid?: number;
  command: string;
  cwd?: string;
  elapsed?: string;
}

export type TerminalControlCapability =
  | "screen_status"
  | "send_keys"
  | "terminal_approval"
  | "screen_completion"
  | "durable_completion"
  | "terminal_cancel";

export interface TerminalControlRef {
  kind: "tmux";
  target: string;
  socketPath?: string;
  session: string;
  window: number;
  pane: number;
  panePid: number;
  currentCommand?: string;
  currentPath?: string;
  capabilities: TerminalControlCapability[];
}

export interface ActiveTerminalProcess<ProcessKind extends string = string> extends TerminalProcessSnapshot {
  agent: ExecutorKind;
  kind: ProcessKind;
  sessionId?: string;
  confidence: DiscoveryConfidence;
  reason: string;
  terminalControl?: TerminalControlRef;
}

export type TerminalActivityState = "awaiting_approval" | "working" | "idle" | "unknown";

export interface TerminalActivityInspection {
  state: TerminalActivityState;
  reason: string;
}

export interface TerminalApprovalAction {
  /** Screen adapters use keys; hook-backed adapters use a structured one-time decision. */
  mode?: "keys" | "structured";
  /** Exact ordered tmux key sequence to send after prompt revalidation. */
  keys: readonly string[];
  label: string;
  /** Opaque adapter-owned request identity for a structured decision. */
  requestId?: string;
}

export type TerminalApprovalInspection =
  | {
      blocked: true;
      approvable: true;
      promptKind: string;
      command?: string;
      /** Safe display name for the tool that requested permission. */
      toolName?: string;
      /** Redacted, bounded summary of the permission target; never the full tool input. */
      requestDetail?: string;
      action: TerminalApprovalAction;
    }
  | {
      blocked: boolean;
      approvable: false;
      reason: string;
      promptKind?: string;
      command?: string;
      toolName?: string;
      requestDetail?: string;
      action?: undefined;
    };

export interface TerminalCompletionEvidence {
  source: "screen" | "durable";
  outcome?: "success" | "failure";
  text: string;
  timestamp?: string;
  id?: string;
  confidence?: "high" | "medium" | "low" | "screen_only";
  metadata?: Record<string, unknown>;
}

export interface TerminalRuntimeIdentity {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  conversationId?: string;
  messageId?: string;
  terminalTarget?: string;
}

export interface TerminalScreenInspectionOptions {
  screen: string;
  requestText?: string;
  screenChangedSinceSend?: boolean;
  maxExcerptLength?: number;
  runtime?: TerminalRuntimeIdentity;
}

export interface TerminalScreenInspection {
  activity: TerminalActivityInspection;
  approval: TerminalApprovalInspection;
  screenExcerpt: string;
  completion?: TerminalCompletionEvidence;
}

export interface TerminalDurableCompletionRequest {
  sessionId?: string;
  cwd?: string;
  requestText?: string;
  requestHash?: string;
  startedAt?: string;
  context?: unknown;
}

export interface TerminalApprovalDecisionRequest {
  decision: "allow" | "deny";
  expectedFingerprint: string;
  actualFingerprint: string;
  inspection: TerminalScreenInspection;
  runtime?: TerminalRuntimeIdentity;
  interrupt?: boolean;
}

export interface TerminalApprovalDecisionResult {
  resolved: boolean;
  requestId?: string;
  reason?: string;
}

export interface TerminalAgentAdapterCapabilities {
  processDiscovery: boolean;
  screenStatus: boolean;
  terminalApproval: boolean;
  screenCompletion: boolean;
  durableCompletion: boolean;
  cancellation: boolean;
}

export interface TerminalAgentAdapter<ProcessKind extends string = string> {
  readonly agent: ExecutorKind;
  readonly displayName: string;
  readonly capabilities: Readonly<TerminalAgentAdapterCapabilities>;
  /** Exact ordered tmux key sequence used to cancel the interactive agent. */
  readonly cancelKeys: readonly string[];

  classifyProcess(snapshot: TerminalProcessSnapshot): ActiveTerminalProcess<ProcessKind> | undefined;
  inspectScreen(options: TerminalScreenInspectionOptions): TerminalScreenInspection;
  resolveApproval?(
    request: TerminalApprovalDecisionRequest
  ): Promise<TerminalApprovalDecisionResult>;
  detectDurableCompletion?(
    request: TerminalDurableCompletionRequest
  ): Promise<TerminalCompletionEvidence | undefined>;
}

export class TerminalAgentAdapterRegistry {
  private readonly adapters = new Map<ExecutorKind, TerminalAgentAdapter>();

  constructor(adapters: readonly TerminalAgentAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: TerminalAgentAdapter): this {
    if (this.adapters.has(adapter.agent)) {
      throw new Error(`terminal agent adapter is already registered for ${adapter.agent}`);
    }
    if (adapter.capabilities.durableCompletion && !adapter.detectDurableCompletion) {
      throw new Error(
        `terminal agent adapter ${adapter.agent} advertises durable completion without implementing it`
      );
    }
    if (adapter.capabilities.cancellation && adapter.cancelKeys.length === 0) {
      throw new Error(
        `terminal agent adapter ${adapter.agent} advertises cancellation without an ordered key sequence`
      );
    }
    this.adapters.set(adapter.agent, adapter);
    return this;
  }

  get(agent: ExecutorKind | string): TerminalAgentAdapter | undefined {
    return isExecutorKind(agent) ? this.adapters.get(agent) : undefined;
  }

  require(agent: ExecutorKind | string): TerminalAgentAdapter {
    const adapter = this.get(agent);
    if (!adapter) {
      throw new Error(`terminal agent adapter is not registered for ${agent || "<empty>"}`);
    }
    return adapter;
  }

  list(): TerminalAgentAdapter[] {
    return [...this.adapters.values()];
  }
}

export function createTerminalAgentAdapterRegistry(
  adapters: readonly TerminalAgentAdapter[] = []
): TerminalAgentAdapterRegistry {
  return new TerminalAgentAdapterRegistry(adapters);
}

export function terminalControlCapabilitiesForAdapter(
  adapter: Pick<TerminalAgentAdapter, "capabilities">
): TerminalControlCapability[] {
  const capabilities: TerminalControlCapability[] = [];
  if (adapter.capabilities.screenStatus) {
    capabilities.push("screen_status");
  }
  capabilities.push("send_keys");
  if (adapter.capabilities.terminalApproval) {
    capabilities.push("terminal_approval");
  }
  if (adapter.capabilities.screenCompletion) {
    capabilities.push("screen_completion");
  }
  if (adapter.capabilities.durableCompletion) {
    capabilities.push("durable_completion");
  }
  if (adapter.capabilities.cancellation) {
    capabilities.push("terminal_cancel");
  }
  return capabilities;
}

export interface TerminalConversationIdentity {
  conversationId: string;
  kind: "tmux";
  agent: ExecutorKind;
  target: string;
  pid: number;
  legacy: boolean;
}

export function formatTerminalConversationId({
  agent,
  target,
  pid
}: {
  agent: ExecutorKind;
  target: string;
  pid: number;
}): string {
  if (!isExecutorKind(agent)) {
    throw new Error(`unsupported terminal agent: ${String(agent || "<empty>")}`);
  }
  assertTerminalIdentityParts(target, pid);
  return `terminal:v2:tmux:${agent}:${target}:${pid}`;
}

export function parseTerminalConversationId(
  conversationId: string | undefined
): TerminalConversationIdentity | undefined {
  const agentAwarePrefix = "terminal:v2:tmux:";
  const legacyPrefix = "terminal:tmux:";
  if (!conversationId?.startsWith(agentAwarePrefix) && !conversationId?.startsWith(legacyPrefix)) {
    return undefined;
  }

  const legacy = conversationId.startsWith(legacyPrefix);
  const prefix = legacy ? legacyPrefix : agentAwarePrefix;
  const rest = conversationId.slice(prefix.length);
  const pidSeparator = rest.lastIndexOf(":");
  if (pidSeparator <= 0 || pidSeparator === rest.length - 1) {
    throw new Error(`invalid terminal-controlled conversation id: ${conversationId}`);
  }
  let identity = rest.slice(0, pidSeparator);
  const pid = Number(rest.slice(pidSeparator + 1));
  let agent: ExecutorKind = "codex";
  if (!legacy) {
    const agentSeparator = identity.indexOf(":");
    const parsedAgent = agentSeparator > 0 ? identity.slice(0, agentSeparator) : "";
    if (!isExecutorKind(parsedAgent)) {
      throw new Error(
        `unsupported terminal agent in conversation id: ${parsedAgent || "<empty>"}`
      );
    }
    agent = parsedAgent;
    identity = identity.slice(agentSeparator + 1);
  }
  const target = identity;
  assertTerminalIdentityParts(target, pid, conversationId);

  return {
    conversationId,
    kind: "tmux",
    agent,
    target,
    pid,
    legacy
  };
}

function assertTerminalIdentityParts(target: string, pid: number, conversationId?: string): void {
  if (!target || !Number.isInteger(pid)) {
    throw new Error(
      conversationId
        ? `invalid terminal-controlled conversation id: ${conversationId}`
        : "terminal-controlled conversation id requires a target and integer pid"
    );
  }
}
