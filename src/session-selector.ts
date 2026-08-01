import { createHash } from "node:crypto";
import {
  isExecutorKind,
  type ExecutorKind
} from "./executors.js";

const SHORT_REF_DOMAIN = "agent-knock-knock/session-ref/v1\0";

export const DEFAULT_SESSION_SHORT_REF_LENGTH = 10;

export interface SessionSelectorCandidate {
  /** Complete, authoritative conversation/session id. */
  id: string;
  /**
   * Optional operation target returned after this candidate is selected.
   * Matching, short references, and candidate details remain anchored to
   * `id`, allowing a physical terminal to route an operation to its current
   * managed turn without changing the terminal's public selector identity.
   */
  targetId?: string;
  agent: ExecutorKind;
  /**
   * Whether the caller can perform its current operation on this target.
   *
   * Actionability is intentionally supplied by the caller because it differs
   * between operations (for example, a native session can be described but
   * cannot receive terminal input).
   */
  actionable: boolean;
  /**
   * Whether this candidate participates in omitted and semantic selector
   * resolution (`only`, `latest`, an agent name, or `agent:latest`).
   *
   * Set this to false for explicitly addressable history, such as an older
   * managed turn attached to a physical terminal. Complete ids and short refs
   * still resolve the candidate when `actionable` is true. Omission preserves
   * the previous behavior and allows the candidate into default selection.
   */
  defaultActionable?: boolean;
  /**
   * Caller-supplied recency. It must not be derived from the current clock in
   * this resolver. `latest` fails closed when recency is missing or tied.
   */
  updatedAtMs?: number;
  source?: string;
  status?: string;
  workspace?: string;
  label?: string;
}

export interface SessionSelectorCandidateDetail {
  id: string;
  shortRef: string;
  agent: ExecutorKind;
  actionable: boolean;
  defaultActionable?: boolean;
  updatedAtMs?: number;
  source?: string;
  status?: string;
  workspace?: string;
  label?: string;
}

export type SessionSelectorMatchKind =
  | "full_id"
  | "short_ref"
  | "implicit_only"
  | "only"
  | "latest"
  | "agent"
  | "agent_latest";

export interface SessionSelectorResolution<T extends SessionSelectorCandidate> {
  candidate: T;
  id: string;
  shortRef: string;
  selector?: string;
  matchedBy: SessionSelectorMatchKind;
}

export type SessionSelectorErrorCode =
  | "ambiguous"
  | "no_actionable_targets"
  | "not_actionable"
  | "not_found";

export class SessionSelectorError extends Error {
  readonly code: SessionSelectorErrorCode;
  readonly selector?: string;
  readonly candidates: readonly SessionSelectorCandidateDetail[];

  constructor(options: {
    code: SessionSelectorErrorCode;
    message: string;
    selector?: string;
    candidates?: readonly SessionSelectorCandidateDetail[];
  }) {
    super(options.message);
    this.name = "SessionSelectorError";
    this.code = options.code;
    this.selector = options.selector;
    this.candidates = Object.freeze([...(options.candidates ?? [])]);
  }
}

export interface SessionSelectorOptions {
  /** Used only to make error messages operation-specific, such as "send". */
  operation?: string;
  /**
   * Hash characters after `@`. Production callers should keep the default.
   * Shorter values are supported for deterministic collision testing.
   */
  shortRefLength?: number;
}

/**
 * Produce a stable, opaque reference that does not depend on list order or on
 * the other currently visible sessions.
 */
export function sessionShortRef(
  id: string,
  length = DEFAULT_SESSION_SHORT_REF_LENGTH
): string {
  const normalizedId = requireNonEmptyString(id, "session id");
  if (!Number.isInteger(length) || length < 6 || length > 64) {
    throw new TypeError("short reference length must be an integer between 6 and 64");
  }
  const digest = createHash("sha256")
    .update(SHORT_REF_DOMAIN, "utf8")
    .update(normalizedId, "utf8")
    .digest("hex");
  return `@${digest.slice(0, length)}`;
}

/**
 * Return display-ready candidate details in a deterministic order.
 */
