import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  ActiveTerminalProcess,
  TerminalProcessSnapshot
} from "./terminal-agent-adapter.js";
import {
  createTerminalEndpointRef,
  sameTerminalControlIncarnation,
  sameTerminalEndpointIdentity,
  terminalControlWithCapabilities,
  terminalEndpointFromControlRef,
  tmuxTerminalRouteKey,
  type TerminalControlCapability,
  type TerminalControlRef,
  type TerminalEndpointRef,
  type TerminalProviderCapability,
  type TmuxTerminalControlRef
} from "./terminal-control-ref.js";

export interface TerminalPane {
  kind: "tmux";
  target: string;
  socketPath?: string;
  serverSocketPath?: string;
  paneId?: string;
  session: string;
  window: number;
  pane: number;
  panePid: number;
  currentCommand?: string;
  currentPath?: string;
  columns?: number;
  rows?: number;
}

export interface TerminalViewport {
  columns: number;
  rows: number;
}

export type TerminalDiscoveryDiagnosticLog = (
  event: string,
  fields: Readonly<Record<string, unknown>>
) => void;

export interface TerminalControlProvider {
  readonly kind: string;
  readonly supportedCapabilities: readonly TerminalControlCapability[];
  readonly providerCapabilities: readonly TerminalProviderCapability[];
  diagnostics(): Promise<Record<string, unknown>>;
  listTerminals(): Promise<TerminalEndpointRef[]>;
  endpoint(terminalControl: TerminalControlRef): TerminalEndpointRef;
  toControlRef(
    terminal: TerminalEndpointRef,
    capabilities?: readonly TerminalControlCapability[]
  ): TerminalControlRef;
  resolve(terminal: TerminalEndpointRef): Promise<TerminalEndpointRef>;
  inspectViewport?(
    terminal: TerminalEndpointRef
  ): Promise<TerminalViewport | undefined>;
  containsProcess(
    terminal: TerminalEndpointRef,
    process: Pick<TerminalProcessSnapshot, "pid" | "ppid">,
    processes: readonly Pick<TerminalProcessSnapshot, "pid" | "ppid">[]
  ): boolean;
  capture(terminal: TerminalEndpointRef, options?: {
    scrollbackLines?: number;
    preserveEscapes?: boolean;
  }): Promise<string>;
  sendText(terminal: TerminalEndpointRef, text: string): Promise<void>;
  sendKeys(terminal: TerminalEndpointRef, keys: readonly string[]): Promise<void>;
}

export class TerminalControlProviderRegistry {
  private readonly providers = new Map<string, TerminalControlProvider>();
  private facade?: TerminalControlProvider;

  constructor(
    providers: readonly TerminalControlProvider[] = [],
    private readonly diagnosticLog?: TerminalDiscoveryDiagnosticLog
  ) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: TerminalControlProvider): this {
    if (!provider.kind.trim()) {
      throw new Error("terminal control provider kind is required");
    }
    if (this.providers.has(provider.kind)) {
      throw new Error(
        `terminal control provider is already registered for ${provider.kind}`
      );
    }
    this.providers.set(provider.kind, provider);
    return this;
  }

  get(kind: string): TerminalControlProvider | undefined {
    return this.providers.get(kind);
  }

  require(kind: string): TerminalControlProvider {
    const provider = this.get(kind);
    if (!provider) {
      throw new Error(
        `terminal control provider is not registered for ${kind || "<empty>"}`
      );
    }
    return provider;
  }

  list(): TerminalControlProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Exposes all registered providers through the same provider boundary used
   * by the terminal bridge. Discovery is aggregated, while every operation on
   * an existing endpoint is dispatched only to that endpoint's provider.
   *
   * The facade advertises only capabilities shared by every registered
   * provider. This keeps generic preflight checks conservative; the selected
   * provider still performs its own endpoint-specific checks when dispatched.
   */
  asProvider(): TerminalControlProvider {
    this.facade ??= new RegistryTerminalControlProvider(
      () => this.list(),
      this.diagnosticLog
    );
    return this.facade;
  }
}

class RegistryTerminalControlProvider implements TerminalControlProvider {
  readonly kind = "registry";
  private readonly discoveryErrors = new Map<string, string>();

  constructor(
    private readonly registeredProviders: () => TerminalControlProvider[],
    private readonly diagnosticLog?: TerminalDiscoveryDiagnosticLog
  ) {}

  get supportedCapabilities(): readonly TerminalControlCapability[] {
    return intersectRegisteredCapabilities(
      this.registeredProviders(),
      (provider) => provider.supportedCapabilities
    );
  }

  get providerCapabilities(): readonly TerminalProviderCapability[] {
    return intersectRegisteredCapabilities(
      this.registeredProviders(),
      (provider) => provider.providerCapabilities
    );
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const providers = this.registeredProviders();
    const diagnostics = await Promise.all(providers.map(async (provider) => {
      try {
        return [provider.kind, await provider.diagnostics()] as const;
      } catch (error) {
        return [provider.kind, {
          provider: provider.kind,
          status: "error",
          error: terminalProviderErrorMessage(error)
        }] as const;
      }
    }));
    return {
      provider: this.kind,
      providerKinds: providers.map((provider) => provider.kind),
      providers: Object.fromEntries(diagnostics),
      discoveryErrors: Object.fromEntries(this.discoveryErrors)
    };
  }

