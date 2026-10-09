import path from "node:path";
import { connectCodexUnixWebSocket, type CodexAppServerReadTransport } from "./codex-app-server-transport.js";
import { parseCodexAppServerMetadata } from "./codex-app-server-read-client.js";
import { CodexNativeError, type CodexNativeClientOptions, type CodexNativeMetadata } from "./codex-native-types.js";
import { nativeRecord, nativeInvalid } from "./codex-native-snapshot.js";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; mutation: boolean; method: string; params: unknown };

/** Internal RPC transport, deliberately not exported through the public adapter. */
export class CodexNativeRpc {
  readonly metadata: CodexNativeMetadata;
  private sequence = 0;
  private closed = false;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(message: Record<string, unknown>) => void>();
  private unlisten: (() => void)[];
  private constructor(private transport: CodexAppServerReadTransport, readonly timeoutMs: number, socketPath: string) {
    this.metadata = { socketPath, codexHome: "", serverVersion: "", platformFamily: "", platformOs: "" };
    this.unlisten = [transport.onMessage(message => this.receive(message)),
      transport.onDisconnect(() => this.finish(new CodexNativeError("closed", "Codex native connection closed")))];
  }
  static async connect(options: CodexNativeClientOptions): Promise<CodexNativeRpc> {
    if (!path.isAbsolute(options.codexHome)) throw new CodexNativeError("invalid_argument", "Codex home must be absolute");
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new CodexNativeError("invalid_argument", "Invalid native timeout");
    const socketPath = path.join(options.codexHome, "app-server-control", "app-server-control.sock");
    const transport = await (options.transportFactory ?? connectCodexUnixWebSocket)({ socketPath, timeoutMs });
    const rpc = new CodexNativeRpc(transport, timeoutMs, socketPath);
    try {
      const result = await rpc.call("initialize", { clientInfo: { name: "agent-knock-knock-native", title: "AKK native CLI", version: "1" },
        capabilities: { experimentalApi: true } });
      Object.assign(rpc.metadata, parseCodexAppServerMetadata(result,
        { codexHome: options.codexHome, expectedServerVersion: "", compatibility: "read_contract" }, socketPath));
      transport.send(JSON.stringify({ method: "initialized" }));
      return rpc;
    } catch (error) { rpc.close(); throw error; }
  }
  onEvent(listener: (message: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  call(method: string, params: unknown, mutation = false): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexNativeError("closed", "Codex native connection closed"));
    if (this.pending.size >= 100) return Promise.reject(new CodexNativeError("invalid_argument", "Too many native requests"));
    const id = `akk-native-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexNativeError("timeout", `Codex native ${method} timed out`, mutation ? "unknown" : "not_sent"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, mutation, method, params });
      try { this.transport.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id);
        reject(new CodexNativeError("closed", "Codex native send failed", mutation ? "unknown" : "not_sent")); }
    });
  }
  respond(id: string | number, result: unknown): void {
    if (this.closed) throw new CodexNativeError("closed", "Codex native connection closed");
    try { this.transport.send(JSON.stringify({ id, result })); }
    catch { throw new CodexNativeError("closed", "Codex native response delivery uncertain", "unknown"); }
  }
  close(): void { this.finish(new CodexNativeError("closed", "Codex native connection closed")); this.transport.close(); }
  private receive(message: string): void {
    try {
      if (Buffer.byteLength(message) > 8 * 1024 * 1024) nativeInvalid("Native message exceeds bound");
      const raw = nativeRecord(JSON.parse(message));
      if (typeof raw.method === "string") { for (const listener of this.listeners) listener(raw); return; }
      this.receiveResponse(raw);
    } catch {
      this.finish(new CodexNativeError("invalid_response", "Malformed Codex native protocol message")); this.transport.close();
    }
  }
  private receiveResponse(raw: Record<string, unknown>): void {
    if (typeof raw.id !== "string") return;
    const pending = this.pending.get(raw.id); if (!pending) return;
    // Validate before removing the pending request, so malformed errors also reject it on disconnect.
    const responseError = raw.error !== undefined ? nativeRecord(raw.error) : undefined;
    this.pending.delete(raw.id); clearTimeout(pending.timer);
    if (responseError) pending.reject(nativeRpcError(responseError, pending));
    else if (Object.hasOwn(raw, "result")) pending.resolve(raw.result);
    else pending.reject(new CodexNativeError("invalid_response", "Native response omitted result", pending.mutation ? "unknown" : "not_sent"));
  }
  private finish(error: CodexNativeError): void {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer); p.reject(new CodexNativeError(error.code, error.message, p.mutation ? "unknown" : "not_sent"));
    }
    this.pending.clear(); this.listeners.clear(); this.unlisten.forEach(stop => stop());
  }
}

function nativeRpcError(error: Record<string, unknown>, pending: Pending): CodexNativeError {
  const code = typeof error.code === "number" ? error.code : undefined;
  const unsupported = code === -32601;
  const threadId = pending.params && typeof pending.params === "object" ? (pending.params as Record<string, unknown>).threadId : undefined;
  const unmaterialized = pending.method === "thread/turns/list" && code === -32600 && typeof threadId === "string"
    && error.message === `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`;
  // Raw RPC error messages can contain prompts and private paths. Keep them local to the server.
  return new CodexNativeError(unmaterialized ? "unmaterialized_thread" : unsupported ? "unsupported_capability" : "rpc_error",
    unsupported ? "Codex backend does not expose this native capability" : "Codex backend rejected the native request",
    pending.mutation && code !== -32601 && code !== -32602 ? "unknown" : "not_sent", code);
}
