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
  CLAUDE_INJECTED_PASTE_FRAME_PROFILE
} from "./claude-injected-paste-proof.js";
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
  isTerminalModelControlPlanForAgent,
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
  assertTerminalMutationCapabilities,
  claudeNativeInspectionTrailingIsFooter,
  CODEX_COMPOSER_FOOTER,
  CODEX_COMPOSER_MARKER,
  exactCodexReadyStyledComposerCapture,
  exactClaudeComposerFrame,
  inferCodexVisibleViewportColumns,
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
const CODEX_COMPLETE_COMPOSER_FOOTER =
  /^(?:gpt-[\w.-]+(?:\s+\S+)?|[-\w.]+ default)\s+·\s+\S.*$/u;
const CODEX_LARGE_PASTE_CHAR_THRESHOLD = 1_000;

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


function exactClaudeModelControlComposerCapture(
  screen: string,
  plan: TerminalModelControlPlan,
  expectedText: string
): { digest: string } | undefined {
  if (
    !isTerminalModelControlPlanForAgent(plan, "claude") ||
    expectedText !== plan.command ||
    expectedText !== "/model"
  ) return undefined;
  const frame = exactClaudeComposerFrame(screen);
  if (
    !frame ||
    frame.composerRows.length !== 1 ||
    frame.composerRows[0].replace(/^\s*❯\s?/u, "").trimEnd() !== expectedText ||
    frame.trailing.length > 2 ||
    !claudeNativeInspectionTrailingIsFooter(frame.trailing)
  ) return undefined;
  const beforeComposer = frame.lines.slice(0, frame.openIndex);
  while (beforeComposer.length > 0 &&
         beforeComposer.at(-1)?.trim() === "") {
    beforeComposer.pop();
  }
  let popupStart = beforeComposer.length;
  while (popupStart > 0) {
    const line = beforeComposer[popupStart - 1];
    if (
      /^\s*(?:(?:❯|›)\s*)?\/[a-z][a-z0-9-]*(?:\s{2,}|\s*$)/iu.test(line) ||
      /^\s{2,}\S/u.test(line)
    ) {
      popupStart -= 1;
      continue;
    }
    break;
  }
  const popupRows = beforeComposer.slice(popupStart);
  if (popupRows.length === 0 || popupRows.length > 32) return undefined;
  const suggestions: Array<{
    lineIndex: number;
    selected: boolean;
    command: string;
    normalized: string;
  }> = [];
  for (const [lineIndex, line] of popupRows.entries()) {
    const match = /^\s*(?:(❯|›)\s*)?(\/[a-z][a-z0-9-]*)(?:\s{2,}|\s*$)(.*)$/iu
      .exec(line);
    if (match) {
      suggestions.push({
        lineIndex,
        selected: Boolean(match[1]),
        command: match[2],
        normalized: `${match[2]} ${match[3]}`.trim().replace(/\s+/gu, " ")
      });
      continue;
    }
    if (suggestions.length === 0 || !/^\s{2,}\S/u.test(line)) {
      return undefined;
    }
    const previous = suggestions.at(-1)!;
    previous.normalized = `${previous.normalized} ${line.trim()}`
      .replace(/\s+/gu, " ");
  }
  if (suggestions.length === 0 || suggestions[0].lineIndex !== 0) {
    return undefined;
  }
  const selected = suggestions.filter((row) => row.selected);
  if (
    selected.length > 1 ||
    selected.length === 1 && selected[0].lineIndex !== 0 ||
    suggestions.slice(1).some((row) => row.command === "/model")
  ) return undefined;
  const first = suggestions[0].normalized;
  if (!/^\/model Set the AI model for Claude Code \(currently [A-Za-z0-9][A-Za-z0-9._:/+\[\]\- ]{0,127}\)$/u.test(first)) {
    return undefined;
  }
  return {
    digest: createHash("sha256")
      .update(frame.lines.slice(frame.openIndex).join("\n"))
      .digest("hex")
  };
}


function codexBlockingModalVisible(screen: string): boolean {
  const tail = screen.replace(/\r\n?/gu, "\n").split("\n").slice(-80)
    .join("\n");
  return /\b(?:press|use)\s+(?:esc|escape)\s+to\s+(?:cancel|close|dismiss)\b/iu
    .test(tail) ||
    /\besc\s+to\s+cancel\b/iu.test(tail) ||
    codexActiveWriterViewerVisible(tail) ||
    ["expanded", "ambiguous"].includes(
      inspectCodexAsyncQuestionInputMode(tail)
    );
}

