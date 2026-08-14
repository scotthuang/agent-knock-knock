import {
  isExactNativeThreadId,
  managedSessionRevision,
  nativeThreadCommandFingerprint,
  nativeThreadTransitionRevision,
  terminalBindingFrom,
  type ManagedSessionState,
  type NativeThreadTransition
} from "./managed-session.js";
import {
  classifyCodexLifecyclePostcondition
} from "./native-thread-lifecycle-policy.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import {
  terminalDispatchLedgerLooksLifecycle,
  type NativeThreadLifecycleLedgerPhase,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import type {
  CanonicalMutationResources,
  CanonicalMutationScopes
} from "./mutation-transaction.js";
import type {
  TerminalNativeIdentity as NativeAgentSessionIdentity,
  TerminalNativeIdentityFence as CodexCompanionIdentity
} from "./terminal-binding-authority.js";
import {
  terminalNativeIdentityFence as codexIdentityFence
} from "./terminal-binding-authority.js";
import { nonBlankString as stringValue } from "./value-guards.js";

type ScopeArgs = [CanonicalMutationScopes, CanonicalMutationResources];
type Scoped<Args extends unknown[], Result> =
  (...args: [...ScopeArgs, ...Args]) => Result;

const HUMAN_OBSERVED_HANDOFF_FINGERPRINT = nativeThreadCommandFingerprint(
  "adopt_external_thread:human_observed:no_terminal_input:v1"
);

export type NativeThreadLifecycleRecoveryAuthority =
  | { kind: "automatic" }
  | { kind: "manual"; expectedTransitionId: string };

export type NativeThreadLifecycleRecoveryTerminalFacts = Readonly<{
  conversationId: string;
  agent: NativeThreadTransition["agent"];
  pid: number;
  terminalControl: TerminalControlRef;
}>;

export type NativeThreadLifecycleRecoveryRequest = Readonly<{
  /** Fresh post-lock terminal facts; all effects remain capability-bound. */
  terminal: NativeThreadLifecycleRecoveryTerminalFacts;
}>;

export type NativeThreadLifecycleReconcileRequest =
  NativeThreadLifecycleRecoveryRequest & Readonly<{
    ledger: TerminalDispatchLedgerDocument;
    authority?: NativeThreadLifecycleRecoveryAuthority;
  }>;

export interface CodexCompanionSet {
  primary?: CodexCompanionIdentity;
  additional: CodexCompanionIdentity[];
}

export type NativeThreadLifecycleOperation =
  | Readonly<{ kind: "new_thread" }>
  | Readonly<{ kind: "resume_thread"; nativeThreadId: string }>;

export type NativeThreadLifecycleCapabilityFacts = Readonly<{
  status: "supported" | "unsupported" | "unknown";
}>;

export type NativeThreadLifecyclePlanFacts = Readonly<{
  steps: readonly Readonly<{
    kind: string;
    command: string;
    effect: string;
    requiresIdle: true;
  }>[];
}>;

export type NativeThreadLifecycleObservationFacts = Readonly<{
  status: "observed" | "verified" | "missing" | "ambiguous" | "mismatch";
  nativeThreadId?: string;
  evidence?: string;
  idle?: boolean;
  reason?: string;
}>;

export type NativeThreadLifecycleProbeContext =
  | Readonly<{ kind: "physical" }>
  | Readonly<{
      kind: "codex_recovery";
      processUuid: string;
      processBirth: string | undefined;
      expectedSessionId: string;
      companions: CodexCompanionSet;
    }>;

export type NativeThreadLifecycleStatusFacts = Readonly<{
  reachable: boolean;
  activityState: "awaiting_approval" | "working" | "idle" | "unknown";
  approvalBlocked: boolean;
  composerVisible: boolean;
  composerEmpty: boolean;
  screenDigest?: string;
}>;

export type NativeThreadLifecycleStatusProbeFacts = Readonly<{
  observationBaselineDigest: string;
  observationScrollbackLines: number;
}>;

export type NativeThreadLifecycleObservationRequest =
  | Readonly<{
      kind: "claude_agents";
      operation: NativeThreadLifecycleOperation;
      pid: number;
      processStartedAt: number;
      cwd: string;
    }>
  | Readonly<{
      kind: "codex_status";
      operation: NativeThreadLifecycleOperation;
      context: Extract<
        NativeThreadLifecycleProbeContext,
        { kind: "codex_recovery" }
      >;
      observationBaselineDigest: string;
      observationScrollbackLines: number;
    }>;

export type NativeThreadLifecycleObservationResult =
  | Readonly<{
      kind: "claude_agents";
      observation: NativeThreadLifecycleObservationFacts | undefined;
    }>
  | Readonly<{
      kind: "codex_status";
      status: NativeThreadLifecycleStatusFacts;
      observation: NativeThreadLifecycleObservationFacts | undefined;
    }>;

type LedgerExpectation = Readonly<{
  expectedTransitionId: string | null;
  expectedStatus?: "prepared" | "dispatching" | "submitted";
}>;

export type NativeThreadLifecycleRecoveryPorts = Readonly<{
  authority: Readonly<{
    bind: Scoped<[], Readonly<{
      terminalControl: TerminalControlRef;
    }>>;
  }>;
  persistence: Readonly<{
    listNativeThreadTransitions: Scoped<[], readonly NativeThreadTransition[]>;
    loadManagedSession: Scoped<[string], ManagedSessionState>;
    tryLoadManagedSession: Scoped<[string], ManagedSessionState | undefined>;
    loadNativeThreadTransition: Scoped<[string], NativeThreadTransition>;
    saveManagedSession: Scoped<[
      ManagedSessionState,
      Readonly<{ expectedRevision: number | null }>
    ], ManagedSessionState>;
    saveNativeThreadTransition: Scoped<[
      NativeThreadTransition,
      Readonly<{ expectedRevision: number | null }>
    ], NativeThreadTransition>;
    commitVerified: Scoped<[NativeThreadTransition, string], ManagedSessionState>;
    loadLedger: Scoped<[], TerminalDispatchLedgerDocument | undefined>;
    buildLedger: Scoped<[
      NativeThreadTransition,
      NativeThreadLifecycleLedgerPhase
    ], TerminalDispatchLedgerDocument>;
    saveLedger: Scoped<[
      NativeThreadTransition,
      NativeThreadLifecycleLedgerPhase,
      LedgerExpectation
    ], void>;
    saveFailClosedLedger: Scoped<[
      TerminalDispatchLedgerDocument,
      string,
      string,
      string
    ], void>;
  }>;
  terminal: Readonly<{
    recoverDeferred: Scoped<[], Promise<void>>;
    sameTerminalIncarnation: Scoped<[TerminalControlRef], boolean>;
    aliasMatches: Scoped<[unknown, unknown, unknown], boolean>;
    workspaceMatches: Scoped<[unknown], boolean>;
    resolveIdentity: Scoped<[
      string | undefined,
      CodexCompanionSet
    ], Promise<NativeAgentSessionIdentity | undefined>>;
    observeExternalHandoff: Scoped<[
      ManagedSessionState,
      NativeAgentSessionIdentity | undefined
    ], Promise<NativeAgentSessionIdentity | undefined>>;
    assertExclusive: Scoped<[string, string | undefined], Promise<void>>;
    assertTargetExclusive: Scoped<[NativeThreadTransition], Promise<void>>;
    exactIdentity: Scoped<[
      NativeAgentSessionIdentity
    ], NativeAgentSessionIdentity>;
    isProcessAlive: Scoped<[number], boolean>;
    recordedStoreMatches: Scoped<[string], boolean>;
    recordMatchesControl: Scoped<[TerminalDispatchLedgerDocument], boolean>;
    runningVersion: Scoped<[], string | undefined>;
    probeThreadLifecycle: Scoped<[
      string | undefined
    ], NativeThreadLifecycleCapabilityFacts | undefined>;
    planThreadLifecycle: Scoped<[
      NativeThreadLifecycleOperation,
      NativeThreadLifecycleCapabilityFacts
    ], NativeThreadLifecyclePlanFacts | undefined>;
    observeThreadLifecycle: Scoped<[
      NativeThreadLifecycleObservationRequest
    ], Promise<NativeThreadLifecycleObservationResult>>;
    prepareProbeBridge: Scoped<[], void>;
    status: Scoped<[
      NativeThreadLifecycleProbeContext,
      number | undefined
    ], Promise<NativeThreadLifecycleStatusFacts>>;
    clearInputLine: Scoped<[NativeThreadLifecycleProbeContext], Promise<void>>;
    submitCodexStatusProbe: Scoped<[
      string,
      Extract<NativeThreadLifecycleProbeContext, { kind: "codex_recovery" }>
    ], Promise<NativeThreadLifecycleStatusProbeFacts>>;
    assertResumedCodexCandidate: Scoped<[
      NativeAgentSessionIdentity,
      NativeThreadTransition["target_candidate_file_identity"]
    ], void>;
    codexKnownRoots: Scoped<[NativeThreadTransition], CodexCompanionSet>;
    codexCompanionsExcludingPreferred: Scoped<[
      CodexCompanionSet,
      string
    ], CodexCompanionSet>;
    codexProcessBirth: Scoped<[], string>;
    nativeIdentityMatches: Scoped<[
      NativeAgentSessionIdentity | undefined,
      CodexCompanionIdentity | undefined
    ], boolean>;
  }>;
  runtime: Readonly<{
    now(): Date;
    sleep(milliseconds: number): Promise<void>;
  }>;
}>;

