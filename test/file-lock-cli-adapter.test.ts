import test from "node:test";
import assert from "node:assert/strict";
import {
  createFileLockCliAdapter,
  type FileLockCliRuntime,
  type FileLockFileSystem
} from "../src/file-lock-cli-adapter.js";

function unused(operation: string): never {
  throw new Error(`unexpected file-lock operation: ${operation}`);
}

function fileSystem(
  overrides: Partial<FileLockFileSystem>
): FileLockFileSystem {
  return {
    constants: { O_CREAT: 1, O_EXCL: 2, O_WRONLY: 4, O_NOFOLLOW: 8 },
    openSync: () => unused("open"),
    fchmodSync: () => unused("chmod"),
    writeFileSync: () => unused("write"),
    fsyncSync: () => unused("fsync"),
    closeSync: () => unused("close"),
    lstatSync: () => unused("lstat"),
    unlinkSync: () => unused("unlink"),
    readFileSync: () => unused("read"),
    ...overrides
  };
}

function runtime(
  overrides: Partial<FileLockCliRuntime> = {}
): FileLockCliRuntime {
  return {
    now: () => new Date("2026-08-15T01:02:03.004Z"),
    nowMs: () => 1_000,
    pid: () => 4242,
    sleepSync: () => unused("sleep"),
    nonce: () => "token-1",
    signalProcess: () => unused("signal"),
    ...overrides
  };
}

function errorWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

test("file lock acquisition and token-matched release preserve exact private write order", () => {
  const calls: string[] = [];
  let lockBytes = "";
  const adapter = createFileLockCliAdapter(runtime(), fileSystem({
    openSync(filePath, flags, mode) {
      calls.push(`open:${filePath}:${flags}:${mode}`);
      return 11;
    },
    fchmodSync(fd, mode) {
      calls.push(`chmod:${fd}:${mode}`);
    },
    writeFileSync(fd, data, encoding) {
      calls.push(`write:${fd}:${encoding}`);
      lockBytes = data;
    },
    fsyncSync(fd) {
      calls.push(`fsync:${fd}`);
    },
    closeSync(fd) {
      calls.push(`close:${fd}`);
    },
    readFileSync(filePath, encoding) {
      calls.push(`read:${filePath}:${encoding}`);
      return lockBytes;
    },
    unlinkSync(filePath) {
      calls.push(`unlink:${filePath}`);
    }
  }));

  const release = adapter.acquire("/locks/one");
  const originalLockBytes = lockBytes;
  assert.equal(
    lockBytes,
    '{"pid":4242,"token":"token-1","created_at":"2026-08-15T01:02:03.004Z"}\n'
  );
  assert.deepEqual(calls, [
    "open:/locks/one:15:384",
    "chmod:11:384",
    "write:11:utf8",
    "fsync:11",
    "close:11"
  ]);

  lockBytes = '{"pid":5151,"token":"replacement"}\n';
  release();
  assert.deepEqual(calls.slice(5), [
    "read:/locks/one:utf8"
  ]);
  lockBytes = originalLockBytes;
  release();
  assert.deepEqual(calls.slice(6), [
    "read:/locks/one:utf8",
    "unlink:/locks/one"
  ]);
});

