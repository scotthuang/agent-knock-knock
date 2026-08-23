import path from "node:path";

import {
  atomicSaveJsonFile,
  isNodeError,
  readJsonFileNoFollow
} from "./durable-json-file.js";
import { ensureDir, pathsForConversationDir } from "./store.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export const TERMINAL_SUBMISSION_RETRY_SCHEMA =
  "agent-knock-knock/terminal-submission-retry" as const;
export const TERMINAL_SUBMISSION_RETRY_VERSION = 1 as const;
export const TERMINAL_SUBMISSION_RETRY_FILE = "submission-retry.json";

export type TerminalSubmissionRetryMode =
  | "exact_draft_enter"
  | "replacement_send";

export type TerminalSubmissionRetryState =
  | "replacement_reserved"
  | "replacement_text_reserved"
  | "replacement_text_injected"
  | "enter_reserved"
  | "enter_dispatched"
  | "agent_accepted";

export interface TerminalSubmissionRetryRecord {
  schema: typeof TERMINAL_SUBMISSION_RETRY_SCHEMA;
  version: typeof TERMINAL_SUBMISSION_RETRY_VERSION;
  revision: number;
  attempt_id: string;
  mode: TerminalSubmissionRetryMode;
  state: TerminalSubmissionRetryState;
  store_dir: string;
  state_path: string;
  session_id: string;
  turn_id: string;
  original_message_id: string;
  active_message_id: string;
  request_hash: string;
  terminal_target: string;
  callback_route_fingerprint: string | null;
  deferred_foreground_transfer_id: string | null;
  reserved_at: string;
  updated_at: string;
  replacement_text_reserved_at?: string;
  replacement_text_injected_at?: string;
  enter_reserved_at?: string;
  enter_dispatched_at?: string;
  agent_accepted_at?: string;
}

export type TerminalSubmissionComposerState =
  | "exact_draft"
  | "exact_empty"
  | "different_draft"
  | "working"
  | "approval_or_modal"
  | "identity_drift"
  | "unavailable";

export type TerminalSubmissionRetryDecision =
  | { action: "repair_accepted" }
  | { action: "submit_exact_draft"; activeMessageId: string }
  | { action: "start_replacement" }
  | { action: "resume_replacement"; activeMessageId: string }
  | { action: "refuse"; reason: string };

export interface TerminalSubmissionRetryFacts {
  agent: string;
  exactTurnTarget: boolean;
  accepted: boolean;
  composer: TerminalSubmissionComposerState;
  submissionStatus?: string;
  lastProvenStage?: string;
  submissionTextInjectedAt?: string;
  enterDispatchedAt?: string;
  enterNotAttemptedAt?: string;
  enterNotAttemptedReason?: string;
  ledgerStatus?: string;
  ledgerTextInjectedAt?: string;
  ledgerEnterDispatchedAt?: string;
  ledgerEnterNotAttemptedAt?: string;
  ledgerEnterNotAttemptedReason?: string;
  ledgerAgentAcceptedAt?: string;
  originalMessageId?: string;
  currentMessageId?: string;
  attempt?: TerminalSubmissionRetryRecord;
}

export interface TerminalSubmissionRetryPendingProjection {
  messageId: string;
  preparedAt: string;
  textInjectedAt: string;
  enterDispatchedAt: string;
}