function codexActiveWriterViewerVisible(styledScreen: string): boolean {
  const lines = stripTerminalEscapeSequences(styledScreen)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .slice(-80);
  let titleIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (
      /^ {2}🔒(?:\s|$)/u.test(lines[index]!)
    ) {
      titleIndex = index;
      break;
    }
  }
  if (titleIndex < 0) {
    return false;
  }
  const laterMainComposer = lines.findIndex((line, index) =>
    index > titleIndex && CODEX_COMPOSER_MARKER.test(line)
  );
  if (laterMainComposer >= 0) {
    return false;
  }
  const frame = lines.slice(titleIndex, titleIndex + 12)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter((line) => line.length > 0)
    .join(" ");
  return /🔒\s+This conversation is open in another app\s+\S+ to Retry/iu
      .test(frame) &&
    /Close it there and press\s+\S+\s+to continue here\./iu.test(frame) &&
    /\S+ retry\s+\S+ exit(?:\s+\S+ transcript)?/iu.test(frame);
}

export type CodexAsyncQuestionInputMode =
  | "absent"
  | "collapsed"
  | "expanded"
  | "ambiguous";

const CODEX_ASYNC_QUESTION_FOOTER_LABEL =
  /\s(submit|skip|main prompt|prev question|next question|queued messages)(?=\s{2,}|\s*$)/giu;

function codexStructuredAsyncFooterEvidence(
  lines: readonly string[],
  evidenceFloor: number
): { readonly index: number; readonly labelCount: number } {
  let strongest = { index: -1, labelCount: 0 };
  for (let start = evidenceFloor + 1; start < lines.length; start += 1) {
    const labels = new Set<string>();
    for (let end = start; end < Math.min(lines.length, start + 5); end += 1) {
      const line = lines[end]!;
      if (!/^ {2}(?![ ↳?])\S/u.test(line)) {
        break;
      }
      for (const match of line.matchAll(CODEX_ASYNC_QUESTION_FOOTER_LABEL)) {
        labels.add(match[1]!.toLowerCase());
      }
      if (labels.size > strongest.labelCount) {
        strongest = { index: end, labelCount: labels.size };
      }
      if (labels.size >= 2) {
        return strongest;
      }
    }
  }
  return strongest;
}

function codexMainComposerFooterIndex(
  lines: readonly string[],
  composerIndex: number
): number {
  for (let index = lines.length - 1; index > composerIndex; index -= 1) {
    // A real statusline starts at column zero. Draft continuations are inset,
    // even when their text happens to look exactly like a model statusline.
    if (CODEX_COMPLETE_COMPOSER_FOOTER.test(lines[index]!.trimEnd())) {
      return index;
    }
  }
  return -1;
}

/**
 * Classify Codex 0.154's non-blocking inline-question surface by current input
 * ownership. The shared `Queued follow-up inputs` heading is not sufficient:
 * ordinary queued messages use it too. An exact collapsed summary, after any
 * ordinary queue preview is removed, proves Send-safe ownership even when the
 * Composer is outside the viewport. Positive editor evidence without a
 * complete shape remains fail-closed because paste plus Enter would otherwise
 * submit the user's task as an answer.
 */
