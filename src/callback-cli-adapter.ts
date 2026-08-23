// Raw CLI composition for callback commands, outbox recovery, and transport.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  createCallbackOutboxService, type ApprovalNotificationPreparationInput,
  type CallbackDeliveryReconciliationInput, type CallbackExecutionResult,
  type CallbackOutboxServicePorts, type CallbackPreparationOptions,
  type CallbackRetryMonitorInput, type PreparedCallback,
  type StallNotificationPreparationInput,
  type TerminalCompletionPreparationInput
} from "./callback-outbox-service.js";
import type {
  CallbackDeliveryOutcome,
  CallbackRetryDisposition,
  DeliverCallbackInput
} from "./callback-outbox-policy.js";
import {
  parseCallbackAttemptOutcome,
  type CallbackAttemptOutcome,
  type CallbackRouteV1,
  type CallbackTransport,
  type CallbackTransportDeliverInput
} from "./callback-transport.js";
import { budgetAction, type Conversation } from "./protocol.js";
import {
  appendEvent, assertStoreWriterCompatible, loadState, logPathForStatePath,
  messageEvent, pathsForConversationDir, saveState
} from "./store.js";
import type { TranscriptEvent } from "./transcript.js";
import { nonBlankString, recordValue } from "./value-guards.js";
import { expandHome, writeCliJson } from
  "./cli-command-runtime.js";
import {
  cliEnv, cliExit, cliNow, cliNowMs, cliPid, cliRuntimeLog,
  cliSleepSync
} from "./cli-runtime-context.js";

export type CallbackCliOptions = Omit<CallbackPreparationOptions, "statePath"> & {
  callbackRetryDelayMs?: unknown;
  state?: string;
  statePath?: string;
  [option: string]: unknown;
};

type ResolvedCallbackTransportDelivery = Omit<
  CallbackTransportDeliverInput,
  "reportCheckpoint"
>;

export interface CallbackCliDependencies {
  state: {
    acquireFileLock(lockPath: string): () => void;
    loadConversation(options: CallbackCliOptions): {
      conversation: Conversation; statePath: string; logPath: string;
    };
    readEvents(logPath: string): TranscriptEvent[];
    withWriter<Result>(storeDir: string, operation: () => Result): Result;
  };
  authority: CallbackOutboxServicePorts["authority"];
  retry: CallbackOutboxServicePorts["retry"];
  delivery: {
    transport: CallbackTransport;
    resolve(input: DeliverCallbackInput): ResolvedCallbackTransportDelivery;
  };
  runtime: {
    textSummary(value: unknown): unknown;
  };
}
type CallbackOutboxService = ReturnType<typeof createCallbackOutboxService>;
export interface CallbackCliFacade {
  runCallback(options: CallbackCliOptions): void;
  runRetryCallback(options: CallbackCliOptions): void;
  retryDisposition(delivery: unknown): CallbackRetryDisposition;
  reconcileDelivery(input: CallbackDeliveryReconciliationInput): ReturnType<
    CallbackOutboxService["reconcileDelivery"]>;
  runRetryMonitor(input: CallbackRetryMonitorInput): void;
  prepareApprovalNotification(input: ApprovalNotificationPreparationInput): ReturnType<
    CallbackOutboxService["prepareApprovalNotification"]>;
  prepareStallNotification(input: StallNotificationPreparationInput): ReturnType<
    CallbackOutboxService["prepareStallNotification"]>;
  prepareTerminalCompletion(input: TerminalCompletionPreparationInput): ReturnType<
    CallbackOutboxService["prepareTerminalCompletion"]>;
  runPrepared(prepared: PreparedCallback, options?: { emit?: boolean }): CallbackExecutionResult;
  emitPreparedResult(result: CallbackExecutionResult): void;
}
const callbackCliContext = new AsyncLocalStorage<CallbackCliDependencies>();
function callbackRuntime(): CallbackCliDependencies {
  const runtime = callbackCliContext.getStore();
  if (!runtime) throw new Error("Callback CLI facade runtime is unavailable");
  return runtime;
}

function required<Value>(value: Value, message: string): Exclude<Value, undefined | ""> {
  if (value === undefined || value === "") throw new Error(message);
  return value as Exclude<Value, undefined | "">;
}

function callbackStoreDir(statePath: string): string {
  return pathsForConversationDir(path.dirname(statePath)).storeDir;
}

