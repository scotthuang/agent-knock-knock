import { assertBackendRecoveryFields, assertBackendRecoveryUpdate, type BackendRecoveryFields, type BackendRetryFields } from "./backend-task-recovery.js";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertRealDirectory, atomicSaveJsonFile, isNodeError, readJsonFileNoFollow } from "./durable-json-file.js";
import { assertStoreReadable, ensureDir, withStoreWriterLease } from "./store.js";
import {
  createCallbackEnvelope, parseCallbackAttemptOutcome, parseCallbackRoute,
  type CallbackAttemptOutcome, type CallbackEnvelopeV1, type CallbackRouteV1
} from "./callback-transport.js";
import type { DesktopAsyncInteraction, DesktopInteraction, DesktopThreadIdentity } from "./desktop-types.js";
import { parseDesktopConversationId } from "./desktop-identity.js";
import { assertDesktopAsyncInteraction } from "./desktop-async-state.js";
import { assertDesktopInteraction } from "./desktop-interaction-state.js";

export const DESKTOP_TASKS_DIRECTORY = "desktop-tasks";
export type DesktopTaskStatus = "awaiting_acceptance" | "watching" | "completed" |
  "failed" | "interrupted" | "timed_out" | "cancelled";
export interface DesktopSendIntent {
  message_id: string;
  client_user_message_id: string;
  text: string;
  owner_client_id: string;
  baseline_turn_ids: string[];
  state: "reserved" | "uncertain" | "accepted" | "not_sent";
  dispatched_at: string;
  receipt_turn_id?: string;
  error_code?: string;
}
export interface DesktopNotification extends BackendRetryFields {
  id: string;
  envelope: CallbackEnvelopeV1;
  status: "ready" | "leased" | "retry_wait" | "accepted" | "failed" | "uncertain";
  attempts: number;
  attempt_id?: string;
  lease_expires_at?: string;
  retry_at?: string;
  outcome?: CallbackAttemptOutcome;
}
export interface DesktopTaskRecord extends BackendRecoveryFields {
  schema: "agent-knock-knock/desktop-task";
  version: 1;
  revision: number;
  id: string;
  watch_id: string;
  desktop_id: string;
  target: DesktopThreadIdentity;
  controller_session: string;
  kind: "send" | "watch";
  status: DesktopTaskStatus;
  created_at: string;
  updated_at: string;
  deadline_at: string;
  native_turn_id?: string;
  send_intent?: DesktopSendIntent;
  callback_route?: CallbackRouteV1;
  observed_at?: string;
  observation_error?: string;
  pending_manual_count: number;
  pending_manual_fingerprint?: string;
  /** Older v1 records omit this field; absence means no observed async questions. */
  pending_async_interactions?: DesktopAsyncInteraction[];
  /** All executable interactions; old async-only records remain readable. */
  pending_interactions?: DesktopInteraction[];
  final_text?: string;
  notifications: DesktopNotification[];
}
export interface DesktopStateScan {
  tasks: DesktopTaskRecord[];
  errors: { id: string; error_code: "desktop_record_invalid" }[];
}
export interface DesktopStateRepository {
  load(id: string): DesktopTaskRecord | undefined;
  list(): DesktopTaskRecord[];
  scanForReconciliation(): DesktopStateScan;
  save(record: DesktopTaskRecord, expectedRevision: number | null): DesktopTaskRecord;
  withLock<T>(id: string, operation: () => T): T;
}

