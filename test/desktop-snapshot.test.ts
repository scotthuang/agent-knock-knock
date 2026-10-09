import assert from "node:assert/strict";
import test from "node:test";
import { desktopUserMessageText, findDesktopSubmission, reduceDesktopSnapshot } from "../src/desktop-snapshot.js";

const identity = { threadId: "thread-one", ownerClientId: "owner-one", revision: 7 };
const user = (id = "user-one", clientId = "client-message") => ({ id, type: "userMessage", clientId,
  content: [{ type: "text", text: "exact prompt", text_elements: [] }] });
const turn = (turnId = "turn-one", overrides: Record<string, unknown> = {}) => ({ turnId, status: "completed",
  items: [user(), { id: "reply-one", type: "agentMessage", text: "done", phase: "final_answer" }], ...overrides });
function state(overrides: Record<string, unknown> = {}) {
  return { id: identity.threadId, hostId: "local", mode: "default", resumeState: "resumed",
    threadRuntimeStatus: { type: "idle" }, requests: [], turns: [turn()], ...overrides };
}
function canonical(turns: unknown[], exhausted = true) {
  return { kind: "canonical", history: { entitiesByKey: Object.fromEntries(turns.map((t, i) => [`key-${i}`, t])),
    islands: [{ entries: turns.map((_, i) => ({ value: `key-${i}` })), newerBoundary: { status: exhausted ? "exhausted" : "unknown" } }] } };
}

test("Desktop snapshot merges exact canonical/live turn identities without losing user correlation", () => {
  const snapshot = reduceDesktopSnapshot(state({
    turnHistory: canonical([turn("turn-one", { status: "inProgress", items: [user()] })]),
    turns: [turn("turn-one", { items: [{ id: "reply-one", type: "agentMessage", text: "done", phase: "final_answer" }] })]
  }), identity);
  assert.equal(snapshot.canSend, true);
  assert.equal(snapshot.latestTurnId, "turn-one");
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].items.length, 2);
  assert.equal(snapshot.turns[0].itemsComplete, true);
  const found = findDesktopSubmission(snapshot, "client-message", "exact prompt");
  assert.equal(found?.turn.turnId, "turn-one");
  assert.equal(desktopUserMessageText(found!.item), "exact prompt");
  assert.equal(findDesktopSubmission(snapshot, "client-message", "different prompt"), null);
  assert.equal("raw" in snapshot, false);
});

test("Desktop snapshot projection whitelists identity even when caller passes a larger options object", () => {
  const extendedIdentity = { ...identity, prompt: "PRIVATE_PROMPT", callbackRoute: { secret: "PRIVATE_ROUTE" },
    beforeDispatch: async () => {} };
  const snapshot = reduceDesktopSnapshot(state(), extendedIdentity);
  assert.deepEqual(snapshot, reduceDesktopSnapshot(state(), identity));
  assert.doesNotThrow(() => structuredClone(snapshot));
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|beforeDispatch|callbackRoute/u);
});

test("Desktop snapshot fails closed on unknown tail, pending requests, unconfirmed receipts, and unknown runtime", () => {
  for (const [overrides, reason] of [
    [{ turnHistory: canonical([turn()], false), turns: [] }, "unknown_history_tail"],
    [{ requests: [{ id: "approval", method: "item/commandExecution/requestApproval" }] }, "pending_desktop_request"],
    [{ requests: [{ id: "new-request", method: "future/interaction" }] }, "pending_desktop_request"],
    [{ requests: [null] }, "pending_desktop_request"],
    [{ unconfirmedTurnSubmissions: [{ terminal: true }] }, "unconfirmed_submission"],
    [{ threadRuntimeStatus: { type: "future-status" } }, "runtime_not_idle"],
    [{ threadGoal: { status: "active" } }, "active_thread_goal"],
    [{ turns: [turn("turn-one", { status: "future-status" })] }, "nonterminal_or_unknown_turn"],
    [{ turns: [{ turnId: null, status: "inProgress", items: [] }] }, "unidentified_turn"],
    [{ mode: "durable" }, "unsupported_thread_mode"]
  ] as const) {
    const snapshot = reduceDesktopSnapshot(state(overrides), identity);
    assert.equal(snapshot.canSend, false);
    assert.equal(snapshot.idleBlockedReason, reason);
  }
  const unknown = reduceDesktopSnapshot(state({ requests: [{ method: "future/request", params: { secret: "not projected" } }] }), identity);
  assert.deepEqual(unknown.pendingRequests, [{ kind: "unknown", method: "future/request" }]);
});

