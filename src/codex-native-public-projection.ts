import { createHash } from "node:crypto";
import { createCodexNativeConversationId } from "./codex-native-identity.js";
import { parseCodexNativeConversationId } from "./codex-native-identity.js";
import type { CodexNativeTaskRecord, PersistedNativeInteraction } from "./codex-native-state-store.js";
import type { CodexNativeIdentity, CodexNativeSnapshot, CodexNativeTurn, NativeInteractionResponse } from "./codex-native-types.js";
import { isRecord } from "./value-guards.js";

const semanticId = (kind: string, parts: unknown[]): string => `${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
const questionId = (interaction: PersistedNativeInteraction, nativeId: string) => semanticId("q", [interaction.id, nativeId]);
const optionId = (interaction: PersistedNativeInteraction, nativeId: string, option: string) => semanticId("o", [interaction.id, nativeId, option]);

/** Keep native request projections separate from terminal screen-derived questionnaire contracts. */
export function validateNativeInteractionProjections(value: unknown, conversationId: unknown, watchId?: unknown): unknown[] {
  if (typeof conversationId !== "string" || !Array.isArray(value) || value.length > 128) throw new Error("Invalid native interaction projection");
  const identity = parseCodexNativeConversationId(conversationId);
  const ids = new Set<string>();
  for (const item of value) {
    assertNativeInteractionProjection(item, { threadId: identity.threadId, conversationId, watchId, ids });
    ids.add(item.interaction_id);
    for (const question of item.questions) assertNativeQuestionProjection(question);
  }
  return value;
}

type ValidatedNativeInteraction = Record<string, unknown> & { interaction_id: string; questions: unknown[] };

function assertNativeInteractionProjection(item: unknown, expected: {
  threadId: string; conversationId: string; watchId: unknown; ids: Set<string>
}): asserts item is ValidatedNativeInteraction {
  if (!isRecord(item) || typeof item.interaction_id !== "string" || !/^codex-native-interaction:[0-9a-f]{64}$/u.test(item.interaction_id)
    || expected.ids.has(item.interaction_id) || item.native_thread_id !== expected.threadId || typeof item.native_turn_id !== "string"
    || item.status !== "pending" || !["command_approval", "file_approval", "blocking_question", "async_question"].includes(String(item.kind))
    || !Array.isArray(item.questions) || item.questions.length > 16
    || (expected.watchId ? item.watch_id !== expected.watchId : item.conversation_id !== expected.conversationId)) {
    throw new Error("Native interaction identity mismatch");
  }
}

function assertNativeQuestionProjection(question: unknown): void {
  if (!isRecord(question) || typeof question.question_id !== "string" || !/^q:[0-9a-f]{64}$/u.test(question.question_id)
    || typeof question.title !== "string" || !["single_select", "free_text"].includes(String(question.response_kind))
    || !Array.isArray(question.options) || question.options.some(option => !isNativeOptionProjection(option))) {
    throw new Error("Invalid native question projection");
  }
}

function isNativeOptionProjection(option: unknown): boolean {
  return isRecord(option) && typeof option.option_id === "string" &&
    /^o:[0-9a-f]{64}$/u.test(option.option_id) && typeof option.label === "string";
}

export function nativeInteractionProjection(interaction: PersistedNativeInteraction, conversationId: string, watchId?: string) {
  const target = watchId ? { watch_id: watchId } : { conversation_id: conversationId };
  const approval = interaction.kind === "command_approval" || interaction.kind === "file_approval";
  return {
    ...target, interaction_id: interaction.id, kind: interaction.kind, status: "pending",
    native_thread_id: interaction.threadId, native_turn_id: interaction.turnId,
    ...(interaction.command ? { command: interaction.command } : {}),
    ...(interaction.reason ? { reason: interaction.reason } : {}),
    ...(interaction.networkApprovalContext ? { network: interaction.networkApprovalContext } : {}),
    ...(interaction.cwd ? { cwd: interaction.cwd } : {}),
    ...(interaction.changes ? { file_changes: interaction.changes } : {}),
    ...(interaction.kind === "async_question" ? { delivery_modes: ["steer_current_turn"] } : {}),
    questions: interaction.questions.map(question => ({
      question_id: questionId(interaction, question.id), title: question.title,
      ...(question.isSecret ? { is_secret: true } : {}),
      response_kind: question.options.length ? "single_select" : "free_text",
      allow_free_text: !question.options.length || question.isOther === true || interaction.kind === "async_question",
      options: question.options.map(option => ({ option_id: optionId(interaction, question.id, option), label: option }))
    })),
    available_actions: approval
      ? { approve: { tool: "agent_knock_knock_approve", input: { ...target, interaction_id: interaction.id } } }
      : { respond: { tool: "agent_knock_knock_respond_interaction", input: { ...target, interaction_id: interaction.id } } }
  };
}

/** Resolve advertised opaque IDs against fresh native questions, never against labels supplied by a caller. */
export function nativeQuestionResponse(interaction: PersistedNativeInteraction, value: unknown): NativeInteractionResponse {
  assertNativeQuestionResponseEnvelope(interaction, value);
  const answers: Record<string, string[]> = {};
  for (const answer of value.answers) {
    if (!isRecord(answer)) throw new Error("Invalid question answer");
    const question = interaction.questions.find(q => questionId(interaction, q.id) === answer.question_id);
    if (!question || Object.hasOwn(answers, question.id)) throw new Error("Question ID is absent or duplicated");
    Object.defineProperty(answers, question.id, { value: [nativeQuestionAnswerText(interaction, question, answer)], enumerable: true });
  }
  return { answers };
}

function assertNativeQuestionResponseEnvelope(interaction: PersistedNativeInteraction, value: unknown):
  asserts value is Record<string, unknown> & { answers: unknown[] } {
  if (!isRecord(value) || value.interaction_id !== interaction.id || !Array.isArray(value.answers) ||
    value.answers.length !== interaction.questions.length ||
    Object.keys(value).some(key => !["interaction_id", "answers", "delivery_mode"].includes(key))) {
    throw new Error("Answer must match the current Codex CLI interaction and every question");
  }
  if (value.delivery_mode !== undefined && (interaction.kind !== "async_question" || value.delivery_mode !== "steer_current_turn")) {
    throw new Error("This Codex CLI question does not support the requested delivery mode");
  }
  if (!["blocking_question", "async_question"].includes(interaction.kind)) throw new Error("Current interaction is an approval, not a question");
}

type NativeQuestion = PersistedNativeInteraction["questions"][number];

function nativeQuestionAnswerText(interaction: PersistedNativeInteraction, question: NativeQuestion,
  answer: Record<string, unknown>): string {
  if (answer.response_kind === "single_select") return nativeSelectedOptionText(interaction, question, answer);
  if (answer.response_kind === "free_text") return nativeFreeTextAnswer(interaction, question, answer);
  throw new Error("Unsupported Codex CLI response kind");
}

function nativeSelectedOptionText(interaction: PersistedNativeInteraction, question: NativeQuestion,
  answer: Record<string, unknown>): string {
  if (Object.keys(answer).some(key => !["question_id", "response_kind", "selected_option_ids"].includes(key)) ||
    !Array.isArray(answer.selected_option_ids) || answer.selected_option_ids.length !== 1) throw new Error("Select one advertised option ID");
  const selected = answer.selected_option_ids[0];
  const option = question.options.find(o => optionId(interaction, question.id, o) === selected);
  if (option === undefined) throw new Error("Selected option is no longer available");
  return option;
}

function nativeFreeTextAnswer(interaction: PersistedNativeInteraction, question: NativeQuestion,
  answer: Record<string, unknown>): string {
  if (Object.keys(answer).some(key => !["question_id", "response_kind", "text"].includes(key)) ||
    question.options.length && !question.isOther && interaction.kind !== "async_question" ||
    typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(answer.text)) {
    throw new Error("Free text is invalid or not allowed for this question");
  }
  return answer.text;
}

export function nativeTurnProjection(turn: CodexNativeTurn | undefined) {
  if (!turn) return null;
  const messages = turn.items.filter(item => item.type === "agentMessage" && typeof item.text === "string");
  const finals = messages.filter(item => item.phase === "final_answer");
  const text = (finals.length ? finals : messages.filter(item => item.phase == null)).map(item => item.text).join("\n\n");
  return { id: turn.id, status: turn.status, items_complete: turn.itemsComplete,
    ...(turn.status !== "inProgress" && turn.itemsComplete ? { final_text: text } : { response_text: text }) };
}

export function codexNativeSessionProjection(identity: CodexNativeIdentity, snapshot: CodexNativeSnapshot, backendVersion: string, interactionsScanned = false) {
  const id = createCodexNativeConversationId(identity);
  const active = snapshot.turns.filter(turn => turn.status === "inProgress");
  const watch = snapshot.loaded && active.length === 1 && active[0].id === snapshot.latestTurnId;
  return {
    id, conversation_id: id, source: "codex_cli", agent: "codex",
    title: snapshot.thread.name ?? snapshot.thread.preview ?? "Codex CLI", cwd: snapshot.thread.cwd,
    native_thread_id: identity.threadId, native_turn_id: snapshot.latestTurnId,
    backend_version: backendVersion, connection_state: snapshot.loaded ? "loaded_backend_verified" : "not_loaded",
    activity_state: snapshot.thread.status.type,
    active_flags: snapshot.thread.status.type === "active" ? snapshot.thread.status.activeFlags : [],
    interaction_requests_scanned: interactionsScanned,
    pending_interaction_count: interactionsScanned ? snapshot.pendingInteractions.length : null,
    attention_required: snapshot.pendingInteractions.length > 0 || snapshot.thread.status.type === "active" && snapshot.thread.status.activeFlags.length > 0,
    capabilities: { status: true, send: snapshot.canSend, watch, interaction_notify: watch,
      interaction_respond: snapshot.loaded, approve: snapshot.loaded, set_permissions: snapshot.loaded },
    interaction_state: snapshot.pendingInteractions.map(item => nativeInteractionProjection(item, id)),
    latest_turn: nativeTurnProjection(snapshot.turns.find(turn => turn.id === snapshot.latestTurnId)),
    available_actions: {
      status: { tool: "agent_knock_knock_status", input: { conversation_id: id } },
      ...(snapshot.canSend ? { send: { tool: "agent_knock_knock_send", input: { conversation_id: id } } } : {}),
      ...(watch ? { watch: { tool: "agent_knock_knock_watch", input: { conversation_id: id } } } : {}),
      ...(snapshot.loaded ? { permission_options: { tool: "agent_knock_knock_permission_options", input: { conversation_id: id } } } : {})
    }
  };
}

export function codexNativeTaskProjection(task: CodexNativeTaskRecord) {
  const intent = task.send_intent;
  const active = task.status === "watching" || task.status === "awaiting_acceptance";
  const notifications = task.notifications.map(note => ({ id: note.id, status: note.status, attempts: note.attempts,
    ...(note.outcome && "error_code" in note.outcome ? { error_code: note.outcome.error_code } : {}) }));
  return {
    watch_id: task.id, conversation_id: task.native_id, source: "codex_cli", status: task.status,
    native_thread_id: task.target.threadId, native_turn_id: task.native_turn_id ?? null,
    observation_mode: task.native_turn_id ? "exact_task" : "pending_acceptance", anchor_state: task.native_turn_id ? "verified" : "pending",
    created_at: task.created_at, updated_at: task.updated_at, observed_at: task.observed_at,
    observation_error: task.observation_error, final_text: task.final_text,
    pending_interaction_count: task.pending_interactions.length,
    interaction_state: task.pending_interactions.map(item => nativeInteractionProjection(item, task.native_id, task.id)),
    callback_configured: Boolean(task.callback_route), callback_expected: Boolean(task.callback_route && task.status !== "cancelled" &&
      (active || notifications.some(note => ["ready", "leased", "retry_wait"].includes(note.status)))),
    callback_notifications: notifications,
    capabilities: { callback: Boolean(task.callback_route), interaction_notify: active && Boolean(task.callback_route),
      interaction_respond: active, approve: active },
    ...(intent ? { message_id: intent.message_id, delivered: intent.state === "accepted", send_state: intent.state,
      delivery_receipt: intent.state === "accepted" ? "native_task_verified" : intent.state === "not_sent" ? "not_sent" : "acceptance_unproven",
      agent_acceptance: intent.state === "accepted" ? "proven" : "unproven", send_error: intent.error_code, resend_allowed: false } : {})
  };
}
