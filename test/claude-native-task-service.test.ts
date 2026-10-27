import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { collectExpiredWatchHistory } from "../src/watch-history-retention.js";
import { createTerminalWatchOpenClawCallbackRoute, type CallbackAttemptOutcome, type CallbackTransportDeliverInput } from "../src/callback-transport.js";
import { createClaudeNativeTaskService, type ClaudeNativeTaskDependencies } from "../src/claude-native-task-service.js";
import { assertClaudeNativeTaskRecord, createClaudeNativeStateStore } from "../src/claude-native-state-store.js";
import { ClaudeNativeError, createClaudeNativeConversationId, type ClaudeNativeCatalogEntry } from "../src/claude-native-identity.js";
import { createClaudeNativeRuntime } from "../src/claude-native-runtime.js";
import { parseClaudeNativeSenderPermissionClass, type ClaudeNativeSenderPermissionClass } from "../src/claude-native-sender-policy.js";
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
    senderClasses: [] as (ClaudeNativeSenderPermissionClass | undefined)[],
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
      state.senderClasses.push(options.senderPermissionClass);
      const saved = repository.list().find(task => task.send_intent?.client_user_message_id === options.inputUuid)!;
      assert.equal(saved.send_intent?.state, "uncertain"); assert.equal(saved.send_intent?.sender_pid, 654);
      assert.equal(options.senderPermissionClass, saved.send_intent?.sender_permission_class, "dispatch uses the persisted sender assertion");
      state.selected = selected(options.inputUuid, options.messageId);
      return { dispatchState: "written", senderPid: 654 };
    },
    deliver: async notification => { state.deliveries.push(notification); return state.outcomes.shift() ?? accepted(); }
  };
  return { dir, repository, state, deps, snapshot, accepted, service: createClaudeNativeTaskService(deps) };
}

test("Claude callbacks wait without a lease until this Host can deliver the immutable route", async t => {
  const h = harness(t);
  h.deps.canDeliver = () => false;
  const sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.selected!.state = "completed";
  const pendingTask = await h.service.reconcile(sent.id);
  assert.equal(pendingTask.status, "completed");
  assert.equal(pendingTask.notifications[0].status, "ready");
  assert.equal(pendingTask.notifications[0].attempts, 0);
  assert.equal(h.state.deliveries.length, 0);
  const envelope = structuredClone(pendingTask.notifications[0].envelope);
  h.deps.canDeliver = () => { throw new Error("recovery catalogue unavailable"); };
  assert.deepEqual((await h.service.reconcile(sent.id)).notifications, pendingTask.notifications);
  h.deps.canDeliver = candidate => candidate?.controller_session_id === input.controllerSession;
  const accepted = await h.service.reconcile(sent.id);
  assert.equal(accepted.notifications[0].status, "accepted");
  assert.equal(accepted.notifications[0].attempts, 1);
  assert.deepEqual(h.state.deliveries[0].envelope, envelope);
});

test("expired Claude Send history rejects repeated messages before inspecting or sending to the native CLI", async t => {
  const h = harness(t), request = { ...input, callbackRoute: route };
  const sent = await h.service.send(request);
  h.state.selected!.state = "completed";
  assert.equal((await h.service.reconcile(sent.id)).status, "completed");
  const before = { sends: h.state.sends, inspections: h.state.inspections, observations: h.state.observations, deliveries: h.state.deliveries.length };
  h.state.now += 48 * 3_600_000;
  assert.equal(collectExpiredWatchHistory({ storeDir: h.dir, now: new Date(h.state.now) }).deleted, 1);
  assert.deepEqual(h.repository.list(), []);
  const restored = createClaudeNativeTaskService(h.deps);
  assert.throws(() => restored.status(sent.id), { code: "watch_history_expired", replay_forbidden: true });
  await assert.rejects(restored.send(request), { code: "watch_history_expired" });
  await assert.rejects(restored.send({ ...request, text: "Changed replay" }), { code: "watch_history_expired" });
  assert.deepEqual({ sends: h.state.sends, inspections: h.state.inspections, observations: h.state.observations, deliveries: h.state.deliveries.length }, before);
});

