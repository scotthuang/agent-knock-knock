import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  CreateHostAdapterOptions,
  HostAdapter,
  HostAdapterControllerContext,
  HostBridgeCommandResult,
  HostBridgeToolResult,
} from "@scotthuang/agent-knock-knock/host-adapter";

import type { CallbackInbox } from "../src/callback-inbox.js";
import {
  applyWithDependencies,
  type ConnectorDependencies,
} from "../src/index.js";
import type { CallbackIpcServer } from "../src/ipc.js";
import type { ConnectorProfileResources } from "../src/profile.js";
import type {
  CallbackAcknowledgement,
  CallbackRequest,
  PiCallbackRoute,
  PiCallbackTarget,
  PiRouteTable,
} from "../src/routes.js";

const TOOL_NAMES = [
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
  "agent_knock_knock_close",
] as const;

test("Pi 0.84.4 registers /akk and all 16 tools and preserves command/tool calls", async () => {
  const fixture = nativeFixture();
  await fixture.start();

  assert.deepEqual([...fixture.pi.tools.keys()], TOOL_NAMES);
  assert.deepEqual([...fixture.pi.commands.keys()], ["akk"]);
  assert.equal(fixture.hostAdapterOptions?.lifecycleIntervalMs, 5_000);

  const commandSignal = new AbortController().signal;
  await fixture.pi.command("akk").handler(
    "list --agent codex",
    { ...fixture.context, signal: commandSignal },
  );
  const command = fixture.state.commandCalls[0];
  assert.equal(command?.args, "list --agent codex");
  assert.equal(command?.signal, commandSignal);
  assert.equal(command?.context.sessionKey, command?.context.sessionId);
  assert.deepEqual(fixture.pi.sentMessages.at(-1), {
    message: {
      customType: "agent-knock-knock-command",
      content: "command:list --agent codex",
      display: true,
      details: { isError: false },
    },
    options: { triggerTurn: false },
  });

  const respondSignal = new AbortController().signal;
  const response = await executeRegisteredTool(
    fixture.pi.tool("agent_knock_knock_respond"),
    "respond-call",
    { turn_id: "turn-one", request: "continue" },
    respondSignal,
    fixture.context,
  );
  const respond = fixture.state.toolCalls.at(-1);
  assert.equal(respond?.name, "agent_knock_knock_respond");
  assert.equal(respond?.toolCallId, "respond-call");
  assert.deepEqual(respond?.args, {
    turn_id: "turn-one",
    request: "continue",
  });
  assert.equal(respond?.signal, respondSignal);
  assert.match(textResult(response), /agent_knock_knock_respond/u);

  await fixture.shutdown();
});

test("active approve refreshes Status before Pi UI and then approves once", async () => {
  const fixture = nativeFixture({ selectChoices: ["Approve once"] });
  await fixture.start();

  await executeRegisteredTool(
    fixture.pi.tool("agent_knock_knock_approve"),
    "approve-call",
    { turn_id: "turn-approve" },
    undefined,
    fixture.context,
  );

  assert.deepEqual(fixture.state.timeline.slice(-3), [
    "tool:agent_knock_knock_status",
    "ui:select:Approve once|Reject and cancel task|Keep pending",
    "tool:agent_knock_knock_approve",
  ]);
  const [status, approve] = fixture.state.toolCalls.slice(-2);
  assert.deepEqual(status && {
    name: status.name,
    toolCallId: status.toolCallId,
    args: status.args,
  }, {
    name: "agent_knock_knock_status",
    toolCallId: "approve-call:approval-status",
    args: { turn_id: "turn-approve" },
  });
  assert.deepEqual(approve && {
    name: approve.name,
    toolCallId: approve.toolCallId,
    args: approve.args,
  }, {
    name: "agent_knock_knock_approve",
    toolCallId: "approve-call",
    args: { turn_id: "turn-approve" },
  });
  assert.equal(status?.context.authority, approve?.context.authority);

  await fixture.shutdown();
});

