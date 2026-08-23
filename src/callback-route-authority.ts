import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import {
  createLegacyOpenClawCallbackRoute,
  parseCallbackRoute,
  type CallbackRouteV1
} from "./callback-transport.js";
import type { Conversation } from "./protocol.js";
import {
  nonBlankString,
  recordValue
} from "./value-guards.js";

export interface CallbackRouteAuthorityRecord {
  callback_route?: unknown;
  gateway_method?: unknown;
  gateway_session?: unknown;
  openclaw_session?: unknown;
  openclaw_bin?: unknown;
  gateway_url?: unknown;
}

export interface ResolveCallbackRouteAuthorityInput {
  conversation: CallbackRouteAuthorityRecord;
  primaryOutbox?: unknown;
}

/**
 * Canonical, secretless identity for one trusted callback route snapshot.
 * The digest is durable dispatch authority; it is never a model argument.
 */
export function callbackRouteFingerprint(route: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(parseCallbackRoute(route)))
    .digest("hex")}`;
}

/**
 * Read the durable route authority without collapsing explicit no-route
 * (`null`) into a legacy record that predates the field. Malformed declared
 * authority is never treated as absent.
 */
export function callbackRouteFingerprintFromRecord(
  value: unknown
): string | null | undefined {
  const record = recordValue(value);
  if (!record || !Object.hasOwn(record, "callback_route_fingerprint")) {
    return undefined;
  }
  const fingerprint = record.callback_route_fingerprint;
  if (fingerprint === null) return null;
  if (
    typeof fingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(fingerprint)
  ) {
    return fingerprint;
  }
  throw new Error("callback_route_fingerprint authority is invalid");
}

/**
 * Project one receipt's route authority into its ledger. A ledger that
 * predates the field may be upgraded, but an already-declared different
 * authority is a hard conflict rather than a redirect.
 */
export function callbackRouteFingerprintLedgerFields(input: {
  receipt: unknown;
  ledger: unknown;
  context: string;
}): { callback_route_fingerprint?: string | null } {
  const receiptAuthority = callbackRouteFingerprintFromRecord(input.receipt);
  const ledgerAuthority = callbackRouteFingerprintFromRecord(input.ledger);
  if (
    ledgerAuthority !== undefined &&
    ledgerAuthority !== receiptAuthority
  ) {
    throw new Error(
      `${input.context} callback route conflicts with its dispatch ledger`
    );
  }
  return receiptAuthority === undefined
    ? {}
    : { callback_route_fingerprint: receiptAuthority };
}

export function callbackRouteFingerprintForConversation(
  conversation: CallbackRouteAuthorityRecord
): string | undefined {
  const route = callbackRouteForConversation(conversation);
  return route ? callbackRouteFingerprint(route) : undefined;
}

/**
 * Resolve the durable callback destination without silently downgrading a
 * malformed generic route to legacy OpenClaw fields.
 *
 * A primary outbox route is an immutable delivery snapshot and therefore has
 * precedence over every Conversation route, including when the immutable
 * snapshot uses legacy Gateway fields. Legacy compatibility is available only
 * when both a non-blank Gateway method and controller session can be proven.
 */
export function resolveCallbackRouteAuthority({
  conversation,
  primaryOutbox
}: ResolveCallbackRouteAuthorityInput): CallbackRouteV1 | undefined {
  const outbox = recordValue(primaryOutbox);
  if (outbox && Object.hasOwn(outbox, "callback_route")) {
    return parseCallbackRoute(outbox.callback_route);
  }
  if (outbox && nonBlankString(outbox.gateway_method)) {
    return legacyCallbackRoute(outbox, conversation);
  }
  if (Object.hasOwn(conversation, "callback_route")) {
    return parseCallbackRoute(conversation.callback_route);
  }
  return legacyCallbackRoute(conversation);
}

export function callbackRouteForConversation(
  conversation: CallbackRouteAuthorityRecord
): CallbackRouteV1 | undefined {
  return resolveCallbackRouteAuthority({ conversation });
}

export function callbackRouteForPrimaryOutbox(
  conversation: Conversation
): CallbackRouteV1 | undefined {
  return resolveCallbackRouteAuthority({
    conversation,
    primaryOutbox: conversation.callback_delivery
  });
}

export function callbackExpectedForConversation(
  conversation: CallbackRouteAuthorityRecord
): boolean {
  return callbackRouteForConversation(conversation) !== undefined;
}

/**
 * Preserve a callback_expected bit written by an older dispatch ledger only
 * when the Conversation has no callback authority declaration of its own.
 * A malformed generic route still throws, and an incomplete legacy route does
 * not inherit a stale truthy bit from the ledger.
 */
export function callbackExpectedForConversationWithLegacyFallback(
  conversation: CallbackRouteAuthorityRecord,
  legacyCallbackExpected: unknown
): boolean {
  if (callbackExpectedForConversation(conversation)) return true;
  if (
    Object.hasOwn(conversation, "callback_route") ||
    nonBlankString(conversation.gateway_method)
  ) {
    return false;
  }
  return legacyCallbackExpected === true;
}

export function callbackExpectedForPrimaryOutbox(
  conversation: Conversation
): boolean {
  return callbackRouteForPrimaryOutbox(conversation) !== undefined;
}

function legacyCallbackRoute(
  record: CallbackRouteAuthorityRecord,
  fallback: CallbackRouteAuthorityRecord = record
): CallbackRouteV1 | undefined {
  const gatewayMethod = nonBlankString(record.gateway_method);
  const controllerSessionId =
    nonBlankString(record.gateway_session) ??
    nonBlankString(record.openclaw_session) ??
    nonBlankString(fallback.gateway_session) ??
    nonBlankString(fallback.openclaw_session);
  if (!gatewayMethod || !controllerSessionId) {
    return undefined;
  }
  return createLegacyOpenClawCallbackRoute({
    gatewayMethod,
    controllerSessionId,
    openclawBin: nonBlankString(record.openclaw_bin) ??
      nonBlankString(fallback.openclaw_bin),
    gatewayUrl: nonBlankString(record.gateway_url) ??
      nonBlankString(fallback.gateway_url)
  });
}
