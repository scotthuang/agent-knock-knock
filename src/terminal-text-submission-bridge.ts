import { createHash } from "node:crypto";
import type { ExecutorKind } from "./executors.js";
import type {
  TerminalAgentAdapter,
  TerminalRuntimeIdentity,
  TerminalScreenInspection
} from "./terminal-agent-adapter.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import {
  claudeInjectedPasteProofEligible,
  revalidateClaudeComposerProof,
  settleClaudeInjectedPasteComposer,
  type ClaudeComposerBeforeEnterProof,
  type ClaudeInjectedPasteCapture,
  type ClaudeInjectedPasteProofPorts
} from "./claude-injected-paste-proof.js";
import { TerminalControlInputNotSentError } from
  "./terminal-control-provider.js";

// Verified Codex profiles through 0.155.1 keep Enter in paste/newline mode for
// 120ms after burst input. Cross that boundary rather than landing on it, and
// also require observable composer stability instead of treating this delay
// alone as acceptance.
export const CODEX_PASTE_ENTER_SETTLE_MS = 121;
export const CODEX_MULTILINE_SETTLE_POLL_MS = 30;
// A capture can itself take longer than the old two-second deadline on a busy
// tmux server. Give repaint discovery a bounded five-second window and, once
// an exact frame has been observed, always allow the required stable/final
// captures to complete instead of letting the first I/O consume their budget.
const CODEX_MULTILINE_SETTLE_TIMEOUT_MS = 5_000;
export const CODEX_MULTILINE_STABLE_CAPTURES = 2;
export const CODEX_EXACT_CANDIDATE_GRACE_CAPTURES = 8;
export const CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES = 240;

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
  /** Require the agent's exact stable composer proof even for a single-line send. */
  requireExactComposerBeforeEnter?: boolean;
  /**
   * User-explicit managed-path guard. Recapture an exactly empty composer
   * immediately before the first text-delivery call so a stale list/preflight
   * observation can fall back without appending to a human draft.
   */
  requireExactEmptyComposerBeforeText?: boolean;
  /** User-explicit physical Send may steer a mutable working composer. */
  allowWorkingComposerForUserExplicit?: boolean;
  /**
   * User-explicit managed Send only: after an exactly empty pre-text
   * boundary has accepted the request, cross Codex's paste-suppression window
   * and dispatch Enter without using a rendered Composer proof as a veto.
   */
  userExplicitEnterAfterTextWithoutComposerVeto?: boolean;
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

type TerminalTextSubmissionPreflight =
  | "send"
  | "send_with_composer"
  | "observe_composer";

interface CapturedTerminalInspection {
  terminalControl: TerminalControlRef;
  screen: string;
  inspection: TerminalScreenInspection;
}

export interface TerminalTextSubmissionRuntimePorts {
  preflight(
    terminalControl: TerminalControlRef,
    operation: TerminalTextSubmissionPreflight
  ): void;
  verifyIdentity(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime: TerminalRuntimeIdentity | undefined
  ): Promise<TerminalControlRef>;
  captureInspection(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    options: {
      runtime?: TerminalRuntimeIdentity;
      scrollbackLines?: number;
    }
  ): Promise<CapturedTerminalInspection>;
  captureStyled(terminalControl: TerminalControlRef): Promise<string>;
  deliverText(terminalControl: TerminalControlRef, text: string): Promise<void>;
  dispatchEnter(terminalControl: TerminalControlRef): Promise<void>;
  nowMs(): number;
  sleep(milliseconds: number): Promise<void>;
}

interface CodexComposerCapture {
  state: "exact_draft" | "exact_empty" | "different_draft";
  digest: string;
}

