import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AjvJsonSchemaValidator } from
  "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from
  "@modelcontextprotocol/sdk/validation";

import {
  HOST_PROFILE_JSON_SCHEMA,
  HOST_PROFILE_MAX_FILE_BYTES,
  HOST_PROFILE_MAX_OUTPUT_BYTES,
  HOST_PROFILE_MAX_TIMEOUT_MS,
  HOST_PROFILE_SCHEMA,
  HOST_PROFILE_VERSION,
  assertHostProfileCompatibility,
  assertHostProfileCallbackExecutableReady,
  createHostProfileRegistry,
  hostProfileFingerprint,
  hostProfileSupportsHostVersion,
  loadHostProfileV1,
  parseHostProfileV1,
  resolveHostProfileControllerContext
} from "../src/host-profile.js";

function profileFixture(id = "my-agent-command") {
  return {
    $schema: HOST_PROFILE_JSON_SCHEMA,
    schema: HOST_PROFILE_SCHEMA,
    version: HOST_PROFILE_VERSION,
    id,
    revision: "2026.08.25-1",
    compatibility: {
      host: "my-agent",
      range: ">=1.8.0 <2.0.0"
    },
    controllerContext: {
      driver: "environment_v1",
      sessionIdVariable: "MY_AGENT_SESSION_ID"
    },
    callback: {
      driver: "command_json_v1",
      executable: "/usr/local/bin/my-agent",
      arguments: [
        "session",
        "inject",
        "--session",
        "${controller.session_id}",
        "--delivery-id",
        "${envelope.delivery_id}",
        "--message-id",
        "${envelope.message_id}",
        "--idempotency-key",
        "${envelope.idempotency_key}",
        "--message-stdin",
        "--json"
      ],
      stdin: "${envelope.body}",
      environment: {
        allow: ["MY_AGENT_TOKEN"]
      },
      timeoutMs: 8_000,
      maxOutputBytes: 65_536,
      acknowledgement: {
        disposition: {
          jsonPointer: "/result/status",
          mapping: {
            accepted: "accepted",
            retry: "retryable_failure",
            rejected: "permanent_failure",
            unknown: "uncertain"
          }
        },
        acceptanceId: {
          jsonPointer: "/result/acceptance_id"
        },
        acknowledgedDeliveryId: {
          jsonPointer: "/request/delivery_id"
        },
        acknowledgedMessageId: {
          jsonPointer: "/request/message_id"
        }
      }
    }
  };
}

type ProfileFixture = ReturnType<typeof profileFixture>;

function changed(
  mutate: (candidate: ProfileFixture) => void,
  id = "my-agent-command"
): ProfileFixture {
  const candidate = structuredClone(profileFixture(id));
  mutate(candidate);
  return candidate;
}