test("managed approval may be explicitly rejected by cancelling the exact turn", async () => {
  const fixture = nativeFixture({
    selectChoices: ["Reject and cancel task"],
    confirmChoices: [true],
  });
  await fixture.start();

  await executeRegisteredTool(
    fixture.pi.tool("agent_knock_knock_approve"),
    "reject-call",
    { turn_id: "turn-reject" },
    undefined,
    fixture.context,
  );

  assert.deepEqual(fixture.state.toolCalls.slice(-2).map((call) => ({
    name: call.name,
    toolCallId: call.toolCallId,
    args: call.args,
  })), [
    {
      name: "agent_knock_knock_status",
      toolCallId: "reject-call:approval-status",
      args: { turn_id: "turn-reject" },
    },
    {
      name: "agent_knock_knock_cancel",
      toolCallId: "reject-call:cancel",
      args: { turn_id: "turn-reject" },
    },
  ]);
  assert.match(fixture.state.timeline.join("\n"), /ui:confirm:true/u);

  await fixture.shutdown();
});

test("terminal-scoped approval never advertises an inferred cancel action", async () => {
  const fixture = nativeFixture({ selectChoices: ["Keep pending"] });
  await fixture.start();

  const result = await executeRegisteredTool(
    fixture.pi.tool("agent_knock_knock_approve"),
    "terminal-approval",
    { terminal_id: "terminal:v1:codex:%1" },
    undefined,
    fixture.context,
  );

  assert.deepEqual(fixture.pi.selectOptions.at(-1), [
    "Approve once",
    "Keep pending",
  ]);
  assert.deepEqual(fixture.state.toolCalls.slice(-1).map((call) => ({
    name: call.name,
    args: call.args,
  })), [{
    name: "agent_knock_knock_status",
    args: { conversation_id: "terminal:v1:codex:%1" },
  }]);
  assert.match(textResult(result), /remains pending/u);

  await fixture.shutdown();
});

test("approve and cancel fail closed when Pi has no interactive UI", async () => {
  const fixture = nativeFixture({ hasUI: false });
  await fixture.start();

  await assert.rejects(
    executeRegisteredTool(
      fixture.pi.tool("agent_knock_knock_approve"),
      "headless-approve",
      { turn_id: "turn-headless" },
      undefined,
      fixture.context,
    ),
    /requires an interactive Pi confirmation/u,
  );
  await assert.rejects(
    executeRegisteredTool(
      fixture.pi.tool("agent_knock_knock_cancel"),
      "headless-cancel",
      { turn_id: "turn-headless" },
      undefined,
      fixture.context,
    ),
    /cancellation requires an interactive Pi confirmation/u,
  );
  assert.equal(fixture.state.toolCalls.length, 0);
  assert.equal(fixture.pi.selectOptions.length, 0);
  assert.equal(fixture.pi.confirmMessages.length, 0);

  await fixture.shutdown();
});