export function inspectCodexAsyncQuestionInputMode(
  styledScreen: string
): CodexAsyncQuestionInputMode {
  const lines = stripTerminalEscapeSequences(styledScreen)
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .split("\n")
    .slice(-80);
  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) {
    lines.pop();
  }
  const normalized = lines.map((line) => line.trim().replace(/\s+/gu, " "));
  let mainComposerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // The main Composer marker is column zero. Async option and inline-text
    // markers are inset by the menu surface, even after ANSI is removed.
    if (CODEX_COMPOSER_MARKER.test(lines[index]!)) {
      mainComposerIndex = index;
      break;
    }
  }

  let headerIndex = -1;
  let wrappedHeaderRows = 1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (
      /^•\s+Queued follow-up inputs\s*$/u.test(lines[index]!) ||
      /^•\s+Queued follow-up inpu…\s*$/u.test(lines[index]!) ||
      (
        /^•\s+Queued follow-up\s*$/u.test(lines[index]!) &&
        /^ {2}inputs\s*$/u.test(lines[index + 1] ?? "")
      )
    ) {
      headerIndex = index;
      wrappedHeaderRows = /^•\s+Queued follow-up\s*$/u.test(lines[index]!)
        ? 2
        : 1;
      break;
    }
  }
  const headerBodyIndex = headerIndex < 0
    ? -1
    : headerIndex + wrappedHeaderRows;
  let questionEvidenceStart = headerBodyIndex;
  if (headerIndex >= 0) {
    let cursor = headerBodyIndex;
    while (cursor < lines.length && lines[cursor]!.trim().length === 0) {
      cursor += 1;
    }
    let sawQueuedPreview = false;
    while (cursor < lines.length) {
      if (/^ {2}↳\s/u.test(lines[cursor]!)) {
        sawQueuedPreview = true;
        cursor += 1;
        while (cursor < lines.length) {
          if (
            lines[cursor]!.trim().length === 0 ||
            /^ {4,}\S/u.test(lines[cursor]!)
          ) {
            cursor += 1;
            continue;
          }
          break;
        }
        continue;
      }
      break;
    }
    if (sawQueuedPreview) {
      questionEvidenceStart = cursor;
    }
  }

  const mainComposerFooterIndex = mainComposerIndex < 0
    ? -1
    : codexMainComposerFooterIndex(lines, mainComposerIndex);
  const summaryBeforeMainComposer = headerIndex < 0 || mainComposerIndex < 0
    ? -1
    : normalized.findIndex((line, index) =>
      index >= questionEvidenceStart && index < mainComposerIndex &&
      /^\?\s+\d+\s+questions?(?:\s+·\s+\d+s)?$/iu.test(line)
    );
  if (mainComposerIndex >= 0 && mainComposerFooterIndex < 0) {
    // A statusline-disabled Composer is the strongest available ownership
    // anchor. Treat all following wrapped rows as its arbitrary draft instead
    // of letting question-like user text veto a human-priority Send.
    return summaryBeforeMainComposer >= 0 ? "collapsed" : "absent";
  }

  const evidenceFloor = Math.max(
    mainComposerFooterIndex,
    questionEvidenceStart - 1
  );
  const structuredFooter = codexStructuredAsyncFooterEvidence(
    lines,
    evidenceFloor
  );
  if (structuredFooter.labelCount >= 2) {
    return "expanded";
  }

  const clippedFooterIndex = normalized.findIndex((line, index) =>
    index > evidenceFloor && /^ente(?:r)?…$/iu.test(line) &&
    /^ctrl…$/iu.test(normalized[index + 1] ?? "")
  );
  const clippedChoiceIndex = normalized.findIndex((line, index) =>
    index > evidenceFloor &&
    line === "Expand terminal to read the entire option"
  );
  if (clippedFooterIndex >= 0 || clippedChoiceIndex >= 0) {
    return "ambiguous";
  }

  if (headerIndex < 0) {
    const evidence = new Set<string>();
    normalized.forEach((line, index) => {
      if (index <= evidenceFloor) {
        return;
      }
      if (/^\d+\s+of(?:\s+\d+)?$/iu.test(line)) {
        evidence.add("progress");
      }
      if (/^›\s+\S/u.test(line)) {
        evidence.add("selector");
      }
      if (/^Type your answer(?:\s*\(optional\))?$/iu.test(line)) {
        evidence.add("free_text");
      }
    });
    return evidence.size >= 2 ||
        (evidence.size >= 1 && structuredFooter.labelCount >= 1)
      ? "ambiguous"
      : "absent";
  }

  const weakQuestionIndex = normalized.findIndex((line, index) =>
    index > evidenceFloor && index >= questionEvidenceStart && (
      /^\d+\s+of(?:\s+\d+)?$/iu.test(line) ||
      /^›\s+\S/u.test(line) ||
      /^Type your answer(?:\s*\(optional\))?$/iu.test(line)
    )
  );
  if (mainComposerIndex > headerIndex && weakQuestionIndex > evidenceFloor) {
    return "ambiguous";
  }

  const summaryIndex = normalized.findIndex((line, index) =>
    index >= questionEvidenceStart &&
    (mainComposerIndex < 0 || index < mainComposerIndex) &&
    /^\?\s+\d+\s+questions?(?:\s+·\s+\d+s)?$/iu.test(line)
  );
  if (summaryIndex >= 0) {
    return weakQuestionIndex >= 0 ? "ambiguous" : "collapsed";
  }
  if (mainComposerIndex > headerIndex) {
    return "absent";
  }
  const afterHeader = normalized.slice(questionEvidenceStart)
    .filter((line) => line.length > 0);
  const positiveAfterHeader = afterHeader.some((line) =>
      /^\d+\s+of(?:\s+\d+)?$/iu.test(line) ||
      /^›\s+\d+\.(?:\s|$)/u.test(line) ||
      /^Type your answer(?:\s*\(optional\))?$/iu.test(line)
    );
  if (positiveAfterHeader) {
    return "ambiguous";
  }

  // A bare heading (optionally followed by ↳ queued-message previews) is not
  // question authority. Preserve human-explicit Send in that ordinary state.
  if (
    afterHeader.length === 0
  ) {
    return "absent";
  }

  // An expanded editor can temporarily replace its footer with a flash. If
  // there is question-like content under the shared heading and no proven main
  // Composer, do not guess which input surface will receive the next paste.
  return "ambiguous";
}

