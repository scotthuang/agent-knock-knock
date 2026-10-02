import assert from "node:assert/strict";
import path from "node:path";
import {
  createRequire
} from "node:module";
import {
  pathToFileURL
} from "node:url";
import {
  callbackParams
} from "./runtime-contract.js";
import {
  runNpm,
  readJson,
  safeName
} from "./command-runtime.js";

export async function verifyApiBoundary({
  artifactPath: artifact,
  caseRoot,
  expectSupported,
  host,
  target,
  version
}) {
  runNpm([
    "install",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--prefer-offline",
    "--legacy-peer-deps",
    artifact
  ], {
    cwd: host.dir,
    env: host.env,
    timeoutMs: 4 * 60 * 1000
  });
  assert.equal(
    readJson(host.packagePath).version,
    version,
    "installing the AKK artifact must not replace the candidate host"
  );

  const hostRequire = createRequire(path.join(host.dir, "package.json"));
  const testApiPath = hostRequire.resolve(
    "openclaw/plugin-sdk/plugin-test-api"
  );
  const { createTestPluginApi } = await import(
    pathToFileURL(testApiPath).href
  );
  assert.equal(typeof createTestPluginApi, "function");

  let gatewayHandler;
  const api = createTestPluginApi({
    pluginConfig: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {}
    },
    async enqueueNextTurnInjection(injection) {
      return {
        enqueued: true,
        id: "compat-injection",
        sessionKey: injection.sessionKey
      };
    },
    registerGatewayMethod(method, handler) {
      if (method === "agent-knock-knock.callback") {
        gatewayHandler = handler;
      }
    }
  });
  assert.equal(
    typeof api.enqueueNextTurnInjection,
    "function",
    "the boundary host must retain the legacy flat injection API"
  );
  assert.equal(
    typeof api.session?.workflow?.enqueueNextTurnInjection,
    expectSupported ? "function" : "undefined"
  );

  const pluginPath = path.join(
    host.dir,
    "node_modules",
    "@scotthuang",
    "agent-knock-knock",
    "dist",
    "src",
    "openclaw-plugin.js"
  );
  const pluginModule = await import(pathToFileURL(pluginPath).href);
  const plugin = pluginModule.default;
  assert.equal(typeof plugin?.register, "function");
  plugin.register(api);
  assert.equal(typeof gatewayHandler, "function");

  let callbackResponse;
  await gatewayHandler({
    params: callbackParams(`api-${safeName(version)}`),
    respond(ok, result, error) {
      callbackResponse = { ok, result, error };
    }
  });
  assert.notEqual(callbackResponse, undefined);

  if (expectSupported) {
    assert.equal(callbackResponse.ok, true);
    assert.equal(callbackResponse.result?.enqueued, true);
    assert.equal(callbackResponse.result?.delivery_required, false);
    assert.equal(callbackResponse.error, undefined);
  } else {
    assert.equal(callbackResponse.ok, false);
    assert.equal(
      callbackResponse.error?.code,
      "AGENT_KNOCK_KNOCK_CALLBACK_FAILED"
    );
    assert.match(
      callbackResponse.error?.message ?? "",
      /workflow/u,
      "the adjacent boundary must fail on the missing grouped workflow API"
    );
  }

  return {
    target,
    openclaw_version: version,
    result: expectSupported
      ? "api-compatible"
      : "expected-incompatible",
    flat_injection_api: true,
    grouped_injection_api: expectSupported,
    callback: expectSupported ? "passed" : "failed-as-expected",
    incompatibility: expectSupported
      ? null
      : "api.session.workflow.enqueueNextTurnInjection is unavailable"
  };
}