interface NativeThreadLifecycleAdapter {
  terminal: {
    sameTerminalIncarnation(right: TerminalControlRef): boolean;
    recoverDeferred(): Promise<void>;
    aliasMatches(storedTerminalId: unknown, storedControl: unknown, currentTerminalId: unknown): boolean;
    workspaceMatches(expected: unknown): boolean;
    resolveIdentity(preferredSessionId: string | undefined, companions: CodexCompanionSet): Promise<NativeAgentSessionIdentity | undefined>;
    observeExternalHandoff(source: ManagedSessionState, resolved: NativeAgentSessionIdentity | undefined): Promise<NativeAgentSessionIdentity | undefined>;
    assertExclusive(nativeThreadId: string, excludedSessionId?: string): Promise<void>;
    assertTargetExclusive(transition: NativeThreadTransition): Promise<void>;
    exactIdentity(identity: NativeAgentSessionIdentity): NativeAgentSessionIdentity;
    isProcessAlive(pid: number): boolean;
    recordedStoreMatches(recordedStoreDir: string): boolean;
    recordMatchesControl(ledger: TerminalDispatchLedgerDocument): boolean;
    runningVersion(): string | undefined;
    probeThreadLifecycle(agentVersion: string | undefined): NativeThreadLifecycleCapabilityFacts | undefined;
    planThreadLifecycle(operation: NativeThreadLifecycleOperation, capability: NativeThreadLifecycleCapabilityFacts): NativeThreadLifecyclePlanFacts | undefined;
    observeThreadLifecycle(request: NativeThreadLifecycleObservationRequest): Promise<NativeThreadLifecycleObservationResult>;
    prepareProbeBridge(): void;
    status(context: NativeThreadLifecycleProbeContext, scrollbackLines?: number): Promise<NativeThreadLifecycleStatusFacts>;
    clearInputLine(context: NativeThreadLifecycleProbeContext): Promise<void>;
    submitCodexStatusProbe(agentVersion: string, context: Extract<NativeThreadLifecycleProbeContext, { kind: "codex_recovery" }>): Promise<NativeThreadLifecycleStatusProbeFacts>;
    assertResumedCodexCandidate(identity: NativeAgentSessionIdentity, expected: NativeThreadTransition["target_candidate_file_identity"]): void;
    codexKnownRoots(transition: NativeThreadTransition): CodexCompanionSet;
    codexCompanionsExcludingPreferred(roots: CodexCompanionSet, preferredSessionId: string): CodexCompanionSet;
    codexProcessBirth(): string;
    nativeIdentityMatches(identity: NativeAgentSessionIdentity | undefined, expected: CodexCompanionIdentity | undefined): boolean;
  };
  repository: {
    listNativeThreadTransitions(): readonly NativeThreadTransition[];
    loadManagedSession(id: string): ManagedSessionState;
    tryLoadManagedSession(id: string): ManagedSessionState | undefined;
    loadNativeThreadTransition(id: string): NativeThreadTransition;
    saveManagedSession(state: ManagedSessionState, expectation: Readonly<{ expectedRevision: number | null }>): ManagedSessionState;
    saveNativeThreadTransition(transition: NativeThreadTransition, expectation: Readonly<{ expectedRevision: number | null }>): NativeThreadTransition;
    commitVerified(transition: NativeThreadTransition, at: string): ManagedSessionState;
  };
  ledger: {
    load(): TerminalDispatchLedgerDocument | undefined;
    build(transition: NativeThreadTransition, phase: NativeThreadLifecycleLedgerPhase): TerminalDispatchLedgerDocument;
    save(transition: NativeThreadTransition, phase: NativeThreadLifecycleLedgerPhase, expectation: LedgerExpectation): void;
    saveFailClosed(ledger: TerminalDispatchLedgerDocument, transitionId: string, now: string, reason: string): void;
  };
  runtime: NativeThreadLifecycleRecoveryPorts["runtime"];
}

function bindRecoveryPorts(
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  ports: NativeThreadLifecycleRecoveryPorts
): Readonly<{
  terminalControl: TerminalControlRef;
  ports: NativeThreadLifecycleAdapter;
}> {
  const authority = ports.authority.bind(scopes, resources);
  const repository = ports.persistence;
  const terminal = ports.terminal;
  return {
    ...authority,
    ports: {
      repository: {
        listNativeThreadTransitions: () => repository.listNativeThreadTransitions(scopes, resources),
        loadManagedSession: (id) => repository.loadManagedSession(scopes, resources, id),
        tryLoadManagedSession: (id) => repository.tryLoadManagedSession(scopes, resources, id),
        loadNativeThreadTransition: (id) => repository.loadNativeThreadTransition(scopes, resources, id),
        saveManagedSession: (state, expectation) => repository.saveManagedSession(scopes, resources, state, expectation),
        saveNativeThreadTransition: (transition, expectation) => repository.saveNativeThreadTransition(scopes, resources, transition, expectation),
        commitVerified: (transition, at) => repository.commitVerified(scopes, resources, transition, at)
      },
      ledger: {
        load: () => repository.loadLedger(scopes, resources),
        build: (transition, phase) => repository.buildLedger(scopes, resources, transition, phase),
        save: (transition, phase, expectation) => repository.saveLedger(scopes, resources, transition, phase, expectation),
        saveFailClosed: (ledger, transitionId, now, reason) => repository.saveFailClosedLedger(scopes, resources, ledger, transitionId, now, reason)
      },
      terminal: {
        sameTerminalIncarnation: (right) => terminal.sameTerminalIncarnation(scopes, resources, right),
        recoverDeferred: () => terminal.recoverDeferred(scopes, resources),
        aliasMatches: (storedId, storedControl, currentId) => terminal.aliasMatches(scopes, resources, storedId, storedControl, currentId),
        workspaceMatches: (expected) => terminal.workspaceMatches(scopes, resources, expected),
        resolveIdentity: (preferred, companions) => terminal.resolveIdentity(scopes, resources, preferred, companions),
        observeExternalHandoff: (source, resolved) => terminal.observeExternalHandoff(scopes, resources, source, resolved),
        assertExclusive: (nativeThreadId, excluded) => terminal.assertExclusive(scopes, resources, nativeThreadId, excluded),
        assertTargetExclusive: (transition) => terminal.assertTargetExclusive(scopes, resources, transition),
        exactIdentity: (identity) => terminal.exactIdentity(scopes, resources, identity),
        isProcessAlive: (pid) => terminal.isProcessAlive(scopes, resources, pid),
        recordedStoreMatches: (recorded) => terminal.recordedStoreMatches(scopes, resources, recorded),
        recordMatchesControl: (ledger) => terminal.recordMatchesControl(scopes, resources, ledger),
        runningVersion: () => terminal.runningVersion(scopes, resources),
        probeThreadLifecycle: (version) =>
          terminal.probeThreadLifecycle(scopes, resources, version),
        planThreadLifecycle: (operation, capability) =>
          terminal.planThreadLifecycle(
            scopes,
            resources,
            operation,
            capability
          ),
        observeThreadLifecycle: (request) =>
          terminal.observeThreadLifecycle(scopes, resources, request),
        prepareProbeBridge: () => terminal.prepareProbeBridge(scopes, resources),
        status: (context, scrollbackLines) => terminal.status(
          scopes,
          resources,
          context,
          scrollbackLines
        ),
        clearInputLine: (context) => terminal.clearInputLine(
          scopes,
          resources,
          context
        ),
        submitCodexStatusProbe: (version, context) =>
          terminal.submitCodexStatusProbe(
            scopes,
            resources,
            version,
            context
          ),
        assertResumedCodexCandidate: (identity, expected) => terminal.assertResumedCodexCandidate(scopes, resources, identity, expected),
        codexKnownRoots: (transition) => terminal.codexKnownRoots(scopes, resources, transition),
        codexCompanionsExcludingPreferred: (roots, preferred) => terminal.codexCompanionsExcludingPreferred(scopes, resources, roots, preferred),
        codexProcessBirth: () => terminal.codexProcessBirth(scopes, resources),
        nativeIdentityMatches: (identity, expected) => terminal.nativeIdentityMatches(scopes, resources, identity, expected)
      },
      runtime: ports.runtime
    }
  };
}

