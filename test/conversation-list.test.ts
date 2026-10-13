import test from "node:test";
import assert from "node:assert/strict";
import { unifiedConversationList } from "../src/conversation-list.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { createClaudeNativeConversationId } from "../src/claude-native-identity.js";

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
  assert.deepEqual(result.conversations.slice(1), desktops.map(row => ({ ...row, route_preference: "desktop_ipc", surface: "desktop" })));
  assert.equal(result.conversations[0].surface, "cli");
  assert.equal(result.conversation_routing.exact_associations, 1);
  assert.equal(result.conversation_routing.unresolved_terminals, 0);
});

test("exact aliases advertise the selected backend Send and Watch while preserving terminal-only actions", () => {
  const special = { tool: "agent_knock_knock_model_options", arguments: { terminal_id: terminalId, expected_binding_token: "authority" } };
  const physical = terminal({ capabilities: { send: true, watch: true, cancel: true }, available_actions: {
    send: { tool: "agent_knock_knock_send", arguments: { terminal_id: terminalId, expected_terminal_token: "old" } },
    watch: { tool: "agent_knock_knock_watch", arguments: { terminal_id: terminalId } }, model_options: special,
    permission_options: { tool: "agent_knock_knock_permission_options", arguments: { terminal_id: terminalId } }
  } });
  for (const send of [true, false]) {
    const row = { ...native(), capabilities: { send, watch: false },
      available_actions: send ? native().available_actions : {} };
    const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [row] }, [physical]);
    const alias = (result.conversations[0].terminal_controls as Record<string, any>[])[0];
    assert.equal(alias.capabilities.send, send); assert.equal(alias.capabilities.watch, false);
    assert.equal(alias.capabilities.cancel, true); assert.equal(alias.available_actions.watch, undefined);
    assert.deepEqual(alias.available_actions.send, send ? native().available_actions.send : undefined);
    assert.equal(alias.available_actions.model_options, special); assert.ok(alias.available_actions.permission_options);
    const actions = result.conversations[0].available_actions as Record<string, unknown>;
    assert.equal(actions.model_options, special);
    assert.equal(actions.permission_options, undefined);
    assert.deepEqual(result.conversations[0].capabilities, { send, watch: false, model_options: true });
  }
  // Legacy physical diagnostics retain their own offers; only exact routed controls are projected.
  assert.equal((physical.available_actions as Record<string, any>).send.arguments.expected_terminal_token, "old");
  const unavailable = unifiedConversationList({ terminals: [physical],
    codex_cli_sessions: [{ ...native(), connection_state: "not_loaded" }] }, [physical]);
  assert.deepEqual(unavailable.conversations[0].terminal_controls, []);
  const separate = unavailable.conversations[1].available_actions as Record<string, any>;
  assert.equal(separate.send.input.conversation_id, terminalId);
  assert.ok(separate.permission_options);
});

test("one CLI workspace entry preserves terminal identity and authority without promoting a same-cwd backend candidate", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    command: `codex resume ${thread}`, activity_state: "working", capabilities: { send: false, watch: false },
    available_actions: { status: { tool: "agent_knock_knock_status", arguments: { terminal_id: terminalId } } } });
  const backend = native();
  const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [backend] }, [physical]);
  assert.deepEqual(result.conversations.map(row => row.conversation_id), [terminalId]);
  const shown = result.conversations[0];
  assert.equal(shown.surface, "cli");
  assert.equal(shown.activity_state, "working");
  assert.deepEqual(shown.capabilities, { send: false, watch: false });
  assert.deepEqual(shown.available_actions, { status: { tool: "agent_knock_knock_status", input: { conversation_id: terminalId } } });
  assert.equal(shown.terminal_aliases, undefined);
  assert.equal(shown.native_thread_id, undefined);
  assert.equal(shown.route_status, "identity_unresolved");
  assert.equal(shown.route_preference, "codex_backend");
  assert.deepEqual(result.conversation_presentation, { mode: "default", workspace_grouped_connections: 1 });
  assert.equal(result.conversation_routing.exact_associations, 0);
  assert.equal(result.conversation_routing.unresolved_terminals, 1);
  assert.deepEqual((result as Record<string, unknown>).codex_cli_sessions, [backend]);
  assert.deepEqual((result as Record<string, unknown>).terminals, [physical]);
});

