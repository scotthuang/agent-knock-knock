/** Observe each Watch according to its captured backend and completion contract. */
import { paginatedWatchProcessMatches, observePaginatedWatch } from "./codex-paginated-watch.js";
import { observeCodexPaginatedBlockingQuestion } from "./codex-paginated-questionnaire-runtime.js";
import { observeClaudeHumanStartedActiveTask } from "./claude-local-transcript-provider.js";
import { observeCodexHumanStartedActiveTask } from "./terminal-submission-acceptance.js";
import {
  terminalWatchObservationFence,
  type TerminalWatchObservation
} from "./terminal-watch-service.js";
import {
  isTerminalActivityWatch,
  isUserExplicitFallbackWatch,
  type TerminalWatch,
  type TerminalWatchObservationCheckpoint,
  type TerminalActivityWatchObservationCheckpoint
} from "./terminal-watch-store.js";
import { nonBlankString as stringValue } from "./value-guards.js";
import type {
  TerminalWatchCliOptions,
  ExactTerminalWatchObservation,
  TerminalWatchCliDependencies
} from "./terminal-watch-cli-contract.js";
import {
  terminalActivityState,
  currentTerminalForWatch,
  terminalMatchesWatch,
  type TerminalActivityWatchIdentityMatch,
  terminalActivityWatchIdentityMatch,
  terminalMatchesUserExplicitFallbackWatch,
  codexIdentity,
  codexIdentityForWatch,
  sha256
} from "./terminal-watch-terminal-identity.js";
import { observeUserExplicitFallbackTerminalWatch } from "./terminal-watch-fallback-observation.js";
import { terminalWatchQuestionnaireObservation } from "./terminal-watch-interaction-observation.js";
import { terminalWatchResponseDecision } from "./terminal-watch-response-authority.js";
import {
  claudeObservationCheckpoint,
  terminalActivityObservationCheckpoint,
  approvalFingerprint,
  invalidatedObservation
} from "./terminal-watch-observation-evidence.js";

interface WatchObservationContext {
  watch: TerminalWatch;
  exactTerminal: ExactTerminalWatchObservation;
  rawTerminal?: Record<string, unknown>;
  projectedTerminal?: Record<string, unknown>;
  terminalMatches: boolean;
  observedAt: string;
  options: TerminalWatchCliOptions;
  dependencies: TerminalWatchCliDependencies;
}

