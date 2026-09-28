import { createHash } from "node:crypto";
import type {
  CodexAppServerInputQuestion,
  CodexAppServerPendingQuestion,
  CodexAppServerQuestionAnswers
} from "./codex-app-server-interaction-client.js";
import {
  TERMINAL_INTERACTION_LIMITS,
  TERMINAL_INTERACTION_SCHEMA,
  TERMINAL_INTERACTION_SUBJECT_VERSION,
  validateTerminalInteractionSubject,
  validateTerminalInteractionSubjectProjection,
  validateTerminalInteractionSubjectResponse,
  type TerminalInteractionQuestion,
  type TerminalInteractionSubject,
  type TerminalInteractionSubjectProjection
} from "./terminal-interaction-protocol.js";
import { isRecord } from "./value-guards.js";

/** Owner-private: store only in the protected Watch checkpoint, never callbacks. */
export interface CodexBlockingQuestionDraft {
  threadId: string;
  turnId: string;
  itemId: string;
  requestId: string | number;
  stablePayloadFingerprint: string;
  answers: CodexAppServerQuestionAnswers;
  nextQuestionIndex: number;
}

/** Only projection is public; native identifiers and draft material stay private. */
export interface CodexAppServerQuestionnaireOffer {
  projection: TerminalInteractionSubjectProjection;
  promptFingerprint: string;
  surfaceId: string;
  payloadFingerprint: string;
  questionIndex: number;
  nativeQuestionId: string;
}

export interface BuildCodexAppServerQuestionnaireOfferInput {
  pending: CodexAppServerPendingQuestion;
  subject: TerminalInteractionSubject;
  canonicalEndpointIdentity: unknown;
  draft?: CodexBlockingQuestionDraft;
  now: Date;
  ttlMs?: number;
  expiresAt?: string;
  responseUncertain?: boolean;
}

export type CodexAppServerQuestionnaireOfferResult =
  | { status: "ready"; offer: CodexAppServerQuestionnaireOffer }
  | { status: "manual_required"; offer: CodexAppServerQuestionnaireOffer; reason: string }
  | { status: "invalidated"; reason: string };

export type CodexAppServerQuestionnaireAnswerResult =
  | { status: "advance"; draft: CodexBlockingQuestionDraft }
  | { status: "ready"; requestId: string | number; answers: CodexAppServerQuestionAnswers }
  | { status: "invalidated"; reason: string };

const NONE_OF_THE_ABOVE = "None of the above";
const USER_NOTE_PREFIX = "user_note: ";
const MAX_NATIVE_IDENTIFIER = 512;
const MAX_NATIVE_TEXT = 64 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_DRAFT_BYTES = 80 * 1024;
const ANSWER_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const DISPLAY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const DRAFT_KEYS = new Set([
  "threadId", "turnId", "itemId", "requestId", "stablePayloadFingerprint",
  "answers", "nextQuestionIndex"
]);

/**
 * Build from the real native RPC payload. No terminal keys, screen coordinates,
 * or synthetic UI action plans are produced by this adapter.
 */
export function buildCodexAppServerQuestionnaireOffer(
  input: BuildCodexAppServerQuestionnaireOfferInput
): CodexAppServerQuestionnaireOfferResult {
  try {
    validatePending(input.pending);
    if (!input.pending.isBlocking) {
      return { status: "invalidated", reason: "codex_native_question_is_not_blocking" };
    }
    const subject = validateTerminalInteractionSubject(input.subject);
    const endpointFingerprint = hash("codex-native-question-endpoint", input.canonicalEndpointIdentity);
    const nativeFingerprint = hash("codex-native-question-payload", input.pending);
    const payloadFingerprint = hash("codex-native-question-owner", {
      nativeFingerprint, endpointFingerprint, subject
    });
    const draft = input.draft === undefined
      ? undefined : validateCodexBlockingQuestionDraft(input.draft);
    if (draft) validateBoundDraft(draft, input.pending, payloadFingerprint);
    const questionIndex = draft?.nextQuestionIndex ?? 0;
    const nativeQuestion = input.pending.questions[questionIndex];
    if (!nativeQuestion) throw new Error("Invalid native question index");
    const reason = manualReason(input.pending, input.responseUncertain === true);
    const question: TerminalInteractionQuestion = reason === undefined
      ? publicQuestion(nativeQuestion, nativeFingerprint, questionIndex)
      : {
          question_id: opaqueId("cq", { nativeFingerprint, questionIndex }),
          prompt: "This native Codex questionnaire needs an answer in the terminal.",
          required: true,
          response_kind: "free_text"
        };
    const promptFingerprint = hash("codex-native-question-prompt", {
      nativeFingerprint, questionIndex, question
    });
    const surfaceId = opaqueId("tis", {
      nativeFingerprint, endpointFingerprint, questionIndex, promptFingerprint
    });
    const interactionId = opaqueId("ti", { surfaceId, subject });
    const projection = validateTerminalInteractionSubjectProjection({
      schema: TERMINAL_INTERACTION_SCHEMA,
      version: TERMINAL_INTERACTION_SUBJECT_VERSION,
      interaction_id: interactionId,
      subject,
      agent: "codex",
      kind: "questionnaire",
      state: input.responseUncertain
        ? "response_uncertain" : reason === undefined ? "pending" : "manual_required",
      step: { index: questionIndex + 1, total: input.pending.questions.length },
      questions: [question],
      expires_at: offerExpiry(input),
      surface_id: surfaceId,
      prompt_fingerprint: promptFingerprint,
      response_authority: reason === undefined ? "executable" : "notify_only",
      capabilities: {
        respond: reason === undefined,
        batch_response: false,
        free_text: question.response_kind === "free_text",
        multi_select: false
      }
    });
    const offer = {
      projection, promptFingerprint, surfaceId, payloadFingerprint,
      questionIndex, nativeQuestionId: nativeQuestion.id
    };
    return reason === undefined
      ? { status: "ready", offer }
      : { status: "manual_required", offer, reason };
  } catch {
    return { status: "invalidated", reason: "codex_native_question_binding_invalid" };
  }
}

