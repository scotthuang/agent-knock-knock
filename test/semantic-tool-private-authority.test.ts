import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

import {
  assertOnlyModelControlParameters,
  buildPrivateReconcileBindingArgs,
  privateActionArguments,
  rememberDisplayedPrivateAuthorityOffers,
  RECONCILE_BINDING_AUTHORITY_KIND
} from "../src/semantic-tool-private-authority.js";
import { consumeSemanticPrivateAuthorityOffer } from "../src/semantic-private-authority-offers.js";
import { reconcileBindingParameters } from "../src/semantic-tool-schemas.js";
import {
  authoritativeManagedId,
  pushOptional,
  requiredTerminalInteractionIdentifier
} from "../src/semantic-tool-arguments.js";

test("semantic private authority accepts only typed model-control inputs", () => {
  assert.doesNotThrow(() => assertOnlyModelControlParameters(
    { terminal_id: "terminal:v2:tmux:codex:test:0.0:123" },
    ["terminal_id"],
    "model_options"
  ));
  assert.throws(
    () => assertOnlyModelControlParameters(
      {
        terminal_id: "terminal:v2:tmux:codex:test:0.0:123",
        raw_keys: ["Enter"]
      },
      ["terminal_id"],
      "model_options"
    ),
    /accepts only typed semantic fields/u
  );
});

test("binding recovery schema distinguishes legacy detach from explicit Store authority transfer", () => {
  const validate = new AjvJsonSchemaValidator().getValidator(reconcileBindingParameters);
  const terminal_id = "terminal:v2:tmux:claude:recovery:0.0:123";
  const transfer = { operation: "transfer_store_authority", terminal_id };
  for (const params of [{ terminal_id, conflicting_session_id: "session-old" }, transfer,
    { ...transfer, maintenance_acknowledgement: true }]) {
    assert.equal(validate(params).valid, true, JSON.stringify(params));
  }
  for (const params of [{ terminal_id }, { ...transfer, conflicting_session_id: "session-old" },
    { ...transfer, maintenance_acknowledgement: false }, { ...transfer, expected_authority_token: "forged" },
    { ...transfer, store_dir: "/caller/selected/store" }, { ...transfer, operation: "detach_binding" },
    { terminal_id, conflicting_session_id: "session-old", maintenance_acknowledgement: true }]) {
    assert.equal(validate(params).valid, false, JSON.stringify(params));
  }
});

test("Store transfer offers remain controller-scoped and do not replace displayed detach authority", async () => {
  const api = {}, context = { sessionKey: "controller", sessionId: "incarnation" };
  const terminal_id = "terminal:v2:tmux:claude:recovery:0.0:123";
  const transfer = { operation: "transfer_store_authority", terminal_id };
  for (const params of [{ ...transfer, expected_authority_token: "forged" },
    { ...transfer, maintenance_acknowledgement: "true" }, { ...transfer, conflicting_session_id: "session-old" }]) {
    await assert.rejects(buildPrivateReconcileBindingArgs(api, params, context), /semantic fields|explicit true/u);
  }
  await assert.rejects(buildPrivateReconcileBindingArgs(api, transfer, context), /current action shown/u);
  const detach = { terminal_id, conflicting_session_id: "session-old", expected_session_revision: 2,
    expected_binding_token: "binding-private", expected_terminal_token: "terminal-private" };
  rememberDisplayedPrivateAuthorityOffers(api, context.sessionKey, context.sessionId, { terminals: [{
    id: terminal_id, available_actions: {
      reconcile_binding: { tool: "agent_knock_knock_reconcile_binding", arguments: detach },
      transfer_store_authority: { tool: "agent_knock_knock_reconcile_binding",
        arguments: { ...transfer, expected_authority_token: "store-private" },
        missing_required: ["maintenance_acknowledgement"] }
    }
  }] });
  await assert.rejects(buildPrivateReconcileBindingArgs(api, transfer,
    { ...context, sessionId: "other-incarnation" }), /current action shown/u);
  const target = { type: "terminal_id", id: terminal_id };
  const transferOffer = consumeSemanticPrivateAuthorityOffer(api,
    { ...context, kind: "transfer_store_authority", target });
  assert.deepEqual(transferOffer?.args, { ...transfer, expected_authority_token: "store-private",
    maintenance_acknowledgement_required: true });
  assert.equal(Object.hasOwn(transferOffer?.args ?? {}, "maintenance_acknowledgement"), false,
    "the displayed action cannot assert user maintenance confirmation");
  assert.deepEqual(consumeSemanticPrivateAuthorityOffer(api,
    { ...context, kind: RECONCILE_BINDING_AUTHORITY_KIND, target })?.args, detach);
  assert.equal(consumeSemanticPrivateAuthorityOffer(api,
    { ...context, kind: "transfer_store_authority", target }), undefined);
});

