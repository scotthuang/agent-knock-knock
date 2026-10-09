import { DesktopIpcError, type DesktopSnapshot, type DesktopTurn, type DesktopTurnItem,
  type DesktopPendingRequest, type DesktopTurnStatus } from "./desktop-types.js";

export function desktopRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(message: string): never { throw new DesktopIpcError("invalid_response", message); }
function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length || value.length > 512) invalid(`Invalid Desktop ${name}`);
  return value;
}
const statuses = new Set(["inProgress", "completed", "failed", "interrupted"]);
const approvals = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval"]);
const questions = new Set(["item/tool/requestUserInput", "item/tool/requestOptionPicker",
  "mcpServer/elicitation/request", "item/plan/requestImplementation"]);

function item(value: unknown): DesktopTurnItem {
  if (!desktopRecord(value)) invalid("Invalid Desktop turn item");
  const result: DesktopTurnItem = { id: identifier(value.id, "item id"), type: identifier(value.type, "item type") };
  for (const key of ["text", "status"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") invalid(`Invalid Desktop item ${key}`);
    if (typeof value[key] === "string") result[key] = value[key];
  }
  for (const key of ["clientId", "phase", "serverUserMessageId", "serverClientUserMessageId"] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") invalid(`Invalid Desktop item ${key}`);
    if (value[key] !== undefined) result[key] = value[key] as string | null;
  }
  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) invalid("Invalid Desktop message content");
    result.content = value.content.map((part) => {
      if (!desktopRecord(part)) invalid("Invalid Desktop message content part");
      const type = identifier(part.type, "content type");
      if (type === "text" && typeof part.text !== "string") invalid("Invalid Desktop user message text");
      return { type, ...(typeof part.text === "string" ? { text: part.text } : {}) };
    });
  }
  if (result.type === "userMessage" && !result.content) invalid("Desktop user message has no content");
  if (result.type === "agentMessage" && typeof result.text !== "string") invalid("Desktop agent message has no text");
  return result;
}

function parseTurn(value: unknown): DesktopTurn {
  if (!desktopRecord(value) || !Array.isArray(value.items)) invalid("Invalid Desktop turn shape");
  const result: DesktopTurn = {
    turnId: identifier(value.turnId, "turn id"),
    status: statuses.has(String(value.status)) ? value.status as DesktopTurnStatus : "unknown",
    items: value.items.map(item),
    itemsComplete: true
  };
  const ids = new Set<string>();
  for (const entry of result.items) {
    if (ids.has(entry.id)) invalid("Duplicate Desktop item id in one turn");
    ids.add(entry.id);
  }
  if (value.itemsView !== undefined && value.itemsView !== "full") result.itemsComplete = false;
  if (value.itemsPagination !== undefined && value.itemsPagination !== null) {
    const p = value.itemsPagination;
    result.itemsComplete = result.itemsComplete && desktopRecord(p) && p.hasLoadedOldest === true && p.isLoadingOlder === false
      && p.olderCursor == null && p.reconnect == null && p.summaryItemIds == null && p.evicted !== true;
  }
  if (desktopRecord(value.error) && typeof value.error.message === "string") result.error = value.error.message;
  return result;
}

/** Live turns overlay canonical history by identity, without dropping canonical items. */
function overlayTurn(canonical: DesktopTurn, live: DesktopTurn): DesktopTurn {
  if (canonical.status !== live.status && canonical.status !== "inProgress") {
    invalid("Conflicting Desktop terminal turn status");
  }
  const items = new Map(canonical.items.map((entry) => [entry.id, entry]));
  for (const entry of live.items) {
    const previous = items.get(entry.id);
    if (previous && (previous.type !== entry.type || (entry.type === "userMessage"
      && (previous.clientId !== entry.clientId || JSON.stringify(previous.content) !== JSON.stringify(entry.content))))) {
      invalid("Conflicting Desktop item identity");
    }
    items.set(entry.id, entry);
  }
  return { ...canonical, ...live, items: [...items.values()], itemsComplete: canonical.itemsComplete && live.itemsComplete };
}

