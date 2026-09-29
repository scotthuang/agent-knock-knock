import { createHash } from "node:crypto";
import path from "node:path";
import { isCodexPaginatedVersion, type CodexPaginatedVersion } from "./codex-lifecycle-compatibility.js";
import type {
  CodexAppServerThread,
  CodexAppServerThreadItem,
  CodexAppServerTurn
} from "./codex-app-server-read-client.js";
import type { CodexAsyncQuestionDurableEvidence } from
  "./codex-async-question-adapter.js";
import type { TerminalCompletionEvidence } from "./terminal-agent-adapter.js";
import {
  validateCodexBlockingQuestionDraft,
  type CodexBlockingQuestionDraft
} from "./codex-app-server-questionnaire.js";
import {
  exactNativeThreadId,
  fingerprint,
  requiredString,
  sha256Value,
  validTimestamp,
  validateTerminalSubmissionAcceptanceEvidence,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-facts.js";
import { isRecord } from "./value-guards.js";

export interface CodexPaginatedTaskAnchor {
  schema: "agent-knock-knock/codex-paginated-task-anchor";
  version: 1;
  origin: "user_explicit_send" | "active_task";
  captured_at: string;
  codex_home: string;
  codex_version: CodexPaginatedVersion;
  native_thread_id: string;
  process_uuid: string;
  process_birth: string;
  pid: number;
  request_hash: string;
  baseline_latest_turn_id?: string;
  turn_id?: string;
  anchor_fingerprint: string;
}

export interface CodexPaginatedTaskCheckpoint {
  schema: "agent-knock-knock/codex-paginated-task-checkpoint";
  version: 1;
  safe_resume_offset_bytes: 0;
  acceptance_evidence?: TerminalSubmissionAcceptanceEvidence;
  /** Owner-private partial answers; never copy this field into callbacks. */
  blocking_question_draft?: CodexBlockingQuestionDraft;
}

/** The reader proves contiguous descending turns through the required boundary. */
export interface CodexPaginatedTaskSnapshot {
  codexHome: string;
  serverVersion: string;
  thread: CodexAppServerThread;
  turns: readonly CodexAppServerTurn[];
  completeToBoundary: boolean;
}

interface AcceptedPaginatedTaskObservation {
  evidence: TerminalSubmissionAcceptanceEvidence;
  checkpoint: CodexPaginatedTaskCheckpoint;
  questions: readonly CodexAsyncQuestionDurableEvidence[];
}

export type CodexPaginatedTaskObservation =
  | { status: "pending"; checkpoint: CodexPaginatedTaskCheckpoint;
      questions: readonly CodexAsyncQuestionDurableEvidence[] }
  | ({ status: "accepted" } & AcceptedPaginatedTaskObservation)
  | ({ status: "completed"; completion: TerminalCompletionEvidence } &
      AcceptedPaginatedTaskObservation)
  | { status: "uncertain"; reason: string }
  | { status: "unavailable"; reason: string; retryable: true }
  | { status: "invalidated"; reason: string };

const ANCHOR_KEYS = new Set([
  "schema", "version", "origin", "captured_at", "codex_home", "codex_version",
  "native_thread_id", "process_uuid", "process_birth", "pid", "request_hash",
  "baseline_latest_turn_id", "turn_id", "anchor_fingerprint"
]);
const CHECKPOINT_KEYS = new Set([
  "schema", "version", "safe_resume_offset_bytes", "acceptance_evidence",
  "blocking_question_draft"
]);
const TURN_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted"]);
const MAX_TURNS = 128;
const MAX_ITEMS = 1_024;
const MAX_TEXT_CHARACTERS = 1024 * 1024;
const MAX_QUESTIONS = 16;
const MAX_OPTIONS = 32;

export function createCodexPaginatedTaskAnchor(
  input: Omit<CodexPaginatedTaskAnchor, "schema" | "version" | "anchor_fingerprint">
): CodexPaginatedTaskAnchor {
  const base = {
    schema: "agent-knock-knock/codex-paginated-task-anchor" as const,
    version: 1 as const,
    origin: input.origin,
    captured_at: input.captured_at,
    codex_home: input.codex_home,
    codex_version: input.codex_version,
    native_thread_id: input.native_thread_id,
    process_uuid: input.process_uuid,
    process_birth: input.process_birth,
    pid: input.pid,
    request_hash: input.request_hash,
    ...(input.baseline_latest_turn_id === undefined
      ? {} : { baseline_latest_turn_id: input.baseline_latest_turn_id }),
    ...(input.turn_id === undefined ? {} : { turn_id: input.turn_id })
  };
  return validateCodexPaginatedTaskAnchor({
    ...base,
    anchor_fingerprint: fingerprint(base)
  });
}

export function validateCodexPaginatedTaskAnchor(
  value: unknown
): CodexPaginatedTaskAnchor {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !ANCHOR_KEYS.has(key)) ||
    value.schema !== "agent-knock-knock/codex-paginated-task-anchor" ||
    value.version !== 1 ||
    !["user_explicit_send", "active_task"].includes(String(value.origin)) ||
    !isCodexPaginatedVersion(value.codex_version) ||
    !validTimestamp(value.captured_at) ||
    typeof value.codex_home !== "string" ||
    !path.isAbsolute(value.codex_home) ||
    !Number.isSafeInteger(value.pid) || Number(value.pid) <= 1
  ) throw new Error("Codex paginated task anchor is invalid");
  if (exactNativeThreadId(String(value.native_thread_id)) !== value.native_thread_id) {
    throw new Error("Codex paginated anchor has an invalid native thread");
  }
  requiredString(value.process_uuid, "Codex process UUID");
  requiredString(value.process_birth, "Codex process birth");
  if (sha256Value(value.request_hash, "Codex request hash") !== value.request_hash) {
    throw new Error("Codex paginated request hash is not canonical");
  }
  validateAnchorTaskBinding(value);
  const { anchor_fingerprint, ...base } = value;
  if (fingerprint(base) !== anchor_fingerprint) {
    throw new Error("Codex paginated anchor fingerprint does not match");
  }
  return value as unknown as CodexPaginatedTaskAnchor;
}

