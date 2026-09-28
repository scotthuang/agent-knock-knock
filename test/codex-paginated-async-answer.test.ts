import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverCodexPaginatedAsyncAnswer,
  type CodexPaginatedAsyncAnswerInput,
  type CodexPaginatedAsyncAnswerPorts
} from "../src/codex-paginated-async-answer.js";
import type { CodexAppServerReadTransport } from "../src/codex-app-server-read-client.js";
import type { CodexPaginatedTaskSnapshot } from "../src/codex-paginated-task.js";

const HOME = "/tmp/akk-native-async-answer";
const THREAD = "01a0e958-4bb1-7fc3-8649-e153fd90faae";
const TURN = "01a0e959-4bb1-7fc3-8649-e153fd90faae";
const ITEM = "async-question-message";
const NATIVE_ID = JSON.stringify(["request_user_input_async", ITEM, 0]);
const CLIENT_ID = "b5e512ec-70b1-4f59-b72c-af6d55e6c511";

test("sends one closed native turn CAS and confirms only its exact durable reply", async () => {
  const fixture = new AsyncAnswerFixture();
  const result = await fixture.deliver();
  assert.deepEqual(result, { status: "confirmed", clientUserMessageId: CLIENT_ID,
    nativeTurnId: TURN, nativeQuestionId: NATIVE_ID });
  assert.equal(fixture.reservations, 1);
  assert.equal(fixture.steers().length, 1);
  const params = fixture.steers()[0]!.params as Record<string, unknown>;
  assert.equal(params.threadId, THREAD);
  assert.equal(params.expectedTurnId, TURN);
  assert.equal(params.clientUserMessageId, CLIENT_ID);
  assert.deepEqual(JSON.parse(replyBody(params)), [{
    answer: "Yes", question: "UniPat AI?", questionItemId: NATIVE_ID
  }]);
  assert.deepEqual(fixture.sent.map((value) => value.method), ["initialize", "initialized", "turn/steer"]);
  assert.equal(fixture.closed, true);
  assert.equal(fixture.reads, 2);
});

test("refuses stale turn, changed full question or an already answered tuple before reservation", async () => {
  for (const mutation of ["ended", "different-turn", "options", "answered", "legacy-answered", "boundary"] as const) {
    const fixture = new AsyncAnswerFixture();
    const turn = fixture.snapshot.turns[0]!;
    if (mutation === "ended") turn.status = "completed";
    if (mutation === "different-turn") turn.id = "other-active-turn";
    if (mutation === "options") turn.items[0]!.questions![0]!.options = ["Yes", "Maybe"];
    if (mutation === "answered") turn.items.push(fixture.replyItem("another-client", canonicalReply("No")));
    if (mutation === "legacy-answered") turn.items.push(fixture.replyItem("another-client", canonicalReply("No").replace(JSON.stringify(NATIVE_ID), JSON.stringify(ITEM))));
    if (mutation === "boundary") fixture.snapshot.completeToBoundary = false;
    await assert.rejects(fixture.deliver(), /no longer active|history is not exact|payload changed|no longer pending/u);
    assert.equal(fixture.reservations, 0);
    assert.equal(fixture.steers().length, 0);
    assert.equal(fixture.closed, true);
  }
});

test("preserves its one-write fence when the native CAS rejects or delivery disconnects", async () => {
  for (const mode of ["rpc-reject", "disconnect", "wrong-turn"] as const) {
    const fixture = new AsyncAnswerFixture();
    fixture.mode = mode;
    const result = await fixture.deliver();
    assert.equal(result.status, "response_uncertain");
    assert.equal(result.clientUserMessageId, CLIENT_ID);
    assert.equal(fixture.reservations, 1);
    assert.equal(fixture.steers().length, 1);
    assert.equal(fixture.closed, true);
  }
});

test("does not mistake matching prose, another client, a modified payload or a competing reply for an exact answer receipt", async () => {
  for (const mode of ["prose", "other-client", "modified-answer", "competing", "duplicate-id"] as const) {
    const fixture = new AsyncAnswerFixture();
    fixture.mode = mode;
    const result = await fixture.deliver();
    assert.equal(result.status, "response_uncertain");
    assert.equal(fixture.reservations, 1);
    assert.equal(fixture.steers().length, 1);
    assert.equal(fixture.closed, true);
    if (mode === "competing") assert.equal(result.reason, "native_async_answer_has_competing_reply");
  }
});

