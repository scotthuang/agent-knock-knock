import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../src/canonical-json.js";

test("canonical JSON preserves sorted record and legacy scalar semantics", () => {
  assert.equal(
    canonicalJson({ z: 1, a: [true, { c: null, b: "value" }] }),
    '{"a":[true,{"b":"value","c":null}],"z":1}'
  );
  assert.equal(canonicalJson(undefined), "undefined");
  assert.equal(canonicalJson(Number.NaN), "null");
});

test("canonical JSON keeps arrays distinct and preserves legacy object handling", () => {
  assert.equal(canonicalJson([3, 2, 1]), "[3,2,1]");
  assert.equal(canonicalJson(new Date("2026-08-14T00:00:00.000Z")), "{}");
});