function runCallback(options: CallbackCliOptions): void {
  const statePath = expandHome(required(options.state, "--state is required"));
  runCallbackTransaction({ ...options, statePath });
}

function runRetryCallback(options: CallbackCliOptions): void {
  const runtime = callbackRuntime();
  const { conversation, statePath, logPath } = runtime.state.loadConversation(options);
  const storeDir = callbackStoreDir(statePath);
  runtime.state.withWriter(storeDir, () => {
    const fresh = loadState(statePath);
    runtime.authority.assertNoDeferredTransfer({
      storeDir,
      conversation: fresh,
      action: "retry callback for"
    });
  });
  const outcome = callbackOutboxService().retry({
    options: { ...options, statePath }, conversation, statePath, logPath
  });
  if (outcome.kind === "recovered") emitPreparedCallbackResult(outcome.result);
}

function runCallbackTransaction(options: CallbackPreparationOptions):
  CallbackExecutionResult {
  let prepared: PreparedCallback;
  callbackRuntime().state.withWriter(callbackStoreDir(options.statePath), () => {
    const releaseState = callbackRuntime().state.acquireFileLock(
      `${options.statePath}.lock`);
    try {
      prepared = prepareLockedCallback(options);
    } finally {
      releaseState();
    }
  });
  return runPreparedCallback(prepared!);
}

function deliverCallbackViaTransport(
  input: DeliverCallbackInput
): CallbackDeliveryOutcome {
  const runtime = callbackRuntime();
  let resolved: ResolvedCallbackTransportDelivery;
  try {
    resolved = runtime.delivery.resolve(input);
  } catch {
    return callbackDeliveryOutcome(undefined, {
      disposition: "permanent_failure",
      error_code: "callback_route_resolution_failed"
    });
  }
  let acceptedCheckpoint: Extract<
    CallbackAttemptOutcome,
    { disposition: "accepted" }
  > | undefined;
  let invalidCheckpoint = false;
  const reportCheckpoint = (value: CallbackAttemptOutcome): void => {
    let outcome: CallbackAttemptOutcome;
    try {
      outcome = parseCallbackAttemptOutcome(value);
    } catch {
      invalidCheckpoint = true;
      return;
    }
    const delivery = callbackDeliveryOutcome(resolved.route, outcome);
    if (outcome.disposition === "accepted") {
      acceptedCheckpoint = outcome;
      input.onAccepted?.(delivery);
    }
    input.onProgress?.({
      stage: "transport_checkpoint",
      ...delivery
    });
  };
  let value: unknown;
  try {
    value = runtime.delivery.transport.deliver({
      ...resolved,
      reportCheckpoint
    });
  } catch {
    return callbackDeliveryOutcome(
      resolved.route,
      acceptedCheckpoint ?? callbackTransportContractViolation()
    );
  }
  let outcome: CallbackAttemptOutcome;
  try {
    outcome = parseCallbackAttemptOutcome(value);
  } catch {
    outcome = acceptedCheckpoint ?? callbackTransportContractViolation();
  }
  if (acceptedCheckpoint && outcome.disposition !== "accepted") {
    outcome = acceptedCheckpoint;
  } else if (invalidCheckpoint && outcome.disposition !== "accepted") {
    outcome = callbackTransportContractViolation();
  }
  return callbackDeliveryOutcome(resolved.route, outcome);
}

function callbackTransportContractViolation(): CallbackAttemptOutcome {
  return {
    disposition: "uncertain",
    error_code: "callback_transport_contract_violation",
    observed_at: cliNow().toISOString()
  };
}

function callbackDeliveryOutcome(
  route: CallbackRouteV1 | undefined,
  outcome: CallbackAttemptOutcome
): CallbackDeliveryOutcome {
  const legacyDelivery = legacyCallbackDelivery(outcome);
  if (legacyDelivery) {
    return { ...legacyDelivery, attempt_outcome: outcome };
  }
  const accepted = outcome.disposition === "accepted";
  const uncertain = outcome.disposition === "uncertain";
  const errorCode = accepted ? undefined : outcome.error_code;
  const injectionStatus = outcomeEvidenceString(
    outcome,
    "injection_status"
  ) ?? (accepted ? "accepted" : uncertain ? "uncertain" : "failed");
  const wakeStatus = outcomeEvidenceString(outcome, "wake_status") ??
    (accepted ? "not_required" : "not_attempted");
  return {
    kind: outcomeEvidenceString(outcome, "delivery_kind") ??
      route?.transport ?? "callback_transport",
    injection: {
      status: injectionStatus,
      ...(accepted
        ? {
            accepted_at: outcome.accepted_at
          }
        : { error_code: errorCode })
    },
    wake: {
      status: wakeStatus
    },
    attempt_outcome: outcome
  };
}

