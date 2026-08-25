import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHostAdapter,
  type HostAdapterControllerContext
} from "../src/host-adapter.js";
import { listParameters } from "../src/openclaw-plugin-schemas.js";

const expectedToolNames = [
  "agent_knock_knock_list",
  "agent_knock_knock_watch",
  "agent_knock_knock_unwatch",
  "agent_knock_knock_list_resumable_threads",
  "agent_knock_knock_native_inspect",
  "agent_knock_knock_new_thread",
  "agent_knock_knock_reconcile_binding",
  "agent_knock_knock_resume_thread",
  "agent_knock_knock_status",
  "agent_knock_knock_send",
  "agent_knock_knock_respond",
  "agent_knock_knock_approve",
  "agent_knock_knock_renew",
  "agent_knock_knock_retry_callback",
  "agent_knock_knock_cancel",
  "agent_knock_knock_close"
] as const;

test("public Host adapter registers metadata once and isolates exact owners", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-adapter-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  fs.writeFileSync(relayPath, `
process.stdout.write(JSON.stringify({
  controller: process.env.AKK_TEST_CONTROLLER,
  argv: process.argv.slice(2)
}));
`, "utf8");
  const environmentCalls: string[] = [];
  const adapter = createHostAdapter({
    relayPath,
    logger: logger(),
    environmentForContext(context) {
      environmentCalls.push(context.sessionId);
      return { AKK_TEST_CONTROLLER: context.sessionId };
    }
  });
  const authorityA = {};
  const authorityB = {};
  const contextA = controller(authorityA, "controller-a");
  const contextB = controller(authorityB, "controller-b");

  assert.equal(adapter.command.name, "akk");
  assert.equal(adapter.command.acceptsArgs, true);
  assert.deepEqual(adapter.tools.map((tool) => tool.name), expectedToolNames);
  assert.equal(environmentCalls.length, 0, "metadata must not resolve a route");

  const [resultA, resultB] = await Promise.all([
    adapter.executeTool(
      contextA,
      "agent_knock_knock_respond",
      "same-call",
      { turn_id: "turn-a", request: "continue A" }
    ),
    adapter.executeTool(
      contextB,
      "agent_knock_knock_respond",
      "same-call",
      { turn_id: "turn-b", request: "continue B" }
    )
  ]);
  assert.equal(detail(resultA).controller, "controller-a");
  assert.equal(detail(resultB).controller, "controller-b");
  assert.notEqual(
    argumentValue(detail(resultA).argv, "--message-id"),
    argumentValue(detail(resultB).argv, "--message-id")
  );
  assert.deepEqual(environmentCalls.sort(), ["controller-a", "controller-b"]);

  await adapter.executeCommand(contextA, "help");
  assert.equal(environmentCalls.length, 2, "one registry is cached per owner");
  await assert.rejects(
    adapter.executeCommand(
      controller(authorityA, "replacement-controller"),
      "help"
    ),
    /authority cannot be reused/u
  );

  adapter.disposeContext(authorityA);
  await adapter.executeCommand(
    controller(authorityA, "replacement-controller"),
    "help"
  );
  assert.equal(environmentCalls.at(-1), "replacement-controller");
});

test("public Host adapter propagates AbortSignal to the async relay", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-adapter-abort-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  fs.writeFileSync(
    relayPath,
    "setTimeout(() => process.stdout.write(JSON.stringify({ terminals: [] })), 1000);\n",
    "utf8"
  );
  const adapter = createHostAdapter({
    relayPath,
    logger: logger(),
    environmentForContext: () => ({})
  });
  const abort = new AbortController();
  const execution = adapter.executeTool(
    controller({}, "abort-controller"),
    "agent_knock_knock_list",
    "abort-call",
    {},
    abort.signal
  );
  abort.abort();

  await assert.rejects(execution, (error: unknown) =>
    error instanceof Error && error.name === "AbortError"
  );
});

test("public Host adapter slash command preserves AbortError", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-command-abort-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  fs.writeFileSync(
    relayPath,
    "setTimeout(() => process.stdout.write(JSON.stringify({ terminals: [] })), 1000);\n",
    "utf8"
  );
  const adapter = createHostAdapter({
    relayPath,
    logger: logger(),
    environmentForContext: () => ({})
  });
  const abort = new AbortController();
  const execution = adapter.executeCommand(
    controller({}, "abort-command-controller"),
    "list",
    abort.signal
  );
  abort.abort();

  await assert.rejects(execution, (error: unknown) =>
    error instanceof Error && error.name === "AbortError"
  );
});