export async function observeTerminalWatch(
  watch: TerminalWatch,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<TerminalWatchObservation> {
  const observedAt = dependencies.now().toISOString();
  const exactTerminal = await currentTerminalForWatch(
    watch,
    options,
    dependencies
  );
  const rawTerminal = exactTerminal.state === "available"
    ? exactTerminal.rawTerminal
    : undefined;
  if (watch.anchor.schema === "agent-knock-knock/codex-paginated-task-anchor") {
    return observePaginatedWatchAtTerminal({ watch, observedAt, exactTerminal,
      rawTerminal, options, dependencies }, watch.anchor);
  }
  const projectedTerminal = exactTerminal.state === "available"
    ? exactTerminal.terminal
    : undefined;
  const activityTerminalIdentity = rawTerminal && isTerminalActivityWatch(watch)
    ? terminalActivityWatchIdentityMatch(rawTerminal, watch)
    : undefined;
  const terminalMatches = rawTerminal
    ? isUserExplicitFallbackWatch(watch)
      ? terminalMatchesUserExplicitFallbackWatch(rawTerminal, watch)
      : isTerminalActivityWatch(watch)
        ? activityTerminalIdentity === "match"
        : terminalMatchesWatch(rawTerminal, watch)
    : false;
  if (isUserExplicitFallbackWatch(watch)) {
    return observeUserExplicitFallbackTerminalWatch({
      watch,
      exactTerminal,
      rawTerminal,
      projectedTerminal,
      terminalMatches,
      observedAt,
      options,
      dependencies
    });
  }
  if (isTerminalActivityWatch(watch)) {
    return observeTerminalActivityWatch({
      watch,
      exactTerminal,
      rawTerminal,
      projectedTerminal,
      terminalIdentityMatch: activityTerminalIdentity ?? "mismatch",
      observedAt,
      options,
      dependencies
    });
  }
  return observeHumanStartedWatch({ watch, exactTerminal, rawTerminal,
    projectedTerminal, terminalMatches, observedAt, options, dependencies });
}

function observePaginatedWatchAtTerminal(
  input: Omit<WatchObservationContext, "terminalMatches">,
  anchor: Extract<TerminalWatch["anchor"], {
    schema: "agent-knock-knock/codex-paginated-task-anchor";
  }>
): Promise<TerminalWatchObservation> {
  const { watch, rawTerminal, observedAt, exactTerminal, options, dependencies } = input;
  const terminalMatches = Boolean(rawTerminal && terminalMatchesWatch(rawTerminal, watch) && paginatedWatchProcessMatches(rawTerminal, anchor));
  return observePaginatedWatch({ watch, observedAt, terminalMatches,
    terminalAvailable: exactTerminal.state === "available",
    readSnapshot: dependencies.readPaginatedSnapshot,
    blockingQuestionnaire: (checkpoint) => observeCodexPaginatedBlockingQuestion({
      watch, checkpoint, now: new Date(observedAt),
      responseDecision: (surfaceId, fingerprint) => rawTerminal
        ? terminalWatchResponseDecision({ ...watch, observation_checkpoint: checkpoint }, rawTerminal,
            surfaceId, fingerprint, options, dependencies)
        : { executable: false, suppress: false }
    }),
    questionnaire: (checkpoint, questions, allowResponses) => exactTerminal.state === "available"
      ? terminalWatchQuestionnaireObservation({ watch: allowResponses ? watch : { ...watch, interaction_policy: "notify_only" }, observedAt, options, dependencies,
          rawTerminal, projectedTerminal: exactTerminal.terminal, terminalMatches,
          observationCheckpoint: checkpoint, codexAsyncQuestionEvidence: questions })
      : undefined });
}

function observeHumanStartedWatch(input: WatchObservationContext): TerminalWatchObservation {
  const { watch, exactTerminal, rawTerminal, projectedTerminal,
    terminalMatches, observedAt, options, dependencies } = input;
  const fence = terminalWatchObservationFence(watch);
  const observation =
    watch.anchor.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
    ? observeCodexHumanStartedActiveTask({
        anchor: watch.anchor,
        currentIdentity: rawTerminal
          ? codexIdentity(rawTerminal)
          : codexIdentityForWatch(watch),
        resumeOffsetBytes:
          watch.observation_checkpoint.safe_resume_offset_bytes
      })
    : watch.anchor.schema ===
        "agent-knock-knock/claude-human-started-active-task-anchor"
      ? observeClaudeHumanStartedActiveTask({
        anchor: watch.anchor,
        claudeHome: stringValue(options.claudeHome),
        agentRows: dependencies.loadClaudeAgentRows(options, { required: true }),
        resumeOffsetBytes:
          watch.observation_checkpoint.safe_resume_offset_bytes,
        checkpoint: claudeObservationCheckpoint(watch)
      })
      : (() => {
          throw new Error("terminal Watch anchor is unsupported");
        })();
  if (observation.status === "invalidated") {
    return invalidatedObservation(watch, observedAt, "task_anchor_invalidated");
  }
  if (observation.status === "completed") {
    const completion = observation.completion;
    const kind = completion.outcome === "failure" ? "failed" : "completed";
    return {
      ...fence,
      kind,
      observed_at: observedAt,
      evidence_fingerprint: sha256({
        kind,
        watch_id: watch.watch_id,
        completion_id: completion.id ?? null,
        completion_timestamp: completion.timestamp ?? null,
        anchor_fingerprint: watch.anchor.anchor_fingerprint
      }),
      reason_code: completion.outcome === "failure"
        ? "anchored_task_failed"
        : "anchored_task_completed",
      completion_text: completion.text.slice(0, 4000),
      completion_id: completion.id,
      completion_timestamp: completion.timestamp
    };
  }
  if (observation.status === "unavailable") {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      reason_code: "provider_observation_unavailable"
    };
  }
  return observePendingHumanStartedWatch(input, observation);
}

