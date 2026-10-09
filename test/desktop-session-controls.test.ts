import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopSessionControls, type DesktopSessionControlDependencies } from "../src/desktop-session-controls.js";
import { DesktopIpcError, type DesktopSnapshot } from "../src/desktop-types.js";

const target = { codexHome: "/home/test/.codex", hostId: "local", threadId: "thread-one" };
function fixture() {
  let state: DesktopSnapshot = { threadId: target.threadId, ownerClientId: "owner-one", revision: 1,
    runtimeStatus: "idle", mode: "default", resumeState: "resumed", pendingRequests: [], pendingRequestCount: 0,
    unconfirmedSubmissionCount: 0, tailKnown: true, latestTurnId: "old-turn", turns: [
      { turnId: "old-turn", status: "completed", itemsComplete: true, items: [] }], canSend: true,
    latestModel: "old-model", latestReasoningEffort: "high",
    latestCollaborationMode: { mode: "default", settings: { model: "old-model", reasoning_effort: "high", developer_instructions: "custom instructions" } },
    currentPermissions: { activePermissionProfile: { id: ":read-only", extends: null }, approvalPolicy: "on-request", approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false }, runtimeWorkspaceRoots: ["/work"] } };
  let onObserve = () => {}; let onUpdate = (input: Parameters<DesktopSessionControlDependencies["updateSettings"]>[1]) => {};
  let onInterrupt = (input: Parameters<DesktopSessionControlDependencies["interruptTurn"]>[1]) => {};
  const updates: Parameters<DesktopSessionControlDependencies["updateSettings"]>[1][] = [];
  const interrupts: string[] = [];
  const deps: DesktopSessionControlDependencies = {
    observe: async () => { onObserve(); return structuredClone(state); }, observationAttempts: 3, sleep: async () => {},
    readModelSettings: async () => ({ model: state.latestModel ?? null, reasoningEffort: state.latestReasoningEffort ?? null,
      daybreakEnabled: null, resumeState: "resumed", mode: "default", threadSource: "user", modelProvider: "openai" }),
    updateSettings: async (_identity, input) => { await input.beforeDispatch?.(state); updates.push(input); onUpdate(input);
      return { applied: true, snapshot: structuredClone(state), modelSettings: await deps.readModelSettings(target, { threadId: target.threadId, ownerClientId: state.ownerClientId }), revision: state.revision }; },
    interruptTurn: async (_identity, input) => { interrupts.push(input.expectedTurnId); onInterrupt(input);
      return { interruptedTurnId: input.expectedTurnId, snapshot: structuredClone(state) }; }
  };
  return { controls: createDesktopSessionControls(deps), updates, interrupts,
    get state() { return state; }, set state(value: DesktopSnapshot) { state = value; },
    observe(fn: () => void) { onObserve = fn; }, update(fn: typeof onUpdate) { onUpdate = fn; }, interrupt(fn: typeof onInterrupt) { onInterrupt = fn; } };
}

