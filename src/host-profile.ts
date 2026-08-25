import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson } from "./canonical-json.js";
import { isRecord } from "./value-guards.js";

export const HOST_PROFILE_SCHEMA = "agent-knock-knock/host-profile";
export const HOST_PROFILE_VERSION = 1 as const;
export const HOST_PROFILE_JSON_SCHEMA =
  "https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/" +
  "schemas/host-profile-v1.schema.json";
export const HOST_PROFILE_BUILTIN_ID_PREFIX = "builtin-";
export const HOST_PROFILE_MAX_FILE_BYTES = 256 * 1024;
export const HOST_PROFILE_MAX_TIMEOUT_MS = 30_000;
export const HOST_PROFILE_MAX_OUTPUT_BYTES = 1024 * 1024;
export const HOST_PROFILE_PRIVATE_ENVIRONMENT_VARIABLES = Object.freeze([
  "AKK_HOST_PROFILE_SELECTION",
  "AKK_HOST_PROFILE_SOURCE",
  "AKK_HOST_PROFILE_FINGERPRINT",
  "AKK_HOST_PROFILE_HOST",
  "AKK_HOST_PROFILE_HOST_VERSION"
] as const);

export const HOST_PROFILE_PLACEHOLDERS = Object.freeze([
  "controller.session_id",
  "envelope.delivery_id",
  "envelope.idempotency_key",
  "envelope.message_id",
  "envelope.body"
] as const);

export type HostProfilePlaceholder =
  (typeof HOST_PROFILE_PLACEHOLDERS)[number];

export type HostProfileAcknowledgementDispositionV1 =
  | "accepted"
  | "retryable_failure"
  | "permanent_failure"
  | "uncertain";

export type HostProfileControllerScopeV1 =
  | "startup_v1"
  | "route_bound_v1";

export interface HostProfileCompatibilityV1 {
  readonly host: string;
  readonly range: string;
}

export interface HostProfileEnvironmentControllerContextV1 {
  readonly driver: "environment_v1";
  readonly sessionIdVariable: string;
  /**
   * Omitted is the original v1 behavior and is equivalent to startup_v1.
   * Keeping it omitted in the parsed model preserves existing fingerprints.
   */
  readonly scope?: HostProfileControllerScopeV1;
}

export interface HostProfileCallbackEnvironmentV1 {
  readonly allow: readonly string[];
}

export interface HostProfileJsonPointerV1 {
  readonly jsonPointer: string;
}

export interface HostProfileDispositionAcknowledgementV1 {
  readonly jsonPointer: string;
  readonly mapping: Readonly<Record<
    string,
    HostProfileAcknowledgementDispositionV1
  >>;
}

export interface HostProfileAcknowledgementV1 {
  readonly disposition: HostProfileDispositionAcknowledgementV1;
  readonly acceptanceId: HostProfileJsonPointerV1;
  readonly acknowledgedDeliveryId: HostProfileJsonPointerV1;
  readonly acknowledgedMessageId: HostProfileJsonPointerV1;
}

export interface HostProfileCommandJsonCallbackV1 {
  readonly driver: "command_json_v1";
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly stdin: "${envelope.body}";
  readonly environment: HostProfileCallbackEnvironmentV1;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly acknowledgement: HostProfileAcknowledgementV1;
}

export interface HostProfileV1 {
  readonly $schema: typeof HOST_PROFILE_JSON_SCHEMA;
  readonly schema: typeof HOST_PROFILE_SCHEMA;
  readonly version: typeof HOST_PROFILE_VERSION;
  readonly id: string;
  readonly revision: string;
  readonly compatibility: HostProfileCompatibilityV1;
  readonly controllerContext: HostProfileEnvironmentControllerContextV1;
  readonly callback: HostProfileCommandJsonCallbackV1;
}

export interface ParseHostProfileOptions {
  /** Built-ins alone may use the reserved built-in id namespace. */
  source?: "user" | "built_in";
  /** Exact ids already owned by a built-in registry. */
  reservedIds?: Iterable<string>;
}

