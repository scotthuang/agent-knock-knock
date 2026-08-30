/** Pi-as-orchestrator POC: Pi controls Codex and Claude Code through AKK. */

import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { VERSION as PI_RUNTIME_VERSION } from "@earendil-works/pi-coding-agent";
import {
  createHostAdapter,
  type CreateHostAdapterOptions,
  type HostAdapter,
  type HostAdapterControllerContext,
  type HostAdapterToolMetadata,
  type HostBridgeToolResult,
} from "@scotthuang/agent-knock-knock/host-adapter";

import {
  CONNECTOR_STORE_DIR_ENV,
  CONNECTOR_NAME,
  LIFECYCLE_INTERVAL_MS,
  SUPPORTED_PI_VERSION,
} from "./constants.js";
import { CallbackInbox } from "./callback-inbox.js";
import { createCallbackIpcServer, type CallbackIpcServer } from "./ipc.js";
import {
  createConnectorProfileResources,
  type ConnectorProfileResources,
} from "./profile.js";
import {
  PiRouteTable,
  type CallbackRequest,
  type PiCallbackTarget,
} from "./routes.js";
import {
  adaptHostToolInputSchema,
  compileAuthoritativeInputValidator,
} from "./schema-adapter.js";

const CALLBACK_CUSTOM_TYPE = "agent-knock-knock-callback";
const COMMAND_CUSTOM_TYPE = "agent-knock-knock-command";
const APPROVE_TOOL = "agent_knock_knock_approve";
const CANCEL_TOOL = "agent_knock_knock_cancel";
const STATUS_TOOL = "agent_knock_knock_status";
const EXPECTED_TOOL_COUNT = 16;
const MAX_APPROVAL_DISPLAY_CHARS = 8_000;

interface LiveConnector {
  readonly resources: ConnectorProfileResources;
  readonly inbox: CallbackInbox;
  readonly routes: PiRouteTable;
  readonly server: CallbackIpcServer;
  readonly adapter: HostAdapter;
  target: PiCallbackTarget;
  branchEpoch: number;
  running: boolean;
  stopPromise?: Promise<void>;
}

/** @internal Replaceable seams for native wiring and lifecycle tests. */
export interface ConnectorDependencies {
  readonly piVersion: string;
  readonly createConnectorProfileResources: typeof createConnectorProfileResources;
  readonly createCallbackInbox: (
    options: ConstructorParameters<typeof CallbackInbox>[0],
  ) => CallbackInbox;
  readonly createRouteTable: (
    inbox: CallbackInbox,
    instanceNonce: string,
  ) => PiRouteTable;
  readonly createCallbackIpcServer: typeof createCallbackIpcServer;
  readonly createHostAdapter: (options: CreateHostAdapterOptions) => HostAdapter;
}

const DEFAULT_DEPENDENCIES: ConnectorDependencies = Object.freeze({
  piVersion: PI_RUNTIME_VERSION,
  createConnectorProfileResources,
  createCallbackInbox: (
    options: ConstructorParameters<typeof CallbackInbox>[0],
  ) => new CallbackInbox(options),
  createRouteTable: (inbox: CallbackInbox, instanceNonce: string) =>
    new PiRouteTable(inbox, instanceNonce),
  createCallbackIpcServer,
  createHostAdapter,
});

/** Mount one Host-owned AKK runtime for the current Pi session incarnation. */
export default function agentKnockKnockPi(pi: ExtensionAPI): void {
  applyWithDependencies(pi);
}

/** @internal Mount with deterministic process, IPC, and HostAdapter seams. */
export function applyWithDependencies(
  pi: ExtensionAPI,
  dependencies: Partial<ConnectorDependencies> = {},
): void {
  const resolved = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let live: LiveConnector | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (live?.running) {
      throw new Error("Pi AKK connector started more than once");
    }
    assertSupportedPiVersion(resolved.piVersion);
    const connector = await startConnector(pi, ctx, resolved);
    live = connector;
    try {
      registerPiSurface(pi, connector, () => requiredLive(live));
      ctx.ui.setStatus(CONNECTOR_NAME, "AKK ready");
    } catch (error) {
      live = undefined;
      await stopConnector(connector);
      throw error;
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    const current = requiredLive(live);
    rotateControllerTarget(pi, current, ctx, () => live);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const current = live;
    ctx.ui.setStatus(CONNECTOR_NAME, undefined);
    try {
      if (current) await stopConnector(current);
    } finally {
      if (live === current) live = undefined;
    }
  });
}