function legacyCallbackDelivery(
  outcome: CallbackAttemptOutcome
): CallbackDeliveryOutcome | undefined {
  const value = recordValue(outcome.evidence?.legacy_delivery);
  const kind = nonBlankString(value?.kind);
  const injection = recordValue(value?.injection);
  const wake = recordValue(value?.wake);
  const runObservation = recordValue(value?.run_observation);
  if (!kind || !injection || !wake) return undefined;
  return {
    kind,
    injection,
    wake,
    ...(runObservation ? { run_observation: runObservation } : {})
  };
}

function outcomeEvidenceString(
  outcome: CallbackAttemptOutcome,
  field: string
): string | undefined {
  const value = outcome.evidence?.[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function callbackOutboxService(): CallbackOutboxService {
  const runtime = callbackRuntime();
  return createCallbackOutboxService({
    state: {
      load: loadState, save: saveState,
      readEvents: runtime.state.readEvents,
      append: appendEvent,
      appendMessage: (logPath, message) => appendEvent(
        logPath, messageEvent(message)),
      assertWriterCompatible: assertStoreWriterCompatible,
      withTransaction: (statePath, operation) => {
        const releaseState = runtime.state.acquireFileLock(`${statePath}.lock`);
        try { return operation(); } finally { releaseState(); }
      },
      withWriter: runtime.state.withWriter,
      storeDirForStatePath: callbackStoreDir, logPathForStatePath
    },
    authority: runtime.authority,
    retry: runtime.retry,
    runtime: {
      now: cliNow, nowMs: cliNowMs, pid: cliPid, log: cliRuntimeLog,
      textSummary: runtime.runtime.textSummary,
      sleepSync: cliSleepSync,
      crashCheckpoint: () => {
        if (cliEnv().AKK_TEST_EXIT_AFTER_LOCAL_COMPLETION_STATE === "1") {
          cliExit(86);
        }
      }
    },
    delivery: { deliver: deliverCallbackViaTransport,
    runTransaction: runCallbackTransaction }
  });
}

function prepareLockedCallback(options: CallbackPreparationOptions): PreparedCallback {
  required(options.messageJson, "--message-json is required");
  return callbackOutboxService().prepare({
    options, logPath: expandHome(
      options.log ?? logPathForStatePath(options.statePath))
  });
}

function emitPreparedCallbackResult(result: CallbackExecutionResult): void {
  writeCliJson({
    conversation: result.conversation, message: result.message,
    budget: budgetAction(result.conversation),
    delivered: result.delivered, duplicate: result.duplicate,
    ...(result.delivery === undefined ? {} : { delivery: result.delivery })
  });
}

function runPreparedCallback(
  prepared: PreparedCallback,
  { emit = true }: { emit?: boolean } = {}
): CallbackExecutionResult {
  const result = callbackOutboxService().runPrepared(prepared);
  if (emit) emitPreparedCallbackResult(result);
  return result;
}

export function createCallbackCliFacade(
  dependencies: CallbackCliDependencies
): CallbackCliFacade {
  const call = <Result>(operation: () => Result): Result =>
    callbackCliContext.run(dependencies, operation);
  return Object.freeze({
    runCallback: (options) => call(() => runCallback(options)),
    runRetryCallback: (options) => call(() => runRetryCallback(options)),
    retryDisposition: (delivery) => call(() =>
      callbackOutboxService().retryDisposition(delivery)),
    reconcileDelivery: (input) => call(() =>
      callbackOutboxService().reconcileDelivery(input)),
    runRetryMonitor: (input) => call(() =>
      callbackOutboxService().runRetryMonitor(input)),
    prepareApprovalNotification: (input) => call(() =>
      callbackOutboxService().prepareApprovalNotification(input)),
    prepareStallNotification: (input) => call(() =>
      callbackOutboxService().prepareStallNotification(input)),
    prepareTerminalCompletion: (input) => call(() =>
      callbackOutboxService().prepareTerminalCompletion(input)),
    runPrepared: (prepared, options) => call(() =>
      runPreparedCallback(prepared, options)),
    emitPreparedResult: (result) => call(() => emitPreparedCallbackResult(result))
  });
}
