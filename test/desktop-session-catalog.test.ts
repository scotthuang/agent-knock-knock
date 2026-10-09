import test from "node:test";
import assert from "node:assert/strict";
import { DesktopSessionCatalog, mergeDesktopMetadata } from "../src/desktop-session-catalog.js";
import type { DesktopMetadataBatch, DesktopMetadataRow } from "../src/desktop-metadata-reader.js";

function batch(kind: "state" | "desktop_catalog", rows: DesktopMetadataRow[], home = "/fixture/codex"): DesktopMetadataBatch {
  return {
    source: { kind, codexHome: home, database: `${home}/${kind}.sqlite`, status: "ok" },
    rows, hosts: { local: "local", remote: "ssh", cloud: "chatgpt" }
  };
}
function state(id: string, overrides: DesktopMetadataRow = {}): DesktopMetadataRow {
  return { id, title: `state ${id}`, cwd: "/projects/one", updated_at_ms: 1000, archived: 0, source: "cli", originator: "codex-tui", ...overrides };
}
function catalog(id: string, overrides: DesktopMetadataRow = {}): DesktopMetadataRow {
  return { thread_id: id, host_id: "local", display_title: `catalog ${id}`, cwd: "/projects/one", source_updated_at: 2, source_kind: "unknown", missing_candidate: 0, ...overrides };
}

test("Desktop directory entries survive unknown source and missing live owner, with state metadata enrichment", () => {
  const { sessions } = mergeDesktopMetadata([
    batch("state", [state("thread-one", { source: "vscode", originator: "codex_work_desktop", thread_source: "voice_chat", updated_at_ms: 3000 })]),
    batch("desktop_catalog", [catalog("thread-one"), catalog("thread-tui", { source_kind: "cli" })])
  ]);
  assert.equal(sessions.length, 2);
  const voice = sessions.find((entry) => entry.threadId === "thread-one")!;
  assert.equal(voice.title, "catalog thread-one");
  assert.equal(voice.updatedAtMs, 3000);
  assert.equal(voice.originator, "codex_work_desktop");
  assert.equal(voice.threadSource, "voice_chat");
  assert.equal(voice.sourceKind, "unknown");
  assert.equal(voice.catalogMembership, "desktop_catalog");
  assert.equal(voice.metadataOnly, true);
  assert.equal(voice.localVerifiable, true);
  assert.deepEqual(voice.provenance.map((source) => source.table).sort(), ["local_thread_catalog", "threads"]);
  assert.equal("ownerClientId" in voice, false);
  assert.equal("canSend" in voice, false);
});

test("state-only root candidates are labelled metadata, and child/exec/hidden rows do not masquerade as Desktop UI", () => {
  const { sessions } = mergeDesktopMetadata([batch("state", [
    state("root-tui"), state("root-unknown", { source: "unknown" }),
    state("root-work", { source: "vscode", originator: "codex_work_desktop" }),
    state("child-one", { source: JSON.stringify({ subAgent: { thread_spawn: {} } }) }),
    state("child-two", { source: "vscode", parent_thread_id: "root-work" }),
    state("execution", { source: "exec" }), state("background", { thread_source: "chatgpt_hidden" }),
    state("archived", { archived: 1 }), state("unknown-structured", { source: "{invalid" })
  ])]);
  assert.deepEqual(sessions.map((entry) => entry.threadId).sort(), ["root-tui", "root-unknown", "root-work"]);
  assert.ok(sessions.every((entry) => entry.catalogMembership === "state_metadata" && entry.metadataOnly));
});

test("explicit directory membership survives state classification and dedupes only exact home/host/thread identity", () => {
  const { sessions } = mergeDesktopMetadata([
    batch("state", [state("same-id", { source: "exec" })]),
    batch("desktop_catalog", [catalog("same-id"), catalog("same-id", { host_id: "remote" }), catalog("opaque-id", { host_id: "unrecognized" })]),
    batch("desktop_catalog", [catalog("same-id")], "/fixture/other-home")
  ]);
  assert.equal(sessions.length, 4);
  assert.equal(new Set(sessions.map((entry) => entry.conversationId)).size, 4);
  assert.equal(sessions.find((entry) => entry.hostId === "remote")?.localVerifiable, false);
  assert.equal(sessions.find((entry) => entry.hostId === "unrecognized")?.localVerifiable, false);
  assert.equal(sessions.find((entry) => entry.codexHome === "/fixture/codex" && entry.hostId === "local")?.provenance.length, 2);
});

test("newer directory metadata wins across prod/dev catalogs without changing identity", () => {
  const first = batch("desktop_catalog", [catalog("same-id", { display_title: "older", source_updated_at: 5 })]);
  const second = batch("desktop_catalog", [catalog("same-id", { display_title: "newer", source_updated_at: 6 })]);
  second.source.database += "-dev";
  const merged = mergeDesktopMetadata([first, batch("state", [state("same-id", { updated_at_ms: 9000 })]), second]).sessions;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "newer");
  assert.equal(merged[0].provenance.length, 3);
  assert.equal(merged[0].updatedAtMs, 9000);
  assert.equal(merged[0].conversationId, mergeDesktopMetadata([first]).sessions[0].conversationId);
});

test("catalog pagination has deterministic ties and bound search/project cursors", async () => {
  const entries = ["aa", "bb", "cc", "dd"].map((id) => catalog(id, { display_title: `Needle ${id}`, project_id: "project-one" }));
  const provider = new DesktopSessionCatalog({ codexHomes: ["/fixture/codex"], readMetadata: async () => [batch("desktop_catalog", entries)] });
  const first = await provider.list({ limit: 2, search: "NEEDLE", project: "project-one" });
  const second = await provider.list({ limit: 2, search: "needle", project: "project-one", cursor: first.nextCursor });
  assert.equal(first.total, 4);
  assert.ok(first.nextCursor);
  assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.sessions, ...second.sessions].map((entry) => entry.threadId)).size, 4);
  await assert.rejects(provider.list({ cursor: first.nextCursor, search: "elsewhere" }), /changed search\/project/);
  assert.equal((await provider.list({ project: "/projects/one/" })).total, 4);
  assert.equal((await provider.list({ project: "/projects/two" })).total, 0);
  assert.equal((await provider.get(first.sessions[0]))?.conversationId, first.sessions[0].conversationId);
  await assert.rejects(provider.list({ limit: 0 }), /limit/);
});

test("a corrupt source is explicit and atomic, while independent catalog results remain available", async () => {
  const provider = new DesktopSessionCatalog({ codexHomes: ["/fixture/codex"], readMetadata: async () => [
    batch("state", [state("valid-row"), state("invalid-row", { updated_at_ms: "oops" })]),
    batch("desktop_catalog", [catalog("retained-row")])
  ] });
  const page = await provider.list();
  assert.equal(page.complete, false);
  assert.deepEqual(page.sessions.map((entry) => entry.threadId), ["retained-row"]);
  assert.match(page.sources.find((source) => source.status === "error")?.error ?? "", /timestamp/);
});
