import { createHash } from "node:crypto";
import type { ExecutorKind } from "./executors.js";
import type {
  TerminalAgentAdapter,
  TerminalAgentAdapterRegistry,
  TerminalControlCapability,
  TerminalNativeInspectionEvidenceInventoryEntry,
  TerminalNativeInspectionObservation,
  TerminalNativeInspectionObservationRequest,
  TerminalNativeInspectionPlan,
  TerminalRuntimeIdentity,
  TerminalScreenInspection
} from "./terminal-agent-adapter.js";
import {
  TerminalControlInputNotSentError,
  type TerminalControlProvider,
  type TerminalViewport
} from "./terminal-control-provider.js";
import {
  sameTerminalControlIncarnation,
  type TerminalControlRef,
  type TerminalEndpointRef,
  type TerminalProviderCapability
} from "./terminal-control-ref.js";
import {
  CODEX_EXACT_CANDIDATE_GRACE_CAPTURES,
  CODEX_MULTILINE_SETTLE_POLL_MS,
  CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES,
  CODEX_MULTILINE_STABLE_CAPTURES,
  CODEX_PASTE_ENTER_SETTLE_MS
} from "./terminal-text-submission-bridge.js";

export const CODEX_COMPOSER_MARKER = /^[›»](?:\s|$)/u;
export const CODEX_COMPOSER_FOOTER =
  /^(?:gpt-[\w.-]+(?:\s|$)|[-\w.]+ default ·)/u;

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
  ],
  "codex-tui-0.149.1": [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ],
  "codex-tui-0.150.1": [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ],
  "codex-tui-0.151.0": [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ],
  "codex-tui-0.153.0": [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ],
  "codex-tui-0.153.4": [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ],
  "codex-tui-0.154.0": [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ],
  "codex-tui-0.155.1": [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ],
  "codex-tui-generic-v1": [
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
  "codex-tui-0.148.0": 80,
  "codex-tui-0.149.1": 80,
  "codex-tui-0.150.1": 80,
  "codex-tui-0.151.0": 80,
  "codex-tui-0.153.0": 80,
  "codex-tui-0.153.4": 80,
  "codex-tui-0.154.0": 80,
  "codex-tui-0.155.1": 80,
  "codex-tui-generic-v1": 80
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
  ],
  "claude-code-2.1.251-native-status": [
    "/status Show Claude Code status including version, model, account, API connectivity, and tool statuses",
    "/statusline Set up Claude Code's status line UI",
    "/ide Manage IDE integrations and show status",
    "/usage Show session cost, plan usage, and activity stats"
  ],
  "claude-code-2.1.259-native-status": [
    "/status Show Claude Code status including version, model, account, API connectivity, and tool statuses",
    "/statusline Set up Claude Code's status line UI",
    "/ide Manage IDE integrations and show status",
    "/usage Show session cost, plan usage, and activity stats"
  ],
  "claude-code-2.1.263-native-status": [
    "/status Show Claude Code status including version, model, account, API connectivity, and tool statuses",
    "/statusline Set up Claude Code's status line UI",
    "/ide Manage IDE integrations and show status",
    "/usage Show session cost, plan usage, and activity stats"
  ],
  "claude-code-2.1.266-native-status": [
    "/status Show Claude Code status including version, model, account, API connectivity, and tool statuses",
    "/statusline Set up Claude Code's status line UI",
    "/ide Manage IDE integrations and show status",
    "/usage Show session cost, plan usage, and activity stats"
  ],
  "claude-code-2.1.267-native-status": [
    "/status Show Claude Code status including version, model, account, API connectivity, and tool statuses",
    "/statusline Set up Claude Code's status line UI",
    "/ide Manage IDE integrations and show status",
    "/usage Show session cost, plan usage, and activity stats"
  ],
  "claude-code-unverified-native-status-v1": [
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
  },
  "claude-code-2.1.251-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.259-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.263-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.266-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.267-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-unverified-native-status-v1": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  }
};

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

export interface TerminalNativeInspectionTransportObservationResult<TStatus> {
  terminalControl: TerminalControlRef;
  status: TStatus;
  /** Same raw-screen fingerprint format used by adapter stale checks. */
  screenDigest: string;
  observation: TerminalNativeInspectionObservation;
}

