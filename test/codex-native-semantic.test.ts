import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { createAkkSemanticToolCatalog } from "../src/semantic-tool-runtime.js";
import { bindSemanticToolRelayPath } from "../src/semantic-tool-relay.js";
import { buildAkkCommandCliArgs, parseAkkCommand, formatAkkListCommandResult,
  formatAkkWatchCommandResult, formatAkkUnwatchCommandResult } from "../src/semantic-tool-command-helpers.js";
import { formatStatusCommandResult, formatSendCommandResult, formatApproveCommandResult } from "../src/semantic-tool-presentation.js";
import { unifiedConversationList } from "../src/conversation-list.js";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";
import { parseCliCommand } from "../src/cli-core.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { dispatchRoutedConversationCli } from "../src/conversation-routing-cli-adapter.js";
import { createCodexNativeRuntime } from "../src/codex-native-runtime.js";
import { CodexNativeError } from "../src/codex-native-types.js";
import { createTerminalWatchCliAdapter } from "../src/terminal-watch-cli-adapter.js";
import { loadTerminalWatch } from "../src/terminal-watch-store.js";
import { createFixture, exactTerminalObservation, record, TASK_ID } from "./terminal-watch-cli-adapter/fixtures.js";
import { approveParameters, respondInteractionParameters, sendParameters, watchParameters, nativeInspectParameters, permissionOptionsParameters, setPermissionsParameters, modelOptionsParameters, setModelParameters } from "../src/semantic-tool-schemas.js";

const identity = { codexHome: "/test/codex-home", threadId: "01a11faa-fe88-7491-80ee-41842ac032e3" };
const conversationId = createCodexNativeConversationId(identity);
const watchId = "codex-cli-watch:11111111-2222-4333-8444-555555555555";
const controller = { sessionKey: "agent:test:direct-cli", sessionId: "controller-one" };
const terminalId = "terminal:v2:tmux:codex:test:0.0:1234";
const response = { interaction_id: "native-question-one", answers: [
  { question_id: "question-one", response_kind: "single_select", selected_option_ids: ["option-green"] }
] };
type Result = { details: Record<string, any>; content: { type: string; text: string }[]; isError?: boolean };

function harness(t: TestContext, pluginConfig: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-native-semantic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const relay = path.join(dir, "relay.cjs"), calls = path.join(dir, "calls.jsonl"), reply = path.join(dir, "reply.json");
  fs.writeFileSync(reply, JSON.stringify({ source: "codex_cli", conversation_id: conversationId, watch_id: watchId,
    native_thread_id: identity.threadId, native_turn_id: "turn-one", status: "watching", delivered: true,
    agent_acceptance: "proven", send_state: "accepted", delivery_receipt: "native_task_verified", callback_expected: true }));
  fs.writeFileSync(relay, `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');const r=JSON.parse(fs.readFileSync(${JSON.stringify(reply)},'utf8'));if(r.__error){process.stderr.write(r.__error);process.exit(1);}process.stdout.write(JSON.stringify(r.__byCommand?.[process.argv[2]]??r));`);
  const owner = { pluginConfig: { storeDir: path.join(dir, "store"), codexHome: identity.codexHome,
    openclawBin: "/test/openclaw", agentHardTimeoutMinutes: 60, ...pluginConfig }, logger: { info() {}, warn() {} } };
  bindSemanticToolRelayPath(owner, relay);
  const catalog = createAkkSemanticToolCatalog(owner, new Map());
  return {
    async execute(name: string, args: Record<string, unknown>, callId = "call-one", context: Record<string, unknown> = controller): Promise<Result> {
      const tool = catalog.tools.find(value => value.name === `agent_knock_knock_${name}`);
      assert.ok(tool);
      return await tool.execute(context, callId, args) as Result;
    },
    calls: (): string[][] => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    reply: (value: unknown) => fs.writeFileSync(reply, JSON.stringify(value))
  };
}
const argument = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

test("Host terminal Watch selectors and CLI --terminal survive routing into exact persistent observation", async t => {
  const fixture = createFixture(t);
  fixture.terminal.id = terminalId;
  const codexHome = path.join(fixture.terminal.cwd, ".codex");
  const h = harness(t, { storeDir: fixture.storeDir, codexHome });
  // Capture the actual Host buildArgs boundary; execute those same arguments below
  // with isolated discovery and the real terminal Watch adapter/Store.
  for (const target of [{ conversation_id: terminalId }, { terminal_id: terminalId }]) {
    await h.execute("watch", { ...target, hardTimeoutMinutes: 37 });
  }
  const invocations = [...h.calls(), ["watch-terminal", "--terminal", terminalId,
    "--store-dir", fixture.storeDir, "--codex-home", codexHome,
    "--openclaw-session", controller.sessionKey, "--openclaw-bin", "/test/openclaw",
    "--hard-timeout-minutes", "37"]];
  const printed: unknown[] = [];
  let callbacks = 0;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {}, acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId: target }) => exactTerminalObservation([fixture.terminal], target),
    loadClaudeAgentRows: () => [], now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000251",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }), terminalIncarnationBlockingTurns: () => [],
    printJson: value => printed.push(value),
    callback: { deliver() { callbacks++; throw new Error("creating an active Watch must not send a notification"); } }
  });
  const watchIds: string[] = [];
  for (const args of invocations) {
    assert.equal(argument(args, "--terminal"), terminalId);
    assert.equal(args.includes("--conversation"), false);
    const { command, options } = parseCliCommand(args);
    const result = await runCliCommandExecution(command, options, {
      cwd: fixture.terminal.cwd, env: { HOME: fixture.terminal.cwd }, runtimeLog() {},
      createCodexNativeRuntime: configuration => createCodexNativeRuntime({ ...configuration,
        clientFactory: async () => { throw new CodexNativeError("closed", "isolated backend unavailable"); } })
    }, async () => {
      assert.equal(await dispatchRoutedConversationCli(command, options, {
        terminals: async () => [fixture.terminal],
        async execute(selectedCommand, selectedOptions) {
          assert.equal(selectedCommand, "watch-terminal");
          await facade.runWatch(selectedOptions);
          return record(printed.at(-1));
        }
      }), true);
    });
    const routed = JSON.parse(result.stdout);
    assert.equal(routed.routing.transport, "terminal");
    const watch = loadTerminalWatch(fixture.storeDir, routed.watch.watch_id);
    watchIds.push(watch.watch_id);
    assert.equal(watch.status, "active");
    assert.equal(watch.terminal.terminal_id, terminalId);
    assert.equal(record(watch.anchor).turn_id, TASK_ID);
    assert.equal(watch.openclaw_session, controller.sessionKey);
    assert.equal(Date.parse(watch.deadline_at) - Date.parse(watch.created_at), 37 * 60_000);
  }
  assert.equal(new Set(watchIds).size, 1, "same controller and exact task reuse the existing Watch");
  assert.equal(facade.listPublicWatches(fixture.storeDir).length, 1);
  assert.equal(callbacks, 0);
});

