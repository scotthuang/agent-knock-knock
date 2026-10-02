// Durable questionnaire and asynchronous-question attribution.
import {
  type CodexOpenRootRolloutInventory,
} from "./agent-session-provider.js";
import {
  type CodexAsyncQuestionDurableEvidence,
} from "./codex-async-question-adapter.js";
import {
  assertPrivateRegularFile,
  byteAtOffset,
  fileEndsWithNewline,
  openExactRollout,
  readCodexRolloutHeader,
  sameRolloutFileIdentity,
  sameStableFile,
} from "./codex-rollout-file.js";
import {
  validateCodexOpenRootInventoryForAcceptance,
} from "./codex-rollout-inventory.js";
import {
  assertExistingCodexRolloutHeader,
  type CodexJsonlRecordAtOffset,
  isRecord,
  optionalString,
  parseCodexJsonlRecords,
  positiveByteLimit,
} from "./codex-rollout-records.js";
import {
  type CodexRolloutAcceptanceIdentity,
  type CodexRolloutIdentity,
  exactNativeThreadId,
  fingerprint,
  normalizedRolloutIdentity,
  requiredString,
} from "./terminal-submission-facts.js";
import fs from "node:fs";
import path from "node:path";

const CODEX_QUESTIONNAIRE_TAIL_MAX_BYTES = 1024 * 1024;

const CODEX_QUESTIONNAIRE_MAX_TEXT_LENGTH = 16 * 1024;

const CODEX_QUESTIONNAIRE_MAX_OPTIONS = 8;

const CODEX_QUESTIONNAIRE_MAX_QUESTIONS = 3;

const CODEX_QUESTIONNAIRE_OTHER_LABEL = "None of the above";

const CODEX_QUESTIONNAIRE_OTHER_DESCRIPTION =
  "Optionally, add details in notes (tab).";

const CODEX_QUESTIONNAIRE_CUSTOM_LABEL = "Type something.";

const CODEX_QUESTIONNAIRE_CUSTOM_DESCRIPTION =
  "Enter a free-form answer through Codex Notes.";

const CODEX_ASYNC_QUESTION_TAIL_MAX_BYTES = 4 * 1024 * 1024;

const CODEX_ASYNC_QUESTION_MAX_ITEMS = 16;

const CODEX_ASYNC_QUESTION_MAX_QUESTIONS = 16;

const CODEX_ASYNC_QUESTION_MAX_OPTIONS = 32;

const CODEX_ASYNC_QUESTION_MAX_TEXT_LENGTH = 4_096;

export interface CodexQuestionnaireScreenEvidence {
  currentStep: number;
  totalSteps: number;
  prompt: string;
  responseKind: "single_select" | "multi_select" | "free_text" | "confirm";
  options?: ReadonlyArray<{
    label: string;
    description?: string;
  }>;
  /** Changed/unsupported frames may only use unique pending-call attribution. */
  exactShape: boolean;
}

export type CodexBoundQuestionnaireAttributionResult =
  | {
      status: "matched";
      evidenceFingerprint: string;
    }
  | {
      status: "not_matched";
      code:
        | "accepted_root_missing"
        | "accepted_call_not_unique"
        | "screen_signature_not_unique";
    }
  | {
      status: "unavailable";
      code: "invalid_inventory" | "invalid_screen" |
        "rollout_scan_unavailable";
    };

/**
 * Attributes a rendered questionnaire to one exact accepted Codex turn while
 * the process has multiple open root rollouts. No prompt or tool arguments are
 * returned: callers receive only a bounded fingerprint or a typed failure.
 */
