import fs from "node:fs";
import path from "node:path";
import { isAuditedCodexPaginatedServerPair } from "./codex-lifecycle-compatibility.js";
import {
  connectCodexUnixWebSocket,
  type CodexAppServerReadTransport
} from "./codex-app-server-transport.js";
export type { CodexAppServerReadTransport } from "./codex-app-server-transport.js";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 16;
const DEFAULT_TIMEOUT_MS = 5_000;
const TURN_STATUSES = new Set(["completed", "interrupted", "failed", "inProgress"]);

export type CodexAppServerTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type CodexAppServerThreadStatus =
  | { type: "notLoaded" | "idle" | "systemError" }
  | { type: "active"; activeFlags: ("waitingOnApproval" | "waitingOnUserInput")[] };
export interface CodexAppServerUserInput {
  type: string;
  text?: string;
  [key: string]: unknown;
}
export interface CodexAppServerThreadItem {
  id: string;
  type: string;
  content?: CodexAppServerUserInput[];
  clientId?: string | null;
  text?: string;
  phase?: string | null;
  delivery?: "async" | null;
  questions?: { title: string; options: string[] | null }[] | null;
  [key: string]: unknown;
}
export interface CodexAppServerTurn {
  id: string;
  status: CodexAppServerTurnStatus;
  items: CodexAppServerThreadItem[];
  itemsView: "notLoaded" | "summary" | "full";
  error: { message: string; [key: string]: unknown } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  [key: string]: unknown;
}
export interface CodexAppServerThread {
  id: string;
  sessionId: string;
  cwd: string;
  historyMode: "legacy" | "paginated";
  cliVersion: string;
  originator: string | null;
  source: unknown;
  status: CodexAppServerThreadStatus;
  turns: CodexAppServerTurn[];
  [key: string]: unknown;
}
export interface CodexAppServerItemEntry {
  turnId: string;
  item: CodexAppServerThreadItem;
  startedAtMs: number | null;
  completedAtMs: number | null;
}
export interface CodexAppServerPage<T> {
  data: T[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}
export interface CodexAppServerMetadata {
  serverVersion: string;
  codexHome: string;
  socketPath: string;
  platformFamily: string;
  platformOs: string;
}
export interface CodexAppServerReadOptions {
  codexHome: string;
  expectedServerVersion: string;
  /** Only the fresh TUI /status binding may discover an audited shared backend patch. */
  allowAuditedBackendPatch?: true;
  timeoutMs?: number;
  transportFactory?: (options: {
    socketPath: string;
    timeoutMs: number;
  }) => Promise<CodexAppServerReadTransport>;
}
export interface CodexAppServerListOptions {
  threadId: string;
  cursor?: string;
  limit?: number;
  sortDirection?: "asc" | "desc";
}

export class CodexAppServerReadError extends Error {
  constructor(
    public readonly code: "invalid_response" | "incompatible_server" | "timeout" | "closed" | "rpc_error",
    message: string,
    public readonly rpcCode?: number,
    public readonly rpcMessage?: string
  ) {
    super(message);
    this.name = "CodexAppServerReadError";
  }
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexAppServerReadClient {
  readonly metadata: CodexAppServerMetadata;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unsubscribe: (() => void)[];
  private nextRequestId = 1;
  private closed = false;

  private constructor(
    private readonly transport: CodexAppServerReadTransport,
    private readonly timeoutMs: number,
    metadata: CodexAppServerMetadata
  ) {
    this.metadata = metadata;
    this.unsubscribe = [
      transport.onMessage((message) => this.receive(message)),
      transport.onDisconnect((error) => this.finish(error))
    ];
  }

  static async connect(options: CodexAppServerReadOptions): Promise<CodexAppServerReadClient> {
    if (!path.isAbsolute(options.codexHome)) throw new Error("Codex home must be absolute");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("Codex app-server timeout must be between 1 and 30000 milliseconds");
    }
    const socketPath = path.join(options.codexHome, "app-server-control", "app-server-control.sock");
    const transport = await (options.transportFactory ?? connectCodexUnixWebSocket)({ socketPath, timeoutMs });
    const metadata = { socketPath, serverVersion: "", codexHome: "", platformFamily: "", platformOs: "" };
    const client = new CodexAppServerReadClient(transport, timeoutMs, metadata);
    try {
      const result = await client.request("initialize", {
        clientInfo: { name: "agent-knock-knock-read", title: "AKK read-only history", version: "1" },
        capabilities: { experimentalApi: true }
      });
      Object.assign(metadata, parseCodexAppServerMetadata(result, options, socketPath));
      transport.send(JSON.stringify({ method: "initialized" }));
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async readThread(threadId: string): Promise<CodexAppServerThread> {
    const result = record(await this.request("thread/read", { threadId: identifier(threadId), includeTurns: false }));
    const thread = record(result.thread);
    if (thread.id !== threadId) invalid("Codex app-server returned a different thread");
    identifier(thread.sessionId);
    if (typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd)) invalid("Invalid thread cwd");
    if (thread.historyMode !== "legacy" && thread.historyMode !== "paginated") invalid("Unknown thread history mode");
    if (typeof thread.cliVersion !== "string") invalid("Invalid thread CLI version");
    validateThreadStatus(thread.status);
    if (!Array.isArray(thread.turns)) invalid("Invalid thread turns");
    thread.turns.forEach(validateTurn);
    return thread as unknown as CodexAppServerThread;
  }

  async listTurns(options: CodexAppServerListOptions & {
    itemsView?: "notLoaded" | "summary" | "full";
  }): Promise<CodexAppServerPage<CodexAppServerTurn>> {
    if (options.itemsView && !["notLoaded", "summary", "full"].includes(options.itemsView)) {
      throw new Error("Invalid Codex turn items view");
    }
    const result = await this.request("thread/turns/list", {
      ...listParams(options), itemsView: options.itemsView ?? "notLoaded"
    });
    return parsePage(result, validateTurn);
  }

  async listItems(options: CodexAppServerListOptions & {
    turnId?: string;
  }): Promise<CodexAppServerPage<CodexAppServerItemEntry>> {
    const params = listParams(options);
    if (options.turnId !== undefined) params.turnId = identifier(options.turnId);
    const page = parsePage(await this.request("thread/items/list", params), validateItemEntry);
    if (options.turnId && page.data.some((entry) => entry.turnId !== options.turnId)) {
      invalid("Codex app-server returned items from a different turn");
    }
    return page;
  }

  close(): void {
    if (!this.closed) {
      this.finish(new CodexAppServerReadError("closed", "Codex app-server read connection closed"));
    }
    this.transport.close();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexAppServerReadError("closed", "Codex app-server read connection closed"));
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("Too many Codex app-server reads"));
    const id = `akk-read-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerReadError("timeout", `Codex app-server ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(message: string): void {
    try {
      if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) invalid("Codex app-server message exceeded its bound");
      const response = record(JSON.parse(message));
      // Never respond to server requests: doing so could answer another client's question.
      if (response.method !== undefined || typeof response.id !== "string") return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error !== undefined) {
        const error = record(response.error);
        pending.reject(new CodexAppServerReadError(
          "rpc_error", "Codex app-server read was rejected",
          Number.isInteger(error.code) ? error.code as number : undefined,
          typeof error.message === "string" ? error.message.slice(0, 1024) : undefined
        ));
      } else if (Object.hasOwn(response, "result")) {
        pending.resolve(response.result);
      } else {
        pending.reject(new CodexAppServerReadError("invalid_response", "Codex app-server response omitted result"));
      }
    } catch (error) {
      this.finish(error instanceof Error ? error : new Error("Invalid Codex app-server response"));
      this.transport.close();
    }
  }

  private finish(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.unsubscribe.forEach((unsubscribe) => unsubscribe());
  }
}

