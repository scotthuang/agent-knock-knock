import type { ExecutorKind } from "./executors.js";
import type {
  TerminalRuntimeIdentity,
  TerminalScreenInspection
} from "./terminal-agent-adapter.js";
import {
  type TerminalControlProvider
} from "./terminal-control-provider.js";
import {
  hasCanonicalTerminalEndpoint,
  sameTerminalControlIncarnation,
  terminalControlEvidenceMatches,
  terminalEndpointFromControlRef,
  terminalEndpointIdentityFromEvidence,
  terminalEndpointIdentityKey,
  type TerminalControlEvidence,
  type TerminalControlRef
} from "./terminal-control-ref.js";
import {
  normalizeTerminalInteractionResponseV2,
  type TerminalInteractionAnswer,
  type TerminalInteractionSubject,
  type TerminalInteractionSubjectProjection,
  type TerminalInteractionSubjectResponse
} from "./terminal-interaction-protocol.js";
import { captureTerminalInteraction } from "./terminal-interaction-core.js";
import type {
  NativeQuestionnaireActionPlan,
  NativeQuestionnaireInspection
} from "./terminal-questionnaire-adapter.js";
import {
  observeTerminalModelControl,
  planTerminalModelControl,
  probeTerminalModelControl
} from "./terminal-model-control.js";
import { CODEX_PASTE_ENTER_SETTLE_MS } from
  "./terminal-text-submission-bridge.js";

const TERMINAL_INTERACTION_TTL_MS = 10 * 60 * 1_000;
const TERMINAL_INTERACTION_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TERMINAL_INTERACTION_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

export type TerminalInteractionReservedStage =
  | "reservation_uncertain"
  | "text_uncertain"
  | "key_uncertain";

/**
 * A response reservation or terminal input may already have happened. The
 * same interaction must never be dispatched automatically after this error.
 */
export class TerminalInteractionDispatchReservedError extends Error {
  readonly code = "AKK_TERMINAL_INTERACTION_DISPATCH_RESERVED";
  readonly doNotRetry = true;

  constructor(
    readonly stage: TerminalInteractionReservedStage,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "TerminalInteractionDispatchReservedError";
  }
}

/**
 * A durable response reservation exists, but the bridge proved that no
 * terminal text or key delivery was attempted. The caller must discard the
 * one-shot offer and obtain a fresh status projection before trying again.
 */
export class TerminalInteractionInputNotStartedError extends Error {
  readonly code = "AKK_TERMINAL_INTERACTION_INPUT_NOT_STARTED";
  readonly stage = "input_not_started";
  readonly doNotRetry = true;
  readonly requiresFreshOffer = true;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "TerminalInteractionInputNotStartedError";
  }
}

export interface TerminalInteractionAuthorizationContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  fingerprint: string;
  projection: TerminalInteractionSubjectProjection;
  response: TerminalInteractionSubjectResponse;
  runtime?: TerminalRuntimeIdentity;
}

export interface TerminalInteractionAuthorizationDecision {
  approved: boolean;
  reason?: string;
}

export interface TerminalInteractionBeforeDispatchContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  fingerprint: string;
  projection: TerminalInteractionSubjectProjection;
  response: TerminalInteractionSubjectResponse;
  runtime?: TerminalRuntimeIdentity;
}

export interface TerminalInteractionResponseExecution {
  responded: boolean;
  blocked: boolean;
  reason?: string;
  interactionId: string;
  questionId?: string;
  responseKind?: TerminalInteractionAnswer["response_kind"];
  outcome?:
    | "submitted_or_advanced"
    | "custom_text_opened"
    | "confirmed"
    | "cancelled";
}

/** Input is validated against the freshly recaptured v1/v2 projection. */
export type TerminalInteractionResponseInput = {
  readonly interaction_id: string;
  readonly turn_id?: string;
  readonly subject?: TerminalInteractionSubject;
  readonly answers: readonly TerminalInteractionAnswer[];
};

