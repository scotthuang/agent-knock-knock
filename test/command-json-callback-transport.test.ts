import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
  createCommandJsonCallbackTransport,
  type CommandJsonSpawnOptions,
  type CommandJsonSpawnResult
} from "../src/command-json-callback-transport.js";
import {
  CALLBACK_ROUTE_SCHEMA,
  CALLBACK_ROUTE_VERSION,
  createCallbackEnvelope,
  type CallbackRouteV1,
  type CallbackTransportDeliverInput
} from "../src/callback-transport.js";
import type { HostProfileV1 } from "../src/host-profile.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const CONTROLLER_SESSION_ID = "controller-session-1";

function profile(input: {
  arguments?: string[];
  executable?: string;
  stdin?: string;
  environmentVariables?: string[];
  acknowledgement?: Record<string, unknown>;
} = {}): HostProfileV1 {
  return {
    $schema: "https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/schemas/host-profile-v1.schema.json",
    schema: "agent-knock-knock/host-profile",
    version: 1,
    id: "fixture-command-profile",
    revision: "revision-1",
    compatibility: { host: "fixture-host", range: ">=1.0.0 <2.0.0" },
    controllerContext: {
      driver: "environment_v1",
      sessionIdVariable: "FIXTURE_SESSION_ID"
    },
    callback: {
      driver: COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
      executable: input.executable ?? "/opt/fixture-host/bin/inject",
      arguments: input.arguments ?? [
        "--session",
        "${controller.session_id}",
        "--delivery",
        "${envelope.delivery_id}",
      "--message",
      "${envelope.message_id}",
      "--idempotency-key",
      "${envelope.idempotency_key}",
      "--json"
    ],
    stdin: input.stdin ?? "${envelope.body}",
      environment: {
        allow: input.environmentVariables ?? ["ALLOWED_TOKEN"]
      },
      timeoutMs: 1_234,
      maxOutputBytes: 4_321,
      acknowledgement: input.acknowledgement ?? acknowledgementDefinition()
    }
  } as unknown as HostProfileV1;
}

function acknowledgementDefinition(): Record<string, unknown> {
  return {
    disposition: {
      jsonPointer: "/result/status",
      mapping: {
        accepted: "accepted",
        retry: "retryable_failure",
        rejected: "permanent_failure",
        unknown: "uncertain"
      }
    },
    acceptanceId: { jsonPointer: "/result/acceptance_id" },
    acknowledgedDeliveryId: { jsonPointer: "/request/delivery_id" },
    acknowledgedMessageId: { jsonPointer: "/request/message_id" }
  };
}

function route(overrides: Partial<CallbackRouteV1> = {}): CallbackRouteV1 {
  return {
    schema: CALLBACK_ROUTE_SCHEMA,
    version: CALLBACK_ROUTE_VERSION,
    transport: COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
    profile_id: "fixture-command-profile",
    profile_revision: "revision-1",
    controller_session_id: CONTROLLER_SESSION_ID,
    capabilities: { wake: true, respond: true },
    ...overrides
  };
}

function deliveryInput(
  callbackRoute = route(),
  overrides: Partial<CallbackTransportDeliverInput> = {}
): CallbackTransportDeliverInput {
  return {
    route: callbackRoute,
    envelope: createCallbackEnvelope({
      route: callbackRoute,
      deliveryId: "delivery-1",
      idempotencyKey: "idempotency-1",
      source: {
        kind: "managed_turn",
        session_id: "session-1",
        turn_id: "turn-1",
        conversation_id: "conversation-1"
      },
      event: {
        id: "message-1",
        type: "completed",
        body: "callback body; $(never execute)",
        requires_response: false
      }
    }),
    attempt: { number: 2, id: "attempt-2" },
    ...overrides
  };
}

function acknowledgement(
  status: "accepted" | "retry" | "rejected" | "unknown",
  overrides: {
    deliveryId?: string;
    messageId?: string;
    acceptanceId?: string;
    errorCode?: string;
  } = {}
): string {
  return JSON.stringify({
    result: {
      status,
      acceptance_id: overrides.acceptanceId ?? "host-message-1",
      accepted_at: NOW.toISOString(),
      error_code: overrides.errorCode ?? `host_${status}`
    },
    request: {
      delivery_id: overrides.deliveryId ?? "delivery-1",
      message_id: overrides.messageId ?? "message-1"
    }
  });
}