  async listTerminals(): Promise<TerminalEndpointRef[]> {
    const batches = await Promise.all(
      this.registeredProviders().map(async (provider) => {
        try {
          const terminals = await provider.listTerminals();
          for (const terminal of terminals) {
            assertEndpointKind(terminal, provider.kind);
          }
          this.discoveryErrors.delete(provider.kind);
          emitTerminalDiscoveryDiagnostic(
            this.diagnosticLog,
            "terminal_control_provider_discovery",
            {
              provider: provider.kind,
              status: "available",
              terminal_count: terminals.length,
              terminals: terminals.map(terminalEndpointDiagnostic)
            }
          );
          return terminals;
        } catch (error) {
          // A provider that cannot prove its own endpoints must contribute no
          // candidates, but it must not make a different healthy transport
          // disappear. Keep the last failure visible through diagnostics.
          this.discoveryErrors.set(
            provider.kind,
            terminalProviderErrorMessage(error)
          );
          emitTerminalDiscoveryDiagnostic(
            this.diagnosticLog,
            "terminal_control_provider_discovery",
            {
              provider: provider.kind,
              status: "error",
              error_name: error instanceof Error ? error.name : undefined,
              error: terminalProviderErrorMessage(error)
            }
          );
          return [];
        }
      })
    );
    return batches.flat();
  }

  endpoint(terminalControl: TerminalControlRef): TerminalEndpointRef {
    const provider = this.requireProvider(terminalControl.kind);
    const terminal = provider.endpoint(terminalControl);
    assertEndpointKind(terminal, provider.kind);
    return terminal;
  }

  toControlRef(
    terminal: TerminalEndpointRef,
    capabilities?: readonly TerminalControlCapability[]
  ): TerminalControlRef {
    const provider = this.providerForEndpoint(terminal);
    const control = provider.toControlRef(terminal, capabilities);
    if (control.kind !== provider.kind) {
      throw new Error(
        `terminal control provider ${provider.kind} returned control for ` +
        `${control.kind}`
      );
    }
    return control;
  }

  async resolve(terminal: TerminalEndpointRef): Promise<TerminalEndpointRef> {
    const provider = this.providerForEndpoint(terminal);
    const resolved = await provider.resolve(terminal);
    assertEndpointKind(resolved, provider.kind);
    return resolved;
  }

  async inspectViewport(
    terminal: TerminalEndpointRef
  ): Promise<TerminalViewport | undefined> {
    const provider = this.providerForEndpoint(terminal);
    return provider.inspectViewport
      ? provider.inspectViewport(terminal)
      : undefined;
  }

  containsProcess(
    terminal: TerminalEndpointRef,
    process: Pick<TerminalProcessSnapshot, "pid" | "ppid">,
    processes: readonly Pick<TerminalProcessSnapshot, "pid" | "ppid">[]
  ): boolean {
    return this.providerForEndpoint(terminal).containsProcess(
      terminal,
      process,
      processes
    );
  }

  capture(terminal: TerminalEndpointRef, options: {
    scrollbackLines?: number;
    preserveEscapes?: boolean;
  } = {}): Promise<string> {
    return this.providerForEndpoint(terminal).capture(terminal, options);
  }

  sendText(terminal: TerminalEndpointRef, text: string): Promise<void> {
    return this.providerForEndpoint(terminal).sendText(terminal, text);
  }

  sendKeys(
    terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    return this.providerForEndpoint(terminal).sendKeys(terminal, keys);
  }

  private providerForEndpoint(
    terminal: TerminalEndpointRef
  ): TerminalControlProvider {
    return this.requireProvider(terminal.identity.providerKind);
  }

  private requireProvider(kind: string): TerminalControlProvider {
    const provider = this.registeredProviders().find(
      (candidate) => candidate.kind === kind
    );
    if (!provider) {
      throw new Error(
        `terminal control provider is not registered for ${kind || "<empty>"}`
      );
    }
    return provider;
  }
}

function terminalProviderErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function intersectRegisteredCapabilities<T extends string>(
  providers: readonly TerminalControlProvider[],
  capabilities: (provider: TerminalControlProvider) => readonly T[]
): T[] {
  const [first, ...rest] = providers;
  if (!first) {
    return [];
  }
  return [...new Set(capabilities(first))].filter((capability) =>
    rest.every((provider) => capabilities(provider).includes(capability))
  );
}

export function createTerminalControlProviderRegistry(
  providers: readonly TerminalControlProvider[] = [],
  diagnosticLog?: TerminalDiscoveryDiagnosticLog
): TerminalControlProviderRegistry {
  return new TerminalControlProviderRegistry(providers, diagnosticLog);
}

function terminalEndpointDiagnostic(
  terminal: TerminalEndpointRef
): Record<string, unknown> {
  return {
    provider: terminal.identity.providerKind,
    endpoint_key: terminal.identity.endpointKey,
    resource_key: terminal.identity.resourceKey,
    route: terminal.route.label,
    process_anchor_pid: terminal.processAnchorPid
  };
}

function emitTerminalDiscoveryDiagnostic(
  diagnosticLog: TerminalDiscoveryDiagnosticLog | undefined,
  event: string,
  fields: Readonly<Record<string, unknown>>
): void {
  try {
    diagnosticLog?.(event, fields);
  } catch {
    // Diagnostics must never change terminal discovery behavior.
  }
}

/**
 * Stable-resource resolution found no controllable instance of the requested
 * terminal endpoint. Ambiguity, identity drift, malformed provider data, and
 * transport integrity failures must use another error and remain fail-closed.
 */
export class TerminalControlUnavailableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "TerminalControlUnavailableError";
  }
}

/**
 * A provider-level failure proving that no terminal input operation succeeded.
 * Unknown/time-out outcomes must use an ordinary Error instead.
 */
export class TerminalControlInputNotSentError extends Error {
  readonly code = "AKK_TERMINAL_INPUT_NOT_SENT";

