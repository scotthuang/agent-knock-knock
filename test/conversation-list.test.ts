import test from "node:test";
import assert from "node:assert/strict";
import { unifiedConversationList } from "../src/conversation-list.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { createClaudeNativeConversationId } from "../src/claude-native-identity.js";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";
import { HOST_LIST_MAX_BYTES, HOST_LIST_MAX_WEIGHTED_CHARS, hostListWeightedChars } from "../src/semantic-tool-list-budget.js";

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

test("default List prefers the original verified backend without inventing a terminal alias", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    command: `codex resume ${thread}`, activity_state: "unknown", capabilities: { send: false, watch: false, model_options: true },
    available_actions: { model_options: { tool: "agent_knock_knock_model_options", arguments: { terminal_id: terminalId } } } });
  const backend = { ...native(), activity_state: "idle", native_turn_id: "backend-turn" };
  const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [backend] }, [physical]);
  assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId]);
  const selectedBackend = result.conversations[0];
  assert.equal(selectedBackend.surface, "cli");
  assert.equal(selectedBackend.activity_state, "idle");
  assert.equal(selectedBackend.title, backend.title);
  assert.equal(selectedBackend.native_thread_id, thread);
  assert.equal(selectedBackend.native_turn_id, "backend-turn");
  assert.deepEqual(selectedBackend.capabilities, backend.capabilities);
  assert.deepEqual(selectedBackend.available_actions, backend.available_actions);
  assert.deepEqual(selectedBackend.terminal_aliases, []);
  assert.deepEqual(selectedBackend.terminal_controls, []);
  assert.deepEqual(result.conversation_presentation, { mode: "default", workspace_grouped_connections: 1 });
  assert.equal(result.conversation_routing.exact_associations, 0);
  assert.equal(result.conversation_routing.unresolved_terminals, 1);
  assert.deepEqual((result as Record<string, unknown>).codex_cli_sessions, [backend]);
  assert.deepEqual((result as Record<string, unknown>).terminals, [physical]);
  const host = compactAkkListModelProjection(result) as Record<string, any>;
  assert.deepEqual(host.conversations.map((row: Record<string, unknown>) => row.conversation_id), [nativeId]);
  const hostBackend = host.conversations[0];
  assert.equal(hostBackend.capabilities.send, true);
  assert.equal(hostBackend.available_actions.send, true);
  assert.equal(hostBackend.native_thread_id, thread);
  assert.equal(hostBackend.scoped_controls, undefined, "No terminal action or alias is invented by workspace similarity");
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

test("busy and blocked preferred backends do not borrow an idle terminal's Send authority", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    capabilities: { send: true, model_options: true }, available_actions: {
      send: { tool: "agent_knock_knock_send", arguments: { terminal_id: terminalId, expected_terminal_token: "terminal-authority" } },
      model_options: { tool: "agent_knock_knock_model_options", arguments: { terminal_id: terminalId } }
    } });
  for (const activity_state of ["working", "blocked", "unknown"]) {
    const backend = { ...native(), activity_state, capabilities: { send: false, status: true },
      available_actions: { status: { tool: "agent_knock_knock_status", input: { conversation_id: nativeId } } } };
    const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [backend] }, [physical]);
    assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId]);
    assert.equal(result.conversations[0].activity_state, activity_state);
    assert.deepEqual(result.conversations[0].capabilities, backend.capabilities);
    assert.deepEqual(result.conversations[0].available_actions, backend.available_actions);
    assert.deepEqual(result.conversations[0].terminal_aliases, []);
    const host = compactAkkListModelProjection(result) as Record<string, any>;
    assert.equal(host.conversations[0].capabilities.send, false);
    assert.equal(host.conversations[0].available_actions.send, undefined);
    assert.equal(host.conversations[0].scoped_controls, undefined);
  }
});

