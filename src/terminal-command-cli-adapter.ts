// Raw CLI infrastructure for ordinary terminal send/respond/approval commands.
import {
  AsyncLocalStorage
} from "node:async_hooks";
import {
  createHash,
  randomUUID
} from "node:crypto";
import path from "node:path";
import {
  callbackExpectedForConversation,
  callbackExpectedForConversationWithLegacyFallback,
  callbackRouteFingerprintForConversation
} from "./callback-route-authority.js";
import {
  type CodexRolloutAcceptanceAnchor,
  validateCodexRolloutAcceptanceAnchor
} from "./terminal-submission-acceptance.js";
import { fingerprint } from "./terminal-submission-facts.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import {
  deferredForegroundActiveMessageId,
  isDeferredForegroundSubmissionRetryPending,
  type DeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import {
  applyMessageToConversation,
  budgetAction,
  createMessage,
  effectiveTurnStatus,
  executorForConversation,
  isSessionSendBlockingStatus,
  isTerminalDispatchOwnerReleasedStatus,
  sessionIdForConversation,
  turnIdForConversation,
  type AgentMessage,
  type Conversation,
  type ConversationStatus,
  type Executor
} from "./protocol.js";
import {
  readNdjsonLog
} from "./transcript.js";
import {
  appendEvent,
  ensureDir,
  listConversations,
  loadState,
  messageEvent,
  pathsForConversationDir,
  saveState,
  withStoreWriterLeaseAsync
} from "./store.js";
import { tryLoadManagedSession } from "./session-store.js";
import {
  isTerminalApprovalDecision,
  type TerminalApprovalDecision,
  type TerminalControlRef,
  type TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  terminalControlEvidenceMatches
} from "./terminal-control-ref.js";
import {
  type TerminalApprovalAuthorizationContext,
  type TerminalAgentBridge,
  type TerminalCodexComposerObservation
} from "./terminal-agent-bridge.js";
import {
  decideTerminalSubmissionRetry,
  loadTerminalSubmissionRetry,
  projectTerminalSubmissionRetryPending,
  saveTerminalSubmissionRetry,
  terminalSubmissionRetryLedgerFields,
  TERMINAL_SUBMISSION_RETRY_SCHEMA,
  TERMINAL_SUBMISSION_RETRY_VERSION,
  type TerminalSubmissionRetryDecision,
  type TerminalSubmissionRetryRecord
} from "./terminal-submission-retry-service.js";
import {
  evaluateApprovalPolicy,
  type ApprovalCandidate
} from "./approval-policy.js";
import {
  terminalControlsShareIncarnation,
  type CodexAllowedCompanionSet,
  type CodexPreMaterializationIdentity
} from "./terminal-authority-policy.js";
import {
  terminalScopedCodexApprovalPromptSnapshot
} from "./terminal-scoped-approval-authority.js";
import {
  type CanonicalMutationResources,
  type CanonicalMutationScopes,
  type CanonicalStateMutationResources,
  type CanonicalStateMutationScopes,
  withCanonicalMutationLocks
} from "./mutation-transaction.js";
import {
  assertTerminalDispatchRouteMatches,
  bindTerminalDispatchRoute,
  type BoundTerminalDispatchRoute
} from "./terminal-dispatch-capability.js";
import {
  claudeTranscriptApprovalIdentity,
  terminalMonitorDeadlineAt as deadlineAt,
  validTerminalMonitorTimestampMs as validTimestampMs
} from "./terminal-monitor-decision-policy.js";
import * as monitorOwner from "./terminal-monitor-ownership-policy.js";
import {
  sameCanonicalStatePath,
  terminalDispatchLedgerLooksLifecycle,
  terminalDispatchReceiptHistory as terminalLedgerReceiptHistory,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import {
  prepareTerminalControlSend,
  type TerminalDispatchPreparationPorts
} from "./terminal-command-dispatch-preparation.js";
import {
  runTerminalControlSend as executeTerminalControlSend,
  type TerminalDispatchTransportCliPorts,
  type TerminalDispatchTransportDependencies
} from "./terminal-command-dispatch-transport.js";
import type {
  DeferredCodexForegroundBindingBoundary,
  TerminalDispatchTerminal,
  TerminalControlSendRequest
} from "./terminal-dispatch-composition.js";
import type { DeferredForegroundApplicationScope } from
  "./deferred-foreground-boundary.js";
import {
  bindDeferredForegroundApplicationScope
} from "./deferred-foreground-capability.js";
import * as deferredRecoveryAdapter from "./deferred-foreground-recovery-cli-adapter.js";
import {
  deferredForegroundBoundaryProjection
} from "./deferred-foreground-preparation-cli-adapter.js";
import {
  terminalSubmissionPayload
} from "./terminal-dispatch-execution.js";
import {
  runHumanExplicitTerminalSend,
  type TerminalHumanExplicitSendDependencies
} from "./terminal-human-explicit-send-cli-adapter.js";
import {
  runManagedRawTerminalSendAttempt,
  runManagedSessionSend,
  type TerminalManagedSendDependencies
} from "./terminal-managed-send-cli-adapter.js";
import type { TerminalDispatchExecutionService } from
  "./terminal-dispatch-execution.js";
import {
  createCodexForegroundProofAuthority
} from "./terminal-command-foreground-proof.js";
import {
  presentTerminalCompleted,
  presentTerminalDispatchReplay,
  presentTerminalIdentityFailure,
  terminalSendEnterDispatched,
  terminalSendResultContract,
  presentTerminalUncertain,
  presentTerminalZeroInputAbort as renderTerminalZeroInputAbort
} from "./terminal-dispatch-presenter.js";
import * as dispatchReceipt from "./terminal-dispatch-receipt.js";
import {
  positiveMilliseconds,
  writeCliJson as printJson
} from "./cli-command-runtime.js";
import {
  cliEnv,
  cliExit,
  cliNow,
  cliNowMs,
  cliPid,
  cliRuntimeLog as runtimeLog,
  type CliCommandExecutionResult
} from "./cli-runtime-context.js";

export type {
  TerminalCommandCliDependencies,
  TerminalCommandCliOptions
} from "./terminal-command-cli-ports.js";
import type {
  TerminalCommandCliDependencies,
  TerminalCommandCliOptions,
  TerminalCommandCliPorts,
  TerminalCommandTarget,
  TerminalDispatchRecord,
  TerminalMonitorProcess
} from "./terminal-command-cli-ports.js";

export interface TerminalCommandCliFacade {
  runSend(options: TerminalCommandCliOptions): Promise<void>;
  runRespond(options: TerminalCommandCliOptions): Promise<void>;
  runApprove(options: TerminalCommandCliOptions): Promise<void>;
}

const terminalCommandContext =
  new AsyncLocalStorage<TerminalCommandCliDependencies>();

function terminalCommandRuntime(): TerminalCommandCliDependencies {
  const runtime = terminalCommandContext.getStore();
  if (!runtime) {
    throw new Error("Terminal command facade runtime is unavailable");
  }
  return runtime;
}

type TerminalCommandFunctionPortName = {
  [Name in keyof TerminalCommandCliPorts]:
    TerminalCommandCliPorts[Name] extends (...arguments_: never[]) => unknown
      ? Name
      : never;
}[keyof TerminalCommandCliPorts];

function rawPort<Name extends TerminalCommandFunctionPortName>(
  name: Name
): TerminalCommandCliPorts[Name] {
  return ((...arguments_: unknown[]) => {
    const operation = terminalCommandRuntime().ports[name];
    if (typeof operation !== "function") {
      throw new Error(`Terminal command port ${String(name)} is unavailable`);
    }
    return (operation as (...values: unknown[]) => unknown)(...arguments_);
  }) as unknown as TerminalCommandCliPorts[Name];
}

const acquireFileLock = rawPort("acquireFileLock");
const acquireTerminalBridgeSendLock = rawPort("acquireTerminalBridgeSendLock");
const assertCodexComposerReadyForAutomatedInput =
  rawPort("assertCodexComposerReadyForAutomatedInput");
const assertDeferredCodexForegroundBindingBoundary =
  rawPort("assertDeferredCodexForegroundBindingBoundary");
const assertExpectedHandoffTokenUsesExactTerminalSelector =
  rawPort("assertExpectedHandoffTokenUsesExactTerminalSelector");
const assertManagedTerminalDispatchOwner =
  rawPort("assertManagedTerminalDispatchOwner");
const assertNativeAgentIdentityForTurn =
  rawPort("assertNativeAgentIdentityForTurn");
const assertNativeThreadHasExclusiveOwnership =
  rawPort("assertNativeThreadHasExclusiveOwnership");
const assertObservedHandoffTransportBoundary =
  rawPort("assertObservedHandoffTransportBoundary");
const assertSafeAbortedTerminalRetryBinding =
  rawPort("assertSafeAbortedTerminalRetryBinding");
const assertSafeTerminalSend = rawPort("assertSafeTerminalSend");
const assertVerifiedEmptyCodexTransportBoundary =
  rawPort("assertVerifiedEmptyCodexTransportBoundary");
const codexAllowedCompanionSetForManagedSession =
  rawPort("codexAllowedCompanionSetForManagedSession");
const createRuntimeTerminalAgentRegistry =
  rawPort("createRuntimeTerminalAgentRegistry");
const createTerminalAgentBridge = rawPort("createTerminalAgentBridge");
const deferredForegroundApplication = rawPort("deferredForegroundApplication");
const deferredForegroundRecoveryAdapterPorts =
  rawPort("deferredForegroundRecoveryAdapterPorts");
const ensureTerminalBridgeMonitorAfterApproval =
  rawPort("ensureTerminalBridgeMonitorAfterApproval");
const exactSafeAbortedRecoveredSessionMatches =
  rawPort("exactSafeAbortedRecoveredSessionMatches");
const loadClaudeAgentRows = rawPort("loadClaudeAgentRows");
const loadConversationFromOptions = rawPort("loadConversationFromOptions");
const loadTerminalBridgeDispatchLedger =
  rawPort("loadTerminalBridgeDispatchLedger");
const loadTerminalDispatchLedgerOwner =
  rawPort("loadTerminalDispatchLedgerOwner");
const logicalIdentityForManagedSession =
  rawPort("logicalIdentityForManagedSession");
const managedSessionStoreDirForConversation =
  rawPort("managedSessionStoreDirForConversation");
const maybeDetachVerifiedEmptyCodexSource =
  rawPort("maybeDetachVerifiedEmptyCodexSource");
const migrateLegacyTerminalAgentIdentity =
  rawPort("migrateLegacyTerminalAgentIdentity");
const openClawYieldNextAction = rawPort("openClawYieldNextAction");
const parseJsonOption = rawPort("parseJsonOption");
const persistManagedSessionNativeIdentity =
  rawPort("persistManagedSessionNativeIdentity");
const positiveMinutes = rawPort("positiveMinutes");
const prepareUserExplicitFallbackWatch =
  rawPort("prepareUserExplicitFallbackWatch");
const processIncarnationForPid = rawPort("processIncarnationForPid");
const attachUserExplicitFallbackWatch =
  rawPort("attachUserExplicitFallbackWatch");
const quarantineManagedSessionBinding = rawPort("quarantineManagedSessionBinding");
const reconcilePreparedTerminalDispatchLedger =
  rawPort("reconcilePreparedTerminalDispatchLedger");
const refineManagedSessionNativeIdentity =
  rawPort("refineManagedSessionNativeIdentity");
const refineTerminalTurnEndpoint = rawPort("refineTerminalTurnEndpoint");
const required = rawPort("required");
const resolveCurrentNativeAgentSessionIdentity =
  rawPort("resolveCurrentNativeAgentSessionIdentity");
const resolveTerminalBridgeDispatchLedger =
  rawPort("resolveTerminalBridgeDispatchLedger");
const resolveTerminalDispatchLedgerPaneIncarnation =
  rawPort("resolveTerminalDispatchLedgerPaneIncarnation");
const resolveTerminalConversationFromOptions =
  rawPort("resolveTerminalConversationFromOptions");
const stallOtherTerminalBridgeConversationsForUncertainDispatch =
  rawPort("stallOtherTerminalBridgeConversationsForUncertainDispatch");
const startTerminalBridgeMonitorForConversation =
  rawPort("startTerminalBridgeMonitorForConversation");
const storeDirFromOptions = rawPort("storeDirFromOptions");
const terminalBindingLedgerFields = rawPort("terminalBindingLedgerFields");
const terminalBridgeEnabled = rawPort("terminalBridgeEnabled");
const terminalBridgeRequestFingerprint = rawPort("terminalBridgeRequestFingerprint");
const terminalBridgeRuntimeKey = rawPort("terminalBridgeRuntimeKey");
const terminalControlFromTakeover = rawPort("terminalControlFromTakeover");
const terminalDispatchCapabilityRepositories =
  rawPort("terminalDispatchCapabilityRepositories");
const terminalDispatchExecution = rawPort("terminalDispatchExecution");
const terminalDispatchRecordMatchesControl =
  rawPort("terminalDispatchRecordMatchesControl");
const terminalDurableRequestForConversation =
  rawPort("terminalDurableRequestForConversation");
const terminalRuntimeForLiveIdentity = rawPort("terminalRuntimeForLiveIdentity");
const terminalRuntimeIdentityForConversation =
  rawPort("terminalRuntimeIdentityForConversation");
const terminalWriterMutationLocks = rawPort("terminalWriterMutationLocks");
const textSummary = rawPort("textSummary");
const withTerminalBridgeSubmission = rawPort("withTerminalBridgeSubmission");
const withTerminalDispatchStateScope = rawPort("withTerminalDispatchStateScope");
const userExplicitFallbackWatchReceipt =
  rawPort("userExplicitFallbackWatchReceipt");

const foregroundIdentificationAuthority =
  createCodexForegroundProofAuthority({
    createRegistry: (options) =>
      createRuntimeTerminalAgentRegistry(options),
    nowMs: () => cliNowMs(),
    processIncarnationForPid: (pid) => processIncarnationForPid(pid)
  });

const mutationDispatchLedger = new Proxy({}, {
  get: (_target, property) =>
    terminalCommandRuntime().ports.mutationDispatchLedger[
      property as keyof TerminalCommandCliPorts["mutationDispatchLedger"]
    ]
}) as TerminalCommandCliPorts["mutationDispatchLedger"];

const terminalListCliFacade = new Proxy({}, {
  get: (_target, property) =>
    terminalCommandRuntime().ports.terminalList[
      property as keyof TerminalCommandCliPorts["terminalList"]
    ]
}) as TerminalCommandCliPorts["terminalList"];

export type { CliCommandExecutionResult };


const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_AGENT_HARD_TIMEOUT_MINUTES = 720;
const DEFAULT_TERMINAL_ACCEPTANCE_TIMEOUT_MS = 5000;
const DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS = 50;
const CLAUDE_SCREEN_APPROVAL_TTL_MS = 10 * 60 * 1000;

interface TerminalReplayExpectation {
  terminalControl: TerminalControlRef;
  expectedStoreDir: string;
  expectedSessionId?: string;
  expectedTurnId?: string;
  expectedMessageType: "task" | "answer";
  expectedStatePath?: string;
  requestHash: string;
  options: Record<string, any>;
}

function replayReceiptBindingMismatch(
  receipt: Record<string, any>,
  expectation: TerminalReplayExpectation
): boolean {
  return Boolean(
    !terminalDispatchRecordMatchesControl(receipt, expectation.terminalControl) ||
    (stringValue(receipt.store_dir) !== undefined &&
      path.resolve(String(receipt.store_dir)) !==
        path.resolve(expectation.expectedStoreDir)) ||
    (expectation.expectedSessionId &&
      stringValue(receipt.session_id) !== undefined &&
      stringValue(receipt.session_id) !== expectation.expectedSessionId) ||
    (expectation.expectedTurnId &&
      stringValue(receipt.turn_id) !== undefined &&
      stringValue(receipt.turn_id) !== expectation.expectedTurnId) ||
    (expectation.expectedStatePath &&
      stringValue(receipt.state_path) !== undefined &&
      !sameCanonicalStatePath(
        receipt.state_path,
        expectation.expectedStatePath
      ))
  );
}

function replayReceiptPayloadMismatch(
  receipt: Record<string, any>,
  expectation: TerminalReplayExpectation,
  expectedMessageBodyHash: string
): boolean {
  return (
    (stringValue(receipt.message_type) !== undefined &&
      stringValue(receipt.message_type) !== expectation.expectedMessageType) ||
    (stringValue(receipt.message_body_hash) !== undefined &&
      stringValue(receipt.message_body_hash) !== expectedMessageBodyHash) ||
    (stringValue(receipt.request_hash) !== undefined &&
      stringValue(receipt.request_hash) !== expectation.requestHash) ||
    (stringValue(expectation.options.openclawSession) !== undefined &&
      stringValue(receipt.openclaw_session) !== undefined &&
      stringValue(receipt.openclaw_session) !==
        stringValue(expectation.options.openclawSession))
  );
}

function replayReceiptConflicts(
  receipt: Record<string, any> | undefined,
  expectation: TerminalReplayExpectation,
  expectedMessageBodyHash: string
): boolean {
  return Boolean(
    receipt &&
    !(receipt.status === "aborted" && receipt.safe_to_retry === true) &&
    (
      replayReceiptBindingMismatch(receipt, expectation) ||
      replayReceiptPayloadMismatch(
        receipt,
        expectation,
        expectedMessageBodyHash
      )
    )
  );
}

function activeReplayLedgerBindingMismatch(
  ledger: TerminalDispatchLedgerDocument,
  expectation: TerminalReplayExpectation,
  storeDir: string | undefined,
  sessionId: string | undefined,
  statePath: string | undefined,
  matchesRecoveredSession: boolean
): boolean {
  return Boolean(
    !terminalDispatchRecordMatchesControl(ledger, expectation.terminalControl) ||
    (storeDir !== undefined &&
      path.resolve(storeDir) !== path.resolve(expectation.expectedStoreDir)) ||
    (expectation.expectedSessionId &&
      sessionId !== undefined &&
      sessionId !== expectation.expectedSessionId &&
      !matchesRecoveredSession) ||
    (expectation.expectedTurnId &&
      stringValue(ledger.turn_id) !== undefined &&
      stringValue(ledger.turn_id) !== expectation.expectedTurnId) ||
    (expectation.expectedStatePath &&
      statePath !== undefined &&
      !sameCanonicalStatePath(
        statePath,
        expectation.expectedStatePath
      ))
  );
}

function activeReplayLedgerPayloadMismatch(
  ledger: TerminalDispatchLedgerDocument,
  owner: Conversation | undefined,
  expectation: TerminalReplayExpectation
): boolean {
  return Boolean(
    (stringValue(ledger.message_type) !== undefined &&
      stringValue(ledger.message_type) !== expectation.expectedMessageType) ||
    (stringValue(ledger.request_hash) !== undefined &&
      stringValue(ledger.request_hash) !== expectation.requestHash) ||
    (stringValue(expectation.options.openclawSession) !== undefined &&
      owner !== undefined &&
      owner.openclaw_session !==
        stringValue(expectation.options.openclawSession))
  );
}

function activeReplayLedgerConflicts(input: {
  ledger: TerminalDispatchLedgerDocument | undefined;
  ledgerMessageId?: string;
  messageId: string;
  owner?: Conversation;
  expectation: TerminalReplayExpectation;
  storeDir?: string;
  sessionId?: string;
  statePath?: string;
  matchesRecoveredSession: boolean;
}): boolean {
  return Boolean(
    input.ledger &&
    input.ledgerMessageId === input.messageId &&
    (
      activeReplayLedgerBindingMismatch(
        input.ledger,
        input.expectation,
        input.storeDir,
        input.sessionId,
        input.statePath,
        input.matchesRecoveredSession
      ) ||
      activeReplayLedgerPayloadMismatch(
        input.ledger,
        input.owner,
        input.expectation
      )
    )
  );
}

function durableReceiptCannotDispatchAgain(
  receipt: Record<string, any> | undefined,
  ledger: TerminalDispatchLedgerDocument | undefined,
  ledgerMessageId: string | undefined,
  messageId: string
): boolean {
  return Boolean(
    receipt &&
    !(receipt.status === "aborted" && receipt.safe_to_retry === true) &&
    (
      ledgerMessageId !== messageId ||
      !["submitted", "enter_dispatched", "agent_accepted"].includes(
        String(receipt.status)
      ) ||
      !["submitted", "enter_dispatched", "agent_accepted"].includes(
        String(ledger?.status)
      )
    )
  );
}

function replayableReconciledLedger(
  ledger: TerminalDispatchLedgerDocument | undefined,
  expectation: TerminalReplayExpectation,
  messageId: string
): TerminalDispatchLedgerDocument | undefined {
  if (
    !ledger ||
    !["submitted", "enter_dispatched", "agent_accepted"].includes(
      String(ledger.status)
    ) ||
    !terminalDispatchRecordMatchesControl(
      ledger,
      expectation.terminalControl
    ) ||
    stringValue(ledger.message_id) !== messageId ||
    (stringValue(ledger.message_type) !== undefined &&
      stringValue(ledger.message_type) !== expectation.expectedMessageType) ||
    stringValue(ledger.request_hash) !== expectation.requestHash
  ) {
    return undefined;
  }
  return ledger;
}

function activeReplayOwnerMismatch(input: {
  owner?: Conversation;
  ledger: TerminalDispatchLedgerDocument;
  ledgerStoreDir?: string;
  ownerStoreDir?: string;
  expectation: TerminalReplayExpectation;
}): boolean {
  const { owner, ledger, ledgerStoreDir, ownerStoreDir, expectation } = input;
  return Boolean(
    !owner ||
    isTerminalDispatchOwnerReleasedStatus(owner.status) ||
    !ledgerStoreDir ||
    !ownerStoreDir ||
    path.resolve(ledgerStoreDir) !== path.resolve(expectation.expectedStoreDir) ||
    path.resolve(ownerStoreDir) !== path.resolve(expectation.expectedStoreDir) ||
    (expectation.expectedSessionId &&
      sessionIdForConversation(owner) !== expectation.expectedSessionId) ||
    (expectation.expectedTurnId &&
      turnIdForConversation(owner) !== expectation.expectedTurnId) ||
    (expectation.expectedStatePath &&
      !sameCanonicalStatePath(ledger.state_path, expectation.expectedStatePath)) ||
    (stringValue(expectation.options.openclawSession) &&
      owner.openclaw_session !==
        stringValue(expectation.options.openclawSession))
  );
}

function activeReplaySubmissionMismatch(input: {
  submission: Record<string, any> | undefined;
  nativeTakeover: Record<string, any> | undefined;
  messageId: string;
  expectation: TerminalReplayExpectation;
}): boolean {
  return (
    stringValue(input.nativeTakeover?.terminal_bridge_message_id) !==
      input.messageId ||
    stringValue(input.submission?.message_id) !== input.messageId ||
    (stringValue(input.submission?.message_type) !== undefined &&
      stringValue(input.submission?.message_type) !==
        input.expectation.expectedMessageType) ||
    stringValue(input.submission?.request_hash) !== input.expectation.requestHash
  );
}

function replayLoggedMessageMismatch(
  loggedMessage: Record<string, any>,
  owner: Conversation,
  expectedMessageType: "task" | "answer",
  requestText: string
): boolean {
  return (
    loggedMessage.type !== expectedMessageType ||
    loggedMessage.body !== requestText ||
    loggedMessage.conversation_id !== owner.conversation_id ||
    loggedMessage.session_id !== sessionIdForConversation(owner) ||
    loggedMessage.turn_id !== turnIdForConversation(owner)
  );
}

function replayExactActiveTerminalSubmission({
  options,
  terminalControl,
  requestText,
  expectedStoreDir,
  expectedSessionId,
  expectedTurnId,
  expectedMessageType = "task",
  expectedStatePath,
  userExplicitTerminalId
}: {
  options: Record<string, any>;
  terminalControl: TerminalControlRef;
  requestText: string;
  expectedStoreDir: string;
  expectedSessionId?: string;
  expectedTurnId?: string;
  expectedMessageType?: "task" | "answer";
  expectedStatePath?: string;
  userExplicitTerminalId?: string;
}): boolean {
  const messageId = stringValue(options.messageId);
  if (!messageId) {
    return false;
  }
  const terminalPayload = terminalSubmissionPayload(requestText);
  const requestHash = terminalBridgeRequestFingerprint(terminalPayload);
  if (!requestHash) {
    return false;
  }
  const loadedLedger = loadTerminalBridgeDispatchLedger(terminalControl);
  const ledgerReceiptMatches = terminalLedgerReceiptHistory(loadedLedger)
    .filter((receipt) => stringValue(receipt.message_id) === messageId);
  if (ledgerReceiptMatches.length > 1) {
    throw new Error(
      `terminal idempotency key ${messageId} has multiple terminal-ledger receipts`
    );
  }
  const ledgerReceipt = ledgerReceiptMatches[0];
  const loadedLedgerMessageId = stringValue(loadedLedger?.message_id);
  const loadedLedgerStoreDir = stringValue(loadedLedger?.store_dir);
  const loadedLedgerStatePath = stringValue(loadedLedger?.state_path);
  const loadedLedgerOwner = loadedLedger && loadedLedgerMessageId === messageId
    ? loadTerminalDispatchLedgerOwner(loadedLedger)
    : undefined;
  const loadedLedgerSessionId = stringValue(loadedLedger?.session_id);
  const loadedLedgerMatchesRecoveredSession = Boolean(
    expectedSessionId &&
    loadedLedgerSessionId !== undefined &&
    loadedLedgerSessionId !== expectedSessionId &&
    loadedLedgerOwner &&
    exactSafeAbortedRecoveredSessionMatches({
      owner: loadedLedgerOwner,
      storeDir: expectedStoreDir,
      terminalControl,
      messageId,
      expectedSessionId
    })
  );
  const expectedMessageBodyHash = createHash("sha256")
    .update(requestText)
    .digest("hex");
  const expectation: TerminalReplayExpectation = {
    terminalControl,
    expectedStoreDir,
    expectedSessionId,
    expectedTurnId,
    expectedMessageType,
    expectedStatePath,
    requestHash,
    options
  };
  if (replayReceiptConflicts(
    ledgerReceipt,
    expectation,
    expectedMessageBodyHash
  )) {
    throw new Error(
      `terminal idempotency key ${messageId} does not match its durable ` +
      "terminal receipt; no terminal input was sent"
    );
  }
  if (activeReplayLedgerConflicts({
    ledger: loadedLedger,
    ledgerMessageId: loadedLedgerMessageId,
    messageId,
    owner: loadedLedgerOwner,
    expectation,
    storeDir: loadedLedgerStoreDir,
    sessionId: loadedLedgerSessionId,
    statePath: loadedLedgerStatePath,
    matchesRecoveredSession: loadedLedgerMatchesRecoveredSession
  })) {
    throw new Error(
      `terminal idempotency key ${messageId} does not match its original ` +
      "Store, Session, Turn, controller session, message, or terminal binding; " +
      "no terminal input was sent"
    );
  }
  if (replayExactStoredTerminalSubmission({
    options,
    terminalControl,
    requestText,
    requestHash,
    messageId,
    expectedStoreDir,
    expectedSessionId,
    expectedTurnId,
    expectedMessageType,
    expectedStatePath,
    userExplicitTerminalId
  })) {
    return true;
  }
  if (durableReceiptCannotDispatchAgain(
    ledgerReceipt,
    loadedLedger,
    loadedLedgerMessageId,
    messageId
  )) {
    throw new Error(
      `terminal idempotency key ${messageId} already has durable ` +
      `${String(ledgerReceipt.status)} proof and cannot be dispatched again; ` +
      "no additional terminal input was sent"
    );
  }
  const incarnationLedger = resolveTerminalDispatchLedgerPaneIncarnation(
    terminalControl,
    loadedLedger
  );
  const ledger = replayableReconciledLedger(
    reconcilePreparedTerminalDispatchLedger(
      terminalControl,
      incarnationLedger
    ),
    expectation,
    messageId
  );
  if (!ledger) {
    return false;
  }
  const ownerCandidate = loadTerminalDispatchLedgerOwner(ledger);
  const ledgerStoreDir = stringValue(ledger.store_dir);
  const ownerStoreDir = ownerCandidate
    ? managedSessionStoreDirForConversation(ownerCandidate)
    : undefined;
  if (activeReplayOwnerMismatch({
    owner: ownerCandidate,
    ledger,
    ledgerStoreDir,
    ownerStoreDir,
    expectation
  })) {
    return false;
  }
  const owner = ownerCandidate as Conversation;
  const submission = terminalBridgeSubmission(owner);
  const nativeTakeover = isRecord(owner.native_session_takeover)
    ? owner.native_session_takeover
    : undefined;
  if (activeReplaySubmissionMismatch({
    submission,
    nativeTakeover,
    messageId,
    expectation
  })) {
    return false;
  }
  const executor = executorForConversation(owner);
  const nativeThreadId = stringValue(owner.native_thread_id) ??
    stringValue(nativeTakeover?.terminal_agent_session_id) ??
    stringValue(nativeTakeover?.terminal_agent_expected_session_id) ??
    sessionIdForConversation(owner);
  const proofLevel = String(ledger.status) as
    | "submitted"
    | "enter_dispatched"
    | "agent_accepted";
  const replayReceipt = dispatchReceipt.terminalSubmissionReplayReceipt({
    proofLevel,
    evidence: ledger.acceptance_evidence,
    expected: {
      source: executor.kind === "codex"
        ? "codex_rollout"
        : "claude_transcript",
      nativeThreadId,
      requestHash
    }
  });
  const logPath = stringValue(ledger.event_log_path) ??
    stringValue(owner.event_log_path);
  let loggedMessage: unknown;
  if (logPath) {
    try {
      loggedMessage = readNdjsonLog(logPath).find((event) =>
        isRecord(event.message) && event.message.id === messageId
      )?.message;
    } catch {
      loggedMessage = undefined;
    }
  }
  if (
    isRecord(loggedMessage) &&
    replayLoggedMessageMismatch(
      loggedMessage,
      owner,
      expectedMessageType,
      requestText
    )
  ) {
    return false;
  }
  const durableMessageType = stringValue(ledger.message_type) ??
    stringValue(submission?.message_type) ??
    (isRecord(loggedMessage) ? stringValue(loggedMessage.type) : undefined);
  if (durableMessageType !== expectedMessageType) {
    return false;
  }
  const replayedMessage = isRecord(loggedMessage)
    ? loggedMessage
    : createMessage({
        conversation: owner,
        id: messageId,
        from: "openclaw",
        to: executor.actor,
        type: expectedMessageType,
        body: requestText,
        metadata: {
          executor_kind: executor.kind,
          executor_session: executor.session
        }
      });
  const acceptanceInvalid = replayReceipt.submission_outcome === "uncertain";
  const callbackExpected = callbackExpectedForConversationWithLegacyFallback(
    owner,
    ledger.callback_expected
  );
  presentTerminalDispatchReplay({
    owner,
    receipt: replayReceipt,
    accepted: replayReceipt.submission_outcome === "agent_accepted",
    acceptanceInvalid,
    receiptConversationId: owner.conversation_id,
    receiptMessageId: messageId,
    callbackExpected,
    ...(userExplicitTerminalId
      ? {
          userExplicit: {
            terminalId: userExplicitTerminalId,
            messageId
          }
        }
      : {})
  }, {
    message: replayedMessage as AgentMessage,
    executor,
    terminalControl
  }, {
    write: printJson,
    budget: budgetAction,
    nextAction: openClawYieldNextAction,
    summarize: textSummary
  });
  return true;
}

function storedReceiptTerminalBoundaryMismatch(input: {
  ownerStoreDir?: string;
  receiptStoreDir?: string;
  expectedStoreDir: string;
  storedControl?: TerminalControlRef;
  terminalControl: TerminalControlRef;
  receiptTerminalEvidence: unknown;
}): boolean {
  return (
    !input.ownerStoreDir ||
    !input.receiptStoreDir ||
    path.resolve(input.ownerStoreDir) !== path.resolve(input.expectedStoreDir) ||
    path.resolve(input.receiptStoreDir) !== path.resolve(input.expectedStoreDir) ||
    !input.storedControl ||
    !terminalControlsShareIncarnation(
      input.storedControl,
      input.terminalControl
    ) ||
    !terminalControlEvidenceMatches(
      input.receiptTerminalEvidence,
      input.terminalControl
    )
  );
}

function storedReceiptAuthorityMismatch(input: {
  owner: Conversation;
  receipt: Record<string, any>;
  receiptSessionId: string;
  receiptTurnId: string;
  receiptOpenClawSession?: string;
  receiptMatchesRecoveredSession: boolean;
  expectedSessionId?: string;
  expectedTurnId?: string;
  expectedStatePath?: string;
  requestedOpenClawSession?: string;
  requestHash: string;
}): boolean {
  return (
    input.receiptSessionId !== sessionIdForConversation(input.owner) ||
    input.receiptTurnId !== turnIdForConversation(input.owner) ||
    (input.expectedSessionId &&
      input.receiptSessionId !== input.expectedSessionId &&
      !input.receiptMatchesRecoveredSession) ||
    (input.expectedTurnId && input.receiptTurnId !== input.expectedTurnId) ||
    (input.expectedStatePath &&
      !sameCanonicalStatePath(
        input.owner.state_path,
        input.expectedStatePath
      )) ||
    (input.requestedOpenClawSession &&
      input.receiptOpenClawSession !== input.requestedOpenClawSession) ||
    stringValue(input.receipt.request_hash) !== input.requestHash ||
    (stringValue(input.receipt.executor_kind) !== undefined &&
      stringValue(input.receipt.executor_kind) !==
        executorForConversation(input.owner).kind)
  );
}

function validateStoredTerminalSubmissionMatch({
  owner,
  receipt,
  options,
  terminalControl,
  requestText,
  requestHash,
  expectedStoreDir,
  expectedSessionId,
  expectedTurnId,
  expectedMessageType,
  expectedStatePath
}: {
  owner: Conversation;
  receipt: Record<string, any>;
  options: Record<string, any>;
  terminalControl: TerminalControlRef;
  requestText: string;
  requestHash: string;
  expectedStoreDir: string;
  expectedSessionId?: string;
  expectedTurnId?: string;
  expectedMessageType: "task" | "answer";
  expectedStatePath?: string;
}): Record<string, any> | undefined {
  const messageId = required(
    stringValue(receipt.message_id),
    "stored terminal receipt message id is required"
  );
  const ownerStoreDir = managedSessionStoreDirForConversation(owner);
  const nativeTakeover = isRecord(owner.native_session_takeover)
    ? owner.native_session_takeover
    : undefined;
  const storedControl = terminalControlFromTakeover(nativeTakeover);
  const receiptStoreDir = stringValue(receipt.store_dir) ?? ownerStoreDir;
  const receiptSessionId = stringValue(receipt.session_id) ??
    sessionIdForConversation(owner);
  const receiptMatchesRecoveredSession = Boolean(
    expectedSessionId &&
    receiptSessionId !== expectedSessionId &&
    exactSafeAbortedRecoveredSessionMatches({
      owner,
      receipt,
      storeDir: expectedStoreDir,
      terminalControl,
      messageId,
      expectedSessionId
    })
  );
  const receiptTurnId = stringValue(receipt.turn_id) ??
    turnIdForConversation(owner);
  const receiptOpenClawSession = stringValue(receipt.openclaw_session) ??
    owner.openclaw_session;
  const receiptTerminalEvidence = receipt.terminal_endpoint !== undefined
    ? receipt.terminal_endpoint
    : {
        kind: "tmux",
        target: stringValue(receipt.terminal_target) ?? storedControl?.target,
        socket_path: receipt.terminal_socket_path === null
          ? null
          : stringValue(receipt.terminal_socket_path) ??
            storedControl?.socketPath ??
            null,
        pane_pid: Number(
          receipt.terminal_pane_pid ?? storedControl?.panePid
        )
      };
  const requestedOpenClawSession = stringValue(options.openclawSession);
  if (
    storedReceiptTerminalBoundaryMismatch({
      ownerStoreDir,
      receiptStoreDir,
      expectedStoreDir,
      storedControl,
      terminalControl,
      receiptTerminalEvidence
    }) ||
    storedReceiptAuthorityMismatch({
      owner,
      receipt,
      receiptSessionId,
      receiptTurnId,
      receiptOpenClawSession,
      receiptMatchesRecoveredSession,
      expectedSessionId,
      expectedTurnId,
      expectedStatePath,
      requestedOpenClawSession,
      requestHash
    })
  ) {
    throw new Error(
      `terminal idempotency key ${messageId} does not match its original ` +
      "Store, Session, Turn, controller session, or terminal binding; no terminal input was sent"
    );
  }

  const logPath = stringValue(owner.event_log_path);
  let loggedMessages: Record<string, any>[] = [];
  if (logPath) {
    try {
      loggedMessages = readNdjsonLog(logPath)
        .filter((event) =>
          isRecord(event.message) && event.message.id === messageId
        )
        .map((event) => event.message as Record<string, any>);
    } catch {
      loggedMessages = [];
    }
  }
  if (loggedMessages.length > 1) {
    throw new Error(
      `terminal idempotency key ${messageId} has duplicate durable messages`
    );
  }
  const loggedMessage = loggedMessages[0];
  if (
    isRecord(loggedMessage) &&
    replayLoggedMessageMismatch(
      loggedMessage,
      owner,
      expectedMessageType,
      requestText
    )
  ) {
    throw new Error(
      `terminal idempotency key ${messageId} does not match its durable message; no terminal input was sent`
    );
  }
  const durableMessageType = stringValue(receipt.message_type) ??
    (isRecord(loggedMessage) ? stringValue(loggedMessage.type) : undefined);
  const durableMessageBodyHash = stringValue(receipt.message_body_hash) ??
    (isRecord(loggedMessage) && typeof loggedMessage.body === "string"
      ? createHash("sha256").update(loggedMessage.body).digest("hex")
      : undefined);
  const expectedMessageBodyHash = createHash("sha256")
    .update(requestText)
    .digest("hex");
  if (
    durableMessageType !== expectedMessageType ||
    durableMessageBodyHash !== expectedMessageBodyHash
  ) {
    throw new Error(
      `terminal idempotency key ${messageId} was already used for a different message; no terminal input was sent`
    );
  }
  return loggedMessage;
}

function replayExactStoredTerminalSubmission({
  options,
  terminalControl,
  requestText,
  requestHash,
  messageId,
  expectedStoreDir,
  expectedSessionId,
  expectedTurnId,
  expectedMessageType,
  expectedStatePath,
  userExplicitTerminalId
}: {
  options: Record<string, any>;
  terminalControl: TerminalControlRef;
  requestText: string;
  requestHash: string;
  messageId: string;
  expectedStoreDir: string;
  expectedSessionId?: string;
  expectedTurnId?: string;
  expectedMessageType: "task" | "answer";
  expectedStatePath?: string;
  userExplicitTerminalId?: string;
}): boolean {
  const allMatches = listConversations(expectedStoreDir).flatMap((owner) =>
    terminalBridgeSubmissionReceipts(owner)
      .filter((receipt) => stringValue(receipt.message_id) === messageId)
      .map((receipt) => ({ owner, receipt }))
  );
  const validatedMatches = allMatches.map((match) => ({
    ...match,
    loggedMessage: validateStoredTerminalSubmissionMatch({
      ...match,
      options,
      terminalControl,
      requestText,
      requestHash,
      expectedStoreDir,
      expectedSessionId,
      expectedTurnId,
      expectedMessageType,
      expectedStatePath
    })
  }));
  const matches = validatedMatches.filter(({ receipt }) =>
    !(receipt.status === "aborted" && receipt.safe_to_retry === true)
  );
  if (matches.length > 1) {
    throw new Error(
      `terminal idempotency key ${messageId} has multiple durable receipts in one Store`
    );
  }
  const match = matches[0];
  if (!match) {
    for (const { owner, receipt } of validatedMatches) {
      if (expectedSessionId) {
        if (!exactSafeAbortedRecoveredSessionMatches({
          owner,
          receipt,
          storeDir: expectedStoreDir,
          terminalControl,
          messageId,
          expectedSessionId
        })) {
          throw new Error(
            `terminal idempotency key ${messageId} does not match its ` +
            "restored retry Session; no terminal input was sent"
          );
        }
      } else {
        assertSafeAbortedTerminalRetryBinding({
          owner,
          receipt,
          storeDir: expectedStoreDir,
          terminalControl,
          messageId
        });
      }
    }
    // A prepared-stage failure with a restored ledger proves that tmux was
    // untouched. The same exact id may therefore start a fresh attempt; all
    // immutable boundaries above were still validated before allowing it.
    return false;
  }
  const { owner, receipt, loggedMessage } = match;
  const nativeTakeover = isRecord(owner.native_session_takeover)
    ? owner.native_session_takeover
    : undefined;
  const currentSubmission = terminalBridgeSubmission(owner);

  const isCurrentSubmission =
    stringValue(currentSubmission?.message_id) === messageId;
  if (
    isCurrentSubmission &&
    !isTerminalDispatchOwnerReleasedStatus(owner.status)
  ) {
    return false;
  }
  if (!["submitted", "enter_dispatched", "agent_accepted"].includes(
    String(receipt.status)
  )) {
    throw new Error(
      `terminal idempotency key ${messageId} has durable ${String(receipt.status)} ` +
      "proof and must not be retried; no additional terminal input was sent"
    );
  }

  const executor = executorForConversation(owner);
  const nativeThreadId = stringValue(receipt.native_thread_id) ??
    stringValue(owner.native_thread_id) ??
    stringValue(nativeTakeover?.terminal_agent_session_id) ??
    stringValue(nativeTakeover?.terminal_agent_expected_session_id) ??
    sessionIdForConversation(owner);
  const proofLevel = String(receipt.status) as
    | "submitted"
    | "enter_dispatched"
    | "agent_accepted";
  const replayReceipt = dispatchReceipt.terminalSubmissionReplayReceipt({
    proofLevel,
    evidence: receipt.acceptance_evidence,
    expected: {
      source: executor.kind === "codex"
        ? "codex_rollout"
        : "claude_transcript",
      nativeThreadId,
      requestHash
    }
  });
  const replayedMessage = isRecord(loggedMessage)
    ? loggedMessage
    : createMessage({
        conversation: owner,
        id: messageId,
        from: "openclaw",
        to: executor.actor,
        type: expectedMessageType,
        body: requestText,
        metadata: {
          executor_kind: executor.kind,
          executor_session: executor.session
        }
      });
  const acceptanceInvalid = replayReceipt.submission_outcome === "uncertain";
  const callbackExpected = callbackExpectedForConversation(owner);
  presentTerminalDispatchReplay({
    owner,
    receipt: replayReceipt,
    accepted: replayReceipt.submission_outcome === "agent_accepted",
    acceptanceInvalid,
    receiptConversationId: owner.conversation_id,
    receiptMessageId: messageId,
    callbackExpected,
    ...(userExplicitTerminalId
      ? {
          userExplicit: {
            terminalId: userExplicitTerminalId,
            messageId
          }
        }
      : {})
  }, {
    message: replayedMessage as AgentMessage,
    executor,
    terminalControl
  }, {
    write: printJson,
    budget: budgetAction,
    nextAction: openClawYieldNextAction,
    summarize: textSummary
  });
  return true;
}

const terminalBridgeSubmission = dispatchReceipt.terminalBridgeSubmission;
const terminalBridgeSubmissionReceipts =
  dispatchReceipt.terminalBridgeSubmissionReceipts;
const unresolvedTerminalBridgeSubmission =
  dispatchReceipt.unresolvedTerminalBridgeSubmission;

function durableTerminalInputDispatched(
  conversation: Conversation
): boolean {
  try {
    return dispatchReceipt.terminalInputDispatchedForConversation(conversation);
  } catch {
    return dispatchReceipt.terminalSubmissionIndicatesInputDispatched(
      terminalBridgeSubmission(conversation)
    );
  }
}

function assertNoUnresolvedTerminalBridgeSubmission(
  storeDir: string,
  terminalControl: TerminalControlRef,
  currentConversationId: string,
  requestText: string
): void {
  const requestHash = terminalBridgeRequestFingerprint(requestText);
  for (const candidate of listConversations(storeDir)) {
    const submission = terminalBridgeSubmission(candidate);
    if (
      candidate.conversation_id === currentConversationId ||
      !submission ||
      isTerminalDispatchOwnerReleasedStatus(
        effectiveTurnStatus(candidate)
      ) ||
      ![
        "prepared",
        "text_injected",
        "enter_dispatched",
        "agent_accepted",
        "submitted",
        "not_accepted",
        "uncertain"
      ].includes(String(submission.status))
    ) {
      continue;
    }
    if (
      ["submitted", "agent_accepted"].includes(String(submission.status)) &&
      stringValue(submission.request_hash) !== requestHash
    ) {
      continue;
    }
    const nativeTakeover = isRecord(candidate.native_session_takeover)
      ? candidate.native_session_takeover
      : undefined;
    if (
      terminalControlsShareIncarnation(
        terminalControlFromTakeover(nativeTakeover),
        terminalControl
      )
    ) {
      throw new Error(
        `terminal ${terminalControl.target} has a conflicting ${String(submission.status)} ` +
        `AKK submission in ${candidate.conversation_id}; inspect that conversation and pane, ` +
        "then close it before retrying"
      );
    }
  }
}

function prepareManagedSend({
  options,
  statePath,
  logPath,
  messageBody,
  stateLockHeld = false,
  persist = true,
  rejectTerminalControl = false
}) {
  if (!stateLockHeld) {
    const releaseLock = acquireFileLock(`${statePath}.lock`);
    try {
      return prepareManagedSend({
        options,
        statePath,
        logPath,
        messageBody,
        stateLockHeld: true,
        persist,
        rejectTerminalControl
      });
    } finally {
      releaseLock();
    }
  }

  const conversation = loadState(statePath);
  if (
    conversation.status !== "waiting_for_openclaw" ||
    options.type !== "answer"
  ) {
    throw new Error(
      `cannot respond to turn ${turnIdForConversation(conversation)}; ` +
      `turn is ${conversation.status}`
    );
  }

  const executor = executorForConversation(conversation);
  const type = "answer";
  const nativeTakeoverForSend = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const unresolvedSubmission = unresolvedTerminalBridgeSubmission(conversation);
  if (unresolvedSubmission) {
    throw new Error(
      `cannot send to ${conversation.conversation_id}; its previous terminal submission is ` +
      `${unresolvedSubmission.status}. Inspect the conversation and terminal pane, then close ` +
      "the AKK conversation before creating a replacement task."
    );
  }
  if (
    rejectTerminalControl &&
    terminalControlFromTakeover(nativeTakeoverForSend)
  ) {
    throw new Error(
      "terminal control changed while waiting to send; refresh status and retry"
    );
  }
  const message = createMessage({
    conversation,
    id: stringValue(options.messageId),
    from: "openclaw",
    to: executor.actor,
    type,
    body: messageBody,
    metadata: {
      executor_kind: executor.kind,
      executor_session: executor.session
    }
  });
  const nextConversation = {
    ...applyMessageToConversation(conversation, message),
    executor,
    claude_session: executor.kind === "claude"
      ? executor.session
      : conversation.claude_session
  };
  if (persist) {
    saveState(statePath, nextConversation);
    appendEvent(logPath, messageEvent(message));
    runtimeLog("info", "message_created", {
      conversation_id: conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      message_type: type,
      state_path: statePath,
      event_log_path: logPath,
      message: textSummary(messageBody)
    });
  }
  return {
    conversation,
    executor,
    nativeTakeoverForSend,
    message,
    nextConversation
  };
}

function assertTerminalSubmissionRetryOptions(
  options: TerminalCommandCliOptions
): string {
  const turnId = required(stringValue(options.turn), "--turn is required");
  const allowed = new Set(["turn", "storeDir"]);
  const conflicts = Object.keys(options).filter(
    (option) => options[option] !== undefined && !allowed.has(option)
  );
  if (conflicts.length > 0) {
    throw new Error(
      "send --turn is an exact submission recovery form and cannot be " +
      `combined with ${conflicts.map((option) => `--${option}`).join(", ")}; ` +
      "no terminal input was sent"
    );
  }
  return turnId;
}

function terminalSubmissionRetryBaseRecord(input: {
  mode: "exact_draft_enter" | "replacement_send";
  state: TerminalSubmissionRetryRecord["state"];
  attemptId: string;
  storeDir: string;
  statePath: string;
  conversation: Conversation;
  originalMessageId: string;
  activeMessageId: string;
  requestHash: string;
  terminalControl: TerminalControlRef;
  at: string;
  deferredTransferId?: string;
}): TerminalSubmissionRetryRecord {
  return {
    schema: TERMINAL_SUBMISSION_RETRY_SCHEMA,
    version: TERMINAL_SUBMISSION_RETRY_VERSION,
    revision: 1,
    attempt_id: input.attemptId,
    mode: input.mode,
    state: input.state,
    store_dir: path.resolve(input.storeDir),
    state_path: path.resolve(input.statePath),
    session_id: sessionIdForConversation(input.conversation),
    turn_id: turnIdForConversation(input.conversation),
    original_message_id: input.originalMessageId,
    active_message_id: input.activeMessageId,
    request_hash: input.requestHash,
    terminal_target: input.terminalControl.target,
    callback_route_fingerprint:
      callbackRouteFingerprintForConversation(input.conversation) ?? null,
    deferred_foreground_transfer_id: input.deferredTransferId ?? null,
    reserved_at: input.at,
    updated_at: input.at
  };
}

function assertTerminalSubmissionRetryAttemptIdentity(input: {
  attempt?: TerminalSubmissionRetryRecord;
  conversation: Conversation;
  storeDir: string;
  statePath: string;
  originalMessageId: string;
  requestHash: string;
  terminalControl: TerminalControlRef;
  deferredTransferId?: string;
}): void {
  const attempt = input.attempt;
  if (!attempt) return;
  const callbackFingerprint =
    callbackRouteFingerprintForConversation(input.conversation) ?? null;
  if (
    attempt.store_dir !== path.resolve(input.storeDir) ||
    attempt.state_path !== path.resolve(input.statePath) ||
    attempt.session_id !== sessionIdForConversation(input.conversation) ||
    attempt.turn_id !== turnIdForConversation(input.conversation) ||
    attempt.original_message_id !== input.originalMessageId ||
    attempt.request_hash !== input.requestHash ||
    attempt.terminal_target !== input.terminalControl.target ||
    attempt.callback_route_fingerprint !== callbackFingerprint ||
    attempt.deferred_foreground_transfer_id !==
      (input.deferredTransferId ?? null)
  ) {
    throw new Error(
      "terminal submission retry authority changed; no terminal input was sent"
    );
  }
}

function terminalSubmissionRetryMessageType(
  submission: TerminalDispatchRecord
): "task" | "answer" {
  const messageType = stringValue(submission.message_type);
  if (messageType !== "task" && messageType !== "answer") {
    throw new Error(
      "terminal submission retry message type is unavailable; no terminal input was sent"
    );
  }
  return messageType;
}

function withDeferredTransferSubmissionAuthority(
  conversation: Conversation,
  messageId: string,
  transferId: string
): Conversation {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(conversation);
  if (!takeover || !submission || submission.message_id !== messageId) {
    throw new Error(
      "cannot upgrade deferred transfer authority on a changed submission"
    );
  }
  const existing = stringValue(submission.deferred_foreground_transfer_id);
  if (existing && existing !== transferId) {
    throw new Error("deferred transfer receipt authority conflicts");
  }
  const receiptsValue = takeover.terminal_bridge_submission_receipts;
  if (receiptsValue !== undefined && !Array.isArray(receiptsValue)) {
    throw new Error("terminal submission receipt history is malformed");
  }
  const receipts = (Array.isArray(receiptsValue) ? receiptsValue : []).map(
    (receipt) => {
      if (!isRecord(receipt) || !stringValue(receipt.message_id)) {
        throw new Error("terminal submission receipt history is malformed");
      }
      if (receipt.message_id !== messageId) return receipt;
      const receiptTransferId = stringValue(
        receipt.deferred_foreground_transfer_id
      );
      if (receiptTransferId && receiptTransferId !== transferId) {
        throw new Error("deferred transfer receipt history conflicts");
      }
      return {
        ...receipt,
        deferred_foreground_transfer_id: transferId
      };
    }
  );
  return {
    ...conversation,
    native_session_takeover: {
      ...takeover,
      deferred_foreground_transfer_id: transferId,
      terminal_bridge_submission: {
        ...submission,
        deferred_foreground_transfer_id: transferId
      },
      terminal_bridge_submission_receipts: receipts
    }
  };
}

function terminalSubmissionRetryUnstalled(
  conversation: Conversation
): Conversation {
  const next: Conversation = {
    ...conversation,
    status: "waiting_for_agent"
  };
  delete next.stalled_at;
  delete next.stalled_reason;
  delete next.failed_at;
  delete next.failure_reason;
  delete next.idle_since;
  return next;
}

function withTerminalSubmissionRetryMonitorEpoch(
  conversation: Conversation,
  at: string
): Conversation {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
  const configuredInactivity = Number(
    takeover.terminal_bridge_inactivity_timeout_minutes
  );
  const configuredHard = Number(
    takeover.terminal_bridge_hard_timeout_minutes
  );
  const inactivityMinutes = Number.isFinite(configuredInactivity) &&
      configuredInactivity > 0
    ? configuredInactivity
    : DEFAULT_AGENT_TIMEOUT_MINUTES;
  const hardMinutes = Number.isFinite(configuredHard) && configuredHard > 0
    ? configuredHard
    : DEFAULT_AGENT_HARD_TIMEOUT_MINUTES;
  return {
    ...conversation,
    native_session_takeover: {
      ...takeover,
      terminal_bridge_started_at: at,
      terminal_bridge_monitor_started_at: at,
      terminal_bridge_last_activity_at: at,
      terminal_bridge_last_activity_reason:
        "submission retry Enter dispatched",
      terminal_bridge_inactivity_timeout_minutes: inactivityMinutes,
      terminal_bridge_hard_timeout_minutes: hardMinutes,
      terminal_bridge_inactivity_deadline_at: deadlineAt(
        at,
        inactivityMinutes
      ),
      terminal_bridge_hard_deadline_at: deadlineAt(at, hardMinutes)
    },
    updated_at: at
  };
}

function terminalSubmissionRetryAccepted(input: {
  conversation: Conversation;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
  evidence: NonNullable<Awaited<ReturnType<
    TerminalDispatchExecutionService["detectAcceptance"]
  >>>;
  requestText: string;
  at: string;
  statePath: string;
  logPath: string;
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
  attempt?: TerminalSubmissionRetryRecord;
  terminalInputSent: boolean;
}): { conversation: Conversation; attempt?: TerminalSubmissionRetryRecord } {
  const currentConversation = assertTerminalSubmissionRetryTurnOpen({
    statePath: input.statePath,
    exactTurnId: turnIdForConversation(input.conversation)
  });
  const messageId = required(
    stringValue(input.submission.message_id),
    "terminal submission retry message id is unavailable"
  );
  const preparedAt = required(
    stringValue(input.submission.prepared_at),
    "terminal submission retry prepared timestamp is unavailable"
  );
  const acceptedConversation = withTerminalBridgeSubmission({
    conversation: terminalSubmissionRetryUnstalled(currentConversation),
    messageId,
    messageType: terminalSubmissionRetryMessageType(input.submission),
    requestText: input.requestText,
    status: "agent_accepted",
    preparedAt,
    textInjectedAt: stringValue(input.submission.text_injected_at),
    enterDispatchedAt: stringValue(input.submission.enter_dispatched_at),
    agentAcceptedAt: input.at,
    acceptanceEvidence: input.evidence,
    lastProvenStage: "agent_accepted"
  });
  saveState(input.statePath, acceptedConversation);
  let acceptedAttempt = input.attempt;
  if (acceptedAttempt && acceptedAttempt.state !== "agent_accepted") {
    acceptedAttempt = saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
      ...acceptedAttempt,
      state: "agent_accepted",
      agent_accepted_at: input.at,
      updated_at: input.at
    }, acceptedAttempt.revision);
  }
  mutationDispatchLedger.save(input.scopes, input.resources, {
    ...input.ledger,
    ...terminalSubmissionRetryLedgerFields(acceptedAttempt),
    status: "agent_accepted",
    text_injected_at: stringValue(input.ledger.text_injected_at),
    enter_dispatched_at: stringValue(input.ledger.enter_dispatched_at),
    agent_accepted_at: input.at,
    acceptance_evidence: input.evidence,
    dispatcher_pid: null
  });
  appendEvent(input.logPath, {
    ts: input.at,
    conversation_id: acceptedConversation.conversation_id,
    event: "terminal_submission_retry_agent_accepted",
    message_id: messageId,
    terminal_input_sent: input.terminalInputSent
  });
  return { conversation: acceptedConversation, attempt: acceptedAttempt };
}

