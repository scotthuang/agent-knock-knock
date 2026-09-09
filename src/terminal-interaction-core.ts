import { createHash } from "node:crypto";
import {
  inspectNativeQuestionnaire,
  type NativeQuestionnaireActionPlan,
  type NativeQuestionnaireInspection,
  type NativeQuestionnaireQuestion
} from "./terminal-questionnaire-adapter.js";
import {
  TERMINAL_INTERACTION_SCHEMA,
  TERMINAL_INTERACTION_SUBJECT_VERSION,
  sameTerminalInteractionSubject,
  terminalInteractionSubjectKey,
  validateTerminalInteractionSubject,
  validateTerminalInteractionSubjectProjection,
  type TerminalInteractionAgent,
  type TerminalInteractionQuestion,
  type TerminalInteractionResponseAuthority,
  type TerminalInteractionSubject,
  type TerminalInteractionSubjectProjection
} from "./terminal-interaction-protocol.js";
import { isRecord } from "./value-guards.js";

export const TERMINAL_INTERACTION_AGGREGATE_SCHEMA =
  "agent-knock-knock/terminal-interaction-aggregate" as const;
export const TERMINAL_INTERACTION_AGGREGATE_VERSION = 1 as const;
export const TERMINAL_INTERACTION_AGGREGATE_STATES = [
  "pending",
  "reserved",
  "consumed",
  "response_uncertain",
  "superseded"
] as const;

export type TerminalInteractionAggregateState =
  typeof TERMINAL_INTERACTION_AGGREGATE_STATES[number];

export interface TerminalInteractionReservation {
  readonly attempt_id: string;
  readonly response_hash: string;
  readonly reserved_at: string;
}

export interface TerminalInteractionResolution {
  readonly resolved_at: string;
  /** Bounded machine code only; never persist raw screen/error/answer text. */
  readonly reason_code: string;
}

export interface TerminalInteractionAggregate {
  readonly schema: typeof TERMINAL_INTERACTION_AGGREGATE_SCHEMA;
  readonly version: typeof TERMINAL_INTERACTION_AGGREGATE_VERSION;
  readonly subject: TerminalInteractionSubject;
  readonly interaction_id: string;
  readonly surface_id: string;
  readonly prompt_fingerprint: string;
  readonly response_authority: TerminalInteractionResponseAuthority;
  readonly current_step: number;
  readonly state: TerminalInteractionAggregateState;
  readonly created_at: string;
  readonly expires_at: string;
  readonly reservation?: TerminalInteractionReservation;
  readonly resolution?: TerminalInteractionResolution;
}

export type TerminalInteractionAggregateEvent =
  | {
      /** Exact live recapture proved the same pending native surface. */
      readonly type: "refresh";
      readonly expires_at: string;
    }
  | {
      readonly type: "reserve";
      readonly attempt_id: string;
      readonly response_hash: string;
      readonly at: string;
    }
  | {
      readonly type: "consume";
      readonly at: string;
      readonly reason_code: string;
    }
  | {
      readonly type: "response_uncertain";
      readonly at: string;
      readonly reason_code: string;
    }
  | {
      readonly type: "supersede";
      readonly at: string;
      readonly reason_code: string;
    };

export class TerminalInteractionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalInteractionTransitionError";
  }
}

export interface BuildTerminalInteractionOfferInput {
  readonly subject: TerminalInteractionSubject;
  readonly agent: TerminalInteractionAgent;
  readonly agentVersion: string;
  /** Canonical endpoint/process incarnation data. It is hashed, never emitted. */
  readonly canonicalTerminalIdentity: unknown;
  /** Exact accepted native task/thread/rollout identity. It is hashed, never emitted. */
  readonly nativeTaskIdentity: unknown;
  readonly inspection: NativeQuestionnaireInspection;
  readonly now: Date;
  readonly expiresAt?: string;
  readonly ttlMs?: number;
  readonly responseUncertain?: boolean;
  readonly responseAuthority: TerminalInteractionResponseAuthority;
  /** Managed v1 clients may temporarily require the legacy top-level alias. */
  readonly includeLegacyTurnId?: boolean;
}

export interface TerminalInteractionCoreOffer {
  readonly projection: TerminalInteractionSubjectProjection;
  readonly promptFingerprint: string;
  readonly surfaceId: string;
  /** Owner-private: never copy this field into callbacks or public Status. */
  readonly actionPlan: NativeQuestionnaireActionPlan;
  readonly nativeInspection: Exclude<
    NativeQuestionnaireInspection,
    { readonly status: "none" }
  >;
}

