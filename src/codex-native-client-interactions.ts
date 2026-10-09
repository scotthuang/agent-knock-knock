import { CodexNativeError, type NativeInteraction, type NativeInteractionResponse, type CodexNativeTurn } from "./codex-native-types.js";
import { nativeId, nativeRecord, nativeInvalid, nativeInteractionId } from "./codex-native-snapshot.js";

const methods = new Map<string, NativeInteraction["kind"]>([
  ["item/commandExecution/requestApproval", "command_approval"],
  ["item/fileChange/requestApproval", "file_approval"], ["item/tool/requestUserInput", "blocking_question"]
]);
export function parseNativeRequest(raw: Record<string, unknown>): NativeInteraction | null {
  const kind = methods.get(String(raw.method)); if (!kind) return null;
  if ((typeof raw.id !== "string" && !Number.isSafeInteger(raw.id)) || raw.id === undefined) nativeInvalid("Invalid native request id");
  const p = nativeRecord(raw.params); const threadId = nativeId(p.threadId), turnId = nativeId(p.turnId), itemId = nativeId(p.itemId);
  const questions = kind === "blocking_question" ? parseQuestions(p.questions) : [];
  const details = approvalDetails(p, kind);
  return { id: nativeInteractionId([threadId, turnId, itemId, raw.method, questions, details]), kind, threadId, turnId, itemId,
    method: String(raw.method), requestId: raw.id as string | number, questions, ...details };
}
function approvalDetails(p: Record<string, unknown>, kind: NativeInteraction["kind"]):
  Pick<NativeInteraction, "command" | "reason" | "cwd" | "availableDecisions" | "approvalId" | "nativeApprovalKind" | "networkApprovalContext"> {
  const details: ReturnType<typeof approvalDetails> = {};
  for (const field of ["command", "reason", "cwd"] as const) {
    if (p[field] != null && typeof p[field] !== "string") nativeInvalid("Invalid native approval detail");
    if (typeof p[field] === "string") details[field] = p[field];
  }
  if (p.availableDecisions != null) {
    if (!Array.isArray(p.availableDecisions)) nativeInvalid("Invalid native approval decisions");
    details.availableDecisions = p.availableDecisions.filter((d): d is string => typeof d === "string");
  }
  if (kind === "command_approval") {
    details.nativeApprovalKind = p.kind == null ? "command" : nativeId(p.kind);
    if (p.approvalId != null) details.approvalId = nativeId(p.approvalId);
    if (p.networkApprovalContext != null) {
      const network = nativeRecord(p.networkApprovalContext);
      details.networkApprovalContext = { host: nativeId(network.host, 4096), protocol: nativeId(network.protocol) };
    }
  }
  return details;
}
function parseQuestions(value: unknown): NativeInteraction["questions"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) nativeInvalid("Invalid native blocking questions");
  const ids = new Set<string>();
  return value.map(raw => {
    const q = nativeRecord(raw); const id = nativeId(q.id);
    if (ids.has(id) || typeof q.question !== "string") nativeInvalid("Invalid native question identity"); ids.add(id);
    if (q.options != null && !Array.isArray(q.options)) nativeInvalid("Invalid native question options");
    const options = ((q.options ?? []) as unknown[]).map(raw => {
      const option = nativeRecord(raw);
      if (typeof option.label !== "string") nativeInvalid("Invalid native question option"); return option.label;
    });
    return { id, title: q.question, options, isOther: q.isOther === true, isSecret: q.isSecret === true };
  });
}
export function nativeResponse(interaction: NativeInteraction, response: NativeInteractionResponse): Record<string, unknown> {
  if (interaction.kind === "blocking_question" && "answers" in response) {
    const keys = Object.keys(response.answers);
    if (keys.length !== interaction.questions.length || interaction.questions.some(q => !Object.hasOwn(response.answers, q.id))) {
      throw new CodexNativeError("invalid_argument", "Answer must identify every native question exactly once");
    }
    const answers: Record<string, { answers: string[] }> = Object.create(null);
    for (const q of interaction.questions) {
      const values = response.answers[q.id];
      if (!Array.isArray(values) || values.length < 1 || values.length > 100 || values.some(value => typeof value !== "string"
        || !value.trim() || value.length > 16_384 || (!q.isOther && q.options.length > 0 && !q.options.includes(value)))) {
        throw new CodexNativeError("invalid_argument", "Invalid answer for native question");
      }
      answers[q.id] = { answers: values };
    }
    return { answers };
  }
  if ((interaction.kind === "command_approval" || interaction.kind === "file_approval") && "decision" in response
    && ["accept", "decline", "cancel"].includes(response.decision)) {
    if (interaction.availableDecisions && !interaction.availableDecisions.includes(response.decision)) {
      throw new CodexNativeError("invalid_argument", "Decision is not offered by this native approval");
    }
    return { decision: response.decision };
  }
  throw new CodexNativeError("invalid_argument", "Response does not match native interaction kind");
}

export function buildNativeAsyncReply(interaction: NativeInteraction, answer: string): string {
  if (interaction.kind !== "async_question" || interaction.questions.length !== 1 || typeof answer !== "string"
    || !answer.trim() || answer.length > 16_384) throw new CodexNativeError("invalid_argument", "Invalid native asynchronous answer");
  const question = interaction.questions[0];
  return `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: question.id,
    question: question.title, answer }])}\n</send_user_message_question_reply>`;
}

/** Preview comes from the same native item as the pending approval, never a nearby diff. */
export function hydrateNativeFileApproval(interaction: NativeInteraction, turns: CodexNativeTurn[],
  liveItem?: CodexNativeTurn["items"][number]): NativeInteraction {
  if (interaction.kind !== "file_approval") return interaction;
  const turn = turns.find(t => t.id === interaction.turnId);
  const item = turn?.items.find(i => i.id === interaction.itemId && i.type === "fileChange")
    ?? (liveItem?.id === interaction.itemId && liveItem.type === "fileChange" ? liveItem : undefined);
  if (!item) return interaction; // The canonical item can appear one polling tick after the request.
  if (!Array.isArray(item.changes) || item.changes.length === 0) nativeInvalid("Native file approval omitted exact changes");
  const changes = item.changes.map(raw => {
    const change = nativeRecord(raw); const path = nativeId(change.path, 16_384);
    const kind = change.kind == null ? undefined : typeof change.kind === "string" ? change.kind : nativeRecord(change.kind).type;
    if (kind !== undefined && typeof kind !== "string") nativeInvalid("Invalid native file change kind");
    if (change.diff !== undefined && typeof change.diff !== "string") nativeInvalid("Invalid native file diff");
    const diffBytes = typeof change.diff === "string" ? Buffer.from(change.diff) : undefined;
    return { path, ...(typeof kind === "string" ? { kind } : {}),
      ...(diffBytes ? { diff: diffBytes.subarray(0, 16_384).toString("utf8"), ...(diffBytes.length > 16_384 ? { diffTruncated: true } : {}) } : {}) };
  });
  return { ...interaction, changes };
}
