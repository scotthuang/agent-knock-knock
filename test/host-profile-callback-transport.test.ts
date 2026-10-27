import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createCallbackEnvelope,
  createLegacyOpenClawCallbackRoute,
  type CallbackAttemptOutcome,
  type CallbackRouteV1,
  type CallbackTransport,
  type CallbackTransportDeliverInput
} from "../src/callback-transport.js";
import {
  HOST_PROFILE_CALLBACK_ROUTER_KIND,
  createHostProfileCallbackTransport,
  hostProfileCallbackRouteMatchesRuntime,
  type HostProfileCallbackTransport
} from "../src/host-profile-callback-transport.js";
import { AKK_HOST_PROFILE_CALLBACK_RECOVERY, AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT,
  createHostProfileCallbackRecoveryCatalog, hostProfileCallbackRecoveryFingerprint
} from "../src/host-profile-callback-recovery.js";
import {
  AKK_HOST_PROFILE_FINGERPRINT,
  AKK_HOST_PROFILE_HOST,
  AKK_HOST_PROFILE_HOST_VERSION,
  AKK_HOST_PROFILE_SELECTION,
  AKK_HOST_PROFILE_SOURCE,
  createTrustedHostProfileRuntime,
  hostProfileRelayEnvironment,
  trustedHostProfileRuntimeFromEnvironment,
  type TrustedHostProfileRuntimeV1
} from "../src/host-profile-runtime.js";

const NOW = new Date("2026-08-25T18:30:00.000Z");
const HOST_ID = "fixture-host";
const HOST_VERSION = "1.4.0";
const SESSION_VARIABLE = "FIXTURE_CONTROLLER_SESSION";
const SESSION_ID = "controller-session-command-json";
const CALLBACK_TOKEN = "trusted-callback-token";

interface CallbackFixture {
  readonly root: string;
  readonly profilePath: string;
  readonly runtime: TrustedHostProfileRuntimeV1;
  readonly relayEnvironment: NodeJS.ProcessEnv;
}

function createCallbackFixture(
  t: TestContext,
  controllerScope?: "startup_v1" | "route_bound_v1"
): CallbackFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-profile-callback-"));
  const executable = path.join(root, "callback-driver");
  const profilePath = path.join(root, "host-profile.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(executable, [
    `#!${process.execPath}`,
    "let body = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { body += chunk; });",
    "process.stdin.on('end', () => {",
    "  const [sessionId, deliveryId, messageId] = process.argv.slice(2);",
    "  const acceptanceId = [",
    "    process.env.FIXTURE_CALLBACK_TOKEN,",
    "    sessionId,",
    "    body",
    "  ].join(':');",
    "  process.stdout.write(JSON.stringify({",
    "    status: 'accepted',",
    "    acceptance_id: acceptanceId,",
    "    delivery_id: deliveryId,",
    "    message_id: messageId",
    "  }));",
    "});"
  ].join("\n"));
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(profilePath, JSON.stringify({
    $schema: "https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/schemas/host-profile-v1.schema.json",
    schema: "agent-knock-knock/host-profile",
    version: 1,
    id: "fixture-command-profile",
    revision: "revision-1",
    compatibility: {
      host: HOST_ID,
      range: ">=1.0.0 <2.0.0"
    },
    controllerContext: {
      driver: "environment_v1",
      sessionIdVariable: SESSION_VARIABLE,
      ...(controllerScope === undefined ? {} : { scope: controllerScope })
    },
    callback: {
      driver: "command_json_v1",
      executable,
      arguments: [
        "${controller.session_id}",
        "${envelope.delivery_id}",
        "${envelope.message_id}"
      ],
      stdin: "${envelope.body}",
      environment: { allow: ["FIXTURE_CALLBACK_TOKEN"] },
      timeoutMs: 5_000,
      maxOutputBytes: 16_384,
      acknowledgement: {
        disposition: {
          jsonPointer: "/status",
          mapping: { accepted: "accepted" }
        },
        acceptanceId: { jsonPointer: "/acceptance_id" },
        acknowledgedDeliveryId: { jsonPointer: "/delivery_id" },
        acknowledgedMessageId: { jsonPointer: "/message_id" }
      }
    }
  }));

  const runtime = createTrustedHostProfileRuntime({
    selection: profilePath,
    cwd: root,
    host: HOST_ID,
    hostVersion: HOST_VERSION,
    environment: { [SESSION_VARIABLE]: SESSION_ID }
  });
  const relayEnvironment = hostProfileRelayEnvironment(runtime, {
    [SESSION_VARIABLE]: SESSION_ID,
    FIXTURE_CALLBACK_TOKEN: CALLBACK_TOKEN,
    MUST_NOT_REACH_CALLBACK: "secret"
  });
  return { root, profilePath, runtime, relayEnvironment };
}

