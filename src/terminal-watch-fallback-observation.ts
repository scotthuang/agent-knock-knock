/** Request-bound legacy provider observations; live terminal activity is not completion proof. */
import type { CodexOpenRootRolloutInventory } from "./agent-session-provider.js";
import { observeClaudeUserExplicitFallbackTranscript } from "./claude-local-transcript-provider.js";
import type { TerminalDurableCompletionRequest } from "./terminal-agent-adapter.js";
import {
  detectCodexBoundRolloutCompletion,
  detectCodexCandidateSetRolloutAcceptance,
  detectCodexRolloutAcceptance,
  type CodexRolloutAcceptanceIdentity,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-acceptance.js";
import {
  terminalWatchObservationFence,
  type TerminalWatchObservation
} from "./terminal-watch-service.js";
import type {
  TerminalWatch,
  CodexUserExplicitFallbackWatchObservationCheckpoint
} from "./terminal-watch-store.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import type {
  TerminalWatchCliOptions,
  ExactTerminalWatchObservation,
  TerminalWatchCliDependencies
} from "./terminal-watch-cli-contract.js";
import { fallbackQuestionnaireObservation } from "./terminal-watch-interaction-observation.js";
import {
  fallbackPendingOrTerminalObservation,
  codexFallbackObservationCheckpoint,
  claudeFallbackObservationCheckpoint,
  codexFallbackAcceptedCheckpoint,
  claudeFallbackAcceptedCheckpoint,
  fallbackCompletionObservation,
  invalidatedObservation
} from "./terminal-watch-observation-evidence.js";
import { codexIdentity } from "./terminal-watch-terminal-identity.js";

interface FallbackObservationInput {
  watch: TerminalWatch;
  exactTerminal: ExactTerminalWatchObservation;
  rawTerminal?: Record<string, unknown>;
  projectedTerminal?: Record<string, unknown>;
  terminalMatches: boolean;
  observedAt: string;
  options: TerminalWatchCliOptions;
  dependencies: TerminalWatchCliDependencies;
}

type CodexFallbackAnchor = Extract<TerminalWatch["anchor"], {
  schema: "agent-knock-knock/codex-user-explicit-fallback-watch-anchor";
}>;
type ClaudeFallbackAnchor = Extract<TerminalWatch["anchor"], {
  schema: "agent-knock-knock/claude-user-explicit-fallback-watch-anchor";
}>;

export async function observeUserExplicitFallbackTerminalWatch(
  input: FallbackObservationInput
): Promise<TerminalWatchObservation> {
  const anchor = input.watch.anchor;
  if (anchor.schema === "agent-knock-knock/codex-user-explicit-fallback-watch-anchor") {
    return observeCodexFallback(input, anchor);
  }
  if (anchor.schema === "agent-knock-knock/claude-user-explicit-fallback-watch-anchor") {
    return observeClaudeFallback(input, anchor);
  }
  throw new Error("user-explicit fallback Watch anchor is unsupported");
}

