import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCliCommand } from "../src/cli-core.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { DesktopSessionCatalog } from "../src/desktop-session-catalog.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import { createDesktopResponseStore } from "../src/desktop-response-store.js";
import { createDesktopResponseService } from "../src/desktop-response-service.js";
import { createDesktopTaskService } from "../src/desktop-task-service.js";
import { DESKTOP_CREATION_BUILD, desktopCapabilityProfile } from "../src/desktop-compatibility.js";
import { parseDesktopRequestInteraction } from "../src/desktop-request-interactions.js";
import { VERIFIED_DESKTOP_BUILD } from "../src/desktop-ipc-client.js";
import { buildDesktopAsyncReply, desktopAsyncQuestions } from "../src/desktop-async-interactions.js";
import { createDesktopSessionControls } from "../src/desktop-session-controls.js";
import { formatDesktopCommandResult } from "../src/desktop-command-presentation.js";
import { DesktopIpcError } from "../src/desktop-types.js";
import { DesktopEndpointUnavailable } from "../src/desktop-ipc-transport.js";
import { createDesktopPersistedTurnReader } from "../src/desktop-queue-inspection.js";
import { DesktopQueueAdmissionError } from "../src/desktop-queue-submit.js";
import type { DesktopCompatibility, DesktopSnapshot, DesktopTransportPort, DesktopTurnItem } from "../src/desktop-types.js";
import type { CliCommandDependencies } from "../src/cli-runtime-context.js";

