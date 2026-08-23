import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import {
  isRecord,
  nonBlankString,
  recordValue
} from "./value-guards.js";

export const CALLBACK_ROUTE_SCHEMA = "agent-knock-knock/callback-route";
export const CALLBACK_ROUTE_VERSION = 1 as const;
export const CALLBACK_ENVELOPE_SCHEMA = "agent-knock-knock/callback-envelope";
export const CALLBACK_ENVELOPE_VERSION = 1 as const;

export interface CallbackRouteCapabilitiesV1 {
  wake?: boolean;
  respond?: boolean;
}

/**
 * Immutable reference to one administrator-authorized callback destination.
 * Secrets and executable/network configuration remain behind the trusted
 * profile resolver and must never be persisted in this route.
 */
export interface CallbackRouteV1 {
  schema: typeof CALLBACK_ROUTE_SCHEMA;
  version: typeof CALLBACK_ROUTE_VERSION;
  transport: string;
  profile_id: string;
  profile_revision: string;
  controller_session_id: string;
  capabilities?: CallbackRouteCapabilitiesV1;
}

export type CallbackEnvelopeSourceV1 =
  | {
      kind: "managed_turn";
      session_id: string;
      turn_id: string;
      conversation_id: string;
    }
  | {
      kind: "terminal_watch";
      watch_id: string;
      terminal_id: string;
    };

export interface CallbackEnvelopeEventV1 {
  id: string;
  type: string;
  body: string;
  requires_response: boolean;
  metadata?: Record<string, unknown>;
}

export interface CallbackEnvelopeRouteV1 {
  transport: string;
  profile_id: string;
  profile_revision: string;
  controller_session_id: string;
}

/** Canonical host-neutral payload persisted before transport delivery. */
export interface CallbackEnvelopeV1 {
  schema: typeof CALLBACK_ENVELOPE_SCHEMA;
  version: typeof CALLBACK_ENVELOPE_VERSION;
  delivery_id: string;
  idempotency_key: string;
  route: CallbackEnvelopeRouteV1;
  source: CallbackEnvelopeSourceV1;
  event: CallbackEnvelopeEventV1;
}

export type CallbackAttemptOutcome =
  | {
      disposition: "accepted";
      accepted_at: string;
      acceptance_id: string;
      evidence?: Record<string, unknown>;
    }
  | {
      disposition: "retryable_failure";
      error_code: string;
      evidence?: Record<string, unknown>;
    }
  | {
      disposition: "permanent_failure";
      error_code: string;
      evidence?: Record<string, unknown>;
    }
  | {
      disposition: "uncertain";
      error_code: string;
      observed_at: string;
      evidence?: Record<string, unknown>;
    };

export interface CallbackTransportAttemptV1 {
  number: number;
  id: string;
}

/**
 * Trusted in-process compatibility context. It is not part of the canonical
 * envelope, must not be persisted, and must never be exposed to a model.
 */
export interface CallbackTransportContextV1 {
  statePath?: string;
  logPath?: string;
  conversation?: unknown;
  message?: unknown;
  legacyOptions?: Record<string, unknown>;
}

export interface CallbackTransportDeliverInput {
  route: CallbackRouteV1;
  envelope: CallbackEnvelopeV1;
  attempt: CallbackTransportAttemptV1;
  context?: CallbackTransportContextV1;
  reportCheckpoint?(outcome: CallbackAttemptOutcome): void;
}

/**
 * One bounded, non-throwing attempt; retry/lease policy remains owned by the
 * AKK outbox. A transport must convert every expected delivery failure into a
 * typed outcome. The caller treats an unexpected throw or malformed return as
 * uncertain because a side effect may already have happened.
 */
export interface CallbackTransport {
  readonly kind: string;
  deliver(input: CallbackTransportDeliverInput): CallbackAttemptOutcome;
}

export interface LegacyOpenClawCallbackRouteInput {
  controllerSessionId: unknown;
  gatewayMethod?: unknown;
  openclawBin?: unknown;
  gatewayUrl?: unknown;
}

export interface CallbackRouteCandidate {
  callbackRoute?: unknown;
  legacyOpenClaw?: LegacyOpenClawCallbackRouteInput;
}

export interface CreateCallbackEnvelopeInput {
  route: CallbackRouteV1;
  source: CallbackEnvelopeSourceV1;
  event: CallbackEnvelopeEventV1;
  deliveryId?: string;
  idempotencyKey?: string;
}

