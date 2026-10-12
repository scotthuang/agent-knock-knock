import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopCreationStore, type DesktopCreationRecord } from "../src/desktop-creation-store.js";

const ID = `desktop-create:${"2".repeat(64)}`, THREAD = "00000000-0000-4000-8000-000000000001";
test("creation store protects immutable target, input, known receipts and terminal outcomes across reopen", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-create-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createDesktopCreationStore(dir), date = new Date().toISOString();
  const initial: DesktopCreationRecord = { schema: "agent-knock-knock/desktop-creation", version: 1, id: ID,
    controllerSession: "controller", input: { codexHome: dir, title: "Fixture", timeoutMs: 43_200_000 },
    status: "prepared", createdAt: date, updatedAt: date };
  store.update(ID, () => initial);
  const file = path.join(dir, "desktop-creations", `${ID}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  store.update(ID, record => ({ ...record!, status: "creating", cwd: dir, projectId: null,
    worker: { pid: process.pid, token: "worker", startedAt: date }, threadId: THREAD }));
  const reopened = createDesktopCreationStore(dir);
  for (const change of [
    (r: DesktopCreationRecord) => { r.input.timeoutMs = 10; },
    (r: DesktopCreationRecord) => { r.cwd = "/other"; },
    (r: DesktopCreationRecord) => { delete r.threadId; },
    (r: DesktopCreationRecord) => { r.projectId = "00000000-0000-4000-8000-000000000002"; }
  ]) {
    assert.throws(() => reopened.update(ID, r => { change(r!); return r!; }), /cannot change|immutable/u);
  }
  reopened.update(ID, r => ({ ...r!, status: "uncertain", errorCode: "creation_identity_mismatch" }));
  assert.throws(() => reopened.update(ID, r => ({ ...r!, status: "created" })), /cannot be replayed/u);
  assert.equal(reopened.load(ID)?.threadId, THREAD);
  fs.chmodSync(file, 0o644);
  assert.throws(() => reopened.load(ID), /private/u);
});

test("creation store rejects malformed leases and absent recovery identities without creating records", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-create-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createDesktopCreationStore(dir), date = new Date().toISOString();
  const initial: DesktopCreationRecord = { schema: "agent-knock-knock/desktop-creation", version: 1, id: ID,
    controllerSession: "controller", input: { codexHome: dir, title: "Fixture", timeoutMs: 1000 },
    status: "prepared", createdAt: date, updatedAt: date };
  assert.throws(() => store.update(ID, () => ({ ...initial, worker: { pid: 0, token: "", startedAt: date } })), /Invalid/u);
  assert.throws(() => store.update(ID, () => ({ ...initial, status: "created" })), /Invalid/u);
  assert.equal(store.load(ID), undefined);
  assert.throws(() => store.load("../../escape"), /Invalid/u);
});
