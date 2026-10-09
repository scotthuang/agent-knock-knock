import crypto from "node:crypto";
import path from "node:path";
import { connectDesktopIpcTransport } from "./desktop-ipc-transport.js";
import { desktopRecord, reduceDesktopSnapshot } from "./desktop-snapshot.js";
import { DesktopIpcError, type DesktopIpcClientOptions, type DesktopIpcTransport, type DesktopOwner,
  type DesktopObserveTarget, type DesktopSendTurnOptions, type DesktopSnapshot, type DesktopTurnReceipt,
  type DesktopDispatchState } from "./desktop-types.js";

export const VERIFIED_DESKTOP_BUILD = Object.freeze({ version: "26.1002.52244", build: "13536" });
const MIN_TIMEOUT_MS = 12_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 15_000;
type Pending = { method: string; version: number; target?: string; timer: ReturnType<typeof setTimeout>;
  resolve: (response: Record<string, unknown>) => void; reject: (error: Error) => void };

function id(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,511}$/u.test(value)) {
    throw new DesktopIpcError("invalid_argument", `Invalid Desktop ${label}`);
  }
  return value;
}

function acceptedTurnId(response: Record<string, unknown>): string {
  const outer = response.result;
  const inner = desktopRecord(outer) ? outer.result : undefined;
  const turn = desktopRecord(inner) ? inner.turn : undefined;
  if (!desktopRecord(turn) || typeof turn.id !== "string" || !turn.id
    || !["inProgress", "completed", "failed", "interrupted"].includes(String(turn.status))) {
    throw new DesktopIpcError("invalid_response", "Desktop start receipt did not identify an accepted turn", "unknown");
  }
  return turn.id;
}

function isExactStreamMessage(message: Record<string, unknown>, target: DesktopObserveTarget,
  clientId: string | undefined): message is Record<string, unknown> & { params: Record<string, unknown> } {
  return message.type === "broadcast" && message.method === "thread-stream-state-changed"
    && message.sourceClientId === target.ownerClientId && desktopRecord(message.params)
    && message.params.hostId === "local" && message.params.conversationId === target.threadId
    && (message.targetClientIds == null || (Array.isArray(message.targetClientIds) && message.targetClientIds.includes(clientId)));
}

/** No generic RPC entry point, ownership acquisition, resume, steering, or approval responses. */
export class DesktopIpcClient {
  private readonly pending = new Map<string, Pending>();
  private readonly unsubscribe: (() => void)[];
  private clientId: string | undefined;
  private closed: Error | undefined;
  private target: DesktopObserveTarget | undefined;
  private snapshot: DesktopSnapshot | undefined;
  private observedRevision = -1;
  private dirty = true;
  private generation = 0;
  private sending = false;
  private readonly sentMessageIds = new Set<string>();
  private snapshotWaiter: { resolve: (value: DesktopSnapshot) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> } | undefined;

  private constructor(private readonly transport: DesktopIpcTransport,
    private readonly options: DesktopIpcClientOptions, private readonly timeoutMs: number) {
    this.unsubscribe = [transport.onMessage((message) => {
      try { this.receive(message); }
      catch (error) { this.finish(error instanceof Error ? error : new DesktopIpcError("invalid_response", "Invalid Desktop IPC message")); }
    }), transport.onDisconnect((error) => this.finish(error))];
  }