export interface CaptureTerminalInteractionInput
  extends Omit<BuildTerminalInteractionOfferInput, "inspection"> {
  readonly screen: string;
  readonly secret?: boolean;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(`${namespace}\0${canonicalJson(value)}`, "utf8")
    .digest("hex");
}

function terminalInteractionQuestion(
  question: NativeQuestionnaireQuestion
): TerminalInteractionQuestion {
  const common = {
    question_id: question.question_id,
    prompt: question.prompt,
    required: question.required
  };
  if (
    question.response_kind === "single_select" ||
    question.response_kind === "multi_select"
  ) {
    return {
      ...common,
      response_kind: question.response_kind,
      options: question.options ?? []
    };
  }
  return { ...common, response_kind: question.response_kind };
}

function offerExpiry(input: BuildTerminalInteractionOfferInput): string {
  if (input.expiresAt !== undefined) {
    return input.expiresAt;
  }
  const ttlMs = input.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError("terminal interaction ttlMs must be a positive integer");
  }
  return new Date(input.now.getTime() + ttlMs).toISOString();
}

/**
 * Pure, subject-neutral offer builder. Monitor and Watch pass the same native
 * inspection through this function and therefore share semantic ids,
 * cross-source `surface_id`, public redaction, and executable/manual policy.
 */
export function buildTerminalInteractionOffer(
  input: BuildTerminalInteractionOfferInput
): TerminalInteractionCoreOffer | undefined {
  if (input.inspection.status === "none") {
    return undefined;
  }
  if (input.inspection.agent !== input.agent) {
    throw new TypeError("native questionnaire agent does not match offer agent");
  }
  const subject = validateTerminalInteractionSubject(input.subject);
  const promptFingerprint = input.inspection.prompt_evidence.sha256;
  const surfaceMaterial = {
    version: 1,
    agent: input.agent,
    agent_version: input.agentVersion,
    terminal: input.canonicalTerminalIdentity,
    native_task: input.nativeTaskIdentity,
    profile: input.inspection.profile,
    prompt_sha256: promptFingerprint
  };
  const surfaceId = `tis_${sha256(
    "terminal-interaction-surface",
    surfaceMaterial
  ).slice(0, 40)}`;
  const interactionId = `ti_${sha256("terminal-interaction-subject", {
    subject: terminalInteractionSubjectKey(subject),
    subject_evidence: subject,
    surface_id: surfaceId
  }).slice(0, 40)}`;
  const actionPlan = input.inspection.action_plan;
  const nativeExecutable = input.inspection.status === "actionable" &&
    actionPlan.kind !== "manual_only";
  const responseAuthority = nativeExecutable
    ? input.responseAuthority
    : "notify_only";
  const responseUncertain = input.responseUncertain === true;
  const state = responseUncertain
    ? "response_uncertain"
    : nativeExecutable
      ? "pending"
      : "manual_required";
  const question = terminalInteractionQuestion(input.inspection.question);
  const common = {
    schema: TERMINAL_INTERACTION_SCHEMA,
    version: TERMINAL_INTERACTION_SUBJECT_VERSION,
    interaction_id: interactionId,
    subject,
    agent: input.agent,
    kind: "questionnaire" as const,
    state,
    step: {
      index: input.inspection.current_step,
      total: input.inspection.total_steps
    },
    questions: [question],
    expires_at: offerExpiry(input),
    surface_id: surfaceId,
    prompt_fingerprint: promptFingerprint,
    response_authority: responseAuthority,
    capabilities: {
      respond: nativeExecutable &&
        responseAuthority === "executable" &&
        !responseUncertain,
      batch_response: false,
      free_text: question.response_kind === "free_text",
      multi_select: question.response_kind === "multi_select"
    }
  };
  const projection = validateTerminalInteractionSubjectProjection(
    subject.kind === "managed_turn" && input.includeLegacyTurnId !== false
      ? { ...common, subject, turn_id: subject.turn_id }
      : { ...common, subject }
  );
  return {
    projection,
    promptFingerprint,
    surfaceId,
    actionPlan,
    nativeInspection: input.inspection
  };
}

/** Convenience capture entry point; the parser remains single-source. */
export function captureTerminalInteraction(
  input: CaptureTerminalInteractionInput
): TerminalInteractionCoreOffer | undefined {
  return buildTerminalInteractionOffer({
    ...input,
    inspection: inspectNativeQuestionnaire({
      agent: input.agent,
      version: input.agentVersion,
      screen: input.screen,
      secret: input.secret
    })
  });
}