function terminalSubmissionRetryTerminalOutcome(input: {
  conversation: Conversation;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
  requestText: string;
  reason: string;
  at: string;
  statePath: string;
  logPath: string;
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
  attempt: TerminalSubmissionRetryRecord;
  outcome: "not_accepted" | "uncertain";
}): Conversation {
  const currentConversation = assertTerminalSubmissionRetryTurnOpen({
    statePath: input.statePath,
    exactTurnId: turnIdForConversation(input.conversation)
  });
  const messageId = required(
    stringValue(input.submission.message_id),
    "terminal submission retry message id is unavailable"
  );
  const preparedAt = required(
    stringValue(input.submission.prepared_at),
    "terminal submission retry prepared timestamp is unavailable"
  );
  const stalled: Conversation = {
    ...currentConversation,
    status: "stalled",
    stalled_at: input.at,
    stalled_reason: input.reason,
    updated_at: input.at
  };
  const conversation = withTerminalBridgeSubmission({
    conversation: stalled,
    messageId,
    messageType: terminalSubmissionRetryMessageType(input.submission),
    requestText: input.requestText,
    status: input.outcome,
    preparedAt,
    textInjectedAt: stringValue(input.submission.text_injected_at),
    enterDispatchedAt: stringValue(input.submission.enter_dispatched_at),
    ...(input.outcome === "not_accepted"
      ? { notAcceptedAt: input.at }
      : {
          uncertainAt: input.at,
          error: input.reason,
          safeToRetry: false
        }),
    lastProvenStage: "enter_dispatched"
  });
  saveState(input.statePath, conversation);
  mutationDispatchLedger.save(input.scopes, input.resources, {
    ...input.ledger,
    ...terminalSubmissionRetryLedgerFields(input.attempt),
    status: input.outcome,
    ...(input.outcome === "not_accepted"
      ? {
          not_accepted_at: input.at,
          uncertain_at: undefined,
          error: undefined,
          safe_to_retry: undefined
        }
      : {
          not_accepted_at: undefined,
          uncertain_at: input.at,
          error: input.reason,
          safe_to_retry: false
        }),
    acceptance_evidence: undefined,
    agent_accepted_at: undefined,
    dispatcher_pid: null
  });
  appendEvent(input.logPath, {
    ts: input.at,
    conversation_id: conversation.conversation_id,
    event: `terminal_submission_retry_${input.outcome}`,
    message_id: messageId,
    terminal_input_sent: true,
    reason: input.reason,
    do_not_retry: true
  });
  return conversation;
}

