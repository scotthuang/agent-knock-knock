import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { TrustedHostProfileRuntimeV1 } from "@scotthuang/agent-knock-knock/host-adapter";

export type DshCallbackRoute = TrustedHostProfileRuntimeV1["callbackRoute"];
export interface SessionIdentity {
  readonly sessionId: string;
  readonly headerFingerprint: string;
}
export interface DurableRouteRecord extends SessionIdentity {
  readonly controllerId: string;
}
export interface DeliveryIdentity {
  readonly requestFingerprint: string;
  readonly messageId: string;
}
export interface DurableDeliveryRecord extends DeliveryIdentity {
  readonly state: "prepared" | "accepted";
}
export interface DurableCallbackAuthority {
  bindRoute(session: SessionIdentity, candidateControllerId: string): DurableRouteRecord;
  bindFreshRoute(session: SessionIdentity, candidateControllerId: string): DurableRouteRecord;
  getRoute(controllerId: string): DurableRouteRecord | undefined;
  registerCallbackRoute(controllerId: string, route: DshCallbackRoute): void;
  callbackRoutes(): readonly DshCallbackRoute[];
  readDelivery(controllerId: string, idempotencyKey: string): DurableDeliveryRecord | undefined;
  prepareDelivery(controllerId: string, idempotencyKey: string, identity: DeliveryIdentity): DurableDeliveryRecord;
  acceptDelivery(controllerId: string, idempotencyKey: string, identity: DeliveryIdentity): DurableDeliveryRecord;
}
export interface LegacyRouteAuthorization {
  readonly explicit: true;
  readonly scope: string;
  readonly watchId: string;
  readonly historicalProfileFingerprint: string;
}
interface StoredRoute extends DurableRouteRecord {
  readonly callbackRoutes: readonly DshCallbackRoute[];
  readonly adoptions: readonly LegacyRouteAuthorization[];
}
interface StoredDelivery extends DurableDeliveryRecord {
  readonly controllerId: string;
  readonly idempotencyKey: string;
}
interface AuthorityDocument {
  readonly version: 1;
  readonly profileDirectory: string;
  readonly storeDirectory: string;
  readonly ownerId: string;
  readonly routes: readonly StoredRoute[];
  readonly deliveries: readonly StoredDelivery[];
}
interface OwnerLock {
  readonly pid: number;
  readonly processStart: string;
  readonly nonce: string;
}
const MAX_BYTES = 16 * 1024 * 1024;

/** Canonicalize an existing directory or its nearest existing ancestor. */
export function canonicalDirectoryPath(directory: string): string {
  cleanText(directory);
  let existing = path.resolve(directory);
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("DSH authority directory cannot be resolved");
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  if (!fs.statSync(existing).isDirectory()) throw new Error("DSH authority path is not a directory");
  return path.join(fs.realpathSync(existing), ...missing);
}

/** One exclusive writer; no route or receipt survives without durable storage. */
export class CallbackAuthority implements DurableCallbackAuthority {
  readonly directory: string;
  readonly ownerId: string;
  readonly scope: string;
  private document: AuthorityDocument;
  private readonly lock: OwnerLock;
  private active = true;
  private writeFailed = false;

  constructor(options: { readonly profileDirectory: string; readonly storeDirectory: string }) {
    const profileDirectory = fs.realpathSync(options.profileDirectory);
    const storeDirectory = canonicalDirectoryPath(options.storeDirectory);
    if (!fs.statSync(profileDirectory).isDirectory()) throw new Error("DSH profile is not a directory");
    const scopeHash = digest([profileDirectory, storeDirectory]);
    const parent = path.join(profileDirectory, ".akk-callback-authority");
    privateDirectory(parent);
    this.directory = path.join(parent, scopeHash);
    privateDirectory(this.directory);
    this.lock = acquireLock(this.directory);
    try {
      const filename = path.join(this.directory, "authority.json");
      this.document = fs.existsSync(filename)
        ? readDocument(filename, profileDirectory, storeDirectory)
        : { version: 1, profileDirectory, storeDirectory, ownerId: randomUUID(), routes: [], deliveries: [] };
      this.ownerId = this.document.ownerId;
      this.scope = `akk-dsh:${scopeHash}:${this.ownerId}`;
      if (!fs.existsSync(filename)) this.commit(this.document);
    } catch (error) {
      releaseLock(this.directory, this.lock);
      throw error;
    }
  }

  bindRoute(session: SessionIdentity, candidateControllerId: string): DurableRouteRecord {
    this.assertActive();
    validateSession(session);
    cleanText(candidateControllerId);
    const existing = [...this.document.routes].reverse().find((route) => sameSession(route, session));
    if (existing) return publicRoute(existing);
    return this.bindFreshRoute(session, candidateControllerId);
  }

