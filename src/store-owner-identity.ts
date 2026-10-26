import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeStoreOwnerIdentity,
  storeOwnerHostIsAncestor,
  systemStoreOwnerProcessProbe,
  type StoreOwnerProcessEvidence,
  type StoreOwnerProcessProbe
} from "./store-owner-process.js";

export { probeStoreOwnerIdentity } from "./store-owner-process.js";
export type { StoreOwnerLiveness, StoreOwnerProcessProbe } from "./store-owner-process.js";

export const STORE_OWNER_HOST_ENV = "AKK_STORE_OWNER_HOST_IDENTITY";
export interface StoreOwnerHostIdentity extends StoreOwnerProcessEvidence {
  readonly host_id: string;
  readonly owner_scope: "host" | "cli";
  readonly instance_nonce: string;
  readonly created_at: string;
}
export interface StoreOwnerIdentity extends StoreOwnerHostIdentity {
  readonly schema: "agent-knock-knock/store-owner";
  readonly version: 1;
  readonly store_dir: string;
  readonly store_kind: "persistent" | "ephemeral";
}

const localOwners = new Map<string, StoreOwnerHostIdentity>();

function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validProcessEvidence(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.pid) && Number(value.pid) > 1 &&
    (value.process_start === null || text(value.process_start)) &&
    (value.boot_id === null || text(value.boot_id));
}

export function isStoreOwnerHostIdentity(value: unknown): value is StoreOwnerHostIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return validProcessEvidence(owner) && text(owner.host_id, 128) &&
    ["host", "cli"].includes(String(owner.owner_scope)) &&
    typeof owner.instance_nonce === "string" && /^[a-f0-9-]{36}$/u.test(owner.instance_nonce) &&
    typeof owner.created_at === "string" && Number.isFinite(Date.parse(owner.created_at));
}

export function isStoreOwnerIdentity(value: unknown): value is StoreOwnerIdentity {
  if (!isStoreOwnerHostIdentity(value)) return false;
  const owner = value as unknown as Record<string, unknown>;
  return owner.schema === "agent-knock-knock/store-owner" && owner.version === 1 &&
    text(owner.store_dir, 4096) && path.isAbsolute(owner.store_dir) &&
    ["persistent", "ephemeral"].includes(String(owner.store_kind));
}

function captureProcessOwner(hostId: string, scope: "host" | "cli"): StoreOwnerHostIdentity {
  const key = `${scope}:${hostId}`;
  const cached = localOwners.get(key);
  if (cached) return cached;
  const observed = systemStoreOwnerProcessProbe(process.pid);
  const owner: StoreOwnerHostIdentity = Object.freeze({
    host_id: hostId, owner_scope: scope, pid: process.pid,
    process_start: observed.state === "present" ? observed.process_start : null,
    boot_id: observed.state === "present" ? observed.boot_id : null,
    instance_nonce: randomUUID(), created_at: new Date().toISOString()
  });
  localOwners.set(key, owner);
  return owner;
}

/** Stamp the embedding process, never a short-lived CLI relay, as Host owner. */
export function withStoreOwnerHostEnvironment(
  environment: NodeJS.ProcessEnv,
  fallbackHostId = "openclaw"
): NodeJS.ProcessEnv {
  const inherited = inheritedOwner(environment);
  const hostId = environment.AKK_HOST_PROFILE_HOST ??
    (inherited?.pid === process.pid ? inherited.host_id : fallbackHostId);
  if (!text(hostId, 128)) throw new Error("Invalid Store owner Host identity");
  return { ...environment, [STORE_OWNER_HOST_ENV]: JSON.stringify(captureProcessOwner(hostId, "host")) };
}

export function canonicalStoreOwnerPath(storeDir: string): string {
  if (!text(storeDir, 4096) || !path.isAbsolute(storeDir)) {
    throw new Error("Store owner registration requires an absolute Store path");
  }
  const resolved = fs.realpathSync(storeDir);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Store owner path is not a directory");
  return resolved;
}

function privateDirectory(candidate: string): boolean {
  const stat = fs.lstatSync(candidate);
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    typeof process.getuid === "function" && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

/** A temporary path alone never opts a Store into automatic owner recovery. */
export function storeOwnerKind(
  storeDir: string,
  environment: NodeJS.ProcessEnv = process.env
): "persistent" | "ephemeral" {
  if (environment.AKK_EPHEMERAL_STORE !== "1") return "persistent";
  try {
    const canonical = canonicalStoreOwnerPath(storeDir);
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const relative = path.relative(temporaryRoot, canonical);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "persistent";
    const parts = relative.split(path.sep);
    if (!parts[0].startsWith("akk-")) return "persistent";
    let cursor = temporaryRoot;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      if (!privateDirectory(cursor)) return "persistent";
    }
    return "ephemeral";
  } catch { return "persistent"; }
}

function inheritedOwner(environment: NodeJS.ProcessEnv): StoreOwnerHostIdentity | undefined {
  const encoded = environment[STORE_OWNER_HOST_ENV];
  if (encoded === undefined) return undefined;
  if (encoded.length > 4096) throw new Error("Invalid Store owner Host environment");
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new Error("Invalid Store owner Host environment"); }
  if (!isStoreOwnerHostIdentity(value) || value.owner_scope !== "host") {
    throw new Error("Invalid Store owner Host environment");
  }
  return value;
}

export function captureStoreOwnerIdentity(
  storeDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  probe: StoreOwnerProcessProbe = systemStoreOwnerProcessProbe
): StoreOwnerIdentity {
  const canonical = canonicalStoreOwnerPath(storeDir);
  const host = inheritedOwner(environment);
  // A detached monitor or copied environment must not impersonate a former Host.
  // Retain normal operation as a persistent CLI owner; this cannot enable auto recovery.
  const verifiedHost = host && storeOwnerHostIsAncestor(host.pid) &&
    probeStoreOwnerIdentity(host, probe).state === "alive" ? host : undefined;
  const owner = verifiedHost ?? captureProcessOwner("standalone-cli", "cli");
  return Object.freeze({ ...owner, schema: "agent-knock-knock/store-owner", version: 1,
    store_dir: canonical, store_kind: host && !verifiedHost ? "persistent" : storeOwnerKind(canonical, environment) });
}
