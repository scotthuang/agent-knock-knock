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
  "desktop_queue_appends_behind_existing", "desktop_queue_depth_unknown"
];
export interface DesktopQueueWitness {
  clientUserMessageId: string; prompt: string; baselineTurnId: string | null; expectedCwd: string; expectedEndpointId: string;
  acknowledgedQueueId?: string;
}
export type DesktopQueueObservation = { state: "matched"; turn: DesktopTurn } |
  { state: "pending" | "uncertain"; reason: string };
export interface DesktopTaskQueuePort {
  prepare(target: DesktopThreadIdentity): Promise<DesktopQueueAdmission>;
  submit(target: DesktopThreadIdentity, admission: DesktopQueueAdmission,
    input: { watchId: string; clientUserMessageId: string; prompt: string }): Promise<{ queueId: string; clientUserMessageId: string }>;
  observe(target: DesktopThreadIdentity, witness: DesktopQueueWitness): Promise<DesktopQueueObservation>;
}

/** A different queue request can wait beside existing work. A new ID alone cannot authorize replay of an unresolved identical request. */
export function desktopSendConflictsWithUnresolved(task: DesktopTaskRecord, other: DesktopTaskRecord): boolean {
  if (task.send_intent?.delivery_path !== "native_thread_queue") return true;
  return task.controller_session === other.controller_session && task.send_intent.text === other.send_intent?.text && !other.send_intent?.queue_id;
}

/** A queued item ID cannot anchor a turn. Retain the original client ID, text and pre-send boundary on every read. */
export function desktopQueueWitness(task: DesktopTaskRecord): DesktopQueueWitness {
  const intent = task.send_intent;
  if (intent?.delivery_path !== "native_thread_queue" || !intent.queue_cwd || !intent.queue_endpoint_id || intent.baseline_turn_ids.length > 1) {
    throw new Error("Desktop task does not have an exact native queue witness");
  }
  return { clientUserMessageId: intent.client_user_message_id, prompt: intent.text,
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
