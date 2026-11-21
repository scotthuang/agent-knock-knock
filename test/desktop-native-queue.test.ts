import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { readDesktopLatestPersistedTurn, readDesktopQueueSubmission } from "../src/desktop-native-queue.js";
import { fixtureWriter } from "./desktop-native-queue-experiment.js";
import { DesktopIpcError } from "../src/desktop-types.js";

const prompt = "queue proof", clientId = "controller-message", threadId = "dedicated-thread";
const input = { prompt, clientUserMessageId: clientId, baselineTurnId: "baseline" };
const user = (id = "item-1", client = clientId, text = prompt) =>
  ({ id, type: "userMessage", clientId: client, content: [{ type: "text", text, text_elements: [] }] });
const turn = (id: string, items: unknown[], extra = {}) =>
  ({ id, items, itemsView: "full", status: "completed", completedAt: 100, ...extra });
const page = (data: unknown[], nextCursor: string | null = null) => ({ data, nextCursor });

async function fixture(t: TestContext) {
  // Darwin AF_UNIX path limits also apply in environments with an unusually long TMPDIR.
  const home = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "akk-q-"));
  const dir = path.join(home, "app-server-control");
  fs.mkdirSync(dir, { mode: 0o700 });
  const local = path.join(home, "server.sock"), alias = path.join(dir, "app-server-control.sock");
  const server = http.createServer(), sockets = new WebSocketServer({ server });
  const state = {
    pages: new Map<string, ReturnType<typeof page>>([["", page([turn("baseline", [user("baseline-msg", "prior")])])]]),
    replacementHeadAfterCursor: undefined as ReturnType<typeof page> | undefined,
    threadStatus: "notLoaded", rejectReceipt: false, loseAck: false, queued: [] as unknown[], methods: [] as string[],
    home, socketAlias: alias, socketLocal: local, target: { codexHome: home, threadId, hostId: "local" }
  };
  sockets.on("connection", ws => ws.on("message", bytes => {
    const { id, method, params } = JSON.parse(bytes.toString());
    state.methods.push(method);
    if (!id) return;
    let result: unknown;
    if (method === "initialize") result = { userAgent: "codex/0.171.0", codexHome: home, platformFamily: "unix", platformOs: "macos" };
    else if (method === "thread/read") result = { thread: { id: threadId, sessionId: threadId, cliVersion: "0.171.0", originator: "codex_work_desktop",
      source: "vscode", ephemeral: false, threadSource: "user", cwd: home, historyMode: "paginated", status: {type: state.threadStatus}, turns: [] } };
    else if (method === "thread/turns/list") {
      result = state.pages.get(params.cursor ?? "");
      if (params.cursor && state.replacementHeadAfterCursor) state.pages.set("", state.replacementHeadAfterCursor);
    }
    else if (method === "thread/queue/list") result = page(state.queued);
    else if (method === "thread/queue/add") {
      assert.equal(params.threadId, threadId);
      state.queued.push({ id: "queue-id", clientUserMessageId: params.clientUserMessageId, input: params.input });
      if (state.loseAck) { ws.terminate(); return; }
      result = { queuedSubmission: state.rejectReceipt ? { id: "wrong", clientUserMessageId: "other", input: [] } : state.queued[0] };
    } else throw new Error("Unexpected native method in queue fixture");
    ws.send(JSON.stringify({ id, result }));
  }));
  server.listen(local);
  await once(server, "listening");
  fs.chmodSync(local, 0o600);
  fs.symlinkSync(local, alias);
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, {recursive:true, force:true});
  });
  return state;
}

