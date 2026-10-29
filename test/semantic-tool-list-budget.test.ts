import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";
import { HOST_LIST_MAX_BYTES, HOST_LIST_MAX_WEIGHTED_CHARS, hostListWeightedChars } from "../src/semantic-tool-list-budget.js";
import { createAkkSemanticToolCatalog } from "../src/semantic-tool-runtime.js";
import { bindSemanticToolRelayPath } from "../src/semantic-tool-relay.js";
import { compactListV5Row, resolveHostListProjectionVersion } from "../src/semantic-tool-list-format.js";

type Row = Record<string, any>;
const watch = (index: number, status = "completed", callback = "accepted"): Row => ({
  watch_id: `codex-cli-watch:fixture-${index}`, conversation_id: "codex-cli:v1:fixture", status,
  callback_state: callback, callback_expected: false, native_thread_id: "exact-thread", native_turn_id: `turn-${index}`,
  callback_notifications: [{ id: `notice-${index}`, status: callback, attempts: 1 }],
  available_actions: { status: { tool: "agent_knock_knock_status", input: { watch_id: `codex-cli-watch:fixture-${index}` } } }
});
const conversations = [
  { conversation_id: "codex-cli:v1:cli", source: "codex_cli", surface: "cli", agent: "codex", title: "CLI fixture", activity_state: "active" },
  { conversation_id: "desktop:v1:desktop", source: "codex_desktop", surface: "desktop", agent: "codex", title: "Desktop fixture", activity_state: "idle" }
];
function bounded(value: Row) {
  const json = JSON.stringify(value);
  assert.doesNotThrow(() => JSON.parse(json));
  assert.ok(hostListWeightedChars(json) <= HOST_LIST_MAX_WEIGHTED_CHARS);
  assert.ok(Buffer.byteLength(json) <= HOST_LIST_MAX_BYTES, `List exceeded its whole-response budget: ${Buffer.byteLength(json)}`);
}
test("thousands of ended and unresolved Watches never enter conversation List or its page counts", () => {
  const data = { conversations, codex_cli_watches: Array.from({ length: 2_000 }, (_, i) => watch(i)),
    desktop_watches: [watch(2_001, "watching", "monitoring"), watch(2_002, "completed", "failed"), watch(2_003, "completed", "uncertain")],
    terminal_watches: [{ watch_id: "terminal-watch-pending", status: "completed", callback: { pending: 1 } }] };
  const result = compactAkkListModelProjection(data) as Row;
  bounded(result);
  assert.equal(result.projection.version, 4);
  assert.deepEqual(result.conversations.map((row: Row) => row.conversation_id), conversations.map(row => row.conversation_id));
  for (const field of ["codex_cli_watches", "desktop_watches", "terminal_watches", "watch_summary", "managed_turns", "unavailable_managed_turns"]) assert.equal(result[field], undefined);
  assert.equal(result.pagination.total_available, 2);
  assert.equal(result.pagination.has_more, false);
  assert.equal(data.codex_cli_watches.length, 2_000, "input remains intact for independent monitoring");
});

test("conversation pages bound Unicode output, retain every selector once and validate continuation scope", () => {
  const data = { conversations: Array.from({ length: 80 }, (_, i) => ({ ...conversations[i % 2], conversation_id: `fixture-${i}`, title: "中文🙂𠀀".repeat(40) })) };
  const seen = new Set<string>(); let args: Row | null = { listLimit: 100 }; let pages = 0;
  do {
    const page = compactAkkListModelProjection(data, args!) as Row;
    bounded(page);
    for (const row of page.conversations) { assert.equal(seen.has(row.conversation_id), false); seen.add(row.conversation_id); }
    args = page.pagination.next_args; pages++;
  } while (args && pages < 100);
  assert.equal(args, null); assert.equal(seen.size, 80); assert.ok(pages > 1);
  const first = compactAkkListModelProjection(data, { listLimit: 1 }) as Row;
  assert.throws(() => compactAkkListModelProjection(data, { ...first.pagination.next_args, agent: "claude" }), /changed filters/u);
  assert.throws(() => compactAkkListModelProjection(data, { listCursor: "invalid" }), /Invalid List cursor/u);
  assert.throws(() => compactAkkListModelProjection(data, { listLimit: 0 }), /listLimit/u);
  for (const params of [{ all: true }, { listView: "history" }, { listView: "all" }]) {
    assert.throws(() => compactAkkListModelProjection(data, params), /agent_knock_knock_watches/u);
  }
});

