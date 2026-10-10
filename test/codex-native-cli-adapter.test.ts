import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCliCommand } from "../src/cli-core.js";
import { createCodexNativeRuntime, type CodexNativeClientPort } from "../src/codex-native-runtime.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import type { CodexNativeSnapshot, CodexNativePermissions } from "../src/codex-native-types.js";
import type { CliCommandDependencies } from "../src/cli-runtime-context.js";
import { isSubmissionError, toolResult, withTurnIdentity } from "../src/semantic-tool-presentation.js";

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
  const client: CodexNativeClientPort = {
    metadata: { serverVersion: "0.162.0", codexHome: target.codexHome, socketPath: "/fixture", platformFamily: "unix", platformOs: "macos" },
    async discover() { return [snapshot.thread]; }, async readSnapshot() { return structuredClone(snapshot); }, async subscribe() {}, close() {},
    async start(_thread, input) {
      await input.beforeDispatch?.(structuredClone(snapshot)); sends++;
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
  return { run, id, target, snapshot, deps, get sends() { return sends; }, get callbacks() { return callbacks; },
    get launches() { return launches; }, get updates() { return updates; },
    finish() { snapshot.thread.status = { type: "idle" }; snapshot.canSend = true; snapshot.turns[0]!.status = "completed";
      snapshot.turns[0]!.items.push({ id: "final", type: "agentMessage", phase: "final_answer", text: "NATIVE_EXACT_DONE" }); }
  };
}

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
  const list = await f.run("codex-cli-list"); assert.equal(list.codex_cli_sessions[0].conversation_id, f.id);
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
