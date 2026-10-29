import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCliCommand } from "../src/cli-core.js";
import { createCodexNativeRuntime, type CodexNativeClientPort } from "../src/codex-native-runtime.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { CodexNativeError, type CodexNativeSnapshot, type CodexNativePermissions } from "../src/codex-native-types.js";
import type { CliCommandDependencies } from "../src/cli-runtime-context.js";
import { isSubmissionError, toolResult, withTurnIdentity } from "../src/semantic-tool-presentation.js";
import { presentConversationList } from "../src/conversation-list-presentation.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-native-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = { codexHome: path.join(root, ".codex"), threadId: "native-thread-one" };
  const id = createCodexNativeConversationId(target);
  const snapshot: CodexNativeSnapshot = { threadId: target.threadId, thread: { id: target.threadId, sessionId: target.threadId,
    cwd: root, cliVersion: "0.162.0", originator: "codex-tui", source: "cli", historyMode: "paginated", status: { type: "idle" }, turns: [] },
    loaded: true, latestTurnId: null, turns: [], pendingInteractions: [], canSend: true };
  let settings: CodexNativePermissions = { preset: "read-only", profileId: ":read-only", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" } };
  let sends = 0, callbacks = 0, launches = 0, updates = 0;
  let readFailure = false; let successfulReadsBeforeFailure = 0;
  const client: CodexNativeClientPort = {
    metadata: { serverVersion: "0.162.0", codexHome: target.codexHome, socketPath: "/fixture", platformFamily: "unix", platformOs: "macos" },
    async discover() { return [snapshot.thread]; }, async readSnapshot() { if (readFailure && successfulReadsBeforeFailure-- <= 0) throw new Error("private backend failure"); return structuredClone(snapshot); }, async subscribe() {}, close() {},
    async start(_thread, input) {
      await input.beforeDispatch?.(structuredClone(snapshot)); sends++;
      snapshot.historyMaterialized = true;
      snapshot.thread.status = { type: "active", activeFlags: [] }; snapshot.canSend = false; snapshot.latestTurnId = `native-turn-${sends}`;
      snapshot.turns = [{ id: snapshot.latestTurnId, status: "inProgress", itemsComplete: true,
        items: [{ id: "user-one", type: "userMessage", clientId: input.clientUserMessageId, content: [{ type: "text", text: input.text }] }] }];
      return { turnId: snapshot.latestTurnId, clientUserMessageId: input.clientUserMessageId };
    },
    async respond() { throw new Error("unused"); }, async answerAsync() { throw new Error("unused"); },
    async readPermissions() { return settings; },
    async updatePermissions(_thread, preset) { updates++; settings = { ...settings, preset }; return settings; }
  };
  const deps: CliCommandDependencies = { cwd: root, env: { HOME: root }, runtimeLog() {},
    conversationRoutingTerminals: async () => [],
    createCodexNativeRuntime: options => createCodexNativeRuntime({ ...options, clientFactory: async () => client,
      callbackDeliver: async () => { callbacks++; return { disposition: "accepted", accepted_at: new Date().toISOString(), acceptance_id: "fixture" }; } }),
    launchCodexNativeMonitor: async () => { launches++; return 12345; }
  };
  const run = async (command: string, options: Record<string, unknown> = {}) => JSON.parse((await executeCliCommand(command,
    { storeDir: path.join(root, "store"), ...options }, deps)).stdout);
  return { run, id, target, snapshot, client, deps, failReads(after = 0) { readFailure = true; successfulReadsBeforeFailure = after; }, get sends() { return sends; }, get callbacks() { return callbacks; },
    get launches() { return launches; }, get updates() { return updates; },
    finish() { snapshot.thread.status = { type: "idle" }; snapshot.canSend = true; snapshot.turns[0]!.status = "completed";
      snapshot.turns[0]!.items.push({ id: "final", type: "agentMessage", phase: "final_answer", text: "NATIVE_EXACT_DONE" }); }
  };
}

