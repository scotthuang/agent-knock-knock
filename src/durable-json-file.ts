import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;

export interface AtomicJsonFileOptions {
  rootLabel: string;
  directoryLabel: string;
  fileLabel: string;
  ensureDirectory: (directory: string) => void;
  fsyncNewRootParent?: boolean;
  fsyncNewDirectoryParent?: boolean;
}

/** Atomically replace one private JSON record without following symlinks. */
export function atomicSaveJsonFile(
  filePath: string,
  value: unknown,
  options: AtomicJsonFileOptions
): void {
  const root = path.dirname(path.dirname(filePath));
  const directory = path.dirname(filePath);
  const rootExisted = fs.existsSync(root);
  options.ensureDirectory(root);
  assertRealDirectory(root, options.rootLabel);
  if (!rootExisted && options.fsyncNewRootParent) {
    fsyncDirectory(path.dirname(root));
  }

  const directoryExisted = fs.existsSync(directory);
  options.ensureDirectory(directory);
  if (!directoryExisted && options.fsyncNewDirectoryParent) {
    fsyncDirectory(root);
  }
  assertRealDirectory(directory, options.directoryLabel);
  assertRegularOrAbsent(filePath, options.fileLabel);

  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        NO_FOLLOW_FLAG,
      PRIVATE_FILE_MODE
    );
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertRegularOrAbsent(filePath, options.fileLabel);
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

/** Read one regular private JSON record without following its final path. */
export function readJsonFileNoFollow(filePath: string, label: string): unknown {
  assertRealDirectory(path.dirname(path.dirname(filePath)), `${label} root`);
  assertRealDirectory(path.dirname(filePath), `${label} directory`);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`${label} must be a regular file: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

export function assertRealDirectory(value: string, label: string): void {
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${value}`);
  }
}

function assertRegularOrAbsent(value: string, label: string): void {
  try {
    const stat = fs.lstatSync(value);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${label} must be a regular file: ${value}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    fs.fsyncSync(fd);
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(String(code))) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function isNodeError(
  error: unknown,
  code?: string
): error is NodeJS.ErrnoException {
  return error instanceof Error &&
    "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code);
}
