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
import { createConversationRouteStore, type ConversationRouteChoice } from "../src/conversation-route-store.js";

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
  terminal_control: { kind: "tmux", capabilities: ["screen_status", "send_keys", "terminal_approval", "durable_completion"] },
  activity_state: "idle", approval_state: { scanned: true, blocked: false },
  _claude_managed_send_eligible: true,
  available_actions: { send: { tool: "agent_knock_knock_send", arguments: { selector: terminalId, expected_terminal_token: "existing-authority" } },
    cancel: { tool: "agent_knock_knock_cancel", arguments: { conversation_id: terminalId } },
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
  assert.equal(listed.conversations[0].route_preference, "managed_terminal");
  const compact = compactAkkListModelProjection(listed);
  const displayed = (compact.conversations as Record<string, unknown>[])[0];
  assert.equal(displayed.surface, "cli");
  assert.equal(displayed.agent, "claude");
  assert.equal("source" in displayed, false);
  assert.equal(compact.claude_cli_watches, undefined);
});

test("UTC Claude identity and a local-time physical birth form one exact CLI row", () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = "Asia/Shanghai";
    const physical = { ...terminal, _physical_agent_process_birth: "Sun Oct 11 09:00:00 2026" };
    const native = { id, conversation_id: id, source: "claude_cli", agent: "claude",
      activity_state: "idle", capabilities: { send: true } };
    const listed = unifiedConversationList({ terminals: [physical], claude_cli_sessions: [native],
      claude_cli_watches: [] }, [physical]);
    assert.equal(claudeProcessBirthMatches(target.processStart, physical._physical_agent_process_birth), true);
    assert.equal(listed.conversations.length, 1);
    assert.equal(listed.conversations[0].conversation_id, id);
    assert.deepEqual(listed.conversations[0].terminal_aliases, [terminalId]);
    for (const change of [
      { pid: 124 },
      { _physical_agent_process_birth: "Sun Oct 11 09:00:01 2026" },
      { _physical_agent_process_birth: "日 10月 11 09:00:00 2026" },
      { native_agent_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
    ]) assert.equal(exactClaudeTerminal(id, { ...physical, ...change }), false);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
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
          return { source: String(selectedOptions.conversation).startsWith("claude-cli:") ? "claude_cli" : "terminal",
            agent: "claude", conversation_id: selectedOptions.conversation, status: "observed",
            capabilities: { status: true, cancel: false, set_model: false } }; }
      }), true);
    });
    return JSON.parse(result.stdout);
  };
  return { run, calls, noTerminal() { rows = []; }, terminals(value: Record<string, unknown>[]) { rows = value; }, noNative() { entries = []; },
    pin(messageId: string, canonicalTarget: string, choice: ConversationRouteChoice) {
      createConversationRouteStore(path.join(root, "store"), { acquire: () => () => {} }).reserve({
        controllerSession: "agent:main:main", messageId, requestText: "task", canonicalTarget }, choice);
    },
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

test("Claude native status exposes the same exact terminal controls as List and drops ambiguous counterparts", async t => {
  const f = fixture(t);
  const status = await f.run("status", { conversation: id });
  assert.equal(status.capabilities.cancel, true);
  assert.equal(status.capabilities.model_options, true);
  assert.equal(status.capabilities.set_model, true);
  assert.deepEqual(status.available_actions.cancel, terminal.available_actions.cancel);
  assert.deepEqual(status.terminal_aliases, [terminalId]);
  assert.equal(status.terminal_controls, undefined, "Status must not expose raw terminal discovery or historical screen evidence");
  assert.equal(status.routing.transport, "claude_native");
  for (const rows of [[], [terminal, { ...terminal, id: "terminal:v2:tmux:claude:akk:0.1:123" }],
    [{ ...terminal, native_agent_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]]) {
    f.terminals(rows);
    const unpaired = await f.run("status", { conversation: id });
    assert.equal(unpaired.status, "observed");
    assert.equal(unpaired.capabilities.cancel, false);
    assert.equal(unpaired.capabilities.set_model, false);
    assert.equal(unpaired.terminal_aliases, undefined);
  }
});

test("direct-only special operations remain native unavailable results instead of selecting another cwd terminal", async t => {
  const f = fixture(t); f.noTerminal();
  const result = await f.run("model-options", { conversation: id });
  assert.equal(result.routing.transport, "claude_native");
  assert.equal(result.routing.reason, "manual_required");
  assert.equal(f.calls[0].options.conversation, id);
});

test("native-only Send preserves busy, blocked and unknown verification failures", async t => {
  for (const code of ["busy", "blocked", "peer_identity_mismatch", "unknown_schema"]) {
    const f = fixture(t); f.noTerminal(); f.inspectFailure(code);
    await assert.rejects(f.run("send", { conversation: id, message: "task", messageId: code }), new RegExp(code));
    assert.equal(f.calls.length, 0);
  }
});

test("successful managed Send retries replay the selected receipt after terminal inventory disappears", async t => {
  const f = fixture(t);
  const input = { terminal: terminalId, message: "one task", messageId: "stable-one", openclawSession: "controller" };
  const sent = await f.run("send", input); assert.equal(sent.routing.transport, "terminal");
  assert.equal(sent.routing.terminal_mode, "managed");
  assert.equal(sent.requested_conversation_id, terminalId);
  f.noTerminal();
  const retry = await f.run("send", input);
  assert.equal(retry.replayed, true); assert.equal(retry.routing.transport, "terminal"); assert.equal(f.calls.length, 1);
  await assert.rejects(f.run("send", { ...input, message: "different" }), /different immutable/u);
});

test("uncertain native Send pins the original route on retry and never sends through terminal", async t => {
  const f = fixture(t); f.noTerminal(); f.executeFailure();
  const input = { conversation: id, message: "task", messageId: "uncertain-one" };
  await assert.rejects(f.run("send", input), /uncertain transport/u);
  f.terminals([terminal]);
  await assert.rejects(f.run("send", input), /uncertain transport/u);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.options.conversation === id));
});

