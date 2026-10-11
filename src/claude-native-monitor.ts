import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ensureDir } from "./store.js";
import { cliCwd, cliEnv, cliNow, cliNowMs, cliPid, cliSleep, cliSleepSync } from "./cli-runtime-context.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { isClaudeNativeWatchId } from "./claude-native-identity.js";
import { createClaudeNativeRuntime, type ClaudeNativeRuntimeOptions } from "./claude-native-runtime.js";

export interface ClaudeNativeMonitorTasks {
  reconcile(id: string): Promise<unknown>;
  shouldMonitor(id: string): boolean;
}
/** Polling recovers missed events. Durable task/outbox state, never idle alone, decides when to stop. */
export async function pollClaudeNativeMonitor(watchId: string, tasks: ClaudeNativeMonitorTasks,
  options: { sleep?: (ms: number) => Promise<void>; onError?: () => void } = {}): Promise<void> {
  if (!isClaudeNativeWatchId(watchId)) throw new Error("Invalid Claude CLI Watch ID");
  while (tasks.shouldMonitor(watchId)) {
    try { await tasks.reconcile(watchId); }
    catch { options.onError?.(); }
    if (!tasks.shouldMonitor(watchId)) return;
    await (options.sleep ?? cliSleep)(2000);
  }
}

export async function launchClaudeNativeMonitor(watchId: string, options: ClaudeNativeRuntimeOptions): Promise<number> {
  if (!isClaudeNativeWatchId(watchId)) throw new Error("Invalid Claude CLI Watch ID");
  const args = [fileURLToPath(new URL("./cli.js", import.meta.url)), "monitor-claude-native", "--watch", watchId, "--store-dir", options.storeDir];
  if (options.openclawBin) args.push("--openclaw-bin", options.openclawBin);
  const directory = path.join(options.storeDir, "claude-native-monitors"); ensureDir(directory);
  const fd = fs.openSync(path.join(directory, `${watchId}.log`), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    const child = spawn(process.execPath, args, { detached: true, cwd: cliCwd(),
      env: { ...cliEnv(), AKK_NATIVE_CLAUDE_CONFIG_DIRS: JSON.stringify(options.claudeConfigDirs),
        ...(options.claudeBin ? { AKK_NATIVE_CLAUDE_BIN: options.claudeBin } : {}),
        ...(options.pythonBin ? { AKK_NATIVE_CLAUDE_PYTHON: options.pythonBin } : {}) }, stdio: ["ignore", fd, fd, "ipc"] });
    return await new Promise<number>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => finish(new Error("Claude CLI monitor readiness timed out")), 5000);
      const finish = (error?: Error, pid?: number) => {
        if (finished) return; finished = true; clearTimeout(timer);
        child.removeAllListeners("message"); child.removeAllListeners("exit"); child.removeAllListeners("error");
        if (child.connected) child.disconnect(); child.unref();
        if (error) reject(error); else resolve(pid!);
      };
      child.once("error", error => finish(error));
      child.once("exit", () => finish(new Error("Claude CLI monitor exited before readiness")));
      child.on("message", value => {
        const message = value as { watchId?: string; ready?: boolean; pid?: number };
        if (message?.watchId === watchId && message.ready === true && Number.isSafeInteger(message.pid) && message.pid! > 1) finish(undefined, message.pid);
      });
    });
  } finally { fs.closeSync(fd); }
}

function announce(watchId: string, pid: number): void {
  // Losing the launching controller must not stop a durable observer.
  if (!process.connected || !process.send) return;
  try { process.send({ watchId, ready: true, pid }, () => {}); } catch { /* Parent already disconnected. */ }
}

/** Runtime fences the saved PID/start/session and cannot substitute a later resumed process. */
export async function runClaudeNativeMonitor(watchId: string, options: ClaudeNativeRuntimeOptions): Promise<void> {
  if (!isClaudeNativeWatchId(watchId)) throw new Error("Invalid Claude CLI Watch ID");
  const directory = path.join(options.storeDir, "claude-native-monitors"); ensureDir(directory);
  const locks = createFileLockCliAdapter({ now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync });
  const runtime = createClaudeNativeRuntime(options), lockPath = path.join(directory, `${watchId}.lock`);
  let release: (() => void) | undefined;
  try {
    runtime.tasks.status(watchId);
    try { release = locks.acquire(lockPath, { timeoutMs: 100 }); }
    catch (error) {
      const owner = locks.owner(lockPath);
      if (owner.pid && owner.pid !== cliPid() && !locks.stale(lockPath)) { announce(watchId, owner.pid); return; }
      throw error;
    }
    // This acknowledges observer ownership only, never native acceptance or success.
    announce(watchId, cliPid());
    let lastErrorAt = -Infinity;
    await pollClaudeNativeMonitor(watchId, runtime.tasks, { onError: () => {
      if (cliNowMs() - lastErrorAt < 30_000) return;
      lastErrorAt = cliNowMs();
      process.stderr.write("Claude CLI monitor could not reconcile; retrying the existing durable Watch.\n");
    } });
  } finally { try { release?.(); } finally { await runtime.close(); } }
}