function saveLifecycleSession(
  ports: NativeThreadLifecycleAdapter,
  state: ManagedSessionState,
  expectedRevision: number | null
): ManagedSessionState {
  return ports.repository.saveManagedSession(state, { expectedRevision });
}

function saveLifecycleTransition(
  ports: NativeThreadLifecycleAdapter,
  transition: NativeThreadTransition,
  expectedRevision: number | null
): NativeThreadTransition {
  return ports.repository.saveNativeThreadTransition(
    transition,
    { expectedRevision }
  );
}

export async function recoverLifecycleFenceBeforeMutation(
  request: NativeThreadLifecycleRecoveryRequest,
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  recoveryPorts: NativeThreadLifecycleRecoveryPorts
): Promise<void> {
  const bound = bindRecoveryPorts(scopes, resources, recoveryPorts);
  return recoverLifecycleFenceBeforeMutationBound(
    request.terminal,
    bound.terminalControl,
    bound.ports
  );
}

async function recoverLifecycleFenceBeforeMutationBound(
  terminal: NativeThreadLifecycleRecoveryTerminalFacts,
  terminalControl: TerminalControlRef,
  ports: NativeThreadLifecycleAdapter
): Promise<void> {
  if (terminal.terminalControl !== terminalControl) {
    terminal = { ...terminal, terminalControl };
  }
  await ports.terminal.recoverDeferred();
  let ledger = ports.ledger.load();
  if (!ledger || ledger.status === "resolved") {
    ledger = rebuildObservedHandoffLedgerFromTransition({
      terminal,
      previousLedger: ledger,
      ports
    });
    if (!ledger) {
      return;
    }
  }
  if (!terminalDispatchLedgerLooksLifecycle(ledger)) {
    return;
  }
  if (ledger.kind !== "lifecycle") {
    throw new Error(
      `terminal ${terminal.terminalControl.target} has a malformed lifecycle ` +
      "dispatch fence; no Session or Turn was created and manual recovery is required"
    );
  }
  const recovered = await reconcileLifecycleDispatchLedgerBound({
    terminalControl,
    terminal,
    ledger
  }, ports);
  if (recovered.status !== "resolved") {
    throw new Error(
      `terminal ${terminal.terminalControl.target} has unresolved lifecycle ` +
      `transition ${stringValue(recovered.transition_id) ?? "with invalid identity"} ` +
      `(${String(recovered.status)}: ` +
      `${stringValue(recovered.reason) ?? "recovery evidence unavailable"}); ` +
      "refresh AKK list and use its exact " +
      "expected-transition-id recovery action"
    );
  }
}

function rebuildObservedHandoffLedgerFromTransition({
  terminal,
  previousLedger,
  ports
}: {
  terminal: NativeThreadLifecycleRecoveryTerminalFacts;
  previousLedger?: TerminalDispatchLedgerDocument;
  ports: NativeThreadLifecycleAdapter;
}): TerminalDispatchLedgerDocument | undefined {
  const candidates = ports.repository.listNativeThreadTransitions().filter(
    (transition) =>
      transition.operation === "adopt_external_thread" &&
      transition.origin === "human_observed" &&
      transition.terminal_input_sent === false &&
      ["prepared", "verified"].includes(transition.status) &&
      transition.agent === terminal.agent &&
      transition.before_binding?.native_process.pid === terminal.pid &&
      ports.terminal.aliasMatches(
        transition.terminal_id,
        transition.before_binding?.terminal_control,
        terminal.conversationId
      ) &&
      ports.terminal.workspaceMatches(
        transition.workspace
      )
  );
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length !== 1) {
    throw new Error(
      `terminal ${terminal.terminalControl.target} has multiple unresolved ` +
      "human-observed handoff transitions; refusing to infer one ledger owner"
    );
  }
  const transition = candidates[0];
  if (
    previousLedger?.status === "resolved" &&
    stringValue(previousLedger.transition_id) === transition.transition_id
  ) {
    throw new Error(
      `human-observed handoff transition ${transition.transition_id} is ` +
      "unresolved but its terminal ledger is already resolved"
    );
  }
  const rebuilt = ports.ledger.build(transition, {
    phase: "rebuild",
    control: terminal.terminalControl,
    previous: previousLedger
  });
  // Validate the complete transition/terminal/adapter relationship before
  // replacing a missing or older resolved ledger.  Rebuilding a fence is a
  // Store-side recovery operation only and never sends terminal input.
  assertLifecycleLedgerMatchesTransition({
    terminal,
    ledger: rebuilt,
    transition,
    ports
  });
  ports.ledger.save(transition, {
    phase: "rebuild",
    control: terminal.terminalControl,
    previous: previousLedger
  }, { expectedTransitionId: null });
  return ports.ledger.load();
}

