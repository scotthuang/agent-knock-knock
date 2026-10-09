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
import { VERIFIED_DESKTOP_BUILD } from "../src/desktop-ipc-client.js";
import { buildDesktopAsyncReply, desktopAsyncQuestions } from "../src/desktop-async-interactions.js";
import { createDesktopSessionControls } from "../src/desktop-session-controls.js";
import { DesktopIpcError } from "../src/desktop-types.js";
import type { DesktopSnapshot, DesktopTransportPort, DesktopTurnItem } from "../src/desktop-types.js";
import type { CliCommandDependencies } from "../src/cli-runtime-context.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = { codexHome: path.join(root, ".codex"), hostId: "local", threadId: "desktop-thread" };
  const id = createDesktopConversationId(target);
  const storeDir = path.join(root, "store");
  let snapshot: DesktopSnapshot = { threadId: target.threadId, ownerClientId: "exact-owner", revision: 1,
    runtimeStatus: "idle", pendingRequests: [], pendingRequestCount: 0, unconfirmedSubmissionCount: 0,
    tailKnown: true, latestTurnId: null, turns: [], canSend: true };
  let sends = 0, callbacks = 0, launches = 0, closed = 0, answers = 0;
  let deferredAnswer: DesktopTurnItem | undefined;
  let deferAnswer = false;
  const transport: DesktopTransportPort = {
    observe: async () => structuredClone(snapshot),
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
    rows: [{ thread_id: target.threadId, host_id: "local", display_title: "Desktop test", source_updated_at: 1 }]
  }] });
  const tasks = createDesktopTaskService({ repository, ...transport, deliver: () => {
    callbacks++; return { disposition: "accepted", accepted_at: new Date().toISOString(), acceptance_id: "callback-accepted" };
  } });
  const responses = createDesktopResponseService({ tasks: repository,
    repository: createDesktopResponseStore(storeDir, { acquire: () => () => {} }), observe: transport.observe,
    answerAsync: transport.answerAsync! });
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
    createDesktopRuntime: () => ({ compatibility: VERIFIED_DESKTOP_BUILD, catalog, transport, tasks, responses, controls,
      close: async () => { closed++; } }),
    launchDesktopMonitor: async () => { launches++; return 1234; } };
  const run = async (command: string, options: Record<string, unknown> = {}) => JSON.parse((await executeCliCommand(command,
    { storeDir, ...options }, deps)).stdout);
  return { id, tasks, run, deps, get sends() { return sends; }, get callbacks() { return callbacks; },
    get launches() { return launches; }, get closed() { return closed; }, get answers() { return answers; },
    ask(delayed = false) {
      deferAnswer = delayed;
      snapshot.turns[0].items.push({ id: "question-one", type: "agentMessage", phase: "final_answer", delivery: "async",
        text: "Pick a color", questions: [{ title: "Pick a color", options: ["Green", "Blue"] }] });
      snapshot.asyncQuestions = desktopAsyncQuestions(snapshot);
    },
    revealAnswer() {
      if (deferredAnswer) snapshot.turns[0].items.push(deferredAnswer);
      snapshot.asyncQuestions = desktopAsyncQuestions(snapshot); deferredAnswer = undefined;
    },
    finish() { snapshot.runtimeStatus = "idle"; snapshot.canSend = true;
      snapshot.turns[0]!.status = "completed";
      snapshot.turns[0]!.items.push({ id: "answer", type: "agentMessage", phase: "final_answer", text: "EXACT_DONE" }); } };
}

test("Desktop CLI sends once, launches exact Watch, recovers completion and enforces controller ownership", async t => {
  const f = fixture(t);
  const input = { conversation: f.id, message: "Only reply READY", messageId: "stable-cli-message", openclawSession: "controller-one" };
  const receipt = await f.run("send", input);
  assert.equal(receipt.agent_acceptance, "proven"); assert.equal(receipt.native_turn_id, "turn-one");
  assert.equal(receipt.callback_expected, true); assert.equal(receipt.monitor_pid, 1234);
  assert.equal(f.sends, 1);
  const same = await f.run("send", input);
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
  const f = fixture(t);
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