test("ordinary Claude Send prefers a managed terminal independently of native helper availability", async t => {
  const f = fixture(t); f.inspectFailure("peer_helper_unavailable");
  const result = await f.run("send", { conversation: id, message: "one task", messageId: "helper-unavailable" });
  assert.equal(result.routing.transport, "terminal");
  assert.equal(f.calls[0].options.conversation, terminalId);
  assert.equal(f.calls[0].options.expectedTerminalToken, "existing-authority");
  assert.equal(f.calls[0].options.routingRequireManagedTurn, true);
  assert.equal(f.calls[0].options.background, true);
  assert.equal(result.requested_conversation_id, id);
  assert.equal(result.routing.policy, "managed_terminal_first");
  assert.equal(result.routing.terminal_mode, "managed");
  f.noNative();
  const terminalOnly = await f.run("send", { terminal: terminalId, message: "task", messageId: "terminal-only" });
  assert.equal(terminalOnly.routing.terminal_mode, "managed");
});

test("explicit physical Claude Send retains its token and original executor semantics", async t => {
  const f = fixture(t);
  f.terminals([{ ...terminal, native_agent_session_id: undefined,
    native_agent_identity_observation: { status: "unknown", window_role: "background_view" },
    _claude_managed_send_eligible: false,
    available_actions: {} }]);
  const input = { conversation: terminalId, message: "Replace the explicitly selected draft",
    messageId: "physical-claude", expectedTerminalToken: "caller-physical-authority" };
  const sent = await f.run("send", input);
  assert.equal(sent.routing.transport, "terminal");
  assert.equal(sent.routing.terminal_mode, undefined);
  assert.equal(f.calls[0].options.conversation, terminalId);
  assert.equal(f.calls[0].options.routingRequireManagedTurn, undefined);
  assert.equal(f.calls[0].options.expectedTerminalToken, input.expectedTerminalToken,
    "the locked terminal executor, not route discovery, must validate the original physical token");
  f.noTerminal();
  assert.equal((await f.run("send", input)).replayed, true);
  assert.equal(f.calls.length, 1);
});

