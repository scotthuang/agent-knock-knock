import { spawnSync } from "node:child_process";
import fs from "node:fs";

export interface StoreOwnerProcessEvidence {
  readonly pid: number;
  readonly process_start: string | null;
  readonly boot_id: string | null;
}

export type StoreOwnerProcessObservation =
  | { readonly state: "absent" }
  | { readonly state: "unknown" }
  | { readonly state: "present"; readonly process_start: string | null; readonly boot_id: string | null };

export type StoreOwnerProcessProbe = (pid: number) => StoreOwnerProcessObservation;
export interface StoreOwnerLiveness {
  readonly state: "alive" | "dead" | "unknown";
  readonly reason: string;
}

function boundedText(value: string): string | null {
  const text = value.trim();
  return text.length > 0 && text.length <= 256 && !/[\u0000\r\n]/u.test(text) ? text : null;
}

function systemCommand(executable: string, args: string[]): string | null {
  const result = spawnSync(executable, args, {
    encoding: "utf8", timeout: 2_000, maxBuffer: 4096,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
  });
  return result.status === 0 && !result.error ? boundedText(result.stdout) : null;
}

function bootIdentity(): string | null {
  if (process.platform === "linux") {
    return boundedText(fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8"));
  }
  if (process.platform === "darwin") {
    return systemCommand("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
  }
  return null;
}

function startIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    return /^\d+$/u.test(fields[19] ?? "") ? `linux-start-ticks:${fields[19]}` : null;
  }
  if (process.platform === "darwin") {
    const value = systemCommand("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    return value ? `darwin-lstart:${value}` : null;
  }
  return null;
}

/** EPERM and inaccessible OS evidence never prove either presence or death. */
export const systemStoreOwnerProcessProbe: StoreOwnerProcessProbe = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: "unknown" };
  try {
    process.kill(pid, 0);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown" };
  }
  try {
    return { state: "present", process_start: startIdentity(pid), boot_id: bootIdentity() };
  } catch {
    return { state: "unknown" };
  }
};

export function probeStoreOwnerIdentity(
  owner: StoreOwnerProcessEvidence,
  probe: StoreOwnerProcessProbe = systemStoreOwnerProcessProbe
): StoreOwnerLiveness {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || !owner.process_start || !owner.boot_id) {
    return { state: "unknown", reason: "owner_incarnation_unverified" };
  }
  let observed: StoreOwnerProcessObservation;
  try { observed = probe(owner.pid); } catch { return { state: "unknown", reason: "owner_probe_failed" }; }
  if (observed.state === "absent") return { state: "dead", reason: "owner_pid_absent" };
  if (observed.state !== "present") return { state: "unknown", reason: "owner_process_unreadable" };
  if (!observed.process_start || !observed.boot_id) {
    return { state: "unknown", reason: "owner_incarnation_unverified" };
  }
  if (owner.process_start !== observed.process_start || owner.boot_id !== observed.boot_id) {
    return { state: "unknown", reason: "owner_incarnation_changed" };
  }
  return { state: "alive", reason: "owner_incarnation_verified" };
}

function parentPid(pid: number): number | undefined {
  if (pid === process.pid) return process.ppid;
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[1]);
  }
  if (process.platform === "darwin") {
    return Number(systemCommand("/bin/ps", ["-o", "ppid=", "-p", String(pid)]));
  }
  return undefined;
}

/** A copied environment cannot nominate an unrelated process as its Host. */
export function storeOwnerHostIsAncestor(hostPid: number): boolean {
  try {
    let pid: number | undefined = process.pid;
    const seen = new Set<number>();
    while (pid && pid > 1 && !seen.has(pid) && seen.size < 32) {
      if (pid === hostPid) return true;
      seen.add(pid);
      pid = parentPid(pid);
    }
  } catch { return false; }
  return false;
}
