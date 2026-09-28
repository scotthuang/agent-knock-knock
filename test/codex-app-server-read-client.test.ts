import assert from "node:assert/strict";
import test from "node:test";
import {
  connectCodexAppServerReadClient,
  CodexAppServerReadError,
  isCodexUnmaterializedThreadError,
  type CodexAppServerReadTransport
} from "../src/codex-app-server-read-client.js";

const HOME = "/tmp/akk-codex-read-fixture";
const THREAD_ID = "01a0e958-4bb1-7fc3-8649-e153fd90faae";
const TURN_ID = "01a0e959-4bb1-7fc3-8649-e153fd90faae";
const ASYNC_ID = "call_question_1";
const ANSWER = `<send_user_message_question_reply>\n${JSON.stringify([{
  answer: "Yes", question: "UniPat AI?",
  questionItemId: JSON.stringify(["request_user_input_async", ASYNC_ID, 0])
}])}\n</send_user_message_question_reply>`;

test("reads exact paginated thread/turn/items while leaving server questions unanswered", async () => {
  const fixture = new FixtureTransport((request) => {
    if (request.method === "thread/read") {
      fixture.emit({ id: request.id, method: "item/tool/requestUserInput", params: {
        threadId: THREAD_ID, turnId: TURN_ID, itemId: "blocking-question"
      } });
      return { thread: thread() };
    }
    if (request.method === "thread/turns/list") return page([turn()]);
    if (request.method === "thread/items/list") return page([
      { turnId: TURN_ID, startedAtMs: 1_790_645_000_000, completedAtMs: 1_790_645_001_000,
        item: { type: "agentMessage", id: ASYNC_ID, text: "UniPat AI?",
          phase: "final_answer", delivery: "async", questions: [{ title: "UniPat AI?", options: ["Yes", "No"] }] } },
      { turnId: TURN_ID, startedAtMs: 1_790_645_002_000, completedAtMs: 1_790_645_002_000,
        item: { type: "userMessage", id: "answer-1", clientId: null,
          content: [{ type: "text", text: ANSWER, textElements: [] }] } }
    ]);
    throw new Error(`Unexpected request ${request.method}`);
  });
  const client = await connect(fixture);
  try {
    assert.equal(client.metadata.serverVersion, "0.158.0");
    assert.equal((await client.readThread(THREAD_ID)).cliVersion, "0.155.1");
    assert.equal((await client.listTurns({ threadId: THREAD_ID, sortDirection: "desc" })).data[0].status, "completed");
    const items = await client.listItems({ threadId: THREAD_ID, turnId: TURN_ID });
    assert.deepEqual(items.data[0].item.questions, [{ title: "UniPat AI?", options: ["Yes", "No"] }]);
    assert.equal(items.data[1].item.content?.[0].text, ANSWER);
    assert.deepEqual(fixture.sent.map((entry) => entry.method), [
      "initialize", "initialized", "thread/read", "thread/turns/list", "thread/items/list"
    ]);
    assert.equal(fixture.sent.every((entry) => !Object.hasOwn(entry, "result") && !Object.hasOwn(entry, "error")), true);
    assert.deepEqual(fixture.sent[2].params, { threadId: THREAD_ID, includeTurns: false });
    assert.equal((fixture.sent[3].params as Record<string, unknown>).itemsView, "notLoaded");
  } finally { client.close(); }
  assert.equal(fixture.closed, true);
});

test("rejects a backend version or home mismatch before reading user threads", async () => {
  for (const metadata of [
    { ...initialize(), userAgent: "codex_cli_rs/0.157.1 (Mac OS)" },
    { ...initialize(), codexHome: "/tmp/a-different-codex-home" }
  ]) {
    const fixture = new FixtureTransport(() => ({}), metadata);
    await assert.rejects(connect(fixture), (error: unknown) =>
      error instanceof CodexAppServerReadError && error.code === "incompatible_server");
    assert.equal(fixture.closed, true);
    assert.deepEqual(fixture.sent.map((entry) => entry.method), ["initialize"]);
  }
});

test("rejects cross-thread, cross-turn and unknown lifecycle evidence", async () => {
  const fixture = new FixtureTransport((request) => {
    if (request.method === "thread/read") return { thread: { ...thread(), id: "another-thread" } };
    if (request.method === "thread/turns/list") return page([{ ...turn(), status: "unknown" }]);
    return page([{ turnId: "another-turn", item: { id: "item-1", type: "contextCompaction" }, startedAtMs: null, completedAtMs: null }]);
  });
  const client = await connect(fixture);
  try {
    await assert.rejects(client.readThread(THREAD_ID), /different thread/u);
    await assert.rejects(client.listTurns({ threadId: THREAD_ID }), /Unknown Codex turn status/u);
    await assert.rejects(client.listItems({ threadId: THREAD_ID, turnId: TURN_ID }), /different turn/u);
    await assert.rejects(client.listItems({ threadId: THREAD_ID, limit: 101 }), /page limit/u);
  } finally { client.close(); }
});

