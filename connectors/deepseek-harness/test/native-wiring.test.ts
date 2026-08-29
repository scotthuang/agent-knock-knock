import assert from "node:assert/strict";
import test from "node:test";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  assertSupportedJsonSchema,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type {
  CreateHostAdapterOptions,
  HostAdapter,
  HostAdapterControllerContext,
} from "@scotthuang/agent-knock-knock/host-adapter";

import { applyWithDependencies } from "../src/index.js";
import type { AgentRouteTable } from "../src/routes.js";

test("mounts native command/tools and routes every call through the exact Agent", async () => {
  const live = new Map<Agent["id"], Agent>();
  const commands: CommandDefinition[] = [];
  const tools: ToolDefinition[] = [];
  const disposeEvents: Array<(payload: { agent: Agent }) => void> = [];
  const contexts: HostAdapterControllerContext[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const disposedAuthorities: object[] = [];
  let capturedRoutes: AgentRouteTable | undefined;
  let lifecycleStarts = 0;
  let lifecycleStops = 0;
  let serverStarts = 0;
  let serverStops = 0;
  let profileRemovals = 0;
  let registrationDisposals = 0;
  let drainControllerId: string | undefined;
  let drainStatus: string | undefined;
  let profileHarnessVersion: string | undefined;

  const fakeContext = {
    agents: { get: (id: Agent["id"]) => live.get(id) },
    commands: {
      register(definition: CommandDefinition) {
        commands.push(definition);
        return () => { registrationDisposals += 1; };
      },
    },
    tools: {
      register(definition: ToolDefinition) {
        tools.push(definition);
        return () => { registrationDisposals += 1; };
      },
    },
    on(event: string, listener: (payload: { agent: Agent }) => void) {
      assert.equal(event, "agent/disposed");
      disposeEvents.push(listener);
      return () => { registrationDisposals += 1; };
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  } as unknown as Context;

  const cleanup = await applyWithDependencies(fakeContext, {}, {
    async loadSupportedDeepSeekHarnessRuntime() {
      return {
        version: "0.1.2-alpha.1",
        createUserMessage,
        assertSupportedJsonSchema,
      };
    },
    createConnectorProfileResources(harnessVersion) {
      profileHarnessVersion = harnessVersion;
      return {
        instanceNonce: "host-instance",
        directory: "/private/test",
        socketPath: "/private/test/callback.sock",
        token: "token",
        profilePath: "/private/test/profile.json",
        profile: {},
        fingerprint: "sha256:test",
        environment(controllerId: string) {
          return { AKK_DSH_CONTROLLER_ID: controllerId };
        },
        remove() { profileRemovals += 1; },
      };
    },
    createCallbackIpcServer(options) {
      capturedRoutes = options.routes;
      return {
        async start() { serverStarts += 1; },
        async stop() { serverStops += 1; },
      };
    },
    createHostAdapter(options) {
      return fakeAdapter(options, {
        contexts,
        environments,
        disposedAuthorities,
        lifecycle: {
          start: () => { lifecycleStarts += 1; },
          stop: async () => {
            lifecycleStops += 1;
            if (drainControllerId && capturedRoutes) {
              drainStatus = capturedRoutes.deliver({
                controllerId: drainControllerId,
                deliveryId: "delivery-during-drain",
                messageId: "message-during-drain",
                idempotencyKey: "key-during-drain",
                body: "lifecycle drain",
              }).result.status;
            }
          },
        },
      });
    },
  });

  assert.equal(serverStarts, 1);
  assert.equal(profileHarnessVersion, "0.1.2-alpha.1");
  assert.equal(lifecycleStarts, 1);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, "akk");
  assert.equal(tools.length, 16);

  const active = fakeAgent("active-session", "idle");
  live.set(active.agent.id, active.agent);
  const commandResult = await commands[0]!.handler({
    agent: active.agent,
    rawInput: " list",
    signal: new AbortController().signal,
  } as Parameters<CommandDefinition["handler"]>[0]);
  assert.deepEqual(commandResult, { kind: "success", text: "command: list" });
  assert.equal(contexts[0]?.authority, active.agent);
  assert.match(contexts[0]!.sessionKey, /^akk-dsh:host-instance:/u);
  assert.equal(contexts[0]?.sessionKey, contexts[0]?.sessionId);
  assert.equal(environments[0]?.AKK_DSH_CONTROLLER_ID, contexts[0]?.sessionKey);

  const toolValue = await tools[0]!.execute(
    { sample: true },
    {
      agent: active.agent,
      callId: "call-one",
      signal: new AbortController().signal,
    } as unknown as ToolRunContext,
  );
  assert.deepEqual(toolValue, {
    content: [{ type: "text", text: "tool:agent_knock_knock_tool_1" }],
    details: { exact: true },
  });
  assert.equal(contexts[1]?.authority, active.agent);
  assert.equal(contexts[1]?.sessionKey, contexts[0]?.sessionKey);

  await assert.rejects(
    tools[0]!.execute({}, {
      callId: "missing-agent",
      signal: new AbortController().signal,
    } as unknown as ToolRunContext),
    /requires an exact DeepSeek Harness Agent/u,
  );

  const stale = fakeAgent("replaceable", "idle");
  live.set(stale.agent.id, stale.agent);
  const replacement = fakeAgent("replaceable", "idle");
  live.set(replacement.agent.id, replacement.agent);
  await assert.rejects(
    async () => commands[0]!.handler({
        agent: stale.agent,
        rawInput: " list",
        signal: new AbortController().signal,
      } as Parameters<CommandDefinition["handler"]>[0]),
    /exact live DeepSeek Harness Agent/u,
  );

  const controllerId = contexts[0]!.sessionKey;
  disposeEvents[0]!({ agent: active.agent });
  assert.equal(disposedAuthorities[0], active.agent);
  const afterDispose = capturedRoutes!.deliver({
    controllerId,
    deliveryId: "delivery-after-dispose",
    messageId: "message-after-dispose",
    idempotencyKey: "key-after-dispose",
    body: "should not route",
  });
  assert.equal(afterDispose.result.status, "rejected");
  assert.equal(afterDispose.result.error_code, "agent_route_not_live");

  const draining = fakeAgent("draining-session", "idle");
  live.set(draining.agent.id, draining.agent);
  await commands[0]!.handler({
    agent: draining.agent,
    rawInput: " status",
    signal: new AbortController().signal,
  } as Parameters<CommandDefinition["handler"]>[0]);
  drainControllerId = contexts.at(-1)!.sessionKey;

  await cleanup();
  await cleanup();
  assert.equal(lifecycleStops, 1);
  assert.equal(serverStops, 1);
  assert.equal(profileRemovals, 1);
  assert.equal(registrationDisposals, 18);
  assert.equal(drainStatus, "accepted");
  assert.equal(draining.followed.length, 1);
});

test("removes private resources when Host Adapter construction fails", async () => {
  let serverStarts = 0;
  let serverStops = 0;
  let profileRemovals = 0;
  const fakeContext = {
    agents: { get: () => undefined },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  } as unknown as Context;

  await assert.rejects(
    applyWithDependencies(fakeContext, {}, {
      async loadSupportedDeepSeekHarnessRuntime() {
        return {
          version: "0.1.2-alpha.1",
          createUserMessage,
          assertSupportedJsonSchema,
        };
      },
      createConnectorProfileResources() {
        return {
          instanceNonce: "failing-host",
          directory: "/private/failing",
          socketPath: "/private/failing/callback.sock",
          token: "token",
          profilePath: "/private/failing/profile.json",
          profile: {},
          fingerprint: "sha256:test",
          environment(controllerId: string) {
            return { AKK_DSH_CONTROLLER_ID: controllerId };
          },
          remove() { profileRemovals += 1; },
        };
      },
      createCallbackIpcServer() {
        return {
          async start() { serverStarts += 1; },
          async stop() { serverStops += 1; },
        };
      },
      createHostAdapter() {
        throw new Error("adapter construction failed");
      },
    }),
    /adapter construction failed/u,
  );

  assert.equal(serverStarts, 0);
  assert.equal(serverStops, 1);
  assert.equal(profileRemovals, 1);
});

function fakeAdapter(
  options: CreateHostAdapterOptions,
  state: {
    contexts: HostAdapterControllerContext[];
    environments: NodeJS.ProcessEnv[];
    disposedAuthorities: object[];
    lifecycle: { start(): void; stop(): Promise<void> };
  },
): HostAdapter {
  const metadata = Array.from({ length: 16 }, (_, index) => ({
    name: `agent_knock_knock_tool_${index + 1}`,
    description: `tool ${index + 1}`,
    inputSchema: { type: "object", additionalProperties: true },
  }));
  return {
    command: { name: "akk", description: "AKK", acceptsArgs: true },
    tools: metadata,
    lifecycle: { id: "fake", ...state.lifecycle },
    async executeCommand(context, args) {
      state.contexts.push(context);
      state.environments.push(options.environmentForContext(context));
      return { text: `command:${args}`, isError: false };
    },
    async executeTool(context, name) {
      state.contexts.push(context);
      state.environments.push(options.environmentForContext(context));
      return {
        content: [{ type: "text", text: `tool:${name}` }],
        details: { exact: true },
      };
    },
    disposeContext(authority) {
      state.disposedAuthorities.push(authority);
    },
  };
}

function fakeAgent(id: string, status: "idle" | "running") {
  const followed: unknown[] = [];
  const injected: unknown[] = [];
  const agent = {
    id,
    status,
    followup: (message: unknown) => followed.push(message),
    inject: (message: unknown) => injected.push(message),
  } as unknown as Agent;
  return { agent, followed, injected };
}