test("Claude Send persists exact sender provenance; restart replay preserves the original deadline and never resends", async t => {
  const h = harness(t), sent = await h.service.send(input);
  assert.equal(sent.status, "watching"); assert.equal(sent.send_intent?.state, "accepted"); assert.equal(sent.send_intent?.sender_pid, 654);
  assert.equal(Date.parse(sent.deadline_at) - h.state.now, 720 * 60_000);
  h.state.now += 30_000;
  const replay = await createClaudeNativeTaskService(h.deps).send({ ...input, timeoutMs: 60_000 });
  assert.equal(replay.id, sent.id); assert.equal(replay.deadline_at, sent.deadline_at); assert.equal(h.state.sends, 1);
  await assert.rejects(h.service.send({ ...input, text: "A different task" }), { code: "idempotency_conflict" });
});

test("sender permission class is explicit, bounded and absent by default", async t => {
  for (const value of [undefined, "", " \t\n"]) assert.equal(parseClaudeNativeSenderPermissionClass(value), undefined);
  for (const value of ["prompting", "bypass"] as const) assert.equal(parseClaudeNativeSenderPermissionClass(` ${value} `), value);
  for (const value of [null, 1, {}, "auto", "BYPASS", "bypassPermissions"]) {
    assert.throws(() => parseClaudeNativeSenderPermissionClass(value), { code: "invalid_sender_permission_class" });
  }
  const h = harness(t), sent = await h.service.send(input);
  assert.equal(Object.hasOwn(sent.send_intent!, "sender_permission_class"), false);
  assert.deepEqual(h.state.senderClasses, [undefined]);
});

test("new Claude Send pins the configured sender assertion before asynchronous inspection and dispatch", async t => {
  for (const permissionClass of ["prompting", "bypass"] as const) {
    const h = harness(t), inspect = h.deps.inspect;
    h.deps.senderPermissionClass = permissionClass;
    h.deps.inspect = async identity => {
      h.deps.senderPermissionClass = permissionClass === "bypass" ? "prompting" : "bypass";
      return inspect(identity);
    };
    const sent = await h.service.send(input);
    assert.equal(sent.send_intent?.sender_permission_class, permissionClass);
    assert.deepEqual(h.state.senderClasses, [permissionClass]);
    assert.equal(h.repository.load(sent.id)?.send_intent?.sender_permission_class, permissionClass);
  }
});

test("invalid sender configuration refuses a new Send before inspection, reservation or native input", async t => {
  const h = harness(t); h.deps.senderPermissionClass = "infer-from-target";
  await assert.rejects(h.service.send(input), { code: "invalid_sender_permission_class" });
  assert.equal(h.state.inspections, 0); assert.equal(h.state.observations, 0); assert.equal(h.state.sends, 0);
  assert.deepEqual(h.repository.list(), []);
});

test("idempotent Send retains old or absent sender assertions after configuration changes without resending", async t => {
  for (const initial of [undefined, "prompting", "bypass"] as const) {
    const h = harness(t); h.deps.senderPermissionClass = initial;
    const sent = await h.service.send(input), inspections = h.state.inspections;
    for (const changed of ["bypass", "prompting", "invalid-now"]) {
      const restarted = createClaudeNativeTaskService({ ...h.deps, senderPermissionClass: changed });
      const replay = await restarted.send(input);
      assert.equal(replay.id, sent.id); assert.equal(replay.send_intent?.sender_permission_class, initial);
      assert.equal(replay.deadline_at, sent.deadline_at);
    }
    assert.equal(h.state.inspections, inspections); assert.equal(h.state.sends, 1);
  }
});