function deliveryInput(route: CallbackRouteV1): CallbackTransportDeliverInput {
  return {
    route,
    envelope: createCallbackEnvelope({
      route,
      deliveryId: "delivery-232",
      idempotencyKey: "idempotency-232",
      source: {
        kind: "managed_turn",
        session_id: "managed-session-232",
        turn_id: "managed-turn-232",
        conversation_id: "managed-turn-232"
      },
      event: {
        id: "message-232",
        type: "completed",
        body: "body-232",
        requires_response: false
      }
    }),
    attempt: { number: 1, id: "attempt-232" }
  };
}

function callbackRouter(
  fixture: CallbackFixture,
  environment: () => NodeJS.ProcessEnv,
  legacyTransport?: CallbackTransport
): HostProfileCallbackTransport {
  return createHostProfileCallbackTransport({
    legacyTransport: legacyTransport ?? {
      kind: "openclaw_gateway_v1",
      deliver: () => ({
        disposition: "permanent_failure",
        error_code: "legacy-transport-not-expected"
      })
    },
    environment,
    cwd: fixture.root,
    now: () => NOW
  });
}

test("the callback router delegates the legacy transport and input exactly", (t) => {
  const fixture = createCallbackFixture(t);
  const route = createLegacyOpenClawCallbackRoute({
    controllerSessionId: "legacy-controller-session",
    gatewayMethod: "agent.callback",
    openclawBin: "/opt/openclaw/bin/openclaw"
  });
  const input = deliveryInput(route);
  const expected: CallbackAttemptOutcome = {
    disposition: "retryable_failure",
    error_code: "legacy-result"
  };
  let received: CallbackTransportDeliverInput | undefined;
  const legacyTransport: CallbackTransport = {
    kind: route.transport,
    deliver(candidate) {
      received = candidate;
      return expected;
    }
  };
  const router = callbackRouter(fixture, () => {
    throw new Error("legacy routing must not inspect Host Profile markers");
  }, legacyTransport);

  assert.equal(router.kind, HOST_PROFILE_CALLBACK_ROUTER_KIND);
  assert.strictEqual(router.deliver(input), expected);
  assert.strictEqual(received, input);
});

test("command_json_v1 executes the exact selected Profile and accepts its acknowledgement", (t) => {
  const fixture = createCallbackFixture(t);
  const router = callbackRouter(fixture, () => fixture.relayEnvironment);

  assert.deepEqual(router.deliver(deliveryInput(fixture.runtime.callbackRoute)), {
    disposition: "accepted",
    accepted_at: NOW.toISOString(),
    acceptance_id: `${CALLBACK_TOKEN}:${SESSION_ID}:body-232`,
    evidence: {
      transport: "command_json_v1",
      process_status: 0
    }
  });
});

test("route_bound_v1 executes against the persisted route controller session", (t) => {
  const fixture = createCallbackFixture(t, "route_bound_v1");
  const routeSessionId = "controller-session-from-persisted-route";
  const route = {
    ...fixture.runtime.callbackRoute,
    controller_session_id: routeSessionId
  };
  const router = callbackRouter(fixture, () => fixture.relayEnvironment);

  assert.deepEqual(router.deliver(deliveryInput(route)), {
    disposition: "accepted",
    accepted_at: NOW.toISOString(),
    acceptance_id: `${CALLBACK_TOKEN}:${routeSessionId}:body-232`,
    evidence: {
      transport: "command_json_v1",
      process_status: 0
    }
  });
});

test("command_json_v1 fails closed for missing or altered runtime markers", (t) => {
  const fixture = createCallbackFixture(t);
  const incomplete = { ...fixture.relayEnvironment };
  delete incomplete[AKK_HOST_PROFILE_FINGERPRINT];
  const changedFingerprint = {
    ...fixture.relayEnvironment,
    [AKK_HOST_PROFILE_FINGERPRINT]: `sha256:${"0".repeat(64)}`
  };
  const changedSelection = {
    ...fixture.relayEnvironment,
    [AKK_HOST_PROFILE_SELECTION]: path.join(fixture.root, "missing.json")
  };

  const cases: Array<{
    readonly label: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly errorCode: string;
  }> = [
    {
      label: "no Bridge runtime",
      environment: {},
      errorCode: "host_profile_runtime_missing"
    },
    {
      label: "incomplete marker set",
      environment: incomplete,
      errorCode: "host_profile_runtime_invalid"
    },
    {
      label: "changed fingerprint marker",
      environment: changedFingerprint,
      errorCode: "host_profile_runtime_invalid"
    },
    {
      label: "changed Profile selection marker",
      environment: changedSelection,
      errorCode: "host_profile_runtime_invalid"
    }
  ];

  for (const fixtureCase of cases) {
    const router = callbackRouter(fixture, () => fixtureCase.environment);
    assert.deepEqual(
      router.deliver(deliveryInput(fixture.runtime.callbackRoute)),
      {
        disposition: "permanent_failure",
        error_code: fixtureCase.errorCode
      },
      fixtureCase.label
    );
  }

  // Sanity-check that all private startup marker fields are represented by
  // the environment under test; none may be silently optional.
  for (const marker of [
    AKK_HOST_PROFILE_SELECTION,
    AKK_HOST_PROFILE_SOURCE,
    AKK_HOST_PROFILE_FINGERPRINT,
    AKK_HOST_PROFILE_HOST,
    AKK_HOST_PROFILE_HOST_VERSION
  ]) {
    assert.equal(typeof fixture.relayEnvironment[marker], "string", marker);
  }
});