test("a physical token cannot bypass managed eligibility through a native Claude selector", async t => {
  for (const options of [{ conversation: id, expectedTerminalToken: "existing-authority" },
    { conversation: terminalId },
    { conversation: terminalId, expectedTerminalToken: "existing-authority", routingDiscoveredTerminalAuthority: true }]) {
    const f = fixture(t);
    f.terminals([{ ...terminal, _claude_managed_send_eligible: false, managed_send_readiness: {
      ready: false, reason: "claude_completion_monitor_unavailable",
      message: "Check the Claude reader, then refresh List and retry. No task text was sent."
    } }]);
    await assert.rejects(f.run("send", { ...options, message: "task", messageId: "no-bypass" }),
      /Claude managed Send blocked: claude_completion_monitor_unavailable.*Check the Claude reader.*refresh List and retry/u);
    assert.equal(f.calls.length, 0);
  }
});

test("corresponding Claude terminals with busy, blocked, ambiguous or conflicting identity cannot bypass through native Send", async t => {
  for (const rows of [
    [{ ...terminal, activity_state: "working" }],
    [{ ...terminal, approval_state: { scanned: true, blocked: true } }],
    [{ ...terminal, native_agent_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    [{ ...terminal, native_agent_identity_observation: { status: "unknown" } }],
    [{ ...terminal, native_agent_process_birth: "Sun Oct 11 02:00:00 2026" }],
    [{ ...terminal, available_actions: {} }],
    [{ ...terminal, _claude_managed_send_eligible: false }],
    [{ ...terminal, _claude_managed_send_eligible: undefined }],
    [terminal, { ...terminal, id: "terminal:v2:tmux:claude:akk:0.1:123" }]
  ]) {
    const f = fixture(t); f.terminals(rows);
    await assert.rejects(f.run("send", { conversation: id, message: "task" }), /Claude managed Send blocked/u);
    assert.equal(f.calls.length, 0);
  }
});

test("uncertain managed Send retains its mode across retries and never falls back when its terminal vanishes", async t => {
  const f = fixture(t); f.executeFailure();
  const input = { conversation: id, message: "task", messageId: "managed-uncertain" };
  await assert.rejects(f.run("send", input), /uncertain transport/u);
  await assert.rejects(f.run("send", { ...input, expectedTerminalToken: "replacement-process-token" }),
    { code: "conversation_route_conflict" });
  assert.equal(f.calls.length, 1, "a replacement physical token cannot override the selected process incarnation");
  f.terminals([{ ...terminal, activity_state: "waiting", approval_state: { scanned: true, blocked: true },
    _claude_managed_send_eligible: false, available_actions: {} }]);
  await assert.rejects(f.run("send", input), /uncertain transport/u);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.options.routingRequireManagedTurn === true && call.options.conversation === terminalId));
  assert.ok(f.calls.every(call => call.options.expectedTerminalToken === "existing-authority"));
  f.noTerminal();
  await assert.rejects(f.run("send", input), /identity changed/u);
  assert.equal(f.calls.length, 2);
});

test("preexisting native and physical terminal reservations keep their original execution mode", async t => {
  for (const choice of [{ route: "native", targetId: id }, { route: "terminal", targetId: terminalId }] as const) {
    const f = fixture(t), messageId = `legacy-${choice.route}`;
    f.pin(messageId, id, choice);
    const result = await f.run("send", { conversation: id, message: "task", messageId });
    assert.equal(result.routing.transport, choice.route === "native" ? "claude_native" : "terminal");
    assert.equal(result.routing.terminal_mode, undefined);
    assert.equal(f.calls[0].options.routingRequireManagedTurn, undefined);
    assert.equal(f.calls[0].options.conversation, choice.targetId);
  }
});