export interface LoadedHostProfileV1 {
  readonly source: "file";
  readonly path: string;
  readonly fingerprint: string;
  readonly profile: HostProfileV1;
}

export interface HostProfileRegistryEntryV1 {
  readonly source: "built_in";
  readonly id: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly compatibility: HostProfileCompatibilityV1;
}

export interface HostProfileRegistry {
  list(): readonly HostProfileRegistryEntryV1[];
  resolve(id: string): HostProfileV1 | undefined;
  isReserved(id: string): boolean;
}

export interface LoadHostProfileOptions {
  cwd?: string;
  registry?: HostProfileRegistry;
}

export interface ResolvedHostProfileControllerContextV1 {
  readonly driver: "environment_v1";
  readonly variable: string;
  readonly controllerSessionId: string;
}

export interface HostProfileCompatibilityInputV1 {
  readonly host: string;
  readonly version: string;
}

const PROFILE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]*$/u;
const ACKNOWLEDGEMENT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SEMVER_CORE =
  "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
const EXACT_SEMVER = new RegExp(
  `^(${SEMVER_CORE})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u"
);
const VERSION_COMPARATOR = /^(>=|>|<=|<|=)?(.+)$/u;
const PLACEHOLDER = /\$\{([^{}]+)\}/gu;
const ALLOWED_PLACEHOLDERS = new Set<string>(HOST_PROFILE_PLACEHOLDERS);
const CALLBACK_DISPOSITIONS = new Set<HostProfileAcknowledgementDispositionV1>([
  "accepted",
  "retryable_failure",
  "permanent_failure",
  "uncertain"
]);
const UNSAFE_ENVIRONMENT_VARIABLES = new Set([
  "BASH_ENV",
  "ENV",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "SHELLOPTS"
]);
const PRIVATE_ENVIRONMENT_VARIABLES = new Set<string>(
  HOST_PROFILE_PRIVATE_ENVIRONMENT_VARIABLES
);
const SHELL_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "csh",
  "dash",
  "env",
  "fish",
  "ksh",
  "powershell",
  "powershell.exe",
  "pwsh",
  "sh",
  "tcsh",
  "zsh"
]);

/**
 * Parse one untrusted Profile document into a deeply immutable v1 model.
 *
 * Runtime validation is deliberately implemented here instead of delegated to
 * a JSON Schema package. The published schema is documentation and tooling;
 * this parser remains the fail-closed authority used by AKK.
 */
export function parseHostProfileV1(
  value: unknown,
  options: ParseHostProfileOptions = {}
): HostProfileV1 {
  const root = profileObject(value, "host profile");
  assertOnlyKeys(root, [
    "$schema",
    "schema",
    "version",
    "id",
    "revision",
    "compatibility",
    "controllerContext",
    "callback"
  ], "host profile");

  if (
    Object.hasOwn(root, "$schema") &&
    root.$schema !== HOST_PROFILE_JSON_SCHEMA
  ) {
    throw new Error(
      `host profile $schema must be ${HOST_PROFILE_JSON_SCHEMA}`
    );
  }
  if (requiredField(root, "schema", "host profile") !== HOST_PROFILE_SCHEMA) {
    throw new Error(`host profile schema must be ${HOST_PROFILE_SCHEMA}`);
  }
  const version = requiredField(root, "version", "host profile");
  if (version !== HOST_PROFILE_VERSION) {
    throw new Error(`unsupported host profile version ${String(version)}`);
  }

  const id = cleanString(root, "id", "host profile", 64);
  assertSafeProfileId(id, options);
  const revision = cleanString(root, "revision", "host profile", 128);
  if (!REVISION.test(revision)) {
    throw new Error("host profile revision is unsafe");
  }

  const profile = {
    $schema: HOST_PROFILE_JSON_SCHEMA,
    schema: HOST_PROFILE_SCHEMA,
    version: HOST_PROFILE_VERSION,
    id,
    revision,
    compatibility: parseCompatibility(root.compatibility),
    controllerContext: parseControllerContext(root.controllerContext),
    callback: parseCommandJsonCallback(root.callback)
  } satisfies HostProfileV1;
  return freezeProfile(profile);
}

/** Verify the configured callback path and its symlink target at Host startup. */
export function assertHostProfileCallbackExecutableReady(
  executable: string,
  environmentVariables: readonly string[] = []
): void {
  try {
    assertSafeExecutable(executable);
    const resolved = fs.realpathSync(executable);
    assertSafeExecutable(resolved);
    fs.accessSync(resolved, fs.constants.X_OK);
    if (!fs.statSync(resolved).isFile()) {
      throw new Error("not a regular file");
    }
    if (
      callbackUsesEnvShebang(resolved) &&
      !environmentVariables.includes("PATH")
    ) {
      throw new Error(
        "callback executable uses /usr/bin/env but " +
        "callback.environment.allow does not include PATH"
      );
    }
  } catch (error) {
    throw new Error(
      "Host Profile callback executable is unavailable or unsafe: " +
      errorMessage(error)
    );
  }
}

function callbackUsesEnvShebang(filePath: string): boolean {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const prefix = Buffer.alloc(256);
    const bytesRead = fs.readSync(descriptor, prefix, 0, prefix.length, 0);
    const firstLine = prefix.subarray(0, bytesRead)
      .toString("utf8")
      .split(/\r?\n/u, 1)[0];
    return /^#!\s*\/usr\/bin\/env(?:\s|$)/u.test(firstLine);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function hostProfileFingerprint(profile: HostProfileV1): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(profile))
    .digest("hex")}`;
}

