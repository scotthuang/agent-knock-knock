// Raw CLI composition for renew, cancel, and close maintenance commands.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import type { ExecutorKind } from "./executors.js";
import type { ManagedSessionState } from "./managed-session.js";
import {
  type CanonicalMutationLockPorts, type CanonicalMutationResources,
  type CanonicalMutationScopes, type CanonicalStateMutationResources,
  type CanonicalStateMutationScopes, withCanonicalMutationLocks
} from "./mutation-transaction.js";
import {
  budgetAction, executorForConversation, sessionIdForConversation,
  isSessionSendBlockingStatus, turnIdForConversation,
  type Conversation, type ConversationStatus
} from "./protocol.js";
import {
  appendEvent, loadState, logPathForStatePath, pathsForConversationDir,
  saveState, withStoreWriterLeaseAsync
} from "./store.js";
import { loadManagedSession, tryLoadManagedSession } from "./session-store.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { ResolvedTerminalConversation, TerminalAgentBridge } from
  "./terminal-agent-bridge.js";
import { TerminalControlUnavailableError, type TerminalControlProvider } from
  "./terminal-control-provider.js";
import { terminalControlsShareIncarnation } from
  "./terminal-authority-policy.js";
import { terminalControlEvidenceMatches } from "./terminal-control-ref.js";
import { terminalControlFromTakeover } from
  "./terminal-runtime-cli-adapter.js";
