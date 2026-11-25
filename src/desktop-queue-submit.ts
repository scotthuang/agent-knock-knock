import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cliNow, cliNowMs, cliPid, cliSleepSync } from "./cli-runtime-context.js";
import { CodexNativeRpc } from "./codex-native-client-rpc.js";
import { answeredNativeQuestionIds, nativeId, nativePage, nativeRecord, parseNativeThread, parseNativeTurn } from "./codex-native-snapshot.js";
import { CodexNativeError } from "./codex-native-types.js";
import { desktopQueueSocketIdentity } from "./desktop-native-queue.js";
import { verifyDesktopQueueOwner, type DesktopQueueOwner } from "./desktop-queue-owner.js";
import { createDesktopStateStore, type DesktopTaskRecord } from "./desktop-state-store.js";
import type { DesktopQueueAdmission } from "./desktop-task-queue.js";
import { DesktopIpcError, type DesktopThreadIdentity } from "./desktop-types.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";

export type { DesktopQueueAdmission } from "./desktop-task-queue.js";
interface Send {
  target: DesktopThreadIdentity; admission: DesktopQueueAdmission; storeDir: string;
  watchId: string; clientUserMessageId: string; prompt: string;
}
const admissions = new WeakMap<DesktopQueueAdmission, {
  target: DesktopThreadIdentity; socket: string; draft: DesktopQueueOwner["draft"]; expires: number;
}>();
const admissionLifetimeMs = 30_000;
// One short-lived read witness. A timeout may hide queue depth even where the native
// method has already been observed. This witness is never a grant to the append operation.
let lastQueueRead: { ownerId: string; endpointId: string; socket: string; expires: number } | undefined;
const admissionReasons = {
  desktop_queue_saved_draft: "A saved draft is present. Keep it intact; its ordering and preservation on independent append are unverified.",
  desktop_queue_retained_editor: "A retained editor document is present. Its isolation from a queued submission is unverified.",
  desktop_queue_question_pending: "An unresolved question is present on the active turn. Queue isolation for this interaction is unverified.",
  desktop_queue_baseline_unavailable: "No exact pre-send turn boundary is available for tracking this submission.",
  desktop_queue_contract_unavailable: "Cannot establish the native thread queue contract on this endpoint.",
  desktop_queue_write_denied: "The native thread explicitly disallows direct input.",
  desktop_queue_full: "The native queue is full. The request was not enqueued."
};

/** Fixed public diagnostics after locating a writer; no native content or write authority. */
export class DesktopQueueAdmissionError extends DesktopIpcError {
  constructor(readonly reason: keyof typeof admissionReasons) {
    super(reason, admissionReasons[reason]);
  }
}
function changed(): never { throw new DesktopIpcError("owner_changed", "Desktop queue owner, socket or exact task scope changed"); }
function socketPath(target: DesktopThreadIdentity) { return path.join(target.codexHome, "app-server-control", "app-server-control.sock"); }

async function ownerGate(target: DesktopThreadIdentity) {
  const owner = await verifyDesktopQueueOwner(target).catch(() => { throw new DesktopIpcError("no_live_owner", "Cannot verify Desktop queue owner"); });
  if (owner.draft === "present") throw new DesktopQueueAdmissionError("desktop_queue_saved_draft");
  if (owner.draft === "retained_editor") throw new DesktopQueueAdmissionError("desktop_queue_retained_editor");
  return owner;
}

function verifySharedThread(rawThread: unknown, id: string, cwd: string): void {
  const thread = parseNativeThread(rawThread, id);
  if (thread.cwd !== cwd || thread.sessionId !== id || thread.originator !== "codex_work_desktop" || thread.source !== "vscode" ||
      thread.historyMode !== "paginated" || thread.threadSource !== "user" || thread.parentThreadId != null ||
      thread.attachedToThreadId != null || thread.ephemeral !== false || thread.status.type !== "notLoaded") changed();
  if (thread.canAcceptDirectInput === false) throw new DesktopQueueAdmissionError("desktop_queue_write_denied");
}

function queueBaseline(rawTurn: Record<string, unknown>, notices: string[]): string {
  // Older turns and sub-agent activity are not renderer interactions or write permissions.
  // Only the exact turn boundary is needed to find our own subsequent client message.
  const turnId = nativeId(rawTurn.id);
  if (rawTurn.status === "inProgress") {
    notices.push("desktop_queue_parent_running");
    if (Array.isArray(rawTurn.items) && rawTurn.items.some(item => item?.type === "agentMessage" &&
        item.delivery === "async" && Array.isArray(item.questions) && item.questions.length > 0)) {
      const turn = parseNativeTurn(rawTurn);
      // Display directives govern publication of text. They do not settle a question.
      const answered = answeredNativeQuestionIds(turn);
      const pending = turn.items.some(item => item.type === "agentMessage" && item.delivery === "async" &&
        item.questions?.some((_question, index, questions) =>
          !(questions.length === 1 && answered.has(item.id)) &&
          !answered.has(JSON.stringify(["request_user_input_async", item.id, index]))));
      if (!turn.itemsComplete || pending) throw new DesktopQueueAdmissionError("desktop_queue_question_pending");
    }
  }
  return turnId;
}

