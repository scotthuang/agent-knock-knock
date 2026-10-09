import { createHash } from "node:crypto";
import { parseDesktopConversationId } from "./desktop-identity.js";
import type { DesktopAsyncInteraction, DesktopInteraction, DesktopQuestion, DesktopRequestResponse } from "./desktop-types.js";
import { isRecord } from "./value-guards.js";

const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const questionId = (item: DesktopInteraction, nativeId: string) => `q:${digest([item.id, nativeId])}`;
const optionId = (item: DesktopInteraction, nativeId: string, label: string) => `o:${digest([item.id, nativeId, label])}`;
const interactionPattern = /^desktop-(?:async|request)-interaction:[0-9a-f]{64}$/u;
const questionPattern = /^q:[0-9a-f]{64}$/u;
const optionPattern = /^o:[0-9a-f]{64}$/u;
type ProjectedQuestion = { question_id: string; title: string; response_kind: string; allow_free_text: boolean;
  is_secret?: boolean; options: { option_id: string; label: string }[] };
export interface ProjectedDesktopInteraction {
  conversation_id?: string; watch_id?: string; interaction_id: string; kind: DesktopInteraction["kind"]; status: "pending";
  native_thread_id: string; native_turn_id: string; delivery_modes?: string[]; expires_at: string;
  interaction_prompt_fingerprint: string; questions: ProjectedQuestion[];
  command?: string; reason?: string; cwd?: string; network?: { host: string; protocol: string };
  file_changes?: { path: string; kind?: string; diff?: string; diffTruncated?: boolean }[];
  available_actions: Record<string, { tool: string; input: Record<string, string> }>;
}
export function desktopInteractionIsApproval(item: { kind: string }): boolean {
  return item.kind === "command_approval" || item.kind === "file_approval";
}
/** Exact request content, never stream revision or elapsed time, defines freshness. */
export function desktopInteractionFingerprint(item: DesktopInteraction): string {
  const request = item.kind === "async_question" ? [] : [item.requestId, item.command, item.reason, item.cwd,
    item.approvalId, item.nativeApprovalKind, item.networkApprovalContext, item.changes];
  return digest([item.id, item.threadId, item.turnId, item.itemId, item.method, item.questions, ...request]);
}
export function desktopInteractionProjection(item: DesktopInteraction, desktopId: string, watchId?: string): ProjectedDesktopInteraction {
  const target: Record<string, string> = watchId ? { watch_id: watchId } : { conversation_id: desktopId };
  const approval = desktopInteractionIsApproval(item);
  return {
    ...target, interaction_id: item.id, kind: item.kind, status: "pending",
    native_thread_id: item.threadId, native_turn_id: item.turnId,
    ...(item.kind === "async_question" ? { delivery_modes: ["steer_current_turn"] } : {}),
    ...(item.kind === "async_question" ? {} : approvalDetails(item)),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    interaction_prompt_fingerprint: desktopInteractionFingerprint(item),
    questions: item.questions.map(question => desktopQuestionProjection(item, question)),
    available_actions: { [approval ? "approve" : "respond"]: {
      tool: approval ? "agent_knock_knock_approve" : "agent_knock_knock_respond_interaction",
      input: { ...target, interaction_id: item.id } } }
  };
}
function approvalDetails(item: Exclude<DesktopInteraction, DesktopAsyncInteraction>) {
  return { ...(item.command ? { command: item.command } : {}), ...(item.reason ? { reason: item.reason } : {}),
    ...(item.cwd ? { cwd: item.cwd } : {}), ...(item.networkApprovalContext ? { network: item.networkApprovalContext } : {}),
    ...(item.changes ? { file_changes: item.changes } : {}) };
}
function desktopQuestionProjection(item: DesktopInteraction, question: DesktopQuestion): ProjectedQuestion {
  return { question_id: questionId(item, question.id), title: question.title,
    response_kind: question.options.length ? "single_select" : "free_text",
    allow_free_text: !question.options.length || question.isOther === true || item.kind === "async_question",
    ...(question.isSecret ? { is_secret: true } : {}),
    options: question.options.map(label => ({ option_id: optionId(item, question.id, label), label })) };
}
/** Reconstruct a whitelist after checking exact subject and task; raw request fields never escape. */
export function validateDesktopInteractionProjections(value: unknown, desktopId: unknown,
  watchId?: unknown, turnId?: unknown): ProjectedDesktopInteraction[] {
  if (typeof desktopId !== "string" || !Array.isArray(value) || value.length > 128) throw new Error("Invalid Desktop interaction projection");
  const identity = parseDesktopConversationId(desktopId);
  if (watchId !== undefined && (typeof watchId !== "string" || !/^desktop-watch:[A-Za-z0-9_-]{8,128}$/u.test(watchId))) throw new Error("Invalid Desktop Watch identity");
  const ids = new Set<string>();
  return value.map(item => {
    assertProjectedInteraction(item, { desktopId, watchId, threadId: identity.threadId, turnId });
    if (ids.has(item.interaction_id)) throw new Error("Duplicate Desktop interaction");
    ids.add(item.interaction_id);
    return copyProjectedInteraction(item, desktopId, typeof watchId === "string" ? watchId : undefined);
  });
}
function copyProjectedInteraction(item: ProjectedDesktopInteraction, desktopId: string, watchId?: string): ProjectedDesktopInteraction {
  const target: Record<string, string> = watchId ? { watch_id: watchId } : { conversation_id: desktopId };
  const approval = desktopInteractionIsApproval(item);
  return { ...copyProjectedApprovalDetails(item), ...target, interaction_id: item.interaction_id, kind: item.kind, status: "pending",
    native_thread_id: item.native_thread_id, native_turn_id: item.native_turn_id,
    ...(item.kind === "async_question" ? { delivery_modes: ["steer_current_turn"] } : {}),
    expires_at: item.expires_at,
    interaction_prompt_fingerprint: item.interaction_prompt_fingerprint,
    questions: item.questions.map(q => ({ question_id: q.question_id, title: q.title, response_kind: q.response_kind,
      allow_free_text: q.allow_free_text, ...(q.is_secret ? { is_secret: true } : {}),
      options: q.options.map(o => ({ option_id: o.option_id, label: o.label })) })),
    available_actions: { [approval ? "approve" : "respond"]: {
      tool: approval ? "agent_knock_knock_approve" : "agent_knock_knock_respond_interaction",
      input: { ...target, interaction_id: item.interaction_id } } } };
}
function copyProjectedApprovalDetails(item: ProjectedDesktopInteraction) {
  const details: Partial<ProjectedDesktopInteraction> = {};
  for (const field of ["command", "reason", "cwd"] as const) {
    if (typeof item[field] === "string") details[field] = item[field];
  }
  if (isRecord(item.network) && typeof item.network.host === "string" && typeof item.network.protocol === "string") {
    details.network = { host: item.network.host, protocol: item.network.protocol };
  }
  if (Array.isArray(item.file_changes)) details.file_changes = item.file_changes
    .filter(change => isRecord(change) && typeof change.path === "string").map(projectedFileChange);
  return details;
}
function projectedFileChange(change: NonNullable<ProjectedDesktopInteraction["file_changes"]>[number]) {
  return { path: change.path, ...(typeof change.kind === "string" ? { kind: change.kind } : {}),
    ...(typeof change.diff === "string" ? { diff: change.diff } : {}), ...(change.diffTruncated === true ? { diffTruncated: true } : {}) };
}
function assertProjectedInteraction(item: unknown, target: { desktopId: string; watchId: unknown; threadId: string; turnId: unknown }):
  asserts item is ProjectedDesktopInteraction {
  if (!isRecord(item) || typeof item.interaction_id !== "string" || !interactionPattern.test(item.interaction_id)
    || !["async_question", "blocking_question", "command_approval", "file_approval"].includes(String(item.kind))
    || item.status !== "pending" || item.native_thread_id !== target.threadId
    || typeof item.native_turn_id !== "string" || !item.native_turn_id || (typeof target.turnId === "string" && item.native_turn_id !== target.turnId)
    || (target.watchId ? item.watch_id !== target.watchId : item.conversation_id !== target.desktopId)) throw new Error("Desktop interaction identity mismatch");
  if ((item.kind === "async_question") !== item.interaction_id.startsWith("desktop-async-interaction:")) throw new Error("Desktop interaction identity mismatch");
  assertProjectedQuestionDetails(item);
}
function assertProjectedQuestionDetails(item: Record<string, unknown>): void {
  if (!Array.isArray(item.questions) || item.questions.length > 16 || typeof item.expires_at !== "string"
    || !Number.isFinite(Date.parse(item.expires_at))) throw new Error("Invalid Desktop interaction projection");
  if (item.kind === "async_question" && (item.questions.length !== 1 || !Array.isArray(item.delivery_modes)
    || item.delivery_modes.length !== 1 || item.delivery_modes[0] !== "steer_current_turn")) throw new Error("Invalid Desktop async projection");
  if (item.kind !== "async_question" && item.delivery_modes !== undefined) throw new Error("Blocking Desktop interactions cannot steer replies");
  if (item.kind === "blocking_question" && !item.questions.length) throw new Error("Empty Desktop questionnaire");
  if (["command_approval", "file_approval"].includes(String(item.kind)) && item.questions.length) throw new Error("Desktop approval cannot contain question answers");
  const ids = new Set<string>();
  for (const question of item.questions) {
    assertProjectedQuestion(question);
    if (ids.has(question.question_id)) throw new Error("Duplicate Desktop question");
    ids.add(question.question_id);
  }
}
function assertProjectedQuestion(q: unknown): asserts q is ProjectedQuestion {
  if (!isRecord(q) || typeof q.question_id !== "string" || !questionPattern.test(q.question_id)
    || typeof q.title !== "string" || !q.title || !["single_select", "free_text"].includes(String(q.response_kind))
    || typeof q.allow_free_text !== "boolean" || !Array.isArray(q.options) || q.options.length > 32
    || q.options.some(option => !validProjectedOption(option))) throw new Error("Invalid Desktop question");
}
function validProjectedOption(option: unknown): boolean {
  return isRecord(option) && typeof option.option_id === "string" && optionPattern.test(option.option_id) && typeof option.label === "string";
}
export function desktopQuestionAnswer(interaction: DesktopAsyncInteraction, value: unknown): string {
  const answers = desktopQuestionResponse(interaction, value);
  return answers.answers[interaction.questions[0].id][0];
}
/** Answer every question from one exact native request in a single structured response. */
export function desktopQuestionResponse(interaction: DesktopInteraction, value: unknown): Extract<DesktopRequestResponse, { answers: unknown }> {
  const projection = desktopInteractionProjection(interaction, "unused");
  const selected = projectedAnswers(projection, value);
  const answers: Record<string, string[]> = {};
  for (const question of interaction.questions) {
    Object.defineProperty(answers, question.id, { value: [selected.get(questionId(interaction, question.id))!], enumerable: true });
  }
  return { answers };
}
export function validateDesktopProjectedAnswer(projection: ProjectedDesktopInteraction, value: unknown): void {
  projectedAnswers(projection, value);
}
function projectedAnswers(projection: ProjectedDesktopInteraction, value: unknown): Map<string, string> {
  assertAnswerEnvelope(projection, value);
  const answers = new Map<string, string>();
  for (const answer of value.answers) {
    if (!isRecord(answer)) throw new Error("Invalid Desktop answer");
    const question = projection.questions.find(q => q.question_id === answer.question_id);
    if (!question || answers.has(question.question_id)) throw new Error("Desktop question ID does not match or is duplicated");
    answers.set(question.question_id, projectedDesktopAnswerText(question, answer));
  }
  return answers;
}
function assertAnswerEnvelope(projection: ProjectedDesktopInteraction, value: unknown): asserts value is Record<string, unknown> & { answers: unknown[] } {
  if (desktopInteractionIsApproval(projection) || !isRecord(value) || value.interaction_id !== projection.interaction_id
    || !Array.isArray(value.answers) || value.answers.length !== projection.questions.length
    || Object.keys(value).some(key => !["interaction_id", "answers", "delivery_mode"].includes(key))) throw new Error("Answer must match every question in one current Desktop interaction");
  if (value.delivery_mode !== undefined && (projection.kind !== "async_question" || value.delivery_mode !== "steer_current_turn")) {
    throw new Error("Answer must use one current Desktop async delivery mode");
  }
}
function projectedDesktopAnswerText(question: ProjectedQuestion, answer: Record<string, unknown>): string {
  if (answer.response_kind === "single_select") {
    if (Object.keys(answer).some(key => !["question_id", "response_kind", "selected_option_ids"].includes(key))
      || !Array.isArray(answer.selected_option_ids) || answer.selected_option_ids.length !== 1) throw new Error("Select one advertised Desktop option");
    const option = question.options.find(item => item.option_id === (answer.selected_option_ids as unknown[])[0]);
    if (!option) throw new Error("Selected Desktop option is absent");
    return option.label;
  }
  if (answer.response_kind !== "free_text" || !question.allow_free_text
    || Object.keys(answer).some(key => !["question_id", "response_kind", "text"].includes(key))
    || typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > 4096
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(answer.text)) throw new Error("Invalid Desktop free-text answer");
  return answer.text;
}