function finalizeDeferredTerminalSubmissionRetryAccepted(input: {
  statePath: string;
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
  attempt?: TerminalSubmissionRetryRecord;
}): { conversation: Conversation; attempt?: TerminalSubmissionRetryRecord } {
  const conversation = loadState(input.statePath);
  if (conversation.status === "closed") {
    throw new Error(
      `cannot finalize submission retry for closed Turn ` +
      `${turnIdForConversation(conversation)}; no retry state was changed`
    );
  }
  if (
    input.attempt &&
    turnIdForConversation(conversation) !== input.attempt.turn_id
  ) {
    throw new Error(
      "Turn identity changed during submission retry finalization; no retry " +
      "state was changed"
    );
  }
  const submission = required(
    terminalBridgeSubmission(conversation),
    "deferred submission retry acceptance lost its Turn receipt"
  );
  const ledger = required(
    mutationDispatchLedger.load(input.scopes, input.resources),
    "deferred submission retry acceptance lost its dispatch ledger"
  );
  if (
    submission.status !== "agent_accepted" ||
    ledger.status !== "agent_accepted"
  ) {
    throw new Error(
      "deferred submission retry acceptance was not durably finalized"
    );
  }
  let attempt = input.attempt;
  if (attempt && attempt.state !== "agent_accepted") {
    const acceptedAt = stringValue(submission.agent_accepted_at) ??
      stringValue(ledger.agent_accepted_at) ?? cliNow().toISOString();
    attempt = saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
      ...attempt,
      state: "agent_accepted",
      agent_accepted_at: acceptedAt,
      updated_at: acceptedAt
    }, attempt.revision);
  }
  if (attempt) {
    mutationDispatchLedger.save(input.scopes, input.resources, {
      ...ledger,
      ...terminalSubmissionRetryLedgerFields(attempt)
    });
  }
  return { conversation, attempt };
}

function reconcileTerminalSubmissionRetryPending(input: {
  conversation: Conversation;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
  attempt: TerminalSubmissionRetryRecord;
  requestText: string;
  statePath: string;
  logPath: string;
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
  deferred?: TerminalSubmissionRetryDeferredContext;
}): Conversation {
  const currentConversation = assertTerminalSubmissionRetryTurnOpen({
    statePath: input.statePath,
    exactTurnId: turnIdForConversation(input.conversation)
  });
  const { attempt, submission, ledger } = input;
  const projection = projectTerminalSubmissionRetryPending({
    attempt,
    submission,
    ledger
  });
  const {
    messageId,
    preparedAt,
    textInjectedAt,
    enterDispatchedAt
  } = projection;
  if (input.deferred) {
    const transfer = input.deferred.scope.loadTransfer(
      input.deferred.transfer.transfer_id
    );
    if (!isDeferredForegroundSubmissionRetryPending(transfer)) {
      throw new Error(
        "deferred submission retry lacks exact pending transfer authority"
      );
    }
    input.deferred.transfer = transfer;
  }
  const enteredConversation = withTerminalBridgeSubmission({
    conversation: withTerminalSubmissionRetryMonitorEpoch(
      terminalSubmissionRetryUnstalled(currentConversation),
      enterDispatchedAt
    ),
    messageId,
    messageType: terminalSubmissionRetryMessageType(submission),
    requestText: input.requestText,
    status: "enter_dispatched",
    preparedAt,
    textInjectedAt,
    enterDispatchedAt,
    lastProvenStage: "enter_dispatched"
  });
  saveState(input.statePath, enteredConversation);
  mutationDispatchLedger.save(input.scopes, input.resources, {
    ...ledger,
    ...terminalSubmissionRetryLedgerFields(attempt),
    status: "enter_dispatched",
    text_injected_at: textInjectedAt,
    enter_dispatched_at: enterDispatchedAt,
    enter_not_attempted_at: undefined,
    enter_not_attempted_reason: undefined,
    uncertain_at: undefined,
    safe_to_retry: undefined,
    acceptance_evidence: undefined,
    agent_accepted_at: undefined,
    not_accepted_at: undefined,
    dispatcher_pid: null
  });
  appendEvent(input.logPath, {
    ts: enterDispatchedAt,
    conversation_id: enteredConversation.conversation_id,
    event: "terminal_submission_retry_pending_reconciled",
    message_id: messageId,
    terminal_input_sent: false
  });
  return enteredConversation;
}

