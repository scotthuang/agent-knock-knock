import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveOptionalExecutable } from "./cli-command-runtime.js";

interface ProcessIdentity {
  pid: number;
  ppid: number;
  birth: string;
  command: string;
}
interface MappedExecutable {
  path: string;
  device: bigint;
  inode: bigint;
}
interface ExecutableEvidence extends MappedExecutable {
  size: bigint;
  modified: bigint;
  changed: bigint;
}
export interface RunningCodexExecutable {
  path: string;
  version: string;
  isCurrent(): boolean;
}

/** Resolve the loaded native image, including the npm launcher's direct child. */
export function runningCodexExecutables(pid: number): readonly RunningCodexExecutable[] {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 1) return [];
    const selected = selectNativeProcess(observeProcesses(), pid);
    if (!selected) return [];
    const evidence = observeExecutable(selected.native);
    if (!evidence) return [];
    const result = spawnSync(evidence.path, ["--version"], {
      encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024
    });
    if (result.error || result.status !== 0) return [];
    const version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/u
      .exec(String(result.stdout ?? "").trim())?.[1];
    const isCurrent = () => sameRunningExecutable(pid, selected, evidence);
    return version && isCurrent() ? [{ path: evidence.path, version, isCurrent }] : [];
  } catch {
    return [];
  }
}

function observeProcesses(): ProcessIdentity[] {
  const result = spawnSync(resolveOptionalExecutable("ps"), [
    "-axo", "pid=,ppid=,lstart=,command="
  ], { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  if (result.error || result.status !== 0 || !result.stdout.endsWith("\n")) return [];
  const entries: ProcessIdentity[] = [];
  for (const line of result.stdout.trimEnd().split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(line);
    if (!match) return [];
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]),
      birth: match[3]!.replace(/\s+/gu, " "), command: match[4]! });
  }
  return new Set(entries.map(entry => entry.pid)).size === entries.length ? entries : [];
}

function commandTokens(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? [])
    .map(token => token.replace(/^(["'])(.*)\1$/u, "$2"));
}

function selectNativeProcess(processes: readonly ProcessIdentity[], pid: number):
  { root: ProcessIdentity; native: ProcessIdentity } | undefined {
  const root = processes.find(entry => entry.pid === pid);
  if (!root) return undefined;
  const tokens = commandTokens(root.command);
  if (path.basename(tokens[0] ?? "") === "codex") return { root, native: root };
  if (path.basename(tokens[0] ?? "") !== "node" ||
      !["codex", "codex.js"].includes(path.basename(tokens[1] ?? ""))) return undefined;
  // The official Node launcher forwards argv unchanged to one native child.
  // Do not borrow a version from grandchildren or agent-spawned Codex sessions.
  const children = processes.filter(entry => entry.ppid === pid &&
    path.basename(commandTokens(entry.command)[0] ?? "") === "codex");
  if (children.length !== 1) return undefined;
  const native = children[0]!;
  if (JSON.stringify(commandTokens(native.command).slice(1)) !==
      JSON.stringify(tokens.slice(2))) return undefined;
  return { root, native };
}

function observeExecutable(native: ProcessIdentity): ExecutableEvidence | undefined {
  const result = spawnSync(resolveOptionalExecutable("lsof"), [
    "-a", "-p", String(native.pid), "-d", "txt", "-FpnDi"
  ], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) return undefined;
  const mapped = parseMappedExecutables(String(result.stdout ?? ""), native.pid);
  if (mapped.length !== 1) return undefined;
  const entry = mapped[0]!;
  const stat = fs.statSync(entry.path, { bigint: true });
  const started = Date.parse(`${native.birth} UTC`);
  if (!stat.isFile() || stat.dev !== entry.device || stat.ino !== entry.inode ||
      !Number.isFinite(started) || stat.mtimeMs > started || stat.ctimeMs > started) return undefined;
  const commandPath = commandTokens(native.command)[0]!;
  if (path.isAbsolute(commandPath) && fs.realpathSync(commandPath) !== fs.realpathSync(entry.path)) return undefined;
  return { ...entry, size: stat.size, modified: stat.mtimeNs, changed: stat.ctimeNs };
}

function parseMappedExecutables(output: string, pid: number): MappedExecutable[] {
  let selected = false;
  let entry: Partial<MappedExecutable> = {};
  const entries: MappedExecutable[] = [];
  const finish = () => {
    if (selected && entry.path && path.isAbsolute(entry.path) &&
        path.basename(entry.path) === "codex" && entry.device !== undefined &&
        entry.inode !== undefined) entries.push(entry as MappedExecutable);
    entry = {};
  };
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("p")) { finish(); selected = line === `p${pid}`; }
    else if (line.startsWith("f")) finish();
    else if (line.startsWith("n")) entry.path = line.slice(1);
    else if (/^D(?:0x)?[\da-f]+$/iu.test(line)) entry.device = BigInt(line.slice(1));
    else if (/^i\d+$/u.test(line)) entry.inode = BigInt(line.slice(1));
  }
  finish();
  return [...new Map(entries.map(entry => [
    `${entry.path}:${entry.device}:${entry.inode}`, entry
  ])).values()];
}

function sameRunningExecutable(pid: number,
  selected: { root: ProcessIdentity; native: ProcessIdentity },
  evidence: ExecutableEvidence): boolean {
  try {
    const current = selectNativeProcess(observeProcesses(), pid);
    if (!current || !sameProcess(current.root, selected.root) ||
        !sameProcess(current.native, selected.native)) return false;
    const mapped = observeExecutable(current.native);
    return mapped !== undefined && mapped.path === evidence.path &&
      mapped.device === evidence.device && mapped.inode === evidence.inode &&
      mapped.size === evidence.size && mapped.modified === evidence.modified &&
      mapped.changed === evidence.changed;
  } catch { return false; }
}

function sameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.ppid === right.ppid &&
    left.birth === right.birth && left.command === right.command;
}
