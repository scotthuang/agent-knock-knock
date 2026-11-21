import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isPublicAgentMessage, validNativeItemTime } from "./backend-public-progress.js";
import type { CodexAppServerThreadItem } from "./codex-app-server-read-client.js";
import { CodexNativeRpc } from "./codex-native-client-rpc.js";
import { nativeId, nativePage, nativeRecord, parseNativeThread, parseNativeTurn } from "./codex-native-snapshot.js";
import { readDesktopSocketIdentity } from "./desktop-ipc-transport.js";
import { desktopUserMessageText } from "./desktop-snapshot.js";
import { DesktopIpcError, type DesktopThreadIdentity, type DesktopTurn, type DesktopTurnItem } from "./desktop-types.js";

interface Submission { clientUserMessageId: string; prompt: string }
type DesktopQueueObservation = { state: "matched"; turn: DesktopTurn }
  | { state: "pending" | "uncertain"; reason: string };

const PAGE_SIZE = 8;
const MAX_PAGES = 8;

/** Current Codex may use a private, owner-created symlink to a shorter private Unix socket. */
export function desktopQueueSocketIdentity(socketPath: string): string {
  const directory = fs.lstatSync(path.dirname(socketPath), { bigint: true });
  const alias = fs.lstatSync(socketPath, { bigint: true });
  const uid = process.getuid?.();
  if (uid === undefined || directory.uid !== BigInt(uid) || !directory.isDirectory() ||
      (directory.mode & 0o077n) !== 0n || alias.uid !== directory.uid) {
    throw new DesktopIpcError("unsafe_socket", "Shared backend socket is outside a private user-owned endpoint");
  }
  const real = fs.realpathSync(socketPath);
  return [directory.dev, directory.ino, alias.dev, alias.ino, alias.ctimeNs, real,
    readDesktopSocketIdentity(real)].join(":");
}

async function withQueue<T>(target: DesktopThreadIdentity, use: (rpc: CodexNativeRpc, check: () => void) => Promise<T>): Promise<T> {
  if (target.hostId !== "local" || !path.isAbsolute(target.codexHome)) {
    throw new DesktopIpcError("invalid_argument", "Desktop queue requires an exact local target");
  }
  nativeId(target.threadId);
  const socket = path.join(target.codexHome, "app-server-control", "app-server-control.sock");
  const baseline = desktopQueueSocketIdentity(socket);
  const check = () => {
    if (desktopQueueSocketIdentity(socket) !== baseline) throw new DesktopIpcError("unsafe_socket", "Shared backend endpoint changed");
  };
  const rpc = await CodexNativeRpc.connect({ codexHome: target.codexHome, timeoutMs: 5_000 });
  try { check(); return await use(rpc, check); }
  finally { rpc.close(); }
}

async function threadMetadata(rpc: CodexNativeRpc, threadId: string, expectedCwd?: string) {
  const result = nativeRecord(await rpc.call("thread/read", { threadId, includeTurns: false }));
  const thread = parseNativeThread(result.thread, threadId);
  const allowed = expectedCwd ? thread.cwd === expectedCwd && ["notLoaded", "idle", "active"].includes(thread.status.type) : thread.status.type === "notLoaded";
  if (thread.historyMode !== "paginated" || !allowed ||
      thread.threadSource !== "user" || thread.parentThreadId != null || thread.attachedToThreadId != null ||
      thread.canAcceptDirectInput === false) {
    throw new DesktopIpcError("no_live_owner", "Shared daemon cannot act as this Desktop history reader");
  }
  return thread;
}

function userInputs(value: unknown): { type: string; text?: string }[] {
  if (!Array.isArray(value)) throw new DesktopIpcError("invalid_response", "Invalid native user input");
  return value.map(entry => {
    const part = nativeRecord(entry);
    if (part.type !== "text") return { type: nativeId(part.type) };
    if (typeof part.text !== "string") throw new DesktopIpcError("invalid_response", "Invalid native text input");
    // Embedded UI tokens can make visibly identical text a different instruction.
    for (const key of ["text_elements", "textElements"]) {
      if (key in part && (!Array.isArray(part[key]) || part[key].length)) return { type: "annotatedText" };
    }
    return { type: "text", text: part.text };
  });
}

function projectItem(raw: CodexAppServerThreadItem): DesktopTurnItem {
  const item: DesktopTurnItem = { id: raw.id, type: raw.type };
  if (raw.type === "userMessage") { item.clientId = raw.clientId; item.content = userInputs(raw.content); }
  if (isPublicAgentMessage(raw)) {
    if (raw.delivery !== "async" && !raw.questions?.length && (raw.phase === "commentary" || raw.phase === "final_answer")) {
      item.text = raw.text; item.phase = raw.phase;
    }
  }
  if (typeof raw.status === "string" && ["inProgress", "completed", "failed", "interrupted", "declined", "pending"].includes(raw.status)) item.status = raw.status;
  if (validNativeItemTime(raw.startedAtMs)) item.startedAtMs = raw.startedAtMs;
  if (validNativeItemTime(raw.completedAtMs)) item.completedAtMs = raw.completedAtMs;
  return item;
}

