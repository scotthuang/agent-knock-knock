import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopRuntime } from "./desktop-runtime.js";
import type { DesktopCatalogEntry } from "./desktop-session-catalog.js";
import { desktopCapabilityProfile } from "./desktop-compatibility.js";
import { desktopSessionProjection } from "./desktop-public-projection.js";
import { DesktopIpcError } from "./desktop-types.js";
import { DesktopEndpointUnavailable } from "./desktop-ipc-transport.js";
import { canInspectDesktopHistory } from "./desktop-queue-inspection.js";
import { DesktopQueueAdmissionError } from "./desktop-queue-submit.js";
import { desktopQueueNotices } from "./desktop-task-queue.js";

const MAX_QUEUE_PROBES = 4;
const execFileAsync = promisify(execFile);

function queueCandidate(runtime: DesktopRuntime, entry: DesktopCatalogEntry) {
  return runtime.compatibility.applicationIdentityVerified === true && runtime.transport.queue &&
    canInspectDesktopHistory(entry, entry) && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(entry.threadId);
}

/** List and Status make the same read-only check as Send. Discard the one-use permit:
 * a future action always requires fresh evidence. Never imply that an IPC observer is connected. */
export async function projectDesktopQueueAvailability(runtime: DesktopRuntime, entry: DesktopCatalogEntry,
  error: DesktopEndpointUnavailable): Promise<Record<string, unknown>> {
  const base = endpointUnavailable(entry, error, Boolean(queueCandidate(runtime, entry)));
  if (!queueCandidate(runtime, entry)) return base;
  const { observation_error, ...row } = base;
  try {
    const admission = await runtime.transport.queue!.prepare(entry);
    if (admission.cwd !== entry.cwd) {
      return { ...row, observation_error: "owner_changed", can_send_reason: "owner_changed" };
    }
    const input = { conversation_id: entry.conversationId };
    const notices = desktopQueueNotices.filter(notice => admission.notices?.includes(notice));
    return { ...row, connection_state: "desktop_queue_owner_verified", can_send_reason: "native_queue_available",
      owner_ipc_state: "unavailable", live_draft_state: "unknown", activity_state: "unknown",
      ...(notices.length ? { queue_notices: notices } : {}),
      capabilities: { ...(base.capabilities as Record<string, unknown>), send: true },
      available_actions: { status: { tool: "agent_knock_knock_status", input }, send: { tool: "agent_knock_knock_send", input } } };
  } catch (failure) {
    if (failure instanceof DesktopQueueAdmissionError) return { ...row, owner_ipc_state: "unavailable",
      connection_state: "desktop_queue_admission_blocked", observation_error: failure.reason, can_send_reason: failure.reason };
    if (failure instanceof DesktopIpcError && failure.code !== "no_live_owner") {
      const reason = failure.code === "thread_not_idle" ? "desktop_queue_admission_blocked" : failure.code;
      return { ...row, owner_ipc_state: "unavailable", observation_error: reason, can_send_reason: reason };
    }
    return base;
  }
}

function endpointUnavailable(entry: DesktopCatalogEntry, error: DesktopEndpointUnavailable, queueEligible: boolean) {
  const reason = error.code === "ENOENT" && !queueEligible ? "desktop_not_running" : "live_owner_not_confirmed";
  return { ...desktopSessionProjection(entry, undefined, false, reason),
    pending_interaction_count: null, pending_async_count: null } as Record<string, unknown>;
}

/** Only a scheduling hint. Look up the exact files for this returned page in one bounded
 * read. A filename, an open fd or a catalog record never establishes a live writer. */
async function openQueueLocks(entries: DesktopCatalogEntry[]) {
  const result = new Set<string>();
  const paths = entries.map(entry => path.join(entry.codexHome, "thread-writer-locks", entry.threadId + ".lock"))
    .filter(file => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile());
  if (!paths.length || process.platform !== "darwin") return result;
  const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", "-Fn", "--", ...paths], {
    encoding: "utf8", timeout: 1500, maxBuffer: 128 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" }
  }).catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; signal?: string }) => {
    // lsof may return 1 when only some selected files are open. Other failures do not
    // establish either a positive or negative hint.
    if (Number(error.code) === 1 && !error.signal && !error.stderr && typeof error.stdout === "string") return { stdout: error.stdout };
    throw error;
  });
  const held = new Set(stdout.split("\n").filter(line => line.startsWith("n")).map(line => line.slice(1)));
  for (const entry of entries) if (held.has(path.join(entry.codexHome, "thread-writer-locks", entry.threadId + ".lock"))) result.add(entry.conversationId);
  return result;
}

