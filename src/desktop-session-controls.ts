import { randomUUID } from "node:crypto";
import type { DesktopIpcClient } from "./desktop-ipc-client.js";
import { DesktopIpcError, type DesktopModelSettings, type DesktopObserveTarget,
  type DesktopSnapshot, type DesktopThreadIdentity } from "./desktop-types.js";

export type DesktopPermissionMode = "read-only" | "default" | "full-access";
export interface DesktopModelSelection { model: string; reasoningEffort: string; collaborationMode?: "plan" | "default" }
export interface DesktopSessionControlDependencies {
  observe(identity: DesktopThreadIdentity): Promise<DesktopSnapshot>;
  readModelSettings(identity: DesktopThreadIdentity, target: DesktopObserveTarget): Promise<DesktopModelSettings>;
  updateSettings(identity: DesktopThreadIdentity, options: Parameters<DesktopIpcClient["updateThreadSettingsOnce"]>[0]):
    ReturnType<DesktopIpcClient["updateThreadSettingsOnce"]>;
  interruptTurn(identity: DesktopThreadIdentity, options: Parameters<DesktopIpcClient["interruptTurnOnce"]>[0]):
    ReturnType<DesktopIpcClient["interruptTurnOnce"]>;
  sleep?(ms: number): Promise<void>;
  randomUUID?(): string;
  observationAttempts?: number;
}
const presets = {
  "read-only": { permissions: ":read-only", approvalPolicy: "on-request", sandboxType: "readOnly", label: "Read Only" },
  default: { permissions: ":workspace", approvalPolicy: "on-request", sandboxType: "workspaceWrite", label: "Default" },
  "full-access": { permissions: ":danger-full-access", approvalPolicy: "never", sandboxType: "dangerFullAccess", label: "Full Access" }
} as const;

function sameThread(snapshot: DesktopSnapshot, identity: DesktopThreadIdentity): void {
  if (snapshot.threadId !== identity.threadId || !snapshot.ownerClientId) {
    throw new DesktopIpcError("invalid_response", "Desktop settings observation changed the selected native thread");
  }
}
function idleSnapshot(snapshot: DesktopSnapshot, identity: DesktopThreadIdentity): void {
  sameThread(snapshot, identity);
  if (!snapshot.canSend || snapshot.runtimeStatus !== "idle") {
    throw new DesktopIpcError("thread_not_idle", "Change Desktop settings while this exact conversation is idle");
  }
}
function effectivePermissions(snapshot: DesktopSnapshot) {
  const source = snapshot.runtimeStatus === "idle" ? snapshot.threadSettings ?? snapshot.currentPermissions : snapshot.currentPermissions;
  if (!source) return undefined;
  return { activePermissionProfile: source.activePermissionProfile, approvalPolicy: source.approvalPolicy,
    approvalsReviewer: source.approvalsReviewer, sandboxPolicy: source.sandboxPolicy, runtimeWorkspaceRoots: source.runtimeWorkspaceRoots };
}
function permissionMode(snapshot: DesktopSnapshot): DesktopPermissionMode | null {
  const current = effectivePermissions(snapshot);
  return (Object.keys(presets) as DesktopPermissionMode[]).find(mode => {
    const preset = presets[mode];
    return current?.activePermissionProfile?.id === preset.permissions && current.approvalPolicy === preset.approvalPolicy
      && current.approvalsReviewer === "user" && current.sandboxPolicy?.type === preset.sandboxType;
  }) ?? null;
}
function modelState(snapshot: DesktopSnapshot) {
  return { model: snapshot.latestCollaborationMode?.settings.model ?? snapshot.latestModel ?? null,
    reasoning_effort: snapshot.latestCollaborationMode?.settings.reasoning_effort ?? snapshot.latestReasoningEffort ?? null,
    collaboration_mode: snapshot.latestCollaborationMode?.mode ?? null };
}
function matchesModel(snapshot: DesktopSnapshot, selection: DesktopModelSelection, expectedMode?: string | null): boolean {
  const current = modelState(snapshot);
  return current.model === selection.model && current.reasoning_effort === selection.reasoningEffort
    && (expectedMode == null || current.collaboration_mode === expectedMode);
}
function validateModel(selection: DesktopModelSelection): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,159}$/u.test(selection.model)
    || !/^[a-z][a-z0-9_-]{0,63}$/u.test(selection.reasoningEffort)
    || selection.collaborationMode !== undefined && !["plan", "default"].includes(selection.collaborationMode)) {
    throw new DesktopIpcError("invalid_argument", "Desktop model requires an explicit model/effort tuple and optional plan/default mode");
  }
}
function errorCode(error: unknown): string {
  return error instanceof DesktopIpcError ? error.code : "desktop_effective_settings_unconfirmed";
}

