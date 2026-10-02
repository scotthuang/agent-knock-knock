import assert from "node:assert/strict";
import {
  manifest
} from "./configuration.js";
import {
  requiredStringArray,
  sorted
} from "./command-runtime.js";

export function assertRuntimeContract(inspect) {
  const plugin = inspect.plugin ?? {};
  assert.equal(plugin.status, "loaded");
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.imported, true);
  assert.equal(plugin.configSchema, true);
  const diagnostics = Array.isArray(plugin.diagnostics)
    ? plugin.diagnostics
    : Array.isArray(inspect.diagnostics)
      ? inspect.diagnostics
      : [];
  assert.deepEqual(
    diagnostics.filter((entry) => entry?.level === "error"),
    [],
    "runtime inspect must not report error diagnostics"
  );
  assert.deepEqual(
    normalizedToolNames(inspect),
    sorted(requiredStringArray(manifest.contracts?.tools, "contracts.tools"))
  );
  assert.equal(
    normalizedNames(plugin.commands ?? inspect.commands).includes("akk"),
    true
  );
  assert.equal(
    normalizedNames(plugin.services ?? inspect.services).includes(
      "agent-knock-knock-monitor-reconciliation"
    ),
    true
  );
  assert.equal(
    normalizedNames(
      plugin.gatewayMethods ?? inspect.gatewayMethods
    ).includes("agent-knock-knock.callback"),
    true
  );
}

export function normalizedToolNames(inspect) {
  const direct = inspect.plugin?.toolNames;
  if (Array.isArray(direct)) {
    return sorted(direct.filter((value) => typeof value === "string"));
  }
  const tools = Array.isArray(inspect.tools) ? inspect.tools : [];
  return sorted(
    tools.flatMap((tool) =>
      Array.isArray(tool?.names)
        ? tool.names.filter((value) => typeof value === "string")
        : []
    )
  );
}

function normalizedNames(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    if (typeof entry?.name === "string") {
      return [entry.name];
    }
    return [];
  });
}

export function callbackParams(suffix) {
  return {
    sessionKey: `agent:main:${suffix}`,
    conversation: {
      conversation_id: `compat-${suffix}`,
      openclaw_session: `agent:main:${suffix}`
    },
    message: {
      id: `message-${suffix}`,
      conversation_id: `compat-${suffix}`,
      type: "progress",
      requires_response: false,
      round: 1,
      body: "OpenClaw compatibility callback"
    }
  };
}

export function hasAkkCommand(result) {
  const commands = Array.isArray(result)
    ? result
    : Array.isArray(result?.commands)
      ? result.commands
      : [];
  return commands.some((command) => {
    if (typeof command === "string") {
      return command.replace(/^\//u, "") === "akk";
    }
    const name = command?.name ?? command?.command ?? command?.key;
    return typeof name === "string" && name.replace(/^\//u, "") === "akk";
  });
}
