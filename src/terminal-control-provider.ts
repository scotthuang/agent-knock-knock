import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ActiveCodexProcess, TerminalControlRef } from "./codex-session-provider.js";

export interface TerminalPane {
  kind: "tmux";
  target: string;
  socketPath?: string;
  session: string;
  window: number;
  pane: number;
  panePid: number;
  currentCommand?: string;
  currentPath?: string;
}

export interface TerminalControlProvider {
  listPanes(): Promise<TerminalPane[]>;
  capture(target: string, options?: { scrollbackLines?: number; socketPath?: string }): Promise<string>;
  sendText(target: string, text: string, options?: { socketPath?: string }): Promise<void>;
  sendKeys(target: string, keys: string[], options?: { socketPath?: string }): Promise<void>;
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
          "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}"
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
          const key = `${pane.socketPath ?? ""}\t${pane.target}\t${pane.panePid}`;
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

  async capture(target: string, options: { scrollbackLines?: number; socketPath?: string } = {}): Promise<string> {
    const scrollbackLines = Math.max(0, Math.floor(options.scrollbackLines ?? 200));
    let lastResult: CommandResult | undefined;
    for (const command of this.commands) {
      const result = this.runCommand(command, tmuxArgs(options.socketPath, [
        "capture-pane",
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

  async sendKeys(target: string, keys: string[], options: { socketPath?: string } = {}): Promise<void> {
    let lastResult: CommandResult | undefined;
    for (const command of this.commands) {
      const result = this.runCommand(command, tmuxArgs(options.socketPath, ["send-keys", "-t", target, ...keys]));
      if (result.status === 0) {
        return;
      }
      lastResult = result;
    }
    throw new Error(lastResult?.stderr || lastResult?.error?.message || `tmux send-keys failed for ${target}`);
  }

  async sendText(target: string, text: string, options: { socketPath?: string } = {}): Promise<void> {
    let lastResult: CommandResult | undefined;
    for (const command of this.commands) {
      const result = this.runCommand(command, tmuxArgs(options.socketPath, ["send-keys", "-t", target, "-l", text]));
      if (result.status === 0) {
        return;
      }
      lastResult = result;
    }
    throw new Error(lastResult?.stderr || lastResult?.error?.message || `tmux send-keys failed for ${target}`);
  }
}

export class StaticTerminalControlProvider implements TerminalControlProvider {
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

  async capture(target: string): Promise<string> {
    return this.screens.get(target) ?? "";
  }

  async sendText(target: string, text: string): Promise<void> {
    this.sentKeys.push({ target, keys: ["-l", text] });
  }

  async sendKeys(target: string, keys: string[]): Promise<void> {
    this.sentKeys.push({ target, keys });
  }
}

export function parseTmuxListPanes(output: string, socketPath?: string): TerminalPane[] {
  const panes: TerminalPane[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseTmuxPaneLine(line);
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

function parseTmuxPaneLine(line: string): Omit<TerminalPane, "kind" | "target" | "socketPath"> | undefined {
  const tabFields = line.split("\t");
  const fields = tabFields.length >= 6
    ? [
        tabFields[0],
        tabFields[1],
        tabFields[2],
        tabFields[3],
        tabFields[4],
        tabFields.slice(5).join("\t")
      ]
    : parseWhitespaceTmuxPaneLine(line);
  if (!fields) {
    return undefined;
  }

  const [session, windowIndex, paneIndex, panePid, currentCommand, currentPath] = fields;
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
    currentPath: currentPath || undefined
  };
}

function parseWhitespaceTmuxPaneLine(line: string): string[] | undefined {
  const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line.trim());
  return match ? match.slice(1) : undefined;
}

export async function enrichActiveProcessesWithTerminalControl(
  processes: ActiveCodexProcess[],
  provider: TerminalControlProvider
): Promise<ActiveCodexProcess[]> {
  const panes = await provider.listPanes();
  if (panes.length === 0) {
    return processes;
  }

  return processes.map((process) => {
    const pane = panes.find((candidate) => processBelongsToPane(process, candidate, processes));
    if (!pane) {
      return process;
    }
    return {
      ...process,
      terminalControl: terminalRefFromPane(pane)
    };
  });
}

export function terminalRefFromPane(pane: TerminalPane): TerminalControlRef {
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
    capabilities: ["capture_screen", "send_keys", "terminal_approval"]
  };
}

function processBelongsToPane(process: ActiveCodexProcess, pane: TerminalPane, processes: ActiveCodexProcess[]): boolean {
  if (process.pid === pane.panePid || process.ppid === pane.panePid) {
    return true;
  }

  let current = process;
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
