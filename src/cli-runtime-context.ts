import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";
import type { CodingAgentSessionProvider } from "./agent-session-provider.js";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import type { CodexLocalSessionAdapter } from "./codex-local-session-provider.js";
import type { ExecutorKind } from "./executors.js";
import { writeRuntimeLog } from "./runtime-log.js";
import type { TerminalThreadLifecycleCandidateProvider } from "./terminal-agent-adapter.js";
import type { TerminalControlProviderRegistry } from "./terminal-control-provider.js";
import type { TerminalProcessSource } from "./terminal-process-source.js";

type CliDependencyOptions = Readonly<Record<string, unknown>>;

/**
 * Process-level dependencies used by an imported CLI command execution.
 *
 * Every dependency is scoped to one async execution. This deliberately avoids
 * mutating process globals, so independent in-process commands can run in
 * parallel without sharing providers, output, environment, or clocks.
 */
export interface CliCommandDependencies<Options extends CliDependencyOptions = CliDependencyOptions> {
  terminalControlProviderRegistry?: TerminalControlProviderRegistry;
  terminalProcessSource?: TerminalProcessSource;
  createAgentSessionProvider?: (
    agent: "codex",
    options: Options
  ) => CodingAgentSessionProvider;
  codexLocalSessionAdapter?: CodexLocalSessionAdapter | ((
    options: Options
  ) => CodexLocalSessionAdapter);
  codexThreadLifecycleProvider?: TerminalThreadLifecycleCandidateProvider;
  loadClaudeAgentRows?: (
    options: Options,
    observation: { required?: boolean }
  ) => ClaudeAgentRow[];
  agentVersionForRunningProcess?: (
    agent: ExecutorKind,
    pid: number,
    options: Options
  ) => string | undefined;
  codexProcessBirthForPid?: (pid: number) => string;
  /** Adapter-neutral process birth used to fence physical terminal actions. */
  processBirthForPid?: (pid: number) => string;
  stdout?: (text: string) => void;
  cwd?: string | (() => string);
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => Date | number;
  /** Monotonic clock for terminal composer settling; production uses performance.now. */
  monotonicNowMs?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  sleepSync?: (milliseconds: number) => void;
  exit?: (code: number) => never;
  runtimeLog?: (
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>
  ) => void;
}

export interface CliCommandExecutionResult {
  exitCode: number;
  stdout: string;
}

interface CliExecutionContext {
  executionDependencies: Readonly<Pick<CliCommandDependencies,
    "stdout" | "cwd" | "env" | "pid" | "now" | "sleep" | "sleepSync" |
    "exit" | "runtimeLog">>;
  commandDependencies: Readonly<object>;
  exitCode: number;
  stdout: string[];
}

const cliExecutionStorage = new AsyncLocalStorage<CliExecutionContext>();

function cliContext(): CliExecutionContext | undefined {
  return cliExecutionStorage.getStore();
}

/** Run one CLI command inside its async-local dependency and output boundary. */
export function runCliCommandExecution<Options extends CliDependencyOptions>(
  commandName: string | undefined,
  options: Options,
  dependencies: CliCommandDependencies<Options>,
  command: () => Promise<void>
): Promise<CliCommandExecutionResult> {
  const context: CliExecutionContext = {
    executionDependencies: dependencies,
    commandDependencies: dependencies,
    exitCode: 0,
    stdout: []
  };
  return cliExecutionStorage.run(context, async () => {
    cliRuntimeLog("info", "cli_start", {
      command: commandName ?? "help",
      cwd: cliCwd(),
      option_keys: Object.keys(options).sort()
    });
    try {
      await command();
      cliRuntimeLog("info", "cli_finish", {
        command: commandName ?? "help",
        exit_code: context.exitCode
      });
      return {
        exitCode: context.exitCode,
        stdout: context.stdout.join("")
      };
    } catch (error) {
      cliRuntimeLog("error", "cli_error", {
        command: commandName ?? "help",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  });
}

export function cliDependencies<Options extends CliDependencyOptions = CliDependencyOptions>(): Readonly<CliCommandDependencies<Options>> {
  return cliContext()?.commandDependencies ?? {};
}

export function writeCliStdout(text: string): void {
  const context = cliContext();
  if (!context) {
    throw new Error("CLI output requires an active executeCliCommand context");
  }
  context.stdout.push(text);
  context.executionDependencies.stdout?.(text);
}

export function setCliExitCode(exitCode: number): void {
  const context = cliContext();
  if (!context) {
    throw new Error("CLI exit status requires an active executeCliCommand context");
  }
  context.exitCode = exitCode;
}

export function cliCwd(): string {
  const configured = cliContext()?.executionDependencies.cwd;
  return typeof configured === "function"
    ? configured()
    : configured ?? process.cwd();
}

export function cliEnv(): NodeJS.ProcessEnv {
  return cliContext()?.executionDependencies.env ?? process.env;
}

export function cliPid(): number {
  return cliContext()?.executionDependencies.pid ?? process.pid;
}

export function cliNow(): Date {
  const value = cliContext()?.executionDependencies.now?.();
  return value instanceof Date
    ? new Date(value.getTime())
    : new Date(value ?? Date.now());
}

export function cliNowMs(): number {
  return cliNow().getTime();
}

export async function cliSleep(milliseconds: number): Promise<void> {
  const injected = cliContext()?.executionDependencies.sleep;
  if (injected) {
    await injected(milliseconds);
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function cliSleepSync(milliseconds: number): void {
  const injected = cliContext()?.executionDependencies.sleepSync;
  if (injected) {
    injected(milliseconds);
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function cliExit(code: number): never {
  const injected = cliContext()?.executionDependencies.exit;
  if (injected) {
    return injected(code);
  }
  return process.exit(code);
}

export function cliRuntimeLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const injected = cliContext()?.executionDependencies.runtimeLog;
  if (injected) {
    injected(level, event, fields);
    return;
  }
  try {
    writeRuntimeLog({ level, event, ...fields });
  } catch {
    // Runtime logging must never break the user-facing CLI command.
  }
}