test("semantic argument encoding preserves public validation boundaries", () => {
  const args = ["status"];
  pushOptional(args, "--store-dir", "/tmp/akk-store");
  pushOptional(args, "--unused", undefined);
  assert.deepEqual(args, ["status", "--store-dir", "/tmp/akk-store"]);
  assert.equal(authoritativeManagedId("turn-20260915-a", "turn_id"), "turn-20260915-a");
  assert.throws(
    () => authoritativeManagedId("terminal:v2:tmux:codex:test:0.0:123", "turn_id"),
    /authoritative managed id/u
  );
  assert.equal(
    requiredTerminalInteractionIdentifier("ti_123:step-2", "interaction_id"),
    "ti_123:step-2"
  );
  assert.throws(
    () => requiredTerminalInteractionIdentifier("unsafe input", "interaction_id"),
    /exact safe interaction identifier/u
  );
});

test("private Send refusal explains only the selected Claude physical readiness failure", async (t) => {
  const terminalId = "terminal:v2:herdr:claude:fixture:w1:p2:123";
  const diagnostic = "PRIVATE_READINESS_DETAIL";
  let rows: Record<string, unknown>[] = [];
  const commands: string[] = [];
  const spawn = t.mock.method(childProcess, "spawnSync", (...callArgs: unknown[]) => {
    if (callArgs[0] === process.execPath) commands.push(String((callArgs[1] as string[] | undefined)?.[1]));
    return { status: 0, stdout: JSON.stringify({ terminals: rows }), stderr: "" } as
      unknown as ReturnType<typeof childProcess.spawnSync>;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const terminal = (readiness: Record<string, unknown>, agent = "claude") => ({
    id: terminalId, agent, physical_send_readiness: readiness, available_actions: {}
  });
  const call = (tool = "agent_knock_knock_send", target: string | undefined = terminalId) =>
    privateActionArguments({}, { tool, terminalId: target, matches: () => true });
  for (const [reason, message] of [
    ["footer_unrecognized", "The native footer contains an unknown component; return to the main prompt."],
    ["composer_not_empty", "The Composer contains an unsent draft; save or clear it before retrying."],
    ["stash_not_empty", "This window has a stashed draft; restore it with Ctrl+S and save it before retrying."],
    ["cleanup_marker_present", "Do not submit the AKK cleanup marker; remove only the marker before retrying."],
    ["foreground_running", "Claude is still executing its foreground turn; wait for it to finish."],
    ["foreground_unproven", "The foreground turn has no completion proof; wait and refresh."]
  ]) {
    rows = [terminal({ ready: false, reason, message })];
    await assert.rejects(call(), (error: unknown) => error instanceof Error &&
      error.message.startsWith("the current AKK list does not advertise one exact agent_knock_knock_send") &&
      error.message.endsWith(`: ${message}`));
  }
  for (const scenario of [
    { rows: [terminal({ ready: false, message: diagnostic }, "codex")] },
    { rows: [terminal({ ready: false, message: diagnostic })], tool: "agent_knock_knock_new_thread" },
    { rows: [terminal({ ready: true, message: diagnostic })] },
    { rows: [terminal({ ready: false })] },
    { rows: [terminal({ ready: false, message: diagnostic }), terminal({ ready: false, message: diagnostic })] },
    { rows: [terminal({ ready: false, message: diagnostic }), { id: "another-terminal", agent: "claude" }], omitted: true }
  ]) {
    rows = scenario.rows;
    await assert.rejects(scenario.omitted
      ? privateActionArguments({}, { tool: "agent_knock_knock_send", matches: () => true })
      : call(scenario.tool), (error: unknown) => error instanceof Error && !error.message.includes(diagnostic));
  }
  rows = [terminal({ ready: false, message: diagnostic + "\n" + "x".repeat(1_100) })];
  await assert.rejects(call(), (error: unknown) => error instanceof Error &&
    !error.message.includes("\n") && error.message.endsWith((diagnostic + " " + "x".repeat(1_100)).slice(0, 1_000)));
  assert.ok(commands.length > 0);
  assert.ok(commands.every(command => command === "list"), "a blocked action performs only private discovery, never Send");
});

test("runtime composes private authority without a reverse dependency", () => {
  const runtimeSource = fs.readFileSync("src/semantic-tool-runtime.ts", "utf8");
  const privateAuthoritySource = fs.readFileSync(
    "src/semantic-tool-private-authority.ts",
    "utf8"
  );
  const argumentsSource = fs.readFileSync(
    "src/semantic-tool-arguments.ts",
    "utf8"
  );

  assert.match(runtimeSource, /from "\.\/semantic-tool-private-authority\.js"/u);
  assert.match(runtimeSource, /from "\.\/semantic-tool-arguments\.js"/u);
  assert.doesNotMatch(runtimeSource, /openclaw-private-authority-offers/u);
  assert.doesNotMatch(runtimeSource, /function privateActionArguments/u);
  assert.doesNotMatch(privateAuthoritySource, /semantic-tool-runtime/u);
  assert.doesNotMatch(privateAuthoritySource, /openclaw-plugin-command-adapter/u);
  assert.doesNotMatch(privateAuthoritySource, /openclaw-plugin-schemas/u);
  assert.doesNotMatch(argumentsSource, /semantic-tool-runtime/u);
  assert.doesNotMatch(argumentsSource, /openclaw-plugin-/u);
});
