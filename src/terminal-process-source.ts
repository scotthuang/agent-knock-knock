import { spawnSync } from "node:child_process";
import type { TerminalProcessSnapshot } from "./terminal-agent-adapter.js";

export interface ProcessCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface TerminalProcessSource {
  listProcessSnapshots(
    isCandidate?: (snapshot: TerminalProcessSnapshot) => boolean
  ): Promise<TerminalProcessSnapshot[]>;
}

export class StaticTerminalProcessSource implements TerminalProcessSource {
  constructor(private readonly snapshots: readonly TerminalProcessSnapshot[]) {}

  async listProcessSnapshots(
    isCandidate: (snapshot: TerminalProcessSnapshot) => boolean = () => true
  ): Promise<TerminalProcessSnapshot[]> {
    return this.snapshots.filter(isCandidate).map((snapshot) => ({ ...snapshot }));
  }
}

export class SystemTerminalProcessSource implements TerminalProcessSource {
  private readonly runCommand: (command: string, args: string[]) => ProcessCommandResult;

  constructor(options: {
    runCommand?: (command: string, args: string[]) => ProcessCommandResult;
  } = {}) {
    this.runCommand = options.runCommand ?? runProcessCommand;
  }

  async listProcessSnapshots(
    isCandidate: (snapshot: TerminalProcessSnapshot) => boolean = () => true
  ): Promise<TerminalProcessSnapshot[]> {
    const ps = this.runCommand("ps", ["-axo", "pid,ppid,etime,command"]);
    if (ps.status !== 0) {
      throw new Error(ps.stderr || ps.error?.message || "ps failed");
    }

    const candidates = parsePsProcessSnapshots(ps.stdout).filter(isCandidate);
    if (candidates.length === 0) {
      return [];
    }

    const lsof = this.runCommand("lsof", [
      "-a",
      "-d",
      "cwd",
      "-p",
      candidates.map((snapshot) => String(snapshot.pid)).join(",")
    ]);
    if (lsof.status !== 0) {
      return candidates;
    }

    const cwdByPid = parseLsofCwdMap(lsof.stdout);
    return candidates.map((snapshot) => ({
      ...snapshot,
      cwd: snapshot.cwd ?? cwdByPid.get(snapshot.pid)
    }));
  }
}

export function parsePsProcessSnapshots(output: string): TerminalProcessSnapshot[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsed: match[3],
      command: match[4]
    }));
}

export function parseLsofCwdMap(output: string): Map<number, string> {
  const cwdByPid = new Map<number, string>();
  for (const line of output.split(/\r?\n/).slice(1)) {
    const match = /^\S+\s+(\d+)\s+\S+\s+cwd\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+?)\s*$/u.exec(line);
    if (match) {
      cwdByPid.set(Number(match[1]), match[2]);
    }
  }
  return cwdByPid;
}

export function runProcessCommand(command: string, args: string[]): ProcessCommandResult {
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
