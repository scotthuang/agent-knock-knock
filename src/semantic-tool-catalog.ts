export interface SemanticToolControllerContext {
  readonly sessionKey?: unknown;
  readonly sessionId?: unknown;
}

export interface SemanticCommandControllerContext
  extends SemanticToolControllerContext {
  readonly args?: unknown;
}

export interface SemanticCommandCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly acceptsArgs: boolean;
  readonly requiresAuthentication: boolean;
  readonly progressMessage: string;
  readonly promptGuidance: readonly string[];
  execute(
    context: SemanticCommandControllerContext
  ): Promise<unknown> | unknown;
}

export interface SemanticToolCatalogEntry {
  readonly label: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  execute(
    context: SemanticToolControllerContext,
    toolCallId: unknown,
    args: unknown,
    signal?: AbortSignal
  ): Promise<unknown> | unknown;
}

export interface SemanticToolCatalog {
  readonly command: SemanticCommandCatalogEntry;
  readonly tools: readonly SemanticToolCatalogEntry[];
}

export interface SemanticToolCatalogRegistrar {
  registerCommand?(command: Readonly<Record<string, unknown>>): void;
  registerTool(
    factory: (
      context: SemanticToolControllerContext
    ) => Readonly<Record<string, unknown>>,
    registration: { readonly name: string; readonly optional: true }
  ): void;
}

const pendingToolsByRuntime = new WeakMap<
  object,
  SemanticToolCatalogEntry[]
>();

export function beginSemanticToolCatalog(runtime: object): void {
  if (pendingToolsByRuntime.has(runtime)) {
    throw new Error("semantic tool catalog construction is already active");
  }
  pendingToolsByRuntime.set(runtime, []);
}

export function defineSemanticCatalogTool(
  runtime: object,
  tool: SemanticToolCatalogEntry
): void {
  const tools = pendingToolsByRuntime.get(runtime);
  if (!tools) {
    throw new Error("semantic tools must be defined inside catalog construction");
  }
  tools.push(tool);
}

export function semanticToolLabel(name: string): string {
  const action = name.replace(/^agent_knock_knock_/u, "")
    .split("_").filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `AKK ${action || "Tool"}`;
}

export function finishSemanticToolCatalog(
  runtime: object,
  command: SemanticCommandCatalogEntry
): SemanticToolCatalog {
  const tools = pendingToolsByRuntime.get(runtime);
  if (!tools) {
    throw new Error("semantic tool catalog construction is not active");
  }
  pendingToolsByRuntime.delete(runtime);
  return defineSemanticToolCatalog(command, tools);
}

/** Adapt one catalog to a context-factory registration API such as OpenClaw. */
export function registerSemanticToolCatalog(
  registrar: SemanticToolCatalogRegistrar,
  catalog: SemanticToolCatalog
): void {
  registrar.registerCommand?.({
    name: catalog.command.name,
    description: catalog.command.description,
    acceptsArgs: catalog.command.acceptsArgs,
    requireAuth: catalog.command.requiresAuthentication,
    nativeProgressMessages: { default: catalog.command.progressMessage },
    agentPromptGuidance: catalog.command.promptGuidance,
    handler: async (context: SemanticCommandControllerContext) =>
      catalog.command.execute(context)
  });
  for (const tool of catalog.tools) {
    registrar.registerTool((context) => ({
      label: tool.label,
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      execute: (toolCallId: unknown, args: unknown, signal?: AbortSignal) =>
        tool.execute(context, toolCallId, args, signal)
    }), { name: tool.name, optional: true });
  }
}

/**
 * Freeze one host-neutral semantic catalog after checking its public identity.
 *
 * The catalog owns tool order, metadata, schema references, and execution
 * factories. Host-specific registration APIs adapt this value; they are not a
 * source of tool definitions.
 */
export function defineSemanticToolCatalog(
  command: SemanticCommandCatalogEntry,
  tools: readonly SemanticToolCatalogEntry[]
): SemanticToolCatalog {
  const exactCommand = Object.freeze({
    ...command,
    promptGuidance: Object.freeze([...command.promptGuidance])
  });
  requiredString(exactCommand.name, "semantic command name");
  requiredString(exactCommand.description, "semantic command description");
  requiredString(exactCommand.progressMessage, "semantic command progress message");
  if (
    !Array.isArray(exactCommand.promptGuidance) ||
    exactCommand.promptGuidance.some((value) =>
      typeof value !== "string" || value.length === 0
    )
  ) {
    throw new Error("semantic command prompt guidance is invalid");
  }
  if (typeof exactCommand.execute !== "function") {
    throw new Error("semantic command execute is required");
  }

  const names = new Set<string>();
  const exactTools = tools.map((tool) => {
    const exactTool = Object.freeze({ ...tool });
    const name = requiredString(exactTool.name, "semantic tool name");
    requiredString(exactTool.label, `semantic tool ${name} label`);
    requiredString(
      exactTool.description,
      `semantic tool ${name} description`
    );
    if (!isRecord(exactTool.inputSchema)) {
      throw new Error(`semantic tool ${name} input schema is required`);
    }
    if (typeof exactTool.execute !== "function") {
      throw new Error(`semantic tool ${name} execute is required`);
    }
    if (names.has(name)) {
      throw new Error(`duplicate semantic tool ${name}`);
    }
    names.add(name);
    return exactTool;
  });

  return Object.freeze({
    command: exactCommand,
    tools: Object.freeze(exactTools)
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