function pendingRequest(value: unknown): DesktopPendingRequest {
  if (!desktopRecord(value)) return { kind: "unknown" };
  const method = typeof value.method === "string" ? value.method : undefined;
  return {
    kind: method && approvals.has(method) ? "approval" : method && questions.has(method) ? "user_input" : "unknown",
    ...(method ? { method } : {}),
    ...(typeof value.id === "string" || typeof value.id === "number" ? { requestId: String(value.id) } : {}),
    ...(desktopRecord(value.params) && typeof value.params.turnId === "string" ? { turnId: value.params.turnId } : {})
  };
}

function canonicalHistory(raw: unknown): { turns: unknown[]; tailKnown: boolean } {
  if (raw == null) return { turns: [], tailKnown: true };
  if (!desktopRecord(raw)) invalid("Invalid Desktop turn history");
  if (raw.kind === "legacy") return { turns: [], tailKnown: true };
  if (raw.kind !== "canonical") invalid("Unknown Desktop history representation");
  const history = raw.history;
  if (!desktopRecord(history) || !desktopRecord(history.entitiesByKey) || !Array.isArray(history.islands)) {
    invalid("Invalid Desktop canonical history");
  }
  const turns: unknown[] = [];
  for (const island of history.islands) {
    if (!desktopRecord(island) || !Array.isArray(island.entries)) invalid("Invalid Desktop history island");
    for (const entry of island.entries) {
      if (!desktopRecord(entry) || typeof entry.value !== "string" || !Object.hasOwn(history.entitiesByKey, entry.value)) {
        invalid("Missing Desktop canonical turn entity");
      }
      turns.push(history.entitiesByKey[entry.value]);
    }
  }
  const last = history.islands.at(-1);
  const tailKnown = history.islands.length === 0 ? history.isComplete === true
    : desktopRecord(last) && desktopRecord(last.newerBoundary) && last.newerBoundary.status === "exhausted";
  return { turns, tailKnown };
}

function mergeHistoryTurns(canonical: unknown[], live: unknown[]): {
  turns: DesktopTurn[]; tailId: string | null; unidentifiedTurn: boolean;
} {
  const turns = new Map<string, DesktopTurn>();
  let unidentifiedTurn = false, tailId: string | null = null;
  const readTurn = (value: unknown): DesktopTurn | null => {
    if (desktopRecord(value) && value.turnId == null) { unidentifiedTurn = true; return null; }
    return parseTurn(value);
  };
  for (const value of canonical) {
    const turn = readTurn(value);
    if (!turn) continue;
    if (turns.has(turn.turnId)) invalid("Duplicate Desktop canonical turn identity");
    turns.set(turn.turnId, turn); tailId = turn.turnId;
  }
  const liveIds = new Set<string>();
  for (const value of live) {
    const turn = readTurn(value);
    if (!turn) continue;
    if (liveIds.has(turn.turnId)) invalid("Duplicate Desktop live turn identity");
    liveIds.add(turn.turnId);
    const previous = turns.get(turn.turnId);
    turns.set(turn.turnId, previous ? overlayTurn(previous, turn) : turn);
    // An overlay of an older canonical turn must not move the known tail backwards.
    if (!previous) tailId = turn.turnId;
  }
  return { turns: [...turns.values()], tailId, unidentifiedTurn };
}

function sendBlockedReason(raw: Record<string, unknown>, state: {
  runtimeStatus: DesktopSnapshot["runtimeStatus"]; requests: number; unconfirmed: number;
  unidentifiedTurn: boolean; tailKnown: boolean; turns: DesktopTurn[];
}): string | undefined {
  if (raw.mode !== "default") return "unsupported_thread_mode";
  if (raw.resumeState !== "resumed") return "thread_not_resumed";
  if (state.runtimeStatus !== "idle") return "runtime_not_idle";
  if (desktopRecord(raw.threadGoal) && raw.threadGoal.status === "active") return "active_thread_goal";
  if (state.requests) return "pending_desktop_request";
  if (state.unconfirmed) return "unconfirmed_submission";
  if (state.unidentifiedTurn) return "unidentified_turn";
  if (!state.tailKnown) return "unknown_history_tail";
  if (state.turns.some((turn) => turn.status === "inProgress" || turn.status === "unknown")) return "nonterminal_or_unknown_turn";
  return undefined;
}

