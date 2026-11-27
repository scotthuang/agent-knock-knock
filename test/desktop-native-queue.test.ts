import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { createTerminalWatchOpenClawCallbackRoute } from "../src/callback-transport.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { DesktopEndpointUnavailable } from "../src/desktop-ipc-transport.js";
import { readDesktopLatestPersistedTurn, readDesktopQueueSubmission } from "../src/desktop-native-queue.js";
import { desktopTaskProjection } from "../src/desktop-public-projection.js";
import { createDesktopTaskService, type DesktopTaskServiceDependencies } from "../src/desktop-task-service.js";
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
    queuePages: new Map<string, ReturnType<typeof page>>(),
    replacementHeadAfterCursor: undefined as ReturnType<typeof page> | undefined,
    threadStatus: "notLoaded", rejectReceipt: false, loseAck: false, queued: [] as unknown[], methods: [] as string[],
    queueListError: 0, queueAddError: undefined as { code: number; message: string } | undefined,
    directInput: undefined as boolean | undefined, serverVersion: "0.171.0",
    home, socketAlias: alias, socketLocal: local, target: { codexHome: home, threadId, hostId: "local" }
  };
  sockets.on("connection", ws => ws.on("message", bytes => {
    const { id, method, params } = JSON.parse(bytes.toString());
    state.methods.push(method);
    if (!id) return;
    let result: unknown;
    if (method === "initialize") result = { userAgent: "codex/" + state.serverVersion, codexHome: home, platformFamily: "unix", platformOs: "macos" };
    else if (method === "thread/read") result = { thread: { id: threadId, sessionId: threadId, cliVersion: "0.171.0", originator: "codex_work_desktop",
      source: "vscode", ephemeral: false, threadSource: "user", cwd: home, historyMode: "paginated", status: {type: state.threadStatus},
      canAcceptDirectInput: state.directInput, turns: [] } };
    else if (method === "thread/turns/list") {
      result = state.pages.get(params.cursor ?? "");
      if (params.cursor && state.replacementHeadAfterCursor) state.pages.set("", state.replacementHeadAfterCursor);
    }
    else if (method === "thread/queue/list") {
      if (state.queueListError) { ws.send(JSON.stringify({id, error: {code: state.queueListError, message:"list unavailable"}})); return; }
      result = state.queuePages.get(params.cursor ?? "") ?? page(state.queued.slice(0, params.limit), state.queued.length > params.limit ? "more" : null);
    }
    else if (method === "thread/queue/add") {
      assert.equal(params.threadId, threadId);
      if (state.queueAddError) { ws.send(JSON.stringify({id, error: state.queueAddError})); return; }
      state.queued.push({ id: "queue-id", clientUserMessageId: params.clientUserMessageId, input: params.input });
      if (state.loseAck) { ws.terminate(); return; }
      result = { queuedSubmission: state.rejectReceipt ? { id: "wrong", clientUserMessageId: "other", input: [] } : state.queued.at(-1) };
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
  assert.ok((await prepare()).notices?.includes("desktop_queue_appends_behind_existing"));
  await assert.rejects(submit(await prepare()), (err: unknown) => err instanceof DesktopIpcError && err.dispatchState === "unknown");
  s.queued.length=0; // Consumption still does not make the same reservation dispatchable.
  await assert.rejects(submit(await prepare()), (err: unknown) => err instanceof DesktopIpcError && err.dispatchState === "unknown");
  assert.equal(s.methods.filter(m => m === "thread/queue/add").length,1);
});

test("malformed or lost acknowledgements preserve single native dispatch", async t => {
  const s = await fixture(t), writer = await fixtureWriter(s.target);
  const prepare = () => writer.prepareDesktopQueue(s.target, s.home);
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

test("independent append leaves a pending question unanswered during an active turn or transient interruption", async t => {
  const s = await fixture(t), writer = await fixtureWriter(s.target);
  const prepare = () => writer.prepareDesktopQueue(s.target, s.home);
  const notice = "desktop_queue_question_pending";
  const question = { id: "q", type: "agentMessage", text: "fixture", delivery: "async", questions: [{ title: "q", options: null }] };
  const child = { id: "child-start", type: "subAgentActivity", kind: "started" };
  const answer = user("answer", "human", '<send_user_message_question_reply>{"questionItemId":"q","answer":"ok"}</send_user_message_question_reply>');
  for (const status of ["inProgress", "interrupted"]) {
    const active = { status, completedAt: null };
    s.pages.set("", page([turn("baseline", [user(), child], active)]));
    const admission = await prepare();
    assert.ok(!admission.notices?.includes(notice)); // A sub-agent entry alone is no evidence of a question.
    const watchId = "desktop-watch:pending-question-" + status;
    const requestClientId = clientId + "-" + status;
    writer.reserve(watchId, admission, requestClientId, prompt);

    const pendingPage = page([turn("baseline", [user(), child, question], active)]);
    s.pages.set("", pendingPage);
    assert.ok((await prepare()).notices?.includes(notice));
    const before = s.methods.length;
    await writer.submitDesktopQueueOnce({ target: s.target, admission, storeDir: writer.storeDir,
      watchId, clientUserMessageId: requestClientId, prompt });
    const reads = new Set(["initialize", "initialized", "thread/read", "thread/turns/list", "thread/queue/list"]);
    assert.deepEqual(s.methods.slice(before).filter(method => !reads.has(method)), ["thread/queue/add"]);
    assert.deepEqual(s.queued.at(-1), {id: "queue-id", clientUserMessageId: requestClientId,
      input: [{type:"text", text: prompt, text_elements: []}]});
    assert.ok((await prepare()).notices?.includes(notice)); // The user's question still needs their answer.

    s.pages.set("", page([turn("baseline", [user(), child, question, answer], active)]));
    assert.ok(!(await prepare()).notices?.includes(notice));
  }
  for (const status of ["completed", "failed", "interrupted"]) {
    s.pages.set("", page([turn("baseline", [user(), child, question], { status, completedAt:100 })]));
    assert.ok(!(await prepare()).notices?.includes(notice));
  }
  for (const [itemsView, overlay] of [["full", {moderation:{moderated:false,display:"desktop"}}], ["summary", {}]] as const) {
    s.pages.set("", page([turn("baseline", [{...question, ...overlay}], {status:"inProgress", completedAt:null, itemsView})]));
    assert.ok((await prepare()).notices?.includes(notice));
  }
});

test("ordinary Send appends behind human input across active work, approval and unfamiliar history", async t => {
  const s = await fixture(t), writer = await fixtureWriter(s.target);
  const approval = {id:"command",type:"commandExecution",status:"inProgress"};
  const children = [{id:"child",type:"subAgentActivity",kind:"started"}, {id:"future",type:"futureActivity",status:"unknown"}];
  const other = {id:"human-queued",clientUserMessageId:"human",input:[{type:"text",text:"first"}]};
  s.serverVersion = "0.999.0";
  s.pages.set("", page([turn("baseline", children)]));
  writer.setOwner({draft:"unknown"});
  assert.ok((await writer.prepareDesktopQueue(s.target,s.home)).notices?.includes("desktop_queue_draft_unknown"));
  s.queued.push(other);
  s.pages.set("", page([turn("baseline", [approval, ...children], {status:"inProgress",completedAt:null})]));
  const a = await writer.prepareDesktopQueue(s.target,s.home);
  assert.ok(a.notices?.includes("desktop_queue_parent_running"));
  assert.ok(a.notices?.includes("desktop_queue_appends_behind_existing"));
  const watchId = "desktop-watch:queue-tail";
  writer.reserve(watchId,a,clientId,prompt);
  s.queueListError = -32603; // read depth became unavailable on the same attested endpoint.
  assert.ok((await writer.prepareDesktopQueue(s.target,s.home)).notices?.includes("desktop_queue_depth_unknown"));
  await writer.submitDesktopQueueOnce({target:s.target,admission:a,storeDir:writer.storeDir,watchId,clientUserMessageId:clientId,prompt});
  assert.deepEqual(s.queued,[other,{id:"queue-id",clientUserMessageId:clientId,input:[{type:"text",text:prompt,text_elements:[]}]}]);
  assert.equal(s.methods.filter(method => method === "thread/queue/add").length,1);
  assert.ok(!s.methods.some(method => ["thread/queue/start","thread/queue/delete","thread/queue/update","thread/queue/reorder","turn/steer"].includes(method)));
});

test("known draft, editor, direct input denial, unavailable queue or changed anchor cannot dispatch", async t => {
  const s = await fixture(t), writer = await fixtureWriter(s.target);
  const prepare = () => writer.prepareDesktopQueue(s.target,s.home);
  for (const [draft,reason] of [["present","desktop_queue_saved_draft"],["retained_editor","desktop_queue_retained_editor"]]) {
    writer.setOwner({draft}); await assert.rejects(prepare(),{reason,dispatchState:"not_sent"});
  }
  writer.setOwner();
  s.directInput=false; await assert.rejects(prepare(),{reason:"desktop_queue_write_denied"}); s.directInput=true;
  s.queued.push({ id: "missing-client-id", input: [] });
  await assert.rejects(prepare(), {reason:"desktop_queue_contract_unavailable"});
  s.queued.length = 0;
  s.queueListError=-32601; await assert.rejects(prepare(),{reason:"desktop_queue_contract_unavailable"});
  s.queueListError=0;
  const a=await prepare(), watchId="desktop-watch:queue-anchor";
  writer.reserve(watchId,a,clientId,prompt);
  s.pages.set("",page([turn("different",[])]));
  await assert.rejects(writer.submitDesktopQueueOnce({target:s.target,admission:a,storeDir:writer.storeDir,watchId,clientUserMessageId:clientId,prompt}),{code:"owner_changed"});
  s.pages.set("",page([])); await assert.rejects(prepare(),{reason:"desktop_queue_baseline_unavailable"});
  assert.equal(s.methods.includes("thread/queue/add"),false);
  assert.equal(writer.repo.load(watchId)?.send_intent?.state,"reserved");
});

test("queue capacity and permission rejections are distinguished from unknown dispatch errors", async t => {
  const s = await fixture(t), writer = await fixtureWriter(s.target);
  for (const [message,code,expected,state] of [
    ["queue cannot contain more than 100 submissions",-32600,"desktop_queue_full","not_sent"],
    ["direct app-server input is not allowed for unloaded spawned sub-agents",-32600,"desktop_queue_write_denied","not_sent"],
    ["queue cannot contain more than 100 submissions",-32603,"rpc_error","unknown"],
    ["ambiguous rejected response",-32600,"rpc_error","unknown"],
  ] as const) {
    const watchId="desktop-watch:queue-error-"+s.methods.length;
    const a=await writer.prepareDesktopQueue(s.target,s.home);
    writer.reserve(watchId,a,clientId,prompt);
    s.queueAddError={code,message};
    await assert.rejects(writer.submitDesktopQueueOnce({target:s.target,admission:a,storeDir:writer.storeDir,watchId,clientUserMessageId:clientId,prompt}),
      {code:expected,dispatchState:state});
  }
  assert.equal(s.methods.filter(method=>method==="thread/queue/add").length,4);
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
    {id:"shown",type:"agentMessage",phase:"final_answer",text:"for requester",moderation:{
      moderated:true,display:{version:1,mode:"show",trustedContacts:"check"}}},
    {id:"hidden",type:"agentMessage",phase:"final_answer",text:"private answer",moderation:{
      moderated:true,display:{version:1,mode:"hide",replacement:{kind:"wellbeingPromptHelpline"}}}},
    {id:"final",type:"agentMessage",text:"ready",phase:"final_answer"}]), turn("baseline", [])]));
  result = await readDesktopQueueSubmission(s.target, input);
  assert.equal(result.state, "matched");
  if (result.state === "matched") {
    assert.equal(result.turn.status, "completed");
    const shown = result.turn.items.find(item => item.id === "shown");
    assert.equal(shown?.text, "for requester");
    assert.equal(shown?.answerDisplay?.mode === "show" && shown.answerDisplay.trustedContacts, "check");
    assert.equal(result.turn.items.find(item => item.id === "hidden")?.answerDisplay?.mode, "hide");
  }
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

test("only turns after the Send baseline need full content for exact task attribution", async t => {
  const s = await fixture(t);
  const anchor = { id: "baseline", status: "future_state", itemsView: "notLoaded" };
  s.pages.set("", page([turn("original-turn", [user()]), anchor, { id: "older", itemsView: "summary" }]));
  const result = await readDesktopQueueSubmission(s.target, input);
  assert.equal(result.state, "matched");
  if (result.state === "matched") assert.equal(result.turn.turnId, "original-turn");
  s.pages.set("", page([{id:"newer",itemsView:"summary"}, turn("original-turn", [user()]), anchor]));
  await assert.rejects(readDesktopQueueSubmission(s.target, input));
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
  assert.deepEqual(await readDesktopQueueSubmission(s.target,input), { state: "uncertain", reason: "desktop_queue_ack_unconfirmed" });
  s.pages = new Map([["",page([turn("a",[user()])],"cycle")],["cycle",page([turn("unrelated",[])],"cycle")]]);
  assert.equal((await readDesktopQueueSubmission(s.target,input)).state, "uncertain");
});

test("queue position changes, edits or disappearance never attest execution; only the original message in its own later turn can settle", async t => {
  const s = await fixture(t), witness = { ...input, acknowledgedQueueId: "ack-id" };
  const row = (id: string, clientUserMessageId: string, text: string) => ({
    id, clientUserMessageId, input: [{ type: "text", text, text_elements: [] }]
  });
  const ours = row("ack-id", clientId, prompt), human = row("human", "human-client", prompt);
  const observe = () => readDesktopQueueSubmission(s.target, witness);
  s.queuePages.set("", page([human], "p2"));
  s.queuePages.set("p2", page([ours]));
  const waiting = { state: "pending", reason: "desktop_queue_entry_waiting" };
  assert.deepEqual(await observe(), waiting);
  s.queuePages.set("", page([ours, human]));
  assert.deepEqual(await observe(), waiting);
  assert.deepEqual(await readDesktopQueueSubmission(s.target, input), { state: "pending", reason: "desktop_queue_entry_unconfirmed_ack" });
  for (const changed of [row("ack-id", clientId, "PRIVATE EDIT"), row("ack-id", "other-client", prompt), row("other-id", clientId, prompt)]) {
    s.queuePages.set("", page([human, changed]));
    assert.deepEqual(await observe(), { state: "uncertain", reason: "desktop_queue_entry_conflict" });
  }
  s.queuePages.set("", page([human], "p2")); s.queuePages.set("p2", page([human], "p2"));
  assert.deepEqual(await observe(), { state: "uncertain", reason: "desktop_queue_inventory_incomplete" });
  s.queuePages.set("", page([human]));
  assert.deepEqual(await observe(), { state: "uncertain", reason: "desktop_queue_entry_not_observed" });
  s.pages.set("", page([turn("human-turn", [user("m", "human-client")]), turn("original-turn", [user()]), turn("baseline", [])]));
  const observed = await observe();
  assert.equal(observed.state, "matched");
  if (observed.state === "matched") assert.equal(observed.turn.turnId, "original-turn");
  assert.ok(s.methods.every(method => !method.startsWith("thread/queue/") || method === "thread/queue/list"));
});

test("an ordinary observer covers the native queue capacity without binding early or confusing similar human turns", async t => {
  const s = await fixture(t);
  const rows = Array.from({length: 100}, (_, i) =>
    turn("turn-" + i, [user("msg-" + i, i === 0 ? clientId : "human-" + i)]));
  rows.push(turn("baseline", []));
  function paginate(data: unknown[]) {
    for (let i = 0; i < data.length; i += 8) s.pages.set(i ? String(i) : "", page(data.slice(i,i+8), i+8 < data.length ? String(i+8) : null));
  }
  paginate(rows);
  const matched = await readDesktopQueueSubmission(s.target, input);
  assert.equal(matched.state === "matched" && matched.turn.turnId, "turn-0");
  rows[95] = turn("other", [user("duplicate", clientId)]);
  paginate(rows);
  assert.deepEqual(await readDesktopQueueSubmission(s.target, input), {state:"uncertain", reason:"desktop_queue_submission_conflict"});
  const outsideDeepWindow = Array.from({length:1024}, (_, i) => turn("deep-" + i, [user("m",i ? "other" : clientId)]));
  paginate([...outsideDeepWindow,turn("baseline",[])]);
  const calls = s.methods.length;
  assert.deepEqual(await readDesktopQueueSubmission(s.target,{...input,historyScan:"recover"}),
    {state:"uncertain",reason:"desktop_queue_recovery_scan_limit"});
  assert.equal(s.methods.slice(calls).filter(method => method === "thread/turns/list").length,128);
});

test("Recover on the original Watch can verify a long queue interval, rejects a deep duplicate, then follows only its proven turn", async t => {
  const s = await fixture(t), writer = await fixtureWriter(s.target);
  const deps: DesktopTaskServiceDependencies = {
    repository: writer.repo,
    observe: async () => { throw new DesktopEndpointUnavailable("ECONNREFUSED"); },
    start: async () => assert.fail("queue observation must not start a turn"),
    queue: {
      prepare: target => writer.prepareDesktopQueue(target, s.home),
      submit: (target, admission, claim) => writer.submitDesktopQueueOnce({target, admission, ...claim, storeDir:writer.storeDir}),
      observe: readDesktopQueueSubmission
    }
  };
  const controllerSession = "isolated-controller";
  const sent = await createDesktopTaskService(deps).send({target:s.target, desktopId:createDesktopConversationId(s.target),
    controllerSession, messageId:"deep-original", requestId:"long-queue-recovery-request", text:prompt});
  const ownId = sent.send_intent!.client_user_message_id;
  const rows = Array.from({length: 132}, (_, i) => turn("turn-" + i, [user("m-" + i,"human-" + i)]));
  rows[0] = turn("mine", [user("m",ownId)], {status:"inProgress",completedAt:null});
  rows.push(turn("baseline", []));
  function paginate() {
    for (let i = 0; i < rows.length; i += 8) s.pages.set(i ? String(i) : "", page(rows.slice(i,i+8), i+8 < rows.length ? String(i+8) : null));
  }
  paginate();
  const service = createDesktopTaskService(deps);
  const incomplete = await service.reconcile(sent.id);
  assert.equal(incomplete.observation_error, "desktop_queue_history_requires_recover");
  assert.equal(incomplete.native_turn_id, undefined);
  rows[125] = turn("conflicting", [user("duplicate",ownId)]);
  paginate();
  const conflict = await service.recover(sent.id, {controllerSession});
  assert.equal(conflict.observation_error, "desktop_queue_submission_conflict");
  assert.equal(conflict.native_turn_id, undefined);
  rows[125] = turn("human", []);
  paginate();
  assert.equal((await service.recover(sent.id,{controllerSession})).native_turn_id, "mine");

  // A different identity cannot replace the already bound turn, even though
  // it carries an apparently identical message after the original queue event.
  rows[0] = turn("imposter",[user("imposter",ownId)]);
  rows[1] = turn("mine", [user("m", "different-client")]);
  paginate();
  const changed = await service.reconcile(sent.id);
  assert.equal(changed.observation_error, "desktop_queue_bound_turn_conflict");
  assert.equal(changed.native_turn_id, "mine");
  rows[0] = turn("new-human", []);
  rows[1] = turn("mine", [user("m",ownId)]);
  paginate();
  const reads = s.methods.length;
  assert.equal((await service.reconcile(sent.id)).status,"completed");
  assert.equal(s.methods.slice(reads).filter(method => method === "thread/turns/list").length,1);
  assert.equal(s.methods.filter(method => method === "thread/queue/add").length,1);
});

test("ordinary Desktop Send appends behind a human and settles its own Watch once through the native wire, Store and callback outbox", async t => {
  const s = await fixture(t), writer = await fixtureWriter(s.target);
  const baseline = turn("baseline", [user("u", "older"), { id: "child", type: "subAgentActivity", kind: "started" }]);
  s.pages.set("", page([baseline]));
  const human = { id: "human-entry", clientUserMessageId: "human", input: [{ type: "text", text: prompt, text_elements: [] }] };
  s.queued.push(human);
  const delivered: string[] = [];
  const deps: DesktopTaskServiceDependencies = {
    repository: writer.repo,
    observe: async () => { throw new DesktopEndpointUnavailable("ECONNREFUSED"); },
    start: async () => assert.fail("The fallback must not start a turn"),
    queue: {
      prepare: target => writer.prepareDesktopQueue(target, s.home),
      submit: (target, admission, claim) => writer.submitDesktopQueueOnce({ target, admission, ...claim, storeDir: writer.storeDir }),
      observe: readDesktopQueueSubmission
    },
    deliver: async ({ envelope }) => {
      delivered.push(envelope.event.id);
      return { disposition: "accepted", accepted_at: new Date().toISOString(), acceptance_id: "isolated-controller-receipt" };
    }
  };
  const request = { target: s.target, desktopId: createDesktopConversationId(s.target), controllerSession: "isolated-controller",
    callbackRoute: createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: "isolated-controller" }),
    messageId: "first-outer-invocation", requestId: "one-original-request", text: prompt };
  const service = createDesktopTaskService(deps);
  const task = await service.send(request), queued = desktopTaskProjection(task);
  assert.equal(queued.delivery_receipt, "native_queue_accepted");
  assert.equal(queued.native_turn_id, null); assert.equal(queued.delivered, false);
  assert.deepEqual(s.queued, [human, { id: "queue-id", clientUserMessageId: task.send_intent!.client_user_message_id, input: human.input }]);
  assert.equal(delivered.length, 0);
  const ownClient = (s.queued[1] as { clientUserMessageId: string }).clientUserMessageId;
  s.queued.shift();
  const otherTurn = turn("human-turn", [user("human-user", "human", prompt)]);
  s.pages.set("", page([otherTurn, baseline]));
  const resumed = createDesktopTaskService(deps);
  assert.equal((await resumed.reconcile(task.id)).native_turn_id, undefined);
  assert.equal(delivered.length, 0);
  s.queued.pop();
  s.pages.set("", page([turn("actual-turn", [user("own-user", ownClient), { id: "f", type: "agentMessage",
    phase: "final_answer", text: "fixture finished" }]), otherTurn, baseline]));
  const done = desktopTaskProjection(await resumed.reconcile(task.id));
  assert.equal(done.status, "completed"); assert.equal(done.native_turn_id, "actual-turn"); assert.equal(done.final_text, "fixture finished");
  assert.equal(done.watch_id, task.id); assert.equal(done.callback_state, "accepted"); assert.equal(done.channel_delivery_state, "unknown");
  await service.reconcile(task.id);
  assert.equal((await resumed.send(request)).id, task.id);
  assert.deepEqual(delivered, [`${task.id}:settled`]);
  assert.equal(s.methods.filter(m => m === "thread/queue/add").length, 1);
});
