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
  type TerminalControlCapability,
  type TerminalControlRef,
  type TerminalDurableCompletionRequest,
  type TerminalNativeInspectionEvidenceInventoryEntry,
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
  type TerminalControlProvider,
  type TerminalViewport
} from "./terminal-control-provider.js";
import {
  hasCanonicalTerminalEndpoint,
  sameTerminalControlIncarnation,
  terminalEndpointFromControlRef,
  terminalEndpointIdentityKey,
  type TerminalEndpointRef,
  type TerminalProviderCapability
} from "./terminal-control-ref.js";

// Verified Codex profiles through 0.148.0 keep Enter in paste/newline mode for
// 120ms after burst input. Cross that boundary rather than landing on it, and
// also require observable composer stability instead of treating this delay
// alone as acceptance.
const CODEX_PASTE_ENTER_SETTLE_MS = 121;
const CODEX_MULTILINE_SETTLE_POLL_MS = 30;
// A capture can itself take longer than the old two-second deadline on a busy
// tmux server. Give repaint discovery a bounded five-second window and, once
// an exact frame has been observed, always allow the required stable/final
// captures to complete instead of letting the first I/O consume their budget.
const CODEX_MULTILINE_SETTLE_TIMEOUT_MS = 5_000;
const CODEX_MULTILINE_STABLE_CAPTURES = 2;
const CODEX_EXACT_CANDIDATE_GRACE_CAPTURES = 8;
const CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES = 240;
const CODEX_COMPOSER_MARKER = /^[›»](?:\s|$)/u;
const CODEX_COMPOSER_FOOTER =
  /^(?:gpt-[\w.-]+(?:\s|$)|[-\w.]+ default ·)/u;
const CODEX_COMPLETE_COMPOSER_FOOTER =
  /^(?:gpt-[\w.-]+(?:\s+\S+)?|[-\w.]+ default)\s+·\s+\S.*$/u;
// Keep every exact slash-completion shape closed per behavior profile so a
// version adding another matching command cannot silently become an authorized
// native command surface.
const CODEX_NATIVE_STATUS_POPUP_BY_PROFILE: Readonly<
  Record<string, readonly string[]>
> = {
  "codex-tui-0.146.0": [
    "  /status  show current session configuration and token usage"
  ],
  "codex-tui-0.146.1": [
    "  /status  show current session configuration and token usage"
  ],
  "codex-tui-0.147.0": [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ],
  "codex-tui-0.148.0": [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ]
};
// Codex's verified `/status` profiles are exercised against its canonical
// 80-column status surface. Narrower layouts can truncate the 36-character
// Session UUID after a dynamically sized label column. Exact provider geometry
// is required before input; ANSI visible-buffer width is only a conservative
// fallback diagnostic and never upgrades unknown geometry to safe.
const CODEX_NATIVE_STATUS_MIN_VIEWPORT_BY_PROFILE: Readonly<
  Record<string, number>
> = {
  "codex-tui-0.146.0": 80,
  "codex-tui-0.146.1": 80,
  "codex-tui-0.147.0": 80,
  "codex-tui-0.148.0": 80
};
const CLAUDE_NATIVE_STATUS_POPUP_BY_PROFILE: Readonly<
  Record<string, readonly string[]>
> = {
  "claude-code-2.1.218-native-status": [
    "/status Show Claude Code status including version, model, account, API connectivity, and tool statuses",
    "/statusline Set up Claude Code's status line UI",
    "/ide Manage IDE integrations and show status",
    "/usage Show session cost, plan usage, and activity stats"
  ],
  "claude-code-2.1.226-native-status": [
    "/status Show Claude Code status including version, model, account, API connectivity, and tool statuses",
    "/statusline Set up Claude Code's status line UI",
    "/ide Manage IDE integrations and show status",
    "/usage Show session cost, plan usage, and activity stats"
  ],
  "claude-code-2.1.237-native-status": [
    "/status Show Claude Code status including version, model, account, API connectivity, and tool statuses",
    "/statusline Set up Claude Code's status line UI",
    "/ide Manage IDE integrations and show status",
    "/usage Show session cost, plan usage, and activity stats"
  ]
};
const CLAUDE_NATIVE_STATUS_SETTLE_BY_PROFILE: Readonly<
  Record<string, { minimumStableMs: number; maximumSettleMs: number }>
> = {
  "claude-code-2.1.218-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 2_000
  },
  "claude-code-2.1.226-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.237-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  }
};
const CODEX_LARGE_PASTE_CHAR_THRESHOLD = 1_000;

/** A terminal send failed at a boundary that proves input never started. */
export class TerminalInputNotStartedError extends Error {
  readonly code = "AKK_TERMINAL_INPUT_NOT_STARTED";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "TerminalInputNotStartedError";
  }
}

/**
 * Text is already in the terminal composer, but this bridge invocation proved
 * that it never called the Enter transport boundary.
 *
 * Callers may persist this as narrow recovery evidence. It says nothing about
 * whether the draft remains exact or whether a later human action submitted
 * it; those facts must be re-observed under the terminal lock.
 */
export class TerminalEnterDispatchNotAttemptedError extends Error {
  readonly code = "AKK_TERMINAL_ENTER_DISPATCH_NOT_ATTEMPTED";
  readonly stage = "enter_not_attempted";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "TerminalEnterDispatchNotAttemptedError";
  }
}

/**
 * The caller's one-shot Enter reservation was invoked, so this recovery
 * attempt is permanently consumed even though C-m was not proven dispatched.
 */
export class TerminalEnterDispatchReservedError extends Error {
  readonly code = "AKK_TERMINAL_ENTER_DISPATCH_RESERVED";
  readonly stage = "enter_reserved";
  readonly doNotRetry = true;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "TerminalEnterDispatchReservedError";
  }
}

export type NativeInspectionSubmissionStage =
  | "not_started"
  | "text_injected"
  | "enter_uncertain";

/** Machine-readable reason for a closed native-inspection submission failure. */
export type NativeInspectionSubmissionDiagnostic =
  | "unsupported_profile"
  | "capability_unavailable"
  | "identity_unverified"
  | "composer_not_ready"
  | "viewport_too_narrow"
  | "viewport_unavailable"
  | "text_delivery_unproven"
  | "composer_viewport_truncated"
  | "composer_not_exact"
  | "composer_drift"
  | "evidence_unproven"
  | "enter_uncertain";

/**
 * A fail-closed native-inspection submission result.
 *
 * Only `not_started` proves that a caller may safely retry. Once text has
 * reached the composer, or Enter has been attempted, automated retries could
 * duplicate input or execute a different command after terminal drift.
 */
export class NativeInspectionSubmissionError extends Error {
  readonly code = "AKK_NATIVE_INSPECTION_SUBMISSION_FAILED";
  readonly doNotRetry: boolean;

  constructor(
    readonly stage: NativeInspectionSubmissionStage,
    message: string,
    options: {
      cause?: unknown;
      diagnostic?: NativeInspectionSubmissionDiagnostic;
    } = {}
  ) {
    super(message, options);
    this.name = "NativeInspectionSubmissionError";
    this.doNotRetry = stage !== "not_started";
    this.diagnostic = options.diagnostic;
  }

  readonly diagnostic?: NativeInspectionSubmissionDiagnostic;
}

class NativeInspectionDiagnosticError extends Error {
  constructor(
    readonly diagnostic: NativeInspectionSubmissionDiagnostic,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "NativeInspectionDiagnosticError";
  }
}

/** A verified modal could not be dismissed across one exact key attempt. */
export class NativeInspectionDismissalError extends Error {
  readonly code = "AKK_NATIVE_INSPECTION_DISMISSAL_FAILED";
  readonly doNotRetry = true;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "NativeInspectionDismissalError";
  }
}

export interface TerminalBridgeStatus {
  provider: string;
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

export type TerminalTransportStage = "text_injected" | "enter_dispatched";

export interface TerminalTransportStageEvent {
  stage: TerminalTransportStage;
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  multiline: boolean;
}

export interface TerminalSendBoundaryContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  multiline: boolean;
  text: string;
}

export interface TerminalSendOptions {
  runtime?: TerminalRuntimeIdentity;
  /** Runs after identity verification and immediately before text injection. */
  beforeText?: (
    context: TerminalSendBoundaryContext
  ) => void | Promise<void>;
  /** Runs after exact composer/identity proof and immediately before Enter. */
  beforeEnter?: (
    context: TerminalSendBoundaryContext
  ) => void | Promise<void>;
  /** Require Codex's exact stable composer proof even for a single-line send. */
  requireExactComposerBeforeEnter?: boolean;
  /**
   * Retry-only authority from a preliminary exact-empty observation. After
   * `beforeText` reserves the attempt, the bridge independently recaptures the
   * same empty composer and then immediately makes its sole text-delivery call.
   */
  requireExactEmptyComposerAfterBeforeText?: {
    preliminaryComposerDigest: string;
  };
  /**
   * Awaited immediately after each irreversible transport boundary so the
   * caller can durably persist the exact proof level before continuing.
   */
  onTransportStage?: (
    event: TerminalTransportStageEvent
  ) => void | Promise<void>;
}

export interface TerminalSendResult {
  stage: "enter_dispatched";
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  multiline: boolean;
}

interface TerminalCodexStableComposerObservationBase {
  terminalControl: TerminalControlRef;
  digest: string;
  stableCaptures: number;
}

type TerminalCodexObservedComposerState =
  | "exact_draft"
  | "exact_empty"
  | "different_draft"
  | "working"
  | "approval_or_modal";

/** Closed, content-redacting observation of the current Codex composer. */
export type TerminalCodexComposerObservation =
  | {
      [State in TerminalCodexObservedComposerState]:
        TerminalCodexStableComposerObservationBase & { state: State };
    }[TerminalCodexObservedComposerState]
  | {
      state: "identity_drift" | "unavailable";
      reason: string;
    };

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

type TerminalCodexCapturedComposerState = TerminalCodexObservedComposerState;

