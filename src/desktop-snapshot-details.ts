import { DesktopIpcError, type DesktopCurrentPermissions, type DesktopCollaborationMode,
  type DesktopThreadSettings, type DesktopTurnItem, type DesktopFileChange, type DesktopSnapshot } from "./desktop-types.js";
import { desktopObject, desktopNativeRequestId } from "./desktop-request-interactions.js";

function invalid(): never { throw new DesktopIpcError("invalid_response", "Invalid Desktop native detail"); }
function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") invalid(); return value;
}
function object(value: unknown): Record<string, unknown> { if (!desktopObject(value)) invalid(); return value; }

export function desktopCollaborationMode(value: unknown): DesktopCollaborationMode {
  const mode = object(value), settings = object(mode.settings);
  if (typeof mode.mode !== "string" || typeof settings.model !== "string") invalid();
  return { mode: mode.mode, settings: { model: settings.model,
    reasoning_effort: optionalString(settings.reasoning_effort) ?? null,
    developer_instructions: optionalString(settings.developer_instructions) ?? null } };
}

function permissions(value: unknown): DesktopCurrentPermissions {
  const raw = object(value), result: DesktopCurrentPermissions = {};
  if (raw.activePermissionProfile != null) {
    const profile = object(raw.activePermissionProfile);
    if (typeof profile.id !== "string") invalid();
    result.activePermissionProfile = { id: profile.id, extends: optionalString(profile.extends) ?? null };
  } else if (raw.activePermissionProfile === null) result.activePermissionProfile = null;
  if (raw.approvalPolicy != null) result.approvalPolicy = typeof raw.approvalPolicy === "string" ? raw.approvalPolicy : structuredClone(object(raw.approvalPolicy));
  if (raw.approvalsReviewer != null) result.approvalsReviewer = optionalString(raw.approvalsReviewer);
  if (raw.sandboxPolicy != null) result.sandboxPolicy = structuredClone(object(raw.sandboxPolicy));
  if (raw.runtimeWorkspaceRoots != null) {
    if (!Array.isArray(raw.runtimeWorkspaceRoots) || raw.runtimeWorkspaceRoots.some(root => typeof root !== "string")) invalid();
    result.runtimeWorkspaceRoots = [...raw.runtimeWorkspaceRoots] as string[];
  }
  return result;
}

function threadSettings(value: unknown): DesktopThreadSettings {
  const raw = object(value), result: DesktopThreadSettings = permissions(raw);
  for (const field of ["model", "permissions"] as const) if (raw[field] != null) result[field] = optionalString(raw[field]);
  if (raw.effort !== undefined) result.effort = optionalString(raw.effort) ?? null;
  if (raw.collaborationMode != null) result.collaborationMode = desktopCollaborationMode(raw.collaborationMode);
  return result;
}

export function desktopSettingsSnapshot(raw: Record<string, unknown>): Pick<DesktopSnapshot,
  "threadSettings" | "currentPermissions" | "latestModel" | "latestReasoningEffort" | "latestCollaborationMode"> {
  return {
    ...(raw.latestThreadSettings == null ? {} : { threadSettings: threadSettings(raw.latestThreadSettings) }),
    ...(raw.currentPermissions == null ? {} : { currentPermissions: permissions(raw.currentPermissions) }),
    ...(raw.latestModel == null ? {} : { latestModel: optionalString(raw.latestModel) }),
    ...(raw.latestReasoningEffort === undefined ? {} : { latestReasoningEffort: optionalString(raw.latestReasoningEffort) ?? null }),
    ...(raw.latestCollaborationMode == null ? {} : { latestCollaborationMode: desktopCollaborationMode(raw.latestCollaborationMode) })
  };
}

function fileChanges(value: unknown): DesktopFileChange[] {
  if (!Array.isArray(value)) invalid();
  return value.map(raw => {
    const change = object(raw);
    if (typeof change.path !== "string") invalid();
    const kind = typeof change.kind === "string" ? change.kind : change.kind == null ? undefined : optionalString(object(change.kind).type);
    const diff = optionalString(change.diff);
    return { path: change.path, ...(kind ? { kind } : {}), ...(diff === undefined ? {} : {
      diff: diff.slice(0, 16_384), ...(diff.length > 16_384 ? { diffTruncated: true } : {}) }) };
  });
}

function inputResponse(value: Record<string, unknown>, result: DesktopTurnItem): void {
  if (value.requestId !== undefined) result.requestId = desktopNativeRequestId(value.requestId);
  if (value.turnId !== undefined) result.turnId = optionalString(value.turnId);
  if (value.completed !== undefined) {
    if (typeof value.completed !== "boolean") invalid(); result.completed = value.completed;
  }
  if (value.answers !== undefined) {
    const answers = object(value.answers), projected: Record<string, string[]> = Object.create(null);
    for (const [id, answer] of Object.entries(answers)) {
      if (!Array.isArray(answer) || answer.some(value => typeof value !== "string")) invalid();
      projected[id] = [...answer] as string[];
    }
    result.answers = projected;
  }
}

export function projectDesktopItemDetails(raw: Record<string, unknown>, result: DesktopTurnItem): void {
  if (result.type === "userInputResponse") inputResponse(raw, result);
  if (result.type === "fileChange" && raw.changes != null) result.changes = fileChanges(raw.changes);
  if (result.type !== "commandExecution") return;
  for (const field of ["command", "cwd"] as const) if (raw[field] != null) result[field] = optionalString(raw[field]);
  if (raw.aggregatedOutput !== undefined) result.aggregatedOutput = optionalString(raw.aggregatedOutput) ?? null;
  if (raw.exitCode !== undefined) {
    if (raw.exitCode !== null && (typeof raw.exitCode !== "number" || !Number.isSafeInteger(raw.exitCode))) invalid();
    result.exitCode = raw.exitCode as number | null;
  }
}
