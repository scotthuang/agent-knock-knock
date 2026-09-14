import { createHash } from "node:crypto";
import type { ExecutorKind } from "./executors.js";
import {
  formatTerminalConversationId,
  parseTerminalConversationId,
  terminalControlCapabilitiesForAdapter,
  terminalApprovalActionForDecision,
  terminalApprovalChoices,
  type ActiveTerminalProcess,
  type TerminalAgentAdapter,
  type TerminalAgentAdapterCapabilities,
  type TerminalAgentAdapterRegistry,
  type TerminalApprovalAction,
  type TerminalApprovalDecision,
  type TerminalApprovalInspection,
  type TerminalCompletionEvidence,
  type TerminalControlRef,
  type TerminalDurableCompletionRequest,
  type TerminalNativeInspectionObservation,
  type TerminalNativeInspectionObservationRequest,
  type TerminalNativeInspectionPlan,
  type TerminalProcessSnapshot,
  type TerminalRuntimeIdentity,
  type TerminalScreenInspection
} from "./terminal-agent-adapter.js";
import {
  enrichActiveProcessesWithTerminalControl,
  TerminalControlInputNotSentError,
  type TerminalDiscoveryDiagnosticLog,
  type TerminalControlProvider
} from "./terminal-control-provider.js";
import {
  hasCanonicalTerminalEndpoint,
  sameTerminalControlIncarnation,
  terminalEndpointFromControlRef,
  terminalEndpointIdentityKey,
  type TerminalEndpointRef
} from "./terminal-control-ref.js";
import {
  terminalInteractionPublicCompatibilityProjection,
  type TerminalInteractionAnyProjection
} from "./terminal-interaction-protocol.js";
import {
  captureTerminalInteractionRuntimeOffer,
  exactCurrentModelControlSurface,
  TerminalInteractionResponseBridge,
  type TerminalInteractionResponseExecution,
  type TerminalInteractionResponseInput,
  type TerminalInteractionResponseOptions
} from "./terminal-interaction-response-bridge.js";
import {
  discoverTerminalModelOptions,
  inspectTerminalModelControlResidual,
  observeTerminalModelControl,
  planTerminalModelControl,
  probeTerminalModelControl,
  repairTerminalModelControlResidual,
  switchTerminalModel,
  terminalModelControlPlanConforms,
  type TerminalModelCatalog,
  type TerminalModelControlPlan,
  type TerminalModelControlPorts,
  type TerminalModelControlRepairResult,
  type TerminalModelControlResidualObservation,
  type TerminalModelSwitchRequest,
  type TerminalModelSwitchResult
} from "./terminal-model-control.js";
import {
  codexActiveWriterViewerVisible,
  codexBlockingModalVisible,
  currentCodexComposerCapture,
  exactClaudeComposerCapture,
  exactClaudeInjectedPastePlaceholderCapture,
  exactClaudeModelControlComposerCapture,
  exactTerminalComposerCapture,
  inspectCodexAsyncQuestionInputMode
} from "./terminal-composer-classifier.js";
import {
  assertTerminalMutationCapabilities,
  exactCodexReadyStyledComposerCapture,
  isExactClaudeIdleComposer,
  stripTerminalEscapeSequences,
  TerminalNativeInspectionBridge,
  type TerminalCodexStatusProbeResult,
  type TerminalNativeInspectionDismissalOptions,
  type TerminalNativeInspectionDismissalResult,
  type TerminalNativeInspectionOptions,
  type TerminalNativeInspectionResult
} from "./terminal-native-inspection-bridge.js";
import { createTerminalModelControlPorts } from
  "./terminal-model-control-bridge.js";
import {
  CODEX_EXACT_CANDIDATE_GRACE_CAPTURES,
  CODEX_MULTILINE_SETTLE_POLL_MS,
  CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES,
  CODEX_MULTILINE_STABLE_CAPTURES,
  CODEX_PASTE_ENTER_SETTLE_MS,
  TerminalEnterDispatchNotAttemptedError,
  TerminalEnterDispatchReservedError,
  TerminalInputNotStartedError,
  TerminalTextSubmissionBridge,
  type TerminalCodexComposerObservation,
  type TerminalSendOptions,
  type TerminalSendResult
} from "./terminal-text-submission-bridge.js";

export {
  TerminalEnterDispatchNotAttemptedError,
  TerminalEnterDispatchReservedError,
  TerminalInputNotStartedError,
  type TerminalCodexComposerObservation,
  type TerminalSendBoundaryContext,
  type TerminalSendOptions,
  type TerminalSendResult,
  type TerminalTransportStage,
  type TerminalTransportStageEvent
} from "./terminal-text-submission-bridge.js";
export {
  captureTerminalInteractionRuntimeOffer,
  TerminalInteractionDispatchReservedError,
  TerminalInteractionInputNotStartedError,
  type TerminalInteractionAuthorizationContext,
  type TerminalInteractionAuthorizationDecision,
  type TerminalInteractionBeforeDispatchContext,
  type TerminalInteractionReservedStage,
  type TerminalInteractionResponseExecution,
  type TerminalInteractionRuntimeOffer
} from "./terminal-interaction-response-bridge.js";
export {
  inspectCodexAsyncQuestionInputMode,
  type CodexAsyncQuestionInputMode
} from "./terminal-composer-classifier.js";
export {
  exactCodexReadyStyledComposerCapture,
  isExactClaudeIdleComposer,
  isExactClaudeNativeInspectionIdleComposer,
  NativeInspectionDismissalError,
  NativeInspectionSubmissionError,
  type NativeInspectionSubmissionDiagnostic,
  type NativeInspectionSubmissionStage,
  type TerminalCodexStatusProbeResult,
  type TerminalNativeInspectionBeforeDismissContext,
  type TerminalNativeInspectionBeforeEnterContext,
  type TerminalNativeInspectionDismissalOptions,
  type TerminalNativeInspectionDismissalResult,
  type TerminalNativeInspectionMaterializationEvidence,
  type TerminalNativeInspectionMaterializationKind,
  type TerminalNativeInspectionOptions,
  type TerminalNativeInspectionResult
} from "./terminal-native-inspection-bridge.js";
export type TerminalActivityState =
  | "awaiting_approval"
  | "working"
  | "idle"
  | "unknown";

export type TerminalNativeIdentityState =
  | "resolved"
  | "ambiguous"
  | "verified_absent"
  | "unavailable";

export type TerminalDurableActivityState = "working" | "idle" | "unknown";

export interface TerminalBridgeStatus {
  provider: string;
  target: string;
  agent: ExecutorKind;
  reachable: boolean;
  capabilities: Readonly<TerminalAgentAdapterCapabilities>;
  activity_state: TerminalActivityState;
  activity_reason: string;
  /** Raw live-screen classification before durable identity reconciliation. */
  screen_state?: TerminalActivityState;
  /** Adapter evidence for screen_state. */
  screen_reason?: string;
  /** Safe foreground-native-identity summary projected by list/status. */
  native_identity_state?: TerminalNativeIdentityState;
  /** Durable task activity projected from exact native artifacts. */
  durable_activity_state?: TerminalDurableActivityState;
  /** Evidence or limitation for durable_activity_state. */
  durable_activity_reason?: string;
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
    choices?: readonly {
      decision: TerminalApprovalDecision;
      label: string;
      fingerprint: string;
    }[];
    decision_mode?: "keys";
    request_id?: string;
    policy_evidence?: {
      source: "claude_transcript";
      kind: "run_command";
      command_sha256: string;
      evidence_fingerprint: string;
      request_id: string;
    };
  };
  screen: {
    excerpt?: string;
    /** SHA-256 of the raw capture. The raw terminal contents are never exposed here. */
    digest?: string;
    approval?: Record<string, unknown>;
    error?: string;
  };
  /** Safe, semantic current-question projection; never terminal keys. */
  interaction_state?: TerminalInteractionAnyProjection;
  /**
   * Owner-private response fence. Public status renderers must remove this
   * sibling field before returning terminal_status to a model or browser.
   */
  interaction_prompt_fingerprint?: string;
  /** Owner-private cross-observer identity used for Monitor/Watch arbitration. */
  interaction_surface_id?: string;
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
  /** True after either approve_once or reject was dispatched exactly once. */
  decisionDispatched?: boolean;
  decision?: TerminalApprovalDecision;
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
  decisionMode?: "keys";
  requestId?: string;
}

export interface TerminalIdentityVerificationRequest {
  agent: ExecutorKind;
  pid: number;
  terminalControl: TerminalControlRef;
  runtime?: TerminalRuntimeIdentity;
}

export interface TerminalIdentityVerificationResult {
  terminalControl?: TerminalControlRef;
}

export type TerminalIdentityVerifier = (
  request: TerminalIdentityVerificationRequest
) => Promise<TerminalIdentityVerificationResult | void>;