type TerminalCodexComposerSnapshot =
  | {
      [State in TerminalCodexCapturedComposerState]: {
        state: State;
        terminalControl: TerminalControlRef;
        digest: string;
      };
    }[TerminalCodexCapturedComposerState]
  | {
      state: "identity_drift";
      reason: string;
    }
  | {
      state: "unavailable";
      reason: string;
      /** A repaint may still materialize a classifiable live composer. */
      retryable?: false;
    }
  | {
      state: "unavailable";
      reason: string;
      retryable: true;
      terminalControl: TerminalControlRef;
      digest: string;
    };

export type TerminalNativeInspectionMaterializationKind =
  | "exact_slash_composer"
  | "exact_slash_popup";

export interface TerminalNativeInspectionMaterializationEvidence {
  kind: TerminalNativeInspectionMaterializationKind;
  digest: string;
  stableForMs: number;
  stableCaptures: number;
}

export interface TerminalNativeInspectionBeforeEnterContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  plan: TerminalNativeInspectionPlan;
  preEnterScreenDigest: string;
  materialization: TerminalNativeInspectionMaterializationEvidence;
}

export interface TerminalNativeInspectionOptions {
  runtime?: TerminalRuntimeIdentity;
  /**
   * Gives the CLI one final in-lock authorization point for its Store binding
   * and action-token fences. The bridge recaptures the exact composer and
   * revalidates terminal identity again after this hook before pressing Enter.
   */
  beforeEnter?: (
    context: TerminalNativeInspectionBeforeEnterContext
  ) => void | Promise<void>;
}

export interface TerminalNativeInspectionResult {
  stage: "enter_dispatched";
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  command: string;
  behaviorProfile: string;
  preEnterScreenDigest: string;
  preEnterEvidenceInventory:
    readonly TerminalNativeInspectionEvidenceInventoryEntry[];
  materialization: TerminalNativeInspectionMaterializationEvidence;
  enterCount: 1;
}

export interface TerminalCodexStatusProbeResult
  extends TerminalNativeInspectionResult {
  agent: "codex";
  /** Identity-fenced ANSI capture proving an empty/dim placeholder composer. */
  preTextScreenDigest: string;
  /**
   * Bare SHA-256 of the final pre-Enter 240-line capture. This deliberately
   * matches `status().screen.digest` when observed with the returned depth.
   */
  observationBaselineDigest: string;
  /** Capture depth required for same-domain post-Enter freshness checks. */
  observationScrollbackLines: 240;
}

export interface TerminalNativeInspectionBeforeDismissContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  plan: TerminalNativeInspectionPlan;
  evidenceFingerprint: string;
}

export interface TerminalNativeInspectionDismissalOptions {
  runtime?: TerminalRuntimeIdentity;
  scrollbackLines?: number;
  beforeDismiss?: (
    context: TerminalNativeInspectionBeforeDismissContext
  ) => void | Promise<void>;
}

export interface TerminalNativeInspectionDismissalResult {
  stage: "dismiss_dispatched";
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  keys: readonly string[];
  dismissCount: 1;
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
  private readonly nowMs: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: {
    registry: TerminalAgentAdapterRegistry;
    terminalProvider: TerminalControlProvider;
    verifyIdentity?: TerminalIdentityVerifier;
    nowMs?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.registry = options.registry;
    this.terminalProvider = options.terminalProvider;
    this.verifyIdentity = options.verifyIdentity;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.sleep = options.sleep ?? terminalSettleDelay;
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
    options: TerminalSendOptions = {}
  ): Promise<TerminalSendResult> {
    const adapter = this.registry.require(agent);
    const multiline = /[\r\n]/u.test(text.trimEnd());
    const exactEmptyRetryAuthority =
      options.requireExactEmptyComposerAfterBeforeText;
    const requireExactComposer =
      (adapter.agent === "codex" && multiline) ||
      options.requireExactComposerBeforeEnter === true ||
      exactEmptyRetryAuthority !== undefined;
    if (
      exactEmptyRetryAuthority !== undefined &&
      (
        adapter.agent !== "codex" ||
        options.beforeText === undefined ||
        !/^[0-9a-f]{64}$/u.test(
          exactEmptyRetryAuthority.preliminaryComposerDigest
        )
      )
    ) {
      throw new TerminalInputNotStartedError(
        "exact-empty replacement requires Codex, a reservation hook, and a preliminary composer digest"
      );
    }
    try {
      assertTerminalMutationCapabilities({
        provider: this.terminalProvider,
        terminal: this.terminalProvider.endpoint(terminalControl),
        semantic: [
          "send_keys",
          ...(requireExactComposer || exactEmptyRetryAuthority
            ? ["screen_status" as const]
            : [])
        ],
        transport: [
          "stable_resource_resolution",
          "text_delivery",
          "key_delivery",
          ...(requireExactComposer || exactEmptyRetryAuthority
            ? ["screen_capture" as const]
            : [])
        ]
      });
    } catch (error) {
      throw new TerminalInputNotStartedError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }
    const normalized = text.trimEnd();
    if (!normalized) {
      throw new TerminalInputNotStartedError("terminal message is empty");
    }
    let verifiedForText: TerminalControlRef;
    try {
      verifiedForText = await this.verifyTerminalIdentity(
        adapter.agent,
        terminalControl,
        options.runtime
      );
    } catch (error) {
      throw new TerminalInputNotStartedError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }
    if (!verifiedForText.capabilities.includes("send_keys")) {
      throw new TerminalInputNotStartedError(
        `${adapter.displayName} terminal input capability changed before injection`
      );
    }
    if (exactEmptyRetryAuthority) {
      try {
        // Invoking this retry-only hook consumes the durable attempt. The
        // independently identity-fenced recapture closes the human-edit race
        // before any physical text delivery.
        await options.beforeText?.({
          agent: adapter.agent,
          terminalControl: verifiedForText,
          multiline,
          text: normalized
        });
        const finalEmpty = await this.captureCodexComposerSnapshot(
          adapter,
          verifiedForText,
          normalized,
          options.runtime
        );
        if (
          finalEmpty.state !== "exact_empty" ||
          finalEmpty.digest !==
            exactEmptyRetryAuthority.preliminaryComposerDigest ||
          !sameTerminalControlIdentity(
            verifiedForText,
            finalEmpty.terminalControl
          )
        ) {
          const reason = "reason" in finalEmpty
            ? finalEmpty.reason
            : `Codex composer is ${finalEmpty.state}`;
          throw new Error(
            `reserved Codex replacement lost its exact-empty composer: ${reason}`
          );
        }
        verifiedForText = finalEmpty.terminalControl;
      } catch (error) {
        throw new TerminalEnterDispatchReservedError(
          error instanceof Error ? error.message : String(error),
          { cause: error }
        );
      }
    } else {
      try {
        await options.beforeText?.({
          agent: adapter.agent,
          terminalControl: verifiedForText,
          multiline,
          text: normalized
        });
      } catch (error) {
        throw new TerminalInputNotStartedError(
          error instanceof Error ? error.message : String(error),
          { cause: error }
        );
      }
    }
    try {
      await this.terminalProvider.sendText(
        this.terminalProvider.endpoint(verifiedForText),
        normalized
      );
    } catch (error) {
      if (exactEmptyRetryAuthority) {
        throw new TerminalEnterDispatchReservedError(
          "reserved Codex replacement text delivery outcome is uncertain; do not retry",
          { cause: error }
        );
      }
      if (error instanceof TerminalControlInputNotSentError) {
        throw new TerminalInputNotStartedError(error.message, {
          cause: error
        });
      }
      throw error;
    }
    let verifiedForEnter: TerminalControlRef;
    try {
      await options.onTransportStage?.({
        stage: "text_injected",
        agent: adapter.agent,
        terminalControl: verifiedForText,
        multiline
      });
      // Text and Enter are separate tmux operations. Revalidate between them
      // and never submit after identity or composer drift. Every failure in
      // this region is typed proof that this invocation did not call C-m.
      if (adapter.agent === "codex" && requireExactComposer) {
        verifiedForEnter = await this.settleCodexMultilineComposer(
          adapter,
          terminalControl,
          normalized,
          options.runtime,
          {
            allowOpaqueLargePastePlaceholder:
              exactEmptyRetryAuthority === undefined
          }
        );
      } else if (requireExactComposer) {
        verifiedForEnter = await this.verifyExactComposerBeforeEnter(
          adapter,
          terminalControl,
          normalized,
          options.runtime
        );
      } else {
        verifiedForEnter = await this.verifyTerminalIdentity(
          adapter.agent,
          terminalControl,
          options.runtime
        );
      }
      await options.beforeEnter?.({
        agent: adapter.agent,
        terminalControl: verifiedForEnter,
        multiline,
        text: normalized
      });
      // `beforeEnter` may await Store and terminal identity fences. The human
      // can still edit the composer or change the native thread while that
      // callback is pending, so recapture before attempting Enter.
      if (requireExactComposer) {
        verifiedForEnter = adapter.agent === "codex"
          ? await this.settleCodexMultilineComposer(
            adapter,
            terminalControl,
            normalized,
            options.runtime,
            {
              allowOpaqueLargePastePlaceholder:
                exactEmptyRetryAuthority === undefined
            }
          )
          : await this.verifyExactComposerBeforeEnter(
            adapter,
            terminalControl,
            normalized,
            options.runtime
          );
      } else if (options.beforeEnter) {
        verifiedForEnter = await this.verifyTerminalIdentity(
          adapter.agent,
          terminalControl,
          options.runtime
        );
      }
    } catch (error) {
      if (exactEmptyRetryAuthority) {
        if (error instanceof TerminalEnterDispatchReservedError) {
          throw error;
        }
        throw new TerminalEnterDispatchReservedError(
          error instanceof Error ? error.message : String(error),
          { cause: error }
        );
      }
      if (error instanceof TerminalEnterDispatchNotAttemptedError) {
        throw error;
      }
      throw new TerminalEnterDispatchNotAttemptedError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }
    // Do not include this transport call (or anything after it) in the typed
    // pre-Enter proof: a thrown key-delivery error may still have emitted C-m.
    try {
      await this.terminalProvider.sendKeys(
        this.terminalProvider.endpoint(verifiedForEnter),
        ["C-m"]
      );
      await options.onTransportStage?.({
        stage: "enter_dispatched",
        agent: adapter.agent,
        terminalControl: verifiedForEnter,
        multiline
      });
    } catch (error) {
      if (exactEmptyRetryAuthority) {
        throw new TerminalEnterDispatchReservedError(
          "reserved Codex Enter dispatch outcome is uncertain; do not retry",
          { cause: error }
        );
      }
      throw error;
    }
    return {
      stage: "enter_dispatched",
      agent: adapter.agent,
      terminalControl: verifiedForEnter,
      multiline
    };
  }

