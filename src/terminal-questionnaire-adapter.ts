import { createHash } from "node:crypto";

export const NATIVE_QUESTIONNAIRE_PROFILES = Object.freeze({
  claude: "claude-code/2.1.263/ask-user-question-v1",
  codex: "codex/0.153.4/request-user-input-v1"
} as const);

export type NativeQuestionnaireAgent = "claude" | "codex";
export type NativeQuestionnaireResponseKind =
  | "single_select"
  | "multi_select"
  | "free_text"
  | "confirm";

export type NativeQuestionnaireManualReason =
  | "unsupported_version"
  | "changed_shape"
  | "ambiguous_surface"
  | "secret_input"
  | "unsupported_multi_select"
  | "unproven_custom_text_edit"
  | "unproven_final_confirmation";

export interface NativeQuestionnaireOption {
  readonly option_id: string;
  readonly label: string;
  readonly description?: string;
}

/** Internal-only normalized current question. It deliberately contains no keys. */
export interface NativeQuestionnaireQuestion {
  readonly question_id: string;
  readonly prompt: string;
  readonly response_kind: NativeQuestionnaireResponseKind;
  readonly required: boolean;
  readonly options?: readonly NativeQuestionnaireOption[];
}

export interface NativeQuestionnairePromptEvidence {
  readonly profile: string;
  readonly exact_region: string;
  readonly sha256: string;
  readonly footer?: string;
}

export type NativeQuestionnaireActionStage =
  | {
      readonly kind: "key";
      readonly key: string;
    }
  | {
      readonly kind: "answer_text";
      readonly single_line: true;
      readonly max_characters: number;
    };

export interface NativeQuestionnaireChoiceAction {
  readonly option_id: string;
  readonly outcome: "submit_or_advance" | "open_custom_text";
  readonly stages: readonly NativeQuestionnaireActionStage[];
}

/**
 * Owner-private transport plan. Callers choose semantic ids or booleans; this
 * object never crosses into a public TerminalInteractionProjection.
 */
export type NativeQuestionnaireActionPlan =
  | {
      readonly kind: "single_select";
      readonly choices: readonly NativeQuestionnaireChoiceAction[];
    }
  | {
      readonly kind: "free_text";
      readonly stages: readonly NativeQuestionnaireActionStage[];
    }
  | {
      readonly kind: "confirm";
      readonly confirm_stages: readonly NativeQuestionnaireActionStage[];
      readonly cancel_stages: readonly NativeQuestionnaireActionStage[];
    }
  | {
      readonly kind: "manual_only";
    };

interface NativeQuestionnaireInspectionBase {
  readonly agent: NativeQuestionnaireAgent;
  readonly profile: string;
  readonly current_step: number;
  readonly total_steps: number;
  readonly question: NativeQuestionnaireQuestion;
  readonly prompt_evidence: NativeQuestionnairePromptEvidence;
  readonly action_plan: NativeQuestionnaireActionPlan;
}

export type NativeQuestionnaireInspection =
  | {
      readonly status: "none";
      readonly agent: NativeQuestionnaireAgent;
      readonly reason: "no_questionnaire_surface";
    }
  | (NativeQuestionnaireInspectionBase & {
      readonly status: "actionable";
    })
  | (NativeQuestionnaireInspectionBase & {
      readonly status: "manual_required";
      readonly reason: NativeQuestionnaireManualReason;
    });

export interface InspectNativeQuestionnaireOptions {
  readonly agent: NativeQuestionnaireAgent;
  readonly version: string;
  readonly screen: string;
  /** Durable provider metadata must set this for password/secret questions. */
  readonly secret?: boolean;
}

interface ScreenLines {
  readonly lines: readonly string[];
  readonly hadUnsafeControl: boolean;
}

interface ParsedOptionRow {
  readonly number: number;
  readonly selected: boolean;
  readonly label: string;
  readonly description?: string;
}

interface ClaudeTab {
  readonly complete: boolean;
  readonly label: string;
}

interface ClaudeHeader {
  readonly tabs: readonly ClaudeTab[];
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly finalReview: boolean;
}

interface ClaudeChoiceRegion {
  readonly start: number;
  readonly end: number;
  readonly footer: string;
  readonly header: ClaudeHeader;
  readonly prompt: string;
  readonly options: readonly ParsedOptionRow[];
}