test("direct CLI Host send/watch/status retain backend identity and stable message routing without terminal discovery", async t => {
  const h = harness(t);
  const result = await h.execute("send", { conversation_id: conversationId, request: "One task" });
  assert.equal(result.details.conversation_id, conversationId);
  assert.equal(result.details.watch_id, watchId);
  assert.equal("turn_id" in result.details, false);
  await h.execute("send", { conversation_id: conversationId, request: "One task" });
  await h.execute("watch", { conversation_id: conversationId });
  await h.execute("status", { conversation_id: conversationId });
  await h.execute("status", { watch_id: watchId });
  await h.execute("unwatch", { watch_id: watchId });
  const calls = h.calls();
  assert.deepEqual(calls.map(args => args[0]), ["send", "send", "watch-terminal", "status", "watch-status", "unwatch-terminal"]);
  assert.equal(argument(calls[0], "--message-id"), argument(calls[1], "--message-id"));
  assert.equal(argument(calls[0], "--message"), "One task");
  assert.equal(argument(calls[0], "--openclaw-bin"), "/test/openclaw");
  for (const args of calls) {
    assert.equal(argument(args, "--openclaw-session"), controller.sessionKey);
    assert.equal(argument(args, "--codex-home"), identity.codexHome);
    assert.equal(args.includes("--terminal"), false);
    assert.equal(args.some(value => /token|fingerprint/u.test(value)), false);
  }
});

test("direct CLI approval and typed answers use exact native interaction targets and no terminal offers", async t => {
  const h = harness(t);
  await h.execute("approve", { conversation_id: conversationId, interaction_id: "approval-one", decision: "reject" });
  await h.execute("approve", { watch_id: watchId, interaction_id: "approval-two" });
  await h.execute("respond_interaction", { conversation_id: conversationId, ...response });
  const multiple = [response.answers[0], { question_id: "question-two", response_kind: "free_text", text: "Second answer" }];
  await h.execute("respond_interaction", { watch_id: watchId, ...response, answers: multiple, delivery_mode: "steer_current_turn" });
  const calls = h.calls();
  assert.deepEqual(calls.map(args => args[0]), ["approve", "approve", "respond-interaction", "respond-interaction"]);
  assert.equal(argument(calls[0], "--decision"), "reject");
  assert.equal(argument(calls[1], "--decision"), "approve_once");
  assert.equal(argument(calls[1], "--watch"), watchId);
  assert.deepEqual(JSON.parse(argument(calls[2], "--response-json")!), response);
  assert.equal(JSON.parse(argument(calls[3], "--response-json")!).delivery_mode, "steer_current_turn");
  assert.deepEqual(JSON.parse(argument(calls[3], "--response-json")!).answers, multiple);
  for (const args of calls) assert.equal(argument(args, "--codex-home"), identity.codexHome);
});

test("send-derived digest Watch IDs work across native Host status, responses and unwatch", async t => {
  const h = harness(t);
  const digestWatchId = `codex-cli-watch:${"a".repeat(64)}`;
  h.reply({ source: "codex_cli", conversation_id: conversationId, watch_id: digestWatchId, state: "sent" });
  const approval = { watch_id: digestWatchId, interaction_id: "approval-one", decision: "approve_once" };
  const answer = { watch_id: digestWatchId, ...response };
  assert.equal(new AjvJsonSchemaValidator().getValidator(approveParameters)(approval).valid, true);
  assert.equal(new AjvJsonSchemaValidator().getValidator(respondInteractionParameters)(answer).valid, true);
  await h.execute("status", { watch_id: digestWatchId });
  await h.execute("approve", approval);
  await h.execute("respond_interaction", answer);
  await h.execute("unwatch", { watch_id: digestWatchId });
  assert.deepEqual(h.calls().map(args => args[0]), ["watch-status", "approve", "respond-interaction", "unwatch-terminal"]);
  for (const args of h.calls()) assert.equal(argument(args, "--watch"), digestWatchId);
  for (const command of ["status", "unwatch"]) {
    const args = buildAkkCommandCliArgs(parseAkkCommand(`${command} ${digestWatchId}`), {}, controller)!;
    assert.equal(argument(args, "--watch"), digestWatchId);
  }
});

