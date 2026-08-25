import fs from "node:fs";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from
  "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createHostBridgeMcpServer,
  drainHostBridgeMcpCalls
} from "./host-bridge-mcp.js";
import { createHostBridgeToolRegistry } from "./host-bridge-tools.js";
import {
  bindOpenClawRelayEnvironment,
  bindOpenClawRelayPath
} from "./openclaw-plugin-command-adapter.js";
import { createMonitorReconciliationService } from
  "./openclaw-plugin-supervisor.js";
import { assertHostProfileCallbackExecutableReady } from "./host-profile.js";
import {
  createTrustedHostProfileRuntime,
  hostProfileRelayEnvironment
} from "./host-profile-runtime.js";
import { packageRootDir } from "./cli-command-runtime.js";
import { cliCwd, cliEnv } from "./cli-runtime-context.js";

export interface HostBridgeCliOptions extends Record<string, unknown> {
  profile?: unknown;
  host?: unknown;
  hostVersion?: unknown;
  storeDir?: unknown;
}

export interface RunHostBridgeOptions {
  readonly profile: string;
  readonly host: string;
  readonly hostVersion: string;
  readonly storeDir?: string;
  readonly lifecycleIntervalMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly relayPath?: string;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly signalSource?: Pick<
    NodeJS.Process,
    "on" | "off"
  >;
}

/** CLI composition boundary; stdout remains exclusively owned by MCP/stdio. */
export async function runHostBridgeCli(
  options: HostBridgeCliOptions
): Promise<void> {
  await runHostBridge({
    profile: requiredString(options.profile, "--profile"),
    host: requiredString(options.host, "--host"),
    hostVersion: requiredString(options.hostVersion, "--host-version"),
    storeDir: optionalString(options.storeDir, "--store-dir"),
    environment: cliEnv(),
    cwd: cliCwd()
  });
}

/**
 * Run one foreground, Host-owned Bridge. It owns no daemon and returns only
 * after stdio closes or the owning Host sends SIGINT/SIGTERM.
 */
export async function runHostBridge(
  options: RunHostBridgeOptions
): Promise<void> {
  const environment = { ...(options.environment ?? process.env) };
  const cwd = options.cwd ?? process.cwd();
  const runtime = createTrustedHostProfileRuntime({
    selection: options.profile,
    host: options.host,
    hostVersion: options.hostVersion,
    environment,
    cwd
  });
  assertHostProfileCallbackExecutableReady(
    runtime.selected.profile.callback.executable,
    runtime.selected.profile.callback.environment.allow
  );

  const relayPath = options.relayPath ?? fileURLToPath(
    new URL("./cli.js", import.meta.url)
  );
  const relayEnvironment = hostProfileRelayEnvironment(runtime, environment);
  const pluginConfig = Object.freeze({
    ...(options.storeDir ? { storeDir: options.storeDir } : {})
  });
  const stderr = options.stderr ?? process.stderr;
  const logger = bridgeLogger(stderr);
  const tools = createHostBridgeToolRegistry({
    relayPath,
    relayEnvironment,
    pluginConfig,
    logger,
    context: {
      sessionKey: runtime.controllerSessionId,
      sessionId: runtime.controllerSessionId
    }
  });

  const lifecycleApi = { pluginConfig, logger };
  bindOpenClawRelayPath(lifecycleApi, relayPath);
  bindOpenClawRelayEnvironment(lifecycleApi, relayEnvironment);
  const lifecycle = createMonitorReconciliationService(
    lifecycleApi,
    options.lifecycleIntervalMs ?? 5_000
  );
  const server = createHostBridgeMcpServer({
    registry: tools,
    version: packageVersion()
  });
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(input, output);
  const signals = options.signalSource ?? process;

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
    await settle("MCP transport close", () => server.close(), logger);
    await settle("Host lifecycle drain", () => lifecycle.stop(), logger);
    await settle("MCP tool drain", () => drainHostBridgeMcpCalls(server), logger);
    resolveClosed();
  })();
  const onInputEnd = (): void => {
    void shutdown();
  };
  const onInputError = (error: Error): void => {
    logger.warn(`agent-knock-knock Host Bridge input error: ${error.message}`);
    void shutdown();
  };
  const onSignal = (): void => {
    void shutdown();
  };

  input.once("end", onInputEnd);
  input.once("close", onInputEnd);
  input.once("error", onInputError);
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  try {
    await server.connect(transport);
    lifecycle.start();
    if (
      (input as Readable & { readableEnded?: boolean }).readableEnded === true
    ) {
      await shutdown();
    }
    await closed;
  } finally {
    input.off("end", onInputEnd);
    input.off("close", onInputEnd);
    input.off("error", onInputError);
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
    await shutdown();
  }
}

function bridgeLogger(stderr: Writable) {
  const write = (level: string, message: string): void => {
    const line = String(message)
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 4_096);
    stderr.write(`[agent-knock-knock:${level}] ${line}\n`);
  };
  return Object.freeze({
    info: (message: string) => write("info", message),
    warn: (message: string) => write("warn", message),
    error: (message: string) => write("error", message)
  });
}

async function settle(
  label: string,
  operation: () => Promise<void>,
  logger: ReturnType<typeof bridgeLogger>
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.warn(`${label} failed: ${errorMessage(error)}`);
  }
}

function packageVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(
    `${packageRootDir()}/package.json`,
    "utf8"
  )) as { version?: unknown };
  return requiredString(packageJson.version, "package version");
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
