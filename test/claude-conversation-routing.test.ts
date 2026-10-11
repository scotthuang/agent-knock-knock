import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeNativeConversationId } from "../src/claude-native-identity.js";
import { exactClaudeTerminal, claudeProcessBirthMatches } from "../src/claude-conversation-routing-identity.js";
import { dispatchClaudeConversationCli } from "../src/claude-conversation-routing-cli-adapter.js";
import { runCliCommandExecution, type CliCommandDependencies } from "../src/cli-runtime-context.js";
import { unifiedConversationList } from "../src/conversation-list.js";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";

const target = { configDir: "/fixture/.claude", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", pid: 123,
  processStart: "Sun Oct 11 01:00:00 2026" };
const id = createClaudeNativeConversationId(target), terminalId = "terminal:v2:tmux:claude:akk:0.0:123";
const entry = { ...target, nativeId: id, status: "idle", version: "2.1.296", cwd: "/project" };
function localPsTime(utc: string) {
  const date = new Date(`${utc} GMT`), pad = (value: number) => String(value).padStart(2, "0");
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()]} ${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
}
const terminal = { id: terminalId, agent: "claude", source: "terminal", process_state: "active", pid: 123,
  native_agent_process_birth: localPsTime(target.processStart), native_agent_session_id: target.sessionId,
  native_agent_identity_observation: { status: "resolved" }, cwd: "/project",
  available_actions: { send: { arguments: { expected_terminal_token: "existing-authority" } },
    model_options: { arguments: { expected_binding_token: "existing-binding" } } } };

test("Claude associations require exact process incarnation and resolved native session, never cwd", () => {
  assert.equal(exactClaudeTerminal(id, terminal), true);
  assert.equal(exactClaudeTerminal(id, { ...terminal, native_agent_process_birth: undefined,
    _physical_agent_process_birth: localPsTime(target.processStart) }), true);
  assert.equal(exactClaudeTerminal(id, { ...terminal,
    _physical_agent_process_birth: "Sun Oct 11 02:00:00 2026" }), false,
  "explicit physical proof cannot be replaced by a matching native field");
  assert.equal(claudeProcessBirthMatches(target.processStart, localPsTime(target.processStart)), true);
  assert.equal(claudeProcessBirthMatches(target.processStart, "2026-10-11T01:00:00Z"), false);
  for (const change of [{ pid: 124 }, { native_agent_process_birth: "Sun Oct 11 02:00:00 2026" },
    { native_agent_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { native_agent_identity_observation: { status: "verified_absent" } }]) {
    assert.equal(exactClaudeTerminal(id, { ...terminal, ...change }), false);
  }
  const native = { id, conversation_id: id, source: "claude_cli", agent: "claude", activity_state: "idle",
    capabilities: { send: true }, available_actions: { send: { tool: "agent_knock_knock_send", input: { conversation_id: id } } } };
  const listed = unifiedConversationList({ terminals: [terminal], claude_cli_sessions: [native], claude_cli_watches: [] }, [terminal]);
  assert.equal(listed.conversations.length, 1);
  assert.deepEqual(listed.conversations[0].terminal_aliases, [terminalId]);
  assert.equal(listed.conversations[0].route_preference, "claude_native");
  const compact = compactAkkListModelProjection(listed);
  assert.ok(JSON.stringify(compact).includes('"source":"claude_cli"'));
  assert.ok(JSON.stringify(compact).includes('"claude_cli_watches":[]'));
});

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-route-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: Array<{ command: string; options: Record<string, unknown> }> = [];
  let rows: Record<string, unknown>[] = [terminal], entries = [entry], inspectError: Error | undefined, executeError: Error | undefined;
  const runtime = { catalog: { discover: async () => ({ sessions: entries, errors: [] }) },
    inspect: async () => { if (inspectError) throw inspectError; return entry; }, close: async () => {} };
  const dependencies: CliCommandDependencies = { env: { HOME: root, AKK_RUNTIME_DIR: path.join(root, "runtime") }, cwd: root, runtimeLog() {}, createClaudeNativeRuntime: (() => runtime) as any };
  const run = async (command: string, options: Record<string, unknown> = {}) => {
    const result = await runCliCommandExecution(command, options, dependencies, async () => {
      assert.equal(await dispatchClaudeConversationCli(command, { storeDir: path.join(root, "store"), ...options }, {
        terminals: async () => rows,
        execute: async (selectedCommand, selectedOptions) => { calls.push({ command: selectedCommand, options: selectedOptions });
          if (executeError) throw executeError;
          return { source: String(selectedOptions.conversation).startsWith("claude-cli:") ? "claude_cli" : "terminal", status: "observed" }; }
      }), true);
    });
    return JSON.parse(result.stdout);
  };
  return { run, calls, noTerminal() { rows = []; }, noNative() { entries = []; },
    inspectFailure(code: string) { inspectError = Object.assign(new Error(code), { code }); },
    executeFailure() { executeError = new Error("uncertain transport result"); } };
}

