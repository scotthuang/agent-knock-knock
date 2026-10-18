import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCliCommand } from "../src/cli-core.js";
import { createConversation } from "../src/protocol.js";
import { pathsForConversation, saveState } from "../src/store.js";
import { createHostBridgeToolRegistry } from "../src/host-bridge-tools.js";
import { parseWatchListOptions, projectWatchList } from "../src/watch-list-projection.js";
import { HOST_LIST_MAX_BYTES, HOST_LIST_MAX_WEIGHTED_CHARS, hostListWeightedChars } from "../src/semantic-tool-list-budget.js";
import { parseAkkCommand, buildAkkCommandCliArgs, formatAkkListCommandResult } from "../src/semantic-tool-command-helpers.js";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const watch = (id: string, hours: number, extra: Record<string, unknown> = {}) => ({
  watch_id: `codex-cli-watch:${id}`, agent: "codex", source: "codex_cli", conversation_id: "exact-native-conversation",
  status: "completed", created_at: at(hours + 2), updated_at: at(hours), callback_state: "accepted", ...extra
});

test("Watches windows use last activity and retain old unresolved records without private body or authority", () => {
  const result = projectWatchList({ watches: [watch("recent", 23), watch("boundary", 24), watch("too-old", 24.001),
    watch("old-active", 80, { status: "watching" }), watch("old-uncertain", 60, { callback_state: "uncertain" }),
    watch("old-question", 72, { pending_interaction_count: 1 }), watch("fresh-update", 0, { created_at: at(300) }),
    watch("secret-body", 1, { final_text: "PRIVATE_OUTPUT", progress: { text: "PRIVATE_PROGRESS" }, request: "PRIVATE_REQUEST",
      callback_route: { token: "PRIVATE_TOKEN" }, interaction_state: [{ secret: "PRIVATE_ANSWER" }], available_actions: { approve: { secret: "PRIVATE_AUTHORITY" } } })],
    managed_turns: [{ turn_id: "managed-one", source: "managed_turn", status: "stalled", created_at: at(90),
      available_actions: { status: { tool: "agent_knock_knock_status", arguments: { turn_id: "managed-one" } },
        close: { tool: "agent_knock_knock_close", arguments: { turn_id: "managed-one" } }, approve: { private: true } } }] }, {}, now);
  const rows = result.watches as Record<string, unknown>[];
  assert.equal(rows.length, 7);
  assert.ok(rows.find(row => row.watch_id === "codex-cli-watch:boundary"));
  assert.equal(rows.find(row => row.watch_id === "codex-cli-watch:too-old"), undefined);
  for (const id of ["old-active", "old-uncertain", "old-question"]) assert.equal(rows.find(row => row.watch_id === `codex-cli-watch:${id}`)?.outside_window, true);
  const managed = (result.managed_turns as Record<string, any>[])[0];
  assert.equal(managed.kind, "managed_turn");
  assert.deepEqual(Object.keys(managed.available_actions), ["status", "close"]);
  assert.deepEqual(managed.available_actions.close.arguments, { turn_id: "managed-one" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|"approve"/u);
});

test("Watches whole-response budget and cursor cover many histories exactly once with a frozen time window", () => {
  const watches = Array.from({ length: 300 }, (_, i) => watch(`many-${i}`, i / 20, {
    callback_notifications: Array.from({ length: 200 }, () => ({ status: "accepted", private: "hidden" }))
  }));
  const ids: unknown[] = [];
  let args: Record<string, unknown> = { limit: 100 };
  let pages = 0;
  do {
    const result = projectWatchList({ watches, managed_turns: [] }, args, now + pages * 60_000);
    const json = JSON.stringify(result), page = result.pagination as Record<string, any>;
    assert.ok(Buffer.byteLength(json) <= HOST_LIST_MAX_BYTES);
    assert.ok(hostListWeightedChars(json) <= HOST_LIST_MAX_WEIGHTED_CHARS);
    assert.equal((result.window as Record<string, unknown>).as_of, new Date(now).toISOString());
    ids.push(...(result.watches as Record<string, unknown>[]).map(row => row.watch_id));
    args = page.next_args; pages++;
    assert.ok(pages < 100);
  } while (args);
  assert.equal(ids.length, 300); assert.equal(new Set(ids).size, 300); assert.ok(pages > 3);
  const first = projectWatchList({ watches, managed_turns: [] }, { limit: 1 }, now);
  const next = (first.pagination as Record<string, any>).next_args;
  assert.throws(() => projectWatchList({ watches, managed_turns: [] }, { ...next, hours: 48 }, now), /changed filters/u);
  assert.throws(() => parseWatchListOptions({ hours: 49 }, now), /hours/u);
  assert.throws(() => parseWatchListOptions({ limit: 101 }, now), /limit/u);
  assert.throws(() => parseWatchListOptions({ cursor: "not-cursor" }, now), /cursor/u);
});

test("real Watches CLI reads isolated retained records without native discovery, callbacks or Store mutation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-watch-list-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  const conversation = createConversation({ userRequest: "DO_NOT_EXPOSE_TASK", executorKind: "codex", now: new Date(now) });
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const state = paths.statePath;
  saveState(state, { ...conversation, store_dir: paths.storeDir, conversation_dir: paths.conversationDir, event_log_path: paths.logPath, state_path: paths.statePath });
  const before = fs.readFileSync(state, "utf8");
  const snapshot = () => Object.fromEntries((fs.readdirSync(storeDir, { recursive: true }) as string[]).sort().flatMap(relative => {
    const file = path.join(storeDir, relative);
    return fs.statSync(file).isFile() ? [[relative, fs.readFileSync(file, "utf8")]] : [];
  }));
  const beforeFiles = snapshot();
  const fail = (): never => { throw new Error("native connection must not be used by Watches"); };
  const result = await executeCliCommand("watches", { storeDir }, { cwd: root, env: { HOME: root }, now: () => now,
    runtimeLog() {}, createCodexNativeRuntime: fail, createDesktopRuntime: fail, createClaudeNativeRuntime: fail,
    conversationRoutingTerminals: fail, launchCodexNativeMonitor: fail, launchClaudeNativeMonitor: fail, launchDesktopMonitor: fail });
  assert.equal(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.watches, []);
  assert.equal(output.managed_turns.length, 1);
  assert.equal(output.managed_turns[0].turn_id, conversation.turn_id);
  assert.equal(output.managed_turns[0].source, "managed_turn");
  assert.deepEqual(Object.keys(output.managed_turns[0].available_actions), ["status", "close"]);
  assert.doesNotMatch(result.stdout, /DO_NOT_EXPOSE_TASK/u);
  assert.equal(fs.readFileSync(state, "utf8"), before);
  assert.deepEqual(snapshot(), beforeFiles);
  assert.ok(output.diagnostics.every((row: Record<string, unknown>) => row.status === "ok"));
});

