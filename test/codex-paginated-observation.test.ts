import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CodexAppServerReadError,
  type CodexAppServerItemEntry,
  type CodexAppServerListOptions,
  type CodexAppServerPage,
  type CodexAppServerThread,
  type CodexAppServerThreadItem,
  type CodexAppServerTurn
} from "../src/codex-app-server-read-client.js";
import {
  CodexLegacyThreadHistoryError,
  captureCodexPaginatedTaskAnchor,
  readCodexPaginatedTaskSnapshot
} from "../src/codex-paginated-observation.js";
import type { CodexPaginatedThreadBinding } from "../src/codex-paginated-thread-facts.js";

const HOME = "/tmp/akk-codex-observation-fixture";
const THREAD = "01a0e958-4bb1-7fc3-8649-e153fd90faae";
const NOW = new Date("2026-09-29T03:00:00.000Z");
const REQUEST = "Check UniPat AI";
const HASH = createHash("sha256").update(REQUEST).digest("hex");
const BINDING: CodexPaginatedThreadBinding = {
  codexHome: HOME, threadId: THREAD, agentVersion: "0.158.0", serverVersion: "0.158.0",
  processUuid: "fixture-process", processBirth: "fixture-birth", pid: 34744,
  observedAt: NOW.toISOString()
};

test("reads all item pages through the exact descending turn boundary and closes its reader", async () => {
  const fixture = new ReaderFixture({
    turns: new Map([
      ["", page([turn("latest"), turn("middle")], "turn-page-2")],
      ["turn-page-2", page([turn("boundary"), turn("older")], "unused-page")]
    ]),
    items: new Map([
      ["latest:", page([entry("latest", user("input", REQUEST))], "items-page-2")],
      ["latest:items-page-2", page([entry("latest", agent("result", "Done"))])],
      ["middle:", page([])],
      ["boundary:", page([entry("boundary", user("baseline", "Old request"))])]
    ])
  });
  const snapshot = await read(fixture, "boundary");
  assert.equal(snapshot.completeToBoundary, true);
  assert.deepEqual(snapshot.turns.map((value) => value.id), ["latest", "middle", "boundary"]);
  assert.deepEqual(snapshot.turns[0]!.items.map((value) => value.id), ["input", "result"]);
  assert.equal(snapshot.turns.every((value) => value.itemsView === "full"), true);
  assert.deepEqual(fixture.turnCalls.map((value) => value.cursor), [undefined, "turn-page-2"]);
  assert.equal(fixture.turnCalls.every((value) => value.sortDirection === "desc" && value.itemsView === "notLoaded"), true);
  assert.equal(fixture.itemCalls.every((value) => value.sortDirection === "asc" && value.turnId !== "older"), true);
  assert.deepEqual(fixture.connections, [{ codexHome: HOME, expectedServerVersion: "0.158.0" }]);
  assert.equal(fixture.closed, true);
});

test("accepts only the exact idle unmaterialized error as an empty pre-submission baseline", async () => {
  const fresh = new ReaderFixture({ turnError: unmaterialized() });
  const snapshot = await read(fresh);
  assert.deepEqual(snapshot.turns, []);
  assert.equal(snapshot.completeToBoundary, true);
  assert.equal(fresh.itemCalls.length, 0);
  assert.equal(fresh.closed, true);

  const baseline = new ReaderFixture({ turnError: unmaterialized() });
  const anchor = await capture(baseline, HASH);
  assert.equal(anchor?.origin, "user_explicit_send");
  assert.equal(anchor?.baseline_latest_turn_id, undefined);
  assert.equal(baseline.closed, true);
  for (const fixture of [
    new ReaderFixture({ turnError: unmaterialized(), thread: thread({ type: "active", activeFlags: [] }) }),
    new ReaderFixture({ turnError: unmaterialized("different-thread") }),
    new ReaderFixture({ turnError: new CodexAppServerReadError("rpc_error", "Fixture", -32601, "thread/items/list is not supported yet") })
  ]) {
    await assert.rejects(read(fixture), CodexAppServerReadError);
    assert.equal(fixture.closed, true);
  }
  const bound = new ReaderFixture({ turnError: unmaterialized() });
  await assert.rejects(read(bound, "already-accepted"), CodexAppServerReadError);
  assert.equal(bound.closed, true);
});

