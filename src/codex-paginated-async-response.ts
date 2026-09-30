import { isAuditedCodexPaginatedServerPair, isCodexPaginatedVersion } from "./codex-lifecycle-compatibility.js";
import { readCodexPaginatedAsyncQuestions } from "./codex-paginated-observation.js";
import { deliverCodexPaginatedAsyncAnswer } from "./codex-paginated-async-answer.js";
import type { CodexAsyncQuestionDurableEvidence, CodexAsyncQuestionDurableQuestion } from "./codex-async-question-adapter.js";
import type { TerminalAgentBridge } from "./terminal-agent-bridge.js";
import type { TerminalRuntimeIdentity } from "./terminal-agent-adapter.js";
import type { TerminalControlRef, TerminalControlEvidence } from "./terminal-control-ref.js";
import {
  captureTerminalInteractionRuntimeOffer,
  TerminalInteractionInputNotStartedError,
  TerminalInteractionDispatchReservedError,
  type TerminalInteractionResponseOptions,
  type TerminalInteractionResponseExecution,
  type TerminalInteractionRuntimeOffer
} from "./terminal-interaction-response-bridge.js";
import {
  validateTerminalInteractionSubjectResponse,
  type TerminalInteractionSubjectResponse
} from "./terminal-interaction-protocol.js";

interface PaginatedAsyncResponseInput {
  bridge: Pick<TerminalAgentBridge, "status" | "respondInteraction">;
  terminalControl: TerminalControlRef;
  terminalEvidence: TerminalControlEvidence;
  runtime: TerminalRuntimeIdentity;
  response: TerminalInteractionSubjectResponse;
  options: TerminalInteractionResponseOptions;
  now: () => Date;
  readQuestions?: typeof readCodexPaginatedAsyncQuestions;
  deliver?: typeof deliverCodexPaginatedAsyncAnswer;
}

/** UI navigation may open an Other editor; actual answers use native turn CAS. */
export async function respondCodexPaginatedAsyncQuestion(
  input: PaginatedAsyncResponseInput
): Promise<TerminalInteractionResponseExecution> {
  const { offer, evidence } = await recaptureAsyncOffer(input);
  const native = offer.nativeInspection;
  if (!("interaction_kind" in native) || native.interaction_kind !== "async_question" || !native.async_inspection.match) {
    throw new TerminalInteractionInputNotStartedError("Codex async question has no exact native identity");
  }
  const match = native.async_inspection.match;
  const [itemId, questionIndex] = nativeQuestionTuple(match.native_question_id, match.source_question_index);
  const question = evidence.find((item) => item.itemId === itemId)?.questions[questionIndex];
  if (!question) throw new TerminalInteractionInputNotStartedError("Codex async question is no longer pending");
  const answer = nativeAnswerText(offer, input.response, question);
  if (answer === undefined) {
    return input.bridge.respondInteraction("codex", input.terminalControl, input.response, input.options);
  }
  const context = { agent: "codex" as const, terminalControl: input.terminalControl,
    fingerprint: offer.promptFingerprint, projection: offer.projection,
    response: input.response, runtime: input.runtime };
  let reserved = false;
  try {
    const result = await (input.deliver ?? deliverCodexPaginatedAsyncAnswer)({
      binding: input.runtime.codexPaginatedThread!, nativeTurnId: input.runtime.nativeTaskId!,
      itemId, questionIndex,
      expectedQuestion: question, answer,
      beforeDispatch: async () => {
        const authority = await input.options.authorize?.(context);
        if (!authority?.approved) throw new TerminalInteractionInputNotStartedError(authority?.reason ?? "Codex async answer authority changed");
        if (!input.options.beforeDispatch) throw new TerminalInteractionInputNotStartedError("Codex async answer requires a durable reservation");
        reserved = true;
        try { await input.options.beforeDispatch(context); }
        catch (error) {
          throw new TerminalInteractionDispatchReservedError("reservation_uncertain", "Codex async answer reservation is uncertain", { cause: error });
        }
      }
    });
    if (result.status !== "confirmed") {
      throw new TerminalInteractionDispatchReservedError("key_uncertain", "Codex async answer was submitted once but its durable acceptance is uncertain");
    }
  } catch (error) {
    if (error instanceof TerminalInteractionInputNotStartedError || error instanceof TerminalInteractionDispatchReservedError) throw error;
    if (reserved) throw new TerminalInteractionDispatchReservedError("key_uncertain", "Codex async answer delivery is uncertain", { cause: error });
    throw new TerminalInteractionInputNotStartedError("Codex async question changed before answer delivery", { cause: error });
  }
  return { responded: true, blocked: false, interactionId: offer.projection.interaction_id,
    questionId: input.response.answers[0].question_id,
    responseKind: input.response.answers[0].response_kind, outcome: "confirmed" };
}

