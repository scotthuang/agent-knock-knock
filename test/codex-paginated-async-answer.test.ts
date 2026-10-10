import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverCodexPaginatedAsyncAnswer,
  type CodexPaginatedAsyncAnswerInput,
  type CodexPaginatedAsyncAnswerPorts
} from "../src/codex-paginated-async-answer.js";
import type { CodexAppServerReadTransport } from "../src/codex-app-server-read-client.js";
import type { CodexPaginatedTaskSnapshot } from "../src/codex-paginated-task.js";
import type { CodexPaginatedBackendVersion, CodexPaginatedVersion } from "../src/codex-lifecycle-compatibility.js";

const HOME = "/tmp/akk-native-async-answer";
const THREAD = "01a0e958-4bb1-7fc3-8649-e153fd90faae";
const TURN = "01a0e959-4bb1-7fc3-8649-e153fd90faae";
const ITEM = "async-question-message";
const NATIVE_ID = JSON.stringify(["request_user_input_async", ITEM, 0]);
const CLIENT_ID = "b5e512ec-70b1-4f59-b72c-af6d55e6c511";
const CODEX_VERSION_PAIRS = [["0.158.0", "0.158.0"], ["0.159.0", "0.159.0"],
  ["0.159.0", "0.159.2"], ["0.159.2", "0.159.2"],
  ["0.159.3", "0.159.3"], ["0.159.3", "0.160.0"], ["0.160.0", "0.160.0"], ["0.162.1", "0.162.1"]] as const;