async function inspectQueue(rpc: CodexNativeRpc, threadId: string, previouslyVerified: boolean, notices: string[]) {
  try {
    const page = nativePage(await rpc.call("thread/queue/list", {threadId, limit: 1}), raw => {
      const entry = nativeRecord(raw);
      nativeId(entry.id);
      nativeId(entry.clientUserMessageId);
      if (!Array.isArray(entry.input)) throw new DesktopQueueAdmissionError("desktop_queue_contract_unavailable");
    });
    if (page.data.length > 1 || (page.data.length === 0 && page.nextCursor !== null)) {
      throw new DesktopQueueAdmissionError("desktop_queue_contract_unavailable");
    }
    if (page.data.length) notices.push("desktop_queue_appends_behind_existing");
  } catch (error) {
    // A transient read failure does not revoke a contract already probed on this exact live endpoint.
    if (previouslyVerified && error instanceof CodexNativeError && (error.code === "timeout" || error.rpcCode === -32603)) {
      notices.push("desktop_queue_depth_unknown");
      return;
    }
    throw new DesktopQueueAdmissionError("desktop_queue_contract_unavailable");
  }
}

async function nativeGate(rpc: CodexNativeRpc, target: DesktopThreadIdentity, cwd: string, previouslyVerified = false) {
  const id = target.threadId;
  const { thread: rawThread } = nativeRecord(await rpc.call("thread/read", { threadId: id, includeTurns: false }));
  verifySharedThread(rawThread, id, cwd);
  const page = nativePage(await rpc.call("thread/turns/list", {threadId: id, limit: 1, sortDirection: "desc", itemsView: "full"}), nativeRecord);
  if (page.data.length !== 1) throw new DesktopQueueAdmissionError("desktop_queue_baseline_unavailable");
  const notices = ["desktop_queue_live_input_unobserved"];
  const baselineTurnId = queueBaseline(page.data[0], notices);
  await inspectQueue(rpc, id, previouslyVerified, notices);
  return { baselineTurnId, notices };
}

/** Issues a short-lived, process-local admission. A serialized or reconstructed result conveys no write authority. */
export async function prepareDesktopQueue(target: DesktopThreadIdentity, expectedCwd: string): Promise<DesktopQueueAdmission> {
  if (!path.isAbsolute(expectedCwd)) throw new DesktopIpcError("invalid_argument", "Desktop queue requires an exact catalog cwd");
  const first = await ownerGate(target), socket = desktopQueueSocketIdentity(socketPath(target));
  const rpc = await CodexNativeRpc.connect({codexHome: target.codexHome, timeoutMs: 5_000});
  try {
    const cached = lastQueueRead;
    const priorRead = cached?.ownerId === first.ownerId && cached.endpointId === first.endpointId &&
      cached.socket === socket && cached.expires > performance.now();
    const { baselineTurnId, notices } = await nativeGate(rpc, target, expectedCwd, priorRead).catch(error => {
      if (cached === lastQueueRead && error instanceof DesktopQueueAdmissionError && error.reason === "desktop_queue_contract_unavailable") {
        lastQueueRead = undefined;
      }
      throw error;
    });
    const last = await ownerGate(target);
    if (first.ownerId !== last.ownerId || first.endpointId !== last.endpointId || socket !== desktopQueueSocketIdentity(socketPath(target))) changed();
    if (first.draft !== last.draft) changed();
    if (last.draft === "unknown") notices.push("desktop_queue_draft_unknown");
    const admission = Object.freeze({ ownerId: first.ownerId, endpointId: first.endpointId, cwd: expectedCwd,
      baselineTurnId, notices: Object.freeze(notices) });
    let expires = performance.now() + admissionLifetimeMs;
    if (cached && notices.includes("desktop_queue_depth_unknown")) {
      expires = cached.expires;
      if (expires <= performance.now()) throw new DesktopQueueAdmissionError("desktop_queue_contract_unavailable");
    } else {
      lastQueueRead = { ownerId: last.ownerId, endpointId: last.endpointId, socket, expires };
    }
    admissions.set(admission, { target: { ...target }, socket, draft: last.draft, expires });
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
  if (owner.ownerId !== send.admission.ownerId || owner.endpointId !== send.admission.endpointId || owner.draft !== grant.draft ||
      grant.expires <= performance.now() || grant.socket !== desktopQueueSocketIdentity(socketPath(send.target))) changed();
  const rpc = await CodexNativeRpc.connect({codexHome: send.target.codexHome, timeoutMs: 5_000});
  try {
    if ((await nativeGate(rpc, send.target, send.admission.cwd, true)).baselineTurnId !== send.admission.baselineTurnId) changed();
    const fresh = await ownerGate(send.target);
    if (fresh.ownerId !== owner.ownerId || fresh.endpointId !== owner.endpointId || fresh.draft !== owner.draft) changed();
    let raw: unknown;
    try { raw = await dispatch(rpc, send, grant.socket, grant.expires); }
    catch (error) {
      if (error instanceof CodexNativeError) {
        if (error.code === "queue_full") throw new DesktopQueueAdmissionError("desktop_queue_full");
        if (error.code === "queue_write_denied") throw new DesktopQueueAdmissionError("desktop_queue_write_denied");
        if (error.code === "unsupported_capability") throw new DesktopQueueAdmissionError("desktop_queue_contract_unavailable");
        throw new DesktopIpcError("rpc_error", "Desktop queue did not acknowledge the submission", error.dispatchState);
      }
      throw error;
    }
    return parseReceipt(raw, send);
  } finally { rpc.close(); }
}