test("callback delivery wakes idle Pi and queues a follow-up while Pi is busy", async () => {
  const fixture = nativeFixture();
  await fixture.start();
  await fixture.pi.command("akk").handler("list", fixture.context);
  fixture.pi.sentMessages.length = 0;

  const route = fixture.routes.latestRoute();
  const idleAck = await fixture.routes.deliver(callbackRequest(
    route.controllerId,
    "idle",
  ));
  assert.equal(idleAck.result.status, "accepted");
  assert.deepEqual(fixture.pi.sentMessages.at(-1)?.options, {
    triggerTurn: true,
  });

  fixture.contextState.idle = false;
  const busyAck = await fixture.routes.deliver(callbackRequest(
    route.controllerId,
    "busy",
  ));
  assert.equal(busyAck.result.status, "accepted");
  assert.deepEqual(fixture.pi.sentMessages.at(-1)?.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  assert.equal(
    fixture.pi.sentMessages.at(-1)?.message.customType,
    "agent-knock-knock-callback",
  );

  await fixture.shutdown();
});

test("session_tree disposes the old callback authority and binds a new route", async () => {
  const fixture = nativeFixture();
  await fixture.start();
  await fixture.pi.command("akk").handler("list", fixture.context);
  const oldRoute = fixture.routes.latestRoute();
  const oldAuthority = oldRoute.target.authority;

  fixture.contextState.leafId = "leaf-after-navigation";
  await fixture.emit("session_tree", {
    type: "session_tree",
    newLeafId: fixture.contextState.leafId,
    oldLeafId: "leaf-start",
  });
  const oldAck = await fixture.routes.deliver(callbackRequest(
    oldRoute.controllerId,
    "old-route",
  ));
  assert.deepEqual(oldAck.result, {
    status: "rejected",
    error_code: "pi_route_not_live",
  });
  assert.ok(fixture.state.disposedAuthorities.includes(oldAuthority));

  await fixture.pi.command("akk").handler("list", fixture.context);
  const newRoute = fixture.routes.latestRoute();
  assert.notEqual(newRoute.controllerId, oldRoute.controllerId);
  assert.notEqual(newRoute.target.authority, oldAuthority);
  const newAck = await fixture.routes.deliver(callbackRequest(
    newRoute.controllerId,
    "new-route",
  ));
  assert.equal(newAck.result.status, "accepted");

  await fixture.shutdown();
});

test("shutdown drains a callback while live and completes cleanup after one failure", async () => {
  let drained: CallbackAcknowledgement | undefined;
  const fixture = nativeFixture({
    async lifecycleStop(state) {
      const route = state.routes?.latestRoute();
      assert.ok(route);
      drained = await state.routes?.deliver(callbackRequest(
        route.controllerId,
        "during-shutdown",
      ));
      throw new Error("expected lifecycle stop failure");
    },
  });
  await fixture.start();
  await fixture.pi.command("akk").handler("list", fixture.context);
  fixture.pi.sentMessages.length = 0;

  await assert.rejects(
    fixture.shutdown(),
    (error: unknown) =>
      error instanceof AggregateError &&
      /connector cleanup failed/u.test(error.message),
  );

  assert.equal(drained?.result.status, "accepted");
  assert.equal(
    fixture.pi.sentMessages.at(-1)?.message.customType,
    "agent-knock-knock-callback",
  );
  assert.equal(fixture.state.serverStops, 1);
  assert.equal(fixture.state.routeCloses, 1);
  assert.equal(fixture.state.inboxCloses, 1);
  assert.equal(fixture.state.resourceRemoves, 1);
  assert.deepEqual(fixture.state.cleanupTimeline, [
    "lifecycle:stop",
    "server:stop",
    "route:dispose",
    "route:close",
    "inbox:close",
    "resources:remove",
  ]);
});

test("registration failure after startup stops every resource and removes the Profile", async () => {
  const fixture = nativeFixture({ failToolRegistrationAt: 1 });

  await assert.rejects(
    fixture.start(),
    /synthetic tool registration failure/u,
  );
  assert.equal(fixture.state.lifecycleStarts, 1);
  assert.equal(fixture.state.lifecycleStops, 1);
  assert.equal(fixture.state.serverStops, 1);
  assert.equal(fixture.state.routeCloses, 1);
  assert.equal(fixture.state.inboxCloses, 1);
  assert.equal(fixture.state.resourceRemoves, 1);
});

test("unsupported Pi fails before allocating connector resources", async () => {
  const fixture = nativeFixture({ piVersion: "0.84.5" });

  await assert.rejects(
    fixture.start(),
    /requires Pi 0\.84\.4; received 0\.84\.5/u,
  );
  assert.equal(fixture.state.profileCreates, 0);
  assert.equal(fixture.state.serverStarts, 0);
  assert.equal(fixture.pi.tools.size, 0);
  assert.equal(fixture.pi.commands.size, 0);
});

interface NativeFixtureOptions {
  readonly piVersion?: string;
  readonly hasUI?: boolean;
  readonly selectChoices?: readonly string[];
  readonly confirmChoices?: readonly boolean[];
  readonly failToolRegistrationAt?: number;
  readonly lifecycleStop?: (
    state: NativeFixtureState,
  ) => Promise<void>;
}

interface AdapterCall {
  readonly context: HostAdapterControllerContext;
  readonly name: string;
  readonly toolCallId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal | undefined;
}

interface NativeFixtureState {
  readonly timeline: string[];
  readonly cleanupTimeline: string[];
  readonly toolCalls: AdapterCall[];
  readonly commandCalls: Array<{
    readonly context: HostAdapterControllerContext;
    readonly args: string;
    readonly signal: AbortSignal | undefined;
  }>;
  readonly disposedAuthorities: object[];
  profileCreates: number;
  resourceRemoves: number;
  serverStarts: number;
  serverStops: number;
  lifecycleStarts: number;
  lifecycleStops: number;
  routeCloses: number;
  inboxCloses: number;
  routes?: FakeRouteTable;
}

function nativeFixture(options: NativeFixtureOptions = {}) {
  const state: NativeFixtureState = {
    timeline: [],
    cleanupTimeline: [],
    toolCalls: [],
    commandCalls: [],
    disposedAuthorities: [],
    profileCreates: 0,
    resourceRemoves: 0,
    serverStarts: 0,
    serverStops: 0,
    lifecycleStarts: 0,
    lifecycleStops: 0,
    routeCloses: 0,
    inboxCloses: 0,
  };
  const contextState = {
    idle: true,
    sessionId: "pi-session-one",
    leafId: "leaf-start" as string | null,
  };
  const pi = new FakePi(state, {
    hasUI: options.hasUI ?? true,
    selectChoices: [...(options.selectChoices ?? [])],
    confirmChoices: [...(options.confirmChoices ?? [])],
    failToolRegistrationAt: options.failToolRegistrationAt,
  });
  const context = pi.context(contextState);
  let hostAdapterOptions: CreateHostAdapterOptions | undefined;

  const resources: ConnectorProfileResources = {
    instanceNonce: "native-wiring-instance",
    directory: "/tmp/akk-pi-native-wiring",
    socketPath: "/tmp/akk-pi-native-wiring/callback.sock",
    stateDirectory: "/tmp/akk-pi-native-wiring/state",
    token: "private-test-token",
    profilePath: "/tmp/akk-pi-native-wiring/host-profile.json",
    profile: {},
    fingerprint: "f".repeat(64),
    environment(controllerId: string) {
      return { AKK_PI_TEST_CONTROLLER: controllerId };
    },
    remove() {
      state.resourceRemoves += 1;
      state.cleanupTimeline.push("resources:remove");
    },
  };
  const inbox = {
    async close() {
      state.inboxCloses += 1;
      state.cleanupTimeline.push("inbox:close");
    },
  } as unknown as CallbackInbox;
  const server: CallbackIpcServer = {
    async start() {
      state.serverStarts += 1;
    },
    async stop() {
      state.serverStops += 1;
      state.cleanupTimeline.push("server:stop");
    },
  };
  const adapter = fakeHostAdapter(state, options);

  const dependencies: Partial<ConnectorDependencies> = {
    piVersion: options.piVersion ?? "0.84.4",
    createConnectorProfileResources() {
      state.profileCreates += 1;
      return resources;
    },
    createCallbackInbox() {
      return inbox;
    },
    createRouteTable() {
      const routes = new FakeRouteTable(state);
      state.routes = routes;
      return routes as unknown as PiRouteTable;
    },
    createCallbackIpcServer() {
      return server;
    },
    createHostAdapter(received) {
      hostAdapterOptions = received;
      return adapter;
    },
  };
  applyWithDependencies(pi.api, dependencies);

  return {
    state,
    pi,
    context,
    contextState,
    get routes(): FakeRouteTable {
      assert.ok(state.routes);
      return state.routes;
    },
    get hostAdapterOptions(): CreateHostAdapterOptions | undefined {
      return hostAdapterOptions;
    },
    start: () => pi.emit("session_start", {
      type: "session_start",
      reason: "startup",
    }, context),
    emit: (name: string, event: unknown) => pi.emit(name, event, context),
    shutdown: () => pi.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    }, context),
  };
}

