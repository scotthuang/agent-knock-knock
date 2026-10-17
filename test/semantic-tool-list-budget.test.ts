import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";
import { HOST_LIST_MAX_BYTES, HOST_LIST_MAX_WEIGHTED_CHARS, hostListWeightedChars } from "../src/semantic-tool-list-budget.js";
import { createAkkSemanticToolCatalog } from "../src/semantic-tool-runtime.js";
import { bindSemanticToolRelayPath } from "../src/semantic-tool-relay.js";

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
function ids(value: Row): string[] { return Object.entries(value).flatMap(([key, rows]) => key.endsWith("_watches") ? rows.map((row: Row) => row.watch_id) : []); }

test("large ended history cannot bury CLI/Desktop conversations or unresolved observations", () => {
  const data = { conversations, codex_cli_watches: Array.from({ length: 2_000 }, (_, i) => watch(i)),
    desktop_watches: [watch(2_001, "watching", "monitoring"), watch(2_002, "completed", "failed"), watch(2_003, "completed", "uncertain"),
      { ...watch(2_004), pending_async_count: 1 }, watch(2_005, "timed_out")], terminal_watches: [
      { watch_id: "terminal-watch-pending", status: "completed", callback: { pending: 1 } }
    ] };
  const result = compactAkkListModelProjection(data) as Row;
  bounded(result);
  assert.equal(result.projection.version, 3);
  assert.deepEqual(result.conversations.map((row: Row) => row.conversation_id), conversations.map(row => row.conversation_id));
  assert.equal(Object.keys(result)[1], "conversations");
  assert.equal(result.codex_cli_watches.length, 0);
  assert.equal(result.desktop_watches.length, 4);
  assert.equal(result.terminal_watches.length, 1);
  assert.equal(result.watch_summary.history, 2_001);
  assert.equal(result.watch_summary.current, 5);
  assert.deepEqual(result.pagination.attention_counts, { failed_callback: 1, uncertain_callback: 1, pending_callback: 1, pending_interaction: 1, observation_error: 0 });
  assert.equal(result.pagination.has_more, false);
  assert.equal(data.codex_cli_watches.length, 2_000, "raw CLI/operator data is not mutated");
});

test("all/history pages retain every exact identity once, bound bytes and provide actionable continuation", () => {
  const data = { conversations, codex_cli_watches: Array.from({ length: 140 }, (_, i) => ({ ...watch(i),
    callback_notifications: Array.from({ length: 5 }, (_, n) => ({ id: `notice-${i}-${n}`, status: "accepted", attempts: 1 })) })) };
  let args: Row = { all: true, listLimit: 100 };
  const seen: string[] = [];
  let pages = 0;
  do {
    const page = compactAkkListModelProjection(data, args) as Row;
    bounded(page); seen.push(...ids(page)); pages++;
    assert.equal(page.pagination.view, "all");
    args = page.pagination.next_args;
  } while (args && pages < 20);
  assert.ok(pages > 1); assert.equal(args, null);
  assert.deepEqual([...seen].sort(), data.codex_cli_watches.map((row: Row) => row.watch_id).sort());
  const history = compactAkkListModelProjection(data, { listView: "history", listLimit: 1 }) as Row;
  assert.deepEqual(history.conversations, []);
  assert.equal(ids(history).length, 1);
  assert.throws(() => compactAkkListModelProjection(data, { ...history.pagination.next_args, agent: "claude" }), /changed filters/u);
  assert.throws(() => compactAkkListModelProjection(data, { listCursor: "invalid" }), /Invalid List cursor/u);
  assert.throws(() => compactAkkListModelProjection(data, { listLimit: 0 }), /listLimit/u);
});

test("large active/attention pages and oversized rows stay bounded without erasing recovery visibility", () => {
  const data = { conversations: Array.from({ length: 80 }, (_, i) => ({ ...conversations[i % 2], conversation_id: `desktop:v1:fixture-${i}`, title: "中文🙂𠀀".repeat(40) })),
    codex_cli_watches: Array.from({ length: 80 }, (_, i) => ({ ...watch(i, "completed", "uncertain"),
      callback_notifications: Array.from({ length: 80 }, (_, n) => ({ id: `note-${i}-${n}`, status: "uncertain", error_code: "failed".repeat(50) })) })) };
  const seen = new Set<string>(); let args: Row | null = {}; let pages = 0; let foundFallback = false;
  do {
    const page = compactAkkListModelProjection(data, args!) as Row;
    bounded(page);
    for (const row of [...page.conversations, ...page.codex_cli_watches]) {
      const id = row.watch_id ?? row.conversation_id;
      assert.equal(seen.has(id), false); seen.add(id);
      if (row.details_omitted) {
        foundFallback = true; assert.equal(row.callback_state, "uncertain");
        assert.equal(row.attention_required, true); assert.equal(row.available_actions.status, true);
        assert.deepEqual(row.action_inputs.status.arguments, { watch_id: id });
        assert.match(row.next_action, /omitted actions are not unsupported/u);
      }
    }
    args = page.pagination.next_args; pages++;
  } while (args && pages < 100);
  assert.equal(args, null); assert.equal(seen.size, 160); assert.equal(foundFallback, true);
});

