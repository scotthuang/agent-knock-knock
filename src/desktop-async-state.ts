import { createHash } from "node:crypto";
import type { DesktopAsyncInteraction, DesktopThreadIdentity } from "./desktop-types.js";

export function desktopNonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertAsyncIdentity(value: unknown): asserts value is DesktopAsyncInteraction {
  const interaction = value as DesktopAsyncInteraction;
  if (!interaction || interaction.kind !== "async_question" || interaction.method !== "request_user_input_async" ||
    !desktopNonblank(interaction.id) || !desktopNonblank(interaction.threadId) || !desktopNonblank(interaction.turnId) ||
    !desktopNonblank(interaction.itemId) || !Array.isArray(interaction.questions) || interaction.questions.length !== 1) {
    throw new Error("Invalid Desktop async interaction");
  }
}

function assertAsyncQuestion(interaction: DesktopAsyncInteraction): void {
  const question = interaction.questions[0];
  if (!question || !desktopNonblank(question.id) || !desktopNonblank(question.title) ||
    question.isOther !== true || !Array.isArray(question.options) || question.options.some(option => !desktopNonblank(option))) {
    throw new Error("Invalid Desktop async question");
  }
}

function assertNativeQuestionTuple(interaction: DesktopAsyncInteraction): void {
  const question = interaction.questions[0];
  let nativeId: unknown;
  try { nativeId = JSON.parse(question.id); } catch { throw new Error("Invalid Desktop native question identity"); }
  if (!Array.isArray(nativeId) || nativeId.length !== 3 || nativeId[0] !== "request_user_input_async" ||
    nativeId[1] !== interaction.itemId || !Number.isSafeInteger(nativeId[2]) || nativeId[2] < 0 ||
    JSON.stringify(nativeId) !== question.id) throw new Error("Desktop native question identity does not match its item");
}

/** Persist native question identity, not a connection-local owner or a UI position. */
export function assertDesktopAsyncInteraction(value: unknown, target?: DesktopThreadIdentity, turnId?: string): asserts value is DesktopAsyncInteraction {
  assertAsyncIdentity(value);
  const interaction = value;
  if (target && interaction.threadId !== target.threadId || turnId && interaction.turnId !== turnId) {
    throw new Error("Desktop async interaction belongs to a different native task");
  }
  assertAsyncQuestion(interaction); assertNativeQuestionTuple(interaction);
  const question = interaction.questions[0];
  const hash = createHash("sha256").update(JSON.stringify([interaction.threadId, interaction.turnId, interaction.itemId,
    question.id, question.title, question.options])).digest("hex");
  if (interaction.id !== `desktop-async-interaction:${hash}`) throw new Error("Desktop async interaction payload does not match its identity");
}

export function persistDesktopAsyncInteraction(interaction: DesktopAsyncInteraction): DesktopAsyncInteraction {
  assertDesktopAsyncInteraction(interaction);
  return structuredClone(interaction);
}
