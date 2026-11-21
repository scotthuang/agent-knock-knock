import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDesktopSessions } from "../src/desktop-list.js";
import { createDesktopConversationId, parseDesktopConversationId } from "../src/desktop-identity.js";
import { DESKTOP_CREATION_BUILD } from "../src/desktop-compatibility.js";
import { VERIFIED_DESKTOP_BUILD } from "../src/desktop-ipc-client.js";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";
import { DesktopIpcError } from "../src/desktop-types.js";
import type { DesktopRuntime } from "../src/desktop-runtime.js";
import type { DesktopCatalogEntry, DesktopCatalogListOptions } from "../src/desktop-session-catalog.js";

function exactHostRow(host: any, conversationId: string): any {
  const matches = host.desktop_sessions.filter((row: any) => row.conversation_id === conversationId);
  assert.equal(matches.length, 1, "each exact Desktop identity must appear once");
  return matches[0];
}

test("Desktop List defaults to sidebar and retains an unloaded row and its reason in the Host result", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "akk-sidebar-list-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Only the existence gate is exercised; the injected transport never opens a socket.
  fs.mkdirSync(path.join(home, "ipc")); fs.writeFileSync(path.join(home, "ipc", "ipc.sock"), "");
  const entry = (threadId: string): DesktopCatalogEntry => {
    const identity = { codexHome: home, hostId: "local", threadId };
    return { ...identity, conversationId: createDesktopConversationId(identity), title: threadId,
      cwd: "/project", updatedAtMs: 1, originator: null, projectId: "avatar", sourceKind: "vscode",
      threadSource: null, catalogMembership: "desktop_catalog", localVerifiable: true, metadataOnly: true,
      provenance: [], sidebar: { section: "project", projectId: "avatar", projectName: "Avatar" } };
  };
  const rows = [entry("ready-thread"), entry("unloaded-thread")];
  const requests: DesktopCatalogListOptions[] = [];
  const runtime = { compatibility: VERIFIED_DESKTOP_BUILD,
    catalog: { async list(options: DesktopCatalogListOptions) {
      requests.push(options);
      return { sessions: rows, total: 2, historyTotal: 341, nextCursor: "next-page", complete: true, sources: [],
        sidebar: { status: "supported", mode: "project", selectionScope: "persisted_expanded_membership",
          limitations: ["Screen scrolling is not observed."] } };
    } },
    transport: { async observe(identity: DesktopCatalogEntry) {
      if (identity.threadId === "unloaded-thread") throw new DesktopIpcError("no_live_owner", "native router rejection");
      return { threadId: identity.threadId, ownerClientId: "private-owner", revision: 1, runtimeStatus: "idle",
        pendingRequests: [], pendingRequestCount: 0, unconfirmedSubmissionCount: 0, tailKnown: true,
        latestTurnId: null, turns: [], canSend: true };
    } }, tasks: { list: () => [] }
  } as unknown as DesktopRuntime;
  const result = await listDesktopSessions(runtime, {});
  assert.equal(requests[0].view, "sidebar");
  assert.equal(result.desktop_sessions.length, 2);
  assert.equal(result.desktop_scan.total_candidates, 2);
  assert.equal(result.desktop_scan.history_candidates, 341);
  assert.equal(result.desktop_scan.live_count, 1);
  assert.equal(result.desktop_scan.live_probe_scope, "returned_page");
  const host = compactAkkListModelProjection(result) as any;
  assert.equal(host.desktop_sessions.length, 2);
  // Host pagination orders opaque IDs, not catalog insertion order. Their encoded
  // home prefix can change this order when TMPDIR changes; select by exact identity.
  assert.equal(exactHostRow(host, rows[0].conversationId).capabilities.send, true);
  const unavailable = exactHostRow(host, rows[1].conversationId);
  assert.equal(unavailable.conversation_id, rows[1].conversationId);
  assert.equal(unavailable.sidebar_project_name, "Avatar");
  assert.equal(unavailable.connection_state, "unconfirmed");
  assert.equal(unavailable.capabilities.send, false);
  assert.equal(unavailable.can_send_reason, "no_live_owner");
  assert.equal(unavailable.observation_error, "no_live_owner");
  assert.match(unavailable.manual_action, /Open this conversation/);
  assert.equal(unavailable.available_actions.send, undefined);
  assert.equal(host.desktop_scan.view, "sidebar");
  assert.equal(host.desktop_scan.history_candidates, 341);
  assert.equal(host.desktop_scan.sidebar_status, "supported");
  assert.equal(host.desktop_scan.sidebar_selection_scope, "persisted_expanded_membership");
  assert.deepEqual(host.desktop_scan.limitations, ["Screen scrolling is not observed."]);
  assert.equal(JSON.stringify(host).includes("private-owner"), false);

  await listDesktopSessions(runtime, { desktopView: "history", desktopSearch: "avatar", desktopCursor: "cursor", desktopLimit: 4 });
  assert.deepEqual(requests[1], { view: "history", limit: 4, cursor: "cursor", search: "avatar", project: undefined });
  await assert.rejects(listDesktopSessions(runtime, { desktopView: "all" }), /desktop-view must be/);
  assert.equal(requests.length, 2);
  runtime.compatibility = DESKTOP_CREATION_BUILD;
  const sendOnly = compactAkkListModelProjection(await listDesktopSessions(runtime, {})) as any;
  const sendOnlyReady = exactHostRow(sendOnly, rows[0].conversationId);
  assert.equal(sendOnlyReady.capabilities.send, true);
  assert.equal(sendOnlyReady.capabilities.set_permissions, true);
  assert.equal(sendOnlyReady.available_actions.model_options, true);
  assert.equal(sendOnlyReady.capability_verification.nativeControls, false);
  assert.equal(sendOnly.desktop_scan.write_contract_verified, false);
  assert.equal(sendOnly.desktop_scan.send_contract_verified, true);
  assert.equal(sendOnly.desktop_scan.approval_contract_verified, true);
  runtime.compatibility = { version: "future", build: "unverified" };
  const unknown = compactAkkListModelProjection(await listDesktopSessions(runtime, {})) as any;
  const ready = exactHostRow(unknown, rows[0].conversationId);
  assert.equal(ready.capabilities.send, true); assert.equal(ready.capabilities.set_model, true);
  assert.equal(ready.compatibility_warning, true); assert.equal(ready.compatibility_policy, "attempt_native_contract");
  assert.equal(Object.values(ready.capability_verification).every(value => value === false), true);
  assert.equal(unknown.desktop_scan.compatibility_policy, "attempt_native_contract");
  assert.equal(unknown.desktop_scan.write_contract_verified, false); assert.equal(unknown.desktop_scan.send_contract_verified, false);
  assert.equal(unknown.desktop_scan.approval_contract_verified, false);
  assert.equal(exactHostRow(unknown, rows[1].conversationId).capabilities.send, false);
});

