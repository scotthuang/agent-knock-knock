import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createTerminalWatchOpenClawCallbackRoute, type CallbackAttemptOutcome, type CallbackTransportDeliverInput } from "../src/callback-transport.js";
import { createClaudeNativeTaskService, type ClaudeNativeTaskDependencies } from "../src/claude-native-task-service.js";
import { createClaudeNativeStateStore } from "../src/claude-native-state-store.js";
import { ClaudeNativeError, createClaudeNativeConversationId, type ClaudeNativeCatalogEntry } from "../src/claude-native-identity.js";
import { createClaudeNativeRuntime } from "../src/claude-native-runtime.js";
import type { ClaudeNativeInputObservation, ClaudeNativeSnapshot } from "../src/claude-native-observation.js";

const target = { configDir: "/test/claude", sessionId: "11111111-1111-4111-8111-111111111111", pid: 321,
  processStart: "Sun Oct 11 00:00:00 2026" };
const input = { target, nativeId: createClaudeNativeConversationId(target), controllerSession: "controller-fixture",
  messageId: "message-fixture", text: "Only report the fixture result" };
const owner = { controllerSession: input.controllerSession };
const route = createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: input.controllerSession });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry: ClaudeNativeCatalogEntry = { ...target, nativeId: input.nativeId, cwd: "/test/project", version: "2.1.296",
  socketPath: "/tmp/cc-socks/321.sock", peerProtocol: 1, peerFeatures: ["notify_idle"], status: "idle", observedAt: "2026-10-11T00:00:00.000Z" };
function selected(id: string, messageId?: string): ClaudeNativeInputObservation {
  return { inputUuid: id, messageId, verifiedPeerPid: 654, kind: "root_user", origin: "peer", state: "inProgress",
    acceptedAt: "2026-10-11T00:00:00.000Z", completedAt: null, responseText: "", responseTruncated: false, pendingTools: [], toolResults: [] };
}
function harness(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-tasks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repository = createClaudeNativeStateStore(dir, { acquire: () => () => {} });
  const state = { now: Date.parse("2026-10-11T00:00:00Z"), sequence: 0, sends: 0, inspections: 0, observations: 0,
    entry: structuredClone(entry), selected: undefined as ClaudeNativeInputObservation | undefined,
    latest: undefined as string | undefined, inspectError: undefined as Error | undefined,
    outcomes: [] as CallbackAttemptOutcome[], deliveries: [] as CallbackTransportDeliverInput[] };
  const snapshot = (): ClaudeNativeSnapshot => {
    const readAt = new Date(state.now).toISOString(), id = state.selected?.inputUuid ?? null;
    return { identity: target, readAt, latestInputUuid: state.latest ?? id, inputs: state.selected ? [structuredClone(state.selected)] : [],
      ...(state.selected ? { selectedInput: structuredClone(state.selected) } : {}),
      source: { relativePath: "projects/fixture/session.jsonl", device: "1", inode: "2" },
      progress: { state: "no_public_progress", text: "", native_turn_id: id, native_input_id: id,
        task_anchor_kind: "native_input_uuid", read_at: readAt, latest_item_at: null, truncated: false } };
  };
  const accepted = (): CallbackAttemptOutcome => ({ disposition: "accepted", acceptance_id: "local-test-only",
    accepted_at: new Date(state.now).toISOString() });
  const deps: ClaudeNativeTaskDependencies = { repository, now: () => new Date(state.now), randomUUID: () => uuid(++state.sequence),
    acceptancePollAttempts: 1, sleep: async () => {},
    inspect: async () => { state.inspections++; if (state.inspectError) throw state.inspectError; return structuredClone(state.entry); },
    observe: async (_entry, options) => {
      state.observations++;
      if (options.messageId) {
        const task = repository.list().find(item => item.send_intent?.native_message_id === options.messageId);
        assert.equal(options.expectedPeerPid, task?.send_intent?.sender_pid);
      }
      return snapshot();
    },
    send: async (_identity, options) => {
      assert.ok(repository.list().some(task => task.send_intent?.client_user_message_id === options.inputUuid), "intent exists before mutation");
      await options.beforeDispatch?.(state.entry, 654); state.sends++;
      const saved = repository.list().find(task => task.send_intent?.client_user_message_id === options.inputUuid)!;
      assert.equal(saved.send_intent?.state, "uncertain"); assert.equal(saved.send_intent?.sender_pid, 654);
      state.selected = selected(options.inputUuid, options.messageId);
      return { dispatchState: "written", senderPid: 654 };
    },
    deliver: async notification => { state.deliveries.push(notification); return state.outcomes.shift() ?? accepted(); }
  };
  return { dir, repository, state, deps, snapshot, accepted, service: createClaudeNativeTaskService(deps) };
}

