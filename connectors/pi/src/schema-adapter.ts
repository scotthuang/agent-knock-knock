import { Ajv, type ValidateFunction } from "ajv";
import { Type, type TSchema } from "typebox";

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
 * Project AKK schemas into Pi's provider-facing TypeBox subset. The untouched
 * schema remains authoritative at execution time through AJV and AKK itself.
 */
export function adaptHostToolInputSchema(
  schema: Readonly<Record<string, unknown>>,
): TSchema {
  const adapted = adaptNode(schema);
  if (adapted.type !== "object") {
    throw new Error("AKK Host tool input schema must have an object root");
  }
  return Type.Unsafe<Record<string, unknown>>(adapted);
}

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
  if (!type) return output;
  output.type = type;

  if (type === "object") {
    const inputProperties = isRecord(value.properties) ? value.properties : {};
    const properties: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(inputProperties)) {
      properties[name] = adaptNode(property);
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
