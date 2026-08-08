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
  TerminalControlInputNotSentError,
  terminalRefFromPane,
  type TerminalControlProvider
} from "./terminal-control-provider.js";

// Codex 0.146.x keeps Enter in paste/newline mode for 120ms after burst input.
// Cross that boundary rather than landing on it, and also require observable
// composer stability instead of treating this delay alone as acceptance.
const CODEX_PASTE_ENTER_SETTLE_MS = 121;
const CODEX_MULTILINE_SETTLE_POLL_MS = 30;
const CODEX_MULTILINE_SETTLE_TIMEOUT_MS = 2_000;
const CODEX_MULTILINE_STABLE_CAPTURES = 2;
const CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES = 240;
const CODEX_COMPOSER_MARKER = /^[›»](?:\s|$)/u;
const CODEX_COMPOSER_FOOTER =
  /^(?:gpt-[\w.-]+(?:\s|$)|[-\w.]+ default ·)/u;
const CODEX_LARGE_PASTE_CHAR_THRESHOLD = 1_000;

/** A terminal send failed at a boundary that proves input never started. */
export class TerminalInputNotStartedError extends Error {
  readonly code = "AKK_TERMINAL_INPUT_NOT_STARTED";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "TerminalInputNotStartedError";
  }
}

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

export interface TerminalSendOptions {
  runtime?: TerminalRuntimeIdentity;
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
    options: TerminalSendOptions = {}
  ): Promise<TerminalSendResult> {
    const adapter = this.registry.require(agent);
    if (!terminalControl.capabilities.includes("send_keys")) {
      throw new TerminalInputNotStartedError(
        `${adapter.displayName} terminal input is not supported`
      );
    }
    const normalized = text.trimEnd();
    if (!normalized) {
      throw new TerminalInputNotStartedError("terminal message is empty");
    }
    const multiline = /[\r\n]/u.test(normalized);
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
    try {
      await this.terminalProvider.sendText(verifiedForText.target, normalized, {
        socketPath: verifiedForText.socketPath
      });
    } catch (error) {
      if (error instanceof TerminalControlInputNotSentError) {
        throw new TerminalInputNotStartedError(error.message, {
          cause: error
        });
      }
      throw error;
    }
    await options.onTransportStage?.({
      stage: "text_injected",
      agent: adapter.agent,
      terminalControl: verifiedForText,
      multiline
    });
    // Text and Enter are separate tmux operations. Revalidate between them and
    // never submit after identity or composer drift. The legacy single-line
    // path retains its best-effort pre-submit cleanup behavior.
    let verifiedForEnter: TerminalControlRef;
    if (adapter.agent === "codex" && multiline) {
      verifiedForEnter = await this.settleCodexMultilineComposer(
        adapter,
        terminalControl,
        normalized,
        options.runtime
      );
    } else {
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
    }
    await this.terminalProvider.sendKeys(verifiedForEnter.target, ["C-m"], {
      socketPath: verifiedForEnter.socketPath
    });
    await options.onTransportStage?.({
      stage: "enter_dispatched",
      agent: adapter.agent,
      terminalControl: verifiedForEnter,
      multiline
    });
    return {
      stage: "enter_dispatched",
      agent: adapter.agent,
      terminalControl: verifiedForEnter,
      multiline
    };
  }

  private async settleCodexMultilineComposer(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime?: TerminalRuntimeIdentity
  ): Promise<TerminalControlRef> {
    const startedAt = performance.now();
    let stableDigest: string | undefined;
    let stableSince: number | undefined;
    let stableCaptures = 0;

    while (performance.now() - startedAt <= CODEX_MULTILINE_SETTLE_TIMEOUT_MS) {
      const captured = await this.captureInspection(adapter, terminalControl, {
        runtime,
        scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
      });
      if (
        captured.inspection.approval.blocked ||
        captured.inspection.activity.state === "awaiting_approval" ||
        captured.inspection.activity.state === "working"
      ) {
        throw new Error(
          "Codex became busy or blocked while its multiline composer was settling"
        );
      }

      const composer = exactCodexComposerCapture(captured.screen, expectedText);
      const composerIsIdle = captured.inspection.activity.state === "idle" ||
        (
          captured.inspection.activity.state === "unknown" &&
          composer !== undefined
        );
      if (composer && composerIsIdle) {
        if (composer.digest === stableDigest) {
          stableCaptures += 1;
        } else {
          stableDigest = composer.digest;
          stableSince = performance.now();
          stableCaptures = 1;
        }
        if (
          stableCaptures >= CODEX_MULTILINE_STABLE_CAPTURES &&
          stableSince !== undefined &&
          performance.now() - stableSince >= CODEX_PASTE_ENTER_SETTLE_MS
        ) {
          const finalCapture = await this.captureInspection(
            adapter,
            captured.terminalControl,
            {
              runtime,
              scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
            }
          );
          const finalComposer = exactCodexComposerCapture(
            finalCapture.screen,
            expectedText
          );
          const finalIsIdle = finalCapture.inspection.activity.state === "idle" ||
            (
              finalCapture.inspection.activity.state === "unknown" &&
              finalComposer !== undefined
            );
          if (
            finalCapture.inspection.approval.blocked ||
            !finalIsIdle ||
            !finalComposer ||
            finalComposer.digest !== stableDigest
          ) {
            throw new Error(
              "Codex multiline composer changed after its stable pre-submit capture"
            );
          }
          const verifiedImmediatelyBeforeEnter = await this.verifyTerminalIdentity(
            adapter.agent,
            finalCapture.terminalControl,
            runtime
          );
          if (
            !sameTerminalControlIdentity(
              finalCapture.terminalControl,
              verifiedImmediatelyBeforeEnter
            )
          ) {
            throw new Error(
              "terminal control identity changed after the final Codex composer capture"
            );
          }
          return verifiedImmediatelyBeforeEnter;
        }
      } else {
        stableDigest = undefined;
        stableSince = undefined;
        stableCaptures = 0;
      }

      const remainingSuppressionMs = CODEX_PASTE_ENTER_SETTLE_MS -
        (stableSince === undefined ? 0 : performance.now() - stableSince);
      await terminalSettleDelay(Math.max(
        1,
        Math.min(
          CODEX_MULTILINE_SETTLE_POLL_MS,
          remainingSuppressionMs > 0
            ? remainingSuppressionMs
            : CODEX_MULTILINE_SETTLE_POLL_MS
        )
      ));
    }
    throw new Error(
      "Codex multiline composer did not become exact, idle, and stable before the bounded submit deadline"
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
    await terminalSettleDelay(CODEX_MULTILINE_SETTLE_POLL_MS);
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
    if (!terminalControl.capabilities.includes("send_keys")) {
      throw new Error(`${adapter.displayName} terminal input is not supported`);
    }
    const verified = await this.verifyTerminalIdentity(
      adapter.agent,
      terminalControl,
      options.runtime
    );
    await this.terminalProvider.sendKeys(verified.target, ["C-u"], {
      socketPath: verified.socketPath
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
        afterReservation.terminalControl,
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
      verifiedImmediatelyBeforeSend.target,
      dispatchApproval.action.keys,
      { socketPath: verifiedImmediatelyBeforeSend.socketPath }
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
      terminalControl,
      runtime
    });
    return result?.terminalControl ?? terminalControl;
  }
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
    const exactVisibleDraft = codexComposerRowsMatchExpected(
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
 * Codex paints wrapped composer content as independent terminal rows, so tmux
 * cannot distinguish a visual wrap from an authored newline. Align the rows
 * against the exact text AKK injected instead of joining every row with `\n`.
 *
 * Only row boundaries are ambiguous: they may consume an authored newline, an
 * omitted run of ASCII spaces at a word wrap, or no character at a CJK/token
 * wrap. Every visible character remains character-for-character exact, and an
 * empty row can only advance through an authored newline (plus terminal-trimmed
 * spaces before it), so blank-line structure is preserved.
 */
function codexComposerRowsMatchExpected(
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
  const body = [
    region[0].replace(/^\s*❯\s?/u, ""),
    ...region.slice(1).map((line) =>
      line.startsWith("  ") ? line.slice(2) : line
    )
  ].join("\n");
  if (composerComparableText(body) !== composerComparableText(expectedText)) {
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
  return left.kind === right.kind &&
    left.target === right.target &&
    left.socketPath === right.socketPath &&
    left.session === right.session &&
    left.window === right.window &&
    left.pane === right.pane &&
    left.panePid === right.panePid;
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
