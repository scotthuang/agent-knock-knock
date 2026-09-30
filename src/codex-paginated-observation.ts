import {
  connectCodexAppServerReadClient,
  isCodexUnmaterializedThreadError,
  type CodexAppServerReadClient,
  type CodexAppServerTurn,
  type CodexAppServerThreadItem
} from "./codex-app-server-read-client.js";
import type { CodexPaginatedThreadBinding } from "./codex-paginated-thread-facts.js";
import {
  createCodexPaginatedTaskAnchor,
  codexPaginatedTurnRequestHash,
  codexPaginatedAsyncQuestionEvidence,
  type CodexPaginatedTaskAnchor,
  type CodexPaginatedTaskSnapshot
} from "./codex-paginated-task.js";
import type { TerminalRuntimeIdentity } from "./terminal-agent-adapter.js";
import type { CodexAsyncQuestionDurableEvidence } from "./codex-async-question-adapter.js";

type ReadClient = Pick<CodexAppServerReadClient, "metadata" | "readThread" | "listTurns" | "listItems" | "close">;
type Connect = (options: { codexHome: string; expectedServerVersion: string }) => Promise<ReadClient>;

export async function readCodexPaginatedAsyncQuestions(runtime: TerminalRuntimeIdentity): Promise<
  readonly CodexAsyncQuestionDurableEvidence[] | undefined
> {
  const binding = runtime.codexPaginatedThread;
  if (!binding || !runtime.nativeTaskId || binding.threadId !== runtime.nativeSessionId) return undefined;
  const snapshot = await readCodexPaginatedTaskSnapshot({
    codexHome: binding.codexHome, threadId: binding.threadId,
    serverVersion: binding.serverVersion, boundaryTurnId: runtime.nativeTaskId
  });
  if (!snapshot.completeToBoundary) return undefined;
  const index = snapshot.turns.findIndex((turn) => turn.id === runtime.nativeTaskId);
  return index < 0 ? undefined : codexPaginatedAsyncQuestionEvidence(snapshot.turns[index]!, snapshot.turns.slice(0, index));
}

export class CodexLegacyThreadHistoryError extends Error {
  constructor(readonly threadId: string) {
    super("The exact Codex foreground thread uses legacy history");
    this.name = "CodexLegacyThreadHistoryError";
  }
}

/** Bounded reads never resume, subscribe to, create, or mutate native threads. */
export async function readCodexPaginatedTaskSnapshot(input: {
  codexHome: string;
  threadId: string;
  serverVersion: string;
  boundaryTurnId?: string;
  connect?: Connect;
}): Promise<CodexPaginatedTaskSnapshot> {
  const client = await (input.connect ?? connectCodexAppServerReadClient)({
    codexHome: input.codexHome, expectedServerVersion: input.serverVersion
  });
  try {
    const thread = await client.readThread(input.threadId);
    if (thread.historyMode === "legacy") throw new CodexLegacyThreadHistoryError(thread.id);
    const listed = await readTurnsThroughBoundary(client, input.threadId, input.boundaryTurnId).catch((error: unknown) => {
      if (!input.boundaryTurnId && thread.status.type === "idle" && isCodexUnmaterializedThreadError(error, input.threadId)) {
        return { turns: [], complete: true };
      }
      throw error;
    });
    const turns: CodexAppServerTurn[] = [];
    for (const turn of listed.turns) {
      turns.push({ ...turn, itemsView: "full", items: await readTurnItems(client, input.threadId, turn.id) });
    }
    return {
      codexHome: client.metadata.codexHome,
      serverVersion: client.metadata.serverVersion,
      thread, turns, completeToBoundary: listed.complete
    };
  } finally {
    client.close();
  }
}

async function readTurnsThroughBoundary(client: ReadClient, threadId: string, boundary?: string): Promise<{
  turns: CodexAppServerTurn[]; complete: boolean;
}> {
  const turns: CodexAppServerTurn[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 64; pageNumber += 1) {
    const page = await client.listTurns({ threadId, cursor, limit: 20, sortDirection: "desc", itemsView: "notLoaded" });
    for (const turn of page.data) {
      if (ids.has(turn.id)) throw new Error("Codex turn pagination repeated an item");
      ids.add(turn.id);
      turns.push(turn);
      if (turn.id === boundary) return { turns, complete: true };
      if (turns.length > 128) throw new Error("Codex task history exceeded the bounded observation window");
    }
    if (page.nextCursor === null) return { turns, complete: boundary === undefined };
    if (cursors.has(page.nextCursor)) throw new Error("Codex turn pagination repeated a cursor");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("Codex turn pagination exceeded its page limit");
}

async function readTurnItems(client: ReadClient, threadId: string, turnId: string): Promise<CodexAppServerThreadItem[]> {
  const items: CodexAppServerThreadItem[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 64; pageNumber += 1) {
    const page = await client.listItems({ threadId, turnId, cursor, limit: 100, sortDirection: "asc" });
    for (const entry of page.data) {
      if (ids.has(entry.item.id) || entry.turnId !== turnId) throw new Error("Codex item identity changed during pagination");
      ids.add(entry.item.id);
      items.push(entry.item);
      if (items.length > 1024) throw new Error("Codex task items exceeded the bounded observation window");
    }
    if (page.nextCursor === null) return items;
    if (cursors.has(page.nextCursor)) throw new Error("Codex item pagination repeated a cursor");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("Codex item pagination exceeded its page limit");
}

export async function captureCodexPaginatedTaskAnchor(input: {
  binding: CodexPaginatedThreadBinding;
  requestHash?: string;
  now: Date;
  connect?: Connect;
}): Promise<CodexPaginatedTaskAnchor | undefined> {
  const { binding } = input;
  const client = await (input.connect ?? connectCodexAppServerReadClient)({
    codexHome: binding.codexHome, expectedServerVersion: binding.serverVersion
  });
  try {
    const thread = await client.readThread(binding.threadId);
    if (thread.historyMode === "legacy") throw new CodexLegacyThreadHistoryError(thread.id);
    const page = await client.listTurns({ threadId: binding.threadId, limit: 2, sortDirection: "desc", itemsView: "notLoaded" }).catch((error: unknown) => {
      if (thread.status.type === "idle" && isCodexUnmaterializedThreadError(error, binding.threadId)) return { data: [] };
      throw error;
    });
    const latest = page.data[0];
    if (!input.requestHash && latest?.status !== "inProgress") return undefined;
    const activeHash = !input.requestHash && latest
      ? codexPaginatedTurnRequestHash({ ...latest,
          items: await readTurnItems(client, binding.threadId, latest.id), itemsView: "full" }) : undefined;
    if (!input.requestHash && !activeHash) throw new Error("Active Codex turn has no unique text request");
    return createCodexPaginatedTaskAnchor({
      origin: input.requestHash ? "user_explicit_send" : "active_task",
      captured_at: input.now.toISOString(), codex_home: binding.codexHome,
      codex_version: binding.agentVersion,
      ...(binding.serverVersion === binding.agentVersion
        ? {} : { backend_version: binding.serverVersion }),
      native_thread_id: binding.threadId,
      process_uuid: binding.processUuid, process_birth: binding.processBirth,
      pid: binding.pid, request_hash: input.requestHash ?? activeHash!,
      ...(input.requestHash && latest ? { baseline_latest_turn_id: latest.id } : {}),
      ...(!input.requestHash && latest ? { turn_id: latest.id } : {})
    });
  } finally {
    client.close();
  }
}