test("direct CLI permissions use backend presets without demanding terminal UI offers", async t => {
  const h = harness(t);
  h.reply({ source: "codex_cli", conversation_id: conversationId, agent: "codex", scope: "current_session",
    current: "default", choices: [{ id: "full-access", label: "Full Access", description: "Unrestricted" }] });
  await h.execute("native_inspect", { conversation_id: conversationId, inspection: "status" });
  await h.execute("permission_options", { conversation_id: conversationId });
  h.reply({ source: "codex_cli", conversation_id: conversationId, scope: "current_session", defaults_changed: false,
    do_not_retry: false, outcome: "changed", requested: { mode: "full-access" }, effective: { mode: "full-access" } });
  const result = await h.execute("set_permissions", { conversation_id: conversationId, mode: "full-access" });
  assert.equal(result.isError, undefined);
  const calls = h.calls();
  assert.deepEqual(calls.map(args => args[0]), ["native-inspect", "native-inspect", "set-permissions"]);
  assert.equal(argument(calls[0], "--action"), "status");
  assert.equal(argument(calls[1], "--action"), "permissions");
  assert.equal(argument(calls[2], "--mode"), "full-access");
});

test("native inspection relay errors retain a JSON error envelope and never imply a safe retry", async t => {
  const h = harness(t);
  const diagnostic = "native status inspection Enter was dispatched exactly once, but a fresh exact status result was not proven; do not retry automatically";
  h.reply({ __error: diagnostic });
  const failed = await h.execute("native_inspect", { conversation_id: terminalId, inspection: "status" });
  assert.equal(failed.isError, true);
  assert.deepEqual(JSON.parse(failed.content[0].text), failed.details);
  assert.deepEqual(failed.details, {
    status: "error", inspection: "status", error_code: "AKK_NATIVE_INSPECTION_FAILED",
    message: diagnostic, do_not_retry: true, safe_to_retry: false
  });
  assert.deepEqual(h.calls().map(args => args[0]), ["native-inspect"]);

  h.reply({ __error: "terminal token private-terminal-authority is invalid" });
  const privateFailure = await h.execute("native_inspect", { conversation_id: conversationId, inspection: "status" });
  assert.equal(privateFailure.isError, true);
  assert.doesNotMatch(privateFailure.content[0].text, /private-terminal-authority/u);
  assert.match(privateFailure.details.message, /private authority changed/u);
  assert.equal(privateFailure.details.do_not_retry, true);
  await assert.rejects(h.execute("native_inspect", { conversation_id: conversationId, inspection: "usage" }), /inspection must be status/u);
  assert.equal(h.calls().length, 2, "invalid parameters are rejected before relay execution");
});

test("native response tools distinguish unconfirmed dispatch from failed or uncertain responses", async t => {
  const h = harness(t);
  for (const name of ["approve", "respond_interaction"]) {
    const params = name === "approve"
      ? { conversation_id: conversationId, interaction_id: "approval-one", decision: "approve_once" }
      : { conversation_id: conversationId, ...response };
    for (const state of ["reserved", "not_sent", "uncertain", "sent", "confirmed"]) {
      h.reply({ source: "codex_cli", conversation_id: conversationId, interaction_id: params.interaction_id,
        response_id: "response-one", state, ...(state === "confirmed" ? { evidence: "native_task_continued" } : {}), resend_allowed: false });
      const result = await h.execute(name, params);
      assert.equal(result.isError, ["reserved", "not_sent", "uncertain"].includes(state) ? true : undefined);
      assert.equal(result.details.state, state);
      assert.equal(result.details.evidence, state === "confirmed" ? "native_task_continued" : undefined);
      assert.equal("turn_id" in result.details, false);
    }
  }
});

test("native semantic validation rejects mixed identities and malformed responses before relay", async t => {
  const h = harness(t);
  for (const extra of [{ terminal_id: terminalId }, { turn_id: "turn-one" }, { watch_id: watchId }, { session_id: "session-one" }]) {
    await assert.rejects(h.execute("send", { conversation_id: conversationId, request: "No send", ...extra }));
  }
  for (const args of [
    { conversation_id: conversationId, ...response, delivery_mode: "queue_next_turn" },
    { conversation_id: conversationId, ...response, answers: [{ ...response.answers[0], text: "mixed" }] },
    { conversation_id: conversationId, ...response, answers: [response.answers[0], response.answers[0]] },
    { conversation_id: conversationId, ...response, answers: [{ question_id: "q", response_kind: "free_text", text: "bad\u0000control" }] },
    { watch_id: watchId, turn_id: "turn-one", ...response }
  ]) await assert.rejects(h.execute("respond_interaction", args));
  await assert.rejects(h.execute("approve", { conversation_id: conversationId }), /interaction_id/u);
  await assert.rejects(h.execute("set_permissions", { conversation_id: conversationId, mode: "arbitrary-profile" }));
  await assert.rejects(h.execute("unwatch", { watch_id: "codex-cli-watch:../../escape" }));
  await assert.rejects(h.execute("watch", { conversation_id: conversationId }, "call", {}), /controller session/iu);
  assert.deepEqual(h.calls(), []);
});

test("native JSON answers preserve multiline text while terminal schemas retain single-line restrictions", async t => {
  const h = harness(t);
  const text = "First line\nSecond\tcolumn\r\nThird line";
  const answer = { interaction_id: "question-native", answers: [{ question_id: "q-one", response_kind: "free_text", text }] };
  const validate = new AjvJsonSchemaValidator().getValidator(respondInteractionParameters);
  for (const target of [{ conversation_id: conversationId }, { watch_id: watchId }]) {
    assert.equal(validate({ ...target, ...answer }).valid, true);
    await h.execute("respond_interaction", { ...target, ...answer });
  }
  for (const target of [{ turn_id: "managed-turn-one" }, { watch_id: "terminal-watch-one" }]) {
    assert.equal(validate({ ...target, ...answer }).valid, false);
    assert.equal(validate({ ...target, ...answer, answers: [{ ...answer.answers[0], text: "One line" }] }).valid, true);
  }
  for (const args of h.calls()) assert.equal(JSON.parse(argument(args, "--response-json")!).answers[0].text, text);
  assert.equal(validate({ conversation_id: conversationId, ...answer,
    answers: [{ ...answer.answers[0], text: "bad\u001bcontrol" }] }).valid, false);
});

