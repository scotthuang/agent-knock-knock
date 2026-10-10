import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDesktopSessions } from "../src/desktop-list.js";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { VERIFIED_DESKTOP_BUILD } from "../src/desktop-ipc-client.js";
import { compactAkkListModelProjection } from "../src/semantic-tool-list-projection.js";
import { DesktopIpcError } from "../src/desktop-types.js";
import type { DesktopRuntime } from "../src/desktop-runtime.js";
import type { DesktopCatalogEntry, DesktopCatalogListOptions } from "../src/desktop-session-catalog.js";

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
  assert.equal(host.desktop_sessions[0].capabilities.send, true);
  const unavailable = host.desktop_sessions[1];
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
