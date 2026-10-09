import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ensureDir } from "./store.js";
import { cliCwd, cliEnv, cliNow, cliNowMs, cliPid, cliSleep, cliSleepSync } from "./cli-runtime-context.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { codexNativeTaskNeedsReconciliation } from "./codex-native-task-service.js";
import { isCodexNativeWatchId } from "./codex-native-state-store.js";
import { createCodexNativeRuntime, type CodexNativeRuntimeOptions } from "./codex-native-runtime.js";

export async function launchCodexNativeMonitor(watchId: string, options: CodexNativeRuntimeOptions): Promise<number> {
  if (!isCodexNativeWatchId(watchId)) throw new Error("Invalid Codex CLI Watch ID");
  const args = [fileURLToPath(new URL("./cli.js", import.meta.url)), "monitor-codex-native", "--watch", watchId, "--store-dir", options.storeDir];
  if (options.openclawBin) args.push("--openclaw-bin", options.openclawBin);
  const directory = path.join(options.storeDir, "codex-native-monitors"); ensureDir(directory);
  const fd = fs.openSync(path.join(directory, `${watchId}.log`), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const child = spawn(process.execPath, args, { detached: true, cwd: cliCwd(),
      env: { ...cliEnv(), AKK_NATIVE_CODEX_HOMES: JSON.stringify(options.codexHomes) }, stdio: ["ignore", fd, fd, "ipc"] });
    return await new Promise<number>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => finish(new Error("Codex CLI monitor readiness timed out")), 5000);
      const finish = (error?: Error, pid?: number) => {
        if (finished) return; finished = true; clearTimeout(timer);
        child.removeAllListeners("message"); child.removeAllListeners("exit"); child.removeAllListeners("error");
        if (child.connected) child.disconnect(); child.unref();
        if (error) reject(error); else resolve(pid!);
      };
      child.once("error", error => finish(error));
      child.once("exit", () => finish(new Error("Codex CLI monitor exited before readiness")));
      child.on("message", value => {
        const message = value as { watchId?: string; ready?: boolean; pid?: number };
        if (message.watchId === watchId && message.ready === true && Number.isSafeInteger(message.pid) && message.pid! > 1) finish(undefined, message.pid);
      });
    });
  } finally { fs.closeSync(fd); }
}

/** Keep one scoped observer connected; polling recovers exact turn state after missed events. */
export async function runCodexNativeMonitor(watchId: string, options: CodexNativeRuntimeOptions): Promise<void> {
  if (!isCodexNativeWatchId(watchId)) throw new Error("Invalid Codex CLI Watch ID");
  const directory = path.join(options.storeDir, "codex-native-monitors"); ensureDir(directory);
  const locks = createFileLockCliAdapter({ now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync });
  const runtime = createCodexNativeRuntime(options);
  const lockPath = path.join(directory, `${watchId}.lock`);
  let release: (() => void) | undefined;
  try {
    runtime.tasks.status(watchId);
    try { release = locks.acquire(lockPath, { timeoutMs: 100 }); }
    catch (error) {
      const owner = locks.owner(lockPath);
      if (owner.pid && owner.pid !== cliPid() && !locks.stale(lockPath)) { process.send?.({ watchId, ready: true, pid: owner.pid }); return; }
      throw error;
    }
    // Readiness acknowledges durable observer ownership, not native task acceptance or completion.
    process.send?.({ watchId, ready: true, pid: cliPid() });
    for (;;) {
      const task = await runtime.reconcile(watchId);
      if (!codexNativeTaskNeedsReconciliation(task)) return;
      await cliSleep(2000);
    }
  } finally { release?.(); await runtime.close(); }
}