export function createTerminalInteractionAggregate(
  projectionValue: unknown,
  createdAt: string
): TerminalInteractionAggregate {
  const projection = validateTerminalInteractionSubjectProjection(projectionValue);
  if (projection.state === "response_uncertain") {
    throw new TerminalInteractionTransitionError(
      "response-uncertain projection requires its existing durable reservation"
    );
  }
  return validateTerminalInteractionAggregate({
    schema: TERMINAL_INTERACTION_AGGREGATE_SCHEMA,
    version: TERMINAL_INTERACTION_AGGREGATE_VERSION,
    subject: projection.subject,
    interaction_id: projection.interaction_id,
    surface_id: projection.surface_id,
    prompt_fingerprint: projection.prompt_fingerprint,
    response_authority: projection.response_authority,
    current_step: projection.step.index,
    state: "pending",
    created_at: createdAt,
    expires_at: projection.expires_at
  });
}

export function hashTerminalInteractionResponse(value: unknown): string {
  return sha256("terminal-interaction-response", value);
}

export function reduceTerminalInteractionAggregate(
  currentValue: unknown,
  event: TerminalInteractionAggregateEvent
): TerminalInteractionAggregate {
  const current = validateTerminalInteractionAggregate(currentValue);
  let next: TerminalInteractionAggregate;
  switch (event.type) {
    case "refresh":
      if (current.state !== "pending") {
        throw transitionError(current.state, event.type);
      }
      if (
        !Number.isFinite(Date.parse(event.expires_at)) ||
        Date.parse(event.expires_at) <= Date.parse(current.expires_at)
      ) {
        throw new TerminalInteractionTransitionError(
          "terminal interaction refresh must extend expires_at"
        );
      }
      next = { ...current, expires_at: event.expires_at };
      break;
    case "reserve":
      if (current.state !== "pending") {
        throw transitionError(current.state, event.type);
      }
      if (current.response_authority !== "executable") {
        throw new TerminalInteractionTransitionError(
          "notify-only interaction cannot reserve terminal response authority"
        );
      }
      next = {
        ...current,
        state: "reserved",
        reservation: {
          attempt_id: event.attempt_id,
          response_hash: event.response_hash,
          reserved_at: event.at
        }
      };
      break;
    case "consume":
      if (current.state !== "reserved") {
        throw transitionError(current.state, event.type);
      }
      next = {
        ...current,
        state: "consumed",
        resolution: {
          resolved_at: event.at,
          reason_code: event.reason_code
        }
      };
      break;
    case "response_uncertain":
      if (current.state !== "reserved") {
        throw transitionError(current.state, event.type);
      }
      next = {
        ...current,
        state: "response_uncertain",
        resolution: {
          resolved_at: event.at,
          reason_code: event.reason_code
        }
      };
      break;
    case "supersede":
      if (current.state !== "pending") {
        throw transitionError(current.state, event.type);
      }
      next = {
        ...current,
        state: "superseded",
        resolution: {
          resolved_at: event.at,
          reason_code: event.reason_code
        }
      };
      break;
  }
  return validateTerminalInteractionAggregate(next);
}

function transitionError(
  state: TerminalInteractionAggregateState,
  event: TerminalInteractionAggregateEvent["type"]
): TerminalInteractionTransitionError {
  return new TerminalInteractionTransitionError(
    `terminal interaction cannot transition from ${state} via ${event}`
  );
}

function aggregateString(
  value: unknown,
  field: string,
  pattern?: RegExp
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  if (pattern && !pattern.test(value)) {
    throw new TypeError(`${field} has an invalid format`);
  }
  return value;
}

function aggregateTimestamp(value: unknown, field: string): string {
  const timestamp = aggregateString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError(`${field} must be an ISO-compatible timestamp`);
  }
  return timestamp;
}

function aggregateRecord(
  value: unknown,
  field: string,
  keys: readonly string[]
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new TypeError(`${field}.${key} is not allowed`);
    }
  }
  return value;
}

