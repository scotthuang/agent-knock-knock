import { spawnSync } from "node:child_process";
import path from "node:path";

import type { CodexOpenRootRolloutInventory } from "./agent-session-provider.js";
import { observeClaudeDeadProcessTranscriptCompletion } from
  "./claude-local-transcript-provider.js";
import { expandHome, resolveOptionalExecutable } from "./cli-command-runtime.js";
import { cliDependencies, cliRuntimeLog } from "./cli-runtime-context.js";
import type { DeferredForegroundTransfer,
  DeferredForegroundTransferSourceRolloutAuthority,
  DeferredForegroundTransferSourceTurnAuthority } from
  "./deferred-foreground-transfer.js";
import * as deferredAuthorityAdapter from
  "./deferred-foreground-authority-cli-adapter.js";
import type { ExecutorKind } from "./executors.js";
import { isExactNativeThreadId, managedSessionBindingToken,
  managedSessionRevision, terminalBindingFrom, type ManagedSessionState,
  type NativeThreadTransition } from "./managed-session.js";
import { executorForConversation, sessionIdForConversation,
  turnIdForConversation, type Conversation } from "./protocol.js";
import { listManagedSessions, loadManagedSession, loadNativeThreadTransition,
  saveManagedSession, tryLoadManagedSession } from "./session-store.js";
import { listConversations } from "./store.js";
import type { TerminalCompletionEvidence, TerminalControlRef,
  TerminalDurableCompletionRequest, TerminalRuntimeIdentity,
  ActiveTerminalProcess, TerminalAgentAdapter,
  TerminalAgentAdapterRegistry } from
  "./terminal-agent-adapter.js";
import { parseTerminalConversationId } from "./terminal-agent-adapter.js";
import { exactCodexReadyStyledComposerCapture,
  type TerminalAgentBridge, type TerminalBridgeStatus } from
  "./terminal-agent-bridge.js";
import type { TerminalControlProvider } from "./terminal-control-provider.js";
import type { TerminalProcessSource } from "./terminal-process-source.js";
import { knownNativeThreadCompanionSet } from
  "./native-thread-transition-verification-adapter.js";
import { codexComposerVisible } from
  "./native-thread-lifecycle-recovery-adapter.js";
import { associateTerminalEndpointEvidence, hasCanonicalTerminalEndpoint,
  terminalControlEvidence } from "./terminal-control-ref.js";
import { codexIdentityFence, decideManagedBindingConflict,
  exactBoundCodexSendSource, isCodexStatusCardEvidence,
  isCompleteNativeRollout, processIncarnationRelationship,
  terminalControlAliasMatches, terminalControlsShareIncarnation,
  withCodexCompanionFences,
  type CodexAllowedCompanionSet, type CodexPreMaterializationIdentity,
  type CodexSendAuthorityContext, type ManagedBindingConflictKind } from
  "./terminal-authority-policy.js";
import { codexCompanionSet, exactLifecycleIdentity,
  verifiedEmptySourceSnapshotMatches } from
  "./terminal-identity-authority-service.js";
import { codexKnownBeforeIdentityForTransition, codexLingeringIdentityMatches,
  logicalManagedSessionIdentity, managedBindingMatchesLiveTerminal,
  managedSessionOwnerIsInactive,
  resolvedTerminalProcessIncarnation as resolvedTerminalProcessIncarnationPolicy,
  selectBoundManagedSessionForTerminal, selectSoleBoundManagedSessionClaim,
  terminalRuntimeForLiveIdentity as terminalRuntimeForLiveIdentityPolicy,
  terminalRuntimeIdentityBase,
  type NativeAgentSessionIdentityObservation,
  type NativeIdentityResolutionRequest } from "./terminal-dispatch-execution.js";
import type { DeferredCodexForegroundDispatchSnapshot,
  TerminalDispatchTerminal } from "./terminal-dispatch-composition.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import { terminalBridgeSubmission } from "./terminal-dispatch-receipt.js";
import { detectCodexBoundRolloutCompletion,
  type CodexRolloutAcceptanceAnchor,
  type TerminalSubmissionAcceptanceEvidence } from
  "./terminal-submission-acceptance.js";
import type { BoundTerminalAgentProcessObservation,
  VerifiedDeadAgentCompletionObservation } from
  "./verified-dead-agent-policy.js";
import { type TerminalNativeIdentity as NativeAgentSessionIdentity } from
  "./terminal-binding-authority.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";

export type TerminalIdentityCliOptions = Readonly<Record<string, unknown>>;

export interface TerminalIdentityTerminal {
  conversationId: string;
  agent: ExecutorKind;
  pid: number;
  legacy: boolean;
  adapter: TerminalAgentAdapter;
  terminalControl: TerminalControlRef;
}

interface NativeThreadOwnershipRequest {
  options: TerminalIdentityCliOptions; agent: ExecutorKind;
  currentPid: number; nativeThreadId: string; storeDir: string;
  terminalControl: TerminalControlRef;
  excludedManagedSessionId?: string;
  allowedManagedSessionIds?: string[];
}

interface CodexProbeRequest {
  options: TerminalIdentityCliOptions; terminal: TerminalIdentityTerminal;
  currentIdentity?: NativeAgentSessionIdentity;
  runtimeOverride: TerminalRuntimeIdentity;
}
interface CompletionObservationInput {
  options: TerminalIdentityCliOptions; conversation: Conversation;
  terminalControl: TerminalControlRef;
}
interface ManagedOwnerInput {
  session: ManagedSessionState;
  terminal: Pick<TerminalIdentityTerminal, "agent" | "pid">;
  identity?: NativeAgentSessionIdentity;
}
interface ManagedIdentityContextInput {
  storeDir: string;
  terminal: Pick<TerminalIdentityTerminal,
    "conversationId" | "agent" | "pid" | "terminalControl">;
}
interface KnownRootSetInput {
  storeDir: string; terminal: TerminalIdentityTerminal;
  transition: NativeThreadTransition;
}
interface ComposerReadyInput {
  options: TerminalIdentityCliOptions;
  terminalControl: TerminalControlRef;
}

export interface TerminalIdentityRuntimePorts {
  createBridge(options: TerminalIdentityCliOptions): TerminalAgentBridge;
  createControlProvider(options: TerminalIdentityCliOptions): TerminalControlProvider;
  createProcessSource(options: TerminalIdentityCliOptions): TerminalProcessSource;
  createAgentRegistry(options: TerminalIdentityCliOptions):
    TerminalAgentAdapterRegistry;
  observeNativeIdentity(request: NativeIdentityResolutionRequest &
    { options: TerminalIdentityCliOptions }):
    Promise<NativeAgentSessionIdentityObservation>;
  probeCodexCurrentThread(request: CodexProbeRequest):
    Promise<NativeAgentSessionIdentity>;
}

