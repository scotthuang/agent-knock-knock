import path from "node:path";
import type { Conversation } from "./protocol.js";
import { supersedeMatchingInteractionCallbackDelivery } from "./callback-outbox-policy.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { cliNow, cliNowMs, cliPid, cliSleepSync } from "./cli-runtime-context.js";
import { appendEvent, loadState, pathsForConversationDir, saveState,
  withStoreWriterLease } from "./store.js";
import { isRecord, nonBlankString } from "./value-guards.js";

/** Only withdraw an observed async offer; never creates response authority. */
export function retireAbsentAsyncQuestionNotification(input: {
  statePath: string;
  logPath: string;
  expectedConversation: Conversation;
  absenceProven: boolean;
}): Conversation {
  const storeDir = pathsForConversationDir(path.dirname(input.statePath)).storeDir;
  return withStoreWriterLease(storeDir, () => {
    const release = createFileLockCliAdapter({
      now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync
    }).acquire(`${input.statePath}.lock`);
    try {
      const current = loadState(input.statePath);
      const next = retireAbsentAsyncQuestionInSnapshot(
        current, input.expectedConversation, input.absenceProven, cliNow().toISOString()
      );
      if (next !== current) {
        saveState(input.statePath, next);
        appendEvent(input.logPath, {
          ts: next.updated_at,
          conversation_id: next.conversation_id,
          event: "terminal_bridge_async_question_withdrawn",
          reason: "exact_main_composer_has_no_async_question"
        });
      }
      return next;
    } finally {
      release();
    }
  });
}

export function retireAbsentAsyncQuestionInSnapshot(
  current: Conversation,
  expected: Conversation,
  absenceProven: boolean,
  at: string
): Conversation {
  if (!absenceProven || current.conversation_id !== expected.conversation_id ||
      current.updated_at !== expected.updated_at ||
      current.status !== "waiting_for_agent") return current;
  const takeover = isRecord(current.native_session_takeover)
    ? current.native_session_takeover : undefined;
  const expectedTakeover = isRecord(expected.native_session_takeover)
    ? expected.native_session_takeover : undefined;
  const notification = isRecord(takeover?.terminal_bridge_interaction_notification)
    ? takeover.terminal_bridge_interaction_notification : undefined;
  const expectedNotification = isRecord(expectedTakeover?.terminal_bridge_interaction_notification)
    ? expectedTakeover.terminal_bridge_interaction_notification : undefined;
  const projection = isRecord(notification?.interaction_state)
    ? notification.interaction_state : undefined;
  const dispatch = isRecord(takeover?.terminal_bridge_interaction_dispatch)
    ? takeover.terminal_bridge_interaction_dispatch : undefined;
  const interactionId = nonBlankString(notification?.interaction_id);
  const fingerprint = nonBlankString(notification?.prompt_fingerprint);
  if (projection?.kind !== "async_question" || !interactionId || !fingerprint ||
      takeover?.terminal_bridge_message_id !== expectedTakeover?.terminal_bridge_message_id ||
      interactionId !== expectedNotification?.interaction_id ||
      fingerprint !== expectedNotification?.prompt_fingerprint ||
      dispatch?.state === "reserved" || dispatch?.state === "uncertain") return current;
  const superseded = supersedeMatchingInteractionCallbackDelivery(current, {
    at, interactionId, fingerprint
  });
  const nextTakeover = { ...takeover };
  delete nextTakeover.terminal_bridge_interaction_notification;
  return { ...superseded, native_session_takeover: nextTakeover, updated_at: at };
}