/** Create the immutable built-in Profile lookup used by later Bridge wiring. */
export function createHostProfileRegistry(
  builtInProfiles: readonly unknown[] = []
): HostProfileRegistry {
  const byId = new Map<string, HostProfileV1>();
  for (const candidate of builtInProfiles) {
    const profile = parseHostProfileV1(candidate, { source: "built_in" });
    if (byId.has(profile.id)) {
      throw new Error(`duplicate built-in host profile id ${profile.id}`);
    }
    byId.set(profile.id, profile);
  }
  const entries = Object.freeze([...byId.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((profile) => Object.freeze({
      source: "built_in" as const,
      id: profile.id,
      revision: profile.revision,
      fingerprint: hostProfileFingerprint(profile),
      compatibility: profile.compatibility
    })));
  return Object.freeze({
    list: () => entries,
    resolve: (id: string) => byId.get(id),
    isReserved: (id: string) =>
      id.startsWith(HOST_PROFILE_BUILTIN_ID_PREFIX) || byId.has(id)
  });
}

/** Load one explicit JSON file; no search path or implicit Profile selection. */
export function loadHostProfileV1(
  profilePath: string,
  options: LoadHostProfileOptions = {}
): LoadedHostProfileV1 {
  if (
    typeof profilePath !== "string" ||
    profilePath.trim().length === 0 ||
    profilePath.includes("\0")
  ) {
    throw new Error("host profile path must be an explicit non-empty path");
  }
  const requestedPath = path.resolve(options.cwd ?? process.cwd(), profilePath);
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(requestedPath);
  } catch (error) {
    throw new Error(
      `cannot resolve host profile path ${requestedPath}: ${errorMessage(error)}`
    );
  }
  if (path.extname(canonicalPath).toLowerCase() !== ".json") {
    throw new Error("host profile path must identify a .json file");
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(canonicalPath, "r");
  } catch (error) {
    throw new Error(
      `cannot open host profile ${canonicalPath}: ${errorMessage(error)}`
    );
  }
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("host profile path must identify a regular file");
    }
    if (stat.size > HOST_PROFILE_MAX_FILE_BYTES) {
      throw new Error(
        `host profile exceeds ${HOST_PROFILE_MAX_FILE_BYTES} bytes`
      );
    }
    bytes = fs.readFileSync(descriptor);
    if (bytes.length > HOST_PROFILE_MAX_FILE_BYTES) {
      throw new Error(
        `host profile exceeds ${HOST_PROFILE_MAX_FILE_BYTES} bytes`
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`host profile is not valid UTF-8: ${errorMessage(error)}`);
  }
  let unverified: unknown;
  try {
    unverified = JSON.parse(source);
  } catch (error) {
    throw new Error(`host profile is not valid JSON: ${errorMessage(error)}`);
  }
  const profile = parseHostProfileV1(unverified, {
    source: "user",
    reservedIds: options.registry?.list().map((entry) => entry.id)
  });
  return Object.freeze({
    source: "file" as const,
    path: canonicalPath,
    fingerprint: hostProfileFingerprint(profile),
    profile
  });
}

