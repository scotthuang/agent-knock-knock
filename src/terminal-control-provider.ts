import { spawnSync } from "node:child_process";
import type { ActiveCodexProcess, TerminalControlRef } from "./codex-session-provider.js";

export interface TerminalPane {
  kind: "tmux";
  target: string;
  session: string;
  window: number;
  pane: number;
  panePid: number;
  currentCommand?: string;
  currentPath?: string;
}

export interface TerminalControlProvider {
  listPanes(): Promise<TerminalPane[]>;
  capture(target: string, options?: { scrollbackLines?: number }): Promise<string>;
  sendText(target: string, text: string): Promise<void>;
  sendKeys(target: string, keys: string[]): Promise<void>;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export class TmuxTerminalControlProvider implements TerminalControlProvider {
  private readonly runCommand: (command: string, args: string[]) => CommandResult;

  constructor(options: { runCommand?: (command: string, args: string[]) => CommandResult } = {}) {
    this.runCommand = options.runCommand ?? runCommand;
  }

  async listPanes(): Promise<TerminalPane[]> {
    const result = this.runCommand("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}"
    ]);
    if (result.status !== 0) {
      return [];
    }
    return parseTmuxListPanes(result.stdout);
  }

  async capture(target: string, options: { scrollbackLines?: number } = {}): Promise<string> {
    const scrollbackLines = Math.max(0, Math.floor(options.scrollbackLines ?? 200));
    const result = this.runCommand("tmux", [
      "capture-pane",
      "-t",
      target,
      "-p",
      "-S",
      `-${scrollbackLines}`
    ]);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || `tmux capture-pane failed for ${target}`);
    }
    return result.stdout;
  }

  async sendKeys(target: string, keys: string[]): Promise<void> {
    const result = this.runCommand("tmux", ["send-keys", "-t", target, ...keys]);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || `tmux send-keys failed for ${target}`);
    }
  }

  async sendText(target: string, text: string): Promise<void> {
    const result = this.runCommand("tmux", ["send-keys", "-t", target, "-l", text]);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || `tmux send-keys failed for ${target}`);
    }
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

export function parseTmuxListPanes(output: string): TerminalPane[] {
  const panes: TerminalPane[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const [session, windowIndex, paneIndex, panePid, currentCommand, currentPath] = line.split("\t");
      const window = Number(windowIndex);
      const pane = Number(paneIndex);
      const parsedPanePid = Number(panePid);
      if (!session || !Number.isInteger(window) || !Number.isInteger(pane) || !Number.isInteger(parsedPanePid)) {
        continue;
      }
      panes.push({
        kind: "tmux" as const,
        target: `${session}:${window}.${pane}`,
        session,
        window,
        pane,
        panePid: parsedPanePid,
        currentCommand: currentCommand || undefined,
        currentPath: currentPath || undefined
      });
  }
  return panes;
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
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}
