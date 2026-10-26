import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicReplacePrivateJsonFile, fsyncDirectory } from "./durable-json-file.js";
import {
  canonicalStoreOwnerPath, isStoreOwnerIdentity, type StoreOwnerIdentity
} from "./store-owner-identity.js";
import {
  probeStoreOwnerIdentity, systemStoreOwnerProcessProbe,
  type StoreOwnerLiveness, type StoreOwnerProcessProbe
} from "./store-owner-process.js";

const DIRECTORY = ".akk-store-owners";
const FILE = "registry.json";
const SCHEMA = "agent-knock-knock/store-owner-registry";
const MAX_BYTES = 4 * 1024 * 1024;

export interface StoreOwnerInventory {
  /** Complete only for this registered-owner snapshot; never proves legacy coverage. */
  readonly complete: boolean;
  readonly owners: readonly StoreOwnerIdentity[];
  readonly fingerprint: string | null;
  readonly reason?: string;
}

function assertPrivate(stat: fs.Stats): void {
  if (typeof process.getuid !== "function" || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Store owner registry ownership or permissions are unsafe");
  }
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Store owner registry directory");
  assertPrivate(stat);
}

function readPrivateFile(filename: string): string {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("Invalid Store owner registry file");
    assertPrivate(stat);
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

function ownerText(owner: StoreOwnerIdentity): string {
  return JSON.stringify({ schema: owner.schema, version: owner.version, host_id: owner.host_id,
    owner_scope: owner.owner_scope, store_dir: owner.store_dir, pid: owner.pid,
    process_start: owner.process_start, boot_id: owner.boot_id, instance_nonce: owner.instance_nonce,
    store_kind: owner.store_kind, created_at: owner.created_at });
}

function readSnapshot(directory: string, storeDir: string): StoreOwnerIdentity[] {
  assertPrivateDirectory(directory);
  const value = JSON.parse(readPrivateFile(path.join(directory, FILE)));
  if (value?.schema !== SCHEMA || value.version !== 1 || value.store_dir !== storeDir ||
      !Array.isArray(value.owners) || !value.owners.length || value.owners.length > 4096) {
    throw new Error("Invalid Store owner registry snapshot");
  }
  const nonces = new Set<string>();
  for (const owner of value.owners) {
    if (!isStoreOwnerIdentity(owner) || owner.store_dir !== storeDir || nonces.has(owner.instance_nonce)) {
      throw new Error("Store owner snapshot contains an invalid or duplicate incarnation");
    }
    nonces.add(owner.instance_nonce);
    Object.freeze(owner);
  }
  return value.owners.sort((left: StoreOwnerIdentity, right: StoreOwnerIdentity) =>
    left.instance_nonce.localeCompare(right.instance_nonce));
}

function existsNoFollow(candidate: string): boolean {
  try { fs.lstatSync(candidate); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function replaceSnapshot(directory: string, storeDir: string, owners: readonly StoreOwnerIdentity[], beforeRename?: () => void): void {
  const value = { schema: SCHEMA, version: 1, store_dir: storeDir,
    owners: owners.map(owner => JSON.parse(ownerText(owner))) };
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) + 1 > MAX_BYTES) {
    throw new Error("Store owner registry capacity exceeded");
  }
  atomicReplacePrivateJsonFile(path.join(directory, FILE), value, {
    temporaryPath: path.join(directory, `.registry.${process.pid}.${randomUUID()}.tmp`),
    beforeRename,
    cleanupTemporary(temporaryPath) {
      try { fs.unlinkSync(temporaryPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  });
}

function initializeSnapshot(directory: string, owner: StoreOwnerIdentity): void {
  const staging = fs.mkdtempSync(path.join(owner.store_dir, `${DIRECTORY}.init-`));
  fs.chmodSync(staging, 0o700);
  try {
    replaceSnapshot(staging, owner.store_dir, [owner]);
    fsyncDirectory(staging);
    if (existsNoFollow(directory)) throw new Error("Store owner registry appeared during initialization");
    fs.renameSync(staging, directory);
    fsyncDirectory(owner.store_dir);
  } finally {
    // Only this invocation's unpublished staging directory; never an existing registry.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Call in the Store writer transaction; one atomic snapshot preserves every registration. */
export function registerStoreOwnerIdentity(owner: StoreOwnerIdentity): StoreOwnerIdentity {
  if (!isStoreOwnerIdentity(owner) || canonicalStoreOwnerPath(owner.store_dir) !== owner.store_dir) {
    throw new Error("Invalid Store owner identity");
  }
  const directory = path.join(owner.store_dir, DIRECTORY);
  if (!existsNoFollow(directory)) { initializeSnapshot(directory, owner); return owner; }
  const owners = readSnapshot(directory, owner.store_dir);
  const existing = owners.find(value => value.instance_nonce === owner.instance_nonce);
  if (existing) {
    if (ownerText(existing) !== ownerText(owner)) throw new Error("Store owner incarnation registration cannot be replaced");
    return owner;
  }
  if (owners.length >= 4096) throw new Error("Store owner registration capacity exceeded");
  replaceSnapshot(directory, owner.store_dir, [...owners, owner], () => {
    if (JSON.stringify(readSnapshot(directory, owner.store_dir).map(ownerText)) !== JSON.stringify(owners.map(ownerText))) {
      throw new Error("Store owner registrations changed before atomic publication");
    }
  });
  return owner;
}

export function readStoreOwnerInventory(storeDir: string): StoreOwnerInventory {
  try {
    const canonical = canonicalStoreOwnerPath(storeDir);
    const directory = path.join(canonical, DIRECTORY);
    if (!existsNoFollow(directory)) return unverifiableInventory("owner_inventory_absent");
    const owners = readSnapshot(directory, canonical);
    const fingerprint = createHash("sha256").update(owners.map(ownerText).join("\n")).digest("hex");
    return Object.freeze({ complete: true, owners: Object.freeze(owners), fingerprint });
  } catch { return unverifiableInventory(); }
}

function unverifiableInventory(reason = "owner_inventory_unverifiable"): StoreOwnerInventory {
  return Object.freeze({ complete: false, owners: [], fingerprint: null, reason });
}

export function probeStoreOwnerInventory(inventory: StoreOwnerInventory,
  probe: StoreOwnerProcessProbe = systemStoreOwnerProcessProbe): StoreOwnerLiveness {
  if (!inventory.complete || !inventory.owners.length) return { state: "unknown", reason: "owner_inventory_unverifiable" };
  const results = inventory.owners.map(owner => probeStoreOwnerIdentity(owner, probe));
  if (results.some(result => result.state === "alive")) return { state: "alive", reason: "registered_owner_alive" };
  if (results.some(result => result.state === "unknown")) return { state: "unknown", reason: "registered_owner_unverifiable" };
  return { state: "dead", reason: "all_registered_owners_proven_dead" };
}