  static async connect(options: DesktopIpcClientOptions): Promise<DesktopIpcClient> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!path.isAbsolute(options.socketPath) || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > 60_000) {
      throw new DesktopIpcError("invalid_argument", "Desktop IPC needs an absolute socket path and timeout between 12000 and 60000 ms");
    }
    const transport = await (options.transportFactory ?? connectDesktopIpcTransport)({ socketPath: options.socketPath, timeoutMs });
    const client = new DesktopIpcClient(transport, options, timeoutMs);
    try {
      const initialized = await client.request("initialize", 0, { clientType: "agent-knock-knock" });
      if (!desktopRecord(initialized.result) || typeof initialized.result.clientId !== "string") {
        throw new DesktopIpcError("invalid_response", "Desktop IPC initialization has no client identity");
      }
      client.clientId = id(initialized.result.clientId, "client identity");
      return client;
    } catch (error) { client.close(); throw error; }
  }

  async discoverOwner(threadId: string, expectedOwnerId?: string): Promise<DesktopOwner> {
    id(threadId, "thread identity"); if (expectedOwnerId) id(expectedOwnerId, "owner identity");
    const response = await this.request("thread-owner-discovery", 1,
      { hostId: "local", conversationId: threadId }, expectedOwnerId, DISCOVERY_TIMEOUT_MS);
    const ownerClientId = response.handledByClientId;
    if (typeof ownerClientId !== "string" || ownerClientId === this.clientId) {
      throw new DesktopIpcError("invalid_response", "Desktop owner discovery returned an invalid owner");
    }
    id(ownerClientId, "owner identity");
    if (expectedOwnerId && ownerClientId !== expectedOwnerId) throw new DesktopIpcError("owner_changed", "Desktop owner changed");
    return { ownerClientId, supportsUntrustedAppInput: desktopRecord(response.result)
      && response.result.supportsUntrustedAppInput === true };
  }

  async observeThread(target: DesktopObserveTarget): Promise<DesktopSnapshot> {
    this.assertOpen(); id(target.threadId, "thread identity"); id(target.ownerClientId, "owner identity");
    if (this.snapshotWaiter) throw new DesktopIpcError("invalid_argument", "A Desktop snapshot request is already pending");
    if (this.target && (this.target.threadId !== target.threadId || this.target.ownerClientId !== target.ownerClientId)) {
      this.follow(false); this.snapshot = undefined; this.observedRevision = -1; this.dirty = true; this.generation++;
    }
    // sendTurnOnce passes a structurally compatible options object here. Keep
    // only native identity; prompts and durable-barrier functions are not state.
    this.target = { threadId: target.threadId, ownerClientId: target.ownerClientId };
    return new Promise<DesktopSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.snapshotWaiter = undefined;
        reject(new DesktopIpcError("timeout", "Exact Desktop owner snapshot timed out"));
      }, this.timeoutMs);
      this.snapshotWaiter = { resolve, reject, timer };
      try { this.follow(true); }
      catch (error) {
        clearTimeout(timer); this.snapshotWaiter = undefined;
        reject(error);
      }
    });
  }

  async sendTurnOnce(options: DesktopSendTurnOptions): Promise<DesktopTurnReceipt> {
    this.assertOpen();
    this.validateSubmission(options);
    this.sending = true;
    let dispatchState: DesktopDispatchState = "not_sent";
    try {
      const baseline = await this.prepareSubmission(options);
      this.sentMessageIds.add(options.clientUserMessageId);
      dispatchState = "unknown";
      const response = await this.request("thread-follower-start-turn", 2, {
        conversationId: options.threadId,
        turnStart: { request: { threadId: options.threadId, clientUserMessageId: options.clientUserMessageId,
          input: [{ type: "text", text: options.prompt, text_elements: [] }] }, context: { inheritThreadSettings: true } }
      }, options.ownerClientId);
      const turnId = acceptedTurnId(response);
      dispatchState = "accepted";
      if (baseline.turns.some((previous) => previous.turnId === turnId)) {
        throw new DesktopIpcError("unexpected_existing_turn", "Desktop attached input to an existing turn; do not claim a new task or retry", "accepted", turnId);
      }
      return { turnId, clientUserMessageId: options.clientUserMessageId, revision: baseline.revision, atomicIdlePrecondition: false };
    } catch (error) {
      if (error instanceof DesktopIpcError && (dispatchState === "not_sent" || error.dispatchState !== "not_sent")) throw error;
      throw new DesktopIpcError(error instanceof DesktopIpcError ? error.code : "closed",
        error instanceof Error ? error.message : "Desktop submission failed", dispatchState);
    } finally { this.sending = false; }
  }

  private validateSubmission(options: DesktopSendTurnOptions): void {
    if (this.options.compatibility.version !== VERIFIED_DESKTOP_BUILD.version
      || this.options.compatibility.build !== VERIFIED_DESKTOP_BUILD.build) {
      throw new DesktopIpcError("incompatible_desktop", "Desktop write capability requires the verified version and build");
    }
    id(options.clientUserMessageId, "user message identity");
    if (typeof options.prompt !== "string" || !options.prompt.trim() || Buffer.byteLength(options.prompt) > 1024 * 1024
      || !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0
      || (options.expectedLatestTurnId !== null && typeof options.expectedLatestTurnId !== "string")) {
      throw new DesktopIpcError("invalid_argument", "Invalid Desktop turn submission");
    }
    if (this.sending || this.sentMessageIds.has(options.clientUserMessageId)) {
      throw new DesktopIpcError("duplicate_submission", "Desktop submission is already attempted; it will not be retried");
    }
  }

  private async prepareSubmission(options: DesktopSendTurnOptions): Promise<DesktopSnapshot> {
      const owner = await this.discoverOwner(options.threadId, options.ownerClientId);
      if (!owner.supportsUntrustedAppInput) throw new DesktopIpcError("incompatible_desktop", "Desktop owner does not advertise untrusted app input support");
      const baseline = await this.observeThread(options);
      if (!baseline.canSend) throw new DesktopIpcError("thread_not_idle", `Desktop thread is not sendable: ${baseline.idleBlockedReason}`);
      // A first follower can increment revision solely by subscribing. Revisions must never regress.
      if (baseline.revision < options.expectedRevision || baseline.latestTurnId !== options.expectedLatestTurnId) {
        throw new DesktopIpcError("snapshot_changed", "Desktop history changed since submission was prepared");
      }
      if (baseline.turns.some((turn) => turn.items.some((entry) => entry.clientId === options.clientUserMessageId))) {
        throw new DesktopIpcError("duplicate_submission", "Desktop already contains this client user message identity");
      }
      const generation = this.generation;
      await options.beforeDispatch?.(structuredClone(baseline));
      this.assertOpen();
      if (this.dirty || generation !== this.generation || this.snapshot?.revision !== baseline.revision
        || this.target?.threadId !== options.threadId || this.target.ownerClientId !== options.ownerClientId) {
        throw new DesktopIpcError("snapshot_changed", "Desktop state changed before dispatch; nothing was sent");
      }
      return baseline;
  }

  close(): void {
    if (!this.closed && this.target) { try { this.follow(false); } catch { /* best effort unsubscribe on close */ } }
    this.finish(new DesktopIpcError("closed", "Desktop IPC client closed"));
  }

  private assertOpen(): void { if (this.closed) throw this.closed; }

  private follow(following: boolean): void {
    this.assertOpen();
    if (!this.target || !this.clientId) throw new DesktopIpcError("closed", "Desktop IPC has no initialized target");
    this.transport.send({ type: "broadcast", sourceClientId: this.clientId, method: "thread-stream-following-changed",
      version: 1, targetClientIds: [this.target.ownerClientId],
      params: { conversationId: this.target.threadId, hostId: "local", following } });
  }

  private request(method: string, version: number, params: unknown, target?: string,
    backendTimeoutMs = this.timeoutMs - 2000): Promise<Record<string, unknown>> {
    this.assertOpen();
    if (this.pending.size >= 16) throw new DesktopIpcError("invalid_argument", "Too many pending Desktop requests");
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId);
        reject(new DesktopIpcError("timeout", `Desktop ${method} response timed out; not retried`)); }, this.timeoutMs);
      this.pending.set(requestId, { method, version, target, resolve, reject, timer });
      try {
        this.transport.send({ type: "request", requestId, sourceClientId: this.clientId ?? "initializing-client",
          method, version, params, timeoutMs: backendTimeoutMs, ...(target ? { targetClientId: target } : {}) });
      } catch (error) { this.pending.delete(requestId); clearTimeout(timer); reject(error); }
    });
  }

  private receive(message: unknown): void {
    if (this.closed || !desktopRecord(message)) return;
    if (message.type === "client-discovery-request" && typeof message.requestId === "string") {
      this.transport.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === "response" && typeof message.requestId === "string") {
      this.receiveResponse(message, message.requestId); return;
    }
    // All incoming RPC requests (including approval/questions) are deliberately left unanswered.
    const target = this.target;
    if (!target || !isExactStreamMessage(message, target, this.clientId)) return;
    if (message.version !== 11) throw new DesktopIpcError("incompatible_desktop", "Unsupported Desktop snapshot protocol version");
    this.receiveStreamChange(message.params.change, target);
  }

  private receiveResponse(message: Record<string, unknown>, requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId); clearTimeout(pending.timer);
    if (message.method !== pending.method || (message.version !== undefined && message.version !== pending.version)) {
      pending.reject(new DesktopIpcError("invalid_response", "Desktop RPC response method/version mismatch")); return;
    }
    if (pending.target && message.handledByClientId !== pending.target) {
      pending.reject(new DesktopIpcError("owner_changed", "Desktop RPC response came from a different owner")); return;
    }
    if (message.resultType !== "success") {
      pending.reject(new DesktopIpcError("rpc_error", `Desktop ${pending.method} was not accepted`)); return;
    }
    pending.resolve(message);
  }

  private receiveStreamChange(change: unknown, target: DesktopObserveTarget): void {
    if (!desktopRecord(change) || !Number.isSafeInteger(change.revision) || (change.revision as number) < this.observedRevision) {
      throw new DesktopIpcError("invalid_response", "Desktop snapshot revision regressed or is invalid");
    }
    if (change.type !== "snapshot") {
      if (!Number.isSafeInteger(change.baseRevision) || (change.baseRevision as number) < 0
        || (change.revision as number) <= (change.baseRevision as number) || !Array.isArray(change.patches)) {
        throw new DesktopIpcError("invalid_response", "Unsupported Desktop stream change");
      }
      // Do not implement the private patch language. Even a missed base invalidates cached state.
      this.dirty = true; this.generation++; this.observedRevision = change.revision as number;
      return;
    }
    const snapshot = reduceDesktopSnapshot(change.conversationState, {
      threadId: target.threadId, ownerClientId: target.ownerClientId, revision: change.revision as number
    });
    if (this.snapshot && snapshot.revision === this.snapshot.revision && JSON.stringify(snapshot) !== JSON.stringify(this.snapshot)) {
      throw new DesktopIpcError("invalid_response", "Desktop changed a snapshot without advancing revision");
    }
    if (snapshot.revision !== this.observedRevision || this.dirty) this.generation++;
    this.snapshot = snapshot; this.observedRevision = snapshot.revision; this.dirty = false;
    const waiter = this.snapshotWaiter;
    if (waiter) {
      // Leave the waiter registered until projection succeeds: receive's error
      // handler must still be able to reject it and cancel its timer on failure.
      const projected = structuredClone(snapshot);
      this.snapshotWaiter = undefined; clearTimeout(waiter.timer); waiter.resolve(projected);
    }
  }

  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.snapshotWaiter) { clearTimeout(this.snapshotWaiter.timer); this.snapshotWaiter.reject(error); this.snapshotWaiter = undefined; }
    for (const unsubscribe of this.unsubscribe ?? []) unsubscribe();
    this.transport.close();
  }
}

export const connectDesktopIpcClient = DesktopIpcClient.connect;