export function sessionSelectorCandidateDetails(
  candidates: readonly SessionSelectorCandidate[],
  options: Pick<SessionSelectorOptions, "shortRefLength"> = {}
): SessionSelectorCandidateDetail[] {
  const normalized = normalizeCandidates(candidates);
  const shortRefLength = normalizedShortRefLength(options.shortRefLength);
  return [...normalized]
    .sort(compareCandidates)
    .map((candidate) => detailFor(candidate, shortRefLength));
}

/**
 * Resolve a user-facing selector to one authoritative id.
 *
 * This function only resolves identity. The caller must still revalidate any
 * PID, tmux pane/socket, native session id, or process identity immediately
 * before performing a side effect.
 */
export function resolveSessionSelector<T extends SessionSelectorCandidate>(
  selector: string | null | undefined,
  candidates: readonly T[],
  options: SessionSelectorOptions = {}
): SessionSelectorResolution<T> {
  const normalizedCandidates = normalizeCandidates(candidates) as T[];
  const shortRefLength = normalizedShortRefLength(options.shortRefLength);
  const operation = normalizedOperation(options.operation);
  const trimmedSelector = typeof selector === "string" ? selector.trim() : "";
  const selectorForError = trimmedSelector || undefined;

  // Complete ids are authoritative and case-sensitive. Check them before
  // reserved selector words so even an unusual id such as "latest" remains
  // addressable by its complete id.
  if (trimmedSelector) {
    const fullIdMatches = normalizedCandidates.filter(
      (candidate) => candidate.id === trimmedSelector
    );
    if (fullIdMatches.length > 0) {
      return resolveExactMatches({
        matches: fullIdMatches,
        selector: trimmedSelector,
        matchedBy: "full_id",
        operation,
        shortRefLength
      });
    }
  }

  const defaultCandidates = normalizedCandidates.filter(
    (candidate) => candidate.defaultActionable !== false
  );
  const defaultActionable = defaultCandidates.filter(
    (candidate) => candidate.actionable
  );
  if (!trimmedSelector || trimmedSelector.toLowerCase() === "only") {
    const matchedBy = trimmedSelector ? "only" : "implicit_only";
    return resolveOnly({
      matches: defaultActionable,
      allCandidates: defaultCandidates,
      selector: selectorForError,
      matchedBy,
      operation,
      shortRefLength
    });
  }

  const normalizedSelector = trimmedSelector.toLowerCase();
  if (normalizedSelector === "latest") {
    return resolveLatest({
      matches: defaultActionable,
      allCandidates: defaultCandidates,
      selector: trimmedSelector,
      matchedBy: "latest",
      operation,
      shortRefLength
    });
  }

  if (isExecutorKind(normalizedSelector)) {
    const allAgentMatches = defaultCandidates.filter(
      (candidate) => candidate.agent === normalizedSelector
    );
    return resolveOnly({
      matches: allAgentMatches.filter((candidate) => candidate.actionable),
      allCandidates: allAgentMatches,
      selector: trimmedSelector,
      matchedBy: "agent",
      operation,
      shortRefLength
    });
  }

  const agentLatestMatch = /^(codex|claude):latest$/u.exec(normalizedSelector);
  if (agentLatestMatch) {
    const agent = agentLatestMatch[1] as ExecutorKind;
    const allAgentMatches = defaultCandidates.filter(
      (candidate) => candidate.agent === agent
    );
    return resolveLatest({
      matches: allAgentMatches.filter((candidate) => candidate.actionable),
      allCandidates: allAgentMatches,
      selector: trimmedSelector,
      matchedBy: "agent_latest",
      operation,
      shortRefLength
    });
  }

  if (/^@[0-9a-f]+$/iu.test(trimmedSelector)) {
    const shortRefMatches = normalizedCandidates.filter(
      (candidate) =>
        sessionShortRef(candidate.id, shortRefLength).toLowerCase() === normalizedSelector
    );
    if (shortRefMatches.length > 0) {
      return resolveExactMatches({
        matches: shortRefMatches,
        selector: trimmedSelector,
        matchedBy: "short_ref",
        operation,
        shortRefLength
      });
    }
  }

  const details = candidateDetails(
    normalizedCandidates.filter((candidate) => candidate.actionable),
    shortRefLength
  );
  throw new SessionSelectorError({
    code: "not_found",
    selector: trimmedSelector,
    candidates: details,
    message: [
      `Session selector ${quote(trimmedSelector)} did not match an actionable target${operationSuffix(operation)}.`,
      candidateHint(details)
    ].filter(Boolean).join(" ")
  });
}