test("Host List invocation applies params before JSON serialization and keeps history requests at the CLI boundary", async t => {
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
  assert.equal(parsed.conversations.length, 2); assert.equal(parsed.codex_cli_watches.length, 0);
  assert.ok(JSON.parse(fs.readFileSync(calls, "utf8")).includes("--all"), "Host must read old unresolved managed records before selecting current rows");
  const history = await tool.execute({}, "list-history", { listView: "history", listLimit: 2 }) as Row;
  assert.equal(JSON.parse(history.content[0].text).codex_cli_watches.length, 2);
  assert.ok(JSON.parse(fs.readFileSync(calls, "utf8")).includes("--all"));
  const next = await tool.execute({}, "list-next", history.details.pagination.next_args) as Row;
  assert.equal(next.details.codex_cli_watches.length, 2);
  assert.equal(next.details.codex_cli_watches[0].watch_id === history.details.codex_cli_watches[0].watch_id, false);
});


test("terminal managed histories keep unresolved delivery visible and paginate healthy ended records", () => {
  const row = { conversation_id: "terminal:v2:tmux:claude:fixture:0.0:1", source: "terminal_control", agent: "claude", managed: {
    current_turn: { turn_id: "current", status: "waiting_for_agent" },
    history: [
      { turn_id: "old-uncertain", status: "idle", callback_delivery: { status: "uncertain", attempts: 1 } },
      { turn_id: "old-failed", status: "idle", callback_delivery: { status: "failed", attempts: 4 } },
      { turn_id: "old-healthy", status: "idle", callback_delivery: { status: "delivered", attempts: 1 } }
    ]
  } };
  const current = compactAkkListModelProjection({ conversations: [row], unavailable_managed_turns: [
    { turn_id: "missing-terminal-uncertain", status: "idle", callback_delivery: { status: "uncertain" } },
    { turn_id: "missing-terminal-healthy", status: "idle", callback_delivery: { status: "delivered" } }
  ] }) as Row;
  bounded(current);
  assert.deepEqual(current.managed_turns.map((turn: Row) => turn.turn_id).sort(), ["old-failed", "old-uncertain"]);
  assert.equal(current.managed_turns.find((turn: Row) => turn.turn_id === "old-uncertain").callback_delivery.status, "uncertain");
  assert.deepEqual(current.unavailable_managed_turns.map((turn: Row) => turn.turn_id), ["missing-terminal-uncertain"]);
  assert.equal(current.conversations[0].managed.history, undefined);
  assert.equal(current.conversations[0].managed.current_turn.turn_id, "current");
  assert.equal(row.managed.history.length, 3, "raw input remains intact");
  assert.equal(current.pagination.managed_turns.history, 2);
});

test("Unicode diagnostics and all metadata are included in the whole response limit", () => {
  const result = compactAkkListModelProjection({ conversations, codex_cli_scan: { error: "𠀀".repeat(10_000) },
    desktop_scan: { limitations: Array(50).fill("中文".repeat(1_000)) }, recovery: { reason: "長".repeat(1_000) } }) as Row;
  bounded(result); assert.equal(result.conversations.length, 2);
  assert.equal(result.desktop_scan.details_omitted, true);
  assert.equal(result.codex_cli_scan.details_omitted, true);
});


test("pagination is stable when live inventory is reordered and includes the latest ended managed Turn", () => {
  const rows = Array.from({ length: 20 }, (_, i) => watch(i, "watching", "monitoring"));
  const first = compactAkkListModelProjection({ codex_cli_watches: rows }, { listLimit: 10 }) as Row;
  const second = compactAkkListModelProjection({ codex_cli_watches: [...rows].reverse() }, first.pagination.next_args) as Row;
  assert.equal(new Set([...ids(first), ...ids(second)]).size, 20);
  assert.equal(second.pagination.has_more, false);
  // Terminal managed context lives on terminal controls of a direct conversation.
  const terminalHistory = compactAkkListModelProjection({ terminals: [{ id: "terminal:v2:tmux:codex:fixture:0.0:1", managed: {
    recent_turn: { turn_id: "latest-ended", status: "idle" }
  } }] }, { listView: "history" }) as Row;
  assert.equal(terminalHistory.managed_turns[0].turn_id, "latest-ended");
  assert.equal(terminalHistory.pagination.managed_turns.history, 1);
});
