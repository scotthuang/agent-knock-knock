/** Native interaction observations and exact live-questionnaire attribution. */
import { terminalWatchCapturedAgentVersion } from "./terminal-watch-presentation.js";
import {
  type CodexAsyncQuestionDurableEvidence,
  codexAsyncQuestionMainComposerVisible
} from "./codex-async-question-adapter.js";
import type { CodexOpenRootRolloutInventory } from "./agent-session-provider.js";
import { captureTerminalInteractionRuntimeOffer } from "./terminal-agent-bridge.js";
import { rolloutFileIdentityMatches } from "./terminal-binding-authority.js";
import { detectCodexBoundQuestionnaireAttribution } from "./terminal-submission-acceptance.js";
import {
  createTerminalInteractionAggregate,
  type NativeTerminalInteractionInspection
} from "./terminal-interaction-core.js";
import { terminalInteractionRuntimeForWatch } from "./terminal-watch-interaction-runtime.js";
import {
  terminalWatchObservationFence,
  type TerminalWatchObservation
} from "./terminal-watch-service.js";
import type {
  TerminalWatch,
  TerminalWatchObservationCheckpoint,
  TerminalWatchManualInteractionSummary,
  TerminalWatchCurrentInteraction
} from "./terminal-watch-store.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import type {
  TerminalWatchCliOptions,
  ExactTerminalWatchObservation,
  TerminalWatchCliDependencies
} from "./terminal-watch-cli-contract.js";
import {
  terminalControlForWatch,
  terminalWatchCandidateMatchesLiveContext,
  sha256
} from "./terminal-watch-terminal-identity.js";
import { terminalWatchResponseDecision } from "./terminal-watch-response-authority.js";
import { approvalFingerprint } from "./terminal-watch-observation-evidence.js";

export function fallbackQuestionnaireObservation(input: {
  watch: TerminalWatch;
  exactTerminal: ExactTerminalWatchObservation;
  rawTerminal?: Record<string, unknown>;
  projectedTerminal?: Record<string, unknown>;
  terminalMatches: boolean;
  observedAt: string;
  observationCheckpoint: TerminalWatchObservationCheckpoint;
  options: TerminalWatchCliOptions;
  dependencies: TerminalWatchCliDependencies;
}): TerminalWatchObservation | undefined {
  if (
    input.exactTerminal.state !== "available" ||
    !input.rawTerminal ||
    !input.projectedTerminal ||
    !input.terminalMatches
  ) {
    return undefined;
  }
  return terminalWatchQuestionnaireObservation({
    ...input,
    rawTerminal: input.rawTerminal,
    projectedTerminal: input.projectedTerminal
  }, true);
}