  bindFreshRoute(session: SessionIdentity, candidateControllerId: string): DurableRouteRecord {
    this.assertActive();
    validateSession(session);
    cleanText(candidateControllerId);
    if (this.getRoute(candidateControllerId)) throw new Error("DSH controller authority collision");
    const route = { ...session, controllerId: candidateControllerId, callbackRoutes: [], adoptions: [] };
    this.commit({ ...this.document, routes: [...this.document.routes, route] });
    return publicRoute(route);
  }

  getRoute(controllerId: string): DurableRouteRecord | undefined {
    this.assertActive();
    const route = this.document.routes.find((item) => item.controllerId === controllerId);
    return route && publicRoute(route);
  }

  registerCallbackRoute(controllerId: string, candidate: DshCallbackRoute): void {
    this.assertActive();
    const route = checkedCallbackRoute(candidate, controllerId);
    const owner = this.document.routes.find((item) => item.controllerId === controllerId);
    if (!owner) throw new Error("DSH callback route has no durable owner");
    if (owner.callbackRoutes.some((item) => digest(item) === digest(route))) return;
    this.commit({ ...this.document, routes: this.document.routes.map((item) => item !== owner ? item : {
      ...item, callbackRoutes: [...item.callbackRoutes, route],
    }) });
  }

  callbackRoutes(): readonly DshCallbackRoute[] {
    this.assertActive();
    return Object.freeze(this.document.routes.flatMap((route) => route.callbackRoutes.map(freezeRoute)));
  }

  isWatchAdopted(watchId: string): boolean {
    this.assertActive();
    cleanText(watchId);
    return this.document.routes.some((route) => route.adoptions.some((item) => item.watchId === watchId));
  }

  /** Called only after explicit adoption and independent historical evidence checks. */
  adoptRoute(input: {
    readonly controllerId: string;
    readonly session: SessionIdentity;
    readonly callbackRoute: DshCallbackRoute;
    readonly authorization: LegacyRouteAuthorization;
  }): DurableRouteRecord {
    this.assertActive();
    validateSession(input.session);
    const route = checkedCallbackRoute(input.callbackRoute, input.controllerId);
    const authorization = input.authorization;
    validateAuthorization(authorization);
    if (authorization.scope !== this.scope) throw new Error("DSH legacy adoption owner scope mismatch");
    const existing = this.document.routes.find((item) => item.controllerId === input.controllerId);
    if (existing && !sameSession(existing, input.session)) throw new Error("DSH legacy route generation changed");
    const owner: StoredRoute = existing ?? {
      ...input.session, controllerId: input.controllerId, callbackRoutes: [], adoptions: [],
    };
    const adopted: StoredRoute = {
      ...owner,
      callbackRoutes: owner.callbackRoutes.some((item) => digest(item) === digest(route))
        ? owner.callbackRoutes : [...owner.callbackRoutes, route],
      adoptions: owner.adoptions.some((item) => digest(item) === digest(authorization))
        ? owner.adoptions : [...owner.adoptions, { ...authorization }],
    };
    this.commit({ ...this.document, routes: existing
      ? this.document.routes.map((item) => item === existing ? adopted : item)
      : [...this.document.routes, adopted] });
    return publicRoute(adopted);
  }

  readDelivery(controllerId: string, idempotencyKey: string): DurableDeliveryRecord | undefined {
    this.assertActive();
    const entry = this.document.deliveries.find((item) => item.controllerId === controllerId && item.idempotencyKey === idempotencyKey);
    return entry && publicDelivery(entry);
  }

  prepareDelivery(controllerId: string, idempotencyKey: string, identity: DeliveryIdentity): DurableDeliveryRecord {
    this.assertActive();
    cleanText(idempotencyKey);
    validateDelivery(identity);
    if (!this.getRoute(controllerId)) throw new Error("DSH delivery has no durable route owner");
    const previous = this.readDelivery(controllerId, idempotencyKey);
    if (previous) {
      assertSameDelivery(previous, identity);
      return previous;
    }
    const entry: StoredDelivery = { controllerId, idempotencyKey, ...identity, state: "prepared" };
    this.commit({ ...this.document, deliveries: [...this.document.deliveries, entry] });
    return publicDelivery(entry);
  }

