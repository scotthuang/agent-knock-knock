import test from "node:test";
import assert from "node:assert/strict";
import { unifiedConversationList } from "../src/conversation-list.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";

const home = "/fixture/codex", thread = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nativeId = createCodexNativeConversationId({ codexHome: home, threadId: thread });
const terminalId = "terminal:v2:tmux:codex:akk:0.0:123";
function terminal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: terminalId, source: "terminal", agent: "codex", process_state: "active", pid: 123,
    native_agent_session_id: thread, native_agent_identity_observation: { status: "resolved" },
    native_agent_process_uuid: "process-123", native_agent_process_birth: "2026-10-10T01:00:00Z",
    codex_home: home, activity_state: "idle", cwd: "/project", ...extra };
}
function native() {
  return { id: nativeId, conversation_id: nativeId, source: "codex_cli", agent: "codex", native_thread_id: thread,
    connection_state: "loaded_backend_verified", cwd: "/project", title: "Coding", capabilities: { send: true, watch: false },
    available_actions: { send: { tool: "agent_knock_knock_send", input: { conversation_id: nativeId } } } };
}

test("unified List coalesces exact terminal/backend identity and preserves every Desktop sidebar row", () => {
  const physical = terminal();
  const desktops = [
    { conversation_id: "desktop:v1:one", title: "Project one", source: "codex_desktop", sidebar_section: "project",
      sidebar_project_id: "project-one", connection_state: "live_owner_verified", capabilities: { send: true } },
    { conversation_id: "desktop:v1:two", title: "Project two", source: "codex_desktop", sidebar_section: "project",
      sidebar_project_id: "project-two", connection_state: "unconfirmed", can_send_reason: "no_live_owner",
      capabilities: { send: false, watch: false, status: true },
      available_actions: { status: { tool: "agent_knock_knock_status", input: { conversation_id: "desktop:v1:two" } } } }
  ];
  const result = unifiedConversationList({ terminals: [{ id: terminalId, agent: "codex" }],
    codex_cli_sessions: [native()], desktop_sessions: desktops }, [physical]);
  assert.equal(result.conversations.length, 3);
  assert.deepEqual(result.conversations[0].terminal_aliases, [terminalId]);
  assert.equal(result.conversations[0].conversation_id, nativeId);
  assert.equal(result.conversations[0].route_preference, "codex_backend");
  assert.deepEqual(result.conversations.slice(1), desktops.map(row => ({ ...row, route_preference: "desktop_ipc" })));
  assert.equal(result.conversation_routing.exact_associations, 1);
  assert.equal(result.conversation_routing.unresolved_terminals, 0);
});

test("same cwd or matching launch resume UUID does not hide an unresolved terminal beside a loaded backend", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    command: `codex resume ${thread}` });
  const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [native()] }, [physical]);
  assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId, terminalId]);
  assert.deepEqual(result.conversations[0].terminal_aliases, []);
  assert.equal(result.conversations[1].route_status, "identity_unresolved");
  assert.equal(result.conversations[1].route_preference, "codex_backend");
  assert.equal(result.conversation_routing.exact_associations, 0);
  assert.equal(result.conversation_routing.unresolved_terminals, 1);
});

test("terminal conversation actions use canonical conversation_id without changing legacy endpoint actions", () => {
  const actions = Object.fromEntries(["send", "status", "watch", "native_inspect", "permission_options", "model_options"].map(name => [name,
    { tool: `agent_knock_knock_${name}`, arguments: { terminal_id: terminalId, expected_terminal_token: "PRIVATE" } }]));
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    available_actions: actions });
  const result = unifiedConversationList({ terminals: [physical] }, [physical]);
  const canonical = result.conversations[0].available_actions as Record<string, unknown>;
  for (const name of ["send", "status", "watch", "native_inspect", "permission_options", "model_options"]) {
    assert.deepEqual(canonical[name], { tool: `agent_knock_knock_${name}`, input: { conversation_id: terminalId,
      ...(name === "native_inspect" ? { inspection: "status" } : {}) } });
  }
  assert.equal(JSON.stringify(canonical).includes("PRIVATE"), false);
  assert.equal((physical.available_actions as typeof actions).send.arguments.expected_terminal_token, "PRIVATE");
});

test("multiple exact physical aliases share one backend conversation and keep their distinct terminal IDs", () => {
  const first = terminal();
  const second = terminal({ id: "terminal:v2:herdr:codex:default:w1:p1:456", pid: 456,
    native_agent_process_uuid: "process-456", native_agent_process_birth: "2026-10-10T02:00:00Z" });
  const result = unifiedConversationList({ terminals: [first, second], codex_cli_sessions: [native()] }, [first, second]);
  assert.equal(result.conversations.length, 1);
  assert.deepEqual(result.conversations[0].terminal_aliases, [first.id, second.id]);
  assert.equal(result.conversation_routing.exact_associations, 2);
});

test("Claude terminal-only conversation remains visible alongside Codex and disabled Desktop", () => {
  const claude = terminal({ id: "terminal:v2:herdr:claude:default:w1:p4:999", agent: "claude", pid: 999 });
  const desktop = { conversation_id: "desktop:v1:offline", source: "codex_desktop", capabilities: { send: false } };
  const result = unifiedConversationList({ terminals: [claude], codex_cli_sessions: [native()], desktop_sessions: [desktop] }, [claude]);
  assert.equal(result.conversations[1].route_status, "terminal_only");
  assert.equal(result.conversations[1].conversation_id, claude.id);
  assert.equal(result.conversation_routing.unresolved_terminals, 0);
  assert.deepEqual(result.conversations[2].capabilities, { send: false });
});
