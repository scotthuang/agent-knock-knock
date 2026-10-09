import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { desktopInteractionProjection } from "../src/desktop-interaction-projection.js";
import { createAkkSemanticToolCatalog } from "../src/semantic-tool-runtime.js";
import { bindSemanticToolRelayPath } from "../src/semantic-tool-relay.js";
import { approveParameters, respondInteractionParameters, setModelParameters, modelOptionsParameters, setPermissionsParameters, cancelParameters } from "../src/semantic-tool-schemas.js";
import type { DesktopAsyncInteraction, DesktopRequestInteraction } from "../src/desktop-types.js";

const identity = { codexHome: "/test/desktop-home", hostId: "local", threadId: "desktop-thread" };
const conversationId = createDesktopConversationId(identity);
const watchId = "desktop-watch:11111111-2222-4333-8444-555555555555";
const controller = { sessionKey: "agent:test:desktop", sessionId: "controller-one" };
const interaction: DesktopAsyncInteraction = { id: `desktop-async-interaction:${"a".repeat(64)}`,
  threadId: identity.threadId, turnId: "turn-one", itemId: "item-one", kind: "async_question", method: "request_user_input_async",
  questions: [{ id: '["request_user_input_async","call-one",0]', title: "Choose a color", options: ["Green", "Blue"], isOther: true }] };
const arg = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
type Result = { details: Record<string, any>; isError?: boolean };

function harness(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-semantic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const relay = path.join(dir, "relay.cjs"), calls = path.join(dir, "calls.jsonl"), reply = path.join(dir, "reply.json");
  fs.writeFileSync(relay, `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(fs.readFileSync(${JSON.stringify(reply)},'utf8'));`);
  const api = { pluginConfig: { storeDir: path.join(dir, "store"), codexHome: identity.codexHome }, logger: { info() {}, warn() {} } };
  bindSemanticToolRelayPath(api, relay);
  const catalog = createAkkSemanticToolCatalog(api, new Map());
  return {
    async execute(name: string, params: Record<string, unknown>, context = controller): Promise<Result> {
      const tool = catalog.tools.find(item => item.name === `agent_knock_knock_${name}`)!;
      return await tool.execute(context, "call-one", params) as Result;
    },
    reply(value: unknown) { fs.writeFileSync(reply, JSON.stringify(value)); },
    calls: (): string[][] => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []
  };
}

function status(watch?: string) {
  return { source: "codex_desktop", conversation_id: conversationId, ...(watch ? { watch_id: watch } : {}),
    native_turn_id: interaction.turnId, interaction_state: [desktopInteractionProjection(interaction, conversationId, watch)] };
}
function answer(watch?: string) {
  const projected = desktopInteractionProjection(interaction, conversationId, watch);
  return { ...(watch ? { watch_id: watch } : { conversation_id: conversationId }), interaction_id: interaction.id,
    answers: [{ question_id: projected.questions[0].question_id, response_kind: "single_select",
      selected_option_ids: [projected.questions[0].options[0].option_id] }] };
}

test("Desktop Host Status preserves async questions and privately binds conversation and Watch responses", async t => {
  const h = harness(t);
  for (const watch of [undefined, watchId]) {
    h.reply(status(watch));
    const result = await h.execute("status", watch ? { watch_id: watch } : { conversation_id: conversationId });
    assert.equal(result.details.interaction_state[0].questions[0].title, "Choose a color");
    assert.equal(JSON.stringify(result).includes("interaction_prompt_fingerprint"), false);
    assert.equal("turn_id" in result.details, false);
    h.reply({ source: "codex_desktop", conversation_id: conversationId, state: "sent" });
    const response = await h.execute("respond_interaction", answer(watch));
    assert.equal(response.isError, undefined);
    const args = h.calls().at(-1)!;
    assert.equal(args[0], "respond-interaction");
    assert.equal(arg(args, watch ? "--watch" : "--conversation"), watch ?? conversationId);
    assert.match(arg(args, "--expected-interaction-fingerprint")!, /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(arg(args, "--expected-interaction-expires-at")!)));
    assert.equal(arg(args, "--codex-home"), identity.codexHome);
    assert.equal(arg(args, "--openclaw-session"), controller.sessionKey);
    assert.equal(args.includes("--terminal"), false);
  }
});

