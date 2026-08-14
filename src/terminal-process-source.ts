import { spawnSync } from "node:child_process";
import type { TerminalProcessSnapshot } from "./terminal-agent-adapter.js";
import { parseProcessElapsedSeconds } from "./terminal-process-facts.js";

export { parseProcessElapsedSeconds } from "./terminal-process-facts.js";

export interface ProcessCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface TerminalProcessSource {
  /**
   * True only when an empty result comes from one complete, integrity-checked
   * operating-system process inventory and may therefore prove PID absence.
   * User-supplied/static discovery snapshots deliberately omit this marker.
   */
  readonly completeInventoryAuthority?: true;
  listProcessSnapshots(
    isCandidate?: (snapshot: TerminalProcessSnapshot) => boolean,
    options?: { includeCwd?: boolean; includeAncestors?: boolean }
  ): Promise<TerminalProcessSnapshot[]>;
}

export class StaticTerminalProcessSource implements TerminalProcessSource {
  constructor(private readonly snapshots: readonly TerminalProcessSnapshot[]) {}

  async listProcessSnapshots(
    isCandidate: (snapshot: TerminalProcessSnapshot) => boolean = () => true,
    options: { includeCwd?: boolean; includeAncestors?: boolean } = {}
  ): Promise<TerminalProcessSnapshot[]> {
    const candidates = this.snapshots.filter(isCandidate);
    return selectedSnapshots(this.snapshots, candidates, options.includeAncestors === true)
      .map((snapshot) => ({ ...snapshot }));
  }
}

export class SystemTerminalProcessSource implements TerminalProcessSource {
  readonly completeInventoryAuthority = true as const;
  private readonly runCommand: (command: string, args: string[]) => ProcessCommandResult;

  constructor(options: {
    runCommand?: (command: string, args: string[]) => ProcessCommandResult;
  } = {}) {
    this.runCommand = options.runCommand ?? runProcessCommand;
  }

  async listProcessSnapshots(
    isCandidate: (snapshot: TerminalProcessSnapshot) => boolean = () => true,
    options: { includeCwd?: boolean; includeAncestors?: boolean } = {}
  ): Promise<TerminalProcessSnapshot[]> {
    const ps = this.runCommand("ps", ["-axo", "pid,ppid,etime,command"]);
    if (ps.status !== 0) {
      throw new Error(ps.stderr || ps.error?.message || "ps failed");
    }

    const snapshots = parseCompletePsProcessSnapshots(ps.stdout);
    const candidates = snapshots.filter(isCandidate);
    if (candidates.length === 0) {
      return [];
    }
    const selected = selectedSnapshots(
      snapshots,
      candidates,
      options.includeAncestors === true
    );
    if (options.includeCwd === false) {
      return selected;
    }

    const lsof = this.runCommand("lsof", [
      "-a",
      "-d",
      "cwd",
      "-p",
      candidates.map((snapshot) => String(snapshot.pid)).join(",")
    ]);
    const lsofOutput = typeof lsof.stdout === "string" ? lsof.stdout : "";
    if (lsof.status !== 0 && lsofOutput.trim().length === 0) {
      return selected;
    }

    const cwdByPid = parseLsofCwdMap(lsofOutput);
    return selected.map((snapshot) => ({
      ...snapshot,
      cwd: snapshot.cwd ?? cwdByPid.get(snapshot.pid)
    }));
  }
}

/**
 * Parse one complete `ps -axo pid,ppid,etime,command` observation. This is
 * intentionally stricter than the public best-effort parser below: callers
 * may use an empty result as process-death authority, so malformed or
 * truncated output must never collapse into an apparently empty inventory.
 */
function parseCompletePsProcessSnapshots(
  output: string
): TerminalProcessSnapshot[] {
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("ps returned an empty process inventory");
  }
  if (!/\r?\n$/u.test(output)) {
    throw new Error("ps returned a truncated process inventory");
  }
  const lines = output.split(/\r?\n/u);
  const header = lines.shift()?.trim();
  if (!header || !/^PID\s+PPID\s+(?:ELAPSED|ETIME)\s+COMMAND$/u.test(header)) {
    throw new Error("ps returned an unexpected process inventory header");
  }
  const snapshots: TerminalProcessSnapshot[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) {
      throw new Error("ps returned an unparseable process inventory row");
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0 ||
      parseProcessElapsedSeconds(match[3]) === undefined
    ) {
      throw new Error("ps returned an invalid process inventory row");
    }
    snapshots.push({
      pid,
      ppid,
      elapsed: match[3],
      command: match[4]
    });
  }
  if (snapshots.length === 0) {
    throw new Error("ps returned a header-only process inventory");
  }
  return snapshots;
}

function selectedSnapshots(
  snapshots: readonly TerminalProcessSnapshot[],
  candidates: readonly TerminalProcessSnapshot[],
  includeAncestors: boolean
): TerminalProcessSnapshot[] {
  if (!includeAncestors) {
    return [...candidates];
  }

  const byPid = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
  const selectedPids = new Set(candidates.map((snapshot) => snapshot.pid));
  for (const candidate of candidates) {
    let parentPid = candidate.ppid;
    const visited = new Set<number>([candidate.pid]);
    while (
      typeof parentPid === "number" &&
      Number.isInteger(parentPid) &&
      parentPid > 1 &&
      !visited.has(parentPid)
    ) {
      visited.add(parentPid);
      const parent = byPid.get(parentPid);
      if (!parent) {
        break;
      }
      selectedPids.add(parent.pid);
      parentPid = parent.ppid;
    }
  }
  return snapshots.filter((snapshot) => selectedPids.has(snapshot.pid));
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
