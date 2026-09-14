import {
  bindHostBridgeAsyncRelay,
  bindHostBridgeToolPresentation,
  bindOpenClawRelayEnvironment,
  bindOpenClawRelayPath,
  createAkkSemanticToolCatalog
} from "./openclaw-plugin-command-adapter.js";

export interface HostBridgeToolContext {
  readonly sessionKey: string;
  readonly sessionId: string;
}

export interface HostBridgeToolLogger {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error?(message: string): void;
}

export interface HostBridgeToolContent {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface HostBridgeToolResult {
  readonly content?: readonly HostBridgeToolContent[];
  readonly details?: unknown;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export interface HostBridgeCommandResult {
  readonly text: string;
  readonly isError?: boolean;
}

export interface HostBridgeCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly acceptsArgs: boolean;
  execute(args: string): Promise<HostBridgeCommandResult>;
}

export interface HostBridgeToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  execute(
    toolCallId: string,
    args: Readonly<Record<string, unknown>>
  ): Promise<HostBridgeToolResult>;
}

export interface HostBridgeToolRegistry {
  list(): readonly HostBridgeToolDescriptor[];
  get(name: string): HostBridgeToolDescriptor | undefined;
  execute(
    name: string,
    toolCallId: string,
    args: Readonly<Record<string, unknown>>
  ): Promise<HostBridgeToolResult>;
}

export interface HostBridgeCommandToolRegistry extends HostBridgeToolRegistry {
  command(): HostBridgeCommandDescriptor;
}

export interface CreateHostBridgeToolsOptions {
  readonly relayPath: string;
  readonly relayEnvironment: NodeJS.ProcessEnv;
  readonly pluginConfig: Readonly<Record<string, unknown>>;
  readonly logger: HostBridgeToolLogger;
  readonly context: HostBridgeToolContext;
}

/**
 * Adapt the established host-neutral AKK catalog to a Host Bridge registry.
 *
 * One private runtime owner is retained for the registry lifetime so approval,
 * action-offer, resume-snapshot, and idempotency state cannot cross owners.
 */
export function createHostBridgeToolRegistry(
  options: CreateHostBridgeToolsOptions
): HostBridgeCommandToolRegistry {
  const trustedContext = Object.freeze({
    sessionKey: requiredString(options.context.sessionKey, "context.sessionKey"),
    sessionId: requiredString(options.context.sessionId, "context.sessionId")
  });
  const runtime = {
    pluginConfig: options.pluginConfig,
    logger: options.logger
  };
  bindOpenClawRelayPath(runtime, requiredString(options.relayPath, "relayPath"));
  bindOpenClawRelayEnvironment(runtime, options.relayEnvironment);
  bindHostBridgeToolPresentation(runtime);
  bindHostBridgeAsyncRelay(runtime);
  const catalog = createAkkSemanticToolCatalog(runtime, new Map());

  if (catalog.tools.length !== 22) {
    throw new Error(
      `host bridge expected 22 semantic tools, received ${catalog.tools.length}`
    );
  }
  const commandName = requiredString(catalog.command.name, "command name");
  if (commandName !== "akk") {
    throw new Error(`host bridge expected command akk, received ${commandName}`);
  }
  const commandDescriptor: HostBridgeCommandDescriptor = Object.freeze({
    name: commandName,
    description: catalog.command.description,
    acceptsArgs: catalog.command.acceptsArgs,
    async execute(args: string): Promise<HostBridgeCommandResult> {
      const result = await catalog.command.execute({
        ...trustedContext,
        args: typeof args === "string" ? args : ""
      });
      if (!isRecord(result) || typeof result.text !== "string") {
        throw new Error(
          `host bridge command ${commandName} returned an invalid result`
        );
      }
      return {
        text: result.text,
        ...(result.isError === true ? { isError: true } : {})
      };
    }
  });
  const descriptors = catalog.tools.map((tool) => {
    const descriptor: HostBridgeToolDescriptor = Object.freeze({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      async execute(toolCallId, args) {
        const result = await tool.execute(
          trustedContext,
          toolCallId,
          args
        );
        if (!isRecord(result)) {
          throw new Error(
            `host bridge tool ${tool.name} returned an invalid result`
          );
        }
        return result as HostBridgeToolResult;
      }
    });
    return descriptor;
  });
  const descriptorsByName = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor])
  );

  const listed = Object.freeze([...descriptors]);
  return Object.freeze({
    command: () => commandDescriptor,
    list: () => listed,
    get: (name: string) => descriptorsByName.get(name),
    execute: async (
      name: string,
      toolCallId: string,
      args: Readonly<Record<string, unknown>>
    ) => {
      const descriptor = descriptorsByName.get(name);
      if (!descriptor) {
        throw new Error(`unknown host bridge tool ${name}`);
      }
      return descriptor.execute(toolCallId, args);
    }
  });
}

export function createHostBridgeTools(
  options: CreateHostBridgeToolsOptions
): readonly HostBridgeToolDescriptor[] {
  return createHostBridgeToolRegistry(options).list();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
