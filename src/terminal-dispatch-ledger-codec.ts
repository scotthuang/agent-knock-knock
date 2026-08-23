import path from "node:path";
import {
  hasCanonicalTerminalEndpoint,
  sameTerminalControlEvidenceIncarnation,
  sameTerminalEndpointIdentity,
  terminalControlEvidence,
  terminalEndpointIdentityFromEvidence,
  type TerminalControlRef
} from "./terminal-control-ref.js";
import type {
  ManagedTerminalBinding,
  NativeThreadTransition
} from "./managed-session.js";
import type { TerminalSubmissionAcceptanceEvidence } from
  "./terminal-submission-facts.js";
import { canonicalJson } from "./canonical-json.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

export type TerminalDispatchLedgerDocument = Record<string, unknown>;
export type TerminalDispatchReceipt = Record<string, unknown>;

export function sameCanonicalStatePath(left: unknown, right: unknown): boolean {
  const leftPath = stringValue(left);
  const rightPath = stringValue(right);
  return Boolean(
    leftPath && rightPath && path.resolve(leftPath) === path.resolve(rightPath)
  );
}

export type TerminalOrdinaryDispatchStatus =
  "prepared" | "text_injected" | "enter_dispatched" |
  "agent_accepted" | "not_accepted" |
  // Legacy submitted proves only that the terminal accepted Enter dispatch.
  "submitted" | "uncertain" | "aborted";

export type TerminalOrdinaryDispatchIdentityFields = Record<
  "generation_id" | "conversation_id" | "session_id" | "turn_id" |
    "message_id" | "request_hash" | "prepared_at",
  string
> & { status: TerminalOrdinaryDispatchStatus; message_type: "task" | "answer" };

export interface TerminalOrdinaryDispatchPhaseFields {
  text_injected_at?: string;
  enter_dispatched_at?: string;
  enter_not_attempted_at?: string;
  enter_not_attempted_reason?: "pre_key_failure";
  agent_accepted_at?: string;
  acceptance_evidence?: TerminalSubmissionAcceptanceEvidence;
  not_accepted_at?: string;
  uncertain_at?: string;
  error?: { length: number; preview?: string };
}

export type TerminalOrdinaryDispatchPostCallbackFields =
  Pick<TerminalOrdinaryDispatchPhaseFields, "error"> &
  { native_identity_status?: "unresolved_after_submit" };

export interface ConstructTerminalOrdinaryDispatchLedgerOptions {
  bindingFields: TerminalDispatchLedgerDocument;
  identityFields: TerminalOrdinaryDispatchIdentityFields;
  phaseFields?: TerminalOrdinaryDispatchPhaseFields;
  dispatcherPid: number | null;
  statePath: string;
  eventLogPath: string;
  callbackExpected: boolean;
  callbackRouteFingerprint?: string | null;
  postCallbackFields?: TerminalOrdinaryDispatchPostCallbackFields;
  previousGenerationId?: string;
}

/** Order one ordinary dispatch write without performing persistence. */
export const constructTerminalOrdinaryDispatchLedger = (
  options: ConstructTerminalOrdinaryDispatchLedgerOptions
): TerminalDispatchLedgerDocument => ({
  ...options.bindingFields,
  ...options.identityFields,
  ...(options.phaseFields ?? {}),
  dispatcher_pid: options.dispatcherPid,
  state_path: options.statePath,
  event_log_path: options.eventLogPath,
  callback_expected: options.callbackExpected,
  ...(options.callbackRouteFingerprint !== undefined
    ? { callback_route_fingerprint: options.callbackRouteFingerprint }
    : {}),
  ...(options.postCallbackFields ?? {}),
  previous_generation_id: options.previousGenerationId
});