test("Host List is read-only conversation discovery and directs old history requests to watches", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-page-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const relay = path.join(dir, "relay.cjs"), calls = path.join(dir, "calls.json");
  const data = { conversations, codex_cli_watches: Array.from({ length: 300 }, (_, i) => watch(i)) };
  fs.writeFileSync(relay, `require('node:fs').writeFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(JSON.stringify(data))});`);
  const owner = { pluginConfig: { storeDir: path.join(dir, "store") }, logger: { info() {}, warn() {} } };
  bindSemanticToolRelayPath(owner, relay);
  const tool = createAkkSemanticToolCatalog(owner, new Map()).tools.find(tool => tool.name === "agent_knock_knock_list")!;
  const current = await tool.execute({}, "list-current", {}) as Row;
  const parsed = JSON.parse(current.content[0].text); bounded(parsed);
  assert.equal(parsed.conversations.length, 2); assert.equal(parsed.codex_cli_watches, undefined);
  const argv = JSON.parse(fs.readFileSync(calls, "utf8"));
  assert.equal(argv.includes("--all"), false); assert.equal(argv.includes("--reconcile"), false);
  await assert.rejects(async () => tool.execute({}, "list-history", { listView: "history" }), /watches/u);
});

test("List retains current managed ownership and blocked interactions but no historical records", () => {
  const row = { conversation_id: "terminal:v2:tmux:claude:fixture:0.0:1", source: "terminal_control", agent: "claude",
    approval_state: { blocked: true, approvable: true }, managed: {
      current_turn: { turn_id: "current", status: "waiting_for_agent" },
      recent_turn: { turn_id: "old-uncertain", status: "idle" },
      history: [{ turn_id: "old-uncertain", status: "idle", callback_delivery: { status: "uncertain", attempts: 1 } }]
    } };
  const current = compactAkkListModelProjection({ conversations: [row], unavailable_managed_turns: [{ turn_id: "offline", status: "idle" }] }) as Row;
  bounded(current);
  assert.equal(current.managed_turns, undefined); assert.equal(current.unavailable_managed_turns, undefined);
  assert.equal(current.conversations[0].managed.history, undefined); assert.equal(current.conversations[0].managed.recent_turn, undefined);
  assert.equal(current.conversations[0].managed.current_turn.turn_id, "current");
  assert.equal(current.conversations[0].approval_state.blocked, true);
  assert.equal(row.managed.history.length, 1);
});

test("Unicode diagnostics and all metadata are included in the whole response limit", () => {
  const result = compactAkkListModelProjection({ conversations, codex_cli_scan: { error: "𠀀".repeat(10_000) },
    desktop_scan: { limitations: Array(50).fill("中文".repeat(1_000)) }, recovery: { reason: "長".repeat(1_000) } }) as Row;
  bounded(result); assert.equal(result.conversations.length, 2);
  assert.equal(result.desktop_scan.details_omitted, true);
  assert.equal(result.codex_cli_scan.details_omitted, true);
});

test("Claude compact diagnostics allow only bounded codes and reader selection, never private discovery details", () => {
  const result = compactAkkListModelProjection({ conversations, claude_cli_scan: {
    status: "partial", returned: 0, loaded_count: 0, complete: false, error_count: 100,
    error_codes: [...Array(50).fill("claude_reader_unavailable"), ...Array.from({ length: 20 }, (_, i) => `fixture_error_${i}`)],
    next_action: "check_claude_reader_in_host_environment",
    reader: { executable: "tclaude", source: "environment", path_omitted: true, resolved_path: "/private/install/tclaude" },
    diagnostics: [{ configDir: "/private/session/root", code: "claude_reader_unavailable" }], raw_stderr: "private credentials"
  } }) as Row;
  bounded(result);
  assert.equal(result.claude_cli_scan.error_codes.length, 8);
  assert.equal(result.claude_cli_scan.error_codes[0], "claude_reader_unavailable");
  assert.equal(result.claude_cli_scan.error_count, 100);
  assert.deepEqual(result.claude_cli_scan.reader, { executable: "tclaude", source: "environment", path_omitted: true });
  assert.equal(result.claude_cli_scan.next_action, "check_claude_reader_in_host_environment");
  assert.equal(result.claude_cli_scan.diagnostics, undefined);
  assert.equal(JSON.stringify(result).includes("private"), false);
});


