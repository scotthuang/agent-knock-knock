import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { callbackRouteFingerprint } from "./callback-route-authority.js";
import { parseCallbackRoute, type CallbackRouteV1 } from "./callback-transport.js";
import { isRecord } from "./value-guards.js";

export const AKK_HOST_PROFILE_CALLBACK_RECOVERY = "AKK_HOST_PROFILE_CALLBACK_RECOVERY";
export const AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT = "AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT";
const SCHEMA = "agent-knock-knock/host-profile-callback-recovery";
const MAX_BYTES = 256 * 1024;

/** @internal Host-issued aliases contain route identity, never callback configuration. */
export interface HostProfileCallbackRecoveryCatalogV1 {
  readonly schema: typeof SCHEMA;
  readonly version: 1;
  readonly current_profile_fingerprint: string;
  readonly owner_scope: string;
  readonly routes: readonly CallbackRouteV1[];
}

/** @internal The connector owns the private file and its authorization evidence. */
export function createHostProfileCallbackRecoveryCatalog(input: {
  currentProfileFingerprint: string; ownerScope: string; routes: readonly CallbackRouteV1[];
}): HostProfileCallbackRecoveryCatalogV1 {
  return parseCatalog({ schema: SCHEMA, version: 1,
    current_profile_fingerprint: input.currentProfileFingerprint,
    owner_scope: input.ownerScope, routes: input.routes });
}

export function hostProfileCallbackRecoveryFingerprint(catalog: HostProfileCallbackRecoveryCatalogV1): string {
  return `sha256:${createHash("sha256").update(canonicalJson(parseCatalog(catalog))).digest("hex")}`;
}

export function hasHostProfileCallbackRecovery(environment: Readonly<NodeJS.ProcessEnv>): boolean {
  return environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY] !== undefined ||
    environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT] !== undefined;
}

export function readHostProfileCallbackRecovery(environment: Readonly<NodeJS.ProcessEnv>, current: {
  profileFingerprint: string; profileId: string; transport: string; controllerScope: string;
}): { path: string; fingerprint: string; routes: readonly CallbackRouteV1[] } | undefined {
  if (!hasHostProfileCallbackRecovery(environment)) return undefined;
  const source = cleanString(environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY], "catalogue path");
  const fingerprint = digestString(environment[AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT]);
  if (!path.isAbsolute(source) || current.controllerScope !== "route_bound_v1" ||
      current.transport !== "command_json_v1") throw new Error("Host callback recovery requires an absolute catalogue and a route-bound command Profile");
  const content = readPrivateCatalog(source);
  const catalog = parseCatalog(JSON.parse(content.toString("utf8")));
  if (hostProfileCallbackRecoveryFingerprint(catalog) !== fingerprint ||
      catalog.current_profile_fingerprint !== current.profileFingerprint) {
    throw new Error("Host callback recovery catalogue fingerprint does not match trusted startup authority");
  }
  if (catalog.routes.some(route => route.profile_id !== current.profileId || route.transport !== current.transport)) {
    throw new Error("Host callback recovery route belongs to another Profile or transport");
  }
  return Object.freeze({ path: source, fingerprint, routes: catalog.routes });
}

function readPrivateCatalog(source: string): Buffer {
  const uid = process.getuid?.();
  if (uid === undefined || !fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK) {
    throw new Error("Host callback recovery requires private-file support");
  }
  const descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const assertPrivateFile = () => {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) {
      throw new Error("Host callback recovery catalogue must be a bounded private file owned by the current user");
    }
  };
  try {
    assertPrivateFile();
    const content = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length <= MAX_BYTES) {
      const read = fs.readSync(descriptor, content, length, content.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_BYTES) throw new Error("Host callback recovery catalogue exceeded its limit");
    assertPrivateFile();
    return content.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
}

function parseCatalog(value: unknown): HostProfileCallbackRecoveryCatalogV1 {
  if (!isRecord(value) || Object.keys(value).some(key => ![
    "schema", "version", "current_profile_fingerprint", "owner_scope", "routes"
  ].includes(key)) || value.schema !== SCHEMA || value.version !== 1 ||
      !Array.isArray(value.routes) || value.routes.length > 1024) throw new Error("Host callback recovery catalogue is invalid");
  const routes = value.routes.map(raw => {
    const route = parseCallbackRoute(raw);
    if (route.capabilities) Object.freeze(route.capabilities);
    return Object.freeze(route);
  });
  if (new Set(routes.map(callbackRouteFingerprint)).size !== routes.length) throw new Error("Host callback recovery routes are duplicated");
  const catalog = Object.freeze({ schema: SCHEMA, version: 1 as const,
    current_profile_fingerprint: digestString(value.current_profile_fingerprint),
    owner_scope: cleanString(value.owner_scope, "owner scope"), routes: Object.freeze(routes) });
  if (Buffer.byteLength(canonicalJson(catalog)) > MAX_BYTES) throw new Error("Host callback recovery catalogue exceeded its limit");
  return catalog;
}

function cleanString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Host callback recovery ${label} is invalid`);
  return value;
}
function digestString(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("Host callback recovery fingerprint is invalid");
  return value;
}