test("native queue requires a genuine fresh admission and exact pending store reservation on a private endpoint", async t => {
  const s = await fixture(t), writer = await fixtureWriter(s.target);
  const prepare = () => writer.prepareDesktopQueue(s.target, s.home);
  const watchId = "desktop-watch:queue-guard";
  const submit = (admission: Awaited<ReturnType<typeof prepare>>) => writer.submitDesktopQueueOnce({
    target: s.target, admission, storeDir: writer.storeDir, watchId, clientUserMessageId: clientId, prompt });
  assert.equal((await readDesktopLatestPersistedTurn(s.target)).latestTurn?.turnId, "baseline");
  assert.equal(s.methods.some(method => method.startsWith("thread/queue/")), false);
  await assert.rejects(prepare().then(grant => submit({...grant})), /No fresh/);
  await assert.rejects(prepare().then(submit), /exact persisted/);
  const a = await prepare(); writer.reserve(watchId, a, clientId, prompt);
  writer.setOwner({draft: "present"});
  await assert.rejects(submit(a), /draft/);
  writer.setOwner();
  const b = await prepare();
  writer.setOwner({endpointId: "replaced"});
  await assert.rejects(submit(b), /changed/);
  writer.setOwner();
  const c = await prepare();
  fs.symlinkSync(s.socketLocal, s.socketAlias + ".new");
  fs.renameSync(s.socketAlias + ".new", s.socketAlias);
  await assert.rejects(submit(c), /changed/);
  assert.equal(s.queued.length, 0);
  assert.equal(writer.repo.load(watchId)?.send_intent?.state, "reserved");
  assert.deepEqual(await submit(await prepare()), {clientUserMessageId: clientId, queueId: "queue-id"});
  assert.equal(writer.repo.load(watchId)?.send_intent?.state, "uncertain");
  await assert.rejects(prepare(), /not empty/);
  s.queued.length=0; // Owner consumed it. A second admission must still not dispatch the same reservation.
  await assert.rejects(submit(await prepare()), (err: unknown) => err instanceof DesktopIpcError && err.dispatchState === "unknown");
  assert.equal(s.methods.filter(m => m === "thread/queue/add").length,1);
});

test("busy, question, unsafe baseline, malformed receipt and lost ACK preserve single native dispatch", async t => {
  const s = await fixture(t), writer = await fixtureWriter(s.target);
  const prepare = () => writer.prepareDesktopQueue(s.target, s.home);
  const base = s.pages.get("")!;
  for (const variant of [turn("active", [user()], {status:"inProgress",completedAt:null}),
    turn("synthetic", [user()], {status:"interrupted",completedAt:null}),
    turn("question", [user(), {id:"q",type:"agentMessage",text:"choose",delivery:"async", questions:[{title:"q", options:null}]}]),
    turn("approval", [user(), {id:"q",type:"fileChange",status:"inProgress"}])]) {
    s.pages.set("", page([variant]));
    await assert.rejects(prepare(), (err: unknown) => err instanceof DesktopIpcError && err.dispatchState === "not_sent");
  }
  s.pages.set("",base);
  for (const variant of ["loseAck","rejectReceipt"] as const) {
    s.queued.length = 0; s[variant] = true;
    const admission = await prepare(), watchId = "desktop-watch:queue-"+variant;
    writer.reserve(watchId,admission,clientId,prompt);
    await assert.rejects(writer.submitDesktopQueueOnce({target:s.target, admission,storeDir:writer.storeDir,
      watchId, clientUserMessageId:clientId, prompt}), (err: unknown) => err instanceof DesktopIpcError && err.dispatchState === "unknown");
    assert.equal(s.queued.length, 1);
    assert.equal(writer.repo.load(watchId)?.send_intent?.state,"uncertain");
    s[variant] = false;
  }
  assert.deepEqual(s.methods.filter(m => m.includes("queue/add")), ["thread/queue/add", "thread/queue/add"]);
});

