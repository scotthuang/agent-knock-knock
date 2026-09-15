import {
  nonBlankString as stringValue
} from "./value-guards.js";
import {
  TERMINAL_INTERACTION_LIMITS
} from "./terminal-interaction-protocol.js";

export function pushTurnTarget(args, params) {
  if (Object.hasOwn(params, "turn_id") && Object.hasOwn(params, "conversation_id")) {
    throw new Error("turn-target tools accept only one of turn_id or conversation_id");
  }
  const turnId = stringValue(params.turn_id);
  if (turnId) {
    args.push("--turn", authoritativeManagedId(turnId, "turn_id"));
    return;
  }
  args.push(
    "--conversation",
    requiredString(params.conversation_id, "turn_id")
  );
}

export function authoritativeManagedId(value, name) {
  const id = requiredString(value, name).trim();
  if (
    /^(?:only|latest|codex|claude|(?:codex|claude):latest)$/iu.test(id) ||
    /^@[0-9a-f]+$/iu.test(id) ||
    /^terminal:/iu.test(id)
  ) {
    throw new Error(
      `${name} must be an authoritative managed id, not a discovery selector or terminal id`
    );
  }
  return id;
}

export function assertExclusiveRecoveryFence(params) {
  const expectedMessageId = stringValue(params.expected_message_id);
  const expectedTransitionId = stringValue(params.expected_transition_id);
  const closeFenceCount = [expectedMessageId, expectedTransitionId]
    .filter(Boolean).length;
  if (closeFenceCount > 1) {
    throw new Error(
      "close accepts only one of expected_message_id or expected_transition_id"
    );
  }
  if (
    stringValue(params.reason) === "superseded_by_human_context_switch" &&
    (!stringValue(params.turn_id) || stringValue(params.conversation_id))
  ) {
    throw new Error(
      "human-context handoff Close requires the exact managed turn_id"
    );
  }
}

export function pushOptional(args, flag, value) {
  if (value !== undefined && value !== "") {
    args.push(flag, value);
  }
}

export function numberString(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}


export function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function requiredControllerSessionKey(value: unknown): string {
  return requiredString(
    value,
    "Controller session identity for this confirmed action"
  );
}

export function requiredControllerSessionId(value: unknown): string {
  return requiredString(
    value,
    "Controller conversation incarnation for this confirmed action"
  );
}

export function requiredTerminalInteractionIdentifier(
  value: unknown,
  name: string
): string {
  const identifier = requiredString(value, name);
  if (
    identifier.length > TERMINAL_INTERACTION_LIMITS.maxIdentifierLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(identifier)
  ) {
    throw new Error(`${name} must be an exact safe interaction identifier`);
  }
  return identifier;
}
