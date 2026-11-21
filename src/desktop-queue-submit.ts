import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cliNow, cliNowMs, cliPid, cliSleepSync } from "./cli-runtime-context.js";
import { CodexNativeRpc } from "./codex-native-client-rpc.js";
import { nativeId, nativePage, nativeRecord, parseNativeThread, parseNativeTurn } from "./codex-native-snapshot.js";
import { CodexNativeError } from "./codex-native-types.js";
import { desktopQueueSocketIdentity } from "./desktop-native-queue.js";
import { verifyDesktopQueueOwner } from "./desktop-queue-owner.js";
import { createDesktopStateStore, type DesktopTaskRecord } from "./desktop-state-store.js";
import type { DesktopQueueAdmission } from "./desktop-task-queue.js";
import { DesktopIpcError, type DesktopThreadIdentity } from "./desktop-types.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";

export type { DesktopQueueAdmission } from "./desktop-task-queue.js";
interface Send {
  target: DesktopThreadIdentity; admission: DesktopQueueAdmission; storeDir: string;
  watchId: string; clientUserMessageId: string; prompt: string;
}
const admissions = new WeakMap<DesktopQueueAdmission, { target: DesktopThreadIdentity; socket: string; expires: number }>();
const knownItems = new Set(["userMessage", "agentMessage", "reasoning", "plan", "webSearch", "imageView", "contextCompaction",
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "imageGeneration", "collabAgentToolCall"]);
const finishedActions = new Set(["completed", "failed", "declined", "interrupted"]);

function idle(message: string): never { throw new DesktopIpcError("thread_not_idle", message); }
function changed(): never { throw new DesktopIpcError("owner_changed", "Desktop queue owner, socket or exact task scope changed"); }
function socketPath(target: DesktopThreadIdentity) { return path.join(target.codexHome, "app-server-control", "app-server-control.sock"); }

async function ownerGate(target: DesktopThreadIdentity) {
  const owner = await verifyDesktopQueueOwner(target).catch(() => { throw new DesktopIpcError("no_live_owner", "Cannot verify Desktop queue owner"); });
  if (owner.draft !== "none_persisted") idle("Desktop has a retained editor, a saved draft, or unknown draft state");
  return owner;
}

function verifySharedThread(rawThread: unknown, id: string, cwd: string): void {
  const thread = parseNativeThread(rawThread, id);
  if (thread.cwd !== cwd || thread.sessionId !== id || thread.originator !== "codex_work_desktop" || thread.source !== "vscode" ||
      thread.historyMode !== "paginated" || thread.threadSource !== "user" || thread.parentThreadId != null ||
      thread.attachedToThreadId != null || thread.canAcceptDirectInput === false || thread.ephemeral !== false) changed();
  if (thread.status.type !== "notLoaded") idle("Shared daemon is not the eligible non-owner queue endpoint");
}

function completedBaseline(rawTurn: Record<string, unknown>): string {
  const turn = parseNativeTurn(rawTurn);
  if (turn.status !== "completed" || !turn.itemsComplete || !Number.isSafeInteger(rawTurn.completedAt) ||
      Number(rawTurn.completedAt) <= 0 || rawTurn.error != null || !turn.items.some(i => i.type === "userMessage")) idle("Desktop has no durable completed turn");
  for (const item of turn.items) {
    if (!knownItems.has(item.type) || (item.status != null && !finishedActions.has(String(item.status))) ||
        item.delivery === "async" || item.questions?.length) idle("Desktop has an interaction, non-terminal item or unknown native item");
  }
  return turn.id;
}

async function nativeGate(rpc: CodexNativeRpc, target: DesktopThreadIdentity, cwd: string): Promise<string> {
  const id = target.threadId;
  const { thread: rawThread } = nativeRecord(await rpc.call("thread/read", { threadId: id, includeTurns: false }));
  verifySharedThread(rawThread, id, cwd);
  const page = nativePage(await rpc.call("thread/turns/list", {threadId: id, limit: 1, sortDirection: "desc", itemsView: "full"}), nativeRecord);
  if (page.data.length !== 1) idle("No single completed Desktop baseline is available");
  const baseline = completedBaseline(page.data[0]);
  const queued = nativePage(await rpc.call("thread/queue/list", {threadId: id, limit: 1}), nativeRecord);
  if (queued.data.length || queued.nextCursor !== null) idle("Existing native Desktop queue is not empty");
  return baseline;
}

/** Issues a short-lived, process-local admission. A serialized or reconstructed result conveys no write authority. */
export async function prepareDesktopQueue(target: DesktopThreadIdentity, expectedCwd: string): Promise<DesktopQueueAdmission> {
  if (!path.isAbsolute(expectedCwd)) throw new DesktopIpcError("invalid_argument", "Desktop queue requires an exact catalog cwd");
  const first = await ownerGate(target), socket = desktopQueueSocketIdentity(socketPath(target));
  const rpc = await CodexNativeRpc.connect({codexHome: target.codexHome, timeoutMs: 5_000});
  try {
    const baselineTurnId = await nativeGate(rpc, target, expectedCwd);
    const last = await ownerGate(target);
    if (first.ownerId !== last.ownerId || first.endpointId !== last.endpointId || socket !== desktopQueueSocketIdentity(socketPath(target))) changed();
    const admission = Object.freeze({ ownerId: first.ownerId, endpointId: first.endpointId, cwd: expectedCwd, baselineTurnId });
    admissions.set(admission, { target: { ...target }, socket, expires: performance.now() + 30_000 });
    return admission;
  } finally { rpc.close(); }
}

