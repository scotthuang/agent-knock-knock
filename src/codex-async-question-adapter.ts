import { createHash } from "node:crypto";

/**
 * This adapter is deliberately version-bound. Later Codex releases gained
 * different durable answer identities; callers must not silently reuse this
 * TUI contract for an unverified release.
 */
export const CODEX_ASYNC_QUESTION_PROFILES: Readonly<Record<string, string>> =
  Object.freeze({
    "0.154.0": "codex/0.154.0/request-user-input-async-v1",
    "0.155.1": "codex/0.155.1/request-user-input-async-v1"
  });

export const CODEX_ASYNC_QUESTION_LIMITS = Object.freeze({
  maxRecords: 4_096,
  maxArgumentsBytes: 64 * 1024,
  maxQuestions: 16,
  maxOptions: 32,
  maxTitleCharacters: 4_096,
  maxOptionCharacters: 512,
  maxIdentifierCharacters: 256,
  maxScreenCharacters: 128 * 1024,
  maxScreenLines: 160
});

const ANSI_SEQUENCE_PATTERN =
  /[\u001B\u009B](?:(?:\[[0-?]*[ -/]*[@-~])|(?:\][^\u0007]*(?:\u0007|\u001B\\))|.)/gu;
const UNSAFE_CONTROL_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export type CodexAsyncQuestionSurfaceState =
  | "absent"
  | "collapsed"
  | "expanded"
  | "ambiguous";

export type CodexAsyncQuestionOpenBinding = "shift_left" | "alt_up";
export type CodexAsyncQuestionDeliveryMode =
  | "steer_current_turn"
  | "queue_next_turn";

export interface CodexAsyncQuestionDurableQuestion {
  readonly title: string;
  readonly options?: readonly string[];
}

/**
 * Owner-private durable evidence supplied by an exact rollout reader. This
 * module never opens rollout files and never returns a raw JSONL record.
 */
export interface CodexAsyncQuestionDurableEvidence {
  readonly itemId: string;
  readonly turnId: string;
  readonly questions: readonly CodexAsyncQuestionDurableQuestion[];
  /** Zero-based index within `questions`, when the caller can prove it. */
  readonly currentIndex?: number;
  /** Number still retained by the native client, when independently known. */
  readonly remainingCount?: number;
}

export interface CodexAsyncQuestionSemanticOption {
  readonly option_id: string;
  readonly label: string;
  readonly kind: "suggested" | "free_text_entry";
}

export interface CodexAsyncQuestionSemanticQuestion {
  readonly question_id: string;
  readonly prompt: string;
  readonly response_kind: "single_select" | "free_text";
  readonly required: true;
  readonly options?: readonly CodexAsyncQuestionSemanticOption[];
}

export interface CodexAsyncQuestionMatch {
  readonly source_id: string;
  readonly source_question_index: number;
  readonly question: CodexAsyncQuestionSemanticQuestion;
  readonly selected_option_id?: string;
}

export interface CodexAsyncQuestionPromptEvidence {
  readonly profile: string;
  /** Exact rendered region digest for dispatch-time recapture. */
  readonly exact_region_sha256: string;
  /** Stable semantic digest, independent of cursor and countdown redraws. */
  readonly semantic_sha256: string;
}

/**
 * Owner-private plan. It intentionally describes native intent rather than
 * exposing terminal keys or menu indexes to a public interaction projection.
 */
export type CodexAsyncQuestionOwnerPrivateActionPlan =
  | {
      readonly kind: "open_async_question_editor";
      readonly binding: CodexAsyncQuestionOpenBinding;
      readonly expected_pending_count: number;
      readonly expected_region_sha256: string;
    }
  | {
      readonly kind: "answer_async_question";
      readonly question_id: string;
      readonly choices: readonly {
        readonly option_id: string;
        readonly native_ordinal: number;
        readonly intent: "submit_choice" | "open_free_text";
      }[];
      readonly free_text: {
        readonly intent: "enter_free_text" | "select_other_then_enter_text";
        readonly native_ordinal?: number;
        readonly max_characters: number;
      };
      readonly delivery: Readonly<Record<
        CodexAsyncQuestionDeliveryMode,
        "submit" | "queue"
      >>;
      readonly expected_region_sha256: string;
    };