export function validateTerminalInteractionAggregate(
  value: unknown
): TerminalInteractionAggregate {
  const record = aggregateRecord(value, "$aggregate", [
    "schema",
    "version",
    "subject",
    "interaction_id",
    "surface_id",
    "prompt_fingerprint",
    "response_authority",
    "current_step",
    "state",
    "created_at",
    "expires_at",
    "reservation",
    "resolution"
  ]);
  if (record.schema !== TERMINAL_INTERACTION_AGGREGATE_SCHEMA) {
    throw new TypeError("$aggregate.schema is invalid");
  }
  if (record.version !== TERMINAL_INTERACTION_AGGREGATE_VERSION) {
    throw new TypeError("$aggregate.version is invalid");
  }
  const subject = validateTerminalInteractionSubject(
    record.subject,
    "$aggregate.subject"
  );
  const state = aggregateString(record.state, "$aggregate.state") as
    TerminalInteractionAggregateState;
  if (!TERMINAL_INTERACTION_AGGREGATE_STATES.includes(state)) {
    throw new TypeError("$aggregate.state is invalid");
  }
  const responseAuthority = aggregateString(
    record.response_authority,
    "$aggregate.response_authority"
  ) as TerminalInteractionResponseAuthority;
  if (responseAuthority !== "executable" && responseAuthority !== "notify_only") {
    throw new TypeError("$aggregate.response_authority is invalid");
  }
  if (!Number.isSafeInteger(record.current_step) || Number(record.current_step) < 1) {
    throw new TypeError("$aggregate.current_step must be a positive integer");
  }
  let reservation: TerminalInteractionReservation | undefined;
  if (record.reservation !== undefined) {
    const item = aggregateRecord(record.reservation, "$aggregate.reservation", [
      "attempt_id",
      "response_hash",
      "reserved_at"
    ]);
    reservation = {
      attempt_id: aggregateString(item.attempt_id, "$aggregate.reservation.attempt_id"),
      response_hash: aggregateString(
        item.response_hash,
        "$aggregate.reservation.response_hash",
        /^[0-9a-f]{64}$/u
      ),
      reserved_at: aggregateTimestamp(
        item.reserved_at,
        "$aggregate.reservation.reserved_at"
      )
    };
  }
  let resolution: TerminalInteractionResolution | undefined;
  if (record.resolution !== undefined) {
    const item = aggregateRecord(record.resolution, "$aggregate.resolution", [
      "resolved_at",
      "reason_code"
    ]);
    resolution = {
      resolved_at: aggregateTimestamp(
        item.resolved_at,
        "$aggregate.resolution.resolved_at"
      ),
      reason_code: aggregateString(
        item.reason_code,
        "$aggregate.resolution.reason_code",
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
      )
    };
  }
  if (
    (state === "reserved" || state === "consumed" ||
      state === "response_uncertain") &&
    !reservation
  ) {
    throw new TypeError(`$aggregate.reservation is required for ${state}`);
  }
  if ((state === "consumed" || state === "response_uncertain" ||
    state === "superseded") && !resolution) {
    throw new TypeError(`$aggregate.resolution is required for ${state}`);
  }
  if (state === "pending" && (reservation || resolution)) {
    throw new TypeError("pending aggregate cannot have reservation or resolution");
  }
  if (state === "reserved" && resolution) {
    throw new TypeError("reserved aggregate cannot have a resolution");
  }
  if (state === "superseded" && reservation) {
    throw new TypeError("superseded aggregate cannot have a reservation");
  }
  return {
    schema: TERMINAL_INTERACTION_AGGREGATE_SCHEMA,
    version: TERMINAL_INTERACTION_AGGREGATE_VERSION,
    subject,
    interaction_id: aggregateString(record.interaction_id, "$aggregate.interaction_id"),
    surface_id: aggregateString(record.surface_id, "$aggregate.surface_id"),
    prompt_fingerprint: aggregateString(
      record.prompt_fingerprint,
      "$aggregate.prompt_fingerprint",
      /^[0-9a-f]{64}$/u
    ),
    response_authority: responseAuthority,
    current_step: Number(record.current_step),
    state,
    created_at: aggregateTimestamp(record.created_at, "$aggregate.created_at"),
    expires_at: aggregateTimestamp(record.expires_at, "$aggregate.expires_at"),
    ...(reservation ? { reservation } : {}),
    ...(resolution ? { resolution } : {})
  };
}

export function aggregateMatchesProjection(
  aggregateValue: unknown,
  projectionValue: unknown
): boolean {
  const aggregate = validateTerminalInteractionAggregate(aggregateValue);
  const projection = validateTerminalInteractionSubjectProjection(projectionValue);
  return sameTerminalInteractionSubject(aggregate.subject, projection.subject) &&
    aggregate.interaction_id === projection.interaction_id &&
    aggregate.surface_id === projection.surface_id &&
    aggregate.prompt_fingerprint === projection.prompt_fingerprint &&
    aggregate.response_authority === projection.response_authority &&
    aggregate.current_step === projection.step.index &&
    aggregate.expires_at === projection.expires_at;
}
