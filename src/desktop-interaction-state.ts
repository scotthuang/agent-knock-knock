import { assertDesktopAsyncInteraction, desktopNonblank } from "./desktop-async-state.js";
import { desktopRequestInteractionId } from "./desktop-request-interactions.js";
import type { DesktopInteraction, DesktopRequestInteraction, DesktopThreadIdentity } from "./desktop-types.js";

const methods = {
  command_approval: "item/commandExecution/requestApproval",
  file_approval: "item/fileChange/requestApproval",
  blocking_question: "item/tool/requestUserInput"
} as const;

function assertRequestIdentity(interaction: DesktopRequestInteraction): void {
  if (!interaction || !(interaction.kind in methods) || interaction.method !== methods[interaction.kind] ||
    !desktopNonblank(interaction.id) || !desktopNonblank(interaction.threadId) || !desktopNonblank(interaction.turnId) ||
    !desktopNonblank(interaction.itemId) || !Array.isArray(interaction.questions)) throw new Error("Invalid Desktop request interaction");
  if (!(typeof interaction.requestId === "number" && Number.isSafeInteger(interaction.requestId)) &&
    !desktopNonblank(interaction.requestId)) throw new Error("Desktop interaction requires its native request identity");
}

function assertRequestQuestions(interaction: DesktopRequestInteraction): void {
  if (interaction.kind === "blocking_question" && !interaction.questions.length) throw new Error("Desktop blocking question has no questions");
  if (interaction.kind !== "blocking_question" && interaction.questions.length) throw new Error("Desktop approval cannot contain answer questions");
  const ids = new Set<string>();
  for (const question of interaction.questions) {
    if (!desktopNonblank(question.id) || !desktopNonblank(question.title) || ids.has(question.id) ||
      !Array.isArray(question.options) || question.options.some(option => !desktopNonblank(option))) throw new Error("Invalid Desktop blocking question");
    ids.add(question.id);
  }
}

export function assertDesktopInteraction(value: unknown, target?: DesktopThreadIdentity, turnId?: string): asserts value is DesktopInteraction {
  const interaction = value as DesktopInteraction;
  if (interaction?.kind === "async_question") { assertDesktopAsyncInteraction(value, target, turnId); return; }
  assertRequestIdentity(interaction); assertRequestQuestions(interaction);
  if (target && interaction.threadId !== target.threadId || turnId && interaction.turnId !== turnId) {
    throw new Error("Desktop interaction belongs to a different native task");
  }
  if (interaction.id !== desktopRequestInteractionId(interaction)) throw new Error("Desktop request payload does not match its identity");
}

export function persistDesktopInteraction(interaction: DesktopInteraction): DesktopInteraction {
  assertDesktopInteraction(interaction);
  return structuredClone(interaction);
}
