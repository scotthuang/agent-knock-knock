import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";

import {
  createHostBridgeMcpServer,
  drainHostBridgeMcpCalls,
  getHostBridgeMcpActiveCallCount,
  hostBridgeToolCallId,
  HOST_BRIDGE_MCP_SERVER_NAME
} from "../src/host-bridge-mcp.js";
import type {
  HostBridgeToolDescriptor,
  HostBridgeToolRegistry,
  HostBridgeToolResult
} from "../src/host-bridge-tools.js";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    turn_id: { type: "string", minLength: 1 }
  },
  required: ["turn_id"]
} as const;

test("MCP server initializes and advertises all exact host bridge tools", async () => {
  const harness = await connectHarness(createFakeRegistry());
  try {
    assert.deepEqual(harness.client.getServerVersion(), {
      name: HOST_BRIDGE_MCP_SERVER_NAME,
      version: "0.12.16-test"
    });
    assert.deepEqual(harness.client.getServerCapabilities(), { tools: {} });

    const listed = await harness.client.listTools();
    assert.equal(listed.tools.length, 16);
    assert.deepEqual(
      listed.tools.map(({ name }) => name),
      Array.from({ length: 16 }, (_, index) => `akk_test_${index}`)
    );
    assert.equal(listed.tools[0]?.description, "Test semantic tool 0");
    assert.deepEqual(listed.tools[0]?.inputSchema, inputSchema);
  } finally {
    await harness.close();
  }
});

test("MCP server rejects unknown tools and invalid authority arguments before execution", async () => {
  let executionCount = 0;
  const registry = createFakeRegistry(async () => {
    executionCount += 1;
    return { content: [{ type: "text", text: "unexpected" }] };
  });
  const harness = await connectHarness(registry);
  try {
    await assertInvalidParams(
      harness.client.callTool({
        name: "akk_missing",
        arguments: { turn_id: "turn-1" }
      }),
      /Unknown host bridge tool/u
    );
    await assertInvalidParams(
      harness.client.callTool({
        name: "akk_test_0",
        arguments: {
          turn_id: "turn-1",
          callback_route: { transport: "command_json_v1" },
          profile_id: "untrusted-profile"
        }
      }),
      /Invalid arguments/u
    );
    assert.equal(executionCount, 0);
  } finally {
    await harness.close();
  }
});

test("MCP server rejects task-mode calls without executing the tool", async () => {
  let executionCount = 0;
  const registry = createFakeRegistry(async () => {
    executionCount += 1;
    return { content: [] };
  });
  const harness = await connectHarness(registry);
  try {
    await assert.rejects(
      harness.client.callTool({
        name: "akk_test_0",
        arguments: { turn_id: "turn-1" },
        task: { ttl: 1_000 }
      }),
      (error: unknown) => error instanceof McpError
    );
    assert.equal(executionCount, 0);
  } finally {
    await harness.close();
  }
});