test("HostProfile v1 parses into a normalized deeply immutable model", () => {
  const { $schema: _schema, ...withoutSchema } = profileFixture();
  const profile = parseHostProfileV1(withoutSchema);

  assert.equal(profile.$schema, HOST_PROFILE_JSON_SCHEMA);
  assert.equal(profile.schema, HOST_PROFILE_SCHEMA);
  assert.equal(profile.version, 1);
  assert.deepEqual(profile.callback.environment.allow, ["MY_AGENT_TOKEN"]);
  assert.deepEqual(profile.callback.acknowledgement.disposition.mapping, {
    accepted: "accepted",
    rejected: "permanent_failure",
    retry: "retryable_failure",
    unknown: "uncertain"
  });
  for (const value of [
    profile,
    profile.compatibility,
    profile.controllerContext,
    profile.callback,
    profile.callback.arguments,
    profile.callback.environment,
    profile.callback.environment.allow,
    profile.callback.acknowledgement,
    profile.callback.acknowledgement.disposition,
    profile.callback.acknowledgement.disposition.mapping
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.match(hostProfileFingerprint(profile), /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    hostProfileFingerprint(parseHostProfileV1(profileFixture())),
    hostProfileFingerprint(profile)
  );
});

test("HostProfile v1 rejects unknown fields at every closed object boundary", () => {
  const cases: Array<[string, (candidate: ProfileFixture) => void]> = [
    ["root", (candidate) => Object.assign(candidate, { extra: true })],
    [
      "compatibility",
      (candidate) => Object.assign(candidate.compatibility, { extra: true })
    ],
    [
      "controller context",
      (candidate) => Object.assign(candidate.controllerContext, { extra: true })
    ],
    [
      "callback",
      (candidate) => Object.assign(candidate.callback, { extra: true })
    ],
    [
      "environment",
      (candidate) => Object.assign(candidate.callback.environment, { extra: true })
    ],
    [
      "acknowledgement",
      (candidate) => Object.assign(
        candidate.callback.acknowledgement,
        { extra: true }
      )
    ],
    [
      "disposition",
      (candidate) => Object.assign(
        candidate.callback.acknowledgement.disposition,
        { extra: true }
      )
    ],
    [
      "pointer",
      (candidate) => Object.assign(
        candidate.callback.acknowledgement.acceptanceId,
        { extra: true }
      )
    ]
  ];

  for (const [label, mutate] of cases) {
    assert.throws(
      () => parseHostProfileV1(changed(mutate)),
      /unsupported fields/u,
      label
    );
  }

  const inherited = Object.assign(
    Object.create({ hidden: true }) as ProfileFixture,
    profileFixture()
  );
  assert.throws(
    () => parseHostProfileV1(inherited),
    /must be a plain object/u
  );
});

test("HostProfile v1 fails closed on schema, identity, and compatibility", () => {
  const invalid: Array<[
    string,
    (candidate: ProfileFixture) => void,
    RegExp
  ]> = [
    ["schema", (candidate) => { candidate.schema = "other"; }, /schema must/u],
    [
      "version",
      (candidate) => { Object.assign(candidate, { version: 2 }); },
      /version 2/u
    ],
    ["id", (candidate) => { candidate.id = "Unsafe ID"; }, /id is unsafe/u],
    ["revision", (candidate) => { candidate.revision = "../1"; }, /revision is unsafe/u],
    [
      "host",
      (candidate) => { candidate.compatibility.host = "My Agent"; },
      /compatibility\.host is unsafe/u
    ],
    [
      "range",
      (candidate) => { candidate.compatibility.range = "^1.8.0"; },
      /explicit SemVer comparators/u
    ]
  ];

  for (const [label, mutate, expected] of invalid) {
    assert.throws(
      () => parseHostProfileV1(changed(mutate)),
      expected,
      label
    );
  }
  assert.throws(
    () => parseHostProfileV1(profileFixture("builtin-openclaw")),
    /reserved by a built-in Profile/u
  );
  assert.throws(
    () => parseHostProfileV1(profileFixture("openclaw"), {
      reservedIds: ["openclaw"]
    }),
    /reserved by a built-in Profile/u
  );
});

test("environment_v1 admits only a named trusted environment variable", () => {
  assert.throws(
    () => parseHostProfileV1(changed((candidate) => {
      candidate.controllerContext.driver = "process_v1";
    })),
    /must be environment_v1/u
  );
  for (const variable of [
    "lower_case",
    "1SESSION",
    "NODE_OPTIONS",
    "DYLD_INSERT_LIBRARIES",
    "AKK_HOST_PROFILE_SELECTION",
    "AKK_HOST_PROFILE_FUTURE_MARKER"
  ]) {
    assert.throws(
      () => parseHostProfileV1(changed((candidate) => {
        candidate.controllerContext.sessionIdVariable = variable;
      })),
      /environment variable is unsafe/u,
      variable
    );
  }
});

test("HostProfile compatibility matches an exact Host id and SemVer AND range", () => {
  const profile = parseHostProfileV1(profileFixture());

  assert.equal(hostProfileSupportsHostVersion(profile, {
    host: "my-agent",
    version: "1.8.0"
  }), true);
  assert.equal(hostProfileSupportsHostVersion(profile, {
    host: "my-agent",
    version: "1.9.7+host.1"
  }), true);
  assert.equal(hostProfileSupportsHostVersion(profile, {
    host: "my-agent",
    version: "1.8.0-alpha.1"
  }), false);
  assert.equal(hostProfileSupportsHostVersion(profile, {
    host: "my-agent",
    version: "2.0.0"
  }), false);
  assert.equal(hostProfileSupportsHostVersion(profile, {
    host: "my-agent",
    version: "2.0.0-alpha.1"
  }), false);
  assert.equal(hostProfileSupportsHostVersion(profile, {
    host: "other-agent",
    version: "1.9.0"
  }), false);
  assert.doesNotThrow(() => assertHostProfileCompatibility(profile, {
    host: "my-agent",
    version: "1.9.0"
  }));
  assert.throws(
    () => assertHostProfileCompatibility(profile, {
      host: "other-agent",
      version: "1.9.0"
    }),
    /targets my-agent, not other-agent/u
  );
  assert.throws(
    () => assertHostProfileCompatibility(profile, {
      host: "my-agent",
      version: "2.0.0"
    }),
    /does not satisfy Profile range/u
  );
  assert.throws(
    () => hostProfileSupportsHostVersion(profile, {
      host: "my-agent",
      version: "v1.9.0"
    }),
    /exact SemVer/u
  );

  const prereleaseProfile = parseHostProfileV1(changed((candidate) => {
    candidate.compatibility.range = ">=2.0.0-alpha.1 <2.0.0";
  }));
  assert.equal(hostProfileSupportsHostVersion(prereleaseProfile, {
    host: "my-agent",
    version: "2.0.0-alpha.2"
  }), true);
});

test("command_json_v1 requires a normalized absolute non-shell executable", () => {
  for (const executable of [
    "my-agent",
    "/bin/sh",
    "/usr/bin/env",
    "/opt/../bin/my-agent",
    "/usr/local/bin/my-agent/"
  ]) {
    assert.throws(
      () => parseHostProfileV1(changed((candidate) => {
        candidate.callback.executable = executable;
      })),
      /executable/u,
      executable
    );
  }
  assert.throws(
    () => parseHostProfileV1(changed((candidate) => {
      candidate.callback.driver = "shell_v1";
    })),
    /must be command_json_v1/u
  );
});

test("Host startup rejects a callback symlink whose target is a shell", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-profile-shell-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "callback");
  fs.symlinkSync("/bin/sh", executable);

  assert.throws(
    () => assertHostProfileCallbackExecutableReady(executable),
    /executable cannot be a shell/u
  );
});

