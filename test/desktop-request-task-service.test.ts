import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createTerminalWatchOpenClawCallbackRoute } from "../src/callback-transport.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { desktopRequestInteractionId, parseDesktopRequestInteraction } from "../src/desktop-request-interactions.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import { createDesktopTaskService } from "../src/desktop-task-service.js";
import type { DesktopRequestInteraction, DesktopSnapshot } from "../src/desktop-types.js";

const target = { codexHome: "/test/codex", hostId: "local", threadId: "thread-exact" };
const desktopId = createDesktopConversationId(target);
function harness(t: TestContext, kind: DesktopRequestInteraction["kind"] = "command_approval") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-request-watch-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const method = kind === "blocking_question" ? "item/tool/requestUserInput"
    : kind === "file_approval" ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
  const snapshot: DesktopSnapshot = { threadId: target.threadId, ownerClientId: "owner-one", revision: 1, runtimeStatus: "active",
    pendingRequests: [{ kind: kind === "blocking_question" ? "user_input" : "approval", method, requestId: "request-seven", turnId: "native-one" }],
    pendingRequestCount: 1, unconfirmedSubmissionCount: 0, tailKnown: true, latestTurnId: "native-one", canSend: false,
    turns: [{ turnId: "native-one", status: "inProgress", itemsComplete: true, items: [{ id: "request-item",
      type: kind === "file_approval" ? "fileChange" : "commandExecution", status: "inProgress",
      ...(kind === "file_approval" ? { changes: [{ path: "/tmp/owned-output", diff: "+owned" }] } : {}) }] }] };
  const request = parseDesktopRequestInteraction({ id: "request-seven", method,
    params: { threadId: target.threadId, turnId: "native-one", itemId: "request-item", command: "printf owned", reason: "Owned test",
      ...(kind === "blocking_question" ? { questions: [{ id: "color", question: "Choose a color", options: [{ label: "Green" }], isOther: true }] } : {}) }
  }, target.threadId, snapshot.turns)!;
  snapshot.pendingInteractions = [request];
  const repository = createDesktopStateStore(directory, { acquire: () => () => {} });
  const service = createDesktopTaskService({ repository, observe: async () => structuredClone(snapshot),
    start: async () => { throw new Error("Watch must not send a task"); } });
  const input = { target, desktopId, controllerSession: "controller-one",
    callbackRoute: createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: "controller-one" }) };
  return { snapshot, request, service, input };
}

for (const kind of ["command_approval", "file_approval", "blocking_question"] as const) {
  test(`Desktop ${kind} publishes one exact actionable notification instead of a duplicate manual reminder`, async t => {
    const h = harness(t, kind); const watched = await h.service.watch(h.input);
    assert.equal(watched.pending_manual_count, 0); assert.equal(watched.pending_interactions?.length, 1);
    assert.equal(watched.notifications.length, 1); assert.equal(watched.notifications[0].envelope.event.requires_response, true);
    const event = watched.notifications[0].envelope.event;
    assert.equal(event.metadata?.action, kind === "blocking_question" ? "respond" : "approve");
    assert.equal(event.metadata?.interaction_id, h.request.id); assert.match(event.body, /Refresh AKK Status/);
    assert.doesNotMatch(JSON.stringify(event), /interaction_prompt_fingerprint|expires_at|available_actions|request-seven/);
    if (kind === "file_approval") assert.match(event.body, /owned-output/);
    const repeated = await h.service.reconcile(watched.id); assert.equal(repeated.notifications.length, 1);
  });
}

test("unsupported Desktop special forms keep manual notification alongside native actionable approval", async t => {
  const h = harness(t);
  h.snapshot.pendingRequests.push({ kind: "user_input", method: "mcpServer/elicitation/request", requestId: "manual-only", turnId: "native-one" });
  h.snapshot.pendingRequestCount++;
  const watched = await h.service.watch(h.input);
  assert.equal(watched.pending_manual_count, 1); assert.equal(watched.pending_interactions?.length, 1);
  assert.deepEqual(watched.notifications.map(notification => notification.envelope.event.type), ["desktop_watch.interaction", "desktop_watch.manual"]);
  assert.equal(watched.notifications[1].envelope.event.requires_response, false);
});

test("incomplete Desktop turn items do not suppress fresh native approval requests or imply acceptance", async t => {
  const h = harness(t); h.snapshot.turns[0].itemsComplete = false;
  const watched = await h.service.watch(h.input);
  assert.equal(watched.status, "watching"); assert.equal(watched.observation_error, "desktop_async_questions_incomplete");
  assert.equal(watched.pending_interactions?.length, 1); assert.equal(watched.notifications[0].status, "ready");
  h.snapshot.pendingRequests = []; h.snapshot.pendingInteractions = []; h.snapshot.pendingRequestCount = 0;
  const observed = await h.service.reconcile(watched.id);
  assert.deepEqual(observed.pending_interactions, []); assert.equal(observed.notifications[0].status, "failed");
  assert.equal(observed.status, "watching", "request disappearance is not task completion");
});

test("blocking Desktop prompt notifications become obsolete after the native request is resolved", async t => {
  const h = harness(t, "blocking_question"); const watched = await h.service.watch(h.input);
  h.snapshot.pendingRequests = []; h.snapshot.pendingInteractions = []; h.snapshot.pendingRequestCount = 0;
  const resolved = await h.service.reconcile(watched.id);
  assert.equal(resolved.status, "watching"); assert.deepEqual(resolved.pending_interactions, []);
  assert.equal(resolved.notifications[0].status, "failed"); assert.equal(resolved.pending_manual_count, 0);
});

test("a legacy manual-only Desktop request is promoted without delivering its obsolete manual reminder", async t => {
  const h = harness(t); h.snapshot.pendingInteractions = [];
  const old = await h.service.watch(h.input);
  assert.equal(old.pending_manual_count, 1); assert.equal(old.notifications[0].envelope.event.type, "desktop_watch.manual");
  h.snapshot.pendingInteractions = [h.request];
  const upgraded = await h.service.reconcile(old.id);
  assert.equal(upgraded.pending_manual_count, 0); assert.equal(upgraded.pending_interactions?.length, 1);
  assert.equal(upgraded.notifications[0].status, "failed");
  assert.equal(upgraded.notifications[1].envelope.event.type, "desktop_watch.interaction");
  assert.equal(upgraded.notifications[1].status, "ready");
});

test("Desktop manual attention keeps numeric and string native request IDs distinct", async t => {
  const h = harness(t); h.request.requestId = 7; h.request.id = desktopRequestInteractionId(h.request);
  h.snapshot.pendingRequests[0].requestId = 7;
  h.snapshot.pendingRequests.push({ ...h.snapshot.pendingRequests[0], requestId: "7" });
  h.snapshot.pendingRequestCount = 2;
  const watched = await h.service.watch(h.input);
  assert.equal(watched.pending_interactions?.length, 1); assert.equal(watched.pending_manual_count, 1);
  assert.deepEqual(watched.notifications.map(notification => notification.envelope.event.type), ["desktop_watch.interaction", "desktop_watch.manual"]);
});