test("native List discovery reads no task snapshots and Status retains fresh detailed reads", async t => {
  const f = fixture(t);
  f.failReads();
  for (const state of ["idle", "active"] as const) {
    f.snapshot.thread.status = state === "idle" ? { type: state } : { type: state, activeFlags: ["waitingOnApproval"] };
    const result = await f.run("codex-cli-list");
    assert.equal(result.codex_cli_scan.complete, true, "broken task-history reads do not erase discovered loaded sessions");
    const row = result.codex_cli_sessions[0];
    assert.equal(row.activity_state, state);
    assert.equal(row.capabilities.send, state === "idle");
    assert.equal(row.capabilities.watch, state === "active");
    assert.equal(row.detail_scan, "deferred");
    assert.equal(row.interaction_requests_scanned, false);
    assert.equal(row.pending_interaction_count, null);
    assert.equal(row.native_turn_id, undefined, "a thread activity flag is not an exact task anchor");
    assert.equal(row.latest_turn, undefined);
    assert.equal(row.interaction_state, undefined);
  }
  const detailed = await f.run("codex-cli-list", { approvalScan: true });
  assert.equal(detailed.codex_cli_scan.complete, false, "explicit detailed scan still reads current history");
  await assert.rejects(f.run("status", { conversation: f.id }), /private backend failure/u,
    "Status routing still demands a fresh snapshot rather than reusing List's summary");
  assert.equal(f.sends, 0);
});

test("default native List retains exact empty-candidate folding only for ambiguous project groups", async t => {
  const f = fixture(t); f.snapshot.historyMaterialized = false;
  const existing: CodexNativeSnapshot = structuredClone(f.snapshot);
  existing.threadId = existing.thread.id = existing.thread.sessionId = "existing-peer";
  existing.thread.name = "Existing task"; existing.historyMaterialized = true;
  existing.latestTurnId = "existing-turn";
  existing.turns = [{ id: "existing-turn", status: "completed", itemsComplete: true,
    items: [{ id: "private-item", type: "agentMessage", text: "DO_NOT_RETURN_HISTORY_BODY" }] }];
  const unrelated = { ...existing.thread, id: "unrelated", sessionId: "unrelated", cwd: path.join(existing.thread.cwd, "other") };
  const reads: string[] = []; let subscriptions = 0;
  f.client.discover = async () => [f.snapshot.thread, existing.thread, unrelated];
  f.client.readSnapshot = async id => {
    reads.push(id);
    assert.notEqual(id, unrelated.id, "ordinary single-thread groups do not read history");
    return structuredClone(id === f.target.threadId ? f.snapshot : existing);
  };
  f.client.subscribe = async () => { subscriptions++; throw new Error("List must not subscribe"); };
  const result = await f.run("codex-cli-list");
  assert.equal(result.codex_cli_scan.complete, true);
  assert.deepEqual(reads, [f.target.threadId, existing.threadId]);
  assert.equal(subscriptions, 0);
  const rows = result.codex_cli_sessions;
  assert.equal(rows[0].unstarted_thread, true);
  assert.equal(rows[0].history_state, "unmaterialized");
  assert.equal(rows[0].native_turn_id, null);
  assert.equal(rows[0].latest_turn, null);
  assert.deepEqual(rows[1].latest_turn, { id: "existing-turn", status: "completed" });
  assert.equal(rows[2].native_turn_id, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /DO_NOT_RETURN_HISTORY_BODY|private-item|response_text|final_text/u);
  const presented = presentConversationList(rows, []);
  assert.equal(presented.conversations.length, 2);
  assert.equal(presented.conversation_presentation.unstarted_candidates_omitted, 1);
  const debug = presentConversationList(rows, [], { diagnostics: true });
  assert.equal(debug.conversations.length, 3);
  assert.equal(debug.conversations[0].classification, "unstarted_candidate");
  assert.equal(f.sends, 0); assert.equal(f.launches, 0); assert.equal(f.callbacks, 0);
});

