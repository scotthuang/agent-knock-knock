import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConversationRoutingHome, withConversationRoutingHome } from "../src/conversation-routing-home.js";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akk-routing-home-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const row = { agent: "codex", process_state: "active", pid: 123, native_agent_process_birth: "birth-123" };
  function descriptor(home: string, name = "codex-arg0Example", fd = "7") {
    const filename = path.join(home, "tmp", "arg0", name, ".lock");
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, "");
    const stat = fs.statSync(filename, { bigint: true });
    return { filename, text: `f${fd}\ntREG\nD0x${stat.dev.toString(16)}\ni${stat.ino}\nn${filename}\n` };
  }
  const home = path.join(root, "custom-codex-home"), lock = descriptor(home);
  const observe = (output = `p123\n${lock.text}`, birth: () => string = () => "birth-123") =>
    readConversationRoutingHome(row, { processBirth: birth, openFiles: () => ({ status: 0, stdout: output }) });
  return { root, home, row, lock, descriptor, observe };
}

test("routing home comes from the live arg0 descriptor and canonical file identity, not the configured home", t => {
  const f = fixture(t);
  assert.deepEqual(f.observe(), { status: "verified", codexHome: f.home, evidence: "open_arg0_lock" });
  const row = withConversationRoutingHome(f.row, { processBirth: () => "birth-123",
    openFiles: () => ({ status: 0, stdout: `p123\n${f.lock.text}` }) });
  assert.equal(row.native_agent_codex_home, f.home);
  assert.deepEqual(row.native_agent_codex_home_observation, f.observe());
  assert.equal(Object.hasOwn(f.row, "native_agent_codex_home"), false);
});

test("installation paths, configurable logs and unrelated lock files cannot prove Codex home", t => {
  const f = fixture(t);
  for (const filename of ["/somewhere/bin/codex", "/somewhere/log/codex-tui.log", "/somewhere/logs_2.sqlite",
    "/somewhere/tmp/arg0/other/.lock", "/somewhere/tmp/arg0/codex-arg0/.lock", "/somewhere/tmp/codex-arg0Example/.lock"]) {
    assert.deepEqual(f.observe(`p123\nf7\ntREG\nD1\ni1\nn${filename}\n`),
      { status: "unavailable", reason: "codex_home_descriptor_missing" });
  }
});

test("routing home rejects process replacement before or during open-file observation", t => {
  const f = fixture(t); let reads = 0;
  assert.deepEqual(f.observe(undefined, () => ++reads === 1 ? "birth-123" : "replacement"),
    { status: "unavailable", reason: "physical_process_incarnation_changed" });
  let filesRead = false;
  assert.deepEqual(readConversationRoutingHome(f.row, { processBirth: () => "replacement",
    openFiles: () => { filesRead = true; return { status: 0, stdout: "" }; } }),
    { status: "unavailable", reason: "physical_process_incarnation_changed" });
  assert.equal(filesRead, false);
});

test("stale, deleted, symlink and nonregular descriptors fail home verification", t => {
  const f = fixture(t);
  for (const changed of [f.lock.text.replace(/\ni\d+\n/u, "\ni1\n"), f.lock.text.replace(/\nD[^\n]+\n/u, "\nD1\n"),
    f.lock.text.replace("tREG", "tDIR"), f.lock.text.replace("f7", "fcwd"), f.lock.text.replace(f.lock.filename, `${f.lock.filename} (deleted)`)]) {
    assert.deepEqual(f.observe(`p123\n${changed}`), { status: "unavailable", reason: "codex_home_descriptor_unverifiable" });
  }
  const original = `${f.lock.filename}.original`; fs.renameSync(f.lock.filename, original); fs.symlinkSync(original, f.lock.filename);
  assert.deepEqual(f.observe(), { status: "unavailable", reason: "codex_home_descriptor_unverifiable" });
});

test("multiple physical homes are ambiguous while duplicate descriptors in one home agree", t => {
  const f = fixture(t);
  const same = f.descriptor(f.home, "codex-arg0Second", "8");
  assert.equal(f.observe(`p123\n${f.lock.text}${same.text}`).status, "verified");
  const other = f.descriptor(path.join(f.root, "other-codex-home"), "codex-arg0Third", "9");
  assert.deepEqual(f.observe(`p123\n${f.lock.text}${other.text}`),
    { status: "ambiguous", reason: "multiple_codex_home_descriptors" });
});

test("wrong-PID and failed inventories cannot become home evidence or trigger non-Codex inspection", t => {
  const f = fixture(t);
  for (const output of [`p999\n${f.lock.text}`, `p123\n${f.lock.text}p999\n${f.lock.text}`]) {
    assert.deepEqual(f.observe(output), { status: "unavailable", reason: "process_open_files_identity_mismatch" });
  }
  assert.deepEqual(readConversationRoutingHome(f.row, { processBirth: () => "birth-123",
    openFiles: () => ({ status: 1, stdout: `p123\n${f.lock.text}` }) }),
    { status: "unavailable", reason: "process_open_files_unavailable" });
  const claude = { ...f.row, agent: "claude" };
  assert.equal(withConversationRoutingHome(claude, { processBirth: () => { throw new Error("must not run"); } }), claude);
});
