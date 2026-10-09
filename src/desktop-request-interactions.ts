import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { desktopAsyncQuestions } from "./desktop-async-interactions.js";
import { DesktopIpcError, type DesktopInteraction, type DesktopQuestion, type DesktopRequestInteraction,
  type DesktopRequestResponse, type DesktopSnapshot, type DesktopTurn } from "./desktop-types.js";

export const desktopObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(message: string): never { throw new DesktopIpcError("invalid_response", message); }
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 16_384) invalid("Invalid Desktop request string");
  return value;
}
export function desktopNativeRequestId(value: unknown): string | number {
  if (typeof value === "string" && value.length > 0 && value.length <= 512) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return invalid("Invalid Desktop native request identity");
}

export function desktopRequestInteractionId(value: Omit<DesktopRequestInteraction, "id">): string {
  const fields = [value.kind, value.threadId, value.turnId, value.itemId, value.method, value.requestId, value.questions,
    value.command, value.reason, value.cwd, value.availableDecisions, value.approvalId, value.nativeApprovalKind, value.networkApprovalContext];
  return `desktop-request-interaction:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}

function parseQuestions(value: unknown): DesktopQuestion[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) invalid("Invalid Desktop blocking questions");
  const ids = new Set<string>();
  return value.map(raw => {
    if (!desktopObject(raw)) invalid("Invalid Desktop blocking question");
    const id = text(raw.id);
    if (ids.has(id)) invalid("Duplicate Desktop blocking question"); ids.add(id);
    if (raw.options != null && (!Array.isArray(raw.options) || raw.options.length > 128)) invalid("Invalid Desktop blocking options");
    const options = ((raw.options ?? []) as unknown[]).map(option => {
      if (!desktopObject(option)) invalid("Invalid Desktop blocking option"); return text(option.label);
    });
    return { id, title: text(raw.question), options, isOther: raw.isOther === true, isSecret: raw.isSecret === true };
  });
}

function approvalDetails(params: Record<string, unknown>, result: DesktopRequestInteraction): void {
  for (const key of ["command", "reason", "cwd", "approvalId"] as const) {
    const value = params[key];
    if (value == null) continue;
    if (typeof value !== "string" || value.length > 16_384) invalid("Invalid Desktop approval detail");
    result[key] = value;
  }
  if (params.availableDecisions != null) {
    if (!Array.isArray(params.availableDecisions)) invalid("Invalid Desktop approval decisions");
    result.availableDecisions = params.availableDecisions.filter((value): value is string => typeof value === "string");
  }
  if (result.kind !== "command_approval") return;
  result.nativeApprovalKind = params.kind == null ? "command" : text(params.kind);
  if (params.networkApprovalContext != null) {
    if (!desktopObject(params.networkApprovalContext)) invalid("Invalid Desktop network approval");
    result.networkApprovalContext = { host: text(params.networkApprovalContext.host), protocol: text(params.networkApprovalContext.protocol) };
  }
}

const requestKinds = new Map<string, DesktopRequestInteraction["kind"]>([
  ["item/commandExecution/requestApproval", "command_approval"], ["item/fileChange/requestApproval", "file_approval"],
  ["item/tool/requestUserInput", "blocking_question"]
]);
export function parseDesktopRequestInteraction(raw: unknown, threadId: string, turns: DesktopTurn[]): DesktopRequestInteraction | null {
  if (!desktopObject(raw) || typeof raw.method !== "string") return null;
  const kind = requestKinds.get(raw.method); if (!kind) return null;
  if (!desktopObject(raw.params)) return null;
  const params = raw.params;
  if (params.threadId === undefined || typeof params.turnId !== "string" || typeof params.itemId !== "string") return null;
  if (params.threadId !== threadId) invalid("Desktop request belongs to a different thread");
  const result: DesktopRequestInteraction = { id: "", kind, method: raw.method, requestId: desktopNativeRequestId(raw.id),
    threadId, turnId: text(params.turnId), itemId: text(params.itemId), questions: kind === "blocking_question" ? parseQuestions(params.questions) : [] };
  approvalDetails(params, result);
  result.id = desktopRequestInteractionId(result);
  const item = turns.find(turn => turn.turnId === result.turnId)?.items.find(item => item.id === result.itemId);
  if (kind === "file_approval" && item?.type === "fileChange" && item.changes) result.changes = item.changes;
  return result;
}

export function desktopInteractions(snapshot: DesktopSnapshot, turnId?: string): DesktopInteraction[] {
  const requests = (snapshot.pendingInteractions ?? []).filter((item): item is DesktopRequestInteraction => item.kind !== "async_question");
  return [...requests, ...desktopAsyncQuestions(snapshot, turnId)].filter(item => turnId === undefined || item.turnId === turnId);
}

export function desktopRequestResponse(interaction: DesktopRequestInteraction, response: DesktopRequestResponse): Record<string, unknown> {
  if (interaction.kind !== "blocking_question" && "decision" in response && ["accept", "decline", "cancel"].includes(response.decision)) {
    return { decision: response.decision };
  }
  if (interaction.kind !== "blocking_question" || !("answers" in response) || !desktopObject(response.answers)
    || Object.keys(response.answers).length !== interaction.questions.length) throw new DesktopIpcError("invalid_argument", "Response does not match Desktop request");
  const answers: Record<string, { answers: string[] }> = Object.create(null);
  for (const question of interaction.questions) {
    answers[question.id] = { answers: blockingAnswer(question, response.answers[question.id]) };
  }
  return { answers };
}
function blockingAnswer(question: DesktopQuestion, values: unknown): string[] {
  if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(value => typeof value !== "string"
    || !value.trim() || value.length > 16_384 || (!question.isOther && question.options.length > 0 && !question.options.includes(value)))) {
    throw new DesktopIpcError("invalid_argument", "Invalid Desktop blocking answer");
  }
  return values;
}

function blockingEffect(turn: DesktopTurn, interaction: DesktopRequestInteraction, answers: Record<string, string[]>): string | undefined {
  const matches = turn.items.filter(item => item.type === "userInputResponse" && item.completed === true
    && item.requestId === interaction.requestId && item.turnId === interaction.turnId && item.answers !== undefined
    && isDeepStrictEqual(Object.entries(item.answers).sort(), Object.entries(answers).sort()));
  return matches.length === 1 ? matches[0].id : undefined;
}

export function findDesktopRequestEffect(snapshot: DesktopSnapshot, input: {
  interaction: DesktopRequestInteraction; response: DesktopRequestResponse;
}): { evidence: "exact_blocking_answer_observed" | "exact_approval_item_advanced"; itemId: string } | null {
  const { interaction, response } = input;
  if (snapshot.threadId !== interaction.threadId) return null;
  const turn = snapshot.turns.find(turn => turn.turnId === interaction.turnId);
  if (!turn?.itemsComplete) return null;
  if (snapshot.pendingRequests.some(request => request.requestId === interaction.requestId && request.method === interaction.method)) return null;
  if (interaction.kind === "blocking_question" && "answers" in response) {
    const itemId = blockingEffect(turn, interaction, response.answers);
    return itemId ? { evidence: "exact_blocking_answer_observed", itemId } : null;
  }
  if (!("decision" in response)) return null;
  const item = turn.items.find(item => item.id === interaction.itemId
    && item.type === (interaction.kind === "command_approval" ? "commandExecution" : "fileChange"));
  const expected = response.decision === "accept" ? ["completed", "failed"] : ["declined"];
  return item?.status && expected.includes(item.status) ? { evidence: "exact_approval_item_advanced", itemId: item.id } : null;
}