export type CodexAsyncQuestionInspection =
  | {
      readonly state: "absent";
      readonly reason: "no_async_question_surface";
    }
  | {
      readonly state: "ambiguous";
      readonly reason:
        | "unsupported_version"
        | "capture_limit_exceeded"
        | "unsafe_control"
        | "partial_or_unknown_surface"
        | "invalid_durable_evidence"
        | "pending_count_mismatch"
        | "question_match_missing"
        | "question_match_ambiguous"
        | "clipped_question"
        | "unsupported_keymap"
        | "existing_answer_draft";
      readonly profile?: string;
    }
  | {
      readonly state: "collapsed";
      readonly profile: string;
      readonly pending_count: number;
      readonly countdown_seconds?: number;
      /** Present only when durable order and remaining count prove it. */
      readonly match?: CodexAsyncQuestionMatch;
      readonly prompt_evidence: CodexAsyncQuestionPromptEvidence;
      readonly owner_private_action_plan:
        CodexAsyncQuestionOwnerPrivateActionPlan;
    }
  | {
      readonly state: "expanded";
      readonly profile: string;
      readonly current_step: number;
      readonly total_steps: number;
      readonly match: CodexAsyncQuestionMatch;
      readonly prompt_evidence: CodexAsyncQuestionPromptEvidence;
      readonly owner_private_action_plan:
        CodexAsyncQuestionOwnerPrivateActionPlan;
    };

export type CodexAsyncQuestionRecordCandidates =
  | {
      readonly status: "unsupported_version";
    }
  | {
      readonly status: "none";
    }
  | {
      readonly status: "ambiguous";
      readonly reason:
        | "record_limit_exceeded"
        | "invalid_arguments"
        | "invalid_identity"
        | "duplicate_item_id";
    }
  | {
      readonly status: "candidates";
      readonly evidence: readonly CodexAsyncQuestionDurableEvidence[];
    };

export function codexAsyncQuestionProfile(
  version: string
): string | undefined {
  return Object.hasOwn(CODEX_ASYNC_QUESTION_PROFILES, version)
    ? CODEX_ASYNC_QUESTION_PROFILES[version]
    : undefined;
}

/**
 * Parse already-bounded, already-read rollout records. `function_call_output`
 * with `{accepted:true}` is deliberately ignored: request_user_input_async
 * returns immediately, so that output does not mean the user answered.
 */
export function parseCodexAsyncQuestionRecordCandidates(input: {
  readonly version: string;
  readonly records: readonly unknown[];
  readonly fallbackTurnId?: string;
}): CodexAsyncQuestionRecordCandidates {
  if (!codexAsyncQuestionProfile(input.version)) {
    return { status: "unsupported_version" };
  }
  if (input.records.length > CODEX_ASYNC_QUESTION_LIMITS.maxRecords) {
    return { status: "ambiguous", reason: "record_limit_exceeded" };
  }
  const evidence: CodexAsyncQuestionDurableEvidence[] = [];
  const itemIds = new Set<string>();
  for (const value of input.records) {
    if (!isRecord(value) || value.type !== "response_item") continue;
    const payload = isRecord(value.payload) ? value.payload : undefined;
    if (
      !payload || payload.type !== "function_call" ||
      payload.name !== "request_user_input_async"
    ) {
      continue;
    }
    const itemId = boundedIdentifier(payload.call_id);
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : undefined;
    const turnId = boundedIdentifier(metadata?.turn_id) ??
      boundedIdentifier(input.fallbackTurnId);
    if (!itemId || !turnId) {
      return { status: "ambiguous", reason: "invalid_identity" };
    }
    if (itemIds.has(itemId)) {
      return { status: "ambiguous", reason: "duplicate_item_id" };
    }
    const questions = parseArguments(payload.arguments);
    if (!questions) {
      return { status: "ambiguous", reason: "invalid_arguments" };
    }
    itemIds.add(itemId);
    evidence.push({ itemId, turnId, questions });
  }
  return evidence.length === 0
    ? { status: "none" }
    : { status: "candidates", evidence };
}

export function inspectCodexAsyncQuestion(input: {
  readonly version: string;
  readonly screen: string;
  readonly evidence?: readonly CodexAsyncQuestionDurableEvidence[];
}): CodexAsyncQuestionInspection {
  const profile = codexAsyncQuestionProfile(input.version);
  if (!profile) {
    return { state: "ambiguous", reason: "unsupported_version" };
  }
  const captured = captureLines(input.screen);
  if (captured.status !== "ok") {
    return { state: "ambiguous", reason: captured.reason, profile };
  }
  const normalizedEvidence = normalizeEvidence(input.evidence ?? [], profile);
  if (!normalizedEvidence) {
    return { state: "ambiguous", reason: "invalid_durable_evidence", profile };
  }

  const collapsed = parseCollapsed(captured.lines);
  const expandedMarker = hasExpandedMarker(captured.lines);
  if (collapsed.status === "exact" && !expandedMarker) {
    return inspectCollapsedQuestion(collapsed, normalizedEvidence, profile);
  }
  if (collapsed.status === "partial" && !expandedMarker) {
    return { state: "ambiguous", reason: "partial_or_unknown_surface", profile };
  }

  const expanded = parseExpanded(captured.lines, normalizedEvidence, profile);
  if (expanded.status === "none") {
    return collapsed.status === "none"
      ? { state: "absent", reason: "no_async_question_surface" }
      : { state: "ambiguous", reason: "partial_or_unknown_surface", profile };
  }
  if (expanded.status === "ambiguous") {
    return { state: "ambiguous", reason: expanded.reason, profile };
  }
  return inspectExpandedQuestion(expanded, profile);
}

