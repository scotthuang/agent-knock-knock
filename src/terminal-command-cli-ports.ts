import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import type { ExecutorKind } from "./executors.js";
import type { FileLockAcquisitionOptions } from
  "./file-lock-cli-adapter.js";
import type {
  ManagedSessionState,
  NativeThreadTransition
} from "./managed-session.js";
import type {
  CanonicalMutationLockPorts,
  CanonicalMutationResources,
  CanonicalMutationScopes,
  CanonicalStateMutationResources,
  CanonicalStateMutationScopes
} from "./mutation-transaction.js";
import type { Conversation, Executor, AgentMessage } from "./protocol.js";
import type { EventRecord } from "./store.js";
import type {
  TerminalAgentAdapterRegistry as TerminalRegistry,
  TerminalApprovalDecision,
  TerminalControlRef,
  TerminalDurableCompletionRequest,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import type {
  TerminalAgentBridge,
  TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import type {
  NativeIdentityResolutionRequest,
  NativeAgentSessionIdentityObservation,
  TerminalDispatchExecutionService
} from "./terminal-dispatch-execution.js";
import type {
  CodexAllowedCompanionSet,
  CodexPreMaterializationIdentity
} from "./terminal-authority-policy.js";
import type { TerminalNativeIdentity as NativeAgentSessionIdentity } from
  "./terminal-binding-authority.js";
import type {
  DeferredCodexForegroundBindingBoundary,
  TerminalDispatchTerminal,
  VerifiedEmptyCodexHandoffBoundary
} from "./terminal-dispatch-composition.js";
import type {
  BoundTerminalDispatchRoute,
  TerminalDispatchCapabilityRepositories
} from "./terminal-dispatch-capability.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import type { TerminalBridgeSubmissionMutation } from
  "./terminal-dispatch-receipt.js";
import type { DeferredForegroundApplicationScope } from
  "./deferred-foreground-boundary.js";
import type { DeferredForegroundApplicationService } from
  "./deferred-foreground-application-service.js";
import type { DeferredForegroundRecoveryAdapterPorts } from
  "./deferred-foreground-recovery-cli-adapter.js";
import type { CodexForegroundIdentificationProof } from
  "./native-thread-lifecycle-cli-adapter.js";
import type {
  PreparedUserExplicitFallbackWatch,
  UserExplicitFallbackWatchReceipt
} from "./terminal-watch-cli-adapter.js";
import type {
  TerminalScopedCodexApprovalBoundary,
  TerminalScopedCodexApprovalPromptSnapshot
} from "./terminal-scoped-approval-authority.js";
import type { TerminalWriterMutationLockOptions } from
  "./terminal-mutation-cli-runtime.js";

export interface TerminalCommandCliOptions {
  agentHardTimeoutMinutes?: number | string;
  agentTimeoutMinutes?: number | string;
  autoApprovalPolicyJson?: string;
  autoApproved?: boolean;
  background?: boolean;
  claudeHome?: string;
  conversation?: string;
  conversationId?: string;
  decision?: TerminalApprovalDecision;
  expectedApprovalFingerprint?: string;
  expectedCallbackConversationId?: string;
  expectedCallbackMessageId?: string;
  expectedCallbackOpenclawSession?: string;
  expectedCallbackSessionId?: string;
  expectedCallbackTurnId?: string;
  expectedManagedTerminalToken?: string;
  expectedTerminalToken?: string;
  /** Explicit P2 atomic identify-then-send mode; never inferred by ordinary Send. */
  identifyForeground?: boolean;
  /** Internal copy of the user-priority token while managed fast path runs. */
  expectedUserExplicitTerminalToken?: string;
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

export type TerminalCommandTarget = TerminalDispatchTerminal;
export type TerminalDispatchRecord = Record<string, unknown>;

interface LoadedTerminalConversation {
  conversation: Conversation;
  statePath: string;
  logPath: string;
}

export interface TerminalMonitorProcess {
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

/**
 * Host/runtime dependencies for the terminal command CLI facade.
 *
 * Application services should consume a named `Pick` of this contract rather
 * than importing the command facade or inheriting the complete port bag.
 */
export interface TerminalCommandCliPorts {
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
    runtime?: TerminalRuntimeIdentity;
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
  prepareManagedSessionNativeIdentityClaim(request: {
    options: TerminalCommandCliOptions;
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    identity: NativeAgentSessionIdentity;
    storeDir: string;
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
  identifyCodexForegroundWhileLocked(request: {
    options: TerminalCommandCliOptions;
    terminal: TerminalCommandTarget;
    expectedTerminalToken: string;
  }): Promise<CodexForegroundIdentificationProof>;
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
    load(
      scopes: CanonicalMutationScopes,
      resources: CanonicalMutationResources
    ): TerminalDispatchLedgerDocument | undefined;
    save(
      scopes: CanonicalMutationScopes,
      resources: CanonicalMutationResources,
      ledger: TerminalDispatchLedgerDocument
    ): void;
    resolve(
      scopes: CanonicalMutationScopes,
      resources: CanonicalMutationResources,
      request: {
        conversation: Readonly<{ conversation_id: string }>;
        expectedMessageId?: string;
        reason: string;
      }
    ): boolean;
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
  processIncarnationForPid(pid: number): {
    processUuid: string;
    processBirth: string;
    evidence: "process_birth";
  };
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
  resolveTerminalBridgeDispatchLedger(
    terminalControl: TerminalControlRef,
    request: {
      conversation: Readonly<{ conversation_id: string }>;
      expectedMessageId?: string;
      reason: string;
    }
  ): boolean;
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
    terminalControl: TerminalControlRef,
    options?: TerminalWriterMutationLockOptions
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
    ) => Promise<Result>,
    options?: FileLockAcquisitionOptions
  ): Promise<Result>;
  prepareUserExplicitFallbackWatch(input: {
    options: TerminalCommandCliOptions;
    terminal: TerminalCommandTarget;
    requestHash: string;
    messageId: string;
    physicalToken: string;
  }): Promise<PreparedUserExplicitFallbackWatch | undefined>;
  attachUserExplicitFallbackWatch(input: {
    options: TerminalCommandCliOptions;
    prepared: PreparedUserExplicitFallbackWatch;
  }): Promise<UserExplicitFallbackWatchReceipt>;
  userExplicitFallbackWatchReceipt(input: {
    options: TerminalCommandCliOptions;
    watchId: string;
  }): UserExplicitFallbackWatchReceipt | undefined;
}

export interface TerminalCommandCliDependencies {
  ports: TerminalCommandCliPorts;
}

/** Named port subsets keep extracted application services from inheriting the facade bag. */
export type TerminalCommandPortView<
  Names extends keyof TerminalCommandCliPorts
> = Pick<TerminalCommandCliPorts, Names>;

/**
 * Runtime seams used by exact Codex submission recovery. The retry application
 * service may depend on this view, never on every command-facade port.
 */
export type TerminalSubmissionRetryCliPorts = TerminalCommandPortView<
  | "acquireFileLock"
  | "assertDeferredCodexForegroundBindingBoundary"
  | "assertSafeAbortedTerminalRetryBinding"
  | "createTerminalAgentBridge"
  | "deferredForegroundApplication"
  | "deferredForegroundRecoveryAdapterPorts"
  | "exactSafeAbortedRecoveredSessionMatches"
  | "loadConversationFromOptions"
  | "loadTerminalBridgeDispatchLedger"
  | "loadTerminalDispatchLedgerOwner"
  | "managedSessionStoreDirForConversation"
  | "mutationDispatchLedger"
  | "openClawYieldNextAction"
  | "reconcilePreparedTerminalDispatchLedger"
  | "required"
  | "resolveTerminalDispatchLedgerPaneIncarnation"
  | "startTerminalBridgeMonitorForConversation"
  | "terminalBridgeRequestFingerprint"
  | "terminalBridgeRuntimeKey"
  | "terminalControlFromTakeover"
  | "terminalDispatchExecution"
  | "terminalDispatchRecordMatchesControl"
  | "terminalRuntimeIdentityForConversation"
  | "terminalWriterMutationLocks"
  | "textSummary"
  | "withTerminalBridgeSubmission"
  | "withTerminalDispatchStateScope"
>;
