/** Native, no-bind Agent Knock Knock integration for DeepSeek Harness Web. */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonValue, ToolDefinition } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import {
  createHostAdapter,
  type HostAdapter,
  type HostAdapterControllerContext,
  type HostAdapterToolMetadata,
} from "@scotthuang/agent-knock-knock/host-adapter";

import {
  CONNECTOR_NAME,
  DSH_LAUNCHER_PACKAGE,
  DSH_RUNTIME_ANCHOR_PACKAGE,
  SUPPORTED_DSH_RUNTIME_PACKAGES,
  SUPPORTED_DSH_VERSIONS,
  type SupportedDeepSeekHarnessVersion,
} from "./constants.js";
import { createCallbackIpcServer } from "./ipc.js";
import { createConnectorProfileResources } from "./profile.js";
import {
  AgentRouteTable,
  type CreateUserMessage,
} from "./routes.js";
import {
  adaptHostToolInputSchema,
  compileAuthoritativeInputValidator,
  type AssertSupportedJsonSchema,
} from "./schema-adapter.js";

export const name = CONNECTOR_NAME;
export const inject = ["agents", "commands", "tools"];

export interface Config {
  /** AKK reconciliation cadence for the one shared Host lifecycle service. */
  lifecycleIntervalMs?: number;
  /** Existing AKK plugin options such as storeDir or executor timeouts. */
  pluginConfig?: Record<string, unknown>;
}

export const Config: z<Config> = z.object({
  lifecycleIntervalMs: z.number().min(50).default(5_000),
  pluginConfig: z.dict(z.any()).default({}),
});

/**
 * Mount `/akk`, all 16 semantic AKK tools, one callback route table, and one
 * Host-owned lifecycle service. No explicit bind command or per-session setup
 * exists: the exact command/tool Agent becomes the callback owner lazily.
 */
export async function apply(
  ctx: Context,
  config: Config = {},
): Promise<() => Promise<void>> {
  return applyWithDependencies(ctx, config);
}

/** @internal Strict dependency seam used by the connector's native wiring tests. */
export interface ConnectorDependencies {
  readonly loadSupportedDeepSeekHarnessRuntime:
    () => Promise<SupportedDeepSeekHarnessRuntime>;
  readonly createConnectorProfileResources: typeof createConnectorProfileResources;
  readonly createCallbackIpcServer: typeof createCallbackIpcServer;
  readonly createHostAdapter: typeof createHostAdapter;
}

const DEFAULT_DEPENDENCIES: ConnectorDependencies = Object.freeze({
  loadSupportedDeepSeekHarnessRuntime,
  createConnectorProfileResources,
  createCallbackIpcServer,
  createHostAdapter,
});

/** @internal Mount with replaceable process/IPC seams for deterministic tests. */
export async function applyWithDependencies(
  ctx: Context,
  config: Config = {},
  dependencies: Partial<ConnectorDependencies> = {},
): Promise<() => Promise<void>> {
  const resolved = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const harnessRuntime = await resolved.loadSupportedDeepSeekHarnessRuntime();

  const resources = resolved.createConnectorProfileResources(
    harnessRuntime.version,
  );
  let routes: AgentRouteTable | undefined;
  let server: ReturnType<typeof createCallbackIpcServer> | undefined;
  let adapter: HostAdapter | undefined;
  const disposers: Array<() => void> = [];
  let lifecycleStarted = false;

  try {
    const builtRoutes = new AgentRouteTable(
      ctx.agents,
      harnessRuntime.createUserMessage,
      resources.instanceNonce,
    );
    routes = builtRoutes;
    const builtServer = resolved.createCallbackIpcServer({
      socketPath: resources.socketPath,
      token: resources.token,
      routes: builtRoutes,
    });
    server = builtServer;
    const lifecycleControllerId = `akk-dsh:${resources.instanceNonce}:lifecycle`;
    const builtAdapter = resolved.createHostAdapter({
      environmentForContext(context) {
        if (context.sessionKey !== context.sessionId) {
          throw new Error("DeepSeek Harness AKK controller identities diverged");
        }
        return resources.environment(context.sessionKey);
      },
      lifecycleEnvironment: resources.environment(lifecycleControllerId),
      lifecycleIntervalMs: config.lifecycleIntervalMs,
      pluginConfig: config.pluginConfig ?? {},
      logger: {
        debug: (message) => ctx.logger.debug(message),
        info: (message) => ctx.logger.info(message),
        warn: (message) => ctx.logger.warn(message),
        error: (message) => ctx.logger.error(message),
      },
    });
    adapter = builtAdapter;

    await builtServer.start();
    builtAdapter.lifecycle.start();
    lifecycleStarted = true;

    disposers.push(ctx.on("agent/disposed", ({ agent }) => {
      builtRoutes.disposeAgent(agent);
      builtAdapter.disposeContext(agent);
    }));
    disposers.push(ctx.commands.register(commandDefinition(
      builtAdapter,
      builtRoutes,
    )));
    for (const tool of builtAdapter.tools) {
      disposers.push(ctx.tools.register(toolDefinition(
        builtAdapter,
        builtRoutes,
        tool,
        harnessRuntime.assertSupportedJsonSchema,
      )));
    }
    if (builtAdapter.tools.length !== 16) {
      throw new Error(
        `agent-knock-knock-deepseek-harness expected 16 AKK tools, received ${builtAdapter.tools.length}`,
      );
    }

    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.reverse()) dispose();
      await builtAdapter.lifecycle.stop();
      builtRoutes.close();
      await builtServer.stop();
      resources.remove();
    };
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    if (lifecycleStarted && adapter) await adapter.lifecycle.stop();
    routes?.close();
    if (server) await server.stop();
    resources.remove();
    throw error;
  }
}

