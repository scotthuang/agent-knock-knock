import {
  executeCliCommand,
  parseCliCommand,
  type CliCommandDependencies
} from "../src/cli-core.js";
import type {
  TerminalProcessSnapshot
} from "../src/terminal-agent-adapter.js";
import {
  createTerminalControlProviderRegistry,
  StaticTerminalControlProvider,
  type TerminalPane
} from "../src/terminal-control-provider.js";
import type { TerminalEndpointRef } from "../src/terminal-control-ref.js";
import {
  StaticTerminalProcessSource,
  type TerminalProcessSource
} from "../src/terminal-process-source.js";

export interface InProcessCliResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

class InProcessCliExit extends Error {
  constructor(readonly exitCode: number) {
    super(`CLI requested exit ${exitCode}`);
    this.name = "InProcessCliExit";
  }
}

/**
 * Execute the same parsed command core as the bin entry without touching
 * process argv/stdout/exit. Thrown command errors are projected like the real
 * executable so a migrated test can retain its existing status/stderr checks.
 */
export async function runInProcessCli(
  argv: readonly string[],
  dependencies: CliCommandDependencies = {}
): Promise<InProcessCliResult> {
  const { command, options } = parseCliCommand(argv);
  try {
    const result = await executeCliCommand(command, options, {
      ...dependencies,
      exit: dependencies.exit ?? ((code): never => {
        throw new InProcessCliExit(code);
      })
    });
    return {
      status: result.exitCode,
      stdout: result.stdout,
      stderr: ""
    };
  } catch (error) {
    if (error instanceof InProcessCliExit) {
      return {
        status: error.exitCode,
        stdout: "",
        stderr: ""
      };
    }
    const normalized = error instanceof Error
      ? error
      : new Error(String(error));
    return {
      status: 1,
      stdout: "",
      stderr: `${normalized.message}\n`,
      error: normalized
    };
  }
}

export type RecordedTerminalOperation =
  | {
      kind: "capture";
      target: string;
      scrollbackLines?: number;
      preserveEscapes?: boolean;
    }
  | { kind: "text"; target: string; text: string }
  | { kind: "keys"; target: string; keys: string[] };

export interface MutableTerminalHooks {
  capture?: (
    operation: Extract<RecordedTerminalOperation, { kind: "capture" }>,
    provider: MutableRecordingTerminalProvider
  ) => string | undefined | Promise<string | undefined>;
  sendText?: (
    operation: Extract<RecordedTerminalOperation, { kind: "text" }>,
    provider: MutableRecordingTerminalProvider
  ) => void | Promise<void>;
  sendKeys?: (
    operation: Extract<RecordedTerminalOperation, { kind: "keys" }>,
    provider: MutableRecordingTerminalProvider
  ) => void | Promise<void>;
}

/**
 * Stateful test transport built on the production static provider contract.
 * Hooks model only observable terminal effects; all adapter parsing, identity
 * checks, and bridge sequencing still execute in production code.
 */
export class MutableRecordingTerminalProvider
  extends StaticTerminalControlProvider {
  readonly operations: RecordedTerminalOperation[] = [];
  private readonly mutableScreens = new Map<string, string>();
  private hooks: MutableTerminalHooks;

  constructor(options: {
    panes: TerminalPane[];
    screens?: Record<string, string>;
    hooks?: MutableTerminalHooks;
  }) {
    super({ panes: options.panes, screens: options.screens });
    this.hooks = options.hooks ?? {};
    for (const [target, screen] of Object.entries(options.screens ?? {})) {
      this.mutableScreens.set(target, screen);
    }
  }

  setHooks(hooks: MutableTerminalHooks): void {
    this.hooks = hooks;
  }

  setScreen(target: string, screen: string): void {
    this.mutableScreens.set(target, screen);
  }

  screen(target: string): string {
    return this.mutableScreens.get(target) ?? "";
  }

  clearOperations(): void {
    this.operations.length = 0;
  }

  literalInputs(): string[] {
    return this.operations.flatMap((operation) =>
      operation.kind === "text" ? [operation.text] : []
    );
  }

  keyDispatches(): string[][] {
    return this.operations.flatMap((operation) =>
      operation.kind === "keys" ? [[...operation.keys]] : []
    );
  }

  override async capture(
    terminal: TerminalEndpointRef,
    options: {
      scrollbackLines?: number;
      preserveEscapes?: boolean;
    } = {}
  ): Promise<string> {
    const target = terminalTarget(terminal);
    const operation: Extract<
      RecordedTerminalOperation,
      { kind: "capture" }
    > = {
      kind: "capture",
      target,
      scrollbackLines: options.scrollbackLines,
      preserveEscapes: options.preserveEscapes
    };
    this.operations.push(operation);
    return (await this.hooks.capture?.(operation, this)) ?? this.screen(target);
  }

  override async sendText(
    terminal: TerminalEndpointRef,
    text: string
  ): Promise<void> {
    const operation = {
      kind: "text" as const,
      target: terminalTarget(terminal),
      text
    };
    this.operations.push(operation);
    await this.hooks.sendText?.(operation, this);
  }

  override async sendKeys(
    terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    const operation = {
      kind: "keys" as const,
      target: terminalTarget(terminal),
      keys: [...keys]
    };
    this.operations.push(operation);
    await this.hooks.sendKeys?.(operation, this);
  }
}

