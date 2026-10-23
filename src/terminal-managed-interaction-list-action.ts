import { executorForConversation, turnIdForConversation, type Conversation } from "./protocol.js";
import { terminalControlsShareIncarnation } from "./terminal-authority-policy.js";
import { validateAnyTerminalInteractionProjection } from "./terminal-interaction-protocol.js";
import { nonBlankString, recordValue } from "./value-guards.js";

/** Discovery offer only: fresh owner-bound Status still supplies response authority. */
export function managedInteractionListAction(conversation: Conversation, nowMs: number) {
  if (!["waiting_for_agent", "waiting_for_openclaw"].includes(conversation.status)) return undefined;
  const current = currentInteractionNotification(conversation);
  if (!current) return undefined;
  const { notification, messageId, fingerprint } = current;
  let projection;
  try { projection = validateAnyTerminalInteractionProjection(notification?.interaction_state); }
  catch { return undefined; }
  const turnId = turnIdForConversation(conversation);
  if (projection.state !== "pending" || !projection.capabilities.respond ||
      projection.agent !== executorForConversation(conversation).kind ||
      projection.interaction_id !== notification?.interaction_id ||
      !Number.isFinite(nowMs) || Date.parse(projection.expires_at) <= nowMs) return undefined;
  if (projection.version === 1 ? projection.turn_id !== turnId :
      projection.subject.kind !== "managed_turn" || projection.subject.turn_id !== turnId ||
      projection.subject.message_id !== messageId || projection.response_authority !== "executable" ||
      projection.prompt_fingerprint !== fingerprint) return undefined;
  return {
    tool: "agent_knock_knock_respond_interaction",
    arguments: { turn_id: turnId },
    missing_required: ["interaction_id", "answers"],
    before_call: {
      tool: "agent_knock_knock_status",
      arguments: { turn_id: turnId },
      use: "Refresh this exact Turn in the owning controller conversation; use its current pending interaction and the user's answer."
    },
    requires_fresh_status: true
  };
}

/** Retained notifications must belong to this live message and remain unconsumed. */
function currentInteractionNotification(conversation: Conversation) {
  const takeover = recordValue(conversation.native_session_takeover);
  const notification = recordValue(takeover?.terminal_bridge_interaction_notification);
  const dispatch = recordValue(takeover?.terminal_bridge_interaction_dispatch);
  const messageId = nonBlankString(takeover?.terminal_bridge_message_id);
  const fingerprint = nonBlankString(notification?.prompt_fingerprint);
  if (takeover?.terminal_bridge !== true || !messageId || !fingerprint ||
      !/^[0-9a-f]{64}$/u.test(fingerprint) ||
      notification?.terminal_bridge_message_id !== messageId ||
      ["reserved", "uncertain"].includes(String(dispatch?.state)) ||
      takeover.terminal_bridge_last_interaction_fingerprint === fingerprint ||
      !terminalControlsShareIncarnation(
        takeover.terminal_control, notification?.terminal_control
      )) return undefined;
  return { notification, messageId, fingerprint };
}
