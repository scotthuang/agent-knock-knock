// CLI infrastructure for verified-empty, deferred foreground, and observed handoff authority.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import type { CodexOpenRootRolloutInventory } from "./agent-session-provider.js";
import { canonicalJson } from "./canonical-json.js";
import { cliCwd, cliEnv, cliExit, cliNow, cliPid,
  cliRuntimeLog as runtimeLog } from "./cli-runtime-context.js";
import { type DeferredForegroundApplicationScope,
  type DeferredForegroundBindingBoundary } from "./deferred-foreground-boundary.js";
import { DeferredForegroundApplicationService } from "./deferred-foreground-application-service.js";
import { TerminalHandoffApplicationService } from "./terminal-handoff-application-service.js";
import { bindDeferredForegroundApplicationScope,
  bindDeferredForegroundWriterScope } from "./deferred-foreground-capability.js";
import { createDeferredForegroundTransferId, listDeferredForegroundTransfers,
  loadDeferredForegroundTransfer, type DeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import { DeferredForegroundRecoveryService } from "./deferred-foreground-recovery-service.js";
import * as deferredRecoveryAdapter from "./deferred-foreground-recovery-cli-adapter.js";
import { prepareDeferredForegroundBinding } from "./deferred-foreground-preparation-service.js";
import { assertDeferredForegroundBoundary, deferredForegroundBoundaryProjection,
  deferredForegroundConcreteBoundary, deferredForegroundTransferMatchesTerminal,
  projectDeferredForegroundTerminalFacts,
  type DeferredForegroundBoundaryAdapterPorts } from
  "./deferred-foreground-preparation-cli-adapter.js";
import { executorDefinitionForKind, type ExecutorKind } from "./executors.js";
import { createManagedSessionId, createNativeThreadTransitionId,
  isExactNativeThreadId, managedSessionBindingToken, managedSessionRevision,
  nativeThreadCommandFingerprint, terminalBindingFrom, type HumanObservedHandoffTargetSnapshot,
  type ManagedSessionState, type NativeThreadTransition } from
  "./managed-session.js";
import { type CanonicalMutationLockPorts, type CanonicalMutationResources,
  type CanonicalMutationScopes, type CanonicalStateMutationResources,
  type CanonicalStateMutationScopes, withCanonicalMutationLocks } from
  "./mutation-transaction.js";
import { claudeComposerEmpty, codexComposerEmpty } from "./native-thread-lifecycle-recovery-adapter.js";
import { sessionIdForConversation, turnIdForConversation, type Conversation } from
  "./protocol.js";
import { commitVerifiedLifecycleTransition, listManagedSessions,
  loadManagedSession, loadNativeThreadTransition, saveManagedSession,
  saveNativeThreadTransition, tryLoadManagedSession } from "./session-store.js";
import { pathsForConversation, pathsForConversationDir } from "./store.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { ResolvedTerminalConversation, TerminalAgentBridge,
  TerminalBridgeStatus } from "./terminal-agent-bridge.js";
import { activeTurnHandoffDecisionToken as projectActiveTurnHandoffDecisionToken,
  codexIdentityFence, deferredCodexForegroundBindingToken,
  exactBoundCodexSendSource,
  observedHandoffAuthorityToken as projectObservedHandoffAuthorityToken,
  terminalControlsShareIncarnation, verifiedEmptyCodexHandoffToken } from
  "./terminal-authority-policy.js";
import type { TerminalNativeIdentity as NativeAgentSessionIdentity } from "./terminal-binding-authority.js";
import { terminalControlEvidenceMatches } from "./terminal-control-ref.js";
import { type DeferredCodexForegroundBindingBoundary,
  type TerminalDispatchTerminal, type VerifiedEmptyCodexHandoffBoundary } from
  "./terminal-dispatch-composition.js";
import { nativeThreadTransitionRevision, terminalSubmissionPayload,
  type NativeAgentSessionIdentityObservation } from
  "./terminal-dispatch-execution.js";
