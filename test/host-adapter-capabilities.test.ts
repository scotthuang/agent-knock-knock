import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_ADAPTER_CAPABILITY_CONTRACT,
  HOST_ADAPTER_CAPABILITY_VERSION,
  createHostAdapterCapabilityHandshake,
  verifyHostAdapterCapabilityHandshake,
  type HostAdapterCapabilityCommand,
  type HostAdapterCapabilityTool
} from "../src/host-adapter-capabilities.js";

const command: HostAdapterCapabilityCommand = Object.freeze({
  name: "akk",
  description: "AKK command",
  acceptsArgs: true
});
const skill = "---\nname: agent-knock-knock\n---\n\n# AKK\n";

test("Host adapter capability handshake is stable, versioned, and secretless", () => {
  const tools = [tool("one"), tool("two")];
  const handshake = createHostAdapterCapabilityHandshake({ command, tools }, skill);

  assert.deepEqual(handshake, {
    contract: HOST_ADAPTER_CAPABILITY_CONTRACT,
    version: HOST_ADAPTER_CAPABILITY_VERSION,
    catalogDigest:
      "sha256:66ed9169de7bd6f1c2b5241d2a94dd43e38f02c93adece91ff9a7bc85534d163",
    toolCount: 2,
    toolNames: ["agent_knock_knock_one", "agent_knock_knock_two"],
    skillName: "agent-knock-knock",
    skillDigest:
      "sha256:32c31566fe87affda10c0e77f9c61564534a99798996ec4fb4b73a00f74d0c9f"
  });
  assert.equal(Object.isFrozen(handshake), true);
  assert.equal(Object.isFrozen(handshake.toolNames), true);
  assert.doesNotMatch(JSON.stringify(handshake), /token|secret|environment|path/iu);
  assert.equal(
    verifyHostAdapterCapabilityHandshake(
      { command, tools, capabilityHandshake: handshake },
      skill,
      handshake.toolNames
    ),
    handshake
  );
});

test("catalog changes derive count and digest without a count declaration", () => {
  const one = createHostAdapterCapabilityHandshake({
    command,
    tools: [tool("one")]
  }, skill);
  const three = createHostAdapterCapabilityHandshake({
    command,
    tools: [tool("one"), tool("two"), tool("three")]
  }, skill);

  assert.equal(one.toolCount, 1);
  assert.deepEqual(one.toolNames, ["agent_knock_knock_one"]);
  assert.equal(three.toolCount, 3);
  assert.deepEqual(three.toolNames, [
    "agent_knock_knock_one",
    "agent_knock_knock_two",
    "agent_knock_knock_three"
  ]);
  assert.notEqual(one.catalogDigest, three.catalogDigest);
});

test("handshake rejects missing, unknown, forged, Skill, and registration drift", () => {
  const tools = [tool("one"), tool("two")];
  const handshake = createHostAdapterCapabilityHandshake({ command, tools }, skill);
  const source = { command, tools, capabilityHandshake: handshake };

  assert.throws(
    () => verifyHostAdapterCapabilityHandshake({ command, tools }, skill),
    /handshake is missing/u
  );
  assert.throws(
    () => verifyHostAdapterCapabilityHandshake({
      command,
      tools,
      capabilityHandshake: { ...handshake, version: 2 }
    }, skill),
    /unsupported Host adapter capability handshake version 2/u
  );
  assert.throws(
    () => verifyHostAdapterCapabilityHandshake({
      command,
      tools,
      capabilityHandshake: {
        ...handshake,
        catalogDigest: `sha256:${"0".repeat(64)}`
      }
    }, skill),
    /catalog digest drifted/u
  );
  assert.throws(
    () => verifyHostAdapterCapabilityHandshake(source, `${skill}\ndrift\n`),
    /Skill digest drifted/u
  );
  assert.throws(
    () => verifyHostAdapterCapabilityHandshake(source, skill, [
      "agent_knock_knock_two",
      "agent_knock_knock_one"
    ]),
    /registered tool names do not match/u
  );
});

test("catalog digest is independent of JSON object insertion order", () => {
  const forward = tool("one", {
    type: "object",
    properties: { first: { type: "string" }, second: { type: "number" } }
  });
  const reverse = tool("one", {
    properties: { second: { type: "number" }, first: { type: "string" } },
    type: "object"
  });

  assert.equal(
    createHostAdapterCapabilityHandshake({ command, tools: [forward] }, skill)
      .catalogDigest,
    createHostAdapterCapabilityHandshake({ command, tools: [reverse] }, skill)
      .catalogDigest
  );
});

function tool(
  suffix: string,
  inputSchema: Readonly<Record<string, unknown>> = {
    type: "object",
    additionalProperties: false
  }
): HostAdapterCapabilityTool {
  return Object.freeze({
    name: `agent_knock_knock_${suffix}`,
    description: `AKK ${suffix}`,
    inputSchema
  });
}