async function recoverPreparedObservedHandoff({
  terminal,
  ledger,
  transition,
  now,
  ports
}: {
  terminal: NativeThreadLifecycleRecoveryTerminalFacts;
  ledger: TerminalDispatchLedgerDocument;
  transition: NativeThreadTransition;
  now: string;
  ports: NativeThreadLifecycleAdapter;
}): Promise<NativeThreadTransition> {
  if (
    transition.operation !== "adopt_external_thread" ||
    transition.status !== "prepared" ||
    ledger.status !== "prepared" ||
    !transition.source_session_id ||
    transition.source_expected_revision === undefined ||
    !transition.before_binding ||
    !transition.target_native_thread_id
  ) {
    return transition;
  }
  let source = ports.repository.loadManagedSession(transition.source_session_id);
  if (
    source.status === "bound" &&
    source.revision === transition.source_expected_revision &&
    JSON.stringify(source.binding) === JSON.stringify(transition.before_binding)
  ) {
    source = saveLifecycleSession(ports, {
      ...source,
      status: "transitioning",
      last_transition_id: transition.transition_id,
      updated_at: now
    }, managedSessionRevision(source));
  } else if (
    source.status !== "transitioning" ||
    source.last_transition_id !== transition.transition_id ||
    source.revision !== transition.source_expected_revision + 1 ||
    JSON.stringify(source.binding) !== JSON.stringify(transition.before_binding)
  ) {
    throw new Error("human-observed handoff source changed before recovery");
  }
  const before = transition.before_binding;
  const resolved = await ports.terminal.resolveIdentity(
    transition.target_native_thread_id,
    { primary: codexIdentityFence({
      sessionId: transition.before_native_thread_id,
      processUuid: transition.before_process_uuid,
      processBirth: transition.before_process_birth,
      rollout: transition.before_process_rollout,
      evidence: before.native_process.evidence
    }), additional: [] }
  );
  const observed = await ports.terminal.observeExternalHandoff(source, resolved);
  const liveId = observed?.sessionId.toLowerCase();
  if (liveId === transition.before_native_thread_id.toLowerCase()) {
    transition = saveLifecycleTransition(ports, {
      ...transition,
      status: "aborted",
      aborted_at: now,
      error: "recovery observed the exact source native thread"
    }, nativeThreadTransitionRevision(transition));
    restorePreparedLifecycleSource(transition, now, ports);
    ports.ledger.save(transition, {
      phase: "resolved",
      at: now,
      reason: "human-observed handoff rolled back to its exact source"
    }, { expectedTransitionId: transition.transition_id });
    return transition;
  }
  if (
    !observed ||
    liveId !== transition.target_native_thread_id.toLowerCase()
  ) {
    throw new Error(
      "human-observed handoff recovery found neither its exact source nor target"
    );
  }
  const target = ports.repository.tryLoadManagedSession(transition.target_session_id);
  if ((target?.revision ?? null) !== transition.target_expected_revision) {
    throw new Error("human-observed handoff target changed before recovery");
  }
  await ports.terminal.assertExclusive(
    transition.target_native_thread_id,
    target?.session_id
  );
  const exact = ports.terminal.exactIdentity(observed);
  const afterBinding = terminalBindingFrom({
    terminalId: terminal.conversationId,
    terminalControl: terminal.terminalControl,
    pid: terminal.pid,
    nativeThreadId: transition.target_native_thread_id,
    processUuid: exact.processUuid,
    processBirth: exact.processBirth,
    rollout: exact.rollout,
    evidence: `${exact.evidence}+human_observed_recovery`,
    generation: (target?.binding?.generation ?? 0) + 1,
    now: new Date(now)
  });
  transition = saveLifecycleTransition(ports, {
    ...transition,
    status: "verified",
    verified_at: now,
    after_binding: afterBinding
  }, nativeThreadTransitionRevision(transition));
  ports.ledger.save(transition, {
    phase: "verified",
    binding: before
  }, {
    expectedTransitionId: transition.transition_id,
    expectedStatus: "prepared"
  });
  return transition;
}

export async function reconcileLifecycleDispatchLedger(
  request: NativeThreadLifecycleReconcileRequest,
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  recoveryPorts: NativeThreadLifecycleRecoveryPorts
): Promise<TerminalDispatchLedgerDocument> {
  const bound = bindRecoveryPorts(scopes, resources, recoveryPorts);
  return reconcileLifecycleDispatchLedgerBound({
    terminalControl: bound.terminalControl,
    terminal: request.terminal,
    ledger: request.ledger,
    authority: request.authority
  }, bound.ports);
}

async function reconcileLifecycleDispatchLedgerBound(
  request: Readonly<{
    terminalControl: TerminalControlRef;
    terminal: NativeThreadLifecycleRecoveryTerminalFacts;
    ledger: TerminalDispatchLedgerDocument;
    authority?: NativeThreadLifecycleRecoveryAuthority;
  }>,
  ports: NativeThreadLifecycleAdapter
): Promise<TerminalDispatchLedgerDocument> {
  const {
    terminalControl,
    ledger: initialLedger,
    authority = { kind: "automatic" }
  } = request;
  let { terminal } = request;
  let ledger = initialLedger;
  if (terminal.terminalControl !== terminalControl) terminal = { ...terminal, terminalControl };
  if (ledger.status === "resolved") {
    return ledger;
  }
  const dispatcherPid = Number(ledger.dispatcher_pid);
  if (
    authority.kind === "automatic" &&
    Number.isSafeInteger(dispatcherPid) &&
    dispatcherPid > 1 &&
    ports.terminal.isProcessAlive(dispatcherPid)
  ) {
    return ledger;
  }
  const recordedStoreDir = stringValue(ledger.store_dir);
  const transitionId = stringValue(ledger.transition_id);
  if (
    !recordedStoreDir ||
    !transitionId ||
    stringValue(ledger.generation_id) !== transitionId ||
    (
      authority.kind === "manual" &&
      authority.expectedTransitionId !== transitionId
    )
  ) {
    return ledger;
  }
  if (!ports.terminal.recordedStoreMatches(recordedStoreDir)) {
    return failClosedLifecycleLedger({
      ledger,
      ports,
      reason: "native thread transition belongs to another Store"
    });
  }
  let transition: NativeThreadTransition;
  try {
    transition = ports.repository.loadNativeThreadTransition(transitionId);
  } catch (error) {
    return failClosedLifecycleLedger({
      ledger,
      ports,
      reason:
        `native thread transition state is unavailable: ` +
        `${error instanceof Error ? error.message : String(error)}`
    });
  }
  const now = ports.runtime.now().toISOString();
  try {
    assertLifecycleLedgerMatchesTransition({
      terminal,
      ledger,
      transition,
      ports
    });
    if (
      transition.operation === "adopt_external_thread" &&
      transition.status === "verified" &&
      ledger.status === "prepared"
    ) {
      ports.ledger.save(transition, {
        phase: "verified_with_previous",
        binding: transition.before_binding,
        previousGenerationId: stringValue(ledger.previous_generation_id)
      }, {
        expectedTransitionId: transition.transition_id,
        expectedStatus: "prepared"
      });
      ledger = ports.ledger.load() as TerminalDispatchLedgerDocument;
    }
    if (
      transition.operation === "adopt_external_thread" &&
      transition.status === "prepared"
    ) {
      transition = await recoverPreparedObservedHandoff({
        terminal,
        ledger,
        transition,
        now,
        ports
      });
      if (["aborted", "committed"].includes(transition.status)) {
        return ports.ledger.load() as TerminalDispatchLedgerDocument;
      }
    }
    if (transition.status === "prepared" && ledger.status === "prepared") {
      await ports.terminal.assertExclusive(
        transition.before_native_thread_id,
        transition.source_session_id
      );
      restorePreparedLifecycleSource(transition, now, ports);
      transition = saveLifecycleTransition(ports, {
        ...transition,
        status: "aborted",
        aborted_at: now,
        error: "dispatcher exited before lifecycle input began"
      }, nativeThreadTransitionRevision(transition));
      ports.ledger.save(transition, {
        phase: "resolved",
        at: now,
        reason:
          "lifecycle dispatcher exited while durably prepared; no terminal input was possible"
      }, { expectedTransitionId: transitionId });
      return ports.ledger.load() as TerminalDispatchLedgerDocument;
    }
    if (transition.status === "verified") {
      await verifyRecoveredLifecycleAfterBinding({
        terminal,
        transition,
        ports
      });
      await ports.terminal.assertTargetExclusive(transition);
      const savedTarget = ports.repository.commitVerified(transition, now);
      transition = saveLifecycleTransition(ports, {
        ...transition,
        status: "committed",
        committed_at: now
      }, nativeThreadTransitionRevision(transition));
      ports.ledger.save(transition, {
        phase: "resolved_with_binding",
        at: now,
        binding: savedTarget.binding,
        reason: "revalidated and rolled forward a verified native thread transition"
      }, { expectedTransitionId: transitionId });
      return ports.ledger.load() as TerminalDispatchLedgerDocument;
    }
    if (transition.status === "committed") {
      await verifyRecoveredLifecycleAfterBinding({
        terminal,
        transition,
        ports
      });
      await ports.terminal.assertTargetExclusive(transition);
      assertCommittedLifecycleTarget(transition, ports);
      ports.ledger.save(transition, {
        phase: "resolved_with_binding",
        at: now,
        binding: transition.after_binding,
        reason: "revalidated an already committed native thread transition"
      }, { expectedTransitionId: transitionId });
      return ports.ledger.load() as TerminalDispatchLedgerDocument;
    }
    if (transition.status === "aborted") {
      await ports.terminal.assertExclusive(
        transition.before_native_thread_id,
        transition.source_session_id
      );
      restorePreparedLifecycleSource(transition, now, ports);
      ports.ledger.save(transition, {
        phase: "resolved",
        at: now,
        reason: "native thread transition is already aborted"
      }, { expectedTransitionId: transitionId });
      return ports.ledger.load() as TerminalDispatchLedgerDocument;
    }
    if (["dispatching", "submitted"].includes(transition.status)) {
      transition = saveLifecycleTransition(ports, {
        ...transition,
        status: "uncertain",
        uncertain_at: now,
        error:
          "lifecycle dispatcher exited after terminal input may have started",
        do_not_retry: true
      }, nativeThreadTransitionRevision(transition));
    }
    if (transition.status === "uncertain" && authority.kind === "manual") {
      return await reconcileUncertainLifecycleTransition({
        terminal,
        ledger,
        transition,
        now,
        ports
      });
    }
    quarantineLifecycleSource(transition, now,
      ports,
      "native thread lifecycle dispatcher exited after terminal input may have started");
    ports.ledger.save(transition, {
      phase: "uncertain",
      at: transition.uncertain_at ?? now,
      reason:
        "lifecycle dispatcher exited after terminal input may have started"
    }, { expectedTransitionId: transitionId });
    return ports.ledger.load() as TerminalDispatchLedgerDocument;
  } catch (error) {
    quarantineLifecycleSource(transition, now,
      ports,
      "native thread lifecycle recovery evidence did not match the live terminal");
    return failClosedLifecycleLedger({
      ledger,
      ports,
      reason:
        `native thread lifecycle recovery failed closed: ` +
        `${error instanceof Error ? error.message : String(error)}`
    });
  }
}

