import { isRecord, type UnknownRecord } from "./value-guards.js";

export const TERMINAL_INTERACTION_SCHEMA =
  "agent-knock-knock/terminal-interaction" as const;
export const TERMINAL_INTERACTION_VERSION = 1 as const;
/**
 * Version 2 makes the interaction owner explicit. Version 1 remains readable
 * for durable managed-Turn records written by releases before Watch response
 * authority existed.
 */
export const TERMINAL_INTERACTION_SUBJECT_VERSION = 2 as const;

export const TERMINAL_INTERACTION_KINDS = ["questionnaire"] as const;
export const TERMINAL_INTERACTION_STATES = [
  "pending",
  "manual_required",
  "response_uncertain"
] as const;
export const TERMINAL_INTERACTION_RESPONSE_KINDS = [
  "single_select",
  "multi_select",
  "free_text",
  "confirm"
] as const;
export const TERMINAL_INTERACTION_AGENTS = ["codex", "claude"] as const;
export const TERMINAL_INTERACTION_SUBJECT_KINDS = [
  "managed_turn",
  "terminal_watch"
] as const;
export const TERMINAL_INTERACTION_RESPONSE_AUTHORITIES = [
  "executable",
  "notify_only"
] as const;

export const TERMINAL_INTERACTION_LIMITS = Object.freeze({
  maxProjectionBytes: 32 * 1024,
  /** A projection is deliberately one native step, never a batch of keys. */
  maxQuestions: 1,
  /** Claude may render four declared options plus its automatic Other row. */
  maxOptionsPerQuestion: 5,
  maxSteps: 16,
  maxIdentifierLength: 128,
  maxPromptLength: 4_096,
  maxHeaderLength: 12,
  maxOptionLabelLength: 64,
  maxOptionDescriptionLength: 1_024,
  maxPlaceholderLength: 256,
  maxTextAnswerLength: 4_096,
  maxExpiresAtLength: 64
});

export type TerminalInteractionKind =
  typeof TERMINAL_INTERACTION_KINDS[number];
export type TerminalInteractionState =
  typeof TERMINAL_INTERACTION_STATES[number];
export type TerminalInteractionResponseKind =
  typeof TERMINAL_INTERACTION_RESPONSE_KINDS[number];
export type TerminalInteractionAgent =
  typeof TERMINAL_INTERACTION_AGENTS[number];
export type TerminalInteractionSubjectKind =
  typeof TERMINAL_INTERACTION_SUBJECT_KINDS[number];
export type TerminalInteractionResponseAuthority =
  typeof TERMINAL_INTERACTION_RESPONSE_AUTHORITIES[number];

export interface TerminalInteractionManagedTurnSubject {
  readonly kind: "managed_turn";
  readonly turn_id: string;
  /** The exact controller message that established managed ownership. */
  readonly message_id: string;
}

export interface TerminalInteractionTerminalWatchSubject {
  readonly kind: "terminal_watch";
  readonly watch_id: string;
  /** Hash of the exact task/acceptance anchor; never raw terminal content. */
  readonly anchor_fingerprint: string;
}

export type TerminalInteractionSubject =
  | TerminalInteractionManagedTurnSubject
  | TerminalInteractionTerminalWatchSubject;

export interface TerminalInteractionOption {
  readonly option_id: string;
  readonly label: string;
  readonly description?: string;
}

interface TerminalInteractionQuestionBase {
  readonly question_id: string;
  readonly header?: string;
  readonly prompt: string;
  readonly required: boolean;
}

export interface TerminalInteractionSingleSelectQuestion
  extends TerminalInteractionQuestionBase {
  readonly response_kind: "single_select";
  readonly options: readonly TerminalInteractionOption[];
}

export interface TerminalInteractionMultiSelectQuestion
  extends TerminalInteractionQuestionBase {
  readonly response_kind: "multi_select";
  readonly options: readonly TerminalInteractionOption[];
}

export interface TerminalInteractionFreeTextQuestion
  extends TerminalInteractionQuestionBase {
  readonly response_kind: "free_text";
  readonly placeholder?: string;
}

export interface TerminalInteractionConfirmQuestion
  extends TerminalInteractionQuestionBase {
  readonly response_kind: "confirm";
}

export type TerminalInteractionQuestion =
  | TerminalInteractionSingleSelectQuestion
  | TerminalInteractionMultiSelectQuestion
  | TerminalInteractionFreeTextQuestion
  | TerminalInteractionConfirmQuestion;