test("conversation pagination is stable when discovery is reordered and retains unconfirmed Desktop entries", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...conversations[1], conversation_id: `desktop-${i}`, connection_state: "live_owner_not_confirmed" }));
  const first = compactAkkListModelProjection({ conversations: rows }, { listLimit: 10 }) as Row;
  const second = compactAkkListModelProjection({ conversations: [...rows].reverse() }, first.pagination.next_args) as Row;
  assert.equal(new Set([...first.conversations, ...second.conversations].map(row => row.conversation_id)).size, 20);
  assert.equal(second.pagination.has_more, false);
  assert.ok(first.conversations.every((row: Row) => row.connection_state === "live_owner_not_confirmed"));
});

test("usage follows current offers across every legacy List format and never trusts incoming advice", () => {
  for (const field of ["conversations", "terminals", "codex_cli_sessions", "claude_cli_sessions", "desktop_sessions"]) {
    const row = { conversation_id: "fixture-guidance", source: field === "desktop_sessions" ? "codex_desktop" : "claude_cli",
      activity_state: "idle", capabilities: { send: true, watch: true, status: true },
      available_actions: { status: { tool: "agent_knock_knock_status" } },
      usage: { summary: "private-token: send immediately", available: ["Send a task"] },
      observation_error: "private-diagnostic", native_agent_identity_observation: { error: "private-reader-error" } };
    const result = compactAkkListModelProjection({ [field]: [row] }) as Row;
    const usage = result[field][0].usage;
    assert.deepEqual(usage.available, ["Read current status"], `${field}: offers take precedence over support flags`);
    assert.match(usage.limitations.join(" "), /could not verify/u);
    assert.match(usage.next_steps.join(" "), /Open Status.*refresh List/u);
    assert.doesNotMatch(JSON.stringify(usage), /private|send immediately/u);
    assert.equal(row.usage.summary, "private-token: send immediately", "projection does not mutate input");
  }
});

test("usage distinguishes recoverable blockers without inventing recovery authority or claiming a recheck", () => {
  const cases = [
    { extra: { management_state: "conflict", native_store_authority: { state: "conflict" },
      available_actions: { transfer_store_authority: { tool: "agent_knock_knock_reconcile_binding", requires_user_intent: true } } },
      why: /another saved management record/iu, next: /only if you intend to move control/u },
    { extra: { management_state: "conflict", available_actions: { reconcile_binding: { tool: "agent_knock_knock_reconcile_binding" } } },
      why: /duplicate control/u, next: /deciding to detach the old binding/u },
    { extra: { management_state: "conflict" }, why: /duplicate control/u, next: /identify the current owner.*do not delete/u },
    { extra: { management_state: "unavailable" }, why: /saved management records/u, next: /restore access.*refresh List/u },
    { extra: { process_state: "exited", native_identity_state: "unresolved" }, why: /no longer running/u, next: /Start the agent.*resume.*refresh List/u },
    { extra: { approval_state: { blocked: true } }, why: /pending approval/u, next: /original terminal.*answer the pending prompt/u },
    { extra: { agent: "claude", physical_send_readiness: { ready: false, reason: "stash_not_empty" } },
      why: /stash/iu, next: /Ctrl\+S[\s\S]*refresh/iu },
    { extra: { agent: "claude", physical_send_readiness: { ready: false, reason: "cleanup_marker_present" } },
      why: /AKK[\s\S]*marker/iu, next: /marker[\s\S]*refresh/iu },
    { extra: { activity_state: "working" }, why: /busy with existing work/u, next: /wait for current work to finish/u },
    { extra: { connection_state: "not_loaded" }, why: /live connection/u, next: /Open this conversation.*refresh List/u },
    { extra: { send_blocked_reason: "terminal_identity_unresolved" }, why: /could not identify/u, next: /Exit the agent.*refresh List/u }
  ];
  for (const { extra, why, next } of cases) {
    const result = compactAkkListModelProjection({ conversations: [{ conversation_id: "terminal:v2:fixture", source: "terminal",
      activity_state: "idle", capabilities: { send: false }, available_actions: { status: { tool: "agent_knock_knock_status" } }, ...extra }] }) as Row;
    const usage = result.conversations[0].usage;
    assert.match(usage.limitations.join(" "), why);
    assert.match(usage.next_steps.join(" "), next);
    assert.equal(usage.available.includes("Send a task"), false);
    assert.doesNotMatch(JSON.stringify(usage), /checked again/u, "no recheck claim without evidence");
  }
});