/**
 * Owner-private pre-submit proof after one text injection. The public observer
 * continues to reject drafts. Text must be wholly visible on one row: terminal
 * wrapping cannot prove the original buffer's whitespace or hidden contents.
 */
export function verifyCodexAsyncQuestionInjectedText(input: {
  readonly version: string;
  readonly screen: string;
  readonly evidence: readonly CodexAsyncQuestionDurableEvidence[];
  readonly expectedQuestionId: string;
  readonly expectedText: string;
}): boolean {
  const text = input.expectedText;
  if (!text || text !== text.trim() || /[\r\n\t]/u.test(text) ||
      UNSAFE_CONTROL_PATTERN.test(text) || [...text].length > 4_096) {
    return false;
  }
  const captured = captureLines(input.screen);
  if (captured.status !== "ok") return false;
  let matches = 0;
  for (const [index, line] of captured.lines.entries()) {
    for (const replacement of injectedTextPlaceholderRows(line, text)) {
      const restored = [...captured.lines];
      restored[index] = replacement;
      const inspection = inspectCodexAsyncQuestion({
        version: input.version,
        screen: restored.join("\n"),
        evidence: input.evidence
      });
      if (inspection.state === "expanded" &&
          inspection.match.question.response_kind === "free_text" &&
          inspection.match.question.question_id === input.expectedQuestionId) {
        matches += 1;
      }
    }
  }
  return matches === 1;
}

function injectedTextPlaceholderRows(line: string, text: string): string[] {
  if (line.trimEnd() === `  ${text}`) {
    return text === "Type your answer" ? [] : ["  Type your answer"];
  }
  const optionPrefix = /^ {2}› [1-9]\d*\. /u.exec(line)?.[0];
  if (!optionPrefix || line.slice(optionPrefix.length).trimEnd() !== text) {
    return [];
  }
  return ["Other", "Other (write an answer)"]
    .filter((placeholder) => placeholder !== text)
    .map((placeholder) => `${optionPrefix}${placeholder}`);
}

/** Withdraw-only observation; this never grants main-Composer input authority. */
export function codexAsyncQuestionMainComposerVisible(input: {
  readonly version: string;
  readonly screen: string;
}): boolean {
  const captured = captureLines(input.screen);
  if (captured.status !== "ok" ||
      inspectCodexAsyncQuestion(input).state !== "absent") {
    return false;
  }
  const footer = captured.lines.at(-1)?.trim() ?? "";
  return /^(?:gpt-[\w.-]+(?:\s+\S+)?|[-\w.]+ default)\s+·\s+\S.*$/u
    .test(footer) && captured.lines.slice(0, -1).some(
      (line) => /^[›»](?:\s|$)/u.test(line)
    );
}

function inspectCollapsedQuestion(
  collapsed: Extract<CollapsedParse, { status: "exact" }>,
  evidence: readonly NormalizedEvidence[],
  profile: string
): CodexAsyncQuestionInspection {
  const knownRemaining = evidence.length > 0 &&
    evidence.every((entry) => entry.remainingCount !== undefined)
    ? evidence.reduce((total, entry) => total + entry.remainingCount!, 0)
    : undefined;
  if (knownRemaining !== undefined && knownRemaining < collapsed.pendingCount) {
    return { state: "ambiguous", reason: "pending_count_mismatch", profile };
  }
  const match = collapsedMatch(evidence, collapsed.pendingCount, profile);
  const exactDigest = sha256(
    "codex-async-question-region",
    collapsed.exactLines.join("\n")
  );
  return {
    state: "collapsed",
    profile,
    pending_count: collapsed.pendingCount,
    ...(collapsed.countdownSeconds === undefined
      ? {}
      : { countdown_seconds: collapsed.countdownSeconds }),
    ...(match ? { match } : {}),
    prompt_evidence: {
      profile,
      exact_region_sha256: exactDigest,
      semantic_sha256: sha256("codex-async-question-semantic", {
        kind: "collapsed",
        pending_count: collapsed.pendingCount,
        match: match?.question.question_id
      })
    },
    owner_private_action_plan: {
      kind: "open_async_question_editor",
      binding: collapsed.binding,
      expected_pending_count: collapsed.pendingCount,
      expected_region_sha256: exactDigest
    }
  };
}