test("command_json_v1 delivers without a shell using only allowlisted context and environment", () => {
  const calls: Array<{
    executable: string;
    arguments_: string[];
    options: CommandJsonSpawnOptions;
  }> = [];
  const checkpoints: unknown[] = [];
  const transport = createCommandJsonCallbackTransport({
    profile: profile(),
    controllerSessionId: CONTROLLER_SESSION_ID,
    now: () => NOW,
    environment: () => ({
      ALLOWED_TOKEN: "allowed-value",
      SECRET_TOKEN: "must-not-leak",
      PATH: "/must/not/be/forwarded"
    }),
    spawnSync(executable, arguments_, options): CommandJsonSpawnResult {
      calls.push({ executable, arguments_, options });
      return {
        status: 7,
        stdout: acknowledgement("accepted"),
        stderr: "ignored after exact acknowledgement"
      };
    }
  });
  const request = deliveryInput(route(), {
    reportCheckpoint(value) {
      checkpoints.push(value);
    }
  });

  const outcome = transport.deliver(request);

  assert.deepEqual(outcome, {
    disposition: "accepted",
    accepted_at: NOW.toISOString(),
    acceptance_id: "host-message-1",
    evidence: {
      transport: COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
      process_status: 7
    }
  });
  assert.deepEqual(checkpoints, [outcome]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "/opt/fixture-host/bin/inject");
  assert.deepEqual(calls[0].arguments_, [
    "--session", CONTROLLER_SESSION_ID,
    "--delivery", "delivery-1",
    "--message", "message-1",
    "--idempotency-key", "idempotency-1",
    "--json"
  ]);
  assert.equal(calls[0].options.input, "callback body; $(never execute)");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 1_234);
  assert.equal(calls[0].options.maxBuffer, 4_321);
  assert.deepEqual(Object.entries(calls[0].options.env), [
    ["ALLOWED_TOKEN", "allowed-value"]
  ]);
});

test("command_json_v1 maps exact acknowledgements to every generic outcome", () => {
  const cases = [
    {
      host: "retry" as const,
      expected: {
        disposition: "retryable_failure",
        error_code: "command_json_callback_retryable_failure",
        evidence: {
          transport: COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
          process_status: 0
        }
      }
    },
    {
      host: "rejected" as const,
      expected: {
        disposition: "permanent_failure",
        error_code: "command_json_callback_permanent_failure",
        evidence: {
          transport: COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
          process_status: 0
        }
      }
    },
    {
      host: "unknown" as const,
      expected: {
        disposition: "uncertain",
        error_code: "command_json_callback_uncertain",
        observed_at: NOW.toISOString(),
        evidence: {
          transport: COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
          process_status: 0
        }
      }
    }
  ];

  for (const fixture of cases) {
    const transport = createCommandJsonCallbackTransport({
      profile: profile(),
      controllerSessionId: CONTROLLER_SESSION_ID,
      now: () => NOW,
      spawnSync: () => ({
        status: 0,
        stdout: acknowledgement(fixture.host),
        stderr: ""
      })
    });
    assert.deepEqual(transport.deliver(deliveryInput()), fixture.expected);
  }
});

test("command_json_v1 fails closed before spawn when route authority drifts", () => {
  const cases: Array<{
    route: CallbackRouteV1;
    errorCode: string;
  }> = [
    {
      route: route({ transport: "other_transport_v1" }),
      errorCode: "unsupported_callback_transport"
    },
    {
      route: route({ profile_id: "other-profile" }),
      errorCode: "command_json_callback_profile_mismatch"
    },
    {
      route: route({ profile_revision: "revision-2" }),
      errorCode: "command_json_callback_profile_revision_mismatch"
    },
    {
      route: route({ controller_session_id: "other-session" }),
      errorCode: "command_json_controller_session_mismatch"
    }
  ];

  for (const fixture of cases) {
    let spawned = false;
    const transport = createCommandJsonCallbackTransport({
      profile: profile(),
      controllerSessionId: CONTROLLER_SESSION_ID,
      spawnSync: () => {
        spawned = true;
        return { status: 0, stdout: acknowledgement("accepted") };
      }
    });
    assert.deepEqual(transport.deliver(deliveryInput(fixture.route)), {
      disposition: "permanent_failure",
      error_code: fixture.errorCode
    });
    assert.equal(spawned, false);
  }

  let spawned = false;
  const transport = createCommandJsonCallbackTransport({
    profile: profile(),
    controllerSessionId: CONTROLLER_SESSION_ID,
    spawnSync: () => {
      spawned = true;
      return { status: 0, stdout: acknowledgement("accepted") };
    }
  });
  const request = deliveryInput();
  const mismatchedEnvelope = {
    ...request.envelope,
    route: { ...request.envelope.route, profile_revision: "revision-2" }
  };
  assert.deepEqual(transport.deliver({
    ...request,
    envelope: mismatchedEnvelope
  }), {
    disposition: "permanent_failure",
    error_code: "callback_envelope_route_mismatch"
  });
  assert.equal(spawned, false);
});

