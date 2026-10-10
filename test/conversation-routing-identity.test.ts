import test from "node:test";
import assert from "node:assert/strict";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { associateConversationRoutes, proveNativeTerminalRoute, resolveNativeTerminalRoute, withClosedStatusInspection } from "../src/conversation-routing-identity.js";

const home = "/fixture/codex", thread = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const nativeId = createCodexNativeConversationId({ codexHome: home, threadId: thread });
function terminal(extra: Record<string, unknown> = {}) {
  return { id: "terminal:v2:tmux:codex:test:0.0:123", agent: "codex", process_state: "active", pid: 123,
    native_agent_process_uuid: "process-123", native_agent_process_birth: "2026-10-10T01:02:03Z",
    native_agent_session_id: thread, native_agent_identity_observation: { status: "resolved" },
    codex_home: home, activity_state: "idle", approval_state: { scanned: true, blocked: false }, cwd: "/project", ...extra };
}
function native(extra: Record<string, unknown> = {}) {
  return { id: nativeId, conversation_id: nativeId, native_thread_id: thread, source: "codex_cli", agent: "codex",
    connection_state: "loaded_backend_verified", cwd: "/project", ...extra };
}

test("routing merges only the matching resolved physical native identity and backend home", () => {
  const result = associateConversationRoutes([terminal()], [native(), native({
    id: "other", conversation_id: createCodexNativeConversationId({ codexHome: home, threadId: other }), native_thread_id: other
  })]);
  assert.equal(result.associations.length, 1);
  assert.equal(result.associations[0].nativeId, nativeId);
  assert.equal(result.associations[0].evidence, "resolved_native_identity");
  assert.deepEqual(result.unassociated, []);
});

test("same directory, resume command, historical managed task and unavailable identity never establish routing", () => {
  const row = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    command: `codex resume ${thread}`, managed: { current_turn: { native_thread_id: thread } } });
  assert.equal(associateConversationRoutes([row], [native()]).associations.length, 0);
  assert.equal(proveNativeTerminalRoute(nativeId, row).status, "unavailable");
  assert.equal(proveNativeTerminalRoute(nativeId, terminal({ native_agent_identity_observation: { status: "unavailable" } })).status, "unavailable");
});

test("visible exact status card can map paginated terminal only with current idle/process evidence", () => {
  const row = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    native_agent_status_card_session_id: thread });
  assert.equal(associateConversationRoutes([row], [native()]).associations[0].evidence, "visible_status_card");
  for (const drift of [{ activity_state: "working" }, { approval_state: { blocked: true } },
    { native_agent_process_birth: undefined }, { native_agent_process_uuid: undefined }, { process_state: "stopped" }]) {
    assert.notEqual(proveNativeTerminalRoute(nativeId, { ...row, ...drift }).status, "exact");
  }
  assert.equal(proveNativeTerminalRoute(nativeId, { ...row, native_agent_session_id: other }).status, "conflict");
});

test("home evidence is physical and never guessed from scan configuration, a unique backend or directory", () => {
  const row = terminal({ codex_home: undefined });
  assert.equal(associateConversationRoutes([row], [native()]).associations.length, 0);
  assert.equal(proveNativeTerminalRoute(nativeId, row, { defaultCodexHome: home }).status, "unavailable");
  assert.equal(proveNativeTerminalRoute(nativeId, row, { defaultCodexHome: "/different" }).status, "unavailable");
  assert.equal(proveNativeTerminalRoute(nativeId, terminal({ native_agent_codex_home: "/different" })).status, "conflict");
  assert.equal(proveNativeTerminalRoute(nativeId, terminal({ codex_home: "relative" })).status, "unavailable");
  const otherHome = createCodexNativeConversationId({ codexHome: "/different", threadId: thread });
  const result = associateConversationRoutes([terminal()], [native(), native({ id: otherHome, conversation_id: otherHome })]);
  assert.deepEqual(result.associations.map(item => item.nativeId), [nativeId]);
});