/**
 * Classify only the bottom live Codex composer region. A matching transcript
 * prompt elsewhere in scrollback is deliberately ignored.
 */
function currentCodexComposerCapture(
  styledScreen: string,
  expectedText: string,
  allowOpaqueLargePastePlaceholder = false,
  classifyOpaqueLargePasteAsDifferent = false,
  exactSlashPopupRows?: readonly string[]
): {
  state: "exact_draft" | "exact_empty" | "different_draft";
  digest: string;
  profiledSlashPopup?: true;
  bareCommand?: true;
} | undefined {
  const screen = stripTerminalEscapeSequences(styledScreen);
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) {
    lines.pop();
  }
  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CODEX_COMPOSER_MARKER.test(lines[index])) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 0) {
    return undefined;
  }
  const footerIndex = lines.findIndex((line, index) =>
    index > composerIndex &&
    CODEX_COMPLETE_COMPOSER_FOOTER.test(line.trim())
  );
  if (
    footerIndex >= 0 &&
    lines.slice(footerIndex + 1).some((line) => line.trim().length > 0)
  ) {
    return undefined;
  }
  const regionEnd = footerIndex < 0 ? lines.length : footerIndex;
  const region = lines.slice(composerIndex, regionEnd);
  while (region.length > 1 && region.at(-1)?.trim().length === 0) {
    region.pop();
  }
  if (
    region.length === 0 ||
    region.slice(1).some((line) => line.length > 0 && !line.startsWith("  "))
  ) {
    return undefined;
  }
  const bodyRows = [
    region[0].replace(/^[›»]\s?/u, ""),
    ...region.slice(1).map((line) => line.startsWith("  ") ? line.slice(2) : line)
  ];
  const digest = createHash("sha256").update(region.join("\n")).digest("hex");
  const positivelyEmpty = footerIndex >= 0 &&
    bodyRows.slice(1).every((row) => row.trim().length === 0) &&
    exactCodexReadyStyledComposerCapture(styledScreen) !== undefined;
  if (positivelyEmpty) {
    return { state: "exact_empty", digest };
  }
  const expectedComparable = composerComparableText(expectedText);
  const exactStyledProfiledCommand = exactSlashPopupRows !== undefined &&
    exactCodexStyledCommandComposerCapture(
      styledScreen,
      expectedText
    ) !== undefined;
  const exactFooterlessProfiledCommand = footerIndex < 0 &&
    exactStyledProfiledCommand;
  // Codex 0.154 replaces the ordinary model/cwd footer with its slash
  // completion surface. Real terminal renderers may retain one or more blank
  // layout rows between the Composer and that surface. The exact styled
  // command is sufficient only for reversible cleanup; Enter additionally
  // requires the unique, ordered, version-profiled completion rows below.
  const popupRows = region.slice(1).map((row) => row.trimEnd());
  const exactPopupLayout =
    exactSlashPopupRows !== undefined && (
      JSON.stringify(popupRows) === JSON.stringify(exactSlashPopupRows) ||
      popupRows.length === exactSlashPopupRows.length + 1 &&
        popupRows[0] === "" &&
        JSON.stringify(popupRows.slice(1)) ===
          JSON.stringify(exactSlashPopupRows)
    );
  const exactProfiledSlashPopup =
    exactSlashPopupRows !== undefined &&
    composerComparableText(bodyRows[0] ?? "").trimEnd() ===
      expectedComparable &&
    exactPopupLayout;
  if (footerIndex < 0 && !exactFooterlessProfiledCommand) {
    return undefined;
  }

  const expectedCharacterCount = Array.from(expectedText).length;
  const comparable = composerComparableText(bodyRows.join("\n"));
  const opaqueLargePastePlaceholder =
    /^\[Pasted Content \d+ chars\]$/u.test(comparable);
  if (opaqueLargePastePlaceholder && !allowOpaqueLargePastePlaceholder) {
    return classifyOpaqueLargePasteAsDifferent
      ? { state: "different_draft", digest }
      : undefined;
  }
  // Herdr's ANSI visible buffer preserves Codex's fixed-width Composer paint:
  // the typed command is followed by layout padding through the viewport edge.
  // Accept that padding only when the closed 0.154 profile, full-row
  // background paint, exact command text, and complete model/cwd footer all
  // agree. Plain padded text remains untrusted.
  const exactVisibleDraft = footerIndex >= 0 && (
    terminalComposerRowsMatchExpected(bodyRows, expectedComparable) ||
    exactStyledProfiledCommand
  );
  const exactLargePastePlaceholder =
    allowOpaqueLargePastePlaceholder &&
    expectedCharacterCount > CODEX_LARGE_PASTE_CHAR_THRESHOLD &&
    comparable === composerComparableText(
      `[Pasted Content ${expectedCharacterCount} chars]`
    );
  if (
    exactVisibleDraft ||
    exactLargePastePlaceholder ||
    exactProfiledSlashPopup ||
    exactFooterlessProfiledCommand
  ) {
    return {
      state: "exact_draft",
      digest,
      ...(exactProfiledSlashPopup ? { profiledSlashPopup: true as const } : {}),
      ...(exactVisibleDraft && footerIndex >= 0
        ? { bareCommand: true as const }
        : {})
    };
  }
  return comparable.length > 0
    ? { state: "different_draft", digest }
    : undefined;
}