export function parseCallbackRoute(value: unknown): CallbackRouteV1 {
  if (!isRecord(value)) {
    throw new Error("callback_route must be an object");
  }
  assertOnlyKeys(value, [
    "schema",
    "version",
    "transport",
    "profile_id",
    "profile_revision",
    "controller_session_id",
    "capabilities"
  ], "callback_route");
  if (value.schema !== CALLBACK_ROUTE_SCHEMA) {
    throw new Error(
      `callback_route schema must be ${CALLBACK_ROUTE_SCHEMA}`
    );
  }
  if (value.version !== CALLBACK_ROUTE_VERSION) {
    throw new Error(
      `unsupported callback_route version ${String(value.version)}`
    );
  }
  const transport = requiredRouteString(value.transport, "transport");
  const profileId = requiredRouteString(value.profile_id, "profile_id");
  const profileRevision = requiredRouteString(
    value.profile_revision,
    "profile_revision"
  );
  const controllerSessionId = requiredRouteString(
    value.controller_session_id,
    "controller_session_id"
  );
  const capabilities = parseRouteCapabilities(value.capabilities);
  return {
    schema: CALLBACK_ROUTE_SCHEMA,
    version: CALLBACK_ROUTE_VERSION,
    transport,
    profile_id: profileId,
    profile_revision: profileRevision,
    controller_session_id: controllerSessionId,
    ...(capabilities ? { capabilities } : {})
  };
}

/**
 * Resolve candidates in explicit priority order. A present generic route is
 * authoritative: malformed data throws and never falls back to a legacy host.
 */
export function resolveCallbackRoute(
  ...candidates: CallbackRouteCandidate[]
): CallbackRouteV1 | undefined {
  for (const candidate of candidates) {
    if (Object.hasOwn(candidate, "callbackRoute")) {
      return parseCallbackRoute(candidate.callbackRoute);
    }
    if (candidate.legacyOpenClaw !== undefined) {
      return createLegacyOpenClawCallbackRoute(candidate.legacyOpenClaw);
    }
  }
  return undefined;
}

export function hasCallbackRoute(
  ...candidates: CallbackRouteCandidate[]
): boolean {
  return resolveCallbackRoute(...candidates) !== undefined;
}

export function callbackEnvelopeMatchesRoute(
  envelope: CallbackEnvelopeV1,
  route: CallbackRouteV1
): boolean {
  return envelope.route.transport === route.transport &&
    envelope.route.profile_id === route.profile_id &&
    envelope.route.profile_revision === route.profile_revision &&
    envelope.route.controller_session_id === route.controller_session_id;
}

export function createLegacyOpenClawCallbackRoute(
  input: LegacyOpenClawCallbackRouteInput
): CallbackRouteV1 {
  const controllerSessionId = requiredRouteString(
    input.controllerSessionId,
    "legacy OpenClaw controller session"
  );
  const gatewayMethod = requiredRouteString(
    input.gatewayMethod,
    "legacy OpenClaw gateway method"
  );
  const openclawBin = nonBlankString(input.openclawBin) ?? "openclaw";
  const gatewayUrl = nonBlankString(input.gatewayUrl);
  const revision = createHash("sha256")
    .update(canonicalJson({
      transport: "openclaw_gateway_v1",
      gateway_method: gatewayMethod,
      openclaw_bin: openclawBin,
      gateway_url: gatewayUrl
    }))
    .digest("hex");
  return {
    schema: CALLBACK_ROUTE_SCHEMA,
    version: CALLBACK_ROUTE_VERSION,
    transport: "openclaw_gateway_v1",
    profile_id: "legacy-openclaw-cli",
    profile_revision: `sha256:${revision}`,
    controller_session_id: controllerSessionId,
    capabilities: { wake: true, respond: true }
  };
}

export function createCallbackEnvelope(
  input: CreateCallbackEnvelopeInput
): CallbackEnvelopeV1 {
  const route = parseCallbackRoute(input.route);
  const source = parseEnvelopeSource(input.source);
  const event = parseEnvelopeEvent(input.event);
  const identity = {
    version: CALLBACK_ENVELOPE_VERSION,
    route: envelopeRoute(route),
    source,
    event
  };
  const digest = createHash("sha256")
    .update(canonicalJson(identity))
    .digest("hex");
  return {
    schema: CALLBACK_ENVELOPE_SCHEMA,
    version: CALLBACK_ENVELOPE_VERSION,
    delivery_id: nonBlankString(input.deliveryId) ??
      `callback-delivery-${digest}`,
    idempotency_key: nonBlankString(input.idempotencyKey) ??
      `agent-knock-knock:${digest}`,
    route: envelopeRoute(route),
    source,
    event
  };
}

