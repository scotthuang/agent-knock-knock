import { createHash } from "node:crypto";
import { arrayValue } from "./semantic-tool-value-helpers.js";
import { recordValue } from "./value-guards.js";

// A byte budget also bounds UTF-16 output and leaves room for Host envelopes.
// It is not a token budget, and does not reduce the native discovery/read cost.
export const HOST_LIST_MAX_BYTES = 24 * 1024;
export const HOST_LIST_MAX_WEIGHTED_CHARS = 12_000;
const ROW_MAX_BYTES = 8_000;
const FIELDS = ["conversations", "terminals", "codex_cli_sessions", "claude_cli_sessions", "desktop_sessions",
  "managed_turns", "unavailable_managed_turns", "terminal_watches", "codex_cli_watches", "claude_cli_watches", "desktop_watches"] as const;
const FILTERS = ["agent", "status", "all", "noApprovalScan", "terminalDebug", "desktop_view", "desktopSearch", "desktopProject", "desktopCursor", "desktopLimit", "idleTimeoutMinutes"];
const ENDED = new Set(["idle", "completed", "timed_out", "unwatched", "closed", "cancelled", "interrupted", "exited", "settled"]);
const UNRESOLVED_CALLBACK = new Set(["uncertain", "failed", "pending", "ready", "leased", "retry_wait", "in_flight"]);
type Row = Record<string, unknown>;
type Entry = { field: string; row: Row; key: string; order: string; history: boolean };
type View = "current" | "history" | "all";

export function parseHostListPageOptions(params: Row = {}) {
  const view = params.listView ?? (params.all === true ? "all" : "current");
  if (!["current", "history", "all"].includes(String(view))) throw new Error("listView must be current, history or all");
  const limit = params.listLimit ?? 40;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("listLimit must be between 1 and 100");
  const filters = Object.fromEntries(FILTERS.filter(key => params[key] !== undefined).map(key => [key, params[key]]));
  const scope = digest(JSON.stringify({ view, filters }));
  let after = "";
  if (params.listCursor !== undefined) {
    try {
      if (typeof params.listCursor !== "string" || params.listCursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(params.listCursor)) throw new Error();
      const cursor = JSON.parse(Buffer.from(params.listCursor, "base64url").toString("utf8"));
      if (cursor.version !== 1 || cursor.scope !== scope || typeof cursor.after !== "string" || !/^[0-9]:[a-f0-9]{64}$/u.test(cursor.after)) throw new Error();
      after = cursor.after;
    } catch { throw new Error("Invalid List cursor or changed filters; restart List without listCursor"); }
  }
  return { view: view as View, limit: Number(limit), scope, after, filters };
}

/** Healthy ended observations are history. Unknown/failed delivery and pending interaction stay current. */
export function hostListWatchNeedsAttention(row: Row): boolean {
  return !ENDED.has(String(row.status)) || row.observation_active === true || row.callback_expected === true ||
    row.callback_in_flight === true || hasUnresolvedCallback(row) || hasPendingInteraction(row) || Boolean(row.observation_error);
}

function hasUnresolvedCallback(row: Row): boolean {
  if (UNRESOLVED_CALLBACK.has(String(row.callback_state))) return true;
  if (Array.isArray(row.retryable_callback_ids) && row.retryable_callback_ids.length) return true;
  if (arrayValue(row.callback_notifications).some(note => UNRESOLVED_CALLBACK.has(String(note.status)))) return true;
  const delivery = recordValue(row.callback_delivery);
  if (delivery && (UNRESOLVED_CALLBACK.has(String(delivery.status)) || ["uncertain", "in_flight", "retryable"].includes(String(delivery.attempt_state)))) return true;
  const callback = recordValue(row.callback);
  return Boolean(callback && (Number(callback.pending) > 0 || Number(callback.failed) > 0 || callback.last_error_code));
}

function hasPendingInteraction(row: Row): boolean {
  if (["pending_manual_count", "pending_async_count", "pending_interaction_count"].some(key => Number(row[key]) > 0)) return true;
  const approval = recordValue(row.approval_state);
  if (approval?.blocked === true || approval?.approvable === true) return true;
  const interaction = recordValue(row.interaction_state);
  return Boolean(interaction && !["none", "resolved", "answered", "closed"].includes(String(interaction.state)));
}