export interface TerminalInteractionResponseOptions {
  agentVersion: string;
  expectedFingerprint: string;
  expectedExpiresAt: string;
  scrollbackLines?: number;
  runtime?: TerminalRuntimeIdentity;
  authorize?: (
    context: TerminalInteractionAuthorizationContext
  ) => TerminalInteractionAuthorizationDecision |
    Promise<TerminalInteractionAuthorizationDecision>;
  /**
   * Resolve only after the caller has durably persisted its one-shot
   * dispatch receipt. A successful return is the offer lease acceptance
   * boundary for the final read-only recapture.
   */
  beforeDispatch?: (
    context: TerminalInteractionBeforeDispatchContext
  ) => void | Promise<void>;
}

export interface TerminalInteractionRuntimeOffer {
  readonly projection: TerminalInteractionSubjectProjection;
  readonly promptFingerprint: string;
  readonly surfaceId: string;
  readonly actionPlan: NativeQuestionnaireActionPlan;
  readonly nativeInspection: Exclude<
    NativeQuestionnaireInspection,
    { status: "none" }
  >;
}

interface CapturedTerminalInteractionOffer {
  readonly terminalControl: TerminalControlRef;
  readonly inspection: TerminalScreenInspection;
  readonly offer?: TerminalInteractionRuntimeOffer;
}

interface TerminalInteractionCapture {
  readonly terminalControl: TerminalControlRef;
  readonly screen: string;
  readonly inspection: TerminalScreenInspection;
}

interface TerminalInteractionResponseRuntime {
  captureInspection: (
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime: TerminalRuntimeIdentity,
    scrollbackLines?: number
  ) => Promise<TerminalInteractionCapture>;
  verifyIdentity: (
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime: TerminalRuntimeIdentity
  ) => Promise<TerminalControlRef>;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
}

/**
 * Executes only a closed questionnaire action plan. Store mutation, terminal
 * locking, and the caller's at-most-once ledger remain outside this service.
 */
export class TerminalInteractionResponseBridge {
  constructor(
    private readonly terminalProvider: TerminalControlProvider,
    private readonly runtime: TerminalInteractionResponseRuntime
  ) {}