/** Resolve trusted controller identity only from the Host-supplied environment. */
export function resolveHostProfileControllerContext(
  profile: HostProfileV1,
  environment: Readonly<Record<string, string | undefined>>
): ResolvedHostProfileControllerContextV1 {
  const variable = profile.controllerContext.sessionIdVariable;
  const candidate = Object.hasOwn(environment, variable)
    ? environment[variable]
    : undefined;
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 1024 ||
    candidate.trim() !== candidate ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new Error(
      `trusted controller session is missing or invalid in ${variable}`
    );
  }
  return Object.freeze({
    driver: "environment_v1" as const,
    variable,
    controllerSessionId: candidate
  });
}

/** Return whether one exact Host identity satisfies the Profile's AND range. */
export function hostProfileSupportsHostVersion(
  profile: HostProfileV1,
  input: HostProfileCompatibilityInputV1
): boolean {
  const { host, version } = parseCompatibilityInput(input);
  if (host !== profile.compatibility.host) return false;
  const actual = parseExactSemver(version);
  if (actual === undefined) {
    throw new Error("host version must be an exact SemVer version");
  }
  const comparators = parseVersionComparators(profile.compatibility.range);
  // Match SemVer range prerelease gating: a prerelease is eligible only when
  // this comparator set explicitly names a prerelease for the same core.
  if (
    actual.prerelease.length > 0 &&
    !comparators.some(({ expected }) =>
      expected.prerelease.length > 0 && sameSemverCore(actual, expected)
    )
  ) {
    return false;
  }
  return comparators.every(({ operator, expected }) => {
    const compared = compareSemver(actual, expected);
    switch (operator) {
      case ">": return compared > 0;
      case ">=": return compared >= 0;
      case "<": return compared < 0;
      case "<=": return compared <= 0;
      case "=": return compared === 0;
    }
  });
}

function sameSemverCore(left: ParsedSemver, right: ParsedSemver): boolean {
  return left.core.every((component, index) => component === right.core[index]);
}

/** Assert compatibility before a Bridge is allowed to use a Profile. */
export function assertHostProfileCompatibility(
  profile: HostProfileV1,
  input: HostProfileCompatibilityInputV1
): void {
  const { host, version } = parseCompatibilityInput(input);
  if (host !== profile.compatibility.host) {
    throw new Error(
      `host profile ${profile.id} targets ${profile.compatibility.host}, not ${host}`
    );
  }
  if (!hostProfileSupportsHostVersion(profile, { host, version })) {
    throw new Error(
      `host ${host} version ${version} does not satisfy Profile range ${profile.compatibility.range}`
    );
  }
}

function parseCompatibility(value: unknown): HostProfileCompatibilityV1 {
  const compatibility = profileObject(value, "host profile compatibility");
  assertOnlyKeys(
    compatibility,
    ["host", "range"],
    "host profile compatibility"
  );
  const host = cleanString(
    compatibility,
    "host",
    "host profile compatibility",
    64
  );
  if (!PROFILE_ID.test(host)) {
    throw new Error("host profile compatibility.host is unsafe");
  }
  const range = cleanString(
    compatibility,
    "range",
    "host profile compatibility",
    256
  );
  try {
    parseVersionComparators(range);
  } catch {
    throw new Error(
      "host profile compatibility.range must be one to four explicit SemVer comparators"
    );
  }
  return Object.freeze({ host, range });
}

interface ParsedSemver {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[];
}

