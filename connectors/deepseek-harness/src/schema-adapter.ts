import { Ajv, type ValidateFunction } from "ajv";
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";

export type AssertSupportedJsonSchema =
  typeof import("@deepseek-ai/dsh-tools")["assertSupportedJsonSchema"];

const SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

/**
 * Project an AKK input schema into the supported DSH discovery subset.
 *
 * Unsupported conditional and scalar constraints are omitted only from the
 * model-facing discovery copy. Object shape, declared property types, enums,
 * constants, unconditional required fields, and closed-object boundaries are
 * retained. The untouched AKK schema remains authoritative and is compiled by
 * {@link compileAuthoritativeInputValidator} before any Host Adapter execution.
 */
export function adaptHostToolInputSchema(
  schema: Readonly<Record<string, unknown>>,
  assertSupportedJsonSchema: AssertSupportedJsonSchema,
): Readonly<Record<string, unknown>> {
  const adapted = adaptNode(schema);
  if (adapted.type !== "object") {
    throw new Error("AKK Host tool input schema must have an object root");
  }
  assertSupportedJsonSchema(adapted);
  return Object.freeze(adapted);
}

/** Compile the complete, unmodified AKK JSON Schema as the execution gate. */
export function compileAuthoritativeInputValidator(
  schema: Readonly<Record<string, unknown>>,
): (value: unknown) => void {
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(structuredClone(schema));
  } catch {
    throw new Error("AKK Host tool exposed an invalid authoritative input schema");
  }
  return (value: unknown): void => {
    if (!validate(value)) {
      // Do not reflect schema internals, regexes, or private authority details
      // into a model-facing error. Root AKK validation remains the final gate.
      throw new Error("arguments did not match the authoritative AKK tool schema");
    }
  };
}

function adaptNode(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  if (typeof value.description === "string") output.description = value.description;
  if (typeof value.title === "string") output.title = value.title;

  const type = typeof value.type === "string" && SCHEMA_TYPES.has(value.type)
    ? value.type
    : undefined;
  if (!type) {
    // AKK uses condition-only branches under oneOf/anyOf/not. DSH cannot
    // represent those branches, so this node remains annotation-only and the
    // authoritative execution validator enforces the original condition.
    return output;
  }
  output.type = type;

  if (type === "object") {
    const inputProperties = isRecord(value.properties) ? value.properties : {};
    const properties: Record<string, JsonSchemaNode> = {};
    for (const [name, property] of Object.entries(inputProperties)) {
      properties[name] = adaptNode(property) as JsonSchemaNode;
    }
    output.properties = properties;
    if (Array.isArray(value.required)) {
      const required = value.required.filter(
        (name): name is string =>
          typeof name === "string" && Object.hasOwn(properties, name),
      );
      if (required.length > 0) output.required = required;
    }
    if (typeof value.additionalProperties === "boolean") {
      output.additionalProperties = value.additionalProperties;
    }
    return output;
  }

  if (type === "array" && isRecord(value.items)) {
    output.items = adaptNode(value.items);
  }
  if (Array.isArray(value.enum)) output.enum = structuredClone(value.enum);
  if (Object.hasOwn(value, "const")) output.const = structuredClone(value.const);
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
