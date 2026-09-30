import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  connectCodexAppServerInteractionClient,
  type CodexAppServerQuestionAnswers
} from "../src/codex-app-server-interaction-client.js";
import type { CodexAppServerReadTransport } from "../src/codex-app-server-read-client.js";
import type { CodexPaginatedThreadBinding } from "../src/codex-paginated-thread-binding.js";
import type { CodexPaginatedBackendVersion, CodexPaginatedVersion } from "../src/codex-lifecycle-compatibility.js";

const THREAD_ID = "01a0e958-4bb1-7fc3-8649-e153fd90faae";
const TURN_ID = "01a0e959-4bb1-7fc3-8649-e153fd90faae";
const ITEM_ID = "call_exact_question_1";
const ANSWERS = { confirm_company: { answers: ["Yes"] } };
const CODEX_VERSION_PAIRS = [["0.158.0", "0.158.0"], ["0.159.0", "0.159.0"],
  ["0.159.0", "0.159.2"], ["0.159.2", "0.159.2"]] as const;

for (const [version, serverVersion] of CODEX_VERSION_PAIRS) test("rejoins only the exact loaded question turn and reads replay without answering for " + version + "/" + serverVersion, async () => {
  const fixture = new InteractionFixture(version, serverVersion);
  const client = await fixture.connect();
  try {
    const pending = client.listPendingQuestions();
    assert.equal(client.metadata.serverVersion, serverVersion);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].requestId, 77);
    assert.equal(pending[0].itemId, ITEM_ID);
    assert.equal(pending[0].isBlocking, true);
    pending[0].questions[0].question = "A caller must not alter the pending request";
    assert.equal(client.listPendingQuestions()[0].questions[0].question, "UniPat AI?");
    const initialize = fixture.sent.find((message) => message.method === "initialize")!;
    assert.deepEqual((initialize.params as Record<string, unknown>).clientInfo, {
      name: "codex-tui", title: "AKK native question bridge", version
    });
    assert.deepEqual(fixture.sent.find((message) => message.method === "thread/resume")?.params,
      { threadId: THREAD_ID, excludeTurns: true });
    assert.equal(fixture.sent.some((message) => Object.hasOwn(message, "result")), false);
  } finally { await client.close(); fixture.cleanup(); }
  assert.equal(fixture.sent.at(-1)?.method, "thread/unsubscribe");
  assert.equal(fixture.closed, true);
});

