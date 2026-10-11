import { isDeepStrictEqual } from "node:util";
import { createCallbackEnvelope, parseCallbackRoute, parseCallbackAttemptOutcome,
  type CallbackRouteV1 } from "./callback-transport.js";
import { assertBackendRecoveryFields, assertBackendRecoveryUpdate, type BackendRecoveryFields } from "./backend-task-recovery.js";
import { createNativeRecordRepository, type NativeRecordRepository } from "./codex-native-record-store.js";
import type { CodexNativeNotification } from "./codex-native-state-store.js";
import { createClaudeNativeConversationId, isClaudeNativeWatchId, isClaudeNativeUuid,
  type ClaudeNativeIdentity, type ClaudeNativeCatalogEntry } from "./claude-native-identity.js";
import type { ClaudeNativeTranscriptSource, ClaudeNativePublicProgress } from "./claude-native-observation.js";

export type ClaudeNativeTaskStatus = "awaiting_acceptance" | "watching" | "completed" | "failed" |
  "interrupted" | "exited" | "timed_out" | "cancelled";
export interface ClaudeNativeSendIntent {
  message_id: string; client_user_message_id: string; native_message_id: string; text: string;
  sender_pid?: number; state: "reserved" | "uncertain" | "accepted" | "not_sent" | "held" | "refused" | "attached";
  dispatched_at: string; error_code?: string;
}
export interface ClaudeNativeTaskRecord extends BackendRecoveryFields {
  schema: "agent-knock-knock/claude-native-task"; version: 1; revision: number;
  id: string; watch_id: string; native_id: string; target: ClaudeNativeIdentity;
  entry: ClaudeNativeCatalogEntry; controller_session: string; kind: "send" | "watch";
  status: ClaudeNativeTaskStatus; created_at: string; updated_at: string; deadline_at: string;
  native_input_id?: string; source?: ClaudeNativeTranscriptSource; send_intent?: ClaudeNativeSendIntent;
  callback_route?: CallbackRouteV1; observed_at?: string; observation_error?: string;
  response_text?: string; response_truncated?: boolean; progress?: ClaudeNativePublicProgress;
  waiting_for?: string; notifications: CodexNativeNotification[];
}
export type ClaudeNativeStateRepository = NativeRecordRepository<ClaudeNativeTaskRecord>;
const time = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
export function assertClaudeNativeTaskRecord(value: unknown): asserts value is ClaudeNativeTaskRecord {
  const r = value as ClaudeNativeTaskRecord;
  if (!r || r.schema !== "agent-knock-knock/claude-native-task" || r.version !== 1 ||
    !Number.isSafeInteger(r.revision) || r.revision < 1 || !isClaudeNativeWatchId(r.id) || r.watch_id !== r.id ||
    !text(r.controller_session) || !["send", "watch"].includes(r.kind) ||
    !["awaiting_acceptance", "watching", "completed", "failed", "interrupted", "exited", "timed_out", "cancelled"].includes(r.status) ||
    ![r.created_at, r.updated_at, r.deadline_at].every(time) || !Array.isArray(r.notifications)) throw new Error("Invalid Claude native task");
  assertTaskIdentity(r);
  assertSendIntent(r);
  if (r.source && (!text(r.source.relativePath) || !/^\d+$/u.test(r.source.device) || !/^\d+$/u.test(r.source.inode))) throw new Error("Invalid Claude transcript anchor");
  if (r.callback_route && parseCallbackRoute(r.callback_route).controller_session_id !== r.controller_session) throw new Error("Claude callback owner mismatch");
  assertNotifications(r);
}
function assertTaskIdentity(r: ClaudeNativeTaskRecord): void {
  if (createClaudeNativeConversationId(r.target) !== r.native_id || createClaudeNativeConversationId(r.entry) !== r.native_id) throw new Error("Claude task identity mismatch");
  assertBackendRecoveryFields(r);
  if (r.native_input_id !== undefined && !isClaudeNativeUuid(r.native_input_id)) throw new Error("Invalid Claude input anchor");
  if (r.kind === "watch" && (!r.native_input_id || r.send_intent)) throw new Error("Claude Watch requires exact input");
}
function assertSendIntent(r: ClaudeNativeTaskRecord): void {
  if (r.kind === "send") {
    const i = r.send_intent;
    if (!i || !text(i.message_id) || !text(i.text) || !isClaudeNativeUuid(i.client_user_message_id) ||
      !isClaudeNativeUuid(i.native_message_id) || !time(i.dispatched_at) ||
      !["reserved", "uncertain", "accepted", "not_sent", "held", "refused", "attached"].includes(i.state) ||
      i.sender_pid !== undefined && (!Number.isSafeInteger(i.sender_pid) || i.sender_pid < 1) ||
      r.native_input_id && r.native_input_id !== i.client_user_message_id) throw new Error("Invalid Claude send intent");
    if (i.state === "accepted" && (!r.native_input_id || !i.sender_pid)) throw new Error("Claude acceptance requires exact native provenance");
  }
}
function assertNotifications(r: ClaudeNativeTaskRecord): void {
  const ids = new Set<string>();
  for (const n of r.notifications) {
    if (!n || !r.callback_route || !text(n.id) || ids.has(n.id) || !Number.isSafeInteger(n.attempts) || n.attempts < 0 ||
      !["ready", "leased", "retry_wait", "accepted", "failed", "uncertain"].includes(n.status)) throw new Error("Invalid Claude callback");
    ids.add(n.id);
    assertNotificationIdentity(r, n);
    if (n.outcome) parseCallbackAttemptOutcome(n.outcome);
    if (n.status === "leased" && (!text(n.attempt_id) || !time(n.lease_expires_at))) throw new Error("Invalid Claude callback lease");
    if (n.status === "retry_wait" && (!time(n.retry_at) || n.outcome?.disposition !== "retryable_failure")) throw new Error("Invalid Claude callback retry");
  }
}
function assertNotificationIdentity(r: ClaudeNativeTaskRecord, n: CodexNativeNotification): void {
  const envelope = createCallbackEnvelope({ route: r.callback_route!, source: n.envelope.source, event: n.envelope.event });
  if (!isDeepStrictEqual(envelope, n.envelope) || envelope.source.kind !== "claude_native_watch" ||
    envelope.source.watch_id !== r.id || envelope.source.native_id !== r.native_id || envelope.event.id !== n.id) throw new Error("Claude callback identity mismatch");
}
export function createClaudeNativeStateStore(storeDir: string, locks: { acquire(lock: string): () => void }): ClaudeNativeStateRepository {
  return createNativeRecordRepository({ storeDir, directory: "claude-native-tasks", prefix: "claude-cli-watch:",
    acquire: locks.acquire, assert: assertClaudeNativeTaskRecord,
    assertUpdate(previous, next) {
      for (const key of ["id", "watch_id", "native_id", "target", "controller_session", "kind", "created_at", "callback_route"] as const) {
        if (!isDeepStrictEqual(previous[key], next[key])) throw new Error(`Claude immutable ${key} changed`);
      }
      assertBackendRecoveryUpdate(previous, next);
      if (previous.native_input_id && previous.native_input_id !== next.native_input_id) throw new Error("Claude input anchor changed");
      if (previous.source && !isDeepStrictEqual(previous.source, next.source)) throw new Error("Claude transcript anchor changed");
      if (previous.send_intent) {
        for (const key of ["message_id", "client_user_message_id", "native_message_id", "text", "dispatched_at"] as const) {
          if (previous.send_intent[key] !== next.send_intent?.[key]) throw new Error("Claude send intent changed");
        }
        if (previous.send_intent.sender_pid && previous.send_intent.sender_pid !== next.send_intent?.sender_pid) throw new Error("Claude sender changed");
      }
      for (const before of previous.notifications) {
        const after = next.notifications.find(n => n.id === before.id);
        if (!after || !isDeepStrictEqual(before.envelope, after.envelope)) throw new Error("Claude notification changed");
      }
    } });
}