  constructor(message: string) {
    super(message);
    this.name = "TerminalControlInputNotSentError";
  }
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface TmuxTerminalControlDiagnostics {
  commands: string[];
  socketPaths: string[];
  attempts: Array<{
    command: string;
    socketPath?: string;
    status: number | null;
    stdoutBytes: number;
    stdoutPreview?: string;
    stderr?: string;
    error?: string;
    paneCount: number;
  }>;
  paneCount: number;
  panes: TerminalPane[];
}

export class TmuxTerminalControlProvider implements TerminalControlProvider {
  readonly kind = "tmux";
  readonly supportedCapabilities: readonly TerminalControlCapability[] = [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "screen_completion",
    "durable_completion",
    "terminal_cancel"
  ];
  readonly providerCapabilities: readonly TerminalProviderCapability[] = [
    "screen_capture",
    "ansi_capture",
    "text_delivery",
    "key_delivery",
    "process_inspection",
    "stable_resource_resolution"
  ];
  private readonly runCommand: (command: string, args: string[]) => CommandResult;
  private readonly socketPaths: string[];
  private readonly commands: string[];

  constructor(options: {
    runCommand?: (command: string, args: string[]) => CommandResult;
    socketPaths?: string[];
    commands?: string[];
  } = {}) {
    this.runCommand = options.runCommand ?? runCommand;
    this.socketPaths = options.socketPaths ?? defaultTmuxSocketPaths();
    this.commands = uniqueStrings(options.commands ?? defaultTmuxCommands());
  }

  async listPanes(): Promise<TerminalPane[]> {
    return (await this.diagnose()).panes;
  }

  async listTerminals(): Promise<TerminalEndpointRef[]> {
    return (await this.listPanes()).map((pane) =>
      tmuxEndpointFromPane(pane, this.supportedCapabilities)
    );
  }

  endpoint(terminalControl: TerminalControlRef): TerminalEndpointRef {
    if (terminalControl.kind !== this.kind) {
      throw new Error(
        `terminal control provider ${this.kind} cannot resolve ${terminalControl.kind}`
      );
    }
    return terminalEndpointFromControlRef(terminalControl);
  }

  toControlRef(
    terminal: TerminalEndpointRef,
    capabilities: readonly TerminalControlCapability[] = terminal.capabilities
  ): TerminalControlRef {
    const control = tmuxControlFromEndpoint(terminal);
    return terminalControlWithCapabilities(
      control,
      intersectCapabilities(capabilities, this.supportedCapabilities)
    );
  }

  async resolve(terminal: TerminalEndpointRef): Promise<TerminalEndpointRef> {
    assertProviderCapability(
      this.kind,
      this.providerCapabilities,
      "stable_resource_resolution"
    );
    assertEndpointKind(terminal, this.kind);
    const matches = (await this.listTerminals()).filter((candidate) =>
      sameTerminalEndpointIdentity(candidate, terminal) ||
      legacyTmuxEndpointMatches(candidate, terminal)
    );
    if (matches.length === 0) {
      throw new TerminalControlUnavailableError(
        `terminal resource ${terminal.route.label} is no longer available`
      );
    }
    if (matches.length !== 1) {
      throw new Error(
        `terminal resource ${terminal.route.label} is ambiguous`
      );
    }
    return endpointWithCapabilities(
      matches[0],
      intersectCapabilities(
        terminal.capabilities,
        this.supportedCapabilities
      )
    );
  }

  containsProcess(
    terminal: TerminalEndpointRef,
    process: Pick<TerminalProcessSnapshot, "pid" | "ppid">,
    processes: readonly Pick<TerminalProcessSnapshot, "pid" | "ppid">[]
  ): boolean {
    assertProviderCapability(
      this.kind,
      this.providerCapabilities,
      "process_inspection"
    );
    return terminalPaneContainsProcess(
      process,
      tmuxPaneFromEndpoint(terminal),
      processes
    );
  }

  async diagnose(): Promise<TmuxTerminalControlDiagnostics> {
    const panes: TerminalPane[] = [];
    const diagnosticAttempts: TmuxTerminalControlDiagnostics["attempts"] = [];
    const seenTargets = new Set<string>();
    const attempts: (string | undefined)[] = [undefined, ...this.socketPaths];
    for (const command of this.commands) {
      for (const socketPath of attempts) {
        const result = this.runCommand(command, tmuxArgs(socketPath, [
          "list-panes",
          "-a",
          "-F",
          "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{socket_path}\t#{pane_id}"
        ]));
        const parsedPanes = result.status === 0 ? parseTmuxListPanes(result.stdout, socketPath) : [];
        diagnosticAttempts.push({
          command,
          socketPath,
          status: result.status,
          stdoutBytes: (result.stdout ?? "").length,
          stdoutPreview: cleanDiagnosticText(result.stdout),
          stderr: cleanDiagnosticText(result.stderr),
          error: cleanDiagnosticText(result.error?.message),
          paneCount: parsedPanes.length
        });
        if (result.status !== 0) {
          continue;
        }
        for (const pane of parsedPanes) {
          // A default-server query and its discovered socket path can describe
          // the same pane. Prefer tmux's server-scoped stable pane identity; the
          // complete legacy route+PID tuple is the safe fallback for old tmux.
          const key = pane.serverSocketPath && pane.paneId
            ? `${pane.serverSocketPath}\t${pane.paneId}`
            : `${pane.target}\t${pane.panePid}`;
          if (seenTargets.has(key)) {
            continue;
          }
          seenTargets.add(key);
          panes.push(pane);
        }
      }
    }
    return {
      commands: this.commands,
      socketPaths: this.socketPaths,
      attempts: diagnosticAttempts,
      paneCount: panes.length,
      panes
    };
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    return this.diagnose() as unknown as Record<string, unknown>;
  }

