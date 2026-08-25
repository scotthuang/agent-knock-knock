import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  executeCliCommand,
  parseCliCommand
} from "../src/cli-core.js";
import {
  HOST_PROFILE_JSON_SCHEMA,
  HOST_PROFILE_SCHEMA,
  HOST_PROFILE_VERSION
} from "../src/host-profile.js";

test("host-profile CLI parses example, list, and positional validate forms", () => {
  assert.deepEqual(parseCliCommand(["host-profile", "example"]), {
    command: "host-profile",
    options: { action: "example" }
  });
  assert.deepEqual(parseCliCommand(["host-profile", "list"]), {
    command: "host-profile",
    options: { action: "list" }
  });
  assert.deepEqual(parseCliCommand([
    "host-profile",
    "validate",
    "profiles/my-agent.json",
    "--host",
    "my-agent",
    "--host-version",
    "1.9.0"
  ]), {
    command: "host-profile",
    options: {
      action: "validate",
      profile: "profiles/my-agent.json",
      host: "my-agent",
      hostVersion: "1.9.0"
    }
  });

  assert.throws(
    () => parseCliCommand(["host-profile"]),
    /requires example, list, or validate/u
  );
  assert.throws(
    () => parseCliCommand([
      "host-profile",
      "validate",
      "one.json",
      "--profile",
      "two.json"
    ]),
    /accepts the Profile only once/u
  );
});

test("host-profile example, list, and validate execute with scoped cwd", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-profile-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "my-agent.json");
  writeProfile(profilePath);

  const example = await executeCliCommand("host-profile", {
    action: "example"
  }, quietDependencies(root));
  assert.equal(example.exitCode, 0);
  assert.equal(JSON.parse(example.stdout).$schema, HOST_PROFILE_JSON_SCHEMA);

  const listed = await executeCliCommand("host-profile", {
    action: "list"
  }, quietDependencies(root));
  assert.equal(listed.exitCode, 0);
  assert.deepEqual(JSON.parse(listed.stdout), {
    schema: "agent-knock-knock/host-profile-list",
    version: 1,
    profiles: []
  });

  const parsed = parseCliCommand([
    "host-profile",
    "validate",
    path.basename(profilePath),
    "--host",
    "my-agent",
    "--host-version",
    "1.8.7"
  ]);
  const validated = await executeCliCommand(
    parsed.command,
    parsed.options,
    quietDependencies(root)
  );
  const body = JSON.parse(validated.stdout);

  assert.equal(validated.exitCode, 0);
  assert.equal(body.ok, true);
  assert.equal(body.source, "file");
  assert.equal(body.selection, fs.realpathSync(profilePath));
  assert.equal(body.id, "my-agent-command");
  assert.equal(body.revision, "2026.08.25-1");
  assert.equal(body.compatibility_checked, true);
  assert.equal(body.controller_context_driver, "environment_v1");
  assert.equal(body.controller_context_scope, "startup_v1");
  assert.equal(body.standalone_bridge_compatible, true);
  assert.equal(body.callback_driver, "command_json_v1");
  assert.match(body.fingerprint, /^sha256:[a-f0-9]{64}$/u);
});

