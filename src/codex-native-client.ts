import { CodexNativeRpc } from "./codex-native-client-rpc.js";
import { buildNativeAsyncReply, nativeResponse, parseNativeRequest, hydrateNativeFileApproval } from "./codex-native-client-interactions.js";
import { nativeId, nativeRecord, nativeInvalid, nativePage, parseNativeThread, parseNativeTurn, parseNativeItem,
  isMainCodexCliThread, nativeAsyncInteractions, parseNativePermissions } from "./codex-native-snapshot.js";
import { CodexNativeError, type CodexNativeClientOptions, type CodexNativeSnapshot, type CodexNativeThread,
  type CodexNativeTurn, type CodexNativeMetadata, type NativeInteraction, type NativeInteractionResponse,
  type CodexNativeReceipt, type CodexNativePermissionPreset, type CodexNativePermissions } from "./codex-native-types.js";

const MAX_PAGES = 100;
const PRESETS = { "read-only": [":read-only", "on-request"], default: [":workspace", "on-request"],
  "full-access": [":danger-full-access", "never"] } as const;

/** Native shared-daemon connection. No terminal ownership inference and no historical thread loading. */
export class CodexNativeClient {
  readonly metadata: CodexNativeMetadata;
  private subscribed = new Set<string>();
  private requests = new Map<string, NativeInteraction>();
  private answered = new Set<string>();
  private settings = new Map<string, unknown>();
  private liveFileChanges = new Map<string, { threadId: string; turnId: string; item: CodexNativeTurn["items"][number] }>();
  private constructor(private readonly rpc: CodexNativeRpc) {
    this.metadata = rpc.metadata;
    rpc.onEvent(raw => this.receive(raw));
  }
  static async connect(options: CodexNativeClientOptions): Promise<CodexNativeClient> {
    return new CodexNativeClient(await CodexNativeRpc.connect(options));
  }
  close(): void { this.rpc.close(); this.subscribed.clear(); this.requests.clear(); this.liveFileChanges.clear(); }