  async respond(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    response: TerminalInteractionResponseInput,
    options: TerminalInteractionResponseOptions
  ): Promise<TerminalInteractionResponseExecution> {
    const runtime = {
      ...options.runtime,
      agentVersion: options.agentVersion
    };
    const optionReason = terminalInteractionOptionPreflightReason(
      options,
      runtime
    );
    if (optionReason) {
      return blockedTerminalInteractionResponse(response, optionReason);
    }
    const first = await this.captureOffer(
      agent,
      terminalControl,
      runtime,
      options.scrollbackLines
    ).catch((error) => error);
    if (first instanceof Error) {
      return blockedTerminalInteractionResponse(response, first.message);
    }
    const firstReason = terminalInteractionOfferPreflightReason(
      first.offer,
      options,
      this.runtime.now()
    );
    if (firstReason || !first.offer) {
      return blockedTerminalInteractionResponse(
        response,
        firstReason ?? "native questionnaire has no safe interaction offer",
        first.offer
      );
    }
    const validatedResponse = normalizeTerminalInteractionResponseV2(
      response,
      first.offer.projection,
      {
        now: this.runtime.now(),
        // The capture immediately above is the authoritative freshness proof.
        // A wall-clock bucket boundary must not override exact live terminal
        // evidence before any input has been sent.
        allowExpiredForLiveRecapture: true
      }
    );
    const planReason = terminalInteractionPlanPreflightReason(
      validatedResponse,
      first.offer.actionPlan
    );
    if (planReason) {
      return blockedTerminalInteractionResponse(
        validatedResponse,
        planReason,
        first.offer
      );
    }
    const capabilityReason = terminalInteractionCapabilityReason(
      this.terminalProvider,
      first.terminalControl,
      first.offer.actionPlan
    );
    if (capabilityReason) {
      return blockedTerminalInteractionResponse(
        validatedResponse,
        capabilityReason,
        first.offer
      );
    }
    const authorization = await authorizeTerminalInteraction(
      options.authorize,
      interactionHookContext(
        agent,
        first.terminalControl,
        first.offer,
        validatedResponse,
        runtime
      )
    );
    if (!authorization.approved) {
      return blockedTerminalInteractionResponse(
        validatedResponse,
        authorization.reason ??
          "terminal interaction response was not authorized",
        first.offer
      );
    }
    const afterAuthorization = await this.captureOffer(
      agent,
      first.terminalControl,
      runtime,
      options.scrollbackLines
    ).catch((error) => error);
    if (afterAuthorization instanceof Error) {
      return blockedTerminalInteractionResponse(
        validatedResponse,
        afterAuthorization.message,
        first.offer
      );
    }
    const afterAuthorizationReason = terminalInteractionOfferPreflightReason(
      afterAuthorization.offer,
      options,
      this.runtime.now()
    );
    if (afterAuthorizationReason) {
      return blockedTerminalInteractionResponse(
        validatedResponse,
        afterAuthorizationReason,
        first.offer
      );
    }
    if (!sameTerminalInteractionOffer(first, afterAuthorization, {
      // expires_at is generated from AKK wall-clock freshness buckets, not
      // from the native prompt. All semantic projection and action-plan fields
      // still have to match exactly.
      ignoreExpiresAt: true
    })) {
      return blockedTerminalInteractionResponse(
        validatedResponse,
        "native questionnaire changed after authorization",
        first.offer
      );
    }
    await reserveTerminalInteractionDispatch(
      options.beforeDispatch,
      interactionHookContext(
        agent,
        afterAuthorization.terminalControl,
        afterAuthorization.offer!,
        validatedResponse,
        runtime
      )
    );
    const finalCapture = await this.captureOffer(
      agent,
      afterAuthorization.terminalControl,
      runtime,
      options.scrollbackLines
    ).catch((error) => {
      if (options.beforeDispatch) {
        throw terminalInteractionInputNotStartedError(
          error,
          "cannot recapture native questionnaire after dispatch reservation"
        );
      }
      return error;
    });
    if (finalCapture instanceof Error) {
      return blockedTerminalInteractionResponse(
        validatedResponse,
        finalCapture.message,
        first.offer
      );
    }
    if (!sameTerminalInteractionOffer(afterAuthorization, finalCapture, {
      // The projection expiry is bucketed and may roll over during this final,
      // bounded recapture even though the questionnaire is exact. Prompt,
      // action plan, terminal identity, and owner remain exact-match fences.
      ignoreExpiresAt: true
    })) {
      if (options.beforeDispatch) {
        throw new TerminalInteractionInputNotStartedError(
          "native questionnaire changed after dispatch reservation"
        );
      }
      return blockedTerminalInteractionResponse(
        validatedResponse,
        "native questionnaire changed before dispatch",
        first.offer
      );
    }
    const verified = await this.runtime.verifyIdentity(
      agent,
      finalCapture.terminalControl,
      runtime
    ).catch((error) => {
      if (options.beforeDispatch) {
        throw terminalInteractionInputNotStartedError(
          error,
          "terminal identity could not be verified immediately before interaction dispatch"
        );
      }
      throw terminalInteractionReservedError(
        "key_uncertain",
        error,
        "terminal identity could not be verified immediately before interaction dispatch"
      );
    });
    if (!sameTerminalControlIncarnation(
      finalCapture.terminalControl,
      verified
    )) {
      if (options.beforeDispatch) {
        throw new TerminalInteractionInputNotStartedError(
          "terminal identity changed after the final questionnaire capture"
        );
      }
      throw new TerminalInteractionDispatchReservedError(
        "key_uncertain",
        "terminal identity changed after the final questionnaire capture"
      );
    }
    const answer = validatedResponse.answers[0];
    const outcome = await dispatchTerminalInteractionAnswer({
      agent,
      provider: this.terminalProvider,
      terminalControl: verified,
      actionPlan: finalCapture.offer!.actionPlan,
      answer,
      sleep: this.runtime.sleep,
      reverifyTerminalIdentity: async (currentControl) => {
        const reverified = await this.runtime.verifyIdentity(
          agent,
          currentControl,
          runtime
        );
        if (!sameTerminalControlIncarnation(currentControl, reverified)) {
          throw new Error(
            "terminal identity changed between interaction text and Enter"
          );
        }
        return reverified;
      }
    });
    return {
      responded: true,
      blocked: false,
      interactionId: validatedResponse.interaction_id,
      questionId: answer.question_id,
      responseKind: answer.response_kind,
      outcome
    };
  }

