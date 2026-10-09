import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDesktopMetadata, withDesktopMetadataSnapshot } from "../src/desktop-metadata-reader.js";

test("metadata snapshots copy only main/WAL into private files and remove them after success and failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akk-desktop-test-"));
  const database = path.join(root, "state_5.sqlite");
  let copied = "";
  try {
    await fs.writeFile(database, "main");
    await fs.writeFile(`${database}-wal`, "wal");
    const original = await fs.stat(database, { bigint: true });
    assert.equal(await withDesktopMetadataSnapshot(database, async (copy) => {
      copied = copy;
      assert.notEqual(copy, database);
      assert.equal((await fs.stat(path.dirname(copy))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(copy)).mode & 0o777, 0o600);
      assert.equal(await fs.readFile(`${copy}-wal`, "utf8"), "wal");
      assert.equal(await fs.readFile(copy, "utf8"), "main");
      return "read";
    }, root), "read");
    await assert.rejects(fs.stat(copied), { code: "ENOENT" });
    await assert.rejects(withDesktopMetadataSnapshot(database, async (copy) => {
      copied = copy;
      throw new Error("read failed");
    }, root), /read failed/);
    await assert.rejects(fs.stat(copied), { code: "ENOENT" });
    const after = await fs.stat(database, { bigint: true });
    assert.equal(after.mtimeNs, original.mtimeNs);
    assert.equal(await fs.readFile(database, "utf8"), "main");
    await assert.rejects(fs.stat(`${database}-shm`), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reader checks supported schemas, scans every metadata page, and never opens an original with SQLite", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akk-desktop-test-"));
  try {
    const database = path.join(root, "state_5.sqlite");
    await fs.writeFile(database, "fake database for injected reader");
    const offsets: number[] = [];
    const batches = await readDesktopMetadata(root, { temporaryRoot: root, querySnapshot: async (copy, sql) => {
      assert.notEqual(copy, database);
      assert.ok(copy.startsWith(`${root}/akk-desktop-metadata-`));
      if (sql === "PRAGMA quick_check") return [{ quick_check: "ok" }];
      if (sql.startsWith("PRAGMA table_info")) return ["id", "title", "cwd", "archived", "source", "updated_at"].map((name) => ({ name }));
      if (sql.startsWith("SELECT count")) return [{ count: 205 }];
      assert.ok(!sql.includes("first_user_message"));
      assert.ok(!sql.includes("thread_history"));
      const offset = Number(sql.match(/OFFSET (\d+)$/u)?.[1]);
      offsets.push(offset);
      return Array.from({ length: Math.min(100, 205 - offset) }, (_, index) => ({ id: `thread-${offset + index}` }));
    } });
    assert.deepEqual(offsets, [0, 100, 200]);
    const state = batches.find((batch) => batch.source.kind === "state")!;
    assert.equal(state.rows.length, 205);
    assert.equal(state.source.status, "ok");
    assert.equal(state.source.pageCount, 3);
    assert.equal(state.source.snapshot, "stable_copy");
    assert.ok(batches.filter((batch) => batch.source.kind === "desktop_catalog").every((batch) => batch.source.status === "absent"));
    assert.deepEqual(await fs.readdir(root), ["state_5.sqlite"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("unsupported schemas and inconsistent snapshots return explicit errors without partial candidates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "akk-desktop-test-"));
  try {
    await fs.writeFile(path.join(root, "state_5.sqlite"), "fake");
    const schemaFailure = await readDesktopMetadata(root, { querySnapshot: async (_copy, sql) =>
      sql === "PRAGMA quick_check" ? [{ quick_check: "ok" }] : [{ name: "id" }] });
    const failed = schemaFailure.find((batch) => batch.source.kind === "state")!;
    assert.equal(failed.source.status, "error");
    assert.match(failed.source.error ?? "", /Unsupported threads schema/);
    assert.deepEqual(failed.rows, []);
    const checkFailure = await readDesktopMetadata(root, { querySnapshot: async () => [{ quick_check: "corrupt" }] });
    assert.match(checkFailure.find((batch) => batch.source.kind === "state")?.source.error ?? "", /quick_check/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