async function startConnector(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  dependencies: ConnectorDependencies,
): Promise<LiveConnector> {
  const resources = dependencies.createConnectorProfileResources(
    relayEnvironment(process.env),
  );
  let inbox: CallbackInbox | undefined;
  let routes: PiRouteTable | undefined;
  let server: CallbackIpcServer | undefined;
  let adapter: HostAdapter | undefined;
  let connector: LiveConnector | undefined;
  let lifecycleStarted = false;

  try {
    inbox = dependencies.createCallbackInbox({
      filePath: path.join(resources.stateDirectory, "callback-inbox.json"),
    });
    routes = dependencies.createRouteTable(inbox, resources.instanceNonce);
    server = dependencies.createCallbackIpcServer({
      socketPath: resources.socketPath,
      token: resources.token,
      routes,
    });
    const lifecycleControllerId = `akk-pi:${resources.instanceNonce}:lifecycle`;
    const pluginConfig = connectorPluginConfig(process.env);
    adapter = dependencies.createHostAdapter({
      environmentForContext(context) {
        if (context.sessionKey !== context.sessionId) {
          throw new Error("Pi AKK controller identities diverged");
        }
        return resources.environment(context.sessionKey);
      },
      lifecycleEnvironment: resources.environment(lifecycleControllerId),
      lifecycleIntervalMs: LIFECYCLE_INTERVAL_MS,
      pluginConfig,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    let current = {} as LiveConnector;
    const target = createTarget(pi, ctx, resources, 0, () => current);
    connector = {
      resources,
      inbox,
      routes,
      server,
      adapter,
      target,
      branchEpoch: 0,
      running: true,
    };
    current = connector;
    await server.start();
    adapter.lifecycle.start();
    lifecycleStarted = true;
    return connector;
  } catch (error) {
    if (connector) connector.running = false;
    if (lifecycleStarted) await adapter?.lifecycle.stop().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await routes?.close().catch(() => undefined);
    await inbox?.close().catch(() => undefined);
    resources.remove();
    throw error;
  }
}

function registerPiSurface(
  pi: ExtensionAPI,
  initial: LiveConnector,
  current: () => LiveConnector,
): void {
  pi.registerCommand(initial.adapter.command.name, {
    description: initial.adapter.command.description,
    handler: async (args, ctx) => {
      const connector = current();
      const result = await connector.adapter.executeCommand(
        controllerContext(connector),
        args,
        ctx.signal,
      );
      pi.sendMessage({
        customType: COMMAND_CUSTOM_TYPE,
        content: result.text,
        display: true,
        details: { isError: result.isError === true },
      }, { triggerTurn: false });
      if (result.isError) ctx.ui.notify("AKK command failed", "error");
    },
  });

  if (initial.adapter.tools.length !== EXPECTED_TOOL_COUNT) {
    throw new Error(
      `agent-knock-knock-pi expected ${EXPECTED_TOOL_COUNT} AKK tools, ` +
      `received ${initial.adapter.tools.length}`,
    );
  }
  for (const metadata of initial.adapter.tools) {
    pi.registerTool(toolDefinition(metadata, current));
  }
}

function toolDefinition(
  metadata: HostAdapterToolMetadata,
  current: () => LiveConnector,
): ToolDefinition {
  const parameters = adaptHostToolInputSchema(metadata.inputSchema);
  const validate = compileAuthoritativeInputValidator(metadata.inputSchema);
  return {
    name: metadata.name,
    label: toolLabel(metadata.name),
    description: metadata.description,
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, rawParameters, signal, _onUpdate, ctx) {
      validate(rawParameters);
      const args = requiredRecord(rawParameters, metadata.name);
      const connector = current();
      const result = metadata.name === APPROVE_TOOL
        ? await executeApproval(connector, toolCallId, args, signal, ctx)
        : metadata.name === CANCEL_TOOL
          ? await executeConfirmedCancel(
              connector,
              toolCallId,
              args,
              signal,
              ctx,
            )
          : await connector.adapter.executeTool(
              controllerContext(connector),
              metadata.name,
              toolCallId,
              args,
              signal,
            );
      if (result.isError) throw new Error(hostToolResultText(result));
      return {
        content: [{ type: "text", text: hostToolResultText(result) }],
        details: losslessDetails(result),
      };
    },
  };
}

async function executeApproval(
  connector: LiveConnector,
  toolCallId: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<HostBridgeToolResult> {
  if (!ctx.hasUI) {
    throw new Error("AKK approval requires an interactive Pi confirmation");
  }
  const statusArgs = approvalStatusArguments(args);
  const controller = controllerContext(connector);
  const status = await connector.adapter.executeTool(
    controller,
    STATUS_TOOL,
    `${toolCallId}:approval-status`,
    statusArgs,
    signal,
  );
  if (status.isError) throw new Error(hostToolResultText(status));

  const statusText = truncateForDialog(hostToolResultText(status));
  const turnId = nonBlankString(args.turn_id);
  const choices = turnId
    ? ["Approve once", "Reject and cancel task", "Keep pending"]
    : ["Approve once", "Keep pending"];
  const choice = await ctx.ui.select(
    `AKK approval request\n\n${statusText}`,
    choices,
    signal ? { signal } : undefined,
  );
  if (choice === "Approve once") {
    return connector.adapter.executeTool(
      controller,
      APPROVE_TOOL,
      toolCallId,
      args,
      signal,
    );
  }
  if (choice === "Reject and cancel task") {
    const confirmed = await ctx.ui.confirm(
      "Reject approval and cancel AKK task?",
      "This interrupts the current managed task; it is not a native deny-and-continue action.",
      signal ? { signal } : undefined,
    );
    if (confirmed) {
      return connector.adapter.executeTool(
        controller,
        CANCEL_TOOL,
        `${toolCallId}:cancel`,
        approvalCancelArguments(args),
        signal,
      );
    }
  }
  return informationalResult("Approval was not sent; the request remains pending.");
}

async function executeConfirmedCancel(
  connector: LiveConnector,
  toolCallId: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<HostBridgeToolResult> {
  if (!ctx.hasUI) {
    throw new Error("AKK cancellation requires an interactive Pi confirmation");
  }
  const confirmed = await ctx.ui.confirm(
    "Cancel AKK task?",
    "This interrupts the exact AKK task selected by the tool call.",
    signal ? { signal } : undefined,
  );
  if (!confirmed) return informationalResult("Cancellation was not sent.");
  return connector.adapter.executeTool(
    controllerContext(connector),
    CANCEL_TOOL,
    toolCallId,
    args,
    signal,
  );
}

function createTarget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  resources: ConnectorProfileResources,
  branchEpoch: number,
  current: () => LiveConnector,
): PiCallbackTarget {
  const authority = Object.freeze({
    connector: CONNECTOR_NAME,
    nonce: resources.instanceNonce,
    branchEpoch,
  });
  const sessionId = ctx.sessionManager.getSessionId();
  const runtimeGeneration = `${resources.instanceNonce}:branch:${branchEpoch}`;
  const anchorLeafId = ctx.sessionManager.getLeafId();
  let target: PiCallbackTarget;
  target = Object.freeze({
    authority,
    sessionId,
    runtimeGeneration,
    anchorLeafId,
    isLive(): boolean {
      const connector = current();
      return connector.running && connector.target === target &&
        ctx.sessionManager.getSessionId() === sessionId;
    },
    deliver(body: string, request: CallbackRequest): void {
      if (!target.isLive()) {
        throw new Error("Pi callback target is no longer live");
      }
      pi.sendMessage({
        customType: CALLBACK_CUSTOM_TYPE,
        content: body,
        display: true,
        details: {
          controllerId: request.controllerId,
          deliveryId: request.deliveryId,
          messageId: request.messageId,
          idempotencyKey: request.idempotencyKey,
          sessionId,
          runtimeGeneration,
          anchorLeafId,
        },
      }, {
        triggerTurn: true,
        ...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }),
      });
    },
  });
  return target;
}