interface ParsedVersionComparator {
  readonly operator: ">" | ">=" | "<" | "<=" | "=";
  readonly expected: ParsedSemver;
}

function parseCompatibilityInput(
  input: HostProfileCompatibilityInputV1
): HostProfileCompatibilityInputV1 {
  const value = profileObject(input, "host compatibility input");
  assertOnlyKeys(value, ["host", "version"], "host compatibility input");
  const host = cleanString(value, "host", "host compatibility input", 64);
  if (!PROFILE_ID.test(host)) {
    throw new Error("host compatibility input.host is unsafe");
  }
  const version = cleanString(
    value,
    "version",
    "host compatibility input",
    256
  );
  if (parseExactSemver(version) === undefined) {
    throw new Error("host version must be an exact SemVer version");
  }
  return Object.freeze({ host, version });
}

function parseVersionComparators(range: string): readonly ParsedVersionComparator[] {
  const candidates = range.split(" ");
  if (candidates.length === 0 || candidates.length > 4) {
    throw new Error("invalid comparator count");
  }
  return candidates.map((candidate) => {
    const match = VERSION_COMPARATOR.exec(candidate);
    if (match === null) throw new Error("invalid comparator");
    const expected = parseExactSemver(match[2]);
    if (expected === undefined) throw new Error("invalid comparator version");
    return {
      operator: (match[1] ?? "=") as ParsedVersionComparator["operator"],
      expected
    };
  });
}

function parseExactSemver(value: string): ParsedSemver | undefined {
  const match = EXACT_SEMVER.exec(value);
  if (match === null) return undefined;
  const core = match[1].split(".");
  if (core.length !== 3) return undefined;
  const prerelease = match[2]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^0[0-9]+$/u.test(identifier))) {
    return undefined;
  }
  return {
    core: [BigInt(core[0]), BigInt(core[1]), BigInt(core[2])],
    prerelease
  };
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^[0-9]+$/u.test(leftIdentifier);
    const rightNumeric = /^[0-9]+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function parseControllerContext(
  value: unknown
): HostProfileEnvironmentControllerContextV1 {
  const context = profileObject(value, "host profile controllerContext");
  assertOnlyKeys(
    context,
    ["driver", "sessionIdVariable", "scope"],
    "host profile controllerContext"
  );
  if (
    requiredField(context, "driver", "host profile controllerContext") !==
      "environment_v1"
  ) {
    throw new Error(
      "host profile controllerContext.driver must be environment_v1"
    );
  }
  const sessionIdVariable = cleanString(
    context,
    "sessionIdVariable",
    "host profile controllerContext",
    128
  );
  assertSafeEnvironmentVariable(sessionIdVariable, "controller session");
  const scope = Object.hasOwn(context, "scope")
    ? parseControllerScope(context.scope)
    : undefined;
  return Object.freeze({
    driver: "environment_v1" as const,
    sessionIdVariable,
    ...(scope === undefined ? {} : { scope })
  });
}

/** Normalize the optional scope without changing legacy Profile fingerprints. */
export function hostProfileControllerScope(
  profile: HostProfileV1
): HostProfileControllerScopeV1 {
  return profile.controllerContext.scope ?? "startup_v1";
}

function parseControllerScope(
  value: unknown
): HostProfileControllerScopeV1 {
  if (value !== "startup_v1" && value !== "route_bound_v1") {
    throw new Error(
      "host profile controllerContext.scope must be startup_v1 or route_bound_v1"
    );
  }
  return value;
}