function manualReason(
  pending: CodexAppServerPendingQuestion,
  responseUncertain: boolean
): string | undefined {
  // One secret anywhere in the batch prevents collecting an incomplete set
  // of answers through AKK. The native terminal remains its sole answer path.
  if (pending.questions.some((question) => question.isSecret)) {
    return "codex_native_question_requires_private_terminal_answer";
  }
  if (pending.questions.some((question) => !projectableQuestion(question))) {
    return "codex_native_question_exceeds_public_protocol";
  }
  return responseUncertain ? "codex_native_question_response_uncertain" : undefined;
}

function offerExpiry(input: BuildCodexAppServerQuestionnaireOfferInput): string {
  const ttlMs = input.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 ||
      !Number.isFinite(input.now.getTime())) throw new Error("Invalid offer expiry");
  return input.expiresAt ?? new Date(input.now.getTime() + ttlMs).toISOString();
}

/**
 * Advance only private state until every native question has an answer. The
 * caller reserves the displayed offer, persists an advance, then consumes it.
 * Only a ready result may be passed to the native client's single RPC write.
 */
export function accumulateCodexAppServerQuestionnaireAnswer(input: {
  pending: CodexAppServerPendingQuestion;
  offer: CodexAppServerQuestionnaireOffer;
  canonicalEndpointIdentity: unknown;
  response: unknown;
  draft?: CodexBlockingQuestionDraft;
  now: Date;
}): CodexAppServerQuestionnaireAnswerResult {
  try {
    const fresh = buildCodexAppServerQuestionnaireOffer({
      pending: input.pending,
      subject: input.offer.projection.subject,
      canonicalEndpointIdentity: input.canonicalEndpointIdentity,
      ...(input.draft === undefined ? {} : { draft: input.draft }),
      now: input.now,
      expiresAt: input.offer.projection.expires_at
    });
    if (fresh.status !== "ready" || !sameOffer(input.offer, fresh.offer)) {
      return { status: "invalidated", reason: "codex_native_question_changed_before_response" };
    }
    const response = validateTerminalInteractionSubjectResponse(
      input.response, fresh.offer.projection, { now: input.now }
    );
    const nativeQuestion = input.pending.questions[fresh.offer.questionIndex];
    const answer = response.answers[0];
    let nativeAnswer: string;
    if (answer.response_kind === "free_text" &&
        (nativeQuestion.options === null || nativeQuestion.options.length === 0)) {
      // .158's native questionnaire encodes notes, including standalone
      // free-form answers, as "user_note: " plus the trimmed composer text.
      nativeAnswer = USER_NOTE_PREFIX + answer.text.trim();
    } else if (answer.response_kind === "single_select") {
      const labels = nativeOptionLabels(nativeQuestion);
      const selected = fresh.offer.projection.questions[0];
      if (selected.response_kind !== "single_select") throw new Error("Question kind changed");
      const index = selected.options.findIndex((option) =>
        option.option_id === answer.selected_option_ids[0]);
      if (index < 0 || labels[index] === undefined) throw new Error("Option changed");
      nativeAnswer = labels[index];
    } else throw new Error("Unsupported native answer");
    const previousAnswers: [string, { answers: string[] }][] =
      Object.entries(input.draft?.answers ?? {}).map(([id, value]) =>
        [id, { answers: [...value.answers] }]);
    const answers: CodexAppServerQuestionAnswers = Object.fromEntries([
      ...previousAnswers,
      [nativeQuestion.id, { answers: [nativeAnswer] }]
    ]);
    const nextQuestionIndex = fresh.offer.questionIndex + 1;
    if (nextQuestionIndex === input.pending.questions.length) {
      return { status: "ready", requestId: input.pending.requestId, answers };
    }
    return {
      status: "advance",
      draft: validateCodexBlockingQuestionDraft({
        threadId: input.pending.threadId,
        turnId: input.pending.turnId,
        itemId: input.pending.itemId,
        requestId: input.pending.requestId,
        stablePayloadFingerprint: fresh.offer.payloadFingerprint,
        answers,
        nextQuestionIndex
      })
    };
  } catch {
    return { status: "invalidated", reason: "codex_native_question_response_invalid" };
  }
}