test("doctor checks Profile compatibility, trusted context, and callback executable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-profile-doctor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "my-agent.json");
  writeProfile(profilePath);

  const parsed = parseCliCommand([
    "doctor",
    "--host-profile",
    path.basename(profilePath),
    "--host",
    "my-agent",
    "--host-version",
    "1.9.2"
  ]);
  const valid = await executeCliCommand(parsed.command, parsed.options, {
    ...quietDependencies(root),
    env: {
      MY_AGENT_SESSION_ID: "private-controller-session"
    }
  });
  const validBody = JSON.parse(valid.stdout);

  assert.equal(valid.exitCode, 0);
  assert.equal(validBody.ok, true);
  assert.equal(validBody.mode, "host_bridge");
  assert.equal(validBody.controller_context_scope, "startup_v1");
  assert.equal(validBody.standalone_bridge_compatible, true);
  assert.deepEqual(
    validBody.checks.map((check: { name: string; status: string }) => [
      check.name,
      check.status
    ]),
    [
      ["profile", "ok"],
      ["host_compatibility", "ok"],
      ["controller_context", "ok"],
      ["callback_executable", "ok"]
    ]
  );
  assert.doesNotMatch(valid.stdout, /private-controller-session/u);

  const missingContext = await executeCliCommand(
    parsed.command,
    parsed.options,
    {
      ...quietDependencies(root),
      env: {}
    }
  );
  const missingBody = JSON.parse(missingContext.stdout);
  assert.equal(missingContext.exitCode, 1);
  assert.equal(missingBody.ok, false);
  assert.deepEqual(
    missingBody.checks.find((check: { name: string }) =>
      check.name === "controller_context"
    )?.status,
    "error"
  );
});

test("validate and doctor identify route-bound Profiles as connector-only", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-route-bound-doctor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "route-bound.json");
  writeProfile(profilePath, "route_bound_v1");

  const validated = await executeCliCommand("host-profile", {
    action: "validate",
    profile: path.basename(profilePath),
    host: "my-agent",
    hostVersion: "1.9.2"
  }, quietDependencies(root));
  const validatedBody = JSON.parse(validated.stdout);
  assert.equal(validated.exitCode, 0);
  assert.equal(validatedBody.controller_context_scope, "route_bound_v1");
  assert.equal(validatedBody.standalone_bridge_compatible, false);

  const diagnosed = await executeCliCommand("doctor", {
    hostProfile: path.basename(profilePath),
    host: "my-agent",
    hostVersion: "1.9.2"
  }, {
    ...quietDependencies(root),
    env: { MY_AGENT_SESSION_ID: "private-controller-session" }
  });
  const diagnosedBody = JSON.parse(diagnosed.stdout);
  assert.equal(diagnosed.exitCode, 1);
  assert.equal(diagnosedBody.controller_context_scope, "route_bound_v1");
  assert.equal(diagnosedBody.standalone_bridge_compatible, false);
  assert.deepEqual(
    diagnosedBody.checks.find((check: { name: string }) =>
      check.name === "standalone_bridge_scope"
    ),
    {
      name: "standalone_bridge_scope",
      status: "error",
      scope: "route_bound_v1",
      detail:
        "route_bound_v1 is for a Host-native connector and is not supported " +
        "by the standalone Host Bridge"
    }
  );
});

function quietDependencies(cwd: string) {
  return {
    cwd,
    runtimeLog: () => undefined
  };
}

function writeProfile(
  filePath: string,
  controllerScope?: "startup_v1" | "route_bound_v1"
): void {
  fs.writeFileSync(filePath, `${JSON.stringify({
    $schema: HOST_PROFILE_JSON_SCHEMA,
    schema: HOST_PROFILE_SCHEMA,
    version: HOST_PROFILE_VERSION,
    id: "my-agent-command",
    revision: "2026.08.25-1",
    compatibility: {
      host: "my-agent",
      range: ">=1.8.0 <2.0.0"
    },
    controllerContext: {
      driver: "environment_v1",
      sessionIdVariable: "MY_AGENT_SESSION_ID",
      ...(controllerScope === undefined ? {} : { scope: controllerScope })
    },
    callback: {
      driver: "command_json_v1",
      executable: process.execPath,
      arguments: [
        "--controller",
        "${controller.session_id}",
        "--delivery",
        "${envelope.delivery_id}",
        "--message",
        "${envelope.message_id}"
      ],
      stdin: "${envelope.body}",
      environment: { allow: [] },
      timeoutMs: 2_000,
      maxOutputBytes: 65_536,
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
  }, null, 2)}\n`, "utf8");
}