export function detectCodexBoundQuestionnaireAttribution(options: {
  currentInventory: CodexOpenRootRolloutInventory;
  acceptedIdentity: CodexRolloutAcceptanceIdentity;
  acceptanceId: string;
  screen: CodexQuestionnaireScreenEvidence;
  maxBytesPerRollout?: number;
}): CodexBoundQuestionnaireAttributionResult {
  let inventory: CodexOpenRootRolloutInventory;
  let acceptedThreadId: string;
  let acceptedRollout: CodexRolloutIdentity;
  let acceptanceId: string;
  try {
    inventory = validateCodexOpenRootInventoryForAcceptance(
      options.currentInventory
    );
    acceptedThreadId = exactNativeThreadId(options.acceptedIdentity.sessionId);
    acceptanceId = exactNativeThreadId(options.acceptanceId);
    if (!options.acceptedIdentity.rollout) {
      throw new Error("accepted Codex rollout identity is unavailable");
    }
    acceptedRollout = normalizedRolloutIdentity(
      options.acceptedIdentity.rollout
    );
    if (
      requiredString(
        options.acceptedIdentity.processUuid,
        "accepted Codex process UUID"
      ) !== inventory.processUuid ||
      requiredString(
        options.acceptedIdentity.processBirth,
        "accepted Codex process birth"
      ) !== inventory.processBirth
    ) {
      return { status: "not_matched", code: "accepted_root_missing" };
    }
  } catch {
    return { status: "unavailable", code: "invalid_inventory" };
  }

  let normalizedScreen: ReturnType<typeof normalizedCodexQuestionnaireScreen>;
  try {
    normalizedScreen = normalizedCodexQuestionnaireScreen(options.screen);
  } catch {
    return { status: "unavailable", code: "invalid_screen" };
  }

  const acceptedRoots = inventory.roots.filter((root) =>
    root.sessionId.toLowerCase() === acceptedThreadId &&
    sameRolloutFileIdentity(root.rollout, acceptedRollout)
  );
  if (acceptedRoots.length !== 1) {
    return { status: "not_matched", code: "accepted_root_missing" };
  }

  let maxBytes: number;
  try {
    maxBytes = positiveByteLimit(
      options.maxBytesPerRollout,
      CODEX_QUESTIONNAIRE_TAIL_MAX_BYTES,
      "Codex questionnaire rollout scan limit"
    );
  } catch {
    return { status: "unavailable", code: "rollout_scan_unavailable" };
  }
  const pending: CodexPendingRequestUserInput[] = [];
  try {
    for (const root of inventory.roots) {
      pending.push(...readPendingCodexRequestUserInput({
        rollout: root.rollout,
        nativeThreadId: root.sessionId,
        maxBytes
      }));
    }
  } catch {
    return { status: "unavailable", code: "rollout_scan_unavailable" };
  }

  const acceptedCalls = pending.filter((call) =>
    call.nativeThreadId === acceptedThreadId &&
    call.turnId === acceptanceId &&
    sameRolloutFileIdentity(call.rollout, acceptedRollout)
  );
  if (acceptedCalls.length !== 1) {
    return { status: "not_matched", code: "accepted_call_not_unique" };
  }

  const matching = options.screen.exactShape &&
      normalizedScreen.responseKind !== "confirm" &&
      normalizedScreen.responseKind !== "multi_select"
    ? pending.filter((call) =>
        codexPendingQuestionnaireMatchesScreen(call, normalizedScreen)
      )
    : pending;
  if (matching.length !== 1 || matching[0] !== acceptedCalls[0]) {
    return { status: "not_matched", code: "screen_signature_not_unique" };
  }
  return {
    status: "matched",
    evidenceFingerprint: fingerprint({
      schema: "agent-knock-knock/codex-bound-questionnaire-attribution",
      version: 1,
      native_thread_id: acceptedThreadId,
      turn_id: acceptanceId,
      rollout: {
        device: acceptedRollout.device,
        inode: acceptedRollout.inode,
        path: acceptedRollout.path
      },
      screen: normalizedScreen
    })
  };
}

interface CodexDurableQuestionnaireQuestion {
  prompt: string;
  options: ReadonlyArray<{
    label: string;
    description?: string;
  }>;
}

interface CodexPendingRequestUserInput {
  nativeThreadId: string;
  rollout: CodexRolloutIdentity;
  turnId: string;
  questions: readonly CodexDurableQuestionnaireQuestion[];
}

/**
 * Read only the bounded, complete tail of one exact rollout and return async
 * questions belonging to its single currently active native turn. A missing
 * task boundary, a partial record, file drift, or an unsupported payload is a
 * hard absence rather than permission to infer from screen text alone.
 */
