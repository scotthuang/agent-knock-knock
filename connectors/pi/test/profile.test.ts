import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CALLBACK_SOCKET_ENV,
  CALLBACK_TOKEN_ENV,
  CONNECTOR_STATE_DIR_ENV,
  CONTROLLER_ID_ENV,
} from "../src/constants.js";
import { createConnectorProfileResources } from "../src/profile.js";

test("creates a private route-bound Pi Host Profile without persisting its token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-pi-profile-test-"));
  const stateDirectory = path.join(root, "state");
  const resources = createConnectorProfileResources({
    PATH: process.env.PATH,
    [CONNECTOR_STATE_DIR_ENV]: stateDirectory,
  });
  try {
    assert.equal(fs.statSync(resources.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(resources.profilePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDirectory).mode & 0o777, 0o700);

    const persisted = fs.readFileSync(resources.profilePath, "utf8");
    assert.equal(persisted.includes(resources.token), false);
    assert.equal(persisted.includes(resources.socketPath), false);
    assert.match(persisted, /"scope": "route_bound_v1"/u);
    assert.match(persisted, /"driver": "command_json_v1"/u);

    const environment = resources.environment("pi-controller-one");
    assert.equal(environment[CONTROLLER_ID_ENV], "pi-controller-one");
    assert.equal(environment[CALLBACK_SOCKET_ENV], resources.socketPath);
    assert.equal(environment[CALLBACK_TOKEN_ENV], resources.token);
    assert.equal(typeof environment.AKK_HOST_PROFILE_FINGERPRINT, "string");
  } finally {
    resources.remove();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a relative state directory before allocating Profile resources", () => {
  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter(isProfileResourceDirectory),
  );
  assert.throws(
    () => createConnectorProfileResources({
      [CONNECTOR_STATE_DIR_ENV]: "relative/state",
    }),
    /must be an absolute path/u,
  );
  const after = fs.readdirSync(os.tmpdir())
    .filter(isProfileResourceDirectory);
  assert.deepEqual(after.filter((entry) => !before.has(entry)), []);
});

function isProfileResourceDirectory(entry: string): boolean {
  return /^akk-pi-[A-Za-z0-9]{6}$/u.test(entry);
}