  private async captureOffer(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime: TerminalRuntimeIdentity,
    scrollbackLines?: number
  ): Promise<CapturedTerminalInteractionOffer> {
    const captured = await this.runtime.captureInspection(
      agent,
      terminalControl,
      runtime,
      scrollbackLines
    );
    return {
      terminalControl: captured.terminalControl,
      inspection: captured.inspection,
      offer: captureTerminalInteractionRuntimeOffer({
        agent,
        terminalControl: captured.terminalControl,
        screen: captured.screen,
        runtime,
        now: this.runtime.now(),
        approvalBlocked: captured.inspection.approval.blocked
      })
    };
  }
}

function terminalInteractionTurnId(
  runtime: TerminalRuntimeIdentity | undefined
): string | undefined {
  // Questionnaire mutation is managed-Turn-only. A raw terminal's
  // conversationId is a discovery label, not durable response authority.
  const candidate = runtime?.turnId;
  return typeof candidate === "string" &&
    TERMINAL_INTERACTION_IDENTIFIER_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

function terminalInteractionSubject(
  runtime: TerminalRuntimeIdentity | undefined
): TerminalInteractionSubject | undefined {
  if (runtime?.interactionSubject) {
    return runtime.interactionSubject;
  }
  const turnId = terminalInteractionTurnId(runtime);
  const messageId = runtime?.messageId;
  return turnId && typeof messageId === "string" &&
      TERMINAL_INTERACTION_IDENTIFIER_PATTERN.test(messageId)
    ? { kind: "managed_turn", turn_id: turnId, message_id: messageId }
    : undefined;
}

function terminalInteractionExpiry(now: Date): string | undefined {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    return undefined;
  }
  const windowStart = Math.floor(nowMs / TERMINAL_INTERACTION_TTL_MS) *
    TERMINAL_INTERACTION_TTL_MS;
  return new Date(windowStart + TERMINAL_INTERACTION_TTL_MS).toISOString();
}

function terminalInteractionCanonicalIdentity(
  terminalControl: TerminalControlRef
): Record<string, unknown> | undefined {
  if (!hasCanonicalTerminalEndpoint(terminalControl)) {
    return undefined;
  }
  const terminal = terminalEndpointFromControlRef(terminalControl);
  if (
    !Number.isInteger(terminal.processAnchorPid) ||
    Number(terminal.processAnchorPid) <= 0
  ) {
    return undefined;
  }
  // Surface identity is shared by independent observers. Keep physical
  // terminal identity separate from runtime-native identity so an optional
  // observer-only fence (for example processStartedAt) cannot split one live
  // questionnaire into different Monitor and Watch surfaces. Dispatch still
  // revalidates the complete runtime immediately before any terminal input.
  return {
    terminal_identity: terminalEndpointIdentityKey(terminal),
    terminal_process_anchor_pid: terminal.processAnchorPid
  };
}

function terminalInteractionNativeTaskIdentity(
  runtime: TerminalRuntimeIdentity
): Record<string, unknown> {
  // Include only native-task fields that both managed Turn and exact Watch
  // observations can derive from their durable anchors. Optional runtime
  // verification fields remain on `runtime`; they are identity fences, not
  // cross-observer surface identity.
  return {
    agent_pid: runtime.pid,
    native_session_id: runtime.nativeSessionId,
    native_process_uuid: runtime.nativeProcessUuid,
    native_process_birth: runtime.nativeProcessBirth,
    native_rollout: runtime.nativeRollout,
    expected_native_session_id: runtime.expectedNativeSessionId,
    expected_empty_native_session: runtime.expectedEmptyNativeSession === true
  };
}