test("folded Claude guidance uses only one exact terminal readiness and preserves explicit row facts", () => {
  const status = { tool: "agent_knock_knock_status" };
  const base = { conversation_id: "claude-cli:v1:folded", source: "claude_cli", agent: "claude",
    activity_state: "idle", capabilities: { status: true, send: false }, available_actions: { status } };
  const listed = (extra: Row) => (compactAkkListModelProjection({ conversations: [{ ...base, ...extra }] }) as Row).conversations[0];
  for (const reason of ["stash_not_empty", "cleanup_marker_present"]) {
    const control = { id: "terminal:v2:herdr:claude:fixture:w1:p1:123", agent: "claude",
      physical_send_readiness: { ready: false, reason }, available_actions: { status } };
    const input = { terminal_controls: [control] };
    const original = structuredClone(input);
    const output = listed(input);
    assert.match(output.usage.limitations.join(" "), reason === "stash_not_empty" ? /stashed draft/u : /AKK-style cleanup marker/u);
    assert.match(output.usage.next_steps.join(" "), reason === "stash_not_empty" ? /Ctrl\+S.*restore.*refresh/u : /Remove only the AKK marker.*refresh/u);
    assert.equal(output.available_actions.send, undefined, "guidance does not grant a missing action");
    assert.deepEqual(input, original, "projection leaves folded terminal facts untouched");

    const own = listed({ ...input, physical_send_readiness: { ready: false, reason: "composer_not_empty" } });
    assert.match(own.usage.limitations.join(" "), /unsent draft/u, "row-level readiness takes precedence");
    assert.doesNotMatch(own.usage.limitations.join(" "), /stashed|cleanup marker/u);
    const multiple = listed({ terminal_controls: [control, { ...control, id: "terminal:v2:herdr:claude:fixture:w1:p2:456" }] });
    assert.match(multiple.usage.limitations.join(" "), /could not verify/u);
    assert.doesNotMatch(JSON.stringify(multiple.usage), /stashed draft|cleanup marker|Ctrl\+S/u, "multiple controls do not select recovery for a guessed window");
    for (const source of ["codex_cli", "codex_desktop"]) {
      const codex = listed({ ...input, source, agent: "codex", conversation_id: "codex-cli:v1:folded" });
      assert.match(codex.usage.limitations.join(" "), /could not verify/u);
      assert.doesNotMatch(JSON.stringify(codex.usage), /stashed draft|cleanup marker|Ctrl\+S/u, "Claude readiness does not change Codex advice");
    }
  }
});

test("usage distinguishes supported future answers, pending question responses and managed task continuation", () => {
  const base = { conversation_id: "codex-cli:v1:answers", source: "codex_cli", activity_state: "active",
    capabilities: { send: false, watch: true, interaction_notify: true, interaction_respond: true, approve: true },
    available_actions: { status: { tool: "agent_knock_knock_status" }, watch: { tool: "agent_knock_knock_watch" } } };
  const listed = (row: Row) => (compactAkkListModelProjection({ conversations: [row] }) as Row).conversations[0].usage;
  const working = listed(base);
  assert.doesNotMatch(working.limitations.join(" "), /must be answered in the original/u,
    "no pending action does not mean the backend lacks interactive support");
  assert.equal(working.available.includes("Answer a pending question"), false);
  const waiting = listed({ ...base, pending_interaction_count: 1 });
  assert.match(waiting.next_steps.join(" "), /Open Status.*offered approval or answer action/u);
  assert.doesNotMatch(waiting.next_steps.join(" "), /Return to the original terminal/u);
  const continuation = listed({ ...base, available_actions: { ...base.available_actions,
    respond: { tool: "agent_knock_knock_respond", arguments: { conversation_id: "managed-task" } },
    clear_thread: { tool: "agent_knock_knock_clear_thread" } } });
  assert.ok(continuation.available.includes("Continue the managed task"));
  assert.ok(continuation.available.includes("Clear the current conversation"));
  assert.equal(continuation.available.includes("Answer a pending question"), false);
  const question = listed({ ...base, available_actions: { ...base.available_actions,
    respond: { tool: "agent_knock_knock_respond_interaction", input: { interaction_id: "pending-question" } } } });
  assert.ok(question.available.includes("Answer a pending question"));
  assert.equal(question.available.includes("Continue the managed task"), false);
});

