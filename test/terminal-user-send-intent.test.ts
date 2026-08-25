import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicSaveJsonFile } from "../src/durable-json-file.js";

import {
  createTerminalUserSendIntentRepository,
  TerminalUserSendIntentBoundaryConflictError,
  TerminalUserSendIntentUncertainError,
  type TerminalUserSendIntentBoundary
} from "../src/terminal-user-send-intent.js";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture(): {
  root: string;
  runtimeDir: string;
  input: TerminalUserSendIntentBoundary;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-user-send-intent-"));
  const runtimeDir = path.join(root, "runtime");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  return {
    root,
    runtimeDir,
    input: {
      terminalRuntimeKey: "runtime-key-1",
      physicalToken: hash("physical-terminal-1"),
      messageId: "message-1",
      requestHash: hash("secret request body")
    }
  };
}

test("reserves privately without persisting the request body", (t) => {
  const { root, runtimeDir, input } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalUserSendIntentRepository({
    runtimeDir,
    now: () => new Date("2026-08-25T01:02:03.000Z")
  });

  const result = repository.reserve(input);
  assert.equal(result.outcome, "reserved");
  assert.equal(result.intent.stage, "reserved");
  const filePath = repository.pathFor(input);
  const serialized = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(serialized, /secret request body/u);
  assert.match(serialized, new RegExp(input.requestHash, "u"));
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);

  const retry = repository.reserve(input);
  assert.equal(retry.outcome, "uncertain");
  assert.equal(retry.stage, "reserved");
});

test("replays only after Enter dispatch completed", (t) => {
  const { root, runtimeDir, input } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const times = [
    "2026-08-25T01:00:00.000Z",
    "2026-08-25T01:00:01.000Z"
  ];
  let index = 0;
  const repository = createTerminalUserSendIntentRepository({
    runtimeDir,
    now: () => new Date(times[index++] as string)
  });

  repository.reserve(input);
  const completed = repository.complete(input, "managed");
  assert.equal(completed.stage, "enter_dispatched");
  assert.equal(completed.delivery_mode, "managed");
  assert.equal(completed.reserved_at, times[0]);
  assert.equal(completed.enter_dispatched_at, times[1]);
  assert.deepEqual(repository.complete(input, "managed"), completed);
  assert.throws(
    () => repository.complete(input, "unmanaged"),
    /another mode/u
  );

  const replay = repository.reserve(input);
  assert.equal(replay.outcome, "replay");
  assert.equal(replay.stage, "enter_dispatched");
});

test("cancels only a reservation that has provably sent no input", (t) => {
  const { root, runtimeDir, input } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalUserSendIntentRepository({ runtimeDir });

  repository.reserve(input);
  assert.equal(repository.cancelProvenZeroInput(input), true);
  assert.equal(repository.load(input)?.stage, "zero_input_cancelled");
  assert.equal(repository.cancelProvenZeroInput(input), false);
  assert.throws(
    () => repository.reserve({ ...input, requestHash: hash("changed body") }),
    /different request hash/u
  );
  assert.throws(
    () => repository.reserve({
      ...input,
      physicalToken: hash("changed terminal")
    }),
    /different physical terminal/u
  );

  assert.equal(repository.reserve(input).outcome, "reserved");
  repository.complete(input, "unmanaged");
  assert.throws(
    () => repository.cancelProvenZeroInput(input),
    /completed terminal user-send intent cannot be cancelled/u
  );
  assert.equal(repository.reserve(input).outcome, "replay");
});

test("same message id cannot change request or physical terminal", (t) => {
  const { root, runtimeDir, input } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalUserSendIntentRepository({ runtimeDir });
  repository.reserve(input);

  const otherTerminal = {
    ...input,
    terminalRuntimeKey: "runtime-key-2",
    physicalToken: hash("another physical terminal")
  };
  assert.equal(
    repository.pathFor(input),
    repository.pathFor(otherTerminal),
    "all terminal entry points must share one global same-message path"
  );

  assert.throws(
    () => repository.reserve({ ...input, requestHash: hash("another request") }),
    /different request hash/u
  );
  assert.throws(
    () => repository.reserve({
      ...input,
      physicalToken: hash("another terminal")
    }),
    /different physical terminal/u
  );
  assert.throws(
    () => repository.reserve(otherTerminal),
    (error: unknown) =>
      error instanceof TerminalUserSendIntentBoundaryConflictError
  );
});

