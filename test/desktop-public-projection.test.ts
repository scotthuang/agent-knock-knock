import test from "node:test";
import assert from "node:assert/strict";
import { desktopSessionProjection, desktopTaskProjection } from "../src/desktop-public-projection.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { createCallbackEnvelope, createTerminalWatchOpenClawCallbackRoute } from "../src/callback-transport.js";
import type { DesktopCatalogEntry } from "../src/desktop-session-catalog.js";
import type { DesktopSnapshot } from "../src/desktop-types.js";
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