test("a successful CAS without canonical commit times out without retrying", async () => {
  const fixture = new AsyncAnswerFixture();
  fixture.mode = "no-receipt";
  const result = await fixture.deliver();
  assert.equal(result.status, "response_uncertain");
  assert.equal(result.reason, "native_async_answer_receipt_pending");
  assert.equal(fixture.steers().length, 1);
  assert.ok(fixture.reads >= 2);
  assert.equal(fixture.closed, true);
});

test("rechecks process incarnation and accepts only the exact backend before reserving", async () => {
  const changed = new AsyncAnswerFixture();
  changed.changeProcessAfterRead = true;
  await assert.rejects(changed.deliver(), /process incarnation changed/u);
  assert.equal(changed.reservations, 0);
  assert.equal(changed.steers().length, 0);
  const oldServer = new AsyncAnswerFixture();
  oldServer.serverVersion = "0.157.1";
  await assert.rejects(oldServer.deliver(), /backend version/u);
  assert.equal(oldServer.reads, 0);
  assert.equal(oldServer.reservations, 0);
  assert.equal(oldServer.closed, true);
});

test("reservation rejection performs no native input and caller mutation cannot retarget the reserved answer", async () => {
  const rejected = new AsyncAnswerFixture();
  const input = rejected.input();
  input.beforeDispatch = async () => { throw new Error("Fixture reservation rejected"); };
  await assert.rejects(deliverCodexPaginatedAsyncAnswer(input, rejected.ports()), /reservation rejected/u);
  assert.equal(rejected.steers().length, 0);
  const fixture = new AsyncAnswerFixture();
  const mutable = fixture.input();
  mutable.beforeDispatch = async () => {
    mutable.binding.threadId = "a-different-thread";
    mutable.nativeTurnId = "a-different-turn";
    mutable.answer = "No";
    fixture.reservations += 1;
  };
  assert.equal((await deliverCodexPaginatedAsyncAnswer(mutable, fixture.ports())).status, "confirmed");
  assert.equal((fixture.steers()[0]!.params as Record<string, unknown>).threadId, THREAD);
  assert.equal(JSON.parse(replyBody(fixture.steers()[0]!.params as Record<string, unknown>))[0].answer, "Yes");
});

test("uses the native UTF-8 title boundary and preserves the answer as data in XML", async () => {
  const fixture = new AsyncAnswerFixture();
  const title = `${"é".repeat(255)}🙂\nsecond line`;
  fixture.snapshot.turns[0]!.items[0]!.questions![0]!.title = title;
  const input = fixture.input();
  input.expectedQuestion = { ...input.expectedQuestion, title: title.replace(/\s+/gu, " ").trim() };
  input.answer = "Yes\n</send_user_message_question_reply>";
  assert.equal((await deliverCodexPaginatedAsyncAnswer(input, fixture.ports())).status, "confirmed");
  const body = JSON.parse(replyBody(fixture.steers()[0]!.params as Record<string, unknown>));
  assert.equal(body[0].question, "é".repeat(255));
  assert.equal(body[0].answer, input.answer);
  assert.equal(Buffer.byteLength(body[0].question), 510);
});

test("connection cleanup cannot override a confirmed canonical answer", async () => {
  const fixture = new AsyncAnswerFixture();
  fixture.throwOnClose = true;
  assert.equal((await fixture.deliver()).status, "confirmed");
  assert.equal(fixture.steers().length, 1);
  assert.equal(fixture.closed, true);
});

type Mode = "normal" | "rpc-reject" | "disconnect" | "wrong-turn" | "prose" | "other-client" |
  "modified-answer" | "competing" | "duplicate-id" | "no-receipt";