function commandDefinition(
  adapter: HostAdapter,
  routes: AgentRouteTable,
): CommandDefinition {
  return {
    name: adapter.command.name,
    description: adapter.command.description,
    input: { hint: "<task or AKK command>" },
    handler: async (invocation) => {
      const context = controllerContext(routes, invocation.agent);
      const result = await adapter.executeCommand(
        context,
        invocation.rawInput,
        invocation.signal,
      );
      return result.isError
        ? { kind: "error", text: result.text }
        : { kind: "success", text: result.text };
    },
  };
}

function toolDefinition(
  adapter: HostAdapter,
  routes: AgentRouteTable,
  metadata: HostAdapterToolMetadata,
  assertSupportedJsonSchema: AssertSupportedJsonSchema,
): ToolDefinition {
  const parameters = adaptHostToolInputSchema(
    metadata.inputSchema,
    assertSupportedJsonSchema,
  );
  const validateAuthoritativeInput = compileAuthoritativeInputValidator(
    metadata.inputSchema,
  );
  return {
    name: metadata.name,
    description: metadata.description,
    parameters: { ...parameters },
    // An empty schema is DSH's raw JSON-Schema form for an unconstrained JSON
    // canonical value. The connector returns one stable { text } projection.
    output: {
      schema: {},
      render(_args: unknown, value: JsonValue): ContentBlock[] {
        return [{ type: "text", text: canonicalToolText(value) }];
      },
    },
    async execute(args, execution) {
      validateAuthoritativeInput(args);
      const agent = execution.agent;
      if (!agent) {
        throw new Error(`${metadata.name} requires an exact DeepSeek Harness Agent`);
      }
      const result = await adapter.executeTool(
        controllerContext(routes, agent),
        metadata.name,
        String(execution.callId),
        requiredRecord(args, metadata.name),
        execution.signal,
      );
      if (result.isError) throw new Error(hostToolResultText(result));
      return losslessToolResult(result, metadata.name);
    },
  };
}

function controllerContext(
  routes: AgentRouteTable,
  agent: Agent,
): HostAdapterControllerContext {
  const route = routes.bind(agent);
  return Object.freeze({
    sessionKey: route.controllerId,
    sessionId: route.controllerId,
    authority: agent,
  });
}

function hostToolResultText(result: {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly details?: unknown;
}): string {
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
      // Fall through to a stable model-facing completion below.
    }
  }
  return "AKK command completed.";
}

function canonicalToolText(value: JsonValue): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const record = value as Record<string, JsonValue>;
    const content = record.content;
    if (Array.isArray(content)) {
      const text = content.flatMap((block) => {
        if (typeof block !== "object" || block === null || Array.isArray(block)) {
          return [];
        }
        const candidate = (block as Record<string, JsonValue>).text;
        return typeof candidate === "string" ? [candidate] : [];
      }).join("\n").trim();
      if (text) return text;
    }
  }
  return JSON.stringify(value);
}