test("native slash Watch and Status keep exact backend IDs and controller route", () => {
  const config = { codexHome: identity.codexHome };
  for (const command of [`watch ${conversationId}`, `status ${conversationId}`, `status ${watchId}`, `unwatch ${watchId}`]) {
    const args = buildAkkCommandCliArgs(parseAkkCommand(command), config, controller)!;
    assert.equal(argument(args, "--openclaw-session"), controller.sessionKey);
    assert.equal(argument(args, "--codex-home"), identity.codexHome);
    assert.equal(args.includes("--terminal"), false);
  }
  assert.equal(parseAkkCommand(`permissions ${conversationId}`).action, "permission-options");
  assert.equal(parseAkkCommand(`set-permissions ${conversationId} full-access`).action, "set-permissions");
  assert.match(formatAkkListCommandResult({ codex_cli_sessions: [{ conversation_id: conversationId, title: "CLI work" }] }), /CLI work/u);
});

test("native slash presentation reports backend task evidence without invented terminal or managed identities", () => {
  const result = { source: "codex_cli", conversation_id: conversationId, watch_id: watchId,
    native_thread_id: identity.threadId, native_turn_id: "native-turn-one", status: "completed",
    final_text: "Verified result", send_state: "accepted", agent_acceptance: "proven", callback_expected: false,
    callback_notifications: [{ status: "accepted" }] };
  for (const format of [formatStatusCommandResult, formatSendCommandResult, formatAkkWatchCommandResult, formatAkkUnwatchCommandResult]) {
    const text = format(result);
    assert.match(text, /native task: native-turn-one/u);
    assert.match(text, /completion: Verified result/u);
    assert.doesNotMatch(text, /(?:^|\n)(?:terminal|session|turn):/u);
  }
  const responseText = formatApproveCommandResult({ ...result, state: "sent" });
  assert.match(responseText, /dispatched; native effect is not yet confirmed/u);
  assert.doesNotMatch(responseText, /AKK approved|session:|terminal:/u);
});


test("listed Codex terminal conversation IDs defer transport authority to the router and preserve backend receipts", async t => {
  const h = harness(t);
  const nativeReceipt = { source: "codex_cli", conversation_id: conversationId, watch_id: watchId,
    native_thread_id: identity.threadId, native_turn_id: "turn-one", status: "watching", delivered: true,
    agent_acceptance: "proven", send_state: "accepted", delivery_receipt: "native_task_verified", callback_expected: true };
  const list = { terminals: [{ id: terminalId, available_actions: {
    send: { tool: "agent_knock_knock_send", arguments: { terminal_id: terminalId, expected_terminal_token: "private-current-terminal" } },
    native_inspect: { tool: "agent_knock_knock_native_inspect", arguments: { terminal_id: terminalId, expected_binding_token: "private-current-binding" } }
  } }] };
  h.reply({ __byCommand: { list, send: nativeReceipt, status: nativeReceipt,
    "watch-terminal": nativeReceipt, "native-inspect": nativeReceipt } });
  const sent = await h.execute("send", { conversation_id: terminalId, request: "Send once" });
  assert.deepEqual(sent.details, nativeReceipt, "A backend receipt must not acquire terminal dispatch or managed Turn fields");
  await h.execute("watch", { conversation_id: terminalId });
  await h.execute("status", { conversation_id: terminalId });
  await h.execute("native_inspect", { conversation_id: terminalId, inspection: "status" });
  const calls = h.calls();
  assert.deepEqual(calls.map(args => args[0]), ["send", "watch-terminal", "status", "native-inspect"]);
  assert.equal(argument(calls[0], "--conversation"), terminalId);
  assert.equal(argument(calls[0], "--expected-terminal-token"), undefined);
  assert.equal(argument(calls[1], "--terminal"), terminalId);
  assert.equal(argument(calls[3], "--expected-binding-token"), undefined);
  for (const index of [0, 1, 2, 3]) {
    assert.equal(argument(calls[index], "--openclaw-session"), controller.sessionKey);
    assert.equal(argument(calls[index], "--codex-home"), identity.codexHome);
  }
  h.reply({ __byCommand: { list, send: { ...nativeReceipt, send_state: "uncertain", delivered: false, agent_acceptance: "unproven" } } });
  const uncertain = await h.execute("send", { conversation_id: terminalId, request: "One attempt" }, "another-call");
  assert.equal(uncertain.isError, true);
  assert.equal(uncertain.details.send_state, "uncertain");
  assert.deepEqual(h.calls().slice(calls.length).map(args => args[0]), ["send"], "Uncertainty never triggers another transport attempt in the Host");
});

