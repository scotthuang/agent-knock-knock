import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isNodeError } from "./durable-json-file.js";
import { ensureDir } from "./store.js";
import { ConversationRouteError, conversationRouteId, createConversationRouteStore,
  type ConversationRouteChoice, type ConversationRouteInput, type ConversationRouteRecord,
  type ConversationRouteStore } from "./conversation-route-store.js";

/** Resolve aliases even before the configured directory itself exists. */
function canonicalPath(directory: string): string {
  let current = path.resolve(directory);
  const suffix: string[] = [];
  while (true) {
    try { return path.join(fs.realpathSync(current), ...suffix); }
    catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function privateDirectory(directory: string): void {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      process.getuid && stat.uid !== process.getuid()) {
      throw new Error("Conversation routing runtime must be an owner-private real directory");
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    ensureDir(directory);
  }
}

function reconcileRecords(legacy?: ConversationRouteRecord, current?: ConversationRouteRecord): ConversationRouteRecord | undefined {
  if (!legacy || !current) return legacy ?? current;
  const immutable = ["id", "controller_session", "message_id", "request_text", "canonical_target", "route", "target_id"] as const;
  if (immutable.some(key => legacy[key] !== current[key]) ||
    legacy.receipt !== undefined && current.receipt !== undefined && !isDeepStrictEqual(legacy.receipt, current.receipt)) {
    throw new ConversationRouteError("conversation_route_conflict", "Managed Store and runtime journals disagree on this message's immutable route or receipt");
  }
  if (legacy.receipt) return legacy;
  if (current.receipt || current.state === "uncertain") return current;
  return legacy.state === "uncertain" ? legacy : current;
}

const choiceOf = (record: ConversationRouteRecord): ConversationRouteChoice => ({ route: record.route, targetId: record.target_id });

/** New reservations never acquire the managed Store writer lease. Existing development
 * journals remain read-only authority; migration preserves their provider and outcome.
 * Writers using this wrapper share a message lock. Older binaries that write only the
 * legacy journal are not coordinated; any observed disagreement fails closed.
 */
export function createConversationRuntimeRouteStore(storeDir: string, runtimeDir: string,
  locks: { acquire(lockPath: string): () => void }, options: { now?(): Date } = {}): ConversationRouteStore {
  const runtimeRoot = canonicalPath(runtimeDir);
  const routingRoot = path.join(runtimeRoot, "conversation-routing");
  const scope = path.join(routingRoot, createHash("sha256").update(canonicalPath(storeDir)).digest("hex"));
  const legacy = createConversationRouteStore(storeDir, locks, options);
  const current = createConversationRouteStore(path.join(scope, "state"), locks, options);
  const read = (input: ConversationRouteInput) => reconcileRecords(legacy.load(input), current.load(input));
  const locked = <T>(input: ConversationRouteInput, action: () => T): T => {
    const id = conversationRouteId(input.controllerSession, input.messageId);
    for (const directory of [runtimeRoot, routingRoot, scope]) privateDirectory(directory);
    const release = locks.acquire(path.join(scope, `${id}.lock`));
    try { return action(); } finally { release(); }
  };
  const copyPin = (input: ConversationRouteInput, record: ConversationRouteRecord): void => {
    const choice = choiceOf(record);
    current.reserve(input, choice);
    read(input); // Never overwrite a conflicting reservation or a newly observed legacy outcome.
    if (record.receipt) current.recordReceipt(input, choice, record.receipt);
    else if (record.state === "uncertain") current.markUncertain(input, choice, record.error_code);
  };
  const update = (input: ConversationRouteInput, action: () => ConversationRouteRecord): ConversationRouteRecord => locked(input, () => {
    const record = read(input);
    if (record) copyPin(input, record);
    const result = action();
    read(input);
    return result;
  });
  return {
    load: input => locked(input, () => {
      const record = read(input);
      if (record && !record.receipt) copyPin(input, record);
      return read(input);
    }),
    reserve: (input, choice) => locked(input, () => {
      const previous = read(input);
      if (previous) {
        if (!previous.receipt) copyPin(input, previous);
        return { record: read(input)!, created: false };
      }
      const result = current.reserve(input, choice);
      return { record: read(input)!, created: result.created };
    }),
    recordReceipt: (input, choice, receipt) => update(input, () => current.recordReceipt(input, choice, receipt)),
    markUncertain: (input, choice, errorCode) => update(input, () => current.markUncertain(input, choice, errorCode))
  };
}
