import { buildDesktopAsyncReply, desktopAsyncQuestions } from "./desktop-async-interactions.js";
import { desktopRecord } from "./desktop-snapshot.js";
import { DesktopIpcError, type DesktopAsyncAnswerOptions, type DesktopAsyncAnswerReceipt,
  type DesktopAsyncInteraction, type DesktopObserveTarget, type DesktopOwner, type DesktopSnapshot } from "./desktop-types.js";

export interface DesktopAsyncAnswerPort {
  discoverOwner(threadId: string, ownerId: string): Promise<DesktopOwner>;
  observeThread(target: DesktopObserveTarget): Promise<DesktopSnapshot>;
  request(params: Record<string, unknown>, ownerId: string): Promise<Record<string, unknown>>;
  markDispatched(): void;
}

function validateOptions(options: DesktopAsyncAnswerOptions): void {
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0
    || typeof options.expectedTurnId !== "string" || !options.expectedTurnId
    || typeof options.interactionId !== "string" || !options.interactionId
    || typeof options.answer !== "string" || !options.answer.trim() || options.answer.length > 16_384) {
    throw new DesktopIpcError("invalid_argument", "Invalid Desktop asynchronous response");
  }
}

function activeQuestion(snapshot: DesktopSnapshot, options: DesktopAsyncAnswerOptions): DesktopAsyncInteraction {
  const active = snapshot.turns.filter(turn => turn.status === "inProgress");
  if (snapshot.threadId !== options.threadId || snapshot.ownerClientId !== options.ownerClientId
    || snapshot.revision < options.expectedRevision || !snapshot.tailKnown || snapshot.mode !== "default"
    || snapshot.resumeState !== "resumed" || snapshot.runtimeStatus !== "active"
    || snapshot.latestTurnId !== options.expectedTurnId || active.length !== 1 || active[0].turnId !== options.expectedTurnId) {
    throw new DesktopIpcError("stale_interaction", "Desktop asynchronous question no longer belongs to the exact active task");
  }
  const matches = desktopAsyncQuestions(snapshot, options.expectedTurnId).filter(question => question.id === options.interactionId);
  if (matches.length !== 1) throw new DesktopIpcError("stale_interaction", "Desktop asynchronous question is answered, changed, or unavailable");
  if (snapshot.turns.some(turn => turn.items.some(item => item.clientId === options.clientUserMessageId
    || item.clientUserMessageId === options.clientUserMessageId || item.serverClientUserMessageId === options.clientUserMessageId))) {
    throw new DesktopIpcError("duplicate_submission", "Desktop already contains this answer identity; it will not be replayed");
  }
  return matches[0];
}

function steerParams(options: DesktopAsyncAnswerOptions, snapshot: DesktopSnapshot, text: string): Record<string, unknown> {
  const id = options.clientUserMessageId;
  return { conversationId: options.threadId, input: [{ type: "text", text, text_elements: [] }],
    clientUserMessageId: id, attachments: [], restoreMessage: {
      id, text, createdAt: Date.now(), ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      context: { prompt: text, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [],
        commentAttachments: [], workspaceRoots: snapshot.cwd ? [snapshot.cwd] : [] }
    } };
}

function receiptTurnId(response: Record<string, unknown>): string | undefined {
  const outer = response.result;
  const result = desktopRecord(outer) ? outer.result : undefined;
  return desktopRecord(result) && typeof result.turnId === "string" ? result.turnId : undefined;
}

/** One targeted steer attempt. An RPC acknowledgement is not the final native answer proof. */
export async function sendDesktopAsyncAnswer(options: DesktopAsyncAnswerOptions,
  port: DesktopAsyncAnswerPort): Promise<DesktopAsyncAnswerReceipt> {
  validateOptions(options);
  const owner = await port.discoverOwner(options.threadId, options.ownerClientId);
  if (!owner.supportsUntrustedAppInput) throw new DesktopIpcError("incompatible_desktop", "Desktop owner does not support untrusted app input");
  const baseline = await port.observeThread(options);
  const question = activeQuestion(baseline, options);
  const text = buildDesktopAsyncReply(question, options.answer);
  await options.beforeDispatch?.(structuredClone(baseline));
  // Normal progress changes revisions. Recheck the question and exact task, not byte-identical snapshots.
  const current = await port.observeThread(options);
  activeQuestion(current, options);
  port.markDispatched();
  try {
    const response = await port.request(steerParams(options, current, text), options.ownerClientId);
    const turnId = receiptTurnId(response);
    if (turnId !== options.expectedTurnId) {
      throw new DesktopIpcError("unexpected_existing_turn", "Desktop did not acknowledge the expected asynchronous answer task", "unknown", turnId);
    }
    return { turnId, clientUserMessageId: options.clientUserMessageId, revision: current.revision, atomicTurnPrecondition: false };
  } catch (error) {
    if (error instanceof DesktopIpcError && error.dispatchState !== "not_sent") throw error;
    throw new DesktopIpcError(error instanceof DesktopIpcError ? error.code : "closed",
      error instanceof Error ? error.message : "Desktop asynchronous response outcome is unknown", "unknown");
  }
}