export function readCodexAsyncQuestionDurableEvidence(input: {
  rollout: CodexRolloutIdentity;
  nativeThreadId: string;
  maxBytes?: number;
}): readonly CodexAsyncQuestionDurableEvidence[] | undefined {
  const rollout = normalizedRolloutIdentity(input.rollout);
  const nativeThreadId = exactNativeThreadId(input.nativeThreadId);
  const maxBytes = positiveByteLimit(
    input.maxBytes,
    CODEX_ASYNC_QUESTION_TAIL_MAX_BYTES,
    "Codex async-question rollout scan limit"
  );
  const opened = openExactRollout(rollout);
  try {
    const before = opened.stat;
    assertPrivateRegularFile(before);
    const header = readCodexRolloutHeader(opened.fd, before.size);
    assertExistingCodexRolloutHeader(header, nativeThreadId);
    if (!fileEndsWithNewline(opened.fd, before.size)) {
      throw new Error("Codex async-question rollout has a partial JSONL record");
    }
    const readStart = Math.max(0, before.size - maxBytes);
    const length = before.size - readStart;
    const buffer = Buffer.allocUnsafe(length);
    if (fs.readSync(opened.fd, buffer, 0, length, readStart) !== length) {
      throw new Error("Codex async-question rollout changed while it was read");
    }
    const after = fs.fstatSync(opened.fd);
    if (!sameStableFile(before, after)) {
      throw new Error(
        "Codex async-question rollout changed while it was scanned"
      );
    }
    const atBoundary = readStart === 0 ||
      byteAtOffset(opened.fd, readStart - 1) === 0x0a;
    const firstComplete = atBoundary ? 0 : buffer.indexOf(0x0a) + 1;
    if (firstComplete <= 0 && !atBoundary) {
      throw new Error(
        "Codex async-question rollout record exceeded its bounded tail scan"
      );
    }
    const records = parseCodexJsonlRecords(
      buffer.subarray(firstComplete),
      "async-question tail"
    );
    return codexAsyncQuestionEvidenceFromRecords({
      records,
      prefixTruncated: readStart > 0
    });
  } finally {
    fs.closeSync(opened.fd);
  }
}

function codexAsyncQuestionEvidenceFromRecords(input: {
  records: readonly CodexJsonlRecordAtOffset[];
  prefixTruncated: boolean;
}): readonly CodexAsyncQuestionDurableEvidence[] | undefined {
  const active = activeCodexAsyncQuestionTask(input);
  if (!active) return undefined;
  const evidence: CodexAsyncQuestionDurableEvidence[] = [];
  let totalQuestions = 0;
  for (const { value } of input.records.slice(active.startIndex + 1)) {
    const payload = isRecord(value.payload) ? value.payload : undefined;
    if (
      value.type !== "event_msg" ||
      payload?.type !== "item_completed" ||
      exactNativeThreadId(payload.turn_id) !== active.turnId ||
      !isRecord(payload.item) ||
      payload.item.type !== "AgentMessage" ||
      payload.item.delivery !== "async"
    ) {
      continue;
    }
    if (evidence.length >= CODEX_ASYNC_QUESTION_MAX_ITEMS) {
      throw new Error("Codex async-question item count exceeds the safe limit");
    }
    const item = codexAsyncQuestionItemEvidence(payload.item, active.turnId);
    totalQuestions += item.questions.length;
    if (totalQuestions > CODEX_ASYNC_QUESTION_MAX_QUESTIONS) {
      throw new Error(
        "Codex active async-question total exceeds the safe limit"
      );
    }
    evidence.push(item);
  }
  return evidence.length === 0 ? undefined : evidence;
}

function activeCodexAsyncQuestionTask(input: {
  records: readonly CodexJsonlRecordAtOffset[];
  prefixTruncated: boolean;
}): { turnId: string; startIndex: number } | undefined {
  let activeTurnId: string | undefined;
  let activeStartIndex = -1;
  let activeClosed = false;
  input.records.forEach(({ value }, index) => {
    const payload = isRecord(value.payload) ? value.payload : undefined;
    if (!payload || value.type !== "event_msg") return;
    if (payload.type === "task_started") {
      activeTurnId = exactNativeThreadId(payload.turn_id);
      activeStartIndex = index;
      activeClosed = false;
      return;
    }
    if (
      activeTurnId &&
      (payload.type === "task_complete" || payload.type === "turn_aborted") &&
      (payload.turn_id === undefined ||
        exactNativeThreadId(payload.turn_id) === activeTurnId)
    ) {
      activeClosed = true;
    }
  });
  if (!activeTurnId || activeStartIndex < 0 || activeClosed) {
    if (input.prefixTruncated && activeStartIndex < 0) {
      throw new Error(
        "Codex async-question tail omitted the active task boundary"
      );
    }
    return undefined;
  }
  return { turnId: activeTurnId, startIndex: activeStartIndex };
}