function parseCommandJsonCallback(
  value: unknown
): HostProfileCommandJsonCallbackV1 {
  const callback = profileObject(value, "host profile callback");
  assertOnlyKeys(callback, [
    "driver",
    "executable",
    "arguments",
    "stdin",
    "environment",
    "timeoutMs",
    "maxOutputBytes",
    "acknowledgement"
  ], "host profile callback");
  if (
    requiredField(callback, "driver", "host profile callback") !==
      "command_json_v1"
  ) {
    throw new Error("host profile callback.driver must be command_json_v1");
  }

  const executable = cleanString(
    callback,
    "executable",
    "host profile callback",
    4096
  );
  assertSafeExecutable(executable);
  const arguments_ = parseArguments(callback.arguments);
  const stdin = cleanString(callback, "stdin", "host profile callback", 128);
  if (stdin !== "${envelope.body}") {
    throw new Error(
      "host profile callback.stdin must be exactly ${envelope.body}"
    );
  }
  const environment = parseCallbackEnvironment(callback.environment);
  const timeoutMs = boundedInteger(
    callback,
    "timeoutMs",
    1,
    HOST_PROFILE_MAX_TIMEOUT_MS,
    "host profile callback"
  );
  const maxOutputBytes = boundedInteger(
    callback,
    "maxOutputBytes",
    1,
    HOST_PROFILE_MAX_OUTPUT_BYTES,
    "host profile callback"
  );
  const acknowledgement = parseAcknowledgement(callback.acknowledgement);
  return Object.freeze({
    driver: "command_json_v1" as const,
    executable,
    arguments: arguments_,
    stdin: "${envelope.body}" as const,
    environment,
    timeoutMs,
    maxOutputBytes,
    acknowledgement
  });
}

function parseArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error(
      "host profile callback.arguments must be an array of 1 to 64 argv values"
    );
  }
  const placeholders = new Set<string>();
  let totalLength = 0;
  const arguments_ = value.map((candidate, index) => {
    if (typeof candidate !== "string" || candidate.length > 4096) {
      throw new Error(
        `host profile callback.arguments[${index}] must be a string no longer than 4096 characters`
      );
    }
    totalLength += candidate.length;
    const used = validateTemplate(
      candidate,
      `host profile callback.arguments[${index}]`,
      true
    );
    for (const placeholder of used) placeholders.add(placeholder);
    if (used.has("envelope.body")) {
      throw new Error(
        "host profile callback body may appear only in the stdin template"
      );
    }
    return candidate;
  });
  if (totalLength > 16_384) {
    throw new Error("host profile callback.arguments exceed the argv size bound");
  }
  for (const required of [
    "controller.session_id",
    "envelope.delivery_id",
    "envelope.message_id"
  ]) {
    if (!placeholders.has(required)) {
      throw new Error(
        `host profile callback.arguments must include \${${required}}`
      );
    }
  }
  return Object.freeze(arguments_);
}

function parseCallbackEnvironment(
  value: unknown
): HostProfileCallbackEnvironmentV1 {
  const environment = profileObject(
    value,
    "host profile callback.environment"
  );
  assertOnlyKeys(
    environment,
    ["allow"],
    "host profile callback.environment"
  );
  const allow = requiredField(
    environment,
    "allow",
    "host profile callback.environment"
  );
  if (!Array.isArray(allow) || allow.length > 32) {
    throw new Error(
      "host profile callback.environment.allow must be an array of at most 32 variables"
    );
  }
  const seen = new Set<string>();
  const parsed = allow.map((candidate, index) => {
    if (typeof candidate !== "string") {
      throw new Error(
        `host profile callback.environment.allow[${index}] must be a variable name`
      );
    }
    assertSafeEnvironmentVariable(candidate, "callback allowlist");
    if (seen.has(candidate)) {
      throw new Error(
        `host profile callback.environment.allow repeats ${candidate}`
      );
    }
    seen.add(candidate);
    return candidate;
  });
  return Object.freeze({ allow: Object.freeze(parsed) });
}

