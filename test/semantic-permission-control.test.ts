import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPrivatePermissionOptionsArgs,
  buildPrivateSetPermissionsArgs,
  formatAkkSetPermissionsCommandResult,
  isAkkSetPermissionsSuccess,
  rememberDisplayedPermissionOptionsOffer
} from "../src/semantic-permission-control.js";
import { createHostBridgeToolRegistry } from "../src/host-bridge-tools.js";
import { parseAkkCommand } from "../src/semantic-tool-command-helpers.js";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";
import { permissionOptionsParameters, setPermissionsParameters } from "../src/semantic-tool-schemas.js";

const terminalId = "terminal:v2:tmux:codex:permission-test:0.0:1234";
const context = { sessionKey: "permission-owner", sessionId: "permission-incarnation" };
const fingerprint = "a".repeat(64);
function options() {
  return {
    terminal_id: terminalId,
    agent: "codex",
    agent_version: "0.159.2",
    behavior_profile: "codex-permissions",
    scope: "current_session",
    current: "read_only",
    choices: [
      { id: "ask_for_approval", label: "Ask for approval", description: "Requests approval as needed." },
      { id: "full_access", label: "Full Access", description: "Allows actions without sandbox restrictions." }
    ],
    catalog_fingerprint: fingerprint,
    available_actions: { set_permissions: {
      tool: "agent_knock_knock_set_permissions",
      arguments: { terminal_id: terminalId, expected_binding_token: "binding-private", expected_catalog_fingerprint: fingerprint }
    } }
  };
}
function parameters(mode = "full_access") { return { terminal_id: terminalId, mode }; }
function changed() {
  return { outcome: "changed", scope: "current_session", defaults_changed: false,
    requested: { mode: "full_access" }, effective: { mode: "full_access" }, do_not_retry: false };
}

test("permission catalog binds one semantic choice to the exact controller incarnation and terminal", () => {
  const api = { pluginConfig: { storeDir: "/tmp/permission-fixture" } };
  rememberDisplayedPermissionOptionsOffer(api, context, terminalId, options());
  for (const other of [
    { ...context, sessionId: "new-incarnation" },
    { ...context, sessionKey: "other-owner" }
  ]) assert.throws(() => buildPrivateSetPermissionsArgs(api, parameters(), other), /requires current choices/u);
  assert.throws(() => buildPrivateSetPermissionsArgs(api, { ...parameters(), terminal_id: terminalId + "5" }, context), /requires current choices/u);
  const args = buildPrivateSetPermissionsArgs(api, parameters(), context);
  assert.deepEqual(args, [
    "set-permissions", "--terminal", terminalId, "--expected-binding-token", "binding-private",
    "--expected-catalog-fingerprint", fingerprint, "--mode", "full_access", "--store-dir", "/tmp/permission-fixture"
  ]);
  assert.throws(() => buildPrivateSetPermissionsArgs(api, parameters(), context), /requires current choices/u);
});

test("current-but-unselectable and invented permission modes cannot be used; failed selection consumes the offer", () => {
  for (const mode of ["read_only", "invented_profile"]) {
    const api = {};
    rememberDisplayedPermissionOptionsOffer(api, context, terminalId, options());
    assert.throws(() => buildPrivateSetPermissionsArgs(api, parameters(mode), context), /not advertised/u);
    assert.throws(() => buildPrivateSetPermissionsArgs(api, parameters(), context), /requires current choices/u);
  }
});

test("permission tools reject raw authority and native input syntax", () => {
  assert.deepEqual(Object.keys(permissionOptionsParameters.properties), ["conversation_id", "terminal_id"]);
  assert.deepEqual(Object.keys(setPermissionsParameters.properties), ["conversation_id", "terminal_id", "mode"]);
  assert.equal(setPermissionsParameters.additionalProperties, false);
  for (const field of ["keys", "command", "index", "label", "scope", "profile", "expected_binding_token", "expected_catalog_fingerprint"]) {
    assert.throws(() => buildPrivateSetPermissionsArgs({}, { ...parameters(), [field]: "unexpected" }, context), /only typed semantic fields/u);
  }
  for (const mode of ["/permissions", "Full Access", "2", "Enter", "--full-access", "a\nb"]) {
    assert.throws(() => buildPrivateSetPermissionsArgs({}, parameters(mode), context), /exact semantic id/u);
  }
});