test("command_json_v1 rejects Profile, revision, and controller-session drift", (t) => {
  const fixture = createCallbackFixture(t);
  const cases: Array<{
    readonly label: string;
    readonly route: CallbackRouteV1;
    readonly environment: NodeJS.ProcessEnv;
  }> = [
    {
      label: "profile id",
      route: {
        ...fixture.runtime.callbackRoute,
        profile_id: "other-profile"
      },
      environment: fixture.relayEnvironment
    },
    {
      label: "profile revision",
      route: {
        ...fixture.runtime.callbackRoute,
        profile_revision: "revision-2"
      },
      environment: fixture.relayEnvironment
    },
    {
      label: "route controller session",
      route: {
        ...fixture.runtime.callbackRoute,
        controller_session_id: "other-controller-session"
      },
      environment: fixture.relayEnvironment
    },
    {
      label: "trusted environment controller session",
      route: fixture.runtime.callbackRoute,
      environment: {
        ...fixture.relayEnvironment,
        [SESSION_VARIABLE]: "other-controller-session"
      }
    }
  ];

  for (const fixtureCase of cases) {
    const router = callbackRouter(fixture, () => fixtureCase.environment);
    assert.deepEqual(router.deliver(deliveryInput(fixtureCase.route)), {
      disposition: "permanent_failure",
      error_code: "host_profile_callback_route_mismatch"
    }, fixtureCase.label);
  }
});

test("the callback router rejects unknown transports without consulting a Profile", (t) => {
  const fixture = createCallbackFixture(t);
  const unknownRoute: CallbackRouteV1 = {
    ...fixture.runtime.callbackRoute,
    transport: "unknown_transport_v1"
  };
  let environmentReads = 0;
  const router = callbackRouter(fixture, () => {
    environmentReads += 1;
    return fixture.relayEnvironment;
  });

  assert.deepEqual(router.deliver(deliveryInput(unknownRoute)), {
    disposition: "permanent_failure",
    error_code: "unsupported_callback_transport"
  });
  assert.equal(environmentReads, 0);
});

function recoveryEnvironment(fixture: CallbackFixture, routes: readonly CallbackRouteV1[]) {
  const catalog = createHostProfileCallbackRecoveryCatalog({
    currentProfileFingerprint: fixture.runtime.selected.fingerprint,
    ownerScope: "verified-dsh-session-header", routes
  });
  const catalogPath = path.join(fixture.root, "callback-recovery.json");
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = { ...fixture.relayEnvironment,
    [AKK_HOST_PROFILE_CALLBACK_RECOVERY]: catalogPath,
    [AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT]: hostProfileCallbackRecoveryFingerprint(catalog) };
  return { catalog, catalogPath, environment };
}

