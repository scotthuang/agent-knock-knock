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

test("preparation rejection records no execution; an explicit retry prepares only the pinned route", async t => {
  const h = fixture(t); let selections = 0, executions = 0;
  const rejected = new Error("Exact terminal fallback cannot currently accept this task");
  const attempt = () => dispatchConversationRoute({ command: "send", input, store: h.create(),
    select: async () => { selections++; return terminal; },
    prepare: async choice => { assert.equal(choice.route, "terminal"); throw rejected; },
    execute: async () => { executions++; return {}; } });
  await assert.rejects(attempt(), error => error === rejected);
  const saved = h.create().load(input)!;
  assert.equal(saved.state, "reserved");
  assert.deepEqual(saved.preparation_rejection, {
    stage: "route_preparation", request_dispatched: false, error_code: "route_preparation_rejected"
  });
  assert.equal(saved.execution_started_at, undefined);
  await assert.rejects(attempt(), error => error === rejected);
  assert.equal(h.store.load(input)?.revision, saved.revision);
  assert.equal(selections, 1); assert.equal(executions, 0);
  const retried = await dispatchConversationRoute({ command: "send", input, store: h.create(),
    select: async () => { throw new Error("Availability changes cannot reselect this message"); },
    prepare: async choice => { assert.deepEqual(choice, terminal); },
    execute: async choice => {
      executions++; assert.deepEqual(choice, terminal);
      assert.ok(h.store.load(input)?.execution_started_at);
      assert.equal(h.store.load(input)?.preparation_rejection, undefined);
      return { delivered: true, provider_message_id: input.messageId };
    } });
  assert.equal(retried.delivered, true); assert.equal(executions, 1);
});

test("executor exceptions remain uncertain regardless of their wording or earlier preparation rejection", async t => {
  const h = fixture(t);
  h.store.reserve(input, native, { trackPreparation: true });
  h.store.markPreparationRejected(input, native, "temporarily_unavailable");
  await assert.rejects(dispatchConversationRoute({ command: "send", input, store: h.create(),
    select: async () => terminal, prepare: async () => {},
    execute: async () => { throw Object.assign(new Error("Exact terminal fallback cannot currently accept this task"), { code: "timeout" }); }
  }), /Exact terminal fallback/u);
  const saved = h.store.load(input)!;
  assert.equal(saved.state, "uncertain"); assert.equal(saved.error_code, "timeout");
  assert.ok(saved.execution_started_at); assert.equal(saved.preparation_rejection, undefined);
});

test("a late preparation failure cannot downgrade concurrent execution or its accepted receipt", async t => {
  const h = fixture(t);
  let rejectPreparation!: () => void, prepared!: () => void;
  const waiting = new Promise<void>(resolve => { prepared = resolve; });
  const delayed = new Promise<void>((_, reject) => { rejectPreparation = () => reject(new Error("late preparation rejection")); });
  const first = dispatchConversationRoute({ command: "send", input, store: h.store,
    select: async () => native, prepare: async () => { prepared(); await delayed; },
    execute: async () => { throw new Error("Rejected attempt cannot execute"); } });
  await waiting;
  await dispatchConversationRoute({ command: "send", input, store: h.create(),
    select: async () => terminal, execute: async choice => {
      assert.deepEqual(choice, native);
      rejectPreparation();
      await assert.rejects(first, /late preparation rejection/u);
      const running = h.store.load(input)!;
      assert.equal(running.state, "reserved"); assert.ok(running.execution_started_at);
      assert.equal(running.preparation_rejection, undefined);
      return { delivered: true };
    } });
  assert.equal(h.store.load(input)?.state, "recorded");
  assert.equal(h.store.load(input)?.preparation_rejection, undefined);
});

test("receipt accepted while another caller prepares prevents a second executor entry", async t => {
  const h = fixture(t); let executions = 0;
  const result = await dispatchConversationRoute({ command: "send", input, store: h.store, select: async () => native,
    prepare: async () => { h.create().recordReceipt(input, native, { delivered: true, watch_id: "already-accepted" }); },
    execute: async () => { executions++; return {}; } });
  assert.equal(result.replayed, true); assert.equal(result.watch_id, "already-accepted");
  assert.equal(executions, 0);
});

test("old reserved and uncertain messages retain unknown execution history after preparation fails", async t => {
  const h = fixture(t);
  for (const state of ["reserved", "uncertain"] as const) {
    const request = { ...input, messageId: state };
    h.store.reserve(request, native);
    if (state === "uncertain") h.store.markUncertain(request, native, "timeout");
    const before = h.create().load(request);
    await assert.rejects(dispatchConversationRoute({ command: "send", input: request, store: h.create(),
      select: async () => terminal, prepare: async () => { throw new Error("cannot prepare"); },
      execute: async () => { throw new Error("must not execute"); } }), /cannot prepare/u);
    assert.deepEqual(h.create().load(request), before);
  }
});