const LIFECYCLE_IDENTITY_KEYS = ["kind", "generation_id", "transition_id"] as const;
const LIFECYCLE_TERMINAL_KEYS = [
  "terminal_id", "agent", "workspace", "adapter_version", "command_fingerprint"
] as const;
const LIFECYCLE_TARGET_KEYS = [
  "source_session_id", "target_session_id", "target_native_thread_id",
  "target_candidate_file_identity"
] as const;
const LIFECYCLE_BEFORE_KEYS = [
  "before_native_thread_id", "before_process_uuid", "before_process_started_at",
  "before_process_birth", "before_process_rollout"
] as const;
const LIFECYCLE_BASE_KEYS = [
  ...LIFECYCLE_IDENTITY_KEYS, "operation", "origin", "terminal_input_sent",
  ...LIFECYCLE_TERMINAL_KEYS, ...LIFECYCLE_TARGET_KEYS, "native_thread_id",
  ...LIFECYCLE_BEFORE_KEYS, "store_dir", "prepared_at", "dispatching_at",
  "submitted_at", "verified_at", "dispatcher_pid", "binding"
] as const;

const lifecycleFields = (
  transition: NativeThreadTransition, storeDir: string, keys: readonly string[]
): TerminalDispatchLedgerDocument => {
  const values: TerminalDispatchLedgerDocument = {
    ...transition,
    kind: "lifecycle",
    generation_id: transition.transition_id,
    transition_id: transition.transition_id,
    native_thread_id: transition.after_binding?.native_thread_id ??
      transition.before_native_thread_id,
    store_dir: storeDir,
    binding: transition.before_binding
  };
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
};

type LifecycleLedgerError = NonNullable<TerminalOrdinaryDispatchPhaseFields["error"]>;
type LifecycleBinding = ManagedTerminalBinding | undefined;
type PreviousLifecycleLedger = TerminalDispatchLedgerDocument | undefined;
const previousLifecycleGenerationId = (ledger: PreviousLifecycleLedger): string | undefined =>
  stringValue(ledger?.generation_id) ?? stringValue(ledger?.message_id);
export type NativeThreadLifecycleLedgerPhase =
  | { phase: "prepared"; previous: PreviousLifecycleLedger; targetNativeThreadId: string }
  | { phase: "verified"; binding: LifecycleBinding }
  | { phase: "verified_with_previous"; binding: LifecycleBinding; previousGenerationId?: string }
  | { phase: "resolved" | "uncertain"; at: string; reason: string }
  | { phase: "resolved_with_binding"; at: string; binding: LifecycleBinding; reason: string }
  | { phase: "uncertain_reason_error"; at: string; reason: string; error: LifecycleLedgerError }
  | { phase: "uncertain_error_reason"; at: string; error: LifecycleLedgerError; reason: string }
  | { phase: "rebuild"; control: TerminalControlRef; previous: PreviousLifecycleLedger }
  | { phase: "command_prepared" | "command_dispatching" | "command_submitted";
      previous: PreviousLifecycleLedger }
  | { phase: "command_resolved"; at: string; binding: ManagedTerminalBinding; reason: string };

function lifecycleCommandLedger(
  transition: NativeThreadTransition,
  storeDir: string,
  phase: Extract<NativeThreadLifecycleLedgerPhase, { phase: `command_${string}` }>
): TerminalDispatchLedgerDocument {
  const status = phase.phase.slice("command_".length);
  if (phase.phase === "command_resolved") {
    const keys = [
      ...LIFECYCLE_IDENTITY_KEYS, ...LIFECYCLE_TERMINAL_KEYS, "operation",
      ...LIFECYCLE_TARGET_KEYS, "store_dir", "prepared_at", "submitted_at", "verified_at"
    ] as const;
    return Object.assign({ status }, lifecycleFields(transition, storeDir, keys), {
      target_native_thread_id: phase.binding.native_thread_id,
      resolved_at: phase.at, dispatcher_pid: transition.dispatcher_pid,
      binding: phase.binding, reason: phase.reason
    });
  }
  const keys = phase.phase === "command_prepared"
    ? [
        ...LIFECYCLE_IDENTITY_KEYS, "operation", ...LIFECYCLE_TERMINAL_KEYS,
        ...LIFECYCLE_TARGET_KEYS, ...LIFECYCLE_BEFORE_KEYS, "store_dir", "prepared_at",
        "dispatcher_pid", "binding"
      ] as const
    : [
        ...LIFECYCLE_IDENTITY_KEYS, ...LIFECYCLE_TERMINAL_KEYS, "operation",
        ...LIFECYCLE_TARGET_KEYS, ...LIFECYCLE_BEFORE_KEYS, "store_dir", "prepared_at",
        `${status}_at`, "dispatcher_pid", "binding"
      ] as const;
  return Object.assign({ status }, lifecycleFields(transition, storeDir, keys), {
    previous_generation_id: previousLifecycleGenerationId(phase.previous)
  });
}