test("terminal-owned management and interactions keep their exact entry and actions visible", () => {
  const close = { tool: "agent_knock_knock_close", input: { turn_id: "terminal-owned-turn" } };
  const base = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    available_actions: { close } });
  for (const attention of [
    { managed: { current_turn: { turn_id: "terminal-owned-turn", status: "active" } } },
    { managed: { recent_turn: { turn_id: "terminal-owned-turn", status: "completed", callback_delivery: { status: "uncertain" } } } },
    { managed: { history: [{ turn_id: "terminal-owned-turn", status: "closed", callback_delivery: { status: "failed" } }] } },
    { management_state: "conflict" }, { management_unavailable: { reason: "unavailable" } },
    { blocking_turns: [{ turn_id: "terminal-owned-turn" }] }, { handoff_state: "external_handoff_blocked" },
    { approval_state: { scanned: true, blocked: true } }, { approval_state: { approvable: true } },
    { interaction_state: { state: "pending" } }, { pending_interaction_count: 1 }
  ]) {
    // Attention can be added by ownership projection without appearing in the physical discovery row.
    const shown = { ...base, ...attention };
    const result = unifiedConversationList({ terminals: [shown], codex_cli_sessions: [native()] }, [base]);
    assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId, terminalId]);
    assert.equal((result.conversations[1].available_actions as Record<string, unknown>).close, close);
    assert.equal((result.conversations[0].available_actions as Record<string, unknown>).close, undefined);
    assert.equal(result.conversation_presentation.workspace_grouped_connections, 0);
  }
});

test("hidden terminal history is excluded from conversation List without mutating ownership", () => {
  const history = Array.from({ length: 90 }, (_, index) => ({ turn_id: `terminal-history-${index}`,
    status: "closed", callback_delivery: { status: "delivered" },
    available_actions: { status: { tool: "agent_knock_knock_status", input: { turn_id: `terminal-history-${index}` } } } }));
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    management_state: "managed", managed: { current_turn: null, recent_turn: history[0], history } });
  const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [native()] }, [physical]);
  assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId]);
  assert.equal(result.conversations[0].managed, undefined);
  const current = compactAkkListModelProjection(result) as Record<string, any>;
  assert.equal(current.managed_turns, undefined);
  assert.equal(current.pagination.total_available, 1);
  assert.throws(() => compactAkkListModelProjection(result, { listView: "history" }), /watches/u);
  assert.equal((physical.managed as { history: unknown[] }).history.length, history.length, "Projection does not mutate stored history");
});

test("known thread and Codex home conflicts keep separate default targets and exclude diagnostic grouping", () => {
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
    const diagnostics = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [native()] }, [physical], {}, { diagnostics: true });
    assert.deepEqual(diagnostics.conversation_presentation.workspace_groups, []);
  }
  const raw = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  const conflictingProjection = { ...raw, native_agent_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  assert.equal(unifiedConversationList({ terminals: [conflictingProjection], codex_cli_sessions: [native()] }, [raw])
    .conversation_presentation.workspace_grouped_connections, 0);
});

test("unverified or malformed backends do not replace a terminal and inactive terminals are not grouped", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  for (const backend of [
    { ...native(), connection_state: "not_loaded" }, { ...native(), conversation_id: "codex-cli:invalid" },
    { ...native(), native_thread_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
  ]) {
    const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [backend] }, [physical]);
    assert.equal(result.conversations.length, 2);
    assert.equal(result.conversation_presentation.workspace_grouped_connections, 0);
  }
  const inactive = { ...physical, process_state: "exited" };
  const result = unifiedConversationList({ terminals: [inactive], codex_cli_sessions: [native()] }, [inactive]);
  assert.equal(result.conversations.length, 2);
  assert.equal(result.conversation_presentation.workspace_grouped_connections, 0);
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