test("rejects repeated turn identities and cursors instead of accepting an incomplete task history", async () => {
  for (const [turns, message] of [
    [new Map([["", page([turn("same")], "next")], ["next", page([turn("same")])]]), /repeated an item/u],
    [new Map([["", page([turn("first")], "next")], ["next", page([turn("second")], "next")]]), /repeated a cursor/u]
  ] as const) {
    const fixture = new ReaderFixture({ turns });
    await assert.rejects(read(fixture, "boundary"), message);
    assert.equal(fixture.closed, true);
  }
});

test("rejects repeated item identities, item cursors and items belonging to another turn", async () => {
  for (const [items, message] of [
    [new Map([["latest:", page([entry("latest", user("same", REQUEST))], "next")],
      ["latest:next", page([entry("latest", agent("same", "Done"))])]]), /item identity/u],
    [new Map([["latest:", page([entry("latest", user("first", REQUEST))], "next")],
      ["latest:next", page([entry("latest", agent("second", "Done"))], "next")]]), /repeated a cursor/u],
    [new Map([["latest:", page([entry("another-turn", user("foreign", REQUEST))])]]), /item identity/u]
  ] as const) {
    const fixture = new ReaderFixture({ turns: new Map([["", page([turn("latest")])]]), items });
    await assert.rejects(read(fixture), message);
    assert.equal(fixture.closed, true);
  }
});

test("marks an absent boundary incomplete and refuses history beyond the bounded window", async () => {
  const missing = new ReaderFixture({ turns: new Map([["", page([turn("latest")])]]) });
  assert.equal((await read(missing, "missing-turn")).completeToBoundary, false);
  assert.equal(missing.closed, true);
  const pages = new Map<string, CodexAppServerPage<CodexAppServerTurn>>();
  for (let index = 0; index < 7; index += 1) {
    pages.set(index === 0 ? "" : `page-${index}`,
      page(Array.from({ length: 20 }, (_, offset) => turn(`turn-${index * 20 + offset}`)), `page-${index + 1}`));
  }
  const bounded = new ReaderFixture({ turns: pages });
  await assert.rejects(read(bounded, "never-present"), /bounded observation window/u);
  assert.equal(bounded.closed, true);
});

test("captures only the latest active task while explicit send preserves the latest baseline", async () => {
  const active = new ReaderFixture({
    turns: new Map([["", page([turn("active", "inProgress"), turn("older")])]]),
    items: new Map([["active:", page([entry("active", user("request", REQUEST))])]])
  });
  const anchor = await capture(active);
  assert.equal(anchor?.origin, "active_task");
  assert.equal(anchor?.turn_id, "active");
  assert.equal(anchor?.request_hash, HASH);
  assert.equal(anchor?.baseline_latest_turn_id, undefined);
  assert.equal(active.closed, true);
  assert.equal(anchor?.codex_version, "0.158.0");
  assert.equal(Object.hasOwn(anchor!, "backend_version"), false);

  const oldActive = new ReaderFixture({ turns: new Map([["", page([turn("completed"), turn("old-active", "inProgress")])]]) });
  assert.equal(await capture(oldActive), undefined);
  assert.equal(oldActive.itemCalls.length, 0);
  const explicit = new ReaderFixture({ turns: new Map([["", page([turn("completed")])]]) });
  assert.equal((await capture(explicit, HASH))?.baseline_latest_turn_id, "completed");
  assert.equal(explicit.itemCalls.length, 0);

  const ambiguous = new ReaderFixture({
    turns: new Map([["", page([turn("active", "inProgress")])]]),
    items: new Map([["active:", page([entry("active", { id: "mixed", type: "userMessage",
      content: [{ type: "text", text: REQUEST }, { type: "image", url: "fixture" }] })])]])
  });
  await assert.rejects(capture(ambiguous), /no unique text request/u);
  assert.equal(ambiguous.closed, true);
});