test("Claude terminal selectors prefer direct core operations and keep special operations on exact terminal authority", async t => {
  const f = fixture(t);
  for (const command of ["status", "native-inspect", "watch-terminal"]) {
    const result = await f.run(command, { terminal: terminalId });
    assert.equal(result.routing.transport, "claude_native");
    assert.equal(f.calls.at(-1)!.options.conversation, id);
    assert.equal(f.calls.at(-1)!.options.expectedBindingToken, undefined);
  }
  const special = await f.run("model-options", { conversation: id });
  assert.equal(special.routing.transport, "terminal");
  assert.equal(f.calls.at(-1)!.options.expectedBindingToken, "existing-binding");
  assert.equal(f.calls.at(-1)!.options.conversation, terminalId);
});

test("direct-only special operations remain native unavailable results instead of selecting another cwd terminal", async t => {
  const f = fixture(t); f.noTerminal();
  const result = await f.run("model-options", { conversation: id });
  assert.equal(result.routing.transport, "claude_native");
  assert.equal(result.routing.reason, "manual_required");
  assert.equal(f.calls[0].options.conversation, id);
});

test("busy, blocked and unknown verification failures never fall back to PTY", async t => {
  for (const code of ["busy", "blocked", "peer_identity_mismatch", "unknown_schema"]) {
    const f = fixture(t); f.inspectFailure(code);
    await assert.rejects(f.run("send", { conversation: id, message: "task", messageId: code }), new RegExp(code));
    assert.equal(f.calls.length, 0);
  }
});

test("successful Send retries replay the selected receipt even after native inventory disappears", async t => {
  const f = fixture(t);
  const input = { terminal: terminalId, message: "one task", messageId: "stable-one", openclawSession: "controller" };
  const sent = await f.run("send", input); assert.equal(sent.routing.transport, "claude_native");
  f.noNative();
  const retry = await f.run("send", input);
  assert.equal(retry.replayed, true); assert.equal(retry.routing.transport, "claude_native"); assert.equal(f.calls.length, 1);
  await assert.rejects(f.run("send", { ...input, message: "different" }), /different immutable/u);
});

test("uncertain native Send pins the original route on retry and never sends through terminal", async t => {
  const f = fixture(t); f.executeFailure();
  const input = { terminal: terminalId, message: "task", messageId: "uncertain-one" };
  await assert.rejects(f.run("send", input), /uncertain transport/u);
  f.noNative();
  await assert.rejects(f.run("send", input), /uncertain transport/u);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.options.conversation === id));
});

test("missing peer helper before dispatch preserves an exact supported terminal fallback", async t => {
  const f = fixture(t); f.inspectFailure("peer_helper_unavailable");
  const result = await f.run("send", { conversation: id, message: "one task", messageId: "helper-unavailable" });
  assert.equal(result.routing.transport, "terminal");
  assert.equal(f.calls[0].options.conversation, terminalId);
  assert.equal(f.calls[0].options.expectedTerminalToken, "existing-authority");
});