test("same-message lock contention is uncertain but fresh storage failure is degradable", (t) => {
  const busy = fixture();
  const unavailable = fixture();
  t.after(() => fs.rmSync(busy.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(unavailable.root, { recursive: true, force: true }));

  const busyRepository = createTerminalUserSendIntentRepository({
    runtimeDir: busy.runtimeDir,
    acquireLock() {
      throw Object.assign(new Error("same-message lock timed out"), {
        code: "LOCK_TIMEOUT"
      });
    }
  });
  assert.throws(
    () => busyRepository.reserve(busy.input),
    (error: unknown) =>
      error instanceof TerminalUserSendIntentUncertainError &&
      /lock is busy/u.test(error.message)
  );

  const unavailableRepository = createTerminalUserSendIntentRepository({
    runtimeDir: unavailable.runtimeDir,
    acquireLock() {
      throw new Error("runtime filesystem unavailable");
    }
  });
  assert.throws(
    () => unavailableRepository.reserve(unavailable.input),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof TerminalUserSendIntentUncertainError) &&
      /runtime filesystem unavailable/u.test(error.message)
  );
});

test("an existing same-id intent stays fail-closed when its lock storage breaks", (t) => {
  const { root, runtimeDir, input } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writer = createTerminalUserSendIntentRepository({ runtimeDir });
  writer.reserve(input);
  writer.complete(input, "unmanaged");

  const inaccessible = createTerminalUserSendIntentRepository({
    runtimeDir,
    acquireLock() {
      throw Object.assign(new Error("intent lock permission denied"), {
        code: "EACCES"
      });
    }
  });
  assert.throws(
    () => inaccessible.reserve(input),
    (error: unknown) =>
      error instanceof TerminalUserSendIntentUncertainError &&
      /existing same-id.*permission denied/u.test(error.message)
  );
});

test("intent lock cleanup cannot override a durable reservation", (t) => {
  const { root, runtimeDir, input } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalUserSendIntentRepository({
    runtimeDir,
    acquireLock() {
      return () => { throw new Error("intent lock unlink failed"); };
    }
  });

  assert.equal(repository.reserve(input).outcome, "reserved");
  assert.equal(repository.load(input)?.stage, "reserved");
  assert.equal(repository.complete(input, "unmanaged").stage, "enter_dispatched");
});

test("a fresh post-commit save fault remains degradable before input", (t) => {
  const { root, runtimeDir, input } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createTerminalUserSendIntentRepository({
    runtimeDir,
    saveJson(filePath, value, options) {
      atomicSaveJsonFile(filePath, value, options);
      throw new Error("post-commit intent fsync failed");
    }
  });

  assert.throws(
    () => repository.reserve(input),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof TerminalUserSendIntentUncertainError) &&
      /post-commit intent fsync failed/u.test(error.message)
  );
  const cleanReader = createTerminalUserSendIntentRepository({ runtimeDir });
  assert.equal(cleanReader.load(input)?.stage, "reserved");
});

test("a cancelled zero-input intent save fault remains degradable", (t) => {
  const { root, runtimeDir, input } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writer = createTerminalUserSendIntentRepository({ runtimeDir });
  writer.reserve(input);
  writer.cancelProvenZeroInput(input);
  const unavailable = createTerminalUserSendIntentRepository({
    runtimeDir,
    saveJson() {
      throw new Error("replacement persistence unavailable");
    }
  });

  assert.throws(
    () => unavailable.reserve(input),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof TerminalUserSendIntentUncertainError) &&
      /replacement persistence unavailable/u.test(error.message)
  );
  assert.equal(writer.load(input)?.stage, "zero_input_cancelled");
});

test("does not replace malformed records or follow receipt symlinks", (t) => {
  const first = fixture();
  const second = fixture();
  t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }));

  const malformedRepository = createTerminalUserSendIntentRepository({
    runtimeDir: first.runtimeDir
  });
  const malformedPath = malformedRepository.pathFor(first.input);
  fs.mkdirSync(path.dirname(malformedPath), { recursive: true, mode: 0o700 });
  const malformed = '{"request":"must-not-be-accepted"}\n';
  fs.writeFileSync(malformedPath, malformed, { mode: 0o600 });
  assert.throws(
    () => malformedRepository.reserve(first.input),
    (error: unknown) =>
      error instanceof TerminalUserSendIntentUncertainError &&
      /unsupported field request/u.test(error.message)
  );
  assert.equal(fs.readFileSync(malformedPath, "utf8"), malformed);

  const symlinkRepository = createTerminalUserSendIntentRepository({
    runtimeDir: second.runtimeDir
  });
  const symlinkPath = symlinkRepository.pathFor(second.input);
  fs.mkdirSync(path.dirname(symlinkPath), { recursive: true, mode: 0o700 });
  const target = path.join(second.root, "target.json");
  fs.writeFileSync(target, "{}\n", { mode: 0o600 });
  fs.symlinkSync(target, symlinkPath);
  assert.throws(
    () => symlinkRepository.reserve(second.input),
    (error: unknown) =>
      error instanceof TerminalUserSendIntentUncertainError &&
      /must be a regular file|symbolic link/u.test(error.message)
  );
  assert.equal(fs.readFileSync(target, "utf8"), "{}\n");
});