export function captureTerminalInteractionRuntimeOffer(input: {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  screen: string;
  runtime?: TerminalRuntimeIdentity;
  now: Date;
  approvalBlocked?: boolean;
  /** Exact durable Watch endpoint evidence for legacy provider refs. */
  trustedTerminalEvidence?: TerminalControlEvidence;
}): TerminalInteractionRuntimeOffer | undefined {
  const subject = terminalInteractionSubject(input.runtime);
  const agentVersion = input.runtime?.agentVersion;
  const expiry = terminalInteractionExpiry(input.now);
  const canonicalIdentity = input.runtime
    ? terminalInteractionCanonicalIdentity(input.terminalControl) ??
      terminalInteractionTrustedWatchIdentity(
        input.terminalControl,
        input.runtime,
        input.trustedTerminalEvidence
      )
    : undefined;
  if (
    !subject ||
    typeof agentVersion !== "string" ||
    agentVersion.length === 0 ||
    !expiry ||
    !canonicalIdentity ||
    input.approvalBlocked === true
  ) {
    return undefined;
  }
  if (exactCurrentModelControlSurface(
    input.agent,
    agentVersion,
    input.screen
  )) {
    return undefined;
  }
  const coreOffer = captureTerminalInteraction({
    subject,
    agent: input.agent,
    agentVersion,
    canonicalTerminalIdentity: canonicalIdentity,
    nativeTaskIdentity: terminalInteractionNativeTaskIdentity(input.runtime!),
    screen: input.screen,
    now: input.now,
    expiresAt: expiry,
    responseUncertain:
      input.runtime?.interactionDispatchState === "reserved" ||
      input.runtime?.interactionDispatchState === "uncertain",
    responseAuthority:
      input.runtime?.interactionResponseAuthority ?? "executable"
  });
  if (!coreOffer) {
    return undefined;
  }
  return {
    projection: coreOffer.projection,
    promptFingerprint: coreOffer.promptFingerprint,
    surfaceId: coreOffer.surfaceId,
    actionPlan: coreOffer.actionPlan,
    nativeInspection: coreOffer.nativeInspection
  };
}

export function exactCurrentModelControlSurface(
  agent: ExecutorKind,
  agentVersion: string | undefined,
  screen: string
): boolean {
  if (!agentVersion) return false;
  try {
    const capabilities = probeTerminalModelControl(agent, agentVersion);
    if (capabilities.status !== "supported") return false;
    const observation = observeTerminalModelControl(
      planTerminalModelControl(capabilities),
      screen
    );
    return observation.state !== "none" &&
      observation.state !== "ambiguous";
  } catch {
    return false;
  }
}

function terminalInteractionTrustedWatchIdentity(
  terminalControl: TerminalControlRef,
  runtime: TerminalRuntimeIdentity,
  evidence: TerminalControlEvidence | undefined
): Record<string, unknown> | undefined {
  if (
    runtime.interactionSubject?.kind !== "terminal_watch" ||
    !evidence ||
    !terminalControlEvidenceMatches(evidence, terminalControl)
  ) {
    return undefined;
  }
  const identity = terminalEndpointIdentityFromEvidence(evidence);
  if (!identity || !Number.isSafeInteger(evidence.process_anchor_pid) ||
      Number(evidence.process_anchor_pid) <= 0) {
    return undefined;
  }
  return {
    terminal_identity: terminalEndpointIdentityKey(identity),
    terminal_process_anchor_pid: evidence.process_anchor_pid
  };
}

function terminalInteractionOptionPreflightReason(
  options: TerminalInteractionResponseOptions,
  runtime: TerminalRuntimeIdentity
): string | undefined {
  if (
    typeof options.agentVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(options.agentVersion)
  ) {
    return "an exact semantic agent version is required";
  }
  if (
    options.runtime?.agentVersion !== undefined &&
    options.runtime.agentVersion !== options.agentVersion
  ) {
    return "runtime agent version does not match the requested interaction profile";
  }
  if (!terminalInteractionSubject(runtime)) {
    return "a protocol-safe exact interaction subject is required";
  }
  if (!TERMINAL_INTERACTION_FINGERPRINT_PATTERN.test(options.expectedFingerprint)) {
    return "a valid interaction prompt fingerprint is required";
  }
  if (!Number.isFinite(Date.parse(options.expectedExpiresAt))) {
    return "a valid interaction expiry is required";
  }
  return undefined;
}

function terminalInteractionOfferPreflightReason(
  offer: TerminalInteractionRuntimeOffer | undefined,
  options: Pick<
    TerminalInteractionResponseOptions,
    "expectedFingerprint" | "expectedExpiresAt"
  >,
  now: Date
): string | undefined {
  if (!offer) {
    return "native questionnaire has no identity-fenced interaction offer";
  }
  if (
    offer.projection.state !== "pending" ||
    !offer.projection.capabilities.respond ||
    offer.actionPlan.kind === "manual_only"
  ) {
    return `native questionnaire requires manual response: ${offer.nativeInspection.status === "manual_required"
      ? offer.nativeInspection.reason
      : "unsupported action plan"}`;
  }
  if (offer.promptFingerprint !== options.expectedFingerprint) {
    return "native questionnaire fingerprint changed before execution";
  }
  if (
    offer.projection.expires_at !== options.expectedExpiresAt &&
    Date.parse(options.expectedExpiresAt) > now.getTime()
  ) {
    return "native questionnaire expiry changed before execution";
  }
  return undefined;
}