function resolveExactMatches<T extends SessionSelectorCandidate>(options: {
  matches: readonly T[];
  selector: string;
  matchedBy: "full_id" | "short_ref";
  operation?: string;
  shortRefLength: number;
}): SessionSelectorResolution<T> {
  if (options.matches.length > 1) {
    const details = candidateDetails(options.matches, options.shortRefLength);
    throw new SessionSelectorError({
      code: "ambiguous",
      selector: options.selector,
      candidates: details,
      message: [
        `Session selector ${quote(options.selector)} is ambiguous.`,
        candidateHint(details)
      ].join(" ")
    });
  }
  const candidate = options.matches[0];
  if (!candidate.actionable) {
    const details = candidateDetails(options.matches, options.shortRefLength);
    throw new SessionSelectorError({
      code: "not_actionable",
      selector: options.selector,
      candidates: details,
      message:
        `Session ${quote(candidate.id)} is not actionable${operationSuffix(options.operation)}.`
    });
  }
  return resolution(candidate, options.selector, options.matchedBy, options.shortRefLength);
}

function resolveOnly<T extends SessionSelectorCandidate>(options: {
  matches: readonly T[];
  allCandidates: readonly T[];
  selector?: string;
  matchedBy: "implicit_only" | "only" | "agent";
  operation?: string;
  shortRefLength: number;
}): SessionSelectorResolution<T> {
  if (options.matches.length === 1) {
    return resolution(
      options.matches[0],
      options.selector,
      options.matchedBy,
      options.shortRefLength
    );
  }
  if (options.matches.length === 0) {
    throwNoActionable(options);
  }
  throwAmbiguous(options);
}

function resolveLatest<T extends SessionSelectorCandidate>(options: {
  matches: readonly T[];
  allCandidates: readonly T[];
  selector: string;
  matchedBy: "latest" | "agent_latest";
  operation?: string;
  shortRefLength: number;
}): SessionSelectorResolution<T> {
  if (options.matches.length === 0) {
    throwNoActionable(options);
  }
  if (options.matches.length === 1) {
    return resolution(
      options.matches[0],
      options.selector,
      options.matchedBy,
      options.shortRefLength
    );
  }

  // If any candidate lacks recency, choosing another candidate as "latest"
  // would be a guess. Equal newest timestamps are also intentionally ambiguous.
  if (options.matches.some((candidate) => candidate.updatedAtMs === undefined)) {
    throwAmbiguous(options, "latest cannot be determined because recency is missing");
  }
  const newestTimestamp = Math.max(
    ...options.matches.map((candidate) => candidate.updatedAtMs as number)
  );
  const newest = options.matches.filter(
    (candidate) => candidate.updatedAtMs === newestTimestamp
  );
  if (newest.length !== 1) {
    throwAmbiguous(
      { ...options, matches: newest },
      "latest is tied between multiple targets"
    );
  }
  return resolution(
    newest[0],
    options.selector,
    options.matchedBy,
    options.shortRefLength
  );
}

function throwNoActionable(options: {
  allCandidates: readonly SessionSelectorCandidate[];
  selector?: string;
  operation?: string;
  shortRefLength: number;
}): never {
  const details = candidateDetails(options.allCandidates, options.shortRefLength);
  const hasCandidates = options.allCandidates.length > 0;
  throw new SessionSelectorError({
    code: hasCandidates ? "not_actionable" : "no_actionable_targets",
    selector: options.selector,
    candidates: details,
    message: hasCandidates
      ? `No matching session is actionable${operationSuffix(options.operation)}. ${candidateHint(details)}`
      : `There are no actionable sessions${operationSuffix(options.operation)}.`
  });
}

function throwAmbiguous(options: {
  matches: readonly SessionSelectorCandidate[];
  selector?: string;
  shortRefLength: number;
}, reason = "multiple actionable targets match"): never {
  const details = candidateDetails(options.matches, options.shortRefLength);
  const subject = options.selector
    ? `Session selector ${quote(options.selector)}`
    : "The omitted session selector";
  throw new SessionSelectorError({
    code: "ambiguous",
    selector: options.selector,
    candidates: details,
    message: `${subject} is ambiguous: ${reason}. ${candidateHint(details)}`
  });
}

