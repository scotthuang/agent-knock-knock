import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";

/** Exercise the actual Host executor's raw JSON batch boundary, including parsing. */
export async function executeNativeTool(ctx: Context, input: {
  name: string; callId: ToolCallId; arguments: unknown; agent: Agent; signal: AbortSignal;
}) {
  const batch = await ctx.tools.execute({
    calls: [{ type: "tool-call", id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    agent: input.agent, signal: input.signal,
  });
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0]?.callId, input.callId);
  return batch.results[0]!.result;
}
