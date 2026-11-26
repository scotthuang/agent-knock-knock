import { createHash } from "node:crypto";
import { isDesktopConversationId } from "./desktop-identity.js";
import type { DesktopTaskRecord } from "./desktop-state-store.js";
import type { DesktopThreadIdentity, DesktopTurn } from "./desktop-types.js";

/** The native append request has no queue revision or atomic empty-queue precondition. */
export function assertDesktopQueueCondition(onlyIfEmpty: unknown): void {
  if (onlyIfEmpty === undefined || onlyIfEmpty === false) return;
  if (onlyIfEmpty !== true) throw new Error("desktopQueueOnlyIfEmpty must be a boolean");
  throw new Error("Desktop cannot atomically append only if the queue is empty. No message was submitted. Ask whether ordinary tail append is acceptable.");
}

export interface DesktopQueueAdmission {
  ownerId: string; endpointId: string; cwd: string; baselineTurnId: string | null;
  notices?: readonly string[];
}

/** Only these public observations travel with an advertised queue Send. */
export const desktopQueueNotices: readonly string[] = [
  "desktop_queue_live_input_unobserved", "desktop_queue_draft_unknown", "desktop_queue_parent_running",
  "desktop_queue_appends_behind_existing", "desktop_queue_depth_unknown", "desktop_queue_question_pending"
];
export interface DesktopQueueWitness {
  clientUserMessageId: string; prompt: string; baselineTurnId: string | null; expectedCwd: string; expectedEndpointId: string;
  acknowledgedQueueId?: string;
  /** A previously verified turn on this exact task; a queue receipt alone cannot set it. */
  boundTurnId?: string;
  /** Only an explicit read-only recovery gets the larger history budget. */
  historyScan?: "recover";
}
export type DesktopQueueObservation = { state: "matched"; turn: DesktopTurn } |
  { state: "pending" | "uncertain"; reason: string };
export interface DesktopTaskQueuePort {
  prepare(target: DesktopThreadIdentity): Promise<DesktopQueueAdmission>;
  submit(target: DesktopThreadIdentity, admission: DesktopQueueAdmission,
    input: { watchId: string; clientUserMessageId: string; prompt: string }): Promise<{ queueId: string; clientUserMessageId: string }>;
  observe(target: DesktopThreadIdentity, witness: DesktopQueueWitness): Promise<DesktopQueueObservation>;
}

/** Explicit keys are correlation, never authority. Tool invocation IDs and text cannot identify a user instruction. */
export function desktopRequestKeyDigest(requestId: unknown): string | undefined {
  if (requestId === undefined) return undefined;
  if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(requestId)) {
    throw new Error("desktopRequestId must be an opaque, preallocated 8–128 character request key");
  }
  return createHash("sha256").update(requestId).digest("hex");
}

export function assertDesktopRequestOptions(target: unknown, opts: Record<string, unknown>): void {
  if (opts.desktopRequestId === undefined) return;
  if (!isDesktopConversationId(target)) throw new Error("Desktop request keys require an exact Desktop conversation");
  desktopRequestKeyDigest(opts.desktopRequestId);
}

/** A queued item ID cannot anchor a turn. Retain the original client ID, text and pre-send boundary on every read. */
export function desktopQueueWitness(task: DesktopTaskRecord, historyScan?: "recover"): DesktopQueueWitness {
  const intent = task.send_intent;
  if (intent?.delivery_path !== "native_thread_queue" || !intent.queue_cwd || !intent.queue_endpoint_id || intent.baseline_turn_ids.length > 1) {
    throw new Error("Desktop task does not have an exact native queue witness");
  }
  return { clientUserMessageId: intent.client_user_message_id, prompt: intent.text,
    ...(historyScan ? { historyScan } : {}),
    ...(intent.state === "accepted" && task.native_turn_id ? {boundTurnId: task.native_turn_id} : {}),
    ...(intent.queue_id ? { acknowledgedQueueId: intent.queue_id } : {}),
    baselineTurnId: intent.baseline_turn_ids[0] ?? null, expectedCwd: intent.queue_cwd, expectedEndpointId: intent.queue_endpoint_id };
}

/** The user may change a thread's frontend, but a different shared daemon cannot attest a previous task. */
export function createDesktopQueueObserver(
  verifyEndpoint: (codexHome: string) => Promise<string>, read: DesktopTaskQueuePort["observe"]
): DesktopTaskQueuePort["observe"] {
  return async (target, witness) => {
    const endpoint = () => verifyEndpoint(target.codexHome).catch(() => null);
    const match = async (): Promise<DesktopQueueObservation | undefined> => {
      const actual = await endpoint();
      if (!actual || !witness.expectedEndpointId) return { state: "uncertain", reason: "desktop_queue_endpoint_unverified" };
      if (actual !== witness.expectedEndpointId) return { state: "uncertain", reason: "desktop_queue_endpoint_changed" };
      return undefined;
    };
    const before = await match();
    if (before) return before;
    const observation = await read(target, witness);
    return await match() ?? observation;
  };
}
