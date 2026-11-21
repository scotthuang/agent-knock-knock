import type { DesktopTaskRecord } from "./desktop-state-store.js";
import type { DesktopThreadIdentity, DesktopTurn } from "./desktop-types.js";

export interface DesktopQueueAdmission {
  ownerId: string; endpointId: string; cwd: string; baselineTurnId: string | null;
}
export interface DesktopQueueWitness {
  clientUserMessageId: string; prompt: string; baselineTurnId: string | null; expectedCwd: string; expectedEndpointId: string;
}
export type DesktopQueueObservation = { state: "matched"; turn: DesktopTurn } |
  { state: "pending" | "uncertain"; reason: string };
export interface DesktopTaskQueuePort {
  prepare(target: DesktopThreadIdentity): Promise<DesktopQueueAdmission>;
  submit(target: DesktopThreadIdentity, admission: DesktopQueueAdmission,
    input: { watchId: string; clientUserMessageId: string; prompt: string }): Promise<{ queueId: string; clientUserMessageId: string }>;
  observe(target: DesktopThreadIdentity, witness: DesktopQueueWitness): Promise<DesktopQueueObservation>;
}

/** A queued item ID cannot anchor a turn. Retain the original client ID, text and pre-send boundary on every read. */
export function desktopQueueWitness(task: DesktopTaskRecord): DesktopQueueWitness {
  const intent = task.send_intent;
  if (intent?.delivery_path !== "native_thread_queue" || !intent.queue_cwd || !intent.queue_endpoint_id || intent.baseline_turn_ids.length > 1) {
    throw new Error("Desktop task does not have an exact native queue witness");
  }
  return { clientUserMessageId: intent.client_user_message_id, prompt: intent.text,
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
