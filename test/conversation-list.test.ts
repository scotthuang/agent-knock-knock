import test from "node:test";
import assert from "node:assert/strict";
import { unifiedConversationList, withExactTerminalActions } from "../src/conversation-list.js";
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

test("exact frontend versions remain distinct from a newer backend", () => {
  for (const frontend of ["0.162.1", "0.164.0", "0.165.0"]) {
    const physical = terminal({ agent_version: frontend });
    const result = unifiedConversationList({ terminals: [physical],
      codex_cli_sessions: [{ ...native(), backend_version: "0.165.0" }] }, [physical]);
    const row = result.conversations[0];
    assert.equal(row.agent_version, frontend);
    assert.equal(row.backend_version, "0.165.0");
    assert.equal((compactAkkListModelProjection(result) as any).conversations[0].agent_version, frontend);
  }
  const unproven = terminal({ agent_version: "0.162.1", native_agent_session_id: undefined,
    native_agent_identity_observation: { status: "verified_absent" } });
  const row = unifiedConversationList({ terminals: [unproven],
    codex_cli_sessions: [{ ...native(), backend_version: "0.165.0" }] }, [unproven]).conversations[0];
  assert.equal(row.agent_version, undefined, "workspace grouping never proves the frontend version");
});

test("folder trust removes stale physical actions after promotion while preserving native reads and record recovery", () => {
  const inputNames = ["send", "approve", "respond_interaction", "set_permissions", "model_options", "set_model", "cancel",
    "new_thread", "clear_thread", "resume_thread", "list_resumable_threads", "identify_foreground", "repair_model_control", "retry_submission"];
  const physicalInputNames = [...inputNames, "native_inspect", "permission_options"];
  const recordAction = (name: string, target = "managed-turn") => ({ tool: `agent_knock_knock_${name}`, arguments: { turn_id: target } });
  const physicalActions = Object.fromEntries(physicalInputNames.map(name => [name,
    { tool: `agent_knock_knock_${name}`, arguments: { terminal_id: terminalId, expected_binding_token: "stale-binding" } }]));
  const physical = terminal({ agent_version: "0.165.0", activity_state: "blocked",
    approval_state: { scanned: true, blocked: true, approvable: false, prompt_kind: "folder_trust" },
    capabilities: Object.fromEntries([...physicalInputNames, "status", "watch", "close"].map(name => [name, true])),
    available_actions: { ...physicalActions, status: { tool: "agent_knock_knock_status" }, close: recordAction("close") } });
  const safeNames = ["status", "watch", "native_inspect", "permission_options", "close", "recover", "renew", "retry_callback", "unwatch"];
  const safeActions = Object.fromEntries(safeNames.map(name => [name, name === "close" ? recordAction(name, "native-watch")
    : { tool: `agent_knock_knock_${name}`, input: { conversation_id: nativeId } }]));
  const backend = { ...native(), activity_state: "idle", backend_version: "0.165.0",
    capabilities: { ...Object.fromEntries([...safeNames, ...inputNames].map(name => [name, true])), interaction_respond: true },
    available_actions: { ...physicalActions, ...safeActions },
    interaction_state: [{ available_actions: { approve: physicalActions.approve, respond_interaction: physicalActions.respond_interaction } }] };
  const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [backend] }, [physical]);
  const row = result.conversations[0] as any;
  assert.equal(result.conversations.length, 1);
  assert.equal(row.activity_state, "blocked"); assert.equal(row.backend_activity_state, "idle");
  assert.equal(row.capabilities.send, false); assert.equal(row.capabilities.approve, false);
  assert.equal(row.capabilities.interaction_respond, false); assert.equal(row.capabilities.set_permissions, false);
  assert.equal(row.capabilities.status, true); assert.equal(row.capabilities.watch, true);
  assert.equal(row.available_actions.send, undefined);
  assert.equal(row.terminal_controls[0].available_actions.send, undefined);
  for (const name of inputNames) {
    assert.equal(row.available_actions[name], undefined, `${name} cannot be promoted or remain on the native row`);
    assert.equal(row.capabilities[name], false);
  }
  for (const name of physicalInputNames) {
    assert.equal(row.terminal_controls[0].available_actions[name], undefined, `${name} cannot remain scoped to a blocked terminal`);
    assert.equal(row.terminal_controls[0].capabilities[name], false);
  }
  for (const name of safeNames) assert.deepEqual(row.available_actions[name], safeActions[name], `${name} stays on its existing native/record route`);
  assert.deepEqual(row.interaction_state[0].available_actions, {});
  assert.deepEqual(row.terminal_controls[0].available_actions.close, recordAction("close"));
  assert.equal(row.terminal_controls[0].available_actions.watch, safeActions.watch);
  assert.equal(withExactTerminalActions(row).backend_activity_state, "idle", "repeated Status projection keeps the actual backend state");
  const compact = (compactAkkListModelProjection(result) as any).conversations[0];
  assert.equal(compact.approval_state.prompt_kind, "folder_trust");
  assert.equal(compact.approval_state.approvable, false);
  assert.equal(compact.available_actions?.send, undefined);
  assert.match(compact.usage.summary, /folder access decision/);
  assert.doesNotMatch(compact.usage.summary, /Ready to receive/);
  assert.match(compact.usage.next_steps.join(" "), /yourself.*original terminal/);
  for (const name of inputNames) assert.equal(compact.available_actions?.[name], undefined);
  assert.deepEqual(Object.keys(compact.scoped_controls[0].available_actions), ["close"], "scoped projection retains record close, never physical input");
  for (const name of ["status", "watch", "native_inspect", "permission_options"]) assert.equal(compact.available_actions[name], true);
  assert.ok((physical.available_actions as Record<string, unknown>).send, "projection does not mutate the raw diagnostic evidence");
});