function terminalInteractionCapabilityReason(
  provider: TerminalControlProvider,
  terminalControl: TerminalControlRef,
  plan: NativeQuestionnaireActionPlan
): string | undefined {
  const requiresText = plan.kind === "free_text";
  const missing = [
    !terminalControl.capabilities.includes("screen_status")
      ? "terminal:screen_status"
      : undefined,
    !terminalControl.capabilities.includes("send_keys")
      ? "terminal:send_keys"
      : undefined,
    !provider.providerCapabilities.includes("stable_resource_resolution")
      ? "provider:stable_resource_resolution"
      : undefined,
    !provider.providerCapabilities.includes("screen_capture")
      ? "provider:screen_capture"
      : undefined,
    !provider.providerCapabilities.includes("key_delivery")
      ? "provider:key_delivery"
      : undefined,
    requiresText && !provider.providerCapabilities.includes("text_delivery")
      ? "provider:text_delivery"
      : undefined
  ].filter((value): value is string => value !== undefined);
  return missing.length > 0
    ? `terminal interaction capability preflight failed: ${missing.join(", ")}`
    : undefined;
}

function terminalInteractionPlanPreflightReason(
  response: TerminalInteractionResponseInput,
  plan: NativeQuestionnaireActionPlan
): string | undefined {
  const answer = response.answers[0];
  if (plan.kind !== "free_text" || answer?.response_kind !== "free_text") {
    return undefined;
  }
  const textStage = plan.stages[0];
  if (
    textStage?.kind !== "answer_text" ||
    !Number.isSafeInteger(textStage.max_characters) ||
    textStage.max_characters < 1
  ) {
    return "native free-text interaction has no verified input limit";
  }
  return answer.text.length <= textStage.max_characters
    ? undefined
    : `free-text answer exceeds the verified native limit of ${textStage.max_characters} characters`;
}

function blockedTerminalInteractionResponse(
  response: TerminalInteractionResponseInput,
  reason: string,
  offer?: TerminalInteractionRuntimeOffer
): TerminalInteractionResponseExecution {
  const answer = Array.isArray(response.answers) ? response.answers[0] : undefined;
  return {
    responded: false,
    blocked: true,
    reason,
    interactionId: response.interaction_id,
    questionId: answer?.question_id ?? offer?.projection.questions[0]?.question_id,
    responseKind: answer?.response_kind
  };
}

function interactionHookContext(
  agent: ExecutorKind,
  terminalControl: TerminalControlRef,
  offer: TerminalInteractionRuntimeOffer,
  response: TerminalInteractionSubjectResponse,
  runtime: TerminalRuntimeIdentity
): TerminalInteractionAuthorizationContext {
  return {
    agent,
    terminalControl,
    fingerprint: offer.promptFingerprint,
    projection: offer.projection,
    response,
    runtime
  };
}

async function authorizeTerminalInteraction(
  authorize: TerminalInteractionResponseOptions["authorize"],
  context: TerminalInteractionAuthorizationContext
): Promise<TerminalInteractionAuthorizationDecision> {
  return authorize ? authorize(context) : { approved: true };
}

async function reserveTerminalInteractionDispatch(
  beforeDispatch: TerminalInteractionResponseOptions["beforeDispatch"],
  context: TerminalInteractionBeforeDispatchContext
): Promise<void> {
  if (!beforeDispatch) {
    return;
  }
  try {
    await beforeDispatch(context);
  } catch (error) {
    if (error instanceof TerminalInteractionInputNotStartedError) {
      throw error;
    }
    throw terminalInteractionReservedError(
      "reservation_uncertain",
      error,
      "terminal interaction dispatch reservation failed"
    );
  }
}

