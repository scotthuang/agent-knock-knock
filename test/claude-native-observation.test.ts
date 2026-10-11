import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readClaudeNativeSnapshot } from "../src/claude-native-observation.js";
import type { ClaudeNativeCatalogEntry } from "../src/claude-native-identity.js";

const sid = "10000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-11T00:00:00.000Z";
function record(type: string, id: number, parent: number | null, extra: Record<string, unknown> = {}) {
  return { type, uuid: uuid(id), parentUuid: parent === null ? null : uuid(parent), sessionId: sid, isSidechain: false, timestamp: at, ...extra };
}
const user = (id: number, parent: number | null = null) => record("user", id, parent,
  { isMeta: true, origin: { kind: "peer", msg_id: uuid(id + 100), verifiedPeerPid: 123 },
    message: { role: "user", content: "Private task prompt must never leak" } });
const assistant = (id: number, parent: number, text: string, extra: Record<string, unknown> = {}) => record("assistant", id, parent,
  { message: { role: "assistant", id: `message-${id}`, content: [{ type: "text", text }], stop_reason: "end_turn", ...extra } });
const duration = (id: number, parent: number) => record("system", id, parent, { subtype: "turn_duration", durationMs: 10 });
async function fixture(t: { after(fn: () => Promise<void>): void }, records: Record<string, unknown>[]) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "akk-native-observation-"));
  const configDir = await fs.realpath(temp); t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const project = path.join(configDir, "projects", "isolated-project"); await fs.mkdir(project, { recursive: true });
  const file = path.join(project, `${sid}.jsonl`);
  await fs.writeFile(file, records.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  const entry: ClaudeNativeCatalogEntry = { configDir, sessionId: sid, pid: 321, processStart: "Sun Oct 11 00:00:00 2026",
    nativeId: "synthetic-native-id", cwd: "/isolated/project", version: "2.1.296", socketPath: "/isolated/socket",
    peerProtocol: 1, peerFeatures: [], status: "idle", observedAt: at };
  return { file, entry, write: (values: Record<string, unknown>[]) => fs.writeFile(file,
    values.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 }) };
}

test("native observation anchors old exact input and origin without borrowing a later task", async t => {
  const f = await fixture(t, [user(1), assistant(2, 1, "First result"), duration(3, 2), user(4, 3), assistant(5, 4, "Later result"), duration(6, 5)]);
  const old = await readClaudeNativeSnapshot({ ...f.entry, status: "working" }, { exactInputUuid: uuid(1), messageId: uuid(101), expectedPeerPid: 123 });
  assert.equal(old.latestInputUuid, uuid(4));
  assert.equal(old.selectedInput?.state, "completed");
  assert.equal(old.selectedInput?.responseText, "First result");
  assert.equal(old.selectedInput?.completionRecordUuid, uuid(3));
  assert.equal(old.progress.native_turn_id, null);
  assert.equal(old.progress.native_input_id, uuid(1));
  assert.equal(old.progress.task_anchor_kind, "native_input_uuid");
  assert.equal(old.progress.text, "");
  assert.doesNotMatch(JSON.stringify(old), /Private task prompt/u);
  assert.equal((await readClaudeNativeSnapshot(f.entry, { exactInputUuid: uuid(1), messageId: uuid(999) })).readError, "identity_mismatch");
  assert.equal((await readClaudeNativeSnapshot(f.entry, { exactInputUuid: uuid(999) })).readError, "missing_exact_input");
  assert.equal((await readClaudeNativeSnapshot(f.entry, { exactInputUuid: uuid(1), expectedPeerPid: 124 })).readError, "identity_mismatch");
});

test("idle and private end_turn blocks do not establish completion or leak hidden content", async t => {
  const hidden = assistant(2, 1, "unused", { content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }] });
  const f = await fixture(t, [user(1), hidden]);
  assert.equal((await readClaudeNativeSnapshot(f.entry)).selectedInput?.state, "unknown");
  await f.write([user(1), hidden, duration(3, 2)]);
  const noPublic = await readClaudeNativeSnapshot(f.entry);
  assert.equal(noPublic.selectedInput?.state, "unknown");
  assert.equal(noPublic.progress.state, "no_public_progress");
  assert.doesNotMatch(JSON.stringify(noPublic), /PRIVATE_REASONING/u);
  const publicText = assistant(3, 2, "Final public answer", { id: "message-2" });
  await f.write([user(1), hidden, publicText, duration(4, 3)]);
  assert.equal((await readClaudeNativeSnapshot(f.entry)).selectedInput?.state, "completed");
});