test("background-view advice requires positive Claude evidence and otherwise retains actionable uncertainty", () => {
  for (const agent of ["claude", "codex"]) for (const role of [undefined, "unknown", "background_view", true]) {
    const row = { conversation_id: `terminal:v2:tmux:${agent}:fixture:0.0:123`, source: "terminal", agent,
      activity_state: "idle", send_blocked_reason: "terminal_identity_unresolved",
      capabilities: { status: true, watch: true, send: false },
      available_actions: { status: { tool: "agent_knock_knock_status" }, watch: { tool: "agent_knock_knock_watch" } },
      native_agent_identity_observation: { status: "unavailable", window_role: role,
        recheck: { attempted: true, status: "failed" }, reason: "private-registry-path-or-error" },
      usage: { summary: "stale claim: known background session" } };
    const result = compactAkkListModelProjection({ conversations: [row] }) as Row;
    const output = result.conversations[0];
    assert.deepEqual(output.available_actions, { status: true, watch: true });
    assert.deepEqual(output.capabilities, { status: true, watch: true },
      "terminal compact output retains its existing omission of unavailable Send");
    assert.doesNotMatch(JSON.stringify(output.usage), /private|stale claim/u);
    if (agent === "claude" && role === "background_view") {
      assert.match(output.usage.summary, /background conversation.*not currently available/u);
      assert.match(output.usage.next_steps.join(" "), /pending prompt.*refresh List.*Use Send if/u);
      assert.doesNotMatch(JSON.stringify(output.usage), /AKK cannot send tasks here|Reopening.*will not enable/u);
    } else {
      assert.match(output.usage.limitations.join(" "), /checked again.*could not identify/u);
      assert.match(output.usage.next_steps.join(" "), /Finish or save.*Exit the agent.*refresh List/u);
      assert.doesNotMatch(JSON.stringify(output.usage), /background session view/u);
    }
  }
});

test("unresolved Claude physical Send retains callable public inputs and honest submission guidance", () => {
  for (const role of [undefined, "background_view"]) {
    const id = "terminal:v2:herdr:claude:fixture:w1:p1:123";
    const row = { id, conversation_id: id, agent: "claude", source: "terminal", activity_state: "idle",
      native_identity_state: "verified_absent", native_agent_identity_observation: { window_role: role },
      available_actions: { status: { tool: "agent_knock_knock_status" }, watch: { tool: "agent_knock_knock_watch" },
        send: { tool: "agent_knock_knock_send", arguments: { terminal_id: id, expected_terminal_token: "private-token" },
          scope: "terminal_user_explicit", missing_required: ["request"], requires_user_intent: true } } };
    const listed = (value: Row) => (compactAkkListModelProjection({ conversations: [value] }) as Row).conversations[0];
    const output = listed(row);
    assert.equal(output.available_actions.send, true);
    assert.deepEqual(output.action_inputs.send, { scope: "terminal_user_explicit", missing_required: ["request"], requires_user_intent: true });
    assert.equal(output.usage.summary, "可以向此窗口发送任务。AKK 会输入文字并提交，但目前无法可靠确认后台任务的接受和完成状态；请在窗口中查看执行结果。");
    assert.match(output.usage.next_steps.join(" "), /terminal_id and request.*check the result/u);
    assert.match(output.usage.limitations.join(" "), /not native task acceptance or completion/u);
    assert.doesNotMatch(JSON.stringify(output), /private-token|expected_terminal_token|cannot send tasks here/u);
    const blocked = listed({ ...row, approval_state: { blocked: true },
      available_actions: { status: row.available_actions.status, watch: row.available_actions.watch } });
    assert.equal(blocked.available_actions.send, undefined);
    assert.match(blocked.usage.next_steps.join(" "), /answer the pending prompt/u);
    assert.doesNotMatch(blocked.usage.summary, /可以向此窗口发送任务/u, "advice follows the current offer, not the window role");
  }
});