import { terminalBridgeSubmission } from "./terminal-dispatch-receipt.js";
import { terminalDispatchLedgerLooksLifecycle,
  type TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import { loadDeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import { isRecoverableTerminalDispatchStatus } from
  "./terminal-dispatch-policy.js";
import { decideVerifiedDeadAgentProcess,
  type VerifiedDeadTerminalAgentProcessProof } from
  "./verified-dead-agent-policy.js";
import { terminalMonitorDeadlineAt as deadlineAt } from
  "./terminal-monitor-decision-policy.js";
import { writeCliJson as printJson } from "./cli-command-runtime.js";
import { cliCwd, cliEnv, cliExit, cliNow, cliNowMs,
  cliRuntimeLog as runtimeLog } from "./cli-runtime-context.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import type { createTerminalIdentityAuthorityCliAdapter } from
  "./terminal-identity-authority-cli-adapter.js";
import type { createTerminalAcceptanceCliFacade } from
  "./terminal-acceptance-cli-adapter.js";
import type { createTerminalHandoffCliFacade } from
  "./terminal-handoff-cli-adapter.js";
import type { createTerminalListCliFacade } from
  "./terminal-list-cli-adapter.js";
import type { TerminalDispatchRecoveryCliFacade } from
  "./terminal-dispatch-recovery-cli-adapter.js";
import type { TerminalDispatchRepositoryCliAdapter,
  TerminalDispatchResolveRequest } from
  "./terminal-dispatch-repository-cli-adapter.js";
import type { NativeThreadLifecycleCliFacade } from
  "./native-thread-lifecycle-cli-adapter.js";
import type { NativeThreadTransitionApplication } from
  "./native-thread-transition-application.js";

export type TerminalMaintenanceCliOptions = Readonly<Record<string, unknown>>;
interface LoadedConversation {
  conversation: Conversation; statePath: string; logPath: string;
}
type TerminalIdentityFacade = ReturnType<
  typeof createTerminalIdentityAuthorityCliAdapter>;
type TerminalAcceptanceFacade = ReturnType<
  typeof createTerminalAcceptanceCliFacade>;
type TerminalHandoffFacade = ReturnType<typeof createTerminalHandoffCliFacade>;
type TerminalListFacade = ReturnType<typeof createTerminalListCliFacade>;

export interface TerminalMaintenanceRuntimePorts {
  readonly defaultAgentTimeoutMinutes: number;
  readonly defaultAgentHardTimeoutMinutes: number;
  readonly monitorLockVersion: number;
  loadConversation(options: TerminalMaintenanceCliOptions): LoadedConversation;
  storeDir(options: TerminalMaintenanceCliOptions): string;
  createControlProvider(options: TerminalMaintenanceCliOptions):
    TerminalControlProvider;
  createBridge(options: TerminalMaintenanceCliOptions): TerminalAgentBridge;
  startMonitor(input: { conversation: Conversation; statePath: string;
    logPath: string; options: TerminalMaintenanceCliOptions }):
    { pid?: number } | undefined;
  positiveMinutes(value: unknown, optionName: string): number;
  textSummary(value: unknown, maxLength?: number): unknown;
}
export type TerminalMaintenanceIdentityPorts = Pick<TerminalIdentityFacade,
  "resolveTerminalConversationFromOptions" |
  "migrateLegacyTerminalAgentIdentity" |
  "terminalRuntimeIdentityForConversation" |
  "codexAllowedCompanionSetForManagedSession" |
  "managedBindingConflictKindForResolvedTerminal" |
  "observeBoundTerminalAgentProcess"> & Pick<TerminalAcceptanceFacade,
    "resolveNativeIdentity" | "observeNativeIdentity">;
export type TerminalMaintenanceAuthorityPorts = Pick<TerminalHandoffFacade,
  "assertConversationHasNoNonterminalDeferredForegroundTransfer" |
  "assertTerminalHasNoNonterminalDeferredForegroundTransfer" |
  "observedExternalHandoffIdentity" | "observedHandoffAuthorityToken" |
  "observedHandoffTargetResolution" | "activeTurnHandoffDecisionToken"> & {
    hasUnresolvedNativeTransition:
      TerminalListFacade["managedSessionHasUnresolvedNativeTransition"];
    assertExclusive: NativeThreadLifecycleCliFacade["assertExclusive"];
    assertTurnBindingCurrent(conversation: Conversation,
      operation: string): void;
    assertManagedTerminalDispatchOwner(input: { storeDir: string;
      conversation: Conversation; terminalControl: TerminalControlRef;
      action: "approve" | "cancel" }): void;
    loadTerminalDispatchLedgerOwner(ledger: TerminalDispatchLedgerDocument):
      Conversation | undefined;
  };
type CanonicalStateMutationLockPorts = CanonicalMutationLockPorts & {
  resources: CanonicalStateMutationResources; acquireState: () => () => void;
};
export interface TerminalMaintenanceRepositoryPorts {
  acquireFileLock(lockPath: string): () => void;
  acquireTerminalLock: TerminalDispatchRepositoryCliAdapter["acquire"];
  withStoreWriterLease<Result>(storeDir: string,
    operation: () => Promise<Result>): Promise<Result>;
  resolveDispatch: TerminalDispatchRepositoryCliAdapter["resolve"];
  conversationLoad(scopes: CanonicalStateMutationScopes,
    resources: CanonicalStateMutationResources): Conversation;
  conversationSave(scopes: CanonicalStateMutationScopes,
    resources: CanonicalStateMutationResources,
    conversation: Conversation): void;
  conversationAppendEvent(scopes: CanonicalStateMutationScopes,
    resources: CanonicalStateMutationResources,
    event: Parameters<typeof appendEvent>[1]): void;
  sessionLoad(scopes: CanonicalStateMutationScopes,
    resources: CanonicalStateMutationResources,
    sessionId: string): ManagedSessionState;
  ledgerLoad(scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources):
    TerminalDispatchLedgerDocument | undefined;
  ledgerSave(scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources,
    ledger: TerminalDispatchLedgerDocument): void;
  ledgerResolve(scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources,
    request: TerminalDispatchResolveRequest): boolean;
  ledgerReconcileIncarnation(scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources):
    TerminalDispatchLedgerDocument | undefined;
  ledgerReconcile: NativeThreadTransitionApplication["reconcileLedger"];
  terminalWriterLocks(storeDir: string, terminalControl: TerminalControlRef):
    CanonicalMutationLockPorts;
  terminalWriterStateLocks(storeDir: string,
    terminalControl: TerminalControlRef, statePath: string, logPath: string):
    CanonicalStateMutationLockPorts;
  isVerifiedDead: TerminalDispatchRecoveryCliFacade["isVerifiedDead"];
  exactVerifiedDeadAuthority:
    TerminalDispatchRecoveryCliFacade["exactVerifiedDeadAuthority"];
  ensureVerifiedDeadEvent:
    TerminalDispatchRecoveryCliFacade["ensureVerifiedDeadEvent"];
  ensureVerifiedDeadClosedEvent:
    TerminalDispatchRecoveryCliFacade["ensureVerifiedDeadClosedEvent"];
  assertVerifiedDeadDispatch:
    TerminalDispatchRecoveryCliFacade["assertVerifiedDeadDispatch"];
  resolveVerifiedDeadDispatch:
    TerminalDispatchRecoveryCliFacade["resolveVerifiedDeadDispatch"];
}
export interface TerminalMaintenanceCliDependencies {
  runtime: TerminalMaintenanceRuntimePorts;
  identity: TerminalMaintenanceIdentityPorts;
  authority: TerminalMaintenanceAuthorityPorts;
  repository: TerminalMaintenanceRepositoryPorts;
}
interface TerminalMaintenanceRuntime {
  dependencies: TerminalMaintenanceCliDependencies;
}
const terminalMaintenanceContext =
  new AsyncLocalStorage<TerminalMaintenanceRuntime>();
function terminalMaintenanceRuntime(): TerminalMaintenanceRuntime {
  const runtime = terminalMaintenanceContext.getStore();
  if (!runtime) {
    throw new Error("Terminal maintenance facade runtime is unavailable");
  }
  return runtime;
}
type FunctionPortName<Ports> = {
  [Name in keyof Ports]: Ports[Name] extends
    (...arguments_: never[]) => unknown ? Name : never;
}[keyof Ports];
function contextualPort<
  Group extends keyof TerminalMaintenanceCliDependencies,
  Name extends FunctionPortName<TerminalMaintenanceCliDependencies[Group]>
>(group: Group, name: Name): TerminalMaintenanceCliDependencies[Group][Name] {
  return ((...arguments_: unknown[]) => {
    const operation = terminalMaintenanceRuntime().dependencies[group][name];
    return (operation as (...values: unknown[]) => unknown)(...arguments_);
  }) as TerminalMaintenanceCliDependencies[Group][Name];
}
function required<Value>(value: Value | undefined, message: string):
  Exclude<Value, undefined | ""> {
  if (value === undefined || value === "") throw new Error(message);
  return value as Exclude<Value, undefined | "">;
}

const loadConversationFromOptions = contextualPort("runtime", "loadConversation");
const storeDirFromOptions = contextualPort("runtime", "storeDir");
const createTerminalControlProvider =
  contextualPort("runtime", "createControlProvider");
const createTerminalAgentBridge = contextualPort("runtime", "createBridge");
const startTerminalBridgeMonitorForConversation =
  contextualPort("runtime", "startMonitor");
const positiveMinutes = contextualPort("runtime", "positiveMinutes");
const textSummary = contextualPort("runtime", "textSummary");
const resolveTerminalConversationFromOptions =
  contextualPort("identity", "resolveTerminalConversationFromOptions");
const migrateLegacyTerminalAgentIdentity =
  contextualPort("identity", "migrateLegacyTerminalAgentIdentity");
const terminalRuntimeIdentityForConversation =
  contextualPort("identity", "terminalRuntimeIdentityForConversation");
const codexAllowedCompanionSetForManagedSession =
  contextualPort("identity", "codexAllowedCompanionSetForManagedSession");
const managedBindingConflictKindForResolvedTerminal = contextualPort(
  "identity", "managedBindingConflictKindForResolvedTerminal");
const observeBoundTerminalAgentProcess =
  contextualPort("identity", "observeBoundTerminalAgentProcess");
const resolveCurrentNativeAgentSessionIdentity =
  contextualPort("identity", "resolveNativeIdentity");
const observeCurrentNativeAgentSessionIdentity =
  contextualPort("identity", "observeNativeIdentity");
const assertConversationHasNoNonterminalDeferredForegroundTransfer =
  contextualPort("authority",
    "assertConversationHasNoNonterminalDeferredForegroundTransfer");
const assertTerminalHasNoNonterminalDeferredForegroundTransfer =
  contextualPort("authority",
    "assertTerminalHasNoNonterminalDeferredForegroundTransfer");
const observedExternalHandoffIdentity =
  contextualPort("authority", "observedExternalHandoffIdentity");
const observedHandoffAuthorityToken =
  contextualPort("authority", "observedHandoffAuthorityToken");
const observedHandoffTargetResolution =
  contextualPort("authority", "observedHandoffTargetResolution");
const activeTurnHandoffDecisionToken =
  contextualPort("authority", "activeTurnHandoffDecisionToken");
const assertTurnBindingCurrent =
  contextualPort("authority", "assertTurnBindingCurrent");
const assertManagedTerminalDispatchOwner =
  contextualPort("authority", "assertManagedTerminalDispatchOwner");
const loadTerminalDispatchLedgerOwner =
  contextualPort("authority", "loadTerminalDispatchLedgerOwner");
const terminalListCliFacade = Object.freeze({
  managedSessionHasUnresolvedNativeTransition:
    contextualPort("authority", "hasUnresolvedNativeTransition")
});
const nativeThreadLifecycleFacade = Object.freeze({
  assertExclusive: contextualPort("authority", "assertExclusive")
});
const acquireFileLock = contextualPort("repository", "acquireFileLock");
const acquireTerminalBridgeSendLock =
  contextualPort("repository", "acquireTerminalLock");
const withStoreWriterLease =
  contextualPort("repository", "withStoreWriterLease");
const resolveTerminalBridgeDispatchLedger =
  contextualPort("repository", "resolveDispatch");
const terminalWriterMutationLocks =
  contextualPort("repository", "terminalWriterLocks");
const terminalWriterStateMutationLocks =
  contextualPort("repository", "terminalWriterStateLocks");
const mutationConversationStore = Object.freeze({
  load: contextualPort("repository", "conversationLoad"),
  save: contextualPort("repository", "conversationSave"),
  appendEvent: contextualPort("repository", "conversationAppendEvent")
});
const mutationManagedSessions = Object.freeze({
  load: contextualPort("repository", "sessionLoad")
});
const mutationDispatchLedger = Object.freeze({
  load: contextualPort("repository", "ledgerLoad"),
  save: contextualPort("repository", "ledgerSave"),
  resolve: contextualPort("repository", "ledgerResolve"),
  reconcileIncarnation:
    contextualPort("repository", "ledgerReconcileIncarnation"),
  reconcile: contextualPort("repository", "ledgerReconcile")
});
const isVerifiedDeadTerminalAgentProcess =
  contextualPort("repository", "isVerifiedDead");
const exactVerifiedDeadTerminalAgentProcessAuthority =
  contextualPort("repository", "exactVerifiedDeadAuthority");
const ensureVerifiedDeadTerminalAgentProcessEvent =
  contextualPort("repository", "ensureVerifiedDeadEvent");
const ensureVerifiedDeadConversationClosedEvent =
  contextualPort("repository", "ensureVerifiedDeadClosedEvent");
const assertVerifiedDeadTerminalBridgeDispatchAuthority =
  contextualPort("repository", "assertVerifiedDeadDispatch");
const resolveVerifiedDeadTerminalBridgeDispatchLedger =
  contextualPort("repository", "resolveVerifiedDeadDispatch");

async function runRenew(options: TerminalMaintenanceCliOptions): Promise<void> {
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
        terminalMaintenanceRuntime().dependencies.runtime
          .defaultAgentTimeoutMinutes,
      "--minutes"
    );
    hardTimeoutMinutes = positiveMinutes(
      currentTakeover.terminal_bridge_hard_timeout_minutes ??
        terminalMaintenanceRuntime().dependencies.runtime
          .defaultAgentHardTimeoutMinutes,
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
        terminal_bridge_monitor_lock_version:
          terminalMaintenanceRuntime().dependencies.runtime.monitorLockVersion,
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
async function runCancel(options: TerminalMaintenanceCliOptions): Promise<void> {
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

async function runTerminalConversationCancel({
  options,
  conversationId,
  agent,
  terminalControl,
  pid
}: {
  options: TerminalMaintenanceCliOptions;
  conversationId: string;
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  pid: number;
}): Promise<void> {
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

async function runTerminalControlCancel({
  options,
  statePath,
  logPath,
  agent,
  terminalControl
}: {
  options: TerminalMaintenanceCliOptions;
  statePath: string;
  logPath: string;
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
}): Promise<void> {
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
    return await withStoreWriterLease(writerStoreDir, async () => {
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
  options: TerminalMaintenanceCliOptions;
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
          !isSessionSendBlockingStatus(conversation.status)
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
        await nativeThreadLifecycleFacade.assertExclusive({
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

async function runClose(options: TerminalMaintenanceCliOptions): Promise<void> {
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
      const closeReason = stringValue(options.reason) ?? "closed by request";
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
  options: TerminalMaintenanceCliOptions;
  storeDir: string;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
}): Promise<
  | VerifiedDeadTerminalAgentProcessProof
  | undefined
> {
  if (!isSessionSendBlockingStatus(conversation.status)) {
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
  options: TerminalMaintenanceCliOptions;
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
      if (!isFinalDeferredForegroundTransferStatus(transfer.status)) {
        throw new Error(
          `terminal ${terminalControl.target} dispatch is fenced by deferred ` +
          `foreground transfer ${transfer.transfer_id} (${transfer.status}); ` +
          "generic terminal close cannot resolve it"
        );
      }
    }
    if (!isRecoverableTerminalDispatchStatus(String(ledger.status))) {
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

const terminalMaintenanceOperations = {
  runRenew,
  runCancel,
  runClose
};

export type TerminalMaintenanceCliFacade =
  Readonly<typeof terminalMaintenanceOperations>;

export function createTerminalMaintenanceCliFacade(
  dependencies: TerminalMaintenanceCliDependencies
): TerminalMaintenanceCliFacade {
  const runtime = Object.freeze({ dependencies });
  const call = <Result>(operation: () => Result): Result =>
    terminalMaintenanceContext.run(runtime, operation);
  return Object.freeze({
    runRenew: (options) => call(() => runRenew(options)),
    runCancel: (options) => call(() => runCancel(options)),
    runClose: (options) => call(() => runClose(options))
  });
}
