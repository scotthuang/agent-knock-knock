import path from "node:path";
import type { DesktopSidebarMetadata } from "./desktop-sidebar-metadata.js";

export interface DesktopSidebarProjectCandidate { hostId: string; threadId: string; cwd: string | null }

/** Renderer project membership uses explicit assignment, then its saved root/hint filters. */
export function desktopSidebarProject(entry: DesktopSidebarProjectCandidate, layout: DesktopSidebarMetadata): string | undefined {
  if (entry.hostId !== "local") return undefined;
  const assigned = layout.assignments[entry.threadId];
  if (assigned) return assigned.hostId === "local" ? assigned.projectId : undefined;
  if (layout.projectlessIds.includes(entry.threadId)) return undefined;
  const hint = layout.rootHints[entry.threadId];
  const candidates = Object.entries(layout.projects).flatMap(([id, project]) => project.roots
    .filter(root => hint != null && path.isAbsolute(hint) && root === path.resolve(hint) || rootContains(root, entry.cwd))
    .map(root => ({ id, root })));
  candidates.sort((a, b) => b.root.length - a.root.length || a.id.localeCompare(b.id));
  if (candidates.length > 1 && candidates[1].root === candidates[0].root && candidates[1].id !== candidates[0].id) return undefined;
  return candidates[0]?.id;
}

/** Overlapping root ownership also depends on renderer-specific project priority. */
export function desktopSidebarHasOverlappingRoots(layout: DesktopSidebarMetadata): boolean {
  const roots = Object.entries(layout.projects).flatMap(([id, project]) => project.roots.map(root => ({ id, root })));
  return roots.some((entry, index) => roots.slice(index + 1).some(other =>
    entry.id !== other.id && (rootContains(entry.root, other.root) || rootContains(other.root, entry.root))));
}
function rootContains(root: string, value: string | null | undefined): boolean {
  if (!value || !path.isAbsolute(value)) return false;
  const relative = path.relative(root, path.resolve(value));
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
