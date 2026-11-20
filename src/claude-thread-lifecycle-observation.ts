import path from "node:path";
import { isClaudeAgentIdleState } from "./claude-agent-state.js";
import { captureClaudeTranscriptAnchor } from "./claude-local-transcript-provider.js";
import type { ClaudeAgentRow } from "./claude-agent-state.js";
import type { TerminalThreadLifecycleObservation, TerminalThreadLifecycleObservationRequest,
  TerminalThreadLifecycleOperation } from "./terminal-agent-adapter.js";
import { isExactNativeThreadId } from "./managed-session.js";
import { nonBlankString as nonEmptyString } from "./value-guards.js";

export function observeClaudeThreadLifecycle(
  request: TerminalThreadLifecycleObservationRequest,
  legacyOperation?: undefined,
  fallbackAgentRows?: readonly ClaudeAgentRow[]
): TerminalThreadLifecycleObservation;
/** @deprecated Claude lifecycle identity requires a typed agents-row request. */
export function observeClaudeThreadLifecycle(
  screen: string,
  operation: TerminalThreadLifecycleOperation,
  fallbackAgentRows?: readonly ClaudeAgentRow[]
): TerminalThreadLifecycleObservation;
export function observeClaudeThreadLifecycle(
  requestOrScreen: TerminalThreadLifecycleObservationRequest | string,
  legacyOperation?: TerminalThreadLifecycleOperation,
  fallbackAgentRows: readonly ClaudeAgentRow[] = []
): TerminalThreadLifecycleObservation {
  if (typeof requestOrScreen === "string") {
    return {
      status: "missing",
      reason:
        "Claude lifecycle identity is not available from screen text; exact agents JSON is required"
    };
  }
  const request = requestOrScreen;
  const pid = Number(request.pid);
  const startedAt = Number(request.processStartedAt);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0
  ) {
    return {
      status: "missing",
      reason: "Claude lifecycle observation requires exact PID and startedAt identity"
    };
  }
  const rows = request.agentRows ?? fallbackAgentRows;
  const matches = rows.filter((row) => Number(row.pid) === pid);
  if (matches.length === 0) {
    return {
      status: "missing",
      reason: `Claude agents JSON has no row for PID ${pid}`
    };
  }
  if (matches.length !== 1) {
    return {
      status: "ambiguous",
      reason: `Claude agents JSON has ${matches.length} rows for PID ${pid}`
    };
  }
  const row = matches[0];
  const nativeThreadId = nonEmptyString(row.sessionId)?.toLowerCase();
  if (
    row.kind !== "interactive" ||
    !isExactNativeThreadId(nativeThreadId) ||
    Number(row.startedAt) !== startedAt ||
    (
      request.cwd !== undefined &&
      (
        !path.isAbsolute(request.cwd) ||
        typeof row.cwd !== "string" ||
        !path.isAbsolute(row.cwd) ||
        path.resolve(row.cwd) !== path.resolve(request.cwd)
      )
    )
  ) {
    return {
      status: "mismatch",
      nativeThreadId,
      evidence: "claude_agents_exact_pid",
      reason: "Claude agents JSON does not match the expected interactive process incarnation"
    };
  }
  const foregroundComplete = row.status === "shell" && !row.waitingFor?.trim() &&
    completedForeground(request, row);
  const observed: TerminalThreadLifecycleObservation = {
    status: "observed",
    nativeThreadId,
    evidence: "claude_agents_exact_pid",
    idle: isClaudeAgentIdleState(row),
    ...(row.status === "shell" ? { foregroundComplete } : {})
  };
  if (request.phase === "before") {
    return observed;
  }
  if (!observed.idle && !foregroundComplete) {
    return {
      ...observed,
      status: "mismatch",
      reason: `Claude agents JSON reports ${row.status ?? "unknown"}, foreground completion is not proven`
    };
  }
  if (request.operation.kind === "new_thread") {
    if (!isExactNativeThreadId(request.beforeNativeThreadId)) {
      return {
        ...observed,
        status: "mismatch",
        reason: "a verified before-session UUID is required for Claude /clear"
      };
    }
    return nativeThreadId === request.beforeNativeThreadId.toLowerCase()
      ? {
          ...observed,
          status: "mismatch",
          reason: "Claude /clear did not change the sessionId"
        }
      : { ...observed, status: "verified" };
  }
  const expected = (
    request.expectedNativeThreadId ?? request.operation.nativeThreadId
  ).toLowerCase();
  if (!isExactNativeThreadId(expected)) {
    return {
      ...observed,
      status: "mismatch",
      reason: "Claude resume postcondition requires an exact target UUID"
    };
  }
  return nativeThreadId === expected
    ? { ...observed, status: "verified" }
    : {
        ...observed,
        status: "mismatch",
        reason: `Claude resumed ${nativeThreadId}, not the requested native thread ${expected}`
      };
}

/** A shell flag is never authority: reuse Send's exact, stable transcript proof. */
function completedForeground(request: TerminalThreadLifecycleObservationRequest, row: ClaudeAgentRow): boolean {
  try {
    return captureClaudeTranscriptAnchor({ pid: request.pid, sessionId: row.sessionId,
      cwd: request.cwd, claudeHome: request.claudeHome, agentRows: [row] }) !== undefined;
  } catch {
    return false;
  }
}
