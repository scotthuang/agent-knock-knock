import path from "node:path";
import { captureClaudeTranscriptAnchor, type CaptureClaudeTranscriptAnchorOptions,
  type ClaudeTranscriptAnchor } from "./claude-local-transcript-provider.js";
import { observeClaudeThreadLifecycle } from "./claude-terminal-agent-adapter.js";
import { isExactNativeThreadId } from "./managed-session.js";
import type { TerminalThreadLifecycleObservation } from "./terminal-agent-adapter.js";

export type ClaudeControlReadiness = Readonly<
  { ready: true } | { ready: false; reason: string; message: string }
>;

export interface ClaudeTerminalAdmission {
  readonly managedSend: ClaudeControlReadiness;
  readonly lifecycle: ClaudeControlReadiness;
}

/** Shared before-transition policy; the native observer owns exact process evidence. */
export function claudeLifecycleReadiness(input: {
  cwd?: string;
  expectedNativeThreadId?: string;
  observation?: TerminalThreadLifecycleObservation;
}): ClaudeControlReadiness {
  const observed = input.observation;
  const identityKnown = input.cwd && path.isAbsolute(input.cwd) && observed?.status === "observed" &&
    isExactNativeThreadId(input.expectedNativeThreadId) &&
    observed.nativeThreadId === input.expectedNativeThreadId.toLowerCase();
  if (identityKnown && (observed.idle === true || observed.foregroundComplete === true)) return { ready: true };
  return {
    ready: false,
    reason: identityKnown ? "claude_lifecycle_foreground_unproven" : "claude_lifecycle_identity_unavailable",
    message: (identityKnown
      ? "AKK verified the Claude session identity, but cannot prove its foreground task has finished for a thread change. " +
        "A background shell alone is not proof; wait for foreground completion or restore transcript observation. "
      : "AKK cannot verify one current Claude session identity in this window for a thread change. " +
        "Check Status, the exact process identity and the Claude reader. ") +
      "Refresh List and retry. " +
      (observed?.reason ? `Reader detail: ${observed.reason}. ` : "") + "No terminal input was sent."
  };
}

/** Capture exactly the original managed-send proof, without importing lifecycle-only gates. */
export function captureClaudeManagedSendAdmission(
  input: CaptureClaudeTranscriptAnchorOptions
): { readiness: ClaudeControlReadiness; anchor?: ClaudeTranscriptAnchor } {
  try {
    const anchor = captureClaudeTranscriptAnchor(input);
    return anchor ? { readiness: { ready: true }, anchor } : {
      readiness: {
        ready: false, reason: "claude_completion_monitor_unavailable",
        message: "AKK cannot verify this Claude session's completed foreground turn and transcript for managed completion tracking. " +
          "Claude may still be busy; a background shell alone is allowed only with verified foreground completion. Wait for the task result or check Status for the blocking reason, then refresh List and retry through AKK. No task text was sent."
      }
    };
  } catch {
    return { readiness: {
      ready: false, reason: "claude_transcript_boundary_unavailable",
      message: "AKK cannot safely read this Claude transcript before managed Send. " +
        "Check Status and Claude's transcript access; restore access or wait for Claude to finish writing, then refresh List and retry. " +
        "No task text was sent."
    } };
  }
}

/** List retains only diagnostics, never a captured anchor as later mutation authority. */
export function observeClaudeTerminalAdmission(
  input: CaptureClaudeTranscriptAnchorOptions & { processStartedAt?: number }
): ClaudeTerminalAdmission {
  const observation = observeClaudeThreadLifecycle({
    operation: { kind: "new_thread" }, phase: "before", pid: input.pid,
    processStartedAt: input.processStartedAt, cwd: input.cwd, agentRows: input.agentRows, claudeHome: input.claudeHome
  });
  return {
    lifecycle: claudeLifecycleReadiness({ cwd: input.cwd, expectedNativeThreadId: input.sessionId, observation }),
    managedSend: captureClaudeManagedSendAdmission(input).readiness
  };
}