test("Desktop offers cannot cross controllers, subjects or refreshed question boundaries", async t => {
  const h = harness(t);
  h.reply(status()); await h.execute("status", { conversation_id: conversationId });
  await assert.rejects(h.execute("respond_interaction", answer(), { ...controller, sessionId: "reset-controller" }), /Refresh AKK Status/);
  await assert.rejects(h.execute("respond_interaction", { ...answer(), watch_id: watchId }), /exactly one/);
  h.reply({ ...status(), interaction_state: [] }); await h.execute("status", { conversation_id: conversationId });
  await assert.rejects(h.execute("respond_interaction", answer()), /Refresh AKK Status/);
  assert.deepEqual(h.calls().map(args => args[0]), ["status", "status"]);
});

test("Desktop failed and uncertain responses remain errors while dispatched answers remain unconfirmed", async t => {
  const h = harness(t);
  for (const state of ["not_sent", "uncertain", "sent", "confirmed"]) {
    h.reply(status()); await h.execute("status", { conversation_id: conversationId });
    h.reply({ source: "codex_desktop", conversation_id: conversationId, state });
    const result = await h.execute("respond_interaction", answer());
    assert.equal(Boolean(result.isError), state === "not_sent" || state === "uncertain");
    assert.equal(result.details.state, state);
  }
});

test("Desktop response schema permits native question batches and multiline text while requiring exact approval identity", () => {
  const valid = new AjvJsonSchemaValidator().getValidator(respondInteractionParameters);
  for (const watch of [undefined, watchId]) {
    const value = answer(watch);
    assert.equal(valid(value).valid, true);
    assert.equal(valid({ ...value, answers: [{ question_id: value.answers[0].question_id, response_kind: "free_text", text: "First\nsecond\tcolumn" }] }).valid, true);
    assert.equal(valid({ ...value, delivery_mode: "queue_next_turn" }).valid, false);
    assert.equal(valid({ ...value, answers: [value.answers[0], { ...value.answers[0], question_id: "q:second" }] }).valid, true);
    assert.equal(valid({ ...value, answers: [{ question_id: value.answers[0].question_id, response_kind: "confirm", confirm: true }] }).valid, false);
  }
  assert.equal(new AjvJsonSchemaValidator().getValidator(approveParameters)({ conversation_id: conversationId }).valid, false);
});