function resolveCodexFallbackAcceptance(
  input: FallbackObservationInput,
  savedAnchor: CodexFallbackAnchor
): TerminalWatchObservation | {
  acceptance: TerminalSubmissionAcceptanceEvidence;
  currentIdentity: CodexRolloutAcceptanceIdentity;
  acceptedCheckpoint: CodexUserExplicitFallbackWatchObservationCheckpoint;
} {
  const {
    watch,
    exactTerminal,
    rawTerminal,
    projectedTerminal,
    terminalMatches,
    observedAt,
    options,
    dependencies
  } = input;
  const fence = terminalWatchObservationFence(watch);
  const anchor = savedAnchor.acceptance_anchor;
  const persistedCheckpoint = codexFallbackObservationCheckpoint(watch);
  let acceptance: TerminalSubmissionAcceptanceEvidence | undefined;
  let currentIdentity: CodexRolloutAcceptanceIdentity;
  let acceptedCheckpoint:
    CodexUserExplicitFallbackWatchObservationCheckpoint | undefined;
  if (
    persistedCheckpoint.acceptance_evidence &&
    persistedCheckpoint.accepted_identity
  ) {
    acceptance = persistedCheckpoint.acceptance_evidence;
    currentIdentity = {
      sessionId: persistedCheckpoint.accepted_identity.native_thread_id,
      processUuid: persistedCheckpoint.accepted_identity.process_uuid,
      processBirth: persistedCheckpoint.accepted_identity.process_birth,
      rollout: persistedCheckpoint.accepted_identity.rollout
    };
    acceptedCheckpoint = persistedCheckpoint;
  } else if (anchor.version === 3) {
    const inventory = rawTerminal?._codex_open_root_rollout_inventory;
    if (!isRecord(inventory)) {
      return fallbackPendingOrTerminalObservation({
        watch,
        exactTerminal,
        rawTerminal,
        terminalMatches,
        observedAt,
        reasonCode: "codex_rollout_inventory_unavailable"
      });
    }
    const result = detectCodexCandidateSetRolloutAcceptance({
      anchor,
      currentInventory:
        inventory as unknown as CodexOpenRootRolloutInventory,
      requestHash: savedAnchor.request_hash
    });
    if (result.status === "uncertain") {
      if (result.code === "candidate_scan_invalid") {
        return {
          ...fence,
          kind: "unavailable",
          observed_at: observedAt,
          reason_code: "native_acceptance_scan_unavailable"
        };
      }
      return invalidatedObservation(
        watch,
        observedAt,
        `native_acceptance_${result.code}`
      );
    }
    if (result.status === "pending") {
      return fallbackPendingOrTerminalObservation({
        watch,
        exactTerminal,
        rawTerminal,
        terminalMatches,
        observedAt
      });
    }
    acceptance = result.evidence;
    currentIdentity = result.identity;
    acceptedCheckpoint = codexFallbackAcceptedCheckpoint(
      watch,
      acceptance,
      currentIdentity
    );
  } else {
    try {
      currentIdentity = anchor.version === 1
        ? {
            sessionId: anchor.native_thread_id,
            processUuid: anchor.process_uuid,
            processBirth: anchor.process_birth,
            rollout: anchor.rollout
          }
        : rawTerminal
          ? codexIdentity(rawTerminal)
          : (() => {
              throw new Error(
                "Codex pre-materialization identity is unavailable"
              );
            })();
      acceptance = detectCodexRolloutAcceptance({
        anchor,
        currentIdentity,
        requestHash: savedAnchor.request_hash
      });
    } catch (error) {
      if (retryableProviderError(error)) {
        return {
          ...fence,
          kind: "unavailable",
          observed_at: observedAt,
          reason_code: "native_acceptance_scan_unavailable"
        };
      }
      return invalidatedObservation(
        watch,
        observedAt,
        "native_acceptance_identity_changed"
      );
    }
    if (!acceptance) {
      return fallbackPendingOrTerminalObservation({
        watch,
        exactTerminal,
        rawTerminal,
        terminalMatches,
        observedAt
      });
    }
    acceptedCheckpoint = codexFallbackAcceptedCheckpoint(
      watch,
      acceptance,
      currentIdentity
    );
  }
  if (!acceptance || !acceptedCheckpoint) {
    throw new Error("Codex fallback Watch acceptance checkpoint is incomplete");
  }
  return { acceptance, currentIdentity, acceptedCheckpoint };
}

