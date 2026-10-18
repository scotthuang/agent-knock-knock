import { recordValue } from "./value-guards.js";

export const DEFAULT_WATCH_HISTORY_HOURS = 24;
export const WATCH_HISTORY_RETENTION_HOURS = 48;
export const WATCH_HISTORY_MAINTENANCE_INTERVAL_MS = 60 * 60_000;
export const WATCH_HISTORY_MAINTENANCE_BATCH = 100;

/** Raw durable records only; public List projections are not deletion authority. */
export function isHealthySettledWatch(value: unknown): boolean {
  const task = recordValue(value);
  if (!task || task.status !== "completed" || task.observation_error || task.waiting_for) return false;
  if (task.send_intent && recordValue(task.send_intent)?.state !== "accepted") return false;
  if (["pending_interactions", "pending_async_interactions"].some(key =>
    task[key] !== undefined && (!Array.isArray(task[key]) || task[key].length > 0))) return false;
  if (task.pending_manual_count !== undefined && task.pending_manual_count !== 0) return false;
  const interaction = recordValue(task.current_interaction);
  if (interaction && !["consumed", "superseded"].includes(String(recordValue(interaction.aggregate)?.state))) return false;
  const terminal = task.schema === "agent-knock-knock/terminal-watch";
  const notes = terminal ? task.notification_outbox : task.notifications;
  if (!Array.isArray(notes)) return false;
  // A configured callback without a completion receipt is not successfully settled.
  if ((terminal || task.callback_route) && !notes.some(value => {
    const note = recordValue(value);
    return terminal ? note?.kind === "completed" && note.status === "delivered"
      : String(recordValue(recordValue(note?.envelope)?.event)?.type).endsWith(".settled");
  })) return false;
  return notes.every(value => {
    const note = recordValue(value);
    if (!note) return false;
    if (terminal) return note.status === "superseded" || note.status === "delivered" && validTime(note.delivered_at);
    return note.status === "accepted" && recordValue(note.outcome)?.disposition === "accepted" &&
      validTime(recordValue(note.outcome)?.accepted_at);
  });
}

/** Completion and callback receipts are business clocks; poll timestamps are not. */
export function watchHistorySettledAt(value: unknown): string | undefined {
  const task = recordValue(value);
  if (!task || !isHealthySettledWatch(task)) return undefined;
  const terminal = task.schema === "agent-knock-knock/terminal-watch";
  const completion = terminal ? recordValue(task.settlement)?.observed_at : task.observed_at;
  // Old schemas without a settlement clock use their last write conservatively.
  const clocks = [validTime(completion) ? completion : task.updated_at, task.created_at, task.closed_at, task.unwatched_at];
  for (const value of (terminal ? task.notification_outbox : task.notifications) as unknown[]) {
    const note = recordValue(value)!;
    clocks.push(terminal ? note.delivered_at ?? note.superseded_at : recordValue(note.outcome)?.accepted_at);
  }
  const times = clocks.filter(validTime).map(value => Date.parse(value));
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
}

export function watchHistoryExpired(value: unknown, now: Date): boolean {
  const settledAt = watchHistorySettledAt(value);
  return settledAt !== undefined && now.getTime() - Date.parse(settledAt) >= WATCH_HISTORY_RETENTION_HOURS * 3_600_000;
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