/** IDs and full user inputs exist only while matching native items in memory. */
function publicTurn(turn: DesktopTurn): DesktopTurn {
  const actionTypes = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch",
    "imageGeneration", "imageView", "plan", "collabAgentToolCall"]);
  return { ...turn, items: turn.items.filter(item =>
    item.type === "agentMessage" ? typeof item.text === "string" : actionTypes.has(item.type)) };
}

function projectTurn(value: unknown): DesktopTurn {
  const raw = nativeRecord(value);
  const turn = parseNativeTurn(raw);
  if (!turn.itemsComplete) throw new DesktopIpcError("invalid_response", "Desktop queue history omitted full items");
  // The non-owner daemon can transiently synthesize an interrupted row with no completion time.
  const terminal = typeof raw.completedAt === "number" && Number.isSafeInteger(raw.completedAt) && raw.completedAt > 0;
  const status = turn.status === "inProgress" || terminal ? turn.status : "unknown";
  return { turnId: turn.id, status, itemsComplete: true, items: turn.items.map(projectItem),
    ...(turn.status === "failed" ? { error: "Native Desktop task failed" } : {}) };
}

async function turnsPage(rpc: CodexNativeRpc, threadId: string, limit: number, cursor?: string) {
  const page = nativePage(await rpc.call("thread/turns/list", {
    threadId, sortDirection: "desc", itemsView: "full", limit, ...(cursor ? { cursor } : {})
  }), projectTurn);
  if (!page.data.length && page.nextCursor !== null) throw new DesktopIpcError("invalid_response", "Empty Desktop history page claims a continuation");
  if (page.data.length > limit) throw new DesktopIpcError("invalid_response", "Desktop queue history exceeded the requested limit");
  return page;
}

export function readDesktopLatestPersistedTurn(target: DesktopThreadIdentity) {
  return withQueue(target, async (rpc, check) => {
    const thread = await threadMetadata(rpc, target.threadId);
    const page = await turnsPage(rpc, target.threadId, 1);
    check();
    const latest = page.data[0];
    return { cwd: thread.cwd, latestTurn: latest ? publicTurn(latest) : null };
  });
}

function matchTurns(turns: DesktopTurn[], input: Submission): DesktopQueueObservation {
  let match: DesktopTurn | undefined;
  for (const turn of turns) {
    const user = turn.items.filter(item => item.type === "userMessage");
    if (!user.some(item => item.clientId === input.clientUserMessageId)) continue;
    if (match || user.length !== 1 || turn.items[0] !== user[0] || desktopUserMessageText(user[0]) !== input.prompt ||
        turn.items.some(item => item.type === "steered" || item.type === "steeringUserMessage")) {
      return { state: "uncertain", reason: "desktop_queue_submission_conflict" };
    }
    match = turn;
  }
  return match ? { state: "matched", turn: publicTurn(match) } : { state: "pending", reason: "desktop_queue_turn_not_observed" };
}

/** Examine the entire interval after the pre-send anchor. Partial pages cannot prove uniqueness. */
export function readDesktopQueueSubmission(target: DesktopThreadIdentity, input: Submission & {
  baselineTurnId: string | null; expectedCwd?: string;
}): Promise<DesktopQueueObservation> {
  nativeId(input.clientUserMessageId);
  if (input.baselineTurnId !== null) nativeId(input.baselineTurnId);
  return withQueue(target, async (rpc, check) => {
    await threadMetadata(rpc, target.threadId, input.expectedCwd);
    const turns = new Map<string, DesktopTurn>(), cursors = new Set<string>();
    let firstPage: Awaited<ReturnType<typeof turnsPage>>;
    let cursor: string | undefined;
    const finish = async (): Promise<DesktopQueueObservation> => {
      if (cursor !== undefined) {
        const head = await turnsPage(rpc, target.threadId, PAGE_SIZE);
        check();
        if (!isDeepStrictEqual(firstPage, head)) return { state: "uncertain", reason: "desktop_queue_history_changed" };
      }
      return matchTurns([...turns.values()], input);
    };
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      const page = await turnsPage(rpc, target.threadId, PAGE_SIZE, cursor);
      if (pageNo === 0) firstPage = page;
      check();
      for (const turn of page.data) {
        if (turn.turnId === input.baselineTurnId) return finish();
        if (turns.has(turn.turnId)) return { state: "uncertain", reason: "desktop_queue_history_conflict" };
        turns.set(turn.turnId, turn);
      }
      if (page.nextCursor === null) return input.baselineTurnId === null ? finish()
        : { state: "uncertain", reason: "desktop_queue_baseline_missing" };
      if (cursors.has(page.nextCursor)) break;
      cursor = page.nextCursor;
      cursors.add(cursor);
    }
    return { state: "uncertain", reason: "desktop_queue_history_incomplete" };
  });
}