const TERMINAL_SUBMISSION_RETRY_LEDGER_KEYS = [
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

function assertTerminalSubmissionRetryDeferredMirror(input: {
  attempt: TerminalSubmissionRetryRecord;
  transfer: DeferredForegroundTransfer;
  submission: TerminalDispatchRecord;
}): void {
  const { attempt, transfer, submission } = input;
  const replacement = attempt.mode === "replacement_send";
  const stateRank = terminalSubmissionRetryTransportRank(attempt);
  const expectedPreparedAt = stringValue(submission.prepared_at);
  if (
    transfer.status !== "uncertain" ||
    transfer.message_id !== attempt.original_message_id ||
    transfer.submission_retry_attempt_id !== attempt.attempt_id ||
    transfer.submission_retry_mode !== attempt.mode ||
    transfer.submission_retry_message_id !== attempt.active_message_id ||
    transfer.submission_retry_message_id !== transfer.message_id ||
    transfer.submission_retry_prepared_at !== expectedPreparedAt ||
    transfer.submission_retry_prepared_at !== transfer.prepared_at ||
    transfer.submission_retry_text_reserved_at !==
      (replacement && stateRank >= 1
        ? attempt.replacement_text_reserved_at
        : undefined) ||
    transfer.submission_retry_text_injected_at !==
      (replacement && stateRank >= 2
        ? attempt.replacement_text_injected_at
        : undefined) ||
    transfer.submission_retry_enter_reserved_at !==
      (stateRank >= (replacement ? 3 : 0)
        ? attempt.enter_reserved_at
        : undefined) ||
    transfer.submission_retry_enter_dispatched_at !==
      (stateRank >= (replacement ? 4 : 1)
        ? attempt.enter_dispatched_at
        : undefined) ||
    (attempt.state === "enter_dispatched"
      ? transfer.input_stage !== "enter_dispatched" ||
        transfer.enter_dispatched_at !== attempt.enter_dispatched_at
      : transfer.input_stage !== "text_injected")
  ) {
    throw new Error(
      "deferred submission retry mirror conflicts with its durable attempt"
    );
  }
}

function assertTerminalSubmissionRetryDeferredMirrorCanReconcile(input: {
  attempt: TerminalSubmissionRetryRecord;
  transfer: DeferredForegroundTransfer;
  submission: TerminalDispatchRecord;
}): void {
  const { attempt, transfer, submission } = input;
  const expectedPreparedAt = stringValue(submission.prepared_at);
  const retryFields = [
    transfer.submission_retry_attempt_id,
    transfer.submission_retry_mode,
    transfer.submission_retry_message_id,
    transfer.submission_retry_prepared_at,
    transfer.submission_retry_text_reserved_at,
    transfer.submission_retry_text_injected_at,
    transfer.submission_retry_enter_reserved_at,
    transfer.submission_retry_enter_dispatched_at
  ];
  if (transfer.submission_retry_attempt_id === undefined) {
    const initialAttempt =
      (attempt.mode === "replacement_send" &&
        attempt.state === "replacement_reserved") ||
      (attempt.mode === "exact_draft_enter" &&
        attempt.state === "enter_reserved");
    if (!initialAttempt || retryFields.some((value) => value !== undefined)) {
      throw new Error(
        "deferred submission retry mirror is missing beyond its first recoverable write"
      );
    }
    return;
  }
  if (
    transfer.submission_retry_attempt_id !== attempt.attempt_id ||
    transfer.submission_retry_mode !== attempt.mode ||
    transfer.submission_retry_message_id !== attempt.active_message_id ||
    transfer.submission_retry_message_id !== transfer.message_id ||
    transfer.submission_retry_prepared_at !== expectedPreparedAt ||
    transfer.submission_retry_prepared_at !== transfer.prepared_at
  ) {
    throw new Error(
      "deferred submission retry mirror identity conflicts with its durable attempt"
    );
  }
  const expectedStages = {
    submission_retry_text_reserved_at:
      attempt.mode === "replacement_send"
        ? attempt.replacement_text_reserved_at
        : undefined,
    submission_retry_text_injected_at:
      attempt.mode === "replacement_send"
        ? attempt.replacement_text_injected_at
        : undefined,
    submission_retry_enter_reserved_at: attempt.enter_reserved_at,
    submission_retry_enter_dispatched_at: attempt.enter_dispatched_at
  } as const;
  for (const field of Object.keys(expectedStages) as
    (keyof typeof expectedStages)[]) {
    const actual = transfer[field];
    const expected = expectedStages[field];
    if (actual !== undefined && actual !== expected) {
      throw new Error(
        "deferred submission retry mirror stage conflicts with its durable attempt"
      );
    }
  }
  const transferRank = attempt.mode === "replacement_send"
    ? transfer.submission_retry_enter_dispatched_at !== undefined
      ? 4
      : transfer.submission_retry_enter_reserved_at !== undefined
        ? 3
        : transfer.submission_retry_text_injected_at !== undefined
          ? 2
          : transfer.submission_retry_text_reserved_at !== undefined
            ? 1
            : 0
    : transfer.submission_retry_enter_dispatched_at !== undefined
      ? 1
      : transfer.submission_retry_enter_reserved_at !== undefined
        ? 0
        : -1;
  const attemptRank = terminalSubmissionRetryTransportRank(attempt);
  if (transferRank > attemptRank || attemptRank - transferRank > 1) {
    throw new Error(
      "deferred submission retry mirror is ahead or more than one stage behind"
    );
  }
}

function terminalSubmissionRetryTransportRank(
  attempt: TerminalSubmissionRetryRecord
): number {
  const order = attempt.mode === "replacement_send"
    ? [
        "replacement_reserved", "replacement_text_reserved",
        "replacement_text_injected", "enter_reserved", "enter_dispatched"
      ]
    : ["enter_reserved", "enter_dispatched"];
  return order.indexOf(attempt.state);
}

function reconcileTerminalSubmissionRetryLedgerPrefix(input: {
  attempt: TerminalSubmissionRetryRecord;
  ledger: TerminalDispatchLedgerDocument;
}): { ledger: TerminalDispatchLedgerDocument; changed: boolean } {
  const { attempt, ledger } = input;
  if (attempt.state === "agent_accepted") {
    return { ledger, changed: false };
  }
  const currentAttemptId = stringValue(ledger.submission_retry_attempt_id);
  const currentHasRetryFields = TERMINAL_SUBMISSION_RETRY_LEDGER_KEYS.some(
    (key) => ledger[key] !== undefined
  );
  if (!currentAttemptId) {
    if (currentHasRetryFields || attempt.revision !== 1) {
      throw new Error(
        "terminal submission retry ledger has an unsafe missing retry prefix"
      );
    }
    return {
      ledger: { ...ledger, ...terminalSubmissionRetryLedgerFields(attempt) },
      changed: true
    };
  }
  const currentState = stringValue(ledger.submission_retry_state);
  const currentRevision = Number(ledger.submission_retry_revision);
  const allowedStates = terminalSubmissionRetryLedgerStates(attempt);
  const same = currentState === attempt.state &&
    currentRevision === attempt.revision;
  const immediatelyLagging = currentState === allowedStates.previous &&
    currentRevision === attempt.revision - 1;
  if (!same && !immediatelyLagging) {
    throw new Error(
      "terminal submission retry ledger is ahead, conflicting, or more than one stage behind"
    );
  }
  const expectedCurrent = terminalSubmissionRetryLedgerFieldsAtState(
    attempt,
    currentState as TerminalSubmissionRetryRecord["state"],
    currentRevision
  );
  if (TERMINAL_SUBMISSION_RETRY_LEDGER_KEYS.some(
    (key) => JSON.stringify(ledger[key]) !== JSON.stringify(expectedCurrent[key])
  )) {
    throw new Error(
      "terminal submission retry ledger prefix conflicts with its durable attempt"
    );
  }
  return same
    ? { ledger, changed: false }
    : {
        ledger: { ...ledger, ...terminalSubmissionRetryLedgerFields(attempt) },
        changed: true
      };
}

function terminalSubmissionRetryLedgerStates(
  attempt: TerminalSubmissionRetryRecord
): { previous?: TerminalSubmissionRetryRecord["state"] } {
  const order: TerminalSubmissionRetryRecord["state"][] =
    attempt.mode === "replacement_send"
      ? [
          "replacement_reserved", "replacement_text_reserved",
          "replacement_text_injected", "enter_reserved", "enter_dispatched"
        ]
      : ["enter_reserved", "enter_dispatched"];
  const index = order.indexOf(attempt.state);
  return { previous: index > 0 ? order[index - 1] : undefined };
}

function terminalSubmissionRetryLedgerFieldsAtState(
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

function printTerminalSubmissionRetryOutcome(input: {
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  attempt?: TerminalSubmissionRetryRecord;
  outcome: "agent_accepted" | "enter_dispatched" | "not_accepted" |
    "refused";
  terminalInputSent: boolean;
  reason: string;
}): void {
  const submission = terminalBridgeSubmission(input.conversation);
  const enterDispatched = input.terminalInputSent ||
    ["agent_accepted", "enter_dispatched", "not_accepted"].includes(
      input.outcome
    ) ||
    terminalSendEnterDispatched(submission) ||
    ["enter_dispatched", "agent_accepted"].includes(
      String(input.attempt?.state ?? "")
    );
  const terminalInputDispatched = enterDispatched ||
    durableTerminalInputDispatched(input.conversation);
  const accepted = input.outcome === "agent_accepted";
  const pending = input.outcome === "enter_dispatched";
  const callbackAvailable =
    !isTerminalDispatchOwnerReleasedStatus(input.conversation.status) &&
    (accepted || pending) &&
    callbackExpectedForConversation(input.conversation);
  printJson({
    session_id: sessionIdForConversation(input.conversation),
    turn_id: turnIdForConversation(input.conversation),
    conversation: input.conversation,
    delivered: enterDispatched,
    delivery_receipt: accepted
      ? "agent_accepted"
      : input.outcome === "enter_dispatched" ||
          input.outcome === "not_accepted"
        ? "enter_dispatched"
        : "uncertain",
    status: input.outcome === "agent_accepted"
      ? "async_pending"
      : input.outcome === "enter_dispatched"
        ? "submission_pending"
        : input.outcome === "not_accepted"
          ? "submission_not_accepted"
        : "submission_uncertain",
    submission_outcome: input.outcome === "enter_dispatched"
      ? "pending_acceptance"
      : input.outcome === "not_accepted"
        ? "not_accepted"
      : input.outcome === "refused"
        ? "uncertain"
        : "agent_accepted",
    replayed: true,
    terminal_control: input.terminalControl,
    terminal_input_sent: input.terminalInputSent,
    callback_expected: callbackAvailable,
    ...terminalSendResultContract({
      terminalInputDispatched,
      agentAcceptance: accepted ? "proven" : "unproven",
      managementMode: "managed",
      observationMode: callbackAvailable ? "managed_monitor" : "none",
      callbackAvailable,
      interactionNotificationAvailable: accepted,
      interactionResponseAvailable: accepted
    }),
    ...(input.attempt
      ? {
          submission_retry_attempt_id: input.attempt.attempt_id,
          submission_retry_state: input.attempt.state
        }
      : {}),
    do_not_retry: input.outcome !== "agent_accepted",
    reason: input.reason
  });
}

interface TerminalSubmissionRetryDeferredContext {
  scope: DeferredForegroundApplicationScope;
  transfer: DeferredForegroundTransfer;
  boundary: DeferredCodexForegroundBindingBoundary;
}

interface TerminalSubmissionRetryInvocation {
  options: TerminalCommandCliOptions;
  exactTurnId: string;
  statePath: string;
  logPath: string;
  storeDir: string;
  bridge: TerminalAgentBridge;
  live: TerminalDispatchTerminal;
  terminalControl: TerminalControlRef;
}

interface TerminalSubmissionRetryLockedAuthority {
  conversation: Conversation;
  takeover?: Record<string, unknown>;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
  attempt?: TerminalSubmissionRetryRecord;
  currentMessageId: string;
  originalMessageId: string;
  requestText: string;
  requestHash: string;
  deferredTransferId?: string;
  lifecycleSettled: boolean;
}

function loadExactTerminalSubmissionRetryTurn(input: {
  statePath: string;
  exactTurnId: string;
}): Conversation {
  const conversation = loadState(input.statePath);
  if (turnIdForConversation(conversation) !== input.exactTurnId) {
    throw new Error(
      "Turn identity changed during submission retry; no terminal input was " +
      "sent and no retry state was changed"
    );
  }
  return conversation;
}

function assertTerminalSubmissionRetryTurnOpen(input: {
  statePath: string;
  exactTurnId: string;
}): Conversation {
  const conversation = loadExactTerminalSubmissionRetryTurn(input);
  if (conversation.status === "closed") {
    throw new Error(
      `cannot retry submission for closed Turn ${input.exactTurnId}; no ` +
      "terminal input was sent and no retry state was changed"
    );
  }
  return conversation;
}

function saveTerminalSubmissionRetryForOpenTurn(
  statePath: string,
  candidate: TerminalSubmissionRetryRecord,
  expectedRevision: number | null
): TerminalSubmissionRetryRecord {
  assertTerminalSubmissionRetryTurnOpen({
    statePath,
    exactTurnId: candidate.turn_id
  });
  return saveTerminalSubmissionRetry(
    statePath,
    candidate,
    expectedRevision
  );
}

function loadTerminalSubmissionRetryLockedAuthority(input: {
  invocation: TerminalSubmissionRetryInvocation;
  scopes: CanonicalStateMutationScopes;
  resources: CanonicalStateMutationResources;
}): TerminalSubmissionRetryLockedAuthority {
  const {
    options, exactTurnId, statePath, logPath, storeDir, terminalControl
  } = input.invocation;
  const route = bindTerminalDispatchRoute(input.scopes, input.resources);
  assertTerminalDispatchRouteMatches(route, {
    terminalControl,
    terminalKey: terminalBridgeRuntimeKey(terminalControl),
    storeDir,
    statePath,
    logPath
  });
  let conversation = assertTerminalSubmissionRetryTurnOpen({
    statePath,
    exactTurnId
  });
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const lockedControl = terminalControlFromTakeover(takeover);
  if (
    turnIdForConversation(conversation) !== exactTurnId ||
    executorForConversation(conversation).kind !== "codex" ||
    !lockedControl ||
    !terminalControlsShareIncarnation(lockedControl, terminalControl)
  ) {
    throw new Error(
      "Turn or terminal authority changed before submission retry; no terminal input was sent"
    );
  }
  let submission = terminalBridgeSubmission(conversation);
  if (!submission) {
    throw new Error(
      "Turn has no terminal submission receipt to recover; no terminal input was sent"
    );
  }
  const currentMessageId = required(
    stringValue(submission.message_id),
    "terminal submission retry message id is unavailable"
  );
  const attempt = loadTerminalSubmissionRetry(statePath);
  const originalMessageId = attempt?.original_message_id ?? currentMessageId;
  const requestText = terminalSubmissionPayload(required(
    stringValue(takeover?.terminal_bridge_request_text),
    "terminal submission retry request text is unavailable"
  ));
  const requestHash = required(
    terminalBridgeRequestFingerprint(requestText),
    "terminal submission retry request hash is unavailable"
  );
  const messageType = terminalSubmissionRetryMessageType(submission);
  const messageBodyHash = createHash("sha256").update(requestText).digest("hex");
  validateStoredTerminalSubmissionMatch({
    owner: conversation,
    receipt: submission,
    options,
    terminalControl,
    requestText,
    requestHash,
    expectedStoreDir: storeDir,
    expectedSessionId: sessionIdForConversation(conversation),
    expectedTurnId: exactTurnId,
    expectedMessageType: messageType,
    expectedStatePath: statePath
  });
  const ledger = mutationDispatchLedger.load(input.scopes, input.resources);
  assertTerminalSubmissionRetryLedgerAuthority({
    ledger,
    conversation,
    exactTurnId,
    currentMessageId,
    messageType,
    messageBodyHash,
    requestHash,
    storeDir,
    statePath,
    terminalControl
  });
  let currentLedger = ledger as TerminalDispatchLedgerDocument;
  const takeoverDeferredTransferId = stringValue(
    takeover?.deferred_foreground_transfer_id
  );
  const ledgerDeferredTransferId = stringValue(
    currentLedger.deferred_foreground_transfer_id
  );
  if (
    takeoverDeferredTransferId &&
    takeoverDeferredTransferId === ledgerDeferredTransferId &&
    stringValue(submission.deferred_foreground_transfer_id) === undefined
  ) {
    conversation = withDeferredTransferSubmissionAuthority(
      conversation,
      currentMessageId,
      takeoverDeferredTransferId
    );
    saveState(statePath, conversation);
    submission = required(
      terminalBridgeSubmission(conversation),
      "deferred terminal submission receipt upgrade failed"
    );
  }
  const expectedCallbackFingerprint =
    callbackRouteFingerprintForConversation(conversation) ?? null;
  if (
    (currentLedger.callback_route_fingerprint ?? null) !==
      expectedCallbackFingerprint ||
    (submission.callback_route_fingerprint ?? null) !==
      expectedCallbackFingerprint
  ) {
    throw new Error(
      "terminal submission callback route changed; no terminal input was sent"
    );
  }
  const deferredTransferId = exactTerminalSubmissionRetryDeferredTransferId({
    takeover,
    submission,
    ledger: currentLedger
  });
  assertTerminalSubmissionRetryAttemptIdentity({
    attempt,
    conversation,
    storeDir,
    statePath,
    originalMessageId,
    requestHash,
    terminalControl,
    deferredTransferId
  });
  assertTerminalSubmissionRetryGeneration({
    attempt,
    takeover,
    currentMessageId,
    originalMessageId
  });
  const callbackDelivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  return {
    conversation,
    takeover,
    submission,
    ledger: currentLedger,
    attempt,
    currentMessageId,
    originalMessageId,
    requestText,
    requestHash,
    deferredTransferId,
    lifecycleSettled: callbackDelivery?.status === "delivered" ||
      isTerminalDispatchOwnerReleasedStatus(effectiveTurnStatus(conversation))
  };
}

function assertTerminalSubmissionRetryLedgerAuthority(input: {
  ledger?: TerminalDispatchLedgerDocument;
  conversation: Conversation;
  exactTurnId: string;
  currentMessageId: string;
  messageType: "task" | "answer";
  messageBodyHash: string;
  requestHash: string;
  storeDir: string;
  statePath: string;
  terminalControl: TerminalControlRef;
}): asserts input is typeof input & { ledger: TerminalDispatchLedgerDocument } {
  const { ledger } = input;
  if (
    !ledger || terminalDispatchLedgerLooksLifecycle(ledger) ||
    stringValue(ledger.conversation_id) !== input.conversation.conversation_id ||
    stringValue(ledger.session_id) !== sessionIdForConversation(input.conversation) ||
    stringValue(ledger.turn_id) !== input.exactTurnId ||
    stringValue(ledger.generation_id) !== input.currentMessageId ||
    stringValue(ledger.message_id) !== input.currentMessageId ||
    stringValue(ledger.message_type) !== input.messageType ||
    stringValue(ledger.message_body_hash) !== input.messageBodyHash ||
    stringValue(ledger.executor_kind) !== "codex" ||
    stringValue(ledger.request_hash) !== input.requestHash ||
    path.resolve(stringValue(ledger.store_dir) ?? "") !==
      path.resolve(input.storeDir) ||
    !sameCanonicalStatePath(ledger.state_path, input.statePath) ||
    !terminalDispatchRecordMatchesControl(ledger, input.terminalControl)
  ) {
    throw new Error(
      "terminal dispatch ledger does not match the exact Turn generation; no terminal input was sent"
    );
  }
}

function exactTerminalSubmissionRetryDeferredTransferId(input: {
  takeover?: Record<string, unknown>;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
}): string | undefined {
  const references = [
    stringValue(input.takeover?.deferred_foreground_transfer_id),
    stringValue(input.submission.deferred_foreground_transfer_id),
    stringValue(input.ledger.deferred_foreground_transfer_id)
  ];
  const hasDeferred = references.some((value) => value !== undefined);
  if (
    hasDeferred &&
    (references.some((value) => value === undefined) ||
      new Set(references).size !== 1)
  ) {
    throw new Error(
      "deferred transfer references disagree across Turn and ledger; no terminal input was sent"
    );
  }
  return hasDeferred ? references[0] : undefined;
}

function assertTerminalSubmissionRetryGeneration(input: {
  attempt?: TerminalSubmissionRetryRecord;
  takeover?: Record<string, unknown>;
  currentMessageId: string;
  originalMessageId: string;
}): void {
  const currentGenerationEligible = input.attempt?.mode === "replacement_send"
    ? input.attempt.state === "replacement_reserved"
      ? [input.attempt.original_message_id, input.attempt.active_message_id]
        .includes(input.currentMessageId)
      : input.currentMessageId === input.attempt.active_message_id
    : input.currentMessageId === input.originalMessageId;
  if (
    stringValue(input.takeover?.terminal_bridge_message_id) !==
      input.currentMessageId ||
    !currentGenerationEligible
  ) {
    throw new Error(
      "terminal submission retry generation changed; no terminal input was sent"
    );
  }
}

function reconcileTerminalSubmissionRetryDeferredTransfer(input: {
  invocation: TerminalSubmissionRetryInvocation;
  scope: DeferredForegroundApplicationScope;
  boundary: DeferredCodexForegroundBindingBoundary;
  transfer: DeferredForegroundTransfer;
  attempt?: TerminalSubmissionRetryRecord;
  submission: TerminalDispatchRecord;
}): DeferredForegroundTransfer {
  const { attempt } = input;
  if (!attempt) return input.transfer;
  const application = deferredForegroundApplication(
    input.invocation.options,
    input.invocation.live
  );
  const boundary = deferredForegroundBoundaryProjection(input.boundary);
  let transfer = input.transfer;
  if (transfer.submission_retry_attempt_id === undefined) {
    if (
      attempt.mode === "replacement_send" &&
      attempt.state === "replacement_reserved"
    ) {
      transfer = application.reserveSubmissionRetry({
        scope: input.scope,
        boundary,
        attemptId: attempt.attempt_id,
        mode: attempt.mode,
        messageId: attempt.active_message_id,
        preparedAt: required(
          stringValue(input.submission.prepared_at),
          "deferred retry prepared timestamp is unavailable"
        )
      });
    } else if (
      attempt.mode === "exact_draft_enter" &&
      attempt.state === "enter_reserved"
    ) {
      transfer = application.reserveSubmissionRetry({
        scope: input.scope,
        boundary,
        attemptId: attempt.attempt_id,
        mode: attempt.mode,
        messageId: attempt.active_message_id,
        preparedAt: required(
          stringValue(input.submission.prepared_at),
          "deferred retry prepared timestamp is unavailable"
        )
      });
      transfer = application.advanceSubmissionRetry({
        scope: input.scope,
        boundary,
        attemptId: attempt.attempt_id,
        messageId: attempt.active_message_id,
        stage: "enter_reserved",
        at: attempt.enter_reserved_at as string
      });
    } else {
      throw new Error(
        "deferred retry mirror is incomplete after an irreversible boundary; no terminal input was sent"
      );
    }
  }
  if (!transfer.submission_retry_attempt_id) return transfer;
  if (
    attempt.mode === "replacement_send" &&
    [
      "replacement_text_reserved", "replacement_text_injected",
      "enter_reserved", "enter_dispatched"
    ].includes(attempt.state) &&
    !transfer.submission_retry_text_reserved_at
  ) {
    transfer = application.advanceSubmissionRetry({
      scope: input.scope,
      boundary,
      attemptId: attempt.attempt_id,
      messageId: attempt.active_message_id,
      stage: "text_reserved",
      at: attempt.replacement_text_reserved_at as string
    });
  }
  if (
    ["replacement_text_injected", "enter_reserved", "enter_dispatched"]
      .includes(attempt.state) &&
    !transfer.submission_retry_text_injected_at
  ) {
    transfer = application.advanceSubmissionRetry({
      scope: input.scope,
      boundary,
      attemptId: attempt.attempt_id,
      messageId: attempt.active_message_id,
      stage: "text_injected",
      at: attempt.replacement_text_injected_at ??
        attempt.enter_reserved_at ?? attempt.reserved_at
    });
  }
  if (
    ["enter_reserved", "enter_dispatched"].includes(attempt.state) &&
    !transfer.submission_retry_enter_reserved_at
  ) {
    transfer = application.advanceSubmissionRetry({
      scope: input.scope,
      boundary,
      attemptId: attempt.attempt_id,
      messageId: attempt.active_message_id,
      stage: "enter_reserved",
      at: attempt.enter_reserved_at as string
    });
  }
  if (
    attempt.state === "enter_dispatched" &&
    !transfer.submission_retry_enter_dispatched_at
  ) {
    transfer = application.advanceSubmissionRetry({
      scope: input.scope,
      boundary,
      attemptId: attempt.attempt_id,
      messageId: attempt.active_message_id,
      stage: "enter_dispatched",
      at: attempt.enter_dispatched_at as string
    });
  }
  return transfer;
}

function prepareTerminalSubmissionRetryDeferredContext(input: {
  invocation: TerminalSubmissionRetryInvocation;
  authority: TerminalSubmissionRetryLockedAuthority;
  scopes: CanonicalStateMutationScopes;
  resources: CanonicalStateMutationResources;
}): {
  deferred?: TerminalSubmissionRetryDeferredContext;
  ledger: TerminalDispatchLedgerDocument;
} {
  assertTerminalSubmissionRetryTurnOpen({
    statePath: input.invocation.statePath,
    exactTurnId: input.invocation.exactTurnId
  });
  const { deferredTransferId, attempt, submission } = input.authority;
  if (!deferredTransferId) return { ledger: input.authority.ledger };
  const scope = bindDeferredForegroundApplicationScope(
    input.scopes,
    input.resources
  );
  const transfer = scope.loadTransfer(deferredTransferId);
  const boundary = deferredRecoveryAdapter.deferredCodexBoundaryFromTransfer(
    deferredForegroundRecoveryAdapterPorts(),
    { terminal: input.invocation.live, transfer }
  );
  const projectedBoundary = deferredForegroundBoundaryProjection(boundary);
  scope.assertBoundary(projectedBoundary);
  if (attempt && attempt.state !== "agent_accepted") {
    assertTerminalSubmissionRetryDeferredMirrorCanReconcile({
      attempt,
      transfer,
      submission
    });
  }
  const ledgerMirror = attempt && attempt.state !== "agent_accepted"
    ? reconcileTerminalSubmissionRetryLedgerPrefix({
        attempt,
        ledger: input.authority.ledger
      })
    : undefined;
  const currentTransfer = reconcileTerminalSubmissionRetryDeferredTransfer({
    invocation: input.invocation,
    scope,
    boundary,
    transfer,
    attempt,
    submission
  });
  assertTerminalSubmissionRetryDeferredTransferAuthority({
    invocation: input.invocation,
    authority: input.authority,
    transfer: currentTransfer,
    attempt
  });
  deferredForegroundApplication(
    input.invocation.options,
    input.invocation.live
  ).assertTransferAuthority(scope, currentTransfer, projectedBoundary);
  let ledger = input.authority.ledger;
  if (attempt && attempt.state !== "agent_accepted") {
    assertTerminalSubmissionRetryDeferredMirror({
      attempt,
      transfer: currentTransfer,
      submission
    });
    if (ledgerMirror?.changed) {
      mutationDispatchLedger.save(input.scopes, input.resources,
        ledgerMirror.ledger);
      ledger = ledgerMirror.ledger;
    }
  }
  return {
    deferred: { scope, transfer: currentTransfer, boundary },
    ledger
  };
}

function assertTerminalSubmissionRetryDeferredTransferAuthority(input: {
  invocation: TerminalSubmissionRetryInvocation;
  authority: TerminalSubmissionRetryLockedAuthority;
  transfer: DeferredForegroundTransfer;
  attempt?: TerminalSubmissionRetryRecord;
}): void {
  const { transfer, attempt } = input;
  const plannedReplacement = Boolean(
    attempt?.mode === "replacement_send" &&
    attempt.state === "replacement_reserved" &&
    transfer.submission_retry_text_reserved_at === undefined
  );
  const activeMessageId = deferredForegroundActiveMessageId(transfer);
  const currentMessageId = input.authority.currentMessageId;
  if (
    transfer.turn_id !== input.invocation.exactTurnId ||
    transfer.target_session_id !==
      sessionIdForConversation(input.authority.conversation) ||
    transfer.request_hash !== input.authority.requestHash ||
    !sameCanonicalStatePath(transfer.state_path, input.invocation.statePath) ||
    transfer.message_id !== input.authority.originalMessageId ||
    (plannedReplacement
      ? ![input.authority.originalMessageId, attempt!.active_message_id]
        .includes(currentMessageId)
      : activeMessageId !== currentMessageId) ||
    (attempt
      ? transfer.submission_retry_attempt_id !== attempt.attempt_id ||
        transfer.submission_retry_message_id !== attempt.active_message_id
      : transfer.submission_retry_attempt_id !== undefined)
  ) {
    throw new Error(
      "deferred submission retry transfer authority changed; no terminal input was sent"
    );
  }
}

interface TerminalSubmissionRetryFlowState {
  conversation: Conversation;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
  attempt?: TerminalSubmissionRetryRecord;
}

interface TerminalSubmissionRetryFlowContext {
  invocation: TerminalSubmissionRetryInvocation;
  scopes: CanonicalStateMutationScopes;
  resources: CanonicalStateMutationResources;
  execution: TerminalDispatchExecutionService;
  deferred?: TerminalSubmissionRetryDeferredContext;
  takeover?: Record<string, unknown>;
  currentMessageId: string;
  originalMessageId: string;
  requestText: string;
  requestHash: string;
}

function reconcileTerminalSubmissionRetryDeferredPending(
  context: TerminalSubmissionRetryFlowContext,
  state: TerminalSubmissionRetryFlowState
): boolean {
  if (
    !context.deferred || state.attempt?.state !== "enter_dispatched" ||
    state.submission.status === "agent_accepted" ||
    state.ledger.status === "agent_accepted"
  ) {
    return false;
  }
  state.conversation = reconcileTerminalSubmissionRetryPending({
    conversation: state.conversation,
    submission: state.submission,
    ledger: state.ledger,
    attempt: state.attempt,
    requestText: context.requestText,
    statePath: context.invocation.statePath,
    logPath: context.invocation.logPath,
    scopes: context.scopes,
    resources: context.resources,
    deferred: context.deferred
  });
  state.submission = required(
    terminalBridgeSubmission(state.conversation),
    "terminal submission retry receipt disappeared during pending reconciliation"
  );
  state.ledger = required(
    mutationDispatchLedger.load(context.scopes, context.resources),
    "terminal submission retry ledger disappeared during pending reconciliation"
  );
  return true;
}

async function recoverPartialTerminalSubmissionRetryAcceptance(
  context: TerminalSubmissionRetryFlowContext,
  state: TerminalSubmissionRetryFlowState
): Promise<boolean> {
  assertTerminalSubmissionRetryTurnOpen({
    statePath: context.invocation.statePath,
    exactTurnId: context.invocation.exactTurnId
  });
  const partialAcceptance =
    state.submission.status === "agent_accepted" ||
    state.ledger.status === "agent_accepted" ||
    state.attempt?.state === "agent_accepted";
  if (!partialAcceptance) return false;
  const {
    options, terminalControl, live, statePath, logPath, storeDir
  } = context.invocation;
  if (
    context.deferred &&
    ["uncertain", "dispatch_started"].includes(context.deferred.transfer.status)
  ) {
    const recovered = await deferredRecoveryAdapter
      .recoverAcceptedDeferredForegroundDispatch(
        deferredForegroundRecoveryAdapterPorts(),
        {
          options,
          scope: context.deferred.scope,
          storeDir,
          terminal: live,
          transfer: context.deferred.transfer,
          boundary: context.deferred.boundary
        }
      );
    assertTerminalSubmissionRetryTurnOpen({
      statePath,
      exactTurnId: context.invocation.exactTurnId
    });
    if (!recovered) {
      printTerminalSubmissionRetryOutcome({
        conversation: state.conversation,
        terminalControl,
        attempt: state.attempt,
        outcome: "refused",
        terminalInputSent: false,
        reason: "Partial deferred acceptance lacks current native evidence; no terminal input was sent."
      });
      return true;
    }
    const finalized = finalizeDeferredTerminalSubmissionRetryAccepted({
      statePath,
      scopes: context.scopes,
      resources: context.resources,
      attempt: state.attempt
    });
    state.conversation = finalized.conversation;
    state.attempt = finalized.attempt;
    startTerminalBridgeMonitorForConversation({
      conversation: state.conversation,
      statePath,
      logPath,
      options
    });
    printTerminalSubmissionRetryOutcome({
      conversation: state.conversation,
      terminalControl,
      attempt: state.attempt,
      outcome: "agent_accepted",
      terminalInputSent: false,
      reason: "Deferred native acceptance, source/target Sessions, and monitoring were reconciled without terminal input."
    });
    return true;
  }
  const durableEvidence = await context.execution.detectAcceptance({
    executor: "codex",
    conversation: state.conversation,
    terminalControl,
    ...terminalAcceptanceCompanionFences(state.conversation, terminalControl)
  });
  assertTerminalSubmissionRetryTurnOpen({
    statePath,
    exactTurnId: context.invocation.exactTurnId
  });
  if (!durableEvidence) {
    printTerminalSubmissionRetryOutcome({
      conversation: state.conversation,
      terminalControl,
      attempt: state.attempt,
      outcome: "refused",
      terminalInputSent: false,
      reason: "Partial acceptance metadata lacks current native evidence; no terminal input was sent."
    });
    return true;
  }
  const repaired = terminalSubmissionRetryAccepted({
    conversation: state.conversation,
    submission: state.submission,
    ledger: state.ledger,
    evidence: durableEvidence,
    requestText: context.requestText,
    at: stringValue(state.submission.agent_accepted_at) ??
      stringValue(state.ledger.agent_accepted_at) ?? cliNow().toISOString(),
    statePath,
    logPath,
    scopes: context.scopes,
    resources: context.resources,
    attempt: state.attempt,
    terminalInputSent: false
  });
  state.conversation = repaired.conversation;
  state.attempt = repaired.attempt;
  startTerminalBridgeMonitorForConversation({
    conversation: state.conversation,
    statePath,
    logPath,
    options
  });
  printTerminalSubmissionRetryOutcome({
    conversation: state.conversation,
    terminalControl,
    attempt: state.attempt,
    outcome: "agent_accepted",
    terminalInputSent: false,
    reason: "Partial durable acceptance was reconciled without terminal input and monitoring was ensured."
  });
  return true;
}

function terminalSubmissionRetryIsEligible(
  context: TerminalSubmissionRetryFlowContext,
  state: TerminalSubmissionRetryFlowState
): boolean {
  const legacyEligible = !state.attempt &&
    state.conversation.status === "stalled" &&
    state.submission.status === "uncertain" &&
    state.submission.last_proven_stage === "text_injected" &&
    context.currentMessageId === context.originalMessageId;
  if (legacyEligible || (state.attempt && state.attempt.state !== "agent_accepted")) {
    return true;
  }
  printTerminalSubmissionRetryOutcome({
    conversation: state.conversation,
    terminalControl: context.invocation.terminalControl,
    attempt: state.attempt,
    outcome: "refused",
    terminalInputSent: false,
    reason: "The Turn is not an eligible incomplete submission recovery; no terminal input was sent."
  });
  return false;
}

async function recoverTerminalSubmissionRetryAcceptance(
  context: TerminalSubmissionRetryFlowContext,
  state: TerminalSubmissionRetryFlowState
): Promise<boolean> {
  const {
    options, terminalControl, live, statePath, logPath, storeDir
  } = context.invocation;
  const deferredAccepted = context.deferred
    ? await deferredRecoveryAdapter.recoverAcceptedDeferredForegroundDispatch(
        deferredForegroundRecoveryAdapterPorts(),
        {
          options,
          scope: context.deferred.scope,
          storeDir,
          terminal: live,
          transfer: context.deferred.transfer,
          boundary: context.deferred.boundary
        }
      )
    : false;
  assertTerminalSubmissionRetryTurnOpen({
    statePath,
    exactTurnId: context.invocation.exactTurnId
  });
  if (deferredAccepted) {
    const finalized = finalizeDeferredTerminalSubmissionRetryAccepted({
      statePath,
      scopes: context.scopes,
      resources: context.resources,
      attempt: state.attempt
    });
    state.conversation = finalized.conversation;
    state.attempt = finalized.attempt;
    startTerminalBridgeMonitorForConversation({
      conversation: state.conversation,
      statePath,
      logPath,
      options
    });
    printTerminalSubmissionRetryOutcome({
      conversation: state.conversation,
      terminalControl,
      attempt: state.attempt,
      outcome: "agent_accepted",
      terminalInputSent: false,
      reason: "Deferred native acceptance and source/target Session bindings were reconciled without terminal input."
    });
    return true;
  }
  const acceptedEvidence = context.deferred
    ? undefined
    : await context.execution.detectAcceptance({
        executor: "codex",
        conversation: state.conversation,
        terminalControl,
        ...terminalAcceptanceCompanionFences(
          state.conversation,
          terminalControl
        )
      });
  assertTerminalSubmissionRetryTurnOpen({
    statePath,
    exactTurnId: context.invocation.exactTurnId
  });
  if (!acceptedEvidence) return false;
  const repaired = terminalSubmissionRetryAccepted({
    conversation: state.conversation,
    submission: state.submission,
    ledger: state.ledger,
    evidence: acceptedEvidence,
    requestText: context.requestText,
    at: cliNow().toISOString(),
    statePath,
    logPath,
    scopes: context.scopes,
    resources: context.resources,
    attempt: state.attempt,
    terminalInputSent: false
  });
  state.conversation = repaired.conversation;
  state.attempt = repaired.attempt;
  startTerminalBridgeMonitorForConversation({
    conversation: state.conversation,
    statePath,
    logPath,
    options
  });
  printTerminalSubmissionRetryOutcome({
    conversation: state.conversation,
    terminalControl,
    attempt: state.attempt,
    outcome: "agent_accepted",
    terminalInputSent: false,
    reason: "Native Codex acceptance was reconciled; no terminal input was sent."
  });
  return true;
}

function finishPendingTerminalSubmissionRetry(
  context: TerminalSubmissionRetryFlowContext,
  state: TerminalSubmissionRetryFlowState,
  alreadyReconciled: boolean
): boolean {
  if (state.attempt?.state !== "enter_dispatched") return false;
  assertTerminalSubmissionRetryTurnOpen({
    statePath: context.invocation.statePath,
    exactTurnId: context.invocation.exactTurnId
  });
  if (!alreadyReconciled) {
    state.conversation = reconcileTerminalSubmissionRetryPending({
      conversation: state.conversation,
      submission: state.submission,
      ledger: state.ledger,
      attempt: state.attempt,
      requestText: context.requestText,
      statePath: context.invocation.statePath,
      logPath: context.invocation.logPath,
      scopes: context.scopes,
      resources: context.resources,
      deferred: context.deferred
    });
  }
  startTerminalBridgeMonitorForConversation({
    conversation: state.conversation,
    statePath: context.invocation.statePath,
    logPath: context.invocation.logPath,
    options: context.invocation.options
  });
  printTerminalSubmissionRetryOutcome({
    conversation: state.conversation,
    terminalControl: context.invocation.terminalControl,
    attempt: state.attempt,
    outcome: "enter_dispatched",
    terminalInputSent: false,
    reason: "The durable retry Enter was reconciled without additional terminal input; native acceptance remains pending."
  });
  return true;
}

function terminalSubmissionRetryHasInputAuthority(
  context: TerminalSubmissionRetryFlowContext,
  state: TerminalSubmissionRetryFlowState
): boolean {
  if (
    !context.deferred ||
    validateCodexRolloutAcceptanceAnchor(
      context.takeover?.codex_rollout_acceptance_anchor
    )?.version === 3
  ) {
    return true;
  }
  printTerminalSubmissionRetryOutcome({
    conversation: state.conversation,
    terminalControl: context.invocation.terminalControl,
    attempt: state.attempt,
    outcome: "refused",
    terminalInputSent: false,
    reason: "Deferred submission retry requires a candidate-set Codex acceptance anchor before any terminal input; no terminal input was sent."
  });
  return false;
}

async function runTerminalSubmissionRetryNoInputRecovery(
  context: TerminalSubmissionRetryFlowContext,
  state: TerminalSubmissionRetryFlowState
): Promise<boolean> {
  const pendingRetryReconciled =
    reconcileTerminalSubmissionRetryDeferredPending(context, state);
  if (await recoverPartialTerminalSubmissionRetryAcceptance(context, state)) {
    return true;
  }
  if (!terminalSubmissionRetryIsEligible(context, state)) return true;
  if (await recoverTerminalSubmissionRetryAcceptance(context, state)) {
    return true;
  }
  if (finishPendingTerminalSubmissionRetry(
    context,
    state,
    pendingRetryReconciled
  )) {
    return true;
  }
  return !terminalSubmissionRetryHasInputAuthority(context, state);
}

async function runTerminalSubmissionRetryDecision(
  context: TerminalSubmissionRetryFlowContext,
  state: TerminalSubmissionRetryFlowState
): Promise<void> {
  const {
    options, bridge, terminalControl, storeDir, statePath, logPath
  } = context.invocation;
  if (context.deferred) {
    await assertDeferredCodexForegroundBindingBoundary({
      options,
      scope: context.deferred.scope,
      boundary: context.deferred.boundary,
      expectedSourceStatus: "transitioning",
      requireNoDispatch: false,
      requireEmptyComposer: false
    });
  }
  const observation = await bridge.observeCodexComposer(
    terminalControl,
    context.requestText,
    { runtime: terminalRuntimeIdentityForConversation(
      state.conversation,
      terminalControl
    ) }
  );
  assertTerminalSubmissionRetryTurnOpen({
    statePath,
    exactTurnId: context.invocation.exactTurnId
  });
  const decision = decideTerminalSubmissionRetry({
    agent: "codex",
    exactTurnTarget: true,
    accepted: false,
    composer: observation.state,
    submissionStatus: stringValue(state.submission.status),
    lastProvenStage: stringValue(state.submission.last_proven_stage),
    submissionTextInjectedAt: stringValue(state.submission.text_injected_at),
    enterDispatchedAt: stringValue(state.submission.enter_dispatched_at),
    enterNotAttemptedAt: stringValue(state.submission.enter_not_attempted_at),
    enterNotAttemptedReason: stringValue(
      state.submission.enter_not_attempted_reason
    ),
    ledgerStatus: stringValue(state.ledger.status),
    ledgerTextInjectedAt: stringValue(state.ledger.text_injected_at),
    ledgerEnterDispatchedAt: stringValue(state.ledger.enter_dispatched_at),
    ledgerEnterNotAttemptedAt: stringValue(state.ledger.enter_not_attempted_at),
    ledgerEnterNotAttemptedReason: stringValue(
      state.ledger.enter_not_attempted_reason
    ),
    ledgerAgentAcceptedAt: stringValue(state.ledger.agent_accepted_at),
    originalMessageId: context.originalMessageId,
    currentMessageId: stringValue(
      context.takeover?.terminal_bridge_message_id
    ),
    attempt: state.attempt
  });
  if (decision.action === "refuse") {
    printTerminalSubmissionRetryOutcome({
      conversation: state.conversation,
      terminalControl,
      attempt: state.attempt,
      outcome: "refused",
      terminalInputSent: false,
      reason: `${decision.reason}; no terminal input was sent.`
    });
    return;
  }
  if (decision.action === "repair_accepted") {
    throw new Error(
      "retry metadata claims acceptance without native evidence; no terminal input was sent"
    );
  }
  if (
    decision.action === "start_replacement" ||
    decision.action === "resume_replacement"
  ) {
    await runTerminalSubmissionReplacement({
      options,
      bridge,
      execution: context.execution,
      observation,
      decision,
      conversation: state.conversation,
      submission: state.submission,
      ledger: state.ledger,
      requestText: context.requestText,
      requestHash: context.requestHash,
      originalMessageId: context.originalMessageId,
      terminalControl,
      storeDir,
      statePath,
      logPath,
      scopes: context.scopes,
      resources: context.resources,
      attempt: state.attempt,
      deferred: context.deferred
    });
    return;
  }
  await runTerminalSubmissionExactDraftEnter({
    options,
    bridge,
    execution: context.execution,
    conversation: state.conversation,
    submission: state.submission,
    ledger: state.ledger,
    requestText: context.requestText,
    requestHash: context.requestHash,
    originalMessageId: context.originalMessageId,
    activeMessageId: decision.activeMessageId,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    scopes: context.scopes,
    resources: context.resources,
    attempt: state.attempt,
    deferred: context.deferred
  });
}

async function runTerminalSubmissionRetryLocked(input: {
  invocation: TerminalSubmissionRetryInvocation;
  scopes: CanonicalStateMutationScopes;
  resources: CanonicalStateMutationResources;
}): Promise<void> {
  const freshConversation = loadExactTerminalSubmissionRetryTurn({
    statePath: input.invocation.statePath,
    exactTurnId: input.invocation.exactTurnId
  });
  if (freshConversation.status === "closed") {
    printTerminalSubmissionRetryOutcome({
      conversation: freshConversation,
      terminalControl: input.invocation.terminalControl,
      outcome: "refused",
      terminalInputSent: false,
      reason:
        "The Turn was explicitly closed; no terminal input was sent and no " +
        "retry state was changed."
    });
    return;
  }
  const authority = loadTerminalSubmissionRetryLockedAuthority(input);
  if (authority.lifecycleSettled) {
    printTerminalSubmissionRetryOutcome({
      conversation: authority.conversation,
      terminalControl: input.invocation.terminalControl,
      attempt: authority.attempt,
      outcome: "refused",
      terminalInputSent: false,
      reason: "The Turn lifecycle is already settled; no terminal input was sent."
    });
    return;
  }
  const prepared = prepareTerminalSubmissionRetryDeferredContext({
    invocation: input.invocation,
    authority,
    scopes: input.scopes,
    resources: input.resources
  });
  const state: TerminalSubmissionRetryFlowState = {
    conversation: authority.conversation,
    submission: authority.submission,
    ledger: prepared.ledger,
    attempt: authority.attempt
  };
  const context: TerminalSubmissionRetryFlowContext = {
    invocation: input.invocation,
    scopes: input.scopes,
    resources: input.resources,
    execution: terminalDispatchExecution(
      input.invocation.options,
      input.invocation.bridge
    ),
    deferred: prepared.deferred,
    takeover: authority.takeover,
    currentMessageId: authority.currentMessageId,
    originalMessageId: authority.originalMessageId,
    requestText: authority.requestText,
    requestHash: authority.requestHash
  };
  if (await runTerminalSubmissionRetryNoInputRecovery(context, state)) return;
  await runTerminalSubmissionRetryDecision(context, state);
}

async function runTerminalSubmissionRetry(
  options: TerminalCommandCliOptions
): Promise<void> {
  const exactTurnId = assertTerminalSubmissionRetryOptions(options);
  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const storePaths = pathsForConversationDir(path.dirname(statePath));
  const storeDir = storePaths.storeDir;
  if (
    path.resolve(storePaths.statePath) !== path.resolve(statePath) ||
    path.basename(storePaths.conversationDir) !== exactTurnId ||
    turnIdForConversation(loaded.conversation) !== exactTurnId
  ) {
    throw new Error(
      "send --turn did not resolve one canonical Turn; no terminal input was sent"
    );
  }
  const initialTakeover = isRecord(loaded.conversation.native_session_takeover)
    ? loaded.conversation.native_session_takeover
    : undefined;
  const storedControl = terminalControlFromTakeover(initialTakeover);
  const pid = Number(initialTakeover?.terminal_agent_pid);
  if (!storedControl || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(
      `turn ${exactTurnId} is not attached to a live terminal; no terminal input was sent`
    );
  }
  if (executorForConversation(loaded.conversation).kind !== "codex") {
    throw new Error(
      "terminal submission retry is supported only for Codex; no terminal input was sent"
    );
  }
  const bridge = createTerminalAgentBridge(options);
  const live = await bridge.resolveStoredTerminal(
    "codex",
    pid,
    storedControl,
    terminalRuntimeIdentityForConversation(loaded.conversation, storedControl)
  );
  if (!terminalControlsShareIncarnation(live.terminalControl, storedControl)) {
    throw new Error(
      "terminal control changed before submission retry; no terminal input was sent"
    );
  }
  const terminalControl = live.terminalControl;
  await withCanonicalMutationLocks(
    terminalWriterMutationLocks(storeDir, terminalControl),
    async (scopes, resources) => withTerminalDispatchStateScope(
      scopes,
      resources,
      statePath,
      logPath,
      async (dispatchScopes, dispatchResources) =>
        runTerminalSubmissionRetryLocked({
          invocation: {
            options,
            exactTurnId,
            statePath,
            logPath,
            storeDir,
            bridge,
            live,
            terminalControl
          },
          scopes: dispatchScopes,
          resources: dispatchResources
        })
    )
  );
}

async function runTerminalSubmissionExactDraftEnter(input: {
  options: TerminalCommandCliOptions;
  bridge: TerminalAgentBridge;
  execution: TerminalDispatchExecutionService;
  conversation: Conversation;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
  requestText: string;
  requestHash: string;
  originalMessageId: string;
  activeMessageId: string;
  terminalControl: TerminalControlRef;
  storeDir: string;
  statePath: string;
  logPath: string;
  scopes: CanonicalStateMutationScopes;
  resources: CanonicalStateMutationResources;
  attempt?: TerminalSubmissionRetryRecord;
  deferred?: TerminalSubmissionRetryDeferredContext;
}): Promise<void> {
  let attempt = input.attempt;
  const reserveEnter = (): void => {
    assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    const at = cliNow().toISOString();
    const persistAttemptLedger = (): void => {
      mutationDispatchLedger.save(input.scopes, input.resources, {
        ...mutationDispatchLedger.load(input.scopes, input.resources),
        ...terminalSubmissionRetryLedgerFields(attempt)
      });
    };
    const advanceDeferred = (
      stage: "text_injected" | "enter_reserved",
      stageAt: string
    ): void => {
      if (!input.deferred || !attempt) return;
      input.deferred.transfer = deferredForegroundApplication(
        input.options,
        input.deferred.boundary.terminal
      ).advanceSubmissionRetry({
        scope: input.deferred.scope,
        boundary: deferredForegroundBoundaryProjection(
          input.deferred.boundary
        ),
        attemptId: attempt.attempt_id,
        messageId: attempt.active_message_id,
        stage,
        at: stageAt
      });
    };
    if (!attempt) {
      attempt = saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
        ...terminalSubmissionRetryBaseRecord({
          mode: "exact_draft_enter",
          state: "enter_reserved",
          attemptId: `submission-retry-${randomUUID()}`,
          storeDir: input.storeDir,
          statePath: input.statePath,
          conversation: input.conversation,
          originalMessageId: input.originalMessageId,
          activeMessageId: input.activeMessageId,
          requestHash: input.requestHash,
          terminalControl: input.terminalControl,
          at,
          deferredTransferId: input.deferred?.transfer.transfer_id
        }),
        enter_reserved_at: at
      }, null);
      if (input.deferred) {
        input.deferred.transfer = deferredForegroundApplication(
          input.options,
          input.deferred.boundary.terminal
        ).reserveSubmissionRetry({
          scope: input.deferred.scope,
          boundary: deferredForegroundBoundaryProjection(
            input.deferred.boundary
          ),
          attemptId: attempt.attempt_id,
          mode: attempt.mode,
          messageId: attempt.active_message_id,
          preparedAt: required(
            stringValue(input.submission.prepared_at),
            "deferred retry prepared timestamp is unavailable"
          )
        });
      }
      advanceDeferred("enter_reserved", at);
      persistAttemptLedger();
      return;
    }
    if (
      attempt.mode === "replacement_send" &&
      attempt.state === "replacement_text_reserved"
    ) {
      attempt = saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
        ...attempt,
        state: "replacement_text_injected",
        replacement_text_injected_at: at,
        updated_at: at
      }, attempt.revision);
      advanceDeferred("text_injected", at);
      persistAttemptLedger();
    }
    if (attempt.state !== "replacement_text_injected") {
      throw new Error(
        "submission retry Enter is no longer reservable; no key was sent"
      );
    }
    const enterReservedAt = cliNow().toISOString();
    attempt = saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
      ...attempt,
      state: "enter_reserved",
      enter_reserved_at: enterReservedAt,
      updated_at: enterReservedAt
    }, attempt.revision);
    advanceDeferred("enter_reserved", enterReservedAt);
    persistAttemptLedger();
  };
  await input.bridge.submitExactCodexDraft(
    input.terminalControl,
    input.requestText,
    {
      runtime: terminalRuntimeIdentityForConversation(
        input.conversation,
        input.terminalControl
      ),
      beforeEnterReservation: reserveEnter
    }
  );
  assertTerminalSubmissionRetryTurnOpen({
    statePath: input.statePath,
    exactTurnId: turnIdForConversation(input.conversation)
  });
  if (!attempt || attempt.state !== "enter_reserved") {
    throw new Error(
      "terminal bridge dispatched Enter without a durable retry reservation"
    );
  }
  const enterAt = cliNow().toISOString();
  attempt = saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
    ...attempt,
    state: "enter_dispatched",
    enter_dispatched_at: enterAt,
    updated_at: enterAt
  }, attempt.revision);
  if (input.deferred) {
    input.deferred.transfer = deferredForegroundApplication(
      input.options,
      input.deferred.boundary.terminal
    ).advanceSubmissionRetry({
      scope: input.deferred.scope,
      boundary: deferredForegroundBoundaryProjection(
        input.deferred.boundary
      ),
      attemptId: attempt.attempt_id,
      messageId: attempt.active_message_id,
      stage: "enter_dispatched",
      at: enterAt
    });
  }
  const current = loadState(input.statePath);
  const currentSubmission = required(
    terminalBridgeSubmission(current),
    "terminal submission receipt disappeared after retry Enter"
  );
  const enteredConversation = withTerminalBridgeSubmission({
    conversation: withTerminalSubmissionRetryMonitorEpoch(
      terminalSubmissionRetryUnstalled(current),
      enterAt
    ),
    messageId: input.activeMessageId,
    messageType: terminalSubmissionRetryMessageType(currentSubmission),
    requestText: input.requestText,
    status: "enter_dispatched",
    preparedAt: required(
      stringValue(currentSubmission.prepared_at),
      "terminal submission retry prepared timestamp is unavailable"
    ),
    textInjectedAt:
      stringValue(currentSubmission.text_injected_at) ??
        attempt.replacement_text_injected_at ?? attempt.reserved_at,
    enterDispatchedAt: enterAt,
    lastProvenStage: "enter_dispatched"
  });
  saveState(input.statePath, enteredConversation);
  let enteredLedger = {
    ...mutationDispatchLedger.load(input.scopes, input.resources),
    ...terminalSubmissionRetryLedgerFields(attempt),
    status: "enter_dispatched",
    text_injected_at:
      stringValue(currentSubmission.text_injected_at) ??
        attempt.replacement_text_injected_at ?? attempt.reserved_at,
    enter_dispatched_at: enterAt,
    dispatcher_pid: null
  };
  mutationDispatchLedger.save(input.scopes, input.resources, enteredLedger);
  appendEvent(input.logPath, {
    ts: enterAt,
    conversation_id: enteredConversation.conversation_id,
    event: "terminal_submission_retry_enter_dispatched",
    message_id: input.activeMessageId,
    terminal_input_sent: true
  });
  if (input.deferred) {
    const transfer = input.deferred.scope.loadTransfer(
      input.deferred.transfer.transfer_id
    );
    const recovered = await deferredRecoveryAdapter
      .recoverAcceptedDeferredForegroundDispatch(
        deferredForegroundRecoveryAdapterPorts(),
        {
          options: input.options,
          scope: input.deferred.scope,
          storeDir: input.storeDir,
          terminal: input.deferred.boundary.terminal,
          transfer,
          boundary: input.deferred.boundary
        }
    );
    assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    if (recovered) {
      const finalized = finalizeDeferredTerminalSubmissionRetryAccepted({
        statePath: input.statePath,
        scopes: input.scopes,
        resources: input.resources,
        attempt
      });
      attempt = required(
        finalized.attempt,
        "deferred retry attempt disappeared after accepted finalization"
      );
      const acceptedConversation = finalized.conversation;
      startTerminalBridgeMonitorForConversation({
        conversation: acceptedConversation,
        statePath: input.statePath,
        logPath: input.logPath,
        options: input.options
      });
      printTerminalSubmissionRetryOutcome({
        conversation: acceptedConversation,
        terminalControl: input.terminalControl,
        attempt,
        outcome: "agent_accepted",
        terminalInputSent: true,
        reason: "The exact deferred Codex draft was submitted once and its transfer and source/target Sessions were committed."
      });
      return;
    }
    startTerminalBridgeMonitorForConversation({
      conversation: enteredConversation,
      statePath: input.statePath,
      logPath: input.logPath,
      options: input.options
    });
    printTerminalSubmissionRetryOutcome({
      conversation: enteredConversation,
      terminalControl: input.terminalControl,
      attempt,
      outcome: "enter_dispatched",
      terminalInputSent: true,
      reason: "The exact deferred Codex draft received one Enter; dedicated transfer acceptance remains pending and another retry is forbidden."
    });
    return;
  }
  const timeoutMs = positiveMilliseconds(
    input.options.terminalAcceptanceTimeoutMs ??
      DEFAULT_TERMINAL_ACCEPTANCE_TIMEOUT_MS,
    "--terminal-acceptance-timeout-ms"
  );
  const acceptance = await input.execution.pollAcceptance({
    executor: "codex",
    conversation: enteredConversation,
    terminalControl: input.terminalControl,
    ...terminalAcceptanceCompanionFences(
      enteredConversation,
      input.terminalControl
    ),
    timeoutMs,
    pollIntervalMs: Math.max(10, Math.min(
      timeoutMs,
      Number(input.options.terminalAcceptancePollIntervalMs ??
        DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS)
    )),
    scrollbackLines: Number(input.options.scrollbackLines ?? 240)
  });
  assertTerminalSubmissionRetryTurnOpen({
    statePath: input.statePath,
    exactTurnId: turnIdForConversation(input.conversation)
  });
  if (acceptance.outcome === "agent_accepted") {
    const repaired = terminalSubmissionRetryAccepted({
      conversation: enteredConversation,
      submission: required(
        terminalBridgeSubmission(enteredConversation),
        "terminal submission receipt disappeared after retry acceptance"
      ),
      ledger: enteredLedger,
      evidence: acceptance.evidence,
      requestText: input.requestText,
      at: cliNow().toISOString(),
      statePath: input.statePath,
      logPath: input.logPath,
      scopes: input.scopes,
      resources: input.resources,
      attempt,
      terminalInputSent: true
    });
    startTerminalBridgeMonitorForConversation({
      conversation: repaired.conversation,
      statePath: input.statePath,
      logPath: input.logPath,
      options: input.options
    });
    printTerminalSubmissionRetryOutcome({
      conversation: repaired.conversation,
      terminalControl: input.terminalControl,
      attempt: repaired.attempt,
      outcome: "agent_accepted",
      terminalInputSent: true,
      reason: "The exact existing Codex draft was submitted once and native acceptance was proven."
    });
    return;
  }
  if (acceptance.outcome === "not_accepted") {
    const notAcceptedAt = cliNow().toISOString();
    const notAcceptedConversation = terminalSubmissionRetryTerminalOutcome({
      conversation: enteredConversation,
      submission: required(
        terminalBridgeSubmission(enteredConversation),
        "terminal submission receipt disappeared after retry rejection"
      ),
      ledger: enteredLedger,
      requestText: input.requestText,
      reason: acceptance.reason,
      at: notAcceptedAt,
      statePath: input.statePath,
      logPath: input.logPath,
      scopes: input.scopes,
      resources: input.resources,
      attempt,
      outcome: "not_accepted"
    });
    printTerminalSubmissionRetryOutcome({
      conversation: notAcceptedConversation,
      terminalControl: input.terminalControl,
      attempt,
      outcome: "not_accepted",
      terminalInputSent: true,
      reason: "The exact draft remains in the Codex composer after one Enter; it was durably recorded as not accepted and another retry is forbidden."
    });
    return;
  }
  if (acceptance.outcome === "uncertain") {
    const uncertainConversation = terminalSubmissionRetryTerminalOutcome({
      conversation: enteredConversation,
      submission: required(
        terminalBridgeSubmission(enteredConversation),
        "terminal submission receipt disappeared after uncertain retry acceptance"
      ),
      ledger: enteredLedger,
      requestText: input.requestText,
      reason: acceptance.reason,
      at: cliNow().toISOString(),
      statePath: input.statePath,
      logPath: input.logPath,
      scopes: input.scopes,
      resources: input.resources,
      attempt,
      outcome: "uncertain"
    });
    printTerminalSubmissionRetryOutcome({
      conversation: uncertainConversation,
      terminalControl: input.terminalControl,
      attempt,
      outcome: "refused",
      terminalInputSent: true,
      reason: `Exact-draft acceptance is uncertain (${acceptance.reason}); the terminal outcome is durable and another retry is forbidden.`
    });
    return;
  }
  startTerminalBridgeMonitorForConversation({
    conversation: enteredConversation,
    statePath: input.statePath,
    logPath: input.logPath,
    options: input.options
  });
  printTerminalSubmissionRetryOutcome({
    conversation: enteredConversation,
    terminalControl: input.terminalControl,
    attempt,
    outcome: "enter_dispatched",
    terminalInputSent: true,
    reason: "The exact existing Codex draft received one Enter; acceptance remains pending and another retry is forbidden."
  });
}