export interface TerminalInteractionProjection {
  readonly schema: typeof TERMINAL_INTERACTION_SCHEMA;
  readonly version: typeof TERMINAL_INTERACTION_VERSION;
  readonly interaction_id: string;
  readonly turn_id: string;
  readonly agent: TerminalInteractionAgent;
  readonly kind: TerminalInteractionKind;
  readonly state: TerminalInteractionState;
  readonly step: {
    readonly index: number;
    readonly total: number;
  };
  readonly questions: readonly TerminalInteractionQuestion[];
  /** Pending interaction offers always expire and cannot be replayed. */
  readonly expires_at: string;
  readonly capabilities: {
    readonly respond: boolean;
    readonly batch_response: boolean;
    readonly free_text: boolean;
    readonly multi_select: boolean;
  };
}

/**
 * Subject-aware public projection. `subject` is authoritative. `turn_id` is a
 * deprecated managed-Turn compatibility alias and is forbidden for Watch
 * subjects, so Watch integrations never invent a fake Turn.
 */
export type TerminalInteractionSubjectProjection = {
  readonly schema: typeof TERMINAL_INTERACTION_SCHEMA;
  readonly version: typeof TERMINAL_INTERACTION_SUBJECT_VERSION;
  readonly interaction_id: string;
  readonly subject: TerminalInteractionSubject;
  readonly agent: TerminalInteractionAgent;
  readonly kind: TerminalInteractionKind;
  readonly state: TerminalInteractionState;
  readonly step: {
    readonly index: number;
    readonly total: number;
  };
  readonly questions: readonly TerminalInteractionQuestion[];
  readonly expires_at: string;
  /** Stable across monitor/Watch observation of the same native surface. */
  readonly surface_id: string;
  /** SHA-256 of the normalized native prompt, never raw terminal content. */
  readonly prompt_fingerprint: string;
  readonly response_authority: TerminalInteractionResponseAuthority;
  readonly capabilities: {
    readonly respond: boolean;
    readonly batch_response: boolean;
    readonly free_text: boolean;
    readonly multi_select: boolean;
  };
} & (
  | {
      readonly subject: TerminalInteractionManagedTurnSubject;
      /** @deprecated Read `subject.turn_id`; retained for managed v1 clients. */
      readonly turn_id?: string;
    }
  | {
      readonly subject: TerminalInteractionTerminalWatchSubject;
      readonly turn_id?: never;
    }
);

export type TerminalInteractionAnyProjection =
  | TerminalInteractionProjection
  | TerminalInteractionSubjectProjection;

interface TerminalInteractionAnswerBase {
  readonly question_id: string;
}

export interface TerminalInteractionSingleSelectAnswer
  extends TerminalInteractionAnswerBase {
  readonly response_kind: "single_select";
  readonly selected_option_ids: readonly [string];
}

export interface TerminalInteractionMultiSelectAnswer
  extends TerminalInteractionAnswerBase {
  readonly response_kind: "multi_select";
  readonly selected_option_ids: readonly string[];
}

export interface TerminalInteractionFreeTextAnswer
  extends TerminalInteractionAnswerBase {
  readonly response_kind: "free_text";
  readonly text: string;
}

export interface TerminalInteractionConfirmAnswer
  extends TerminalInteractionAnswerBase {
  readonly response_kind: "confirm";
  readonly confirm: boolean;
}

export type TerminalInteractionAnswer =
  | TerminalInteractionSingleSelectAnswer
  | TerminalInteractionMultiSelectAnswer
  | TerminalInteractionFreeTextAnswer
  | TerminalInteractionConfirmAnswer;

export interface TerminalInteractionResponse {
  readonly interaction_id: string;
  readonly turn_id: string;
  readonly answers: readonly TerminalInteractionAnswer[];
}

export type TerminalInteractionSubjectResponse = {
  readonly interaction_id: string;
  readonly subject: TerminalInteractionSubject;
  readonly answers: readonly TerminalInteractionAnswer[];
} & (
  | {
      readonly subject: TerminalInteractionManagedTurnSubject;
      /** @deprecated Optional compatibility assertion for managed clients. */
      readonly turn_id?: string;
    }
  | {
      readonly subject: TerminalInteractionTerminalWatchSubject;
      readonly turn_id?: never;
    }
);

export type TerminalInteractionAnyResponse =
  | TerminalInteractionResponse
  | TerminalInteractionSubjectResponse;