function fixture(t: { after(fn: () => void): void }, compatibility: DesktopCompatibility = VERIFIED_DESKTOP_BUILD,
  catalogCwd?: string, threadId = "desktop-thread") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = { codexHome: path.join(root, ".codex"), hostId: "local", threadId };
  fs.mkdirSync(target.codexHome);
  fs.writeFileSync(path.join(target.codexHome, ".codex-global-state.json"), JSON.stringify({
    "pinned-thread-ids": [target.threadId], "electron-persisted-atom-state": {
      "flat-project-sidebar-preferences-v1": { mode: "project" }, "sidebar-collapsed-sections-v1": { chats: true }
    }
  }));
  const id = createDesktopConversationId(target);
  const storeDir = path.join(root, "store");
  let snapshot: DesktopSnapshot = { threadId: target.threadId, ownerClientId: "exact-owner", revision: 1,
    runtimeStatus: "idle", pendingRequests: [], pendingRequestCount: 0, unconfirmedSubmissionCount: 0,
    tailKnown: true, latestTurnId: null, turns: [], canSend: true };
  let sends = 0, callbacks = 0, launches = 0, closed = 0, answers = 0;
  const approvalDecisions: string[] = [];
  let deferredAnswer: DesktopTurnItem | undefined;
  let deferAnswer = false;
  let readFailure: Error | undefined;
  const transport: DesktopTransportPort = {
    observe: async () => { if (readFailure) throw readFailure; return structuredClone(snapshot); },
    async answerAsync(_identity, input) {
      await input.beforeDispatch?.(snapshot); answers++;
      const question = desktopAsyncQuestions(snapshot).find(item => item.id === input.interactionId)!;
      const item: DesktopTurnItem = { id: "reply-one", type: "steeringUserMessage", status: "accepted",
        targetTurnId: input.expectedTurnId, clientUserMessageId: input.clientUserMessageId,
        input: [{ type: "text", text: buildDesktopAsyncReply(question, input.answer) }] };
      if (deferAnswer) { deferredAnswer = item; throw new DesktopIpcError("timeout", "receipt unavailable", "unknown"); }
      snapshot.turns[0].items.push(item); snapshot.asyncQuestions = desktopAsyncQuestions(snapshot);
      return { turnId: input.expectedTurnId, clientUserMessageId: input.clientUserMessageId, revision: ++snapshot.revision, atomicTurnPrecondition: false };
    },
    async respondRequest(_identity, input) {
      await input.beforeDispatch?.(snapshot);
      const pending = snapshot.pendingInteractions?.find(item => item.id === input.interactionId)!;
      assert.ok(pending.kind !== "async_question");
      if ("answers" in input.response) {
        assert.equal(pending.kind, "blocking_question"); answers++;
        snapshot.turns[0].items.push({ id: "blocking-answer", type: "userInputResponse", requestId: pending.requestId,
          turnId: pending.turnId, completed: true, answers: structuredClone(input.response.answers) });
      } else {
        approvalDecisions.push(input.response.decision);
        const item = snapshot.turns[0].items.find(item => item.id === pending.itemId)!;
        item.status = input.response.decision === "accept" ? "completed" : "declined";
      }
      snapshot.pendingInteractions = []; snapshot.pendingRequests = []; snapshot.pendingRequestCount = 0;
      return { turnId: pending.turnId, interactionId: pending.id, requestId: pending.requestId, revision: ++snapshot.revision, acknowledged: true };
    },
    async start(_identity, input) {
      await input.beforeDispatch?.(snapshot); sends++;
      snapshot = { ...snapshot, runtimeStatus: "active", revision: 2, canSend: false, latestTurnId: "turn-one",
        turns: [{ turnId: "turn-one", status: "inProgress", itemsComplete: true,
          items: [{ id: "user-one", type: "userMessage", clientId: input.clientUserMessageId, content: [{ type: "text", text: input.prompt }] }] }] };
      return { turnId: "turn-one", clientUserMessageId: input.clientUserMessageId, revision: 2, atomicIdlePrecondition: false };
    }
  };
  const repository = createDesktopStateStore(storeDir, { acquire: () => () => {} });
  const catalog = new DesktopSessionCatalog({ codexHomes: [target.codexHome], readMetadata: async () => [{
    source: { codexHome: target.codexHome, database: "/fixture/catalog", kind: "desktop_catalog", status: "ok" },
    ...(catalogCwd ? { hosts: { local: "local" } } : {}),
    rows: [{ thread_id: target.threadId, host_id: "local", display_title: "Desktop test", source_updated_at: 1, cwd: catalogCwd }]
  }] });
  const tasks = createDesktopTaskService({ repository, ...transport, interactionResponsesVerified: desktopCapabilityProfile(compatibility), deliver: () => {
    callbacks++; return { disposition: "accepted", accepted_at: new Date().toISOString(), acceptance_id: "callback-accepted" };
  } });
  const responses = createDesktopResponseService({ tasks: repository,
    repository: createDesktopResponseStore(storeDir, { acquire: () => () => {} }), observe: transport.observe,
    answerAsync: transport.answerAsync!, respondRequest: transport.respondRequest! });
  const controls = createDesktopSessionControls({ observe: transport.observe,
    readModelSettings: async () => ({ model: snapshot.latestModel ?? null, reasoningEffort: snapshot.latestReasoningEffort ?? null }),
    updateSettings: async (_identity, input) => {
      await input.beforeDispatch?.(snapshot);
      snapshot.latestModel = input.settings.model ?? snapshot.latestModel;
      snapshot.latestReasoningEffort = input.settings.effort ?? snapshot.latestReasoningEffort;
      snapshot.latestCollaborationMode = input.settings.collaborationMode ?? snapshot.latestCollaborationMode;
      return { applied: true, snapshot, modelSettings: { model: snapshot.latestModel ?? null, reasoningEffort: snapshot.latestReasoningEffort ?? null } };
    },
    interruptTurn: async (_identity, input) => {
      const turn = snapshot.turns.find(item => item.turnId === input.expectedTurnId)!;
      turn.status = "interrupted"; snapshot.runtimeStatus = "idle"; snapshot.canSend = true;
      return { interruptedTurnId: input.expectedTurnId, snapshot };
    }, sleep: async () => {} });
  const deps: CliCommandDependencies = { cwd: root, env: { HOME: root }, runtimeLog: () => {},
    createDesktopRuntime: () => ({ compatibility, catalog, transport, tasks, responses, controls,
      close: async () => { closed++; } }),
    launchDesktopMonitor: async () => { launches++; return 1234; } };
  const run = async (command: string, options: Record<string, unknown> = {}) => JSON.parse((await executeCliCommand(command,
    { storeDir, ...options }, deps)).stdout);
  return { id, tasks, run, deps, transport, get snapshot() { return snapshot; },
    failReads(error = new Error("private IPC failure")) { readFailure = error; }, get sends() { return sends; }, get callbacks() { return callbacks; },
    get launches() { return launches; }, get closed() { return closed; }, get answers() { return answers; }, approvalDecisions,
    requestApproval(kind: "command" | "file") {
      const method = kind === "command" ? "item/commandExecution/requestApproval" : "item/fileChange/requestApproval";
      snapshot.turns[0].items.push({ id: "approval-item", type: kind === "command" ? "commandExecution" : "fileChange", status: "inProgress" });
      const pending = parseDesktopRequestInteraction({ id: "request-approval", method, params: { threadId: target.threadId,
        turnId: "turn-one", itemId: "approval-item", command: "printf isolated" } }, target.threadId, snapshot.turns)!;
      snapshot.pendingRequests = [{ kind: "approval", method, requestId: "request-approval", turnId: "turn-one" }];
      snapshot.pendingRequestCount = 1; snapshot.pendingInteractions = [pending];
      return pending;
    },
    ask(delayed = false) {
      deferAnswer = delayed;
      snapshot.turns[0].items.push({ id: "question-one", type: "agentMessage", phase: "final_answer", delivery: "async",
        text: "Pick a color", questions: [{ title: "Pick a color", options: ["Green", "Blue"] }] });
      snapshot.asyncQuestions = desktopAsyncQuestions(snapshot);
    },
    askBlocking() {
      const method = "item/tool/requestUserInput", requestId = 27;
      const pending = parseDesktopRequestInteraction({ id: requestId, method, params: { threadId: target.threadId,
        turnId: "turn-one", itemId: "blocking-item", questions: [
          { id: "color", question: "Choose a color", options: [{ label: "Green" }, { label: "Blue" }] },
          { id: "notes", question: "Add a note", options: [], isOther: true }
        ] } }, target.threadId, snapshot.turns)!;
      snapshot.pendingRequests = [{ kind: "user_input", method, requestId, turnId: "turn-one" }];
      snapshot.pendingRequestCount = 1; snapshot.pendingInteractions = [pending];
    },
    revealAnswer() {
      if (deferredAnswer) snapshot.turns[0].items.push(deferredAnswer);
      snapshot.asyncQuestions = desktopAsyncQuestions(snapshot); deferredAnswer = undefined;
    },
    finish() { snapshot.runtimeStatus = "idle"; snapshot.canSend = true;
      snapshot.turns[0]!.status = "completed";
      snapshot.turns[0]!.items.push({ id: "answer", type: "agentMessage", phase: "final_answer", text: "EXACT_DONE" }); } };
}

