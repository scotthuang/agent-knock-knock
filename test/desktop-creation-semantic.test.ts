import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createAkkSemanticToolCatalog } from "../src/semantic-tool-runtime.js";
import { bindSemanticToolRelayPath } from "../src/semantic-tool-relay.js";
import { desktopCreateParameters } from "../src/semantic-tool-schemas.js";
import { desktopCreationToolArgs } from "../src/desktop-creation-semantic.js";

const context = { sessionKey: "agent:test:desktop-creation", sessionId: "controller-one" };
const operationId = "desktop-create:" + "a".repeat(64);
const argument = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
type Result = { details: Record<string, any>; isError?: boolean };

function harness(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-creation-semantic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relay = path.join(root, "relay.cjs"), calls = path.join(root, "calls.jsonl"), reply = path.join(root, "reply.json");
  const exitCode = path.join(root, "exit-code");
  fs.writeFileSync(exitCode, "0");
  fs.writeFileSync(reply, JSON.stringify({ source: "codex_desktop", operation_id: operationId,
    status: "ready", created: true, conversation_id: "desktop:v1:test", native_thread_id: "thread-created" }));
  fs.writeFileSync(relay, `const fs = require("node:fs");
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
    process.stdout.write(fs.readFileSync(${JSON.stringify(reply)}, "utf8"));
    process.exitCode = Number(fs.readFileSync(${JSON.stringify(exitCode)}, "utf8"));`);
  const owner = { pluginConfig: { storeDir: path.join(root, "store"), codexHome: "/test/codex",
    openclawBin: "/test/openclaw", agentHardTimeoutMinutes: 120 }, logger: { info() {}, warn() {} } };
  bindSemanticToolRelayPath(owner, relay);
  const tool = createAkkSemanticToolCatalog(owner, new Map()).tools.find(entry => entry.name === "agent_knock_knock_desktop_create");
  assert.ok(tool);
  return {
    execute: (params: unknown, callId = "creation-one", controller = context) => tool.execute(controller, callId, params) as Promise<Result>,
    calls: (): string[][] => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    reply: (value: unknown) => fs.writeFileSync(reply, JSON.stringify(value)),
    invalidReply: () => fs.writeFileSync(reply, "not JSON"),
    exit: (code: number) => fs.writeFileSync(exitCode, String(code)),
    store: owner.pluginConfig.storeDir
  };
}

test("Desktop Create is separate from terminal lifecycle and forwards exact project/task options", async t => {
  const h = harness(t);
  const result = await h.execute({ project: "测试项目", cwd: "/test/project", title: "新的对话", request: "Perform the authorized task", agentHardTimeoutMinutes: 15 });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.native_thread_id, "thread-created");
  assert.equal("session_id" in result.details, false);
  assert.equal("turn_id" in result.details, false);
  const [args] = h.calls();
  assert.equal(h.calls().length, 1, "No discovery, terminal replacement, or follow-up send from the semantic layer");
  assert.equal(args[0], "desktop-create");
  for (const [flag, value] of [["--project", "测试项目"], ["--cwd", "/test/project"], ["--title", "新的对话"],
    ["--message", "Perform the authorized task"], ["--agent-hard-timeout-minutes", "15"], ["--store-dir", h.store],
    ["--codex-home", "/test/codex"], ["--openclaw-bin", "/test/openclaw"], ["--openclaw-session", context.sessionKey]]) {
    assert.equal(argument(args, flag), value);
  }
  assert.equal(args.includes("--terminal"), false);
  assert.equal(args.includes("--conversation"), false);
});

test("Desktop creation identity survives identical invocation replay and isolates controller incarnations", async t => {
  const h = harness(t);
  await h.execute({});
  await h.execute({});
  await h.execute({}, "creation-one", { ...context, sessionId: "controller-two" });
  await h.execute({}, "creation-two");
  await h.execute({}, "creation-one", { ...context, sessionKey: "agent:test:other-controller" });
  const calls = h.calls();
  const expected = "desktop-create:" + createHash("sha256").update(JSON.stringify([
    context.sessionKey, context.sessionId, "agent_knock_knock_desktop_create", "creation-one"
  ])).digest("hex");
  assert.equal(argument(calls[0], "--operation-id"), expected);
  assert.equal(argument(calls[1], "--operation-id"), expected);
  assert.equal(new Set([calls[0], ...calls.slice(2)].map(args => argument(args, "--operation-id"))).size, 4);
  assert.equal(argument(calls[0], "--agent-hard-timeout-minutes"), "120");
  for (const flag of ["--project", "--cwd", "--title", "--message"]) assert.equal(argument(calls[0], flag), undefined);
});