function resolution<T extends SessionSelectorCandidate>(
  candidate: T,
  selector: string | undefined,
  matchedBy: SessionSelectorMatchKind,
  shortRefLength: number
): SessionSelectorResolution<T> {
  return {
    candidate,
    id: candidate.targetId ?? candidate.id,
    shortRef: sessionShortRef(candidate.id, shortRefLength),
    selector,
    matchedBy
  };
}

function normalizeCandidates<T extends SessionSelectorCandidate>(
  candidates: readonly T[]
): T[] {
  if (!Array.isArray(candidates)) {
    throw new TypeError("session selector candidates must be an array");
  }
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new TypeError(`session selector candidate ${index} must be an object`);
    }
    requireNonEmptyString(candidate.id, `session selector candidate ${index} id`);
    if (candidate.targetId !== undefined) {
      requireNonEmptyString(
        candidate.targetId,
        `session selector candidate ${index} targetId`
      );
    }
    if (!isExecutorKind(candidate.agent)) {
      throw new TypeError(
        `session selector candidate ${index} has unsupported agent ${quote(String(candidate.agent))}`
      );
    }
    if (typeof candidate.actionable !== "boolean") {
      throw new TypeError(
        `session selector candidate ${index} actionable must be a boolean`
      );
    }
    if (
      candidate.defaultActionable !== undefined &&
      typeof candidate.defaultActionable !== "boolean"
    ) {
      throw new TypeError(
        `session selector candidate ${index} defaultActionable must be a boolean when provided`
      );
    }
    if (
      candidate.updatedAtMs !== undefined &&
      !Number.isFinite(candidate.updatedAtMs)
    ) {
      throw new TypeError(
        `session selector candidate ${index} updatedAtMs must be finite when provided`
      );
    }
    return candidate;
  });
}

function candidateDetails(
  candidates: readonly SessionSelectorCandidate[],
  shortRefLength: number
): SessionSelectorCandidateDetail[] {
  return [...candidates]
    .sort(compareCandidates)
    .map((candidate) => detailFor(candidate, shortRefLength));
}

function detailFor(
  candidate: SessionSelectorCandidate,
  shortRefLength: number
): SessionSelectorCandidateDetail {
  return {
    id: candidate.id,
    shortRef: sessionShortRef(candidate.id, shortRefLength),
    agent: candidate.agent,
    actionable: candidate.actionable,
    defaultActionable: candidate.defaultActionable,
    updatedAtMs: candidate.updatedAtMs,
    source: candidate.source,
    status: candidate.status,
    workspace: candidate.workspace,
    label: candidate.label
  };
}

function compareCandidates(
  left: SessionSelectorCandidate,
  right: SessionSelectorCandidate
): number {
  const leftHasTime = left.updatedAtMs !== undefined;
  const rightHasTime = right.updatedAtMs !== undefined;
  if (leftHasTime && rightHasTime && left.updatedAtMs !== right.updatedAtMs) {
    return (right.updatedAtMs as number) - (left.updatedAtMs as number);
  }
  if (leftHasTime !== rightHasTime) {
    return leftHasTime ? -1 : 1;
  }
  const agentOrder = compareStrings(left.agent, right.agent);
  return agentOrder || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateHint(details: readonly SessionSelectorCandidateDetail[]): string {
  if (details.length === 0) {
    return "";
  }
  return `Candidates: ${details.map((detail) => {
    const context = [
      detail.shortRef,
      detail.agent,
      detail.status,
      detail.source,
      detail.workspace,
      detail.label ? bounded(detail.label, 80) : undefined,
      detail.id
    ].filter((value): value is string => Boolean(value));
    return `[${context.join(" | ")}]`;
  }).join(", ")}`;
}

function normalizedShortRefLength(value: number | undefined): number {
  const length = value ?? DEFAULT_SESSION_SHORT_REF_LENGTH;
  // Reuse the public validation without making a meaningless hash allocation.
  if (!Number.isInteger(length) || length < 6 || length > 64) {
    throw new TypeError("short reference length must be an integer between 6 and 64");
  }
  return length;
}

function normalizedOperation(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, "session selector operation");
}

function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function operationSuffix(operation: string | undefined): string {
  return operation ? ` for ${operation}` : "";
}

function bounded(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1)}…`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
