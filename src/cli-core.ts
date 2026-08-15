import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type {
  ActiveCodexProcess,
  ForkContextPackage
} from "./codex-session-provider.js";
import {
  createCodexTerminalAgentAdapter,
  detectCodexDurableCompletion
} from "./codex-terminal-agent-adapter.js";
import { codexLifecycleBehaviorProfile } from "./codex-lifecycle-compatibility.js";
import {
  createClaudeTerminalAgentAdapter,
  type ClaudeAgentRow
} from "./claude-terminal-agent-adapter.js";
import {
  createClaudeThreadLifecycleCandidateProvider,
  detectClaudeTranscriptAcceptance,
  detectClaudeTranscriptCompletion,
  detectClaudeTranscriptPendingApproval,
  observeClaudeDeadProcessTranscriptCompletion
} from "./claude-local-transcript-provider.js";
import {
  captureCodexCandidateSetRolloutAcceptanceAnchor,
  captureCodexRolloutAcceptanceAnchor,
  detectCodexBoundRolloutCompletion,
  detectCodexCandidateSetRolloutAcceptance,
  detectCodexRolloutAcceptance,
  type CodexRolloutAcceptanceAnchor,
  type TerminalSubmissionAcceptanceEvidence,
  validateCodexRolloutAcceptanceAnchor
} from "./terminal-submission-acceptance.js";
import {
  CodexLocalSessionProvider,
  InlineCodexLocalSessionAdapter
} from "./codex-local-session-provider.js";
import { CodexStoreAdapter } from "./codex-store-adapter.js";
import { buildConversationTrace } from "./conversation-trace.js";
import { canonicalJson } from "./canonical-json.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import {
  createDeferredForegroundTransferId,
  listDeferredForegroundTransfers,
  loadDeferredForegroundTransfer,
  type DeferredForegroundTransfer,
  type DeferredForegroundTransferSourceRolloutAuthority,
  type DeferredForegroundTransferSourceTurnAuthority
} from "./deferred-foreground-transfer.js";
import {
  atomicReplacePrivateJsonFile,
  fsyncDirectory
} from "./durable-json-file.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import type {
  CodexOpenRootRolloutInventory
} from "./agent-session-provider.js";
import {
  applyMessageToConversation,
  budgetAction,
  createConversation,
  createMessage,
  effectiveTurnStatus,
  executorForConversation,
  resolveExecutor,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation,
  type ConversationStatus
} from "./protocol.js";
import {
  EXECUTOR_KINDS,
  executorDefinitionForKind,
  isExecutorKind,
  type ExecutorKind
} from "./executors.js";
import { redactString } from "./runtime-log.js";
import { formatTranscript, readNdjsonLog } from "./transcript.js";
import {
  appendEvent,
  assertStoreWriterCompatible,
  defaultStoreDir,
  ensureDir,
  ensureStoreWritable,
  inspectStoreCompatibility,
  listConversations,
  logPathForStatePath,
  loadConversationById,
  loadState,
  messageEvent,
  pathsForConversation,
  pathsForConversationDir,
  saveState,
  STORE_SESSION_AUTHORITY_PROTOCOL,
  StoreLockTimeoutError,
  statePathForConversationId,
  withStoreWriterLease,
  withStoreWriterLeaseAsync
} from "./store.js";
import {
  createManagedSessionId,
  createNativeThreadTransitionId,
  isExactNativeThreadId,
  legacyManagedSessionBindingToken,
  legacyUnmanagedTerminalBindingToken,
  managedSessionBindingToken,
  managedSessionRevision,
  nativeThreadCommandFingerprint,
  terminalBindingFrom,
  unmanagedTerminalBindingToken,
  type ManagedSessionState,
  type HumanObservedHandoffTargetSnapshot,
  type NativeThreadCandidate,
  type NativeThreadTransition
} from "./managed-session.js";
import {
  assertNativeThreadHasExclusiveOwnership as assertNativeThreadHasExclusiveOwnershipFromQuery,
  assertRestorableOriginSessionRelationship as assertRestorableOriginSessionRelationshipFromQuery,
  previousCommittedResumeCandidate as previousCommittedResumeCandidateFromQuery,
  requireRestorableLifecycleOrigin as requireRestorableLifecycleOriginFromQuery,
  resumableNativeThreadCandidates,
  revalidateNativeThreadCandidate as revalidateNativeThreadCandidateFromQuery,
  type NativeThreadLifecycleQueryPorts
} from "./native-thread-lifecycle-query-service.js";
import {
  decideResumeCandidateEligibility,
  decideResumeTargetSession,
  prepareNativeThreadTransition,
  reduceNativeThreadTransitionPhase
} from "./native-thread-transition-policy.js";
import {
  settleFailedNativeThreadTransition,
  settleVerifiedNativeThreadTransition,
  type NativeThreadTransitionSettlementPorts
} from "./native-thread-transition-settlement-service.js";
import {
  reconcileLifecycleDispatchLedger as reconcileLifecycleDispatchLedgerService,
  recoverLifecycleFenceBeforeMutation as recoverLifecycleFenceBeforeMutationService,
  type CodexCompanionSet as LifecycleRecoveryCodexCompanionSet,
  type NativeThreadLifecycleRecoveryAuthority,
  type NativeThreadLifecycleRecoveryPorts
} from "./native-thread-lifecycle-recovery-service.js";
import {
  claudeComposerEmpty,
  codexComposerEmpty,
  codexComposerVisible,
  createNativeThreadLifecycleRecoveryProbeAdapter,
  lifecycleRecoveryRuntime,
  lifecycleRecoveryTerminalFacts
} from "./native-thread-lifecycle-recovery-adapter.js";
import {
  nativeThreadTransitionResourceBoundOperation
} from "./native-thread-transition-resource-adapter.js";
import {
  assertResumedNativeThreadMatchesCandidate as assertResumedCodexRolloutMatchesCandidate,
  knownNativeThreadCompanionSet,
  nativeThreadCandidateFileIdentity as codexCandidateFileIdentity,
  prepareNativeThreadVerification,
  probeCodexCurrentThread,
  verifyNativeThreadTransition as verifyNativeThreadTransitionWithRuntime,
  type NativeThreadVerificationAdapterPorts
} from "./native-thread-transition-verification-adapter.js";
import {
  createNativeThreadResumeSnapshot,
  resolveNativeThreadResumeSelection,
  saveNativeThreadResumeSnapshot
} from "./native-thread-resume-snapshot.js";
import {
  assertResumeSnapshotActionFingerprint,
  assertResumeSnapshotCandidates,
  assertResumeSnapshotMatchesTerminal,
  assertResumeSnapshotNotExpired,
  terminalActionFingerprint,
  type NativeThreadResumeSnapshot
} from "./native-thread-resume-snapshot-policy.js";
import {
  commitVerifiedLifecycleTransition,
  listNativeThreadTransitions,
  listManagedSessions,
  loadManagedSession,
  loadNativeThreadTransition,
  saveManagedSession,
  saveNativeThreadTransition,
  tryLoadManagedSession
} from "./session-store.js";
import {
  createTerminalControlProviderRegistry as createProviderRegistry,
  StaticTerminalControlProvider,
  TerminalControlUnavailableError,
  TmuxTerminalControlProvider,
  type TerminalControlProvider,
  type TerminalControlProviderRegistry
} from "./terminal-control-provider.js";
import { HerdrTerminalControlProvider } from "./herdr-terminal-control-provider.js";
import {
  parseTerminalConversationId,
  type ActiveTerminalProcess,
  type TerminalCompletionEvidence,
  type TerminalControlCapability,
  type TerminalControlRef,
  type TerminalDurableCompletionRequest,
  type TerminalRuntimeIdentity,
  type TerminalThreadLifecycleCandidateProvider,
  type TerminalThreadLifecycleCandidateToken
} from "./terminal-agent-adapter.js";
import {
  associateTerminalEndpointEvidence,
  hasCanonicalTerminalEndpoint,
  sameTerminalControlIncarnation,
  terminalControlEvidence,
  terminalControlEvidenceMatches,
  terminalEndpointFromControlRef,
  terminalRuntimeResourceKey,
  type TerminalControlEvidence
} from "./terminal-control-ref.js";
import { createProductionTerminalAgentRegistry } from "./terminal-agent-registry.js";
import {
  StaticTerminalProcessSource,
  SystemTerminalProcessSource,
  type TerminalProcessSource
} from "./terminal-process-source.js";
import {
  exactCodexReadyStyledComposerCapture,
  isExactClaudeNativeInspectionIdleComposer,
  NativeInspectionSubmissionError,
  TerminalAgentBridge,
  TerminalInputNotStartedError,
  type ResolvedTerminalConversation
} from "./terminal-agent-bridge.js";
import {
  decideAcceptedTurnDeadAgentStall,
  decideVerifiedDeadAgentProcess,
  isVerifiedDeadAgentProcessDisposition,
  reconcileVerifiedDeadAgentAuthority,
  selectVerifiedDeadAgentEvent,
  validateStoredVerifiedDeadAgentAuthority,
  validateVerifiedDeadAgentEventAuthority,
  verifiedDeadTerminalAgentProcessEvidenceId,
  type BoundTerminalAgentProcessObservation,
  type VerifiedDeadAgentAuthorityContext,
  type VerifiedDeadAgentAuthorityDecision,
  type VerifiedDeadAgentCompletionObservation,
  type VerifiedDeadTerminalAgentProcessProof
} from "./verified-dead-agent-policy.js";
import {
  runDoctor,
  runInstallOpenClaw
} from "./install-doctor-command-adapter.js";
import {
  createTerminalListCliFacade
} from "./terminal-list-cli-adapter.js";
import {
  createTerminalCommandCliFacade
} from "./terminal-command-cli-adapter.js";
import {
  exactRolloutMatches,
  type TerminalNativeIdentity as NativeAgentSessionIdentity
} from "./terminal-binding-authority.js";
import {
  activeTurnHandoffDecisionToken as projectActiveTurnHandoffDecisionToken,
  decideManagedBindingConflict,
  codexCompanionsExcludingPreferred,
  codexIdentityFence,
  deferredCodexForegroundBindingToken,
  exactBoundCodexSendSource,
  isCodexStatusCardEvidence,
  isCompleteNativeRollout,
  nativeIdentityMatchesCodexPreMaterialization,
  observedHandoffAuthorityToken as projectObservedHandoffAuthorityToken,
  processIncarnationRelationship,
  selectRootTerminalProcesses,
  terminalControlAliasMatches,
  terminalControlsShareIncarnation,
  verifiedEmptyCodexHandoffToken,
  withCodexCompanionFences,
  type CodexAllowedCompanionSet,
  type CodexPreMaterializationIdentity,
  type CodexSendAuthorityContext,
  type ManagedBindingConflictKind
} from "./terminal-authority-policy.js";
import {
  compareManagedConversationRecency
} from "./terminal-action-projection.js";
import { reconcileTerminalBinding } from "./terminal-binding-reconciliation-service.js";
import {
  canonicalMutationResource, capabilityGatedRepositoryOperation,
  capabilityGatedRepositoryPairOperation, withCanonicalMutationLocks,
  withCanonicalStateMutationLock,
  type CanonicalMutationResources,
  type CanonicalMutationScopes,
  type CanonicalStateMutationResources,
  type CanonicalStateMutationScopes
} from "./mutation-transaction.js";
import {
  bindTerminalDispatchRoute,
  terminalDispatchStateLockPath,
  terminalDispatchStateMutationResource,
  terminalDispatchStateResourceForStore,
  type BoundTerminalDispatchRoute,
  type TerminalDispatchCapabilityRepositories
} from "./terminal-dispatch-capability.js";
import {
  createCallbackOutboxService,
  deterministicTerminalCallbackMessageId,
  type CallbackPreparationOptions,
  type PreparedCallback
} from "./callback-outbox-service.js";
import {
  createOpenClawCallbackTransport,
  type CallbackProcessDeliveryObservation
} from "./openclaw-callback-transport.js";
import {
  decideTerminalMonitorVerifiedDeadCompletion as decideVerifiedDeadAgentCompletion,
  terminalMonitorActivityPersistIntervalMs as terminalBridgeActivityPersistIntervalMs,
  terminalMonitorApprovalCandidate as terminalBridgeApprovalCandidate,
  terminalMonitorDeadlineAt as deadlineAt,
  validTerminalMonitorTimestampMs as validTimestampMs
} from "./terminal-monitor-decision-policy.js";
import * as monitorLaunch from "./terminal-monitor-launch-plan.js";
import * as monitorOwner from "./terminal-monitor-ownership-policy.js";
import {
  runTerminalMonitor as runTerminalMonitorService,
  runTerminalMonitorWithStoreDeferral,
  type TerminalMonitorServicePorts
} from "./terminal-monitor-application-service.js";
import {
  pollTerminalMonitor,
  presentTerminalMonitor,
  reconcileMonitorAcceptance,
  recordMonitorApprovalNotification,
  recoverPreparedMonitorSubmission,
  terminalMonitorStoreLeaseTimeout,
  terminalMonitorStoreOperationTimeout
} from "./terminal-monitor-cli-adapter.js";
import { terminalMonitorReconciliationEligibility as monitorEligibility } from
  "./terminal-monitor-reconciliation-eligibility.js";
import {
  constructTerminalDispatchLedgerDocument,
  decodeTerminalDispatchLedgerDocument,
  nativeThreadLifecycleLedger as lifecycleLedger,
  sameCanonicalStatePath,
  terminalDispatchLedgerLooksLifecycle,
  terminalDispatchReceiptHistory as terminalLedgerReceiptHistory,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import type {
  DeferredCodexForegroundBindingBoundary,
  DeferredCodexForegroundDispatchSnapshot,
  TerminalDispatchTerminal,
  VerifiedEmptyCodexHandoffBoundary
} from "./terminal-dispatch-composition.js";
import {
  DeferredForegroundApplicationService
} from "./deferred-foreground-application-service.js";
import type {
  DeferredForegroundApplicationScope,
  DeferredForegroundBindingBoundary
} from "./deferred-foreground-boundary.js";
import {
  bindDeferredForegroundApplicationScope,
  bindDeferredForegroundWriterScope
} from "./deferred-foreground-capability.js";
import { DeferredForegroundRecoveryService } from
  "./deferred-foreground-recovery-service.js";
import * as deferredRecoveryAdapter from
  "./deferred-foreground-recovery-cli-adapter.js";
import { prepareDeferredForegroundBinding } from
  "./deferred-foreground-preparation-service.js";
import {
  assertDeferredForegroundBoundary,
  deferredForegroundBoundaryProjection,
  deferredForegroundConcreteBoundary,
  deferredForegroundTransferMatchesTerminal,
  projectDeferredForegroundTerminalFacts,
  type DeferredForegroundBoundaryAdapterPorts
} from "./deferred-foreground-preparation-cli-adapter.js";
import * as deferredAuthorityAdapter from
  "./deferred-foreground-authority-cli-adapter.js";
import {
  TerminalDispatchExecutionService,
  assertManagedSessionCanStartTurnPolicy,
  codexKnownBeforeIdentityForTransition,
  codexLingeringIdentityMatches,
  logicalManagedSessionIdentity,
  managedBindingMatchesLiveTerminal,
  managedSessionOwnerIsInactive,
  managedTurnMatchesTerminal,
  migratedTerminalBindingMatches,
  nativeThreadTransitionRevision,
  resolvedTerminalProcessIncarnation as resolvedTerminalProcessIncarnationPolicy,
  selectBoundManagedSessionForTerminal,
  selectSoleBoundManagedSessionClaim,
  terminalSubmissionPayload,
  terminalRuntimeForLiveIdentity as terminalRuntimeForLiveIdentityPolicy,
  terminalRuntimeIdentityBase,
  type NativeAgentSessionIdentityObservation,
  type NativeIdentityResolutionRequest
} from "./terminal-dispatch-execution.js";
import * as dispatchReceipt from "./terminal-dispatch-receipt.js";
import {
  cleanProcessText,
  expandHome,
  packageRootDir,
  redactCliOutput,
  resolveOptionalExecutable,
  writeCliJson as printJson
} from "./cli-command-runtime.js";
import {
  cliCwd,
  cliDependencies,
  cliEnv,
  cliExit,
  cliNow,
  cliNowMs,
  cliPid,
  cliRuntimeLog as runtimeLog,
  cliSleep,
  cliSleepSync as sleepSync,
  runCliCommandExecution,
  setCliExitCode,
  writeCliStdout,
  type CliCommandDependencies as RuntimeCliCommandDependencies,
  type CliCommandExecutionResult
} from "./cli-runtime-context.js";

export type { CliCommandExecutionResult };

const cliFileLock = createFileLockCliAdapter({
  now: cliNow,
  nowMs: cliNowMs,
  pid: cliPid,
  sleepSync
});
const acquireFileLock = cliFileLock.acquire;
const staleFileLock = cliFileLock.stale;
const readFileLockOwner = cliFileLock.owner;

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10080;
const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_AGENT_HARD_TIMEOUT_MINUTES = 720;
const DEFAULT_MONITOR_POLL_INTERVAL_MS = 5000;
const CLAUDE_SCREEN_APPROVAL_TTL_MS = 10 * 60 * 1000;
const CALLBACK_ATTEMPT_LEASE_MS = 2 * 60 * 1000;
const CALLBACK_RETRY_DELAYS_MS = [5000, 15000, 60000, 60000];
const TERMINAL_CONTROL_CAPABILITIES = new Set<TerminalControlCapability>([
  "screen_status",
  "send_keys",
  "terminal_approval",
  "screen_completion",
  "durable_completion",
  "terminal_cancel"
]);
const TERMINAL_INPUT_EVIDENCE_FIELDS = [
  "text_injected_at",
  "enter_dispatched_at",
  "submitted_at",
  "agent_accepted_at",
  "not_accepted_at",
  "uncertain_at",
  "acceptance_evidence"
] as const;
const FINAL_DEFERRED_TRANSFER_STATUSES = new Set(["resolved", "abort_resolved"]);
const gateRepository = capabilityGatedRepositoryOperation;
const gateRepositoryPair = capabilityGatedRepositoryPairOperation;
const authenticateLifecycleRecoveryResources = gateRepositoryPair(
  ["terminal", "storeWriter"] as const,
  ["terminal", "storeWriter"] as const,
  (terminalControl: TerminalControlRef, storeDir: string) => ({
    terminalControl,
    storeDir
  })
);
const mutationConversationStore = Object.freeze({
  load: gateRepository(["state"], "state", (resource: { statePath: string }) => loadState(resource.statePath)),
  save: gateRepository(["storeWriter", "state"], "state", (resource: { statePath: string }, state: Conversation) => saveState(resource.statePath, state)),
  appendEvent: gateRepository(["storeWriter", "state"], "state", (resource: { logPath: string }, event: Parameters<typeof appendEvent>[1]) => appendEvent(resource.logPath, event))
});
const mutationDispatchLedger = Object.freeze({
  load: gateRepository(["terminal"], "terminal", loadTerminalBridgeDispatchLedger),
  save: gateRepository(["terminal", "storeWriter"], "terminal", saveTerminalBridgeDispatchLedger),
  resolve: gateRepository(["terminal", "storeWriter"], "terminal", resolveTerminalBridgeDispatchLedger),
  reconcileIncarnation: gateRepository(["terminal", "storeWriter"], "terminal",
    (terminalControl: TerminalControlRef) => resolveTerminalDispatchLedgerPaneIncarnation(
      terminalControl, loadTerminalBridgeDispatchLedger(terminalControl))),
  reconcile: reconcileLifecycleDispatchLedgerScoped,
  beforeMutation: recoverLifecycleFenceBeforeMutationScoped
});
const mutationManagedSessions = Object.freeze({
  load: gateRepository(["storeWriter"], "storeWriter", loadManagedSession),
  save: gateRepository(["storeWriter"], "storeWriter", saveManagedSession)
});
function terminalWriterMutationLocks(storeDir: string, terminalControl: TerminalControlRef) {
  const canonicalStoreDir = path.resolve(storeDir);
  return {
    resources: {
      terminal: canonicalMutationResource(terminalBridgeRuntimeKey(terminalControl), terminalControl),
      storeWriter: canonicalMutationResource(canonicalStoreDir, canonicalStoreDir)
    },
    acquireTerminal: () => acquireTerminalBridgeSendLock(canonicalStoreDir, terminalControl, { timeoutMs: 30000 }),
    withStoreWriter: <Result>(operation: () => Promise<Result>) => withStoreWriterLeaseAsync(canonicalStoreDir, operation)
  };
}
function terminalWriterStateMutationLocks(storeDir: string, terminalControl: TerminalControlRef, statePath: string, logPath: string) {
  const locks = terminalWriterMutationLocks(storeDir, terminalControl);
  const stateResource = terminalDispatchStateResourceForStore(
    storeDir, statePath, logPath
  );
  return {
    ...locks, resources: {
      ...locks.resources,
      state: stateResource
    },
    acquireState: () => acquireFileLock(
      terminalDispatchStateLockPath(stateResource)
    )
  };
}
function withTerminalDispatchStateScope<Result>(
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  statePath: string,
  logPath: string,
  operation: (
    scopes: CanonicalStateMutationScopes,
    resources: CanonicalStateMutationResources
  ) => Promise<Result>
): Promise<Result> {
  const stateResource = terminalDispatchStateMutationResource(
    scopes, resources, statePath, logPath
  );
  return withCanonicalStateMutationLock(
    scopes,
    resources,
    {
      resource: stateResource,
      acquire: () => acquireFileLock(
        terminalDispatchStateLockPath(stateResource)
      )
    },
    operation
  );
}

function terminalDispatchCapabilityRepositories({
  previousLedger,
  preparedMessageEvent,
  restoreDeferred,
  rollbackBeforeInput
}: {
  previousLedger: TerminalDispatchLedgerDocument | undefined;
  preparedMessageEvent(): Parameters<typeof appendEvent>[1];
  restoreDeferred(
    route: BoundTerminalDispatchRoute,
    terminalInputNotStartedAt?: string
  ): boolean;
  rollbackBeforeInput(route: BoundTerminalDispatchRoute): boolean;
}): TerminalDispatchCapabilityRepositories {
  return Object.freeze({
    state: {
      save(scopes, resources, conversation) {
        const route = bindTerminalDispatchRoute(scopes, resources);
        saveState(route.statePath, conversation);
      }
    },
    ledger: {
      save(scopes, resources, ledger, phase) {
        const route = bindTerminalDispatchRoute(scopes, resources);
        if (
          phase === "final" &&
          cliEnv().AKK_TEST_FINAL_TERMINAL_LEDGER_FAILURE === "1"
        ) {
          throw new Error(
            "injected final terminal ledger persistence failure"
          );
        }
        saveTerminalBridgeDispatchLedger(route.terminalControl, ledger);
      },
      restore(scopes, resources, reason, terminalInputNotStartedAt) {
        const route = bindTerminalDispatchRoute(scopes, resources);
        if (restoreDeferred(route, terminalInputNotStartedAt)) {
          return;
        }
        restoreTerminalBridgeDispatchLedger({
          terminalControl: route.terminalControl,
          previousLedger,
          reason
        });
      }
    },
    audit: {
      append(scopes, resources, event) {
        const route = bindTerminalDispatchRoute(scopes, resources);
        appendEvent(route.logPath, { ...event });
      },
      appendPreparedMessage(scopes, resources) {
        const route = bindTerminalDispatchRoute(scopes, resources);
        appendEvent(route.logPath, preparedMessageEvent());
      }
    },
    rollbackBeforeInput(scopes, resources) {
      return rollbackBeforeInput(
        bindTerminalDispatchRoute(scopes, resources)
      );
    }
  });
}
const TERMINAL_BRIDGE_SUPERSEDE_STATUSES = new Set<ConversationStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "stalled",
  "cancelling"
]);
const TERMINAL_DISPATCH_RELEASE_STATUSES = new Set<ConversationStatus>([
  "idle",
  "failed",
  "closed",
  "cancelled"
]);
const ACTIVE_TERMINAL_DISPATCH_STATUSES = new Set([
  "prepared",
  "text_injected",
  "enter_dispatched",
  "agent_accepted",
  "dispatching",
  "submitted",
  "not_accepted",
  "uncertain"
]);
const RECOVERABLE_TERMINAL_DISPATCH_STATUSES = new Set([...ACTIVE_TERMINAL_DISPATCH_STATUSES, "verified"]);
const SESSION_SEND_BLOCKING_STATUSES = new Set<ConversationStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "stalled",
  // Valid legacy records are normalized at the Store read boundary. Keeping
  // these here makes malformed legacy records fail closed.
  "callback_pending",
  "callback_failed",
  "cancelling"
]);
const TERMINAL_BRIDGE_UNCERTAIN_COLLATERAL_STALL_REASON =
  "a newer terminal submission has an uncertain outcome; inspect the shared terminal pane before continuing";
const SESSION_SELECTOR_COMMANDS = new Set([
  "status",
  "send",
  "respond",
  "approve",
  "cancel",
  "renew",
  "retry-callback",
  "close"
]);
const STORE_MUTATION_COMMANDS = new Set([
  "delegate",
  "send",
  "respond",
  "approve",
  "cancel",
  "renew",
  "reconcile-monitors",
  "close",
  "callback",
  "retry-callback",
  "monitor",
  "new-thread",
  "clear-thread",
  "resume-thread",
  "reconcile-binding"
]);

export type CliCommandOptions = Record<string, any>;
export type CliCommandDependencies = RuntimeCliCommandDependencies<CliCommandOptions>;

export interface ParsedCliCommand {
  command?: string;
  options: CliCommandOptions;
}

class TurnBindingSupersededError extends Error {
  readonly code = "AKK_TURN_BINDING_SUPERSEDED";

  constructor(message: string) {
    super(message);
    this.name = "TurnBindingSupersededError";
  }
}

export function parseCliCommand(argv: readonly string[]): ParsedCliCommand {
  const [command, ...rawArgs] = argv;
  return {
    command,
    options: parseArgs(rawArgs)
  };
}

export async function executeCliCommand(
  commandName: string | undefined,
  options: CliCommandOptions = {},
  dependencies: CliCommandDependencies = {}
): Promise<CliCommandExecutionResult> {
  return runCliCommandExecution(
    commandName,
    options,
    dependencies,
    () => dispatchCliCommand(commandName, options)
  );
}

async function dispatchCliCommand(commandName, options) {
  await terminalListCliFacade.resolveConversationSelectorOption(commandName, options);
  preflightStoreWriter(commandName, options);
  if (commandName === "help" || commandName === "--help" || commandName === "-h") {
    usage();
  } else if (commandName === "version" || commandName === "--version" || commandName === "-v") {
    printVersion();
  } else if (commandName === "delegate") {
    await runDelegate(options);
  } else if (commandName === "list") {
    await terminalListCliFacade.runList(options);
  } else if (commandName === "status") {
    await runStatus(options);
  } else if (commandName === "send") {
    await terminalCommandCliFacade.runSend(options);
  } else if (commandName === "new-thread" || commandName === "clear-thread") {
    await runNewThread(options);
  } else if (commandName === "list-resumable-threads" || commandName === "threads") {
    await runListResumableThreads(options);
  } else if (commandName === "native-inspect" || commandName === "native-status") {
    await runNativeInspect(options);
  } else if (commandName === "resume-thread") {
    await runResumeThread(options);
  } else if (commandName === "reconcile-binding") {
    await runReconcileBinding(options);
  } else if (commandName === "respond") {
    await terminalCommandCliFacade.runRespond(options);
  } else if (commandName === "approve") {
    await terminalCommandCliFacade.runApprove(options);
  } else if (commandName === "cancel") {
    await runCancel(options);
  } else if (commandName === "renew") {
    await runRenew(options);
  } else if (commandName === "reconcile-monitors") {
    await runReconcileMonitors(options);
  } else if (commandName === "close") {
    await runClose(options);
  } else if (commandName === "transcript") {
    runTranscript(options);
  } else if (commandName === "install-openclaw") {
    runInstallOpenClaw(options);
  } else if (commandName === "doctor") {
    runDoctor(options);
  } else if (commandName === "callback") {
    runCallback(options);
  } else if (commandName === "retry-callback") {
    runRetryCallback(options);
  } else if (commandName === "monitor") {
    await runMonitor(options);
  } else {
    usage();
    setCliExitCode(commandName ? 1 : 0);
  }
}

function preflightStoreWriter(commandName, options): void {
  if (!STORE_MUTATION_COMMANDS.has(String(commandName ?? ""))) {
    return;
  }
  const statePath = stringValue(options.state);
  const storeDir = statePath
    ? pathsForConversationDir(path.dirname(expandHome(statePath))).storeDir
    : storeDirFromOptions(options);
  assertStoreWriterCompatible(storeDir);
}

function canonicalWorkspace(value: unknown): string {
  const requested = path.resolve(String(required(value, "--workspace is required")));
  let canonical: string;
  let stat: fs.Stats;
  try {
    canonical = fs.realpathSync(requested);
    stat = fs.statSync(canonical);
  } catch {
    throw new Error(`--workspace does not exist: ${requested}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`--workspace must be a directory: ${requested}`);
  }
  return canonical;
}

function matchesConfiguredWorkspace(
  configuredWorkspace: unknown,
  candidateWorkspace: unknown
): boolean {
  if (configuredWorkspace === undefined) {
    return true;
  }
  if (candidateWorkspace === undefined || candidateWorkspace === null) {
    return false;
  }
  try {
    return canonicalWorkspace(configuredWorkspace) ===
      canonicalWorkspace(candidateWorkspace);
  } catch {
    return false;
  }
}

function assertConfiguredWorkspace(
  configuredWorkspace: unknown,
  candidateWorkspace: unknown,
  subject: string
): void {
  if (configuredWorkspace === undefined) {
    return;
  }
  const configured = canonicalWorkspace(configuredWorkspace);
  let candidate: string;
  try {
    candidate = canonicalWorkspace(candidateWorkspace);
  } catch {
    throw new Error(
      `refusing ${subject}; its working directory cannot be verified against expected workspace ${configured}`
    );
  }
  if (candidate !== configured) {
    throw new Error(
      `refusing ${subject}; workspace ${candidate} does not match expected workspace ${configured}`
    );
  }
}

async function listActiveSessionsWithTerminalControl(
  provider,
  options,
  terminalProvider: TerminalControlProvider = createTerminalControlProvider(options)
): Promise<ActiveCodexProcess[]> {
  const activeSessions = await provider.listActiveSessions();
  const activePids = new Set(activeSessions.map((session) => session.pid));
  const processTree = activePids.size > 0
    ? await createTerminalProcessSource(options).listProcessSnapshots(
        (snapshot) => activePids.has(snapshot.pid),
        { includeCwd: false, includeAncestors: true }
      )
    : [];
  return createTerminalAgentBridge(options, terminalProvider).attachProcesses(
    provider.agent,
    activeSessions,
    { processTree }
  );
}

function createRuntimeTerminalControlProviderRegistry(
  options
): TerminalControlProviderRegistry {
  const injected = cliDependencies<CliCommandOptions>().terminalControlProviderRegistry;
  if (injected) {
    return injected;
  }
  return createProviderRegistry([
    options.terminalsJson || options.terminalScreensJson || options.processesJson
      ? new StaticTerminalControlProvider({
          panes: options.terminalsJson
            ? parseJsonOption(options.terminalsJson, "--terminals-json")
            : [],
          screens: options.terminalScreensJson
            ? parseJsonOption(options.terminalScreensJson, "--terminal-screens-json")
            : {}
        })
      : new TmuxTerminalControlProvider(),
    ...(
      options.terminalsJson || options.terminalScreensJson || options.processesJson
        ? []
        : [new HerdrTerminalControlProvider()]
    )
  ]);
}

function createTerminalControlProvider(
  options,
  registry: TerminalControlProviderRegistry =
    createRuntimeTerminalControlProviderRegistry(options)
): TerminalControlProvider {
  return registry.asProvider();
}

function createTerminalProcessSource(options): TerminalProcessSource {
  const injected = cliDependencies<CliCommandOptions>().terminalProcessSource;
  if (injected) {
    return injected;
  }
  if (options.processesJson) {
    return new StaticTerminalProcessSource(
      parseJsonOption(options.processesJson, "--processes-json")
    );
  }
  return new SystemTerminalProcessSource();
}

function loadClaudeAgentRows(
  options: Record<string, any> = {},
  observation: { required?: boolean } = {}
): ClaudeAgentRow[] {
  const injected = cliDependencies<CliCommandOptions>().loadClaudeAgentRows;
  if (injected) {
    return injected(options, observation);
  }
  let value: unknown;
  if (options.claudeAgentsJson !== undefined) {
    value = typeof options.claudeAgentsJson === "string"
      ? parseJsonOption(options.claudeAgentsJson, "--claude-agents-json")
      : options.claudeAgentsJson;
  } else if (options.processesJson || options.terminalsJson || options.terminalScreensJson) {
    return [];
  } else {
    const claudeExecutable = resolveOptionalExecutable("claude");
    if (!claudeExecutable) {
      if (observation.required) {
        throw new Error(
          "Claude agent session observation is unavailable because the Claude CLI could not be resolved"
        );
      }
      return [];
    }
    const result = spawnSync(claudeExecutable, ["agents", "--json", "--all"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
      timeout: 10_000
    });
    if (result.error || result.status !== 0) {
      runtimeLog("warn", "claude_agents_list_failed", {
        status: result.status ?? null,
        error: result.error?.message,
        stderr: textSummary(cleanProcessText(result.stderr))
      });
      if (observation.required) {
        throw new Error(
          "Claude agent session observation failed; refusing to treat the process as a virgin session"
        );
      }
      return [];
    }
    try {
      value = JSON.parse(result.stdout);
    } catch {
      runtimeLog("warn", "claude_agents_list_invalid_json", {
        stdout: textSummary(result.stdout)
      });
      if (observation.required) {
        throw new Error(
          "Claude agent session observation returned invalid JSON; refusing to treat the process as a virgin session"
        );
      }
      return [];
    }
  }

  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.agents)
      ? value.agents
      : undefined;
  if (!rows) {
    if (observation.required) {
      throw new Error(
        "Claude agent session observation returned an unsupported result shape; refusing to treat the process as a virgin session"
      );
    }
    return [];
  }
  return rows.flatMap((row): ClaudeAgentRow[] => {
    if (!isRecord(row) || !Number.isInteger(Number(row.pid))) {
      return [];
    }
    return [{
      pid: Number(row.pid),
      ...(stringValue(row.cwd) ? { cwd: stringValue(row.cwd) } : {}),
      ...(stringValue(row.kind) ? { kind: stringValue(row.kind) } : {}),
      ...(stringValue(row.sessionId) ? { sessionId: stringValue(row.sessionId) } : {}),
      ...(Number.isSafeInteger(Number(row.startedAt)) && Number(row.startedAt) > 0
        ? { startedAt: Number(row.startedAt) }
        : {}),
      ...(stringValue(row.status) ? { status: stringValue(row.status) } : {}),
      ...(stringValue(row.waitingFor)
        ? { waitingFor: stringValue(row.waitingFor) }
        : {})
    }];
  });
}

function createRuntimeTerminalAgentRegistry(options) {
  return createProductionTerminalAgentRegistry({
    overrides: [
      createCodexTerminalAgentAdapter({
        async detectDurableCompletion(request: TerminalDurableCompletionRequest) {
          const runtime = isRecord(request.context) ? request.context : undefined;
          const conversation = runtime?.conversation;
          const nativeTakeover = isRecord(runtime?.nativeTakeover)
            ? runtime?.nativeTakeover
            : undefined;
          if (!isRecord(conversation)) {
            return undefined;
          }
          const exactCompletion = detectExactBoundCodexCompletion({
            conversation,
            nativeTakeover,
            request,
            runtime,
            options
          });
          if (exactCompletion.handled) {
            return exactCompletion.completion;
          }
          const contextMatches = await loadCodexTerminalContexts({
            nativeTakeover,
            options
          });
          const matches: TerminalCompletionEvidence[] = [];
          const detectionErrors: string[] = [];
          for (const contextMatch of contextMatches) {
            try {
              const evidence = detectCodexDurableCompletion({
                ...request,
                context: contextMatch.context
              });
              if (evidence) {
                matches.push({
                  ...evidence,
                  confidence: contextMatch.confidence as "high" | "medium" | "low",
                  metadata: {
                    ...evidence.metadata,
                    context_match: contextMatch.match,
                    session: contextMatch.context.source
                  }
                });
              }
            } catch (error) {
              detectionErrors.push(
                error instanceof Error ? error.message : String(error)
              );
            }
          }
          if (detectionErrors.length > 0) {
            throw new Error(
              `could not inspect every plausible Codex completion: ${detectionErrors.join("; ")}`
            );
          }
          if (matches.length > 1) {
            throw new Error(
              "multiple same-cwd Codex sessions match the managed terminal request"
            );
          }
          return matches[0];
        }
      }),
      createClaudeTerminalAgentAdapter({
        agentRows: loadClaudeAgentRows(options),
        detectPendingApproval(request: TerminalDurableCompletionRequest) {
          return detectClaudeTranscriptPendingApproval(request, {
            claudeHome: expandHome(options.claudeHome),
            agentRows: loadClaudeAgentRows(options)
          });
        },
        async detectDurableCompletion(request: TerminalDurableCompletionRequest) {
          return detectClaudeTranscriptCompletion(request, {
            claudeHome: expandHome(options.claudeHome),
            agentRows: loadClaudeAgentRows(options)
          });
        }
      })
    ]
  });
}

function detectExactBoundCodexCompletion({
  conversation,
  nativeTakeover,
  request,
  runtime,
  options
}: {
  conversation: Record<string, any>;
  nativeTakeover?: Record<string, any>;
  request: TerminalDurableCompletionRequest;
  runtime?: Record<string, any>;
  options: Record<string, any>;
}): { handled: boolean; completion?: TerminalCompletionEvidence } {
  const submission = terminalBridgeSubmission(conversation);
  const acceptanceEvidence = isRecord(submission?.acceptance_evidence)
    ? submission.acceptance_evidence
    : undefined;
  const anchor = isRecord(nativeTakeover?.codex_rollout_acceptance_anchor)
    ? nativeTakeover.codex_rollout_acceptance_anchor
    : undefined;
  if (submission?.status !== "agent_accepted") {
    return { handled: false };
  }
  const exactRequired = requiresExactBoundCodexCompletion(conversation);
  if (!exactRequired) {
    return { handled: false };
  }
  if (acceptanceEvidence?.source !== "codex_rollout") {
    throw new Error(
      "[codex_exact_bound_rollout:invalid_acceptance_evidence] " +
      "the accepted modern Codex Turn has no exact rollout acceptance evidence"
    );
  }
  if (!anchor) {
    throw new Error(
      "[codex_exact_bound_rollout:invalid_anchor] " +
      "the accepted modern Codex Turn has no exact rollout byte anchor"
    );
  }

  const nativeRollout = isRecord(runtime?.nativeRollout)
    ? runtime.nativeRollout
    : undefined;
  const result = detectCodexBoundRolloutCompletion({
    anchor: anchor as unknown as CodexRolloutAcceptanceAnchor,
    acceptanceEvidence:
      acceptanceEvidence as unknown as TerminalSubmissionAcceptanceEvidence,
    currentIdentity: {
      sessionId:
        stringValue(runtime?.nativeSessionId) ??
        stringValue(runtime?.sessionId) ??
        "",
      processUuid: stringValue(runtime?.nativeProcessUuid),
      processBirth: stringValue(runtime?.nativeProcessBirth),
      ...(nativeRollout
        ? {
            rollout: {
              fd: String(nativeRollout.fd ?? ""),
              device: String(nativeRollout.device ?? ""),
              inode: String(nativeRollout.inode ?? ""),
              path: String(nativeRollout.path ?? "")
            }
          }
        : {})
    },
    requestHash:
      stringValue(request.requestHash) ??
      stringValue(nativeTakeover?.terminal_bridge_request_hash) ??
      ""
  });
  if (result.status === "failure") {
    throw new Error(
      `[codex_exact_bound_rollout:${result.diagnostics.code}] ${
        result.diagnostics.detail ?? "the exact bound rollout is not safely inspectable"
      }`
    );
  }
  if (result.status === "pending") {
    return { handled: true };
  }
  return {
    handled: true,
    completion: {
      ...result.completion,
      metadata: {
        ...result.completion.metadata,
        context_match: "exact_bound_rollout",
        detector_code: result.diagnostics.code
      }
    }
  };
}

function requiresExactBoundCodexCompletion(
  conversation: Record<string, any>
): boolean {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(conversation);
  if (submission?.status !== "agent_accepted") {
    return false;
  }
  const hasExactArtifacts =
    isRecord(nativeTakeover?.codex_rollout_acceptance_anchor) &&
    isRecord(submission.acceptance_evidence) &&
    submission.acceptance_evidence.source === "codex_rollout";
  const modernProductionTurn =
    Number(nativeTakeover?.terminal_agent_identity_protocol) === 1 &&
    cliEnv().AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE !== "1";
  return hasExactArtifacts || modernProductionTurn;
}

function createTerminalAgentBridge(
  options,
  terminalProvider: TerminalControlProvider = createTerminalControlProvider(options),
  registry = createRuntimeTerminalAgentRegistry(options)
): TerminalAgentBridge {
  const processSource = createTerminalProcessSource(options);
  const dependencies = cliDependencies<CliCommandOptions>();
  return new TerminalAgentBridge({
    registry,
    terminalProvider,
    ...(dependencies.monotonicNowMs
      ? { nowMs: dependencies.monotonicNowMs }
      : {}),
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
    async verifyIdentity({ agent, pid, terminalControl, runtime }) {
      const adapter = registry.require(agent);
      const requestedTerminal = terminalProvider.endpoint(terminalControl);
      const resolvedTerminal = await terminalProvider.resolve(requestedTerminal);
      const expectedWorkspace =
        options.workspace ?? resolvedTerminal.route.currentPath ??
        terminalControl.currentPath;
      if (!expectedWorkspace) {
        throw new Error(
          `refusing terminal access to ${terminalControl.target}; its workspace is unavailable`
        );
      }
      const snapshots = await processSource.listProcessSnapshots(
        (candidate) => candidate.pid === pid,
        {
          includeCwd: true,
          includeAncestors: true
        }
      );
      const snapshot = snapshots.find((candidate) => candidate.pid === pid);
      if (!snapshot || !adapter.classifyProcess(snapshot)) {
        throw new Error(
          `terminal conversation agent ${agent} with pid ${pid} is no longer active`
        );
      }
      if (!terminalProvider.containsProcess(
        resolvedTerminal,
        snapshot,
        snapshots
      )) {
        throw new Error(
          `terminal conversation agent ${agent} with pid ${pid} no longer belongs to pane ${terminalControl.target}`
        );
      }
      assertConfiguredWorkspace(
        expectedWorkspace,
        snapshot.cwd,
        `terminal access to ${terminalControl.target} by agent process ${pid}`
      );
      assertConfiguredWorkspace(
        expectedWorkspace,
        resolvedTerminal.route.currentPath,
        `terminal access to ${terminalControl.target} by terminal endpoint`
      );
      const requiresNativeIdentity = Boolean(
        runtime?.nativeSessionId ||
        runtime?.nativeProcessUuid ||
        runtime?.nativeProcessBirth ||
        runtime?.nativeRollout ||
        runtime?.requireNativeProcessUuid ||
        runtime?.requireExactClaudeAgentRow ||
        runtime?.nativeProcessStartedAt ||
        runtime?.exactClaudeAgentState ||
        runtime?.requireNativeRolloutIdentity ||
        runtime?.expectedNativeSessionId ||
        runtime?.expectedEmptyNativeSession ||
        runtime?.allowedPreMaterializationNativeIdentity ||
        runtime?.allowedAdditionalNativeIdentities?.length
      );
      const currentNativeIdentity = requiresNativeIdentity
        ? await resolveCurrentNativeAgentSessionIdentity({
            options,
            agent,
            pid,
            cwd: snapshot.cwd ?? resolvedTerminal.route.currentPath,
            preferredSessionId:
              runtime?.allowedPreMaterializationNativeIdentity &&
                (runtime.expectedNativeSessionId ?? runtime.nativeSessionId) &&
                runtime.allowedPreMaterializationNativeIdentity.sessionId !==
                  (runtime.expectedNativeSessionId ?? runtime.nativeSessionId)
                ? (runtime.expectedNativeSessionId ?? runtime.nativeSessionId)
                : undefined,
            allowedCompanionIdentity:
              runtime?.allowedPreMaterializationNativeIdentity,
            allowedAdditionalIdentities:
              runtime?.allowedAdditionalNativeIdentities
          })
        : undefined;
      terminalDispatchExecution(options).assertRuntimeIdentity({
        runtime,
        currentIdentity: currentNativeIdentity,
        agent,
        pid
      });
      if (runtime?.requireExactClaudeAgentRow === true) {
        if (
          agent !== "claude" ||
          !Number.isSafeInteger(runtime.nativeProcessStartedAt) ||
          Number(runtime.nativeProcessStartedAt) <= 0 ||
          !runtime.nativeSessionId
        ) {
          throw new Error(
            `native ${agent} inspection has an incomplete exact process identity; ` +
            "refresh list before controlling the terminal"
          );
        }
        const agentRows = loadClaudeAgentRows(options, { required: true });
        const observation = adapter.observeThreadLifecycle?.({
          operation: { kind: "new_thread" },
          phase: "before",
          pid,
          processStartedAt: runtime.nativeProcessStartedAt,
          cwd: snapshot.cwd ?? resolvedTerminal.route.currentPath,
          agentRows
        });
        const exactRows = agentRows.filter((row) => row.pid === pid);
        const expectedState = runtime.exactClaudeAgentState ?? "idle";
        const stateMatches = expectedState === "idle"
          ? observation?.idle === true
          : (
              observation?.idle === false &&
              exactRows.length === 1 &&
              exactRows[0].status === "waiting" &&
              exactRows[0].waitingFor === "dialog open"
            );
        if (
          observation?.status !== "observed" ||
          !stateMatches ||
          observation.nativeThreadId !== runtime.nativeSessionId
        ) {
          throw new Error(
            `native Claude agents identity, cwd, or idle state changed for process ${pid}; ` +
            "refresh list before controlling the terminal"
          );
        }
      }
      return {
        terminalControl: terminalProvider.toControlRef(
          resolvedTerminal,
          terminalControl.capabilities
        )
      };
    }
  });
}

function terminalControlFromTakeover(nativeTakeover): TerminalControlRef | undefined {
  if (!isRecord(nativeTakeover)) {
    return undefined;
  }
  const terminalControl = nativeTakeover["terminal_control"];
  if (
    !isRecord(terminalControl) ||
    !(terminalControl.kind === "tmux" || terminalControl.kind === "herdr")
  ) {
    return undefined;
  }
  const target = stringValue(terminalControl.target);
  const session = stringValue(terminalControl.session);
  const panePid = Number(terminalControl.panePid);
  if (!target || !session || !Number.isSafeInteger(panePid) || panePid <= 0) {
    return undefined;
  }
  const storedCapabilities = Array.isArray(terminalControl.capabilities)
    ? terminalControl.capabilities.filter(isTerminalControlCapability)
    : [];
  const capabilities = storedCapabilities.length > 0
    ? storedCapabilities
    : [...TERMINAL_CONTROL_CAPABILITIES];
  let control: TerminalControlRef;
  if (terminalControl.kind === "tmux") {
    const window = Number(terminalControl.window);
    const pane = Number(terminalControl.pane);
    if (!Number.isInteger(window) || !Number.isInteger(pane)) {
      return undefined;
    }
    control = {
      kind: "tmux",
      target,
      session,
      window,
      pane,
      panePid,
      currentCommand: stringValue(terminalControl.currentCommand),
      currentPath: stringValue(terminalControl.currentPath),
      socketPath: stringValue(terminalControl.socketPath),
      // State written before adapter capabilities were persisted always represented Codex.
      capabilities
    };
  } else {
    const socketPath = stringValue(terminalControl.socketPath);
    const workspaceId = stringValue(terminalControl.workspaceId);
    const tabId = stringValue(terminalControl.tabId);
    const paneId = stringValue(terminalControl.paneId);
    const terminalId = stringValue(terminalControl.terminalId);
    if (!socketPath || !workspaceId || !tabId || !paneId || !terminalId) {
      return undefined;
    }
    control = {
      kind: "herdr",
      target,
      socketPath,
      session,
      sessionDir: stringValue(terminalControl.sessionDir),
      workspaceId,
      tabId,
      paneId,
      terminalId,
      panePid,
      currentCommand: stringValue(terminalControl.currentCommand),
      currentPath: stringValue(terminalControl.currentPath),
      capabilities
    };
  }
  const endpointEvidence = nativeTakeover["terminal_endpoint"];
  if (endpointEvidence !== undefined) {
    try {
      associateTerminalEndpointEvidence(control, endpointEvidence);
    } catch {
      return undefined;
    }
  }
  return control;
}

function terminalEndpointTakeoverFields(
  terminalControl: TerminalControlRef
): { terminal_control: TerminalControlRef; terminal_endpoint?: TerminalControlEvidence } {
  return {
    terminal_control: terminalControl,
    ...(hasCanonicalTerminalEndpoint(terminalControl)
      ? { terminal_endpoint: terminalControlEvidence(terminalControl) }
      : {})
  };
}

/**
 * Add canonical endpoint evidence to a verified v0.11.x Turn without changing
 * its public route-shaped terminal id or provider-owned control payload.
 * Callers must already hold the terminal, Store-writer, and Turn state locks.
 */
function refineTerminalTurnEndpoint({
  conversation,
  statePath,
  terminalControl
}: {
  conversation: Conversation;
  statePath: string;
  terminalControl: TerminalControlRef;
}): Conversation {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const storedControl = terminalControlFromTakeover(takeover);
  if (
    !takeover ||
    !storedControl ||
    takeover.terminal_endpoint !== undefined ||
    !hasCanonicalTerminalEndpoint(terminalControl)
  ) {
    return conversation;
  }
  if (!terminalControlsShareIncarnation(storedControl, terminalControl)) {
    throw new Error(
      `cannot refine Turn ${turnIdForConversation(conversation)} terminal ` +
      "endpoint after its terminal incarnation changed"
    );
  }
  const terminalEndpoint = terminalControlEvidence(terminalControl);
  // Validate that the additive evidence agrees with the exact legacy route
  // before making it durable. This also restores the in-memory association on
  // the old provider-owned control object.
  associateTerminalEndpointEvidence(storedControl, terminalEndpoint);
  const refined: Conversation = {
    ...conversation,
    native_session_takeover: {
      ...takeover,
      terminal_endpoint: terminalEndpoint
    }
  };
  saveState(statePath, refined);
  return refined;
}

function terminalRuntimeIdentityForConversation(
  conversation: Conversation,
  terminalControl: TerminalControlRef
): TerminalRuntimeIdentity {
  const runtime = terminalRuntimeIdentityBase(conversation, terminalControl);
  if (executorForConversation(conversation).kind !== "codex") {
    return runtime;
  }
  const storeDir = managedSessionStoreDirForConversation(conversation);
  if (!storeDir) {
    return runtime;
  }
  const managedSession = tryLoadManagedSession(
    storeDir,
    sessionIdForConversation(conversation)
  );
  const binding = managedSession?.binding;
  const expectedThreadId = runtime.nativeSessionId ??
    runtime.expectedNativeSessionId;
  if (
    !managedSession ||
    managedSession.agent !== "codex" ||
    managedSession.status !== "bound" ||
    !binding ||
    binding.binding_id !== stringValue(conversation.terminal_binding_id) ||
    binding.generation !== Number(conversation.terminal_binding_generation) ||
    binding.native_thread_id !== expectedThreadId ||
    binding.native_process.pid !== runtime.pid ||
    !terminalControlsShareIncarnation(binding.terminal_control, terminalControl)
  ) {
    return runtime;
  }
  return withCodexCompanionFences(
    runtime,
    codexAllowedCompanionSetForManagedSession({
      storeDir,
      session: managedSession
    })
  );
}

function terminalDurableRequestForConversation(
  conversation,
  terminalControl: TerminalControlRef
): TerminalDurableCompletionRequest {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const runtime = terminalRuntimeIdentityForConversation(conversation, terminalControl);
  const requestText = String(
    nativeTakeover?.terminal_bridge_request_text ?? conversation?.user_request ?? ""
  );
  return {
    sessionId: runtime.sessionId,
    cwd: stringValue(nativeTakeover?.source_cwd),
    requestText,
    requestHash: stringValue(nativeTakeover?.terminal_bridge_request_hash),
    startedAt: stringValue(nativeTakeover?.terminal_bridge_started_at),
    context: {
      conversation,
      nativeTakeover,
      ...runtime
    }
  };
}

async function migrateLegacyTerminalAgentIdentity({
  conversation,
  statePath,
  logPath,
  options
}) {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (!nativeTakeover || !terminalControl) {
    return conversation;
  }
  const runtime = terminalRuntimeIdentityForConversation(conversation, terminalControl);
  if (Number.isInteger(runtime.pid) && Number(runtime.pid) > 0) {
    return conversation;
  }

  const executor = executorForConversation(conversation);
  const nativeSessionId = stringValue(nativeTakeover.native_session_id);
  if (
    executor.kind !== "codex" ||
    !nativeSessionId ||
    parseTerminalConversationId(nativeSessionId)
  ) {
    return conversation;
  }

  let matchedProcess: ActiveTerminalProcess | undefined;
  try {
    const registry = createRuntimeTerminalAgentRegistry(options);
    const adapter = registry.require("codex");
    const snapshots = await createTerminalProcessSource(options).listProcessSnapshots(
      (snapshot) => adapter.classifyProcess(snapshot) !== undefined,
      { includeAncestors: true }
    );
    const terminalProvider = createTerminalControlProvider(options);
    const resolvedTerminal = await terminalProvider.resolve(
      terminalProvider.endpoint(terminalControl)
    );

    const candidates = snapshots.flatMap((snapshot): ActiveTerminalProcess[] => {
      const classified = adapter.classifyProcess(snapshot);
      return classified ? [{ ...classified, agent: "codex" }] : [];
    });
    const matches = candidates.filter((candidate) =>
      candidate.sessionId === nativeSessionId &&
      terminalProvider.containsProcess(resolvedTerminal, candidate, snapshots)
    );
    if (matches.length !== 1) {
      return conversation;
    }
    matchedProcess = matches[0];
  } catch (error) {
    runtimeLog("warn", "legacy_terminal_agent_identity_migration_failed", {
      conversation_id: conversation.conversation_id,
      terminal_target: terminalControl.target,
      reason: error instanceof Error ? error.message : String(error)
    });
    return conversation;
  }
  if (!matchedProcess) {
    return conversation;
  }

  const releaseLock = acquireFileLock(`${statePath}.lock`);
  let migratedConversation = conversation;
  let migrated = false;
  try {
    const current = loadState(statePath);
    const currentTakeover = isRecord(current.native_session_takeover)
      ? current.native_session_takeover
      : undefined;
    const currentControl = terminalControlFromTakeover(currentTakeover);
    if (!currentTakeover || !currentControl) {
      return current;
    }
    const currentRuntime = terminalRuntimeIdentityForConversation(current, currentControl);
    if (Number.isInteger(currentRuntime.pid) && Number(currentRuntime.pid) > 0) {
      return current;
    }
    if (
      currentTakeover.native_session_id !== nativeSessionId ||
      !terminalControlsShareIncarnation(currentControl, terminalControl)
    ) {
      return current;
    }

    const migratedAt = cliNow().toISOString();
    migratedConversation = {
      ...current,
      native_session_takeover: {
        ...currentTakeover,
        terminal_agent_pid: matchedProcess.pid,
        terminal_agent_session_id: matchedProcess.sessionId,
        terminal_agent_identity_migrated_at: migratedAt
      },
      updated_at: migratedAt
    };
    saveState(statePath, migratedConversation);
    migrated = true;
  } finally {
    releaseLock();
  }

  if (migrated) {
    appendEvent(logPath, {
      ts: cliNow().toISOString(),
      conversation_id: migratedConversation.conversation_id,
      event: "terminal_agent_identity_migrated",
      terminal_target: terminalControl.target,
      terminal_agent_pid: matchedProcess.pid,
      native_session_id: nativeSessionId
    });
    runtimeLog("info", "terminal_agent_identity_migrated", {
      conversation_id: migratedConversation.conversation_id,
      terminal_target: terminalControl.target,
      terminal_agent_pid: matchedProcess.pid
    });
  }
  return migratedConversation;
}

function isTerminalControlCapability(value: unknown): value is TerminalControlCapability {
  return typeof value === "string" &&
    TERMINAL_CONTROL_CAPABILITIES.has(value as TerminalControlCapability);
}

function assertSafeAbortedTerminalRetryBinding({
  owner,
  receipt,
  storeDir,
  terminalControl,
  messageId
}: {
  owner: Conversation;
  receipt: Record<string, any>;
  storeDir: string;
  terminalControl: TerminalControlRef;
  messageId: string;
}): ManagedSessionState | undefined {
  if (!(receipt.status === "aborted" && receipt.safe_to_retry === true)) {
    return undefined;
  }
  const sessionId = sessionIdForConversation(owner);
  const managedSession = tryLoadManagedSession(storeDir, sessionId);
  const binding = managedSession?.binding;
  const receiptBindingId = stringValue(receipt.binding_id);
  const receiptBindingGeneration = Number(receipt.binding_generation);
  const receiptNativeThreadId = stringValue(receipt.native_thread_id);
  const ownerTakeover = isRecord(owner.native_session_takeover)
    ? owner.native_session_takeover
    : undefined;
  const ownerControl = terminalControlFromTakeover(ownerTakeover);
  const ownerNativeThreadId = stringValue(owner.native_thread_id) ??
    stringValue(ownerTakeover?.terminal_agent_session_id) ??
    stringValue(ownerTakeover?.terminal_agent_expected_session_id);
  const ownerAgentPid = Number(ownerTakeover?.terminal_agent_pid);
  if (
    managedSession &&
    managedSession.status === "bound" &&
    binding &&
    receiptBindingId &&
    Number.isSafeInteger(receiptBindingGeneration) &&
    receiptNativeThreadId &&
    receiptBindingId === stringValue(owner.terminal_binding_id) &&
    receiptBindingGeneration === Number(owner.terminal_binding_generation) &&
    receiptNativeThreadId === ownerNativeThreadId &&
    binding.binding_id === receiptBindingId &&
    binding.generation === receiptBindingGeneration &&
    binding.native_thread_id === receiptNativeThreadId &&
    Number.isSafeInteger(ownerAgentPid) &&
    binding.native_process.pid === ownerAgentPid &&
    ownerControl &&
    terminalControlsShareIncarnation(ownerControl, terminalControl) &&
    terminalControlsShareIncarnation(binding.terminal_control, terminalControl)
  ) {
    return managedSession;
  }
  const recoveredSource = safeAbortedDeferredRetrySourceSession({
    owner,
    receipt,
    storeDir,
    terminalControl,
    messageId
  });
  if (!recoveredSource) {
    throw new Error(
      `terminal idempotency key ${messageId} belongs to a safe-aborted Turn ` +
      "whose Session binding is no longer current; no terminal input was sent"
    );
  }
  return recoveredSource;
}

function safeAbortedDeferredRetrySourceSession({
  owner,
  receipt,
  storeDir,
  terminalControl,
  messageId
}: {
  owner: Conversation;
  receipt: Record<string, any>;
  storeDir: string;
  terminalControl: TerminalControlRef;
  messageId: string;
}): ManagedSessionState | undefined {
  const takeover = isRecord(owner.native_session_takeover)
    ? owner.native_session_takeover
    : undefined;
  const transferId = stringValue(takeover?.deferred_foreground_transfer_id);
  const ownerControl = terminalControlFromTakeover(takeover);
  if (!transferId || !takeover || !ownerControl) {
    return undefined;
  }
  const transfer = loadDeferredForegroundTransfer(storeDir, transferId);
  const target = tryLoadManagedSession(storeDir, transfer.target_session_id);
  const source = tryLoadManagedSession(storeDir, transfer.source_session_id);
  const submission = terminalBridgeSubmission(owner);
  const matchingReceipts = terminalBridgeSubmissionReceipts(owner).filter(
    (candidate) => stringValue(candidate.message_id) === messageId
  );
  const canonical = pathsForConversation(owner.conversation_id, storeDir);
  const targetBinding = transfer.abort_target_after_binding;
  const sourceBinding = transfer.abort_source_after_binding;
  const transferDispatchStartedAt = stringValue(
    transfer.dispatch_started_at
  );
  const terminalInputNotStartedAt = stringValue(
    transfer.terminal_input_not_started_at
  );
  const abortedBeforeDispatchIntent =
    transfer.input_stage === "none" &&
    transferDispatchStartedAt === undefined &&
    terminalInputNotStartedAt === undefined;
  const dispatchIntentProvedNotStarted =
    transfer.input_stage === "dispatch_started" &&
    transferDispatchStartedAt !== undefined &&
    terminalInputNotStartedAt !== undefined &&
    validTimestampMs(transferDispatchStartedAt) &&
    validTimestampMs(terminalInputNotStartedAt) &&
    Date.parse(terminalInputNotStartedAt) >=
      Date.parse(transferDispatchStartedAt);
  const forbiddenInputEvidence = TERMINAL_INPUT_EVIDENCE_FIELDS;
  if (
    transfer.version !== 2 ||
    transfer.status !== "abort_resolved" ||
    (!abortedBeforeDispatchIntent && !dispatchIntentProvedNotStarted) ||
    transfer.text_injected_at !== undefined ||
    transfer.enter_dispatched_at !== undefined ||
    transfer.agent_accepted_at !== undefined ||
    transfer.target_session_id !== sessionIdForConversation(owner) ||
    transfer.turn_id !== turnIdForConversation(owner) ||
    transfer.turn_id !== owner.conversation_id ||
    transfer.message_id !== messageId ||
    transfer.terminal_id !== stringValue(takeover.native_session_id) ||
    transfer.process_pid !== Number(takeover.terminal_agent_pid) ||
    transfer.process_uuid !== stringValue(
      takeover.terminal_agent_process_uuid
    ) ||
    transfer.process_birth !== stringValue(
      takeover.terminal_agent_process_birth
    ) ||
    path.resolve(transfer.workspace) !== path.resolve(owner.workspace) ||
    !terminalControlsShareIncarnation(ownerControl, terminalControl) ||
    !terminalControlEvidenceMatches(
      transfer.terminal_endpoint,
      terminalControl
    ) ||
    owner.status !== "failed" ||
    isRecord(owner.callback_delivery) ||
    isRecord(owner.terminal_bridge_completion_claim) ||
    isRecord(takeover.terminal_bridge_completion_claim) ||
    stringValue(takeover.terminal_bridge_message_id) !== messageId ||
    stringValue(takeover.terminal_bridge_request_hash) !==
      transfer.request_hash ||
    stringValue(takeover.terminal_bridge_request_hash) !==
      stringValue(receipt.request_hash) ||
    stringValue(takeover.deferred_foreground_transfer_id) !==
      transfer.transfer_id ||
    path.resolve(stringValue(owner.state_path) ?? "") !==
      path.resolve(canonical.statePath) ||
    path.resolve(stringValue(owner.event_log_path) ?? "") !==
      path.resolve(canonical.logPath) ||
    path.resolve(managedSessionStoreDirForConversation(owner) ?? "") !==
      path.resolve(storeDir) ||
    !submission ||
    matchingReceipts.length !== 1 ||
    canonicalJson(matchingReceipts[0]) !== canonicalJson(submission) ||
    canonicalJson(submission) !== canonicalJson(receipt) ||
    submission.status !== "aborted" ||
    submission.safe_to_retry !== true ||
    stringValue(submission.last_proven_stage) !== "prepared" ||
    !validTimestampMs(submission.prepared_at) ||
    !validTimestampMs(submission.aborted_at) ||
    Date.parse(String(submission.aborted_at)) <
      Date.parse(String(submission.prepared_at)) ||
    (
      dispatchIntentProvedNotStarted &&
      stringValue(submission.aborted_at) !== terminalInputNotStartedAt
    ) ||
    forbiddenInputEvidence.some((field) => submission[field] !== undefined) ||
    stringValue(submission.session_id) !== transfer.target_session_id ||
    stringValue(submission.turn_id) !== transfer.turn_id ||
    stringValue(submission.message_id) !== transfer.message_id ||
    stringValue(submission.request_hash) !== transfer.request_hash ||
    stringValue(submission.binding_id) !==
      transfer.target_before_binding?.binding_id ||
    Number(submission.binding_generation) !==
      transfer.target_before_binding?.generation ||
    stringValue(submission.native_thread_id) !== undefined ||
    !target ||
    target.status !== "detached" ||
    target.last_transition_id !== transfer.transfer_id ||
    target.lineage.transition_id !== transfer.transfer_id ||
    target.lineage.previous_session_id !== transfer.source_session_id ||
    transfer.abort_target_after_status !== "detached" ||
    !targetBinding ||
    managedSessionRevision(target) !== transfer.abort_target_after_revision ||
    managedSessionBindingToken(target) !==
      transfer.abort_target_after_binding_token ||
    JSON.stringify(target.binding) !== JSON.stringify(targetBinding) ||
    !source ||
    source.status !== "bound" ||
    source.last_transition_id !== transfer.source_previous_last_transition_id ||
    transfer.abort_source_after_status !== "bound" ||
    !sourceBinding ||
    managedSessionRevision(source) !== transfer.abort_source_after_revision ||
    managedSessionBindingToken(source) !==
      transfer.abort_source_after_binding_token ||
    JSON.stringify(source.binding) !== JSON.stringify(sourceBinding) ||
    JSON.stringify(sourceBinding) !==
      JSON.stringify(transfer.source_before_binding)
  ) {
    return undefined;
  }
  const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
  if (!ledger) {
    return undefined;
  }
  deferredRecoveryAdapter.assertDeferredForegroundResolvedZeroInputLedger(
    deferredForegroundRecoveryAdapterPorts(), {
    storeDir,
    terminal: { terminalControl },
    transfer,
    ledger,
    statePath: canonical.statePath
  });
  if (
    dispatchIntentProvedNotStarted &&
    stringValue(ledger.aborted_at) !== terminalInputNotStartedAt
  ) {
    return undefined;
  }
  return source;
}

function exactSafeAbortedRecoveredSessionMatches({
  owner,
  receipt,
  storeDir,
  terminalControl,
  messageId,
  expectedSessionId
}: {
  owner: Conversation;
  receipt?: Record<string, any>;
  storeDir: string;
  terminalControl: TerminalControlRef;
  messageId: string;
  expectedSessionId: string;
}): boolean {
  const exactReceipt = receipt ?? (() => {
    const matches = terminalBridgeSubmissionReceipts(owner).filter(
      (candidate) => stringValue(candidate.message_id) === messageId
    );
    return matches.length === 1 ? matches[0] : undefined;
  })();
  if (
    !exactReceipt ||
    exactReceipt.status !== "aborted" ||
    exactReceipt.safe_to_retry !== true
  ) {
    return false;
  }
  const recoveredSession = assertSafeAbortedTerminalRetryBinding({
    owner,
    receipt: exactReceipt,
    storeDir,
    terminalControl,
    messageId
  });
  return recoveredSession?.session_id === expectedSessionId;
}

function stableDelegateTerminalRoute({
  options,
  request,
  workspace,
  requestedAgent
}: {
  options: Record<string, any>;
  request: string;
  workspace?: string;
  requestedAgent?: ExecutorKind;
}):
  | { kind: "terminal"; conversationId: string; workspace: string }
  | { kind: "session"; sessionId: string; workspace: string }
  | undefined {
  const messageId = stringValue(options.messageId);
  if (!messageId) {
    return undefined;
  }
  const storeDir = path.resolve(storeDirFromOptions(options));
  const requestHash = terminalBridgeRequestFingerprint(
    terminalSubmissionPayload(request)
  );
  const bodyHash = createHash("sha256").update(request).digest("hex");
  const requestedOpenClawSession = stringValue(options.openclawSession);
  const matches = listConversations(storeDir).flatMap((owner) =>
    terminalBridgeSubmissionReceipts(owner)
      .filter((receipt) => stringValue(receipt.message_id) === messageId)
      .map((receipt) => ({ owner, receipt }))
  );
  if (matches.length === 0) {
    return undefined;
  }
  const routed = matches.map(({ owner, receipt }) => {
    const ownerStoreDir = managedSessionStoreDirForConversation(owner);
    const takeover = isRecord(owner.native_session_takeover)
      ? owner.native_session_takeover
      : undefined;
    const terminalControl = terminalControlFromTakeover(takeover);
    const conversationId = stringValue(takeover?.native_session_id);
    let eventMessages: Record<string, any>[] = [];
    const eventLogPath = stringValue(owner.event_log_path);
    if (eventLogPath) {
      try {
        eventMessages = readNdjsonLog(eventLogPath)
          .filter((event) =>
            isRecord(event.message) && event.message.id === messageId
          )
          .map((event) => event.message as Record<string, any>);
      } catch {
        eventMessages = [];
      }
    }
    if (eventMessages.length > 1) {
      throw new Error(
        `terminal idempotency key ${messageId} has duplicate durable messages`
      );
    }
    const eventMessage = eventMessages[0];
    const messageType = stringValue(receipt.message_type) ??
      (isRecord(eventMessage) ? stringValue(eventMessage.type) : undefined);
    const storedBodyHash = stringValue(receipt.message_body_hash) ??
      (isRecord(eventMessage) && typeof eventMessage.body === "string"
        ? createHash("sha256").update(eventMessage.body).digest("hex")
        : undefined);
    const ownerWorkspace = canonicalWorkspace(owner.workspace);
    if (
      !ownerStoreDir ||
      path.resolve(ownerStoreDir) !== storeDir ||
      (stringValue(receipt.store_dir) !== undefined &&
        path.resolve(String(receipt.store_dir)) !== storeDir) ||
      !terminalControl ||
      !conversationId ||
      stringValue(receipt.request_hash) !== requestHash ||
      messageType !== "task" ||
      storedBodyHash !== bodyHash ||
      (requestedOpenClawSession &&
        (stringValue(receipt.openclaw_session) ?? owner.openclaw_session) !==
          requestedOpenClawSession) ||
      (requestedAgent && executorForConversation(owner).kind !== requestedAgent) ||
      (workspace && ownerWorkspace !== workspace)
    ) {
      throw new Error(
        `terminal idempotency key ${messageId} does not match its original ` +
        "delegate request boundary; no terminal input was sent"
      );
    }
    return {
      owner,
      receipt,
      conversationId,
      workspace: ownerWorkspace,
      terminalControl
    };
  });
  const authoritative = routed.filter(({ receipt }) =>
    !(receipt.status === "aborted" && receipt.safe_to_retry === true)
  );
  if (authoritative.length > 1) {
    throw new Error(
      `terminal idempotency key ${messageId} has multiple durable delegate receipts`
    );
  }
  const firstRoute = routed[0];
  if (
    !firstRoute ||
    routed.some((entry) =>
      entry.conversationId !== firstRoute.conversationId ||
      !terminalControlsShareIncarnation(
        entry.terminalControl,
        firstRoute.terminalControl
      )
    )
  ) {
    throw new Error(
      `terminal idempotency key ${messageId} has conflicting terminal routes`
    );
  }
  const selected = authoritative[0] ?? routed.at(-1);
  if (!selected) {
    return undefined;
  }
  if (
    selected.receipt.status === "aborted" &&
    selected.receipt.safe_to_retry === true
  ) {
    const ownerControl = terminalControlFromTakeover(
      isRecord(selected.owner.native_session_takeover)
        ? selected.owner.native_session_takeover
        : undefined
    );
    if (!ownerControl) {
      throw new Error(
        `terminal idempotency key ${messageId} has no durable terminal route`
      );
    }
    const retrySession = assertSafeAbortedTerminalRetryBinding({
      owner: selected.owner,
      receipt: selected.receipt,
      storeDir,
      terminalControl: ownerControl,
      messageId
    });
    if (!retrySession) {
      throw new Error(
        `terminal idempotency key ${messageId} has no restored retry Session`
      );
    }
    if (
      retrySession.agent === "codex" &&
      isCompleteNativeRollout(retrySession.binding?.native_process.rollout)
    ) {
      // A safe-aborted retry has proved that the original binding is unchanged,
      // but one open Codex rollout still does not prove the TUI foreground.
      // Preserve the stable terminal route so runSend captures fresh implicit
      // candidate authority and retries through the v3 transfer instead of the
      // forbidden strict Session path.
      return {
        kind: "terminal",
        conversationId: selected.conversationId,
        workspace: selected.workspace
      };
    }
    return {
      kind: "session",
      sessionId: retrySession.session_id,
      workspace: selected.workspace
    };
  }
  return {
    kind: "terminal",
    conversationId: selected.conversationId,
    workspace: selected.workspace
  };
}

async function runDelegate(options) {
  const request = required(options.request, "--request is required");
  const workspace = options.workspace === undefined
    ? undefined
    : canonicalWorkspace(options.workspace);
  const requestedAgent = options.agent === undefined
    ? undefined
    : resolveExecutor({ kind: options.agent }).kind;
  const stableRoute = stableDelegateTerminalRoute({
    options,
    request,
    workspace,
    requestedAgent
  });
  if (stableRoute) {
    await terminalCommandCliFacade.runSend(stableRoute.kind === "session"
      ? {
          ...options,
          session: stableRoute.sessionId,
          conversation: undefined,
          message: request,
          workspace: stableRoute.workspace,
          background: true
        }
      : {
          ...options,
          conversation: stableRoute.conversationId,
          session: undefined,
          message: request,
          workspace: stableRoute.workspace,
          background: true
        });
    return;
  }
  const scan = await terminalListCliFacade.buildTerminalListGroup({
    options: {
      ...options,
      workspace,
      noApprovalScan: false
    },
    agentFilter: requestedAgent,
    statusFilter: undefined
  });
  if (scan.summary.error) {
    throw new Error(`terminal discovery failed: ${scan.summary.error}`);
  }

  const scopedCandidates = workspace === undefined
    ? scan.terminalControlled
    : scan.terminalControlled.filter((candidate) => {
        try {
          return canonicalWorkspace(candidate.workspace) === workspace;
        } catch {
          return false;
        }
      });
  const eligible = scopedCandidates.filter((candidate) => {
    if (candidate.activity_state !== "idle") {
      return false;
    }
    const terminalControl = isRecord(candidate.terminal_control)
      ? candidate.terminal_control as unknown as TerminalControlRef
      : undefined;
    return !terminalControl || terminalListCliFacade.terminalDispatchOwnership(terminalControl).state === "none";
  });
  if (eligible.length === 0) {
    const observed = scopedCandidates.length > 0
      ? ` Found ${scopedCandidates.length} matching pane(s), but none is idle.`
      : "";
    const requestedExecutor = requestedAgent
      ? executorDefinitionForKind(requestedAgent)
      : undefined;
    const workspaceDetail = workspace
      ? ` in ${workspace}`
      : "";
    throw new Error(
      `No idle ${requestedExecutor?.displayName ?? "Codex or Claude Code"} pane is available${workspaceDetail}.${observed} ` +
      `Start ${requestedAgent ?? "codex or claude"} inside tmux or Herdr${workspaceDetail}, wait until it is idle, then retry.`
    );
  }
  if (eligible.length > 1) {
    const candidates = eligible
      .map((candidate) => {
        const identity =
          `${candidate.agent}, ${candidate.terminal_control?.target ?? candidate.id}`;
        return workspace
          ? `${candidate.short_ref} (${identity})`
          : `${candidate.short_ref} (${identity}, ${candidate.workspace ?? "workspace unknown"})`;
      })
      .join(", ");
    const scope = requestedAgent
      ? executorDefinitionForKind(requestedAgent).displayName
      : "coding-agent";
    const ambiguity = workspace
      ? `match ${workspace}`
      : "are available across workspaces";
    throw new Error(
      `Multiple idle ${scope} panes ${ambiguity}: ${candidates}. ` +
      "Use /akk codex: <task>, /akk claude: <task>, or /akk @short-ref: <message> to choose one explicitly."
    );
  }

  const selectedWorkspace = canonicalWorkspace(eligible[0].workspace);
  await terminalCommandCliFacade.runSend({
    ...options,
    conversation: eligible[0].id,
    message: request,
    workspace: selectedWorkspace,
    background: true
  });
}

function spawnDetachedTerminalMonitor(
  plan?: monitorLaunch.DetachedTerminalMonitorPlan
) {
  if (!plan) {
    return undefined;
  }
  const child = spawn(process.execPath, plan.args, {
    detached: true,
    stdio: "ignore",
    cwd: cliCwd(),
    env: plan.environment
  });
  child.unref();
  return child;
}

function startTerminalBridgeMonitorForConversation({ conversation, statePath, logPath, options }) {
  return spawnDetachedTerminalMonitor(
    monitorLaunch.planLaunch({
      conversation,
      statePath,
      logPath,
      options,
      entryPath: cliEntryPath(),
      environment: cliEnv()
    })
  );
}

function ensureTerminalBridgeMonitorAfterApproval({
  conversation,
  statePath,
  logPath,
  terminalControl,
  options,
  reason = "approval_resolved"
}) {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalMessageId = stringValue(
    nativeTakeover?.terminal_bridge_message_id
  );
  const activeMonitor = terminalMessageId
    ? activeTerminalBridgeMonitorOwner(statePath, terminalMessageId)
    : undefined;
  const launchPlan = monitorLaunch.planAfterApproval({
    conversation,
    statePath,
    logPath,
    options,
    entryPath: cliEntryPath(),
    environment: cliEnv(),
    activeMonitorPresent: activeMonitor !== undefined
  });
  const launchedMonitor = spawnDetachedTerminalMonitor(launchPlan.monitor);
  const handoffWatchdog = spawnDetachedTerminalMonitor(launchPlan.handoff);
  const monitorPid = activeMonitor?.ownerPid ?? launchedMonitor?.pid;
  const { agentTimeoutMinutes, agentHardTimeoutMinutes } =
    monitorLaunch.terminalMonitorTimeoutPlan({ conversation, options });
  if (activeMonitor) {
    appendEvent(logPath, {
      ts: cliNow().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_monitor_reused",
      pid: activeMonitor.ownerPid ?? null,
      terminal_control: terminalControl,
      reason,
      agent_timeout_minutes: agentTimeoutMinutes,
      agent_hard_timeout_minutes: agentHardTimeoutMinutes
    });
    runtimeLog("info", "terminal_bridge_monitor_reused", {
      conversation_id: conversation.conversation_id,
      monitor_pid: activeMonitor.ownerPid ?? null,
      terminal_target: terminalControl.target,
      reason
    });
    if (handoffWatchdog) {
      appendEvent(logPath, {
        ts: cliNow().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_monitor_handoff_watchdog_launch",
        pid: handoffWatchdog.pid ?? null,
        monitor_owner_pid: activeMonitor.ownerPid ?? null,
        terminal_bridge_message_id: terminalMessageId,
        terminal_control: terminalControl,
        reason
      });
      runtimeLog("info", "terminal_bridge_monitor_handoff_watchdog_launch", {
        conversation_id: conversation.conversation_id,
        watchdog_pid: handoffWatchdog.pid ?? null,
        monitor_owner_pid: activeMonitor.ownerPid ?? null,
        terminal_target: terminalControl.target,
        reason
      });
    }
  } else if (launchedMonitor) {
    appendEvent(logPath, {
      ts: cliNow().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_monitor_launch",
      pid: launchedMonitor.pid ?? null,
      terminal_control: terminalControl,
      reason,
      agent_timeout_minutes: agentTimeoutMinutes,
      agent_hard_timeout_minutes: agentHardTimeoutMinutes
    });
    runtimeLog("info", "terminal_bridge_monitor_launch", {
      conversation_id: conversation.conversation_id,
      monitor_pid: launchedMonitor.pid ?? null,
      terminal_target: terminalControl.target,
      reason
    });
  }
  return {
    activeMonitor,
    launchedMonitor,
    handoffWatchdog,
    monitorPid
  };
}

const terminalBridgeEnabled = dispatchReceipt.terminalBridgeEnabled;

function withTerminalBridgeSubmission(
  mutation: dispatchReceipt.TerminalBridgeSubmissionMutation
): Conversation {
  const takeover = isRecord(mutation.conversation.native_session_takeover)
    ? mutation.conversation.native_session_takeover
    : undefined;
  return dispatchReceipt.applyTerminalBridgeSubmission(mutation, {
    dispatcherPid: cliPid(),
    storeDir: managedSessionStoreDirForConversation(mutation.conversation),
    terminalControl: terminalControlFromTakeover(takeover)
  });
}

const terminalAcceptanceEvidenceForConversation =
  dispatchReceipt.terminalAcceptanceEvidenceForConversation;
const terminalBridgeSubmission = dispatchReceipt.terminalBridgeSubmission;
const terminalBridgeSubmissionReceipts =
  dispatchReceipt.terminalBridgeSubmissionReceipts;

function stallOtherTerminalBridgeConversationsForUncertainDispatch({
  storeDir,
  terminalControl,
  currentConversationId,
  uncertainMessageId
}: {
  storeDir: string;
  terminalControl: TerminalControlRef;
  currentConversationId: string;
  uncertainMessageId: string;
}): string[] {
  const stalledConversationIds: string[] = [];
  for (const listed of listConversations(storeDir)) {
    if (
      listed.conversation_id === currentConversationId ||
      !SESSION_SEND_BLOCKING_STATUSES.has(listed.status)
    ) {
      continue;
    }
    const listedTakeover = isRecord(listed.native_session_takeover)
      ? listed.native_session_takeover
      : undefined;
    if (
      listedTakeover?.terminal_bridge !== true ||
      !terminalControlsShareIncarnation(
        terminalControlFromTakeover(listedTakeover),
        terminalControl
      )
    ) {
      continue;
    }
    const listedStatePath = stringValue(listed.state_path);
    if (!listedStatePath) {
      continue;
    }
    const releaseStateLock = acquireFileLock(`${listedStatePath}.lock`);
    try {
      const current = loadState(listedStatePath);
      const currentTakeover = isRecord(current.native_session_takeover)
        ? current.native_session_takeover
        : undefined;
      if (
        !SESSION_SEND_BLOCKING_STATUSES.has(current.status) ||
        currentTakeover?.terminal_bridge !== true ||
        !terminalControlsShareIncarnation(
          terminalControlFromTakeover(currentTakeover),
          terminalControl
        )
      ) {
        continue;
      }
      const stalledAt = cliNow().toISOString();
      const stalledConversation = {
        ...current,
        status: "stalled" as const,
        stalled_at: stalledAt,
        stalled_reason: TERMINAL_BRIDGE_UNCERTAIN_COLLATERAL_STALL_REASON,
        native_session_takeover: {
          ...currentTakeover,
          terminal_bridge_uncertain_dispatch_fence: {
            message_id: uncertainMessageId,
            observed_at: stalledAt,
            previous_status: current.status
          }
        },
        updated_at: stalledAt
      };
      saveState(listedStatePath, stalledConversation);
      try {
        appendEvent(logPathForStatePath(listedStatePath), {
          ts: stalledAt,
          conversation_id: current.conversation_id,
          event: "terminal_bridge_stalled_by_uncertain_dispatch",
          terminal_control: terminalControl,
          uncertain_message_id: uncertainMessageId
        });
      } catch {
        // The stalled state and terminal-level ledger are the authoritative fence.
      }
      stalledConversationIds.push(current.conversation_id);
    } finally {
      releaseStateLock();
    }
  }
  return stalledConversationIds;
}

interface TerminalBridgeCollateralStallRepairEvidence {
  uncertainMessageId: string;
  ownerConversationId: string;
  restoredStatus: "idle";
}

function exactTerminalBridgeCollateralStallRepairEvidence({
  conversation,
  storeDir
}: {
  conversation: Conversation;
  storeDir: string;
}): TerminalBridgeCollateralStallRepairEvidence | undefined {
  if (
    conversation.status !== "stalled" ||
    conversation.stalled_reason !==
      TERMINAL_BRIDGE_UNCERTAIN_COLLATERAL_STALL_REASON
  ) {
    return undefined;
  }
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const fence = isRecord(
    takeover?.terminal_bridge_uncertain_dispatch_fence
  )
    ? takeover.terminal_bridge_uncertain_dispatch_fence
    : undefined;
  const uncertainMessageId = stringValue(fence?.message_id);
  const fenceObservedAt = stringValue(fence?.observed_at);
  const previousStatus = stringValue(fence?.previous_status);
  const ownMessageId = stringValue(takeover?.terminal_bridge_message_id);
  const ownSubmission = terminalBridgeSubmission(conversation);
  const completionClaim = isRecord(takeover?.terminal_bridge_completion_claim)
    ? takeover.terminal_bridge_completion_claim
    : undefined;
  const callbackDelivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const callbackMessage = isRecord(callbackDelivery?.message)
    ? callbackDelivery.message
    : undefined;
  const idleSince = stringValue(conversation.idle_since);
  const deliveredAt = stringValue(callbackDelivery?.delivered_at);
  const claimedAt = stringValue(completionClaim?.claimed_at);
  const fenceAtMs = validTimestampMs(fenceObservedAt);
  const idleAtMs = validTimestampMs(idleSince);
  const deliveredAtMs = validTimestampMs(deliveredAt);
  const claimedAtMs = validTimestampMs(claimedAt);
  if (
    takeover?.terminal_bridge !== true ||
    !uncertainMessageId ||
    !fenceObservedAt ||
    fenceAtMs === undefined ||
    uncertainMessageId === ownMessageId ||
    (previousStatus !== undefined && previousStatus !== "idle") ||
    conversation.stalled_at !== fenceObservedAt ||
    conversation.updated_at !== fenceObservedAt ||
    !idleSince ||
    idleAtMs === undefined ||
    idleAtMs > fenceAtMs ||
    !ownMessageId ||
    ownSubmission?.status !== "agent_accepted" ||
    stringValue(ownSubmission.message_id) !== ownMessageId ||
    stringValue(ownSubmission.session_id) !==
      sessionIdForConversation(conversation) ||
    stringValue(ownSubmission.turn_id) !== turnIdForConversation(conversation) ||
    !completionClaim ||
    stringValue(completionClaim.terminal_bridge_message_id) !== ownMessageId ||
    completionClaim.outcome !== "success" ||
    !claimedAt ||
    claimedAtMs === undefined ||
    claimedAtMs > fenceAtMs ||
    callbackDelivery?.status !== "delivered" ||
    callbackDelivery.final_status !== "idle" ||
    callbackDelivery.preserve_conversation_status !== true ||
    !callbackMessage ||
    callbackMessage.type !== "done" ||
    callbackMessage.requires_response !== false ||
    stringValue(callbackMessage.id) !==
      stringValue(completionClaim.callback_message_id) ||
    stringValue(callbackMessage.conversation_id) !==
      conversation.conversation_id ||
    stringValue(callbackMessage.session_id) !==
      sessionIdForConversation(conversation) ||
    stringValue(callbackMessage.turn_id) !== turnIdForConversation(conversation) ||
    stringValue(
      isRecord(callbackMessage.metadata)
        ? callbackMessage.metadata.terminal_bridge_message_id
        : undefined
    ) !== ownMessageId ||
    !deliveredAt ||
    deliveredAtMs === undefined ||
    deliveredAtMs > fenceAtMs
  ) {
    return undefined;
  }
  const control = terminalListCliFacade.terminalControlForManagedConversation(conversation);
  if (!control) {
    return undefined;
  }
  // The target state lock is already held by the caller. Rescan owner state
  // now instead of trusting the unlocked discovery snapshot used to find the
  // target candidate.
  const ownerCandidates = listConversations(storeDir).filter((candidate) => {
    if (candidate.conversation_id === conversation.conversation_id) {
      return false;
    }
    const candidateTakeover = isRecord(candidate.native_session_takeover)
      ? candidate.native_session_takeover
      : undefined;
    const candidateSubmission = terminalBridgeSubmission(candidate);
    return candidateTakeover?.terminal_bridge === true &&
      stringValue(candidateTakeover.terminal_bridge_message_id) ===
        uncertainMessageId &&
      stringValue(candidateSubmission?.message_id) === uncertainMessageId &&
      terminalControlsShareIncarnation(
        terminalListCliFacade.terminalControlForManagedConversation(candidate),
        control
      );
  });
  if (ownerCandidates.length !== 1) {
    return undefined;
  }
  const ownerListed = ownerCandidates[0];
  const ownerStatePath = stringValue(ownerListed.state_path);
  if (!ownerStatePath) {
    return undefined;
  }
  let owner: Conversation;
  let ownerEvents: Record<string, any>[];
  let events: Record<string, any>[];
  try {
    owner = loadState(ownerStatePath);
    ownerEvents = readNdjsonLog(
      stringValue(owner.event_log_path) ?? logPathForStatePath(ownerStatePath)
    );
    const statePath = stringValue(conversation.state_path);
    if (!statePath) {
      return undefined;
    }
    events = readNdjsonLog(
      stringValue(conversation.event_log_path) ??
        logPathForStatePath(statePath)
    );
  } catch {
    return undefined;
  }
  const ownerTakeover = isRecord(owner.native_session_takeover)
    ? owner.native_session_takeover
    : undefined;
  const ownerSubmission = terminalBridgeSubmission(owner);
  const ownerClosedAt = stringValue(owner.closed_at);
  const ownerClosedAtMs = validTimestampMs(ownerClosedAt);
  if (
    owner.conversation_id !== ownerListed.conversation_id ||
    owner.status !== "closed" ||
    !ownerClosedAt ||
    ownerClosedAtMs === undefined ||
    ownerClosedAtMs < fenceAtMs ||
    !stringValue(owner.close_reason) ||
    owner.updated_at !== ownerClosedAt ||
    ownerTakeover?.terminal_bridge !== true ||
    stringValue(ownerTakeover.terminal_bridge_message_id) !==
      uncertainMessageId ||
    ownerSubmission?.status !== "uncertain" ||
    stringValue(ownerSubmission.message_id) !== uncertainMessageId ||
    stringValue(ownerSubmission.session_id) !== sessionIdForConversation(owner) ||
    stringValue(ownerSubmission.turn_id) !== turnIdForConversation(owner) ||
    isRecord(ownerTakeover.terminal_bridge_uncertain_dispatch_fence) ||
    !terminalControlsShareIncarnation(
      terminalListCliFacade.terminalControlForManagedConversation(owner),
      control
    )
  ) {
    return undefined;
  }
  const callbackMessageId = stringValue(callbackMessage.id) as string;
  const hasCompletionClaim = events.some((event) =>
    event.event === "terminal_bridge_completion_claimed" &&
    event.conversation_id === conversation.conversation_id &&
    event.terminal_bridge_message_id === ownMessageId &&
    event.callback_message_id === callbackMessageId &&
    event.completion_fingerprint === completionClaim.completion_fingerprint &&
    event.completion_id === completionClaim.completion_id &&
    event.outcome === "success" &&
    event.ts === claimedAt
  );
  const hasCompletionDetected = events.some((event) =>
    event.event === "terminal_bridge_completion_detected" &&
    event.conversation_id === conversation.conversation_id &&
    event.terminal_bridge_message_id === ownMessageId &&
    event.callback_message_id === callbackMessageId &&
    event.completion_id === completionClaim.completion_id &&
    event.completion_outcome === "success" &&
    validTimestampMs(event.ts) !== undefined &&
    (validTimestampMs(event.ts) as number) <= fenceAtMs
  );
  const hasDeliveredCallback = events.some((event) =>
    event.event === "callback_delivery_succeeded" &&
    event.conversation_id === conversation.conversation_id &&
    event.message_id === callbackMessageId &&
    event.status === "idle" &&
    event.ts === deliveredAt
  );
  const hasExactFence = events.some((event) =>
    event.event === "terminal_bridge_stalled_by_uncertain_dispatch" &&
    event.conversation_id === conversation.conversation_id &&
    event.uncertain_message_id === uncertainMessageId &&
    event.ts === fenceObservedAt
  );
  const hasExactOwnerClose = ownerEvents.some((event) =>
    event.event === "conversation_closed" &&
    event.conversation_id === owner.conversation_id &&
    event.status === "closed" &&
    event.ts === ownerClosedAt &&
    event.reason === owner.close_reason
  );
  if (
    !hasCompletionClaim ||
    !hasCompletionDetected ||
    !hasDeliveredCallback ||
    !hasExactFence ||
    !hasExactOwnerClose
  ) {
    return undefined;
  }
  return {
    uncertainMessageId,
    ownerConversationId: owner.conversation_id,
    restoredStatus: "idle"
  };
}

function reconcileTerminalBridgeCollateralStalls(
  storeDir: string,
  conversationId?: string
): {
  checked: number;
  repaired: number;
  skipped: number;
  errors: string[];
  items: Record<string, unknown>[];
} {
  const reservedSourceTurnIds = new Set(
    listDeferredForegroundTransfers(storeDir)
      .filter((transfer) =>
        transfer.version === 2 &&
        transfer.source_kind === "candidate_rollout_quiescent" &&
        !FINAL_DEFERRED_TRANSFER_STATUSES.has(transfer.status)
      )
      .flatMap((transfer) =>
        (transfer.source_turn_history ?? []).map((turn) => turn.turn_id)
      )
  );
  const candidates = listConversations(storeDir).filter((conversation) => {
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    return (
      conversationId === undefined ||
      conversation.conversation_id === conversationId
    ) &&
      !reservedSourceTurnIds.has(turnIdForConversation(conversation)) &&
      conversation.status === "stalled" &&
      isRecord(takeover?.terminal_bridge_uncertain_dispatch_fence);
  });
  let repaired = 0;
  let skipped = 0;
  const errors: string[] = [];
  const items: Record<string, unknown>[] = [];
  for (const listed of candidates) {
    const statePath = stringValue(listed.state_path);
    if (!statePath) {
      skipped += 1;
      continue;
    }
    let releaseStateLock: (() => void) | undefined;
    try {
      releaseStateLock = acquireFileLock(`${statePath}.lock`);
      const current = loadState(statePath);
      const evidence = exactTerminalBridgeCollateralStallRepairEvidence({
        conversation: current,
        storeDir
      });
      if (!evidence) {
        skipped += 1;
        continue;
      }
      const takeover = {
        ...(current.native_session_takeover as Record<string, any>)
      };
      delete takeover.terminal_bridge_uncertain_dispatch_fence;
      const repairedAt = cliNow().toISOString();
      takeover.terminal_bridge_collateral_stall_repair = {
        repaired_at: repairedAt,
        uncertain_message_id: evidence.uncertainMessageId,
        uncertain_owner_conversation_id: evidence.ownerConversationId,
        restored_status: evidence.restoredStatus,
        evidence:
          "foreign_uncertain_fence+completion_claim+delivered_callback+closed_owner"
      };
      const repairedConversation: Conversation = {
        ...current,
        status: evidence.restoredStatus,
        native_session_takeover: takeover,
        updated_at: repairedAt
      };
      delete repairedConversation.stalled_at;
      delete repairedConversation.stalled_reason;
      saveState(statePath, repairedConversation);
      let eventWarning: string | undefined;
      try {
        appendEvent(
          stringValue(current.event_log_path) ?? logPathForStatePath(statePath),
          {
            ts: repairedAt,
            conversation_id: current.conversation_id,
            event: "terminal_bridge_collateral_stall_repaired",
            uncertain_message_id: evidence.uncertainMessageId,
            uncertain_owner_conversation_id: evidence.ownerConversationId,
            previous_status: "stalled",
            restored_status: evidence.restoredStatus,
            evidence:
              "foreign_uncertain_fence+completion_claim+delivered_callback+closed_owner"
          }
        );
      } catch (error) {
        eventWarning = error instanceof Error ? error.message : String(error);
        runtimeLog("warn", "terminal_bridge_collateral_stall_repair_event_failed", {
          conversation_id: current.conversation_id,
          uncertain_message_id: evidence.uncertainMessageId,
          error: eventWarning
        });
      }
      repaired += 1;
      items.push({
        conversation_id: current.conversation_id,
        status: "repaired",
        reason: "legacy_terminal_bridge_collateral_stall",
        uncertain_message_id: evidence.uncertainMessageId,
        uncertain_owner_conversation_id: evidence.ownerConversationId,
        restored_status: evidence.restoredStatus,
        ...(eventWarning ? { event_warning: eventWarning } : {})
      });
    } catch (error) {
      skipped += 1;
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${listed.conversation_id}: ${reason}`);
      items.push({
        conversation_id: listed.conversation_id,
        status: "error",
        reason
      });
    } finally {
      releaseStateLock?.();
    }
  }
  return {
    checked: candidates.length,
    repaired,
    skipped,
    errors,
    items
  };
}


async function resolveTerminalConversationFromOptions(
  options
): Promise<ResolvedTerminalConversation | undefined> {
  return createTerminalAgentBridge(options).resolveConversationId(
    stringValue(
      options.session ??
      options.turn ??
      options.conversation ??
      options.conversationId
    )
  );
}

function exactLifecycleProcessIdentity(
  terminal: ResolvedTerminalConversation,
  identity: NativeAgentSessionIdentity
): NativeAgentSessionIdentity {
  if (terminal.agent === "claude") {
    if (!identity.processUuid) {
      throw new Error(
        `Claude lifecycle process incarnation is unavailable for pid ${terminal.pid}`
      );
    }
    return identity;
  }
  const processBirth = identity.processBirth ??
    codexProcessBirthForLifecycle(terminal.pid);
  const processUuid = identity.processUuid ??
    `codex-pid:${terminal.pid}:birth:${processBirth}`;
  return {
    ...identity,
    processBirth,
    processUuid
  };
}

function codexProcessBirthForLifecycle(pid: number): string {
  const injected = cliDependencies().codexProcessBirthForPid;
  if (injected) {
    return injected(pid);
  }
  const ps = resolveOptionalExecutable("ps");
  if (!ps) {
    throw new Error("cannot verify Codex process incarnation because ps is unavailable");
  }
  const result = spawnSync(ps, ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  const processBirth = String(result.stdout ?? "").trim();
  if (result.error || result.status !== 0 || !processBirth) {
    throw new Error(
      String(result.stderr ?? "").trim() ||
      result.error?.message ||
      `cannot verify Codex process incarnation for pid ${pid}`
    );
  }
  return processBirth;
}

function codexProcessIncarnationForPid(pid: number): {
  processUuid: string;
  processBirth: string;
  evidence: "codex_process_birth";
} {
  const processBirth = codexProcessBirthForLifecycle(pid);
  return {
    processUuid: `codex-pid:${pid}:birth:${processBirth}`,
    processBirth,
    evidence: "codex_process_birth"
  };
}

type DurableCompletionBeforeDeadStallObservation =
  VerifiedDeadAgentCompletionObservation<TerminalCompletionEvidence>;

function observeExactCodexDeadProcessRolloutCompletion({
  options,
  conversation,
  terminalControl
}: {
  options: Record<string, any>;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
}): DurableCompletionBeforeDeadStallObservation {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(conversation);
  const acceptanceEvidence = isRecord(submission?.acceptance_evidence)
    ? submission.acceptance_evidence
    : undefined;
  const anchor = isRecord(takeover?.codex_rollout_acceptance_anchor)
    ? takeover.codex_rollout_acceptance_anchor
    : undefined;
  if (
    submission?.status !== "agent_accepted" ||
    !requiresExactBoundCodexCompletion(conversation) ||
    acceptanceEvidence?.source !== "codex_rollout" ||
    !anchor
  ) {
    return {
      status: "unverifiable",
      reason: "Codex has no exact accepted rollout authority for the dead process"
    };
  }
  const runtime = terminalRuntimeIdentityForConversation(
    conversation,
    terminalControl
  );
  const nativeRollout = isRecord(runtime.nativeRollout)
    ? runtime.nativeRollout
    : undefined;
  const request = terminalDurableRequestForConversation(
    conversation,
    terminalControl
  );
  const result = detectCodexBoundRolloutCompletion({
    anchor: anchor as unknown as CodexRolloutAcceptanceAnchor,
    acceptanceEvidence:
      acceptanceEvidence as unknown as TerminalSubmissionAcceptanceEvidence,
    currentIdentity: {
      sessionId: runtime.nativeSessionId ?? runtime.sessionId ?? "",
      processUuid: runtime.nativeProcessUuid,
      processBirth: runtime.nativeProcessBirth,
      ...(nativeRollout
        ? {
            rollout: {
              fd: String(nativeRollout.fd ?? ""),
              device: String(nativeRollout.device ?? ""),
              inode: String(nativeRollout.inode ?? ""),
              path: String(nativeRollout.path ?? "")
            }
          }
        : {})
    },
    requestHash:
      stringValue(request.requestHash) ??
      stringValue(takeover?.terminal_bridge_request_hash) ??
      ""
  });
  if (result.status === "completed") {
    return {
      status: "present",
      completion: {
        ...result.completion,
        metadata: {
          ...result.completion.metadata,
          context_match: "exact_bound_rollout",
          detector_code: result.diagnostics.code
        }
      }
    };
  }
  if (
    result.status === "pending" &&
    result.diagnostics.code === "exact_turn_not_complete"
  ) {
    return { status: "absent" };
  }
  return {
    status: "unverifiable",
    reason:
      `[codex_exact_bound_rollout:${result.diagnostics.code}] ` +
      (result.diagnostics.detail ??
        "the exact bound rollout is not safely inspectable")
  };
}

async function observeDurableCompletionBeforeDeadStall({
  options,
  conversation,
  terminalControl
}: {
  options: Record<string, any>;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
}): Promise<DurableCompletionBeforeDeadStallObservation> {
  try {
    const executor = executorForConversation(conversation);
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    if (executor.kind === "claude") {
      const anchor = isRecord(takeover?.claude_transcript_anchor)
        ? takeover.claude_transcript_anchor
        : undefined;
      const pid = Number(anchor?.pid);
      const startedAt = Number(anchor?.agent_started_at_ms);
      const sessionId = stringValue(anchor?.session_id);
      const cwd = stringValue(anchor?.cwd);
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 1 ||
        !Number.isSafeInteger(startedAt) ||
        startedAt <= 0 ||
        !sessionId ||
        !cwd ||
        pid !== Number(takeover?.terminal_agent_pid) ||
        sessionId !== stringValue(takeover?.terminal_agent_session_id) ||
        path.resolve(cwd) !== path.resolve(conversation.workspace)
      ) {
        return {
          status: "unverifiable",
          reason: "Claude has no exact immutable transcript anchor for the dead process"
        };
      }
      const processUuid = stringValue(
        takeover?.terminal_agent_process_uuid
      );
      if (
        processUuid !== `claude-pid:${pid}:started:${startedAt}`
      ) {
        return {
          status: "unverifiable",
          reason: "Claude transcript anchor does not match the exact process incarnation"
        };
      }
      const submission = terminalBridgeSubmission(conversation);
      const observation = observeClaudeDeadProcessTranscriptCompletion(
        terminalDurableRequestForConversation(conversation, terminalControl),
        {
          claudeHome: expandHome(options.claudeHome),
          // Process death freezes this exact historical incarnation. The
          // transcript detector still revalidates the immutable PID/session/
          // cwd/start anchor and the no-follow file boundary before reading.
          agentRows: [{
            pid,
            startedAt,
            sessionId,
            cwd,
            kind: "interactive",
            status: "idle"
          }],
          acceptanceEvidence: submission?.acceptance_evidence
        }
      );
      return observation;
    }
    return observeExactCodexDeadProcessRolloutCompletion({
      options,
      conversation,
      terminalControl
    });
  } catch (error) {
    return {
      status: "unverifiable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function observeBoundTerminalAgentProcess({
  options,
  conversation,
  terminalControl
}: {
  options: Record<string, any>;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
}): Promise<BoundTerminalAgentProcessObservation> {
  try {
    assertTurnBindingCurrent(conversation, "verify the bound agent process for");
    const storeDir = managedSessionStoreDirForConversation(conversation);
    if (!storeDir) {
      return {
        status: "unverifiable",
        reason: "the managed Store is unavailable"
      };
    }
    const session = loadManagedSession(
      storeDir,
      sessionIdForConversation(conversation)
    );
    const binding = session.binding;
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const pid = Number(takeover?.terminal_agent_pid);
    const bindingId = stringValue(conversation.terminal_binding_id);
    const bindingGeneration = Number(conversation.terminal_binding_generation);
    const processUuid = stringValue(takeover?.terminal_agent_process_uuid);
    const processBirth = stringValue(takeover?.terminal_agent_process_birth);
    const messageId = stringValue(takeover?.terminal_bridge_message_id);
    const submission = terminalBridgeSubmission(conversation);
    if (
      session.status !== "bound" ||
      !binding ||
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      !bindingId ||
      !Number.isSafeInteger(bindingGeneration) ||
      bindingGeneration < 1 ||
      !processUuid ||
      !messageId ||
      !hasCanonicalTerminalEndpoint(terminalControl) ||
      binding.native_process.pid !== pid ||
      !terminalControlsShareIncarnation(
        binding.terminal_control,
        terminalControl
      ) ||
      binding.binding_id !== bindingId ||
      binding.generation !== bindingGeneration ||
      session.agent !== executorForConversation(conversation).kind ||
      path.resolve(session.workspace) !== path.resolve(conversation.workspace) ||
      binding.native_thread_id !==
        (
          stringValue(conversation.native_thread_id) ??
          stringValue(takeover?.terminal_agent_session_id)
        ) ||
      binding.native_process.process_uuid !== processUuid ||
      stringValue(takeover?.terminal_binding_id) !== bindingId ||
      Number(takeover?.terminal_binding_generation) !== bindingGeneration ||
      submission?.status !== "agent_accepted" ||
      stringValue(submission.session_id) !==
        sessionIdForConversation(conversation) ||
      stringValue(submission.turn_id) !== turnIdForConversation(conversation) ||
      stringValue(submission.message_id) !== messageId ||
      stringValue(submission.binding_id) !== bindingId ||
      Number(submission.binding_generation) !== bindingGeneration ||
      (binding.native_process.process_birth ?? undefined) !== processBirth
    ) {
      return {
        status: "unverifiable",
        reason: "the Turn and Session no longer share one exact process binding"
      };
    }
    const processSource = createTerminalProcessSource(options);
    if (processSource.completeInventoryAuthority !== true) {
      return {
        status: "unverifiable",
        reason:
          "the configured process source is not complete process-death authority"
      };
    }
    const snapshots = await processSource.listProcessSnapshots(
        (snapshot) => snapshot.pid === pid,
        { includeCwd: false, includeAncestors: false }
      );
    const exact = snapshots.filter((snapshot) => snapshot.pid === pid);
    if (exact.length === 1) {
      return { status: "alive", pid };
    }
    if (exact.length !== 0) {
      return {
        status: "unverifiable",
        reason: `the process inventory returned ${exact.length} rows for pid ${pid}`
      };
    }
    return {
      status: "verified_dead",
      proof: {
        kind: "exact_pid_absent_from_complete_process_inventory",
        agent: session.agent,
        pid,
        process_uuid: processUuid,
        process_birth: binding.native_process.process_birth,
        conversation_id: conversation.conversation_id,
        session_id: sessionIdForConversation(conversation),
        turn_id: turnIdForConversation(conversation),
        terminal_control: terminalControl,
        terminal_endpoint: terminalControlEvidence(terminalControl),
        binding_id: binding.binding_id,
        binding_generation: binding.generation,
        message_id: messageId,
        observed_at: cliNow().toISOString()
      }
    };
  } catch (error) {
    return {
      status: "unverifiable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function resolvedTerminalProcessIncarnation(
  terminal: Pick<ResolvedTerminalConversation, "agent" | "pid">,
  identity?: NativeAgentSessionIdentity
): { processUuid?: string; processBirth?: string } {
  return resolvedTerminalProcessIncarnationPolicy({
    terminal,
    identity,
    codexProcessIncarnation: codexProcessIncarnationForPid
  });
}

function managedSessionOwnerIsConclusivelyInactive(input: {
  session: ManagedSessionState;
  terminal: Pick<ResolvedTerminalConversation, "agent" | "pid">;
  identity?: NativeAgentSessionIdentity;
}): boolean {
  return managedSessionOwnerIsInactive({
    ...input,
    isProcessAlive,
    codexProcessIncarnation: codexProcessIncarnationForPid
  });
}

function codexKnownBeforeIdentityForManagedSession({
  storeDir,
  session,
  requireNewThread = false
}: {
  storeDir: string;
  session: ManagedSessionState;
  requireNewThread?: boolean;
}): NativeAgentSessionIdentity | undefined {
  let transition: NativeThreadTransition | undefined;
  try {
    transition = session.last_transition_id
      ? loadNativeThreadTransition(storeDir, session.last_transition_id)
      : undefined;
  } catch {
    return undefined;
  }
  return codexKnownBeforeIdentityForTransition({
    session,
    transition,
    requireNewThread
  });
}

function codexLingeringBeforeIdentityMatchesSession({
  storeDir,
  session,
  identity
}: {
  storeDir: string;
  session: ManagedSessionState;
  identity?: NativeAgentSessionIdentity;
}): boolean {
  if (!codexKnownBeforeIdentityForManagedSession({
    storeDir,
    session,
    requireNewThread: true
  })) {
    return false;
  }
  let transition: NativeThreadTransition | undefined;
  try {
    transition = loadNativeThreadTransition(
      storeDir,
      session.last_transition_id as string
    );
  } catch {
    return false;
  }
  return codexLingeringIdentityMatches({
    session,
    identity,
    transition,
    companions: codexAllowedCompanionSetForManagedSession({
      storeDir,
      session
    })
  });
}

function logicalIdentityForManagedSession({
  storeDir,
  session,
  observedIdentity
}: {
  storeDir: string;
  session: ManagedSessionState;
  observedIdentity?: NativeAgentSessionIdentity;
}): NativeAgentSessionIdentity | undefined {
  return logicalManagedSessionIdentity({
    session,
    observedIdentity,
    lingeringBeforeMatches: Boolean(observedIdentity &&
      codexLingeringBeforeIdentityMatchesSession({
        storeDir,
        session,
        identity: observedIdentity
      }))
  });
}

function codexAllowedCompanionIdentityForManagedSession({
  storeDir,
  session
}: {
  storeDir: string;
  session: ManagedSessionState;
}): CodexPreMaterializationIdentity | undefined {
  return codexIdentityFence(codexKnownBeforeIdentityForManagedSession({
    storeDir,
    session
  }));
}

function codexAllowedCompanionSetForManagedSession({
  storeDir,
  session
}: {
  storeDir: string;
  session: ManagedSessionState;
}): CodexAllowedCompanionSet {
  const primary = codexAllowedCompanionIdentityForManagedSession({
    storeDir,
    session
  });
  const binding = session.binding;
  if (!binding) {
    return { additional: [] };
  }
  const candidates = listManagedSessions(storeDir).flatMap(
    (candidate): CodexPreMaterializationIdentity[] => {
      const candidateBinding = candidate.binding;
      if (
        candidate.session_id === session.session_id ||
        candidate.agent !== "codex" ||
        candidate.status !== "detached" ||
        !candidateBinding?.native_thread_id ||
        candidateBinding.native_process.pid !== binding.native_process.pid ||
        candidateBinding.native_process.process_uuid !==
          binding.native_process.process_uuid ||
        candidateBinding.native_process.process_birth !==
          binding.native_process.process_birth ||
        !terminalControlAliasMatches(
          candidateBinding.terminal_id,
          candidateBinding.terminal_control,
          binding.terminal_id,
          binding.terminal_control
        ) ||
        path.resolve(candidate.workspace) !== path.resolve(session.workspace) ||
        !candidateBinding.native_process.process_uuid ||
        !candidateBinding.native_process.process_birth ||
        !isCompleteNativeRollout(candidateBinding.native_process.rollout)
      ) {
        return [];
      }
      return [{
        sessionId: candidateBinding.native_thread_id,
        processUuid: candidateBinding.native_process.process_uuid,
        processBirth: candidateBinding.native_process.process_birth,
        rollout: candidateBinding.native_process.rollout
      }];
    }
  );
  const selectedPrimary = primary ?? candidates[0];
  if (!selectedPrimary) {
    return { additional: [] };
  }
  const primaryKey = JSON.stringify(selectedPrimary);
  const seen = new Set([primaryKey]);
  const additional = [primary, ...candidates].filter(
    (candidate): candidate is CodexPreMaterializationIdentity => {
    if (!candidate) {
      return false;
    }
    const key = JSON.stringify(candidate);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return { primary: selectedPrimary, additional };
}

function codexManagedIdentityResolutionContext({
  storeDir,
  terminal
}: {
  storeDir: string;
  terminal: Pick<
    ResolvedTerminalConversation,
    "conversationId" | "agent" | "pid" | "terminalControl"
  >;
}): {
  claimedSession?: ManagedSessionState;
  companions: CodexAllowedCompanionSet;
  preferredSessionId?: string;
} {
  const claimedSession = soleBoundManagedSessionClaimForTerminal(
    storeDir,
    terminal
  );
  const companions = claimedSession
    ? codexAllowedCompanionSetForManagedSession({
        storeDir,
        session: claimedSession
      })
    : { additional: [] };
  return {
    claimedSession,
    companions,
    // A preferred rollout is only safe when committed managed lineage also
    // supplies an exact predecessor/companion fence. The constrained resolver
    // will reject every unknown root instead of guessing among open FDs.
    preferredSessionId: companions.primary
      ? claimedSession?.binding?.native_thread_id
      : undefined
  };
}

function codexKnownRootSetForLifecycleTransition({
  storeDir,
  terminal,
  transition
}: {
  storeDir: string;
  terminal: ResolvedTerminalConversation;
  transition: NativeThreadTransition;
}): CodexAllowedCompanionSet {
  return knownNativeThreadCompanionSet({
    terminal,
    transition,
    managedSessions: listManagedSessions(storeDir)
  }, {
    terminalAliasMatches: terminalControlAliasMatches,
    workspaceMatches: matchesConfiguredWorkspace
  });
}

function codexPreMaterializationIdentityForManagedSession({
  storeDir,
  session,
  observedIdentity
}: {
  storeDir: string;
  session: ManagedSessionState;
  observedIdentity?: NativeAgentSessionIdentity;
}): CodexPreMaterializationIdentity | undefined {
  if (!codexLingeringBeforeIdentityMatchesSession({
      storeDir,
      session,
      identity: observedIdentity
    })) {
    return undefined;
  }
  return codexIdentityFence(observedIdentity);
}

async function assertCodexComposerReadyForAutomatedInput({
  options,
  terminalControl
}: {
  options: Record<string, any>;
  terminalControl: TerminalControlRef;
}): Promise<void> {
  const provider = createTerminalControlProvider(options);
  const resolvedTerminal = await provider.resolve(
    provider.endpoint(terminalControl)
  );
  const styledScreen = await provider.capture(
    resolvedTerminal,
    { scrollbackLines: 40, preserveEscapes: true }
  );
  if (exactCodexReadyStyledComposerCapture(styledScreen) === undefined) {
    throw new Error(
      "Codex composer contains non-placeholder input; refusing automated terminal input"
    );
  }
}

async function verifyCodexPendingManagedSendStatus({
  options,
  terminal,
  session,
  logicalIdentity,
  allowedPreMaterializationIdentity,
  allowedAdditionalIdentities = []
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  session: ManagedSessionState;
  logicalIdentity?: NativeAgentSessionIdentity;
  allowedPreMaterializationIdentity?: CodexPreMaterializationIdentity;
  allowedAdditionalIdentities?: CodexPreMaterializationIdentity[];
}): Promise<void> {
  const binding = session.binding;
  if (
    terminal.agent !== "codex" ||
    !binding?.native_thread_id ||
    (
      !allowedPreMaterializationIdentity &&
      (
        binding.native_process.rollout ||
        !isCodexStatusCardEvidence(binding.native_process.evidence)
      )
    )
  ) {
    return;
  }
  if (logicalIdentity?.sessionId !== binding.native_thread_id) {
    throw new Error(
      "the pending Codex Session has no exact logical native-thread identity"
    );
  }

  const runtime: TerminalRuntimeIdentity = {
    ...terminalRuntimeForLiveIdentity({
      terminal,
      expectedEmptyNativeSession: true
    }),
    ...(binding.native_process.process_uuid
      ? { nativeProcessUuid: binding.native_process.process_uuid }
      : {}),
    ...(binding.native_process.process_birth
      ? { nativeProcessBirth: binding.native_process.process_birth }
      : {}),
    ...(binding.native_process.rollout
      ? { nativeRollout: binding.native_process.rollout }
      : {}),
    expectedNativeSessionId: binding.native_thread_id,
    allowedPreMaterializationNativeIdentity:
      allowedPreMaterializationIdentity,
    allowedAdditionalNativeIdentities: allowedAdditionalIdentities
  };
  const bridge = createTerminalAgentBridge(options);
  const initialStatus = await bridge.status(
    terminal.agent,
    terminal.terminalControl,
    { runtime }
  );
  assertSafeTerminalSend(terminal.agent, initialStatus);
  if (!codexComposerVisible(initialStatus.screen.excerpt)) {
    throw new Error(
      "Codex status-card verification requires a visible idle composer"
    );
  }
  const observed = await probeCodexCurrentThread({
    terminal,
    currentIdentity: logicalIdentity,
    runtimeOverride: runtime
  }, nativeThreadVerificationAdapterPorts(options, terminal));
  if (observed.sessionId !== binding.native_thread_id) {
    throw new Error(
      `Codex /status reports native thread ${observed.sessionId}, but managed ` +
      `Session ${session.session_id} is bound to ${binding.native_thread_id}`
    );
  }
}

function terminalRuntimeForLiveIdentity(input: {
  terminal: TerminalDispatchTerminal;
  identity?: NativeAgentSessionIdentity;
  expectedEmptyNativeSession?: boolean;
  physicalOnly?: boolean;
}): TerminalRuntimeIdentity {
  return terminalRuntimeForLiveIdentityPolicy({
    ...input,
    codexProcessIncarnation: codexProcessIncarnationForPid
  });
}

type ResolvedTerminalClaim = Pick<ResolvedTerminalConversation,
  "conversationId" | "agent" | "pid" | "terminalControl">;

function managedSessionClaimsResolvedTerminal(
  session: ManagedSessionState,
  terminal: ResolvedTerminalClaim
): boolean {
  const binding = session.binding!;
  return session.status === "bound" && binding !== undefined &&
    session.agent === terminal.agent &&
    binding.native_process.pid === terminal.pid &&
    terminalControlAliasMatches(
      binding.terminal_id,
      binding.terminal_control,
      terminal.conversationId,
      terminal.terminalControl
    ) && matchesConfiguredWorkspace(
      session.workspace,
      terminal.terminalControl.currentPath
    );
}

function bindingMatchesLiveTerminal(
  session: ManagedSessionState,
  terminal: ResolvedTerminalConversation,
  identity: NativeAgentSessionIdentity | undefined,
  storeDir: string
): boolean {
  if (!managedSessionClaimsResolvedTerminal(session, terminal)) {
    return false;
  }
  const binding = session.binding!;
  let processIncarnation = {
    processUuid: identity?.processUuid,
    processBirth: identity?.processBirth
  };
  if (!identity) {
    if (
      terminal.agent !== "codex" || !binding.native_thread_id ||
      !isCodexStatusCardEvidence(binding.native_process.evidence) ||
      !binding.native_process.process_uuid ||
      !binding.native_process.process_birth
    ) {
      return false;
    }
    try {
      processIncarnation = codexProcessIncarnationForPid(terminal.pid);
    } catch {
      return false;
    }
  }
  return managedBindingMatchesLiveTerminal({
    session,
    terminal,
    identity,
    processIncarnation,
    claimMatches: true,
    codexLingeringBeforeMatches: () =>
      codexLingeringBeforeIdentityMatchesSession({
        storeDir,
        session,
        identity
      })
  });
}

function boundManagedSessionForTerminal({
  storeDir,
  terminal,
  identity
}: {
  storeDir: string;
  terminal: ResolvedTerminalConversation;
  identity?: NativeAgentSessionIdentity;
}): ManagedSessionState | undefined {
  return selectBoundManagedSessionForTerminal({
    sessions: listManagedSessions(storeDir),
    agent: terminal.agent,
    pid: terminal.pid,
    terminalTarget: terminal.terminalControl.target,
    aliasMatches: (session) => Boolean(session.binding &&
      terminalControlAliasMatches(
        session.binding.terminal_id,
        session.binding.terminal_control,
        terminal.conversationId,
        terminal.terminalControl
      )),
    exactMatches: (session) =>
      bindingMatchesLiveTerminal(session, terminal, identity, storeDir),
    sameIncarnation: (session) => Boolean(session.binding &&
      terminalControlsShareIncarnation(
        session.binding.terminal_control,
        terminal.terminalControl
      )),
    ownerIsInactive: (session) => managedSessionOwnerIsConclusivelyInactive({
      session,
      terminal,
      identity
    })
  });
}

function managedBindingConflictKindForResolvedTerminal({
  storeDir,
  session,
  terminal,
  identity
}: {
  storeDir: string;
  session: ManagedSessionState;
  terminal: ResolvedTerminalConversation;
  identity?: NativeAgentSessionIdentity;
}): ManagedBindingConflictKind | undefined {
  if (
    !managedSessionClaimsResolvedTerminal(session, terminal) ||
    bindingMatchesLiveTerminal(session, terminal, identity, storeDir)
  ) {
    return undefined;
  }
  const binding = session.binding!;
  if (managedSessionOwnerIsConclusivelyInactive({
    session,
    terminal,
    identity
  })) {
    return "stale_process_incarnation";
  }
  const incarnation = resolvedTerminalProcessIncarnation(terminal, identity);
  const relationship = processIncarnationRelationship({
    binding,
    livePid: terminal.pid,
    liveProcessUuid: incarnation.processUuid,
    liveProcessBirth: incarnation.processBirth
  });
  return decideManagedBindingConflict({
    session,
    claimsTerminal: true,
    exactBinding: false,
    ownerConclusivelyInactive: false,
    processRelationship: relationship,
    liveNativeThreadId: identity?.sessionId,
    managedTurnCount: terminalListCliFacade.provisionalManagedBindingTurnCount(storeDir, session)
  });
}

function soleBoundManagedSessionClaimForTerminal(
  storeDir: string,
  terminal: ResolvedTerminalClaim
): ManagedSessionState | undefined {
  return selectSoleBoundManagedSessionClaim({
    sessions: listManagedSessions(storeDir),
    terminalTarget: terminal.terminalControl.target,
    claims: (session) =>
      managedSessionClaimsResolvedTerminal(session, terminal),
    ownerIsInactive: (session) =>
      managedSessionOwnerIsConclusivelyInactive({ session, terminal })
  });
}

function createBoundManagedSession({
  sessionId,
  terminal,
  identity,
  nativeThreadId = identity?.sessionId,
  evidence = identity?.evidence ?? "native_thread_boundary",
  generation = 1,
  lineage,
  now = cliNow()
}: {
  sessionId: string;
  terminal: ResolvedTerminalConversation;
  identity?: NativeAgentSessionIdentity;
  nativeThreadId?: string;
  evidence?: string;
  generation?: number;
  lineage: ManagedSessionState["lineage"];
  now?: Date;
}): ManagedSessionState {
  const workspace = terminal.terminalControl.currentPath ?? cliCwd();
  const codexIncarnation = terminal.agent === "codex" && !identity
    ? codexProcessIncarnationForPid(terminal.pid)
    : undefined;
  const binding = terminalBindingFrom({
    terminalId: terminal.conversationId,
    terminalControl: terminal.terminalControl,
    pid: terminal.pid,
    nativeThreadId,
    processUuid: identity?.processUuid ?? codexIncarnation?.processUuid,
    processBirth: identity?.processBirth ?? codexIncarnation?.processBirth,
    rollout: identity?.rollout,
    evidence: identity?.evidence ?? codexIncarnation?.evidence ?? evidence,
    generation,
    now
  });
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: terminal.agent,
    workspace,
    status: "bound",
    binding,
    lineage,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_transition_id: lineage.transition_id
  };
}

function materializeCurrentManagedSession({
  options,
  terminal,
  identity
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  identity?: NativeAgentSessionIdentity;
}): ManagedSessionState | undefined {
  const storeDir = storeDirFromOptions(options);
  const existing = boundManagedSessionForTerminal({
    storeDir,
    terminal,
    identity
  });
  if (existing) {
    return existing;
  }
  const matches = listConversations(storeDir)
    .filter(isDiscoverableTmuxConversation)
    .filter((conversation) =>
      managedTurnMatchesResolvedTerminal(conversation, terminal, identity)
    );
  const sessionIds = [...new Set(matches.map((turn) =>
    sessionIdForConversation(turn)
  ))];
  if (sessionIds.length > 1) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} has ambiguous legacy Session bindings`
    );
  }
  const sessionId = sessionIds[0];
  if (!sessionId) {
    return undefined;
  }
  const existingById = tryLoadManagedSession(storeDir, sessionId);
  if (existingById) {
    if (!bindingMatchesLiveTerminal(existingById, terminal, identity, storeDir)) {
      throw new Error(
        `managed Session ${sessionId} no longer matches its terminal binding`
      );
    }
    return existingById;
  }
  throw new Error(
    `Store protocol 3+ has Turn records for Session ${sessionId} but its ` +
    "authoritative Session state is missing"
  );
}

async function reattachManagedSessionForNativeIdentity({
  options,
  terminal,
  identity,
  storeDir
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  identity: NativeAgentSessionIdentity;
  storeDir: string;
}): Promise<ManagedSessionState | undefined> {
  if (!isExactNativeThreadId(identity.sessionId)) {
    throw new Error("raw terminal attach requires an exact native thread UUID");
  }
  const nativeThreadId = identity.sessionId.toLowerCase();
  const matches = listManagedSessions(storeDir).filter((session) =>
    session.agent === terminal.agent &&
    session.binding?.native_thread_id?.toLowerCase() === nativeThreadId
  );
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new Error(
      `native thread ${nativeThreadId} is claimed by multiple managed Sessions`
    );
  }
  const existing = matches[0];
  if (
    !existing.binding ||
    !["bound", "detached"].includes(existing.status) ||
    path.resolve(existing.workspace) !==
      path.resolve(terminal.terminalControl.currentPath ?? cliCwd())
  ) {
    throw new Error(
      `managed Session ${existing.session_id} cannot be rebound from ` +
      `${existing.status} state for native thread ${nativeThreadId}`
    );
  }
  assertManagedSessionCanStartTurn(
    managedTurnsForSession(storeDir, existing.session_id)
  );
  await assertNativeThreadHasExclusiveOwnership({
    options,
    agent: terminal.agent,
    currentPid: terminal.pid,
    nativeThreadId,
    storeDir,
    terminalControl: terminal.terminalControl,
    excludedManagedSessionId: existing.session_id
  });
  const previousPid = existing.binding.native_process.pid;
  if (
    existing.status === "bound" &&
    !managedSessionOwnerIsConclusivelyInactive({
      session: existing,
      terminal,
      identity
    })
  ) {
    throw new Error(
      `managed Session ${existing.session_id} is still bound to process ${previousPid}`
    );
  }

  const now = cliNow();
  const binding = terminalBindingFrom({
    terminalId: terminal.conversationId,
    terminalControl: terminal.terminalControl,
    pid: terminal.pid,
    nativeThreadId,
    processUuid: identity.processUuid,
    processBirth: identity.processBirth,
    rollout: identity.rollout,
    evidence: `${identity.evidence}+raw_reattach`,
    generation: existing.binding.generation + 1,
    now
  });
  return saveManagedSession(storeDir, {
    ...existing,
    status: "bound",
    binding,
    detached_at: undefined,
    quarantine_reason: undefined,
    updated_at: now.toISOString()
  }, { expectedRevision: managedSessionRevision(existing) });
}

const HUMAN_OBSERVED_HANDOFF_FINGERPRINT =
  nativeThreadCommandFingerprint(
    "adopt_external_thread:human_observed:no_terminal_input:v1"
  );

function deferredForegroundAuthorityAdapterPorts():
  deferredAuthorityAdapter.DeferredForegroundAuthorityAdapterPorts {
  return {
    turn: {
      terminalControl: terminalControlFromTakeover,
      storeDir: managedSessionStoreDirForConversation,
      turnsForSession: managedTurnsForSession,
      needsAttention: (turn) =>
        terminalListCliFacade.managedTurnNeedsAttention(turn),
      readEvents: readExistingEvents
    },
    ledger: {
      load: loadTerminalBridgeDispatchLedger,
      matchesControl: terminalDispatchRecordMatchesControl,
      processAnchor: terminalDispatchRecordProcessAnchor
    },
    transition: {
      hasUnresolved: (storeDir, session) =>
        terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(
          storeDir,
          session
        ),
      hasAny: (storeDir, session) =>
        terminalListCliFacade.managedSessionHasAnyNativeTransition(
          storeDir,
          session
        )
    }
  };
}

function codexCandidateInventoryHasNoOtherManagedClaim(options: {
  storeDir: string;
  inventory: CodexOpenRootRolloutInventory;
  sourceSessionId: string;
  includeDetached?: boolean;
}): boolean {
  return deferredAuthorityAdapter.codexCandidateInventoryHasNoOtherManagedClaim(
    deferredForegroundAuthorityAdapterPorts(),
    options
  );
}

function deferredCandidateSourceTurnHistory(
  storeDir: string,
  session: ManagedSessionState
): DeferredForegroundTransferSourceTurnAuthority[] | undefined {
  return deferredAuthorityAdapter.deferredCandidateSourceTurnHistory(
    deferredForegroundAuthorityAdapterPorts(),
    storeDir,
    session
  );
}

function explicitlyAbandonedCandidateSourceFingerprint(options: {
  storeDir: string;
  session: ManagedSessionState;
  sourceTurnHistory: DeferredForegroundTransferSourceTurnAuthority[];
  dispatchSnapshot: DeferredCodexForegroundDispatchSnapshot;
  sourceRevision?: number;
  sourceBindingToken?: string;
  ledgerOverride?: Record<string, any>;
  requireResolvedTopLevel?: boolean;
}): string | undefined {
  return deferredAuthorityAdapter.explicitlyAbandonedCandidateSourceFingerprint(
    deferredForegroundAuthorityAdapterPorts(),
    options
  );
}

function assertFrozenExplicitlyAbandonedPredecessorAuthority(options: {
  storeDir: string;
  transfer: DeferredForegroundTransfer;
  terminalControl: TerminalControlRef;
}): void {
  deferredAuthorityAdapter.assertFrozenExplicitlyAbandonedPredecessorAuthority(
    deferredForegroundAuthorityAdapterPorts(),
    options
  );
}

function deferredCodexForegroundDispatchSnapshot(
  terminalControl: TerminalControlRef
): DeferredCodexForegroundDispatchSnapshot {
  return deferredAuthorityAdapter.deferredCodexForegroundDispatchSnapshot(
    deferredForegroundAuthorityAdapterPorts(),
    terminalControl
  );
}

function deferredCodexPreviousDispatchSnapshotMatches(options: {
  transfer: DeferredForegroundTransfer;
  terminalControl: TerminalControlRef;
  ledger: Record<string, any> | undefined;
}): boolean {
  return deferredAuthorityAdapter.deferredCodexPreviousDispatchSnapshotMatches(
    deferredForegroundAuthorityAdapterPorts(),
    options
  );
}

function observeDeferredCodexAuthority(options: {
  mode: deferredAuthorityAdapter.DeferredCodexAuthorityMode;
  storeDir: string;
  context: CodexSendAuthorityContext;
  sourceSession?: ManagedSessionState;
  candidateInventory?: CodexOpenRootRolloutInventory;
  abandonment: "never" | "missing_rollout" | "missing_inventory_rollout";
  fixedSourceRolloutAuthority?: DeferredForegroundTransferSourceRolloutAuthority;
  fixedDispatchSnapshot?: DeferredCodexForegroundDispatchSnapshot;
  sourceRevision?: number;
  sourceBindingToken?: string;
  requireUnclaimedCandidate?: boolean;
}): deferredAuthorityAdapter.DeferredCodexAuthorityObservation | undefined {
  return deferredAuthorityAdapter.observeDeferredCodexAuthority(
    deferredForegroundAuthorityAdapterPorts(),
    options
  );
}

async function assertVerifiedEmptyCodexHandoffBoundary({
  options,
  terminal,
  sourceSession,
  expectedSourceStatus,
  requireNoDispatch,
  requireEmptyComposer = true
}: {
  options: Record<string, any>;
  terminal: TerminalDispatchTerminal;
  sourceSession: ManagedSessionState;
  expectedSourceStatus: "bound" | "detached";
  requireNoDispatch: boolean;
  requireEmptyComposer?: boolean;
}): Promise<void> {
  const currentSource = loadManagedSession(
    storeDirFromOptions(options),
    sourceSession.session_id
  );
  if (
    currentSource.status !== expectedSourceStatus ||
    currentSource.revision !== sourceSession.revision ||
    managedSessionBindingToken(currentSource) !==
      managedSessionBindingToken(sourceSession)
  ) {
    throw new Error(
      "the verified-empty source Session changed; refresh AKK list"
    );
  }
  const liveIncarnation = codexProcessIncarnationForPid(terminal.pid);
  if (
    !exactBoundCodexSendSource({
      kind: "verified_empty",
      sourceSession: {
        ...currentSource,
        // The exact source binding remains authoritative after the monotonic
        // detach; only the Session status changes.
        status: "bound"
      },
      context: {
        terminalId: terminal.conversationId,
        terminalControl: terminal.terminalControl,
        pid: terminal.pid,
        workspace: terminal.terminalControl.currentPath,
        liveProcessUuid: liveIncarnation.processUuid,
        liveProcessBirth: liveIncarnation.processBirth
      }
    })
  ) {
    throw new Error(
      "the verified-empty source binding no longer matches the terminal"
    );
  }
  const observation = await observeCurrentNativeAgentSessionIdentity({
    options,
    agent: "codex",
    pid: terminal.pid,
    cwd: terminal.terminalControl.currentPath
  });
  if (observation.status === "unavailable") {
    throw new Error(
      `Codex native identity observation is unavailable: ${observation.reason}`
    );
  }
  if (observation.status !== "verified_absent") {
    throw new Error(
      `Codex materialized native thread ${observation.identity.sessionId}; ` +
      "refresh AKK list before sending"
    );
  }
  const status = await createTerminalAgentBridge(options).status(
    "codex",
    terminal.terminalControl,
    {
      runtime: terminalRuntimeForLiveIdentity({
        terminal,
        expectedEmptyNativeSession: true
      })
    }
  );
  if (
    status.reachable !== true ||
    status.approval_state.blocked === true ||
    !["idle", "unknown"].includes(status.activity_state)
  ) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} is not at a verified ` +
      `empty Codex prompt (${status.activity_state}: ${status.activity_reason})`
    );
  }
  if (requireNoDispatch) {
    assertTerminalLifecycleReady({
      options,
      terminal,
      // A fully styled empty/placeholder composer below is stronger prompt
      // evidence than the plain-screen parser's conservative `unknown`.
      terminalStatus: { ...status, activity_state: "idle" }
    });
  }
  if (terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(
    storeDirFromOptions(options),
    currentSource
  )) {
    throw new Error(
      `managed Session ${currentSource.session_id} has an unresolved native-thread transition`
    );
  }
  if (requireEmptyComposer) {
    await assertCodexComposerReadyForAutomatedInput({
      options,
      terminalControl: terminal.terminalControl
    });
  }
}

async function maybeDetachVerifiedEmptyCodexSource({
  options,
  terminal,
  sourceSession,
  observation
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  sourceSession?: ManagedSessionState;
  observation: NativeAgentSessionIdentityObservation;
}): Promise<{
  detached: ManagedSessionState;
  boundary: VerifiedEmptyCodexHandoffBoundary;
} | undefined> {
  if (
    terminal.agent !== "codex" ||
    !sourceSession?.binding ||
    observation.status !== "verified_absent"
  ) {
    return undefined;
  }
  const processUuid = sourceSession.binding.native_process.process_uuid;
  const processBirth = sourceSession.binding.native_process.process_birth;
  const workspace = terminal.terminalControl.currentPath;
  const liveIncarnation = codexProcessIncarnationForPid(terminal.pid);
  if (
    !processUuid ||
    !processBirth ||
    !workspace ||
    !exactBoundCodexSendSource({
      kind: "verified_empty",
      sourceSession,
      context: {
        terminalId: terminal.conversationId,
        terminalControl: terminal.terminalControl,
        pid: terminal.pid,
        workspace,
        liveProcessUuid: liveIncarnation.processUuid,
        liveProcessBirth: liveIncarnation.processBirth
      }
    })
  ) {
    return undefined;
  }
  const expectedToken = verifiedEmptyCodexHandoffToken({
    terminalId: terminal.conversationId,
    terminalControl: terminal.terminalControl,
    pid: terminal.pid,
    workspace,
    processUuid,
    processBirth,
    sourceSession
  });
  if (stringValue(options.expectedTerminalToken) !== expectedToken) {
    throw new Error(
      "verified-empty Codex handoff requires the fresh exact terminal token " +
      "advertised by AKK list"
    );
  }
  await assertVerifiedEmptyCodexHandoffBoundary({
    options,
    terminal,
    sourceSession,
    expectedSourceStatus: "bound",
    requireNoDispatch: true
  });
  await assertNativeThreadHasExclusiveOwnership({
    options,
    agent: "codex",
    currentPid: terminal.pid,
    nativeThreadId: sourceSession.binding.native_thread_id as string,
    storeDir: storeDirFromOptions(options),
    terminalControl: terminal.terminalControl,
    excludedManagedSessionId: sourceSession.session_id
  });
  const detachedAt = cliNow().toISOString();
  const detached = saveManagedSession(storeDirFromOptions(options), {
    ...sourceSession,
    status: "detached",
    detached_at: detachedAt,
    updated_at: detachedAt
  }, {
    expectedRevision: managedSessionRevision(sourceSession)
  });
  runtimeLog("info", "verified_empty_codex_source_detached", {
    terminal_id: terminal.conversationId,
    source_session_id: sourceSession.session_id,
    native_thread_id: sourceSession.binding.native_thread_id,
    process_uuid: processUuid,
    process_birth: processBirth,
    terminal_input_sent: false
  });
  return {
    detached,
    boundary: {
      terminal,
      detachedSourceSessionId: detached.session_id,
      detachedSourceRevision: managedSessionRevision(detached),
      detachedSourceBindingToken: managedSessionBindingToken(detached),
      processUuid,
      processBirth
    }
  };
}

async function assertVerifiedEmptyCodexTransportBoundary({
  options,
  boundary,
  requireEmptyComposer
}: {
  options: Record<string, any>;
  boundary: VerifiedEmptyCodexHandoffBoundary;
  requireEmptyComposer: boolean;
}): Promise<void> {
  const source = loadManagedSession(
    storeDirFromOptions(options),
    boundary.detachedSourceSessionId
  );
  if (
    source.status !== "detached" ||
    managedSessionRevision(source) !== boundary.detachedSourceRevision ||
    managedSessionBindingToken(source) !==
      boundary.detachedSourceBindingToken ||
    source.binding?.native_process.process_uuid !== boundary.processUuid ||
    source.binding.native_process.process_birth !== boundary.processBirth
  ) {
    throw new Error(
      "verified-empty Codex source authority changed before text injection"
    );
  }
  await assertVerifiedEmptyCodexHandoffBoundary({
    options,
    terminal: boundary.terminal,
    sourceSession: source,
    expectedSourceStatus: "detached",
    requireNoDispatch: false,
    requireEmptyComposer
  });
}

function deferredForegroundBoundaryAdapterPorts(
  options: Record<string, any>,
  storeDir: string
): DeferredForegroundBoundaryAdapterPorts {
  return {
    processIncarnation: codexProcessIncarnationForPid,
    inventory: (boundary) => inspectCodexOpenRootRolloutInventory({
      options,
      pid: boundary.terminal.pid,
      cwd: boundary.terminal.terminalControl.currentPath
    }),
    nativeIdentity: (boundary) => observeCurrentNativeAgentSessionIdentity({
      options,
      agent: "codex",
      pid: boundary.terminal.pid,
      cwd: boundary.terminal.terminalControl.currentPath
    }),
    authority: ({
      boundary,
      sourceAsBound,
      candidateInventory,
      expectedSourceStatus
    }) => observeDeferredCodexAuthority({
      mode: expectedSourceStatus === "bound"
        ? "boundary_bound"
        : "boundary_transitioning",
      storeDir,
      context: {
        terminalId: boundary.terminal.conversationId,
        terminalControl: boundary.terminal.terminalControl,
        pid: boundary.terminal.pid,
        workspace: boundary.terminal.terminalControl.currentPath,
        liveProcessUuid: boundary.processUuid,
        liveProcessBirth: boundary.processBirth
      },
      sourceSession: sourceAsBound,
      candidateInventory,
      abandonment: "never",
      fixedSourceRolloutAuthority: boundary.sourceRolloutAuthority,
      fixedDispatchSnapshot: boundary.previousDispatchSnapshot,
      sourceRevision: boundary.sourceBoundRevision,
      sourceBindingToken: boundary.sourceBoundBindingToken
    }),
    assertNoDispatch: (_scope, boundary) =>
      terminalListCliFacade.assertTerminalIncarnationCanStartTurn(
        storeDir,
        boundary.terminal.terminalControl
      ),
    dispatchSnapshot: (boundary) =>
      deferredCodexForegroundDispatchSnapshot(
        boundary.terminal.terminalControl
      ),
    status: async (boundary) => {
      const status = await createTerminalAgentBridge(options).status(
        "codex",
        boundary.terminal.terminalControl,
        {
          runtime: terminalRuntimeForLiveIdentity({
            terminal: boundary.terminal,
            expectedEmptyNativeSession:
              boundary.candidateAcceptanceAnchor === undefined,
            physicalOnly: boundary.candidateAcceptanceAnchor !== undefined
          })
        }
      );
      return {
        reachable: status.reachable === true,
        approvalBlocked: status.approval_state.blocked === true,
        activityState: status.activity_state,
        activityReason: status.activity_reason
      };
    },
    assertComposerReady: (boundary) =>
      assertCodexComposerReadyForAutomatedInput({
        options,
        terminalControl: boundary.terminal.terminalControl
      }),
    valuesMatch: (left, right) =>
      JSON.stringify(left) === JSON.stringify(right)
  };
}

async function assertDeferredCodexForegroundBindingBoundary({
  options,
  scope,
  boundary,
  expectedSourceStatus,
  requireNoDispatch,
  requireEmptyComposer
}: {
  options: Record<string, any>;
  scope: DeferredForegroundApplicationScope;
  boundary: DeferredCodexForegroundBindingBoundary;
  expectedSourceStatus: "bound" | "transitioning";
  requireNoDispatch: boolean;
  requireEmptyComposer: boolean;
}): Promise<ManagedSessionState> {
  const storeDir = storeDirFromOptions(options);
  return assertDeferredForegroundBoundary({
    scope,
    storeDir,
    boundary,
    applicationBoundary: deferredForegroundBoundaryProjection(boundary),
    expectedSourceStatus,
    requireNoDispatch,
    requireEmptyComposer,
    ports: deferredForegroundBoundaryAdapterPorts(options, storeDir)
  });
}

async function prepareDeferredCodexForegroundBinding({
  options,
  scope,
  terminal,
  sourceSession,
  observation,
  candidateInventory,
  requestText,
  allowImplicitFreshAuthority = false
}: {
  options: Record<string, any>;
  scope: DeferredForegroundApplicationScope;
  terminal: ResolvedTerminalConversation;
  sourceSession?: ManagedSessionState;
  observation: NativeAgentSessionIdentityObservation;
  candidateInventory?: CodexOpenRootRolloutInventory;
  requestText: string;
  allowImplicitFreshAuthority?: boolean;
}): Promise<DeferredCodexForegroundBindingBoundary | undefined> {
  const storeDir = storeDirFromOptions(options);
  const prepared = await prepareDeferredForegroundBinding({
    scope,
    terminal: projectDeferredForegroundTerminalFacts(terminal),
    sourceSession,
    nativeIdentityVerifiedAbsent: observation.status === "verified_absent",
    candidateInventory,
    requestText,
    expectedTerminalToken: stringValue(options.expectedTerminalToken),
    allowImplicitFreshAuthority
  }, {
    authority: {
      processIncarnation: codexProcessIncarnationForPid,
      observeFresh: ({
        sourceSession,
        candidateInventory,
        liveIncarnation
      }) => observeDeferredCodexAuthority({
        mode: "prepare",
        storeDir,
        context: {
          terminalId: terminal.conversationId,
          terminalControl: terminal.terminalControl,
          pid: terminal.pid,
          workspace: terminal.terminalControl.currentPath,
          liveProcessUuid: liveIncarnation.processUuid,
          liveProcessBirth: liveIncarnation.processBirth
        },
        sourceSession,
        candidateInventory,
        abandonment: "missing_inventory_rollout"
      }),
      revalidate: async (activeScope, boundary) => {
        await assertDeferredCodexForegroundBindingBoundary({
          options,
          scope: activeScope,
          boundary: deferredForegroundConcreteBoundary(boundary, terminal),
          expectedSourceStatus: "bound",
          requireNoDispatch: true,
          requireEmptyComposer: true
        });
      },
      assertExclusive: (
        _activeScope,
        boundary,
        nativeThreadId,
        excludedManagedSessionId
      ) => assertNativeThreadHasExclusiveOwnership({
        options,
        agent: "codex",
        currentPid: boundary.terminal.pid,
        nativeThreadId,
        storeDir,
        terminalControl: terminal.terminalControl,
        excludedManagedSessionId
      }),
      candidateInventoryUnclaimed: ({
        sourceSession,
        inventory,
        includeDetached
      }) => codexCandidateInventoryHasNoOtherManagedClaim({
        storeDir,
        inventory,
        sourceSessionId: sourceSession.session_id,
        includeDetached
      }),
      abandonmentStillFresh: ({
        sourceSession,
        sourceTurnHistory,
        sourceAbandonmentFingerprint,
        dispatchSnapshot
      }) => {
        const freshHistory = deferredCandidateSourceTurnHistory(
          storeDir,
          sourceSession
        );
        const freshFingerprint = freshHistory
          ? explicitlyAbandonedCandidateSourceFingerprint({
              storeDir,
              session: sourceSession,
              sourceTurnHistory: freshHistory,
              dispatchSnapshot
            })
          : undefined;
        return JSON.stringify(freshHistory) ===
            JSON.stringify(sourceTurnHistory) &&
          freshFingerprint === sourceAbandonmentFingerprint;
      },
      transferMatchesTerminal: (transfer) =>
        deferredForegroundTransferMatchesTerminal(transfer, terminal)
    },
    identity: {
      targetSessionId: createManagedSessionId,
      transferId: createDeferredForegroundTransferId,
      captureCandidateAnchor: (inventory, now) =>
        captureCodexCandidateSetRolloutAcceptanceAnchor({ inventory, now }),
      bindingToken: ({
        sourceSession,
        authority,
        candidateInventory
      }) => deferredCodexForegroundBindingToken({
        terminalId: terminal.conversationId,
        terminalControl: terminal.terminalControl,
        pid: terminal.pid,
        workspace: required(
          terminal.terminalControl.currentPath,
          "deferred Codex terminal workspace is unavailable"
        ),
        processUuid: sourceSession.binding!.native_process.process_uuid as string,
        processBirth: sourceSession.binding!.native_process.process_birth as string,
        sourceSession,
        dispatchSnapshot: authority.dispatchSnapshot!,
        candidateInventory,
        sourceTurnHistory: authority.sourceTurnHistory,
        sourceRolloutAuthority: authority.sourceRolloutAuthority,
        sourceAbandonmentFingerprint:
          authority.sourceAbandonmentFingerprint
      }),
      requestHash: (text) => required(
        terminalBridgeRequestFingerprint(terminalSubmissionPayload(text)),
        "deferred foreground request hash is unavailable"
      )
    },
    runtime: {
      now: cliNow,
      pid: cliPid,
      log: runtimeLog
    }
  });
  return prepared
    ? deferredForegroundConcreteBoundary(prepared, terminal)
    : undefined;
}

function deferredForegroundApplication(
  options: Record<string, any>,
  terminal?: TerminalDispatchTerminal
): DeferredForegroundApplicationService {
  const concreteBoundary = (boundary: DeferredForegroundBindingBoundary) =>
    deferredForegroundConcreteBoundary(
      boundary,
      required(
        terminal,
        "deferred foreground terminal authority is unavailable"
      )
    );
  return new DeferredForegroundApplicationService({
    authority: {
      verifyReservedSource: (scope, boundary) =>
        assertDeferredCodexForegroundBindingBoundary({
          options,
          scope,
          boundary: concreteBoundary(boundary),
          expectedSourceStatus: "bound",
          requireNoDispatch: true,
          requireEmptyComposer: true
        }),
      assertExclusive: (_scope, boundary, request) =>
        assertNativeThreadHasExclusiveOwnership({
          options,
          agent: "codex",
          currentPid: request.processPid,
          nativeThreadId: request.nativeThreadId,
          storeDir: storeDirFromOptions(options),
          terminalControl: concreteBoundary(boundary).terminal.terminalControl,
          excludedManagedSessionId: request.excludedManagedSessionId,
          allowedManagedSessionIds: request.allowedManagedSessionIds
        }),
      assertFrozenPredecessor: (_scope, boundary, transfer) =>
        assertFrozenExplicitlyAbandonedPredecessorAuthority({
          storeDir: storeDirFromOptions(options),
          transfer,
          terminalControl: concreteBoundary(boundary).terminal.terminalControl
        }),
      valuesMatch: (left, right) =>
        JSON.stringify(left) === JSON.stringify(right)
    },
    clock: { now: cliNow },
    runtime: {
      crashAt: (point) => {
        const key = {
          source_session_reserved:
            "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_SESSION_RESERVED",
          source_reserved: "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_RESERVED",
          target_prepared: "AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_PREPARED",
          source_scrubbed: "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_SCRUBBED",
          target_accepted: "AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_ACCEPTED",
          committed: "AKK_TEST_EXIT_AFTER_DEFERRED_COMMITTED",
          source_detached: "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_DETACHED",
          target_bound: "AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_BOUND"
        }[point];
        if (cliEnv()[key] === "1") cliExit(86);
      },
      errorReceipt: (reason) => JSON.stringify(textSummary(reason)),
      summary: textSummary,
      log: runtimeLog
    }
  });
}

function deferredForegroundRecoveryAdapterPorts():
  deferredRecoveryAdapter.DeferredForegroundRecoveryAdapterPorts {
  return {
    native: {
      processIncarnation: codexProcessIncarnationForPid,
      inventory: inspectCodexOpenRootRolloutInventory,
      identity: resolveCurrentNativeAgentSessionIdentity
    },
    turn: {
      terminalControl: terminalControlFromTakeover,
      storeDir: managedSessionStoreDirForConversation,
      withIdentity: withNativeAgentSessionIdentity,
      withSubmission: withTerminalBridgeSubmission
    },
    ledger: {
      load: loadTerminalBridgeDispatchLedger,
      save: saveTerminalBridgeDispatchLedger,
      matchesControl: terminalDispatchRecordMatchesControl,
      bindingFields: terminalBindingLedgerFields,
      previousSnapshotMatches: deferredCodexPreviousDispatchSnapshotMatches
    },
    authority: {
      assertFrozen: assertFrozenExplicitlyAbandonedPredecessorAuthority,
      assertTurnIdentity: assertNativeAgentIdentityForTurn
    },
    application: {
      abortBeforeInput: ({
        options,
        scope,
        boundary,
        reason,
        terminalInputNotStartedAt
      }) => deferredForegroundApplication(
        options,
        boundary.terminal
      ).abortBeforeInput({
        scope,
        boundary: deferredForegroundBoundaryProjection(boundary),
        reason,
        terminalInputNotStartedAt
      }),
      commit: ({ options, scope, boundary, identity, acceptedAt }) =>
        deferredForegroundApplication(options, boundary.terminal).commit({
          scope,
          boundary: deferredForegroundBoundaryProjection(boundary),
          identity,
          acceptedAt
        })
    }
  };
}

function observedHandoffAuthorityToken({
  terminal,
  identity,
  sourceSession,
  target
}: {
  terminal: ResolvedTerminalConversation;
  identity: NativeAgentSessionIdentity;
  sourceSession: ManagedSessionState;
  target: HumanObservedHandoffTargetSnapshot;
}): string {
  const exact = exactLifecycleProcessIdentity(terminal, identity);
  return projectObservedHandoffAuthorityToken({
    terminalId: terminal.conversationId,
    terminalControl: terminal.terminalControl,
    agent: terminal.agent,
    pid: terminal.pid,
    workspace: terminal.terminalControl.currentPath ?? cliCwd(),
    identity: exact,
    sourceSession,
    target
  });
}

function activeTurnHandoffDecisionToken({
  handoffToken,
  turn,
  ledger
}: {
  handoffToken: string;
  turn: Record<string, any>;
  ledger?: Record<string, any>;
}): string {
  const takeover = isRecord(turn.native_session_takeover)
    ? turn.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(turn);
  return projectActiveTurnHandoffDecisionToken({
    handoffToken,
    sessionId: sessionIdForConversation(turn),
    turnId: turnIdForConversation(turn),
    turnStatus: turn.status,
    turnUpdatedAt: turn.updated_at ?? null,
    currentMessageId:
      stringValue(takeover?.terminal_bridge_message_id) ??
      stringValue(submission?.message_id) ??
      null,
    ledgerGenerationId: stringValue(ledger?.generation_id) ?? null,
    ledgerMessageId: stringValue(ledger?.message_id) ?? null,
    ledgerStatus: stringValue(ledger?.status) ?? null
  });
}

const originalExpectedTerminalSelector =
  new WeakMap<Record<string, any>, string | undefined>();

const terminalListCliFacade = createTerminalListCliFacade({
  reconciliation: {
    reconcileIdleConversations,
    reconcileMonitors
  },
  discovery: {
    agentVersionForRunningProcess,
    codexLatentClearResumeObservation,
    codexManagedIdentityResolutionContext,
    codexProcessIncarnationForPid,
    createRuntimeTerminalAgentRegistry,
    createTerminalAgentBridge,
    createTerminalControlProvider,
    createTerminalProcessSource,
    inspectCodexOpenRootRolloutInventory,
    nativeInspectionComposerEmpty,
    observeCurrentNativeAgentSessionIdentity,
    terminalStatusForControl
  },
  store: {
    callbackRetryDisposition: (delivery) =>
      callbackOutboxService().retryDisposition(delivery),
    codexLingeringBeforeIdentityMatchesSession,
    isActiveStatus,
    isDiscoverableTmuxConversation,
    isVerifiedDeadTerminalAgentProcess,
    loadTerminalBridgeDispatchLedger,
    loadTerminalDispatchLedgerOwner,
    managedSessionStoreDirForConversation:
      managedSessionStoreDirForConversation,
    managedTurnsForSession,
    matchesConfiguredWorkspace,
    orphanedTerminalDispatchForRecovery,
    storeDirFromOptions,
    summarizeConversation,
    terminalBridgeEnabled,
    terminalBridgeSubmission,
    terminalControlFromTakeover,
    terminalDispatchRecordMatchesControl
  },
  authority: {
    activeTurnHandoffDecisionToken,
    assertManagedTerminalDispatchOwner,
    observeDeferredCodexAuthority,
    observedHandoffTargetResolution
  },
  policy: {
    activeTerminalDispatchStatuses: ACTIVE_TERMINAL_DISPATCH_STATUSES,
    approvalTtlMs: CLAUDE_SCREEN_APPROVAL_TTL_MS,
    finalDeferredTransferStatuses: FINAL_DEFERRED_TRANSFER_STATUSES,
    selectorCommands: SESSION_SELECTOR_COMMANDS,
    sessionSendBlockingStatuses: SESSION_SEND_BLOCKING_STATUSES,
    terminalDispatchReleaseStatuses: TERMINAL_DISPATCH_RELEASE_STATUSES,
    rememberOriginalExpectedTerminalSelector: (options, selector) => {
      originalExpectedTerminalSelector.set(options, selector);
    }
  }
});


function assertExpectedHandoffTokenUsesExactTerminalSelector({
  options,
  terminal
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
}): void {
  if (!stringValue(options.expectedTerminalToken)) {
    return;
  }
  const supplied = originalExpectedTerminalSelector.has(options)
    ? originalExpectedTerminalSelector.get(options)
    : stringValue(
        options.session ?? options.conversation ?? options.conversationId
      )?.trim();
  if (supplied !== terminal.conversationId) {
    throw new Error(
      "--expected-terminal-token is valid only with the exact full terminal " +
      "conversation selector advertised by AKK list"
    );
  }
}

async function observedExternalHandoffIdentity({
  options,
  terminal,
  sourceSession,
  resolvedIdentity,
  requireSafeTerminal = true
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  sourceSession: ManagedSessionState;
  resolvedIdentity?: NativeAgentSessionIdentity;
  requireSafeTerminal?: boolean;
}): Promise<{
  identity?: NativeAgentSessionIdentity;
  status: Awaited<ReturnType<TerminalAgentBridge["status"]>>;
}> {
  const bridge = createTerminalAgentBridge(options);
  const status = await bridge.status(
    terminal.agent,
    terminal.terminalControl,
    { runtime: terminalRuntimeForLiveIdentity({ terminal, physicalOnly: true }) }
  );
  if (requireSafeTerminal) {
    assertSafeTerminalSend(terminal.agent, status);
  }
  if (terminal.agent !== "codex") {
    return { identity: resolvedIdentity, status };
  }
  const sourceBinding = sourceSession.binding;
  const statusCard = terminal.adapter.observeThreadLifecycle?.({
    operation: { kind: "new_thread" },
    phase: "before",
    screen: status.screen.excerpt ?? ""
  });
  const statusCardId =
    statusCard?.status === "observed" &&
      isExactNativeThreadId(statusCard.nativeThreadId)
      ? statusCard.nativeThreadId.toLowerCase()
      : undefined;
  const sourceId = sourceBinding?.native_thread_id?.toLowerCase();
  if (statusCardId && sourceId && statusCardId !== sourceId) {
    const processUuid = sourceBinding?.native_process.process_uuid;
    const processBirth = sourceBinding?.native_process.process_birth;
    if (!processUuid || !processBirth) {
      return { identity: undefined, status };
    }
    const resolvedMatchesStatus =
      resolvedIdentity?.sessionId.toLowerCase() === statusCardId;
    return {
      identity: {
        sessionId: statusCardId,
        processUuid,
        processBirth,
        rollout: resolvedMatchesStatus ? resolvedIdentity?.rollout : undefined,
        evidence: resolvedMatchesStatus
          ? `${resolvedIdentity?.evidence ?? "native_thread_boundary"}+codex_status_card`
          : statusCard?.evidence ?? "codex_status_card"
      },
      status
    };
  }
  return { identity: resolvedIdentity, status };
}

type ObservedHandoffTargetResolution =
  | {
      status: "eligible";
      session?: ManagedSessionState;
      snapshot: HumanObservedHandoffTargetSnapshot;
    }
  | { status: "blocked"; reason: string };

function observedHandoffTargetResolution({
  storeDir,
  agent,
  workspace,
  nativeThreadId,
  sourceSessionId
}: {
  storeDir: string;
  agent: ExecutorKind;
  workspace: string;
  nativeThreadId: string;
  sourceSessionId: string;
}): ObservedHandoffTargetResolution {
  const matches = listManagedSessions(storeDir).filter((session) =>
    session.session_id !== sourceSessionId &&
    session.agent === agent &&
    session.binding?.native_thread_id?.toLowerCase() === nativeThreadId &&
    path.resolve(session.workspace) === path.resolve(workspace)
  );
  if (matches.length > 1) {
    return {
      status: "blocked",
      reason:
        `native thread ${nativeThreadId} is claimed by multiple managed Sessions`
    };
  }
  const target = matches[0];
  if (!target) {
    return { status: "eligible", snapshot: { state: "absent" } };
  }
  if (
    !target.binding ||
    target.status !== "detached" ||
    terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(storeDir, target)
  ) {
    return {
      status: "blocked",
      reason:
        `managed Session ${target.session_id} cannot be adopted from ` +
        `${target.status} state or while its lifecycle is unresolved`
    };
  }
  try {
    assertManagedSessionCanStartTurn(
      managedTurnsForSession(storeDir, target.session_id)
    );
  } catch (error) {
    return {
      status: "blocked",
      reason:
        `managed Session ${target.session_id} has unresolved work: ` +
        `${error instanceof Error ? error.message : String(error)}`
    };
  }
  return {
    status: "eligible",
    session: target,
    snapshot: {
      state: "detached",
      session_id: target.session_id,
      revision: managedSessionRevision(target),
      status: "detached",
      binding_token: managedSessionBindingToken(target)
    }
  };
}

async function maybeAdoptObservedExternalThread({
  options,
  terminal,
  sourceSession,
  resolvedIdentity,
  storeDir
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  sourceSession?: ManagedSessionState;
  resolvedIdentity?: NativeAgentSessionIdentity;
  storeDir: string;
}): Promise<{
  session?: ManagedSessionState;
  identity?: NativeAgentSessionIdentity;
  transition?: NativeThreadTransition;
  adopted: boolean;
}> {
  if (!sourceSession?.binding) {
    return { identity: resolvedIdentity, adopted: false };
  }
  const observed = await observedExternalHandoffIdentity({
    options,
    terminal,
    sourceSession,
    resolvedIdentity,
    // Snapshot-bound terminal actions apply their own stricter boundary
    // before any input.  In particular, a post-/clear Codex composer can be
    // safely empty while the passive activity classifier is still unknown;
    // do not force the unrelated external-handoff idle check before the
    // deferred candidate boundary gets a chance to revalidate it.
    requireSafeTerminal: !stringValue(options.expectedTerminalToken)
  });
  const identity = observed.identity;
  const conflictKind = managedBindingConflictKindForResolvedTerminal({
    storeDir,
    session: sourceSession,
    terminal,
    identity
  });
  if (conflictKind !== "live_external_thread_change") {
    return { identity, adopted: false };
  }
  assertTerminalLifecycleReady({
    options,
    terminal,
    terminalStatus: observed.status
  });
  if (!identity || !isExactNativeThreadId(identity.sessionId)) {
    throw new Error(
      "the externally selected native thread has no exact supported identity"
    );
  }
  if (terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(storeDir, sourceSession)) {
    throw new Error(
      `managed Session ${sourceSession.session_id} has an unresolved native-thread transition`
    );
  }
  assertManagedSessionCanStartTurn(
    managedTurnsForSession(storeDir, sourceSession.session_id)
  );
  if (
    terminal.agent === "codex"
      ? !codexComposerEmpty(observed.status.screen.excerpt)
      : !claudeComposerEmpty(observed.status.screen.excerpt)
  ) {
    throw new Error(
      "external handoff adoption requires an exact empty idle composer"
    );
  }
  if (terminal.agent === "codex") {
    await assertCodexComposerReadyForAutomatedInput({
      options,
      terminalControl: terminal.terminalControl
    });
  }
  const targetNativeThreadId = identity.sessionId.toLowerCase();
  const targetResolution = observedHandoffTargetResolution({
    storeDir,
    agent: terminal.agent,
    workspace: terminal.terminalControl.currentPath ?? cliCwd(),
    nativeThreadId: targetNativeThreadId,
    sourceSessionId: sourceSession.session_id
  });
  const expectedTerminalToken = stringValue(options.expectedTerminalToken);
  if (targetResolution.status === "blocked") {
    if (expectedTerminalToken) {
      throw new Error(
        "live source or target Session snapshot changed after the handoff was " +
        "listed; refresh AKK list"
      );
    }
    throw new Error(targetResolution.reason);
  }
  const freshHandoffToken = observedHandoffAuthorityToken({
    terminal,
    identity,
    sourceSession,
    target: targetResolution.snapshot
  });
  if (
    expectedTerminalToken &&
    expectedTerminalToken !== freshHandoffToken
  ) {
    throw new Error(
      "live source, target, or terminal identity changed after the handoff " +
      "was listed; refresh AKK list"
    );
  }
  const targetSession = targetResolution.session;
  await assertNativeThreadHasExclusiveOwnership({
    options,
    agent: terminal.agent,
    currentPid: terminal.pid,
    nativeThreadId: targetNativeThreadId,
    storeDir,
    terminalControl: terminal.terminalControl,
    excludedManagedSessionId: targetSession?.session_id
  });
  const adapterVersion = required(
    stringValue(agentVersionForRunningProcess(terminal.agent, terminal.pid, options)),
    "external handoff adoption requires the exact running agent version"
  );
  const capability = terminal.adapter.probeThreadLifecycle?.(adapterVersion);
  if (capability?.status !== "supported") {
    throw new Error(
      capability?.reason ?? "external handoff adoption is unsupported for this agent version"
    );
  }
  const now = cliNow();
  const sourceBinding = sourceSession.binding;
  const targetSessionId = targetSession?.session_id ?? createManagedSessionId(now);
  const transitionId = createNativeThreadTransitionId();
  const exactIdentity = exactLifecycleProcessIdentity(terminal, identity);
  const nextBinding = terminalBindingFrom({
    terminalId: terminal.conversationId,
    terminalControl: terminal.terminalControl,
    pid: terminal.pid,
    nativeThreadId: targetNativeThreadId,
    processUuid: exactIdentity.processUuid,
    processBirth: exactIdentity.processBirth,
    rollout: exactIdentity.rollout,
    evidence: `${exactIdentity.evidence}+human_observed`,
    generation: (targetSession?.binding?.generation ?? 0) + 1,
    now
  });
  const previousLedger = loadTerminalBridgeDispatchLedger(
    terminal.terminalControl
  );
  let transition: NativeThreadTransition = {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: transitionId,
    operation: "adopt_external_thread",
    origin: "human_observed",
    terminal_input_sent: false,
    status: "prepared",
    terminal_id: terminal.conversationId,
    agent: terminal.agent,
    workspace: terminal.terminalControl.currentPath ?? cliCwd(),
    source_session_id: sourceSession.session_id,
    source_expected_revision: managedSessionRevision(sourceSession),
    source_previous_last_transition_id: sourceSession.last_transition_id,
    target_session_id: targetSessionId,
    target_expected_revision: targetSession
      ? managedSessionRevision(targetSession)
      : null,
    target_native_thread_id: targetNativeThreadId,
    before_native_thread_id: sourceBinding.native_thread_id as string,
    before_process_uuid: sourceBinding.native_process.process_uuid as string,
    before_process_started_at: exactIdentity.processStartedAt,
    before_process_birth: sourceBinding.native_process.process_birth,
    before_process_rollout: sourceBinding.native_process.rollout,
    before_binding: sourceBinding,
    adapter_version: adapterVersion,
    command_fingerprint: HUMAN_OBSERVED_HANDOFF_FINGERPRINT,
    dispatcher_pid: cliPid(),
    prepared_at: now.toISOString()
  };
  transition = saveNativeThreadTransition(storeDir, transition, {
    expectedRevision: null
  });
  if (
    cliEnv().AKK_TEST_EXIT_AFTER_HANDOFF_TRANSITION_BEFORE_LEDGER === "1"
  ) {
    cliExit(88);
  }
  saveLifecycleTerminalDispatchLedger(terminal.terminalControl,
    lifecycleLedger(transition, storeDir,
      { phase: "prepared", previous: previousLedger, targetNativeThreadId }),
    { expectedTransitionId: null });
  if (cliEnv().AKK_TEST_EXIT_AFTER_LIFECYCLE_PREPARED === "1") {
    cliExit(86);
  }
  const sourceTransitioning = saveManagedSession(storeDir, {
    ...sourceSession,
    status: "transitioning",
    last_transition_id: transitionId,
    updated_at: now.toISOString()
  }, { expectedRevision: managedSessionRevision(sourceSession) });
  try {
    const reObserved = await observedExternalHandoffIdentity({
      options,
      terminal,
      sourceSession: sourceTransitioning,
      resolvedIdentity: await resolveCurrentNativeAgentSessionIdentity({
        options,
        agent: terminal.agent,
        pid: terminal.pid,
        cwd: terminal.terminalControl.currentPath,
        preferredSessionId: targetNativeThreadId,
        allowedCompanionIdentity: codexIdentityFence({
          sessionId: sourceBinding.native_thread_id as string,
          processUuid: sourceBinding.native_process.process_uuid,
          processBirth: sourceBinding.native_process.process_birth,
          rollout: sourceBinding.native_process.rollout,
          evidence: sourceBinding.native_process.evidence
        }),
        allowedAdditionalIdentities: []
      })
    });
    const reObservedExact = reObserved.identity
      ? exactLifecycleProcessIdentity(terminal, reObserved.identity)
      : undefined;
    if (
      reObservedExact?.sessionId.toLowerCase() !== targetNativeThreadId ||
      reObservedExact.processUuid !== nextBinding.native_process.process_uuid ||
      reObservedExact.processBirth !== nextBinding.native_process.process_birth ||
      JSON.stringify(reObservedExact.rollout ?? null) !==
        JSON.stringify(nextBinding.native_process.rollout ?? null)
    ) {
      throw new Error("live native thread changed during external handoff adoption");
    }
    await assertNativeThreadHasExclusiveOwnership({
      options,
      agent: terminal.agent,
      currentPid: terminal.pid,
      nativeThreadId: targetNativeThreadId,
      storeDir,
      terminalControl: terminal.terminalControl,
      excludedManagedSessionId: targetSession?.session_id
    });
    transition = saveNativeThreadTransition(storeDir, {
      ...transition,
      status: "verified",
      after_binding: nextBinding,
      verified_at: cliNow().toISOString()
    }, { expectedRevision: nativeThreadTransitionRevision(transition) });
    if (
      cliEnv().AKK_TEST_EXIT_AFTER_HANDOFF_VERIFIED_TRANSITION_BEFORE_LEDGER ===
        "1"
    ) {
      cliExit(89);
    }
    saveLifecycleTerminalDispatchLedger(terminal.terminalControl,
      lifecycleLedger(transition, storeDir, { phase: "verified", binding: sourceBinding }), {
      expectedTransitionId: transitionId,
      expectedStatus: "prepared"
    });
    if (cliEnv().AKK_TEST_EXIT_AFTER_LIFECYCLE_VERIFIED === "1") {
      cliExit(87);
    }
    const committedTarget = commitVerifiedLifecycleTransition(
      storeDir,
      transition,
      cliNow().toISOString()
    );
    transition = saveNativeThreadTransition(storeDir, {
      ...transition,
      status: "committed",
      committed_at: cliNow().toISOString()
    }, { expectedRevision: nativeThreadTransitionRevision(transition) });
    saveLifecycleTerminalDispatchLedger(terminal.terminalControl,
      lifecycleLedger(transition, storeDir, {
        phase: "resolved_with_binding", at: cliNow().toISOString(),
        binding: committedTarget.binding,
        reason: "verified human-observed native thread handoff committed"
      }), {
      expectedTransitionId: transitionId,
      expectedStatus: "verified"
    });
    runtimeLog("info", "human_observed_handoff_adopted", {
      transition_id: transitionId,
      terminal_id: terminal.conversationId,
      source_session_id: sourceSession.session_id,
      target_session_id: committedTarget.session_id,
      native_thread_id: targetNativeThreadId,
      terminal_input_sent: false
    });
    return {
      session: committedTarget,
      identity: exactIdentity,
      transition,
      adopted: true
    };
  } catch (error) {
    const failedAt = cliNow().toISOString();
    const durable = loadNativeThreadTransition(storeDir, transitionId);
    if (durable.status === "verified" || durable.status === "committed") {
      throw error;
    }
    const uncertain = saveNativeThreadTransition(storeDir, {
      ...durable,
      status: "uncertain",
      uncertain_at: failedAt,
      error: error instanceof Error ? error.message : String(error),
      do_not_retry: true
    }, { expectedRevision: nativeThreadTransitionRevision(durable) });
    saveManagedSession(storeDir, {
      ...sourceTransitioning,
      status: "quarantined",
      quarantine_reason: "human-observed handoff could not be revalidated",
      updated_at: failedAt
    }, { expectedRevision: managedSessionRevision(sourceTransitioning) });
    saveLifecycleTerminalDispatchLedger(terminal.terminalControl,
      lifecycleLedger(uncertain, storeDir, {
        phase: "uncertain", at: failedAt,
        reason: "human-observed handoff could not be revalidated"
      }), { expectedTransitionId: transitionId });
    throw error;
  }
}

async function assertObservedHandoffTransportBoundary({
  options,
  terminal,
  transition,
  requireEmptyComposer
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  transition: NativeThreadTransition;
  requireEmptyComposer: boolean;
}): Promise<void> {
  const storeDir = storeDirFromOptions(options);
  const durable = loadNativeThreadTransition(
    storeDir,
    transition.transition_id
  );
  if (
    durable.operation !== "adopt_external_thread" ||
    durable.origin !== "human_observed" ||
    durable.terminal_input_sent !== false ||
    durable.status !== "committed" ||
    !durable.source_session_id ||
    !durable.before_binding ||
    !durable.after_binding ||
    JSON.stringify(durable.after_binding) !==
      JSON.stringify(transition.after_binding)
  ) {
    throw new Error("human-observed handoff changed before terminal transport");
  }
  const source = loadManagedSession(storeDir, durable.source_session_id);
  const target = loadManagedSession(storeDir, durable.target_session_id);
  if (
    source.status !== "detached" ||
    source.last_transition_id !== durable.transition_id ||
    JSON.stringify(source.binding) !== JSON.stringify(durable.before_binding) ||
    target.status !== "bound" ||
    target.last_transition_id !== durable.transition_id ||
    JSON.stringify(target.binding) !== JSON.stringify(durable.after_binding)
  ) {
    throw new Error("human-observed handoff Session authority changed before send");
  }
  const targetId = durable.after_binding.native_thread_id;
  if (!targetId) {
    throw new Error("human-observed handoff target identity is incomplete");
  }
  const resolved = await resolveCurrentNativeAgentSessionIdentity({
    options,
    agent: terminal.agent,
    pid: terminal.pid,
    cwd: terminal.terminalControl.currentPath,
    preferredSessionId: targetId,
    allowedCompanionIdentity: codexIdentityFence({
      sessionId: durable.before_native_thread_id,
      processUuid: durable.before_process_uuid,
      processBirth: durable.before_process_birth,
      rollout: durable.before_process_rollout,
      evidence: durable.before_binding.native_process.evidence
    }),
    allowedAdditionalIdentities: []
  });
  const bridge = createTerminalAgentBridge(options);
  const status = await bridge.status(
    terminal.agent,
    terminal.terminalControl,
    { runtime: terminalRuntimeForLiveIdentity({ terminal, physicalOnly: true }) }
  );
  if (requireEmptyComposer) {
    assertSafeTerminalSend(terminal.agent, status);
  } else {
    const displayName = executorDefinitionForKind(terminal.agent).displayName;
    const approval = isRecord(status?.approval_state)
      ? status.approval_state
      : undefined;
    if (status?.reachable !== true) {
      throw new Error(`${displayName} terminal status is unavailable`);
    }
    if (approval?.blocked === true) {
      throw new Error(
        stringValue(approval.reason) ??
          `${displayName} is waiting at a permission dialog`
      );
    }
    // With an exact draft in the composer, native TUIs can classify the screen
    // as `unknown` instead of `idle`. Exact draft materialization is proven by
    // the bridge before Enter, so only a positively busy state is unsafe here.
    if (
      status.activity_state !== "idle" &&
      status.activity_state !== "unknown"
    ) {
      throw new Error(
        `${displayName} terminal became ${
          stringValue(status.activity_state) ?? "unknown"
        } before handoff submission`
      );
    }
  }
  let liveIdentity = resolved;
  if (terminal.agent === "codex") {
    const foreground = terminal.adapter.observeThreadLifecycle?.({
      operation: { kind: "new_thread" },
      phase: "before",
      screen: status.screen.excerpt ?? ""
    });
    const foregroundId =
      foreground?.status === "observed" &&
        isExactNativeThreadId(foreground.nativeThreadId)
        ? foreground.nativeThreadId.toLowerCase()
        : undefined;
    if (foregroundId && foregroundId !== targetId.toLowerCase()) {
      throw new Error(
        "Codex foreground native thread changed after handoff adoption"
      );
    }
    if (!durable.after_binding.native_process.rollout) {
      if (
        requireEmptyComposer &&
        foregroundId !== targetId.toLowerCase()
      ) {
        throw new Error(
          "status-card-only Codex handoff lost its exact foreground identity"
        );
      }
      liveIdentity = resolved?.sessionId.toLowerCase() === targetId.toLowerCase()
        ? resolved
        : {
            sessionId: targetId,
            processUuid: durable.after_binding.native_process.process_uuid,
            processBirth: durable.after_binding.native_process.process_birth,
            evidence: foreground?.evidence ?? "codex_status_card"
          };
    } else if (
      !liveIdentity ||
      liveIdentity.sessionId.toLowerCase() !== targetId.toLowerCase()
    ) {
      throw new Error(
        "Codex handoff rollout identity changed before terminal transport"
      );
    }
  }
  if (!liveIdentity) {
    throw new Error("human-observed handoff identity is unavailable before send");
  }
  const exact = exactLifecycleProcessIdentity(terminal, liveIdentity);
  if (
    exact.sessionId.toLowerCase() !== targetId.toLowerCase() ||
    exact.processUuid !== durable.after_binding.native_process.process_uuid ||
    exact.processBirth !== durable.after_binding.native_process.process_birth ||
    JSON.stringify(exact.rollout ?? null) !==
      JSON.stringify(durable.after_binding.native_process.rollout ?? null)
  ) {
    throw new Error("human-observed handoff identity changed before send");
  }
  if (requireEmptyComposer) {
    const empty = terminal.agent === "codex"
      ? codexComposerEmpty(status.screen.excerpt)
      : claudeComposerEmpty(status.screen.excerpt);
    if (!empty) {
      throw new Error(
        "human-observed handoff composer changed before text injection"
      );
    }
    if (terminal.agent === "codex") {
      await assertCodexComposerReadyForAutomatedInput({
        options,
        terminalControl: terminal.terminalControl
      });
    }
  }
}

function lifecycleBindingToken({
  session,
  terminal,
  identity
}: {
  session?: ManagedSessionState;
  terminal: ResolvedTerminalConversation;
  identity?: NativeAgentSessionIdentity;
}): string {
  if (session) {
    return managedSessionBindingToken(session);
  }
  const codexIncarnation =
    terminal.agent === "codex" && !identity
      ? codexProcessIncarnationForPid(terminal.pid)
      : undefined;
  return unmanagedTerminalBindingToken({
    terminalId: terminal.conversationId,
    terminalControl: terminal.terminalControl,
    agent: terminal.agent,
    pid: terminal.pid,
    workspace: terminal.terminalControl.currentPath ?? cliCwd(),
    nativeThreadId: identity?.sessionId,
    processUuid: identity?.processUuid ?? codexIncarnation?.processUuid,
    processBirth: identity?.processBirth ?? codexIncarnation?.processBirth,
    rollout: identity?.rollout
  });
}

function lifecycleBindingTokens({
  session,
  terminal,
  identity
}: {
  session?: ManagedSessionState;
  terminal: ResolvedTerminalConversation;
  identity?: NativeAgentSessionIdentity;
}): string[] {
  const current = lifecycleBindingToken({ session, terminal, identity });
  const codexIncarnation = terminal.agent === "codex" && !identity
    ? codexProcessIncarnationForPid(terminal.pid)
    : undefined;
  const legacy = session
    ? legacyManagedSessionBindingToken(session)
    : legacyUnmanagedTerminalBindingToken({
        terminalId: terminal.conversationId,
        terminalControl: terminal.terminalControl,
        agent: terminal.agent,
        pid: terminal.pid,
        workspace: terminal.terminalControl.currentPath ?? cliCwd(),
        nativeThreadId: identity?.sessionId,
        processUuid: identity?.processUuid ?? codexIncarnation?.processUuid,
        processBirth: identity?.processBirth ?? codexIncarnation?.processBirth,
        rollout: identity?.rollout
      });
  return [...new Set([current, legacy])];
}

function agentVersionForRunningProcess(
  agent: ExecutorKind,
  pid: number,
  options: Record<string, any>
): string | undefined {
  const injected = cliDependencies<CliCommandOptions>().agentVersionForRunningProcess;
  if (injected) {
    return injected(agent, pid, options);
  }
  const fixture = options.agentVersionsJson
    ? parseJsonOption(options.agentVersionsJson, "--agent-versions-json")
    : undefined;
  if (isRecord(fixture)) {
    const byPid = stringValue(fixture[String(pid)]);
    const byAgent = stringValue(fixture[agent]);
    return byPid ?? byAgent;
  }
  const lsof = resolveOptionalExecutable("lsof");
  if (!lsof) {
    return undefined;
  }
  const result = spawnSync(
    lsof,
    ["-a", "-p", String(pid), "-d", "txt", "-Fn"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }
  );
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const paths = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
  const pathVersions = paths.flatMap((executablePath): string[] => {
    const pattern = agent === "codex"
      ? /\/releases\/(\d+\.\d+\.\d+)(?:-[^/]*)?\/bin\/codex$/u
      : /\/claude\/versions\/(\d+\.\d+\.\d+)$/u;
    const match = pattern.exec(executablePath);
    return match ? [match[1]] : [];
  });
  const versions = [...new Set(pathVersions)];
  return versions.length === 1 ? versions[0] : undefined;
}

function assertTerminalLifecycleReady({
  options,
  terminal,
  terminalStatus
}: {
  options: Record<string, any>;
  terminal: TerminalDispatchTerminal;
  terminalStatus: Awaited<ReturnType<TerminalAgentBridge["status"]>>;
}): void {
  if (
    terminalStatus.reachable !== true ||
    terminalStatus.activity_state !== "idle" ||
    terminalStatus.approval_state.blocked === true
  ) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} is not at a verified idle prompt ` +
      `(${terminalStatus.activity_state}: ${terminalStatus.activity_reason})`
    );
  }
  const blockers = terminalListCliFacade.terminalIncarnationBlockingTurns(
    storeDirFromOptions(options),
    terminal.terminalControl
  );
  if (blockers.length > 0) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} still has unresolved Turn ` +
      `${turnIdForConversation(blockers[0])} (${blockers[0].status})`
    );
  }
  const ledger = resolveTerminalDispatchLedgerPaneIncarnation(
    terminal.terminalControl,
    reconcilePreparedTerminalDispatchLedger(
      terminal.terminalControl,
      loadTerminalBridgeDispatchLedger(terminal.terminalControl)
    )
  );
  if (
    terminalDispatchLedgerLooksLifecycle(ledger) &&
    ledger?.status !== "resolved"
  ) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} has unresolved lifecycle ` +
      `transition ${stringValue(ledger?.transition_id) ?? "with invalid identity"}`
    );
  }
  if (
    ledger &&
    [
      "prepared",
      "text_injected",
      "enter_dispatched",
      "dispatching",
      "not_accepted",
      "uncertain"
    ].includes(String(ledger.status))
  ) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} has an unresolved ` +
      `${String(ledger.kind ?? "turn")} operation (${String(ledger.status)})`
    );
  }
  if (ledger && ["submitted", "agent_accepted"].includes(String(ledger.status))) {
    const owner = loadTerminalDispatchLedgerOwner(ledger);
    if (!owner || !TERMINAL_DISPATCH_RELEASE_STATUSES.has(owner.status)) {
      throw new Error(
        `terminal ${terminal.terminalControl.target} still has a submitted operation`
      );
    }
  }
}

async function resolveLifecycleTerminal(
  options: Record<string, any>
): Promise<ResolvedTerminalConversation> {
  const terminalId = required(
    stringValue(options.terminal ?? options.conversation ?? options.conversationId),
    "--terminal is required"
  );
  const terminal = await createTerminalAgentBridge(options)
    .resolveConversationId(terminalId);
  if (!terminal || terminal.conversationId !== terminalId) {
    throw new Error(
      "native thread lifecycle requires the exact terminal_id returned by AKK list"
    );
  }
  return terminal;
}

function nativeThreadVerificationAdapterPorts(
  options: Record<string, any>,
  terminal: ResolvedTerminalConversation
): NativeThreadVerificationAdapterPorts {
  return {
    createBridge: () => createTerminalAgentBridge(options),
    loadClaudeAgentRows: () =>
      loadClaudeAgentRows(options, { required: true }),
    runningVersion: () => agentVersionForRunningProcess(
      terminal.agent,
      terminal.pid,
      options
    ),
    runtimeForIdentity: (identity) =>
      terminalRuntimeForLiveIdentity({ terminal, identity }),
    emptyRuntime: () => terminalRuntimeForLiveIdentity({
      terminal,
      expectedEmptyNativeSession: true
    }),
    physicalRuntime: () => terminalRuntimeForLiveIdentity({
      terminal,
      physicalOnly: true
    }),
    resolveIdentity: (
      preferredSessionId,
      allowedCompanionIdentity,
      allowedAdditionalIdentities
    ) => resolveCurrentNativeAgentSessionIdentity({
      options,
      agent: terminal.agent,
      pid: terminal.pid,
      cwd: terminal.terminalControl.currentPath,
      preferredSessionId,
      allowedCompanionIdentity,
      allowedAdditionalIdentities: [...allowedAdditionalIdentities]
    }),
    sleep: cliSleep
  };
}

function nativeThreadLifecycleQueryPorts(
  options: Record<string, any>
): NativeThreadLifecycleQueryPorts {
  let resolvedStoreDir: string | undefined;
  const storeDir = (): string =>
    resolvedStoreDir ??= storeDirFromOptions(options);
  return Object.freeze({
    cwd: cliCwd,
    listManagedSessions: () => listManagedSessions(storeDir()),
    loadNativeThreadTransition: (transitionId) =>
      loadNativeThreadTransition(storeDir(), transitionId),
    blockingTurns: (sessionId) => managedTurnsForSession(storeDir(), sessionId)
      .filter((turn) => SESSION_SEND_BLOCKING_STATUSES.has(turn.status))
      .map((turn) => ({
        turnId: turnIdForConversation(turn),
        status: turn.status
      })),
    assertStoreAuthority: (terminalControl, nativeThreadId) =>
      assertTerminalNativeThreadStoreAuthority({
        terminalControl,
        nativeThreadId,
        storeDir: storeDir()
      }),
    runningVersion: (terminal) => agentVersionForRunningProcess(
      terminal.agent,
      terminal.pid,
      options
    ),
    candidateProvider: (agent) => agent === "codex"
      ? codexThreadLifecycleProvider(options)
      : createClaudeThreadLifecycleCandidateProvider({
          claudeHome: expandHome(options.claudeHome)
        }),
    sessionOwnerIsConclusivelyInactive: (session, terminal, identity) =>
      managedSessionOwnerIsConclusivelyInactive({
        session,
        terminal,
        identity
      }),
    rootActiveProcesses: async (agent) => {
      const adapter = createRuntimeTerminalAgentRegistry(options).require(agent);
      const snapshots = await createTerminalProcessSource(options)
        .listProcessSnapshots(
          (snapshot) => adapter.classifyProcess(snapshot) !== undefined,
          { includeCwd: true, includeAncestors: true }
        );
      const processes = snapshots.flatMap((snapshot): ActiveTerminalProcess[] => {
        const classified = adapter.classifyProcess(snapshot);
        return classified ? [{ ...classified, agent }] : [];
      });
      return selectRootTerminalProcesses(processes);
    },
    resolveProcessIdentity: (agent, pid, cwd) =>
      resolveCurrentNativeAgentSessionIdentity({ options, agent, pid, cwd }),
    loadClaudeAgentRows: () => loadClaudeAgentRows(options, { required: true }),
    workspaceRelationship: verifiedWorkspaceRelationship
  });
}

function verifiedWorkspaceRelationship(
  targetWorkspace: unknown,
  candidateWorkspace: unknown
): "same" | "different" | "unknown" {
  const target = stringValue(targetWorkspace);
  const candidate = stringValue(candidateWorkspace);
  if (
    !target ||
    !candidate ||
    !path.isAbsolute(target) ||
    !path.isAbsolute(candidate)
  ) {
    return "unknown";
  }
  try {
    const targetReal = fs.realpathSync(target);
    const candidateReal = fs.realpathSync(candidate);
    if (!fs.statSync(targetReal).isDirectory() ||
        !fs.statSync(candidateReal).isDirectory()) {
      return "unknown";
    }
    return targetReal === candidateReal ? "same" : "different";
  } catch {
    return "unknown";
  }
}

async function assertNativeThreadHasExclusiveOwnership({
  options,
  agent,
  currentPid,
  nativeThreadId,
  storeDir,
  terminalControl,
  excludedManagedSessionId,
  allowedManagedSessionIds = []
}: {
  options: Record<string, any>;
  agent: ExecutorKind;
  currentPid: number;
  nativeThreadId: string;
  storeDir: string;
  terminalControl: TerminalControlRef;
  excludedManagedSessionId?: string;
  allowedManagedSessionIds?: string[];
}): Promise<void> {
  await assertNativeThreadHasExclusiveOwnershipFromQuery({
    terminalControl,
    agent,
    currentPid,
    nativeThreadId,
    excludedManagedSessionId,
    allowedManagedSessionIds
  }, nativeThreadLifecycleQueryPorts({ ...options, storeDir }));
}

async function assertLifecycleTargetHasExclusiveOwnership({
  options,
  terminal,
  transition,
  storeDir
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  transition: NativeThreadTransition;
  storeDir: string;
}): Promise<void> {
  const afterBinding = transition.after_binding;
  const nativeThreadId = afterBinding?.native_thread_id;
  if (
    !afterBinding ||
    !nativeThreadId ||
    !isExactNativeThreadId(nativeThreadId) ||
    afterBinding.native_process.pid !== terminal.pid ||
    !terminalControlAliasMatches(
      afterBinding.terminal_id,
      afterBinding.terminal_control,
      terminal.conversationId,
      terminal.terminalControl
    )
  ) {
    throw new Error(
      "cannot exclude the current lifecycle process without an exact after_binding"
    );
  }
  await assertNativeThreadHasExclusiveOwnership({
    options,
    agent: transition.agent,
    currentPid: terminal.pid,
    nativeThreadId,
    storeDir,
    terminalControl: terminal.terminalControl,
    excludedManagedSessionId: transition.target_session_id
  });
}

async function currentLifecycleSnapshot(
  options: Record<string, any>,
  terminal: ResolvedTerminalConversation,
  { materialize = false }: { materialize?: boolean } = {}
) {
  const storeDir = storeDirFromOptions(options);
  const codexIdentityContext = terminal.agent === "codex"
    ? codexManagedIdentityResolutionContext({ storeDir, terminal })
    : undefined;
  const claimedCodexCompanions = codexIdentityContext?.companions ?? {
    additional: []
  };
  const observedIdentity = await resolveCurrentNativeAgentSessionIdentity({
    options,
    agent: terminal.agent,
    pid: terminal.pid,
    cwd: terminal.terminalControl.currentPath,
    preferredSessionId: codexIdentityContext?.preferredSessionId,
    allowedCompanionIdentity: claimedCodexCompanions.primary,
    allowedAdditionalIdentities: claimedCodexCompanions.additional
  });
  let session = materialize
    ? materializeCurrentManagedSession({
        options,
        terminal,
        identity: observedIdentity
      })
    : boundManagedSessionForTerminal({
        storeDir,
        terminal,
        identity: observedIdentity
      });
  let identity = session
    ? logicalIdentityForManagedSession({
        storeDir,
        session,
        observedIdentity
      })
    : observedIdentity;
  if (materialize && session) {
    session = refineManagedSessionNativeIdentity({
      storeDir,
      session,
      terminalControl: terminal.terminalControl,
      identity
    });
    identity = logicalIdentityForManagedSession({
      storeDir,
      session,
      observedIdentity
    });
  }
  const codexCompanions = terminal.agent === "codex" && session
    ? codexAllowedCompanionSetForManagedSession({ storeDir, session })
    : claimedCodexCompanions;
  if (materialize && identity?.sessionId) {
    await assertNativeThreadHasExclusiveOwnership({
      options,
      agent: terminal.agent,
      currentPid: terminal.pid,
      nativeThreadId: identity.sessionId,
      storeDir,
      terminalControl: terminal.terminalControl,
      excludedManagedSessionId: session?.session_id
    });
  }
  const version = agentVersionForRunningProcess(
    terminal.agent,
    terminal.pid,
    options
  );
  const adapter = createRuntimeTerminalAgentRegistry(options)
    .require(terminal.agent);
  const capabilities = adapter.probeThreadLifecycle?.(version) ?? {
    status: "unsupported" as const,
    agentVersion: version,
    newThread: false,
    resumeExact: false,
    reason: `${adapter.displayName} has no native-thread lifecycle adapter`
  };
  const bindingTokens = lifecycleBindingTokens({ session, terminal, identity });
  return {
    identity,
    runtimeIdentity: observedIdentity,
    codexCompanions,
    session,
    version,
    adapter,
    capabilities,
    bindingToken: bindingTokens[0],
    bindingTokens
  };
}

async function runListResumableThreads(options) {
  const terminal = await resolveLifecycleTerminal(options);
  const snapshot = await currentLifecycleSnapshot(options, terminal);
  if (
    snapshot.capabilities.status !== "supported" ||
    snapshot.capabilities.resumeExact !== true
  ) {
    throw new Error(snapshot.capabilities.reason);
  }
  const candidates = await resumableNativeThreadCandidates({
    terminal,
    currentIdentity: snapshot.identity
  }, nativeThreadLifecycleQueryPorts(options));
  const storeDir = storeDirFromOptions(options);
  const workspace = path.resolve(
    terminal.terminalControl.currentPath ?? cliCwd()
  );
  const selectionScope =
    stringValue(options.selectionScope) ?? "cli:unscoped";
  const resumeSnapshot = createNativeThreadResumeSnapshot({
    storeDir,
    selectionScope,
    terminalId: terminal.conversationId,
    agent: terminal.agent,
    workspace,
    terminalControl: terminal.terminalControl,
    currentSessionId: snapshot.session?.session_id,
    currentNativeThreadId:
      snapshot.identity?.sessionId ??
      snapshot.session?.binding?.native_thread_id,
    expectedBindingToken: snapshot.bindingToken,
    terminalActionFingerprint: terminalActionFingerprint(
      loadTerminalBridgeDispatchLedger(terminal.terminalControl)
    ),
    candidates
  });
  saveNativeThreadResumeSnapshot(
    terminalBridgeRuntimeDir(),
    storeDir,
    resumeSnapshot
  );
  const snapshotRows = new Map(
    resumeSnapshot.rows.map((row) => [row.native_thread_id, row])
  );
  const resumeAction = (candidate: NativeThreadCandidate) => ({
    tool: "agent_knock_knock_resume_thread",
    arguments: {
      terminal_id: terminal.conversationId,
      native_thread_id: candidate.native_thread_id,
      expected_binding_token: snapshot.bindingToken,
      ...(candidate.candidate_token
        ? { candidate_token: candidate.candidate_token }
        : {})
    },
    requires_user_intent: true
  });
  const previousCandidate = previousCommittedResumeCandidateFromQuery({
    terminal,
    currentSession: snapshot.session,
    candidates
  }, nativeThreadLifecycleQueryPorts({ ...options, storeDir }));
  const previousSnapshotRow = previousCandidate
    ? snapshotRows.get(previousCandidate.native_thread_id)
    : undefined;
  printJson({
    terminal_id: terminal.conversationId,
    agent: terminal.agent,
    workspace,
    current_session_id: snapshot.session?.session_id ?? null,
    current_native_thread_id:
      snapshot.identity?.sessionId ??
      snapshot.session?.binding?.native_thread_id ??
      null,
    expected_binding_token: snapshot.bindingToken,
    capability: snapshot.capabilities,
    selection_snapshot: {
      schema: resumeSnapshot.schema,
      version: resumeSnapshot.version,
      snapshot_id: resumeSnapshot.snapshot_id,
      created_at: resumeSnapshot.created_at,
      expires_at: resumeSnapshot.expires_at,
      scope: "exact selection snapshot, scope, and terminal",
      display_only: true
    },
    ...(previousCandidate && previousSnapshotRow
      ? {
          previous: {
            keyword: "previous",
            native_thread_id: previousCandidate.native_thread_id,
            selection_number: previousSnapshotRow.selection_number,
            short_id: previousSnapshotRow.short_id,
            selection_handle: previousSnapshotRow.selection_handle,
            available_actions: {
              resume_thread: resumeAction(previousCandidate)
            }
          }
        }
      : {}),
    threads: candidates.map((candidate) => ({
      ...candidate,
      selection_number:
        snapshotRows.get(candidate.native_thread_id)?.selection_number,
      short_id: snapshotRows.get(candidate.native_thread_id)?.short_id,
      selection_handle:
        snapshotRows.get(candidate.native_thread_id)?.selection_handle,
      selection_scope: "current_snapshot",
      available_actions: candidate.resumable
        ? {
            resume_thread: resumeAction(candidate)
          }
        : {}
    }))
  });
}

function assertSameNativeInspectionTerminal(
  expected: ResolvedTerminalConversation,
  actual: ResolvedTerminalConversation,
  stage: string
): void {
  const expectedPath = expected.terminalControl.currentPath;
  const actualPath = actual.terminalControl.currentPath;
  if (
    actual.agent !== expected.agent ||
    actual.pid !== expected.pid ||
    !terminalControlAliasMatches(
      expected.conversationId,
      expected.terminalControl,
      actual.conversationId,
      actual.terminalControl
    ) ||
    !expectedPath ||
    !actualPath ||
    path.resolve(actualPath) !== path.resolve(expectedPath)
  ) {
    throw new Error(
      `terminal identity, pane, or cwd changed ${stage}; refresh AKK list`
    );
  }
}

function assertTerminalNativeInspectionReady({
  options,
  terminal,
  terminalStatus,
  session
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  terminalStatus?: Awaited<ReturnType<TerminalAgentBridge["status"]>>;
  session?: ManagedSessionState;
}): void {
  if (
    terminalStatus &&
    (
      terminalStatus.reachable !== true ||
      terminalStatus.activity_state !== "idle" ||
      terminalStatus.approval_state.blocked === true
    )
  ) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} is not at a verified idle prompt ` +
      `(${terminalStatus.activity_state}: ${terminalStatus.activity_reason})`
    );
  }
  const blocker = terminalListCliFacade.terminalIncarnationBlockingTurns(
    storeDirFromOptions(options),
    terminal.terminalControl
  )[0];
  if (blocker) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} still has unresolved Turn ` +
      `${turnIdForConversation(blocker)} (${blocker.status})`
    );
  }
  if (
    session &&
    terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(
      storeDirFromOptions(options),
      session
    )
  ) {
    throw new Error(
      `managed Session ${session.session_id} has an unresolved native-thread transition`
    );
  }
  const ownership = terminalListCliFacade.terminalDispatchOwnership(terminal.terminalControl);
  if (ownership.state !== "none") {
    throw new Error(
      `terminal ${terminal.terminalControl.target} has unresolved dispatch ` +
      "ownership; resolve it before native inspection"
    );
  }
  const orphaned = orphanedTerminalDispatchForRecovery(
    terminal.terminalControl
  );
  if (orphaned) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} has unresolved ` +
      `${String(orphaned.kind ?? "terminal")} input ` +
      `(${String(orphaned.status ?? "unknown")})`
    );
  }
}

function nativeInspectionRuntime({
  terminal,
  snapshot
}: {
  terminal: ResolvedTerminalConversation;
  snapshot: Awaited<ReturnType<typeof currentLifecycleSnapshot>>;
}): TerminalRuntimeIdentity {
  if (terminal.agent === "claude") {
    const identity = snapshot.runtimeIdentity;
    if (
      !identity?.sessionId ||
      !identity.processUuid ||
      identity.sessionId !== snapshot.identity?.sessionId
    ) {
      throw new Error(
        "Claude native status inspection requires one exact claude agents Session and process incarnation"
      );
    }
    return {
      ...terminalRuntimeForLiveIdentity({ terminal, identity }),
      requireExactClaudeAgentRow: true,
      nativeProcessStartedAt: identity.processStartedAt,
      exactClaudeAgentState: "idle"
    };
  }
  const exactRuntimeIdentity =
    snapshot.runtimeIdentity?.sessionId === snapshot.identity?.sessionId
      ? snapshot.runtimeIdentity
      : undefined;
  const runtime = exactRuntimeIdentity
    ? terminalRuntimeForLiveIdentity({
        terminal,
        identity: exactRuntimeIdentity
      })
    : {
        ...terminalRuntimeForLiveIdentity({
          terminal,
          expectedEmptyNativeSession: true
        }),
        ...(snapshot.identity?.processUuid
          ? { nativeProcessUuid: snapshot.identity.processUuid }
          : {}),
        ...(snapshot.identity?.processBirth
          ? { nativeProcessBirth: snapshot.identity.processBirth }
          : {}),
        ...(snapshot.identity?.sessionId
          ? { expectedNativeSessionId: snapshot.identity.sessionId }
          : {})
      };
  return withCodexCompanionFences(runtime, snapshot.codexCompanions);
}

function assertNativeInspectionSnapshotUnchanged({
  options,
  expectedTerminal,
  actualTerminal,
  expectedBindingToken,
  expectedVersion,
  actualSnapshot,
  stage,
  expectedClaudeState = "idle"
}: {
  options: Record<string, any>;
  expectedTerminal: ResolvedTerminalConversation;
  actualTerminal: ResolvedTerminalConversation;
  expectedBindingToken: string;
  expectedVersion?: string;
  actualSnapshot: Awaited<ReturnType<typeof currentLifecycleSnapshot>>;
  stage: string;
  expectedClaudeState?: "idle" | "status_dialog";
}): void {
  assertSameNativeInspectionTerminal(expectedTerminal, actualTerminal, stage);
  if (!actualSnapshot.bindingTokens.includes(expectedBindingToken)) {
    throw new Error(
      `terminal binding changed ${stage}; refresh AKK list`
    );
  }
  if (actualSnapshot.version !== expectedVersion) {
    throw new Error(
      `coding-agent version changed ${stage}; refresh AKK list`
    );
  }
  const capability = actualSnapshot.adapter.probeNativeInspection?.(
    actualSnapshot.version
  );
  if (
    capability?.status !== "supported" ||
    capability.statusInspection !== true
  ) {
    throw new Error(
      capability?.reason ??
      "native status inspection became unsupported; refresh AKK list"
    );
  }
  assertNativeInspectionAgentIdentity({
    options,
    terminal: actualTerminal,
    snapshot: actualSnapshot,
    stage,
    expectedClaudeState
  });
}

function assertNativeInspectionAgentIdentity({
  options,
  terminal,
  snapshot,
  stage,
  expectedClaudeState = "idle"
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  snapshot: Awaited<ReturnType<typeof currentLifecycleSnapshot>>;
  stage: string;
  expectedClaudeState?: "idle" | "status_dialog";
}): void {
  if (terminal.agent !== "claude") {
    return;
  }
  const identity = snapshot.runtimeIdentity;
  if (
    !identity?.sessionId ||
    !identity.processUuid ||
    !Number.isSafeInteger(identity.processStartedAt) ||
    Number(identity.processStartedAt) <= 0
  ) {
    throw new Error(
      `Claude process identity is incomplete ${stage}; refresh AKK list`
    );
  }
  const agentRows = loadClaudeAgentRows(options, { required: true });
  const observation = snapshot.adapter.observeThreadLifecycle?.({
    operation: { kind: "new_thread" },
    phase: "before",
    pid: terminal.pid,
    processStartedAt: identity.processStartedAt,
    cwd: terminal.terminalControl.currentPath,
    agentRows
  });
  const exactRows = agentRows.filter((row) => row.pid === terminal.pid);
  const stateMatches = expectedClaudeState === "idle"
    ? observation?.idle === true
    : (
        observation?.idle === false &&
        exactRows.length === 1 &&
        exactRows[0].status === "waiting" &&
        exactRows[0].waitingFor === "dialog open"
      );
  if (
    observation?.status !== "observed" ||
    !stateMatches ||
    observation.nativeThreadId !== identity.sessionId
  ) {
    throw new Error(
      `Claude agents identity, cwd, or idle state changed ${stage}; refresh AKK list`
    );
  }
}

async function assertNativeInspectionExclusiveOwnership({
  options,
  terminal,
  snapshot
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  snapshot: Awaited<ReturnType<typeof currentLifecycleSnapshot>>;
}): Promise<void> {
  // Claude's exact `claude agents` mapping makes global active ownership part
  // of the supported exact Claude inspection profiles. Keep the existing Codex #112 path
  // unchanged: an unmanaged Codex pane may be inspected before a rollout
  // identity exists, and its status card is the bounded identity evidence.
  if (terminal.agent !== "claude") {
    return;
  }
  const nativeThreadId = snapshot.identity?.sessionId ??
    snapshot.session?.binding?.native_thread_id;
  if (!isExactNativeThreadId(nativeThreadId)) {
    throw new Error(
      "native status inspection requires one exact current native Session identity"
    );
  }
  await assertNativeThreadHasExclusiveOwnership({
    options,
    agent: terminal.agent,
    currentPid: terminal.pid,
    nativeThreadId,
    storeDir: storeDirFromOptions(options),
    terminalControl: terminal.terminalControl,
    excludedManagedSessionId: snapshot.session?.session_id
  });
}

async function runNativeInspect(options: Record<string, any>) {
  const inspection = required(
    stringValue(options.inspection),
    "--inspection is required"
  );
  if (inspection !== "status") {
    throw new Error(
      "--inspection must be the closed value status; arbitrary native slash commands are not accepted"
    );
  }
  if (options.command !== undefined || options.message !== undefined) {
    throw new Error(
      "native inspection does not accept a command or message payload"
    );
  }
  const expectedBindingToken = required(
    stringValue(options.expectedBindingToken),
    "--expected-binding-token is required"
  );
  const storeDir = storeDirFromOptions(options);
  const store = inspectStoreCompatibility(storeDir);
  if (store.writable !== true) {
    throw new Error(
      "native inspection requires a compatible AKK Store so binding authority can be verified"
    );
  }
  const initiallyResolved = await resolveLifecycleTerminal(options);
  const bridge = createTerminalAgentBridge(options);
  const releaseTerminalLock = acquireTerminalBridgeSendLock(
    storeDir,
    initiallyResolved.terminalControl,
    { timeoutMs: 30000 }
  );
  try {
    const terminal = await bridge.resolveStoredTerminal(
      initiallyResolved.agent,
      initiallyResolved.pid,
      initiallyResolved.terminalControl,
      { pid: initiallyResolved.pid }
    );
    assertSameNativeInspectionTerminal(
      initiallyResolved,
      terminal,
      "while waiting for native-inspection control"
    );
    const snapshot = await currentLifecycleSnapshot(options, terminal);
    if (!snapshot.bindingTokens.includes(expectedBindingToken)) {
      throw new Error(
        "terminal binding changed after it was listed; refresh AKK list and retry"
      );
    }
    const capability = snapshot.adapter.probeNativeInspection?.(
      snapshot.version
    );
    if (
      capability?.status !== "supported" ||
      capability.statusInspection !== true
    ) {
      throw new Error(
        capability?.reason ??
        "native status inspection is unavailable for this agent version"
      );
    }
    const plan = snapshot.adapter.planNativeInspection?.(
      { kind: "status" },
      capability
    );
    if (
      !plan ||
      plan.operation.kind !== "status" ||
      plan.command !== "/status" ||
      plan.effect !== "read_only"
    ) {
      throw new Error(
        "the agent adapter did not produce the closed native status inspection plan"
      );
    }
    assertNativeInspectionAgentIdentity({
      options,
      terminal,
      snapshot,
      stage: "before native status inspection"
    });
    await assertNativeInspectionExclusiveOwnership({
      options,
      terminal,
      snapshot
    });
    const runtime = nativeInspectionRuntime({ terminal, snapshot });
    const initialStatus = await bridge.status(
      terminal.agent,
      terminal.terminalControl,
      { runtime }
    );
    assertTerminalNativeInspectionReady({
      options,
      terminal,
      terminalStatus: initialStatus,
      session: snapshot.session
    });
    await assertNativeInspectionComposerReadyForAutomatedInput({
      options,
      terminal
    });

    let submission: Awaited<
      ReturnType<TerminalAgentBridge["submitNativeInspection"]>
    >;
    try {
      submission = await bridge.submitNativeInspection(
        terminal.agent,
        terminal.terminalControl,
        plan,
        {
          runtime,
          beforeEnter: async () => {
            const finalTerminal = await bridge.resolveStoredTerminal(
              terminal.agent,
              terminal.pid,
              terminal.terminalControl,
              runtime
            );
            const finalSnapshot = await currentLifecycleSnapshot(
              options,
              finalTerminal
            );
            assertNativeInspectionSnapshotUnchanged({
              options,
              expectedTerminal: terminal,
              actualTerminal: finalTerminal,
              expectedBindingToken,
              expectedVersion: snapshot.version,
              actualSnapshot: finalSnapshot,
              stage: "immediately before native status submission"
            });
            await assertNativeInspectionExclusiveOwnership({
              options,
              terminal: finalTerminal,
              snapshot: finalSnapshot
            });
            assertTerminalNativeInspectionReady({
              options,
              terminal: finalTerminal,
              session: finalSnapshot.session
            });
          }
        }
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (
        error instanceof NativeInspectionSubmissionError &&
        error.doNotRetry !== true
      ) {
        throw new Error(
          `native status inspection did not start; refresh AKK list and retry if still desired: ${detail}`
        );
      }
      throw new Error(
        "native status inspection did not cross a proven completion boundary; " +
        `do not retry automatically: ${detail}`
      );
    }

    try {
      const expectedNativeThreadId =
        snapshot.session?.binding?.native_thread_id ??
        snapshot.identity?.sessionId;
      const observationRequest = {
        operation: plan.operation,
        previousScreenFingerprint: submission.preEnterScreenDigest,
        preEnterEvidenceInventory: submission.preEnterEvidenceInventory,
        expectedNativeThreadId,
        expectedAgentVersion: snapshot.version,
        expectedCwd: terminal.terminalControl.currentPath
      };
      const postEnterRuntime: TerminalRuntimeIdentity =
        plan.expectedResult.presentation === "modal"
          ? { ...runtime, exactClaudeAgentState: "status_dialog" }
          : runtime;
      let stableEvidenceFingerprint: string | undefined;
      let stableObservation: Awaited<
        ReturnType<TerminalAgentBridge["observeNativeInspection"]>
      >["observation"] | undefined;
      let stableCount = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const observed = await bridge.observeNativeInspection(
          terminal.agent,
          terminal.terminalControl,
          observationRequest,
          { runtime: postEnterRuntime, scrollbackLines: 240 }
        );
        const observation = observed.observation;
        if (
          observed.status.reachable === true &&
          (
            plan.expectedResult.presentation === "inline"
              ? observed.status.activity_state === "idle"
              : ![
                  "working",
                  "awaiting_approval"
                ].includes(observed.status.activity_state)
          ) &&
          observed.status.approval_state.blocked !== true &&
          observed.screenDigest !== submission.preEnterScreenDigest &&
          observation.status === "observed" &&
          observation.result?.kind === "native_status" &&
          isExactNativeThreadId(observation.nativeThreadId) &&
          observation.evidenceFingerprint
        ) {
          if (
            stableEvidenceFingerprint === observation.evidenceFingerprint
          ) {
            stableCount += 1;
          } else {
            stableEvidenceFingerprint = observation.evidenceFingerprint;
            stableObservation = observation;
            stableCount = 1;
          }
          if (stableCount >= 2) {
            stableObservation = observation;
            break;
          }
        } else {
          stableEvidenceFingerprint = undefined;
          stableObservation = undefined;
          stableCount = 0;
        }
        await cliSleep(100);
      }
      if (!stableObservation || stableCount < 2) {
        throw new Error(
          "native status inspection Enter was dispatched exactly once, but a fresh exact status result was not proven; do not retry automatically"
        );
      }
      let dismissal:
        Awaited<ReturnType<TerminalAgentBridge["dismissNativeInspection"]>> |
        undefined;
      if (plan.expectedResult.presentation === "modal") {
        if (!stableObservation.evidenceFingerprint) {
          throw new Error(
            "native status modal lacks exact dismissal evidence; do not retry automatically"
          );
        }
        try {
          dismissal = await bridge.dismissNativeInspection(
            terminal.agent,
            terminal.terminalControl,
            plan,
            observationRequest,
            stableObservation.evidenceFingerprint,
            {
              runtime: postEnterRuntime,
              scrollbackLines: 240,
              beforeDismiss: async () => {
                const dismissTerminal = await bridge.resolveStoredTerminal(
                  terminal.agent,
                  terminal.pid,
                  terminal.terminalControl,
                  postEnterRuntime
                );
                const dismissSnapshot = await currentLifecycleSnapshot(
                  options,
                  dismissTerminal
                );
                assertNativeInspectionSnapshotUnchanged({
                  options,
                  expectedTerminal: terminal,
                  actualTerminal: dismissTerminal,
                  expectedBindingToken,
                  expectedVersion: snapshot.version,
                  actualSnapshot: dismissSnapshot,
                  stage: "immediately before native status dismissal",
                  expectedClaudeState: "status_dialog"
                });
                await assertNativeInspectionExclusiveOwnership({
                  options,
                  terminal: dismissTerminal,
                  snapshot: dismissSnapshot
                });
                assertTerminalNativeInspectionReady({
                  options,
                  terminal: dismissTerminal,
                  session: dismissSnapshot.session
                });
              }
            }
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            "native status panel was proven but safe dismissal failed; " +
            `do not retry automatically and dismiss it manually if still visible: ${detail}`
          );
        }
        let restoredIdle = false;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const restored = await bridge.status(
            terminal.agent,
            terminal.terminalControl,
            { runtime }
          );
          if (
            restored.reachable === true &&
            restored.activity_state === "idle" &&
            restored.approval_state.blocked !== true &&
            nativeInspectionComposerEmpty(
              terminal.agent,
              restored.screen.excerpt
            )
          ) {
            restoredIdle = true;
            break;
          }
          await cliSleep(100);
        }
        if (!restoredIdle) {
          throw new Error(
            "Claude Status panel dismissal was dispatched exactly once, but the original idle composer was not restored; do not retry automatically"
          );
        }
      }
      const finalTerminal = await bridge.resolveStoredTerminal(
        terminal.agent,
        terminal.pid,
        terminal.terminalControl,
        runtime
      );
      const finalSnapshot = await currentLifecycleSnapshot(options, finalTerminal);
      assertNativeInspectionSnapshotUnchanged({
        options,
        expectedTerminal: terminal,
        actualTerminal: finalTerminal,
        expectedBindingToken,
        expectedVersion: snapshot.version,
        actualSnapshot: finalSnapshot,
        stage: "after native status inspection"
      });
      await assertNativeInspectionExclusiveOwnership({
        options,
        terminal: finalTerminal,
        snapshot: finalSnapshot
      });
      const finalStatus = await bridge.status(
        finalTerminal.agent,
        finalTerminal.terminalControl,
        { runtime }
      );
      assertTerminalNativeInspectionReady({
        options,
        terminal: finalTerminal,
        terminalStatus: finalStatus,
        session: finalSnapshot.session
      });
      await assertNativeInspectionComposerReadyForAutomatedInput({
        options,
        terminal: finalTerminal
      });
      printJson({
        status: "observed",
        inspection: "status",
        terminal_id: terminal.conversationId,
        agent: terminal.agent,
        agent_version: snapshot.version,
        behavior_profile: plan.behaviorProfile,
        native_thread_id: stableObservation.nativeThreadId,
        native_status: stableObservation.result,
        terminal_submission: {
          command: plan.command,
          enter_count: submission.enterCount,
          materialization: submission.materialization
        },
        ...(dismissal
          ? {
              terminal_dismissal: {
                keys: dismissal.keys,
                dismiss_count: dismissal.dismissCount,
                restored_idle: true
              }
            }
          : {}),
        store_mutation: false,
        session_created: false,
        turn_created: false,
        receipt_created: false,
        monitor_created: false,
        callback_created: false
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/do not retry automatically/iu.test(detail)) {
        throw error;
      }
      throw new Error(
        "native status inspection Enter was dispatched exactly once, but its " +
        `postcondition became uncertain; do not retry automatically: ${detail}`
      );
    }
  } finally {
    releaseTerminalLock();
  }
}

async function runNewThread(options) {
  const requireRestorableOrigin = options.requireRestorableOrigin;
  if (
    requireRestorableOrigin !== undefined &&
    requireRestorableOrigin !== true
  ) {
    throw new Error("--require-restorable-origin does not take a value");
  }
  return runNativeThreadTransition(options, {
    kind: "new_thread",
    requireRestorableOrigin: requireRestorableOrigin === true
  });
}

async function runResumeThread(options) {
  const exactNativeThreadId = stringValue(
    options.nativeThread ?? options.nativeThreadId
  );
  const hasSnapshotSelection = Boolean(
    options.selectionSnapshot ||
    options.selectionNumber ||
    options.selectionShortId ||
    options.selectionHandle
  );
  if (exactNativeThreadId && hasSnapshotSelection) {
    throw new Error(
      "--native-thread cannot be combined with a snapshot-bound selection"
    );
  }
  if (exactNativeThreadId) {
    if (!isExactNativeThreadId(exactNativeThreadId)) {
      throw new Error("--native-thread must be a complete native thread UUID");
    }
    return runNativeThreadTransition(options, {
      kind: "resume_thread",
      nativeThreadId: exactNativeThreadId.toLowerCase()
    });
  }
  if (!hasSnapshotSelection) {
    throw new Error(
      "--native-thread or a snapshot-bound resume selection is required"
    );
  }
  const terminal = await resolveLifecycleTerminal(options);
  const storeDir = storeDirFromOptions(options);
  const selectionScope = required(
    stringValue(options.selectionScope),
    "--selection-scope is required for snapshot-bound resume"
  );
  const rawSelectionNumber = options.selectionNumber;
  const selectionNumber = rawSelectionNumber === undefined
    ? undefined
    : positiveSafeInteger(rawSelectionNumber, "--selection-number");
  const selection = resolveNativeThreadResumeSelection({
    runtimeDir: terminalBridgeRuntimeDir(),
    storeDir,
    terminalId: terminal.conversationId,
    selectionScope,
    snapshotId: stringValue(options.selectionSnapshot),
    selectionNumber,
    shortId: stringValue(options.selectionShortId),
    selectionHandle: stringValue(options.selectionHandle)
  });
  assertResumeSnapshotMatchesTerminal(selection.snapshot, terminal, cliCwd);
  assertResumeSnapshotActionFingerprint(
    selection.snapshot,
    loadTerminalBridgeDispatchLedger(terminal.terminalControl)
  );
  const selectedOptions = {
    ...options,
    expectedBindingToken: selection.snapshot.expected_binding_token,
    candidateToken: selection.row.candidate_token
  };
  return runNativeThreadTransition(selectedOptions, {
    kind: "resume_thread",
    nativeThreadId: selection.row.native_thread_id.toLowerCase(),
    selectionSnapshot: selection.snapshot
  });
}

async function runReconcileBinding(options: Record<string, any>) {
  const initiallyResolved = await resolveLifecycleTerminal(options);
  const storeDir = storeDirFromOptions(options);
  const conflictingSessionId = required(
    stringValue(
      options.conflictingSession ?? options.conflictingSessionId
    ),
    "--conflicting-session is required"
  );
  const expectedSessionRevision = positiveSafeInteger(required(stringValue(
    options.expectedSessionRevision ?? options.sessionRevision
  ), "--expected-session-revision is required"), "--expected-session-revision");
  const expectedBindingToken = required(
    stringValue(options.expectedBindingToken),
    "--expected-binding-token is required"
  );
  const expectedTerminalToken = required(
    stringValue(options.expectedTerminalToken),
    "--expected-terminal-token is required"
  );
  return reconcileTerminalBinding({
    initialTerminal: initiallyResolved,
    conflictingSessionId,
    expectedSessionRevision,
    expectedBindingToken,
    expectedTerminalToken
  }, {
    transaction: {
      locks: terminalWriterMutationLocks(
        storeDir, initiallyResolved.terminalControl
      ),
      recover: (scopes, resources, terminal) =>
        mutationDispatchLedger.beforeMutation(
          scopes, resources, options, terminal
        ),
      loadSession: mutationManagedSessions.load,
      saveSession: mutationManagedSessions.save
    },
    terminal: {
      resolve: () => resolveLifecycleTerminal(options),
      sameIncarnation: terminalControlsShareIncarnation,
      identity: (terminal) => resolveCurrentNativeAgentSessionIdentity({
        options,
        agent: terminal.agent,
        pid: terminal.pid,
        cwd: terminal.terminalControl.currentPath
      }),
      prepareStatus: () => {
        const bridge = createTerminalAgentBridge(options);
        return (terminal) => bridge.status(terminal.agent, terminal.terminalControl, {
          runtime: terminalRuntimeForLiveIdentity({ terminal, physicalOnly: true })
        });
      },
      assertReady: (terminal, terminalStatus) =>
        assertTerminalLifecycleReady({ options, terminal, terminalStatus })
    },
    authority: {
      dispatchIsFree: (terminalControl) =>
        terminalListCliFacade.terminalDispatchOwnership(terminalControl).state === "none",
      sessionClaimsTerminal: managedSessionClaimsResolvedTerminal,
      terminalTokenMatches: (terminal, identity, token) =>
        lifecycleBindingTokens({ terminal, identity }).includes(token),
      hasUnresolvedTransition: (session) =>
        terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(storeDir, session),
      blockingTurn: (sessionId) => {
        const blocker = managedTurnsForSession(storeDir, sessionId)
          .find((turn) => SESSION_SEND_BLOCKING_STATUSES.has(turn.status));
        return blocker
          ? { turnId: turnIdForConversation(blocker), status: blocker.status }
          : undefined;
      },
      conflictKind: (session, terminal, identity) =>
        managedBindingConflictKindForResolvedTerminal({
          storeDir, session, terminal, identity
        })
    },
    now: () => cliNow().toISOString(),
    present: (result) => {
      runtimeLog("info", "managed_binding_reconciled", {
        terminal_id: result.terminal.conversationId,
        terminal_target: result.terminal.terminalControl.target,
        session_id: result.detached.session_id,
        binding_id: result.detached.binding?.binding_id,
        previous_revision: expectedSessionRevision,
        revision: result.detached.revision,
        conflict_kind: result.conflictKind,
        terminal_input_sent: false
      });
      printJson({
        status: "reconciled",
        outcome: "detached_conflicting_binding",
        conflict_kind: result.conflictKind,
        terminal_id: result.terminal.conversationId,
        session_id: result.detached.session_id,
        binding_id: result.detached.binding?.binding_id,
        session_revision: result.detached.revision,
        terminal_input_sent: false,
        turn_created: false,
        refresh_required: true
      });
    }
  });
}

type NativeThreadTransitionOperation =
  | { kind: "new_thread"; requireRestorableOrigin: boolean }
  | {
      kind: "resume_thread";
      nativeThreadId: string;
      selectionSnapshot?: NativeThreadResumeSnapshot;
    };

async function freshLifecycleRecoveryTerminal(
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  options: Record<string, any>,
  capturedTerminal: ResolvedTerminalConversation
): Promise<Readonly<{
  terminal: ResolvedTerminalConversation;
  storeDir: string;
}>> {
  const active = authenticateLifecycleRecoveryResources(scopes, resources);
  const terminal = await createTerminalAgentBridge(options).resolveStoredTerminal(
    capturedTerminal.agent,
    capturedTerminal.pid,
    active.terminalControl,
    { pid: capturedTerminal.pid }
  );
  assertSameNativeInspectionTerminal(
    capturedTerminal,
    terminal,
    "while waiting for lifecycle recovery"
  );
  if (
    !terminalControlsShareIncarnation(
      active.terminalControl,
      terminal.terminalControl
    )
  ) {
    throw new Error(
      "terminal process incarnation changed while waiting for lifecycle recovery"
    );
  }
  return { terminal, storeDir: active.storeDir };
}

function nativeThreadLifecycleRecoveryPorts({
  options,
  terminal,
  storeDir
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  storeDir: string;
}): NativeThreadLifecycleRecoveryPorts {
  const scoped = <Args extends unknown[], Result>(operation: (
    freshControl: TerminalControlRef,
    canonicalStoreDir: string,
    ...args: Args
  ) => Result) => nativeThreadTransitionResourceBoundOperation({
    freshTerminal: terminal.terminalControl,
    capturedStoreDir: storeDir
  }, operation);
  const scopedStore = <Args extends unknown[], Result>(operation: (
    canonicalStoreDir: string,
    ...args: Args
  ) => Result) => scoped((
    _freshControl,
    canonicalStoreDir,
    ...args: Args
  ) => operation(canonicalStoreDir, ...args));
  const freshTerminal = (freshControl: TerminalControlRef) => ({
    ...terminal,
    terminalControl: freshControl
  });
  const canonicalOptions = (canonicalStoreDir: string) =>
    Object.freeze({ ...options, storeDir: canonicalStoreDir });
  const deferredRecoveryRoute = scoped((
    freshControl,
    canonicalStoreDir
  ) => ({ freshControl, canonicalStoreDir }));
  const recoveryProbe = createNativeThreadLifecycleRecoveryProbeAdapter({
    agent: terminal.agent,
    lifecycle: terminal.adapter,
    createBridge: (canonicalStoreDir) =>
      createTerminalAgentBridge(canonicalOptions(canonicalStoreDir)),
    runtime: (freshControl, context) => lifecycleRecoveryRuntime(
      terminalRuntimeForLiveIdentity({
        terminal: freshTerminal(freshControl),
        expectedEmptyNativeSession: context.kind === "codex_recovery",
        physicalOnly: context.kind === "physical"
      }),
      context
    ),
    loadClaudeRows: (canonicalStoreDir) => loadClaudeAgentRows(
      canonicalOptions(canonicalStoreDir),
      { required: true }
    )
  });
  const ledgerDocument = (
    freshControl: TerminalControlRef,
    canonicalStoreDir: string,
    transition: NativeThreadTransition,
    phase: Parameters<typeof lifecycleLedger>[2]
  ) => lifecycleLedger(
    transition,
    canonicalStoreDir,
    phase.phase === "rebuild"
      ? { ...phase, control: freshControl }
      : phase
  );
  return {
    authority: {
      bind: scoped((freshControl) => ({ terminalControl: freshControl }))
    },
    persistence: {
      listNativeThreadTransitions: scopedStore(listNativeThreadTransitions),
      loadManagedSession: scopedStore(loadManagedSession),
      tryLoadManagedSession: scopedStore(tryLoadManagedSession),
      loadNativeThreadTransition: scopedStore(loadNativeThreadTransition),
      saveManagedSession: scopedStore(saveManagedSession),
      saveNativeThreadTransition: scopedStore(saveNativeThreadTransition),
      commitVerified: scopedStore(commitVerifiedLifecycleTransition),
      loadLedger: scoped((freshControl) =>
        loadTerminalBridgeDispatchLedger(freshControl)),
      buildLedger: scoped((
        freshControl,
        canonicalStoreDir,
        transition,
        phase
      ) => ledgerDocument(
        freshControl,
        canonicalStoreDir,
        transition,
        phase
      )),
      saveLedger: scoped((
        freshControl,
        canonicalStoreDir,
        transition,
        phase,
        expectation
      ) => {
        const ledger = ledgerDocument(
          freshControl,
          canonicalStoreDir,
          transition,
          phase
        );
        if (ledger.store_dir !== canonicalStoreDir) {
          throw new Error(
            "lifecycle recovery ledger Store differs from its writer capability"
          );
        }
        saveLifecycleTerminalDispatchLedger(
          freshControl,
          ledger,
          expectation
        );
      }),
      saveFailClosedLedger: scoped((
        freshControl,
        _canonicalStoreDir,
        ledger,
        transitionId,
        now,
        reason
      ) => saveLifecycleTerminalDispatchLedger(freshControl, {
        ...ledger,
        kind: "lifecycle",
        generation_id: transitionId,
        transition_id: transitionId,
        status: "uncertain",
        uncertain_at: now,
        reason: reason.slice(0, 2000)
      }, { expectedTransitionId: transitionId }))
    },
    terminal: {
      recoverDeferred: (scopes, resources) => {
        const route = deferredRecoveryRoute(scopes, resources);
        return recoverDeferredCodexForegroundTransferWhileWriterLease({
          options: canonicalOptions(route.canonicalStoreDir),
          terminal: freshTerminal(route.freshControl),
          storeDir: route.canonicalStoreDir,
          scopes,
          resources
        });
      },
      sameTerminalIncarnation: scoped((freshControl, _storeDir, right) =>
        terminalControlsShareIncarnation(freshControl, right)),
      aliasMatches: scoped((
        freshControl,
        _storeDir,
        storedTerminalId,
        storedControl,
        currentTerminalId
      ) => terminalControlAliasMatches(
        storedTerminalId,
        storedControl,
        currentTerminalId,
        freshControl
      )),
      workspaceMatches: scoped((freshControl, _storeDir, expected) =>
        matchesConfiguredWorkspace(expected, freshControl.currentPath)),
      resolveIdentity: scoped((
        freshControl,
        canonicalStoreDir,
        preferredSessionId,
        companions: LifecycleRecoveryCodexCompanionSet
      ) => resolveCurrentNativeAgentSessionIdentity({
        options: canonicalOptions(canonicalStoreDir),
        agent: terminal.agent,
        pid: terminal.pid,
        cwd: freshControl.currentPath,
        preferredSessionId,
        allowedCompanionIdentity: companions.primary,
        allowedAdditionalIdentities: companions.additional
      })),
      observeExternalHandoff: scoped((
        freshControl,
        canonicalStoreDir,
        sourceSession,
        resolvedIdentity
      ) => observedExternalHandoffIdentity({
        options: canonicalOptions(canonicalStoreDir),
        terminal: freshTerminal(freshControl),
        sourceSession,
        resolvedIdentity
      }).then((observed) => observed.identity)),
      assertExclusive: scoped((
        freshControl,
        canonicalStoreDir,
        nativeThreadId,
        excludedManagedSessionId
      ) => assertNativeThreadHasExclusiveOwnership({
        options: canonicalOptions(canonicalStoreDir),
        agent: terminal.agent,
        currentPid: terminal.pid,
        nativeThreadId,
        storeDir: canonicalStoreDir,
        terminalControl: freshControl,
        excludedManagedSessionId
      })),
      assertTargetExclusive: scoped((
        freshControl,
        canonicalStoreDir,
        transition
      ) => assertLifecycleTargetHasExclusiveOwnership({
        options: canonicalOptions(canonicalStoreDir),
        terminal: freshTerminal(freshControl),
        transition,
        storeDir: canonicalStoreDir
      })),
      exactIdentity: scoped((freshControl, _storeDir, identity) =>
        exactLifecycleProcessIdentity(freshTerminal(freshControl), identity)),
      isProcessAlive: scoped((_freshControl, _storeDir, pid) =>
        isProcessAlive(pid)),
      recordedStoreMatches: scoped((
        _freshControl,
        canonicalStoreDir,
        recordedStoreDir
      ) => path.resolve(recordedStoreDir) === canonicalStoreDir),
      recordMatchesControl: scoped((freshControl, _storeDir, ledger) =>
        terminalDispatchRecordMatchesControl(ledger, freshControl)),
      runningVersion: scoped((_freshControl, canonicalStoreDir) =>
        agentVersionForRunningProcess(
          terminal.agent,
          terminal.pid,
          canonicalOptions(canonicalStoreDir)
        )),
      probeThreadLifecycle: scoped((_freshControl, _storeDir, version) =>
        recoveryProbe.probe(version)),
      planThreadLifecycle: scoped((_freshControl, _storeDir, operation, facts) =>
        recoveryProbe.plan(operation, facts)),
      observeThreadLifecycle: scoped((freshControl, canonicalStoreDir, request) =>
        recoveryProbe.observe(freshControl, canonicalStoreDir, request)),
      prepareProbeBridge: scoped((_freshControl, canonicalStoreDir) =>
        recoveryProbe.prepare(canonicalStoreDir)),
      status: scoped((freshControl, _storeDir, context, scrollbackLines) =>
        recoveryProbe.status(freshControl, context, scrollbackLines)),
      clearInputLine: scoped((freshControl, _storeDir, context) =>
        recoveryProbe.clearInputLine(freshControl, context)),
      submitCodexStatusProbe: scoped((
        freshControl,
        _storeDir,
        version,
        context
      ) => recoveryProbe.submitCodexStatusProbe(
        freshControl,
        version,
        context
      )),
      assertResumedCodexCandidate: scoped((
        _freshControl,
        _storeDir,
        identity,
        expected
      ) => assertResumedCodexRolloutMatchesCandidate(identity, expected)),
      codexKnownRoots: scoped((
        freshControl,
        canonicalStoreDir,
        transition
      ) => codexKnownRootSetForLifecycleTransition({
        storeDir: canonicalStoreDir,
        terminal: freshTerminal(freshControl),
        transition
      })),
      codexCompanionsExcludingPreferred: scoped((
        _freshControl,
        _storeDir,
        roots,
        preferredSessionId
      ) => codexCompanionsExcludingPreferred(roots, preferredSessionId)),
      codexProcessBirth: scoped(() =>
        codexProcessBirthForLifecycle(terminal.pid)),
      nativeIdentityMatches: scoped((
        _freshControl,
        _storeDir,
        identity,
        expected
      ) => nativeIdentityMatchesCodexPreMaterialization(identity, expected))
    },
    runtime: {
      now: cliNow,
      sleep: cliSleep
    }
  };
}

async function recoverLifecycleFenceBeforeMutationScoped(
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  options: Record<string, any>,
  capturedTerminal: ResolvedTerminalConversation
): Promise<void> {
  const fresh = await freshLifecycleRecoveryTerminal(
    scopes,
    resources,
    options,
    capturedTerminal
  );
  const serviceTerminal = lifecycleRecoveryTerminalFacts(fresh.terminal);
  await recoverLifecycleFenceBeforeMutationService(
    { terminal: serviceTerminal },
    scopes,
    resources,
    nativeThreadLifecycleRecoveryPorts({
      options,
      terminal: fresh.terminal,
      storeDir: fresh.storeDir
    })
  );
}

async function reconcileLifecycleDispatchLedgerScoped(
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  options: Record<string, any>,
  capturedTerminal: ResolvedTerminalConversation,
  ledger: TerminalDispatchLedgerDocument,
  authority: NativeThreadLifecycleRecoveryAuthority = { kind: "automatic" }
): Promise<TerminalDispatchLedgerDocument> {
  const fresh = await freshLifecycleRecoveryTerminal(
    scopes,
    resources,
    options,
    capturedTerminal
  );
  const serviceTerminal = lifecycleRecoveryTerminalFacts(fresh.terminal);
  return reconcileLifecycleDispatchLedgerService(
    { terminal: serviceTerminal, ledger, authority },
    scopes,
    resources,
    nativeThreadLifecycleRecoveryPorts({
      options,
      terminal: fresh.terminal,
      storeDir: fresh.storeDir
    })
  );
}

function nativeThreadTransitionSettlementPorts({
  options,
  operation,
  terminal,
  storeDir,
  targetSession,
  targetSessionId,
  sourceBefore,
  beforeIdentity,
  verificationPorts
}: {
  options: Record<string, any>;
  operation: NativeThreadTransitionOperation;
  terminal: ResolvedTerminalConversation;
  storeDir: string;
  targetSession?: ManagedSessionState;
  targetSessionId: string;
  sourceBefore?: ManagedSessionState;
  beforeIdentity: NativeAgentSessionIdentity;
  verificationPorts: NativeThreadVerificationAdapterPorts;
}): NativeThreadTransitionSettlementPorts {
  const scoped = <Args extends unknown[], Result>(operation: (
    freshTerminal: TerminalControlRef,
    canonicalStoreDir: string,
    ...args: Args
  ) => Result) => nativeThreadTransitionResourceBoundOperation({
    freshTerminal: terminal.terminalControl,
    capturedStoreDir: storeDir
  }, operation);
  return {
    persistence: {
      saveLedger: scoped((
        freshTerminal,
        canonicalStoreDir,
        value,
        phase,
        expectation
      ) => {
        const ledger = lifecycleLedger(value, canonicalStoreDir, phase);
        if (ledger.store_dir !== canonicalStoreDir) {
          throw new Error(
            "lifecycle dispatch ledger Store differs from its writer capability"
          );
        }
        saveLifecycleTerminalDispatchLedger(
          freshTerminal,
          ledger,
          expectation
        );
      }),
      loadTransition: scoped((_freshTerminal, canonicalStoreDir, id) =>
        loadNativeThreadTransition(canonicalStoreDir, id)),
      saveTransition: scoped((
        _freshTerminal,
        canonicalStoreDir,
        value,
        expectation
      ) => saveNativeThreadTransition(
        canonicalStoreDir,
        value,
        expectation
      )),
      saveSession: scoped((
        _freshTerminal,
        canonicalStoreDir,
        value,
        expectation
      ) => saveManagedSession(canonicalStoreDir, value, expectation)),
      commitVerified: scoped((
        _freshTerminal,
        canonicalStoreDir,
        value,
        verifiedAt
      ) => commitVerifiedLifecycleTransition(
        canonicalStoreDir,
        value,
        verifiedAt
      ))
    },
    effects: {
      finalizeIdentity: (observed, durableTransition, verifiedAt) => {
        const identity = exactLifecycleProcessIdentity(terminal, observed);
        if (
          terminal.agent === "codex" &&
          operation.kind === "resume_thread"
        ) {
          assertResumedCodexRolloutMatchesCandidate(
            identity,
            durableTransition.target_candidate_file_identity
          );
        }
        return {
          identity,
          binding: terminalBindingFrom({
            terminalId: terminal.conversationId,
            terminalControl: terminal.terminalControl,
            pid: terminal.pid,
            nativeThreadId: identity.sessionId,
            processUuid: identity.processUuid,
            processBirth: identity.processBirth,
            rollout: identity.rollout,
            evidence: identity.evidence,
            generation: (targetSession?.binding?.generation ?? 0) + 1,
            now: verifiedAt
          })
        };
      },
      assertTargetOwnership: scoped((
        _freshTerminal,
        canonicalStoreDir,
        durableTransition
      ) =>
        assertLifecycleTargetHasExclusiveOwnership({
          options,
          terminal,
          transition: durableTransition,
          storeDir: canonicalStoreDir
        })),
      targetConflictWorkspace: () =>
        terminal.terminalControl.currentPath ?? cliCwd()
    },
    runtime: {
      now: cliNow,
      crashAfterVerified: () => {
        if (cliEnv().AKK_TEST_EXIT_AFTER_LIFECYCLE_VERIFIED === "1") {
          cliExit(87);
        }
      },
      injectTargetConflict: () =>
        cliEnv().AKK_TEST_INJECT_LIFECYCLE_TARGET_CONFLICT === "1",
      errorProvesInputNotStarted: (error) =>
        error instanceof TerminalInputNotStartedError,
      summarizeError: textSummary
    },
    verification: scoped((_freshTerminal, _canonicalStoreDir, request) =>
      verifyNativeThreadTransitionWithRuntime(
        request,
        terminal,
        verificationPorts
      )),
    present: (result) => {
      if (result.status === "committed") {
        printJson({
          status: "committed",
          transition_id: result.transition.transition_id,
          operation: operation.kind,
          terminal_id: terminal.conversationId,
          previous_session_id: sourceBefore?.session_id ?? null,
          session_id: targetSessionId,
          previous_native_thread_id:
            beforeIdentity.sessionId ??
            sourceBefore?.binding?.native_thread_id ??
            null,
          native_thread_id: result.identity.sessionId,
          binding_id: result.binding.binding_id,
          binding_generation: result.binding.generation,
          binding_token: managedSessionBindingToken(result.committedTarget),
          turn_created: false
        });
        return;
      }
      printJson({
        status: result.status,
        transition_id: result.transitionId,
        operation: operation.kind,
        terminal_id: terminal.conversationId,
        do_not_retry: true,
        turn_created: false,
        reason: result.reason
      });
    }
  };
}

async function runNativeThreadTransition(
  options: Record<string, any>,
  operation: NativeThreadTransitionOperation
  ) {
  const initiallyResolved = await resolveLifecycleTerminal(options);
  const storeDir = storeDirFromOptions(options);
  return withCanonicalMutationLocks(terminalWriterMutationLocks(
    storeDir, initiallyResolved.terminalControl
  ), async (scopes, resources) => {
      const terminal = await resolveLifecycleTerminal(options);
      if (
        terminal.pid !== initiallyResolved.pid ||
        !terminalControlsShareIncarnation(
          terminal.terminalControl,
          initiallyResolved.terminalControl
        )
      ) {
        throw new Error(
          "terminal identity changed while waiting for lifecycle control; refresh list"
        );
      }
      if (operation.kind === "resume_thread" && operation.selectionSnapshot) {
        assertResumeSnapshotNotExpired(operation.selectionSnapshot, cliNowMs);
        assertResumeSnapshotMatchesTerminal(
          operation.selectionSnapshot,
          terminal,
          cliCwd
        );
        assertResumeSnapshotActionFingerprint(
          operation.selectionSnapshot,
          loadTerminalBridgeDispatchLedger(terminal.terminalControl)
        );
      }
      await mutationDispatchLedger.beforeMutation(
        scopes, resources, options, terminal
      );
      if (operation.kind === "resume_thread" && operation.selectionSnapshot) {
        // Recovery may resolve or otherwise rewrite a durable dispatch fence.
        // A snapshot created before that mutation is stale even when the
        // binding and candidate files themselves did not change.
        assertResumeSnapshotActionFingerprint(
          operation.selectionSnapshot,
          loadTerminalBridgeDispatchLedger(terminal.terminalControl)
        );
      }
      const snapshot = await currentLifecycleSnapshot(
        options,
        terminal,
        { materialize: true }
      );
      const expectedToken = required(
        stringValue(options.expectedBindingToken),
        "--expected-binding-token is required"
      );
      const verificationPorts = nativeThreadVerificationAdapterPorts(
        options,
        terminal
      );
      const selectionSnapshot = operation.kind === "resume_thread"
        ? operation.selectionSnapshot
        : undefined;
      const preparedVerification = await prepareNativeThreadVerification({
        operation,
        expectedBindingToken: expectedToken,
        bindingTokens: snapshot.bindingTokens,
        capabilities: snapshot.capabilities,
        beforeIdentity: snapshot.identity,
        physicalBeforeIdentity: snapshot.runtimeIdentity,
        allowedCompanionIdentity: snapshot.codexCompanions.primary,
        allowedAdditionalIdentities: snapshot.codexCompanions.additional
      }, terminal, {
        ...verificationPorts,
        plan: () => snapshot.adapter.planThreadLifecycle?.(
          operation,
          snapshot.capabilities
        ),
        assertReady: (status) =>
          assertTerminalLifecycleReady({ options, terminal, terminalStatus: status }),
        ...(selectionSnapshot
          ? {
              revalidateSelectionSnapshot: async () => {
                const candidates = await resumableNativeThreadCandidates({
                  terminal,
                  currentIdentity: snapshot.identity
                }, nativeThreadLifecycleQueryPorts(options));
                assertResumeSnapshotCandidates(
                  selectionSnapshot,
                  candidates
                );
              }
            }
          : {}),
        finalizeIdentity: (identity) =>
          exactLifecycleProcessIdentity(terminal, identity)
      });
      const {
        bridge,
        plan,
        beforeIdentity,
        beforeRuntime
      } = preparedVerification;

      const restorableOriginCandidateToken =
        operation.kind === "new_thread" &&
          operation.requireRestorableOrigin
          ? await requireRestorableLifecycleOriginFromQuery({
              terminal,
              currentIdentity: beforeIdentity,
              currentSession: snapshot.session,
              agentVersion: required(
                stringValue(snapshot.version),
                "restorable origin requires the exact running agent version"
              )
            }, nativeThreadLifecycleQueryPorts({ ...options, storeDir }))
          : undefined;

      let candidates: NativeThreadCandidate[] = [];
      let targetSession: ManagedSessionState | undefined;
      let resumeCandidateToken:
        | TerminalThreadLifecycleCandidateToken
        | undefined;
      if (operation.kind === "resume_thread") {
        const expectedCandidateToken = required(
          stringValue(options.candidateToken),
          "--candidate-token is required"
        );
        if (beforeIdentity.sessionId === operation.nativeThreadId) {
          printJson({
            status: "already_active",
            no_op: true,
            terminal_id: terminal.conversationId,
            session_id: snapshot.session?.session_id ?? null,
            native_thread_id: operation.nativeThreadId,
            binding_token: snapshot.bindingToken
          });
          return;
        }
        candidates = await resumableNativeThreadCandidates({
          terminal,
          currentIdentity: beforeIdentity
        }, nativeThreadLifecycleQueryPorts(options));
        if (operation.selectionSnapshot) {
          // The Codex identity probe and other readiness checks above are
          // asynchronous. Rebind the whole displayed snapshot, not only its
          // selected UUID, after those checks and before any lifecycle state
          // is persisted.
          assertResumeSnapshotCandidates(
            operation.selectionSnapshot,
            candidates
          );
        }
        const candidate = candidates.find((entry) =>
          entry.native_thread_id === operation.nativeThreadId
        );
        const candidateDecision = decideResumeCandidateEligibility({
          candidate,
          expectedCandidateToken
        });
        if (candidateDecision.action === "reject") {
          throw new Error(
            candidateDecision.reason === "candidate_not_found"
              ? `native thread ${operation.nativeThreadId} is not a verified same-workspace candidate`
              : candidateDecision.reason === "candidate_not_resumable"
                ? `native thread ${operation.nativeThreadId} cannot be resumed: ` +
                  `${candidate?.unavailable_reason ?? "unavailable"}`
                : "resume candidate changed after it was listed; refresh resumable threads and retry"
          );
        }
        const eligibleCandidate = candidateDecision.candidate;
        resumeCandidateToken = await revalidateNativeThreadCandidateFromQuery({
          terminal,
          nativeThreadId: operation.nativeThreadId,
          encodedToken: expectedCandidateToken,
          agentVersion: snapshot.version as string
        }, nativeThreadLifecycleQueryPorts(options));
        if (eligibleCandidate.managed_session_id) {
          targetSession = tryLoadManagedSession(
            storeDir,
            eligibleCandidate.managed_session_id
          );
          const targetBlockers = managedTurnsForSession(
            storeDir,
            eligibleCandidate.managed_session_id
          ).filter((turn) => SESSION_SEND_BLOCKING_STATUSES.has(turn.status));
          const targetDecision = decideResumeTargetSession({
            hasUnresolvedTurn: targetBlockers.length > 0,
            loadedSession: targetSession,
            boundOwnerConclusivelyInactive: Boolean(
              targetBlockers.length === 0 && targetSession?.status === "bound" &&
              managedSessionOwnerIsConclusivelyInactive({
                session: targetSession,
                terminal,
                identity: beforeIdentity
              })
            )
          });
          if (
            targetDecision.action === "reject" &&
            targetDecision.reason === "unresolved_turn"
          ) {
            throw new Error(
              `target Session ${eligibleCandidate.managed_session_id} has unresolved Turn ` +
              `${turnIdForConversation(targetBlockers[0])}`
            );
          }
          if (targetDecision.action === "reject") {
            throw new Error(
              `target Session ${eligibleCandidate.managed_session_id} is still bound to a live or unverifiable process`
            );
          }
          if (
            targetDecision.action === "detach_stale_binding" &&
            targetSession
          ) {
            const detachedAt = cliNow().toISOString();
            targetSession = saveManagedSession(storeDir, {
              ...targetSession,
              status: "detached",
              detached_at: detachedAt,
              updated_at: detachedAt
            }, { expectedRevision: managedSessionRevision(targetSession) });
          }
        }
      }

      const now = cliNow();
      const transitionId = createNativeThreadTransitionId();
      const targetSessionId = targetSession?.session_id ??
        createManagedSessionId(now);
      const sourceBefore = snapshot.session;
      const previousLedger = loadTerminalBridgeDispatchLedger(
        terminal.terminalControl
      );
      let transition = prepareNativeThreadTransition({
        transitionId,
        operation,
        terminalId: terminal.conversationId,
        agent: terminal.agent,
        workspace: terminal.terminalControl.currentPath ?? cliCwd(),
        source: sourceBefore
          ? {
              state: sourceBefore,
              revision: managedSessionRevision(sourceBefore)
            }
          : undefined,
        targetSessionId,
        target: targetSession
          ? {
              state: targetSession,
              revision: managedSessionRevision(targetSession)
            }
          : undefined,
        candidateFileIdentity:
          terminal.agent === "codex" && operation.kind === "resume_thread"
            ? codexCandidateFileIdentity(resumeCandidateToken)
            : undefined,
        beforeIdentity,
        beforeProcessUuid: beforeIdentity.processUuid as string,
        beforeBinding: snapshot.session?.binding,
        adapterVersion: snapshot.version as string,
        commandFingerprint: nativeThreadCommandFingerprint(
          JSON.stringify(plan.steps)
        ),
        dispatcherPid: cliPid(),
        preparedAt: now.toISOString()
      });
      transition = saveNativeThreadTransition(storeDir, transition, {
        expectedRevision: null
      });
      saveLifecycleTerminalDispatchLedger(terminal.terminalControl,
        lifecycleLedger(transition, storeDir,
          { phase: "command_prepared", previous: previousLedger }), {
        expectedTransitionId: null
      });

      const settlementPorts = nativeThreadTransitionSettlementPorts({
        options,
        operation,
        terminal,
        storeDir,
        targetSession,
        targetSessionId,
        sourceBefore,
        beforeIdentity,
        verificationPorts
      });

      let inputStarted = false;
      let sourceTransitioning: ManagedSessionState | undefined;
      try {
        if (
          cliEnv().AKK_TEST_EXIT_AFTER_LIFECYCLE_PREPARED === "1"
        ) {
          cliExit(86);
        }
        if (sourceBefore) {
          sourceTransitioning = saveManagedSession(storeDir, {
            ...sourceBefore,
            status: "transitioning",
            last_transition_id: transitionId,
            updated_at: now.toISOString()
          }, { expectedRevision: managedSessionRevision(sourceBefore) });
        }
        const dispatchingAt = cliNow().toISOString();
        transition = reduceNativeThreadTransitionPhase(transition, {
          type: "dispatch_started",
          at: dispatchingAt
        });
        transition = saveNativeThreadTransition(storeDir, transition, {
          expectedRevision: nativeThreadTransitionRevision(transition)
        });
        saveLifecycleTerminalDispatchLedger(terminal.terminalControl,
          lifecycleLedger(transition, storeDir,
            { phase: "command_dispatching", previous: previousLedger }), {
          expectedTransitionId: transitionId,
          expectedStatus: "prepared"
        });
        const transitionStep = plan.steps.find((step) =>
          step.kind === "transition"
        );
        if (!transitionStep || transitionStep.effect !== "thread_transition") {
          throw new Error(
            "the adapter lifecycle plan has no exact transition step"
          );
        }
        if (restorableOriginCandidateToken) {
          assertRestorableOriginSessionRelationshipFromQuery({
            agent: terminal.agent,
            nativeThreadId: beforeIdentity.sessionId.toLowerCase(),
            currentSession: snapshot.session
          }, nativeThreadLifecycleQueryPorts({ ...options, storeDir }));
          await assertNativeThreadHasExclusiveOwnership({
            options,
            agent: terminal.agent,
            currentPid: terminal.pid,
            nativeThreadId: beforeIdentity.sessionId.toLowerCase(),
            storeDir,
            terminalControl: terminal.terminalControl,
            excludedManagedSessionId: snapshot.session?.session_id
          });
          await revalidateNativeThreadCandidateFromQuery({
            terminal,
            nativeThreadId: beforeIdentity.sessionId.toLowerCase(),
            encodedToken: restorableOriginCandidateToken,
            agentVersion: required(
              stringValue(snapshot.version),
              "restorable origin requires the exact running agent version"
            )
          }, nativeThreadLifecycleQueryPorts({ ...options, storeDir }));
        }
        if (terminal.agent === "codex") {
          // Candidate discovery and ownership revalidation can take long
          // enough for a human to start typing after the /status probe. Keep
          // this check immediately adjacent to the terminal mutation.
          try {
            await assertCodexComposerReadyForAutomatedInput({
              options,
              terminalControl: terminal.terminalControl
            });
          } catch (error) {
            throw new TerminalInputNotStartedError(
              error instanceof Error ? error.message : String(error),
              { cause: error }
            );
          }
        }
        if (operation.kind === "resume_thread" && operation.selectionSnapshot) {
          assertResumeSnapshotNotExpired(
            operation.selectionSnapshot,
            cliNowMs
          );
        }
        await bridge.send(
          terminal.agent,
          terminal.terminalControl,
          transitionStep.command,
          {
            runtime: beforeRuntime,
            onTransportStage(event) {
              if (event.stage === "text_injected") {
                inputStarted = true;
              }
            }
          }
        );
        const submittedAt = cliNow().toISOString();
        transition = reduceNativeThreadTransitionPhase(transition, {
          type: "submission_recorded",
          at: submittedAt
        });
        transition = saveNativeThreadTransition(storeDir, transition, {
          expectedRevision: nativeThreadTransitionRevision(transition)
        });
        saveLifecycleTerminalDispatchLedger(terminal.terminalControl,
          lifecycleLedger(transition, storeDir,
            { phase: "command_submitted", previous: previousLedger }), {
          expectedTransitionId: transitionId,
          expectedStatus: "dispatching"
        });

        await settleVerifiedNativeThreadTransition({
          transition,
          verification: {
            operation,
            plan,
            beforeIdentity,
            physicalBeforeIdentity: snapshot.runtimeIdentity,
            allowedCompanionIdentity: snapshot.codexCompanions.primary,
            allowedAdditionalIdentities:
              snapshot.codexCompanions.additional,
            initialScreenDigest: preparedVerification.initialScreenDigest
          }
        }, scopes, resources, settlementPorts);
      } catch (error) {
        await settleFailedNativeThreadTransition({
          transitionId,
          inputStarted,
          sourceBefore,
          sourceTransitioning
        }, error, scopes, resources, settlementPorts);
      }
  });
}

async function runStatus(options) {
  const explicitStatePath = options.state
    ? expandHome(String(options.state))
    : undefined;
  const storeDir = explicitStatePath
    ? pathsForConversationDir(path.dirname(explicitStatePath)).storeDir
    : storeDirFromOptions(options);
  const reconciliationConversationId =
    stringValue(options.turn ?? options.conversation ?? options.conversationId) ??
    (explicitStatePath
      ? path.basename(
          pathsForConversationDir(path.dirname(explicitStatePath))
            .conversationDir
        )
      : undefined);
  const reconciliation = options.reconcile === true
    ? await reconcileStoreForStatus(
        storeDir,
        options,
        reconciliationConversationId
      )
    : {
        status: "disabled",
        reason: "standalone status is read-only unless --reconcile is supplied"
      };
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    assertExpectedHandoffTokenUsesExactTerminalSelector({
      options,
      terminal: terminalConversation
    });
    const terminalStatus = await terminalStatusForControl(
      terminalConversation.agent,
      terminalConversation.terminalControl,
      options,
      {
        pid: terminalConversation.pid,
        cwd: terminalConversation.terminalControl.currentPath,
        conversationId: terminalConversation.conversationId,
        terminalTarget: terminalConversation.terminalControl.target
      }
    );
    const context = await terminalStatusContext(
      terminalConversation,
      terminalStatus,
      options
    );
    printJson({
      conversation_id: terminalConversation.conversationId,
      source: "terminal_control",
      agent: terminalConversation.agent,
      store: inspectStoreCompatibility(storeDir),
      reconciliation,
      ...context,
      terminal_control: terminalConversation.terminalControl,
      terminal_status: terminalStatus,
      terminal_screen: terminalStatus.screen
    });
    runtimeLog("info", "terminal_status_read", {
      conversation_id: terminalConversation.conversationId,
      terminal_target: terminalConversation.terminalControl.target,
      reachable: terminalStatus.reachable
    });
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const conversation = loaded.conversation;
  const events = readExistingEvents(logPath);
  const result: Record<string, any> = {
    conversation,
    store: inspectStoreCompatibility(storeDir),
    reconciliation,
    summary: summarizeConversation(conversation),
    confidence: "high",
    about: managedConversationAbout(conversation, events),
    limitations: [],
    state_path: statePath,
    event_log_path: logPath,
    budget: budgetAction(conversation),
    recent_events: events.slice(-10).map(summarizeEvent)
  };
  if (options.trace) {
    result.trace = buildConversationTrace(conversation, events, logPath);
  }
  const terminalControl = terminalControlFromTakeover(
    isRecord(conversation.native_session_takeover) ? conversation.native_session_takeover : undefined
  );
  if (terminalControl) {
    const executor = executorForConversation(conversation);
    result.terminal_control = terminalControl;
    result.terminal_status = await terminalStatusForControl(
      executor.kind,
      terminalControl,
      options,
      terminalRuntimeIdentityForConversation(conversation, terminalControl)
    );
    result.terminal_screen = result.terminal_status.screen;
    result.about = managedConversationAbout(
      conversation,
      events,
      result.terminal_status
    );
    result.limitations = result.terminal_status.reachable === false
      ? ["terminal status unavailable"]
      : [];
  } else {
    result.limitations = ["terminal control metadata is unavailable"];
  }
  printJson(result);
  runtimeLog("info", "task_status_read", {
    conversation_id: conversation.conversation_id,
    status: conversation.status,
    state_path: statePath,
    event_log_path: logPath,
    recent_event_count: Math.min(events.length, 10),
    trace: Boolean(options.trace)
  });
}

async function reconcileStoreForStatus(storeDir, options, conversationId) {
  try {
    ensureStoreWritable(storeDir);
  } catch (error) {
    if (isRecord(error) && error.code === "AKK_STORE_INCOMPATIBLE") {
      return {
        status: "skipped",
        reason: error instanceof Error ? error.message : String(error),
        store: inspectStoreCompatibility(storeDir)
      };
    }
    throw error;
  }
  const monitors = await reconcileMonitors(options, {
    includeCallbackRecovery: false,
    reason: "status_reconciliation",
    conversationId
  });
  const idle = reconcileIdleConversations(
    storeDir,
    options,
    cliNow(),
    conversationId
  );
  return {
    status: "completed",
    checked: Math.max(idle.checked, monitors.checked),
    changed: idle.closed + monitors.launched + monitors.repaired,
    closed: idle.closed,
    repaired: monitors.repaired,
    collateral_stalls_checked: monitors.collateral_stalls_checked,
    collateral_stalls_skipped: monitors.collateral_stalls_skipped,
    collateral_stall_repairs: monitors.items.filter((item) =>
      item.status === "repaired"
    ),
    monitors_launched: monitors.launched,
    monitors_already_running: monitors.already_running,
    skipped: idle.skipped + monitors.skipped,
    errors: monitors.errors,
    idle_timeout_minutes: idle.idle_timeout_minutes
  };
}

async function terminalStatusContext(
  terminalConversation: ResolvedTerminalConversation,
  terminalStatus: Record<string, any>,
  options
): Promise<{
  confidence: string;
  about: string;
  limitations: string[];
}> {
  if (terminalConversation.agent === "codex") {
    try {
      const process = await activeCodexProcessForPid(
        options,
        terminalConversation.pid
      );
      const description = await codexTerminalStatusContext({
        id: terminalConversation.conversationId,
        process,
        options,
        terminalControl: terminalConversation.terminalControl,
        terminalStatus
      });
      return {
        confidence: description.confidence,
        about: description.about,
        limitations: description.limitations
      };
    } catch {
      return {
        confidence: "low",
        about: terminalStatus.reachable
          ? `Codex is attached through ${terminalConversation.terminalControl.kind}:${terminalConversation.terminalControl.target}.`
          : "Codex terminal status is unavailable.",
        limitations: [
          "Codex historical session context is unavailable; live terminal status remains authoritative."
        ]
      };
    }
  }
  const adapter =
    createRuntimeTerminalAgentRegistry(options).require(terminalConversation.agent);
  return {
    confidence: terminalStatus.reachable ? "medium" : "low",
    about: terminalStatus.reachable
      ? `${adapter.displayName} is attached through ${terminalConversation.terminalControl.kind}:${terminalConversation.terminalControl.target}.`
      : `${adapter.displayName} terminal status is unavailable.`,
    limitations: [
      "Historical session context is not available for this terminal adapter."
    ]
  };
}

async function terminalStatusForControl(
  agent: ExecutorKind,
  terminalControl: TerminalControlRef,
  options,
  runtime?: TerminalRuntimeIdentity
) {
  return createTerminalAgentBridge(options).status(agent, terminalControl, {
    scrollbackLines: Number(options.scrollbackLines ?? 120),
    runtime
  });
}

function assertSafeTerminalSend(
  agent: ExecutorKind,
  terminalStatus
): void {
  const displayName = executorDefinitionForKind(agent).displayName;
  const approval = isRecord(terminalStatus?.approval_state)
    ? terminalStatus.approval_state
    : undefined;
  if (terminalStatus?.reachable !== true) {
    throw new Error(`${displayName} terminal status is unavailable`);
  }
  if (approval?.blocked === true) {
    throw new Error(
      stringValue(approval.reason) ?? `${displayName} is waiting at a permission dialog`
    );
  }
  if (terminalStatus.activity_state !== "idle") {
    throw new Error(
      `${displayName} terminal is ${stringValue(terminalStatus.activity_state) ?? "unknown"}, not idle`
    );
  }
}

function terminalBridgeApprovalInstructions({ conversation, terminalControl, terminalStatus }) {
  const approval = isRecord(terminalStatus?.approval_state) ? terminalStatus.approval_state : {};
  const screen = isRecord(terminalStatus?.screen) ? terminalStatus.screen : {};
  const executor = executorForConversation(conversation);
  const agentName = executorDefinitionForKind(executor.kind).displayName;
  const label = stringValue(approval.label) || `the current ${agentName} approval prompt`;
  const keys = Array.isArray(approval.keys)
    ? approval.keys.filter((value): value is string => typeof value === "string")
    : [];
  const decisionMode = stringValue(approval.decision_mode);
  const keyDescription = keys.length > 0
    ? keys.join(" then ")
    : stringValue(approval.key) || "the detected approve key sequence";
  const fingerprint = stringValue(approval.fingerprint);
  const promptKind = stringValue(approval.prompt_kind);
  const command = stringValue(approval.command);
  const toolName = stringValue(approval.tool_name);
  const requestDetail = stringValue(approval.request_detail);
  const requestId = stringValue(approval.request_id);
  const excerpt = stringValue(screen.excerpt) || "(No terminal excerpt was available.)";
  const requiresDirectTerminalReview =
    executor.kind === "claude" &&
    decisionMode === "keys";
  return [
    `${agentName} is waiting for approval in a terminal-controlled AKK session.`,
    "",
    `Conversation: ${conversation.conversation_id}`,
    `Terminal: ${terminalControl.kind}:${terminalControl.target}`,
    `Approval option: ${label} (${keyDescription})`,
    promptKind ? `Request kind: ${promptKind}` : undefined,
    toolName ? `Tool: ${toolName}` : undefined,
    requestDetail ? `Request: ${requestDetail}` : undefined,
    command ? `Command: ${command}` : undefined,
    requestId ? `Request id: ${requestId}` : undefined,
    "",
    "Safe terminal excerpt:",
    "```text",
    excerpt,
    "```",
    "",
    requiresDirectTerminalReview
      ? `Before asking for approval, have the user personally inspect the live ${terminalControl.kind} pane ${terminalControl.target}.`
      : undefined,
    requiresDirectTerminalReview
      ? "This hookless callback intentionally omits raw command details; do not approve from the hash or summary alone."
      : undefined,
    requiresDirectTerminalReview ? "" : undefined,
    `Ask the user whether to approve or deny this ${agentName} request.`,
    "",
    "If the user approves, call `agent_knock_knock_approve` with:",
    `- conversation_id: ${conversation.conversation_id}`,
    `- expected_approval_fingerprint: ${fingerprint ?? "(missing; refresh status before approval)"}`,
    "",
    "Equivalent user command: `AKK approve " + conversation.conversation_id +
      (fingerprint ? ` --expected-approval-fingerprint ${fingerprint}` : "") + "`",
    "",
    "If the user denies or wants to stop this request, call `agent_knock_knock_cancel` with:",
    `- conversation_id: ${conversation.conversation_id}`,
    "",
    "Equivalent user command: `AKK cancel " + conversation.conversation_id + "`",
    "",
    "Do not use raw tmux, shell, or manual key presses for this approval. Do not approve without explicit user confirmation."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function recordTerminalBridgeApprovalNotification({
  statePath,
  logPath,
  terminalControl,
  terminalStatus,
  fingerprint,
  expectedConversation,
  onRecorded
}) {
  const storeDir = pathsForConversationDir(path.dirname(statePath)).storeDir;
  return withStoreWriterLease(storeDir, () => {
    const releaseLock = acquireFileLock(`${statePath}.lock`);
    try {
    const conversation = loadState(statePath);
    const currentNativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const currentTerminalControl = terminalControlFromTakeover(currentNativeTakeover);
    if (
      !isWaitingForAgent(conversation.status) ||
      conversation.conversation_id !== expectedConversation.conversationId ||
      conversation.status !== expectedConversation.status ||
      conversation.updated_at !== expectedConversation.updatedAt ||
      currentNativeTakeover?.terminal_bridge !== true ||
      stringValue(currentNativeTakeover.terminal_bridge_message_id) !==
        expectedConversation.messageId ||
      !currentTerminalControl ||
      !terminalControlsShareIncarnation(
        currentTerminalControl,
        terminalControl
      )
    ) {
      return {
        conversation,
        duplicate: false,
        stale: true,
        recorded: undefined
      };
    }
    const nativeTakeover: Record<string, unknown> = isRecord(conversation.native_session_takeover)
      ? { ...conversation.native_session_takeover }
      : {};
    const approvalScreenDigest = stringValue(
      isRecord(terminalStatus?.screen)
        ? terminalStatus.screen.digest
        : undefined
    );
    const previousApproval = isRecord(nativeTakeover.terminal_bridge_approval)
      ? nativeTakeover.terminal_bridge_approval
      : undefined;
    const previousNotifiedAt = validTimestampMs(previousApproval?.notified_at);
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    const callbackMessage = isRecord(callbackDelivery?.message)
      ? callbackDelivery.message
      : undefined;
    const previousCallbackMessageId =
      stringValue(previousApproval?.callback_message_id);
    const matchingApprovalOutbox =
      callbackDelivery?.kind === "approval_notification" &&
      previousCallbackMessageId !== undefined &&
      callbackMessage?.id === previousCallbackMessageId;
    const callbackDeliveryStatus = stringValue(callbackDelivery?.status);
    const callbackDeliveryAttempts = Number(callbackDelivery?.attempts ?? 0);
    const conflictingActiveOutbox =
      !matchingApprovalOutbox &&
      (
        callbackDeliveryStatus === "pending" ||
        (
          callbackDeliveryStatus === "failed" &&
          Number.isFinite(callbackDeliveryAttempts) &&
          callbackDeliveryAttempts <= CALLBACK_RETRY_DELAYS_MS.length
        )
      );
    if (
      previousApproval?.fingerprint === fingerprint &&
      previousNotifiedAt !== undefined &&
      cliNowMs() - previousNotifiedAt <= CLAUDE_SCREEN_APPROVAL_TTL_MS
    ) {
      if (conflictingActiveOutbox) {
        return {
          conversation,
          duplicate: false,
          stale: true,
          deferred: true,
          previousApproval,
          recorded: undefined
        };
      }
      if (!matchingApprovalOutbox && !conflictingActiveOutbox) {
        const recoveryMessageId =
          previousCallbackMessageId ?? `msg-${randomUUID()}`;
        const recoveryMessageTs =
          stringValue(previousApproval?.callback_message_ts) ??
          stringValue(previousApproval?.notified_at) ??
          cliNow().toISOString();
        const recoveryConversation = previousCallbackMessageId
          ? conversation
          : {
              ...conversation,
              native_session_takeover: {
                ...nativeTakeover,
                terminal_bridge_approval: {
                  ...previousApproval,
                  callback_message_id: recoveryMessageId,
                  callback_message_ts: recoveryMessageTs
                }
              }
            };
        if (!previousCallbackMessageId) {
          saveState(statePath, recoveryConversation);
        }
        const recorded = onRecorded?.(recoveryConversation, {
          recoverMissingOutbox: true
        });
        appendEvent(logPath, {
          ts: cliNow().toISOString(),
          conversation_id: recoveryConversation.conversation_id,
          event: "terminal_bridge_approval_notification_outbox_recovered",
          terminal_control: terminalControl,
          fingerprint,
          callback_message_id: recoveryMessageId
        });
        return {
          conversation: isRecord(recorded) && isRecord(recorded.prepared)
            ? recorded.prepared.conversation
            : recoveryConversation,
          duplicate: false,
          recovered: true,
          stale: false,
          previousApproval,
          recorded
        };
      }
      return {
        conversation,
        duplicate: true,
        stale: false,
        previousApproval,
        recorded: undefined
      };
    }

    const now = cliNow().toISOString();
    const callbackMessageId = `msg-${randomUUID()}`;
    const nextConversation = {
      ...conversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_approval: {
          fingerprint,
          screen_digest: approvalScreenDigest,
          notified_at: now,
          terminal_control: terminalControl,
          approval_state: terminalStatus.approval_state,
          callback_message_id: callbackMessageId,
          callback_message_ts: now
        }
      },
      updated_at: now
    };
    // Persist the stable callback identity before any message/outbox event. If
    // the process exits during callback preparation, recovery can recreate the
    // exact same message and safely finish the outbox transaction.
    saveState(statePath, nextConversation);
    appendEvent(logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_approval_notification_recorded",
      terminal_control: terminalControl,
      fingerprint,
      screen_digest: approvalScreenDigest
    });
    const recorded = onRecorded?.(nextConversation);
    return {
      conversation: isRecord(recorded) && isRecord(recorded.prepared)
        ? recorded.prepared.conversation
        : nextConversation,
      duplicate: false,
      stale: false,
      recorded
    };
    } finally {
      releaseLock();
    }
  });
}

function markTerminalBridgeApprovalPromptCleared({
  statePath,
  logPath,
  expectedConversationId,
  expectedMessageId
}) {
  const storeDir = pathsForConversationDir(path.dirname(statePath)).storeDir;
  return withStoreWriterLease(storeDir, () => {
    const releaseLock = acquireFileLock(`${statePath}.lock`);
    try {
    const conversation = loadState(statePath);
    const nativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    if (
      conversation.conversation_id !== expectedConversationId ||
      conversation.status !== "waiting_for_agent" ||
      nativeTakeover?.terminal_bridge !== true ||
      stringValue(nativeTakeover.terminal_bridge_message_id) !==
        expectedMessageId ||
      stringValue(nativeTakeover.terminal_bridge_last_approval_message_id) !==
        expectedMessageId ||
      validTimestampMs(
        nativeTakeover.terminal_bridge_approval_resolved_at
      ) === undefined ||
      validTimestampMs(
        nativeTakeover.terminal_bridge_last_approval_prompt_cleared_at
      ) !== undefined
    ) {
      return {
        conversation,
        marked: false
      };
    }

    const clearedAt = cliNow().toISOString();
    const nextConversation = {
      ...conversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_last_approval_prompt_cleared_at: clearedAt
      },
      updated_at: clearedAt
    };
    saveState(statePath, nextConversation);
    appendEvent(logPath, {
      ts: clearedAt,
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_approval_prompt_cleared",
      terminal_bridge_message_id: expectedMessageId
    });
    return {
      conversation: nextConversation,
      marked: true
    };
    } finally {
      releaseLock();
    }
  });
}

function terminalDispatchExecution(
  options: Record<string, any>,
  bridge?: TerminalAgentBridge
): TerminalDispatchExecutionService {
  return new TerminalDispatchExecutionService(
    cliEnv().AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE === "1"
      ? cliEnv().AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME ?? "accepted"
      : undefined,
    {
    clock: {
      now: cliNow,
      nowMs: cliNowMs,
      sleep: cliSleep
    },
    native: {
      resolveCodex: ({
        pid,
        cwd,
        preferredSessionId,
        allowedCompanionIdentity,
        allowedAdditionalIdentities
      }) => createAgentSessionProvider("codex", options)
        .resolveActiveSessionIdentityForPid(
          pid,
          cwd,
          preferredSessionId,
          allowedCompanionIdentity
            ? {
                ...allowedCompanionIdentity,
                evidence: "managed_transition_before_identity"
              }
            : undefined,
          allowedAdditionalIdentities?.map((identity) => ({
            ...identity,
            evidence: "managed_transition_ancestor_identity"
          }))
        ),
      async inspectCodexOpenRoots(pid, cwd) {
        const provider = createAgentSessionProvider("codex", options);
        if (!provider.inspectOpenRootRolloutInventoryForPid) {
          throw new Error(
            "Codex open-root rollout inventory inspection is unavailable"
          );
        }
        return provider.inspectOpenRootRolloutInventoryForPid(pid, cwd);
      },
      claudeRows: () => loadClaudeAgentRows(options, { required: true }),
      codexProcessIncarnation: codexProcessIncarnationForPid
    },
    acceptance: {
      captureCodex: captureCodexRolloutAcceptanceAnchor,
      detectCodexCandidates: detectCodexCandidateSetRolloutAcceptance,
      detectBoundCodex: detectCodexRolloutAcceptance,
      detectClaude: (conversation, terminalControl) =>
        detectClaudeTranscriptAcceptance(
          terminalDurableRequestForConversation(
            conversation,
            terminalControl
          ),
          {
            claudeHome: expandHome(options.claudeHome),
            agentRows: loadClaudeAgentRows(options)
          }
        )
    },
    terminal: {
      proveExactDraftStillPresent: (input) =>
        (bridge ?? createTerminalAgentBridge(options))
          .proveExactDraftStillPresent(
            input.executor,
            input.terminalControl,
            input.requestText,
            {
              scrollbackLines: input.scrollbackLines,
              runtime: terminalRuntimeIdentityForConversation(
                input.conversation,
                input.terminalControl
              )
            }
          )
    },
    authority: {
      assertTurnCurrent: assertTurnBindingCurrent
    }
    }
  );
}

type VirginCodexBindingRecovery = {
  conversation: Conversation;
  state: "not_applicable" | "already_bound" | "pending" | "recovered";
};

/**
 * Finish the one monotonic binding transaction that a process crash may split
 * after a virgin Codex Turn has durably dispatched Enter.  This is deliberately
 * scoped to the v2 post-submission anchor: legacy/v1 Turns retain their normal
 * binding fences and never gain a new recovery path.
 */
async function recoverVirginCodexPostSubmissionBinding({
  options,
  conversation,
  statePath,
  logPath,
  terminalLockHeld = false
}: {
  options: Record<string, any>;
  conversation: Conversation;
  statePath: string;
  logPath: string;
  terminalLockHeld?: boolean;
}): Promise<VirginCodexBindingRecovery> {
  const initialTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const initialAnchor = isRecord(
    initialTakeover?.codex_rollout_acceptance_anchor
  )
    ? initialTakeover.codex_rollout_acceptance_anchor
    : undefined;
  const initialSubmission = terminalBridgeSubmission(conversation);
  const initialTerminalControl = terminalControlFromTakeover(initialTakeover);
  if (
    executorForConversation(conversation).kind !== "codex" ||
    initialAnchor?.version !== 2 ||
    initialAnchor?.native_thread_binding !== "post_submission" ||
    !initialTerminalControl ||
    !["enter_dispatched", "agent_accepted"].includes(
      String(initialSubmission?.status ?? "")
    )
  ) {
    return { conversation, state: "not_applicable" };
  }

  const storeDir = pathsForConversationDir(path.dirname(statePath)).storeDir;
  const releaseTerminalLock = terminalLockHeld
    ? () => {}
    : acquireTerminalBridgeSendLock(
        storeDir,
        initialTerminalControl,
        { timeoutMs: 30000 }
      );
  try {
    return await withStoreWriterLeaseAsync(storeDir, async () => {
      const releaseStateLock = acquireFileLock(`${statePath}.lock`);
      try {
        const current = loadState(statePath);
        const takeover = isRecord(current.native_session_takeover)
          ? current.native_session_takeover
          : undefined;
        const anchor = isRecord(takeover?.codex_rollout_acceptance_anchor)
          ? takeover.codex_rollout_acceptance_anchor
          : undefined;
        const submission = terminalBridgeSubmission(current);
        const terminalControl = terminalControlFromTakeover(takeover);
        const messageId = stringValue(submission?.message_id);
        const requestHash = stringValue(takeover?.terminal_bridge_request_hash);
        const requestText = String(
          takeover?.terminal_bridge_request_text ?? current.user_request ?? ""
        );
        if (
          executorForConversation(current).kind !== "codex" ||
          anchor?.version !== 2 ||
          anchor?.native_thread_binding !== "post_submission" ||
          !terminalControl ||
          !terminalControlsShareIncarnation(
            terminalControl,
            initialTerminalControl
          ) ||
          !messageId ||
          messageId !== stringValue(takeover?.terminal_bridge_message_id) ||
          !["enter_dispatched", "agent_accepted"].includes(
            String(submission?.status ?? "")
          ) ||
          !requestHash ||
          requestHash !== terminalBridgeRequestFingerprint(requestText)
        ) {
          return { conversation: current, state: "not_applicable" };
        }

        const bindingId = stringValue(current.terminal_binding_id);
        const bindingGeneration = Number(current.terminal_binding_generation);
        const session = loadManagedSession(
          storeDir,
          sessionIdForConversation(current)
        );
        const binding = session.binding;
        const pid = Number(takeover?.terminal_agent_pid);
        if (
          !bindingId ||
          !Number.isSafeInteger(bindingGeneration) ||
          !Number.isSafeInteger(pid) ||
          pid <= 1 ||
          session.agent !== "codex" ||
          session.status !== "bound" ||
          !binding ||
          binding.binding_id !== bindingId ||
          binding.generation !== bindingGeneration ||
          binding.native_process.pid !== pid ||
          !terminalControlsShareIncarnation(
            binding.terminal_control,
            terminalControl
          )
        ) {
          throw new Error(
            "virgin Codex post-submission binding changed before recovery"
          );
        }

        const anchorProcessUuid = stringValue(anchor.process_uuid);
        const anchorProcessBirth = stringValue(anchor.process_birth);
        const turnProcessUuid = stringValue(
          takeover?.terminal_agent_process_uuid
        );
        const turnProcessBirth = stringValue(
          takeover?.terminal_agent_process_birth
        );
        if (
          !anchorProcessUuid ||
          !anchorProcessBirth ||
          turnProcessUuid !== anchorProcessUuid ||
          turnProcessBirth !== anchorProcessBirth ||
          binding.native_process.process_uuid !== anchorProcessUuid ||
          binding.native_process.process_birth !== anchorProcessBirth
        ) {
          throw new Error(
            "virgin Codex process incarnation changed before binding recovery"
          );
        }

        const turnNativeThreadId = stringValue(current.native_thread_id) ??
          stringValue(takeover?.terminal_agent_session_id);
        const sessionNativeThreadId = binding.native_thread_id;
        if (
          turnNativeThreadId &&
          sessionNativeThreadId &&
          turnNativeThreadId !== sessionNativeThreadId
        ) {
          throw new Error(
            "virgin Codex Session and Turn disagree before binding recovery"
          );
        }
        if (turnNativeThreadId && !isCompleteNativeRollout(
          takeover?.terminal_agent_rollout
        )) {
          throw new Error(
            "virgin Codex Turn has a partial recovered native identity"
          );
        }
        if (sessionNativeThreadId && !binding.native_process.rollout) {
          throw new Error(
            "virgin Codex Session has a partial recovered native identity"
          );
        }
        if (turnNativeThreadId && sessionNativeThreadId) {
          assertTurnBindingCurrent(current, "recover virgin Codex binding for");
          return { conversation: current, state: "already_bound" };
        }

        const preferredSessionId = turnNativeThreadId ?? sessionNativeThreadId;
        const identity = await resolveCurrentNativeAgentSessionIdentity({
          options,
          agent: "codex",
          pid,
          cwd: terminalControl.currentPath,
          preferredSessionId
        });
        if (!identity) {
          return { conversation: current, state: "pending" };
        }
        if (
          !isExactNativeThreadId(identity.sessionId) ||
          identity.processUuid !== anchorProcessUuid ||
          identity.processBirth !== anchorProcessBirth ||
          !isCompleteNativeRollout(identity.rollout) ||
          (preferredSessionId && identity.sessionId !== preferredSessionId) ||
          (turnNativeThreadId &&
            !exactRolloutMatches(
              takeover?.terminal_agent_rollout,
              identity.rollout
            )) ||
          (sessionNativeThreadId &&
            !exactRolloutMatches(
              binding.native_process.rollout,
              identity.rollout
            ))
        ) {
          throw new Error(
            "virgin Codex native identity changed before binding recovery"
          );
        }
        // When neither side was committed, only the exact native acceptance
        // record may tell us that this newly materialized UUID belongs to the
        // dispatched request. If either side was already committed before the
        // crash, that durable CAS plus a fresh exact identity is sufficient to
        // finish the other side while acceptance is still being written.
        if (!turnNativeThreadId && !sessionNativeThreadId) {
          const acceptance = detectCodexRolloutAcceptance({
            anchor: anchor as unknown as CodexRolloutAcceptanceAnchor,
            currentIdentity: identity,
            requestHash
          });
          if (!acceptance) {
            return { conversation: current, state: "pending" };
          }
        }

        await assertNativeThreadHasExclusiveOwnership({
          options,
          agent: "codex",
          currentPid: pid,
          nativeThreadId: identity.sessionId,
          storeDir,
          terminalControl,
          excludedManagedSessionId: session.session_id
        });
        if (!sessionNativeThreadId) {
          const persistedSession = persistManagedSessionNativeIdentity({
            conversation: current,
            terminalControl,
            identity,
            storeDir
          });
          if (
            persistedSession?.binding?.native_thread_id !==
              identity.sessionId ||
            persistedSession.binding.native_process.process_uuid !==
              identity.processUuid ||
            persistedSession.binding.native_process.process_birth !==
              identity.processBirth ||
            !exactRolloutMatches(
              persistedSession.binding.native_process.rollout,
              identity.rollout
            )
          ) {
            throw new Error(
              "virgin Codex Session identity was not durably committed during recovery"
            );
          }
        }
        const recoveredAt = cliNow().toISOString();
        const recoveredConversation = turnNativeThreadId
          ? current
          : {
              ...withNativeAgentSessionIdentity(current, identity),
              updated_at: recoveredAt
            };
        if (!turnNativeThreadId) {
          saveState(statePath, recoveredConversation);
        }
        assertNativeAgentIdentityForTurn({
          conversation: recoveredConversation,
          currentIdentity: identity,
          operation: "recover virgin Codex binding for"
        });
        try {
          appendEvent(logPath, {
            ts: recoveredAt,
            conversation_id: recoveredConversation.conversation_id,
            event: "virgin_codex_post_submission_binding_recovered",
            message_id: messageId,
            native_thread_id: identity.sessionId,
            terminal_control: terminalControl
          });
        } catch (error) {
          runtimeLog("warn", "virgin_codex_binding_recovery_event_failed", {
            conversation_id: recoveredConversation.conversation_id,
            terminal_target: terminalControl.target,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return { conversation: recoveredConversation, state: "recovered" };
      } finally {
        releaseStateLock();
      }
    });
  } finally {
    releaseTerminalLock();
  }
}

async function detectTerminalSubmissionAcceptance({
  options,
  ...request
}: {
  options: Record<string, any>;
  executor: ExecutorKind;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
}): Promise<TerminalSubmissionAcceptanceEvidence | undefined> {
  return terminalDispatchExecution(options).detectAcceptance(request);
}

async function reconcileTerminalAcceptanceInMonitor({
  options,
  conversation,
  statePath,
  logPath,
  terminalControl,
  executor,
  terminalBridge
}: {
  options: Record<string, any>;
  conversation: Conversation;
  statePath: string;
  logPath: string;
  terminalControl: TerminalControlRef;
  executor: ReturnType<typeof executorForConversation>;
  terminalBridge: TerminalAgentBridge;
}): Promise<
  | { outcome: "accepted"; conversation: Conversation }
  | { outcome: "pending" }
  | { outcome: "not_accepted"; conversation: Conversation }
> {
  const initialTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const deferredTransferId = stringValue(
    initialTakeover?.deferred_foreground_transfer_id
  );
  if (deferredTransferId) {
    const transferStoreDir = pathsForConversationDir(
      path.dirname(statePath)
    ).storeDir;
    let transfer = loadDeferredForegroundTransfer(
      transferStoreDir,
      deferredTransferId
    );
    const pid = Number(initialTakeover?.terminal_agent_pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(
        "deferred Codex acceptance monitor lost its exact process identity"
      );
    }
    const terminal = await terminalBridge.resolveStoredTerminal(
      "codex",
      pid,
      terminalControl,
      { pid }
    );
    if (!FINAL_DEFERRED_TRANSFER_STATUSES.has(transfer.status)) {
      await recoverDeferredCodexForegroundTransferBeforeMutation({
        options: {
          ...options,
          storeDir: transferStoreDir
        },
        terminal
      });
      transfer = loadDeferredForegroundTransfer(
        transferStoreDir,
        deferredTransferId
      );
      conversation = loadState(statePath);
      if (!FINAL_DEFERRED_TRANSFER_STATUSES.has(transfer.status)) {
        return { outcome: "pending" };
      }
    }
    if (transfer.status === "abort_resolved") {
      const submission = terminalBridgeSubmission(conversation);
      if (
        conversation.conversation_id !== transfer.turn_id ||
        stringValue(submission?.message_id) !== transfer.message_id ||
        submission?.status !== "aborted" ||
        submission.safe_to_retry !== true
      ) {
        throw new Error(
          `deferred foreground transfer ${transfer.transfer_id} resolved its ` +
          "abort without an exact zero-input Turn receipt"
        );
      }
      return { outcome: "not_accepted", conversation };
    }

    // Dedicated deferred recovery is authoritative and may have closed the
    // transfer while this monitor held the terminal lock. Do not fall through
    // to the generic enter_dispatched reconciler: it would reject the stronger
    // agent_accepted Turn/ledger that recovery just persisted. Re-prove that
    // exact monotonic authority here, then let this same monitor invocation
    // continue into completion polling without replaying terminal input.
    const authority = deferredRecoveryAdapter.loadDeferredForegroundTurnAuthority(
      deferredForegroundRecoveryAdapterPorts(), {
      storeDir: transferStoreDir,
      terminal,
      transfer
    });
    const ledger = loadTerminalBridgeDispatchLedger(terminal.terminalControl);
    if (!ledger) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} resolved ` +
        "without an exact terminal dispatch ledger"
      );
    }
    deferredRecoveryAdapter.assertDeferredForegroundLedgerAuthority(
      deferredForegroundRecoveryAdapterPorts(), {
      storeDir: transferStoreDir,
      terminal,
      transfer,
      ledger,
      statePath: authority.statePath,
      expectedMessageBodyHash: stringValue(
        authority.submission.message_body_hash
      )
    });
    const acceptedBinding = transfer.target_accepted_binding;
    const rollout = acceptedBinding?.native_process.rollout;
    if (
      !acceptedBinding ||
      !transfer.target_native_thread_id ||
      acceptedBinding.native_thread_id !== transfer.target_native_thread_id ||
      !isCompleteNativeRollout(rollout)
    ) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} resolved ` +
        "without an exact accepted native binding"
      );
    }
    const acceptedIdentity: NativeAgentSessionIdentity = {
      sessionId: transfer.target_native_thread_id,
      processUuid: acceptedBinding.native_process.process_uuid,
      processBirth: acceptedBinding.native_process.process_birth,
      rollout,
      evidence: acceptedBinding.native_process.evidence
    };
    assertNativeAgentIdentityForTurn({
      conversation: authority.conversation,
      currentIdentity: acceptedIdentity,
      operation: "continue deferred foreground monitor for"
    });
    return { outcome: "accepted", conversation: authority.conversation };
  }
  let bindingRecovery = await recoverVirginCodexPostSubmissionBinding({
    options,
    conversation,
    statePath,
    logPath,
    terminalLockHeld: true
  });
  conversation = bindingRecovery.conversation;
  let evidence = await detectTerminalSubmissionAcceptance({
    options,
    executor: executor.kind,
    conversation,
    terminalControl
  });
  const recoveredAnchor = isRecord(conversation.native_session_takeover) &&
    isRecord(
      conversation.native_session_takeover.codex_rollout_acceptance_anchor
    )
    ? conversation.native_session_takeover.codex_rollout_acceptance_anchor
    : undefined;
  if (
    evidence &&
    recoveredAnchor?.version === 2 &&
    bindingRecovery.state === "not_applicable"
  ) {
    throw new Error(
      "virgin Codex acceptance appeared without a recoverable Session/Turn binding"
    );
  }
  if (
    evidence &&
    recoveredAnchor?.version === 2 &&
    bindingRecovery.state === "pending"
  ) {
    // The session_meta and exact user record can land between the first
    // recovery probe and this acceptance probe. Never persist agent_accepted
    // until the same evidence has also closed the Session/Turn binding CAS.
    bindingRecovery = await recoverVirginCodexPostSubmissionBinding({
      options,
      conversation,
      statePath,
      logPath,
      terminalLockHeld: true
    });
    if (
      bindingRecovery.state !== "recovered" &&
      bindingRecovery.state !== "already_bound"
    ) {
      return { outcome: "pending" };
    }
    conversation = bindingRecovery.conversation;
    evidence = await detectTerminalSubmissionAcceptance({
      options,
      executor: executor.kind,
      conversation,
      terminalControl
    });
    if (!evidence) {
      return { outcome: "pending" };
    }
  }
  const submission = terminalBridgeSubmission(conversation);
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const messageId = stringValue(submission?.message_id);
  if (!messageId) {
    throw new Error("terminal acceptance monitor lost its exact message identity");
  }
  let notAcceptedReason: string | undefined;
  if (!evidence) {
    const enterAt = validTimestampMs(submission?.enter_dispatched_at);
    if (enterAt !== undefined && cliNowMs() - enterAt >= 250) {
      const requestText = String(
        nativeTakeover?.terminal_bridge_request_text ?? ""
      );
      if (
        await terminalBridge.proveExactDraftStillPresent(
          executor.kind,
          terminalControl,
          requestText,
          {
            scrollbackLines: Number(options.scrollbackLines ?? 240),
            runtime: terminalRuntimeIdentityForConversation(
              conversation,
              terminalControl
            )
          }
        )
      ) {
        notAcceptedReason =
          "the exact managed draft remains in the terminal composer";
      }
    }
    if (!notAcceptedReason) {
      return { outcome: "pending" };
    }
  }

  const resolvedAt = cliNow().toISOString();
  const writerStoreDir = pathsForConversationDir(
    path.dirname(statePath)
  ).storeDir;
  return await withStoreWriterLeaseAsync(writerStoreDir, async () => {
    const releaseStateLock = acquireFileLock(`${statePath}.lock`);
    try {
      const current = loadState(statePath);
    const currentSubmission = terminalBridgeSubmission(current);
    const currentTakeover = isRecord(current.native_session_takeover)
      ? current.native_session_takeover
      : undefined;
    if (
      current.status !== conversation.status ||
      stringValue(currentTakeover?.terminal_bridge_message_id) !== messageId ||
      stringValue(currentSubmission?.message_id) !== messageId ||
      currentSubmission?.status !== "enter_dispatched"
    ) {
      throw new Error(
        "terminal acceptance generation changed before monitor reconciliation"
      );
    }
    const requestText = String(
      currentTakeover?.terminal_bridge_request_text ?? current.user_request ?? ""
    );
    const nextBase = notAcceptedReason
      ? {
          ...current,
          status: "stalled" as const,
          stalled_at: resolvedAt,
          stalled_reason: notAcceptedReason,
          updated_at: resolvedAt
        }
      : current;
    const acceptedConversation = withTerminalBridgeSubmission({
      conversation: nextBase,
      messageId,
      requestText,
      status: notAcceptedReason ? "not_accepted" : "agent_accepted",
      preparedAt:
        stringValue(currentSubmission.prepared_at) ?? resolvedAt,
      textInjectedAt: stringValue(currentSubmission.text_injected_at),
      enterDispatchedAt: stringValue(currentSubmission.enter_dispatched_at),
      ...(notAcceptedReason
        ? { notAcceptedAt: resolvedAt }
        : {
            agentAcceptedAt: resolvedAt,
            acceptanceEvidence: evidence as TerminalSubmissionAcceptanceEvidence
          })
    });
    const ledger = reconcilePreparedTerminalDispatchLedger(
      terminalControl,
      loadTerminalBridgeDispatchLedger(terminalControl)
    );
    if (
      stringValue(ledger?.message_id) !== messageId ||
      ledger?.status !== "enter_dispatched"
    ) {
      throw new Error(
        "terminal dispatch ledger changed before acceptance reconciliation"
      );
    }
    saveState(statePath, acceptedConversation);
    try {
      if (
        cliEnv().AKK_TEST_MONITOR_FINAL_TERMINAL_LEDGER_FAILURE === "1"
      ) {
        throw new Error(
          "injected monitor final terminal ledger persistence failure"
        );
      }
      saveTerminalBridgeDispatchLedger(terminalControl, {
        ...ledger,
        ...terminalBindingLedgerFields(acceptedConversation),
        status: notAcceptedReason ? "not_accepted" : "agent_accepted",
        ...(notAcceptedReason
          ? { not_accepted_at: resolvedAt }
          : {
              agent_accepted_at: resolvedAt,
              acceptance_evidence: evidence
            }),
        dispatcher_pid: null
      });
    } catch (error) {
      runtimeLog("warn", "terminal_acceptance_monitor_ledger_lagging", {
        conversation_id: acceptedConversation.conversation_id,
        message_id: messageId,
        terminal_target: terminalControl.target,
        durable_submission_status: notAcceptedReason
          ? "not_accepted"
          : "agent_accepted",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    try {
      if (
        cliEnv().AKK_TEST_MONITOR_FINAL_EVENT_FAILURE === "1"
      ) {
        throw new Error(
          "injected monitor final acceptance event persistence failure"
        );
      }
      appendEvent(logPath, {
        ts: resolvedAt,
        conversation_id: acceptedConversation.conversation_id,
        event: notAcceptedReason
          ? "terminal_message_not_accepted"
          : "terminal_message_agent_accepted",
        message_id: messageId,
        terminal_control: terminalControl,
        do_not_retry: Boolean(notAcceptedReason)
      });
    } catch (error) {
      runtimeLog("warn", "terminal_acceptance_monitor_event_lagging", {
        conversation_id: acceptedConversation.conversation_id,
        message_id: messageId,
        terminal_target: terminalControl.target,
        durable_submission_status: notAcceptedReason
          ? "not_accepted"
          : "agent_accepted",
        error: error instanceof Error ? error.message : String(error)
      });
    }
      return notAcceptedReason
        ? { outcome: "not_accepted", conversation: acceptedConversation }
        : { outcome: "accepted", conversation: acceptedConversation };
    } finally {
      releaseStateLock();
    }
  });
}

function markTerminalAcceptanceUncertain({
  conversation,
  statePath,
  logPath,
  terminalControl,
  reason
}: {
  conversation: Conversation;
  statePath: string;
  logPath: string;
  terminalControl: TerminalControlRef;
  reason: string;
}): Conversation {
  const messageId = stringValue(
    terminalBridgeSubmission(conversation)?.message_id
  );
  const uncertainAt = cliNow().toISOString();
  const writerStoreDir = pathsForConversationDir(
    path.dirname(statePath)
  ).storeDir;
  return withStoreWriterLease(writerStoreDir, () => {
    const releaseStateLock = acquireFileLock(`${statePath}.lock`);
    try {
      const current = loadState(statePath);
    const submission = terminalBridgeSubmission(current);
    const currentMessageId = stringValue(submission?.message_id);
    if (
      !messageId ||
      currentMessageId !== messageId ||
      !["text_injected", "enter_dispatched"].includes(
        String(submission?.status)
      )
    ) {
      return current;
    }
    const takeover = isRecord(current.native_session_takeover)
      ? current.native_session_takeover
      : undefined;
    const requestText = String(
      takeover?.terminal_bridge_request_text ?? current.user_request ?? ""
    );
    const uncertain = withTerminalBridgeSubmission({
      conversation: {
        ...current,
        status: "stalled" as const,
        stalled_at: uncertainAt,
        stalled_reason: reason,
        updated_at: uncertainAt
      },
      messageId,
      requestText,
      status: "uncertain",
      preparedAt: stringValue(submission?.prepared_at) ?? uncertainAt,
      textInjectedAt: stringValue(submission?.text_injected_at),
      enterDispatchedAt: stringValue(submission?.enter_dispatched_at),
      uncertainAt,
      error: reason,
      lastProvenStage: submission?.status === "enter_dispatched"
        ? "enter_dispatched"
        : "text_injected"
    });
    const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
    if (
      stringValue(ledger?.message_id) === messageId &&
      ["text_injected", "enter_dispatched"].includes(String(ledger?.status))
    ) {
      saveTerminalBridgeDispatchLedger(terminalControl, {
        ...ledger,
        status: "uncertain",
        uncertain_at: uncertainAt,
        error: textSummary(reason),
        dispatcher_pid: null
      });
    }
    saveState(statePath, uncertain);
    appendEvent(logPath, {
      ts: uncertainAt,
      conversation_id: uncertain.conversation_id,
      event: "terminal_message_acceptance_uncertain",
      message_id: messageId,
      terminal_control: terminalControl,
      error: textSummary(reason),
      do_not_retry: true
    });
      return uncertain;
    } finally {
      releaseStateLock();
    }
  });
}

async function inspectCodexOpenRootRolloutInventory({
  options,
  pid,
  cwd
}: {
  options: Record<string, any>;
  pid: number;
  cwd?: string;
}): Promise<CodexOpenRootRolloutInventory> {
  return terminalDispatchExecution(options)
    .inspectCodexOpenRootInventory(pid, cwd);
}

async function resolveCurrentNativeAgentSessionIdentity({
  options,
  ...request
}: NativeIdentityResolutionRequest & {
  options: Record<string, any>;
}): Promise<NativeAgentSessionIdentity | undefined> {
  return terminalDispatchExecution(options).resolveCurrentNativeIdentity(
    request
  );
}

async function observeCurrentNativeAgentSessionIdentity(
  request: NativeIdentityResolutionRequest & {
    options: Record<string, any>;
  }
): Promise<NativeAgentSessionIdentityObservation> {
  const { options, ...resolution } = request;
  return terminalDispatchExecution(options).observeCurrentNativeIdentity(
    resolution
  );
}

function assertNativeAgentIdentityForTurn({
  conversation,
  currentIdentity,
  operation
}: {
  conversation: Conversation;
  currentIdentity: NativeAgentSessionIdentity | undefined;
  operation: string;
}): void {
  terminalDispatchExecution({}).assertTurnIdentity({
    conversation,
    currentIdentity,
    operation
  });
}

function assertTurnBindingCurrent(
  conversation: Conversation,
  operation: string
): void {
  const storeDir = managedSessionStoreDirForConversation(conversation);
  if (!storeDir) {
    return;
  }
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const hasTerminalControl = isRecord(takeover?.terminal_control);
  // Delegated, non-terminal Turns predate first-class Session authority and
  // still need to accept their exact callback. Native-thread fencing applies
  // only to Turns that can cause or receive terminal side effects.
  if (!hasTerminalControl) {
    return;
  }
  const terminalControl = terminalControlFromTakeover(takeover);
  if (!terminalControl) {
    throw new Error(
      `cannot ${operation} Turn ${turnIdForConversation(conversation)}: its ` +
      "terminal binding is malformed"
    );
  }
  // Every terminal side effect first upgrades a supported predecessor under
  // the Store writer lease. This makes the freshly materialized Session
  // authoritative even for the first callback/control after an upgrade.
  const manifest = ensureStoreWritable(storeDir);
  if (manifest.writer_protocol < STORE_SESSION_AUTHORITY_PROTOCOL) {
    throw new Error(
      `cannot ${operation} Turn ${turnIdForConversation(conversation)}: ` +
      "its Store has no protocol-3 Session authority"
    );
  }
  const session = loadManagedSession(
    storeDir,
    sessionIdForConversation(conversation)
  );
  const bindingId = stringValue(conversation.terminal_binding_id);
  const bindingGeneration = Number(conversation.terminal_binding_generation);
  const turnNativeThreadId = stringValue(conversation.native_thread_id) ??
    stringValue(takeover?.terminal_agent_session_id);
  const exactModernBinding = Boolean(
    bindingId &&
    Number.isSafeInteger(bindingGeneration) &&
    session.status === "bound" &&
    session.binding?.binding_id === bindingId &&
    session.binding.generation === bindingGeneration &&
    session.binding.native_thread_id === turnNativeThreadId
  );
  const compatibleMigratedBinding = Boolean(
    !bindingId &&
    !Number.isSafeInteger(bindingGeneration) &&
    session.lineage.created_by === "migration" &&
    !session.last_transition_id &&
    migratedTerminalTurnMatchesSessionBinding({
      conversation,
      takeover,
      terminalControl,
      session,
      turnNativeThreadId
    })
  );
  if (!exactModernBinding && !compatibleMigratedBinding) {
    throw new TurnBindingSupersededError(
      `cannot ${operation} Turn ${turnIdForConversation(conversation)}: its ` +
      `Session binding generation is no longer current`
    );
  }
}

function migratedTerminalTurnMatchesSessionBinding({
  conversation,
  takeover,
  terminalControl,
  session,
  turnNativeThreadId
}: {
  conversation: Conversation;
  takeover: Record<string, any>;
  terminalControl: TerminalControlRef;
  session: ManagedSessionState;
  turnNativeThreadId?: string;
}): boolean {
  const binding = session.binding;
  const terminalId = stringValue(takeover.native_session_id);
  return migratedTerminalBindingMatches({
    session,
    agent: executorForConversation(conversation).kind,
    workspaceMatches:
      path.resolve(session.workspace) === path.resolve(conversation.workspace),
    terminalId,
    terminalAliasMatches: Boolean(binding && terminalId &&
      terminalControlAliasMatches(
        terminalId,
        terminalControl,
        binding.terminal_id,
        binding.terminal_control
      )),
    terminalIncarnationMatches: Boolean(binding &&
      terminalControlsShareIncarnation(
        binding.terminal_control,
        terminalControl
      )),
    pid: Number(takeover.terminal_agent_pid),
    nativeThreadId: turnNativeThreadId,
    processUuid: stringValue(takeover.terminal_agent_process_uuid),
    processBirth: stringValue(takeover.terminal_agent_process_birth),
    rollout: isRecord(takeover.terminal_agent_rollout)
      ? takeover.terminal_agent_rollout
      : undefined
  });
}

function withNativeAgentSessionIdentity(
  conversation: Conversation,
  identity: NativeAgentSessionIdentity
): Conversation {
  return terminalDispatchExecution({}).withNativeIdentity(
    conversation,
    identity
  );
}

function managedSessionStoreDirForConversation(
  conversation: Conversation
): string | undefined {
  const explicit = stringValue(conversation.store_dir);
  if (explicit) {
    return explicit;
  }
  const statePath = stringValue(conversation.state_path);
  return statePath
    ? pathsForConversationDir(path.dirname(statePath)).storeDir
    : undefined;
}

function refineManagedSessionNativeIdentity({
  storeDir,
  session,
  terminalControl,
  identity
}: {
  storeDir: string;
  session: ManagedSessionState;
  terminalControl: TerminalControlRef;
  identity?: NativeAgentSessionIdentity;
}): ManagedSessionState {
  const binding = session.binding;
  if (session.status !== "bound" || !binding) {
    return session;
  }
  if (
    !terminalControlsShareIncarnation(binding.terminal_control, terminalControl) ||
    (identity && binding.native_thread_id &&
      binding.native_thread_id !== identity.sessionId)
  ) {
    throw new Error(
      `managed Session ${session.session_id} changed native identity before send`
    );
  }
  const refinedNativeThreadId = binding.native_thread_id ?? identity?.sessionId;
  const refinedProcessUuid =
    binding.native_process.process_uuid ?? identity?.processUuid;
  const refinedProcessBirth =
    binding.native_process.process_birth ?? identity?.processBirth;
  const refinedRollout = binding.native_process.rollout ?? identity?.rollout;
  const refinedTerminalEndpoint = binding.terminal_endpoint ??
    (hasCanonicalTerminalEndpoint(terminalControl)
      ? terminalControlEvidence(terminalControl)
      : undefined);
  const changed =
    refinedNativeThreadId !== binding.native_thread_id ||
    refinedProcessUuid !== binding.native_process.process_uuid ||
    refinedProcessBirth !== binding.native_process.process_birth ||
    JSON.stringify(refinedRollout) !==
      JSON.stringify(binding.native_process.rollout) ||
    refinedTerminalEndpoint !== binding.terminal_endpoint;
  if (!changed) {
    return session;
  }
  const now = cliNow().toISOString();
  return saveManagedSession(storeDir, {
    ...session,
    binding: {
      ...binding,
      ...(refinedTerminalEndpoint
        ? { terminal_endpoint: refinedTerminalEndpoint }
        : {}),
      native_thread_id: refinedNativeThreadId,
      native_process: {
        ...binding.native_process,
        process_uuid: refinedProcessUuid,
        process_birth: refinedProcessBirth,
        rollout: refinedRollout,
        evidence: identity?.evidence ?? binding.native_process.evidence
      },
      last_verified_at: now
    },
    updated_at: now
  }, {
    expectedRevision: managedSessionRevision(session)
  });
}

function persistManagedSessionNativeIdentity({
  conversation,
  terminalControl,
  identity,
  storeDir
}: {
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  identity: NativeAgentSessionIdentity;
  storeDir: string;
}): ManagedSessionState | undefined {
  const bindingId = stringValue(conversation.terminal_binding_id);
  const bindingGeneration = Number(conversation.terminal_binding_generation);
  const conversationStoreDir =
    managedSessionStoreDirForConversation(conversation);
  if (
    !bindingId ||
    !Number.isSafeInteger(bindingGeneration) ||
    !conversationStoreDir
  ) {
    return undefined;
  }
  const canonicalStoreDir = path.resolve(storeDir);
  if (path.resolve(conversationStoreDir) !== canonicalStoreDir) {
    throw new Error(
      "managed Session native identity escaped its exact Store writer"
    );
  }
  const sessionId = sessionIdForConversation(conversation);
  const current = tryLoadManagedSession(canonicalStoreDir, sessionId);
  if (
    !current ||
    current.status !== "bound" ||
    !current.binding ||
    current.binding.binding_id !== bindingId ||
    current.binding.generation !== bindingGeneration ||
    !terminalControlsShareIncarnation(
      current.binding.terminal_control,
      terminalControl
    )
  ) {
    throw new Error(
      `managed Session ${sessionId} binding changed before native identity commit`
    );
  }
  const expectedNativeThreadId = current.binding.native_thread_id;
  if (
    expectedNativeThreadId &&
    expectedNativeThreadId !== identity.sessionId
  ) {
    throw new Error(
      `managed Session ${sessionId} expected native thread ` +
      `${expectedNativeThreadId}, observed ${identity.sessionId}`
    );
  }
  const now = cliNow().toISOString();
  const next: ManagedSessionState = {
    ...current,
    binding: {
      ...current.binding,
      native_thread_id: identity.sessionId,
      native_process: {
        ...current.binding.native_process,
        process_uuid: identity.processUuid,
        process_birth: identity.processBirth,
        rollout: identity.rollout,
        evidence: identity.evidence
      },
      last_verified_at: now
    },
    updated_at: now
  };
  return saveManagedSession(canonicalStoreDir, next, {
    expectedRevision: managedSessionRevision(current)
  });
}

function quarantineManagedSessionBinding({
  conversation,
  reason,
  storeDir
}: {
  conversation: Conversation;
  reason: string;
  storeDir: string;
}): void {
  const bindingId = stringValue(conversation.terminal_binding_id);
  const bindingGeneration = Number(conversation.terminal_binding_generation);
  const conversationStoreDir =
    managedSessionStoreDirForConversation(conversation);
  if (
    !bindingId ||
    !Number.isSafeInteger(bindingGeneration) ||
    !conversationStoreDir
  ) {
    return;
  }
  const canonicalStoreDir = path.resolve(storeDir);
  if (path.resolve(conversationStoreDir) !== canonicalStoreDir) {
    throw new Error(
      "managed Session quarantine escaped its exact Store writer"
    );
  }
  const current = tryLoadManagedSession(
    canonicalStoreDir,
    sessionIdForConversation(conversation)
  );
  if (
    !current?.binding ||
    current.binding.binding_id !== bindingId ||
    current.binding.generation !== bindingGeneration
  ) {
    return;
  }
  const now = cliNow().toISOString();
  saveManagedSession(canonicalStoreDir, {
    ...current,
    status: "quarantined",
    quarantine_reason: reason.slice(0, 2000),
    updated_at: now
  }, {
    expectedRevision: managedSessionRevision(current)
  });
}

function managedTurnsForSession(
  storeDir: string,
  sessionId: string
): Conversation[] {
  return listConversations(storeDir)
    .filter(isDiscoverableTmuxConversation)
    .filter((conversation) =>
      sessionIdForConversation(conversation) === sessionId
    )
    .sort(compareManagedConversationRecency);
}

function assertManagedSessionCanStartTurn(
  turns: Conversation[]
): void {
  assertManagedSessionCanStartTurnPolicy(
    turns,
    (conversation) => SESSION_SEND_BLOCKING_STATUSES.has(conversation.status)
  );
}

function managedTurnMatchesResolvedTerminal(
  conversation: Conversation,
  terminal: ResolvedTerminalConversation,
  currentIdentity?: NativeAgentSessionIdentity
): boolean {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const storedControl = terminalControlFromTakeover(takeover);
  return managedTurnMatchesTerminal({
    conversation,
    terminal,
    currentIdentity,
    storedControlExists: storedControl !== undefined,
    terminalIncarnationMatches: Boolean(storedControl &&
      terminalControlsShareIncarnation(
        storedControl,
        terminal.terminalControl
      )),
    workspaceMatches: matchesConfiguredWorkspace(
      conversation.workspace,
      terminal.terminalControl.currentPath
    )
  });
}

function createManagedTerminalTurn({
  options,
  conversationId,
  agent,
  pid,
  messageBody,
  terminalControl,
  previousTurn,
  managedSession,
  nativeAgentIdentity,
  deferredForegroundTransferId = undefined as string | undefined
}) {
  const workspace = terminalControl.currentPath ?? cliCwd();
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  const executor = previousTurn
    ? executorForConversation(previousTurn)
    : resolveExecutor({
        kind: agent,
        session: conversationId
      });
  const now = cliNow();
  const conversation = createConversation({
    userRequest: String(messageBody),
    sessionId:
      managedSession?.session_id ??
      (previousTurn ? sessionIdForConversation(previousTurn) : undefined),
    workspace,
    openclawSession:
      options.openclawSession ?? previousTurn?.openclaw_session ??
      "agent:main:main",
    executorKind: executor.kind,
    executorSession: executor.session,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100),
    now
  });
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const previousTakeover = previousTurn && isRecord(
    previousTurn.native_session_takeover
  )
    ? previousTurn.native_session_takeover
    : undefined;
  const managedNativeProcess = managedSession?.binding?.native_process;
  const attachedConversation = withStoragePaths({
    ...conversation,
    terminal_binding_id: managedSession?.binding?.binding_id,
    terminal_binding_generation: managedSession?.binding?.generation,
    native_thread_id:
      managedSession?.binding?.native_thread_id ??
      nativeAgentIdentity?.sessionId,
    executor,
    status: "idle" as const,
    idle_since: now.toISOString(),
    updated_at: now.toISOString(),
    gateway_url:
      options.gatewayUrl ?? previousTurn?.gateway_url ??
      "ws://127.0.0.1:18789",
    gateway_method: options.gatewayMethod ?? previousTurn?.gateway_method,
    gateway_session:
      options.gatewaySession ?? options.openclawSession ??
      previousTurn?.gateway_session ?? previousTurn?.openclaw_session ??
      "agent:main:main",
    openclaw_bin:
      options.openclawBin ?? previousTurn?.openclaw_bin ??
      resolveOptionalExecutable("openclaw"),
    native_session_takeover: {
      agent,
      terminal_agent_identity_protocol: 1,
      native_session_id: conversationId,
      terminal_agent_pid: pid,
      terminal_agent_session_id: nativeAgentIdentity?.sessionId,
      terminal_agent_expected_session_id:
        managedSession?.binding?.native_thread_id,
      terminal_binding_id: managedSession?.binding?.binding_id,
      terminal_binding_generation: managedSession?.binding?.generation,
      terminal_agent_process_uuid:
        nativeAgentIdentity?.processUuid ?? managedNativeProcess?.process_uuid,
      terminal_agent_process_birth:
        nativeAgentIdentity?.processBirth ?? managedNativeProcess?.process_birth,
      terminal_agent_rollout:
        nativeAgentIdentity?.rollout ?? managedNativeProcess?.rollout,
      terminal_agent_identity_evidence:
        nativeAgentIdentity?.evidence ?? managedNativeProcess?.evidence,
      source_cwd: workspace,
      source_title: `Terminal-controlled ${executor.display_name} ${terminalControl.target}`,
      strategy: "terminal_control",
      attached_at:
        stringValue(previousTakeover?.attached_at) ?? now.toISOString(),
      takeover_match_kind: previousTurn
        ? "managed_session_send"
        : "raw_terminal_send",
      ...terminalEndpointTakeoverFields(terminalControl),
      needs_bootstrap: false,
      terminal_bridge: true,
      ...(deferredForegroundTransferId
        ? { deferred_foreground_transfer_id: deferredForegroundTransferId }
        : {})
    }
  }, paths);
  const message = createMessage({
    conversation: attachedConversation,
    id: stringValue(options.messageId),
    from: "openclaw",
    to: executor.actor,
    type: options.type ?? "task",
    body: String(messageBody),
    metadata: {
      executor_kind: executor.kind,
      executor_session: executor.session,
      source_conversation_id: conversationId
    }
  });
  const nextConversation = applyMessageToConversation(attachedConversation, message);
  return {
    conversation: attachedConversation,
    nextConversation,
    statePath: paths.statePath,
    logPath: paths.logPath,
    executor,
    message
  };
}

function openClawYieldNextAction({
  conversationId,
  sessionId,
  turnId,
  source,
  callbackExpected
}) {
  const callbackText = callbackExpected
    ? "The coding agent should report completion, questions, or errors through the existing Agent Knock Knock callback for this conversation."
    : "No AKK-managed callback is registered for this raw terminal-controlled id; do not wait synchronously. Use AKK status/list later or attach/create an AKK conversation when callback delivery is required.";
  return {
    action: "yield",
    reason:
      "The requested agent work was handed off asynchronously. End this OpenClaw turn now instead of waiting, polling, or treating the send as a synchronous agent result.",
    source,
    conversation_id: conversationId,
    session_id: sessionId,
    turn_id: turnId,
    callback_expected: callbackExpected,
    do_not:
      "Do not inspect event logs, process lists, terminal screens, files, stdout, or stderr while waiting unless the user explicitly asks for status.",
    expected_callback: callbackText
  };
}

async function runRenew(options) {
  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const conversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  if (conversation.status === "closed") {
    throw new Error(`cannot renew ${conversation.conversation_id}; conversation is closed`);
  }
  if (conversation.status !== "stalled") {
    throw new Error(`cannot renew ${conversation.conversation_id}; conversation is ${conversation.status}, not stalled`);
  }
  if (isVerifiedDeadTerminalAgentProcess(conversation)) {
    throw new Error(
      `cannot renew ${conversation.conversation_id}; its bound terminal agent ` +
      "process is verified dead. Close this orphaned Turn instead."
    );
  }
  if (terminalBridgeSubmission(conversation)?.status === "uncertain") {
    throw new Error(
      `cannot renew ${conversation.conversation_id}; its terminal submission ` +
      "is uncertain and cannot be attributed by monitoring. Inspect the pane " +
      "and explicitly close the Turn to abandon the unresolved result."
    );
  }

  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (!terminalControl || nativeTakeover?.["terminal_bridge"] !== true) {
    throw new Error(`cannot renew ${conversation.conversation_id}; conversation is not a terminal bridge task`);
  }

  const terminalProvider = createTerminalControlProvider(options);
  try {
    await terminalProvider.resolve(terminalProvider.endpoint(terminalControl));
  } catch {
    throw new Error(`cannot renew ${conversation.conversation_id}; terminal ${terminalControl.target} is no longer available`);
  }

  const expectedMessageId = stringValue(nativeTakeover?.terminal_bridge_message_id);
  const expectedStartedAt = stringValue(nativeTakeover?.terminal_bridge_started_at);
  let renewed = conversation;
  let renewedTerminalControl = terminalControl;
  let inactivityTimeoutMinutes = 0;
  let hardTimeoutMinutes = 0;
  const releaseStateLock = acquireFileLock(`${statePath}.lock`);
  try {
    const current = loadState(statePath);
    if (current.status !== "stalled") {
      throw new Error(
        `cannot renew ${current.conversation_id}; conversation is ${current.status}, not stalled`
      );
    }
    if (isVerifiedDeadTerminalAgentProcess(current)) {
      throw new Error(
        `cannot renew ${current.conversation_id}; its bound terminal agent ` +
        "process is verified dead"
      );
    }
    if (terminalBridgeSubmission(current)?.status === "uncertain") {
      throw new Error(
        `cannot renew ${current.conversation_id}; its terminal submission is uncertain`
      );
    }
    const currentTakeover = isRecord(current.native_session_takeover)
      ? current.native_session_takeover
      : undefined;
    const currentControl = terminalControlFromTakeover(currentTakeover);
    if (!currentControl || currentTakeover?.terminal_bridge !== true) {
      throw new Error(
        `cannot renew ${current.conversation_id}; conversation is not a terminal bridge task`
      );
    }
    if (
      current.conversation_id !== conversation.conversation_id ||
      !terminalControlsShareIncarnation(currentControl, terminalControl) ||
      stringValue(currentTakeover.terminal_bridge_message_id) !== expectedMessageId ||
      stringValue(currentTakeover.terminal_bridge_started_at) !== expectedStartedAt
    ) {
      throw new Error(
        "conversation changed while waiting to renew; refresh status and retry"
      );
    }
    assertTurnBindingCurrent(current, "renew");

    renewedTerminalControl = currentControl;
    inactivityTimeoutMinutes = positiveMinutes(
      options.minutes ??
        options.agentTimeoutMinutes ??
        currentTakeover.terminal_bridge_inactivity_timeout_minutes ??
        DEFAULT_AGENT_TIMEOUT_MINUTES,
      "--minutes"
    );
    hardTimeoutMinutes = positiveMinutes(
      currentTakeover.terminal_bridge_hard_timeout_minutes ??
        DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
      "--agent-hard-timeout-minutes"
    );
    const startedAt = stringValue(currentTakeover.terminal_bridge_started_at);
    const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
    if (
      Number.isFinite(startedAtMs) &&
      cliNowMs() - startedAtMs >= hardTimeoutMinutes * 60 * 1000
    ) {
      throw new Error(
        `cannot renew ${current.conversation_id}; terminal bridge hard lifetime of ${hardTimeoutMinutes} minutes has elapsed`
      );
    }

    const now = cliNow().toISOString();
    const hardDeadline = deadlineAt(startedAt ?? now, hardTimeoutMinutes) ??
      new Date(cliNowMs() + hardTimeoutMinutes * 60 * 1000).toISOString();
    const inactivityDeadline = deadlineAt(now, inactivityTimeoutMinutes) ??
      new Date(cliNowMs() + inactivityTimeoutMinutes * 60 * 1000).toISOString();
    renewed = {
      ...current,
      status: "waiting_for_agent" as const,
      native_session_takeover: {
        ...currentTakeover,
        terminal_bridge_monitor_lock_version: monitorOwner.LOCK_VERSION,
        terminal_bridge_monitor_started_at: now,
        terminal_bridge_last_activity_at: now,
        terminal_bridge_inactivity_timeout_minutes: inactivityTimeoutMinutes,
        terminal_bridge_hard_timeout_minutes: hardTimeoutMinutes,
        terminal_bridge_inactivity_deadline_at: inactivityDeadline,
        terminal_bridge_hard_deadline_at: hardDeadline,
        terminal_bridge_renewed_at: now
      },
      updated_at: now
    };
    Reflect.deleteProperty(renewed, "stalled_at");
    Reflect.deleteProperty(renewed, "stalled_reason");
    Reflect.deleteProperty(renewed, "stalled_notification_sent_at");
    Reflect.deleteProperty(renewed, "stalled_notification_message_id");
    saveState(statePath, renewed);
    appendEvent(logPath, {
      ts: now,
      conversation_id: current.conversation_id,
      event: "terminal_bridge_renewed",
      previous_status: current.status,
      terminal_control: currentControl,
      agent_timeout_minutes: inactivityTimeoutMinutes,
      agent_hard_timeout_minutes: hardTimeoutMinutes,
      last_activity_at: now
    });
    runtimeLog("info", "terminal_bridge_renewed", {
      conversation_id: current.conversation_id,
      terminal_target: currentControl.target,
      agent_timeout_minutes: inactivityTimeoutMinutes,
      agent_hard_timeout_minutes: hardTimeoutMinutes
    });
  } finally {
    releaseStateLock();
  }

  const monitor = startTerminalBridgeMonitorForConversation({
    conversation: renewed,
    statePath,
    logPath,
    options: {
      ...options,
      agentTimeoutMinutes: inactivityTimeoutMinutes,
      agentHardTimeoutMinutes: hardTimeoutMinutes
    }
  });
  if (monitor) {
    appendEvent(logPath, {
      ts: cliNow().toISOString(),
      conversation_id: renewed.conversation_id,
      event: "terminal_bridge_monitor_launch",
      pid: monitor.pid ?? null,
      terminal_control: renewedTerminalControl,
      reason: "renewal",
      agent_timeout_minutes: inactivityTimeoutMinutes,
      agent_hard_timeout_minutes: hardTimeoutMinutes
    });
  }

  printJson({
    conversation: renewed,
    renewed: true,
    terminal_control: renewedTerminalControl,
    agent_timeout_minutes: inactivityTimeoutMinutes,
    agent_hard_timeout_minutes: hardTimeoutMinutes,
    monitor_pid: monitor?.pid ?? null
  });
}

async function runReconcileMonitors(options) {
  const reason = stringValue(options.reason) ?? "startup_reconciliation";
  printJson(await reconcileMonitors(options, {
    includeCallbackRecovery:
      options.terminalMonitorsOnly !== true &&
      reason !== "monitor_supervision",
    reason,
    conversationId: undefined
  }));
}

async function reconcileMonitors(
  options,
  {
    includeCallbackRecovery,
    reason,
    conversationId
  }: {
    includeCallbackRecovery: boolean;
    reason: string;
    conversationId?: string;
  }
) {
  const storeDir = storeDirFromOptions(options);
  const collateralStalls = await withStoreWriterLeaseAsync(
    storeDir,
    async () => reconcileTerminalBridgeCollateralStalls(
      storeDir,
      conversationId
    )
  );
  const conversations = listConversations(storeDir).filter((conversation) =>
    conversationId === undefined || conversation.conversation_id === conversationId
  );
  const items: Record<string, unknown>[] = [...collateralStalls.items];
  const repairedConversationIds = new Set(
    collateralStalls.items
      .filter((item) => item.status === "repaired")
      .map((item) => stringValue(item.conversation_id))
      .filter((id): id is string => id !== undefined)
  );
  let ignored = 0;
  let launched = 0;
  let alreadyRunning = 0;
  let skipped = 0;
  let errors = collateralStalls.errors.length;

  for (const listedConversation of conversations) {
    if (repairedConversationIds.has(listedConversation.conversation_id)) {
      ignored += 1;
      continue;
    }
    if (
      !matchesConfiguredWorkspace(
        options.workspace,
        listedConversation.workspace
      )
    ) {
      ignored += 1;
      continue;
    }
    const statePath = expandHome(
      stringValue(listedConversation.state_path) ??
        statePathForConversationId(listedConversation.conversation_id, storeDir)
    );
    const logPath = expandHome(
      stringValue(listedConversation.event_log_path) ??
        logPathForStatePath(statePath)
    );

    try {
      const localCompletion = settleLocalTerminalBridgeCompletionClaim({
        storeDir,
        statePath,
        logPath
      });
      if (localCompletion.handled) {
        skipped += 1;
        items.push({
          conversation_id: listedConversation.conversation_id,
          status: localCompletion.recovered ? "recovered" : "skipped",
          reason: localCompletion.reason
        });
        continue;
      }
      if (includeCallbackRecovery) {
        const callbackRecovery = withStoreWriterLease(storeDir, () =>
          prepareCallbackDeliveryReconciliation({
            statePath,
            logPath,
            delayMs: options.callbackRetryDelayMs
          })
        );
        if (callbackRecovery.handled) {
          if (callbackRecovery.status === "launched") {
            launched += 1;
          } else if (callbackRecovery.status === "already_running") {
            alreadyRunning += 1;
          } else {
            skipped += 1;
          }
          items.push({
            conversation_id: callbackRecovery.conversationId,
            status: callbackRecovery.status,
            reason: callbackRecovery.reason,
            ...(callbackRecovery.monitorPid === undefined
              ? {}
              : { monitor_pid: callbackRecovery.monitorPid }),
            ...(callbackRecovery.attempt === undefined
              ? {}
              : { attempt: callbackRecovery.attempt }),
            ...(callbackRecovery.attemptPid === undefined
              ? {}
              : { attempt_pid: callbackRecovery.attemptPid }),
            ...(callbackRecovery.leaseExpiresAt === undefined
              ? {}
              : { lease_expires_at: callbackRecovery.leaseExpiresAt }),
            ...(callbackRecovery.nextAttemptAt === undefined
              ? {}
              : { next_attempt_at: callbackRecovery.nextAttemptAt })
          });
          continue;
        }
      }

      const listedNativeTakeover = isRecord(listedConversation.native_session_takeover)
        ? listedConversation.native_session_takeover
        : undefined;
      if (listedNativeTakeover?.terminal_bridge !== true) {
        ignored += 1;
        continue;
      }

      let initialConversation = await migrateLegacyTerminalAgentIdentity({
        conversation: loadState(statePath),
        statePath,
        logPath,
        options
      });
      const deadProcessStall = await stallAcceptedTurnForVerifiedDeadAgent({
        options,
        storeDir,
        statePath,
        logPath,
        expectedConversationId: initialConversation.conversation_id,
        expectedMessageId: stringValue(
          isRecord(initialConversation.native_session_takeover)
            ? initialConversation.native_session_takeover
                .terminal_bridge_message_id
            : undefined
          )
      });
      if (deadProcessStall.completionPreparation) {
        const completionPreparation = deadProcessStall.completionPreparation;
        skipped += 1;
        if (!completionPreparation.claimed) {
          items.push({
            conversation_id: initialConversation.conversation_id,
            status: "skipped",
            reason: completionPreparation.reason
          });
        } else {
          const completionResult = runPreparedCallback(
            completionPreparation.prepared,
            { emit: false }
          );
          items.push({
            conversation_id: initialConversation.conversation_id,
            status: "recovered",
            reason: "bound_agent_process_dead_completion_recovered",
            delivered: completionResult.delivered
          });
        }
        continue;
      }
      if (deadProcessStall.stalled) {
        skipped += 1;
        items.push({
          conversation_id: initialConversation.conversation_id,
          status: "stalled",
          reason: deadProcessStall.reason
        });
        continue;
      }
      const initialTakeover = isRecord(
        initialConversation.native_session_takeover
      )
        ? initialConversation.native_session_takeover
        : undefined;
      const deferredTransferId = stringValue(
        initialTakeover?.deferred_foreground_transfer_id
      );
      if (deferredTransferId) {
        const deferredTransfer = loadDeferredForegroundTransfer(
          storeDir,
          deferredTransferId
        );
        if (!FINAL_DEFERRED_TRANSFER_STATUSES.has(deferredTransfer.status)) {
          const deferredControl = terminalControlFromTakeover(initialTakeover);
          const deferredPid = Number(initialTakeover?.terminal_agent_pid);
          if (
            !deferredControl ||
            !Number.isSafeInteger(deferredPid) ||
            deferredPid <= 1
          ) {
            throw new Error(
              `deferred foreground Turn ${initialConversation.conversation_id} ` +
              "lost its exact terminal process authority"
            );
          }
          const bridge = createTerminalAgentBridge(options);
          const deferredTerminal = await bridge.resolveStoredTerminal(
            "codex",
            deferredPid,
            deferredControl,
            { pid: deferredPid }
          );
          const releaseTerminalLock = acquireTerminalBridgeSendLock(
            storeDir,
            deferredControl,
            { timeoutMs: 30000 }
          );
          try {
            await recoverDeferredCodexForegroundTransferBeforeMutation({
              options,
              terminal: deferredTerminal
            });
          } finally {
            releaseTerminalLock();
          }
          initialConversation = loadState(statePath);
          const refreshedTransfer = loadDeferredForegroundTransfer(
            storeDir,
            deferredTransferId
          );
          if (!FINAL_DEFERRED_TRANSFER_STATUSES.has(refreshedTransfer.status)) {
            const pendingSubmission = terminalBridgeSubmission(
              initialConversation
            );
            const pendingTakeover = isRecord(
              initialConversation.native_session_takeover
            )
              ? initialConversation.native_session_takeover
              : undefined;
            const pendingAnchor = validateCodexRolloutAcceptanceAnchor(
              pendingTakeover?.codex_rollout_acceptance_anchor
            );
            if (
              pendingAnchor?.version !== 3 ||
              initialConversation.status !== "waiting_for_agent" ||
              pendingSubmission?.status !== "enter_dispatched" ||
              stringValue(pendingSubmission.message_id) !==
                stringValue(pendingTakeover?.terminal_bridge_message_id) ||
              refreshedTransfer.status !== "dispatch_started"
            ) {
              throw new Error(
                `deferred foreground Turn ${initialConversation.conversation_id} ` +
                "is not an exact pending candidate-set acceptance"
              );
            }
          }
        }
      }
      initialConversation = (
        await recoverVirginCodexPostSubmissionBinding({
          options,
          conversation: initialConversation,
          statePath,
          logPath
        })
      ).conversation;
      const reconciledTakeover = isRecord(
        initialConversation.native_session_takeover
      )
        ? initialConversation.native_session_takeover
        : undefined;
      const reconciledTransferId = stringValue(
        reconciledTakeover?.deferred_foreground_transfer_id
      );
      const reconciledTransfer = reconciledTransferId
        ? loadDeferredForegroundTransfer(storeDir, reconciledTransferId)
        : undefined;
      if (
        !reconciledTransfer ||
        FINAL_DEFERRED_TRANSFER_STATUSES.has(reconciledTransfer.status)
      ) {
        assertTurnBindingCurrent(initialConversation, "reconcile monitor for");
      }
      const initialEligibility = terminalBridgeReconciliationEligibility(initialConversation);
      if (!initialEligibility.eligible) {
        skipped += 1;
        items.push({
          conversation_id: initialConversation.conversation_id,
          status: "skipped",
          reason: initialEligibility.reason
        });
        continue;
      }

      const previousMonitorPid = latestTerminalBridgeMonitorLaunchPid(logPath);
      const unexpectedMonitorExit = previousMonitorPid !== undefined &&
        !isProcessAlive(previousMonitorPid);

      const activeOwner = activeTerminalBridgeMonitorOwner(
        statePath,
        initialEligibility.terminalMessageId
      );
      const currentOwnership = monitorOwner.decideCurrent({
        currentOwnerPresent: activeOwner !== undefined,
        currentOwnerPid: activeOwner?.ownerPid,
        monitorLockVersion:
          initialEligibility.nativeTakeover.terminal_bridge_monitor_lock_version
      });
      const ownership = currentOwnership.action === "inspect_legacy"
        ? (() => {
            const legacyLaunchPid = latestTerminalBridgeMonitorLaunchPid(logPath);
            return monitorOwner.decideLegacy({
              latestLaunchPid: legacyLaunchPid,
              launchProcessAlive: legacyLaunchPid !== undefined &&
                isProcessAlive(legacyLaunchPid)
            });
          })()
        : currentOwnership;
      if (ownership.action === "stop") {
        if (ownership.item.status === "already_running") {
          alreadyRunning += 1;
        } else {
          skipped += 1;
        }
        items.push({
          conversation_id: initialConversation.conversation_id,
          ...ownership.item
        });
        continue;
      }

      const prepared = prepareTerminalBridgeMonitorReconciliation({
        statePath,
        expectedMessageId: initialEligibility.terminalMessageId
      });
      if (!prepared.prepared) {
        if (prepared.alreadyRunning) {
          alreadyRunning += 1;
          items.push({
            conversation_id: initialConversation.conversation_id,
            status: "already_running",
            reason: prepared.reason,
            monitor_owner_pid: prepared.ownerPid ?? null
          });
        } else {
          skipped += 1;
          items.push({
            conversation_id: initialConversation.conversation_id,
            status: "skipped",
            reason: prepared.reason
          });
        }
        continue;
      }

      const monitor = startTerminalBridgeMonitorForConversation({
        conversation: prepared.conversation,
        statePath,
        logPath,
        options
      });
      if (!monitor) {
        skipped += 1;
        items.push({
          conversation_id: prepared.conversation.conversation_id,
          status: "skipped",
          reason: "terminal_bridge_monitor_launch_disabled"
        });
        continue;
      }

      const launchedAt = cliNow().toISOString();
      const launchReason = unexpectedMonitorExit
        ? "unexpected_exit_recovery"
        : reason;
      if (unexpectedMonitorExit) {
        appendEvent(logPath, {
          ts: launchedAt,
          conversation_id: prepared.conversation.conversation_id,
          event: "terminal_bridge_monitor_exit_observed",
          previous_monitor_pid: previousMonitorPid,
          terminal_control: prepared.terminalControl,
          reason: "monitor_owner_process_missing",
          observed_by: reason
        });
        runtimeLog("warn", "terminal_bridge_monitor_exit_observed", {
          conversation_id: prepared.conversation.conversation_id,
          previous_monitor_pid: previousMonitorPid,
          terminal_target: prepared.terminalControl.target,
          observed_by: reason
        });
      }
      appendEvent(logPath, {
        ts: launchedAt,
        conversation_id: prepared.conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: monitor.pid ?? null,
        terminal_control: prepared.terminalControl,
        reason: launchReason,
        agent_timeout_minutes: prepared.inactivityTimeoutMinutes,
        agent_hard_timeout_minutes: prepared.hardTimeoutMinutes
      });
      runtimeLog("info", "terminal_bridge_monitor_reconciled", {
        conversation_id: prepared.conversation.conversation_id,
        monitor_pid: monitor.pid ?? null,
        terminal_target: prepared.terminalControl.target
      });
      launched += 1;
      items.push({
        conversation_id: prepared.conversation.conversation_id,
        status: "launched",
        reason: launchReason,
        monitor_pid: monitor.pid ?? null,
        ...(unexpectedMonitorExit
          ? { previous_monitor_pid: previousMonitorPid }
          : {})
      });
    } catch (error) {
      if (error instanceof TurnBindingSupersededError) {
        skipped += 1;
        items.push({
          conversation_id: listedConversation.conversation_id,
          status: "skipped",
          reason: "session_binding_superseded"
        });
        continue;
      }
      errors += 1;
      items.push({
        conversation_id: listedConversation.conversation_id,
        status: "error",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    reconciled: true,
    store_dir: storeDir,
    checked: conversations.length,
    repaired: collateralStalls.repaired,
    collateral_stalls_checked: collateralStalls.checked,
    collateral_stalls_skipped: collateralStalls.skipped,
    ignored,
    launched,
    already_running: alreadyRunning,
    skipped,
    errors,
    items
  };
}

function prepareCallbackDeliveryReconciliation(input: {
  statePath: string;
  logPath: string;
  delayMs?: unknown;
}) {
  return callbackOutboxService().reconcileDelivery(input);
}

function terminalBridgeReconciliationEligibility(conversation: Conversation) {
  const eligibility = monitorEligibility(conversation);
  let step = eligibility.next();
  while (!step.done) {
    const request = step.value;
    step = eligibility.next(request.kind === "control"
      ? { kind: "control", terminalControl: terminalControlFromTakeover(
          request.nativeTakeover
        ) }
      : request.kind === "dispatch"
      ? { kind: "dispatch", ledger: loadTerminalBridgeDispatchLedger(request.terminalControl) }
      : request.kind === "store"
        ? { kind: "store", storeDir: managedSessionStoreDirForConversation(conversation) }
        : request.kind === "runtime"
          ? { kind: "runtime", runtime: terminalRuntimeIdentityForConversation(
              conversation, request.terminalControl
            ) }
          : { kind: "deferred", transfer: loadDeferredForegroundTransfer(
              request.storeDir, request.transferId
            ) });
  }
  return step.value;
}

function terminalAgentProcessDisposition(
  conversation: Conversation | Record<string, any>
): Record<string, any> | undefined {
  return isRecord(conversation.terminal_agent_process_disposition)
    ? conversation.terminal_agent_process_disposition
    : undefined;
}

function isVerifiedDeadTerminalAgentProcess(
  conversation: Conversation | Record<string, any>
): boolean {
  return isVerifiedDeadAgentProcessDisposition(
    terminalAgentProcessDisposition(conversation)
  );
}

function verifiedDeadAgentAuthorityContext({
  conversation,
  storeDir,
  terminalControl
}: {
  conversation: Conversation;
  storeDir: string;
  terminalControl: TerminalControlRef;
}): VerifiedDeadAgentAuthorityContext {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(conversation);
  const session = tryLoadManagedSession(
    storeDir,
    sessionIdForConversation(conversation)
  );
  const binding = session?.binding;
  return {
    terminalControl,
    conversation: {
      agent: executorForConversation(conversation).kind,
      conversationId: conversation.conversation_id,
      sessionId: sessionIdForConversation(conversation),
      turnId: turnIdForConversation(conversation),
      bindingId: stringValue(conversation.terminal_binding_id),
      bindingGeneration: Number(conversation.terminal_binding_generation)
    },
    ...(session
      ? {
          session: {
            status: session.status,
            agent: session.agent,
            workspaceMatchesConversation:
              path.resolve(session.workspace) ===
              path.resolve(conversation.workspace),
            ...(binding
              ? {
                  binding: {
                    terminalControl: binding.terminal_control,
                    pid: binding.native_process.pid,
                    processUuid: binding.native_process.process_uuid,
                    processBirth: binding.native_process.process_birth,
                    bindingId: binding.binding_id,
                    generation: binding.generation
                  }
                }
              : {})
          }
        }
      : {}),
    ...(takeover
      ? {
          takeover: {
            pid: Number(takeover.terminal_agent_pid),
            processUuid: stringValue(takeover.terminal_agent_process_uuid),
            processBirth: stringValue(takeover.terminal_agent_process_birth),
            bindingId: stringValue(takeover.terminal_binding_id),
            bindingGeneration: Number(takeover.terminal_binding_generation),
            messageId: stringValue(takeover.terminal_bridge_message_id)
          }
        }
      : {}),
    ...(submission
      ? {
          submission: {
            status: stringValue(submission.status),
            sessionId: stringValue(submission.session_id),
            turnId: stringValue(submission.turn_id),
            messageId: stringValue(submission.message_id),
            bindingId: stringValue(submission.binding_id),
            bindingGeneration: Number(submission.binding_generation)
          }
        }
      : {})
  };
}

function storedVerifiedDeadTerminalAgentProcessProof({
  conversation,
  storeDir,
  terminalControl
}: {
  conversation: Conversation;
  storeDir: string;
  terminalControl: TerminalControlRef;
}):
  | { status: "absent" }
  | {
      status: "valid";
      proof: VerifiedDeadTerminalAgentProcessProof;
      evidenceId: string;
      recordedAt: string;
    }
  | { status: "invalid"; reason: string } {
  const disposition = terminalAgentProcessDisposition(conversation);
  if (disposition?.status !== "verified_dead") {
    return { status: "absent" };
  }
  return validateStoredVerifiedDeadAgentAuthority({
    disposition,
    context: verifiedDeadAgentAuthorityContext({
      conversation,
      storeDir,
      terminalControl
    })
  });
}

function eventVerifiedDeadTerminalAgentProcessProof({
  conversation,
  storeDir,
  terminalControl,
  logPath
}: {
  conversation: Conversation;
  storeDir: string;
  terminalControl: TerminalControlRef;
  logPath: string;
}):
  | { status: "absent" }
  | {
      status: "valid";
      proof: VerifiedDeadTerminalAgentProcessProof;
      evidenceId: string;
      recordedAt: string;
    }
  | { status: "invalid"; reason: string } {
  const candidate = selectVerifiedDeadAgentEvent({
    events: readExistingEvents(logPath),
    conversationId: conversation.conversation_id
  });
  if (candidate.status !== "candidate") {
    return candidate;
  }
  return validateVerifiedDeadAgentEventAuthority({
    candidate,
    context: verifiedDeadAgentAuthorityContext({
      conversation,
      storeDir,
      terminalControl
    })
  });
}

function exactVerifiedDeadTerminalAgentProcessAuthority({
  conversation,
  storeDir,
  terminalControl,
  logPath
}: {
  conversation: Conversation;
  storeDir: string;
  terminalControl: TerminalControlRef;
  logPath: string;
}): VerifiedDeadAgentAuthorityDecision {
  const stored = storedVerifiedDeadTerminalAgentProcessProof({
    conversation,
    storeDir,
    terminalControl
  });
  if (stored.status === "invalid") {
    return stored;
  }
  const event = eventVerifiedDeadTerminalAgentProcessProof({
    conversation,
    storeDir,
    terminalControl,
    logPath
  });
  return reconcileVerifiedDeadAgentAuthority({ stored, event });
}

function ensureVerifiedDeadTerminalAgentProcessEvent({
  logPath,
  proof,
  action
}: {
  logPath: string;
  proof: VerifiedDeadTerminalAgentProcessProof;
  action: "managed_close" | "monitor_reconciliation";
}): {
  proof: VerifiedDeadTerminalAgentProcessProof;
  evidenceId: string;
  recordedAt: string;
} {
  const evidenceId = verifiedDeadTerminalAgentProcessEvidenceId(proof);
  const existing = readExistingEvents(logPath).find((event) =>
    event.event === "terminal_agent_process_verified_dead" &&
    event.conversation_id === proof.conversation_id &&
    event.evidence_id === evidenceId
  );
  if (existing) {
    const existingProof = isRecord(existing.proof)
      ? existing.proof as VerifiedDeadTerminalAgentProcessProof
      : undefined;
    const existingAt = stringValue(existing.ts);
    if (
      !existingProof ||
      !existingAt ||
      validTimestampMs(existingAt) === undefined ||
      existingProof.observed_at !== existingAt ||
      verifiedDeadTerminalAgentProcessEvidenceId(existingProof) !== evidenceId
    ) {
      throw new Error(
        `verified-dead process event ${evidenceId} is inconsistent`
      );
    }
    return {
      proof: existingProof,
      evidenceId,
      recordedAt: existingAt
    };
  }
  appendEvent(logPath, {
    ts: proof.observed_at,
    conversation_id: proof.conversation_id,
    event: "terminal_agent_process_verified_dead",
    evidence_id: evidenceId,
    status: "verified_dead",
    proof,
    action
  });
  return {
    proof,
    evidenceId,
    recordedAt: proof.observed_at
  };
}

function ensureVerifiedDeadConversationStalledEvent({
  logPath,
  proof,
  evidenceId,
  reason,
  terminalControl,
  completionObservation
}: {
  logPath: string;
  proof: VerifiedDeadTerminalAgentProcessProof;
  evidenceId: string;
  reason: string;
  terminalControl: TerminalControlRef;
  completionObservation: "absent" | "unverifiable";
}): void {
  const existing = readExistingEvents(logPath).find((event) =>
    event.event === "conversation_stalled" &&
    event.conversation_id === proof.conversation_id &&
    event.evidence_id === evidenceId
  );
  if (existing) {
    if (
      existing.ts !== proof.observed_at ||
      existing.reason !== reason ||
      existing.disposition !== "verified_dead_agent_process" ||
      existing.completion_observation !== completionObservation
    ) {
      throw new Error(
        `verified-dead stalled event ${evidenceId} is inconsistent`
      );
    }
    return;
  }
  appendEvent(logPath, {
    ts: proof.observed_at,
    conversation_id: proof.conversation_id,
    event: "conversation_stalled",
    evidence_id: evidenceId,
    status: "stalled",
    reason,
    terminal_bridge: true,
    terminal_control: terminalControl,
    disposition: "verified_dead_agent_process",
    completion_observation: completionObservation
  });
}

function verifiedDeadConversationStalledEventDecision({
  logPath,
  proof,
  evidenceId,
  reason
}: {
  logPath: string;
  proof: VerifiedDeadTerminalAgentProcessProof;
  evidenceId: string;
  reason: string;
}):
  | { status: "absent" }
  | {
      status: "valid";
      completionObservation: "absent" | "unverifiable";
    }
  | { status: "invalid"; reason: string } {
  const candidates = readExistingEvents(logPath).filter((event) =>
    event.event === "conversation_stalled" &&
    event.conversation_id === proof.conversation_id &&
    event.evidence_id === evidenceId
  );
  if (candidates.length === 0) {
    return { status: "absent" };
  }
  if (candidates.length !== 1) {
    return {
      status: "invalid",
      reason: "the verified-dead stalled event history is ambiguous"
    };
  }
  const event = candidates[0];
  const completionObservation = stringValue(event.completion_observation);
  if (
    event.ts !== proof.observed_at ||
    event.status !== "stalled" ||
    event.reason !== reason ||
    event.disposition !== "verified_dead_agent_process" ||
    !["absent", "unverifiable"].includes(completionObservation ?? "")
  ) {
    return {
      status: "invalid",
      reason: "the verified-dead stalled event decision is inconsistent"
    };
  }
  return {
    status: "valid",
    completionObservation:
      completionObservation as "absent" | "unverifiable"
  };
}

function ensureVerifiedDeadConversationClosedEvent({
  logPath,
  conversation,
  evidenceId
}: {
  logPath: string;
  conversation: Conversation;
  evidenceId: string;
}): void {
  const closedAt = required(
    stringValue(conversation.closed_at),
    "verified-dead closed Turn has no closed_at timestamp"
  );
  const reason = required(
    stringValue(conversation.close_reason),
    "verified-dead closed Turn has no close reason"
  );
  if (
    conversation.status !== "closed" ||
    validTimestampMs(closedAt) === undefined
  ) {
    throw new Error("verified-dead closed Turn state is inconsistent");
  }
  const existing = readExistingEvents(logPath).find((event) =>
    event.event === "conversation_closed" &&
    event.conversation_id === conversation.conversation_id &&
    event.evidence_id === evidenceId
  );
  if (existing) {
    if (
      existing.ts !== closedAt ||
      existing.status !== "closed" ||
      existing.reason !== reason ||
      existing.disposition !== "verified_dead_agent_process"
    ) {
      throw new Error(
        `verified-dead close event ${evidenceId} is inconsistent`
      );
    }
    return;
  }
  appendEvent(logPath, {
    ts: closedAt,
    conversation_id: conversation.conversation_id,
    event: "conversation_closed",
    evidence_id: evidenceId,
    status: "closed",
    reason,
    disposition: "verified_dead_agent_process"
  });
}

function acceptedTurnCanBeStalledForDeadAgent({
  storeDir,
  conversation
}: {
  storeDir: string;
  conversation: Conversation;
}): boolean {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const messageId = stringValue(takeover?.terminal_bridge_message_id);
  const submission = terminalBridgeSubmission(conversation);
  const transferId = stringValue(takeover?.deferred_foreground_transfer_id);
  const input = {
    conversationStatus: conversation.status,
    terminalBridge: takeover?.terminal_bridge === true,
    messageId,
    submissionStatus: stringValue(submission?.status),
    submissionMessageId: stringValue(submission?.message_id),
    deferredTransferId: transferId
  };
  const decision = decideAcceptedTurnDeadAgentStall(input);
  if (decision.status !== "requires_deferred_transfer") {
    return decision.status === "applicable";
  }
  const transfer = loadDeferredForegroundTransfer(
    storeDir,
    decision.transferId
  );
  return decideAcceptedTurnDeadAgentStall({
    ...input,
    deferredTransferStatus: transfer.status
  }).status === "applicable";
}

async function stallAcceptedTurnForVerifiedDeadAgent({
  options,
  storeDir,
  statePath,
  logPath,
  expectedConversationId,
  expectedMessageId
}: {
  options: Record<string, any>;
  storeDir: string;
  statePath: string;
  logPath: string;
  expectedConversationId: string;
  expectedMessageId?: string;
}): Promise<{
  stalled: boolean;
  conversation: Conversation;
  reason: string;
  completionPreparation?: ReturnType<
    typeof prepareTerminalBridgeCompletionCallbackWithLocksHeld
  >;
}> {
  const canonicalStoreDir = pathsForConversationDir(
    path.dirname(statePath)
  ).storeDir;
  if (path.resolve(storeDir) !== path.resolve(canonicalStoreDir)) {
    const conversation = loadState(statePath);
    return {
      stalled: false,
      conversation,
      reason: "dead_process_stall_store_mismatch"
    };
  }
  const initial = loadState(statePath);
  const initialTakeover = isRecord(initial.native_session_takeover)
    ? initial.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(initialTakeover);
  if (
    initial.conversation_id !== expectedConversationId ||
    !terminalControl ||
    !acceptedTurnCanBeStalledForDeadAgent({ storeDir, conversation: initial })
  ) {
    return {
      stalled: false,
      conversation: initial,
      reason: "dead_process_stall_not_applicable"
    };
  }
  const releaseTerminalLock = acquireTerminalBridgeSendLock(
    storeDir,
    terminalControl,
    { timeoutMs: 30000 }
  );
  try {
    return await withStoreWriterLeaseAsync(storeDir, async () => {
      const releaseStateLock = acquireFileLock(`${statePath}.lock`);
      let stateLockReleased = false;
      try {
        const current = loadState(statePath);
        const takeover = isRecord(current.native_session_takeover)
          ? current.native_session_takeover
          : undefined;
        const currentControl = terminalControlFromTakeover(takeover);
        const messageId = stringValue(takeover?.terminal_bridge_message_id);
        if (
          current.conversation_id !== expectedConversationId ||
          (expectedMessageId !== undefined && messageId !== expectedMessageId) ||
          !currentControl ||
          !terminalControlsShareIncarnation(currentControl, terminalControl) ||
          !acceptedTurnCanBeStalledForDeadAgent({
            storeDir,
            conversation: current
          })
        ) {
          return {
            stalled: false,
            conversation: current,
            reason: "dead_process_stall_generation_changed"
          };
        }
        assertTurnBindingCurrent(current, "stall a verified-dead agent Turn for");
        const ledger = loadTerminalBridgeDispatchLedger(currentControl);
        if (
          !ledger ||
          stringValue(ledger.status) !== "agent_accepted" ||
          !sameCanonicalStatePath(ledger.state_path, statePath) ||
          path.resolve(stringValue(ledger.store_dir) ?? "") !==
            path.resolve(storeDir) ||
          path.resolve(stringValue(ledger.event_log_path) ?? "") !==
            path.resolve(logPath) ||
          stringValue(ledger.conversation_id) !== current.conversation_id ||
          stringValue(ledger.session_id) !== sessionIdForConversation(current) ||
          stringValue(ledger.turn_id) !== turnIdForConversation(current) ||
          stringValue(ledger.message_id) !== messageId ||
          !terminalDispatchRecordMatchesControl(ledger, currentControl, {
            requireProcessAnchor: true
          }) ||
          terminalDispatchRecordProcessAnchor(ledger) !==
            terminalEndpointFromControlRef(currentControl).processAnchorPid ||
          stringValue(ledger.binding_id) !==
            stringValue(current.terminal_binding_id) ||
          Number(ledger.binding_generation) !==
            Number(current.terminal_binding_generation)
        ) {
          return {
            stalled: false,
            conversation: current,
            reason: "dead_process_stall_dispatch_changed"
          };
        }
        try {
          assertVerifiedDeadTerminalBridgeDispatchAuthority({
            terminalControl: currentControl,
            conversation: current,
            storeDir,
            statePath,
            logPath,
            expectedMessageId: required(
              messageId,
              "verified-dead stall has no terminal message id"
            )
          });
        } catch (error) {
          return {
            stalled: false,
            conversation: current,
            reason:
              "dead_process_stall_dispatch_changed: " +
              (error instanceof Error ? error.message : String(error))
          };
        }
        const persistedAuthority =
          exactVerifiedDeadTerminalAgentProcessAuthority({
            conversation: current,
            storeDir,
            terminalControl: currentControl,
            logPath
          });
        const persistedDecision = decideVerifiedDeadAgentProcess({
          persistedAuthority
        });
        if (persistedDecision.status === "invalid") {
          return {
            stalled: false,
            conversation: current,
            reason: `bound_agent_process_evidence_invalid: ${persistedDecision.reason}`
          };
        }
        let proof: VerifiedDeadTerminalAgentProcessProof;
        if (persistedDecision.status === "verified_dead") {
          proof = persistedDecision.proof;
        } else {
          const observation = await observeBoundTerminalAgentProcess({
            options,
            conversation: current,
            terminalControl: currentControl
          });
          const observedDecision = decideVerifiedDeadAgentProcess({
            persistedAuthority: { status: "absent" },
            observation
          });
          if (observedDecision.status !== "verified_dead") {
            return {
              stalled: false,
              conversation: current,
              reason: observedDecision.status === "alive"
                ? "bound_agent_process_alive"
                : `bound_agent_process_unverifiable: ${observedDecision.reason}`
            };
          }
          proof = observedDecision.proof;
        }
        const stalledReason =
          "bound terminal agent process is verified dead";
        const priorStalledDecision =
          verifiedDeadConversationStalledEventDecision({
            logPath,
            proof,
            evidenceId: verifiedDeadTerminalAgentProcessEvidenceId(proof),
            reason: stalledReason
          });
        if (priorStalledDecision.status === "invalid") {
          return {
            stalled: false,
            conversation: current,
            reason:
              `bound_agent_process_evidence_invalid: ${priorStalledDecision.reason}`
          };
        }
        if (priorStalledDecision.status === "valid") {
          if (persistedAuthority.status !== "valid") {
            return {
              stalled: false,
              conversation: current,
              reason:
                "bound_agent_process_evidence_invalid: the stalled decision has no exact death event"
            };
          }
          const stalled: Conversation = {
            ...current,
            status: "stalled",
            stalled_at: persistedAuthority.recordedAt,
            stalled_reason: stalledReason,
            terminal_agent_process_disposition: {
              status: "verified_dead",
              proof: persistedAuthority.proof,
              evidence_id: persistedAuthority.evidenceId,
              recorded_at: persistedAuthority.recordedAt,
              completion_observation: {
                status: priorStalledDecision.completionObservation
              }
            },
            updated_at: persistedAuthority.recordedAt
          };
          saveState(statePath, stalled);
          return {
            stalled: true,
            conversation: stalled,
            reason:
              priorStalledDecision.completionObservation === "unverifiable"
                ? "bound_agent_process_verified_dead_completion_unverifiable"
                : "bound_agent_process_verified_dead"
          };
        }
        const durableCompletion =
          await observeDurableCompletionBeforeDeadStall({
            options,
            conversation: current,
            terminalControl: currentControl
          });
        const completionDecision =
          decideVerifiedDeadAgentCompletion(durableCompletion);
        if (completionDecision.action === "complete") {
          // Completion claiming re-enters the Turn state lock. Keep the
          // canonical terminal and Store-writer locks, but release the state
          // lock before preparing the callback/local completion atomically.
          releaseStateLock();
          stateLockReleased = true;
          const completionPreparation =
            prepareTerminalBridgeCompletionCallbackWithLocksHeld({
              options,
              statePath,
              logPath,
              conversation: current,
              executor: executorForConversation(current),
              terminalControl: currentControl,
              terminalMessageId: required(
                messageId,
                "verified-dead completion has no terminal message id"
              ),
              completion: completionDecision.completion
            });
          return {
            stalled: false,
            conversation: completionPreparation.conversation,
            reason: completionPreparation.claimed
              ? "bound_agent_process_dead_completion_prepared"
              : `bound_agent_process_dead_completion_${completionPreparation.reason}`,
            completionPreparation
          };
        }
        const completionUnverifiable =
          completionDecision.completionObservation === "unverifiable";
        // Keep the durable lifecycle reason independent of a transient
        // completion-read outcome. If the process crashes between the
        // append-only events and state save, a later reconciliation must be
        // able to reuse the same death evidence even when the transcript or
        // rollout has become readable in the meantime.
        const reason = stalledReason;
        const audit = ensureVerifiedDeadTerminalAgentProcessEvent({
          logPath,
          proof,
          action: "monitor_reconciliation"
        });
        ensureVerifiedDeadConversationStalledEvent({
          logPath,
          proof: audit.proof,
          evidenceId: audit.evidenceId,
          reason,
          terminalControl: currentControl,
          completionObservation:
            completionUnverifiable ? "unverifiable" : "absent"
        });
        if (
          cliEnv().AKK_TEST_EXIT_AFTER_VERIFIED_DEAD_STALL_EVENTS === "1"
        ) {
          cliExit(86);
        }
        const stalled: Conversation = {
          ...current,
          status: "stalled",
          stalled_at: audit.recordedAt,
          stalled_reason: reason,
          terminal_agent_process_disposition: {
            status: "verified_dead",
            proof: audit.proof,
            evidence_id: audit.evidenceId,
            recorded_at: audit.recordedAt,
            completion_observation: {
              status: completionUnverifiable ? "unverifiable" : "absent"
            }
          },
          updated_at: audit.recordedAt
        };
        saveState(statePath, stalled);
        runtimeLog("warn", "terminal_agent_process_verified_dead", {
          conversation_id: current.conversation_id,
          terminal_target: currentControl.target,
          pid: audit.proof.pid,
          reason
        });
        return {
          stalled: true,
          conversation: stalled,
          reason: completionDecision.resultReason
        };
      } finally {
        if (!stateLockReleased) {
          releaseStateLock();
        }
      }
    });
  } finally {
    releaseTerminalLock();
  }
}

function settleLocalTerminalBridgeCompletionClaim({
  storeDir,
  statePath,
  logPath
}: {
  storeDir: string;
  statePath: string;
  logPath: string;
}): {
  handled: boolean;
  recovered: boolean;
  reason: string;
} {
  const initial = loadState(statePath);
  const initialTakeover = isRecord(initial.native_session_takeover)
    ? initial.native_session_takeover
    : undefined;
  const initialClaim = isRecord(
    initialTakeover?.terminal_bridge_completion_claim
  )
    ? initialTakeover.terminal_bridge_completion_claim
    : undefined;
  if (
    stringValue(initial.gateway_method) ||
    !initialClaim ||
    !["idle", "failed"].includes(String(initial.status))
  ) {
    return {
      handled: false,
      recovered: false,
      reason: "local_completion_not_applicable"
    };
  }
  const initialTerminalControl = terminalControlFromTakeover(initialTakeover);
  if (!initialTerminalControl) {
    throw new Error(
      `local terminal completion ${initial.conversation_id} lost its terminal authority`
    );
  }
  const releaseTerminalLock = acquireTerminalBridgeSendLock(
    storeDir,
    initialTerminalControl,
    { timeoutMs: 30000 }
  );
  try {
    return withStoreWriterLease(storeDir, () => {
      const releaseStateLock = acquireFileLock(`${statePath}.lock`);
      try {
        const conversation = loadState(statePath);
        const takeover = isRecord(conversation.native_session_takeover)
          ? conversation.native_session_takeover
          : undefined;
        const claim = isRecord(takeover?.terminal_bridge_completion_claim)
          ? takeover.terminal_bridge_completion_claim
          : undefined;
        const terminalControl = terminalControlFromTakeover(takeover);
        const terminalMessageId = stringValue(
          takeover?.terminal_bridge_message_id
        );
        const callbackMessageId = stringValue(claim?.callback_message_id);
        const completionFingerprint = stringValue(
          claim?.completion_fingerprint
        );
        const completionId = stringValue(claim?.completion_id);
        const claimedAt = stringValue(claim?.claimed_at);
        const outcome = stringValue(claim?.outcome);
        const expectedMessageType = outcome === "success"
          ? "done"
          : outcome === "failure"
            ? "error"
            : undefined;
        if (
          stringValue(conversation.gateway_method) ||
          conversation.callback_delivery !== undefined ||
          !claim ||
          !terminalControl ||
          !terminalControlsShareIncarnation(
            terminalControl,
            initialTerminalControl
          ) ||
          !terminalMessageId ||
          !callbackMessageId ||
          !completionFingerprint ||
          !completionId ||
          !claimedAt ||
          validTimestampMs(claimedAt) === undefined ||
          !expectedMessageType ||
          (outcome === "success" && conversation.status !== "idle") ||
          (outcome === "failure" && conversation.status !== "failed") ||
          deterministicTerminalCallbackMessageId({
            conversationId: conversation.conversation_id,
            terminalMessageId,
            completionFingerprint,
            outcome: outcome!
          }) !== callbackMessageId
        ) {
          throw new Error(
            `local terminal completion ${conversation.conversation_id} has ` +
            "inconsistent claim, Turn phase, or callback authority"
          );
        }
        const submission = terminalBridgeSubmission(conversation);
        if (
          submission?.status !== "agent_accepted" ||
          stringValue(submission.message_id) !== terminalMessageId ||
          stringValue(submission.session_id) !==
            sessionIdForConversation(conversation) ||
          stringValue(submission.turn_id) !== turnIdForConversation(conversation)
        ) {
          throw new Error(
            `local terminal completion ${conversation.conversation_id} is ` +
            "not tied to one accepted terminal submission"
          );
        }
        const events = readExistingEvents(logPath);
        const claimed = events.some((event) =>
          event.event === "terminal_bridge_completion_claimed" &&
          event.conversation_id === conversation.conversation_id &&
          event.terminal_bridge_message_id === terminalMessageId &&
          event.completion_fingerprint === completionFingerprint &&
          event.completion_id === completionId &&
          event.callback_message_id === callbackMessageId &&
          event.outcome === outcome &&
          event.ts === claimedAt
        );
        const detected = events.some((event) =>
          event.event === "terminal_bridge_completion_detected" &&
          event.conversation_id === conversation.conversation_id &&
          event.terminal_bridge_message_id === terminalMessageId &&
          event.completion_id === completionId &&
          event.callback_message_id === callbackMessageId &&
          event.completion_outcome === outcome
        );
        const messageRecorded = events.some((event) => {
          const message = isRecord(event.message) ? event.message : undefined;
          const metadata = isRecord(message?.metadata)
            ? message.metadata
            : undefined;
          return event.event === "message" &&
            event.conversation_id === conversation.conversation_id &&
            event.session_id === sessionIdForConversation(conversation) &&
            event.turn_id === turnIdForConversation(conversation) &&
            message?.id === callbackMessageId &&
            message?.type === expectedMessageType &&
            message?.to === "openclaw" &&
            message?.requires_response === false &&
            metadata?.terminal_bridge_message_id === terminalMessageId;
        });
        if (!claimed || !detected || !messageRecorded) {
          throw new Error(
            `local terminal completion ${conversation.conversation_id} is ` +
            "missing exact claim, detection, or message evidence"
          );
        }
        const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
        const expectedBindingId = stringValue(
          conversation.terminal_binding_id
        );
        const expectedBindingGeneration = Number(
          conversation.terminal_binding_generation
        );
        if (
          !ledger ||
          !["agent_accepted", "resolved"].includes(String(ledger.status)) ||
          !terminalDispatchRecordMatchesControl(ledger, terminalControl) ||
          stringValue(ledger.conversation_id) !== conversation.conversation_id ||
          stringValue(ledger.session_id) !== sessionIdForConversation(conversation) ||
          stringValue(ledger.turn_id) !== turnIdForConversation(conversation) ||
          stringValue(ledger.message_id) !== terminalMessageId ||
          stringValue(ledger.native_thread_id) !==
            stringValue(conversation.native_thread_id) ||
          (expectedBindingId !== undefined &&
            stringValue(ledger.binding_id) !== expectedBindingId) ||
          (Number.isSafeInteger(expectedBindingGeneration) &&
            Number(ledger.binding_generation) !== expectedBindingGeneration) ||
          path.resolve(stringValue(ledger.store_dir) ?? "") !==
            path.resolve(storeDir) ||
          !sameCanonicalStatePath(ledger.state_path, statePath)
        ) {
          throw new Error(
            `local terminal completion ${conversation.conversation_id} has ` +
            "no exact accepted terminal ledger"
          );
        }
        if (ledger.status === "resolved") {
          return {
            handled: true,
            recovered: false,
            reason: "local_terminal_completion_already_settled"
          };
        }
        if (!resolveTerminalBridgeDispatchLedger(terminalControl, {
          conversation,
          expectedMessageId: terminalMessageId,
          reason: "callbackless terminal bridge task reached durable completion"
        })) {
          throw new Error(
            `local terminal completion ${conversation.conversation_id} ` +
            "changed before ledger settlement"
          );
        }
        appendEvent(logPath, {
          ts: cliNow().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_local_completion_settled",
          terminal_bridge_message_id: terminalMessageId,
          completion_id: completionId,
          callback_message_id: callbackMessageId,
          outcome
        });
        return {
          handled: true,
          recovered: true,
          reason: "local_terminal_completion_ledger_recovered"
        };
      } finally {
        releaseStateLock();
      }
    });
  } finally {
    releaseTerminalLock();
  }
}

function latestTerminalBridgeMonitorLaunchPid(logPath: string): number | undefined {
  try {
    return monitorOwner.latestLaunchPid(readExistingEvents(logPath));
  } catch {
    return undefined;
  }
}

function prepareTerminalBridgeMonitorReconciliation({
  statePath,
  expectedMessageId,
  requireWaitingForAgentStatus = false
}: {
  statePath: string;
  expectedMessageId: string;
  requireWaitingForAgentStatus?: boolean;
}) {
  const releaseStateLock = acquireFileLock(`${statePath}.lock`);
  try {
    const conversation = loadState(statePath);
    if (
      requireWaitingForAgentStatus &&
      conversation.status !== "waiting_for_agent"
    ) {
      return {
        prepared: false as const,
        alreadyRunning: false,
        reason: `conversation_status_${String(
          conversation.status ?? "missing"
        )}`
      };
    }
    const eligibility = terminalBridgeReconciliationEligibility(conversation);
    if (!eligibility.eligible) {
      return {
        prepared: false as const,
        alreadyRunning: false,
        reason: eligibility.reason
      };
    }
    if (eligibility.terminalMessageId !== expectedMessageId) {
      return {
        prepared: false as const,
        alreadyRunning: false,
        reason: "terminal_bridge_task_replaced"
      };
    }

    const activeOwner = activeTerminalBridgeMonitorOwner(
      statePath,
      eligibility.terminalMessageId
    );
    if (activeOwner) {
      return {
        prepared: false as const,
        alreadyRunning: true,
        reason: "monitor_lock_owner_alive",
        ownerPid: activeOwner.ownerPid
      };
    }

    const nextNativeTakeover = {
      ...eligibility.nativeTakeover,
      terminal_bridge_monitor_lock_version: monitorOwner.LOCK_VERSION
    };
    const needsSave =
      eligibility.nativeTakeover.terminal_bridge_monitor_lock_version !==
        monitorOwner.LOCK_VERSION;
    const preparedConversation = needsSave
      ? {
          ...conversation,
          native_session_takeover: nextNativeTakeover,
          updated_at: cliNow().toISOString()
        }
      : conversation;
    if (needsSave) {
      saveState(statePath, preparedConversation);
    }
    return {
      prepared: true as const,
      conversation: preparedConversation,
      terminalControl: eligibility.terminalControl,
      inactivityTimeoutMinutes: eligibility.inactivityTimeoutMinutes,
      hardTimeoutMinutes: eligibility.hardTimeoutMinutes
    };
  } finally {
    releaseStateLock();
  }
}

function positiveMinutes(value, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return parsed;
}

function positiveSafeInteger(value: unknown, optionName: string): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${optionName} must be a positive safe integer`);
  }
  return parsed;
}

async function runCancel(options) {
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    await runTerminalConversationCancel({
      options,
      conversationId: terminalConversation.conversationId,
      agent: terminalConversation.agent,
      terminalControl: terminalConversation.terminalControl,
      pid: terminalConversation.pid
    });
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const conversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  if (!["waiting_for_agent", "waiting_for_openclaw"].includes(conversation.status)) {
    throw new Error(`cannot cancel ${conversation.conversation_id}; conversation is ${conversation.status}`);
  }

  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (terminalControl) {
    await runTerminalControlCancel({
      options,
      statePath,
      logPath,
      agent: executorForConversation(conversation).kind,
      terminalControl
    });
    return;
  }

  throw new Error(
    `conversation ${conversation.conversation_id} is not attached to a live terminal`
  );
}

async function runTerminalConversationCancel({ options, conversationId, agent, terminalControl, pid }) {
  const storeDir = storeDirFromOptions(options);
  await withCanonicalMutationLocks(
    terminalWriterMutationLocks(storeDir, terminalControl),
    async () => {
      assertTerminalHasNoNonterminalDeferredForegroundTransfer({
        storeDir,
        pid,
        terminalControl,
        action: "cancel"
      });
      const cancellation = await createTerminalAgentBridge(options).cancel(agent, terminalControl, {
        runtime: {
          pid,
          cwd: terminalControl.currentPath,
          terminalTarget: terminalControl.target
        },
        scrollbackLines: Number(options.scrollbackLines ?? 120)
      });
      runtimeLog("info", "terminal_cancel_requested", {
        conversation_id: conversationId,
        agent,
        terminal_target: terminalControl.target,
        key: cancellation.key,
        keys: cancellation.keys,
        denied_approval: cancellation.deniedApproval,
        request_id: cancellation.requestId,
        cancel_requested: cancellation.cancelRequested,
        reason: cancellation.reason
      });

      printJson({
        conversation_id: conversationId,
        source: "terminal_control",
        cancel_requested: cancellation.cancelRequested,
        reason: cancellation.reason,
        terminal_control: terminalControl,
        key: cancellation.key,
        keys: cancellation.keys,
        denied_approval: cancellation.deniedApproval,
        request_id: cancellation.requestId
      });
  });
}

async function runTerminalControlCancel({ options, statePath, logPath, agent, terminalControl }) {
  const releaseTerminalLock = acquireTerminalBridgeSendLock(
    storeDirFromOptions(options),
    terminalControl,
    { timeoutMs: 30000 }
  );
  let releaseStateLock: (() => void) | undefined;
  try {
    releaseStateLock = acquireFileLock(`${statePath}.lock`);
    const writerStoreDir = pathsForConversationDir(
      path.dirname(statePath)
    ).storeDir;
    return await withStoreWriterLeaseAsync(writerStoreDir, async () => {
    const currentConversation = loadState(statePath);
    if (!["waiting_for_agent", "waiting_for_openclaw"].includes(currentConversation.status)) {
      throw new Error(
        `cannot cancel ${currentConversation.conversation_id}; conversation is ${currentConversation.status}`
      );
    }
    const currentTakeover = isRecord(currentConversation.native_session_takeover)
      ? currentConversation.native_session_takeover
      : undefined;
    const currentControl = terminalControlFromTakeover(currentTakeover);
    if (
      !currentControl ||
      !terminalControlsShareIncarnation(currentControl, terminalControl)
    ) {
      throw new Error(
        "terminal control changed while waiting to cancel; refresh status and retry"
      );
    }
    assertManagedTerminalDispatchOwner({
      storeDir: writerStoreDir,
      conversation: currentConversation,
      terminalControl: currentControl,
      action: "cancel"
    });

    const cancellation = await createTerminalAgentBridge(options).cancel(agent, currentControl, {
      runtime: terminalRuntimeIdentityForConversation(currentConversation, currentControl),
      scrollbackLines: Number(options.scrollbackLines ?? 120)
    });
    if (!cancellation.cancelRequested) {
      printJson({
        conversation: currentConversation,
        cancel_requested: false,
        reason: cancellation.reason,
        terminal_control: currentControl,
        budget: budgetAction(currentConversation)
      });
      return;
    }

    const now = cliNow().toISOString();
    appendEvent(logPath, {
      ts: now,
      conversation_id: currentConversation.conversation_id,
      event: "terminal_cancel_requested",
      terminal_control: currentControl,
      key: cancellation.key,
      keys: cancellation.keys,
      denied_approval: cancellation.deniedApproval,
      request_id: cancellation.requestId
    });
    runtimeLog("info", "terminal_cancel_requested", {
      conversation_id: currentConversation.conversation_id,
      agent,
      terminal_target: currentControl.target,
      key: cancellation.key,
      keys: cancellation.keys,
      denied_approval: cancellation.deniedApproval,
      request_id: cancellation.requestId
    });

    const nextConversation = {
      ...currentConversation,
      status: "cancelled" as const,
      cancelled_at: now,
      terminal_cancel_requested_at: now,
      updated_at: now
    };
    saveState(statePath, nextConversation);

    printJson({
      conversation: nextConversation,
      cancel_requested: true,
      terminal_control: currentControl,
      key: cancellation.key,
      keys: cancellation.keys,
      denied_approval: cancellation.deniedApproval,
      request_id: cancellation.requestId,
      budget: budgetAction(nextConversation)
    });
    });
  } finally {
    try {
      releaseStateLock?.();
    } finally {
      releaseTerminalLock();
    }
  }
}

async function runObservedHandoffClose({
  options,
  statePath,
  logPath,
  initialConversation
}: {
  options: Record<string, any>;
  statePath: string;
  logPath: string;
  initialConversation: Conversation;
}): Promise<void> {
  const expectedToken = required(
    stringValue(options.expectedHandoffToken),
    "--expected-handoff-token is required"
  );
  if (
    stringValue(options.expectedMessageId) ||
    stringValue(options.expectedTransitionId)
  ) {
    throw new Error(
      "--expected-handoff-token cannot be combined with dispatch or lifecycle recovery tokens"
    );
  }
  if (stringValue(options.reason) !== "superseded_by_human_context_switch") {
    throw new Error(
      "a handoff close requires reason superseded_by_human_context_switch"
    );
  }
  const storeDir = pathsForConversationDir(path.dirname(statePath)).storeDir;
  const sourceSessionId = sessionIdForConversation(initialConversation);
  const initialSource = loadManagedSession(storeDir, sourceSessionId);
  if (!initialSource.binding || initialSource.status !== "bound") {
    throw new Error("handoff source Session is no longer bound; refresh list");
  }
  const terminal = await createTerminalAgentBridge(options).resolveStoredTerminal(
    initialSource.agent,
    initialSource.binding.native_process.pid,
    initialSource.binding.terminal_control,
    { pid: initialSource.binding.native_process.pid }
  );
  await withCanonicalMutationLocks(terminalWriterStateMutationLocks(
    storeDir, terminal.terminalControl, statePath, logPath
  ), async (scopes, resources) => {
        const conversation = mutationConversationStore.load(
          scopes, resources
        );
        const turnId = turnIdForConversation(conversation);
        if (
          conversation.conversation_id !== initialConversation.conversation_id ||
          sessionIdForConversation(conversation) !== sourceSessionId ||
          !SESSION_SEND_BLOCKING_STATUSES.has(conversation.status)
        ) {
          throw new Error(
            "active handoff Turn changed after it was listed; refresh AKK list"
          );
        }
        const source = mutationManagedSessions.load(
          scopes, resources, sourceSessionId
        );
        if (
          source.status !== "bound" ||
          !source.binding ||
          terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(storeDir, source)
        ) {
          throw new Error(
            "handoff source Session changed after it was listed; refresh AKK list"
          );
        }
        const companions = codexAllowedCompanionSetForManagedSession({
          storeDir,
          session: source
        });
        const resolved = await resolveCurrentNativeAgentSessionIdentity({
          options,
          agent: terminal.agent,
          pid: terminal.pid,
          cwd: terminal.terminalControl.currentPath,
          preferredSessionId: companions.primary
            ? source.binding.native_thread_id
            : undefined,
          allowedCompanionIdentity: companions.primary,
          allowedAdditionalIdentities: companions.additional
        });
        const observed = await observedExternalHandoffIdentity({
          options,
          terminal,
          sourceSession: source,
          resolvedIdentity: resolved
        });
        if (
          !observed.identity ||
          managedBindingConflictKindForResolvedTerminal({
            storeDir,
            session: source,
            terminal,
            identity: observed.identity
          }) !== "live_external_thread_change"
        ) {
          throw new Error(
            "live native thread no longer matches the listed handoff; refresh AKK list"
          );
        }
        const targetNativeThreadId = observed.identity.sessionId.toLowerCase();
        const target = observedHandoffTargetResolution({
          storeDir,
          agent: terminal.agent,
          workspace: terminal.terminalControl.currentPath ?? cliCwd(),
          nativeThreadId: targetNativeThreadId,
          sourceSessionId
        });
        if (target.status !== "eligible") {
          throw new Error(
            "handoff target Session changed after it was listed; refresh AKK list"
          );
        }
        await assertNativeThreadHasExclusiveOwnership({
          options,
          agent: terminal.agent,
          currentPid: terminal.pid,
          nativeThreadId: targetNativeThreadId,
          storeDir,
          terminalControl: terminal.terminalControl,
          excludedManagedSessionId: target.snapshot.state === "detached"
            ? target.snapshot.session_id
            : undefined
        });
        const handoffToken = observedHandoffAuthorityToken({
          terminal,
          identity: observed.identity,
          sourceSession: source,
          target: target.snapshot
        });
        const takeover = isRecord(conversation.native_session_takeover)
          ? conversation.native_session_takeover
          : undefined;
        const expectedMessageId = stringValue(
          takeover?.terminal_bridge_message_id
        ) ?? stringValue(terminalBridgeSubmission(conversation)?.message_id);
        const ledger = mutationDispatchLedger.load(
          scopes, resources
        );
        const exactDispatchGeneration = Boolean(
          expectedMessageId &&
          ledger &&
          !terminalDispatchLedgerLooksLifecycle(ledger) &&
          stringValue(ledger.conversation_id) ===
            conversation.conversation_id &&
          stringValue(ledger.session_id) === sourceSessionId &&
          stringValue(ledger.turn_id) === turnId &&
          stringValue(ledger.message_id) === expectedMessageId
        );
        const exactNoLedgerGeneration = Boolean(
          !expectedMessageId &&
          (!ledger || ledger.status === "resolved")
        );
        if (!exactDispatchGeneration && !exactNoLedgerGeneration) {
          throw new Error(
            "active handoff dispatch generation changed; refresh AKK list"
          );
        }
        const freshToken = activeTurnHandoffDecisionToken({
          handoffToken,
          turn: conversation,
          ledger
        });
        if (freshToken !== expectedToken) {
          throw new Error(
            "active handoff snapshot changed; refresh AKK list before closing"
          );
        }
        const now = cliNow().toISOString();
        const closed: Conversation = {
          ...conversation,
          status: "closed",
          closed_at: now,
          close_reason: "superseded_by_human_context_switch",
          disposition: "superseded_by_human_context_switch",
          updated_at: now
        };
        mutationConversationStore.save(scopes, resources, closed);
        const dispatchResolved = expectedMessageId
          ? mutationDispatchLedger.resolve(
              scopes, resources, {
              conversation: closed,
              expectedMessageId,
              reason: "Turn superseded by a verified human context switch"
            })
          : false;
        if (expectedMessageId && !dispatchResolved) {
          throw new Error(
            "active handoff dispatch changed during close; inspect before retrying"
          );
        }
        mutationConversationStore.appendEvent(scopes, resources, {
          ts: now,
          conversation_id: conversation.conversation_id,
          event: "conversation_closed",
          status: "closed",
          reason: "superseded_by_human_context_switch",
          disposition: "superseded_by_human_context_switch",
          handoff_native_thread_id: targetNativeThreadId
        });
        runtimeLog("info", "conversation_closed", {
          conversation_id: conversation.conversation_id,
          status: "closed",
          reason: "superseded_by_human_context_switch",
          disposition: "superseded_by_human_context_switch",
          state_path: statePath,
          event_log_path: logPath
        });
        printJson({
          conversation: closed,
          closed: true,
          terminal_dispatch_resolved: dispatchResolved,
          handoff_disposition: "superseded_by_human_context_switch",
          next_action: "refresh list and use its follow-current send"
        });
  });
}

async function runClose(options) {
  const terminalConversation =
    await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    if (stringValue(options.expectedHandoffToken)) {
      throw new Error(
        "--expected-handoff-token cannot be used with raw terminal close"
      );
    }
    await runTerminalDispatchClose({
      options,
      terminalConversation
    });
    return;
  }
  const loaded = loadConversationFromOptions(options);
  if (stringValue(options.expectedHandoffToken)) {
    await runObservedHandoffClose({
      options,
      statePath: loaded.statePath,
      logPath: loaded.logPath,
      initialConversation: loaded.conversation
    });
    return;
  }
  if (stringValue(options.reason) === "superseded_by_human_context_switch") {
    throw new Error(
      "reason superseded_by_human_context_switch requires the fresh " +
      "expected_handoff_token advertised by AKK list"
    );
  }
  const { statePath, logPath } = loaded;
  const closeStoreDir = pathsForConversationDir(
    path.dirname(statePath)
  ).storeDir;
  const nativeTakeover = isRecord(loaded.conversation.native_session_takeover)
    ? loaded.conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  const releaseTerminalLock = terminalControl
    ? acquireTerminalBridgeSendLock(
        closeStoreDir,
        terminalControl,
        { timeoutMs: 30000 }
      )
    : () => {};
  const closeWithFreshState = async (): Promise<void> => {
    const releaseStateLock = acquireFileLock(`${statePath}.lock`);
    try {
      const conversation = loadState(statePath);
      let verifiedDeadProcess: VerifiedDeadTerminalAgentProcessProof | undefined;
      assertConversationHasNoNonterminalDeferredForegroundTransfer({
        storeDir: closeStoreDir,
        conversation,
        action: "close"
      });
      const currentTakeover = isRecord(conversation.native_session_takeover)
        ? conversation.native_session_takeover
        : undefined;
      const currentTerminalControl = terminalControlFromTakeover(
        currentTakeover
      );
      if (
        terminalControl &&
        !terminalControlsShareIncarnation(
          currentTerminalControl,
          terminalControl
        )
      ) {
        throw new Error(
          "terminal control changed after the close action was listed; refresh AKK list"
        );
      }
      if (conversation.status === "closed" && currentTerminalControl) {
        const recoveredAuthority =
          exactVerifiedDeadTerminalAgentProcessAuthority({
            conversation,
            storeDir: closeStoreDir,
            terminalControl: currentTerminalControl,
            logPath
          });
        const recoveredDecision = decideVerifiedDeadAgentProcess({
          persistedAuthority: recoveredAuthority
        });
        if (recoveredDecision.status === "invalid") {
          throw new Error(
            `cannot finish close recovery for ${conversation.conversation_id}; ` +
            recoveredDecision.reason
          );
        }
        if (recoveredDecision.status === "verified_dead") {
          const audit = ensureVerifiedDeadTerminalAgentProcessEvent({
            logPath,
            proof: recoveredDecision.proof,
            action: "managed_close"
          });
          const expectedMessageId = required(
            stringValue(currentTakeover?.terminal_bridge_message_id),
            "verified-dead close recovery has no terminal message id"
          );
          const dispatchLedgerResolved =
            resolveVerifiedDeadTerminalBridgeDispatchLedger({
              terminalControl: currentTerminalControl,
              conversation,
              storeDir: closeStoreDir,
              statePath,
              logPath,
              expectedMessageId,
              reason: "conversation explicitly closed by request"
            });
          ensureVerifiedDeadConversationClosedEvent({
            logPath,
            conversation,
            evidenceId: audit.evidenceId
          });
          printJson({
            conversation,
            closed: true,
            recovered: true,
            terminal_dispatch_resolved: dispatchLedgerResolved
          });
          return;
        }
      }
      if (terminalControl && currentTerminalControl) {
        verifiedDeadProcess =
          await assertGenericCloseDoesNotBypassObservedHandoff({
            options,
            storeDir: closeStoreDir,
            conversation,
            terminalControl: currentTerminalControl
          });
      }
      const now = cliNow().toISOString();
      const closeReason = options.reason ?? "closed by request";
      const verifiedDeadAudit = verifiedDeadProcess
        ? ensureVerifiedDeadTerminalAgentProcessEvent({
            logPath,
            proof: verifiedDeadProcess,
            action: "managed_close"
          })
        : undefined;
      const verifiedDeadMessageId = verifiedDeadAudit
        ? required(
            stringValue(currentTakeover?.terminal_bridge_message_id),
            "verified-dead close has no terminal message id"
          )
        : undefined;
      if (verifiedDeadAudit && currentTerminalControl) {
        assertVerifiedDeadTerminalBridgeDispatchAuthority({
          terminalControl: currentTerminalControl,
          conversation,
          storeDir: closeStoreDir,
          statePath,
          logPath,
          expectedMessageId: verifiedDeadMessageId as string
        });
      }
      const closed = {
        ...conversation,
        status: "closed" as const,
        closed_at: now,
        close_reason: closeReason,
        ...(verifiedDeadAudit
          ? {
              terminal_agent_process_disposition: {
                status: "verified_dead",
                proof: verifiedDeadAudit.proof,
                evidence_id: verifiedDeadAudit.evidenceId,
                recorded_at: verifiedDeadAudit.recordedAt
              }
            }
          : {}),
        updated_at: now
      };
      saveState(statePath, closed);
      if (
        verifiedDeadAudit &&
        cliEnv().AKK_TEST_EXIT_AFTER_VERIFIED_DEAD_CLOSE_STATE === "1"
      ) {
        cliExit(86);
      }
      let dispatchLedgerResolved = false;
      let dispatchLedgerWarning: string | undefined;
      if (currentTerminalControl) {
        try {
          dispatchLedgerResolved = verifiedDeadAudit
            ? resolveVerifiedDeadTerminalBridgeDispatchLedger({
                terminalControl: currentTerminalControl,
                conversation: closed,
                storeDir: closeStoreDir,
                statePath,
                logPath,
                expectedMessageId: verifiedDeadMessageId as string,
                reason: "conversation explicitly closed by request"
              })
            : resolveTerminalBridgeDispatchLedger(currentTerminalControl, {
                conversation: closed,
                expectedMessageId: stringValue(
                  currentTakeover?.terminal_bridge_message_id
                ),
                reason: "conversation explicitly closed by request"
              });
        } catch (error) {
          dispatchLedgerWarning =
            error instanceof Error ? error.message : String(error);
          runtimeLog("error", "terminal_dispatch_ledger_resolve_failed", {
            conversation_id: closed.conversation_id,
            terminal_target: currentTerminalControl.target,
            error: dispatchLedgerWarning
          });
        }
      }
      if (verifiedDeadAudit) {
        ensureVerifiedDeadConversationClosedEvent({
          logPath,
          conversation: closed,
          evidenceId: verifiedDeadAudit.evidenceId
        });
      } else {
        appendEvent(logPath, {
          ts: now,
          conversation_id: conversation.conversation_id,
          event: "conversation_closed",
          status: "closed",
          reason: closed.close_reason
        });
      }
      runtimeLog("info", "conversation_closed", {
        conversation_id: conversation.conversation_id,
        status: "closed",
        reason: closed.close_reason,
        state_path: statePath,
        event_log_path: logPath
      });
      printJson({
        conversation: closed,
        closed: true,
        terminal_dispatch_resolved: dispatchLedgerResolved,
        ...(dispatchLedgerWarning
          ? {
              terminal_dispatch_warning:
                textSummary(dispatchLedgerWarning),
              do_not_retry: true
            }
          : {})
      });
    } finally {
      releaseStateLock();
    }
  };
  try {
    if (terminalControl) {
      await withStoreWriterLeaseAsync(
        closeStoreDir,
        closeWithFreshState
      );
    } else {
      await closeWithFreshState();
    }
  } finally {
    releaseTerminalLock();
  }
}

async function assertGenericCloseDoesNotBypassObservedHandoff({
  options,
  storeDir,
  conversation,
  terminalControl
}: {
  options: Record<string, any>;
  storeDir: string;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
}): Promise<
  | VerifiedDeadTerminalAgentProcessProof
  | undefined
> {
  if (!SESSION_SEND_BLOCKING_STATUSES.has(conversation.status)) {
    return;
  }
  const sourceSession = tryLoadManagedSession(
    storeDir,
    sessionIdForConversation(conversation)
  );
  if (
    sourceSession?.status !== "bound" ||
    !sourceSession.binding ||
    !terminalControlsShareIncarnation(
      sourceSession.binding.terminal_control,
      terminalControl
    )
  ) {
    return;
  }
  const storedProof = exactVerifiedDeadTerminalAgentProcessAuthority({
    conversation,
    storeDir,
    terminalControl,
    logPath: stringValue(conversation.event_log_path) ??
      logPathForStatePath(
        required(
          stringValue(conversation.state_path),
          "managed Turn state path is unavailable"
        )
      )
  });
  const persistedDecision = decideVerifiedDeadAgentProcess({
    persistedAuthority: storedProof
  });
  if (persistedDecision.status === "verified_dead") {
    return persistedDecision.proof;
  }
  if (persistedDecision.status === "invalid") {
    throw new Error(
      `cannot close ${conversation.conversation_id}; ${persistedDecision.reason}`
    );
  }
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const pid = Number(takeover?.terminal_agent_pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return;
  }
  const bridge = createTerminalAgentBridge(options);
  let terminal: ResolvedTerminalConversation;
  try {
    terminal = await bridge.resolveStoredTerminal(
      sourceSession.agent,
      pid,
      terminalControl,
      { pid }
    );
  } catch (error) {
    if (error instanceof TerminalControlUnavailableError) {
      // An unavailable terminal cannot prove a live A -> B handoff. Preserve the
      // explicit Store-only close path used to retire unavailable Turn history.
      return;
    }
    const processObservation = await observeBoundTerminalAgentProcess({
      options,
      conversation,
      terminalControl
    });
    const processDecision = decideVerifiedDeadAgentProcess({
      persistedAuthority: { status: "absent" },
      observation: processObservation
    });
    if (processDecision.status === "verified_dead") {
      return processDecision.proof;
    }
    if (processDecision.status === "unverifiable") {
      throw new Error(
        `cannot close ${conversation.conversation_id}; the bound agent process ` +
        `death is unverifiable: ${processDecision.reason}`
      );
    }
    throw error;
  }
  const companions = sourceSession.agent === "codex"
    ? codexAllowedCompanionSetForManagedSession({
        storeDir,
        session: sourceSession
      })
    : { additional: [] };
  const identityObservation = await observeCurrentNativeAgentSessionIdentity({
    options,
    agent: terminal.agent,
    pid: terminal.pid,
    cwd: terminal.terminalControl.currentPath,
    preferredSessionId: companions.primary
      ? sourceSession.binding.native_thread_id
      : undefined,
    allowedCompanionIdentity: companions.primary,
    allowedAdditionalIdentities: companions.additional
  });
  const resolvedIdentity = identityObservation.status === "resolved"
    ? identityObservation.identity
    : undefined;
  const observed = await observedExternalHandoffIdentity({
    options,
    terminal,
    sourceSession,
    resolvedIdentity,
    requireSafeTerminal: false
  });
  if (
    managedBindingConflictKindForResolvedTerminal({
      storeDir,
      session: sourceSession,
      terminal,
      identity: observed.identity
    }) === "live_external_thread_change"
  ) {
    throw new Error(
      `terminal ${terminalControl.target} changed native thread after the ` +
      "generic close action was listed; refresh AKK list and use only its " +
      "fresh snapshot-bound handoff_decision"
    );
  }
}

async function runTerminalDispatchClose({
  options,
  terminalConversation
}: {
  options: Record<string, any>;
  terminalConversation: ResolvedTerminalConversation;
}): Promise<void> {
  const terminalControl = terminalConversation.terminalControl;
  const storeDir = storeDirFromOptions(options);
  return withCanonicalMutationLocks(
    terminalWriterMutationLocks(storeDir, terminalControl),
    async (scopes, resources) => {
    let ledger = mutationDispatchLedger.reconcileIncarnation(
      scopes, resources
    );
    if (!ledger || ledger.status === "resolved") {
      throw new Error(
        `terminal ${terminalControl.target} has no unresolved AKK dispatch fence`
      );
    }
    const deferredTransferId = stringValue(
      ledger.deferred_foreground_transfer_id
    );
    if (deferredTransferId) {
      const ledgerStatePath = path.resolve(required(
        stringValue(ledger.state_path),
        "deferred terminal dispatch state path is unavailable"
      ));
      const ledgerStoreDir = path.resolve(required(
        stringValue(ledger.store_dir),
        "deferred terminal dispatch Store is unavailable"
      ));
      const canonicalLedgerStoreDir = path.resolve(
        pathsForConversationDir(path.dirname(ledgerStatePath)).storeDir
      );
      if (
        ledgerStoreDir !== path.resolve(storeDir) ||
        canonicalLedgerStoreDir !== ledgerStoreDir
      ) {
        throw new Error(
          `terminal ${terminalControl.target} deferred dispatch belongs to ` +
          "another or noncanonical Store; generic terminal close cannot resolve it"
        );
      }
      const transfer = loadDeferredForegroundTransfer(
        storeDir,
        deferredTransferId
      );
      if (
        transfer.state_path === undefined ||
        path.resolve(transfer.state_path) !== ledgerStatePath ||
        transfer.terminal_id !== terminalConversation.conversationId ||
        !terminalControlEvidenceMatches(
          transfer.terminal_endpoint,
          terminalControl
        )
      ) {
        throw new Error(
          `terminal ${terminalControl.target} deferred dispatch authority ` +
          "does not match its exact Store/terminal transfer"
        );
      }
      if (!FINAL_DEFERRED_TRANSFER_STATUSES.has(transfer.status)) {
        throw new Error(
          `terminal ${terminalControl.target} dispatch is fenced by deferred ` +
          `foreground transfer ${transfer.transfer_id} (${transfer.status}); ` +
          "generic terminal close cannot resolve it"
        );
      }
    }
    if (!RECOVERABLE_TERMINAL_DISPATCH_STATUSES.has(ledger.status)) {
      throw new Error(
        `terminal ${terminalControl.target} has an invalid dispatch status: ` +
        String(ledger.status)
      );
    }
    if (terminalDispatchLedgerLooksLifecycle(ledger)) {
      const expectedTransitionId = required(
        stringValue(options.expectedTransitionId),
        "--expected-transition-id is required to recover a lifecycle transition"
      );
      const currentTransitionId = stringValue(ledger.transition_id);
      if (
        !currentTransitionId ||
        stringValue(ledger.generation_id) !== currentTransitionId ||
        expectedTransitionId !== currentTransitionId
      ) {
        throw new Error(
          "lifecycle transition identity changed; run AKK list again and use " +
          "the current expected-transition-id"
        );
      }
      ledger = await mutationDispatchLedger.reconcile(
        scopes,
        resources,
        options,
        terminalConversation,
        ledger,
        {
          kind: "manual",
          expectedTransitionId
        }
      );
      if (ledger.status !== "resolved") {
        printJson({
          source: "terminal_control",
          conversation_id: terminalConversation.conversationId,
          terminal_control: terminalControl,
          closed: false,
          terminal_dispatch_resolved: false,
          transition_id: expectedTransitionId,
          previous_dispatch_status: ledger.status,
          blocked: true,
          do_not_retry: true,
          reason:
            stringValue(ledger.reason) ??
            "the live terminal cannot prove the recorded lifecycle outcome",
          recovery_required: {
            action:
              "inspect the pane and restore an exact recorded before/after native identity, then rerun the list-provided close action",
            expected_transition_id: expectedTransitionId
          },
          coding_agent_stopped: false,
          tmux_pane_closed: false
        });
        return;
      }
      printJson({
        source: "terminal_control",
        conversation_id: terminalConversation.conversationId,
        terminal_control: terminalControl,
        closed: false,
        terminal_dispatch_resolved: true,
        transition_id: expectedTransitionId,
        reason: stringValue(ledger.reason),
        coding_agent_stopped: false,
        tmux_pane_closed: false
      });
      return;
    }
    const owner = loadTerminalDispatchLedgerOwner(ledger);
    if (owner) {
      throw new Error(
        `terminal ${terminalControl.target} dispatch is owned by AKK ` +
        `conversation ${owner.conversation_id} (${owner.status}); close that ` +
        "managed conversation instead"
      );
    }
    const expectedMessageId = required(
      stringValue(options.expectedMessageId),
      "--expected-message-id is required to resolve an orphaned terminal dispatch"
    );
    const ownerMessageId = stringValue(ledger.message_id);
    if (!ownerMessageId || expectedMessageId !== ownerMessageId) {
      throw new Error(
        "terminal dispatch identity changed; run AKK list again and use the " +
        "current orphaned dispatch message id"
      );
    }
    const resolvedAt = cliNow().toISOString();
    const reason =
      stringValue(options.reason) ??
      "terminal dispatch explicitly resolved after operator inspection";
    mutationDispatchLedger.save(scopes, resources, {
      ...ledger,
      status: "resolved",
      resolved_at: resolvedAt,
      reason,
      resolved_by_terminal_conversation_id:
        terminalConversation.conversationId
    });
    runtimeLog("info", "terminal_dispatch_explicitly_resolved", {
      terminal_target: terminalControl.target,
      terminal_conversation_id: terminalConversation.conversationId,
      owner_conversation_id:
        stringValue(ledger.conversation_id),
      owner_message_id: stringValue(ledger.message_id),
      previous_status: ledger.status,
      reason
    });
    printJson({
      source: "terminal_control",
      conversation_id: terminalConversation.conversationId,
      terminal_control: terminalControl,
      closed: false,
      terminal_dispatch_resolved: true,
      previous_dispatch_status: ledger.status,
      owner_conversation_id:
        stringValue(ledger.conversation_id),
      owner_message_id: stringValue(ledger.message_id),
      reason,
      coding_agent_stopped: false,
      tmux_pane_closed: false
    });
  });
}

async function runMonitor(options) {
  if (options.callbackRetry) {
    return runCallbackRetryMonitor(options);
  }
  if (options.terminalBridgeHandoff) {
    return runTerminalBridgeMonitorHandoff(options);
  }
  if (options.terminalBridge) {
    return await runTerminalBridgeMonitor(options);
  }
  throw new Error(
    "monitor requires --terminal-bridge, --terminal-bridge-handoff, or --callback-retry"
  );
}

function startCallbackRetryMonitor({
  statePath,
  delayMs = CALLBACK_RETRY_DELAYS_MS[0]
}) {
  const normalizedDelayMs = Math.max(
    0,
    Number.isFinite(Number(delayMs)) ? Number(delayMs) : CALLBACK_RETRY_DELAYS_MS[0]
  );
  return spawnDetachedTerminalMonitor({
    args: [
      cliEntryPath(),
      "monitor",
      "--callback-retry",
      "--state",
      statePath,
      "--callback-retry-delay-ms",
      String(normalizedDelayMs)
    ],
    environment: monitorLaunch.withoutGatewayTokens(cliEnv())
  })!;
}

function runCallbackRetryMonitor(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  return callbackOutboxService().runRetryMonitor({
    statePath,
    initialDelayMs: options.callbackRetryDelayMs
  });
}

function runTerminalBridgeMonitorHandoff(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  const logPath = expandHome(options.log ?? logPathForStatePath(statePath));
  const expectedMessageId = required(
    options.expectedTerminalMessageId,
    "--expected-terminal-message-id is required"
  );
  const configuredPollIntervalMs = Number(
    options.monitorHandoffPollIntervalMs
  );
  const pollIntervalMs = Math.max(
    50,
    Number.isFinite(configuredPollIntervalMs)
      ? configuredPollIntervalMs
      : 100
  );
  const handoffLockPath = monitorOwner.handoffLockPath(
    statePath,
    expectedMessageId
  );
  let releaseHandoffLock: (() => void) | undefined;
  try {
    releaseHandoffLock = acquireFileLock(handoffLockPath, { timeoutMs: 0 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "LOCK_TIMEOUT") {
      throw error;
    }
    printJson({
      monitored: false,
      terminal_bridge: true,
      handoff_watchdog: false,
      already_running: true,
      reason: "terminal_bridge_monitor_handoff_watchdog_already_running"
    });
    return;
  }

  try {
    const startedConversation = loadState(statePath);
    appendEvent(logPath, {
      ts: cliNow().toISOString(),
      conversation_id: startedConversation.conversation_id,
      event: "terminal_bridge_monitor_handoff_watchdog_started",
      terminal_bridge_message_id: expectedMessageId
    });
    while (true) {
      const conversation = loadState(statePath);
      const nativeTakeover = isRecord(conversation.native_session_takeover)
        ? conversation.native_session_takeover
        : undefined;
      const currentMessageId = stringValue(
        nativeTakeover?.terminal_bridge_message_id
      );
      if (currentMessageId !== expectedMessageId) {
        appendEvent(logPath, {
          ts: cliNow().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          current_terminal_bridge_message_id: currentMessageId,
          reason: "terminal_bridge_task_replaced"
        });
        return;
      }
      if (conversation.status === "waiting_for_openclaw") {
        sleepSync(pollIntervalMs);
        continue;
      }
      if (conversation.status !== "waiting_for_agent") {
        appendEvent(logPath, {
          ts: cliNow().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          status: conversation.status,
          reason: "conversation_no_longer_waiting_for_agent"
        });
        return;
      }

      const eligibility = terminalBridgeReconciliationEligibility(conversation);
      if (!eligibility.eligible) {
        appendEvent(logPath, {
          ts: cliNow().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          reason: eligibility.reason
        });
        return;
      }
      const activeOwner = activeTerminalBridgeMonitorOwner(
        statePath,
        expectedMessageId
      );
      if (activeOwner) {
        sleepSync(pollIntervalMs);
        continue;
      }

      const prepared = prepareTerminalBridgeMonitorReconciliation({
        statePath,
        expectedMessageId,
        requireWaitingForAgentStatus: true
      });
      if (!prepared.prepared) {
        if (prepared.alreadyRunning) {
          sleepSync(pollIntervalMs);
          continue;
        }
        appendEvent(logPath, {
          ts: cliNow().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          reason: prepared.reason
        });
        return;
      }

      const monitor = startTerminalBridgeMonitorForConversation({
        conversation: prepared.conversation,
        statePath,
        logPath,
        options
      });
      if (!monitor) {
        appendEvent(logPath, {
          ts: cliNow().toISOString(),
          conversation_id: prepared.conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          reason: "terminal_bridge_monitor_launch_disabled"
        });
        return;
      }
      const launchedAt = cliNow().toISOString();
      appendEvent(logPath, {
        ts: launchedAt,
        conversation_id: prepared.conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: monitor.pid ?? null,
        terminal_control: prepared.terminalControl,
        terminal_bridge_message_id: expectedMessageId,
        reason: "approval_handoff_reconciliation",
        agent_timeout_minutes: prepared.inactivityTimeoutMinutes,
        agent_hard_timeout_minutes: prepared.hardTimeoutMinutes
      });
      runtimeLog("info", "terminal_bridge_monitor_handoff_reconciled", {
        conversation_id: prepared.conversation.conversation_id,
        monitor_pid: monitor.pid ?? null,
        terminal_target: prepared.terminalControl.target,
        terminal_bridge_message_id: expectedMessageId
      });
      printJson({
        conversation: prepared.conversation,
        monitored: true,
        terminal_bridge: true,
        handoff_watchdog: true,
        launched: true,
        monitor_pid: monitor.pid ?? null,
        reason: "approval_handoff_reconciliation"
      });
      return;
    }
  } finally {
    releaseHandoffLock();
  }
}

async function runTerminalBridgeMonitor(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  const logPath = expandHome(options.log ?? logPathForStatePath(statePath));
  const conversation = loadState(statePath);
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalMessageId = stringValue(nativeTakeover?.terminal_bridge_message_id) ?? "missing-message-id";
  const monitorLock = tryAcquireTerminalBridgeMonitorLock(statePath, terminalMessageId);
  if (!monitorLock.acquired) {
    runtimeLog("info", "terminal_bridge_monitor_already_running", {
      conversation_id: conversation.conversation_id,
      terminal_bridge_message_id: terminalMessageId,
      monitor_owner_pid: monitorLock.ownerPid
    });
    printJson({
      conversation,
      monitored: false,
      terminal_bridge: true,
      already_running: true,
      reason: "terminal_bridge_monitor_already_running",
      monitor_owner_pid: monitorLock.ownerPid ?? null
    });
    return;
  }

  const lifecycle = { startedRecorded: false };
  try {
    await runTerminalMonitorWithStoreDeferral({
      initialConversation: conversation,
      terminalMessageId,
      run: () => runTerminalBridgeMonitorWithLock(
        options,
        lifecycle,
        terminalMessageId
      ),
      ports: {
        state: {
          load: () => loadState(statePath),
          appendEvent: (event) => appendEvent(logPath, event)
        },
        authority: {
          terminalControl: (candidate) => terminalControlFromTakeover(
            isRecord(candidate.native_session_takeover)
              ? candidate.native_session_takeover
              : undefined
          ),
          bindingSuperseded: (error) => error instanceof TurnBindingSupersededError
            ? { code: error.code, message: error.message }
            : undefined,
          storeOperationTimeout: terminalMonitorStoreOperationTimeout
        },
        runtime: monitorRuntimePort(),
        presentation: {
          emit: (result) => presentTerminalMonitor(result, printJson)
        }
      }
    });
  } finally {
    monitorLock.release();
  }
}

async function runTerminalBridgeMonitorWithLock(
  options,
  lifecycle: { startedRecorded: boolean },
  expectedTerminalMessageId: string
) {
  const statePath = expandHome(required(options.state, "--state is required"));
  const logPath = expandHome(options.log ?? logPathForStatePath(statePath));
  const pollIntervalMs = Math.max(
    50,
    Number(options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS)
  );
  const initialConversation = await migrateLegacyTerminalAgentIdentity({
    conversation: loadState(statePath),
    statePath,
    logPath,
    options
  });
  const initialTakeover = isRecord(initialConversation.native_session_takeover)
    ? initialConversation.native_session_takeover
    : undefined;
  let terminalBridge: TerminalAgentBridge | undefined;
  const bridge = () => terminalBridge ??= createTerminalAgentBridge(options);
  await runTerminalMonitorService({
    initialConversation,
    expectedTerminalMessageId,
    lifecycle,
    configuration: () => {
      const timeoutMinutes = Number(
        options.agentTimeoutMinutes ??
          initialTakeover?.terminal_bridge_inactivity_timeout_minutes ??
          DEFAULT_AGENT_TIMEOUT_MINUTES
      );
      const hardTimeoutMinutes = positiveMinutes(
        options.agentHardTimeoutMinutes ??
          initialTakeover?.terminal_bridge_hard_timeout_minutes ??
          DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
        "--agent-hard-timeout-minutes"
      );
      return {
        pollIntervalMs,
        timeoutMinutes,
        hardTimeoutMinutes,
        activityPersistIntervalMs:
          terminalBridgeActivityPersistIntervalMs(timeoutMinutes, pollIntervalMs)
      };
    },
    ports: terminalMonitorServicePorts({
      options,
      statePath,
      logPath,
      terminalBridge: bridge
    })
  });
}

function monitorRuntimePort(): TerminalMonitorServicePorts["runtime"] {
  return {
    now: cliNow,
    nowMs: cliNowMs,
    pid: cliPid,
    sleep: sleepSync,
    log: runtimeLog,
    exitAfterApprovalCallback: () =>
      cliEnv().AKK_TEST_EXIT_AFTER_APPROVAL_CALLBACK_DELIVERED === "1",
    exit: (code) => cliExit(code)
  };
}

function terminalMonitorServicePorts({
  options,
  statePath,
  logPath,
  terminalBridge
}: {
  options: CliCommandOptions;
  statePath: string;
  logPath: string;
  terminalBridge(): TerminalAgentBridge;
}): TerminalMonitorServicePorts {
  let resolvedStoreDir: string | undefined;
  const storeDir = () => resolvedStoreDir ??=
    pathsForConversationDir(path.dirname(statePath)).storeDir;
  return {
    state: {
      load: () => loadState(statePath),
      appendEvent: (event) => appendEvent(logPath, event),
      markStalled: (reason, detail) => {
        const conversation = markConversationStalled({
          statePath,
          logPath,
          reason,
          detail
        });
        if (!conversation) {
          throw new Error("terminal monitor stall transaction returned no conversation");
        }
        return conversation;
      },
      persistActivity: (input) => persistTerminalBridgeActivity({
        ...input,
        statePath,
        logPath
      }),
      persistDetectorDiagnostic: (input) =>
        persistTerminalBridgeDetectorDiagnostic({
          ...input,
          statePath,
          logPath
        }),
      markApprovalPromptCleared: (input) =>
        markTerminalBridgeApprovalPromptCleared({
          expectedConversationId: input.expectedConversationId,
          expectedMessageId: input.expectedMessageId,
          statePath,
          logPath
        }),
      recordApprovalNotification: (input) =>
        recordMonitorApprovalNotification({
          ...input,
          ports: {
            record: (request) => {
              const result = recordTerminalBridgeApprovalNotification({
                terminalControl: request.terminalControl,
                terminalStatus: request.terminalStatus,
                fingerprint: request.fingerprint,
                expectedConversation: request.expectedConversation,
                onRecorded: request.onRecorded,
                statePath,
                logPath
              });
              return { ...result, conversation: result.conversation as Conversation };
            },
            prepare: (request) =>
              callbackOutboxService().prepareApprovalNotification({
                options: { ...options, statePath },
                statePath,
                logPath,
                ...request
              }),
            approvalInstructions: terminalBridgeApprovalInstructions,
            approvalCandidate: terminalBridgeApprovalCandidate
          }
        })
    },
    authority: {
      initialize: () => { terminalBridge(); },
      terminalControl: (conversation) => {
        const takeover = isRecord(conversation.native_session_takeover)
          ? conversation.native_session_takeover
          : undefined;
        return terminalControlFromTakeover(takeover);
      },
      submission: terminalBridgeSubmission,
      isWaitingForAgent,
      isProcessAlive,
      markAcceptanceUncertain: (input) =>
        markTerminalAcceptanceUncertain({
          ...input,
          statePath,
          logPath
        }),
      reconcileAcceptance: (input) => reconcileMonitorAcceptance({
        terminalControl: input.terminalControl,
        acquireTerminal: (control) => acquireTerminalBridgeSendLock(
          storeDirFromOptions(options), control, { timeoutMs: 30000 }
        ),
        reconcile: () => reconcileTerminalAcceptanceInMonitor({
          ...input,
          options,
          statePath,
          logPath,
          terminalBridge: terminalBridge()
        }),
        apply: input.apply,
        recover: input.recover
      }),
      recoverPreparedSubmission: (input) =>
        recoverPreparedMonitorSubmission({
          ...input,
          statePath,
          logPath,
          ports: {
            acquireTerminal: (control) => acquireTerminalBridgeSendLock(
              storeDirFromOptions(options), control, { timeoutMs: 30000 }
            ),
            withWriter: (use) => withStoreWriterLeaseAsync(storeDir(), use),
            acquireState: () => acquireFileLock(`${statePath}.lock`),
            loadConversation: () => loadState(statePath),
            loadLedger: loadTerminalBridgeDispatchLedger,
            saveLedger: saveTerminalBridgeDispatchLedger,
            saveConversation: (conversation) => saveState(statePath, conversation),
            submission: terminalBridgeSubmission,
            applySubmission: withTerminalBridgeSubmission,
            requestFingerprint: terminalBridgeRequestFingerprint,
            now: cliNow,
            appendEvent: (event) => appendEvent(logPath, event),
            stallCollateral: (request) => {
              stallOtherTerminalBridgeConversationsForUncertainDispatch({
                storeDir: storeDir(),
                ...request
              });
            }
          }
        }),
      assertBindingCurrent: (conversation) =>
        assertTurnBindingCurrent(conversation, "monitor"),
      bindingSuperseded: (error) => error instanceof TurnBindingSupersededError
        ? { code: error.code, message: error.message }
        : undefined,
      storeOperationTimeout: terminalMonitorStoreOperationTimeout,
      storeLeaseTimeout: terminalMonitorStoreLeaseTimeout,
      poll: (input) => pollTerminalMonitor({
        ...input,
        terminalBridge: terminalBridge(),
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        ports: {
          acquireTerminal: (control) => acquireTerminalBridgeSendLock(
            storeDirFromOptions(options), control, { timeoutMs: 30000 }
          ),
          reconcileLedger: reconcilePreparedTerminalDispatchLedger,
          loadLedger: loadTerminalBridgeDispatchLedger,
          saveLedger: saveTerminalBridgeDispatchLedger,
          submission: terminalBridgeSubmission,
          loadConversation: () => loadState(statePath),
          terminalControl: (conversation) => terminalControlFromTakeover(
            isRecord(conversation.native_session_takeover)
              ? conversation.native_session_takeover
              : undefined
          ),
          sameIncarnation: terminalControlsShareIncarnation,
          runtime: terminalRuntimeIdentityForConversation,
          durableRequest: terminalDurableRequestForConversation,
          appendEvent: (event) => appendEvent(logPath, event),
          now: cliNow
        }
      })
    },
    callbacks: {
      prepareCompletion: (input) =>
        prepareTerminalBridgeCompletionCallback({
          options,
          statePath,
          logPath,
          ...input
        }),
      verifiedDead: (input) =>
        stallAcceptedTurnForVerifiedDeadAgent({
          options,
          storeDir: storeDir(),
          statePath,
          logPath,
          expectedConversationId: input.conversationId,
          expectedMessageId: input.messageId
        }),
      run: (prepared, callbackOptions) =>
        runPreparedCallback(prepared, callbackOptions),
      emit: emitPreparedCallbackResult
    },
    runtime: monitorRuntimePort(),
    presentation: {
      emit: (result) => presentTerminalMonitor(result, printJson)
    }
  };
}

function activeTerminalBridgeMonitorOwner(
  statePath: string,
  terminalMessageId: string
): { lockPath: string; ownerPid?: number } | undefined {
  const lockPath = monitorOwner.lockPath(statePath, terminalMessageId);
  if (!fs.existsSync(lockPath) || staleFileLock(lockPath)) {
    return undefined;
  }
  return terminalBridgeMonitorLockOwner(lockPath);
}

function terminalBridgeMonitorLockOwner(lockPath: string) {
  return { lockPath, ownerPid: readFileLockOwner(lockPath).pid };
}

function tryAcquireTerminalBridgeMonitorLock(statePath: string, terminalMessageId: string) {
  const lockPath = monitorOwner.lockPath(statePath, terminalMessageId);
  try {
    return {
      acquired: true as const,
      lockPath,
      release: acquireFileLock(lockPath, { timeoutMs: 0 })
    };
  } catch (error) {
    if (isRecord(error) && error.code === "LOCK_TIMEOUT") {
      return {
        acquired: false as const,
        ...terminalBridgeMonitorLockOwner(lockPath)
      };
    }
    throw error;
  }
}

function terminalBridgeSendLockPath(_storeDir: string, terminalControl): string {
  const lockDir = terminalBridgeRuntimeLockDir();
  ensureDir(lockDir);
  const terminalKey = terminalBridgeRuntimeKey(terminalControl);
  return path.join(lockDir, `terminal-bridge-send-${terminalKey}.lock`);
}

function legacyTerminalBridgeSendLockPath(
  _storeDir: string,
  terminalControl: TerminalControlRef
): string {
  const lockDir = terminalBridgeRuntimeLockDir();
  ensureDir(lockDir);
  return path.join(
    lockDir,
    `terminal-bridge-send-${legacyTerminalBridgeRuntimeKey(terminalControl)}.lock`
  );
}

function acquireTerminalBridgeSendLock(
  storeDir: string,
  terminalControl: TerminalControlRef,
  options: { timeoutMs?: number; retryMs?: number } = {}
): () => void {
  const lockPaths = [...new Set([
    terminalBridgeSendLockPath(storeDir, terminalControl),
    legacyTerminalBridgeSendLockPath(storeDir, terminalControl)
  ])].sort();
  const releases: Array<() => void> = [];
  try {
    for (const lockPath of lockPaths) {
      releases.push(acquireFileLock(lockPath, options));
    }
  } catch (error) {
    for (const release of releases.reverse()) {
      release();
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    for (const release of [...releases].reverse()) {
      release();
    }
  };
}

function terminalBridgeRuntimeLockDir(): string {
  return path.join(
    terminalBridgeRuntimeDir(),
    "terminal-locks"
  );
}

function terminalBridgeRuntimeDir(): string {
  const configured = stringValue(cliEnv().AKK_RUNTIME_DIR);
  return configured
    ? path.resolve(expandHome(configured))
    : path.join(path.dirname(defaultStoreDir()), "runtime-v2");
}

function terminalBridgeRuntimeKey(terminalControl): string {
  return terminalRuntimeResourceKey(terminalControl as TerminalControlRef);
}

function legacyTerminalBridgeRuntimeKey(
  terminalControl: TerminalControlRef
): string {
  return terminalRuntimeResourceKey(terminalControl, { legacy: true });
}

function terminalBridgeDispatchLedgerPath(
  terminalControl: TerminalControlRef,
  options: { legacy?: boolean } = {}
): string {
  const ledgerDir = path.join(
    terminalBridgeRuntimeDir(),
    "terminal-dispatch"
  );
  return path.join(
    ledgerDir,
    `terminal-dispatch-${options.legacy
      ? legacyTerminalBridgeRuntimeKey(terminalControl)
      : terminalBridgeRuntimeKey(terminalControl)}.json`
  );
}

function terminalBridgeDispatchLedgerPaths(
  terminalControl: TerminalControlRef
): string[] {
  return [...new Set([
    terminalBridgeDispatchLedgerPath(terminalControl),
    terminalBridgeDispatchLedgerPath(terminalControl, { legacy: true })
  ])];
}

function loadTerminalBridgeDispatchLedger(
  terminalControl: TerminalControlRef
): Record<string, any> | undefined {
  const ledgerPaths = terminalBridgeDispatchLedgerPaths(terminalControl)
    .filter((candidate) => fs.existsSync(candidate));
  if (ledgerPaths.length === 0) {
    return undefined;
  }
  if (ledgerPaths.length > 1) {
    throw new Error(
      `terminal dispatch ledger has conflicting canonical and legacy owners: ` +
      ledgerPaths.join(", ")
    );
  }
  const ledgerPath = ledgerPaths[0];
  const stat = fs.lstatSync(ledgerPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`terminal dispatch ledger is not a regular file: ${ledgerPath}`);
  }
  return decodeTerminalDispatchLedgerDocument(
    fs.readFileSync(ledgerPath, "utf8"),
    {
      ledgerPath,
      terminalControl,
      legacyTerminalKey: legacyTerminalBridgeRuntimeKey(terminalControl),
      canonicalTerminalKey: terminalBridgeRuntimeKey(terminalControl)
    }
  );
}

function terminalDispatchRecordMatchesControl(
  record: Record<string, any> | undefined,
  terminalControl: TerminalControlRef,
  options: {
    requireCurrentRoute?: boolean;
    requireProcessAnchor?: boolean;
  } = {}
): boolean {
  if (!record) {
    return false;
  }
  const evidence = record.terminal_endpoint !== undefined
    ? record.terminal_endpoint
    : record.terminal_control;
  return terminalControlEvidenceMatches(evidence, terminalControl, options);
}

function terminalDispatchRecordProcessAnchor(
  record: Record<string, any>
): number | undefined {
  const evidence = isRecord(record.terminal_endpoint)
    ? record.terminal_endpoint
    : isRecord(record.terminal_control)
      ? record.terminal_control
      : undefined;
  const panePid = Number(
    evidence?.process_anchor_pid ?? evidence?.pane_pid ?? evidence?.panePid
  );
  return Number.isSafeInteger(panePid) && panePid > 0 ? panePid : undefined;
}

function assertTerminalNativeThreadStoreAuthority({
  terminalControl,
  nativeThreadId,
  storeDir
}: {
  terminalControl: TerminalControlRef;
  nativeThreadId: string;
  storeDir: string;
}): void {
  const ledger = resolveTerminalDispatchLedgerPaneIncarnation(
    terminalControl,
    loadTerminalBridgeDispatchLedger(terminalControl)
  );
  if (!ledger) {
    return;
  }
  if (
    !terminalDispatchRecordMatchesControl(ledger, terminalControl, {
      requireProcessAnchor: false
    })
  ) {
    throw new Error(
      `terminal ${terminalControl.target} dispatch ledger selector is invalid`
    );
  }
  const binding = isRecord(ledger.binding) ? ledger.binding : undefined;
  const authorityNativeThreadIds = new Set([
    stringValue(ledger.native_thread_id),
    stringValue(binding?.native_thread_id),
    stringValue(ledger.before_native_thread_id),
    stringValue(ledger.target_native_thread_id)
  ].filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase()));
  const normalizedNativeThreadId = nativeThreadId.toLowerCase();
  if (!authorityNativeThreadIds.has(normalizedNativeThreadId)) {
    return;
  }
  let authorityStoreDir = stringValue(ledger.store_dir);
  if (!authorityStoreDir) {
    const statePath = stringValue(ledger.state_path);
    if (statePath) {
      try {
        authorityStoreDir = pathsForConversationDir(
          path.dirname(path.resolve(statePath))
        ).storeDir;
      } catch {
        authorityStoreDir = undefined;
      }
    }
  }
  if (!authorityStoreDir) {
    throw new Error(
      `terminal ${terminalControl.target} has native-thread authority ` +
      `${normalizedNativeThreadId} whose Store cannot be verified`
    );
  }
  if (path.resolve(authorityStoreDir) !== path.resolve(storeDir)) {
    throw new Error(
      `terminal ${terminalControl.target} native thread ` +
      `${normalizedNativeThreadId} is authoritative in another Store ` +
      `${path.resolve(authorityStoreDir)}`
    );
  }
}

function orphanedTerminalDispatchForRecovery(
  terminalControl: TerminalControlRef
): Record<string, any> | undefined {
  try {
    const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
    const lifecycle = terminalDispatchLedgerLooksLifecycle(ledger);
    const recoveryIdentity = lifecycle
      ? stringValue(ledger?.transition_id)
      : stringValue(ledger?.message_id);
    if (
      !ledger ||
      !RECOVERABLE_TERMINAL_DISPATCH_STATUSES.has(String(ledger.status)) ||
      !recoveryIdentity ||
      (
        !lifecycle &&
        terminalDispatchRecordMatchesControl(ledger, terminalControl, {
          requireProcessAnchor: false
        }) &&
        !terminalDispatchRecordMatchesControl(ledger, terminalControl)
      ) ||
      (!lifecycle && loadTerminalDispatchLedgerOwner(ledger))
    ) {
      return undefined;
    }
    return lifecycle ? { ...ledger, kind: "lifecycle" } : ledger;
  } catch {
    return undefined;
  }
}

function saveLifecycleTerminalDispatchLedger(
  terminalControl: TerminalControlRef,
  ledger: Record<string, unknown>,
  options: {
    expectedTransitionId: string | null;
    expectedStatus?: string;
  }
): void {
  if (
    ledger.kind !== "lifecycle" ||
    !stringValue(ledger.transition_id) ||
    stringValue(ledger.generation_id) !== stringValue(ledger.transition_id)
  ) {
    throw new Error("lifecycle dispatch ledger requires one transition identity");
  }
  const current = loadTerminalBridgeDispatchLedger(terminalControl);
  if (options.expectedTransitionId === null) {
    if (current && current.status !== "resolved") {
      const releasedOrdinaryOwner = current.kind !== "lifecycle"
        ? loadTerminalDispatchLedgerOwner(current)
        : undefined;
      if (
        !releasedOrdinaryOwner ||
        !TERMINAL_DISPATCH_RELEASE_STATUSES.has(releasedOrdinaryOwner.status)
      ) {
        throw new Error(
          `terminal ${terminalControl.target} dispatch generation changed before lifecycle prepare`
        );
      }
    }
  } else if (
    current?.kind !== "lifecycle" ||
    stringValue(current.transition_id) !== options.expectedTransitionId ||
    stringValue(current.generation_id) !== options.expectedTransitionId
  ) {
    throw new Error(
      `terminal ${terminalControl.target} lifecycle transition identity changed; ` +
      "refresh list before recovery"
    );
  }
  if (
    options.expectedStatus !== undefined &&
    String(current?.status) !== options.expectedStatus
  ) {
    throw new Error(
      `terminal ${terminalControl.target} lifecycle status changed from ` +
      `${options.expectedStatus} to ${String(current?.status)}`
    );
  }
  saveTerminalBridgeDispatchLedger(terminalControl, ledger);
}

function saveTerminalBridgeDispatchLedger(
  terminalControl: TerminalControlRef,
  ledger: Record<string, unknown>
): void {
  const previousLedger = loadTerminalBridgeDispatchLedger(terminalControl);
  const existingPaths = terminalBridgeDispatchLedgerPaths(terminalControl)
    .filter((candidate) => fs.existsSync(candidate));
  let ledgerPath = existingPaths[0] ??
    terminalBridgeDispatchLedgerPath(terminalControl);
  const canonicalLedgerPath = terminalBridgeDispatchLedgerPath(terminalControl);
  const legacyLedgerPath = terminalBridgeDispatchLedgerPath(
    terminalControl,
    { legacy: true }
  );
  ensureDir(path.dirname(canonicalLedgerPath));
  if (
    hasCanonicalTerminalEndpoint(terminalControl) &&
    ledgerPath === legacyLedgerPath &&
    legacyLedgerPath !== canonicalLedgerPath
  ) {
    // Promote a validated v0.11.x route-keyed ledger before writing the next
    // generation. rename() removes the duplicate-owner window: after a crash,
    // the canonical path may still contain v1 JSON, which the compatibility
    // reader accepts and a later writer can finish upgrading to v2.
    if (fs.existsSync(canonicalLedgerPath)) {
      throw new Error(
        `terminal dispatch ledger has conflicting canonical and legacy owners: ` +
        `${canonicalLedgerPath}, ${legacyLedgerPath}`
      );
    }
    fs.renameSync(legacyLedgerPath, canonicalLedgerPath);
    fsyncDirectory(path.dirname(canonicalLedgerPath));
    ledgerPath = canonicalLedgerPath;
  }
  const preserveLegacyFormat = !hasCanonicalTerminalEndpoint(terminalControl);
  ensureDir(path.dirname(ledgerPath));
  if (fs.existsSync(ledgerPath) && fs.lstatSync(ledgerPath).isSymbolicLink()) {
    throw new Error(`terminal dispatch ledger is a symlink: ${ledgerPath}`);
  }
  const useCanonicalFormat =
    hasCanonicalTerminalEndpoint(terminalControl) && !preserveLegacyFormat;
  const nextLedger = constructTerminalDispatchLedgerDocument({
    previousLedger,
    incomingLedger: ledger,
    version: useCanonicalFormat ? 2 : 1,
    terminalKey: preserveLegacyFormat
      ? legacyTerminalBridgeRuntimeKey(terminalControl)
      : terminalBridgeRuntimeKey(terminalControl),
    terminalControl: {
      kind: terminalControl.kind,
      target: terminalControl.target,
      socket_path: terminalControl.socketPath ?? null,
      pane_pid: terminalControl.panePid ?? null,
      current_path: terminalControl.currentPath ?? null,
      ...(terminalControl.kind === "herdr"
        ? {
            session: terminalControl.session,
            session_dir: terminalControl.sessionDir ?? null,
            workspace_id: terminalControl.workspaceId,
            tab_id: terminalControl.tabId,
            pane_id: terminalControl.paneId,
            terminal_id: terminalControl.terminalId
          }
        : {})
    },
    ...(useCanonicalFormat
      ? { terminalEndpoint: terminalControlEvidence(terminalControl) }
      : {})
  });
  const temporaryPath = `${ledgerPath}.${cliPid()}.${randomUUID()}.tmp`;
  atomicReplacePrivateJsonFile(ledgerPath, nextLedger, {
    temporaryPath,
    cleanupTemporary: () => fs.rmSync(temporaryPath, { force: true })
  });
}

function resolveTerminalDispatchLedgerPaneIncarnation(
  terminalControl: TerminalControlRef,
  ledger?: Record<string, any>
): Record<string, any> | undefined {
  if (!ledger || ledger.status === "resolved") {
    return ledger;
  }
  if (terminalDispatchLedgerLooksLifecycle(ledger)) {
    // A changed pane incarnation invalidates lifecycle recovery evidence. It
    // must remain fenced and be handled by lifecycle recovery, never silently
    // released by the generic Turn-ledger cleanup path.
    return ledger;
  }
  if (
    !terminalDispatchRecordMatchesControl(ledger, terminalControl, {
      requireProcessAnchor: false
    }) ||
    terminalDispatchRecordMatchesControl(ledger, terminalControl)
  ) {
    return ledger;
  }
  const ledgerProcessAnchor = terminalDispatchRecordProcessAnchor(ledger);
  const currentProcessAnchor = terminalEndpointFromControlRef(
    terminalControl
  ).processAnchorPid;
  saveTerminalBridgeDispatchLedger(terminalControl, {
    ...ledger,
    status: "resolved",
    resolved_at: cliNow().toISOString(),
    reason:
      "terminal process incarnation changed from anchor " +
      `${ledgerProcessAnchor} to ${currentProcessAnchor ?? "unknown"}`
  });
  return loadTerminalBridgeDispatchLedger(terminalControl);
}

function loadTerminalDispatchLedgerOwner(
  ledger: Record<string, any>
): Conversation | undefined {
  const statePath = stringValue(ledger.state_path);
  if (!statePath) {
    return undefined;
  }
  try {
    const conversation = loadState(statePath);
    if (
      conversation.conversation_id !==
        stringValue(ledger.conversation_id)
    ) {
      return undefined;
    }
    return conversation;
  } catch {
    return undefined;
  }
}

function assertManagedTerminalDispatchOwner({
  storeDir,
  conversation,
  terminalControl,
  action
}: {
  storeDir: string;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  action: "approve" | "cancel";
}): void {
  assertConversationHasNoNonterminalDeferredForegroundTransfer({
    storeDir,
    conversation,
    action
  });
  assertTurnBindingCurrent(conversation, action);
  const nativeTakeover = isRecord(
    conversation.native_session_takeover
  )
    ? conversation.native_session_takeover
    : undefined;
  const messageId = stringValue(
    nativeTakeover?.terminal_bridge_message_id
  );
  const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
  if (
    !messageId ||
    !ledger ||
    !["submitted", "agent_accepted"].includes(String(ledger.status)) ||
    stringValue(ledger.conversation_id) !==
      conversation.conversation_id ||
    stringValue(ledger.message_id) !== messageId ||
    (
      stringValue(conversation.terminal_binding_id) &&
      (
        stringValue(ledger.binding_id) !==
          stringValue(conversation.terminal_binding_id) ||
        Number(ledger.binding_generation) !==
          Number(conversation.terminal_binding_generation) ||
        stringValue(ledger.native_thread_id) !==
          (
            stringValue(conversation.native_thread_id) ??
            stringValue(nativeTakeover?.terminal_agent_session_id)
          )
      )
    )
  ) {
    throw new Error(
      `refusing to ${action}: this AKK conversation does not own the ` +
      "current terminal dispatch generation; refresh status and operate on " +
      "the current task"
    );
  }
}

function terminalBindingLedgerFields(
  conversation: Conversation
): Record<string, unknown> {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const bindingId = stringValue(conversation.terminal_binding_id);
  const generation = Number(conversation.terminal_binding_generation);
  const nativeThreadId = stringValue(conversation.native_thread_id) ??
    stringValue(takeover?.terminal_agent_session_id);
  const storeDir = managedSessionStoreDirForConversation(conversation);
  const submission = terminalBridgeSubmission(conversation);
  const messageType = stringValue(submission?.message_type);
  const messageBodyHash = stringValue(submission?.message_body_hash);
  const deferredForegroundTransferId = stringValue(
    takeover?.deferred_foreground_transfer_id
  );
  return {
    ...(bindingId ? { binding_id: bindingId } : {}),
    ...(Number.isSafeInteger(generation)
      ? { binding_generation: generation }
      : {}),
    ...(nativeThreadId ? { native_thread_id: nativeThreadId } : {}),
    ...(storeDir ? { store_dir: path.resolve(storeDir) } : {}),
    ...(messageType ? { message_type: messageType } : {}),
    ...(messageBodyHash ? { message_body_hash: messageBodyHash } : {}),
    ...(deferredForegroundTransferId
      ? { deferred_foreground_transfer_id: deferredForegroundTransferId }
      : {}),
    executor_kind: executorForConversation(conversation).kind,
    ...(conversation.openclaw_session
      ? { openclaw_session: conversation.openclaw_session }
      : {})
  };
}

function assertConversationHasNoNonterminalDeferredForegroundTransfer({
  storeDir,
  conversation,
  action
}: {
  storeDir: string;
  conversation: Conversation;
  action: string;
}): void {
  const turnId = turnIdForConversation(conversation);
  const sourceTransfer = listDeferredForegroundTransfers(storeDir).find(
    (candidate) =>
      candidate.version === 2 &&
      candidate.source_kind === "candidate_rollout_quiescent" &&
      !FINAL_DEFERRED_TRANSFER_STATUSES.has(candidate.status) &&
      (candidate.source_turn_history ?? []).some(
        (sourceTurn) => sourceTurn.turn_id === turnId
      )
  );
  if (sourceTransfer) {
    throw new Error(
      `cannot ${action} Turn ${turnId} while deferred foreground transfer ` +
      `${sourceTransfer.transfer_id} reserves it as immutable source ` +
      `history in ${sourceTransfer.status}; dedicated transfer recovery ` +
      "must finish first"
    );
  }
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const transferId = stringValue(takeover?.deferred_foreground_transfer_id);
  if (!transferId) {
    return;
  }
  const transfer = loadDeferredForegroundTransfer(storeDir, transferId);
  if (!FINAL_DEFERRED_TRANSFER_STATUSES.has(transfer.status)) {
    throw new Error(
      `cannot ${action} Turn ${turnIdForConversation(conversation)} while ` +
      `deferred foreground transfer ${transfer.transfer_id} is ` +
      `${transfer.status}; dedicated transfer recovery must finish first`
    );
  }
}

function assertTerminalHasNoNonterminalDeferredForegroundTransfer({
  storeDir,
  pid,
  terminalControl,
  action
}: {
  storeDir: string;
  pid: number;
  terminalControl: TerminalControlRef;
  action: string;
}): void {
  const transfer = listDeferredForegroundTransfers(storeDir).find(
    (candidate) =>
      !FINAL_DEFERRED_TRANSFER_STATUSES.has(candidate.status) &&
      candidate.process_pid === pid &&
      terminalControlEvidenceMatches(
        candidate.terminal_endpoint,
        terminalControl
      )
  );
  if (!transfer) {
    return;
  }
  throw new Error(
    `cannot ${action} terminal ${terminalControl.target} while deferred ` +
    `foreground transfer ${transfer.transfer_id} is ${transfer.status}; ` +
    "dedicated transfer recovery must finish first"
  );
}

function reconcilePreparedTerminalDispatchLedger(
  terminalControl: TerminalControlRef,
  ledger?: Record<string, any>
): Record<string, any> | undefined {
  if (terminalDispatchLedgerLooksLifecycle(ledger)) {
    return ledger;
  }
  if (ledger?.status !== "prepared") {
    return reconcileLaggingTerminalDispatchLedger(
      terminalControl,
      ledger
    );
  }
  const dispatcherPid = Number(ledger.dispatcher_pid);
  if (
    Number.isSafeInteger(dispatcherPid) &&
    dispatcherPid > 1 &&
    dispatcherPid !== cliPid() &&
    isProcessAlive(dispatcherPid)
  ) {
    return ledger;
  }
  const statePath = stringValue(ledger.state_path);
  const messageId = stringValue(ledger.message_id);
  if (!statePath || !messageId) {
    return ledger;
  }
  let conversation: Conversation | undefined;
  try {
    conversation = loadState(statePath);
  } catch (error) {
    const code = error instanceof Error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code !== "ENOENT") {
      return ledger;
    }
    saveTerminalBridgeDispatchLedger(terminalControl, {
      ...ledger,
      status: "resolved",
      resolved_at: cliNow().toISOString(),
      reason:
        "dispatcher exited before the prepared owner state existed; no terminal input was possible"
    });
    return loadTerminalBridgeDispatchLedger(terminalControl);
  }
  const nativeTakeover = isRecord(
    conversation.native_session_takeover
  )
    ? conversation.native_session_takeover
    : undefined;
  const storedControl = terminalControlFromTakeover(nativeTakeover);
  const submission = terminalBridgeSubmission(conversation);
  const storedMessageId = stringValue(
    nativeTakeover?.terminal_bridge_message_id
  );
  if (
    conversation.conversation_id !==
      stringValue(ledger.conversation_id) ||
    !storedControl ||
    !sameTerminalControlIncarnation(storedControl, terminalControl)
  ) {
    return ledger;
  }
  if (
    storedMessageId === messageId &&
    stringValue(submission?.message_id) === messageId
  ) {
    if (
      submission &&
      ["submitted", "text_injected", "enter_dispatched", "agent_accepted"]
        .includes(String(submission.status))
    ) {
      const submittedAt =
        stringValue(submission.agent_accepted_at) ??
        stringValue(submission.enter_dispatched_at) ??
        stringValue(submission.text_injected_at) ??
        stringValue(submission.submitted_at) ??
        stringValue(conversation.updated_at) ??
        cliNow().toISOString();
      saveTerminalBridgeDispatchLedger(terminalControl, {
        ...ledger,
        status: submission.status,
        ...(submission.text_injected_at
          ? { text_injected_at: submission.text_injected_at }
          : {}),
        ...(submission.enter_dispatched_at
          ? { enter_dispatched_at: submission.enter_dispatched_at }
          : {}),
        ...(submission.status === "agent_accepted"
          ? {
              agent_accepted_at: submittedAt,
              acceptance_evidence: submission.acceptance_evidence
            }
          : submission.status === "submitted"
            ? { submitted_at: submittedAt }
            : {}),
        reason:
          "recovered from the durable conversation submission receipt"
      });
    } else {
      saveTerminalBridgeDispatchLedger(terminalControl, {
        ...ledger,
        status: "uncertain",
        uncertain_at: cliNow().toISOString(),
        reason:
          "dispatcher exited after the prepared state became durable; terminal submission cannot be proven"
      });
    }
    return loadTerminalBridgeDispatchLedger(terminalControl);
  }

  if (
    storedMessageId &&
    submission &&
    ["submitted", "agent_accepted"].includes(String(submission.status)) &&
    stringValue(submission.message_id) === storedMessageId
  ) {
    const requestText = String(
      nativeTakeover?.terminal_bridge_request_text ??
        conversation.user_request ??
        ""
    );
    saveTerminalBridgeDispatchLedger(terminalControl, {
      ...terminalBindingLedgerFields(conversation),
      status: submission.status,
      generation_id: storedMessageId,
      conversation_id: conversation.conversation_id,
      message_id: storedMessageId,
      ...(stringValue(submission.message_type)
        ? { message_type: stringValue(submission.message_type) }
        : {}),
      request_hash:
        terminalBridgeRequestFingerprint(requestText),
      prepared_at:
        stringValue(submission.prepared_at) ??
        stringValue(conversation.updated_at),
      ...(submission.status === "agent_accepted"
        ? {
            agent_accepted_at:
              stringValue(submission.agent_accepted_at) ??
              stringValue(conversation.updated_at),
            acceptance_evidence: submission.acceptance_evidence
          }
        : {
            submitted_at:
              stringValue(submission.submitted_at) ??
              stringValue(conversation.updated_at)
          }),
      dispatcher_pid: null,
      state_path: statePath,
      event_log_path:
        stringValue(ledger.event_log_path) ??
        logPathForStatePath(statePath),
      callback_expected: Boolean(conversation.gateway_method),
      reason:
        "restored the prior durable generation after a pre-submit dispatcher exit"
    });
  } else {
    saveTerminalBridgeDispatchLedger(terminalControl, {
      ...ledger,
      status: "resolved",
      resolved_at: cliNow().toISOString(),
      reason:
        "dispatcher exited before the prepared generation reached durable state; no terminal input was possible"
    });
  }
  return loadTerminalBridgeDispatchLedger(terminalControl);
}

function reconcileLaggingTerminalDispatchLedger(
  terminalControl: TerminalControlRef,
  ledger?: Record<string, any>
): Record<string, any> | undefined {
  if (
    !ledger ||
    terminalDispatchLedgerLooksLifecycle(ledger) ||
    ![
      "text_injected",
      "enter_dispatched",
      "submitted",
      "agent_accepted",
      "not_accepted",
      "uncertain"
    ].includes(String(ledger.status))
  ) {
    return ledger;
  }
  const statePath = stringValue(ledger.state_path);
  const messageId = stringValue(ledger.message_id);
  if (!statePath || !messageId) {
    return ledger;
  }
  let conversation: Conversation;
  try {
    conversation = loadState(statePath);
  } catch {
    return ledger;
  }
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(conversation);
  const storedControl = terminalControlFromTakeover(nativeTakeover);
  if (
    conversation.conversation_id !== stringValue(ledger.conversation_id) ||
    stringValue(nativeTakeover?.terminal_bridge_message_id) !== messageId ||
    stringValue(submission?.message_id) !== messageId ||
    !storedControl ||
    !sameTerminalControlIncarnation(storedControl, terminalControl)
  ) {
    return ledger;
  }
  const requestText = String(
    nativeTakeover?.terminal_bridge_request_text ?? conversation.user_request ?? ""
  );
  const requestHash = terminalBridgeRequestFingerprint(requestText);
  if (
    stringValue(ledger.request_hash) !== requestHash ||
    stringValue(submission?.request_hash) !== requestHash
  ) {
    return ledger;
  }
  const bindingFields = terminalBindingLedgerFields(conversation);
  for (const key of [
    "binding_id",
    "binding_generation",
    "native_thread_id",
    "store_dir"
  ]) {
    if (
      ledger[key] !== undefined &&
      bindingFields[key] !== undefined &&
      String(ledger[key]) !== String(bindingFields[key])
    ) {
      return ledger;
    }
  }

  const stateStatus = String(submission?.status ?? "");
  let stateAcceptanceEvidence: TerminalSubmissionAcceptanceEvidence | undefined;
  if (stateStatus === "agent_accepted") {
    try {
      stateAcceptanceEvidence = terminalAcceptanceEvidenceForConversation(
        conversation,
        requestText,
        submission?.acceptance_evidence
      );
    } catch {
      stateAcceptanceEvidence = undefined;
    }
  }
  let ledgerAcceptanceEvidence: TerminalSubmissionAcceptanceEvidence | undefined;
  let ledgerAcceptanceError: string | undefined;
  if (ledger.status === "agent_accepted") {
    try {
      ledgerAcceptanceEvidence = terminalAcceptanceEvidenceForConversation(
        conversation,
        requestText,
        ledger.acceptance_evidence
      );
    } catch (error) {
      ledgerAcceptanceError = error instanceof Error
        ? error.message
        : String(error);
    }
  }

  if (ledgerAcceptanceEvidence) {
    if (!stateAcceptanceEvidence) {
      const acceptedAt =
        stringValue(ledger.agent_accepted_at) ?? cliNow().toISOString();
      const acceptedConversation = withTerminalBridgeSubmission({
        conversation,
        messageId,
        requestText,
        status: "agent_accepted",
        preparedAt:
          stringValue(submission?.prepared_at) ??
          stringValue(ledger.prepared_at) ??
          acceptedAt,
        textInjectedAt:
          stringValue(submission?.text_injected_at) ??
          stringValue(ledger.text_injected_at),
        enterDispatchedAt:
          stringValue(submission?.enter_dispatched_at) ??
          stringValue(ledger.enter_dispatched_at),
        agentAcceptedAt: acceptedAt,
        acceptanceEvidence: ledgerAcceptanceEvidence
      });
      saveState(statePath, acceptedConversation);
    }
    return ledger;
  }

  if (stateAcceptanceEvidence) {
    const acceptedAt =
      stringValue(submission?.agent_accepted_at) ?? cliNow().toISOString();
    saveTerminalBridgeDispatchLedger(terminalControl, {
      ...ledger,
      ...bindingFields,
      status: "agent_accepted",
      text_injected_at: submission?.text_injected_at,
      enter_dispatched_at: submission?.enter_dispatched_at,
      agent_accepted_at: acceptedAt,
      acceptance_evidence: stateAcceptanceEvidence,
      dispatcher_pid: null,
      reason: "recovered the strongest durable native acceptance receipt"
    });
    return loadTerminalBridgeDispatchLedger(terminalControl);
  }

  if (ledger.status === "agent_accepted") {
    const uncertainAt = cliNow().toISOString();
    const uncertainConversation = withTerminalBridgeSubmission({
      conversation: {
        ...conversation,
        status: "stalled" as const,
        stalled_at: uncertainAt,
        stalled_reason: "stored native acceptance evidence is invalid",
        updated_at: uncertainAt
      },
      messageId,
      requestText,
      status: "uncertain",
      preparedAt:
        stringValue(submission?.prepared_at) ??
        stringValue(ledger.prepared_at) ??
        uncertainAt,
      textInjectedAt:
        stringValue(submission?.text_injected_at) ??
        stringValue(ledger.text_injected_at),
      enterDispatchedAt:
        stringValue(submission?.enter_dispatched_at) ??
        stringValue(ledger.enter_dispatched_at),
      uncertainAt,
      error: ledgerAcceptanceError ??
        "stored native acceptance evidence is invalid",
      lastProvenStage: "enter_dispatched"
    });
    saveState(statePath, uncertainConversation);
    saveTerminalBridgeDispatchLedger(terminalControl, {
      ...ledger,
      ...bindingFields,
      status: "uncertain",
      uncertain_at: uncertainAt,
      dispatcher_pid: null,
      reason: "stored native acceptance evidence is invalid"
    });
    return loadTerminalBridgeDispatchLedger(terminalControl);
  }

  const stateRank = terminalSubmissionProofRank(
    stateStatus,
    stringValue(submission?.last_proven_stage)
  );
  const ledgerRank = terminalSubmissionProofRank(
    String(ledger.status),
    stringValue(ledger.last_proven_stage)
  );
  const stateIsTerminal = ["not_accepted", "uncertain", "aborted"]
    .includes(stateStatus);
  if (!stateIsTerminal && stateRank <= ledgerRank) {
    return ledger;
  }
  if (
    ![
      "text_injected",
      "enter_dispatched",
      "submitted",
      "not_accepted",
      "uncertain",
      "aborted"
    ].includes(stateStatus)
  ) {
    return ledger;
  }
  saveTerminalBridgeDispatchLedger(terminalControl, {
    ...ledger,
    ...bindingFields,
    status: stateStatus,
    ...(submission?.text_injected_at
      ? { text_injected_at: submission.text_injected_at }
      : {}),
    ...(submission?.enter_dispatched_at
      ? { enter_dispatched_at: submission.enter_dispatched_at }
      : {}),
    ...(submission?.submitted_at
      ? { submitted_at: submission.submitted_at }
      : {}),
    ...(submission?.not_accepted_at
      ? { not_accepted_at: submission.not_accepted_at }
      : {}),
    ...(submission?.uncertain_at
      ? { uncertain_at: submission.uncertain_at }
      : {}),
    ...(submission?.aborted_at
      ? { aborted_at: submission.aborted_at }
      : {}),
    last_proven_stage: submission?.last_proven_stage,
    ...(stateIsTerminal ? { dispatcher_pid: null } : {}),
    reason: "recovered the strongest durable conversation proof level"
  });
  return loadTerminalBridgeDispatchLedger(terminalControl);
}

function terminalSubmissionProofRank(status: string, lastProven?: string): number {
  if (status === "agent_accepted" || lastProven === "agent_accepted") {
    return 3;
  }
  if (
    ["enter_dispatched", "submitted", "not_accepted"].includes(status) ||
    lastProven === "enter_dispatched"
  ) {
    return 2;
  }
  if (status === "text_injected" || lastProven === "text_injected") {
    return 1;
  }
  return 0;
}

async function recoverDeferredCodexForegroundTransferBeforeMutation({
  options,
  terminal
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
}): Promise<void> {
  const storeDir = storeDirFromOptions(options);
  const locks = terminalWriterMutationLocks(
    storeDir,
    terminal.terminalControl
  );
  await withCanonicalMutationLocks({
    ...locks,
    // Every caller already owns this exact terminal lock. The no-op adapter
    // creates the canonical scope without recursively acquiring the raw lock.
    acquireTerminal: () => () => {}
  }, (scopes, resources) =>
    recoverDeferredCodexForegroundTransferWhileWriterLease({
      options,
      terminal,
      storeDir,
      scopes,
      resources
    })
  );
}

async function withDeferredForegroundRecoveryScope<Result>({
  scopes,
  resources,
  transfer,
  operation
}: {
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
  transfer: DeferredForegroundTransfer;
  operation(scope: DeferredForegroundApplicationScope): Promise<Result>;
}): Promise<Result> {
  if (!transfer.state_path) {
    return operation(bindDeferredForegroundWriterScope(scopes, resources));
  }
  const statePath = path.resolve(transfer.state_path);
  const paths = pathsForConversationDir(path.dirname(statePath));
  return withTerminalDispatchStateScope(
    scopes,
    resources,
    statePath,
    paths.logPath,
    (stateScopes, stateResources) => operation(
      bindDeferredForegroundApplicationScope(stateScopes, stateResources)
    )
  );
}

function matchingDeferredForegroundTransfers(
  scope: DeferredForegroundApplicationScope,
  terminal: ResolvedTerminalConversation
): DeferredForegroundTransfer[] {
  return scope.listTransfers().filter((transfer) =>
    transfer.terminal_id === terminal.conversationId &&
    transfer.process_pid === terminal.pid &&
    terminalControlEvidenceMatches(
      transfer.terminal_endpoint,
      terminal.terminalControl
    )
  );
}

async function recoverDeferredCodexForegroundTransferWhileWriterLease({
  options,
  terminal,
  storeDir,
  scopes,
  resources
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
  storeDir: string;
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
}): Promise<void> {
  options = Object.freeze({ ...options, storeDir });
  const service = new DeferredForegroundRecoveryService({
    transaction: {
      writerScope: () => bindDeferredForegroundWriterScope(scopes, resources),
      withTransferScope: (transfer, operation) =>
        withDeferredForegroundRecoveryScope({
          scopes,
          resources,
          transfer,
          operation
        })
    },
    repository: {
      all: (scope) => scope.listTransfers(),
      matching: (scope) =>
        matchingDeferredForegroundTransfers(scope, terminal),
      load: (scope, transferId) => scope.loadTransfer(transferId),
      markUncertain: (scope, boundary, reason) =>
        deferredForegroundApplication(options, terminal).markUncertain({
          scope,
          boundary,
          reason
        })
    },
    recovery: {
      boundary: (transfer) =>
        deferredForegroundBoundaryProjection(
          deferredRecoveryAdapter.deferredCodexBoundaryFromTransfer(
            deferredForegroundRecoveryAdapterPorts(),
            { terminal, transfer }
          )
        ),
      assertRoute: (scope, transfer, boundary) =>
        deferredForegroundApplication(options, terminal)
          .assertTransferAuthority(scope, transfer, boundary),
      finalizeAbort: (scope, transfer) => {
        deferredForegroundApplication(options).finalizeAbort(scope, transfer);
      },
      persistCommitted: (scope, transfer) =>
        deferredRecoveryAdapter.persistCommittedDeferredForegroundTurnAcceptance(
          deferredForegroundRecoveryAdapterPorts(), {
          options,
          scope,
          storeDir,
          terminal,
          transfer
        }),
      crashAfterCommittedBackfill: () => {
        if (
          cliEnv().AKK_TEST_EXIT_AFTER_DEFERRED_COMMITTED_ACCEPTANCE_BACKFILL ===
            "1"
        ) {
          cliExit(86);
        }
      },
      resolveCommitted: async (scope, boundary) => {
        await deferredForegroundApplication(options, terminal).resolve({
          scope,
          boundary
        });
      },
      assertAcceptedTurn: (accepted) =>
        assertNativeAgentIdentityForTurn({
          conversation: accepted.conversation,
          currentIdentity: accepted.identity,
          operation: "recover committed deferred foreground binding for"
        }),
      abortPrepared: (scope, transfer, boundary, at) =>
        deferredRecoveryAdapter.abortPreparedDeferredForegroundTurn(
          deferredForegroundRecoveryAdapterPorts(), {
          options,
          scope,
          storeDir,
          terminal,
          transfer,
          boundary: deferredForegroundConcreteBoundary(boundary, terminal),
          terminalInputNotStartedAt: at
        }),
      durableInputNotStartedAt: (scope, transfer) =>
        deferredRecoveryAdapter.deferredCodexDurableInputNotStartedAt(
          deferredForegroundRecoveryAdapterPorts(),
          scope,
          transfer
        ),
      recoverAccepted: (scope, transfer, boundary) =>
        deferredRecoveryAdapter.recoverAcceptedDeferredForegroundDispatch(
          deferredForegroundRecoveryAdapterPorts(), {
          options,
          scope,
          storeDir,
          terminal,
          transfer,
          boundary: deferredForegroundConcreteBoundary(boundary, terminal)
        }),
      pendingAnchorVersion: (scope, transfer) =>
        deferredRecoveryAdapter.loadDeferredForegroundTurnAuthority(
          deferredForegroundRecoveryAdapterPorts(), {
          storeDir,
          terminal,
          transfer,
          scope
        }).anchor.version
    },
    runtime: {
      terminalTarget: terminal.terminalControl.target,
      isStoreMutationLockTimeout
    }
  });
  await service.recover();
}

interface CodexLatentClearResumeObservation {
  sourceNativeThreadId: string;
  fingerprint: string;
}

function codexLatentClearResumeObservation({
  screen,
  agentVersion
}: {
  screen: string | undefined;
  agentVersion: string | undefined;
}): CodexLatentClearResumeObservation | undefined {
  const behaviorProfile = codexLifecycleBehaviorProfile(agentVersion);
  if (!behaviorProfile) {
    return undefined;
  }
  const withoutEscapes = (line: string): string => line.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu,
    ""
  );
  const resumePrefix = /^\s*To continue this session, run codex resume\s+(.+?)\s*$/iu;
  const exactUuid = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
  const lines = String(screen ?? "")
    .split(/\r?\n/u)
    .slice(-24)
    .map(withoutEscapes);
  const resumeIds: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const prefixMatch = resumePrefix.exec(lines[index]);
    if (!prefixMatch) {
      continue;
    }
    // Codex wraps the UUID after a hyphen in narrow panes. Only join the
    // immediately following line, strip layout whitespace, and still require
    // the resulting value to be one exact UUID. This keeps a prose lookalike
    // or an unrelated scrollback line from becoming routing authority.
    const firstFragment = prefixMatch[1].replace(/\s+/gu, "");
    const fragments = [
      firstFragment,
      ...(firstFragment.endsWith("-")
        ? [`${prefixMatch[1]}${lines[index + 1] ?? ""}`.replace(/\s+/gu, "")]
        : [])
    ];
    const matched = fragments.flatMap((candidate) => {
      const uuidMatch = exactUuid.exec(candidate);
      return uuidMatch ? [uuidMatch[1].toLowerCase()] : [];
    })[0];
    if (matched) {
      resumeIds.push(matched);
    }
  }
  const sourceNativeThreadId = resumeIds.at(-1);
  if (!sourceNativeThreadId) {
    return undefined;
  }
  return {
    sourceNativeThreadId,
    fingerprint: terminalActionFingerprint({
      kind: "codex_latent_clear_resume_hint",
      behavior_profile: behaviorProfile,
      source_native_thread_id: sourceNativeThreadId
    })
  };
}

function nativeInspectionComposerEmpty(
  agent: ExecutorKind,
  screen: string | undefined
): boolean {
  return agent === "codex"
    ? codexComposerEmpty(screen)
    : isExactClaudeNativeInspectionIdleComposer(String(screen ?? ""));
}

async function assertNativeInspectionComposerReadyForAutomatedInput({
  options,
  terminal
}: {
  options: Record<string, any>;
  terminal: ResolvedTerminalConversation;
}): Promise<void> {
  if (terminal.agent === "codex") {
    await assertCodexComposerReadyForAutomatedInput({
      options,
      terminalControl: terminal.terminalControl
    });
    return;
  }
  const provider = createTerminalControlProvider(options);
  const resolvedTerminal = await provider.resolve(
    provider.endpoint(terminal.terminalControl)
  );
  const screen = await provider.capture(
    resolvedTerminal,
    { scrollbackLines: 40 }
  );
  if (!isExactClaudeNativeInspectionIdleComposer(screen)) {
    throw new Error(
      "Claude composer contains input or is not at the exact idle frame; refusing automated terminal input"
    );
  }
}

function restoreTerminalBridgeDispatchLedger({
  terminalControl,
  previousLedger,
  reason
}: {
  terminalControl: TerminalControlRef;
  previousLedger?: Record<string, any>;
  reason: string;
}): void {
  if (previousLedger) {
    saveTerminalBridgeDispatchLedger(terminalControl, previousLedger);
    return;
  }
  saveTerminalBridgeDispatchLedger(terminalControl, {
    status: "resolved",
    resolved_at: cliNow().toISOString(),
    reason
  });
}

function resolveTerminalBridgeDispatchLedger(
  terminalControl: TerminalControlRef,
  { conversation, expectedMessageId, reason }: {
  conversation: Conversation;
  expectedMessageId?: string;
  reason: string;
}): boolean {
  const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
  if (
    !ledger ||
    stringValue(ledger.conversation_id) !== conversation.conversation_id ||
    (
      expectedMessageId !== undefined &&
      stringValue(ledger.message_id) !== expectedMessageId
    )
  ) {
    return false;
  }
  saveTerminalBridgeDispatchLedger(terminalControl, {
    ...ledger,
    status: "resolved",
    resolved_at: cliNow().toISOString(),
    reason
  });
  return true;
}

function assertVerifiedDeadTerminalBridgeDispatchAuthority({
  terminalControl,
  conversation,
  storeDir,
  statePath,
  logPath,
  expectedMessageId
}: {
  terminalControl: TerminalControlRef;
  conversation: Conversation;
  storeDir: string;
  statePath: string;
  logPath: string;
  expectedMessageId: string;
}): { ledger: Record<string, any>; resolved: boolean } {
  assertTurnBindingCurrent(
    conversation,
    "resolve a verified-dead agent dispatch for"
  );
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(conversation);
  const rawStateReceiptHistory =
    takeover?.terminal_bridge_submission_receipts;
  const rawStateReceipts = Array.isArray(rawStateReceiptHistory)
    ? rawStateReceiptHistory.filter((receipt) =>
        isRecord(receipt) &&
        stringValue(receipt.message_id) === expectedMessageId
      )
    : [];
  const validatedStateReceipts = terminalBridgeSubmissionReceipts(
    conversation
  ).filter((receipt) =>
    stringValue(receipt.message_id) === expectedMessageId
  );
  const requestText = String(
    takeover?.terminal_bridge_request_text ?? conversation.user_request ?? ""
  );
  const requestHash = terminalBridgeRequestFingerprint(requestText);
  const sessionId = sessionIdForConversation(conversation);
  const turnId = turnIdForConversation(conversation);
  const bindingId = stringValue(conversation.terminal_binding_id);
  const bindingGeneration = Number(conversation.terminal_binding_generation);
  const nativeThreadId = stringValue(conversation.native_thread_id) ??
    stringValue(takeover?.terminal_agent_session_id);
  const endpointAnchor = terminalEndpointFromControlRef(
    terminalControl
  ).processAnchorPid;
  if (
    !expectedMessageId ||
    !Array.isArray(rawStateReceiptHistory) ||
    rawStateReceipts.length !== 1 ||
    validatedStateReceipts.length !== 1 ||
    canonicalJson(rawStateReceipts[0]) !== canonicalJson(submission) ||
    canonicalJson(validatedStateReceipts[0]) !== canonicalJson(submission) ||
    stringValue(takeover?.terminal_bridge_message_id) !== expectedMessageId ||
    submission?.status !== "agent_accepted" ||
    stringValue(submission.message_id) !== expectedMessageId ||
    stringValue(submission.session_id) !== sessionId ||
    stringValue(submission.turn_id) !== turnId ||
    stringValue(submission.binding_id) !== bindingId ||
    Number(submission.binding_generation) !== bindingGeneration ||
    !requestHash ||
    stringValue(submission.request_hash) !== requestHash ||
    !bindingId ||
    !Number.isSafeInteger(bindingGeneration) ||
    bindingGeneration < 1 ||
    !nativeThreadId ||
    !Number.isSafeInteger(endpointAnchor) ||
    Number(endpointAnchor) < 1 ||
    !sameCanonicalStatePath(conversation.state_path, statePath) ||
    path.resolve(stringValue(conversation.event_log_path) ?? "") !==
      path.resolve(logPath) ||
    path.resolve(managedSessionStoreDirForConversation(conversation) ?? "") !==
      path.resolve(storeDir)
  ) {
    throw new Error(
      `verified-dead Turn ${conversation.conversation_id} has no exact accepted submission authority`
    );
  }
  const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
  const rawReceiptHistory = ledger?.terminal_submission_receipts;
  const receipts = Array.isArray(rawReceiptHistory)
    ? rawReceiptHistory.filter((receipt) =>
        isRecord(receipt) &&
        stringValue(receipt.message_id) === expectedMessageId
      )
    : [];
  // Parse the entire append-only history as well as selecting the one exact
  // receipt. A synthesized top-level candidate is not sufficient cleanup
  // authority for a verified-dead process.
  const validatedReceiptHistory = terminalLedgerReceiptHistory(ledger);
  const validatedReceipts = validatedReceiptHistory.filter((receipt) =>
    stringValue(receipt.message_id) === expectedMessageId
  );
  const receipt = receipts[0];
  const recordMatches = (
    record: Record<string, any> | undefined,
    expectedStatus: "agent_accepted" | "resolved"
  ): boolean => Boolean(
    record &&
    record.status === expectedStatus &&
    stringValue(record.generation_id) === expectedMessageId &&
    stringValue(record.conversation_id) === conversation.conversation_id &&
    stringValue(record.session_id) === sessionId &&
    stringValue(record.turn_id) === turnId &&
    stringValue(record.message_id) === expectedMessageId &&
    stringValue(record.request_hash) === requestHash &&
    sameCanonicalStatePath(record.state_path, statePath) &&
    path.resolve(stringValue(record.store_dir) ?? "") ===
      path.resolve(storeDir) &&
    path.resolve(stringValue(record.event_log_path) ?? "") ===
      path.resolve(logPath) &&
    stringValue(record.binding_id) === bindingId &&
    Number(record.binding_generation) === bindingGeneration &&
    stringValue(record.native_thread_id) === nativeThreadId &&
    stringValue(record.executor_kind) ===
      executorForConversation(conversation).kind &&
    (stringValue(record.openclaw_session) ?? undefined) ===
      (stringValue(conversation.openclaw_session) ?? undefined) &&
    Boolean(record.callback_expected) === Boolean(conversation.gateway_method) &&
    (stringValue(record.message_type) ?? undefined) ===
      (stringValue(submission.message_type) ?? undefined) &&
    (stringValue(record.message_body_hash) ?? undefined) ===
      (stringValue(submission.message_body_hash) ?? undefined) &&
    isRecord(record.terminal_endpoint) &&
    terminalDispatchRecordMatchesControl(record, terminalControl, {
      requireProcessAnchor: true
    }) &&
    terminalDispatchRecordProcessAnchor(record) === endpointAnchor
  );
  if (
    !ledger ||
    terminalDispatchLedgerLooksLifecycle(ledger) ||
    !["agent_accepted", "resolved"].includes(String(ledger.status)) ||
    !recordMatches(
      ledger,
      ledger.status === "resolved" ? "resolved" : "agent_accepted"
    ) ||
    receipts.length !== 1 ||
    validatedReceipts.length !== 1 ||
    canonicalJson(receipts[0]) !== canonicalJson(validatedReceipts[0]) ||
    !recordMatches(receipt, "agent_accepted") ||
    (
      ledger.status === "resolved" &&
      validTimestampMs(ledger.resolved_at) === undefined
    )
  ) {
    throw new Error(
      `verified-dead Turn ${conversation.conversation_id} no longer owns one exact terminal dispatch receipt`
    );
  }
  let stateAcceptance: TerminalSubmissionAcceptanceEvidence;
  let ledgerAcceptance: TerminalSubmissionAcceptanceEvidence;
  let receiptAcceptance: TerminalSubmissionAcceptanceEvidence;
  try {
    stateAcceptance = terminalAcceptanceEvidenceForConversation(
      conversation,
      requestText,
      submission.acceptance_evidence
    );
    ledgerAcceptance = terminalAcceptanceEvidenceForConversation(
      conversation,
      requestText,
      ledger.acceptance_evidence
    );
    receiptAcceptance = terminalAcceptanceEvidenceForConversation(
      conversation,
      requestText,
      receipt.acceptance_evidence
    );
  } catch (error) {
    throw new Error(
      `verified-dead Turn ${conversation.conversation_id} has invalid native acceptance evidence: ` +
      (error instanceof Error ? error.message : String(error))
    );
  }
  if (
    canonicalJson(stateAcceptance) !== canonicalJson(ledgerAcceptance) ||
    canonicalJson(stateAcceptance) !== canonicalJson(receiptAcceptance)
  ) {
    throw new Error(
      `verified-dead Turn ${conversation.conversation_id} has conflicting native acceptance receipts`
    );
  }
  return { ledger, resolved: ledger.status === "resolved" };
}

function resolveVerifiedDeadTerminalBridgeDispatchLedger(options: {
  terminalControl: TerminalControlRef;
  conversation: Conversation;
  storeDir: string;
  statePath: string;
  logPath: string;
  expectedMessageId: string;
  reason: string;
}): boolean {
  const authority = assertVerifiedDeadTerminalBridgeDispatchAuthority(options);
  if (authority.resolved) {
    return true;
  }
  saveTerminalBridgeDispatchLedger(options.terminalControl, {
    ...authority.ledger,
    status: "resolved",
    resolved_at: cliNow().toISOString(),
    reason: options.reason
  });
  const resolved = assertVerifiedDeadTerminalBridgeDispatchAuthority(options);
  if (!resolved.resolved) {
    throw new Error(
      `verified-dead Turn ${options.conversation.conversation_id} dispatch did not resolve`
    );
  }
  return true;
}

const terminalBridgeRequestFingerprint =
  dispatchReceipt.terminalBridgeRequestFingerprint;


function prepareTerminalBridgeCompletionCallback(args) {
  const storeDir = pathsForConversationDir(
    path.dirname(args.statePath)
  ).storeDir;
  const releaseTerminalLock = acquireTerminalBridgeSendLock(
    storeDir,
    args.terminalControl,
    { timeoutMs: 30000 }
  );
  try {
    return withStoreWriterLease(storeDir, () =>
      prepareTerminalBridgeCompletionCallbackWithLocksHeld(args)
    );
  } finally {
    releaseTerminalLock();
  }
}

function prepareTerminalBridgeCompletionCallbackWithLocksHeld({
  options,
  statePath,
  logPath,
  conversation,
  executor,
  terminalControl,
  terminalMessageId,
  completion,
  allowSupersedeRecovery = false,
  completionFingerprint = undefined
}) {
  return callbackOutboxService().prepareTerminalCompletion({
    options: { ...options, statePath },
    statePath,
    logPath,
    conversationId: conversation.conversation_id,
    actor: executor.actor,
    terminalControl,
    terminalMessageId,
    completion,
    allowSupersedeRecovery,
    completionFingerprint
  });
}

function persistTerminalBridgeActivity({
  conversation,
  statePath,
  logPath,
  observedAtMs,
  reason,
  activityState,
  timeoutMinutes,
  hardTimeoutMinutes
}) {
  const storeDir = pathsForConversationDir(path.dirname(statePath)).storeDir;
  return withStoreWriterLease(storeDir, () => {
    const releaseLock = acquireFileLock(`${statePath}.lock`);
    try {
    const currentConversation = loadState(statePath);
    if (!isWaitingForAgent(currentConversation.status)) {
      return currentConversation;
    }
    const expectedNativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : {};
    const nativeTakeover = isRecord(currentConversation.native_session_takeover)
      ? currentConversation.native_session_takeover
      : {};
    if (
      nativeTakeover["terminal_bridge_message_id"] !==
      expectedNativeTakeover["terminal_bridge_message_id"]
    ) {
      return currentConversation;
    }

    const previousActivityAtMs = validTimestampMs(nativeTakeover["terminal_bridge_last_activity_at"]);
    const observedAt = new Date(observedAtMs).toISOString();
    const inactivityDeadlineAt = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
      ? new Date(observedAtMs + timeoutMinutes * 60 * 1000).toISOString()
      : undefined;
    const nextConversation = {
      ...currentConversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_last_activity_at: observedAt,
        terminal_bridge_last_activity_reason: reason,
        terminal_bridge_inactivity_deadline_at: inactivityDeadlineAt,
        terminal_bridge_inactivity_timeout_minutes: timeoutMinutes,
        terminal_bridge_hard_timeout_minutes: hardTimeoutMinutes
      },
      updated_at: observedAt
    };
    saveState(statePath, nextConversation);
    appendEvent(logPath, {
      ts: observedAt,
      conversation_id: currentConversation.conversation_id,
      event: "terminal_bridge_activity_observed",
      reason,
      last_activity_at: observedAt,
      terminal_activity_state: activityState
    });
    if (inactivityDeadlineAt) {
      appendEvent(logPath, {
        ts: observedAt,
        conversation_id: currentConversation.conversation_id,
        event: "terminal_bridge_inactivity_deadline_extended",
        reason,
        previous_last_activity_at: previousActivityAtMs === undefined
          ? null
          : new Date(previousActivityAtMs).toISOString(),
        last_activity_at: observedAt,
        inactivity_deadline_at: inactivityDeadlineAt,
        agent_timeout_minutes: timeoutMinutes
      });
    }
    return nextConversation;
    } finally {
      releaseLock();
    }
  });
}

function persistTerminalBridgeDetectorDiagnostic({
  statePath,
  logPath,
  expectedConversationId,
  expectedMessageId,
  limitation,
  fingerprint
}: {
  statePath: string;
  logPath: string;
  expectedConversationId: string;
  expectedMessageId?: string;
  limitation?: string;
  fingerprint?: string;
}) {
  const storeDir = pathsForConversationDir(path.dirname(statePath)).storeDir;
  return withStoreWriterLease(storeDir, () => {
    const releaseLock = acquireFileLock(`${statePath}.lock`);
    try {
    const conversation = loadState(statePath);
    const nativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : {};
    if (
      conversation.conversation_id !== expectedConversationId ||
      stringValue(nativeTakeover.terminal_bridge_message_id) !==
        expectedMessageId
    ) {
      return {
        persisted: false as const,
        conversation,
        reason: "terminal_bridge_task_replaced"
      };
    }
    const existing = isRecord(nativeTakeover.terminal_bridge_detector_diagnostic)
      ? nativeTakeover.terminal_bridge_detector_diagnostic
      : undefined;
    const now = cliNow().toISOString();
    const nextDiagnostic = limitation && fingerprint
      ? {
          status: "limited",
          source: "terminal_completion_detector",
          fingerprint,
          detail: truncateText(redactString(limitation), 1000),
          observed_at: now
        }
      : existing && stringValue(existing.status) === "limited"
        ? {
            ...existing,
            status: "recovered",
            recovered_at: now
          }
        : undefined;
    if (!nextDiagnostic) {
      return {
        persisted: false as const,
        conversation,
        diagnostic: existing,
        reason: "detector_diagnostic_unchanged"
      };
    }
    if (
      stringValue(existing?.status) === stringValue(nextDiagnostic.status) &&
      stringValue(existing?.fingerprint) ===
        stringValue(nextDiagnostic.fingerprint)
    ) {
      return {
        persisted: false as const,
        conversation,
        diagnostic: existing,
        reason: "detector_diagnostic_unchanged"
      };
    }
    const nextConversation = {
      ...conversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_detector_diagnostic: nextDiagnostic
      },
      updated_at: now
    };
    saveState(statePath, nextConversation);
    const event = nextDiagnostic.status === "limited"
      ? "terminal_bridge_completion_detector_limited"
      : "terminal_bridge_completion_detector_recovered";
    appendEvent(logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event,
      terminal_bridge_message_id: expectedMessageId,
      detector_source: nextDiagnostic.source,
      diagnostic_fingerprint: nextDiagnostic.fingerprint,
      detail: nextDiagnostic.status === "limited"
        ? nextDiagnostic.detail
        : undefined
    });
    runtimeLog(
      nextDiagnostic.status === "limited" ? "warn" : "info",
      event,
      {
        conversation_id: conversation.conversation_id,
        terminal_bridge_message_id: expectedMessageId,
        detector_source: nextDiagnostic.source,
        diagnostic_fingerprint: nextDiagnostic.fingerprint
      }
    );
    return {
      persisted: true as const,
      conversation: nextConversation,
      diagnostic: nextDiagnostic
    };
    } finally {
      releaseLock();
    }
  });
}

async function loadCodexTerminalContexts({ nativeTakeover, options }) {
  const provider = createAgentSessionProvider("codex", options);
  const nativeSessionId = stringValue(nativeTakeover?.["native_session_id"]);
  const startedAtMs = Date.parse(String(nativeTakeover?.["terminal_bridge_started_at"] ?? ""));
  const terminalConversation = parseTerminalConversationId(nativeSessionId);
  const activeProcess = await activeCodexProcessForPid(options, terminalConversation?.pid);
  const directSessionId = activeProcess?.sessionId ?? (terminalConversation ? undefined : nativeSessionId);
  if (directSessionId) {
    const context = await provider.getForkContext({
      sessionId: directSessionId,
      maxMessages: Number(options.maxMessages ?? 16),
      maxCommands: Number(options.maxCommands ?? 10),
      maxTextLength: Number(options.maxTextLength ?? 4000)
    });
    if (context) {
      return [{
        context,
        process: activeProcess,
        match: activeProcess?.sessionId ? "process_session_id" : "native_session_id",
        confidence: "high"
      }];
    }
  }

  const cwd = activeProcess?.cwd ?? stringValue(nativeTakeover?.["source_cwd"]);
  if (!cwd) {
    return [];
  }

  const sessions = (await provider.listHistoricalSessions())
    .filter((session) => session.cwd === cwd)
    .filter((session) => {
      if (!Number.isFinite(startedAtMs)) {
        return true;
      }
      if (session.updatedAtMs === undefined || session.updatedAtMs === null) {
        return true;
      }
      const updatedAtMs = Number(session.updatedAtMs);
      return !Number.isFinite(updatedAtMs) || updatedAtMs >= startedAtMs;
    })
    .sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  const matches: Array<{
    context: ForkContextPackage;
    process: ActiveCodexProcess | undefined;
    match: string;
    confidence: string;
  }> = [];
  const candidateErrors: string[] = [];
  for (const session of sessions) {
    try {
      const context = await provider.getForkContext({
        sessionId: session.id,
        maxMessages: Number(options.maxMessages ?? 16),
        maxCommands: Number(options.maxCommands ?? 10),
        maxTextLength: Number(options.maxTextLength ?? 4000)
      });
      if (context) {
        matches.push({
          context,
          process: activeProcess,
          match: sessions.length === 1 ? "cwd" : "cwd_request_hash",
          confidence: sessions.length === 1 ? "medium" : "low"
        });
      }
    } catch (error) {
      candidateErrors.push(
        `${session.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (candidateErrors.length > 0) {
    throw new Error(
      `could not inspect every plausible same-cwd Codex session: ${candidateErrors.join("; ")}`
    );
  }
  return matches;
}

/**
 * Detached monitors must re-enter through the executable wrapper. The command
 * implementation lives beside it in cli-core.js, but importing that module is
 * intentionally side-effect free and therefore cannot dispatch a child CLI.
 */
function cliEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
}

function printVersion() {
  const packageJsonPath = path.join(packageRootDir(), "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  writeCliStdout(`${packageJson.version}\n`);
}

function runTranscript(options) {
  const conversationDir = options.conversation ? expandHome(options.conversation) : null;
  const logPath = conversationDir
    ? pathsForConversationDir(conversationDir).logPath
    : required(options.log ?? options.path, "--log or --conversation is required");
  const events = readNdjsonLog(expandHome(logPath));
  writeCliStdout(formatTranscript(events, {
    includeRaw: Boolean(options.includeRaw)
  }));
}

function runCallback(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  runCallbackTransaction({ ...options, statePath });
}

function runRetryCallback(options) {
  const { conversation, statePath, logPath } =
    loadConversationFromOptions(options);
  const storeDir = pathsForConversationDir(path.dirname(statePath)).storeDir;
  withStoreWriterLease(storeDir, () => {
    const fresh = loadState(statePath);
    assertConversationHasNoNonterminalDeferredForegroundTransfer({
      storeDir,
      conversation: fresh,
      action: "retry callback for"
    });
  });
  const outcome = callbackOutboxService().retry({
    options: { ...options, statePath },
    conversation,
    statePath,
    logPath
  });
  if (outcome.kind === "recovered") {
    emitPreparedCallbackResult(outcome.result);
  }
}

function runCallbackTransaction(options) {
  let prepared;
  const callbackStoreDir = pathsForConversationDir(
    path.dirname(options.statePath)
  ).storeDir;
  withStoreWriterLease(callbackStoreDir, () => {
    const releaseLock = acquireFileLock(`${options.statePath}.lock`);
    try {
      prepared = prepareLockedCallback(options);
    } finally {
      releaseLock();
    }
  });
  return runPreparedCallback(prepared);
}

function callbackOutboxService() {
  return createCallbackOutboxService({
    state: {
      load: loadState,
      save: saveState,
      readEvents: readExistingEvents,
      append: appendEvent,
      appendMessage: (logPath, message) => {
        appendEvent(logPath, messageEvent(message));
      },
      assertWriterCompatible: assertStoreWriterCompatible,
      withTransaction: (statePath, operation) => {
        const releaseLock = acquireFileLock(`${statePath}.lock`);
        try {
          return operation();
        } finally {
          releaseLock();
        }
      },
      storeDirForStatePath: (statePath) =>
        pathsForConversationDir(path.dirname(statePath)).storeDir,
      logPathForStatePath
    },
    authority: {
      assertNoDeferredTransfer:
        assertConversationHasNoNonterminalDeferredForegroundTransfer,
      assertBindingCurrent: assertTurnBindingCurrent,
      isDispatchReleased: (conversation) =>
        TERMINAL_DISPATCH_RELEASE_STATUSES.has(
          effectiveTurnStatus(conversation)
        ),
      isWaitingForAgent,
      isTerminalBridgeSupersedeStatus: (status) =>
        TERMINAL_BRIDGE_SUPERSEDE_STATUSES.has(status)
    },
    retry: {
      startMonitor: startCallbackRetryMonitor,
      isProcessAlive,
      attemptLeaseMs: CALLBACK_ATTEMPT_LEASE_MS,
      delaysMs: CALLBACK_RETRY_DELAYS_MS
    },
    runtime: {
      now: cliNow,
      nowMs: cliNowMs,
      pid: cliPid,
      log: runtimeLog,
      textSummary,
      sleepSync,
      crashCheckpoint: () => {
        if (cliEnv().AKK_TEST_EXIT_AFTER_LOCAL_COMPLETION_STATE === "1") {
          cliExit(86);
        }
      }
    },
    delivery: {
      deliver: (input) => openClawCallbackTransport().deliverCallback(input),
      runTransaction: runCallbackTransaction
    },
    terminal: {
      resolveCompletionDispatch: ({
        terminalControl,
        conversation,
        expectedMessageId,
        reason
      }) => resolveTerminalBridgeDispatchLedger(terminalControl, {
        conversation,
        expectedMessageId,
        reason
      })
    }
  });
}

function prepareLockedCallback(
  options: CallbackPreparationOptions
): PreparedCallback {
  required(options.messageJson, "--message-json is required");
  const logPath = expandHome(
    options.log ?? logPathForStatePath(options.statePath)
  );
  return callbackOutboxService().prepare({
    options,
    logPath
  });
}

function emitPreparedCallbackResult(result): void {
  printJson({
    conversation: result.conversation,
    message: result.message,
    budget: budgetAction(result.conversation),
    delivered: result.delivered,
    duplicate: result.duplicate,
    ...(result.delivery === undefined ? {} : { delivery: result.delivery })
  });
}

function runPreparedCallback(prepared, { emit = true } = {}) {
  const result = callbackOutboxService().runPrepared(prepared);
  if (emit) {
    emitPreparedCallbackResult(result);
  }
  return result;
}

function recordCallbackProcessDelivery({
  logPath,
  conversation,
  message,
  event,
  runtimeEvent,
  delivery,
  detail = {}
}: CallbackProcessDeliveryObservation) {
  appendEvent(logPath, {
    ts: cliNow().toISOString(),
    conversation_id: conversation.conversation_id,
    event,
    from: message.from,
    to: "openclaw",
    round: message.round,
    ...detail,
    status: delivery.status,
    stdout: redactString(delivery.stdout),
    stderr: redactString(delivery.stderr)
  });
  runtimeLog("info", runtimeEvent, {
    conversation_id: conversation.conversation_id,
    ...detail,
    status: delivery.status,
    failure_kind: classifyProcessFailure(delivery),
    stdout: textSummary(delivery.stdout),
    stderr: textSummary(delivery.stderr)
  });
}

function openClawCallbackTransport() {
  return createOpenClawCallbackTransport({
    now: cliNow,
    environment: cliEnv,
    redactConversation: redactCliOutput,
    recordCallbackProcessDelivery
  });
}

function isStoreMutationLockTimeout(error: unknown): boolean {
  return error instanceof StoreLockTimeoutError ||
    (isRecord(error) && error.code === "LOCK_TIMEOUT");
}

function readExistingEvents(logPath) {
  try {
    return readNdjsonLog(logPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function loadConversationFromOptions(options) {
  const storeDir = storeDirFromOptions(options);
  const conversationId = options.turn ?? options.conversation ?? options.conversationId;
  const statePath = expandHome(options.state ?? (conversationId ? statePathForConversationId(conversationId, storeDir) : undefined));
  if (!statePath) {
    throw new Error("--conversation or --state is required");
  }

  const conversation = options.state
    ? (() => {
        const paths = pathsForConversationDir(path.dirname(statePath));
        if (path.resolve(paths.statePath) !== path.resolve(statePath)) {
          throw new Error(`AKK state path is not canonical: ${statePath}`);
        }
        return loadConversationById(
          path.basename(paths.conversationDir),
          paths.storeDir
        );
      })()
    : loadConversationById(conversationId, storeDir);
  assertConfiguredWorkspace(
    options.workspace,
    conversation.workspace,
    `access to AKK conversation ${conversation.conversation_id}`
  );
  return {
    conversation,
    statePath,
    logPath: logPathForStatePath(statePath)
  };
}

function storeDirFromOptions(options) {
  return expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(cliCwd()));
}

function summarizeConversation(conversation) {
  const executor = executorForConversation(conversation);
  const callbackDelivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const callbackDisposition = callbackDelivery
    ? callbackOutboxService().retryDisposition(callbackDelivery)
    : undefined;
  return {
    session_id: sessionIdForConversation(conversation),
    turn_id: turnIdForConversation(conversation),
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor,
    session: executor.session,
    status: conversation.status,
    request: conversation.user_request,
    workspace: conversation.workspace,
    openclaw_session: conversation.openclaw_session,
    response_rounds_used: conversation.response_rounds_used,
    soft_limit: conversation.soft_limit,
    hard_limit: conversation.hard_limit,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    idle_since: conversation.idle_since,
    closed_at: conversation.closed_at,
    ...(callbackDelivery
      ? {
          callback_delivery: {
            status: callbackDelivery.status,
            attempts: callbackDelivery.attempts,
            attempt_state: callbackDisposition?.state,
            attempt_pid: callbackDelivery.attempt_pid,
            lease_expires_at: callbackDelivery.attempt_lease_expires_at,
            next_attempt_at: callbackDelivery.next_attempt_at,
            last_error: callbackDelivery.last_error === undefined
              ? undefined
              : textSummary(String(callbackDelivery.last_error))
          }
        }
      : {}),
    state_path: conversation.state_path,
    event_log_path: conversation.event_log_path
  };
}

function isDiscoverableTmuxConversation(conversation): boolean {
  if (!isRecord(conversation)) {
    return false;
  }
  if (!isRecord(conversation.executor)) {
    return false;
  }
  const kind = stringValue(conversation.executor.kind)?.toLowerCase();
  return (
    kind !== undefined &&
    isExecutorKind(kind) &&
    conversation.executor.transport === "tmux"
  );
}

function persistedExecutorLogFields(conversation): {
  agent: string;
  executor_session?: string;
} {
  if (isDiscoverableTmuxConversation(conversation)) {
    const executor = executorForConversation(conversation);
    return {
      agent: executor.kind,
      executor_session: executor.session
    };
  }
  const rawExecutor = isRecord(conversation?.executor)
    ? conversation.executor
    : {};
  return {
    agent: stringValue(rawExecutor.kind) ?? "unsupported",
    executor_session: stringValue(rawExecutor.session)
  };
}

function summarizeEvent(event) {
  return {
    ts: event.ts,
    event: event.event,
    from: event.from,
    to: event.to,
    type: event.type,
    status: event.status,
    round: event.round,
    body: typeof event.body === "string" ? event.body.slice(0, 500) : undefined
  };
}

async function activeCodexProcessForPid(options, pid: number | undefined): Promise<ActiveCodexProcess | undefined> {
  if (!Number.isInteger(pid)) {
    return undefined;
  }
  const provider = createAgentSessionProvider("codex", options);
  const activeSessions = await listActiveSessionsWithTerminalControl(provider, options);
  return activeSessions.find((process) => process.pid === pid);
}

async function codexTerminalStatusContext({
  id,
  process,
  options,
  terminalControl,
  terminalStatus
}: {
  id: string;
  process?: ActiveCodexProcess;
  options: Record<string, any>;
  terminalControl?: TerminalControlRef;
  terminalStatus?: Record<string, any>;
}) {
  const provider = createAgentSessionProvider("codex", options);
  const directSessionId = process?.sessionId;
  if (directSessionId) {
    const context = await provider.getForkContext({
      sessionId: directSessionId,
      maxMessages: Number(options.maxMessages ?? 16),
      maxCommands: Number(options.maxCommands ?? 10),
      maxTextLength: Number(options.maxTextLength ?? 1200)
    });
    if (context) {
      return codexTerminalContextFromHistory({
        id,
        confidence: "high",
        match: "session_id",
        process,
        context,
        terminalControl,
        terminalStatus,
        limitations: []
      });
    }
  }

  const cwd = process?.cwd ?? terminalControl?.currentPath;
  const sessions = (await provider.listHistoricalSessions())
    .filter((session) => session.cwd === cwd)
    .sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  if (sessions.length > 0) {
    const selected = sessions[0];
    const context = await provider.getForkContext({
      sessionId: selected.id,
      maxMessages: Number(options.maxMessages ?? 16),
      maxCommands: Number(options.maxCommands ?? 10),
      maxTextLength: Number(options.maxTextLength ?? 1200)
    });
    if (context) {
      return codexTerminalContextFromHistory({
        id,
        confidence: sessions.length === 1 ? "medium" : "low",
        match: sessions.length === 1 ? "cwd" : "cwd_latest",
        process,
        context,
        terminalControl,
        terminalStatus,
        limitations: sessions.length === 1
          ? ["Codex session inferred from matching cwd because the active process did not expose a session id."]
          : [`Codex session inferred from the most recent of ${sessions.length} sessions with the same cwd.`],
        candidates: sessions.slice(0, 5).map((session) => ({
          session_id: session.id,
          cwd: session.cwd,
          title: session.title ?? session.preview ?? session.firstUserMessage,
          updated_at_ms: session.updatedAtMs,
          capability: session.capability
        }))
      });
    }
  }

  return {
    conversation_id: id,
    source: "terminal_control",
    confidence: "screen_only",
    match: "terminal_screen",
    about: screenOnlyAbout({ process, terminalStatus }),
    evidence: {
      process,
      terminal_control: terminalControl,
      terminal_status: terminalStatus
    },
    limitations: [
      "No exact Codex session id was available.",
      cwd ? "No matching Codex rollout history was found for this cwd." : "No process cwd was available for Codex history matching.",
      "Summary is limited to active process metadata and the visible terminal screen."
    ]
  };
}

function codexTerminalContextFromHistory({
  id,
  confidence,
  match,
  process,
  context,
  terminalControl,
  terminalStatus,
  limitations,
  candidates
}: {
  id: string;
  confidence: "high" | "medium" | "low";
  match: string;
  process?: ActiveCodexProcess;
  context: ForkContextPackage;
  terminalControl?: TerminalControlRef;
  terminalStatus?: Record<string, any>;
  limitations: string[];
  candidates?: Record<string, any>[];
}) {
  return {
    conversation_id: id,
    source: "terminal_control",
    confidence,
    match,
    about: rolloutAbout(context, terminalStatus),
    codex_session: context.source,
    evidence: {
      process,
      terminal_control: terminalControl,
      terminal_status: terminalStatus,
      initial_request: bestSessionIntent(context),
      title: context.source.title,
      recent_messages: visibleRolloutMessages(context).slice(-8),
      recent_commands: context.commands.slice(-8),
      candidates
    },
    limitations
  };
}

function managedConversationAbout(conversation, events, terminalStatus?: Record<string, any>): string {
  const request = truncateText(String(conversation.user_request ?? "").trim(), 220);
  const recent = recentMessageEvidence(events).at(-1)?.body;
  const parts = [
    request ? `Initial request: ${request}` : undefined,
    recent ? `Latest visible message: ${truncateText(recent, 180)}` : undefined,
    terminalStatus?.activity_state ? `Current terminal state: ${terminalStatus.activity_state}.` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "No durable task content is available for this AKK-managed session.";
}

function rolloutAbout(context: ForkContextPackage, terminalStatus?: Record<string, any>): string {
  const title = truncateText(String(context.source.title ?? "").trim(), 180);
  const intent = bestSessionIntent(context);
  const latestAssistant = [...visibleRolloutMessages(context)].reverse().find((message) => message.role === "assistant")?.text;
  const latestCommand = context.commands.at(-1)?.command;
  const parts = [
    intent ? `Initial request: ${truncateText(intent, 220)}` : title ? `Codex title: ${title}` : undefined,
    latestAssistant ? `Latest visible progress: ${truncateText(latestAssistant, 180)}` : undefined,
    latestCommand ? `Recent command: ${truncateText(latestCommand, 140)}` : undefined,
    terminalStatus?.activity_state ? `Current terminal state: ${terminalStatus.activity_state}.` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Codex history was found, but it did not include enough visible message content to summarize the session.";
}

function screenOnlyAbout({ process, terminalStatus }: { process?: ActiveCodexProcess; terminalStatus?: Record<string, any> }): string {
  const activity = terminalStatus?.activity_reason ?? terminalStatus?.activity_state;
  const excerpt = terminalStatus?.screen?.excerpt;
  const parts = [
    process?.cwd ? `This Codex process is running in ${process.cwd}.` : undefined,
    activity ? `Terminal activity: ${truncateText(String(activity), 180)}` : undefined,
    excerpt ? `Visible screen: ${truncateText(String(excerpt), 220)}` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Only active process metadata is available; no Codex conversation history or terminal screen content could be read.";
}

function bestSessionIntent(context: ForkContextPackage): string | undefined {
  const firstUser = visibleRolloutMessages(context).find((message) => message.role === "user")?.text;
  if (firstUser) {
    return firstUser;
  }
  const title = cleanIntentText(context.source.title);
  if (title) {
    return title;
  }
  return undefined;
}

function visibleRolloutMessages(context: ForkContextPackage) {
  return context.messages.filter((message) => !isEnvironmentContextMessage(message.text));
}

function cleanIntentText(value: string | undefined): string | undefined {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text && !isEnvironmentContextMessage(text) ? text : undefined;
}

function isEnvironmentContextMessage(value: string | undefined): boolean {
  return /^\s*<environment_context[\s>]/u.test(String(value ?? ""));
}

function recentMessageEvidence(events) {
  return events
    .filter((event) => event.event === "message" && typeof event.body === "string")
    .slice(-8)
    .map((event) => ({
      ts: event.ts,
      from: event.from,
      to: event.to,
      type: event.type,
      round: event.round,
      body: truncateText(event.body, 800)
    }));
}

function truncateText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isActiveStatus(status) {
  return !["done", "failed", "closed", "cancelled"].includes(status);
}

function isWaitingForAgent(status) {
  return ["created", "running", "waiting_for_agent", "cancelling"].includes(status);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return !isZombieProcess(pid);
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isZombieProcess(pid) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return false;
  }

  return result.stdout.trim().toUpperCase().startsWith("Z");
}

function markConversationStalled({ statePath, logPath, reason, detail = {} }) {
  const storeDir = pathsForConversationDir(path.dirname(statePath)).storeDir;
  let stalledConversation: Conversation | undefined;
  let stalledMessage: Record<string, any> | undefined;
  let unchangedConversation: Conversation | undefined;
  withStoreWriterLease(storeDir, () => {
    const releaseLock = acquireFileLock(`${statePath}.lock`);
    try {
    const conversation = loadState(statePath);
    if (!isWaitingForAgent(conversation.status)) {
      runtimeLog("info", "executor_monitor_finished", {
        conversation_id: conversation.conversation_id,
        status: conversation.status,
        reason: "conversation_changed_before_stall"
      });
      unchangedConversation = conversation;
      return;
    }

    const now = cliNow().toISOString();
    const executor = executorForConversation(conversation);
    const terminalBridge = terminalBridgeEnabled(conversation);
    const shouldNotify = Boolean(conversation.gateway_method && !conversation.stalled_notification_sent_at);
    stalledMessage = shouldNotify
      ? createMessage({
          conversation,
          from: executor.actor,
          to: "openclaw",
          type: "error",
          requiresResponse: false,
          body: [
            `AKK marked this ${executor.display_name} task as stalled: ${reason}.`,
            "",
            `Turn: ${turnIdForConversation(conversation)}`,
            `AKK session: ${sessionIdForConversation(conversation)}`,
            `Agent session: ${executor.session}`,
            terminalBridge
              ? `Use \`AKK status --turn ${turnIdForConversation(conversation)}\` for details, \`AKK renew --turn ${turnIdForConversation(conversation)}\` to resume monitoring in this Turn, or \`AKK close --turn ${turnIdForConversation(conversation)}\` to close it. Start any independent retry with \`AKK send --session ${sessionIdForConversation(conversation)}\`.`
              : `Use \`AKK status --turn ${turnIdForConversation(conversation)}\` for details or \`AKK close --turn ${turnIdForConversation(conversation)}\` to close this Turn.`
          ].join("\n")
        })
      : undefined;
    stalledConversation = {
      ...conversation,
      status: "stalled" as const,
      stalled_at: now,
      stalled_reason: reason,
      stalled_notification_sent_at: shouldNotify ? now : conversation.stalled_notification_sent_at,
      stalled_notification_message_id: stalledMessage?.id ?? conversation.stalled_notification_message_id,
      updated_at: now
    };
    saveState(statePath, stalledConversation);
    appendEvent(logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event: "conversation_stalled",
      status: "stalled",
      reason,
      ...detail
    });
    runtimeLog("warn", "conversation_stalled", {
      conversation_id: conversation.conversation_id,
      agent: executorForConversation(conversation).kind,
      executor_session: executorForConversation(conversation).session,
      state_path: statePath,
      event_log_path: logPath,
      reason,
      ...detail
    });
    } finally {
      releaseLock();
    }
  });

  if (unchangedConversation) {
    return unchangedConversation;
  }

  if (stalledConversation && stalledMessage) {
    deliverStalledNotification({
      statePath,
      logPath,
      conversation: stalledConversation,
      message: stalledMessage
    });
  }
  return stalledConversation;
}

function deliverStalledNotification({ statePath, logPath, conversation, message, eventPrefix = "stalled" }) {
  if (!conversation.gateway_method) {
    return;
  }

  const gatewayToken = conversation.gateway_token;
  const gatewayUrl = gatewayToken ? conversation.gateway_url : undefined;
  const callbackTransport = openClawCallbackTransport();
  const delivery = callbackTransport.deliverGatewayMethod({
    method: conversation.gateway_method,
    openclawBin: conversation.openclaw_bin,
    gatewayUrl,
    token: gatewayToken,
    sessionKey: conversation.gateway_session ?? conversation.openclaw_session,
    statePath,
    logPath,
    conversation,
    message
  });
  appendEvent(logPath, {
    ts: cliNow().toISOString(),
    conversation_id: conversation.conversation_id,
    event: `${eventPrefix}_gateway_method_delivery`,
    method: conversation.gateway_method,
    message_id: message.id,
    status: delivery.status,
    stdout: redactString(delivery.stdout),
    stderr: redactString(delivery.stderr)
  });
  runtimeLog("info", `${eventPrefix}_gateway_method_delivery`, {
    conversation_id: conversation.conversation_id,
    method: conversation.gateway_method,
    message_id: message.id,
    status: delivery.status,
    failure_kind: classifyProcessFailure(delivery),
    stdout: textSummary(delivery.stdout),
    stderr: textSummary(delivery.stderr)
  });
  if (delivery.status !== 0) {
    return;
  }

  const gatewayPayload = parseOptionalJson(delivery.stdout);
  const chatSendParams = isRecord(gatewayPayload?.chat_send) ? gatewayPayload.chat_send : undefined;
  if (!chatSendParams) {
    return;
  }

  const chatSendDelivery = callbackTransport.deliverChatSend({
    openclawBin: conversation.openclaw_bin,
    gatewayUrl,
    token: gatewayToken,
    params: chatSendParams
  });
  appendEvent(logPath, {
    ts: cliNow().toISOString(),
    conversation_id: conversation.conversation_id,
    event: `${eventPrefix}_chat_send_delivery`,
    message_id: message.id,
    status: chatSendDelivery.status,
    stdout: redactString(chatSendDelivery.stdout),
    stderr: redactString(chatSendDelivery.stderr)
  });
  runtimeLog("info", `${eventPrefix}_chat_send_delivery`, {
    conversation_id: conversation.conversation_id,
    message_id: message.id,
    status: chatSendDelivery.status,
    failure_kind: classifyProcessFailure(chatSendDelivery),
    stdout: textSummary(chatSendDelivery.stdout),
    stderr: textSummary(chatSendDelivery.stderr)
  });
}

function reconcileIdleConversations(
  storeDir,
  options: Record<string, any> = {},
  now = cliNow(),
  conversationId?: string
) {
  const timeoutMinutes = Number(options.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return {
      checked: 0,
      closed: 0,
      skipped: 0,
      idle_timeout_minutes: timeoutMinutes
    };
  }

  ensureStoreWritable(storeDir);
  const conversations = listConversations(storeDir).filter((conversation) =>
    (conversationId === undefined || conversation.conversation_id === conversationId) &&
    matchesConfiguredWorkspace(options.workspace, conversation.workspace)
  );
  const reservedSourceTurnIds = new Set(
    listDeferredForegroundTransfers(storeDir)
      .filter((transfer) =>
        transfer.version === 2 &&
        transfer.source_kind === "candidate_rollout_quiescent" &&
        !FINAL_DEFERRED_TRANSFER_STATUSES.has(transfer.status)
      )
      .flatMap((transfer) =>
        (transfer.source_turn_history ?? []).map((turn) => turn.turn_id)
      )
  );
  let closed = 0;
  let skipped = 0;
  for (const listedConversation of conversations) {
    if (listedConversation.status !== "idle" || !listedConversation.idle_since) {
      continue;
    }

    const listedIdleSinceMs = Date.parse(listedConversation.idle_since);
    if (!Number.isFinite(listedIdleSinceMs)) {
      continue;
    }
    if (now.getTime() - listedIdleSinceMs < timeoutMinutes * 60 * 1000) {
      continue;
    }
    if (
      reservedSourceTurnIds.has(
        turnIdForConversation(listedConversation)
      )
    ) {
      skipped += 1;
      continue;
    }

    const statePath = listedConversation.state_path ??
      statePathForConversationId(listedConversation.conversation_id, storeDir);
    let releaseStateLock: (() => void) | undefined;
    try {
      releaseStateLock = acquireFileLock(`${statePath}.lock`);
    } catch (error) {
      if (isRecord(error) && error.code === "LOCK_TIMEOUT") {
        skipped += 1;
        continue;
      }
      throw error;
    }
    try {
      const conversation = loadState(statePath);
      if (conversation.status !== "idle" || !conversation.idle_since) {
        continue;
      }

      const idleSinceMs = Date.parse(conversation.idle_since);
      if (!Number.isFinite(idleSinceMs)) {
        continue;
      }

      const terminalBridge = terminalBridgeEnabled(conversation) &&
        isRecord(conversation.native_session_takeover) &&
        typeof conversation.native_session_takeover.terminal_bridge_message_id === "string";
      if (now.getTime() - idleSinceMs < timeoutMinutes * 60 * 1000) {
        continue;
      }

      const logPath = conversation.event_log_path ?? logPathForStatePath(statePath);
      const closeReason = `idle timeout after ${timeoutMinutes} minutes`;
      const closedConversation = {
        ...conversation,
        status: "closed" as const,
        closed_at: now.toISOString(),
        close_reason: closeReason,
        updated_at: now.toISOString()
      };
      delete closedConversation.idle_since;
      saveState(statePath, closedConversation);
      appendEvent(logPath, {
        ts: now.toISOString(),
        conversation_id: conversation.conversation_id,
        event: "conversation_closed",
        status: "closed",
        reason: closedConversation.close_reason,
        idle_timeout_minutes: timeoutMinutes,
        terminal_bridge: terminalBridge
      });
      const executorLogFields = persistedExecutorLogFields(conversation);
      runtimeLog("info", "idle_conversation_closed", {
        conversation_id: conversation.conversation_id,
        ...executorLogFields,
        state_path: statePath,
        event_log_path: logPath,
        idle_since: conversation.idle_since,
        idle_timeout_minutes: timeoutMinutes,
        reason: closedConversation.close_reason
      });
      closed += 1;
    } finally {
      releaseStateLock();
    }
  }

  return {
    checked: conversations.length,
    closed,
    skipped,
    idle_timeout_minutes: timeoutMinutes
  };
}


function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }

    const key = toCamelCase(arg.slice(2));
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }

  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function required(value, message) {
  if (value === undefined || value === "") {
    throw new Error(message);
  }

  return value;
}

function parseOptionalJson(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return undefined;
  }
}

function createAgentSessionProvider(agent, options) {
  if (agent !== "codex") {
    throw new Error(`unsupported agent session provider: ${agent}`);
  }

  const injected = cliDependencies<CliCommandOptions>().createAgentSessionProvider;
  if (injected) {
    return injected(agent, options);
  }
  const injectedAdapter = cliDependencies<CliCommandOptions>().codexLocalSessionAdapter;
  if (injectedAdapter) {
    return new CodexLocalSessionProvider(
      typeof injectedAdapter === "function"
        ? injectedAdapter(options)
        : injectedAdapter
    );
  }

  if (
    options.threadsJson ||
    options.processesJson ||
    options.rolloutsJson ||
    options.codexActiveSessionIdentitiesJson
  ) {
    return new CodexLocalSessionProvider(new InlineCodexLocalSessionAdapter({
      threads: parseJsonOption(options.threadsJson, "--threads-json"),
      processes: parseJsonOption(options.processesJson, "--processes-json"),
      rollouts: parseJsonOption(options.rolloutsJson, "--rollouts-json"),
      activeSessionIdentities: parseJsonOption(
        options.codexActiveSessionIdentitiesJson,
        "--codex-active-session-identities-json"
      )
    }));
  }

  return new CodexLocalSessionProvider(new CodexStoreAdapter({
    codexHome: expandHome(options.codexHome)
  }));
}

function codexThreadLifecycleProvider(
  options: CliCommandOptions
): TerminalThreadLifecycleCandidateProvider {
  return cliDependencies().codexThreadLifecycleProvider ??
    new CodexStoreAdapter({
      codexHome: expandHome(options.codexHome)
    });
}

function parseJsonOption(value, optionName) {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${optionName} must be valid JSON: ${error.message}`);
  }
}

function textSummary(text, maxLength = 240) {
  const value = String(text ?? "");
  return {
    length: value.length,
    preview: value ? value.slice(0, maxLength) : undefined
  };
}

function classifyProcessFailure(result) {
  const status = result?.status ?? 0;
  const combined = [
    result?.error?.message,
    result?.stderr,
    result?.stdout
  ].filter(Boolean).join("\n").toLowerCase();

  if (!combined && status === 0) {
    return undefined;
  }
  if (isRemoteCompactStreamDisconnect(combined)) {
    return "transient_remote_compact_failure";
  }
  if (combined.includes("agent needs reconnect") || combined.includes("internal error")) {
    return "agent_reconnect_required";
  }
  if (combined.includes("permission denied") || combined.includes("operation not permitted")) {
    return "permission_denied";
  }
  if (combined.includes("sandbox") || combined.includes("outside workspace")) {
    return "sandbox_denied";
  }
  if (combined.includes("timed out") || combined.includes("timeout")) {
    return "timeout";
  }
  if (status !== 0) {
    return "nonzero_exit";
  }
  return undefined;
}

function isRemoteCompactStreamDisconnect(text) {
  const value = String(text ?? "").toLowerCase();
  return (
    value.includes("error running remote compact task") &&
    value.includes("stream disconnected") &&
    value.includes("/codex/responses/compact")
  );
}

function withStoragePaths(conversation, paths) {
  return {
    ...conversation,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
}

const terminalCommandCliFacade = createTerminalCommandCliFacade({
  ports: {
    acquireFileLock,
    acquireTerminalBridgeSendLock,
    assertCodexComposerReadyForAutomatedInput,
    assertDeferredCodexForegroundBindingBoundary,
    assertExpectedHandoffTokenUsesExactTerminalSelector,
    assertManagedSessionCanStartTurn,
    assertManagedTerminalDispatchOwner,
    assertNativeAgentIdentityForTurn,
    assertNativeThreadHasExclusiveOwnership,
    assertObservedHandoffTransportBoundary,
    assertSafeAbortedTerminalRetryBinding,
    assertSafeTerminalSend,
    assertVerifiedEmptyCodexTransportBoundary,
    bindingMatchesLiveTerminal,
    codexAllowedCompanionSetForManagedSession,
    codexPreMaterializationIdentityForManagedSession,
    createBoundManagedSession,
    createManagedTerminalTurn,
    createRuntimeTerminalAgentRegistry,
    createTerminalAgentBridge,
    deferredForegroundApplication,
    deferredForegroundRecoveryAdapterPorts,
    ensureTerminalBridgeMonitorAfterApproval,
    exactSafeAbortedRecoveredSessionMatches,
    inspectCodexOpenRootRolloutInventory,
    isDiscoverableTmuxConversation,
    loadClaudeAgentRows,
    loadConversationFromOptions,
    loadTerminalBridgeDispatchLedger,
    loadTerminalDispatchLedgerOwner,
    logicalIdentityForManagedSession,
    managedSessionStoreDirForConversation,
    managedTurnsForSession,
    materializeCurrentManagedSession,
    maybeAdoptObservedExternalThread,
    maybeDetachVerifiedEmptyCodexSource,
    migrateLegacyTerminalAgentIdentity,
    mutationDispatchLedger,
    observeCurrentNativeAgentSessionIdentity,
    openClawYieldNextAction,
    parseJsonOption,
    persistManagedSessionNativeIdentity,
    positiveMinutes,
    prepareDeferredCodexForegroundBinding,
    quarantineManagedSessionBinding,
    reattachManagedSessionForNativeIdentity,
    reconcilePreparedTerminalDispatchLedger,
    refineManagedSessionNativeIdentity,
    refineTerminalTurnEndpoint,
    required,
    resolveCurrentNativeAgentSessionIdentity,
    resolveTerminalConversationFromOptions,
    resolveTerminalDispatchLedgerPaneIncarnation,
    soleBoundManagedSessionClaimForTerminal,
    stallOtherTerminalBridgeConversationsForUncertainDispatch,
    startTerminalBridgeMonitorForConversation,
    storeDirFromOptions,
    terminalBindingLedgerFields,
    terminalBridgeEnabled,
    terminalBridgeRequestFingerprint,
    terminalBridgeRuntimeKey,
    terminalControlFromTakeover,
    terminalDispatchCapabilityRepositories,
    terminalDispatchExecution,
    terminalDispatchRecordMatchesControl,
    terminalDurableRequestForConversation,
    terminalList: {
      assertTerminalIncarnationCanStartTurn:
        terminalListCliFacade.assertTerminalIncarnationCanStartTurn,
      resolveTerminalScopedCodexApproval:
        terminalListCliFacade.resolveTerminalScopedCodexApproval
    },
    terminalRuntimeForLiveIdentity,
    terminalRuntimeIdentityForConversation,
    terminalWriterMutationLocks,
    textSummary,
    verifyCodexPendingManagedSendStatus,
    withTerminalBridgeSubmission,
    withTerminalDispatchStateScope
  },
  policy: {
    terminalDispatchReleaseStatuses: TERMINAL_DISPATCH_RELEASE_STATUSES
  }
});

function usage() {
  const agentList = EXECUTOR_KINDS.join("|");
  writeCliStdout(`Usage:
  agent-knock-knock --help
  agent-knock-knock --version
  agent-knock-knock delegate --request <text> [--agent ${agentList}] [--workspace <path>] [--store-dir <dir>]
  agent-knock-knock list [--store-dir <dir>] [--agent ${agentList}] [--status <status>] [--all] [--reconcile] [--no-approval-scan] [--terminal-debug]
  agent-knock-knock status [--turn <turn-id|selector>] [--conversation <selector>] [--store-dir <dir>] [--reconcile] [--trace]
  agent-knock-knock send [--session <session-id|selector>] [--conversation <selector>] --message <text> [--expected-terminal-token <token>] [--type task] [--agent-timeout-minutes <minutes>] [--agent-hard-timeout-minutes <minutes>]
  agent-knock-knock new-thread --terminal <exact-terminal-id> --expected-binding-token <token>
  agent-knock-knock clear-thread --terminal <exact-terminal-id> --expected-binding-token <token>
  agent-knock-knock list-resumable-threads --terminal <exact-terminal-id> [--selection-scope <opaque-scope>]
  agent-knock-knock native-inspect --terminal <exact-terminal-id> --inspection status --expected-binding-token <token>
  agent-knock-knock resume-thread --terminal <exact-terminal-id> --native-thread <uuid> --expected-binding-token <token> --candidate-token <token>
  agent-knock-knock resume-thread --terminal <exact-terminal-id> (--selection-handle <handle> | --selection-snapshot <id> (--selection-number <n> | --selection-short-id <@id>)) --selection-scope <opaque-scope>
  agent-knock-knock reconcile-binding --terminal <exact-terminal-id> --conflicting-session <session-id> --expected-session-revision <n> --expected-binding-token <token> --expected-terminal-token <token>
  agent-knock-knock respond --turn <turn-id|selector> --message <text> [--conversation <selector>]
  agent-knock-knock approve [--turn <turn-id|selector>] [--conversation <selector>] [--expected-terminal-token <token>] --expected-approval-fingerprint <fingerprint>
  agent-knock-knock cancel [--turn <turn-id|selector>] [--conversation <selector>]
  agent-knock-knock renew [--turn <turn-id|selector>] [--conversation <selector>]
  agent-knock-knock retry-callback [--turn <turn-id|selector>] [--conversation <selector>]
  agent-knock-knock close [--turn <turn-id|selector>] [--conversation <selector>] [--reason <text>] [--expected-message-id <message-id> | --expected-transition-id <transition-id> | --expected-handoff-token <token>]
  agent-knock-knock install-openclaw [--verify] [--openclaw-bin <path>] [--skill-path <path>] [--skill-only] [--no-restart]
  agent-knock-knock doctor [--openclaw-bin <path>] [--tmux-bin <path>] [--herdr-bin <path>]
  agent-knock-knock callback --state <file> --message-json <json> [--record-only]
  agent-knock-knock transcript --log <file> [--include-raw]
  agent-knock-knock transcript --conversation <dir> [--include-raw]
`);
}