test("public Host adapter snapshots each controller environment", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-adapter-env-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  fs.writeFileSync(relayPath, `
process.stdout.write(JSON.stringify({
  environment_value: process.env.AKK_TEST_VALUE,
  terminals: []
}));
`, "utf8");
  const suppliedEnvironment = { AKK_TEST_VALUE: "owner-original" };
  const adapter = createHostAdapter({
    relayPath,
    logger: logger(),
    environmentForContext: () => suppliedEnvironment
  });
  const context = controller({}, "environment-controller");

  await adapter.executeCommand(context, "help");
  suppliedEnvironment.AKK_TEST_VALUE = "owner-mutated";
  const result = await adapter.executeTool(
    context,
    "agent_knock_knock_list",
    "environment-call",
    {}
  );

  assert.equal(
    (result.details as Record<string, unknown>).environment_value,
    "owner-original"
  );
});

test("public Host metadata is a lossless owner-isolated immutable snapshot", () => {
  const create = () => createHostAdapter({
    logger: logger(),
    environmentForContext: () => ({})
  });
  const first = create();
  const second = create();
  const firstList = first.tools.find((tool) =>
    tool.name === "agent_knock_knock_list"
  );
  const secondList = second.tools.find((tool) =>
    tool.name === "agent_knock_knock_list"
  );
  assert.ok(firstList);
  assert.ok(secondList);

  assert.deepEqual(firstList.inputSchema, listParameters);
  assert.deepEqual(secondList.inputSchema, listParameters);
  assert.notEqual(firstList.inputSchema, secondList.inputSchema);
  assert.equal(Object.isFrozen(first.command), true);
  assert.equal(Object.isFrozen(first.tools), true);
  assert.equal(Object.isFrozen(firstList), true);
  assert.equal(Object.isFrozen(firstList.inputSchema), true);
  const firstProperties = firstList.inputSchema.properties as Record<
    string,
    Record<string, unknown>
  >;
  const secondProperties = secondList.inputSchema.properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(Object.isFrozen(firstProperties), true);
  assert.equal(Object.isFrozen(firstProperties.agent), true);
  assert.equal(Reflect.set(firstProperties.agent, "type", "number"), false);
  assert.equal(firstProperties.agent.type, "string");
  assert.equal(secondProperties.agent.type, "string");
});

test("public Host adapter owns one shared monitor lifecycle", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-adapter-life-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  const logPath = path.join(directory, "calls.log");
  fs.writeFileSync(relayPath, `
import fs from "node:fs";
fs.appendFileSync(
  process.env.AKK_TEST_LOG,
  process.argv[2] + ":" + process.env.AKK_TEST_VALUE + "\\n"
);
process.stdout.write("{}");
`, "utf8");
  const lifecycleEnvironment = {
    AKK_TEST_LOG: logPath,
    AKK_TEST_VALUE: "lifecycle-original"
  };
  const adapter = createHostAdapter({
    relayPath,
    logger: logger(),
    lifecycleIntervalMs: 60_000,
    lifecycleEnvironment,
    environmentForContext: () => ({})
  });
  lifecycleEnvironment.AKK_TEST_VALUE = "lifecycle-mutated";

  assert.equal(adapter.lifecycle, adapter.lifecycle);
  adapter.lifecycle.start();
  await adapter.lifecycle.stop();
  assert.deepEqual(
    fs.readFileSync(logPath, "utf8").trim().split("\n"),
    [
      "reconcile-monitors:lifecycle-original",
      "reconcile-watches:lifecycle-original"
    ]
  );
});

test("the packed public subpath resolves to the stable Host adapter facade", async () => {
  const packageName = [
    "@scotthuang",
    "agent-knock-knock",
    "host-adapter"
  ].join("/");
  const facade = await import(packageName) as Record<string, unknown>;

  assert.equal(typeof facade.createHostAdapter, "function");
  assert.equal(typeof facade.createTrustedHostProfileRuntime, "function");
  assert.equal(typeof facade.hostProfileRelayEnvironment, "function");
  assert.equal(typeof facade.defaultHostAdapterRelayPath, "string");

  const require = createRequire(import.meta.url);
  for (const subpath of [
    "schemas/host-profile-v1.schema.json",
    "examples/host-profiles/command-json-starter.json",
    "templates/openclaw-skills/agent-knock-knock/SKILL.md",
    "docs/host-bridge-profiles.md",
    "docs/assets/agent-knock-knock-icon.png",
    "openclaw.plugin.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ]) {
    assert.ok(require.resolve(`@scotthuang/agent-knock-knock/${subpath}`));
  }
});

function controller(
  authority: object,
  id: string
): HostAdapterControllerContext {
  return { authority, sessionKey: id, sessionId: id };
}

function logger() {
  return {
    info() {},
    warn() {}
  };
}

function detail(result: { readonly details?: unknown }): {
  controller: string;
  argv: string[];
} {
  assert.ok(result.details && typeof result.details === "object");
  const value = result.details as { controller?: unknown; argv?: unknown };
  assert.equal(typeof value.controller, "string");
  assert.ok(Array.isArray(value.argv));
  assert.ok(value.argv.every((item) => typeof item === "string"));
  return value as { controller: string; argv: string[] };
}

function argumentValue(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  assert.ok(argv[index + 1], `missing value for ${name}`);
  return argv[index + 1]!;
}
