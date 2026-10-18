import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createCallbackEnvelope, createTerminalWatchOpenClawCallbackRoute } from "../src/callback-transport.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { createCodexNativeStateStore, type CodexNativeTaskRecord, type CodexNativeNotification } from "../src/codex-native-state-store.js";
import { collectExpiredWatchHistory } from "../src/watch-history-retention.js";
import { DEFAULT_WATCH_HISTORY_HOURS, WATCH_HISTORY_RETENTION_HOURS, isHealthySettledWatch,
  watchHistorySettledAt } from "../src/watch-history-policy.js";
import { loadWatchHistoryReceipt, saveWatchHistoryReceipt, watchHistoryReceiptPath } from "../src/watch-history-receipt.js";
import { ensureStoreWritable, storeManifestPath, withStoreWriterLease, STORE_WRITER_PROTOCOL } from "../src/store.js";

const OLD = "2026-10-12T00:00:00.000Z";
const NOW = new Date("2026-10-14T01:00:00.000Z");
const target = { codexHome: "/isolated/codex", threadId: "history-fixture-thread" };
const nativeId = createCodexNativeConversationId(target);
const route = createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: "isolated-history-controller" });
function harness(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repository = createCodexNativeStateStore(dir, { acquire: () => () => {} });
  return { dir, repository, file: (id: string) => path.join(dir, "codex-native-tasks", `${id}.json`) };
}
function task(suffix = "fixture1"): CodexNativeTaskRecord {
  const id = `codex-cli-watch:${suffix}`;
  return { schema: "agent-knock-knock/codex-native-task", version: 1, revision: 1,
    id, watch_id: id, native_id: nativeId, target, controller_session: "isolated-history-controller",
    kind: "watch", status: "completed", native_turn_id: `turn-${suffix}`,
    created_at: OLD, updated_at: OLD, observed_at: OLD, deadline_at: "2026-10-12T12:00:00.000Z",
    pending_interactions: [], final_text: "Private result body must be removed", notifications: [] };
}
function callback(record: CodexNativeTaskRecord, status: CodexNativeNotification["status"]): CodexNativeNotification {
  const id = `${record.id}:settled`;
  return { id, attempts: status === "ready" ? 0 : 1, status,
    envelope: createCallbackEnvelope({ route, source: { kind: "codex_native_watch", watch_id: record.id, native_id: nativeId },
      event: { id, type: "codex_native_watch.settled", requires_response: false, body: "Private notification body" } }),
    ...(status === "accepted" ? { outcome: { disposition: "accepted" as const, accepted_at: OLD, acceptance_id: "fixture-accepted" } } : {}),
    ...(status === "uncertain" ? { outcome: { disposition: "uncertain" as const, observed_at: OLD, error_code: "ack_unknown" } } : {}),
    ...(status === "failed" || status === "retry_wait" ? { outcome: { disposition: "retryable_failure" as const, error_code: "connection_failed" } } : {}),
    ...(status === "retry_wait" ? { retry_at: "2026-10-12T00:00:05.000Z" } : {}),
    ...(status === "leased" ? { attempt_id: "fixture-attempt", lease_expires_at: "2026-10-12T00:00:30.000Z" } : {}) };
}

test("history windows are separate and cleanup starts after exact completion or the last accepted callback", t => {
  assert.equal(DEFAULT_WATCH_HISTORY_HOURS, 24); assert.equal(WATCH_HISTORY_RETENTION_HOURS, 48);
  const h = harness(t), record = task();
  record.created_at = "2026-10-01T00:00:00.000Z";
  record.observed_at = "2026-10-13T00:00:00.000Z";
  record.updated_at = record.observed_at;
  h.repository.save(record, null);
  assert.equal(collectExpiredWatchHistory({ storeDir: h.dir, now: NOW }).deleted, 0, "an old long task just completed");
  const accepted = task("accepted"); accepted.callback_route = route; accepted.notifications = [callback(accepted, "accepted")];
  accepted.notifications[0].outcome = { disposition: "accepted", acceptance_id: "late", accepted_at: "2026-10-13T23:59:00.000Z" };
  assert.equal(watchHistorySettledAt(accepted), "2026-10-13T23:59:00.000Z");
  const polled = task("noop-poll"); polled.updated_at = NOW.toISOString();
  assert.equal(watchHistorySettledAt(polled), OLD, "a no-op outbox write is not a new business event");
  delete polled.observed_at;
  assert.equal(watchHistorySettledAt(polled), NOW.toISOString(), "legacy missing observation time uses conservative last write");
});