interface CodexHeader {
  readonly currentStep: number;
  readonly totalSteps: number;
}

interface CodexQuestionRegion {
  readonly start: number;
  readonly end: number;
  readonly footer: string;
  readonly header: CodexHeader;
  readonly prompt: string;
  readonly options?: readonly ParsedOptionRow[];
  readonly freeText: boolean;
}

const CLAUDE_VERSION = "2.1.263";
const CODEX_VERSION = "0.153.4";
const MAX_CAPTURE_CHARACTERS = 128 * 1024;
const MAX_CAPTURE_LINES = 240;
const MAX_TEXT_ANSWER_CHARACTERS = 4_096;
// Claude collapses bracketed-paste payloads at 800 characters. Until the
// custom-text editor has the same placeholder proof as managed Send, keep a
// semantic response strictly below that boundary.
const MAX_CLAUDE_TEXT_ANSWER_CHARACTERS = 799;
const ANSI_SEQUENCE_PATTERN =
  /[\u001B\u009B](?:(?:\[[0-?]*[ -/]*[@-~])|(?:\][^\u0007]*(?:\u0007|\u001B\\))|.)/gu;
const UNSAFE_CONTROL_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const SECRET_INPUT_PATTERN =
  /(?:password|passphrase|api[ _-]?key|secret|access[ _-]?token|credential|private[ _-]?key|密码|口令|密钥|令牌)/iu;
const CLAUDE_SELECTION_FOOTER =
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
const CLAUDE_SINGLE_SELECTION_FOOTER =
  "Enter to select · ↑/↓ to navigate · Esc to cancel";
const CLAUDE_CUSTOM_TEXT_FOOTER =
  "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel";
const CODEX_OPTIONS_FOOTER =
  "  tab to add notes | enter to submit answer | esc to interrupt";
const CODEX_MULTI_OPTIONS_FOOTER =
  "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt";
const CODEX_FREE_TEXT_FOOTER =
  "  enter to submit answer | esc to interrupt";
const CODEX_MULTI_FREE_TEXT_FOOTER =
  "  enter to submit all | ctrl + p / ctrl + n change question | esc to interrupt";
const CODEX_UNANSWERED_FOOTER =
  "  Press enter to confirm or esc to go back";

export function inspectNativeQuestionnaire(
  options: InspectNativeQuestionnaireOptions
): NativeQuestionnaireInspection {
  const screen = normalizedScreenLines(options.screen);
  return options.agent === "claude"
    ? inspectClaudeQuestionnaire(options, screen)
    : inspectCodexQuestionnaire(options, screen);
}

function normalizedScreenLines(screen: string): ScreenLines {
  const tail = screen.length > MAX_CAPTURE_CHARACTERS
    ? screen.slice(-MAX_CAPTURE_CHARACTERS)
    : screen;
  const withoutAnsi = tail
    .replace(ANSI_SEQUENCE_PATTERN, "")
    .replaceAll("\u00a0", " ")
    .replaceAll("\r", "");
  const hadUnsafeControl = UNSAFE_CONTROL_PATTERN.test(withoutAnsi);
  const allLines = withoutAnsi.split("\n").map((line) => line.trimEnd());
  while (allLines.at(-1) === "") {
    allLines.pop();
  }
  return {
    lines: allLines.slice(-MAX_CAPTURE_LINES),
    hadUnsafeControl
  };
}

function fingerprint(profile: string, region: string): string {
  return createHash("sha256")
    .update(`${profile}\0${region}`, "utf8")
    .digest("hex");
}

function promptEvidence(
  profile: string,
  lines: readonly string[],
  start: number,
  end: number,
  footer?: string
): NativeQuestionnairePromptEvidence {
  const exactRegion = lines.slice(start, end + 1).join("\n");
  return {
    profile,
    exact_region: exactRegion,
    sha256: fingerprint(profile, exactRegion),
    ...(footer === undefined ? {} : { footer })
  };
}