test("Desktop creation continuation keeps exact identity without resupplying or changing the payload", async t => {
  const h = harness(t);
  h.reply({ source: "codex_desktop", operation_id: operationId, status: "opening", created: true,
    native_thread_id: "thread-created", next_action: { tool: "agent_knock_knock_desktop_create", input: { operation_id: operationId } } });
  const result = await h.execute({ operation_id: operationId }, "different-call");
  assert.equal(result.isError, undefined, "Opening is an incomplete receipt, not a second creation request");
  assert.equal(result.details.status, "opening");
  const [args] = h.calls();
  assert.equal(argument(args, "--operation-id"), operationId);
  assert.equal(args.includes("--resume-creation"), true);
  for (const flag of ["--project", "--cwd", "--title", "--message", "--agent-hard-timeout-minutes"]) assert.equal(argument(args, flag), undefined);
  assert.equal(argument(args, "--openclaw-session"), context.sessionKey);
});

test("Desktop creation rejects target aliases, missing invocation identity, invalid durations and changed continuation before relay", async t => {
  const h = harness(t);
  for (const params of [null, [], { terminal_id: "terminal:work" }, { conversation_id: "desktop:v1:old" }, { project: " " },
    { cwd: 123 }, { request: "" }, { title: null }, { agentHardTimeoutMinutes: 0 }, { agentHardTimeoutMinutes: NaN },
    { agentHardTimeoutMinutes: "720" }, { operation_id: "../../other" }, { operation_id: operationId, request: "changed" },
    { operation_id: operationId, project: "other" }, { operation_id: operationId, agentHardTimeoutMinutes: 720 }]) {
    await assert.rejects(h.execute(params));
  }
  await assert.rejects(h.execute({}, ""), /tool call identity/u);
  await assert.rejects(h.execute({}, "call", { ...context, sessionKey: "" }), /controller session/u);
  assert.deepEqual(h.calls(), []);
});

test("Desktop creation transport failure keeps the original operation and cannot claim no creation", async t => {
  const h = harness(t);
  h.invalidReply();
  const result = await h.execute({ request: "Do not replay" });
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "uncertain");
  assert.equal(result.details.created, null);
  assert.equal(result.details.error_code, "desktop_creation_receipt_unavailable");
  assert.equal(result.details.operation_id, argument(h.calls()[0], "--operation-id"));
  assert.deepEqual(result.details.next_action, { tool: "agent_knock_knock_desktop_create", input: { operation_id: result.details.operation_id } });
  assert.equal(h.calls().length, 1);
});

test("Desktop creation preserves first-task Watch receipt and marks failed or uncertain creation as errors", async t => {
  const h = harness(t);
  const send = { watch_id: "desktop-watch:created-task", native_turn_id: "turn-created", callback_expected: true, send_state: "accepted" };
  h.reply({ source: "codex_desktop", operation_id: operationId, status: "ready", created: true,
    native_thread_id: "thread-created", request_state: "accepted", task_status: "watching", ...send });
  const result = await h.execute({ request: "One task" });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "ready");
  assert.equal(result.details.task_status, "watching");
  for (const [key, value] of Object.entries(send)) assert.equal(result.details[key], value);
  for (const request_state of ["uncertain", "not_sent"]) {
    h.reply({ source: "codex_desktop", operation_id: operationId, status: "ready", created: true, request_state });
    const failedTask = await h.execute({ operation_id: operationId });
    assert.equal(failedTask.isError, true);
    assert.equal(failedTask.details.created, true, "Task rejection does not undo conversation creation");
  }
  for (const status of ["uncertain", "failed", "unexpected"]) {
    h.reply({ source: "codex_desktop", operation_id: operationId, status, created: true, native_thread_id: "thread-created" });
    assert.equal((await h.execute({ operation_id: operationId })).isError, true);
  }
});

test("Desktop creation schema excludes caller authority and keeps explicit/config/default lifetime priority", () => {
  assert.equal(desktopCreateParameters.additionalProperties, false);
  assert.deepEqual(Object.keys(desktopCreateParameters.properties), ["project", "cwd", "title", "request", "agentHardTimeoutMinutes", "operation_id"]);
  const explicit = desktopCreationToolArgs({ agentHardTimeoutMinutes: 10 }, { agentHardTimeoutMinutes: 120 }, context, "call");
  const configured = desktopCreationToolArgs({}, { agentHardTimeoutMinutes: 120 }, context, "call");
  const defaulted = desktopCreationToolArgs({}, {}, context, "call");
  assert.equal(argument(explicit, "--agent-hard-timeout-minutes"), "10");
  assert.equal(argument(configured, "--agent-hard-timeout-minutes"), "120");
  assert.equal(argument(defaulted, "--agent-hard-timeout-minutes"), undefined, "Service owns the shared default");
});


test("Desktop creation preserves a structured rejection even when the CLI exits unsuccessfully", async t => {
  const h = harness(t);
  const failure = { source: "codex_desktop", operation_id: operationId, status: "failed", created: false,
    error_code: "desktop_creation_unknown_operation" };
  h.reply(failure); h.exit(1);
  const result = await h.execute({ operation_id: operationId });
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, failure);
  assert.equal(h.calls().length, 1);
});