test("public progress is bounded, redacted and excludes tool parameters and raw outputs", async t => {
  const text = "Progress token=private-secret " + "👨‍👩‍👧‍👦e\u0301中".repeat(1000);
  const tool = record("assistant", 3, 2, { message: { role: "assistant", id: "tool-message", stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "PRIVATE_COMMAND" } }] } });
  const result = record("user", 4, 3, { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "PRIVATE_STDOUT".repeat(1000) }] } });
  const f = await fixture(t, [user(1), assistant(2, 1, text, { stop_reason: null }), tool, result]);
  const snapshot = await readClaudeNativeSnapshot({ ...f.entry, status: "working" });
  assert.equal(snapshot.selectedInput?.state, "inProgress");
  assert.deepEqual(snapshot.selectedInput?.toolResults, [{ toolUseId: "tool-1", name: "Bash", status: "completed" }]);
  assert.ok([...snapshot.progress.text].length <= 800);
  assert.equal(snapshot.progress.truncated, true);
  assert.match(snapshot.progress.text, /Command execution: completed$/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_COMMAND|PRIVATE_STDOUT|private-secret/u);
  const body = snapshot.progress.text.split("\n")[0].slice(1);
  const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(body)].map(value => value.segment);
  assert.ok(parts.every(value => ["👨‍👩‍👧‍👦", "e\u0301", "中"].includes(value)));
  assert.equal(snapshot.progress.latest_item_at, at);
});

test("causal attachment order recognizes busy absorption without claiming an independent completion", async t => {
  const folded = record("attachment", 4, 3, { timestamp: "2026-10-10T23:59:59.000Z", attachment: {
    type: "queued_command", source_uuid: uuid(20), origin: { kind: "peer", msg_id: uuid(120), verifiedPeerPid: 123 } } });
  const f = await fixture(t, [user(1), folded, assistant(2, 1, "Working", { stop_reason: null }),
    record("attachment", 3, 2, { attachment: { type: "context" } }), assistant(5, 4, "Shared answer"), duration(6, 5)]);
  const snapshot = await readClaudeNativeSnapshot(f.entry, { exactInputUuid: uuid(20), messageId: uuid(120) });
  assert.equal(snapshot.readError, undefined);
  assert.equal(snapshot.selectedInput?.kind, "absorbed_mid_turn");
  assert.equal(snapshot.selectedInput?.state, "unknown");
  assert.equal(snapshot.selectedInput?.reason, "input_absorbed_into_existing_task");
  assert.equal(snapshot.selectedInput?.completionRecordUuid, undefined);
});