export type TerminalInteractionValidationCode =
  | "invalid_type"
  | "invalid_value"
  | "unknown_field"
  | "limit_exceeded"
  | "duplicate_id"
  | "secret_not_allowed"
  | "control_character"
  | "interaction_mismatch"
  | "response_not_allowed"
  | "answer_kind_mismatch"
  | "unknown_question"
  | "unknown_option"
  | "missing_answer"
  | "expired";

export class TerminalInteractionValidationError extends Error {
  constructor(
    readonly code: TerminalInteractionValidationCode,
    readonly path: string,
    message: string
  ) {
    super(`${path}: ${message}`);
    this.name = "TerminalInteractionValidationError";
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const UNSAFE_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const TERMINAL_ANSWER_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const SECRET_FIELD_NAMES = new Set([
  "secret",
  "isSecret",
  "is_secret",
  "contains_secret"
]);

function fail(
  code: TerminalInteractionValidationCode,
  path: string,
  message: string
): never {
  throw new TerminalInteractionValidationError(code, path, message);
}

function parseRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[]
): UnknownRecord {
  if (!isRecord(value)) {
    fail("invalid_type", path, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      fail("secret_not_allowed", `${path}.${key}`, "secret input cannot be relayed");
    }
    if (!allowedKeys.includes(key)) {
      fail("unknown_field", `${path}.${key}`, "is not allowed");
    }
  }
  return value;
}

function parseBoundedString(
  value: unknown,
  path: string,
  maxLength: number
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("invalid_type", path, "must be a non-blank string");
  }
  if (value.length > maxLength) {
    fail("limit_exceeded", path, `must contain at most ${maxLength} characters`);
  }
  if (UNSAFE_CONTROL_CHARACTER_PATTERN.test(value)) {
    fail("control_character", path, "contains an unsafe control character");
  }
  return value;
}

function parseIdentifier(value: unknown, path: string): string {
  const identifier = parseBoundedString(
    value,
    path,
    TERMINAL_INTERACTION_LIMITS.maxIdentifierLength
  );
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    fail("invalid_value", path, "must be a safe opaque identifier");
  }
  return identifier;
}

function parseEnum<const Values extends readonly string[]>(
  value: unknown,
  path: string,
  values: Values
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    fail("invalid_value", path, `must be one of ${values.join(", ")}`);
  }
  return value as Values[number];
}

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail("invalid_type", path, "must be a boolean");
  }
  return value;
}

function parsePositiveInteger(
  value: unknown,
  path: string,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("invalid_type", path, "must be a positive safe integer");
  }
  if (Number(value) > maximum) {
    fail("limit_exceeded", path, `must be at most ${maximum}`);
  }
  return Number(value);
}

function parseOptionalDisplayString(
  value: unknown,
  path: string,
  maximum: number
): string | undefined {
  return value === undefined
    ? undefined
    : parseBoundedString(value, path, maximum);
}

function assertPayloadSize(value: unknown, path: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("invalid_type", path, "must be JSON serializable");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") >
      TERMINAL_INTERACTION_LIMITS.maxProjectionBytes
  ) {
    fail(
      "limit_exceeded",
      path,
      `must serialize to at most ${TERMINAL_INTERACTION_LIMITS.maxProjectionBytes} bytes`
    );
  }
}

function parseOption(value: unknown, path: string): TerminalInteractionOption {
  const record = parseRecord(value, path, [
    "option_id",
    "label",
    "description"
  ]);
  const description = parseOptionalDisplayString(
    record.description,
    `${path}.description`,
    TERMINAL_INTERACTION_LIMITS.maxOptionDescriptionLength
  );
  return {
    option_id: parseIdentifier(record.option_id, `${path}.option_id`),
    label: parseBoundedString(
      record.label,
      `${path}.label`,
      TERMINAL_INTERACTION_LIMITS.maxOptionLabelLength
    ),
    ...(description === undefined ? {} : { description })
  };
}

function parseOptions(value: unknown, path: string): TerminalInteractionOption[] {
  if (!Array.isArray(value)) {
    fail("invalid_type", path, "must be an array");
  }
  if (
    value.length < 2 ||
    value.length > TERMINAL_INTERACTION_LIMITS.maxOptionsPerQuestion
  ) {
    fail(
      "limit_exceeded",
      path,
      `must contain between 2 and ${TERMINAL_INTERACTION_LIMITS.maxOptionsPerQuestion} options`
    );
  }
  const options = value.map((item, index) => parseOption(item, `${path}[${index}]`));
  assertUniqueIds(options.map((option) => option.option_id), path);
  return options;
}

