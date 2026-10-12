import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export class DesktopCreationRpcError extends Error {
  constructor(public readonly code: string, message: string,
    public readonly requestDispatched: boolean, public readonly method?: string,
    public readonly requestId?: number, public readonly rpcCode?: number) {
    super(message); this.name = "DesktopCreationRpcError";
  }
}

export interface DesktopCreationRpc {
  request(method: string, params: Record<string, unknown>,
    options?: { beforeDispatch?: () => void | Promise<void> }): Promise<unknown>;
  notifyInitialized(): void;
  close(): Promise<void>;
}

export interface DesktopCreationRpcOptions {
  binaryPath: string;
  codexHome: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

type Pending = { method: string; dispatched: boolean; timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void; reject: (error: Error) => void };
const METHODS = new Set(["initialize", "project/list", "project/read", "thread/start", "thread/name/set", "thread/read"]);
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** A dedicated, short-lived bundled process. Never attaches to or kills an existing server. */
export function createDesktopCreationRpc(options: DesktopCreationRpcOptions): DesktopCreationRpc {
  return new DesktopCreationProcess(options);
}

class DesktopCreationProcess implements DesktopCreationRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private closed = false;
  private processExited = false;
  private spawnFailed = false;
  private closePromise: Promise<void> | undefined;
  private resolveExit!: () => void;
  private readonly exited = new Promise<void>(resolve => { this.resolveExit = resolve; });

  constructor(options: DesktopCreationRpcOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new DesktopCreationRpcError("invalid_argument", "Invalid Desktop creation request timeout", false);
    }
    this.child = (options.spawnProcess ?? spawn)(options.binaryPath,
      ["-c", "features.code_mode_host=true", "app-server", "--listen", "stdio://"], {
        cwd: options.codexHome, env: { ...(options.environment ?? process.env), CODEX_HOME: options.codexHome },
        stdio: ["pipe", "pipe", "pipe"]
      }) as ChildProcessWithoutNullStreams;
    this.child.on("error", () => {
      this.fail("process_failed", "Desktop creation process could not run");
      if (this.child.pid === undefined) { this.spawnFailed = true; this.resolveExit(); }
    });
    this.child.on("exit", () => { this.processExited = true; this.fail("closed", "Desktop creation process exited"); this.resolveExit(); });
    this.child.stdin.on("error", () => this.fail("write_failed", "Desktop creation input transport failed"));
    this.child.stdout.on("error", () => this.fail("read_failed", "Desktop creation output transport failed"));
    this.child.stderr.resume(); // Diagnostics may contain local paths; never project raw stderr into receipts.
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  private fail(code: string, message: string): void {
    this.ended = true;
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(new DesktopCreationRpcError(code, message, item.dispatched, item.method, id));
    }
    this.pending.clear();
  }

  private receive(chunk: Buffer): void {
    if (this.ended) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.includes(10)) {
      const index = this.buffer.indexOf(10), line = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1);
      if (line.length > MAX_LINE_BYTES) { this.fail("invalid_response", "Desktop creation response exceeds its limit"); return; }
      let message: Record<string, unknown>;
      try { const value = JSON.parse(line.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        message = value;
      } catch { this.fail("invalid_response", "Desktop creation returned malformed JSON"); return; }
      if (typeof message.method === "string") {
        // Creation never starts a turn or authorizes server tool/approval requests.
        if (message.id !== undefined) { this.fail("unexpected_request", "Desktop creation received an unexpected server request"); return; }
        continue;
      }
      this.settle(message);
    }
    if (this.buffer.length > MAX_LINE_BYTES) this.fail("invalid_response", "Desktop creation response exceeds its limit");
  }

  private settle(message: Record<string, unknown>): void {
    const item = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!item) return; // A late response never revives or repeats a timed-out mutation.
    const requestId = message.id as number;
    this.pending.delete(requestId); clearTimeout(item.timer);
    if (message.error && typeof message.error === "object") {
      const rpcCode = (message.error as Record<string, unknown>).code;
      item.reject(new DesktopCreationRpcError("rpc_rejected", `Desktop ${item.method} returned an error`,
        item.dispatched, item.method, requestId, typeof rpcCode === "number" ? rpcCode : undefined));
    } else if (!Object.hasOwn(message, "result")) {
      item.reject(new DesktopCreationRpcError("invalid_response", "Desktop creation response has no result",
        item.dispatched, item.method, requestId));
    } else item.resolve(message.result);
  }

  async request(method: string, params: Record<string, unknown>,
    options?: { beforeDispatch?: () => void | Promise<void> }): Promise<unknown> {
    if (!METHODS.has(method)) throw new DesktopCreationRpcError("invalid_argument", "Desktop creation method is not permitted", false, method);
    if (this.ended || this.closed) throw new DesktopCreationRpcError("closed", "Desktop creation connection is closed", false, method);
    // Serialize before the durable barrier, so malformed input cannot leave a false dispatch record.
    const id = ++this.sequence, payload = `${JSON.stringify({ id, method, params })}\n`;
    try { await options?.beforeDispatch?.(); }
    catch { throw new DesktopCreationRpcError("dispatch_barrier_failed", "Desktop creation durable dispatch barrier failed", false, method, id); }
    if (this.ended || this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new DesktopCreationRpcError("closed", "Desktop creation connection closed before dispatch", false, method, id);
    }
    return new Promise((resolve, reject) => {
      const item: Pending = { method, dispatched: false, resolve, reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          reject(new DesktopCreationRpcError("timeout", "Desktop creation request timed out; no automatic retry",
            item.dispatched, method, id));
        }, this.timeoutMs) };
      this.pending.set(id, item);
      try {
        // Once write is called, a throwing/erroring pipe may still have submitted bytes.
        item.dispatched = true;
        this.child.stdin.write(payload);
      } catch {
        this.pending.delete(id); clearTimeout(item.timer);
        reject(new DesktopCreationRpcError("write_failed", "Desktop creation dispatch outcome is unknown", true, method, id));
      }
    });
  }

  notifyInitialized(): void {
    if (this.ended || this.closed) throw new DesktopCreationRpcError("closed", "Desktop creation connection is closed", false);
    this.child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.fail("closed", "Desktop creation connection closed");
    this.closePromise = this.closeProcess();
    return this.closePromise;
  }

  private async closeProcess(): Promise<void> {
    if (this.processExited || this.spawnFailed || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const signal = (name: "SIGTERM" | "SIGKILL") => {
      if (this.processExited || this.spawnFailed) return;
      try { this.child.kill(name); } catch { /* Exit must still be independently confirmed below. */ }
    };
    const terminate = setTimeout(() => signal("SIGTERM"), 1000);
    const kill = setTimeout(() => signal("SIGKILL"), 3000);
    let bound: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      bound = setTimeout(() => reject(new DesktopCreationRpcError("process_exit_unconfirmed",
        "Desktop creation process exit could not be confirmed; do not hand off its thread", false)), 4000);
    });
    try {
      try { this.child.stdin.end(); } catch { /* Retain bounded signal cleanup if the input pipe fails. */ }
      await Promise.race([this.exited, deadline]);
    } finally { clearTimeout(terminate); clearTimeout(kill); clearTimeout(bound!); }
  }
}