function parseAcknowledgement(value: unknown): HostProfileAcknowledgementV1 {
  const acknowledgement = profileObject(
    value,
    "host profile callback.acknowledgement"
  );
  assertOnlyKeys(acknowledgement, [
    "disposition",
    "acceptanceId",
    "acknowledgedDeliveryId",
    "acknowledgedMessageId"
  ], "host profile callback.acknowledgement");

  const dispositionValue = profileObject(
    acknowledgement.disposition,
    "host profile callback.acknowledgement.disposition"
  );
  assertOnlyKeys(
    dispositionValue,
    ["jsonPointer", "mapping"],
    "host profile callback.acknowledgement.disposition"
  );
  const dispositionPointer = parseJsonPointer(
    dispositionValue,
    "jsonPointer",
    "host profile callback.acknowledgement.disposition"
  );
  const mappingValue = profileObject(
    dispositionValue.mapping,
    "host profile callback.acknowledgement.disposition.mapping"
  );
  const mappingEntries = Object.entries(mappingValue);
  if (mappingEntries.length === 0 || mappingEntries.length > 16) {
    throw new Error(
      "host profile acknowledgement disposition mapping must contain 1 to 16 entries"
    );
  }
  let accepts = false;
  const mapping = Object.freeze(Object.fromEntries(mappingEntries
    .map(([key, candidate]) => {
      if (
        key.length > 64 ||
        !ACKNOWLEDGEMENT_VALUE.test(key) ||
        !CALLBACK_DISPOSITIONS.has(
          candidate as HostProfileAcknowledgementDispositionV1
        )
      ) {
        throw new Error(
          "host profile acknowledgement disposition mapping is invalid"
        );
      }
      if (candidate === "accepted") accepts = true;
      return [
        key,
        candidate as HostProfileAcknowledgementDispositionV1
      ] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right)))) as Readonly<
      Record<string, HostProfileAcknowledgementDispositionV1>
    >;
  if (!accepts) {
    throw new Error(
      "host profile acknowledgement disposition mapping must include accepted"
    );
  }

  const acceptanceId = parseJsonPointerReference(
    acknowledgement.acceptanceId,
    "host profile callback.acknowledgement.acceptanceId"
  );
  const acknowledgedDeliveryId = parseJsonPointerReference(
    acknowledgement.acknowledgedDeliveryId,
    "host profile callback.acknowledgement.acknowledgedDeliveryId"
  );
  const acknowledgedMessageId = parseJsonPointerReference(
    acknowledgement.acknowledgedMessageId,
    "host profile callback.acknowledgement.acknowledgedMessageId"
  );
  if (
    acknowledgedDeliveryId.jsonPointer ===
      acknowledgedMessageId.jsonPointer
  ) {
    throw new Error(
      "host profile acknowledgement delivery and message pointers must differ"
    );
  }
  return Object.freeze({
    disposition: Object.freeze({
      jsonPointer: dispositionPointer,
      mapping
    }),
    acceptanceId,
    acknowledgedDeliveryId,
    acknowledgedMessageId
  });
}

function parseJsonPointerReference(
  value: unknown,
  label: string
): HostProfileJsonPointerV1 {
  const reference = profileObject(value, label);
  assertOnlyKeys(reference, ["jsonPointer"], label);
  return Object.freeze({
    jsonPointer: parseJsonPointer(reference, "jsonPointer", label)
  });
}

function parseJsonPointer(
  value: Record<string, unknown>,
  key: string,
  label: string
): string {
  const pointer = cleanString(value, key, label, 256);
  if (!pointer.startsWith("/") || pointer.split("/").length > 17) {
    throw new Error(`${label}.${key} must be a bounded JSON pointer`);
  }
  for (let index = 0; index < pointer.length; index += 1) {
    if (pointer[index] !== "~") continue;
    if (pointer[index + 1] !== "0" && pointer[index + 1] !== "1") {
      throw new Error(`${label}.${key} contains invalid JSON pointer escaping`);
    }
    index += 1;
  }
  if (/[\u0000-\u001f\u007f]/u.test(pointer)) {
    throw new Error(`${label}.${key} contains control characters`);
  }
  return pointer;
}