function validateAnchorTaskBinding(value: Record<string, unknown>): void {
  if (value.baseline_latest_turn_id !== undefined) boundedId(value.baseline_latest_turn_id);
  if (value.turn_id !== undefined) boundedId(value.turn_id);
  if (
    (value.origin === "active_task" && value.turn_id === undefined) ||
    (value.origin === "user_explicit_send" && value.turn_id !== undefined)
  ) throw new Error("Codex paginated anchor has inconsistent task binding");
}

export function createCodexPaginatedTaskCheckpoint(
  acceptanceEvidence?: TerminalSubmissionAcceptanceEvidence,
  blockingQuestionDraft?: CodexBlockingQuestionDraft
): CodexPaginatedTaskCheckpoint {
  return validateCodexPaginatedTaskCheckpoint({
    schema: "agent-knock-knock/codex-paginated-task-checkpoint",
    version: 1,
    safe_resume_offset_bytes: 0,
    ...(acceptanceEvidence === undefined ? {} : { acceptance_evidence: acceptanceEvidence }),
    ...(blockingQuestionDraft === undefined ? {} : { blocking_question_draft: blockingQuestionDraft })
  });
}

export function validateCodexPaginatedTaskCheckpoint(
  value: unknown,
  anchor?: CodexPaginatedTaskAnchor
): CodexPaginatedTaskCheckpoint {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !CHECKPOINT_KEYS.has(key)) ||
    value.schema !== "agent-knock-knock/codex-paginated-task-checkpoint" ||
    value.version !== 1 ||
    value.safe_resume_offset_bytes !== 0
  ) throw new Error("Codex paginated checkpoint is invalid");
  if (value.acceptance_evidence !== undefined) {
    if (!isRecord(value.acceptance_evidence)) throw new Error("Codex acceptance is invalid");
    const evidence = validateTerminalSubmissionAcceptanceEvidence(value.acceptance_evidence, {
      source: "codex_paginated",
      nativeThreadId: anchor?.native_thread_id ??
        requiredString(value.acceptance_evidence.nativeThreadId, "Codex acceptance thread"),
      requestHash: anchor?.request_hash ??
        requiredString(value.acceptance_evidence.requestHash, "Codex acceptance request")
    });
    boundedId(evidence.acceptanceId);
    if (
      evidence.metadata?.turn_id !== evidence.acceptanceId ||
      (anchor && evidence.anchorFingerprint !== anchor.anchor_fingerprint) ||
      (anchor?.origin === "active_task" && evidence.acceptanceId !== anchor.turn_id)
    ) throw new Error("Codex paginated acceptance belongs to a different task");
  }
  if (value.blocking_question_draft !== undefined) {
    const draft = validateCodexBlockingQuestionDraft(value.blocking_question_draft);
    if (!isRecord(value.acceptance_evidence) ||
        draft.threadId !== value.acceptance_evidence.nativeThreadId ||
        draft.turnId !== value.acceptance_evidence.acceptanceId) {
      throw new Error("Codex question draft belongs to a different accepted task");
    }
  }
  return value as unknown as CodexPaginatedTaskCheckpoint;
}

