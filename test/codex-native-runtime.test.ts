import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createCodexNativeRuntime, type CodexNativeClientPort } from "../src/codex-native-runtime.js";
import { CodexNativeError, type CodexNativeSnapshot } from "../src/codex-native-types.js";

const target = { codexHome: "/test/codex", threadId: "thread-native" };
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-native-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshot: CodexNativeSnapshot = { threadId: target.threadId, loaded: true, turns: [], latestTurnId: null, canSend: true, pendingInteractions: [],
    thread: { id: target.threadId, sessionId: "session-native", cwd: "/test", historyMode: "paginated", cliVersion: "0.160.0", originator: "codex-tui", source: "cli", status: { type: "idle" }, turns: [] } };
  const state = { connects: 0, closes: 0, subscriptions: 0, reads: 0, fail: false };
  const client: CodexNativeClientPort = {
    metadata: { codexHome: target.codexHome, serverVersion: "0.162.0", socketPath: "/test/socket", platformFamily: "unix", platformOs: "macos" },
    discover: async () => [snapshot.thread],
    readSnapshot: async () => { state.reads++; if (state.fail) { state.fail = false; throw new CodexNativeError("closed", "disconnected"); } return structuredClone(snapshot); },
    subscribe: async threadId => { assert.equal(threadId, target.threadId); state.subscriptions++; },
    start: async () => { throw new Error("must not send"); }, respond: async () => { throw new Error("must not answer"); }, answerAsync: async () => { throw new Error("must not answer"); },
    readPermissions: async () => { throw new Error("must not inspect permissions"); }, updatePermissions: async () => { throw new Error("must not modify permissions"); },
    close: () => { state.closes++; }
  };
  const runtime = createCodexNativeRuntime({ storeDir: dir, codexHomes: [target.codexHome], clientFactory: async () => { state.connects++; return client; } });
  t.after(async () => runtime.close());
  return { runtime, state, snapshot, client };
}

test("native List and read-only Status do not subscribe or load a thread", async t => {
  const h = fixture(t); const catalog = await h.runtime.catalog.discover();
  assert.equal(catalog.sessions.length, 1); assert.equal(catalog.sessions[0].backendVersion, "0.162.0");
  assert.equal(catalog.errors.length, 0);
  await h.runtime.read(target); assert.equal(h.state.subscriptions, 0); assert.equal(h.state.connects, 1);
});

test("native task observations keep one scoped connection and reconnect only after a failed read", async t => {
  const h = fixture(t);
  await h.runtime.transport.observe(target); await h.runtime.transport.observe(target);
  assert.equal(h.state.connects, 1); assert.equal(h.state.subscriptions, 2);
  h.state.fail = true; await assert.rejects(h.runtime.transport.observe(target), { code: "closed" });
  assert.equal(h.state.closes, 1);
  await h.runtime.transport.observe(target); assert.equal(h.state.connects, 2);
});

test("unloaded historical threads stay unloaded and unconfigured homes never create connections", async t => {
  const h = fixture(t); h.snapshot.loaded = false; h.snapshot.thread.status = { type: "notLoaded" }; h.snapshot.canSend = false;
  const result = await h.runtime.transport.observe(target); assert.equal(result.loaded, false); assert.equal(h.state.subscriptions, 0);
  await assert.rejects(h.runtime.read({ ...target, codexHome: "/unconfigured/home" }), /configured local home/);
  assert.equal(h.state.connects, 1);
});

test("first-task observation permits only a fresh exact idle empty owner and retries subscription on subsequent reads", async t => {
  const h = fixture(t); h.snapshot.historyMaterialized = false;
  h.client.subscribe = async () => { h.state.subscriptions++; throw new CodexNativeError("unmaterialized_subscription", "No first input history"); };
  const empty = await h.runtime.transport.observe(target);
  assert.equal(empty.canSend, true); assert.equal(empty.historyMaterialized, false);
  assert.equal(h.state.reads, 2); assert.equal(h.state.subscriptions, 1);
  await h.runtime.transport.observe(target);
  assert.equal(h.state.subscriptions, 2);
  h.snapshot.historyMaterialized = true;
  h.snapshot.latestTurnId = "first-turn";
  h.snapshot.turns = [{ id: "first-turn", status: "inProgress", items: [], itemsComplete: true }];
  h.snapshot.selectedTurn = h.snapshot.turns[0]; h.snapshot.canSend = false;
  h.snapshot.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  h.client.subscribe = async () => {
    h.state.subscriptions++;
    h.snapshot.pendingInteractions = [{ id: "first-approval", kind: "command_approval", threadId: target.threadId,
      turnId: "first-turn", itemId: "command", method: "item/commandExecution/requestApproval", requestId: 1, questions: [] }];
  };
  const observed = await h.runtime.transport.observe(target, "first-turn");
  assert.equal(observed.selectedTurn?.id, "first-turn");
  assert.equal(observed.pendingInteractions[0]?.id, "first-approval");
  assert.equal(h.state.subscriptions, 3);
});

test("unmaterialized observation never bypasses unknown errors or a changed owner, active task, history or exact-task request", async t => {
  const h = fixture(t); h.snapshot.historyMaterialized = false;
  const empty = structuredClone(h.snapshot);
  const rejection = new CodexNativeError("unmaterialized_subscription", "No first input history");
  for (const mutate of [
    () => { h.snapshot.thread.status = { type: "active", activeFlags: [] }; },
    () => { h.snapshot.loaded = false; },
    () => { h.snapshot.thread.id = "other-owner"; },
    () => { h.snapshot.thread.source = { subAgent: {} }; },
    () => { h.snapshot.thread.historyMode = "legacy"; },
    () => { h.snapshot.historyMaterialized = true; },
    () => { h.snapshot.thread.turns = [{ id: "another-turn", status: "completed", items: [], itemsView: "full",
      error: null, startedAt: null, completedAt: null, durationMs: null }]; },
    () => { h.snapshot.turns = [{ id: "another-turn", status: "completed", items: [], itemsComplete: true }]; },
    () => { h.snapshot.latestTurnId = "another-turn"; },
    () => { h.snapshot.pendingInteractions = [{ id: "approval", kind: "command_approval", threadId: target.threadId,
      turnId: "another-turn", itemId: "command", method: "item/commandExecution/requestApproval", questions: [] }]; }
  ]) {
    Object.assign(h.snapshot, structuredClone(empty));
    h.client.subscribe = async () => { mutate(); throw rejection; };
    await assert.rejects(h.runtime.transport.observe(target), error => error === rejection);
  }
  Object.assign(h.snapshot, structuredClone(empty));
  h.client.subscribe = async () => { throw rejection; };
  await assert.rejects(h.runtime.transport.observe(target, "existing-turn"), error => error === rejection);
  for (const error of [new CodexNativeError("rpc_error", "Unrelated RPC failure"), new Error("unmaterialized_subscription")]) {
    h.client.subscribe = async () => { throw error; };
    await assert.rejects(h.runtime.transport.observe(target), actual => actual === error);
  }
});