function validateTemplate(
  value: string,
  label: string,
  rejectShellSyntax: boolean
): ReadonlySet<string> {
  if (value.includes("\0")) {
    throw new Error(`${label} contains a NUL byte`);
  }
  const placeholders = new Set<string>();
  const withoutPlaceholders = value.replace(
    PLACEHOLDER,
    (_match, placeholder: string) => {
      if (!ALLOWED_PLACEHOLDERS.has(placeholder)) {
        throw new Error(`${label} contains unsupported placeholder ${placeholder}`);
      }
      placeholders.add(placeholder);
      return "placeholder";
    }
  );
  if (withoutPlaceholders.includes("${") || withoutPlaceholders.includes("$")) {
    throw new Error(`${label} contains malformed or unsupported interpolation`);
  }
  if (
    rejectShellSyntax &&
    (/[\r\n;`<>|]/u.test(withoutPlaceholders) ||
      withoutPlaceholders.includes("&&"))
  ) {
    throw new Error(`${label} contains shell syntax`);
  }
  return placeholders;
}

function assertSafeExecutable(executable: string): void {
  if (
    !path.isAbsolute(executable) ||
    path.normalize(executable) !== executable ||
    executable === path.parse(executable).root ||
    executable.endsWith(path.sep) ||
    /[\u0000-\u001f\u007f]/u.test(executable) ||
    executable.includes("${")
  ) {
    throw new Error(
      "host profile callback.executable must be a normalized absolute path"
    );
  }
  if (SHELL_EXECUTABLES.has(path.basename(executable).toLowerCase())) {
    throw new Error("host profile callback.executable cannot be a shell");
  }
}

function assertSafeProfileId(
  id: string,
  options: ParseHostProfileOptions
): void {
  if (!PROFILE_ID.test(id)) {
    throw new Error("host profile id is unsafe");
  }
  if (options.source === "built_in") return;
  const reservedIds = new Set(options.reservedIds ?? []);
  if (id.startsWith(HOST_PROFILE_BUILTIN_ID_PREFIX) || reservedIds.has(id)) {
    throw new Error(`host profile id ${id} is reserved by a built-in Profile`);
  }
}

function assertSafeEnvironmentVariable(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 128 ||
    !ENVIRONMENT_VARIABLE.test(value) ||
    UNSAFE_ENVIRONMENT_VARIABLES.has(value) ||
    PRIVATE_ENVIRONMENT_VARIABLES.has(value) ||
    value.startsWith("AKK_HOST_PROFILE_") ||
    value.startsWith("DYLD_")
  ) {
    throw new Error(`host profile ${label} environment variable is unsafe`);
  }
}

function boundedInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  label: string
): number {
  const candidate = requiredField(value, key, label);
  if (
    !Number.isSafeInteger(candidate) ||
    Number(candidate) < minimum ||
    Number(candidate) > maximum
  ) {
    throw new Error(
      `${label}.${key} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return Number(candidate);
}

function cleanString(
  value: Record<string, unknown>,
  key: string,
  label: string,
  maximumLength: number
): string {
  const candidate = requiredField(value, key, label);
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > maximumLength ||
    candidate.trim() !== candidate ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new Error(
      `${label}.${key} must be a clean non-empty string no longer than ${maximumLength} characters`
    );
  }
  return candidate;
}

function requiredField(
  value: Record<string, unknown>,
  key: string,
  label: string
): unknown {
  if (!Object.hasOwn(value, key)) {
    throw new Error(`${label} is missing required field ${key}`);
  }
  return value[key];
}

function profileObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .sort();
  if (unsupported.length > 0) {
    throw new Error(
      `${label} contains unsupported fields: ${unsupported.join(", ")}`
    );
  }
}

function freezeProfile(profile: HostProfileV1): HostProfileV1 {
  Object.freeze(profile.callback.acknowledgement.disposition.mapping);
  Object.freeze(profile.callback.acknowledgement.disposition);
  Object.freeze(profile.callback.acknowledgement.acceptanceId);
  Object.freeze(profile.callback.acknowledgement.acknowledgedDeliveryId);
  Object.freeze(profile.callback.acknowledgement.acknowledgedMessageId);
  Object.freeze(profile.callback.acknowledgement);
  Object.freeze(profile.callback.environment.allow);
  Object.freeze(profile.callback.environment);
  Object.freeze(profile.callback.arguments);
  Object.freeze(profile.callback);
  Object.freeze(profile.controllerContext);
  Object.freeze(profile.compatibility);
  return Object.freeze(profile);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