test("folder trust projection rejects prepromoted physical reads and lifecycle close without suppressing unrelated prompts", () => {
  const inputActions = Object.fromEntries(["native_inspect", "permission_options", "model_options"].map(name => [name,
    { tool: `agent_knock_knock_${name}`, arguments: { terminal_id: terminalId } }]));
  const lifecycleClose = { tool: "agent_knock_knock_close", arguments: { conversation_id: terminalId, expected_transition_id: "transition" } };
  const blocked = terminal({ approval_state: { blocked: true, approvable: false, prompt_kind: "folder_trust" },
    available_actions: { ...inputActions, close: lifecycleClose }, capabilities: { native_inspect: true, permission_options: true } });
  const row = withExactTerminalActions({ ...native(), available_actions: { ...inputActions, close: lifecycleClose },
    terminal_controls: [blocked, terminal({ id: "terminal:v2:tmux:codex:other:0.0:124" })] }) as any;
  assert.deepEqual(row.available_actions, {}, "multiple aliases cannot leave already promoted physical operations");
  assert.deepEqual(row.terminal_controls[0].available_actions, {});
  assert.equal(row.capabilities.native_inspect, false);
  assert.equal(row.capabilities.permission_options, false);
  const otherPrompt = { ...blocked, approval_state: { blocked: true, approvable: false, prompt_kind: "unknown" } };
  const unchanged = withExactTerminalActions({ ...native(), terminal_controls: [otherPrompt] }) as any;
  assert.deepEqual(unchanged.available_actions.send, native().available_actions.send);
  assert.equal(unchanged.capabilities.send, true, "this policy is limited to an identified Folder access modal");
  assert.equal(unchanged.available_actions.model_options, inputActions.model_options);
});

test("an unassociated folder decision stays visible without being assigned to another same-directory backend", () => {
  const physical = terminal({ native_agent_session_id: undefined, native_agent_identity_observation: { status: "verified_absent" },
    activity_state: "blocked", capabilities: { send: true, status: true, model_options: true },
    approval_state: { scanned: true, blocked: true, approvable: false, prompt_kind: "folder_trust" },
    available_actions: { send: { tool: "agent_knock_knock_send" }, model_options: { tool: "agent_knock_knock_model_options" } } });
  const result = unifiedConversationList({ terminals: [physical], codex_cli_sessions: [native()] }, [physical]);
  assert.equal(result.conversations.length, 2);
  assert.deepEqual(result.conversations[0].terminal_aliases, []);
  assert.equal((result.conversations[0].capabilities as any).send, true, "cwd alone cannot change another thread's authority");
  assert.match((result.conversations[1].usage as any).summary, /folder access decision/);
  assert.deepEqual(result.conversations[1].available_actions, {});
  assert.equal((result.conversations[1].capabilities as any).send, false);
  assert.equal((result.conversations[1].capabilities as any).model_options, false);
});

