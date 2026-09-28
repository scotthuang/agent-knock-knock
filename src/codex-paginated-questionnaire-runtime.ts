import { createHash } from "node:crypto";
import {
  connectCodexAppServerInteractionClient,
  type CodexAppServerAnswerResult,
  type CodexAppServerInteractionClient,
  type CodexAppServerInteractionOptions
} from "./codex-app-server-interaction-client.js";
import {
  buildCodexAppServerQuestionnaireOffer,
  accumulateCodexAppServerQuestionnaireAnswer,
  type CodexBlockingQuestionDraft
} from "./codex-app-server-questionnaire.js";
import {
  validateCodexPaginatedTaskCheckpoint,
  type CodexPaginatedTaskCheckpoint
} from "./codex-paginated-task.js";
import type { TerminalWatch } from "./terminal-watch-record.js";
import { terminalWatchObservationFence, type TerminalWatchObservation } from "./terminal-watch-service.js";
import { createTerminalInteractionAggregate } from "./terminal-interaction-core.js";
import {
  TerminalInteractionDispatchReservedError,
  TerminalInteractionInputNotStartedError,
  type TerminalInteractionAuthorizationContext,
  type TerminalInteractionAuthorizationDecision,
  type TerminalInteractionBeforeDispatchContext,
  type TerminalInteractionResponseExecution
} from "./terminal-interaction-response-bridge.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import type { TerminalInteractionSubjectResponse } from "./terminal-interaction-protocol.js";

export type CodexPaginatedQuestionnaireClient = Pick<
  CodexAppServerInteractionClient, "listPendingQuestions" | "answer" | "close"
>;
export type CodexPaginatedQuestionnaireConnect = (
  options: CodexAppServerInteractionOptions
) => Promise<CodexPaginatedQuestionnaireClient>;

async function openQuestion(watch: TerminalWatch, checkpoint: CodexPaginatedTaskCheckpoint,
  now: Date, connect: CodexPaginatedQuestionnaireConnect) {
  const anchor = watch.anchor;
  const turnId = checkpoint.acceptance_evidence?.acceptanceId;
  if (anchor.schema !== "agent-knock-knock/codex-paginated-task-anchor" || !turnId) return undefined;
  validateCodexPaginatedTaskCheckpoint(checkpoint, anchor);
  const client = await connect({ nativeTurnId: turnId, binding: {
    codexHome: anchor.codex_home, serverVersion: anchor.codex_version,
    threadId: anchor.native_thread_id, pid: anchor.pid, processUuid: anchor.process_uuid,
    processBirth: anchor.process_birth, observedAt: anchor.captured_at
  } });
  try {
    const requests = [...client.listPendingQuestions()].filter((pending) => pending.isBlocking)
      .sort((a, b) => a.itemId.localeCompare(b.itemId));
    const draft = checkpoint.blocking_question_draft;
    const pending = requests.find((request) => request.itemId === draft?.itemId && request.requestId === draft.requestId) ?? requests[0];
    if (!pending) { await closeClient(client); return undefined; }
    if (pending.threadId !== anchor.native_thread_id || pending.turnId !== turnId) {
      throw new Error("Codex pending question belongs to another native task");
    }
    const matchingDraft = pending.itemId === draft?.itemId && pending.requestId === draft.requestId ? draft : undefined;
    const built = buildCodexAppServerQuestionnaireOffer({ pending,
      subject: { kind: "terminal_watch", watch_id: watch.watch_id, anchor_fingerprint: anchor.anchor_fingerprint },
      canonicalEndpointIdentity: watch.terminal.terminal_endpoint, draft: matchingDraft, now
    });
    if (built.status === "invalidated") throw new Error(built.reason);
    return { client, pending, built, draft: matchingDraft };
  } catch (error) { await closeClient(client); throw error; }
}