function assertLifecycleLedgerMatchesTransition({
  terminal,
  ledger,
  transition,
  ports
}: {
  terminal: NativeThreadLifecycleRecoveryTerminalFacts;
  ledger: TerminalDispatchLedgerDocument;
  transition: NativeThreadTransition;
  ports: NativeThreadLifecycleAdapter;
}): void {
  if (
    lifecycleLedgerStoredFactsDisagree(ledger, transition) ||
    terminal.agent !== transition.agent ||
    !ports.terminal.recordMatchesControl(ledger) ||
    terminal.pid !== transition.before_binding?.native_process.pid &&
      transition.before_binding !== undefined ||
    !ports.terminal.sameTerminalIncarnation(
      transition.before_binding?.terminal_control ?? terminal.terminalControl
    ) ||
    (
      transition.before_binding !== undefined &&
      !ports.terminal.aliasMatches(
        transition.terminal_id,
        transition.before_binding.terminal_control,
        terminal.conversationId
      )
    ) ||
    !ports.terminal.workspaceMatches(transition.workspace) ||
    JSON.stringify(ledger.binding ?? null) !==
      JSON.stringify(transition.before_binding ?? null)
  ) {
    throw new Error("lifecycle ledger, transition, and live terminal identities disagree");
  }
  const currentVersion = ports.terminal.runningVersion();
  const capability = ports.terminal.probeThreadLifecycle(currentVersion);
  if (transition.operation === "adopt_external_thread") {
    if (
      currentVersion !== transition.adapter_version ||
      capability?.status !== "supported" ||
      transition.origin !== "human_observed" ||
      transition.terminal_input_sent !== false ||
      transition.command_fingerprint !== HUMAN_OBSERVED_HANDOFF_FINGERPRINT
    ) {
      throw new Error(
        "human-observed handoff adapter profile changed during recovery"
      );
    }
    return;
  }
  const operation = transition.operation === "resume_thread"
    ? {
        kind: "resume_thread" as const,
        nativeThreadId: transition.target_native_thread_id as string
      }
    : { kind: "new_thread" as const };
  const plan = capability?.status === "supported"
    ? ports.terminal.planThreadLifecycle(operation, capability)
    : undefined;
  if (
    currentVersion !== transition.adapter_version ||
    !plan ||
    nativeThreadCommandFingerprint(JSON.stringify(plan.steps)) !==
      transition.command_fingerprint
  ) {
    throw new Error("lifecycle adapter version or command plan changed during recovery");
  }
}

function lifecycleLedgerStoredFactsDisagree(
  ledger: TerminalDispatchLedgerDocument,
  transition: NativeThreadTransition
): boolean {
  const operationTarget = transition.operation === "new_thread"
    ? undefined
    : transition.target_native_thread_id;
  const allowedLedgerStatuses: Record<
    NativeThreadTransition["status"],
    readonly string[]
  > = {
    prepared: ["prepared", "uncertain"],
    dispatching: ["prepared", "dispatching", "uncertain"],
    submitted: ["dispatching", "submitted", "uncertain"],
    uncertain: ["dispatching", "submitted", "uncertain"],
    verified: transition.operation === "adopt_external_thread"
      ? ["prepared", "verified", "uncertain"]
      : ["submitted", "verified", "uncertain"],
    committed: transition.operation === "adopt_external_thread"
      ? ["verified", "uncertain"]
      : ["submitted", "verified", "uncertain"],
    aborted: transition.reconciled_outcome === "before"
      ? ["dispatching", "submitted", "uncertain"]
      : ["prepared", "dispatching"]
  };
  return (
    ledger.kind !== "lifecycle" ||
    stringValue(ledger.transition_id) !== transition.transition_id ||
    stringValue(ledger.generation_id) !== transition.transition_id ||
    stringValue(ledger.operation) !== transition.operation ||
    stringValue(ledger.origin) !== transition.origin ||
    ledger.terminal_input_sent !== transition.terminal_input_sent ||
    stringValue(ledger.terminal_id) !== transition.terminal_id ||
    stringValue(ledger.agent) !== transition.agent ||
    stringValue(ledger.workspace) !== transition.workspace ||
    stringValue(ledger.source_session_id) !== transition.source_session_id ||
    stringValue(ledger.target_session_id) !== transition.target_session_id ||
    stringValue(ledger.target_native_thread_id) !== operationTarget ||
    JSON.stringify(ledger.target_candidate_file_identity ?? null) !==
      JSON.stringify(transition.target_candidate_file_identity ?? null) ||
    stringValue(ledger.before_native_thread_id) !==
      transition.before_native_thread_id ||
    !isExactNativeThreadId(transition.before_native_thread_id) ||
    stringValue(ledger.before_process_uuid) !==
      transition.before_process_uuid ||
    (
      ledger.before_process_started_at === undefined
        ? undefined
        : Number(ledger.before_process_started_at)
    ) !== transition.before_process_started_at ||
    stringValue(ledger.before_process_birth) !==
      transition.before_process_birth ||
    JSON.stringify(ledger.before_process_rollout ?? null) !==
      JSON.stringify(transition.before_process_rollout ?? null) ||
    Number(ledger.dispatcher_pid) !== transition.dispatcher_pid ||
    stringValue(ledger.prepared_at) !== transition.prepared_at ||
    !allowedLedgerStatuses[transition.status].includes(String(ledger.status)) ||
    (
      transition.status === "aborted" &&
      transition.reconciled_outcome === undefined &&
      !["prepared", "dispatching"].includes(String(ledger.status))
    ) ||
    stringValue(ledger.adapter_version) !== transition.adapter_version ||
    stringValue(ledger.command_fingerprint) !== transition.command_fingerprint
  );
}