function codexAsyncQuestionItemEvidence(
  item: Record<string, unknown>,
  turnId: string
): CodexAsyncQuestionDurableEvidence {
  const itemId = requiredString(
    item.id,
    "Codex async-question item id"
  );
  const rawQuestions = item.questions;
  if (
    !Array.isArray(rawQuestions) ||
    rawQuestions.length < 1 ||
    rawQuestions.length > CODEX_ASYNC_QUESTION_MAX_QUESTIONS
  ) {
    throw new Error("Codex async-question count is invalid");
  }
  const questions = rawQuestions.map((question) => {
    if (!isRecord(question)) {
      throw new Error("Codex async-question payload is invalid");
    }
    const title = normalizedCodexQuestionnaireText(
      question.title,
      "Codex async-question title"
    );
    if (title.length > CODEX_ASYNC_QUESTION_MAX_TEXT_LENGTH) {
      throw new Error("Codex async-question title exceeds the safe limit");
    }
    const rawOptions = question.options;
    if (
      rawOptions !== undefined && rawOptions !== null &&
      (!Array.isArray(rawOptions) ||
        rawOptions.length < 1 ||
        rawOptions.length > CODEX_ASYNC_QUESTION_MAX_OPTIONS)
    ) {
      throw new Error("Codex async-question options are invalid");
    }
    const options = rawOptions == null
      ? undefined
      : rawOptions.map((option) => {
          const label = normalizedCodexQuestionnaireText(
            option,
            "Codex async-question option"
          );
          if (label.length > CODEX_ASYNC_QUESTION_MAX_TEXT_LENGTH) {
            throw new Error(
              "Codex async-question option exceeds the safe limit"
            );
          }
          return label;
        });
    return {
      title,
      ...(options === undefined ? {} : { options })
    };
  });
  return {
    itemId,
    turnId,
    questions,
    currentIndex: 0,
    remainingCount: questions.length
  };
}

function readPendingCodexRequestUserInput(input: {
  rollout: CodexRolloutIdentity;
  nativeThreadId: string;
  maxBytes: number;
}): CodexPendingRequestUserInput[] {
  const rollout = normalizedRolloutIdentity(input.rollout);
  const nativeThreadId = exactNativeThreadId(input.nativeThreadId);
  const opened = openExactRollout(rollout);
  try {
    const before = opened.stat;
    assertPrivateRegularFile(before);
    const header = readCodexRolloutHeader(opened.fd, before.size);
    assertExistingCodexRolloutHeader(header, nativeThreadId);
    if (!fileEndsWithNewline(opened.fd, before.size)) {
      throw new Error("Codex questionnaire rollout has a partial JSONL record");
    }
    const readStart = Math.max(0, before.size - input.maxBytes);
    const length = before.size - readStart;
    const buffer = Buffer.allocUnsafe(length);
    if (
      fs.readSync(opened.fd, buffer, 0, length, readStart) !== length
    ) {
      throw new Error("Codex questionnaire rollout changed while it was read");
    }
    const after = fs.fstatSync(opened.fd);
    if (!sameStableFile(before, after)) {
      throw new Error("Codex questionnaire rollout changed while it was scanned");
    }
    const atBoundary = readStart === 0 ||
      byteAtOffset(opened.fd, readStart - 1) === 0x0a;
    const firstComplete = atBoundary ? 0 : buffer.indexOf(0x0a) + 1;
    if (firstComplete <= 0 && !atBoundary) {
      throw new Error(
        "Codex questionnaire rollout record exceeded its bounded tail scan"
      );
    }
    const records = parseCodexJsonlRecords(
      buffer.subarray(firstComplete),
      "questionnaire tail"
    );
    return pendingCodexRequestUserInputFromRecords({
      records,
      nativeThreadId,
      rollout,
      prefixTruncated: readStart > 0
    });
  } finally {
    fs.closeSync(opened.fd);
  }
}