test("48-hour cleanup boundary removes only healthy bodies and keeps privacy-minimal durable replay receipts", t => {
  const h = harness(t), record = task(); h.repository.save(record, null);
  assert.equal(collectExpiredWatchHistory({ storeDir: h.dir, now: new Date(Date.parse(OLD) + 48 * 3_600_000 - 1) }).deleted, 0);
  // The hourly maintenance throttle is separate from the exact 48h predicate.
  const after = new Date(Date.parse(OLD) + 49 * 3_600_000);
  const result = collectExpiredWatchHistory({ storeDir: h.dir, now: after });
  assert.equal(result.deleted, 1); assert.equal(fs.existsSync(h.file(record.id)), false);
  assert.throws(() => h.repository.load(record.id), { code: "watch_history_expired", task_status: "completed", replay_forbidden: true });
  assert.throws(() => h.repository.save(record, null), { code: "watch_history_expired" });
  assert.deepEqual(h.repository.scanForReconciliation(), { tasks: [], errors: [] });
  const receipt = fs.readFileSync(watchHistoryReceiptPath(h.dir, "codex", record.id), "utf8");
  assert.doesNotMatch(receipt, /Private|history-fixture-thread|isolated-history-controller|codexHome/u);
  assert.ok(Buffer.byteLength(receipt) < 600);
});

test("active, failed, expired, uncertain, pending callback and pending interaction records are never age-deleted", t => {
  const h = harness(t);
  const records: CodexNativeTaskRecord[] = [];
  for (const status of ["watching", "failed", "interrupted", "timed_out", "cancelled"] as const) {
    records.push({ ...task(`state-${status}`), status });
  }
  for (const status of ["ready", "leased", "retry_wait", "failed", "uncertain"] as const) {
    const record = task(`callback-${status}`); record.callback_route = route; record.notifications = [callback(record, status)]; records.push(record);
  }
  const waiting = task("interaction"); waiting.pending_interactions = [{ id: "question", kind: "blocking_question",
    threadId: target.threadId, turnId: waiting.native_turn_id!, itemId: "question-item", method: "item/tool/requestUserInput",
    questions: [{ id: "q1", title: "Choose", options: ["one", "two"] }] }]; records.push(waiting);
  records.push({ ...task("read-error"), observation_error: "native_read_failed" });
  const noReceipt = task("missing-note"); noReceipt.callback_route = route; records.push(noReceipt);
  for (const record of records) h.repository.save(record, null);
  const before = records.map(record => fs.readFileSync(h.file(record.id), "utf8"));
  assert.equal(collectExpiredWatchHistory({ storeDir: h.dir, now: NOW }).deleted, 0);
  assert.deepEqual(records.map(record => fs.readFileSync(h.file(record.id), "utf8")), before);
  const uncertainSend = { ...task(), send_intent: { state: "uncertain" } };
  assert.equal(isHealthySettledWatch(uncertainSend), false);
  assert.equal(isHealthySettledWatch({ schema: "agent-knock-knock/terminal-watch", status: "completed",
    notification_outbox: [{ kind: "completed", status: "superseded", superseded_at: OLD }] }), false,
  "a superseded completion notification is not a delivered result");
});

test("maintenance persists throttling and advances a bounded cursor across retained records", t => {
  const h = harness(t);
  for (const [id, status] of [["aaaaaaa1", "watching"], ["bbbbbbb2", "completed"], ["ccccccc3", "completed"]] as const) {
    h.repository.save({ ...task(id), status }, null);
  }
  const first = collectExpiredWatchHistory({ storeDir: h.dir, now: NOW, limit: 1 });
  assert.equal(first.checked, 1); assert.equal(first.deleted, 0);
  assert.equal(collectExpiredWatchHistory({ storeDir: h.dir, now: NOW }).throttled, true, "another process/generation shares the throttle");
  const second = collectExpiredWatchHistory({ storeDir: h.dir, now: new Date(NOW.getTime() + 3_600_000), limit: 1 });
  const third = collectExpiredWatchHistory({ storeDir: h.dir, now: new Date(NOW.getTime() + 2 * 3_600_000), limit: 1 });
  assert.equal(second.deleted, 1); assert.equal(third.deleted, 1); assert.equal(h.repository.list().length, 1);
});