function inspectExpandedQuestion(
  expanded: Extract<ExpandedParse, { status: "exact" }>,
  profile: string
): CodexAsyncQuestionInspection {
  const exactDigest = sha256(
    "codex-async-question-region",
    expanded.exactLines.join("\n")
  );
  const question = expanded.match.question;
  const options = question.options ?? [];
  const selectedOption = expanded.match.selected_option_id;
  const choicePlans = options.map((option, index) => ({
    option_id: option.option_id,
    native_ordinal: index + 1,
    intent: option.kind === "free_text_entry"
      ? "open_free_text" as const
      : "submit_choice" as const
  }));
  const freeTextEntry = options.findIndex(
    (option) => option.kind === "free_text_entry"
  );
  return {
    state: "expanded",
    profile,
    current_step: expanded.currentStep,
    total_steps: expanded.totalSteps,
    match: expanded.match,
    prompt_evidence: {
      profile,
      exact_region_sha256: exactDigest,
      semantic_sha256: sha256("codex-async-question-semantic", {
        source_id: expanded.match.source_id,
        question_id: question.question_id,
        selected_option_id: selectedOption
      })
    },
    owner_private_action_plan: {
      kind: "answer_async_question",
      question_id: question.question_id,
      choices: choicePlans,
      free_text: freeTextEntry >= 0
        ? {
            intent: "select_other_then_enter_text",
            native_ordinal: freeTextEntry + 1,
            max_characters: 4_096
          }
        : {
            intent: "enter_free_text",
            max_characters: 4_096
          },
      delivery: {
        steer_current_turn: "submit",
        queue_next_turn: "queue"
      },
      expected_region_sha256: exactDigest
    }
  };
}

interface NormalizedEvidence {
  readonly itemId: string;
  readonly turnId: string;
  readonly sourceId: string;
  readonly currentIndex?: number;
  readonly remainingCount?: number;
  readonly questions: readonly NormalizedQuestion[];
}

interface NormalizedQuestion {
  readonly sourceIndex: number;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly modelOptions: readonly string[];
  readonly normalizedModelOptions: readonly string[];
  readonly semantic: CodexAsyncQuestionSemanticQuestion;
}

function normalizeEvidence(
  values: readonly CodexAsyncQuestionDurableEvidence[],
  profile: string
): readonly NormalizedEvidence[] | undefined {
  const sourceIds = new Set<string>();
  const normalized: NormalizedEvidence[] = [];
  for (const value of values) {
    const entry = normalizeEvidenceEntry(value, profile);
    if (!entry || sourceIds.has(entry.sourceId)) return undefined;
    sourceIds.add(entry.sourceId);
    normalized.push(entry);
  }
  return normalized;
}

function normalizeEvidenceEntry(
  value: CodexAsyncQuestionDurableEvidence,
  profile: string
): NormalizedEvidence | undefined {
  const itemId = boundedIdentifier(value.itemId);
  const turnId = boundedIdentifier(value.turnId);
  if (!itemId || !turnId || !validQuestionArray(value.questions)) {
    return undefined;
  }
  if (!validOptionalProgress(value.currentIndex, 0, value.questions.length - 1) ||
      !validOptionalProgress(value.remainingCount, 1, value.questions.length)) {
    return undefined;
  }
  const sourceId = `cai_${sha256("codex-async-question-source", {
    profile,
    item_id: itemId,
    turn_id: turnId
  }).slice(0, 40)}`;
  const questions: NormalizedQuestion[] = [];
  for (const [index, question] of value.questions.entries()) {
    const normalized = normalizeQuestion(question, sourceId, index);
    if (!normalized) return undefined;
    questions.push(normalized);
  }
  return {
    itemId,
    turnId,
    sourceId,
    ...(value.currentIndex === undefined
      ? {}
      : { currentIndex: value.currentIndex }),
    ...(value.remainingCount === undefined
      ? {}
      : { remainingCount: value.remainingCount }),
    questions
  };
}

function validOptionalProgress(
  value: number | undefined,
  minimum: number,
  maximum: number
): boolean {
  return value === undefined ||
    (Number.isSafeInteger(value) && value >= minimum && value <= maximum);
}