test("permission discovery rejects absent controller incarnation before any native inspection", async () => {
  await assert.rejects(buildPrivatePermissionOptionsArgs({}, { terminal_id: terminalId }, { sessionKey: context.sessionKey }), /conversation incarnation/u);
  await assert.rejects(buildPrivatePermissionOptionsArgs({}, { terminal_id: terminalId, command: "/permissions" }, context), /only typed semantic fields/u);
});

test("malformed or substituted permission catalogs revoke the previous offer", () => {
  const variants = [
    { ...options(), agent: "claude" },
    { ...options(), scope: "current_and_new_sessions" },
    { ...options(), terminal_id: terminalId + "5" },
    { ...options(), choices: [options().choices[0], options().choices[0]] },
    { ...options(), catalog_fingerprint: "b".repeat(64) }
  ];
  for (const bad of variants) {
    const api = {};
    rememberDisplayedPermissionOptionsOffer(api, context, terminalId, options());
    assert.throws(() => rememberDisplayedPermissionOptionsOffer(api, context, terminalId, bad));
    assert.throws(() => buildPrivateSetPermissionsArgs(api, parameters(), context), /requires current choices/u);
  }
});

test("permission outcomes require a verified matching mode and unchanged global defaults", () => {
  assert.equal(isAkkSetPermissionsSuccess(changed()), true);
  assert.equal(isAkkSetPermissionsSuccess({ ...changed(), outcome: "already_effective" }), true);
  for (const partial of [
    { ...changed(), outcome: "uncertain" },
    { ...changed(), do_not_retry: true },
    { ...changed(), effective: undefined },
    { ...changed(), effective: { mode: "ask_for_approval" } },
    { ...changed(), defaults_changed: true },
    { ...changed(), scope: "global" }
  ]) {
    assert.equal(isAkkSetPermissionsSuccess(partial), false);
    assert.match(formatAkkSetPermissionsCommandResult(partial), /Stop before sending the task/u);
  }
});

test("permission slash commands require exact semantic targets and compact List retains the advertised capability", () => {
  assert.deepEqual(parseAkkCommand(`permissions ${terminalId}`), { action: "permission-options", terminalId });
  assert.deepEqual(parseAkkCommand(`set-permissions ${terminalId} full_access`), { action: "set-permissions", terminalId, mode: "full_access" });
  for (const input of [`permissions ${terminalId} extra`, `set-permissions ${terminalId} 2`, `set-permissions short full_access`, `set-permissions ${terminalId} /permissions`]) {
    assert.throws(() => parseAkkCommand(input), /Usage/u);
  }
  const projected = compactAkkListModelProjection({ terminals: [{ id: terminalId,
    permission_control: { status: "supported", scope: "current_session", behaviorProfile: "internal" },
    available_actions: { permission_options: { tool: "agent_knock_knock_permission_options", arguments: { terminal_id: terminalId, expected_binding_token: "private-list-binding" } } }
  }] });
  const row = (projected.terminals as Record<string, unknown>[])[0];
  assert.deepEqual(row.features, { permission_control: { status: "supported", scope: "current_session" } });
  assert.deepEqual(row.available_actions, { permission_options: true });
  assert.doesNotMatch(JSON.stringify(projected), /private-list-binding|behaviorProfile/u);
});