export function terminalWatchQuestionnaireObservation(input: {
  watch: TerminalWatch;
  rawTerminal?: Record<string, unknown>;
  projectedTerminal: Record<string, unknown>;
  terminalMatches: boolean;
  observedAt: string;
  observationCheckpoint?: TerminalWatchObservationCheckpoint;
  codexAsyncQuestionEvidence?: readonly CodexAsyncQuestionDurableEvidence[];
  options: TerminalWatchCliOptions;
  dependencies: TerminalWatchCliDependencies;
}, requireFallbackAttribution = false): TerminalWatchObservation | undefined {
  if (!input.rawTerminal || !input.terminalMatches) return undefined;
  const rawTerminal = input.rawTerminal;
  const screen = terminalWatchScreenExcerpt(
    rawTerminal,
    input.projectedTerminal
  );
  const version = terminalWatchCapturedAgentVersion(input.watch) ??
    stringValue(rawTerminal.agent_version);
  if (!screen || !version) return undefined;

  const responseWatch = input.observationCheckpoint
    ? {
        ...input.watch,
        observation_checkpoint: input.observationCheckpoint
      }
    : input.watch;
  const captureOffer = (responseAuthority: "executable" | "notify_only") =>
    captureTerminalInteractionRuntimeOffer({
      agent: input.watch.agent,
      terminalControl: terminalControlForWatch(rawTerminal),
      screen,
      runtime: terminalInteractionRuntimeForWatch({
        watch: responseWatch,
        rawTerminal,
        checkpoint: responseWatch.observation_checkpoint,
        version,
        terminalTarget: terminalControlForWatch(rawTerminal).target,
        responseAuthority
      }),
      now: new Date(input.observedAt),
      approvalBlocked: Boolean(approvalFingerprint(input.projectedTerminal)),
      trustedTerminalEvidence: input.watch.terminal.terminal_endpoint,
      codexAsyncQuestionEvidence: input.codexAsyncQuestionEvidence
    });
  let offer = captureOffer("notify_only");
  if (!offer) return absentAsyncQuestionObservation(input, screen, version);
  if (input.watch.current_interaction?.projection.kind === "async_question" &&
      offer.projection.kind === "questionnaire" &&
      offer.nativeInspection.status !== "actionable") {
    return absentAsyncQuestionObservation(input, screen, version);
  }
  if (
    requireFallbackAttribution &&
    !fallbackQuestionnaireContextMatches(
      input.watch,
      rawTerminal,
      input.observationCheckpoint ?? input.watch.observation_checkpoint,
      offer.nativeInspection
    )
  ) {
    return undefined;
  }
  const responseDecision = terminalWatchResponseDecision(
    responseWatch,
    rawTerminal,
    offer.surfaceId,
    offer.promptFingerprint,
    input.options,
    input.dependencies
  );
  if (responseDecision.executable && !(responseWatch.anchor.schema === "agent-knock-knock/codex-paginated-task-anchor" && offer.projection.kind === "questionnaire")) {
    const executableOffer = captureOffer("executable");
    if (
      !executableOffer ||
      executableOffer.surfaceId !== offer.surfaceId ||
      executableOffer.projection.interaction_id !==
        offer.projection.interaction_id
    ) {
      throw new Error(
        "terminal Watch interaction surface changed during responder arbitration"
      );
    }
    offer = executableOffer;
  }
  const currentInteraction: TerminalWatchCurrentInteraction = {
    projection: offer.projection.version === 2 &&
        offer.projection.subject.kind === "terminal_watch"
      ? offer.projection
      : (() => {
          throw new Error("Watch interaction projection lost its Watch subject");
        })(),
    aggregate: createTerminalInteractionAggregate(
      offer.projection,
      input.observedAt
    )
  };
  const manualInteraction = terminalWatchManualInteractionSummary(
    offer.nativeInspection
  );
  const interactionReasonPrefix = offer.projection.kind === "async_question"
    ? "terminal_async_question"
    : "terminal_questionnaire";
  return {
    ...terminalWatchObservationFence(input.watch),
    kind: "interaction",
    observed_at: input.observedAt,
    last_activity_at: input.observedAt,
    ...(input.observationCheckpoint
      ? { observation_checkpoint: input.observationCheckpoint }
      : {}),
    evidence_fingerprint: sha256({
      schema: "agent-knock-knock/terminal-watch-interaction-event",
      version: 1,
      watch_id: input.watch.watch_id,
      interaction_id: offer.projection.interaction_id,
      surface_id: offer.surfaceId
    }),
    reason_code: responseDecision.suppress
      ? `${interactionReasonPrefix}_managed_responder_precedence`
      : currentInteraction.projection.capabilities.respond
        ? `${interactionReasonPrefix}_response_requested`
        : `${interactionReasonPrefix}_requires_manual_response`,
    current_interaction: currentInteraction,
    ...(responseDecision.suppress
      ? { suppress_notification: true }
      : {}),
    ...(!responseDecision.suppress &&
        !currentInteraction.projection.capabilities.respond
      ? { manual_interaction: manualInteraction }
      : {})
  };
}

function absentAsyncQuestionObservation(
  input: {
    watch: TerminalWatch;
    rawTerminal?: Record<string, unknown>;
    observedAt: string;
    observationCheckpoint?: TerminalWatchObservationCheckpoint;
  },
  screen: string,
  version: string
): TerminalWatchObservation | undefined {
  const prior = input.watch.current_interaction;
  if (prior?.projection.kind !== "async_question" ||
      prior.aggregate.state !== "pending" ||
      !input.rawTerminal ||
      !terminalWatchCandidateMatchesLiveContext(input.watch, input.rawTerminal) ||
      !codexAsyncQuestionMainComposerVisible({ version, screen })) {
    return undefined;
  }
  return {
    ...terminalWatchObservationFence(input.watch),
    kind: "pending",
    observed_at: input.observedAt,
    ...(input.observationCheckpoint
      ? { observation_checkpoint: input.observationCheckpoint }
      : {}),
    async_interaction_absent: {
      interaction_id: prior.projection.interaction_id,
      prompt_fingerprint: prior.projection.prompt_fingerprint
    }
  };
}

