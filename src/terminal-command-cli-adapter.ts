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
  callbackExpectedForConversationWithLegacyFallback
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
  type Conversation
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
  saveState
} from "./store.js";
import { tryLoadManagedSession } from "./session-store.js";
import {
  type TerminalControlRef,
  type TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  terminalControlEvidenceMatches
} from "./terminal-control-ref.js";
import {
  type TerminalAgentBridge
} from "./terminal-agent-bridge.js";
import { TerminalSubmissionRetryApplication } from
  "./terminal-submission-retry-application.js";
import { TerminalSubmissionRetryReconciliation } from
  "./terminal-submission-retry-reconciliation.js";
import { TerminalSubmissionRetryTransport } from
  "./terminal-submission-retry-transport.js";
import type { TerminalSubmissionRetryPorts } from
  "./terminal-submission-retry-ports.js";
import {
  terminalControlsShareIncarnation,
  type CodexAllowedCompanionSet,
  type CodexPreMaterializationIdentity
} from "./terminal-authority-policy.js";
import {
  type CanonicalMutationResources,
  type CanonicalMutationScopes,
  withCanonicalMutationLocks
} from "./mutation-transaction.js";
import {
  assertTerminalDispatchRouteMatches,
  type BoundTerminalDispatchRoute
} from "./terminal-dispatch-capability.js";
import {
  terminalMonitorDeadlineAt as deadlineAt
} from "./terminal-monitor-decision-policy.js";
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
import {
  runTerminalApproval,
  type TerminalApprovalCliDependencies
} from "./terminal-approval-cli-adapter.js";
import {
  createCodexForegroundProofAuthority
} from "./terminal-command-foreground-proof.js";
import {
  presentTerminalCompleted,
  presentTerminalDispatchReplay,
  presentTerminalIdentityFailure,
  terminalSendResultContract,
  presentTerminalUncertain,
  presentTerminalZeroInputAbort as renderTerminalZeroInputAbort
} from "./terminal-dispatch-presenter.js";
import * as dispatchReceipt from "./terminal-dispatch-receipt.js";
import { writeCliJson as printJson } from "./cli-command-runtime.js";
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

function terminalSubmissionRetryPorts(): TerminalSubmissionRetryPorts {
  return {
    assertDeferredCodexForegroundBindingBoundary,
    createTerminalAgentBridge,
    deferredForegroundApplication,
    deferredForegroundRecoveryAdapterPorts,
    durableTerminalInputDispatched,
    loadConversationFromOptions,
    mutationDispatchLedger,
    required,
    startTerminalBridgeMonitorForConversation,
    terminalAcceptanceCompanionFences,
    terminalBridgeRequestFingerprint,
    terminalBridgeRuntimeKey,
    terminalControlFromTakeover,
    terminalDispatchExecution,
    terminalDispatchRecordMatchesControl,
    terminalRuntimeIdentityForConversation,
    terminalWriterMutationLocks,
    validateStoredTerminalSubmissionMatch,
    withTerminalBridgeSubmission,
    withTerminalDispatchStateScope
  };
}

async function runTerminalSubmissionRetry(
  options: TerminalCommandCliOptions
): Promise<void> {
  const ports = terminalSubmissionRetryPorts();
  const reconciliation = new TerminalSubmissionRetryReconciliation(ports);
  const transport = new TerminalSubmissionRetryTransport(
    ports,
    reconciliation
  );
  const application = new TerminalSubmissionRetryApplication(
    ports,
    reconciliation,
    transport
  );
  await application.runTerminalSubmissionRetry(options);
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

function terminalApprovalDependencies():
  TerminalApprovalCliDependencies {
  const runtime = terminalCommandRuntime();
  return {
    ports: runtime.ports,
    runtime: {
      now: () => cliNow(),
      nowMs: () => cliNowMs(),
      log: (level, event, fields) => runtimeLog(level, event, fields),
      printJson: (value) => printJson(value)
    },
    defaults: {
      agentTimeoutMinutes: DEFAULT_AGENT_TIMEOUT_MINUTES,
      agentHardTimeoutMinutes: DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
      claudeScreenApprovalTtlMs: CLAUDE_SCREEN_APPROVAL_TTL_MS
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

async function runApprove(
  options: TerminalCommandCliOptions
): Promise<void> {
  return runTerminalApproval(
    terminalApprovalDependencies(),
    options
  );
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
