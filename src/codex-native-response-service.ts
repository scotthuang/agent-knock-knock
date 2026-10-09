import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createNativeRecordRepository, type NativeRecordRepository } from "./codex-native-record-store.js";
import { assertNativeIdentity, assertPersistedNativeInteraction, nonblank, persistNativeInteraction, validTime,
  type CodexNativeStateRepository, type PersistedNativeInteraction } from "./codex-native-state-store.js";
import { CodexNativeTaskError, nativeDigest, nativeErrorCode, nativeTurn } from "./codex-native-task-service.js";
import type { CodexNativeIdentity, CodexNativeReceipt, CodexNativeSnapshot, NativeInteraction, NativeInteractionResponse } from "./codex-native-types.js";

export type NativeResponseValue = NativeInteractionResponse | { answer: string };
export interface NativeResponseInput {
  target: CodexNativeIdentity;
  nativeId: string;
  controllerSession: string;
  interactionId: string;
  responseId: string;
  response: NativeResponseValue;
}
export interface CodexNativeResponseRecord {
  schema: "agent-knock-knock/codex-native-response";
  version: 1;
  revision: number;
  id: string;
  created_at: string;
  updated_at: string;
  target: CodexNativeIdentity;
  native_id: string;
  controller_session: string;
  response_id: string;
  interaction: PersistedNativeInteraction;
  response: NativeResponseValue;
  baseline_item_ids: string[];
  baseline_item_status?: string;
  client_user_message_id?: string;
  state: "reserved" | "sent" | "confirmed" | "uncertain" | "not_sent";
  /** Only explicit, proven-before-dispatch retries increment this counter. */
  attempts?: number;
  not_sent_history?: { attempt: number; observed_at: string; error_code?: string }[];
  evidence?: "exact_async_answer_observed" | "native_item_advanced" | "native_turn_settled" | "native_task_continued";
  error_code?: string;
}
export type CodexNativeResponseRepository = NativeRecordRepository<CodexNativeResponseRecord>;
function assertResponseSchema(r: CodexNativeResponseRecord): void {
  if (!r || r.schema !== "agent-knock-knock/codex-native-response" || r.version !== 1 ||
    !Number.isSafeInteger(r.revision) || r.revision < 1 || !/^codex-cli-response:[a-f0-9]{64}$/.test(r.id) ||
    !validTime(r.created_at) || !validTime(r.updated_at) || !nonblank(r.controller_session) || !nonblank(r.response_id) ||
    !["reserved", "sent", "confirmed", "uncertain", "not_sent"].includes(r.state) || !r.response || typeof r.response !== "object" ||
    !Array.isArray(r.baseline_item_ids) || r.baseline_item_ids.some(id => !nonblank(id))) throw new Error("Invalid Codex native response record");
}
function assertResponse(value: unknown): asserts value is CodexNativeResponseRecord {
  const r = value as CodexNativeResponseRecord;
  assertResponseSchema(r);
  assertNativeIdentity(r.native_id, r.target); assertPersistedNativeInteraction(r.interaction, r.target);
  validateResponse(r.interaction, r.response);
  if (r.interaction.kind === "async_question" && !nonblank(r.client_user_message_id)) throw new Error("Native async answer requires correlation identity");
  if (r.state === "confirmed" && !r.evidence) throw new Error("Native response confirmation requires observed evidence");
  if (r.attempts !== undefined && (!Number.isSafeInteger(r.attempts) || r.attempts < 1)) throw new Error("Invalid native response attempt counter");
  if (r.not_sent_history !== undefined && (!Array.isArray(r.not_sent_history) || r.not_sent_history.some(attempt =>
    !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1 || !validTime(attempt.observed_at)))) throw new Error("Invalid native response attempt history");
}
export function createCodexNativeResponseStore(storeDir: string, locks: { acquire(lockPath: string): () => void }): CodexNativeResponseRepository {
  return createNativeRecordRepository({ storeDir, directory: "codex-native-responses", prefix: "codex-cli-response:", acquire: locks.acquire,
    assert: assertResponse,
    assertUpdate: (previous, next) => {
      for (const key of ["id", "created_at", "target", "native_id", "controller_session", "response_id", "interaction", "response", "baseline_item_ids", "baseline_item_status", "client_user_message_id"] as const) {
        if (!isDeepStrictEqual(previous[key], next[key])) throw new Error("Codex native response intent cannot change");
      }
      if (previous.state === "confirmed" && next.state !== "confirmed") throw new Error("Codex native response proof cannot regress");
    } });
}
function validateResponse(interaction: PersistedNativeInteraction, response: NativeResponseValue): void {
  if (interaction.kind.endsWith("approval")) {
    if (!("decision" in response) || !["accept", "decline", "cancel"].includes(response.decision)) throw new CodexNativeTaskError("invalid_argument", "Approval needs accept, decline or cancel");
    return;
  }
  if (interaction.kind === "async_question" && "answer" in response && response.answer.trim()) return;
  if (!("answers" in response) || !response.answers || typeof response.answers !== "object") throw new CodexNativeTaskError("invalid_argument", "Question response requires answers");
  const expected = interaction.questions.map(q => q.id).sort();
  if (!isDeepStrictEqual(Object.keys(response.answers).sort(), expected) || Object.values(response.answers).some(answers => !Array.isArray(answers) || !answers.length || answers.some(answer => !nonblank(answer)))) {
    throw new CodexNativeTaskError("invalid_argument", "Answers must address the exact pending question IDs");
  }
  if (interaction.kind === "async_question" && (expected.length !== 1 || response.answers[expected[0]].length !== 1)) throw new CodexNativeTaskError("invalid_argument", "Async question requires one answer");
}
function asyncAnswer(record: Pick<CodexNativeResponseRecord, "interaction" | "response">): string {
  return "answer" in record.response ? record.response.answer : "answers" in record.response ? record.response.answers[record.interaction.questions[0].id][0] : "";
}
function echoedAnswer(record: CodexNativeResponseRecord, snapshot: CodexNativeSnapshot): boolean {
  const turn = nativeTurn(snapshot, record.interaction.turnId);
  if (!turn?.itemsComplete) return false;
  const messages = turn.items.filter(item => item.type === "userMessage" && item.clientId === record.client_user_message_id);
  if (messages.length !== 1) return false;
  const text = messages[0].content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n") ?? messages[0].text;
  if (typeof text !== "string") return false;
  const match = /^<send_user_message_question_reply>\s*([\s\S]+?)\s*<\/send_user_message_question_reply>$/u.exec(text);
  try {
    const answers = match && JSON.parse(match[1]); const question = record.interaction.questions[0];
    return Array.isArray(answers) && answers.length === 1 && answers[0].questionItemId === question.id &&
      answers[0].question === question.title && answers[0].answer === asyncAnswer(record);
  } catch { return false; }
}
export interface NativeResponseDependencies {
  repository: CodexNativeResponseRepository;
  tasks: CodexNativeStateRepository;
  observe(target: CodexNativeIdentity, exactTurnId?: string): Promise<CodexNativeSnapshot>;
  respond(target: CodexNativeIdentity, interaction: NativeInteraction, response: NativeInteractionResponse): Promise<{ dispatchState: "sent" }>;
  answerAsync(target: CodexNativeIdentity, interaction: NativeInteraction, input: { answer: string; clientUserMessageId: string }): Promise<CodexNativeReceipt>;
  now?(): Date;
  randomUUID?(): string;
}
function reserveKnownNotSentRetry(repository: CodexNativeResponseRepository, record: CodexNativeResponseRecord, date: string): CodexNativeResponseRecord {
  const attempted = record.attempts ?? 1;
  record.not_sent_history = [...(record.not_sent_history ?? []), { attempt: attempted, observed_at: record.updated_at,
    ...(record.error_code ? { error_code: record.error_code } : {}) }];
  record.state = "reserved"; record.attempts = attempted + 1; record.updated_at = date; delete record.error_code;
  return repository.save(record, record.revision);
}
export function createCodexNativeResponseService(deps: NativeResponseDependencies) {
  const repo = deps.repository; const now = deps.now ?? (() => new Date()); const uuid = deps.randomUUID ?? randomUUID;
  function status(id: string): CodexNativeResponseRecord {
    const record = repo.load(id); if (!record) throw new CodexNativeTaskError("codex_native_response_not_found", "Native response was not found"); return record;
  }
  function update(id: string, operation: (record: CodexNativeResponseRecord) => void) {
    return repo.withLock(id, () => { const record = status(id); operation(record); record.updated_at = now().toISOString(); return repo.save(record, record.revision); });
  }
  async function reconcile(id: string): Promise<CodexNativeResponseRecord> {
    const before = status(id); if (["confirmed", "not_sent", "reserved"].includes(before.state)) return before;
    let snapshot: CodexNativeSnapshot;
    try { snapshot = await deps.observe(before.target, before.interaction.turnId); }
    catch (error) { return update(id, record => { record.error_code = nativeErrorCode(error); }); }
    if (snapshot.threadId !== before.target.threadId) throw new CodexNativeTaskError("codex_native_identity_mismatch", "Native answer observation changed identity");
    return update(id, record => {
      const turn = nativeTurn(snapshot, record.interaction.turnId);
      if (["confirmed", "not_sent", "reserved"].includes(record.state) || !turn) return;
      let evidence: CodexNativeResponseRecord["evidence"];
      if (record.interaction.kind === "async_question") {
        if (echoedAnswer(record, snapshot)) evidence = "exact_async_answer_observed";
      } else if (!snapshot.pendingInteractions.some(i => i.id === record.interaction.id)) {
        const item = turn.items.find(i => i.id === record.interaction.itemId);
        if (item && typeof item.status === "string" && item.status !== record.baseline_item_status && item.status !== "inProgress") evidence = "native_item_advanced";
        else if (turn.status !== "inProgress" && turn.itemsComplete) evidence = "native_turn_settled";
        else if (record.interaction.kind === "blocking_question" && turn.items.some(i => !record.baseline_item_ids.includes(i.id) && i.type !== "userMessage")) evidence = "native_task_continued";
      }
      if (evidence) { record.state = "confirmed"; record.evidence = evidence; delete record.error_code; }
    });
  }
  async function respond(input: NativeResponseInput): Promise<CodexNativeResponseRecord> {
    assertNativeIdentity(input.nativeId, input.target);
    if (!input.responseId?.trim() || !input.interactionId?.trim() || !input.controllerSession?.trim()) throw new CodexNativeTaskError("invalid_argument", "Native response requires controller, interaction and response IDs");
    const id = `codex-cli-response:${nativeDigest([input.target, input.interactionId])}`;
    function duplicate(record: CodexNativeResponseRecord) {
      if (record.controller_session !== input.controllerSession || !isDeepStrictEqual(record.response, input.response) ||
        record.native_id !== input.nativeId || record.interaction.id !== input.interactionId) throw new CodexNativeTaskError("codex_native_response_conflict", "This interaction already has a different response intent");
      return record;
    }
    const previous = repo.load(id);
    if (previous) { duplicate(previous); if (previous.state !== "not_sent") return reconcile(id); }
    const snapshot = await deps.observe(input.target);
    const interactions = snapshot.pendingInteractions.filter(i => i.id === input.interactionId && i.threadId === input.target.threadId);
    const interaction = interactions.length === 1 ? interactions[0] : undefined;
    if (!snapshot.loaded || snapshot.threadId !== input.target.threadId || !interaction || nativeTurn(snapshot, interaction.turnId)?.status !== "inProgress") {
      throw new CodexNativeTaskError("stale_interaction", "The exact native interaction is no longer pending");
    }
    validateResponse(interaction, input.response);
    const turn = nativeTurn(snapshot, interaction.turnId)!; const date = now().toISOString();
    const itemStatus = turn.items.find(item => item.id === interaction.itemId)?.status;
    const intent: CodexNativeResponseRecord = { schema: "agent-knock-knock/codex-native-response", version: 1, revision: 1, id,
      created_at: date, updated_at: date, target: structuredClone(input.target), native_id: input.nativeId, controller_session: input.controllerSession,
      response_id: input.responseId, interaction: persistNativeInteraction(interaction), response: structuredClone(input.response), state: "reserved", attempts: 1,
      baseline_item_ids: turn.items.map(item => item.id), ...(typeof itemStatus === "string" ? { baseline_item_status: itemStatus } : {}),
      ...(interaction.kind === "async_question" ? { client_user_message_id: uuid() } : {}) };
    let created = false;
    const reserved = repo.withLock(id, () => {
      const existing = repo.load(id);
      if (existing) {
        duplicate(existing);
        if (existing.state !== "not_sent") return existing;
        created = true; return reserveKnownNotSentRetry(repo, existing, date);
      }
      created = true; return repo.save(intent, null);
    });
    if (!created) return reserved;
    // A crashed or disconnected response is observed on recovery, never automatically replayed.
    update(id, record => { record.state = "uncertain"; });
    try {
      if (interaction.kind === "async_question") {
        const receipt = await deps.answerAsync(input.target, interaction, { answer: asyncAnswer(reserved), clientUserMessageId: reserved.client_user_message_id! });
        if (receipt.turnId !== interaction.turnId || receipt.clientUserMessageId !== reserved.client_user_message_id) throw new Error("Native async answer receipt identity mismatch");
      } else await deps.respond(input.target, interaction, input.response as NativeInteractionResponse);
      update(id, record => { if (record.state !== "confirmed") record.state = "sent"; });
    } catch (error) {
      update(id, record => {
        if (record.state === "confirmed") return;
        record.error_code = nativeErrorCode(error);
        record.state = (error as { dispatchState?: string })?.dispatchState === "not_sent" ? "not_sent" : "uncertain";
      });
    }
    return reconcile(id);
  }
  return {
    respond, reconcile, status, list: () => repo.list(),
    async respondWatch(watchId: string, input: Omit<NativeResponseInput, "target" | "nativeId">) {
      const task = deps.tasks.load(watchId);
      if (!task || task.controller_session !== input.controllerSession) throw new CodexNativeTaskError("codex_native_controller_mismatch", "Watch response requires its owning controller");
      const existing = repo.load(`codex-cli-response:${nativeDigest([task.target, input.interactionId])}`);
      const recordedForTask = existing?.native_id === task.native_id && existing.interaction.turnId === task.native_turn_id;
      if (!recordedForTask && !task.pending_interactions.some(i => i.id === input.interactionId && i.turnId === task.native_turn_id)) {
        throw new CodexNativeTaskError("stale_interaction", "Interaction does not belong to the watched native task");
      }
      return respond({ ...input, target: task.target, nativeId: task.native_id });
    }
  };
}
