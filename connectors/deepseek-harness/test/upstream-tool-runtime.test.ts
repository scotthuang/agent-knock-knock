import assert from "node:assert/strict";
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