function assertUniqueIds(ids: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      fail("duplicate_id", path, `contains duplicate id ${JSON.stringify(id)}`);
    }
    seen.add(id);
  }
}

function questionAllowedKeys(
  responseKind: TerminalInteractionResponseKind
): readonly string[] {
  const base = ["question_id", "header", "prompt", "required", "response_kind"];
  if (responseKind === "single_select" || responseKind === "multi_select") {
    return [...base, "options"];
  }
  if (responseKind === "free_text") {
    return [...base, "placeholder"];
  }
  return base;
}

function parseQuestion(value: unknown, path: string): TerminalInteractionQuestion {
  const candidate = parseRecord(value, path, [
    "question_id",
    "header",
    "prompt",
    "required",
    "response_kind",
    "options",
    "placeholder"
  ]);
  const responseKind = parseEnum(
    candidate.response_kind,
    `${path}.response_kind`,
    TERMINAL_INTERACTION_RESPONSE_KINDS
  );
  const record = parseRecord(value, path, questionAllowedKeys(responseKind));
  const common = {
    question_id: parseIdentifier(record.question_id, `${path}.question_id`),
    ...(record.header === undefined ? {} : {
      header: parseBoundedString(
        record.header,
        `${path}.header`,
        TERMINAL_INTERACTION_LIMITS.maxHeaderLength
      )
    }),
    prompt: parseBoundedString(
      record.prompt,
      `${path}.prompt`,
      TERMINAL_INTERACTION_LIMITS.maxPromptLength
    ),
    required: parseBoolean(record.required, `${path}.required`)
  };
  if (responseKind === "single_select" || responseKind === "multi_select") {
    return {
      ...common,
      response_kind: responseKind,
      options: parseOptions(record.options, `${path}.options`)
    };
  }
  if (responseKind === "free_text") {
    const placeholder = parseOptionalDisplayString(
      record.placeholder,
      `${path}.placeholder`,
      TERMINAL_INTERACTION_LIMITS.maxPlaceholderLength
    );
    return {
      ...common,
      response_kind: responseKind,
      ...(placeholder === undefined ? {} : { placeholder })
    };
  }
  return { ...common, response_kind: responseKind };
}

function parseQuestions(value: unknown): TerminalInteractionQuestion[] {
  if (!Array.isArray(value)) {
    fail("invalid_type", "$.questions", "must be an array");
  }
  if (
    value.length < 1 ||
    value.length > TERMINAL_INTERACTION_LIMITS.maxQuestions
  ) {
    fail(
      "limit_exceeded",
      "$.questions",
      `must contain between 1 and ${TERMINAL_INTERACTION_LIMITS.maxQuestions} questions`
    );
  }
  const questions = value.map((item, index) =>
    parseQuestion(item, `$.questions[${index}]`)
  );
  assertUniqueIds(questions.map((question) => question.question_id), "$.questions");
  return questions;
}

function parseStep(value: unknown): TerminalInteractionProjection["step"] {
  const record = parseRecord(value, "$.step", ["index", "total"]);
  const total = parsePositiveInteger(
    record.total,
    "$.step.total",
    TERMINAL_INTERACTION_LIMITS.maxSteps
  );
  const index = parsePositiveInteger(record.index, "$.step.index", total);
  return { index, total };
}

function parseCapabilities(
  value: unknown
): TerminalInteractionProjection["capabilities"] {
  const record = parseRecord(value, "$.capabilities", [
    "respond",
    "batch_response",
    "free_text",
    "multi_select"
  ]);
  return {
    respond: parseBoolean(record.respond, "$.capabilities.respond"),
    batch_response: parseBoolean(
      record.batch_response,
      "$.capabilities.batch_response"
    ),
    free_text: parseBoolean(record.free_text, "$.capabilities.free_text"),
    multi_select: parseBoolean(
      record.multi_select,
      "$.capabilities.multi_select"
    )
  };
}

function assertCapabilitiesMatchQuestions(
  capabilities: TerminalInteractionProjection["capabilities"],
  questions: readonly TerminalInteractionQuestion[]
): void {
  if (capabilities.batch_response) {
    fail("invalid_value", "$.capabilities.batch_response", "is not supported by protocol version 1");
  }
  const requiredCapabilities = new Set(
    questions.map((question) => question.response_kind)
  );
  for (const capability of ["free_text", "multi_select"] as const) {
    if (requiredCapabilities.has(capability) && !capabilities[capability]) {
      fail(
        "invalid_value",
        `$.capabilities.${capability}`,
        `must support projected ${capability} questions`
      );
    }
  }
}