test("Claude Send persists exact sender provenance; restart replay preserves the original deadline and never resends", async t => {
  const h = harness(t), sent = await h.service.send(input);
  assert.equal(sent.status, "watching"); assert.equal(sent.send_intent?.state, "accepted"); assert.equal(sent.send_intent?.sender_pid, 654);
  assert.equal(Date.parse(sent.deadline_at) - h.state.now, 720 * 60_000);
  h.state.now += 30_000;
  const replay = await createClaudeNativeTaskService(h.deps).send({ ...input, timeoutMs: 60_000 });
  assert.equal(replay.id, sent.id); assert.equal(replay.deadline_at, sent.deadline_at); assert.equal(h.state.sends, 1);
  await assert.rejects(h.service.send({ ...input, text: "A different task" }), { code: "idempotency_conflict" });
});

test("uncertain acceptance survives restart without a resend and can bind only the saved message UUID and peer PID", async t => {
  const h = harness(t);
  h.deps.send = async (_target, options) => { await options.beforeDispatch?.(entry, 654); h.state.sends++; throw new Error("connection lost after write"); };
  const sent = await h.service.send(input);
  assert.equal(sent.status, "awaiting_acceptance"); assert.equal(sent.send_intent?.state, "uncertain");
  await createClaudeNativeTaskService(h.deps).send(input); assert.equal(h.state.sends, 1);
  await assert.rejects(h.service.send({ ...input, messageId: "do-not-retry-with-a-new-key" }), { code: "send_unresolved" });
  h.state.selected = selected(sent.send_intent!.client_user_message_id, sent.send_intent!.native_message_id);
  h.state.selected.verifiedPeerPid = 999;
  assert.equal((await h.service.reconcile(sent.id)).observation_error, "input_provenance_mismatch");
  h.state.selected.verifiedPeerPid = 654; h.state.selected.messageId = uuid(999);
  assert.equal((await h.service.reconcile(sent.id)).native_input_id, undefined);
  h.state.selected.messageId = sent.send_intent!.native_message_id; h.state.selected.state = "completed"; h.state.selected.responseText = "Exact result";
  const resolved = await createClaudeNativeTaskService(h.deps).reconcile(sent.id);
  assert.equal(resolved.status, "completed"); assert.equal(resolved.response_text, "Exact result"); assert.equal(h.state.sends, 1);
});

test("concurrent same-key reservations send once; another key cannot enter the unresolved target", async t => {
  const h = harness(t);
  const results = await Promise.all([h.service.send(input), createClaudeNativeTaskService(h.deps).send(input)]);
  assert.equal(results[0].id, results[1].id); assert.equal(h.state.sends, 1);
  await assert.rejects(h.service.send({ ...input, messageId: "another" }), { code: "send_unresolved" });
  assert.equal(h.state.sends, 1);
});