test("controller tool and slash paths keep permission authority private and cannot retry an uncertain mutation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-permission-semantic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relayPath = path.join(root, "relay.mjs");
  const callsPath = path.join(root, "calls.jsonl");
  const resultPath = path.join(root, "set-result.json");
  fs.writeFileSync(resultPath, JSON.stringify(changed()));
  fs.writeFileSync(relayPath, `
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "list") console.log(JSON.stringify({ terminals: [{ id: ${JSON.stringify(terminalId)}, available_actions: {
  permission_options: { tool: "agent_knock_knock_permission_options", arguments: { terminal_id: ${JSON.stringify(terminalId)}, expected_binding_token: "list-private" } }
} }] }));
else if (argv[0] === "permission-options") console.log(JSON.stringify(${JSON.stringify(options())}));
else if (argv[0] === "set-permissions") console.log(fs.readFileSync(${JSON.stringify(resultPath)}, "utf8"));
else throw new Error("unexpected CLI operation");
`);
  const registry = createHostBridgeToolRegistry({ relayPath, relayEnvironment: {}, pluginConfig: {}, context, logger: { info() {}, warn() {} } });
  await assert.rejects(registry.execute("agent_knock_knock_set_permissions", "before", parameters()), /requires current choices/u);
  const displayed = await registry.execute("agent_knock_knock_permission_options", "query", { terminal_id: terminalId });
  assert.doesNotMatch(JSON.stringify(displayed), /binding-private|list-private|catalog_fingerprint|expected_binding_token/u);
  const display = displayed.details as ReturnType<typeof options>;
  assert.equal(display.current, "read_only");
  assert.deepEqual(Object.keys(display.choices[1]).sort(), ["description", "id", "label"]);
  assert.deepEqual(display.available_actions.set_permissions.arguments, { terminal_id: terminalId });
  const result = await registry.execute("agent_knock_knock_set_permissions", "apply", parameters());
  assert.equal(result.isError, undefined);
  assert.equal((result.details as { outcome: string }).outcome, "changed");
  await assert.rejects(registry.execute("agent_knock_knock_set_permissions", "retry", parameters()), /requires current choices/u);
  const slashQuery = await registry.command().execute(`permissions ${terminalId}`);
  assert.match(slashQuery.text, /full_access/u);
  fs.writeFileSync(resultPath, JSON.stringify({ ...changed(), outcome: "uncertain", effective: undefined, do_not_retry: true }));
  const slashMutation = await registry.command().execute(`set-permissions ${terminalId} full_access`);
  assert.equal(slashMutation.isError, true);
  assert.match(slashMutation.text, /Stop before sending the task/u);
  await assert.rejects(registry.execute("agent_knock_knock_set_permissions", "retry-uncertain", parameters()), /requires current choices/u);
  const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls.map((argv) => argv[0]), ["permission-options", "set-permissions", "permission-options", "set-permissions"]);
  assert.equal(calls.some((argv) => argv[0] === "approve" || argv[0] === "send"), false);
  assert.deepEqual(calls[1].slice(0, 9), ["set-permissions", "--terminal", terminalId, "--expected-binding-token", "binding-private", "--expected-catalog-fingerprint", fingerprint, "--mode", "full_access"]);
});


test("canonical backend presets can route from a terminal alias but never manufacture a UI catalog", async () => {
  const api = { pluginConfig: { storeDir: "/tmp/permission-route" } };
  const query = await buildPrivatePermissionOptionsArgs(api, { conversation_id: terminalId }, context);
  assert.deepEqual(query.slice(0, 3), ["permission-options", "--terminal", terminalId]);
  assert.equal(query.includes("--expected-binding-token"), false);
  const args = buildPrivateSetPermissionsArgs(api, { conversation_id: terminalId, mode: "full-access" }, context);
  assert.deepEqual(args.slice(0, 3), ["set-permissions", "--terminal", terminalId]);
  assert.equal(args.includes("--expected-catalog-fingerprint"), false, "A unavailable backend cannot reuse fabricated terminal authority");
  assert.throws(() => buildPrivateSetPermissionsArgs(api, { conversation_id: terminalId, mode: "invented" }, context), /requires current choices/u);
});
