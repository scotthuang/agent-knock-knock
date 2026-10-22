import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHostAdapter,
  type HostBridgeToolResult,
} from "@scotthuang/agent-knock-knock/host-adapter";
import { compileAuthoritativeInputValidator } from "../src/schema-adapter.js";

test("pinned core keeps List conversation-only and exposes bounded Watches independently", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-pi-inventory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.mjs");
  const logPath = path.join(directory, "calls.jsonl");
  // Only discovery data is synthetic. Tool schemas, argument mapping, private
  // authority handling and model-facing projection use the actual pinned core.
  fs.writeFileSync(relayPath, `
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.AKK_TEST_LOG, JSON.stringify(argv) + "\\n");
const result = argv[0] === "list" ? {
  conversation_presentation: argv.includes("--terminal-debug") ? { mode: "diagnostics" } : {
    mode: "default", unstarted_candidates_count: 1, unstarted_candidates_omitted: 1 },
  conversations: argv.includes("--terminal-debug") ? [{ conversation_id: "fixture-empty", source: "codex_cli",
    native_thread_id: "fixture-empty-thread", unstarted_thread: true, classification: "unstarted_candidate",
    frontend_presence: "unverified", connection_state: "loaded_backend_verified",
    history_state: "unmaterialized", native_turn_id: null, capabilities: { status: true } }] : [{ conversation_id: "fixture-cli", source: "codex_cli",
    native_thread_id: "fixture-thread", title: "Fixture", activity_state: "idle",
    capabilities: { status: true } }],
  codex_cli_watches: [{ watch_id: "old-watch", final_text: "historical-body" }],
  desktop_watches: [{ watch_id: "old-desktop-watch" }]
} : { watches: [{ watch_id: "fixture-watch", status: "active" }] };
process.stdout.write(JSON.stringify(result));
`, "utf8");
  const adapter = createHostAdapter({
    relayPath,
    environmentForContext: () => ({ AKK_TEST_LOG: logPath }),
    logger: { info() {}, warn() {} },
  });
  t.after(() => adapter.lifecycle.stop());
  const context = { authority: {}, sessionKey: "fixture-owner", sessionId: "fixture-owner" };

  const list = modelResult(await adapter.executeTool(context, "agent_knock_knock_list", "list-call", {}));
  assert.equal((list.conversations as unknown[]).length, 1);
  assert.equal(list.codex_cli_watches, undefined);
  assert.equal(list.desktop_watches, undefined);
  const presentation = list.conversation_presentation as Record<string, unknown>;
  assert.equal(presentation.unstarted_candidates_omitted, 1);
  assert.deepEqual(presentation.diagnostic_query, {
    tool: "agent_knock_knock_list", arguments: { terminalDebug: true },
  });
  assert.ok(!JSON.stringify(list).includes("historical-body"));

  const watches = adapter.tools.find((tool) => tool.name === "agent_knock_knock_watches")!;
  const validate = compileAuthoritativeInputValidator(watches.inputSchema);
  assert.doesNotThrow(() => validate({}));
  assert.doesNotThrow(() => validate({ hours: 48, limit: 100 }));
  assert.throws(() => validate({ hours: 49 }), /did not match/u);
  assert.throws(() => validate({ limit: 101 }), /did not match/u);
  const inventory = modelResult(await adapter.executeTool(context, watches.name, "watches-call", {
    hours: 24, limit: 7, conversation_id: "fixture-cli",
  }));
  assert.deepEqual(inventory.watches, [{ watch_id: "fixture-watch", status: "active" }]);
  const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(calls[0]?.[0], "list");
  assert.equal(calls[1]?.[0], "watches");
  for (const [flag, value] of [["--hours", "24"], ["--limit", "7"], ["--conversation", "fixture-cli"]]) {
    assert.equal(calls[1]?.[calls[1]!.indexOf(flag!) + 1], value, flag);
  }

  await assert.rejects(adapter.executeTool(context, "agent_knock_knock_list", "legacy-list-call", { all: true }), /Use agent_knock_knock_watches/u);
  assert.equal(fs.readFileSync(logPath, "utf8").trim().split("\n").length, 2);

  const diagnostic = modelResult(await adapter.executeTool(context, "agent_knock_knock_list", "diagnostic-call", { terminalDebug: true }));
  const empty = (diagnostic.conversations as Record<string, unknown>[])[0]!;
  assert.equal(empty.conversation_id, "fixture-empty");
  assert.equal(empty.unstarted_thread, true);
  assert.equal(empty.frontend_presence, "unverified");
  assert.equal(empty.classification, "unstarted_candidate");
  assert.equal(empty.connected, undefined);
  const diagnosticCall = JSON.parse(fs.readFileSync(logPath, "utf8").trim().split("\n").at(-1)!) as string[];
  assert.ok(diagnosticCall.includes("--terminal-debug"));
});

function modelResult(result: HostBridgeToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true);
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.ok(text);
  return JSON.parse(text) as Record<string, unknown>;
}
