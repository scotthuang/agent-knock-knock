import { createHash } from "node:crypto";
import { DesktopIpcError, type DesktopAsyncInteraction, type DesktopSnapshot,
  type DesktopTurn, type DesktopTurnItem } from "./desktop-types.js";

type Reply = { questionItemId: string; question: string; answer: string };
const opening = "<send_user_message_question_reply>", closing = "</send_user_message_question_reply>";

function messageText(item: DesktopTurnItem, turnId: string): string | undefined {
  if (item.type === "steeringUserMessage" && (item.status !== "accepted" || item.targetTurnId !== turnId)) return;
  if (item.type !== "steeringUserMessage" && item.type !== "userMessage") return;
  const content = item.type === "userMessage" ? item.content : item.input;
  return content?.length === 1 && content[0].type === "text" ? content[0].text : undefined;
}

function replies(item: DesktopTurnItem, turnId: string): Reply[] {
  const text = messageText(item, turnId)?.trim();
  if (!text?.startsWith(opening) || !text.endsWith(closing) || text.length > 1024 * 1024) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(opening.length, -closing.length));
    const values: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (values.length < 1 || values.length > 64) return [];
    return values.every((value): value is Reply => Boolean(value && typeof value === "object"
      && !Array.isArray(value) && typeof (value as Reply).questionItemId === "string"
      && typeof (value as Reply).question === "string" && typeof (value as Reply).answer === "string")) ? values : [];
  } catch { return []; }
}

/** Match Desktop's accepted reply history; pending or rejected steering is not an answer. */
export function desktopAsyncQuestions(snapshot: Pick<DesktopSnapshot, "threadId" | "turns">,
  turnId?: string): DesktopAsyncInteraction[] {
  return snapshot.turns.flatMap(turn => {
    if (!turn.itemsComplete || turn.status !== "inProgress" || (turnId !== undefined && turn.turnId !== turnId)) return [];
    const answered = new Set(turn.items.flatMap(item => replies(item, turn.turnId).map(reply => reply.questionItemId)));
    return turn.items.flatMap(item => item.type === "agentMessage" && item.delivery === "async"
      ? (item.questions ?? []).flatMap((question, index): DesktopAsyncInteraction[] => {
        const nativeId = JSON.stringify(["request_user_input_async", item.id, index]);
        if (answered.has(nativeId) || answered.has(item.id)) return [];
        const options = question.options ?? [];
        const digest = createHash("sha256").update(JSON.stringify([
          snapshot.threadId, turn.turnId, item.id, nativeId, question.title, options
        ])).digest("hex");
        return [{ id: `desktop-async-interaction:${digest}`, kind: "async_question", threadId: snapshot.threadId,
          turnId: turn.turnId, itemId: item.id, method: "request_user_input_async",
          questions: [{ id: nativeId, title: question.title, options: [...options], isOther: true }] }];
      }) : []);
  });
}

export function buildDesktopAsyncReply(interaction: DesktopAsyncInteraction, answer: string): string {
  if (interaction.kind !== "async_question" || interaction.questions.length !== 1 || typeof answer !== "string"
    || !answer.trim() || answer.length > 16_384) throw new DesktopIpcError("invalid_argument", "Invalid Desktop asynchronous answer");
  const question = interaction.questions[0];
  return `${opening}\n${JSON.stringify([{ questionItemId: question.id, question: question.title, answer }])}\n${closing}`;
}

export interface DesktopAsyncAnswerEvidence {
  turnId: string;
  interaction: DesktopAsyncInteraction;
  answer: string;
  clientUserMessageId: string;
}

function hasClientId(item: DesktopTurnItem, clientId: string): boolean {
  if (item.type === "userMessage") return item.clientId === clientId;
  return item.type === "steeringUserMessage" && item.clientUserMessageId === clientId
    && (item.serverClientUserMessageId == null || item.serverClientUserMessageId === clientId);
}

function sameReply(item: DesktopTurnItem, input: DesktopAsyncAnswerEvidence): boolean {
  const matches = replies(item, input.turnId);
  const question = input.interaction.questions[0];
  return matches.length === 1 && matches[0].questionItemId === question.id
    && matches[0].question === question.title && matches[0].answer === input.answer;
}

/** Native correlation proves receipt, including steering-to-canonical item materialization. */
export function findDesktopAsyncAnswer(snapshot: DesktopSnapshot, input: DesktopAsyncAnswerEvidence): {
  turn: DesktopTurn; item: DesktopTurnItem;
} | null {
  if (snapshot.threadId !== input.interaction.threadId || input.turnId !== input.interaction.turnId) return null;
  const correlated = snapshot.turns.flatMap(turn => turn.items.filter(item => hasClientId(item, input.clientUserMessageId))
    .map(item => ({ turn, item })));
  if (!correlated.length || correlated.some(({ turn, item }) => turn.turnId !== input.turnId
    || !turn.itemsComplete || !sameReply(item, input))) return null;
  if (correlated.length === 1) return correlated[0];
  // Desktop can retain the accepted steering item alongside its canonical user message.
  if (correlated.length !== 2) return null;
  const steering = correlated.find(({ item }) => item.type === "steeringUserMessage");
  const canonical = correlated.find(({ item }) => item.type === "userMessage");
  return steering && canonical && (steering.item.serverUserMessageId == null
    || steering.item.serverUserMessageId === canonical.item.id) ? canonical : null;
}
