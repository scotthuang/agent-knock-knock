import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDesktopConversationId } from "./desktop-identity.js";
import type { DesktopThreadIdentity } from "./desktop-types.js";
import {
  readDesktopMetadata,
  type DesktopMetadataBatch,
  type DesktopMetadataReader,
  type DesktopMetadataRow,
  type DesktopMetadataSource
} from "./desktop-metadata-reader.js";

export interface DesktopCatalogProvenance {
  database: string;
  table: "threads" | "local_thread_catalog";
  sourceKind: string | null;
  threadSource: string | null;
}
export interface DesktopCatalogEntry extends DesktopThreadIdentity {
  conversationId: string;
  title: string;
  cwd: string | null;
  updatedAtMs: number;
  originator: string | null;
  projectId: string | null;
  sourceKind: string | null;
  threadSource: string | null;
  catalogMembership: "desktop_catalog" | "state_metadata";
  localVerifiable: boolean;
  /** Directory membership does not establish a current owner, loaded state, or send capability. */
  metadataOnly: true;
  provenance: DesktopCatalogProvenance[];
}
export interface DesktopCatalogListOptions {
  limit?: number;
  cursor?: string;
  search?: string;
  /** Exact project ID or normalized absolute project directory. */
  project?: string;
}
export interface DesktopCatalogPage {
  sessions: DesktopCatalogEntry[];
  nextCursor?: string;
  total: number;
  sources: DesktopMetadataSource[];
  /** All available supported sources were read; not a claim of live or cloud completeness. */
  complete: boolean;
}
export interface DesktopSessionCatalogOptions {
  codexHomes?: string[];
  readMetadata?: DesktopMetadataReader;
}

export class DesktopSessionCatalog {
  private readonly homes: string[];
  private readonly readMetadata: DesktopMetadataReader;
  constructor(options: DesktopSessionCatalogOptions = {}) {
    this.homes = [...new Set((options.codexHomes ?? [path.join(os.homedir(), ".codex"), ...(process.env.CODEX_HOME ? [process.env.CODEX_HOME] : [])]).map(canonicalHome))];
    this.readMetadata = options.readMetadata ?? readDesktopMetadata;
  }

  async list(options: DesktopCatalogListOptions = {}): Promise<DesktopCatalogPage> {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Desktop catalog limit must be 1..500");
    const search = options.search?.trim().toLocaleLowerCase() ?? "";
    const project = options.project?.trim() ?? "";
    const { sessions, sources } = await this.collect();
    const filtered = sessions.filter((session) => {
      if (project && session.projectId !== project && (!session.cwd || !path.isAbsolute(session.cwd) || !path.isAbsolute(project) || path.resolve(session.cwd) !== path.resolve(project))) return false;
      return !search || [session.title, session.cwd, session.threadId, session.projectId]
        .some((value) => value?.toLocaleLowerCase().includes(search));
    });
    const queryKey = createHash("sha256").update(JSON.stringify([this.homes, search, project])).digest("hex");
    let after: { updatedAtMs: number; conversationId: string } | undefined;
    if (options.cursor) after = decodeCursor(options.cursor, queryKey);
    const remaining = after ? filtered.filter((entry) =>
      entry.updatedAtMs < after.updatedAtMs ||
      entry.updatedAtMs === after.updatedAtMs && entry.conversationId > after.conversationId
    ) : filtered;
    const page = remaining.slice(0, limit);
    const tail = page.at(-1);
    return {
      sessions: page,
      ...(remaining.length > page.length && tail ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, q: queryKey, t: tail.updatedAtMs, id: tail.conversationId })).toString("base64url") } : {}),
      total: filtered.length,
      sources,
      complete: sources.every((source) => source.status !== "error")
    };
  }

  async get(identity: DesktopThreadIdentity): Promise<DesktopCatalogEntry | undefined> {
    const conversationId = createDesktopConversationId({ ...identity, codexHome: canonicalHome(identity.codexHome) });
    return (await this.collect()).sessions.find((entry) => entry.conversationId === conversationId);
  }

  private async collect(): Promise<{ sessions: DesktopCatalogEntry[]; sources: DesktopMetadataSource[] }> {
    const batches: DesktopMetadataBatch[] = [];
    for (const home of this.homes) {
      try { batches.push(...await this.readMetadata(home)); }
      catch (error) {
        batches.push({ source: { database: home, codexHome: home, kind: "state", status: "error", error: error instanceof Error ? error.message : String(error) }, rows: [] });
      }
    }
    return mergeDesktopMetadata(batches);
  }
}

