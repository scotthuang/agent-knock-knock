/** Watch observation/checkpoint projections shared by provider adapters. */
import type { TerminalCompletionEvidence } from "./terminal-agent-adapter.js";
import type {
  CodexRolloutAcceptanceIdentity,
  TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-acceptance.js";
import {
  terminalWatchObservationFence,
  type TerminalWatchObservation
} from "./terminal-watch-service.js";
import type {
  TerminalWatch,
  ClaudeUserExplicitFallbackWatchObservationCheckpoint,
  CodexUserExplicitFallbackWatchObservationCheckpoint,
  TerminalWatchObservationCheckpoint,
  TerminalActivityWatchObservationCheckpoint
} from "./terminal-watch-store.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import type { ExactTerminalWatchObservation } from "./terminal-watch-cli-contract.js";
import { requiredString, sha256 } from "./terminal-watch-terminal-identity.js";

export function fallbackPendingOrTerminalObservation(input: {
  watch: TerminalWatch;
  exactTerminal: ExactTerminalWatchObservation;
  rawTerminal?: Record<string, unknown>;
  terminalMatches: boolean;
  observedAt: string;
  observedEndOffsetBytes?: number;
  observationCheckpoint?: TerminalWatchObservationCheckpoint;
  reasonCode?: string;
}): TerminalWatchObservation {
  if (input.exactTerminal.state === "unavailable") {
    return {
      ...terminalWatchObservationFence(input.watch),
      kind: "unavailable",
      observed_at: input.observedAt,
      reason_code: input.reasonCode ?? "terminal_observation_unavailable"
    };
  }
  if (input.exactTerminal.state === "absent" || !input.rawTerminal) {
    return invalidatedObservation(
      input.watch,
      input.observedAt,
      "terminal_process_unavailable"
    );
  }
  if (!input.terminalMatches) {
    return invalidatedObservation(
      input.watch,
      input.observedAt,
      "terminal_identity_changed"
    );
  }
  if (input.reasonCode) {
    return {
      ...terminalWatchObservationFence(input.watch),
      kind: "unavailable",
      observed_at: input.observedAt,
      reason_code: input.reasonCode
    };
  }
  return fallbackPendingObservation(
    input.watch,
    input.observedAt,
    input.observedEndOffsetBytes,
    input.observationCheckpoint
  );
}

function fallbackPendingObservation(
  watch: TerminalWatch,
  observedAt: string,
  observedEndOffsetBytes?: number,
  observationCheckpoint?: TerminalWatchObservationCheckpoint
): TerminalWatchObservation {
  const effectiveCheckpoint = observationCheckpoint ?? (
    watch.anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
      ? watch.observation_checkpoint
      : undefined
  );
  const safeResumeOffsetBytes = effectiveCheckpoint
    ?.safe_resume_offset_bytes ?? fallbackResumeOffset(
      watch,
      observedEndOffsetBytes
    );
  return {
    ...terminalWatchObservationFence(watch),
    kind: "pending",
    observed_at: observedAt,
    safe_resume_offset_bytes: safeResumeOffsetBytes,
    ...(effectiveCheckpoint
      ? { observation_checkpoint: effectiveCheckpoint }
      : {})
  };
}

export function codexFallbackObservationCheckpoint(
  watch: TerminalWatch
): CodexUserExplicitFallbackWatchObservationCheckpoint {
  const checkpoint = watch.observation_checkpoint;
  if (
    !("schema" in checkpoint) ||
    checkpoint.schema !==
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint"
  ) {
    throw new Error("Codex fallback Watch has no exact acceptance checkpoint");
  }
  return checkpoint;
}

export function claudeFallbackObservationCheckpoint(
  watch: TerminalWatch
): ClaudeUserExplicitFallbackWatchObservationCheckpoint {
  const checkpoint = watch.observation_checkpoint;
  if (
    !("schema" in checkpoint) ||
    checkpoint.schema !==
      "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint"
  ) {
    throw new Error("Claude fallback Watch has no exact acceptance checkpoint");
  }
  return checkpoint;
}

export function codexFallbackAcceptedCheckpoint(
  watch: TerminalWatch,
  acceptanceEvidence: TerminalSubmissionAcceptanceEvidence,
  currentIdentity: CodexRolloutAcceptanceIdentity
): CodexUserExplicitFallbackWatchObservationCheckpoint {
  const nativeThreadId = requiredString(
    currentIdentity.sessionId,
    "accepted Codex native thread id"
  );
  const processUuid = requiredString(
    currentIdentity.processUuid,
    "accepted Codex process UUID"
  );
  const processBirth = requiredString(
    currentIdentity.processBirth,
    "accepted Codex process birth"
  );
  const rollout = currentIdentity.rollout;
  if (!rollout) {
    throw new Error("accepted Codex rollout identity is unavailable");
  }
  const acceptanceOffset = numericMetadata(
    acceptanceEvidence.metadata,
    "observed_end_offset_bytes"
  );
  if (acceptanceOffset === undefined) {
    throw new Error("accepted Codex rollout boundary is unavailable");
  }
  return {
    schema:
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint",
    version: 1,
    safe_resume_offset_bytes: fallbackResumeOffset(
      watch,
      acceptanceOffset
    ),
    acceptance_evidence: acceptanceEvidence,
    accepted_identity: {
      native_thread_id: nativeThreadId,
      process_uuid: processUuid,
      process_birth: processBirth,
      rollout
    }
  };
}

export function claudeFallbackAcceptedCheckpoint(
  watch: TerminalWatch,
  acceptanceEvidence: TerminalSubmissionAcceptanceEvidence
): ClaudeUserExplicitFallbackWatchObservationCheckpoint {
  const acceptanceOffset = numericMetadata(
    acceptanceEvidence.metadata,
    "observed_end_offset_bytes"
  );
  if (acceptanceOffset === undefined) {
    throw new Error("accepted Claude transcript boundary is unavailable");
  }
  const promptUuid = requiredString(
    acceptanceEvidence.acceptanceId,
    "accepted Claude prompt UUID"
  );
  return {
    schema:
      "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint",
    version: 1,
    safe_resume_offset_bytes: fallbackResumeOffset(
      watch,
      acceptanceOffset
    ),
    acceptance_evidence: acceptanceEvidence,
    accepted_prompt_uuid: promptUuid
  };
}

export function fallbackCompletionObservation(
  watch: TerminalWatch,
  observedAt: string,
  completion: TerminalCompletionEvidence,
  observedEndOffsetBytes?: number,
  observationCheckpoint?: TerminalWatchObservationCheckpoint
): TerminalWatchObservation {
  const safeResumeOffsetBytes = observationCheckpoint
    ?.safe_resume_offset_bytes ?? fallbackResumeOffset(
      watch,
      observedEndOffsetBytes
    );
  const kind = completion.outcome === "failure" ? "failed" : "completed";
  return {
    ...terminalWatchObservationFence(watch),
    kind,
    observed_at: observedAt,
    safe_resume_offset_bytes: safeResumeOffsetBytes,
    ...(observationCheckpoint
      ? { observation_checkpoint: observationCheckpoint }
      : {}),
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

function fallbackResumeOffset(
  watch: TerminalWatch,
  observedEndOffsetBytes?: number
): number {
  return Math.max(
    watch.observation_checkpoint.safe_resume_offset_bytes,
    Number.isSafeInteger(observedEndOffsetBytes) &&
        Number(observedEndOffsetBytes) >= 0
      ? Number(observedEndOffsetBytes)
      : 0
  );
}

function numericMetadata(
  metadata: Record<string, unknown> | undefined,
  field: string
): number | undefined {
  const value = metadata?.[field];
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

export function claudeObservationCheckpoint(
  watch: TerminalWatch
) {
  const checkpoint = watch.observation_checkpoint;
  if (
    !("schema" in checkpoint) ||
    checkpoint.schema !==
      "agent-knock-knock/claude-human-started-active-task-checkpoint"
  ) {
    throw new Error("Claude terminal Watch has no continuation checkpoint");
  }
  return checkpoint;
}

export function terminalActivityObservationCheckpoint(
  watch: TerminalWatch
): TerminalActivityWatchObservationCheckpoint {
  const checkpoint = watch.observation_checkpoint;
  if (
    !("schema" in checkpoint) ||
    checkpoint.schema !==
      "agent-knock-knock/terminal-activity-watch-checkpoint"
  ) {
    throw new Error("terminal activity Watch has no activity checkpoint");
  }
  return checkpoint;
}

export function approvalFingerprint(
  terminal: Record<string, unknown>
): string | undefined {
  if (terminal.activity_state !== "awaiting_approval") return undefined;
  const approval = isRecord(terminal.approval_state)
    ? terminal.approval_state
    : undefined;
  const fingerprint = stringValue(approval?.fingerprint);
  return fingerprint && /^[a-f0-9]{64}$/u.test(fingerprint)
    ? fingerprint
    : undefined;
}

export function invalidatedObservation(
  watch: TerminalWatch,
  observedAt: string,
  reasonCode: string
): TerminalWatchObservation {
  return {
    ...terminalWatchObservationFence(watch),
    kind: "invalidated",
    observed_at: observedAt,
    evidence_fingerprint: sha256({
      watch_id: watch.watch_id,
      reason_code: reasonCode,
      anchor_fingerprint: watch.anchor.anchor_fingerprint
    }),
    reason_code: reasonCode
  };
}