export function projectTerminalSubmissionRetryPending(input: {
  attempt: TerminalSubmissionRetryRecord;
  submission: Record<string, unknown>;
  ledger: Record<string, unknown>;
}): TerminalSubmissionRetryPendingProjection {
  const { attempt, submission, ledger } = input;
  if (attempt.state !== "enter_dispatched" || !attempt.enter_dispatched_at) {
    throw new Error("submission retry has no durable Enter dispatch to reconcile");
  }
  if (
    !["uncertain", "text_injected", "enter_dispatched"].includes(
      String(submission.status)
    ) ||
    !["uncertain", "text_injected", "enter_dispatched"].includes(
      String(ledger.status)
    ) ||
    submission.agent_accepted_at !== undefined ||
    submission.not_accepted_at !== undefined ||
    ledger.agent_accepted_at !== undefined ||
    ledger.not_accepted_at !== undefined ||
    ledger.acceptance_evidence !== undefined
  ) {
    throw new Error(
      "submission retry pending metadata conflicts with a stronger durable outcome"
    );
  }
  const messageId = nonBlankString(submission.message_id);
  const preparedAt = nonBlankString(submission.prepared_at);
  if (
    !messageId || messageId !== attempt.active_message_id ||
    nonBlankString(ledger.message_id) !== messageId ||
    !preparedAt || nonBlankString(ledger.prepared_at) !== preparedAt
  ) {
    throw new Error("submission retry pending generation authority disagrees");
  }
  assertPendingRetryLedgerPrefix(attempt, ledger);
  const textInjectedAt = attempt.mode === "replacement_send"
    ? attempt.replacement_text_injected_at
    : nonBlankString(submission.text_injected_at);
  if (!textInjectedAt) {
    throw new Error("submission retry pending text authority is unavailable");
  }
  if (
    (submission.status === "enter_dispatched" &&
      nonBlankString(submission.text_injected_at) !== textInjectedAt) ||
    (ledger.status === "enter_dispatched" &&
      nonBlankString(ledger.text_injected_at) !== textInjectedAt) ||
    (attempt.mode === "exact_draft_enter" &&
      nonBlankString(ledger.text_injected_at) !== textInjectedAt)
  ) {
    throw new Error("submission retry pending text authority disagrees");
  }
  for (const record of [submission, ledger]) {
    const enteredAt = nonBlankString(record.enter_dispatched_at);
    if (enteredAt && enteredAt !== attempt.enter_dispatched_at) {
      throw new Error("submission retry pending Enter authority disagrees");
    }
  }
  return {
    messageId,
    preparedAt,
    textInjectedAt,
    enterDispatchedAt: attempt.enter_dispatched_at
  };
}

function assertPendingRetryLedgerPrefix(
  attempt: TerminalSubmissionRetryRecord,
  ledger: Record<string, unknown>
): void {
  const ledgerState = nonBlankString(ledger.submission_retry_state);
  const ledgerRevision = ledger.submission_retry_revision;
  const dispatchPersisted = ledgerState === "enter_dispatched";
  const reservationPersisted = ledgerState === "enter_reserved";
  if (
    nonBlankString(ledger.submission_retry_attempt_id) !== attempt.attempt_id ||
    nonBlankString(ledger.submission_retry_mode) !== attempt.mode ||
    nonBlankString(ledger.submission_retry_original_message_id) !==
      attempt.original_message_id ||
    nonBlankString(ledger.submission_retry_active_message_id) !==
      attempt.active_message_id ||
    nonBlankString(ledger.submission_retry_reserved_at) !==
      attempt.reserved_at ||
    typeof ledgerRevision !== "number" ||
    !Number.isSafeInteger(ledgerRevision) ||
    !(
      dispatchPersisted && ledgerRevision === attempt.revision ||
      reservationPersisted && ledgerRevision === attempt.revision - 1
    ) ||
    nonBlankString(ledger.submission_retry_enter_reserved_at) !==
      attempt.enter_reserved_at ||
    nonBlankString(ledger.submission_retry_enter_dispatched_at) !==
      (dispatchPersisted ? attempt.enter_dispatched_at : undefined) ||
    nonBlankString(ledger.submission_retry_replacement_text_reserved_at) !==
      attempt.replacement_text_reserved_at ||
    nonBlankString(ledger.submission_retry_replacement_text_injected_at) !==
      attempt.replacement_text_injected_at
  ) {
    throw new Error(
      "submission retry pending ledger lacks the exact durable retry prefix"
    );
  }
}

