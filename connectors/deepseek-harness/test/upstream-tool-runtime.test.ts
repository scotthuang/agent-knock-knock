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
import {
  createHostAdapter,
  type HostAdapterControllerContext,
} from "@scotthuang/agent-knock-knock/host-adapter";

import { applyWithDependencies } from "../src/index.js";
import { openCallbackAuthority } from "../src/callback-authority.js";
import { sessionHeaderIdentity } from "../src/host-ports.js";
import type { AgentRouteTable } from "../src/routes.js";

// Exercise the published Host's registry and execution pipeline, not a local
// substitute. The AKK executor is captured so this test never operates a user
// conversation, starts a monitor, or invokes a model.
test("published DSH ToolRuntime preserves exact targets, typed answers and canonical results", async () => {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, { mode: "native" });
  new AgentRegistry(ctx);
  new CommandRuntime(ctx);
  new SkillRegistry(ctx);
  const acceptedCalls: Array<{
    context: HostAdapterControllerContext;
    name: string;
    callId: string;
    args: Readonly<Record<string, unknown>>;
  }> = [];
  const core = createHostAdapter({
    environmentForContext: () => ({}),
    lifecycleEnvironment: {},
    logger: { info() {}, warn() {} },
  });
  const result = {
    content: [{ type: "text", text: "question accepted" }],
    details: {
      native_turn_id: "turn-exact",
      interaction_id: "question-exact",
      accepted: true,
      callback_expected: true,
    },
  };
  let cleanup: (() => Promise<void>) | undefined;
  try {
    cleanup = await applyWithDependencies(ctx, { pluginConfig: { storeDir: "/private/explicit-dsh-store" } }, {
      async loadSupportedDeepSeekHarnessRuntime() {
        return { version: "0.2.1-rc.2", createUserMessage, assertSupportedJsonSchema };
      },
      createHostAdapter(options) {
        assert.equal(options.pluginConfig?.storeDir, "/private/explicit-dsh-store");
        return {
          ...core,
          lifecycle: { ...core.lifecycle, start() {}, async stop() {} },
          async executeTool(context, name, callId, args) {
            acceptedCalls.push({ context, name, callId, args });
            return result;
          },
        };
      },
    });
    assert.equal(ctx.tools.schemas().length, core.tools.length);
    const agent = {
      id: "controller-exact",
      session: { id: "controller-exact" },
      status: "idle",
      ctx,
    } as unknown as Agent;
    const detach = ctx.agents.enter(agent, undefined);
    const signal = new AbortController().signal;
    const args = {
      conversation_id: "desktop:v1:exact_thread",
      interaction_id: "question-exact",
      answers: [
        { question_id: "one", response_kind: "single_select", selected_option_ids: ["option-a"] },
        { question_id: "two", response_kind: "free_text", text: "中文 👩🏽‍💻 é\nline two" },
      ],
    };
    const outcome = await ctx.tools.execute({
      name: "agent_knock_knock_respond_interaction",
      callId: ToolCallId("call-exact"),
      arguments: args,
      agent,
      signal,
    });
    assert.equal(outcome.isError, false);
    assert.deepEqual(outcome.value, result);
    assert.deepEqual(outcome.content, result.content);
    assert.equal(acceptedCalls.length, 1);
    assert.equal(acceptedCalls[0]?.context.authority, agent);
    assert.equal(acceptedCalls[0]?.callId, "call-exact");
    assert.deepEqual(acceptedCalls[0]?.args, args);

    // DSH's discovery projection cannot encode target exclusivity. The full
    // core validator must still reject it before reaching the executor.
    const ambiguous = await ctx.tools.execute({
      name: "agent_knock_knock_status",
      callId: ToolCallId("call-ambiguous"),
      arguments: { conversation_id: "desktop:v1:exact_thread", watch_id: "desktop-watch:other" },
      agent,
      signal,
    });
    assert.equal(ambiguous.isError, true);
    assert.equal(acceptedCalls.length, 1);

    detach();
    const stale = await ctx.tools.execute({
      name: "agent_knock_knock_approve",
      callId: ToolCallId("call-stale"),
      arguments: {
        conversation_id: "desktop:v1:exact_thread",
        interaction_id: "approval-exact",
        decision: "reject",
      },
      agent,
      signal,
    });
    assert.equal(stale.isError, true);
    assert.equal(acceptedCalls.length, 1);
  } finally {
    await cleanup?.();
    await core.lifecycle.stop();
    await ctx.fiber.dispose();
  }
});