function assertExactReservation(task: DesktopTaskRecord | undefined, send: Send): asserts task is DesktopTaskRecord & {send_intent: NonNullable<DesktopTaskRecord["send_intent"]>} {
  const intent = task?.send_intent;
  if (!task || task.kind !== "send" || !isDeepStrictEqual(task.target, send.target) || intent?.delivery_path !== "native_thread_queue" ||
      intent.queue_cwd !== send.admission.cwd || intent.queue_endpoint_id !== send.admission.endpointId ||
      intent.owner_client_id !== send.admission.ownerId || !isDeepStrictEqual(intent.baseline_turn_ids, [send.admission.baselineTurnId]) ||
      intent.client_user_message_id !== send.clientUserMessageId || intent.text !== send.prompt) {
    throw new DesktopIpcError("invalid_argument", "Desktop queue requires the exact persisted Send reservation");
  }
  if (intent.state !== "reserved" || intent.queue_id || task.native_turn_id) {
    throw new DesktopIpcError("duplicate_submission", "Desktop queue reservation may already have been dispatched", "unknown");
  }
}

/** Persist the unique dispatch claim and issue the single append before releasing the existing task/store lock. */
function dispatch(rpc: CodexNativeRpc, send: Send, socket: string, expires: number): Promise<unknown> {
  const locks = createFileLockCliAdapter({now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync});
  const repo = createDesktopStateStore(send.storeDir, locks);
  let attempted = false;
  try { return repo.withLock(send.watchId, () => {
    const task = repo.load(send.watchId);
    assertExactReservation(task, send);
    if (task.closed_at || task.unwatched_at || task.status !== "awaiting_acceptance" || Date.parse(task.deadline_at) <= Date.now() ||
        performance.now() >= expires || socket !== desktopQueueSocketIdentity(socketPath(send.target))) changed();
    task.send_intent.state = "uncertain";
    task.updated_at = new Date().toISOString();
    repo.save(task, task.revision);
    attempted = true;
    return rpc.call("thread/queue/add", {threadId: send.target.threadId, clientUserMessageId: send.clientUserMessageId,
      input: [{ type: "text", text: send.prompt, text_elements: [] }]}, true);
  }); } catch (error) {
    if (error instanceof DesktopIpcError || error instanceof CodexNativeError) throw error;
    throw new DesktopIpcError("rpc_error", "Could not claim the Desktop queue reservation", attempted ? "unknown" : "not_sent");
  }
}

function parseReceipt(raw: unknown, send: Send) {
  try {
    const receipt = nativeRecord(nativeRecord(raw).queuedSubmission);
    if (receipt.clientUserMessageId !== send.clientUserMessageId || !Array.isArray(receipt.input) || receipt.input.length !== 1) throw new Error();
    const part = nativeRecord(receipt.input[0]);
    if (part.type !== "text" || part.text !== send.prompt || ["text_elements", "textElements"].some(k =>
      k in part && (!Array.isArray(part[k]) || part[k].length))) throw new Error();
    return { queueId: nativeId(receipt.id), clientUserMessageId: send.clientUserMessageId };
  } catch { throw new DesktopIpcError("invalid_response", "Unrecognized queue acknowledgement; never resubmit", "unknown"); }
}

/** Native queue/add does not touch the renderer, start the owner, resume a thread or steer a running turn. */
export async function submitDesktopQueueOnce(input: Send) {
  const send = {...input, target: {...input.target}};
  const grant = admissions.get(send.admission);
  if (!grant || !isDeepStrictEqual(send.target, grant.target) || !path.isAbsolute(send.storeDir) || !send.prompt.trim()) {
    throw new DesktopIpcError("invalid_argument", "No fresh Desktop queue admission for this exact Send");
  }
  admissions.delete(send.admission);
  nativeId(send.clientUserMessageId);
  const owner = await ownerGate(send.target);
  if (owner.ownerId !== send.admission.ownerId || owner.endpointId !== send.admission.endpointId ||
      grant.expires <= performance.now() || grant.socket !== desktopQueueSocketIdentity(socketPath(send.target))) changed();
  const rpc = await CodexNativeRpc.connect({codexHome: send.target.codexHome, timeoutMs: 5_000});
  try {
    if (await nativeGate(rpc, send.target, send.admission.cwd) !== send.admission.baselineTurnId) changed();
    const fresh = await ownerGate(send.target);
    if (fresh.ownerId !== owner.ownerId || fresh.endpointId !== owner.endpointId) changed();
    let raw: unknown;
    try { raw = await dispatch(rpc, send, grant.socket, grant.expires); }
    catch (error) {
      if (error instanceof CodexNativeError) throw new DesktopIpcError("rpc_error", "Desktop queue did not acknowledge the submission", error.dispatchState);
      throw error;
    }
    return parseReceipt(raw, send);
  } finally { rpc.close(); }
}
