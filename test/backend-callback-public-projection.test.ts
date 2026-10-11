import assert from "node:assert/strict";
import test from "node:test";
import { backendCallbackPublicProjection } from "../src/backend-callback-public-projection.js";
import type { BackendRecoveryNotification } from "../src/backend-task-recovery.js";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";
import { formatRetryCallbackCommandResult } from "../src/semantic-tool-presentation.js";
import { formatDesktopCommandResult } from "../src/desktop-command-presentation.js";
import { formatCodexNativeCommandResult } from "../src/semantic-tool-command-helpers.js";
import { codexNativeTaskProjection } from "../src/codex-native-public-projection.js";
import type { CodexNativeTaskRecord } from "../src/codex-native-state-store.js";
import { createCallbackEnvelope, createTerminalWatchOpenClawCallbackRoute } from "../src/callback-transport.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";

const accepted: BackendRecoveryNotification = { id: "notice-accepted", status: "accepted", attempts: 1,
  outcome: { disposition: "accepted", accepted_at: "2026-10-11T00:00:00.000Z", acceptance_id: "private-run-id" } };
function project(notes: BackendRecoveryNotification[], active = false, stopped = false) {
  return backendCallbackPublicProjection({ callback_route: true, notifications: notes }, active, stopped);
}

test("uncertain callback remains distinct from task completion, earlier acceptance and user delivery", () => {
  const uncertain: BackendRecoveryNotification = { id: "notice-current", status: "uncertain", attempts: 1,
    outcome: { disposition: "uncertain", error_code: "openclaw_callback_acceptance_uncertain",
      observed_at: "2026-10-11T00:00:01.000Z", evidence: { request_phase: "submitted", request_dispatched: true,
        idempotency_key: "private-key", recipient: "private-recipient", error_message: "private-content" } } };
  const result = { ...project([accepted, uncertain]), status: "completed", callback_expected: false,
    watch_id: "codex-cli-watch:test-notification-001", source: "codex_cli" };
  assert.equal(result.callback_state, "uncertain");
  assert.equal(result.callback_notifications[1].controller_acceptance, "unconfirmed");
  assert.equal(result.callback_notifications[1].request_dispatched, true);
  assert.equal(result.callback_notifications[1].request_phase, "submitted");
  assert.equal(result.channel_delivery_state, "unknown");
  for (const state of [result, project([accepted, uncertain], false, true)]) assert.equal(state.callback_state, "uncertain");
  const listed = compactAkkListModelProjection({ codex_cli_watches: [result], desktop_watches: [result], claude_cli_watches: [result] });
  for (const key of ["codex_cli_watches", "desktop_watches", "claude_cli_watches"]) {
    const row = (listed[key] as Record<string, any>[])[0];
    assert.equal(row.callback_state, "uncertain"); assert.equal(row.channel_delivery_state, "unknown");
    assert.equal(row.callback_notifications[1].request_dispatched, true);
  }
  for (const text of [JSON.stringify(result), JSON.stringify(listed)]) assert.doesNotMatch(text, /private-/u);
  for (const text of [formatCodexNativeCommandResult(result, "status"), formatDesktopCommandResult(result, "status")]) {
    assert.match(text, /callback state: uncertain/u);
    assert.match(text, /user-channel delivery is unknown/u);
  }
});

test("accepted requires positive outcome evidence and never implies channel delivery", () => {
  assert.equal(project([accepted]).callback_state, "accepted");
  assert.equal(project([accepted]).callback_notifications[0].controller_acceptance, "confirmed");
  assert.equal(project([accepted]).channel_delivery_state, "unknown");
  assert.equal(project([{ ...accepted, outcome: undefined }]).callback_state, "uncertain");
  assert.equal(project([accepted], true).callback_state, "monitoring");
});

