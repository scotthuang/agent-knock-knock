import { isRecord } from "./value-guards.js";

export interface HerdrOperationSupport {
  state: "available" | "unsupported" | "unknown";
  reason: string;
}

export interface HerdrDeclaredInputContract {
  textInput: HerdrOperationSupport;
  keyInput: HerdrOperationSupport;
  rawTextInput: HerdrOperationSupport;
}

type Schema = Record<string, unknown>;
const ANNOTATIONS = new Set([
  "$comment", "title", "description", "default", "examples", "deprecated"
]);
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * Inspect a CLI declaration, not remote negotiation or proof of execution.
 * Callers must bind its version/protocol to the current server observation.
 * Unknown constraints cannot silently authorize input; no input is probed here.
 */
export function inspectHerdrInputSchema(schema: unknown, protocol: number): HerdrDeclaredInputContract {
  if (!isRecord(schema) || schema.schema_version !== 1 || !isRecord(schema.schemas) ||
      "$id" in schema || (schema.$schema !== undefined && schema.$schema !== DIALECT)) {
    return unavailableContract("unknown", "unrecognized_cli_schema_envelope");
  }
  if (schema.protocol !== protocol) return unavailableContract("unknown", "cli_schema_protocol_mismatch");
  const { request, success_response: success, error_response: error } = schema.schemas;
  if (!isRecord(request) || !isRecord(success) || !isRecord(error)) {
    return unavailableContract("unknown", "cli_schema_envelopes_missing");
  }
  const reader = new HerdrSchemaReader(schema);
  if (!validEnvelopes(reader, request, success, error)) {
    return unavailableContract("unsupported", "cli_schema_request_or_ack_contract_incompatible");
  }
  return {
    textInput: inputOperation(reader, request, "pane.send_input", "text"),
    keyInput: inputOperation(reader, request, "pane.send_input", "keys"),
    rawTextInput: inputOperation(reader, request, "pane.send_text", "text")
  };
}

function unavailableContract(state: HerdrOperationSupport["state"], reason: string): HerdrDeclaredInputContract {
  return { textInput: { state, reason }, keyInput: { state, reason }, rawTextInput: { state, reason } };
}

/** Only the bounded, internal-reference JSON Schema subset used by Herdr. */
class HerdrSchemaReader {
  constructor(private readonly schema: Schema) {}

  deref(value: unknown): Schema | undefined {
    const visited = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      if (!isRecord(value)) return undefined;
      if (!("$ref" in value)) return value;
      const ref = value.$ref;
      if (typeof ref !== "string" || !ref.startsWith("#/schemas/") || visited.has(ref) ||
          !onlyKeys(value, ["$ref"])) return undefined;
      visited.add(ref);
      value = this.pointer(ref);
    }
    return undefined;
  }

  private pointer(ref: string): unknown {
    let value: unknown = this.schema;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isRecord(value) || !Object.hasOwn(value, key) || "$id" in value ||
          (value.$schema !== undefined && value.$schema !== DIALECT)) return undefined;
      value = value[key];
    }
    return value;
  }

  string(value: unknown, constant?: string): boolean {
    const shape = this.deref(value);
    return !!shape && shape.type === "string" &&
      onlyKeys(shape, constant === undefined ? ["type"] : ["type", "const"]) &&
      (constant === undefined || shape.const === constant);
  }

  object(value: unknown, sent: string[], required: string[], extras: string[] = []): Schema | undefined {
    const shape = this.deref(value);
    if (!shape || shape.type !== "object" || !isRecord(shape.properties) ||
        !onlyKeys(shape, ["type", "properties", "required", "$defs", ...extras]) ||
        !Array.isArray(shape.required) ||
        !shape.required.every((key) => typeof key === "string" && sent.includes(key)) ||
        !required.every((key) => (shape.required as unknown[]).includes(key))) return undefined;
    return shape;
  }

  // Unknown branches can overlap. Exclude only a provably different discriminator.
  possibleVariants(variants: unknown, key: string, expected: string): unknown[] {
    if (!Array.isArray(variants)) return [];
    return variants.filter((value) => {
      const shape = this.deref(value);
      const discriminator = shape && isRecord(shape.properties) ? this.deref(shape.properties[key]) : undefined;
      return !discriminator || typeof discriminator.const !== "string" || discriminator.const === expected;
    });
  }
}

function property(shape: Schema, key: string): unknown {
  return isRecord(shape.properties) ? shape.properties[key] : undefined;
}

function validEnvelopes(reader: HerdrSchemaReader, request: Schema, success: Schema, error: Schema): boolean {
  const req = reader.object(request, ["id", "method", "params"], ["id"], ["oneOf"]);
  const ack = reader.object(success, ["id", "result"], ["id", "result"]);
  const err = reader.object(error, ["id", "error"], ["id", "error"]);
  if (!req || !ack || !err || !Array.isArray(req.oneOf) ||
      Object.keys(req.properties as object).some((key) => key !== "id")) return false;
  const body = reader.object(property(err, "error"), ["code", "message"], ["code", "message"]);
  const result = reader.deref(property(ack, "result"));
  if (!body || !result || !onlyKeys(result, ["oneOf"])) return false;
  const oks = reader.possibleVariants(result.oneOf, "type", "ok");
  const ok = oks.length === 1 && reader.object(oks[0], ["type"], ["type"]);
  return !!ok && reader.string(property(ok, "type"), "ok") &&
    [req, ack, err].every((shape) => reader.string(property(shape, "id"))) &&
    reader.string(property(body, "code")) && reader.string(property(body, "message"));
}

function inputOperation(reader: HerdrSchemaReader, request: Schema, method: string, field: "text" | "keys"): HerdrOperationSupport {
  const unavailable = (detail: string): HerdrOperationSupport => ({
    state: "unsupported", reason: `cli_schema_${method}_${field}_${detail}`
  });
  const variants = reader.possibleVariants(request.oneOf, "method", method);
  if (variants.length !== 1) return unavailable("method_missing_or_ambiguous");
  const variant = reader.object(variants[0], ["method", "params"], ["method", "params"]);
  if (!variant || !reader.string(property(variant, "method"), method)) return unavailable("request_incompatible");
  if (Object.keys(variant.properties as object).some((key) => !["method", "params"].includes(key))) {
    return unavailable("unrecognized_envelope_constraint");
  }
  const params = reader.deref(property(variant, "params"));
  if (params?.additionalProperties !== undefined && typeof params.additionalProperties !== "boolean") {
    return unavailable("unknown_additional_properties_constraint");
  }
  // additionalProperties=false is safe here: every field we send is declared.
  const shape = reader.object(params, ["pane_id", field], ["pane_id"], ["additionalProperties"]);
  if (!shape) return unavailable("params_incompatible");
  if (!reader.string(property(shape, "pane_id"))) return unavailable("pane_identity_incompatible");
  if (!validPayload(reader, property(shape, field), field)) return unavailable("payload_incompatible");
  return { state: "available", reason: "matching_cli_schema" };
}

function validPayload(reader: HerdrSchemaReader, value: unknown, field: "text" | "keys"): boolean {
  if (field === "text") return reader.string(value);
  const keys = reader.deref(value);
  return !!keys && keys.type === "array" && onlyKeys(keys, ["type", "items"]) && reader.string(keys.items);
}

function onlyKeys(value: Schema, keys: string[]): boolean {
  return Object.keys(value).every((key) => ANNOTATIONS.has(key) || keys.includes(key) ||
    (key === "$schema" && value[key] === DIALECT));
}