export interface TerminalTextSubmissionClassifierPorts {
  sameIdentity(
    left: TerminalControlRef,
    right: TerminalControlRef
  ): boolean;
  stripEscapes(screen: string): string;
  codexBlockingModalVisible(screen: string): boolean;
  inspectCodexAsyncQuestionInputMode(
    screen: string
  ): "absent" | "collapsed" | "expanded" | "ambiguous";
  currentCodexComposer(
    styledScreen: string,
    expectedText: string,
    allowOpaqueLargePastePlaceholder?: boolean,
    classifyOpaqueLargePasteAsDifferent?: boolean
  ): CodexComposerCapture | undefined;
  exactTerminalComposer(
    agent: ExecutorKind,
    screen: string,
    expectedText: string
  ): { digest: string } | undefined;
  exactClaudeComposer(
    screen: string,
    expectedText: string
  ): { digest: string } | undefined;
  exactClaudeInjectedPastePlaceholder(
    screen: string,
    expectedText: string
  ): ClaudeInjectedPasteCapture | undefined;
}

export interface CreateTerminalTextSubmissionBridgeInput {
  runtime: TerminalTextSubmissionRuntimePorts;
  classifiers: TerminalTextSubmissionClassifierPorts;
}

function terminalSendComposerRequirements(
  agent: ExecutorKind,
  multiline: boolean,
  options: TerminalSendOptions
): {
  exactEmptyRetryAuthority?: {
    preliminaryComposerDigest: string;
  };
  requireExactEmptyComposerBeforeText: boolean;
  requireExactComposer: boolean;
} {
  const exactEmptyRetryAuthority =
    options.requireExactEmptyComposerAfterBeforeText;
  const requireExactEmptyComposerBeforeText =
    options.requireExactEmptyComposerBeforeText === true;
  const userExplicitEnterAfterTextWithoutComposerVeto =
    options.userExplicitEnterAfterTextWithoutComposerVeto === true;
  if (
    userExplicitEnterAfterTextWithoutComposerVeto &&
    !requireExactEmptyComposerBeforeText
  ) {
    throw new TerminalInputNotStartedError(
      "composer-veto-free Enter requires an exact-empty pre-text user-explicit boundary"
    );
  }
  const requireExactComposer =
    !userExplicitEnterAfterTextWithoutComposerVeto &&
    (
      (agent === "codex" && multiline) ||
      options.requireExactComposerBeforeEnter === true ||
      requireExactEmptyComposerBeforeText ||
      exactEmptyRetryAuthority !== undefined
    );
  if (
    exactEmptyRetryAuthority !== undefined &&
    (
      agent !== "codex" ||
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
  return {
    exactEmptyRetryAuthority,
    requireExactEmptyComposerBeforeText,
    requireExactComposer
  };
}

async function recordTerminalSendStage(
  options: TerminalSendOptions,
  event: TerminalTransportStageEvent,
  preserveUserInput: boolean,
  previousError?: unknown
): Promise<unknown> {
  try {
    await options.onTransportStage?.(event);
    return previousError;
  } catch (error) {
    if (!preserveUserInput) throw error;
    return previousError ?? error;
  }
}

async function runTerminalSendBeforeEnter(
  options: TerminalSendOptions,
  context: TerminalSendBoundaryContext,
  preserveUserInput: boolean,
  previousError?: unknown
): Promise<unknown> {
  try {
    await options.beforeEnter?.(context);
    return previousError;
  } catch (error) {
    if (!preserveUserInput) throw error;
    return previousError ?? error;
  }
}

async function waitForUserExplicitEnter(input: {
  enabled: boolean;
  textInjectedAt: number;
  nowMs: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  if (!input.enabled) return;
  await input.sleep(Math.max(
    0,
    CODEX_PASTE_ENTER_SETTLE_MS -
      (input.nowMs() - input.textInjectedAt)
  ));
}

function throwPostTextHookFailureAfterUserEnter(
  enabled: boolean,
  error: unknown
): void {
  if (!enabled || error === undefined) return;
  throw new TerminalEnterDispatchReservedError(
    "user-explicit terminal Enter was dispatched but post-text bookkeeping failed; do not retry",
    { cause: error }
  );
}

export class TerminalTextSubmissionBridge {
  private readonly runtime: TerminalTextSubmissionRuntimePorts;
  private readonly classifiers: TerminalTextSubmissionClassifierPorts;

  constructor(input: CreateTerminalTextSubmissionBridgeInput) {
    this.runtime = input.runtime;
    this.classifiers = input.classifiers;
  }

  async send(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    text: string,
    options: TerminalSendOptions = {}
  ): Promise<TerminalSendResult> {
    const multiline = /[\r\n]/u.test(text.trimEnd());
    const {
      exactEmptyRetryAuthority,
      requireExactEmptyComposerBeforeText,
      requireExactComposer
    } = terminalSendComposerRequirements(adapter.agent, multiline, options);
    try {
      this.runtime.preflight(
        terminalControl,
        requireExactComposer || exactEmptyRetryAuthority
          ? "send_with_composer"
          : "send"
      );
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
      verifiedForText = await this.runtime.verifyIdentity(
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
    let composerVerifiedImmediatelyBeforeText = false;
    if (exactEmptyRetryAuthority) {
      try {
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
          !this.classifiers.sameIdentity(
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
      if (requireExactEmptyComposerBeforeText) {
        try {
          verifiedForText = await this.verifyExactEmptyComposerBeforeText(
            adapter,
            verifiedForText,
            normalized,
            options.runtime,
            options.allowWorkingComposerForUserExplicit === true
          );
          composerVerifiedImmediatelyBeforeText = true;
        } catch (error) {
          throw new TerminalInputNotStartedError(
            error instanceof Error ? error.message : String(error),
            { cause: error }
          );
        }
      }
    }
    if (!composerVerifiedImmediatelyBeforeText) {
      try {
        const reverifiedForText = await this.runtime.verifyIdentity(
          adapter.agent,
          verifiedForText,
          options.runtime
        );
        if (!this.classifiers.sameIdentity(
          verifiedForText,
          reverifiedForText
        )) {
          throw new Error(
            "terminal identity changed after the final pre-text check"
          );
        }
        verifiedForText = reverifiedForText;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (exactEmptyRetryAuthority) {
          throw new TerminalEnterDispatchReservedError(message, {
            cause: error
          });
        }
        throw new TerminalInputNotStartedError(message, { cause: error });
      }
    }
    try {
      await this.runtime.deliverText(verifiedForText, normalized);
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
    const textInjectedAt = this.runtime.nowMs();
    const preserveUserInput =
      options.userExplicitEnterAfterTextWithoutComposerVeto === true;
    const allowClaudeInjectedPastePlaceholder =
      claudeInjectedPasteProofEligible({
        agent: adapter.agent,
        multiline,
        composerVerifiedImmediatelyBeforeText,
        terminalControl: verifiedForText
      });
    let postTextHookError: unknown;
    let verifiedForEnter: TerminalControlRef;
    let claudeComposerProof: ClaudeComposerBeforeEnterProof | undefined;
    try {
      postTextHookError = await recordTerminalSendStage(
        options,
        {
          stage: "text_injected",
          agent: adapter.agent,
          terminalControl: verifiedForText,
          multiline
        },
        preserveUserInput
      );
      if (preserveUserInput) {
        await waitForUserExplicitEnter({
          enabled: true,
          textInjectedAt,
          nowMs: this.runtime.nowMs,
          sleep: this.runtime.sleep
        });
        verifiedForEnter = await this.runtime.verifyIdentity(
          adapter.agent,
          terminalControl,
          options.runtime
        );
      } else if (adapter.agent === "codex" && requireExactComposer) {
        verifiedForEnter = await this.settleCodexMultilineComposer(
          adapter,
          terminalControl,
          normalized,
          options.runtime,
          {
            allowOpaqueLargePastePlaceholder:
              exactEmptyRetryAuthority === undefined,
            allowWorkingComposer:
              options.allowWorkingComposerForUserExplicit === true
          }
        );
      } else if (allowClaudeInjectedPastePlaceholder) {
        claudeComposerProof = await settleClaudeInjectedPasteComposer({
          terminalControl: verifiedForText,
          expectedText: normalized,
          runtime: options.runtime,
          allowWorkingComposer:
            options.allowWorkingComposerForUserExplicit === true,
          ports: this.claudeInjectedPasteProofPorts(adapter)
        });
        verifiedForEnter = claudeComposerProof.terminalControl;
      } else if (requireExactComposer) {
        verifiedForEnter = await this.verifyExactComposerBeforeEnter(
          adapter,
          terminalControl,
          normalized,
          options.runtime,
          options.allowWorkingComposerForUserExplicit === true
        );
      } else {
        verifiedForEnter = await this.runtime.verifyIdentity(
          adapter.agent,
          terminalControl,
          options.runtime
        );
      }
      postTextHookError = await runTerminalSendBeforeEnter(
        options,
        {
          agent: adapter.agent,
          terminalControl: verifiedForEnter,
          multiline,
          text: normalized
        },
        preserveUserInput,
        postTextHookError
      );
      if (requireExactComposer) {
        if (adapter.agent === "codex") {
          verifiedForEnter = await this.settleCodexMultilineComposer(
            adapter,
            terminalControl,
            normalized,
            options.runtime,
            {
              allowOpaqueLargePastePlaceholder:
                exactEmptyRetryAuthority === undefined,
              allowWorkingComposer:
                options.allowWorkingComposerForUserExplicit === true
            }
          );
        } else if (
          allowClaudeInjectedPastePlaceholder && claudeComposerProof
        ) {
          verifiedForEnter = await revalidateClaudeComposerProof({
            proof: claudeComposerProof,
            expectedText: normalized,
            runtime: options.runtime,
            allowWorkingComposer:
              options.allowWorkingComposerForUserExplicit === true,
            ports: this.claudeInjectedPasteProofPorts(adapter)
          });
        } else {
          verifiedForEnter = await this.verifyExactComposerBeforeEnter(
            adapter,
            terminalControl,
            normalized,
            options.runtime,
            options.allowWorkingComposerForUserExplicit === true
          );
        }
      } else if (options.beforeEnter) {
        verifiedForEnter = await this.runtime.verifyIdentity(
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
    try {
      await this.runtime.dispatchEnter(verifiedForEnter);
      postTextHookError = await recordTerminalSendStage(
        options,
        {
          stage: "enter_dispatched",
          agent: adapter.agent,
          terminalControl: verifiedForEnter,
          multiline
        },
        preserveUserInput,
        postTextHookError
      );
      throwPostTextHookFailureAfterUserEnter(
        preserveUserInput,
        postTextHookError
      );
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

  async observeCodexComposer(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime?: TerminalRuntimeIdentity
  ): Promise<TerminalCodexComposerObservation> {
    const normalized = expectedText.trimEnd();
    if (!normalized) {
      return {
        state: "unavailable",
        reason: "expected Codex draft is empty"
      };
    }
    try {
      this.runtime.preflight(terminalControl, "observe_composer");
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
      runtime,
      { minimumStableMs: CODEX_MULTILINE_SETTLE_POLL_MS }
    );
  }

  async settleCodexComposerObservation(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime: TerminalRuntimeIdentity | undefined,
    options: {
      minimumStableMs: number;
      requiredState?: TerminalCodexCapturedComposerState;
      allowOpaqueLargePastePlaceholder?: boolean;
      classifyOpaqueLargePasteAsDifferent?: boolean;
      allowWorkingComposer?: boolean;
    }
  ): Promise<TerminalCodexComposerObservation> {
    const startedAt = this.runtime.nowMs();
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
            options.allowOpaqueLargePastePlaceholder === true,
          classifyOpaqueLargePasteAsDifferent:
            options.classifyOpaqueLargePasteAsDifferent === true,
          allowWorkingComposer: options.allowWorkingComposer === true
        }
      );
      if (
        snapshot.state === "identity_drift" ||
        (snapshot.state === "unavailable" && snapshot.retryable !== true)
      ) {
        return snapshot;
      }
      if (
        this.runtime.nowMs() - startedAt >
          CODEX_MULTILINE_SETTLE_TIMEOUT_MS
      ) {
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
        this.classifiers.sameIdentity(
          candidate.terminalControl,
          snapshot.terminalControl
        );
      if (sameCandidate) {
        stableCaptures += 1;
      } else {
        candidate = snapshot;
        stableSince = this.runtime.nowMs();
        stableCaptures = 1;
        finishObservedExactCandidate = snapshot.state === "exact_draft";
      }

      const stableForMs = stableSince === undefined
        ? 0
        : this.runtime.nowMs() - stableSince;
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
        const finalSnapshot = await this.captureCodexComposerSnapshot(
          adapter,
          snapshot.terminalControl,
          expectedText,
          runtime,
          {
            allowOpaqueLargePastePlaceholder:
              options.allowOpaqueLargePastePlaceholder === true,
            classifyOpaqueLargePasteAsDifferent:
              options.classifyOpaqueLargePasteAsDifferent === true,
            allowWorkingComposer: options.allowWorkingComposer === true
          }
        );
        if (
          finalSnapshot.state === snapshot.state &&
          "digest" in finalSnapshot &&
          finalSnapshot.digest === snapshot.digest &&
          this.classifiers.sameIdentity(
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
        stableSince = this.runtime.nowMs();
        stableCaptures = 1;
        finishObservedExactCandidate = finalSnapshot.state === "exact_draft";
      }

      const elapsed = this.runtime.nowMs() - startedAt;
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
      await this.runtime.sleep(Math.max(
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

  async captureCodexComposerSnapshot(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime?: TerminalRuntimeIdentity,
    options: {
      allowOpaqueLargePastePlaceholder?: boolean;
      classifyOpaqueLargePasteAsDifferent?: boolean;
      allowWorkingComposer?: boolean;
    } = {}
  ): Promise<TerminalCodexComposerSnapshot> {
    let verifiedBefore: TerminalControlRef;
    try {
      verifiedBefore = await this.runtime.verifyIdentity(
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
      styledScreen = await this.runtime.captureStyled(verifiedBefore);
    } catch (error) {
      return {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    const screen = this.classifiers.stripEscapes(styledScreen);
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
      verifiedAfter = await this.runtime.verifyIdentity(
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
    if (!this.classifiers.sameIdentity(verifiedBefore, verifiedAfter)) {
      return {
        state: "identity_drift",
        reason: "terminal control identity changed across the Codex composer capture"
      };
    }

    const screenDigest = createHash("sha256")
      .update(styledScreen)
      .digest("hex");
    if (
      inspection.approval.blocked ||
      inspection.activity.state === "awaiting_approval" ||
      this.classifiers.codexBlockingModalVisible(screen)
    ) {
      return {
        state: "approval_or_modal",
        terminalControl: verifiedAfter,
        digest: screenDigest
      };
    }
    if (
      inspection.activity.state === "working" &&
      options.allowWorkingComposer !== true
    ) {
      return {
        state: "working",
        terminalControl: verifiedAfter,
        digest: screenDigest
      };
    }

    const composer = this.classifiers.currentCodexComposer(
      styledScreen,
      expectedText,
      options.allowOpaqueLargePastePlaceholder === true,
      options.classifyOpaqueLargePasteAsDifferent === true
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

  private async settleCodexMultilineComposer(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime?: TerminalRuntimeIdentity,
    options: {
      allowOpaqueLargePastePlaceholder?: boolean;
      allowWorkingComposer?: boolean;
    } = {}
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
          options.allowOpaqueLargePastePlaceholder === true,
        allowWorkingComposer: options.allowWorkingComposer === true
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

  private async verifyExactComposerBeforeEnter(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime?: TerminalRuntimeIdentity,
    allowWorkingComposer = false
  ): Promise<TerminalControlRef> {
    const captured = await this.runtime.captureInspection(
      adapter,
      terminalControl,
      {
        runtime,
        scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
      }
    );
    const exactComposer = this.classifiers.exactTerminalComposer(
      adapter.agent,
      captured.screen,
      expectedText
    );
    if (
      captured.inspection.approval.blocked ||
      !(
        ["idle", "unknown"].includes(captured.inspection.activity.state) ||
        (
          allowWorkingComposer &&
          captured.inspection.activity.state === "working"
        )
      ) ||
      !exactComposer
    ) {
      throw new Error(
        `${adapter.displayName} composer was not exact and idle immediately before Enter`
      );
    }
    const verifiedImmediatelyBeforeEnter =
      await this.runtime.verifyIdentity(
        adapter.agent,
        captured.terminalControl,
        runtime
      );
    if (!this.classifiers.sameIdentity(
      captured.terminalControl,
      verifiedImmediatelyBeforeEnter
    )) {
      throw new Error(
        "terminal control identity changed after the final exact composer capture"
      );
    }
    return verifiedImmediatelyBeforeEnter;
  }

  private claudeInjectedPasteProofPorts(
    adapter: TerminalAgentAdapter
  ): ClaudeInjectedPasteProofPorts {
    return {
      nowMs: this.runtime.nowMs,
      sleep: this.runtime.sleep,
      capture: (terminalControl, runtime) =>
        this.runtime.captureInspection(adapter, terminalControl, {
          runtime,
          scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
        }),
      verifyIdentity: (terminalControl, runtime) =>
        this.runtime.verifyIdentity(adapter.agent, terminalControl, runtime),
      exactDraft: this.classifiers.exactClaudeComposer,
      exactInjectedPastePlaceholder:
        this.classifiers.exactClaudeInjectedPastePlaceholder
    };
  }

  private async verifyExactEmptyComposerBeforeText(
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    expectedText: string,
    runtime?: TerminalRuntimeIdentity,
    allowWorkingComposer = false
  ): Promise<TerminalControlRef> {
    if (adapter.agent === "codex") {
      const snapshot = await this.captureCodexComposerSnapshot(
        adapter,
        terminalControl,
        expectedText,
        runtime
      );
      if (snapshot.state !== "exact_empty") {
        const reason = "reason" in snapshot
          ? snapshot.reason
          : `Codex composer is ${snapshot.state}`;
        throw new Error(
          `Codex composer was not exactly empty immediately before text: ${reason}`
        );
      }
      return snapshot.terminalControl;
    }
    const captured = await this.runtime.captureInspection(
      adapter,
      terminalControl,
      {
        runtime,
        scrollbackLines: CODEX_MULTILINE_SETTLE_SCROLLBACK_LINES
      }
    );
    if (
      captured.inspection.approval.blocked ||
      !(
        ["idle", "unknown"].includes(captured.inspection.activity.state) ||
        (
          allowWorkingComposer &&
          captured.inspection.activity.state === "working"
        )
      ) ||
      !this.classifiers.exactTerminalComposer(adapter.agent, captured.screen, "")
    ) {
      throw new Error(
        `${adapter.displayName} composer was not exactly empty immediately before text`
      );
    }
    const verified = await this.runtime.verifyIdentity(
      adapter.agent,
      captured.terminalControl,
      runtime
    );
    if (!this.classifiers.sameIdentity(
      captured.terminalControl,
      verified
    )) {
      throw new Error(
        "terminal control identity changed after the final empty composer capture"
      );
    }
    return verified;
  }
}
