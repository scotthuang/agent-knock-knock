import { claudeUserExplicitReadiness } from "./claude-user-explicit-input-proof.js";
import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import { isExactNativeThreadId } from "./managed-session.js";
import type {
  ActiveTerminalProcess,
  TerminalAgentAdapter,
  TerminalNativeInspectionCapabilities,
  TerminalThreadLifecycleCapabilities
} from "./terminal-agent-adapter.js";
import type {
  TerminalActivityState,
  TerminalAgentBridge,
  TerminalBridgeStatus,
  TerminalDurableActivityState,
  TerminalNativeIdentityState
} from "./terminal-agent-bridge.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import {
  terminalModelControlProfileFor,
  type TerminalModelControlCapabilities,
  type TerminalModelControlProfile,
  type TerminalModelControlResidualObservation
} from "./terminal-model-control.js";
import type {
  TerminalNativeIdentity,
  TerminalNativeIdentityObservation
} from "./terminal-binding-authority.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import type { TerminalListIdentityRecheck } from "./terminal-list-native-identity-recheck.js";
import type { ClaudeTerminalAdmission } from "./claude-terminal-admission.js";

export interface TerminalListState {
  readonly approval_state: TerminalBridgeStatus["approval_state"] & {
    readonly screen_excerpt?: string;
    readonly error?: string;
  };
  readonly activity_state: TerminalBridgeStatus["activity_state"];
  readonly activity_reason: string;
  readonly screen_state: TerminalActivityState;
  readonly screen_reason: string;
  readonly capability_limitation?: string;
  readonly screen_excerpt?: string;
  readonly _terminal_status_snapshot?: TerminalBridgeStatus;
}

export interface EffectiveTerminalListState extends TerminalListState {
  readonly native_identity_state: TerminalNativeIdentityState;
  readonly durable_activity_state: TerminalDurableActivityState;
  readonly durable_activity_reason: string;
}

export interface TerminalNativeListIdentityFacts {
  readonly claudeAdmission?: ClaudeTerminalAdmission;
  readonly orphanedDispatch?: TerminalDispatchLedgerDocument;
  readonly nativeIdentityObservation: TerminalNativeIdentityObservation;
  readonly nativeIdentityRecheck?: TerminalListIdentityRecheck;
  readonly nativeWindowRole?: "background_view";
  readonly nativeAgentIdentity?: TerminalNativeIdentity;
  readonly authorityNativeIdentityObservation:
    TerminalNativeIdentityObservation;
  readonly authorityNativeAgentIdentity?: TerminalNativeIdentity;
  readonly codexOpenRootRolloutInventory?: CodexOpenRootRolloutInventory;
  readonly nativeProcessUuid?: string;
  readonly nativeProcessBirth?: string;
  readonly nativeProcessEvidence?: string;
}

export interface TerminalListComposerFacts {
  readonly automatedInputComposerReady: boolean;
  readonly userExplicitComposerReady: boolean;
  readonly claudeUserExplicitReadiness?: ReturnType<typeof claudeUserExplicitReadiness>;
  /** Positive evidence that a non-Composer UI surface owns terminal input. */
  readonly inputOwnerBlocked: boolean;
}