test("ambiguous native discovery preserves visible rows when history is unavailable or crossed", async t => {
  for (const fault of ["read_failure", "crossed_thread"] as const) await t.test(fault, async t => {
    const f = fixture(t); f.snapshot.historyMaterialized = false;
    const peer = { ...f.snapshot.thread, id: "existing-peer", sessionId: "existing-peer", name: "Existing task" };
    f.client.discover = async () => [f.snapshot.thread, peer];
    f.client.readSnapshot = async () => {
      if (fault === "read_failure") throw new Error("PRIVATE_READ_FAILURE");
      return { ...structuredClone(f.snapshot), threadId: "different-thread" };
    };
    const result = await f.run("codex-cli-list");
    assert.equal(result.codex_cli_scan.complete, false);
    assert.equal(result.codex_cli_scan.returned, 2, "failed detail reads do not erase loaded owners");
    const presented = presentConversationList(result.codex_cli_sessions, []);
    assert.equal(presented.conversations.length, 2);
    assert.equal(presented.conversation_presentation.unstarted_candidates_omitted, undefined);
    assert.ok(result.codex_cli_sessions.every(row => row.native_turn_id === undefined && row.unstarted_thread === undefined));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_READ_FAILURE|different-thread/u);
    assert.equal(f.sends, 0); assert.equal(f.callbacks, 0);
  });
});

test("unmaterialized native Status offers first Send without claiming subscription or permission authority", async t => {
  const f = fixture(t); f.snapshot.historyMaterialized = false;
  f.client.subscribe = async () => { throw new CodexNativeError("unmaterialized_subscription", "No materialized history"); };
  const listed = (await f.run("codex-cli-list", { approvalScan: true })).codex_cli_sessions[0];
  assert.equal(listed.unstarted_thread, true);
  assert.equal(listed.connection_state, "loaded_backend_verified"); assert.equal(listed.activity_state, "idle");
  assert.equal(listed.capabilities.send, true); assert.equal(listed.available_actions.send.input.conversation_id, f.id);
  assert.equal(listed.capabilities.set_permissions, false); assert.equal(listed.available_actions.permission_options, undefined);
  assert.equal(listed.capabilities.approve, false); assert.equal(listed.capabilities.interaction_respond, false);
  assert.doesNotMatch(listed.control_limitation, /complete the first task/i);
  for (const command of ["status", "native-inspect"]) {
    const result = await f.run(command, { conversation: f.id, action: "status" });
    assert.equal(result.native_thread_id, f.target.threadId); assert.equal(result.native_turn_id, null);
    assert.equal(result.connection_state, "loaded_backend_verified"); assert.equal(result.activity_state, "idle");
    assert.equal(result.history_state, "unmaterialized");
    assert.equal(result.subscription_state, "unavailable_unmaterialized_history");
    assert.equal(result.observation_error, "native_subscription_unmaterialized");
    assert.equal(result.interaction_requests_scanned, false); assert.equal(result.pending_interaction_count, null);
    assert.equal(result.progress.state, "no_public_progress"); assert.equal(result.capabilities.send, true);
  }
  assert.equal(f.sends, 0); assert.equal(f.launches, 0); assert.equal(f.callbacks, 0);
  f.snapshot.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  const changed = await f.run("status", { conversation: f.id });
  assert.equal(changed.connection_state, "unconfirmed"); assert.equal(changed.observation_error, "native_status_read_failed");
  assert.equal(changed.progress.state, "read_error");
  f.snapshot.thread.status = { type: "idle" };
  f.client.subscribe = async () => { throw new CodexNativeError("rpc_error", "Unrelated RPC failure"); };
  const otherFailure = await f.run("status", { conversation: f.id });
  assert.equal(otherFailure.connection_state, "unconfirmed"); assert.equal(otherFailure.progress.state, "read_error");
  f.client.subscribe = async () => {
    if (f.snapshot.historyMaterialized === false) throw new CodexNativeError("unmaterialized_subscription", "No materialized history");
  };
  const sent = await f.run("send", { conversation: f.id, message: "First task", messageId: "first", openclawSession: "controller" });
  assert.equal(sent.delivered, true); assert.equal(sent.submission_state, "verified");
  assert.equal(sent.native_thread_id, f.target.threadId); assert.equal(sent.native_turn_id, "native-turn-1");
  assert.equal((await f.run("codex-cli-list", { approvalScan: true })).codex_cli_sessions[0].unstarted_thread, undefined);
  assert.equal(f.sends, 1); assert.equal(f.launches, 1); assert.equal(f.callbacks, 0);
  f.finish();
  const completed = await f.run("watch-status", { watch: sent.watch_id });
  assert.equal(completed.status, "completed"); assert.equal(f.callbacks, 1);
});

