import assert from "node:assert/strict";
import fs from "node:fs";
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
import { createConnectorProfileResources } from "../src/profile.js";

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
