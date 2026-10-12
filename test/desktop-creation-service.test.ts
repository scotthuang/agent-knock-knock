import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createDesktopCreationService, type DesktopCreationServiceDependencies } from "../src/desktop-creation-service.js";
import { createDesktopCreationStore, type DesktopCreationRecord, type DesktopCreationRequest } from "../src/desktop-creation-store.js";
import { DesktopCreationNativeError, type DesktopCreationNative } from "../src/desktop-creation-native.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import { createDesktopTaskService } from "../src/desktop-task-service.js";
import type { DesktopSnapshot } from "../src/desktop-types.js";

const ID = `desktop-create:${"1".repeat(64)}`, THREAD = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function harness(t: TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akk-create-service-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input: DesktopCreationRequest = { codexHome: dir, cwd: dir, title: "Fixture", request: "Do fixture work", timeoutMs: 43_200_000 };
  const store = createDesktopCreationStore(dir), tasks = createDesktopStateStore(dir, { acquire: () => () => {} });
  const state = { creates: 0, reads: 0, closes: 0, connects: 0, opens: 0, starts: 0, projectId: null as string | null,
    afterAck: undefined as (() => Promise<void>) | undefined, close: undefined as (() => Promise<void>) | undefined,
    readError: undefined as Error | undefined, createError: undefined as Error | undefined,
    wrongRead: false, wrongOwner: false, ownerMissing: false, afterSend: false, priorTurn: false,
    beforeStart: undefined as (() => void) | undefined };
  const receipt = () => ({ threadId: THREAD, cwd: dir, title: input.title, projectId: state.projectId });
  const snapshot = (): DesktopSnapshot => ({ threadId: THREAD, cwd: state.wrongOwner ? "/wrong" : dir, ownerClientId: "owner",
    revision: 1, runtimeStatus: state.afterSend ? "active" : "idle", tailKnown: true,
    latestTurnId: state.afterSend ? "turn-one" : state.priorTurn ? "prior-turn" : null,
    turns: state.afterSend ? [{ turnId: "turn-one", status: "inProgress", itemsComplete: true, items: [] }]
      : state.priorTurn ? [{ turnId: "prior-turn", status: "completed", itemsComplete: true, items: [] }] : [],
    pendingRequests: [], pendingRequestCount: 0, unconfirmedSubmissionCount: 0, canSend: !state.afterSend });
  const taskService = createDesktopTaskService({ repository: tasks, observe: async () => snapshot(),
    start: async (_target, options) => {
      state.beforeStart?.();
      await options.beforeDispatch?.(snapshot()); state.starts++; state.afterSend = true;
      return { turnId: "turn-one", clientUserMessageId: options.clientUserMessageId, revision: 1, atomicIdlePrecondition: false };
    }, deliver: async () => { throw new Error("No real notifications in fixture"); } });
  const native: DesktopCreationNative = { metadata: { appPath: "/app", binaryPath: "/app/codex", codexHome: dir,
    appVersion: "test", appBuild: "test", backendVersion: "test" }, projects: async () => [],
    resolveProject: async () => ({ project: { id: PROJECT, name: "Project", roots: [dir] }, cwd: dir }),
    create: async options => {
      await options.beforeDispatch?.(); state.creates++; state.projectId = options.projectId ?? null;
      if (state.createError) throw state.createError;
      await options.onCreated?.(receipt()); await state.afterAck?.(); return receipt();
    }, read: async threadId => {
      assert.equal(threadId, THREAD); state.reads++;
      if (state.readError) throw state.readError;
      return { ...receipt(), ...(state.wrongRead ? { cwd: "/wrong" } : {}) };
    }, close: async () => { state.closes++; await state.close?.(); } };
  const deps: DesktopCreationServiceDependencies = { store, connect: async () => { state.connects++; return native; },
    defaultDirectory: () => dir, open: async id => { assert.equal(id, THREAD); state.opens++; },
    observe: async () => { if (state.ownerMissing) throw Object.assign(new Error("No owner"), { code: "no_live_owner" }); return snapshot(); },
    tasks: taskService, ownerAttempts: 1, isProcessAlive: pid => pid === process.pid };
  const service = createDesktopCreationService(deps);
  const run = { operationId: ID, controllerSession: "controller", input };
  const seed = (extra: Partial<DesktopCreationRecord>) => store.update(ID, () => ({ schema: "agent-knock-knock/desktop-creation", version: 1,
    id: ID, controllerSession: "controller", input, status: "creating", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    cwd: dir, projectId: null, worker: { pid: 99999999, token: "dead", startedAt: new Date().toISOString() }, ...extra }));
  return { input, store, tasks, state, deps, service, run, seed };
}

test("concurrent invocations cannot hand off while naming or native close is pending; task is sent once", async t => {
  const h = harness(t), ack = deferred(), naming = deferred(), closing = deferred(), closeEntered = deferred();
  h.state.afterAck = async () => { ack.resolve(); await naming.promise; };
  h.state.close = async () => { closeEntered.resolve(); await closing.promise; };
  const first = h.service.run(h.run);
  await ack.promise;
  const second = await createDesktopCreationService(h.deps).run({ operationId: ID, controllerSession: "controller", resume: true });
  assert.equal(second.status, "creating"); assert.equal(second.threadId, THREAD); assert.equal(h.state.opens, 0);
  naming.resolve(); await closeEntered.promise;
  await h.service.run(h.run);
  assert.equal(h.state.opens, 0); assert.equal(h.state.starts, 0);
  closing.resolve(); const result = await first;
  assert.equal(result.status, "ready"); assert.ok(result.watchId); assert.equal(result.worker, undefined);
  await h.service.run(h.run);
  assert.deepEqual([h.state.creates, h.state.opens, h.state.starts], [1, 1, 1]);
  assert.equal(h.tasks.load(result.watchId!)?.deadline_at !== undefined, true);
});