async function verifyRecoveredLifecycleAfterBinding({
  terminal,
  transition,
  ports
}: {
  terminal: NativeThreadLifecycleRecoveryTerminalFacts;
  transition: NativeThreadTransition;
  ports: NativeThreadLifecycleAdapter;
}): Promise<void> {
  const binding = transition.after_binding;
  if (
    !binding ||
    !binding.native_thread_id ||
    binding.native_process.pid !== terminal.pid ||
    !ports.terminal.aliasMatches(
      binding.terminal_id,
      binding.terminal_control,
      terminal.conversationId
    )
  ) {
    throw new Error("verified after_binding no longer matches the terminal or pid");
  }
  if (transition.operation === "adopt_external_thread") {
    if (
      transition.origin !== "human_observed" ||
      transition.terminal_input_sent !== false ||
      !transition.source_session_id ||
      !transition.before_binding
    ) {
      throw new Error("human-observed handoff recovery evidence is incomplete");
    }
    const source = ports.repository.loadManagedSession(transition.source_session_id);
    const resolved = await ports.terminal.resolveIdentity(
      binding.native_thread_id,
      { primary: codexIdentityFence({
        sessionId: transition.before_native_thread_id,
        processUuid: transition.before_process_uuid,
        processBirth: transition.before_process_birth,
        rollout: transition.before_process_rollout,
        evidence: transition.before_binding.native_process.evidence
      }), additional: [] }
    );
    const observed = await ports.terminal.observeExternalHandoff(source, resolved);
    if (!observed) {
      throw new Error(
        "human-observed handoff target identity is unavailable during recovery"
      );
    }
    const exact = ports.terminal.exactIdentity(observed);
    if (
      exact.sessionId.toLowerCase() !== binding.native_thread_id.toLowerCase() ||
      exact.processUuid !== binding.native_process.process_uuid ||
      exact.processBirth !== binding.native_process.process_birth ||
      JSON.stringify(exact.rollout ?? null) !==
        JSON.stringify(binding.native_process.rollout ?? null)
    ) {
      throw new Error(
        "human-observed handoff target identity changed during recovery"
      );
    }
    return;
  }
  ports.terminal.prepareProbeBridge();
  const status = await ports.terminal.status({ kind: "physical" });
  if (
    !status.reachable ||
    status.activityState !== "idle" ||
    status.approvalBlocked
  ) {
    throw new Error("live terminal is not at a verified idle prompt during recovery");
  }
  let identity: NativeAgentSessionIdentity | undefined;
  if (terminal.agent === "claude") {
    identity = await probeManualClaudeLifecycleRecoveryIdentity({
      terminal,
      transition,
      clearInput: false,
      ports
    });
  } else if (binding.native_process.rollout) {
    // Resolver failures are unknown evidence, never permission to fall back to
    // a possibly stale status card.
    const knownRoots = ports.terminal.codexKnownRoots(transition);
    const companions = ports.terminal.codexCompanionsExcludingPreferred(
      knownRoots,
      binding.native_thread_id
    );
    identity = await ports.terminal.resolveIdentity(
      binding.native_thread_id,
      companions
    );
    if (!identity) {
      throw new Error(
        "Codex rollout identity is unavailable during verified recovery"
      );
    }
    identity = ports.terminal.exactIdentity(identity);
  } else {
    identity = await probeManualCodexLifecycleRecoveryIdentity({
      terminal,
      transition,
      clearInput: false,
      ports
    });
  }
  if (identity.sessionId !== binding.native_thread_id) {
    throw new Error("live native thread does not match verified after_binding");
  }
  if (terminal.agent === "codex") {
    if (
      binding.native_process.process_birth !== identity.processBirth ||
      binding.native_process.process_uuid !== identity.processUuid
    ) {
      throw new Error("Codex process incarnation changed during lifecycle recovery");
    }
  } else if (
    !identity.processUuid ||
    binding.native_process.process_uuid !== identity.processUuid
  ) {
    throw new Error("Claude process incarnation changed during lifecycle recovery");
  }
  const rollout = binding.native_process.rollout;
  if (
    rollout &&
    (
      rollout.fd !== identity?.rollout?.fd ||
      rollout.device !== identity.rollout.device ||
      rollout.inode !== identity.rollout.inode ||
      rollout.path !== identity.rollout.path
    )
  ) {
    throw new Error("native rollout incarnation changed during lifecycle recovery");
  }
  if (
    terminal.agent === "codex" &&
    transition.operation === "resume_thread"
  ) {
    ports.terminal.assertResumedCodexCandidate(
      identity,
      transition.target_candidate_file_identity
    );
  }
}

async function reconcileUncertainLifecycleTransition({
  terminal,
  transition,
  now,
  ports
}: {
  terminal: NativeThreadLifecycleRecoveryTerminalFacts;
  ledger: TerminalDispatchLedgerDocument;
  transition: NativeThreadTransition;
  now: string;
  ports: NativeThreadLifecycleAdapter;
}): Promise<TerminalDispatchLedgerDocument> {
  if (transition.operation === "adopt_external_thread") {
    throw new Error(
      "uncertain human-observed handoff remains quarantined because recovery cannot send terminal input"
    );
  }
  const live = terminal.agent === "claude"
    ? await probeManualClaudeLifecycleRecoveryIdentity({
        terminal,
        transition,
        clearInput: !transition.submitted_at,
        ports
      })
    : await probeManualCodexLifecycleRecoveryIdentity({
        terminal,
        transition,
        clearInput: !transition.submitted_at,
        ports
      });
  assertManualLifecycleProcessIncarnation(transition, live);

  if (live.sessionId === transition.before_native_thread_id) {
    assertLifecycleRolloutMatches(
      transition.before_process_rollout,
      live.rollout,
      "before-thread rollout"
    );
    await ports.terminal.assertExclusive(
      transition.before_native_thread_id,
      transition.source_session_id
    );
    transition = saveLifecycleTransition(ports, {
      ...transition,
      status: "aborted",
      aborted_at: now,
      reconciled_outcome: "before",
      reconciled_at: now,
      error:
        "operator-authorized recovery observed the exact before-thread identity"
    }, nativeThreadTransitionRevision(transition));
    restorePreparedLifecycleSource(transition, now, ports);
    ports.ledger.save(transition, {
      phase: "resolved",
      at: now,
      reason:
        "operator-authorized recovery observed exact before identity and rolled back"
    }, { expectedTransitionId: transition.transition_id });
    return ports.ledger.load() as TerminalDispatchLedgerDocument;
  }

  if (
    !["resume_thread", "adopt_external_thread"].includes(
      transition.operation
    ) ||
    live.sessionId !== transition.target_native_thread_id
  ) {
    throw new Error(
      "fresh native thread identity matches neither the recorded before identity " +
      "nor a durably known exact after identity"
    );
  }
  if (
    transition.operation === "resume_thread" &&
    terminal.agent === "codex" &&
    !live.rollout
  ) {
    throw new Error(
      "Codex resume recovery requires an exact live rollout incarnation"
    );
  }
  if (
    transition.operation === "resume_thread" &&
    terminal.agent === "codex"
  ) {
    ports.terminal.assertResumedCodexCandidate(
      live,
      transition.target_candidate_file_identity
    );
  }
  const targetAtPrepare = ports.repository.tryLoadManagedSession(
    transition.target_session_id
  );
  if (
    (targetAtPrepare?.revision ?? null) !== transition.target_expected_revision
  ) {
    throw new Error(
      "lifecycle target Session changed before manual roll-forward"
    );
  }
  const verifiedAt = new Date(now);
  const afterBinding = terminalBindingFrom({
    terminalId: terminal.conversationId,
    terminalControl: terminal.terminalControl,
    pid: terminal.pid,
    nativeThreadId: live.sessionId,
    processUuid: live.processUuid,
    processBirth: live.processBirth,
    rollout: live.rollout,
    evidence: `${live.evidence}+operator_recovery`,
    generation: (targetAtPrepare?.binding?.generation ?? 0) + 1,
    now: verifiedAt
  });
  transition = saveLifecycleTransition(ports, {
    ...transition,
    status: "verified",
    submitted_at: transition.submitted_at ?? now,
    verified_at: now,
    after_binding: afterBinding,
    reconciled_outcome: "after",
    reconciled_at: now,
    error: undefined,
    do_not_retry: undefined
  }, nativeThreadTransitionRevision(transition));
  await ports.terminal.assertTargetExclusive(transition);
  const savedTarget = ports.repository.commitVerified(transition, now);
  transition = saveLifecycleTransition(ports, {
    ...transition,
    status: "committed",
    committed_at: now
  }, nativeThreadTransitionRevision(transition));
  ports.ledger.save(transition, {
    phase: "resolved_with_binding",
    at: now,
    binding: savedTarget.binding,
    reason:
      "operator-authorized recovery observed exact after identity and rolled forward"
  }, { expectedTransitionId: transition.transition_id });
  return ports.ledger.load() as TerminalDispatchLedgerDocument;
}

