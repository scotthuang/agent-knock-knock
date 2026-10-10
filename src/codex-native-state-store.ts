import { assertBackendRecoveryFields, assertBackendRecoveryUpdate, type BackendRecoveryFields, type BackendRetryFields } from "./backend-task-recovery.js";
import { isDeepStrictEqual } from "node:util";
import {
  createCallbackEnvelope, parseCallbackAttemptOutcome, parseCallbackRoute,
  type CallbackAttemptOutcome, type CallbackEnvelopeV1, type CallbackRouteV1
} from "./callback-transport.js";
import { isCodexNativeWatchId, parseCodexNativeConversationId } from "./codex-native-identity.js";
export { isCodexNativeWatchId } from "./codex-native-identity.js";
import { createNativeRecordRepository, type NativeRecordRepository } from "./codex-native-record-store.js";
import type { CodexNativeIdentity, NativeInteraction } from "./codex-native-types.js";

export type CodexNativeTaskStatus = "awaiting_acceptance" | "watching" | "completed" |
  "failed" | "interrupted" | "timed_out" | "cancelled";
export interface CodexNativeSendIntent {
  message_id: string;
  client_user_message_id: string;
  text: string;
  baseline_turn_ids: string[];
  state: "reserved" | "uncertain" | "accepted" | "not_sent";
  dispatched_at: string;
  receipt_turn_id?: string;
  error_code?: string;
}
export interface CodexNativeNotification extends BackendRetryFields {
  id: string;
  envelope: CallbackEnvelopeV1;
  status: "ready" | "leased" | "retry_wait" | "accepted" | "failed" | "uncertain";
  attempts: number;
  attempt_id?: string;
  lease_expires_at?: string;
  retry_at?: string;
  outcome?: CallbackAttemptOutcome;
}
/** Connection-local request IDs are deliberately absent from persisted interaction authority. */
export type PersistedNativeInteraction = Omit<NativeInteraction, "requestId">;
export interface CodexNativeTaskRecord extends BackendRecoveryFields {
  schema: "agent-knock-knock/codex-native-task";
  version: 1;
  revision: number;
  id: string;
  watch_id: string;
  native_id: string;
  target: CodexNativeIdentity;
  controller_session: string;
  kind: "send" | "watch";
  status: CodexNativeTaskStatus;
  created_at: string;
  updated_at: string;
  deadline_at: string;
  native_turn_id?: string;
  send_intent?: CodexNativeSendIntent;
  callback_route?: CallbackRouteV1;
  observed_at?: string;
  observation_error?: string;
  pending_interactions: PersistedNativeInteraction[];
  final_text?: string;
  notifications: CodexNativeNotification[];
}
export type CodexNativeStateRepository = NativeRecordRepository<CodexNativeTaskRecord>;
export const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
export function assertNativeIdentity(nativeId: string, target: CodexNativeIdentity): void {
  if (!isDeepStrictEqual(parseCodexNativeConversationId(nativeId), target)) throw new Error("Codex native conversation does not match its target");
}
export function persistNativeInteraction(value: NativeInteraction): PersistedNativeInteraction {
  const { requestId: _requestId, ...persistent } = value;
  return structuredClone(persistent);
}
export function assertPersistedNativeInteraction(value: PersistedNativeInteraction, target: CodexNativeIdentity, turnId?: string): void {
  if (!value || !nonblank(value.id) || !nonblank(value.itemId) || !nonblank(value.method) ||
    value.threadId !== target.threadId || !nonblank(value.turnId) || turnId && value.turnId !== turnId ||
    !["command_approval", "file_approval", "blocking_question", "async_question"].includes(value.kind) ||
    Object.hasOwn(value, "requestId") || !Array.isArray(value.questions) || value.questions.some(q =>
      !nonblank(q.id) || !nonblank(q.title) || !Array.isArray(q.options) || q.options.some(o => typeof o !== "string"))) {
    throw new Error("Invalid persisted Codex native interaction");
  }
  if (value.changes !== undefined && (!Array.isArray(value.changes) || value.changes.some(change =>
    !change || !nonblank(change.path) || change.kind !== undefined && typeof change.kind !== "string" ||
    change.diff !== undefined && typeof change.diff !== "string" || change.diffTruncated !== undefined && typeof change.diffTruncated !== "boolean"))) {
    throw new Error("Invalid persisted native file approval changes");
  }
}
function assertTaskSchema(r: CodexNativeTaskRecord): void {
  if (!r || typeof r !== "object" || r.schema !== "agent-knock-knock/codex-native-task" || r.version !== 1 ||
    !Number.isSafeInteger(r.revision) || r.revision < 1 || !isCodexNativeWatchId(r.id) || r.watch_id !== r.id ||
    !nonblank(r.controller_session) || !["send", "watch"].includes(r.kind) ||
    !["awaiting_acceptance", "watching", "completed", "failed", "interrupted", "timed_out", "cancelled"].includes(r.status) ||
    !validTime(r.created_at) || !validTime(r.updated_at) || !validTime(r.deadline_at) ||
    !Array.isArray(r.pending_interactions) || !Array.isArray(r.notifications)) throw new Error("Invalid Codex native task record");
}
function assertTaskAnchor(r: CodexNativeTaskRecord): void {
  assertNativeIdentity(r.native_id, r.target);
  if (r.native_turn_id !== undefined && !nonblank(r.native_turn_id) ||
    ["watching", "completed", "interrupted"].includes(r.status) && !r.native_turn_id) throw new Error("Codex native task requires exact turn anchor");
}
function assertTaskIntent(r: CodexNativeTaskRecord): void {
  if (r.kind !== "send") {
    if (r.send_intent || !r.native_turn_id) throw new Error("Invalid Codex native Watch anchor");
    return;
  }
  const i = r.send_intent;
  if (!i || !nonblank(i.message_id) || !nonblank(i.client_user_message_id) || !nonblank(i.text) ||
    !Array.isArray(i.baseline_turn_ids) || i.baseline_turn_ids.some(id => !nonblank(id)) ||
    !validTime(i.dispatched_at) || !["reserved", "uncertain", "accepted", "not_sent"].includes(i.state) ||
    i.receipt_turn_id !== undefined && !nonblank(i.receipt_turn_id) ||
    (i.state === "accepted") !== Boolean(r.native_turn_id)) throw new Error("Invalid Codex native send intent");
}
function assertTaskInteractions(r: CodexNativeTaskRecord): void {
  const interactionIds = new Set<string>();
  for (const i of r.pending_interactions) {
    assertPersistedNativeInteraction(i, r.target, r.native_turn_id);
    if (interactionIds.has(i.id)) throw new Error("Duplicate native interaction"); interactionIds.add(i.id);
  }
}
function assertTaskNotifications(r: CodexNativeTaskRecord): void {
  if (r.callback_route && parseCallbackRoute(r.callback_route).controller_session_id !== r.controller_session) {
    throw new Error("Codex native callback controller mismatch");
  }
  const notificationIds = new Set<string>();
  for (const n of r.notifications) {
    if (!n || !nonblank(n.id) || notificationIds.has(n.id) || !r.callback_route ||
      !["ready", "leased", "retry_wait", "accepted", "failed", "uncertain"].includes(n.status) ||
      !Number.isSafeInteger(n.attempts) || n.attempts < 0) throw new Error("Invalid Codex native notification");
    notificationIds.add(n.id);
    const envelope = createCallbackEnvelope({ route: r.callback_route, source: n.envelope.source, event: n.envelope.event });
    if (!isDeepStrictEqual(envelope, n.envelope) || envelope.source.kind !== "codex_native_watch" ||
      envelope.source.watch_id !== r.id || envelope.source.native_id !== r.native_id || envelope.event.id !== n.id) {
      throw new Error("Codex native callback identity mismatch");
    }
    assertNotificationDelivery(n);
  }
}
function assertNotificationDelivery(n: CodexNativeNotification): void {
  if (n.outcome) parseCallbackAttemptOutcome(n.outcome);
  if (n.retry_budget_until !== undefined && (!Number.isSafeInteger(n.retry_budget_until) || n.retry_budget_until < 1)) throw new Error("Invalid native callback retry budget");
  if (n.status === "leased" && (!nonblank(n.attempt_id) || !validTime(n.lease_expires_at))) throw new Error("Invalid native callback lease");
  if (n.status === "retry_wait" && (!validTime(n.retry_at) || n.outcome?.disposition !== "retryable_failure")) throw new Error("Invalid native callback retry");
}
export function assertCodexNativeTaskRecord(value: unknown): asserts value is CodexNativeTaskRecord {
  const record = value as CodexNativeTaskRecord;
  assertTaskSchema(record);
  assertBackendRecoveryFields(record);
  assertTaskAnchor(record);
  assertTaskIntent(record);
  assertTaskInteractions(record);
  assertTaskNotifications(record);
}
export function createCodexNativeStateStore(storeDir: string, locks: { acquire(lockPath: string): () => void }): CodexNativeStateRepository {
  return createNativeRecordRepository({ storeDir, directory: "codex-native-tasks", prefix: "codex-cli-watch:",
    acquire: locks.acquire, assert: assertCodexNativeTaskRecord,
    assertUpdate: (previous, next) => {
      for (const key of ["id", "watch_id", "native_id", "target", "controller_session", "kind", "created_at", "callback_route"] as const) {
        if (!isDeepStrictEqual(previous[key], next[key])) throw new Error(`Codex native immutable ${key} changed`);
      }
      assertBackendRecoveryUpdate(previous, next);
      for (const before of previous.notifications) {
        const after = next.notifications.find(note => note.id === before.id);
        if (!after || !isDeepStrictEqual(before.envelope, after.envelope) || after.attempts < before.attempts ||
          (after.retry_budget_until ?? 0) < (before.retry_budget_until ?? 0)) throw new Error("Codex native notification identity or attempts cannot change");
      }
      if (previous.native_turn_id && next.native_turn_id !== previous.native_turn_id) throw new Error("Codex native exact turn anchor cannot change");
      if (previous.send_intent) {
        for (const key of ["message_id", "client_user_message_id", "text", "baseline_turn_ids", "dispatched_at"] as const) {
          if (!isDeepStrictEqual(previous.send_intent[key], next.send_intent?.[key])) throw new Error("Codex native send intent cannot change");
        }
        if (previous.send_intent.receipt_turn_id && previous.send_intent.receipt_turn_id !== next.send_intent?.receipt_turn_id) throw new Error("Codex native receipt cannot change");
      }
    } });
}