function losslessToolResult(
  value: unknown,
  toolName: string,
): JsonValue {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("no JSON representation");
    return JSON.parse(encoded) as JsonValue;
  } catch {
    throw new Error(`${toolName} returned a non-lossless JSON result`);
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

export interface DeepSeekHarnessManifestResolver {
  launcherManifest(): unknown;
  runtimeAnchorManifest(): unknown;
  runtimePackageManifest(packageName: string): unknown;
  runtimePackageEntry(packageName: string): string;
}

/** Host-owned DSH functions whose implementation must match the verified package set. */
export interface SupportedDeepSeekHarnessRuntime {
  readonly version: SupportedDeepSeekHarnessVersion;
  readonly createUserMessage: CreateUserMessage;
  readonly assertSupportedJsonSchema: AssertSupportedJsonSchema;
}

/** @internal Resolve compatibility evidence only from the real DSH launcher tree. */
export function createDeepSeekHarnessManifestResolver(
  launcherEntryPath: string | undefined = process.argv[1],
): DeepSeekHarnessManifestResolver {
  if (!launcherEntryPath || launcherEntryPath.trim() !== launcherEntryPath) {
    throw new Error(
      "agent-knock-knock-deepseek-harness could not identify the DeepSeek Harness launcher",
    );
  }

  let launcherManifestPath: string;
  try {
    const launcherPath = fs.realpathSync(path.resolve(launcherEntryPath));
    launcherManifestPath = findOwningPackageManifest(
      launcherPath,
      DSH_LAUNCHER_PACKAGE,
    );
  } catch {
    throw new Error(
      "agent-knock-knock-deepseek-harness could not identify the " +
      `${DSH_LAUNCHER_PACKAGE} launcher package`,
    );
  }
  const requireFromLauncher = createRequire(launcherManifestPath);
  let runtimeAnchorManifestPath: string;
  try {
    runtimeAnchorManifestPath = fs.realpathSync(
      requireFromLauncher.resolve(`${DSH_RUNTIME_ANCHOR_PACKAGE}/package.json`),
    );
  } catch {
    throw new Error(
      "agent-knock-knock-deepseek-harness could not identify the " +
      `${DSH_RUNTIME_ANCHOR_PACKAGE} launcher runtime anchor`,
    );
  }
  const requireFromRuntimeAnchor = createRequire(runtimeAnchorManifestPath);

  return Object.freeze({
    launcherManifest: () => readPackageManifest(launcherManifestPath),
    runtimeAnchorManifest: () => readPackageManifest(runtimeAnchorManifestPath),
    runtimePackageManifest(packageName: string): unknown {
      assertKnownRuntimePackageName(packageName);
      let manifestPath: string;
      try {
        manifestPath = fs.realpathSync(
          requireFromRuntimeAnchor.resolve(`${packageName}/package.json`),
        );
      } catch {
        throw new Error(
          `DeepSeek Harness launcher is missing runtime package ${packageName}`,
        );
      }
      return readPackageManifest(manifestPath);
    },
    runtimePackageEntry(packageName: string): string {
      assertKnownRuntimePackageName(packageName);
      try {
        return fs.realpathSync(requireFromRuntimeAnchor.resolve(packageName));
      } catch {
        throw new Error(
          `DeepSeek Harness launcher cannot load runtime package ${packageName}`,
        );
      }
    },
  });
}

/**
 * Validate one launcher-owned package set, then import the exact Host modules
 * that own the connector's two runtime helper functions.
 */
export async function loadSupportedDeepSeekHarnessRuntime(
  resolver: DeepSeekHarnessManifestResolver =
    createDeepSeekHarnessManifestResolver(),
): Promise<SupportedDeepSeekHarnessRuntime> {
  const version = assertSupportedDeepSeekHarness(resolver);
  const [llmModule, toolsModule] = await Promise.all([
    importRuntimePackage(resolver, "@deepseek-ai/dsh-llm"),
    importRuntimePackage(resolver, "@deepseek-ai/dsh-tools"),
  ]);
  const createUserMessage = llmModule.createUserMessage;
  if (typeof createUserMessage !== "function") {
    throw new Error(
      "DeepSeek Harness runtime package @deepseek-ai/dsh-llm does not export createUserMessage",
    );
  }
  const assertSupportedJsonSchema = toolsModule.assertSupportedJsonSchema;
  if (typeof assertSupportedJsonSchema !== "function") {
    throw new Error(
      "DeepSeek Harness runtime package @deepseek-ai/dsh-tools does not export assertSupportedJsonSchema",
    );
  }
  return Object.freeze({
    version,
    createUserMessage: createUserMessage as CreateUserMessage,
    assertSupportedJsonSchema:
      assertSupportedJsonSchema as AssertSupportedJsonSchema,
  });
}

/** @internal Fail before mounting if the launcher-owned DSH package set split. */
export function assertSupportedDeepSeekHarness(
  resolver: DeepSeekHarnessManifestResolver =
    createDeepSeekHarnessManifestResolver(),
): SupportedDeepSeekHarnessVersion {
  const launcherVersion = assertSupportedDeepSeekHarnessPackage(
    resolver.launcherManifest(),
    DSH_LAUNCHER_PACKAGE,
  );
  assertMatchingDeepSeekHarnessPackage(
    resolver.runtimeAnchorManifest(),
    DSH_RUNTIME_ANCHOR_PACKAGE,
    launcherVersion,
  );
  for (const packageName of SUPPORTED_DSH_RUNTIME_PACKAGES) {
    let manifest: unknown;
    try {
      manifest = resolver.runtimePackageManifest(packageName);
    } catch (error) {
      throw new Error(
        `agent-knock-knock-deepseek-harness could not verify ${packageName}: ` +
        errorMessage(error),
      );
    }
    assertMatchingDeepSeekHarnessPackage(
      manifest,
      packageName,
      launcherVersion,
    );
  }
  return launcherVersion;
}

function assertSupportedDeepSeekHarnessPackage(
  manifest: unknown,
  expectedName: string,
): SupportedDeepSeekHarnessVersion {
  const version = deepSeekHarnessPackageVersion(manifest, expectedName);
  if (!isSupportedDeepSeekHarnessVersion(version)) {
    throw new Error(
      "agent-knock-knock-deepseek-harness supports only DeepSeek Harness " +
      `${SUPPORTED_DSH_VERSIONS.join(" or ")}; ${expectedName} is ${version}`,
    );
  }
  return version;
}

function assertMatchingDeepSeekHarnessPackage(
  manifest: unknown,
  expectedName: string,
  launcherVersion: SupportedDeepSeekHarnessVersion,
): void {
  const version = deepSeekHarnessPackageVersion(manifest, expectedName);
  if (version !== launcherVersion) {
    throw new Error(
      "agent-knock-knock-deepseek-harness requires one coherent DeepSeek " +
      `Harness ${launcherVersion} package set; ${expectedName} is ${version}`,
    );
  }
}

function deepSeekHarnessPackageVersion(
  manifest: unknown,
  expectedName: string,
): string {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new Error(
      `agent-knock-knock-deepseek-harness could not verify ${expectedName}: invalid package manifest`,
    );
  }
  const candidate = manifest as Record<string, unknown>;
  if (candidate.name !== expectedName) {
    throw new Error(
      `agent-knock-knock-deepseek-harness expected package ${expectedName}; ` +
      `found ${String(candidate.name)}`,
    );
  }
  if (typeof candidate.version !== "string") {
    throw new Error(
      `agent-knock-knock-deepseek-harness could not verify ${expectedName}: invalid package version`,
    );
  }
  return candidate.version;
}