/** Inspect already-read data only; this module never opens a socket or a file. */
export function observeCodexPaginatedTask(input: {
  anchor: CodexPaginatedTaskAnchor;
  snapshot: CodexPaginatedTaskSnapshot;
  checkpoint?: CodexPaginatedTaskCheckpoint;
}): CodexPaginatedTaskObservation {
  let anchor: CodexPaginatedTaskAnchor;
  let checkpoint: CodexPaginatedTaskCheckpoint;
  try {
    anchor = validateCodexPaginatedTaskAnchor(input.anchor);
    checkpoint = validateCodexPaginatedTaskCheckpoint(
      input.checkpoint ?? createCodexPaginatedTaskCheckpoint(), anchor
    );
  } catch (error) {
    return { status: "invalidated", reason: errorText(error) };
  }
  const snapshot = input.snapshot;
  if (
    snapshot.codexHome !== anchor.codex_home ||
    snapshot.serverVersion !== anchor.codex_version ||
    snapshot.thread.id !== anchor.native_thread_id ||
    snapshot.thread.historyMode !== "paginated"
  ) return { status: "invalidated", reason: "Codex paginated history identity changed" };
  if (!snapshot.completeToBoundary) {
    return unavailable("Codex paginated history did not reach the exact task boundary");
  }
  try {
    validateTurns(snapshot.turns);
  } catch (error) {
    return unavailable(errorText(error));
  }
  const selected = selectPaginatedTaskTurn(anchor, checkpoint, snapshot.turns);
  if (selected.status !== "matched") return selected;
  const turn = selected.turn;
  const evidence = checkpoint.acceptance_evidence ?? createTaskAcceptance(anchor, turn);
  if (!checkpoint.acceptance_evidence) checkpoint = createCodexPaginatedTaskCheckpoint(evidence);
  const turnIndex = snapshot.turns.findIndex((candidate) => candidate.id === turn.id);
  return acceptedTaskObservation({
    turn, evidence, checkpoint, newerTurns: snapshot.turns.slice(0, turnIndex)
  });
}

type PaginatedTaskTurnSelection =
  | { status: "matched"; turn: CodexAppServerTurn }
  | Extract<CodexPaginatedTaskObservation, {
      status: "pending" | "uncertain" | "unavailable" | "invalidated"
    }>;

