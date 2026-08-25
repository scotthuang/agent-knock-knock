import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicSaveJsonFile } from "../src/durable-json-file.js";

import {
  createTerminalDelegateSendBindingRepository,
  TerminalDelegateSendBindingConflictError,
  TerminalDelegateSendBindingUncertainError,
  type TerminalDelegateSendRequestBoundary,
  type TerminalDelegateSendTargetBoundary
} from "../src/terminal-delegate-send-binding.js";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture(): {
  root: string;
  runtimeDir: string;
  boundary: TerminalDelegateSendRequestBoundary;
  target: TerminalDelegateSendTargetBoundary;
} {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-delegate-send-binding-"
  ));
  const runtimeDir = path.join(root, "runtime");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  return {
    root,
    runtimeDir,
    boundary: {
      messageId: "openclaw-tool-message-1",
      requestHash: hash("private request body"),
      requestedWorkspace: path.join(root, "requested-workspace"),
      requestedAgent: "codex",
      openclawSession: "agent:main:binding-test"
    },
    target: {
      terminalId: "terminal:v2:tmux:codex:work:0.0:4100",
      workspace: path.join(root, "terminal-workspace"),
      terminalRuntimeKey: "tmux:socket:work:%42",
      physicalToken: hash("physical terminal A")
    }
  };
}

test("locks discovery and immutably binds one omitted-target route", (t) => {
  const { root, runtimeDir, boundary, target } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalDelegateSendBindingRepository({
    runtimeDir,
    now: () => new Date("2026-08-25T03:04:05.000Z")
  });

  const release = repository.acquire(boundary.messageId);
  let reserved;
  try {
    assert.equal(repository.load(boundary), undefined);
    reserved = repository.bind(boundary, target);
  } finally {
    release();
  }
  assert.equal(reserved.outcome, "reserved");
  assert.deepEqual(reserved.binding, {
    ...boundary,
    ...target,
    reservedAt: "2026-08-25T03:04:05.000Z"
  });

  const filePath = repository.pathFor(boundary);
  const serialized = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(serialized, /private request body/u);
  assert.match(serialized, new RegExp(boundary.requestHash, "u"));
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
  assert.deepEqual(repository.load(boundary), reserved.binding);

  const releaseReplay = repository.acquire(boundary.messageId);
  try {
    const replay = repository.bind(boundary, target);
    assert.equal(replay.outcome, "replay");
    assert.deepEqual(replay.binding, reserved.binding);
  } finally {
    releaseReplay();
  }
});

test("same message id cannot move to another physical terminal", (t) => {
  const { root, runtimeDir, boundary, target } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalDelegateSendBindingRepository({ runtimeDir });
  const release = repository.acquire(boundary.messageId);
  try {
    repository.bind(boundary, target);
  } finally {
    release();
  }

  const otherTarget = {
    ...target,
    terminalId: "terminal:v2:tmux:codex:other:0.0:4200",
    terminalRuntimeKey: "tmux:socket:other:%84",
    physicalToken: hash("physical terminal B")
  };
  assert.equal(
    repository.pathFor(boundary),
    repository.pathFor({ messageId: boundary.messageId }),
    "the path must be globally keyed only by message id"
  );
  const releaseConflict = repository.acquire(boundary.messageId);
  try {
    assert.throws(
      () => repository.bind(boundary, otherTarget),
      (error: unknown) =>
        error instanceof TerminalDelegateSendBindingConflictError &&
        /different physical terminal/u.test(error.message)
    );
  } finally {
    releaseConflict();
  }
  assert.equal(repository.load(boundary)?.terminalId, target.terminalId);
});

test("same message id cannot change request or delegate scope", (t) => {
  const { root, runtimeDir, boundary, target } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalDelegateSendBindingRepository({ runtimeDir });
  const release = repository.acquire(boundary.messageId);
  try {
    repository.bind(boundary, target);
  } finally {
    release();
  }

  const conflicts: Array<{
    boundary: TerminalDelegateSendRequestBoundary;
    message: RegExp;
  }> = [
    {
      boundary: { ...boundary, requestHash: hash("different request") },
      message: /different delegate request hash/u
    },
    {
      boundary: {
        ...boundary,
        requestedWorkspace: path.join(root, "other-workspace")
      },
      message: /different delegate request scope/u
    },
    {
      boundary: { ...boundary, requestedAgent: "claude" },
      message: /different delegate request scope/u
    },
    {
      boundary: { ...boundary, openclawSession: "agent:other:session" },
      message: /different delegate request scope/u
    }
  ];
  for (const conflict of conflicts) {
    assert.throws(
      () => repository.load(conflict.boundary),
      (error: unknown) =>
        error instanceof TerminalDelegateSendBindingConflictError &&
        conflict.message.test(error.message)
    );
  }
});