function isSupportedDeepSeekHarnessVersion(
  version: string,
): version is SupportedDeepSeekHarnessVersion {
  return (SUPPORTED_DSH_VERSIONS as readonly string[]).includes(version);
}

function assertKnownRuntimePackageName(packageName: string): void {
  if (!(SUPPORTED_DSH_RUNTIME_PACKAGES as readonly string[]).includes(packageName)) {
    throw new Error(`unsupported DeepSeek Harness runtime package ${packageName}`);
  }
}

async function importRuntimePackage(
  resolver: DeepSeekHarnessManifestResolver,
  packageName: string,
): Promise<Readonly<Record<string, unknown>>> {
  let entryPath: string;
  try {
    entryPath = resolver.runtimePackageEntry(packageName);
  } catch (error) {
    throw new Error(
      `agent-knock-knock-deepseek-harness could not load ${packageName}: ` +
      errorMessage(error),
    );
  }
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(entryPath).href);
  } catch (error) {
    throw new Error(
      `agent-knock-knock-deepseek-harness could not import ${packageName}: ` +
      errorMessage(error),
    );
  }
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
    throw new Error(
      `agent-knock-knock-deepseek-harness imported invalid ${packageName} runtime exports`,
    );
  }
  return loaded as Readonly<Record<string, unknown>>;
}

function findOwningPackageManifest(
  entryPath: string,
  expectedName: string,
): string {
  let directory = fs.statSync(entryPath).isDirectory()
    ? entryPath
    : path.dirname(entryPath);
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = readPackageManifest(manifestPath);
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        !Array.isArray(manifest) &&
        (manifest as Record<string, unknown>).name === expectedName
      ) {
        return manifestPath;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`launcher is not owned by ${expectedName}`);
}

function readPackageManifest(manifestPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    throw new Error(`could not read package manifest ${manifestPath}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
