// Descriptor identity and stable byte reads for legacy Codex rollouts.
import {
  type CodexRolloutIdentity,
  parsedInteger,
} from "./terminal-submission-facts.js";
import fs from "node:fs";
import path from "node:path";

export const CODEX_COMPLETION_MAX_BYTES = 256 * 1024 * 1024;

const CODEX_ROLLOUT_HEADER_MAX_BYTES = 1024 * 1024;

const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;

export function readCodexRolloutHeader(fd: number, size: number): Buffer {
  const bytesToRead = Math.min(size, CODEX_ROLLOUT_HEADER_MAX_BYTES);
  const buffer = readExactBytes(fd, 0, bytesToRead);
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) {
    throw new Error("Codex active-task rollout header exceeded the safe read limit");
  }
  return buffer.subarray(0, newline + 1);
}

export function readExactBytes(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const read = fs.readSync(fd, buffer, total, length - total, offset + total);
    if (read === 0) {
      break;
    }
    total += read;
  }
  if (total !== length) {
    throw new Error("Codex rollout changed while it was being read");
  }
  return buffer;
}

export function openExactRollout(rollout: CodexRolloutIdentity): {
  fd: number;
  stat: fs.Stats;
} {
  if (!path.isAbsolute(rollout.path)) {
    throw new Error("Codex rollout path is not absolute");
  }
  const before = fs.lstatSync(rollout.path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Codex rollout path is not a regular file");
  }
  const fd = fs.openSync(
    rollout.path,
    fs.constants.O_RDONLY | NO_FOLLOW_FLAG
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      BigInt(stat.dev) !== parsedInteger(rollout.device) ||
      BigInt(stat.ino) !== parsedInteger(rollout.inode)
    ) {
      throw new Error("Codex rollout descriptor identity does not match its open file");
    }
    return { fd, stat };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function assertPrivateRegularFile(stat: fs.Stats): void {
  if (!stat.isFile()) {
    throw new Error("Codex rollout is not a regular file");
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error("Codex rollout is not owned by the current user");
  }
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error("Codex rollout is writable by another user");
  }
}

export function fileEndsWithNewline(fd: number, size: number): boolean {
  if (size <= 0) {
    return true;
  }
  const last = Buffer.allocUnsafe(1);
  return fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a;
}

export function byteAtOffset(fd: number, offset: number): number | undefined {
  const buffer = Buffer.allocUnsafe(1);
  return fs.readSync(fd, buffer, 0, 1, offset) === 1
    ? buffer[0]
    : undefined;
}

export function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

export function sameRolloutIdentity(
  left: CodexRolloutIdentity,
  right: CodexRolloutIdentity
): boolean {
  return left.fd === right.fd &&
    sameRolloutFileIdentity(left, right);
}

export function sameRolloutFileIdentity(
  left: CodexRolloutIdentity,
  right: CodexRolloutIdentity
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.path === right.path;
}