test("a receipt-first crash leaves history hidden and replay fenced until maintenance finishes deleting its body", t => {
  const h = harness(t), record = h.repository.save(task(), null);
  withStoreWriterLease(h.dir, () => saveWatchHistoryReceipt(h.dir, { schema: "agent-knock-knock/watch-history-receipt", version: 1,
    provider: "codex", watch_id: record.id, status: "completed", settled_at: OLD, deleted_at: NOW.toISOString(),
    record_sha256: createHash("sha256").update(JSON.stringify(record)).digest("hex") }));
  assert.equal(fs.existsSync(h.file(record.id)), true);
  assert.deepEqual(h.repository.list(), []);
  assert.throws(() => h.repository.load(record.id), { code: "watch_history_expired" });
  assert.equal(collectExpiredWatchHistory({ storeDir: h.dir, now: NOW }).deleted, 1);
  assert.ok(loadWatchHistoryReceipt(h.dir, "codex", record.id));
});

test("cleanup revalidates under the record lock; malformed, unknown schemas and symlinks are preserved", t => {
  const h = harness(t), original = h.repository.save(task("aaaaaaa1"), null);
  const unknown = h.repository.save(task("bbbbbbb2"), null), malformed = h.repository.save(task("ccccccc3"), null);
  fs.writeFileSync(h.file(unknown.id), JSON.stringify({ ...unknown, version: 999 }));
  fs.writeFileSync(h.file(malformed.id), "{not-json");
  const outside = path.join(h.dir, "outside.json"); fs.writeFileSync(outside, "private outside fixture", { mode: 0o600 });
  const link = h.file("codex-cli-watch:ddddddd4"); fs.symlinkSync(outside, link);
  const result = collectExpiredWatchHistory({ storeDir: h.dir, now: NOW, locks: { acquire(file) {
    if (file === `${h.file(original.id)}.lock`) fs.writeFileSync(h.file(original.id), JSON.stringify({ ...original, status: "watching" }));
    return () => {};
  } } });
  assert.equal(result.deleted, 0); assert.equal(result.errors, 3);
  assert.equal(fs.readFileSync(outside, "utf8"), "private outside fixture");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(h.file(malformed.id), "utf8"), "{not-json");
});

test("writer protocol upgrade fences predecessor writers without changing records, deadlines or callback receipts", async t => {
  const h = harness(t), record = h.repository.save(task(), null), originalBytes = fs.readFileSync(h.file(record.id));
  const manifest = JSON.parse(fs.readFileSync(storeManifestPath(h.dir), "utf8"));
  fs.writeFileSync(storeManifestPath(h.dir), JSON.stringify({ ...manifest, writer_protocol: 9 }));
  // Exercise the real Store guard with the predecessor constants, not a mocked write verdict.
  const storeUrl = new URL("../src/store.js", import.meta.url);
  const source = fs.readFileSync(storeUrl, "utf8")
    .replace(/STORE_WRITER_PROTOCOL = \d+;/u, "STORE_WRITER_PROTOCOL = 9;")
    .replace(/new Set\(\[1, 2, 3, 4, 5, 6, 7, 8, 9\]\)/u, "new Set([1, 2, 3, 4, 5, 6, 7, 8])")
    .replace(/from\s+(["'])(\.\/[^"']+)\1/gu, (_match, _quote, relative: string) => `from ${JSON.stringify(new URL(relative, storeUrl).href)}`);
  const oldWriter = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.equal(oldWriter.inspectStoreCompatibility(h.dir).writable, true);
  assert.equal(ensureStoreWritable(h.dir).writer_protocol, STORE_WRITER_PROTOCOL);
  assert.equal(oldWriter.inspectStoreCompatibility(h.dir).readable, true);
  assert.equal(oldWriter.inspectStoreCompatibility(h.dir).writable, false);
  let oldMutation = 0;
  assert.throws(() => oldWriter.withStoreWriterLease(h.dir, () => oldMutation++), /writer protocol|refusing to mutate/u);
  assert.equal(oldMutation, 0);
  assert.deepEqual(fs.readFileSync(h.file(record.id)), originalBytes);
  assert.equal(JSON.parse(fs.readFileSync(storeManifestPath(h.dir), "utf8")).created_at, manifest.created_at);
});