test("only a verified unnamed pre-first-task snapshot is marked as an unstarted display candidate", async t => {
  const f = fixture(t);
  for (const history of [undefined, true, false]) {
    f.snapshot.historyMaterialized = history;
    assert.equal((await f.run("codex-cli-list", { approvalScan: true })).codex_cli_sessions[0].unstarted_thread, history === false ? true : undefined);
  }
  for (const field of ["name", "preview"] as const) {
    f.snapshot.thread[field] = "A deliberately named new session";
    const row = (await f.run("codex-cli-list", { approvalScan: true })).codex_cli_sessions[0];
    assert.equal(row.unstarted_thread, undefined);
    assert.equal(row.capabilities.send, true);
    delete f.snapshot.thread[field];
  }
  f.snapshot.pendingInteractions.push({ id: "pending", kind: "blocking_question", threadId: f.target.threadId,
    turnId: "pending-turn", itemId: "pending-item", method: "item/tool/requestUserInput", questions: [] });
  assert.equal((await f.run("codex-cli-list", { approvalScan: true })).codex_cli_sessions[0].unstarted_thread, undefined);
  assert.equal(f.sends, 0); assert.equal(f.launches, 0); assert.equal(f.callbacks, 0);
});

test("native Status public progress stays on the exact selected turn and distinguishes empty from failed reads", async t => {
  const f = fixture(t);
  const empty = await f.run("status", { conversation: f.id });
  assert.equal(empty.progress.state, "no_public_progress");
  assert.equal(empty.progress.native_turn_id, null);
  const sent = await f.run("send", { conversation: f.id, message: "READY", messageId: "progress-test", openclawSession: "controller" });
  f.snapshot.turns[0].items.push({ id: "progress", type: "agentMessage", phase: "commentary", text: "正在检查旧任务", startedAtMs: 1_700_000_000_000 });
  const running = await f.run("status", { conversation: f.id });
  assert.equal(running.progress.text, "正在检查旧任务");
  assert.equal(running.latest_turn.response_text, "");
  assert.equal(running.progress.native_turn_id, sent.native_turn_id);
  assert.equal(running.progress.latest_item_at, "2023-11-14T22:13:20.000Z");
  assert.ok(Number.isFinite(Date.parse(running.progress.read_at)));
  assert.deepEqual((toolResult(running).details as typeof running).progress, running.progress);
  assert.equal((await f.run("codex-cli-list", { approvalScan: true })).codex_cli_sessions[0].progress, undefined);
  f.finish();
  await f.run("watch-status", { watch: sent.watch_id });
  f.snapshot.latestTurnId = "successor";
  f.snapshot.turns.unshift({ id: "successor", status: "inProgress", itemsComplete: true,
    items: [{ id: "new-progress", type: "agentMessage", phase: "commentary", text: "新任务进度不可串给旧 Watch" }] });
  const old = await f.run("status", { watch: sent.watch_id });
  assert.equal(old.progress.text, "正在检查旧任务");
  assert.equal(old.progress.native_turn_id, sent.native_turn_id);
  assert.equal((await f.run("status", { conversation: f.id })).progress.native_turn_id, "successor");
  f.snapshot.turns.pop();
  assert.equal((await f.run("status", { watch: sent.watch_id })).progress.reason, "missing_exact_turn");
  // Let route selection succeed, then fail the Status snapshot itself.
  f.failReads(1);
  const failed = await f.run("status", { conversation: f.id });
  assert.equal(failed.progress.state, "read_error");
  assert.equal(failed.pending_interaction_count, null);
  assert.equal(JSON.stringify(failed).includes("private backend failure"), false);
  assert.equal((await f.run("status", { watch: sent.watch_id })).progress.state, "read_error");
  assert.equal(f.callbacks, 1);
});