function assertId(id: string): void {
  if (!/^desktop-watch:[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error("invalid Desktop task id");
}
function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function assertPrivate(filePath: string, directory: boolean): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Desktop state path must be an owner-private regular " + (directory ? "directory" : "file"));
  }
}
function assertTaskIdentity(r: DesktopTaskRecord): void {
  assertId(r.id);
  if (r.watch_id !== r.id || !nonblank(r.desktop_id) || !nonblank(r.controller_session) ||
    !r.target || !nonblank(r.target.codexHome) || !path.isAbsolute(r.target.codexHome) ||
    !nonblank(r.target.hostId) || !nonblank(r.target.threadId)) throw new Error("invalid Desktop task identity");
  if (!isDeepStrictEqual(parseDesktopConversationId(r.desktop_id), r.target)) throw new Error("Desktop conversation ID does not match native target");
}
function assertTaskLifecycle(r: DesktopTaskRecord): void {
  if (!["send", "watch"].includes(r.kind) ||
    !["awaiting_acceptance", "watching", "completed", "failed", "interrupted", "timed_out", "cancelled"].includes(r.status) ||
    !validTime(r.created_at) || !validTime(r.updated_at) || !validTime(r.deadline_at) ||
    !Number.isSafeInteger(r.pending_manual_count) || r.pending_manual_count < 0 ||
    !Array.isArray(r.notifications) || (r.native_turn_id !== undefined && !nonblank(r.native_turn_id))) throw new Error("invalid Desktop task state");
  if (["watching", "completed", "interrupted"].includes(r.status) && !r.native_turn_id) throw new Error("Desktop task state requires an exact turn anchor");
}
function assertSendIntent(r: DesktopTaskRecord): void {
  const i = r.send_intent;
  if (!i || !nonblank(i.message_id) || !nonblank(i.client_user_message_id) || !nonblank(i.text) ||
    !nonblank(i.owner_client_id) || !Array.isArray(i.baseline_turn_ids) ||
    i.baseline_turn_ids.some(id => !nonblank(id)) || !validTime(i.dispatched_at) ||
    !["reserved", "uncertain", "accepted", "not_sent"].includes(i.state) ||
    (i.receipt_turn_id !== undefined && !nonblank(i.receipt_turn_id)) ||
    (i.state === "accepted" && !r.native_turn_id) || (r.native_turn_id && i.state !== "accepted")) throw new Error("invalid Desktop send intent");
}
function assertNotification(r: DesktopTaskRecord, n: DesktopNotification, ids: Set<string>): void {
  if (!n || !nonblank(n.id) || ids.has(n.id) ||
    !["ready", "leased", "retry_wait", "accepted", "failed", "uncertain"].includes(n.status) ||
    !Number.isSafeInteger(n.attempts) || n.attempts < 0 || !r.callback_route) throw new Error("invalid Desktop outbox");
  ids.add(n.id);
  const envelope = createCallbackEnvelope({ route: r.callback_route, source: n.envelope.source, event: n.envelope.event });
  if (!isDeepStrictEqual(envelope, n.envelope) || envelope.source.kind !== "desktop_watch" ||
    envelope.source.watch_id !== r.id || envelope.source.desktop_id !== r.desktop_id ||
    envelope.event.id !== n.id) throw new Error("Desktop callback identity mismatch");
  if (envelope.event.requires_response) assertInteractionNotification(r, n);
  assertNotificationDelivery(n);
}
function assertInteractionNotification(record: DesktopTaskRecord, notification: DesktopNotification): void {
  const event = notification.envelope.event; const metadata = event.metadata;
  if (event.type !== "desktop_watch.interaction" || !metadata || !nonblank(metadata.interaction_id) ||
    !["respond", "approve"].includes(String(metadata.action)) || metadata.thread_id !== record.target.threadId || metadata.turn_id !== record.native_turn_id ||
    notification.id !== `${record.id}:interaction:${metadata.interaction_id}` || !metadata.interaction || typeof metadata.interaction !== "object") {
    throw new Error("Desktop response notification requires an exact interaction");
  }
  const interaction = metadata.interaction as Record<string, unknown>;
  if (!["async_question", "blocking_question", "command_approval", "file_approval"].includes(String(interaction.kind)) || interaction.interaction_id !== metadata.interaction_id ||
    interaction.native_thread_id !== record.target.threadId || interaction.native_turn_id !== record.native_turn_id) {
    throw new Error("Desktop response notification has a different interaction identity");
  }
  if (metadata.action !== (String(interaction.kind).endsWith("approval") ? "approve" : "respond")) throw new Error("Desktop notification action does not match its interaction");
}
function assertAsyncInteractions(record: DesktopTaskRecord): void {
  if (record.pending_async_interactions === undefined) return;
  if (!Array.isArray(record.pending_async_interactions)) throw new Error("Invalid Desktop pending async questions");
  const ids = new Set<string>();
  for (const interaction of record.pending_async_interactions) {
    assertDesktopAsyncInteraction(interaction, record.target, record.native_turn_id);
    if (!record.native_turn_id || ids.has(interaction.id)) throw new Error("Desktop async question lacks a unique task anchor");
    ids.add(interaction.id);
  }
}
function assertPendingInteractions(record: DesktopTaskRecord): void {
  if (record.pending_interactions === undefined) return;
  if (!Array.isArray(record.pending_interactions)) throw new Error("Invalid Desktop pending interactions");
  const ids = new Set<string>();
  for (const interaction of record.pending_interactions) {
    assertDesktopInteraction(interaction, record.target, record.native_turn_id);
    if (!record.native_turn_id || ids.has(interaction.id)) throw new Error("Desktop interaction lacks a unique task anchor");
    ids.add(interaction.id);
  }
}
function assertNotificationDelivery(n: DesktopNotification): void {
  if (n.retry_budget_until !== undefined && (!Number.isSafeInteger(n.retry_budget_until) || n.retry_budget_until < 1)) throw new Error("invalid Desktop delivery retry budget");
  if (n.outcome) parseCallbackAttemptOutcome(n.outcome);
  if (n.status === "leased" && (!nonblank(n.attempt_id) || !validTime(n.lease_expires_at))) throw new Error("invalid Desktop delivery lease");
  if (n.status === "retry_wait" && (!validTime(n.retry_at) || n.outcome?.disposition !== "retryable_failure")) throw new Error("invalid Desktop delivery retry");
}
export function assertDesktopTaskRecord(value: unknown): asserts value is DesktopTaskRecord {
  const r = value as DesktopTaskRecord;
  if (!r || typeof r !== "object" || r.schema !== "agent-knock-knock/desktop-task" ||
    r.version !== 1 || !Number.isSafeInteger(r.revision) || r.revision < 1) throw new Error("invalid Desktop task record");
  assertTaskIdentity(r); assertTaskLifecycle(r); assertBackendRecoveryFields(r);
  assertAsyncInteractions(r);
  assertPendingInteractions(r);
  if (r.kind === "send") assertSendIntent(r);
  else if (r.send_intent !== undefined || !r.native_turn_id) throw new Error("invalid Desktop watch anchor");
  if (r.callback_route) {
    parseCallbackRoute(r.callback_route);
    if (r.callback_route.controller_session_id !== r.controller_session || r.callback_route.capabilities?.respond === true) throw new Error("Desktop callback must belong to its controller and be notification-only");
  }
  const ids = new Set<string>();
  for (const n of r.notifications) assertNotification(r, n, ids);
}

