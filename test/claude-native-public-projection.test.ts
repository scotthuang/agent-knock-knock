import assert from "node:assert/strict";
import test from "node:test";
import { claudeNativeSessionProjection, claudeNativeTaskProjection } from "../src/claude-native-public-projection.js";
import { createClaudeNativeConversationId, type ClaudeNativeCatalogEntry } from "../src/claude-native-identity.js";
import { createCallbackEnvelope, createTerminalWatchOpenClawCallbackRoute } from "../src/callback-transport.js";
import type { ClaudeNativeSnapshot } from "../src/claude-native-observation.js";
import type { ClaudeNativeTaskRecord } from "../src/claude-native-state-store.js";
const target = { configDir: "/fixture/claude", sessionId: "10000000-0000-4000-8000-000000000001", pid: 123,
  processStart: "Sun Oct 11 00:00:00 2026" };
const id = createClaudeNativeConversationId(target);
const inputId = "20000000-0000-4000-8000-000000000002", at = "2026-10-11T00:00:00.000Z";
const entry: ClaudeNativeCatalogEntry = { ...target, nativeId: id, cwd: "/fixture/project", version: "2.1.296",
  socketPath: "/fixture/private.sock", peerProtocol: 1, peerFeatures: ["notify_idle"], status: "idle", observedAt: at };
const route = createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: "private-controller" });
function task(extra: Partial<ClaudeNativeTaskRecord> = {}): ClaudeNativeTaskRecord {
  const watch = "claude-cli-watch:00000000-0000-4000-8000-000000000001";
  return { schema: "agent-knock-knock/claude-native-task", version: 1, revision: 1, id: watch, watch_id: watch,
    native_id: id, target, entry, controller_session: "private-controller", kind: "send", status: "awaiting_acceptance",
    created_at: at, updated_at: at, deadline_at: "2026-10-11T12:00:00.000Z", callback_route: route, notifications: [],
    send_intent: { message_id: "public-message", client_user_message_id: inputId, native_message_id: "30000000-0000-4000-8000-000000000003",
      text: "PRIVATE_PROMPT", sender_pid: 456, state: "uncertain", dispatched_at: at }, ...extra };
}
function progress(): NonNullable<ClaudeNativeTaskRecord["progress"]> {
  return { state: "available", text: "PUBLIC_PROGRESS", native_turn_id: null, native_input_id: inputId,
    task_anchor_kind: "native_input_uuid", read_at: at, latest_item_at: at, truncated: false };
}

test("List projections exclude progress, answers, raw requests and callback routing", () => {
  const record = task({ response_text: "PUBLIC_RESULT", progress: progress() });
  const compact = claudeNativeTaskProjection(record);
  const list = JSON.stringify({ session: claudeNativeSessionProjection(entry), watch: compact });
  for (const omitted of ["PUBLIC_PROGRESS", "PUBLIC_RESULT", "PRIVATE_PROMPT", "private-controller", "private.sock", route.profile_revision]) {
    assert.equal(list.includes(omitted), false);
  }
  assert.equal(Object.hasOwn(compact, "native_turn_id"), false);
  assert.equal(compact.native_input_id, null);
  assert.equal(compact.resend_allowed, false);
  assert.equal(compact.needs_watch, false);
  assert.equal(compact.callback_expected, true);
  assert.equal(compact.callback_state, "monitoring");
  assert.equal(claudeNativeTaskProjection(record, true).progress?.text, "PUBLIC_PROGRESS");
});