async function probeManualClaudeLifecycleRecoveryIdentity({
  terminal,
  transition,
  clearInput = true,
  ports
}: {
  terminal: NativeThreadLifecycleRecoveryTerminalFacts;
  transition: NativeThreadTransition;
  clearInput?: boolean;
  ports: NativeThreadLifecycleAdapter;
}): Promise<NativeAgentSessionIdentity> {
  const startedAt = transition.before_process_started_at;
  if (!startedAt) {
    throw new Error(
      "Claude manual lifecycle recovery lacks prepare-time process incarnation"
    );
  }
  ports.terminal.prepareProbeBridge();
  const operation: NativeThreadLifecycleOperation =
    transition.operation === "resume_thread"
      ? {
          kind: "resume_thread",
          nativeThreadId: transition.target_native_thread_id as string
        }
      : { kind: "new_thread" };
  const initialObservation = (await ports.terminal.observeThreadLifecycle({
    kind: "claude_agents",
    operation,
    pid: terminal.pid,
    processStartedAt: startedAt,
    cwd: transition.workspace
  })).observation;
  const initialStatus = await ports.terminal.status({ kind: "physical" });
  if (
    initialObservation?.status !== "observed" ||
    initialObservation.idle !== true ||
    !isExactNativeThreadId(initialObservation.nativeThreadId) ||
    !initialStatus.reachable ||
    initialStatus.approvalBlocked ||
    (
      clearInput
        ? (
            initialStatus.activityState === "working" ||
            initialStatus.activityState === "awaiting_approval" ||
            !initialStatus.composerVisible
          )
        : (
            initialStatus.activityState !== "idle" ||
            !initialStatus.composerEmpty
          )
    )
  ) {
    throw new Error(
      "manual lifecycle recovery requires one exact idle Claude process and composer"
    );
  }
  const processUuid = `claude-pid:${terminal.pid}:started:${startedAt}`;
  if (processUuid !== transition.before_process_uuid) {
    throw new Error(
      "Claude process incarnation changed before manual lifecycle recovery"
    );
  }
  if (clearInput) {
    await ports.terminal.clearInputLine({ kind: "physical" });
  }

  let stableSessionId: string | undefined;
  let stableCount = 0;
  let lastReason = "no exact idle Claude agents observation was available";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const observed = (await ports.terminal.observeThreadLifecycle({
      kind: "claude_agents",
      operation,
      pid: terminal.pid,
      processStartedAt: startedAt,
      cwd: transition.workspace
    })).observation;
    const status = await ports.terminal.status({ kind: "physical" });
    if (
      observed?.status === "observed" &&
      observed.idle === true &&
      isExactNativeThreadId(observed.nativeThreadId) &&
      status.reachable &&
      status.activityState === "idle" &&
      !status.approvalBlocked &&
      status.composerEmpty
    ) {
      if (stableSessionId === observed.nativeThreadId) {
        stableCount += 1;
      } else {
        stableSessionId = observed.nativeThreadId;
        stableCount = 1;
      }
      if (stableCount >= 2) {
        return {
          sessionId: observed.nativeThreadId,
          processStartedAt: startedAt,
          processUuid,
          evidence: observed.evidence ?? "claude_agents_exact_pid"
        };
      }
      lastReason = "only one stable Claude agents observation was available";
    } else {
      stableSessionId = undefined;
      stableCount = 0;
      lastReason =
        observed?.reason ??
        "Claude process or terminal was not exact, idle, and unblocked";
    }
    await ports.runtime.sleep(100);
  }
  throw new Error(
    `Claude manual lifecycle recovery identity was not stable: ${lastReason}`
  );
}