function fakeHostAdapter(
  state: NativeFixtureState,
  options: NativeFixtureOptions,
): HostAdapter {
  return {
    command: {
      name: "akk",
      description: "Control coding-agent terminals with AKK",
      acceptsArgs: true,
    },
    tools: TOOL_NAMES.map((name) => ({
      name,
      description: `Description for ${name}`,
      inputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {},
      },
    })),
    lifecycle: {
      id: "fake-lifecycle",
      start() {
        state.lifecycleStarts += 1;
      },
      async stop() {
        state.lifecycleStops += 1;
        state.cleanupTimeline.push("lifecycle:stop");
        await options.lifecycleStop?.(state);
      },
    },
    async executeCommand(context, args, signal): Promise<HostBridgeCommandResult> {
      state.commandCalls.push({ context, args, signal });
      return { text: `command:${args}` };
    },
    async executeTool(
      context,
      name,
      toolCallId,
      args,
      signal,
    ): Promise<HostBridgeToolResult> {
      state.timeline.push(`tool:${name}`);
      state.toolCalls.push({ context, name, toolCallId, args, signal });
      if (name === "agent_knock_knock_status") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              approval_state: {
                approvable: true,
                request_detail: "Run the exact reviewed command",
              },
            }),
          }],
          details: { approval_state: { approvable: true } },
        };
      }
      return {
        content: [{ type: "text", text: `result:${name}` }],
        details: { name, args },
      };
    },
    disposeContext(authority) {
      state.disposedAuthorities.push(authority);
    },
  };
}