/** Pure phase builder; persistence and lifecycle CAS remain with the caller. */
export function nativeThreadLifecycleLedger(
  transition: NativeThreadTransition,
  storeDir: string,
  phase: NativeThreadLifecycleLedgerPhase
): TerminalDispatchLedgerDocument {
  const base = lifecycleFields(transition, storeDir, LIFECYCLE_BASE_KEYS);
  const append = (...entries: ReadonlyArray<readonly [string, unknown]>) =>
    Object.assign({ ...base }, Object.fromEntries(entries));
  switch (phase.phase) {
    case "prepared":
      return append(
        ["status", "prepared"], ["target_native_thread_id", phase.targetNativeThreadId],
        ["previous_generation_id", previousLifecycleGenerationId(phase.previous)]
      );
    case "verified":
      return append(["status", "verified"], ["binding", phase.binding]);
    case "verified_with_previous":
      return append(["status", "verified"], ["binding", phase.binding],
        ["previous_generation_id", phase.previousGenerationId]);
    case "resolved":
    case "uncertain":
      return append(["status", phase.phase], [`${phase.phase}_at`, phase.at],
        ["reason", phase.reason]);
    case "resolved_with_binding":
      return append(["status", "resolved"], ["resolved_at", phase.at],
        ["binding", phase.binding], ["reason", phase.reason]);
    case "uncertain_reason_error":
      return append(["status", "uncertain"], ["uncertain_at", phase.at],
        ["reason", phase.reason], ["error", phase.error]);
    case "uncertain_error_reason":
      return append(["status", "uncertain"], ["uncertain_at", phase.at],
        ["error", phase.error], ["reason", phase.reason]);
    case "rebuild":
      return append(
        ["status", transition.status], ["binding", transition.before_binding],
        ["terminal_control", {
          kind: phase.control.kind,
          target: phase.control.target,
          socket_path: phase.control.socketPath ?? null,
          pane_pid: phase.control.panePid ?? null,
          current_path: phase.control.currentPath ?? null
        }],
        ...(hasCanonicalTerminalEndpoint(phase.control)
          ? [["terminal_endpoint", terminalControlEvidence(phase.control)]] as const
          : []),
        ["previous_generation_id", previousLifecycleGenerationId(phase.previous)]
      );
    default:
      return lifecycleCommandLedger(transition, storeDir, phase);
  }
}

const RECEIPT_STATUSES = new Set([
  "text_injected",
  "enter_dispatched",
  "submitted",
  "agent_accepted",
  "not_accepted",
  "uncertain",
  "aborted"
]);

const RECEIPT_IMMUTABLE_FIELDS = [
  "binding_id",
  "binding_generation",
  "native_thread_id",
  "store_dir",
  "conversation_id",
  "session_id",
  "turn_id",
  "message_id",
  "message_type",
  "message_body_hash",
  "request_hash",
  "executor_kind",
  "openclaw_session",
  "callback_route_fingerprint",
  "state_path",
  "event_log_path",
  "deferred_foreground_transfer_id"
] as const;

export interface DecodeTerminalDispatchLedgerOptions {
  ledgerPath: string;
  terminalControl: TerminalControlRef;
  legacyTerminalKey: string;
  canonicalTerminalKey: string;
}

/** Parse and validate one already-read ledger document without performing I/O. */
export function decodeTerminalDispatchLedgerDocument(
  source: string,
  options: DecodeTerminalDispatchLedgerOptions
): TerminalDispatchLedgerDocument {
  // Keep JSON.parse here (rather than wrapping it) so native parse errors remain
  // byte-for-byte compatible with the former in-line reader.
  const parsed: unknown = JSON.parse(source);
  if (
    !isRecord(parsed) ||
    !(parsed.version === 1 || parsed.version === 2)
  ) {
    throw invalidLedger(options.ledgerPath);
  }
  if (parsed.version === 1) {
    const control = isRecord(parsed.terminal_control)
      ? parsed.terminal_control
      : undefined;
    if (
      stringValue(parsed.terminal_key) !== options.legacyTerminalKey ||
      stringValue(control?.target) !== options.terminalControl.target ||
      (stringValue(control?.socket_path) ?? undefined) !==
        options.terminalControl.socketPath
    ) {
      throw invalidLedger(options.ledgerPath);
    }
  } else {
    const identity = terminalEndpointIdentityFromEvidence(
      parsed.terminal_endpoint
    );
    if (
      !identity ||
      stringValue(parsed.terminal_key) !== options.canonicalTerminalKey ||
      !sameTerminalEndpointIdentity(identity, options.terminalControl)
    ) {
      throw invalidLedger(options.ledgerPath);
    }
  }
  return parsed;
}