/** Shape-only durable validation; an offer also rebinds it to the live payload. */
export function validateCodexBlockingQuestionDraft(value: unknown): CodexBlockingQuestionDraft {
  if (!isRecord(value) || Object.keys(value).some((key) => !DRAFT_KEYS.has(key)) ||
      !isRecord(value.answers) || !Number.isSafeInteger(value.nextQuestionIndex) ||
      Number(value.nextQuestionIndex) < 1 ||
      Number(value.nextQuestionIndex) >= TERMINAL_INTERACTION_LIMITS.maxSteps ||
      typeof value.stablePayloadFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.stablePayloadFingerprint)) {
    throw new Error("Codex private question draft is invalid");
  }
  for (const field of ["threadId", "turnId", "itemId"]) nativeId(value[field]);
  requestId(value.requestId);
  const entries = Object.entries(value.answers);
  if (entries.length !== value.nextQuestionIndex ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_DRAFT_BYTES) {
    throw new Error("Codex private question draft exceeded its bound");
  }
  for (const [id, answer] of entries) {
    validateDraftAnswer(id, answer);
  }
  return structuredClone(value) as unknown as CodexBlockingQuestionDraft;
}

function validateDraftAnswer(id: string, answer: unknown): void {
  nativeId(id);
  if (!isRecord(answer) || Object.keys(answer).length !== 1 ||
      !Array.isArray(answer.answers) || answer.answers.length !== 1 ||
      typeof answer.answers[0] !== "string" || answer.answers[0].trim().length === 0 ||
      answer.answers[0].length > TERMINAL_INTERACTION_LIMITS.maxTextAnswerLength + USER_NOTE_PREFIX.length ||
      ANSWER_CONTROLS.test(answer.answers[0])) {
    throw new Error("Codex private question draft has invalid answers");
  }
}

function validateBoundDraft(
  draft: CodexBlockingQuestionDraft,
  pending: CodexAppServerPendingQuestion,
  payloadFingerprint: string
): void {
  if (draft.threadId !== pending.threadId || draft.turnId !== pending.turnId ||
      draft.itemId !== pending.itemId || draft.requestId !== pending.requestId ||
      draft.stablePayloadFingerprint !== payloadFingerprint ||
      draft.nextQuestionIndex >= pending.questions.length) {
    throw new Error("Codex private question draft no longer matches its native request");
  }
  const prefix = pending.questions.slice(0, draft.nextQuestionIndex);
  if (JSON.stringify(Object.keys(draft.answers).sort()) !==
      JSON.stringify(prefix.map((question) => question.id).sort())) {
    throw new Error("Codex private question draft skipped a native question");
  }
  for (const question of prefix) {
    if (question.isSecret) throw new Error("Private native questions cannot be relayed");
    const text = draft.answers[question.id].answers[0];
    if (question.options === null || question.options.length === 0) {
      if (!text.startsWith(USER_NOTE_PREFIX) ||
          text.slice(USER_NOTE_PREFIX.length).trim().length === 0) {
        throw new Error("Native free-form answer encoding is invalid");
      }
    } else if (!nativeOptionLabels(question).includes(text)) {
      throw new Error("Native selected answer no longer matches an option");
    }
  }
}

function validatePending(value: CodexAppServerPendingQuestion): void {
  requestId(value.requestId);
  for (const id of [value.threadId, value.turnId, value.itemId]) nativeId(id);
  if (typeof value.isBlocking !== "boolean" || !Array.isArray(value.questions) ||
      value.questions.length < 1 ||
      value.questions.length > TERMINAL_INTERACTION_LIMITS.maxSteps ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PENDING_BYTES) {
    throw new Error("Native Codex question batch exceeded its bound");
  }
  const ids = new Set<string>();
  for (const question of value.questions) {
    nativeId(question.id);
    if (ids.has(question.id)) throw new Error("Native question IDs are duplicated");
    ids.add(question.id);
    validateNativeQuestion(question);
  }
}