test("Host Watches and slash command share the dedicated read-only CLI and legacy List history migrates explicitly", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-watch-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relay = path.join(root, "relay.mjs");
  fs.writeFileSync(relay, "process.stdout.write(JSON.stringify({argv:process.argv.slice(2)}));");
  const registry = createHostBridgeToolRegistry({ relayPath: relay, relayEnvironment: { ...process.env }, pluginConfig: { storeDir: path.join(root, "store") },
    logger: { info() {}, warn() {} }, context: { sessionKey: "controller", sessionId: "incarnation" } });
  const result = await registry.execute("agent_knock_knock_watches", "read-only-query", { hours: 48, limit: 12, conversation_id: "selected-conversation" });
  const output = JSON.parse(result.content!.find(item => item.type === "text")!.text!);
  assert.deepEqual(output.argv, ["watches", "--store-dir", path.join(root, "store"), "--hours", "48", "--limit", "12", "--conversation", "selected-conversation"]);
  for (const params of [{ all: true }, { listView: "history" }, { listView: "all" }]) {
    await assert.rejects(() => registry.execute("agent_knock_knock_list", "legacy-list", params), /agent_knock_knock_watches/u);
  }
  assert.deepEqual(parseAkkCommand("watches"), { action: "watches" });
  assert.deepEqual(buildAkkCommandCliArgs({ action: "watches" }, { storeDir: "store" }), ["watches", "--store-dir", path.resolve("store")]);
  const list = formatAkkListCommandResult({ conversations: [{ conversation_id: "current", surface: "cli", managed: { current_turn: { turn_id: "current-turn", status: "running" },
    recent_turn: { turn_id: "PRIVATE_HISTORY" }, history: [{ turn_id: "PRIVATE_HISTORY" }] } }], terminal_watches: [{ watch_id: "PRIVATE_WATCH" }], unavailable_managed_turns: [{ turn_id: "PRIVATE_OFFLINE" }] });
  assert.match(list, /current-turn/u); assert.doesNotMatch(list, /PRIVATE_/u);
});
