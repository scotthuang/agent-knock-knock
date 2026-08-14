import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicSaveJsonFile,
  readJsonFileNoFollow
} from "../src/durable-json-file.js";

function withTempDirectory(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-durable-json-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function save(filePath: string, value: unknown): void {
  atomicSaveJsonFile(filePath, value, {
    rootLabel: "record root",
    directoryLabel: "record directory",
    fileLabel: "record state file",
    ensureDirectory: (directory) => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  });
}

test("durable JSON writes exact private bytes and reads without following links", () => {
  withTempDirectory((root) => {
    const statePath = path.join(root, "records", "one", "state.json");
    save(statePath, { version: 1, value: "exact" });
    assert.equal(
      fs.readFileSync(statePath, "utf8"),
      '{\n  "version": 1,\n  "value": "exact"\n}\n'
    );
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.deepEqual(readJsonFileNoFollow(statePath, "record state"), {
      version: 1,
      value: "exact"
    });

    const linkPath = path.join(root, "records", "one", "linked.json");
    fs.symlinkSync(statePath, linkPath);
    assert.throws(
      () => readJsonFileNoFollow(linkPath, "record state"),
      /record state must be a regular file/u
    );
  });
});

test("failed serialization leaves the previous record and no temp file", () => {
  withTempDirectory((root) => {
    const directory = path.join(root, "records", "one");
    const statePath = path.join(directory, "state.json");
    save(statePath, { version: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => save(statePath, circular), /circular structure/iu);
    assert.equal(fs.readFileSync(statePath, "utf8"), '{\n  "version": 1\n}\n');
    assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
  });
});

test("atomic replacement refuses a symbolic-link destination", () => {
  withTempDirectory((root) => {
    const directory = path.join(root, "records", "one");
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(root, "outside.json");
    fs.writeFileSync(target, "{}\n");
    const statePath = path.join(directory, "state.json");
    fs.symlinkSync(target, statePath);
    assert.throws(
      () => save(statePath, { version: 1 }),
      /record state file must be a regular file/u
    );
    assert.equal(fs.readFileSync(target, "utf8"), "{}\n");
  });
});
