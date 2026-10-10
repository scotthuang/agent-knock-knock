import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { dispatchConversationRoute } from "../src/conversation-route-dispatch.js";
import { createConversationRouteStore, type ConversationRouteChoice } from "../src/conversation-route-store.js";

const input = { controllerSession: "controller", messageId: "stable-message", requestText: "One task", canonicalTarget: "selected-conversation" };
const native: ConversationRouteChoice = { route: "native", targetId: "native-exact-thread" };
const terminal: ConversationRouteChoice = { route: "terminal", targetId: "terminal-exact-process" };
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-route-dispatch-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const create = () => createConversationRouteStore(directory, { acquire: () => () => {} });
  return { create, store: create() };
}

test("preflight terminal fallback stays chosen after backend recovery and receipt replays without another execution", async t => {
  const h = fixture(t); let executions = 0;
  const first = await dispatchConversationRoute({ command: "send", input, store: h.store,
    select: async () => ({ ...terminal, reason: "backend_unavailable" }), execute: async choice => {
      assert.deepEqual(choice, { ...terminal, reason: "backend_unavailable" }); executions++;
      return { conversation_id: "provider-conversation", watch_id: "provider-watch", delivered: true };
    } });
  assert.equal(first.conversation_id, "provider-conversation"); assert.equal(first.watch_id, "provider-watch");
  assert.equal(first.requested_conversation_id, input.canonicalTarget);
  assert.equal(first.message_id, input.messageId);
  assert.deepEqual(first.routing, { policy: "backend_first", transport: "terminal", selected_target: terminal.targetId, reason: "backend_unavailable" });
  const retried = await dispatchConversationRoute({ command: "send", input, store: h.create(),
    select: async () => { throw new Error("Receipt replay must precede backend selection"); },
    execute: async () => { throw new Error("Receipt replay must not dispatch"); } });
  assert.equal(retried.replayed, true); assert.equal(executions, 1);
  assert.equal(retried.message_id, input.messageId);
  assert.equal((retried.routing as Record<string, unknown>).transport, "terminal");
});

test("unknown native send pins uncertainty and retry uses the same provider rather than terminal fallback", async t => {
  const h = fixture(t); const lost = Object.assign(new Error("Native receipt lost"), { code: "timeout", dispatchState: "unknown" });
  await assert.rejects(dispatchConversationRoute({ command: "send", input, store: h.store, select: async () => native,
    execute: async choice => { assert.equal(choice.route, "native"); throw lost; } }), error => error === lost);
  assert.equal(h.create().load(input)?.state, "uncertain");
  assert.equal(h.create().load(input)?.error_code, "timeout");
  const recovered = await dispatchConversationRoute({ command: "send", input, store: h.create(),
    select: async () => { throw new Error("Uncertain route cannot be reselected"); }, execute: async choice => {
      assert.deepEqual(choice, native); return { send_state: "accepted", watch_id: "same-provider-message-ledger" };
    } });
  assert.equal(recovered.watch_id, "same-provider-message-ledger");
});

test("callback false and unproven delivery are receipts, never signals to retry through a terminal", async t => {
  const h = fixture(t); let calls = 0;
  const result = await dispatchConversationRoute({ command: "send", input, store: h.store, select: async () => native,
    execute: async choice => { calls++; assert.equal(choice.route, "native");
      return { delivered: false, send_state: "uncertain", callback_expected: false, agent_acceptance: "unproven" }; } });
  assert.equal(result.callback_expected, false); assert.equal(result.send_state, "uncertain");
  const replay = await dispatchConversationRoute({ command: "send", input, store: h.store,
    select: async () => terminal, execute: async () => { calls++; return {}; } });
  assert.equal(replay.replayed, true); assert.equal(calls, 1);
});

test("immutable input conflict fails before selection or execution, including another public target alias", async t => {
  const h = fixture(t); h.store.reserve(input, native);
  for (const changed of [{ ...input, requestText: "Different task" }, { ...input, canonicalTarget: "another-alias" }]) {
    await assert.rejects(dispatchConversationRoute({ command: "send", input: changed, store: h.store,
      select: async () => { throw new Error("must not select"); }, execute: async () => { throw new Error("must not execute"); } }),
    { code: "conversation_route_conflict" });
  }
});

test("concurrent stale observations preserve the first immutable receipt and first route winner", async t => {
  const h = fixture(t); const executed: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = dispatchConversationRoute({ command: "send", input, store: h.store, select: async () => native,
    execute: async choice => { executed.push(choice.route); firstStarted(); await hold; return { watch_id: "same-watch", status: "completed" }; } });
  await started;
  const second = await dispatchConversationRoute({ command: "send", input, store: h.create(),
    select: async () => { throw new Error("Prior route already reserved"); },
    execute: async choice => { executed.push(choice.route); return { watch_id: "same-watch", status: "watching" }; } });
  release(); const late = await first;
  assert.deepEqual(executed, ["native", "native"]);
  assert.equal(second.status, "watching"); assert.equal(late.status, "watching"); assert.equal(late.replayed, true);
  assert.equal(h.store.load(input)?.receipt?.status, "watching");
});

test("non-send operations use selection without a journal and send refuses absent durable authority", async () => {
  const result = await dispatchConversationRoute({ command: "status", select: async () => native,
    execute: async () => ({ conversation_id: "exact-provider-thread", state: "working" }) });
  assert.equal(result.conversation_id, "exact-provider-thread");
  assert.deepEqual(result.routing, { policy: "backend_first", transport: "codex_backend", selected_target: native.targetId });
  await assert.rejects(dispatchConversationRoute({ command: "send", select: async () => native, execute: async () => ({}) }),
    /requires immutable input and a durable route store/u);
});
