import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { DesktopIpcClient, VERIFIED_DESKTOP_BUILD } from "../src/desktop-ipc-client.js";
import { DesktopIpcError, type DesktopCompatibility, type DesktopIpcTransport } from "../src/desktop-types.js";
import { DesktopFrameDecoder, encodeDesktopFrame, readDesktopSocketIdentity } from "../src/desktop-ipc-transport.js";
import { reduceDesktopSnapshot } from "../src/desktop-snapshot.js";

const target = { threadId: "thread-one", ownerClientId: "owner-one" };
const baseline = () => ({ id: target.threadId, hostId: "local", mode: "default", resumeState: "resumed",
  threadRuntimeStatus: { type: "idle" }, requests: [], turns: [{ turnId: "previous-turn", status: "completed", items: [] }] });
const options = () => ({ ...target, expectedRevision: 7, expectedLatestTurnId: "previous-turn", prompt: "do this task",
  clientUserMessageId: "message-one" });
type Wire = Record<string, any>;

class Fixture implements DesktopIpcTransport {
  sent: Wire[] = [];
  closed = false;
  state: Wire = baseline();
  revision = 7;
  acceptedTurnId = "accepted-turn";
  startHandler?: (request: Wire) => void;
  steerHandler?: (request: Wire) => void;
  followHandler?: (request: Wire) => void;
  ownerHandler?: (request: Wire) => void;
  private messages = new Set<(message: unknown) => void>();
  private disconnects = new Set<(error: Error) => void>();
  send(request: Wire): void {
    this.sent.push(request);
    if (request.method === "initialize") this.respond(request, { result: { clientId: "client-one" } });
    if (request.method === "thread-owner-discovery") {
      if (this.ownerHandler) this.ownerHandler(request);
      else this.respond(request, { handledByClientId: target.ownerClientId, result: { supportsUntrustedAppInput: true } });
    }
    if (request.method === "thread-stream-following-changed" && request.params.following) {
      if (this.followHandler) this.followHandler(request); else this.emitSnapshot();
    }
    if (request.method === "thread-follower-start-turn") {
      if (this.startHandler) this.startHandler(request);
      else this.respond(request, { handledByClientId: target.ownerClientId,
        result: { result: { turn: { id: this.acceptedTurnId, status: "inProgress" } } } });
    }
    if (request.method === "thread-follower-steer-turn") {
      if (this.steerHandler) this.steerHandler(request);
      else this.respond(request, { handledByClientId: target.ownerClientId, result: { result: { turnId: "active-turn" } } });
    }
  }
  respond(request: Wire, overrides: Wire): void {
    this.emit({ type: "response", requestId: request.requestId, method: request.method, version: request.version,
      resultType: "success", ...overrides });
  }
  emitSnapshot(overrides: Wire = {}): void {
    this.emit({ type: "broadcast", sourceClientId: target.ownerClientId, targetClientIds: ["client-one"],
      method: "thread-stream-state-changed", version: 11, params: { hostId: "local", conversationId: target.threadId,
        change: { type: "snapshot", revision: this.revision, conversationState: this.state } }, ...overrides });
  }
  emit(message: unknown): void { for (const listener of this.messages) listener(message); }
  disconnect(): void { for (const listener of [...this.disconnects]) listener(new Error("connection lost")); }
  onMessage(listener: (message: unknown) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onDisconnect(listener: (error: Error) => void) { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }
  close(): void { this.closed = true; }
}
const connect = (fixture: Fixture, compatibility: DesktopCompatibility = VERIFIED_DESKTOP_BUILD) => DesktopIpcClient.connect({
  socketPath: "/tmp/akk-test-not-a-real-socket", compatibility, transportFactory: async () => fixture
});
const starts = (fixture: Fixture) => fixture.sent.filter((message) => message.method === "thread-follower-start-turn");
const steers = (fixture: Fixture) => fixture.sent.filter((message) => message.method === "thread-follower-steer-turn");
function asyncFixture() {
  const fixture = new Fixture();
  fixture.state = { ...baseline(), cwd: "/tmp/desktop-test", threadRuntimeStatus: { type: "active" },
    turns: [{ turnId: "active-turn", status: "inProgress", items: [{ id: "async-one", type: "agentMessage",
      text: "Pick a color", delivery: "async", questions: [{ title: "Pick a color", options: ["Blue", "Green"] }] }] }]
  };
  const snapshot = reduceDesktopSnapshot(fixture.state, { ...target, revision: fixture.revision });
  const answer = { ...target, expectedRevision: snapshot.revision, expectedTurnId: "active-turn",
    interactionId: snapshot.asyncQuestions![0].id, answer: "Green", clientUserMessageId: "answer-one" };
  return { fixture, answer };
}

test("Desktop async answer uses one exact-owner steer and permits ordinary progress during durable persistence", async () => {
  const { fixture, answer } = asyncFixture(), client = await connect(fixture);
  try {
    const receipt = await client.answerAsyncOnce({ ...answer, beforeDispatch: async () => {
      fixture.revision++;
      fixture.state.turns[0].items.push({ id: "progress", type: "agentMessage", text: "Still working", phase: "commentary" });
    } });
    assert.equal(receipt.turnId, "active-turn");
    assert.equal(receipt.revision, 8);
    assert.equal(receipt.atomicTurnPrecondition, false);
    assert.equal(starts(fixture).length, 0);
    const request = steers(fixture)[0];
    assert.equal(request.targetClientId, target.ownerClientId);
    assert.equal(request.version, 1);
    assert.equal(request.params.clientUserMessageId, answer.clientUserMessageId);
    assert.equal(request.params.restoreMessage.cwd, "/tmp/desktop-test");
    assert.deepEqual(request.params.restoreMessage.context.commentAttachments, []);
    assert.match(request.params.input[0].text, /request_user_input_async/u);
    await assert.rejects(client.answerAsyncOnce(answer), (error: unknown) => error instanceof DesktopIpcError && error.code === "duplicate_submission");
    assert.equal(steers(fixture).length, 1);
  } finally { client.close(); }
});

test("Desktop async answers reject completed tasks, changed questions and human answers before dispatch", async () => {
  for (const change of ["complete", "changed", "answered", "new-turn"] as const) {
    const { fixture, answer } = asyncFixture(), client = await connect(fixture);
    try {
      await assert.rejects(client.answerAsyncOnce({ ...answer, beforeDispatch: async () => {
        fixture.revision++;
        if (change === "complete") fixture.state.turns[0].status = "completed";
        if (change === "changed") fixture.state.turns[0].items[0].questions[0].title = "Another question";
        if (change === "new-turn") fixture.state.turns[0].turnId = "other-turn";
        if (change === "answered") fixture.state.turns[0].items.push({ id: "human-answer", type: "userMessage", content: [{
          type: "text", text: `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify([
            "request_user_input_async", "async-one", 0]), question: "Pick a color", answer: "Blue" }])}\n</send_user_message_question_reply>`
        }] });
      } }), (error: unknown) => error instanceof DesktopIpcError && error.dispatchState === "not_sent" && error.code === "stale_interaction");
      assert.equal(steers(fixture).length, 0);
    } finally { client.close(); }
  }
});

test("Desktop async post-dispatch disconnect or wrong-task acknowledgement stays uncertain and is not replayed", async () => {
  for (const mode of ["disconnect", "wrong-task", "rpc-error"] as const) {
    const { fixture, answer } = asyncFixture(), client = await connect(fixture);
    fixture.steerHandler = request => {
      if (mode === "disconnect") fixture.disconnect();
      else fixture.respond(request, { handledByClientId: target.ownerClientId,
        ...(mode === "rpc-error" ? { resultType: "error" } : { result: { result: { turnId: "other-turn" } } }) });
    };
    try {
      await assert.rejects(client.answerAsyncOnce(answer), (error: unknown) => error instanceof DesktopIpcError && error.dispatchState === "unknown");
      await assert.rejects(client.answerAsyncOnce(answer));
      assert.equal(steers(fixture).length, 1);
    } finally { client.close(); }
  }
});

test("Desktop async response preserves exact owner and verified-build write boundaries", async () => {
  const { fixture, answer } = asyncFixture(), client = await connect(fixture, { version: "future", build: "future" });
  try {
    await assert.rejects(client.answerAsyncOnce(answer), (error: unknown) => error instanceof DesktopIpcError && error.code === "incompatible_desktop");
    assert.equal(steers(fixture).length, 0);
  } finally { client.close(); }
  const second = asyncFixture(), secondClient = await connect(second.fixture);
  second.fixture.ownerHandler = request => second.fixture.respond(request, {
    handledByClientId: "different-owner", result: { supportsUntrustedAppInput: true }
  });
  try {
    await assert.rejects(secondClient.answerAsyncOnce(second.answer), (error: unknown) => error instanceof DesktopIpcError && error.code === "owner_changed");
    assert.equal(steers(second.fixture).length, 0);
  } finally { secondClient.close(); }
});

test("Desktop submits one exact text to the confirmed owner with inherited settings and no retries", async () => {
  const fixture = new Fixture(), client = await connect(fixture);
  try {
    const owner = await client.discoverOwner(target.threadId);
    assert.equal(owner.ownerClientId, target.ownerClientId);
    const discovery = fixture.sent.find((message) => message.method === "thread-owner-discovery")!;
    assert.equal(discovery.timeoutMs, 10_000);
    const snapshot = await client.observeThread(target);
    let barrierCalled = 0;
    const result = await client.sendTurnOnce({ ...options(), expectedRevision: snapshot.revision,
      beforeDispatch: async (fresh) => { barrierCalled++; assert.equal(fresh.canSend, true); } });
    assert.equal(result.turnId, "accepted-turn");
    assert.equal(result.atomicIdlePrecondition, false);
    assert.equal(barrierCalled, 1);
    const request = starts(fixture)[0];
    assert.equal(request.targetClientId, target.ownerClientId);
    assert.equal(request.version, 2);
    assert.deepEqual(request.params, { conversationId: target.threadId, turnStart: { request: {
      threadId: target.threadId, clientUserMessageId: "message-one", input: [{ type: "text", text: "do this task", text_elements: [] }]
    }, context: { inheritThreadSettings: true } } });
    await assert.rejects(client.sendTurnOnce(options()), (error: unknown) => error instanceof DesktopIpcError && error.code === "duplicate_submission");
    assert.equal(starts(fixture).length, 1);
  } finally { client.close(); }
  assert.equal(fixture.closed, true);
  assert.equal(fixture.sent.at(-1)?.params.following, false);
});

test("Desktop send preflight at the observed revision keeps request options out of snapshot identity", async () => {
  const fixture = new Fixture(), client = await connect(fixture);
  try {
    const initial = await client.observeThread(target);
    const extraTarget = { ...target, prompt: "PRIVATE_PROMPT", expectedRevision: 7,
      clientUserMessageId: "PRIVATE_CLIENT_MESSAGE", beforeDispatch: async () => {} };
    const clean = await client.observeThread(extraTarget);
    assert.deepEqual(clean, initial);
    let barrierSnapshot: unknown;
    const receipt = await client.sendTurnOnce({ ...options(), expectedRevision: initial.revision,
      beforeDispatch: async snapshot => { barrierSnapshot = snapshot; } });
    assert.deepEqual(barrierSnapshot, initial);
    assert.equal(receipt.revision, initial.revision);
    assert.equal(receipt.turnId, "accepted-turn");
    assert.equal(starts(fixture).length, 1);
    assert.doesNotMatch(JSON.stringify(barrierSnapshot), /PRIVATE_|beforeDispatch|expectedRevision|clientUserMessageId/u);
  } finally { client.close(); }
});

test("Desktop snapshot projection failure rejects its registered waiter instead of leaving observation pending", async t => {
  const fixture = new Fixture(), client = await connect(fixture);
  t.mock.method(globalThis, "structuredClone", () => { throw new Error("fixture snapshot clone failure"); });
  try {
    await assert.rejects(client.observeThread(target), /fixture snapshot clone failure/u);
    assert.equal(fixture.closed, true);
    assert.equal(starts(fixture).length, 0);
  } finally { client.close(); }
});

test("Desktop refuses busy, changed history, and a changed state during the durable barrier", async () => {
  for (const mode of ["busy", "history", "patch"] as const) {
    const fixture = new Fixture(), client = await connect(fixture);
    if (mode === "busy") fixture.state.threadRuntimeStatus = { type: "active", activeFlags: [] };
    if (mode === "history") fixture.state.turns[0].turnId = "human-turn";
    try {
      await assert.rejects(client.sendTurnOnce({ ...options(), beforeDispatch: async () => {
        if (mode === "patch") fixture.emit({ type: "broadcast", sourceClientId: target.ownerClientId,
          method: "thread-stream-state-changed", version: 11, targetClientIds: ["client-one"],
          params: { hostId: "local", conversationId: target.threadId,
            change: { type: "patch", revision: 8, baseRevision: 7, patches: [] } } });
      } }), (error: unknown) => error instanceof DesktopIpcError && error.dispatchState === "not_sent");
      assert.equal(starts(fixture).length, 0);
    } finally { client.close(); }
  }
});

test("Desktop rejects spoofed targets and unsupported snapshot versions before any write", async () => {
  const fixture = new Fixture(), client = await connect(fixture);
  fixture.followHandler = () => {
    fixture.emitSnapshot({ sourceClientId: "other-owner" });
    fixture.emitSnapshot({ targetClientIds: ["other-client"] });
    fixture.emitSnapshot({ params: { hostId: "local", conversationId: "different-thread",
      change: { type: "snapshot", revision: 7, conversationState: fixture.state } } });
    fixture.emitSnapshot({ version: 999 });
  };
  await assert.rejects(client.observeThread(target), (error: unknown) => error instanceof DesktopIpcError && error.code === "incompatible_desktop");
  assert.equal(fixture.closed, true);
  assert.equal(starts(fixture).length, 0);
});

test("Desktop write gate checks exact build while compatible-shaped snapshots remain readable", async () => {
  const fixture = new Fixture(), client = await connect(fixture, { version: VERIFIED_DESKTOP_BUILD.version, build: "future" });
  try {
    assert.equal((await client.observeThread(target)).threadId, target.threadId);
    await assert.rejects(client.sendTurnOnce(options()), (error: unknown) => error instanceof DesktopIpcError && error.code === "incompatible_desktop");
    assert.equal(starts(fixture).length, 0);
  } finally { client.close(); }
});

test("Desktop never answers incoming approvals/questions and never claims ownership", async () => {
  const fixture = new Fixture(), client = await connect(fixture);
  try {
    const before = fixture.sent.length;
    for (const method of ["item/commandExecution/requestApproval", "item/tool/requestUserInput"]) {
      fixture.emit({ type: "request", requestId: method, method, params: { threadId: target.threadId } });
    }
    assert.equal(fixture.sent.length, before);
    fixture.emit({ type: "client-discovery-request", requestId: "discovery" });
    assert.deepEqual(fixture.sent.at(-1), { type: "client-discovery-response", requestId: "discovery", response: { canHandle: false } });
  } finally { client.close(); }
});

test("Desktop uncertain dispatch and an existing-turn receipt cannot produce a new-task success or retry", async () => {
  for (const outcome of ["disconnect", "existing", "wrong-owner"] as const) {
    const fixture = new Fixture(), client = await connect(fixture);
    fixture.startHandler = (request) => {
      if (outcome === "disconnect") fixture.disconnect();
      else fixture.respond(request, { handledByClientId: outcome === "wrong-owner" ? "someone-else" : target.ownerClientId,
        result: { result: { turn: { id: "previous-turn", status: "inProgress" } } } });
    };
    try {
      await assert.rejects(client.sendTurnOnce(options()), (error: unknown) => error instanceof DesktopIpcError
        && error.dispatchState === (outcome === "existing" ? "accepted" : "unknown"));
      assert.equal(starts(fixture).length, 1);
      await assert.rejects(client.sendTurnOnce(options()));
      assert.equal(starts(fixture).length, 1);
    } finally { client.close(); }
  }
});

test("Desktop revision regression is rejected, while first-follower revision advancement is allowed", async () => {
  const fixture = new Fixture(), client = await connect(fixture);
  try {
    await client.observeThread(target);
    fixture.revision = 6;
    await assert.rejects(client.observeThread(target), /revision regressed/u);
  } finally { client.close(); }
  const fresh = new Fixture(), nextClient = await connect(fresh);
  try { fresh.revision = 8; assert.equal((await nextClient.sendTurnOnce(options())).revision, 8); }
  finally { nextClient.close(); }
});

test("Desktop discovery waits past its backend deadline and timeout cleanup does not resend", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = new Fixture(), client = await connect(fixture);
  fixture.ownerHandler = () => {};
  const pending = client.discoverOwner(target.threadId);
  const rejection = assert.rejects(pending, (error: unknown) => error instanceof DesktopIpcError && error.code === "timeout");
  t.mock.timers.tick(10_000);
  assert.equal(fixture.closed, false);
  t.mock.timers.tick(5_000);
  await rejection;
  assert.equal(fixture.sent.filter((message) => message.method === "thread-owner-discovery").length, 1);
  client.close();
});