test("completed Codex Watch retains uncertain callback status separately from native send acceptance", () => {
  const target = { codexHome: "/fixture/codex", threadId: "native-thread" };
  const nativeId = createCodexNativeConversationId(target), id = "codex-cli-watch:fixture-task-001", noteId = `${id}:settled`;
  const route = createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: "private-controller" });
  const record: CodexNativeTaskRecord = { schema: "agent-knock-knock/codex-native-task", version: 1, revision: 1,
    id, watch_id: id, native_id: nativeId, target, controller_session: "private-controller", kind: "send", status: "completed",
    created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:01:00Z", deadline_at: "2026-10-11T12:00:00Z",
    native_turn_id: "exact-turn", pending_interactions: [], callback_route: route,
    send_intent: { message_id: "message", client_user_message_id: "client", text: "private-prompt", baseline_turn_ids: [],
      state: "accepted", dispatched_at: "2026-10-11T00:00:00Z" }, notifications: [{ id: noteId, status: "uncertain", attempts: 1,
      outcome: { disposition: "uncertain", error_code: "acceptance_uncertain", observed_at: "2026-10-11T00:01:00Z" },
      envelope: createCallbackEnvelope({ route, source: { kind: "codex_native_watch", watch_id: id, native_id: nativeId },
        event: { id: noteId, type: "codex_native_watch.settled", body: "private-result", requires_response: false } }) }] };
  const projected = codexNativeTaskProjection(record);
  assert.equal(projected.status, "completed"); assert.equal(projected.delivered, true);
  assert.equal(projected.agent_acceptance, "proven"); assert.equal(projected.callback_expected, false);
  assert.equal(projected.callback_state, "uncertain"); assert.equal(projected.channel_delivery_state, "unknown");
  assert.equal(projected.capabilities.retry_callback, false);
  assert.doesNotMatch(JSON.stringify(projected), /private-/u);
});

test("bounded retry projections explain waiting and exhausted states without inferring private evidence", () => {
  const waiting: BackendRecoveryNotification = { id: "notice-retry", status: "retry_wait", attempts: 1,
    retry_at: "2026-10-11T00:00:05.000Z", outcome: { disposition: "retryable_failure", error_code: "pre_dispatch_failure",
      evidence: { request_phase: "connection_handshake", request_dispatched: false } } };
  assert.equal(project([waiting]).callback_state, "retry_wait");
  assert.equal(project([waiting]).callback_notifications[0].next_attempt_at, waiting.retry_at);
  const exhausted = project([{ ...waiting, status: "failed", retry_at: undefined, attempts: 4,
    outcome: { ...waiting.outcome!, evidence: { retry_budget_exhausted: true, max_delivery_attempts: 4 } } }]);
  assert.equal(exhausted.callback_state, "failed");
  assert.equal(exhausted.callback_notifications[0].automatic_retry_stopped, true);
  assert.equal(exhausted.callback_notifications[0].retry_budget_exhausted, true);
  assert.equal(exhausted.callback_notifications[0].max_delivery_attempts, 4);
  assert.equal(project([{ ...waiting, status: "failed", retry_at: undefined }]).callback_notifications[0].retry_budget_exhausted, undefined);
  const legacy = project([{ id: "old", status: "uncertain", attempts: 1 }]).callback_notifications[0];
  assert.equal(legacy.request_dispatched, undefined); assert.equal(legacy.request_phase, undefined);
});

test("legacy retry presentation never declares success merely because a retry command returned", () => {
  for (const status of ["uncertain", "failed", "pending", "delivered"]) {
    const text = formatRetryCallbackCommandResult({ conversation: { status: "completed", callback_delivery: { status, attempts: 1 } } });
    assert.match(text, /acceptance is not confirmed/u); assert.doesNotMatch(text, /callback delivered/u);
  }
  const text = formatRetryCallbackCommandResult({ conversation: { status: "completed", callback_delivery: {
    status: "delivered", attempts: 1, attempt_outcome: accepted.outcome
  } } });
  assert.match(text, /accepted by the controller/u); assert.match(text, /does not prove user-channel delivery/u);
});
