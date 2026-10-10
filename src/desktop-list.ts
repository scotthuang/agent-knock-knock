import fs from "node:fs";
import path from "node:path";
import type { DesktopRuntime } from "./desktop-runtime.js";
import { desktopWritesVerified } from "./desktop-runtime.js";
import { desktopSessionProjection, desktopTaskProjection } from "./desktop-public-projection.js";
import { DesktopIpcError } from "./desktop-types.js";

export async function listDesktopSessions(runtime: DesktopRuntime, options: Record<string, unknown>) {
  const limit = options.desktopLimit === undefined ? 30 : Number(options.desktopLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("desktop-limit must be between 1 and 100");
  const view = options.desktopView ?? "sidebar";
  if (view !== "sidebar" && view !== "history") throw new Error("desktop-view must be sidebar or history");
  const page = await runtime.catalog.list({ view, limit, cursor: text(options.desktopCursor),
    search: text(options.desktopSearch), project: text(options.desktopProject) });
  const sessions: Record<string, unknown>[] = new Array(page.sessions.length);
  // Bounded parallel read-only probes. Missing owners remain visible, never implicitly loaded.
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(16, page.sessions.length) }, async () => {
    while (index < page.sessions.length) {
      const position = index++;
      const entry = page.sessions[position]!;
      if (!entry.localVerifiable || !fs.existsSync(path.join(entry.codexHome, "ipc", "ipc.sock"))) {
        sessions[position] = desktopSessionProjection(entry, undefined, false,
          entry.localVerifiable ? "desktop_not_running" : "unsupported_desktop_host"); continue;
      }
      try {
        const snapshot = await runtime.transport.observe(entry);
        sessions[position] = desktopSessionProjection(entry, snapshot, desktopWritesVerified(runtime.compatibility));
      } catch (error) {
        sessions[position] = desktopSessionProjection(entry, undefined, false,
          error instanceof DesktopIpcError ? error.code : "live_owner_not_confirmed");
      }
    }
  }));
  let watches: Record<string, unknown>[] = []; let watchError: string | undefined;
  try { watches = runtime.tasks.list().map(task => desktopTaskProjection(task, desktopWritesVerified(runtime.compatibility))); }
  catch { watchError = "desktop_watch_store_unavailable"; }
  return { desktop_sessions: sessions, desktop_watches: watches,
    desktop_scan: { view, total_candidates: page.total, history_candidates: page.historyTotal,
      returned: sessions.length, next_cursor: page.nextCursor,
      sidebar_status: page.sidebar?.status, sidebar_mode: page.sidebar?.mode,
      sidebar_selection_scope: page.sidebar?.selectionScope, limitations: page.sidebar?.limitations,
      live_probe_scope: "returned_page",
      catalog_complete: page.complete, live_count: sessions.filter(row => row.connection_state === "live_owner_verified").length,
      application_version: runtime.compatibility.version, application_build: runtime.compatibility.build,
      write_contract_verified: desktopWritesVerified(runtime.compatibility), watch_error: watchError,
      sources: page.sources, membership_is_not_live_identity: true } };
}
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
