import { createHash } from "node:crypto";
import type { DesktopSidebarMetadata } from "./desktop-sidebar-metadata.js";
import { desktopSidebarProject, desktopSidebarHasOverlappingRoots, type DesktopSidebarProjectCandidate } from "./desktop-sidebar-projects.js";

export interface DesktopSidebarSummary {
  status: "supported" | "partial" | "unsupported" | "unavailable";
  mode?: string;
  limitations: string[];
  selectionScope: "persisted_expanded_membership";
}
export interface DesktopSidebarMembership { section: "pinned" | "project"; projectId?: string; projectName?: string }
interface SidebarCandidate extends DesktopSidebarProjectCandidate {
  codexHome: string; conversationId: string; updatedAtMs: number;
  threadSectionId?: string | null; sectionPosition?: number; sidebar?: DesktopSidebarMembership;
}
// Codex Desktop's reserved app-server Pinned section; a user section named "Pinned" is not sufficient.
export const DESKTOP_PINNED_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

export function selectDesktopSidebar<T extends SidebarCandidate>(entries: T[], layouts: Map<string, DesktopSidebarMetadata>,
  archivedIds: Set<string> = new Set()) {
  const selected = new Map<string, T>();
  const summaries: DesktopSidebarSummary[] = [];
  for (const [home, layout] of layouts) {
    const localEntries = entries.filter(entry => entry.codexHome === home);
    const summary = sidebarSummary(layout); summaries.push(summary);
    if (summary.status === "unavailable" || summary.status === "unsupported") continue;
    selectLayout(home, localEntries, layout, selected, archivedIds, summary);
  }
  const sidebar = combineSummaries(summaries);
  const sessions = [...selected.values()];
  const fingerprint = createHash("sha256").update(JSON.stringify({ layouts: [...layouts],
    selected: sessions.map(entry => [entry.conversationId, entry.updatedAtMs, entry.sidebar]), sidebar })).digest("hex");
  return { sessions, sidebar, fingerprint };
}

function sidebarSummary(layout: DesktopSidebarMetadata): DesktopSidebarSummary {
  const limitations = [...new Set(layout.limitations)];
  if (desktopSidebarHasOverlappingRoots(layout)) limitations.push("Overlapping project roots use approximate ownership; renderer project-priority ordering is not verified.");
  if (layout.available && layout.mode !== "project") limitations.push("This Desktop sidebar mode is not supported; use desktop_view=history for saved candidates.");
  if (layout.available && layout.mode === "project" && layout.collapsed.chats !== true) {
    limitations.push("Expanded Chats include runtime catalog and pagination state; only pinned and expanded-project membership is returned.");
  }
  return { status: !layout.available ? "unavailable" : layout.mode !== "project" ? "unsupported" : limitations.length ? "partial" : "supported",
    mode: layout.mode, limitations, selectionScope: "persisted_expanded_membership" };
}

function selectLayout<T extends SidebarCandidate>(home: string, entries: T[], layout: DesktopSidebarMetadata,
  selected: Map<string, T>, archived: Set<string>, summary: DesktopSidebarSummary) {
  const byThread = new Map(entries.filter(entry => entry.hostId === "local").map(entry => [entry.threadId, entry]));
  const add = (id: string, membership: DesktopSidebarMembership) => {
    const entry = byThread.get(id);
    if (!entry) {
      if (!archived.has(`${home}\0local\0${id}`)) {
        summary.status = "partial";
        summary.limitations.push("A sidebar member has no supported local catalog metadata.");
      }
      return;
    }
    if (!selected.has(entry.conversationId)) selected.set(entry.conversationId, { ...entry, sidebar: membership });
  };
  const pinned = new Set(pinnedThreads(entries, layout));
  if (layout.collapsed.pinned !== true) {
    for (const id of pinned) add(id, { section: "pinned" });
  }
  for (const projectId of layout.collapsed.threads === true ? [] : orderedProjects(layout)) {
    if (layout.expanded[projectId] === false) continue;
    const members = entries.filter(entry => !pinned.has(entry.threadId) && !entry.threadSectionId && !layout.customSectionThreadIds.includes(entry.threadId) &&
      desktopSidebarProject(entry, layout) === projectId);
    for (const entry of members) add(entry.threadId, { section: "project", projectId, projectName: layout.projects[projectId]?.name });
    for (const [id, assignment] of Object.entries(layout.assignments)) {
      if (assignment.projectId === projectId && assignment.hostId === "local" && !byThread.has(id)) add(id, { section: "project", projectId });
    }
  }
  summary.limitations = [...new Set(summary.limitations)];
}

function pinnedThreads(entries: SidebarCandidate[], layout: DesktopSidebarMetadata): string[] {
  const native = entries.filter(entry => entry.hostId === "local" && entry.threadSectionId === DESKTOP_PINNED_SECTION_ID)
    .sort((a, b) => (a.sectionPosition ?? 0) - (b.sectionPosition ?? 0)).map(entry => entry.threadId);
  const migrated = new Set(layout.migratedPinnedIds);
  const retained = new Set([...native, ...layout.pinnedIds.filter(id => !migrated.has(id))]);
  return [...new Set([...layout.nativePinnedOrder.filter(id => retained.has(id)), ...retained])];
}
function orderedProjects(layout: DesktopSidebarMetadata): string[] {
  return [...new Set([...layout.projectOrder.filter(id => Object.hasOwn(layout.projects, id)), ...Object.keys(layout.projects)])];
}
function combineSummaries(items: DesktopSidebarSummary[]): DesktopSidebarSummary {
  const usable = items.filter(item => item.status === "supported" || item.status === "partial");
  const status = items.length > 0 && items.every(item => item.status === "supported") ? "supported"
    : usable.length ? "partial" : items.some(item => item.status === "unsupported") ? "unsupported" : "unavailable";
  const modes = [...new Set(items.map(item => item.mode).filter(Boolean))];
  return { status, mode: modes.length === 1 ? modes[0] : undefined,
    limitations: [...new Set(items.flatMap(item => item.limitations))], selectionScope: "persisted_expanded_membership" };
}