function sameTerminalInteractionOffer(
  left: CapturedTerminalInteractionOffer,
  right: CapturedTerminalInteractionOffer,
  options: { ignoreExpiresAt?: boolean } = {}
): boolean {
  const leftProjection = options.ignoreExpiresAt && left.offer
    ? terminalInteractionProjectionWithoutExpiry(left.offer.projection)
    : left.offer?.projection;
  const rightProjection = options.ignoreExpiresAt && right.offer
    ? terminalInteractionProjectionWithoutExpiry(right.offer.projection)
    : right.offer?.projection;
  return Boolean(
    left.offer &&
    right.offer &&
    sameTerminalControlIncarnation(left.terminalControl, right.terminalControl) &&
    left.offer.promptFingerprint === right.offer.promptFingerprint &&
    JSON.stringify(leftProjection) === JSON.stringify(rightProjection) &&
    JSON.stringify(left.offer.actionPlan) === JSON.stringify(right.offer.actionPlan)
  );
}

function terminalInteractionProjectionWithoutExpiry(
  projection: TerminalInteractionSubjectProjection
): Omit<TerminalInteractionSubjectProjection, "expires_at"> {
  const { expires_at: _expiresAt, ...semanticProjection } = projection;
  return semanticProjection;
}

function terminalInteractionInputNotStartedError(
  error: unknown,
  message: string
): TerminalInteractionInputNotStartedError {
  if (error instanceof TerminalInteractionInputNotStartedError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new TerminalInteractionInputNotStartedError(
    `${message}: ${detail}`,
    { cause: error }
  );
}

function terminalInteractionReservedError(
  stage: TerminalInteractionReservedStage,
  error: unknown,
  message: string
): TerminalInteractionDispatchReservedError {
  if (error instanceof TerminalInteractionDispatchReservedError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new TerminalInteractionDispatchReservedError(
    stage,
    `${message}: ${detail}`,
    { cause: error }
  );
}

function terminalInteractionChoiceAction(
  agent: ExecutorKind,
  plan: Extract<NativeQuestionnaireActionPlan, { kind: "single_select" }>,
  answer: Extract<TerminalInteractionAnswer, { response_kind: "single_select" }>
): {
  keys: readonly string[];
  outcome: TerminalInteractionResponseExecution["outcome"];
} {
  const choice = plan.choices.find(
    (candidate) => candidate.option_id === answer.selected_option_ids[0]
  );
  if (!choice) {
    throw new TerminalInteractionInputNotStartedError(
      "single-select interaction has no closed adapter action"
    );
  }
  const keys = choice.stages.flatMap((stage) =>
    stage.kind === "key" ? [stage.key] : []
  );
  const directChoice = choice.outcome === "submit_or_advance" &&
    choice.stages.length === 1 &&
    keys.length === 1 &&
    /^[1-5]$/u.test(keys[0]!);
  const directCustomTextChoice = agent === "claude" &&
    choice.outcome === "open_custom_text" &&
    choice.stages.length === 1 &&
    keys.length === 1 &&
    /^[1-5]$/u.test(keys[0]!);
  const navigatedCustomTextChoice = agent === "codex" &&
    choice.outcome === "open_custom_text" &&
    choice.stages.length >= 1 &&
    choice.stages.length <= 4 &&
    keys.length === choice.stages.length &&
    keys.at(-1) === "C-m" &&
    keys.slice(0, -1).every((key) => key === "Down");
  if (!directChoice && !directCustomTextChoice && !navigatedCustomTextChoice) {
    throw new TerminalInteractionInputNotStartedError(
      "single-select interaction has no closed adapter action"
    );
  }
  return {
    keys,
    outcome: choice.outcome === "open_custom_text"
      ? "custom_text_opened"
      : "submitted_or_advanced"
  };
}

function terminalInteractionConfirmKey(
  plan: Extract<NativeQuestionnaireActionPlan, { kind: "confirm" }>,
  answer: Extract<TerminalInteractionAnswer, { response_kind: "confirm" }>
): string {
  const stages = answer.confirm ? plan.confirm_stages : plan.cancel_stages;
  const stage = stages[0];
  if (
    stages.length !== 1 ||
    stage?.kind !== "key" ||
    !["C-m", "Escape", "1", "2"].includes(stage.key) ||
    JSON.stringify(plan.confirm_stages) === JSON.stringify(plan.cancel_stages)
  ) {
    throw new TerminalInteractionInputNotStartedError(
      "confirmation interaction has no closed adapter action"
    );
  }
  return stage.key;
}

async function sendTerminalInteractionKeys(
  provider: TerminalControlProvider,
  terminalControl: TerminalControlRef,
  keys: readonly string[]
): Promise<void> {
  try {
    await provider.sendKeys(provider.endpoint(terminalControl), keys);
  } catch (error) {
    throw terminalInteractionReservedError(
      "key_uncertain",
      error,
      "terminal interaction key dispatch is uncertain"
    );
  }
}

async function dispatchTerminalInteractionFreeText(input: {
  agent: ExecutorKind;
  provider: TerminalControlProvider;
  terminalControl: TerminalControlRef;
  plan: Extract<NativeQuestionnaireActionPlan, { kind: "free_text" }>;
  answer: Extract<TerminalInteractionAnswer, { response_kind: "free_text" }>;
  reverifyTerminalIdentity: (
    terminalControl: TerminalControlRef
  ) => Promise<TerminalControlRef>;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<"submitted_or_advanced"> {
  const [textStage, enterStage] = input.plan.stages;
  if (
    input.plan.stages.length !== 2 ||
    textStage?.kind !== "answer_text" ||
    textStage.single_line !== true ||
    textStage.max_characters < input.answer.text.length ||
    enterStage?.kind !== "key" ||
    enterStage.key !== "C-m"
  ) {
    throw new TerminalInteractionInputNotStartedError(
      "free-text interaction has no closed adapter action"
    );
  }
  try {
    await input.provider.sendText(
      input.provider.endpoint(input.terminalControl),
      input.answer.text
    );
  } catch (error) {
    throw terminalInteractionReservedError(
      "text_uncertain",
      error,
      "terminal interaction text dispatch is uncertain"
    );
  }
  if (input.agent === "codex") {
    try {
      await input.sleep(CODEX_PASTE_ENTER_SETTLE_MS);
    } catch (error) {
      throw terminalInteractionReservedError(
        "text_uncertain",
        error,
        "terminal interaction paste-settle outcome is uncertain"
      );
    }
  }
  let enterControl: TerminalControlRef;
  try {
    enterControl = await input.reverifyTerminalIdentity(input.terminalControl);
    if (!sameTerminalControlIncarnation(input.terminalControl, enterControl)) {
      throw new Error(
        "terminal identity changed between interaction text and Enter"
      );
    }
  } catch (error) {
    throw terminalInteractionReservedError(
      "text_uncertain",
      error,
      "terminal identity after interaction text dispatch is uncertain"
    );
  }
  await sendTerminalInteractionKeys(
    input.provider,
    enterControl,
    [enterStage.key]
  );
  return "submitted_or_advanced";
}

async function dispatchTerminalInteractionAnswer(input: {
  agent: ExecutorKind;
  provider: TerminalControlProvider;
  terminalControl: TerminalControlRef;
  actionPlan: NativeQuestionnaireActionPlan;
  answer: TerminalInteractionAnswer;
  reverifyTerminalIdentity: (
    terminalControl: TerminalControlRef
  ) => Promise<TerminalControlRef>;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<NonNullable<TerminalInteractionResponseExecution["outcome"]>> {
  if (
    input.actionPlan.kind === "single_select" &&
    input.answer.response_kind === "single_select"
  ) {
    const action = terminalInteractionChoiceAction(
      input.agent,
      input.actionPlan,
      input.answer
    );
    await sendTerminalInteractionKeys(
      input.provider,
      input.terminalControl,
      action.keys
    );
    return action.outcome!;
  }
  if (
    input.actionPlan.kind === "confirm" &&
    input.answer.response_kind === "confirm"
  ) {
    const key = terminalInteractionConfirmKey(input.actionPlan, input.answer);
    await sendTerminalInteractionKeys(input.provider, input.terminalControl, [key]);
    return input.answer.confirm ? "confirmed" : "cancelled";
  }
  if (
    input.actionPlan.kind === "free_text" &&
    input.answer.response_kind === "free_text"
  ) {
    return dispatchTerminalInteractionFreeText({
      agent: input.agent,
      provider: input.provider,
      terminalControl: input.terminalControl,
      plan: input.actionPlan,
      answer: input.answer,
      reverifyTerminalIdentity: input.reverifyTerminalIdentity,
      sleep: input.sleep
    });
  }
  throw new TerminalInteractionInputNotStartedError(
    "terminal interaction answer does not have a closed adapter action"
  );
}