test("Host startup requires explicit PATH for an env shebang", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-profile-env-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "callback");
  fs.writeFileSync(executable, "#!/usr/bin/env node\n", { mode: 0o755 });

  assert.throws(
    () => assertHostProfileCallbackExecutableReady(executable),
    /environment\.allow does not include PATH/u
  );
  assert.doesNotThrow(
    () => assertHostProfileCallbackExecutableReady(executable, ["PATH"])
  );
});

test("command_json_v1 argv permits only bounded data placeholders and no shell program", () => {
  const unsafe: Array<[string, (arguments_: string[]) => void, RegExp]> = [
    [
      "unknown placeholder",
      (arguments_) => arguments_.push("${process.env}"),
      /unsupported placeholder/u
    ],
    [
      "body outside stdin",
      (arguments_) => arguments_.push("${envelope.body}"),
      /body may appear only/u
    ],
    [
      "shell syntax",
      (arguments_) => arguments_.push("ok; rm -rf anything"),
      /shell syntax/u
    ],
    [
      "shell substitution",
      (arguments_) => arguments_.push("$(printf unsafe)"),
      /unsupported interpolation/u
    ]
  ];
  for (const [label, mutate, expected] of unsafe) {
    assert.throws(
      () => parseHostProfileV1(changed((candidate) => {
        mutate(candidate.callback.arguments);
      })),
      expected,
      label
    );
  }

  for (const required of [
    "${controller.session_id}",
    "${envelope.delivery_id}",
    "${envelope.message_id}"
  ]) {
    assert.throws(
      () => parseHostProfileV1(changed((candidate) => {
        candidate.callback.arguments = candidate.callback.arguments
          .filter((argument) => argument !== required);
      })),
      /arguments must include/u,
      required
    );
  }
  assert.throws(
    () => parseHostProfileV1(changed((candidate) => {
      candidate.callback.stdin = "${envelope.message_id}";
    })),
    /stdin must be exactly/u
  );
});

