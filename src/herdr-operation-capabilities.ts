import { inspectHerdrInputSchema } from "./herdr-api-contract.js";
import { TerminalControlInputNotSentError } from "./terminal-control-provider.js";
import type {
  TerminalControlCapability, TerminalEndpointRef, TerminalProviderCapability
} from "./terminal-control-ref.js";
import type {
  HerdrOperationCapability,
  HerdrOperationCapabilities,
  HerdrServerObservation
} from "./herdr-compatibility.js";

export interface HerdrCliObservation {
  version?: string;
  schema?: unknown;
  schemaState: "available" | "unavailable" | "malformed";
}

export function declaredHerdrInputCapabilities(
  cli: HerdrCliObservation,
  server: HerdrServerObservation
): Pick<HerdrOperationCapabilities, "textInput" | "keyInput" | "rawTextInput"> {
  const mismatched = cli.version !== server.version;
  if (mismatched || cli.schemaState === "unavailable") {
    const capability: HerdrOperationCapability = server.baselineKnown
      ? { state: "available", reason: "verified release input behavior; no matching CLI schema", evidence: "verified_release" }
      : { state: "unknown", reason: "no matching CLI schema or verified input behavior", evidence: "none" };
    return { textInput: capability, keyInput: capability, rawTextInput: capability };
  }
  const declaration = inspectHerdrInputSchema(cli.schema, server.protocol);
  const capability = (support: { state: HerdrOperationCapability["state"]; reason: string }): HerdrOperationCapability => ({
    ...support,
    evidence: support.state === "unknown" ? "none" : "matching_cli_schema"
  });
  return {
    textInput: capability(declaration.textInput),
    keyInput: capability(declaration.keyInput),
    rawTextInput: capability(declaration.rawTextInput)
  };
}

export function herdrControlCapabilities(
  operations: HerdrOperationCapabilities
): TerminalControlCapability[] {
  const readable = [operations.visibleText, operations.detectionText]
    .some((capability) => capability.state === "available");
  // Public Send is a composite text+Enter operation. Keep detailed partial
  // input support in diagnostics instead of advertising an unusable Send.
  const sendable = operations.textInput.state === "available" &&
    operations.keyInput.state === "available";
  return [
    ...(readable ? ["screen_status", "screen_completion"] as const : []),
    "durable_completion",
    ...(sendable ? ["send_keys", "terminal_approval", "terminal_cancel"] as const : [])
  ];
}

export function assertOperationAvailable(
  capabilities: HerdrOperationCapabilities,
  operation: keyof HerdrOperationCapabilities
): void {
  const capability = capabilities[operation];
  if (capability.state !== "available") {
    throw new Error(`Herdr ${operation} is ${capability.state}: ${capability.reason}`);
  }
}

export function assertInputEndpointCapability(
  terminal: TerminalEndpointRef,
  providerCapabilities: readonly TerminalProviderCapability[],
  providerCapability: "text_delivery" | "key_delivery",
  operations?: HerdrOperationCapabilities
): void {
  if (terminal.identity.providerKind !== "herdr") {
    throw new TerminalControlInputNotSentError(
      `terminal control provider herdr cannot use ${terminal.identity.providerKind}`
    );
  }
  if (!terminal.capabilities.includes("send_keys")) {
    const detail = operations ? (["textInput", "keyInput"] as const)
      .filter((operation) => operations[operation].state !== "available")
      .map((operation) => `${operation} is ${operations[operation].state}: ${operations[operation].reason}`)
      .join("; ") : "";
    throw new TerminalControlInputNotSentError(
      `Herdr terminal does not permit send_keys${detail ? `; ${detail}` : ""}`
    );
  }
  if (!providerCapabilities.includes(providerCapability)) {
    throw new TerminalControlInputNotSentError(
      `Herdr provider does not support ${providerCapability}`
    );
  }
}

/** Prefer agent detection for plain status; visible text is a bounded fallback. */
export function selectHerdrReadOperation(
  capabilities: HerdrOperationCapabilities,
  viewportOnly: boolean,
  preserveEscapes: boolean
): {
  source: "visible" | "detection";
  format: "text" | "ansi";
  operation: "visibleText" | "visibleAnsi" | "detectionText";
} {
  if (preserveEscapes) return { source: "visible", format: "ansi", operation: "visibleAnsi" };
  if (viewportOnly || (capabilities.detectionText.state !== "available" &&
      capabilities.visibleText.state === "available")) {
    return { source: "visible", format: "text", operation: "visibleText" };
  }
  return { source: "detection", format: "text", operation: "detectionText" };
}