class FakeRouteTable {
  private readonly routeByAuthority = new WeakMap<object, PiCallbackRoute>();
  private readonly routeByController = new Map<string, PiCallbackRoute>();
  private nextRoute = 0;

  constructor(private readonly state: NativeFixtureState) {}

  bind(target: PiCallbackTarget): PiCallbackRoute {
    const previous = this.routeByAuthority.get(target.authority);
    if (previous) return previous;
    this.nextRoute += 1;
    const route: PiCallbackRoute = {
      controllerId: `controller-${this.nextRoute}`,
      target,
      sessionId: target.sessionId,
      runtimeGeneration: target.runtimeGeneration,
      anchorLeafId: target.anchorLeafId,
    };
    this.routeByAuthority.set(target.authority, route);
    this.routeByController.set(route.controllerId, route);
    return route;
  }

  dispose(target: PiCallbackTarget): void {
    this.state.cleanupTimeline.push("route:dispose");
    const route = this.routeByAuthority.get(target.authority);
    if (route) this.routeByController.delete(route.controllerId);
  }

  async deliver(request: CallbackRequest): Promise<CallbackAcknowledgement> {
    const route = this.routeByController.get(request.controllerId);
    if (!route || !route.target.isLive()) {
      return acknowledgement(request, "rejected", "pi_route_not_live");
    }
    await route.target.deliver(request.body, request);
    return acknowledgement(request, "accepted");
  }

  async close(): Promise<void> {
    this.state.routeCloses += 1;
    this.state.cleanupTimeline.push("route:close");
  }

  latestRoute(): PiCallbackRoute {
    const route = [...this.routeByController.values()].at(-1);
    assert.ok(route);
    return route;
  }
}

class FakePi {
  readonly handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  readonly tools = new Map<string, ToolDefinition>();
  readonly commands = new Map<string, {
    readonly description?: string;
    readonly handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  }>();
  readonly sentMessages: Array<{
    readonly message: {
      readonly customType: string;
      readonly content: unknown;
      readonly display: boolean;
      readonly details?: unknown;
    };
    readonly options: unknown;
  }> = [];
  readonly selectOptions: string[][] = [];
  readonly confirmMessages: string[] = [];
  readonly api: ExtensionAPI;

