import path from "node:path";

import type { ExecutorKind } from "./executors.js";
import {
  createManagedSessionId,
  createNativeThreadTransitionId,
  isExactNativeThreadId,
  managedSessionBindingToken,
  managedSessionRevision,
  nativeThreadTransitionRevision,
  nativeThreadCommandFingerprint,
  terminalBindingFrom,
  type ManagedSessionState,
  type NativeThreadCandidate,
  type NativeThreadTransition
} from "./managed-session.js";
import {
  assertRestorableOriginSessionRelationship as assertRestorableOriginSessionRelationshipFromQuery,
  requireRestorableLifecycleOrigin as requireRestorableLifecycleOriginFromQuery,
  resumableNativeThreadCandidates,
  revalidateNativeThreadCandidate as revalidateNativeThreadCandidateFromQuery
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
  createNativeThreadLifecycleRecoveryProbeAdapter,
  lifecycleRecoveryRuntime,
  lifecycleRecoveryTerminalFacts
} from "./native-thread-lifecycle-recovery-adapter.js";
import { nativeThreadTransitionResourceBoundOperation } from
  "./native-thread-transition-resource-adapter.js";
import {
  assertResumedNativeThreadMatchesCandidate as assertResumedCodexRolloutMatchesCandidate,
  nativeThreadCandidateFileIdentity as codexCandidateFileIdentity,
  prepareNativeThreadVerification,
  verifyNativeThreadTransition as verifyNativeThreadTransitionWithRuntime,
  type NativeThreadVerificationAdapterPorts
} from "./native-thread-transition-verification-adapter.js";
import {
  resolveNativeThreadResumeSelection
} from "./native-thread-resume-snapshot.js";
import {
  assertResumeSnapshotActionFingerprint,
  assertResumeSnapshotCandidates,
  assertResumeSnapshotMatchesTerminal,
  assertResumeSnapshotNotExpired,
  type NativeThreadResumeSnapshot
} from "./native-thread-resume-snapshot-policy.js";
import {
  commitVerifiedLifecycleTransition,
  listNativeThreadTransitions,
  loadManagedSession,
  loadNativeThreadTransition,
  saveManagedSession,
  saveNativeThreadTransition,
  tryLoadManagedSession
} from "./session-store.js";
import type {
  TerminalControlRef,
  TerminalRuntimeIdentity,
  TerminalThreadLifecycleAgentRow,
  TerminalThreadLifecycleCandidateToken
} from "./terminal-agent-adapter.js";
import {
  TerminalInputNotStartedError,
  type ResolvedTerminalConversation,
  type TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import type { TerminalDispatchTerminal } from
  "./terminal-dispatch-composition.js";
import {
  codexCompanionsExcludingPreferred,
  nativeIdentityMatchesCodexPreMaterialization,
  terminalControlAliasMatches,
  terminalControlsShareIncarnation,
  type CodexAllowedCompanionSet,
  type ManagedBindingConflictKind
} from "./terminal-authority-policy.js";
import type { TerminalNativeIdentity as NativeAgentSessionIdentity } from
  "./terminal-binding-authority.js";
import {
  nativeThreadLifecycleLedger as lifecycleLedger,
  terminalDispatchLedgerLooksLifecycle,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import type {
  NativeThreadLifecycleLedgerCliAdapter
} from "./native-thread-lifecycle-ledger-cli-adapter.js";
import type {
  NativeThreadLifecycleCliFacade,
  NativeThreadOwnershipRequest
} from "./native-thread-lifecycle-cli-adapter.js";
import type { TerminalRuntimeCliAdapter } from
  "./terminal-runtime-cli-adapter.js";
import {
  reconcileTerminalBinding,
  type BindingReconciliationStatusFacts,
  type BindingReconciliationTerminalFacts
} from "./terminal-binding-reconciliation-service.js";
import {
  type CanonicalMutationLockPorts,
  type CanonicalMutationResources,
  type CanonicalMutationScopes,
  withCanonicalMutationLocks
} from "./mutation-transaction.js";
import {
  isSessionSendBlockingStatus,
  isTerminalDispatchOwnerReleasedStatus,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import { nonBlankString as stringValue } from "./value-guards.js";

export type NativeThreadTransitionCliOptions =
  Readonly<Record<string, unknown>>;

type Scoped<Args extends unknown[], Result> = (
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  ...args: Args
) => Result;

export interface NativeThreadTransitionRuntimePorts {
  now(): Date;
  nowMs(): number;
  pid(): number;
  cwd(): string;
  sleep(milliseconds: number): Promise<void>;
  env(name: string): string | undefined;
  exit(code: number): void;
  log(level: "info" | "warn" | "error", event: string,
    details: Record<string, unknown>): void;
  print(value: unknown): void;
  summarizeError(error: unknown):
    Readonly<{ length: number; preview?: string }>;
}

export interface NativeThreadTransitionLifecyclePorts {
  facade: Pick<NativeThreadLifecycleCliFacade,
    "resolveLifecycleTerminal" | "queryPorts" | "assertExclusive" |
    "currentSnapshot" | "lifecycleBindingTokens" | "agentAdapter" |
    "assertSameInspectionTerminal">;
  runtime(options: NativeThreadTransitionCliOptions): TerminalRuntimeCliAdapter;
  resolveIdentity(input: {
    options: NativeThreadTransitionCliOptions;
    agent: ExecutorKind;
    pid: number;
    cwd?: string;
    preferredSessionId?: string;
    allowedCompanionIdentity?: CodexAllowedCompanionSet["primary"];
    allowedAdditionalIdentities?: readonly NonNullable<
      CodexAllowedCompanionSet["primary"]>[];
  }): Promise<NativeAgentSessionIdentity | undefined>;
  runtimeForIdentity(input: {
    terminal: ResolvedTerminalConversation;
    identity?: NativeAgentSessionIdentity;
    expectedEmptyNativeSession?: boolean;
    physicalOnly?: boolean;
  }): TerminalRuntimeIdentity;
  exactIdentity(terminal: ResolvedTerminalConversation,
    identity: NativeAgentSessionIdentity): NativeAgentSessionIdentity;
  assertComposerReady(input: {
    options: NativeThreadTransitionCliOptions;
    terminalControl: TerminalControlRef;
  }): Promise<void>;
}

export interface NativeThreadTransitionStatePorts {
  storeDir(options: NativeThreadTransitionCliOptions): string;
  runtimeDir(): string;
  loadLedger(terminalControl: TerminalControlRef):
    TerminalDispatchLedgerDocument | undefined;
  reconcilePrepared(terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument):
    TerminalDispatchLedgerDocument | undefined;
  reconcileIncarnation(terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument):
    TerminalDispatchLedgerDocument | undefined;
  recordMatchesControl(ledger: TerminalDispatchLedgerDocument | undefined,
    terminalControl: TerminalControlRef): boolean;
  lifecycleLedger: NativeThreadLifecycleLedgerCliAdapter;
  ordinaryOwnerStatus(ledger: TerminalDispatchLedgerDocument):
    Conversation["status"] | undefined;
  blockingTurns(storeDir: string, terminalControl: TerminalControlRef):
    readonly Conversation[];
  managedTurns(storeDir: string, sessionId: string): readonly Conversation[];
  hasUnresolvedTransition(storeDir: string,
    session: ManagedSessionState): boolean;
  dispatchOwnership(terminalControl: TerminalControlRef): { state: string };
}

export interface NativeThreadTransitionAuthorityPorts {
  sessionClaimsTerminal(session: ManagedSessionState,
    terminal: BindingReconciliationTerminalFacts): boolean;
  conflictKind(input: {
    storeDir: string;
    session: ManagedSessionState;
    terminal: ResolvedTerminalConversation;
    identity?: NativeAgentSessionIdentity;
  }): ManagedBindingConflictKind | undefined;
  ownerIsInactive(input: {
    session: ManagedSessionState;
    terminal: Pick<ResolvedTerminalConversation, "agent" | "pid">;
    identity?: NativeAgentSessionIdentity;
  }): boolean;
  observeExternal(input: {
    options: NativeThreadTransitionCliOptions;
    terminal: ResolvedTerminalConversation;
    sourceSession: ManagedSessionState;
    resolvedIdentity?: NativeAgentSessionIdentity;
  }): Promise<{
    identity?: NativeAgentSessionIdentity; status: TerminalBridgeStatus
  }>;
  recoverDeferred(input: {
    options: NativeThreadTransitionCliOptions;
    terminal: ResolvedTerminalConversation;
    storeDir: string;
    scopes: CanonicalMutationScopes;
    resources: CanonicalMutationResources;
  }): Promise<void>;
  knownRoots(input: {
    storeDir: string;
    terminal: ResolvedTerminalConversation;
    transition: NativeThreadTransition;
  }): CodexAllowedCompanionSet;
  codexProcessBirth(pid: number): string;
  processAlive(pid: number): boolean;
  workspaceMatches(configured: unknown, observed: unknown): boolean;
}

export interface NativeThreadTransitionMutationPorts {
  locks(storeDir: string, terminalControl: TerminalControlRef):
    CanonicalMutationLockPorts;
  authenticate(scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources):
    Readonly<{ terminalControl: TerminalControlRef; storeDir: string }>;
  loadSession: Scoped<[string], ManagedSessionState>;
  saveSession: Scoped<[
    ManagedSessionState,
    Readonly<{ expectedRevision: number }>
  ], ManagedSessionState>;
}

export interface CreateNativeThreadTransitionApplicationInput {
  runtime: NativeThreadTransitionRuntimePorts;
  lifecycle: NativeThreadTransitionLifecyclePorts;
  state: NativeThreadTransitionStatePorts;
  authority: NativeThreadTransitionAuthorityPorts;
  mutation: NativeThreadTransitionMutationPorts;
}

export interface NativeThreadTransitionApplication {
  runNewThread(options: NativeThreadTransitionCliOptions): Promise<void>;
  runResumeThread(options: NativeThreadTransitionCliOptions): Promise<void>;
  runReconcileBinding(options: NativeThreadTransitionCliOptions): Promise<void>;
  verificationPorts(options: NativeThreadTransitionCliOptions,
    terminal: ResolvedTerminalConversation): NativeThreadVerificationAdapterPorts;
  assertTerminalReady(input: {
    options: NativeThreadTransitionCliOptions;
    terminal: TerminalDispatchTerminal;
    terminalStatus: BindingReconciliationStatusFacts;
  }): void;
  recoverBeforeMutation(
    scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources,
    options: NativeThreadTransitionCliOptions,
    capturedTerminal: ResolvedTerminalConversation
  ): Promise<void>;
  reconcileLedger(
    scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources,
    options: NativeThreadTransitionCliOptions,
    capturedTerminal: ResolvedTerminalConversation,
    ledger: TerminalDispatchLedgerDocument,
    authority?: NativeThreadLifecycleRecoveryAuthority
  ): Promise<TerminalDispatchLedgerDocument>;
}

function createNativeThreadTransitionBindings(
  ports: CreateNativeThreadTransitionApplicationInput
) {
  const {
    now: cliNow,
    nowMs: cliNowMs,
    pid: cliPid,
    cwd: cliCwd,
    sleep: cliSleep,
    exit: cliExit,
    log: runtimeLog,
    print: printJson,
    summarizeError: textSummary
  } = ports.runtime;
  const cliEnv = () => new Proxy({} as Record<string, string | undefined>, {
    get: (_target, property) => ports.runtime.env(String(property))
  });
  const nativeThreadLifecycleFacade = ports.lifecycle.facade;
  const assertNativeThreadHasExclusiveOwnership = (
    input: NativeThreadOwnershipRequest
  ) => nativeThreadLifecycleFacade.assertExclusive(input);
  const resolveLifecycleTerminal =
    nativeThreadLifecycleFacade.resolveLifecycleTerminal;
  const nativeThreadLifecycleQueryPorts =
    nativeThreadLifecycleFacade.queryPorts;
  const currentLifecycleSnapshot =
    nativeThreadLifecycleFacade.currentSnapshot;
  const lifecycleBindingTokens =
    nativeThreadLifecycleFacade.lifecycleBindingTokens;
  const assertSameNativeInspectionTerminal =
    nativeThreadLifecycleFacade.assertSameInspectionTerminal;
  const storeDirFromOptions = ports.state.storeDir;
  const terminalBridgeRuntimeDir = ports.state.runtimeDir;
  const loadTerminalBridgeDispatchLedger = ports.state.loadLedger;
  const reconcilePreparedTerminalDispatchLedger =
    ports.state.reconcilePrepared;
  const resolveTerminalDispatchLedgerPaneIncarnation =
    ports.state.reconcileIncarnation;
  const terminalDispatchRecordMatchesControl =
    ports.state.recordMatchesControl;
  const saveLifecycleTerminalDispatchLedger =
    ports.state.lifecycleLedger.save;
  const loadTerminalDispatchLedgerOwner = (
    ledger: TerminalDispatchLedgerDocument
  ) => {
    const status = ports.state.ordinaryOwnerStatus(ledger);
    return status ? { status } : undefined;
  };
  const terminalListCliFacade = {
    terminalIncarnationBlockingTurns: ports.state.blockingTurns,
    terminalDispatchOwnership: ports.state.dispatchOwnership,
    managedSessionHasUnresolvedNativeTransition:
      ports.state.hasUnresolvedTransition
  };
  const managedTurnsForSession = ports.state.managedTurns;
  const terminalWriterMutationLocks = ports.mutation.locks;
  const mutationManagedSessions = {
    load: ports.mutation.loadSession,
    save: ports.mutation.saveSession
  };
  const authenticateLifecycleRecoveryResources =
    ports.mutation.authenticate;
  const createTerminalAgentBridge = (
    options: NativeThreadTransitionCliOptions
  ) => ports.lifecycle.runtime(options).createBridge();
  const loadClaudeAgentRows = (
    options: NativeThreadTransitionCliOptions,
    settings: Readonly<{ required: true }>
  ): readonly TerminalThreadLifecycleAgentRow[] =>
    ports.lifecycle.runtime(options).loadClaudeAgentRows(settings);
  const agentVersionForRunningProcess = (
    agent: ExecutorKind,
    pid: number,
    options: NativeThreadTransitionCliOptions
  ) => ports.lifecycle.runtime(options)
    .agentVersionForRunningProcess(agent, pid);
  const terminalRuntimeForLiveIdentity =
    ports.lifecycle.runtimeForIdentity;
  const resolveCurrentNativeAgentSessionIdentity =
    ports.lifecycle.resolveIdentity;
  const assertCodexComposerReadyForAutomatedInput =
    ports.lifecycle.assertComposerReady;
  const exactLifecycleProcessIdentity = ports.lifecycle.exactIdentity;
  const managedSessionClaimsResolvedTerminal =
    ports.authority.sessionClaimsTerminal;
  const managedBindingConflictKindForResolvedTerminal =
    ports.authority.conflictKind;
  const managedSessionOwnerIsConclusivelyInactive =
    ports.authority.ownerIsInactive;
  const observedExternalHandoffIdentity =
    ports.authority.observeExternal;
  const recoverDeferredCodexForegroundTransferWhileWriterLease =
    ports.authority.recoverDeferred;
  const codexKnownRootSetForLifecycleTransition =
    ports.authority.knownRoots;
  const codexProcessBirthForLifecycle =
    ports.authority.codexProcessBirth;
  const isProcessAlive = ports.authority.processAlive;
  const matchesConfiguredWorkspace = ports.authority.workspaceMatches;
  return Object.freeze({
    cliNow, cliNowMs, cliPid, cliCwd, cliSleep, cliExit,
    runtimeLog, printJson, textSummary, cliEnv,
    nativeThreadLifecycleFacade, assertNativeThreadHasExclusiveOwnership,
    resolveLifecycleTerminal, nativeThreadLifecycleQueryPorts,
    currentLifecycleSnapshot, lifecycleBindingTokens,
    assertSameNativeInspectionTerminal, storeDirFromOptions,
    terminalBridgeRuntimeDir, loadTerminalBridgeDispatchLedger,
    reconcilePreparedTerminalDispatchLedger,
    resolveTerminalDispatchLedgerPaneIncarnation,
    terminalDispatchRecordMatchesControl,
    saveLifecycleTerminalDispatchLedger, loadTerminalDispatchLedgerOwner,
    terminalListCliFacade, managedTurnsForSession,
    terminalWriterMutationLocks, mutationManagedSessions,
    authenticateLifecycleRecoveryResources, createTerminalAgentBridge,
    loadClaudeAgentRows, agentVersionForRunningProcess,
    terminalRuntimeForLiveIdentity,
    resolveCurrentNativeAgentSessionIdentity,
    assertCodexComposerReadyForAutomatedInput,
    exactLifecycleProcessIdentity, managedSessionClaimsResolvedTerminal,
    managedBindingConflictKindForResolvedTerminal,
    managedSessionOwnerIsConclusivelyInactive,
    observedExternalHandoffIdentity,
    recoverDeferredCodexForegroundTransferWhileWriterLease,
    codexKnownRootSetForLifecycleTransition,
    codexProcessBirthForLifecycle, isProcessAlive,
    matchesConfiguredWorkspace
  });
}

type NativeThreadTransitionBindings = ReturnType<
  typeof createNativeThreadTransitionBindings
>;

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === "") throw new Error(message);
  return value;
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

function bindingTerminalFacts(
  terminal: ResolvedTerminalConversation
): BindingReconciliationTerminalFacts {
  return Object.freeze({
    conversationId: terminal.conversationId,
    agent: terminal.agent,
    pid: terminal.pid,
    terminalControl: terminal.terminalControl
  });
}

type NativeThreadTransitionOperation =
  | { kind: "new_thread"; requireRestorableOrigin: boolean }
  | {
      kind: "resume_thread";
      nativeThreadId: string;
      selectionSnapshot?: NativeThreadResumeSnapshot;
    };

type NativeThreadTransitionRunner = (
  options: NativeThreadTransitionCliOptions,
  operation: NativeThreadTransitionOperation
) => Promise<void>;

type NativeThreadTransitionCommandApplication = Pick<
  NativeThreadTransitionApplication,
  "runNewThread" | "runResumeThread" | "runReconcileBinding" |
    "verificationPorts" | "assertTerminalReady"
> & Readonly<{
  assertTargetExclusive(input: {
    options: NativeThreadTransitionCliOptions;
    terminal: ResolvedTerminalConversation;
    transition: NativeThreadTransition;
    storeDir: string;
  }): Promise<void>;
}>;

type NativeThreadTransitionRecoveryApplication = Pick<
  NativeThreadTransitionApplication,
  "recoverBeforeMutation" | "reconcileLedger"
>;

export function createNativeThreadTransitionApplication(
  ports: CreateNativeThreadTransitionApplicationInput
): NativeThreadTransitionApplication {
  const bindings = createNativeThreadTransitionBindings(ports);
  let commands: NativeThreadTransitionCommandApplication;
  let recovery: NativeThreadTransitionRecoveryApplication;
  const runTransition: NativeThreadTransitionRunner = (options, operation) =>
    runNativeThreadTransition(
      bindings, commands, recovery, options, operation
    );
  commands = createNativeThreadTransitionCommandApplication(
    bindings,
    runTransition,
    (...args) => recovery.recoverBeforeMutation(...args)
  );
  recovery = createNativeThreadTransitionRecoveryApplication(
    bindings,
    commands.assertTargetExclusive
  );
  return Object.freeze({
    runNewThread: commands.runNewThread,
    runResumeThread: commands.runResumeThread,
    runReconcileBinding: commands.runReconcileBinding,
    verificationPorts: commands.verificationPorts,
    assertTerminalReady: commands.assertTerminalReady,
    recoverBeforeMutation: recovery.recoverBeforeMutation,
    reconcileLedger: recovery.reconcileLedger
  });
}

function createNativeThreadTransitionCommandApplication(
  bindings: NativeThreadTransitionBindings,
  runTransition: NativeThreadTransitionRunner,
  recoverBeforeMutation: NativeThreadTransitionApplication["recoverBeforeMutation"]
): NativeThreadTransitionCommandApplication {
  const {
    cliNow, cliCwd, cliSleep, runtimeLog, printJson,
    assertNativeThreadHasExclusiveOwnership, resolveLifecycleTerminal,
    lifecycleBindingTokens, storeDirFromOptions, terminalBridgeRuntimeDir,
    loadTerminalBridgeDispatchLedger,
    reconcilePreparedTerminalDispatchLedger,
    resolveTerminalDispatchLedgerPaneIncarnation,
    loadTerminalDispatchLedgerOwner, terminalListCliFacade,
    managedTurnsForSession, terminalWriterMutationLocks,
    mutationManagedSessions, createTerminalAgentBridge,
    loadClaudeAgentRows, agentVersionForRunningProcess,
    terminalRuntimeForLiveIdentity,
    resolveCurrentNativeAgentSessionIdentity,
    managedSessionClaimsResolvedTerminal,
    managedBindingConflictKindForResolvedTerminal
  } = bindings;

function assertTerminalLifecycleReady({
  options,
  terminal,
  terminalStatus
}: {
  options: NativeThreadTransitionCliOptions;
  terminal: TerminalDispatchTerminal;
  terminalStatus: BindingReconciliationStatusFacts;
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
    if (!owner || !isTerminalDispatchOwnerReleasedStatus(owner.status)) {
      throw new Error(
        `terminal ${terminal.terminalControl.target} still has a submitted operation`
      );
    }
  }
}

function nativeThreadVerificationAdapterPorts(
  options: NativeThreadTransitionCliOptions,
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

async function assertLifecycleTargetHasExclusiveOwnership({
  options,
  terminal,
  transition,
  storeDir
}: {
  options: NativeThreadTransitionCliOptions;
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

async function runNewThread(options) {
  const requireRestorableOrigin = options.requireRestorableOrigin;
  if (
    requireRestorableOrigin !== undefined &&
    requireRestorableOrigin !== true
  ) {
    throw new Error("--require-restorable-origin does not take a value");
  }
  return runTransition(options, {
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
    return runTransition(options, {
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
  return runTransition(selectedOptions, {
    kind: "resume_thread",
    nativeThreadId: selection.row.native_thread_id.toLowerCase(),
    selectionSnapshot: selection.snapshot
  });
}

async function runReconcileBinding(options: NativeThreadTransitionCliOptions) {
  const initiallyResolved = await resolveLifecycleTerminal(options);
  const resolvedByFacts = new WeakMap<
    BindingReconciliationTerminalFacts,
    ResolvedTerminalConversation
  >();
  const remember = (terminal: ResolvedTerminalConversation) => {
    const facts = bindingTerminalFacts(terminal);
    resolvedByFacts.set(facts, terminal);
    return facts;
  };
  const fullTerminal = (facts: BindingReconciliationTerminalFacts) =>
    required(
      resolvedByFacts.get(facts),
      "binding reconciliation terminal capability is unavailable"
    );
  const initialFacts = remember(initiallyResolved);
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
    initialTerminal: initialFacts,
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
        recoverBeforeMutation(
          scopes, resources, options, fullTerminal(terminal)
        ),
      loadSession: mutationManagedSessions.load,
      saveSession: mutationManagedSessions.save
    },
    terminal: {
      resolve: async () => remember(await resolveLifecycleTerminal(options)),
      sameIncarnation: terminalControlsShareIncarnation,
      identity: (facts) => resolveCurrentNativeAgentSessionIdentity({
        options,
        agent: facts.agent,
        pid: facts.pid,
        cwd: facts.terminalControl.currentPath
      }),
      prepareStatus: () => {
        const bridge = createTerminalAgentBridge(options);
        return async (facts: BindingReconciliationTerminalFacts) => {
          const terminal = fullTerminal(facts);
          const status = await bridge.status(
            terminal.agent,
            terminal.terminalControl,
            {
              runtime: terminalRuntimeForLiveIdentity({
                terminal,
                physicalOnly: true
              })
            }
          );
          return Object.freeze({
            reachable: status.reachable,
            activity_state: status.activity_state,
            activity_reason: status.activity_reason,
            approval_state: Object.freeze({
              blocked: status.approval_state.blocked
            })
          });
        };
      },
      assertReady: (facts, terminalStatus) => assertTerminalLifecycleReady({
        options,
        terminal: fullTerminal(facts),
        terminalStatus
      })
    },
    authority: {
      dispatchIsFree: (terminalControl) =>
        terminalListCliFacade.terminalDispatchOwnership(terminalControl).state === "none",
      sessionClaimsTerminal: managedSessionClaimsResolvedTerminal,
      terminalTokenMatches: (terminal, identity, token) =>
        lifecycleBindingTokens({
          terminal: fullTerminal(terminal),
          identity
        }).includes(token),
      hasUnresolvedTransition: (session) =>
        terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(storeDir, session),
      blockingTurn: (sessionId) => {
        const blocker = managedTurnsForSession(storeDir, sessionId)
          .find((turn) => isSessionSendBlockingStatus(turn.status));
        return blocker
          ? { turnId: turnIdForConversation(blocker), status: blocker.status }
          : undefined;
      },
      conflictKind: (session, terminal, identity) =>
        managedBindingConflictKindForResolvedTerminal({
          storeDir,
          session,
          terminal: fullTerminal(terminal),
          identity
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

  return Object.freeze({
    runNewThread, runResumeThread, runReconcileBinding,
    verificationPorts: nativeThreadVerificationAdapterPorts,
    assertTerminalReady: assertTerminalLifecycleReady,
    assertTargetExclusive: assertLifecycleTargetHasExclusiveOwnership
  });
}

function createNativeThreadTransitionRecoveryApplication(
  bindings: NativeThreadTransitionBindings,
  assertTargetExclusive: NativeThreadTransitionCommandApplication["assertTargetExclusive"]
): NativeThreadTransitionRecoveryApplication {
  const {
    cliNow, cliSleep, terminalRuntimeForLiveIdentity,
    resolveCurrentNativeAgentSessionIdentity,
    assertNativeThreadHasExclusiveOwnership,
    assertSameNativeInspectionTerminal, authenticateLifecycleRecoveryResources,
    createTerminalAgentBridge, loadClaudeAgentRows,
    loadTerminalBridgeDispatchLedger, saveLifecycleTerminalDispatchLedger,
    observedExternalHandoffIdentity,
    recoverDeferredCodexForegroundTransferWhileWriterLease,
    codexKnownRootSetForLifecycleTransition,
    codexProcessBirthForLifecycle, isProcessAlive,
    matchesConfiguredWorkspace, terminalDispatchRecordMatchesControl,
    agentVersionForRunningProcess, exactLifecycleProcessIdentity
  } = bindings;

async function freshLifecycleRecoveryTerminal(
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  options: NativeThreadTransitionCliOptions,
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
  options: NativeThreadTransitionCliOptions;
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
      ) => assertTargetExclusive({
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
  options: NativeThreadTransitionCliOptions,
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
  options: NativeThreadTransitionCliOptions,
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

  return Object.freeze({
    recoverBeforeMutation: recoverLifecycleFenceBeforeMutationScoped,
    reconcileLedger: reconcileLifecycleDispatchLedgerScoped
  });
}

function nativeThreadTransitionSettlementPorts(
  bindings: NativeThreadTransitionBindings,
  assertTargetExclusive: NativeThreadTransitionCommandApplication["assertTargetExclusive"],
  {
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
  options: NativeThreadTransitionCliOptions;
  operation: NativeThreadTransitionOperation;
  terminal: ResolvedTerminalConversation;
  storeDir: string;
  targetSession?: ManagedSessionState;
  targetSessionId: string;
  sourceBefore?: ManagedSessionState;
  beforeIdentity: NativeAgentSessionIdentity;
  verificationPorts: NativeThreadVerificationAdapterPorts;
  }
): NativeThreadTransitionSettlementPorts {
  const {
    saveLifecycleTerminalDispatchLedger, exactLifecycleProcessIdentity,
    cliCwd, cliNow, cliEnv, cliExit, textSummary, printJson
  } = bindings;
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
        assertTargetExclusive({
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
  bindings: NativeThreadTransitionBindings,
  commands: NativeThreadTransitionCommandApplication,
  recovery: NativeThreadTransitionRecoveryApplication,
  options: NativeThreadTransitionCliOptions,
  operation: NativeThreadTransitionOperation
): Promise<void> {
  const {
    resolveLifecycleTerminal, storeDirFromOptions,
    terminalWriterMutationLocks, cliNowMs, cliCwd,
    loadTerminalBridgeDispatchLedger, currentLifecycleSnapshot,
    nativeThreadLifecycleFacade, nativeThreadLifecycleQueryPorts,
    assertNativeThreadHasExclusiveOwnership,
    assertCodexComposerReadyForAutomatedInput,
    cliNow, cliPid, saveLifecycleTerminalDispatchLedger,
    managedTurnsForSession,
    managedSessionOwnerIsConclusivelyInactive, printJson,
    cliEnv, cliExit, exactLifecycleProcessIdentity
  } = bindings;
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
      await recovery.recoverBeforeMutation(
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
      const verificationPorts = commands.verificationPorts(
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
        plan: () => nativeThreadLifecycleFacade.agentAdapter(
          options,
          terminal.agent
        ).planThreadLifecycle?.(
          operation,
          snapshot.capabilities
        ),
        assertReady: (status) =>
          commands.assertTerminalReady({ options, terminal, terminalStatus: status }),
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
          ).filter((turn) => isSessionSendBlockingStatus(turn.status));
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

      const settlementPorts = nativeThreadTransitionSettlementPorts(
        bindings,
        commands.assertTargetExclusive,
        {
          options,
          operation,
          terminal,
          storeDir,
          targetSession,
          targetSessionId,
          sourceBefore,
          beforeIdentity,
          verificationPorts
        }
      );

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