function selectPaginatedTaskTurn(
  anchor: CodexPaginatedTaskAnchor,
  checkpoint: CodexPaginatedTaskCheckpoint,
  turns: readonly CodexAppServerTurn[]
): PaginatedTaskTurnSelection {
  const evidence = checkpoint.acceptance_evidence;
  let turn: CodexAppServerTurn | undefined;
  if (evidence || anchor.origin === "active_task") {
    turn = turns.find((candidate) =>
      candidate.id === (evidence?.acceptanceId ?? anchor.turn_id));
    if (!turn) return unavailable("The accepted Codex turn is absent from its complete boundary");
    if (codexPaginatedTurnRequestHash(turn) !== anchor.request_hash) {
      return { status: "invalidated", reason: "The accepted Codex native input changed" };
    }
  } else {
    let candidates = turns;
    if (anchor.baseline_latest_turn_id !== undefined) {
      const baseline = turns.findIndex((candidate) =>
        candidate.id === anchor.baseline_latest_turn_id);
      if (baseline < 0) return unavailable("Codex pre-Send turn boundary is absent");
      candidates = turns.slice(0, baseline);
    }
    const matches = candidates.filter((candidate) =>
      codexPaginatedTurnRequestHash(candidate) === anchor.request_hash);
    if (matches.length > 1) {
      return { status: "uncertain", reason: "multiple_exact_request_acceptances" };
    }
    turn = matches[0];
    if (!turn) return { status: "pending", checkpoint, questions: [] };
  }
  return { status: "matched", turn };
}

function createTaskAcceptance(
  anchor: CodexPaginatedTaskAnchor,
  turn: CodexAppServerTurn
): TerminalSubmissionAcceptanceEvidence {
  const acceptedAt = epochTimestamp(turn.startedAt);
  const base: Omit<TerminalSubmissionAcceptanceEvidence, "evidenceFingerprint"> = {
    source: "codex_paginated",
    kind: "native_user_turn",
    nativeThreadId: anchor.native_thread_id,
    requestHash: anchor.request_hash,
    acceptanceId: turn.id,
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
    anchorFingerprint: anchor.anchor_fingerprint,
    metadata: { turn_id: turn.id }
  };
  return { ...base, evidenceFingerprint: fingerprint(base) };
}

function acceptedTaskObservation(input: {
  turn: CodexAppServerTurn;
  evidence: TerminalSubmissionAcceptanceEvidence;
  checkpoint: CodexPaginatedTaskCheckpoint;
  newerTurns: readonly CodexAppServerTurn[];
}): CodexPaginatedTaskObservation {
  const { turn, evidence, checkpoint } = input;
  let questionState: ReturnType<typeof taskQuestions>;
  try {
    questionState = taskQuestions(turn, input.newerTurns);
  } catch (error) {
    return unavailable(errorText(error));
  }
  const accepted = { evidence, checkpoint, questions: questionState.questions };
  if (turn.status === "inProgress") return { status: "accepted", ...accepted };
  // A native turn ends its pending-question queue. Historical unanswered async
  // items therefore cannot, on their own, prevent its completion callback.
  const lastAnswerTurn = questionState.answerTurns[0];
  if (
    turn.status === "completed" &&
    questionState.answerTurns.some((answerTurn) => answerTurn.status === "inProgress")
  ) return { status: "accepted", ...accepted };
  const settledTurn = turn.status === "completed" && lastAnswerTurn
    ? lastAnswerTurn : turn;
  return {
    status: "completed",
    ...accepted,
    completion: {
      source: "durable",
      outcome: settledTurn.status === "completed" ? "success" : "failure",
      text: completionText(settledTurn),
      id: turn.id,
      confidence: "high",
      timestamp: epochTimestamp(settledTurn.completedAt),
      metadata: {
        detector: "codex_exact_paginated_task",
        native_thread_id: evidence.nativeThreadId,
        turn_id: turn.id,
        status: settledTurn.status,
        ...(settledTurn === turn ? {} : { answer_turn_id: settledTurn.id })
      }
    }
  };
}