test("native CLI Send persists one exact task, Status recovers completion without a monitor, callback is once", async t => {
  const f = fixture(t);
  const input = { conversation: f.id, message: "READY", messageId: "same-message", openclawSession: "controller" };
  const sent = await f.run("send", input);
  assert.equal(sent.agent_acceptance, "proven"); assert.equal(sent.native_turn_id, "native-turn-1");
  assert.equal(sent.monitor_pid, 12345); assert.equal(sent.callback_expected, true);
  assert.equal(isSubmissionError(sent), false); assert.deepEqual(withTurnIdentity(sent), sent);
  const repeated = await f.run("send", input); assert.equal(repeated.watch_id, sent.watch_id); assert.equal(f.sends, 1);
  await assert.rejects(f.run("send", { ...input, message: "DIFFERENT" }), /different immutable/);
  f.finish();
  const status = await f.run("watch-status", { watch: sent.watch_id, openclawSession: "controller" });
  assert.equal(status.status, "completed"); assert.equal(status.final_text, "NATIVE_EXACT_DONE"); assert.equal(f.callbacks, 1);
  await f.run("watch-status", { watch: sent.watch_id }); assert.equal(f.callbacks, 1);
  await assert.rejects(f.run("unwatch-terminal", { watch: sent.watch_id, openclawSession: "other" }), /different controller/);
});

test("native CLI list/status and permission tools preserve native identities without terminal selection", async t => {
  const f = fixture(t);
  const list = await f.run("codex-cli-list", { approvalScan: true }); assert.equal(list.codex_cli_sessions[0].conversation_id, f.id);
  const status = await f.run("status", { conversation: f.id }); assert.equal(status.connection_state, "loaded_backend_verified");
  const options = await f.run("native-inspect", { conversation: f.id, action: "permissions" });
  assert.equal(options.current, "read-only"); assert.deepEqual(options.choices.map(c => c.id), ["read-only", "default", "full-access"]);
  const changed = await f.run("set-permissions", { conversation: f.id, mode: "full-access" });
  assert.equal(changed.outcome, "changed"); assert.equal(changed.effective.mode, "full-access");
  assert.equal(changed.defaults_changed, false); assert.equal(f.sends, 0); assert.equal(f.updates, 1);
  for (const command of ["cancel", "new-thread", "resume-thread"]) await assert.rejects(f.run(command, { conversation: f.id }), /no unique verified terminal fallback/);
  await assert.rejects(f.run("status", { conversation: f.id, terminal: "terminal:v2:other" }), /exactly one/);
  assert.equal(f.launches, 0);
});

test("native CLI monitor launch failure retains task receipt without promising callback", async t => {
  const f = fixture(t); f.deps.launchCodexNativeMonitor = async () => { throw new Error("no spawn"); };
  const result = await f.run("send", { conversation: f.id, message: "READY", messageId: "launch-failure", openclawSession: "controller" });
  assert.equal(result.delivered, true); assert.equal(result.callback_expected, false); assert.equal(result.monitor_error, "codex_native_monitor_launch_failed");
  assert.equal(f.sends, 1);
});

