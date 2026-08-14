export interface TerminalMonitorPollState {
  previousScreenFingerprint: string | undefined;
  previousDurableFingerprint?: string;
  previousCompletionFingerprint?: string;
}

export interface TerminalMonitorActivityPollInput {
  state: TerminalMonitorPollState;
  activityState?: string;
  activityReason?: string;
  screenFingerprint?: string;
  durableFingerprint?: string;
}

export interface TerminalMonitorActivityPollDecision {
  state: TerminalMonitorPollState;
  screenChanged: boolean;
  durableChanged: boolean;
  activityReasons: string[];
  activityReason?: string;
}

export function reduceTerminalMonitorActivityPoll(
  input: TerminalMonitorActivityPollInput
): TerminalMonitorActivityPollDecision {
  const screenChanged =
    input.state.previousScreenFingerprint !== undefined &&
    input.screenFingerprint !== undefined &&
    input.screenFingerprint !== input.state.previousScreenFingerprint;
  const durableChanged =
    input.durableFingerprint !== undefined &&
    input.durableFingerprint !== input.state.previousDurableFingerprint;
  const activityReasons = [
    input.activityState === "working" ? input.activityReason : undefined,
    screenChanged ? "terminal screen changed" : undefined,
    durableChanged ? "durable completion evidence changed" : undefined
  ].filter((value): value is string => Boolean(value));

  return {
    state: {
      ...input.state,
      previousScreenFingerprint: input.screenFingerprint,
      previousDurableFingerprint: input.durableFingerprint
    },
    screenChanged,
    durableChanged,
    activityReasons,
    ...(activityReasons.length > 0
      ? { activityReason: activityReasons.join("; ") }
      : {})
  };
}

export interface TerminalMonitorCompletionPollInput {
  state: TerminalMonitorPollState;
  completionPresent: boolean;
  completionFingerprint?: string;
}

export interface TerminalMonitorCompletionPollDecision {
  state: TerminalMonitorPollState;
  completionStable: boolean;
  checkVerifiedDeadAgent: boolean;
}

export function reduceTerminalMonitorCompletionPoll(
  input: TerminalMonitorCompletionPollInput
): TerminalMonitorCompletionPollDecision {
  return {
    state: {
      ...input.state,
      previousCompletionFingerprint: input.completionFingerprint
    },
    completionStable:
      input.completionPresent &&
      input.completionFingerprint !== undefined &&
      input.completionFingerprint ===
        input.state.previousCompletionFingerprint,
    checkVerifiedDeadAgent: !input.completionPresent
  };
}

export type TerminalMonitorTimeoutDecision =
  | { kind: "none" }
  | { kind: "hard"; deadlineAtMs: number }
  | { kind: "inactivity"; deadlineAtMs: number };

export interface TerminalMonitorTimeoutInput {
  nowMs: number;
  taskStartedAtMs: number;
  lastActivityAtMs: number;
  hardTimeoutMinutes?: number;
  inactivityTimeoutMinutes?: number;
}

function enabledTimeoutMs(
  startedAtMs: number,
  timeoutMinutes: number | undefined
): { deadlineAtMs: number; timeoutMs: number } | undefined {
  if (
    timeoutMinutes === undefined ||
    !Number.isFinite(timeoutMinutes) ||
    timeoutMinutes <= 0
  ) {
    return undefined;
  }
  const timeoutMs = timeoutMinutes * 60 * 1000;
  return {
    deadlineAtMs: startedAtMs + timeoutMs,
    timeoutMs
  };
}

export function decideTerminalMonitorTimeout(
  input: TerminalMonitorTimeoutInput
): TerminalMonitorTimeoutDecision {
  const hardTimeout = enabledTimeoutMs(
    input.taskStartedAtMs,
    input.hardTimeoutMinutes
  );
  if (
    hardTimeout !== undefined &&
    input.nowMs - input.taskStartedAtMs >= hardTimeout.timeoutMs
  ) {
    return { kind: "hard", deadlineAtMs: hardTimeout.deadlineAtMs };
  }

  const inactivityTimeout = enabledTimeoutMs(
    input.lastActivityAtMs,
    input.inactivityTimeoutMinutes
  );
  if (
    inactivityTimeout !== undefined &&
    input.nowMs - input.lastActivityAtMs >= inactivityTimeout.timeoutMs
  ) {
    return {
      kind: "inactivity",
      deadlineAtMs: inactivityTimeout.deadlineAtMs
    };
  }

  return { kind: "none" };
}