async function resolveManualCodexLifecycleStatusIdentity({
  observedNativeThreadId,
  observedEvidence,
  transition,
  recoveryKnownRoots,
  ports
}: {
  observedNativeThreadId: string;
  observedEvidence?: string;
  transition: NativeThreadTransition;
  recoveryKnownRoots: CodexCompanionSet;
  ports: NativeThreadLifecycleAdapter;
}): Promise<NativeAgentSessionIdentity> {
  let resolved: NativeAgentSessionIdentity | undefined;
  try {
    const companions = ports.terminal.codexCompanionsExcludingPreferred(
      recoveryKnownRoots,
      observedNativeThreadId
    );
    resolved = await ports.terminal.resolveIdentity(
      observedNativeThreadId,
      companions
    );
  } catch (error) {
    throw new Error(
      `Codex resolver failed during manual lifecycle recovery: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const matchedKnownBefore = [
    recoveryKnownRoots.primary,
    ...recoveryKnownRoots.additional
  ].find((candidate) =>
    ports.terminal.nativeIdentityMatches(
      resolved,
      candidate
    )
  );
  const observedRecordedBefore =
    observedNativeThreadId === transition.before_native_thread_id;
  const recordedBeforeFence = transition.before_process_rollout
    ? {
        sessionId: transition.before_native_thread_id,
        processUuid: transition.before_process_uuid,
        processBirth: transition.before_process_birth as string,
        rollout: transition.before_process_rollout
      }
    : undefined;
  const postconditionEvidence = observedRecordedBefore
    ? recordedBeforeFence
      ? ports.terminal.nativeIdentityMatches(
          resolved,
          recordedBeforeFence
        )
        ? "matching_after"
        : "invalid"
      : resolved === undefined || matchedKnownBefore
        ? "no_rollout"
        : "invalid"
    : classifyCodexLifecyclePostcondition({
        operation: transition.operation === "resume_thread"
          ? "resume_thread"
          : "new_thread",
        parsedNativeThreadId: observedNativeThreadId,
        observationSucceeded: true,
        observedIdentity: resolved,
        beforeIdentity: matchedKnownBefore ?? {
          sessionId: transition.before_native_thread_id,
          processUuid: transition.before_process_uuid,
          processBirth: transition.before_process_birth,
          rollout: transition.before_process_rollout
        }
      });
  if (postconditionEvidence === "invalid") {
    throw new Error(
      "Codex status card and rollout resolver disagree during recovery"
    );
  }
  const sanitized = postconditionEvidence === "matching_after"
    ? resolved
    : {
        sessionId: observedNativeThreadId,
        processUuid: transition.before_process_uuid,
        processBirth: transition.before_process_birth,
        evidence: observedEvidence ?? "codex_status_card"
      };
  return ports.terminal.exactIdentity({
    ...sanitized,
    sessionId: observedNativeThreadId,
    evidence: observedEvidence ?? "codex_status_card"
  });
}

async function probeManualCodexLifecycleRecoveryIdentity({
  terminal,
  transition,
  clearInput = true,
  ports
}: {
  terminal: NativeThreadLifecycleRecoveryTerminalFacts;
  transition: NativeThreadTransition;
  clearInput?: boolean;
  ports: NativeThreadLifecycleAdapter;
}): Promise<NativeAgentSessionIdentity> {
  if (terminal.agent !== "codex") {
    throw new Error(
      "manual uncertain lifecycle recovery currently requires Codex exact-status evidence"
    );
  }
  ports.terminal.prepareProbeBridge();
  const recoveryKnownRoots = ports.terminal.codexKnownRoots(transition);
  const recoveryPreferredSessionId = transition.operation === "resume_thread"
    ? transition.target_native_thread_id as string
    : transition.after_binding?.native_thread_id ??
      transition.before_native_thread_id;
  const recoveryCompanions = ports.terminal.codexCompanionsExcludingPreferred(
    recoveryKnownRoots,
    recoveryPreferredSessionId
  );
  const recoveryContext = {
    kind: "codex_recovery",
    processUuid: transition.before_process_uuid,
    processBirth: transition.before_process_birth,
    expectedSessionId: recoveryPreferredSessionId,
    companions: recoveryCompanions
  } as const;
  // Before any recovery key is sent, prove that every open root is either the
  // exact expected before/after thread or a complete managed companion. This
  // turns an unknown third root into a poisoned recovery instead of allowing
  // C-u or /status to act on an unowned foreground context.
  await ports.terminal.resolveIdentity(
    recoveryPreferredSessionId,
    recoveryCompanions
  );
  const initial = await ports.terminal.status(recoveryContext);
  if (
    !initial.reachable ||
    initial.approvalBlocked ||
    (
      clearInput
        ? (
            initial.activityState === "working" ||
            initial.activityState === "awaiting_approval" ||
            !initial.composerVisible
          )
        : (
            initial.activityState !== "idle" ||
            !initial.composerVisible ||
            !initial.composerEmpty
          )
    )
  ) {
    throw new Error(
      "manual lifecycle recovery requires a reachable non-working Codex composer"
    );
  }
  const birthBeforeClear = ports.terminal.codexProcessBirth();
  const processUuidBeforeClear =
    `codex-pid:${terminal.pid}:birth:${birthBeforeClear}`;
  if (
    birthBeforeClear !== transition.before_process_birth ||
    processUuidBeforeClear !== transition.before_process_uuid
  ) {
    throw new Error(
      "Codex process incarnation changed before manual lifecycle recovery"
    );
  }

  // A dispatcher can die after sendText() but before Enter. Explicit close is
  // the operator authority to clear that unsubmitted composer before probing.
  let cleared: NativeThreadLifecycleStatusFacts | undefined = initial;
  if (clearInput) {
    await ports.terminal.clearInputLine(recoveryContext);
    cleared = undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = await ports.terminal.status(recoveryContext);
      if (
        candidate.reachable &&
        candidate.activityState === "idle" &&
        !candidate.approvalBlocked &&
        candidate.composerEmpty
      ) {
        cleared = candidate;
        break;
      }
      await ports.runtime.sleep(50);
    }
  }
  if (!cleared?.screenDigest) {
    throw new Error("Codex composer did not become empty after recovery clear-line");
  }
  const agentVersion = ports.terminal.runningVersion();
  if (!agentVersion) {
    throw new Error(
      "Codex lifecycle recovery /status requires the exact running version before terminal input"
    );
  }
  const submission = await ports.terminal.submitCodexStatusProbe(
    agentVersion,
    recoveryContext
  );
  const baselineDigest = submission.observationBaselineDigest;

  let stable: NativeAgentSessionIdentity | undefined;
  let stableCount = 0;
  let lastObservationReason = "no fresh idle status screen was captured";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const sampled = await ports.terminal.observeThreadLifecycle({
      kind: "codex_status",
      operation: { kind: "new_thread" },
      context: recoveryContext,
      observationBaselineDigest: baselineDigest,
      observationScrollbackLines: submission.observationScrollbackLines
    });
    if (sampled.kind !== "codex_status") {
      throw new Error("Codex lifecycle observer returned the wrong result kind");
    }
    const status = sampled.status;
    if (
      status.reachable &&
      status.activityState === "idle" &&
      !status.approvalBlocked &&
      status.screenDigest &&
      status.screenDigest !== baselineDigest
    ) {
      const observed = sampled.observation;
      if (
        observed?.status === "observed" &&
        isExactNativeThreadId(observed.nativeThreadId)
      ) {
        const exact = await resolveManualCodexLifecycleStatusIdentity({
          observedNativeThreadId: observed.nativeThreadId,
          observedEvidence: observed.evidence,
          transition,
          recoveryKnownRoots,
          ports
        });
        const key = JSON.stringify({
          sessionId: exact.sessionId,
          processUuid: exact.processUuid,
          processBirth: exact.processBirth,
          rollout: exact.rollout ?? null
        });
        const priorKey = stable
          ? JSON.stringify({
              sessionId: stable.sessionId,
              processUuid: stable.processUuid,
              processBirth: stable.processBirth,
              rollout: stable.rollout ?? null
            })
          : undefined;
        if (priorKey === key) {
          stableCount += 1;
        } else {
          stable = exact;
          stableCount = 1;
        }
        if (stableCount >= 2) {
          return exact;
        }
        lastObservationReason =
          "only one stable status/process observation was available";
      } else {
        lastObservationReason =
          observed?.reason ?? "Codex status card did not expose one exact UUID";
        stable = undefined;
        stableCount = 0;
      }
    } else {
      lastObservationReason =
        "terminal status was not fresh, idle, reachable, and unblocked";
    }
    await ports.runtime.sleep(100);
  }
  throw new Error(
    "fresh Codex /status did not produce a stable exact lifecycle identity: " +
    lastObservationReason
  );
}

function assertManualLifecycleProcessIncarnation(
  transition: NativeThreadTransition,
  live: NativeAgentSessionIdentity
): void {
  if (
    live.processUuid !== transition.before_process_uuid ||
    live.processStartedAt !== transition.before_process_started_at ||
    live.processBirth !== transition.before_process_birth
  ) {
    throw new Error(
      "live process incarnation does not match lifecycle prepare evidence"
    );
  }
}

function assertLifecycleRolloutMatches(
  expected: NativeAgentSessionIdentity["rollout"] | undefined,
  actual: NativeAgentSessionIdentity["rollout"] | undefined,
  label: string
): void {
  if (
    expected &&
    (
      expected.device !== actual?.device ||
      expected.inode !== actual?.inode ||
      expected.path !== actual?.path
    )
  ) {
    throw new Error(`${label} changed during lifecycle recovery`);
  }
}

function restorePreparedLifecycleSource(
  transition: NativeThreadTransition,
  now: string,
  ports: NativeThreadLifecycleAdapter
): void {
  if (transition.target_session_id !== transition.source_session_id) {
    const target = ports.repository.tryLoadManagedSession(
      transition.target_session_id
    );
    if (
      (target?.revision ?? null) !== transition.target_expected_revision ||
      (
        target?.status === "bound" &&
        target.last_transition_id === transition.transition_id
      )
    ) {
      throw new Error(
        "lifecycle target Session changed before before-identity rollback"
      );
    }
  }
  if (!transition.source_session_id) {
    return;
  }
  const source = ports.repository.tryLoadManagedSession(transition.source_session_id);
  if (!source || transition.source_expected_revision === undefined) {
    throw new Error("prepared lifecycle source Session is unavailable");
  }
  if (
    source.status === "bound" &&
    JSON.stringify(source.binding) === JSON.stringify(transition.before_binding) &&
    source.last_transition_id === transition.source_previous_last_transition_id
  ) {
    return;
  }
  if (
    Number(source.revision) <= transition.source_expected_revision ||
    !["transitioning", "quarantined"].includes(source.status) ||
    source.last_transition_id !== transition.transition_id ||
    JSON.stringify(source.binding) !== JSON.stringify(transition.before_binding)
  ) {
    throw new Error("prepared lifecycle source Session changed before recovery");
  }
  saveLifecycleSession(ports, {
    ...source,
    status: "bound",
    quarantine_reason: undefined,
    last_transition_id: transition.source_previous_last_transition_id,
    updated_at: now
  }, managedSessionRevision(source));
}

function assertCommittedLifecycleTarget(
  transition: NativeThreadTransition,
  ports: NativeThreadLifecycleAdapter
): void {
  const target = ports.repository.tryLoadManagedSession(transition.target_session_id);
  if (
    !target ||
    target.status !== "bound" ||
    target.last_transition_id !== transition.transition_id ||
    JSON.stringify(target.binding) !== JSON.stringify(transition.after_binding)
  ) {
    throw new Error("committed lifecycle target Session is missing or mismatched");
  }
}

function quarantineLifecycleSource(
  transition: NativeThreadTransition,
  now: string,
  ports: NativeThreadLifecycleAdapter,
  reason: string
): void {
  if (!transition.source_session_id) {
    return;
  }
  const source = ports.repository.tryLoadManagedSession(transition.source_session_id);
  if (
    !source?.binding ||
    source.last_transition_id !== transition.transition_id ||
    source.status === "quarantined" ||
    source.status === "detached"
  ) {
    return;
  }
  saveLifecycleSession(ports, {
    ...source,
    status: "quarantined",
    quarantine_reason: reason,
    updated_at: now
  }, managedSessionRevision(source));
}

function failClosedLifecycleLedger({
  ledger,
  ports,
  reason
}: {
  ledger: TerminalDispatchLedgerDocument;
  ports: NativeThreadLifecycleAdapter;
  reason: string;
}): TerminalDispatchLedgerDocument {
  const transitionId = stringValue(ledger.transition_id);
  if (!transitionId) {
    return ledger;
  }
  const now = ports.runtime.now().toISOString();
  try {
    ports.ledger.saveFailClosed(ledger, transitionId, now, reason);
  } catch {
    return ledger;
  }
  return ports.ledger.load() as TerminalDispatchLedgerDocument;
}
