/** Managed-Turn interaction normalization and public projection, without effects. */
import { turnIdForConversation, type Conversation, type Executor } from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { TerminalBridgeStatus } from "./terminal-agent-bridge.js";
import {
  normalizeTerminalInteractionProjectionV2,
  type TerminalInteractionSubjectProjection
} from "./terminal-interaction-protocol.js";
import { nonBlankString as stringValue } from "./value-guards.js";

interface MonitorInteractionProjectionInput {
  state: { conversation: Conversation; executor: Pick<Executor, "kind"> };
  terminalStatus: TerminalBridgeStatus;
  terminalControl: TerminalControlRef;
  currentMessageId?: string;
}

export function normalizeManagedMonitorInteraction(
  input: MonitorInteractionProjectionInput,
  projection: NonNullable<TerminalBridgeStatus["interaction_state"]>,
  fingerprint: string | undefined,
  surfaceId: string | undefined
): TerminalInteractionSubjectProjection | undefined {
  if (!input.currentMessageId || !fingerprint || !surfaceId) {
    return undefined;
  }
  try {
    return normalizeTerminalInteractionProjectionV2(projection, {
      subject: {
        kind: "managed_turn",
        turn_id: turnIdForConversation(input.state.conversation),
        message_id: input.currentMessageId
      },
      surfaceId,
      promptFingerprint: fingerprint,
      responseAuthority: projection.state === "pending" &&
          projection.capabilities.respond
        ? "executable"
        : "notify_only"
    });
  } catch {
    return undefined;
  }
}

export function terminalInteractionSurfaceId(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate && /^tis_[0-9a-f]{40}$/u.test(candidate)
    ? candidate
    : undefined;
}

export function interactionCallbackPublicConversation(
  conversation: Conversation
): Conversation {
  const projected = { ...conversation };
  delete projected.native_session_takeover;
  delete projected.callback_delivery;
  delete projected.callback_notification_delivery;
  return projected;
}

export function interactionObservationMatchesMonitor(
  input: MonitorInteractionProjectionInput,
  projection: TerminalBridgeStatus["interaction_state"]
): boolean {
  return input.terminalStatus.reachable &&
    input.terminalStatus.provider === input.terminalControl.kind &&
    input.terminalStatus.target === input.terminalControl.target &&
    input.terminalStatus.agent === input.state.executor.kind &&
    (projection === undefined || projection.agent === input.state.executor.kind);
}
