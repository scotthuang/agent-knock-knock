export {
  CODEX_COMPOSER_MARKER,
  CODEX_COMPOSER_FOOTER,
  isExactClaudeIdleComposer,
  isExactClaudeNativeInspectionIdleComposer,
  exactClaudeComposerFrame,
  claudeNativeInspectionTrailingIsFooter,
  stripTerminalEscapeSequences,
  exactCodexReadyStyledComposerCapture,
  inferCodexVisibleViewportColumns
} from "./terminal-native-inspection-proof.js";
import {
  CODEX_COMPOSER_MARKER,
  CODEX_COMPOSER_FOOTER,
  assertNativeInspectionComposerSafe,
  exactNativeInspectionComposerCapture,
  isExactClaudeIdleComposer,
  isExactClaudeNativeInspectionIdleComposer,
  exactClaudeComposerFrame,
  claudeNativeInspectionTrailingIsFooter,
  nativeInspectionScreenFingerprint,
  bareDigestFromNativeInspectionScreenFingerprint,
  stripTerminalEscapeSequences,
  exactCodexReadyStyledComposerCapture,
  inferCodexVisibleViewportColumns,
  hasTruncatedCodexStatusSessionLine,
  codexNativeInspectionComposerMismatchDiagnostic
} from "./terminal-native-inspection-proof.js";
import {
  codexFullscreenStatusVersion,
  codexNativeStatusPopupRows,
  codexNativeStatusMinimumViewport,
  assertClosedStatusInspectionPlan,
  assertClosedNativeInspectionDismissal
} from "./terminal-native-inspection-profile.js";
export {
  NativeInspectionSubmissionStage,
  NativeInspectionSubmissionDiagnostic,
  TerminalNativeInspectionMaterializationKind,
  TerminalNativeInspectionMaterializationEvidence,
  TerminalNativeInspectionBeforeEnterContext,
  TerminalNativeInspectionOptions,
  TerminalNativeInspectionResult,
  TerminalCodexStatusProbeResult,
  TerminalNativeInspectionBeforeDismissContext,
  TerminalNativeInspectionDismissalOptions,
  TerminalNativeInspectionDismissalResult,
  TerminalNativeInspectionTransportObservationResult,
  NativeInspectionSubmissionError,
  NativeInspectionDismissalError
} from "./terminal-native-inspection-contract.js";
import {
  NativeInspectionSubmissionStage,
  NativeInspectionSubmissionDiagnostic,
  TerminalNativeInspectionMaterializationKind,
  TerminalNativeInspectionMaterializationEvidence,
  TerminalNativeInspectionBeforeEnterContext,
  TerminalNativeInspectionOptions,
  TerminalNativeInspectionResult,
  TerminalCodexStatusProbeResult,
  TerminalNativeInspectionBeforeDismissContext,
  TerminalNativeInspectionDismissalOptions,
  TerminalNativeInspectionDismissalResult,
  TerminalNativeInspectionTransportObservationResult,
  TerminalNativeInspectionCapture,
  TerminalNativeInspectionRuntime,
  NativeInspectionSubmissionError,
  NativeInspectionDiagnosticError,
  NativeInspectionDismissalError
} from "./terminal-native-inspection-contract.js";
import {
  isCodexPaginatedReadCandidate
} from "./codex-lifecycle-compatibility.js";