/** A deferred/disabled scan carries no input authority; failed capture is distinct from unsafe input. */
export async function observeTerminalListState(input: {
  noApprovalScan?: boolean;
  listDiscoveryOnly?: boolean;
  discoveredActivity?: "idle" | "working" | "waiting";
  observe(): Promise<TerminalBridgeStatus>;
}): Promise<TerminalListState> {
  if (input.noApprovalScan || input.listDiscoveryOnly) {
    return {
      approval_state: {
        scanned: false,
        blocked: false,
        approvable: false,
        reason: input.noApprovalScan ? "approval scan disabled" : "approval details deferred to Status or execution preflight"
      },
      activity_state: input.discoveredActivity === "waiting" ? "awaiting_approval" : input.discoveredActivity ?? "unknown",
      activity_reason: input.discoveredActivity ? "current discovery activity" : "terminal screen scan disabled",
      screen_state: "unknown",
      screen_reason: "terminal screen scan disabled"
    };
  }
  try {
    const status = await input.observe();
    return {
      approval_state: {
        ...status.approval_state,
        screen_excerpt: status.approval_state.blocked ? status.screen.excerpt?.slice(-1000) : undefined
      },
      activity_state: status.activity_state,
      activity_reason: status.activity_reason,
      screen_state: status.screen_state ?? status.activity_state,
      screen_reason: status.screen_reason ?? status.activity_reason,
      capability_limitation: status.capability_limitation,
      _terminal_status_snapshot: status,
      // Internal projection evidence; terminalControlledListEntry selects all
      // public fields explicitly and never exposes the pane excerpt itself.
      screen_excerpt: status.screen.excerpt
    };
  } catch (error) {
    return {
      approval_state: {
        scanned: false,
        blocked: false,
        approvable: false,
        error: error instanceof Error ? error.message : String(error)
      },
      activity_state: "unknown",
      activity_reason: error instanceof Error ? error.message : String(error),
      screen_state: "unknown",
      screen_reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/** A skipped or failed capture says nothing about the contents of the Composer. */
export function claudePhysicalSendReadinessFromListState(
  state: TerminalListState, options: { noApprovalScan?: boolean; listDiscoveryOnly?: boolean }
): ReturnType<typeof claudeUserExplicitReadiness> {
  if (options.noApprovalScan || options.listDiscoveryOnly) return {
    ready: false, reason: "screen_not_scanned",
    message: "AKK has not scanned this window's input. Use Status, or List with noApprovalScan:false (CLI: --approval-scan), to check current input readiness."
  };
  if (typeof state.screen_excerpt !== "string") return {
    ready: false, reason: "screen_unavailable",
    message: "AKK could not read this window. Open Status to inspect the capture error, restore terminal-provider access, then refresh List with pane scanning enabled."
  };
  return claudeUserExplicitReadiness(state.screen_excerpt);
}

/** Diagnostics do not carry the private transcript anchor or grant a physical fallback. */
export function claudeListAdmissionProjection(agent: string, facts: TerminalListTerminalFacts, send: boolean, deferred = false) {
  if (agent !== "claude") return {};
  if (deferred) return { _claude_managed_send_eligible: false };
  const missing = { ready: false, reason: "claude_reader_unavailable",
    message: "AKK could not verify the current Claude process through its reader. Check Status and the configured Claude reader, then refresh List and retry." };
  return {
    managed_send_readiness: facts.native.claudeAdmission?.managedSend ?? missing,
    thread_lifecycle_readiness: facts.native.claudeAdmission?.lifecycle ?? missing,
    _claude_managed_send_eligible: send && facts.composer.automatedInputComposerReady &&
      !facts.store.hasOrphanedDispatch && facts.native.claudeAdmission?.managedSend.ready === true
  };
}

export interface TerminalListPhysicalProcessIncarnation {
  readonly processUuid: string;
  readonly processBirth: string;
  readonly evidence?: string;
}

export interface TerminalListLatentClearResumeFacts {
  readonly sourceNativeThreadId: string;
  readonly fingerprint: string;
}

export interface TerminalListTerminalFacts {
  readonly physical: {
    readonly terminalId: string;
    readonly childPids: readonly number[];
    readonly processIncarnation?: TerminalListPhysicalProcessIncarnation;
  };
  readonly status: {
    /** One status observation supplies screen, activity, and approval facts. */
    readonly observed: TerminalListState;
    readonly effective: EffectiveTerminalListState;
    readonly projected: EffectiveTerminalListState;
    readonly snapshot?: TerminalBridgeStatus;
    readonly statusCardNativeThreadId?: string;
    readonly hasInteraction: boolean;
  };
  readonly native: TerminalNativeListIdentityFacts;
  readonly runtime: {
    readonly agentVersion?: string;
    readonly lifecycleCapability: TerminalThreadLifecycleCapabilities;
    readonly nativeInspectionCapability:
      TerminalNativeInspectionCapabilities;
    readonly modelControlCapability: TerminalModelControlCapabilities;
    readonly modelControlProfile?: TerminalModelControlProfile;
    readonly compatibilityWarnings: readonly string[];
  };
  readonly composer: TerminalListComposerFacts;
  readonly store: {
    readonly terminalHasBlockingTurn: boolean;
    readonly hasOrphanedDispatch: boolean;
  };
  readonly codex: {
    readonly latentClearResume?: TerminalListLatentClearResumeFacts;
    readonly zeroRolloutModelControlVerified: boolean;
  };
  readonly modelControlResidual?: TerminalModelControlResidualObservation;
}

export interface TerminalListTerminalFactPorts {
  observeStatus(agentVersion?: string): Promise<TerminalListState>;
  observeNativeIdentity(
    terminalId: string
  ): Promise<TerminalNativeListIdentityFacts>;
  projectEffectiveState(input: {
    terminalState: TerminalListState;
    native: TerminalNativeListIdentityFacts;
  }): EffectiveTerminalListState;
  observeAgentVersion(): string | undefined;
  observeTerminalHasBlockingTurn(): boolean;
  observeComposer(
    terminalState: EffectiveTerminalListState, agentVersion?: string
  ): Promise<TerminalListComposerFacts>;
  observePhysicalProcessIncarnation():
    TerminalListPhysicalProcessIncarnation | undefined;
  observeLatentClearResume(input: {
    screen?: string;
    agentVersion?: string;
  }): TerminalListLatentClearResumeFacts | undefined;
  observeModelControlResidual(input: {
    agentVersion?: string;
    modelControlCapability: TerminalModelControlCapabilities;
    modelControlProfile?: TerminalModelControlProfile;
    native: TerminalNativeListIdentityFacts;
    zeroRolloutVerified: boolean;
    effectiveTerminalState: EffectiveTerminalListState;
    terminalHasInteraction: boolean;
    terminalHasBlockingTurn: boolean;
    hasOrphanedDispatch: boolean;
  }): Promise<TerminalModelControlResidualObservation | undefined>;
  projectStatusSnapshot(
    status: TerminalBridgeStatus,
    projection: EffectiveTerminalListState
  ): TerminalBridgeStatus;
}

/**
 * Collect the immutable observation facts for one already-discovered terminal.
 *
 * This boundary does not create action authority, generate tokens, render
 * public JSON, write Store state, or send terminal input. Each observation port
 * is invoked at most once. The status result is the single source for screen,
 * activity, approval, and interaction facts; later styled-Composer and native
 * model-control observations remain explicitly separate fail-closed captures.
 */
export async function collectTerminalListTerminalFacts(input: {
  session: ActiveTerminalProcess;
  terminalControl: TerminalControlRef;
  terminalId: string;
  childPids: readonly number[];
  adapter: TerminalAgentAdapter;
  ports: TerminalListTerminalFactPorts;
}): Promise<TerminalListTerminalFacts> {
  const { session, terminalControl, terminalId, childPids, adapter, ports } =
    input;
  const agentVersion = ports.observeAgentVersion();
  const observedState = await ports.observeStatus(agentVersion);
  const native = await ports.observeNativeIdentity(terminalId);
  const effectiveState = ports.projectEffectiveState({
    terminalState: observedState,
    native
  });
  const rawSnapshot = effectiveState._terminal_status_snapshot;
  const snapshot = rawSnapshot
    ? ports.projectStatusSnapshot(rawSnapshot, effectiveState)
    : undefined;
  const statusCardNativeThreadId = observeStatusCardNativeThreadId(
    session,
    adapter,
    effectiveState
  );
  const runtime = observeTerminalListRuntimeFacts(
    session,
    adapter,
    agentVersion
  );
  const latentClearResume = session.agent === "codex"
    ? ports.observeLatentClearResume({
        screen: effectiveState.screen_excerpt,
        agentVersion: runtime.agentVersion
      })
    : undefined;
  const terminalHasBlockingTurn = ports.observeTerminalHasBlockingTurn();
  const composer = await ports.observeComposer(effectiveState, agentVersion);
  const processIncarnation = ports.observePhysicalProcessIncarnation();
  const zeroRolloutModelControlVerified = zeroRolloutModelControlFact({
    session,
    native,
    processIncarnation
  });
  const terminalHasInteraction = snapshot?.interaction_state !== undefined;
  const hasOrphanedDispatch = native.orphanedDispatch !== undefined;
  const modelControlResidual = await ports.observeModelControlResidual({
    agentVersion: runtime.agentVersion,
    modelControlCapability: runtime.modelControlCapability,
    modelControlProfile: runtime.modelControlProfile,
    native,
    zeroRolloutVerified: zeroRolloutModelControlVerified,
    effectiveTerminalState: effectiveState,
    terminalHasInteraction,
    terminalHasBlockingTurn,
    hasOrphanedDispatch
  });
  const modelControlSurfaceOpen =
    modelControlResidual?.state === "recoverable" &&
    modelControlResidual.kind === "model_surface";
  const projectedState = modelControlSurfaceOpen
    ? terminalListStateWithOpenModelControlSurface(effectiveState)
    : effectiveState;

  return freezeTerminalListFacts({
    terminalId,
    childPids,
    processIncarnation,
    observedState,
    effectiveState,
    projectedState,
    snapshot,
    statusCardNativeThreadId,
    terminalHasInteraction,
    native,
    runtime,
    composer,
    terminalHasBlockingTurn,
    hasOrphanedDispatch,
    latentClearResume,
    zeroRolloutModelControlVerified,
    modelControlResidual
  });
}

function observeStatusCardNativeThreadId(
  session: ActiveTerminalProcess,
  adapter: TerminalAgentAdapter,
  state: EffectiveTerminalListState
): string | undefined {
  const observation = session.agent === "codex" &&
      typeof state.screen_excerpt === "string"
    ? adapter.observeThreadLifecycle?.({
        operation: { kind: "new_thread" },
        phase: "before",
        screen: state.screen_excerpt
      })
    : undefined;
  return observation?.status === "observed" &&
      state.activity_state === "idle" &&
      state.approval_state.blocked !== true &&
      isExactNativeThreadId(observation.nativeThreadId)
    ? observation.nativeThreadId
    : undefined;
}

function observeTerminalListRuntimeFacts(
  session: ActiveTerminalProcess,
  adapter: TerminalAgentAdapter,
  agentVersion: string | undefined
): TerminalListTerminalFacts["runtime"] {
  const lifecycleCapability = adapter.probeThreadLifecycle?.(agentVersion) ?? {
    status: "unsupported" as const,
    agentVersion,
    newThread: false,
    resumeExact: false,
    reason: "native thread lifecycle is unavailable"
  };
  const nativeInspectionCapability =
    adapter.probeNativeInspection?.(agentVersion) ?? {
      status: "unsupported" as const,
      agentVersion,
      statusInspection: false,
      reason: "native inspection is unavailable"
    };
  const modelControlCapability = adapter.probeModelControl?.(agentVersion) ?? {
    status: "unsupported" as const,
    agentVersion,
    modelSelection: false,
    reasoningEffortSelection: false,
    reason: "terminal model control is unavailable"
  };
  const compatibilityWarnings = Object.freeze([...new Set([
    lifecycleCapability.compatibilityWarning,
    nativeInspectionCapability.compatibilityWarning
  ].filter((warning): warning is string =>
    typeof warning === "string" && warning.trim().length > 0
  ))]);
  return Object.freeze({
    agentVersion,
    lifecycleCapability,
    nativeInspectionCapability,
    modelControlCapability,
    modelControlProfile: terminalModelControlProfileFor(
      session.agent,
      agentVersion
    ),
    compatibilityWarnings
  });
}

function zeroRolloutModelControlFact(input: {
  session: ActiveTerminalProcess;
  native: TerminalNativeListIdentityFacts;
  processIncarnation?: TerminalListPhysicalProcessIncarnation;
}): boolean {
  const { session, native, processIncarnation } = input;
  return session.agent === "codex" &&
    native.nativeIdentityObservation.status === "verified_absent" &&
    native.authorityNativeIdentityObservation.status === "verified_absent" &&
    native.codexOpenRootRolloutInventory?.status === "verified_absent" &&
    native.codexOpenRootRolloutInventory.pid === session.pid &&
    native.codexOpenRootRolloutInventory.roots.length === 0 &&
    native.codexOpenRootRolloutInventory.processBirth ===
      processIncarnation?.processBirth;
}

function freezeTerminalListFacts(input: {
  terminalId: string;
  childPids: readonly number[];
  processIncarnation?: TerminalListPhysicalProcessIncarnation;
  observedState: TerminalListState;
  effectiveState: EffectiveTerminalListState;
  projectedState: EffectiveTerminalListState;
  snapshot?: TerminalBridgeStatus;
  statusCardNativeThreadId?: string;
  terminalHasInteraction: boolean;
  native: TerminalNativeListIdentityFacts;
  runtime: TerminalListTerminalFacts["runtime"];
  composer: TerminalListComposerFacts;
  terminalHasBlockingTurn: boolean;
  hasOrphanedDispatch: boolean;
  latentClearResume?: TerminalListLatentClearResumeFacts;
  zeroRolloutModelControlVerified: boolean;
  modelControlResidual?: TerminalModelControlResidualObservation;
}): TerminalListTerminalFacts {
  return Object.freeze({
    physical: Object.freeze({
      terminalId: input.terminalId,
      childPids: Object.freeze([...input.childPids]),
      processIncarnation: input.processIncarnation
    }),
    status: Object.freeze({
      observed: input.observedState,
      effective: input.effectiveState,
      projected: input.projectedState,
      snapshot: input.snapshot,
      statusCardNativeThreadId: input.statusCardNativeThreadId,
      hasInteraction: input.terminalHasInteraction
    }),
    native: Object.freeze({ ...input.native }),
    runtime: input.runtime,
    composer: Object.freeze({ ...input.composer }),
    store: Object.freeze({
      terminalHasBlockingTurn: input.terminalHasBlockingTurn,
      hasOrphanedDispatch: input.hasOrphanedDispatch
    }),
    codex: Object.freeze({
      latentClearResume: input.latentClearResume,
      zeroRolloutModelControlVerified:
        input.zeroRolloutModelControlVerified
    }),
    modelControlResidual: input.modelControlResidual
  });
}

function terminalListStateWithOpenModelControlSurface(
  state: EffectiveTerminalListState
): EffectiveTerminalListState {
  const reason = "an exact native model-control surface is open";
  return {
    ...state,
    activity_state: "unknown",
    activity_reason: reason,
    screen_state: "unknown",
    screen_reason: reason
  };
}