test("preferred CLI targets remain reachable through bounded Host List pages alongside ended Watch history", () => {
  const terminals: Record<string, unknown>[] = [], backends: Record<string, unknown>[] = [];
  for (let index = 0; index < 45; index++) {
    const threadId = `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;
    const id = createCodexNativeConversationId({ codexHome: home, threadId });
    const cwd = `/fixture/project-${index}`;
    terminals.push(terminal({ id: `terminal:v2:tmux:codex:fixture:${index}.0:${1000 + index}`, cwd, pid: 1000 + index,
      native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" }, activity_state: "unknown" }));
    backends.push({ ...native(), id, conversation_id: id, native_thread_id: threadId, cwd,
      available_actions: { send: { tool: "agent_knock_knock_send", input: { conversation_id: id } } } });
  }
  const result = unifiedConversationList({ terminals, codex_cli_sessions: backends,
    codex_cli_watches: Array.from({ length: 300 }, (_, index) => ({ watch_id: `codex-cli-watch:ended-${index}`,
      status: "completed", callback_state: "accepted", callback_expected: false })) }, terminals);
  assert.equal(result.conversation_routing.exact_associations, 0);
  const seen = new Set<string>();
  let params: Record<string, unknown> | null = {};
  let pageCount = 0;
  do {
    const page = compactAkkListModelProjection(result, params!) as Record<string, any>;
    const json = JSON.stringify(page);
    assert.doesNotThrow(() => JSON.parse(json));
    assert.ok(Buffer.byteLength(json) <= HOST_LIST_MAX_BYTES);
    assert.ok(hostListWeightedChars(json) <= HOST_LIST_MAX_WEIGHTED_CHARS);
    assert.equal(page.codex_cli_watches, undefined, "Watch inventory belongs to the separate command");
    for (const row of page.conversations) {
      assert.equal(seen.has(row.conversation_id), false);
      seen.add(row.conversation_id);
      if (row.conversation_id.startsWith("codex-cli:")) assert.equal(row.available_actions.send, true);
    }
    params = page.pagination.next_args;
    pageCount++;
  } while (params && pageCount < 50);
  assert.equal(params, null);
  assert.ok(pageCount > 1);
  assert.deepEqual(seen, new Set(backends.map(row => String(row.conversation_id))));
  assert.equal(result.conversation_presentation.workspace_grouped_connections, 45);
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

test("workspace preference normalizes paths but requires matching absolute project paths", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  const normalized = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [{ ...native(), cwd: "/project/sub/.." }] }, [physical]);
  assert.deepEqual(normalized.conversations.map(row => row.conversation_id), [nativeId]);
  const diagnostic = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [{ ...native(), cwd: "/project/sub/.." }] }, [physical], {}, { diagnostics: true });
  assert.deepEqual(diagnostic.conversation_presentation.workspace_groups, [{ terminal_conversation_id: terminalId, native_conversation_id: nativeId }]);
  for (const cwd of [undefined, "project", "/other", "/project\n"]) {
    const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [{ ...native(), cwd }] }, [physical]);
    assert.equal(result.conversations.length, 2);
  }
});

test("Claude workspace preference also requires the registry process and rejects birth or session conflicts", () => {
  const processStart = "Mon Oct 12 01:02:03 2026";
  const claudeId = createClaudeNativeConversationId({ configDir: "/fixture/claude", sessionId: thread, pid: 123, processStart });
  const backend = { conversation_id: claudeId, source: "claude_cli", agent: "claude", cwd: "/project",
    pid: 123, native_thread_id: thread, connection_state: "native_registry_verified", capabilities: { send: true } };
  const physical = terminal({ id: "terminal:v2:tmux:claude:akk:0.0:123", agent: "claude",
    native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" }, native_agent_process_birth: undefined });
  const grouped = unifiedConversationList({ terminals: [physical], claude_cli_sessions: [backend] }, [physical]);
  assert.deepEqual(grouped.conversations.map(row => row.conversation_id), [claudeId]);
  assert.deepEqual(grouped.conversations[0].terminal_aliases, []);
  assert.deepEqual(grouped.conversations[0].terminal_controls, []);
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

function unstartedFixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const emptyThread = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const emptyId = createCodexNativeConversationId({ codexHome: home, threadId: emptyThread });
  return { ...native(), id: emptyId, conversation_id: emptyId, native_thread_id: emptyThread, title: "",
    unstarted_thread: true, history_state: "unmaterialized", native_turn_id: null, latest_turn: null,
    activity_state: "idle", active_flags: [], pending_interaction_count: null, attention_required: false, interaction_state: [],
    available_actions: { status: { tool: "agent_knock_knock_status", input: { conversation_id: emptyId } },
      send: { tool: "agent_knock_knock_send", input: { conversation_id: emptyId } } }, ...extra };
}

function establishedFixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...native(), native_turn_id: "existing-task", latest_turn: { id: "existing-task", status: "completed" },
    activity_state: "idle", ...extra };
}

test("default List folds a provably unstarted same-project candidate without changing routes or native inventory", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" } });
  const real = establishedFixture(), empty = unstartedFixture();
  const input = { terminals: [physical], codex_cli_sessions: [real, empty] };
  const before = structuredClone(input);
  const result = unifiedConversationList(input, [physical]);
  assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId]);
  assert.deepEqual(result.conversation_presentation, { mode: "default", workspace_grouped_connections: 1,
    unstarted_candidates_count: 1, unstarted_candidates_omitted: 1,
    diagnostic_query: { tool: "agent_knock_knock_list", arguments: { terminalDebug: true } } });
  assert.deepEqual(result.conversations[0].terminal_aliases, []);
  assert.deepEqual(result.conversations[0].terminal_controls, []);
  assert.equal(result.conversation_routing.exact_associations, 0);
  assert.equal(result.conversation_routing.unresolved_terminals, 1);
  assert.deepEqual(result.conversations[0].available_actions, real.available_actions);
  assert.deepEqual(input, before, "Presentation does not mutate native rows, capability or exact Send targets");
  assert.equal((result as Record<string, any>).codex_cli_sessions[1], empty);

  const diagnostic = unifiedConversationList(input, [physical], {}, { diagnostics: true });
  assert.deepEqual(diagnostic.conversations.map(row => row.conversation_id), [nativeId, empty.conversation_id, terminalId]);
  const shown = diagnostic.conversations.find(row => row.conversation_id === empty.conversation_id)!;
  assert.equal(shown.classification, "unstarted_candidate");
  assert.equal(shown.frontend_presence, "unverified");
  assert.deepEqual(shown.available_actions, empty.available_actions);
  assert.deepEqual(shown.capabilities, empty.capabilities);
  assert.equal(diagnostic.conversation_presentation.unstarted_candidates_omitted, 0);
  assert.equal(diagnostic.conversation_presentation.unstarted_candidates_count, 1);
});

test("unstarted display folding requires a positive empty snapshot and never suppresses actionable or uncertain rows", () => {
  const real = establishedFixture();
  for (const evidence of [
    { unstarted_thread: undefined }, { unstarted_thread: false }, { history_state: undefined },
    { history_state: "materialized" }, { native_turn_id: undefined }, { native_turn_id: "started" },
    { latest_turn: undefined }, { latest_turn: { id: "started" } }, { activity_state: "active" }, { activity_state: "unknown" },
    { observation_error: "read_failed" }, { active_flags: ["waitingOnApproval"] }, { attention_required: true },
    { pending_interaction_count: 1 }, { pending_async_count: 1 }, { pending_manual_count: 1 },
    { interaction_state: [{ id: "question" }] }, { approval_state: { blocked: true } },
    { managed: { current_turn: { turn_id: "owned", status: "active" } } },
    { managed: { recent_turn: { turn_id: "owned", status: "completed", callback_delivery: { status: "uncertain" } } } },
    { management_state: "conflict" }, { handoff_state: "blocked" }, { blocking_turns: [{ turn_id: "owned" }] }
  ]) {
    const empty = unstartedFixture(evidence);
    const result = unifiedConversationList({ codex_cli_sessions: [real, empty] }, []);
    assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId, empty.conversation_id], JSON.stringify(evidence));
    assert.equal(result.conversation_presentation.unstarted_candidates_omitted, undefined);
  }
});

test("empty-only CLI sessions remain selectable and a first task restores normal same-project display", () => {
  const empty = unstartedFixture();
  const alone = unifiedConversationList({ codex_cli_sessions: [empty] }, []);
  assert.equal(alone.conversations[0].conversation_id, empty.conversation_id);
  assert.deepEqual(alone.conversations[0].available_actions, empty.available_actions);
  assert.equal(alone.conversation_presentation.unstarted_candidates_count, undefined);
  const first = terminal(), real = establishedFixture();
  const before = unifiedConversationList({ terminals: [first], codex_cli_sessions: [real, empty] }, [first]);
  assert.deepEqual(before.conversations.map(row => row.conversation_id), [nativeId]);
  const started = { ...empty, unstarted_thread: false, history_state: "materialized", native_turn_id: "new-task",
    latest_turn: { id: "new-task", status: "inProgress" }, activity_state: "active" };
  const after = unifiedConversationList({ terminals: [first], codex_cli_sessions: [real, started] }, [first]);
  assert.deepEqual(after.conversations.map(row => row.conversation_id), [nativeId, empty.conversation_id]);
  assert.equal(after.conversation_presentation.unstarted_candidates_count, undefined);
});

test("real multiple same-project tasks and multiple physical CLI sessions prevent empty candidate folding", () => {
  const real = establishedFixture(), empty = unstartedFixture();
  const otherThread = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const otherId = createCodexNativeConversationId({ codexHome: home, threadId: otherThread });
  const other = establishedFixture({ id: otherId, conversation_id: otherId, native_thread_id: otherThread });
  const many = unifiedConversationList({ codex_cli_sessions: [real, other, empty] }, []);
  assert.deepEqual(many.conversations.map(row => row.conversation_id), [nativeId, otherId, empty.conversation_id]);
  const first = terminal({ native_agent_session_id: undefined });
  const second = terminal({ id: "terminal:v2:tmux:codex:other:0.0:456", pid: 456, native_agent_session_id: undefined });
  const physical = unifiedConversationList({ terminals: [first, second], codex_cli_sessions: [real, empty] }, [first, second]);
  assert.equal(physical.conversations.length, 4);
  assert.equal(physical.conversation_presentation.unstarted_candidates_count, undefined);
});

test("an exact terminal attached to an empty thread keeps that new session visible", () => {
  const empty = unstartedFixture(), real = establishedFixture();
  for (const cwd of ["/project", "/other-project"]) {
    const physical = terminal({ native_agent_session_id: empty.native_thread_id, cwd });
    const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [real, empty] }, [physical]);
    assert.deepEqual(result.conversations.map(row => row.conversation_id), [nativeId, empty.conversation_id]);
    assert.deepEqual(result.conversations[1].terminal_aliases, [terminalId]);
    assert.equal(result.conversation_presentation.unstarted_candidates_count, undefined);
  }
  for (const evidence of ["native_agent_status_card_session_id", "_routing_inspection_thread_id"]) {
    const physical = terminal({ native_agent_session_id: undefined, [evidence]: empty.native_thread_id,
      activity_state: "unknown", native_agent_identity_observation: { status: "verified_absent" } });
    const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [real, empty] }, [physical]);
    assert.equal(result.conversations.some(row => row.conversation_id === empty.conversation_id), true);
    assert.equal(result.conversation_presentation.unstarted_candidates_count, undefined);
  }
});

test("empty candidates require matching canonical project and Codex home without malformed identity or conflicts", () => {
  const real = establishedFixture();
  const empty = unstartedFixture();
  const foreignHome = "/fixture/other-codex";
  const foreignId = createCodexNativeConversationId({ codexHome: foreignHome, threadId: String(empty.native_thread_id) });
  for (const evidence of [
    { cwd: "/other-project" }, { cwd: "project" }, { cwd: "/project\n" },
    { id: foreignId, conversation_id: foreignId }, { conversation_id: "codex-cli:invalid" },
    { native_thread_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, { connection_state: "not_loaded" }
  ]) {
    const candidate = { ...empty, ...evidence };
    const result = unifiedConversationList({ codex_cli_sessions: [real, candidate] }, []);
    assert.equal(result.conversations.length, 2, JSON.stringify(evidence));
    assert.equal(result.conversation_presentation.unstarted_candidates_count, undefined);
  }
  const normalized = unifiedConversationList({ codex_cli_sessions: [real, { ...empty, cwd: "/project/sub/.." }] }, []);
  assert.deepEqual(normalized.conversations.map(row => row.conversation_id), [nativeId]);
  for (const evidence of [
    { codex_home: foreignHome }, { native_agent_session_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
    { approval_state: { blocked: true } }, { managed: { current_turn: { turn_id: "terminal-work" } } }
  ]) {
    const physical = terminal({ native_agent_session_id: undefined, ...evidence });
    const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [real, empty] }, [physical]);
    assert.equal(result.conversations.some(row => row.conversation_id === empty.conversation_id), true);
    assert.equal(result.conversation_presentation.unstarted_candidates_count, undefined);
  }
});