  async capture(terminal: TerminalEndpointRef, options: {
    scrollbackLines?: number;
    preserveEscapes?: boolean;
  } = {}): Promise<string> {
    assertTerminalCapability(
      terminal,
      "screen_status",
      this.supportedCapabilities
    );
    assertProviderCapability(
      this.kind,
      this.providerCapabilities,
      options.preserveEscapes ? "ansi_capture" : "screen_capture"
    );
    const { target, socketPath } = tmuxIoRoute(terminal);
    const scrollbackLines = Math.max(0, Math.floor(options.scrollbackLines ?? 200));
    let lastResult: CommandResult | undefined;
    for (const command of this.commands) {
      const result = this.runCommand(command, tmuxArgs(socketPath, [
        "capture-pane",
        ...(options.preserveEscapes ? ["-e"] : []),
        "-t",
        target,
        "-p",
        "-S",
        `-${scrollbackLines}`
      ]));
      if (result.status === 0) {
        return result.stdout;
      }
      lastResult = result;
    }
    throw new Error(lastResult?.stderr || lastResult?.error?.message || `tmux capture-pane failed for ${target}`);
  }

  async inspectViewport(
    terminal: TerminalEndpointRef
  ): Promise<TerminalViewport | undefined> {
    const resolved = await this.resolve(terminal);
    if (!sameTerminalControlIncarnation(terminal, resolved)) {
      throw new Error(
        "tmux terminal stable resource or process anchor changed before viewport inspection"
      );
    }
    const stablePaneId = resolved.identity.resourceKey.startsWith("pane-id:")
      ? resolved.identity.resourceKey.slice("pane-id:".length)
      : undefined;
    if (!stablePaneId || !/^%\d+$/u.test(stablePaneId)) {
      return undefined;
    }
    const { socketPath } = tmuxIoRoute(resolved);
    let lastResult: CommandResult | undefined;
    for (const command of this.commands) {
      const result = this.runCommand(command, tmuxArgs(socketPath, [
        "display-message",
        "-p",
        "-t",
        stablePaneId,
        "#{pane_width}\t#{pane_height}"
      ]));
      if (result.status === 0) {
        return parseTmuxViewport(result.stdout, resolved.route.label);
      }
      lastResult = result;
    }
    throw new Error(
      lastResult?.stderr || lastResult?.error?.message ||
      `tmux display-message failed for ${stablePaneId}`
    );
  }

  async sendKeys(
    terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    assertTerminalCapability(
      terminal,
      "send_keys",
      this.supportedCapabilities
    );
    assertInputProviderCapability(
      this.kind,
      this.providerCapabilities,
      "key_delivery"
    );
    const { target, socketPath } = tmuxIoRoute(terminal);
    let lastResult: CommandResult | undefined;
    for (const command of this.commands) {
      const result = this.runCommand(command, tmuxArgs(socketPath, ["send-keys", "-t", target, ...keys]));
      if (result.status === 0) {
        return;
      }
      if (result.status !== null) {
        // The tmux process ran. Even a non-zero response is not a safe reason
        // to invoke a second executable for an irreversible key such as Enter.
        throw new TerminalControlInputNotSentError(
          result.stderr || result.error?.message ||
          `tmux send-keys failed for ${target}`
        );
      }
      if (!commandDefinitelyDidNotStart(result.error)) {
        // A timeout or signal after spawn may already have delivered the key.
        // Retrying here could turn one requested Enter into two submissions.
        throw new Error(
          result.stderr || result.error?.message ||
          `tmux send-keys outcome is uncertain for ${target}`
        );
      }
      lastResult = result;
    }
    throw new TerminalControlInputNotSentError(
      lastResult?.stderr || lastResult?.error?.message ||
      `tmux send-keys failed for ${target}`
    );
  }

  async sendText(
    terminal: TerminalEndpointRef,
    text: string
  ): Promise<void> {
    assertTerminalCapability(
      terminal,
      "send_keys",
      this.supportedCapabilities
    );
    assertInputProviderCapability(
      this.kind,
      this.providerCapabilities,
      "text_delivery"
    );
    const { target, socketPath } = tmuxIoRoute(terminal);
    let lastResult: CommandResult | undefined;
    for (const command of this.commands) {
      if (/[\r\n]/u.test(text)) {
        const bufferName = `akk-${process.pid}-${randomUUID()}`;
        const setBuffer = this.runCommand(command, tmuxArgs(socketPath, [
          "set-buffer",
          "-b",
          bufferName,
          "--",
          text
        ]));
        if (setBuffer.status !== 0) {
          lastResult = setBuffer;
          continue;
        }
        const pasteBuffer = this.runCommand(command, tmuxArgs(socketPath, [
          "paste-buffer",
          "-p",
          "-d",
          "-b",
          bufferName,
          "-t",
          target
        ]));
        if (pasteBuffer.status === 0) {
          return;
        }
        this.runCommand(command, tmuxArgs(socketPath, [
          "delete-buffer",
          "-b",
          bufferName
        ]));
        if (
          pasteBuffer.status !== null ||
          !commandDefinitelyDidNotStart(pasteBuffer.error)
        ) {
          throw new Error(
            pasteBuffer.stderr || pasteBuffer.error?.message ||
            `tmux terminal paste outcome is uncertain for ${target}`
          );
        }
        lastResult = pasteBuffer;
        continue;
      }
      const result = this.runCommand(command, tmuxArgs(socketPath, ["send-keys", "-t", target, "-l", text]));
      if (result.status === 0) {
        return;
      }
      if (
        result.status === null &&
        !commandDefinitelyDidNotStart(result.error)
      ) {
        // A timeout or signal after spawn may already have delivered input.
        // Do not try another tmux executable and risk injecting it twice.
        throw new Error(
          result.stderr || result.error?.message ||
          `tmux terminal input outcome is uncertain for ${target}`
        );
      }
      lastResult = result;
    }
    const message = lastResult?.stderr || lastResult?.error?.message ||
      `tmux terminal paste failed for ${target}`;
    throw new TerminalControlInputNotSentError(message);
  }
}

function commandDefinitelyDidNotStart(error: Error | undefined): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "ENOTDIR";
}