function parseExpiresAt(value: unknown): string {
  const expiresAt = parseBoundedString(
    value,
    "$.expires_at",
    TERMINAL_INTERACTION_LIMITS.maxExpiresAtLength
  );
  if (!Number.isFinite(Date.parse(expiresAt))) {
    fail("invalid_value", "$.expires_at", "must be an ISO-compatible timestamp");
  }
  return expiresAt;
}

function parseSha256(value: unknown, path: string): string {
  const fingerprint = parseBoundedString(value, path, 64);
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
    fail("invalid_value", path, "must be a lowercase SHA-256 fingerprint");
  }
  return fingerprint;
}

export function validateTerminalInteractionSubject(
  value: unknown,
  path = "$.subject"
): TerminalInteractionSubject {
  const candidate = parseRecord(value, path, [
    "kind",
    "turn_id",
    "message_id",
    "watch_id",
    "anchor_fingerprint"
  ]);
  const kind = parseEnum(
    candidate.kind,
    `${path}.kind`,
    TERMINAL_INTERACTION_SUBJECT_KINDS
  );
  if (kind === "managed_turn") {
    const record = parseRecord(value, path, ["kind", "turn_id", "message_id"]);
    return {
      kind,
      turn_id: parseIdentifier(record.turn_id, `${path}.turn_id`),
      message_id: parseIdentifier(record.message_id, `${path}.message_id`)
    };
  }
  const record = parseRecord(value, path, [
    "kind",
    "watch_id",
    "anchor_fingerprint"
  ]);
  return {
    kind,
    watch_id: parseIdentifier(record.watch_id, `${path}.watch_id`),
    anchor_fingerprint: parseSha256(
      record.anchor_fingerprint,
      `${path}.anchor_fingerprint`
    )
  };
}

export function terminalInteractionSubjectId(
  subject: TerminalInteractionSubject
): string {
  return subject.kind === "managed_turn" ? subject.turn_id : subject.watch_id;
}

export function terminalInteractionSubjectKey(
  subject: TerminalInteractionSubject
): string {
  return `${subject.kind}:${terminalInteractionSubjectId(subject)}`;
}

export function sameTerminalInteractionSubject(
  left: TerminalInteractionSubject,
  right: TerminalInteractionSubject
): boolean {
  return left.kind === right.kind &&
    terminalInteractionSubjectId(left) === terminalInteractionSubjectId(right) &&
    (left.kind === "managed_turn"
      ? left.message_id ===
        (right as TerminalInteractionManagedTurnSubject).message_id
      : left.anchor_fingerprint ===
        (right as TerminalInteractionTerminalWatchSubject).anchor_fingerprint);
}

export function validateTerminalInteractionProjection(
  value: unknown
): TerminalInteractionProjection {
  assertPayloadSize(value, "$projection");
  const record = parseRecord(value, "$", [
    "schema",
    "version",
    "interaction_id",
    "turn_id",
    "agent",
    "kind",
    "state",
    "step",
    "questions",
    "expires_at",
    "capabilities"
  ]);
  if (record.schema !== TERMINAL_INTERACTION_SCHEMA) {
    fail("invalid_value", "$.schema", `must equal ${TERMINAL_INTERACTION_SCHEMA}`);
  }
  if (record.version !== TERMINAL_INTERACTION_VERSION) {
    fail("invalid_value", "$.version", `must equal ${TERMINAL_INTERACTION_VERSION}`);
  }
  const questions = parseQuestions(record.questions);
  const capabilities = parseCapabilities(record.capabilities);
  assertCapabilitiesMatchQuestions(capabilities, questions);
  const expiresAt = parseExpiresAt(record.expires_at);
  return {
    schema: TERMINAL_INTERACTION_SCHEMA,
    version: TERMINAL_INTERACTION_VERSION,
    interaction_id: parseIdentifier(record.interaction_id, "$.interaction_id"),
    turn_id: parseIdentifier(record.turn_id, "$.turn_id"),
    agent: parseEnum(record.agent, "$.agent", TERMINAL_INTERACTION_AGENTS),
    kind: parseEnum(record.kind, "$.kind", TERMINAL_INTERACTION_KINDS),
    state: parseEnum(record.state, "$.state", TERMINAL_INTERACTION_STATES),
    step: parseStep(record.step),
    questions,
    expires_at: expiresAt,
    capabilities
  };
}