/** Limit the whole model-facing result before serialization, never truncate JSON text. */
export function paginateHostList(projected: Row, params: Row = {}): Row {
  const options = parseHostListPageOptions(params);
  extractManagedHistory(projected);
  const { entries, watchCounts, managedCounts, attention, categoryCounts } = collectHostListEntries(projected);
  const selected = entries.filter(entry => options.view === "all" || (options.view === "history" ? entry.history : !entry.history));
  const position = options.after ? selected.findIndex(entry => entry.key === options.after) : -1;
  if (options.after && position < 0) throw new Error("List changed since this cursor; restart List without listCursor");
  const remaining = selected.slice(position + 1);
  const output = createHostListEnvelope(projected);
  output.watch_summary = { ...watchCounts, history_included: options.view !== "current",
    history_query: { ...options.filters, listView: "history" }, note: "Watches are observations, not additional conversations. Omitted history is not missing monitoring; use exact Status for details." };
  const page: Row = { view: options.view, limit: options.limit, total_available: selected.length, returned: 0,
    has_more: false, next_cursor: null, counts: categoryCounts, max_output_bytes: HOST_LIST_MAX_BYTES,
    live_snapshot: true, note: "Follow next_args for remaining rows; refresh before acting. Counts describe this live discovery, not a frozen snapshot." };
  page.managed_turns = managedCounts;
  page.attention_counts = attention;
  page.attention_counts_scope = "all observed Watches and separate managed rows; categories may overlap";
  page.max_output_weighted_chars = HOST_LIST_MAX_WEIGHTED_CHARS;
  output.pagination = page;
  let returned = 0;
  for (const entry of remaining) {
    if (returned >= options.limit) break;
    const row = bytes(entry.row) > ROW_MAX_BYTES || hostListWeightedChars(JSON.stringify(entry.row)) > 6_000
      ? statusReference(entry.row) : entry.row;
    const rows = output[entry.field] as Row[];
    rows.push(row);
    updatePage(returned + 1, entry.key);
    if (overBudget(output)) { rows.pop(); break; }
    returned++;
  }
  const last = remaining[returned - 1];
  updatePage(returned, last?.key ?? options.after);
  if (!returned && remaining.length) throw new Error("List identity or metadata exceeds the response budget; use exact Status or CLI diagnostics");
  if (overBudget(output)) throw new Error("List metadata exceeds the response budget; narrow List filters");
  return output;

  function updatePage(count: number, after: string) {
    const hasMore = count < remaining.length;
    page.returned = count; page.has_more = hasMore;
    page.remaining = remaining.length - count;
    page.next_cursor = hasMore && after ? Buffer.from(JSON.stringify({ version: 1, scope: options.scope, after })).toString("base64url") : null;
    page.next_args = page.next_cursor ? { ...options.filters, listView: options.view, listLimit: options.limit, listCursor: page.next_cursor } : null;
  }
}

/** Keep non-resource metadata bounded separately from paged rows. */
function createHostListEnvelope(projected: Row): Row {
  const output: Row = {};
  // Conversations are always the first resource field, ahead of observation records.
  if (projected.projection !== undefined) output.projection = projected.projection;
  for (const field of FIELDS) if (projected[field] !== undefined) output[field] = [];
  for (const [field, value] of Object.entries(projected)) {
    if (field !== "projection" && !FIELDS.includes(field as typeof FIELDS[number])) output[field] = value;
  }
  // Diagnostic text is not an identity/action field; exceptionally large diagnostics are summarized.
  for (const key of Object.keys(output)) {
    if (key === "projection" || FIELDS.includes(key as typeof FIELDS[number]) || key === "pagination" || key === "watch_summary") continue;
    if (bytes(output[key]) > 1_500 || hostListWeightedChars(JSON.stringify(output[key])) > 1_000) output[key] = { details_omitted: true, reason: "list_output_budget", status: recordValue(output[key])?.status ?? "unknown", use: "exact Status or CLI diagnostics" };
  }
  return output;
}

/** Build complete inventory/attention counts independently of page and output budgets. */
function collectHostListEntries(projected: Row) {
  const entries: Entry[] = [];
  const watchCounts = { total: 0, current: 0, history: 0 };
  const managedCounts = { total: 0, current: 0, history: 0 };
  const attention = { failed_callback: 0, uncertain_callback: 0, pending_callback: 0, pending_interaction: 0, observation_error: 0 };
  const categoryCounts: Record<string, number> = {};
  for (const field of FIELDS) {
    const rows = arrayValue(projected[field]);
    if (projected[field] !== undefined) categoryCounts[field] = rows.length;
    const watch = field.endsWith("_watches");
    const managed = field === "managed_turns" || field === "unavailable_managed_turns";
    for (const row of rows) {
      const history = (watch || managed) && !hostListWatchNeedsAttention(row);
      if (managed) { managedCounts.total++; managedCounts[history ? "history" : "current"]++; }
      if (watch) { watchCounts.total++; watchCounts[history ? "history" : "current"]++; }
      if (watch || managed) recordAttentionCounts(row, attention);
      entries.push(hostListEntry(field, row, history));
    }
  }
  entries.sort((a, b) => a.order.localeCompare(b.order));
  return { entries, watchCounts, managedCounts, attention, categoryCounts };
}

