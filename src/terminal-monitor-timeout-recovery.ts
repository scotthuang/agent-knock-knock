import { continuesClaudeCompletionObservation } from "./terminal-monitor-continuation-policy.js";
import { type Conversation } from "./protocol.js";
import { appendEvent, loadState, saveState, withStoreWriterLease } from "./store.js";
import { recordValue, nonBlankString } from "./value-guards.js";

/** Only old timeout stalls are resumed; binding, ledger, callback route and generation remain fenced. */
export function recoverTimedOutClaudeMonitor(input: {
  storeDir: string; statePath: string; logPath: string;
  lock(work: () => Conversation): Conversation;
  assertBindingCurrent(conversation: Conversation): void;
  eligible(conversation: Conversation): boolean;
  now(): Date;
}): Conversation {
  return withStoreWriterLease(input.storeDir, () => input.lock(() => {
    const current = loadState(input.statePath);
    if (current.status !== "stalled" || !continuesClaudeCompletionObservation(current) ||
        current.callback_delivery || !/^terminal bridge (observed no activity for|reached its hard lifetime of) [0-9.]+ minutes$/u
          .test(nonBlankString(current.stalled_reason) ?? "")) return current;
    const resumed: Conversation = { ...current, status: "waiting_for_agent" };
    input.assertBindingCurrent(resumed);
    if (!input.eligible(resumed)) return current;
    const at = input.now().toISOString();
    resumed.updated_at = at;
    resumed.native_session_takeover = { ...recordValue(current.native_session_takeover),
      terminal_bridge_timeout_recovery: { resumed_at: at, stalled_at: current.stalled_at,
        reason: current.stalled_reason } };
    delete resumed.stalled_at;
    delete resumed.stalled_reason;
    saveState(input.statePath, resumed);
    appendEvent(input.logPath, { ts: at, conversation_id: resumed.conversation_id,
      event: "terminal_bridge_timeout_observation_resumed",
      terminal_bridge_message_id: recordValue(resumed.native_session_takeover)?.terminal_bridge_message_id });
    return resumed;
  }));
}