test("Codex CLI and Desktop compact guidance preserves their existing selectors, capabilities and action inputs", () => {
  for (const source of ["codex_cli", "codex_desktop"]) {
    const id = source === "codex_cli" ? "codex-cli:v1:stable" : "desktop:v1:stable";
    const capabilities = { status: true, send: true, watch: true, interaction_notify: true,
      interaction_respond: true, approve: true, set_permissions: true, set_model: false, cancel: true };
    const row = { conversation_id: id, source, agent: "codex", title: "Existing conversation", cwd: "/fixture/project",
      activity_state: "working", connection_state: source === "codex_cli" ? "loaded_backend_verified" : "live_owner_verified",
      capabilities, available_actions: {
        status: { tool: "agent_knock_knock_status", input: { conversation_id: id } },
        send: { tool: "agent_knock_knock_send", input: { conversation_id: id } },
        watch: { tool: "agent_knock_knock_watch", input: { conversation_id: id } },
        approve: { tool: "agent_knock_knock_approve", input: { conversation_id: id, request_id: "approval-one" },
          decisions: ["approve", "deny"] }
      } };
    const original = structuredClone(row);
    const result = compactAkkListModelProjection({ conversations: [row], action_contracts: { version: 33 } }) as Row;
    const { usage, ...existingFields } = result.conversations[0];
    assert.deepEqual(existingFields, { conversation_id: id, agent: "codex", title: row.title, cwd: row.cwd,
      activity_state: "working", capabilities,
      available_actions: { status: true, send: true, watch: true, approve: true },
      action_inputs: { approve: { arguments: { request_id: "approval-one" }, decisions: ["approve", "deny"] } },
      surface: source === "codex_cli" ? "cli" : "desktop",
      ...(source === "codex_cli" ? { connected: true } : { connection_state: "live_owner_verified" })
    }, `${source}: usage is additive to the existing compact contract`);
    assert.ok(usage.available.includes("Send a task") && usage.available.includes("Review and answer an approval request"));
    assert.doesNotMatch(JSON.stringify(usage), /background session view|must be answered in the original/u);
    assert.equal(result.projection.version, 4);
    assert.equal(result.projection.action_contract_version, 33);
    assert.deepEqual(row, original, "projection leaves discovery facts and displayed authority untouched");
  }
});

test("oversized List rows retain honest Status guidance throughout pagination", () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ conversation_id: `huge-${i}`, source: "claude_cli", title: "界".repeat(1_000),
    activity_state: "idle", capabilities: { send: true }, available_actions: { send: { tool: "agent_knock_knock_send" } } }));
  let params: Row | null = { listLimit: 1 };
  const seen: string[] = [];
  do {
    const result = compactAkkListModelProjection({ conversations: rows }, params!) as Row;
    bounded(result);
    const row = result.conversations[0]; seen.push(row.conversation_id);
    assert.equal(row.details_omitted, true);
    assert.deepEqual(row.available_actions, { status: true });
    assert.deepEqual(row.usage.available, ["Read current status"]);
    assert.match(row.usage.limitations.join(" "), /omitted, not necessarily unavailable/u);
    assert.match(row.usage.next_steps.join(" "), /Status for this exact conversation/u);
    params = result.pagination.next_args;
  } while (params);
  assert.deepEqual(seen, ["huge-0", "huge-1", "huge-2"]);
});