async function runTerminalSubmissionReplacement(input: {
  options: TerminalCommandCliOptions;
  bridge: TerminalAgentBridge;
  execution: TerminalDispatchExecutionService;
  observation: TerminalCodexComposerObservation;
  decision: Extract<TerminalSubmissionRetryDecision, {
    action: "start_replacement" | "resume_replacement";
  }>;
  conversation: Conversation;
  submission: TerminalDispatchRecord;
  ledger: TerminalDispatchLedgerDocument;
  requestText: string;
  requestHash: string;
  originalMessageId: string;
  terminalControl: TerminalControlRef;
  storeDir: string;
  statePath: string;
  logPath: string;
  scopes: CanonicalStateMutationScopes;
  resources: CanonicalStateMutationResources;
  attempt?: TerminalSubmissionRetryRecord;
  deferred?: TerminalSubmissionRetryDeferredContext;
}): Promise<void> {
  if (input.observation.state !== "exact_empty") {
    throw new Error(
      "replacement send lost its positive empty-composer proof; no terminal input was sent"
    );
  }
  assertTerminalSubmissionRetryTurnOpen({
    statePath: input.statePath,
    exactTurnId: turnIdForConversation(input.conversation)
  });
  let attempt = input.attempt;
  if (!attempt) {
    const at = cliNow().toISOString();
    attempt = saveTerminalSubmissionRetryForOpenTurn(input.statePath,
      terminalSubmissionRetryBaseRecord({
        mode: "replacement_send",
        state: "replacement_reserved",
        attemptId: `submission-retry-${randomUUID()}`,
        storeDir: input.storeDir,
        statePath: input.statePath,
        conversation: input.conversation,
        originalMessageId: input.originalMessageId,
        activeMessageId: input.originalMessageId,
        requestHash: input.requestHash,
        terminalControl: input.terminalControl,
        at,
        deferredTransferId: input.deferred?.transfer.transfer_id
      }), null);
    if (input.deferred) {
      input.deferred.transfer = deferredForegroundApplication(
        input.options,
        input.deferred.boundary.terminal
      ).reserveSubmissionRetry({
        scope: input.deferred.scope,
        boundary: deferredForegroundBoundaryProjection(
          input.deferred.boundary
        ),
        attemptId: attempt.attempt_id,
        mode: attempt.mode,
        messageId: attempt.active_message_id,
        preparedAt: required(
          stringValue(input.submission.prepared_at),
          "deferred retry prepared timestamp is unavailable"
          )
        });
    }
    const reservedLedger = required(
      mutationDispatchLedger.load(input.scopes, input.resources),
      "terminal submission retry ledger disappeared after reservation"
    );
    mutationDispatchLedger.save(input.scopes, input.resources, {
      ...reservedLedger,
      ...terminalSubmissionRetryLedgerFields(attempt)
    });
  }
  if (
    attempt.mode !== "replacement_send" ||
    attempt.state !== "replacement_reserved"
  ) {
    throw new Error(
      "replacement text transport was already reserved; no additional text was sent"
    );
  }
  const currentAttempt = (): TerminalSubmissionRetryRecord => required(
    attempt,
    "terminal submission retry attempt is unavailable"
  );
  const saveAttempt = (
    state: TerminalSubmissionRetryRecord["state"],
    at: string,
    fields: Partial<TerminalSubmissionRetryRecord>
  ): void => {
    const current = currentAttempt();
    attempt = saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
      ...current,
      ...fields,
      state,
      updated_at: at
    }, current.revision);
  };
  const persistRetryLedger = (
    fields: Record<string, unknown> = {}
  ): TerminalDispatchLedgerDocument => {
    const current = required(
      mutationDispatchLedger.load(input.scopes, input.resources),
      "terminal submission retry ledger disappeared"
    );
    const next = {
      ...current,
      ...terminalSubmissionRetryLedgerFields(attempt),
      ...fields
    };
    mutationDispatchLedger.save(input.scopes, input.resources, next);
    return next;
  };
  let enteredConversation: Conversation | undefined;
  let enteredLedger: TerminalDispatchLedgerDocument | undefined;
  await input.bridge.send(
    "codex",
    input.terminalControl,
    input.requestText,
    {
      runtime: terminalRuntimeIdentityForConversation(
        input.conversation,
        input.terminalControl
      ),
      requireExactComposerBeforeEnter: true,
      requireExactEmptyComposerAfterBeforeText: {
        preliminaryComposerDigest: input.observation.digest
      },
      beforeText: () => {
        assertTerminalSubmissionRetryTurnOpen({
          statePath: input.statePath,
          exactTurnId: turnIdForConversation(input.conversation)
        });
        const at = cliNow().toISOString();
        saveAttempt("replacement_text_reserved", at, {
          replacement_text_reserved_at: at
        });
        if (input.deferred) {
          input.deferred.transfer = deferredForegroundApplication(
            input.options,
            input.deferred.boundary.terminal
          ).advanceSubmissionRetry({
            scope: input.deferred.scope,
            boundary: deferredForegroundBoundaryProjection(
              input.deferred.boundary
            ),
            attemptId: currentAttempt().attempt_id,
            messageId: currentAttempt().active_message_id,
            stage: "text_reserved",
            at
          });
        }
        persistRetryLedger();
      },
      beforeEnter: () => {
        assertTerminalSubmissionRetryTurnOpen({
          statePath: input.statePath,
          exactTurnId: turnIdForConversation(input.conversation)
        });
        const at = cliNow().toISOString();
        saveAttempt("enter_reserved", at, { enter_reserved_at: at });
        if (input.deferred) {
          input.deferred.transfer = deferredForegroundApplication(
            input.options,
            input.deferred.boundary.terminal
          ).advanceSubmissionRetry({
            scope: input.deferred.scope,
            boundary: deferredForegroundBoundaryProjection(
              input.deferred.boundary
            ),
            attemptId: currentAttempt().attempt_id,
            messageId: currentAttempt().active_message_id,
            stage: "enter_reserved",
            at
          });
        }
        persistRetryLedger();
      },
      onTransportStage: ({ stage }) => {
        assertTerminalSubmissionRetryTurnOpen({
          statePath: input.statePath,
          exactTurnId: turnIdForConversation(input.conversation)
        });
        const at = cliNow().toISOString();
        if (stage === "text_injected") {
          saveAttempt("replacement_text_injected", at, {
            replacement_text_injected_at: at
          });
        } else {
          saveAttempt("enter_dispatched", at, {
            enter_dispatched_at: at
          });
        }
        if (input.deferred) {
          input.deferred.transfer = deferredForegroundApplication(
            input.options,
            input.deferred.boundary.terminal
          ).advanceSubmissionRetry({
            scope: input.deferred.scope,
            boundary: deferredForegroundBoundaryProjection(
              input.deferred.boundary
            ),
            attemptId: currentAttempt().attempt_id,
            messageId: currentAttempt().active_message_id,
            stage,
            at
          });
        }
        if (stage === "text_injected") {
          persistRetryLedger();
          return;
        }
        const current = loadState(input.statePath);
        const submission = required(
          terminalBridgeSubmission(current),
          "terminal submission receipt disappeared after replacement Enter"
        );
        enteredConversation = withTerminalBridgeSubmission({
          conversation: withTerminalSubmissionRetryMonitorEpoch(
            terminalSubmissionRetryUnstalled(current),
            at
          ),
          messageId: input.originalMessageId,
          messageType: terminalSubmissionRetryMessageType(submission),
          requestText: input.requestText,
          status: "enter_dispatched",
          preparedAt: required(
            stringValue(submission.prepared_at),
            "terminal submission retry prepared timestamp is unavailable"
          ),
          textInjectedAt: currentAttempt().replacement_text_injected_at as string,
          enterDispatchedAt: at,
          lastProvenStage: "enter_dispatched"
        });
        saveState(input.statePath, enteredConversation);
        enteredLedger = persistRetryLedger({
          status: "enter_dispatched",
          text_injected_at: currentAttempt().replacement_text_injected_at,
          enter_dispatched_at: at,
          enter_not_attempted_at: undefined,
          enter_not_attempted_reason: undefined,
          uncertain_at: undefined,
          safe_to_retry: undefined,
          acceptance_evidence: undefined,
          agent_accepted_at: undefined,
          not_accepted_at: undefined,
          dispatcher_pid: null
        });
        appendEvent(input.logPath, {
          ts: at,
          conversation_id: enteredConversation.conversation_id,
          event: "terminal_submission_retry_enter_dispatched",
          message_id: input.originalMessageId,
          terminal_input_sent: true
        });
      }
    }
  );
  assertTerminalSubmissionRetryTurnOpen({
    statePath: input.statePath,
    exactTurnId: turnIdForConversation(input.conversation)
  });
  if (
    currentAttempt().state !== "enter_dispatched" ||
    !enteredConversation || !enteredLedger
  ) {
    throw new Error(
      "replacement transport returned without durable Enter evidence"
    );
  }
  if (input.deferred) {
    const transfer = input.deferred.scope.loadTransfer(
      input.deferred.transfer.transfer_id
    );
    const recovered = await deferredRecoveryAdapter
      .recoverAcceptedDeferredForegroundDispatch(
        deferredForegroundRecoveryAdapterPorts(),
        {
          options: input.options,
          scope: input.deferred.scope,
          storeDir: input.storeDir,
          terminal: input.deferred.boundary.terminal,
          transfer,
          boundary: input.deferred.boundary
        }
    );
    assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    if (recovered) {
      const finalized = finalizeDeferredTerminalSubmissionRetryAccepted({
        statePath: input.statePath,
        scopes: input.scopes,
        resources: input.resources,
        attempt
      });
      attempt = required(
        finalized.attempt,
        "deferred replacement retry attempt disappeared after accepted finalization"
      );
      const acceptedConversation = finalized.conversation;
      startTerminalBridgeMonitorForConversation({
        conversation: acceptedConversation,
        statePath: input.statePath,
        logPath: input.logPath,
        options: input.options
      });
      printTerminalSubmissionRetryOutcome({
        conversation: acceptedConversation,
        terminalControl: input.terminalControl,
        attempt,
        outcome: "agent_accepted",
        terminalInputSent: true,
        reason: "The missing deferred Codex submission was completed once and its source/target Sessions were committed."
      });
      return;
    }
  } else {
    const timeoutMs = positiveMilliseconds(
      input.options.terminalAcceptanceTimeoutMs ??
        DEFAULT_TERMINAL_ACCEPTANCE_TIMEOUT_MS,
      "--terminal-acceptance-timeout-ms"
    );
    const acceptance = await input.execution.pollAcceptance({
      executor: "codex",
      conversation: enteredConversation,
      terminalControl: input.terminalControl,
      ...terminalAcceptanceCompanionFences(
        enteredConversation,
        input.terminalControl
      ),
      timeoutMs,
      pollIntervalMs: Math.max(10, Math.min(
        timeoutMs,
        Number(input.options.terminalAcceptancePollIntervalMs ??
          DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS)
      )),
      scrollbackLines: Number(input.options.scrollbackLines ?? 240)
    });
    assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    if (acceptance.outcome === "agent_accepted") {
      const repaired = terminalSubmissionRetryAccepted({
        conversation: enteredConversation,
        submission: required(
          terminalBridgeSubmission(enteredConversation),
          "terminal submission receipt disappeared after replacement acceptance"
        ),
        ledger: enteredLedger,
        evidence: acceptance.evidence,
        requestText: input.requestText,
        at: cliNow().toISOString(),
        statePath: input.statePath,
        logPath: input.logPath,
        scopes: input.scopes,
        resources: input.resources,
        attempt,
        terminalInputSent: true
      });
      startTerminalBridgeMonitorForConversation({
        conversation: repaired.conversation,
        statePath: input.statePath,
        logPath: input.logPath,
        options: input.options
      });
      printTerminalSubmissionRetryOutcome({
        conversation: repaired.conversation,
        terminalControl: input.terminalControl,
        attempt: repaired.attempt,
        outcome: "agent_accepted",
        terminalInputSent: true,
        reason: "The missing Codex submission was completed once and native acceptance was proven."
      });
      return;
    }
    if (acceptance.outcome === "not_accepted") {
      const notAcceptedConversation = terminalSubmissionRetryTerminalOutcome({
        conversation: enteredConversation,
        submission: required(
          terminalBridgeSubmission(enteredConversation),
          "terminal submission receipt disappeared after replacement rejection"
        ),
        ledger: enteredLedger,
        requestText: input.requestText,
        reason: acceptance.reason,
        at: cliNow().toISOString(),
        statePath: input.statePath,
        logPath: input.logPath,
        scopes: input.scopes,
        resources: input.resources,
        attempt,
        outcome: "not_accepted"
      });
      printTerminalSubmissionRetryOutcome({
        conversation: notAcceptedConversation,
        terminalControl: input.terminalControl,
        attempt,
        outcome: "not_accepted",
        terminalInputSent: true,
        reason: "The replacement text remains in the Codex composer after one Enter; it was not accepted and another retry is forbidden."
      });
      return;
    }
    if (acceptance.outcome === "uncertain") {
      const uncertainConversation = terminalSubmissionRetryTerminalOutcome({
        conversation: enteredConversation,
        submission: required(
          terminalBridgeSubmission(enteredConversation),
          "terminal submission receipt disappeared after uncertain replacement acceptance"
        ),
        ledger: enteredLedger,
        requestText: input.requestText,
        reason: acceptance.reason,
        at: cliNow().toISOString(),
        statePath: input.statePath,
        logPath: input.logPath,
        scopes: input.scopes,
        resources: input.resources,
        attempt,
        outcome: "uncertain"
      });
      printTerminalSubmissionRetryOutcome({
        conversation: uncertainConversation,
        terminalControl: input.terminalControl,
        attempt,
        outcome: "refused",
        terminalInputSent: true,
        reason: `Replacement acceptance is uncertain (${acceptance.reason}); another retry is forbidden.`
      });
      return;
    }
  }
  startTerminalBridgeMonitorForConversation({
    conversation: enteredConversation,
    statePath: input.statePath,
    logPath: input.logPath,
    options: input.options
  });
  printTerminalSubmissionRetryOutcome({
    conversation: enteredConversation,
    terminalControl: input.terminalControl,
    attempt,
    outcome: "enter_dispatched",
    terminalInputSent: true,
    reason: "The missing Codex submission received one text injection and one Enter; acceptance remains pending and another retry is forbidden."
  });
}