/** Catalog evidence outranks state evidence; owner availability is deliberately not an input. */
export function mergeDesktopMetadata(batches: DesktopMetadataBatch[]): {
  sessions: DesktopCatalogEntry[]; sources: DesktopMetadataSource[];
} {
  const entries = new Map<string, DesktopCatalogEntry>();
  const preferredSourceTimes = new Map<string, number>();
  const sources: DesktopMetadataSource[] = [];
  // Determine directory membership before admitting state-only rows.
  const normalized: Array<{ entry: DesktopCatalogEntry; stateEligible: boolean }> = [];
  for (const batch of batches) {
    try {
      const parsed = batch.source.status === "ok" ? batch.rows.map((row) => normalizeRow(row, batch)) : [];
      normalized.push(...parsed);
      sources.push(batch.source);
    } catch (error) {
      sources.push({ ...batch.source, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const catalogIds = new Set(normalized.filter(({ entry }) => entry.catalogMembership === "desktop_catalog").map(({ entry }) => entry.conversationId));
  for (const { entry, stateEligible } of normalized) {
    if (entry.catalogMembership === "state_metadata" && !stateEligible && !catalogIds.has(entry.conversationId)) continue;
    const previous = entries.get(entry.conversationId);
    if (!previous) {
      entries.set(entry.conversationId, entry);
      preferredSourceTimes.set(entry.conversationId, entry.updatedAtMs);
      continue;
    }
    const preferred = preferredEntry(entry, previous, preferredSourceTimes.get(entry.conversationId) ?? 0);
    if (preferred === entry) preferredSourceTimes.set(entry.conversationId, entry.updatedAtMs);
    entries.set(entry.conversationId, enrichPreferredEntry(preferred, previous, entry));
  }
  return { sources, sessions: [...entries.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs || compare(a.conversationId, b.conversationId)) };
}

function preferredEntry(entry: DesktopCatalogEntry, previous: DesktopCatalogEntry,
  previousSourceTime: number): DesktopCatalogEntry {
  if (entry.catalogMembership !== previous.catalogMembership) {
    return entry.catalogMembership === "desktop_catalog" ? entry : previous;
  }
  return entry.updatedAtMs > previousSourceTime ? entry : previous;
}

function enrichPreferredEntry(preferred: DesktopCatalogEntry, previous: DesktopCatalogEntry,
  entry: DesktopCatalogEntry): DesktopCatalogEntry {
  const other = preferred === entry ? previous : entry;
  return {
    ...preferred,
    updatedAtMs: Math.max(previous.updatedAtMs, entry.updatedAtMs),
    title: preferred.title || other.title,
    cwd: preferred.cwd ?? other.cwd,
    originator: preferred.originator ?? other.originator,
    projectId: preferred.projectId ?? other.projectId,
    threadSource: preferred.threadSource ?? other.threadSource,
    provenance: [...previous.provenance, ...entry.provenance]
  };
}

function normalizeRow(row: DesktopMetadataRow, batch: DesktopMetadataBatch): { entry: DesktopCatalogEntry; stateEligible: boolean } {
  const state = batch.source.kind === "state";
  const identity: DesktopThreadIdentity = {
    codexHome: canonicalHome(batch.source.codexHome),
    hostId: state ? "local" : requiredText(row.host_id, "host_id"),
    threadId: requiredText(state ? row.id : row.thread_id, "thread_id")
  };
  const sourceKind = normalizedSource(state ? row.source : row.source_kind);
  const threadSource = optionalText(row.thread_source);
  const title = metadataTitle(row, state);
  const updatedAtMs = metadataTimestamp(row, state);
  const catalogMembership = state ? "state_metadata" : "desktop_catalog";
  return {
    entry: {
      ...identity, conversationId: createDesktopConversationId(identity), title: title.slice(0, 160),
      cwd: optionalText(row.cwd), updatedAtMs, originator: optionalText(row.originator),
      projectId: optionalText(row.project_id), sourceKind, threadSource, catalogMembership, metadataOnly: true,
      localVerifiable: identity.hostId === "local" && (state || batch.hosts?.[identity.hostId] === "local") && sourceKind !== "chatgpt",
      provenance: [{ database: batch.source.database, table: state ? "threads" : "local_thread_catalog", sourceKind, threadSource }]
    },
    stateEligible: !state || eligibleStateRow(row, sourceKind, threadSource)
  };
}

function metadataTitle(row: DesktopMetadataRow, state: boolean): string {
  return state ? optionalText(row.name)?.trim() || optionalText(row.title) || "" : optionalText(row.display_title) || "";
}

function metadataTimestamp(row: DesktopMetadataRow, state: boolean): number {
  const updated = state ? row.updated_at_ms ?? (typeof row.updated_at === "number" ? row.updated_at * 1000 : null)
    : typeof row.source_updated_at === "number" ? row.source_updated_at * 1000 : null;
  if (typeof updated !== "number" || !Number.isFinite(updated) || updated < 0 || !Number.isSafeInteger(Math.round(updated))) {
    throw new Error("Invalid metadata timestamp");
  }
  return Math.round(updated);
}

function eligibleStateRow(row: DesktopMetadataRow, sourceKind: string | null, threadSource: string | null): boolean {
  return (row.archived === 0 || row.archived === false) && !optionalText(row.parent_thread_id) &&
    sourceKind !== "exec" && sourceKind !== "structured" && !sourceKind?.toLowerCase().startsWith("subagent") &&
    !["chatgpt_hidden", "ambient_suggestions", "pull_request_fix_automation"].includes(threadSource ?? "");
}

function normalizedSource(value: unknown): string | null {
  const source = optionalText(value);
  if (!source?.trim().startsWith("{")) return source;
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object") {
      if (Object.keys(parsed).some((key) => key.toLowerCase() === "subagent")) return "subagent";
      if (typeof parsed.custom === "string") return parsed.custom;
    }
  } catch { /* Unknown structured metadata is not proof of a root thread. */ }
  return "structured";
}
function canonicalHome(home: string): string {
  const absolute = path.resolve(home);
  try { return fs.realpathSync(absolute); } catch { return absolute; }
}
function requiredText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`Invalid metadata ${label}`);
  return text;
}
function optionalText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("Invalid metadata text field");
  return value || null;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function decodeCursor(cursor: string, query: string): { updatedAtMs: number; conversationId: string } {
  try {
    if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value.v !== 1 || value.q !== query || !Number.isSafeInteger(value.t) || typeof value.id !== "string") throw new Error();
    return { updatedAtMs: value.t, conversationId: value.id };
  } catch { throw new Error("Invalid Desktop catalog cursor or changed search/project filter"); }
}