function recordAttentionCounts(row: Row, attention: Record<string, number>): void {
  const callback = recordValue(row.callback), delivery = recordValue(row.callback_delivery);
  const states = [String(row.callback_state), String(delivery?.status), String(delivery?.attempt_state),
    ...arrayValue(row.callback_notifications).map(note => String(note.status))];
  if (states.includes("failed") || Number(callback?.failed) > 0) attention.failed_callback++;
  if (states.includes("uncertain")) attention.uncertain_callback++;
  if (states.some(state => ["pending", "ready", "leased", "retry_wait", "in_flight"].includes(state)) || Number(callback?.pending) > 0) attention.pending_callback++;
  if (["pending_manual_count", "pending_async_count", "pending_interaction_count"].some(key => Number(row[key]) > 0) ||
      recordValue(row.interaction_state)?.state === "pending") attention.pending_interaction++;
  if (row.observation_error) attention.observation_error++;
}

function hostListEntry(field: typeof FIELDS[number], row: Row, history: boolean): Entry {
  const id = row.watch_id ?? row.turn_id ?? row.conversation_id ?? row.id;
  const rank = field === "conversations" || field === "terminals" || field.endsWith("_sessions") ? 0 : history ? 2 : 1;
  const identity = String(id ?? JSON.stringify(row));
  const surface = row.surface === "desktop" || row.source === "codex_desktop" ? 1 : 0;
  const agent = row.agent === "codex" ? 0 : row.agent === "claude" ? 1 : 2;
  return { field, row, history, key: `${rank}:${digest(`${field}:${identity}`)}`,
    order: `${rank}:${String(FIELDS.indexOf(field)).padStart(2, "0")}:${surface}:${agent}:${identity}` };
}

function extractManagedHistory(projected: Row): void {
  const turns = new Map<string, Row>();
  function visit(row: Row, parentId?: unknown) {
    const managed = recordValue(row.managed);
    if (managed) {
      const history = arrayValue(managed.history);
      const recent = recordValue(managed.recent_turn);
      for (const turn of [...(recent ? [recent] : []), ...history]) {
        const id = turn.turn_id ?? turn.conversation_id ?? turn.id;
        if (typeof id === "string") turns.set(id, { ...turn, parent_conversation_id: parentId });
      }
      managed.history_count = history.length;
      managed.history_details = "managed_turns pages";
      delete managed.history;
    }
    for (const field of ["terminal_controls", "control_records"]) for (const control of arrayValue(row[field])) visit(control, parentId);
  }
  for (const field of ["conversations", "terminals", "codex_cli_sessions", "claude_cli_sessions"]) {
    for (const row of arrayValue(projected[field])) visit(row, row.conversation_id ?? row.id);
  }
  if (turns.size) projected.managed_turns = [...turns.values()];
}

function statusReference(row: Row): Row {
  const result: Row = {};
  for (const key of ["id", "conversation_id", "watch_id", "turn_id", "native_thread_id", "native_turn_id", "surface", "agent", "status", "activity_state", "connection_state",
    "management_state", "pending_interaction_count", "pending_manual_count", "pending_async_count", "callback_state", "callback_expected", "observation_active", "channel_delivery_state"]) {
    if (row[key] !== undefined) result[key] = row[key];
  }
  const delivery = recordValue(row.callback_delivery);
  if (delivery) result.callback_delivery = delivery;
  const callback = recordValue(row.callback);
  if (callback) result.callback = callback;
  result.details_omitted = true;
  result.detail_reason = "list_row_budget";
  result.attention_required = hostListWatchNeedsAttention(row);
  result.available_actions = { status: true };
  const id = row.watch_id ? { watch_id: row.watch_id } : row.turn_id ? { turn_id: row.turn_id } : { conversation_id: row.conversation_id ?? row.id };
  result.action_inputs = { status: { arguments: id } };
  result.next_action = "Read exact Status for current actions and interaction/callback details; omitted actions are not unsupported.";
  return result;
}
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8"); }

// Conservatively cap model output even when a Host weights Unicode more heavily than UTF-8.
export function hostListWeightedChars(text: string): number {
  let weight = 0;
  for (const char of text) weight += char.codePointAt(0)! <= 0x7f ? 1 : 16;
  return weight;
}
function overBudget(value: unknown): boolean {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, "utf8") > HOST_LIST_MAX_BYTES || hostListWeightedChars(json) > HOST_LIST_MAX_WEIGHTED_CHARS;
}
