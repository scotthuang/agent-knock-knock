import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { executeCliCommand } from "../src/cli-core.js";
import type { CliCommandDependencies } from "../src/cli-runtime-context.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import { createDesktopCreationStore } from "../src/desktop-creation-store.js";
import { createDesktopTaskService } from "../src/desktop-task-service.js";
import { createDesktopResponseStore } from "../src/desktop-response-store.js";
import { createDesktopResponseService } from "../src/desktop-response-service.js";
import { createDesktopSessionControls } from "../src/desktop-session-controls.js";
import { DesktopSessionCatalog } from "../src/desktop-session-catalog.js";
import { DesktopCreationNativeError, VERIFIED_DESKTOP_CREATION_BUILD, type DesktopCreationNative } from "../src/desktop-creation-native.js";
import type { DesktopSnapshot, DesktopSendTurnOptions } from "../src/desktop-types.js";

const ID = `desktop-create:${"3".repeat(64)}`, THREAD = "00000000-0000-4000-8000-000000000001";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akk-create-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, ".codex"), storeDir = path.join(root, "store"); fs.mkdirSync(codexHome);
  const target = { codexHome, hostId: "local", threadId: THREAD };
  let snapshot: DesktopSnapshot = { threadId: THREAD, cwd: root, ownerClientId: "owner", revision: 1,
    runtimeStatus: "idle", pendingRequests: [], pendingRequestCount: 0, unconfirmedSubmissionCount: 0,
    tailKnown: true, latestTurnId: null, turns: [], canSend: true };
  const state = { creates: 0, opens: 0, sends: 0, monitors: 0, closes: 0, runtimeCreates: 0,
    failSendReceipt: false, monitorError: false, createError: undefined as Error | undefined,
    title: "Fixture" as string | null, afterAck: undefined as (() => Promise<void>) | undefined };
  const repository = createDesktopStateStore(storeDir, { acquire: () => () => {} });
  const transport = { observe: async () => structuredClone(snapshot),
    start: async (_identity: unknown, input: DesktopSendTurnOptions) => {
      await input.beforeDispatch?.(snapshot); state.sends++;
      snapshot = { ...snapshot, runtimeStatus: "active", revision: 2, canSend: false, latestTurnId: "turn-one",
        turns: [{ turnId: "turn-one", status: "inProgress", itemsComplete: true,
          items: [{ id: "user-one", type: "userMessage", clientId: input.clientUserMessageId, content: [{ type: "text", text: input.prompt }] }] }] };
      return { turnId: "turn-one", clientUserMessageId: input.clientUserMessageId, revision: 2, atomicIdlePrecondition: false as const };
    } };
  const tasks = createDesktopTaskService({ repository, ...transport,
    deliver: async () => { throw new Error("No real callback from this test"); } });
  const originalSend = tasks.send;
  tasks.send = async input => { const task = await originalSend(input); if (state.failSendReceipt) throw new Error("post-send receipt unavailable"); return task; };
  const responses = createDesktopResponseService({ tasks: repository,
    repository: createDesktopResponseStore(storeDir, { acquire: () => () => {} }), observe: transport.observe,
    answerAsync: async () => { throw new Error("not used"); } });
  const controls = createDesktopSessionControls({ observe: transport.observe,
    readModelSettings: async () => ({ model: null, reasoningEffort: null }),
    updateSettings: async () => { throw new Error("not used"); }, interruptTurn: async () => { throw new Error("not used"); } });
  const catalog = new DesktopSessionCatalog({ codexHomes: [codexHome], readMetadata: async () => [] });
  const receipt = () => ({ threadId: THREAD, cwd: root, projectId: null, title: state.title });
  const native: DesktopCreationNative = { metadata: { appPath: "/app", binaryPath: "/app/codex", codexHome,
    appVersion: VERIFIED_DESKTOP_CREATION_BUILD.version, appBuild: VERIFIED_DESKTOP_CREATION_BUILD.build,
    backendVersion: VERIFIED_DESKTOP_CREATION_BUILD.backendVersion }, projects: async () => [],
    resolveProject: async () => { throw new Error("not used"); },
    create: async input => { await input.beforeDispatch?.(); state.creates++;
      if (state.createError) throw state.createError;
      await input.onCreated?.(receipt()); await state.afterAck?.(); return receipt(); },
    read: async () => receipt(), close: async () => {} };
  const deps: CliCommandDependencies = { cwd: root, env: { HOME: root }, runtimeLog: () => {},
    createDesktopCreationNative: async () => native, desktopCreationOwnerAttempts: 1,
    openDesktopThread: async id => { assert.equal(id, THREAD); state.opens++; },
    createDesktopRuntime: () => { state.runtimeCreates++; return { compatibility: VERIFIED_DESKTOP_CREATION_BUILD,
      catalog, transport, tasks, responses, controls, close: async () => { state.closes++; } }; },
    launchDesktopMonitor: async () => { state.monitors++; if (state.monitorError) throw new Error("No monitor"); return 321; } };
  const args = { operationId: ID, openclawSession: "controller", cwd: root, title: "Fixture", message: "Reply READY", storeDir };
  const run = async (options: Record<string, unknown> = args) => JSON.parse((await executeCliCommand("desktop-create", options, deps)).stdout);
  const resume = { operationId: ID, openclawSession: "controller", resumeCreation: true, storeDir };
  return { root, state, tasks, run, args, resume, store: createDesktopCreationStore(storeDir), target };
}