export async function observeCodexPaginatedBlockingQuestion(input: {
  watch: TerminalWatch; checkpoint: CodexPaginatedTaskCheckpoint; now: Date;
  responseDecision: (surfaceId: string, fingerprint: string) => { executable: boolean; suppress: boolean };
  connect?: CodexPaginatedQuestionnaireConnect;
}): Promise<TerminalWatchObservation | undefined> {
  let opened;
  try { opened = await openQuestion(input.watch, input.checkpoint, input.now, input.connect ?? connectCodexAppServerInteractionClient); }
  catch { return undefined; }
  if (!opened) return undefined;
  try {
    const offer = opened.built.offer;
    const decision = input.responseDecision(offer.surfaceId, offer.promptFingerprint);
    const projection = decision.executable ? offer.projection : {
      ...offer.projection, response_authority: "notify_only" as const,
      capabilities: { ...offer.projection.capabilities, respond: false }
    };
    const checkpoint = { ...input.checkpoint };
    if (!opened.draft) delete checkpoint.blocking_question_draft;
    const question = projection.questions[0];
    return {
      ...terminalWatchObservationFence(input.watch), kind: "interaction", observed_at: input.now.toISOString(),
      observation_checkpoint: checkpoint,
      evidence_fingerprint: createHash("sha256").update(JSON.stringify({
        schema: "agent-knock-knock/terminal-watch-interaction-event",
        version: 1,
        watch_id: input.watch.watch_id,
        interaction_id: projection.interaction_id,
        surface_id: offer.surfaceId
      })).digest("hex"),
      reason_code: projection.capabilities.respond ? "codex_native_question_response_requested" : "codex_native_question_requires_manual_response",
      current_interaction: { projection, aggregate: createTerminalInteractionAggregate(projection, input.now.toISOString()) },
      ...(decision.suppress ? { suppress_notification: true } : {}),
      ...(!projection.capabilities.respond ? { manual_interaction: {
        kind: "questionnaire" as const, response_kind: question.response_kind,
        required: question.required, parser_status: "manual_required" as const,
        prompt: question.prompt, current_step: projection.step.index, total_steps: projection.step.total,
        ...(question.response_kind === "single_select" ? { options: question.options.map(({ label, description }) => ({ label, description })) } : {})
      } } : {})
    };
  } finally { await closeClient(opened.client); }
}

/** Dispatches one exact native response, or privately advances a multi-question batch. */
export async function respondCodexPaginatedBlockingQuestion(input: {
  watch: TerminalWatch; checkpoint: CodexPaginatedTaskCheckpoint; terminalControl: TerminalControlRef;
  response: TerminalInteractionSubjectResponse; expectedFingerprint: string; now: () => Date;
  authorize: (context: TerminalInteractionAuthorizationContext) => TerminalInteractionAuthorizationDecision | Promise<TerminalInteractionAuthorizationDecision>;
  beforeDispatch: (context: TerminalInteractionBeforeDispatchContext) => void | Promise<void>;
  persistDraft: (draft: CodexBlockingQuestionDraft | undefined) => void;
  connect?: CodexPaginatedQuestionnaireConnect;
}): Promise<TerminalInteractionResponseExecution> {
  let opened;
  try {
    opened = await openQuestion(input.watch, input.checkpoint, input.now(), input.connect ?? connectCodexAppServerInteractionClient);
  } catch {
    throw new TerminalInteractionInputNotStartedError("The exact native Codex question is unavailable before response");
  }
  if (!opened || opened.built.status !== "ready") {
    if (opened) await closeClient(opened.client);
    throw new TerminalInteractionInputNotStartedError("The exact native Codex question is no longer executable");
  }
  try {
    const offer = opened.built.offer;
    if (offer.promptFingerprint !== input.expectedFingerprint || offer.projection.interaction_id !== input.response.interaction_id) {
      throw new TerminalInteractionInputNotStartedError("The native Codex question changed before response");
    }
    const result = accumulateCodexAppServerQuestionnaireAnswer({
      pending: opened.pending, offer, canonicalEndpointIdentity: input.watch.terminal.terminal_endpoint,
      response: input.response, draft: opened.draft, now: input.now()
    });
    if (result.status === "invalidated") throw new TerminalInteractionInputNotStartedError(result.reason);
    const context = { agent: "codex" as const, terminalControl: input.terminalControl,
      fingerprint: offer.promptFingerprint, projection: offer.projection, response: input.response };
    const authority = await input.authorize(context);
    if (!authority.approved) throw new TerminalInteractionInputNotStartedError(authority.reason ?? "Codex question response authority changed");
    await input.beforeDispatch(context);
    try {
      if (result.status === "advance") input.persistDraft(result.draft);
      else {
        const receipt = await opened.client.answer(result.requestId, result.answers);
        requireConfirmedAnswer(receipt, result.requestId, opened.pending.itemId);
        input.persistDraft(undefined);
      }
    } catch (error) {
      if (error instanceof TerminalInteractionDispatchReservedError) throw error;
      throw new TerminalInteractionDispatchReservedError("key_uncertain", "Native Codex response or private checkpoint update is uncertain");
    }
    return { responded: true, blocked: false, interactionId: offer.projection.interaction_id,
      questionId: offer.projection.questions[0].question_id,
      responseKind: input.response.answers[0].response_kind,
      outcome: result.status === "advance" ? "submitted_or_advanced" : "confirmed" };
  } finally { await closeClient(opened.client); }
}

function requireConfirmedAnswer(
  receipt: CodexAppServerAnswerResult,
  requestId: string | number,
  itemId: string
): void {
  if (receipt.status !== "confirmed" || receipt.requestId !== requestId ||
      receipt.itemId !== itemId) {
    throw new TerminalInteractionDispatchReservedError("key_uncertain", "The exact native Codex answer is not durably confirmed");
  }
}

async function closeClient(client: CodexPaginatedQuestionnaireClient): Promise<void> {
  try { await client.close(); } catch { /* Cleanup cannot change an already confirmed response. */ }
}
