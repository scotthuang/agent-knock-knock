import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createConversationRuntimeRouteStore } from "../src/conversation-runtime-route-store.js";
import { createConversationRouteStore, type ConversationRouteChoice } from "../src/conversation-route-store.js";
import { createFileLockCliAdapter } from "../src/file-lock-cli-adapter.js";
import { ensureStoreWritable, storeManifestPath, STORE_WRITER_PROTOCOL } from "../src/store.js";

const input = { controllerSession: "controller-one", messageId: "message-one", requestText: "Send once", canonicalTarget: "exact-conversation" };
const native: ConversationRouteChoice = { route: "native", targetId: "codex-cli:v1:exact-thread" };
const terminal: ConversationRouteChoice = { route: "terminal", targetId: "terminal:v2:tmux:codex:work:0.0:123" };
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-runtime-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store"), runtimeDir = path.join(root, "runtime");
  const locks = createFileLockCliAdapter({ now: () => new Date(), nowMs: Date.now, pid: () => process.pid,
    sleepSync: () => { throw new Error("Unexpected route lock contention"); } });
  const create = (directory = storeDir) => createConversationRuntimeRouteStore(directory, runtimeDir, locks);
  const legacy = createConversationRouteStore(storeDir, locks);
  return { root, storeDir, runtimeDir, create, legacy };
}
function newerWriter(storeDir: string): void {
  const file = storeManifestPath(storeDir);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...manifest, writer_protocol: STORE_WRITER_PROTOCOL + 1 }));
}
function snapshot(directory: string): Record<string, string> {
  if (!fs.existsSync(directory)) return {};
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).map(String).sort()
    .filter(name => fs.statSync(path.join(directory, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(directory, name), "utf8")]));
}

test("runtime route reservations ignore the managed writer lease without weakening its protocol", t => {
  const h = fixture(t);
  ensureStoreWritable(h.storeDir);
  newerWriter(h.storeDir);
  fs.writeFileSync(path.join(h.storeDir, ".akk-writer.lock"), JSON.stringify({ pid: process.pid, token: "held-managed-writer" }));
  const before = snapshot(h.storeDir);
  const store = h.create();
  assert.equal(store.reserve(input, native).created, true);
  store.recordReceipt(input, native, { delivered: true, watch_id: "exact-task" });
  assert.equal(h.create().load(input)?.receipt?.watch_id, "exact-task");
  assert.deepEqual(snapshot(h.storeDir), before);
  assert.throws(() => h.legacy.reserve({ ...input, messageId: "still-forbidden" }, terminal), /writer protocol/u);
  assert.equal(fs.statSync(h.runtimeDir).mode & 0o777, 0o700);
});

test("legacy reservations and uncertain pins migrate without modifying the managed Store", t => {
  const h = fixture(t);
  for (const state of ["reserved", "uncertain"] as const) {
    const request = { ...input, messageId: state };
    h.legacy.reserve(request, native);
    if (state === "uncertain") h.legacy.markUncertain(request, native, "timeout");
  }
  newerWriter(h.storeDir);
  const before = snapshot(h.storeDir);
  for (const state of ["reserved", "uncertain"] as const) {
    const request = { ...input, messageId: state };
    assert.equal(h.create().load(request)?.state, state);
    assert.equal(h.create().reserve(request, terminal).record.route, "native");
    h.create().recordReceipt(request, native, { delivered: false, state: "uncertain" });
    assert.deepEqual(h.create().load(request)?.receipt, { delivered: false, state: "uncertain" });
    assert.equal(h.legacy.load(request)?.state, state);
  }
  assert.deepEqual(snapshot(h.storeDir), before);
});

test("a legacy immutable receipt replays read-only without copying an outcome", t => {
  const h = fixture(t);
  h.legacy.reserve(input, terminal);
  const saved = h.legacy.recordReceipt(input, terminal, { delivered: true, receipt: "original" });
  newerWriter(h.storeDir);
  const before = snapshot(h.storeDir);
  assert.deepEqual(h.create().load(input), saved);
  assert.deepEqual(h.create().reserve(input, native), { record: saved, created: false });
  assert.deepEqual(snapshot(h.storeDir), before);
  assert.deepEqual(snapshot(h.runtimeDir), {});
});

test("dual journal disagreement rejects provider, input, and receipt changes", t => {
  const h = fixture(t), store = h.create();
  store.reserve(input, native);
  h.legacy.reserve(input, terminal);
  const before = { managed: snapshot(h.storeDir), runtime: snapshot(h.runtimeDir) };
  assert.throws(() => store.load(input), { code: "conversation_route_conflict" });
  assert.throws(() => store.reserve(input, native), { code: "conversation_route_conflict" });
  assert.throws(() => store.recordReceipt(input, native, { delivered: true }), { code: "conversation_route_conflict" });
  assert.deepEqual({ managed: snapshot(h.storeDir), runtime: snapshot(h.runtimeDir) }, before);
  const other = { ...input, messageId: "receipt-conflict" };
  store.reserve(other, native); store.recordReceipt(other, native, { delivered: false });
  h.legacy.reserve(other, native); h.legacy.recordReceipt(other, native, { delivered: true });
  assert.throws(() => store.load(other), { code: "conversation_route_conflict" });
  assert.throws(() => store.load({ ...input, requestText: "different task" }), { code: "conversation_route_conflict" });
});

test("matching legacy outcomes remain compatible and runtime pins survive managed Store creation", t => {
  const h = fixture(t), store = h.create();
  const first = store.reserve(input, terminal);
  assert.equal(fs.existsSync(h.storeDir), false);
  const receipt = { delivered: true, receipt: "same" };
  store.recordReceipt(input, terminal, receipt);
  h.legacy.reserve(input, terminal); h.legacy.recordReceipt(input, terminal, receipt);
  assert.deepEqual(h.create().load(input)?.receipt, receipt);
  assert.equal(h.create().reserve(input, native).record.route, "terminal");
  assert.equal(first.created, true);
});

test("runtime scope canonicalizes parent aliases and separates managed stores and controllers", t => {
  const h = fixture(t);
  const alias = path.join(h.root, "alias");
  fs.symlinkSync(h.root, alias, "dir");
  h.create().reserve(input, native);
  assert.equal(h.create(path.join(alias, "store")).load(input)?.route, "native");
  const otherStore = h.create(path.join(h.root, "other-store"));
  assert.equal(otherStore.load(input), undefined);
  assert.equal(otherStore.reserve(input, terminal).record.route, "terminal");
  assert.equal(h.create().reserve({ ...input, controllerSession: "controller-two" }, terminal).created, true);
  assert.throws(() => h.create().load({ ...input, canonicalTarget: "different-conversation" }), { code: "conversation_route_conflict" });
});