interface TerminalNativeInspectionCapture {
  terminalControl: TerminalControlRef;
  screen: string;
  inspection: TerminalScreenInspection;
}

interface TerminalNativeInspectionRuntime<TStatus> {
  captureInspection: (
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    options: {
      runtime?: TerminalRuntimeIdentity;
      scrollbackLines?: number;
    }
  ) => Promise<TerminalNativeInspectionCapture>;
  verifyIdentity: (
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime?: TerminalRuntimeIdentity
  ) => Promise<TerminalControlRef>;
  statusFromInspection: (
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    inspection: TerminalScreenInspection,
    options: {
      screen?: string;
      runtime?: TerminalRuntimeIdentity;
    }
  ) => TStatus;
  nowMs: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

/**
 * Closed native-inspection transport. Terminal locking, Store authority, and
 * the caller's one-shot input ledger remain outside this internal service.
 */
export class TerminalNativeInspectionBridge<TStatus> {
  readonly registry: TerminalAgentAdapterRegistry;
  readonly terminalProvider: TerminalControlProvider;

  constructor(options: {
    registry: TerminalAgentAdapterRegistry;
    terminalProvider: TerminalControlProvider;
    runtime: TerminalNativeInspectionRuntime<TStatus>;
  }) {
    this.registry = options.registry;
    this.terminalProvider = options.terminalProvider;
    this.runtime = options.runtime;
  }

  private readonly runtime: TerminalNativeInspectionRuntime<TStatus>;

  private captureInspection(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    options: {
      runtime?: TerminalRuntimeIdentity;
      scrollbackLines?: number;
    } = {}
  ): Promise<TerminalNativeInspectionCapture> {
    return this.runtime.captureInspection(adapter, terminalControl, options);
  }

  private verifyTerminalIdentity(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime?: TerminalRuntimeIdentity
  ): Promise<TerminalControlRef> {
    return this.runtime.verifyIdentity(agent, terminalControl, runtime);
  }

  private nowMs(): number {
    return this.runtime.nowMs();
  }

  private sleep(milliseconds: number): Promise<void> {
    return this.runtime.sleep(milliseconds);
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
  ): Promise<TerminalNativeInspectionTransportObservationResult<TStatus>> {
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
      status: this.runtime.statusFromInspection(
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
    let capturesBeyondDeadline = 0;
    let lastMismatchDiagnostic: NativeInspectionSubmissionDiagnostic =
      "composer_not_exact";

    while (true) {
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
      if (remaining <= 0 && !materialized) {
        break;
      }
      if (remaining <= 0) {
        capturesBeyondDeadline += 1;
        if (
          capturesBeyondDeadline > CODEX_EXACT_CANDIDATE_GRACE_CAPTURES
        ) {
          break;
        }
      }
      const remainingStableMs = plan.composer.minimumStableMs -
        (stableSince === undefined ? 0 : this.nowMs() - stableSince);
      await this.sleep(Math.min(
        CODEX_MULTILINE_SETTLE_POLL_MS,
        remaining > 0
          ? remaining
          : Math.max(1, remainingStableMs)
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

}

function sameTerminalControlIdentity(
  left: TerminalControlRef,
  right: TerminalControlRef
): boolean {
  return sameTerminalControlIncarnation(left, right);
}

export function assertTerminalMutationCapabilities({
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
    throw new Error("refusing a non-closed native inspection plan");
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
    throw new Error("native inspection has no closed modal dismissal plan");
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

export function exactClaudeComposerFrame(screen: string): {
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

export function claudeNativeInspectionTrailingIsFooter(
  lines: readonly string[]
): boolean {
  return lines.length <= 2 && lines.every(isClaudeNativeComposerFooterLine);
}

function isClaudeNativeComposerFooterLine(line: string): boolean {
  return /^\s*(?:[⏵⏴⏸]{1,2}|\?)\s*.*(?:manual mode|shift\+tab|accept edits|bypass permissions|for shortcuts|← for agents)/iu
    .test(line);
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

export function stripTerminalEscapeSequences(value: string): string {
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
export function inferCodexVisibleViewportColumns(screen: string): number | undefined {
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