  /** Observe only the current, live Codex composer without exposing its text. */
  async observeCodexComposer(
    terminalControl: TerminalControlRef,
    expectedText: string,
    options: { runtime?: TerminalRuntimeIdentity } = {}
  ): Promise<TerminalCodexComposerObservation> {
    const adapter = this.registry.require("codex");
    const normalized = expectedText.trimEnd();
    if (!normalized) {
      return {
        state: "unavailable",
        reason: "expected Codex draft is empty"
      };
    }
    try {
      assertTerminalMutationCapabilities({
        provider: this.terminalProvider,
        terminal: this.terminalProvider.endpoint(terminalControl),
        semantic: ["screen_status"],
        transport: ["stable_resource_resolution", "screen_capture"]
      });
    } catch (error) {
      return {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    return this.settleCodexComposerObservation(
      adapter,
      terminalControl,
      normalized,
      options.runtime,
      { minimumStableMs: CODEX_MULTILINE_SETTLE_POLL_MS }
    );
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
      const observation = await this.settleCodexComposerObservation(
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

    let finalObservation: Extract<
      TerminalCodexComposerSnapshot,
      { state: "exact_draft" }
    >;
    try {
      // Calling this hook is itself the one-shot boundary. A throw may occur
      // after durable storage committed, so every failure from here onward
      // permanently consumes the attempt.
      await options.beforeEnterReservation({
        terminalControl: preliminaryObservation.terminalControl,
        text: normalized,
        composerDigest: preliminaryObservation.digest
      });
      const recaptured = await this.captureCodexComposerSnapshot(
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

  private async verifyExactComposerBeforeEnter(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime?: TerminalRuntimeIdentity
  ): Promise<TerminalControlRef> {
    const captured = await this.captureInspection(adapter, terminalControl, {
      runtime,
      scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
    });
    const exactComposer = exactTerminalComposerCapture(
      adapter.agent,
      captured.screen,
      expectedText
    );
    if (
      captured.inspection.approval.blocked ||
      !["idle", "unknown"].includes(captured.inspection.activity.state) ||
      !exactComposer
    ) {
      throw new Error(
        `${adapter.displayName} composer was not exact and idle immediately before Enter`
      );
    }
    const verifiedImmediatelyBeforeEnter = await this.verifyTerminalIdentity(
      adapter.agent,
      captured.terminalControl,
      runtime
    );
    if (
      !sameTerminalControlIdentity(
        captured.terminalControl,
        verifiedImmediatelyBeforeEnter
      )
    ) {
      throw new Error(
        "terminal control identity changed after the final exact composer capture"
      );
    }
    return verifiedImmediatelyBeforeEnter;
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
    return this.submitClosedNativeInspection(
      agent,
      terminalControl,
      plan,
      options,
      { requireCodexReadyComposer: agent === "codex" }
    );
  }

  /**
   * Submit Codex's closed, version-profiled `/status` probe.
   *
   * Unlike the generic native-inspection entry point, callers provide only
   * the detected Codex version, never a command or plan. The bridge proves an
   * exact empty (or fully dim replace-on-type) ANSI composer before injecting
   * text, then crosses Codex's paste suppression window under the same exact
   * composer and terminal-identity fences used by native inspection.
   */
  async submitCodexStatusProbe(
    terminalControl: TerminalControlRef,
    agentVersion: string,
    options: TerminalNativeInspectionOptions = {}
  ): Promise<TerminalCodexStatusProbeResult> {
    const adapter = this.registry.require("codex");
    let plan: TerminalNativeInspectionPlan;
    try {
      const capability = adapter.probeNativeInspection?.(agentVersion);
      if (
        capability?.status !== "supported" ||
        capability.statusInspection !== true
      ) {
        throw new NativeInspectionDiagnosticError(
          "unsupported_profile",
          capability?.reason ??
            `Codex ${agentVersion} has no closed /status behavior profile`
        );
      }
      const planned = adapter.planNativeInspection?.(
        { kind: "status" },
        capability
      );
      if (!planned) {
        throw new NativeInspectionDiagnosticError(
          "unsupported_profile",
          `Codex ${agentVersion} did not produce a closed /status plan`
        );
      }
      plan = planned;
    } catch (error) {
      throw nativeInspectionSubmissionError(
        "not_started",
        error,
        "unsupported_profile"
      );
    }

    const result = await this.submitClosedNativeInspection(
      "codex",
      terminalControl,
      plan,
      options,
      { requireCodexReadyComposer: true }
    );
    if (!result.preTextScreenDigest) {
      throw new Error("Codex /status pre-text composer evidence is missing");
    }
    return {
      ...result,
      agent: "codex",
      preTextScreenDigest: result.preTextScreenDigest,
      observationBaselineDigest:
        bareDigestFromNativeInspectionScreenFingerprint(
          result.preEnterScreenDigest
        ),
      observationScrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
    };
  }

  private async submitClosedNativeInspection(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    plan: TerminalNativeInspectionPlan,
    options: TerminalNativeInspectionOptions,
    safety: { requireCodexReadyComposer?: boolean } = {}
  ): Promise<TerminalNativeInspectionResult & {
    preTextScreenDigest?: string;
  }> {
    const adapter = this.registry.require(agent);
    try {
      assertClosedStatusInspectionPlan(adapter, terminalControl, plan);
      assertTerminalMutationCapabilities({
        provider: this.terminalProvider,
        terminal: this.terminalProvider.endpoint(terminalControl),
        semantic: ["send_keys", "screen_status"],
        transport: [
          "stable_resource_resolution",
          "screen_capture",
          "text_delivery",
          "key_delivery",
          ...(safety.requireCodexReadyComposer
            ? ["ansi_capture" as const]
            : [])
        ]
      });
    } catch (error) {
      throw nativeInspectionSubmissionError(
        "not_started",
        error,
        "capability_unavailable"
      );
    }

    let verifiedForText: TerminalControlRef;
    try {
      verifiedForText = await this.verifyTerminalIdentity(
        adapter.agent,
        terminalControl,
        options.runtime
      );
    } catch (error) {
      throw nativeInspectionSubmissionError(
        "not_started",
        error,
        "identity_unverified"
      );
    }

    let preTextScreenDigest: string | undefined;
    if (safety.requireCodexReadyComposer) {
      try {
        const ready = await this.captureCodexReadyComposer(
          adapter,
          verifiedForText,
          plan,
          options.runtime
        );
        verifiedForText = ready.terminalControl;
        preTextScreenDigest = ready.screenDigest;
      } catch (error) {
        throw nativeInspectionSubmissionError(
          "not_started",
          error,
          "composer_not_ready"
        );
      }
    }

    try {
      if (!verifiedForText.capabilities.includes("send_keys")) {
        throw new TerminalControlInputNotSentError(
          `${adapter.displayName} native inspection input capability changed`
        );
      }
      await this.terminalProvider.sendText(
        this.terminalProvider.endpoint(verifiedForText),
        plan.command
      );
    } catch (error) {
      if (error instanceof TerminalControlInputNotSentError) {
        throw nativeInspectionSubmissionError(
          "not_started",
          error,
          "text_delivery_unproven"
        );
      }
      // The transport cannot prove whether an untyped failure happened before
      // or after tmux accepted the literal input. Fail closed as injected.
      throw nativeInspectionSubmissionError(
        "text_injected",
        error,
        "text_delivery_unproven"
      );
    }

    let settled: {
      terminalControl: TerminalControlRef;
      screenDigest: string;
      evidenceInventory:
        readonly TerminalNativeInspectionEvidenceInventoryEntry[];
      materialization: TerminalNativeInspectionMaterializationEvidence;
    };
    try {
      settled = await this.settleNativeInspectionComposer(
        adapter,
        terminalControl,
        plan,
        options.runtime
      );
      await options.beforeEnter?.({
        agent: adapter.agent,
        terminalControl: settled.terminalControl,
        plan,
        preEnterScreenDigest: settled.screenDigest,
        materialization: settled.materialization
      });
      if (safety.requireCodexReadyComposer) {
        settled = {
          ...settled,
          terminalControl: await this.assertFinalCodexStatusViewport(
            settled.terminalControl,
            plan,
            options.runtime
          )
        };
      }
      // Viewport inspection may await provider I/O and the PTY may receive
      // human input while that proof is in flight. Keep the exact composer
      // capture as the final substantive asynchronous evidence before the
      // single Enter attempt.
      settled = await this.revalidateNativeInspectionComposer(
        adapter,
        settled.terminalControl,
        plan,
        settled.materialization,
        options.runtime
      );
    } catch (error) {
      throw nativeInspectionSubmissionError(
        "text_injected",
        error,
        "composer_not_exact"
      );
    }

    try {
      // Exactly one Enter attempt. Any error is submission-uncertain and must
      // never trigger a fallback executable or a blind second Enter.
      await this.terminalProvider.sendKeys(
        this.terminalProvider.endpoint(settled.terminalControl),
        ["C-m"]
      );
    } catch (error) {
      throw nativeInspectionSubmissionError(
        "enter_uncertain",
        error,
        "enter_uncertain"
      );
    }

    return {
      stage: "enter_dispatched",
      agent: adapter.agent,
      terminalControl: settled.terminalControl,
      command: plan.command,
      behaviorProfile: plan.behaviorProfile,
      preEnterScreenDigest: settled.screenDigest,
      preEnterEvidenceInventory: settled.evidenceInventory,
      materialization: settled.materialization,
      enterCount: 1,
      ...(preTextScreenDigest ? { preTextScreenDigest } : {})
    };
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
    const adapter = this.registry.require(agent);
    if (!adapter.observeNativeInspection) {
      throw new Error(
        `${adapter.displayName} native inspection observation is not supported`
      );
    }
    const captured = await this.captureInspection(adapter, terminalControl, {
      runtime: options.runtime,
      scrollbackLines: options.scrollbackLines
    });
    const screenDigest = nativeInspectionScreenFingerprint(captured.screen);
    const adapterObservation = adapter.observeNativeInspection({
      operation: request.operation,
      previousScreenFingerprint: request.previousScreenFingerprint,
      preEnterEvidenceInventory: request.preEnterEvidenceInventory,
      expectedNativeThreadId: request.expectedNativeThreadId,
      expectedAgentVersion: request.expectedAgentVersion,
      expectedCwd: request.expectedCwd,
      screen: captured.screen
    });
    const observation =
      adapter.agent === "claude" &&
      options.runtime?.requireExactClaudeAgentRow === true &&
      adapterObservation.status === "observed" &&
      adapterObservation.evidence === "claude_status_panel"
        ? {
            ...adapterObservation,
            evidence: "claude_status_panel+claude_agents_exact_pid"
          }
        : adapterObservation;
    return {
      terminalControl: captured.terminalControl,
      status: statusFromInspection(
        adapter,
        captured.terminalControl,
        captured.inspection,
        { screen: captured.screen, runtime: options.runtime }
      ),
      screenDigest,
      observation
    };
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
    const adapter = this.registry.require(agent);
    try {
      assertClosedStatusInspectionPlan(adapter, terminalControl, plan);
      assertClosedNativeInspectionDismissal(plan);
    } catch (error) {
      throw new NativeInspectionDismissalError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }

    const observeExactPanel = async (
      control: TerminalControlRef
    ): Promise<TerminalControlRef> => {
      const captured = await this.captureInspection(adapter, control, {
        runtime: options.runtime,
        scrollbackLines: options.scrollbackLines
      });
      const observation = adapter.observeNativeInspection?.({
        operation: request.operation,
        previousScreenFingerprint: request.previousScreenFingerprint,
        preEnterEvidenceInventory: request.preEnterEvidenceInventory,
        expectedNativeThreadId: request.expectedNativeThreadId,
        expectedAgentVersion: request.expectedAgentVersion,
        expectedCwd: request.expectedCwd,
        screen: captured.screen
      });
      if (
        !observation ||
        observation.status !== "observed" ||
        observation.result?.kind !== "native_status" ||
        observation.evidenceFingerprint !== expectedEvidenceFingerprint
      ) {
        throw new Error(
          observation?.reason ??
          "the exact fresh native status panel changed before dismissal"
        );
      }
      const verified = await this.verifyTerminalIdentity(
        adapter.agent,
        captured.terminalControl,
        options.runtime
      );
      if (!sameTerminalControlIdentity(captured.terminalControl, verified)) {
        throw new Error(
          "terminal control identity changed before native status dismissal"
        );
      }
      return verified;
    };

    try {
      let verified = await observeExactPanel(terminalControl);
      await options.beforeDismiss?.({
        agent: adapter.agent,
        terminalControl: verified,
        plan,
        evidenceFingerprint: expectedEvidenceFingerprint
      });
      verified = await observeExactPanel(verified);
      try {
        await this.terminalProvider.sendKeys(
          this.terminalProvider.endpoint(verified),
          plan.expectedResult.dismissal!.keys
        );
      } catch (error) {
        throw new NativeInspectionDismissalError(
          "native status modal dismissal outcome is uncertain; do not retry automatically",
          { cause: error }
        );
      }
      return {
        stage: "dismiss_dispatched",
        agent: adapter.agent,
        terminalControl: verified,
        keys: plan.expectedResult.dismissal!.keys,
        dismissCount: 1
      };
    } catch (error) {
      if (error instanceof NativeInspectionDismissalError) {
        throw error;
      }
      throw new NativeInspectionDismissalError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }
  }

  private async captureCodexReadyComposer(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    plan: TerminalNativeInspectionPlan,
    runtime?: TerminalRuntimeIdentity
  ): Promise<{
    terminalControl: TerminalControlRef;
    screenDigest: string;
  }> {
    if (adapter.agent !== "codex") {
      throw new NativeInspectionDiagnosticError(
        "unsupported_profile",
        "the closed Codex /status probe requires the Codex adapter"
      );
    }
    const minimumViewport =
      CODEX_NATIVE_STATUS_MIN_VIEWPORT_BY_PROFILE[plan.behaviorProfile];
    if (minimumViewport === undefined) {
      throw new NativeInspectionDiagnosticError(
        "unsupported_profile",
        `Codex ${plan.behaviorProfile} has no exact /status viewport profile`
      );
    }

    const captureReady = async (control: TerminalControlRef) => {
      const verified = await this.verifyTerminalIdentity(
        adapter.agent,
        control,
        runtime
      );
      const endpoint = this.terminalProvider.endpoint(verified);
      const viewportInspector = this.terminalProvider.inspectViewport;
      let exactViewport: number | undefined;
      let viewportUnavailableReason =
        "terminal provider has no exact viewport inspector";
      if (viewportInspector) {
        let viewport: TerminalViewport | undefined;
        try {
          viewport = await viewportInspector.call(
            this.terminalProvider,
            endpoint
          );
        } catch (error) {
          throw new NativeInspectionDiagnosticError(
            "viewport_unavailable",
            `Codex /status viewport inspection failed before terminal input: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error }
          );
        }
        if (viewport) {
          if (
            !Number.isSafeInteger(viewport.columns) ||
            viewport.columns <= 0 ||
            !Number.isSafeInteger(viewport.rows) ||
            viewport.rows <= 0
          ) {
            throw new NativeInspectionDiagnosticError(
              "viewport_unavailable",
              "Codex /status viewport inspector returned invalid geometry"
            );
          }
          exactViewport = viewport.columns;
        } else {
          viewportUnavailableReason =
            "terminal provider could not prove exact viewport geometry";
        }
      }
      const styledScreen = await this.terminalProvider.capture(
        endpoint,
        { scrollbackLines: 40, preserveEscapes: true }
      );
      const plainScreen = stripTerminalEscapeSequences(styledScreen);
      const inspection = adapter.inspectScreen({ screen: plainScreen, runtime });
      assertNativeInspectionComposerSafe(inspection, adapter.displayName);
      const composer = exactCodexReadyStyledComposerCapture(styledScreen);
      if (!composer) {
        throw new NativeInspectionDiagnosticError(
          "composer_not_ready",
          "Codex composer contains non-placeholder input or is not at the exact idle prompt"
        );
      }
      const inferredViewport = inferCodexVisibleViewportColumns(styledScreen);
      const observedViewport = exactViewport ?? inferredViewport;
      if (
        (observedViewport !== undefined && observedViewport < minimumViewport) ||
        hasTruncatedCodexStatusSessionLine(plainScreen)
      ) {
        throw new NativeInspectionDiagnosticError(
          "viewport_too_narrow",
          `Codex /status requires a proven viewport of at least ` +
            `${minimumViewport} columns to preserve the complete Session UUID` +
            `${observedViewport === undefined
              ? ""
              : `; observed ${observedViewport}`}; widen or zoom the pane before retrying`
        );
      }
      if (exactViewport === undefined) {
        throw new NativeInspectionDiagnosticError(
          "viewport_unavailable",
          `Codex /status requires exact terminal viewport geometry before input; ` +
            viewportUnavailableReason +
            `${inferredViewport === undefined
              ? ""
              : ` (ANSI fallback estimated ${inferredViewport} columns)`}`
        );
      }
      const reverified = await this.verifyTerminalIdentity(
        adapter.agent,
        verified,
        runtime
      );
      if (!sameTerminalControlIdentity(verified, reverified)) {
        throw new NativeInspectionDiagnosticError(
          "identity_unverified",
          "terminal control identity changed after the Codex pre-text composer capture"
        );
      }
      return {
        terminalControl: reverified,
        screenDigest: nativeInspectionScreenFingerprint(styledScreen),
        composerDigest: composer.digest
      };
    };

    const first = await captureReady(terminalControl);
    const second = await captureReady(first.terminalControl);
    if (second.composerDigest !== first.composerDigest) {
      throw new NativeInspectionDiagnosticError(
        "composer_not_ready",
        "Codex empty composer changed across its stable pre-text captures"
      );
    }
    return {
      terminalControl: second.terminalControl,
      screenDigest: second.screenDigest
    };
  }

  private async assertFinalCodexStatusViewport(
    terminalControl: TerminalControlRef,
    plan: TerminalNativeInspectionPlan,
    runtime?: TerminalRuntimeIdentity
  ): Promise<TerminalControlRef> {
    const minimumViewport =
      CODEX_NATIVE_STATUS_MIN_VIEWPORT_BY_PROFILE[plan.behaviorProfile];
    if (minimumViewport === undefined) {
      throw new NativeInspectionDiagnosticError(
        "unsupported_profile",
        `Codex ${plan.behaviorProfile} has no exact /status viewport profile`
      );
    }
    const verified = await this.verifyTerminalIdentity(
      "codex",
      terminalControl,
      runtime
    );
    const viewportInspector = this.terminalProvider.inspectViewport;
    if (!viewportInspector) {
      throw new NativeInspectionDiagnosticError(
        "viewport_unavailable",
        "Codex /status requires exact terminal viewport geometry immediately before Enter"
      );
    }
    let viewport: TerminalViewport | undefined;
    try {
      viewport = await viewportInspector.call(
        this.terminalProvider,
        this.terminalProvider.endpoint(verified)
      );
    } catch (error) {
      throw new NativeInspectionDiagnosticError(
        "viewport_unavailable",
        `Codex /status viewport inspection failed immediately before Enter: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
    if (
      !viewport ||
      !Number.isSafeInteger(viewport.columns) ||
      viewport.columns <= 0 ||
      !Number.isSafeInteger(viewport.rows) ||
      viewport.rows <= 0
    ) {
      throw new NativeInspectionDiagnosticError(
        "viewport_unavailable",
        "Codex /status exact terminal viewport became unavailable immediately before Enter"
      );
    }
    if (viewport.columns < minimumViewport) {
      throw new NativeInspectionDiagnosticError(
        "viewport_too_narrow",
        `Codex /status viewport narrowed to ${viewport.columns} columns before Enter; ` +
          `at least ${minimumViewport} are required to preserve the complete Session UUID`
      );
    }
    const reverified = await this.verifyTerminalIdentity(
      "codex",
      verified,
      runtime
    );
    if (!sameTerminalControlIdentity(verified, reverified)) {
      throw new NativeInspectionDiagnosticError(
        "identity_unverified",
        "terminal control identity changed after the final Codex viewport proof"
      );
    }
    return reverified;
  }

  private async settleNativeInspectionComposer(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    plan: TerminalNativeInspectionPlan,
    runtime?: TerminalRuntimeIdentity
  ): Promise<{
    terminalControl: TerminalControlRef;
    screenDigest: string;
    evidenceInventory:
      readonly TerminalNativeInspectionEvidenceInventoryEntry[];
    materialization: TerminalNativeInspectionMaterializationEvidence;
  }> {
    const startedAt = this.nowMs();
    const settleTimeoutMs = plan.composer.maximumSettleMs;
    let stableDigest: string | undefined;
    let stableKind: TerminalNativeInspectionMaterializationKind | undefined;
    let stableSince: number | undefined;
    let stableCaptures = 0;
    let lastMismatchDiagnostic: NativeInspectionSubmissionDiagnostic =
      "composer_not_exact";

    while (this.nowMs() - startedAt <= settleTimeoutMs) {
      const captured = await this.captureInspection(adapter, terminalControl, {
        runtime,
        scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
      });
      assertNativeInspectionComposerSafe(captured.inspection);
      const materialized = exactNativeInspectionComposerCapture(
        adapter.agent,
        captured.screen,
        plan
      );
      const now = this.nowMs();
      if (materialized) {
        if (
          materialized.digest === stableDigest &&
          materialized.kind === stableKind
        ) {
          stableCaptures += 1;
        } else {
          stableDigest = materialized.digest;
          stableKind = materialized.kind;
          stableSince = now;
          stableCaptures = 1;
        }
        const stableForMs = stableSince === undefined ? 0 : now - stableSince;
        if (
          stableCaptures >= CODEX_MULTILINE_STABLE_CAPTURES &&
          stableForMs >= plan.composer.minimumStableMs
        ) {
          const evidence = {
            kind: materialized.kind,
            digest: materialized.digest,
            stableForMs,
            stableCaptures
          } satisfies TerminalNativeInspectionMaterializationEvidence;
          return this.revalidateNativeInspectionComposer(
            adapter,
            captured.terminalControl,
            plan,
            evidence,
            runtime
          );
        }
      } else {
        lastMismatchDiagnostic = adapter.agent === "codex"
          ? codexNativeInspectionComposerMismatchDiagnostic(
              captured.screen,
              plan
            )
          : "composer_not_exact";
        stableDigest = undefined;
        stableKind = undefined;
        stableSince = undefined;
        stableCaptures = 0;
      }

      const elapsed = this.nowMs() - startedAt;
      const remaining = settleTimeoutMs - elapsed;
      if (remaining <= 0) {
        break;
      }
      await this.sleep(Math.min(
        CODEX_MULTILINE_SETTLE_POLL_MS,
        remaining
      ));
    }
    throw new NativeInspectionDiagnosticError(
      lastMismatchDiagnostic,
      lastMismatchDiagnostic === "composer_viewport_truncated"
        ? `${adapter.displayName} /status slash popup was truncated by the viewport; widen or zoom the pane before retrying manually`
        : `${adapter.displayName} /status composer did not become exact, idle, and stable before the bounded submit deadline`
    );
  }

  private async revalidateNativeInspectionComposer(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    plan: TerminalNativeInspectionPlan,
    expected: TerminalNativeInspectionMaterializationEvidence,
    runtime?: TerminalRuntimeIdentity
  ): Promise<{
    terminalControl: TerminalControlRef;
    screenDigest: string;
    evidenceInventory:
      readonly TerminalNativeInspectionEvidenceInventoryEntry[];
    materialization: TerminalNativeInspectionMaterializationEvidence;
  }> {
    const captured = await this.captureInspection(adapter, terminalControl, {
      runtime,
      scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
    });
    assertNativeInspectionComposerSafe(captured.inspection);
    const materialized = exactNativeInspectionComposerCapture(
      adapter.agent,
      captured.screen,
      plan
    );
    if (
      !materialized ||
      materialized.digest !== expected.digest ||
      materialized.kind !== expected.kind
    ) {
      throw new NativeInspectionDiagnosticError(
        "composer_drift",
        `${adapter.displayName} /status composer changed after its stable pre-submit capture`
      );
    }
    const baseline = adapter.observeNativeInspection?.({
      operation: plan.operation,
      screen: captured.screen
    });
    if (
      !baseline ||
      baseline.status === "ambiguous" ||
      !Array.isArray(baseline.evidenceInventory)
    ) {
      throw new NativeInspectionDiagnosticError(
        "evidence_unproven",
        baseline?.reason ??
          `${adapter.displayName} /status pre-Enter evidence inventory was not proven`
      );
    }
    const verifiedImmediatelyBeforeEnter = await this.verifyTerminalIdentity(
      adapter.agent,
      captured.terminalControl,
      runtime
    );
    if (
      !sameTerminalControlIdentity(
        captured.terminalControl,
        verifiedImmediatelyBeforeEnter
      )
    ) {
      throw new NativeInspectionDiagnosticError(
        "identity_unverified",
        `terminal control identity changed after the final ${adapter.displayName} /status composer capture`
      );
    }
    return {
      terminalControl: verifiedImmediatelyBeforeEnter,
      screenDigest: nativeInspectionScreenFingerprint(captured.screen),
      evidenceInventory: baseline.evidenceInventory,
      materialization: expected
    };
  }

  private async settleCodexMultilineComposer(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime?: TerminalRuntimeIdentity,
    options: { allowOpaqueLargePastePlaceholder?: boolean } = {}
  ): Promise<TerminalControlRef> {
    const observation = await this.settleCodexComposerObservation(
      adapter,
      terminalControl,
      expectedText,
      runtime,
      {
        minimumStableMs: CODEX_PASTE_ENTER_SETTLE_MS,
        requiredState: "exact_draft",
        allowOpaqueLargePastePlaceholder:
          options.allowOpaqueLargePastePlaceholder === true
      }
    );
    if (observation.state === "exact_draft") {
      return observation.terminalControl;
    }
    if (
      observation.state === "working" ||
      observation.state === "approval_or_modal"
    ) {
      throw new Error(
        "Codex became busy or blocked while its multiline composer was settling"
      );
    }
    if (observation.state === "identity_drift") {
      throw new Error(observation.reason);
    }
    throw new Error(
      "Codex multiline composer did not become exact, idle, and stable before the bounded submit deadline"
    );
  }

  private async settleCodexComposerObservation(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime: TerminalRuntimeIdentity | undefined,
    options: {
      minimumStableMs: number;
      requiredState?: TerminalCodexCapturedComposerState;
      allowOpaqueLargePastePlaceholder?: boolean;
    }
  ): Promise<TerminalCodexComposerObservation> {
    const startedAt = this.nowMs();
    let candidate: Extract<
      TerminalCodexComposerSnapshot,
      { terminalControl: TerminalControlRef }
    > | undefined;
    let stableSince: number | undefined;
    let stableCaptures = 0;
    let finishObservedExactCandidate = false;
    let capturesBeyondDeadline = 0;
    let control = terminalControl;

    while (true) {
      const snapshot = await this.captureCodexComposerSnapshot(
        adapter,
        control,
        expectedText,
        runtime,
        {
          allowOpaqueLargePastePlaceholder:
            options.allowOpaqueLargePastePlaceholder === true
        }
      );
      if (
        snapshot.state === "identity_drift" ||
        (snapshot.state === "unavailable" && snapshot.retryable !== true)
      ) {
        return snapshot;
      }
      if (this.nowMs() - startedAt > CODEX_MULTILINE_SETTLE_TIMEOUT_MS) {
        capturesBeyondDeadline += 1;
        if (
          capturesBeyondDeadline > CODEX_EXACT_CANDIDATE_GRACE_CAPTURES
        ) {
          return {
            state: "unavailable",
            reason: "Codex exact composer did not stabilize within its bounded capture grace"
          };
        }
      }
      control = snapshot.terminalControl;
      const sameCandidate = candidate !== undefined &&
        candidate.state === snapshot.state &&
        candidate.digest === snapshot.digest &&
        sameTerminalControlIdentity(
          candidate.terminalControl,
          snapshot.terminalControl
        );
      if (sameCandidate) {
        stableCaptures += 1;
      } else {
        candidate = snapshot;
        stableSince = this.nowMs();
        stableCaptures = 1;
        finishObservedExactCandidate = snapshot.state === "exact_draft";
      }

      const stableForMs = stableSince === undefined
        ? 0
        : this.nowMs() - stableSince;
      if (
        stableCaptures >= CODEX_MULTILINE_STABLE_CAPTURES &&
        stableForMs >= options.minimumStableMs &&
        snapshot.state !== "unavailable" &&
        (
          options.requiredState === undefined ||
          snapshot.state === options.requiredState ||
          snapshot.state === "working" ||
          snapshot.state === "approval_or_modal"
        )
      ) {
        // The caller's authorization hook must see evidence from a final,
        // independently identity-fenced recapture, not the polling capture.
        const finalSnapshot = await this.captureCodexComposerSnapshot(
          adapter,
          snapshot.terminalControl,
          expectedText,
          runtime,
          {
            allowOpaqueLargePastePlaceholder:
              options.allowOpaqueLargePastePlaceholder === true
          }
        );
        if (
          finalSnapshot.state === snapshot.state &&
          "digest" in finalSnapshot &&
          finalSnapshot.digest === snapshot.digest &&
          sameTerminalControlIdentity(
            snapshot.terminalControl,
            finalSnapshot.terminalControl
          )
        ) {
          return {
            ...finalSnapshot,
            stableCaptures: stableCaptures + 1
          };
        }
        if (
          finalSnapshot.state === "identity_drift" ||
          (
            finalSnapshot.state === "unavailable" &&
            finalSnapshot.retryable !== true
          )
        ) {
          return finalSnapshot;
        }
        if (
          options.requiredState !== undefined &&
          snapshot.state === options.requiredState
        ) {
          return {
            state: "unavailable",
            reason: "Codex composer changed after its stable final recapture"
          };
        }
        candidate = finalSnapshot;
        control = finalSnapshot.terminalControl;
        stableSince = this.nowMs();
        stableCaptures = 1;
        finishObservedExactCandidate = finalSnapshot.state === "exact_draft";
      }

      const elapsed = this.nowMs() - startedAt;
      if (
        elapsed > CODEX_MULTILINE_SETTLE_TIMEOUT_MS &&
        !finishObservedExactCandidate
      ) {
        return {
          state: "unavailable",
          reason: options.requiredState
            ? `Codex composer did not become ${options.requiredState} before the bounded observation deadline`
            : "Codex composer did not become stable before the bounded observation deadline"
        };
      }
      if (
        elapsed > CODEX_MULTILINE_SETTLE_TIMEOUT_MS &&
        options.requiredState !== undefined &&
        snapshot.state !== options.requiredState
      ) {
        if (snapshot.state !== "unavailable") {
          return {
            ...snapshot,
            stableCaptures
          };
        }
        return {
          state: "unavailable",
          reason: snapshot.reason
        };
      }

      const remainingStableMs = options.minimumStableMs - stableForMs;
      await this.sleep(Math.max(
        1,
        Math.min(
          CODEX_MULTILINE_SETTLE_POLL_MS,
          remainingStableMs > 0
            ? remainingStableMs
            : CODEX_MULTILINE_SETTLE_POLL_MS
        )
      ));
    }
  }

  private async captureCodexComposerSnapshot(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime?: TerminalRuntimeIdentity,
    options: { allowOpaqueLargePastePlaceholder?: boolean } = {}
  ): Promise<TerminalCodexComposerSnapshot> {
    let verifiedBefore: TerminalControlRef;
    try {
      verifiedBefore = await this.verifyTerminalIdentity(
        adapter.agent,
        terminalControl,
        runtime
      );
    } catch (error) {
      return {
        state: "identity_drift",
        reason: error instanceof Error ? error.message : String(error)
      };
    }

    let styledScreen: string;
    try {
      styledScreen = await this.terminalProvider.capture(
        this.terminalProvider.endpoint(verifiedBefore),
        {
          scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES,
          preserveEscapes: true
        }
      );
    } catch (error) {
      return {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    const screen = stripTerminalEscapeSequences(styledScreen);
    let inspection: TerminalScreenInspection;
    try {
      inspection = adapter.inspectScreen({ screen, runtime });
    } catch (error) {
      return {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error)
      };
    }

    let verifiedAfter: TerminalControlRef;
    try {
      verifiedAfter = await this.verifyTerminalIdentity(
        adapter.agent,
        verifiedBefore,
        runtime
      );
    } catch (error) {
      return {
        state: "identity_drift",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    if (!sameTerminalControlIdentity(verifiedBefore, verifiedAfter)) {
      return {
        state: "identity_drift",
        reason: "terminal control identity changed across the Codex composer capture"
      };
    }

    const screenDigest = createHash("sha256").update(styledScreen).digest("hex");
    if (
      inspection.approval.blocked ||
      inspection.activity.state === "awaiting_approval" ||
      codexBlockingModalVisible(screen)
    ) {
      return {
        state: "approval_or_modal",
        terminalControl: verifiedAfter,
        digest: screenDigest
      };
    }
    if (inspection.activity.state === "working") {
      return {
        state: "working",
        terminalControl: verifiedAfter,
        digest: screenDigest
      };
    }

    const composer = currentCodexComposerCapture(
      styledScreen,
      expectedText,
      options.allowOpaqueLargePastePlaceholder === true
    );
    if (!composer) {
      return {
        state: "unavailable",
        reason: "the current live Codex composer could not be proven",
        retryable: true,
        terminalControl: verifiedAfter,
        digest: screenDigest
      };
    }
    return {
      state: composer.state,
      terminalControl: verifiedAfter,
      digest: composer.digest
    };
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
    if (
      decisionMode === "keys" &&
      !isTerminalApprovalPromptEvidence(
        inspection.approval.promptEvidence
      )
    ) {
      return {
        approved: false,
        blocked: true,
        reason: `${adapter.displayName} approval prompt has no adapter-verified prompt evidence`,
        label: inspection.approval.action.label,
        promptKind: inspection.approval.promptKind,
        command: inspection.approval.command,
        screenExcerpt: inspection.screenExcerpt,
        decisionMode,
        requestId: inspection.approval.action.requestId
      };
    }
    const canonicalFingerprint = terminalApprovalFingerprint(
      adapter.agent,
      activeTerminalControl,
      inspection,
      {
        screen: captured.screen,
        runtime: options.runtime
      }
    );
    const legacyFingerprint = hasCanonicalTerminalEndpoint(terminalControl)
      ? undefined
      : terminalApprovalFingerprint(
          adapter.agent,
          terminalControl,
          inspection,
          {
            screen: captured.screen,
            runtime: options.runtime
          }
        );
    const useLegacyFingerprint = Boolean(
      options.expectedFingerprint &&
      options.expectedFingerprint === legacyFingerprint
    );
    const fingerprintControl = useLegacyFingerprint
      ? terminalControl
      : activeTerminalControl;
    const fingerprint = useLegacyFingerprint
      ? legacyFingerprint
      : canonicalFingerprint;
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
      fingerprintControl,
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
    let dispatchTerminalControl = verifiedForApproval;
    let dispatchInspection = recapturedInspection;
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
      const afterReservationMode =
        afterReservationInspection.approval.action.mode ?? "keys";
      const afterReservationFingerprint = terminalApprovalFingerprint(
        adapter.agent,
        fingerprintControl,
        afterReservationInspection,
        {
          screen: afterReservation.screen,
          runtime: options.runtime
        }
      );
      if (
        afterReservationMode !== "keys" ||
        afterReservationFingerprint !== recapturedFingerprint
      ) {
        return {
          approved: false,
          blocked: true,
          reason: "approval fingerprint changed after dispatch reservation",
          key: afterReservationInspection.approval.action.keys.length === 1
            ? afterReservationInspection.approval.action.keys[0]
            : undefined,
          keys: afterReservationInspection.approval.action.keys,
          label: afterReservationInspection.approval.action.label,
          promptKind: afterReservationInspection.approval.promptKind,
          command: afterReservationInspection.approval.command,
          cwd: afterReservationInspection.approval.cwd,
          toolName: afterReservationInspection.approval.toolName,
          requestDetail: afterReservationInspection.approval.requestDetail,
          fingerprint: afterReservationFingerprint,
          screenExcerpt: afterReservationInspection.screenExcerpt,
          decisionMode: afterReservationMode,
          requestId: afterReservationInspection.approval.action.requestId
        };
      }
      dispatchTerminalControl = afterReservation.terminalControl;
      dispatchInspection = afterReservationInspection;
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
      dispatchApproval.action.keys
    );
    return {
      approved: true,
      blocked: false,
      key: dispatchApproval.action.keys.length === 1
        ? dispatchApproval.action.keys[0]
        : undefined,
      keys: dispatchApproval.action.keys,
      label: dispatchApproval.action.label,
      promptKind: dispatchApproval.promptKind,
      command: dispatchApproval.command,
      cwd: dispatchApproval.cwd,
      fingerprint: recapturedFingerprint,
      screenExcerpt: dispatchInspection.screenExcerpt,
      decisionMode: recapturedDecisionMode,
      requestId: dispatchApproval.action.requestId
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
          {
            ...options.screenOptions,
            managedRequest: options.durableRequest
          }
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

function assertTerminalMutationCapabilities({
  provider,
  terminal,
  semantic,
  transport
}: {
  provider: TerminalControlProvider;
  terminal: TerminalEndpointRef;
  semantic: readonly TerminalControlCapability[];
  transport: readonly TerminalProviderCapability[];
}): void {
  const missingSemantic = semantic.filter((capability) =>
    !provider.supportedCapabilities.includes(capability) ||
    !terminal.capabilities.includes(capability)
  );
  const missingTransport = transport.filter((capability) =>
    !provider.providerCapabilities.includes(capability)
  );
  if (missingSemantic.length === 0 && missingTransport.length === 0) {
    return;
  }
  const missing = [
    ...missingSemantic.map((value) => `terminal:${value}`),
    ...missingTransport.map((value) => `provider:${value}`)
  ];
  throw new TerminalControlInputNotSentError(
    `terminal action capability preflight failed for ` +
    `${terminal.identity.providerKind}:${terminal.route.label}: ` +
    missing.join(", ")
  );
}

function nativeInspectionSubmissionError(
  stage: NativeInspectionSubmissionStage,
  error: unknown,
  fallbackDiagnostic?: NativeInspectionSubmissionDiagnostic
): NativeInspectionSubmissionError {
  const diagnostic = error instanceof NativeInspectionSubmissionError
    ? error.diagnostic
    : error instanceof NativeInspectionDiagnosticError
      ? error.diagnostic
      : fallbackDiagnostic;
  if (error instanceof NativeInspectionSubmissionError) {
    const stageRank: Record<NativeInspectionSubmissionStage, number> = {
      not_started: 0,
      text_injected: 1,
      enter_uncertain: 2
    };
    if (stageRank[error.stage] >= stageRank[stage]) {
      return error;
    }
    return new NativeInspectionSubmissionError(stage, error.message, {
      cause: error,
      diagnostic
    });
  }
  return new NativeInspectionSubmissionError(
    stage,
    error instanceof Error ? error.message : String(error),
    { cause: error, diagnostic }
  );
}

function assertClosedStatusInspectionPlan(
  adapter: TerminalAgentAdapter,
  terminalControl: TerminalControlRef,
  plan: TerminalNativeInspectionPlan
): void {
  if (!terminalControl.capabilities.includes("send_keys")) {
    throw new Error(`${adapter.displayName} terminal input is not supported`);
  }
  if (!terminalControl.capabilities.includes("screen_status")) {
    throw new Error(`${adapter.displayName} terminal screen inspection is not supported`);
  }
  const codexProfile = adapter.agent === "codex" &&
    CODEX_NATIVE_STATUS_POPUP_BY_PROFILE[plan.behaviorProfile] !== undefined;
  const claudeProfile = adapter.agent === "claude" &&
    CLAUDE_NATIVE_STATUS_POPUP_BY_PROFILE[plan.behaviorProfile] !== undefined;
  const expectedSettle = codexProfile
    ? { minimumStableMs: CODEX_PASTE_ENTER_SETTLE_MS, maximumSettleMs: 2_000 }
    : CLAUDE_NATIVE_STATUS_SETTLE_BY_PROFILE[plan.behaviorProfile];
  const exactPresentation = codexProfile
    ? plan.expectedResult.presentation === "inline" &&
      plan.expectedResult.dismissal === undefined &&
      plan.composer.minimumStableMs === expectedSettle?.minimumStableMs &&
      plan.composer.maximumSettleMs === expectedSettle.maximumSettleMs
    : claudeProfile
      ? plan.expectedResult.presentation === "modal" &&
        plan.composer.minimumStableMs === expectedSettle?.minimumStableMs &&
        plan.composer.maximumSettleMs === expectedSettle.maximumSettleMs &&
        plan.expectedResult.dismissal?.expected === "idle_empty_composer" &&
        JSON.stringify(plan.expectedResult.dismissal.keys) ===
          JSON.stringify(["Escape"])
      : false;
  if (
    plan.operation.kind !== "status" ||
    plan.command !== "/status" ||
    plan.effect !== "read_only" ||
    plan.requiresIdle !== true ||
    plan.composer.kind !== "exact" ||
    !Number.isFinite(plan.composer.minimumStableMs) ||
    plan.composer.minimumStableMs < 0 ||
    !Number.isFinite(plan.composer.maximumSettleMs) ||
    plan.composer.maximumSettleMs < plan.composer.minimumStableMs ||
    plan.expectedResult.kind !== "native_status" ||
    !exactPresentation
  ) {
    throw new Error("refusing a non-closed or unverified native inspection plan");
  }
}

function assertClosedNativeInspectionDismissal(
  plan: TerminalNativeInspectionPlan
): void {
  if (
    plan.expectedResult.presentation !== "modal" ||
    plan.expectedResult.dismissal?.expected !== "idle_empty_composer" ||
    JSON.stringify(plan.expectedResult.dismissal.keys) !==
      JSON.stringify(["Escape"])
  ) {
    throw new Error("native inspection has no closed verified modal dismissal plan");
  }
}

function assertNativeInspectionComposerSafe(
  inspection: TerminalScreenInspection,
  displayName = "terminal agent"
): void {
  if (
    inspection.approval.blocked ||
    inspection.activity.state === "awaiting_approval" ||
    inspection.activity.state === "working"
  ) {
    throw new NativeInspectionDiagnosticError(
      "composer_not_ready",
      `${displayName} became busy or blocked while its /status composer was settling`
    );
  }
  // Codex's generic activity parser deliberately reports a non-empty slash
  // composer as unknown. At this stage the caller has already proved an idle,
  // empty styled composer under the terminal lock; the exact-current composer
  // capture below is the stronger continuation proof after AKK injected only
  // the adapter-owned /status command.
}

function exactNativeInspectionComposerCapture(
  agent: ExecutorKind,
  screen: string,
  plan: TerminalNativeInspectionPlan
): {
  digest: string;
  kind: TerminalNativeInspectionMaterializationKind;
} | undefined {
  return agent === "codex"
    ? exactCodexNativeInspectionComposerCapture(screen, plan)
    : exactClaudeNativeInspectionComposerCapture(screen, plan);
}

function exactCodexNativeInspectionComposerCapture(
  screen: string,
  plan: TerminalNativeInspectionPlan
): {
  digest: string;
  kind: TerminalNativeInspectionMaterializationKind;
} | undefined {
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  let currentComposerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CODEX_COMPOSER_MARKER.test(lines[index])) {
      currentComposerIndex = index;
      break;
    }
  }
  if (currentComposerIndex < 0) {
    return undefined;
  }
  const composerText = lines[currentComposerIndex]
    .replace(/^[›»]\s?/u, "")
    .trimEnd();
  if (composerText !== plan.command) {
    return undefined;
  }
  const footerIndex = lines.findIndex((line, candidateIndex) =>
    candidateIndex > currentComposerIndex &&
    CODEX_COMPOSER_FOOTER.test(line.trim())
  );
  const region = lines.slice(
    currentComposerIndex,
    footerIndex < 0 ? lines.length : footerIndex
  );
  while (region.length > 1 && region.at(-1)?.trim() === "") {
    region.pop();
  }
  const popupRows = region.slice(1).filter((line) => line.trim().length > 0);
  let kind: TerminalNativeInspectionMaterializationKind;
  if (popupRows.length === 0) {
    kind = "exact_slash_composer";
  } else if (
    JSON.stringify(popupRows.map((line) => line.trimEnd())) ===
      JSON.stringify(CODEX_NATIVE_STATUS_POPUP_BY_PROFILE[plan.behaviorProfile])
  ) {
    kind = "exact_slash_popup";
  } else {
    return undefined;
  }
  return {
    kind,
    digest: createHash("sha256").update(region.join("\n")).digest("hex")
  };
}

function exactClaudeNativeInspectionComposerCapture(
  screen: string,
  plan: TerminalNativeInspectionPlan
): {
  digest: string;
  kind: TerminalNativeInspectionMaterializationKind;
} | undefined {
  const frame = exactClaudeComposerFrame(screen);
  if (!frame) {
    return undefined;
  }
  const { lines, openIndex, closeIndex, composerRows, trailing } = frame;
  if (
    composerRows.length !== 1 ||
    !/^\s*❯(?:\s|$)/u.test(composerRows[0]) ||
    composerRows[0].replace(/^\s*❯\s?/u, "").trimEnd() !== plan.command
  ) {
    return undefined;
  }
  let kind: TerminalNativeInspectionMaterializationKind;
  if (trailing.length === 0 || claudeNativeInspectionTrailingIsFooter(trailing)) {
    kind = "exact_slash_composer";
  } else {
    const suggestions: string[] = [];
    for (const line of trailing) {
      const trimmed = line.trim();
      if (trimmed.startsWith("/")) {
        suggestions.push(trimmed.replace(/\s+/gu, " "));
      } else if (suggestions.length > 0) {
        suggestions[suggestions.length - 1] +=
          ` ${trimmed.replace(/\s+/gu, " ")}`;
      } else {
        return undefined;
      }
    }
    if (
      !closedClaudeNativeStatusSuggestionsMatch(
        suggestions,
        CLAUDE_NATIVE_STATUS_POPUP_BY_PROFILE[plan.behaviorProfile]
      )
    ) {
      return undefined;
    }
    kind = "exact_slash_popup";
  }
  return {
    kind,
    digest: createHash("sha256")
      .update(lines.slice(openIndex, closeIndex + 1).concat(trailing).join("\n"))
      .digest("hex")
  };
}

/**
 * Claude truncates a suggestion row with a Unicode ellipsis at narrow pane
 * widths. Keep authorization closed by accepting only an exact ordered row or
 * an explicit ellipsis whose preceding text is an exact, non-trivial prefix of
 * that same profiled row. A caller still cannot introduce, omit, or reorder a
 * slash command.
 */
function closedClaudeNativeStatusSuggestionsMatch(
  observed: readonly string[],
  expected: readonly string[] | undefined
): boolean {
  if (!expected || observed.length !== expected.length) {
    return false;
  }
  return observed.every((row, index) => {
    const exact = expected[index];
    if (row === exact) {
      return true;
    }
    if (!row.endsWith("…")) {
      return false;
    }
    const prefix = row.slice(0, -1);
    const commandEnd = exact.indexOf(" ");
    return (
      commandEnd > 0 &&
      prefix.length >= commandEnd + 12 &&
      exact.startsWith(prefix)
    );
  });
}

/**
 * Prove Claude Code's exact current idle input frame. This is shared by every
 * automated-input path: a loose or historical `❯` prompt is not authority to
 * inject text into the terminal.
 */
export function isExactClaudeIdleComposer(
  screen: string
): boolean {
  const frame = exactClaudeComposerFrame(screen);
  if (!frame) {
    return false;
  }
  return (
    frame.composerRows.length === 1 &&
    /^\s*❯\s*$/u.test(frame.composerRows[0]) &&
    (
      frame.trailing.length === 0 ||
      claudeNativeInspectionTrailingIsFooter(frame.trailing)
    )
  );
}

/**
 * Compatibility export retained for callers that adopted the native-status
 * name before the same exact-frame proof was reused by lifecycle handoff.
 */
export function isExactClaudeNativeInspectionIdleComposer(
  screen: string
): boolean {
  return isExactClaudeIdleComposer(screen);
}

function exactClaudeComposerFrame(screen: string): {
  lines: string[];
  openIndex: number;
  closeIndex: number;
  composerRows: string[];
  trailing: string[];
} | undefined {
  const lines = screen.replace(/\r\n?/gu, "\n").replace(/\u00a0/gu, " ")
    .split("\n");
  const dividerIndexes = lines
    .map((line, index) => /^\s*[─━]{8,}\s*$/u.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (dividerIndexes.length < 2) {
    return undefined;
  }
  const closeIndex = dividerIndexes.at(-1)!;
  const openIndex = dividerIndexes.at(-2)!;
  return {
    lines,
    openIndex,
    closeIndex,
    composerRows: lines.slice(openIndex + 1, closeIndex)
      .filter((line) => line.trim().length > 0),
    trailing: lines.slice(closeIndex + 1)
      .filter((line) => line.trim().length > 0)
  };
}

function claudeNativeInspectionTrailingIsFooter(
  lines: readonly string[]
): boolean {
  return lines.length <= 2 && lines.every((line) =>
    /^\s*(?:[⏵⏴]{1,2}|\?)\s*.*(?:shift\+tab|accept edits|bypass permissions|for shortcuts|← for agents)/iu
      .test(line)
  );
}

function nativeInspectionScreenFingerprint(screen: string): string {
  return `sha256:${createHash("sha256").update(screen).digest("hex")}`;
}

function bareDigestFromNativeInspectionScreenFingerprint(
  fingerprint: string
): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(fingerprint);
  if (!match) {
    throw new Error("native inspection screen fingerprint is malformed");
  }
  return match[1];
}

function stripTerminalEscapeSequences(value: string): string {
  return value.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu,
    ""
  );
}

export function exactCodexReadyStyledComposerCapture(
  screen: string
): { digest: string } | undefined {
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  while (
    lines.length > 0 &&
    stripTerminalEscapeSequences(lines.at(-1) ?? "").trim().length === 0
  ) {
    lines.pop();
  }
  const composerLine = [...lines.slice(-12)].reverse().find((line) =>
    CODEX_COMPOSER_MARKER.test(
      stripTerminalEscapeSequences(line).trimEnd()
    )
  );
  if (composerLine === undefined) {
    return undefined;
  }

  let dim = false;
  const visible: Array<{ character: string; dim: boolean }> = [];
  for (let index = 0; index < composerLine.length;) {
    if (composerLine[index] === "\x1b") {
      const escape = /^(?:\x1B\[([0-9;]*)m|\x1B\][^\x07]*(?:\x07|\x1B\\))/u
        .exec(composerLine.slice(index));
      if (escape) {
        if (escape[1] !== undefined) {
          const codes = escape[1] === ""
            ? [0]
            : escape[1].split(";").map((value) => Number(value));
          for (let codeIndex = 0; codeIndex < codes.length; codeIndex += 1) {
            const code = codes[codeIndex];
            if (
              [38, 48, 58].includes(code) &&
              codes[codeIndex + 1] === 2
            ) {
              codeIndex += 4;
              continue;
            }
            if (
              [38, 48, 58].includes(code) &&
              codes[codeIndex + 1] === 5
            ) {
              codeIndex += 2;
              continue;
            }
            if (code === 0 || code === 22) {
              dim = false;
            } else if (code === 2) {
              dim = true;
            }
          }
        }
        index += escape[0].length;
        continue;
      }
    }
    const codePoint = composerLine.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    visible.push({ character, dim });
    index += character.length;
  }
  const promptIndex = visible.findIndex(({ character }) =>
    character === "›" || character === "»"
  );
  if (promptIndex < 0) {
    return undefined;
  }
  const content = visible.slice(promptIndex + 1)
    .filter(({ character }) => !/^\s$/u.test(character));
  if (content.length > 0 && !content.every((entry) => entry.dim)) {
    return undefined;
  }
  return {
    digest: createHash("sha256").update(composerLine).digest("hex")
  };
}

/**
 * Infer a viewport only from fixed-width visible-buffer rows. Trimmed captures
 * deliberately return undefined: a short content row is not proof of a short
 * terminal. This keeps the fallback provider-neutral and fail-closed only on
 * positive geometry evidence.
 */
function inferCodexVisibleViewportColumns(screen: string): number | undefined {
  const rows = screen.replace(/\r\n?/gu, "\n").split("\n")
    .map(stripTerminalEscapeSequences);
  const widthOneRows = rows.filter((row) =>
    /^[\x20-\x7e›»·─━╭╮╰╯│]*$/u.test(row)
  );
  const maxWidth = widthOneRows.reduce(
    (maximum, row) => Math.max(maximum, Array.from(row).length),
    0
  );
  if (maxWidth < 20) {
    return undefined;
  }
  const paddedAtMax = widthOneRows.filter((row) =>
    row.endsWith(" ") && Array.from(row).length === maxWidth
  );
  const composerAtMax = paddedAtMax.some((row) =>
    CODEX_COMPOSER_MARKER.test(row.trimEnd())
  );
  return paddedAtMax.length >= 3 && composerAtMax
    ? maxWidth
    : undefined;
}

function hasTruncatedCodexStatusSessionLine(screen: string): boolean {
  return screen.replace(/\r\n?/gu, "\n").split("\n").some((line) => {
    const match = /^\s*│\s*Session:\s*([^│\s]+).*│?\s*$/iu.exec(line);
    if (!match) {
      return false;
    }
    return !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(match[1]);
  });
}

function codexNativeInspectionComposerMismatchDiagnostic(
  screen: string,
  plan: TerminalNativeInspectionPlan
): NativeInspectionSubmissionDiagnostic {
  const expectedRows = CODEX_NATIVE_STATUS_POPUP_BY_PROFILE[
    plan.behaviorProfile
  ];
  if (!expectedRows) {
    return "composer_not_exact";
  }
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CODEX_COMPOSER_MARKER.test(lines[index])) {
      composerIndex = index;
      break;
    }
  }
  if (
    composerIndex < 0 ||
    lines[composerIndex].replace(/^[›»]\s?/u, "").trimEnd() !== plan.command
  ) {
    return "composer_not_exact";
  }
  const footerIndex = lines.findIndex((line, index) =>
    index > composerIndex && CODEX_COMPOSER_FOOTER.test(line.trim())
  );
  const popupRows = lines.slice(
    composerIndex + 1,
    footerIndex < 0 ? lines.length : footerIndex
  ).filter((line) => line.trim().length > 0);
  if (popupRows.length === 0) {
    return "composer_not_exact";
  }

  const logicalRows: string[] = [];
  let observedTruncation = false;
  for (const row of popupRows) {
    const trimmed = row.trim().replace(/\s+/gu, " ");
    if (trimmed.startsWith("/")) {
      logicalRows.push(trimmed);
    } else if (logicalRows.length > 0) {
      logicalRows[logicalRows.length - 1] += ` ${trimmed}`;
      observedTruncation = true;
    } else {
      return "composer_not_exact";
    }
    observedTruncation ||= trimmed.endsWith("…");
  }
  const normalizedExpected = expectedRows.map((row) =>
    row.trim().replace(/\s+/gu, " ")
  );
  const everyKnownPrefix = logicalRows.length <= normalizedExpected.length &&
    logicalRows.every((row, index) => {
      const withoutEllipsis = row.endsWith("…")
        ? row.slice(0, -1).trimEnd()
        : row;
      return normalizedExpected[index]?.startsWith(withoutEllipsis) === true;
    });
  return observedTruncation && everyKnownPrefix
    ? "composer_viewport_truncated"
    : "composer_not_exact";
}

function codexBlockingModalVisible(screen: string): boolean {
  const tail = screen.replace(/\r\n?/gu, "\n").split("\n").slice(-80)
    .join("\n");
  return /\b(?:press|use)\s+(?:esc|escape)\s+to\s+(?:cancel|close|dismiss)\b/iu
    .test(tail) ||
    /\besc\s+to\s+cancel\b/iu.test(tail);
}

/**
 * Classify only the bottom live Codex composer region. A matching transcript
 * prompt elsewhere in scrollback is deliberately ignored.
 */
function currentCodexComposerCapture(
  styledScreen: string,
  expectedText: string,
  allowOpaqueLargePastePlaceholder = false
): {
  state: "exact_draft" | "exact_empty" | "different_draft";
  digest: string;
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
  if (footerIndex < 0) {
    return undefined;
  }

  const expectedComparable = composerComparableText(expectedText);
  const expectedCharacterCount = Array.from(expectedText).length;
  const comparable = composerComparableText(bodyRows.join("\n"));
  const opaqueLargePastePlaceholder =
    /^\[Pasted Content \d+ chars\]$/u.test(comparable);
  if (opaqueLargePastePlaceholder && !allowOpaqueLargePastePlaceholder) {
    return undefined;
  }
  const exactVisibleDraft = terminalComposerRowsMatchExpected(
    bodyRows,
    expectedComparable
  );
  const exactLargePastePlaceholder =
    allowOpaqueLargePastePlaceholder &&
    expectedCharacterCount > CODEX_LARGE_PASTE_CHAR_THRESHOLD &&
    comparable === composerComparableText(
      `[Pasted Content ${expectedCharacterCount} chars]`
    );
  if (exactVisibleDraft || exactLargePastePlaceholder) {
    return { state: "exact_draft", digest };
  }
  return comparable.length > 0
    ? { state: "different_draft", digest }
    : undefined;
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
      !/^\s*(?:[⏵⏴]{1,2}|\?)\s*.*(?:shift\+tab|accept edits|bypass permissions|for shortcuts|← for agents)/iu
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
  } = {}
): string | undefined {
  if (!inspection.approval.approvable) {
    return undefined;
  }
  const decisionMode = inspection.approval.action.mode ?? "keys";
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
      keys: inspection.approval.action.keys,
      label: inspection.approval.action.label,
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
      request_id: inspection.approval.action.requestId
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
  } = {}
): TerminalBridgeStatus {
  const approval = dispatchableApprovalInspection(adapter, inspection.approval);
  const fingerprint = terminalApprovalFingerprint(
    adapter.agent,
    terminalControl,
    {
      ...inspection,
      approval
    },
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
    }
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
