import assert from "node:assert/strict";
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

test("all 16 real AKK schemas pass the shared supported DSH validator", async () => {
  const adapter = createHostAdapter({
    environmentForContext: () => ({}),
    lifecycleEnvironment: {},
    logger: { info() {}, warn() {} },
  });
  try {
    assert.equal(adapter.tools.length, 16);
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
