import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveOptionalExecutable } from "./cli-command-runtime.js";
import { codexProcessBirthForLifecycle } from "./codex-process-incarnation.js";
import { parseLsofOpenFiles, type LsofOpenFileRecord } from "./codex-open-rollout-inventory.js";

type Row = Record<string, unknown>;
export type ConversationRoutingHome =
  | { status: "verified"; codexHome: string; evidence: "open_arg0_lock" }
  | { status: "unavailable" | "ambiguous"; reason: string };
export interface ConversationRoutingHomePorts {
  processBirth(pid: number): string;
  openFiles(pid: number): { status: number | null; stdout: string; error?: unknown };
}
const unavailable = (reason: string): ConversationRoutingHome => ({ status: "unavailable", reason });

/** Codex retains a .lock descriptor in its CODEX_HOME/tmp/arg0 entry for its lifetime.
 * Inspect names and inode identity only;
 * never read its environment, log contents, credentials, or chat history.
 * Official implementation: codex-rs/arg0/src/lib.rs, prepare_path_entry_for_codex_aliases.
 */
export function readConversationRoutingHome(terminal: Row,
  ports: Partial<ConversationRoutingHomePorts> = {}): ConversationRoutingHome {
  const pid = terminal.pid, expectedBirth = terminal.native_agent_process_birth;
  if (terminal.agent !== "codex" || terminal.process_state !== "active" || !Number.isSafeInteger(pid) || Number(pid) < 2 ||
    typeof expectedBirth !== "string" || !expectedBirth.trim()) return unavailable("physical_process_incarnation_missing");
  const birth = ports.processBirth ?? codexProcessBirthForLifecycle;
  try {
    if (birth(Number(pid)) !== expectedBirth) return unavailable("physical_process_incarnation_changed");
    const files = (ports.openFiles ?? processOpenFiles)(Number(pid));
    if (files.status !== 0 || files.error) return unavailable("process_open_files_unavailable");
    const result = homeFromOpenFiles(Number(pid), files.stdout);
    if (birth(Number(pid)) !== expectedBirth) return unavailable("physical_process_incarnation_changed");
    return result;
  } catch { return unavailable("process_home_observation_failed"); }
}

/** Attach private physical evidence to a raw terminal row; scan configuration is not proof. */
export function withConversationRoutingHome(terminal: Row, ports: Partial<ConversationRoutingHomePorts> = {}): Row {
  if (terminal.agent !== "codex") return terminal;
  const observation = readConversationRoutingHome(terminal, ports);
  return { ...terminal, native_agent_codex_home: observation.status === "verified" ? observation.codexHome : undefined,
    native_agent_codex_home_observation: observation };
}

function processOpenFiles(pid: number): { status: number | null; stdout: string; error?: unknown } {
  const result = spawnSync(resolveOptionalExecutable("lsof"), ["-a", "-p", String(pid), "-FnfDit"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), error: result.error };
}

function homeFromOpenFiles(pid: number, output: string): ConversationRoutingHome {
  const processes = output.split(/\r?\n/u).filter(line => line.startsWith("p"));
  if (processes.length !== 1 || processes[0] !== `p${pid}`) return unavailable("process_open_files_identity_mismatch");
  const candidates = parseLsofOpenFiles(output).filter(file => file.path && arg0Home(file.path.replace(/ \(deleted\)$/u, "")));
  if (!candidates.length) return unavailable("codex_home_descriptor_missing");
  if (candidates.length > 128) return unavailable("codex_home_descriptor_limit");
  const homes: string[] = [];
  for (const file of candidates) {
    const home = verifiedDescriptorHome(file);
    if (!home) return unavailable("codex_home_descriptor_unverifiable");
    homes.push(home);
  }
  const unique = [...new Set(homes)];
  return unique.length === 1 ? { status: "verified", codexHome: unique[0], evidence: "open_arg0_lock" }
    : { status: "ambiguous", reason: "multiple_codex_home_descriptors" };
}

function arg0Home(filename: string): string | undefined {
  if (!path.isAbsolute(filename) || path.basename(filename) !== ".lock") return undefined;
  const entry = path.dirname(filename), arg0 = path.dirname(entry), temporary = path.dirname(arg0);
  return /^codex-arg0[^/]+$/u.test(path.basename(entry)) && path.basename(arg0) === "arg0" && path.basename(temporary) === "tmp"
    ? path.dirname(temporary) : undefined;
}

function verifiedDescriptorHome(file: LsofOpenFileRecord): string | undefined {
  if (file.type !== "REG" || !/^\d+$/u.test(file.fd ?? "") || !file.path || !file.device || !file.inode) return undefined;
  const device = integer(file.device), inode = integer(file.inode);
  if (device === undefined || inode === undefined) return undefined;
  try {
    const stat = fs.lstatSync(file.path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== device || stat.ino !== inode) return undefined;
    const real = fs.realpathSync(file.path), home = arg0Home(real);
    if (!home || fs.realpathSync(file.path) !== real) return undefined;
    const confirmed = fs.statSync(real, { bigint: true });
    return confirmed.dev === device && confirmed.ino === inode ? home : undefined;
  } catch { return undefined; }
}

function integer(value: string): bigint | undefined {
  if (!/^(?:[0-9]+|0x[0-9a-f]+)$/iu.test(value)) return undefined;
  try { return BigInt(value); } catch { return undefined; }
}