test("published DSH tools retain one exact Host adapter authority while persisted callback aliases restore", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dsh-tool-aliases-"));
  const storeDirectory = path.join(directory, "store");
  const relayPath = path.join(directory, "relay.mjs");
  const logPath = path.join(directory, "calls.jsonl");
  // Keep the real adapter and semantic tools, replacing only their CLI process
  // with an inert fixture. Even Send cannot reach a terminal or user Store.
  fs.writeFileSync(relayPath, `
import fs from "node:fs";
fs.appendFileSync(process.env.AKK_TEST_LOG, JSON.stringify({
  controller: process.env.AKK_TEST_CONTROLLER,
  argv: process.argv.slice(2),
}) + "\\n");
process.stdout.write(JSON.stringify(process.argv[2] === "list" ? { conversations: [] } : {
  session_id: "fixture-session", turn_id: "fixture-turn", conversation_id: "fixture-turn",
  status: "running", delivered: true,
}));
`);
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, { mode: "native" });
  new AgentRegistry(ctx);
  new CommandRuntime(ctx);
  new SkillRegistry(ctx);
  const header = { id: "session-restored", version: 4, createdAt: 1000, isSeeded: false };
  const identity = sessionHeaderIdentity(header);
  const controllers = ["callback-old-1", "callback-old-2", "callback-old-3", "command-current"];
  const authorityOptions = { profileDirectory: directory, storeDirectory };
  const previousAuthority = openCallbackAuthority(authorityOptions);
  for (const controller of controllers) previousAuthority.bindFreshRoute(identity, controller);
  previousAuthority.close();

  const admitted: Array<ReturnType<typeof createUserMessage>> = [];
  const persisted = new Set<string>();
  const agent = {
    id: header.id,
    session: { id: header.id, header },
    status: "idle",
    ctx,
    followup(message: ReturnType<typeof createUserMessage>) { admitted.push(message); },
  } as unknown as Agent;
  const detach = ctx.agents.enter(agent, undefined);
  let routes: AgentRouteTable | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let restored = 0;
  let callSequence = 0;
  const execute = async (name: string, args: Record<string, unknown>) => {
    const outcome = await ctx.tools.execute({
      name,
      callId: ToolCallId(`alias-call-${++callSequence}`),
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
  };
  try {
    cleanup = await applyWithDependencies(ctx, { pluginConfig: { storeDir: storeDirectory } }, {
      async loadSupportedDeepSeekHarnessRuntime() {
        return { version: "0.2.1-rc.2", createUserMessage, assertSupportedJsonSchema };
      },
      createDshRecoveryHostPorts() {
        return {
          ...authorityOptions,
          sessionIdentity(owner) {
            assert.equal(owner, agent);
            return sessionHeaderIdentity(owner.session.header);
          },
          async observeSessionIdentity(sessionId) {
            assert.equal(sessionId, header.id);
            return identity;
          },
          async restoreAgent(route) {
            assert.equal(route.sessionId, header.id);
            assert.equal(route.headerFingerprint, identity.headerFingerprint);
            restored += 1;
            return agent;
          },
          async flush(owner) {
            assert.equal(owner, agent);
            for (const message of admitted) persisted.add(String(message.id));
            return true;
          },
          async findOwnMessage(owner, messageId) {
            assert.equal(owner, agent);
            return persisted.has(messageId);
          },
        };
      },
      createCallbackIpcServer(options) {
        routes = options.routes;
        return { async start() {}, async stop() {} };
      },
      createHostAdapter(options) {
        const adapter = createHostAdapter({
          ...options,
          relayPath,
          environmentForContext(context) {
            return {
              ...options.environmentForContext(context),
              AKK_TEST_CONTROLLER: context.sessionId,
              AKK_TEST_LOG: logPath,
            };
          },
        });
        return { ...adapter, lifecycle: { ...adapter.lifecycle, start() {}, async stop() {} } };
      },
    });
    // This first call caches the exact Agent's canonical controller in core.
    await execute("agent_knock_knock_list", {});
    assert.ok(routes);
    for (const [index, controllerId] of controllers.slice(0, -1).entries()) {
      const request = {
        controllerId,
        deliveryId: `delivery-${index}`,
        messageId: `message-${index}`,
        idempotencyKey: `receipt-${index}`,
        body: "fixture callback",
      };
      assert.equal((await routes.deliverRecoverable(request)).result.status, "accepted");
      await execute("agent_knock_knock_list", {});
      await execute("agent_knock_knock_status", { turn_id: "fixture-turn" });
      await execute("agent_knock_knock_send", { session_id: "fixture-session", request: "fixture request" });
    }
    assert.equal(restored, 3);
    assert.equal(admitted.length, 3);
    assert.equal(persisted.size, 3);
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { controller: string; argv: string[] });
    assert.equal(calls.length, 10);
    assert.deepEqual([...new Set(calls.map((call) => call.controller))], ["command-current"]);
    assert.deepEqual(calls.map((call) => call.argv[0]), [
      "list", "list", "status", "send", "list", "status", "send", "list", "status", "send",
    ]);
  } finally {
    await cleanup?.();
    detach();
    await ctx.fiber.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