export function validateTerminalInteractionSubjectProjection(
  value: unknown
): TerminalInteractionSubjectProjection {
  assertPayloadSize(value, "$projection");
  const record = parseRecord(value, "$", [
    "schema",
    "version",
    "interaction_id",
    "subject",
    "turn_id",
    "agent",
    "kind",
    "state",
    "step",
    "questions",
    "expires_at",
    "surface_id",
    "prompt_fingerprint",
    "response_authority",
    "capabilities"
  ]);
  if (record.schema !== TERMINAL_INTERACTION_SCHEMA) {
    fail("invalid_value", "$.schema", `must equal ${TERMINAL_INTERACTION_SCHEMA}`);
  }
  if (record.version !== TERMINAL_INTERACTION_SUBJECT_VERSION) {
    fail(
      "invalid_value",
      "$.version",
      `must equal ${TERMINAL_INTERACTION_SUBJECT_VERSION}`
    );
  }
  const subject = validateTerminalInteractionSubject(record.subject);
  let legacyTurnId: string | undefined;
  if (record.turn_id !== undefined) {
    if (subject.kind !== "managed_turn") {
      fail("unknown_field", "$.turn_id", "is forbidden for terminal_watch subjects");
    }
    legacyTurnId = parseIdentifier(record.turn_id, "$.turn_id");
    if (legacyTurnId !== subject.turn_id) {
      fail("interaction_mismatch", "$.turn_id", "must match subject.turn_id");
    }
  }
  const questions = parseQuestions(record.questions);
  const capabilities = parseCapabilities(record.capabilities);
  assertCapabilitiesMatchQuestions(capabilities, questions);
  const state = parseEnum(record.state, "$.state", TERMINAL_INTERACTION_STATES);
  const responseAuthority = parseEnum(
    record.response_authority,
    "$.response_authority",
    TERMINAL_INTERACTION_RESPONSE_AUTHORITIES
  );
  if (
    capabilities.respond &&
    (state !== "pending" || responseAuthority !== "executable")
  ) {
    fail(
      "invalid_value",
      "$.capabilities.respond",
      "requires a pending interaction with executable response authority"
    );
  }
  if (responseAuthority === "notify_only" && capabilities.respond) {
    fail(
      "invalid_value",
      "$.capabilities.respond",
      "must be false for notify-only response authority"
    );
  }
  const common = {
    schema: TERMINAL_INTERACTION_SCHEMA,
    version: TERMINAL_INTERACTION_SUBJECT_VERSION,
    interaction_id: parseIdentifier(record.interaction_id, "$.interaction_id"),
    subject,
    agent: parseEnum(record.agent, "$.agent", TERMINAL_INTERACTION_AGENTS),
    kind: parseEnum(record.kind, "$.kind", TERMINAL_INTERACTION_KINDS),
    state,
    step: parseStep(record.step),
    questions,
    expires_at: parseExpiresAt(record.expires_at),
    surface_id: parseIdentifier(record.surface_id, "$.surface_id"),
    prompt_fingerprint: parseSha256(
      record.prompt_fingerprint,
      "$.prompt_fingerprint"
    ),
    response_authority: responseAuthority,
    capabilities
  };
  return subject.kind === "managed_turn"
    ? {
        ...common,
        subject,
        ...(legacyTurnId === undefined ? {} : { turn_id: legacyTurnId })
      }
    : { ...common, subject };
}

export function validateAnyTerminalInteractionProjection(
  value: unknown
): TerminalInteractionAnyProjection {
  if (!isRecord(value)) {
    fail("invalid_type", "$", "must be an object");
  }
  return value.version === TERMINAL_INTERACTION_SUBJECT_VERSION
    ? validateTerminalInteractionSubjectProjection(value)
    : validateTerminalInteractionProjection(value);
}

function answerAllowedKeys(
  responseKind: TerminalInteractionResponseKind
): readonly string[] {
  const base = ["question_id", "response_kind"];
  if (responseKind === "single_select" || responseKind === "multi_select") {
    return [...base, "selected_option_ids"];
  }
  if (responseKind === "free_text") {
    return [...base, "text"];
  }
  return [...base, "confirm"];
}