test("Desktop permissions require effective state, not the update acknowledgement or profile label alone", async () => {
  const f = fixture(); let readsAfterUpdate = 0;
  f.update(() => { f.state.currentPermissions!.activePermissionProfile = { id: ":danger-full-access", extends: null }; });
  f.observe(() => { if (f.updates.length && ++readsAfterUpdate === 2) f.state.currentPermissions = {
    activePermissionProfile: { id: ":danger-full-access", extends: null }, approvalPolicy: "never", approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" }, runtimeWorkspaceRoots: ["/work"] }; });
  const result = await f.controls.setPermissions(target, "full-access");
  assert.equal(result.applied, true); assert.equal(result.outcome, "changed"); assert.equal(f.updates.length, 1);
  assert.deepEqual(f.updates[0].settings, { permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" });
  assert.equal(f.state.latestTurnId, "old-turn"); assert.equal(f.state.latestModel, "old-model");
  assert.equal((await f.controls.setPermissions(target, "full-access")).outcome, "already_effective");
  assert.equal(f.updates.length, 1, "Full Access is a normal idempotent preset, without a confirmation gate");
});

test("Desktop settings stay unconfirmed when an acknowledged update never becomes effective", async () => {
  const f = fixture();
  const result = await f.controls.setPermissions(target, "default");
  assert.equal(result.applied, false); assert.equal(result.do_not_retry, true); assert.equal(result.outcome, "unconfirmed");
  assert.equal(f.updates.length, 1);
});

test("Desktop settings can recover an unknown receipt by reading effective state, without replay", async () => {
  const f = fixture();
  f.update(() => { f.state.currentPermissions = { activePermissionProfile: { id: ":workspace", extends: null },
    approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" }, runtimeWorkspaceRoots: ["/work"] };
    throw new DesktopIpcError("closed", "ack lost", "unknown"); });
  assert.equal((await f.controls.setPermissions(target, "default")).applied, true);
  assert.equal(f.updates.length, 1);
});

test("Desktop model options disclose missing catalog and explicit model updates preserve unrelated settings", async () => {
  const f = fixture();
  const options = await f.controls.modelOptions(target);
  assert.equal(options.catalog_available, false); assert.equal(options.selection_mode, "explicit_model_id");
  assert.equal(options.current.model, "old-model"); assert.equal("models" in options, false);
  f.update(input => { f.state.latestModel = input.settings.model; f.state.latestReasoningEffort = input.settings.effort;
    f.state.latestCollaborationMode!.settings.model = input.settings.model!;
    f.state.latestCollaborationMode!.settings.reasoning_effort = input.settings.effort!; });
  const result = await f.controls.setModel(target, { model: "user-requested-model", reasoningEffort: "low" });
  assert.equal(result.applied, true); assert.deepEqual(f.updates[0].settings, { model: "user-requested-model", effort: "low" });
  assert.equal(f.state.latestCollaborationMode?.settings.developer_instructions, "custom instructions");
  assert.equal(f.state.currentPermissions?.activePermissionProfile?.id, ":read-only");
  await assert.rejects(f.controls.setModel(target, { model: "bad\nmodel", reasoningEffort: "low" }), /explicit model/);
});

test("Desktop Plan/default switch is explicit and verified in the original thread", async () => {
  const f = fixture();
  f.update(input => { f.state.latestModel = input.settings.model; f.state.latestReasoningEffort = input.settings.effort;
    f.state.latestCollaborationMode = input.settings.collaborationMode; });
  const result = await f.controls.setModel(target, { model: "old-model", reasoningEffort: "high", collaborationMode: "plan" });
  assert.equal(result.applied, true); assert.equal(("effective" in result ? result.effective.collaboration_mode : null), "plan");
  assert.equal(f.updates[0].settings.collaborationMode?.settings.developer_instructions, null);
  assert.equal(f.state.latestTurnId, "old-turn");
});

test("Desktop controls refuse busy settings changes and late cancellation cannot hit the next task", async () => {
  const f = fixture();
  f.state = { ...f.state, canSend: false, runtimeStatus: "active", latestTurnId: "new-turn",
    turns: [...f.state.turns, { turnId: "new-turn", status: "inProgress", itemsComplete: true, items: [] }] };
  await assert.rejects(f.controls.setPermissions(target, "default"), /idle/);
  assert.equal((await f.controls.interrupt(target, "old-turn")).outcome, "already_settled");
  assert.deepEqual(f.interrupts, []);
  await assert.rejects(f.controls.interrupt(target, "wrong-turn"), /no longer/);
  f.interrupt(input => { f.state.turns.find(t => t.turnId === input.expectedTurnId)!.status = "interrupted"; });
  const result = await f.controls.interrupt(target, "new-turn");
  assert.equal(result.interrupted, true); assert.equal(result.state, "interrupted");
  assert.deepEqual(f.interrupts, ["new-turn"]);
});


test("Desktop model confirmation uses the effective collaboration tuple, not an updated top-level cache", async () => {
  const f = fixture();
  f.update(input => { f.state.latestModel = input.settings.model; f.state.latestReasoningEffort = input.settings.effort; });
  const result = await f.controls.setModel(target, { model: "user-requested-model", reasoningEffort: "low" });
  assert.equal(result.applied, false); assert.equal(result.outcome, "unconfirmed");
  assert.equal((await f.controls.modelOptions(target)).current.model, "old-model");
  assert.equal(f.updates.length, 1);
});


test("Desktop idle permission readback uses next-turn settings while active tasks retain actual permissions", async () => {
  const f = fixture(); const old = structuredClone(f.state.currentPermissions);
  f.update(() => { f.state.threadSettings = { collaborationMode: f.state.latestCollaborationMode, model: "private-model", activePermissionProfile: { id: ":danger-full-access", extends: null },
    approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } }; });
  const result = await f.controls.setPermissions(target, "full-access");
  assert.equal(result.applied, true); assert.deepEqual(f.state.currentPermissions, old);
  assert.equal((await f.controls.permissionOptions(target)).current, "full-access");
  assert.equal((await f.controls.permissionOptions(target)).applies_to, "next_task");
  assert.equal("collaborationMode" in (await f.controls.permissionOptions(target)).settings!, false);
  f.state.runtimeStatus = "active"; f.state.canSend = false;
  assert.equal((await f.controls.permissionOptions(target)).current, "read-only");
  assert.equal((await f.controls.permissionOptions(target)).applies_to, "active_task");
});
