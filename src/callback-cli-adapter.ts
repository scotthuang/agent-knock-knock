// Raw CLI composition for callback commands, outbox recovery, and transport.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  createCallbackOutboxService, type ApprovalNotificationPreparationInput,
  type CallbackDeliveryReconciliationInput, type CallbackExecutionResult,
  type CallbackOutboxServicePorts, type CallbackPreparationOptions,
  type CallbackRetryMonitorInput, type PreparedCallback,
  type TerminalCompletionPreparationInput
} from "./callback-outbox-service.js";
import type { CallbackRetryDisposition } from "./callback-outbox-policy.js";
import {
  createOpenClawCallbackTransport, type CallbackProcessDelivery,
  type CallbackProcessDeliveryObservation, type DeliverChatSendInput,
  type DeliverGatewayMethodInput,
  type OpenClawCallbackTransport
} from "./openclaw-callback-transport.js";
import { budgetAction, type Conversation } from "./protocol.js";
import { redactString } from "./runtime-log.js";
import {
  appendEvent, assertStoreWriterCompatible, loadState, logPathForStatePath,
  messageEvent, pathsForConversationDir, saveState
} from "./store.js";
import type { TranscriptEvent } from "./transcript.js";
import { expandHome, redactCliOutput, writeCliJson } from
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
  runtime: {
    classifyProcessFailure(delivery: CallbackProcessDelivery): string | undefined;
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
  prepareTerminalCompletion(input: TerminalCompletionPreparationInput): ReturnType<
    CallbackOutboxService["prepareTerminalCompletion"]>;
  runPrepared(prepared: PreparedCallback, options?: { emit?: boolean }): CallbackExecutionResult;
  emitPreparedResult(result: CallbackExecutionResult): void;
  deliverGatewayMethod(input: DeliverGatewayMethodInput): CallbackProcessDelivery;
  deliverChatSend(input: DeliverChatSendInput): CallbackProcessDelivery;
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
    delivery: { deliver: (input) =>
      openClawCallbackTransport().deliverCallback(input),
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

function recordCallbackProcessDelivery(
  observation: CallbackProcessDeliveryObservation
): void {
  const { logPath, conversation, message, event, runtimeEvent, delivery } =
    observation;
  const detail = observation.detail ?? {};
  appendEvent(logPath, {
    ts: cliNow().toISOString(), conversation_id: conversation.conversation_id,
    event, from: message.from, to: "openclaw", round: message.round, ...detail,
    status: delivery.status, stdout: redactString(delivery.stdout),
    stderr: redactString(delivery.stderr)
  });
  cliRuntimeLog("info", runtimeEvent, {
    conversation_id: conversation.conversation_id, ...detail,
    status: delivery.status,
    failure_kind: callbackRuntime().runtime.classifyProcessFailure(delivery),
    stdout: callbackRuntime().runtime.textSummary(delivery.stdout),
    stderr: callbackRuntime().runtime.textSummary(delivery.stderr)
  });
}

function openClawCallbackTransport(): OpenClawCallbackTransport {
  return createOpenClawCallbackTransport({
    now: cliNow, environment: cliEnv, redactConversation: redactCliOutput,
    recordCallbackProcessDelivery
  });
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
    prepareTerminalCompletion: (input) => call(() =>
      callbackOutboxService().prepareTerminalCompletion(input)),
    runPrepared: (prepared, options) => call(() =>
      runPreparedCallback(prepared, options)),
    emitPreparedResult: (result) => call(() => emitPreparedCallbackResult(result)),
    deliverGatewayMethod: (input) => call(() =>
      openClawCallbackTransport().deliverGatewayMethod(input)),
    deliverChatSend: (input) => call(() =>
      openClawCallbackTransport().deliverChatSend(input))
  });
}