function validateTurns(turns: readonly CodexAppServerTurn[]): void {
  if (!Array.isArray(turns) || turns.length > MAX_TURNS) {
    throw new Error("Codex paginated turn snapshot exceeded its bound");
  }
  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  let newerStartedAt: number | undefined;
  for (const turn of turns) {
    boundedId(turn.id);
    if (turnIds.has(turn.id) || !TURN_STATUSES.has(turn.status)) {
      throw new Error("Codex paginated turns are duplicated or unsupported");
    }
    turnIds.add(turn.id);
    if (
      turn.itemsView !== "full" || !Array.isArray(turn.items) ||
      turn.items.length > MAX_ITEMS
    ) throw new Error("Codex paginated turn items are incomplete");
    if (typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt)) {
      if (newerStartedAt !== undefined && turn.startedAt > newerStartedAt) {
        throw new Error("Codex paginated turns are not ordered newest first");
      }
      newerStartedAt = turn.startedAt;
    }
    for (const item of turn.items) {
      boundedId(item.id);
      if (itemIds.has(item.id)) throw new Error("Codex paginated items are duplicated");
      itemIds.add(item.id);
    }
  }
}

function nativeUserText(item: CodexAppServerThreadItem): string | undefined {
  if (item.type !== "userMessage" || !Array.isArray(item.content)) return undefined;
  const input = item.content.filter((entry) =>
    entry.type !== "skill" && entry.type !== "mention");
  return input.length === 1 && input[0]?.type === "text" &&
      typeof input[0].text === "string" && input[0].text.length <= MAX_TEXT_CHARACTERS
    ? input[0].text : undefined;
}

/** Hash the native stored input; the pre-Send caller profiles input normalization. */
export function codexPaginatedTurnRequestHash(turn: CodexAppServerTurn): string | undefined {
  const root = turn.items.find((item) => item.type === "userMessage");
  const text = root && nativeUserText(root);
  return text === undefined ? undefined : createHash("sha256").update(text).digest("hex");
}

/** Native completion clears its question queue, regardless of retained history. */
export function codexPaginatedAsyncQuestionEvidence(
  turn: CodexAppServerTurn,
  newerTurns: readonly CodexAppServerTurn[] = []
): readonly CodexAsyncQuestionDurableEvidence[] {
  return turn.status === "inProgress" ? taskQuestions(turn, newerTurns).questions : [];
}

function taskQuestions(
  turn: CodexAppServerTurn,
  newerTurns: readonly CodexAppServerTurn[]
): { questions: CodexAsyncQuestionDurableEvidence[]; answerTurns: CodexAppServerTurn[] } {
  const items = turn.items.filter((item) =>
    item.type === "agentMessage" && item.delivery === "async" &&
    Array.isArray(item.questions) && item.questions.length > 0);
  let totalQuestions = 0;
  const questionsById = new Map<string, { itemId: string; index: number }>();
  for (const item of items) {
    const questions = item.questions!;
    totalQuestions += questions.length;
    if (totalQuestions > MAX_QUESTIONS) throw new Error("Codex question count exceeded its bound");
    questions.forEach((question, index) => {
      questionText(question.title, 4_096);
      if (
        question.options !== null &&
        (!Array.isArray(question.options) || question.options.length > MAX_OPTIONS)
      ) throw new Error("Codex question options are invalid");
      question.options?.forEach((option) => questionText(option, 512));
      questionsById.set(JSON.stringify(["request_user_input_async", item.id, index]), {
        itemId: item.id, index
      });
    });
  }
  const answered = new Set<string>();
  const answerTurns: CodexAppServerTurn[] = [];
  for (const candidate of [turn, ...newerTurns]) {
    let exactAnswer = false;
    for (const item of candidate.items) {
      const text = nativeUserText(item);
      if (text === undefined) continue;
      const ids = answeredQuestionIds(text);
      for (const id of ids) {
        if (questionsById.has(id)) {
          answered.add(id);
          exactAnswer = true;
        }
      }
    }
    // Only an entire native root input made of exact question answers can
    // extend task completion into a subsequent turn.
    const root = candidate.items.find((item) => item.type === "userMessage");
    const rootText = root && nativeUserText(root);
    const rootIds = rootText === undefined ? [] : answeredQuestionIds(rootText);
    if (
      candidate !== turn && exactAnswer && rootIds.length > 0 &&
      rootIds.every((id) => questionsById.has(id))
    ) answerTurns.push(candidate);
  }
  return {
    questions: items.flatMap((item) => {
      const rawQuestions = item.questions!;
      const pending = rawQuestions.map((_, index) => index).filter((index) =>
        !answered.has(JSON.stringify(["request_user_input_async", item.id, index])));
      return pending.length === 0 ? [] : [{
        itemId: item.id,
        turnId: turn.id,
        questions: rawQuestions.map((question) => ({
          title: questionText(question.title, 4_096),
          ...(question.options === null ? {} : { options: question.options })
        })),
        currentIndex: pending[0]!,
        remainingCount: pending.length
      }];
    }),
    answerTurns
  };
}