export const connectCodexAppServerReadClient = CodexAppServerReadClient.connect;

// Official app-server emits this only for an existing, loaded thread before its first input.
// Callers must separately verify the selected thread's paginated/idle metadata before
// interpreting this as an empty submission baseline.
export function isCodexUnmaterializedThreadError(error: unknown, threadId: string): boolean {
  return error instanceof CodexAppServerReadError
    && error.code === "rpc_error"
    && error.rpcCode === -32600
    && error.rpcMessage === `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`;
}

export function parseCodexAppServerMetadata(value: unknown, options: CodexAppServerReadOptions, socketPath: string): CodexAppServerMetadata {
  const result = record(value);
  const version = typeof result.userAgent === "string" ? /^[^/]+\/([^\s]+)(?:\s|$)/u.exec(result.userAgent)?.[1] : undefined;
  if (version !== options.expectedServerVersion &&
      !(options.allowAuditedBackendPatch &&
        isAuditedCodexPaginatedServerPair(options.expectedServerVersion, version))) {
    throw new CodexAppServerReadError("incompatible_server", "Codex app-server backend version does not match the required version");
  }
  if (typeof result.codexHome !== "string" || !path.isAbsolute(result.codexHome) || !sameHome(result.codexHome, options.codexHome)) {
    throw new CodexAppServerReadError("incompatible_server", "Codex app-server backend home does not match the selected home");
  }
  if (typeof result.platformFamily !== "string" || typeof result.platformOs !== "string") invalid("Missing Codex app-server platform metadata");
  return { serverVersion: version, codexHome: result.codexHome, socketPath, platformFamily: result.platformFamily, platformOs: result.platformOs };
}

