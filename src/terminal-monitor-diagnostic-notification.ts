import { createMessage, executorForConversation, isWaitingForAgentStatus,
  turnIdForConversation, type Conversation } from "./protocol.js";
import { callbackExpectedForConversation } from "./callback-route-authority.js";
import type { CallbackCliFacade } from "./callback-cli-adapter.js";
import type { PreparedCallback, CallbackExecutionResult } from "./callback-outbox-service.js";
import { redactString } from "./runtime-log.js";
import { recordValue, nonBlankString } from "./value-guards.js";

/** Called under the Store/state transaction. A diagnostic never ends the Turn. */
export function prepareDetectorNotification(input: {
  conversation: Conversation;
  diagnostic: Record<string, unknown>;
  statePath: string;
  logPath: string;
  prepare: CallbackCliFacade["prepareStallNotification"];
}): { conversation: Conversation; diagnostic: Record<string, unknown>; prepared?: PreparedCallback } {
  const { conversation, diagnostic } = input;
  const delivery = recordValue(conversation.callback_notification_delivery);
  if (diagnostic.status !== "limited" || diagnostic.notification_message_id ||
      diagnostic.notification_duplicate === true ||
      !isWaitingForAgentStatus(conversation.status) || !callbackExpectedForConversation(conversation) ||
      ["pending", "failed"].includes(String(delivery?.status))) return { conversation, diagnostic };
  const message = createMessage({
    conversation, from: executorForConversation(conversation).actor, to: "openclaw",
    type: "error", requiresResponse: false,
    body: `AKK cannot currently confirm the result of Turn ${turnIdForConversation(conversation)}. ` +
      "The task may still be running or may already have finished. Monitoring continues; " +
      "AKK will send the final result when it can verify it. Do not resend the task just because this notice arrived.",
    metadata: { source: "terminal_bridge", reason: "completion_detection_unavailable" }
  });
  const notified = { ...diagnostic, notification_message_id: message.id };
  const next = { ...conversation, native_session_takeover: {
    ...recordValue(conversation.native_session_takeover), terminal_bridge_detector_diagnostic: notified
  } };
  const result = input.prepare({
    options: { statePath: input.statePath, callbackDeliveryKind: "completion_uncertain_notification" },
    statePath: input.statePath, logPath: input.logPath, conversation: next, message
  });
  if (result.prepared?.outcome === "duplicate") {
    // Semantic outbox deduplication does not save the proposed Conversation.
    // Retain this episode's diagnostic without claiming a new sent message ID.
    const duplicateDiagnostic = { ...diagnostic, notification_duplicate: true };
    return { conversation: { ...conversation, native_session_takeover: {
      ...recordValue(conversation.native_session_takeover),
      terminal_bridge_detector_diagnostic: duplicateDiagnostic
    } }, diagnostic: duplicateDiagnostic };
  }
  return result.prepared
    ? { conversation: result.prepared.conversation, diagnostic: notified, prepared: result.prepared }
    : { conversation, diagnostic };
}

export function detectorDiagnostic(
  input: { limitation?: string; fingerprint?: string },
  existing: Record<string, unknown> | undefined,
  now: string
): Record<string, unknown> | undefined {
  if (input.limitation && input.fingerprint) {
    return {
      ...(existing?.status === "limited" && existing.notification_message_id
        ? { notification_message_id: existing.notification_message_id } : {}),
      ...(existing?.status === "limited" && existing.notification_duplicate === true
        ? { notification_duplicate: true } : {}),
      status: "limited",
      source: "terminal_completion_detector",
      fingerprint: input.fingerprint,
      detail: redactString(input.limitation).replace(/\s+/g, " ").trim().slice(0, 1000),
      observed_at: now
    };
  }
  return existing && nonBlankString(existing.status) === "limited"
    ? { ...existing, status: "recovered", recovered_at: now }
    : undefined;
}

export function sameDetectorDiagnostic(
  existing: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): boolean {
  return nonBlankString(existing?.status) === nonBlankString(next.status) &&
    nonBlankString(existing?.fingerprint) === nonBlankString(next.fingerprint);
}


/** Transport work runs after releasing the diagnostic Store transaction. */
export function deliverDetectorNotification(prepared: PreparedCallback, ports: {
  callbacks: { run(prepared: PreparedCallback, options: { emit: boolean }): CallbackExecutionResult };
  state: { load(): Conversation };
  runtime: { log(level: "warn", event: string, fields: Record<string, unknown>): void };
}, failure: { event: string; terminalTarget?: string } = {
  event: "completion_uncertain_notification_delivery_deferred"
}): Conversation {
  try {
    ports.callbacks.run(prepared, { emit: false });
  } catch {
    // The durable outbox owns retries; keep detecting the task's final result.
    ports.runtime.log("warn", failure.event, {
      ...(failure.terminalTarget ? { terminal_target: failure.terminalTarget } : {}),
      conversation_id: prepared.conversation.conversation_id
    });
  }
  return ports.state.load();
}