function semanticId(prefix: "question" | "option", ...parts: unknown[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex")
    .slice(0, 20);
  return `${prefix}_${digest}`;
}

function hasClaudeQuestionnaireCandidate(lines: readonly string[]): boolean {
  const tail = lines.at(-1) ?? "";
  return tail.includes("Enter to select ·") || tail === "  2. Cancel";
}

function hasCodexQuestionnaireCandidate(lines: readonly string[]): boolean {
  const tail = lines.at(-1) ?? "";
  return tail.includes("esc to interrupt") ||
    /^  Press enter to confirm or esc to go back$/u.test(tail);
}

function candidateBounds(
  lines: readonly string[],
  marker: (line: string) => boolean
): { start: number; end: number } {
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (marker(lines[index] ?? "")) {
      start = index;
      break;
    }
  }
  return {
    start: Math.max(0, start),
    end: Math.max(0, lines.length - 1)
  };
}

function fallbackQuestion(
  agent: NativeQuestionnaireAgent,
  lines: readonly string[],
  bounds: { start: number; end: number }
): NativeQuestionnaireQuestion {
  const prompt = lines.slice(bounds.start, bounds.end + 1)
    .find((line) => line.trim().length > 0)
    ?.trim() ?? "Unrecognized native questionnaire";
  return {
    question_id: semanticId("question", agent, prompt, bounds.start),
    prompt,
    response_kind: "confirm",
    required: true
  };
}

function manualCandidate(
  agent: NativeQuestionnaireAgent,
  profile: string,
  lines: readonly string[],
  bounds: { start: number; end: number },
  reason: NativeQuestionnaireManualReason,
  question?: NativeQuestionnaireQuestion,
  currentStep = 1,
  totalSteps = 1
): NativeQuestionnaireInspection {
  return {
    status: "manual_required",
    reason,
    agent,
    profile,
    current_step: currentStep,
    total_steps: totalSteps,
    question: question ?? fallbackQuestion(agent, lines, bounds),
    prompt_evidence: promptEvidence(
      profile,
      lines,
      bounds.start,
      bounds.end
    ),
    action_plan: { kind: "manual_only" }
  };
}

function isSecretQuestion(
  explicitSecret: boolean | undefined,
  question: NativeQuestionnaireQuestion
): boolean {
  return explicitSecret === true ||
    SECRET_INPUT_PATTERN.test(question.prompt) ||
    question.options?.some((option) =>
      SECRET_INPUT_PATTERN.test(option.label) ||
      (option.description !== undefined &&
        SECRET_INPUT_PATTERN.test(option.description))
    ) === true;
}

function inspectClaudeQuestionnaire(
  options: InspectNativeQuestionnaireOptions,
  screen: ScreenLines
): NativeQuestionnaireInspection {
  if (!hasClaudeQuestionnaireCandidate(screen.lines)) {
    return { status: "none", agent: "claude", reason: "no_questionnaire_surface" };
  }
  const bounds = candidateBounds(
    screen.lines,
    (line) => /^←  [☐☒]/u.test(line) || /^ [☐☒] \S/u.test(line)
  );
  if (options.version !== CLAUDE_VERSION) {
    return manualCandidate(
      "claude",
      `claude-code/${options.version}/unsupported-questionnaire`,
      screen.lines,
      bounds,
      "unsupported_version"
    );
  }
  if (screen.hadUnsafeControl) {
    return manualCandidate(
      "claude",
      NATIVE_QUESTIONNAIRE_PROFILES.claude,
      screen.lines,
      bounds,
      "changed_shape"
    );
  }
  const finalReview = parseClaudeFinalReview(screen.lines);
  if (finalReview) {
    return finalReview;
  }
  const customTextEdit = parseClaudeCustomTextEdit(screen.lines);
  if (customTextEdit) {
    return isSecretQuestion(options.secret, customTextEdit.question)
      ? {
          ...customTextEdit,
          status: "manual_required",
          reason: "secret_input",
          action_plan: { kind: "manual_only" }
        }
      : customTextEdit;
  }
  const choiceRegion = parseClaudeChoiceRegion(screen.lines);
  if (!choiceRegion) {
    return manualCandidate(
      "claude",
      NATIVE_QUESTIONNAIRE_PROFILES.claude,
      screen.lines,
      bounds,
      "changed_shape"
    );
  }
  return claudeChoiceInspection(choiceRegion, screen.lines, options.secret);
}