function normalizeQuestion(
  question: CodexAsyncQuestionDurableQuestion,
  sourceId: string,
  sourceIndex: number
): NormalizedQuestion | undefined {
  const title = safeSemanticText(
    question.title,
    CODEX_ASYNC_QUESTION_LIMITS.maxTitleCharacters
  );
  const modelOptions = parseOptionLabels(question.options ?? []);
  if (!title || !modelOptions) return undefined;
  const normalizedModelOptions = modelOptions.map(normalizeText);
  if (new Set(normalizedModelOptions).size !== modelOptions.length) {
    return undefined;
  }
  const questionId = `question_${sha256("codex-async-question", {
    source_id: sourceId,
    source_index: sourceIndex,
    title: normalizeText(title),
    options: normalizedModelOptions
  }).slice(0, 40)}`;
  const semanticOptions = buildSemanticOptions(questionId, modelOptions);
  return {
    sourceIndex,
    title,
    normalizedTitle: normalizeText(title),
    modelOptions,
    normalizedModelOptions,
    semantic: {
      question_id: questionId,
      prompt: title,
      response_kind: modelOptions.length > 0 ? "single_select" : "free_text",
      required: true,
      ...(semanticOptions.length > 0 ? { options: semanticOptions } : {})
    }
  };
}

function nativeOtherLabel(normalizedModelOptions: readonly string[]): string {
  return normalizedModelOptions.some(
    (label) => label.toLocaleLowerCase("en-US") === "other"
  ) ? "Other (write an answer)" : "Other";
}

function buildSemanticOptions(
  questionId: string,
  modelOptions: readonly string[]
): CodexAsyncQuestionSemanticOption[] {
  const result: CodexAsyncQuestionSemanticOption[] = modelOptions.map(
    (label, optionIndex) => ({
      option_id: `option_${sha256("codex-async-question-option", {
        question_id: questionId,
        option_index: optionIndex,
        label: normalizeText(label)
      }).slice(0, 40)}`,
      label,
      kind: "suggested"
    })
  );
  if (modelOptions.length > 0) {
    result.push({
      option_id: `option_${sha256("codex-async-question-option", {
        question_id: questionId,
        option_index: modelOptions.length,
        kind: "free_text_entry"
      }).slice(0, 40)}`,
      label: nativeOtherLabel(modelOptions.map(normalizeText)),
      kind: "free_text_entry"
    });
  }
  return result;
}

function collapsedMatch(
  evidence: readonly NormalizedEvidence[],
  pendingCount: number,
  profile: string
): CodexAsyncQuestionMatch | undefined {
  if (
    evidence.length === 0 ||
    !evidence.every((entry) =>
      entry.currentIndex !== undefined && entry.remainingCount !== undefined
    ) ||
    evidence.reduce((sum, entry) => sum + entry.remainingCount!, 0) <
      pendingCount
  ) return undefined;
  const ordered = evidence.flatMap((entry) =>
    entry.questions
      .slice(entry.currentIndex!)
      .map((question) => ({ entry, question }))
  );
  const consumedCount = ordered.length - pendingCount;
  const current = ordered[consumedCount];
  if (!current || consumedCount < 0) return undefined;
  // The profile participates through sourceId/questionId. Keeping the argument
  // explicit makes accidental cross-version reuse visible to reviewers.
  void profile;
  return {
    source_id: current.entry.sourceId,
    source_question_index: current.question.sourceIndex,
    question: current.question.semantic
  };
}

type CapturedLines =
  | { readonly status: "ok"; readonly lines: readonly string[] }
  | {
      readonly status: "error";
      readonly reason: "capture_limit_exceeded" | "unsafe_control";
    };

function captureLines(screen: string): CapturedLines {
  if (
    typeof screen !== "string" ||
    screen.length > CODEX_ASYNC_QUESTION_LIMITS.maxScreenCharacters
  ) {
    return { status: "error", reason: "capture_limit_exceeded" };
  }
  const plain = screen.replace(ANSI_SEQUENCE_PATTERN, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ");
  if (UNSAFE_CONTROL_PATTERN.test(plain)) {
    return { status: "error", reason: "unsafe_control" };
  }
  const lines = plain.split("\n")
    .slice(-CODEX_ASYNC_QUESTION_LIMITS.maxScreenLines);
  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) lines.pop();
  return { status: "ok", lines };
}

type CollapsedParse =
  | { readonly status: "none" }
  | { readonly status: "partial" }
  | {
      readonly status: "exact";
      readonly pendingCount: number;
      readonly countdownSeconds?: number;
      readonly binding: CodexAsyncQuestionOpenBinding;
      readonly exactLines: readonly string[];
    };

