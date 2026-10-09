import { desktopInteractions, desktopObject, desktopRequestResponse } from "./desktop-request-interactions.js";
import { desktopCollaborationMode } from "./desktop-snapshot-details.js";
import { DesktopIpcError, type DesktopObserveTarget, type DesktopOwner, type DesktopSnapshot,
  type DesktopRequestOptions, type DesktopRequestReceipt, type DesktopRequestInteraction, type DesktopModelSettings,
  type DesktopSettingsOptions, type DesktopSettingsReceipt, type DesktopSettingsUpdate,
  type DesktopInterruptOptions, type DesktopInterruptReceipt } from "./desktop-types.js";

export interface DesktopNativeOperationPort {
  discoverOwner(threadId: string, ownerId: string): Promise<DesktopOwner>;
  observeThread(target: DesktopObserveTarget): Promise<DesktopSnapshot>;
  request(method: string, version: number, params: Record<string, unknown>, ownerId: string): Promise<Record<string, unknown>>;
  markDispatched(): void;
}

async function observeOwner(target: DesktopObserveTarget, port: DesktopNativeOperationPort): Promise<DesktopSnapshot> {
  await port.discoverOwner(target.threadId, target.ownerClientId);
  return port.observeThread(target);
}
function assertActive(snapshot: DesktopSnapshot, target: DesktopObserveTarget, turnId: string): void {
  const active = snapshot.turns.filter(turn => turn.status === "inProgress");
  if (snapshot.threadId !== target.threadId || snapshot.ownerClientId !== target.ownerClientId || !snapshot.tailKnown
    || snapshot.runtimeStatus !== "active" || active.length !== 1 || active[0].turnId !== turnId || snapshot.latestTurnId !== turnId) {
    throw new DesktopIpcError("stale_interaction", "Desktop operation no longer targets its exact active task");
  }
}
function requestInteraction(snapshot: DesktopSnapshot, options: DesktopRequestOptions): DesktopRequestInteraction {
  assertActive(snapshot, options, options.expectedTurnId);
  if (!Number.isSafeInteger(options.expectedRevision) || snapshot.revision < options.expectedRevision) {
    throw new DesktopIpcError("snapshot_changed", "Desktop request revision regressed");
  }
  const matches = desktopInteractions(snapshot, options.expectedTurnId).filter((value): value is DesktopRequestInteraction =>
    value.kind !== "async_question" && value.id === options.interactionId);
  if (matches.length !== 1) throw new DesktopIpcError("stale_interaction", "Desktop native request is changed or no longer pending");
  return matches[0];
}
function unknown(error: unknown): never {
  if (error instanceof DesktopIpcError && error.dispatchState !== "not_sent") throw error;
  throw new DesktopIpcError(error instanceof DesktopIpcError ? error.code : "closed",
    error instanceof Error ? error.message : "Desktop native operation outcome is unknown", "unknown");
}
const methods = { command_approval: "thread-follower-command-approval-decision", file_approval: "thread-follower-file-approval-decision",
  blocking_question: "thread-follower-submit-user-input" } as const;

export async function respondDesktopRequest(options: DesktopRequestOptions, port: DesktopNativeOperationPort): Promise<DesktopRequestReceipt> {
  const baseline = await observeOwner(options, port);
  const interaction = requestInteraction(baseline, options);
  const response = desktopRequestResponse(interaction, options.response);
  await options.beforeDispatch?.(structuredClone(baseline));
  const current = await port.observeThread(options);
  const fresh = requestInteraction(current, options);
  if (fresh.requestId !== interaction.requestId) throw new DesktopIpcError("stale_interaction", "Desktop request identity changed");
  const params = { conversationId: options.threadId, requestId: interaction.requestId,
    ...(interaction.kind === "blocking_question" ? { response } : response) };
  port.markDispatched();
  try {
    const receipt = await port.request(methods[interaction.kind], 1, params, options.ownerClientId);
    if (!desktopObject(receipt.result) || receipt.result.ok !== true) throw new DesktopIpcError("invalid_response", "Desktop request handler did not acknowledge the response", "unknown");
    return { turnId: interaction.turnId, interactionId: interaction.id, requestId: interaction.requestId,
      revision: current.revision, acknowledged: true };
  } catch (error) { return unknown(error); }
}