async function runSend(options) {
  if (options.respond !== true && stringValue(options.turn)) {
    return runTerminalSubmissionRetry(options);
  }
  const messageBody = required(options.message ?? options.request, "--message is required");
  // Ordinary send/respond owns Turn creation only. Reject native lifecycle
  // slash commands before resolving or mutating any Session/Turn state so a
  // caller cannot bypass lifecycle capabilities, CAS tokens, transition
  // recovery, or binding-generation updates by writing directly to tmux.
  terminalSubmissionPayload(messageBody);
  if (options.agentHardTimeoutMinutes !== undefined) {
    positiveMinutes(options.agentHardTimeoutMinutes, "--agent-hard-timeout-minutes");
  }
  if (options.respond === true) {
    return runTurnResponse({ options, messageBody });
  }
  if ((options.type ?? "task") !== "task") {
    throw new Error(
      "ordinary send only accepts message type task; use respond --turn to answer an in-flight Turn"
    );
  }

  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    return runRawTerminalSend(options, messageBody, terminalConversation);
  }
  return runManagedSessionSend(
    terminalManagedSendDependencies(),
    options,
    messageBody
  );
}

function terminalManagedSendDependencies():
  TerminalManagedSendDependencies {
  const runtime = terminalCommandRuntime();
  return {
    ports: runtime.ports,
    foregroundIdentificationAuthority,
    replayExactActiveTerminalSubmission,
    runTerminalControlSend,
    runtime: {
      now: () => cliNow()
    }
  };
}