export interface TerminalIdentityStorePorts {
  terminalControlFromTakeover(value: unknown): TerminalControlRef | undefined;
  storeDir(options: TerminalIdentityCliOptions): string;
  storeDirForConversation(conversation: Conversation): string | undefined;
  turnsForSession(storeDir: string, sessionId: string): Conversation[];
  turnMatchesTerminal(conversation: Conversation,
    terminal: TerminalIdentityTerminal,
    identity?: NativeAgentSessionIdentity): boolean;
  isDiscoverableTurn(conversation: Conversation): boolean;
  readEvents(logPath: string): TerminalDispatchLedgerDocument[];
  loadLedger(terminalControl: TerminalControlRef):
    TerminalDispatchLedgerDocument | undefined;
  ledgerMatchesControl(ledger: TerminalDispatchLedgerDocument | undefined,
    terminalControl: TerminalControlRef,
    options?: { requireCurrentRoute?: boolean;
      requireProcessAnchor?: boolean }): boolean;
  ledgerProcessAnchor(ledger: TerminalDispatchLedgerDocument): number | undefined;
  acquireStateLock(statePath: string): () => void;
  loadTurn(statePath: string): Conversation;
  saveTurn(statePath: string, conversation: Conversation): void;
  appendEvent(logPath: string, event: Readonly<{
    event: string; [key: string]: unknown;
  }>): void;
}

export interface TerminalIdentityCompletionPorts {
  requiresExactBoundCodexCompletion(conversation: Conversation): boolean;
}

export interface TerminalIdentityAuthorityPorts {
  assertTurnBindingCurrent(conversation: Conversation, operation: string): void;
  assertManagedSessionCanStartTurn(turns: Conversation[]): void;
  assertNativeThreadHasExclusiveOwnership(request: NativeThreadOwnershipRequest):
    Promise<void>;
  assertSafeTerminalSend(agent: ExecutorKind, status: TerminalBridgeStatus): void;
  assertTerminalLifecycleReady(input: {
    options: TerminalIdentityCliOptions;
    terminal: TerminalDispatchTerminal;
    terminalStatus: TerminalBridgeStatus;
  }): void;
  provisionalManagedBindingTurnCount(storeDir: string,
    session: ManagedSessionState): number | undefined;
  managedTurnNeedsAttention(turn: Conversation): boolean;
  hasUnresolvedNativeTransition(storeDir: string,
    session: ManagedSessionState): boolean;
  hasAnyNativeTransition(storeDir: string,
    session: ManagedSessionState): boolean;
}

export interface TerminalIdentityEnvironmentPorts {
  cwd(): string;
  now(): Date;
  isProcessAlive(pid: number): boolean;
  workspaceMatches(configured: unknown, candidate: unknown): boolean;
}

export interface CreateTerminalIdentityAuthorityCliAdapterInput {
  runtime: TerminalIdentityRuntimePorts;
  store: TerminalIdentityStorePorts;
  authority: TerminalIdentityAuthorityPorts;
  environment: TerminalIdentityEnvironmentPorts;
  completion: TerminalIdentityCompletionPorts;
}

export function createTerminalIdentityAuthorityCliAdapter(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput
) {
  return Object.freeze({
    resolveTerminalConversationFromOptions: (options: TerminalIdentityCliOptions) =>
      resolveTerminalConversationFromOptions(ports, options),
    refineTerminalTurnEndpoint: (input: EndpointRefinementInput) =>
      refineTerminalTurnEndpoint(ports, input),
    terminalRuntimeIdentityForConversation: (conversation: Conversation,
      terminalControl: TerminalControlRef) =>
      terminalRuntimeIdentityForConversation(ports, conversation, terminalControl),
    terminalDurableRequestForConversation: (conversation: Conversation,
      terminalControl: TerminalControlRef) =>
      terminalDurableRequestForConversation(ports, conversation, terminalControl),
    migrateLegacyTerminalAgentIdentity: (input: LegacyIdentityMigrationInput) =>
      migrateLegacyTerminalAgentIdentity(ports, input),
    exactLifecycleProcessIdentity: (terminal: TerminalIdentityTerminal,
      identity: NativeAgentSessionIdentity) =>
      exactLifecycleProcessIdentity(terminal, identity),
    codexProcessBirthForLifecycle,
    codexProcessIncarnationForPid,
    observeDurableCompletionBeforeDeadStall: (input: CompletionObservationInput) =>
      observeDurableCompletionBeforeDeadStall(ports, input),
    observeBoundTerminalAgentProcess: (input: CompletionObservationInput) =>
      observeBoundTerminalAgentProcess(ports, input),
    resolvedTerminalProcessIncarnation,
    managedSessionOwnerIsConclusivelyInactive: (input: ManagedOwnerInput) =>
      managedSessionOwnerIsConclusivelyInactive(ports, input),
    codexKnownBeforeIdentityForManagedSession,
    codexLingeringBeforeIdentityMatchesSession,
    logicalIdentityForManagedSession,
    codexAllowedCompanionIdentityForManagedSession,
    codexAllowedCompanionSetForManagedSession,
    codexManagedIdentityResolutionContext: (input: ManagedIdentityContextInput) =>
      codexManagedIdentityResolutionContext(ports, input),
    codexKnownRootSetForLifecycleTransition: (input: KnownRootSetInput) =>
      codexKnownRootSetForLifecycleTransition(ports, input),
    codexPreMaterializationIdentityForManagedSession,
    assertCodexComposerReadyForAutomatedInput: (input: ComposerReadyInput) =>
      assertCodexComposerReadyForAutomatedInput(ports, input),
    verifyCodexPendingManagedSendStatus: (input: VerifyPendingManagedSendInput) =>
      verifyCodexPendingManagedSendStatus(ports, input),
    terminalRuntimeForLiveIdentity,
    managedSessionClaimsResolvedTerminal: (session: ManagedSessionState,
      terminal: ResolvedTerminalClaim) =>
      managedSessionClaimsResolvedTerminal(ports, session, terminal),
    bindingMatchesLiveTerminal: (session: ManagedSessionState,
      terminal: TerminalIdentityTerminal, identity:
      NativeAgentSessionIdentity | undefined, storeDir: string) =>
      bindingMatchesLiveTerminal(ports, session, terminal, identity, storeDir),
    boundManagedSessionForTerminal: (input: BoundManagedSessionInput) =>
      boundManagedSessionForTerminal(ports, input),
    managedBindingConflictKindForResolvedTerminal: (input:
      ManagedBindingConflictInput) =>
      managedBindingConflictKindForResolvedTerminal(ports, input),
    soleBoundManagedSessionClaimForTerminal: (storeDir: string,
      terminal: ResolvedTerminalClaim) =>
      soleBoundManagedSessionClaimForTerminal(ports, storeDir, terminal),
    createBoundManagedSession: (input: CreateBoundManagedSessionInput) =>
      createBoundManagedSession(ports, input),
    materializeCurrentManagedSession: (input: MaterializeManagedSessionInput) =>
      materializeCurrentManagedSession(ports, input),
    reattachManagedSessionForNativeIdentity: (input: ReattachManagedSessionInput) =>
      reattachManagedSessionForNativeIdentity(ports, input),
    deferredForegroundAuthorityAdapterPorts: () =>
      deferredForegroundAuthorityAdapterPorts(ports),
    codexCandidateInventoryHasNoOtherManagedClaim: (options:
      CodexCandidateInventoryClaimOptions) =>
      codexCandidateInventoryHasNoOtherManagedClaim(ports, options),
    deferredCandidateSourceTurnHistory: (storeDir: string,
      session: ManagedSessionState) =>
      deferredCandidateSourceTurnHistory(ports, storeDir, session),
    explicitlyAbandonedCandidateSourceFingerprint: (options:
      ExplicitlyAbandonedFingerprintOptions) =>
      explicitlyAbandonedCandidateSourceFingerprint(ports, options),
    assertFrozenExplicitlyAbandonedPredecessorAuthority: (options:
      FrozenAbandonedPredecessorOptions) =>
      assertFrozenExplicitlyAbandonedPredecessorAuthority(ports, options),
    deferredCodexForegroundDispatchSnapshot: (control: TerminalControlRef) =>
      deferredCodexForegroundDispatchSnapshot(ports, control),
    deferredCodexPreviousDispatchSnapshotMatches: (options:
      PreviousDispatchSnapshotOptions) =>
      deferredCodexPreviousDispatchSnapshotMatches(ports, options),
    observeDeferredCodexAuthority: (options: ObserveDeferredAuthorityOptions) =>
      observeDeferredCodexAuthority(ports, options),
    assertVerifiedEmptyCodexHandoffBoundary: (input:
      VerifiedEmptyCodexHandoffInput) =>
      assertVerifiedEmptyCodexHandoffBoundary(ports, input)
  });
}

