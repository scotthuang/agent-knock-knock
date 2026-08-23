import assert from "node:assert/strict";
import test from "node:test";

import {
  callbackExpectedForConversation,
  callbackExpectedForConversationWithLegacyFallback,
  callbackExpectedForPrimaryOutbox,
  callbackRouteFingerprint,
  callbackRouteFingerprintFromRecord,
  callbackRouteFingerprintLedgerFields,
  callbackRouteForConversation,
  callbackRouteForPrimaryOutbox,
  resolveCallbackRouteAuthority
} from "../src/callback-route-authority.js";
import {
  CALLBACK_ROUTE_SCHEMA,
  CALLBACK_ROUTE_VERSION,
  type CallbackRouteV1
} from "../src/callback-transport.js";
import { createConversation } from "../src/protocol.js";

const GENERIC_ROUTE: CallbackRouteV1 = {
  schema: CALLBACK_ROUTE_SCHEMA,
  version: CALLBACK_ROUTE_VERSION,
  transport: "exec_v1",
  profile_id: "trusted-harness",
  profile_revision: "sha256:revision-a",
  controller_session_id: "harness-session-a",
  capabilities: { wake: true, respond: true }
};

const OUTBOX_ROUTE: CallbackRouteV1 = {
  ...GENERIC_ROUTE,
  profile_revision: "sha256:revision-outbox",
  controller_session_id: "harness-session-outbox"
};

test("callback route fingerprint is canonical and route-sensitive", () => {
  const reordered = {
    capabilities: { respond: true, wake: true },
    controller_session_id: GENERIC_ROUTE.controller_session_id,
    profile_revision: GENERIC_ROUTE.profile_revision,
    profile_id: GENERIC_ROUTE.profile_id,
    transport: GENERIC_ROUTE.transport,
    version: GENERIC_ROUTE.version,
    schema: GENERIC_ROUTE.schema
  };
  const fingerprint = callbackRouteFingerprint(GENERIC_ROUTE);
  assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(callbackRouteFingerprint(reordered), fingerprint);
  assert.notEqual(callbackRouteFingerprint(OUTBOX_ROUTE), fingerprint);
});

test("durable route authority distinguishes hash, explicit null, and legacy absence", () => {
  const fingerprint = callbackRouteFingerprint(GENERIC_ROUTE);
  assert.equal(callbackRouteFingerprintFromRecord({
    callback_route_fingerprint: fingerprint
  }), fingerprint);
  assert.equal(callbackRouteFingerprintFromRecord({
    callback_route_fingerprint: null
  }), null);
  assert.equal(callbackRouteFingerprintFromRecord({}), undefined);
  assert.throws(() => callbackRouteFingerprintFromRecord({
    callback_route_fingerprint: "sha256:not-valid"
  }), /callback_route_fingerprint authority is invalid/u);
  assert.throws(() => callbackRouteFingerprintFromRecord({
    callback_route_fingerprint: undefined
  }), /callback_route_fingerprint authority is invalid/u);
});

test("ledger projection upgrades legacy absence but rejects declared redirects", () => {
  const fingerprint = callbackRouteFingerprint(GENERIC_ROUTE);
  assert.deepEqual(callbackRouteFingerprintLedgerFields({
    receipt: { callback_route_fingerprint: fingerprint },
    ledger: {},
    context: "test acceptance"
  }), { callback_route_fingerprint: fingerprint });
  assert.deepEqual(callbackRouteFingerprintLedgerFields({
    receipt: { callback_route_fingerprint: null },
    ledger: {},
    context: "test acceptance"
  }), { callback_route_fingerprint: null });
  assert.deepEqual(callbackRouteFingerprintLedgerFields({
    receipt: {},
    ledger: {},
    context: "legacy acceptance"
  }), {});
  assert.throws(() => callbackRouteFingerprintLedgerFields({
    receipt: { callback_route_fingerprint: fingerprint },
    ledger: { callback_route_fingerprint: null },
    context: "test acceptance"
  }), /test acceptance callback route conflicts with its dispatch ledger/u);
  assert.throws(() => callbackRouteFingerprintLedgerFields({
    receipt: {},
    ledger: { callback_route_fingerprint: fingerprint },
    context: "legacy acceptance"
  }), /legacy acceptance callback route conflicts with its dispatch ledger/u);
});

test("generic Conversation route is authoritative over valid legacy fields", () => {
  const route = callbackRouteForConversation({
    callback_route: GENERIC_ROUTE,
    gateway_method: "agent-knock-knock.callback",
    gateway_session: "agent:legacy:session"
  });

  assert.deepEqual(route, GENERIC_ROUTE);
  assert.equal(callbackExpectedForConversation({
    callback_route: GENERIC_ROUTE,
    gateway_method: "agent-knock-knock.callback",
    gateway_session: "agent:legacy:session"
  }), true);
});

