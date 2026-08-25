import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AKK_HOST_PROFILE_FINGERPRINT,
  AKK_HOST_PROFILE_HOST,
  AKK_HOST_PROFILE_HOST_VERSION,
  AKK_HOST_PROFILE_SELECTION,
  AKK_HOST_PROFILE_SOURCE,
  applyTrustedHostProfileCliOptions,
  createTrustedHostProfileRuntime,
  hostProfileRelayEnvironment,
  selectHostProfileV1,
  trustedHostProfileRuntimeFromEnvironment
} from "../src/host-profile-runtime.js";

const HOST_ID = "fixture-host";
const HOST_VERSION = "1.7.3";
const SESSION_VARIABLE = "FIXTURE_CONTROLLER_SESSION";
const SESSION_ID = "controller-session-232";

interface ProfileFixture {
  readonly root: string;
  readonly profilePath: string;
  readonly executable: string;
  write(revision?: string): void;
}

function createProfileFixture(t: TestContext): ProfileFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-profile-runtime-"));
  const executable = path.join(root, "callback-driver");
  const profilePath = path.join(root, "host-profile.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (revision = "revision-1"): void => {
    fs.writeFileSync(profilePath, JSON.stringify({
      $schema: "https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/schemas/host-profile-v1.schema.json",
      schema: "agent-knock-knock/host-profile",
      version: 1,
      id: "fixture-profile",
      revision,
      compatibility: {
        host: HOST_ID,
        range: ">=1.0.0 <2.0.0"
      },
      controllerContext: {
        driver: "environment_v1",
        sessionIdVariable: SESSION_VARIABLE
      },
      callback: {
        driver: "command_json_v1",
        executable,
        arguments: [
          "--session",
          "${controller.session_id}",
          "--delivery",
          "${envelope.delivery_id}",
          "--message",
          "${envelope.message_id}"
        ],
        stdin: "${envelope.body}",
        environment: { allow: ["FIXTURE_CALLBACK_TOKEN"] },
        timeoutMs: 2_000,
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
  };
  write();
  return { root, profilePath, executable, write };
}

function startupRuntime(fixture: ProfileFixture) {
  return createTrustedHostProfileRuntime({
    selection: "host-profile.json",
    cwd: fixture.root,
    host: HOST_ID,
    hostVersion: HOST_VERSION,
    environment: { [SESSION_VARIABLE]: SESSION_ID }
  });
}

test("an explicit file selection becomes one canonical, trusted startup runtime", (t) => {
  const fixture = createProfileFixture(t);
  const selected = selectHostProfileV1("./host-profile.json", {
    cwd: fixture.root
  });

  assert.equal(selected.source, "file");
  assert.equal(selected.selection, fs.realpathSync(fixture.profilePath));
  assert.equal(selected.profile.id, "fixture-profile");
  assert.match(selected.fingerprint, /^sha256:[0-9a-f]{64}$/u);

  const runtime = startupRuntime(fixture);
  assert.equal(runtime.selected.selection, fs.realpathSync(fixture.profilePath));
  assert.equal(runtime.host, HOST_ID);
  assert.equal(runtime.hostVersion, HOST_VERSION);
  assert.equal(runtime.controllerScope, "startup_v1");
  assert.equal(runtime.controllerSessionId, SESSION_ID);
  assert.deepEqual(runtime.callbackRoute, {
    schema: "agent-knock-knock/callback-route",
    version: 1,
    transport: "command_json_v1",
    profile_id: "fixture-profile",
    profile_revision: "revision-1",
    controller_session_id: SESSION_ID,
    capabilities: { wake: true, respond: true }
  });
});

test("relay environment replaces untrusted markers with startup authority", (t) => {
  const fixture = createProfileFixture(t);
  const runtime = startupRuntime(fixture);
  const relay = hostProfileRelayEnvironment(runtime, {
    UNRELATED: "preserved",
    [SESSION_VARIABLE]: "untrusted-session",
    [AKK_HOST_PROFILE_SELECTION]: "/untrusted/profile.json",
    [AKK_HOST_PROFILE_SOURCE]: "built_in",
    [AKK_HOST_PROFILE_FINGERPRINT]: "sha256:untrusted",
    [AKK_HOST_PROFILE_HOST]: "untrusted-host",
    [AKK_HOST_PROFILE_HOST_VERSION]: "999.0.0"
  });

  assert.equal(relay.UNRELATED, "preserved");
  assert.equal(relay[SESSION_VARIABLE], SESSION_ID);
  assert.equal(relay[AKK_HOST_PROFILE_SELECTION], runtime.selected.selection);
  assert.equal(relay[AKK_HOST_PROFILE_SOURCE], "file");
  assert.equal(
    relay[AKK_HOST_PROFILE_FINGERPRINT],
    runtime.selected.fingerprint
  );
  assert.equal(relay[AKK_HOST_PROFILE_HOST], HOST_ID);
  assert.equal(relay[AKK_HOST_PROFILE_HOST_VERSION], HOST_VERSION);
});

test("a child reloads the selected file and rejects an edited fingerprint", (t) => {
  const fixture = createProfileFixture(t);
  const runtime = startupRuntime(fixture);
  const relay = hostProfileRelayEnvironment(runtime, {
    [SESSION_VARIABLE]: SESSION_ID
  });

  const reloaded = trustedHostProfileRuntimeFromEnvironment(relay, {
    cwd: fixture.root
  });
  assert.ok(reloaded);
  assert.equal(reloaded.selected.fingerprint, runtime.selected.fingerprint);
  assert.deepEqual(reloaded.callbackRoute, runtime.callbackRoute);

  fixture.write("revision-2");
  assert.throws(
    () => trustedHostProfileRuntimeFromEnvironment(relay, {
      cwd: fixture.root
    }),
    /changed after Bridge startup/u
  );
});

test("trusted CLI authority is injected only for operations that create a Turn or Watch", (t) => {
  const fixture = createProfileFixture(t);
  const runtime = startupRuntime(fixture);
  const relay = hostProfileRelayEnvironment(runtime, {
    [SESSION_VARIABLE]: SESSION_ID
  });
  const untrusted = {
    message: "keep this request",
    callbackRoute: {
      transport: "attacker_transport",
      profile_id: "attacker-profile",
      profile_revision: "attacker-revision",
      controller_session_id: "attacker-session"
    },
    openclawSession: "attacker-session",
    gatewaySession: "attacker-session",
    openclawBin: "/attacker/bin"
  };

  for (const [command, commandOptions] of [
    ["delegate", untrusted],
    ["send", untrusted],
    ["watch-terminal", untrusted],
    ["reconcile-watches", untrusted]
  ] as const) {
    const applied = applyTrustedHostProfileCliOptions(
      command,
      commandOptions,
      relay,
      fixture.root
    );
    assert.equal(applied.message, "keep this request", command);
    assert.deepEqual(applied.callbackRoute, runtime.callbackRoute, command);
    assert.equal(applied.openclawSession, SESSION_ID, command);
    assert.equal(applied.gatewaySession, SESSION_ID, command);
    assert.equal(
      applied.openclawBin,
      "agent-knock-knock-host-bridge",
      command
    );
  }

  for (const [command, commandOptions] of [
    ["send", { ...untrusted, turn: "turn-existing" }],
    ["respond", untrusted]
  ] as const) {
    const applied = applyTrustedHostProfileCliOptions(
      command,
      commandOptions,
      relay,
      fixture.root
    );
    assert.strictEqual(applied, commandOptions, command);
    assert.equal(applied.openclawSession, "attacker-session", command);
    assert.deepEqual(applied.callbackRoute, untrusted.callbackRoute, command);
  }
});