interface EndpointRefinementInput {
  conversation: Conversation;
  statePath: string;
  terminalControl: TerminalControlRef;
}

function refineTerminalTurnEndpoint(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: EndpointRefinementInput
): Conversation {
  const takeover = isRecord(input.conversation.native_session_takeover)
    ? input.conversation.native_session_takeover
    : undefined;
  const storedControl = ports.store.terminalControlFromTakeover(takeover);
  if (
    !takeover ||
    !storedControl ||
    takeover.terminal_endpoint !== undefined ||
    !hasCanonicalTerminalEndpoint(input.terminalControl)
  ) {
    return input.conversation;
  }
  if (!terminalControlsShareIncarnation(storedControl, input.terminalControl)) {
    throw new Error(
      `cannot refine Turn ${turnIdForConversation(input.conversation)} terminal ` +
      "endpoint after its terminal incarnation changed"
    );
  }
  const terminalEndpoint = terminalControlEvidence(input.terminalControl);
  associateTerminalEndpointEvidence(storedControl, terminalEndpoint);
  const refined: Conversation = {
    ...input.conversation,
    native_session_takeover: { ...takeover, terminal_endpoint: terminalEndpoint }
  };
  ports.store.saveTurn(input.statePath, refined);
  return refined;
}

function terminalRuntimeIdentityForConversation(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  conversation: Conversation,
  terminalControl: TerminalControlRef
): TerminalRuntimeIdentity {
  const runtime = terminalRuntimeIdentityBase(conversation, terminalControl);
  if (executorForConversation(conversation).kind !== "codex") {
    return runtime;
  }
  const storeDir = ports.store.storeDirForConversation(conversation);
  if (!storeDir) {
    return runtime;
  }
  const managedSession = tryLoadManagedSession(
    storeDir,
    sessionIdForConversation(conversation)
  );
  const binding = managedSession?.binding;
  const expectedThreadId = runtime.nativeSessionId ?? runtime.expectedNativeSessionId;
  if (
    !managedSession || managedSession.agent !== "codex" ||
    managedSession.status !== "bound" || !binding ||
    binding.binding_id !== stringValue(conversation.terminal_binding_id) ||
    binding.generation !== Number(conversation.terminal_binding_generation) ||
    binding.native_thread_id !== expectedThreadId ||
    binding.native_process.pid !== runtime.pid ||
    !terminalControlsShareIncarnation(binding.terminal_control, terminalControl)
  ) {
    return runtime;
  }
  return withCodexCompanionFences(runtime,
    codexAllowedCompanionSetForManagedSession({ storeDir, session: managedSession }));
}

function terminalDurableRequestForConversation(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  conversation: Conversation,
  terminalControl: TerminalControlRef
): TerminalDurableCompletionRequest {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const runtime = terminalRuntimeIdentityForConversation(
    ports, conversation, terminalControl);
  return {
    sessionId: runtime.sessionId,
    cwd: stringValue(nativeTakeover?.source_cwd),
    requestText: String(
      nativeTakeover?.terminal_bridge_request_text ?? conversation.user_request ?? ""
    ),
    requestHash: stringValue(nativeTakeover?.terminal_bridge_request_hash),
    startedAt: stringValue(nativeTakeover?.terminal_bridge_started_at),
    context: { conversation, nativeTakeover, ...runtime }
  };
}

interface LegacyIdentityMigrationInput {
  conversation: Conversation;
  statePath: string;
  logPath: string;
  options: TerminalIdentityCliOptions;
}

async function migrateLegacyTerminalAgentIdentity(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: LegacyIdentityMigrationInput
): Promise<Conversation> {
  const nativeTakeover = isRecord(input.conversation.native_session_takeover)
    ? input.conversation.native_session_takeover
    : undefined;
  const terminalControl = ports.store.terminalControlFromTakeover(nativeTakeover);
  if (!nativeTakeover || !terminalControl || hasRuntimePid(
    terminalRuntimeIdentityForConversation(ports, input.conversation, terminalControl)
  )) {
    return input.conversation;
  }
  const nativeSessionId = stringValue(nativeTakeover.native_session_id);
  if (executorForConversation(input.conversation).kind !== "codex" ||
      !nativeSessionId || parseTerminalConversationId(nativeSessionId)) {
    return input.conversation;
  }
  const matchedProcess = await observeLegacyTerminalAgentProcess(
    ports, input, terminalControl, nativeSessionId);
  if (!matchedProcess) {
    return input.conversation;
  }
  const result = persistLegacyTerminalAgentIdentity(
    ports, input, terminalControl, nativeSessionId, matchedProcess);
  if (result.migrated) {
    reportLegacyTerminalAgentIdentityMigration(
      ports, input.logPath, result.conversation, terminalControl,
      nativeSessionId, matchedProcess);
  }
  return result.conversation;
}

function hasRuntimePid(runtime: TerminalRuntimeIdentity): boolean {
  return Number.isInteger(runtime.pid) && Number(runtime.pid) > 0;
}