test("explicit interruption and API error are separate outcomes, process exit alone proves neither", async t => {
  const interrupt = record("user", 2, 1, { message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
  const f = await fixture(t, [user(1), interrupt]);
  const stopped = await readClaudeNativeSnapshot(f.entry);
  assert.equal(stopped.latestInputUuid, uuid(1));
  assert.equal(stopped.selectedInput?.state, "interrupted");
  assert.equal(stopped.selectedInput?.completionRecordUuid, uuid(2));
  await f.write([user(1), { ...assistant(2, 1, "Service unavailable", { stop_reason: "stop_sequence" }), isApiErrorMessage: true }]);
  assert.equal((await readClaudeNativeSnapshot(f.entry)).selectedInput?.state, "failed");
  await f.write([user(1)]);
  const exited = await readClaudeNativeSnapshot(f.entry, { processAlive: false });
  assert.equal(exited.selectedInput?.state, "unknown");
  assert.equal(exited.selectedInput?.reason, "process_exited_without_proven_task_completion");
});

test("unclosed tools, branches and missing parent links fail closed", async t => {
  const tool = record("assistant", 2, 1, { message: { role: "assistant", id: "tool-message", stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tool-1", name: "Write", input: {} }] } });
  const f = await fixture(t, [user(1), tool, assistant(3, 2, "Reported done"), duration(4, 3)]);
  assert.equal((await readClaudeNativeSnapshot(f.entry)).selectedInput?.state, "unknown");
  await f.write([user(1), assistant(2, 1, "Branch one"), assistant(3, 1, "Branch two"), duration(4, 3)]);
  const branched = await readClaudeNativeSnapshot(f.entry);
  assert.equal(branched.selectedInput?.state, "unknown");
  assert.equal(branched.progress.state, "read_error");
  await f.write([user(1), assistant(3, 2, "Orphan answer"), duration(4, 3)]);
  assert.equal((await readClaudeNativeSnapshot(f.entry)).selectedInput?.state, "unknown");
});

test("exact transcript identity refuses replacement, duplicate session files, symlinks and wrong session rows", async t => {
  const f = await fixture(t, [user(1), assistant(2, 1, "Result"), duration(3, 2)]);
  const first = await readClaudeNativeSnapshot(f.entry);
  assert.ok(first.source);
  const original = await fs.readFile(f.file);
  await fs.rename(f.file, `${f.file}.old`); await fs.writeFile(f.file, original, { mode: 0o600 });
  assert.equal((await readClaudeNativeSnapshot(f.entry, { source: first.source })).readError, "read_failed");
  const second = path.join(f.entry.configDir, "projects", "another-project"); await fs.mkdir(second);
  await fs.writeFile(path.join(second, `${sid}.jsonl`), original, { mode: 0o600 });
  assert.equal((await readClaudeNativeSnapshot(f.entry)).readError, "read_failed");
  await fs.rm(second, { recursive: true }); await fs.unlink(f.file); await fs.symlink(`${f.file}.old`, f.file);
  assert.equal((await readClaudeNativeSnapshot(f.entry)).readError, "read_failed");
  await fs.unlink(f.file); await f.write([{ ...user(1), sessionId: uuid(555) }]);
  assert.equal((await readClaudeNativeSnapshot(f.entry)).readError, "identity_mismatch");
});

test("partial trailing JSON never manufactures a result and missing transcript differs from no public progress", async t => {
  const f = await fixture(t, [user(1)]);
  await fs.appendFile(f.file, '{"type":"assistant","message":');
  const snapshot = await readClaudeNativeSnapshot({ ...f.entry, status: "working" });
  assert.equal(snapshot.readError, undefined);
  assert.equal(snapshot.progress.state, "no_public_progress");
  await fs.unlink(f.file);
  assert.equal((await readClaudeNativeSnapshot(f.entry)).readError, "missing_transcript");
});


test("resume/compaction history replay does not block a new exact task or retarget an old Watch", async t => {
  const old = [user(1), assistant(2, 1, "Old result"), duration(3, 2)];
  const newest = [user(10, 3), assistant(11, 10, "Current result"), duration(12, 11)];
  // Native resume may append an old parent after its child, including identical
  // UUID replays. Neither timestamps nor physical order define ownership.
  const f = await fixture(t, [old[0], old[2], old[1], ...newest, old[0], old[1]]);
  const current = await readClaudeNativeSnapshot(f.entry);
  assert.equal(current.latestInputUuid, uuid(10));
  assert.equal(current.selectedInput?.state, "completed");
  assert.equal(current.selectedInput?.responseText, "Current result");
  const prior = await readClaudeNativeSnapshot(f.entry, { exactInputUuid: uuid(1), messageId: uuid(101) });
  assert.equal(prior.selectedInput?.responseText, "Old result");
  // A conflicting historical rewrite poisons its own anchor, not unrelated input.
  await f.write([...old, { ...old[1], message: { role: "assistant", id: "rewrite", content: [] } }, ...newest]);
  assert.equal((await readClaudeNativeSnapshot(f.entry, { exactInputUuid: uuid(10) })).selectedInput?.state, "completed");
  assert.equal((await readClaudeNativeSnapshot(f.entry, { exactInputUuid: uuid(1) })).selectedInput?.state, "unknown");
});

test("native informational side records do not break a resolved question's causal chain", async t => {
  const tool = record("assistant", 2, 1, { message: { role: "assistant", id: "question-message", stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "question-1", name: "AskUserQuestion", input: { questions: "PRIVATE_QUESTION" } }] } });
  const information = record("system", 3, 2, { subtype: "informational", content: "PRIVATE_SETTING" });
  const answer = record("user", 4, 2, { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "question-1", content: "PRIVATE_ANSWER" }] } });
  const f = await fixture(t, [user(1), tool, information, answer, assistant(5, 4, "Continued"), duration(6, 5)]);
  const snapshot = await readClaudeNativeSnapshot(f.entry);
  assert.equal(snapshot.selectedInput?.state, "completed");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_/u);
});


test("an unfinished older input cannot borrow a newer task's working registry status", async t => {
  const f = await fixture(t, [user(1), assistant(2, 1, "Old partial text", { stop_reason: null }), user(3, 2)]);
  const old = await readClaudeNativeSnapshot({ ...f.entry, status: "working" }, { exactInputUuid: uuid(1), messageId: uuid(101) });
  assert.equal(old.selectedInput?.state, "unknown");
  assert.equal(old.selectedInput?.reason, "newer_input_exists_without_proven_completion");
  const current = await readClaudeNativeSnapshot({ ...f.entry, status: "working" });
  assert.equal(current.selectedInput?.inputUuid, uuid(3));
  assert.equal(current.selectedInput?.state, "inProgress");
});


test("Claude public actions use fixed readable titles within the shared progress budget", async t => {
  const f = await fixture(t, []);
  for (const [name, title] of [["Read", "File read"], ["Glob", "File search"], ["Grep", "File search"],
    ["AskUserQuestion", "User question"], ["CustomNativeTool", "Tool call"]]) {
    const tool = record("assistant", 3, 2, { message: { role: "assistant", id: "tool-message", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tool-1", name, input: { path: "PRIVATE_PATH", question: "PRIVATE_QUESTION" } }] } });
    const result = record("user", 4, 3, { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "PRIVATE_OUTPUT" }] } });
    await f.write([user(1), assistant(2, 1, "👨‍👩‍👧‍👦中".repeat(1000), { stop_reason: null }), tool, result]);
    const snapshot = await readClaudeNativeSnapshot({ ...f.entry, status: "working" });
    assert.ok(snapshot.progress.text.endsWith(`${title}: completed`));
    assert.ok([...snapshot.progress.text].length <= 800);
    assert.equal(snapshot.progress.truncated, true);
    assert.doesNotMatch(snapshot.progress.text, /PRIVATE_|CustomNativeTool/u);
  }
});