function claudePair() {
  const processStart = "Mon Oct 12 01:02:03 2026";
  const id = createClaudeNativeConversationId({ configDir: "/fixture/claude", sessionId: thread, pid: 123, processStart });
  const [weekday, month, day, year, time] = new Date(`${processStart} GMT`).toString().split(" ");
  const physical = terminal({ id: "terminal:v2:tmux:claude:akk:0.0:123", agent: "claude",
    native_agent_process_birth: [weekday, month, day, time, year].join(" "),
    _claude_managed_send_eligible: true,
    terminal_control: { capabilities: ["send_keys"] }, approval_state: { scanned: true, blocked: false },
    available_actions: { send: { tool: "agent_knock_knock_send", scope: "terminal_user_explicit",
      arguments: { terminal_id: "terminal:v2:tmux:claude:akk:0.0:123", expected_terminal_token: "physical-authority" } } } });
  const backend = { id, conversation_id: id, source: "claude_cli", agent: "claude", cwd: "/project", pid: 123,
    native_thread_id: thread, connection_state: "native_registry_verified", capabilities: { status: true, send: true, watch: false },
    available_actions: { send: { tool: "agent_knock_knock_send", input: { conversation_id: id } },
      status: { tool: "agent_knock_knock_status", input: { conversation_id: id } } } };
  return { physical, backend };
}

test("unified List coalesces exact terminal/backend identity and preserves every Desktop sidebar row", () => {
  const physical = terminal();
  const codex = native();
  const desktops = [
    { conversation_id: "desktop:v1:one", title: "Project one", source: "codex_desktop", sidebar_section: "project",
      sidebar_project_id: "project-one", connection_state: "live_owner_verified", capabilities: { send: true } },
    { conversation_id: "desktop:v1:two", title: "Project two", source: "codex_desktop", sidebar_section: "project",
      sidebar_project_id: "project-two", connection_state: "unconfirmed", can_send_reason: "no_live_owner",
      capabilities: { send: false, watch: false, status: true },
      available_actions: { status: { tool: "agent_knock_knock_status", input: { conversation_id: "desktop:v1:two" } } } }
  ];
  const result = unifiedConversationList({ terminals: [{ id: terminalId, agent: "codex" }],
    codex_cli_sessions: [codex], desktop_sessions: desktops }, [physical]);
  assert.equal(result.conversations.length, 3);
  assert.deepEqual(result.conversations[0].terminal_aliases, [terminalId]);
  assert.equal(result.conversations[0].conversation_id, nativeId);
  assert.equal(result.conversations[0].route_preference, "codex_backend");
  assert.equal(result.conversation_routing.policy, "agent_specific");
  assert.equal(result.conversation_routing.codex, "backend_first");
  assert.equal(result.conversation_routing.claude, "managed_terminal_first");
  assert.deepEqual(result.conversations.slice(1).map(({ usage: _usage, ...row }) => row),
    desktops.map(row => ({ ...row, route_preference: "desktop_ipc", surface: "desktop" })));
  assert.equal(result.conversations[0].surface, "cli");
  assert.equal(result.conversation_routing.exact_associations, 1);
  assert.equal(result.conversation_routing.unresolved_terminals, 0);
  for (const [key, value] of Object.entries(codex)) {
    assert.deepEqual(result.conversations[0][key], value, `Codex CLI retains its existing ${key}`);
  }
  for (const row of result.conversations) {
    const usage = row.usage as Record<string, any>;
    assert.ok(usage.summary && usage.next_steps.length, "CLI and Desktop both receive actionable display guidance");
    assert.equal(usage.available.includes("Send a task"), (row.capabilities as Record<string, unknown>).send === true);
  }
});

