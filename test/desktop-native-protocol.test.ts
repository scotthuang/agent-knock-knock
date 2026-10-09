import assert from "node:assert/strict";
import test from "node:test";
import { DesktopIpcClient, VERIFIED_DESKTOP_BUILD } from "../src/desktop-ipc-client.js";
import { reduceDesktopSnapshot } from "../src/desktop-snapshot.js";
import { desktopInteractions, desktopRequestResponse, findDesktopRequestEffect } from "../src/desktop-request-interactions.js";
import { DesktopIpcError, type DesktopIpcTransport, type DesktopRequestInteraction } from "../src/desktop-types.js";

type Wire = Record<string, any>;
const target = { threadId: "thread-one", ownerClientId: "owner-one" };
const identity = { ...target, revision: 1 };
function request(kind = "command", id: string | number = 17): Wire {
  const method = kind === "blocking" ? "item/tool/requestUserInput" : kind === "file" ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
  return { id, method, params: { threadId: target.threadId, turnId: "turn-one", itemId: "item-one",
    ...(kind === "blocking" ? { questions: [{ id: "color", question: "Which color?", isOther: true, isSecret: false,
      options: [{ label: "Green" }, { label: "Blue" }] }] } : kind === "command" ? { kind: "command", command: "printf OK", availableDecisions: ["accept", "cancel"] } : {}) } };
}
function state(nativeRequest = request()): Wire {
  return { id: target.threadId, hostId: "local", mode: "default", resumeState: "resumed", threadRuntimeStatus: { type: "active" },
    requests: [nativeRequest], turns: [{ turnId: "turn-one", status: "inProgress", items: [] }],
    latestModel: "model-one", latestReasoningEffort: "high", latestCollaborationMode: { mode: "default",
      settings: { model: "model-one", reasoning_effort: "high", developer_instructions: null } },
    latestThreadSettings: { model: "model-one", effort: "high", permissions: ":workspace" },
    currentPermissions: { activePermissionProfile: { id: ":workspace", extends: null }, approvalPolicy: "on-request",
      approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp/test"] } } };
}
class Fixture implements DesktopIpcTransport {
  sent: Wire[] = []; raw = state(); revision = 1;
  handler?: (message: Wire) => boolean;
  private listeners = new Set<(message: unknown) => void>();
  private disconnects = new Set<(error: Error) => void>();
  send(message: Wire): void {
    this.sent.push(message);
    if (message.method === "initialize") { this.reply(message, { clientId: "client-one" }); return; }
    if (message.method === "thread-owner-discovery") { this.reply(message, { supportsUntrustedAppInput: true }); return; }
    if (message.method === "thread-stream-following-changed") {
      if (message.params.following) this.emit({ type: "broadcast", sourceClientId: target.ownerClientId, targetClientIds: ["client-one"],
        method: "thread-stream-state-changed", version: 11, params: { hostId: "local", conversationId: target.threadId,
          change: { type: "snapshot", revision: this.revision, conversationState: this.raw } } });
      return;
    }
    if (this.handler?.(message)) return;
    if (message.method === "thread-follower-read-model-settings") this.reply(message, { settings: {
      model: this.raw.latestModel, reasoningEffort: this.raw.latestReasoningEffort, resumeState: "resumed", mode: "default" } });
    else this.reply(message, { ok: true });
  }
  reply(message: Wire, result: Wire): void { this.emit({ type: "response", requestId: message.requestId, method: message.method,
    version: message.version, resultType: "success", handledByClientId: target.ownerClientId, result }); }
  emit(message: Wire): void { for (const listener of this.listeners) listener(message); }
  disconnect(): void { for (const listener of [...this.disconnects]) listener(new Error("lost connection")); }
  onMessage(listener: (message: unknown) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onDisconnect(listener: (error: Error) => void) { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }
  close(): void {}
}
const connect = (fixture: Fixture) => DesktopIpcClient.connect({ socketPath: "/tmp/desktop-protocol-not-real", compatibility: VERIFIED_DESKTOP_BUILD,
  transportFactory: async () => fixture });
const interaction = (raw: Wire) => desktopInteractions(reduceDesktopSnapshot(raw, identity))[0] as DesktopRequestInteraction;

test("Desktop request identity retains number versus string IDs and successive approval identities", () => {
  const one = interaction(state(request("command", 17))), two = interaction(state(request("command", "17")));
  assert.equal(one.requestId, 17); assert.equal(two.requestId, "17"); assert.notEqual(one.id, two.id);
  const next = request(); next.params.approvalId = "second-exec-bridge";
  assert.notEqual(one.id, interaction(state(next)).id);
  const network = request(); delete network.params.command; network.params.kind = "network";
  network.params.networkApprovalContext = { host: "example.com", protocol: "https" };
  assert.equal(interaction(state(network)).networkApprovalContext?.host, "example.com");
  assert.deepEqual(desktopRequestResponse(one, { decision: "decline" }), { decision: "decline" });
});

test("Desktop native approval dispatch preserves request ID and never treats ok as proof", async () => {
  for (const kind of ["command", "file"]) {
    const fixture = new Fixture(); fixture.raw = state(request(kind)); const client = await connect(fixture);
    const pending = interaction(fixture.raw);
    try {
      const receipt = await client.respondRequestOnce({ ...target, expectedRevision: 1, expectedTurnId: "turn-one",
        interactionId: pending.id, operationId: "operation:one", response: { decision: "decline" },
        beforeDispatch: async () => { fixture.revision++; } });
      assert.equal(receipt.acknowledged, true);
      const wire = fixture.sent.find(message => message.method === `thread-follower-${kind}-approval-decision`)!;
      assert.equal(wire.version, 1); assert.equal(wire.params.requestId, 17); assert.equal(wire.params.decision, "decline");
      assert.equal(findDesktopRequestEffect(reduceDesktopSnapshot(fixture.raw, identity), { interaction: pending, response: { decision: "decline" } }), null);
    } finally { client.close(); }
  }
});

test("Desktop blocking answer requires exact completed response item, same typed request ID and all answers", async () => {
  const fixture = new Fixture(); fixture.raw = state(request("blocking")); const client = await connect(fixture);
  const pending = interaction(fixture.raw), response = { answers: { color: ["Green"] } };
  try {
    await client.respondRequestOnce({ ...target, expectedRevision: 1, expectedTurnId: "turn-one", interactionId: pending.id,
      operationId: "blocking-one", response });
    const sent = fixture.sent.find(message => message.method === "thread-follower-submit-user-input")!;
    assert.deepEqual(JSON.parse(JSON.stringify(sent.params)), { conversationId: target.threadId, requestId: 17,
      response: { answers: { color: { answers: ["Green"] } } } });
    fixture.raw.requests = [];
    fixture.raw.turns[0].items = [{ id: "response-17", type: "userInputResponse", requestId: "17", turnId: "turn-one", completed: true, answers: { color: ["Green"] } }];
    assert.equal(findDesktopRequestEffect(reduceDesktopSnapshot(fixture.raw, identity), { interaction: pending, response }), null);
    fixture.raw.turns[0].items[0].requestId = 17;
    assert.equal(findDesktopRequestEffect(reduceDesktopSnapshot(fixture.raw, identity), { interaction: pending, response })?.evidence, "exact_blocking_answer_observed");
    assert.equal(findDesktopRequestEffect(reduceDesktopSnapshot(fixture.raw, identity), { interaction: pending, response: { answers: { color: ["Blue"] } } }), null);
  } finally { client.close(); }
});

test("Desktop approval effects distinguish accept progression from decline and ignore missing-item completion", () => {
  const raw = state(), pending = interaction(raw); raw.requests = []; raw.turns[0].status = "completed";
  const effect = (decision: "accept" | "decline") => findDesktopRequestEffect(reduceDesktopSnapshot(raw, identity), { interaction: pending, response: { decision } });
  assert.equal(effect("accept"), null);
  raw.turns[0].items = [{ id: "item-one", type: "commandExecution", status: "declined", command: "printf OK", exitCode: null }];
  assert.equal(effect("accept"), null); assert.equal(effect("decline")?.evidence, "exact_approval_item_advanced");
  raw.turns[0].items[0].status = "completed"; raw.turns[0].items[0].exitCode = 0;
  assert.equal(effect("accept")?.itemId, "item-one"); assert.equal(effect("decline"), null);
});

test("Desktop stale request cannot dispatch and post-dispatch loss cannot replay", async () => {
  for (const mode of ["stale", "lost"] as const) {
    const fixture = new Fixture(), client = await connect(fixture), pending = interaction(fixture.raw);
    if (mode === "lost") fixture.handler = message => {
      if (message.method !== "thread-follower-command-approval-decision") return false;
      fixture.disconnect(); return true;
    };
    const options = { ...target, expectedRevision: 1, expectedTurnId: "turn-one", interactionId: pending.id,
      operationId: "once", response: { decision: "accept" as const }, beforeDispatch: async () => {
        if (mode === "stale") { fixture.raw.requests = []; fixture.revision++; }
      } };
    try {
      await assert.rejects(client.respondRequestOnce(options), (error: unknown) => error instanceof DesktopIpcError && error.dispatchState === (mode === "stale" ? "not_sent" : "unknown"));
      if (mode === "lost") await assert.rejects(client.respondRequestOnce(options));
      assert.equal(fixture.sent.filter(message => message.method === "thread-follower-command-approval-decision").length, mode === "stale" ? 0 : 1);
    } finally { client.close(); }
  }
});

test("Desktop settings preserve native details, update only idle threads and expose acknowledgement separately", async () => {
  const fixture = new Fixture(); fixture.raw.requests = []; fixture.raw.threadRuntimeStatus = { type: "idle" }; fixture.raw.turns[0].status = "completed";
  const client = await connect(fixture);
  fixture.handler = message => {
    if (message.method !== "thread-follower-update-thread-settings") return false;
    assert.equal(message.version, 2); assert.equal(message.params.activeTurnId, undefined);
    fixture.reply(message, { applied: true }); return true;
  };
  try {
    const before = await client.observeThread(target);
    assert.equal(before.currentPermissions?.activePermissionProfile?.id, ":workspace");
    assert.equal(before.latestCollaborationMode?.settings.developer_instructions, null);
    const receipt = await client.updateThreadSettingsOnce({ ...target, operationId: "settings-one", settings: { model: "new-model", effort: "low" } });
    assert.equal(receipt.applied, true);
    // An acknowledged update is not claimed effective when native readback still shows the previous value.
    assert.equal(receipt.modelSettings.model, "model-one");
    fixture.raw.threadRuntimeStatus = { type: "active" }; fixture.raw.turns[0].status = "inProgress"; fixture.revision++;
    await assert.rejects(client.updateThreadSettingsOnce({ ...target, operationId: "settings-two", settings: { permissions: ":read-only" } }), /idle/u);
  } finally { client.close(); }
});

test("Desktop snapshot keeps next-turn permission defaults separate from the previous turn permissions", () => {
  const raw = state(); raw.requests = []; raw.threadRuntimeStatus = { type: "idle" }; raw.turns[0].status = "completed";
  raw.latestThreadSettings = { permissions: ":read-only", activePermissionProfile: { id: ":read-only", extends: null },
    approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } };
  raw.currentPermissions = { activePermissionProfile: { id: ":danger-full-access", extends: null },
    approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } };
  const snapshot = reduceDesktopSnapshot(raw, identity);
  assert.equal(snapshot.threadSettings?.activePermissionProfile?.id, ":read-only");
  assert.equal(snapshot.threadSettings?.approvalPolicy, "on-request");
  assert.equal(snapshot.threadSettings?.sandboxPolicy?.type, "readOnly");
  assert.equal(snapshot.currentPermissions?.activePermissionProfile?.id, ":danger-full-access");
  assert.equal(snapshot.currentPermissions?.sandboxPolicy?.type, "dangerFullAccess");
});

test("Desktop interrupt always includes exact expected turn and rejects wrong native acknowledgement", async () => {
  for (const correct of [true, false]) {
    const fixture = new Fixture(); fixture.raw.requests = []; const client = await connect(fixture);
    fixture.handler = message => {
      if (message.method !== "thread-follower-interrupt-turn") return false;
      assert.equal(message.version, 4); assert.equal(message.params.expectedTurnId, "turn-one");
      fixture.reply(message, { ok: true, interruptedTurnId: correct ? "turn-one" : "other-turn" }); return true;
    };
    try {
      const operation = client.interruptTurnOnce({ ...target, expectedTurnId: "turn-one", operationId: "interrupt" });
      if (correct) assert.equal((await operation).interruptedTurnId, "turn-one");
      else await assert.rejects(operation, (error: unknown) => error instanceof DesktopIpcError && error.dispatchState === "unknown");
    } finally { client.close(); }
  }
});