test("MCP server maps results and namespaces request ids by Bridge instance", async () => {
  const calls: Array<{
    readonly name: string;
    readonly toolCallId: string;
    readonly args: Readonly<Record<string, unknown>>;
  }> = [];
  const registry = createFakeRegistry(async (name, toolCallId, args) => {
    calls.push({ name, toolCallId, args });
    return {
      content: [{ type: "text", text: "accepted" }],
      details: { turn_id: "turn-1", state: "accepted" },
      isError: false
    };
  });
  const harness = await connectHarness(registry, "bridge-instance-a");
  try {
    const result = await harness.client.callTool({
      name: "akk_test_3",
      arguments: { turn_id: "turn-1" }
    });

    assert.deepEqual(result, {
      content: [{ type: "text", text: "accepted" }],
      structuredContent: { turn_id: "turn-1", state: "accepted" },
      isError: false
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "akk_test_3");
    assert.match(
      calls[0]?.toolCallId ?? "",
      /^host-bridge:\["bridge-instance-a",\d+\]$/u
    );
    assert.deepEqual(calls[0]?.args, { turn_id: "turn-1" });

    const restarted = await connectHarness(registry, "bridge-instance-b");
    try {
      await restarted.client.callTool({
        name: "akk_test_3",
        arguments: { turn_id: "turn-2" }
      });
    } finally {
      await restarted.close();
    }
    assert.equal(calls.length, 2);
    assert.match(
      calls[1]?.toolCallId ?? "",
      /^host-bridge:\["bridge-instance-b",\d+\]$/u
    );
    assert.notEqual(calls[1]?.toolCallId, calls[0]?.toolCallId);
    assert.notEqual(
      hostBridgeToolCallId("bridge-instance-a", 1),
      hostBridgeToolCallId("bridge-instance-a", "1")
    );
  } finally {
    await harness.close();
  }
});

test("MCP server normalizes omitted arguments to an empty object", async () => {
  let receivedArgs: Readonly<Record<string, unknown>> | undefined;
  const registry = createFakeRegistry(
    async (_name, _toolCallId, args) => {
      receivedArgs = args;
      return { content: [{ type: "text", text: "listed" }] };
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  );
  const harness = await connectHarness(registry);
  try {
    await harness.client.callTool({ name: "akk_test_0" });
    assert.deepEqual(receivedArgs, {});
  } finally {
    await harness.close();
  }
});

test("MCP server returns bounded sanitized model-facing execution errors", async () => {
  const registry = createFakeRegistry(async () => {
    const error = new Error(`public\u001B[31m\n${"x".repeat(2_000)}`);
    error.stack = "private-stack-marker";
    throw error;
  });
  const harness = await connectHarness(registry);
  try {
    const result = await harness.client.callTool({
      name: "akk_test_0",
      arguments: { turn_id: "turn-1" }
    });
    const text = resultText(result);

    assert.equal(result.isError, true);
    assert.ok(text.startsWith("public "));
    assert.ok(text.endsWith("..."));
    assert.ok(text.length <= 1_024);
    assert.doesNotMatch(text, /\u001B|\n|private-stack-marker/u);
  } finally {
    await harness.close();
  }
});

test("MCP server exposes a drain for accepted in-flight tool calls", async () => {
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let finishExecution: (() => void) | undefined;
  const canFinish = new Promise<void>((resolve) => {
    finishExecution = resolve;
  });
  const registry = createFakeRegistry(async () => {
    signalStarted?.();
    await canFinish;
    return { content: [{ type: "text", text: "drained" }] };
  });
  const harness = await connectHarness(registry);
  try {
    const call = harness.client.callTool({
      name: "akk_test_0",
      arguments: { turn_id: "turn-1" }
    });
    await started;
    assert.equal(getHostBridgeMcpActiveCallCount(harness.server), 1);

    let didDrain = false;
    const drain = drainHostBridgeMcpCalls(harness.server).then(() => {
      didDrain = true;
    });
    await Promise.resolve();
    assert.equal(didDrain, false);

    finishExecution?.();
    await call;
    await drain;
    assert.equal(didDrain, true);
    assert.equal(getHostBridgeMcpActiveCallCount(harness.server), 0);
  } finally {
    finishExecution?.();
    await harness.close();
  }
});

type ExecuteFakeTool = (
  name: string,
  toolCallId: string,
  args: Readonly<Record<string, unknown>>
) => Promise<HostBridgeToolResult>;

function createFakeRegistry(
  executeTool: ExecuteFakeTool = async (name) => ({
    content: [{ type: "text", text: name }]
  }),
  schema: HostBridgeToolDescriptor["inputSchema"] = inputSchema
): HostBridgeToolRegistry {
  const descriptors: HostBridgeToolDescriptor[] = Array.from(
    { length: 16 },
    (_, index) => ({
      name: `akk_test_${index}`,
      description: `Test semantic tool ${index}`,
      inputSchema: schema,
      execute(toolCallId, args) {
        return executeTool(`akk_test_${index}`, toolCallId, args);
      }
    })
  );
  const byName = new Map(descriptors.map((tool) => [tool.name, tool]));
  return {
    list: () => descriptors,
    get: (name) => byName.get(name),
    async execute(name, toolCallId, args) {
      const tool = byName.get(name);
      if (!tool) {
        throw new Error(`unknown fake tool ${name}`);
      }
      return tool.execute(toolCallId, args);
    }
  };
}

async function connectHarness(
  registry: HostBridgeToolRegistry,
  instanceId?: string
): Promise<{
  readonly client: Client;
  readonly server: ReturnType<typeof createHostBridgeMcpServer>;
  close(): Promise<void>;
}> {
  const server = createHostBridgeMcpServer({
    registry,
    version: "0.12.16-test",
    instanceId
  });
  const client = new Client(
    { name: "host-bridge-test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async () => {
      await client.close();
    }
  };
}

async function assertInvalidParams(
  promise: Promise<unknown>,
  messagePattern: RegExp
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, ErrorCode.InvalidParams);
    assert.match(error.message, messagePattern);
    return true;
  });
}

function resultText(result: unknown): string {
  assert.ok(result && typeof result === "object" && "content" in result);
  const content = (result as { readonly content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0];
  assert.ok(first && typeof first === "object" && "type" in first);
  assert.equal(first.type, "text");
  assert.ok("text" in first && typeof first.text === "string");
  return first.text;
}
