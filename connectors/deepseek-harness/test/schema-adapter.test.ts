import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";
import { createHostAdapter } from "@scotthuang/agent-knock-knock/host-adapter";

import {
  adaptHostToolInputSchema,
  compileAuthoritativeInputValidator,
} from "../src/schema-adapter.js";

test("all 22 real AKK schemas pass the shared supported DSH validator", async () => {
  const adapter = createHostAdapter({
    environmentForContext: () => ({}),
    lifecycleEnvironment: {},
    logger: { info() {}, warn() {} },
  });
  try {
    assert.equal(adapter.tools.length, 22);
    assert.equal(
      catalogDigest(adapter),
      "f469d4e7320c789a48ca106e3a89a5f81815d4da7c14920bfd11d25fdf598a98"
    );
    for (const tool of adapter.tools) {
      const discovery = adaptHostToolInputSchema(
        tool.inputSchema,
        assertSupportedJsonSchema,
      );
      assert.doesNotThrow(() => assertSupportedJsonSchema(discovery), tool.name);
      assert.doesNotThrow(
        () => compileAuthoritativeInputValidator(tool.inputSchema),
        tool.name,
      );
    }
  } finally {
    await adapter.lifecycle.stop();
  }
});

function catalogDigest(adapter: ReturnType<typeof createHostAdapter>): string {
  return createHash("sha256").update(JSON.stringify({
    command: [
      adapter.command.name,
      adapter.command.description,
      adapter.command.acceptsArgs
    ],
    tools: adapter.tools.map((tool) => [
      tool.name,
      tool.description,
      tool.inputSchema
    ])
  })).digest("hex");
}

test("discovery projection may omit unsupported conditions but execution does not", async () => {
  const adapter = createHostAdapter({
    environmentForContext: () => ({}),
    lifecycleEnvironment: {},
    logger: { info() {}, warn() {} },
  });
  try {
    const send = adapter.tools.find((tool) =>
      tool.name === "agent_knock_knock_send"
    );
    assert.ok(send);
    const discovery = adaptHostToolInputSchema(
      send.inputSchema,
      assertSupportedJsonSchema,
    );
    assertSupportedJsonSchema(discovery);
    const validateAuthoritative = compileAuthoritativeInputValidator(
      send.inputSchema,
    );

    assert.deepEqual(validateJsonSchemaValue(discovery, { request: "work" }), []);
    assert.doesNotThrow(() => validateAuthoritative({ request: "work" }));

    const conditionallyInvalid = { request: "", turn_id: "turn:fake" };
    assert.deepEqual(
      validateJsonSchemaValue(discovery, conditionallyInvalid),
      [],
      "the discovery subset intentionally cannot encode minLength + oneOf/not",
    );
    assert.throws(
      () => validateAuthoritative(conditionallyInvalid),
      /authoritative AKK tool schema/u,
    );

    assert.notDeepEqual(
      validateJsonSchemaValue(discovery, { request: "work", injected: true }),
      [],
      "closed object shape remains enforced by DSH discovery",
    );
    assert.throws(
      () => validateAuthoritative({ request: "work", injected: true }),
      /authoritative AKK tool schema/u,
    );
  } finally {
    await adapter.lifecycle.stop();
  }
});