test("duplicate backend rows and multiple exact terminal aliases cannot silently select a fallback", () => {
  assert.equal(associateConversationRoutes([terminal()], [native(), native()]).unassociated[0].reason, "ambiguous_native_identity");
  const second = terminal({ id: "terminal:v2:herdr:codex:default:w1:p1:456", pid: 456,
    native_agent_process_uuid: "process-456", native_agent_process_birth: "2026-10-10T03:00:00Z" });
  assert.equal(associateConversationRoutes([terminal(), second], [native()]).associations.length, 2);
  assert.equal(resolveNativeTerminalRoute(nativeId, [terminal(), second]).status, "ambiguous");
  assert.equal(resolveNativeTerminalRoute(nativeId, [terminal()]).status, "exact");
});

test("offline native fallback proves current identity without granting replay or accepting malformed IDs", () => {
  assert.equal(associateConversationRoutes([terminal()], [native({ connection_state: "not_loaded" })]).associations.length, 0);
  assert.equal(proveNativeTerminalRoute(nativeId, terminal()).status, "exact");
  assert.equal(proveNativeTerminalRoute("codex-cli:v1:broken", terminal()).status, "unavailable");
  assert.equal(proveNativeTerminalRoute(nativeId, terminal({ native_agent_session_id: other })).status, "conflict");
  assert.equal(associateConversationRoutes([terminal()], [native({ native_thread_id: other })]).associations.length, 0);
  assert.equal(proveNativeTerminalRoute(nativeId, terminal({ agent: "claude" })).status, "unavailable");
});

test("stale managed ownership does not replace or veto independently resolved current thread identity", () => {
  const row = terminal({ management_conflict: { kind: "stale_process_incarnation" },
    managed: { current_turn: { native_thread_id: other } } });
  assert.equal(proveNativeTerminalRoute(nativeId, row).status, "exact");
  assert.equal(proveNativeTerminalRoute(nativeId, { ...row, native_agent_status_card_session_id: other }).status, "conflict");
});

test("a closed status inspection proves the thread after its visible status card has been dismissed", () => {
  const before = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  const observation = { status: "observed", inspection: "status", agent: "codex", terminal_id: before.id, native_thread_id: thread };
  const inspected = withClosedStatusInspection(before, { ...before }, observation);
  assert.equal(inspected.native_agent_status_card_session_id, undefined);
  assert.equal(associateConversationRoutes([inspected], [native()]).associations[0].evidence, "closed_status_inspection");
  assert.equal(proveNativeTerminalRoute(nativeId, inspected).status, "exact");
  assert.equal(associateConversationRoutes([before], [native()]).associations.length, 0);
});

test("closed inspection rejects changed process, wrong target, conflicting identity and lost readiness", () => {
  const before = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  const observation = { status: "observed", inspection: "status", agent: "codex", terminal_id: before.id, native_thread_id: thread };
  const changedTerminals = [{ pid: 999 }, { native_agent_process_uuid: "replacement" }, { native_agent_process_birth: "replacement" },
    { id: "terminal:v2:tmux:codex:other:0.0:123" }, { agent: "claude" }, { process_state: "stopped" },
    { native_agent_session_id: other }, { native_agent_status_card_session_id: other },
    { activity_state: "working" }, { approval_state: { blocked: true } }];
  for (const changed of changedTerminals) {
    assert.throws(() => withClosedStatusInspection(before, { ...before, ...changed }, observation), /no task input was sent/);
  }
  for (const changed of [{ status: "failed" }, { inspection: "models" }, { agent: "claude" },
    { terminal_id: "different-terminal" }, { native_thread_id: "not-a-uuid" }]) {
    assert.throws(() => withClosedStatusInspection(before, before, { ...observation, ...changed }), /no task input was sent/);
  }
  assert.throws(() => withClosedStatusInspection({ ...before, native_agent_process_birth: undefined }, before, observation), /no task input was sent/);
});