test("a second service cannot reserve a new key while the first native dispatch is in flight", async t => {
  const h = harness(t); let begin!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { begin = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  h.deps.send = async (_identity, options) => {
    await options.beforeDispatch?.(entry, 654); h.state.sends++; begin(); await gate;
    h.state.selected = selected(options.inputUuid, options.messageId); return { dispatchState: "written", senderPid: 654 };
  };
  const first = h.service.send(input); await began;
  try {
    await assert.rejects(createClaudeNativeTaskService(h.deps).send({ ...input, messageId: "concurrent-other-key" }), { code: "send_unresolved" });
    assert.equal(h.state.sends, 1);
  } finally { release(); await first; }
});

test("late transport receipts cannot downgrade native acceptance or completion proven by a concurrent observer", async t => {
  for (const nativeState of ["inProgress", "completed"] as const) for (const dispatchState of ["written", "not_sent"] as const) {
    const h = harness(t); let begin!: () => void, release!: () => void;
    let proven = false; const save = h.repository.save;
    h.repository.save = (record, revision) => {
      if (proven) assert.equal(record.send_intent?.state, "accepted", "Native proof must not transiently regress on disk");
      return save(record, revision);
    };
    const began = new Promise<void>(resolve => { begin = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    h.deps.send = async (_identity, options) => {
      await options.beforeDispatch?.(entry, 654); h.state.sends++;
      h.state.selected = selected(options.inputUuid, options.messageId); h.state.selected.state = nativeState;
      begin(); await gate; return { dispatchState, senderPid: 654 };
    };
    const pending = h.service.send({ ...input, callbackRoute: route }); await began;
    try {
      const id = h.repository.list()[0].id, verified = await createClaudeNativeTaskService(h.deps).reconcile(id);
      assert.equal(verified.send_intent?.state, "accepted");
      proven = true;
      release(); const received = await pending;
      assert.equal(received.send_intent?.state, "accepted", `${nativeState}/${dispatchState} keeps native proof`);
      assert.equal(received.status, nativeState === "completed" ? "completed" : "watching");
      assert.equal(received.native_input_id, verified.native_input_id); assert.equal(h.state.sends, 1);
      assert.equal(h.state.deliveries.length, nativeState === "completed" ? 1 : 0);
    } finally { release(); await pending; }
  }
});

test("busy calls refuse before dispatch and an input absorbed during the final race never claims independent completion", async t => {
  const h = harness(t); h.state.entry.status = "working";
  await assert.rejects(h.service.send(input), { code: "session_not_idle" }); assert.equal(h.state.sends, 0);
  h.state.entry.status = "idle"; const original = h.deps.send;
  h.deps.send = async (identity, options) => {
    const receipt = await original(identity, options); h.state.selected!.kind = "absorbed_mid_turn"; h.state.selected!.state = "completed"; return receipt;
  };
  const sent = await h.service.send({ ...input, callbackRoute: route });
  assert.equal(sent.status, "failed"); assert.equal(sent.send_intent?.state, "attached");
  assert.equal(sent.observation_error, "input_joined_existing_task"); assert.equal(sent.native_input_id, undefined);
  assert.match(h.state.deliveries[0].envelope.event.body, /Independent completion is unproven/u);
  assert.equal((await h.service.send({ ...input, callbackRoute: route })).id, sent.id); assert.equal(h.state.sends, 1);
});

test("old task status is tied to its exact input even when a later native task is now latest", async t => {
  const h = harness(t), sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.latest = uuid(800); h.state.selected!.state = "completed"; h.state.selected!.responseText = "Old exact answer";
  const completed = await h.service.reconcile(sent.id);
  assert.equal(completed.native_input_id, sent.native_input_id); assert.equal(completed.response_text, "Old exact answer");
  assert.equal(completed.status, "completed"); assert.equal(h.state.deliveries.length, 1);
});

test("original process exit wins over a completed-looking resumed transcript", async t => {
  const h = harness(t), sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.selected!.state = "completed"; h.state.selected!.responseText = "Must not attribute a resumed answer";
  h.state.inspectError = new ClaudeNativeError("process_changed", "Original PID/start changed");
  const exited = await h.service.reconcile(sent.id);
  assert.equal(exited.status, "exited"); assert.notEqual(exited.response_text, h.state.selected!.responseText);
  assert.match(h.state.deliveries[0].envelope.event.body, /completion is unproven/u);
  await assert.rejects(h.service.renew(sent.id, owner), { code: "task_settled" });
});

test("Send and explicit Watch share 720 minutes; recover never extends an expired observation", async t => {
  const h = harness(t), sent = await h.service.send({ ...input, callbackRoute: route, timeoutMs: 60_000 });
  h.state.now += 60_001;
  assert.equal((await h.service.reconcile(sent.id)).status, "timed_out");
  const expired = await h.service.recover(sent.id, owner);
  assert.equal(expired.status, "timed_out"); assert.equal(expired.deadline_at, sent.deadline_at); assert.equal(h.state.deliveries.length, 1);
  const renewed = await h.service.renew(sent.id, owner);
  assert.equal(Date.parse(renewed.deadline_at) - h.state.now, 720 * 60_000); assert.equal(renewed.renewal_count, 1);
  assert.equal(renewed.status, "watching"); assert.equal(h.state.sends, 1); assert.equal(h.state.deliveries.length, 1);
  h.service.close(sent.id, owner);
  h.state.entry.status = "working"; h.state.selected = selected(uuid(900)); h.state.selected.origin = "human";
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  assert.equal(Date.parse(watched.deadline_at) - h.state.now, 720 * 60_000);
  await assert.rejects(Promise.resolve().then(() => h.service.close(watched.id, owner)), { code: "backend_watch_not_managed" });
});

test("Unwatch and Close stop management only, preserve deadlines, enforce ownership and cannot silently resume", async t => {
  const h = harness(t), sent = await h.service.send(input);
  assert.throws(() => h.service.unwatch(sent.id, { controllerSession: "someone-else" }));
  h.service.unwatch(sent.id, owner); const reads = h.state.observations;
  const stopped = await h.service.recover(sent.id, owner);
  assert.ok(stopped.unwatched_at); assert.equal(stopped.deadline_at, sent.deadline_at); assert.equal(h.state.observations, reads);
  const closed = h.service.close(sent.id, owner); assert.ok(closed.closed_at); assert.equal(h.service.shouldMonitor(sent.id), false);
  await assert.rejects(h.service.renew(sent.id, owner), { code: "backend_task_closed" }); assert.equal(h.state.sends, 1);
});

test("renewal cannot borrow active state from a different latest native input", async t => {
  const h = harness(t), sent = await h.service.send(input); h.state.latest = uuid(850);
  await assert.rejects(h.service.renew(sent.id, owner), { code: "renewal_anchor_unavailable" });
  assert.equal(h.service.status(sent.id).deadline_at, sent.deadline_at); assert.equal(h.service.status(sent.id).renewal_count, undefined);
});

test("accepted callback checkpoints survive later errors and restart without a duplicate notification", async t => {
  const h = harness(t), sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.selected!.state = "completed";
  h.deps.deliver = async delivery => { h.state.deliveries.push(delivery); delivery.reportCheckpoint!(h.accepted()); throw new Error("caller disconnected after acceptance"); };
  const completed = await h.service.reconcile(sent.id);
  assert.equal(completed.notifications[0].status, "accepted"); assert.equal(h.service.shouldMonitor(sent.id), false);
  await createClaudeNativeTaskService(h.deps).reconcile(sent.id); await h.service.recover(sent.id, owner);
  assert.equal(h.state.deliveries.length, 1);
  await assert.rejects(h.service.retryCallback(sent.id, { ...owner, notificationId: completed.notifications[0].id }), { code: "backend_callback_not_retryable" });
});

test("unknown callback delivery is not automatically or manually replayed; known retryable failure waits for its deadline", async t => {
  const h = harness(t), sent = await h.service.send({ ...input, callbackRoute: route }); h.state.selected!.state = "completed";
  h.state.outcomes.push({ disposition: "uncertain", error_code: "lost_reply", observed_at: new Date(h.state.now).toISOString() });
  const uncertain = await h.service.reconcile(sent.id); assert.equal(uncertain.notifications[0].status, "uncertain");
  await h.service.reconcile(sent.id); assert.equal(h.state.deliveries.length, 1);
  await assert.rejects(h.service.retryCallback(sent.id, { ...owner, notificationId: uncertain.notifications[0].id }), { code: "backend_callback_not_retryable" });
  // A different completed task has independently known retryable failure, not uncertain acceptance.
  h.service.close(sent.id, owner); h.state.selected = undefined;
  const second = await h.service.send({ ...input, messageId: "second", callbackRoute: route }); h.state.selected!.state = "completed";
  h.state.outcomes.push({ disposition: "retryable_failure", error_code: "temporarily_unavailable" });
  const waiting = await h.service.reconcile(second.id); assert.equal(waiting.notifications[0].status, "retry_wait");
  await h.service.reconcile(second.id); assert.equal(h.state.deliveries.length, 2);
  h.state.now += 5000; await h.service.reconcile(second.id); assert.equal(h.state.deliveries.length, 3);
  assert.equal(h.service.status(second.id).notifications[0].status, "accepted");
});

test("callback lease expiry marks uncertainty without parallel resend; its original late acceptance can still settle", async t => {
  const h = harness(t), sent = await h.service.send({ ...input, callbackRoute: route }); h.state.selected!.state = "completed";
  let finish!: (outcome: CallbackAttemptOutcome) => void, begin!: () => void;
  const began = new Promise<void>(resolve => { begin = resolve; });
  h.deps.deliver = async delivery => { h.state.deliveries.push(delivery); begin(); return new Promise(resolve => { finish = resolve; }); };
  const first = h.service.reconcile(sent.id); await began;
  h.state.now += 30_001;
  const recovered = await createClaudeNativeTaskService(h.deps).reconcile(sent.id);
  assert.equal(recovered.notifications[0].status, "uncertain"); assert.equal(h.state.deliveries.length, 1);
  finish(h.accepted()); await first;
  assert.equal(h.service.status(sent.id).notifications[0].status, "accepted"); assert.equal(h.state.deliveries.length, 1);
});

test("Claude callback lease expiry can recover only from the original late pre-dispatch proof", async t => {
  const h = harness(t), sent = await h.service.send({ ...input, callbackRoute: route }); h.state.selected!.state = "completed";
  let finish!: (outcome: CallbackAttemptOutcome) => void, begin!: () => void;
  let request!: CallbackTransportDeliverInput;
  const began = new Promise<void>(resolve => { begin = resolve; });
  h.deps.deliver = async delivery => { request = delivery; begin(); return new Promise(resolve => { finish = resolve; }); };
  const first = h.service.reconcile(sent.id); await began; h.state.now += 30_001;
  assert.equal((await createClaudeNativeTaskService(h.deps).reconcile(sent.id)).notifications[0].status, "uncertain");
  finish({ disposition: "retryable_failure", error_code: "connection_unavailable", evidence: { request_dispatched: false,
    request_phase: "connection_handshake", attempt_id: request.attempt.id, delivery_id: request.envelope.delivery_id,
    idempotency_key: request.envelope.idempotency_key } });
  const waiting = await first;
  assert.equal(waiting.notifications[0].status, "retry_wait"); assert.equal(waiting.notifications[0].attempts, 1);
  assert.equal(Date.parse(waiting.notifications[0].retry_at!) - h.state.now, 5000);
});

test("state repository refuses silent anchor, sender or deadline rewrites", async t => {
  const h = harness(t), sent = await h.service.send(input);
  for (const mutate of [
    (task: typeof sent) => { task.native_input_id = uuid(99); },
    (task: typeof sent) => { task.send_intent!.sender_pid = 999; },
    (task: typeof sent) => { task.deadline_at = new Date(Date.parse(task.deadline_at) + 1000).toISOString(); }
  ]) { const changed = structuredClone(sent); mutate(changed); assert.throws(() => h.repository.save(changed, sent.revision)); }
  assert.equal(h.repository.load(sent.id)!.send_intent!.sender_pid, 654);
});

test("runtime blocks an exited original before touching a resumed client's snapshot or sending", async t => {
  const h = harness(t); let reads = 0, sends = 0, closed = false;
  const runtime = createClaudeNativeRuntime({ storeDir: h.dir, claudeConfigDirs: [target.configDir],
    processCheck: async () => { throw new ClaudeNativeError("process_exited", "fixture original exited"); },
    client: { discover: async () => ({ sessions: [entry], errors: [] }), inspect: async () => { reads++; return entry; },
      send: async () => { sends++; return { dispatchState: "written" }; }, close: () => { closed = true; } } });
  try {
    await assert.rejects(runtime.read(target), { code: "process_exited" });
    await assert.rejects(runtime.tasks.send(input), { code: "process_exited" });
    await assert.rejects(runtime.inspect({ ...target, configDir: "/another-config" }), { code: "unconfigured_home" });
    assert.equal(reads, 0); assert.equal(sends, 0);
  } finally { await runtime.close(); }
  assert.equal(closed, true);
});

test("a configured symlink home admits the canonical identity returned by native discovery", async t => {
  const h = harness(t), actual = path.join(h.dir, "actual-home"), alias = path.join(h.dir, "home-alias");
  fs.mkdirSync(actual, { mode: 0o700 }); fs.symlinkSync(actual, alias);
  const identity = { ...target, configDir: fs.realpathSync(actual) };
  const discovered = { ...entry, ...identity, nativeId: createClaudeNativeConversationId(identity) };
  let inspected = 0;
  const runtime = createClaudeNativeRuntime({ storeDir: h.dir, claudeConfigDirs: [alias], processCheck: async () => {},
    client: { discover: async () => ({ sessions: [discovered], errors: [] }), inspect: async () => { inspected++; return discovered; },
      send: async () => { assert.fail("home normalization must not send a task"); }, close: () => {} } });
  try {
    const result = await runtime.catalog.discover();
    assert.equal((await runtime.inspect(result.sessions[0])).nativeId, discovered.nativeId); assert.equal(inspected, 1);
  } finally { await runtime.close(); }
});