/**
 * Prove the live footerless Codex slash Composer without trusting transcript
 * text alone. The 0.154 TUI paints this row across the current viewport while
 * its completion popup replaces the ordinary model/cwd footer.
 */
function exactCodexStyledCommandComposerCapture(
  styledScreen: string,
  expectedText: string
): { digest: string } | undefined {
  const rows = styledScreen.replace(/\r\n?/gu, "\n").split("\n");
  const viewportColumns = inferCodexVisibleViewportColumns(styledScreen);
  if (!viewportColumns) return undefined;
  let composerLine: string | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const plain = stripTerminalEscapeSequences(rows[index]);
    if (CODEX_COMPOSER_MARKER.test(plain)) {
      composerLine = rows[index];
      break;
    }
  }
  if (!composerLine) return undefined;
  const plain = stripTerminalEscapeSequences(composerLine);
  const exactCommand = plain.trimEnd().replace(/^[›»]\s?/u, "") ===
    expectedText;
  const spansViewport = Array.from(plain).length === viewportColumns &&
    plain.endsWith(" ");
  const hasBackground = [...composerLine.matchAll(/\x1b\[([0-9;]*)m/gu)]
    .some((match) => match[1].split(";").map(Number).includes(48));
  if (!exactCommand || !spansViewport || !hasBackground) {
    return undefined;
  }
  return {
    digest: createHash("sha256").update(composerLine).digest("hex")
  };
}

