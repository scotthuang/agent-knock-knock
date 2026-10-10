import assert from "node:assert/strict";
import test from "node:test";
import { CodexNativeClient } from "../src/codex-native-client.js";
import { CodexNativeError } from "../src/codex-native-types.js";
import type { CodexAppServerReadTransport } from "../src/codex-app-server-transport.js";

const HOME = "/tmp/akk-native-fixture", THREAD = "thread-one", TURN = "turn-one";
type Message = Record<string, any>;
class Fixture implements CodexAppServerReadTransport {
  sent: Message[] = [];
  loaded = [THREAD];
  closed = false;
  handler: (m: Message) => unknown = () => ({});
  private listeners = new Set<(message: string) => void>();
  private disconnects = new Set<(error: Error) => void>();
  send(text: string): void {
    const m = JSON.parse(text); this.sent.push(m);
    if (!m.method || m.id === undefined) return;
    queueMicrotask(() => {
      if (m.method === "initialize") return this.emit({ id: m.id, result: { codexHome: HOME,
        userAgent: "codex-tui/0.999.0 (Mac OS)", platformFamily: "unix", platformOs: "macos" } });
      if (m.method === "thread/loaded/list") return this.emit({ id: m.id, result: page(this.loaded) });
      const result = this.handler(m);
      if (result !== undefined) this.emit({ id: m.id, result });
    });
  }
  emit(m: Message): void { for (const listener of this.listeners) listener(JSON.stringify(m)); }
  onMessage(listener: (message: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onDisconnect(listener: (error: Error) => void): () => void { this.disconnects.add(listener); return () => this.disconnects.delete(listener); }
  close(): void { this.closed = true; }
  disconnect(): void { for (const listener of this.disconnects) listener(new Error("closed")); }
}
const page = (data: unknown[], nextCursor: string | null = null) => ({ data, nextCursor });
const thread = (type = "idle", extra: Message = {}) => ({ id: THREAD, sessionId: THREAD, cwd: "/tmp/work",
  cliVersion: "0.155.1", originator: "codex-tui", source: "cli", historyMode: "paginated", turns: [],
  status: type === "active" ? { type, activeFlags: ["waitingOnApproval"] } : { type }, ...extra });
const turn = (id = TURN, status = "completed") => ({ id, status, items: [], itemsView: "notLoaded", error: null });
const entry = (id: string, item: Message) => ({ turnId: id, item });
async function connect(f: Fixture, timeoutMs = 1000) {
  return CodexNativeClient.connect({ codexHome: HOME, timeoutMs, transportFactory: async () => f });
}
function baseHandler(m: Message): unknown {
  if (m.method === "thread/read") return { thread: thread() };
  if (m.method === "thread/turns/list") return page([turn()]);
  if (m.method === "thread/items/list") return page([]);
  throw new Error(`Unexpected ${m.method}`);
}

test("native discovery is read-only, accepts contract-valid newer backends, and never resumes history", async () => {
  const f = new Fixture(); f.loaded.push("child", "desktop");
  f.handler = m => ({ thread: thread("idle", { id: m.params.threadId, sessionId: m.params.threadId,
    ...(m.params.threadId === "child" ? { source: { subAgent: {} } } : {}),
    ...(m.params.threadId === "desktop" ? { originator: "codex-desktop", source: "vscode" } : {}) }) });
  const c = await connect(f);
  try {
    assert.equal(c.metadata.serverVersion, "0.999.0");
    assert.deepEqual((await c.discover()).map(t => t.id), [THREAD]);
    assert.equal(f.sent.some(m => m.method === "thread/resume"), false);
    f.loaded = [];
    await assert.rejects(c.subscribe(THREAD), (e: CodexNativeError) => e.code === "thread_not_loaded");
    assert.equal(f.sent.some(m => m.method === "thread/resume"), false);
  } finally { c.close(); }
});

test("exact native task lookup paginates turn and item history without substituting the latest task", async () => {
  const f = new Fixture();
  f.handler = m => {
    if (m.method === "thread/read") return { thread: thread() };
    if (m.method === "thread/turns/list") return m.params.cursor ? page([turn("older")]) : page([turn()], "older-page");
    if (m.method === "thread/items/list") {
      if (m.params.turnId === TURN) return page([]);
      return m.params.cursor ? page([entry("older", { id: "final", type: "agentMessage", text: "Done" })])
        : page([entry("older", { id: "user", type: "userMessage", clientId: "submission", content: [{ type: "text", text: "Task" }] })], "item-page");
    }
    throw new Error("Unexpected call");
  };
  const c = await connect(f);
  try {
    const snapshot = await c.readSnapshot(THREAD, "older");
    assert.equal(snapshot.latestTurnId, TURN);
    assert.equal(snapshot.selectedTurn?.id, "older");
    assert.deepEqual(snapshot.selectedTurn?.items.map(i => i.id), ["user", "final"]);
    assert.equal(snapshot.selectedTurn?.itemsComplete, true);
    f.handler = m => m.method === "thread/items/list" ? page([entry("wrong-turn", { id: "x", type: "agentMessage", text: "Wrong" })]) : baseHandler(m);
    await assert.rejects(c.readSnapshot(THREAD), /crossed the exact turn/u);
  } finally { c.close(); }
});

test("native item reads preserve actual per-item timestamps without replacing missing timestamps", async () => {
  const f = new Fixture();
  f.handler = m => m.method === "thread/items/list" ? page([
    { ...entry(TURN, { id: "comment", type: "agentMessage", phase: "commentary", text: "Build started" }),
      startedAtMs: 1791630000000, completedAtMs: null },
    { ...entry(TURN, { id: "tool", type: "commandExecution", status: "completed" }),
      startedAtMs: 1791630001000, completedAtMs: 1791630002000 },
    entry(TURN, { id: "old-protocol", type: "agentMessage", phase: "commentary", text: "No timestamp" })
  ]) : baseHandler(m);
  const c = await connect(f);
  try {
    const items = (await c.readSnapshot(THREAD)).selectedTurn!.items;
    assert.equal(items[0].startedAtMs, 1791630000000);
    assert.equal(items[0].completedAtMs, undefined);
    assert.equal(items[1].completedAtMs, 1791630002000);
    assert.equal(items[2].startedAtMs, undefined);
    assert.equal(items[2].completedAtMs, undefined);
  } finally { c.close(); }
});

test("native send checks idle state and preserves uncertain dispatch instead of retrying", async () => {
  const f = new Fixture(); let active = true;
  f.handler = m => {
    if (m.method === "thread/read") return { thread: thread(active ? "active" : "idle") };
    if (m.method === "turn/start") { f.disconnect(); return undefined; }
    return baseHandler(m);
  };
  const c = await connect(f);
  try {
    await assert.rejects(c.start(THREAD, { text: "Task", clientUserMessageId: "unique" }), (e: CodexNativeError) => e.code === "thread_not_idle");
    assert.equal(f.sent.some(m => m.method === "turn/start"), false);
    active = false;
    let persisted = false;
    await assert.rejects(c.start(THREAD, { text: "Task", clientUserMessageId: "unique", beforeDispatch: async () => { persisted = true; } }),
      (e: CodexNativeError) => e.dispatchState === "unknown");
    assert.equal(persisted, true);
    assert.equal(f.sent.filter(m => m.method === "turn/start").length, 1);
  } finally { c.close(); }
});

test("replayed approvals are scoped, exactly answered, and stale or duplicate responses are rejected", async () => {
  const f = new Fixture();
  f.handler = m => {
    if (m.method === "thread/resume") {
      for (const target of ["other-thread", THREAD]) f.emit({ id: target === THREAD ? 7 : 8,
        method: "item/commandExecution/requestApproval", params: { threadId: target, turnId: TURN, itemId: "command",
          command: "printf marker", availableDecisions: ["accept", "cancel"] } });
      return { thread: thread("active") };
    }
    if (m.method === "thread/read") return { thread: thread("active") };
    if (m.method === "thread/turns/list") return page([turn(TURN, "inProgress")]);
    return baseHandler(m);
  };
  const c = await connect(f);
  try {
    await c.subscribe(THREAD); const interaction = c.getInteractions(THREAD)[0];
    assert.equal(c.getInteractions("other-thread").length, 0);
    await assert.rejects(c.respond(interaction, { decision: "decline" }), /not offered/u);
    assert.deepEqual(await c.respond(interaction, { decision: "accept" }), { dispatchState: "sent" });
    assert.deepEqual(f.sent.filter(m => m.result), [{ id: 7, result: { decision: "accept" } }]);
    await assert.rejects(c.respond(interaction, { decision: "accept" }), /no longer pending/u);
    f.emit({ method: "serverRequest/resolved", params: { threadId: THREAD, requestId: 7 } });
    assert.deepEqual(c.getInteractions(THREAD), []);
  } finally { c.close(); }
});

test("blocking answers require exact question identity and native option labels", async () => {
  const f = new Fixture();
  f.handler = m => {
    if (m.method === "thread/resume") {
      f.emit({ id: 9, method: "item/tool/requestUserInput", params: { threadId: THREAD, turnId: TURN, itemId: "question",
        questions: [{ id: "color", question: "Color?", isOther: false, options: [{ label: "Blue" }, { label: "Green" }] }] } });
      return { thread: thread("active") };
    }
    if (m.method === "thread/read") return { thread: thread("active") };
    if (m.method === "thread/turns/list") return page([turn(TURN, "inProgress")]);
    return baseHandler(m);
  };
  const c = await connect(f);
  try {
    await c.subscribe(THREAD); const interaction = c.getInteractions(THREAD)[0];
    await assert.rejects(c.respond(interaction, { answers: { wrong: ["Green"] } }), /identify every/u);
    await assert.rejects(c.respond(interaction, { answers: { color: ["Red"] } }), /Invalid answer/u);
    await c.respond(interaction, { answers: { color: ["Green"] } });
    assert.deepEqual(f.sent.find(m => m.result)?.result, { answers: { color: { answers: ["Green"] } } });
  } finally { c.close(); }
});

test("permissions use standalone settings and require effective confirmation without creating a task", async () => {
  const f = new Fixture(); let full = false;
  const settings = () => ({ sandbox: { type: full ? "dangerFullAccess" : "readOnly" },
    activePermissionProfile: { id: full ? ":danger-full-access" : ":read-only" },
    approvalPolicy: full ? "never" : "on-request", approvalsReviewer: "user" });
  f.handler = m => {
    if (m.method === "thread/read") return { thread: thread() };
    if (m.method === "thread/resume") return { thread: thread(), ...settings() };
    if (m.method === "thread/settings/update") {
      assert.deepEqual(m.params, { threadId: THREAD, permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" });
      full = true; f.emit({ method: "thread/settings/updated", params: { threadId: THREAD, threadSettings: settings() } }); return {};
    }
    throw new Error("Unexpected call");
  };
  const c = await connect(f);
  try {
    assert.equal((await c.readPermissions(THREAD)).preset, "read-only");
    assert.equal((await c.updatePermissions(THREAD, "full-access")).preset, "full-access");
    assert.equal(f.sent.some(m => m.method === "turn/start"), false);
    assert.equal(f.sent.filter(m => m.method === "thread/resume").every(m => Object.keys(m.params).sort().join() === "excludeTurns,threadId"), true);
  } finally { c.close(); }
});

test("native async answers use exact expected turn and reject a stale question without a second dispatch", async () => {
  const f = new Fixture(); let answered = false;
  f.handler = m => {
    if (m.method === "thread/read") return { thread: thread("active") };
    if (m.method === "thread/turns/list") return page([turn(TURN, "inProgress")]);
    if (m.method === "thread/items/list") return page([entry(TURN, { id: "question", type: "agentMessage", text: "Color?",
      delivery: "async", questions: [{ title: "Color?", options: ["Blue", "Green"] }] }),
    ...(answered ? [entry(TURN, { id: "answer", type: "userMessage", clientId: "answer-client", content: [{ type: "text",
      text: f.sent.find(m => m.method === "turn/steer")!.params.input[0].text }] })] : [])]);
    if (m.method === "turn/steer") { assert.equal(m.params.expectedTurnId, TURN); answered = true; return { turnId: TURN }; }
    throw new Error("Unexpected call");
  };
  const c = await connect(f);
  try {
    const interaction = (await c.readSnapshot(THREAD)).pendingInteractions[0];
    assert.deepEqual(await c.answerAsync(interaction, { answer: "Green", clientUserMessageId: "answer-client" }),
      { turnId: TURN, clientUserMessageId: "answer-client" });
    assert.deepEqual((await c.readSnapshot(THREAD)).pendingInteractions, []);
    await assert.rejects(c.answerAsync(interaction, { answer: "Blue", clientUserMessageId: "other-client" }), /no longer pending/u);
    assert.equal(f.sent.filter(m => m.method === "turn/steer").length, 1);
  } finally { c.close(); }
});

test("file approval preview is hydrated from the exact item and marks truncated diffs", async () => {
  const f = new Fixture(); const diff = "x".repeat(20_000);
  f.handler = m => {
    if (m.method === "thread/resume") {
      f.emit({ id: 3, method: "item/fileChange/requestApproval", params: { threadId: THREAD, turnId: TURN, itemId: "file" } });
      return { thread: thread("active") };
    }
    if (m.method === "thread/read") return { thread: thread("active") };
    if (m.method === "thread/turns/list") return page([turn(TURN, "inProgress")]);
    if (m.method === "thread/items/list") return page([entry(TURN, { id: "file", type: "fileChange", status: "inProgress",
      changes: [{ path: "/tmp/work/test.txt", kind: { type: "add" }, diff }] })]);
    throw new Error("Unexpected call");
  };
  const c = await connect(f);
  try {
    await c.subscribe(THREAD); const interaction = (await c.readSnapshot(THREAD)).pendingInteractions[0];
    assert.equal(interaction.changes?.[0].path, "/tmp/work/test.txt");
    assert.equal(interaction.changes?.[0].diff?.length, 16_384);
    assert.equal(interaction.changes?.[0].diffTruncated, true);
    await assert.rejects(c.respond({ ...interaction, changes: [{ path: "/tmp/wrong.txt" }] }, { decision: "accept" }), /no longer match/u);
    await c.respond(interaction, { decision: "accept" });
    assert.deepEqual(f.sent.filter(m => m.result), [{ id: 3, result: { decision: "accept" } }]);
  } finally { c.close(); }
});

test("pending file approvals remain answerable before canonical file items materialize, including replay", async () => {
  for (const withLivePreview of [false, true]) {
    const f = new Fixture();
    f.handler = m => {
      if (m.method === "thread/resume") {
        if (withLivePreview) f.emit({ method: "item/started", params: { threadId: THREAD, turnId: TURN,
          item: { id: "file", type: "fileChange", status: "inProgress", changes: [{ path: "/tmp/test.txt", diff: "add marker", kind: { type: "add" } }] } } });
        f.emit({ id: 4, method: "item/fileChange/requestApproval", params: { threadId: THREAD, turnId: TURN, itemId: "file" } });
        return { thread: thread("active") };
      }
      if (m.method === "thread/read") return { thread: thread("active") };
      if (m.method === "thread/turns/list") return page([turn(TURN, "inProgress")]);
      if (m.method === "thread/items/list") return page([]);
      throw new Error("Unexpected call");
    };
    const c = await connect(f);
    try {
      await c.subscribe(THREAD); const snapshot = await c.readSnapshot(THREAD);
      assert.equal(snapshot.selectedTurn?.items.length, 0);
      const interaction = snapshot.pendingInteractions[0];
      assert.equal(interaction.changes?.[0].path, withLivePreview ? "/tmp/test.txt" : undefined);
      assert.deepEqual(await c.respond(interaction, { decision: "accept" }), { dispatchState: "sent" });
      assert.deepEqual(f.sent.filter(m => m.result), [{ id: 4, result: { decision: "accept" } }]);
    } finally { c.close(); }
  }
});
