import { ConversationRouteError, type ConversationRouteChoice, type ConversationRouteInput,
  type ConversationRouteRecord, type ConversationRouteStore } from "./conversation-route-store.js";

export type ConversationRouteSelection = ConversationRouteChoice & { reason?: string };
export interface ConversationRouteDispatchOptions {
  command: string;
  input?: ConversationRouteInput;
  select(): Promise<ConversationRouteSelection>;
  execute(choice: ConversationRouteSelection): Promise<Record<string, unknown>>;
  store?: ConversationRouteStore;
}

function choiceFromRecord(record: ConversationRouteRecord): ConversationRouteChoice {
  return { route: record.route, targetId: record.target_id };
}
function sameChoice(left: ConversationRouteChoice, right: ConversationRouteChoice): boolean {
  return left.route === right.route && left.targetId === right.targetId;
}
function resultWithRoute(result: Record<string, unknown>, choice: ConversationRouteSelection,
  input?: ConversationRouteInput, replayed = false): Record<string, unknown> {
  return { ...result, ...(replayed ? { replayed: true } : {}),
    ...(input ? { message_id: input.messageId, requested_conversation_id: input.canonicalTarget } : {}),
    routing: { policy: "backend_first", transport: choice.route === "native" ? "codex_backend" : "terminal",
      selected_target: choice.targetId, ...(choice.reason ? { reason: choice.reason } : {}) } };
}
function errorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(code) ? code : undefined;
}
function saveReceipt(store: ConversationRouteStore, input: ConversationRouteInput, choice: ConversationRouteChoice,
  result: Record<string, unknown>): { receipt: Record<string, unknown>; replayed: boolean } {
  try { return { receipt: store.recordReceipt(input, choice, result).receipt!, replayed: false }; }
  catch (error) {
    if (!(error instanceof ConversationRouteError) || error.code !== "conversation_route_conflict") throw error;
    // Concurrent same-message executions are deduplicated by the provider. Their observations can differ;
    // preserve the first receipt only after the journal revalidates immutable input and route identity.
    const existing = store.load(input);
    if (!existing?.receipt || !sameChoice(choice, choiceFromRecord(existing))) throw error;
    return { receipt: existing.receipt, replayed: true };
  }
}

/** Fallback belongs to preflight selection. Once chosen, delivery errors never switch transports. */
export async function dispatchConversationRoute(options: ConversationRouteDispatchOptions): Promise<Record<string, unknown>> {
  if (options.command !== "send") {
    const choice = await options.select();
    return resultWithRoute(await options.execute(choice), choice, options.input);
  }
  const { input, store } = options;
  if (!input || !store) throw new Error("Send routing requires immutable input and a durable route store");
  let record = store.load(input);
  if (record?.receipt) return resultWithRoute(record.receipt, choiceFromRecord(record), input, true);
  let choice: ConversationRouteSelection;
  if (record) choice = choiceFromRecord(record);
  else {
    const selected = await options.select();
    record = store.reserve(input, selected).record;
    choice = sameChoice(selected, choiceFromRecord(record)) ? selected : choiceFromRecord(record);
    if (record.receipt) return resultWithRoute(record.receipt, choice, input, true);
  }
  try {
    // The executor must pass the original stable message ID to its selected provider's dispatch ledger.
    const result = await options.execute(choice);
    const saved = saveReceipt(store, input, choice, result);
    return resultWithRoute(saved.receipt, choice, input, saved.replayed);
  } catch (error) {
    store.markUncertain(input, choice, errorCode(error));
    throw error;
  }
}
