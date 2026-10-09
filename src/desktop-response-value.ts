import { isDeepStrictEqual } from "node:util";
import { desktopNonblank } from "./desktop-async-state.js";
import { desktopRequestResponse } from "./desktop-request-interactions.js";
import type { DesktopInteraction, DesktopRequestResponse } from "./desktop-types.js";

export interface DesktopResponseValue { answer?: string; response?: DesktopRequestResponse }

export function validateDesktopResponseValue(interaction: DesktopInteraction, value: DesktopResponseValue): void {
  if (interaction.kind === "async_question") {
    if (!desktopNonblank(value.answer) || value.response !== undefined) throw new Error("Desktop async question requires one answer");
    return;
  }
  if (value.answer !== undefined || !value.response || typeof value.response !== "object") throw new Error("Desktop native request requires a typed response");
  if (interaction.kind === "command_approval" || interaction.kind === "file_approval") {
    if (!("decision" in value.response) || !["accept", "decline"].includes(value.response.decision) ||
      Object.keys(value.response).length !== 1) throw new Error("Desktop approval requires accept or decline");
    return;
  }
  validateBlockingAnswers(interaction, value.response);
  desktopRequestResponse(interaction, value.response);
}

function validateBlockingAnswers(interaction: DesktopInteraction, response: DesktopRequestResponse): void {
  if (!("answers" in response) || !response.answers || typeof response.answers !== "object" ||
    Array.isArray(response.answers) || Object.keys(response).length !== 1) throw new Error("Desktop blocking question requires answers");
  const expectedIds = interaction.questions.map(question => question.id).sort();
  if (!isDeepStrictEqual(Object.keys(response.answers).sort(), expectedIds) ||
    Object.values(response.answers).some(answers => !Array.isArray(answers) || !answers.length || answers.some(answer => !desktopNonblank(answer)))) {
    throw new Error("Desktop answers must address the exact native question IDs");
  }
}