  async listLoaded(): Promise<string[]> {
    const ids: string[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const page = nativePage(await this.rpc.call("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) }), value => nativeId(value));
      for (const id of page.data) { if (ids.includes(id)) nativeInvalid("Duplicate loaded thread identity"); ids.push(id); }
      if (page.nextCursor === null) return ids;
      cursor = nextCursor(page.nextCursor, cursors);
    }
    throw new CodexNativeError("pagination_limit", "Loaded thread list exceeds bounded pagination");
  }
  async readThread(threadId: string): Promise<CodexNativeThread> {
    nativeId(threadId);
    const result = nativeRecord(await this.rpc.call("thread/read", { threadId, includeTurns: false }));
    return parseNativeThread(result.thread, threadId);
  }
  async discover(): Promise<CodexNativeThread[]> {
    const rows: CodexNativeThread[] = [];
    for (const id of await this.listLoaded()) {
      const thread = await this.readThread(id);
      if (thread.status.type !== "notLoaded" && isMainCodexCliThread(thread)) rows.push(thread);
    }
    return rows;
  }
  async readSnapshot(threadId: string, exactTurnId?: string): Promise<CodexNativeSnapshot> {
    nativeId(threadId); if (exactTurnId !== undefined) nativeId(exactTurnId);
    const thread = await this.readThread(threadId);
    const loaded = thread.status.type !== "notLoaded" && (await this.listLoaded()).includes(threadId);
    const turns = await this.readTurns(thread, exactTurnId);
    const latestTurnId = turns[0]?.id ?? null;
    const selectedTurn = exactTurnId ? turns.find(t => t.id === exactTurnId) : turns[0];
    const wanted = new Set([latestTurnId, selectedTurn?.id]);
    for (const turn of turns) if (wanted.has(turn.id) && !turn.itemsComplete) {
      turn.items = await this.readItems(threadId, turn.id); turn.itemsComplete = true;
    }
    const liveIds = new Set(turns.filter(t => t.status === "inProgress").map(t => t.id));
    const pendingInteractions = [...this.getInteractions(threadId).filter(i => liveIds.has(i.turnId)).map(i =>
      hydrateNativeFileApproval(i, turns, this.liveFileChanges.get(itemKey(i.threadId, i.turnId, i.itemId))?.item)),
      ...turns.flatMap(t => nativeAsyncInteractions(threadId, t))];
    return { threadId, thread, loaded, latestTurnId, turns, ...(selectedTurn ? { selectedTurn } : {}), pendingInteractions,
      canSend: loaded && isMainCodexCliThread(thread) && thread.status.type === "idle"
        && !turns.some(t => t.status === "inProgress") && pendingInteractions.length === 0 };
  }
  async subscribe(threadId: string): Promise<void> {
    await this.requireLoaded(threadId);
    if (this.subscribed.has(threadId)) return;
    this.subscribed.add(threadId);
    try { await this.resume(threadId); }
    catch (error) { this.subscribed.delete(threadId); this.clearRequests(threadId); throw error; }
  }
  getInteractions(threadId: string): NativeInteraction[] {
    return [...this.requests.values()].filter(i => i.threadId === threadId).map(i => structuredClone(i));
  }
  async start(threadId: string, options: { text: string; clientUserMessageId: string;
    beforeDispatch?: (snapshot: CodexNativeSnapshot) => Promise<void> }): Promise<CodexNativeReceipt> {
    this.validateInput(options.text, options.clientUserMessageId);
    await this.requireLoaded(threadId);
    const snapshot = await this.readSnapshot(threadId);
    if (!snapshot.canSend) throw new CodexNativeError("thread_not_idle", "Codex native thread is not idle");
    if (snapshot.turns.some(t => t.items.some(i => i.clientId === options.clientUserMessageId))) {
      throw new CodexNativeError("duplicate_submission", "Native submission ID already exists");
    }
    await options.beforeDispatch?.(snapshot);
    const result = await this.rpc.call("turn/start", { threadId, clientUserMessageId: options.clientUserMessageId,
      input: [{ type: "text", text: options.text, text_elements: [] }] }, true);
    try {
      const turn = parseNativeTurn(nativeRecord(result).turn);
      if (snapshot.turns.some(t => t.id === turn.id)) throw new CodexNativeError("thread_not_idle",
        "Codex accepted input into an existing turn", "accepted", undefined, turn.id);
      return { turnId: turn.id, clientUserMessageId: options.clientUserMessageId };
    } catch (error) {
      if (error instanceof CodexNativeError && error.dispatchState === "accepted") throw error;
      throw new CodexNativeError("invalid_response", "Invalid native send receipt; do not resend", "unknown");
    }
  }
  async respond(interaction: NativeInteraction, response: NativeInteractionResponse): Promise<{ dispatchState: "sent" }> {
    await this.requireLoaded(interaction.threadId); await this.subscribe(interaction.threadId);
    const current = this.getInteractions(interaction.threadId).find(i => i.id === interaction.id);
    if (!current || current.requestId === undefined || current.turnId !== interaction.turnId || current.itemId !== interaction.itemId
      || this.answered.has(current.id)) throw new CodexNativeError("stale_interaction", "Native request is no longer pending");
    const snapshot = await this.readSnapshot(interaction.threadId, interaction.turnId);
    if (snapshot.selectedTurn?.status !== "inProgress" || !this.requests.has(requestKey(current.threadId, current.requestId))) {
      throw new CodexNativeError("stale_interaction", "Native request no longer belongs to an active turn");
    }
    if (current.kind === "file_approval") {
      const hydrated = snapshot.pendingInteractions.find(i => i.id === current.id);
      // Pending file items may not be materialized until approved. Preview availability is not native authority.
      if (interaction.changes && hydrated?.changes && JSON.stringify(interaction.changes) !== JSON.stringify(hydrated.changes)) {
        throw new CodexNativeError("stale_interaction", "Native file approval changes no longer match the displayed request");
      }
    }
    const result = nativeResponse(current, response);
    this.answered.add(current.id); this.rpc.respond(current.requestId, result);
    return { dispatchState: "sent" };
  }
  async answerAsync(interaction: NativeInteraction, options: { answer: string; clientUserMessageId: string }): Promise<CodexNativeReceipt> {
    const text = buildNativeAsyncReply(interaction, options.answer); this.validateInput(text, options.clientUserMessageId);
    await this.requireLoaded(interaction.threadId);
    const snapshot = await this.readSnapshot(interaction.threadId, interaction.turnId);
    const current = snapshot.pendingInteractions.find(i => i.id === interaction.id && i.kind === "async_question");
    if (!current || snapshot.selectedTurn?.status !== "inProgress" || this.answered.has(current.id)) {
      throw new CodexNativeError("stale_interaction", "Native asynchronous question is no longer pending");
    }
    this.answered.add(current.id);
    const raw = await this.rpc.call("turn/steer", { threadId: interaction.threadId, expectedTurnId: interaction.turnId,
      clientUserMessageId: options.clientUserMessageId, input: [{ type: "text", text, textElements: [] }] }, true);
    if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).turnId !== interaction.turnId) {
      throw new CodexNativeError("invalid_response", "Native answer returned a different turn", "unknown");
    }
    return { turnId: interaction.turnId, clientUserMessageId: options.clientUserMessageId };
  }
  async readPermissions(threadId: string): Promise<CodexNativePermissions> {
    await this.requireLoaded(threadId); await this.subscribe(threadId);
    return parseNativePermissions(await this.resume(threadId));
  }
  async updatePermissions(threadId: string, preset: CodexNativePermissionPreset): Promise<CodexNativePermissions> {
    if (!Object.hasOwn(PRESETS, preset)) throw new CodexNativeError("invalid_argument", "Unknown permission preset");
    await this.requireLoaded(threadId); await this.subscribe(threadId);
    const [permissions, approvalPolicy] = PRESETS[preset]; this.settings.delete(threadId);
    await this.rpc.call("thread/settings/update", { threadId, permissions, approvalPolicy, approvalsReviewer: "user" }, true);
    // The update acknowledgement only queues settings. Check an event or readback, including a no-op update.
    const deadline = Date.now() + this.rpc.timeoutMs;
    try {
      do {
        const event = this.settings.get(threadId);
        if (event) { const current = parseNativePermissions(event); if (current.preset === preset && current.approvalsReviewer === "user") return current; }
        const current = await this.readPermissions(threadId);
        if (current.preset === preset && current.approvalsReviewer === "user") return current;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, this.rpc.timeoutMs)));
      } while (Date.now() < deadline);
    } catch (error) {
      throw new CodexNativeError(error instanceof CodexNativeError ? error.code : "invalid_response", "Native permission update confirmation failed", "unknown");
    }
    throw new CodexNativeError("timeout", "Native permission update was not confirmed", "unknown");
  }
  private async requireLoaded(threadId: string): Promise<CodexNativeThread> {
    nativeId(threadId);
    if (!(await this.listLoaded()).includes(threadId)) throw new CodexNativeError("thread_not_loaded", "Codex thread is not loaded in this backend");
    const thread = await this.readThread(threadId);
    if (thread.status.type === "notLoaded") throw new CodexNativeError("thread_not_loaded", "Codex thread is no longer loaded");
    if (!isMainCodexCliThread(thread)) throw new CodexNativeError("unsupported_thread", "Target is not a main interactive Codex CLI thread");
    return thread;
  }
  private async resume(threadId: string): Promise<Record<string, unknown>> {
    const result = nativeRecord(await this.rpc.call("thread/resume", { threadId, excludeTurns: true }, true));
    parseNativeThread(result.thread, threadId); return result;
  }
  private async readTurns(thread: CodexNativeThread, exactTurnId?: string): Promise<CodexNativeTurn[]> {
    if (thread.historyMode === "legacy") {
      const result = nativeRecord(await this.rpc.call("thread/read", { threadId: thread.id, includeTurns: true }));
      const read = parseNativeThread(result.thread, thread.id);
      return read.turns.map(t => parseNativeTurn({ ...t, itemsView: "full" })).reverse();
    }
    const turns: CodexNativeTurn[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    for (let index = 0; index < MAX_PAGES; index++) {
      let page: ReturnType<typeof nativePage<CodexNativeTurn>>;
      try { page = nativePage(await this.rpc.call("thread/turns/list", { threadId: thread.id, limit: 100,
        sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}) }), parseNativeTurn); }
      catch (error) {
        if (index === 0 && thread.status.type === "idle" && error instanceof CodexNativeError && error.code === "unmaterialized_thread") return [];
        throw error;
      }
      for (const turn of page.data) {
        if (turns.some(t => t.id === turn.id)) nativeInvalid("Duplicate native turn identity"); turns.push(turn);
      }
      if (!exactTurnId || turns.some(t => t.id === exactTurnId) || page.nextCursor === null) return turns;
      cursor = nextCursor(page.nextCursor, cursors);
    }
    throw new CodexNativeError("pagination_limit", "Exact native task exceeds bounded history lookup");
  }
  private async readItems(threadId: string, turnId: string): Promise<CodexNativeTurn["items"]> {
    const items: CodexNativeTurn["items"] = [], cursors = new Set<string>(); let cursor: string | undefined;
    for (let index = 0; index < MAX_PAGES; index++) {
      const page = nativePage(await this.rpc.call("thread/items/list", { threadId, turnId, limit: 100, sortDirection: "asc",
        ...(cursor ? { cursor } : {}) }), raw => {
        const entry = nativeRecord(raw); if (entry.turnId !== turnId) nativeInvalid("Native history crossed the exact turn");
        return parseNativeItem(entry.item);
      });
      for (const item of page.data) { if (items.some(i => i.id === item.id)) nativeInvalid("Duplicate native task item"); items.push(item); }
      if (page.nextCursor === null) return items;
      cursor = nextCursor(page.nextCursor, cursors);
    }
    throw new CodexNativeError("pagination_limit", "Exact native task items exceed bounded pagination");
  }
  private receive(raw: Record<string, unknown>): void {
    if (!raw.params || typeof raw.params !== "object") return;
    const p = nativeRecord(raw.params);
    if (typeof p.threadId !== "string" || !this.subscribed.has(p.threadId)) return;
    if (this.receiveItemEvent(raw.method, p)) return;
    if (raw.method === "serverRequest/resolved" && (typeof p.requestId === "string" || typeof p.requestId === "number")) {
      this.requests.delete(requestKey(p.threadId, p.requestId)); return;
    }
    if (raw.method === "thread/settings/updated") { this.settings.set(p.threadId, p.threadSettings); return; }
    if (raw.id === undefined) return;
    const interaction = parseNativeRequest(raw);
    if (interaction?.requestId !== undefined) {
      // Replaying one logical request may allocate a new connection-local request ID.
      for (const [key, previous] of this.requests) if (previous.id === interaction.id) this.requests.delete(key);
      this.requests.set(requestKey(interaction.threadId, interaction.requestId), interaction);
    }
  }
  private receiveItemEvent(method: unknown, p: Record<string, unknown>): boolean {
    if (method === "turn/completed") {
      const turnId = nativeRecord(p.turn).id;
      for (const [key, entry] of this.liveFileChanges) if (entry.threadId === p.threadId && entry.turnId === turnId) this.liveFileChanges.delete(key);
      return true;
    }
    if (method !== "item/started" && method !== "item/completed") return false;
    const rawItem = nativeRecord(p.item);
    if (rawItem.type !== "fileChange") return true;
    const threadId = nativeId(p.threadId), turnId = nativeId(p.turnId), item = parseNativeItem(rawItem);
    this.liveFileChanges.set(itemKey(threadId, turnId, item.id), { threadId, turnId, item });
    if (this.liveFileChanges.size > 2000) this.liveFileChanges.delete(this.liveFileChanges.keys().next().value!);
    return true;
  }
  private clearRequests(threadId: string): void {
    for (const [key, value] of this.requests) if (value.threadId === threadId) this.requests.delete(key);
  }
  private validateInput(text: string, clientId: string): void {
    nativeId(clientId);
    if (typeof text !== "string" || !text.trim() || text.length > 1_000_000) throw new CodexNativeError("invalid_argument", "Invalid native task input");
  }
}
function nextCursor(cursor: string, seen: Set<string>): string {
  if (seen.has(cursor)) nativeInvalid("Codex native pagination cursor repeated"); seen.add(cursor); return cursor;
}
function requestKey(threadId: string, requestId: string | number): string { return JSON.stringify([threadId, requestId]); }
function itemKey(threadId: string, turnId: string, itemId: string): string { return JSON.stringify([threadId, turnId, itemId]); }