test("unified terminal conversation targets reject competing identities before any relay", async t => {
  const h = harness(t);
  for (const operation of ["send", "watch", "native_inspect"]) {
    const fields = operation === "send" ? { request: "No send" } : operation === "native_inspect" ? { inspection: "status" } : {};
    for (const extra of [{ terminal_id: terminalId }, { turn_id: "turn-one" }, { session_id: "session-one" }, { watch_id: watchId }]) {
      await assert.rejects(h.execute(operation, { conversation_id: terminalId, ...fields, ...extra }), /no other target/u);
    }
  }
  assert.deepEqual(h.calls(), []);
  for (const [schema, fields] of [[sendParameters, { request: "One task" }], [watchParameters, {}], [nativeInspectParameters, { inspection: "status" }]] as const) {
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    assert.equal(validate({ conversation_id: terminalId, ...fields }).valid, true);
    assert.equal(validate({ conversation_id: "terminal:invalid", ...fields }).valid, false);
    assert.equal(validate({ conversation_id: terminalId, terminal_id: terminalId, ...fields }).valid, false);
  }
  assert.equal(new AjvJsonSchemaValidator().getValidator(respondInteractionParameters)(
    { conversation_id: terminalId, ...response }).valid, false, "Questions require the displayed native conversation, Watch or Turn authority");
});


