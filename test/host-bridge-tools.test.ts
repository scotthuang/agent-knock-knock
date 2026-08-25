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

test("host bridge captures the existing semantic tool contract once", () => {
  const registry = createRegistry("session-key", "session-incarnation");
  const listed = registry.list();

  assert.deepEqual(listed.map((tool) => tool.name), expectedToolNames);
  assert.equal(new Set(listed.map((tool) => tool.name)).size, 16);
  assert.equal(registry.list(), listed);
  for (const tool of listed) {
    assert.equal(registry.get(tool.name), tool);
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, "object");
  }
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

test("host bridge rejects unknown tool names", async () => {
  const registry = createRegistry("session-key", "session-incarnation");
  await assert.rejects(
    registry.execute("agent_knock_knock_missing", "call-1", {}),
    /unknown host bridge tool agent_knock_knock_missing/u
  );
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