function exactCodexComposerCapture(
  screen: string,
  expectedText: string
): { digest: string } | undefined {
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  const expectedComparable = composerComparableText(expectedText);
  const expectedCharacterCount = Array.from(expectedText).length;
  const largePasteComparable = composerComparableText(
    `[Pasted Content ${expectedCharacterCount} chars]`
  );
  const matches: { digest: string }[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!CODEX_COMPOSER_MARKER.test(lines[index])) {
      continue;
    }
    const footerIndex = lines.findIndex((line, candidateIndex) =>
      candidateIndex > index && CODEX_COMPOSER_FOOTER.test(line.trim())
    );
    const region = lines.slice(
      index,
      footerIndex < 0 ? lines.length : footerIndex
    );
    while (region.length > 1 && region.at(-1)?.trim() === "") {
      region.pop();
    }
    const bodyRows = [
      region[0].replace(/^[›»]\s?/u, ""),
      ...region.slice(1).map((line) =>
        line.startsWith("  ") ? line.slice(2) : line
      )
    ];
    const comparable = composerComparableText(bodyRows.join("\n"));
    const exactVisibleDraft = terminalComposerRowsMatchExpected(
      bodyRows,
      expectedComparable
    );
    const exactLargePastePlaceholder =
      expectedCharacterCount > CODEX_LARGE_PASTE_CHAR_THRESHOLD &&
      comparable === largePasteComparable;
    if (!exactVisibleDraft && !exactLargePastePlaceholder) {
      continue;
    }
    matches.push({
      digest: createHash("sha256")
        .update(region.join("\n"))
        .digest("hex")
    });
  }

  if (matches.length > 1) {
    throw new Error(
      "multiple Codex composer regions matched the multiline terminal request"
    );
  }
  return matches[0];
}

/**
 * Terminal UIs paint wrapped composer content as independent screen rows, so
 * a provider capture cannot distinguish a visual wrap from an authored
 * newline. Align the rows against the exact text AKK injected instead of
 * joining every row with `\n`.
 *
 * Only row boundaries are ambiguous: they may consume an authored newline, an
 * omitted run of ASCII spaces at a word wrap, or no character at a CJK/token
 * wrap. Every visible character remains character-for-character exact, and an
 * empty row can only advance through an authored newline (plus terminal-trimmed
 * spaces before it), so blank-line structure is preserved.
 */
function terminalComposerRowsMatchExpected(
  rows: readonly string[],
  expectedText: string
): boolean {
  const expected = composerComparableText(expectedText);
  if (rows.length === 0) {
    return expected.length === 0;
  }
  if (!expected.startsWith(rows[0])) {
    return false;
  }

  let offsets = new Set<number>([rows[0].length]);
  for (let index = 1; index < rows.length && offsets.size > 0; index += 1) {
    const row = rows[index];
    const previousRow = rows[index - 1];
    const nextOffsets = new Set<number>();
    for (const offset of offsets) {
      const candidateStarts = new Set<number>();
      if (expected[offset] === "\n") {
        candidateStarts.add(offset + 1);
      }
      let whitespaceEnd = offset;
      while (expected[whitespaceEnd] === " ") {
        whitespaceEnd += 1;
      }
      if (previousRow.length > 0 && row.length > 0) {
        candidateStarts.add(offset);
        if (whitespaceEnd > offset) {
          candidateStarts.add(whitespaceEnd);
        }
      }
      if (
        whitespaceEnd > offset &&
        expected[whitespaceEnd] === "\n"
      ) {
        candidateStarts.add(whitespaceEnd + 1);
      }
      for (const candidateStart of candidateStarts) {
        if (expected.startsWith(row, candidateStart)) {
          nextOffsets.add(candidateStart + row.length);
        }
      }
    }
    offsets = nextOffsets;
  }
  return offsets.has(expected.length);
}

function exactTerminalComposerCapture(
  agent: ExecutorKind,
  screen: string,
  expectedText: string
): { digest: string } | undefined {
  return agent === "codex"
    ? exactCodexComposerCapture(screen, expectedText)
    : exactClaudeComposerCapture(screen, expectedText);
}