test("Desktop partial items never become complete just because an overlay has terminal status", () => {
  const incomplete = turn("turn-one", { itemsPagination: { hasLoadedOldest: false, isLoadingOlder: false, olderCursor: "older" } });
  const snapshot = reduceDesktopSnapshot(state({ turnHistory: canonical([incomplete]), turns: [turn()] }), identity);
  assert.equal(snapshot.turns[0].itemsComplete, false);
  const reconnect = reduceDesktopSnapshot(state({ turns: [turn("turn-one", { itemsPagination: {
    hasLoadedOldest: true, isLoadingOlder: false, olderCursor: null, reconnect: { stopItemId: "gap" }
  } })] }), identity);
  assert.equal(reconnect.turns[0].itemsComplete, false);
});

test("Desktop identity conflicts and incomplete canonical references are rejected", () => {
  for (const raw of [state({ id: "different" }), state({ hostId: "remote" }),
    state({ turnHistory: { kind: "canonical", history: { entitiesByKey: {}, islands: [{ entries: [{ value: "missing" }] }] } } }),
    state({ turnHistory: canonical([turn()]), turns: [turn("turn-one", { status: "failed" })] }),
    state({ turnHistory: canonical([turn()]), turns: [turn("turn-one", { items: [user("user-one", "someone-else")] })] })]) {
    assert.throws(() => reduceDesktopSnapshot(raw, identity));
  }
});

test("Desktop submission proof requires one exact message across all turns, not latest-turn guessing", () => {
  const snapshot = reduceDesktopSnapshot(state({ turns: [turn(), turn("later-turn", {
    items: [{ id: "other-user", type: "userMessage", clientId: "someone-else", content: [{ type: "text", text: "later" }] }]
  })] }), identity);
  assert.equal(snapshot.latestTurnId, "later-turn");
  assert.equal(findDesktopSubmission(snapshot, "client-message", "exact prompt")?.turn.turnId, "turn-one");
  const duplicate = reduceDesktopSnapshot(state({ turns: [turn(), turn("other-turn", { items: [user("other-id")] })] }), identity);
  assert.equal(findDesktopSubmission(duplicate, "client-message", "exact prompt"), null);
  assert.equal(desktopUserMessageText({ ...user(), content: [{ type: "text", text: "exact prompt" }, { type: "image" }] }), null);
});

test("Desktop submission proof rejects incomplete or mixed human/AKK turns after the idle preflight", () => {
  for (const extra of [user("human-user", "human-message"),
    { id: "steering", type: "steeringUserMessage", serverClientUserMessageId: "client-message", status: "accepted" },
    { id: "steered", type: "steered" }]) {
    const snapshot = reduceDesktopSnapshot(state({ turns: [turn("turn-one", { items: [user(), extra] })] }), identity);
    assert.equal(findDesktopSubmission(snapshot, "client-message", "exact prompt"), null);
  }
  const incomplete = reduceDesktopSnapshot(state({ turns: [turn("turn-one", {
    itemsPagination: { hasLoadedOldest: true, isLoadingOlder: false, olderCursor: null, evicted: true }
  })] }), identity);
  assert.equal(incomplete.turns[0].itemsComplete, false);
  assert.equal(findDesktopSubmission(incomplete, "client-message", "exact prompt"), null);
});