test("Desktop capability assertions follow exact IDs across encoded home prefixes and both List formats", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-id-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstThreads = new Set<string>();
  for (const suffix of ["h", "hh", "hhh"]) {
    const codexHome = path.join(root, suffix);
    fs.mkdirSync(codexHome);
    const rows = ["ready-thread", "unloaded-thread"].map(threadId => {
      const identity = { codexHome, hostId: "local", threadId };
      const conversation_id = createDesktopConversationId(identity);
      assert.deepEqual(parseDesktopConversationId(conversation_id), identity);
      const live = threadId === "ready-thread";
      return { conversation_id, source: "codex_desktop", agent: "codex", native_thread_id: threadId,
        connection_state: live ? "live_owner_verified" : "unconfirmed", capabilities: { send: live },
        ...(live ? {} : { can_send_reason: "no_live_owner" }) };
    });
    for (const listProjectionVersion of [4, 5]) {
      const host = compactAkkListModelProjection({ desktop_sessions: rows }, { listProjectionVersion }) as any;
      assert.equal(host.desktop_sessions.length, 2);
      firstThreads.add(host.desktop_sessions[0].native_thread_id);
      const ready = exactHostRow(host, rows[0].conversation_id);
      assert.equal(ready.connection_state, "live_owner_verified");
      assert.equal(ready.capabilities.send, true);
      const unloaded = exactHostRow(host, rows[1].conversation_id);
      assert.equal(unloaded.connection_state, "unconfirmed");
      assert.equal(unloaded.capabilities.send, false);
      assert.equal(unloaded.can_send_reason, "no_live_owner");
      assert.equal(unloaded.available_actions?.send, undefined);
    }
  }
  assert.equal(firstThreads.size, 2, "fixture exercises both opaque-ID sort orders, without Socket I/O");
});

test("unsupported Desktop sidebar metadata remains an explicit incomplete result, not all history or a successful empty sidebar", async () => {
  const runtime = { compatibility: VERIFIED_DESKTOP_BUILD,
    catalog: { async list() { return { sessions: [], total: 0, historyTotal: 341, sources: [], complete: false,
      sidebar: { status: "unsupported", mode: "custom", selectionScope: "persisted_expanded_membership",
        limitations: ["This sidebar mode is not yet supported; use desktop_view=history to search saved threads."] } }; } },
    transport: { observe: () => { throw new Error("No thread may be probed"); } }, tasks: { list: () => [] }
  } as unknown as DesktopRuntime;
  const host = compactAkkListModelProjection(await listDesktopSessions(runtime, {})) as any;
  assert.deepEqual(host.desktop_sessions, []);
  assert.equal(host.desktop_scan.catalog_complete, false);
  assert.equal(host.desktop_scan.sidebar_status, "unsupported");
  assert.equal(host.desktop_scan.history_candidates, 341);
  assert.match(host.desktop_scan.limitations[0], /desktop_view=history/);
});