export async function readDesktopModelSettings(target: DesktopObserveTarget, port: DesktopNativeOperationPort): Promise<DesktopModelSettings> {
  await port.discoverOwner(target.threadId, target.ownerClientId);
  const result = await port.request("thread-follower-read-model-settings", 1, { conversationId: target.threadId }, target.ownerClientId);
  const settings = desktopObject(result.result) ? result.result.settings : undefined;
  if (!desktopObject(settings) || !(settings.model === null || typeof settings.model === "string")
    || !(settings.reasoningEffort === null || typeof settings.reasoningEffort === "string")) {
    throw new DesktopIpcError("invalid_response", "Desktop current model settings are unavailable");
  }
  const output: DesktopModelSettings = { model: settings.model, reasoningEffort: settings.reasoningEffort };
  if (typeof settings.resumeState === "string") output.resumeState = settings.resumeState;
  for (const key of ["mode", "modelProvider"] as const) if (settings[key] === null || typeof settings[key] === "string") output[key] = settings[key];
  return output;
}

function validateSettings(settings: DesktopSettingsUpdate): void {
  const fields = ["model", "effort", "collaborationMode", "permissions", "approvalPolicy", "approvalsReviewer"];
  if (!desktopObject(settings) || !Object.keys(settings).length || Object.keys(settings).some(key => !fields.includes(key))) {
    throw new DesktopIpcError("invalid_argument", "Unsupported Desktop settings update");
  }
  for (const key of ["model", "permissions", "approvalPolicy", "approvalsReviewer"] as const) {
    if (settings[key] !== undefined && (typeof settings[key] !== "string" || !settings[key])) throw new DesktopIpcError("invalid_argument", "Invalid Desktop setting");
  }
  if (settings.effort !== undefined && settings.effort !== null && typeof settings.effort !== "string") throw new DesktopIpcError("invalid_argument", "Invalid Desktop effort");
  if (settings.collaborationMode !== undefined) desktopCollaborationMode(settings.collaborationMode);
}
function assertIdle(snapshot: DesktopSnapshot): void {
  if (!snapshot.canSend || snapshot.runtimeStatus !== "idle") throw new DesktopIpcError("thread_not_idle", "Desktop settings updates require the existing thread to be idle");
}

export async function updateDesktopSettings(options: DesktopSettingsOptions, port: DesktopNativeOperationPort): Promise<DesktopSettingsReceipt> {
  validateSettings(options.settings);
  const baseline = await observeOwner(options, port); assertIdle(baseline);
  await options.beforeDispatch?.(structuredClone(baseline));
  const current = await port.observeThread(options); assertIdle(current);
  port.markDispatched();
  try {
    const receipt = await port.request("thread-follower-update-thread-settings", 2,
      { conversationId: options.threadId, threadSettings: options.settings }, options.ownerClientId);
    if (!desktopObject(receipt.result) || receipt.result.applied !== true) throw new DesktopIpcError("invalid_response", "Desktop settings were not acknowledged", "unknown");
    const modelSettings = await readDesktopModelSettings(options, port);
    return { applied: true, snapshot: await port.observeThread(options), modelSettings };
  } catch (error) { return unknown(error); }
}

export async function interruptDesktopTurn(options: DesktopInterruptOptions, port: DesktopNativeOperationPort): Promise<DesktopInterruptReceipt> {
  const baseline = await observeOwner(options, port); assertActive(baseline, options, options.expectedTurnId);
  await options.beforeDispatch?.(structuredClone(baseline));
  const current = await port.observeThread(options); assertActive(current, options, options.expectedTurnId);
  port.markDispatched();
  try {
    const receipt = await port.request("thread-follower-interrupt-turn", 4,
      { conversationId: options.threadId, mode: "user-stop", expectedTurnId: options.expectedTurnId }, options.ownerClientId);
    if (!desktopObject(receipt.result) || receipt.result.ok !== true || receipt.result.interruptedTurnId !== options.expectedTurnId) {
      throw new DesktopIpcError("invalid_response", "Desktop interrupt did not acknowledge the exact turn", "unknown");
    }
    return { interruptedTurnId: options.expectedTurnId, snapshot: await port.observeThread(options) };
  } catch (error) { return unknown(error); }
}