function terminalTarget(terminal: TerminalEndpointRef): string {
  const providerRef = terminal.providerRef as { target?: unknown };
  if (typeof providerRef.target !== "string" || !providerRef.target) {
    throw new Error("in-process terminal fixture requires a tmux target");
  }
  return providerRef.target;
}

export class MutableTerminalProcessSource implements TerminalProcessSource {
  private snapshots: TerminalProcessSnapshot[];
  readonly calls: Array<{
    includeCwd?: boolean;
    includeAncestors?: boolean;
  }> = [];

  constructor(snapshots: readonly TerminalProcessSnapshot[] = []) {
    this.snapshots = snapshots.map((snapshot) => ({ ...snapshot }));
  }

  setSnapshots(snapshots: readonly TerminalProcessSnapshot[]): void {
    this.snapshots = snapshots.map((snapshot) => ({ ...snapshot }));
  }

  async listProcessSnapshots(
    isCandidate: (snapshot: TerminalProcessSnapshot) => boolean = () => true,
    options: { includeCwd?: boolean; includeAncestors?: boolean } = {}
  ): Promise<TerminalProcessSnapshot[]> {
    this.calls.push({ ...options });
    return new StaticTerminalProcessSource(this.snapshots)
      .listProcessSnapshots(isCandidate, options);
  }
}

export class VirtualClock {
  private currentMs: number;
  readonly sleeps: number[] = [];

  constructor(start: Date | number | string = "2026-08-06T12:00:00.000Z") {
    this.currentMs = start instanceof Date
      ? start.getTime()
      : typeof start === "number"
        ? start
        : Date.parse(start);
    if (!Number.isFinite(this.currentMs)) {
      throw new Error("virtual clock start must be a valid timestamp");
    }
  }

  readonly now = (): Date => new Date(this.currentMs);

  readonly nowMs = (): number => this.currentMs;

  readonly sleep = async (milliseconds: number): Promise<void> => {
    this.advance(milliseconds);
  };

  readonly sleepSync = (milliseconds: number): void => {
    this.advance(milliseconds);
  };

  advance(milliseconds: number): void {
    const normalized = Math.max(0, Number(milliseconds));
    this.sleeps.push(normalized);
    this.currentMs += normalized;
  }
}

export function terminalCliDependencies(options: {
  terminalProvider: MutableRecordingTerminalProvider;
  processSource: TerminalProcessSource;
  clock?: VirtualClock;
  env?: NodeJS.ProcessEnv;
  overrides?: CliCommandDependencies;
}): CliCommandDependencies {
  const clock = options.clock ?? new VirtualClock();
  return {
    terminalControlProviderRegistry: createTerminalControlProviderRegistry([
      options.terminalProvider
    ]),
    terminalProcessSource: options.processSource,
    env: options.env,
    now: clock.now,
    monotonicNowMs: clock.nowMs,
    sleep: clock.sleep,
    sleepSync: clock.sleepSync,
    loadClaudeAgentRows: () => [],
    runtimeLog() {},
    ...options.overrides
  };
}