export async function listDesktopSessions(runtime: DesktopRuntime, options: Record<string, unknown>, readOpenQueueLocks = openQueueLocks) {
  const limit = options.desktopLimit === undefined ? 30 : Number(options.desktopLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("desktop-limit must be between 1 and 100");
  const view = options.desktopView ?? "sidebar";
  if (view !== "sidebar" && view !== "history") throw new Error("desktop-view must be sidebar or history");
  const page = await runtime.catalog.list({ view, limit, cursor: text(options.desktopCursor),
    search: text(options.desktopSearch), project: text(options.desktopProject) });
  const sessions: Record<string, unknown>[] = new Array(page.sessions.length);
  const fallback = new Map<number, DesktopEndpointUnavailable>();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(16, page.sessions.length) }, async () => {
    while (index < page.sessions.length) {
      const position = index++;
      const entry = page.sessions[position]!;
      if (!entry.localVerifiable) {
        sessions[position] = desktopSessionProjection(entry, undefined, false, "unsupported_desktop_host"); continue;
      }
      try {
        if (!fs.lstatSync(path.join(entry.codexHome, "ipc", "ipc.sock"), { throwIfNoEntry: false })) {
          throw new DesktopEndpointUnavailable("ENOENT");
        }
        const snapshot = await runtime.transport.observe(entry);
        sessions[position] = desktopSessionProjection(entry, snapshot, desktopCapabilityProfile(runtime.compatibility));
      } catch (error) {
        if (error instanceof DesktopEndpointUnavailable) {
          const eligible = Boolean(queueCandidate(runtime, entry));
          sessions[position] = endpointUnavailable(entry, error, eligible);
          if (eligible) fallback.set(position, error);
        } else sessions[position] = desktopSessionProjection(entry, undefined, false,
          error instanceof DesktopIpcError ? error.code : "live_owner_not_confirmed");
      }
    }
  }));
  const candidates = [...fallback.keys()].sort((a, b) => a - b);
  if (candidates.length) {
    // A failed hint or a busy page leaves Status available for a full check by exact ID.
    const held = await readOpenQueueLocks(candidates.map(i => page.sessions[i]!)).catch(() => undefined);
    const eligible = candidates.filter(i => !held || held.has(page.sessions[i]!.conversationId));
    for (const i of eligible.slice(held ? MAX_QUEUE_PROBES : 0)) {
      sessions[i] = { ...sessions[i], can_send_reason: "desktop_queue_probe_deferred" };
    }
    if (held) await Promise.all(eligible.slice(0, MAX_QUEUE_PROBES).map(async i => {
      sessions[i] = await projectDesktopQueueAvailability(runtime, page.sessions[i]!, fallback.get(i)!);
    }));
  }
  return { desktop_sessions: sessions,
    desktop_scan: { view, total_candidates: page.total, history_candidates: page.historyTotal,
      returned: sessions.length, next_cursor: page.nextCursor,
      sidebar_status: page.sidebar?.status, sidebar_mode: page.sidebar?.mode,
      sidebar_selection_scope: page.sidebar?.selectionScope, limitations: page.sidebar?.limitations,
      live_probe_scope: "returned_page",
      catalog_complete: page.complete, live_count: sessions.filter(row => row.connection_state === "live_owner_verified").length,
      queue_ready_count: sessions.filter(row => row.connection_state === "desktop_queue_owner_verified").length,
      application_version: runtime.compatibility.version, application_build: runtime.compatibility.build,
      application_identity_verified: runtime.compatibility.applicationIdentityVerified,
      compatibility_policy: "attempt_native_contract",
      write_contract_verified: desktopCapabilityProfile(runtime.compatibility).nativeControls,
      approval_contract_verified: desktopCapabilityProfile(runtime.compatibility).approvals,
      send_contract_verified: desktopCapabilityProfile(runtime.compatibility).send,
      sources: page.sources, membership_is_not_live_identity: true } };
}
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
