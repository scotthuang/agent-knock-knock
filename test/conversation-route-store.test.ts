import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createConversationRouteStore, type ConversationRouteChoice } from "../src/conversation-route-store.js";
import { createFileLockCliAdapter } from "../src/file-lock-cli-adapter.js";

const input = { controllerSession: "controller-one", messageId: "same-message", requestText: "Perform exactly one task", canonicalTarget: "logical-thread-one" };
const native: ConversationRouteChoice = { route: "native", targetId: "codex-cli:v1:exact-thread" };
const terminal: ConversationRouteChoice = { route: "terminal", targetId: "terminal:v2:tmux:codex:akk:0.0:123" };
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-conversation-route-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const locks = createFileLockCliAdapter({ now: () => new Date(), nowMs: Date.now, pid: () => process.pid,
    sleepSync: () => { throw new Error("Unexpected synchronous contention in route fixture"); } });
  const create = () => createConversationRouteStore(directory, locks);
  return { directory, create, store: create() };
}

test("route winner survives competing native availability decisions and process reconstruction", async t => {
  const h = fixture(t), first = h.store, second = h.create();
  // Both callers finish preflight before either reserves. The second choice must lose under the journal lock.
  assert.equal(first.load(input), undefined); assert.equal(second.load(input), undefined);
  const reservations = await Promise.all([
    Promise.resolve().then(() => first.reserve(input, terminal)),
    Promise.resolve().then(() => second.reserve(input, native))
  ]);
  assert.deepEqual(reservations.map(item => item.created), [true, false]);
  assert.equal(reservations[1].record.route, "terminal");
  assert.equal(reservations[1].record.target_id, terminal.targetId);
  assert.equal(h.create().reserve(input, native).record.id, reservations[0].record.id);
  assert.equal(h.create().load(input)?.route, "terminal");
  const journalFile = path.join(h.directory, "conversation-routes", `${reservations[0].record.id}.json`);
  assert.equal(fs.statSync(journalFile).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(journalFile)).filter(name => name.endsWith(".json")).length, 1);
});

test("reserved crash and uncertain native delivery remain pinned without authorizing terminal fallback", t => {
  const h = fixture(t), initial = h.store.reserve(input, native).record;
  const crashed = h.create().reserve(input, terminal);
  assert.equal(crashed.created, false); assert.equal(crashed.record.state, "reserved");
  assert.equal(crashed.record.route, "native");
  const uncertain = h.create().markUncertain(input, native, "timeout");
  assert.equal(uncertain.state, "uncertain"); assert.equal(uncertain.revision, initial.revision + 1);
  const retry = h.create().reserve(input, terminal).record;
  assert.equal(retry.route, "native"); assert.equal(retry.receipt, undefined);
  assert.equal(retry.error_code, "timeout");
  assert.throws(() => h.store.markUncertain(input, terminal, "closed"), { code: "conversation_route_conflict" });
  assert.equal(h.store.markUncertain(input, native, "closed").revision, uncertain.revision);
});

test("recorded uncertain receipt is immutable and remains a replay result, not delivery proof", t => {
  const h = fixture(t); h.store.reserve(input, native);
  const receipt = { delivered: false, send_state: "uncertain", callback_expected: false, watch_id: "codex-cli-watch:pending" };
  const recorded = h.store.recordReceipt(input, native, receipt);
  receipt.delivered = true;
  const restored = h.create().load(input)!;
  assert.equal(restored.state, "recorded"); assert.equal(restored.receipt?.delivered, false);
  assert.equal(h.create().reserve(input, terminal).record.route, "native");
  assert.equal(h.store.recordReceipt(input, native, restored.receipt!).revision, recorded.revision);
  assert.throws(() => h.store.recordReceipt(input, native, receipt), { code: "conversation_route_conflict" });
  assert.throws(() => h.store.recordReceipt(input, terminal, restored.receipt!), { code: "conversation_route_conflict" });
  assert.deepEqual(h.store.markUncertain(input, native, "closed"), restored);
});

test("message identity binds request and canonical target, while separate controllers remain independent", t => {
  const h = fixture(t); const original = h.store.reserve(input, native).record;
  for (const changed of [{ ...input, requestText: "A different task" }, { ...input, canonicalTarget: "different-thread" }]) {
    assert.throws(() => h.store.load(changed), { code: "conversation_route_conflict" });
    assert.throws(() => h.store.reserve(changed, terminal), { code: "conversation_route_conflict" });
  }
  const other = h.store.reserve({ ...input, controllerSession: "controller-two" }, terminal);
  assert.equal(other.created, true); assert.notEqual(other.record.id, original.id);
  assert.throws(() => h.store.recordReceipt({ ...input, messageId: "not-reserved" }, native, {}), { code: "conversation_route_missing" });
  assert.throws(() => h.store.reserve({ ...input, messageId: "" }, native), { code: "conversation_route_invalid" });
});

test("corrupt durable route cannot be treated as absent and silently choose a new transport", t => {
  const h = fixture(t), record = h.store.reserve(input, native).record;
  const file = path.join(h.directory, "conversation-routes", `${record.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...record, message_id: "tampered-message" }));
  assert.throws(() => h.create().load(input), { code: "conversation_route_invalid" });
  assert.throws(() => h.create().reserve(input, terminal), { code: "conversation_route_invalid" });
});