function exactClaudeComposerCapture(
  screen: string,
  expectedText: string
): { digest: string } | undefined {
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  const dividerIndexes = lines
    .map((line, index) => /^\s*[─━]{8,}\s*$/u.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (dividerIndexes.length < 2) {
    return undefined;
  }
  const closeIndex = dividerIndexes.at(-1)!;
  const openIndex = dividerIndexes.at(-2)!;
  const trailing = lines.slice(closeIndex + 1)
    .filter((line) => line.trim().length > 0);
  if (
    trailing.length > 2 ||
    trailing.some((line) =>
      !/^\s*(?:[⏵⏴⏸]{1,2}|\?)\s*.*(?:manual mode|shift\+tab|accept edits|bypass permissions|for shortcuts|← for agents)/iu
        .test(line)
    )
  ) {
    return undefined;
  }
  const region = lines.slice(openIndex + 1, closeIndex);
  while (region.length > 1 && region.at(-1)?.trim() === "") {
    region.pop();
  }
  if (region.length === 0 || !/^\s*❯(?:\s|$)/u.test(region[0])) {
    return undefined;
  }
  const bodyRows = [
    region[0].replace(/^\s*❯\s?/u, ""),
    ...region.slice(1).map((line) =>
      line.startsWith("  ") ? line.slice(2) : line
    )
  ];
  if (!terminalComposerRowsMatchExpected(bodyRows, expectedText)) {
    return undefined;
  }
  return {
    digest: createHash("sha256")
      .update(lines.slice(openIndex, closeIndex + 1).join("\n"))
      .digest("hex")
  };
}

function exactClaudeInjectedPastePlaceholderCapture(
  screen: string,
  expectedText: string
): {
  state: "exact_injected_paste_placeholder";
  digest: string;
  pasteId: number;
  newlineCount: number;
  frameProfile: string;
} | undefined {
  const expectedNewlineCount = (
    composerComparableText(expectedText).match(/\n/gu) ?? []
  ).length;
  if (expectedNewlineCount === 0) {
    return undefined;
  }
  const frame = exactClaudeComposerFrame(screen);
  if (
    !frame ||
    frame.composerRows.length !== 1 ||
    !claudeInjectedPastePlaceholderTrailingMatches(frame.trailing)
  ) {
    return undefined;
  }
  const placeholder =
    /^\s*❯\s*\[Pasted text #([1-9]\d*) \+([1-9]\d*) lines\]\s*$/u
      .exec(frame.composerRows[0]);
  if (!placeholder) {
    return undefined;
  }
  const pasteId = Number(placeholder[1]);
  const newlineCount = Number(placeholder[2]);
  if (
    !Number.isSafeInteger(pasteId) ||
    !Number.isSafeInteger(newlineCount) ||
    newlineCount !== expectedNewlineCount
  ) {
    return undefined;
  }
  return {
    state: "exact_injected_paste_placeholder",
    digest: createHash("sha256")
      .update(
        frame.lines
          .slice(frame.openIndex, frame.closeIndex + 1)
          .concat(frame.trailing)
          .join("\n")
      )
      .digest("hex"),
    pasteId,
    newlineCount,
    frameProfile: CLAUDE_INJECTED_PASTE_FRAME_PROFILE
  };
}

function claudeInjectedPastePlaceholderTrailingMatches(
  lines: readonly string[]
): boolean {
  if (lines.length === 0) {
    return false;
  }
  const hint = "paste again to expand";
  const first = lines[0].trimStart();
  if (!first.startsWith(hint)) {
    return false;
  }
  const sameRowStatus = first.slice(hint.length);
  if (sameRowStatus.length > 0 && !/^\s{2,}\S/u.test(sameRowStatus)) {
    return false;
  }
  const footerRows = [
    ...(sameRowStatus.trim().length > 0 ? [sameRowStatus.trim()] : []),
    ...lines.slice(1).map((line) => line.trim())
  ];
  return footerRows.length === 0 ||
    claudeNativeInspectionTrailingIsFooter(footerRows) ||
    claudeInjectedPasteAuxiliaryFooterMatches(footerRows);
}

function claudeInjectedPasteAuxiliaryFooterMatches(
  lines: readonly string[]
): boolean {
  if (lines.length === 0 || lines.length > 2) {
    return false;
  }
  const autoUpdate = lines.filter((line) =>
    line === "✘ Auto-update failed · Run claude doctor"
  ).length;
  const effort = lines.filter((line) =>
    /^[●○◐◉] (?:low|medium|high|xhigh|max|ultracode) · \/effort$/u
      .test(line)
  ).length;
  return autoUpdate <= 1 && effort <= 1 &&
    autoUpdate + effort === lines.length;
}

function composerComparableText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
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