function parseClaudeHeader(line: string): ClaudeHeader | undefined {
  const single = /^ ☐ (\S.*)$/u.exec(line);
  if (single?.[1] && single[1].trim() === single[1]) {
    return {
      tabs: [{ complete: false, label: single[1] }],
      currentStep: 1,
      totalSteps: 1,
      finalReview: false
    };
  }
  const match = /^←  (.+)  ✔ Submit  →$/u.exec(line);
  if (!match?.[1]) {
    return undefined;
  }
  const inner = match[1];
  const tokenPattern = /([☐☒]) ([^☐☒]+?)(?=  [☐☒] |$)/gu;
  const tabs = [...inner.matchAll(tokenPattern)].map((token) => ({
    complete: token[1] === "☒",
    label: token[2]?.trim() ?? ""
  }));
  if (
    tabs.length < 1 ||
    tabs.some((tab) => tab.label.length === 0) ||
    tabs.map((tab) => `${tab.complete ? "☒" : "☐"} ${tab.label}`).join("  ") !== inner
  ) {
    return undefined;
  }
  const firstIncomplete = tabs.findIndex((tab) => !tab.complete);
  if (
    firstIncomplete >= 0 &&
    tabs.slice(firstIncomplete).some((tab) => tab.complete)
  ) {
    return undefined;
  }
  const totalSteps = tabs.length + 1;
  return {
    tabs,
    currentStep: firstIncomplete < 0 ? totalSteps : firstIncomplete + 1,
    totalSteps,
    finalReview: firstIncomplete < 0
  };
}

function parseClaudeOptionLines(
  lines: readonly string[],
  kind: "single_select" | "multi_select"
): ParsedOptionRow[] | undefined {
  const options: ParsedOptionRow[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    const selected = /^❯ ([1-9]\d*)\. (.+)$/u.exec(line);
    const unselected = /^  ([1-9]\d*)\. (.+)$/u.exec(line);
    const row = selected ?? unselected;
    if (row?.[1] && row[2]) {
      options.push({
        number: Number(row[1]),
        selected: Boolean(selected),
        label: row[2]
      });
      continue;
    }
    const description = kind === "multi_select"
      ? /^ {2,5}(\S.*)$/u.exec(line)?.[1]
      : /^ {5}(\S.*)$/u.exec(line)?.[1];
    const previous = options.at(-1);
    if (!description || !previous || previous.description !== undefined) {
      return undefined;
    }
    options[options.length - 1] = { ...previous, description };
  }
  if (
    options.length === 0 ||
    options.some((option, index) => option.number !== index + 1) ||
    options.filter((option) => option.selected).length !== 1
  ) {
    return undefined;
  }
  return options;
}