test("correlation spans pages, ignores equal human text, and does not settle transient terminal projections", async t => {
  const s = await fixture(t);
  const human = turn("human", [user("human-msg", "human-id")]);
  const incomplete = turn("exact", [user()], {status:"interrupted",completedAt:null});
  s.pages = new Map([["", page([human], "p2")], ["p2", page([incomplete, turn("baseline", [])])]]);
  let result = await readDesktopQueueSubmission(s.target, input);
  assert.equal(result.state, "matched");
  if (result.state === "matched") { assert.equal(result.turn.turnId, "exact"); assert.equal(result.turn.status, "unknown"); }
  s.pages.set("p2", page([turn("exact", [user(), {id:"secret",type:"reasoning",text:"private reasoning"},
    {id:"moderated",type:"agentMessage",text:"private answer",moderation:{moderated:true,display:"hidden"}},
    {id:"final",type:"agentMessage",text:"ready",phase:"final_answer"}]), turn("baseline", [])]));
  result = await readDesktopQueueSubmission(s.target, input);
  assert.equal(result.state, "matched");
  if (result.state === "matched") assert.equal(result.turn.status, "completed");
  assert.doesNotMatch(JSON.stringify(result), /private reasoning|private answer|queue proof|controller-message|userMessage/);
  assert.match(JSON.stringify(result), /ready/);
  s.threadStatus = "idle"; // A different owner has since manually loaded the already-observed exact native thread.
  assert.equal((await readDesktopQueueSubmission(s.target,{...input, expectedCwd:s.home})).state,"matched");
  await assert.rejects(readDesktopQueueSubmission(s.target,{...input, expectedCwd:"/a-different-project"}));
  s.threadStatus = "notLoaded";
  s.replacementHeadAfterCursor = page([turn("interleaved", [user()]), human], "p2");
  assert.deepEqual(await readDesktopQueueSubmission(s.target, input), { state: "uncertain", reason: "desktop_queue_history_changed" });
  assert.ok(s.methods.every(m => !["thread/resume","turn/start","thread/queue/add","thread/queue/start"].includes(m)));
});

test("persisted reads reject an empty continuation and emit only public output and fixed action metadata", async t => {
  const s = await fixture(t);
  s.pages.set("", page([], "unseen"));
  await assert.rejects(readDesktopLatestPersistedTurn(s.target), /Empty Desktop history page/);
  s.pages.set("", page([turn("latest", [user("u", "c", "PRIVATE_DRAFT"),
    { id: "r", type: "reasoning", text: "PRIVATE_REASONING" },
    { id: "a", type: "agentMessage", text: "PRIVATE_PHASE", phase: "analysis" },
    { id: "q", type: "agentMessage", text: "PRIVATE_QUESTION", phase: "commentary", delivery: "async", questions: [{ title: "PRIVATE_Q", options: null }] },
    { id: "answered", type: "requestUserInput", answers: { q: "PRIVATE_ANSWER" } },
    { id: "run", type: "commandExecution", command: "PRIVATE_COMMAND", status: "PRIVATE_STATUS" },
    { id: "f", type: "agentMessage", text: "public reply", phase: "final_answer" }
  ])]));
  const latest = (await readDesktopLatestPersistedTurn(s.target)).latestTurn;
  assert.deepEqual(latest?.items, [{ id: "run", type: "commandExecution" },
    { id: "f", type: "agentMessage", text: "public reply", phase: "final_answer" }]);
  assert.doesNotMatch(JSON.stringify(latest), /PRIVATE/);
  assert.ok(s.methods.every(method => !method.startsWith("thread/queue/")));
});

test("edited, steered, ambiguous or unanchored native history cannot prove the task", async t => {
  const s = await fixture(t), baseline = turn("baseline", []);
  const cases = [
    [turn("a", [user("u", clientId, "edited")]), baseline],
    [turn("a", [user(), user("u2","human")]), baseline],
    [turn("a", [{ id: "prior", type: "agentMessage", text: "preexisting work" }, user()]), baseline],
    [turn("a", [user(), {id:"s",type:"steered"}]), baseline],
    [turn("a", [user()]), turn("b", [user("another")]), baseline],
    [turn("a", [user()])],
    [turn("a", [user()]), turn("a", []), baseline]
  ];
  for (const rows of cases) {
    s.pages.set("", page(rows));
    assert.equal((await readDesktopQueueSubmission(s.target, input)).state, "uncertain");
  }
  s.pages.set("", page([baseline, turn("old", [user()])]));
  assert.equal((await readDesktopQueueSubmission(s.target,input)).state, "pending");
  s.pages = new Map([["",page([turn("a",[user()])],"cycle")],["cycle",page([turn("unrelated",[])],"cycle")]]);
  assert.equal((await readDesktopQueueSubmission(s.target,input)).state, "uncertain");
});
