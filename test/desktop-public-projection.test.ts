import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_CREATION_BUILD, desktopCapabilityProfile } from "../src/desktop-compatibility.js";
import { validateDesktopInteractionProjections } from "../src/desktop-interaction-projection.js";
import { desktopSessionProjection, desktopTaskProjection } from "../src/desktop-public-projection.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { createCallbackEnvelope, createTerminalWatchOpenClawCallbackRoute } from "../src/callback-transport.js";
import type { DesktopCatalogEntry } from "../src/desktop-session-catalog.js";
import type { DesktopAsyncInteraction, DesktopRequestInteraction, DesktopSnapshot } from "../src/desktop-types.js";
import type { DesktopTaskRecord } from "../src/desktop-state-store.js";

const target = { codexHome: "/fixture/codex", hostId: "local", threadId: "thread-one" };
const conversationId = createDesktopConversationId(target);
const entry: DesktopCatalogEntry = { ...target, conversationId, title: "Catalog conversation", cwd: "/project",
  updatedAtMs: 1, originator: "codex-tui", projectId: null, sourceKind: "unknown", threadSource: null,
  catalogMembership: "desktop_catalog", localVerifiable: true, metadataOnly: true, provenance: [] };
function snapshot(extra: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return { threadId: target.threadId, ownerClientId: "owner-private", revision: 1, runtimeStatus: "idle",
    pendingRequests: [], pendingRequestCount: 0, unconfirmedSubmissionCount: 0, tailKnown: true,
    latestTurnId: null, turns: [], canSend: true, ...extra };
}
const route = createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: "controller-private" });
function task(extra: Partial<DesktopTaskRecord> = {}): DesktopTaskRecord {
  const id = "desktop-watch:00000000-0000-0000-0000-000000000001";
  return { schema: "agent-knock-knock/desktop-task", version: 1, revision: 1, id, watch_id: id,
    desktop_id: conversationId, target, controller_session: "controller-private", kind: "send", status: "awaiting_acceptance",
    created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deadline_at: "2026-10-09T01:00:00Z",
    send_intent: { message_id: "public-message", client_user_message_id: "client-private", text: "private prompt",
      owner_client_id: "owner-private", baseline_turn_ids: [], state: "uncertain", dispatched_at: "2026-10-09T00:00:00Z" },
    callback_route: route, pending_manual_count: 0, notifications: [], ...extra };
}

test("catalog-only Desktop conversations remain selectable without claiming live send or Watch", () => {
  const result = desktopSessionProjection(entry);
  assert.equal(result.conversation_id, conversationId); assert.equal(result.creator_originator, "codex-tui");
  assert.equal(result.connection_state, "unconfirmed"); assert.equal(result.activity_state, "unknown");
  assert.equal(result.can_send_reason, "live_owner_not_confirmed");
  assert.deepEqual(result.capabilities, { status: true, send: false, watch: false, interaction_notify: false, interaction_respond: false, approve: false, set_permissions: false, set_model: false, cancel: false });
  assert.deepEqual(result.available_actions, { status: { tool: "agent_knock_knock_status", input: { conversation_id: conversationId } } });
});

test("sidebar membership remains visible when Desktop has unloaded its owner", () => {
  const result = desktopSessionProjection({ ...entry,
    sidebar: { section: "project", projectId: "project-one", projectName: "Avatar" } }, undefined, false, "no_live_owner");
  assert.equal(result.sidebar_project_name, "Avatar");
  assert.equal(result.sidebar_section, "project");
  assert.equal(result.conversation_id, conversationId);
  assert.equal(result.observation_error, "no_live_owner");
  assert.equal(result.can_send_reason, "no_live_owner");
  assert.match(String(result.manual_action), /Open this conversation in Desktop/);
  assert.equal((result.capabilities as any).send, false);
  assert.equal((result.available_actions as any).send, undefined);
});

test("Desktop send requires a verified write contract; Watch requires a uniquely active exact tail", () => {
  assert.equal((desktopSessionProjection(entry, snapshot(), false).capabilities as any).send, false);
  assert.equal((desktopSessionProjection(entry, snapshot(), true).capabilities as any).send, true);
  assert.equal((desktopSessionProjection(entry, snapshot(), false).capabilities as any).set_permissions, false);
  assert.equal((desktopSessionProjection(entry, snapshot(), true).capabilities as any).set_permissions, true);
  const running = snapshot({ runtimeStatus: "active", canSend: false, latestTurnId: "turn-one",
    turns: [{ turnId: "turn-one", status: "inProgress", items: [], itemsComplete: true }] });
  assert.equal((desktopSessionProjection(entry, running).capabilities as any).watch, true);
  assert.equal((desktopSessionProjection(entry, running, true).capabilities as any).set_permissions, false);
  assert.equal((desktopSessionProjection(entry, running, true).capabilities as any).set_model, false);
  assert.equal((desktopSessionProjection(entry, running, true).capabilities as any).cancel, true);
  assert.deepEqual((desktopSessionProjection(entry, running, true).available_actions as any).cancel.input,
    { conversation_id: conversationId, expected_native_turn_id: "turn-one" });
  for (const invalid of [{ ...running, runtimeStatus: "unknown" as const }, { ...running, tailKnown: false },
    { ...running, latestTurnId: "different-turn" }]) {
    assert.equal((desktopSessionProjection(entry, invalid).capabilities as any).watch, false);
  }
});