test("live lock timeout cleans the reclaim guard before preserving timeout priority", () => {
  const calls: string[] = [];
  const times = [1_000, 1_000, 1_005];
  const adapter = createFileLockCliAdapter(runtime({
    nowMs() {
      const value = times.shift();
      assert.notEqual(value, undefined);
      return value!;
    },
    sleepSync(milliseconds) {
      calls.push(`sleep:${milliseconds}`);
    },
    signalProcess(pid) {
      calls.push(`signal:${pid}`);
    }
  }), fileSystem({
    openSync(filePath) {
      calls.push(`open:${filePath}`);
      if (filePath === "/locks/live") {
        throw errorWithCode("EEXIST");
      }
      return 22;
    },
    fchmodSync(fd) {
      calls.push(`chmod:${fd}`);
    },
    writeFileSync(fd, data) {
      calls.push(`write:${fd}:${data}`);
    },
    fsyncSync(fd) {
      calls.push(`fsync:${fd}`);
    },
    lstatSync(filePath) {
      calls.push(`lstat:${filePath}`);
      return {
        isSymbolicLink: () => false,
        isFile: () => true,
        mtimeMs: 0
      };
    },
    readFileSync(filePath) {
      calls.push(`read:${filePath}`);
      return '{"pid":99,"token":"held"}\n';
    },
    closeSync(fd) {
      calls.push(`close:${fd}`);
    },
    unlinkSync(filePath) {
      calls.push(`unlink:${filePath}`);
    }
  }));

  assert.throws(
    () => adapter.acquire("/locks/live", { timeoutMs: 5, retryMs: 2 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "LOCK_TIMEOUT");
      assert.match((error as Error).message, /\/locks\/live/u);
      return true;
    }
  );
  assert.deepEqual(calls, [
    "open:/locks/live",
    "open:/locks/live.reclaim",
    "chmod:22",
    "write:22:4242\n",
    "fsync:22",
    "lstat:/locks/live",
    "read:/locks/live",
    "signal:99",
    "close:22",
    "unlink:/locks/live.reclaim",
    "sleep:2",
    "open:/locks/live",
    "open:/locks/live.reclaim",
    "chmod:22",
    "write:22:4242\n",
    "fsync:22",
    "lstat:/locks/live",
    "read:/locks/live",
    "signal:99",
    "close:22",
    "unlink:/locks/live.reclaim"
  ]);
  assert.deepEqual(times, []);
});

test("dead-owner reclaim releases its guard before retrying the original lock", () => {
  const calls: string[] = [];
  let originalAttempts = 0;
  const adapter = createFileLockCliAdapter(runtime({
    signalProcess(pid) {
      calls.push(`signal:${pid}`);
      throw errorWithCode("ESRCH");
    }
  }), fileSystem({
    openSync(filePath) {
      calls.push(`open:${filePath}`);
      if (filePath === "/locks/stale" && originalAttempts++ === 0) {
        throw errorWithCode("EEXIST");
      }
      return filePath.endsWith(".reclaim") ? 22 : 11;
    },
    fchmodSync(fd) {
      calls.push(`chmod:${fd}`);
    },
    writeFileSync(fd, data) {
      calls.push(`write:${fd}:${data.startsWith("{") ? "owner" : data}`);
    },
    fsyncSync(fd) {
      calls.push(`fsync:${fd}`);
    },
    lstatSync(filePath) {
      calls.push(`lstat:${filePath}`);
      return {
        isSymbolicLink: () => false,
        isFile: () => true,
        mtimeMs: 0
      };
    },
    readFileSync(filePath) {
      calls.push(`read:${filePath}`);
      return '{"pid":77,"token":"old"}\n';
    },
    closeSync(fd) {
      calls.push(`close:${fd}`);
    },
    unlinkSync(filePath) {
      calls.push(`unlink:${filePath}`);
    }
  }));

  adapter.acquire("/locks/stale");
  assert.deepEqual(calls, [
    "open:/locks/stale",
    "open:/locks/stale.reclaim",
    "chmod:22",
    "write:22:4242\n",
    "fsync:22",
    "lstat:/locks/stale",
    "read:/locks/stale",
    "signal:77",
    "unlink:/locks/stale",
    "close:22",
    "unlink:/locks/stale.reclaim",
    "open:/locks/stale",
    "chmod:11",
    "write:11:owner",
    "fsync:11",
    "close:11"
  ]);
});

test("an acquisition write error closes the opened descriptor before propagation", () => {
  const calls: string[] = [];
  const writeError = new Error("write failed");
  const adapter = createFileLockCliAdapter(runtime(), fileSystem({
    openSync() {
      calls.push("open");
      return 11;
    },
    fchmodSync() {
      calls.push("chmod");
    },
    writeFileSync() {
      calls.push("write");
      throw writeError;
    },
    closeSync(fd) {
      calls.push(`close:${fd}`);
    }
  }));

  assert.throws(() => adapter.acquire("/locks/error"), (error) => (
    error === writeError
  ));
  assert.deepEqual(calls, ["open", "chmod", "write", "close:11"]);
});