/**
 * Pure recovery policy. In particular, `exact_empty` is useful only when a
 * structured pre-key receipt proves the original Enter was never attempted.
 * A legacy error string or a missing Enter timestamp is not that proof.
 */
export function decideTerminalSubmissionRetry(
  facts: TerminalSubmissionRetryFacts
): TerminalSubmissionRetryDecision {
  if (!facts.exactTurnTarget) {
    return { action: "refuse", reason: "submission retry requires one exact Turn id" };
  }
  if (facts.agent !== "codex") {
    return { action: "refuse", reason: "submission retry is supported only for Codex" };
  }
  if (facts.accepted) {
    return { action: "repair_accepted" };
  }

  const attempt = facts.attempt;
  if (attempt) {
    if (["enter_reserved", "enter_dispatched", "agent_accepted"]
      .includes(attempt.state)) {
      return {
        action: "refuse",
        reason: "a durable retry Enter reservation already exists; another key dispatch is forbidden"
      };
    }
    if (
      facts.composer === "exact_draft" &&
      (
        attempt.mode === "exact_draft_enter" ||
        ["replacement_text_reserved", "replacement_text_injected"]
          .includes(attempt.state)
      )
    ) {
      return {
        action: "submit_exact_draft",
        activeMessageId: attempt.active_message_id
      };
    }
    if (
      facts.composer === "exact_empty" &&
      attempt.mode === "replacement_send" &&
      attempt.state === "replacement_reserved" &&
      facts.currentMessageId === attempt.original_message_id
    ) {
      return {
        action: "resume_replacement",
        activeMessageId: attempt.active_message_id
      };
    }
    return {
      action: "refuse",
      reason: `retry attempt ${attempt.attempt_id} is ${attempt.state} and the composer is ${facts.composer}`
    };
  }

  const recoverableOriginal =
    facts.submissionStatus === "uncertain" &&
    facts.lastProvenStage === "text_injected" &&
    Boolean(facts.submissionTextInjectedAt) &&
    facts.submissionTextInjectedAt === facts.ledgerTextInjectedAt &&
    facts.ledgerStatus === "uncertain" &&
    !facts.enterDispatchedAt &&
    !facts.ledgerEnterDispatchedAt &&
    !facts.ledgerAgentAcceptedAt &&
    Boolean(facts.originalMessageId) &&
    facts.currentMessageId === facts.originalMessageId;
  if (!recoverableOriginal) {
    return {
      action: "refuse",
      reason: "the Turn has no exact text-injected submission generation eligible for recovery"
    };
  }
  if (facts.composer === "exact_draft") {
    return {
      action: "submit_exact_draft",
      activeMessageId: facts.originalMessageId as string
    };
  }
  if (
    facts.composer === "exact_empty" &&
    facts.enterNotAttemptedReason === "pre_key_failure" &&
    facts.ledgerEnterNotAttemptedReason === "pre_key_failure" &&
    Boolean(facts.enterNotAttemptedAt) &&
    facts.enterNotAttemptedAt === facts.ledgerEnterNotAttemptedAt
  ) {
    return { action: "start_replacement" };
  }
  return {
    action: "refuse",
    reason: facts.composer === "exact_empty"
      ? "the composer is empty, but no structured pre-key proof shows that the original Enter was never attempted"
      : `the Codex composer is ${facts.composer}; no terminal input is authorized`
  };
}

export function terminalSubmissionRetryPath(statePath: string): string {
  return path.join(path.dirname(path.resolve(statePath)),
    TERMINAL_SUBMISSION_RETRY_FILE);
}