export interface TerminalModelControlBridgeOptions {
  runtime?: TerminalRuntimeIdentity;
  /** Revalidate Store/Turn/current-snapshot authority before every UI step. */
  beforeInput?: () => void | Promise<void>;
  /** Read-only catalog from the exact executable bound to this Codex pane. */
  loadCodexCatalog?: TerminalModelControlPorts["loadCodexCatalog"];
  /** Private, current-snapshot authority to continue one exact `/model`. */
  initialResidual?: Extract<
    TerminalModelControlResidualObservation,
    { state: "recoverable" }
  >;
}

export interface TerminalModelOptionsBridgeResult {
  terminalControl: TerminalControlRef;
  catalog: TerminalModelCatalog;
}

export interface TerminalModelSwitchBridgeResult extends TerminalModelSwitchResult {
  terminalControl: TerminalControlRef;
}

export type TerminalModelControlResidualBridgeResult =
  TerminalModelControlResidualObservation;

export interface TerminalModelControlRepairBridgeResult
  extends Omit<TerminalModelControlRepairResult, "terminalControl"> {
  terminalControl: TerminalControlRef;
}

export interface TerminalCodexDraftSubmissionContext {
  terminalControl: TerminalControlRef;
  text: string;
  composerDigest: string;
}

export interface TerminalCodexDraftSubmissionOptions {
  runtime?: TerminalRuntimeIdentity;
  /**
   * Persist the caller's one-shot Enter reservation after the preliminary
   * stable proof. The bridge then independently recaptures the exact draft
   * before its sole C-m transport call. Invoking this hook consumes the attempt
   * even when the hook or any later step fails.
   */
  beforeEnterReservation: (
    context: TerminalCodexDraftSubmissionContext
  ) => void | Promise<void>;
}

export interface TerminalCodexDraftSubmissionResult {
  stage: "enter_dispatched";
  terminalControl: TerminalControlRef;
  enterCount: 1;
}

export type TerminalCodexUserExplicitSendDisposition =
  | "replaced_current_composer";

export interface TerminalCodexUserExplicitSendReservationContext {
  terminalControl: TerminalControlRef;
  text: string;
}

export interface TerminalCodexUserExplicitSendOptions {
  runtime?: TerminalRuntimeIdentity;
  /** Revalidate caller authority before the first physical mutation. */
  beforeMutationReservation: (
    context: TerminalCodexUserExplicitSendReservationContext
  ) => void | Promise<void>;
  /** Called after the replace path has attempted its sole clear-line key. */
  onComposerClearDispatched?: (
    context: TerminalCodexUserExplicitSendReservationContext
  ) => void | Promise<void>;
  onTransportStage?: TerminalSendOptions["onTransportStage"];
}

export interface TerminalCodexUserExplicitSendResult {
  stage: "enter_dispatched";
  terminalControl: TerminalControlRef;
  disposition: TerminalCodexUserExplicitSendDisposition;
  clearCount: 1;
  textInjectionCount: 1;
  enterCount: 1;
}

export interface TerminalNativeInspectionObservationResult {
  terminalControl: TerminalControlRef;
  status: TerminalBridgeStatus;
  /** Same raw-screen fingerprint format used by adapter stale checks. */
  screenDigest: string;
  observation: TerminalNativeInspectionObservation;
}

export interface TerminalApprovalAuthorizationContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  inspection: TerminalScreenInspection;
  fingerprint?: string;
  decision: TerminalApprovalDecision;
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
  decision: TerminalApprovalDecision;
  keys: readonly string[];
  runtime?: TerminalRuntimeIdentity;
}

type TerminalApprovalPreflight =
  | {
      ready: true;
      action: TerminalApprovalAction;
      decisionMode: "keys";
      fingerprintControl: TerminalControlRef;
      fingerprint?: string;
    }
  | { ready: false; result: TerminalApprovalExecution };