test("diagnostics retains both unresolved CLI connections and their display-only grouping candidate", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [native()] }, [physical], {}, { diagnostics: true });
  assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId, terminalId]);
  assert.deepEqual(result.conversations[0].terminal_aliases, []);
  assert.deepEqual(result.conversation_presentation, { mode: "diagnostics", workspace_grouped_connections: 0,
    workspace_groups: [{ terminal_conversation_id: terminalId, native_conversation_id: nativeId }] });
  assert.equal(result.conversation_routing.exact_associations, 0);
});

test("known thread and Codex home conflicts prevent workspace display grouping", () => {
  for (const evidence of [
    { native_agent_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { native_agent_status_card_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { codex_home: "/different-home" },
    { native_agent_codex_home: "/different-home" }
  ]) {
    const physical = terminal({ native_agent_session_id: undefined,
      native_agent_identity_observation: { status: "verified_absent" }, ...evidence });
    const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [native()] }, [physical]);
    assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId, terminalId]);
    assert.equal(result.conversation_presentation.workspace_grouped_connections, 0);
  }
});

test("multiple same-workspace CLI connections stay individually selectable instead of being paired arbitrarily", () => {
  const first = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  const second = { ...first, id: "terminal:v2:herdr:codex:default:w1:p1:456", pid: 456 };
  const secondThread = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const secondId = createCodexNativeConversationId({ codexHome: home, threadId: secondThread });
  const secondNative = { ...native(), id: secondId, conversation_id: secondId, native_thread_id: secondThread };
  const cases: Array<[Record<string, unknown>[], Record<string, unknown>[]]> =
    [[[first, second], [native()]], [[first], [native(), secondNative]]];
  for (const [terminals, natives] of cases) {
    const result = unifiedConversationList({ terminals, codex_cli_sessions: natives }, terminals);
    assert.equal(result.conversations.length, terminals.length + natives.length);
    assert.equal(result.conversation_presentation.workspace_grouped_connections, 0);
    for (const physical of terminals) assert.ok(result.conversations.some(row => row.conversation_id === physical.id));
    for (const backend of natives) assert.ok(result.conversations.some(row => row.conversation_id === backend.conversation_id));
  }
});

test("workspace presentation retains backend-only CLI sessions and never groups different agents", () => {
  const only = unifiedConversationList({ codex_cli_sessions: [native()] }, []);
  assert.deepEqual(only.conversations.map(row => [row.conversation_id, row.surface]), [[nativeId, "cli"]]);
  const claude = terminal({ id: "terminal:v2:herdr:claude:default:w1:p4:999", agent: "claude", pid: 999,
    native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  const mixed = unifiedConversationList({ terminals: [claude], codex_cli_sessions: [native()] }, [claude]);
  assert.equal(mixed.conversations.length, 2);
  assert.equal(mixed.conversation_presentation.workspace_grouped_connections, 0);
});

test("workspace grouping normalizes absolute paths but does not guess missing or relative directories", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  const normalized = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [{ ...native(), cwd: "/project/sub/.." }] }, [physical]);
  assert.equal(normalized.conversations.length, 1);
  for (const cwd of [undefined, "project", "/other", "/project\n"]) {
    const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [{ ...native(), cwd }] }, [physical]);
    assert.equal(result.conversations.length, 2);
  }
});