test("uncertain Desktop receipts never claim acceptance or disclose internal send/callback material", () => {
  const result = desktopTaskProjection(task());
  assert.equal(result.delivered, false); assert.equal(result.agent_acceptance, "unproven");
  assert.equal(result.delivery_receipt, "acceptance_unproven"); assert.equal(result.native_turn_id, null);
  assert.equal(result.resend_allowed, false); assert.equal(result.callback_expected, true);
  const text = JSON.stringify(result);
  for (const privateText of ["private prompt", "client-private", "owner-private", "controller-private", route.profile_revision]) {
    assert.equal(text.includes(privateText), false);
  }
});

test("completion callback expectation follows its outbox and manual interaction remains notification-only", () => {
  const record = task({ status: "completed", native_turn_id: "turn-one", final_text: "Exact task result" });
  record.send_intent!.state = "accepted";
  const id = `${record.id}:settled`;
  record.notifications.push({ id, status: "ready", attempts: 0, envelope: createCallbackEnvelope({ route,
    source: { kind: "desktop_watch", watch_id: record.id, desktop_id: conversationId },
    event: { id, type: "desktop_watch.settled", body: "Private callback envelope", requires_response: false } }) });
  assert.equal(desktopTaskProjection(record).callback_expected, true);
  record.notifications[0].status = "accepted"; record.notifications[0].attempts = 1;
  record.notifications[0].outcome = { disposition: "accepted", accepted_at: "2026-10-09T00:00:00Z", acceptance_id: "accepted" };
  const complete = desktopTaskProjection(record);
  assert.equal(complete.callback_expected, false); assert.equal(complete.delivered, true);
  assert.equal(complete.callback_state, "accepted"); assert.equal(complete.channel_delivery_state, "unknown");
  assert.equal(complete.final_text, "Exact task result");
  assert.equal(JSON.stringify(complete).includes("Private callback envelope"), false);
  record.notifications[0].status = "uncertain";
  record.notifications[0].outcome = { disposition: "uncertain", observed_at: "2026-10-09T00:00:01Z", error_code: "acceptance_uncertain" };
  assert.equal(desktopTaskProjection(record).callback_state, "uncertain");
  assert.equal(desktopTaskProjection(record).status, "completed");
  const pending = desktopTaskProjection(task({ kind: "watch", status: "watching", native_turn_id: "turn-one", send_intent: undefined, pending_manual_count: 1 }));
  assert.match(String(pending.manual_action), /in Desktop/);
  assert.equal((pending.capabilities as any).interaction_respond, false);
  assert.equal((pending.capabilities as any).approve, false);
  assert.equal(desktopTaskProjection(task({ status: "cancelled" })).callback_expected, false);
});

test("Desktop task projections retain observation evidence while distinguishing management and recovery actions", () => {
  const stopped = task({ status: "timed_out", unwatched_at: "2026-10-09T02:00:00Z" });
  const output = desktopTaskProjection(stopped);
  assert.equal(output.management_state, "managed"); assert.equal(output.observation_state, "stopped");
  assert.equal(output.status, "timed_out"); assert.equal(output.callback_expected, false);
  assert.equal(output.turn_id, stopped.id);
  assert.deepEqual((output.available_actions as any).recover.input, { watch_id: stopped.id });
  const closed = desktopTaskProjection({ ...stopped, closed_at: "2026-10-09T03:00:00Z", close_reason: "No longer managed" });
  assert.equal(closed.status, "closed"); assert.equal(closed.observation_status, "timed_out"); assert.equal(closed.management_state, "closed");
  assert.deepEqual(Object.keys(closed.available_actions as object), ["status"]);
  const watch = desktopTaskProjection(task({ kind: "watch", send_intent: undefined, status: "watching", native_turn_id: "turn-one" }));
  assert.equal(watch.management_state, "unmanaged"); assert.equal(watch.turn_id, undefined);
  assert.equal((watch.available_actions as any).close, undefined);
});


