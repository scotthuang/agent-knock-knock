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
  captureClaudeTranscriptAnchor,
  defaultClaudeHome,
  type ClaudeTranscriptAnchor
} from "./claude-local-transcript-provider.js";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import {
  type CodexRolloutAcceptanceAnchor
} from "./terminal-submission-acceptance.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import {
  type DeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import type {
  CodexOpenRootRolloutInventory
} from "./agent-session-provider.js";
import type { ExecutorKind } from "./executors.js";
import {
  applyMessageToConversation,
  budgetAction,
  createMessage,
  effectiveTurnStatus,
  executorForConversation,
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
  ensureStoreWritable,
  listConversations,
  loadState,
  messageEvent,
  pathsForConversationDir,
  saveState,
  withStoreWriterLeaseAsync
} from "./store.js";
import type { EventRecord } from "./store.js";
import {
  createManagedSessionId,
  managedSessionBindingToken,
  type ManagedSessionState,
  type NativeThreadTransition
} from "./managed-session.js";
import {
  loadManagedSession,
  saveManagedSession,
  tryLoadManagedSession
} from "./session-store.js";
import {
  type TerminalAgentAdapterRegistry as TerminalRegistry,
  type TerminalControlRef,
  type TerminalDurableCompletionRequest,
  type TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  terminalControlEvidenceMatches
} from "./terminal-control-ref.js";
import {
  TerminalInputNotStartedError,
  type TerminalAgentBridge,
  type TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import {
  evaluateApprovalPolicy,
  type ApprovalCandidate
} from "./approval-policy.js";
import {
  type TerminalNativeIdentity as NativeAgentSessionIdentity
} from "./terminal-binding-authority.js";
import {
  codexCompanionsPresentInOpenRootInventory,
  isCompleteNativeRollout,
  nativeIdentityMatchesCodexPreMaterialization,
  terminalControlsShareIncarnation,
  type CodexAllowedCompanionSet,
  type CodexPreMaterializationIdentity
} from "./terminal-authority-policy.js";
import {
  decideTerminalSendAuthority
} from "./terminal-action-projection.js";
import {
  terminalScopedCodexApprovalPromptSnapshot
} from "./terminal-scoped-approval-authority.js";
import type {
  TerminalScopedCodexApprovalBoundary,
  TerminalScopedCodexApprovalPromptSnapshot
} from "./terminal-scoped-approval-authority.js";
import {
  type CanonicalMutationLockPorts,
  type CanonicalMutationResources,
  type CanonicalMutationScopes,
  type CanonicalStateMutationResources,
  type CanonicalStateMutationScopes,
  withCanonicalMutationLocks
} from "./mutation-transaction.js";
import {
  assertTerminalDispatchRouteMatches,
  bindTerminalDispatchCapabilities,
  bindTerminalDispatchRoute,
  withExactTerminalDispatchRoute,
  type BoundTerminalDispatchRoute,
  type TerminalDispatchCapabilityRepositories
} from "./terminal-dispatch-capability.js";
import {
  claudeTranscriptApprovalIdentity,
  terminalMonitorDeadlineAt as deadlineAt,
  terminalMonitorScreenFingerprint as terminalBridgeScreenFingerprint,
  validTerminalMonitorTimestampMs as validTimestampMs
} from "./terminal-monitor-decision-policy.js";
import * as monitorOwner from "./terminal-monitor-ownership-policy.js";
import {
  sameCanonicalStatePath,
  terminalDispatchLedgerLooksLifecycle,
  terminalDispatchReceiptHistory as terminalLedgerReceiptHistory,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import * as dispatchApplication from "./terminal-dispatch-application.js";
import type {
  DeferredCodexForegroundBindingBoundary,
  TerminalDispatchTerminal,
  TerminalControlSendRequest,
  VerifiedEmptyCodexHandoffBoundary
} from "./terminal-dispatch-composition.js";
import type { DeferredForegroundApplicationScope } from
  "./deferred-foreground-boundary.js";
import type { DeferredForegroundApplicationService } from
  "./deferred-foreground-application-service.js";
import {
  bindDeferredForegroundApplicationScope,
  bindDeferredForegroundWriterScope
} from "./deferred-foreground-capability.js";
import * as deferredRecoveryAdapter from "./deferred-foreground-recovery-cli-adapter.js";
import type { DeferredForegroundRecoveryAdapterPorts } from
  "./deferred-foreground-recovery-cli-adapter.js";
import {
  deferredForegroundBoundaryProjection
} from "./deferred-foreground-preparation-cli-adapter.js";
import {
  terminalSubmissionPayload
} from "./terminal-dispatch-execution.js";
import type {
  NativeAgentSessionIdentityObservation,
  NativeIdentityResolutionRequest,
  TerminalDispatchExecutionService
} from "./terminal-dispatch-execution.js";
import {
  presentTerminalCompleted,
  presentTerminalDispatchReplay,
  presentTerminalIdentityFailure,
  presentTerminalUncertain,
  presentTerminalZeroInputAbort as renderTerminalZeroInputAbort
} from "./terminal-dispatch-presenter.js";
import * as dispatchReceipt from "./terminal-dispatch-receipt.js";
import type { TerminalBridgeSubmissionMutation } from
  "./terminal-dispatch-receipt.js";
import type { FileLockAcquisitionOptions } from "./file-lock-cli-adapter.js";
import {
  expandHome,
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

export interface TerminalCommandCliOptions {
  agentHardTimeoutMinutes?: number | string;
  agentTimeoutMinutes?: number | string;
  autoApprovalPolicyJson?: string;
  autoApproved?: boolean;
  background?: boolean;
  claudeHome?: string;
  conversation?: string;
  conversationId?: string;
  expectedApprovalFingerprint?: string;
  expectedTerminalToken?: string;
  logDir?: string;
  message?: string;
  messageId?: string;
  openclawSession?: string;
  policyFingerprint?: string;
  policyRuleId?: string;
  request?: string;
  respond?: boolean;
  scrollbackLines?: number | string;
  session?: string;
  state?: string;
  storeDir?: string;
  terminalAcceptancePollIntervalMs?: number | string;
  terminalAcceptanceTimeoutMs?: number | string;
  turn?: string;
  type?: string;
  [option: string]: unknown;
}

type TerminalCommandTarget = TerminalDispatchTerminal;
type TerminalDispatchRecord = Record<string, unknown>;

interface LoadedTerminalConversation {
  conversation: Conversation;
  statePath: string;
  logPath: string;
}

interface TerminalMonitorProcess {
  pid?: number;
}

interface TerminalApprovalMonitorResult {
  monitorPid?: number;
  handoffWatchdog?: TerminalMonitorProcess;
}

interface TerminalManagedTurn {
  conversation: Conversation;
  nextConversation: Conversation;
  statePath: string;
  logPath: string;
  executor: Executor;
  message: AgentMessage;
}

interface TerminalObservedHandoff {
  session?: ManagedSessionState;
  identity?: NativeAgentSessionIdentity;
  transition?: NativeThreadTransition;
  adopted: boolean;
}

type TerminalScopedApprovalResolution =
  | { state: "unmanaged" }
  | { state: "blocked"; reason: string }
  | { state: "eligible"; boundary: TerminalScopedCodexApprovalBoundary };

interface TerminalCommandCliRawPorts {
  acquireFileLock(
    lockPath: string,
    options?: FileLockAcquisitionOptions
  ): () => void;
  acquireTerminalBridgeSendLock(
    storeDir: string,
    terminalControl: TerminalControlRef,
    options?: FileLockAcquisitionOptions
  ): () => void;
  assertCodexComposerReadyForAutomatedInput(request: {
    options: TerminalCommandCliOptions;
    terminalControl: TerminalControlRef;
  }): Promise<void>;
  assertDeferredCodexForegroundBindingBoundary(request: {
    options: TerminalCommandCliOptions;
    scope: DeferredForegroundApplicationScope;
    boundary: DeferredCodexForegroundBindingBoundary;
    expectedSourceStatus: "bound" | "transitioning";
    requireNoDispatch: boolean;
    requireEmptyComposer: boolean;
  }): Promise<ManagedSessionState>;
  assertExpectedHandoffTokenUsesExactTerminalSelector(request: {
    options: TerminalCommandCliOptions;
    terminal: TerminalCommandTarget;
  }): void;
  assertManagedSessionCanStartTurn(turns: Conversation[]): void;
  assertManagedTerminalDispatchOwner(request: {
    storeDir: string;
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    action: "approve" | "cancel";
  }): void;
  assertNativeAgentIdentityForTurn(request: {
    conversation: Conversation;
    currentIdentity: NativeAgentSessionIdentity | undefined;
    operation: string;
  }): void;
  assertNativeThreadHasExclusiveOwnership(request: {
    options: TerminalCommandCliOptions;
    agent: ExecutorKind;
    currentPid: number;
    nativeThreadId: string;
    storeDir: string;
    terminalControl: TerminalControlRef;
    excludedManagedSessionId?: string;
    allowedManagedSessionIds?: string[];
  }): Promise<void>;
  assertObservedHandoffTransportBoundary(request: {
    options: TerminalCommandCliOptions;
    terminal: TerminalCommandTarget;
    transition: NativeThreadTransition;
    requireEmptyComposer: boolean;
  }): Promise<void>;
  assertSafeAbortedTerminalRetryBinding(request: {
    owner: Conversation;
    receipt: TerminalDispatchRecord;
    storeDir: string;
    terminalControl: TerminalControlRef;
    messageId: string;
  }): ManagedSessionState | undefined;
  assertSafeTerminalSend(
    agent: ExecutorKind,
    status: TerminalBridgeStatus
  ): void;
  assertVerifiedEmptyCodexTransportBoundary(request: {
    options: TerminalCommandCliOptions;
    boundary: VerifiedEmptyCodexHandoffBoundary;
    requireEmptyComposer: boolean;
  }): Promise<void>;
  bindingMatchesLiveTerminal(
    session: ManagedSessionState,
    terminal: TerminalCommandTarget,
    identity: NativeAgentSessionIdentity | undefined,
    storeDir: string
  ): boolean;
  codexAllowedCompanionSetForManagedSession(request: {
    storeDir: string;
    session: ManagedSessionState;
  }): CodexAllowedCompanionSet;
  codexPreMaterializationIdentityForManagedSession(request: {
    storeDir: string;
    session: ManagedSessionState;
    observedIdentity?: NativeAgentSessionIdentity;
  }): CodexPreMaterializationIdentity | undefined;
  createBoundManagedSession(request: {
    sessionId: string;
    terminal: TerminalCommandTarget;
    identity?: NativeAgentSessionIdentity;
    nativeThreadId?: string;
    evidence?: string;
    generation?: number;
    lineage: ManagedSessionState["lineage"];
    now?: Date;
  }): ManagedSessionState;
  createManagedTerminalTurn(request: {
    options: TerminalCommandCliOptions;
    conversationId: string;
    agent: ExecutorKind;
    pid: number;
    messageBody: string;
    terminalControl: TerminalControlRef;
    previousTurn?: Conversation;
    managedSession?: ManagedSessionState;
    nativeAgentIdentity?: NativeAgentSessionIdentity;
    deferredForegroundTransferId?: string;
  }): TerminalManagedTurn;
  createRuntimeTerminalAgentRegistry(
    options: TerminalCommandCliOptions
  ): TerminalRegistry;
  createTerminalAgentBridge(
    options: TerminalCommandCliOptions
  ): TerminalAgentBridge;
  deferredForegroundApplication(
    options: TerminalCommandCliOptions,
    terminal?: TerminalCommandTarget
  ): DeferredForegroundApplicationService;
  deferredForegroundRecoveryAdapterPorts():
    DeferredForegroundRecoveryAdapterPorts;
  ensureTerminalBridgeMonitorAfterApproval(request: {
    conversation: Conversation;
    statePath: string;
    logPath: string;
    terminalControl: TerminalControlRef;
    options: TerminalCommandCliOptions;
    reason?: string;
  }): TerminalApprovalMonitorResult;
  exactSafeAbortedRecoveredSessionMatches(request: {
    owner: Conversation;
    receipt?: TerminalDispatchRecord;
    storeDir: string;
    terminalControl: TerminalControlRef;
    messageId: string;
    expectedSessionId: string;
  }): boolean;
  inspectCodexOpenRootRolloutInventory(request: {
    options: TerminalCommandCliOptions;
    pid: number;
    cwd?: string;
  }): Promise<CodexOpenRootRolloutInventory>;
  isDiscoverableTmuxConversation(conversation: Conversation): boolean;
  loadClaudeAgentRows(
    options?: TerminalCommandCliOptions,
    observation?: { required?: boolean }
  ): ClaudeAgentRow[];
  loadConversationFromOptions(
    options: TerminalCommandCliOptions
  ): LoadedTerminalConversation;
  loadTerminalBridgeDispatchLedger(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined;
  loadTerminalDispatchLedgerOwner(
    ledger: TerminalDispatchRecord
  ): Conversation | undefined;
  logicalIdentityForManagedSession(request: {
    storeDir: string;
    session: ManagedSessionState;
    observedIdentity?: NativeAgentSessionIdentity;
  }): NativeAgentSessionIdentity | undefined;
  managedSessionStoreDirForConversation(
    conversation: Conversation
  ): string | undefined;
  managedTurnsForSession(storeDir: string, sessionId: string): Conversation[];
  materializeCurrentManagedSession(request: {
    options: TerminalCommandCliOptions;
    terminal: TerminalCommandTarget;
    identity?: NativeAgentSessionIdentity;
  }): ManagedSessionState | undefined;
  maybeAdoptObservedExternalThread(request: {
    options: TerminalCommandCliOptions;
    terminal: TerminalCommandTarget;
    sourceSession?: ManagedSessionState;
    resolvedIdentity?: NativeAgentSessionIdentity;
    storeDir: string;
  }): Promise<TerminalObservedHandoff>;
  maybeDetachVerifiedEmptyCodexSource(request: {
    options: TerminalCommandCliOptions;
    terminal: TerminalCommandTarget;
    sourceSession?: ManagedSessionState;
    observation: NativeAgentSessionIdentityObservation;
  }): Promise<{
    detached: ManagedSessionState;
    boundary: VerifiedEmptyCodexHandoffBoundary;
  } | undefined>;
  migrateLegacyTerminalAgentIdentity(request: LoadedTerminalConversation & {
    options: TerminalCommandCliOptions;
  }): Promise<Conversation>;
  mutationDispatchLedger: {
    beforeMutation(
      scopes: CanonicalMutationScopes,
      resources: CanonicalMutationResources,
      options: TerminalCommandCliOptions,
      terminal: TerminalCommandTarget
    ): Promise<void>;
  };
  openClawYieldNextAction(request: {
    conversationId: string;
    sessionId: string;
    turnId: string;
    source: string;
    callbackExpected: boolean;
  }): TerminalDispatchRecord;
  observeCurrentNativeAgentSessionIdentity(
    request: NativeIdentityResolutionRequest & {
      options: TerminalCommandCliOptions;
    }
  ): Promise<NativeAgentSessionIdentityObservation>;
  parseJsonOption(value: unknown, optionName: string): unknown;
  persistManagedSessionNativeIdentity(request: {
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    identity: NativeAgentSessionIdentity;
    storeDir: string;
  }): ManagedSessionState | undefined;
  positiveMinutes(value: unknown, optionName: string): number;
  prepareDeferredCodexForegroundBinding(request: {
    options: TerminalCommandCliOptions;
    scope: DeferredForegroundApplicationScope;
    terminal: TerminalCommandTarget;
    sourceSession?: ManagedSessionState;
    observation: NativeAgentSessionIdentityObservation;
    candidateInventory?: CodexOpenRootRolloutInventory;
    requestText: string;
    allowImplicitFreshAuthority?: boolean;
  }): Promise<DeferredCodexForegroundBindingBoundary | undefined>;
  quarantineManagedSessionBinding(request: {
    conversation: Conversation;
    reason: string;
    storeDir: string;
  }): void;
  reattachManagedSessionForNativeIdentity(request: {
    options: TerminalCommandCliOptions;
    terminal: TerminalCommandTarget;
    identity: NativeAgentSessionIdentity;
    storeDir: string;
  }): Promise<ManagedSessionState | undefined>;
  reconcilePreparedTerminalDispatchLedger(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchRecord
  ): TerminalDispatchLedgerDocument | undefined;
  refineManagedSessionNativeIdentity(request: {
    storeDir: string;
    session: ManagedSessionState;
    terminalControl: TerminalControlRef;
    identity?: NativeAgentSessionIdentity;
  }): ManagedSessionState;
  refineTerminalTurnEndpoint(request: {
    conversation: Conversation;
    statePath: string;
    terminalControl: TerminalControlRef;
  }): Conversation;
  required<Value>(
    value: Value | null | undefined,
    message: string
  ): Value;
  resolveCurrentNativeAgentSessionIdentity(
    request: NativeIdentityResolutionRequest & {
      options: TerminalCommandCliOptions;
    }
  ): Promise<NativeAgentSessionIdentity | undefined>;
  resolveTerminalDispatchLedgerPaneIncarnation(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchRecord
  ): TerminalDispatchLedgerDocument | undefined;
  resolveTerminalConversationFromOptions(
    options: TerminalCommandCliOptions
  ): Promise<TerminalCommandTarget | undefined>;
  stallOtherTerminalBridgeConversationsForUncertainDispatch(request: {
    storeDir: string;
    terminalControl: TerminalControlRef;
    currentConversationId: string;
    uncertainMessageId: string;
  }): string[];
  startTerminalBridgeMonitorForConversation(request: {
    conversation: Conversation;
    statePath: string;
    logPath: string;
    options: TerminalCommandCliOptions;
  }): TerminalMonitorProcess | undefined;
  storeDirFromOptions(options: TerminalCommandCliOptions): string;
  soleBoundManagedSessionClaimForTerminal(
    storeDir: string,
    terminal: TerminalCommandTarget
  ): ManagedSessionState | undefined;
  terminalBindingLedgerFields(
    conversation: Conversation
  ): TerminalDispatchRecord;
  terminalBridgeEnabled(conversation: Conversation): boolean;
  terminalBridgeRequestFingerprint(text: string): string | undefined;
  terminalBridgeRuntimeKey(terminalControl: TerminalControlRef): string;
  terminalControlFromTakeover(value: unknown): TerminalControlRef | undefined;
  terminalDispatchCapabilityRepositories(request: {
    previousLedger: TerminalDispatchLedgerDocument | undefined;
    preparedMessageEvent(): EventRecord;
    restoreDeferred(
      route: BoundTerminalDispatchRoute,
      terminalInputNotStartedAt?: string
    ): boolean;
    rollbackBeforeInput(route: BoundTerminalDispatchRoute): boolean;
  }): TerminalDispatchCapabilityRepositories;
  terminalDispatchExecution(
    options: TerminalCommandCliOptions,
    bridge?: TerminalAgentBridge
  ): TerminalDispatchExecutionService;
  terminalDispatchRecordMatchesControl(
    record: TerminalDispatchRecord | undefined,
    terminalControl: TerminalControlRef,
    options?: {
      requireCurrentRoute?: boolean;
      requireProcessAnchor?: boolean;
    }
  ): boolean;
  terminalDurableRequestForConversation(
    conversation: Conversation,
    terminalControl: TerminalControlRef
  ): TerminalDurableCompletionRequest;
  terminalList: {
    assertTerminalIncarnationCanStartTurn(
      storeDir: string,
      terminalControl: TerminalControlRef
    ): void;
    resolveTerminalScopedCodexApproval(request: {
      options: TerminalCommandCliOptions;
      terminal: TerminalCommandTarget;
      approvalSnapshot?: TerminalScopedCodexApprovalPromptSnapshot;
    }): Promise<TerminalScopedApprovalResolution>;
  };
  terminalRuntimeForLiveIdentity(request: {
    terminal: TerminalCommandTarget;
    identity?: NativeAgentSessionIdentity;
    expectedEmptyNativeSession?: boolean;
    physicalOnly?: boolean;
  }): TerminalRuntimeIdentity;
  terminalRuntimeIdentityForConversation(
    conversation: Conversation,
    terminalControl: TerminalControlRef
  ): TerminalRuntimeIdentity;
  terminalWriterMutationLocks(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): CanonicalMutationLockPorts;
  textSummary(
    text: unknown,
    maxLength?: number
  ): { length: number; preview?: string };
  verifyCodexPendingManagedSendStatus(request: {
    options: TerminalCommandCliOptions;
    terminal: TerminalCommandTarget;
    session: ManagedSessionState;
    logicalIdentity?: NativeAgentSessionIdentity;
    allowedPreMaterializationIdentity?: CodexPreMaterializationIdentity;
    allowedAdditionalIdentities?: CodexPreMaterializationIdentity[];
  }): Promise<void>;
  withTerminalBridgeSubmission(
    mutation: TerminalBridgeSubmissionMutation
  ): Conversation;
  withTerminalDispatchStateScope<Result>(
    scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources,
    statePath: string,
    logPath: string,
    operation: (
      scopes: CanonicalStateMutationScopes,
      resources: CanonicalStateMutationResources
    ) => Promise<Result>
  ): Promise<Result>;
}

export interface TerminalCommandCliDependencies {
  ports: TerminalCommandCliRawPorts;
  policy: {
    terminalDispatchReleaseStatuses: ReadonlySet<ConversationStatus>;
  };
}

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
  [Name in keyof TerminalCommandCliRawPorts]:
    TerminalCommandCliRawPorts[Name] extends (...arguments_: never[]) => unknown
      ? Name
      : never;
}[keyof TerminalCommandCliRawPorts];

function rawPort<Name extends TerminalCommandFunctionPortName>(
  name: Name
): TerminalCommandCliRawPorts[Name] {
  return ((...arguments_: unknown[]) => {
    const operation = terminalCommandRuntime().ports[name];
    if (typeof operation !== "function") {
      throw new Error(`Terminal command port ${String(name)} is unavailable`);
    }
    return (operation as (...values: unknown[]) => unknown)(...arguments_);
  }) as unknown as TerminalCommandCliRawPorts[Name];
}

const acquireFileLock = rawPort("acquireFileLock");
const acquireTerminalBridgeSendLock = rawPort("acquireTerminalBridgeSendLock");
const assertCodexComposerReadyForAutomatedInput =
  rawPort("assertCodexComposerReadyForAutomatedInput");
const assertDeferredCodexForegroundBindingBoundary =
  rawPort("assertDeferredCodexForegroundBindingBoundary");
const assertExpectedHandoffTokenUsesExactTerminalSelector =
  rawPort("assertExpectedHandoffTokenUsesExactTerminalSelector");
const assertManagedSessionCanStartTurn =
  rawPort("assertManagedSessionCanStartTurn");
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
const bindingMatchesLiveTerminal = rawPort("bindingMatchesLiveTerminal");
const codexAllowedCompanionSetForManagedSession =
  rawPort("codexAllowedCompanionSetForManagedSession");
const codexPreMaterializationIdentityForManagedSession =
  rawPort("codexPreMaterializationIdentityForManagedSession");
const createBoundManagedSession = rawPort("createBoundManagedSession");
const createManagedTerminalTurn = rawPort("createManagedTerminalTurn");
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
const inspectCodexOpenRootRolloutInventory =
  rawPort("inspectCodexOpenRootRolloutInventory");
const isDiscoverableTmuxConversation =
  rawPort("isDiscoverableTmuxConversation");
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
const managedTurnsForSession = rawPort("managedTurnsForSession");
const materializeCurrentManagedSession =
  rawPort("materializeCurrentManagedSession");
const maybeAdoptObservedExternalThread = rawPort("maybeAdoptObservedExternalThread");
const maybeDetachVerifiedEmptyCodexSource =
  rawPort("maybeDetachVerifiedEmptyCodexSource");
const migrateLegacyTerminalAgentIdentity =
  rawPort("migrateLegacyTerminalAgentIdentity");
const openClawYieldNextAction = rawPort("openClawYieldNextAction");
const observeCurrentNativeAgentSessionIdentity =
  rawPort("observeCurrentNativeAgentSessionIdentity");
const parseJsonOption = rawPort("parseJsonOption");
const persistManagedSessionNativeIdentity =
  rawPort("persistManagedSessionNativeIdentity");
const positiveMinutes = rawPort("positiveMinutes");
const prepareDeferredCodexForegroundBinding =
  rawPort("prepareDeferredCodexForegroundBinding");
const quarantineManagedSessionBinding = rawPort("quarantineManagedSessionBinding");
const reattachManagedSessionForNativeIdentity =
  rawPort("reattachManagedSessionForNativeIdentity");
const reconcilePreparedTerminalDispatchLedger =
  rawPort("reconcilePreparedTerminalDispatchLedger");
const refineManagedSessionNativeIdentity =
  rawPort("refineManagedSessionNativeIdentity");
const refineTerminalTurnEndpoint = rawPort("refineTerminalTurnEndpoint");
const required = rawPort("required");
const resolveCurrentNativeAgentSessionIdentity =
  rawPort("resolveCurrentNativeAgentSessionIdentity");
const resolveTerminalDispatchLedgerPaneIncarnation =
  rawPort("resolveTerminalDispatchLedgerPaneIncarnation");
const resolveTerminalConversationFromOptions =
  rawPort("resolveTerminalConversationFromOptions");
const stallOtherTerminalBridgeConversationsForUncertainDispatch =
  rawPort("stallOtherTerminalBridgeConversationsForUncertainDispatch");
const startTerminalBridgeMonitorForConversation =
  rawPort("startTerminalBridgeMonitorForConversation");
const storeDirFromOptions = rawPort("storeDirFromOptions");
const soleBoundManagedSessionClaimForTerminal =
  rawPort("soleBoundManagedSessionClaimForTerminal");
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
const verifyCodexPendingManagedSendStatus =
  rawPort("verifyCodexPendingManagedSendStatus");
const withTerminalBridgeSubmission = rawPort("withTerminalBridgeSubmission");
const withTerminalDispatchStateScope = rawPort("withTerminalDispatchStateScope");

const mutationDispatchLedger = new Proxy({}, {
  get: (_target, property) =>
    terminalCommandRuntime().ports.mutationDispatchLedger[
      property as keyof TerminalCommandCliRawPorts["mutationDispatchLedger"]
    ]
}) as TerminalCommandCliRawPorts["mutationDispatchLedger"];

const terminalListCliFacade = new Proxy({}, {
  get: (_target, property) =>
    terminalCommandRuntime().ports.terminalList[
      property as keyof TerminalCommandCliRawPorts["terminalList"]
    ]
}) as TerminalCommandCliRawPorts["terminalList"];

const TERMINAL_DISPATCH_RELEASE_STATUSES = {
  has: (status: ConversationStatus) =>
    terminalCommandRuntime().policy.terminalDispatchReleaseStatuses.has(status)
};

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
    TERMINAL_DISPATCH_RELEASE_STATUSES.has(owner.status) ||
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
  expectedStatePath
}: {
  options: Record<string, any>;
  terminalControl: TerminalControlRef;
  requestText: string;
  expectedStoreDir: string;
  expectedSessionId?: string;
  expectedTurnId?: string;
  expectedMessageType?: "task" | "answer";
  expectedStatePath?: string;
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
      "Store, Session, Turn, OpenClaw session, message, or terminal binding; " +
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
    expectedStatePath
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
      "no terminal input was sent"
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
  printJson({
    session_id: sessionIdForConversation(owner),
    turn_id: turnIdForConversation(owner),
    conversation: owner,
    message: replayedMessage,
    delivered: replayReceipt.delivered,
    status: replayReceipt.status,
    submission_outcome: replayReceipt.submission_outcome,
    background: true,
    callback_expected: !acceptanceInvalid && Boolean(
      owner.gateway_method ?? ledger.callback_expected
    ),
    terminal_control: terminalControl,
    executor,
    replayed: replayReceipt.replayed,
    delivery_receipt: replayReceipt.delivery_receipt,
    ...(replayReceipt.do_not_retry
      ? { do_not_retry: replayReceipt.do_not_retry }
      : {}),
    reason: replayReceipt.delivered
      ? "AKK replayed the durable native acceptance receipt and sent no additional terminal input."
      : acceptanceInvalid
        ? "AKK replayed an invalid native acceptance receipt as uncertain and sent no additional terminal input."
        : "AKK replayed the original transport proof without upgrading it and sent no additional terminal input.",
    openclaw_next_action: replayReceipt.delivered
      ? openClawYieldNextAction({
          conversationId: owner.conversation_id,
          sessionId: sessionIdForConversation(owner),
          turnId: turnIdForConversation(owner),
          source: "terminal_control",
          callbackExpected: Boolean(owner.gateway_method ?? ledger.callback_expected)
        })
      : {
          action: "inspect",
          conversation_id: owner.conversation_id,
          session_id: sessionIdForConversation(owner),
          turn_id: turnIdForConversation(owner),
          do_not_retry: true,
          reason: acceptanceInvalid
            ? "Stored native acceptance evidence is invalid."
            : "Only terminal transport is proven."
        }
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
      "Store, Session, Turn, OpenClaw session, or terminal binding; no terminal input was sent"
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
  expectedStatePath
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
    !TERMINAL_DISPATCH_RELEASE_STATUSES.has(owner.status)
  ) {
    return false;
  }
  if (!["submitted", "enter_dispatched", "agent_accepted"].includes(
    String(receipt.status)
  )) {
    throw new Error(
      `terminal idempotency key ${messageId} has durable ${String(receipt.status)} ` +
      "proof and must not be retried; no terminal input was sent"
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
  const callbackExpected = Boolean(owner.gateway_method);
  printJson({
    session_id: sessionIdForConversation(owner),
    turn_id: turnIdForConversation(owner),
    conversation: owner,
    message: replayedMessage,
    delivered: replayReceipt.delivered,
    status: replayReceipt.status,
    submission_outcome: replayReceipt.submission_outcome,
    background: true,
    callback_expected: !acceptanceInvalid && callbackExpected,
    terminal_control: terminalControl,
    executor,
    replayed: true,
    delivery_receipt: replayReceipt.delivery_receipt,
    ...(replayReceipt.do_not_retry
      ? { do_not_retry: replayReceipt.do_not_retry }
      : {}),
    reason: replayReceipt.delivered
      ? "AKK replayed the stored durable native acceptance receipt and sent no additional terminal input."
      : acceptanceInvalid
        ? "AKK replayed an invalid stored native acceptance receipt as uncertain and sent no additional terminal input."
        : "AKK replayed the stored transport proof without upgrading it and sent no additional terminal input.",
    openclaw_next_action: replayReceipt.delivered
      ? openClawYieldNextAction({
          conversationId: owner.conversation_id,
          sessionId: sessionIdForConversation(owner),
          turnId: turnIdForConversation(owner),
          source: "terminal_control",
          callbackExpected
        })
      : {
          action: "inspect",
          conversation_id: owner.conversation_id,
          session_id: sessionIdForConversation(owner),
          turn_id: turnIdForConversation(owner),
          do_not_retry: true,
          reason: acceptanceInvalid
            ? "Stored native acceptance evidence is invalid."
            : "Only terminal transport is proven."
        }
  });
  return true;
}

const terminalBridgeSubmission = dispatchReceipt.terminalBridgeSubmission;
const terminalBridgeSubmissionReceipts =
  dispatchReceipt.terminalBridgeSubmissionReceipts;
const unresolvedTerminalBridgeSubmission =
  dispatchReceipt.unresolvedTerminalBridgeSubmission;

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
      TERMINAL_DISPATCH_RELEASE_STATUSES.has(
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

async function runSend(options) {
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
  return runManagedSessionSend(options, messageBody);
}

interface RawTerminalInitialAuthority {
  claimedSession?: ManagedSessionState;
  suppliedExpectedTerminalToken?: string;
  implicitCodexCandidateAuthority: boolean;
  knownCodexCompanions: CodexAllowedCompanionSet;
}

function rawTerminalInitialAuthority({
  options,
  terminal,
  storeDir
}: {
  options: Record<string, any>;
  terminal: TerminalCommandTarget;
  storeDir: string;
}): RawTerminalInitialAuthority {
  const claimedSession = soleBoundManagedSessionClaimForTerminal(
    storeDir,
    terminal
  );
  const suppliedExpectedTerminalToken = stringValue(
    options.expectedTerminalToken
  );
  const implicitCodexCandidateAuthority = Boolean(
    terminal.agent === "codex" &&
    suppliedExpectedTerminalToken === undefined &&
    claimedSession?.status === "bound" &&
    isCompleteNativeRollout(
      claimedSession.binding?.native_process.rollout
    )
  );
  const knownCodexCompanions = claimedSession
    ? codexAllowedCompanionSetForManagedSession({
        storeDir,
        session: claimedSession
      })
    : { additional: [] };
  return {
    claimedSession,
    suppliedExpectedTerminalToken,
    implicitCodexCandidateAuthority,
    knownCodexCompanions
  };
}

function assertRawTerminalCandidateAuthority({
  terminal,
  nativeIdentityObservation,
  deferredCodexCandidateInventory,
  implicitCodexCandidateAuthority
}: {
  terminal: TerminalCommandTarget;
  nativeIdentityObservation: NativeAgentSessionIdentityObservation;
  deferredCodexCandidateInventory?: CodexOpenRootRolloutInventory;
  implicitCodexCandidateAuthority: boolean;
}): void {
  if (
    implicitCodexCandidateAuthority &&
    !deferredCodexCandidateInventory
  ) {
    throw new Error(
      "rollout-backed Codex terminal send requires a fresh complete " +
      "nonempty open-root inventory; refresh AKK list before sending"
    );
  }
  if (
    nativeIdentityObservation.status === "unavailable" &&
    !deferredCodexCandidateInventory
  ) {
    throw new Error(
      `native ${terminal.agent} identity observation is ` +
      `unavailable: ${nativeIdentityObservation.reason}`
    );
  }
}

async function runRawTerminalSend(
  options: Record<string, any>,
  messageBody: string,
  terminalConversation: TerminalCommandTarget
): Promise<void> {
  // A token copied from list is authority for exactly the advertised full
  // terminal selector. Reject aliases and implicit/no-selector resolution
  // before taking locks or touching Store state.
  assertExpectedHandoffTokenUsesExactTerminalSelector({
    options,
    terminal: terminalConversation
  });
  if (!options.background) {
    throw new Error(
      "raw terminal sends require --background so AKK can persist and monitor the submission safely"
    );
  }
  const rawStoreDir = storeDirFromOptions(options);
  await withCanonicalMutationLocks(terminalWriterMutationLocks(
    rawStoreDir, terminalConversation.terminalControl
  ), async (scopes, resources) => {
    await mutationDispatchLedger.beforeMutation(
      scopes, resources, options, terminalConversation
    );
    // Upgrade legacy Stores before resolving their Session authority. The
    // protocol migration, rather than mutable Turn recency, is the only code
    // allowed to materialize Session records from existing Turns.
    ensureStoreWritable(rawStoreDir);
    if (replayExactActiveTerminalSubmission({
      options,
      terminalControl: terminalConversation.terminalControl,
      requestText: String(messageBody),
      expectedStoreDir: rawStoreDir,
      expectedMessageType: "task"
    })) {
      return;
    }
    terminalListCliFacade.assertTerminalIncarnationCanStartTurn(
      rawStoreDir,
      terminalConversation.terminalControl
    );
    const initialAuthority = rawTerminalInitialAuthority({
      options,
      terminal: terminalConversation,
      storeDir: rawStoreDir
    });
    let {
      claimedSession,
      knownCodexCompanions
    } = initialAuthority;
    const {
      suppliedExpectedTerminalToken,
      implicitCodexCandidateAuthority
    } = initialAuthority;
    const nativeIdentityObservation =
      await observeCurrentNativeAgentSessionIdentity({
        options,
        agent: terminalConversation.agent,
        pid: terminalConversation.pid,
        cwd: terminalConversation.terminalControl.currentPath,
        preferredSessionId: knownCodexCompanions.primary
          ? claimedSession?.binding?.native_thread_id
          : undefined,
        allowedCompanionIdentity: knownCodexCompanions.primary,
        allowedAdditionalIdentities: knownCodexCompanions.additional
      });
    let deferredCodexCandidateInventory:
      | CodexOpenRootRolloutInventory
      | undefined;
    if (
      terminalConversation.agent === "codex" &&
      (suppliedExpectedTerminalToken || implicitCodexCandidateAuthority)
    ) {
      try {
        const inventory = await inspectCodexOpenRootRolloutInventory({
          options,
          pid: terminalConversation.pid,
          cwd: terminalConversation.terminalControl.currentPath
        });
        if (inventory.roots.length > 0) {
          deferredCodexCandidateInventory = inventory;
        }
      } catch (error) {
        if (
          implicitCodexCandidateAuthority ||
          nativeIdentityObservation.status === "unavailable"
        ) {
          throw new Error(
            `native Codex foreground attribution requires a fresh complete ` +
            `open-root inventory: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
    assertRawTerminalCandidateAuthority({
      terminal: terminalConversation,
      nativeIdentityObservation,
      deferredCodexCandidateInventory,
      implicitCodexCandidateAuthority
    });
    let currentNativeIdentity =
      nativeIdentityObservation.status === "resolved"
        ? nativeIdentityObservation.identity
        : undefined;
    // A fresh nonempty inventory is the stronger physical authority for an
    // implicit candidate send. Do not let an earlier verified-absent
    // observation divert this path into the token-only empty handoff.
    const verifiedEmptyHandoff = implicitCodexCandidateAuthority
      ? undefined
      : await maybeDetachVerifiedEmptyCodexSource({
          options,
          terminal: terminalConversation,
          sourceSession: claimedSession,
          observation: nativeIdentityObservation
        });
    if (verifiedEmptyHandoff) {
      // The old rollout is conclusively closed.  Never carry it forward as
      // a pre-materialization companion for the new virgin Session.
      claimedSession = undefined;
      knownCodexCompanions = { additional: [] };
      currentNativeIdentity = undefined;
    }
    const physicalNativeIdentityBeforeHandoff = currentNativeIdentity;
    let handoff = await maybeAdoptObservedExternalThread({
      options,
      terminal: terminalConversation,
      // A no-token raw send to an already managed rollout-backed Codex pane
      // is an internal follow-current delegation, never a sole-root strict
      // continuation or an external-handoff adoption. The dedicated v3
      // transfer below owns attribution and lineage.
      sourceSession: implicitCodexCandidateAuthority
        ? undefined
        : claimedSession,
      resolvedIdentity: currentNativeIdentity,
      storeDir: rawStoreDir
    });
    currentNativeIdentity =
      handoff.adopted &&
        terminalConversation.agent === "codex" &&
        !handoff.session?.binding?.native_process.rollout
        ? physicalNativeIdentityBeforeHandoff
        : handoff.identity;
    const deferredCodexForegroundBinding = !handoff.adopted
        ? await prepareDeferredCodexForegroundBinding({
            options,
            scope: bindDeferredForegroundWriterScope(scopes, resources),
            terminal: terminalConversation,
            sourceSession: claimedSession,
            observation: nativeIdentityObservation,
            candidateInventory: deferredCodexCandidateInventory,
            requestText: String(messageBody),
            allowImplicitFreshAuthority:
              implicitCodexCandidateAuthority
          })
      : undefined;
    const freshSendAuthority = decideTerminalSendAuthority({
      ownership: "conflict",
      verifiedEmpty: Boolean(verifiedEmptyHandoff),
      externalHandoff: handoff.adopted,
      deferred: Boolean(deferredCodexForegroundBinding)
    });
    if (
      freshSendAuthority.mode === "deferred" &&
      deferredCodexForegroundBinding
    ) {
      claimedSession = undefined;
      knownCodexCompanions = { additional: [] };
      currentNativeIdentity = undefined;
      handoff = { identity: undefined, adopted: false };
    } else if (
      (suppliedExpectedTerminalToken || implicitCodexCandidateAuthority) &&
      freshSendAuthority.mode === "conflict"
    ) {
      throw new Error(
        "the expected terminal token no longer authorizes the current " +
        "terminal context; refresh AKK list"
      );
    }
    let managedSession = deferredCodexForegroundBinding
      ? undefined
      : handoff.session ??
        materializeCurrentManagedSession({
          options,
          terminal: terminalConversation,
          identity: currentNativeIdentity
        });
    if (!managedSession && currentNativeIdentity) {
      managedSession = await reattachManagedSessionForNativeIdentity({
        options,
        terminal: terminalConversation,
        identity: currentNativeIdentity,
        storeDir: rawStoreDir
      });
    }
    let pendingRawAttachSessionCreate: ManagedSessionState | undefined;
    if (!managedSession) {
      if (currentNativeIdentity) {
        await assertNativeThreadHasExclusiveOwnership({
          options,
          agent: terminalConversation.agent,
          currentPid: terminalConversation.pid,
          nativeThreadId: currentNativeIdentity.sessionId,
          storeDir: rawStoreDir,
          terminalControl: terminalConversation.terminalControl
        });
      }
      managedSession = createBoundManagedSession({
        sessionId:
          deferredCodexForegroundBinding?.targetSessionId ??
          createManagedSessionId(),
        terminal: terminalConversation,
        identity: currentNativeIdentity,
        lineage: deferredCodexForegroundBinding
          ? {
              created_by: "attach",
              previous_session_id:
                deferredCodexForegroundBinding.sourceSessionId,
              transition_id: deferredCodexForegroundBinding.transferId
            }
          : { created_by: "attach" }
      });
      if (
        terminalConversation.agent === "codex" &&
        !currentNativeIdentity
      ) {
        if (deferredCodexForegroundBinding) {
          managedSession = {
            ...managedSession,
            // Both endpoints stay fenced from older writers until the
            // dedicated transfer reaches its resolved receipt.
            status: "transitioning",
            last_transition_id: deferredCodexForegroundBinding.transferId
          };
        }
        pendingRawAttachSessionCreate = managedSession;
      } else {
        managedSession = saveManagedSession(
          rawStoreDir,
          managedSession,
          { expectedRevision: null }
        );
      }
    }
    const logicalNativeIdentity = logicalIdentityForManagedSession({
      storeDir: rawStoreDir,
      session: managedSession,
      observedIdentity: currentNativeIdentity
    });
    const allowedPreMaterializationIdentity =
      codexPreMaterializationIdentityForManagedSession({
        storeDir: rawStoreDir,
        session: managedSession,
        observedIdentity: currentNativeIdentity
      }) ?? (
        currentNativeIdentity === undefined ||
        nativeIdentityMatchesCodexPreMaterialization(
          currentNativeIdentity,
          knownCodexCompanions.primary
        )
          ? knownCodexCompanions.primary
          : undefined
      );
    const allowedAdditionalIdentities =
      allowedPreMaterializationIdentity
        ? knownCodexCompanions.additional
        : [];
    const materializedNativeIdentity =
      currentNativeIdentity?.sessionId === logicalNativeIdentity?.sessionId
        ? currentNativeIdentity
        : undefined;
    if (!(
      handoff.adopted &&
      terminalConversation.agent === "codex" &&
      !managedSession.binding?.native_process.rollout
    )) {
      await verifyCodexPendingManagedSendStatus({
        options,
        terminal: terminalConversation,
        session: managedSession,
        logicalIdentity: logicalNativeIdentity,
        allowedPreMaterializationIdentity,
        allowedAdditionalIdentities
      });
    }
    const managedNativeThreadId =
      logicalNativeIdentity?.sessionId ??
      managedSession.binding?.native_thread_id;
    if (managedNativeThreadId) {
      await assertNativeThreadHasExclusiveOwnership({
        options,
        agent: terminalConversation.agent,
        currentPid: terminalConversation.pid,
        nativeThreadId: managedNativeThreadId,
        storeDir: rawStoreDir,
        terminalControl: terminalConversation.terminalControl,
        excludedManagedSessionId: managedSession.session_id
      });
    }
    managedSession = refineManagedSessionNativeIdentity({
      storeDir: rawStoreDir,
      session: managedSession,
      terminalControl: terminalConversation.terminalControl,
      identity: logicalNativeIdentity
    });
    const sessionTurns = managedTurnsForSession(
      rawStoreDir,
      managedSession.session_id
    );
    const reusableTurn = sessionTurns[0];
    assertManagedSessionCanStartTurn(
      sessionTurns
    );
    const managed = createManagedTerminalTurn({
      options,
      conversationId: terminalConversation.conversationId,
      agent: terminalConversation.agent,
      pid: terminalConversation.pid,
      messageBody,
      terminalControl: terminalConversation.terminalControl,
      previousTurn: reusableTurn,
      managedSession,
      nativeAgentIdentity: materializedNativeIdentity,
      deferredForegroundTransferId:
        deferredCodexForegroundBinding?.transferId
    });
    ensureStoreWritable(managed.conversation.store_dir);
    ensureDir(path.dirname(managed.statePath));
    await withTerminalDispatchStateScope(
      scopes,
      resources,
      managed.statePath,
      managed.logPath,
      async (dispatchScopes, dispatchResources) => {
      await runTerminalControlSend({
        transaction: {
          scopes: dispatchScopes,
          resources: dispatchResources
        },
        options,
        conversation: managed.conversation,
        nextConversation: managed.nextConversation,
        executor: managed.executor,
        message: managed.message,
        recordMessageAfterSend: true,
        recordRawAttachmentAfterSend: reusableTurn === undefined,
        onTerminalPreflightVerified: pendingRawAttachSessionCreate
            ? async (route) => {
              const exactRoute = withExactTerminalDispatchRoute(route, {
                terminalControl: terminalConversation.terminalControl,
                terminalKey: terminalBridgeRuntimeKey(
                  terminalConversation.terminalControl
                ),
                storeDir: rawStoreDir,
                statePath: managed.statePath,
                logPath: managed.logPath
              }, (boundRoute) => boundRoute);
              let createdSession: ManagedSessionState;
              if (deferredCodexForegroundBinding) {
                const deferredScope =
                  bindDeferredForegroundApplicationScope(
                    dispatchScopes,
                    dispatchResources
                );
                const reserved =
                  await deferredForegroundApplication(
                    options,
                    deferredCodexForegroundBinding.terminal
                  ).reserve({
                    scope: deferredScope,
                    boundary: deferredForegroundBoundaryProjection(
                      deferredCodexForegroundBinding
                    ),
                    targetSession:
                      pendingRawAttachSessionCreate as ManagedSessionState,
                    messageId: managed.message.id,
                    turnId: turnIdForConversation(managed.conversation)
                  });
                createdSession = reserved.createdSession;
                managedSession = createdSession;
                pendingRawAttachSessionCreate = undefined;
                return (rollbackRoute) => {
                  assertTerminalDispatchRouteMatches(
                    rollbackRoute,
                    exactRoute
                  );
                  reserved.rollback(deferredScope);
                };
              }
              createdSession = saveManagedSession(exactRoute.storeDir,
                pendingRawAttachSessionCreate as ManagedSessionState, {
                  expectedRevision: null
                });
              managedSession = createdSession;
              pendingRawAttachSessionCreate = undefined;
              return (rollbackRoute) => {
                assertTerminalDispatchRouteMatches(rollbackRoute, route);
                const current = loadManagedSession(
                  rollbackRoute.storeDir,
                  createdSession.session_id
                );
                if (
                  current.status !== "bound" ||
                  current.revision !== createdSession.revision ||
                  managedSessionBindingToken(current) !==
                    managedSessionBindingToken(createdSession)
                ) {
                  throw new Error(
                    `new raw-attach Session ${createdSession.session_id} changed before pre-transport rollback`
                  );
                }
                const detachedAt = cliNow().toISOString();
                managedSession = saveManagedSession(rollbackRoute.storeDir, {
                  ...current,
                  status: "detached",
                  detached_at: detachedAt,
                  updated_at: detachedAt
                }, {
                  expectedRevision: current.revision as number
                });
              };
            }
          : undefined,
        allowedPreMaterializationIdentity,
        allowedAdditionalIdentities,
        observedHandoff:
          handoff.adopted && handoff.transition
            ? {
                terminal: terminalConversation,
                transition: handoff.transition
              }
            : undefined,
        verifiedEmptyCodexHandoff: verifiedEmptyHandoff?.boundary,
        deferredCodexForegroundBinding
      });
      }
    );
  });
  return;
}

async function runManagedSessionSend(
  options: Record<string, any>,
  messageBody: string
): Promise<void> {
  if (stringValue(options.expectedTerminalToken)) {
    throw new Error(
      "--expected-terminal-token cannot be used with a managed Session; " +
      "use the exact full terminal selector advertised by AKK list"
    );
  }

  const sessionId = required(
    stringValue(options.session ?? options.conversation ?? options.conversationId),
    "--session is required for an ordinary managed send"
  );
  const storeDir = storeDirFromOptions(options);
  // Read only enough legacy/Session authority to identify the physical
  // terminal. Store migration is deliberately deferred until the terminal
  // lock has reconciled any lifecycle fence.
  let initialSession = tryLoadManagedSession(storeDir, sessionId);
  let initialTurns = managedTurnsForSession(storeDir, sessionId);
  if (!initialSession) {
    const exactTurn = listConversations(storeDir)
      .filter(isDiscoverableTmuxConversation)
      .find((turn) =>
        turnIdForConversation(turn) === sessionId ||
        turn.conversation_id === sessionId
      );
    if (exactTurn && sessionIdForConversation(exactTurn) !== sessionId) {
      throw new Error(
        `turn ${sessionId} is an execution identity, not an ordinary send target; ` +
        `send to session ${sessionIdForConversation(exactTurn)} instead`
      );
    }
    if (initialTurns.length === 0) {
      throw new Error(`managed session ${sessionId} was not found`);
    }
  }
  const legacyBindingTurn = initialTurns[0];
  const legacyTakeover = legacyBindingTurn && isRecord(
    legacyBindingTurn.native_session_takeover
  )
    ? legacyBindingTurn.native_session_takeover
    : undefined;
  const rawTerminalId = initialSession?.binding?.terminal_id ??
    stringValue(legacyTakeover?.native_session_id);
  if (!rawTerminalId) {
    throw new Error(
      `managed Session ${sessionId} has no authoritative terminal binding`
    );
  }
  const storedTerminalControl = initialSession?.binding?.terminal_control ??
    terminalControlFromTakeover(legacyTakeover);
  const storedAgent = initialSession?.agent ??
    (legacyBindingTurn
      ? executorForConversation(legacyBindingTurn).kind
      : undefined);
  const storedPid = initialSession?.binding?.native_process.pid ??
    Number(legacyTakeover?.terminal_agent_pid);
  const terminalBridge = createTerminalAgentBridge(options);
  const resolvedTerminal = storedTerminalControl && storedAgent &&
    Number.isSafeInteger(storedPid) && storedPid > 1
    ? await terminalBridge.resolveStoredTerminal(
        storedAgent,
        storedPid,
        storedTerminalControl,
        { pid: storedPid }
      )
    : await terminalBridge.resolveConversationId(rawTerminalId);
  if (!resolvedTerminal) {
    throw new Error(
      `session ${sessionId} is not attached to a live terminal`
    );
  }
  await withCanonicalMutationLocks(terminalWriterMutationLocks(
    storeDir, resolvedTerminal.terminalControl
  ), async (scopes, resources) => {
    const lockedStrictSession = tryLoadManagedSession(storeDir, sessionId);
    if (
      lockedStrictSession?.agent === "codex" &&
      lockedStrictSession.session_id === sessionId &&
      lockedStrictSession.status === "bound" &&
      isCompleteNativeRollout(
        lockedStrictSession.binding?.native_process.rollout
      )
    ) {
      throw new Error(
        `Codex rollout-backed managed Session ${sessionId} cannot use a ` +
        "strict session_id send because an open rollout does not prove the " +
        "current TUI foreground thread. Refresh AKK list and use its exact " +
        "selector plus expected_terminal_token. No Turn was created and no " +
        "terminal input was sent."
      );
    }
    await mutationDispatchLedger.beforeMutation(
      scopes, resources, options, resolvedTerminal
    );
    // A protocol-1/2 Store materializes authoritative Session records as one
    // atomic migration. Once protocol 3 is active, a missing Session is corrupt
    // state and must not be reconstructed from whichever Turn looks newest.
    ensureStoreWritable(storeDir);
    if (replayExactActiveTerminalSubmission({
      options,
      terminalControl: resolvedTerminal.terminalControl,
      requestText: String(messageBody),
      expectedStoreDir: storeDir,
      expectedSessionId: sessionId,
      expectedMessageType: "task"
    })) {
      return;
    }
    terminalListCliFacade.assertTerminalIncarnationCanStartTurn(
      storeDir,
      resolvedTerminal.terminalControl
    );
    let currentSession = tryLoadManagedSession(storeDir, sessionId);
    let knownCodexCompanions: CodexAllowedCompanionSet = currentSession
      ? codexAllowedCompanionSetForManagedSession({
          storeDir,
          session: currentSession
        })
      : { additional: [] };
    if (
      currentSession?.agent === "codex" &&
      knownCodexCompanions.primary
    ) {
      try {
        const inventory = await inspectCodexOpenRootRolloutInventory({
          options,
          pid: resolvedTerminal.pid,
          cwd: resolvedTerminal.terminalControl.currentPath
        });
        knownCodexCompanions = codexCompanionsPresentInOpenRootInventory(
          knownCodexCompanions,
          inventory
        );
      } catch {
        // Inventory proof is an optimization only. Preserve the existing
        // closed /status fence when exact open-root membership is unavailable.
      }
    }
    const lockedNativeIdentity =
      await resolveCurrentNativeAgentSessionIdentity({
        options,
        agent: resolvedTerminal.agent,
        pid: resolvedTerminal.pid,
        cwd: resolvedTerminal.terminalControl.currentPath,
        preferredSessionId: knownCodexCompanions.primary
          ? currentSession?.binding?.native_thread_id
          : undefined,
        allowedCompanionIdentity: knownCodexCompanions.primary,
        allowedAdditionalIdentities: knownCodexCompanions.additional
      });
    if (!currentSession) {
      currentSession = materializeCurrentManagedSession({
        options,
        terminal: resolvedTerminal,
        identity: lockedNativeIdentity
      });
    }
    if (
      !currentSession ||
      currentSession.session_id !== sessionId ||
      currentSession.status !== "bound" ||
      !currentSession.binding
    ) {
      throw new Error(
        `managed Session ${sessionId} is no longer bound; refresh list and retry`
      );
    }
    const currentTurns = managedTurnsForSession(storeDir, sessionId);
    assertManagedSessionCanStartTurn(currentTurns);
    if (!bindingMatchesLiveTerminal(
      currentSession,
      resolvedTerminal,
      lockedNativeIdentity,
      storeDir
    )) {
      throw new Error(
        "managed session identity changed while waiting to send; refresh list and retry"
      );
    }
    const logicalLockedNativeIdentity = logicalIdentityForManagedSession({
      storeDir,
      session: currentSession,
      observedIdentity: lockedNativeIdentity
    });
    const allowedPreMaterializationIdentity =
      codexPreMaterializationIdentityForManagedSession({
        storeDir,
        session: currentSession,
        observedIdentity: lockedNativeIdentity
      }) ?? knownCodexCompanions.primary;
    const allowedAdditionalIdentities = knownCodexCompanions.additional;
    const materializedLockedNativeIdentity =
      lockedNativeIdentity?.sessionId === logicalLockedNativeIdentity?.sessionId
        ? lockedNativeIdentity
        : undefined;
    await verifyCodexPendingManagedSendStatus({
      options,
      terminal: resolvedTerminal,
      session: currentSession,
      logicalIdentity: logicalLockedNativeIdentity,
      allowedPreMaterializationIdentity,
      allowedAdditionalIdentities
    });
    const managedNativeThreadId =
      logicalLockedNativeIdentity?.sessionId ??
      currentSession.binding.native_thread_id;
    if (managedNativeThreadId) {
      await assertNativeThreadHasExclusiveOwnership({
        options,
        agent: resolvedTerminal.agent,
        currentPid: resolvedTerminal.pid,
        nativeThreadId: managedNativeThreadId,
        storeDir,
        terminalControl: resolvedTerminal.terminalControl,
        excludedManagedSessionId: currentSession.session_id
      });
    }
    currentSession = refineManagedSessionNativeIdentity({
      storeDir,
      session: currentSession,
      terminalControl: resolvedTerminal.terminalControl,
      identity: logicalLockedNativeIdentity
    });
    const managed = createManagedTerminalTurn({
      options,
      conversationId: resolvedTerminal.conversationId,
      agent: resolvedTerminal.agent,
      pid: resolvedTerminal.pid,
      messageBody,
      terminalControl: resolvedTerminal.terminalControl,
      previousTurn: currentTurns[0],
      managedSession: currentSession,
      nativeAgentIdentity: materializedLockedNativeIdentity
    });
    ensureStoreWritable(managed.conversation.store_dir);
    ensureDir(path.dirname(managed.statePath));
    await withTerminalDispatchStateScope(
      scopes,
      resources,
      managed.statePath,
      managed.logPath,
      async (dispatchScopes, dispatchResources) => {
      await runTerminalControlSend({
        transaction: {
          scopes: dispatchScopes,
          resources: dispatchResources
        },
        options,
        conversation: managed.conversation,
        nextConversation: managed.nextConversation,
        executor: managed.executor,
        message: managed.message,
        recordMessageAfterSend: true,
        allowedPreMaterializationIdentity,
        allowedAdditionalIdentities
      });
      }
    );
  });
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
      "different OpenClaw session; no terminal input was sent"
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
            "different OpenClaw session; no terminal input was sent"
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
    await runTerminalConversationApprove({
      options,
      terminal: terminalConversation
    });
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
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
  if (!["waiting_for_agent", "waiting_for_openclaw"].includes(conversation.status)) {
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
    stringValue(monitoredApproval?.fingerprint);
  const autoApproved = options.autoApproved === true;
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
      expectedFingerprint !== monitoredApproval?.fingerprint
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
  return runManagedApprovalDispatch({
    options, conversation, statePath, logPath,
    nativeTakeover: nativeTakeover as Record<string, any>,
    terminalControl, executor, monitoredApproval, expectedFingerprint,
    autoApproved, claudeScreenApproval
  });
}

async function runManagedApprovalDispatch({
  options, conversation, statePath, logPath, nativeTakeover,
  terminalControl, executor, monitoredApproval, expectedFingerprint,
  autoApproved, claudeScreenApproval
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
}): Promise<void> {
  const policyRuleId = stringValue(options.policyRuleId);
  const policyFingerprint = stringValue(options.policyFingerprint);
  const autoApprovalPolicy = autoApproved
    ? parseJsonOption(options.autoApprovalPolicyJson, "--auto-approval-policy-json")
    : undefined;
  let executorPolicyDecision;
  const policyCandidateForInspection = ({
    agent,
    currentTerminalControl,
    inspection,
    fingerprint
  }): ApprovalCandidate => {
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
  };
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
    if (
      currentConversation.status !== conversation.status ||
      currentTakeover?.terminal_bridge_message_id !== nativeTakeover?.terminal_bridge_message_id ||
      !currentControl ||
      !terminalControlsShareIncarnation(currentControl, terminalControl) ||
      (
        claudeScreenApproval &&
        currentApproval?.fingerprint !== monitoredApproval?.fingerprint
      )
    ) {
      throw new Error("approval state changed while waiting for terminal control; refresh status and retry");
    }
    assertManagedTerminalDispatchOwner({
      storeDir: writerStoreDir,
      conversation: currentConversation,
      terminalControl: currentControl,
      action: "approve"
    });
    lockedConversation = currentConversation;
    const currentRuntimeIdentity = terminalRuntimeIdentityForConversation(
      currentConversation,
      currentControl
    );
    approval = await createTerminalAgentBridge(options).approve(
      executor.kind,
      currentControl,
      {
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
              const candidate = policyCandidateForInspection({
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
                  candidate: policyCandidateForInspection({
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
                latestApproval?.fingerprint !== fingerprint ||
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
    if (!approval.approved) {
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
      approved: true,
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

async function prepareTerminalControlSend(
  request: TerminalControlSendRequest
) {
  const {
    transaction, options, conversation, nextConversation, executor, message,
    recordRawAttachmentAfterSend = false,
    allowedPreMaterializationIdentity,
    allowedAdditionalIdentities = [],
    verifiedEmptyCodexHandoff,
    deferredCodexForegroundBinding,
    continuingTurnResponse = false
  } = request;
  const bridge = terminalBridgeEnabled(conversation);
  const route = bindTerminalDispatchRoute(
    transaction.scopes,
    transaction.resources
  );
  const {
    terminalControl,
    storeDir: lockedStoreDir,
    statePath,
    logPath
  } = route;
  const terminalBridge = createTerminalAgentBridge(options);
  const execution = terminalDispatchExecution(options, terminalBridge);
  const bridgeStartedAt = cliNow().toISOString();
  const agentTimeoutMinutes = Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES);
  const agentHardTimeoutMinutes = positiveMinutes(
    options.agentHardTimeoutMinutes ?? DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
    "--agent-hard-timeout-minutes"
  );
  const terminalPayload = terminalSubmissionPayload(String(message.body ?? ""));
  const terminalRequestHash = required(
    terminalBridgeRequestFingerprint(terminalPayload),
    "terminal request hash is unavailable"
  );
  const presentationContext = { message, executor, terminalControl };
  const presentationPorts = {
    write: printJson,
    budget: budgetAction,
    nextAction: openClawYieldNextAction,
    summarize: textSummary
  };
  let previousDispatchLedger =
    resolveTerminalDispatchLedgerPaneIncarnation(
      terminalControl,
      loadTerminalBridgeDispatchLedger(terminalControl)
    );
  previousDispatchLedger = reconcilePreparedTerminalDispatchLedger(
    terminalControl, previousDispatchLedger
  );
  const previousDispatchLifecycle =
    terminalDispatchLedgerLooksLifecycle(previousDispatchLedger);
  const previousDispatchOwner = execution.preflightRequiresOwner(
    previousDispatchLedger, previousDispatchLifecycle
  )
    ? loadTerminalDispatchLedgerOwner(previousDispatchLedger!)
    : undefined;
  const dispatchPreflight = execution.evaluatePreflight({
    ledger: previousDispatchLedger,
    owner: previousDispatchOwner,
    conversation,
    requestHash: terminalRequestHash,
    requestText: terminalPayload,
    messageId: message.id,
    terminalTarget: terminalControl.target,
    ledgerLifecycle: previousDispatchLifecycle,
    statePathMatches: Boolean(previousDispatchOwner &&
      sameCanonicalStatePath(previousDispatchLedger!.state_path, statePath)),
    continuingTurnResponse
  });
  if (dispatchPreflight.action === "replay") {
    presentTerminalDispatchReplay(dispatchPreflight, presentationContext,
      presentationPorts);
    return;
  }
  if (bridge) {
    assertNoUnresolvedTerminalBridgeSubmission(
      lockedStoreDir,
      terminalControl,
      conversation.conversation_id,
      terminalPayload
    );
  }
  const sendTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalAgentPid = Number(sendTakeover?.terminal_agent_pid);
  const expectedManagedNativeThreadId = stringValue(
    sendTakeover?.terminal_agent_expected_session_id
  ) ?? stringValue(sendTakeover?.terminal_agent_session_id);
  const currentNativeIdentity = deferredCodexForegroundBinding
      ?.candidateAcceptanceAnchor
    ? undefined
    : await execution.resolveCurrentNativeIdentity({
        agent: executor.kind,
        pid: terminalAgentPid,
        cwd: terminalControl.currentPath,
        preferredSessionId: allowedPreMaterializationIdentity
          ? expectedManagedNativeThreadId
          : undefined,
        allowedCompanionIdentity: allowedPreMaterializationIdentity,
        allowedAdditionalIdentities
      });
  const virginRawAttach = Boolean(
    recordRawAttachmentAfterSend &&
    !stringValue(sendTakeover?.terminal_agent_session_id)
  );
  const pendingManagedNativeBinding = Boolean(
    !stringValue(sendTakeover?.terminal_agent_session_id) &&
    stringValue(sendTakeover?.terminal_agent_expected_session_id)
  );
  const needsPostSendNativeBinding =
    virginRawAttach || pendingManagedNativeBinding;
  if (needsPostSendNativeBinding) {
    if (
      currentNativeIdentity &&
      !nativeIdentityMatchesCodexPreMaterialization(
        currentNativeIdentity,
        allowedPreMaterializationIdentity
      )
    ) {
      throw new Error(
        "native agent session appeared while preparing an unmaterialized terminal binding; refresh list and retry"
      );
    }
  } else {
    execution.assertTurnIdentity({
      conversation,
      currentIdentity: currentNativeIdentity,
      operation: "send to"
    });
  }
  const preSendRuntime: TerminalRuntimeIdentity = {
    ...(deferredCodexForegroundBinding?.candidateAcceptanceAnchor
      ? terminalRuntimeForLiveIdentity({
          terminal: deferredCodexForegroundBinding.terminal,
          physicalOnly: true
        })
      : terminalRuntimeIdentityForConversation(
          nextConversation,
          terminalControl
        )),
    allowedPreMaterializationNativeIdentity:
      allowedPreMaterializationIdentity,
    allowedAdditionalNativeIdentities: allowedAdditionalIdentities,
    messageId: message.id
  };
  let preSendScreenFingerprint: string | undefined;
  let codexRolloutAcceptanceAnchor: CodexRolloutAcceptanceAnchor | undefined;
  let claudeTranscriptAnchor: ClaudeTranscriptAnchor | undefined;
  const claudeHome = executor.kind === "claude"
    ? path.resolve(expandHome(options.claudeHome) ?? defaultClaudeHome())
    : undefined;
  try {
    const status = await terminalBridge.status(executor.kind, terminalControl, {
      scrollbackLines: Number(options.scrollbackLines ?? 120),
      runtime: preSendRuntime
    });
    if (verifiedEmptyCodexHandoff || deferredCodexForegroundBinding) {
      if (
        executor.kind !== "codex" ||
        status.reachable !== true ||
        status.approval_state.blocked === true ||
        !["idle", "unknown"].includes(status.activity_state)
      ) {
        throw new Error(
          `Codex deferred foreground send is not at a safe prompt ` +
          `(${status.activity_state}: ${status.activity_reason})`
        );
      }
    } else {
      assertSafeTerminalSend(executor.kind, status);
    }
    if (executor.kind === "codex" && needsPostSendNativeBinding) {
      if (pendingManagedNativeBinding || allowedPreMaterializationIdentity) {
        const expectedForegroundId = stringValue(
          sendTakeover?.terminal_agent_expected_session_id
        );
        const foreground = createRuntimeTerminalAgentRegistry(options)
          .require("codex")
          .observeThreadLifecycle?.({
            operation: { kind: "new_thread" },
            phase: "before",
            screen: status.screen.excerpt ?? ""
          });
        if (
          !expectedForegroundId ||
          foreground?.status !== "observed" ||
          foreground.nativeThreadId !== expectedForegroundId
        ) {
          throw new Error(
            "Codex foreground thread changed after the managed /status proof; " +
            "refresh list before sending"
          );
        }
      }
      await assertCodexComposerReadyForAutomatedInput({
        options,
        terminalControl
      });
    }
    if (bridge) {
      preSendScreenFingerprint = stringValue(status.screen.digest) ??
        terminalBridgeScreenFingerprint(status.screen.excerpt);
      if (executor.kind === "codex") {
        codexRolloutAcceptanceAnchor = execution.captureCodexAcceptanceAnchor({
          currentIdentity: currentNativeIdentity,
          expectedNativeThreadId: expectedManagedNativeThreadId,
          boundProcessUuid: stringValue(
            sendTakeover?.terminal_agent_process_uuid
          ),
          boundProcessBirth: stringValue(
            sendTakeover?.terminal_agent_process_birth
          ),
          allowedPreMaterializationIdentity,
          needsPostSendNativeBinding,
          candidateSetAnchor:
            deferredCodexForegroundBinding?.candidateAcceptanceAnchor
        });
      } else {
        claudeTranscriptAnchor = captureClaudeTranscriptAnchor({
          sessionId: preSendRuntime.sessionId,
          cwd: preSendRuntime.cwd,
          pid: preSendRuntime.pid,
          claudeHome,
          agentRows: loadClaudeAgentRows(options)
        });
        if (!claudeTranscriptAnchor) {
          throw new Error(
            "the completion monitor could not bind an owner-private Claude transcript boundary"
          );
        }
      }
    }
  } catch (error) {
    throw new Error(
      `refusing to send to ${executor.display_name} without a verified idle terminal: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return {
    route, bridge, terminalControl, lockedStoreDir, statePath, logPath,
    terminalBridge, execution, bridgeStartedAt,
    agentTimeoutMinutes, agentHardTimeoutMinutes,
    terminalPayload, terminalRequestHash,
    presentationContext, presentationPorts, previousDispatchLedger,
    sendTakeover, terminalAgentPid, needsPostSendNativeBinding, preSendRuntime,
    preSendScreenFingerprint, codexRolloutAcceptanceAnchor,
    claudeTranscriptAnchor, claudeHome
  };
}

type PreparedTerminalControlSend = NonNullable<Awaited<
  ReturnType<typeof prepareTerminalControlSend>
>>;
async function resolveTerminalDispatchSubmissionOwner(
  prepared: PreparedTerminalControlSend,
  request: TerminalControlSendRequest,
  application: dispatchApplication.TerminalDispatchApplication,
  stagedConversation: Conversation
) {
  const {
    transaction, options, executor, allowedPreMaterializationIdentity,
    allowedAdditionalIdentities = [],
    deferredCodexForegroundBinding: deferredBinding
  } = request;
  const {
    execution, needsPostSendNativeBinding,
    codexRolloutAcceptanceAnchor: acceptanceAnchor,
    terminalControl, terminalAgentPid, sendTakeover, terminalRequestHash,
    route
  } = prepared;
  const deferredForegroundScope = deferredBinding
    ? bindDeferredForegroundApplicationScope(
        transaction.scopes,
        transaction.resources
      )
    : undefined;
  const ready = (conversation: Conversation, pending = false) => ({
    conversation, deferredCandidateBindingPending: pending
  });
  if (!needsPostSendNativeBinding) {
    return ready(stagedConversation);
  }
  let boundIdentity: NativeAgentSessionIdentity | undefined;
  let boundConversation: Conversation | undefined;
  let bindingError: string | undefined;
  try {
    if (
      deferredBinding &&
      cliEnv().AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE !== "1" &&
      ![2, 3].includes(Number(acceptanceAnchor?.version))
    ) {
      throw new Error(
        "deferred Codex foreground binding requires a virgin rollout acceptance anchor"
      );
    }
    boundIdentity = await execution.pollNativeIdentity({
      executor: executor.kind,
      terminalControl,
      pid: terminalAgentPid,
      expectedSessionId: stringValue(
        sendTakeover?.terminal_agent_expected_session_id
      ),
      allowedPreMaterializationIdentity,
      allowedAdditionalIdentities,
      ...(deferredBinding &&
          acceptanceAnchor &&
          [2, 3].includes(acceptanceAnchor.version)
        ? {
            requiredCodexAcceptance: {
              anchor: acceptanceAnchor,
              requestHash: terminalRequestHash
            },
            attempts: Math.max(1, Math.ceil(
              DEFAULT_TERMINAL_ACCEPTANCE_TIMEOUT_MS /
                DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS
            )),
            delayMs: DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS
          }
        : {})
    });
  } catch (error) {
    bindingError = error instanceof Error ? error.message : String(error);
  }
  if (boundIdentity) {
    try {
      if (
        acceptanceAnchor &&
        (
          boundIdentity.processUuid !==
            acceptanceAnchor.process_uuid ||
          boundIdentity.processBirth !==
            acceptanceAnchor.process_birth
        )
      ) {
        throw new Error(
          "Codex process incarnation changed while its native thread materialized"
        );
      }
      const expectedNativeThreadId = stringValue(
        sendTakeover?.terminal_agent_expected_session_id
      );
      if (
        expectedNativeThreadId &&
        boundIdentity.sessionId !== expectedNativeThreadId
      ) {
        throw new Error(
          `native agent created thread ${boundIdentity.sessionId}, expected ` +
          `${expectedNativeThreadId}`
        );
      }
      const resolvedBoundConversation = execution.withNativeIdentity(
        stagedConversation, boundIdentity
      );
      boundConversation = resolvedBoundConversation;
      const bindingStoreDir =
        managedSessionStoreDirForConversation(resolvedBoundConversation);
      const bindingStatePath = stringValue(resolvedBoundConversation.state_path);
      if (!bindingStoreDir || !bindingStatePath) {
        throw new Error("managed Session Store is unavailable before native identity commit");
      }
      const identityRoute = withExactTerminalDispatchRoute(route, {
        terminalControl,
        terminalKey: terminalBridgeRuntimeKey(terminalControl),
        storeDir: bindingStoreDir,
        statePath: bindingStatePath,
        logPath: path.join(path.dirname(bindingStatePath), "events.ndjson")
      }, (exactRoute) => exactRoute);
      if (deferredBinding) {
        await deferredForegroundApplication(
          options,
          deferredBinding.terminal
        ).commit({
          scope: required(
            deferredForegroundScope,
            "deferred foreground mutation scope is unavailable"
          ),
          boundary: deferredForegroundBoundaryProjection(deferredBinding),
          identity: boundIdentity,
          acceptedAt: cliNow().toISOString()
        });
      } else {
        await assertNativeThreadHasExclusiveOwnership({
          options,
          agent: executor.kind,
          currentPid: terminalAgentPid,
          nativeThreadId: boundIdentity.sessionId,
          storeDir: identityRoute.storeDir,
          terminalControl,
          excludedManagedSessionId: sessionIdForConversation(boundConversation)
        });
        persistManagedSessionNativeIdentity({
          conversation: boundConversation,
          terminalControl,
          identity: boundIdentity,
          storeDir: identityRoute.storeDir
        });
      }
      if (
        acceptanceAnchor?.version === 2 &&
        cliEnv().AKK_TEST_EXIT_AFTER_VIRGIN_SESSION_BINDING === "1"
      ) {
        cliExit(86);
      }
      // Persist the observed identity before the full Turn-vs-Session check:
      // the provisional Turn and Session initially share only a binding id.
      execution.assertTurnIdentity({
        conversation: boundConversation,
        currentIdentity: boundIdentity,
        operation: "bind"
      });
    } catch (error) {
      bindingError = error instanceof Error ? error.message : String(error);
      boundIdentity = undefined;
      boundConversation = undefined;
    }
  }
  if (!boundIdentity && deferredBinding) {
    try {
      const deferredScope = required(
        deferredForegroundScope,
        "deferred foreground mutation scope is unavailable"
      );
      const transfer = deferredScope.loadTransfer(deferredBinding.transferId);
      if (["committed", "resolved"].includes(transfer.status)) {
        const recoveredTarget =
          await deferredForegroundApplication(
            options,
            deferredBinding.terminal
          ).resolve({
            scope: deferredScope,
            boundary: deferredForegroundBoundaryProjection(deferredBinding)
          });
        const binding = recoveredTarget.binding;
        if (
          !binding?.native_thread_id ||
          !binding.native_process.process_uuid ||
          !binding.native_process.process_birth ||
          !isCompleteNativeRollout(binding.native_process.rollout)
        ) {
          throw new Error("resolved deferred target lacks exact native identity");
        }
        const recoveredIdentity: NativeAgentSessionIdentity = {
          sessionId: binding.native_thread_id,
          processUuid: binding.native_process.process_uuid,
          processBirth: binding.native_process.process_birth,
          rollout: binding.native_process.rollout,
          evidence: binding.native_process.evidence
        };
        const recoveredConversation = execution.withNativeIdentity(
          stagedConversation, recoveredIdentity
        );
        execution.assertTurnIdentity({
          conversation: recoveredConversation,
          currentIdentity: recoveredIdentity,
          operation: "recover deferred foreground binding for"
        });
        boundIdentity = recoveredIdentity;
        boundConversation = recoveredConversation;
      }
    } catch (error) {
      bindingError = error instanceof Error ? error.message : String(error);
      boundIdentity = undefined;
      boundConversation = undefined;
    }
  }
  if (boundIdentity && boundConversation) {
    return ready(boundConversation);
  }
  if (
    deferredBinding &&
    acceptanceAnchor?.version === 3 &&
    bindingError === undefined
  ) {
    return ready(stagedConversation, true);
  }
  const bindingReason = bindingError
    ? `AKK dispatched terminal input but could not verify the new native agent session: ${bindingError}`
    : "AKK dispatched terminal input but no exact native agent session appeared within the binding window";
  if (deferredBinding) {
    try {
      deferredForegroundApplication(
        options,
        deferredBinding.terminal
      ).markUncertain({
        scope: required(
          deferredForegroundScope,
          "deferred foreground mutation scope is unavailable"
        ),
        boundary: deferredForegroundBoundaryProjection(deferredBinding),
        reason: bindingReason
      });
    } catch (error) {
      runtimeLog("error", "deferred_codex_foreground_uncertain_persist_failed", {
        transfer_id: deferredBinding.transferId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    conversation: application.applyIdentityFailure(
      cliNow().toISOString(),
      bindingReason,
      deferredBinding
        ? undefined
        : (current) => quarantineManagedSessionBinding({
            conversation: current,
            reason: bindingReason,
            storeDir: route.storeDir
          })
    ),
    failureReason: bindingReason
  };
}

function deferredTerminalInputNotStartedAt(
  transfer: DeferredForegroundTransfer,
  terminalInputNotStartedAt?: string
): string | undefined {
  if (
    terminalInputNotStartedAt === undefined ||
    transfer.input_stage === "none"
  ) {
    return undefined;
  }
  if (
    transfer.status === "dispatch_started" &&
    transfer.input_stage === "dispatch_started"
  ) {
    return terminalInputNotStartedAt;
  }
  throw new Error(
    `deferred foreground transfer ${transfer.transfer_id} has ` +
    `${transfer.input_stage} input evidence and cannot accept a ` +
    "terminal-input-not-started result"
  );
}

interface TerminalDispatchRollbackRepositories {
  rollbackBeforeInput(route: BoundTerminalDispatchRoute): boolean;
  restoreDeferred(
    route: BoundTerminalDispatchRoute,
    terminalInputNotStartedAt?: string
  ): boolean;
}

function terminalDispatchRollbackRepositories({
  request,
  prepared,
  deferredForegroundScope,
  preTransportRollback
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  deferredForegroundScope?: DeferredForegroundApplicationScope;
  preTransportRollback?: (route: BoundTerminalDispatchRoute) => void;
}): TerminalDispatchRollbackRepositories {
  const {
    options,
    conversation,
    deferredCodexForegroundBinding
  } = request;
  let rollbackPreTransportAttach = preTransportRollback;
  const rollbackBeforeInput = (
    route: BoundTerminalDispatchRoute
  ): boolean => {
    if (!rollbackPreTransportAttach) {
      return true;
    }
    const rollback = rollbackPreTransportAttach;
    rollbackPreTransportAttach = undefined;
    try {
      rollback(route);
      return true;
    } catch (error) {
      runtimeLog("error", "raw_attach_pre_transport_rollback_failed", {
        conversation_id: conversation.conversation_id,
        terminal_target: route.terminalControl.target,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  };
  const restoreDeferred = (
    route: BoundTerminalDispatchRoute,
    terminalInputNotStartedAt?: string
  ): boolean => {
    if (!deferredCodexForegroundBinding) {
      return false;
    }
    const deferredScope = required(
      deferredForegroundScope,
      "deferred foreground mutation scope is unavailable"
    );
    const transfer = deferredScope.loadTransfer(
      deferredCodexForegroundBinding.transferId
    );
    if (
      terminalBridgeRuntimeKey(route.terminalControl) !==
        terminalBridgeRuntimeKey(
          deferredCodexForegroundBinding.terminal.terminalControl
        ) ||
      (transfer.state_path !== undefined &&
        !sameCanonicalStatePath(transfer.state_path, route.statePath))
    ) {
      throw new Error(
        "deferred Codex pre-input abort escaped its exact mutation resources"
      );
    }
    const durableTerminalInputNotStartedAt =
      deferredTerminalInputNotStartedAt(
        transfer,
        terminalInputNotStartedAt
      );
    deferredRecoveryAdapter.abortPreparedDeferredForegroundTurn(
      deferredForegroundRecoveryAdapterPorts(), {
      options,
      scope: deferredScope,
      storeDir: route.storeDir,
      terminal: {
        ...deferredCodexForegroundBinding.terminal,
        terminalControl: route.terminalControl
      },
      transfer,
      boundary: deferredCodexForegroundBinding,
      terminalInputNotStartedAt: durableTerminalInputNotStartedAt
    });
    // The dedicated abort already durably restores the Turn, ledger,
    // transfer, and Sessions. Never invoke the attach rollback twice.
    rollbackPreTransportAttach = undefined;
    return true;
  };
  return { rollbackBeforeInput, restoreDeferred };
}

interface TerminalDispatchProgress {
  stagedConversation: Conversation;
  textInjectedAt?: string;
  enterDispatchedAt?: string;
  bookkeepingWarning?: string;
}

interface TerminalDispatchRuntime {
  application: dispatchApplication.TerminalDispatchApplication;
  terminalMessage: AgentMessage &
    dispatchApplication.TerminalDispatchMessage;
  progress: TerminalDispatchProgress;
  recordPostTransportBookkeepingFailure(
    phase: string,
    error: unknown
  ): void;
  validatePreparedMessageEvent(): void;
}

function createTerminalDispatchRuntime(
  request: TerminalControlSendRequest,
  prepared: PreparedTerminalControlSend,
  rollback: TerminalDispatchRollbackRepositories
): TerminalDispatchRuntime {
  const {
    transaction,
    conversation,
    nextConversation,
    executor,
    message,
    recordRawAttachmentAfterSend = false
  } = request;
  const {
    bridge,
    terminalControl,
    lockedStoreDir,
    statePath,
    logPath,
    bridgeStartedAt,
    agentTimeoutMinutes,
    agentHardTimeoutMinutes,
    terminalPayload,
    terminalRequestHash,
    previousDispatchLedger,
    preSendScreenFingerprint,
    codexRolloutAcceptanceAnchor,
    claudeTranscriptAnchor,
    claudeHome
  } = prepared;
  const terminalMessage = message as typeof message &
    dispatchApplication.TerminalDispatchMessage;
  const bridgeConversation = bridge
    ? dispatchReceipt.withTerminalBridgeState({
        conversation: nextConversation,
        message: terminalMessage,
        requestText: terminalPayload,
        startedAt: bridgeStartedAt,
        agentTimeoutMinutes,
        agentHardTimeoutMinutes,
        monitorLockVersion: monitorOwner.LOCK_VERSION,
        preSendScreenFingerprint,
        codexRolloutAcceptanceAnchor,
        claudeTranscriptAnchor,
        claudeHome
      })
    : nextConversation;
  const preparedConversation = withTerminalBridgeSubmission({
    conversation: bridgeConversation,
    messageId: message.id,
    messageType: terminalMessage.type,
    messageBody: String(message.body),
    requestText: terminalPayload,
    status: "prepared",
    preparedAt: bridgeStartedAt
  });
  const previousGenerationId =
    stringValue(previousDispatchLedger?.generation_id) ??
    stringValue(previousDispatchLedger?.message_id);
  const progress: TerminalDispatchProgress = {
    stagedConversation: preparedConversation
  };
  let preparedMessageEvent: EventRecord | undefined;
  const recordPostTransportBookkeepingFailure = (
    phase: string,
    error: unknown
  ): void => {
    const warning = error instanceof Error ? error.message : String(error);
    progress.bookkeepingWarning ??= warning;
    runtimeLog("warn", "terminal_message_post_transport_bookkeeping_failed", {
      conversation_id: conversation.conversation_id,
      terminal_target: terminalControl.target,
      phase,
      error: warning
    });
  };
  const { applicationPorts } = bindTerminalDispatchCapabilities({
    scopes: transaction.scopes,
    resources: transaction.resources,
    repositories: terminalDispatchCapabilityRepositories({
      previousLedger: previousDispatchLedger,
      preparedMessageEvent: () => {
        if (!preparedMessageEvent) {
          throw new Error("prepared message event was not validated");
        }
        return preparedMessageEvent;
      },
      restoreDeferred: rollback.restoreDeferred,
      rollbackBeforeInput: rollback.rollbackBeforeInput
    }),
    local: {
      synchronizeStageProgress: (current, stage, at) => {
        progress.stagedConversation = current;
        progress.textInjectedAt = stage === "text_injected"
          ? at
          : progress.textInjectedAt;
        progress.enterDispatchedAt = stage === "enter_dispatched"
          ? at
          : progress.enterDispatchedAt;
      },
      audit: {
        log: runtimeLog,
        recordBookkeepingFailure: recordPostTransportBookkeepingFailure,
        recordPersistenceFailure: (phase, error, current) => {
          runtimeLog("error", phase, {
            conversation_id: current.conversation_id,
            terminal_target: terminalControl.target,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  });
  const application = new dispatchApplication.TerminalDispatchApplication({
    originalConversation: conversation,
    preparedConversation,
    message: terminalMessage,
    executor,
    terminalControl,
    receiptTerminalControl: terminalControlFromTakeover(
      isRecord(preparedConversation.native_session_takeover)
        ? preparedConversation.native_session_takeover
        : undefined
    ),
    requestText: terminalPayload,
    requestHash: terminalRequestHash,
    preparedAt: bridgeStartedAt,
    statePath,
    eventLogPath: logPath,
    previousGenerationId,
    dispatcherPid: cliPid(),
    storeDir: lockedStoreDir,
    recordRawAttachmentAfterSend,
    ledgerBindingFields: terminalBindingLedgerFields
  }, applicationPorts);
  application.persistPrepared();
  return {
    application,
    terminalMessage,
    progress,
    recordPostTransportBookkeepingFailure,
    validatePreparedMessageEvent: () => {
      preparedMessageEvent = messageEvent(terminalMessage);
    }
  };
}

function terminalDispatchTransportLifecycle({
  request,
  prepared,
  application,
  deferredForegroundScope
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  application: dispatchApplication.TerminalDispatchApplication;
  deferredForegroundScope?: DeferredForegroundApplicationScope;
}): ReturnType<TerminalDispatchExecutionService["transportLifecycle"]> {
  const {
    options,
    observedHandoff,
    verifiedEmptyCodexHandoff,
    deferredCodexForegroundBinding
  } = request;
  return prepared.execution.transportLifecycle({
    ...(observedHandoff
      ? {
          observedHandoff: {
            verify: (requireEmptyComposer) =>
              assertObservedHandoffTransportBoundary({
                options,
                terminal: observedHandoff.terminal,
                transition: observedHandoff.transition,
                requireEmptyComposer
              })
          }
        }
      : {}),
    ...(verifiedEmptyCodexHandoff
      ? {
          verifiedEmptyHandoff: {
            verify: (requireEmptyComposer) =>
              assertVerifiedEmptyCodexTransportBoundary({
                options,
                boundary: verifiedEmptyCodexHandoff,
                requireEmptyComposer
              })
          }
        }
      : {}),
    ...(deferredCodexForegroundBinding
      ? {
          deferredBinding: {
            verify: (requireEmptyComposer) =>
              assertDeferredCodexForegroundBindingBoundary({
                options,
                scope: required(
                  deferredForegroundScope,
                  "deferred foreground mutation scope is unavailable"
                ),
                boundary: deferredCodexForegroundBinding,
                expectedSourceStatus: "transitioning",
                requireNoDispatch: false,
                requireEmptyComposer
              }),
            begin: (at) => deferredForegroundApplication(
              options,
              deferredCodexForegroundBinding.terminal
            ).begin({
              scope: required(
                deferredForegroundScope,
                "deferred foreground mutation scope is unavailable"
              ),
              boundary: deferredForegroundBoundaryProjection(
                deferredCodexForegroundBinding
              ),
              at
            }),
            advance: (stage, at) => deferredForegroundApplication(
              options,
              deferredCodexForegroundBinding.terminal
            ).advance({
              scope: required(
                deferredForegroundScope,
                "deferred foreground mutation scope is unavailable"
              ),
              boundary: deferredForegroundBoundaryProjection(
                deferredCodexForegroundBinding
              ),
              stage,
              at
            })
          }
        }
      : {}),
    recordStage: (stage, at, afterDurable) =>
      application.recordTransportStage(stage, at, afterDurable)
  });
}

async function terminalDispatchAcceptance({
  request,
  prepared,
  conversation
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  conversation: Conversation;
}): Promise<dispatchApplication.TerminalDispatchAcceptance> {
  const { options, executor } = request;
  const { execution, terminalControl } = prepared;
  const timeoutMs = positiveMilliseconds(
    options.terminalAcceptanceTimeoutMs ??
      DEFAULT_TERMINAL_ACCEPTANCE_TIMEOUT_MS,
    "--terminal-acceptance-timeout-ms"
  );
  return execution.pollAcceptance({
    executor: executor.kind,
    conversation,
    terminalControl,
    timeoutMs,
    pollIntervalMs: Math.max(10, Math.min(
      timeoutMs,
      Number(options.terminalAcceptancePollIntervalMs ??
        DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS)
    )),
    scrollbackLines: Number(options.scrollbackLines ?? 240)
  });
}

function launchAcceptedTerminalMonitor({
  request,
  prepared,
  conversation,
  acceptance,
  recordFailure
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  conversation: Conversation;
  acceptance: dispatchApplication.TerminalDispatchAcceptance;
  recordFailure(phase: string, error: unknown): void;
}): TerminalMonitorProcess | undefined {
  const { options } = request;
  const {
    bridge,
    statePath,
    logPath,
    terminalControl,
    agentTimeoutMinutes,
    agentHardTimeoutMinutes
  } = prepared;
  if (
    !bridge ||
    !(
      acceptance.outcome === "agent_accepted" ||
      acceptance.outcome === "pending_acceptance"
    )
  ) {
    return undefined;
  }
  try {
    const monitor = startTerminalBridgeMonitorForConversation({
      conversation,
      statePath,
      logPath,
      options
    });
    if (monitor) {
      appendEvent(logPath, {
        ts: cliNow().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: monitor.pid ?? null,
        terminal_control: terminalControl,
        phase: acceptance.outcome,
        agent_timeout_minutes: agentTimeoutMinutes,
        agent_hard_timeout_minutes: agentHardTimeoutMinutes
      });
    }
    return monitor;
  } catch (error) {
    recordFailure("monitor_launch", error);
    return undefined;
  }
}

function presentTerminalDispatchTransportFailure({
  error,
  request,
  prepared,
  application,
  progress,
  deferredForegroundScope,
  bridgeMonitor
}: {
  error: unknown;
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  application: dispatchApplication.TerminalDispatchApplication;
  progress: TerminalDispatchProgress;
  deferredForegroundScope?: DeferredForegroundApplicationScope;
  bridgeMonitor?: TerminalMonitorProcess;
}): void {
  const {
    options,
    executor,
    message,
    deferredCodexForegroundBinding
  } = request;
  const {
    lockedStoreDir,
    terminalControl,
    presentationContext,
    presentationPorts
  } = prepared;
  if (
    !progress.textInjectedAt &&
    error instanceof TerminalInputNotStartedError
  ) {
    renderTerminalZeroInputAbort(application.recordZeroInputAbort({
      failureKind: "transport",
      error,
      abortedAt: cliNow().toISOString()
    }), presentationContext, presentationPorts, bridgeMonitor?.pid);
    return;
  }
  const uncertainAt = cliNow().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (deferredCodexForegroundBinding) {
    try {
      deferredForegroundApplication(
        options,
        deferredCodexForegroundBinding.terminal
      ).markUncertain({
        scope: required(
          deferredForegroundScope,
          "deferred foreground mutation scope is unavailable"
        ),
        boundary: deferredForegroundBoundaryProjection(
          deferredCodexForegroundBinding
        ),
        reason: errorMessage
      });
    } catch (transferError) {
      runtimeLog("error", "deferred_codex_foreground_uncertain_persist_failed", {
        transfer_id: deferredCodexForegroundBinding.transferId,
        error: transferError instanceof Error
          ? transferError.message
          : String(transferError)
      });
    }
  }
  const uncertainConversation = application.applyUncertain(
    uncertainAt,
    error
  );
  const stalledConversationIds =
    stallOtherTerminalBridgeConversationsForUncertainDispatch({
      storeDir: lockedStoreDir,
      terminalControl,
      currentConversationId: uncertainConversation.conversation_id,
      uncertainMessageId: message.id
    });
  runtimeLog("error", "terminal_message_submit_uncertain", {
    conversation_id: uncertainConversation.conversation_id,
    agent: executor.kind,
    terminal_target: terminalControl.target,
    error: errorMessage,
    do_not_retry: true,
    stalled_conversation_ids: stalledConversationIds
  });
  presentTerminalUncertain({
    conversation: uncertainConversation,
    stalledConversationIds,
    textInjected: progress.textInjectedAt !== undefined,
    enterDispatched: progress.enterDispatchedAt !== undefined,
    monitorPid: bridgeMonitor?.pid
  }, presentationContext, presentationPorts);
}

type TerminalDispatchTransportResult =
  | { outcome: "handled" }
  | {
      outcome: "completed";
      conversation: Conversation;
      acceptance: dispatchApplication.TerminalDispatchAcceptance;
      bridgeMonitor?: TerminalMonitorProcess;
    };

async function runTerminalDispatchTransport({
  request,
  prepared,
  application,
  progress,
  recordPostTransportBookkeepingFailure,
  deferredForegroundScope
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  application: dispatchApplication.TerminalDispatchApplication;
  progress: TerminalDispatchProgress;
  recordPostTransportBookkeepingFailure(phase: string, error: unknown): void;
  deferredForegroundScope?: DeferredForegroundApplicationScope;
}): Promise<TerminalDispatchTransportResult> {
  const { executor } = request;
  const {
    terminalBridge,
    terminalControl,
    terminalPayload,
    preSendRuntime,
    codexRolloutAcceptanceAnchor,
    presentationContext,
    presentationPorts
  } = prepared;
  let bridgeMonitor: TerminalMonitorProcess | undefined;
  try {
    const transportLifecycle = terminalDispatchTransportLifecycle({
      request,
      prepared,
      application,
      deferredForegroundScope
    });
    await terminalBridge.send(
      executor.kind,
      terminalControl,
      terminalPayload,
      { runtime: preSendRuntime, ...transportLifecycle }
    );
    if (!progress.enterDispatchedAt) {
      throw new Error(
        "terminal bridge returned without an enter_dispatched receipt"
      );
    }
    if (
      codexRolloutAcceptanceAnchor?.version === 2 &&
      cliEnv().AKK_TEST_EXIT_AFTER_VIRGIN_ENTER_DISPATCHED === "1"
    ) {
      cliExit(86);
    }
    const submissionOwner = await resolveTerminalDispatchSubmissionOwner(
      prepared,
      request,
      application,
      progress.stagedConversation
    );
    if ("failureReason" in submissionOwner) {
      presentTerminalIdentityFailure(
        submissionOwner.conversation,
        submissionOwner.failureReason,
        presentationContext,
        presentationPorts,
        bridgeMonitor?.pid
      );
      return { outcome: "handled" };
    }
    const acceptance = submissionOwner.deferredCandidateBindingPending
      ? { outcome: "pending_acceptance" } as const
      : await terminalDispatchAcceptance({
          request,
          prepared,
          conversation: submissionOwner.conversation
        });
    const deliveredConversation = application.applyAcceptance(
      submissionOwner.conversation,
      acceptance,
      cliNow().toISOString()
    ).conversation;
    bridgeMonitor = launchAcceptedTerminalMonitor({
      request,
      prepared,
      conversation: deliveredConversation,
      acceptance,
      recordFailure: recordPostTransportBookkeepingFailure
    });
    return {
      outcome: "completed",
      conversation: deliveredConversation,
      acceptance,
      bridgeMonitor
    };
  } catch (error) {
    presentTerminalDispatchTransportFailure({
      error,
      request,
      prepared,
      application,
      progress,
      deferredForegroundScope,
      bridgeMonitor
    });
    return { outcome: "handled" };
  }
}

async function runTerminalControlSend(
  request: TerminalControlSendRequest
): Promise<void> {
  const {
    transaction,
    recordMessageAfterSend = false,
    onTerminalPreflightVerified,
    deferredCodexForegroundBinding
  } = request;
  const prepared = await prepareTerminalControlSend(request);
  if (!prepared) {
    return;
  }
  const { route, presentationContext, presentationPorts } = prepared;
  const deferredForegroundScope = deferredCodexForegroundBinding
    ? bindDeferredForegroundApplicationScope(
        transaction.scopes,
        transaction.resources
      )
    : undefined;
  // A newly discovered raw terminal may not have an authoritative Session
  // yet. Commit that Session only after every pre-input terminal and native
  // acceptance check has passed, but before the Turn or dispatch ledger can
  // become durable. This prevents a failed virgin attach from leaving a
  // zero-identity `bound` Session that fences every later control action.
  if (deferredCodexForegroundBinding) {
    deferredForegroundScope?.assertBoundary(
      deferredForegroundBoundaryProjection(deferredCodexForegroundBinding)
    );
  }
  const preTransportRollback =
    await onTerminalPreflightVerified?.(route);
  const rollback = terminalDispatchRollbackRepositories({
    request,
    prepared,
    deferredForegroundScope,
    preTransportRollback: typeof preTransportRollback === "function"
      ? preTransportRollback
      : undefined
  });
  const dispatch = createTerminalDispatchRuntime(
    request,
    prepared,
    rollback
  );
  const {
    application,
    progress,
    recordPostTransportBookkeepingFailure,
    validatePreparedMessageEvent
  } = dispatch;
  try {
    // Preserve legacy argument-evaluation priority inside the setup catch:
    // validate once before raw-attach bookkeeping, then let the gated
    // repository consume only this cached immutable event.
    application.recordPreparedBookkeeping(
      recordMessageAfterSend,
      cliEnv().AKK_TEST_TERMINAL_SETUP_FAILURE === "1",
      recordMessageAfterSend
        ? validatePreparedMessageEvent
        : undefined
    );
  } catch (error) {
    renderTerminalZeroInputAbort(application.recordZeroInputAbort({
      failureKind: "setup",
      error,
      abortedAt: cliNow().toISOString(),
      injectStatePersistenceFailure:
        cliEnv().AKK_TEST_ABORTED_STATE_PERSISTENCE_FAILURE === "1"
    }), presentationContext, presentationPorts, undefined);
    return;
  }

  const transport = await runTerminalDispatchTransport({
    request,
    prepared,
    application,
    progress,
    recordPostTransportBookkeepingFailure,
    deferredForegroundScope
  });
  if (transport.outcome === "handled") {
    return;
  }
  const deliveredConversation = transport.conversation;
  const acceptanceResult = transport.acceptance;
  const bridgeMonitor = transport.bridgeMonitor;
  const nativeAccepted = acceptanceResult?.outcome === "agent_accepted";
  const postSubmissionWarning = application.recordPostSubmissionBookkeeping(
    deliveredConversation,
    nativeAccepted,
    () => cliNow().toISOString()
  );
  if (postSubmissionWarning !== undefined) {
    progress.bookkeepingWarning = postSubmissionWarning;
  }
  presentTerminalCompleted({
    conversation: deliveredConversation,
    acceptance: acceptanceResult,
    monitorPid: bridgeMonitor?.pid,
    bookkeepingWarning: progress.bookkeepingWarning
  }, presentationContext, presentationPorts);
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
