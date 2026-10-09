import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCliCommand } from "../src/cli-core.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { DesktopSessionCatalog } from "../src/desktop-session-catalog.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import { createDesktopTaskService } from "../src/desktop-task-service.js";
import { VERIFIED_DESKTOP_BUILD } from "../src/desktop-ipc-client.js";
import type { DesktopSnapshot, DesktopTransportPort } from "../src/desktop-types.js";
import type { CliCommandDependencies } from "../src/cli-runtime-context.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = { codexHome: path.join(root, ".codex"), hostId: "local", threadId: "desktop-thread" };
  const id = createDesktopConversationId(target);
  const storeDir = path.join(root, "store");
  let snapshot: DesktopSnapshot = { threadId: target.threadId, ownerClientId: "exact-owner", revision: 1,
    runtimeStatus: "idle", pendingRequests: [], pendingRequestCount: 0, unconfirmedSubmissionCount: 0,
    tailKnown: true, latestTurnId: null, turns: [], canSend: true };
  let sends = 0, callbacks = 0, launches = 0, closed = 0;
  const transport: DesktopTransportPort = {
    observe: async () => structuredClone(snapshot),
    async start(_identity, input) {
      await input.beforeDispatch?.(snapshot); sends++;
      snapshot = { ...snapshot, runtimeStatus: "active", revision: 2, canSend: false, latestTurnId: "turn-one",
        turns: [{ turnId: "turn-one", status: "inProgress", itemsComplete: true,
          items: [{ id: "user-one", type: "userMessage", clientId: input.clientUserMessageId, content: [{ type: "text", text: input.prompt }] }] }] };
      return { turnId: "turn-one", clientUserMessageId: input.clientUserMessageId, revision: 2, atomicIdlePrecondition: false };
    }
  };
  const repository = createDesktopStateStore(storeDir, { acquire: () => () => {} });
  const catalog = new DesktopSessionCatalog({ codexHomes: [target.codexHome], readMetadata: async () => [{
    source: { codexHome: target.codexHome, database: "/fixture/catalog", kind: "desktop_catalog", status: "ok" },
    rows: [{ thread_id: target.threadId, host_id: "local", display_title: "Desktop test", source_updated_at: 1 }]
  }] });
  const tasks = createDesktopTaskService({ repository, ...transport, deliver: () => {
    callbacks++; return { disposition: "accepted", accepted_at: new Date().toISOString(), acceptance_id: "callback-accepted" };
  } });
  const deps: CliCommandDependencies = { cwd: root, env: { HOME: root }, runtimeLog: () => {},
    createDesktopRuntime: () => ({ compatibility: VERIFIED_DESKTOP_BUILD, catalog, transport, tasks,
      close: async () => { closed++; } }),
    launchDesktopMonitor: async () => { launches++; return 1234; } };
  const run = async (command: string, options: Record<string, unknown> = {}) => JSON.parse((await executeCliCommand(command,
    { storeDir, ...options }, deps)).stdout);
  return { id, tasks, run, deps, get sends() { return sends; }, get callbacks() { return callbacks; },
    get launches() { return launches; }, get closed() { return closed; },
    finish() { snapshot.runtimeStatus = "idle"; snapshot.canSend = true;
      snapshot.turns[0]!.status = "completed";
      snapshot.turns[0]!.items.push({ id: "answer", type: "agentMessage", phase: "final_answer", text: "EXACT_DONE" }); } };
}

test("Desktop CLI sends once, launches exact Watch, recovers completion and enforces controller ownership", async t => {
  const f = fixture(t);
  const input = { conversation: f.id, message: "Only reply READY", messageId: "stable-cli-message", openclawSession: "controller-one" };
  const receipt = await f.run("send", input);
  assert.equal(receipt.agent_acceptance, "proven"); assert.equal(receipt.native_turn_id, "turn-one");
  assert.equal(receipt.callback_expected, true); assert.equal(receipt.monitor_pid, 1234);
  assert.equal(f.sends, 1);
  const same = await f.run("send", input);
  assert.equal(same.watch_id, receipt.watch_id); assert.equal(f.sends, 1);
  const explicit = await f.run("watch-terminal", { conversation: f.id, openclawSession: "controller-two" });
  assert.equal(explicit.native_turn_id, "turn-one"); assert.notEqual(explicit.watch_id, receipt.watch_id);
  await assert.rejects(f.run("unwatch-terminal", { watch: explicit.watch_id, openclawSession: "controller-one" }), /different controller/);
  await f.run("unwatch-terminal", { watch: explicit.watch_id, openclawSession: "controller-two" });
  f.finish();
  const recovered = await f.run("reconcile-desktop-watches");
  assert.equal(recovered.callbacks_delivered, 1); assert.equal(f.callbacks, 1);
  const status = await f.run("watch-status", { watch: receipt.watch_id, openclawSession: "controller-one" });
  assert.equal(status.status, "completed"); assert.equal(status.final_text, "EXACT_DONE");
  await f.run("reconcile-desktop-watches"); assert.equal(f.callbacks, 1);
  assert.ok(f.closed >= 7);
});

test("Desktop CLI list/status are read-only, idle Watch refuses, unsupported operations never reach terminals", async t => {
  const f = fixture(t);
  const list = await f.run("desktop-list");
  assert.equal(list.desktop_sessions[0].conversation_id, f.id);
  assert.equal(list.desktop_sessions[0].connection_state, "unconfirmed");
  const status = await f.run("status", { conversation: f.id });
  assert.equal(status.connection_state, "live_owner_verified"); assert.equal(status.latest_turn, null);
  await assert.rejects(f.run("watch-terminal", { conversation: f.id, openclawSession: "controller-one" }), /no uniquely confirmed active task/);
  for (const command of ["approve", "respond", "cancel", "new-thread", "native-inspect"]) {
    await assert.rejects(f.run(command, { conversation: f.id }), /Desktop v1 supports/);
  }
  await assert.rejects(f.run("send", { conversation: f.id, terminal: "terminal:v2:fake", message: "hello", openclawSession: "controller" }), /exactly one/);
  assert.equal(f.sends, 0); assert.equal(f.launches, 0);
});

test("Desktop CLI keeps a persisted Watch but reports monitor launch failure without promising callbacks", async t => {
  const f = fixture(t);
  f.deps.launchDesktopMonitor = async () => { throw new Error("spawn failed"); };
  const result = await f.run("send", { conversation: f.id, message: "READY", messageId: "stable-failure", openclawSession: "controller" });
  assert.equal(result.agent_acceptance, "proven"); assert.equal(result.callback_expected, false);
  assert.equal(result.monitor_error, "desktop_monitor_launch_failed");
  assert.equal(f.tasks.status(result.watch_id).status, "watching");
});