async function recaptureAsyncOffer(input: PaginatedAsyncResponseInput): Promise<{
  offer: TerminalInteractionRuntimeOffer; evidence: readonly CodexAsyncQuestionDurableEvidence[];
}> {
  if (!isCodexPaginatedVersion(input.runtime.agentVersion) || !input.runtime.codexPaginatedThread || !input.runtime.nativeTaskId ||
      input.runtime.codexPaginatedThread.agentVersion !== input.runtime.agentVersion ||
      !isAuditedCodexPaginatedServerPair(input.runtime.agentVersion,
        input.runtime.codexPaginatedThread.serverVersion) ||
      input.response.delivery_mode !== "steer_current_turn") {
    throw new TerminalInteractionInputNotStartedError("Codex paginated answers require an exact active task and current-turn delivery");
  }
  const evidence = await (input.readQuestions ?? readCodexPaginatedAsyncQuestions)(input.runtime) ?? [];
  const status = await input.bridge.status("codex", input.terminalControl, {
    runtime: input.runtime, scrollbackLines: input.options.scrollbackLines ?? 120
  });
  const offer = status.reachable ? captureTerminalInteractionRuntimeOffer({
    agent: "codex", terminalControl: input.terminalControl, runtime: input.runtime,
    screen: status.screen.excerpt ?? "", now: input.now(),
    approvalBlocked: status.approval_state.blocked, trustedTerminalEvidence: input.terminalEvidence,
    codexAsyncQuestionEvidence: evidence
  }) : undefined;
  if (!offer || offer.projection.kind !== "async_question" ||
      offer.promptFingerprint !== input.options.expectedFingerprint ||
      offer.projection.interaction_id !== input.response.interaction_id) {
    throw new TerminalInteractionInputNotStartedError("Codex async question changed before response");
  }
  validateTerminalInteractionSubjectResponse(input.response, offer.projection, { now: input.now() });
  return { offer, evidence };
}

function nativeAnswerText(offer: TerminalInteractionRuntimeOffer, response: TerminalInteractionSubjectResponse, question: CodexAsyncQuestionDurableQuestion): string | undefined {
  const answer = response.answers[0];
  if (answer.response_kind === "free_text") return answer.text.trim();
  const native = offer.nativeInspection;
  if (answer.response_kind !== "single_select" || !("interaction_kind" in native) || native.interaction_kind !== "async_question") {
    throw new TerminalInteractionInputNotStartedError("Unsupported Codex async answer kind");
  }
  const options = native.async_inspection.match?.question.options ?? [];
  const index = options.findIndex((option) => option.option_id === answer.selected_option_ids[0]);
  const selected = options[index];
  if (!selected) throw new TerminalInteractionInputNotStartedError("Codex async answer option changed");
  if (selected.kind === "free_text_entry") return undefined;
  const raw = question.options?.[index];
  if (raw === undefined) throw new TerminalInteractionInputNotStartedError("Codex async answer has no native option text");
  return raw.trim();
}

function nativeQuestionTuple(value: string | undefined, expectedIndex: number): [string, number] {
  let tuple: unknown;
  try { tuple = JSON.parse(value ?? ""); } catch { /* Reject absent or malformed native identity. */ }
  if (!Array.isArray(tuple) || tuple.length !== 3 || tuple[0] !== "request_user_input_async" ||
      typeof tuple[1] !== "string" || !tuple[1] || tuple[2] !== expectedIndex ||
      !Number.isSafeInteger(tuple[2]) || tuple[2] < 0) {
    throw new TerminalInteractionInputNotStartedError("Codex async native question identity is unavailable");
  }
  return [tuple[1], tuple[2]];
}