export function terminalDispatchLedgerLooksLifecycle(
  ledger: TerminalDispatchLedgerDocument | undefined
): boolean {
  return Boolean(
    ledger &&
    (
      ledger.kind === "lifecycle" ||
      ledger.transition_id !== undefined ||
      ledger.operation === "new_thread" ||
      ledger.operation === "resume_thread" ||
      ledger.operation === "adopt_external_thread" ||
      ledger.adapter_version !== undefined ||
      ledger.command_fingerprint !== undefined ||
      ledger.target_session_id !== undefined ||
      ledger.before_native_thread_id !== undefined ||
      ledger.before_process_uuid !== undefined ||
      ledger.before_process_started_at !== undefined ||
      ledger.before_process_birth !== undefined ||
      ledger.before_process_rollout !== undefined
    )
  );
}

export function terminalDispatchReceiptHistory(
  ledger: TerminalDispatchLedgerDocument | undefined
): TerminalDispatchReceipt[] {
  const receipts = validatedStoredTerminalDispatchReceiptHistory(ledger);
  if (!ledger) {
    return receipts;
  }
  const current = terminalDispatchReceiptCandidate(ledger);
  const currentId = stringValue(current?.message_id);
  if (!current || !currentId) {
    return receipts;
  }
  const previous = receipts.find((receipt) =>
    stringValue(receipt.message_id) === currentId
  );
  if (!previous) {
    return [...receipts, current];
  }
  // A resolved top-level ledger may already point at a replacement terminal
  // incarnation. Resolution cannot strengthen or rebind historical proof.
  if (ledger.status === "resolved") {
    return receipts;
  }
  const merged = mergeTerminalDispatchReceipt(previous, current);
  return receipts.map((receipt) =>
    stringValue(receipt.message_id) === currentId ? merged : receipt
  );
}

function validatedStoredTerminalDispatchReceiptHistory(
  ledger: TerminalDispatchLedgerDocument | undefined
): TerminalDispatchReceipt[] {
  if (!ledger) {
    return [];
  }
  const value = ledger.terminal_submission_receipts;
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error("terminal dispatch receipt history is malformed");
  }
  const receipts = (Array.isArray(value) ? value : []).map((receipt) => {
    if (!isRecord(receipt) || !stringValue(receipt.message_id)) {
      throw new Error("terminal dispatch receipt history is malformed");
    }
    return receipt;
  });
  const ids = new Set<string>();
  for (const receipt of receipts) {
    const id = String(receipt.message_id);
    if (ids.has(id)) {
      throw new Error(`terminal dispatch receipt ${id} is duplicated`);
    }
    ids.add(id);
  }
  return receipts;
}

export function terminalDispatchReceiptCandidate(
  ledger: TerminalDispatchLedgerDocument
): TerminalDispatchReceipt | undefined {
  const storedStatus = String(ledger.status);
  const receiptStatus = RECEIPT_STATUSES.has(storedStatus)
    ? storedStatus
    : storedStatus === "resolved" && ledger.agent_accepted_at
      ? "agent_accepted"
      : storedStatus === "resolved" && ledger.uncertain_at
        ? "uncertain"
        : storedStatus === "resolved" && ledger.not_accepted_at
          ? "not_accepted"
          : storedStatus === "resolved" && ledger.aborted_at
            ? "aborted"
            : storedStatus === "resolved" && ledger.enter_dispatched_at
              ? "enter_dispatched"
              : storedStatus === "resolved" && ledger.submitted_at
                ? "submitted"
                : undefined;
  if (
    terminalDispatchLedgerLooksLifecycle(ledger) ||
    !receiptStatus ||
    !stringValue(ledger.message_id)
  ) {
    return undefined;
  }
  const {
    terminal_submission_receipts: _history,
    terminal_key: _terminalKey,
    version: _version,
    ...receipt
  } = ledger;
  return { ...receipt, status: receiptStatus };
}