import { nativeThreadLifecycleLedger as lifecycleLedger,
  type TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import { terminalBridgeRequestFingerprint, terminalBridgeSubmission,
  terminalBridgeSubmissionReceipts, terminalDispatchTextSummary } from
  "./terminal-dispatch-receipt.js";
import { captureCodexCandidateSetRolloutAcceptanceAnchor } from "./terminal-submission-acceptance.js";
import { validTerminalMonitorTimestampMs as validTimestampMs } from "./terminal-monitor-decision-policy.js";
import { terminalControlFromTakeover } from "./terminal-runtime-cli-adapter.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import type { createTerminalAcceptanceCliFacade } from "./terminal-acceptance-cli-adapter.js";
import type { createTerminalIdentityAuthorityCliAdapter } from "./terminal-identity-authority-cli-adapter.js";
export type TerminalHandoffCliOptions = Readonly<Record<string, unknown>>;
type UnknownRecord = Record<string, unknown>;

const TERMINAL_INPUT_EVIDENCE_FIELDS = ["text_injected_at",
  "enter_dispatched_at", "submitted_at", "agent_accepted_at",
  "not_accepted_at", "uncertain_at", "acceptance_evidence"] as const;
const HUMAN_OBSERVED_HANDOFF_FINGERPRINT = nativeThreadCommandFingerprint("adopt_external_thread:human_observed:no_terminal_input:v1");
const handoffApplication = new TerminalHandoffApplicationService();

export interface TerminalHandoffRuntimePorts {
  storeDir(options: TerminalHandoffCliOptions): string;
  createBridge(options: TerminalHandoffCliOptions): TerminalAgentBridge;
  agentVersion(agent: ExecutorKind, pid: number,
    options: TerminalHandoffCliOptions): string | undefined;
  required<Value>(value: Value | null | undefined, message: string): Value;
  isStoreMutationLockTimeout(error: unknown): boolean;
}

type TerminalIdentityAuthorityFacade = ReturnType<
  typeof createTerminalIdentityAuthorityCliAdapter
>;
type TerminalAcceptanceFacade = Pick<ReturnType<
  typeof createTerminalAcceptanceCliFacade
>, "inspectCodexOpenRoots" | "observeNativeIdentity" |
  "resolveNativeIdentity" | "assertTurnIdentity">;

export interface TerminalHandoffAuthorityPorts {
  assertTerminalCanStartTurn(storeDir: string,
    terminalControl: TerminalControlRef): void;
  hasUnresolvedTransition(storeDir: string,
    session: ManagedSessionState): boolean;
  assertSessionCanStartTurn(turns: Conversation[]): void;
  turnsForSession(storeDir: string, sessionId: string): Conversation[];
  assertTerminalReady(input: { options: TerminalHandoffCliOptions;
    terminal: TerminalDispatchTerminal; terminalStatus: TerminalBridgeStatus }): void;
  assertSafeSend(agent: ExecutorKind, status: TerminalBridgeStatus): void;
  assertExclusive(input: { options: TerminalHandoffCliOptions;
    agent: ExecutorKind; currentPid: number; nativeThreadId: string;
    storeDir: string; terminalControl: TerminalControlRef;
    excludedManagedSessionId?: string; allowedManagedSessionIds?: string[] }):
    Promise<void>;
}

export interface TerminalHandoffRepositoryPorts {
  storeDirForConversation(conversation: Conversation): string | undefined;
  loadLedger(terminalControl: TerminalControlRef):
    TerminalDispatchLedgerDocument | undefined;
  saveLedger(terminalControl: TerminalControlRef,
    ledger: TerminalDispatchLedgerDocument): void;
  ledgerMatchesControl(ledger: TerminalDispatchLedgerDocument | undefined,
    terminalControl: TerminalControlRef,
    options?: { requireCurrentRoute?: boolean;
      requireProcessAnchor?: boolean }): boolean;
  bindingFields(conversation: Conversation): UnknownRecord;
  withNativeIdentity(conversation: Conversation,
    identity: NativeAgentSessionIdentity): Conversation;
  withSubmission(mutation: Parameters<
    deferredRecoveryAdapter.DeferredForegroundRecoveryAdapterPorts[
      "turn"
    ]["withSubmission"]
  >[0]): Conversation;
  saveLifecycleLedger(terminalControl: TerminalControlRef,
    ledger: TerminalDispatchLedgerDocument,
    options: { expectedTransitionId: string | null;
      expectedStatus?: string }): void;
  mutationLocks(storeDir: string,
    terminalControl: TerminalControlRef): CanonicalMutationLockPorts;
  withStateScope<Result>(scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources, statePath: string, logPath: string,
    operation: (scopes: CanonicalStateMutationScopes,
      resources: CanonicalStateMutationResources) => Promise<Result>):
    Promise<Result>;
}

export interface TerminalHandoffCliDependencies {
  runtime: TerminalHandoffRuntimePorts;
  identity: TerminalIdentityAuthorityFacade;
  acceptance: TerminalAcceptanceFacade;
  authority: TerminalHandoffAuthorityPorts;
  repository: TerminalHandoffRepositoryPorts;
}
interface TerminalHandoffRuntime {
  dependencies: TerminalHandoffCliDependencies;
  originalExpectedTerminalSelector: WeakMap<object, string | undefined>;
}

const terminalHandoffContext =
  new AsyncLocalStorage<TerminalHandoffRuntime>();

function terminalHandoffRuntime(): TerminalHandoffRuntime {
  const runtime = terminalHandoffContext.getStore();
  if (!runtime) {
    throw new Error("Terminal handoff facade runtime is unavailable");
  }
  return runtime;
}

type FunctionPortName<Ports> = {
  [Name in keyof Ports]: Ports[Name] extends
    (...arguments_: never[]) => unknown ? Name : never;
}[keyof Ports];

function contextualPort<
  Group extends keyof TerminalHandoffCliDependencies,
  Name extends FunctionPortName<TerminalHandoffCliDependencies[Group]>
>(group: Group, name: Name): TerminalHandoffCliDependencies[Group][Name] {
  return ((...arguments_: unknown[]) => {
    const operation = terminalHandoffRuntime().dependencies[group][name];
    return (operation as (...values: unknown[]) => unknown)(...arguments_);
  }) as TerminalHandoffCliDependencies[Group][Name];
}

const storeDirFromOptions = contextualPort("runtime", "storeDir");
const createTerminalAgentBridge = contextualPort("runtime", "createBridge");
const terminalRuntimeForLiveIdentity = contextualPort("identity", "terminalRuntimeForLiveIdentity");
const agentVersionForRunningProcess = contextualPort("runtime", "agentVersion");
const required = contextualPort("runtime", "required");
const textSummary = terminalDispatchTextSummary;
const isStoreMutationLockTimeout = contextualPort("runtime", "isStoreMutationLockTimeout");
const codexProcessIncarnationForPid = contextualPort("identity", "codexProcessIncarnationForPid");
const inspectCodexOpenRootRolloutInventory = contextualPort("acceptance", "inspectCodexOpenRoots");
const observeCurrentNativeAgentSessionIdentity = contextualPort("acceptance", "observeNativeIdentity");
const resolveCurrentNativeAgentSessionIdentity = contextualPort("acceptance", "resolveNativeIdentity");
const exactLifecycleProcessIdentity = contextualPort("identity", "exactLifecycleProcessIdentity");
const managedBindingConflictKindForResolvedTerminal = contextualPort("identity", "managedBindingConflictKindForResolvedTerminal");
const assertNativeThreadHasExclusiveOwnership = contextualPort("authority", "assertExclusive");
const assertCodexComposerReadyForAutomatedInput = contextualPort("identity", "assertCodexComposerReadyForAutomatedInput");
const assertNativeAgentIdentityForTurn = contextualPort("acceptance", "assertTurnIdentity");
const assertVerifiedEmptyCodexHandoffBoundary = contextualPort("identity", "assertVerifiedEmptyCodexHandoffBoundary");
const observeDeferredCodexAuthority = contextualPort("identity", "observeDeferredCodexAuthority");
const deferredCodexForegroundDispatchSnapshot = contextualPort("identity", "deferredCodexForegroundDispatchSnapshot");
const codexCandidateInventoryHasNoOtherManagedClaim = contextualPort("identity", "codexCandidateInventoryHasNoOtherManagedClaim");
const deferredCandidateSourceTurnHistory = contextualPort("identity", "deferredCandidateSourceTurnHistory");
const explicitlyAbandonedCandidateSourceFingerprint = contextualPort("identity", "explicitlyAbandonedCandidateSourceFingerprint");
const assertFrozenExplicitlyAbandonedPredecessorAuthority = contextualPort("identity", "assertFrozenExplicitlyAbandonedPredecessorAuthority");
const deferredCodexPreviousDispatchSnapshotMatches = contextualPort("identity", "deferredCodexPreviousDispatchSnapshotMatches");
const terminalListCliFacade = {
  assertTerminalIncarnationCanStartTurn:
    contextualPort("authority", "assertTerminalCanStartTurn"),
  managedSessionHasUnresolvedNativeTransition:
    contextualPort("authority", "hasUnresolvedTransition")
};
const assertManagedSessionCanStartTurn = contextualPort("authority", "assertSessionCanStartTurn");
const managedTurnsForSession = contextualPort("authority", "turnsForSession");
const assertTerminalLifecycleReady = contextualPort("authority", "assertTerminalReady");
const assertSafeTerminalSend = contextualPort("authority", "assertSafeSend");
const managedSessionStoreDirForConversation = contextualPort("repository", "storeDirForConversation");
const loadTerminalBridgeDispatchLedger = contextualPort("repository", "loadLedger");
const saveTerminalBridgeDispatchLedger = contextualPort("repository", "saveLedger");
const terminalDispatchRecordMatchesControl = contextualPort("repository", "ledgerMatchesControl");
const terminalBindingLedgerFields = contextualPort("repository", "bindingFields");
const withNativeAgentSessionIdentity = contextualPort("repository", "withNativeIdentity");
const withTerminalBridgeSubmission = contextualPort("repository", "withSubmission");
const saveLifecycleTerminalDispatchLedger = contextualPort("repository", "saveLifecycleLedger");
const terminalWriterMutationLocks = contextualPort("repository", "mutationLocks");
const withTerminalDispatchStateScope = contextualPort("repository", "withStateScope");
const originalExpectedTerminalSelector = {
  has: (options: object) => terminalHandoffRuntime()
    .originalExpectedTerminalSelector.has(options),
  get: (options: object) => terminalHandoffRuntime()
    .originalExpectedTerminalSelector.get(options)
};

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
  if (handoffApplication.authorityChecksPass([
    () => managedSession !== undefined,
    () => managedSession?.status === "bound", () => binding !== undefined,
    () => receiptBindingId !== undefined,
    () => Number.isSafeInteger(receiptBindingGeneration),
    () => receiptNativeThreadId !== undefined,
    () => receiptBindingId === stringValue(owner.terminal_binding_id),
    () => receiptBindingGeneration === Number(owner.terminal_binding_generation),
    () => receiptNativeThreadId === ownerNativeThreadId,
    () => binding!.binding_id === receiptBindingId,
    () => binding!.generation === receiptBindingGeneration,
    () => binding!.native_thread_id === receiptNativeThreadId,
    () => Number.isSafeInteger(ownerAgentPid),
    () => binding!.native_process.pid === ownerAgentPid,
    () => ownerControl !== undefined,
    () => terminalControlsShareIncarnation(ownerControl!, terminalControl),
    () => terminalControlsShareIncarnation(
      binding!.terminal_control, terminalControl
    )
  ])) {
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
  const chronology = handoffApplication.zeroInputChronology({
    inputStage: transfer.input_stage,
    dispatchStartedAt: transferDispatchStartedAt,
    inputNotStartedAt: terminalInputNotStartedAt,
    dispatchStartedAtMs: validTimestampMs(transferDispatchStartedAt),
    inputNotStartedAtMs: validTimestampMs(terminalInputNotStartedAt)
  });
  if (!handoffApplication.authorityChecksPass([
    () => transfer.version === 2, () => transfer.status === "abort_resolved",
    () => chronology.safe, () => transfer.text_injected_at === undefined,
    () => transfer.enter_dispatched_at === undefined,
    () => transfer.agent_accepted_at === undefined,
    () => transfer.target_session_id === sessionIdForConversation(owner),
    () => transfer.turn_id === turnIdForConversation(owner),
    () => transfer.turn_id === owner.conversation_id,
    () => transfer.message_id === messageId,
    () => transfer.terminal_id === stringValue(takeover.native_session_id),
    () => transfer.process_pid === Number(takeover.terminal_agent_pid),
    () => transfer.process_uuid ===
      stringValue(takeover.terminal_agent_process_uuid),
    () => transfer.process_birth ===
      stringValue(takeover.terminal_agent_process_birth),
    () => path.resolve(transfer.workspace) === path.resolve(owner.workspace),
    () => terminalControlsShareIncarnation(ownerControl, terminalControl),
    () => terminalControlEvidenceMatches(
      transfer.terminal_endpoint, terminalControl
    ),
    () => owner.status === "failed", () => !isRecord(owner.callback_delivery),
    () => !isRecord(owner.terminal_bridge_completion_claim),
    () => !isRecord(takeover.terminal_bridge_completion_claim),
    () => stringValue(takeover.terminal_bridge_message_id) === messageId,
    () => stringValue(takeover.terminal_bridge_request_hash) ===
      transfer.request_hash,
    () => stringValue(takeover.terminal_bridge_request_hash) ===
      stringValue(receipt.request_hash),
    () => stringValue(takeover.deferred_foreground_transfer_id) ===
      transfer.transfer_id,
    () => path.resolve(stringValue(owner.state_path) ?? "") ===
      path.resolve(canonical.statePath),
    () => path.resolve(stringValue(owner.event_log_path) ?? "") ===
      path.resolve(canonical.logPath),
    () => path.resolve(managedSessionStoreDirForConversation(owner) ?? "") ===
      path.resolve(storeDir),
    () => submission !== undefined, () => matchingReceipts.length === 1,
    () => canonicalJson(matchingReceipts[0]) === canonicalJson(submission),
    () => canonicalJson(submission) === canonicalJson(receipt),
    () => submission?.status === "aborted",
    () => submission?.safe_to_retry === true,
    () => stringValue(submission?.last_proven_stage) === "prepared",
    () => Boolean(validTimestampMs(submission?.prepared_at)),
    () => Boolean(validTimestampMs(submission?.aborted_at)),
    () => Date.parse(String(submission?.aborted_at)) >=
      Date.parse(String(submission?.prepared_at)),
    () => !chronology.dispatchIntentProvedNotStarted ||
      stringValue(submission?.aborted_at) === terminalInputNotStartedAt,
    () => !TERMINAL_INPUT_EVIDENCE_FIELDS.some(
      (field) => submission?.[field] !== undefined
    ),
    () => stringValue(submission?.session_id) === transfer.target_session_id,
    () => stringValue(submission?.turn_id) === transfer.turn_id,
    () => stringValue(submission?.message_id) === transfer.message_id,
    () => stringValue(submission?.request_hash) === transfer.request_hash,
    () => stringValue(submission?.binding_id) ===
      transfer.target_before_binding?.binding_id,
    () => Number(submission?.binding_generation) ===
      transfer.target_before_binding?.generation,
    () => stringValue(submission?.native_thread_id) === undefined,
    () => target !== undefined, () => target?.status === "detached",
    () => target?.last_transition_id === transfer.transfer_id,
    () => target?.lineage.transition_id === transfer.transfer_id,
    () => target?.lineage.previous_session_id === transfer.source_session_id,
    () => transfer.abort_target_after_status === "detached",
    () => targetBinding !== undefined,
    () => managedSessionRevision(target!) === transfer.abort_target_after_revision,
    () => managedSessionBindingToken(target!) ===
      transfer.abort_target_after_binding_token,
    () => JSON.stringify(target?.binding) === JSON.stringify(targetBinding),
    () => source !== undefined, () => source?.status === "bound",
    () => source?.last_transition_id ===
      transfer.source_previous_last_transition_id,
    () => transfer.abort_source_after_status === "bound",
    () => sourceBinding !== undefined,
    () => managedSessionRevision(source!) === transfer.abort_source_after_revision,
    () => managedSessionBindingToken(source!) ===
      transfer.abort_source_after_binding_token,
    () => JSON.stringify(source?.binding) === JSON.stringify(sourceBinding),
    () => JSON.stringify(sourceBinding) ===
      JSON.stringify(transfer.source_before_binding)
  ])) {
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
    chronology.dispatchIntentProvedNotStarted &&
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
  handoffApplication.assertAuthority([
    () => durable.operation === "adopt_external_thread",
    () => durable.origin === "human_observed",
    () => durable.terminal_input_sent === false,
    () => durable.status === "committed",
    () => Boolean(durable.source_session_id),
    () => durable.before_binding !== undefined,
    () => durable.after_binding !== undefined,
    () => JSON.stringify(durable.after_binding) ===
      JSON.stringify(transition.after_binding)
  ], "human-observed handoff changed before terminal transport");
  const sourceSessionId = durable.source_session_id!;
  const beforeBinding = durable.before_binding!;
  const afterBinding = durable.after_binding!;
  const source = loadManagedSession(storeDir, sourceSessionId);
  const target = loadManagedSession(storeDir, durable.target_session_id);
  handoffApplication.assertAuthority([
    () => source.status === "detached",
    () => source.last_transition_id === durable.transition_id,
    () => JSON.stringify(source.binding) === JSON.stringify(beforeBinding),
    () => target.status === "bound",
    () => target.last_transition_id === durable.transition_id,
    () => JSON.stringify(target.binding) === JSON.stringify(afterBinding)
  ], "human-observed handoff Session authority changed before send");
  const targetId = afterBinding.native_thread_id;
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
      evidence: beforeBinding.native_process.evidence
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
    if (!afterBinding.native_process.rollout) {
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
            processUuid: afterBinding.native_process.process_uuid,
            processBirth: afterBinding.native_process.process_birth,
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
  handoffApplication.assertAuthority([
    () => exact.sessionId.toLowerCase() === targetId.toLowerCase(),
    () => exact.processUuid === afterBinding.native_process.process_uuid,
    () => exact.processBirth === afterBinding.native_process.process_birth,
    () => JSON.stringify(exact.rollout ?? null) ===
      JSON.stringify(afterBinding.native_process.rollout ?? null)
  ], "human-observed handoff identity changed before send");
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
      !isFinalDeferredForegroundTransferStatus(candidate.status) &&
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
  if (!isFinalDeferredForegroundTransferStatus(transfer.status)) {
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
      !isFinalDeferredForegroundTransferStatus(candidate.status) &&
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

type FacadeCall = <Result>(operation: () => Result) => Result;
type UnknownOperation = (...arguments_: unknown[]) => unknown;

function bindContextObject<Value extends object>(
  target: Value,
  call: FacadeCall
): Value {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object) as unknown;
      if (typeof value === "function") {
        return (...arguments_: unknown[]) => call(() =>
          Reflect.apply(value, object, arguments_));
      }
      return value && typeof value === "object"
        ? bindContextObject(value, call)
        : value;
    }
  });
}

const terminalHandoffOperations = {
  assertSafeAbortedTerminalRetryBinding,
  exactSafeAbortedRecoveredSessionMatches,
  maybeDetachVerifiedEmptyCodexSource,
  assertVerifiedEmptyCodexTransportBoundary,
  assertDeferredCodexForegroundBindingBoundary,
  prepareDeferredCodexForegroundBinding,
  observedHandoffAuthorityToken,
  activeTurnHandoffDecisionToken,
  assertExpectedHandoffTokenUsesExactTerminalSelector,
  observedExternalHandoffIdentity,
  observedHandoffTargetResolution,
  maybeAdoptObservedExternalThread,
  assertObservedHandoffTransportBoundary,
  assertConversationHasNoNonterminalDeferredForegroundTransfer,
  assertTerminalHasNoNonterminalDeferredForegroundTransfer,
  recoverDeferredCodexForegroundTransferBeforeMutation,
  recoverDeferredCodexForegroundTransferWhileWriterLease
};

export type TerminalHandoffCliFacade = Readonly<
  typeof terminalHandoffOperations & {
    rememberOriginalExpectedTerminalSelector(
      options: object,
      selector: string | undefined
    ): void;
    deferredForegroundApplication: typeof deferredForegroundApplication;
    deferredForegroundRecoveryAdapterPorts:
      typeof deferredForegroundRecoveryAdapterPorts;
  }
>;

export function createTerminalHandoffCliFacade(
  dependencies: TerminalHandoffCliDependencies
): TerminalHandoffCliFacade {
  const runtime: TerminalHandoffRuntime = {
    dependencies,
    originalExpectedTerminalSelector: new WeakMap()
  };
  const call: FacadeCall = (operation) =>
    terminalHandoffContext.run(runtime, operation);
  const contextualOperations = Object.fromEntries(
    Object.entries(terminalHandoffOperations).map(([name, operation]) => [
      name,
      (...arguments_: unknown[]) => call(() =>
        (operation as UnknownOperation)(...arguments_))
    ])
  ) as typeof terminalHandoffOperations;
  return Object.freeze({
    ...contextualOperations,
    rememberOriginalExpectedTerminalSelector: (options, selector) => {
      runtime.originalExpectedTerminalSelector.set(options, selector);
    },
    deferredForegroundApplication: (...arguments_) => bindContextObject(
      call(() => deferredForegroundApplication(...arguments_)),
      call
    ),
    deferredForegroundRecoveryAdapterPorts: () => bindContextObject(
      call(() => deferredForegroundRecoveryAdapterPorts()),
      call
    )
  });
}