function observeCodexFallback(
  input: FallbackObservationInput,
  savedAnchor: CodexFallbackAnchor
): TerminalWatchObservation {
  const {
    watch,
    exactTerminal,
    rawTerminal,
    projectedTerminal,
    terminalMatches,
    observedAt,
    options,
    dependencies
  } = input;
  const fence = terminalWatchObservationFence(watch);
  const accepted = resolveCodexFallbackAcceptance(input, savedAnchor);
  if ("kind" in accepted) return accepted;
  const { acceptance, currentIdentity, acceptedCheckpoint } = accepted;
  const anchor = savedAnchor.acceptance_anchor;
  const completion = detectCodexBoundRolloutCompletion({
    anchor,
    acceptanceEvidence: acceptance,
    currentIdentity,
    requestHash: savedAnchor.request_hash
  });
  if (completion.status === "completed") {
    return fallbackCompletionObservation(
      watch,
      observedAt,
      completion.completion,
      completion.diagnostics.observed_end_offset_bytes,
      codexFallbackAcceptedCheckpoint(
        watch,
        acceptance,
        currentIdentity
      )
    );
  }
  if (completion.status === "failure") {
    if (completion.diagnostics.code === "rollout_unreadable") {
      return {
        ...fence,
        kind: "unavailable",
        observed_at: observedAt,
        safe_resume_offset_bytes:
          acceptedCheckpoint.safe_resume_offset_bytes,
        observation_checkpoint: acceptedCheckpoint,
        reason_code: "accepted_rollout_unavailable"
      };
    }
    return invalidatedObservation(
      watch,
      observedAt,
      `native_completion_${completion.diagnostics.code}`
    );
  }
  const interaction = fallbackQuestionnaireObservation({
    watch,
    exactTerminal,
    rawTerminal,
    projectedTerminal,
    terminalMatches,
    observedAt,
    observationCheckpoint: codexFallbackAcceptedCheckpoint(
      watch,
      acceptance,
      currentIdentity
    ),
    options,
    dependencies
  });
  if (interaction) return interaction;
  return fallbackPendingOrTerminalObservation({
    watch,
    exactTerminal,
    rawTerminal,
    terminalMatches,
    observedAt,
    observedEndOffsetBytes:
      completion.diagnostics.observed_end_offset_bytes,
    observationCheckpoint: codexFallbackAcceptedCheckpoint(
      watch,
      acceptance,
      currentIdentity
    )
  });
}

function observeClaudeFallback(
  input: FallbackObservationInput,
  anchor: ClaudeFallbackAnchor
): TerminalWatchObservation {
  const {
    watch,
    exactTerminal,
    rawTerminal,
    projectedTerminal,
    terminalMatches,
    observedAt,
    options,
    dependencies
  } = input;
  const fence = terminalWatchObservationFence(watch);
  const request: TerminalDurableCompletionRequest = {
    sessionId: anchor.transcript_anchor.session_id,
    cwd: anchor.transcript_anchor.cwd,
    requestHash: anchor.request_hash,
    startedAt: anchor.captured_at,
    context: {
      claudeTranscriptAnchor: anchor.transcript_anchor,
      pid: anchor.transcript_anchor.pid
    }
  };
  const persistedCheckpoint = claudeFallbackObservationCheckpoint(watch);
  const observation = observeClaudeUserExplicitFallbackTranscript(
    request,
    {
      claudeHome: stringValue(options.claudeHome),
      // This observer is transcript-authoritative by design. Completion must
      // remain recoverable after the exact pane/process leaves discovery.
      acceptanceEvidence: persistedCheckpoint.acceptance_evidence
    }
  );
  if (observation.status === "unavailable") {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      reason_code: "native_acceptance_scan_unavailable"
    };
  }
  const acceptance = observation.acceptance;
  if (!acceptance) {
    return fallbackPendingOrTerminalObservation({
      watch,
      exactTerminal,
      rawTerminal,
      terminalMatches,
      observedAt
    });
  }
  const acceptedCheckpoint = claudeFallbackAcceptedCheckpoint(
    watch,
    acceptance
  );
  if (observation.status === "completed") {
    return fallbackCompletionObservation(
      watch,
      observedAt,
      observation.completion,
      observation.observedEndOffsetBytes,
      acceptedCheckpoint
    );
  }
  const interaction = fallbackQuestionnaireObservation({
    watch,
    exactTerminal,
    rawTerminal,
    projectedTerminal,
    terminalMatches,
    observedAt,
    observationCheckpoint: acceptedCheckpoint,
    options,
    dependencies
  });
  if (interaction) return interaction;
  return fallbackPendingOrTerminalObservation({
    watch,
    exactTerminal,
    rawTerminal,
    terminalMatches,
    observedAt,
    observedEndOffsetBytes: observation.observedEndOffsetBytes,
    observationCheckpoint: acceptedCheckpoint
  });
}

function retryableProviderError(error: unknown): boolean {
  return isRecord(error) && typeof error.code === "string" && new Set([
    "EACCES", "EAGAIN", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOENT",
    "EPERM", "ESTALE", "ETIMEDOUT"
  ]).has(error.code);
}