test("Desktop Status public progress is fresh, exact-turn scoped and never copied into List", async t => {
  const f = fixture(t);
  assert.equal((await f.run("status", { conversation: f.id })).progress.state, "no_public_progress");
  const sent = await f.run("send", { conversation: f.id, message: "READY", messageId: "progress-test", openclawSession: "controller" });
  f.snapshot.turns[0].items.push({ id: "progress", type: "agentMessage", phase: "commentary", text: "桌面任务公开进度", completedAtMs: 1_700_000_000_000 });
  const running = await f.run("status", { conversation: f.id });
  assert.equal(running.progress.text, "桌面任务公开进度");
  assert.equal(running.latest_turn.response_text, "");
  assert.equal(running.progress.native_turn_id, sent.native_turn_id);
  assert.equal(running.progress.latest_item_at, "2023-11-14T22:13:20.000Z");
  assert.ok(Number.isFinite(Date.parse(running.progress.read_at)));
  assert.equal((await f.run("desktop-list")).desktop_sessions[0].progress, undefined);
  f.finish();
  await f.run("watch-status", { watch: sent.watch_id });
  f.snapshot.latestTurnId = "successor";
  f.snapshot.turns.unshift({ turnId: "successor", status: "inProgress", itemsComplete: true,
    items: [{ id: "new-progress", type: "agentMessage", phase: "commentary", text: "新的桌面任务" }] });
  const old = await f.run("status", { watch: sent.watch_id });
  assert.equal(old.progress.text, "桌面任务公开进度");
  assert.equal(old.progress.native_turn_id, sent.native_turn_id);
  assert.equal((await f.run("status", { conversation: f.id })).progress.native_turn_id, "successor");
  f.snapshot.turns.pop();
  assert.equal((await f.run("status", { watch: sent.watch_id })).progress.reason, "missing_exact_turn");
  f.failReads();
  const failed = await f.run("status", { conversation: f.id });
  assert.equal(failed.progress.state, "read_error");
  assert.equal(JSON.stringify(failed).includes("private IPC failure"), false);
  assert.equal((await f.run("status", { watch: sent.watch_id })).progress.state, "read_error");
  assert.equal(f.callbacks, 1);
});

test("Desktop Status may display exact persisted history without authorizing input or claiming current GUI state", async t => {
  const cwd = "/fixture/desktop-target";
  const f = fixture(t, { ...VERIFIED_DESKTOP_BUILD, applicationIdentityVerified: true }, cwd);
  const owner = { ownerId: "writer-a", endpointId: "socket-a" };
  let reads = 0;
  f.transport.readPersistedTurn = createDesktopPersistedTurnReader(async () => owner, async () => {
    reads++;
    return { cwd, latestTurn: { turnId: "disk-turn", status: "completed", itemsComplete: true, items: [
      { id: "0", type: "reasoning", text: "private reasoning" }, { id: "1", type: "agentMessage", phase: "commentary", text: "Public progress" },
      { id: "2", type: "agentMessage", phase: "final_answer", text: "Final answer" },
      { id: "3", type: "agentMessage", phase: "final_answer", delivery: "async", text: "private question" }
    ] } };
  });
  f.failReads(new DesktopEndpointUnavailable("ECONNREFUSED"));
  assert.equal((await f.run("desktop-list")).desktop_sessions[0].persisted_history, undefined);
  assert.equal(reads, 0);
  const status = await f.run("status", { conversation: f.id });
  assert.equal(reads, 1);
  assert.equal(status.connection_state, "unconfirmed");
  assert.equal(status.activity_state, "unknown");
  assert.equal(status.pending_interaction_count, null);
  assert.equal(status.capabilities.send || status.capabilities.watch || status.capabilities.approve, false);
  assert.equal(status.progress.state, "read_error");
  assert.equal(status.persisted_history.scope, "latest_persisted_turn");
  assert.deepEqual(status.persisted_history.latest_turn, { id: "disk-turn", status: "completed", items_complete: true, final_text: "Final answer" });
  assert.equal(status.persisted_history.progress.native_turn_id, "disk-turn");
  assert.equal(status.persisted_history.progress.text, "Public progress");
  assert.doesNotMatch(JSON.stringify(status), /private reasoning|private question|writer-a|socket-a/u);
  assert.equal(f.sends, 0);
});