/**
 * Durable fallback completion remains bound to its accepted provider artifact
 * even after the pane moves elsewhere. A live questionnaire is different: it
 * may be attributed to a Watch only while that exact accepted native context
 * is still the one rendered in the pane.
 */
function fallbackQuestionnaireContextMatches(
  watch: TerminalWatch,
  terminal: Record<string, unknown>,
  checkpoint: TerminalWatchObservationCheckpoint,
  inspection: Exclude<NativeTerminalInteractionInspection, { status: "none" }>
): boolean {
  if (
    watch.anchor.schema !==
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    return true;
  }
  if (
    !("schema" in checkpoint) ||
    checkpoint.schema !==
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint" ||
    !checkpoint.accepted_identity ||
    !checkpoint.acceptance_evidence
  ) {
    return false;
  }
  const accepted = checkpoint.accepted_identity;
  const exactLiveContext =
    stringValue(terminal.native_agent_session_id)?.toLowerCase() ===
      accepted.native_thread_id &&
    stringValue(terminal.native_agent_process_uuid) === accepted.process_uuid &&
    stringValue(terminal.native_agent_process_birth) === accepted.process_birth &&
    rolloutFileIdentityMatches(
      terminal.native_agent_rollout,
      accepted.rollout
    );
  if (exactLiveContext) return true;
  if ("interaction_kind" in inspection) {
    // Async-question rollout evidence is already exact-file bound, but unlike
    // blocking request_user_input it has no cross-rollout attribution format
    // in Codex 0.154/0.155.1. Never follow it to a different live context.
    return false;
  }

  const inventory = terminal._codex_open_root_rollout_inventory;
  if (!isRecord(inventory)) return false;
  const attribution = detectCodexBoundQuestionnaireAttribution({
    currentInventory: inventory as unknown as CodexOpenRootRolloutInventory,
    acceptedIdentity: {
      sessionId: accepted.native_thread_id,
      processUuid: accepted.process_uuid,
      processBirth: accepted.process_birth,
      rollout: accepted.rollout
    },
    acceptanceId: checkpoint.acceptance_evidence.acceptanceId,
    screen: {
      currentStep: inspection.current_step,
      totalSteps: inspection.total_steps,
      prompt: inspection.question.prompt,
      responseKind: inspection.question.response_kind,
      ...(inspection.question.options
        ? {
            options: inspection.question.options.map((option) => ({
              label: option.label,
              ...(option.description
                ? { description: option.description }
                : {})
            }))
          }
        : {}),
      exactShape: inspection.status === "actionable" &&
        inspection.question.response_kind !== "multi_select"
    }
  });
  return attribution.status === "matched";
}

function terminalWatchScreenExcerpt(
  rawTerminal: Record<string, unknown>,
  projectedTerminal: Record<string, unknown>
): string | undefined {
  const direct = stringValue(projectedTerminal.screen_excerpt) ??
    stringValue(rawTerminal.screen_excerpt);
  if (direct) return direct;
  const status = isRecord(rawTerminal._terminal_status_snapshot)
    ? rawTerminal._terminal_status_snapshot
    : undefined;
  const screen = status && isRecord(status.screen) ? status.screen : undefined;
  return stringValue(screen?.excerpt);
}

function terminalWatchManualInteractionSummary(
  inspection: Exclude<NativeTerminalInteractionInspection, { status: "none" }>
): TerminalWatchManualInteractionSummary {
  const exposeQuestion = inspection.status === "actionable";
  return {
    kind: "interaction_kind" in inspection
      ? inspection.interaction_kind
      : "questionnaire",
    response_kind: inspection.question.response_kind,
    required: inspection.question.required,
    current_step: inspection.current_step,
    total_steps: inspection.total_steps,
    parser_status: inspection.status,
    ...(exposeQuestion
      ? {
          prompt: boundedInteractionText(inspection.question.prompt, 1_000),
          ...(inspection.question.options &&
              inspection.question.options.length > 0
            ? {
                options: inspection.question.options.slice(0, 8).map(
                  (option) => ({
                    label: boundedInteractionText(option.label, 300),
                    ...(option.description
                      ? {
                          description: boundedInteractionText(
                            option.description,
                            600
                          )
                        }
                      : {})
                  })
                )
              }
            : {})
        }
      : { manual_reason: inspection.reason })
  };
}

function boundedInteractionText(value: string, maxCharacters: number): string {
  const normalized = value
    .replace(/[\u0000-\u001F\u007F-\u009F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxCharacters);
  return normalized || "Native questionnaire";
}