function lastIndexMatching(
  lines: readonly string[],
  predicate: (line: string) => boolean,
  before = lines.length
): number {
  for (let index = Math.min(before, lines.length) - 1; index >= 0; index -= 1) {
    if (predicate(lines[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

function parseClaudeChoiceRegion(
  lines: readonly string[]
): ClaudeChoiceRegion | undefined {
  const end = lines.length - 1;
  const footer = lines[end] ?? "";
  if (
    end < 0 ||
    (footer !== CLAUDE_SELECTION_FOOTER &&
      footer !== CLAUDE_SINGLE_SELECTION_FOOTER)
  ) {
    return undefined;
  }
  const footerGap = lines[end - 1] === "" ? 1 : 0;
  const chatIndex = end - 1 - footerGap;
  const chatMatch = /^  ([1-9]\d*)\. Chat about this$/u.exec(lines[chatIndex] ?? "");
  const separatorIndex = chatIndex - 1;
  if (!chatMatch?.[1] || !/^─{8,}$/u.test(lines[separatorIndex] ?? "")) {
    return undefined;
  }
  const start = lastIndexMatching(lines, (line) => parseClaudeHeader(line) !== undefined, separatorIndex);
  const parsedHeader = start >= 0
    ? parseClaudeHeader(lines[start] ?? "")
    : undefined;
  const hasHeaderGap = lines[start + 1] === "";
  const promptIndex = start + (hasHeaderGap ? 2 : 1);
  const prompt = lines[promptIndex] ?? "";
  const optionStart = promptIndex + (lines[promptIndex + 1] === "" ? 2 : 1);
  if (
    !parsedHeader ||
    prompt.length === 0 ||
    prompt !== prompt.trim() ||
    (parsedHeader.totalSteps === 1) !==
      (footer === CLAUDE_SINGLE_SELECTION_FOOTER)
  ) {
    return undefined;
  }
  const optionLines = lines.slice(optionStart, separatorIndex);
  const multiSelect = optionLines.some((line) =>
    /^(?:❯ |  )[1-9]\d*\. \[(?: |✔)\] /u.test(line)
  );
  const options = parseClaudeOptionLines(
    optionLines,
    multiSelect ? "multi_select" : "single_select"
  );
  const expectedCustomLabel = multiSelect
    ? "[ ] Type something"
    : "Type something.";
  if (
    !options ||
    Number(chatMatch[1]) !== options.length + 1 ||
    options.at(-1)?.label !== expectedCustomLabel ||
    options.length < 3 ||
    options.length > 5 ||
    options.at(-1)?.number !== options.length
  ) {
    return undefined;
  }
  const header = parsedHeader.finalReview
    ? {
        ...parsedHeader,
        currentStep: parsedHeader.tabs.length,
        finalReview: false
      }
    : parsedHeader;
  return { start, end, footer, header, prompt, options };
}

function normalizedOptions(
  profile: string,
  prompt: string,
  rows: readonly ParsedOptionRow[]
): NativeQuestionnaireOption[] {
  return rows.map((row) => ({
    option_id: semanticId("option", profile, prompt, row.number, row.label),
    label: row.label,
    ...(row.description === undefined ? {} : { description: row.description })
  }));
}

function claudeChoiceInspection(
  region: ClaudeChoiceRegion,
  lines: readonly string[],
  explicitSecret: boolean | undefined
): NativeQuestionnaireInspection {
  const multiSelect = region.options.every((option) =>
    /^\[(?: |\u2714)\] /u.test(option.label)
  );
  const mixedKinds = !multiSelect && region.options.some((option) => /^\[[^\]]*\] /u.test(option.label));
  const options = normalizedOptions(
    NATIVE_QUESTIONNAIRE_PROFILES.claude,
    region.prompt,
    region.options
  );
  const question: NativeQuestionnaireQuestion = {
    question_id: semanticId(
      "question",
      NATIVE_QUESTIONNAIRE_PROFILES.claude,
      region.prompt,
      region.header.currentStep
    ),
    prompt: region.prompt,
    response_kind: multiSelect ? "multi_select" : "single_select",
    required: true,
    options
  };
  const evidence = promptEvidence(
    NATIVE_QUESTIONNAIRE_PROFILES.claude,
    lines,
    region.start,
    region.end,
    region.footer
  );
  const base = {
    agent: "claude" as const,
    profile: NATIVE_QUESTIONNAIRE_PROFILES.claude,
    current_step: region.header.currentStep,
    total_steps: region.header.totalSteps,
    question,
    prompt_evidence: evidence
  };
  if (mixedKinds) {
    return { ...base, status: "manual_required", reason: "changed_shape", action_plan: { kind: "manual_only" } };
  }
  if (isSecretQuestion(explicitSecret, question)) {
    return { ...base, status: "manual_required", reason: "secret_input", action_plan: { kind: "manual_only" } };
  }
  if (multiSelect) {
    return { ...base, status: "manual_required", reason: "unsupported_multi_select", action_plan: { kind: "manual_only" } };
  }
  if (!region.options[0]?.selected) {
    return { ...base, status: "manual_required", reason: "ambiguous_surface", action_plan: { kind: "manual_only" } };
  }
  return {
    ...base,
    status: "actionable",
    action_plan: {
      kind: "single_select",
      choices: options.map((option, index) => ({
        option_id: option.option_id,
        outcome: index === options.length - 1
          ? "open_custom_text" as const
          : "submit_or_advance" as const,
        stages: [{ kind: "key" as const, key: String(index + 1) }]
      }))
    }
  };
}

function parseClaudeFinalReview(
  lines: readonly string[]
): NativeQuestionnaireInspection | undefined {
  const readyIndex = lastIndexMatching(
    lines,
    (line) => line === "Ready to submit your answers?"
  );
  const afterReady = lines.slice(readyIndex + 1).filter((line) => line !== "");
  if (
    readyIndex < 2 ||
    afterReady.length !== 2 ||
    afterReady[0] !== "❯ 1. Submit answers" ||
    afterReady[1] !== "  2. Cancel"
  ) {
    return undefined;
  }
  const start = lastIndexMatching(lines, (line) => parseClaudeHeader(line) !== undefined, readyIndex);
  const header = start >= 0 ? parseClaudeHeader(lines[start] ?? "") : undefined;
  const reviewLines = lines.slice(start + 1, readyIndex)
    .filter((line) => line !== "");
  if (!header?.finalReview || reviewLines[0] !== "Review your answers") {
    return undefined;
  }
  const answerRows = reviewLines.slice(1);
  if (
    answerRows.length !== header.tabs.length * 2 ||
    answerRows.some((line, index) => index % 2 === 0
      ? !/^ ● \S.+\?$/u.test(line)
      : !/^   → \S.*$/u.test(line))
  ) {
    return undefined;
  }
  const end = lines.length - 1;
  const question: NativeQuestionnaireQuestion = {
    question_id: semanticId("question", NATIVE_QUESTIONNAIRE_PROFILES.claude, "final-review", header.totalSteps),
    prompt: "Ready to submit your answers?",
    response_kind: "confirm",
    required: true
  };
  return {
    status: "actionable",
    agent: "claude",
    profile: NATIVE_QUESTIONNAIRE_PROFILES.claude,
    current_step: header.currentStep,
    total_steps: header.totalSteps,
    question,
    prompt_evidence: promptEvidence(
      NATIVE_QUESTIONNAIRE_PROFILES.claude,
      lines,
      start,
      end
    ),
    action_plan: {
      kind: "confirm",
      confirm_stages: [{ kind: "key", key: "1" }],
      cancel_stages: [{ kind: "key", key: "2" }]
    }
  };
}

function parseClaudeCustomTextEdit(
  lines: readonly string[]
): Extract<NativeQuestionnaireInspection, { status: "actionable" }> | undefined {
  const editIndex = lastIndexMatching(
    lines,
    (line) => line.includes("ctrl+g to edit in Vim")
  );
  if (
    editIndex < 0 ||
    editIndex !== lines.length - 1 ||
    lines[editIndex] !== CLAUDE_CUSTOM_TEXT_FOOTER
  ) {
    return undefined;
  }
  const start = lastIndexMatching(lines, (line) => parseClaudeHeader(line) !== undefined, editIndex);
  const header = start >= 0 ? parseClaudeHeader(lines[start] ?? "") : undefined;
  const promptIndex = start + (lines[start + 1] === "" ? 2 : 1);
  const prompt = lines[promptIndex] ?? "";
  const optionStart = promptIndex + (lines[promptIndex + 1] === "" ? 2 : 1);
  const footerGap = lines[editIndex - 1] === "" ? 1 : 0;
  const chatIndex = editIndex - 1 - footerGap;
  const chat = /^  ([1-9]\d*)\. Chat about this$/u.exec(lines[chatIndex] ?? "");
  const separatorIndex = chatIndex - 1;
  const options = parseClaudeOptionLines(
    lines.slice(optionStart, separatorIndex),
    "single_select"
  );
  if (
    !header ||
    header.finalReview ||
    prompt.length === 0 ||
    prompt !== prompt.trim() ||
    !chat?.[1] ||
    !/^\u2500{8,}$/u.test(lines[separatorIndex] ?? "") ||
    !options ||
    options.length < 3 ||
    options.length > 5 ||
    Number(chat[1]) !== options.length + 1 ||
    options.at(-1)?.number !== options.length ||
    options.at(-1)?.selected !== true ||
    options.at(-1)?.label !== "Type something."
  ) {
    return undefined;
  }
  const question: NativeQuestionnaireQuestion = {
    question_id: semanticId("question", NATIVE_QUESTIONNAIRE_PROFILES.claude, prompt, "custom-text"),
    prompt,
    response_kind: "free_text",
    required: true
  };
  return {
    status: "actionable",
    agent: "claude",
    profile: NATIVE_QUESTIONNAIRE_PROFILES.claude,
    current_step: header.currentStep,
    total_steps: header.totalSteps,
    question,
    prompt_evidence: promptEvidence(
      NATIVE_QUESTIONNAIRE_PROFILES.claude,
      lines,
      start,
      editIndex
    ),
    action_plan: {
      kind: "free_text",
      stages: [
        {
          kind: "answer_text",
          single_line: true,
          max_characters: MAX_CLAUDE_TEXT_ANSWER_CHARACTERS
        },
        { kind: "key", key: "C-m" }
      ]
    }
  };
}

function inspectCodexQuestionnaire(
  options: InspectNativeQuestionnaireOptions,
  screen: ScreenLines
): NativeQuestionnaireInspection {
  if (!hasCodexQuestionnaireCandidate(screen.lines)) {
    return { status: "none", agent: "codex", reason: "no_questionnaire_surface" };
  }
  const bounds = candidateBounds(
    screen.lines,
    (line) => /^  Question \d+\/\d+ \(/u.test(line) ||
      line === "  Submit with unanswered questions?"
  );
  if (options.version !== CODEX_VERSION) {
    return manualCandidate(
      "codex",
      `codex/${options.version}/unsupported-questionnaire`,
      screen.lines,
      bounds,
      "unsupported_version"
    );
  }
  if (screen.hadUnsafeControl) {
    return manualCandidate(
      "codex",
      NATIVE_QUESTIONNAIRE_PROFILES.codex,
      screen.lines,
      bounds,
      "changed_shape"
    );
  }
  const unanswered = parseCodexUnansweredConfirmation(screen.lines);
  if (unanswered) {
    return options.secret
      ? { ...unanswered, status: "manual_required", reason: "secret_input", action_plan: { kind: "manual_only" } }
      : unanswered;
  }
  const region = parseCodexQuestionRegion(screen.lines);
  if (!region) {
    return manualCandidate(
      "codex",
      NATIVE_QUESTIONNAIRE_PROFILES.codex,
      screen.lines,
      bounds,
      "changed_shape"
    );
  }
  return codexQuestionInspection(region, screen.lines, options.secret);
}

function parseCodexHeader(line: string): CodexHeader | undefined {
  const match = /^  Question ([1-3])\/([1-3]) \(([0-3]+) unanswered\)$/u.exec(line);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  const currentStep = Number(match[1]);
  const totalSteps = Number(match[2]);
  const unanswered = Number(match[3]);
  return currentStep <= totalSteps && unanswered <= totalSteps
    ? { currentStep, totalSteps }
    : undefined;
}

function parseCodexOptionLines(
  lines: readonly string[]
): ParsedOptionRow[] | undefined {
  const nonBlank = lines.filter((line) => line.length > 0);
  const options = nonBlank.map((line) => {
    const match = /^  (› |  )([1-4])\. (.+)$/u.exec(line);
    if (!match?.[2] || !match[3]) {
      return undefined;
    }
    const contentParts = match[3].split(/ {2,}/u);
    if (contentParts.length > 2 || !contentParts[0]) {
      return undefined;
    }
    return {
      number: Number(match[2]),
      selected: match[1] === "› ",
      label: contentParts[0],
      ...(contentParts[1] ? { description: contentParts[1] } : {})
    };
  });
  if (
    options.length < 2 ||
    options.length > 4 ||
    options.some((option) => option === undefined)
  ) {
    return undefined;
  }
  const rows = options as ParsedOptionRow[];
  if (
    rows.some((option, index) => option.number !== index + 1) ||
    rows.filter((option) => option.selected).length !== 1
  ) {
    return undefined;
  }
  return rows;
}

function parseCodexQuestionRegion(
  lines: readonly string[]
): CodexQuestionRegion | undefined {
  const end = lines.length - 1;
  const footer = lines[end] ?? "";
  const headerIndex = lastIndexMatching(lines, (line) => parseCodexHeader(line) !== undefined, end);
  const header = headerIndex >= 0 ? parseCodexHeader(lines[headerIndex] ?? "") : undefined;
  const promptLine = lines[headerIndex + 1] ?? "";
  if (!header || !/^  \S/u.test(promptLine)) {
    return undefined;
  }
  const prompt = promptLine.slice(2);
  const body = lines.slice(headerIndex + 2, end);
  const freeTextLines = body.filter((line) => line.length > 0);
  if (
    (footer === CODEX_FREE_TEXT_FOOTER ||
      (header.totalSteps > 1 && footer === CODEX_MULTI_FREE_TEXT_FOOTER)) &&
    freeTextLines.length === 1 &&
    freeTextLines[0] === "  › Type your answer (optional)"
  ) {
    return {
      start: headerIndex,
      end,
      footer,
      header,
      prompt,
      freeText: true
    };
  }
  const expectedFooter = header.totalSteps === 1
    ? CODEX_OPTIONS_FOOTER
    : CODEX_MULTI_OPTIONS_FOOTER;
  if (footer !== expectedFooter) {
    return undefined;
  }
  const options = parseCodexOptionLines(body);
  return options
    ? {
        start: headerIndex,
        end,
        footer,
        header,
        prompt,
        options,
        freeText: false
      }
    : undefined;
}

function codexQuestionInspection(
  region: CodexQuestionRegion,
  lines: readonly string[],
  explicitSecret: boolean | undefined
): NativeQuestionnaireInspection {
  const options = region.options
    ? normalizedOptions(NATIVE_QUESTIONNAIRE_PROFILES.codex, region.prompt, region.options)
    : undefined;
  const question: NativeQuestionnaireQuestion = {
    question_id: semanticId(
      "question",
      NATIVE_QUESTIONNAIRE_PROFILES.codex,
      region.prompt,
      region.header.currentStep
    ),
    prompt: region.prompt,
    response_kind: region.freeText ? "free_text" : "single_select",
    required: !region.freeText,
    ...(options === undefined ? {} : { options })
  };
  const base = {
    agent: "codex" as const,
    profile: NATIVE_QUESTIONNAIRE_PROFILES.codex,
    current_step: region.header.currentStep,
    total_steps: region.header.totalSteps,
    question,
    prompt_evidence: promptEvidence(
      NATIVE_QUESTIONNAIRE_PROFILES.codex,
      lines,
      region.start,
      region.end,
      region.footer
    )
  };
  if (isSecretQuestion(explicitSecret, question)) {
    return { ...base, status: "manual_required", reason: "secret_input", action_plan: { kind: "manual_only" } };
  }
  if (region.freeText) {
    return {
      ...base,
      status: "actionable",
      action_plan: {
        kind: "free_text",
        stages: [
          {
            kind: "answer_text",
            single_line: true,
            max_characters: MAX_TEXT_ANSWER_CHARACTERS
          },
          { kind: "key", key: "C-m" }
        ]
      }
    };
  }
  return {
    ...base,
    status: "actionable",
    action_plan: {
      kind: "single_select",
      choices: (options ?? []).map((option, index) => ({
        option_id: option.option_id,
        outcome: "submit_or_advance",
        stages: [{ kind: "key", key: String(index + 1) }]
      }))
    }
  };
}

function parseCodexUnansweredConfirmation(
  lines: readonly string[]
): Extract<
  NativeQuestionnaireInspection,
  { status: "actionable" }
> | undefined {
  const end = lines.length - 1;
  if (lines[end] !== CODEX_UNANSWERED_FOOTER) {
    return undefined;
  }
  const start = lastIndexMatching(
    lines,
    (line) => line === "  Submit with unanswered questions?",
    end
  );
  if (start < 0) {
    return undefined;
  }
  const countMatch = /^  ([1-3]) unanswered questions?$/u.exec(lines[start + 1] ?? "");
  const body = lines.slice(start + 2, end).filter((line) => line.length > 0);
  if (
    !countMatch?.[1] ||
    body.length !== 2 ||
    body[0] !== `  › 1. Proceed  Submit with ${countMatch[1]} unanswered questions.` ||
    body[1] !== "    2. Go back  Return to the first unanswered question."
  ) {
    return undefined;
  }
  const prompt = "Submit with unanswered questions?";
  return {
    status: "actionable",
    agent: "codex",
    profile: NATIVE_QUESTIONNAIRE_PROFILES.codex,
    current_step: 1,
    total_steps: 1,
    question: {
      question_id: semanticId("question", NATIVE_QUESTIONNAIRE_PROFILES.codex, prompt, countMatch[1]),
      prompt,
      response_kind: "confirm",
      required: true
    },
    prompt_evidence: promptEvidence(
      NATIVE_QUESTIONNAIRE_PROFILES.codex,
      lines,
      start,
      end,
      CODEX_UNANSWERED_FOOTER
    ),
    action_plan: {
      kind: "confirm",
      confirm_stages: [{ kind: "key", key: "C-m" }],
      cancel_stages: [{ kind: "key", key: "Escape" }]
    }
  };
}