test("Desktop frame decoder handles fragmented/coalesced frames and bounds malformed input", () => {
  const decoder = new DesktopFrameDecoder();
  const first = encodeDesktopFrame({ value: "hello" }), second = encodeDesktopFrame({ value: 2 });
  assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(2), second])), [{ value: "hello" }, { value: 2 }]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(33 * 1024 * 1024);
  assert.throws(() => new DesktopFrameDecoder().push(oversized), /frame length/u);
  assert.throws(() => new DesktopFrameDecoder().push(Buffer.alloc(4)), /frame length/u);
  assert.throws(() => new DesktopFrameDecoder().push(Buffer.from([1, 0, 0, 0, 123])), /JSON/u);
});

test("Desktop IPC trusts only private current-user sockets in a private real directory", (t) => {
  const uid = BigInt(process.getuid!());
  const stat = (socket: boolean) => ({ uid, mode: socket ? 0o140600n : 0o40700n, dev: 1n, ino: socket ? 2n : 3n,
    ctimeNs: 4n, isSymbolicLink: () => false, isSocket: () => socket, isDirectory: () => !socket });
  let parent = stat(false), endpoint = stat(true);
  t.mock.method(fs, "lstatSync", (name: fs.PathLike) => String(name).endsWith("/ipc.sock") ? endpoint : parent);
  const first = readDesktopSocketIdentity("/private-owner/ipc/ipc.sock");
  endpoint.ino++;
  assert.notEqual(readDesktopSocketIdentity("/private-owner/ipc/ipc.sock"), first);
  for (const mutation of [
    () => { endpoint.uid = uid + 1n; },
    () => { endpoint.mode |= 0o060n; },
    () => { endpoint.isSymbolicLink = () => true; },
    () => { endpoint.isSocket = () => false; },
    () => { parent.uid = uid + 1n; },
    () => { parent.mode |= 0o007n; },
    () => { parent.isSymbolicLink = () => true; },
    () => { parent.isDirectory = () => false; }
  ]) {
    parent = stat(false); endpoint = stat(true); mutation();
    assert.throws(() => readDesktopSocketIdentity("/private-owner/ipc/ipc.sock"),
      (error: unknown) => error instanceof DesktopIpcError && error.code === "unsafe_socket");
  }
});