async function observeLegacyTerminalAgentProcess(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: LegacyIdentityMigrationInput,
  terminalControl: TerminalControlRef,
  nativeSessionId: string
): Promise<ActiveTerminalProcess | undefined> {
  try {
    const adapter = ports.runtime.createAgentRegistry(input.options).require("codex");
    const snapshots = await ports.runtime.createProcessSource(input.options)
      .listProcessSnapshots(
        (snapshot) => adapter.classifyProcess(snapshot) !== undefined,
        { includeAncestors: true }
      );
    const terminalProvider = ports.runtime.createControlProvider(input.options);
    const resolvedTerminal = await terminalProvider.resolve(
      terminalProvider.endpoint(terminalControl));
    const candidates = snapshots.flatMap((snapshot): ActiveTerminalProcess[] => {
      const classified = adapter.classifyProcess(snapshot);
      return classified ? [{ ...classified, agent: "codex" }] : [];
    });
    const matches = candidates.filter((candidate) =>
      candidate.sessionId === nativeSessionId &&
      terminalProvider.containsProcess(resolvedTerminal, candidate, snapshots));
    return matches.length === 1 ? matches[0] : undefined;
  } catch (error) {
    cliRuntimeLog("warn", "legacy_terminal_agent_identity_migration_failed", {
      conversation_id: input.conversation.conversation_id,
      terminal_target: terminalControl.target,
      reason: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function persistLegacyTerminalAgentIdentity(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: LegacyIdentityMigrationInput,
  terminalControl: TerminalControlRef,
  nativeSessionId: string,
  matchedProcess: ActiveTerminalProcess
): { conversation: Conversation; migrated: boolean } {
  const releaseLock = ports.store.acquireStateLock(input.statePath);
  try {
    const current = ports.store.loadTurn(input.statePath);
    const currentTakeover = isRecord(current.native_session_takeover)
      ? current.native_session_takeover
      : undefined;
    const currentControl = ports.store.terminalControlFromTakeover(currentTakeover);
    if (!currentTakeover || !currentControl || hasRuntimePid(
      terminalRuntimeIdentityForConversation(ports, current, currentControl)
    ) || currentTakeover.native_session_id !== nativeSessionId ||
      !terminalControlsShareIncarnation(currentControl, terminalControl)) {
      return { conversation: current, migrated: false };
    }
    const migratedAt = ports.environment.now().toISOString();
    const conversation: Conversation = {
      ...current,
      native_session_takeover: {
        ...currentTakeover,
        terminal_agent_pid: matchedProcess.pid,
        terminal_agent_session_id: matchedProcess.sessionId,
        terminal_agent_identity_migrated_at: migratedAt
      },
      updated_at: migratedAt
    };
    ports.store.saveTurn(input.statePath, conversation);
    return { conversation, migrated: true };
  } finally {
    releaseLock();
  }
}

function reportLegacyTerminalAgentIdentityMigration(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  logPath: string,
  conversation: Conversation,
  terminalControl: TerminalControlRef,
  nativeSessionId: string,
  matchedProcess: ActiveTerminalProcess
): void {
  ports.store.appendEvent(logPath, {
    ts: ports.environment.now().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "terminal_agent_identity_migrated",
    terminal_target: terminalControl.target,
    terminal_agent_pid: matchedProcess.pid,
    native_session_id: nativeSessionId
  });
  cliRuntimeLog("info", "terminal_agent_identity_migrated", {
    conversation_id: conversation.conversation_id,
    terminal_target: terminalControl.target,
    terminal_agent_pid: matchedProcess.pid
  });
}

async function resolveTerminalConversationFromOptions(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  options: TerminalIdentityCliOptions
): Promise<TerminalIdentityTerminal | undefined> {
  return ports.runtime.createBridge(options).resolveConversationId(
    stringValue(
      options.session ??
      options.turn ??
      options.conversation ??
      options.conversationId
    )
  );
}

function exactLifecycleProcessIdentity(
  terminal: TerminalIdentityTerminal,
  identity: NativeAgentSessionIdentity
): NativeAgentSessionIdentity {
  const codexIncarnation = terminal.agent === "codex" &&
      identity.processBirth === undefined
    ? codexProcessIncarnationForPid(terminal.pid)
    : undefined;
  return exactLifecycleIdentity({
    agent: terminal.agent,
    pid: terminal.pid,
    identity,
    codexIncarnation
  });
}

function codexProcessBirthForLifecycle(pid: number): string {
  const injected = cliDependencies().codexProcessBirthForPid;
  if (injected) {
    return injected(pid);
  }
  const ps = resolveOptionalExecutable("ps");
  if (!ps) {
    throw new Error(
      "cannot verify Codex process incarnation because ps is unavailable"
    );
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

function codexCompletionIdentity(runtime: TerminalRuntimeIdentity) {
  const rollout = isRecord(runtime.nativeRollout)
    ? runtime.nativeRollout
    : undefined;
  return {
    sessionId: runtime.nativeSessionId ?? runtime.sessionId ?? "",
    processUuid: runtime.nativeProcessUuid,
    processBirth: runtime.nativeProcessBirth,
    ...(rollout ? { rollout: {
      fd: String(rollout.fd ?? ""), device: String(rollout.device ?? ""),
      inode: String(rollout.inode ?? ""), path: String(rollout.path ?? "")
    } } : {})
  };
}

function observeExactCodexDeadProcessRolloutCompletion(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: CompletionObservationInput
): DurableCompletionBeforeDeadStallObservation {
  const { conversation, terminalControl } = input;
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
    !ports.completion.requiresExactBoundCodexCompletion(conversation) ||
    acceptanceEvidence?.source !== "codex_rollout" ||
    !anchor
  ) {
    return {
      status: "unverifiable",
      reason: "Codex has no exact accepted rollout authority for the dead process"
    };
  }
  const runtime = terminalRuntimeIdentityForConversation(
    ports, conversation, terminalControl);
  const request = terminalDurableRequestForConversation(
    ports, conversation, terminalControl);
  const result = detectCodexBoundRolloutCompletion({
    anchor: anchor as unknown as CodexRolloutAcceptanceAnchor,
    acceptanceEvidence:
      acceptanceEvidence as unknown as TerminalSubmissionAcceptanceEvidence,
    currentIdentity: codexCompletionIdentity(runtime),
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

async function observeDurableCompletionBeforeDeadStall(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: CompletionObservationInput
): Promise<DurableCompletionBeforeDeadStallObservation> {
  const { options, conversation, terminalControl } = input;
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
      const processUuid = stringValue(takeover?.terminal_agent_process_uuid);
      if (processUuid !== `claude-pid:${pid}:started:${startedAt}`) {
        return {
          status: "unverifiable",
          reason: "Claude transcript anchor does not match the exact process incarnation"
        };
      }
      const submission = terminalBridgeSubmission(conversation);
      return observeClaudeDeadProcessTranscriptCompletion(
        terminalDurableRequestForConversation(
          ports, conversation, terminalControl),
        {
          claudeHome: expandHome(
            options.claudeHome as string | undefined
          ),
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
    }
    return observeExactCodexDeadProcessRolloutCompletion(ports, input);
  } catch (error) {
    return {
      status: "unverifiable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

interface BoundProcessCandidate {
  session: ManagedSessionState;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  binding: ManagedSessionState["binding"];
  takeover: Record<string, unknown> | undefined;
  submission: ReturnType<typeof terminalBridgeSubmission>;
  pid: number;
  bindingId: string | undefined;
  bindingGeneration: number;
  processUuid: string | undefined;
  processBirth: string | undefined;
  messageId: string | undefined;
}

interface ExactBoundProcessCandidate extends BoundProcessCandidate {
  binding: NonNullable<ManagedSessionState["binding"]>;
  pid: number;
  bindingId: string;
  processUuid: string;
  messageId: string;
}

function hasExactBoundProcessEnvelope(
  context: BoundProcessCandidate
): context is ExactBoundProcessCandidate {
  return context.session.status === "bound" &&
    context.binding !== undefined &&
    Number.isSafeInteger(context.pid) && context.pid > 1 &&
    context.bindingId !== undefined &&
    Number.isSafeInteger(context.bindingGeneration) &&
    context.bindingGeneration >= 1 &&
    context.processUuid !== undefined &&
    context.messageId !== undefined &&
    hasCanonicalTerminalEndpoint(context.terminalControl);
}

function exactBoundProcessBindingMatches(
  context: ExactBoundProcessCandidate
): boolean {
  const { binding, conversation, session, takeover } = context;
  return binding.native_process.pid === context.pid &&
    terminalControlsShareIncarnation(
      binding.terminal_control,
      context.terminalControl
    ) &&
    binding.binding_id === context.bindingId &&
    binding.generation === context.bindingGeneration &&
    session.agent === executorForConversation(conversation).kind &&
    path.resolve(session.workspace) === path.resolve(conversation.workspace) &&
    binding.native_thread_id === (
      stringValue(conversation.native_thread_id) ??
      stringValue(takeover?.terminal_agent_session_id)
    ) &&
    binding.native_process.process_uuid === context.processUuid &&
    stringValue(takeover?.terminal_binding_id) === context.bindingId &&
    Number(takeover?.terminal_binding_generation) ===
      context.bindingGeneration &&
    (binding.native_process.process_birth ?? undefined) ===
      context.processBirth;
}

function exactBoundProcessSubmissionMatches(
  context: ExactBoundProcessCandidate
): boolean {
  const { conversation, submission } = context;
  return submission?.status === "agent_accepted" &&
    stringValue(submission.session_id) ===
      sessionIdForConversation(conversation) &&
    stringValue(submission.turn_id) === turnIdForConversation(conversation) &&
    stringValue(submission.message_id) === context.messageId &&
    stringValue(submission.binding_id) === context.bindingId &&
    Number(submission.binding_generation) === context.bindingGeneration;
}

async function observeBoundTerminalAgentProcess(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: CompletionObservationInput
): Promise<BoundTerminalAgentProcessObservation> {
  const { options, conversation, terminalControl } = input;
  try {
    ports.authority.assertTurnBindingCurrent(conversation,
      "verify the bound agent process for");
    const storeDir = ports.store.storeDirForConversation(conversation);
    if (!storeDir) {
      return {
        status: "unverifiable",
        reason: "the managed Store is unavailable"
      };
    }
    const session = loadManagedSession(storeDir,
      sessionIdForConversation(conversation));
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
    const context: BoundProcessCandidate = {
      session, conversation, terminalControl, binding, takeover, submission,
      pid, bindingId, bindingGeneration, processUuid, processBirth, messageId
    };
    if (
      !hasExactBoundProcessEnvelope(context) ||
      !exactBoundProcessBindingMatches(context) ||
      !exactBoundProcessSubmissionMatches(context)
    ) {
      return {
        status: "unverifiable",
        reason: "the Turn and Session no longer share one exact process binding"
      };
    }
    const processSource = ports.runtime.createProcessSource(options);
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
        process_uuid: context.processUuid,
        process_birth: context.binding.native_process.process_birth,
        conversation_id: conversation.conversation_id,
        session_id: sessionIdForConversation(conversation),
        turn_id: turnIdForConversation(conversation),
        terminal_control: terminalControl,
        terminal_endpoint: terminalControlEvidence(terminalControl),
        binding_id: context.binding.binding_id,
        binding_generation: context.binding.generation,
        message_id: context.messageId,
        observed_at: ports.environment.now().toISOString()
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
  terminal: Pick<TerminalIdentityTerminal, "agent" | "pid">,
  identity?: NativeAgentSessionIdentity
): { processUuid?: string; processBirth?: string } {
  return resolvedTerminalProcessIncarnationPolicy({
    terminal,
    identity,
    codexProcessIncarnation: codexProcessIncarnationForPid
  });
}

function managedSessionOwnerIsConclusivelyInactive(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: ManagedOwnerInput
): boolean {
  return managedSessionOwnerIsInactive({
    ...input,
    isProcessAlive: ports.environment.isProcessAlive,
    codexProcessIncarnation: codexProcessIncarnationForPid
  });
}

function codexKnownBeforeIdentityForManagedSession(input: {
  storeDir: string;
  session: ManagedSessionState;
  requireNewThread?: boolean;
}): NativeAgentSessionIdentity | undefined {
  let transition: NativeThreadTransition | undefined;
  try {
    transition = input.session.last_transition_id
      ? loadNativeThreadTransition(
          input.storeDir,
          input.session.last_transition_id
        )
      : undefined;
  } catch {
    return undefined;
  }
  return codexKnownBeforeIdentityForTransition({
    session: input.session,
    transition,
    requireNewThread: input.requireNewThread ?? false
  });
}

function codexLingeringBeforeIdentityMatchesSession(input: {
  storeDir: string;
  session: ManagedSessionState;
  identity?: NativeAgentSessionIdentity;
}): boolean {
  if (!codexKnownBeforeIdentityForManagedSession({
    storeDir: input.storeDir,
    session: input.session,
    requireNewThread: true
  })) {
    return false;
  }
  let transition: NativeThreadTransition | undefined;
  try {
    transition = loadNativeThreadTransition(
      input.storeDir,
      input.session.last_transition_id as string
    );
  } catch {
    return false;
  }
  return codexLingeringIdentityMatches({
    session: input.session,
    identity: input.identity,
    transition,
    companions: codexAllowedCompanionSetForManagedSession({
      storeDir: input.storeDir,
      session: input.session
    })
  });
}

function logicalIdentityForManagedSession(input: {
  storeDir: string;
  session: ManagedSessionState;
  observedIdentity?: NativeAgentSessionIdentity;
}): NativeAgentSessionIdentity | undefined {
  return logicalManagedSessionIdentity({
    session: input.session,
    observedIdentity: input.observedIdentity,
    lingeringBeforeMatches: Boolean(input.observedIdentity &&
      codexLingeringBeforeIdentityMatchesSession({
        storeDir: input.storeDir,
        session: input.session,
        identity: input.observedIdentity
      }))
  });
}

function codexAllowedCompanionIdentityForManagedSession(input: {
  storeDir: string;
  session: ManagedSessionState;
}): CodexPreMaterializationIdentity | undefined {
  return codexIdentityFence(codexKnownBeforeIdentityForManagedSession(input));
}

function codexAllowedCompanionSetForManagedSession(input: {
  storeDir: string;
  session: ManagedSessionState;
}): CodexAllowedCompanionSet {
  const primary = codexAllowedCompanionIdentityForManagedSession(input);
  const binding = input.session.binding;
  if (!binding) {
    return { additional: [] };
  }
  const candidates = listManagedSessions(input.storeDir).flatMap(
    (candidate): CodexPreMaterializationIdentity[] => {
      const candidateBinding = candidate.binding;
      if (
        candidate.session_id === input.session.session_id ||
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
        path.resolve(candidate.workspace) !==
          path.resolve(input.session.workspace) ||
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
  return codexCompanionSet({ primary, candidates });
}

function codexManagedIdentityResolutionContext(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: ManagedIdentityContextInput
): {
  claimedSession?: ManagedSessionState;
  companions: CodexAllowedCompanionSet;
  preferredSessionId?: string;
} {
  const claimedSession = soleBoundManagedSessionClaimForTerminal(
    ports,
    input.storeDir,
    input.terminal
  );
  const companions = claimedSession
    ? codexAllowedCompanionSetForManagedSession({
        storeDir: input.storeDir,
        session: claimedSession
      })
    : { additional: [] };
  return {
    claimedSession,
    companions,
    preferredSessionId: companions.primary
      ? claimedSession?.binding?.native_thread_id
      : undefined
  };
}

function codexKnownRootSetForLifecycleTransition(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: KnownRootSetInput
): CodexAllowedCompanionSet {
  return knownNativeThreadCompanionSet({
    terminal: input.terminal,
    transition: input.transition,
    managedSessions: listManagedSessions(input.storeDir)
  }, {
    terminalAliasMatches: terminalControlAliasMatches,
    workspaceMatches: ports.environment.workspaceMatches
  });
}

function codexPreMaterializationIdentityForManagedSession(input: {
  storeDir: string;
  session: ManagedSessionState;
  observedIdentity?: NativeAgentSessionIdentity;
}): CodexPreMaterializationIdentity | undefined {
  if (!codexLingeringBeforeIdentityMatchesSession({
    storeDir: input.storeDir,
    session: input.session,
    identity: input.observedIdentity
  })) {
    return undefined;
  }
  return codexIdentityFence(input.observedIdentity);
}

async function assertCodexComposerReadyForAutomatedInput(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: ComposerReadyInput
): Promise<void> {
  const provider = ports.runtime.createControlProvider(input.options);
  const resolvedTerminal = await provider.resolve(
    provider.endpoint(input.terminalControl)
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

interface VerifyPendingManagedSendInput {
  options: TerminalIdentityCliOptions;
  terminal: TerminalIdentityTerminal;
  session: ManagedSessionState;
  logicalIdentity?: NativeAgentSessionIdentity;
  allowedPreMaterializationIdentity?: CodexPreMaterializationIdentity;
  allowedAdditionalIdentities?: CodexPreMaterializationIdentity[];
}

async function verifyCodexPendingManagedSendStatus(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: VerifyPendingManagedSendInput
): Promise<void> {
  const binding = input.session.binding;
  if (
    input.terminal.agent !== "codex" ||
    !binding?.native_thread_id ||
    (
      !input.allowedPreMaterializationIdentity &&
      (
        binding.native_process.rollout ||
        !isCodexStatusCardEvidence(binding.native_process.evidence)
      )
    )
  ) {
    return;
  }
  if (input.logicalIdentity?.sessionId !== binding.native_thread_id) {
    throw new Error(
      "the pending Codex Session has no exact logical native-thread identity"
    );
  }

  const runtime: TerminalRuntimeIdentity = {
    ...terminalRuntimeForLiveIdentity({
      terminal: input.terminal,
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
      input.allowedPreMaterializationIdentity,
    allowedAdditionalNativeIdentities:
      input.allowedAdditionalIdentities ?? []
  };
  const bridge = ports.runtime.createBridge(input.options);
  const initialStatus = await bridge.status(
    input.terminal.agent,
    input.terminal.terminalControl,
    { runtime }
  );
  ports.authority.assertSafeTerminalSend(
    input.terminal.agent,
    initialStatus
  );
  if (!codexComposerVisible(initialStatus.screen.excerpt)) {
    throw new Error(
      "Codex status-card verification requires a visible idle composer"
    );
  }
  const observed = await ports.runtime.probeCodexCurrentThread({
    options: input.options,
    terminal: input.terminal,
    currentIdentity: input.logicalIdentity,
    runtimeOverride: runtime
  });
  if (observed.sessionId !== binding.native_thread_id) {
    throw new Error(
      `Codex /status reports native thread ${observed.sessionId}, but managed ` +
      `Session ${input.session.session_id} is bound to ${binding.native_thread_id}`
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

type ResolvedTerminalClaim = Pick<TerminalIdentityTerminal,
  "conversationId" | "agent" | "pid" | "terminalControl">;

function managedSessionClaimsResolvedTerminal(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  session: ManagedSessionState,
  terminal: ResolvedTerminalClaim
): boolean {
  const binding = session.binding;
  return session.status === "bound" && binding !== undefined &&
    session.agent === terminal.agent &&
    binding.native_process.pid === terminal.pid &&
    terminalControlAliasMatches(
      binding.terminal_id,
      binding.terminal_control,
      terminal.conversationId,
      terminal.terminalControl
    ) && ports.environment.workspaceMatches(
      session.workspace,
      terminal.terminalControl.currentPath
    );
}

function bindingMatchesLiveTerminal(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  session: ManagedSessionState,
  terminal: TerminalIdentityTerminal,
  identity: NativeAgentSessionIdentity | undefined,
  storeDir: string
): boolean {
  if (!managedSessionClaimsResolvedTerminal(ports, session, terminal)) {
    return false;
  }
  let processIncarnation = {
    processUuid: identity?.processUuid,
    processBirth: identity?.processBirth
  };
  if (!identity) {
    const binding = session.binding;
    if (
      terminal.agent !== "codex" ||
      !binding?.native_thread_id ||
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

interface BoundManagedSessionInput {
  storeDir: string; terminal: TerminalIdentityTerminal;
  identity?: NativeAgentSessionIdentity;
}

function boundManagedSessionForTerminal(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: BoundManagedSessionInput
): ManagedSessionState | undefined {
  return selectBoundManagedSessionForTerminal({
    sessions: listManagedSessions(input.storeDir),
    agent: input.terminal.agent,
    pid: input.terminal.pid,
    terminalTarget: input.terminal.terminalControl.target,
    aliasMatches: (session) => Boolean(session.binding &&
      terminalControlAliasMatches(
        session.binding.terminal_id,
        session.binding.terminal_control,
        input.terminal.conversationId,
        input.terminal.terminalControl
      )),
    exactMatches: (session) =>
      bindingMatchesLiveTerminal(
        ports,
        session,
        input.terminal,
        input.identity,
        input.storeDir
      ),
    sameIncarnation: (session) => Boolean(session.binding &&
      terminalControlsShareIncarnation(
        session.binding.terminal_control,
        input.terminal.terminalControl
      )),
    ownerIsInactive: (session) =>
      managedSessionOwnerIsConclusivelyInactive(ports, {
        session,
        terminal: input.terminal,
        identity: input.identity
      })
  });
}

interface ManagedBindingConflictInput {
  storeDir: string; session: ManagedSessionState;
  terminal: TerminalIdentityTerminal;
  identity?: NativeAgentSessionIdentity;
}

function managedBindingConflictKindForResolvedTerminal(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: ManagedBindingConflictInput
): ManagedBindingConflictKind | undefined {
  if (
    !managedSessionClaimsResolvedTerminal(
      ports,
      input.session,
      input.terminal
    ) ||
    bindingMatchesLiveTerminal(
      ports,
      input.session,
      input.terminal,
      input.identity,
      input.storeDir
    )
  ) {
    return undefined;
  }
  const binding = input.session.binding!;
  if (managedSessionOwnerIsConclusivelyInactive(ports, {
    session: input.session,
    terminal: input.terminal,
    identity: input.identity
  })) {
    return "stale_process_incarnation";
  }
  const incarnation = resolvedTerminalProcessIncarnation(
    input.terminal,
    input.identity
  );
  const relationship = processIncarnationRelationship({
    binding,
    livePid: input.terminal.pid,
    liveProcessUuid: incarnation.processUuid,
    liveProcessBirth: incarnation.processBirth
  });
  return decideManagedBindingConflict({
    session: input.session,
    claimsTerminal: true,
    exactBinding: false,
    ownerConclusivelyInactive: false,
    processRelationship: relationship,
    liveNativeThreadId: input.identity?.sessionId,
    managedTurnCount: ports.authority.provisionalManagedBindingTurnCount(
      input.storeDir,
      input.session
    )
  });
}

function soleBoundManagedSessionClaimForTerminal(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  storeDir: string,
  terminal: ResolvedTerminalClaim
): ManagedSessionState | undefined {
  return selectSoleBoundManagedSessionClaim({
    sessions: listManagedSessions(storeDir),
    terminalTarget: terminal.terminalControl.target,
    claims: (session) =>
      managedSessionClaimsResolvedTerminal(ports, session, terminal),
    ownerIsInactive: (session) =>
      managedSessionOwnerIsConclusivelyInactive(ports, { session, terminal })
  });
}

interface CreateBoundManagedSessionInput {
  sessionId: string;
  terminal: TerminalIdentityTerminal;
  identity?: NativeAgentSessionIdentity;
  nativeThreadId?: string;
  evidence?: string;
  generation?: number;
  lineage: ManagedSessionState["lineage"];
  now?: Date;
}

function createBoundManagedSession(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: CreateBoundManagedSessionInput
): ManagedSessionState {
  const nativeThreadId = input.nativeThreadId ?? input.identity?.sessionId;
  const evidence = input.evidence ?? input.identity?.evidence ??
    "native_thread_boundary";
  const generation = input.generation ?? 1;
  const now = input.now ?? ports.environment.now();
  const workspace = input.terminal.terminalControl.currentPath ??
    ports.environment.cwd();
  const codexIncarnation = input.terminal.agent === "codex" && !input.identity
    ? codexProcessIncarnationForPid(input.terminal.pid)
    : undefined;
  const binding = terminalBindingFrom({
    terminalId: input.terminal.conversationId,
    terminalControl: input.terminal.terminalControl,
    pid: input.terminal.pid,
    nativeThreadId,
    processUuid: input.identity?.processUuid ?? codexIncarnation?.processUuid,
    processBirth: input.identity?.processBirth ?? codexIncarnation?.processBirth,
    rollout: input.identity?.rollout,
    evidence: input.identity?.evidence ?? codexIncarnation?.evidence ?? evidence,
    generation,
    now
  });
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: input.sessionId,
    agent: input.terminal.agent,
    workspace,
    status: "bound",
    binding,
    lineage: input.lineage,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_transition_id: input.lineage.transition_id
  };
}

interface MaterializeManagedSessionInput {
  options: TerminalIdentityCliOptions;
  terminal: TerminalIdentityTerminal;
  identity?: NativeAgentSessionIdentity;
}

function materializeCurrentManagedSession(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: MaterializeManagedSessionInput
): ManagedSessionState | undefined {
  const storeDir = ports.store.storeDir(input.options);
  const existing = boundManagedSessionForTerminal(ports, {
    storeDir,
    terminal: input.terminal,
    identity: input.identity
  });
  if (existing) {
    return existing;
  }
  const matches = listConversations(storeDir)
    .filter(ports.store.isDiscoverableTurn)
    .filter((conversation) => ports.store.turnMatchesTerminal(
      conversation,
      input.terminal,
      input.identity
    ));
  const sessionIds = [...new Set(matches.map((turn) =>
    sessionIdForConversation(turn)
  ))];
  if (sessionIds.length > 1) {
    throw new Error(
      `terminal ${input.terminal.terminalControl.target} has ambiguous legacy Session bindings`
    );
  }
  const sessionId = sessionIds[0];
  if (!sessionId) {
    return undefined;
  }
  const existingById = tryLoadManagedSession(storeDir, sessionId);
  if (existingById) {
    if (!bindingMatchesLiveTerminal(
      ports,
      existingById,
      input.terminal,
      input.identity,
      storeDir
    )) {
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

interface ReattachManagedSessionInput {
  options: TerminalIdentityCliOptions; terminal: TerminalIdentityTerminal;
  identity: NativeAgentSessionIdentity;
  storeDir: string;
}

async function reattachManagedSessionForNativeIdentity(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: ReattachManagedSessionInput
): Promise<ManagedSessionState | undefined> {
  if (!isExactNativeThreadId(input.identity.sessionId)) {
    throw new Error("raw terminal attach requires an exact native thread UUID");
  }
  const nativeThreadId = input.identity.sessionId.toLowerCase();
  const matches = listManagedSessions(input.storeDir).filter((session) =>
    session.agent === input.terminal.agent &&
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
      path.resolve(
        input.terminal.terminalControl.currentPath ?? ports.environment.cwd()
      )
  ) {
    throw new Error(
      `managed Session ${existing.session_id} cannot be rebound from ` +
      `${existing.status} state for native thread ${nativeThreadId}`
    );
  }
  ports.authority.assertManagedSessionCanStartTurn(
    ports.store.turnsForSession(input.storeDir, existing.session_id)
  );
  await ports.authority.assertNativeThreadHasExclusiveOwnership({
    options: input.options,
    agent: input.terminal.agent,
    currentPid: input.terminal.pid,
    nativeThreadId,
    storeDir: input.storeDir,
    terminalControl: input.terminal.terminalControl,
    excludedManagedSessionId: existing.session_id
  });

  const fresh = loadManagedSession(input.storeDir, existing.session_id);
  if (
    fresh.revision !== existing.revision ||
    managedSessionBindingToken(fresh) !== managedSessionBindingToken(existing)
  ) {
    throw new Error(
      `managed Session ${existing.session_id} changed before raw reattach`
    );
  }
  const previousPid = fresh.binding!.native_process.pid;
  if (
    fresh.status === "bound" &&
    !managedSessionOwnerIsConclusivelyInactive(ports, {
      session: fresh,
      terminal: input.terminal,
      identity: input.identity
    })
  ) {
    throw new Error(
      `managed Session ${fresh.session_id} is still bound to process ${previousPid}`
    );
  }

  const now = ports.environment.now();
  const binding = terminalBindingFrom({
    terminalId: input.terminal.conversationId,
    terminalControl: input.terminal.terminalControl,
    pid: input.terminal.pid,
    nativeThreadId,
    processUuid: input.identity.processUuid,
    processBirth: input.identity.processBirth,
    rollout: input.identity.rollout,
    evidence: `${input.identity.evidence}+raw_reattach`,
    generation: fresh.binding!.generation + 1,
    now
  });
  return saveManagedSession(input.storeDir, {
    ...fresh,
    status: "bound",
    binding,
    detached_at: undefined,
    quarantine_reason: undefined,
    updated_at: now.toISOString()
  }, { expectedRevision: managedSessionRevision(fresh) });
}

function deferredForegroundAuthorityAdapterPorts(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput
): deferredAuthorityAdapter.DeferredForegroundAuthorityAdapterPorts {
  return {
    turn: {
      terminalControl: ports.store.terminalControlFromTakeover,
      storeDir: ports.store.storeDirForConversation,
      turnsForSession: ports.store.turnsForSession,
      needsAttention: ports.authority.managedTurnNeedsAttention,
      readEvents: ports.store.readEvents
    },
    ledger: {
      load: ports.store.loadLedger,
      matchesControl: ports.store.ledgerMatchesControl,
      processAnchor: ports.store.ledgerProcessAnchor
    },
    transition: {
      hasUnresolved: ports.authority.hasUnresolvedNativeTransition,
      hasAny: ports.authority.hasAnyNativeTransition
    }
  };
}

interface CodexCandidateInventoryClaimOptions {
  storeDir: string; inventory: CodexOpenRootRolloutInventory;
  sourceSessionId: string;
  includeDetached?: boolean;
}

function codexCandidateInventoryHasNoOtherManagedClaim(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  options: CodexCandidateInventoryClaimOptions
): boolean {
  return deferredAuthorityAdapter.codexCandidateInventoryHasNoOtherManagedClaim(
    deferredForegroundAuthorityAdapterPorts(ports),
    options
  );
}

function deferredCandidateSourceTurnHistory(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  storeDir: string,
  session: ManagedSessionState
): DeferredForegroundTransferSourceTurnAuthority[] | undefined {
  return deferredAuthorityAdapter.deferredCandidateSourceTurnHistory(
    deferredForegroundAuthorityAdapterPorts(ports),
    storeDir,
    session
  );
}

interface ExplicitlyAbandonedFingerprintOptions {
  storeDir: string;
  session: ManagedSessionState;
  sourceTurnHistory: DeferredForegroundTransferSourceTurnAuthority[];
  dispatchSnapshot: DeferredCodexForegroundDispatchSnapshot;
  sourceRevision?: number;
  sourceBindingToken?: string;
  ledgerOverride?: TerminalDispatchLedgerDocument;
  requireResolvedTopLevel?: boolean;
}

function explicitlyAbandonedCandidateSourceFingerprint(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  options: ExplicitlyAbandonedFingerprintOptions
): string | undefined {
  return deferredAuthorityAdapter.explicitlyAbandonedCandidateSourceFingerprint(
    deferredForegroundAuthorityAdapterPorts(ports),
    options
  );
}

interface FrozenAbandonedPredecessorOptions {
  storeDir: string; transfer: DeferredForegroundTransfer;
  terminalControl: TerminalControlRef;
}

function assertFrozenExplicitlyAbandonedPredecessorAuthority(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  options: FrozenAbandonedPredecessorOptions
): void {
  deferredAuthorityAdapter.assertFrozenExplicitlyAbandonedPredecessorAuthority(
    deferredForegroundAuthorityAdapterPorts(ports),
    options
  );
}

function deferredCodexForegroundDispatchSnapshot(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  terminalControl: TerminalControlRef
): DeferredCodexForegroundDispatchSnapshot {
  return deferredAuthorityAdapter.deferredCodexForegroundDispatchSnapshot(
    deferredForegroundAuthorityAdapterPorts(ports),
    terminalControl
  );
}

interface PreviousDispatchSnapshotOptions {
  transfer: DeferredForegroundTransfer; terminalControl: TerminalControlRef;
  ledger: TerminalDispatchLedgerDocument | undefined;
}

function deferredCodexPreviousDispatchSnapshotMatches(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  options: PreviousDispatchSnapshotOptions
): boolean {
  return deferredAuthorityAdapter.deferredCodexPreviousDispatchSnapshotMatches(
    deferredForegroundAuthorityAdapterPorts(ports),
    options
  );
}

interface ObserveDeferredAuthorityOptions {
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
}

function observeDeferredCodexAuthority(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  options: ObserveDeferredAuthorityOptions
): deferredAuthorityAdapter.DeferredCodexAuthorityObservation | undefined {
  return deferredAuthorityAdapter.observeDeferredCodexAuthority(
    deferredForegroundAuthorityAdapterPorts(ports),
    options
  );
}

interface VerifiedEmptyCodexHandoffInput {
  options: TerminalIdentityCliOptions; terminal: TerminalDispatchTerminal;
  sourceSession: ManagedSessionState;
  expectedSourceStatus: "bound" | "detached"; requireNoDispatch: boolean;
  requireEmptyComposer?: boolean;
}

async function assertVerifiedEmptyCodexHandoffBoundary(
  ports: CreateTerminalIdentityAuthorityCliAdapterInput,
  input: VerifiedEmptyCodexHandoffInput
): Promise<void> {
  const storeDir = ports.store.storeDir(input.options);
  const currentSource = loadManagedSession(storeDir,
    input.sourceSession.session_id);
  if (!verifiedEmptySourceSnapshotMatches({
    expectedStatus: input.expectedSourceStatus,
    currentStatus: currentSource.status,
    expectedRevision: input.sourceSession.revision,
    currentRevision: currentSource.revision,
    expectedBindingToken: managedSessionBindingToken(input.sourceSession),
    currentBindingToken: managedSessionBindingToken(currentSource)
  })) {
    throw new Error("the verified-empty source Session changed; refresh AKK list");
  }
  const liveIncarnation = codexProcessIncarnationForPid(input.terminal.pid);
  if (!exactBoundCodexSendSource({
    kind: "verified_empty",
    sourceSession: { ...currentSource, status: "bound" },
    context: {
      terminalId: input.terminal.conversationId,
      terminalControl: input.terminal.terminalControl,
      pid: input.terminal.pid,
      workspace: input.terminal.terminalControl.currentPath,
      liveProcessUuid: liveIncarnation.processUuid,
      liveProcessBirth: liveIncarnation.processBirth
    }
  })) {
    throw new Error("the verified-empty source binding no longer matches the terminal");
  }
  const observation = await ports.runtime.observeNativeIdentity({
    options: input.options,
    agent: "codex",
    pid: input.terminal.pid,
    cwd: input.terminal.terminalControl.currentPath
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
  const status = await ports.runtime.createBridge(input.options).status(
    "codex", input.terminal.terminalControl, {
      runtime: terminalRuntimeForLiveIdentity({ terminal: input.terminal,
        expectedEmptyNativeSession: true })
    });
  if (
    status.reachable !== true ||
    status.approval_state.blocked === true ||
    !["idle", "unknown"].includes(status.activity_state)
  ) {
    throw new Error(
      `terminal ${input.terminal.terminalControl.target} is not at a verified ` +
      `empty Codex prompt (${status.activity_state}: ${status.activity_reason})`
    );
  }
  if (input.requireNoDispatch) {
    ports.authority.assertTerminalLifecycleReady({
      options: input.options,
      terminal: input.terminal,
      terminalStatus: { ...status, activity_state: "idle" }
    });
  }

  const freshSource = loadManagedSession(storeDir, currentSource.session_id);
  if (!verifiedEmptySourceSnapshotMatches({
    expectedStatus: input.expectedSourceStatus,
    currentStatus: freshSource.status,
    expectedRevision: currentSource.revision,
    currentRevision: freshSource.revision,
    expectedBindingToken: managedSessionBindingToken(currentSource),
    currentBindingToken: managedSessionBindingToken(freshSource)
  })) {
    throw new Error("the verified-empty source Session changed; refresh AKK list");
  }
  if (ports.authority.hasUnresolvedNativeTransition(storeDir, freshSource)) {
    throw new Error(
      `managed Session ${freshSource.session_id} has an unresolved native-thread transition`
    );
  }
  if (input.requireEmptyComposer ?? true) {
    await assertCodexComposerReadyForAutomatedInput(ports, {
      options: input.options,
      terminalControl: input.terminal.terminalControl
    });
  }
}