function parseSelectedOptionIds(
  value: unknown,
  path: string,
  responseKind: "single_select" | "multi_select"
): string[] {
  if (!Array.isArray(value)) {
    fail("invalid_type", path, "must be an array");
  }
  const maximum = responseKind === "single_select"
    ? 1
    : TERMINAL_INTERACTION_LIMITS.maxOptionsPerQuestion;
  if (value.length < 1 || value.length > maximum) {
    fail("limit_exceeded", path, `must contain between 1 and ${maximum} option ids`);
  }
  const ids = value.map((item, index) => parseIdentifier(item, `${path}[${index}]`));
  assertUniqueIds(ids, path);
  return ids;
}

function parseAnswer(value: unknown, path: string): TerminalInteractionAnswer {
  const candidate = parseRecord(value, path, [
    "question_id",
    "response_kind",
    "selected_option_ids",
    "text",
    "confirm"
  ]);
  const responseKind = parseEnum(
    candidate.response_kind,
    `${path}.response_kind`,
    TERMINAL_INTERACTION_RESPONSE_KINDS
  );
  const record = parseRecord(value, path, answerAllowedKeys(responseKind));
  const questionId = parseIdentifier(record.question_id, `${path}.question_id`);
  if (responseKind === "single_select" || responseKind === "multi_select") {
    const selectedOptionIds = parseSelectedOptionIds(
      record.selected_option_ids,
      `${path}.selected_option_ids`,
      responseKind
    );
    return {
      question_id: questionId,
      response_kind: responseKind,
      selected_option_ids: responseKind === "single_select"
        ? [selectedOptionIds[0]]
        : selectedOptionIds
    } as TerminalInteractionSingleSelectAnswer |
      TerminalInteractionMultiSelectAnswer;
  }
  if (responseKind === "free_text") {
    const text = parseBoundedString(
      record.text,
      `${path}.text`,
      TERMINAL_INTERACTION_LIMITS.maxTextAnswerLength
    );
    if (TERMINAL_ANSWER_CONTROL_CHARACTER_PATTERN.test(text)) {
      fail(
        "control_character",
        `${path}.text`,
        "must be a single line without terminal control characters"
      );
    }
    return {
      question_id: questionId,
      response_kind: responseKind,
      text
    };
  }
  return {
    question_id: questionId,
    response_kind: responseKind,
    confirm: parseBoolean(record.confirm, `${path}.confirm`)
  };
}

function assertAnswerMatchesQuestion(
  answer: TerminalInteractionAnswer,
  question: TerminalInteractionQuestion,
  path: string
): void {
  if (answer.response_kind !== question.response_kind) {
    fail(
      "answer_kind_mismatch",
      `${path}.response_kind`,
      `must match ${question.response_kind}`
    );
  }
  if (
    answer.response_kind === "single_select" ||
    answer.response_kind === "multi_select"
  ) {
    const optionIds = new Set(
      (question as TerminalInteractionSingleSelectQuestion |
        TerminalInteractionMultiSelectQuestion).options.map(
        (option) => option.option_id
      )
    );
    for (const optionId of answer.selected_option_ids) {
      if (!optionIds.has(optionId)) {
        fail("unknown_option", `${path}.selected_option_ids`, `unknown option ${optionId}`);
      }
    }
  }
}

function parseAnswers(
  value: unknown,
  projection: Pick<TerminalInteractionProjection, "questions">
): TerminalInteractionAnswer[] {
  if (!Array.isArray(value)) {
    fail("invalid_type", "$.answers", "must be an array");
  }
  const questions = new Map(
    projection.questions.map((question) => [question.question_id, question])
  );
  const answers = value.map((item, index) => {
    const path = `$.answers[${index}]`;
    const answer = parseAnswer(item, path);
    const question = questions.get(answer.question_id);
    if (!question) {
      fail("unknown_question", `${path}.question_id`, "does not identify a projected question");
    }
    assertAnswerMatchesQuestion(answer, question, path);
    return answer;
  });
  assertUniqueIds(answers.map((answer) => answer.question_id), "$.answers");
  const answered = new Set(answers.map((answer) => answer.question_id));
  const missing = projection.questions.find(
    (question) => question.required && !answered.has(question.question_id)
  );
  if (missing) {
    fail("missing_answer", "$.answers", `missing required question ${missing.question_id}`);
  }
  if (answers.length !== 1 || projection.questions.length !== 1) {
    fail("invalid_value", "$.answers", "protocol version 1 requires exactly one current-step answer");
  }
  return answers;
}

