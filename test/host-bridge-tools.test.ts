import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHostBridgeToolRegistry,
  type HostBridgeToolResult
} from "../src/host-bridge-tools.js";

const expectedToolNames = [
  "agent_knock_knock_list",
  "agent_knock_knock_watch",
  "agent_knock_knock_unwatch",
  "agent_knock_knock_list_resumable_threads",
  "agent_knock_knock_native_inspect",
  "agent_knock_knock_model_options",
  "agent_knock_knock_repair_model_control",
  "agent_knock_knock_set_model",
  "agent_knock_knock_identify_foreground",
  "agent_knock_knock_identify_and_send",
  "agent_knock_knock_new_thread",
  "agent_knock_knock_reconcile_binding",
  "agent_knock_knock_resume_thread",
  "agent_knock_knock_status",
  "agent_knock_knock_send",
  "agent_knock_knock_respond",
  "agent_knock_knock_respond_interaction",
  "agent_knock_knock_approve",
  "agent_knock_knock_renew",
  "agent_knock_knock_retry_callback",
  "agent_knock_knock_cancel",
  "agent_knock_knock_close"
] as const;

test("host bridge adapts the shared semantic tool catalog once", () => {
  const registry = createRegistry("session-key", "session-incarnation");
  const listed = registry.list();
  const command = registry.command();

  assert.equal(command.name, "akk");
  assert.equal(command.acceptsArgs, true);
  assert.ok(command.description.length > 0);
  assert.equal(registry.command(), command);
  assert.deepEqual(listed.map((tool) => tool.name), expectedToolNames);
  assert.equal(registry.list(), listed);
  for (const tool of listed) {
    assert.equal(registry.get(tool.name), tool);
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("host bridge executes the shared-catalog akk slash command", async () => {
  const result = await createRegistry(
    "command-session",
    "command-incarnation"
  ).command().execute("help");

  assert.equal(result.isError, undefined);
  assert.match(result.text, /\/akk/u);
});

test("host bridge tools execute with the trusted stable controller context", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-tools-"));
  const relayPath = path.join(directory, "relay.mjs");
  fs.writeFileSync(
    relayPath,
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n",
    "utf8"
  );

  try {
    const registry = createRegistry(
      "controller-session",
      "controller-incarnation",
      relayPath
    );
    const first = await registry.execute(
      "agent_knock_knock_respond",
      "tool-call-1",
      { turn_id: "turn-1", request: "continue" }
    );
    const second = await registry.execute(
      "agent_knock_knock_respond",
      "tool-call-1",
      { turn_id: "turn-1", request: "continue" }
    );
    const argv = resultArgv(first);
    const repeatedArgv = resultArgv(second);

    assert.equal(argumentValue(argv, "--openclaw-session"), "controller-session");
    assert.equal(
      argumentValue(argv, "--message-id"),
      expectedMessageId(
        "controller-session",
        "controller-incarnation",
        "tool-call-1"
      )
    );
    assert.deepEqual(repeatedArgv, argv);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("host bridge tools present Host-neutral callback guidance", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-copy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  fs.writeFileSync(relayPath, `
process.stdout.write(JSON.stringify({
  conversation_id: "turn-1",
  session_id: "session-1",
  turn_id: "turn-1",
  conversation: {
    conversation_id: "turn-1",
    session_id: "session-1",
    turn_id: "turn-1",
    status: "running",
    executor: { kind: "codex", session: "codex-session-1" }
  },
  submission_outcome: "agent_accepted",
  delivery_receipt: "agent_accepted",
  delivered: true,
  launched: true,
  background: true
}));
`, "utf8");
  const registry = createRegistry(
    "controller-session",
    "controller-incarnation",
    relayPath
  );

  for (const tool of registry.list()) {
    assert.doesNotMatch(tool.description, /OpenClaw|Gateway method/u);
  }
  const result = await registry.execute(
    "agent_knock_knock_send",
    "tool-call-host-copy",
    { request: "Run the configured task" }
  );
  const rendered = JSON.stringify(result);
  assert.doesNotMatch(rendered, /OpenClaw|agent-knock-knock\.callback Gateway/u);
  assert.equal(
    (result.details as Record<string, unknown>).callback_method,
    "command_json_v1"
  );
  assert.match(rendered, /controller Host should yield/u);
});

test("host bridge List uses the compact skill-backed model projection", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-list-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  const terminalId = "terminal:v2:herdr:codex:default:w1:p4:80686";
  const repeatedGuidance = "static action explanation ".repeat(2_000);
  fs.writeFileSync(relayPath, `
process.stdout.write(JSON.stringify({
  action_contracts: {
    version: 30,
    instructions: [${JSON.stringify(repeatedGuidance)}],
    actions: { send: { use: ${JSON.stringify(repeatedGuidance)} } }
  },
  terminals: [{
    id: ${JSON.stringify(terminalId)},
    source: "herdr",
    agent: "codex",
    agent_version: "0.154.0",
    pid: 80686,
    cwd: "/Users/example/github/codex",
    process_state: "active",
    screen_state: "idle",
    activity_state: "idle",
    screen_reason: ${JSON.stringify(repeatedGuidance)},
    available_actions: {
      status: {
        tool: "agent_knock_knock_status",
        arguments: { conversation_id: ${JSON.stringify(terminalId)} },
        use: ${JSON.stringify(repeatedGuidance)}
      },
      send: {
        tool: "agent_knock_knock_send",
        scope: "terminal_user_explicit",
        arguments: {
          selector: ${JSON.stringify(terminalId)},
          expected_terminal_token: "private-list-authority"
        },
        missing_required: ["request", "expected_terminal_token"],
        reason: ${JSON.stringify(repeatedGuidance)}
      }
    }
  }],
  terminal_watches: [],
  unavailable_managed_turns: [],
  store: { status: "compatible", store_dir: "/private/store" }
}));
`, "utf8");
  const registry = createRegistry(
    "compact-owner",
    "compact-incarnation",
    relayPath
  );

  const result = await registry.execute(
    "agent_knock_knock_list",
    "list-compact",
    { agent: "codex" }
  );
  const details = result.details as {
    projection: Record<string, unknown>;
    terminals: Array<Record<string, unknown>>;
  };
  assert.deepEqual(details.projection, {
    schema: "agent-knock-knock/host-list-compact",
    version: 1,
    skill: "agent-knock-knock",
    action_contract_version: 30
  });
  assert.deepEqual(details.terminals[0]?.available_actions, {
    status: true,
    send: true
  });
  assert.deepEqual(details.terminals[0]?.action_inputs, {
    send: {
      missing_required: ["request"],
      scope: "terminal_user_explicit"
    }
  });
  const encoded = JSON.stringify(result);
  assert.ok(encoded.length < 3_000, `compact Host List was ${encoded.length} chars`);
  assert.doesNotMatch(encoded, /static action explanation|private-list-authority|\/private\/store/u);
  assert.equal(result.content?.[0]?.text, JSON.stringify(details));
});

test("model switching consumes one controller-scoped private catalog offer", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-model-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  const callsPath = path.join(directory, "calls.ndjson");
  const terminalId = "terminal:v2:tmux:codex:model:0.0:1234";
  fs.writeFileSync(relayPath, `
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "list") {
  process.stdout.write(JSON.stringify({ terminals: [{
    id: ${JSON.stringify(terminalId)},
    available_actions: { model_options: {
      tool: "agent_knock_knock_model_options",
      arguments: {
        terminal_id: ${JSON.stringify(terminalId)},
        expected_binding_token: "binding-from-list"
      }
    }}
  }] }));
} else if (argv[0] === "model-options") {
  process.stdout.write(JSON.stringify({
    terminal_id: ${JSON.stringify(terminalId)},
    agent: "codex",
    scope: "current_and_new_sessions",
    current: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    models: [{
      id: "gpt-6-astra",
      label: "GPT-6 Astra",
      reasoning_efforts: ["high", "ultra"]
    }],
    catalog_fingerprint: "catalog-private",
    available_actions: { set_model: {
      tool: "agent_knock_knock_set_model",
      arguments: {
        terminal_id: ${JSON.stringify(terminalId)},
        expected_binding_token: "binding-private",
        expected_catalog_fingerprint: "catalog-private"
      }
    }}
  }));
} else if (argv[0] === "set-model") {
  process.stdout.write(JSON.stringify({
    outcome: "changed",
    terminal_id: ${JSON.stringify(terminalId)},
    scope: "current_and_new_sessions",
    defaults_changed: true,
    requested: { model: "gpt-6-astra", reasoning_effort: "ultra" },
    effective: { model: "gpt-6-astra", reasoning_effort: "ultra" }
  }));
}
`, "utf8");
  const registry = createRegistry("model-owner", "model-incarnation", relayPath);

  await assert.rejects(
    registry.execute("agent_knock_knock_set_model", "set-before-list", {
      terminal_id: terminalId,
      model: "gpt-6-astra",
      reasoning_effort: "ultra"
    }),
    /requires current choices shown by agent_knock_knock_model_options/u
  );
  const options = await registry.execute(
    "agent_knock_knock_model_options",
    "model-options",
    { terminal_id: terminalId }
  );
  assert.equal(
    Object.hasOwn(options.details as object, "catalog_fingerprint"),
    false
  );
  assert.deepEqual(
    (options.details as {
      available_actions: { set_model: { arguments: unknown } };
    }).available_actions.set_model.arguments,
    { terminal_id: terminalId }
  );
  assert.doesNotMatch(JSON.stringify(options), /binding-private|catalog-private/u);
  await assert.rejects(
    registry.execute("agent_knock_knock_set_model", "raw-scope", {
      terminal_id: terminalId,
      model: "gpt-6-astra",
      reasoning_effort: "ultra",
      scope: "current_session"
    }),
    /accepts only typed semantic fields/u
  );
  const otherController = createRegistry(
    "model-owner",
    "other-model-incarnation",
    relayPath
  );
  await assert.rejects(
    otherController.execute("agent_knock_knock_set_model", "other-owner", {
      terminal_id: terminalId,
      model: "gpt-6-astra",
      reasoning_effort: "ultra"
    }),
    /requires current choices shown/u
  );
  await assert.rejects(
    registry.execute("agent_knock_knock_set_model", "bad-effort", {
      terminal_id: terminalId,
      model: "gpt-6-astra",
      reasoning_effort: "invented"
    }),
    /reasoning_effort was not advertised/u
  );
  await assert.rejects(
    registry.execute("agent_knock_knock_set_model", "consumed", {
      terminal_id: terminalId,
      model: "gpt-6-astra",
      reasoning_effort: "ultra"
    }),
    /requires current choices shown/u
  );
  await registry.execute("agent_knock_knock_model_options", "refresh", {
    terminal_id: terminalId
  });
  const changed = await registry.execute(
    "agent_knock_knock_set_model",
    "valid-set",
    {
      terminal_id: terminalId,
      model: "gpt-6-astra",
      reasoning_effort: "ultra"
    }
  );
  assert.equal(changed.isError, undefined);
  const calls = fs.readFileSync(callsPath, "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const setCall = [...calls].reverse().find((argv) => argv[0] === "set-model");
  assert.ok(setCall);
  assert.equal(argumentValue(setCall, "--model"), "gpt-6-astra");
  assert.equal(argumentValue(setCall, "--reasoning-effort"), "ultra");
  assert.equal(argumentValue(setCall, "--expected-binding-token"), "binding-private");
  assert.equal(
    argumentValue(setCall, "--expected-catalog-fingerprint"),
    "catalog-private"
  );
  assert.equal(setCall.includes("--scope"), false);

  const slashRegistry = createRegistry(
    "model-slash-owner",
    "model-slash-incarnation",
    relayPath
  );
  const listedBySlash = await slashRegistry.command().execute(
    `models ${terminalId}`
  );
  assert.match(listedBySlash.text, /scope: current_and_new_sessions/u);
  assert.match(listedBySlash.text, /applies this selection.*persists/u);
  const changedBySlash = await slashRegistry.command().execute(
    `set-model ${terminalId} gpt-6-astra ultra`
  );
  assert.equal(changedBySlash.isError, undefined);
  assert.match(changedBySlash.text, /changed and verified/u);
  assert.match(changedBySlash.text, /new-session default changed: yes/u);
});

test("model-control repair accepts only terminal_id and consumes fresh private list authority", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-model-repair-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  const callsPath = path.join(directory, "calls.ndjson");
  const terminalId = "terminal:v2:tmux:codex:model-repair:0.0:1234";
  fs.writeFileSync(relayPath, `
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "list") {
  process.stdout.write(JSON.stringify({ terminals: [{
    id: ${JSON.stringify(terminalId)},
    available_actions: { repair_model_control: {
      tool: "agent_knock_knock_repair_model_control",
      arguments: {
        terminal_id: ${JSON.stringify(terminalId)},
        expected_binding_token: "repair-binding-private"
      }
    }}
  }] }));
} else if (argv[0] === "repair-model-control") {
  process.stdout.write(JSON.stringify({
    terminal_id: ${JSON.stringify(terminalId)},
    agent: "codex",
    agent_version: "0.154.0",
    outcome: "repaired",
    terminal_input_attempted: true,
    composer_postcondition: "empty",
    do_not_retry: false
  }));
}
`, "utf8");
  const registry = createRegistry(
    "model-repair-owner",
    "model-repair-incarnation",
    relayPath
  );

  await assert.rejects(
    registry.execute(
      "agent_knock_knock_repair_model_control",
      "raw-repair-command",
      { terminal_id: terminalId, command: "/model" }
    ),
    /accepts only typed semantic fields/u
  );
  const repaired = await registry.execute(
    "agent_knock_knock_repair_model_control",
    "repair",
    { terminal_id: terminalId }
  );
  assert.equal(repaired.isError, undefined);
  assert.doesNotMatch(JSON.stringify(repaired), /repair-binding-private/u);
  const calls = fs.readFileSync(callsPath, "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const repairCall = calls.find((argv) => argv[0] === "repair-model-control");
  assert.ok(repairCall);
  assert.equal(
    argumentValue(repairCall, "--expected-binding-token"),
    "repair-binding-private"
  );
  assert.equal(repairCall.includes("--command"), false);

  const repairedBySlash = await registry.command().execute(
    `repair-model-control ${terminalId}`
  );
  assert.equal(repairedBySlash.isError, undefined);
  assert.match(repairedBySlash.text, /cleared and verified/u);
});

test("host bridge rejects unknown tool names", async () => {
  const registry = createRegistry("session-key", "session-incarnation");
  await assert.rejects(
    registry.execute("agent_knock_knock_missing", "call-1", {}),
    /unknown host bridge tool agent_knock_knock_missing/u
  );
});

test("host bridge relay leaves the embedding Host event loop responsive", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-async-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  fs.writeFileSync(
    relayPath,
    "setTimeout(() => process.stdout.write(JSON.stringify({ terminals: [] })), 80);\n",
    "utf8"
  );
  const registry = createRegistry("async-session", "async-owner", relayPath);
  let eventLoopAdvanced = false;
  const resultPromise = registry.execute(
    "agent_knock_knock_list",
    "async-call",
    {}
  );
  await new Promise<void>((resolve) => setImmediate(() => {
    eventLoopAdvanced = true;
    resolve();
  }));

  assert.equal(eventLoopAdvanced, true);
  const result = await resultPromise;
  assert.deepEqual(result.details, {
    projection: {
      schema: "agent-knock-knock/host-list-compact",
      version: 1,
      skill: "agent-knock-knock"
    },
    terminals: [],
    terminal_watches: [],
    unavailable_managed_turns: []
  });
});

function createRegistry(
  sessionKey: string,
  sessionId: string,
  relayPath = new URL("../src/cli.js", import.meta.url).pathname
) {
  return createHostBridgeToolRegistry({
    relayPath,
    relayEnvironment: {},
    pluginConfig: {},
    context: { sessionKey, sessionId },
    logger: {
      info() {},
      warn() {}
    }
  });
}

function resultArgv(result: HostBridgeToolResult): string[] {
  assert.ok(result.details && typeof result.details === "object");
  const argv = (result.details as { argv?: unknown }).argv;
  assert.ok(Array.isArray(argv));
  assert.ok(argv.every((value) => typeof value === "string"));
  return argv;
}

function argumentValue(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  assert.ok(argv[index + 1], `missing value for ${name}`);
  return argv[index + 1];
}

function expectedMessageId(
  sessionKey: string,
  sessionId: string,
  toolCallId: string
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      sessionKey,
      sessionId,
      "agent_knock_knock_respond",
      toolCallId
    ]))
    .digest("hex");
  return `msg-openclaw-${digest}`;
}