test("dead worker with acknowledged UUID reconciles exact metadata, then opens original and preserves input", async t => {
  const h = harness(t); h.seed({ threadId: THREAD });
  const recovered = await h.service.run({ operationId: ID, controllerSession: "controller", resume: true });
  assert.equal(recovered.status, "ready"); assert.equal(recovered.threadId, THREAD);
  assert.deepEqual(recovered.input, h.input);
  assert.deepEqual([h.state.creates, h.state.reads, h.state.opens, h.state.starts], [0, 1, 1, 1]);
  await assert.rejects(h.service.run({ ...h.run, resume: true, input: { ...h.input, timeoutMs: 1 } }), /immutable/u);
});

test("missing creation ACK is permanently uncertain, while provable pre-dispatch failure never retries same operation", async t => {
  const h = harness(t); h.seed({});
  assert.equal((await h.service.run({ operationId: ID, controllerSession: "controller", resume: true })).status, "uncertain");
  await h.service.run(h.run); assert.equal(h.state.connects, 0);
  const other = harness(t);
  other.deps.connect = async () => { throw Object.assign(new Error("Unsupported app"), { code: "incompatible_desktop" }); };
  assert.equal((await createDesktopCreationService(other.deps).run(other.run)).status, "failed");
  await createDesktopCreationService(other.deps).run(other.run);
  assert.equal(other.state.creates, 0);
});

test("thread target mismatch permanently blocks recovery and never opens or sends", async t => {
  for (const phase of ["read", "owner"]) {
    const h = harness(t); h.seed({ threadId: THREAD });
    h.state.wrongRead = phase === "read"; h.state.wrongOwner = phase === "owner";
    assert.equal((await h.service.run({ operationId: ID, controllerSession: "controller", resume: true })).status, "uncertain");
    h.state.wrongRead = false; h.state.wrongOwner = false;
    const connects = h.state.connects;
    assert.equal((await h.service.run(h.run)).status, "uncertain");
    assert.equal(h.state.connects, connects); assert.equal(h.state.starts, 0);
  }
});

test("temporary read failure or missing owner can recover without duplicate creation or deep link", async t => {
  const h = harness(t); h.seed({ threadId: THREAD, status: "created" });
  h.state.readError = new Error("Unavailable");
  const failed = await h.service.run({ operationId: ID, controllerSession: "controller", resume: true });
  assert.equal(failed.status, "created"); assert.ok(failed.errorCode); assert.equal(h.state.opens, 0);
  h.state.readError = undefined; h.state.ownerMissing = true;
  assert.equal((await h.service.run(h.run)).status, "opening"); assert.equal(h.state.opens, 1);
  h.state.ownerMissing = false;
  assert.equal((await h.service.run(h.run)).status, "ready");
  assert.deepEqual([h.state.creates, h.state.opens, h.state.starts], [0, 1, 1]);
});

test("post-dispatch timeout cannot create another thread and naming failure recovers known identity only", async t => {
  const h = harness(t);
  h.state.createError = new DesktopCreationNativeError("timeout", "Timed out", "unknown");
  assert.equal((await h.service.run(h.run)).status, "uncertain");
  h.state.createError = undefined; await h.service.run(h.run);
  assert.equal(h.state.creates, 1); assert.equal(h.state.opens, 0);
  const other = harness(t);
  other.state.afterAck = async () => { throw new DesktopCreationNativeError("timeout", "Naming failed", "created", THREAD); };
  assert.equal((await other.service.run(other.run)).status, "creating"); assert.equal(other.state.opens, 0);
  other.state.afterAck = undefined;
  assert.equal((await other.service.run(other.run)).status, "ready");
  assert.equal(other.state.creates, 1); assert.equal(other.state.reads, 1);
});

test("unconfirmed creator process exit blocks both handoff and later recovery", async t => {
  const h = harness(t);
  h.state.close = async () => { throw Object.assign(new Error("Process still present"), { code: "process_exit_unconfirmed" }); };
  const result = await h.service.run(h.run);
  assert.equal(result.status, "uncertain"); assert.equal(result.threadId, THREAD);
  assert.equal(result.errorCode, "process_exit_unconfirmed"); assert.equal(h.state.opens, 0);
  h.state.close = undefined;
  await h.service.run(h.run);
  assert.equal(h.state.creates, 1); assert.equal(h.state.reads, 0); assert.equal(h.state.opens, 0);
});

test("initial creation task never appends to a thread used before send or during the dispatch barrier", async t => {
  for (const stage of ["before_send", "before_dispatch"]) {
    const h = harness(t);
    if (stage === "before_send") h.state.priorTurn = true;
    else h.state.beforeStart = () => { h.state.priorTurn = true; };
    const result = await h.service.run(h.run);
    assert.equal(result.status, "ready"); assert.equal(result.requestState, "not_sent");
    assert.equal(h.state.starts, 0);
    if (stage === "before_send") {
      assert.equal(result.errorCode, "desktop_creation_thread_changed"); assert.equal(result.watchId, undefined);
    } else {
      const task = h.tasks.load(result.watchId!)!;
      assert.equal(task.send_intent?.state, "not_sent"); assert.equal(task.send_intent?.error_code, "snapshot_changed");
    }
    await h.service.run(h.run);
    assert.equal(h.state.starts, 0); assert.equal(h.state.creates, 1);
  }
});