function pendingCodexRequestUserInputFromRecords(input: {
  records: readonly CodexJsonlRecordAtOffset[];
  nativeThreadId: string;
  rollout: CodexRolloutIdentity;
  prefixTruncated: boolean;
}): CodexPendingRequestUserInput[] {
  const calls: Array<{
    index: number;
    callId: string;
    turnId: string;
    questions: readonly CodexDurableQuestionnaireQuestion[];
  }> = [];
  const outputs = new Map<string, number[]>();
  const terminalTurns = new Map<string, number[]>();
  const unscopedTerminalIndexes: number[] = [];
  const startedTurns: Array<{ index: number; turnId: string }> = [];
  let sawLifecycle = false;

  input.records.forEach(({ value }, index) => {
    const payload = isRecord(value.payload) ? value.payload : undefined;
    if (!payload) return;
    if (
      value.type === "event_msg" &&
      payload.type === "task_started"
    ) {
      startedTurns.push({
        index,
        turnId: exactNativeThreadId(payload.turn_id)
      });
      sawLifecycle = true;
      return;
    }
    if (
      value.type === "event_msg" &&
      (payload.type === "task_complete" || payload.type === "turn_aborted")
    ) {
      const rawTurnId = optionalString(payload.turn_id);
      if (!rawTurnId) {
        unscopedTerminalIndexes.push(index);
        sawLifecycle = true;
        return;
      }
      const turnId = exactNativeThreadId(rawTurnId);
      const indexes = terminalTurns.get(turnId) ?? [];
      indexes.push(index);
      terminalTurns.set(turnId, indexes);
      sawLifecycle = true;
      return;
    }
    if (
      value.type !== "response_item" ||
      payload.type !== "function_call" ||
      payload.name !== "request_user_input"
    ) {
      if (
        value.type === "response_item" &&
        payload.type === "function_call_output"
      ) {
        const callId = requiredString(
          payload.call_id,
          "Codex questionnaire output call id"
        );
        const indexes = outputs.get(callId) ?? [];
        indexes.push(index);
        outputs.set(callId, indexes);
      }
      return;
    }
    const metadata = isRecord(
      payload.internal_chat_message_metadata_passthrough
    )
      ? payload.internal_chat_message_metadata_passthrough
      : undefined;
    const callId = requiredString(
      payload.call_id,
      "Codex questionnaire call id"
    );
    if (calls.some((call) => call.callId === callId)) {
      throw new Error("Codex questionnaire call id is duplicated");
    }
    calls.push({
      index,
      callId,
      turnId: exactNativeThreadId(metadata?.turn_id),
      questions: parseCodexRequestUserInputArguments(payload.arguments)
    });
  });

  const pending = calls.filter((call) => {
    if (outputs.get(call.callId)?.some((index) => index > call.index)) {
      return false;
    }
    if (terminalTurns.get(call.turnId)?.some((index) => index > call.index)) {
      return false;
    }
    if (unscopedTerminalIndexes.some((index) => index > call.index)) {
      return false;
    }
    const precedingStart = latestCodexTaskStartBefore(
      startedTurns,
      call.index
    );
    if (precedingStart && precedingStart.turnId !== call.turnId) {
      return false;
    }
    return !startedTurns.some((started) => started.index > call.index);
  });
  if (
    input.prefixTruncated &&
    pending.length === 0 &&
    !sawLifecycle
  ) {
    throw new Error(
      "Codex questionnaire tail cannot exclude an omitted pending request"
    );
  }
  return pending.map((call) => ({
    nativeThreadId: input.nativeThreadId,
    rollout: input.rollout,
    turnId: call.turnId,
    questions: call.questions
  }));
}

function latestCodexTaskStartBefore(
  starts: ReadonlyArray<{ index: number; turnId: string }>,
  recordIndex: number
): { index: number; turnId: string } | undefined {
  let latest: { index: number; turnId: string } | undefined;
  for (const start of starts) {
    if (start.index >= recordIndex) break;
    latest = start;
  }
  return latest;
}

function parseCodexRequestUserInputArguments(
  value: unknown
): readonly CodexDurableQuestionnaireQuestion[] {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CODEX_QUESTIONNAIRE_TAIL_MAX_BYTES
  ) {
    throw new Error("Codex questionnaire arguments are invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Codex questionnaire arguments are not valid JSON");
  }
  const questions = isRecord(parsed) ? parsed.questions : undefined;
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.length > CODEX_QUESTIONNAIRE_MAX_QUESTIONS
  ) {
    throw new Error("Codex questionnaire question count is invalid");
  }
  return questions.map((question) => {
    if (!isRecord(question)) {
      throw new Error("Codex questionnaire question is invalid");
    }
    const rawOptions = question.options;
    if (
      rawOptions !== undefined &&
      (!Array.isArray(rawOptions) ||
        rawOptions.length > CODEX_QUESTIONNAIRE_MAX_OPTIONS)
    ) {
      throw new Error("Codex questionnaire option count is invalid");
    }
    return {
      prompt: normalizedCodexQuestionnaireText(
        question.question,
        "Codex questionnaire prompt"
      ),
      options: (rawOptions ?? []).map((option) => {
        if (!isRecord(option)) {
          throw new Error("Codex questionnaire option is invalid");
        }
        return {
          label: normalizedCodexQuestionnaireText(
            option.label,
            "Codex questionnaire option label"
          ),
          ...(option.description === undefined
            ? {}
            : {
                description: normalizedCodexQuestionnaireText(
                  option.description,
                  "Codex questionnaire option description"
                )
              })
        };
      })
    };
  });
}

