import assert from "node:assert/strict";
import test from "node:test";
import { inspectHerdrInputSchema } from "../src/herdr-api-contract.js";

import { herdrApiSchemaFixture as declaration } from "./support/herdr-api-schema.js";

test("input declarations do not whitelist private protocol numbers", () => {
  for (const protocol of [19, 22, 9876]) {
    const result = inspectHerdrInputSchema(declaration(protocol), protocol);
    assert.deepEqual(Object.values(result).map((x) => x.state), ["available", "available", "available"]);
    assert.equal(result.textInput.reason, "matching_cli_schema");
  }
  assert.equal(inspectHerdrInputSchema(declaration(19), 22).textInput.state, "unknown");
});

test("missing raw navigation does not revoke normal text and Enter declarations", () => {
  const schema = declaration();
  schema.schemas.request.oneOf.pop();
  const result = inspectHerdrInputSchema(schema, 22);
  assert.equal(result.textInput.state, "available");
  assert.equal(result.keyInput.state, "available");
  assert.equal(result.rawTextInput.state, "unsupported");
});

test("new required input fields and constraints fail the affected declaration", () => {
  for (const mutate of [
    (schema: ReturnType<typeof declaration>) => schema.schemas.request.oneOf[0]!.properties.params.required.push("confirmation"),
    (schema: ReturnType<typeof declaration>) => Object.assign(schema.schemas.request.oneOf[0]!.properties.params.properties.text, { maxLength: 4 }),
    (schema: ReturnType<typeof declaration>) => Object.assign(schema.schemas.request.oneOf[0]!.properties.params, { not: {} })
  ]) {
    const schema = declaration(); mutate(schema);
    const result = inspectHerdrInputSchema(schema, 22);
    assert.equal(result.textInput.state, "unsupported");
    assert.equal(result.rawTextInput.state, "available");
  }
  const schema = declaration();
  schema.schemas.request.oneOf[0]!.properties.params.required.push("text");
  assert.equal(inspectHerdrInputSchema(schema, 22).textInput.state, "available");
  assert.equal(inspectHerdrInputSchema(schema, 22).keyInput.state, "unsupported");
});

test("ambiguous methods or changed acknowledgement contract never authorize writes", () => {
  const duplicate = declaration();
  duplicate.schemas.request.oneOf.push(structuredClone(duplicate.schemas.request.oneOf[0]!));
  assert.equal(inspectHerdrInputSchema(duplicate, 22).textInput.state, "unsupported");
  const changed = declaration();
  changed.schemas.success_response.properties.result.oneOf[0]!.properties.type.const = "queued";
  assert.ok(Object.values(inspectHerdrInputSchema(changed, 22)).every((x) => x.state === "unsupported"));
  const constrained = declaration();
  Object.assign(constrained.schemas.request.properties, { method: { const: "ping" } });
  assert.equal(inspectHerdrInputSchema(constrained, 22).textInput.state, "unsupported");
  for (const target of ["request", "success"] as const) {
    const overlapping = declaration();
    const branches: unknown[] = target === "request" ? overlapping.schemas.request.oneOf :
      overlapping.schemas.success_response.properties.result.oneOf;
    branches.push({});
    assert.equal(inspectHerdrInputSchema(overlapping, 22).textInput.state, "unsupported");
  }
});

test("only bounded internal schema references are followed", () => {
  const schema = declaration();
  const params = schema.schemas.request.oneOf[0]!.properties.params;
  Object.assign(schema.schemas.request, { $defs: { Input: params } });
  Object.assign(schema.schemas.request.oneOf[0]!.properties, { params: { $ref: "#/schemas/request/$defs/Input" } });
  assert.equal(inspectHerdrInputSchema(schema, 22).textInput.state, "available");
  const scoped = structuredClone(schema);
  Object.assign(scoped.schemas.request.oneOf[0]!.properties.params, { $id: "urn:changed-scope" });
  assert.equal(inspectHerdrInputSchema(scoped, 22).textInput.state, "unsupported");
  const ancestorScope = structuredClone(schema);
  Object.assign(ancestorScope.schemas.request, { $defs: { Nested: { $id: "urn:nested", $defs: { Input: params } } } });
  Object.assign(ancestorScope.schemas.request.oneOf[0]!.properties, { params: { $ref: "#/schemas/request/$defs/Nested/$defs/Input" } });
  assert.equal(inspectHerdrInputSchema(ancestorScope, 22).textInput.state, "unsupported");
  for (const ref of ["https://invalid.example/schema", "#/schemas/request/$defs/Cycle"]) {
    Object.assign(schema.schemas.request, { $defs: { Input: { $ref: ref }, Cycle: { $ref: ref } } });
    assert.equal(inspectHerdrInputSchema(schema, 22).textInput.state, "unsupported");
  }
});

test("unrecognized schemas remain unknown instead of claiming support", () => {
  for (const schema of [null, {}, { ...declaration(), schema_version: 2 },
    { ...declaration(), $schema: "https://unknown.example/dialect" }]) {
    assert.ok(Object.values(inspectHerdrInputSchema(schema, 22)).every((x) => x.state === "unknown"));
  }
});
