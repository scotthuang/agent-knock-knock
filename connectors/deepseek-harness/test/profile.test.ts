import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CALLBACK_SOCKET_ENV,
  CALLBACK_TOKEN_ENV,
  CONTROLLER_ID_ENV,
  HOST_PROFILE_FINGERPRINT_ENV,
  HOST_PROFILE_HOST_VERSION_ENV,
  HOST_PROFILE_SELECTION_ENV,
  SUPPORTED_DSH_VERSIONS,
} from "../src/constants.js";
import { createConnectorProfileResources, connectorCallbackRoute, resolveConnectorPluginConfig } from "../src/profile.js";
import { AKK_HOST_PROFILE_CALLBACK_RECOVERY, AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT,
  hostProfileCallbackRecoveryFingerprint } from "@scotthuang/agent-knock-knock/host-adapter";

test("creates a private route-bound Host Profile and environment", () => {
  const resources = createConnectorProfileResources(
    "0.1.2-alpha.1",
    { PATH: "/test/bin" },
  );
  try {
    assert.equal(fs.statSync(resources.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(resources.profilePath).mode & 0o777, 0o600);

    const profile = JSON.parse(fs.readFileSync(resources.profilePath, "utf8"));
    assert.equal(profile.controllerContext.scope, "route_bound_v1");
    assert.equal(profile.compatibility.range, "=0.1.2-alpha.1");
    assert.equal(profile.controllerContext.sessionIdVariable, CONTROLLER_ID_ENV);
    assert.equal(profile.callback.executable, process.execPath);
    assert.equal(profile.callback.arguments[0].endsWith("callback-helper.js"), true);
    assert.deepEqual(
      profile.callback.environment.allow,
      [CALLBACK_SOCKET_ENV, CALLBACK_TOKEN_ENV],
    );
    assert.equal(JSON.stringify(profile).includes(resources.token), false);

    const environment = resources.environment("controller:one");
    assert.equal(environment[CONTROLLER_ID_ENV], "controller:one");
    assert.equal(environment[CALLBACK_SOCKET_ENV], resources.socketPath);
    assert.equal(environment[CALLBACK_TOKEN_ENV], resources.token);
    assert.equal(
      environment[HOST_PROFILE_SELECTION_ENV],
      fs.realpathSync(resources.profilePath),
    );
    assert.equal(environment[HOST_PROFILE_FINGERPRINT_ENV], resources.fingerprint);
    assert.equal(environment[HOST_PROFILE_HOST_VERSION_ENV], "0.1.2-alpha.1");
    assert.equal(environment.PATH, "/test/bin");
  } finally {
    resources.remove();
  }
  assert.equal(fs.existsSync(resources.directory), false);
});

test("uses a new Profile revision and token for each Host incarnation", () => {
  const first = createConnectorProfileResources("0.1.1-rc.2", {});
  const second = createConnectorProfileResources("0.1.2-alpha.1", {});
  try {
    assert.notEqual(first.instanceNonce, second.instanceNonce);
    assert.notEqual(first.token, second.token);
    assert.notEqual(first.profile.revision, second.profile.revision);
    assert.notEqual(first.fingerprint, second.fingerprint);
  } finally {
    first.remove();
    second.remove();
  }
});

test("durable owner retains revision across restart while rotating authenticated IPC", () => {
  const first = createConnectorProfileResources("0.2.1-rc.2", {}, { ownerScope: "profile-web:owner-one", routes: [] });
  const route = connectorCallbackRoute(first, "persisted-controller");
  const second = createConnectorProfileResources("0.2.1-rc.2", {}, {
    ownerScope: "profile-web:owner-one", routes: [route],
  });
  const foreign = createConnectorProfileResources("0.2.1-rc.2", {}, { ownerScope: "profile-other:owner-two", routes: [] });
  try {
    assert.equal(first.profile.revision, second.profile.revision);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.notEqual(first.profile.revision, foreign.profile.revision);
    assert.notEqual(first.instanceNonce, second.instanceNonce);
    assert.notEqual(first.socketPath, second.socketPath);
    assert.notEqual(first.token, second.token);
    const environment = second.environment("lifecycle-after-restart");
    assert.equal(environment[CALLBACK_SOCKET_ENV], second.socketPath);
    assert.equal(environment[CALLBACK_TOKEN_ENV], second.token);
    const catalog = JSON.parse(fs.readFileSync(environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY]!, "utf8"));
    assert.equal(fs.statSync(environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY]!).mode & 0o777, 0o600);
    assert.equal(environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT], hostProfileCallbackRecoveryFingerprint(catalog));
    assert.deepEqual(catalog.routes, [route]);
    assert.equal(JSON.stringify(catalog).includes(first.socketPath), false);
    assert.equal(JSON.stringify(catalog).includes(first.token), false);
  } finally {
    first.remove(); second.remove(); foreign.remove();
  }
});

test("does not inherit another connector's recovery catalogue", () => {
  const resources = createConnectorProfileResources("0.2.1-rc.2", {
    [AKK_HOST_PROFILE_CALLBACK_RECOVERY]: "/unrelated/catalog.json",
    [AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT]: "sha256:unrelated",
  });
  try {
    const environment = resources.environment("controller");
    assert.equal(environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY], undefined);
    assert.equal(environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT], undefined);
  } finally { resources.remove(); }
});

test("projects each supported Harness version into its exact Host Profile", () => {
  for (const version of SUPPORTED_DSH_VERSIONS) {
    const resources = createConnectorProfileResources(version, {});
    try {
      assert.deepEqual(resources.profile.compatibility, {
        host: "deepseek-harness",
        range: `=${version}`,
      });
      assert.equal(
        resources.environment("controller:version")[HOST_PROFILE_HOST_VERSION_ENV],
        version,
      );
    } finally {
      resources.remove();
    }
  }
});


test("uses a stable DSH-owned Store without mutating or overriding explicit configuration", () => {
  const configured = { agentHardTimeoutMinutes: 720 };
  const defaultConfig = resolveConnectorPluginConfig(configured, "/test/home");
  assert.equal(defaultConfig.storeDir, "/test/home/.agent-knock-knock/hosts/deepseek-harness/store");
  assert.notEqual(defaultConfig.storeDir, path.join("/test/home", ".agent-knock-knock", "store"));
  assert.deepEqual(configured, { agentHardTimeoutMinutes: 720 });
  assert.equal(defaultConfig.agentHardTimeoutMinutes, 720);
  for (const storeDir of ["/private/explicit-store", "relative-explicit-store"]) {
    const explicit = { ...configured, storeDir };
    assert.deepEqual(resolveConnectorPluginConfig(explicit, "/other/home"), explicit);
  }
  for (const storeDir of ["", "   ", null, false]) {
    assert.throws(() => resolveConnectorPluginConfig({ storeDir }), /non-empty path/u);
  }
});