function codexPendingQuestionnaireMatchesScreen(
  call: CodexPendingRequestUserInput,
  screen: ReturnType<typeof normalizedCodexQuestionnaireScreen>
): boolean {
  if (
    screen.currentStep < 1 ||
    screen.currentStep > screen.totalSteps ||
    call.questions.length !== screen.totalSteps
  ) {
    return false;
  }
  const question = call.questions[screen.currentStep - 1];
  if (!question) return false;
  if (question.prompt !== screen.prompt) return false;
  if (screen.responseKind === "free_text") return true;
  if (screen.responseKind !== "single_select") return false;
  return codexRenderedOptionsMatch(
    question.options,
    screen.options ?? []
  );
}

function normalizedCodexQuestionnaireScreen(
  screen: CodexQuestionnaireScreenEvidence
): {
  currentStep: number;
  totalSteps: number;
  prompt: string;
  responseKind: CodexQuestionnaireScreenEvidence["responseKind"];
  options?: ReadonlyArray<{ label: string; description?: string }>;
} {
  if (
    !Number.isSafeInteger(screen.currentStep) ||
    !Number.isSafeInteger(screen.totalSteps) ||
    screen.currentStep < 1 ||
    screen.totalSteps < 1 ||
    screen.currentStep > screen.totalSteps ||
    screen.totalSteps > CODEX_QUESTIONNAIRE_MAX_QUESTIONS ||
    !["single_select", "multi_select", "free_text", "confirm"].includes(
      screen.responseKind
    ) ||
    (screen.options?.length ?? 0) > CODEX_QUESTIONNAIRE_MAX_OPTIONS
  ) {
    throw new Error("Codex questionnaire screen evidence is invalid");
  }
  return {
    currentStep: screen.currentStep,
    totalSteps: screen.totalSteps,
    prompt: normalizedCodexQuestionnaireText(
      screen.prompt,
      "Codex questionnaire screen prompt"
    ),
    responseKind: screen.responseKind,
    ...(screen.options === undefined
      ? {}
      : {
          options: screen.options.map((option) => ({
            label: normalizedCodexQuestionnaireText(
              option.label,
              "Codex questionnaire screen option label"
            ),
            ...(option.description === undefined
              ? {}
              : {
                  description: normalizedCodexQuestionnaireText(
                    option.description,
                    "Codex questionnaire screen option description"
                  )
                })
          }))
        })
  };
}

function normalizedCodexQuestionnaireText(
  value: unknown,
  label: string
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CODEX_QUESTIONNAIRE_MAX_TEXT_LENGTH ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid`);
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error(`${label} is empty`);
  return normalized;
}

function codexRenderedOptionsMatch(
  durable: ReadonlyArray<{ label: string; description?: string }>,
  rendered: ReadonlyArray<{ label: string; description?: string }>
): boolean {
  if (sameCodexQuestionnaireOptions(durable, rendered)) return true;
  const canonicalOther = {
    label: CODEX_QUESTIONNAIRE_OTHER_LABEL,
    description: CODEX_QUESTIONNAIRE_OTHER_DESCRIPTION
  };
  if (
    sameCodexQuestionnaireOptions(
      [...durable, canonicalOther],
      rendered
    )
  ) {
    return true;
  }
  return !durable.some((option) =>
    option.label === CODEX_QUESTIONNAIRE_CUSTOM_LABEL
  ) && sameCodexQuestionnaireOptions(
    [
      ...durable,
      {
        label: CODEX_QUESTIONNAIRE_CUSTOM_LABEL,
        description: CODEX_QUESTIONNAIRE_CUSTOM_DESCRIPTION
      },
      canonicalOther
    ],
    rendered
  );
}

function sameCodexQuestionnaireOptions(
  left: ReadonlyArray<{ label: string; description?: string }>,
  right: ReadonlyArray<{ label: string; description?: string }>
): boolean {
  return left.length === right.length && left.every((option, index) =>
    option.label === right[index]?.label &&
    option.description === right[index]?.description
  );
}