test("present malformed generic route fails closed without legacy fallback", () => {
  assert.throws(() => callbackRouteForConversation({
    callback_route: {
      ...GENERIC_ROUTE,
      controller_session_id: " "
    },
    gateway_method: "agent-knock-knock.callback",
    gateway_session: "agent:legacy:session"
  }), /controller_session_id must be a non-empty string/u);

  assert.throws(() => callbackRouteForConversation({
    callback_route: undefined,
    gateway_method: "agent-knock-knock.callback",
    gateway_session: "agent:legacy:session"
  }), /callback_route must be an object/u);

  assert.throws(() => callbackRouteForConversation({
    callback_route: {
      ...GENERIC_ROUTE,
      token: "must-never-be-a-route-field"
    },
    gateway_method: "agent-knock-knock.callback",
    gateway_session: "agent:legacy:session"
  }), /unsupported fields: token/u);
});

test("legacy authority requires both non-blank method and controller session", () => {
  assert.equal(callbackRouteForConversation({
    gateway_method: " ",
    gateway_session: "agent:legacy:session"
  }), undefined);
  assert.equal(callbackRouteForConversation({
    gateway_method: "agent-knock-knock.callback"
  }), undefined);
  assert.equal(callbackExpectedForConversation({
    gateway_method: "agent-knock-knock.callback",
    gateway_session: " "
  }), false);

  const route = callbackRouteForConversation({
    gateway_method: "agent-knock-knock.callback",
    openclaw_session: "agent:legacy:session"
  });
  assert.equal(route?.transport, "openclaw_gateway_v1");
  assert.equal(route?.controller_session_id, "agent:legacy:session");
});

test("legacy ledger fallback applies only without a route declaration", () => {
  assert.equal(callbackExpectedForConversationWithLegacyFallback({}, true), true);
  assert.equal(callbackExpectedForConversationWithLegacyFallback({
    gateway_method: "agent-knock-knock.callback"
  }, true), false);
  assert.throws(() => callbackExpectedForConversationWithLegacyFallback({
    callback_route: undefined
  }, true), /callback_route must be an object/u);
});

test("primary outbox generic snapshot precedes the Conversation route", () => {
  const conversation = createConversation({
    userRequest: "test",
    openclawSession: "agent:legacy:session"
  });
  conversation.callback_route = GENERIC_ROUTE;
  conversation.callback_delivery = {
    callback_route: OUTBOX_ROUTE,
    status: "pending"
  };

  assert.deepEqual(callbackRouteForPrimaryOutbox(conversation), OUTBOX_ROUTE);
  assert.equal(callbackExpectedForPrimaryOutbox(conversation), true);
});

test("invalid primary outbox snapshot fails closed before Conversation fallback", () => {
  assert.throws(() => resolveCallbackRouteAuthority({
    primaryOutbox: {
      callback_route: { ...OUTBOX_ROUTE, version: 99 }
    },
    conversation: { callback_route: GENERIC_ROUTE }
  }), /unsupported callback_route version 99/u);
});

test("primary outbox legacy snapshot precedes the Conversation generic route", () => {
  const route = resolveCallbackRouteAuthority({
    primaryOutbox: {
      gateway_method: "agent-knock-knock.callback",
      gateway_session: "agent:legacy:outbox"
    },
    conversation: { callback_route: GENERIC_ROUTE }
  });
  assert.equal(route?.transport, "openclaw_gateway_v1");
  assert.equal(route?.controller_session_id, "agent:legacy:outbox");
});

test("legacy primary outbox uses its route and Conversation fallback fields", () => {
  const conversation = createConversation({
    userRequest: "test",
    openclawSession: "agent:conversation:session"
  });
  conversation.gateway_method = "conversation.callback";
  conversation.gateway_session = "agent:conversation:session";
  conversation.callback_delivery = {
    gateway_method: "outbox.callback",
    openclaw_bin: "/opt/openclaw"
  };

  const route = callbackRouteForPrimaryOutbox(conversation);
  assert.equal(route?.transport, "openclaw_gateway_v1");
  assert.equal(route?.controller_session_id, "agent:conversation:session");
  assert.equal(callbackExpectedForPrimaryOutbox(conversation), true);
  assert.notEqual(
    route?.profile_revision,
    callbackRouteForConversation(conversation)?.profile_revision
  );
});

test("legacy outbox without a provable controller session does not redirect", () => {
  assert.equal(resolveCallbackRouteAuthority({
    primaryOutbox: {
      gateway_method: "outbox.callback"
    },
    conversation: { callback_route: GENERIC_ROUTE }
  }), undefined);
});