type SnapshotIdentity = Pick<DesktopSnapshot, "threadId" | "ownerClientId" | "revision">;
type SnapshotEnvelope = Record<string, unknown> & { turns: unknown[]; requests: unknown[] };

function assertSnapshotEnvelope(raw: unknown, identity: SnapshotIdentity): asserts raw is SnapshotEnvelope {
  if (!desktopRecord(raw) || raw.id !== identity.threadId || raw.hostId !== "local"
    || !Number.isSafeInteger(identity.revision) || identity.revision < 0) invalid("Desktop snapshot identity/revision mismatch");
  if (!Array.isArray(raw.turns) || !Array.isArray(raw.requests)) invalid("Unsupported Desktop snapshot shape");
  if (raw.unconfirmedTurnSubmissions != null && !Array.isArray(raw.unconfirmedTurnSubmissions)) {
    invalid("Unsupported Desktop unconfirmed submissions shape");
  }
}

export function reduceDesktopSnapshot(raw: unknown, identity: SnapshotIdentity): DesktopSnapshot {
  assertSnapshotEnvelope(raw, identity);
  const canonical = canonicalHistory(raw.turnHistory);
  const history = mergeHistoryTurns(canonical.turns, raw.turns);
  const runtime = desktopRecord(raw.threadRuntimeStatus) ? raw.threadRuntimeStatus.type : undefined;
  const runtimeStatus: DesktopSnapshot["runtimeStatus"] = runtime === "idle" || runtime === "active"
    || runtime === "notLoaded" || runtime === "systemError" ? runtime : "unknown";
  const requests = raw.requests.map(pendingRequest);
  const unconfirmed = Array.isArray(raw.unconfirmedTurnSubmissions) ? raw.unconfirmedTurnSubmissions.length : 0;
  const blocked = sendBlockedReason(raw, { ...history, runtimeStatus, requests: requests.length, unconfirmed, tailKnown: canonical.tailKnown });
  return {
    threadId: identity.threadId, ownerClientId: identity.ownerClientId, revision: identity.revision,
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
    ...(typeof raw.mode === "string" ? { mode: raw.mode } : {}),
    ...(typeof raw.originator === "string" ? { originator: raw.originator } : {}),
    ...(typeof raw.resumeState === "string" ? { resumeState: raw.resumeState } : {}),
    runtimeStatus, pendingRequests: requests, pendingRequestCount: requests.length,
    unconfirmedSubmissionCount: unconfirmed, tailKnown: canonical.tailKnown,
    latestTurnId: canonical.tailKnown && !history.unidentifiedTurn ? history.tailId : null,
    turns: history.turns, canSend: blocked === undefined, ...(blocked ? { idleBlockedReason: blocked } : {})
  };
}

/** AKK submits exactly one text input; other content shapes are not an exact submission proof. */
export function desktopUserMessageText(item: DesktopTurnItem): string | null {
  return item.type === "userMessage" && item.content?.length === 1 && item.content[0].type === "text"
    && typeof item.content[0].text === "string" ? item.content[0].text : null;
}

export function findDesktopSubmission(snapshot: DesktopSnapshot, clientUserMessageId: string, prompt: string): {
  turn: DesktopTurn; item: DesktopTurnItem;
} | null {
  const matches = snapshot.turns.flatMap((turn) => turn.items
    .filter((entry) => entry.type === "userMessage" && entry.clientId === clientUserMessageId)
    .map((entry) => ({ turn, item: entry })));
  if (matches.length !== 1) return null;
  const match = matches[0];
  // The native follower API may steer if a human starts a turn after preflight.
  // Do not establish new-task ownership from one matching item in a mixed turn.
  return match.turn.itemsComplete && desktopUserMessageText(match.item) === prompt
    && match.turn.items.filter((entry) => entry.type === "userMessage").length === 1
    && !match.turn.items.some((entry) => entry.type === "steeringUserMessage" || entry.type === "steered") ? match : null;
}