function rotateControllerTarget(
  pi: ExtensionAPI,
  connector: LiveConnector,
  ctx: ExtensionContext,
  current: () => LiveConnector | undefined,
): void {
  const previous = connector.target;
  connector.routes.dispose(previous);
  connector.adapter.disposeContext(previous.authority);
  connector.branchEpoch += 1;
  connector.target = createTarget(
    pi,
    ctx,
    connector.resources,
    connector.branchEpoch,
    () => current() ?? connector,
  );
  ctx.ui.notify(
    "AKK controller route was renewed for the selected Pi branch.",
    "info",
  );
}

async function stopConnector(connector: LiveConnector): Promise<void> {
  if (connector.stopPromise) return connector.stopPromise;
  connector.stopPromise = (async () => {
    const failures: unknown[] = [];
    await settleCleanup(
      () => connector.adapter.lifecycle.stop(),
      failures,
    );
    await settleCleanup(() => connector.server.stop(), failures);
    connector.running = false;
    settleSynchronousCleanup(() => {
      connector.routes.dispose(connector.target);
      connector.adapter.disposeContext(connector.target.authority);
    }, failures);
    await settleCleanup(() => connector.routes.close(), failures);
    await settleCleanup(() => connector.inbox.close(), failures);
    settleSynchronousCleanup(() => connector.resources.remove(), failures);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Pi AKK connector cleanup failed");
    }
  })();
  return connector.stopPromise;
}