test("Desktop creation CLI opens the created identity, sends once, and exposes its accepted Watch and monitor", async t => {
  const f = fixture(t), result = await f.run();
  assert.equal(result.status, "ready"); assert.equal(result.creation_status, "ready"); assert.equal(result.title_confirmed, true);
  assert.equal(result.request_state, "accepted"); assert.equal(result.agent_acceptance, "proven");
  assert.equal(result.callback_expected, true); assert.equal(result.monitor_pid, 321); assert.ok(result.watch_id);
  const deadline = f.tasks.status(result.watch_id).deadline_at;
  const same = await f.run(f.resume);
  assert.equal(same.watch_id, result.watch_id); assert.equal(f.tasks.status(same.watch_id).deadline_at, deadline);
  assert.deepEqual([f.state.creates, f.state.opens, f.state.sends], [1, 1, 1]);
  assert.equal(result.next_action, undefined);
});

test("Desktop creation CLI never projects another controller's record or a different immutable task", async t => {
  const f = fixture(t); await f.run(); const before = f.state.runtimeCreates;
  await assert.rejects(f.run({ ...f.args, openclawSession: "different-controller" }), /not found for this controller/u);
  await assert.rejects(f.run({ ...f.resume, openclawSession: "different-controller" }), /not found for this controller/u);
  await assert.rejects(f.run({ ...f.args, message: "A different task" }), /different immutable input/u);
  assert.equal(f.state.runtimeCreates, before); assert.equal(f.state.sends, 1);
});

test("Desktop creation CLI reports live creation as progress and preserves uncertainty after a lost task receipt", async t => {
  const f = fixture(t), started = deferred(), release = deferred();
  f.state.afterAck = async () => { started.resolve(); await release.promise; };
  const running = f.run(); await started.promise;
  const pending = await f.run(f.resume);
  assert.equal(pending.status, "creating"); assert.equal(pending.operation_in_flight, true);
  assert.equal(pending.request_state, "not_sent"); assert.equal(f.state.opens, 0);
  f.state.failSendReceipt = true; release.resolve();
  const uncertain = await running;
  assert.equal(uncertain.creation_status, "ready"); assert.equal(uncertain.request_state, "uncertain");
  assert.equal(uncertain.callback_expected, false); assert.match(uncertain.next_action, /not confirmed/u);
  f.state.failSendReceipt = false;
  const accepted = await f.run(f.resume);
  assert.equal(accepted.request_state, "accepted"); assert.equal(f.state.sends, 1); assert.ok(accepted.watch_id);
});

test("Desktop creation CLI does not call uncertain creation successful or present an unconfirmed title as applied", async t => {
  const f = fixture(t);
  f.state.createError = new DesktopCreationNativeError("timeout", "Unknown creation result", "unknown");
  const unknown = await f.run();
  assert.equal(unknown.status, "uncertain"); assert.equal(unknown.created, null);
  assert.equal(unknown.available_actions.continue_creation, undefined); assert.equal(f.state.opens, 0);
  const g = fixture(t); g.state.title = null;
  const created = await g.run({ ...g.args, message: undefined });
  assert.equal(created.created, true); assert.equal(created.title, null);
  assert.equal(created.requested_title, "Fixture"); assert.equal(created.title_confirmed, false);
});

test("Desktop creation CLI separates accepted task from monitor launch failure", async t => {
  const f = fixture(t); f.state.monitorError = true;
  const result = await f.run();
  assert.equal(result.request_state, "accepted"); assert.equal(result.agent_acceptance, "proven");
  assert.equal(result.callback_expected, false); assert.equal(result.monitor_error, "desktop_monitor_launch_failed");
});