import {
  exactCodexFullscreenSlashComposerCapture
} from "./codex-fullscreen-composer-proof.js";
import type {
  ExecutorKind
} from "./executors.js";
import type {
  TerminalAgentAdapter,
  TerminalAgentAdapterRegistry,
  TerminalControlCapability,
  TerminalNativeInspectionEvidenceInventoryEntry,
  TerminalNativeInspectionObservationRequest,
  TerminalNativeInspectionPlan,
  TerminalRuntimeIdentity
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
  CODEX_MULTILINE_STABLE_CAPTURES
} from "./terminal-text-submission-bridge.js";

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
    if (options.allowWorkingCodexStatus && (
      !isCodexPaginatedReadCandidate(agentVersion) ||
      options.runtime?.agentVersion !== agentVersion
    )) {
      throw nativeInspectionSubmissionError(
        "not_started",
        new Error("working native status requires the same exact paginated Codex runtime candidate"),
        "unsupported_profile"
      );
    }
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
      {
        requireCodexReadyComposer: true,
        allowWorkingCodexStatus: options.allowWorkingCodexStatus === true
      }
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
    safety: {
      requireCodexReadyComposer?: boolean;
      allowWorkingCodexStatus?: boolean;
    } = {}
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
          options.runtime,
          safety.allowWorkingCodexStatus
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
        options.runtime,
        safety.allowWorkingCodexStatus
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
        options.runtime,
        safety.allowWorkingCodexStatus
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
    runtime?: TerminalRuntimeIdentity,
    allowWorkingCodexStatus = false
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
    const minimumViewport = codexNativeStatusMinimumViewport(plan);
    if (minimumViewport === undefined) {
      throw new NativeInspectionDiagnosticError(
        "unsupported_profile",
        `Codex ${plan.behaviorProfile} has no exact /status viewport profile`
      );
    }

    const first = await this.captureCodexReadyComposerFrame(
      adapter, terminalControl, minimumViewport, runtime, allowWorkingCodexStatus
    );
    const second = await this.captureCodexReadyComposerFrame(
      adapter, first.terminalControl, minimumViewport, runtime, allowWorkingCodexStatus
    );
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

  private async captureCodexReadyComposerFrame(
    adapter: TerminalAgentAdapter,
    control: TerminalControlRef,
    minimumViewport: number,
    runtime?: TerminalRuntimeIdentity,
    allowWorkingCodexStatus = false
  ): Promise<{ terminalControl: TerminalControlRef; screenDigest: string; composerDigest: string }> {
    const verified = await this.verifyTerminalIdentity(adapter.agent, control, runtime);
    const endpoint = this.terminalProvider.endpoint(verified);
    const { exactViewport, viewportUnavailableReason } =
      await this.captureCodexStatusViewportBeforeInput(endpoint);
    const styledScreen = await this.terminalProvider.capture(
      endpoint, { scrollbackLines: 40, preserveEscapes: true }
    );
    const plainScreen = stripTerminalEscapeSequences(styledScreen);
    const inspection = adapter.inspectScreen({ screen: plainScreen, runtime });
    assertNativeInspectionComposerSafe(inspection, adapter.displayName, allowWorkingCodexStatus);
    const composer = exactCodexReadyStyledComposerCapture(styledScreen, runtime?.agentVersion);
    if (!composer) {
      throw new NativeInspectionDiagnosticError(
        "composer_not_ready",
        "Codex composer contains non-placeholder input or is not at the exact idle prompt"
      );
    }
    const inferredViewport = inferCodexVisibleViewportColumns(styledScreen);
    const observedViewport = exactViewport ?? inferredViewport;
    if ((observedViewport !== undefined && observedViewport < minimumViewport) ||
        hasTruncatedCodexStatusSessionLine(plainScreen)) {
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
          viewportUnavailableReason + `${inferredViewport === undefined
            ? "" : ` (ANSI fallback estimated ${inferredViewport} columns)`}`
      );
    }
    const reverified = await this.verifyTerminalIdentity(adapter.agent, verified, runtime);
    if (!sameTerminalControlIdentity(verified, reverified)) {
      throw new NativeInspectionDiagnosticError(
        "identity_unverified",
        "terminal control identity changed after the Codex pre-text composer capture"
      );
    }
    return { terminalControl: reverified,
      screenDigest: nativeInspectionScreenFingerprint(styledScreen), composerDigest: composer.digest };
  }

  private async captureCodexStatusViewportBeforeInput(
    endpoint: TerminalEndpointRef
  ): Promise<{ exactViewport?: number; viewportUnavailableReason: string }> {
    const inspector = this.terminalProvider.inspectViewport;
    if (!inspector) return {
      viewportUnavailableReason: "terminal provider has no exact viewport inspector"
    };
    let viewport: TerminalViewport | undefined;
    try {
      viewport = await inspector.call(this.terminalProvider, endpoint);
    } catch (error) {
      throw new NativeInspectionDiagnosticError(
        "viewport_unavailable",
        `Codex /status viewport inspection failed before terminal input: ${
          error instanceof Error ? error.message : String(error)
        }`, { cause: error }
      );
    }
    if (!viewport) return {
      viewportUnavailableReason: "terminal provider could not prove exact viewport geometry"
    };
    if (!Number.isSafeInteger(viewport.columns) || viewport.columns <= 0 ||
        !Number.isSafeInteger(viewport.rows) || viewport.rows <= 0) {
      throw new NativeInspectionDiagnosticError(
        "viewport_unavailable", "Codex /status viewport inspector returned invalid geometry"
      );
    }
    return {
      exactViewport: viewport.columns,
      viewportUnavailableReason: "terminal provider has no exact viewport inspector"
    };
  }

  private async assertFinalCodexStatusViewport(
    terminalControl: TerminalControlRef,
    plan: TerminalNativeInspectionPlan,
    runtime?: TerminalRuntimeIdentity
  ): Promise<TerminalControlRef> {
    const minimumViewport = codexNativeStatusMinimumViewport(plan);
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
    runtime?: TerminalRuntimeIdentity,
    allowWorkingCodexStatus = false
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
      assertNativeInspectionComposerSafe(captured.inspection, adapter.displayName, allowWorkingCodexStatus);
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
            runtime,
            allowWorkingCodexStatus
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
    runtime?: TerminalRuntimeIdentity,
    allowWorkingCodexStatus = false
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
    assertNativeInspectionComposerSafe(captured.inspection, adapter.displayName, allowWorkingCodexStatus);
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
    const finalScreen = codexFullscreenStatusVersion(plan) !== undefined
      ? await this.captureCodexStyledStatusPopup(verifiedImmediatelyBeforeEnter, plan,
          expected, runtime, allowWorkingCodexStatus)
      : captured.screen;
    return {
      terminalControl: verifiedImmediatelyBeforeEnter,
      screenDigest: nativeInspectionScreenFingerprint(finalScreen),
      evidenceInventory: baseline.evidenceInventory,
      materialization: expected
    };
  }

  private async captureCodexStyledStatusPopup(
    control: TerminalControlRef,
    plan: TerminalNativeInspectionPlan,
    expected: TerminalNativeInspectionMaterializationEvidence,
    runtime?: TerminalRuntimeIdentity,
    allowWorking = false
  ): Promise<string> {
    const styledScreen = await this.terminalProvider.capture(
      this.terminalProvider.endpoint(control),
      { scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES, preserveEscapes: true }
    );
    const plainScreen = stripTerminalEscapeSequences(styledScreen);
    const adapter = this.registry.require("codex");
    assertNativeInspectionComposerSafe(adapter.inspectScreen({ screen: plainScreen, runtime }),
      adapter.displayName, allowWorking);
    const styled = exactCodexFullscreenSlashComposerCapture(styledScreen, plan.command,
      codexNativeStatusPopupRows(plan) ?? [], true, codexFullscreenStatusVersion(plan));
    const materialized = exactNativeInspectionComposerCapture("codex", plainScreen, plan);
    if (!styled || !materialized || materialized.digest !== expected.digest ||
        materialized.kind !== expected.kind) {
      throw new NativeInspectionDiagnosticError("composer_drift",
        "Codex fullscreen /status lost its exact styled popup before Enter");
    }
    return styledScreen;
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