test("Desktop model projection rejects mixed thread or task identity and strips unknown raw fields", async t => {
  const h = harness(t);
  h.reply({ ...status(), interaction_state: [{ ...status().interaction_state[0], native_turn_id: "old-turn" }] });
  assert.equal((await h.execute("status", { conversation_id: conversationId })).details.interaction_state, undefined);
  h.reply({ ...status(), interaction_state: [{ ...status().interaction_state[0], raw_owner: "must-not-leak" }] });
  const result = await h.execute("status", { conversation_id: conversationId });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("Desktop approval uses current private request identity and preserves dispatched versus confirmed outcomes", async t => {
  const h = harness(t);
  const approval: DesktopRequestInteraction = { id: `desktop-request-interaction:${"b".repeat(64)}`,
    kind: "command_approval", threadId: identity.threadId, turnId: "turn-one", itemId: "command-one",
    requestId: 17, method: "item/commandExecution/requestApproval", command: "read a protected fixture", questions: [] };
  for (const decision of ["approve_once", "reject"]) {
    h.reply({ source: "codex_desktop", conversation_id: conversationId, watch_id: watchId,
      native_turn_id: approval.turnId, interaction_state: [desktopInteractionProjection(approval, conversationId, watchId)] });
    const statusResult = await h.execute("status", { watch_id: watchId });
    assert.equal(statusResult.details.interaction_state[0].command, approval.command);
    assert.equal(JSON.stringify(statusResult).includes("requestId"), false);
    h.reply({ source: "codex_desktop", conversation_id: conversationId, state: "sent" });
    const result = await h.execute("approve", { watch_id: watchId, interaction_id: approval.id, decision });
    assert.equal(result.isError, undefined);
    const args = h.calls().at(-1)!;
    assert.equal(args[0], "approve"); assert.equal(arg(args, "--decision"), decision);
    assert.equal(arg(args, "--watch"), watchId); assert.match(arg(args, "--expected-interaction-fingerprint")!, /^[a-f0-9]{64}$/);
    await assert.rejects(h.execute("approve", { watch_id: watchId, interaction_id: approval.id, decision }), /Refresh AKK Status/);
  }
});

test("Desktop controls route explicit model settings and exact cancellation without granting CLI or terminal new authority", async t => {
  const h = harness(t);
  const calls = [
    ["native_inspect", { conversation_id: conversationId, inspection: "status" }, "native-inspect"],
    ["permission_options", { conversation_id: conversationId }, "permission-options"],
    ["set_permissions", { conversation_id: conversationId, mode: "full-access" }, "set-permissions"],
    ["model_options", { conversation_id: conversationId }, "model-options"],
    ["set_model", { conversation_id: conversationId, model: "user-model", reasoning_effort: "high", collaboration_mode: "plan" }, "set-model"],
    ["cancel", { conversation_id: conversationId, expected_native_turn_id: "turn-one" }, "cancel"],
    ["cancel", { watch_id: watchId }, "cancel"]
  ] as const;
  for (const [tool, params, command] of calls) {
    h.reply({ source: "codex_desktop", conversation_id: conversationId, outcome: "changed", scope: "current_session",
      defaults_changed: false, do_not_retry: false, requested: { mode: "full-access" }, effective: { mode: "full-access" } });
    await h.execute(tool, params);
    const args = h.calls().at(-1)!;
    assert.equal(args[0], command); assert.equal(arg(args, "--codex-home"), identity.codexHome);
    assert.equal(args.includes("--expected-binding-token"), false);
    if (tool === "set_model") assert.equal(arg(args, "--collaboration-mode"), "plan");
  }
  h.reply({ source: "codex_desktop", conversation_id: conversationId, outcome: "unconfirmed", do_not_retry: true });
  assert.equal((await h.execute("cancel", { watch_id: watchId })).isError, true);
  const validator = new AjvJsonSchemaValidator();
  const model = validator.getValidator(setModelParameters);
  assert.equal(model({ conversation_id: conversationId, model: "explicit-model", reasoning_effort: "high", collaboration_mode: "plan" }).valid, true);
  assert.equal(model({ terminal_id: "terminal:v2:tmux:one", model: "explicit-model", reasoning_effort: "high", collaboration_mode: "plan" }).valid, false);
  assert.equal(model({ conversation_id: "codex-cli:v1:opaque", model: "explicit-model", reasoning_effort: "high" }).valid, false);
  assert.equal(validator.getValidator(modelOptionsParameters)({ conversation_id: "codex-cli:v1:opaque" }).valid, false);
  assert.equal(validator.getValidator(setPermissionsParameters)({ conversation_id: conversationId, mode: "full-access" }).valid, true);
  const cancel = validator.getValidator(cancelParameters);
  assert.equal(cancel({ conversation_id: conversationId }).valid, false);
  assert.equal(cancel({ conversation_id: conversationId, expected_native_turn_id: "turn-one" }).valid, true);
  assert.equal(cancel({ watch_id: watchId }).valid, true);
  assert.equal(cancel({ watch_id: watchId, expected_native_turn_id: "turn-one" }).valid, false);
  await assert.rejects(h.execute("set_model", { conversation_id: conversationId, terminal_id: "terminal:v2:wrong", model: "model", reasoning_effort: "high" }), /another target/);
});