export function mergeTerminalDispatchReceipt(
  previous: TerminalDispatchReceipt,
  next: TerminalDispatchReceipt
): TerminalDispatchReceipt {
  const messageId = required(
    stringValue(previous.message_id),
    "terminal dispatch receipt message id is required"
  );
  const safeAbortRetryGeneration = Boolean(
    previous.status === "aborted" &&
    previous.safe_to_retry === true &&
    stringValue(next.message_id) === messageId &&
    stringValue(next.previous_generation_id) === messageId &&
    [
      "text_injected",
      "enter_dispatched",
      "submitted",
      "agent_accepted",
      "not_accepted",
      "uncertain",
      "aborted"
    ].includes(String(next.status)) &&
    validTimestampMs(previous.aborted_at) !== undefined &&
    validTimestampMs(next.prepared_at) !== undefined &&
    Date.parse(String(next.prepared_at)) >=
      Date.parse(String(previous.aborted_at))
  );
  if (safeAbortRetryGeneration) {
    // A proved zero-input abort may advance the terminal-wide singleton to the
    // retry generation even though its Turn/binding identity is different.
    return next;
  }
  for (const field of RECEIPT_IMMUTABLE_FIELDS) {
    const previousValue = previous[field];
    const nextValue = next[field];
    if (
      previousValue !== undefined &&
      nextValue !== undefined &&
      canonicalJson(previousValue) !== canonicalJson(nextValue)
    ) {
      throw new Error(
        `terminal dispatch receipt ${messageId} changed immutable ${field}`
      );
    }
  }
  const previousControl = isRecord(previous.terminal_control)
    ? previous.terminal_control
    : undefined;
  const nextControl = isRecord(next.terminal_control)
    ? next.terminal_control
    : undefined;
  const previousEvidence = previous.terminal_endpoint ?? previousControl;
  const nextEvidence = next.terminal_endpoint ?? nextControl;
  if (
    previousEvidence !== undefined &&
    nextEvidence !== undefined &&
    !sameTerminalControlEvidenceIncarnation(
      previousEvidence,
      nextEvidence
    )
  ) {
    throw new Error(
      `terminal dispatch receipt ${messageId} changed immutable terminal_control`
    );
  }
  if (
    previous.status === "agent_accepted" &&
    next.status !== "agent_accepted"
  ) {
    return previous;
  }
  const previousIsTerminalFailure = [
    "not_accepted",
    "uncertain",
    "aborted"
  ].includes(String(previous.status)) && previous.safe_to_retry !== true;
  const nextIsTransportOnly = [
    "text_injected",
    "enter_dispatched",
    "submitted"
  ].includes(String(next.status));
  if (previousIsTerminalFailure && nextIsTransportOnly) {
    return previous;
  }
  const merged = { ...next };
  for (const field of RECEIPT_IMMUTABLE_FIELDS) {
    if (merged[field] === undefined && previous[field] !== undefined) {
      merged[field] = previous[field];
    }
  }
  if (!merged.terminal_control && previousControl) {
    merged.terminal_control = previousControl;
  }
  if (!merged.terminal_endpoint && previous.terminal_endpoint) {
    merged.terminal_endpoint = previous.terminal_endpoint;
  }
  return merged;
}

export interface ConstructTerminalDispatchLedgerOptions {
  previousLedger: TerminalDispatchLedgerDocument | undefined;
  incomingLedger: TerminalDispatchLedgerDocument;
  version: 1 | 2;
  terminalKey: string;
  terminalControl: TerminalDispatchLedgerDocument;
  terminalEndpoint?: unknown;
}