  acceptDelivery(controllerId: string, idempotencyKey: string, identity: DeliveryIdentity): DurableDeliveryRecord {
    this.assertActive();
    validateDelivery(identity);
    const previous = this.readDelivery(controllerId, idempotencyKey);
    if (!previous) throw new Error("DSH delivery acceptance requires a prepared receipt");
    assertSameDelivery(previous, identity);
    if (previous.state === "accepted") return previous;
    this.commit({ ...this.document, deliveries: this.document.deliveries.map((item) =>
      item.controllerId === controllerId && item.idempotencyKey === idempotencyKey
        ? { ...item, state: "accepted" } : item) });
    return Object.freeze({ ...identity, state: "accepted" });
  }

  close(): void {
    if (!this.active) return;
    releaseLock(this.directory, this.lock);
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active) throw new Error("DSH callback authority is closed");
    if (this.writeFailed) throw new Error("DSH callback authority write outcome is uncertain; reopen required");
    const lock = readPrivateJson(path.join(this.directory, "owner.lock", "owner.json"));
    if (JSON.stringify(lock) !== JSON.stringify(this.lock)) throw new Error("DSH callback authority ownership changed");
  }

  private commit(document: AuthorityDocument): void {
    this.assertActive();
    try { atomicWrite(path.join(this.directory, "authority.json"), document); } catch (error) {
      // A failed directory fsync may follow a successful rename. Stop this
      // writer rather than overwrite the possibly committed document from an
      // older in-memory snapshot. Reopening validates the actual disk state.
      this.writeFailed = true;
      throw error;
    }
    this.document = document;
  }
}

export function openCallbackAuthority(options: ConstructorParameters<typeof CallbackAuthority>[0]): CallbackAuthority {
  return new CallbackAuthority(options);
}

