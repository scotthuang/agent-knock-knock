import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { observeClaudeTerminalRegistry, type ClaudeTerminalRegistryRow } from "../src/claude-terminal-registry-observation.js";

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "akk-terminal-registry-")));
  const configDir = path.join(root, "vendor-config"), sessions = path.join(configDir, "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const pid = process.pid;
  const ps = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
  });
  assert.equal(ps.status, 0);
  const processStart = ps.stdout.trim().replace(/\s+/gu, " "), startedAt = Date.now();
  const row: ClaudeTerminalRegistryRow = { pid, kind: "interactive", sessionId: randomUUID(),
    cwd: root, startedAt, status: "idle" };
  const registry: Record<string, unknown> = { ...row, procStart: processStart, version: "2.1.295" };
  const file = path.join(sessions, `${pid}.json`);
  const save = () => writeFileSync(file, JSON.stringify(registry), { mode: 0o600 }); save();
  const read = (rows: readonly ClaudeTerminalRegistryRow[] = [row]) => observeClaudeTerminalRegistry({ configDir, pid, rows });
  return { root, configDir, sessions, row, registry, file, pid, processStart, save, read,
    cleanup: async () => { rmSync(root, { recursive: true, force: true }); } };
}

test("owned registry binds a vendor version and config root to the actual process without claiming a peer", async () => {
  const f = await fixture();
  try {
    const result = f.read();
    assert.deepEqual(result, { state: "verified", configDir: f.configDir, pid: f.pid, sessionId: f.row.sessionId,
      cwd: f.root, startedAt: f.row.startedAt, processStart: f.processStart, version: "2.1.295" });
    // No socket, messaging protocol, executable installation path or agent-side plugin is needed for version evidence.
    f.registry.peerProtocol = 999; f.registry.messagingSocketPath = "/missing/socket"; f.save();
    assert.equal(f.read().state, "verified");
    f.registry.status = "busy"; f.save();
    assert.equal(f.read([{ ...f.row, status: "waiting" }]).state, "verified");
    assert.equal(f.read([f.row, { ...f.row }]).state, "verified");
  } finally { await f.cleanup(); }
});

test("only missing registry metadata permits the old executable-version fallback", async () => {
  const f = await fixture();
  try {
    unlinkSync(f.file);
    assert.deepEqual(f.read(), { state: "absent" });
    writeFileSync(f.file, "{broken", { mode: 0o600 });
    assert.deepEqual(f.read(), { state: "invalid", reason: "invalid_registry" });
    f.save(); delete f.registry.startedAt; f.save();
    assert.deepEqual(f.read(), { state: "invalid", reason: "registry_mismatch" });
    assert.deepEqual(observeClaudeTerminalRegistry({ configDir: "relative", pid: f.pid, rows: [f.row] }),
      { state: "invalid", reason: "invalid_identity" });
  } finally { await f.cleanup(); }
});

test("same PID rows cannot overwrite different native sessions, directories or incarnations", async () => {
  const f = await fixture();
  try {
    for (const change of [{ sessionId: randomUUID() }, { cwd: path.join(f.root, "other") },
      { startedAt: f.row.startedAt! + 1 }, { kind: "background" }, { status: "" }]) {
      assert.deepEqual(f.read([f.row, { ...f.row, ...change }]), { state: "invalid", reason: "conflicting_rows" });
    }
    assert.deepEqual(f.read([]), { state: "invalid", reason: "invalid_identity" });
    assert.deepEqual(f.read([{ ...f.row, startedAt: undefined }]), { state: "invalid", reason: "invalid_identity" });
    assert.equal(f.read([f.row, { ...f.row, pid: f.pid + 1, sessionId: randomUUID() }]).state, "verified");
  } finally { await f.cleanup(); }
});

test("registry identity and version must match the selected agent-list row", async () => {
  const f = await fixture();
  try {
    const original = { ...f.registry };
    for (const change of [{ pid: f.pid + 1 }, { sessionId: randomUUID() }, { cwd: path.join(f.root, "other") },
      { startedAt: f.row.startedAt! + 1 }, { startedAt: String(f.row.startedAt) }, { version: "latest" }, { status: null }]) {
      Object.assign(f.registry, original, change); f.save();
      assert.deepEqual(f.read(), { state: "invalid", reason: "registry_mismatch" });
    }
    Object.assign(f.registry, original, { procStart: "Mon Jan 1 00:00:00 2001" }); f.save();
    assert.deepEqual(f.read(), { state: "invalid", reason: "process_changed" });
  } finally { await f.cleanup(); }
});

test("unsafe, redirected and oversized records never become trusted registry versions", async () => {
  const f = await fixture();
  try {
    for (const item of [f.configDir, f.sessions, f.file]) {
      chmodSync(item, item === f.file ? 0o666 : 0o777);
      assert.deepEqual(f.read(), { state: "invalid", reason: "unsafe_metadata" });
      chmodSync(item, item === f.file ? 0o600 : 0o700);
    }
    unlinkSync(f.file);
    const target = path.join(f.root, "redirected.json");
    writeFileSync(target, JSON.stringify(f.registry), { mode: 0o600 }); symlinkSync(target, f.file);
    assert.deepEqual(f.read(), { state: "invalid", reason: "unsafe_metadata" });
    unlinkSync(f.file); writeFileSync(f.file, " ".repeat(64 * 1024 + 1), { mode: 0o600 });
    assert.deepEqual(f.read(), { state: "invalid", reason: "invalid_registry" });
  } finally { await f.cleanup(); }
});