test("unified List presents CLI and Desktop once while retaining actions, offline rows and Watches", () => {
  const otherTerminal = "terminal:v2:herdr:claude:default:w1:p4:5678";
  const terminal = { id: otherTerminal, conversation_id: otherTerminal, source: "terminal", agent: "claude",
    route_preference: "terminal", route_status: "terminal_only", available_actions: {
      send: { tool: "agent_knock_knock_send", arguments: { selector: otherTerminal, expected_terminal_token: "PRIVATE_SEND" }, missing_required: ["request"] }
    } };
  const native = { id: conversationId, conversation_id: conversationId, source: "codex_cli", agent: "codex", title: "Shared work",
    backend_version: "0.162.1", connection_state: "loaded_backend_verified",
    route_preference: "codex_backend", route_status: "backend_available", terminal_aliases: [terminalId],
    capabilities: { status: true, send: true }, terminal_controls: [{ id: terminalId, agent: "codex",
      managed: { session_id: "managed-session", current_turn: { turn_id: "managed-turn", status: "working" } },
      blocking_turns: [{ turn_id: "prior-turn", status: "blocked", recovery_action: {
        tool: "agent_knock_knock_close", arguments: { turn_id: "prior-turn", expected_handoff_token: "PRIVATE_HANDOFF" }
      } }],
      available_actions: {
        native_inspect: { tool: "agent_knock_knock_native_inspect", input: { conversation_id: terminalId, inspection: "status", expected_binding_token: "PRIVATE_BINDING" } },
        new_thread: { tool: "agent_knock_knock_new_thread", arguments: { terminal_id: terminalId, expected_binding_token: "PRIVATE_BINDING" } }
      } }], available_actions: {
      send: { tool: "agent_knock_knock_send", arguments: { conversation_id: conversationId }, missing_required: ["request"] },
      native_inspect: { tool: "agent_knock_knock_native_inspect", input: { conversation_id: conversationId, inspection: "status" } },
      new_thread: { tool: "agent_knock_knock_new_thread", arguments: { terminal_id: terminalId, expected_binding_token: "PRIVATE_BINDING" } }
    }, process_incarnation: "PRIVATE_NATIVE" };
  const desktop = { id: "desktop:v1:opaque", conversation_id: "desktop:v1:opaque", source: "codex_desktop", title: "Unloaded sidebar member",
    route_preference: "desktop_ipc", connection_state: "no_live_owner", can_send_reason: "no_live_owner",
    manual_action: "Open this conversation in Desktop, then refresh List.", sidebar_section: "project",
    capabilities: { status: true, send: false, watch: false }, available_actions: {
      status: { tool: "agent_knock_knock_status", arguments: { conversation_id: "desktop:v1:opaque" } }
    }, owner_client_id: "PRIVATE_DESKTOP" };
  const raw = { conversations: [native, terminal, desktop], terminals: [{ id: terminalId }, terminal],
    codex_cli_sessions: [native], desktop_sessions: [desktop],
    conversation_routing: { policy: "backend_first", exact_associations: 1, unresolved_terminals: 0, secret: "PRIVATE_ROUTE" },
    codex_cli_watches: [{ watch_id: watchId, conversation_id: conversationId, status: "watching" }],
    desktop_watches: [{ watch_id: "desktop-watch:12345678", conversation_id: desktop.conversation_id, status: "watching" }],
    terminal_watches: [{ watch_id: "terminal-watch-one", terminal_id: otherTerminal, status: "watching" }],
    desktop_scan: { view: "sidebar", total_candidates: 1, history_candidates: 341, live_count: 0,
      sidebar_selection_scope: "persisted_expanded_membership", limitations: ["Only saved membership is reconstructed."] } };
  const result = compactAkkListModelProjection(raw) as Record<string, any>;
  assert.deepEqual(result.conversations.map(row => row.conversation_id), [conversationId, otherTerminal, desktop.conversation_id]);
  for (const legacy of ["terminals", "codex_cli_sessions", "desktop_sessions"]) assert.equal(legacy in result, false);
  assert.deepEqual(result.conversations.map(row => row.surface), ["cli", "cli", "desktop"]);
  assert.equal(result.conversations[0].agent, "codex");
  assert.equal(result.projection.version, 3);
  assert.equal(result.conversations[0].connected, true);
  assert.equal(result.conversations[2].connection_state, "no_live_owner");
  for (const field of ["source", "route_preference", "route_status", "terminal_aliases", "terminal_controls", "backend_version", "connection_state"]) {
    assert.equal(field in result.conversations[0], false, `${field} is reserved for connection diagnostics`);
  }
  assert.equal(result.conversations[0].managed.session_id, "managed-session");
  assert.equal(result.conversations[0].managed.current_turn.turn_id, "managed-turn");
  assert.equal(result.conversations[0].available_actions.new_thread, true);
  assert.deepEqual(result.conversations[0].blocking_turns[0].recovery_action, { name: "close", arguments: { turn_id: "prior-turn" } });
  assert.deepEqual(result.conversations[0].action_inputs.native_inspect, { arguments: { inspection: "status" } });
  assert.deepEqual(result.conversations[0].action_inputs.new_thread, { arguments: { terminal_id: terminalId } });
  assert.equal(result.conversations[1].available_actions.send, true);
  assert.deepEqual(result.conversations[1].action_inputs.send, { missing_required: ["request"] });
  assert.equal(result.conversations[2].capabilities.send, false);
  assert.equal(result.conversations[2].can_send_reason, "no_live_owner");
  assert.match(result.conversations[2].manual_action, /Open this conversation/u);
  assert.equal(result.desktop_scan.history_candidates, 341);
  assert.deepEqual(result.desktop_scan.limitations, raw.desktop_scan.limitations);
  assert.equal(result.codex_cli_watches[0].watch_id, watchId);
  assert.equal(result.desktop_watches.length, 1);
  assert.equal(result.terminal_watches.length, 1);
  assert.equal("conversation_routing" in result, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
  const command = formatAkkListCommandResult(raw);
  assert.match(command, /AKK conversations \(3; 2 CLI, 1 Desktop\)/u);
  assert.match(command, /CLI conversations:/u);
  assert.match(command, /Desktop conversations:/u);
  assert.match(command, /Watches \(3; observations, not additional conversations\)/u);
  assert.equal(command.split("Shared work").length - 1, 1);
  assert.match(command, /Unloaded sidebar member/u);
  assert.doesNotMatch(command, /associated terminal controls|Direct CLI|live terminals|codex_backend|terminal connection/u);
  assert.match(command, /managed-turn/u);
  const diagnosticRaw = { ...raw, conversation_presentation: { mode: "diagnostics" } };
  const diagnostic = compactAkkListModelProjection(diagnosticRaw) as Record<string, any>;
  assert.deepEqual(diagnostic.conversations[0].terminal_aliases, [terminalId]);
  assert.equal(diagnostic.conversations[0].route_status, "backend_available");
  assert.equal(diagnostic.conversations[0].backend_version, "0.162.1");
  assert.equal(diagnostic.conversations[0].terminal_controls[0].managed.current_turn.turn_id, "managed-turn");
  assert.deepEqual(diagnostic.conversation_routing, { policy: "backend_first", exact_associations: 1, unresolved_terminals: 0 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/u);
  assert.match(formatAkkListCommandResult(diagnosticRaw), /terminal connection:/u);
  const emptyUnified = compactAkkListModelProjection({ conversations: [], terminals: [terminal] });
  assert.deepEqual(emptyUnified.conversations, [], "An intentionally empty unified view never widens to the diagnostic pool");
  assert.equal("terminals" in emptyUnified, false);
});


test("compact unified CLI connections preserve truthful connectivity and each managed recovery target", () => {
  const row = (suffix: string, fields: Record<string, unknown>) => ({ conversation_id: `${conversationId}-${suffix}`,
    source: "codex_cli", agent: "codex", ...fields });
  const projected = compactAkkListModelProjection({ conversations: [
    row("unloaded", { connection_state: "not_loaded", capabilities: { send: false }, available_actions: {} }),
    row("unknown", { connection_state: "unconfirmed", activity_state: "unknown" }),
    row("terminal", { source: "terminal", process_state: "active", terminal_control: { kind: "herdr", target: "pane" } }),
    row("shared", { connection_state: "loaded_backend_verified", terminal_controls: [
      { managed: { session_id: "session-one", current_turn: { turn_id: "turn-one", status: "stalled" } } },
      { managed: { session_id: "session-two", current_turn: { turn_id: "turn-two", status: "blocked" } } }
    ] })
  ] }) as Record<string, any>;
  const bySuffix = (suffix: string) => projected.conversations.find((entry: Record<string, any>) => entry.conversation_id === `${conversationId}-${suffix}`);
  assert.equal(bySuffix("unloaded").connected, false);
  assert.equal(bySuffix("unloaded").capabilities.send, false);
  assert.equal("connected" in bySuffix("unknown"), false, "An unknown connection never becomes connected by presentation");
  assert.equal(bySuffix("terminal").connected, true);
  assert.equal("terminal_control" in bySuffix("terminal"), false);
  assert.deepEqual(bySuffix("shared").control_records.map(record => record.managed.current_turn.turn_id), ["turn-one", "turn-two"]);
  assert.equal("terminal_controls" in bySuffix("shared"), false);
  assert.equal("available_actions" in bySuffix("shared"), false, "Presentation does not infer or union connection actions");
});


test("unified CLI scoped controls preserve exact special targets without advertising another conversation or bypass", () => {
  const second = "terminal:v2:tmux:codex:second:0.0:2233";
  const action = (name: string, target: string, args: Record<string, unknown> = {}) => ({ tool: `agent_knock_knock_${name}`,
    arguments: { terminal_id: target, expected_binding_token: "PRIVATE_SCOPE", ...args } });
  const control = (id: string) => ({ id, permission_control: { status: "supported", scope: "current_session" }, available_actions: {
    model_options: action("model_options", id), native_inspect: action("native_inspect", id, { inspection: "status" }),
    permission_options: action("permission_options", id), send: action("send", id), status: action("status", id),
    watch: action("watch", id), approve: action("approve", id), respond_interaction: action("respond_interaction", id),
    set_permissions: action("set_permissions", id, { mode: "full_access" })
  } });
  const native = { conversation_id: conversationId, source: "codex_cli", agent: "codex", title: "One CLI",
    terminal_aliases: [terminalId, second], terminal_controls: [control(terminalId), control(second), control("not-an-exact-alias")],
    capabilities: { send: true, approve: false }, available_actions: {
      send: { tool: "agent_knock_knock_send", input: { conversation_id: conversationId } }
    } };
  const raw = { conversations: [native] };
  const result = compactAkkListModelProjection(raw) as Record<string, any>;
  assert.equal(result.conversations.length, 1);
  const displayed = result.conversations[0];
  assert.equal(displayed.available_actions.model_options, undefined, "Multiple targets are never promoted to one ambiguous action");
  assert.equal(displayed.capabilities.approve, false);
  assert.deepEqual(displayed.scoped_controls.map(row => row.conversation_id), [terminalId, second]);
  for (const scoped of displayed.scoped_controls) {
    assert.deepEqual(scoped.available_actions, { model_options: true, native_inspect: true, permission_options: true });
    assert.deepEqual(scoped.action_inputs.native_inspect, { arguments: { inspection: "status" } });
    assert.deepEqual(scoped.permission_control, { status: "supported", scope: "current_session" });
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SCOPE|not-an-exact-alias/u);
  const text = formatAkkListCommandResult(raw);
  assert.match(text, /AKK conversations \(1; 1 CLI, 0 Desktop\)/u);
  assert.equal(text.split("One CLI").length - 1, 1);
  assert.match(text, /scoped actions \(conversation_id: terminal:v2:tmux:codex:second:0\.0:2233\): model_options, native_inspect, permission_options/u);
});

test("single exact CLI controls avoid promoted duplicates but retain different permission scope and truthful capabilities", () => {
  const model = { tool: "agent_knock_knock_model_options", input: { terminal_id: terminalId } };
  const permissions = { tool: "agent_knock_knock_permission_options", input: { terminal_id: terminalId }, scope: "current_session" };
  const codex = { conversation_id: conversationId, source: "codex_cli", agent: "codex", terminal_aliases: [terminalId],
    terminal_controls: [{ id: terminalId, available_actions: { model_options: model, permission_options: permissions,
      set_permissions: { tool: "agent_knock_knock_set_permissions", input: { terminal_id: terminalId, mode: "approve_for_me" } } } }],
    capabilities: { model_options: false, set_permissions: false }, available_actions: { model_options: model,
      permission_options: { tool: "agent_knock_knock_permission_options", input: { conversation_id: conversationId }, scope: "native_thread" } } };
  const claude = { conversation_id: "claude-cli:fixture", source: "claude_cli", agent: "claude",
    capabilities: { approve: false, interaction_respond: false }, available_actions: {
      approve: { tool: "agent_knock_knock_approve", arguments: { terminal_id: terminalId } },
      respond_interaction: { tool: "agent_knock_knock_respond_interaction", arguments: { turn_id: "exact-turn" } }
    } };
  const result = compactAkkListModelProjection({ conversations: [codex, claude] }) as Record<string, any>;
  assert.equal(result.conversations[0].capabilities.model_options, true);
  assert.equal(result.conversations[0].capabilities.set_permissions, false, "A scoped offer never becomes an unqualified capability");
  assert.deepEqual(result.conversations[0].scoped_controls[0].available_actions, { permission_options: true, set_permissions: true });
  assert.deepEqual(result.conversations[0].scoped_controls[0].action_inputs.set_permissions, { arguments: { mode: "approve_for_me" } });
  assert.equal(result.conversations[1].capabilities.approve, true);
  assert.equal(result.conversations[1].capabilities.interaction_respond, true);
});


test("native conversation Send normalizes a terminal fallback receipt without inventing native acceptance", async t => {
  const h = harness(t);
  const terminalWatch = "terminal-watch-route-fallback";
  h.reply({ source: "terminal_control", conversation_id: terminalId, requested_conversation_id: conversationId,
    terminal_dispatch_resolved: true, delivered: true, delivered_unmanaged: true,
    delivery_receipt: "enter_dispatched", callback_mode: "terminal_watch", callback_expected: true,
    watch_id: terminalWatch, routing: { policy: "backend_first", transport: "terminal", selected_target: terminalId } });
  const result = await h.execute("send", { conversation_id: conversationId, request: "One fallback task" });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.source, "terminal_control");
  assert.equal(result.details.conversation_id, terminalId);
  assert.equal(result.details.requested_conversation_id, conversationId);
  assert.equal(result.details.terminal_input_dispatched, true);
  assert.equal(result.details.agent_acceptance, "unproven");
  assert.equal(result.details.management_mode, "unmanaged");
  assert.equal(result.details.observation_mode, "terminal_watch");
  assert.equal(result.details.capabilities.callback, true);
  assert.equal(result.details.watch_id, terminalWatch);
  assert.equal("native_turn_id" in result.details, false);
  assert.equal("turn_id" in result.details, false);
  assert.equal(h.calls().length, 1, "The Host does not independently retry or select a physical endpoint");
  assert.equal(argument(h.calls()[0], "--conversation"), conversationId);
});

test("unified List output drives semantic Send, Status, Watch and inspection with one conversation target", async t => {
  const h = harness(t);
  const available_actions = {
    send: { tool: "agent_knock_knock_send", arguments: { terminal_id: terminalId, expected_terminal_token: "PRIVATE_TERMINAL" }, missing_required: ["request"] },
    status: { tool: "agent_knock_knock_status", arguments: { conversation_id: terminalId } },
    watch: { tool: "agent_knock_knock_watch", arguments: { terminal_id: terminalId } },
    native_inspect: { tool: "agent_knock_knock_native_inspect", arguments: { terminal_id: terminalId, inspection: "status", expected_binding_token: "PRIVATE_BINDING" } }
  };
  const terminal = { id: terminalId, source: "terminal", agent: "codex", title: "Unresolved CLI",
    native_identity_state: "verified_absent", available_actions };
  const raw = { terminals: [terminal], codex_cli_sessions: [], desktop_sessions: [] };
  const list = { ...raw, ...unifiedConversationList(raw, [terminal]) };
  const receipt = { source: "terminal_control", conversation_id: terminalId, delivered: true, delivered_unmanaged: true,
    delivery_receipt: "enter_dispatched", callback_expected: false, terminal_dispatch_resolved: true };
  h.reply({ __byCommand: { list, send: receipt, status: receipt, "watch-terminal": receipt, "native-inspect": receipt } });
  const displayed = (await h.execute("list", {})).details;
  assert.equal(displayed.conversations.length, 1);
  for (const hidden of ["terminals", "codex_cli_sessions", "desktop_sessions"]) assert.equal(hidden in displayed, false);
  const row = displayed.conversations[0];
  assert.equal(row.conversation_id, terminalId);
  assert.doesNotMatch(JSON.stringify(displayed), /PRIVATE_/u);
  for (const action of ["send", "status", "watch", "native_inspect"]) {
    assert.equal(row.available_actions[action], true);
    const params = { conversation_id: row.conversation_id, ...row.action_inputs?.[action]?.arguments,
      ...(action === "send" ? { request: "Only this conversation" } : {}) };
    assert.equal("terminal_id" in params, false, "The controller needs only the public conversation ID");
    if (action === "native_inspect") assert.equal(params.inspection, "status");
    await h.execute(action, params);
  }
  assert.deepEqual(h.calls().map(args => args[0]), ["list", "send", "status", "watch-terminal", "native-inspect"]);
  for (const [index, flag] of [[1, "--conversation"], [2, "--conversation"], [3, "--terminal"], [4, "--terminal"]] as const) {
    assert.equal(argument(h.calls()[index], flag), terminalId);
    assert.equal(argument(h.calls()[index], "--openclaw-session"), controller.sessionKey);
  }
  assert.equal(argument(h.calls()[1], "--expected-terminal-token"), undefined);
  assert.equal(argument(h.calls()[4], "--expected-binding-token"), undefined);
});


test("terminal aliases reach backend permissions and native interactions without a terminal UI offer", async t => {
  const h = harness(t);
  h.reply({ source: "codex_cli", conversation_id: conversationId, current: "default", scope: "current_session",
    choices: [{ id: "full-access", label: "Full Access", description: "Current thread" }] });
  await h.execute("permission_options", { conversation_id: terminalId });
  h.reply({ source: "codex_cli", conversation_id: conversationId, outcome: "changed", scope: "current_session",
    defaults_changed: false, do_not_retry: false, requested: { mode: "full-access" }, effective: { mode: "full-access" } });
  const changed = await h.execute("set_permissions", { conversation_id: terminalId, mode: "full-access" });
  assert.equal(changed.isError, undefined);
  const interaction_id = `codex-native-interaction:${"f".repeat(64)}`;
  await h.execute("approve", { conversation_id: terminalId, interaction_id, decision: "reject" });
  await h.execute("respond_interaction", { conversation_id: terminalId, ...response, interaction_id });
  assert.deepEqual(h.calls().map(args => args[0]), ["permission-options", "set-permissions", "approve", "respond-interaction"]);
  for (const args of h.calls()) {
    assert.equal(argument(args, "--terminal") ?? argument(args, "--conversation"), terminalId);
    assert.equal(argument(args, "--openclaw-session"), controller.sessionKey);
    assert.equal(args.some(value => /token|fingerprint/u.test(value)), false);
  }
  for (const name of ["approve", "respond_interaction"]) {
    await assert.rejects(h.execute(name, { conversation_id: terminalId, ...response }), /exact backend interaction_id/u);
  }
  assert.equal(h.calls().length, 4, "An old terminal interaction cannot masquerade as a backend response");
});

test("listed aliases are accepted across permission/model schemas without allowing ambiguous targets", () => {
  for (const [schema, fields] of [[permissionOptionsParameters, {}], [setPermissionsParameters, { mode: "full-access" }],
    [modelOptionsParameters, {}], [setModelParameters, { model: "model-a", reasoning_effort: "high" }]] as const) {
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    assert.equal(validate({ conversation_id: terminalId, ...fields }).valid, true);
    assert.equal(validate({ conversation_id: terminalId, terminal_id: terminalId, ...fields }).valid, false);
  }
  const interaction_id = `codex-native-interaction:${"e".repeat(64)}`;
  assert.equal(new AjvJsonSchemaValidator().getValidator(respondInteractionParameters)({ conversation_id: terminalId, ...response, interaction_id }).valid, true);
});


test("native Send and explicit Watch preserve request over plugin hard-timeout configuration", async t => {
  const h = harness(t);
  await h.execute("send", { conversation_id: conversationId, request: "Configured task" });
  await h.execute("send", { conversation_id: conversationId, request: "Explicit task", agentHardTimeoutMinutes: 19 });
  await h.execute("watch", { conversation_id: conversationId });
  await h.execute("watch", { conversation_id: conversationId, hardTimeoutMinutes: 23 });
  const calls = h.calls();
  assert.equal(argument(calls[0], "--agent-hard-timeout-minutes"), "60");
  assert.equal(argument(calls[1], "--agent-hard-timeout-minutes"), "19");
  assert.equal(argument(calls[2], "--hard-timeout-minutes"), "60");
  assert.equal(argument(calls[3], "--hard-timeout-minutes"), "23");
});
