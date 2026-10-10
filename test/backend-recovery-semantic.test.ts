import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { executeCliCommand, parseCliCommand } from "../src/cli-core.js";
import { backendRecoveryToolArgs, formatBackendRecoveryCommandResult } from "../src/backend-recovery-semantic.js";
import { createAkkSemanticToolCatalog } from "../src/semantic-tool-runtime.js";
import { bindSemanticToolRelayPath } from "../src/semantic-tool-relay.js";
import { buildAkkCommandCliArgs, parseAkkCommand } from "../src/semantic-tool-command-helpers.js";
import { closeParameters, recoverParameters, renewParameters, retryCallbackParameters } from "../src/semantic-tool-schemas.js";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";

const watches = ["codex-cli-watch:original-task-123", "desktop-watch:original-task-123"];
const context = { sessionKey: "originating-controller", sessionId: "controller-incarnation" };
const commands = ["renew", "recover", "close", "retry-callback"] as const;
const value = (args: readonly string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

function harness(t: TestContext, hardTimeoutMinutes?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-recovery-semantic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const relay = path.join(dir, "relay.cjs");
  const calls = path.join(dir, "calls.jsonl");
  fs.writeFileSync(relay, `const fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); process.stdout.write(JSON.stringify({source:'codex_cli',watch_id:args[args.indexOf('--watch')+1],status:'watching',argv:args}));`);
  const api = { pluginConfig: { storeDir: path.join(dir, "store"), codexHome: "/fixture/codex", agentTimeoutMinutes: 42, ...(hardTimeoutMinutes === undefined ? {} : { agentHardTimeoutMinutes: hardTimeoutMinutes }) },
    logger: { info() {}, warn() {} } };
  bindSemanticToolRelayPath(api, relay);
  const catalog = createAkkSemanticToolCatalog(api, new Map());
  return { catalog, calls: () => fs.existsSync(calls)
    ? fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [] };
}

test("backend recovery tools use the original task and trusted controller for both Watch and Send Turn aliases", async t => {
  const h = harness(t);
  for (const watch of watches) for (const command of commands) for (const field of ["watch_id", "turn_id"]) {
    const tool = h.catalog.tools.find(item => item.name === `agent_knock_knock_${command.replaceAll("-", "_")}`)!;
    await tool.execute(context, "call", { [field]: watch,
      ...(command === "renew" ? { minutes: 7 } : {}),
      ...(command === "close" ? { reason: "Requested release" } : {}),
      ...(command === "retry-callback" ? { notification_id: "notification-original" } : {}) });
    const args = h.calls().at(-1)!;
    assert.equal(args[0], command);
    assert.equal(value(args, "--watch"), watch);
    assert.equal(value(args, "--openclaw-session"), context.sessionKey);
    assert.equal(value(args, "--codex-home"), "/fixture/codex");
    assert.equal(args.includes("--conversation") || args.includes("--terminal") || args.includes("--turn"), false);
    assert.equal(value(args, "--minutes"), command === "renew" ? "7" : undefined);
    assert.equal(value(args, "--notification-id"), command === "retry-callback" ? "notification-original" : undefined);
  }
});

test("backend recovery rejects ambiguous targets, missing controller and terminal fences before executing the relay", async t => {
  const h = harness(t);
  for (const command of commands) {
    const tool = h.catalog.tools.find(item => item.name === `agent_knock_knock_${command.replaceAll("-", "_")}`)!;
    for (const params of [
      { watch_id: watches[0], turn_id: watches[0] },
      { watch_id: watches[0], conversation_id: "legacy-turn" },
      { conversation_id: "codex-cli:v1:thread" },
      { conversation_id: "desktop:v1:thread" },
      { conversation_id: watches[0] },
      { turn_id: "desktop:v1:thread" },
      { watch_id: "desktop-watch:../../escape" },
      { watch_id: watches[0], expected_message_id: "terminal-message" },
      { watch_id: watches[0], expected_transition_id: "terminal-transition" },
      { watch_id: watches[0], expected_handoff_token: "terminal-handoff" },
      { watch_id: watches[0], controllerSession: "forged-controller" }
    ]) await assert.rejects(tool.execute(context, "call", params) as Promise<unknown>);
    await assert.rejects(tool.execute({}, "call", { watch_id: watches[0] }) as Promise<unknown>, /Controller session/u);
  }
  assert.deepEqual(h.calls(), []);
  assert.equal(backendRecoveryToolArgs("close", { turn_id: "legacy-turn", expected_message_id: "message" }, {}), undefined);
});

test("Status accepts the exact backend Turn aliases produced by Send without terminal resolution", async t => {
  const h = harness(t);
  const tool = h.catalog.tools.find(item => item.name === "agent_knock_knock_status")!;
  for (const watch of watches) {
    await tool.execute(context, "status-call", { turn_id: watch });
    const args = h.calls().at(-1)!;
    assert.equal(args[0], "watch-status");
    assert.equal(value(args, "--watch"), watch);
    assert.equal(value(args, "--openclaw-session"), context.sessionKey);
    const slash = buildAkkCommandCliArgs(parseAkkCommand(`status ${watch}`), {}, context)!;
    assert.equal(value(slash, "--watch"), watch);
    assert.equal(value(slash, "--openclaw-session"), context.sessionKey);
  }
});

test("backend recovery schemas require one target, preserve legacy terminal aliases and restrict recovery to backend tasks", () => {
  const validator = new AjvJsonSchemaValidator();
  for (const schema of [renewParameters, closeParameters, retryCallbackParameters]) {
    const validate = validator.getValidator(schema);
    for (const input of [{ turn_id: "legacy-turn" }, { conversation_id: "legacy-turn" }, { watch_id: watches[0] }, { turn_id: watches[1] }]) {
      assert.equal(validate(input).valid, true, JSON.stringify(input));
    }
    for (const input of [{}, { watch_id: watches[0], turn_id: watches[0] }, { watch_id: watches[0], conversation_id: "legacy-turn" },
      { turn_id: "legacy-turn", conversation_id: "legacy-turn" }, { conversation_id: "desktop:v1:thread" }, { turn_id: "codex-cli:v1:thread" }]) {
      assert.equal(validate(input).valid, false, JSON.stringify(input));
    }
  }
  const recover = validator.getValidator(recoverParameters);
  assert.equal(recover({ watch_id: watches[0] }).valid, true);
  assert.equal(recover({ turn_id: watches[1] }).valid, true);
  for (const input of [{ turn_id: "legacy-turn" }, { conversation_id: watches[0] }, { watch_id: watches[0], minutes: 4 }]) assert.equal(recover(input).valid, false);
  const close = validator.getValidator(closeParameters);
  assert.equal(close({ turn_id: "legacy-turn", expected_message_id: "orphan" }).valid, true);
  assert.equal(close({ turn_id: watches[0], expected_message_id: "orphan" }).valid, false);
  assert.equal(close({ watch_id: watches[0], expected_transition_id: "transition" }).valid, false);
  const retry = validator.getValidator(retryCallbackParameters);
  assert.equal(retry({ watch_id: watches[0], notification_id: "one" }).valid, true);
  assert.equal(retry({ turn_id: "legacy-turn", notification_id: "one" }).valid, false);
});

test("slash and raw CLI recovery preserve exact task identity and optional notification selection", () => {
  for (const watch of watches) for (const command of commands) {
    const suffix = command === "renew" ? " 9" : command === "retry-callback" ? " --notification-id notification-one" : "";
    const args = buildAkkCommandCliArgs(parseAkkCommand(`${command} ${watch}${suffix}`), {}, context)!;
    assert.equal(value(args, "--watch"), watch);
    assert.equal(value(args, "--openclaw-session"), context.sessionKey);
    assert.equal(value(args, "--notification-id"), command === "retry-callback" ? "notification-one" : undefined);
    assert.equal(value(args, "--minutes"), command === "renew" ? "9" : undefined);
  }
  for (const selector of ["only", "latest", "terminal:v2:tmux:codex:fixture", "desktop:v1:thread"]) {
    assert.throws(() => parseAkkCommand(`recover ${selector}`));
  }
  assert.throws(() => buildAkkCommandCliArgs(parseAkkCommand(`close ${watches[0]} --expected-message-id orphan`), {}, context), /Unsupported backend/u);
  assert.deepEqual(parseCliCommand(["retry-callback", "--turn", watches[0], "--notification-id", "notification-one"]), {
    command: "retry-callback", options: { turn: watches[0], notificationId: "notification-one" }
  });
});

test("raw backend recovery rejects conversation mutation before any backend discovery or terminal fallback", async () => {
  let discoveries = 0;
  const unexpected = () => { discoveries++; throw new Error("Recovery must not discover a replacement task or terminal"); };
  for (const command of commands) for (const options of [
    { conversation: "codex-cli:v1:thread" }, { conversation: "desktop:v1:thread" },
    { turn: watches[0], conversation: "terminal:v2:tmux:codex:fixture" },
    { watch: watches[1], expectedHandoffToken: "terminal-fence" }
  ]) {
    await assert.rejects(executeCliCommand(command, { ...options, openclawSession: context.sessionKey }, {
      createCodexNativeRuntime: unexpected, createDesktopRuntime: unexpected,
      conversationRoutingTerminals: unexpected, runtimeLog: () => {}
    }));
  }
  for (const options of [{ turn: "latest" }, { conversation: "legacy-turn" }, { watch: watches[0] }]) {
    await assert.rejects(executeCliCommand("recover", options, { createCodexNativeRuntime: unexpected, createDesktopRuntime: unexpected, runtimeLog: () => {} }));
  }
  for (const watch of watches) for (const notificationId of [true, "", "   "]) {
    await assert.rejects(executeCliCommand("retry-callback", { watch, notificationId, openclawSession: context.sessionKey }, {
      createCodexNativeRuntime: unexpected, createDesktopRuntime: unexpected, runtimeLog: () => {}
    }), /notification-id/u);
  }
  assert.equal(discoveries, 0);
});

test("compact backend watches retain manual recovery state and notification identity without private authority", () => {
  const row = { watch_id: watches[0], turn_id: watches[0], task_kind: "send", status: "blocked", management_state: "managed", observation_state: "unreachable",
    renewal_count: 2, callback_in_flight: false, retryable_callback_ids: ["notification-one", "notification-two"],
    callback_notifications: [{ id: "notification-one", status: "failed", retryable: true, attempts: 1, callback_route: { secret: "private" } }],
    available_actions: { recover: { tool: "agent_knock_knock_recover", arguments: { watch_id: watches[0] } },
      retry_callback: { tool: "agent_knock_knock_retry_callback", arguments: { watch_id: watches[0], notification_id: "notification-one" } } } };
  const result = compactAkkListModelProjection({ codex_cli_watches: [row], desktop_watches: [{ ...row, watch_id: watches[1], turn_id: watches[1] }] });
  for (const key of ["codex_cli_watches", "desktop_watches"]) {
    const projected = (result[key] as Record<string, any>[])[0];
    assert.equal(projected.management_state, "managed");
    assert.equal(projected.observation_state, "unreachable");
    assert.ok(projected.turn_id);
    assert.equal(projected.task_kind, "send");
    assert.equal(projected.renewal_count, 2);
    assert.equal(projected.callback_in_flight, false);
    assert.deepEqual(projected.retryable_callback_ids, ["notification-one", "notification-two"]);
    assert.equal(projected.available_actions.recover, true);
    assert.equal(projected.action_inputs.retry_callback.arguments.notification_id, "notification-one");
    assert.equal(projected.callback_notifications[0].id, "notification-one");
    assert.equal(projected.callback_notifications[0].retryable, true);
    assert.equal(JSON.stringify(projected).includes("private"), false);
  }
  const text = formatBackendRecoveryCommandResult({ ...row, callback_notifications: [{ notification_id: "notification-one", status: "retryable_failure" }] }, "retry-callback")!;
  assert.match(text, /notification-one: retryable_failure/u);
  assert.doesNotMatch(text, /callback delivered/u);
});


test("backend Renew uses explicit minutes then hard-timeout config then shared default, separate from managed inactivity", async t => {
  for (const [configured, expected] of [[undefined, 720], [95, 95]] as const) {
    const h = harness(t, configured);
    const tool = h.catalog.tools.find(item => item.name === "agent_knock_knock_renew")!;
    for (const watch of watches) {
      await tool.execute(context, "renew-default", { watch_id: watch });
      assert.equal(value(h.calls().at(-1)!, "--minutes"), String(expected));
      await tool.execute(context, "renew-explicit", { watch_id: watch, minutes: 8 });
      assert.equal(value(h.calls().at(-1)!, "--minutes"), "8");
      const config = { agentTimeoutMinutes: 42, ...(configured === undefined ? {} : { agentHardTimeoutMinutes: configured }) };
      const slash = buildAkkCommandCliArgs(parseAkkCommand(`renew ${watch}`), config, context)!;
      assert.equal(value(slash, "--minutes"), String(expected));
    }
    await tool.execute(context, "renew-managed", { turn_id: "managed-terminal-task" });
    assert.equal(value(h.calls().at(-1)!, "--minutes"), "42", "managed terminal Renew retains inactivity configuration");
  }
  const terminal = buildAkkCommandCliArgs(parseAkkCommand("renew managed-terminal-task"), {}, context)!;
  assert.equal(value(terminal, "--minutes"), undefined, "no backend hard-default injected into terminal Renew");
  for (const minutes of ["10", 0, -1, Infinity]) assert.throws(() => backendRecoveryToolArgs("renew", {
    watch_id: watches[0], minutes
  }, context), /positive number/);
});