test("List explains idle, working and unidentified Claude rows without changing their controls", () => {
  const { physical, backend } = claudePair();
  const list = (entry: Record<string, unknown>, control = physical) => unifiedConversationList({
    claude_cli_sessions: [entry], terminals: [control]
  }, [control]);
  const idle = list({ ...backend, activity_state: "idle" });
  const idleRow = idle.conversations[0] as Record<string, any>;
  assert.equal(idleRow.capabilities.send, true);
  assert.equal(idleRow.capabilities.watch, false);
  assert.ok(idleRow.usage.available.includes("Send a task"));
  assert.match(idleRow.usage.limitations.join(" "), /no active task.*idle/u);
  assert.match(idleRow.usage.next_steps.join(" "), /Send a task.*Status/u);
  const working = list({ ...backend, activity_state: "working",
    capabilities: { ...backend.capabilities, watch: true, interaction_notify: true },
    available_actions: { ...backend.available_actions, watch: { tool: "agent_knock_knock_watch", input: { conversation_id: backend.id } } } });
  const workingRow = working.conversations[0] as Record<string, any>;
  assert.ok(workingRow.usage.available.includes("Watch the current task"));
  assert.doesNotMatch(JSON.stringify(workingRow.usage), /no active task/u);
  assert.match(workingRow.usage.limitations.join(" "), /answered in the original terminal/u);
  const unidentified = { ...physical, native_agent_session_id: undefined,
    native_agent_identity_observation: { status: "unresolved", recheck: { attempted: true, status: "unresolved" } },
    available_actions: { status: { tool: "agent_knock_knock_status" }, watch: { tool: "agent_knock_knock_watch" } } };
  const unresolved = unifiedConversationList({ terminals: [unidentified] }, [unidentified]);
  const row = unresolved.conversations[0] as Record<string, any>;
  assert.equal(row.send_blocked_reason, "terminal_identity_unresolved");
  assert.ok(row.usage.available.includes("Observe terminal activity"));
  assert.equal(row.usage.available.includes("Send a task"), false);
  assert.match(row.usage.limitations.join(" "), /checked again.*could not identify/u);
  assert.match(row.usage.next_steps.join(" "), /Finish or save.*Exit the agent.*resume.*refresh List/u);
  assert.match(row.usage.next_steps.join(" "), /not a guaranteed repair/u);
  const background = unifiedConversationList({ terminals: [{ ...unidentified,
    native_agent_identity_observation: { ...unidentified.native_agent_identity_observation, window_role: "background_view" }
  }] }, [unidentified]);
  const backgroundRow = background.conversations[0] as Record<string, any>;
  assert.match(backgroundRow.usage.summary, /background conversation.*not currently available/u);
  assert.match(backgroundRow.usage.limitations.join(" "), /cannot currently verify safe input.*cannot prove native background task acceptance or completion/u);
  assert.match(backgroundRow.usage.next_steps.join(" "), /pending prompt.*refresh List.*Use Send if/u);
  assert.match(backgroundRow.usage.next_steps.join(" "), /keep existing background work running/u);
  assert.doesNotMatch(backgroundRow.usage.next_steps.join(" "), /Exit the agent|resume the conversation/u);
  const { usage: _unknownUsage, native_agent_identity_observation: _unknownObservation, ...unknownFields } = row;
  const { usage: _backgroundUsage, native_agent_identity_observation: _backgroundObservation, ...backgroundFields } = backgroundRow;
  assert.deepEqual(backgroundFields, unknownFields, "diagnostic role changes advice, never actions, identity or capabilities");
  for (const result of [idle, working, unresolved, background]) {
    const compact = compactAkkListModelProjection(result) as Record<string, any>;
    assert.deepEqual(compact.conversations[0].usage, result.conversations[0].usage,
      "the Host preserves advice after compacting capabilities and terminal controls");
  }
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

test("exact native aliases preserve Store conflict recovery without reviving native or physical writes", () => {
  const claude = claudePair();
  for (const pair of [{ physical: terminal(), backend: native() }, claude]) {
    const id = String(pair.physical.id);
    const recovery = { tool: "agent_knock_knock_reconcile_binding", requires_user_intent: true,
      missing_required: ["maintenance_acknowledgement"], arguments: {
        operation: "transfer_store_authority", terminal_id: id, expected_authority_token: "secret-authority"
      } };
    const authority = { state: "conflict", reason: "native_thread_authoritative_in_another_store",
      source_store_dir: "/tmp/previous-store", owner_status: "legacy", transfer_eligible: true, automatic_eligible: false, send_after_transfer: false };
    const projected = { ...pair.physical, management_state: "conflict", native_store_authority: authority,
      capabilities: { status: true, send: false, cancel: false }, available_actions: {
        status: { tool: "agent_knock_knock_status", arguments: { terminal_id: id } }, transfer_store_authority: recovery
      } };
    const backend = { ...pair.backend, interaction_state: [{ kind: "command_approval", available_actions: {
      approve: { tool: "agent_knock_knock_approve" }
    } }], capabilities: { status: true, send: true, watch: true, interaction_notify: true,
      approve: true, set_permissions: true }, available_actions: { ...pair.backend.available_actions,
      status: { tool: "agent_knock_knock_status", input: { conversation_id: pair.backend.conversation_id } },
      watch: { tool: "agent_knock_knock_watch", input: { conversation_id: pair.backend.conversation_id } },
      approve: { tool: "agent_knock_knock_approve" }, set_permissions: { tool: "agent_knock_knock_set_permissions" }
    } };
    const result = unifiedConversationList({ terminals: [projected],
      [backend.agent === "claude" ? "claude_cli_sessions" : "codex_cli_sessions"]: [backend] }, [pair.physical]);
    const row = result.conversations[0] as Record<string, any>;
    assert.deepEqual(row.native_store_authority, authority);
    assert.equal(row.capabilities.send, false);
    assert.equal(row.capabilities.approve, false);
    assert.equal(row.capabilities.set_permissions, false);
    assert.equal(row.capabilities.interaction_notify, true);
    assert.equal(row.available_actions.send, undefined);
    assert.equal(row.available_actions.approve, undefined);
    assert.equal(row.available_actions.set_permissions, undefined);
    assert.deepEqual(row.interaction_state[0].available_actions, {});
    assert.ok(row.available_actions.watch);
    assert.equal(row.available_actions.transfer_store_authority, recovery);
    assert.equal(row.terminal_controls[0].available_actions.send, undefined);
    const status = withExactTerminalActions({ ...backend, terminal_controls: [projected] });
    assert.equal((status.available_actions as Record<string, unknown>).send, undefined,
      "Status consumes the same exact conflict projection");
    const compact = compactAkkListModelProjection(result) as Record<string, any>;
    const shown = compact.conversations[0];
    assert.equal(shown.available_actions.send, undefined);
    assert.equal(shown.available_actions.transfer_store_authority, true);
    assert.equal(shown.action_inputs.transfer_store_authority.tool, "agent_knock_knock_reconcile_binding");
    assert.equal(shown.action_inputs.transfer_store_authority.arguments.operation, "transfer_store_authority");
    assert.equal(shown.action_inputs.transfer_store_authority.arguments.terminal_id, id);
    assert.equal(shown.action_inputs.transfer_store_authority.requires_user_intent, true);
    assert.deepEqual(shown.action_inputs.transfer_store_authority.missing_required, ["maintenance_acknowledgement"]);
    assert.equal(JSON.stringify(compact).includes("secret-authority"), false);
  }
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
  assert.deepEqual(compactAkkListModelProjection(result).conversation_routing, result.conversation_routing);
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
    native_thread_lifecycle: { status: "supported", newThread: true, resumeExact: true },
    available_actions: {
      approve: { tool: "agent_knock_knock_approve", arguments: { turn_id: "claude-managed-turn" } },
      respond_interaction: { tool: "agent_knock_knock_respond_interaction", arguments: { turn_id: "claude-managed-turn", interaction_id: "current-question" } },
      cancel: { tool: "agent_knock_knock_cancel", arguments: { conversation_id: "terminal:v2:tmux:claude:akk:0.0:123" } },
      new_thread: { tool: "agent_knock_knock_new_thread", arguments: { terminal_id: "terminal:v2:tmux:claude:akk:0.0:123", expected_binding_token: "binding" } },
      list_resumable_threads: { tool: "agent_knock_knock_list_resumable_threads", arguments: { terminal_id: "terminal:v2:tmux:claude:akk:0.0:123" } },
      model_options: { tool: "agent_knock_knock_model_options", arguments: { terminal_id: "terminal:v2:tmux:claude:akk:0.0:123", expected_binding_token: "binding" } },
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
  const expected = { ...backend.capabilities, approve: true, native_inspect: true, interaction_respond: true,
    cancel: true, new_thread: true, clear_thread: true, resume_thread: true, list_resumable_threads: true,
    model_options: true, set_model: true, permission_options: false, set_permissions: false };
  assert.deepEqual(result.conversations[0].capabilities, expected);
  const compact = compactAkkListModelProjection(result);
  const visible = (compact.conversations as Record<string, unknown>[])[0];
  assert.deepEqual(visible.capabilities, { ...expected, status: true }, "Host compaction must preserve lifecycle, cancellation and catalog capabilities");
  const actionInputs = visible.action_inputs as Record<string, any>;
  assert.equal(actionInputs.approve.arguments.turn_id, "claude-managed-turn");
  assert.equal(actionInputs.respond_interaction.arguments.interaction_id, "current-question");
  assert.equal(actionInputs.new_thread.arguments.terminal_id, physical.id);
  assert.doesNotMatch(JSON.stringify(compact), /expected_binding_token/u);
  assert.equal(backend.capabilities.approve, false, "Original connection diagnostics keep their native scope");
  const idle = { ...physical, activity_state: "idle", terminal_control: { capabilities: ["send_keys", "terminal_cancel"] },
    available_actions: {} };
  const idleList = unifiedConversationList({ terminals: [idle], claude_cli_sessions: [backend] }, [idle]);
  const idleCapabilities = idleList.conversations[0].capabilities as Record<string, unknown>;
  assert.equal(idleCapabilities.cancel, true, "An idle Claude still supports adapter cancellation without a current cancel offer");
  assert.equal((idleList.conversations[0].available_actions as Record<string, unknown>).cancel, undefined);
  for (const capabilities of [["send_keys"], ["terminal_cancel"], []]) {
    const missing = { ...idle, terminal_control: { capabilities } };
    const unavailable = unifiedConversationList({ terminals: [missing], claude_cli_sessions: [backend] }, [missing]);
    assert.equal((unavailable.conversations[0].capabilities as Record<string, unknown>).cancel, false);
  }
});

test("Claude List follows managed Send eligibility while preserving canonical selectors and native-only fallback", () => {
  const { physical, backend } = claudePair();
  const changed = (values: Record<string, unknown>) => [{ ...physical, ...values }];
  const cases = [
    { name: "eligible", physical: [physical], route: "managed_terminal", send: true },
    { name: "busy", physical: changed({ activity_state: "working" }), route: "managed_terminal", send: false },
    { name: "approval blocked", physical: changed({ approval_state: { scanned: true, blocked: true } }), route: "managed_terminal", send: false },
    { name: "unscanned", physical: changed({ approval_state: { scanned: false, blocked: false } }), route: "managed_terminal", send: false },
    { name: "managed prerequisites unavailable", physical: changed({ _claude_managed_send_eligible: false }), route: "managed_terminal", send: false },
    { name: "managed prerequisites unobserved", physical: changed({ _claude_managed_send_eligible: undefined }), route: "managed_terminal", send: false },
    { name: "Store-filtered Send", physical: [physical], projected: changed({ available_actions: {} }), route: "managed_terminal", send: false },
    { name: "Store read-only", physical: [physical], writable: false, route: "managed_terminal", send: false },
    { name: "Store unavailable", physical: [physical], projected: changed({ management_state: "unavailable" }), route: "managed_terminal", send: false },
    { name: "management conflict", physical: [physical], projected: changed({ management_state: "conflict" }), route: "managed_terminal", send: false },
    { name: "automatic transfer before managed Send", physical: [physical], projected: changed({ management_state: "conflict",
      native_store_authority: { state: "conflict", automatic_eligible: true, send_after_transfer: true } }), route: "managed_terminal", send: true },
    { name: "automatic transfer retains composer fence", physical: changed({ _claude_managed_send_eligible: false }),
      projected: changed({ management_state: "conflict", native_store_authority: { state: "conflict", automatic_eligible: true,
        send_after_transfer: true } }), route: "managed_terminal", send: false },
    { name: "session conflict", physical: changed({ native_agent_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), route: "managed_terminal", send: false },
    { name: "birth conflict", physical: changed({ native_agent_process_birth: "Mon Oct 12 01:02:04 2026" }), route: "managed_terminal", send: false },
    { name: "ambiguous", physical: [physical, { ...physical, id: "terminal:v2:tmux:claude:akk:0.1:123" }], route: "managed_terminal", send: false },
    { name: "no terminal", physical: [], route: "claude_native", send: true },
    { name: "unrelated process", physical: changed({ pid: 999 }), route: "claude_native", send: true },
  ];
  for (const scenario of cases) {
    const listed = unifiedConversationList({ terminals: scenario.projected ?? scenario.physical, store: { writable: scenario.writable ?? true },
      claude_cli_sessions: [backend] }, scenario.physical, {}, { diagnostics: true });
    const row = listed.conversations.find(item => item.conversation_id === backend.id)!;
    assert.equal(row.route_preference, scenario.route, scenario.name);
    assert.equal((row.capabilities as Record<string, unknown>).send, scenario.send, scenario.name);
    const actions = row.available_actions as Record<string, any>;
    if (scenario.send) assert.deepEqual(actions.send.input, { conversation_id: backend.id }, scenario.name);
    else {
      assert.equal(actions.send, undefined, scenario.name);
      assert.equal(row.route_status, "terminal_blocked", scenario.name);
      assert.equal(typeof row.send_blocked_reason, "string", scenario.name);
    }
    assert.equal(actions.status, backend.available_actions.status, "Status retains the native identity");
    const compact = compactAkkListModelProjection(listed) as Record<string, any>;
    const visible = compact.conversations.find((item: Record<string, unknown>) => item.conversation_id === backend.id);
    assert.equal(visible.route_preference, scenario.route, scenario.name);
    assert.equal(visible.capabilities.send, scenario.send, scenario.name);
    assert.equal(visible.available_actions.send, scenario.send ? true : undefined, scenario.name);
    assert.doesNotMatch(JSON.stringify(compact), /physical-authority|expected_terminal_token|_claude_managed_send_eligible/u);
  }
  assert.equal(backend.capabilities.send, true, "Projection must not rewrite native diagnostics");
});

test("Claude terminal-only List retains verified explicit physical Send independently of managed eligibility", () => {
  const { physical } = claudePair();
  const approve = { tool: "agent_knock_knock_approve", arguments: { turn_id: "existing-claude-turn" } };
  const physicalSend = (physical.available_actions as Record<string, any>).send;
  const base = { ...physical, native_agent_session_id: undefined, _claude_managed_send_eligible: false,
    native_agent_identity_observation: { status: "verified_absent", window_role: "background_view" },
    available_actions: { send: physicalSend, approve } };
  const cases: { name: string; values?: Record<string, unknown>; send: boolean; writable?: boolean }[] = [
    { name: "unresolved identity", send: true },
    { name: "physical selector from real terminal projection", values: { available_actions: { approve,
      send: { ...physicalSend, arguments: { selector: physical.id, expected_terminal_token: "physical-authority" } } } }, send: true },
    { name: "background activity label does not override verified physical readiness", values: { activity_state: "working",
      physical_send_readiness: { ready: true } }, send: true },
    { name: "foreground readiness invalidates a stale physical offer", values: {
      physical_send_readiness: { ready: false, reason: "foreground_running" } }, send: false },
    { name: "Store read-only does not veto explicit input", writable: false, send: true },
    { name: "unavailable managed records", values: { management_state: "unavailable" }, send: true },
    { name: "resolved identity still honors explicit selection", values: {
      native_agent_session_id: thread, native_agent_identity_observation: { status: "resolved" } }, send: true },
    { name: "missing physical offer", values: { available_actions: { approve } }, send: false },
    { name: "ordinary offer is not a physical opt-in", values: { available_actions: {
      approve, send: { ...physicalSend, scope: undefined } } }, send: false },
    { name: "missing authority", values: { available_actions: {
      approve, send: { ...physicalSend, arguments: { terminal_id: physical.id } } } }, send: false },
    { name: "different physical target", values: { available_actions: { approve, send: { ...physicalSend,
      arguments: { terminal_id: "terminal:v2:tmux:claude:akk:0.1:999", expected_terminal_token: "other-authority" } } } }, send: false },
    { name: "approval blocked", values: { approval_state: { scanned: true, blocked: true } }, send: false },
    { name: "approval not scanned", values: { approval_state: { scanned: false, blocked: false } }, send: false },
    { name: "process no longer active", values: { process_state: "exited" }, send: false },
    { name: "terminal cannot input", values: { terminal_control: { capabilities: ["screen_status"] } }, send: false },
    { name: "cross-Store conflict", values: { native_store_authority: { state: "conflict" } }, send: false },
    { name: "unfinished transfer", values: { native_store_authority: { state: "transferring" } }, send: false },
    { name: "automatic transfer is not a direct physical offer", values: {
      native_store_authority: { state: "conflict", send_after_transfer: true } }, send: false }
  ];
  for (const scenario of cases) {
    const row = { ...base, ...scenario.values };
    const listed = unifiedConversationList({ terminals: [row], store: { writable: scenario.writable ?? true } },
      [row], {}, { diagnostics: true });
    const conversation = listed.conversations[0];
    assert.equal(conversation.route_preference, scenario.send ? "terminal" : "managed_terminal", scenario.name);
    assert.equal(conversation.route_status, "terminal_only");
    assert.equal((conversation.capabilities as Record<string, unknown>).send, scenario.send, scenario.name);
    const actions = conversation.available_actions as Record<string, any>;
    assert.equal(actions.approve, approve);
    if (scenario.send) {
      assert.deepEqual(actions.send.arguments, { terminal_id: physical.id }, scenario.name);
      assert.deepEqual(actions.send.missing_required, ["request"]);
      assert.equal(actions.send.scope, "terminal_user_explicit");
      assert.equal(actions.send.requires_user_intent, true);
      assert.equal(conversation.send_blocked_reason, undefined);
    } else assert.equal(actions.send, undefined, scenario.name);
    assert.doesNotMatch(JSON.stringify(actions), /physical-authority|other-authority|expected_terminal_token/u);
    const compact = compactAkkListModelProjection(listed) as Record<string, any>;
    assert.equal(compact.conversations[0].action_inputs.approve.arguments.turn_id, "existing-claude-turn");
    assert.equal(compact.conversations[0].conversation_id, physical.id);
    assert.equal(compact.conversations[0].available_actions.send, scenario.send ? true : undefined, scenario.name);
    if (scenario.send) {
      assert.equal(compact.conversations[0].action_inputs.send.scope, "terminal_user_explicit");
      assert.equal(compact.conversations[0].action_inputs.send.requires_user_intent, true);
    }
    assert.doesNotMatch(JSON.stringify(compact), /physical-authority|other-authority|expected_terminal_token/u);
  }
  assert.equal(physicalSend.arguments.expected_terminal_token, "physical-authority", "Private offers remain intact for execution");
});

test("Claude physical readiness explains draft and foreground blockers before missing native identity", () => {
  const reasons = [
    ["screen_not_scanned", /did not scan/u, /noApprovalScan.*false/u],
    ["screen_unavailable", /could not read/u, /Status.*capture error/u],
    ["composer_not_empty", /unsent draft/u, /Send, save, or clear/u],
    ["foreground_running", /still executing its current turn/u, /Wait.*finish/u],
    ["foreground_unproven", /cannot verify.*foreground turn has finished/u, /Wait.*done/u],
    ["footer_unrecognized", /cannot recognize the controls/u, /close any menu or overlay/u],
    ["composer_unrecognized", /cannot verify an empty main input box/u, /Return to Claude/u]
  ] as const;
  for (const [reason, limitation, nextStep] of reasons) {
    const row = terminal({ id: "terminal:v2:herdr:claude:default:w1:p4:999", agent: "claude", pid: 999,
      native_agent_identity_observation: { status: "verified_absent", window_role: "background_view" },
      physical_send_readiness: { ready: false, reason },
      available_actions: { status: true, watch: true } });
    const result = unifiedConversationList({ terminals: [row] }, [row], {}, { diagnostics: true });
    const output = result.conversations[0] as Record<string, any>;
    assert.equal(output.send_blocked_reason, `terminal_${reason}`);
    assert.equal(output.capabilities.send, false);
    assert.match(output.usage.limitations.join(" "), limitation);
    assert.match(output.usage.next_steps.join(" "), nextStep);
    assert.doesNotMatch(output.usage.next_steps.join(" "), /Exit the agent|restart/u);
    const compact = compactAkkListModelProjection(result) as Record<string, any>;
    assert.deepEqual(compact.conversations[0].physical_send_readiness, { ready: false, reason });
    assert.deepEqual(compact.conversations[0].usage, output.usage);
  }
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