function terminalHumanExplicitSendDependencies():
  TerminalHumanExplicitSendDependencies {
  const runtime = terminalCommandRuntime();
  return {
    ports: runtime.ports,
    managedSendAttempt: (
      options,
      messageBody,
      terminal,
      deferZeroInputFailurePresentation,
      attempt
    ) => runManagedRawTerminalSendAttempt(
      terminalManagedSendDependencies(),
      options,
      messageBody,
      terminal,
      deferZeroInputFailurePresentation,
      attempt
    ),
    runtime: {
      env: () => cliEnv(),
      now: () => cliNow(),
      log: (level, event, fields) => runtimeLog(level, event, fields),
      printJson: (value) => printJson(value),
      durableTerminalInputDispatched
    }
  };
}

async function runRawTerminalSend(
  options: Record<string, any>,
  messageBody: string,
  terminalConversation: TerminalCommandTarget
): Promise<void> {
  return runHumanExplicitTerminalSend(
    terminalHumanExplicitSendDependencies(),
    options,
    messageBody,
    terminalConversation
  );
}


async function runRespond(options) {
  const turnId = required(
    stringValue(options.turn ?? options.conversation ?? options.conversationId),
    "--turn is required"
  );
  return runSend({
    ...options,
    turn: turnId,
    conversation: turnId,
    session: undefined,
    type: "answer",
    respond: true
  });
}

async function runTurnResponse({ options, messageBody }) {
  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const initialConversation = loaded.conversation;
  const requestedOpenClawSession = stringValue(options.openclawSession);
  if (
    requestedOpenClawSession &&
    initialConversation.openclaw_session !== requestedOpenClawSession
  ) {
    throw new Error(
      `turn ${turnIdForConversation(initialConversation)} belongs to a ` +
      "different controller session; no terminal input was sent"
    );
  }
  const nativeTakeover = isRecord(initialConversation.native_session_takeover)
    ? initialConversation.native_session_takeover
    : undefined;
  const storedTerminalControl = terminalControlFromTakeover(nativeTakeover);
  const nativeTerminalId = stringValue(nativeTakeover?.native_session_id);
  if (!storedTerminalControl || !nativeTerminalId) {
    throw new Error(
      `turn ${turnIdForConversation(initialConversation)} is not attached to a live terminal`
    );
  }
  const storedPid = Number(nativeTakeover?.terminal_agent_pid);
  const storedAgent = executorForConversation(initialConversation).kind;
  const liveTerminal = Number.isSafeInteger(storedPid) && storedPid > 1
    ? await createTerminalAgentBridge(options).resolveStoredTerminal(
        storedAgent,
        storedPid,
        storedTerminalControl,
        terminalRuntimeIdentityForConversation(
          initialConversation,
          storedTerminalControl
        )
      )
    : undefined;
  if (
    !liveTerminal ||
    liveTerminal.agent !== executorForConversation(initialConversation).kind ||
    !terminalControlsShareIncarnation(
      liveTerminal.terminalControl,
      storedTerminalControl
    )
  ) {
    throw new Error(
      `turn ${turnIdForConversation(initialConversation)} is not attached to its expected live terminal`
    );
  }
  const terminalControl = liveTerminal.terminalControl;
  const responseStoreDir = pathsForConversationDir(
    path.dirname(statePath)
  ).storeDir;
  await withCanonicalMutationLocks(
    terminalWriterMutationLocks(responseStoreDir, terminalControl),
    async (scopes, resources) => {
      // Legacy identity migration may write the Turn, so keep it inside the
      // canonical terminal -> Store writer -> state ordering as well.
      await migrateLegacyTerminalAgentIdentity({ ...loaded, options });
      await withTerminalDispatchStateScope(
        scopes,
        resources,
        statePath,
        logPath,
        async (dispatchScopes, dispatchResources) => {
        let lockedConversation = loadState(statePath);
        let lockedTakeover = isRecord(
          lockedConversation.native_session_takeover
        )
          ? lockedConversation.native_session_takeover
          : undefined;
        const lockedControl = terminalControlFromTakeover(lockedTakeover);
        if (
          stringValue(lockedTakeover?.native_session_id) !== nativeTerminalId ||
          executorForConversation(lockedConversation).kind !== liveTerminal.agent ||
          !lockedControl ||
          !terminalControlsShareIncarnation(lockedControl, terminalControl)
        ) {
          throw new Error(
            "terminal control changed while waiting to respond; refresh status and retry"
          );
        }
        if (
          requestedOpenClawSession &&
          lockedConversation.openclaw_session !== requestedOpenClawSession
        ) {
          throw new Error(
            `turn ${turnIdForConversation(lockedConversation)} belongs to a ` +
            "different controller session; no terminal input was sent"
          );
        }
        lockedConversation = refineTerminalTurnEndpoint({
          conversation: lockedConversation,
          statePath,
          terminalControl
        });
        lockedTakeover = isRecord(lockedConversation.native_session_takeover)
          ? lockedConversation.native_session_takeover
          : undefined;
        if (replayExactActiveTerminalSubmission({
          options,
          terminalControl,
          requestText: String(messageBody),
          expectedStoreDir: responseStoreDir,
          expectedSessionId: sessionIdForConversation(lockedConversation),
          expectedTurnId: turnIdForConversation(lockedConversation),
          expectedMessageType: "answer",
          expectedStatePath: statePath
        })) {
          return;
        }
        if (lockedConversation.status !== "waiting_for_openclaw") {
          throw new Error(
            `cannot respond to turn ${turnIdForConversation(lockedConversation)}; ` +
            `turn is ${lockedConversation.status}, not waiting_for_openclaw`
          );
        }
        const prepared = prepareManagedSend({
          options: { ...options, type: "answer" },
          statePath,
          logPath,
          messageBody,
          stateLockHeld: true,
          persist: false
        });
        const preparedTakeover = isRecord(
          prepared.conversation.native_session_takeover
        )
          ? prepared.conversation.native_session_takeover
          : undefined;
        const terminalAgentPid = Number(preparedTakeover?.terminal_agent_pid);
        let responseManagedSession = tryLoadManagedSession(
          responseStoreDir,
          sessionIdForConversation(prepared.conversation)
        );
        const responseCodexCompanions: CodexAllowedCompanionSet =
          prepared.executor.kind === "codex" && responseManagedSession
            ? codexAllowedCompanionSetForManagedSession({
                storeDir: responseStoreDir,
                session: responseManagedSession
              })
            : { additional: [] };
        const currentNativeIdentity =
          await resolveCurrentNativeAgentSessionIdentity({
            options,
            agent: prepared.executor.kind,
            pid: terminalAgentPid,
            cwd: terminalControl.currentPath,
            preferredSessionId: responseCodexCompanions.primary
              ? stringValue(preparedTakeover?.terminal_agent_session_id)
              : undefined,
            allowedCompanionIdentity: responseCodexCompanions.primary,
            allowedAdditionalIdentities:
              responseCodexCompanions.additional
          });
        assertNativeAgentIdentityForTurn({
          conversation: prepared.conversation,
          currentIdentity: currentNativeIdentity,
          operation: "respond to"
        });
        if (responseManagedSession) {
          const logicalResponseIdentity = logicalIdentityForManagedSession({
            storeDir: responseStoreDir,
            session: responseManagedSession,
            observedIdentity: currentNativeIdentity
          });
          responseManagedSession = refineManagedSessionNativeIdentity({
            storeDir: responseStoreDir,
            session: responseManagedSession,
            terminalControl,
            identity: logicalResponseIdentity
          });
        }
        const currentTerminalControl = terminalControlFromTakeover(
          prepared.nativeTakeoverForSend
        );
        if (
          !currentTerminalControl ||
          !terminalControlsShareIncarnation(
            currentTerminalControl,
            terminalControl
          )
        ) {
          throw new Error(
            "terminal control changed while waiting to respond; refresh status and retry"
          );
        }
        const responseOptions = {
          ...options,
          type: "answer",
          agentTimeoutMinutes:
            options.agentTimeoutMinutes ??
            preparedTakeover?.terminal_bridge_inactivity_timeout_minutes ??
            DEFAULT_AGENT_TIMEOUT_MINUTES,
          agentHardTimeoutMinutes:
            options.agentHardTimeoutMinutes ??
            preparedTakeover?.terminal_bridge_hard_timeout_minutes ??
            DEFAULT_AGENT_HARD_TIMEOUT_MINUTES
        };
        await runTerminalControlSend({
          transaction: {
            scopes: dispatchScopes,
            resources: dispatchResources
          },
          options: responseOptions,
          conversation: prepared.conversation,
          nextConversation: prepared.nextConversation,
          executor: prepared.executor,
          message: prepared.message,
          recordMessageAfterSend: true,
          allowedPreMaterializationIdentity:
            responseCodexCompanions.primary,
          allowedAdditionalIdentities:
            responseCodexCompanions.additional,
          continuingTurnResponse: true
        });
        }
      );
    }
  );
}

async function runApprove(options) {
  const decision = terminalApprovalDecisionFromOptions(options);
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    assertExpectedHandoffTokenUsesExactTerminalSelector({
      options,
      terminal: terminalConversation
    });
    if (options.autoApproved === true) {
      throw new Error(
        "automatic approval requires an exact managed Turn and cannot use a raw terminal selector"
      );
    }
    if (decision !== "approve_once") {
      throw new Error(
        "terminal-scoped approval supports approve_once only; use an exact managed Turn to reject"
      );
    }
    await runTerminalConversationApprove({
      options,
      terminal: terminalConversation
    });
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  assertAutoApprovalCallbackRoute({
    options,
    conversation: loaded.conversation,
    statePath
  });
  const conversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (!terminalControl) {
    throw new Error(`conversation ${conversation.conversation_id} is not controlled through a terminal`);
  }
  const autoApproved = options.autoApproved === true;
  if (autoApproved && decision !== "approve_once") {
    throw new Error("automatic approval can only dispatch approve_once");
  }
  const callbackAuthority = autoApprovalCallbackAuthorityFromOptions(options);
  if (
    !["waiting_for_agent", "waiting_for_openclaw"].includes(
      conversation.status
    ) &&
    !(autoApproved && callbackAuthority)
  ) {
    throw new Error(
      `cannot approve ${conversation.conversation_id}; conversation is ${conversation.status}`
    );
  }

  const executor = executorForConversation(conversation);
  const monitoredApproval = isRecord(nativeTakeover?.["terminal_bridge_approval"])
    ? nativeTakeover.terminal_bridge_approval
    : undefined;
  const suppliedExpectedFingerprint = stringValue(options.expectedApprovalFingerprint);
  const expectedFingerprint = suppliedExpectedFingerprint ??
    monitoredApprovalFingerprint(monitoredApproval, decision);
  const claudeScreenApproval = executor.kind === "claude";
  if (claudeScreenApproval) {
    const monitoredState = isRecord(monitoredApproval?.approval_state)
      ? monitoredApproval.approval_state
      : undefined;
    const pendingDispatch = isRecord(
      nativeTakeover?.terminal_bridge_approval_dispatch
    )
      ? nativeTakeover.terminal_bridge_approval_dispatch
      : undefined;
    const lastApprovalFingerprint = stringValue(
      nativeTakeover?.terminal_bridge_last_approval_fingerprint
    );
    const lastApprovalMessageId = stringValue(
      nativeTakeover?.terminal_bridge_last_approval_message_id
    );
    const currentMessageId = stringValue(
      nativeTakeover?.terminal_bridge_message_id
    );
    const approvalResolvedAt = validTimestampMs(
      nativeTakeover?.terminal_bridge_approval_resolved_at
    );
    if (
      autoApproved &&
      callbackAuthority === undefined &&
      monitoredApproval === undefined &&
      pendingDispatch === undefined &&
      conversation.status === "waiting_for_agent" &&
      suppliedExpectedFingerprint !== undefined &&
      suppliedExpectedFingerprint === lastApprovalFingerprint &&
      lastApprovalMessageId !== undefined &&
      lastApprovalMessageId === currentMessageId &&
      approvalResolvedAt !== undefined
    ) {
      const monitor = ensureTerminalBridgeMonitorAfterApproval({
        conversation,
        statePath,
        logPath,
        terminalControl,
        options,
        reason: "approval_already_resolved"
      });
      printJson({
        conversation,
        approved: false,
        already_approved: true,
        blocked: false,
        reason: "Claude screen approval fingerprint was already consumed",
        terminal_control: terminalControl,
        monitor_pid: monitor.monitorPid ?? null,
        monitor_handoff_pid: monitor.handoffWatchdog?.pid ?? null
      });
      return;
    }
    // A provenance-bound callback whose approval is already absent must reach
    // the terminal+state lock.  Only the persisted callback message and the
    // locked consumed-approval receipt may classify it as an idempotent replay.
    if (callbackAuthority === undefined || monitoredApproval !== undefined) {
      const notifiedAt = validTimestampMs(monitoredApproval?.notified_at);
      if (
        conversation.status !== "waiting_for_openclaw" ||
        monitoredState?.decision_mode !== "keys" ||
        !stringValue(monitoredApproval?.fingerprint)
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "Claude screen approval requires a current managed-turn approval notification",
          terminal_control: terminalControl
        });
        return;
      }
      if (
        notifiedAt === undefined ||
        cliNowMs() - notifiedAt > CLAUDE_SCREEN_APPROVAL_TTL_MS
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "Claude screen approval expired; inspect and resolve the terminal manually",
          terminal_control: terminalControl
        });
        return;
      }
      if (
        !suppliedExpectedFingerprint ||
        expectedFingerprint !== monitoredApprovalFingerprint(
          monitoredApproval,
          decision
        )
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "Claude screen approval requires the latest notified fingerprint",
          terminal_control: terminalControl
        });
        return;
      }
      if (
        pendingDispatch?.state === "reserved" &&
        pendingDispatch.terminal_bridge_message_id ===
          nativeTakeover?.terminal_bridge_message_id
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "a previous Claude approval dispatch has an uncertain outcome; inspect and resolve the terminal manually",
          terminal_control: terminalControl
        });
        return;
      }
      if (
        expectedFingerprint ===
        stringValue(nativeTakeover?.terminal_bridge_last_approval_fingerprint)
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "Claude screen approval fingerprint was already consumed",
          terminal_control: terminalControl
        });
        return;
      }
    }
  }
  return runManagedApprovalDispatch({
    options, conversation, statePath, logPath,
    nativeTakeover: nativeTakeover as Record<string, any>,
    terminalControl, executor, monitoredApproval, expectedFingerprint,
    autoApproved, claudeScreenApproval, decision
  });
}

function terminalApprovalDecisionFromOptions(
  options: Record<string, any>
): TerminalApprovalDecision {
  const value = options.decision ?? "approve_once";
  if (!isTerminalApprovalDecision(value)) {
    throw new Error(
      "--decision must be one of: approve_once, reject"
    );
  }
  return value;
}

function monitoredApprovalFingerprint(
  approval: Record<string, unknown> | undefined,
  decision: TerminalApprovalDecision
): string | undefined {
  if (decision === "approve_once") {
    return stringValue(approval?.fingerprint);
  }
  const state = isRecord(approval?.approval_state)
    ? approval.approval_state
    : undefined;
  const choices = Array.isArray(state?.choices) ? state.choices : [];
  const choice = choices.find((candidate) =>
    isRecord(candidate) && candidate.decision === decision
  );
  return isRecord(choice) ? stringValue(choice.fingerprint) : undefined;
}

function approvalPolicyCandidateForInspection({
  agent,
  currentTerminalControl,
  inspection,
  fingerprint
}: Pick<
  TerminalApprovalAuthorizationContext,
  "agent" | "inspection" | "fingerprint"
> & {
  currentTerminalControl: TerminalControlRef;
}): ApprovalCandidate {
  const evidence = inspection.approval.approvable
    ? inspection.approval.policyEvidence
    : undefined;
  return {
    agent,
    kind: evidence?.kind ?? inspection.approval.promptKind ?? "unknown",
    decisionMode: inspection.approval.approvable
      ? inspection.approval.action.mode ?? "keys"
      : undefined,
    command: evidence?.command ?? inspection.approval.command,
    cwd: evidence?.cwd ?? inspection.approval.cwd ?? currentTerminalControl.currentPath,
    fingerprint: fingerprint ?? "",
    terminalTarget: currentTerminalControl.target,
    ...(evidence?.source === "claude_transcript"
      ? {
          evidenceSource: "claude_transcript" as const,
          evidenceFingerprint: evidence.evidenceFingerprint
        }
      : {})
  };
}