test("command_json_v1 environment is an explicit bounded safe allowlist", () => {
  for (const allow of [
    ["lower_case"],
    ["NODE_OPTIONS"],
    ["DYLD_INSERT_LIBRARIES"],
    ["AKK_HOST_PROFILE_FINGERPRINT"],
    ["MY_AGENT_TOKEN", "MY_AGENT_TOKEN"]
  ]) {
    assert.throws(
      () => parseHostProfileV1(changed((candidate) => {
        candidate.callback.environment.allow = allow;
      })),
      /(environment variable is unsafe|repeats)/u,
      allow.join(",")
    );
  }
  const profile = parseHostProfileV1(changed((candidate) => {
    candidate.callback.environment.allow = [];
  }));
  assert.deepEqual(profile.callback.environment.allow, []);
});

test("command_json_v1 timeout and output limits are mandatory bounded integers", () => {
  for (const timeoutMs of [0, 1.5, HOST_PROFILE_MAX_TIMEOUT_MS + 1]) {
    assert.throws(
      () => parseHostProfileV1(changed((candidate) => {
        candidate.callback.timeoutMs = timeoutMs;
      })),
      /timeoutMs must be an integer/u
    );
  }
  for (const maxOutputBytes of [0, 1.5, HOST_PROFILE_MAX_OUTPUT_BYTES + 1]) {
    assert.throws(
      () => parseHostProfileV1(changed((candidate) => {
        candidate.callback.maxOutputBytes = maxOutputBytes;
      })),
      /maxOutputBytes must be an integer/u
    );
  }
});

test("acknowledgement mapping and JSON pointers are strict and correlatable", () => {
  assert.throws(
    () => parseHostProfileV1(changed((candidate) => {
      Object.assign(candidate.callback.acknowledgement.disposition, {
        mapping: { retry: "retryable_failure" }
      });
    })),
    /must include accepted/u
  );
  assert.throws(
    () => parseHostProfileV1(changed((candidate) => {
      candidate.callback.acknowledgement.disposition.mapping.accepted =
        "success";
    })),
    /mapping is invalid/u
  );
  for (const pointer of ["status", "/bad~2escape", `/${"x/".repeat(17)}x`]) {
    assert.throws(
      () => parseHostProfileV1(changed((candidate) => {
        candidate.callback.acknowledgement.disposition.jsonPointer = pointer;
      })),
      /(bounded JSON pointer|invalid JSON pointer escaping)/u,
      pointer
    );
  }
  assert.throws(
    () => parseHostProfileV1(changed((candidate) => {
      candidate.callback.acknowledgement.acknowledgedMessageId.jsonPointer =
        candidate.callback.acknowledgement.acknowledgedDeliveryId.jsonPointer;
    })),
    /delivery and message pointers must differ/u
  );
});

test("the built-in registry reserves its namespace and exact ids", () => {
  const registry = createHostProfileRegistry([
    profileFixture("openclaw"),
    profileFixture("builtin-example")
  ]);

  assert.deepEqual(
    registry.list().map((entry) => entry.id),
    ["builtin-example", "openclaw"]
  );
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.equal(Object.isFrozen(registry.list()[0]), true);
  assert.equal(registry.isReserved("openclaw"), true);
  assert.equal(registry.isReserved("builtin-any-future-profile"), true);
  assert.equal(registry.resolve("openclaw")?.id, "openclaw");
  assert.equal(registry.resolve("missing"), undefined);
  assert.throws(
    () => createHostProfileRegistry([
      profileFixture("openclaw"),
      profileFixture("openclaw")
    ]),
    /duplicate built-in host profile id/u
  );
});

