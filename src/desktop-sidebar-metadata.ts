import fs from "node:fs/promises";
import path from "node:path";

export interface DesktopSidebarMetadata {
  available: boolean;
  mode?: string;
  collapsed: Record<string, boolean>;
  expanded: Record<string, boolean>;
  projects: Record<string, { name: string; roots: string[] }>;
  assignments: Record<string, { projectId: string; hostId: string }>;
  projectOrder: string[];
  pinnedIds: string[];
  migratedPinnedIds: string[];
  nativePinnedOrder: string[];
  projectIdMappings: Record<string, string>;
  projectlessIds: string[];
  rootHints: Record<string, string>;
  customSectionThreadIds: string[];
  limitations: string[];
}
export type DesktopSidebarReader = (codexHome: string) => Promise<DesktopSidebarMetadata>;

/** Select only layout metadata. Never return the global state, credentials, or drafts. */
export async function readDesktopSidebarMetadata(home: string): Promise<DesktopSidebarMetadata> {
  try {
    const file = path.join(home, ".codex-global-state.json");
    if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error("oversized layout");
    return parseDesktopSidebarMetadata(JSON.parse(await fs.readFile(file, "utf8")), home);
  } catch {
    return { available: false, collapsed: {}, expanded: {}, projects: {}, assignments: {}, projectOrder: [],
      pinnedIds: [], migratedPinnedIds: [], nativePinnedOrder: [], projectIdMappings: {},
      projectlessIds: [], rootHints: {}, customSectionThreadIds: [],
      limitations: ["Desktop persisted sidebar layout is unavailable or invalid."] };
  }
}

export function parseDesktopSidebarMetadata(value: unknown, home: string): DesktopSidebarMetadata {
  const state = record(value), atoms = record(state["electron-persisted-atom-state"]);
  const preferences = record(atoms["flat-project-sidebar-preferences-v1"]);
  const identity = `local:${home}`;
  const projects = Object.fromEntries(Object.entries(record(state["local-projects"]))
    .filter(([, item]) => typeof record(item).name === "string")
    .map(([id, item]) => [id, { name: String(record(item).name).slice(0, 160), roots: projectRoots(record(item)) }]));
  const limitations: string[] = [];
  const sections = Object.values(record(atoms["sidebar-custom-sections-v3"])).flatMap(item => {
    const sectionList = record(item).sections; return Array.isArray(sectionList) ? sectionList : [];
  });
  if (sections.length) {
    limitations.push("Custom sidebar sections are not included in this layout projection.");
  }
  if (Object.values(record(atoms["chatgpt-sidebar-state-v2"])).some(item =>
    ["pinnedConversations", "pinnedProjects", "projects"].some(key => Array.isArray(record(item)[key]) && (record(item)[key] as unknown[]).length))) {
    limitations.push("Cloud sidebar projects and pins are not included in this local layout projection.");
  }
  return { available: true, mode: typeof preferences.mode === "string" ? preferences.mode : undefined,
    collapsed: booleanRecord(atoms["sidebar-collapsed-sections-v1"]),
    expanded: Object.fromEntries(Object.entries(atoms).filter(([key, item]) =>
      key.startsWith("sidebar-project-expanded-v1-codex:") && typeof item === "boolean")
      .map(([key, item]) => [key.slice("sidebar-project-expanded-v1-codex:".length), item as boolean])),
    projects, assignments: sidebarAssignments(state, limitations),
    projectOrder: strings(state["project-order"]), pinnedIds: strings(state["pinned-thread-ids"]),
    migratedPinnedIds: strings(record(state["app-server-migrated-pinned-thread-ids-by-host"])[identity]),
    nativePinnedOrder: strings(atoms["app-server-pinned-thread-order-v1"]),
    projectIdMappings: stringRecord(record(state["app-server-project-id-by-legacy-project-id-by-host"])[identity]),
    projectlessIds: strings(state["projectless-thread-ids"]), rootHints: stringRecord(state["thread-workspace-root-hints"]),
    customSectionThreadIds: sections.flatMap(section => strings(record(section).itemKeys))
      .filter(key => key.startsWith("codex:thread:local:")).map(key => key.slice("codex:thread:local:".length)), limitations };
}

function projectRoots(project: Record<string, unknown>): string[] {
  const aliases = Array.isArray(project.rootPathAliases) ? project.rootPathAliases : [];
  return [...new Set([...strings(project.rootPaths), ...aliases.flatMap(value => {
    const alias = record(value); return [alias.alias, alias.pathAlias].filter((item): item is string => typeof item === "string");
  }), ...(typeof project.pathAlias === "string" ? [project.pathAlias] : [])])].filter(item => path.isAbsolute(item)).map(item => path.resolve(item));
}

function sidebarAssignments(state: Record<string, unknown>, limitations: string[]) {
  const hosts = record(state["thread-project-membership-host-ids"]);
  const entries = Object.entries(record(state["thread-project-assignments"]));
  const result: DesktopSidebarMetadata["assignments"] = {};
  for (const [id, value] of entries) {
    const item = record(value);
    if (item.projectKind !== "local" || typeof item.projectId !== "string") {
      // Keep an explicit exclusion: dropping the record would let cwd inference
      // incorrectly reassign this thread to a local project.
      result[id] = { projectId: typeof item.projectId === "string" ? item.projectId : "", hostId: "non-local" };
      limitations.push("Non-local project assignments are not included in this layout projection."); continue;
    }
    result[id] = { projectId: item.projectId, hostId: typeof hosts[id] === "string" ? hosts[id] as string : "local" };
  }
  return result;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter(item => typeof item === "string") : []; }
function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function booleanRecord(value: unknown): Record<string, boolean> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}
