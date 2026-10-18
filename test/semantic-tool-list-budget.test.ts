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


test("conversation pagination is stable when discovery is reordered and retains unconfirmed Desktop entries", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...conversations[1], conversation_id: `desktop-${i}`, connection_state: "live_owner_not_confirmed" }));
  const first = compactAkkListModelProjection({ conversations: rows }, { listLimit: 10 }) as Row;
  const second = compactAkkListModelProjection({ conversations: [...rows].reverse() }, first.pagination.next_args) as Row;
  assert.equal(new Set([...first.conversations, ...second.conversations].map(row => row.conversation_id)).size, 20);
  assert.equal(second.pagination.has_more, false);
  assert.ok(first.conversations.every((row: Row) => row.connection_state === "live_owner_not_confirmed"));
});