test("Host presentation retains projected native questions and never fabricates managed IDs", async t => {
  const f = fixture(t);
  const iid = `codex-native-interaction:${"a".repeat(64)}`;
  f.snapshot.pendingInteractions.push({ id: iid, kind: "async_question", threadId: f.target.threadId, turnId: "task", itemId: "question",
    method: "request_user_input_async", questions: [{ id: '["request_user_input_async","question",0]', title: "Color?", options: ["Blue", "Green"] }] });
  const nativeStatus = await f.run("status", { conversation: f.id });
  const presented = toolResult(nativeStatus).details as typeof nativeStatus;
  assert.equal(presented.interaction_state[0].interaction_id, iid);
  assert.equal(presented.interaction_state[0].questions[0].options[1].label, "Green");
  assert.match(presented.interaction_state[0].questions[0].question_id, /^q:[0-9a-f]{64}$/u);
  assert.equal(presented.turn_id, undefined); assert.equal(presented.session_id, undefined);
  const invalid = structuredClone(nativeStatus); invalid.interaction_state[0].native_thread_id = "wrong-thread";
  assert.equal((toolResult(invalid).details as Record<string, unknown>).interaction_state, undefined);
});

test("native CLI exact task recovery preserves ownership and management without terminal actions", async t => {
  const f = fixture(t);
  const sent = await f.run("send", { conversation: f.id, message: "READY", messageId: "managed-recovery", openclawSession: "controller" });
  assert.equal(sent.management_state, "managed"); assert.equal(sent.turn_id, sent.watch_id);
  await f.run("unwatch-terminal", { watch: sent.watch_id, openclawSession: "controller" });
  const resumed = await f.run("renew", { turn: sent.watch_id, openclawSession: "controller", minutes: 10 });
  assert.equal(resumed.renewal_count, 1); assert.equal(resumed.observation_state, "watching"); assert.equal(resumed.management_state, "managed");
  f.finish();
  const recovered = await f.run("recover", { watch: sent.watch_id, openclawSession: "controller" });
  assert.equal(recovered.final_text, "NATIVE_EXACT_DONE"); assert.equal(recovered.status, "completed"); assert.equal(f.sends, 1);
  const closed = await f.run("close", { turn: sent.watch_id, openclawSession: "controller", reason: "Done" });
  assert.equal(closed.status, "closed"); assert.equal(closed.management_state, "closed"); assert.equal(closed.observation_status, "completed");
  assert.equal(closed.callback_expected, false); assert.equal(closed.close_reason, "Done");
  await assert.rejects(f.run("recover", { watch: sent.watch_id, openclawSession: "controller" }), /Closed/);
  await assert.rejects(f.run("renew", { conversation: f.id, openclawSession: "controller" }), /exact/i);
  await assert.rejects(f.run("recover", { watch: sent.watch_id, openclawSession: "other" }), /different controller/);
  assert.equal(f.sends, 1);
});


test("Native CLI Send/Watch defaults and lower-level timeout aliases preserve their precedence", async t => {
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

test("native Send returns a durable routed not-sent receipt for preflight subscription failure", async t => {
  const f = fixture(t);
  f.client.subscribe = async () => { throw new CodexNativeError("timeout", "private subscription path", "unknown"); };
  const input = { conversation: f.id, message: "READY", messageId: "preflight-failure", openclawSession: "controller" };
  const result = await f.run("send", input);
  assert.equal(result.delivered, false); assert.equal(result.delivery_receipt, "not_sent");
  assert.equal(result.failure_stage, "native_preflight"); assert.equal(result.request_dispatched, false);
  assert.equal(result.send_error, "timeout"); assert.ok(result.watch_id); assert.equal(result.observation_active, false);
  assert.equal(result.callback_expected, false); assert.equal(result.routing.transport, "codex_backend");
  assert.equal(JSON.stringify(result).includes("private subscription path"), false);
  f.client.subscribe = async () => {};
  const replay = await f.run("send", input);
  assert.equal(replay.replayed, true); assert.equal(replay.delivery_receipt, "not_sent");
  assert.equal(f.sends, 0); assert.equal(f.launches, 0); assert.equal(f.callbacks, 0);
});