  private toolRegistrationCount = 0;

  constructor(
    private readonly state: NativeFixtureState,
    private readonly options: {
      readonly hasUI: boolean;
      readonly selectChoices: string[];
      readonly confirmChoices: boolean[];
      readonly failToolRegistrationAt?: number;
    },
  ) {
    this.api = {
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        const handlers = this.handlers.get(name) ?? [];
        handlers.push(handler);
        this.handlers.set(name, handlers);
      },
      registerTool: (tool: ToolDefinition) => {
        this.toolRegistrationCount += 1;
        if (this.toolRegistrationCount === this.options.failToolRegistrationAt) {
          throw new Error("synthetic tool registration failure");
        }
        this.tools.set(tool.name, tool);
      },
      registerCommand: (name: string, command: {
        readonly description?: string;
        readonly handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      }) => {
        this.commands.set(name, command);
      },
      sendMessage: (message: {
        readonly customType: string;
        readonly content: unknown;
        readonly display: boolean;
        readonly details?: unknown;
      }, sendOptions?: unknown) => {
        this.sentMessages.push({ message, options: sendOptions });
      },
    } as unknown as ExtensionAPI;
  }

  context(contextState: {
    idle: boolean;
    sessionId: string;
    leafId: string | null;
  }): ExtensionContext {
    return {
      hasUI: this.options.hasUI,
      mode: this.options.hasUI ? "tui" : "print",
      cwd: "/tmp/pi-native-wiring",
      signal: undefined,
      isIdle: () => contextState.idle,
      sessionManager: {
        getSessionId: () => contextState.sessionId,
        getSessionFile: () => "/tmp/pi-native-wiring/session.jsonl",
        getLeafId: () => contextState.leafId,
      },
      ui: {
        setStatus: () => undefined,
        notify: () => undefined,
        select: async (_title: string, choices: string[]) => {
          this.selectOptions.push([...choices]);
          const selected = this.options.selectChoices.shift();
          this.state.timeline.push(`ui:select:${choices.join("|")}`);
          if (selected !== undefined) {
            assert.ok(choices.includes(selected), `invalid synthetic choice ${selected}`);
          }
          return selected;
        },
        confirm: async (_title: string, message: string) => {
          this.confirmMessages.push(message);
          const confirmed = this.options.confirmChoices.shift() ?? false;
          this.state.timeline.push(`ui:confirm:${confirmed}`);
          return confirmed;
        },
      },
    } as unknown as ExtensionContext;
  }

  async emit(
    name: string,
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) {
      await handler(event, ctx);
    }
  }

  tool(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    assert.ok(tool, `missing tool ${name}`);
    return tool;
  }

  command(name: string): {
    readonly handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  } {
    const command = this.commands.get(name);
    assert.ok(command, `missing command ${name}`);
    return command;
  }
}

function executeRegisteredTool(
  tool: ToolDefinition,
  toolCallId: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  return tool.execute(toolCallId, args, signal, undefined, ctx);
}

function callbackRequest(controllerId: string, suffix: string): CallbackRequest {
  return {
    controllerId,
    deliveryId: `delivery-${suffix}`,
    messageId: `message-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    body: `callback-${suffix}`,
  };
}

function acknowledgement(
  request: CallbackRequest,
  status: "accepted" | "rejected",
  errorCode?: string,
): CallbackAcknowledgement {
  return {
    request: {
      delivery_id: request.deliveryId,
      message_id: request.messageId,
    },
    result: {
      status,
      ...(status === "accepted"
        ? { acceptance_id: `acceptance-${request.idempotencyKey}` }
        : {}),
      ...(errorCode ? { error_code: errorCode } : {}),
    },
  };
}

function textResult(result: { readonly content: readonly unknown[] }): string {
  return result.content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String(block.text)
        : "")
    .join("\n");
}
