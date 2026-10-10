import { redactString } from "./runtime-log.js";

/** This is a budget for the single progress body, not for the enclosing Status JSON. */
export const DEFAULT_PUBLIC_PROGRESS_CODE_POINTS = 800;
const ACTION_CODE_POINTS = 200;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface BackendProgressItem {
  id: string;
  type: string;
  text?: string;
  phase?: string | null;
  delivery?: string | null;
  status?: unknown;
  exitCode?: unknown;
  /** Native item times only: never synthesize these from the read or turn time. */
  startedAtMs?: number | null;
  completedAtMs?: number | null;
}
export interface BackendProgressTurn {
  id?: string;
  turnId?: string;
  itemsComplete: boolean;
  items: BackendProgressItem[];
}
export type BackendProgressReadError = "read_failed" | "missing_exact_turn" | "incomplete_items" | "identity_mismatch";
export interface BackendPublicProgress {
  state: "available" | "no_public_progress" | "read_error";
  text: string;
  native_turn_id: string | null;
  read_at: string;
  latest_item_at: string | null;
  truncated: boolean;
  reason?: BackendProgressReadError;
}

/** Status-only projection. Callers must also verify the snapshot's exact thread identity. */
export function backendPublicProgress(options: {
  nativeTurnId: string | null;
  turn?: BackendProgressTurn;
  readAt: string;
}): BackendPublicProgress {
  const { nativeTurnId, turn, readAt } = options;
  if (nativeTurnId === null) {
    return turn ? backendPublicProgressReadError(null, readAt, "identity_mismatch") : emptyProgress(null, readAt);
  }
  if (!turn) return backendPublicProgressReadError(nativeTurnId, readAt, "missing_exact_turn");
  if ((turn.id ?? turn.turnId) !== nativeTurnId) return backendPublicProgressReadError(nativeTurnId, readAt, "identity_mismatch");
  if (!turn.itemsComplete) return backendPublicProgressReadError(nativeTurnId, readAt, "incomplete_items");

  // Only the latest explicitly public commentary is eligible. Final answers already
  // have response_text; unknown phases, reasoning, user input and tool output do not.
  const commentary = [...turn.items].reverse().find(item => item.type === "agentMessage" && item.phase === "commentary"
    && item.delivery !== "async" && typeof item.text === "string" && item.text.trim().length > 0);
  const actionItems = turn.items.filter(item => actionTitle(item) !== null).slice(-2);
  const actions = actionItems.map(item => actionTitle(item)!).join("\n");
  const clean = commentary ? redactPublicCommentary(commentary.text!) : { text: "", omitted: false };
  // Reserve up to 200 for the two action summaries; unused space belongs to commentary.
  const actionLimit = Math.max(ACTION_CODE_POINTS, DEFAULT_PUBLIC_PROGRESS_CODE_POINTS - codePoints(clean.text) - 1);
  const boundedActions = truncateAtGrapheme(actions, actionLimit, false);
  const separator = clean.text && boundedActions.text ? "\n" : "";
  const commentaryLimit = DEFAULT_PUBLIC_PROGRESS_CODE_POINTS - codePoints(boundedActions.text) - codePoints(separator);
  const boundedCommentary = truncateAtGrapheme(clean.text, commentaryLimit, true);
  const text = [boundedCommentary.text, boundedActions.text].filter(Boolean).join("\n");
  const selectedItems = [...(commentary && boundedCommentary.text ? [commentary] : []), ...actionItems];
  const times = selectedItems.flatMap(item => [item.startedAtMs, item.completedAtMs])
    .filter((time): time is number => validNativeItemTime(time));
  return { ...emptyProgress(nativeTurnId, readAt), state: text ? "available" : "no_public_progress", text,
    latest_item_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
    truncated: clean.omitted || boundedCommentary.truncated || boundedActions.truncated };
}

export function backendPublicProgressReadError(nativeTurnId: string | null, readAt: string,
  reason: BackendProgressReadError = "read_failed"): BackendPublicProgress {
  return { ...emptyProgress(nativeTurnId, readAt), state: "read_error", reason };
}

function emptyProgress(nativeTurnId: string | null, readAt: string): BackendPublicProgress {
  return { state: "no_public_progress", text: "", native_turn_id: nativeTurnId, read_at: readAt,
    latest_item_at: null, truncated: false };
}

export function validNativeItemTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function actionTitle(item: BackendProgressItem): string | null {
  // Static titles deliberately exclude command strings, tool arguments, paths,
  // diffs and tool results. Unknown item types never become progress implicitly.
  const titles: Record<string, string> = {
    commandExecution: "Command execution", fileChange: "File update", mcpToolCall: "Tool call",
    dynamicToolCall: "Tool call", webSearch: "Web search", imageGeneration: "Image generation",
    imageView: "Image view", plan: "Plan update", collabAgentToolCall: "Agent operation"
  };
  if (!Object.hasOwn(titles, item.type)) return null;
  const statuses: Record<string, string> = { inProgress: "in progress", completed: "completed", failed: "failed",
    interrupted: "interrupted", declined: "declined", pending: "pending" };
  const status = typeof item.status === "string" && Object.hasOwn(statuses, item.status) ? statuses[item.status] : "status unknown";
  const exit = item.type === "commandExecution" && Number.isSafeInteger(item.exitCode) ? ` (exit ${item.exitCode})` : "";
  return `${titles[item.type]}: ${status}${exit}`;
}

function redactPublicCommentary(text: string): { text: string; omitted: boolean } {
  const withoutCode = text.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/gu, "[code omitted]")
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/gu, "[code omitted]");
  const redacted = redactString(withoutCode)
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/gu, "npm_[REDACTED]")
    .replace(/(["']?\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/giu, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
  return { text: redacted, omitted: withoutCode !== text };
}

function codePoints(text: string): number {
  let count = 0; for (const _ of text) count += 1; return count;
}

/** Includes the ellipsis in the code-point budget and never splits a grapheme. */
function truncateAtGrapheme(text: string, limit: number, tail: boolean): { text: string; truncated: boolean } {
  if (codePoints(text) <= limit) return { text, truncated: false };
  if (limit < 1) return { text: "", truncated: true };
  const chosen: Array<{ text: string; size: number }> = []; let size = 0, start = 0;
  for (const part of segmenter.segment(text)) {
    const next = { text: part.segment, size: codePoints(part.segment) };
    if (!tail && size + next.size > limit - 1) break;
    chosen.push(next); size += next.size;
    while (size > limit - 1) size -= chosen[start++].size;
    // A long public message must not allocate one array entry per old grapheme.
    if (start > 1024) { chosen.splice(0, start); start = 0; }
  }
  const body = chosen.slice(start).map(part => part.text).join("");
  return { text: tail ? `…${body}` : `${body}…`, truncated: true };
}