test("mixed-version capture preserves the physical frontend and pins both capture modes to the actual backend", async () => {
  const binding: CodexPaginatedThreadBinding = {
    ...BINDING, agentVersion: "0.159.0", serverVersion: "0.159.2"
  };
  for (const requestHash of [undefined, HASH]) {
    const fixture = new ReaderFixture({
      serverVersion: "0.159.2",
      turns: new Map([["", page([turn("latest", "inProgress")])]]),
      items: new Map([["latest:", page([entry("latest", user("request", REQUEST))])]])
    });
    const anchor = await capture(fixture, requestHash, binding);
    assert.ok(anchor);
    assert.equal(anchor.codex_version, "0.159.0");
    assert.equal(anchor.backend_version, "0.159.2");
    assert.equal(anchor.request_hash, HASH);
    assert.equal(anchor.origin, requestHash ? "user_explicit_send" : "active_task");
    assert.equal(anchor.turn_id, requestHash ? undefined : "latest");
    assert.equal(anchor.baseline_latest_turn_id, requestHash ? "latest" : undefined);
    assert.deepEqual(fixture.connections, [{ codexHome: HOME, expectedServerVersion: "0.159.2" }]);
    assert.equal(fixture.closed, true);
  }

  const sameVersion = new ReaderFixture({ serverVersion: "0.159.0", turns: new Map([["", page([])]]) });
  const anchor = await capture(sameVersion, HASH, { ...binding, serverVersion: "0.159.0" });
  assert.ok(anchor);
  assert.equal(anchor.codex_version, "0.159.0");
  assert.equal(Object.hasOwn(anchor, "backend_version"), false);
  assert.equal(sameVersion.closed, true);
});

test("mixed-version snapshots retain the actual backend while historical thread cliVersion remains independent", async () => {
  const fixture = new ReaderFixture({
    serverVersion: "0.159.2",
    turns: new Map([["", page([turn("accepted"), turn("baseline")])]]),
    items: new Map([["accepted:", page([
      entry("accepted", user("input", REQUEST)), entry("accepted", agent("result", "Done"))
    ])]])
  });
  const snapshot = await read(fixture, "baseline", "0.159.2");
  assert.equal(snapshot.serverVersion, "0.159.2");
  assert.equal(snapshot.thread.cliVersion, "0.158.0");
  assert.equal(snapshot.completeToBoundary, true);
  assert.deepEqual(snapshot.turns[0]!.items.map((item) => item.id), ["input", "result"]);
  assert.deepEqual(fixture.connections, [{ codexHome: HOME, expectedServerVersion: "0.159.2" }]);
  assert.equal(fixture.closed, true);
});

test("a refused backend connection does not retry capture or observation against the physical frontend version", async () => {
  const mismatch = new CodexAppServerReadError("incompatible_server", "Fixture backend version changed");
  for (const operation of ["capture", "snapshot"] as const) {
    const fixture = new ReaderFixture({ connectError: mismatch });
    const result = operation === "capture"
      ? capture(fixture, HASH, { ...BINDING, agentVersion: "0.159.0", serverVersion: "0.159.2" })
      : read(fixture, "accepted", "0.159.2");
    await assert.rejects(result, (error) => error === mismatch);
    assert.deepEqual(fixture.connections, [{ codexHome: HOME, expectedServerVersion: "0.159.2" }]);
    assert.equal(fixture.turnCalls.length, 0);
    assert.equal(fixture.itemCalls.length, 0);
  }
});

test("legacy foreground capture preserves its exact thread identity for the legacy reader", async () => {
  const fixture = new ReaderFixture({ thread: { ...thread(), historyMode: "legacy" } });
  await assert.rejects(capture(fixture, HASH), (error) =>
    error instanceof CodexLegacyThreadHistoryError && error.threadId === THREAD);
  assert.equal(fixture.turnCalls.length, 0);
  assert.equal(fixture.closed, true);
});