test("bounds an unresponsive read and ignores its late reply", async () => {
  const fixture = new FixtureTransport(() => undefined);
  const client = await connect(fixture, 10);
  try {
    await assert.rejects(client.readThread(THREAD_ID), (error: unknown) =>
      error instanceof CodexAppServerReadError && error.code === "timeout");
    fixture.emit({ id: fixture.sent[2].id, result: { thread: thread() } });
    assert.equal(fixture.sent.length, 3);
  } finally { client.close(); }
});

test("disconnect rejects outstanding reads and prevents subsequent requests", async () => {
  const fixture = new FixtureTransport(() => undefined);
  const client = await connect(fixture);
  const pending = client.readThread(THREAD_ID);
  fixture.disconnect(new Error("Fixture backend disconnected"));
  await assert.rejects(pending, /backend disconnected/u);
  await assert.rejects(client.listTurns({ threadId: THREAD_ID }), (error: unknown) =>
    error instanceof CodexAppServerReadError && error.code === "closed");
  assert.equal(fixture.sent.length, 3);
});

test("recognizes only the exact selected thread's unmaterialized history error", () => {
  const message = `thread ${THREAD_ID} is not materialized yet; thread/turns/list is unavailable before first user message`;
  const error = new CodexAppServerReadError("rpc_error", "Read rejected", -32600, message);
  assert.equal(isCodexUnmaterializedThreadError(error, THREAD_ID), true);
  assert.equal(isCodexUnmaterializedThreadError(error, "another-thread"), false);
  assert.equal(isCodexUnmaterializedThreadError(new CodexAppServerReadError("rpc_error", "Read rejected", -32601, message), THREAD_ID), false);
  assert.equal(isCodexUnmaterializedThreadError(new Error(message), THREAD_ID), false);
});

type FixtureRequest = { id?: string; method: string; params?: unknown };
class FixtureTransport implements CodexAppServerReadTransport {
  readonly sent: FixtureRequest[] = [];
  closed = false;
  private messageListener?: (message: string) => void;
  private disconnectListener?: (error: Error) => void;

  constructor(
    private readonly answer: (request: FixtureRequest) => unknown,
    private readonly metadata: unknown = initialize()
  ) {}

  send(message: string): void {
    const request = JSON.parse(message) as FixtureRequest;
    this.sent.push(request);
    if (!request.id) return;
    queueMicrotask(() => {
      const result = request.method === "initialize" ? this.metadata : this.answer(request);
      if (result !== undefined) this.emit({ id: request.id, result });
    });
  }
  onMessage(listener: (message: string) => void): () => void {
    this.messageListener = listener;
    return () => { this.messageListener = undefined; };
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListener = listener;
    return () => { this.disconnectListener = undefined; };
  }
  close(): void { this.closed = true; }
  emit(value: unknown): void { this.messageListener?.(JSON.stringify(value)); }
  disconnect(error: Error): void { this.disconnectListener?.(error); }
}

function connect(fixture: FixtureTransport, timeoutMs = 1000) {
  return connectCodexAppServerReadClient({
    codexHome: HOME, expectedServerVersion: "0.158.0", timeoutMs,
    transportFactory: async ({ socketPath }) => {
      assert.equal(socketPath, `${HOME}/app-server-control/app-server-control.sock`);
      return fixture;
    }
  });
}
function initialize() {
  return { userAgent: "codex_cli_rs/0.158.0 (Mac OS 26.0; arm64)", codexHome: HOME, platformFamily: "unix", platformOs: "macos" };
}
function thread() {
  return { id: THREAD_ID, sessionId: THREAD_ID, cwd: "/tmp", historyMode: "paginated", cliVersion: "0.155.1", originator: "codex_cli_rs", source: "cli", status: { type: "active", activeFlags: ["waitingOnUserInput"] }, turns: [] };
}
function turn() {
  return { id: TURN_ID, status: "completed", items: [], itemsView: "notLoaded", error: null, startedAt: 1_790_645_000, completedAt: 1_790_645_002, durationMs: 2000 };
}
function page(data: unknown[]) { return { data, nextCursor: null, backwardsCursor: null }; }