function observePendingHumanStartedWatch(
  input: WatchObservationContext,
  observation: Extract<ReturnType<typeof observeCodexHumanStartedActiveTask> |
    ReturnType<typeof observeClaudeHumanStartedActiveTask>, { status: "pending" }>
): TerminalWatchObservation {
  const { watch, exactTerminal, rawTerminal, projectedTerminal,
    terminalMatches, observedAt, options, dependencies } = input;
  const fence = terminalWatchObservationFence(watch);
  const safeResumeOffsetBytes = observation.safeResumeOffsetBytes;
  const observationCheckpoint = "checkpoint" in observation
    ? observation.checkpoint as TerminalWatchObservationCheckpoint
    : undefined;
  if (exactTerminal.state === "unavailable") {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      safe_resume_offset_bytes: safeResumeOffsetBytes,
      observation_checkpoint: observationCheckpoint,
      reason_code: "terminal_observation_unavailable"
    };
  }
  if (rawTerminal && !terminalMatches) {
    return invalidatedObservation(
      watch,
      observedAt,
      "terminal_identity_changed"
    );
  }
  if (exactTerminal.state === "absent") {
    return invalidatedObservation(
      watch,
      observedAt,
      "terminal_process_unavailable"
    );
  }
  if (!projectedTerminal) {
    throw new Error("exact terminal observation is inconsistent");
  }
  const approval = approvalFingerprint(projectedTerminal);
  if (approval) {
    return {
      ...fence,
      kind: "approval",
      observed_at: observedAt,
      last_activity_at: observedAt,
      safe_resume_offset_bytes: safeResumeOffsetBytes,
      observation_checkpoint: observationCheckpoint,
      evidence_fingerprint: approval,
      reason_code: "terminal_waiting_for_approval"
    };
  }
  const interaction = terminalWatchQuestionnaireObservation({
    watch,
    rawTerminal,
    projectedTerminal,
    terminalMatches: true,
    observedAt,
    observationCheckpoint,
    options,
    dependencies
  });
  if (interaction) return interaction;
  return {
    ...fence,
    kind: "pending",
    observed_at: observedAt,
    safe_resume_offset_bytes: safeResumeOffsetBytes,
    observation_checkpoint: observationCheckpoint
  };
}

function observeTerminalActivityWatch(input: {
  watch: TerminalWatch;
  exactTerminal: ExactTerminalWatchObservation;
  rawTerminal?: Record<string, unknown>;
  projectedTerminal?: Record<string, unknown>;
  terminalIdentityMatch: TerminalActivityWatchIdentityMatch;
  observedAt: string;
  options: TerminalWatchCliOptions;
  dependencies: TerminalWatchCliDependencies;
}): TerminalWatchObservation {
  const {
    watch,
    exactTerminal,
    projectedTerminal,
    rawTerminal,
    terminalIdentityMatch,
    observedAt
  } = input;
  const fence = terminalWatchObservationFence(watch);
  if (exactTerminal.state === "unavailable") {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      reason_code: "terminal_observation_unavailable"
    };
  }
  if (exactTerminal.state === "absent") {
    return invalidatedObservation(
      watch,
      observedAt,
      "terminal_process_unavailable"
    );
  }
  if (terminalIdentityMatch === "unavailable") {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      reason_code: "terminal_identity_observation_incomplete"
    };
  }
  if (terminalIdentityMatch === "mismatch") {
    return invalidatedObservation(
      watch,
      observedAt,
      "terminal_identity_changed"
    );
  }
  if (!projectedTerminal) {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      reason_code: "terminal_activity_unavailable"
    };
  }
  if (rawTerminal) {
    const interaction = terminalWatchQuestionnaireObservation({
      watch,
      rawTerminal,
      projectedTerminal,
      terminalMatches: true,
      observedAt,
      observationCheckpoint: terminalActivityObservationCheckpoint(watch),
      options: input.options,
      dependencies: input.dependencies
    });
    if (interaction) return interaction;
  }
  const state = terminalActivityState(projectedTerminal);
  const current = terminalActivityObservationCheckpoint(watch);
  const active = state === "working" || state === "awaiting_approval";
  const hasSeenActivity = current.has_seen_activity || active;
  const consecutiveIdle = state === "idle" && hasSeenActivity
    ? current.last_activity_state === "idle"
      ? current.consecutive_idle_observations + 1
      : 1
    : 0;
  const checkpoint: TerminalActivityWatchObservationCheckpoint = {
    ...current,
    has_seen_activity: hasSeenActivity,
    consecutive_idle_observations: consecutiveIdle,
    last_activity_state: state
  };
  if (state === "unknown") {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      observation_checkpoint: checkpoint,
      reason_code: "terminal_activity_unknown"
    };
  }
  if (state === "awaiting_approval") {
    const approval = approvalFingerprint(projectedTerminal);
    if (approval) {
      return {
        ...fence,
        kind: "approval",
        observed_at: observedAt,
        last_activity_at: observedAt,
        observation_checkpoint: checkpoint,
        evidence_fingerprint: approval,
        reason_code: "terminal_waiting_for_approval"
      };
    }
  }
  if (state === "idle" && hasSeenActivity && consecutiveIdle >= 2) {
    return {
      ...fence,
      kind: "completed",
      observed_at: observedAt,
      observation_checkpoint: checkpoint,
      evidence_fingerprint: sha256({
        watch_id: watch.watch_id,
        reason_code: "terminal_activity_became_stably_idle",
        anchor_fingerprint: watch.anchor.anchor_fingerprint
      }),
      reason_code: "terminal_activity_became_stably_idle"
    };
  }
  return {
    ...fence,
    kind: "pending",
    observed_at: observedAt,
    ...(active ? { last_activity_at: observedAt } : {}),
    observation_checkpoint: checkpoint
  };
}