test("v5 retains exact targets, live uncertainty and action inputs without repeating derived advice", () => {
  const cases = [
    { source: "codex_cli", surface: "cli", connection_state: "loaded_backend_verified", activity_state: "unknown", detail_scan: "deferred" },
    { source: "codex_desktop", surface: "desktop", connection_state: "live_owner_not_confirmed", activity_state: "unknown",
      manual_action: "Open this exact conversation", can_send_reason: "no_live_owner", capability_verification: { send: "unverified" } },
    { source: "codex_desktop", surface: "desktop", connection_state: "live_owner_verified", activity_state: "blocked",
      pending_interaction_count: 1, observation_error: "request_read_failed", capability_verification: { send: "verified" } }
  ];
  for (const state of cases) {
    const id = `fixture:${state.connection_state}`;
    const row = { id, conversation_id: id, title: "项目🙂", cwd: "/fixtures/project", agent: "codex", ...state,
      capabilities: { send: false, approve: false, interaction_notify: true },
      available_actions: { status: { tool: "agent_knock_knock_status", input: { conversation_id: id } },
        respond_interaction: { tool: "agent_knock_knock_respond_interaction", input: { conversation_id: id, interaction_id: "question-7" },
          scope: "exact_request", requires_user_intent: true, missing_required: ["answers"], choices: ["One", "Two"] } } };
    const raw = { conversations: [row], action_contracts: { version: 35 } }, saved = structuredClone(raw);
    const v4 = compactAkkListModelProjection(raw) as Row;
    const v5 = compactAkkListModelProjection(raw, { listProjectionVersion: 5 }) as Row;
    const { id: redundant, usage, ...preserved } = v4.conversations[0];
    assert.equal(redundant, id); assert.ok(usage);
    assert.deepEqual(v5.conversations[0], preserved, "no state/action/privacy fields silently removed or reinterpreted");
    assert.equal(v5.conversations[0].capabilities.send, false);
    assert.equal(v5.conversations[0].available_actions.send, undefined);
    assert.equal(v5.conversations[0].action_inputs.respond_interaction.arguments.interaction_id, "question-7");
    assert.equal(v5.projection.version, 5); assert.equal(v5.projection.action_contract_version, 35);
    assert.deepEqual(raw, saved); bounded(v5);
  }
  const distinct = compactListV5Row({ id: "physical-target", conversation_id: "native-target", usage: { summary: "old" },
    unknown: "unknown", nullable: null, flag: false, detail_scan: "deferred" });
  assert.deepEqual(distinct, { id: "physical-target", conversation_id: "native-target", unknown: "unknown", nullable: null, flag: false, detail_scan: "deferred" });
  for (const invalid of [0, 6, "5", null, true, {}, NaN]) assert.throws(() => resolveHostListProjectionVersion(invalid), /must be 4 or 5/u);
});

test("v5 pages retain every distinct conversation and pin format across continuations", () => {
  const rows = Array.from({ length: 70 }, (_, i) => {
    const id = `fixture-${String(i).padStart(3, "0")}`;
    return { ...conversations[i % 2], id, conversation_id: id, title: `项目 ${i} 🙂`, cwd: `/fixtures/project-${i % 4}`,
      connection_state: i % 2 ? "live_owner_not_confirmed" : "loaded_backend_verified", capabilities: { send: false },
      available_actions: { status: { tool: "agent_knock_knock_status" } } };
  });
  const raw = { conversations: rows }, first = compactAkkListModelProjection(raw, { listProjectionVersion: 5, listLimit: 50 }) as Row;
  assert.ok(first.pagination.has_more); assert.equal(first.pagination.next_args.listProjectionVersion, 5);
  assert.throws(() => compactAkkListModelProjection(raw, { ...first.pagination.next_args, listProjectionVersion: 4 }), /Invalid List cursor/u);
  assert.throws(() => compactAkkListModelProjection(raw, { ...first.pagination.next_args, desktopProject: "/different" }), /changed filters/u);
  const legacy = compactAkkListModelProjection(raw, { listLimit: 1 }) as Row;
  assert.throws(() => compactAkkListModelProjection(raw, { ...legacy.pagination.next_args, listProjectionVersion: 5 }), /Invalid List cursor/u);
  const { listProjectionVersion: ignored, ...oldNextArgs } = legacy.pagination.next_args;
  assert.doesNotThrow(() => compactAkkListModelProjection(raw, oldNextArgs), "pre-v5 continuation remains accepted in v4");
  let args: Row | null = { listProjectionVersion: 5, listLimit: 50 };
  const seen = new Set<string>(); let pages = 0;
  do {
    const page = compactAkkListModelProjection({ conversations: [...rows].reverse() }, args!) as Row;
    bounded(page); assert.equal(page.projection.version, 5);
    for (const row of page.conversations) {
      assert.ok(!seen.has(row.conversation_id)); seen.add(row.conversation_id);
      assert.equal(row.usage, undefined); assert.equal(row.id, undefined);
      assert.ok(row.title && row.cwd); assert.equal(row.capabilities.send, false);
    }
    args = page.pagination.next_args; assert.ok(++pages < 100);
  } while (args);
  assert.equal(seen.size, 70);
});