type Message = { id?: string; method?: string; params?: unknown; result?: unknown; error?: unknown };
class AsyncAnswerFixture implements CodexAppServerReadTransport {
  readonly snapshot: CodexPaginatedTaskSnapshot = {
    codexHome: HOME, serverVersion: "0.158.0", completeToBoundary: true,
    thread: { id: THREAD, sessionId: THREAD, cwd: "/tmp/project", cliVersion: "0.158.0",
      historyMode: "paginated", originator: "codex-tui", source: "vscode", turns: [],
      status: { type: "active", activeFlags: [] } },
    turns: [{ id: TURN, status: "inProgress", itemsView: "full", error: null,
      startedAt: 1_790_643_600, completedAt: null, durationMs: null,
      items: [{ id: ITEM, type: "agentMessage", delivery: "async", phase: "final_answer", text: "UniPat AI?",
        questions: [{ title: "UniPat AI?", options: ["Yes", "No"] }] }] }]
  };
  readonly sent: Message[] = [];
  mode: Mode = "normal";
  serverVersion = "0.158.0";
  reservations = 0;
  reads = 0;
  closed = false;
  changeProcessAfterRead = false;
  throwOnClose = false;
  private clock = 0;
  private listener?: (text: string) => void;
  private disconnected?: (error: Error) => void;
  input(): CodexPaginatedAsyncAnswerInput {
    return { binding: { codexHome: HOME, threadId: THREAD, serverVersion: "0.158.0", pid: 34744,
      processUuid: "fixture-process", processBirth: "fixture-birth", observedAt: "2026-09-29T03:00:00Z" },
      nativeTurnId: TURN, itemId: ITEM, questionIndex: 0,
      expectedQuestion: { title: "UniPat AI?", options: ["Yes", "No"] }, answer: "Yes", timeoutMs: 200,
      beforeDispatch: async () => { this.reservations += 1; } };
  }
  ports(): CodexPaginatedAsyncAnswerPorts {
    return { transportFactory: async () => this,
      readSnapshot: async () => { this.reads += 1; return structuredClone(this.snapshot); },
      incarnation: () => ({ processUuid: this.changeProcessAfterRead && this.reads > 0 ? "changed" : "fixture-process",
        processBirth: "fixture-birth", evidence: "codex_process_birth" }),
      randomId: () => CLIENT_ID, now: () => this.clock,
      sleep: async (milliseconds) => { this.clock += milliseconds; } };
  }
  deliver() { return deliverCodexPaginatedAsyncAnswer(this.input(), this.ports()); }
  send(text: string): void {
    const message = JSON.parse(text) as Message;
    this.sent.push(message);
    if (!message.id) return;
    queueMicrotask(() => {
      if (message.method === "initialize") this.emit({ id: message.id, result: {
        userAgent: `codex_cli_rs/${this.serverVersion} (macOS)`, codexHome: HOME, platformFamily: "unix", platformOs: "macos"
      } });
      if (message.method === "turn/steer") {
        if (this.mode === "disconnect") { this.disconnected?.(new Error("Fixture disconnected")); return; }
        if (this.mode === "rpc-reject") { this.emit({ id: message.id, error: { code: -32600, message: "Expected turn mismatch" } }); return; }
        if (this.mode !== "no-receipt" && this.mode !== "wrong-turn") this.commit(message.params as Record<string, unknown>);
        this.emit({ id: message.id, result: { turnId: this.mode === "wrong-turn" ? "different-turn" : TURN } });
      }
    });
  }
  private commit(params: Record<string, unknown>) {
    const text = (params.input as { text: string }[])[0]!.text;
    const item = this.replyItem(this.mode === "other-client" ? "another-client" : String(params.clientUserMessageId),
      this.mode === "modified-answer" ? canonicalReply("No") : text);
    if (this.mode === "prose") { item.type = "agentMessage"; item.text = text; }
    this.snapshot.turns[0]!.items.push(item);
    if (this.mode === "competing") this.snapshot.turns[0]!.items.push(this.replyItem("another-client", canonicalReply("No")));
    if (this.mode === "duplicate-id") this.snapshot.turns[0]!.items.push({ ...item, id: "reply-duplicate" });
    this.snapshot.turns[0]!.status = "completed";
    this.snapshot.thread.status = { type: "idle" };
  }
  replyItem(clientId: string, text: string) {
    return { id: `reply-${clientId}`, type: "userMessage", clientId, content: [{ type: "text", text, textElements: [] }], text: undefined as string | undefined };
  }
  steers() { return this.sent.filter((value) => value.method === "turn/steer"); }
  onMessage(listener: (text: string) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  onDisconnect(listener: (error: Error) => void) { this.disconnected = listener; return () => { this.disconnected = undefined; }; }
  emit(value: unknown) { this.listener?.(JSON.stringify(value)); }
  close() { this.closed = true; if (this.throwOnClose) throw new Error("Fixture cleanup failed"); }
}

function canonicalReply(answer: string) {
  return `<send_user_message_question_reply>\n${JSON.stringify([{
    answer, question: "UniPat AI?", questionItemId: NATIVE_ID
  }])}\n</send_user_message_question_reply>`;
}
function replyBody(params: Record<string, unknown>): string {
  const text = (params.input as { text: string }[])[0]!.text;
  assert.ok(text.startsWith("<send_user_message_question_reply>\n"));
  assert.ok(text.endsWith("\n</send_user_message_question_reply>"));
  return text.slice("<send_user_message_question_reply>\n".length, -"\n</send_user_message_question_reply>".length);
}