test("bind requires the global message lock", (t) => {
  const { root, runtimeDir, boundary, target } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalDelegateSendBindingRepository({ runtimeDir });

  assert.throws(
    () => repository.bind(boundary, target),
    (error: unknown) =>
      error instanceof TerminalDelegateSendBindingUncertainError &&
      /requires its global message lock/u.test(error.message)
  );
  assert.equal(fs.existsSync(repository.pathFor(boundary)), false);
});

test("malformed or symlinked same-id bindings fail closed", (t) => {
  const malformed = fixture();
  const symlinked = fixture();
  t.after(() => fs.rmSync(malformed.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(symlinked.root, { recursive: true, force: true }));

  const malformedRepository = createTerminalDelegateSendBindingRepository({
    runtimeDir: malformed.runtimeDir
  });
  const malformedPath = malformedRepository.pathFor(malformed.boundary);
  fs.mkdirSync(path.dirname(malformedPath), {
    recursive: true,
    mode: 0o700
  });
  const malformedContents = '{"request":"must-not-be-accepted"}\n';
  fs.writeFileSync(malformedPath, malformedContents, { mode: 0o600 });
  const releaseMalformed = malformedRepository.acquire(
    malformed.boundary.messageId
  );
  try {
    assert.throws(
      () => malformedRepository.bind(malformed.boundary, malformed.target),
      (error: unknown) =>
        error instanceof TerminalDelegateSendBindingUncertainError &&
        /unsupported field request/u.test(error.message)
    );
  } finally {
    releaseMalformed();
  }
  assert.equal(fs.readFileSync(malformedPath, "utf8"), malformedContents);

  const symlinkRepository = createTerminalDelegateSendBindingRepository({
    runtimeDir: symlinked.runtimeDir
  });
  const symlinkPath = symlinkRepository.pathFor(symlinked.boundary);
  fs.mkdirSync(path.dirname(symlinkPath), {
    recursive: true,
    mode: 0o700
  });
  const targetPath = path.join(symlinked.root, "target.json");
  fs.writeFileSync(targetPath, "{}\n", { mode: 0o600 });
  fs.symlinkSync(targetPath, symlinkPath);
  const releaseSymlink = symlinkRepository.acquire(
    symlinked.boundary.messageId
  );
  try {
    assert.throws(
      () => symlinkRepository.bind(symlinked.boundary, symlinked.target),
      (error: unknown) =>
        error instanceof TerminalDelegateSendBindingUncertainError &&
        /must be a regular file/u.test(error.message)
    );
  } finally {
    releaseSymlink();
  }
  assert.equal(fs.readFileSync(targetPath, "utf8"), "{}\n");
});

test("fresh lock storage failure is explicitly degradable", (t) => {
  const { root, runtimeDir, boundary } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalDelegateSendBindingRepository({
    runtimeDir,
    acquireLock() {
      throw new Error("binding lock unavailable");
    }
  });

  assert.throws(
    () => repository.acquire(boundary.messageId),
    (error: unknown) =>
      error instanceof TerminalDelegateSendBindingUncertainError &&
      error.possibleExistingBinding === false &&
      /binding lock unavailable/u.test(error.message)
  );
  assert.equal(fs.existsSync(repository.pathFor(boundary)), false);
});

test("same-message lock contention remains fail-closed", (t) => {
  const { root, runtimeDir, boundary } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalDelegateSendBindingRepository({
    runtimeDir,
    acquireLock() {
      throw Object.assign(new Error("binding lock timed out"), {
        code: "LOCK_TIMEOUT"
      });
    }
  });

  assert.throws(
    () => repository.acquire(boundary.messageId),
    (error: unknown) =>
      error instanceof TerminalDelegateSendBindingUncertainError &&
      error.possibleExistingBinding === true &&
      /binding lock timed out/u.test(error.message)
  );
});

test("a fresh post-commit binding fault remains degradable before input", (t) => {
  const { root, runtimeDir, boundary, target } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalDelegateSendBindingRepository({
    runtimeDir,
    saveJson(filePath, value, options) {
      atomicSaveJsonFile(filePath, value, options);
      throw new Error("post-commit binding fsync failed");
    }
  });
  const release = repository.acquire(boundary.messageId);
  try {
    assert.throws(
      () => repository.bind(boundary, target),
      (error: unknown) =>
        error instanceof TerminalDelegateSendBindingUncertainError &&
        error.possibleExistingBinding === false &&
        /post-commit binding fsync failed/u.test(error.message)
    );
  } finally {
    release();
  }

  const cleanReader = createTerminalDelegateSendBindingRepository({
    runtimeDir
  });
  assert.equal(cleanReader.load(boundary)?.terminalId, target.terminalId);
});
