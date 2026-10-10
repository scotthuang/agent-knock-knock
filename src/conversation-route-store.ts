import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createNativeRecordRepository } from "./codex-native-record-store.js";

export interface ConversationRouteInput {
  controllerSession: string;
  messageId: string;
  requestText: string;
  /** The selected public target. A retry through a different alias conflicts instead of authorizing another send. */
  canonicalTarget: string;
}
export interface ConversationRouteChoice { route: "native" | "terminal"; targetId: string }
export interface ConversationRouteRecord {
  schema: "agent-knock-knock/conversation-route";
  version: 1;
  revision: number;
  id: string;
  controller_session: string;
  message_id: string;
  request_text: string;
  canonical_target: string;
  route: ConversationRouteChoice["route"];
  target_id: string;
  created_at: string;
  updated_at: string;
  /** A recorded receipt is an observation, not proof of delivery or task acceptance. */
  state: "reserved" | "uncertain" | "recorded";
  receipt?: Record<string, unknown>;
  error_code?: string;
}
export interface ConversationRouteStore {
  load(input: ConversationRouteInput): ConversationRouteRecord | undefined;
  reserve(input: ConversationRouteInput, choice: ConversationRouteChoice): { record: ConversationRouteRecord; created: boolean };
  recordReceipt(input: ConversationRouteInput, choice: ConversationRouteChoice, receipt: Record<string, unknown>): ConversationRouteRecord;
  markUncertain(input: ConversationRouteInput, choice: ConversationRouteChoice, errorCode?: string): ConversationRouteRecord;
}
export class ConversationRouteError extends Error {
  constructor(public readonly code: "conversation_route_conflict" | "conversation_route_missing" | "conversation_route_invalid", message: string) {
    super(message); this.name = "ConversationRouteError";
  }
}
const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const recordValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
function invalid(message: string): never { throw new ConversationRouteError("conversation_route_invalid", message); }
function conflict(): never { throw new ConversationRouteError("conversation_route_conflict", "Message ID is already bound to different immutable request input or a different conversation route"); }

export function conversationRouteId(controllerSession: string, messageId: string): string {
  if (!nonblank(controllerSession) || !nonblank(messageId)) invalid("Conversation route requires a controller and message ID");
  return `conversation-route:${createHash("sha256").update(JSON.stringify([controllerSession, messageId])).digest("hex")}`;
}
function assertInput(input: ConversationRouteInput): void {
  if (!input || !nonblank(input.controllerSession) || !nonblank(input.messageId) ||
    !nonblank(input.requestText) || !nonblank(input.canonicalTarget)) invalid("Invalid conversation route input");
}
function assertChoice(choice: ConversationRouteChoice): void {
  if (!choice || !["native", "terminal"].includes(choice.route) || !nonblank(choice.targetId)) invalid("Invalid conversation route choice");
}
function assertMatches(record: ConversationRouteRecord, input: ConversationRouteInput): void {
  if (record.controller_session !== input.controllerSession || record.message_id !== input.messageId ||
    record.request_text !== input.requestText || record.canonical_target !== input.canonicalTarget) conflict();
}
function assertRecord(value: unknown): asserts value is ConversationRouteRecord {
  const r = value as ConversationRouteRecord;
  if (!r || r.schema !== "agent-knock-knock/conversation-route" || r.version !== 1 ||
    !Number.isSafeInteger(r.revision) || r.revision < 1 || !nonblank(r.request_text) || !nonblank(r.canonical_target) ||
    !validTime(r.created_at) || !validTime(r.updated_at) || !["reserved", "uncertain", "recorded"].includes(r.state)) {
    invalid("Invalid conversation route record");
  }
  if (r.id !== conversationRouteId(r.controller_session, r.message_id)) invalid("Conversation route record identity mismatch");
  assertChoice({ route: r.route, targetId: r.target_id });
  if ((r.state === "recorded") !== (r.receipt !== undefined) || r.receipt !== undefined && !recordValue(r.receipt) ||
    r.error_code !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(r.error_code)) invalid("Invalid conversation route outcome");
}
function assertUpdate(previous: ConversationRouteRecord, next: ConversationRouteRecord): void {
  for (const key of ["id", "controller_session", "message_id", "request_text", "canonical_target", "route", "target_id", "created_at"] as const) {
    if (previous[key] !== next[key]) conflict();
  }
  if (previous.receipt && !isDeepStrictEqual(previous.receipt, next.receipt)) conflict();
  if (previous.state !== "reserved" && next.state === "reserved") conflict();
}

/** Select once after preflight; crashes and uncertain delivery never authorize a different route.
 * This journal does not replace the selected provider's stable-message-ID dispatch ledger.
 */
export function createConversationRouteStore(storeDir: string, locks: { acquire(lockPath: string): () => void },
  options: { now?(): Date } = {}): ConversationRouteStore {
  const now = options.now ?? (() => new Date());
  const repository = createNativeRecordRepository<ConversationRouteRecord>({ storeDir, directory: "conversation-routes",
    prefix: "conversation-route:", acquire: locks.acquire, assert: assertRecord, assertUpdate });
  const load = (input: ConversationRouteInput) => {
    assertInput(input);
    const found = repository.load(conversationRouteId(input.controllerSession, input.messageId));
    if (found) assertMatches(found, input);
    return found;
  };
  const update = (input: ConversationRouteInput, choice: ConversationRouteChoice,
    operation: (record: ConversationRouteRecord) => ConversationRouteRecord) => {
    assertInput(input); assertChoice(choice);
    return repository.withLock(conversationRouteId(input.controllerSession, input.messageId), () => {
      const current = load(input);
      if (!current) throw new ConversationRouteError("conversation_route_missing", "Conversation route must be reserved before recording an outcome");
      if (current.route !== choice.route || current.target_id !== choice.targetId) conflict();
      const next = operation(current);
      return next === current ? current : repository.save({ ...next, updated_at: now().toISOString() }, current.revision);
    });
  };
  return {
    load,
    reserve(input, choice) {
      assertInput(input); assertChoice(choice);
      return repository.withLock(conversationRouteId(input.controllerSession, input.messageId), () => {
        const previous = load(input);
        if (previous) return { record: previous, created: false };
        const date = now().toISOString();
        return { created: true, record: repository.save({ schema: "agent-knock-knock/conversation-route", version: 1,
          revision: 1, id: conversationRouteId(input.controllerSession, input.messageId), controller_session: input.controllerSession,
          message_id: input.messageId, request_text: input.requestText, canonical_target: input.canonicalTarget,
          route: choice.route, target_id: choice.targetId, created_at: date, updated_at: date, state: "reserved" }, null) };
      });
    },
    recordReceipt(input, choice, receipt) {
      if (!recordValue(receipt)) invalid("Conversation route receipt must be an object");
      const saved: unknown = JSON.parse(JSON.stringify(receipt));
      if (!recordValue(saved)) invalid("Conversation route receipt must serialize to an object");
      return update(input, choice, current => {
        if (current.receipt) { if (!isDeepStrictEqual(current.receipt, saved)) conflict(); return current; }
        return { ...current, state: "recorded", receipt: saved };
      });
    },
    markUncertain(input, choice, errorCode) {
      if (errorCode !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(errorCode)) invalid("Invalid conversation route error code");
      return update(input, choice, current => current.state !== "reserved" ? current :
        { ...current, state: "uncertain", ...(errorCode ? { error_code: errorCode } : {}) });
    }
  };
}