function publicRoute(route: DurableRouteRecord): DurableRouteRecord {
  return Object.freeze({ controllerId: route.controllerId, sessionId: route.sessionId, headerFingerprint: route.headerFingerprint });
}
function publicDelivery(entry: DurableDeliveryRecord): DurableDeliveryRecord {
  return Object.freeze({ requestFingerprint: entry.requestFingerprint, messageId: entry.messageId, state: entry.state });
}
function sameSession(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.sessionId === b.sessionId && a.headerFingerprint === b.headerFingerprint;
}
function validateSession(session: SessionIdentity): void {
  cleanText(session.sessionId);
  fingerprint(session.headerFingerprint);
}
function validateDelivery(identity: DeliveryIdentity): void {
  fingerprint(identity.requestFingerprint);
  cleanText(identity.messageId);
}
function assertSameDelivery(a: DeliveryIdentity, b: DeliveryIdentity): void {
  if (a.requestFingerprint !== b.requestFingerprint || a.messageId !== b.messageId) throw new Error("DSH delivery idempotency collision");
}
function validateAuthorization(value: LegacyRouteAuthorization): void {
  if (value.explicit !== true) throw new Error("DSH legacy adoption requires explicit authorization");
  cleanText(value.scope);
  cleanText(value.watchId);
  fingerprint(value.historicalProfileFingerprint);
}
function checkedCallbackRoute(value: DshCallbackRoute, controllerId: string): DshCallbackRoute {
  cleanText(controllerId);
  if (Object.keys(value).some((key) => !["schema", "version", "transport", "profile_id", "profile_revision", "controller_session_id", "capabilities"].includes(key)) ||
      value.schema !== "agent-knock-knock/callback-route" || value.version !== 1 ||
      value.transport !== "command_json_v1" || value.profile_id !== "deepseek-harness-native" ||
      value.controller_session_id !== controllerId) throw new Error("DSH persisted callback route is invalid");
  cleanText(value.profile_revision);
  if (value.capabilities && Object.entries(value.capabilities).some(([key, item]) =>
    !["wake", "respond"].includes(key) || typeof item !== "boolean")) throw new Error("DSH callback capabilities are invalid");
  return freezeRoute({ schema: value.schema, version: value.version, transport: value.transport,
    profile_id: value.profile_id, profile_revision: value.profile_revision, controller_session_id: controllerId,
    ...(value.capabilities ? { capabilities: { ...value.capabilities } } : {}) });
}
function freezeRoute(route: DshCallbackRoute): DshCallbackRoute {
  return Object.freeze({ ...route, ...(route.capabilities ? { capabilities: Object.freeze({ ...route.capabilities }) } : {}) });
}
function cleanText(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 8192 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("DSH authority identity is invalid");
}
function fingerprint(value: unknown): void {
  if (typeof value !== "string" || !/^(sha256:)?[a-f0-9]{64}$/u.test(value)) throw new Error("DSH authority fingerprint is invalid");
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function privateDirectory(directory: string): void {
  let created = false;
  try { fs.mkdirSync(directory, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error("DSH authority directory is not private");
  if (created) syncDirectory(path.dirname(directory));
}
function readPrivateJson(filename: string): unknown {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("DSH authority file is not private");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
function readDocument(filename: string, profileDirectory: string, storeDirectory: string): AuthorityDocument {
  const value = readPrivateJson(filename) as AuthorityDocument;
  if (!value || value.version !== 1 || value.profileDirectory !== profileDirectory || value.storeDirectory !== storeDirectory ||
      !/^[a-f0-9-]{36}$/u.test(value.ownerId) || !Array.isArray(value.routes) || !Array.isArray(value.deliveries)) throw new Error("DSH authority scope or document is invalid");
  const controllers = new Set<string>();
  for (const route of value.routes) {
    validateSession(route);
    cleanText(route.controllerId);
    if (controllers.has(route.controllerId) || !Array.isArray(route.callbackRoutes) || !Array.isArray(route.adoptions)) throw new Error("DSH route authority is corrupt");
    controllers.add(route.controllerId);
    route.callbackRoutes.forEach((item: DshCallbackRoute) => checkedCallbackRoute(item, route.controllerId));
    route.adoptions.forEach((authorization: LegacyRouteAuthorization) => {
      validateAuthorization(authorization);
      if (authorization.scope !== `akk-dsh:${digest([profileDirectory, storeDirectory])}:${value.ownerId}`) throw new Error("DSH legacy adoption owner scope changed");
    });
  }
  const deliveries = new Set<string>();
  for (const entry of value.deliveries) {
    validateDelivery(entry);
    cleanText(entry.idempotencyKey);
    const key = JSON.stringify([entry.controllerId, entry.idempotencyKey]);
    if (!controllers.has(entry.controllerId) || deliveries.has(key) || !["prepared", "accepted"].includes(entry.state)) throw new Error("DSH delivery journal is corrupt");
    deliveries.add(key);
  }
  return value;
}
function atomicWrite(filename: string, value: unknown): void {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("DSH callback authority capacity exceeded");
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally { fs.rmSync(temporary, { force: true }); }
}
function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function processStart(pid: number): string | undefined {
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw new Error("DSH authority owner liveness is uncertain");
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const start = result.stdout?.trim().replace(/\s+/gu, " ");
  if (result.error || result.status !== 0 || !start) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined; }
    throw new Error("DSH authority process start cannot be verified");
  }
  return start;
}
function acquireLock(directory: string): OwnerLock {
  const lockDirectory = path.join(directory, "owner.lock");
  const start = processStart(process.pid);
  if (!start) throw new Error("DSH authority current process is unavailable");
  const lock = { pid: process.pid, processStart: start, nonce: randomUUID() };
  try { fs.mkdirSync(lockDirectory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    privateDirectory(lockDirectory);
    const previous = readPrivateJson(path.join(lockDirectory, "owner.json")) as OwnerLock;
    if (!Number.isSafeInteger(previous?.pid) || previous.pid < 1 || typeof previous.processStart !== "string" || !previous.processStart || typeof previous.nonce !== "string") throw new Error("DSH authority owner lock is invalid");
    const observed = processStart(previous.pid);
    if (observed === previous.processStart) throw new Error("DSH callback authority already has a live owner");
    // The old incarnation is verified dead. Serialize its removal inside its
    // still-existing directory so a second reclaimer cannot remove a new lock.
    const reclaim = path.join(lockDirectory, "reclaim");
    fs.mkdirSync(reclaim, { mode: 0o700 });
    try {
      if (JSON.stringify(readPrivateJson(path.join(lockDirectory, "owner.json"))) !== JSON.stringify(previous)) throw new Error("DSH authority owner changed during recovery");
      fs.unlinkSync(path.join(lockDirectory, "owner.json"));
    } finally { fs.rmdirSync(reclaim); }
    fs.rmdirSync(lockDirectory);
    fs.mkdirSync(lockDirectory, { mode: 0o700 });
  }
  try { atomicWrite(path.join(lockDirectory, "owner.json"), lock); } catch (error) {
    fs.rmSync(lockDirectory, { recursive: true, force: true });
    throw error;
  }
  return lock;
}
function releaseLock(directory: string, expected: OwnerLock): void {
  const lockDirectory = path.join(directory, "owner.lock");
  const current = readPrivateJson(path.join(lockDirectory, "owner.json"));
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("DSH authority owner changed before release");
  fs.unlinkSync(path.join(lockDirectory, "owner.json"));
  fs.rmdirSync(lockDirectory);
  syncDirectory(directory);
}