function sameHome(left: string, right: string): boolean {
  if (path.resolve(left) === path.resolve(right)) return true;
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return false; }
}

function listParams(options: CodexAppServerListOptions): Record<string, unknown> {
  const params: Record<string, unknown> = { threadId: identifier(options.threadId), limit: options.limit ?? 100 };
  if (!Number.isSafeInteger(params.limit) || (params.limit as number) < 1 || (params.limit as number) > 100) throw new Error("Codex history page limit must be between 1 and 100");
  if (options.cursor !== undefined) params.cursor = identifier(options.cursor, 4096);
  if (options.sortDirection !== undefined) {
    if (options.sortDirection !== "asc" && options.sortDirection !== "desc") throw new Error("Invalid Codex history sort direction");
    params.sortDirection = options.sortDirection;
  }
  return params;
}

function parsePage<T>(value: unknown, validate: (entry: unknown) => T): CodexAppServerPage<T> {
  const page = record(value);
  if (!Array.isArray(page.data) || page.data.length > 100) invalid("Invalid bounded Codex history page");
  const cursor = (value: unknown) => value == null ? null : identifier(value, 4096);
  return { data: page.data.map(validate), nextCursor: cursor(page.nextCursor), backwardsCursor: cursor(page.backwardsCursor) };
}

function validateThreadStatus(value: unknown): void {
  const status = record(value);
  if (["notLoaded", "idle", "systemError"].includes(status.type as string)) return;
  if (status.type !== "active" || !Array.isArray(status.activeFlags) || status.activeFlags.some((flag) => flag !== "waitingOnApproval" && flag !== "waitingOnUserInput")) invalid("Unknown Codex thread status");
}

function validateTurn(value: unknown): CodexAppServerTurn {
  const turn = record(value);
  identifier(turn.id);
  if (!TURN_STATUSES.has(turn.status as string)) invalid("Unknown Codex turn status");
  if (!Array.isArray(turn.items)) invalid("Invalid Codex turn items");
  turn.items.forEach(validateItem);
  if (!["notLoaded", "summary", "full"].includes(turn.itemsView as string)) invalid("Unknown Codex turn items view");
  for (const field of ["startedAt", "completedAt", "durationMs"]) nullableNumber(turn[field]);
  if (turn.error !== null && (typeof record(turn.error).message !== "string")) invalid("Invalid Codex turn error");
  return turn as unknown as CodexAppServerTurn;
}

function validateItemEntry(value: unknown): CodexAppServerItemEntry {
  const entry = record(value);
  identifier(entry.turnId);
  validateItem(entry.item);
  nullableNumber(entry.startedAtMs);
  nullableNumber(entry.completedAtMs);
  return entry as unknown as CodexAppServerItemEntry;
}

function validateItem(value: unknown): CodexAppServerThreadItem {
  const item = record(value);
  identifier(item.id);
  identifier(item.type);
  if (item.type === "userMessage") {
    if (!Array.isArray(item.content)) invalid("Invalid Codex user message content");
    for (const input of item.content) {
      const content = record(input);
      identifier(content.type);
      if (content.type === "text" && typeof content.text !== "string") invalid("Invalid Codex user message text");
    }
  }
  if (item.type === "agentMessage") {
    if (typeof item.text !== "string") invalid("Invalid Codex agent message text");
    if (item.delivery != null && item.delivery !== "async") invalid("Unknown Codex agent message delivery");
    if (item.questions != null) {
      if (!Array.isArray(item.questions)) invalid("Invalid Codex async questions");
      for (const value of item.questions) {
        const question = record(value);
        if (typeof question.title !== "string" || (question.options !== null && (!Array.isArray(question.options) || question.options.some((option) => typeof option !== "string")))) invalid("Invalid Codex async question");
      }
    }
  }
  if (item.type === "plan" && typeof item.text !== "string") invalid("Invalid Codex proposed plan text");
  return item as unknown as CodexAppServerThreadItem;
}

function nullableNumber(value: unknown): void {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) invalid("Invalid Codex history timestamp");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Invalid Codex app-server object");
  return value as Record<string, unknown>;
}

function identifier(value: unknown, limit = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) invalid("Invalid Codex app-server identifier");
  return value;
}

function invalid(message: string): never {
  throw new CodexAppServerReadError("invalid_response", message);
}