test("persisted sender assertions cannot be added, changed or removed after reservation", async t => {
  for (const initial of [undefined, "prompting", "bypass"] as const) {
    const h = harness(t); h.deps.senderPermissionClass = initial;
    const sent = await h.service.send(input);
    for (const changed of [undefined, "prompting", "bypass"] as const) {
      if (changed === initial) continue;
      const rewritten = structuredClone(sent);
      if (changed === undefined) delete rewritten.send_intent!.sender_permission_class;
      else rewritten.send_intent!.sender_permission_class = changed;
      assert.throws(() => h.repository.save(rewritten, sent.revision), /Claude send intent changed/u);
    }
    for (const invalid of ["auto", " bypass ", null, 1]) {
      const malformed = structuredClone(sent);
      Object.assign(malformed.send_intent!, { sender_permission_class: invalid });
      assert.throws(() => h.repository.save(malformed, sent.revision), /Claude send intent changed/u);
      assert.throws(() => assertClaudeNativeTaskRecord(malformed), /Invalid Claude send intent/u);
    }
    assert.equal(h.repository.load(sent.id)?.send_intent?.sender_permission_class, initial);
  }
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

test("a held message is not replayed after configuration changes and completes only after exact native acceptance", async t => {
  const h = harness(t), request = { ...input, callbackRoute: route };
  h.deps.send = async (_identity, options) => {
    await options.beforeDispatch?.(entry, 654); h.state.sends++;
    assert.equal(options.senderPermissionClass, undefined);
    h.state.entry.status = "waiting";
    return { dispatchState: "written", deliveryStatus: "held", senderPid: 654 };
  };
  const held = await h.service.send(request);
  assert.equal(held.status, "awaiting_acceptance"); assert.equal(held.send_intent?.state, "held");
  assert.equal(held.native_input_id, undefined); assert.equal(h.state.deliveries.length, 0);
  const restarted = createClaudeNativeTaskService({ ...h.deps, senderPermissionClass: "bypass" });
  const replay = await restarted.send(request);
  assert.equal(replay.send_intent?.state, "held"); assert.equal(replay.send_intent?.sender_permission_class, undefined);
  assert.equal((await restarted.recover(held.id, owner)).send_intent?.state, "held");
  assert.equal(h.state.sends, 1); assert.equal(h.state.deliveries.length, 0);

  // Simulate the receiver releasing that same input; no AKK approval or resend occurs.
  h.state.entry.status = "working";
  h.state.selected = selected(held.send_intent!.client_user_message_id, held.send_intent!.native_message_id);
  h.state.selected.verifiedPeerPid = 999;
  const foreign = await restarted.reconcile(held.id);
  assert.equal(foreign.send_intent?.state, "held"); assert.equal(foreign.observation_error, "input_provenance_mismatch");
  h.state.selected.verifiedPeerPid = 654;
  const accepted = await restarted.reconcile(held.id);
  assert.equal(accepted.status, "watching"); assert.equal(accepted.send_intent?.state, "accepted");
  assert.equal(accepted.native_input_id, held.send_intent!.client_user_message_id);
  assert.equal(accepted.send_intent?.sender_permission_class, undefined);
  assert.equal(h.state.deliveries.length, 0);

  h.state.selected.state = "completed"; h.state.selected.responseText = "Released exact fixture result";
  const completed = await restarted.reconcile(held.id);
  assert.equal(completed.status, "completed"); assert.equal(completed.notifications[0].status, "accepted");
  assert.match(h.state.deliveries[0].envelope.event.body, /Released exact fixture result/u);
  await createClaudeNativeTaskService({ ...h.deps, senderPermissionClass: "prompting" }).recover(held.id, owner);
  await restarted.reconcile(held.id);
  assert.equal(h.state.sends, 1); assert.equal(h.state.deliveries.length, 1);
  assert.equal(restarted.status(held.id).deadline_at, held.deadline_at);
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

test("Claude waiting notifications reuse Send's Watch and deduplicate polls and restarts without inventing responses", async t => {
  const h = harness(t), sent = await h.service.send({ ...input, callbackRoute: route });
  h.state.entry.status = "working";
  assert.equal((await h.service.watch({ ...input, callbackRoute: route })).id, sent.id);
  // Upgrade a pre-notification Watch that already persisted its registry hint.
  const legacy = h.repository.load(sent.id)!; legacy.waiting_for = "permission prompt";
  h.repository.save(legacy, legacy.revision);
  h.state.entry.status = "waiting";
  for (const [waitingFor, kind, waiting] of [["permission prompt", "approval", "permission prompt"],
    ["input needed", "input", "input needed"], ["PRIVATE_UNKNOWN_PROMPT", "unknown", "unknown"]]) {
    h.state.entry.waitingFor = waitingFor;
    const before = h.state.deliveries.length;
    const task = await h.service.reconcile(sent.id);
    assert.equal(task.waiting_for, waiting);
    assert.equal(h.state.deliveries.length, before + 1);
    const event = h.state.deliveries.at(-1)!.envelope.event;
    assert.equal(event.type, "claude_native_watch.interaction");
    assert.equal(event.metadata?.watch_id, sent.id);
    assert.equal(event.metadata?.native_input_id, sent.native_input_id);
    assert.deepEqual(event.metadata?.interaction_hint, { kind, actionable: false, source: "native_registry" });
    assert.equal(event.requires_response, false);
    assert.equal(event.metadata?.interaction_id, undefined);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_UNKNOWN_PROMPT/u);
    const restarted = createClaudeNativeTaskService(h.deps);
    await restarted.reconcile(sent.id);
    assert.equal((await restarted.watch({ ...input, callbackRoute: route })).id, sent.id);
    assert.equal(h.state.deliveries.length, before + 1);
  }
  h.state.entry.status = "working";
  assert.equal((await h.service.reconcile(sent.id)).waiting_for, undefined);
  h.state.entry.status = "waiting"; h.state.entry.waitingFor = "permission prompt";
  await h.service.reconcile(sent.id);
  assert.equal(h.state.deliveries.length, 4);
  assert.equal(new Set(h.state.deliveries.map(delivery => delivery.envelope.event.id)).size, 4);
  assert.equal(h.repository.list().length, 1); assert.equal(h.state.sends, 1);
  h.state.selected!.state = "completed";
  const completed = await h.service.reconcile(sent.id);
  assert.equal(completed.waiting_for, undefined); assert.equal(completed.waiting_notification_id, undefined);
  assert.equal(h.state.deliveries.at(-1)!.envelope.event.type, "claude_native_watch.settled");
  await h.service.reconcile(sent.id); assert.equal(h.state.deliveries.length, 5);
});

test("watching an existing waiting task notifies immediately and retires callbacks once that wait is resolved", async t => {
  const h = harness(t); h.state.entry.status = "waiting"; h.state.entry.waitingFor = "permission prompt";
  h.state.selected = selected(uuid(900)); h.state.selected.origin = "human";
  h.state.outcomes.push({ disposition: "retryable_failure", error_code: "temporarily_unavailable" });
  const watched = await h.service.watch({ ...input, callbackRoute: route });
  assert.equal(watched.waiting_for, "permission prompt");
  assert.equal(watched.notifications[0].status, "retry_wait"); assert.equal(h.state.deliveries.length, 1);
  const observe = h.deps.observe;
  h.deps.observe = async (...args) => ({ ...await observe(...args), readError: "read_failed" });
  h.state.now += 5001;
  const unreadable = await h.service.reconcile(watched.id);
  assert.equal(unreadable.notifications[0].status, "retry_wait");
  assert.equal(unreadable.waiting_notification_id, watched.waiting_notification_id);
  assert.equal(h.state.deliveries.length, 1, "unreadable current state pauses reminders without losing the retry");
  h.deps.observe = observe; h.state.entry.status = "working";
  const resumed = await createClaudeNativeTaskService(h.deps).reconcile(watched.id);
  assert.equal(resumed.waiting_for, undefined); assert.equal(resumed.notifications[0].status, "failed");
  assert.deepEqual(resumed.notifications[0].outcome, { disposition: "permanent_failure", error_code: "claude_native_callback_stale" });
  assert.equal(h.state.deliveries.length, 1);
  await assert.rejects(h.service.retryCallback(watched.id, { ...owner, notificationId: watched.notifications[0].id }),
    { code: "backend_callback_not_retryable" });
  h.state.entry.status = "waiting";
  h.state.outcomes.push({ disposition: "retryable_failure", error_code: "temporarily_unavailable" });
  const next = await h.service.reconcile(watched.id);
  assert.notEqual(next.waiting_notification_id, watched.waiting_notification_id);
  h.state.selected.state = "completed"; h.state.now += 5001;
  const completed = await h.service.reconcile(watched.id);
  assert.equal(completed.notifications[1].status, "failed");
  assert.equal(h.state.deliveries.length, 3);
  assert.equal(h.state.deliveries[2].envelope.event.type, "claude_native_watch.settled");
  assert.equal(h.repository.list().length, 1); assert.equal(h.state.sends, 0);
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

test("invalid runtime sender configuration leaves discovery and inspection available but prevents new input", async t => {
  const h = harness(t); let inspections = 0, processChecks = 0, sends = 0;
  const runtime = createClaudeNativeRuntime({ storeDir: h.dir, claudeConfigDirs: [target.configDir],
    senderPermissionClass: "invalid-policy", processCheck: async () => { processChecks++; },
    client: { discover: async () => ({ sessions: [entry], errors: [] }),
      inspect: async () => { inspections++; return entry; },
      send: async () => { sends++; return { dispatchState: "written" }; }, close: () => {} } });
  try {
    assert.equal((await runtime.catalog.discover()).sessions.length, 1);
    assert.equal((await runtime.inspect(target)).nativeId, input.nativeId);
    assert.equal(inspections, 1); assert.equal(processChecks, 1);
    await assert.rejects(runtime.tasks.send(input), { code: "invalid_sender_permission_class" });
    assert.equal(inspections, 1); assert.equal(processChecks, 1); assert.equal(sends, 0);
    assert.deepEqual(runtime.tasks.list(), []);
  } finally { await runtime.close(); }
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