test("Claude workspace display grouping requires a matching process and rejects a different live CLI in the same cwd", () => {
  const processStart = "Mon Oct 12 01:02:03 2026";
  const claudeId = createClaudeNativeConversationId({ configDir: "/fixture/claude", sessionId: thread, pid: 123, processStart });
  const backend = { conversation_id: claudeId, source: "claude_cli", agent: "claude", cwd: "/project",
    pid: 123, native_thread_id: thread, connection_state: "native_registry_verified", capabilities: { send: true } };
  const physical = terminal({ id: "terminal:v2:tmux:claude:akk:0.0:123", agent: "claude",
    native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" }, native_agent_process_birth: undefined });
  const grouped = unifiedConversationList({ terminals: [physical], claude_cli_sessions: [backend] }, [physical]);
  assert.deepEqual(grouped.conversations.map(row => row.conversation_id), [physical.id]);
  assert.equal(grouped.conversation_routing.exact_associations, 0);
  for (const changes of [{ pid: 456 }, { native_agent_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { native_agent_process_birth: "Wed Oct 14 01:02:03 2026" }]) {
    const conflicting = { ...physical, ...changes };
    const result = unifiedConversationList({ terminals: [conflicting], claude_cli_sessions: [backend] }, [conflicting]);
    assert.equal(result.conversations.length, 2);
    assert.equal(result.conversation_presentation.workspace_grouped_connections, 0);
  }
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
  const first = terminal({ available_actions: { model_options: { tool: "agent_knock_knock_model_options", arguments: { terminal_id: terminalId } } } });
  const second = terminal({ id: "terminal:v2:herdr:codex:default:w1:p1:456", pid: 456,
    native_agent_process_uuid: "process-456", native_agent_process_birth: "2026-10-10T02:00:00Z" });
  const result = unifiedConversationList({ terminals: [first, second], codex_cli_sessions: [native()] }, [first, second]);
  assert.equal(result.conversations.length, 1);
  assert.deepEqual(result.conversations[0].terminal_aliases, [first.id, second.id]);
  assert.equal(result.conversation_routing.exact_associations, 2);
  assert.equal((result.conversations[0].available_actions as Record<string, unknown>).model_options, undefined);
});

test("a single exact CLI keeps special action targets without borrowing blocked backend operations", () => {
  const modelAction = { tool: "agent_knock_knock_model_options", arguments: { terminal_id: terminalId, expected_binding_token: "authority" } };
  const closeAction = { tool: "agent_knock_knock_close", input: { turn_id: "original-managed-turn" } };
  const cancelAction = { tool: "agent_knock_knock_cancel", arguments: { conversation_id: terminalId } };
  const terminalActions = { model_options: modelAction, close: closeAction, cancel: cancelAction,
    send: { tool: "agent_knock_knock_send", arguments: { terminal_id: terminalId } },
    watch: { tool: "agent_knock_knock_watch", arguments: { terminal_id: terminalId } },
    approve: { tool: "agent_knock_knock_approve", arguments: { terminal_id: terminalId } },
    identify_and_send: { tool: "agent_knock_knock_identify_and_send", arguments: { terminal_id: terminalId } } };
  const physical = terminal({ available_actions: terminalActions });
  const nativeCancel = { tool: "native-cancel", input: { conversation_id: nativeId } };
  const backend = { ...native(), capabilities: { send: false, watch: false }, available_actions: { cancel: nativeCancel } };
  const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [backend] }, [physical]);
  assert.deepEqual(result.conversations[0].available_actions, { cancel: nativeCancel, model_options: modelAction, close: closeAction });
  assert.deepEqual(result.conversations[0].capabilities, { ...backend.capabilities, model_options: true, close: true });
});

test("an exact Claude connection keeps advertised terminal approvals and managed controls with original targets", () => {
  const processStart = "Mon Oct 12 01:02:03 2026";
  const claudeId = createClaudeNativeConversationId({ configDir: "/fixture/claude", sessionId: thread, pid: 123, processStart });
  const [weekday, month, day, year, time] = new Date(`${processStart} GMT`).toString().split(" ");
  const birth = [weekday, month, day, time, year].join(" ");
  const physical = terminal({ id: "terminal:v2:tmux:claude:akk:0.0:123", agent: "claude", native_agent_process_birth: birth,
    available_actions: {
      approve: { tool: "agent_knock_knock_approve", arguments: { turn_id: "claude-managed-turn" } },
      native_inspect: { tool: "agent_knock_knock_native_inspect", arguments: { terminal_id: "terminal:v2:tmux:claude:akk:0.0:123" } },
      send: { tool: "agent_knock_knock_send", arguments: { terminal_id: "terminal:v2:tmux:claude:akk:0.0:123" } }
    } });
  const backend = { conversation_id: claudeId, source: "claude_cli", agent: "claude", cwd: "/project",
    pid: 123, native_thread_id: thread, connection_state: "native_registry_verified", capabilities: { send: false, approve: false },
    available_actions: { status: { tool: "agent_knock_knock_status", input: { conversation_id: claudeId } } } };
  const result = unifiedConversationList({ terminals: [physical], claude_cli_sessions: [backend] }, [physical]);
  assert.equal(result.conversation_routing.exact_associations, 1);
  const actions = result.conversations[0].available_actions as Record<string, unknown>;
  const original = physical.available_actions as Record<string, unknown>;
  assert.equal(actions.approve, original.approve);
  assert.equal(actions.native_inspect, original.native_inspect);
  assert.equal(actions.send, undefined);
  assert.equal(actions.status, backend.available_actions.status);
  assert.deepEqual(result.conversations[0].capabilities, { ...backend.capabilities, approve: true, native_inspect: true });
  assert.equal(backend.capabilities.approve, false, "Original connection diagnostics keep their native scope");
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
