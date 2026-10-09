import path from "node:path";
import { createHash } from "node:crypto";
import { CodexNativeError, type CodexNativeThread, type CodexNativeTurn,
  type NativeInteraction, type CodexNativePermissions } from "./codex-native-types.js";
import type { CodexAppServerThreadItem } from "./codex-app-server-read-client.js";

export function nativeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) nativeInvalid("Invalid Codex native object");
  return value as Record<string, unknown>;
}
export function nativeId(value: unknown, limit = 512): string {
  if (typeof value !== "string" || !value.length || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) {
    nativeInvalid("Invalid Codex native identifier");
  }
  return value;
}
export function nativeInvalid(message: string): never { throw new CodexNativeError("invalid_response", message); }

export function parseNativeThread(value: unknown, expectedId: string): CodexNativeThread {
  const thread = nativeRecord(value);
  if (thread.id !== expectedId) nativeInvalid("Codex returned a different thread");
  nativeId(thread.sessionId);
  if (typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd)
    || !["legacy", "paginated"].includes(String(thread.historyMode)) || typeof thread.cliVersion !== "string"
    || (thread.originator !== null && typeof thread.originator !== "string") || !Array.isArray(thread.turns)) {
    nativeInvalid("Invalid Codex native thread metadata");
  }
  const status = nativeRecord(thread.status);
  if (!["idle", "active", "notLoaded", "systemError"].includes(String(status.type))
    || (status.type === "active" && (!Array.isArray(status.activeFlags) || status.activeFlags.some(f => typeof f !== "string")))) {
    nativeInvalid("Invalid Codex native thread status");
  }
  return thread as unknown as CodexNativeThread;
}

/** Metadata describes the thread's origin, not the currently running frontend version. */
export function isMainCodexCliThread(thread: CodexNativeThread): boolean {
  if (thread.parentThreadId != null || thread.canAcceptDirectInput === false) return false;
  if (thread.source && typeof thread.source === "object") return false;
  if (thread.threadSource != null && thread.threadSource !== "user") return false;
  return thread.originator === "codex-tui" || (thread.source === "cli" && thread.originator !== "codex-desktop");
}

export function parseNativeItem(value: unknown): CodexAppServerThreadItem {
  const item = nativeRecord(value); nativeId(item.id); nativeId(item.type);
  if (item.type === "userMessage") {
    if (!Array.isArray(item.content)) nativeInvalid("Invalid native user message");
    for (const part of item.content) {
      const p = nativeRecord(part); nativeId(p.type);
      if (p.type === "text" && typeof p.text !== "string") nativeInvalid("Invalid native user text");
    }
    if (item.clientId != null) nativeId(item.clientId);
  }
  if (item.type === "agentMessage") {
    if (typeof item.text !== "string") nativeInvalid("Invalid native agent text");
    if (item.delivery != null && item.delivery !== "async") nativeInvalid("Unknown native message delivery");
    if (item.questions != null) {
      if (!Array.isArray(item.questions) || item.questions.length > 64) nativeInvalid("Invalid native question list");
      for (const raw of item.questions) {
        const q = nativeRecord(raw);
        if (typeof q.title !== "string" || (q.options !== null
          && (!Array.isArray(q.options) || q.options.some(o => typeof o !== "string")))) nativeInvalid("Invalid native question");
      }
    }
  }
  return item as unknown as CodexAppServerThreadItem;
}
export function parseNativeTurn(value: unknown): CodexNativeTurn {
  const turn = nativeRecord(value); const id = nativeId(turn.id);
  if (!["inProgress", "completed", "failed", "interrupted"].includes(String(turn.status))
    || !Array.isArray(turn.items) || !["notLoaded", "summary", "full"].includes(String(turn.itemsView))) {
    nativeInvalid("Invalid native turn");
  }
  const items = turn.items.map(parseNativeItem);
  if (new Set(items.map(i => i.id)).size !== items.length) nativeInvalid("Duplicate native item identity");
  const error = turn.error == null ? undefined : nativeRecord(turn.error).message;
  if (error !== undefined && typeof error !== "string") nativeInvalid("Invalid native turn error");
  return { id, status: turn.status as CodexNativeTurn["status"], items,
    itemsComplete: turn.itemsView === "full", ...(typeof error === "string" ? { error } : {}) };
}
export function nativePage<T>(value: unknown, parse: (entry: unknown) => T): { data: T[]; nextCursor: string | null } {
  const page = nativeRecord(value);
  if (!Array.isArray(page.data) || page.data.length > 100) nativeInvalid("Invalid bounded native page");
  return { data: page.data.map(parse), nextCursor: page.nextCursor === null ? null : nativeId(page.nextCursor, 4096) };
}