for (const [version, serverVersion] of CODEX_VERSION_PAIRS) test("sends one closed native turn CAS and confirms only its exact durable reply for " + version + "/" + serverVersion, async () => {
  const fixture = new AsyncAnswerFixture(version, serverVersion);
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
  assert.deepEqual(fixture.snapshotReadVersions, [serverVersion, serverVersion]);
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

test("one native answer waits up to 15 seconds for its exact receipt, including after RPC failure and early completion", async () => {
  for (const { receiptDelayMs, mode, completedBeforeReceipt } of [
    { receiptDelayMs: 6_000, mode: "no-receipt", completedBeforeReceipt: false },
    { receiptDelayMs: 6_000, mode: "rpc-reject", completedBeforeReceipt: true },
    { receiptDelayMs: 15_001, mode: "no-receipt", completedBeforeReceipt: false }
  ] as const) {
    const fixture = new AsyncAnswerFixture("0.159.2");
    fixture.mode = mode;
    let elapsedMs = 0;
    let committed = false;
    const ports = fixture.ports();
    ports.now = () => elapsedMs;
    ports.sleep = async (milliseconds) => {
      elapsedMs += milliseconds;
      if (completedBeforeReceipt) {
        fixture.snapshot.turns[0]!.status = "completed";
        fixture.snapshot.thread.status = { type: "idle" };
      }
      if (!committed && elapsedMs >= receiptDelayMs) {
        const params = fixture.steers()[0]!.params as { input: { text: string }[] };
        fixture.snapshot.turns[0]!.items.push(fixture.replyItem(CLIENT_ID, params.input[0]!.text));
        fixture.snapshot.turns[0]!.status = "completed";
        fixture.snapshot.thread.status = { type: "idle" };
        committed = true;
      }
    };
    // Keep the fixture's 200ms RPC timeout: durable observation has its own window.
    const result = await deliverCodexPaginatedAsyncAnswer(fixture.input(), ports);
    if (receiptDelayMs < 15_000) {
      assert.deepEqual(result, { status: "confirmed", clientUserMessageId: CLIENT_ID,
        nativeTurnId: TURN, nativeQuestionId: NATIVE_ID });
      assert.equal(committed, true);
      assert.ok(elapsedMs >= receiptDelayMs && elapsedMs < 15_000);
    } else {
      assert.equal(result.status, "response_uncertain");
      assert.equal(result.reason, "native_async_answer_receipt_pending");
      assert.equal(committed, false);
      assert.equal(elapsedMs, 15_000);
    }
    assert.equal(fixture.reservations, 1);
    assert.equal(fixture.steers().length, 1);
    assert.deepEqual(fixture.sent.map((value) => value.method), ["initialize", "initialized", "turn/steer"]);
    assert.ok(fixture.reads >= 2);
    assert.equal(fixture.closed, true);
  }
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

test("rejects async backend changes in either direction before reserving", async () => {
  for (const [clientVersion, boundVersion, backendVersion] of [
    ["0.158.0", "0.158.0", "0.159.0"], ["0.159.0", "0.159.0", "0.158.0"],
    ["0.159.0", "0.159.0", "0.159.2"], ["0.159.0", "0.159.2", "0.159.0"],
    ["0.159.3", "0.159.3", "0.160.0"], ["0.159.3", "0.160.0", "0.159.3"],
    ["0.160.0", "0.160.0", "0.160.1"]
  ] as const) {
    const fixture = new AsyncAnswerFixture(clientVersion, boundVersion);
    fixture.serverVersion = backendVersion;
    await assert.rejects(fixture.deliver(), /backend version/u);
    assert.equal(fixture.reads, 0);
    assert.equal(fixture.reservations, 0);
    assert.equal(fixture.steers().length, 0);
    assert.equal(fixture.closed, true);
  }
});

test("rejects reversed or unaudited async bindings before connecting", async () => {
  for (const [clientVersion, backendVersion] of [
    ["0.159.2", "0.159.0"], ["0.158.0", "0.159.2"], ["0.159.0", "0.159.3"],
    ["0.160.0", "0.159.3"], ["0.159.2", "0.160.0"], ["0.159.3", "0.160.1"]
  ] as const) {
    const fixture = new AsyncAnswerFixture(clientVersion, backendVersion);
    await assert.rejects(fixture.deliver(), /Native async answer input is invalid/u);
    assert.deepEqual(fixture.sent, []);
    assert.equal(fixture.reads, 0);
    assert.equal(fixture.reservations, 0);
  }
});

for (const [version, serverVersion] of [["0.159.0", "0.159.2"], ["0.159.3", "0.160.0"]] as const)
test("mixed-version answers pin preflight and receipt to " + version + "/" + serverVersion, async () => {
  for (const stage of ["preflight", "receipt"] as const) {
    const fixture = new AsyncAnswerFixture(version, serverVersion);
    const ports = fixture.ports();
    const read = ports.readSnapshot!;
    ports.readSnapshot = async (input) => {
      const snapshot = await read(input);
      if (stage === "preflight" || fixture.reads > 1) snapshot.serverVersion = version;
      return snapshot;
    };
    const delivered = deliverCodexPaginatedAsyncAnswer(fixture.input(), ports);
    if (stage === "preflight") {
      await assert.rejects(delivered, /history is not exact/u);
      assert.equal(fixture.reservations, 0);
      assert.equal(fixture.steers().length, 0);
    } else {
      const result = await delivered;
      assert.equal(result.status, "response_uncertain");
      assert.equal(result.reason, "native_async_answer_evidence_unavailable");
      assert.equal(fixture.reservations, 1);
      assert.equal(fixture.steers().length, 1);
    }
    assert.equal(fixture.snapshotReadVersions.every((version) => version === serverVersion), true);
    assert.equal(fixture.closed, true);
  }
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
  readonly snapshot: CodexPaginatedTaskSnapshot;
  readonly sent: Message[] = [];
  mode: Mode = "normal";
  serverVersion: string;
  reservations = 0;
  reads = 0;
  readonly snapshotReadVersions: string[] = [];
  closed = false;
  changeProcessAfterRead = false;
  throwOnClose = false;
  private clock = 0;
  private listener?: (text: string) => void;
  private disconnected?: (error: Error) => void;
  constructor(readonly version: CodexPaginatedVersion = "0.158.0", readonly boundServerVersion: string = version) {
    this.snapshot = {
      codexHome: HOME, serverVersion: boundServerVersion, completeToBoundary: true,
      thread: { id: THREAD, sessionId: THREAD, cwd: "/tmp/project", cliVersion: version,
        historyMode: "paginated", originator: "codex-tui", source: "vscode", turns: [],
        status: { type: "active", activeFlags: [] } },
      turns: [{ id: TURN, status: "inProgress", itemsView: "full", error: null,
        startedAt: 1_790_643_600, completedAt: null, durationMs: null,
        items: [{ id: ITEM, type: "agentMessage", delivery: "async", phase: "final_answer", text: "UniPat AI?",
          questions: [{ title: "UniPat AI?", options: ["Yes", "No"] }] }] }]
    };
    this.serverVersion = boundServerVersion;
  }
  input(): CodexPaginatedAsyncAnswerInput {
    return { binding: { codexHome: HOME, threadId: THREAD, agentVersion: this.version,
      serverVersion: this.boundServerVersion as CodexPaginatedBackendVersion, pid: 34744,
      processUuid: "fixture-process", processBirth: "fixture-birth", observedAt: "2026-09-29T03:00:00Z" },
      nativeTurnId: TURN, itemId: ITEM, questionIndex: 0,
      expectedQuestion: { title: "UniPat AI?", options: ["Yes", "No"] }, answer: "Yes", timeoutMs: 200,
      beforeDispatch: async () => { this.reservations += 1; } };
  }
  ports(): CodexPaginatedAsyncAnswerPorts {
    return { transportFactory: async () => this,
      readSnapshot: async (input) => {
        this.reads += 1;
        this.snapshotReadVersions.push(input.serverVersion);
        return structuredClone(this.snapshot);
      },
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