export function createDesktopStateStore(storeDir: string, locks: { acquire(lockPath: string): () => void }): DesktopStateRepository {
  const root = path.join(storeDir, DESKTOP_TASKS_DIRECTORY);
  const statePath = (id: string): string => { assertId(id); return path.join(root, `${id}.json`); };
  const load = (id: string): DesktopTaskRecord | undefined => {
    const filePath = statePath(id);
    if (!fs.existsSync(storeDir)) return undefined;
    assertStoreReadable(storeDir);
    try {
      assertRealDirectory(root, "Desktop tasks"); assertPrivate(root, true); assertPrivate(filePath, false);
      const record = readJsonFileNoFollow(filePath, "Desktop task"); assertDesktopTaskRecord(record);
      if (record.id !== id) throw new Error("Desktop record filename identity mismatch");
      return record;
    } catch (error) { if (isNodeError(error, "ENOENT")) return undefined; throw error; }
  };
  const scan = (isolate: boolean): DesktopStateScan => {
    const result: DesktopStateScan = { tasks: [], errors: [] };
    if (!fs.existsSync(storeDir)) return result;
    assertStoreReadable(storeDir);
    if (!fs.existsSync(root)) return result;
    assertPrivate(root, true);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const filePath = path.join(root, entry.name);
      try { assertPrivate(filePath, false); }
      catch (error) {
        // Another worker can release its lock or rename a temporary file
        // between readdir and lstat. Do not mistake that normal race for corruption.
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      if (/^desktop-watch:[a-zA-Z0-9_-]{8,128}\.json\.lock(?:\.reclaim)?$/.test(entry.name) ||
        /^\.desktop-watch:[a-zA-Z0-9_-]{8,128}\.json\..+\.tmp$/.test(entry.name)) continue;
      if (!entry.name.endsWith(".json")) throw new Error("unknown Desktop state file");
      const id = entry.name.slice(0, -5); assertId(id);
      // Security checks are outside content isolation: symlinks and access failures abort the scan.
      let value: unknown;
      try { value = readJsonFileNoFollow(filePath, "Desktop task"); }
      catch (error) {
        if (!isolate || !(error instanceof SyntaxError)) throw error;
        result.errors.push({ id, error_code: "desktop_record_invalid" }); continue;
      }
      try {
        assertDesktopTaskRecord(value);
        if (value.id !== id) throw new Error("Desktop record filename identity mismatch");
        result.tasks.push(value);
      } catch (error) {
        if (!isolate) throw error;
        result.errors.push({ id, error_code: "desktop_record_invalid" });
      }
    }
    result.tasks.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return result;
  };
  return {
    load, list: () => scan(false).tasks, scanForReconciliation: () => scan(true),
    withLock: (id, operation) => withStoreWriterLease(storeDir, () => {
      statePath(id); ensureDir(root); assertPrivate(root, true);
      const release = locks.acquire(`${statePath(id)}.lock`);
      try { return operation(); } finally { release(); }
    }),
    save: (record, expectedRevision) => withStoreWriterLease(storeDir, () => {
      const current = load(record.id);
      if ((current?.revision ?? null) !== expectedRevision) throw new Error("Desktop task revision conflict");
      if (current) {
        for (const key of ["id", "watch_id", "desktop_id", "target", "controller_session", "kind", "created_at", "callback_route"] as const) {
          if (!isDeepStrictEqual(current[key], record[key])) throw new Error(`Desktop task immutable ${key} changed`);
        }
        assertBackendRecoveryUpdate(current, record);
        if (current.native_turn_id && current.native_turn_id !== record.native_turn_id) throw new Error("Desktop exact turn anchor cannot change");
        if (current.send_intent) {
          for (const key of ["message_id", "client_user_message_id", "text", "owner_client_id", "baseline_turn_ids", "dispatched_at"] as const) {
            if (!isDeepStrictEqual(current.send_intent[key], record.send_intent?.[key])) throw new Error("Desktop send intent cannot change");
          }
          if (current.send_intent.receipt_turn_id && current.send_intent.receipt_turn_id !== record.send_intent?.receipt_turn_id) throw new Error("Desktop send receipt cannot change");
        }
      }
      const saved = { ...record, revision: (expectedRevision ?? 0) + 1 }; assertDesktopTaskRecord(saved);
      atomicSaveJsonFile(statePath(saved.id), saved, {
        rootLabel: "AKK store", directoryLabel: "Desktop tasks", fileLabel: "Desktop task", ensureDirectory: ensureDir
      });
      return saved;
    })
  };
}