export function parseCallbackAttemptOutcome(
  value: unknown
): CallbackAttemptOutcome {
  if (!isRecord(value)) {
    throw new Error("callback attempt outcome must be an object");
  }
  const disposition = nonBlankString(value.disposition);
  const evidence = parseOutcomeEvidence(value.evidence);
  if (disposition === "accepted") {
    assertOnlyKeys(value, [
      "disposition",
      "accepted_at",
      "acceptance_id",
      "evidence"
    ], "callback accepted outcome");
    return {
      disposition,
      accepted_at: requiredRouteString(value.accepted_at, "accepted_at"),
      acceptance_id: requiredRouteString(
        value.acceptance_id,
        "acceptance_id"
      ),
      ...(evidence ? { evidence } : {})
    };
  }
  if (
    disposition === "retryable_failure" ||
    disposition === "permanent_failure"
  ) {
    assertOnlyKeys(value, [
      "disposition",
      "error_code",
      "evidence"
    ], `callback ${disposition} outcome`);
    return {
      disposition,
      error_code: requiredRouteString(value.error_code, "error_code"),
      ...(evidence ? { evidence } : {})
    };
  }
  if (disposition === "uncertain") {
    assertOnlyKeys(value, [
      "disposition",
      "error_code",
      "observed_at",
      "evidence"
    ], "callback uncertain outcome");
    return {
      disposition,
      error_code: requiredRouteString(value.error_code, "error_code"),
      observed_at: requiredRouteString(value.observed_at, "observed_at"),
      ...(evidence ? { evidence } : {})
    };
  }
  throw new Error(
    `unsupported callback attempt disposition ${JSON.stringify(disposition)}`
  );
}

function envelopeRoute(route: CallbackRouteV1): CallbackEnvelopeRouteV1 {
  return {
    transport: route.transport,
    profile_id: route.profile_id,
    profile_revision: route.profile_revision,
    controller_session_id: route.controller_session_id
  };
}

function parseEnvelopeSource(value: unknown): CallbackEnvelopeSourceV1 {
  if (!isRecord(value)) {
    throw new Error("callback envelope source must be an object");
  }
  if (value.kind === "managed_turn") {
    return {
      kind: "managed_turn",
      session_id: requiredRouteString(value.session_id, "source.session_id"),
      turn_id: requiredRouteString(value.turn_id, "source.turn_id"),
      conversation_id: requiredRouteString(
        value.conversation_id,
        "source.conversation_id"
      )
    };
  }
  if (value.kind === "terminal_watch") {
    return {
      kind: "terminal_watch",
      watch_id: requiredRouteString(value.watch_id, "source.watch_id"),
      terminal_id: requiredRouteString(value.terminal_id, "source.terminal_id")
    };
  }
  throw new Error(
    `unsupported callback envelope source ${JSON.stringify(value.kind)}`
  );
}

function parseEnvelopeEvent(value: unknown): CallbackEnvelopeEventV1 {
  if (!isRecord(value)) {
    throw new Error("callback envelope event must be an object");
  }
  if (typeof value.requires_response !== "boolean") {
    throw new Error("callback envelope event.requires_response must be boolean");
  }
  const metadata = value.metadata === undefined
    ? undefined
    : recordValue(value.metadata);
  if (value.metadata !== undefined && !metadata) {
    throw new Error("callback envelope event.metadata must be an object");
  }
  return {
    id: requiredRouteString(value.id, "event.id"),
    type: requiredRouteString(value.type, "event.type"),
    body: typeof value.body === "string"
      ? value.body
      : requiredRouteString(value.body, "event.body"),
    requires_response: value.requires_response,
    ...(metadata ? { metadata } : {})
  };
}

function parseRouteCapabilities(
  value: unknown
): CallbackRouteCapabilitiesV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("callback_route capabilities must be an object");
  }
  assertOnlyKeys(value, ["wake", "respond"], "callback_route capabilities");
  if (value.wake !== undefined && typeof value.wake !== "boolean") {
    throw new Error("callback_route capabilities.wake must be boolean");
  }
  if (value.respond !== undefined && typeof value.respond !== "boolean") {
    throw new Error("callback_route capabilities.respond must be boolean");
  }
  return {
    ...(typeof value.wake === "boolean" ? { wake: value.wake } : {}),
    ...(typeof value.respond === "boolean" ? { respond: value.respond } : {})
  };
}

function parseOutcomeEvidence(
  value: unknown
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const evidence = recordValue(value);
  if (!evidence) {
    throw new Error("callback attempt outcome evidence must be an object");
  }
  return evidence;
}

function requiredRouteString(value: unknown, field: string): string {
  const parsed = nonBlankString(value);
  if (!parsed) {
    throw new Error(`callback ${field} must be a non-empty string`);
  }
  return parsed;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} contains unsupported fields: ${unexpected.sort().join(", ")}`
    );
  }
}