test("command_json_v1 requires exact delivery and message acknowledgement", () => {
  for (const stdout of [
    acknowledgement("accepted", { deliveryId: "other-delivery" }),
    acknowledgement("accepted", { messageId: "other-message" })
  ]) {
    const transport = createCommandJsonCallbackTransport({
      profile: profile(),
      controllerSessionId: CONTROLLER_SESSION_ID,
      now: () => NOW,
      spawnSync: () => ({ status: 0, stdout })
    });
    assert.deepEqual(transport.deliver(deliveryInput()), {
      disposition: "uncertain",
      error_code: "command_json_callback_acknowledgement_identity_mismatch",
      observed_at: NOW.toISOString()
    });
  }
});

test("command_json_v1 rejects unsupported interpolation and keeps callback bodies off argv", () => {
  for (const arguments_ of [
    ["--unknown", "${envelope.metadata.secret}"],
    ["--message", "${envelope.body}"]
  ]) {
    let spawned = false;
    assert.throws(
      () => createCommandJsonCallbackTransport({
        profile: profile({ arguments: arguments_ }),
        controllerSessionId: CONTROLLER_SESSION_ID,
        spawnSync: () => {
          spawned = true;
          return { status: 0, stdout: acknowledgement("accepted") };
        }
      }),
      /unsupported placeholder|body may appear only in the stdin template/u
    );
    assert.equal(spawned, false);
  }
});

test("command_json_v1 treats timeout, output overflow, and malformed acknowledgement as uncertain", () => {
  const failures = [
    {
      result: {
        status: null,
        stdout: acknowledgement("accepted"),
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
      },
      errorCode: "command_json_callback_execution_limit_uncertain"
    },
    {
      result: {
        status: null,
        stdout: acknowledgement("accepted"),
        error: Object.assign(new Error("too much output"), { code: "ENOBUFS" })
      },
      errorCode: "command_json_callback_execution_limit_uncertain"
    },
    {
      result: {
        status: null,
        stdout: acknowledgement("accepted"),
        error: Object.assign(new Error("maxBuffer exceeded"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        })
      },
      errorCode: "command_json_callback_execution_limit_uncertain"
    },
    {
      result: { status: 0, stdout: "not json" },
      errorCode: "command_json_callback_acknowledgement_invalid"
    },
    {
      result: { status: 9, stdout: "" },
      errorCode: "command_json_callback_exit_unacknowledged"
    }
  ];

  for (const failure of failures) {
    const transport = createCommandJsonCallbackTransport({
      profile: profile(),
      controllerSessionId: CONTROLLER_SESSION_ID,
      now: () => NOW,
      spawnSync: () => failure.result
    });
    assert.deepEqual(transport.deliver(deliveryInput()), {
      disposition: "uncertain",
      error_code: failure.errorCode,
      observed_at: NOW.toISOString()
    });
  }
});

test("command_json_v1 parses escaped JSON Pointer tokens and classifies missing executables", () => {
  const escapedAcknowledgement = {
    disposition: {
      jsonPointer: "/result~1status",
      mapping: { accepted: "accepted" }
    },
    acceptanceId: { jsonPointer: "/acceptance~0id" },
    acknowledgedDeliveryId: { jsonPointer: "/delivery" },
    acknowledgedMessageId: { jsonPointer: "/message" }
  };
  const accepted = createCommandJsonCallbackTransport({
    profile: profile({ acknowledgement: escapedAcknowledgement }),
    controllerSessionId: CONTROLLER_SESSION_ID,
    now: () => NOW,
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        "result/status": "accepted",
        "acceptance~id": "escaped-acceptance",
        delivery: "delivery-1",
        message: "message-1"
      })
    })
  });
  assert.deepEqual(accepted.deliver(deliveryInput()), {
    disposition: "accepted",
    accepted_at: NOW.toISOString(),
    acceptance_id: "escaped-acceptance",
    evidence: {
      transport: COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
      process_status: 0
    }
  });

  const missing = createCommandJsonCallbackTransport({
    profile: profile(),
    controllerSessionId: CONTROLLER_SESSION_ID,
    spawnSync: () => ({
      status: null,
      error: Object.assign(new Error("missing"), { code: "ENOENT" })
    })
  });
  assert.deepEqual(missing.deliver(deliveryInput()), {
    disposition: "permanent_failure",
    error_code: "command_json_callback_executable_unavailable"
  });
});

test("command_json_v1 refuses relative executables at the trusted configuration boundary", () => {
  assert.throws(
    () => createCommandJsonCallbackTransport({
      profile: profile({ executable: "fixture-host" }),
      controllerSessionId: CONTROLLER_SESSION_ID
    }),
    /normalized absolute path/u
  );

  for (const environmentVariables of [
    ["NODE_OPTIONS"],
    ["DYLD_INSERT_LIBRARIES"],
    ["AKK_HOST_PROFILE_SELECTION"]
  ]) {
    assert.throws(
      () => createCommandJsonCallbackTransport({
        profile: profile({ environmentVariables }),
        controllerSessionId: CONTROLLER_SESSION_ID
      }),
      /environment variable is unsafe/u
    );
  }
});
