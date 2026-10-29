import { createHash } from "node:crypto";
import { arrayValue } from "./semantic-tool-value-helpers.js";
import { recordValue } from "./value-guards.js";
import { withConversationUsage } from "./conversation-usage-guidance.js";
import { compactListV5Row, resolveHostListProjectionVersion, type HostListProjectionVersion } from "./semantic-tool-list-format.js";

// A byte budget also bounds UTF-16 output and leaves room for Host envelopes.
// It is not a token budget, and does not reduce the native discovery/read cost.
export const HOST_LIST_MAX_BYTES = 24 * 1024;
export const HOST_LIST_MAX_WEIGHTED_CHARS = 12_000;
const ROW_MAX_BYTES = 8_000;
const FIELDS = ["conversations", "terminals", "codex_cli_sessions", "claude_cli_sessions", "desktop_sessions"] as const;
const FILTERS = ["agent", "status", "all", "noApprovalScan", "terminalDebug", "desktop_view", "desktopSearch", "desktopProject", "desktopCursor", "desktopLimit", "idleTimeoutMinutes"];
const ENDED = new Set(["idle", "completed", "timed_out", "unwatched", "closed", "cancelled", "interrupted", "exited", "settled"]);
const UNRESOLVED_CALLBACK = new Set(["uncertain", "failed", "pending", "ready", "leased", "retry_wait", "in_flight"]);
type Row = Record<string, unknown>;
type Entry = { field: string; row: Row; key: string; order: string };

export function parseHostListPageOptions(params: Row = {}) {
  if (params.all === true || (params.listView !== undefined && params.listView !== "current")) {
    throw new Error("List now returns conversations only; use agent_knock_knock_watches or akk watches for monitoring and history");
  }
  const view = "current";
  const projectionVersion = resolveHostListProjectionVersion(params.listProjectionVersion);
  const cursorVersion = projectionVersion === 4 ? 2 : 3;
  const limit = params.listLimit ?? 40;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("listLimit must be between 1 and 100");
  const filters = Object.fromEntries(FILTERS.filter(key => params[key] !== undefined).map(key => [key, params[key]]));
  // Keep existing v4 cursors usable; new cursors bind the selected format as well as filters.
  const scope = digest(JSON.stringify({ view, filters, ...(projectionVersion === 5 ? { projectionVersion } : {}) }));
  let after = "";
  if (params.listCursor !== undefined) {
    try {
      if (typeof params.listCursor !== "string" || params.listCursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(params.listCursor)) throw new Error();
      const cursor = JSON.parse(Buffer.from(params.listCursor, "base64url").toString("utf8"));
      if (cursor.version !== cursorVersion || cursor.scope !== scope || typeof cursor.after !== "string" || !/^[0-9]:[a-f0-9]{64}$/u.test(cursor.after)) throw new Error();
      after = cursor.after;
    } catch { throw new Error("Invalid List cursor or changed filters; restart List without listCursor"); }
  }
  return { view, limit: Number(limit), scope, after, filters, projectionVersion, cursorVersion };
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
  const { entries: selected, categoryCounts } = collectHostListEntries(projected);
  const position = options.after ? selected.findIndex(entry => entry.key === options.after) : -1;
  if (options.after && position < 0) throw new Error("List changed since this cursor; restart List without listCursor");
  const remaining = selected.slice(position + 1);
  const output = createHostListEnvelope(projected);
  const page: Row = { view: options.view, limit: options.limit, total_available: selected.length, returned: 0,
    has_more: false, next_cursor: null, counts: categoryCounts, max_output_bytes: HOST_LIST_MAX_BYTES,
    live_snapshot: true, note: "Follow next_args for remaining rows; refresh before acting. Counts describe this live discovery, not a frozen snapshot." };
  page.max_output_weighted_chars = HOST_LIST_MAX_WEIGHTED_CHARS;
  output.pagination = page;
  let returned = 0;
  for (const entry of remaining) {
    if (returned >= options.limit) break;
    const row = bytes(entry.row) > ROW_MAX_BYTES || hostListWeightedChars(JSON.stringify(entry.row)) > 6_000
      ? statusReference(entry.row, options.projectionVersion) : entry.row;
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
    page.next_cursor = hasMore && after ? Buffer.from(JSON.stringify({ version: options.cursorVersion, scope: options.scope, after })).toString("base64url") : null;
    page.next_args = page.next_cursor ? { ...options.filters, listView: options.view, listLimit: options.limit,
      listProjectionVersion: options.projectionVersion, listCursor: page.next_cursor } : null;
  }
}

/** Keep non-resource metadata bounded separately from paged rows. */
function createHostListEnvelope(projected: Row): Row {
  const output: Row = {};
  // List contains discoverable conversations; observation inventory has a separate command.
  if (projected.projection !== undefined) output.projection = projected.projection;
  for (const field of FIELDS) if (projected[field] !== undefined) output[field] = [];
  for (const [field, value] of Object.entries(projected)) {
    if (field !== "projection" && !FIELDS.includes(field as typeof FIELDS[number]) &&
        !field.endsWith("_watches") && !["managed_turns", "unavailable_managed_turns", "watch_summary"].includes(field)) output[field] = value;
  }
  // Diagnostic text is not an identity/action field; exceptionally large diagnostics are summarized.
  for (const key of Object.keys(output)) {
    if (key === "projection" || FIELDS.includes(key as typeof FIELDS[number]) || key === "pagination" || key === "watch_summary") continue;
    if (bytes(output[key]) > 1_500 || hostListWeightedChars(JSON.stringify(output[key])) > 1_000) output[key] = { details_omitted: true, reason: "list_output_budget", status: recordValue(output[key])?.status ?? "unknown", use: "exact Status or CLI diagnostics" };
  }
  return output;
}

/** Bound the entire conversation inventory, independent of retained observation count. */
function collectHostListEntries(projected: Row) {
  const entries: Entry[] = [];
  const categoryCounts: Record<string, number> = {};
  for (const field of FIELDS) {
    const rows = arrayValue(projected[field]);
    if (projected[field] !== undefined) categoryCounts[field] = rows.length;
    for (const row of rows) {
      const identity = String(row.conversation_id ?? row.id ?? JSON.stringify(row));
      const surface = row.surface === "desktop" || row.source === "codex_desktop" ? 1 : 0;
      const agent = row.agent === "codex" ? 0 : row.agent === "claude" ? 1 : 2;
      entries.push({ field, row, key: `0:${digest(`${field}:${identity}`)}`,
        order: `${String(FIELDS.indexOf(field)).padStart(2, "0")}:${surface}:${agent}:${identity}` });
    }
  }
  entries.sort((a, b) => a.order.localeCompare(b.order));
  return { entries, categoryCounts };
}

function statusReference(row: Row, version: HostListProjectionVersion): Row {
  const result: Row = {};
  for (const key of ["id", "conversation_id", "watch_id", "turn_id", "native_thread_id", "native_turn_id", "surface", "agent", "status", "activity_state", "connection_state",
    "management_state", "pending_interaction_count", "pending_manual_count", "pending_async_count", "callback_state", "callback_expected", "observation_active", "channel_delivery_state"]) {
    if (row[key] !== undefined) result[key] = row[key];
  }
  if (version === 5) for (const key of ["title", "cwd", "workspace", "sidebar_project_id", "sidebar_project_name"]) {
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
  return version === 5 ? compactListV5Row(result) : withConversationUsage(result);
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