test("Desktop List checks only held lock hints on this page, caps queue probes and exposes only a fresh queue Send", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "akk-queue-list-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rows = Array.from({ length: 8 }, (_, i): DesktopCatalogEntry => {
    const identity = { codexHome: home, hostId: "local", threadId: "00000000-0000-7000-8000-" + String(i).padStart(12, "0") };
    return { ...identity, conversationId: createDesktopConversationId(identity), cwd: "/fixture", title: "scope-" + i,
      updatedAtMs: 1, originator: null, projectId: null, sourceKind: null, threadSource: null,
      catalogMembership: "desktop_catalog", localVerifiable: true, metadataOnly: true, provenance: [] };
  });
  rows[7]!.archived = true;
  const checked: string[] = [];
  const runtime = { compatibility: { version: "fixture", build: "fixture", applicationIdentityVerified: true },
    catalog: { async list() { return { sessions: rows, total: 8, complete: true, sources: [] }; } },
    transport: { async observe() { throw new DesktopIpcError("unsafe_socket", "Identity failure"); }, queue: {
      async prepare(entry: DesktopCatalogEntry) {
        checked.push(entry.conversationId);
        if (entry === rows[2]) throw new DesktopIpcError("thread_not_idle", "private draft");
        if (entry === rows[3]) throw new Error("private owner/endpoint information");
        return { ownerId: "private owner", endpointId: "private endpoint", baselineTurnId: "private baseline", cwd: entry.cwd };
      }
    } } } as unknown as DesktopRuntime;
  const result = await listDesktopSessions(runtime, {}, async candidates => {
    assert.deepEqual(candidates, rows.slice(0, 7));
    return new Set(rows.slice(1, 7).map(row => row.conversationId));
  });
  assert.deepEqual(checked, rows.slice(1, 5).map(row => row.conversationId));
  assert.equal(result.desktop_scan.live_count, 0); assert.equal(result.desktop_scan.queue_ready_count, 2);
  for (const version of [4, 5]) {
    let page = compactAkkListModelProjection(result, { listProjectionVersion: version, listLimit: 50 }) as any;
    const host = { desktop_scan: page.desktop_scan, desktop_sessions: [...page.desktop_sessions] };
    while (page.pagination.has_more) {
      page = compactAkkListModelProjection(result, page.pagination.next_args) as any;
      host.desktop_sessions.push(...page.desktop_sessions);
    }
    const ready = exactHostRow(host, rows[1]!.conversationId);
    assert.equal(ready.connection_state, "desktop_queue_owner_verified"); assert.equal(ready.activity_state, "unknown");
    assert.equal(ready.capabilities.send, true); assert.equal(ready.capabilities.watch, false);
    assert.equal(ready.capabilities.approve, false); assert.equal(ready.available_actions.native_inspect, undefined);
    assert.equal(ready.can_send_reason, "native_queue_available");
    assert.equal(exactHostRow(host, rows[0]!.conversationId).capabilities.send, false);
    assert.equal(exactHostRow(host, rows[2]!.conversationId).can_send_reason, "desktop_queue_admission_blocked");
    assert.equal(exactHostRow(host, rows[3]!.conversationId).capabilities.send, false);
    assert.equal(exactHostRow(host, rows[5]!.conversationId).can_send_reason, "desktop_queue_probe_deferred");
    assert.equal(host.desktop_scan.queue_ready_count, 2);
    assert.doesNotMatch(JSON.stringify(host), /private (?:draft|owner|endpoint|baseline)/u);
  }
  const raw = result.desktop_sessions[1]!;
  assert.equal(raw.live_draft_state, "unknown"); assert.equal(raw.pending_interaction_count, null);
  assert.equal(raw.pending_async_count, null);
  // A live IPC protocol/identity refusal is conclusive. Never turn it into queue availability.
  fs.mkdirSync(path.join(home, "ipc"));
  fs.writeFileSync(path.join(home, "ipc", "ipc.sock"), "");
  const refused = await listDesktopSessions(runtime, {}, async () => { throw new Error("unexpected queue hint"); });
  assert.equal(refused.desktop_scan.queue_ready_count, 0);
  assert.ok(refused.desktop_sessions.every(row => row.observation_error === "unsafe_socket"));
  assert.equal(checked.length, 4);
});