function parseCollapsed(lines: readonly string[]): CollapsedParse {
  let header = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] === "• Queued follow-up inputs") {
      header = index;
      break;
    }
  }
  if (header < 0) {
    return lines.some((line) =>
      /^\s*\?\s+\d+\s+questions?/iu.test(line) ||
      /\bto answer\s*$/iu.test(line)
    )
      ? { status: "partial" }
      : { status: "none" };
  }
  let summary = -1;
  let summaryMatch: RegExpExecArray | null = null;
  for (let index = header + 1; index < lines.length; index += 1) {
    const match = /^  \? ([1-9]\d{0,2}) (question|questions)(?: · ([1-9]\d{0,2})s)?$/u
      .exec(lines[index]!);
    if (match) {
      summary = index;
      summaryMatch = match;
      break;
    }
  }
  if (summary < 0 || !summaryMatch) {
    const positive = lines.slice(header + 1).some((line) =>
      /^\s*\?/u.test(line) || /\bto answer\s*$/iu.test(line)
    );
    return positive ? { status: "partial" } : { status: "none" };
  }
  const pendingCount = Number(summaryMatch[1]);
  if (
    (pendingCount === 1) !== (summaryMatch[2] === "question")
  ) return { status: "partial" };
  let hint = summary + 1;
  while (hint < lines.length && lines[hint]!.trim().length === 0) hint += 1;
  const hintLine = lines[hint] ?? "";
  const binding = hintLine === "    shift + ← to answer"
    ? "shift_left" as const
    : hintLine === "    ⌥ + ↑ to answer"
      ? "alt_up" as const
      : undefined;
  if (!binding) return { status: "partial" };
  return {
    status: "exact",
    pendingCount,
    ...(summaryMatch[3] === undefined
      ? {}
      : { countdownSeconds: Number(summaryMatch[3]) }),
    binding,
    exactLines: lines.slice(header, hint + 1)
  };
}

function hasExpandedMarker(lines: readonly string[]): boolean {
  return lines.some((line) =>
    /^ {2}enter submit\b/u.test(line) ||
    /^ {2}\d+ of(?: \d+)?/u.test(line) ||
    /^ {2}(?:ente|ctrl)…\s*$/u.test(line) ||
    /^ {2}Expand terminal to read the entire option\s*$/u.test(line)
  );
}

type ExpandedParse =
  | { readonly status: "none" }
  | {
      readonly status: "ambiguous";
      readonly reason:
        | "partial_or_unknown_surface"
        | "question_match_missing"
        | "question_match_ambiguous"
        | "clipped_question"
        | "unsupported_keymap"
        | "existing_answer_draft";
    }
  | {
      readonly status: "exact";
      readonly currentStep: number;
      readonly totalSteps: number;
      readonly match: CodexAsyncQuestionMatch;
      readonly exactLines: readonly string[];
    };

interface ExpandedCandidateMatch {
  readonly start: number;
  readonly end: number;
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly match: CodexAsyncQuestionMatch;
}

function parseExpanded(
  lines: readonly string[],
  evidence: readonly NormalizedEvidence[],
  profile: string
): ExpandedParse {
  let footerStart = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^ {2}\S.*\bsubmit\b/u.test(lines[index]!)) {
      footerStart = index;
      break;
    }
  }
  if (footerStart < 0) {
    if (lines.some((line) =>
      /^ {2}Expand terminal to read the entire option\s*$/u.test(line)
    )) return { status: "ambiguous", reason: "clipped_question" };
    return hasExpandedMarker(lines)
      ? { status: "ambiguous", reason: "partial_or_unknown_surface" }
      : { status: "none" };
  }
  const footerLines = lines.slice(footerStart).filter((line) => line.trim());
  const footer = footerLines.map((line) => normalizeText(line)).join(" ");
  if (/\boption \d+\/\d+\b/iu.test(footer) ||
      lines.slice(Math.max(0, footerStart - 5), footerStart).some((line) =>
        normalizeText(line) === "Expand terminal to read the entire option"
      )) {
    return { status: "ambiguous", reason: "clipped_question" };
  }
  if (!/^enter submit ctrl \+ \] skip ⌥ \+ ↓ (?:main prompt|prev question)(?: (?:⌥ \+ ↑|shift \+ ←) (?:next question|queued messages))?$/u
    .test(footer)) {
    return { status: "ambiguous", reason: "unsupported_keymap" };
  }
  if (evidence.length === 0) {
    return { status: "ambiguous", reason: "question_match_missing" };
  }

  const matches: ExpandedCandidateMatch[] = [];
  const content = lines.slice(0, footerStart);
  const maximumPending = evidence.reduce(
    (total, source) => total + source.questions.length,
    0
  );
  for (const source of evidence) {
    for (const question of source.questions) {
      for (let start = 0; start < content.length; start += 1) {
        if (!lineCanStartText(content[start]!)) continue;
        const consumed = consumeWrappedText(
          content,
          start,
          question.normalizedTitle
        );
        if (consumed < 0) continue;
        const parsed = parseQuestionBody(
          content,
          consumed,
          question,
          source,
          start,
          footerStart,
          maximumPending
        );
        if (parsed) matches.push(parsed);
      }
    }
  }
  const unique = uniqueExpandedMatches(matches);
  if (unique.length === 0) {
    const draftLikely = evidence.some((source) =>
      source.questions.some((question) =>
        content.some((line) => normalizeText(line) === question.normalizedTitle)
      )
    );
    return {
      status: "ambiguous",
      reason: draftLikely ? "existing_answer_draft" : "question_match_missing"
    };
  }
  if (unique.length !== 1) {
    return { status: "ambiguous", reason: "question_match_ambiguous" };
  }
  const exact = unique[0]!;
  void profile;
  return {
    status: "exact",
    currentStep: exact.currentStep,
    totalSteps: exact.totalSteps,
    match: exact.match,
    exactLines: lines.slice(exact.start, lines.length)
  };
}

