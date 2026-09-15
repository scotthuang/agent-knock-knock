import { canonicalJson } from "./canonical-json.js";
import type { CallbackDeliveryOptions } from "./callback-outbox-policy.js";
import type { CallbackOutboxLane } from "./callback-outbox-settlement.js";
import { callbackRouteFingerprint } from "./callback-route-authority.js";
import {
  createCallbackEnvelope,
  resolveCallbackRoute as resolveHostCallbackRoute,
  type CallbackEnvelopeV1,
  type CallbackRouteCandidate,
  type CallbackRouteV1
} from "./callback-transport.js";
import {
  sessionIdForConversation,
  turnIdForConversation,
  type AgentMessage,
  type Conversation
} from "./protocol.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";

export interface CallbackPreparationOptions extends CallbackDeliveryOptions {
  statePath: string;
  messageJson?: string;
  log?: string;
  conversationOverride?: unknown;
  callbackDeliveryKind?: string;
  allowTerminalCompletionRecoveryStatus?: boolean;
  closeTerminalBridgeOnDone?: boolean;
  disableCallbackRetry?: boolean;
  preserveMessageId?: boolean;
  recordOnly?: boolean;
  recoverMissingOutbox?: boolean;
  recoverTerminalCompletion?: boolean;
  retryPending?: boolean;
  /** Internal durable lane; ordinary callbacks use the lifecycle lane. */
  callbackOutboxLane?: CallbackOutboxLane;
}

export interface CallbackGatewayRouteCandidate {
  gatewayUrl?: unknown;
  token?: unknown;
}

export function resolveCallbackGatewayRoute(
  ...candidates: CallbackGatewayRouteCandidate[]
) {
  let gatewayUrl: string | undefined;
  for (const candidate of candidates) {
    gatewayUrl ??= stringValue(candidate.gatewayUrl);
    const token = stringValue(candidate.token);
    if (!token || token === "<token>") {
      continue;
    }
    return {
      gatewayUrl: stringValue(candidate.gatewayUrl) ?? gatewayUrl,
      token
    };
  }
  return {
    gatewayUrl,
    token: undefined
  };
}

export function resolveManagedCallbackRoute(input: {
  options: CallbackPreparationOptions;
  conversation: Conversation;
  inheritedDelivery?: Record<string, unknown>;
}): CallbackRouteV1 | undefined {
  if (input.inheritedDelivery) {
    return resolveHostCallbackRoute(
      callbackRouteFieldCandidate(input.inheritedDelivery, "callback_route"),
      legacyCallbackRouteCandidate({
        gatewayMethod: input.inheritedDelivery.gateway_method,
        gatewaySession: input.inheritedDelivery.gateway_session ??
          input.conversation.gateway_session ??
          input.conversation.openclaw_session,
        openclawBin: input.inheritedDelivery.openclaw_bin ??
          input.conversation.openclaw_bin,
        gatewayUrl: input.inheritedDelivery.gateway_url ??
          input.conversation.gateway_url
      })
    );
  }
  return resolveHostCallbackRoute(
    callbackRouteFieldCandidate(input.options, "callbackRoute"),
    callbackRouteFieldCandidate(input.conversation, "callback_route"),
    legacyCallbackRouteCandidate({
      gatewayMethod: input.options.gatewayMethod ??
        input.conversation.gateway_method,
      gatewaySession: input.options.gatewaySession ??
        input.options.openclawSession ?? input.conversation.gateway_session ??
        input.conversation.openclaw_session,
      openclawBin: input.options.openclawBin ??
        input.conversation.openclaw_bin,
      gatewayUrl: input.options.gatewayUrl ?? input.conversation.gateway_url
    }),
    legacyCallbackRouteCandidate({
      gatewayMethod: input.conversation.gateway_method,
      gatewaySession: input.conversation.gateway_session ??
        input.conversation.openclaw_session,
      openclawBin: input.conversation.openclaw_bin,
      gatewayUrl: input.conversation.gateway_url
    })
  );
}

function callbackRouteFieldCandidate(
  container: object,
  field: string
): CallbackRouteCandidate {
  return Object.hasOwn(container, field)
    ? { callbackRoute: (container as Record<string, unknown>)[field] }
    : {};
}