async function runManagedApprovalDispatch({
  options, conversation, statePath, logPath, nativeTakeover,
  terminalControl, executor, monitoredApproval, expectedFingerprint,
  autoApproved, claudeScreenApproval, decision
}: {
  options: Record<string, any>;
  conversation: Conversation;
  statePath: string;
  logPath: string;
  nativeTakeover: Record<string, any>;
  terminalControl: TerminalControlRef;
  executor: Executor;
  monitoredApproval?: Record<string, unknown>;
  expectedFingerprint?: string;
  autoApproved: boolean;
  claudeScreenApproval: boolean;
  decision: TerminalApprovalDecision;
}): Promise<void> {
  const policyRuleId = stringValue(options.policyRuleId);
  const policyFingerprint = stringValue(options.policyFingerprint);
  const autoApprovalPolicy = autoApproved
    ? parseJsonOption(options.autoApprovalPolicyJson, "--auto-approval-policy-json")
    : undefined;
  let executorPolicyDecision;
  const releaseTerminalLock = acquireTerminalBridgeSendLock(
    storeDirFromOptions(options),
    terminalControl,
    { timeoutMs: 30000 }
  );
  let terminalLockReleased = false;
  const releaseApprovalTerminalLock = () => {
    if (!terminalLockReleased) {
      terminalLockReleased = true;
      releaseTerminalLock();
    }
  };
  let releaseStateLock: (() => void) | undefined;
  let approvalDispatchReserved = false;
  const releaseApprovalStateLock = () => {
    if (releaseStateLock) {
      const release = releaseStateLock;
      releaseStateLock = undefined;
      release();
    }
  };
  const writerStoreDir = pathsForConversationDir(
    path.dirname(statePath)
  ).storeDir;
  const runApprovalWithStateLock = async () => {
    let approval;
    let lockedConversation = conversation;
    const currentConversation = loadState(statePath);
    const currentTakeover = isRecord(currentConversation.native_session_takeover)
      ? currentConversation.native_session_takeover
      : undefined;
    const currentControl = terminalControlFromTakeover(currentTakeover);
    const currentApproval = isRecord(currentTakeover?.terminal_bridge_approval)
      ? currentTakeover.terminal_bridge_approval
      : undefined;
    const callbackAuthorityState = assertAutoApprovalCallbackAuthority({
      options,
      conversation: currentConversation,
      statePath,
      takeover: currentTakeover,
      approval: currentApproval,
      expectedFingerprint
    });
    if (
      !currentControl ||
      !terminalControlsShareIncarnation(currentControl, terminalControl) ||
      (
        callbackAuthorityState !== "already_approved" &&
        (
          currentConversation.status !== conversation.status ||
          currentTakeover?.terminal_bridge_message_id !==
            nativeTakeover?.terminal_bridge_message_id ||
          (
            claudeScreenApproval &&
            monitoredApprovalFingerprint(currentApproval, decision) !==
              monitoredApprovalFingerprint(monitoredApproval, decision)
          )
        )
      )
    ) {
      throw new Error("approval state changed while waiting for terminal control; refresh status and retry");
    }
    lockedConversation = currentConversation;
    if (callbackAuthorityState === "already_approved") {
      releaseApprovalStateLock();
      printJson({
        conversation: lockedConversation,
        approved: false,
        already_approved: true,
        blocked: false,
        reason: "automatic approval callback was already handled",
        terminal_control: currentControl
      });
      return;
    }
    assertManagedTerminalDispatchOwner({
      storeDir: writerStoreDir,
      conversation: currentConversation,
      terminalControl: currentControl,
      action: "approve"
    });
    const currentRuntimeIdentity = terminalRuntimeIdentityForConversation(
      currentConversation,
      currentControl
    );
    approval = await createTerminalAgentBridge(options).approve(
      executor.kind,
      currentControl,
      {
        decision,
        expectedFingerprint,
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        runtime: currentRuntimeIdentity,
        managedRequest: terminalDurableRequestForConversation(
          currentConversation,
          currentControl
        ),
        requiredDecisionMode:
          autoApproved && executor.kind === "claude" ? "keys" : undefined,
        authorize: autoApproved
          ? ({ agent, terminalControl: currentTerminalControl, inspection, fingerprint }) => {
              if (!autoApprovalPolicy) {
                return {
                  approved: false,
                  reason: "automatic approval requires an executor-side policy"
                };
              }
              const candidate = approvalPolicyCandidateForInspection({
                agent,
                currentTerminalControl,
                inspection,
                fingerprint
              });
              executorPolicyDecision = evaluateApprovalPolicy({
                policy: autoApprovalPolicy,
                candidate
              });
              if (executorPolicyDecision.action !== "approve") {
                return {
                  approved: false,
                  reason: `executor-side auto-approval policy rejected the current request: ${executorPolicyDecision.reason}`
                };
              }
              if (policyRuleId && executorPolicyDecision.ruleId !== policyRuleId) {
                return {
                  approved: false,
                  reason: "executor-side auto-approval rule changed before execution"
                };
              }
              if (
                policyFingerprint &&
                executorPolicyDecision.policyFingerprint !== policyFingerprint
              ) {
                return {
                  approved: false,
                  reason: "executor-side auto-approval policy changed before execution"
                };
              }
              return { approved: true };
            }
          : undefined,
        beforeKeyDispatch: claudeScreenApproval
          ? ({ fingerprint, terminalControl: dispatchControl, inspection, keys }) => {
              if (autoApproved) {
                if (!autoApprovalPolicy) {
                  throw new Error(
                    "automatic approval requires an executor-side policy before dispatch"
                  );
                }
                const freshPolicyDecision = evaluateApprovalPolicy({
                  policy: autoApprovalPolicy,
                  candidate: approvalPolicyCandidateForInspection({
                    agent: executor.kind,
                    currentTerminalControl: dispatchControl,
                    inspection,
                    fingerprint
                  })
                });
                if (freshPolicyDecision.action !== "approve") {
                  throw new Error(
                    `executor-side auto-approval policy rejected the recaptured request: ${freshPolicyDecision.reason}`
                  );
                }
                if (
                  executorPolicyDecision?.ruleId &&
                  freshPolicyDecision.ruleId !== executorPolicyDecision.ruleId
                ) {
                  throw new Error(
                    "executor-side auto-approval rule changed after recapture"
                  );
                }
                if (policyRuleId && freshPolicyDecision.ruleId !== policyRuleId) {
                  throw new Error(
                    "executor-side auto-approval rule changed before dispatch"
                  );
                }
                if (
                  policyFingerprint &&
                  freshPolicyDecision.policyFingerprint !== policyFingerprint
                ) {
                  throw new Error(
                    "executor-side auto-approval policy changed before dispatch"
                  );
                }
                executorPolicyDecision = freshPolicyDecision;
              }
              if (approvalDispatchReserved) {
                throw new Error("Claude approval dispatch was already reserved");
              }
              approvalDispatchReserved = true;
              if (!releaseStateLock) {
                throw new Error(
                  "approval state lock was released before terminal dispatch"
                );
              }
              const latestConversation = loadState(statePath);
              const latestTakeover = isRecord(latestConversation.native_session_takeover)
                ? latestConversation.native_session_takeover
                : undefined;
              const latestControl = terminalControlFromTakeover(latestTakeover);
              const latestApproval = isRecord(latestTakeover?.terminal_bridge_approval)
                ? latestTakeover.terminal_bridge_approval
                : undefined;
              const latestNotifiedAt = validTimestampMs(latestApproval?.notified_at);
              const latestApprovalState = isRecord(latestApproval?.approval_state)
                ? latestApproval.approval_state
                : undefined;
              const latestPolicyEvidence = isRecord(latestApprovalState?.policy_evidence)
                ? latestApprovalState.policy_evidence
                : undefined;
              const recapturedPolicyEvidence = inspection.approval.approvable
                ? inspection.approval.policyEvidence
                : undefined;
              const latestDispatch = isRecord(
                latestTakeover?.terminal_bridge_approval_dispatch
              )
                ? latestTakeover.terminal_bridge_approval_dispatch
                : undefined;
              if (
                !latestTakeover ||
                latestConversation.status !== "waiting_for_openclaw" ||
                latestTakeover.terminal_bridge_message_id !==
                  nativeTakeover?.terminal_bridge_message_id ||
                monitoredApprovalFingerprint(latestApproval, decision) !==
                  fingerprint ||
                latestNotifiedAt === undefined ||
                cliNowMs() - latestNotifiedAt > CLAUDE_SCREEN_APPROVAL_TTL_MS ||
                expectedFingerprint !== fingerprint ||
                !terminalControlsShareIncarnation(
                  latestControl,
                  dispatchControl
                ) ||
                (
                  autoApproved &&
                  (
                    latestPolicyEvidence?.source !== "claude_transcript" ||
                    latestPolicyEvidence.evidence_fingerprint !==
                      recapturedPolicyEvidence?.evidenceFingerprint
                  )
                )
              ) {
                throw new Error(
                  "approval state changed before terminal dispatch; refresh status and retry"
                );
              }
              if (
                latestDispatch?.state === "reserved" &&
                latestDispatch.terminal_bridge_message_id ===
                  latestTakeover.terminal_bridge_message_id
              ) {
                throw new Error(
                  "a previous Claude approval dispatch has an uncertain outcome; inspect and resolve the terminal manually"
                );
              }
              const reservedAt = cliNow().toISOString();
              const reservedConversation = {
                ...latestConversation,
                native_session_takeover: {
                  ...latestTakeover,
                  terminal_bridge_approval_dispatch: {
                    state: "reserved",
                    attempt_id: randomUUID(),
                    decision,
                    fingerprint,
                    keys,
                    terminal_target: dispatchControl.target,
                    terminal_bridge_message_id:
                      latestTakeover.terminal_bridge_message_id,
                    reserved_at: reservedAt
                  }
                },
                updated_at: reservedAt
              };
              saveState(statePath, reservedConversation);
              lockedConversation = reservedConversation;
            }
          : undefined
      }
    );
    const actualFingerprint = approval.fingerprint;
    const effectivePolicyRuleId = executorPolicyDecision?.ruleId ?? policyRuleId;
    const effectivePolicyFingerprint =
      executorPolicyDecision?.policyFingerprint ?? policyFingerprint;
    if (approval.decisionDispatched !== true) {
      releaseApprovalStateLock();
      if (autoApproved) {
        appendEvent(logPath, {
          ts: cliNow().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_auto_approval_decision",
          action: "rejected",
          reason: approval.reason,
          terminal_control: terminalControl,
          expected_fingerprint: expectedFingerprint,
          actual_fingerprint: actualFingerprint,
          policy_rule_id: effectivePolicyRuleId,
          policy_fingerprint: effectivePolicyFingerprint
        });
      }
      printJson({
        conversation,
        approved: false,
        decision,
        decision_dispatched: false,
        blocked: approval.blocked,
        reason: approval.reason,
        terminal_control: terminalControl,
        expected_approval_fingerprint: expectedFingerprint,
        actual_approval_fingerprint: actualFingerprint,
        screen_excerpt: approval.screenExcerpt
      });
      return;
    }

    appendEvent(logPath, {
      ts: cliNow().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_approval_send",
      decision,
      terminal_control: terminalControl,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      approval_fingerprint: actualFingerprint,
      auto_approved: autoApproved,
      policy_rule_id: effectivePolicyRuleId,
      policy_fingerprint: effectivePolicyFingerprint
    });
    if (autoApproved) {
      appendEvent(logPath, {
        ts: cliNow().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_auto_approval_decision",
        action: "approved",
        terminal_control: terminalControl,
        approval_fingerprint: actualFingerprint,
        policy_rule_id: effectivePolicyRuleId,
        policy_fingerprint: effectivePolicyFingerprint
      });
    }
    runtimeLog("info", "terminal_approval_send", {
      conversation_id: conversation.conversation_id,
      terminal_target: terminalControl.target,
      decision,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      approval_fingerprint: actualFingerprint,
      auto_approved: autoApproved,
      policy_rule_id: effectivePolicyRuleId,
      policy_fingerprint: effectivePolicyFingerprint
    });
    const nativeTakeoverForUpdate: Record<string, unknown> = isRecord(lockedConversation.native_session_takeover)
      ? { ...lockedConversation.native_session_takeover }
      : {};
    const resolvedApproval = isRecord(
      nativeTakeoverForUpdate.terminal_bridge_approval
    )
      ? nativeTakeoverForUpdate.terminal_bridge_approval
      : undefined;
    const resolvedApprovalScreenDigest = stringValue(
      resolvedApproval?.screen_digest
    );
    const resolvedApprovalState = isRecord(resolvedApproval?.approval_state)
      ? resolvedApproval.approval_state
      : undefined;
    const resolvedTranscriptIdentity =
      claudeTranscriptApprovalIdentity(resolvedApprovalState);
    const approvalResolvedAt = cliNow().toISOString();
    const agentTimeoutMinutes = Number(
      options.agentTimeoutMinutes ??
        nativeTakeoverForUpdate.terminal_bridge_inactivity_timeout_minutes ??
        DEFAULT_AGENT_TIMEOUT_MINUTES
    );
    const agentHardTimeoutMinutes = positiveMinutes(
      options.agentHardTimeoutMinutes ??
        nativeTakeoverForUpdate.terminal_bridge_hard_timeout_minutes ??
        DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
      "--agent-hard-timeout-minutes"
    );
    const nextNativeTakeover: Record<string, unknown> = {
      ...nativeTakeoverForUpdate,
      terminal_bridge_approval: undefined,
      terminal_bridge_approval_dispatch: undefined,
      terminal_bridge_approval_resolved_at: approvalResolvedAt,
      terminal_bridge_last_approval_fingerprint: actualFingerprint,
      terminal_bridge_last_approval_decision: decision,
      terminal_bridge_last_approval_screen_digest:
        resolvedApprovalScreenDigest,
      terminal_bridge_last_approval_request_id:
        resolvedTranscriptIdentity?.requestId,
      terminal_bridge_last_approval_evidence_fingerprint:
        resolvedTranscriptIdentity?.evidenceFingerprint,
      terminal_bridge_last_approval_prompt_cleared_at: undefined,
      terminal_bridge_last_approval_at: approvalResolvedAt,
      terminal_bridge_last_approval_message_id:
        nativeTakeoverForUpdate.terminal_bridge_message_id,
      terminal_bridge_monitor_lock_version: monitorOwner.LOCK_VERSION,
      terminal_bridge_monitor_started_at: approvalResolvedAt,
      terminal_bridge_last_activity_at: approvalResolvedAt,
      terminal_bridge_last_activity_reason: "approval resolved",
      terminal_bridge_inactivity_timeout_minutes: agentTimeoutMinutes,
      terminal_bridge_hard_timeout_minutes: agentHardTimeoutMinutes,
      terminal_bridge_inactivity_deadline_at: deadlineAt(approvalResolvedAt, agentTimeoutMinutes),
      terminal_bridge_hard_deadline_at: deadlineAt(
        stringValue(nativeTakeoverForUpdate.terminal_bridge_started_at) ?? approvalResolvedAt,
        agentHardTimeoutMinutes
      )
    };
    delete nextNativeTakeover.terminal_bridge_approval;
    delete nextNativeTakeover.terminal_bridge_approval_dispatch;
    delete nextNativeTakeover.terminal_bridge_last_approval_prompt_cleared_at;
    const nextConversation = {
      ...lockedConversation,
      status: terminalBridgeEnabled(lockedConversation)
        ? "waiting_for_agent" as const
        : lockedConversation.status,
      native_session_takeover: nextNativeTakeover,
      updated_at: approvalResolvedAt
    };
    saveState(statePath, nextConversation);
    releaseApprovalStateLock();

    const bridgeMonitor = ensureTerminalBridgeMonitorAfterApproval({
      conversation: nextConversation,
      statePath,
      logPath,
      terminalControl,
      options
    });

    printJson({
      conversation: nextConversation,
      approved: decision === "approve_once",
      rejected: decision === "reject",
      decision,
      decision_dispatched: true,
      terminal_control: terminalControl,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      approval_fingerprint: actualFingerprint,
      auto_approved: autoApproved,
      policy_rule_id: effectivePolicyRuleId,
      policy_fingerprint: effectivePolicyFingerprint,
      monitor_pid: bridgeMonitor.monitorPid ?? null,
      monitor_handoff_pid: bridgeMonitor.handoffWatchdog?.pid ?? null
    });
  };
  try {
    return await withStoreWriterLeaseAsync(writerStoreDir, async () => {
      releaseStateLock = acquireFileLock(`${statePath}.lock`);
      try {
        return await runApprovalWithStateLock();
      } finally {
        releaseApprovalStateLock();
      }
    });
  } finally {
    try {
      releaseApprovalStateLock();
    } finally {
      releaseApprovalTerminalLock();
    }
  }
}

function assertAutoApprovalCallbackAuthority(input: {
  options: Record<string, any>;
  conversation: Conversation;
  statePath: string;
  takeover: Record<string, unknown> | undefined;
  approval: Record<string, unknown> | undefined;
  expectedFingerprint?: string;
}): "not_callback" | "current" | "already_approved" {
  if (input.options.autoApproved !== true) {
    return "not_callback";
  }
  const expected = autoApprovalCallbackAuthorityFromOptions(input.options);
  if (!expected) {
    return "not_callback";
  }
  assertAutoApprovalCallbackRoute({
    options: input.options,
    conversation: input.conversation,
    statePath: input.statePath
  });
  const delivery = isRecord(input.conversation.callback_delivery)
    ? input.conversation.callback_delivery
    : undefined;
  const callbackMessage = isRecord(delivery?.message)
    ? delivery.message
    : undefined;
  const callbackMetadata = isRecord(callbackMessage?.metadata)
    ? callbackMessage.metadata
    : undefined;
  const callbackCandidate = isRecord(callbackMetadata?.approval_candidate)
    ? callbackMetadata.approval_candidate
    : undefined;
  const callbackTerminalStatus = isRecord(callbackMetadata?.terminal_status)
    ? callbackMetadata.terminal_status
    : undefined;
  const callbackApprovalState = isRecord(callbackTerminalStatus?.approval_state)
    ? callbackTerminalStatus.approval_state
    : undefined;
  const persistedApprovalState = isRecord(input.approval?.approval_state)
    ? input.approval.approval_state
    : undefined;
  const callbackFingerprints = [
    stringValue(callbackMetadata?.approval_fingerprint),
    stringValue(callbackCandidate?.fingerprint),
    stringValue(callbackApprovalState?.fingerprint)
  ];
  const commonAuthorityMismatch =
    delivery?.kind !== "approval_notification" ||
      stringValue(callbackMessage?.id) !== expected.messageId ||
      stringValue(callbackMessage?.conversation_id) !== expected.conversationId ||
      stringValue(callbackMessage?.session_id) !== expected.sessionId ||
      stringValue(callbackMessage?.turn_id) !== expected.turnId ||
      !input.expectedFingerprint ||
      !/^[a-f0-9]{64}$/u.test(input.expectedFingerprint) ||
      callbackFingerprints.some((value) => value !== input.expectedFingerprint) ||
      input.takeover?.terminal_bridge !== true;
  if (commonAuthorityMismatch) {
    throw new Error(
      "automatic approval callback no longer matches the locked Turn state; refresh status and retry"
    );
  }
  if (input.approval) {
    const currentFingerprints = [
      stringValue(input.approval.fingerprint),
      stringValue(persistedApprovalState?.fingerprint)
    ];
    if (input.conversation.status !== "waiting_for_openclaw" ||
        currentFingerprints.some((value) => value !== input.expectedFingerprint) ||
        stringValue(input.approval.callback_message_id) !== expected.messageId) {
      throw new Error(
        "automatic approval callback no longer matches the locked Turn state; refresh status and retry"
      );
    }
    return "current";
  }
  if (
    input.takeover?.terminal_bridge_approval !== undefined ||
    input.takeover?.terminal_bridge_approval_dispatch !== undefined ||
    !isPostApprovalCallbackReplayStatus(input.conversation.status) ||
    stringValue(input.takeover?.terminal_bridge_message_id) !==
      expected.messageId ||
    stringValue(input.takeover?.terminal_bridge_last_approval_message_id) !==
      expected.messageId ||
    stringValue(input.takeover?.terminal_bridge_last_approval_fingerprint) !==
      input.expectedFingerprint ||
    validTimestampMs(
      input.takeover?.terminal_bridge_approval_resolved_at
    ) === undefined
  ) {
    throw new Error(
      "automatic approval callback no longer matches the locked Turn receipt; refresh status and retry"
    );
  }
  return "already_approved";
}

function isPostApprovalCallbackReplayStatus(
  status: ConversationStatus
): boolean {
  return [
    "waiting_for_agent",
    "running",
    "idle",
    "stalled",
    "callback_pending",
    "callback_failed",
    "failed",
    "closed",
    "cancelled",
    "cancelling"
  ].includes(status);
}

function autoApprovalCallbackAuthorityFromOptions(
  options: Record<string, any>
): {
  conversationId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  openclawSession: string;
} | undefined {
  const candidate = {
    conversationId: stringValue(options.expectedCallbackConversationId),
    sessionId: stringValue(options.expectedCallbackSessionId),
    turnId: stringValue(options.expectedCallbackTurnId),
    messageId: stringValue(options.expectedCallbackMessageId),
    openclawSession: stringValue(options.expectedCallbackOpenclawSession)
  };
  const values = Object.values(candidate);
  if (values.every((value) => value === undefined)) {
    return undefined;
  }
  if (values.some((value) => value === undefined)) {
    throw new Error(
      "automatic approval callback identity is incomplete; no approval key was sent"
    );
  }
  return candidate as {
    conversationId: string;
    sessionId: string;
    turnId: string;
    messageId: string;
    openclawSession: string;
  };
}

function assertAutoApprovalCallbackRoute(input: {
  options: Record<string, any>;
  conversation: Conversation;
  statePath: string;
}): void {
  if (input.options.autoApproved !== true) {
    return;
  }
  const expected = autoApprovalCallbackAuthorityFromOptions(input.options);
  if (!expected) {
    return;
  }
  const storedOpenClawSession = stringValue(
    input.conversation.gateway_session ?? input.conversation.openclaw_session
  );
  if (
    input.conversation.conversation_id !== expected.conversationId ||
    sessionIdForConversation(input.conversation) !== expected.sessionId ||
    turnIdForConversation(input.conversation) !== expected.turnId ||
    !sameCanonicalStatePath(input.conversation.state_path, input.statePath) ||
    storedOpenClawSession !== expected.openclawSession
  ) {
    throw new Error(
      "automatic approval callback does not match the selected Turn state; no state was changed"
    );
  }
}

async function runTerminalConversationApprove({
  options,
  terminal
}: {
  options: Record<string, any>;
  terminal: TerminalCommandTarget;
}) {
  const { conversationId, agent, terminalControl, pid } = terminal;
  const storeDir = storeDirFromOptions(options);
  const releaseTerminalLock = acquireTerminalBridgeSendLock(
    storeDir,
    terminalControl,
    { timeoutMs: 30000 }
  );
  try {
    if (agent === "claude") {
      printJson({
        conversation_id: conversationId,
        source: "terminal_control",
        approved: false,
        blocked: true,
        reason: "Claude screen approval requires `send --background` so AKK can bind it to an active managed turn",
        terminal_control: terminalControl
      });
      return;
    }
    const suppliedTerminalToken = stringValue(options.expectedTerminalToken);
    const initialResolution = await terminalListCliFacade.resolveTerminalScopedCodexApproval({
      options,
      terminal
    });
    if (initialResolution.state === "blocked") {
      throw new Error(initialResolution.reason);
    }
    if (initialResolution.state === "unmanaged" && suppliedTerminalToken) {
      throw new Error(
        "--expected-terminal-token does not match an advertised terminal-scoped Codex approval"
      );
    }
    if (
      initialResolution.state === "eligible" &&
      suppliedTerminalToken !== initialResolution.boundary.token
    ) {
      throw new Error(
        "terminal-scoped Codex approval token is missing or stale; refresh AKK list"
      );
    }
    const runtime = {
      pid,
      cwd: terminalControl.currentPath,
      conversationId,
      terminalTarget: terminalControl.target
    };
    const approveCurrentPrompt = async (terminalScoped: boolean) =>
      createTerminalAgentBridge(options).approve(agent, terminalControl, {
        expectedFingerprint: stringValue(options.expectedApprovalFingerprint),
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        runtime,
        beforeKeyDispatch: terminalScoped
          ? async (context) => {
              const approvalSnapshot =
                terminalScopedCodexApprovalPromptSnapshot({
                  approvable: true,
                  fingerprint: context.fingerprint,
                  keys: context.keys,
                  decision_mode:
                    context.inspection.approval.approvable
                      ? context.inspection.approval.action.mode ?? "keys"
                      : undefined,
                  request_id:
                    context.inspection.approval.approvable
                      ? context.inspection.approval.action.requestId
                      : undefined
                });
              const current = await terminalListCliFacade.resolveTerminalScopedCodexApproval({
                options,
                terminal,
                approvalSnapshot
              });
              if (
                current.state !== "eligible" ||
                current.boundary.token !== suppliedTerminalToken
              ) {
                throw new Error(
                  current.state === "blocked"
                    ? current.reason
                    : "terminal-scoped Codex approval authority changed before key dispatch"
                );
              }
            }
          : undefined
      });
    const terminalScoped = initialResolution.state === "eligible";
    const approval = terminalScoped
      ? await withStoreWriterLeaseAsync(storeDir, async () => {
          const current = await terminalListCliFacade.resolveTerminalScopedCodexApproval({
            options,
            terminal
          });
          if (
            current.state !== "eligible" ||
            current.boundary.token !== suppliedTerminalToken
          ) {
            throw new Error(
              current.state === "blocked"
                ? current.reason
                : "terminal-scoped Codex approval authority changed while waiting for Store control"
            );
          }
          return approveCurrentPrompt(true);
        })
      : await approveCurrentPrompt(false);
    if (!approval.approved) {
      printJson({
        conversation_id: conversationId,
        source: "terminal_control",
        approved: false,
        blocked: approval.blocked,
        reason: approval.reason,
        terminal_control: terminalControl,
        screen_excerpt: approval.screenExcerpt
      });
      return;
    }

    runtimeLog("info", "terminal_approval_send", {
      conversation_id: conversationId,
      agent,
      terminal_target: terminalControl.target,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId
    });

    printJson({
      conversation_id: conversationId,
      source: "terminal_control",
      approved: true,
      terminal_control: terminalControl,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      approval_fingerprint: approval.fingerprint,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      terminal_scoped: terminalScoped,
      ...(terminalScoped
        ? {
            durable_dispatch_receipt: false,
            uncertain_outcome_recovery:
              "refresh status and inspect the live prompt; do not retry blindly"
          }
        : {})
    });
  } finally {
    releaseTerminalLock();
  }
}

function terminalDispatchPreparationPorts(): TerminalDispatchPreparationPorts {
  return {
    assertCodexComposerReadyForAutomatedInput,
    assertNoUnresolvedTerminalBridgeSubmission,
    assertSafeTerminalSend,
    createRegistry: createRuntimeTerminalAgentRegistry,
    createTerminalBridge: createTerminalAgentBridge,
    execution: terminalDispatchExecution,
    foregroundProofs: foregroundIdentificationAuthority,
    loadClaudeAgentRows,
    loadDispatchLedger: loadTerminalBridgeDispatchLedger,
    loadDispatchOwner: loadTerminalDispatchLedgerOwner,
    now: cliNow,
    positiveMinutes,
    reconcilePreparedLedger: reconcilePreparedTerminalDispatchLedger,
    requestFingerprint: terminalBridgeRequestFingerprint,
    required,
    resolveLedgerPaneIncarnation:
      resolveTerminalDispatchLedgerPaneIncarnation,
    terminalBridgeEnabled,
    terminalRuntimeForLiveIdentity,
    terminalRuntimeIdentityForConversation,
    presentation: {
      write: printJson,
      budget: budgetAction,
      nextAction: openClawYieldNextAction,
      summarize: textSummary
    }
  };
}

function terminalAcceptanceCompanionFences(
  conversation: Conversation,
  terminalControl: TerminalControlRef
): {
  allowedCompanionIdentity?: CodexPreMaterializationIdentity;
  allowedAdditionalIdentities?: CodexPreMaterializationIdentity[];
} {
  if (executorForConversation(conversation).kind !== "codex") {
    return {};
  }
  const runtime = terminalRuntimeIdentityForConversation(
    conversation,
    terminalControl
  );
  return {
    allowedCompanionIdentity:
      runtime.allowedPreMaterializationNativeIdentity,
    allowedAdditionalIdentities:
      runtime.allowedAdditionalNativeIdentities
  };
}

function terminalDispatchTransportDependencies():
  TerminalDispatchTransportDependencies {
  const ports: TerminalDispatchTransportCliPorts = {
    assertDeferredCodexForegroundBindingBoundary,
    assertNativeThreadHasExclusiveOwnership,
    assertObservedHandoffTransportBoundary,
    assertVerifiedEmptyCodexTransportBoundary,
    deferredForegroundApplication,
    deferredForegroundRecoveryAdapterPorts,
    managedSessionStoreDirForConversation,
    persistManagedSessionNativeIdentity,
    prepareManagedSessionNativeIdentityClaim:
      rawPort("prepareManagedSessionNativeIdentityClaim"),
    quarantineManagedSessionBinding,
    required,
    stallOtherTerminalBridgeConversationsForUncertainDispatch,
    startTerminalBridgeMonitorForConversation,
    terminalBindingLedgerFields,
    terminalBridgeRuntimeKey,
    terminalControlFromTakeover,
    terminalDispatchCapabilityRepositories,
    terminalRuntimeIdentityForConversation,
    withTerminalBridgeSubmission
  };
  return {
    ports,
    prepare: prepareTerminalControlSend,
    preparationPorts: terminalDispatchPreparationPorts(),
    defaults: {
      agentTimeoutMinutes: DEFAULT_AGENT_TIMEOUT_MINUTES,
      agentHardTimeoutMinutes: DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
      ordinaryScrollbackLines: 120,
      foregroundScrollbackLines: 240,
      acceptanceTimeoutMs: DEFAULT_TERMINAL_ACCEPTANCE_TIMEOUT_MS,
      acceptancePollIntervalMs:
        DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS
    },
    foregroundProofs: foregroundIdentificationAuthority,
    runtime: {
      appendEvent,
      env: cliEnv,
      exit: cliExit,
      now: cliNow,
      pid: cliPid,
      log: runtimeLog
    }
  };
}

async function runTerminalControlSend(
  request: TerminalControlSendRequest
) {
  return executeTerminalControlSend(
    request,
    terminalDispatchTransportDependencies()
  );
}
export function createTerminalCommandCliFacade(
  dependencies: TerminalCommandCliDependencies
): TerminalCommandCliFacade {
  const call = <Result>(operation: () => Result): Result =>
    terminalCommandContext.run(dependencies, operation);
  return Object.freeze({
    runSend: (options) => call(() => runSend(options)),
    runRespond: (options) => call(() => runRespond(options)),
    runApprove: (options) => call(() => runApprove(options))
  });
}
