import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createNativeRecordRepository, type NativeRecordRepository } from "./codex-native-record-store.js";
import { parseDesktopConversationId } from "./desktop-identity.js";
import { desktopNonblank } from "./desktop-async-state.js";
import { assertDesktopInteraction } from "./desktop-interaction-state.js";
import { validateDesktopResponseValue, type DesktopResponseValue } from "./desktop-response-value.js";
import type { DesktopInteraction, DesktopThreadIdentity } from "./desktop-types.js";

export interface DesktopResponseRecord extends DesktopResponseValue {
  schema: "agent-knock-knock/desktop-response";
  version: 1;
  revision: number;
  id: string;
  created_at: string;
  updated_at: string;
  target: DesktopThreadIdentity;
  desktop_id: string;
  controller_session: string;
  response_id: string;
  interaction: DesktopInteraction;
  client_user_message_id?: string;
  operation_id?: string;
  baseline_item_status?: string;
  state: "reserved" | "uncertain" | "sent" | "confirmed" | "not_sent";
  attempts: number;
  not_sent_history?: { attempt: number; observed_at: string; error_code?: string; baseline_item_status?: string }[];
  evidence?: "exact_async_answer_observed" | "exact_blocking_answer_observed" | "exact_approval_item_advanced";
  error_code?: string;
}
export type DesktopResponseRepository = NativeRecordRepository<DesktopResponseRecord>;

export function desktopResponseId(target: DesktopThreadIdentity, interactionId: string): string {
  const identity = { codexHome: target.codexHome, hostId: target.hostId, threadId: target.threadId };
  return `desktop-response:${createHash("sha256").update(JSON.stringify([identity, interactionId])).digest("hex")}`;
}
const validTime = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value));
export function assertDesktopResponseIdentity(desktopId: string, target: DesktopThreadIdentity): void {
  if (!isDeepStrictEqual(parseDesktopConversationId(desktopId), target)) throw new Error("Desktop response identity does not match its target");
}
function assertResponseLifecycle(record: DesktopResponseRecord): void {
  if (!["reserved", "uncertain", "sent", "confirmed", "not_sent"].includes(record.state) ||
    !validTime(record.created_at) || !validTime(record.updated_at) ||
    !Number.isSafeInteger(record.attempts) || record.attempts < 1) throw new Error("Invalid Desktop response lifecycle");
  if (record.state === "confirmed" && !["exact_async_answer_observed", "exact_blocking_answer_observed", "exact_approval_item_advanced"].includes(record.evidence ?? "")) throw new Error("Desktop response requires native evidence");
  if (record.not_sent_history !== undefined && (!Array.isArray(record.not_sent_history) || record.not_sent_history.some(attempt =>
    !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1 || !validTime(attempt.observed_at)))) throw new Error("Invalid Desktop response attempt history");
}
function assertDesktopResponse(value: unknown): asserts value is DesktopResponseRecord {
  const record = value as DesktopResponseRecord;
  if (!record || record.schema !== "agent-knock-knock/desktop-response" || record.version !== 1 ||
    !Number.isSafeInteger(record.revision) || record.revision < 1 || !/^desktop-response:[a-f0-9]{64}$/.test(record.id) ||
    !desktopNonblank(record.controller_session) || !desktopNonblank(record.response_id)) throw new Error("Invalid Desktop response record");
  assertDesktopResponseIdentity(record.desktop_id, record.target);
  assertDesktopInteraction(record.interaction, record.target); validateDesktopResponseValue(record.interaction, record);
  if (record.interaction.kind === "async_question" ? !desktopNonblank(record.client_user_message_id) : !desktopNonblank(record.operation_id)) {
    throw new Error("Desktop response requires a durable dispatch correlation ID");
  }
  if (record.id !== desktopResponseId(record.target, record.interaction.id)) throw new Error("Desktop response record has a different interaction identity");
  assertResponseLifecycle(record);
}

export function createDesktopResponseStore(storeDir: string, locks: { acquire(lockPath: string): () => void }): DesktopResponseRepository {
  return createNativeRecordRepository({ storeDir, directory: "desktop-responses", prefix: "desktop-response:", acquire: locks.acquire,
    assert: assertDesktopResponse,
    assertUpdate: (previous, next) => {
      for (const key of ["id", "created_at", "target", "desktop_id", "controller_session", "response_id", "interaction", "answer", "response", "client_user_message_id", "operation_id"] as const) {
        if (!isDeepStrictEqual(previous[key], next[key])) throw new Error("Desktop response intent cannot change");
      }
      if (previous.baseline_item_status !== next.baseline_item_status && !(previous.state === "not_sent" &&
        next.state === "reserved" && next.attempts === previous.attempts + 1)) throw new Error("Desktop response baseline can change only for a proven not-sent retry");
      if (previous.state === "confirmed" && next.state !== "confirmed") throw new Error("Desktop answer proof cannot regress");
    } });
}
