import { randomUUID } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { isRecord, nonBlankString } from "./value-guards.js";

const PRIVATE_LOCK_FILE_MODE = 0o600;
const STALE_LOCK_AGE_MS = 30_000;

export type FileLockAcquisitionOptions = Readonly<{
  timeoutMs?: number; retryMs?: number;
}>;

export type FileLockOwner = Readonly<{ pid?: number; token?: string }>;

export interface FileLockCliRuntime {
  now(): Date;
  nowMs(): number;
  pid(): number;
  sleepSync(milliseconds: number): void;
  nonce?(): string;
  signalProcess?(pid: number): void;
}

export interface FileLockFileSystem {
  readonly constants: Readonly<{
    O_CREAT: number; O_EXCL: number; O_WRONLY: number; O_NOFOLLOW?: number;
  }>;
  openSync(filePath: string, flags: number, mode: number): number;
  fchmodSync(fd: number, mode: number): void;
  writeFileSync(fd: number, data: string, encoding: "utf8"): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  lstatSync(filePath: string): Readonly<{
    isSymbolicLink(): boolean; isFile(): boolean; mtimeMs: number;
  }>;
  unlinkSync(filePath: string): void;
  readFileSync(filePath: string, encoding: "utf8"): string;
}

export interface FileLockCliAdapter {
  acquire(lockPath: string, options?: FileLockAcquisitionOptions): () => void;
  stale(lockPath: string): boolean;
  owner(lockPath: string): FileLockOwner;
}

/** Bind the synchronous file-lock protocol to one CLI runtime boundary. */
export function createFileLockCliAdapter(
  runtime: FileLockCliRuntime,
  fileSystem: FileLockFileSystem = fs
): FileLockCliAdapter {
  const noFollowFlag = typeof fileSystem.constants.O_NOFOLLOW === "number"
    ? fileSystem.constants.O_NOFOLLOW
    : 0;
  const exclusiveWriteFlags = fileSystem.constants.O_CREAT |
    fileSystem.constants.O_EXCL | fileSystem.constants.O_WRONLY | noFollowFlag;
  const nonce = runtime.nonce ?? randomUUID;
  const signalProcess = runtime.signalProcess ?? ((pid: number) => {
    process.kill(pid, 0);
  });

  function owner(lockPath: string): FileLockOwner {
    try {
      const text = fileSystem.readFileSync(lockPath, "utf8").trim();
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed)) {
          const pid = Number(parsed.pid);
          return {
            pid: Number.isSafeInteger(pid) && pid > 1 ? pid : undefined,
            token: nonBlankString(parsed.token)
          };
        }
      } catch {
        // Legacy locks contained only the owner PID.
      }
      const legacyPid = Number(text);
      return {
        pid: Number.isSafeInteger(legacyPid) && legacyPid > 1 ? legacyPid : undefined
      };
    } catch {
      return {};
    }
  }

  function stale(lockPath: string): boolean {
    try {
      const stat = fileSystem.lstatSync(lockPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`file lock must be a regular file, not a symlink: ${lockPath}`);
      }
      const lockOwner = owner(lockPath);
      if (lockOwner.pid !== undefined) {
        try {
          signalProcess(lockOwner.pid);
          return false;
        } catch (error) {
          return isRecord(error) && error.code === "ESRCH";
        }
      }
      return runtime.nowMs() - stat.mtimeMs > STALE_LOCK_AGE_MS;
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT";
    }
  }

  function reclaim(lockPath: string): boolean {
    const reclaimPath = `${lockPath}.reclaim`;
    let reclaimFd: number | undefined;
    try {
      reclaimFd = fileSystem.openSync(
        reclaimPath, exclusiveWriteFlags, PRIVATE_LOCK_FILE_MODE
      );
      fileSystem.fchmodSync(reclaimFd, PRIVATE_LOCK_FILE_MODE);
      fileSystem.writeFileSync(reclaimFd, `${runtime.pid()}\n`, "utf8");
      fileSystem.fsyncSync(reclaimFd);
    } catch (error) {
      if (reclaimFd !== undefined) fileSystem.closeSync(reclaimFd);
      if (isRecord(error) && error.code === "EEXIST") return false;
      throw error;
    }

    try {
      if (!stale(lockPath)) return false;
      try {
        fileSystem.unlinkSync(lockPath);
        return true;
      } catch (error) {
        return isRecord(error) && error.code === "ENOENT";
      }
    } finally {
      fileSystem.closeSync(reclaimFd);
      try {
        fileSystem.unlinkSync(reclaimPath);
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  function release(lockPath: string, token: string): void {
    try {
      if (owner(lockPath).token !== token) return;
      fileSystem.unlinkSync(lockPath);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  function acquire(
    lockPath: string,
    { timeoutMs = 5000, retryMs = 50 }: FileLockAcquisitionOptions = {}
  ): () => void {
    const started = runtime.nowMs();
    const token = nonce();

    while (true) {
      let fd: number | undefined;
      try {
        fd = fileSystem.openSync(
          lockPath, exclusiveWriteFlags, PRIVATE_LOCK_FILE_MODE
        );
        fileSystem.fchmodSync(fd, PRIVATE_LOCK_FILE_MODE);
        const contents = JSON.stringify({
          pid: runtime.pid(), token, created_at: runtime.now().toISOString()
        });
        fileSystem.writeFileSync(fd, `${contents}\n`, "utf8");
        fileSystem.fsyncSync(fd);
        fileSystem.closeSync(fd);
        fd = undefined;
        return () => release(lockPath, token);
      } catch (error) {
        if (fd !== undefined) fileSystem.closeSync(fd);
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
        if (reclaim(lockPath)) {
          continue;
        }
        if (runtime.nowMs() - started >= timeoutMs) {
          throw Object.assign(new Error(
            `timed out waiting for file lock: ${lockPath}`
          ), { code: "LOCK_TIMEOUT" });
        }
        runtime.sleepSync(retryMs);
      }
    }
  }

  return Object.freeze({ acquire, stale, owner });
}