function controllerContext(
  connector: LiveConnector,
): HostAdapterControllerContext {
  if (!connector.running) throw new Error("Pi AKK connector is not running");
  const route = connector.routes.bind(connector.target);
  return Object.freeze({
    sessionKey: route.controllerId,
    sessionId: route.controllerId,
    authority: connector.target.authority,
  });
}

function approvalStatusArguments(
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const turnId = nonBlankString(args.turn_id);
  if (turnId) return { turn_id: turnId };
  const terminalId = nonBlankString(args.terminal_id);
  if (terminalId) return { conversation_id: terminalId };
  throw new Error("AKK approval requires turn_id or terminal_id");
}

function approvalCancelArguments(
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const turnId = nonBlankString(args.turn_id);
  if (turnId) return { turn_id: turnId };
  throw new Error("AKK approval cancellation requires a managed turn_id");
}

function assertSupportedPiVersion(version: string): void {
  if (version !== SUPPORTED_PI_VERSION) {
    throw new Error(
      `agent-knock-knock-pi POC requires Pi ${SUPPORTED_PI_VERSION}; ` +
      `received ${version || "unknown"}`,
    );
  }
}

function connectorPluginConfig(
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, unknown>> {
  const storeDir = environment[CONNECTOR_STORE_DIR_ENV];
  if (!storeDir) return Object.freeze({});
  if (!path.isAbsolute(storeDir)) {
    throw new Error(`${CONNECTOR_STORE_DIR_ENV} must be an absolute path`);
  }
  return Object.freeze({ storeDir: path.resolve(storeDir) });
}

async function settleCleanup(
  cleanup: () => Promise<void>,
  failures: unknown[],
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
}

function settleSynchronousCleanup(
  cleanup: () => void,
  failures: unknown[],
): void {
  try {
    cleanup();
  } catch (error) {
    failures.push(error);
  }
}

function hostToolResultText(result: HostBridgeToolResult): string {
  const text = result.content
    ?.filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text) return text;
  if (result.details !== undefined) {
    try {
      return JSON.stringify(result.details);
    } catch {
      // Fall through to one stable result below.
    }
  }
  return "AKK command completed.";
}

function informationalResult(text: string): HostBridgeToolResult {
  return { content: [{ type: "text", text }], details: { acknowledged: false } };
}

function losslessDetails(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(encoded);
  } catch {
    return undefined;
  }
}

function requiredRecord(
  value: unknown,
  toolName: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${toolName} arguments must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredLive(value: LiveConnector | undefined): LiveConnector {
  if (!value?.running) throw new Error("Pi AKK connector is not running");
  return value;
}

function truncateForDialog(value: string): string {
  if (value.length <= MAX_APPROVAL_DISPLAY_CHARS) return value;
  return `${value.slice(0, MAX_APPROVAL_DISPLAY_CHARS)}\n…(truncated)`;
}

function toolLabel(name: string): string {
  return name
    .replace(/^agent_knock_knock_/u, "AKK ")
    .split("_")
    .map((part) => part.length > 0
      ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
      : part)
    .join(" ");
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** Keep the Pi model credential out of AKK relay and callback subprocesses. */
function relayEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const relay = { ...environment };
  delete relay.ZAI_CODING_CN_API_KEY;
  delete relay.ZAI_API_KEY;
  return relay;
}
