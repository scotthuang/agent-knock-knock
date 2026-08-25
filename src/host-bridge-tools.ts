import {
  bindHostBridgeAsyncRelay,
  bindHostBridgeToolPresentation,
  bindOpenClawRelayEnvironment,
  bindOpenClawRelayPath,
  registerOpenClawCommands
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

interface CapturedToolDefinition {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly parameters?: unknown;
  execute?(toolCallId: string, args: unknown): Promise<unknown> | unknown;
}

interface CapturedCommandDefinition {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly acceptsArgs?: unknown;
  handler?(context: HostBridgeToolContext & { readonly args: string }):
    Promise<unknown> | unknown;
}

type CapturedToolFactory = (
  context: HostBridgeToolContext
) => CapturedToolDefinition;

/**
 * Capture the established AKK semantic tools behind a host-neutral registry.
 *
 * Tool factories are instantiated exactly once with the trusted controller
 * context. Keeping the same API object and definitions alive also preserves
 * the private-authority state owned by the OpenClaw-compatible implementation.
 */
export function createHostBridgeToolRegistry(
  options: CreateHostBridgeToolsOptions
): HostBridgeCommandToolRegistry {
  const descriptors: HostBridgeToolDescriptor[] = [];
  const descriptorsByName = new Map<string, HostBridgeToolDescriptor>();
  let commandDescriptor: HostBridgeCommandDescriptor | undefined;
  const trustedContext = Object.freeze({
    sessionKey: requiredString(options.context.sessionKey, "context.sessionKey"),
    sessionId: requiredString(options.context.sessionId, "context.sessionId")
  });

  const api = {
    pluginConfig: options.pluginConfig,
    logger: options.logger,
    registerCommand(command: CapturedCommandDefinition): void {
      if (commandDescriptor) {
        throw new Error("host bridge registered more than one command");
      }
      const name = requiredString(command.name, "command name");
      if (name !== "akk") {
        throw new Error(`host bridge expected command akk, received ${name}`);
      }
      if (typeof command.description !== "string") {
        throw new Error(`host bridge command ${name} has no description`);
      }
      if (typeof command.handler !== "function") {
        throw new Error(`host bridge command ${name} has no handler`);
      }
      const handler = command.handler.bind(command);
      commandDescriptor = Object.freeze({
        name,
        description: command.description,
        acceptsArgs: command.acceptsArgs === true,
        async execute(args: string): Promise<HostBridgeCommandResult> {
          const result = await handler({
            ...trustedContext,
            args: typeof args === "string" ? args : ""
          });
          if (!isRecord(result) || typeof result.text !== "string") {
            throw new Error(`host bridge command ${name} returned an invalid result`);
          }
          return {
            text: result.text,
            ...(result.isError === true ? { isError: true } : {})
          };
        }
      });
    },
    registerTool(
      tool: CapturedToolDefinition | CapturedToolFactory,
      registration?: { readonly name?: unknown }
    ): void {
      const definition = typeof tool === "function"
        ? tool(trustedContext)
        : tool;
      const name = requiredString(definition.name, "tool name");
      const registeredName = requiredString(
        registration?.name,
        `registration name for ${name}`
      );
      if (registeredName !== name) {
        throw new Error(
          `host bridge tool registration name ${registeredName} does not match ${name}`
        );
      }
      if (descriptorsByName.has(name)) {
        throw new Error(`duplicate host bridge tool ${name}`);
      }
      if (typeof definition.description !== "string") {
        throw new Error(`host bridge tool ${name} has no description`);
      }
      if (!isRecord(definition.parameters)) {
        throw new Error(`host bridge tool ${name} has no input schema`);
      }
      if (typeof definition.execute !== "function") {
        throw new Error(`host bridge tool ${name} has no execute function`);
      }

      const execute = definition.execute.bind(definition);
      const descriptor: HostBridgeToolDescriptor = Object.freeze({
        name,
        description: definition.description,
        inputSchema: definition.parameters,
        async execute(toolCallId, args) {
          const result = await execute(toolCallId, args);
          if (!isRecord(result)) {
            throw new Error(`host bridge tool ${name} returned an invalid result`);
          }
          return result as HostBridgeToolResult;
        }
      });
      descriptors.push(descriptor);
      descriptorsByName.set(name, descriptor);
    }
  };

  bindOpenClawRelayPath(api, requiredString(options.relayPath, "relayPath"));
  bindOpenClawRelayEnvironment(api, options.relayEnvironment);
  bindHostBridgeToolPresentation(api);
  bindHostBridgeAsyncRelay(api);
  registerOpenClawCommands(api, new Map());

  if (!commandDescriptor) {
    throw new Error("host bridge did not capture the akk command");
  }

  if (descriptors.length !== 16) {
    throw new Error(
      `host bridge expected 16 semantic tools, received ${descriptors.length}`
    );
  }

  const listed = Object.freeze([...descriptors]);
  const capturedCommand = commandDescriptor;
  return Object.freeze({
    command: () => capturedCommand,
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