/** Settings affect one idle native conversation; effective snapshots, not acknowledgements, prove success. */
export function createDesktopSessionControls(deps: DesktopSessionControlDependencies) {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const uuid = deps.randomUUID ?? randomUUID;
  async function observe(identity: DesktopThreadIdentity) {
    const snapshot = await deps.observe(identity); sameThread(snapshot, identity); return snapshot;
  }
  async function confirm(identity: DesktopThreadIdentity, owner: string, matches: (snapshot: DesktopSnapshot) => boolean) {
    for (let attempt = 0; attempt < (deps.observationAttempts ?? 20); attempt++) {
      const snapshot = await observe(identity);
      if (snapshot.ownerClientId !== owner) throw new DesktopIpcError("owner_changed", "Desktop owner changed while verifying the requested setting", "unknown");
      if (matches(snapshot)) return snapshot;
      await sleep(250);
    }
    throw new DesktopIpcError("timeout", "The requested Desktop state has not been observed; refresh Status before another operation", "unknown");
  }
  async function change(identity: DesktopThreadIdentity, before: DesktopSnapshot,
    settings: Parameters<DesktopIpcClient["updateThreadSettingsOnce"]>[0]["settings"], matches: (snapshot: DesktopSnapshot) => boolean) {
    let dispatchError: unknown;
    try {
      await deps.updateSettings(identity, { threadId: identity.threadId, ownerClientId: before.ownerClientId,
        operationId: uuid(), settings, beforeDispatch: async snapshot => idleSnapshot(snapshot, identity) });
    } catch (error) {
      if (error instanceof DesktopIpcError && error.dispatchState === "not_sent") throw error;
      dispatchError = error;
    }
    try { return { snapshot: await confirm(identity, before.ownerClientId, matches) }; }
    catch (error) { return { error_code: errorCode(dispatchError ?? error) }; }
  }
  async function permissionOptions(identity: DesktopThreadIdentity) {
    const snapshot = await observe(identity);
    return { scope: "current_session", current: permissionMode(snapshot), defaults_changed: false,
      settings: effectivePermissions(snapshot), applies_to: snapshot.runtimeStatus === "idle" ? "next_task" : "active_task", choices: (Object.keys(presets) as DesktopPermissionMode[]).map(mode => ({
        id: mode, mode, label: presets[mode].label, description: mode === "full-access"
          ? "Unrestricted execution without approval prompts in this conversation."
          : mode === "read-only" ? "Read-only access; additional access requires approval."
            : "Write in this conversation's workspace; additional access requires approval."
      })) };
  }
  async function setPermissions(identity: DesktopThreadIdentity, mode: DesktopPermissionMode) {
    if (!Object.hasOwn(presets, mode)) throw new DesktopIpcError("invalid_argument", "Unknown Desktop permission preset");
    const before = await observe(identity); idleSnapshot(before, identity);
    const requested = { mode }; const previous = permissionMode(before);
    const base = { scope: "current_session", defaults_changed: false, requested };
    if (previous === mode) return { ...base, applied: true, do_not_retry: false, outcome: "already_effective", effective: requested };
    const preset = presets[mode];
    const result = await change(identity, before, { permissions: preset.permissions,
      approvalPolicy: preset.approvalPolicy, approvalsReviewer: "user" }, snapshot => permissionMode(snapshot) === mode);
    if (!result.snapshot) return { ...base, applied: false, do_not_retry: true, outcome: "unconfirmed", error_code: result.error_code };
    return { ...base, applied: true, do_not_retry: false, outcome: "changed", effective: requested, applies_to: "next_task", settings: effectivePermissions(result.snapshot) };
  }
  async function modelOptions(identity: DesktopThreadIdentity) {
    const snapshot = await observe(identity);
    const settings = await deps.readModelSettings(identity, { threadId: identity.threadId, ownerClientId: snapshot.ownerClientId });
    return { scope: "current_session", current: modelState(snapshot), model_provider: settings.modelProvider,
      catalog_available: false, selection_mode: "explicit_model_id",
      collaboration_modes: ["default", "plan"],
      limitations: ["Desktop owner exposes current model settings but no model catalog. Use an explicitly requested model ID. AKK verifies effective settings; model availability is not exposed."] };
  }
  async function setModel(identity: DesktopThreadIdentity, selection: DesktopModelSelection) {
    validateModel(selection);
    const before = await observe(identity); idleSnapshot(before, identity);
    const expectedMode = selection.collaborationMode ?? before.latestCollaborationMode?.mode;
    const requested = { model: selection.model, reasoning_effort: selection.reasoningEffort,
      ...(selection.collaborationMode ? { collaboration_mode: selection.collaborationMode } : {}) };
    const base = { scope: "current_session", defaults_changed: false, requested };
    if (matchesModel(before, selection, expectedMode)) return { ...base, applied: true, do_not_retry: false, outcome: "already_effective", effective: modelState(before) };
    const result = await change(identity, before, { model: selection.model, effort: selection.reasoningEffort,
      ...(selection.collaborationMode ? { collaborationMode: { mode: selection.collaborationMode,
        settings: { model: selection.model, reasoning_effort: selection.reasoningEffort, developer_instructions: null } } } : {})
    }, snapshot => matchesModel(snapshot, selection, expectedMode));
    if (!result.snapshot) return { ...base, applied: false, do_not_retry: true, outcome: "unconfirmed", error_code: result.error_code };
    return { ...base, applied: true, do_not_retry: false, outcome: "changed", effective: modelState(result.snapshot) };
  }
  async function interrupt(identity: DesktopThreadIdentity, expectedTurnId: string) {
    if (!expectedTurnId?.trim()) throw new DesktopIpcError("invalid_argument", "Desktop cancellation requires its exact native turn");
    const before = await observe(identity);
    const exact = before.turns.find(turn => turn.turnId === expectedTurnId);
    if (exact && ["completed", "failed", "interrupted"].includes(exact.status)) {
      return { native_turn_id: expectedTurnId, interrupted: exact.status === "interrupted", state: exact.status, outcome: "already_settled", do_not_retry: false };
    }
    if (!exact || exact.status !== "inProgress" || before.latestTurnId !== expectedTurnId) {
      throw new DesktopIpcError("stale_interaction", "The selected Desktop task is no longer the active task");
    }
    let dispatchError: unknown;
    try { await deps.interruptTurn(identity, { threadId: identity.threadId, ownerClientId: before.ownerClientId, expectedTurnId, operationId: uuid() }); }
    catch (error) {
      if (error instanceof DesktopIpcError && error.dispatchState === "not_sent") throw error;
      dispatchError = error;
    }
    try {
      const snapshot = await confirm(identity, before.ownerClientId, state => state.turns.some(turn => turn.turnId === expectedTurnId && ["completed", "failed", "interrupted"].includes(turn.status)));
      const status = snapshot.turns.find(turn => turn.turnId === expectedTurnId)!.status;
      return { native_turn_id: expectedTurnId, interrupted: status === "interrupted", state: status, outcome: "settled", do_not_retry: false };
    } catch (error) { return { native_turn_id: expectedTurnId, interrupted: false, state: "unconfirmed", outcome: "unconfirmed", do_not_retry: true, error_code: errorCode(dispatchError ?? error) }; }
  }
  return { permissionOptions, setPermissions, modelOptions, setModel, interrupt };
}