/** Build the exact JSON document; the caller remains responsible for atomic I/O. */
export function constructTerminalDispatchLedgerDocument({
  previousLedger,
  incomingLedger,
  version,
  terminalKey,
  terminalControl,
  terminalEndpoint
}: ConstructTerminalDispatchLedgerOptions): TerminalDispatchLedgerDocument {
  const resolvingTopLevel = incomingLedger.status === "resolved";
  let baseReceiptHistory = resolvingTopLevel
    ? validatedStoredTerminalDispatchReceiptHistory(previousLedger)
    : terminalDispatchReceiptHistory(previousLedger);
  const incomingReceiptHistory = resolvingTopLevel
    ? validatedStoredTerminalDispatchReceiptHistory(incomingLedger)
    : terminalDispatchReceiptHistory(incomingLedger);
  for (const incomingReceipt of incomingReceiptHistory) {
    const incomingId = String(incomingReceipt.message_id);
    const previousReceipt = baseReceiptHistory.find((receipt) =>
      stringValue(receipt.message_id) === incomingId
    );
    const merged = previousReceipt
      ? mergeTerminalDispatchReceipt(previousReceipt, incomingReceipt)
      : incomingReceipt;
    baseReceiptHistory = previousReceipt
      ? baseReceiptHistory.map((receipt) =>
          stringValue(receipt.message_id) === incomingId ? merged : receipt
        )
      : [...baseReceiptHistory, merged];
  }
  const {
    terminal_submission_receipts: _incomingReceiptHistory,
    terminal_endpoint: incomingTerminalEndpoint,
    ...ledgerWithoutReceiptHistory
  } = incomingLedger;
  const nextWithoutHistory: TerminalDispatchLedgerDocument = {
    ...ledgerWithoutReceiptHistory,
    version,
    terminal_key: terminalKey,
    terminal_control: terminalControl,
    ...(version === 2 ? { terminal_endpoint: terminalEndpoint } : {})
  };
  // The top-level document follows the current terminal incarnation, while a
  // receipt keeps the endpoint that actually accepted its input.
  const receiptCandidateLedger = isRecord(
    ledgerWithoutReceiptHistory.terminal_control
  )
    ? (() => {
        const {
          terminal_endpoint: _derivedTerminalEndpoint,
          ...nextWithoutDerivedTerminalEndpoint
        } = nextWithoutHistory;
        return {
          ...nextWithoutDerivedTerminalEndpoint,
          terminal_control: ledgerWithoutReceiptHistory.terminal_control,
          ...(incomingTerminalEndpoint && version === 2
            ? { terminal_endpoint: incomingTerminalEndpoint }
            : {})
        };
      })()
    : nextWithoutHistory;
  const resolvedMessageId = nextWithoutHistory.status === "resolved"
    ? stringValue(nextWithoutHistory.message_id)
    : undefined;
  const resolvedReceiptAlreadyStored = Boolean(
    resolvedMessageId &&
    baseReceiptHistory.some((receipt) =>
      stringValue(receipt.message_id) === resolvedMessageId
    )
  );
  // Resolution is terminal-wide ownership metadata, not a new submission
  // phase. When the exact receipt is already append-only history, never merge
  // top-level resolved_at/reason back into that historical proof.
  const nextCandidate = resolvedReceiptAlreadyStored
    ? undefined
    : terminalDispatchReceiptCandidate(receiptCandidateLedger);
  let nextReceiptHistory = baseReceiptHistory;
  if (nextCandidate) {
    const messageId = String(nextCandidate.message_id);
    const previousReceipt = baseReceiptHistory.find((receipt) =>
      stringValue(receipt.message_id) === messageId
    );
    const nextReceipt = previousReceipt
      ? mergeTerminalDispatchReceipt(previousReceipt, nextCandidate)
      : nextCandidate;
    nextReceiptHistory = previousReceipt
      ? baseReceiptHistory.map((receipt) =>
          stringValue(receipt.message_id) === messageId
            ? nextReceipt
            : receipt
        )
      : [...baseReceiptHistory, nextReceipt];
  }
  return {
    ...nextWithoutHistory,
    ...(nextReceiptHistory.length > 0
      ? { terminal_submission_receipts: nextReceiptHistory }
      : {})
  };
}

function invalidLedger(ledgerPath: string): Error {
  return new Error(`terminal dispatch ledger is invalid: ${ledgerPath}`);
}

function validTimestampMs(value: unknown): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}