export function resolvedDeliveryOptions(input: {
  options: CallbackPreparationOptions;
  conversation: Conversation;
  inheritedDelivery?: Record<string, unknown>;
  callbackRoute?: CallbackRouteV1;
}): CallbackPreparationOptions {
  if (!input.inheritedDelivery) {
    return {
      ...input.options,
      ...(input.callbackRoute ? { callbackRoute: input.callbackRoute } : {}),
      gatewayMethod: input.options.gatewayMethod ??
        input.conversation.gateway_method,
      gatewaySession: input.options.gatewaySession ??
        input.options.openclawSession ?? input.conversation.gateway_session ??
        input.conversation.openclaw_session,
      openclawSession: input.options.openclawSession ??
        input.conversation.openclaw_session,
      openclawBin: input.options.openclawBin ??
        input.conversation.openclaw_bin,
      gatewayUrl: input.options.gatewayUrl ?? input.conversation.gateway_url
    };
  }
  const { callbackRoute: _ignoredCurrentRoute, ...currentOptions } =
    input.options;
  return {
    ...currentOptions,
    ...(input.callbackRoute ? { callbackRoute: input.callbackRoute } : {}),
    gatewayMethod: stringValue(input.inheritedDelivery.gateway_method),
    gatewaySession: stringValue(input.inheritedDelivery.gateway_session) ??
      input.conversation.gateway_session ??
      input.conversation.openclaw_session,
    openclawSession: input.conversation.openclaw_session,
    openclawBin: stringValue(input.inheritedDelivery.openclaw_bin) ??
      input.conversation.openclaw_bin,
    gatewayUrl: stringValue(input.inheritedDelivery.gateway_url) ??
      input.conversation.gateway_url
  };
}

function legacyCallbackRouteCandidate(input: {
  gatewayMethod?: unknown;
  gatewaySession?: unknown;
  openclawBin?: unknown;
  gatewayUrl?: unknown;
}): CallbackRouteCandidate {
  return stringValue(input.gatewayMethod)
    ? {
        legacyOpenClaw: {
          controllerSessionId: input.gatewaySession,
          gatewayMethod: input.gatewayMethod,
          openclawBin: input.openclawBin,
          gatewayUrl: input.gatewayUrl
        }
      }
    : {};
}

export function createManagedCallbackEnvelope(
  route: CallbackRouteV1,
  conversation: Conversation,
  message: AgentMessage
): CallbackEnvelopeV1 {
  return createCallbackEnvelope({
    route,
    source: {
      kind: "managed_turn",
      session_id: sessionIdForConversation(conversation),
      turn_id: turnIdForConversation(conversation),
      conversation_id: conversation.conversation_id
    },
    event: {
      id: message.id,
      type: message.type,
      body: message.body,
      requires_response: message.requires_response,
      metadata: message.metadata
    }
  });
}

export function assertImmutableCallbackTransport(
  inheritedDelivery: Record<string, unknown> | undefined,
  route: CallbackRouteV1 | undefined,
  envelope: CallbackEnvelopeV1 | undefined,
  messageId: string
): void {
  if (!inheritedDelivery) return;
  if (
    inheritedDelivery.callback_route !== undefined &&
    canonicalJson(inheritedDelivery.callback_route) !== canonicalJson(route)
  ) {
    throw new Error(
      `callback message ${messageId} conflicts with its persisted immutable route`
    );
  }
  if (
    inheritedDelivery.callback_envelope !== undefined &&
    canonicalJson(inheritedDelivery.callback_envelope) !==
      canonicalJson(envelope)
  ) {
    throw new Error(
      `callback message ${messageId} conflicts with its persisted immutable envelope`
    );
  }
}

export function assertDispatchCallbackRouteAuthority(
  conversation: Conversation,
  route: CallbackRouteV1 | undefined
): void {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const submission = isRecord(takeover?.terminal_bridge_submission)
    ? takeover.terminal_bridge_submission
    : undefined;
  if (
    !submission ||
    !Object.hasOwn(submission, "callback_route_fingerprint")
  ) {
    // Records from before the route-fingerprint field remain readable.
    return;
  }
  const authority = submission.callback_route_fingerprint;
  const matches = authority === null
    ? route === undefined
    : stringValue(authority) !== undefined && route !== undefined &&
      callbackRouteFingerprint(route) === authority;
  if (!matches) {
    throw new Error(
      "callback route conflicts with immutable terminal dispatch authority"
    );
  }
}
