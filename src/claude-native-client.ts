import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { CLAUDE_NATIVE_PEER_HELPER } from "./claude-native-peer-helper.js";
import { discoverClaudeNativeSessions, inspectClaudeNativeSession,
  type ClaudeNativeDiscoveryOptions, type ClaudeNativeDiscoveryResult } from "./claude-native-discovery.js";
import { ClaudeNativeError, createClaudeNativeConversationId, isClaudeNativeUuid, type ClaudeNativeCatalogEntry, type ClaudeNativeIdentity } from "./claude-native-identity.js";

export interface ClaudeNativeSendReceipt {
  dispatchState: "written" | "not_sent" | "uncertain";
  errorCode?: string;
  deliveryStatus?: "held" | "delivered" | "refused" | "expired";
  /** Real AKK-side writer PID, expected in native origin.verifiedPeerPid. */
  senderPid?: number;
}
export interface ClaudeNativeNotice {
  sessionId: string; pid: number;
  notice: { action: string; orig_msg_id: string; status?: string; status_detail?: string; state?: string };
}
export interface ClaudeNativePeerTransport {
  readonly senderPid?: number;
  probe(entry: ClaudeNativeCatalogEntry): Promise<void>;
  send(entry: ClaudeNativeCatalogEntry, input: { text: string; inputUuid: string; messageId: string }): Promise<ClaudeNativeSendReceipt>;
  close(): void;
}
export interface ClaudeNativeClientOptions extends ClaudeNativeDiscoveryOptions {
  pythonPath?: string;
  timeoutMs?: number;
  onNotice?: (notice: ClaudeNativeNotice) => void;
  peerTransport?: ClaudeNativePeerTransport;
  discoverSessions?: () => Promise<ClaudeNativeDiscoveryResult>;
  inspectSession?: (identity: ClaudeNativeIdentity) => Promise<ClaudeNativeCatalogEntry>;
}
/** Parent AKK process owns the helper; the actual writer owns its native reply socket. */
class MacPeerTransport implements ClaudeNativePeerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private closed = false;
  private pending = new Map<string, { resolve: (r: ClaudeNativeSendReceipt) => void; timer: NodeJS.Timeout; action: string }>();
  constructor(private options: ClaudeNativeClientOptions) {}
  get senderPid(): number | undefined { return this.child?.pid; }
  private async start(): Promise<void> {
    if (this.closed) throw new ClaudeNativeError("client_closed", "Claude native client is closed");
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.pythonPath ?? "python3", ["-I", "-u", "-c", CLAUDE_NATIVE_PEER_HELPER],
        { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL, PYTHONIOENCODING: "utf-8" } });
      this.child = child;
      child.stdin.on("error", () => this.failPending());
      const timer = setTimeout(() => { child.kill(); reject(new ClaudeNativeError("peer_helper_unavailable", "Claude peer credential helper did not start")); }, 3000);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        if (line.length > 65536) return;
        let value: any; try { value = JSON.parse(line); } catch { return; }
        if (value.ready === true && value.pid === child.pid) { clearTimeout(timer); resolve(); return; }
        if (value.event === "notice") {
          try { this.options.onNotice?.(value as ClaudeNativeNotice); } catch { /* Observer failures never retry input. */ }
          return;
        }
        const request = this.pending.get(value.id); if (!request) return;
        clearTimeout(request.timer); this.pending.delete(value.id);
        const r = value.result;
        request.resolve(r && ["written", "not_sent", "uncertain"].includes(r.dispatchState)
          ? { ...r, ...(request.action === "send" ? { senderPid: child.pid } : {}) }
          : { dispatchState: request.action === "send" ? "uncertain" : "not_sent", errorCode: "invalid_peer_response",
            ...(request.action === "send" ? { senderPid: child.pid } : {}) });
      });
      child.stderr.resume();
      child.once("error", () => { clearTimeout(timer); reject(new ClaudeNativeError("peer_helper_unavailable", "Python 3 is required for native macOS peer identity verification")); this.failPending(); });
      child.once("exit", () => { clearTimeout(timer); reject(new ClaudeNativeError("peer_helper_exited", "Claude peer credential helper exited")); this.failPending(); this.closed = true; });
    });
    return this.starting;
  }
  private failPending(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ dispatchState: p.action === "send" ? "uncertain" : "not_sent", errorCode: "peer_helper_exited",
      ...(p.action === "send" ? { senderPid: this.child?.pid } : {}) }); }
    this.pending.clear();
  }
  private async request(action: "probe" | "send", entry: ClaudeNativeCatalogEntry, input = {}): Promise<ClaudeNativeSendReceipt> {
    await this.start();
    return new Promise(resolve => {
      const id = randomUUID(), timer = setTimeout(() => {
        this.pending.delete(id); resolve({ dispatchState: action === "send" ? "uncertain" : "not_sent", errorCode: "peer_timeout",
          ...(action === "send" ? { senderPid: this.child?.pid } : {}) });
      }, this.options.timeoutMs ?? 5000);
      this.pending.set(id, { resolve, timer, action });
      this.child!.stdin.write(JSON.stringify({ id, action, entry, ...input }) + "\n", error => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer); this.pending.delete(id);
        resolve({ dispatchState: action === "send" ? "uncertain" : "not_sent", errorCode: "peer_write_failed",
          ...(action === "send" ? { senderPid: this.child?.pid } : {}) });
      });
    });
  }
  async probe(entry: ClaudeNativeCatalogEntry): Promise<void> {
    const result = await this.request("probe", entry);
    if (result.errorCode) throw new ClaudeNativeError(result.errorCode, "Claude native socket identity could not be verified");
  }
  async send(entry: ClaudeNativeCatalogEntry, input: { text: string; inputUuid: string; messageId: string }) {
    try { await this.start(); }
    catch (error) { return { dispatchState: "not_sent" as const,
      errorCode: error instanceof ClaudeNativeError ? error.code : "peer_helper_unavailable" }; }
    return this.request("send", entry, input);
  }
  close(): void {
    this.closed = true; this.failPending(); this.child?.stdin.end();
    const child = this.child;
    if (child) { const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000); timer.unref(); }
  }
}
export class ClaudeNativeClient {
  private readonly peer: ClaudeNativePeerTransport;
  private closed = false;
  private inFlight = new Set<string>();
  constructor(private readonly options: ClaudeNativeClientOptions = {}) { this.peer = options.peerTransport ?? new MacPeerTransport(options); }
  get senderPid(): number | undefined { return this.peer.senderPid; }
  async discover(): Promise<ClaudeNativeDiscoveryResult> {
    this.assertOpen();
    const found = await (this.options.discoverSessions?.() ?? discoverClaudeNativeSessions(this.options));
    const sessions: ClaudeNativeCatalogEntry[] = [], errors = [...found.errors];
    for (const entry of found.sessions) {
      try { await this.peer.probe(entry); sessions.push(entry); }
      catch (error) { errors.push({ configDir: entry.configDir,
        code: error instanceof ClaudeNativeError ? error.code : "peer_unavailable" }); }
    }
    return { sessions, errors };
  }
  async inspect(identity: ClaudeNativeIdentity): Promise<ClaudeNativeCatalogEntry> {
    this.assertOpen();
    if ((this.options.platform ?? process.platform) !== "darwin") throw new ClaudeNativeError("unsupported_platform", "Claude native peer verification is currently validated on macOS only");
    const entry = await (this.options.inspectSession?.(identity) ?? inspectClaudeNativeSession(identity, this.options));
    if (entry.nativeId !== createClaudeNativeConversationId(identity)
      || createClaudeNativeConversationId(entry) !== entry.nativeId) {
      throw new ClaudeNativeError("identity_changed", "Claude native inspection returned a different process/session");
    }
    await this.peer.probe(entry); return entry;
  }
  async send(identity: ClaudeNativeIdentity, input: { text: string; inputUuid: string; messageId: string;
    beforeDispatch?: (entry: ClaudeNativeCatalogEntry, senderPid?: number) => Promise<void> }): Promise<ClaudeNativeSendReceipt> {
    this.assertOpen();
    if (typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text) > 256 * 1024
      || !isClaudeNativeUuid(input.inputUuid) || !isClaudeNativeUuid(input.messageId)) throw new ClaudeNativeError("invalid_input", "Claude native message requires bounded text and UUID identifiers");
    const key = `${identity.configDir}:${identity.pid}:${identity.processStart}:${identity.sessionId}`;
    if (this.inFlight.has(key)) return { dispatchState: "not_sent", errorCode: "send_in_flight" };
    this.inFlight.add(key);
    let dispatchAttempted = false;
    try {
      let entry = await this.inspect(identity);
      if (entry.status !== "idle") return { dispatchState: "not_sent", errorCode: "session_not_idle" };
      await input.beforeDispatch?.(entry, this.peer.senderPid);
      entry = await this.inspect(identity);
      if (entry.status !== "idle") return { dispatchState: "not_sent", errorCode: "session_not_idle" };
      dispatchAttempted = true;
      const result = await this.peer.send(entry, input);
      return { ...result, ...(this.peer.senderPid === undefined ? {} : { senderPid: this.peer.senderPid }) };
    } catch (error) {
      return { dispatchState: dispatchAttempted ? "uncertain" : "not_sent",
        errorCode: error instanceof ClaudeNativeError ? error.code : "native_unavailable",
        ...(dispatchAttempted && this.peer.senderPid !== undefined ? { senderPid: this.peer.senderPid } : {}) };
    } finally { this.inFlight.delete(key); }
  }
  close(): void { this.closed = true; this.peer.close(); }
  private assertOpen(): void { if (this.closed) throw new ClaudeNativeError("client_closed", "Claude native client is closed"); }
}
export function createClaudeNativeClient(options: ClaudeNativeClientOptions = {}): ClaudeNativeClient { return new ClaudeNativeClient(options); }
