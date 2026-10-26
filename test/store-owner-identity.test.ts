import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  captureStoreOwnerIdentity,
  STORE_OWNER_HOST_ENV,
  storeOwnerKind,
  type StoreOwnerIdentity
} from "../src/store-owner-identity.js";
import {
  probeStoreOwnerIdentity,
  systemStoreOwnerProcessProbe,
  type StoreOwnerProcessObservation
} from "../src/store-owner-process.js";
import {
  probeStoreOwnerInventory,
  readStoreOwnerInventory,
  registerStoreOwnerIdentity
} from "../src/store-owner-registry.js";

function temporaryStore(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "akk-owner-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = path.join(directory, "store");
  fs.mkdirSync(store, { mode: 0o700 });
  return store;
}

function owner(store: string, pid = 42): StoreOwnerIdentity {
  return { schema: "agent-knock-knock/store-owner", version: 1, host_id: "host-fixture",
    owner_scope: "host", store_dir: store, pid, process_start: "start-one", boot_id: "boot-one",
    instance_nonce: randomUUID(), store_kind: "ephemeral", created_at: "2026-10-23T00:00:00.000Z" };
}

test("owner liveness requires process generation evidence and never equates PID reuse with presence or death", () => {
  const identity = owner("/fixture/store");
  const cases: Array<{ name: string; observed: StoreOwnerProcessObservation; expected: string; missing?: boolean }> = [
    { name: "same incarnation", observed: { state: "present", process_start: "start-one", boot_id: "boot-one" }, expected: "alive" },
    { name: "proven absent", observed: { state: "absent" }, expected: "dead" },
    { name: "unreadable", observed: { state: "unknown" }, expected: "unknown" },
    { name: "reused PID", observed: { state: "present", process_start: "start-two", boot_id: "boot-one" }, expected: "unknown" },
    { name: "different boot", observed: { state: "present", process_start: "start-one", boot_id: "boot-two" }, expected: "unknown" },
    { name: "incomplete live evidence", observed: { state: "present", process_start: null, boot_id: "boot-one" }, expected: "unknown" },
    { name: "missing recorded generation and absent PID", observed: { state: "absent" }, expected: "unknown", missing: true }
  ];
  for (const row of cases) {
    const recorded = row.missing ? { ...identity, process_start: null } : identity;
    assert.equal(probeStoreOwnerIdentity(recorded, () => row.observed).state, row.expected, row.name);
  }
  assert.equal(probeStoreOwnerIdentity(identity, () => { throw new Error("denied"); }).state, "unknown");
});

test("OS permission failure is unknown while ESRCH proves PID absence", (t) => {
  for (const [code, expected] of [["EPERM", "unknown"], ["EACCES", "unknown"], ["ESRCH", "absent"]]) {
    const mocked = t.mock.method(process, "kill", () => { throw Object.assign(new Error(code), { code }); });
    assert.equal(systemStoreOwnerProcessProbe(42).state, expected);
    mocked.mock.restore();
  }
});

test("ephemeral recovery requires explicit opt-in and a private canonical temporary Store", (t) => {
  const store = temporaryStore(t);
  assert.equal(storeOwnerKind(store, {}), "persistent");
  assert.equal(storeOwnerKind(store, { AKK_EPHEMERAL_STORE: "true" }), "persistent");
  assert.equal(storeOwnerKind(store, { AKK_EPHEMERAL_STORE: "1" }), "ephemeral");
  assert.equal(storeOwnerKind(fs.realpathSync(os.tmpdir()), { AKK_EPHEMERAL_STORE: "1" }), "persistent");
  assert.equal(storeOwnerKind(path.join(store, "missing"), { AKK_EPHEMERAL_STORE: "1" }), "persistent");
  fs.chmodSync(store, 0o755);
  assert.equal(storeOwnerKind(store, { AKK_EPHEMERAL_STORE: "1" }), "persistent");
});

test("relay capture retains a verified Host and downgrades unverifiable inherited authority to persistent CLI ownership", (t) => {
  const store = temporaryStore(t);
  const host = owner(store, process.pid);
  const env = { [STORE_OWNER_HOST_ENV]: JSON.stringify(host), AKK_EPHEMERAL_STORE: "1" };
  const captured = captureStoreOwnerIdentity(store, env, () => ({
    state: "present", process_start: host.process_start, boot_id: host.boot_id
  }));
  assert.equal(captured.owner_scope, "host");
  assert.equal(captured.instance_nonce, host.instance_nonce);
  assert.equal(captured.store_kind, "ephemeral");
  const unknown = captureStoreOwnerIdentity(store, env, () => ({ state: "unknown" }));
  assert.equal(unknown.owner_scope, "cli");
  assert.equal(unknown.pid, process.pid);
  assert.equal(unknown.store_kind, "persistent");
  assert.notEqual(unknown.instance_nonce, host.instance_nonce);
  const unrelated = { ...host, pid: 2_000_000_000 };
  const copied = captureStoreOwnerIdentity(store, { ...env, [STORE_OWNER_HOST_ENV]: JSON.stringify(unrelated) },
    () => ({ state: "present", process_start: host.process_start, boot_id: host.boot_id }));
  assert.equal(copied.owner_scope, "cli", "a supplied live observation cannot replace OS ancestry proof");
  assert.equal(copied.store_kind, "persistent");
});