export function validateTerminalInteractionResponse(
  value: unknown,
  authoritativeStoredProjection: unknown,
  options: {
    now?: Date;
    /**
     * Internal dispatch paths may validate a displayed answer shape against an
     * expired projection only because they subsequently recapture and prove
     * the exact live terminal questionnaire before sending any input.
     */
    allowExpiredForLiveRecapture?: boolean;
  } = {}
): TerminalInteractionResponse {
  assertPayloadSize(value, "$response");
  const projection = validateTerminalInteractionProjection(
    authoritativeStoredProjection
  );
  if (projection.state !== "pending") {
    fail("response_not_allowed", "$.state", "interaction is not pending");
  }
  if (!projection.capabilities.respond) {
    fail("response_not_allowed", "$.capabilities.respond", "interaction is not executable");
  }
  const now = options.now ?? new Date();
  if (
    !options.allowExpiredForLiveRecapture &&
    Date.parse(projection.expires_at) <= now.getTime()
  ) {
    fail("expired", "$.expires_at", "interaction offer has expired");
  }
  const record = parseRecord(value, "$", [
    "interaction_id",
    "turn_id",
    "answers"
  ]);
  const interactionId = parseIdentifier(record.interaction_id, "$.interaction_id");
  const turnId = parseIdentifier(record.turn_id, "$.turn_id");
  if (interactionId !== projection.interaction_id) {
    fail("interaction_mismatch", "$.interaction_id", "does not match projection");
  }
  if (turnId !== projection.turn_id) {
    fail("interaction_mismatch", "$.turn_id", "does not match projection");
  }
  return {
    interaction_id: interactionId,
    turn_id: turnId,
    answers: parseAnswers(record.answers, projection)
  };
}

export function validateTerminalInteractionSubjectResponse(
  value: unknown,
  authoritativeStoredProjection: unknown,
  options: {
    now?: Date;
    allowExpiredForLiveRecapture?: boolean;
  } = {}
): TerminalInteractionSubjectResponse {
  assertPayloadSize(value, "$response");
  const projection = validateTerminalInteractionSubjectProjection(
    authoritativeStoredProjection
  );
  if (projection.state !== "pending") {
    fail("response_not_allowed", "$.state", "interaction is not pending");
  }
  if (
    !projection.capabilities.respond ||
    projection.response_authority !== "executable"
  ) {
    fail(
      "response_not_allowed",
      "$.capabilities.respond",
      "interaction is not executable"
    );
  }
  const now = options.now ?? new Date();
  if (
    !options.allowExpiredForLiveRecapture &&
    Date.parse(projection.expires_at) <= now.getTime()
  ) {
    fail("expired", "$.expires_at", "interaction offer has expired");
  }
  const record = parseRecord(value, "$", [
    "interaction_id",
    "subject",
    "turn_id",
    "answers"
  ]);
  const interactionId = parseIdentifier(record.interaction_id, "$.interaction_id");
  if (interactionId !== projection.interaction_id) {
    fail("interaction_mismatch", "$.interaction_id", "does not match projection");
  }
  const subject = validateTerminalInteractionSubject(record.subject);
  if (!sameTerminalInteractionSubject(subject, projection.subject)) {
    fail("interaction_mismatch", "$.subject", "does not match projection subject");
  }
  let legacyTurnId: string | undefined;
  if (record.turn_id !== undefined) {
    if (subject.kind !== "managed_turn") {
      fail("unknown_field", "$.turn_id", "is forbidden for terminal_watch subjects");
    }
    legacyTurnId = parseIdentifier(record.turn_id, "$.turn_id");
    if (legacyTurnId !== subject.turn_id) {
      fail("interaction_mismatch", "$.turn_id", "must match subject.turn_id");
    }
  }
  const answers = parseAnswers(record.answers, projection);
  return subject.kind === "managed_turn"
    ? {
        interaction_id: interactionId,
        subject,
        ...(legacyTurnId === undefined ? {} : { turn_id: legacyTurnId }),
        answers
      }
    : { interaction_id: interactionId, subject, answers };
}

export function validateAnyTerminalInteractionResponse(
  value: unknown,
  authoritativeStoredProjection: unknown,
  options: {
    now?: Date;
    allowExpiredForLiveRecapture?: boolean;
  } = {}
): TerminalInteractionAnyResponse {
  const projection = validateAnyTerminalInteractionProjection(
    authoritativeStoredProjection
  );
  return projection.version === TERMINAL_INTERACTION_SUBJECT_VERSION
    ? validateTerminalInteractionSubjectResponse(value, projection, options)
    : validateTerminalInteractionResponse(value, projection, options);
}
