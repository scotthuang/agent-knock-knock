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
  type TerminalRuntimeIdentity,
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
    cwd?: string;
    tool_name?: string;
    request_detail?: string;
    reason?: string;
    fingerprint?: string;
    decision_mode?: "keys" | "structured";
    request_id?: string;
  };
  screen: {
    excerpt?: string;
    /** SHA-256 of the raw capture. The raw terminal contents are never exposed here. */
    digest?: string;
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
  cwd?: string;
  toolName?: string;
  requestDetail?: string;
  fingerprint?: string;
  screenExcerpt?: string;
  decisionMode?: "keys" | "structured";
  requestId?: string;
}

export interface TerminalIdentityVerificationRequest {
  agent: ExecutorKind;
  pid: number;
  terminalControl: TerminalControlRef;
}

export interface TerminalIdentityVerificationResult {
  terminalControl?: TerminalControlRef;
}

export type TerminalIdentityVerifier = (
  request: TerminalIdentityVerificationRequest
) => Promise<TerminalIdentityVerificationResult | void>;

export interface TerminalApprovalAuthorizationContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  inspection: TerminalScreenInspection;
  fingerprint?: string;
  runtime?: TerminalRuntimeIdentity;
}

export interface TerminalApprovalAuthorizationDecision {
  approved: boolean;
  reason?: string;
}

export interface TerminalApprovalKeyDispatchContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  inspection: TerminalScreenInspection;
  fingerprint: string;
  keys: readonly string[];
  runtime?: TerminalRuntimeIdentity;
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
  private readonly verifyIdentity?: TerminalIdentityVerifier;

  constructor(options: {
    registry: TerminalAgentAdapterRegistry;
    terminalProvider: TerminalControlProvider;
    verifyIdentity?: TerminalIdentityVerifier;
  }) {
    this.registry = options.registry;
    this.terminalProvider = options.terminalProvider;
    this.verifyIdentity = options.verifyIdentity;
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
      discovered.push(...await enrichActiveProcessesWithTerminalControl(
        classified,
        this.terminalProvider,
        {
          capabilities: terminalControlCapabilitiesForAdapter(adapter),
          processTree: snapshots
        }
      ));
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
    processes: T[],
    options: { processTree?: readonly TerminalProcessSnapshot[] } = {}
  ): Promise<T[]> {
    const adapter = this.registry.require(agent);
    return enrichActiveProcessesWithTerminalControl(processes, this.terminalProvider, {
      capabilities: terminalControlCapabilitiesForAdapter(adapter),
      processTree: options.processTree
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
    const candidates = panes.filter(
      (candidate) => candidate.kind === parsed.kind && candidate.target === parsed.target
    );
    const verified = this.verifyIdentity
      ? (await Promise.all(candidates.map(async (pane) => {
          const terminalControl = terminalRefFromPane(
            pane,
            terminalControlCapabilitiesForAdapter(adapter)
          );
          try {
            const verifiedTerminalControl = await this.verifyTerminalIdentity(
              adapter.agent,
              terminalControl,
              { pid: parsed.pid }
            );
            return { pane, terminalControl: verifiedTerminalControl };
          } catch {
            return undefined;
          }
        }))).filter((candidate): candidate is {
          pane: (typeof candidates)[number];
          terminalControl: TerminalControlRef;
        } => candidate !== undefined)
      : candidates.slice(0, 1).map((pane) => ({
          pane,
          terminalControl: terminalRefFromPane(
            pane,
            terminalControlCapabilitiesForAdapter(adapter)
          )
        }));
    if (verified.length === 0) {
      throw new Error(`terminal-controlled session ${parsed.conversationId} is no longer available`);
    }
    if (verified.length > 1) {
      throw new Error(`terminal-controlled session ${parsed.conversationId} matches multiple active panes`);
    }
    return {
      conversationId: parsed.conversationId,
      agent: parsed.agent,
      pid: parsed.pid,
      legacy: parsed.legacy,
      adapter,
      terminalControl: verified[0].terminalControl
    };
  }

  async status(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    options: { scrollbackLines?: number; runtime?: TerminalRuntimeIdentity } = {}
  ): Promise<TerminalBridgeStatus> {
    const adapter = this.registry.require(agent);
    if (
      !adapter.capabilities.screenStatus ||
      !terminalControl.capabilities.includes("screen_status")
    ) {
      return unsupportedScreenStatus(adapter, terminalControl);
    }
    try {
      const captured = await this.captureInspection(adapter, terminalControl, options);
      return statusFromInspection(adapter, captured.terminalControl, captured.inspection, {
        screen: captured.screen,
        runtime: options.runtime
      });
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
    text: string,
    options: { runtime?: TerminalRuntimeIdentity } = {}
  ): Promise<void> {
    const adapter = this.registry.require(agent);
    if (!terminalControl.capabilities.includes("send_keys")) {
      throw new Error(`${adapter.displayName} terminal input is not supported`);
    }
    const normalized = text.trimEnd();
    if (!normalized) {
      throw new Error("terminal message is empty");
    }
    const verifiedForText = await this.verifyTerminalIdentity(
      adapter.agent,
      terminalControl,
      options.runtime
    );
    await this.terminalProvider.sendText(verifiedForText.target, normalized, {
      socketPath: verifiedForText.socketPath
    });
    // Text and Enter are separate tmux operations. Revalidate between them; if the
    // identity changed, clear the line best-effort and never submit it.
    let verifiedForEnter: TerminalControlRef;
    try {
      verifiedForEnter = await this.verifyTerminalIdentity(
        adapter.agent,
        terminalControl,
        options.runtime
      );
    } catch (error) {
      try {
        await this.terminalProvider.sendKeys(verifiedForText.target, ["C-u"], {
          socketPath: verifiedForText.socketPath
        });
      } catch {
        // Best effort only: preserving the identity failure is more important than cleanup.
      }
      throw error;
    }
    await this.terminalProvider.sendKeys(verifiedForEnter.target, ["C-m"], {
      socketPath: verifiedForEnter.socketPath
    });
  }

  async cancel(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    options: { runtime?: TerminalRuntimeIdentity; scrollbackLines?: number } = {}
  ): Promise<{
    cancelRequested: boolean;
    key?: string;
    keys?: readonly string[];
    reason?: string;
    deniedApproval?: boolean;
    requestId?: string;
  }> {
    const adapter = this.registry.require(agent);
    if (
      adapter.capabilities.terminalApproval &&
      adapter.resolveApproval &&
      terminalControl.capabilities.includes("terminal_approval") &&
      adapter.capabilities.screenStatus &&
      terminalControl.capabilities.includes("screen_status")
    ) {
      const captured = await this.captureInspection(adapter, terminalControl, options);
      const { inspection } = captured;
      if (inspection.approval.approvable && inspection.approval.action.mode === "structured") {
        const fingerprint = terminalApprovalFingerprint(
          adapter.agent,
          captured.terminalControl,
          inspection,
          {
            screen: captured.screen,
            runtime: options.runtime
          }
        );
        if (!fingerprint) {
          return {
            cancelRequested: false,
            reason: `${adapter.displayName} structured approval has no fingerprint`
          };
        }
        await this.verifyTerminalIdentity(adapter.agent, captured.terminalControl, options.runtime);
        const decision = await adapter.resolveApproval({
          decision: "deny",
          expectedFingerprint: fingerprint,
          actualFingerprint: fingerprint,
          inspection,
          runtime: options.runtime,
          interrupt: true
        });
        return {
          cancelRequested: decision.resolved,
          deniedApproval: decision.resolved,
          requestId: decision.requestId,
          reason: decision.reason
        };
      }
      if (inspection.approval.blocked && !inspection.approval.approvable) {
        return {
          cancelRequested: false,
          reason: inspection.approval.reason
        };
      }
    }
    if (
      !adapter.capabilities.cancellation ||
      adapter.cancelKeys.length === 0 ||
      !terminalControl.capabilities.includes("terminal_cancel")
    ) {
      return {
        cancelRequested: false,
        reason: `${adapter.displayName} terminal cancellation is not supported`
      };
    }
    const verifiedForCancel = await this.verifyTerminalIdentity(
      adapter.agent,
      terminalControl,
      options.runtime
    );
    await this.terminalProvider.sendKeys(verifiedForCancel.target, adapter.cancelKeys, {
      socketPath: verifiedForCancel.socketPath
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
    options: {
      expectedFingerprint?: string;
      scrollbackLines?: number;
      runtime?: TerminalRuntimeIdentity;
      requiredDecisionMode?: "keys" | "structured";
      authorize?: (
        context: TerminalApprovalAuthorizationContext
      ) => TerminalApprovalAuthorizationDecision | Promise<TerminalApprovalAuthorizationDecision>;
      /**
       * Persist an at-most-once dispatch reservation after final prompt/identity validation
       * and immediately before tmux receives the approval keys.
       */
      beforeKeyDispatch?: (
        context: TerminalApprovalKeyDispatchContext
      ) => void | Promise<void>;
    } = {}
  ): Promise<TerminalApprovalExecution> {
    const adapter = this.registry.require(agent);
    if (
      !adapter.capabilities.terminalApproval ||
      !terminalControl.capabilities.includes("terminal_approval")
    ) {
      return {
        approved: false,
        blocked: true,
        reason: `${adapter.displayName} terminal approval is not supported`
      };
    }
    const captured = await this.captureInspection(adapter, terminalControl, options);
    const { inspection } = captured;
    const activeTerminalControl = captured.terminalControl;
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
    const decisionMode = inspection.approval.action.mode ?? "keys";
    if (options.requiredDecisionMode && decisionMode !== options.requiredDecisionMode) {
      return {
        approved: false,
        blocked: true,
        reason: `${adapter.displayName} approval mode ${decisionMode} is not eligible for this decision`,
        label: inspection.approval.action.label,
        promptKind: inspection.approval.promptKind,
        command: inspection.approval.command,
        fingerprint: terminalApprovalFingerprint(
          adapter.agent,
          activeTerminalControl,
          inspection,
          {
            screen: captured.screen,
            runtime: options.runtime
          }
        ),
        screenExcerpt: inspection.screenExcerpt,
        decisionMode,
        requestId: inspection.approval.action.requestId
      };
    }
    if (decisionMode === "keys" && inspection.approval.action.keys.length === 0) {
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
    const fingerprint = terminalApprovalFingerprint(
      adapter.agent,
      activeTerminalControl,
      inspection,
      {
        screen: captured.screen,
        runtime: options.runtime
      }
    );
    if (
      adapter.agent === "claude" &&
      decisionMode === "keys" &&
      !options.expectedFingerprint
    ) {
      return {
        approved: false,
        blocked: true,
        reason: "screen approval requires the latest expected fingerprint",
        key: inspection.approval.action.keys.length === 1
          ? inspection.approval.action.keys[0]
          : undefined,
        keys: inspection.approval.action.keys,
        label: inspection.approval.action.label,
        promptKind: inspection.approval.promptKind,
        command: inspection.approval.command,
        cwd: inspection.approval.cwd,
        toolName: inspection.approval.toolName,
        requestDetail: inspection.approval.requestDetail,
        fingerprint,
        screenExcerpt: inspection.screenExcerpt,
        decisionMode,
        requestId: inspection.approval.action.requestId
      };
    }
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
        screenExcerpt: inspection.screenExcerpt,
        decisionMode,
        requestId: inspection.approval.action.requestId
      };
    }
    if (options.authorize) {
      const authorization = await options.authorize({
        agent: adapter.agent,
        terminalControl: activeTerminalControl,
        inspection,
        fingerprint,
        runtime: options.runtime
      });
      if (!authorization.approved) {
        return {
          approved: false,
          blocked: true,
          reason: authorization.reason ?? "approval was not authorized",
          key: inspection.approval.action.keys.length === 1
            ? inspection.approval.action.keys[0]
            : undefined,
          keys: inspection.approval.action.keys,
          label: inspection.approval.action.label,
          promptKind: inspection.approval.promptKind,
          command: inspection.approval.command,
          toolName: inspection.approval.toolName,
          requestDetail: inspection.approval.requestDetail,
          fingerprint,
          screenExcerpt: inspection.screenExcerpt,
          decisionMode,
          requestId: inspection.approval.action.requestId
        };
      }
    }
    if (decisionMode === "structured") {
      if (!options.expectedFingerprint) {
        return {
          approved: false,
          blocked: true,
          reason: "structured approval requires the latest expected fingerprint",
          label: inspection.approval.action.label,
          promptKind: inspection.approval.promptKind,
          command: inspection.approval.command,
          fingerprint,
          screenExcerpt: inspection.screenExcerpt,
          decisionMode,
          requestId: inspection.approval.action.requestId
        };
      }
      if (!fingerprint || !adapter.resolveApproval) {
        return {
          approved: false,
          blocked: true,
          reason: `${adapter.displayName} structured approval resolver is unavailable`,
          fingerprint,
          screenExcerpt: inspection.screenExcerpt,
          decisionMode,
          requestId: inspection.approval.action.requestId
        };
      }
      await this.verifyTerminalIdentity(adapter.agent, activeTerminalControl, options.runtime);
      const resolved = await adapter.resolveApproval({
        decision: "allow",
        expectedFingerprint: options.expectedFingerprint,
        actualFingerprint: fingerprint,
        inspection,
        runtime: options.runtime
      });
      return {
        approved: resolved.resolved,
        blocked: !resolved.resolved,
        reason: resolved.reason,
        label: inspection.approval.action.label,
        promptKind: inspection.approval.promptKind,
        command: inspection.approval.command,
        fingerprint,
        screenExcerpt: inspection.screenExcerpt,
        decisionMode,
        requestId: resolved.requestId ?? inspection.approval.action.requestId
      };
    }
    const recaptured = await this.captureInspection(
      adapter,
      activeTerminalControl,
      options
    );
    const recapturedInspection = recaptured.inspection;
    if (!recapturedInspection.approval.approvable) {
      return {
        approved: false,
        blocked: true,
        reason: "approval prompt is no longer approvable after authorization",
        promptKind: recapturedInspection.approval.promptKind,
        command: recapturedInspection.approval.command,
        cwd: recapturedInspection.approval.cwd,
        toolName: recapturedInspection.approval.toolName,
        requestDetail: recapturedInspection.approval.requestDetail,
        screenExcerpt: recapturedInspection.screenExcerpt
      };
    }
    const recapturedDecisionMode = recapturedInspection.approval.action.mode ?? "keys";
    const recapturedFingerprint = terminalApprovalFingerprint(
      adapter.agent,
      recaptured.terminalControl,
      recapturedInspection,
      {
        screen: recaptured.screen,
        runtime: options.runtime
      }
    );
    if (recapturedDecisionMode !== decisionMode) {
      return {
        approved: false,
        blocked: true,
        reason: "approval decision mode changed after authorization",
        key: recapturedInspection.approval.action.keys.length === 1
          ? recapturedInspection.approval.action.keys[0]
          : undefined,
        keys: recapturedInspection.approval.action.keys,
        label: recapturedInspection.approval.action.label,
        promptKind: recapturedInspection.approval.promptKind,
        command: recapturedInspection.approval.command,
        cwd: recapturedInspection.approval.cwd,
        toolName: recapturedInspection.approval.toolName,
        requestDetail: recapturedInspection.approval.requestDetail,
        fingerprint: recapturedFingerprint,
        screenExcerpt: recapturedInspection.screenExcerpt,
        decisionMode: recapturedDecisionMode,
        requestId: recapturedInspection.approval.action.requestId
      };
    }
    if (recapturedFingerprint !== fingerprint) {
      return {
        approved: false,
        blocked: true,
        reason: "approval fingerprint changed after authorization",
        key: recapturedInspection.approval.action.keys.length === 1
          ? recapturedInspection.approval.action.keys[0]
          : undefined,
        keys: recapturedInspection.approval.action.keys,
        label: recapturedInspection.approval.action.label,
        promptKind: recapturedInspection.approval.promptKind,
        command: recapturedInspection.approval.command,
        cwd: recapturedInspection.approval.cwd,
        toolName: recapturedInspection.approval.toolName,
        requestDetail: recapturedInspection.approval.requestDetail,
        fingerprint: recapturedFingerprint,
        screenExcerpt: recapturedInspection.screenExcerpt,
        decisionMode: recapturedDecisionMode,
        requestId: recapturedInspection.approval.action.requestId
      };
    }
    const verifiedForApproval = await this.verifyTerminalIdentity(
      adapter.agent,
      recaptured.terminalControl,
      options.runtime
    );
    if (!recapturedFingerprint) {
      return {
        approved: false,
        blocked: true,
        reason: "approval has no dispatch fingerprint",
        screenExcerpt: recapturedInspection.screenExcerpt,
        decisionMode: recapturedDecisionMode
      };
    }
    await options.beforeKeyDispatch?.({
      agent: adapter.agent,
      terminalControl: verifiedForApproval,
      inspection: recapturedInspection,
      fingerprint: recapturedFingerprint,
      keys: recapturedInspection.approval.action.keys,
      runtime: options.runtime
    });
    await this.terminalProvider.sendKeys(
      verifiedForApproval.target,
      recapturedInspection.approval.action.keys,
      { socketPath: verifiedForApproval.socketPath }
    );
    return {
      approved: true,
      blocked: false,
      key: recapturedInspection.approval.action.keys.length === 1
        ? recapturedInspection.approval.action.keys[0]
        : undefined,
      keys: recapturedInspection.approval.action.keys,
      label: recapturedInspection.approval.action.label,
      promptKind: recapturedInspection.approval.promptKind,
      command: recapturedInspection.approval.command,
      cwd: recapturedInspection.approval.cwd,
      fingerprint: recapturedFingerprint,
      screenExcerpt: recapturedInspection.screenExcerpt,
      decisionMode: recapturedDecisionMode,
      requestId: recapturedInspection.approval.action.requestId
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
      runtime?: TerminalRuntimeIdentity;
    };
    durableRequest?: TerminalDurableCompletionRequest;
  }): Promise<TerminalMonitorPoll> {
    const adapter = this.registry.require(options.agent);
    let inspection: TerminalScreenInspection | undefined;
    let status = unsupportedScreenStatus(adapter, options.terminalControl);
    if (
      adapter.capabilities.screenStatus &&
      options.terminalControl.capabilities.includes("screen_status")
    ) {
      try {
        const captured = await this.captureInspection(
          adapter,
          options.terminalControl,
          options.screenOptions
        );
        inspection = captured.inspection;
        status = statusFromInspection(adapter, captured.terminalControl, inspection, {
          screen: captured.screen,
          runtime: options.screenOptions?.runtime
        });
      } catch (error) {
        status = failedScreenStatus(adapter, options.terminalControl, error);
      }
    }

    let durableCompletion: TerminalCompletionEvidence | undefined;
    let durableError: string | undefined;
    try {
      durableCompletion = adapter.capabilities.durableCompletion &&
        options.terminalControl.capabilities.includes("durable_completion") &&
        options.durableRequest
        ? await adapter.detectDurableCompletion?.(options.durableRequest)
        : undefined;
    } catch (error) {
      durableError = error instanceof Error ? error.message : String(error);
    }

    const screenCompletion = adapter.capabilities.screenCompletion &&
      options.terminalControl.capabilities.includes("screen_completion")
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
      runtime?: TerminalRuntimeIdentity;
    } = {}
  ): Promise<{
    terminalControl: TerminalControlRef;
    screen: string;
    inspection: TerminalScreenInspection;
  }> {
    const verifiedTerminalControl = await this.verifyTerminalIdentity(
      adapter.agent,
      terminalControl,
      options.runtime
    );
    const screen = await this.terminalProvider.capture(verifiedTerminalControl.target, {
      scrollbackLines: options.scrollbackLines ?? 120,
      socketPath: verifiedTerminalControl.socketPath
    });
    return {
      terminalControl: verifiedTerminalControl,
      screen,
      inspection: adapter.inspectScreen({
        screen,
        requestText: options.requestText,
        screenChangedSinceSend: options.screenChangedSinceSend,
        maxExcerptLength: options.maxExcerptLength,
        runtime: options.runtime
      })
    };
  }

  private async verifyTerminalIdentity(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime?: TerminalRuntimeIdentity
  ): Promise<TerminalControlRef> {
    if (!this.verifyIdentity) {
      return terminalControl;
    }
    if (!Number.isInteger(runtime?.pid) || Number(runtime?.pid) <= 0) {
      throw new Error(
        `refusing terminal access for ${agent}:${terminalControl.target} without an exact agent pid; reattach this legacy tmux session before controlling it`
      );
    }
    const result = await this.verifyIdentity({
      agent,
      pid: Number(runtime?.pid),
      terminalControl
    });
    return result?.terminalControl ?? terminalControl;
  }
}

export function terminalApprovalFingerprint(
  agent: ExecutorKind,
  terminalControl: TerminalControlRef,
  inspection: TerminalScreenInspection,
  options: {
    screen?: string;
    runtime?: TerminalRuntimeIdentity;
  } = {}
): string | undefined {
  if (!inspection.approval.approvable) {
    return undefined;
  }
  const decisionMode = inspection.approval.action.mode ?? "keys";
  const rawScreenDigest = decisionMode === "keys" && options.screen !== undefined
    ? createHash("sha256").update(options.screen).digest("hex")
    : undefined;
  return createHash("sha256")
    .update(JSON.stringify({
      agent,
      provider: "tmux",
      terminal: {
        target: terminalControl.target,
        socket_path: terminalControl.socketPath,
        session: terminalControl.session,
        window: terminalControl.window,
        pane: terminalControl.pane,
        pane_pid: terminalControl.panePid
      },
      runtime: {
        pid: options.runtime?.pid,
        session_id: options.runtime?.sessionId,
        cwd: options.runtime?.cwd,
        conversation_id: options.runtime?.conversationId,
        message_id: options.runtime?.messageId,
        terminal_target: options.runtime?.terminalTarget
      },
      keys: inspection.approval.action.keys,
      label: inspection.approval.action.label,
      prompt_kind: inspection.approval.promptKind,
      command: inspection.approval.command,
      cwd: inspection.approval.cwd,
      tool_name: inspection.approval.toolName,
      request_detail: inspection.approval.requestDetail,
      raw_screen_sha256: rawScreenDigest,
      decision_mode: decisionMode,
      request_id: inspection.approval.action.requestId
    }))
    .digest("hex");
}

function statusFromInspection(
  adapter: TerminalAgentAdapter,
  terminalControl: TerminalControlRef,
  inspection: TerminalScreenInspection,
  options: {
    screen?: string;
    runtime?: TerminalRuntimeIdentity;
  } = {}
): TerminalBridgeStatus {
  const approval = inspection.approval;
  const fingerprint = terminalApprovalFingerprint(
    adapter.agent,
    terminalControl,
    inspection,
    options
  );
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
      cwd: approval.cwd,
      tool_name: approval.toolName,
      request_detail: approval.requestDetail,
      reason: approval.approvable ? undefined : approval.reason,
      fingerprint,
      decision_mode: approval.approvable ? approval.action.mode ?? "keys" : undefined,
      request_id: approval.approvable ? approval.action.requestId : undefined
    },
    screen: {
      excerpt: inspection.screenExcerpt,
      digest: options.screen === undefined
        ? undefined
        : createHash("sha256").update(options.screen).digest("hex"),
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
      command: approval.command,
      cwd: approval.cwd,
      toolName: approval.toolName,
      requestDetail: approval.requestDetail
    };
  }
  return {
    blocked: true,
    approvable: true,
    key: approval.action.keys.length === 1 ? approval.action.keys[0] : undefined,
    keys: approval.action.keys,
    label: approval.action.label,
    promptKind: approval.promptKind,
    command: approval.command,
    cwd: approval.cwd,
    toolName: approval.toolName,
    requestDetail: approval.requestDetail,
    decisionMode: approval.action.mode ?? "keys",
    requestId: approval.action.requestId
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