test("Store owner registration preserves all Host incarnations and requires every registered owner dead", (t) => {
  const store = temporaryStore(t);
  const first = owner(store, 42), second = owner(store, 43);
  assert.equal(readStoreOwnerInventory(store).reason, "owner_inventory_absent");
  registerStoreOwnerIdentity(first);
  registerStoreOwnerIdentity(first);
  const initial = readStoreOwnerInventory(store);
  registerStoreOwnerIdentity(second);
  const inventory = readStoreOwnerInventory(store);
  assert.equal(inventory.complete, true);
  assert.equal(inventory.owners.length, 2);
  assert.notEqual(initial.fingerprint, inventory.fingerprint);
  assert.equal(probeStoreOwnerInventory(inventory, pid => pid === 42 ? { state: "absent" }
    : { state: "present", process_start: "start-one", boot_id: "boot-one" }).state, "alive");
  assert.equal(probeStoreOwnerInventory(inventory, pid => ({ state: pid === 42 ? "absent" : "unknown" })).state, "unknown");
  assert.equal(probeStoreOwnerInventory(inventory, () => ({ state: "absent" })).state, "dead");
  assert.throws(() => registerStoreOwnerIdentity({ ...first, pid: 44 }), /cannot be replaced/u);
  assert.equal(readStoreOwnerInventory(store).fingerprint, inventory.fingerprint);
});

test("missing, corrupted or unsafe owner snapshots never become proven-dead registries or legacy absence", (t) => {
  const cases = ["missing-snapshot", "bad-json", "empty-owners", "duplicate-owner", "wrong-store", "invalid-owner", "unsafe-mode", "symlink-snapshot", "legacy-directory"];
  for (const scenario of cases) {
    const store = temporaryStore(t), identity = owner(store);
    registerStoreOwnerIdentity(identity);
    const directory = path.join(store, ".akk-store-owners");
    const record = path.join(directory, "registry.json");
    const snapshot = JSON.parse(fs.readFileSync(record, "utf8"));
    if (scenario === "missing-snapshot") fs.unlinkSync(record);
    if (scenario === "bad-json") fs.writeFileSync(record, "{");
    if (scenario === "empty-owners") fs.writeFileSync(record, JSON.stringify({ ...snapshot, owners: [] }));
    if (scenario === "duplicate-owner") fs.writeFileSync(record, JSON.stringify({ ...snapshot, owners: [identity, identity] }));
    if (scenario === "wrong-store") fs.writeFileSync(record, JSON.stringify({ ...snapshot, store_dir: "/other-store" }));
    if (scenario === "invalid-owner") fs.writeFileSync(record, JSON.stringify({ ...snapshot, owners: [{ ...identity, pid: "42" }] }));
    if (scenario === "unsafe-mode") fs.chmodSync(record, 0o644);
    if (scenario === "symlink-snapshot") {
      fs.renameSync(record, path.join(store, "outside.json"));
      fs.symlinkSync(path.join(store, "outside.json"), record);
    }
    if (scenario === "legacy-directory") {
      fs.unlinkSync(record);
      fs.writeFileSync(path.join(directory, "registrations.ndjson"), `${identity.instance_nonce}\n`, { mode: 0o600 });
    }
    const inventory = readStoreOwnerInventory(store);
    assert.equal(inventory.complete, false, scenario);
    assert.equal(inventory.reason, "owner_inventory_unverifiable", scenario);
    assert.equal(probeStoreOwnerInventory(inventory, () => ({ state: "absent" })).state, "unknown", scenario);
    assert.throws(() => registerStoreOwnerIdentity(owner(store)), Error, scenario);
  }
});

test("failed atomic owner publication preserves the previous snapshot and can be retried without losing registrations", (t) => {
  for (const initialized of [false, true]) {
    const store = temporaryStore(t), first = owner(store), second = owner(store, 43);
    if (initialized) registerStoreOwnerIdentity(first);
    const directory = path.join(store, ".akk-store-owners"), record = path.join(directory, "registry.json");
    const before = initialized ? fs.readFileSync(record, "utf8") : undefined;
    const originalRename = fs.renameSync;
    const failedDestination = initialized ? record : directory;
    const failure = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === failedDestination) throw Object.assign(new Error("atomic publication failure"), { code: "EIO" });
      return originalRename(...args);
    });
    try { assert.throws(() => registerStoreOwnerIdentity(initialized ? second : first), /atomic publication failure/u); }
    finally { failure.mock.restore(); }
    if (initialized) {
      assert.equal(fs.readFileSync(record, "utf8"), before);
      assert.equal(readStoreOwnerInventory(store).owners.length, 1);
    } else {
      assert.equal(readStoreOwnerInventory(store).reason, "owner_inventory_absent");
      assert.equal(fs.existsSync(directory), false, "no empty authoritative directory is published");
    }
    registerStoreOwnerIdentity(initialized ? second : first);
    const inventory = readStoreOwnerInventory(store);
    assert.equal(inventory.complete, true);
    assert.equal(inventory.owners.length, initialized ? 2 : 1);
  }
});

test("an abandoned unpublished owner staging directory grants no authority", (t) => {
  const store = temporaryStore(t);
  const staging = path.join(store, ".akk-store-owners.init-abandoned");
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.writeFileSync(path.join(staging, "registry.json"), "{}", { mode: 0o600 });
  assert.equal(readStoreOwnerInventory(store).reason, "owner_inventory_absent");
  registerStoreOwnerIdentity(owner(store));
  assert.equal(readStoreOwnerInventory(store).complete, true);
  assert.equal(fs.existsSync(staging), true, "registration does not delete another attempt's evidence");
});
