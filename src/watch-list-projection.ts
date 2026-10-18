import { createHash } from "node:crypto";
import { DEFAULT_WATCH_HISTORY_HOURS, WATCH_HISTORY_RETENTION_HOURS } from "./watch-history-policy.js";
import { HOST_LIST_MAX_BYTES, HOST_LIST_MAX_WEIGHTED_CHARS, hostListWatchNeedsAttention, hostListWeightedChars } from "./semantic-tool-list-budget.js";
import { recordValue } from "./value-guards.js";

type Row = Record<string, unknown>;
export interface WatchListInventory { watches: Row[]; managed_turns: Row[]; diagnostics?: Row[] }
const scalarFields = ["watch_id", "turn_id", "id", "short_ref", "conversation_id", "terminal_id", "session_id", "native_thread_id", "native_turn_id", "native_input_id", "native_receipt_turn_id",
  "source", "agent", "workspace", "status", "observation_status", "observation_state", "renewal_count", "renewed_at", "recovered_at", "observation_mode", "watch_mode", "confidence", "anchor_state", "task_kind", "management_state",
  "created_at", "updated_at", "observed_at", "last_activity_at", "deadline_at", "hard_timeout_at", "closed_at", "unwatched_at",
  "callback_configured", "callback_expected", "callback_in_flight", "callback_state", "callback_delivery_scope", "channel_delivery_state",
  "pending_manual_count", "pending_async_count", "pending_interaction_count", "observation_error", "observation_active", "send_state", "submission_state"];

export function parseWatchListOptions(params: Row = {}, nowMs = Date.now()) {
  const hours = integer(params.hours, DEFAULT_WATCH_HISTORY_HOURS, 1, WATCH_HISTORY_RETENTION_HOURS, "hours");
  const limit = integer(params.limit, 40, 1, 100, "limit");
  const filters: Row = { hours };
  for (const key of ["agent", "status", "conversation_id"]) {
    if (params[key] === undefined) continue;
    if (typeof params[key] !== "string" || !params[key].trim() || params[key].length > 2048) throw new Error(`Invalid Watches ${key}`);
    filters[key] = params[key];
  }
  if (filters.agent !== undefined && !["codex", "claude"].includes(String(filters.agent))) throw new Error("Watches agent must be codex or claude");
  const scope = digest(JSON.stringify(filters));
  const { asOf, after } = parseWatchListCursor(params.cursor, scope, nowMs);
  return { hours, limit, filters, scope, asOf, after, since: asOf - hours * 3_600_000 };
}

/** Bind pagination to the original time window and exact normalized filters. */
function parseWatchListCursor(value: unknown, scope: string, nowMs: number): { asOf: number; after: string } {
  if (value === undefined) return { asOf: nowMs, after: "" };
  try {
    if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed.version !== 1 || parsed.scope !== scope || !Number.isSafeInteger(parsed.as_of) || parsed.as_of < 0 || parsed.as_of > nowMs ||
      typeof parsed.after !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.after)) throw new Error();
    return { asOf: parsed.as_of, after: parsed.after };
  } catch { throw new Error("Invalid Watches cursor or changed filters; restart watches without cursor"); }
}

