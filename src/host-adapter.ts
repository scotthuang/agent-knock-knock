import {
  createHostBridgeToolRegistry,
  type HostBridgeCommandResult,
  type HostBridgeToolContext,
  type HostBridgeToolLogger,
  type HostBridgeToolResult
} from "./host-bridge-tools.js";
export type {
  HostBridgeCommandResult,
  HostBridgeToolContext,
  HostBridgeToolLogger,
  HostBridgeToolResult
} from "./host-bridge-tools.js";
import {
  bindOpenClawRelayEnvironment,
  bindOpenClawRelayPath,
  defaultOpenClawRelayPath,
  withHostBridgeInvocationSignal
} from "./openclaw-plugin-command-adapter.js";
import {
  createMonitorReconciliationService,
  MONITOR_SUPERVISOR_INTERVAL_MS
} from "./openclaw-plugin-supervisor.js";

export {
  createTrustedHostProfileRuntime,
  hostProfileRelayEnvironment
} from "./host-profile-runtime.js";
export type {
  CreateTrustedHostProfileRuntimeOptions,
  TrustedHostProfileRuntimeV1
} from "./host-profile-runtime.js";

/** Stable relay entrypoint for native Host connector packages. */
export const defaultHostAdapterRelayPath = defaultOpenClawRelayPath;

export interface HostAdapterControllerContext extends HostBridgeToolContext {
  /** Exact Host-owned controller incarnation; never derive this from text. */
  readonly authority: object;
}

export type HostAdapterEnvironmentContext = HostBridgeToolContext;

export interface HostAdapterToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface HostAdapterCommandMetadata {
  readonly name: string;
  readonly description: string;
  readonly acceptsArgs: boolean;
}

export interface HostAdapterLifecycle {
  readonly id: string;
  start(): void;
  stop(): Promise<void>;
}

export interface CreateHostAdapterOptions {
  readonly relayPath?: string;
  readonly environmentForContext: (
    context: HostAdapterEnvironmentContext
  ) => NodeJS.ProcessEnv;
  /** Fixed child environment used by the one Host-owned lifecycle service. */
  readonly lifecycleEnvironment?: NodeJS.ProcessEnv;
  readonly lifecycleIntervalMs?: number;
  readonly pluginConfig?: Readonly<Record<string, unknown>>;
  readonly logger: HostBridgeToolLogger;
}

export interface HostAdapter {
  readonly command: HostAdapterCommandMetadata;
  readonly tools: readonly HostAdapterToolMetadata[];
  readonly lifecycle: HostAdapterLifecycle;
  executeCommand(
    context: HostAdapterControllerContext,
    args: string,
    signal?: AbortSignal
  ): Promise<HostBridgeCommandResult>;
  executeTool(
    context: HostAdapterControllerContext,
    name: string,
    toolCallId: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<HostBridgeToolResult>;
  /** Drop private action/snapshot authority when the Host disposes an owner. */
  disposeContext(authority: object): void;
}

interface CachedRegistry {
  readonly context: HostAdapterEnvironmentContext;
  readonly registry: ReturnType<typeof createHostBridgeToolRegistry>;
}

const METADATA_CONTEXT = Object.freeze({
  sessionKey: "host-adapter:metadata",
  sessionId: "host-adapter:metadata"
});

/**
 * Adapt AKK's established slash command and 16 semantic tools to a native Host.
 *
 * Public metadata is captured exactly once. Executable registries are created
 * lazily per exact Host authority object so private approvals, action offers,
 * resume snapshots, and idempotency identities cannot leak across controllers.
 */
export function createHostAdapter(options: CreateHostAdapterOptions): HostAdapter {
  const relayPath = requiredString(
    options.relayPath ?? defaultHostAdapterRelayPath,
    "relayPath"
  );
  const pluginConfig = options.pluginConfig ?? {};
  const metadataRegistry = createHostBridgeToolRegistry({
    relayPath,
    relayEnvironment: {},
    pluginConfig,
    logger: options.logger,
    context: METADATA_CONTEXT
  });
  const commandMetadata = immutableMetadataClone({
    name: metadataRegistry.command().name,
    description: metadataRegistry.command().description,
    acceptsArgs: metadataRegistry.command().acceptsArgs
  });
  const toolMetadata = immutableMetadataClone(
    metadataRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  );
  const registries = new WeakMap<object, CachedRegistry>();

  const lifecycleApi = {
    pluginConfig,
    logger: options.logger
  };
  bindOpenClawRelayPath(lifecycleApi, relayPath);
  bindOpenClawRelayEnvironment(
    lifecycleApi,
    options.lifecycleEnvironment ?? process.env
  );
  const lifecycle = createMonitorReconciliationService(
    lifecycleApi,
    options.lifecycleIntervalMs ?? MONITOR_SUPERVISOR_INTERVAL_MS
  );

  const registryFor = (
    context: HostAdapterControllerContext
  ): CachedRegistry["registry"] => {
    const trusted = trustedControllerContext(context);
    const cached = registries.get(context.authority);
    if (cached) {
      if (
        cached.context.sessionKey !== trusted.sessionKey ||
        cached.context.sessionId !== trusted.sessionId
      ) {
        throw new Error(
          "Host adapter authority cannot be reused with another controller context"
        );
      }
      return cached.registry;
    }
    const environment = options.environmentForContext(trusted);
    if (!environment || typeof environment !== "object") {
      throw new Error("environmentForContext must return a process environment");
    }
    const registry = createHostBridgeToolRegistry({
      relayPath,
      relayEnvironment: environment,
      pluginConfig,
      logger: options.logger,
      context: trusted
    });
    registries.set(context.authority, { context: trusted, registry });
    return registry;
  };

  return Object.freeze({
    command: commandMetadata,
    tools: toolMetadata,
    lifecycle,
    executeCommand(context, args, signal) {
      return withHostBridgeInvocationSignal(signal, () =>
        registryFor(context).command().execute(args)
      );
    },
    executeTool(context, name, toolCallId, args, signal) {
      return withHostBridgeInvocationSignal(signal, () =>
        registryFor(context).execute(name, toolCallId, args)
      );
    },
    disposeContext(authority) {
      requiredAuthority(authority);
      registries.delete(authority);
    }
  });
}

function trustedControllerContext(
  context: HostAdapterControllerContext
): HostAdapterEnvironmentContext {
  requiredAuthority(context?.authority);
  return Object.freeze({
    sessionKey: requiredString(context?.sessionKey, "context.sessionKey"),
    sessionId: requiredString(context?.sessionId, "context.sessionId")
  });
}

function requiredAuthority(value: unknown): asserts value is object {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new Error("context.authority must be an exact Host-owned object");
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function immutableMetadataClone<T>(value: T): T {
  return deepFreezeMetadata(structuredClone(value));
}

function deepFreezeMetadata<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return value;
  }
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreezeMetadata(
      (objectValue as Record<PropertyKey, unknown>)[key],
      seen
    );
  }
  return Object.freeze(value);
}