export function loadTerminalSubmissionRetry(
  statePath: string
): TerminalSubmissionRetryRecord | undefined {
  const filePath = terminalSubmissionRetryPath(statePath);
  try {
    return validateTerminalSubmissionRetry(
      readJsonFileNoFollow(filePath, "terminal submission retry"),
      statePath
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function saveTerminalSubmissionRetry(
  statePath: string,
  candidate: TerminalSubmissionRetryRecord,
  expectedRevision: number | null
): TerminalSubmissionRetryRecord {
  const canonicalStatePath = path.resolve(statePath);
  const current = loadTerminalSubmissionRetry(canonicalStatePath);
  if (
    expectedRevision === null
      ? current !== undefined
      : !current || current.revision !== expectedRevision
  ) {
    throw new Error("terminal submission retry changed before its CAS write");
  }
  const next = validateTerminalSubmissionRetry({
    ...candidate,
    revision: expectedRevision === null ? 1 : expectedRevision + 1,
    state_path: canonicalStatePath
  }, canonicalStatePath);
  if (current) assertTerminalSubmissionRetryAdvance(current, next);
  const filePath = terminalSubmissionRetryPath(canonicalStatePath);
  atomicSaveJsonFile(filePath, next, {
    rootLabel: "conversation Store",
    directoryLabel: "conversation directory",
    fileLabel: "terminal submission retry",
    ensureDirectory: ensureDir
  });
  return next;
}

export function terminalSubmissionRetryLedgerFields(
  attempt: TerminalSubmissionRetryRecord | undefined
): Record<string, unknown> {
  return attempt
    ? {
        submission_retry_attempt_id: attempt.attempt_id,
        submission_retry_mode: attempt.mode,
        submission_retry_state: attempt.state,
        submission_retry_revision: attempt.revision,
        submission_retry_original_message_id: attempt.original_message_id,
        submission_retry_active_message_id: attempt.active_message_id,
        submission_retry_reserved_at: attempt.reserved_at,
        ...(attempt.replacement_text_reserved_at
          ? {
              submission_retry_replacement_text_reserved_at:
                attempt.replacement_text_reserved_at
            }
          : {}),
        ...(attempt.replacement_text_injected_at
          ? {
              submission_retry_replacement_text_injected_at:
                attempt.replacement_text_injected_at
            }
          : {}),
        ...(attempt.enter_reserved_at
          ? { submission_retry_enter_reserved_at: attempt.enter_reserved_at }
          : {}),
        ...(attempt.enter_dispatched_at
          ? { submission_retry_enter_dispatched_at: attempt.enter_dispatched_at }
          : {})
      }
    : {};
}

const TERMINAL_SUBMISSION_RETRY_LEDGER_PREFIX_KEYS = [
  "submission_retry_attempt_id",
  "submission_retry_mode",
  "submission_retry_state",
  "submission_retry_revision",
  "submission_retry_original_message_id",
  "submission_retry_active_message_id",
  "submission_retry_reserved_at",
  "submission_retry_replacement_text_reserved_at",
  "submission_retry_replacement_text_injected_at",
  "submission_retry_enter_reserved_at",
  "submission_retry_enter_dispatched_at"
] as const;

export function terminalSubmissionRetryLedgerPrefix(
  attempt: TerminalSubmissionRetryRecord,
  ledger: Record<string, unknown>
): "current" | "previous" | "missing_initial" {
  const matches = (expected: Record<string, unknown>): boolean =>
    TERMINAL_SUBMISSION_RETRY_LEDGER_PREFIX_KEYS.every(
      (key) => ledger[key] === expected[key]
    );
  if (matches(terminalSubmissionRetryLedgerFields(attempt))) return "current";
  if (
    attempt.revision === 1 &&
    TERMINAL_SUBMISSION_RETRY_LEDGER_PREFIX_KEYS.every(
      (key) => ledger[key] === undefined
    ) &&
    (
      attempt.mode === "replacement_send" &&
        attempt.state === "replacement_reserved" ||
      attempt.mode === "exact_draft_enter" &&
        attempt.state === "enter_reserved"
    )
  ) {
    return "missing_initial";
  }
  const previousState = terminalSubmissionRetryPreviousState(attempt);
  const previous = terminalSubmissionRetryLedgerFieldsForState(
    attempt,
    previousState,
    attempt.revision - 1
  );
  if (attempt.revision > 1 && matches(previous)) return "previous";
  throw new Error(
    "submission retry ledger is not an exact current or one-write-lagging prefix"
  );
}

function terminalSubmissionRetryPreviousState(
  attempt: TerminalSubmissionRetryRecord
): TerminalSubmissionRetryRecord["state"] {
  if (attempt.state === "enter_dispatched") return "enter_reserved";
  if (attempt.state !== "agent_accepted") {
    throw new Error("submission retry attempt has no accepted predecessor");
  }
  if (attempt.enter_dispatched_at) return "enter_dispatched";
  if (attempt.enter_reserved_at) return "enter_reserved";
  if (attempt.replacement_text_injected_at) {
    return "replacement_text_injected";
  }
  if (attempt.replacement_text_reserved_at) {
    return "replacement_text_reserved";
  }
  if (attempt.mode === "replacement_send") return "replacement_reserved";
  throw new Error("accepted exact-draft retry lacks its durable Enter prefix");
}

function terminalSubmissionRetryLedgerFieldsForState(
  attempt: TerminalSubmissionRetryRecord,
  state: TerminalSubmissionRetryRecord["state"],
  revision: number
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    ...terminalSubmissionRetryLedgerFields(attempt),
    submission_retry_state: state,
    submission_retry_revision: revision
  };
  const rank: Record<TerminalSubmissionRetryRecord["state"], number> = {
    replacement_reserved: 0,
    replacement_text_reserved: 1,
    replacement_text_injected: 2,
    enter_reserved: 3,
    enter_dispatched: 4,
    agent_accepted: 5
  };
  if (rank[state] < rank.replacement_text_reserved) {
    delete fields.submission_retry_replacement_text_reserved_at;
  }
  if (rank[state] < rank.replacement_text_injected) {
    delete fields.submission_retry_replacement_text_injected_at;
  }
  if (rank[state] < rank.enter_reserved) {
    delete fields.submission_retry_enter_reserved_at;
  }
  if (rank[state] < rank.enter_dispatched) {
    delete fields.submission_retry_enter_dispatched_at;
  }
  return fields;
}

export type TerminalSubmissionRetryStartupDecision =
  | { action: "promote_pending" }
  | { action: "finalize_accepted" }
  | {
      action: "repair_terminal_ledger";
      outcome: "not_accepted" | "uncertain";
      at: string;
      reason?: string;
    }
  | {
      action: "repair_terminal_state";
      outcome: "uncertain";
      at: string;
      reason?: string;
    }
  | { action: "no_change"; reason: string }
  | { action: "refuse"; reason: string };

export function decideTerminalSubmissionRetryStartup(input: {
  attempt: TerminalSubmissionRetryRecord;
  submission: Record<string, unknown>;
  ledger: Record<string, unknown>;
}): TerminalSubmissionRetryStartupDecision {
  let prefix: ReturnType<typeof terminalSubmissionRetryLedgerPrefix>;
  try {
    prefix = terminalSubmissionRetryLedgerPrefix(input.attempt, input.ledger);
  } catch (error) {
    return {
      action: "refuse",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const stateAccepted = input.submission.status === "agent_accepted";
  const ledgerAccepted = input.ledger.status === "agent_accepted";
  const accepted = stateAccepted || ledgerAccepted ||
    input.attempt.state === "agent_accepted";
  const stateNotAcceptedStatus = input.submission.status === "not_accepted";
  const ledgerNotAcceptedStatus = input.ledger.status === "not_accepted";
  const stateNotAccepted = terminalOutcomeTimestamp(
    input.submission,
    "not_accepted",
    "not_accepted_at"
  );
  const ledgerNotAccepted = terminalOutcomeTimestamp(
    input.ledger,
    "not_accepted",
    "not_accepted_at"
  );
  const stateUncertain = postRetryUncertainTimestamp(
    input.submission,
    input.attempt.enter_dispatched_at
  );
  const ledgerUncertain = postRetryUncertainTimestamp(
    input.ledger,
    input.attempt.enter_dispatched_at
  );
  if (
    stateNotAcceptedStatus !== Boolean(stateNotAccepted) ||
    ledgerNotAcceptedStatus !== Boolean(ledgerNotAccepted)
  ) {
    return {
      action: "refuse",
      reason: "not-accepted submission retry lacks its exact terminal timestamp"
    };
  }
  if (
    accepted &&
    (
      stateNotAcceptedStatus || ledgerNotAcceptedStatus ||
      stateUncertain || ledgerUncertain
    )
  ) {
    return {
      action: "refuse",
      reason: "accepted submission retry conflicts with a terminal negative outcome"
    };
  }
  if (accepted) {
    return { action: "finalize_accepted" };
  }
  if (
    (stateNotAccepted || ledgerNotAccepted) &&
    (stateUncertain || ledgerUncertain)
  ) {
    return {
      action: "refuse",
      reason: "submission retry terminal outcomes conflict"
    };
  }
  if (stateNotAccepted || ledgerNotAccepted) {
    if (
      stateNotAccepted && ledgerNotAccepted &&
      stateNotAccepted === ledgerNotAccepted
    ) {
      return { action: "no_change", reason: "not_accepted_is_durable" };
    }
    if (
      stateNotAccepted && !ledgerNotAccepted &&
      input.ledger.status === "enter_dispatched" && prefix === "current"
    ) {
      return {
        action: "repair_terminal_ledger",
        outcome: "not_accepted",
        at: stateNotAccepted
      };
    }
    return {
      action: "refuse",
      reason: "not-accepted submission retry is not an exact state-first ledger lag"
    };
  }
  if (stateUncertain || ledgerUncertain) {
    if (
      stateUncertain && ledgerUncertain && stateUncertain === ledgerUncertain
    ) {
      return { action: "no_change", reason: "uncertain_is_durable" };
    }
    if (
      stateUncertain && !ledgerUncertain &&
      input.ledger.status === "enter_dispatched" && prefix === "current"
    ) {
      return {
        action: "repair_terminal_ledger",
        outcome: "uncertain",
        at: stateUncertain,
        reason: nonBlankString(input.submission.error)
      };
    }
    if (
      ledgerUncertain && !stateUncertain &&
      input.submission.status === "enter_dispatched" && prefix === "current"
    ) {
      return {
        action: "repair_terminal_state",
        outcome: "uncertain",
        at: ledgerUncertain,
        reason: nonBlankString(input.ledger.error)
      };
    }
    return {
      action: "refuse",
      reason: "uncertain submission retry is not an exact state-first ledger lag"
    };
  }
  if (
    input.attempt.state === "enter_dispatched" && prefix === "previous"
  ) {
    return { action: "promote_pending" };
  }
  return {
    action: "no_change",
    reason: prefix === "current"
      ? "retry_prefix_is_already_current"
      : "initial_retry_prefix_requires_explicit_recovery"
  };
}

function terminalOutcomeTimestamp(
  record: Record<string, unknown>,
  status: string,
  timestampField: string
): string | undefined {
  return record.status === status
    ? nonBlankString(record[timestampField])
    : undefined;
}

function postRetryUncertainTimestamp(
  record: Record<string, unknown>,
  enterDispatchedAt: string | undefined
): string | undefined {
  const uncertainAt = terminalOutcomeTimestamp(
    record,
    "uncertain",
    "uncertain_at"
  );
  if (!uncertainAt || !enterDispatchedAt) return undefined;
  return Date.parse(uncertainAt) >= Date.parse(enterDispatchedAt)
    ? uncertainAt
    : undefined;
}

function validateTerminalSubmissionRetry(
  value: unknown,
  expectedStatePath: string
): TerminalSubmissionRetryRecord {
  if (!isRecord(value)) {
    throw new Error("terminal submission retry is malformed");
  }
  const requiredStrings = [
    "attempt_id", "mode", "state", "store_dir", "state_path", "session_id",
    "turn_id", "original_message_id", "active_message_id", "request_hash",
    "terminal_target", "reserved_at", "updated_at"
  ] as const;
  if (
    value.schema !== TERMINAL_SUBMISSION_RETRY_SCHEMA ||
    value.version !== TERMINAL_SUBMISSION_RETRY_VERSION ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    requiredStrings.some((field) => !nonBlankString(value[field])) ||
    !["exact_draft_enter", "replacement_send"].includes(String(value.mode)) ||
    ![
      "replacement_reserved", "replacement_text_reserved",
      "replacement_text_injected", "enter_reserved", "enter_dispatched",
      "agent_accepted"
    ].includes(String(value.state)) ||
    path.resolve(String(value.state_path)) !== path.resolve(expectedStatePath) ||
    !path.isAbsolute(String(value.store_dir)) ||
    !/^[0-9a-f]{64}$/u.test(String(value.request_hash)) ||
    ![null, undefined].includes(value.callback_route_fingerprint as null | undefined) &&
      !nonBlankString(value.callback_route_fingerprint) ||
    ![null, undefined].includes(value.deferred_foreground_transfer_id as null | undefined) &&
      !nonBlankString(value.deferred_foreground_transfer_id)
  ) {
    throw new Error("terminal submission retry is malformed");
  }
  const canonicalStatePath = path.resolve(String(value.state_path));
  const canonicalPaths = pathsForConversationDir(
    path.dirname(canonicalStatePath)
  );
  if (
    path.resolve(canonicalPaths.statePath) !== canonicalStatePath ||
    path.resolve(canonicalPaths.storeDir) !== path.resolve(String(value.store_dir)) ||
    path.basename(canonicalPaths.conversationDir) !== String(value.turn_id)
  ) {
    throw new Error(
      "terminal submission retry is outside its canonical Turn Store path"
    );
  }
  for (const field of [
    "reserved_at", "updated_at", "replacement_text_reserved_at",
    "replacement_text_injected_at", "enter_reserved_at",
    "enter_dispatched_at", "agent_accepted_at"
  ] as const) {
    if (value[field] !== undefined && !Number.isFinite(Date.parse(String(value[field])))) {
      throw new Error(`terminal submission retry ${field} is malformed`);
    }
  }
  assertModeStateShape(value as unknown as TerminalSubmissionRetryRecord);
  return value as unknown as TerminalSubmissionRetryRecord;
}

function assertModeStateShape(record: TerminalSubmissionRetryRecord): void {
  const rank: Record<TerminalSubmissionRetryState, number> = {
    replacement_reserved: 0,
    replacement_text_reserved: 1,
    replacement_text_injected: 2,
    enter_reserved: 3,
    enter_dispatched: 4,
    agent_accepted: 5
  };
  const accepted = record.state === "agent_accepted";
  if (record.mode === "exact_draft_enter") {
    if (
      record.active_message_id !== record.original_message_id ||
      rank[record.state] < rank.enter_reserved ||
      !record.enter_reserved_at ||
      record.replacement_text_reserved_at !== undefined ||
      record.replacement_text_injected_at !== undefined ||
      (!accepted && !timestampMatchesRank(
        record.enter_dispatched_at,
        rank[record.state] >= rank.enter_dispatched
      ))
    ) {
      throw new Error("terminal submission retry exact-draft state is malformed");
    }
  } else {
    const replacementPrefix = [
      record.replacement_text_reserved_at,
      record.replacement_text_injected_at,
      record.enter_reserved_at,
      record.enter_dispatched_at
    ];
    const prefixIsContiguous = replacementPrefix.every(
      (timestamp, index) => timestamp !== undefined ||
        replacementPrefix.slice(index + 1).every((later) => later === undefined)
    );
    if (
      record.active_message_id !== record.original_message_id ||
      (accepted
        ? !prefixIsContiguous
        : !timestampMatchesRank(
            record.replacement_text_reserved_at,
            rank[record.state] >= rank.replacement_text_reserved
          ) ||
          !timestampMatchesRank(
            record.replacement_text_injected_at,
            rank[record.state] >= rank.replacement_text_injected
          ) ||
          !timestampMatchesRank(
            record.enter_reserved_at,
            rank[record.state] >= rank.enter_reserved
          ) ||
          !timestampMatchesRank(
            record.enter_dispatched_at,
            rank[record.state] >= rank.enter_dispatched
          ))
    ) {
      throw new Error("terminal submission retry replacement state is malformed");
    }
  }
  if (!accepted && !timestampMatchesRank(
    record.enter_dispatched_at,
    rank[record.state] >= rank.enter_dispatched
  )) {
    throw new Error("terminal submission retry Enter state is malformed");
  }
  if (!timestampMatchesRank(
    record.agent_accepted_at,
    record.state === "agent_accepted"
  )) {
    throw new Error("terminal submission retry acceptance state is malformed");
  }
  const ordered = record.mode === "replacement_send"
    ? [
        record.reserved_at,
        record.replacement_text_reserved_at,
        record.replacement_text_injected_at,
        record.enter_reserved_at,
        record.enter_dispatched_at,
        record.agent_accepted_at
      ]
    : [
        record.reserved_at,
        record.enter_reserved_at,
        record.enter_dispatched_at,
        record.agent_accepted_at
      ];
  let previous = Number.NEGATIVE_INFINITY;
  for (const timestamp of ordered) {
    if (!timestamp) continue;
    const current = Date.parse(timestamp);
    if (current < previous) {
      throw new Error("terminal submission retry timestamps are out of order");
    }
    previous = current;
  }
}

function timestampMatchesRank(
  timestamp: string | undefined,
  required: boolean
): boolean {
  return required ? timestamp !== undefined : timestamp === undefined;
}

function assertTerminalSubmissionRetryAdvance(
  current: TerminalSubmissionRetryRecord,
  next: TerminalSubmissionRetryRecord
): void {
  for (const field of [
    "schema", "version", "attempt_id", "mode", "store_dir", "state_path",
    "session_id", "turn_id", "original_message_id", "active_message_id",
    "request_hash", "terminal_target", "callback_route_fingerprint",
    "deferred_foreground_transfer_id", "reserved_at"
  ] as const) {
    if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
      throw new Error(`terminal submission retry cannot change ${field}`);
    }
  }
  const rank: Record<TerminalSubmissionRetryState, number> = {
    replacement_reserved: 0,
    replacement_text_reserved: 1,
    replacement_text_injected: 2,
    enter_reserved: 3,
    enter_dispatched: 4,
    agent_accepted: 5
  };
  if (rank[next.state] < rank[current.state]) {
    throw new Error("terminal submission retry state cannot regress");
  }
  if (
    next.state !== "agent_accepted" &&
    rank[next.state] > rank[current.state] + 1
  ) {
    throw new Error("terminal submission retry state cannot skip a transport boundary");
  }
  if (current.mode === "exact_draft_enter" &&
      next.state.startsWith("replacement_")) {
    throw new Error("exact-draft retry cannot become a replacement send");
  }
  for (const field of [
    "replacement_text_reserved_at", "replacement_text_injected_at", "enter_reserved_at",
    "enter_dispatched_at", "agent_accepted_at"
  ] as const) {
    if (current[field] !== undefined && current[field] !== next[field]) {
      throw new Error(`terminal submission retry cannot change ${field}`);
    }
  }
}