for (const [version, serverVersion] of CODEX_VERSION_PAIRS) test("confirms one exact durable answer and prevents concurrent response retries for " + version + "/" + serverVersion, async () => {
  const fixture = new InteractionFixture(version, serverVersion);
  const client = await fixture.connect();
  try {
    const results = await Promise.allSettled([client.answer(77, ANSWERS), client.answer(77, ANSWERS)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const completed = results.find((result) => result.status === "fulfilled");
    assert.ok(completed && completed.status === "fulfilled");
    assert.equal(completed.value.status, "confirmed");
    assert.equal(fixture.answerWrites().length, 1);
    assert.deepEqual(fixture.answerWrites()[0], { id: 77, result: { answers: ANSWERS } });
    await assert.rejects(client.answer(77, ANSWERS), /cannot be retried/u);
    assert.equal(client.listPendingQuestions().length, 0);
  } finally { await client.close(); fixture.cleanup(); }
});

test("a resolved notification cannot confirm our answer when another answer wins", async () => {
  const fixture = new InteractionFixture();
  fixture.outputAnswers = { confirm_company: { answers: ["No"] } };
  const client = await fixture.connect();
  try {
    assert.deepEqual(await client.answer(77, ANSWERS), {
      status: "response_uncertain", requestId: 77, itemId: ITEM_ID,
      reason: "another_question_answer_won"
    });
    assert.equal(fixture.answerWrites().length, 1);
    await assert.rejects(client.answer(77, ANSWERS), /cannot be retried/u);
  } finally { await client.close(); fixture.cleanup(); }
});

test("rejects unloaded or changed active turns before any resume or answer", async () => {
  for (const change of ["unloaded", "different-turn"] as const) {
    const fixture = new InteractionFixture();
    fixture.change = change;
    try {
      await assert.rejects(fixture.connect(), /not loaded|exact active turn changed/u);
      assert.equal(fixture.sent.some((message) => message.method === "thread/resume"), false);
      assert.equal(fixture.answerWrites().length, 0);
      assert.equal(fixture.closed, true);
    } finally { fixture.cleanup(); }
  }
});

test("rejects blocking backend changes in either direction before subscribing or answering", async () => {
  for (const [clientVersion, boundVersion, backendVersion] of [
    ["0.158.0", "0.158.0", "0.159.0"], ["0.159.0", "0.159.0", "0.158.0"],
    ["0.159.0", "0.159.0", "0.159.2"], ["0.159.0", "0.159.2", "0.159.0"]
  ] as const) {
    const fixture = new InteractionFixture(clientVersion, boundVersion);
    fixture.backendVersion = backendVersion;
    try {
      await assert.rejects(fixture.connect(), /backend version/u);
      assert.deepEqual(fixture.sent.map((message) => message.method), ["initialize"]);
      assert.equal(fixture.answerWrites().length, 0);
      assert.equal(fixture.closed, true);
    } finally { fixture.cleanup(); }
  }
});

test("rejects reversed or unaudited blocking bindings before connecting", async () => {
  for (const [clientVersion, backendVersion] of [
    ["0.159.2", "0.159.0"], ["0.158.0", "0.159.2"], ["0.159.0", "0.159.3"]
  ] as const) {
    const fixture = new InteractionFixture(clientVersion, backendVersion);
    try {
      await assert.rejects(fixture.connect(), /binding is unsupported/u);
      assert.deepEqual(fixture.sent, []);
    } finally { fixture.cleanup(); }
  }
});

test("requires all exact question IDs before sending and reports unavailable proof truthfully", async () => {
  const fixture = new InteractionFixture();
  const client = await fixture.connect({ captureAnswerProof: () => { throw new Error("Proof unavailable"); } });
  try {
    await assert.rejects(client.answer(77, {}), /exact full question batch/u);
    await assert.rejects(client.answer(77, { ...ANSWERS, unknown_question: { answers: ["Yes"] } }), /exact full question batch/u);
    assert.equal(fixture.answerWrites().length, 0);
    const result = await client.answer(77, ANSWERS);
    assert.equal(result.status, "response_uncertain");
    assert.equal(result.reason, "canonical_question_answer_evidence_unavailable");
    assert.equal(fixture.answerWrites().length, 1);
    await assert.rejects(client.answer(77, ANSWERS), /cannot be retried/u);
  } finally { await client.close(); fixture.cleanup(); }
});

test("does not write an answer when durable turn identity changed after the active-turn read", async () => {
  for (const payload of [
    { type: "task_started", turn_id: "another-turn" },
    { type: "task_complete", turn_id: TURN_ID }
  ]) {
    const fixture = new InteractionFixture();
    const client = await fixture.connect();
    try {
      fs.appendFileSync(fixture.rolloutPath, `${JSON.stringify({ ordinal: 2, type: "event_msg", payload })}\n`);
      await assert.rejects(client.answer(77, ANSWERS), /current turn changed|no longer active/u);
      assert.equal(fixture.answerWrites().length, 0);
      assert.equal(client.listPendingQuestions().length, 1);
    } finally { await client.close(); fixture.cleanup(); }
  }
});

type Message = { id?: string | number; method?: string; params?: unknown; result?: unknown };
class InteractionFixture implements CodexAppServerReadTransport {
  readonly home = fs.mkdtempSync(path.join(os.tmpdir(), "akk-question-proof-"));
  readonly rolloutPath = path.join(this.home, "sessions", "rollout.jsonl");
  readonly sent: Message[] = [];
  closed = false;
  backendVersion: string;
  outputAnswers: CodexAppServerQuestionAnswers = ANSWERS;
  change?: "unloaded" | "different-turn";
  private messageListener?: (text: string) => void;
  private disconnectListener?: (error: Error) => void;

  constructor(readonly version: CodexPaginatedVersion = "0.158.0", readonly boundServerVersion: string = version) {
    this.backendVersion = boundServerVersion;
    fs.mkdirSync(path.dirname(this.rolloutPath));
    fs.writeFileSync(this.rolloutPath, `${JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: THREAD_ID, history_mode: "paginated" } })}\n` +
      `${JSON.stringify({ ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: TURN_ID } })}\n`, { mode: 0o600 });
  }
  connect(overrides: { captureAnswerProof?: () => never } = {}) {
    return connectCodexAppServerInteractionClient({
      binding: this.binding(), nativeTurnId: TURN_ID, timeoutMs: 1000,
      transportFactory: async () => this, ...overrides
    });
  }
  binding(): CodexPaginatedThreadBinding {
    return { codexHome: this.home, threadId: THREAD_ID, agentVersion: this.version,
      serverVersion: this.boundServerVersion as CodexPaginatedBackendVersion,
      processUuid: "codex-pid:1234:birth:fixture", processBirth: "fixture", pid: 1234, observedAt: "2026-09-29T00:00:00.000Z" };
  }
  send(text: string): void {
    const message = JSON.parse(text) as Message;
    this.sent.push(message);
    if (Object.hasOwn(message, "result")) {
      fs.appendFileSync(this.rolloutPath, `${JSON.stringify({ ordinal: 2, type: "response_item", payload: { type: "function_call_output", call_id: ITEM_ID, output: JSON.stringify({ answers: this.outputAnswers }) } })}\n`);
      this.emit({ method: "serverRequest/resolved", params: { threadId: THREAD_ID, requestId: 77 } });
      return;
    }
    if (message.id === undefined) return;
    queueMicrotask(() => {
      let result: unknown = {};
      if (message.method === "initialize") result = { userAgent: "codex_cli_rs/" + this.backendVersion + " (macOS)", codexHome: this.home, platformFamily: "unix", platformOs: "macos" };
      if (message.method === "thread/read" || message.method === "thread/resume") result = { thread: this.thread() };
      if (message.method === "thread/turns/list") result = { data: [{ id: this.change === "different-turn" ? "another-turn" : TURN_ID, status: "inProgress" }], nextCursor: null };
      this.emit({ id: message.id, result });
      if (message.method === "thread/resume") {
        this.emit({ id: 999, method: "item/tool/requestUserInput", params: { ...this.question(), threadId: "another-thread" } });
        this.emit({ id: 998, method: "item/tool/requestUserInput", params: { ...this.question(), turnId: "another-turn" } });
        this.emit({ id: 77, method: "item/tool/requestUserInput", params: this.question() });
      }
    });
  }
  thread() {
    return { id: THREAD_ID, historyMode: "paginated", originator: "codex-tui", path: this.rolloutPath,
      cliVersion: this.version,
      status: this.change === "unloaded" ? { type: "notLoaded" } : { type: "active", activeFlags: ["waitingOnUserInput"] } };
  }
  question() {
    return { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID, questions: [{
      id: "confirm_company", header: "Company", question: "UniPat AI?", isOther: true, isSecret: false,
      options: [{ label: "Yes", description: "Research this company" }, { label: "No", description: "Select another company" }]
    }] };
  }
  answerWrites() { return this.sent.filter((message) => Object.hasOwn(message, "result")); }
  onMessage(listener: (text: string) => void) { this.messageListener = listener; return () => { this.messageListener = undefined; }; }
  onDisconnect(listener: (error: Error) => void) { this.disconnectListener = listener; return () => { this.disconnectListener = undefined; }; }
  close() { this.closed = true; }
  emit(message: unknown) { this.messageListener?.(JSON.stringify(message)); }
  cleanup() { fs.rmSync(this.home, { recursive: true, force: true }); }
}