test("explicit callback recovery delivers only authorized historical identities through current configuration", t => {
  const fixture = createCallbackFixture(t, "route_bound_v1");
  const original: CallbackRouteV1 = { ...fixture.runtime.callbackRoute,
    profile_revision: "historical-revision", controller_session_id: "historical-controller" };
  const input = deliveryInput(original), immutable = structuredClone(input);
  assert.equal(callbackRouter(fixture, () => fixture.relayEnvironment).deliver(input).disposition, "permanent_failure");
  const recovery = recoveryEnvironment(fixture, [original]);
  recovery.environment.FIXTURE_CALLBACK_TOKEN = "current-host-token";
  const router = callbackRouter(fixture, () => recovery.environment);
  assert.equal(router.canDeliver(original), true);
  const delivered = router.deliver(input);
  assert.equal(delivered.disposition, "accepted");
  assert.equal(delivered.acceptance_id, "current-host-token:historical-controller:body-232");
  assert.deepEqual(input, immutable, "route, envelope, delivery and idempotency identities stay immutable");
  assert.equal(router.canDeliver({ ...original, controller_session_id: "another-controller" }), false);
  assert.equal(router.canDeliver({ ...original, profile_revision: "another-revision" }), false);
  assert.equal(router.canDeliver(createLegacyOpenClawCallbackRoute({ controllerSessionId: "foreign", gatewayMethod: "agent-knock-knock.callback" })), false);
  assert.equal(router.deliver(deliveryInput({ ...original, controller_session_id: "another-controller" })).disposition, "permanent_failure");
  const runtime = trustedHostProfileRuntimeFromEnvironment(recovery.environment)!;
  assert.equal(hostProfileCallbackRouteMatchesRuntime({ ...original, capabilities: { wake: true, respond: false } }, runtime), true);
  assert.equal(hostProfileCallbackRouteMatchesRuntime(original, { ...runtime,
    recoveryRoutes: [{ ...original, capabilities: { wake: true, respond: false } }] }), false);
  assert.equal(hostProfileCallbackRouteMatchesRuntime(original, { ...runtime, recoveryRoutes: [] }), false);
});

test("callback recovery catalogues reject tampering, cross-Profile authority and executable configuration", t => {
  const fixture = createCallbackFixture(t, "route_bound_v1");
  const original = { ...fixture.runtime.callbackRoute, profile_revision: "old-revision" };
  const recovery = recoveryEnvironment(fixture, [original]);
  const failures: Array<{ name: string; environment?: NodeJS.ProcessEnv; content?: unknown; hashContent?: boolean }> = [
    { name: "partial markers", environment: { ...recovery.environment, [AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT]: undefined } },
    { name: "wrong file hash", environment: { ...recovery.environment, [AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT]: `sha256:${"0".repeat(64)}` } },
    { name: "changed content", content: { ...recovery.catalog, owner_scope: "another-owner" } },
    { name: "different current Profile", content: { ...recovery.catalog, current_profile_fingerprint: `sha256:${"1".repeat(64)}` }, hashContent: true },
    { name: "different route Profile", content: { ...recovery.catalog, routes: [{ ...original, profile_id: "other-profile" }] }, hashContent: true },
    { name: "different transport", content: { ...recovery.catalog, routes: [{ ...original, transport: "openclaw_gateway_v1" }] }, hashContent: true },
    { name: "historical executable injection", content: { ...recovery.catalog, callback: { executable: "/untrusted/historical-helper" } } },
    { name: "missing binding evidence", content: { ...recovery.catalog, owner_scope: "" } },
    { name: "duplicate exact routes", content: { ...recovery.catalog, routes: [original, original] } }
  ];
  for (const failure of failures) {
    fs.writeFileSync(recovery.catalogPath, JSON.stringify(failure.content ?? recovery.catalog));
    const environment = { ...failure.environment ?? recovery.environment };
    if (failure.hashContent) environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT] =
      hostProfileCallbackRecoveryFingerprint(failure.content as typeof recovery.catalog);
    const router = callbackRouter(fixture, () => environment);
    assert.equal(router.canDeliver(original), false, failure.name);
    assert.deepEqual(router.deliver(deliveryInput(original)), {
      disposition: "permanent_failure", error_code: "host_profile_runtime_invalid"
    }, failure.name);
  }
  const empty = recoveryEnvironment(fixture, []);
  const router = callbackRouter(fixture, () => empty.environment);
  assert.equal(router.deliver(deliveryInput(fixture.runtime.callbackRoute)).disposition, "accepted");
  assert.equal(router.deliver(deliveryInput(original)).disposition, "permanent_failure");
  assert.equal(callbackRouter(fixture, () => fixture.relayEnvironment).canDeliver(original), true,
    "without opt-in, outbox eligibility keeps its existing default while delivery remains strict");
  fs.chmodSync(empty.catalogPath, 0o644);
  assert.equal(router.canDeliver(fixture.runtime.callbackRoute), false, "a readable-by-others catalogue is not private authority");
  assert.equal(router.deliver(deliveryInput(fixture.runtime.callbackRoute)).disposition, "permanent_failure");
  fs.chmodSync(empty.catalogPath, 0o600);
  const target = `${empty.catalogPath}.private`;
  fs.renameSync(empty.catalogPath, target);
  fs.symlinkSync(target, empty.catalogPath);
  assert.equal(router.canDeliver(fixture.runtime.callbackRoute), false, "a symlink cannot redirect the trusted catalogue path");
  assert.deepEqual(router.deliver(deliveryInput(fixture.runtime.callbackRoute)), {
    disposition: "permanent_failure", error_code: "host_profile_runtime_invalid"
  });
});
