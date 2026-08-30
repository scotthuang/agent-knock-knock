import assert from "node:assert/strict";
import test from "node:test";

import { createHostAdapter } from "@scotthuang/agent-knock-knock/host-adapter";
import { Compile } from "typebox/compile";

import {
  adaptHostToolInputSchema,
  compileAuthoritativeInputValidator,
} from "../src/schema-adapter.js";

test("adapts every AKK HostAdapter tool schema for Pi 0.84.4", async () => {
  const adapter = createHostAdapter({
    environmentForContext: () => process.env,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    assert.equal(adapter.tools.length, 16);
    for (const metadata of adapter.tools) {
      const schema = adaptHostToolInputSchema(metadata.inputSchema);
      assert.doesNotThrow(() => Compile(schema), metadata.name);
      assert.doesNotThrow(
        () => compileAuthoritativeInputValidator(metadata.inputSchema),
        metadata.name,
      );
    }
  } finally {
    await adapter.lifecycle.stop();
  }
});

test("keeps the original AKK schema authoritative at execution time", () => {
  const validate = compileAuthoritativeInputValidator({
    type: "object",
    additionalProperties: false,
    required: ["terminal_id"],
    properties: {
      terminal_id: { type: "string", pattern: "^terminal:v[0-9]+:" },
    },
  });

  assert.doesNotThrow(() => validate({ terminal_id: "terminal:v2:test" }));
  assert.throws(() => validate({ terminal_id: "guessed" }), /did not match/u);
  assert.throws(
    () => validate({ terminal_id: "terminal:v2:test", hidden: true }),
    /did not match/u,
  );
});