function validateNativeQuestion(question: CodexAppServerInputQuestion): void {
  for (const text of [question.header, question.question]) {
    if (typeof text !== "string" || text.length > MAX_NATIVE_TEXT) {
      throw new Error("Native question text is invalid");
    }
  }
  if (typeof question.isOther !== "boolean" || typeof question.isSecret !== "boolean" ||
      (question.options !== null && (!Array.isArray(question.options) ||
        question.options.length > 32))) throw new Error("Native question flags are invalid");
  for (const option of question.options ?? []) {
    if (typeof option.label !== "string" || option.label.length > 512 ||
        typeof option.description !== "string" || option.description.length > MAX_NATIVE_TEXT) {
      throw new Error("Native question option is invalid");
    }
  }
}

function projectableQuestion(question: CodexAppServerInputQuestion): boolean {
  if (question.question.trim().length === 0 ||
      question.question.length > TERMINAL_INTERACTION_LIMITS.maxPromptLength ||
      DISPLAY_CONTROLS.test(question.question)) return false;
  if (question.options === null || question.options.length === 0) return true;
  const labels = nativeOptionLabels(question);
  return labels.length >= 2 && labels.length <= TERMINAL_INTERACTION_LIMITS.maxOptionsPerQuestion &&
    new Set(labels).size === labels.length &&
    labels.every((label) => label.trim().length > 0 &&
      label.length <= TERMINAL_INTERACTION_LIMITS.maxOptionLabelLength &&
      !ANSWER_CONTROLS.test(label)) &&
    question.options.every((option) =>
      option.description.length <= TERMINAL_INTERACTION_LIMITS.maxOptionDescriptionLength &&
      !DISPLAY_CONTROLS.test(option.description));
}

function publicQuestion(
  question: CodexAppServerInputQuestion,
  nativeFingerprint: string,
  questionIndex: number
): TerminalInteractionQuestion {
  const common = {
    question_id: opaqueId("cq", { nativeFingerprint, questionIndex }),
    ...(question.header.trim().length > 0 &&
        question.header.length <= TERMINAL_INTERACTION_LIMITS.maxHeaderLength &&
        !DISPLAY_CONTROLS.test(question.header) ? { header: question.header } : {}),
    prompt: question.question,
    required: true
  };
  if (question.options === null || question.options.length === 0) {
    return { ...common, response_kind: "free_text" };
  }
  return {
    ...common,
    response_kind: "single_select",
    options: nativeOptionLabels(question).map((label, index) => ({
      option_id: opaqueId("co", { nativeFingerprint, questionIndex, index }),
      label,
      ...(question.options?.[index]?.description
        ? { description: question.options[index].description } : {})
    }))
  };
}

function nativeOptionLabels(question: CodexAppServerInputQuestion): string[] {
  const labels = (question.options ?? []).map((option) => option.label);
  if (labels.length > 0 && question.isOther) labels.push(NONE_OF_THE_ABOVE);
  return labels;
}

function sameOffer(left: CodexAppServerQuestionnaireOffer, right: CodexAppServerQuestionnaireOffer): boolean {
  try {
    return left.payloadFingerprint === right.payloadFingerprint &&
      left.promptFingerprint === right.promptFingerprint &&
      left.surfaceId === right.surfaceId && left.questionIndex === right.questionIndex &&
      left.nativeQuestionId === right.nativeQuestionId &&
      canonical(left.projection) === canonical(right.projection);
  } catch { return false; }
}

function nativeId(value: unknown): void {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_NATIVE_IDENTIFIER || ANSWER_CONTROLS.test(value)) {
    throw new Error("Native question identity is invalid");
  }
}

function requestId(value: unknown): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return;
  nativeId(value);
}

function opaqueId(prefix: string, value: unknown): string {
  return prefix + "_" + hash("codex-native-question-" + prefix, value).slice(0, 40);
}

function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\n").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  function normalize(input: unknown, depth: number): unknown {
    if (depth > 10) throw new Error("Native question identity is too deeply nested");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (Array.isArray(input)) {
      if (input.length > 64) throw new Error("Native question identity array is too large");
      return input.map((entry) => normalize(entry, depth + 1));
    }
    if (!isRecord(input) || Object.keys(input).length > 64) {
      throw new Error("Native question identity is not JSON data");
    }
    return Object.fromEntries(Object.keys(input).sort()
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, normalize(input[key], depth + 1)]));
  }
  return JSON.stringify(normalize(value, 0));
}