function parseQuestionBody(
  lines: readonly string[],
  bodyStart: number,
  question: NormalizedQuestion,
  source: NormalizedEvidence,
  questionStart: number,
  footerStart: number,
  maximumPending: number
): ExpandedCandidateMatch | undefined {
  let cursor = bodyStart;
  while (cursor < lines.length && lines[cursor]!.trim().length === 0) cursor += 1;
  const match = parseAnswerRegion(lines.slice(cursor), question, source);
  const progress = progressForQuestion(lines, questionStart, maximumPending);
  if (!match || !progress) return undefined;
  return {
    start: progress.start,
    end: footerStart,
    currentStep: progress.current,
    totalSteps: progress.total,
    match
  };
}

function parseAnswerRegion(
  lines: readonly string[],
  question: NormalizedQuestion,
  source: NormalizedEvidence
): CodexAsyncQuestionMatch | undefined {
  const match: CodexAsyncQuestionMatch = {
    source_id: source.sourceId,
    source_question_index: question.sourceIndex,
    question: question.semantic
  };
  if (question.modelOptions.length === 0) {
    return normalizeText(lines[0] ?? "") === "Type your answer" &&
      lines.slice(1).every((line) => line.trim().length === 0)
      ? match
      : undefined;
  }
  const selectedOption = parseSelectedOption(lines, question);
  if (!selectedOption) return undefined;
  if (selectedOption.kind !== "free_text_entry") {
    return { ...match, selected_option_id: selectedOption.option_id };
  }
  return {
    ...match,
    question: {
      question_id: `question_${sha256("codex-async-question-free-text", {
        source_id: source.sourceId,
        source_index: question.sourceIndex,
        parent_question_id: question.semantic.question_id
      }).slice(0, 40)}`,
      prompt: question.semantic.prompt,
      response_kind: "free_text",
      required: true
    }
  };
}

interface ParsedOptionRow {
  readonly number: number;
  readonly selected: boolean;
  readonly label: string;
}

function parseSelectedOption(
  lines: readonly string[],
  question: NormalizedQuestion
): CodexAsyncQuestionSemanticOption | undefined {
  const rows = parseOptionRows(lines);
  const expectedLabels = [
    ...question.normalizedModelOptions,
    normalizeText(nativeOtherLabel(question.normalizedModelOptions))
  ];
  if (!rows || rows.length !== expectedLabels.length ||
      rows.some((row, index) =>
        row.number !== index + 1 || row.label !== expectedLabels[index]
      ) || rows.filter((row) => row.selected).length !== 1) {
    return undefined;
  }
  return question.semantic.options?.[rows.findIndex((row) => row.selected)];
}

function parseOptionRows(
  lines: readonly string[]
): readonly ParsedOptionRow[] | undefined {
  const rows: ParsedOptionRow[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    if (lines[cursor]!.trim().length === 0) {
      cursor += 1;
      continue;
    }
    const row = /^ {2}(›| ) (\d+)\. (\S.*)$/u.exec(lines[cursor]!);
    if (!row) return undefined;
    cursor += 1;
    let label = row[3]!;
    while (cursor < lines.length && /^ {7,}\S/u.test(lines[cursor]!)) {
      label += ` ${lines[cursor]!.trim()}`;
      cursor += 1;
    }
    rows.push({
      number: Number(row[2]),
      selected: row[1] === "›",
      label: normalizeText(label)
    });
  }
  return rows;
}

