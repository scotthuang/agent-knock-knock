import { decideTerminalMonitorAfterEffectsTimeout } from "./terminal-monitor-decision-policy.js";
import { executorForConversation, isExplicitUserAbandonedManagementTurn, type Conversation } from "./protocol.js";
import { recordValue } from "./value-guards.js";

/** An accepted Claude task retains read-only observation until a final result or explicit release. */
export function continuesClaudeCompletionObservation(conversation: Conversation): boolean {
  const takeover = recordValue(conversation.native_session_takeover);
  const submission = recordValue(takeover?.terminal_bridge_submission);
  return executorForConversation(conversation).kind === "claude" &&
    !isExplicitUserAbandonedManagementTurn(conversation) && takeover?.terminal_bridge === true &&
    submission?.status === "agent_accepted" &&
    submission.message_id === takeover.terminal_bridge_message_id &&
    recordValue(takeover.claude_transcript_anchor) !== undefined;
}


export function statusWithCompletionDeadline<T extends { capability_limitation?: string }>(
  conversation: Conversation, poll: { status: T; completion?: unknown }, nowMs: number,
  activity: { taskStartedAtMs: number; lastActivityAtMs: number },
  configuration: { hardTimeoutMinutes: number; timeoutMinutes: number }
): T {
  if (poll.status.capability_limitation || poll.completion ||
      !continuesClaudeCompletionObservation(conversation)) return poll.status;
  const deadline = decideTerminalMonitorAfterEffectsTimeout({ nowMs, ...activity,
    hardTimeoutMinutes: configuration.hardTimeoutMinutes,
    inactivityTimeoutMinutes: configuration.timeoutMinutes });
  return deadline.kind === "poll" ? poll.status : { ...poll.status,
    capability_limitation: `claude_completion_${deadline.kind}: result not yet verified; monitoring continues` };
}