function read(fixture: ReaderFixture, boundaryTurnId?: string, serverVersion = "0.158.0") {
  return readCodexPaginatedTaskSnapshot({ codexHome: HOME, serverVersion, threadId: THREAD,
    ...(boundaryTurnId ? { boundaryTurnId } : {}), connect: fixture.connect });
}
function capture(fixture: ReaderFixture, requestHash?: string, binding = BINDING) {
  return captureCodexPaginatedTaskAnchor({ binding, now: NOW, requestHash, connect: fixture.connect });
}
function thread(status: CodexAppServerThread["status"] = { type: "idle" }): CodexAppServerThread {
  return { id: THREAD, sessionId: THREAD, cwd: "/tmp/project", historyMode: "paginated", cliVersion: "0.158.0",
    originator: "codex-tui", source: "vscode", status, turns: [] };
}
function turn(id: string, status: CodexAppServerTurn["status"] = "completed"): CodexAppServerTurn {
  return { id, status, items: [], itemsView: "notLoaded", error: null,
    startedAt: 1_790_643_600, completedAt: null, durationMs: null };
}
function user(id: string, text: string): CodexAppServerThreadItem {
  return { id, type: "userMessage", content: [{ type: "text", text, textElements: [] }] };
}
function agent(id: string, text: string): CodexAppServerThreadItem {
  return { id, type: "agentMessage", text, phase: "final_answer" };
}
function entry(turnId: string, item: CodexAppServerThreadItem): CodexAppServerItemEntry {
  return { turnId, item, startedAtMs: null, completedAtMs: null };
}
function page<T>(data: T[], nextCursor: string | null = null): CodexAppServerPage<T> {
  return { data, nextCursor, backwardsCursor: null };
}
function unmaterialized(id = THREAD): CodexAppServerReadError {
  return new CodexAppServerReadError("rpc_error", "Fixture unmaterialized", -32600,
    `thread ${id} is not materialized yet; thread/turns/list is unavailable before first user message`);
}

class ReaderFixture {
  readonly metadata = { codexHome: HOME, serverVersion: "0.158.0", socketPath: `${HOME}/control.sock`, platformFamily: "unix", platformOs: "macos" };
  readonly connections: { codexHome: string; expectedServerVersion: string }[] = [];
  readonly turnCalls: (CodexAppServerListOptions & { itemsView?: "notLoaded" | "summary" | "full" })[] = [];
  readonly itemCalls: (CodexAppServerListOptions & { turnId?: string })[] = [];
  closed = false;
  constructor(private readonly options: {
    serverVersion?: string;
    connectError?: Error;
    thread?: CodexAppServerThread;
    turns?: ReadonlyMap<string, CodexAppServerPage<CodexAppServerTurn>>;
    items?: ReadonlyMap<string, CodexAppServerPage<CodexAppServerItemEntry>>;
    turnError?: Error;
  } = {}) {
    this.metadata.serverVersion = options.serverVersion ?? "0.158.0";
  }
  connect = async (options: { codexHome: string; expectedServerVersion: string }) => {
    this.connections.push(options);
    if (this.options.connectError) throw this.options.connectError;
    return this;
  };
  async readThread(id: string): Promise<CodexAppServerThread> {
    assert.equal(id, THREAD);
    return this.options.thread ?? thread();
  }
  async listTurns(options: CodexAppServerListOptions & { itemsView?: "notLoaded" | "summary" | "full" }) {
    this.turnCalls.push(options);
    if (this.options.turnError) throw this.options.turnError;
    const result = this.options.turns?.get(options.cursor ?? "");
    if (!result) throw new Error("Unexpected turn page");
    return result;
  }
  async listItems(options: CodexAppServerListOptions & { turnId?: string }) {
    this.itemCalls.push(options);
    return this.options.items?.get(`${options.turnId}:${options.cursor ?? ""}`) ?? page<CodexAppServerItemEntry>([]);
  }
  close() { this.closed = true; }
}