test("verified Send has one exact input Watch while completed callback acceptance remains distinct", () => {
  const record = task({ status: "completed", native_input_id: inputId, response_text: "Result" });
  record.send_intent!.state = "accepted";
  const noteId = `${record.id}:completed`;
  record.notifications.push({ id: noteId, attempts: 0, status: "ready", envelope: createCallbackEnvelope({ route,
    source: { kind: "claude_native_watch", watch_id: record.id, native_id: id },
    event: { id: noteId, type: "claude_native_watch.completed", body: "PRIVATE_NOTIFICATION", requires_response: false } }) });
  const pending = claudeNativeTaskProjection(record, true);
  assert.equal(pending.delivered, true); assert.equal(pending.agent_acceptance, "proven");
  assert.equal(pending.native_thread_id, target.sessionId); assert.equal(pending.native_input_id, inputId);
  assert.equal(pending.observation_active, false); assert.equal(pending.callback_expected, true);
  assert.equal(pending.callback_state, "pending"); assert.equal(pending.capabilities.renew, false);
  record.notifications[0].status = "accepted";
  record.notifications[0].outcome = { disposition: "accepted", accepted_at: at, acceptance_id: "callback-accepted" };
  const accepted = claudeNativeTaskProjection(record);
  assert.equal(accepted.callback_expected, false); assert.equal(accepted.callback_state, "accepted");
  assert.equal(accepted.callback_delivery_scope, "controller_acceptance_only");
  assert.equal(accepted.channel_delivery_state, "unknown");
  record.notifications[0].status = "uncertain";
  record.notifications[0].outcome = { disposition: "uncertain", observed_at: at, error_code: "acceptance_uncertain" };
  assert.equal(claudeNativeTaskProjection(record).callback_state, "uncertain");
  assert.equal(claudeNativeTaskProjection(record).status, "completed");
  assert.doesNotMatch(JSON.stringify(accepted), /PRIVATE_NOTIFICATION/u);
});

test("exited observations cannot renew and expired observers point to the existing Watch", () => {
  const exited = claudeNativeTaskProjection(task({ status: "exited", native_input_id: inputId }));
  assert.equal(exited.capabilities.renew, false); assert.equal(Object.hasOwn(exited.available_actions, "renew"), false);
  assert.equal(exited.observation_state, "settled"); assert.equal(exited.next_action, "return_to_claude_terminal");
  const expired = claudeNativeTaskProjection(task({ status: "timed_out", native_input_id: inputId }));
  assert.equal(expired.callback_expected, false); assert.equal(expired.capabilities.renew, true);
  assert.equal(expired.next_action, "renew_existing_watch"); assert.equal(expired.needs_watch, false);
});

test("registry waits are manual hints, never scanned or actionable approval claims", () => {
  const waiting = claudeNativeSessionProjection({ ...entry, status: "waiting", waitingFor: "permission prompt" });
  assert.equal(waiting.capabilities.send, false); assert.equal(waiting.capabilities.approve, false);
  assert.equal(waiting.capabilities.interaction_notify, false); assert.equal(waiting.capabilities.interaction_respond, false);
  assert.equal(waiting.manual_required, true); assert.equal(waiting.next_action, "return_to_claude_terminal");
  assert.equal(waiting.interaction_requests_scanned, false); assert.equal(waiting.pending_interaction_count, null);
  const unknown = claudeNativeSessionProjection({ ...entry, status: "waiting", waitingFor: "UNVALIDATED_PRIVATE_REQUEST" });
  assert.equal(unknown.waiting_for, "unknown"); assert.doesNotMatch(JSON.stringify(unknown), /UNVALIDATED_PRIVATE_REQUEST/u);
});

test("current working registry does not turn an older completed snapshot into an active Watch", () => {
  const snapshot: ClaudeNativeSnapshot = { identity: target, readAt: at, latestInputUuid: inputId, inputs: [], progress: progress(),
    selectedInput: { inputUuid: inputId, kind: "root_user", origin: "human", acceptedAt: at, state: "completed",
      responseText: "Old answer", responseTruncated: false, completedAt: at, pendingTools: [], toolResults: [] } };
  const result = claudeNativeSessionProjection({ ...entry, status: "working" }, snapshot);
  assert.equal(result.activity_state, "working"); assert.equal(result.input_state, "completed");
  assert.equal(result.capabilities.watch, false); assert.equal(result.capabilities.send, false);
  assert.equal(result.progress?.text, "PUBLIC_PROGRESS");
});