function answeredQuestionIds(input: string): string[] {
  let text = input.trim();
  const idePrefix = "# Context from my IDE setup:\n";
  const ideRequest = "\n## My request for Codex:\n";
  if (text.startsWith(idePrefix)) {
    const requestIndex = text.lastIndexOf(ideRequest);
    if (requestIndex >= 0) text = text.slice(requestIndex + ideRequest.length).trim();
  }
  const match = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/u.exec(text);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[1]!); } catch { return []; }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length === 0 || values.length > MAX_QUESTIONS) return [];
  const ids: string[] = [];
  for (const value of values) {
    const id = answeredQuestionId(value);
    if (id === undefined) return [];
    ids.push(id);
  }
  return ids;
}

function answeredQuestionId(value: unknown): string | undefined {
  if (
    !isRecord(value) || typeof value.answer !== "string" ||
    typeof value.question !== "string" || typeof value.questionItemId !== "string"
  ) return undefined;
  let id: unknown;
  try { id = JSON.parse(value.questionItemId); } catch { return undefined; }
  if (
    !Array.isArray(id) || id.length !== 3 ||
    id[0] !== "request_user_input_async" ||
    typeof id[1] !== "string" ||
    !Number.isSafeInteger(id[2]) || Number(id[2]) < 0
  ) return undefined;
  return JSON.stringify(id);
}

function completionText(turn: CodexAppServerTurn): string {
  const messages = turn.items.filter((item) =>
    (item.type === "agentMessage" || item.type === "plan") && item.delivery !== "async" &&
    item.questions == null && typeof item.text === "string");
  // Native Plan-mode output is a plan item instead of an agentMessage.
  const final = [...messages].reverse().find((item) =>
    item.type === "plan" || item.phase === "final_answer") ??
    [...messages].reverse().find((item) => item.phase == null);
  const text = final?.text ?? (turn.status === "completed"
    ? "" : turn.error?.message ?? "Codex native turn " + turn.status);
  return text.slice(-4_000);
}

function questionText(value: unknown, maxCharacters: number): string {
  if (
    typeof value !== "string" || value.length > maxCharacters ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)
  ) throw new Error("Codex question text is invalid");
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) throw new Error("Codex question text is empty");
  return text;
}

function boundedId(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) throw new Error("Codex native item or turn id is invalid");
  return value;
}

function epochTimestamp(value: number | null): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  const milliseconds = value * 1000;
  return Math.abs(milliseconds) <= 8.64e15 ? new Date(milliseconds).toISOString() : undefined;
}

function unavailable(reason: string): Extract<CodexPaginatedTaskObservation, { status: "unavailable" }> {
  return { status: "unavailable", reason, retryable: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