function terminalApprovalPreflight(input: {
  adapter: TerminalAgentAdapter;
  terminalControl: TerminalControlRef;
  activeTerminalControl: TerminalControlRef;
  inspection: TerminalScreenInspection;
  screen: string;
  decision: TerminalApprovalDecision;
  expectedFingerprint?: string;
  requiredDecisionMode?: "keys";
  runtime?: TerminalRuntimeIdentity;
}): TerminalApprovalPreflight {
  const { adapter, inspection, decision } = input;
  if (!inspection.approval.approvable) {
    return { ready: false, result: {
      approved: false,
      blocked: inspection.approval.blocked,
      reason: inspection.approval.reason,
      promptKind: inspection.approval.promptKind,
      command: inspection.approval.command,
      screenExcerpt: inspection.screenExcerpt
    } };
  }
  if (
    decision === "approve_once" &&
    (inspection.approval.action.mode ?? "keys") === "keys" &&
    inspection.approval.action.keys.length === 0
  ) {
    return { ready: false, result: {
      approved: false,
      blocked: true,
      decision,
      reason: `${adapter.displayName} approval action has no keys`,
      label: inspection.approval.action.label,
      promptKind: inspection.approval.promptKind,
      command: inspection.approval.command,
      screenExcerpt: inspection.screenExcerpt
    } };
  }
  const action = terminalApprovalActionForDecision(
    inspection.approval,
    decision
  );
  if (!action) {
    return { ready: false, result: {
      approved: false,
      blocked: true,
      decision,
      reason: `${adapter.displayName} does not expose the ${decision} decision for this exact approval prompt`,
      promptKind: inspection.approval.promptKind,
      command: inspection.approval.command,
      screenExcerpt: inspection.screenExcerpt
    } };
  }
  const decisionMode = action.mode ?? "keys";
  const canonicalFingerprint = terminalApprovalFingerprint(
    adapter.agent,
    input.activeTerminalControl,
    inspection,
    { screen: input.screen, runtime: input.runtime, decision }
  );
  if (
    input.requiredDecisionMode &&
    decisionMode !== input.requiredDecisionMode
  ) {
    return { ready: false, result: {
      approved: false,
      blocked: true,
      reason: `${adapter.displayName} approval mode ${decisionMode} is not eligible for this decision`,
      decision,
      label: action.label,
      promptKind: inspection.approval.promptKind,
      command: inspection.approval.command,
      fingerprint: canonicalFingerprint,
      screenExcerpt: inspection.screenExcerpt,
      decisionMode,
      requestId: action.requestId
    } };
  }
  if (decisionMode === "keys" && action.keys.length === 0) {
    return { ready: false, result: {
      approved: false,
      blocked: true,
      reason: `${adapter.displayName} approval action has no keys`,
      decision,
      label: action.label,
      promptKind: inspection.approval.promptKind,
      command: inspection.approval.command,
      screenExcerpt: inspection.screenExcerpt
    } };
  }
  if (!isTerminalApprovalPromptEvidence(inspection.approval.promptEvidence)) {
    return { ready: false, result: {
      approved: false,
      blocked: true,
      reason: `${adapter.displayName} approval prompt has no adapter-verified prompt evidence`,
      decision,
      label: action.label,
      promptKind: inspection.approval.promptKind,
      command: inspection.approval.command,
      screenExcerpt: inspection.screenExcerpt,
      decisionMode,
      requestId: action.requestId
    } };
  }
  const legacyFingerprint = hasCanonicalTerminalEndpoint(input.terminalControl)
    ? undefined
    : terminalApprovalFingerprint(
        adapter.agent,
        input.terminalControl,
        inspection,
        { screen: input.screen, runtime: input.runtime, decision }
      );
  const useLegacyFingerprint = Boolean(
    input.expectedFingerprint &&
    input.expectedFingerprint === legacyFingerprint
  );
  const fingerprintControl = useLegacyFingerprint
    ? input.terminalControl
    : input.activeTerminalControl;
  const fingerprint = useLegacyFingerprint
    ? legacyFingerprint
    : canonicalFingerprint;
  if (
    adapter.agent === "claude" &&
    !input.expectedFingerprint
  ) {
    return { ready: false, result: {
      approved: false,
      blocked: true,
      reason: "screen approval requires the latest expected fingerprint",
      decision,
      key: action.keys.length === 1 ? action.keys[0] : undefined,
      keys: action.keys,
      label: action.label,
      promptKind: inspection.approval.promptKind,
      command: inspection.approval.command,
      cwd: inspection.approval.cwd,
      toolName: inspection.approval.toolName,
      requestDetail: inspection.approval.requestDetail,
      fingerprint,
      screenExcerpt: inspection.screenExcerpt,
      decisionMode,
      requestId: action.requestId
    } };
  }
  if (
    input.expectedFingerprint &&
    input.expectedFingerprint !== fingerprint
  ) {
    return { ready: false, result: {
      approved: false,
      blocked: true,
      reason: "approval fingerprint changed before execution",
      decision,
      key: action.keys.length === 1 ? action.keys[0] : undefined,
      keys: action.keys,
      label: action.label,
      promptKind: inspection.approval.promptKind,
      command: inspection.approval.command,
      fingerprint,
      screenExcerpt: inspection.screenExcerpt,
      decisionMode,
      requestId: action.requestId
    } };
  }
  return {
    ready: true,
    action,
    decisionMode,
    fingerprintControl,
    fingerprint
  };
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
  private readonly nowMs: () => number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly diagnosticLog?: TerminalDiscoveryDiagnosticLog;

  constructor(options: {
    registry: TerminalAgentAdapterRegistry;
    terminalProvider: TerminalControlProvider;
    verifyIdentity?: TerminalIdentityVerifier;
    nowMs?: () => number;
    now?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
    diagnosticLog?: TerminalDiscoveryDiagnosticLog;
  }) {
    this.registry = options.registry;
    this.terminalProvider = options.terminalProvider;
    this.verifyIdentity = options.verifyIdentity;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? terminalSettleDelay;
    this.diagnosticLog = options.diagnosticLog;
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
          processTree: snapshots,
          diagnosticLog: this.diagnosticLog
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
      processTree: options.processTree,
      diagnosticLog: this.diagnosticLog
    });
  }

  terminalConversationId(process: Pick<ActiveTerminalProcess, "agent" | "pid" | "terminalControl">): string {
    if (!process.terminalControl) {
      throw new Error(`process ${process.pid} is not terminal-controlled`);
    }
    this.registry.require(process.agent);
    const terminal = this.terminalProvider.endpoint(process.terminalControl);
    return formatTerminalConversationId({
      agent: process.agent,
      target: terminal.route.label,
      pid: process.pid,
      kind: terminal.identity.providerKind as "tmux" | "herdr"
    });
  }

  /**
   * Resolve a persisted control reference by stable endpoint identity. This is
   * the managed-Session path: its route-shaped v2 terminal id is only a
   * compatibility alias and may be stale after an explicit provider refresh.
   */
  async resolveStoredTerminal(
    agent: ExecutorKind,
    pid: number,
    terminalControl: TerminalControlRef,
    runtime: TerminalRuntimeIdentity = { pid }
  ): Promise<ResolvedTerminalConversation> {
    const adapter = this.registry.require(agent);
    const freshControl = await this.verifyTerminalIdentity(
      agent,
      terminalControl,
      { ...runtime, pid }
    );
    return {
      conversationId: this.terminalConversationId({
        agent,
        pid,
        terminalControl: freshControl
      }),
      agent,
      pid,
      legacy: false,
      adapter,
      terminalControl: freshControl
    };
  }

  async resolveConversationId(conversationId: string | undefined): Promise<ResolvedTerminalConversation | undefined> {
    const parsed = parseTerminalConversationId(conversationId);
    if (!parsed) {
      return undefined;
    }
    const adapter = this.registry.require(parsed.agent);
    const terminals = await this.terminalProvider.listTerminals();
    const candidates = terminals.filter(
      (candidate) => candidate.identity.providerKind === parsed.kind &&
        candidate.route.label === parsed.target
    );
    const verified = this.verifyIdentity
      ? (await Promise.all(candidates.map(async (terminal) => {
          const terminalControl = this.terminalProvider.toControlRef(
            terminal,
            terminalControlCapabilitiesForAdapter(adapter)
          );
          try {
            const verifiedTerminalControl = await this.verifyTerminalIdentity(
              adapter.agent,
              terminalControl,
              { pid: parsed.pid }
            );
            return { terminal, terminalControl: verifiedTerminalControl };
          } catch {
            return undefined;
          }
        }))).filter((candidate): candidate is {
          terminal: (typeof candidates)[number];
          terminalControl: TerminalControlRef;
        } => candidate !== undefined)
      : candidates.slice(0, 1).map((terminal) => ({
          terminal,
          terminalControl: this.terminalProvider.toControlRef(
            terminal,
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
        runtime: options.runtime,
        now: this.now()
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
        screen_state: "unknown",
        screen_reason: message,
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

  async modelOptions(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    agentVersion: string,
    plan: TerminalModelControlPlan,
    options: TerminalModelControlBridgeOptions = {}
  ): Promise<TerminalModelOptionsBridgeResult> {
    const adapter = this.registry.require(agent);
    assertTerminalModelControlPlan(adapter, terminalControl, agentVersion, plan);
    assertTerminalMutationCapabilities({
      provider: this.terminalProvider,
      terminal: this.terminalProvider.endpoint(terminalControl),
      semantic: ["send_keys", "screen_status"],
      transport: [
        "stable_resource_resolution",
        "screen_capture",
        "ansi_capture",
        "text_delivery",
        "key_delivery"
      ]
    });
    const result = await discoverTerminalModelOptions({
      agent,
      agentVersion,
      plan,
      terminalControl,
      ports: this.modelControlPorts(adapter, plan, options),
      initialResidual: options.initialResidual
    });
    return {
      terminalControl: result.terminalControl as TerminalControlRef,
      catalog: result.catalog
    };
  }

  async setModel(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    agentVersion: string,
    plan: TerminalModelControlPlan,
    expectedCatalogFingerprint: string,
    request: TerminalModelSwitchRequest,
    options: TerminalModelControlBridgeOptions = {}
  ): Promise<TerminalModelSwitchBridgeResult> {
    const adapter = this.registry.require(agent);
    assertTerminalModelControlPlan(adapter, terminalControl, agentVersion, plan);
    assertTerminalMutationCapabilities({
      provider: this.terminalProvider,
      terminal: this.terminalProvider.endpoint(terminalControl),
      semantic: ["send_keys", "screen_status"],
      transport: [
        "stable_resource_resolution",
        "screen_capture",
        "ansi_capture",
        "text_delivery",
        "key_delivery"
      ]
    });
    const result = await switchTerminalModel({
      agent,
      agentVersion,
      plan,
      terminalControl,
      expectedCatalogFingerprint,
      request,
      ports: this.modelControlPorts(adapter, plan, options)
    });
    return {
      ...result,
      terminalControl: result.terminalControl as TerminalControlRef
    };
  }

  async inspectModelControlResidual(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    agentVersion: string,
    plan: TerminalModelControlPlan,
    options: TerminalModelControlBridgeOptions = {}
  ): Promise<TerminalModelControlResidualBridgeResult> {
    const adapter = this.registry.require(agent);
    assertTerminalModelControlPlan(adapter, terminalControl, agentVersion, plan);
    assertTerminalMutationCapabilities({
      provider: this.terminalProvider,
      terminal: this.terminalProvider.endpoint(terminalControl),
      semantic: ["screen_status"],
      transport: ["stable_resource_resolution", "screen_capture", "ansi_capture"]
    });
    return inspectTerminalModelControlResidual({
      plan,
      terminalControl,
      ports: this.modelControlPorts(adapter, plan, options)
    });
  }

  async repairModelControlResidual(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    agentVersion: string,
    plan: TerminalModelControlPlan,
    expectedResidualFingerprint: string,
    options: TerminalModelControlBridgeOptions = {}
  ): Promise<TerminalModelControlRepairBridgeResult> {
    const adapter = this.registry.require(agent);
    assertTerminalModelControlPlan(adapter, terminalControl, agentVersion, plan);
    assertTerminalMutationCapabilities({
      provider: this.terminalProvider,
      terminal: this.terminalProvider.endpoint(terminalControl),
      semantic: ["send_keys", "screen_status"],
      transport: [
        "stable_resource_resolution",
        "screen_capture",
        "ansi_capture",
        "key_delivery"
      ]
    });
    const result = await repairTerminalModelControlResidual({
      plan,
      terminalControl,
      expectedResidualFingerprint,
      ports: this.modelControlPorts(adapter, plan, options)
    });
    return {
      ...result,
      terminalControl: result.terminalControl as TerminalControlRef
    };
  }

  private modelControlPorts(
    adapter: TerminalAgentAdapter,
    plan: TerminalModelControlPlan,
    options: TerminalModelControlBridgeOptions
  ): TerminalModelControlPorts {
    if (!options.beforeInput) {
      throw new Error(
        "terminal model control requires current-snapshot authority before every input"
      );
    }
    return createTerminalModelControlPorts({
      adapter,
      plan,
      runtime: options.runtime,
      beforeInput: options.beforeInput,
      loadCodexCatalog: options.loadCodexCatalog,
      runtimePorts: {
        verifyTerminalIdentity: (agent, control, runtime) =>
          this.verifyTerminalIdentity(agent, control, runtime),
        captureStyled: (control) => this.terminalProvider.capture(
          this.terminalProvider.endpoint(control),
          { scrollbackLines: 160, preserveEscapes: true }
        ),
        sendText: (control, text) => this.terminalProvider.sendText(
          this.terminalProvider.endpoint(control),
          text
        ),
        sendKeys: (control, keys) => this.terminalProvider.sendKeys(
          this.terminalProvider.endpoint(control),
          keys
        ),
        sleep: this.sleep
      },
      classifiers: {
        stripEscapes: stripTerminalEscapeSequences,
        sameIdentity: sameTerminalControlIdentity,
        currentCodexComposer: currentCodexComposerCapture,
        inspectCodexAsyncQuestionInputMode,
        codexActiveWriterViewerVisible,
        isExactClaudeIdleComposer,
        exactClaudeModelControlComposer:
          exactClaudeModelControlComposerCapture,
        exactTerminalComposer: exactTerminalComposerCapture
      }
    });
  }

  private textSubmissionBridge(): TerminalTextSubmissionBridge {
    return new TerminalTextSubmissionBridge({
      runtime: {
        preflight: (terminalControl, operation) => {
          const terminal = this.terminalProvider.endpoint(terminalControl);
          switch (operation) {
            case "send":
              assertTerminalMutationCapabilities({
                provider: this.terminalProvider,
                terminal,
                semantic: ["send_keys"],
                transport: [
                  "stable_resource_resolution",
                  "text_delivery",
                  "key_delivery"
                ]
              });
              return;
            case "send_with_composer":
              assertTerminalMutationCapabilities({
                provider: this.terminalProvider,
                terminal,
                semantic: ["send_keys", "screen_status"],
                transport: [
                  "stable_resource_resolution",
                  "text_delivery",
                  "key_delivery",
                  "screen_capture"
                ]
              });
              return;
            case "observe_composer":
              assertTerminalMutationCapabilities({
                provider: this.terminalProvider,
                terminal,
                semantic: ["screen_status"],
                transport: ["stable_resource_resolution", "screen_capture"]
              });
          }
        },
        verifyIdentity: (agent, control, runtime) =>
          this.verifyTerminalIdentity(agent, control, runtime),
        captureInspection: (adapter, control, options) =>
          this.captureInspection(adapter, control, options),
        captureStyled: (control) => this.terminalProvider.capture(
          this.terminalProvider.endpoint(control),
          {
            scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES,
            preserveEscapes: true
          }
        ),
        deliverText: (control, text) => this.terminalProvider.sendText(
          this.terminalProvider.endpoint(control),
          text
        ),
        dispatchEnter: (control) => this.terminalProvider.sendKeys(
          this.terminalProvider.endpoint(control),
          ["C-m"]
        ),
        nowMs: () => this.nowMs(),
        sleep: (milliseconds) => this.sleep(milliseconds)
      },
      classifiers: {
        sameIdentity: sameTerminalControlIdentity,
        stripEscapes: stripTerminalEscapeSequences,
        codexBlockingModalVisible,
        inspectCodexAsyncQuestionInputMode,
        currentCodexComposer: currentCodexComposerCapture,
        exactTerminalComposer: exactTerminalComposerCapture,
        exactClaudeComposer: exactClaudeComposerCapture,
        exactClaudeInjectedPastePlaceholder:
          exactClaudeInjectedPastePlaceholderCapture
      }
    });
  }

  private interactionResponseBridge(): TerminalInteractionResponseBridge {
    return new TerminalInteractionResponseBridge(
      this.terminalProvider,
      {
        captureInspection: (agent, control, runtime, scrollbackLines) =>
          this.captureInspection(this.registry.require(agent), control, {
            runtime,
            scrollbackLines
          }),
        verifyIdentity: (agent, control, runtime) =>
          this.verifyTerminalIdentity(agent, control, runtime),
        now: () => this.now(),
        sleep: (milliseconds) => this.sleep(milliseconds)
      }
    );
  }

  private nativeInspectionBridge(): TerminalNativeInspectionBridge<
    TerminalBridgeStatus
  > {
    return new TerminalNativeInspectionBridge({
      registry: this.registry,
      terminalProvider: this.terminalProvider,
      runtime: {
        captureInspection: (adapter, control, options) =>
          this.captureInspection(adapter, control, options),
        verifyIdentity: (agent, control, runtime) =>
          this.verifyTerminalIdentity(agent, control, runtime),
        statusFromInspection: (adapter, control, inspection, options) =>
          statusFromInspection(adapter, control, inspection, options),
        nowMs: () => this.nowMs(),
        sleep: (milliseconds) => this.sleep(milliseconds)
      }
    });
  }

  async send(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    text: string,
    options: TerminalSendOptions = {}
  ): Promise<TerminalSendResult> {
    const adapter = this.registry.require(agent);
    return this.textSubmissionBridge().send(
      adapter,
      terminalControl,
      text,
      options
    );
  }

  /** Observe only the current, live Codex composer without exposing its text. */
  async observeCodexComposer(
    terminalControl: TerminalControlRef,
    expectedText: string,
    options: { runtime?: TerminalRuntimeIdentity } = {}
  ): Promise<TerminalCodexComposerObservation> {
    const adapter = this.registry.require("codex");
    return this.textSubmissionBridge().observeCodexComposer(
      adapter,
      terminalControl,
      expectedText,
      options.runtime
    );
  }

  /**
   * Honor one explicit user Send against the current Codex terminal. The
   * rendered Composer is not authority: clear the current draft once, inject
   * the user's request, cross Codex's paste-suppression window, and press Enter
   * once. Approval/modal and terminal identity remain hard pre-mutation gates.
   * This primitive is intentionally not used by autonomous managed sends.
   */
  async sendUserExplicitCodex(
    terminalControl: TerminalControlRef,
    text: string,
    options: TerminalCodexUserExplicitSendOptions
  ): Promise<TerminalCodexUserExplicitSendResult> {
    const adapter = this.registry.require("codex");
    const normalized = text.trimEnd();
    const multiline = /[\r\n]/u.test(normalized);
    if (!normalized) {
      throw new TerminalInputNotStartedError("terminal message is empty");
    }
    try {
      assertTerminalMutationCapabilities({
        provider: this.terminalProvider,
        terminal: this.terminalProvider.endpoint(terminalControl),
        semantic: ["send_keys", "screen_status"],
        transport: [
          "stable_resource_resolution",
          "screen_capture",
          "text_delivery",
          "key_delivery"
        ]
      });
    } catch (error) {
      throw new TerminalInputNotStartedError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }
    const notStarted = (error: unknown, prefix?: string) =>
      error instanceof TerminalInputNotStartedError
        ? error
        : new TerminalInputNotStartedError(
          `${prefix ? `${prefix}: ` : ""}${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        );
    const uncertain = (message: string, error: unknown) =>
      error instanceof TerminalEnterDispatchReservedError
        ? error
        : new TerminalEnterDispatchReservedError(message, { cause: error });

    const captureSafePrompt = async (
      control: TerminalControlRef
    ): Promise<TerminalControlRef> => {
      try {
        const captured = await this.captureInspection(
          adapter,
          control,
          {
            runtime: options.runtime,
            // Approval/modal authority belongs to the current viewport. Do
            // not let historical Esc instructions in scrollback veto Send.
            scrollbackLines: 0
          }
        );
        const asyncQuestionInputMode = inspectCodexAsyncQuestionInputMode(
          captured.screen
        );
        if (
          asyncQuestionInputMode === "expanded" ||
          asyncQuestionInputMode === "ambiguous"
        ) {
          throw new Error(
            asyncQuestionInputMode === "expanded"
              ? "the Codex async question editor currently owns terminal input; answer, skip, or return to the main prompt before retrying the explicit user Send"
              : "Codex shows an async-question surface but AKK cannot prove that the main prompt owns terminal input; return to a complete main prompt before retrying the explicit user Send"
          );
        }
        if (
          captured.inspection.approval.blocked ||
          captured.inspection.activity.state === "awaiting_approval" ||
          codexBlockingModalVisible(captured.screen)
        ) {
          throw new Error(
            "the explicit user Send is blocked by a Codex approval or modal prompt"
          );
        }
        const verified = await this.verifyTerminalIdentity(
          adapter.agent,
          captured.terminalControl,
          options.runtime
        );
        if (!sameTerminalControlIdentity(captured.terminalControl, verified)) {
          throw new Error(
            "terminal identity changed across the explicit Send approval scan"
          );
        }
        return verified;
      } catch (error) {
        throw notStarted(error);
      }
    };

    const initiallySafe = await captureSafePrompt(terminalControl);
    const reservationContext: TerminalCodexUserExplicitSendReservationContext = {
      terminalControl: initiallySafe,
      text: normalized
    };
    try {
      await options.beforeMutationReservation(reservationContext);
    } catch (error) {
      throw notStarted(error);
    }

    // The reservation callback may await Store or terminal locks. Recapture
    // only approval/modal and identity authority immediately before the first
    // physical mutation; Composer visibility and contents are never a veto.
    const verifiedForClear = await captureSafePrompt(initiallySafe);
    let clearEndpoint: TerminalEndpointRef;
    try {
      clearEndpoint = this.terminalProvider.endpoint(verifiedForClear);
    } catch (error) {
      throw notStarted(error);
    }
    try {
      await this.terminalProvider.sendKeys(clearEndpoint, ["C-u"]);
    } catch (error) {
      if (error instanceof TerminalControlInputNotSentError) {
        throw notStarted(error);
      }
      throw uncertain(
        "explicit Codex draft-clear outcome is uncertain; do not retry automatically",
        error
      );
    }

    let postMutationHookError: unknown;
    try {
      await options.onComposerClearDispatched?.({
        terminalControl: verifiedForClear,
        text: normalized
      });
    } catch (error) {
      postMutationHookError = error;
    }

    let verifiedForText: TerminalControlRef;
    try {
      verifiedForText = await this.verifyTerminalIdentity(
        adapter.agent,
        verifiedForClear,
        options.runtime
      );
      if (!sameTerminalControlIdentity(verifiedForClear, verifiedForText)) {
        throw new Error("terminal identity changed after clearing the Composer");
      }
      await this.terminalProvider.sendText(
        this.terminalProvider.endpoint(verifiedForText),
        normalized
      );
    } catch (error) {
      throw uncertain(
        "explicit Codex replacement text outcome is uncertain after clearing the prior draft; do not retry automatically",
        error
      );
    }

    const textInjectedAt = this.nowMs();
    try {
      try {
        await options.onTransportStage?.({
          stage: "text_injected",
          agent: adapter.agent,
          terminalControl: verifiedForText,
          multiline
        });
      } catch (error) {
        postMutationHookError ??= error;
      }
      await this.sleep(Math.max(
        0,
        CODEX_PASTE_ENTER_SETTLE_MS - (this.nowMs() - textInjectedAt)
      ));
    } catch (error) {
      throw uncertain(
        "explicit Codex text was injected but its Enter outcome is unresolved; do not retry automatically",
        error
      );
    }

    let verifiedForEnter: TerminalControlRef;
    try {
      verifiedForEnter = await this.verifyTerminalIdentity(
        adapter.agent,
        verifiedForText,
        options.runtime
      );
      if (!sameTerminalControlIdentity(verifiedForText, verifiedForEnter)) {
        throw new Error("terminal identity changed before explicit Send Enter");
      }
    } catch (error) {
      throw uncertain(
        "explicit Codex Enter endpoint is unresolved after terminal input; do not retry automatically",
        error
      );
    }

    try {
      await this.terminalProvider.sendKeys(
        this.terminalProvider.endpoint(verifiedForEnter),
        ["C-m"]
      );
    } catch (error) {
      throw uncertain(
        "explicit Codex Send Enter outcome is uncertain; do not retry automatically",
        error
      );
    }
    try {
      try {
        await options.onTransportStage?.({
          stage: "enter_dispatched",
          agent: adapter.agent,
          terminalControl: verifiedForEnter,
          multiline
        });
      } catch (error) {
        postMutationHookError ??= error;
      }
      if (postMutationHookError !== undefined) {
        throw postMutationHookError;
      }
    } catch (error) {
      throw uncertain(
        "explicit Codex Send Enter was dispatched but its post-mutation acknowledgement failed; do not retry automatically",
        error
      );
    }

    return {
      stage: "enter_dispatched",
      terminalControl: verifiedForEnter,
      disposition: "replaced_current_composer",
      clearCount: 1,
      textInjectionCount: 1,
      enterCount: 1
    };
  }

  /**
   * Submit one already-present exact Codex draft. This primitive never writes
   * text, clears the composer, or emits C-c, and contains exactly one C-m call.
   */
  async submitExactCodexDraft(
    terminalControl: TerminalControlRef,
    expectedText: string,
    options: TerminalCodexDraftSubmissionOptions
  ): Promise<TerminalCodexDraftSubmissionResult> {
    const adapter = this.registry.require("codex");
    const textSubmission = this.textSubmissionBridge();
    const normalized = expectedText.trimEnd();
    if (!normalized) {
      throw new TerminalEnterDispatchNotAttemptedError(
        "expected Codex draft is empty"
      );
    }
    let preliminaryObservation: Extract<
      TerminalCodexComposerObservation,
      { state: "exact_draft" }
    >;
    try {
      assertTerminalMutationCapabilities({
        provider: this.terminalProvider,
        terminal: this.terminalProvider.endpoint(terminalControl),
        semantic: ["send_keys", "screen_status"],
        transport: [
          "stable_resource_resolution",
          "screen_capture",
          "key_delivery"
        ]
      });
      const observation = await textSubmission.settleCodexComposerObservation(
        adapter,
        terminalControl,
        normalized,
        options.runtime,
        {
          minimumStableMs: CODEX_PASTE_ENTER_SETTLE_MS,
          requiredState: "exact_draft"
        }
      );
      if (observation.state !== "exact_draft") {
        const reason = "reason" in observation
          ? observation.reason
          : `Codex composer is ${observation.state}`;
        throw new Error(
          `refusing to submit an unproven exact Codex draft: ${reason}`
        );
      }
      preliminaryObservation = observation;
    } catch (error) {
      if (error instanceof TerminalEnterDispatchNotAttemptedError) {
        throw error;
      }
      throw new TerminalEnterDispatchNotAttemptedError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }

    let finalObservation: {
      state: "exact_draft";
      terminalControl: TerminalControlRef;
      digest: string;
    };
    try {
      // Calling this hook is itself the one-shot boundary. A throw may occur
      // after durable storage committed, so every failure from here onward
      // permanently consumes the attempt.
      await options.beforeEnterReservation({
        terminalControl: preliminaryObservation.terminalControl,
        text: normalized,
        composerDigest: preliminaryObservation.digest
      });
      const recaptured = await textSubmission.captureCodexComposerSnapshot(
        adapter,
        preliminaryObservation.terminalControl,
        normalized,
        options.runtime
      );
      if (
        recaptured.state !== "exact_draft" ||
        recaptured.digest !== preliminaryObservation.digest ||
        !sameTerminalControlIdentity(
          preliminaryObservation.terminalControl,
          recaptured.terminalControl
        )
      ) {
        const reason = "reason" in recaptured
          ? recaptured.reason
          : `Codex composer is ${recaptured.state}`;
        throw new Error(
          `reserved Codex draft changed before Enter: ${reason}`
        );
      }
      finalObservation = recaptured;
    } catch (error) {
      if (error instanceof TerminalEnterDispatchReservedError) {
        throw error;
      }
      throw new TerminalEnterDispatchReservedError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }
    try {
      await this.terminalProvider.sendKeys(
        this.terminalProvider.endpoint(finalObservation.terminalControl),
        ["C-m"]
      );
    } catch (error) {
      throw new TerminalEnterDispatchReservedError(
        "reserved Codex Enter dispatch outcome is uncertain; do not retry",
        { cause: error }
      );
    }
    return {
      stage: "enter_dispatched",
      terminalControl: finalObservation.terminalControl,
      enterCount: 1
    };
  }

  /**
   * Submit one closed, adapter-owned native inspection command.
   *
   * This intentionally does not use `send()`: native slash commands need a
   * stricter composer proof, and failures after text injection must leave the
   * draft untouched instead of issuing the legacy best-effort C-u cleanup.
   */
  async submitNativeInspection(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    plan: TerminalNativeInspectionPlan,
    options: TerminalNativeInspectionOptions = {}
  ): Promise<TerminalNativeInspectionResult> {
    return this.nativeInspectionBridge().submitNativeInspection(
      agent,
      terminalControl,
      plan,
      options
    );
  }

  /**
   * Submit Codex's closed, version-profiled `/status` probe.
   *
   * Unlike the generic native-inspection entry point, callers provide only
   * the detected Codex version, never a command or plan.
   */
  async submitCodexStatusProbe(
    terminalControl: TerminalControlRef,
    agentVersion: string,
    options: TerminalNativeInspectionOptions = {}
  ): Promise<TerminalCodexStatusProbeResult> {
    return this.nativeInspectionBridge().submitCodexStatusProbe(
      terminalControl,
      agentVersion,
      options
    );
  }

  async observeNativeInspection(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    request: TerminalNativeInspectionObservationRequest,
    options: {
      runtime?: TerminalRuntimeIdentity;
      scrollbackLines?: number;
    } = {}
  ): Promise<TerminalNativeInspectionObservationResult> {
    return this.nativeInspectionBridge().observeNativeInspection(
      agent,
      terminalControl,
      request,
      options
    );
  }

  /**
   * Dismiss one exact adapter-owned modal result after re-observing the same
   * evidence under the terminal identity fence. There is exactly one key
   * attempt and no automated retry across an uncertain dismissal boundary.
   */
  async dismissNativeInspection(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    plan: TerminalNativeInspectionPlan,
    request: TerminalNativeInspectionObservationRequest,
    expectedEvidenceFingerprint: string,
    options: TerminalNativeInspectionDismissalOptions = {}
  ): Promise<TerminalNativeInspectionDismissalResult> {
    return this.nativeInspectionBridge().dismissNativeInspection(
      agent,
      terminalControl,
      plan,
      request,
      expectedEvidenceFingerprint,
      options
    );
  }

  /**
   * Prove that the exact managed draft is still present after Enter dispatch.
   * Two identity-fenced captures are required so transient repaint state never
   * becomes a hard `not_accepted` conclusion.
   */
  async proveExactDraftStillPresent(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    expectedText: string,
    options: { runtime?: TerminalRuntimeIdentity; scrollbackLines?: number } = {}
  ): Promise<boolean> {
    const adapter = this.registry.require(agent);
    const captureExactDraft = async (control: TerminalControlRef) => {
      const captured = await this.captureInspection(adapter, control, {
        runtime: options.runtime,
        scrollbackLines: options.scrollbackLines ??
          CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
      });
      if (
        captured.inspection.approval.blocked ||
        captured.inspection.activity.state === "awaiting_approval" ||
        captured.inspection.activity.state === "working"
      ) {
        return { captured, draft: undefined };
      }
      return {
        captured,
        draft: exactTerminalComposerCapture(
          adapter.agent,
          captured.screen,
          expectedText
        )
      };
    };

    const first = await captureExactDraft(terminalControl);
    if (!first.draft) {
      return false;
    }
    await this.sleep(CODEX_MULTILINE_SETTLE_POLL_MS);
    const second = await captureExactDraft(first.captured.terminalControl);
    if (
      !sameTerminalControlIdentity(
        first.captured.terminalControl,
        second.captured.terminalControl
      )
    ) {
      throw new Error(
        "terminal control identity changed while proving the exact draft remained"
      );
    }
    return Boolean(second.draft && second.draft.digest === first.draft.digest);
  }

  /**
   * Clear a terminal composer's current input without submitting it. This is
   * intentionally narrower than arbitrary key dispatch and always revalidates
   * the exact terminal/process identity first.
   */
  async clearInputLine(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    options: { runtime?: TerminalRuntimeIdentity } = {}
  ): Promise<void> {
    const adapter = this.registry.require(agent);
    assertTerminalMutationCapabilities({
      provider: this.terminalProvider,
      terminal: this.terminalProvider.endpoint(terminalControl),
      semantic: ["send_keys"],
      transport: ["stable_resource_resolution", "key_delivery"]
    });
    const verified = await this.verifyTerminalIdentity(
      adapter.agent,
      terminalControl,
      options.runtime
    );
    await this.terminalProvider.sendKeys(
      this.terminalProvider.endpoint(verified),
      ["C-u"]
    );
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
      terminalControl.capabilities.includes("terminal_approval") &&
      adapter.capabilities.screenStatus &&
      terminalControl.capabilities.includes("screen_status")
    ) {
      const captured = await this.captureInspection(adapter, terminalControl, options);
      const { inspection } = captured;
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
    assertTerminalMutationCapabilities({
      provider: this.terminalProvider,
      terminal: this.terminalProvider.endpoint(terminalControl),
      semantic: ["terminal_cancel", "send_keys"],
      transport: ["stable_resource_resolution", "key_delivery"]
    });
    const verifiedForCancel = await this.verifyTerminalIdentity(
      adapter.agent,
      terminalControl,
      options.runtime
    );
    await this.terminalProvider.sendKeys(
      this.terminalProvider.endpoint(verifiedForCancel),
      adapter.cancelKeys
    );
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
      decision?: TerminalApprovalDecision;
      expectedFingerprint?: string;
      scrollbackLines?: number;
      runtime?: TerminalRuntimeIdentity;
      managedRequest?: TerminalDurableCompletionRequest;
      requiredDecisionMode?: "keys";
      authorize?: (
        context: TerminalApprovalAuthorizationContext
      ) => TerminalApprovalAuthorizationDecision | Promise<TerminalApprovalAuthorizationDecision>;
      /**
       * Persist an at-most-once dispatch reservation after authorization. The
       * bridge then recaptures the prompt and revalidates terminal identity
       * before tmux receives the approval keys.
       */
      beforeKeyDispatch?: (
        context: TerminalApprovalKeyDispatchContext
      ) => void | Promise<void>;
    } = {}
  ): Promise<TerminalApprovalExecution> {
    const adapter = this.registry.require(agent);
    const decision = options.decision ?? "approve_once";
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
    assertTerminalMutationCapabilities({
      provider: this.terminalProvider,
      terminal: this.terminalProvider.endpoint(terminalControl),
      semantic: ["screen_status", "terminal_approval", "send_keys"],
      transport: [
        "stable_resource_resolution",
        "screen_capture",
        "key_delivery"
      ]
    });
    const captured = await this.captureInspection(adapter, terminalControl, options);
    const { inspection } = captured;
    const activeTerminalControl = captured.terminalControl;
    const preflight = terminalApprovalPreflight({
      adapter,
      terminalControl,
      activeTerminalControl,
      inspection,
      screen: captured.screen,
      decision,
      expectedFingerprint: options.expectedFingerprint,
      requiredDecisionMode: options.requiredDecisionMode,
      runtime: options.runtime
    });
    if (!preflight.ready) return preflight.result;
    const { action, decisionMode, fingerprintControl, fingerprint } = preflight;
    if (options.authorize) {
      const authorization = await options.authorize({
        agent: adapter.agent,
        terminalControl: activeTerminalControl,
        inspection,
        fingerprint,
        decision,
        runtime: options.runtime
      });
      if (!authorization.approved) {
        return {
          approved: false,
          blocked: true,
          reason: authorization.reason ?? "approval was not authorized",
          decision,
          key: action.keys.length === 1
            ? action.keys[0]
            : undefined,
          keys: action.keys,
          label: action.label,
          promptKind: inspection.approval.promptKind,
          command: inspection.approval.command,
          toolName: inspection.approval.toolName,
          requestDetail: inspection.approval.requestDetail,
          fingerprint,
          screenExcerpt: inspection.screenExcerpt,
          decisionMode,
          requestId: action.requestId
        };
      }
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
    const recapturedAction = terminalApprovalActionForDecision(
      recapturedInspection.approval,
      decision
    );
    if (!recapturedAction) {
      return {
        approved: false,
        blocked: true,
        decision,
        reason: `the ${decision} decision is no longer available after authorization`,
        promptKind: recapturedInspection.approval.promptKind,
        screenExcerpt: recapturedInspection.screenExcerpt
      };
    }
    const recapturedDecisionMode = recapturedAction.mode ?? "keys";
    const recapturedFingerprint = terminalApprovalFingerprint(
      adapter.agent,
      fingerprintControl,
      recapturedInspection,
      {
        screen: recaptured.screen,
        runtime: options.runtime,
        decision
      }
    );
    if (recapturedDecisionMode !== decisionMode) {
      return {
        approved: false,
        blocked: true,
        reason: "approval decision mode changed after authorization",
        decision,
        key: recapturedAction.keys.length === 1
          ? recapturedAction.keys[0]
          : undefined,
        keys: recapturedAction.keys,
        label: recapturedAction.label,
        promptKind: recapturedInspection.approval.promptKind,
        command: recapturedInspection.approval.command,
        cwd: recapturedInspection.approval.cwd,
        toolName: recapturedInspection.approval.toolName,
        requestDetail: recapturedInspection.approval.requestDetail,
        fingerprint: recapturedFingerprint,
        screenExcerpt: recapturedInspection.screenExcerpt,
        decisionMode: recapturedDecisionMode,
        requestId: recapturedAction.requestId
      };
    }
    if (recapturedFingerprint !== fingerprint) {
      return {
        approved: false,
        blocked: true,
        reason: "approval fingerprint changed after authorization",
        decision,
        key: recapturedAction.keys.length === 1
          ? recapturedAction.keys[0]
          : undefined,
        keys: recapturedAction.keys,
        label: recapturedAction.label,
        promptKind: recapturedInspection.approval.promptKind,
        command: recapturedInspection.approval.command,
        cwd: recapturedInspection.approval.cwd,
        toolName: recapturedInspection.approval.toolName,
        requestDetail: recapturedInspection.approval.requestDetail,
        fingerprint: recapturedFingerprint,
        screenExcerpt: recapturedInspection.screenExcerpt,
        decisionMode: recapturedDecisionMode,
        requestId: recapturedAction.requestId
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
      decision,
      keys: recapturedAction.keys,
      runtime: options.runtime
    });
    let dispatchTerminalControl = verifiedForApproval;
    let dispatchInspection = recapturedInspection;
    let dispatchAction = recapturedAction;
    if (options.beforeKeyDispatch) {
      const afterReservation = await this.captureInspection(
        adapter,
        verifiedForApproval,
        options
      );
      const afterReservationInspection = afterReservation.inspection;
      if (!afterReservationInspection.approval.approvable) {
        return {
          approved: false,
          blocked: true,
          reason: "approval prompt is no longer approvable after dispatch reservation",
          promptKind: afterReservationInspection.approval.promptKind,
          command: afterReservationInspection.approval.command,
          cwd: afterReservationInspection.approval.cwd,
          toolName: afterReservationInspection.approval.toolName,
          requestDetail: afterReservationInspection.approval.requestDetail,
          screenExcerpt: afterReservationInspection.screenExcerpt
        };
      }
      const afterReservationAction = terminalApprovalActionForDecision(
        afterReservationInspection.approval,
        decision
      );
      if (!afterReservationAction) {
        return {
          approved: false,
          blocked: true,
          decision,
          reason: `the ${decision} decision is no longer available after dispatch reservation`,
          promptKind: afterReservationInspection.approval.promptKind,
          screenExcerpt: afterReservationInspection.screenExcerpt
        };
      }
      const afterReservationMode = afterReservationAction.mode ?? "keys";
      const afterReservationFingerprint = terminalApprovalFingerprint(
        adapter.agent,
        fingerprintControl,
        afterReservationInspection,
        {
          screen: afterReservation.screen,
          runtime: options.runtime,
          decision
        }
      );
      if (
        afterReservationMode !== "keys" ||
        afterReservationFingerprint !== recapturedFingerprint
      ) {
        return {
          approved: false,
          blocked: true,
          decision,
          reason: "approval fingerprint changed after dispatch reservation",
          key: afterReservationAction.keys.length === 1
            ? afterReservationAction.keys[0]
            : undefined,
          keys: afterReservationAction.keys,
          label: afterReservationAction.label,
          promptKind: afterReservationInspection.approval.promptKind,
          command: afterReservationInspection.approval.command,
          cwd: afterReservationInspection.approval.cwd,
          toolName: afterReservationInspection.approval.toolName,
          requestDetail: afterReservationInspection.approval.requestDetail,
          fingerprint: afterReservationFingerprint,
          screenExcerpt: afterReservationInspection.screenExcerpt,
          decisionMode: afterReservationMode,
          requestId: afterReservationAction.requestId
        };
      }
      dispatchTerminalControl = afterReservation.terminalControl;
      dispatchInspection = afterReservationInspection;
      dispatchAction = afterReservationAction;
    }
    if (!dispatchInspection.approval.approvable) {
      return {
        approved: false,
        blocked: true,
        reason: "approval prompt lost its approvable state before terminal dispatch",
        screenExcerpt: dispatchInspection.screenExcerpt
      };
    }
    const dispatchApproval = dispatchInspection.approval;
    const verifiedImmediatelyBeforeSend = await this.verifyTerminalIdentity(
      adapter.agent,
      dispatchTerminalControl,
      options.runtime
    );
    if (
      !sameTerminalControlIdentity(
        dispatchTerminalControl,
        verifiedImmediatelyBeforeSend
      )
    ) {
      throw new Error(
        "terminal control identity changed after the final approval capture"
      );
    }
    await this.terminalProvider.sendKeys(
      this.terminalProvider.endpoint(verifiedImmediatelyBeforeSend),
      dispatchAction.keys
    );
    return {
      approved: decision === "approve_once",
      decisionDispatched: true,
      decision,
      blocked: false,
      key: dispatchAction.keys.length === 1
        ? dispatchAction.keys[0]
        : undefined,
      keys: dispatchAction.keys,
      label: dispatchAction.label,
      promptKind: dispatchApproval.promptKind,
      command: dispatchApproval.command,
      cwd: dispatchApproval.cwd,
      fingerprint: recapturedFingerprint,
      screenExcerpt: dispatchInspection.screenExcerpt,
      decisionMode: recapturedDecisionMode,
      requestId: dispatchAction.requestId
    };
  }

  async respondInteraction(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    response: TerminalInteractionResponseInput,
    options: TerminalInteractionResponseOptions
  ): Promise<TerminalInteractionResponseExecution> {
    return this.interactionResponseBridge().respond(
      agent,
      terminalControl,
      response,
      options
    );
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
          {
            ...options.screenOptions,
            managedRequest: options.durableRequest
          }
        );
        inspection = captured.inspection;
        status = statusFromInspection(adapter, captured.terminalControl, inspection, {
          screen: captured.screen,
          runtime: options.screenOptions?.runtime,
          now: this.now()
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
      managedRequest?: TerminalDurableCompletionRequest;
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
    const screen = await this.terminalProvider.capture(
      this.terminalProvider.endpoint(verifiedTerminalControl),
      { scrollbackLines: options.scrollbackLines ?? 120 }
    );
    return {
      terminalControl: verifiedTerminalControl,
      screen,
      inspection: adapter.inspectScreen({
        screen,
        requestText: options.requestText,
        screenChangedSinceSend: options.screenChangedSinceSend,
        maxExcerptLength: options.maxExcerptLength,
        runtime: options.runtime,
        managedRequest: options.managedRequest
      })
    };
  }


  private async verifyTerminalIdentity(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime?: TerminalRuntimeIdentity
  ): Promise<TerminalControlRef> {
    let verifiedControl = terminalControl;
    if (this.verifyIdentity) {
      if (!Number.isInteger(runtime?.pid) || Number(runtime?.pid) <= 0) {
        throw new Error(
          `refusing terminal access for ${agent}:${terminalControl.target} without an exact agent pid; reattach this legacy tmux session before controlling it`
        );
      }
      const result = await this.verifyIdentity({
        agent,
        pid: Number(runtime?.pid),
        terminalControl,
        runtime
      });
      verifiedControl = result?.terminalControl ?? terminalControl;
      if (!sameTerminalControlIncarnation(terminalControl, verifiedControl)) {
        throw new Error(
          "terminal control identity changed during identity verification"
        );
      }
    }

    const verifiedEndpoint = this.terminalProvider.endpoint(verifiedControl);
    const resolvedEndpoint = await this.terminalProvider.resolve(
      verifiedEndpoint
    );
    if (
      hasCanonicalTerminalEndpoint(verifiedControl) &&
      !sameTerminalControlIncarnation(verifiedEndpoint, resolvedEndpoint)
    ) {
      throw new Error(
        "terminal stable resource or process anchor changed during fresh resolution"
      );
    }
    return this.terminalProvider.toControlRef(
      resolvedEndpoint,
      verifiedControl.capabilities
    );
  }
}



async function terminalSettleDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function sameTerminalControlIdentity(
  left: TerminalControlRef,
  right: TerminalControlRef
): boolean {
  return sameTerminalControlIncarnation(left, right);
}

export function terminalApprovalFingerprint(
  agent: ExecutorKind,
  terminalControl: TerminalControlRef,
  inspection: TerminalScreenInspection,
  options: {
    screen?: string;
    runtime?: TerminalRuntimeIdentity;
    decision?: TerminalApprovalDecision;
  } = {}
): string | undefined {
  if (!inspection.approval.approvable) {
    return undefined;
  }
  const decision = options.decision ?? "approve_once";
  const choices = terminalApprovalChoices(inspection.approval);
  const action = terminalApprovalActionForDecision(
    inspection.approval,
    decision
  );
  if (!action) {
    return undefined;
  }
  const decisionMode = action.mode ?? "keys";
  const promptEvidence = inspection.approval.promptEvidence;
  if (
    decisionMode === "keys" &&
    !isTerminalApprovalPromptEvidence(promptEvidence)
  ) {
    return undefined;
  }
  const terminal = terminalEndpointFromControlRef(terminalControl);
  // Legacy control records without canonical endpoint evidence bind v2 to
  // their exact stored tmux coordinates. A fresh canonical capture upgrades
  // new fingerprints to stable endpoint identity; v1 fingerprints are never
  // recomputed or accepted here.
  const terminalFingerprint = hasCanonicalTerminalEndpoint(terminalControl)
    ? {
        identity: terminalEndpointIdentityKey(terminal),
        process_anchor_pid: terminal.processAnchorPid
      }
    : terminalControl.kind === "tmux" ? {
        target: terminalControl.target,
        socket_path: terminalControl.socketPath,
        session: terminalControl.session,
        window: terminalControl.window,
        pane: terminalControl.pane,
        pane_pid: terminalControl.panePid
      } : undefined;
  if (!terminalFingerprint) {
    return undefined;
  }
  return createHash("sha256")
    .update(JSON.stringify({
      version: 2,
      agent,
      provider: terminal.identity.providerKind,
      terminal: terminalFingerprint,
      runtime: {
        pid: options.runtime?.pid,
        session_id: options.runtime?.sessionId,
        native_session_id: options.runtime?.nativeSessionId,
        native_process_uuid: options.runtime?.nativeProcessUuid,
        native_process_birth: options.runtime?.nativeProcessBirth,
        require_native_process_uuid:
          options.runtime?.requireNativeProcessUuid,
        require_exact_claude_agent_row:
          options.runtime?.requireExactClaudeAgentRow,
        native_process_started_at:
          options.runtime?.nativeProcessStartedAt,
        exact_claude_agent_state:
          options.runtime?.exactClaudeAgentState,
        require_native_rollout_identity:
          options.runtime?.requireNativeRolloutIdentity,
        native_rollout: options.runtime?.nativeRollout,
        expected_native_session_id:
          options.runtime?.expectedNativeSessionId,
        expected_empty_native_session:
          options.runtime?.expectedEmptyNativeSession,
        allowed_pre_materialization_native_identity:
          options.runtime?.allowedPreMaterializationNativeIdentity,
        allowed_additional_native_identities:
          options.runtime?.allowedAdditionalNativeIdentities,
        cwd: options.runtime?.cwd,
        conversation_id: options.runtime?.conversationId,
        message_id: options.runtime?.messageId,
        terminal_target: options.runtime?.terminalTarget
      },
      decision,
      keys: action.keys,
      label: action.label,
      available_choices: choices.map((choice) => ({
        decision: choice.decision,
        keys: choice.keys,
        label: choice.label,
        mode: choice.mode ?? "keys",
        request_id: choice.requestId
      })),
      prompt_kind: inspection.approval.promptKind,
      command: inspection.approval.command,
      cwd: inspection.approval.cwd,
      tool_name: inspection.approval.toolName,
      request_detail: inspection.approval.requestDetail,
      policy_evidence: inspection.approval.policyEvidence
        ? {
            source: inspection.approval.policyEvidence.source,
            kind: inspection.approval.policyEvidence.kind,
            command_sha256: inspection.approval.policyEvidence.commandSha256,
            evidence_fingerprint:
              inspection.approval.policyEvidence.evidenceFingerprint,
            request_id: inspection.approval.policyEvidence.requestId,
            metadata: inspection.approval.policyEvidence.metadata
          }
        : undefined,
      prompt_evidence: promptEvidence
        ? {
            profile: promptEvidence.profile,
            sha256: promptEvidence.sha256
          }
        : undefined,
      decision_mode: decisionMode,
      request_id: action.requestId
    }))
    .digest("hex");
}

function isTerminalApprovalPromptEvidence(
  value: unknown
): value is { profile: string; sha256: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const evidence = value as { profile?: unknown; sha256?: unknown };
  return typeof evidence.profile === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(evidence.profile) &&
    typeof evidence.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(evidence.sha256);
}


function statusFromInspection(
  adapter: TerminalAgentAdapter,
  terminalControl: TerminalControlRef,
  inspection: TerminalScreenInspection,
  options: {
    screen?: string;
    runtime?: TerminalRuntimeIdentity;
    now?: Date;
  } = {}
): TerminalBridgeStatus {
  const exactModelSurface = options.screen !== undefined &&
    exactCurrentModelControlSurface(
      adapter.agent,
      options.runtime?.agentVersion,
      options.screen
    );
  const modelSurfaceReason = exactModelSurface
    ? `exact ${adapter.displayName} native model-control surface is open`
    : undefined;
  const approval: TerminalApprovalInspection = exactModelSurface
    ? {
        blocked: false as const,
        approvable: false as const,
        reason: modelSurfaceReason!
      }
    : dispatchableApprovalInspection(adapter, inspection.approval);
  const fingerprint = terminalApprovalFingerprint(
    adapter.agent,
    terminalControl,
    {
      ...inspection,
      approval
    },
    options
  );
  const choices = approval.approvable
    ? terminalApprovalChoices(approval).flatMap((choice) => {
        if (!choice.decision) {
          return [];
        }
        const choiceFingerprint = terminalApprovalFingerprint(
          adapter.agent,
          terminalControl,
          { ...inspection, approval },
          { ...options, decision: choice.decision }
        );
        return choiceFingerprint ? [{
          decision: choice.decision,
          label: choice.label,
          fingerprint: choiceFingerprint
        }] : [];
      })
    : [];
  const interaction = options.screen === undefined || exactModelSurface
    ? undefined
    : captureTerminalInteractionRuntimeOffer({
        agent: adapter.agent,
        terminalControl,
        screen: options.screen,
        runtime: options.runtime,
        now: options.now ?? new Date(),
        approvalBlocked: approval.blocked
      });
  return {
    provider: terminalControl.kind,
    target: terminalControl.target,
    agent: adapter.agent,
    reachable: true,
    capabilities: adapter.capabilities,
    activity_state: exactModelSurface ? "unknown" : inspection.activity.state,
    activity_reason: modelSurfaceReason ?? inspection.activity.reason,
    screen_state: exactModelSurface ? "unknown" : inspection.activity.state,
    screen_reason: modelSurfaceReason ?? inspection.activity.reason,
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
      choices: choices.length > 0 ? choices : undefined,
      decision_mode: approval.approvable ? approval.action.mode ?? "keys" : undefined,
      request_id: approval.approvable ? approval.action.requestId : undefined,
      policy_evidence: approval.approvable && approval.policyEvidence
        ? {
            source: approval.policyEvidence.source,
            kind: approval.policyEvidence.kind,
            command_sha256: approval.policyEvidence.commandSha256,
            evidence_fingerprint: approval.policyEvidence.evidenceFingerprint,
            request_id: approval.policyEvidence.requestId
          }
        : undefined
    },
    screen: {
      excerpt: inspection.screenExcerpt,
      digest: options.screen === undefined
        ? undefined
        : createHash("sha256").update(options.screen).digest("hex"),
      approval: approvalOutput(approval)
    },
    ...(interaction === undefined ? {} : {
      interaction_state: terminalInteractionPublicCompatibilityProjection(
        interaction.projection
      ),
      interaction_prompt_fingerprint: interaction.promptFingerprint,
      interaction_surface_id: interaction.surfaceId
    })
  };
}

function dispatchableApprovalInspection(
  adapter: TerminalAgentAdapter,
  approval: TerminalScreenInspection["approval"]
): TerminalScreenInspection["approval"] {
  if (
    !approval.approvable ||
    (approval.action.mode ?? "keys") !== "keys" ||
    isTerminalApprovalPromptEvidence(approval.promptEvidence)
  ) {
    return approval;
  }
  return {
    blocked: true,
    approvable: false,
    reason: `${adapter.displayName} approval prompt has no adapter-verified prompt evidence`,
    promptKind: approval.promptKind,
    command: approval.command,
    cwd: approval.cwd,
    toolName: approval.toolName,
    requestDetail: approval.requestDetail
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
    screen_state: "unknown",
    screen_reason: message,
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
    choices: terminalApprovalChoices(approval).map((choice) => ({
      decision: choice.decision,
      label: choice.label
    })),
    policyEvidence: approval.policyEvidence
      ? {
          source: approval.policyEvidence.source,
          kind: approval.policyEvidence.kind,
          commandSha256: approval.policyEvidence.commandSha256,
          evidenceFingerprint: approval.policyEvidence.evidenceFingerprint,
          requestId: approval.policyEvidence.requestId
        }
      : undefined,
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
    screen_state: "unknown",
    screen_reason: reason,
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

function assertTerminalModelControlPlan(
  adapter: TerminalAgentAdapter,
  terminalControl: TerminalControlRef,
  agentVersion: string,
  plan: TerminalModelControlPlan
): void {
  if (!terminalControl.capabilities.includes("send_keys") ||
      !terminalControl.capabilities.includes("screen_status")) {
    throw new Error(
      "terminal model control requires exact screen-status and key-delivery capabilities"
    );
  }
  const capabilities = adapter.probeModelControl?.(agentVersion);
  if (capabilities?.status !== "supported" ||
      capabilities.modelSelection !== true ||
      capabilities.reasoningEffortSelection !== true ||
      capabilities.agentVersion !== agentVersion) {
    throw new Error(
      capabilities?.reason ??
      `${adapter.displayName} has no verified model-control profile`
    );
  }
  const expected = adapter.planModelControl?.(capabilities);
  if (!expected ||
      expected.command !== "/model" ||
      expected.requiresIdle !== true ||
      expected.requiresExactEmptyComposer !== true ||
      JSON.stringify(expected) !== JSON.stringify(plan)) {
    throw new Error(
      "the terminal adapter did not produce the exact current model-control plan"
    );
  }
  if (!terminalModelControlPlanConforms({
    agent: adapter.agent,
    agentVersion,
    plan
  })) {
    throw new Error("refusing an unprofiled terminal model-control plan");
  }
}