test("Desktop Status scopes a directed final to the sending controller, exact turn and original Watch", async t => {
  const cwd = "/fixture/requester-project";
  const threadId = "00000000-0000-7000-8000-000000000042";
  const link = `codex://threads/${threadId}`;
  const f = fixture(t, { ...VERIFIED_DESKTOP_BUILD, applicationIdentityVerified: true }, cwd, threadId);
  const sender = { openclawSession: "sender" }, observer = { openclawSession: "observer" };
  const entry = { conversation: f.id };
  const sent = await f.run("send", { ...sender, ...entry, messageId: "request-1", message: "fixture question" });
  const watched = await f.run("watch-terminal", { ...observer, ...entry });
  f.finish();
  const answer = f.snapshot.turns[0].items.at(-1)!;
  answer.answerDisplay = { version: 1, mode: "show", trustedContacts: "check" };
  const owner = await f.run("status", { ...sender, watch: sent.watch_id });
  assert.equal(owner.final_text, "");
  assert.equal(owner.desktop_url, link);
  assert.ok(owner.final_text_notice.includes(link));
  assert.doesNotMatch(JSON.stringify(owner), /EXACT_DONE/);
  assert.equal(owner.trusted_contacts_check_status, "not_performed_by_akk");
  const rendered = formatDesktopCommandResult(owner, "status");
  assert.ok(rendered.includes(link));
  assert.match(rendered, /answer is available/i);
  assert.doesNotMatch(rendered, /EXACT_DONE/);
  for (const params of [{ watch: sent.watch_id }, { ...observer, watch: watched.watch_id }, { ...observer, ...entry }, entry]) {
    assert.doesNotMatch(JSON.stringify(await f.run("status", params)), /EXACT_DONE|codex:\/\/threads\//);
  }
  const live = await f.run("native-inspect", { ...sender, ...entry, inspection: "status" });
  assert.equal(live.latest_turn.final_text, owner.final_text);
  assert.equal(live.latest_turn.desktop_url, link);
  assert.deepEqual(live.latest_turn.final_text_display, owner.final_text_display);
  f.transport.readPersistedTurn = async () => f.snapshot.turns[0];
  f.failReads(new DesktopEndpointUnavailable("ECONNREFUSED"));
  const history = async (context: Record<string, string>) => (await f.run("status", { ...entry, ...context })).persisted_history.latest_turn;
  const persisted = await history(sender);
  assert.equal(persisted.desktop_url, link);
  assert.doesNotMatch(JSON.stringify(persisted), /EXACT_DONE/);
  assert.doesNotMatch(JSON.stringify(await history(observer)), /EXACT_DONE|codex:\/\/threads\//);
  f.snapshot.turns[0].turnId = "different-turn";
  assert.doesNotMatch(JSON.stringify(await history(sender)), /EXACT_DONE|codex:\/\/threads\//);
});

test("Status re-renders a settled historical Watch without rewriting it or repeating its callback", async t => {
  for (const previousText of ["", "previously visible"]) {
    const f = fixture(t);
    const requester = { openclawSession: "original" };
    const receipt = await f.run("send", { ...requester, conversation: f.id, messageId: "historical", message: "fixture question" });
    const watch = { ...requester, watch: receipt.watch_id };
    f.finish();
    const final = f.snapshot.turns[0].items.at(-1)!;
    final.text = previousText;
    await f.run("watch-status", watch);
    const settled = f.tasks.status(watch.watch);
    assert.equal(settled.final_text, previousText);
    assert.equal(f.callbacks, 1);
    f.snapshot.latestTurnId = "successor";
    f.snapshot.turns.push({ turnId: "successor", status: "completed", itemsComplete: true, items: [] });
    final.text = "exact original turn";
    final.answerDisplay = { version: 1, mode: "show", trustedContacts: "check" };
    const refreshed = await f.run("watch-status", watch);
    assert.equal(refreshed.final_text, "");
    assert.ok(refreshed.final_text_notice);
    assert.doesNotMatch(JSON.stringify(refreshed), /exact original turn|previously visible/);
    assert.equal((await f.run("watch-status", { watch: watch.watch })).final_text, "");
    final.answerDisplay = { version: 1, mode: "block", reason: "cyber" };
    const blocked = await f.run("watch-status", watch);
    assert.equal(blocked.final_text, "");
    assert.deepEqual(blocked.final_text_display, [final.answerDisplay]);
    assert.deepEqual(f.tasks.status(watch.watch), settled);
    assert.equal(f.callbacks, 1);
  }
});

test("Desktop Status reports native queue availability and the specific reason when independent append becomes blocked", async t => {
  const cwd = "/fixture/desktop-target";
  const f = fixture(t, { version: "unreviewed", build: "unreviewed", applicationIdentityVerified: true },
    cwd, "00000000-0000-7000-8000-000000000042");
  f.failReads(new DesktopEndpointUnavailable("ECONNREFUSED"));
  let blocked = false;
  f.transport.queue = {
    async prepare() {
      if (blocked) throw new DesktopQueueAdmissionError("desktop_queue_saved_draft");
      return { cwd, ownerId: "writer-a", endpointId: "socket-a", baselineTurnId: "parent",
        notices: ["desktop_queue_parent_running", "desktop_queue_question_pending", "desktop_queue_live_input_unobserved"] };
    },
    async submit() { throw new Error("Status must not dispatch"); },
    async observe() { throw new Error("No queue request has been submitted"); }
  };
  const ready = await f.run("status", { conversation: f.id });
  assert.equal(ready.available_actions.send.input.conversation_id, f.id);
  assert.ok(ready.queue_notices.includes("desktop_queue_parent_running"));
  assert.ok(ready.queue_notices.includes("desktop_queue_question_pending"));
  assert.equal(ready.pending_interaction_count, null);
  assert.equal(ready.available_actions.approve, undefined);
  blocked = true;
  const denied = await f.run("status", { conversation: f.id });
  assert.equal(denied.capabilities.send, false);
  assert.equal(denied.available_actions.send, undefined);
  assert.equal(denied.observation_error, "desktop_queue_saved_draft");
  assert.equal(denied.can_send_reason, "desktop_queue_saved_draft");
  assert.equal(f.sends, 0);
});

test("Desktop persisted Status rejects changed owner, endpoint, cwd, unverified sources and ambiguous legacy errors", async t => {
  const cwd = "/fixture/desktop-target";
  for (const change of ["owner", "socket", "cwd", "identity", "catalog", "legacy_denied", "legacy_timeout", "later_disconnect"]) {
    const f = fixture(t, { ...VERIFIED_DESKTOP_BUILD, applicationIdentityVerified: change !== "identity" }, change === "catalog" ? undefined : cwd);
    let proofs = 0, reads = 0;
    f.transport.readPersistedTurn = createDesktopPersistedTurnReader(async () => {
      proofs++;
      return { ownerId: proofs === 2 && change === "owner" ? "new" : "old", endpointId: proofs === 2 && change === "socket" ? "new" : "old" };
    }, async () => { reads++; return { cwd: change === "cwd" ? "/elsewhere" : cwd, latestTurn: null }; });
    f.failReads(change === "legacy_denied" ? new DesktopIpcError("unsafe_socket", "unsafe") :
      change === "legacy_timeout" ? new DesktopIpcError("timeout", "timeout") :
      change === "later_disconnect" ? Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }) :
      new DesktopEndpointUnavailable("ENOENT"));
    const result = await f.run("status", { conversation: f.id });
    assert.equal(reads, ["owner", "socket", "cwd"].includes(change) ? 1 : 0, change);
    assert.equal(result.persisted_history, undefined, change);
    assert.equal(result.activity_state, "unknown", change);
    assert.equal(result.capabilities.send, false, change);
  }
});

test("Desktop CLI sends once, launches exact Watch, recovers completion and enforces controller ownership", async t => {
  const f = fixture(t);
  const input = { conversation: f.id, message: "Only reply READY", messageId: "stable-cli-message", desktopRequestId: "intent-stable-cli-message", openclawSession: "controller-one" };
  const receipt = await f.run("send", input);
  assert.equal(receipt.agent_acceptance, "proven"); assert.equal(receipt.native_turn_id, "turn-one");
  assert.equal(receipt.callback_expected, true); assert.equal(receipt.monitor_pid, 1234);
  assert.equal(f.sends, 1);
  const same = await f.run("send", { ...input, messageId: "changed-tool-call" });
  assert.equal(same.watch_id, receipt.watch_id); assert.equal(f.sends, 1);
  const explicit = await f.run("watch-terminal", { conversation: f.id, openclawSession: "controller-two" });
  assert.equal(explicit.native_turn_id, "turn-one"); assert.notEqual(explicit.watch_id, receipt.watch_id);
  await assert.rejects(f.run("unwatch-terminal", { watch: explicit.watch_id, openclawSession: "controller-one" }), /different controller/);
  await f.run("unwatch-terminal", { watch: explicit.watch_id, openclawSession: "controller-two" });
  f.finish();
  const recovered = await f.run("reconcile-desktop-watches");
  assert.equal(recovered.callbacks_delivered, 1); assert.equal(f.callbacks, 1);
  const status = await f.run("watch-status", { watch: receipt.watch_id, openclawSession: "controller-one" });
  assert.equal(status.status, "completed"); assert.equal(status.final_text, "EXACT_DONE");
  await f.run("reconcile-desktop-watches"); assert.equal(f.callbacks, 1);
  assert.ok(f.closed >= 7);
});

test("Desktop CLI list/status are read-only, idle Watch refuses, unsupported operations never reach terminals", async t => {
  const f = fixture(t);
  const list = await f.run("desktop-list");
  assert.equal(list.desktop_sessions[0].conversation_id, f.id);
  assert.equal(list.desktop_sessions[0].connection_state, "unconfirmed");
  assert.equal(list.desktop_scan.view, "sidebar");
  assert.equal(list.desktop_sessions[0].can_send_reason, "unsupported_desktop_host");
  const status = await f.run("status", { conversation: f.id });
  assert.equal(status.connection_state, "live_owner_verified"); assert.equal(status.latest_turn, null);
  await assert.rejects(f.run("watch-terminal", { conversation: f.id, openclawSession: "controller-one" }), /no uniquely confirmed active task/);
  for (const command of ["respond", "new-thread", "resume-thread"]) {
    await assert.rejects(f.run(command, { conversation: f.id }), /Desktop supports/);
  }
  await assert.rejects(f.run("send", { conversation: f.id, terminal: "terminal:v2:fake", message: "hello", openclawSession: "controller" }), /exactly one/);
  assert.equal(f.sends, 0); assert.equal(f.launches, 0);
});

test("Desktop CLI keeps a persisted Watch but reports monitor launch failure without promising callbacks", async t => {
  const f = fixture(t);
  f.deps.launchDesktopMonitor = async () => { throw new Error("spawn failed"); };
  const result = await f.run("send", { conversation: f.id, message: "READY", messageId: "stable-failure", openclawSession: "controller" });
  assert.equal(result.agent_acceptance, "proven"); assert.equal(result.callback_expected, false);
  assert.equal(result.monitor_error, "desktop_monitor_launch_failed");
  assert.equal(f.tasks.status(result.watch_id).status, "watching");
});


test("Desktop CLI fresh Watch questions use typed answers and Status reconciles unknown acceptance without resend", async t => {
  for (const compatibility of [VERIFIED_DESKTOP_BUILD, DESKTOP_CREATION_BUILD]) {
    const f = fixture(t, compatibility);
    const sent = await f.run("send", { conversation: f.id, message: "Ask for a color", messageId: "async-task", openclawSession: "controller" });
    f.ask(true);
    const status = await f.run("watch-status", { watch: sent.watch_id, openclawSession: "controller" });
    assert.equal(status.pending_async_count, 1);
    const question = status.interaction_state[0];
    const response = { interaction_id: question.interaction_id, answers: [{ question_id: question.questions[0].question_id,
      response_kind: "single_select", selected_option_ids: [question.questions[0].options[0].option_id] }] };
    const input = { watch: sent.watch_id, openclawSession: "controller", interaction: question.interaction_id,
      responseJson: JSON.stringify(response), expectedInteractionFingerprint: question.interaction_prompt_fingerprint,
      expectedInteractionExpiresAt: "2000-01-01T00:00:00.000Z" };
    await assert.rejects(f.run("respond-interaction", { ...input, expectedInteractionFingerprint: "f".repeat(64) }), /question changed/);
    assert.equal(f.answers, 0);
    const uncertain = await f.run("respond-interaction", input);
    assert.equal(uncertain.state, "uncertain"); assert.equal(f.answers, 1);
    f.revealAnswer();
    const recovered = await f.run("watch-status", { watch: sent.watch_id, openclawSession: "controller" });
    assert.equal(recovered.interaction_state.length, 0);
    assert.equal(recovered.response_state[0].state, "confirmed");
    assert.equal(recovered.response_state[0].evidence, "exact_async_answer_observed");
    assert.equal(f.answers, 1);
    const same = await f.run("respond-interaction", input);
    assert.equal(same.response_id, uncertain.response_id); assert.equal(same.state, "confirmed"); assert.equal(f.answers, 1);
    const conversation = await f.run("status", { conversation: f.id, openclawSession: "controller" });
    assert.equal(conversation.response_state[0].state, "confirmed");
    assert.equal(conversation.latest_turn.response_text.includes("Pick a color"), false);
    await assert.rejects(f.run("respond-interaction", { ...input, openclawSession: "other" }), /different controller/);
  }
});

test("Desktop CLI answers every blocking question through conversation or Watch and confirms one exact response", async t => {
  for (const compatibility of [VERIFIED_DESKTOP_BUILD, DESKTOP_CREATION_BUILD]) for (const useWatch of [false, true]) {
    const f = fixture(t, compatibility);
    const sent = await f.run("send", { conversation: f.id, message: "Ask two questions", messageId: "blocking-task", openclawSession: "controller" });
    f.askBlocking();
    const subject = useWatch ? { watch: sent.watch_id } : { conversation: f.id };
    const statusCommand = useWatch ? "watch-status" : "status";
    const status = await f.run(statusCommand, { ...subject, openclawSession: "controller" });
    assert.equal(status.pending_manual_count, 0); assert.equal(status.capabilities.interaction_respond, true);
    const question = status.interaction_state[0];
    assert.equal(question.kind, "blocking_question"); assert.equal(question.questions.length, 2);
    const response = { interaction_id: question.interaction_id, answers: [
      { question_id: question.questions[0].question_id, response_kind: "single_select", selected_option_ids: [question.questions[0].options[0].option_id] },
      { question_id: question.questions[1].question_id, response_kind: "free_text", text: "Two lines\naccepted" }
    ] };
    const input = { ...subject, openclawSession: "controller", interaction: question.interaction_id,
      responseJson: JSON.stringify(response), expectedInteractionFingerprint: question.interaction_prompt_fingerprint,
      expectedInteractionExpiresAt: question.expires_at };
    const answered = await f.run("respond-interaction", input);
    assert.equal(answered.state, "confirmed"); assert.equal(answered.evidence, "exact_blocking_answer_observed");
    assert.equal(answered.attempts, 1); assert.equal(f.answers, 1);
    const recovered = await f.run(statusCommand, { ...subject, openclawSession: "controller" });
    assert.deepEqual(recovered.interaction_state, []); assert.equal(recovered.response_state[0].state, "confirmed");
    assert.equal((await f.run("respond-interaction", input)).response_id, answered.response_id);
    assert.equal(f.answers, 1); assert.equal(f.sends, 1);
  }
});

test("Desktop CLI exposes honest model settings and cancels only the exact selected native task", async t => {
  const f = fixture(t);
  const native = await f.run("native-inspect", { conversation: f.id, action: "status" });
  assert.equal(native.source, "codex_desktop");
  const models = await f.run("model-options", { conversation: f.id });
  assert.equal(models.catalog_available, false); assert.equal(models.selection_mode, "explicit_model_id");
  assert.equal(models.choices, undefined);
  const changed = await f.run("set-model", { conversation: f.id, model: "explicit-test-model", reasoningEffort: "high", collaborationMode: "plan" });
  assert.equal(changed.outcome, "changed"); assert.equal(changed.effective.collaboration_mode, "plan");
  const sent = await f.run("send", { conversation: f.id, message: "Work", messageId: "cancel-test", openclawSession: "controller" });
  await assert.rejects(f.run("cancel", { conversation: f.id }), /expected native turn/);
  await assert.rejects(f.run("cancel", { conversation: f.id, expectedNativeTurnId: "other-turn" }), /no longer the active/);
  await assert.rejects(f.run("cancel", { watch: sent.watch_id, openclawSession: "wrong-controller" }), /different controller/);
  const interrupted = await f.run("cancel", { watch: sent.watch_id, openclawSession: "controller" });
  assert.equal(interrupted.native_turn_id, "turn-one"); assert.equal(interrupted.state, "interrupted");
  assert.equal(f.tasks.status(sent.watch_id).status, "interrupted");
  const settled = await f.run("cancel", { conversation: f.id, expectedNativeTurnId: "turn-one" });
  assert.equal(settled.outcome, "already_settled");
});

test("Desktop CLI recovery uses only exact persisted Watch IDs and separates Close from Unwatch", async t => {
  const f = fixture(t); const owner = { openclawSession: "controller-recovery" };
  const sent = await f.run("send", { ...owner, conversation: f.id, message: "Recovery task", messageId: "recovery-task" });
  const stopped = await f.run("unwatch-terminal", { ...owner, watch: sent.watch_id });
  assert.equal(stopped.status, "watching"); assert.equal(stopped.management_state, "managed");
  assert.equal(stopped.observation_state, "stopped"); assert.equal(stopped.callback_expected, false);
  const renewed = await f.run("renew", { ...owner, turn: sent.watch_id, minutes: 1 });
  assert.equal(renewed.renewal_count, 1); assert.equal(renewed.observation_state, "watching");
  assert.equal(renewed.native_turn_id, sent.native_turn_id); assert.equal(renewed.monitor_pid, 1234);
  assert.equal((await f.run("status", { ...owner, turn: sent.watch_id })).watch_id, sent.watch_id);
  for (const command of ["close", "renew", "recover", "retry-callback"]) {
    await assert.rejects(f.run(command, { ...owner, conversation: f.id }), /exact.*Watch ID/);
    await assert.rejects(f.run(command, { ...owner, watch: sent.watch_id, turn: sent.watch_id }), /exactly one/);
    await assert.rejects(f.run(command, { ...owner, watch: sent.watch_id, expectedRevision: 1 }), /fences/);
    await assert.rejects(f.run(command, { watch: sent.watch_id, openclawSession: "foreign" }), /owning controller/);
  }
  const closed = await f.run("close", { ...owner, watch: sent.watch_id, reason: "controller finished" });
  assert.equal(closed.status, "closed"); assert.equal(closed.observation_status, "watching");
  assert.equal(closed.management_state, "closed"); assert.equal(closed.close_reason, "controller finished");
  await assert.rejects(f.run("recover", { ...owner, watch: sent.watch_id }), /closed/);
  assert.equal(f.sends, 1);
});


test("Desktop Send/Watch defaults and lower-level timeout aliases preserve their precedence", async t => {
  const variants = [
    { options: {}, expected: 720 },
    { options: { agentHardTimeoutMinutes: 45 }, expected: 45 },
    { options: { hardTimeoutMinutes: 30, agentHardTimeoutMinutes: 45 }, expected: 30 }
  ];
  for (const { options, expected } of variants) {
    const f = fixture(t);
    const sent = await f.run("send", { conversation: f.id, message: "READY", messageId: "timeout-policy", openclawSession: "controller", ...options });
    assert.equal(Date.parse(sent.deadline_at) - Date.parse(sent.created_at), expected * 60_000);
    const watched = await f.run("watch-terminal", { conversation: f.id, openclawSession: "observer", ...options });
    assert.equal(Date.parse(watched.deadline_at) - Date.parse(watched.created_at), expected * 60_000);
  }
});


test("Desktop CLI unknown and partially verified builds attempt native controls and expose their evidence separately", async t => {
  for (const compatibility of [DESKTOP_CREATION_BUILD, { version: "future", build: "unverified" }]) {
    const f = fixture(t, compatibility);
    const ready = await f.run("status", { conversation: f.id });
    assert.equal(ready.capabilities.send, true); assert.equal(ready.capabilities.set_model, true);
    assert.equal(ready.capability_verification.nativeControls, false); assert.equal(ready.compatibility_warning, true);
    assert.equal((await f.run("model-options", { conversation: f.id })).catalog_available, false);
    assert.ok(await f.run("permission-options", { conversation: f.id }));
    assert.equal((await f.run("set-model", { conversation: f.id, model: "test-model", reasoningEffort: "high" })).outcome, "changed");
    const sent = await f.run("send", { conversation: f.id, message: "READY", messageId: "attempt-native", openclawSession: "controller" });
    assert.equal(sent.delivered, true); assert.equal(f.sends, 1); assert.equal(sent.capabilities.cancel, true);
    f.ask();
    const status = await f.run("watch-status", { watch: sent.watch_id });
    assert.equal(status.pending_interaction_count, 1); assert.equal(status.capabilities.interaction_respond, true);
    assert.equal(status.pending_manual_count, 0);
    assert.equal(status.interaction_state[0].response_contract_verified, desktopCapabilityProfile(compatibility).asyncAnswers);
    assert.equal(status.interaction_state[0].questions[0].title, "Pick a color");
    assert.equal(f.answers, 0);
    assert.equal((await f.run("cancel", { watch: sent.watch_id, openclawSession: "controller" })).state, "interrupted");
  }
});

test("Desktop CLI command/file approvals confirm exact effects and replay their receipt without redispatch", async t => {
  for (const kind of ["command", "file"] as const) for (const decision of ["approve_once", "reject"] as const) {
    const f = fixture(t, DESKTOP_CREATION_BUILD);
    const sent = await f.run("send", { conversation: f.id, message: "Isolated approval", messageId: "approval-task", openclawSession: "controller" });
    const interaction = f.requestApproval(kind);
    const current = await f.run("status", { conversation: f.id });
    const watched = await f.run("watch-status", { watch: sent.watch_id });
    assert.equal(current.capabilities.approve, true); assert.equal(watched.capabilities.approve, true);
    assert.equal(watched.pending_manual_count, 0);
    const selection = kind === "command" ? { conversation: f.id } : { watch: sent.watch_id };
    const input = { ...selection, interaction: interaction.id, decision, openclawSession: "controller" };
    const approved = await f.run("approve", input);
    assert.equal(approved.state, "confirmed"); assert.equal(approved.evidence, "exact_approval_item_advanced");
    assert.equal(approved.native_turn_id, sent.native_turn_id);
    assert.equal((await f.run("approve", input)).response_id, approved.response_id);
    assert.deepEqual(f.approvalDecisions, [decision === "approve_once" ? "accept" : "decline"]);
    await assert.rejects(f.run("approve", { ...input, openclawSession: "different-controller" }), /different controller/);
    assert.equal(f.approvalDecisions.length, 1);
  }
});