test("v5 oversized action rows keep recognizable identity and an honest exact Status fallback", () => {
  const raw = { conversations: [{ conversation_id: "desktop:large-actions", id: "desktop:large-actions", source: "codex_desktop",
    agent: "codex", title: "测试项目🙂", cwd: "/fixtures/project", sidebar_project_name: "项目", connection_state: "live_owner_verified",
    activity_state: "blocked", pending_interaction_count: 1,
    available_actions: { approve: { tool: "agent_knock_knock_approve", choices: Array.from({ length: 100 }, (_, i) => `${i}-${"x".repeat(100)}`) } } }] };
  const result = compactAkkListModelProjection(raw, { listProjectionVersion: 5 }) as Row;
  bounded(result);
  const row = result.conversations[0];
  assert.equal(row.details_omitted, true); assert.equal(row.usage, undefined); assert.equal(row.id, undefined);
  assert.equal(row.title, raw.conversations[0].title); assert.equal(row.cwd, "/fixtures/project"); assert.equal(row.sidebar_project_name, "项目");
  assert.equal(row.attention_required, true); assert.equal(row.pending_interaction_count, 1);
  assert.deepEqual(row.available_actions, { status: true });
  assert.deepEqual(row.action_inputs.status.arguments, { conversation_id: "desktop:large-actions" });
  assert.match(row.next_action, /omitted actions are not unsupported/u);
  assert.throws(() => compactAkkListModelProjection({ conversations: [{ ...raw.conversations[0], cwd: "/" + "x".repeat(30_000) }] },
    { listProjectionVersion: 5 }), /exceeds the response budget/u, "oversize identity fails explicitly instead of losing a target or silently dropping rows");
});

test("v5 preserves folded Claude input blockers without choosing a different terminal or exposing authority", () => {
  const control = { id: "terminal:v2:herdr:claude:fixture:w1:p1:123", agent: "claude",
    physical_send_readiness: { ready: false, reason: "stash_not_empty", message: "Save the stashed draft first.", token: "private-anchor" } };
  const base = { conversation_id: "claude-cli:v1:folded", source: "claude_cli", agent: "claude", activity_state: "idle",
    terminal_controls: [control], capabilities: { send: false }, available_actions: { status: { tool: "agent_knock_knock_status" } } };
  const project = (extra: Row = {}, version = 5) => (compactAkkListModelProjection({ conversations: [{ ...base, ...extra }] },
    { listProjectionVersion: version }) as Row).conversations[0];
  const legacy = project({}, 4);
  assert.equal(legacy.physical_send_readiness, undefined); assert.match(JSON.stringify(legacy.usage), /stashed draft/u);
  const output = project();
  assert.deepEqual(output.physical_send_readiness, { ready: false, reason: "stash_not_empty", message: "Save the stashed draft first." });
  assert.equal(output.available_actions.send, undefined); assert.doesNotMatch(JSON.stringify(output), /private-anchor/u);
  assert.deepEqual(project({ physical_send_readiness: { ready: false, reason: "composer_not_empty" } }).physical_send_readiness,
    { ready: false, reason: "composer_not_empty" });
  assert.equal(project({ physical_send_readiness: null }).physical_send_readiness, null, "explicit unknown does not inherit a control's state");
  assert.equal(project({ terminal_controls: [control, { ...control, id: "other-terminal" }] }).physical_send_readiness, undefined);
  assert.equal(project({ source: "codex_cli", agent: "codex" }).physical_send_readiness, undefined);
  assert.equal(control.physical_send_readiness.token, "private-anchor", "raw input is unchanged");
});