function progressForQuestion(
  lines: readonly string[],
  questionStart: number,
  maximumPending: number
): { start: number; current: number; total: number } | undefined {
  let previous = questionStart - 1;
  while (previous >= 0 && lines[previous]!.trim().length === 0) previous -= 1;
  const match = previous >= 0
    ? /^ {2}([1-9]\d*) of ([1-9]\d*)\s*$/u.exec(lines[previous]!)
    : null;
  if (!match) {
    if (previous >= 0 && /^ {2}\d+ of\b/u.test(lines[previous]!)) {
      return undefined;
    }
    return { start: questionStart, current: 1, total: 1 };
  }
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (current > total || total > maximumPending) {
    return undefined;
  }
  // Codex removes answered questions from its local pending queue. This counter
  // describes that mutable queue, not the index/count in the durable item.
  // Identity comes from the uniquely matched title and complete option region.
  return { start: previous, current, total };
}

function uniqueExpandedMatches(
  values: readonly ExpandedCandidateMatch[]
): readonly ExpandedCandidateMatch[] {
  const unique = new Map<string, ExpandedCandidateMatch>();
  for (const value of values) {
    const key = [
      value.match.source_id,
      value.match.question.question_id,
      value.start,
      value.end
    ].join(":");
    unique.set(key, value);
  }
  return [...unique.values()];
}

function consumeWrappedText(
  lines: readonly string[],
  start: number,
  expected: string
): number {
  let combined = "";
  for (let index = start; index < lines.length; index += 1) {
    const line = normalizeText(lines[index]!);
    if (!line) return -1;
    combined = combined ? `${combined} ${line}` : line;
    if (combined === expected) return index + 1;
    if (!expected.startsWith(`${combined} `)) return -1;
  }
  return -1;
}

function lineCanStartText(line: string): boolean {
  return /^ {2}\S/u.test(line) &&
    !/^ {2}(?:\d+ of \d+|[› ] \d+\.|enter submit|\?|↳)/u.test(line);
}

function parseArguments(
  value: unknown
): readonly CodexAsyncQuestionDurableQuestion[] | undefined {
  if (
    typeof value !== "string" || value.length === 0 ||
    Buffer.byteLength(value, "utf8") >
      CODEX_ASYNC_QUESTION_LIMITS.maxArgumentsBytes
  ) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "questions")) {
    return undefined;
  }
  const questions = parsed.questions;
  if (!validQuestionArray(questions)) return undefined;
  const result: CodexAsyncQuestionDurableQuestion[] = [];
  for (const value of questions) {
    const question = parseArgumentQuestion(value);
    if (!question) return undefined;
    result.push(question);
  }
  return result;
}

function validQuestionArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length > 0 &&
    value.length <= CODEX_ASYNC_QUESTION_LIMITS.maxQuestions;
}

function parseArgumentQuestion(
  value: unknown
): CodexAsyncQuestionDurableQuestion | undefined {
  if (!isRecord(value) ||
      Object.keys(value).some((key) => key !== "title" && key !== "options")) {
    return undefined;
  }
  const title = safeSemanticText(
    value.title,
    CODEX_ASYNC_QUESTION_LIMITS.maxTitleCharacters
  );
  if (!title) return undefined;
  if (value.options === undefined || value.options === null) return { title };
  const options = parseOptionLabels(value.options);
  return options && options.length > 0 ? { title, options } : undefined;
}

function parseOptionLabels(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) ||
      value.length > CODEX_ASYNC_QUESTION_LIMITS.maxOptions) {
    return undefined;
  }
  const result: string[] = [];
  for (const option of value) {
    const label = safeSemanticText(
      option,
      CODEX_ASYNC_QUESTION_LIMITS.maxOptionCharacters
    );
    if (!label) return undefined;
    result.push(label);
  }
  return result;
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= CODEX_ASYNC_QUESTION_LIMITS.maxIdentifierCharacters &&
    IDENTIFIER_PATTERN.test(trimmed)
    ? trimmed
    : undefined;
}

function safeSemanticText(
  value: unknown,
  maxCharacters: number
): string | undefined {
  if (typeof value !== "string" || UNSAFE_CONTROL_PATTERN.test(value)) {
    return undefined;
  }
  const trimmed = value.trim().normalize("NFC");
  return trimmed.length > 0 && [...trimmed].length <= maxCharacters
    ? trimmed
    : undefined;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function sha256(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${typeof value === "string" ? value : stableJson(value)}`)
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
