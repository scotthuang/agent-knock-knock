import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, type Agent } from "@deepseek-ai/dsh-agent";
import { CommandRuntime } from "@deepseek-ai/dsh-commands";
import { createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { createHostAdapter } from "@scotthuang/agent-knock-knock/host-adapter";

import { applyWithDependencies } from "../src/index.js";

// Real published DSH registration/execution and pinned core projection; only the
// CLI boundary is a fixture, so no live discovery, monitor or callback can run.
test("published DSH and core separate current List from retained Watches", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dsh-inventory-"));
  const relay = path.join(temporary, "relay.mjs");
  const callsPath = path.join(temporary, "calls.jsonl");
  const conversationId = "codex-cli:v1:inventory-fixture";
  const watch = { watch_id: "codex-cli-watch:fixture", status: "completed", callback_state: "accepted" };
  fs.writeFileSync(relay, [
    'import fs from "node:fs";',
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
    `const row = { conversation_id: ${JSON.stringify(conversationId)}, source: "codex_cli", surface: "cli", agent: "codex", activity_state: "idle", connection_state: "loaded_backend_verified", available_actions: { status: { tool: "agent_knock_knock_status", arguments: { conversation_id: ${JSON.stringify(conversationId)} } } } };`,
    `const watch = ${JSON.stringify(watch)};`,
    'const diagnostic = args.includes("--terminal-debug");',
    'const empty = { ...row, conversation_id: "fixture-empty", native_thread_id: "fixture-empty-thread", unstarted_thread: true, classification: "unstarted_candidate", frontend_presence: "unverified", history_state: "unmaterialized", native_turn_id: null, available_actions: { status: { tool: "agent_knock_knock_status", arguments: { conversation_id: "fixture-empty" } } } };',
    'const presentation = diagnostic ? { mode: "diagnostics" } : { mode: "default", unstarted_candidates_count: 1, unstarted_candidates_omitted: 1 };',
    'if (args[0] === "list") process.stdout.write(JSON.stringify({ conversations: diagnostic ? [empty] : [row], conversation_presentation: presentation, codex_cli_watches: [watch], desktop_watches: [watch], terminal_watches: [watch] }));',
    'else if (args[0] === "watches") process.stdout.write(JSON.stringify({ records: [watch], pagination: { has_more: true, next_args: { hours: 24, limit: 1, cursor: "inventory-next" } } }));',
    'else throw new Error("unexpected command: " + args[0]);',
  ].join("\n"));
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, { mode: "native" });
  new AgentRegistry(ctx);
  new CommandRuntime(ctx);
  new SkillRegistry(ctx);
  const core = createHostAdapter({
    listProjectionVersion: 5,
    relayPath: relay,
    pluginConfig: { storeDir: path.join(temporary, "store") },
    environmentForContext: () => ({}),
    lifecycleEnvironment: {},
    logger: { info() {}, warn() {} },
  });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    cleanup = await applyWithDependencies(ctx, {}, {
      async loadSupportedDeepSeekHarnessRuntime() {
        return { version: "0.2.1-rc.2", createUserMessage, assertSupportedJsonSchema };
      },
      createHostAdapter(options) {
        assert.equal(options.listProjectionVersion, 5);
        return { ...core, lifecycle: { ...core.lifecycle, start() {}, async stop() {} } };
      },
    });
    assert.equal(ctx.tools.schemas().length, 27);
    const agent = { id: "inventory-owner", session: { id: "inventory-owner" }, status: "idle", ctx } as unknown as Agent;
    const detach = ctx.agents.enter(agent, undefined);
    const invoke = (name: string, args: Record<string, unknown>, id: string) => ctx.tools.execute({
      name, arguments: args, agent, callId: ToolCallId(id), signal: new AbortController().signal,
    });
    const list = await invoke("agent_knock_knock_list", {}, "list-current");
    assert.equal(list.isError, false);
    const details = (list.value as { details: Record<string, unknown> }).details;
    assert.equal((details.projection as Record<string, unknown>).version, 5);
    assert.equal((details.conversations as Record<string, unknown>[])[0]?.conversation_id, conversationId);
    assert.deepEqual((details.conversations as Record<string, unknown>[])[0]?.available_actions, { status: true });
    for (const key of ["codex_cli_watches", "desktop_watches", "terminal_watches"]) assert.equal(key in details, false);
    assert.doesNotMatch(JSON.stringify(list.content), /codex-cli-watch:fixture/u);
    const presentation = details.conversation_presentation as Record<string, unknown>;
    assert.equal(presentation.unstarted_candidates_omitted, 1);
    assert.deepEqual(presentation.diagnostic_query, {
      tool: "agent_knock_knock_list", arguments: { terminalDebug: true },
    });

    const watches = await invoke("agent_knock_knock_watches", { hours: 24, limit: 1, conversation_id: conversationId }, "watches-recent");
    assert.equal(watches.isError, false);
    const watchDetails = (watches.value as { details: Record<string, unknown> }).details;
    assert.deepEqual(watchDetails.records, [watch]);
    assert.deepEqual((watchDetails.pagination as Record<string, unknown>).next_args, { hours: 24, limit: 1, cursor: "inventory-next" });
    const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], "list");
    assert.equal(calls[1]?.[0], "watches");
    assert.equal(calls[1]?.[calls[1].indexOf("--conversation") + 1], conversationId);
    assert.equal(calls[1]?.[calls[1].indexOf("--hours") + 1], "24");

    const invalid = await invoke("agent_knock_knock_watches", { hours: 49 }, "invalid-window");
    assert.equal(invalid.isError, true);
    const legacy = await invoke("agent_knock_knock_list", { listView: "history" }, "legacy-history");
    assert.equal(legacy.isError, true);
    assert.match(JSON.stringify(legacy), /agent_knock_knock_watches/u);
    assert.equal(fs.readFileSync(callsPath, "utf8").trim().split("\n").length, 2, "invalid inventory requests must not reach the executor");
    const diagnostic = await invoke("agent_knock_knock_list", { terminalDebug: true }, "list-diagnostic");
    assert.equal(diagnostic.isError, false);
    const diagnosticDetails = (diagnostic.value as { details: Record<string, unknown> }).details;
    assert.equal((diagnosticDetails.projection as Record<string, unknown>).version, 4);
    const empty = (diagnosticDetails.conversations as Record<string, unknown>[])[0]!;
    assert.equal(empty.conversation_id, "fixture-empty");
    assert.equal(empty.unstarted_thread, true);
    assert.equal(empty.frontend_presence, "unverified");
    assert.equal(empty.classification, "unstarted_candidate");
    assert.equal(empty.connected, undefined);
    const diagnosticCall = JSON.parse(fs.readFileSync(callsPath, "utf8").trim().split("\n").at(-1)!) as string[];
    assert.ok(diagnosticCall.includes("--terminal-debug"));
    detach();
  } finally {
    await cleanup?.();
    await core.lifecycle.stop();
    await ctx.fiber.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
