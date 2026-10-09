import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ensureDir } from "./store.js";
import { cliCwd, cliEnv, cliNow, cliNowMs, cliPid, cliSleep, cliSleepSync } from "./cli-runtime-context.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { desktopTaskNeedsReconciliation } from "./desktop-task-service.js";
import { createDesktopRuntime, type DesktopRuntimeOptions } from "./desktop-runtime.js";
import { isDesktopWatchId } from "./desktop-semantic.js";

export async function launchDesktopMonitor(watchId: string, options: DesktopRuntimeOptions): Promise<number> {
  if (!isDesktopWatchId(watchId)) throw new Error("Invalid Desktop Watch ID");
  const args = [fileURLToPath(new URL("./cli.js", import.meta.url)), "monitor-desktop", "--watch", watchId,
    "--store-dir", options.storeDir];
  if (options.openclawBin) args.push("--openclaw-bin", options.openclawBin);
  const directory = path.join(options.storeDir, "desktop-monitors");
  ensureDir(directory);
  const fd = fs.openSync(path.join(directory, `${watchId}.log`), fs.constants.O_CREAT | fs.constants.O_APPEND |
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const child = spawn(process.execPath, args, { detached: true, cwd: cliCwd(),
      env: { ...cliEnv(), AKK_DESKTOP_CODEX_HOMES: JSON.stringify(options.codexHomes) }, stdio: ["ignore", fd, fd, "ipc"] });
    const pid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Desktop monitor readiness timed out")), 5000);
      const finish = (error?: Error, pid?: number) => {
        clearTimeout(timer); child.removeAllListeners("message"); child.removeAllListeners("exit");
        if (child.connected) child.disconnect(); child.unref();
        if (error) reject(error); else resolve(pid!);
      };
      child.once("error", error => finish(error));
      child.once("exit", () => finish(new Error("Desktop monitor exited before readiness")));
      child.on("message", value => {
        const message = value as { watchId?: string; pid?: number; ready?: boolean };
        if (message.watchId === watchId && message.ready === true && Number.isSafeInteger(message.pid) && message.pid! > 1) {
          finish(undefined, message.pid);
        }
      });
    });
    return pid;
  } finally { fs.closeSync(fd); }
}

/** One detached observer per Watch; host sweeps independently repair missed work. */
export async function runDesktopMonitor(watchId: string, options: DesktopRuntimeOptions): Promise<void> {
  if (!isDesktopWatchId(watchId)) throw new Error("Invalid Desktop Watch ID");
  const directory = path.join(options.storeDir, "desktop-monitors");
  ensureDir(directory);
  const locks = createFileLockCliAdapter({ now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync });
  const initial = createDesktopRuntime(options);
  try { initial.tasks.status(watchId); } finally { await initial.close(); }
  const lockPath = path.join(directory, `${watchId}.lock`);
  let release: () => void;
  try { release = locks.acquire(lockPath, { timeoutMs: 100 }); }
  catch (error) {
    const owner = locks.owner(lockPath);
    if (owner.pid && owner.pid !== cliPid() && !locks.stale(lockPath)) {
      process.send?.({ watchId, ready: true, pid: owner.pid }); return;
    }
    throw error;
  }
  try {
    process.send?.({ watchId, ready: true, pid: cliPid() });
    for (;;) {
      const runtime = createDesktopRuntime(options);
      let pending: boolean;
      try { pending = desktopTaskNeedsReconciliation(await runtime.tasks.reconcile(watchId)); }
      finally { await runtime.close(); }
      if (!pending) return;
      await cliSleep(2000);
    }
  } finally { release(); }
}
