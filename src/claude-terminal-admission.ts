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
  if (input.cwd && path.isAbsolute(input.cwd) && observed?.status === "observed" &&
      isExactNativeThreadId(input.expectedNativeThreadId) &&
      observed.nativeThreadId === input.expectedNativeThreadId.toLowerCase() && observed.idle === true) {
    return { ready: true };
  }
  return {
    ready: false,
    reason: "claude_lifecycle_identity_unavailable",
    message: "AKK cannot verify one current idle Claude session in this window for a thread change. " +
      "Wait for Claude to finish, check Status and the Claude reader, then refresh List and retry. " +
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
        message: "AKK cannot verify this Claude session's idle process and transcript for managed completion tracking. " +
          "Wait for Claude to finish, check Status and the Claude reader, then refresh List and retry. No task text was sent."
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
    processStartedAt: input.processStartedAt, cwd: input.cwd, agentRows: input.agentRows
  });
  return {
    lifecycle: claudeLifecycleReadiness({ cwd: input.cwd, expectedNativeThreadId: input.sessionId, observation }),
    managedSend: captureClaudeManagedSendAdmission(input).readiness
  };
}