function parseTmuxViewport(
  output: string,
  terminalLabel: string
): TerminalViewport | undefined {
  const value = output.trim();
  if (!value) {
    return undefined;
  }
  const match = /^(\d+)\t(\d+)$/u.exec(value);
  const columns = match ? positiveSafeInteger(Number(match[1])) : undefined;
  const rows = match ? positiveSafeInteger(Number(match[2])) : undefined;
  if (!columns || !rows) {
    throw new Error(
      `tmux display-message returned an invalid viewport for ${terminalLabel}`
    );
  }
  return { columns, rows };
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export class StaticTerminalControlProvider implements TerminalControlProvider {
  readonly kind = "tmux";
  readonly supportedCapabilities: readonly TerminalControlCapability[] = [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "screen_completion",
    "durable_completion",
    "terminal_cancel"
  ];
  readonly providerCapabilities: readonly TerminalProviderCapability[] = [
    "screen_capture",
    "ansi_capture",
    "text_delivery",
    "key_delivery",
    "process_inspection",
    "stable_resource_resolution"
  ];
  private readonly panes: TerminalPane[];
  private readonly screens: Map<string, string>;
  readonly sentKeys: { target: string; keys: string[] }[] = [];

  constructor(options: { panes?: TerminalPane[]; screens?: Record<string, string> } = {}) {
    this.panes = options.panes ?? [];
    this.screens = new Map(Object.entries(options.screens ?? {}));
  }

  async listPanes(): Promise<TerminalPane[]> {
    return this.panes;
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    return {
      provider: "static",
      paneCount: (await this.listTerminals()).length
    };
  }

  async listTerminals(): Promise<TerminalEndpointRef[]> {
    return this.panes.map((pane) =>
      tmuxEndpointFromPane(pane, this.supportedCapabilities)
    );
  }

  endpoint(terminalControl: TerminalControlRef): TerminalEndpointRef {
    if (terminalControl.kind !== this.kind) {
      throw new Error(
        `terminal control provider ${this.kind} cannot resolve ${terminalControl.kind}`
      );
    }
    return terminalEndpointFromControlRef(terminalControl);
  }

  toControlRef(
    terminal: TerminalEndpointRef,
    capabilities: readonly TerminalControlCapability[] = terminal.capabilities
  ): TerminalControlRef {
    return terminalControlWithCapabilities(
      tmuxControlFromEndpoint(terminal),
      intersectCapabilities(capabilities, this.supportedCapabilities)
    );
  }

  async resolve(terminal: TerminalEndpointRef): Promise<TerminalEndpointRef> {
    assertProviderCapability(
      this.kind,
      this.providerCapabilities,
      "stable_resource_resolution"
    );
    assertEndpointKind(terminal, this.kind);
    const matches = (await this.listTerminals()).filter((candidate) =>
      sameTerminalEndpointIdentity(candidate, terminal) ||
      legacyTmuxEndpointMatches(candidate, terminal)
    );
    if (matches.length === 0) {
      throw new TerminalControlUnavailableError(
        `terminal resource ${terminal.route.label} is no longer available`
      );
    }
    if (matches.length !== 1) {
      throw new Error(
        `terminal resource ${terminal.route.label} is ambiguous`
      );
    }
    return endpointWithCapabilities(
      matches[0],
      intersectCapabilities(
        terminal.capabilities,
        this.supportedCapabilities
      )
    );
  }

  containsProcess(
    terminal: TerminalEndpointRef,
    process: Pick<TerminalProcessSnapshot, "pid" | "ppid">,
    processes: readonly Pick<TerminalProcessSnapshot, "pid" | "ppid">[]
  ): boolean {
    assertProviderCapability(
      this.kind,
      this.providerCapabilities,
      "process_inspection"
    );
    return terminalPaneContainsProcess(
      process,
      tmuxPaneFromEndpoint(terminal),
      processes
    );
  }

  async capture(terminal: TerminalEndpointRef): Promise<string> {
    assertTerminalCapability(
      terminal,
      "screen_status",
      this.supportedCapabilities
    );
    assertProviderCapability(
      this.kind,
      this.providerCapabilities,
      "screen_capture"
    );
    const { target } = tmuxControlFromEndpoint(terminal);
    return this.screens.get(target) ?? "";
  }

  async inspectViewport(
    terminal: TerminalEndpointRef
  ): Promise<TerminalViewport | undefined> {
    const resolved = await this.resolve(terminal);
    if (!sameTerminalControlIncarnation(terminal, resolved)) {
      throw new Error(
        "static terminal stable resource or process anchor changed before viewport inspection"
      );
    }
    const matches = this.panes.filter((pane) =>
      sameTerminalEndpointIdentity(
        tmuxEndpointFromPane(pane, this.supportedCapabilities),
        resolved
      )
    );
    if (matches.length !== 1) {
      throw new Error(
        `static terminal viewport identity is ${matches.length === 0 ? "missing" : "ambiguous"}`
      );
    }
    const columns = positiveSafeInteger(matches[0].columns);
    const rows = positiveSafeInteger(matches[0].rows);
    return columns && rows ? { columns, rows } : undefined;
  }

  async sendText(
    terminal: TerminalEndpointRef,
    text: string
  ): Promise<void> {
    assertTerminalCapability(
      terminal,
      "send_keys",
      this.supportedCapabilities
    );
    assertInputProviderCapability(
      this.kind,
      this.providerCapabilities,
      "text_delivery"
    );
    const { target } = tmuxControlFromEndpoint(terminal);
    this.sentKeys.push({ target, keys: ["-l", text] });
  }

  async sendKeys(
    terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    assertTerminalCapability(
      terminal,
      "send_keys",
      this.supportedCapabilities
    );
    assertInputProviderCapability(
      this.kind,
      this.providerCapabilities,
      "key_delivery"
    );
    const { target } = tmuxControlFromEndpoint(terminal);
    this.sentKeys.push({ target, keys: [...keys] });
  }
}

export function parseTmuxListPanes(output: string, socketPath?: string): TerminalPane[] {
  const panes: TerminalPane[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseTmuxPaneLine(line, socketPath);
    if (!parsed) {
      continue;
    }
    panes.push({
      kind: "tmux" as const,
      target: `${parsed.session}:${parsed.window}.${parsed.pane}`,
      socketPath,
      ...parsed
    });
  }
  return panes;
}

function parseTmuxPaneLine(
  line: string,
  socketPath?: string
): Omit<TerminalPane, "kind" | "target" | "socketPath"> | undefined {
  const tabFields = line.split("\t");
  const fields = tabFields.length >= 8
    ? [
        tabFields[0],
        tabFields[1],
        tabFields[2],
        tabFields[3],
        tabFields[4],
        tabFields.slice(5, -2).join("\t"),
        tabFields.at(-2) ?? "",
        tabFields.at(-1) ?? ""
      ]
    : tabFields.length === 6
      ? tabFields
      : tabFields.length > 1
        ? undefined
        : parseWhitespaceTmuxPaneLine(line, socketPath) ??
          parseUnderscoreTmuxPaneLine(line, socketPath);
  if (!fields) {
    return undefined;
  }

  const [
    session,
    windowIndex,
    paneIndex,
    panePid,
    currentCommand,
    currentPath,
    serverSocketPath,
    paneId
  ] = fields;
  const window = Number(windowIndex);
  const pane = Number(paneIndex);
  const parsedPanePid = Number(panePid);
  if (!session || !Number.isInteger(window) || !Number.isInteger(pane) || !Number.isInteger(parsedPanePid)) {
    return undefined;
  }
  return {
    session,
    window,
    pane,
    panePid: parsedPanePid,
    currentCommand: currentCommand || undefined,
    currentPath: currentPath || undefined,
    serverSocketPath: serverSocketPath || undefined,
    paneId: paneId || undefined
  };
}

function parseWhitespaceTmuxPaneLine(line: string, socketPath?: string): string[] | undefined {
  const trimmed = line.trim();
  const paneIdMatch = /\s+(%\d+)$/u.exec(trimmed);
  if (paneIdMatch) {
    // As with underscore-collapsed output below, an eight-field whitespace
    // line is ambiguous unless it ends in the exact socket used by this
    // query. Paths on either side of that boundary may contain whitespace.
    if (!socketPath) {
      return undefined;
    }
    const paneId = paneIdMatch[1];
    const beforePane = trimmed.slice(0, paneIdMatch.index).trimEnd();
    if (!beforePane.endsWith(socketPath)) {
      return undefined;
    }
    const socketStart = beforePane.length - socketPath.length;
    if (
      socketStart < 1 ||
      !/\s/u.test(beforePane[socketStart - 1])
    ) {
      return undefined;
    }
    const legacyFields = parseLegacyWhitespaceTmuxPaneLine(
      beforePane.slice(0, socketStart).trimEnd()
    );
    return legacyFields ? [...legacyFields, socketPath, paneId] : undefined;
  }
  return parseLegacyWhitespaceTmuxPaneLine(trimmed);
}

function parseLegacyWhitespaceTmuxPaneLine(line: string): string[] | undefined {
  const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
  return match ? match.slice(1) : undefined;
}

function parseUnderscoreTmuxPaneLine(line: string, socketPath?: string): string[] | undefined {
  const trimmed = line.trim();
  const paneIdMatch = /_(%\d+)$/u.exec(trimmed);
  if (paneIdMatch) {
    // Some command runners collapse tmux's tab-delimited output into
    // underscores. The current eight-field format is only unambiguous when
    // the exact socket used for this query is known: both pane_current_path
    // and socket_path may themselves contain underscores. Never fall back to
    // the legacy six-field parser for an extended-looking line, because that
    // would silently append the socket and pane ID to the working directory.
    if (!socketPath) {
      return undefined;
    }
    const paneId = paneIdMatch[1];
    const suffix = `_${socketPath}_${paneId}`;
    if (!trimmed.endsWith(suffix)) {
      return undefined;
    }
    const legacyFields = parseLegacyUnderscoreTmuxPaneLine(
      trimmed.slice(0, -suffix.length)
    );
    return legacyFields ? [...legacyFields, socketPath, paneId] : undefined;
  }
  return parseLegacyUnderscoreTmuxPaneLine(trimmed);
}

function parseLegacyUnderscoreTmuxPaneLine(line: string): string[] | undefined {
  const match = /^(.+)_(\d+)_(\d+)_(\d+)_([^_]+)_(.+?)\s*$/u.exec(line);
  return match ? match.slice(1) : undefined;
}

export async function enrichActiveProcessesWithTerminalControl<T extends ActiveTerminalProcess>(
  processes: T[],
  provider: TerminalControlProvider,
  options: {
    capabilities?: readonly TerminalControlCapability[];
    processTree?: readonly TerminalProcessSnapshot[];
    diagnosticLog?: TerminalDiscoveryDiagnosticLog;
  } = {}
): Promise<T[]> {
  const terminals = await provider.listTerminals();
  if (terminals.length === 0) {
    for (const process of processes) {
      emitTerminalDiscoveryDiagnostic(
        options.diagnosticLog,
        "terminal_process_association",
        {
          agent: process.agent,
          pid: process.pid,
          ppid: process.ppid,
          terminal_count: 0,
          matching_terminal_count: 0,
          result: "no_terminal_candidates",
          process_ancestry: processAncestryDiagnostic(process, options.processTree)
        }
      );
    }
    return processes;
  }

  const matches = new Map<number, TerminalEndpointRef>();
  const processTree = options.processTree ?? processes;
  for (const process of processes) {
    const candidateObservations = terminals.map((candidate) => ({
      terminal: candidate,
      contains_process: provider.containsProcess(candidate, process, processTree)
    }));
    const matchingTerminals = candidateObservations
      .filter((candidate) => candidate.contains_process)
      .map((candidate) => candidate.terminal);
    emitTerminalDiscoveryDiagnostic(
      options.diagnosticLog,
      "terminal_process_association",
      {
        agent: process.agent,
        pid: process.pid,
        ppid: process.ppid,
        terminal_count: terminals.length,
        matching_terminal_count: matchingTerminals.length,
        result: matchingTerminals.length === 1
          ? "matched"
          : matchingTerminals.length === 0
            ? "no_match"
            : "ambiguous",
        process_ancestry: processAncestryDiagnostic(process, processTree),
        candidates: candidateObservations.map(({ terminal, contains_process }) => ({
          ...terminalEndpointDiagnostic(terminal),
          contains_process
        }))
      }
    );
    // Never guess when nested/multiple terminal providers both contain the
    // same process. A wrong match would grant control over an unrelated route.
    if (matchingTerminals.length !== 1) {
      continue;
    }
    matches.set(process.pid, matchingTerminals[0]);
  }

  return processes.map((process) => {
    const terminal = matches.get(process.pid);
    if (!terminal) {
      return process;
    }
    return {
      ...process,
      terminalControl: provider.toControlRef(
        terminal,
        options.capabilities ?? ["screen_status", "send_keys"]
      )
    } as T;
  });
}

function processAncestryDiagnostic(
  process: Pick<TerminalProcessSnapshot, "pid" | "ppid">,
  processTree: readonly Pick<TerminalProcessSnapshot, "pid" | "ppid">[] = []
): Array<{ pid: number; ppid?: number }> {
  const byPid = new Map(processTree.map((candidate) => [candidate.pid, candidate]));
  const ancestry: Array<{ pid: number; ppid?: number }> = [];
  const seen = new Set<number>();
  let current: Pick<TerminalProcessSnapshot, "pid" | "ppid"> | undefined = process;
  while (current && !seen.has(current.pid)) {
    ancestry.push({ pid: current.pid, ppid: current.ppid });
    seen.add(current.pid);
    current = current.ppid === undefined ? undefined : byPid.get(current.ppid);
  }
  return ancestry;
}

function assertEndpointKind(terminal: TerminalEndpointRef, kind: string): void {
  if (terminal.identity.providerKind !== kind) {
    throw new Error(
      `terminal control provider ${kind} cannot resolve ` +
      `${terminal.identity.providerKind}`
    );
  }
}

function assertTerminalCapability(
  terminal: TerminalEndpointRef,
  capability: TerminalControlCapability,
  supportedCapabilities: readonly TerminalControlCapability[]
): void {
  if (
    !supportedCapabilities.includes(capability) ||
    !terminal.capabilities.includes(capability)
  ) {
    throw new Error(
      `terminal control capability ${capability} is not available for ` +
      `${terminal.identity.providerKind}:${terminal.route.label}`
    );
  }
}

function assertProviderCapability(
  kind: string,
  supported: readonly TerminalProviderCapability[],
  capability: TerminalProviderCapability
): void {
  if (!supported.includes(capability)) {
    throw new Error(
      `terminal control provider ${kind} does not support ${capability}`
    );
  }
}

function assertInputProviderCapability(
  kind: string,
  supported: readonly TerminalProviderCapability[],
  capability: "text_delivery" | "key_delivery"
): void {
  if (!supported.includes(capability)) {
    throw new TerminalControlInputNotSentError(
      `terminal control provider ${kind} does not support ${capability}`
    );
  }
}

function intersectCapabilities(
  requested: readonly TerminalControlCapability[],
  supported: readonly TerminalControlCapability[]
): TerminalControlCapability[] {
  const supportedSet = new Set(supported);
  return [...new Set(requested)].filter((capability) =>
    supportedSet.has(capability)
  );
}

function endpointWithCapabilities(
  terminal: TerminalEndpointRef,
  capabilities: readonly TerminalControlCapability[]
): TerminalEndpointRef {
  const providerRef = terminalControlWithCapabilities(
    tmuxControlFromEndpoint(terminal),
    capabilities
  );
  return createTerminalEndpointRef({
    identity: terminal.identity,
    route: terminal.route,
    processAnchorPid: terminal.processAnchorPid,
    capabilities,
    providerRef
  });
}

function tmuxEndpointFromPane(
  pane: TerminalPane,
  capabilities: readonly TerminalControlCapability[]
): TerminalEndpointRef {
  const providerRef = terminalRefFromPane(pane, capabilities);
  const legacy = terminalEndpointFromControlRef(providerRef);
  const endpointKey = pane.serverSocketPath
    ? `socket:${pane.serverSocketPath}`
    : legacy.identity.endpointKey;
  const resourceKey = pane.paneId
    ? `pane-id:${pane.paneId}`
    : legacy.identity.resourceKey;
  return createTerminalEndpointRef({
    identity: {
      providerKind: "tmux",
      endpointKey,
      resourceKey
    },
    route: {
      routeKey: tmuxTerminalRouteKey(
        endpointKey,
        pane.target,
        pane.socketPath
      ),
      label: pane.target,
      currentCommand: pane.currentCommand,
      currentPath: pane.currentPath
    },
    processAnchorPid: pane.panePid,
    capabilities,
    providerRef
  });
}

function legacyTmuxEndpointMatches(
  candidate: TerminalEndpointRef,
  requested: TerminalEndpointRef
): boolean {
  if (!requested.identity.resourceKey.startsWith("legacy:")) {
    return false;
  }
  const candidateControl = tmuxControlFromEndpoint(candidate);
  const requestedControl = tmuxControlFromEndpoint(requested);
  if (
    candidateControl.target !== requestedControl.target ||
    candidateControl.panePid !== requestedControl.panePid
  ) {
    return false;
  }
  if (!requestedControl.socketPath) {
    return true;
  }
  return candidateControl.socketPath === requestedControl.socketPath ||
    candidate.identity.endpointKey === `socket:${requestedControl.socketPath}`;
}

function tmuxControlFromEndpoint(
  terminal: TerminalEndpointRef
): TmuxTerminalControlRef {
  assertEndpointKind(terminal, "tmux");
  const control = terminal.providerRef;
  if (!isTmuxTerminalControlRef(control)) {
    throw new Error("tmux terminal endpoint has an invalid provider reference");
  }
  return control;
}

function tmuxIoRoute(
  terminal: TerminalEndpointRef
): { target: string; socketPath?: string } {
  const control = tmuxControlFromEndpoint(terminal);
  const stablePaneId = terminal.identity.resourceKey.startsWith("pane-id:")
    ? terminal.identity.resourceKey.slice("pane-id:".length)
    : undefined;
  const stableSocketPath = terminal.identity.endpointKey.startsWith("socket:")
    ? terminal.identity.endpointKey.slice("socket:".length)
    : undefined;
  return {
    // tmux's `%pane_id` remains valid across session/window/pane renames and
    // cannot be confused with a newly reused human selector.
    target: stablePaneId || control.target,
    socketPath: stableSocketPath || control.socketPath
  };
}

function isTmuxTerminalControlRef(
  value: unknown
): value is TmuxTerminalControlRef {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const control = value as Partial<TmuxTerminalControlRef>;
  return control.kind === "tmux" &&
    typeof control.target === "string" &&
    typeof control.session === "string" &&
    Number.isInteger(control.window) &&
    Number.isInteger(control.pane) &&
    Number.isInteger(control.panePid) &&
    Array.isArray(control.capabilities);
}

function tmuxPaneFromEndpoint(terminal: TerminalEndpointRef): TerminalPane {
  const control = tmuxControlFromEndpoint(terminal);
  return {
    kind: "tmux",
    target: control.target,
    socketPath: control.socketPath,
    session: control.session,
    window: control.window,
    pane: control.pane,
    panePid: control.panePid,
    currentCommand: control.currentCommand,
    currentPath: control.currentPath
  };
}

export function terminalRefFromPane(
  pane: TerminalPane,
  capabilities: readonly TerminalControlCapability[] = ["screen_status", "send_keys"]
): TerminalControlRef {
  return {
    kind: "tmux",
    target: pane.target,
    socketPath: pane.socketPath,
    session: pane.session,
    window: pane.window,
    pane: pane.pane,
    panePid: pane.panePid,
    currentCommand: pane.currentCommand,
    currentPath: pane.currentPath,
    capabilities: [...capabilities]
  };
}

export function terminalPaneContainsProcess(
  process: Pick<TerminalProcessSnapshot, "pid" | "ppid">,
  pane: TerminalPane,
  processes: readonly Pick<TerminalProcessSnapshot, "pid" | "ppid">[]
): boolean {
  if (process.pid === pane.panePid || process.ppid === pane.panePid) {
    return true;
  }

  let current: Pick<TerminalProcessSnapshot, "pid" | "ppid"> = process;
  const seen = new Set<number>();
  while (current.ppid && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (current.ppid === pane.panePid) {
      return true;
    }
    const parent = processes.find((candidate) => candidate.pid === current.ppid);
    if (!parent) {
      return false;
    }
    current = parent;
  }
  return false;
}

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function tmuxArgs(socketPath: string | undefined, args: string[]): string[] {
  return socketPath ? ["-S", socketPath, ...args] : args;
}

function defaultTmuxSocketPaths(): string[] {
  const paths = [
    process.env.AKK_TMUX_SOCKET,
    tmuxSocketFromEnvironment(process.env.TMUX),
    uidSocketPath("/private/tmp"),
    uidSocketPath("/tmp"),
    ...discoverTmuxSocketPaths("/private/tmp"),
    ...discoverTmuxSocketPaths("/tmp")
  ].filter((value): value is string => Boolean(value));
  return [...new Set(paths)];
}

export function discoverTmuxSocketPaths(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("tmux-"))
      .map((entry) => path.join(root, entry.name, "default"))
      .filter((socketPath) => fs.existsSync(socketPath));
  } catch {
    return [];
  }
}

function defaultTmuxCommands(): string[] {
  return [
    "tmux",
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux"
  ];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function cleanDiagnosticText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 500);
}

function tmuxSocketFromEnvironment(value: string | undefined): string | undefined {
  return value?.split(",")[0] || undefined;
}

function uidSocketPath(root: string): string | undefined {
  if (typeof process.getuid !== "function") {
    return undefined;
  }
  return `${root}/tmux-${process.getuid()}/default`;
}
