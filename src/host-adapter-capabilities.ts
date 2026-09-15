import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";

export const HOST_ADAPTER_CAPABILITY_CONTRACT =
  "agent-knock-knock/host-adapter-capabilities";
export const HOST_ADAPTER_CAPABILITY_VERSION = 1;
export const HOST_ADAPTER_SKILL_NAME = "agent-knock-knock";

export interface HostAdapterCapabilityCommand {
  readonly name: string;
  readonly description: string;
  readonly acceptsArgs: boolean;
}

export interface HostAdapterCapabilityTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** Stable, secretless compatibility proof exchanged with native Host connectors. */
export interface HostAdapterCapabilityHandshakeV1 {
  readonly contract: typeof HOST_ADAPTER_CAPABILITY_CONTRACT;
  readonly version: typeof HOST_ADAPTER_CAPABILITY_VERSION;
  readonly catalogDigest: string;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly skillName: typeof HOST_ADAPTER_SKILL_NAME;
  readonly skillDigest: string;
}

export interface HostAdapterCapabilitySource {
  readonly command: HostAdapterCapabilityCommand;
  readonly tools: readonly HostAdapterCapabilityTool[];
  readonly capabilityHandshake?: unknown;
}

const HANDSHAKE_KEYS = Object.freeze([
  "catalogDigest",
  "contract",
  "skillDigest",
  "skillName",
  "toolCount",
  "toolNames",
  "version"
]);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

/** Derive the v1 handshake from the authoritative ordered catalog and Skill. */
export function createHostAdapterCapabilityHandshake(
  source: Pick<HostAdapterCapabilitySource, "command" | "tools">,
  skillDocument: string
): HostAdapterCapabilityHandshakeV1 {
  const toolNames = Object.freeze(source.tools.map((tool) => tool.name));
  validateCatalogMetadata(source.command, source.tools);
  requiredSkillDocument(skillDocument);
  return Object.freeze({
    contract: HOST_ADAPTER_CAPABILITY_CONTRACT,
    version: HOST_ADAPTER_CAPABILITY_VERSION,
    catalogDigest: catalogDigest(source.command, source.tools),
    toolCount: toolNames.length,
    toolNames,
    skillName: HOST_ADAPTER_SKILL_NAME,
    skillDigest: sha256(skillDocument)
  });
}

/**
 * Fail closed unless one adapter, bundled Skill, and completed registration
 * agree with the exact supported handshake version.
 */
export function verifyHostAdapterCapabilityHandshake(
  source: HostAdapterCapabilitySource,
  skillDocument: string,
  registeredToolNames?: readonly string[]
): HostAdapterCapabilityHandshakeV1 {
  const candidate = source.capabilityHandshake;
  if (!isRecord(candidate)) {
    throw new Error("Host adapter capability handshake is missing");
  }
  if (candidate.version !== HOST_ADAPTER_CAPABILITY_VERSION) {
    throw new Error(
      `unsupported Host adapter capability handshake version ${String(candidate.version)}`
    );
  }
  assertExactKeys(candidate, HANDSHAKE_KEYS);
  if (candidate.contract !== HOST_ADAPTER_CAPABILITY_CONTRACT) {
    throw new Error("Host adapter capability handshake contract does not match");
  }
  if (candidate.skillName !== HOST_ADAPTER_SKILL_NAME) {
    throw new Error("Host adapter capability handshake Skill name does not match");
  }
  if (!SHA256_DIGEST.test(stringValue(candidate.catalogDigest))) {
    throw new Error("Host adapter capability handshake catalog digest is invalid");
  }
  if (!SHA256_DIGEST.test(stringValue(candidate.skillDigest))) {
    throw new Error("Host adapter capability handshake Skill digest is invalid");
  }
  if (
    typeof candidate.toolCount !== "number" ||
    !Number.isSafeInteger(candidate.toolCount) ||
    candidate.toolCount < 0
  ) {
    throw new Error("Host adapter capability handshake tool count is invalid");
  }
  if (
    !Array.isArray(candidate.toolNames) ||
    candidate.toolNames.some((name) => typeof name !== "string")
  ) {
    throw new Error("Host adapter capability handshake tool names are invalid");
  }

  const expected = createHostAdapterCapabilityHandshake(source, skillDocument);
  assertHandshakeMatches(candidate, expected);
  if (registeredToolNames !== undefined) {
    assertExactToolNames(
      registeredToolNames,
      expected.toolNames,
      "Host connector registered tool names"
    );
  }
  return candidate as unknown as HostAdapterCapabilityHandshakeV1;
}

function validateCatalogMetadata(
  command: HostAdapterCapabilityCommand,
  tools: readonly HostAdapterCapabilityTool[]
): void {
  requiredString(command.name, "Host adapter command name");
  requiredString(command.description, "Host adapter command description");
  if (typeof command.acceptsArgs !== "boolean") {
    throw new Error("Host adapter command acceptsArgs is invalid");
  }
  const names = new Set<string>();
  for (const tool of tools) {
    const name = requiredString(tool.name, "Host adapter tool name");
    requiredString(tool.description, `Host adapter tool ${name} description`);
    if (!isRecord(tool.inputSchema)) {
      throw new Error(`Host adapter tool ${name} input schema is invalid`);
    }
    if (names.has(name)) {
      throw new Error(`duplicate Host adapter tool ${name}`);
    }
    names.add(name);
  }
}

function assertHandshakeMatches(
  actual: Readonly<Record<string, unknown>>,
  expected: HostAdapterCapabilityHandshakeV1
): void {
  if (actual.catalogDigest !== expected.catalogDigest) {
    throw new Error("Host adapter capability handshake catalog digest drifted");
  }
  if (actual.skillDigest !== expected.skillDigest) {
    throw new Error("Host adapter capability handshake Skill digest drifted");
  }
  if (actual.toolCount !== expected.toolCount) {
    throw new Error("Host adapter capability handshake tool count drifted");
  }
  assertExactToolNames(
    actual.toolNames as readonly string[],
    expected.toolNames,
    "Host adapter capability handshake tool names"
  );
}

function assertExactToolNames(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`${label} do not match the authoritative catalog`);
  }
}

function catalogDigest(
  command: HostAdapterCapabilityCommand,
  tools: readonly HostAdapterCapabilityTool[]
): string {
  return sha256(canonicalJson({
    command: [command.name, command.description, command.acceptsArgs],
    tools: tools.map((tool) => [
      tool.name,
      tool.description,
      tool.inputSchema
    ])
  }));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function requiredSkillDocument(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Host adapter canonical Skill document is required");
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Host adapter capability handshake shape is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
