import test from "node:test";
import assert from "node:assert/strict";
import { DesktopSessionCatalog, mergeDesktopMetadata } from "../src/desktop-session-catalog.js";
import { parseDesktopSidebarMetadata } from "../src/desktop-sidebar-metadata.js";
import { selectDesktopSidebar, DESKTOP_PINNED_SECTION_ID } from "../src/desktop-sidebar-selection.js";
import type { DesktopMetadataBatch, DesktopMetadataRow } from "../src/desktop-metadata-reader.js";

const home = "/fixture/sidebar";
function state(id: string, extra: DesktopMetadataRow = {}) {
  return { id, name: id, title: id, cwd: "/unrelated", archived: 0, source: "cli", updated_at_ms: 1000, ...extra };
}
function batch(rows: DesktopMetadataRow[]): DesktopMetadataBatch {
  return { source: { codexHome: home, database: `${home}/state.sqlite`, kind: "state", status: "ok" }, rows };
}
function globalState() {
  return { "electron-persisted-atom-state": {
    "flat-project-sidebar-preferences-v1": { mode: "project" },
    "sidebar-collapsed-sections-v1": { chats: true, pinned: false },
    "sidebar-project-expanded-v1-codex:test": true,
    "sidebar-project-expanded-v1-codex:game": true,
    "sidebar-project-expanded-v1-codex:avatar": true,
    "sidebar-project-expanded-v1-codex:hidden": false,
    "app-server-pinned-thread-order-v1": ["pinned"]
  }, "local-projects": {
    test: { name: "Test", rootPaths: ["/test"] }, game: { name: "Game", rootPaths: ["/game"] },
    avatar: { name: "Avatar", rootPaths: ["/avatar"] }, hidden: { name: "Hidden", rootPaths: ["/hidden"] }
  }, "project-order": ["test", "game", "avatar", "hidden"], "pinned-thread-ids": ["pinned", "archived"],
  "app-server-migrated-pinned-thread-ids-by-host": { [`local:${home}`]: ["pinned"] },
  "thread-project-assignments": Object.fromEntries([
    ["test-one", "test"], ["test-two", "test"], ["game-one", "game"], ["avatar-one", "avatar"], ["avatar-two", "avatar"],
    ["hidden-one", "hidden"], ["archived", "test"]
  ].map(([id, projectId]) => [id, { projectKind: "local", projectId }])),
  "app-server-projects-migration-by-host": { [`local:${home}`]: { projectsMigrated: true, threadAssignmentsMigrated: false } },
  "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { test: "native-test" } } };
}
function rows() {
  return [state("pinned", { is_pinned: 0, thread_section_id: DESKTOP_PINNED_SECTION_ID, section_position: 100 }),
    ...["test-one", "test-two", "game-one", "avatar-one", "avatar-two", "hidden-one", "other-cli"].map(id => state(id)),
    state("archived", { archived: 1 })];
}

test("Desktop persisted sidebar reconstructs six members while retaining disconnected and CLI-created rows", () => {
  const all = mergeDesktopMetadata([batch(rows())]);
  const layout = parseDesktopSidebarMetadata(globalState(), home);
  const result = selectDesktopSidebar(all.sessions, new Map([[home, layout]]), all.archivedIds);
  assert.equal(result.sidebar.status, "supported");
  assert.deepEqual(result.sessions.map(row => row.threadId), ["pinned", "test-one", "test-two", "game-one", "avatar-one", "avatar-two"]);
  assert.equal(result.sessions[0].sidebar?.section, "pinned");
  assert.equal(result.sessions[1].sidebar?.projectName, "Test");
  assert.equal(result.sessions[1].projectId, null, "unmigrated legacy assignment is valid despite empty SQL project ID");
});

test("archived catalog overlap and migrated unpinned legacy records never reappear", () => {
  const raw = rows().filter(row => row.id !== "pinned");
  raw.push(state("pinned", { thread_section_id: null }));
  const catalog: DesktopMetadataBatch = { source: { kind: "desktop_catalog", codexHome: home, database: "catalog", status: "ok" },
    hosts: { local: "local" }, rows: [{ host_id: "local", thread_id: "archived", display_title: "stale", source_updated_at: 2, source_kind: "cli" }] };
  const all = mergeDesktopMetadata([batch(raw), catalog]);
  const result = selectDesktopSidebar(all.sessions, new Map([[home, parseDesktopSidebarMetadata(globalState(), home)]]), all.archivedIds);
  assert.equal(result.sidebar.status, "supported");
  assert.equal(result.sessions.some(row => ["pinned", "archived"].includes(row.threadId)), false);
});

test("project root membership follows saved paths/hints, explicit exclusions and nested roots", () => {
  const raw: any = globalState();
  raw["local-projects"].nested = { name: "Nested", rootPaths: ["/test/nested"] };
  raw["projectless-thread-ids"] = ["projectless"];
  raw["thread-workspace-root-hints"] = { hinted: "/avatar" };
  raw["thread-project-assignments"].elsewhere = { projectKind: "local", projectId: "hidden" };
  const all = mergeDesktopMetadata([batch([
    state("child", { cwd: "/test/subdir" }), state("nested", { cwd: "/test/nested/work" }),
    state("hinted"), state("projectless", { cwd: "/test" }), state("elsewhere", { cwd: "/test" }),
    state("prefix-collision", { cwd: "/test-other" })
  ])]);
  const layout = parseDesktopSidebarMetadata(raw, home);
  const result = selectDesktopSidebar(all.sessions, new Map([[home, layout]]));
  assert.deepEqual(result.sessions.map(row => [row.threadId, row.sidebar?.projectId]), [["child", "test"], ["hinted", "avatar"], ["nested", "nested"]]);
  assert.equal(result.sidebar.status, "partial");
  assert.match(result.sidebar.limitations.join(" "), /Overlapping project roots/);
});

test("Projects section uses the native threads collapse key while pinned remains separate", () => {
  const raw: any = globalState();
  raw["electron-persisted-atom-state"]["sidebar-collapsed-sections-v1"].threads = true;
  const all = mergeDesktopMetadata([batch(rows())]);
  const result = selectDesktopSidebar(all.sessions, new Map([[home, parseDesktopSidebarMetadata(raw, home)]]), all.archivedIds);
  assert.deepEqual(result.sessions.map(row => row.threadId), ["pinned"]);
  assert.equal(result.sidebar.status, "supported");
});

test("explicit assignment outranks projectless and non-local assignment blocks cwd, while root hints match exactly", () => {
  const raw: any = globalState();
  raw["pinned-thread-ids"] = [];
  raw["thread-project-assignments"] = {
    assigned: { projectKind: "local", projectId: "game" },
    remote: { projectKind: "remote", projectId: "remote-project" }
  };
  raw["projectless-thread-ids"] = ["assigned"];
  raw["thread-workspace-root-hints"] = { "nested-hint": "/avatar/subdir", "exact-hint": "/avatar/" };
  const all = mergeDesktopMetadata([batch([
    state("assigned", { cwd: "/test" }), state("remote", { cwd: "/test" }),
    state("nested-hint"), state("exact-hint"), state("outside")
  ])]);
  const result = selectDesktopSidebar(all.sessions, new Map([[home, parseDesktopSidebarMetadata(raw, home)]]));
  assert.deepEqual(result.sessions.map(row => [row.threadId, row.sidebar?.projectId]), [["assigned", "game"], ["exact-hint", "avatar"]]);
  assert.equal(result.sidebar.status, "partial", "unsupported remote layout remains explicit");
});

test("collapsed pins stay out of project groups and custom section members are not duplicated", () => {
  const raw: any = globalState();
  raw["electron-persisted-atom-state"]["sidebar-collapsed-sections-v1"].pinned = true;
  raw["thread-project-assignments"].pinned = { projectKind: "local", projectId: "test" };
  raw["electron-persisted-atom-state"]["sidebar-custom-sections-v3"] = { account: {
    sections: [{ itemKeys: ["codex:thread:local:test-one"] }]
  } };
  const all = mergeDesktopMetadata([batch(rows())]);
  const result = selectDesktopSidebar(all.sessions, new Map([[home, parseDesktopSidebarMetadata(raw, home)]]), all.archivedIds);
  assert.equal(result.sidebar.status, "partial");
  assert.equal(result.sessions.some(row => row.threadId === "pinned" || row.threadId === "test-one"), false);
});

test("sidebar is an explicit view with bound cursors, preserved full lookup and scoped search", async () => {
  let raw: any = globalState();
  const catalog = new DesktopSessionCatalog({ codexHomes: [home], readMetadata: async () => [batch(rows())],
    readSidebar: async () => parseDesktopSidebarMetadata(raw, home) });
  assert.equal((await catalog.list()).total, 8);
  const first = await catalog.list({ view: "sidebar", limit: 2 });
  assert.equal(first.total, 6); assert.equal(first.historyTotal, 8);
  const second = await catalog.list({ view: "sidebar", limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map(row => row.threadId), ["test-two", "game-one"]);
  assert.equal((await catalog.list({ view: "sidebar", search: "other-cli" })).total, 0);
  const history = await catalog.list({ view: "history", search: "other-cli" });
  assert.equal(history.total, 1); assert.equal((await catalog.get(history.sessions[0]))?.threadId, "other-cli");
  await assert.rejects(catalog.list({ view: "history", cursor: first.nextCursor }), /Invalid Desktop catalog cursor/);
  raw["electron-persisted-atom-state"]["sidebar-project-expanded-v1-codex:test"] = false;
  await assert.rejects(catalog.list({ view: "sidebar", cursor: first.nextCursor }), /Invalid Desktop catalog cursor/);
});

test("unsupported modes never fall back to history, and expanded recent chats are explicitly partial", () => {
  const all = mergeDesktopMetadata([batch(rows())]); const raw: any = globalState();
  raw["electron-persisted-atom-state"]["flat-project-sidebar-preferences-v1"].mode = "recent";
  let result = selectDesktopSidebar(all.sessions, new Map([[home, parseDesktopSidebarMetadata(raw, home)]]));
  assert.equal(result.sidebar.status, "unsupported"); assert.deepEqual(result.sessions, []);
  raw["electron-persisted-atom-state"]["flat-project-sidebar-preferences-v1"].mode = "project";
  raw["electron-persisted-atom-state"]["sidebar-collapsed-sections-v1"].chats = false;
  result = selectDesktopSidebar(all.sessions, new Map([[home, parseDesktopSidebarMetadata(raw, home)]]));
  assert.equal(result.sidebar.status, "partial"); assert.match(result.sidebar.limitations.join(" "), /runtime catalog/);
});

test("sidebar parser discards unrelated sensitive global state and keeps migration identities home-scoped", () => {
  const raw: any = globalState(); raw.credentials = "SECRET";
  raw["electron-persisted-atom-state"].drafts = "PRIVATE_DRAFT";
  const layout = parseDesktopSidebarMetadata(raw, home);
  assert.equal(JSON.stringify(layout).includes("SECRET"), false);
  assert.equal(JSON.stringify(layout).includes("PRIVATE_DRAFT"), false);
  assert.deepEqual(layout.migratedPinnedIds, ["pinned"]);
  assert.deepEqual(parseDesktopSidebarMetadata(raw, "/different/home").migratedPinnedIds, []);
});