export function nativeInteractionId(identity: unknown): string {
  return "codex-native-interaction:" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
export function nativeAsyncInteractions(threadId: string, turn: CodexNativeTurn): NativeInteraction[] {
  if (!turn.itemsComplete || turn.status !== "inProgress") return [];
  const answered = new Set<string>();
  for (const item of turn.items) {
    let text = nativeUserMessageText(item)?.trim();
    if (text?.startsWith("# Context from my IDE setup:\n")) {
      const marker = "\n## My request for Codex:\n", index = text.lastIndexOf(marker);
      if (index < 0) continue;
      text = text.slice(index + marker.length).trim();
    }
    const match = text && /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/u.exec(text);
    if (!match) continue;
    try {
      const raw: unknown = JSON.parse(match[1]); const replies = Array.isArray(raw) ? raw : [raw];
      for (const reply of replies) {
        const r = nativeRecord(reply);
        if (typeof r.questionItemId === "string" && typeof r.answer === "string") answered.add(r.questionItemId);
      }
    } catch { /* A normal user message is not an answer receipt. */ }
  }
  return turn.items.flatMap(item => item.type === "agentMessage" && item.delivery === "async"
    ? (item.questions ?? []).flatMap((q, index) => {
      const questionId = JSON.stringify(["request_user_input_async", item.id, index]);
      if (answered.has(questionId) || answered.has(item.id)) return [];
      return [{ id: nativeInteractionId([threadId, turn.id, item.id, questionId, q.title, q.options]),
        kind: "async_question" as const, threadId, turnId: turn.id, itemId: item.id,
        method: "request_user_input_async", questions: [{ id: questionId, title: q.title, options: q.options ?? [], isOther: true }] }];
    }) : []);
}
export function nativeUserMessageText(item: CodexAppServerThreadItem): string | null {
  return item.type === "userMessage" && item.content?.length === 1 && item.content[0].type === "text"
    && typeof item.content[0].text === "string" ? item.content[0].text : null;
}
export function findNativeSubmission(turns: CodexNativeTurn[], clientUserMessageId: string, text: string): CodexNativeTurn | null {
  const matches = turns.filter(t => t.itemsComplete && t.items.some(i => i.type === "userMessage"
    && i.clientId === clientUserMessageId && nativeUserMessageText(i) === text));
  return matches.length === 1 ? matches[0] : null;
}

export function parseNativePermissions(value: unknown): CodexNativePermissions {
  const raw = nativeRecord(value); const sandbox = nativeRecord(raw.sandbox ?? raw.sandboxPolicy);
  const profileId = raw.activePermissionProfile == null ? null : nativeId(nativeRecord(raw.activePermissionProfile).id);
  if (typeof raw.approvalsReviewer !== "string" || (typeof raw.approvalPolicy !== "string"
    && (!raw.approvalPolicy || typeof raw.approvalPolicy !== "object"))) nativeInvalid("Invalid native permission settings");
  const policy = raw.approvalPolicy;
  const preset = profileId === ":danger-full-access" && sandbox.type === "dangerFullAccess" && policy === "never" ? "full-access"
    : profileId === ":workspace" && sandbox.type === "workspaceWrite" && policy === "on-request" ? "default"
    : profileId === ":read-only" && sandbox.type === "readOnly" && policy === "on-request" ? "read-only" : "custom";
  return { preset, profileId, sandbox, approvalPolicy: policy, approvalsReviewer: raw.approvalsReviewer };
}
