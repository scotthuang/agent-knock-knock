import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeNativeListForCli } from "../src/claude-native-cli-adapter.js";
import { codexNativeListForCli } from "../src/codex-native-cli-adapter.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { runCliCommandExecution, type CliCommandDependencies } from "../src/cli-runtime-context.js";
import { listDesktopSessions } from "../src/desktop-list.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { VERIFIED_DESKTOP_BUILD } from "../src/desktop-ipc-client.js";
import type { DesktopRuntime } from "../src/desktop-runtime.js";
import { createTerminalListCliFacade, type TerminalListCliDependencies } from "../src/terminal-list-cli-adapter.js";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";

type Row = Record<string, any>;
function isolatedHome(t: { after(callback: () => void): void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-discovery-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test("Codex conversation discovery never enumerates retained Watches and keeps native Send authority", async t => {
  const home = isolatedHome(t), identity = { codexHome: path.join(home, ".codex"), threadId: "fixture-thread" };
  let watchReads = 0, closes = 0, nativeReads = 0;
  const runtime = {
    catalog: { async discover() { return { sessions: [{ ...identity, backendVersion: "0.162.1",
      thread: { id: identity.threadId, cwd: home, status: { type: "idle" } } }], errors: [] }; } },
    async clientFor() { return { async readSnapshot() {
      nativeReads++;
      return { threadId: identity.threadId, thread: { id: identity.threadId, cwd: home, status: { type: "idle" } },
        loaded: true, latestTurnId: null, turns: [], pendingInteractions: [], canSend: true };
    } }; },
    tasks: { list() { watchReads++; throw new Error("Historical Watch store must not be read by List"); } },
    async close() { closes++; }
  };
  let result: Row = {};
  await runCliCommandExecution("codex-cli-list", {}, {
    cwd: home, env: { HOME: home }, runtimeLog() {},
    createCodexNativeRuntime: (() => runtime) as unknown as CliCommandDependencies["createCodexNativeRuntime"]
  }, async () => { result = await codexNativeListForCli({}); });
  assert.equal(watchReads, 0); assert.equal(nativeReads, 0, "List uses discovery summaries without hydrating task details"); assert.equal(closes, 1);
  assert.equal(result.codex_cli_scan.status, "ok");
  assert.equal(result.codex_cli_watches, undefined);
  assert.equal(result.codex_cli_scan.watch_error, undefined);
  assert.equal(result.codex_cli_sessions[0].conversation_id, createCodexNativeConversationId(identity));
  assert.equal(result.codex_cli_sessions[0].capabilities.send, true);
});

test("Claude conversation discovery never enumerates retained Watches and preserves waiting state", async t => {
  const home = isolatedHome(t);
  let watchReads = 0, closes = 0;
  const runtime = {
    catalog: { async discover() { return { sessions: [{ configDir: path.join(home, ".claude"),
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", pid: 42, processStart: "Sun Oct 18 01:02:03 2026",
      cwd: home, version: "2.1.296", status: "waiting", waitingFor: "permission prompt" }], errors: [] }; } },
    tasks: { list() { watchReads++; throw new Error("Historical Watch store must not be read by List"); } },
    async close() { closes++; }
  };
  let result: Row = {};
  await runCliCommandExecution("claude-cli-list", {}, {
    cwd: home, env: { HOME: home }, runtimeLog() {},
    createClaudeNativeRuntime: (() => runtime) as unknown as CliCommandDependencies["createClaudeNativeRuntime"]
  }, async () => { result = await claudeNativeListForCli({}); });
  assert.equal(watchReads, 0); assert.equal(closes, 1);
  assert.equal(result.claude_cli_scan.status, "ok");
  assert.deepEqual(result.claude_cli_scan.reader, { executable: "claude", source: "default", path_omitted: false });
  assert.equal(result.claude_cli_watches, undefined);
  assert.equal(result.claude_cli_sessions[0].attention_required, true);
  assert.equal(result.claude_cli_sessions[0].capabilities.send, false);
  assert.equal(result.claude_cli_sessions[0].next_action, "return_to_claude_terminal");
});

test("Claude reader failures survive raw List and Host compact projection even with no sessions", async t => {
  const home = isolatedHome(t), errors = [
    { configDir: path.join(home, "private-root-a"), code: "claude_reader_unavailable" },
    { configDir: path.join(home, "private-root-b"), code: "claude_reader_unavailable" }
  ];
  const runtime = { catalog: { async discover() { return { sessions: [], errors }; } }, async close() {} };
  for (const configured of [false, true]) {
    const options = { storeDir: path.join(home, "store") };
    const dependencies = {
      discovery: {
        createRuntimeTerminalAgentRegistry: () => ({ get: () => undefined, list: () => [] }),
        createTerminalControlProvider: () => ({}),
        createTerminalAgentBridge: () => ({ listProcesses: async () => [] }),
        createTerminalProcessSource: () => ({ listProcessSnapshots: async () => [] }),
        localCodexList: claudeNativeListForCli
      },
      reconciliation: {}, store: { isDiscoverableTmuxConversation: () => true, matchesConfiguredWorkspace: () => true },
      authority: {}, policy: { approvalTtlMs: 60_000, selectorCommands: new Set(), rememberOriginalExpectedTerminalSelector() {} }
    } as unknown as TerminalListCliDependencies;
    const output = await runCliCommandExecution("list", options, {
      cwd: home, env: { HOME: home, ...(configured ? { AKK_NATIVE_CLAUDE_BIN: path.join(home, "private-install", "tclaude") } : {}) },
      runtimeLog() {}, createClaudeNativeRuntime: (() => runtime) as unknown as CliCommandDependencies["createClaudeNativeRuntime"]
    }, () => createTerminalListCliFacade(dependencies).runList(options));
    const raw = JSON.parse(output.stdout), compact = compactAkkListModelProjection(raw) as Row;
    for (const result of [raw, compact]) {
      assert.deepEqual(result.conversations, []);
      assert.equal(result.claude_cli_scan.status, "partial");
      assert.equal(result.claude_cli_scan.complete, false);
      assert.deepEqual(result.claude_cli_scan.reader, { executable: configured ? "tclaude" : "claude",
        source: configured ? "environment" : "default", path_omitted: configured });
      assert.deepEqual(result.claude_cli_scan.error_codes, ["claude_reader_unavailable"]);
      assert.equal(result.claude_cli_scan.error_count, 2);
      assert.equal(result.claude_cli_scan.next_action, "check_claude_reader_in_host_environment");
    }
    assert.deepEqual(raw.claude_cli_scan.diagnostics, errors);
    assert.equal(compact.claude_cli_scan.diagnostics, undefined);
    assert.equal(JSON.stringify(compact).includes(home), false);
  }
});

test("Desktop discovery retains an unconfirmed sidebar entry without reading Watch history or loading an owner", async t => {
  const home = isolatedHome(t), identity = { codexHome: home, hostId: "local", threadId: "desktop-fixture" };
  let watchReads = 0, ownerReads = 0;
  const runtime = { compatibility: VERIFIED_DESKTOP_BUILD,
    catalog: { async list() { return { sessions: [{ ...identity, conversationId: createDesktopConversationId(identity),
      title: "Unconfirmed sidebar entry", cwd: home, updatedAtMs: 1_700_000_000_000, localVerifiable: true, provenance: [],
      catalogMembership: "desktop_catalog", sidebar: { section: "project", projectId: "fixture" } }],
      total: 1, historyTotal: 400, complete: true, sources: [] }; } },
    transport: { async observe() { ownerReads++; throw new Error("Fixture has no running Desktop owner"); } },
    tasks: { list() { watchReads++; throw new Error("Historical Watch store must not be read by List"); } }
  } as unknown as DesktopRuntime;
  const result = await listDesktopSessions(runtime, {});
  assert.equal(watchReads, 0); assert.equal(ownerReads, 0);
  assert.equal((result as Row).desktop_watches, undefined);
  assert.equal(result.desktop_sessions.length, 1);
  assert.equal(result.desktop_sessions[0].conversation_id, createDesktopConversationId(identity));
  assert.equal(result.desktop_sessions[0].capabilities && (result.desktop_sessions[0].capabilities as Row).send, false);
  assert.equal(result.desktop_sessions[0].observation_error, "desktop_not_running");
});

test("raw public List does not scan Watch stores or reconcile and strips legacy history after current controls", async t => {
  const home = isolatedHome(t);
  let watchReads = 0, reconciliationCalls = 0;
  const currentTurn = { turn_id: "current-turn", status: "waiting_for_agent" };
  const input = { conversation_id: "fixture-native", source: "codex_cli", agent: "codex", cwd: home,
    connection_state: "loaded_backend_verified", managed: { current_turn: currentTurn,
      recent_turn: { turn_id: "old-turn" }, history: [{ turn_id: "old-turn" }], turn_count: 2, hidden_turn_count: 1 },
    blocking_turns: [{ turn_id: "current-turn" }], approval_state: { blocked: true },
    available_actions: { status: { tool: "agent_knock_knock_status", input: { conversation_id: "fixture-native" } } } };
  const forbiddenWatchRead = () => { watchReads++; throw new Error("List must not read Watch history"); };
  const dependencies = {
    reconciliation: { reconcileMonitors() { reconciliationCalls++; throw new Error("Unexpected reconcile"); },
      reconcileIdleConversations() { reconciliationCalls++; throw new Error("Unexpected reconcile"); } },
    discovery: {
      createRuntimeTerminalAgentRegistry: () => ({ get: () => undefined, list: () => [] }),
      createTerminalControlProvider: () => ({}),
      createTerminalAgentBridge: () => ({ listProcesses: async () => [] }),
      createTerminalProcessSource: () => ({ listProcessSnapshots: async () => [] }),
      localCodexList: async () => ({ codex_cli_sessions: [input], codex_cli_watches: [{ watch_id: "legacy-history" }] })
    },
    store: { isDiscoverableTmuxConversation: () => true, matchesConfiguredWorkspace: () => true,
      listTerminalWatches: forbiddenWatchRead, scanTerminalWatchesForExactObservation: forbiddenWatchRead },
    authority: {}, policy: { approvalTtlMs: 60_000, selectorCommands: new Set(), rememberOriginalExpectedTerminalSelector() {} }
  } as unknown as TerminalListCliDependencies;
  const facade = createTerminalListCliFacade(dependencies);
  const options = { storeDir: path.join(home, "store") };
  const output = await runCliCommandExecution("list", options, { cwd: home, env: { HOME: home }, runtimeLog() {} },
    () => facade.runList(options));
  const result = JSON.parse(output.stdout);
  assert.equal(watchReads, 0); assert.equal(reconciliationCalls, 0);
  assert.equal(result.conversations.length, 1);
  for (const field of ["codex_cli_watches", "terminal_watches", "unavailable_managed_turns", "managed_turns"]) assert.equal(result[field], undefined);
  for (const row of [result.conversations[0], result.codex_cli_sessions[0]]) {
    assert.deepEqual(row.managed.current_turn, currentTurn);
    assert.equal(row.managed.history, undefined); assert.equal(row.managed.recent_turn, undefined);
    assert.deepEqual(row.blocking_turns, input.blocking_turns);
    assert.deepEqual(row.approval_state, input.approval_state);
    assert.deepEqual(row.available_actions, input.available_actions);
  }
  assert.equal(input.managed.history.length, 1, "Presentation must not mutate the original ownership evidence");
});