test("explicit file loading canonicalizes a JSON file and enforces registry ownership", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-profile-"));
  try {
    const profilePath = path.join(root, "profile.json");
    const linkPath = path.join(root, "selected.json");
    fs.writeFileSync(profilePath, JSON.stringify(profileFixture()), "utf8");
    fs.symlinkSync(profilePath, linkPath);

    const loaded = loadHostProfileV1("selected.json", { cwd: root });
    assert.equal(loaded.path, fs.realpathSync(profilePath));
    assert.equal(loaded.profile.id, "my-agent-command");
    assert.equal(loaded.fingerprint, hostProfileFingerprint(loaded.profile));
    assert.equal(Object.isFrozen(loaded), true);

    const registry = createHostProfileRegistry([
      profileFixture("my-agent-command")
    ]);
    assert.throws(
      () => loadHostProfileV1(profilePath, { registry }),
      /reserved by a built-in Profile/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("file loading rejects non-files, non-JSON, oversized, and invalid UTF-8 input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-profile-bad-"));
  try {
    const directoryPath = path.join(root, "directory.json");
    const textPath = path.join(root, "profile.txt");
    const oversizedPath = path.join(root, "oversized.json");
    const invalidUtf8Path = path.join(root, "utf8.json");
    fs.mkdirSync(directoryPath);
    fs.writeFileSync(textPath, JSON.stringify(profileFixture()), "utf8");
    fs.writeFileSync(
      oversizedPath,
      Buffer.alloc(HOST_PROFILE_MAX_FILE_BYTES + 1, 0x20)
    );
    fs.writeFileSync(invalidUtf8Path, Buffer.from([0xc3, 0x28]));

    assert.throws(
      () => loadHostProfileV1(directoryPath),
      /regular file/u
    );
    assert.throws(
      () => loadHostProfileV1(textPath),
      /\.json file/u
    );
    assert.throws(
      () => loadHostProfileV1(oversizedPath),
      /exceeds/u
    );
    assert.throws(
      () => loadHostProfileV1(invalidUtf8Path),
      /not valid UTF-8/u
    );
    assert.throws(
      () => loadHostProfileV1("\0profile.json", { cwd: root }),
      /explicit non-empty path/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trusted controller context resolves only from the supplied environment", () => {
  const profile = parseHostProfileV1(profileFixture());
  assert.deepEqual(
    resolveHostProfileControllerContext(profile, {
      MY_AGENT_SESSION_ID: "session-123",
      UNRELATED: "ignored"
    }),
    {
      driver: "environment_v1",
      variable: "MY_AGENT_SESSION_ID",
      controllerSessionId: "session-123"
    }
  );
  assert.throws(
    () => resolveHostProfileControllerContext(profile, {}),
    /missing or invalid/u
  );
  assert.throws(
    () => resolveHostProfileControllerContext(profile, {
      MY_AGENT_SESSION_ID: " session-123"
    }),
    /missing or invalid/u
  );
  const inherited = Object.create({
    MY_AGENT_SESSION_ID: "inherited-session"
  }) as Record<string, string | undefined>;
  assert.throws(
    () => resolveHostProfileControllerContext(profile, inherited),
    /missing or invalid/u
  );
});

test("published HostProfile v1 JSON Schema enforces its closed structural contract", () => {
  const schemaPath = path.resolve("schemas/host-profile-v1.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
    $id: string;
    additionalProperties: boolean;
    required: string[];
    $defs: {
      callback: {
        additionalProperties: boolean;
        required: string[];
      };
    };
  };

  assert.equal(schema.$id, HOST_PROFILE_JSON_SCHEMA);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schema",
    "version",
    "id",
    "revision",
    "compatibility",
    "controllerContext",
    "callback"
  ]);
  assert.equal(schema.$defs.callback.additionalProperties, false);
  assert.deepEqual(schema.$defs.callback.required, [
    "driver",
    "executable",
    "arguments",
    "stdin",
    "environment",
    "timeoutMs",
    "maxOutputBytes",
    "acknowledgement"
  ]);

  const validate = new AjvJsonSchemaValidator().getValidator<
    Record<string, unknown>
  >(schema as unknown as JsonSchemaType);
  const valid = validate(profileFixture());
  assert.equal(valid.valid, true, valid.errorMessage);

  for (const candidate of [
    changed((profile) => {
      profile.compatibility.range = "^1.8.0";
    }),
    changed((profile) => {
      profile.controllerContext.sessionIdVariable =
        "AKK_HOST_PROFILE_SELECTION";
    }),
    changed((profile) => {
      profile.callback.executable = "/bin/sh";
    }),
    changed((profile) => {
      profile.callback.executable = "//callback";
    }),
    changed((profile) => {
      profile.callback.executable = "/opt/bin/SH";
    }),
    changed((profile) => {
      profile.callback.executable = "/opt/bin/callback ";
    }),
    changed((profile) => {
      profile.callback.acknowledgement.acceptanceId.jsonPointer = "/result/id ";
    }),
    changed((profile) => {
      profile.callback.arguments = profile.callback.arguments.filter(
        (argument) => argument !== "${envelope.delivery_id}"
      );
    }),
    changed((profile) => {
      profile.callback.arguments.push("$(unsafe)");
    })
  ]) {
    assert.equal(validate(candidate).valid, false);
  }
});