/** Only public summaries cross this boundary; request text, output and authority never do. */
export function projectWatchList(inventory: WatchListInventory, params: Row = {}, nowMs = Date.now()): Row {
  const options = parseWatchListOptions(params, nowMs);
  const entries = ([...inventory.watches.map(row => ({ row, kind: "watch" })),
    ...inventory.managed_turns.map(row => ({ row, kind: "managed_turn" }))]).flatMap(({ row, kind }) => {
    if (options.filters.agent && row.agent !== options.filters.agent || options.filters.status && row.status !== options.filters.status ||
      options.filters.conversation_id && ![row.conversation_id, row.terminal_id, row.session_id].includes(options.filters.conversation_id)) return [];
    const attention = hostListWatchNeedsAttention(row);
    const time = latestTime(row);
    const within = time !== undefined && time >= options.since && time <= options.asOf;
    if (!within && !attention) return [];
    const id = row.watch_id ?? row.turn_id;
    if (typeof id !== "string" || !id) return [];
    return [{ row, kind, attention, within, time, key: digest(`${kind}:${id}`) }];
  }).sort((a, b) => Number(b.attention) - Number(a.attention) || (b.time ?? 0) - (a.time ?? 0) || a.key.localeCompare(b.key));
  const index = options.after ? entries.findIndex(entry => entry.key === options.after) : -1;
  if (options.after && index < 0) throw new Error("Watches changed since this cursor; restart watches without cursor");
  const remaining = entries.slice(index + 1);
  const output: Row = {
    projection: { schema: "agent-knock-knock/watch-list", version: 1 },
    watches: [], managed_turns: [],
    window: { hours: options.hours, since: new Date(options.since).toISOString(), as_of: new Date(options.asOf).toISOString(),
      includes_older_attention: true, note: "Active or unresolved records remain visible outside the history window. Managed Turns are not Watches." },
    read_at: new Date(nowMs).toISOString(),
    diagnostics: (inventory.diagnostics ?? []).map(row => ({ provider: row.provider, status: row.status, invalid_records: row.invalid_records })),
    pagination: { limit: options.limit, total_available: entries.length, attention: entries.filter(entry => entry.attention).length,
      max_output_bytes: HOST_LIST_MAX_BYTES, max_output_weighted_chars: HOST_LIST_MAX_WEIGHTED_CHARS,
      live_snapshot: true, note: "Window boundaries stay fixed across pages; record states may change. Exact Status returns current details and recovery actions." }
  };
  let returned = 0;
  update();
  for (const entry of remaining) {
    if (returned >= options.limit) break;
    const target = output[entry.kind === "watch" ? "watches" : "managed_turns"] as Row[];
    target.push(compactWatch(entry.row, entry.kind, entry.attention, entry.within));
    returned++; update();
    if (overBudget(output)) { target.pop(); returned--; update(); break; }
  }
  if (!returned && remaining.length) throw new Error("Watch identity exceeds the response budget; use exact Status");
  if (overBudget(output)) throw new Error("Watches metadata exceeds the response budget");
  return output;
  function update() {
    const more = returned < remaining.length;
    const last = remaining[returned - 1]?.key;
    const cursor = more && last ? Buffer.from(JSON.stringify({ version: 1, scope: options.scope, as_of: options.asOf, after: last })).toString("base64url") : null;
    Object.assign(output.pagination as Row, { returned, has_more: more, remaining: remaining.length - returned, next_cursor: cursor,
      next_args: cursor ? { ...options.filters, limit: options.limit, cursor } : null });
  }
}

function compactWatch(row: Row, kind: string, attention: boolean, within: boolean): Row {
  const output: Row = { kind, attention_required: attention, outside_window: !within };
  for (const key of scalarFields) if (["string", "number", "boolean"].includes(typeof row[key]) || row[key] === null) output[key] = row[key];
  const delivery = recordValue(row.callback_delivery);
  if (delivery) output.callback_delivery = pick(delivery, ["status", "attempts", "attempt_state", "next_attempt_at"]);
  const callback = recordValue(row.callback);
  if (callback) output.callback = pick(callback, ["pending", "delivered", "failed", "superseded", "last_error_code"]);
  const notifications = Array.isArray(row.callback_notifications) ? row.callback_notifications : [];
  if (notifications.length) {
    const statuses: Record<string, number> = {};
    for (const note of notifications) {
      const status = recordValue(note)?.status;
      if (typeof status === "string" && ["accepted", "uncertain", "failed", "ready", "leased", "retry_wait"].includes(status)) statuses[status] = (statuses[status] ?? 0) + 1;
    }
    output.callback_notifications = { total: notifications.length, statuses };
  }
  const input = kind === "watch" ? { watch_id: row.watch_id } : { turn_id: row.turn_id };
  const actions = recordValue(row.available_actions) ?? {};
  output.available_actions = kind === "managed_turn"
    ? Object.fromEntries(["status", "retry_callback", "close"].filter(name => recordValue(actions[name])).map(name => [name, actions[name]]))
    : { status: true };
  if (kind !== "managed_turn" || !Object.keys(output.available_actions as Row).length) {
    output.available_actions = { status: true };
    output.action_inputs = { status: { arguments: input } };
  }
  output.detail_tool = "agent_knock_knock_status";
  return output;
}
function pick(row: Row, keys: string[]): Row { return Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]])); }
function latestTime(row: Row): number | undefined {
  const times = ["updated_at", "observed_at", "last_activity_at", "closed_at", "unwatched_at", "created_at"].map(key =>
    typeof row[key] === "string" ? Date.parse(row[key]) : NaN).filter(Number.isFinite);
  const settlement = recordValue(row.settlement);
  if (typeof settlement?.observed_at === "string" && Number.isFinite(Date.parse(settlement.observed_at))) times.push(Date.parse(settlement.observed_at));
  return times.length ? Math.max(...times) : undefined;
}
function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const number = value === undefined ? fallback : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < min || Number(number) > max) throw new Error(`Watches ${name} must be between ${min} and ${max}`);
  return Number(number);
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function overBudget(value: unknown): boolean {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, "utf8") > HOST_LIST_MAX_BYTES || hostListWeightedChars(json) > HOST_LIST_MAX_WEIGHTED_CHARS;
}
