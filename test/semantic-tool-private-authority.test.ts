import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertOnlyModelControlParameters
} from "../src/semantic-tool-private-authority.js";
import {
  authoritativeManagedId,
  pushOptional,
  requiredTerminalInteractionIdentifier
} from "../src/semantic-tool-arguments.js";

test("semantic private authority accepts only typed model-control inputs", () => {
  assert.doesNotThrow(() => assertOnlyModelControlParameters(
    { terminal_id: "terminal:v2:tmux:codex:test:0.0:123" },
    ["terminal_id"],
    "model_options"
  ));
  assert.throws(
    () => assertOnlyModelControlParameters(
      {
        terminal_id: "terminal:v2:tmux:codex:test:0.0:123",
        raw_keys: ["Enter"]
      },
      ["terminal_id"],
      "model_options"
    ),
    /accepts only typed semantic fields/u
  );
});

test("semantic argument encoding preserves public validation boundaries", () => {
  const args = ["status"];
  pushOptional(args, "--store-dir", "/tmp/akk-store");
  pushOptional(args, "--unused", undefined);
  assert.deepEqual(args, ["status", "--store-dir", "/tmp/akk-store"]);
  assert.equal(authoritativeManagedId("turn-20260915-a", "turn_id"), "turn-20260915-a");
  assert.throws(
    () => authoritativeManagedId("terminal:v2:tmux:codex:test:0.0:123", "turn_id"),
    /authoritative managed id/u
  );
  assert.equal(
    requiredTerminalInteractionIdentifier("ti_123:step-2", "interaction_id"),
    "ti_123:step-2"
  );
  assert.throws(
    () => requiredTerminalInteractionIdentifier("unsafe input", "interaction_id"),
    /exact safe interaction identifier/u
  );
});

test("runtime composes private authority without a reverse dependency", () => {
  const runtimeSource = fs.readFileSync("src/semantic-tool-runtime.ts", "utf8");
  const privateAuthoritySource = fs.readFileSync(
    "src/semantic-tool-private-authority.ts",
    "utf8"
  );
  const argumentsSource = fs.readFileSync(
    "src/semantic-tool-arguments.ts",
    "utf8"
  );

  assert.match(runtimeSource, /from "\.\/semantic-tool-private-authority\.js"/u);
  assert.match(runtimeSource, /from "\.\/semantic-tool-arguments\.js"/u);
  assert.doesNotMatch(runtimeSource, /openclaw-private-authority-offers/u);
  assert.doesNotMatch(runtimeSource, /function privateActionArguments/u);
  assert.doesNotMatch(privateAuthoritySource, /semantic-tool-runtime/u);
  assert.doesNotMatch(privateAuthoritySource, /openclaw-plugin-command-adapter/u);
  assert.doesNotMatch(privateAuthoritySource, /openclaw-plugin-schemas/u);
  assert.doesNotMatch(argumentsSource, /semantic-tool-runtime/u);
  assert.doesNotMatch(argumentsSource, /openclaw-plugin-/u);
});