test("Desktop approval profile keeps questions, settings and cancellation unavailable", () => {
  const profile = desktopCapabilityProfile(DESKTOP_CREATION_BUILD);
  const ready = desktopSessionProjection(entry, snapshot(), profile) as any;
  assert.equal(ready.capabilities.send, true);
  for (const capability of ["set_model", "set_permissions", "approve", "interaction_respond", "cancel"]) assert.equal(ready.capabilities[capability], false);
  assert.equal(ready.available_actions.model_options, undefined);
  assert.equal(ready.available_actions.permission_options, undefined);
  const interaction: DesktopAsyncInteraction = { id: `desktop-async-interaction:${"a".repeat(64)}`, kind: "async_question" as const,
    threadId: target.threadId, turnId: "turn-one", itemId: "question-one", method: "request_user_input_async" as const,
    questions: [{ id: "question-one", title: "Choose a color", options: ["Green", "Blue"], isOther: true }] };
  const running = snapshot({ runtimeStatus: "active", canSend: false, latestTurnId: "turn-one",
    turns: [{ turnId: "turn-one", status: "inProgress", items: [], itemsComplete: true }], pendingInteractions: [interaction] });
  const current = desktopSessionProjection(entry, running, profile) as any;
  assert.equal(current.capabilities.watch, true); assert.equal(current.capabilities.interaction_notify, true);
  assert.equal(current.capabilities.interaction_respond, false); assert.equal(current.capabilities.cancel, false);
  assert.equal(current.pending_interaction_count, 1); assert.match(current.manual_action, /in Desktop/);
  assert.equal(current.interaction_state[0].questions[0].title, "Choose a color");
  assert.deepEqual(current.interaction_state[0].available_actions, {});
  assert.deepEqual(validateDesktopInteractionProjections(current.interaction_state, conversationId, undefined, "turn-one")[0].available_actions, {});
  const watched = desktopTaskProjection(task({ status: "watching", native_turn_id: "turn-one", pending_interactions: [interaction] }), profile) as any;
  assert.equal(watched.capabilities.interaction_notify, true); assert.equal(watched.capabilities.interaction_respond, false);
  assert.equal(watched.capabilities.cancel, false); assert.equal(watched.pending_manual_count, 1);
  assert.equal(watched.pending_interaction_count, 1); assert.deepEqual(watched.interaction_state[0].available_actions, {});
  assert.match(watched.manual_action, /in Desktop/);
});

test("Desktop mixed approval/question projections agree across conversation and exact Watch status", () => {
  const profile = desktopCapabilityProfile(DESKTOP_CREATION_BUILD);
  const approvals: DesktopRequestInteraction[] = (["command_approval", "file_approval"] as const).map((kind, index) => ({
    id: `desktop-request-interaction:${String(index + 1).repeat(64)}`, kind,
    threadId: target.threadId, turnId: "turn-one", itemId: `item-${index}`, requestId: index,
    method: kind === "command_approval" ? "item/commandExecution/requestApproval" : "item/fileChange/requestApproval", questions: [] }));
  const question: DesktopRequestInteraction = { ...approvals[0], kind: "blocking_question",
    id: `desktop-request-interaction:${"3".repeat(64)}`, requestId: 2, itemId: "question-one", method: "item/tool/requestUserInput",
    questions: [{ id: "color", title: "Choose a color", options: ["Green"] }] };
  const interactions = [...approvals, question];
  const running = snapshot({ runtimeStatus: "active", canSend: false, latestTurnId: "turn-one",
    turns: [{ turnId: "turn-one", status: "inProgress", items: [], itemsComplete: true }],
    pendingRequestCount: 3, pendingInteractions: interactions });
  const watched = task({ status: "watching", native_turn_id: "turn-one", pending_interactions: interactions });
  for (const output of [desktopSessionProjection(entry, running, profile), desktopTaskProjection(watched, profile)] as any[]) {
    assert.equal(output.capabilities.approve, true); assert.equal(output.capabilities.interaction_respond, false);
    assert.equal(output.capabilities.cancel, false); assert.equal(output.pending_manual_count, 1);
    assert.equal(output.pending_interaction_count, 3);
    for (const approval of output.interaction_state.slice(0, 2)) {
      assert.equal(approval.available_actions.approve.tool, "agent_knock_knock_approve");
      assert.equal(approval.manual_action, undefined);
    }
    assert.deepEqual(output.interaction_state[2].available_actions, {});
    assert.match(output.interaction_state[2].manual_action, /in Desktop/);
  }
  const approvalOnly = desktopSessionProjection(entry, { ...running, pendingRequestCount: 2, pendingInteractions: approvals }, profile) as any;
  assert.equal(approvalOnly.pending_manual_count, 0); assert.equal(approvalOnly.manual_action, undefined);
  const unknown = desktopTaskProjection(watched, desktopCapabilityProfile({ ...DESKTOP_CREATION_BUILD, build: "future" })) as any;
  assert.equal(unknown.capabilities.approve, false); assert.equal(unknown.pending_manual_count, 3);
});
