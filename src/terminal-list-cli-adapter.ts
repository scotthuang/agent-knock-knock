// Infrastructure composition for terminal list discovery and selector projection.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { CodexOpenRootRolloutInventory } from "./agent-session-provider.js";
import {
  listDeferredForegroundTransfers,
  type DeferredForegroundTransferSourceRolloutAuthority,
  type DeferredForegroundTransferSourceTurnAuthority
} from "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import {
  type ExecutorKind
} from "./executors.js";
import {
  humanObservedHandoffBindingToken,
  isExactNativeThreadId,
  managedSessionBindingToken,
  managedSessionRevision,
  unmanagedTerminalBindingToken,
  type HumanObservedHandoffTargetSnapshot,
  type ManagedSessionState,
  type NativeThreadTransition
} from "./managed-session.js";
import {
  executorForConversation,
  isSessionSendBlockingStatus,
  isTerminalDispatchOwnerReleasedStatus,
  resolveExecutor,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import {
  resolveSessionSelector,
  sessionShortRef,
  type SessionSelectorCandidate
} from "./session-selector.js";
import {
  projectSessionSelectorCandidate,
  type TerminalSelectorEntry
} from "./terminal-selector-projection-service.js";
import {
  listManagedSessions,
  loadNativeThreadTransition,
  nativeThreadTransitionsDir,
  tryLoadManagedSession
} from "./session-store.js";
import {
  defaultStoreDir,
  ensureStoreWritable,
  inspectStoreCompatibility,
  listConversations,
  STORE_SESSION_AUTHORITY_PROTOCOL
} from "./store.js";
import {
  type TerminalAgentAdapterRegistry,
  type ActiveTerminalProcess,
  type TerminalControlRef,
  type TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  exactCodexReadyStyledComposerCapture,
  TerminalAgentBridge,
  type ResolvedTerminalConversation,
  type TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import {
  captureCodexHumanStartedActiveTaskAnchor,
  type CodexRolloutAcceptanceIdentity
} from "./terminal-submission-acceptance.js";
import {
  applySessionAuthorityToDispatch,
  authoritativeTerminalIdentity,
  compareManagedConversationRecency,
  decideManagedTerminalAssociation,
  decideLocalTerminalDispatchOwnership,
  decideTerminalSendAuthority,
  decideTerminalSessionAuthorityConflict,
  managedTurnNeedsAttention as terminalManagedTurnNeedsAttention,
  nonOwnerTerminalActions,
  projectBlockingTurn,
  projectHandoffDecision,
  projectHandoffPresentation,
  projectPublicManagementConflict,
  projectReconcileBindingAction,
  projectTerminalDispatchConflict,
  projectTerminalManagement,
  selectManagedTerminalHistory,
  selectTerminalAvailableActions,
  type ConflictingManagedSessionClaim,
  type TerminalActionSet,
  type TerminalDispatchOwnership
} from "./terminal-action-projection.js";
import {
  childProcessIdsForRoot,
  decideManagedBindingConflict,
  deferredCodexForegroundBindingToken,
  exactBoundCodexSendSource,
  isCompleteNativeRollout,
  nativeAgentIdentityMatchesTurn,
  processIncarnationRelationship,
  selectRootTerminalProcesses,
  terminalControlAliasMatches,
  terminalControlsShareIncarnation,
  verifiedEmptyCodexHandoffToken,
  type CodexAllowedCompanionSet,
  type CodexSendAuthorityContext,
  type DeferredCodexForegroundDispatchSnapshot,
  type ManagedBindingConflictKind
} from "./terminal-authority-policy.js";
import {
  decideTerminalBindingMatch,
  terminalObservationFromListEntry,
  type TerminalNativeIdentity,
  type TerminalNativeIdentityObservation
} from "./terminal-binding-authority.js";
import {
  decideTerminalScopedCodexApprovalAuthority,
  terminalScopedCodexApprovalPromptSnapshot,
  type TerminalScopedCodexApprovalBoundary,
  type TerminalScopedCodexApprovalPromptSnapshot
} from "./terminal-scoped-approval-authority.js";
import {
  sameCanonicalStatePath,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import * as dispatch from "./terminal-dispatch-policy.js";
import {
  actionsForManagedSessionBinding,
  currentTerminalActions,
  listActionContracts,
  readOnlyListActions,
  readOnlyManagedTurn,
  userReleaseListActions,
  userReleasableManagedTurn,
  renderAvailableListActions,
  renderCurrentManagedTurn,
  renderHistoricalManagedTurn,
  renderManagedTurnListEntry,
  safeUnavailableManagedTurnActions,
  sendActionForManagedSession,
  withoutGenericHandoffSourceClose,
  type AvailableListActionFacts
} from "./terminal-list-renderer.js";
import type { TerminalProcessSource } from "./terminal-process-source.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalControlEvidenceMatches
} from "./terminal-control-ref.js";
import type { TerminalControlProvider } from "./terminal-control-provider.js";
import { validTerminalMonitorTimestampMs as validTimestampMs } from
  "./terminal-monitor-decision-policy.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import {
  expandHome,
  writeCliJson as printJson
} from "./cli-command-runtime.js";
import {
  cliCwd,
  cliNowMs,
  cliRuntimeLog as runtimeLog
} from "./cli-runtime-context.js";

interface JsonObject {
  [key: string]: unknown;
}

export interface TerminalListCliOptions {
  agent?: string;
  all?: boolean;
  conversation?: string;
  conversationId?: string;
  expectedTerminalToken?: string;
  logDir?: string;
  managedOnly?: boolean;
  noApprovalScan?: boolean;
  reconcile?: boolean;
  scrollbackLines?: number | string;
  session?: string;
  state?: string;
  status?: string;
  storeDir?: string;
  terminalDebug?: boolean;
  turn?: string;
  workspace?: string;
  [option: string]: unknown;
}

interface TerminalListMonitorReconciliation {
  checked: number;
  launched: number;
  repaired: number;
  collateral_stalls_checked: number;
  collateral_stalls_skipped: number;
  already_running: number;
  skipped: number;
  errors: number;
  items: Array<{ status?: string; [field: string]: unknown }>;
}

interface TerminalListIdleReconciliation {
  checked: number;
  closed: number;
  skipped: number;
  idle_timeout_minutes: number;
}

interface TerminalListNativeIdentityRequest {
  options: TerminalListCliOptions;
  agent: ExecutorKind;
  pid: number;
  cwd?: string;
  preferredSessionId?: string;
  allowedCompanionIdentity?: CodexAllowedCompanionSet["primary"];
  allowedAdditionalIdentities?: CodexAllowedCompanionSet["additional"];
}

interface DeferredCodexAuthorityObservation {
  sourceRolloutAuthority: DeferredForegroundTransferSourceRolloutAuthority;
  sourceTurnHistory?: DeferredForegroundTransferSourceTurnAuthority[];
  dispatchSnapshot?: DeferredCodexForegroundDispatchSnapshot;
  sourceAbandonmentFingerprint?: string;
  exactSource: boolean;
}

export interface TerminalListScanEntry {
  agent?: string;
  activity_state?: string;
  cwd?: string;
  id?: string;
  short_ref?: string;
  terminal_control?: { target?: string; [field: string]: unknown };
  workspace?: string;
  [field: string]: unknown;
}

export interface TerminalListScan {
  terminalControlled: TerminalListScanEntry[];
  summary: {
    error?: string;
    [field: string]: unknown;
  };
}

export type ExactTerminalListObservation =
  | {
      state: "available";
      rawTerminal: TerminalListScanEntry;
      terminal: TerminalListScanEntry;
      summary: TerminalListScan["summary"];
    }
  | {
      state: "absent";
      summary: TerminalListScan["summary"];
    }
  | {
      state: "unavailable";
      reason?: string;
      summary: TerminalListScan["summary"];
    };

type TerminalDispatchOwnershipResult = TerminalDispatchOwnership<
  Conversation,
  JsonObject
>;

type TerminalScopedCodexApprovalResolution =
  | { state: "unmanaged" }
  | { state: "eligible"; boundary: TerminalScopedCodexApprovalBoundary }
  | { state: "blocked"; reason: string };

export interface TerminalListReconciliationPorts {
  reconcileMonitors(
    options: TerminalListCliOptions,
    request: {
      includeCallbackRecovery: false;
      reason: "list_reconciliation";
      conversationId: undefined;
    }
  ): Promise<TerminalListMonitorReconciliation>;
  reconcileIdleConversations(
    storeDir: string,
    options: TerminalListCliOptions
  ): TerminalListIdleReconciliation;
}

export interface TerminalListDiscoveryPorts {
  createRuntimeTerminalAgentRegistry(
    options: TerminalListCliOptions
  ): TerminalAgentAdapterRegistry;
  createTerminalAgentBridge(
    options: TerminalListCliOptions,
    provider?: TerminalControlProvider,
    registry?: TerminalAgentAdapterRegistry
  ): TerminalAgentBridge;
  createTerminalControlProvider(
    options: TerminalListCliOptions
  ): TerminalControlProvider;
  createTerminalProcessSource(
    options: TerminalListCliOptions
  ): TerminalProcessSource;
  agentVersionForRunningProcess(
    agent: ExecutorKind,
    pid: number,
    options: TerminalListCliOptions
  ): string | undefined;
  codexLatentClearResumeObservation(request: {
    screen?: string;
    agentVersion?: string;
  }): { sourceNativeThreadId: string; fingerprint: string } | undefined;
  codexManagedIdentityResolutionContext(request: {
    storeDir: string;
    terminal: Pick<
      ResolvedTerminalConversation,
      "conversationId" | "agent" | "pid" | "terminalControl"
    >;
  }): {
    preferredSessionId?: string;
    companions: CodexAllowedCompanionSet;
  };
  codexProcessIncarnationForPid(pid: number): {
    processUuid: string;
    processBirth: string;
    evidence: "codex_process_birth";
  };
  inspectCodexOpenRootRolloutInventory(request: {
    options: TerminalListCliOptions;
    pid: number;
    cwd?: string;
  }): Promise<CodexOpenRootRolloutInventory>;
  nativeInspectionComposerEmpty(
    agent: ExecutorKind,
    screen: string | undefined
  ): boolean;
  observeCurrentNativeAgentSessionIdentity(
    request: TerminalListNativeIdentityRequest
  ): Promise<TerminalNativeIdentityObservation>;
  terminalStatusForControl(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    options: TerminalListCliOptions,
    runtime?: TerminalRuntimeIdentity
  ): ReturnType<TerminalAgentBridge["status"]>;
}

export interface TerminalListStoreObservationPorts {
  callbackRetryDisposition(delivery: unknown): { state: string };
  codexLingeringBeforeIdentityMatchesSession(request: {
    storeDir: string;
    session: ManagedSessionState;
    identity: TerminalNativeIdentity;
  }): boolean;
  isActiveStatus(status: unknown): boolean;
  isDiscoverableTmuxConversation(conversation: Conversation): boolean;
  isVerifiedDeadTerminalAgentProcess(conversation: Conversation | JsonObject): boolean;
  loadTerminalBridgeDispatchLedger(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined;
  loadTerminalDispatchLedgerOwner(
    ledger: TerminalDispatchLedgerDocument
  ): Conversation | undefined;
  listTerminalWatches?(
    storeDir: string,
    options?: { includeAll?: boolean }
  ): JsonObject[];
  scanTerminalWatchesForExactObservation?(
    storeDir: string,
    options?: { includeAll?: boolean }
  ): {
    watches: JsonObject[];
    activeOverlayTrusted: boolean;
  };
  managedSessionStoreDirForConversation(conversation: Conversation): string | undefined;
  managedTurnsForSession(storeDir: string, sessionId: string): Conversation[];
  matchesConfiguredWorkspace(configured: unknown, observed: unknown): boolean;
  orphanedTerminalDispatchForRecovery(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined;
  storeDirFromOptions(options: TerminalListCliOptions): string;
  summarizeConversation(conversation: Conversation): JsonObject;
  terminalBridgeEnabled(conversation: Conversation | JsonObject): boolean;
  terminalBridgeSubmission(
    conversation: Conversation | JsonObject | undefined
  ): {
    status?: string;
    message_id?: unknown;
    last_proven_stage?: unknown;
  } | undefined;
  terminalControlFromTakeover(value: unknown): TerminalControlRef | undefined;
  terminalDispatchRecordMatchesControl(
    ledger: TerminalDispatchLedgerDocument | undefined,
    terminalControl: TerminalControlRef,
    options?: { requireProcessAnchor?: boolean }
  ): boolean;
}

export interface TerminalListAuthorityPorts {
  activeTurnHandoffDecisionToken(request: {
    handoffToken: string;
    turn: Conversation;
    ledger?: TerminalDispatchLedgerDocument;
  }): string;
  assertManagedTerminalDispatchOwner(request: {
    storeDir: string;
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    action: "approve" | "cancel";
  }): void;
  observeDeferredCodexAuthority(request: {
    mode: "list";
    storeDir: string;
    context: CodexSendAuthorityContext;
    sourceSession?: ManagedSessionState;
    candidateInventory?: CodexOpenRootRolloutInventory;
    abandonment: "never" | "missing_rollout";
    requireUnclaimedCandidate: true;
  }): DeferredCodexAuthorityObservation | undefined;
  observedHandoffTargetResolution(request: {
    storeDir: string;
    agent: ExecutorKind;
    workspace: string;
    nativeThreadId: string;
    sourceSessionId: string;
  }):
    | {
        status: "eligible";
        session?: ManagedSessionState;
        snapshot: HumanObservedHandoffTargetSnapshot;
      }
    | { status: "blocked"; reason: string };
}

export interface TerminalListPolicyConfiguration {
  approvalTtlMs: number;
  selectorCommands: ReadonlySet<string>;
  rememberOriginalExpectedTerminalSelector(
    options: TerminalListCliOptions,
    selector: string | undefined
  ): void;
}

export interface TerminalListCliDependencies {
  reconciliation: TerminalListReconciliationPorts;
  discovery: TerminalListDiscoveryPorts;
  store: TerminalListStoreObservationPorts;
  authority: TerminalListAuthorityPorts;
  policy: TerminalListPolicyConfiguration;
}

export interface TerminalListCliFacade {
  runList(options: TerminalListCliOptions): Promise<void>;
  buildTerminalListGroup(request: {
    options: TerminalListCliOptions;
    agentFilter?: ExecutorKind;
    statusFilter?: string;
    terminalId?: string;
  }): Promise<TerminalListScan>;
  observeExactTerminal(request: {
    options: TerminalListCliOptions;
    terminalId: string;
  }): Promise<ExactTerminalListObservation>;
  provisionalManagedBindingTurnCount(
    storeDir: string,
    session: ManagedSessionState
  ): number | undefined;
  managedSessionHasUnresolvedNativeTransition(
    storeDir: string,
    session: ManagedSessionState
  ): boolean;
  managedSessionHasAnyNativeTransition(
    storeDir: string,
    session: ManagedSessionState
  ): boolean;
  terminalControlForManagedConversation(
    conversation: Conversation
  ): TerminalControlRef | undefined;
  terminalIncarnationBlockingTurns(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): Conversation[];
  managedTurnNeedsAttention(conversation: Conversation): boolean;
  assertTerminalIncarnationCanStartTurn(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): void;
  terminalDispatchOwnership(
    terminalControl: TerminalControlRef
  ): TerminalDispatchOwnershipResult;
  resolveTerminalScopedCodexApproval(request: {
    options: TerminalListCliOptions;
    terminal: ResolvedTerminalConversation;
    approvalSnapshot?: TerminalScopedCodexApprovalPromptSnapshot;
  }): Promise<TerminalScopedCodexApprovalResolution>;
  resolveConversationSelectorOption(
    commandName: string,
    options: TerminalListCliOptions
  ): Promise<void>;
}

type TerminalListRuntime =
  & TerminalListReconciliationPorts
  & TerminalListDiscoveryPorts
  & TerminalListStoreObservationPorts
  & TerminalListAuthorityPorts
  & TerminalListPolicyConfiguration;

const terminalListRuntimeContext = new AsyncLocalStorage<TerminalListRuntime>();

function terminalListRuntime(): TerminalListRuntime {
  const runtime = terminalListRuntimeContext.getStore();
  if (!runtime) {
    throw new Error("Terminal list facade runtime is unavailable");
  }
  return runtime;
}

function withTerminalListRuntime<Result>(
  runtime: TerminalListRuntime,
  operation: () => Result
): Result {
  return terminalListRuntimeContext.run(runtime, operation);
}

export function createTerminalListCliFacade(
  dependencies: TerminalListCliDependencies
): TerminalListCliFacade {
  const runtime: TerminalListRuntime = {
    ...dependencies.reconciliation,
    ...dependencies.discovery,
    ...dependencies.store,
    ...dependencies.authority,
    ...dependencies.policy
  };
  const call = <Result>(operation: () => Result): Result =>
    withTerminalListRuntime(runtime, operation);

  return {
    runList: (options) => call(() => runList(options)),
    buildTerminalListGroup: (request) => call(() => buildTerminalListGroup(request)),
    observeExactTerminal: (request) =>
      call(() => observeExactTerminal(request)),
    provisionalManagedBindingTurnCount: (storeDir, session) =>
      call(() => provisionalManagedBindingTurnCount(storeDir, session)),
    managedSessionHasUnresolvedNativeTransition: (storeDir, session) =>
      call(() => managedSessionHasUnresolvedNativeTransition(storeDir, session)),
    managedSessionHasAnyNativeTransition: (storeDir, session) =>
      call(() => managedSessionHasAnyNativeTransition(storeDir, session)),
    terminalControlForManagedConversation: (conversation) =>
      call(() => terminalControlForManagedConversation(conversation)),
    terminalIncarnationBlockingTurns: (storeDir, terminalControl) =>
      call(() => terminalIncarnationBlockingTurns(storeDir, terminalControl)),
    managedTurnNeedsAttention: (conversation) =>
      call(() => managedTurnNeedsAttention(conversation)),
    assertTerminalIncarnationCanStartTurn: (storeDir, terminalControl) =>
      call(() => assertTerminalIncarnationCanStartTurn(storeDir, terminalControl)),
    terminalDispatchOwnership: (terminalControl) =>
      call(() => terminalDispatchOwnership(terminalControl)),
    resolveTerminalScopedCodexApproval: (request) =>
      call(() => resolveTerminalScopedCodexApproval(request)),
    resolveConversationSelectorOption: (commandName, options) =>
      call(() => resolveConversationSelectorOption(commandName, options))
  };
}

function projectSelectorCandidate(
  entry: TerminalSelectorEntry,
  commandName: string,
  observedAtMs: number,
  options: { defaultActionable: boolean; mutationsAllowed: boolean }
) {
  return projectSessionSelectorCandidate(
    entry,
    commandName,
    observedAtMs,
    options,
    { isActiveStatus: terminalListRuntime().isActiveStatus }
  );
}

async function runList(options: TerminalListCliOptions) {
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(cliCwd()));
  const store = inspectStoreCompatibility(storeDir);
  const reconciliation = options.reconcile === true
    ? await reconcileStoreForList(storeDir, options)
    : {
        status: "disabled",
        reason: "standalone list is read-only unless --reconcile is supplied"
      };
  const agentFilter = options.agent ? resolveExecutor({ kind: options.agent }).kind : undefined;
  const statusFilter = options.status;
  const terminalScan = await buildTerminalListGroup({ options, agentFilter, statusFilter });
  const projected = projectTerminalListScan({
    options,
    storeDir,
    store,
    terminalScan,
    agentFilter,
    statusFilter
  });

  printJson({
    store_dir: storeDir,
    store,
    reconciliation,
    action_contracts: listActionContracts(),
    terminals: projected.terminals,
    terminal_watches: projected.terminalWatches,
    unavailable_managed_turns: projected.unavailableManagedTurns,
    terminal_scan: {
      ...terminalScan.summary,
      terminal_count: projected.terminals.length
    }
  });
  runtimeLog("info", "terminals_listed", {
    store_dir: storeDir,
    terminal_count: projected.terminals.length,
    unavailable_managed_turn_count: projected.unavailableManagedTurns.length,
    terminal_scan_error: terminalScan.summary.error,
    include_all: projected.includeAll,
    agent_filter: agentFilter,
    status_filter: statusFilter,
    reconciliation
  });
}

function projectTerminalListScan(input: {
  options: TerminalListCliOptions;
  storeDir: string;
  store: ReturnType<typeof inspectStoreCompatibility>;
  terminalScan: TerminalListScan;
  agentFilter?: ExecutorKind;
  statusFilter?: string;
  tolerateInvalidWatchRecords?: boolean;
}) {
  const {
    options,
    storeDir,
    store,
    terminalScan,
    agentFilter,
    statusFilter,
    tolerateInvalidWatchRecords
  } = input;
  const includeAll = Boolean(options.all);
  const allManagedConversations = listConversations(storeDir)
    .filter(terminalListRuntime().isDiscoverableTmuxConversation);
  const managedSessions = store.readable
    ? listManagedSessions(storeDir)
    : [];
  const displayedConversations = allManagedConversations
    .filter((conversation) =>
      includeAll || terminalListRuntime().isActiveStatus(conversation.status)
    )
    .filter((conversation) =>
      terminalListRuntime().matchesConfiguredWorkspace(
        options.workspace,
        conversation.workspace
      )
    )
    .filter((conversation) =>
      !agentFilter || executorForConversation(conversation).kind === agentFilter
    )
    .filter((conversation) =>
      !statusFilter || conversation.status === statusFilter
    );
  const workspaceConversations = allManagedConversations.filter((conversation) =>
    terminalListRuntime().matchesConfiguredWorkspace(
      options.workspace,
      conversation.workspace
    )
  );
  const physicalTerminals = terminalScan.terminalControlled.filter((entry) =>
    terminalListRuntime().matchesConfiguredWorkspace(
      options.workspace,
      entry.workspace ?? entry.cwd
    )
  );
  const projection = terminalFirstListProjection({
    storeDir,
    terminals: physicalTerminals,
    managedSessions,
    sessionAuthorityRequired:
      Number(store.writer_protocol) >= STORE_SESSION_AUTHORITY_PROTOCOL,
    allConversations: workspaceConversations,
    displayedConversations,
    includeAll,
    managedOnly: options.managedOnly === true,
    statusFilter,
    mutationsAllowed: store.writable === true
  });
  const exactWatchScan = terminalListRuntime()
    .scanTerminalWatchesForExactObservation;
  const watchObservation = tolerateInvalidWatchRecords && exactWatchScan
    ? exactWatchScan(storeDir, { includeAll })
    : {
        watches: terminalListRuntime().listTerminalWatches?.(
          storeDir,
          { includeAll }
        ) ?? [],
        activeOverlayTrusted: true
      };
  const observedTerminalWatches = watchObservation.watches;
  const terminalWatches = options.managedOnly
    ? []
    : observedTerminalWatches
      .filter((watch) => !agentFilter || watch.agent === agentFilter)
      .filter((watch) => terminalListRuntime().matchesConfiguredWorkspace(
        options.workspace,
        watch.workspace
      ))
      .filter((watch) => !statusFilter || watch.status === statusFilter);
  const activeWatchedTerminals = new Set(
    observedTerminalWatches
      .filter((watch) => watch.status === "active")
      .map((watch) => stringValue(watch.terminal_id))
      .filter((terminalId): terminalId is string => terminalId !== undefined)
  );
  const terminals = projection.terminals.map((terminal) =>
    !watchObservation.activeOverlayTrusted ||
      activeWatchedTerminals.has(stringValue(terminal.id) ?? "")
      ? withoutTerminalWatchAuthority(terminal)
      : terminal
  );
  return {
    includeAll,
    terminals,
    terminalWatches,
    unavailableManagedTurns: projection.unavailableManagedTurns
  };
}

async function observeExactTerminal(request: {
  options: TerminalListCliOptions;
  terminalId: string;
}): Promise<ExactTerminalListObservation> {
  const { options, terminalId } = request;
  const storeDir = expandHome(
    options.storeDir ?? options.logDir ?? defaultStoreDir(cliCwd())
  );
  const store = inspectStoreCompatibility(storeDir);
  const scan = await buildTerminalListGroup({ options, terminalId });
  const matches = scan.terminalControlled.filter(
    (terminal) => stringValue(terminal.id) === terminalId
  );
  if (matches.length !== 1) {
    return scan.summary.error
      ? {
          state: "unavailable",
          reason: scan.summary.error,
          summary: scan.summary
        }
      : { state: "absent", summary: scan.summary };
  }
  const projected = projectTerminalListScan({
    options,
    storeDir,
    store,
    terminalScan: scan,
    tolerateInvalidWatchRecords: true
  });
  const projectedMatches = projected.terminals.filter(
    (terminal) => stringValue(terminal.id) === terminalId
  );
  if (projectedMatches.length !== 1) {
    return {
      state: "unavailable",
      reason: "the exact terminal could not be projected authoritatively",
      summary: scan.summary
    };
  }
  return {
    state: "available",
    rawTerminal: matches[0],
    terminal: projectedMatches[0],
    summary: scan.summary
  };
}

function withoutAvailableAction(
  terminal: JsonObject,
  action: string
): JsonObject {
  if (!isRecord(terminal.available_actions)) return terminal;
  const actions = { ...terminal.available_actions };
  delete actions[action];
  return { ...terminal, available_actions: actions };
}

function withoutTerminalWatchAuthority(terminal: JsonObject): JsonObject {
  const projected = withoutAvailableAction(terminal, "watch");
  if (!Object.hasOwn(projected, "terminal_watch_hint")) return projected;
  const safe = { ...projected };
  delete safe.terminal_watch_hint;
  return safe;
}

async function reconcileStoreForList(storeDir, options) {
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

  const monitors = await terminalListRuntime().reconcileMonitors(options, {
    includeCallbackRecovery: false,
    reason: "list_reconciliation",
    conversationId: undefined
  });
  const idle = terminalListRuntime().reconcileIdleConversations(storeDir, options);
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

async function buildTerminalListGroup({
  options,
  agentFilter,
  statusFilter,
  terminalId
}: {
  options: TerminalListCliOptions;
  agentFilter?: ExecutorKind;
  statusFilter?: string;
  terminalId?: string;
}): Promise<TerminalListScan> {
  const empty = {
    terminalControlled: [],
    summary: {
      enabled: false,
      agents: [],
      error: undefined
    }
  };
  if (options.managedOnly) {
    return empty;
  }
  const registry = terminalListRuntime().createRuntimeTerminalAgentRegistry(options);
  const adapters = agentFilter
    ? [registry.get(agentFilter)].filter((adapter) => adapter !== undefined)
    : registry.list();
  if (agentFilter && adapters.length === 0) {
    return {
      ...empty,
      summary: {
        enabled: true,
        agents: [],
        skipped: `terminal agent adapter is not registered for ${agentFilter}`
      }
    };
  }

  const terminalProvider = terminalListRuntime().createTerminalControlProvider(options);
  const bridge: TerminalAgentBridge = terminalListRuntime().createTerminalAgentBridge(
    options,
    terminalProvider,
    registry
  );
  const terminalDiagnostics = options.terminalDebug
    ? await terminalControlDiagnostics(terminalProvider)
    : undefined;
  const terminalControlled: Record<string, any>[] = [];
  let activeCount = 0;
  const errors: string[] = [];
  try {
    const processSource = terminalListRuntime().createTerminalProcessSource(options);
    const snapshots = await processSource.listProcessSnapshots((snapshot) =>
      adapters.some((adapter) =>
        adapter.capabilities.processDiscovery && adapter.classifyProcess(snapshot) !== undefined
      ),
      { includeAncestors: true }
    );
    const activeSessions: ActiveTerminalProcess[] = await bridge.listProcesses(
      snapshots,
      adapters.map((adapter) => adapter.agent)
    );
    const rootSessions = selectRootTerminalProcesses(activeSessions);
    const controlledSessions = rootSessions.filter(
      (session) => session.terminalControl !== undefined
    );
    activeCount = controlledSessions.length;
    const selectedSessions = terminalId
      ? controlledSessions.filter(
          (session) => bridge.terminalConversationId(session) === terminalId
        )
      : controlledSessions;
    for (const session of selectedSessions) {
      try {
        terminalControlled.push(await terminalControlledListEntry(
          session,
          activeSessions,
          options,
          bridge
        ));
      } catch (error) {
        errors.push(
          `terminal process ${session.pid}: ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    terminalControlled,
    summary: {
      enabled: true,
      agents: adapters.map((adapter) => adapter.agent),
      active_count: activeCount,
      terminal_count: terminalControlled.length,
      approval_scan: options.noApprovalScan ? "disabled" : "enabled",
      diagnostics: terminalDiagnostics,
      error: errors.length > 0 ? errors.join("; ") : undefined
    }
  };
}

async function terminalControlDiagnostics(provider: TerminalControlProvider) {
  return provider.diagnostics();
}

function managedTurnListEntry(
  task: Record<string, any>,
  {
    terminalBridge = false,
    approvalState,
    conversation
  }: {
    terminalBridge?: boolean;
    approvalState?: Record<string, any>;
    conversation?: Record<string, any>;
  } = {}
): Record<string, any> {
  return renderManagedTurnListEntry(task, {
    terminalBridge,
    approvalState,
    actionFacts: managedTurnListActionFacts(task, conversation)
  });
}

function managedTurnListActionFacts(
  task: Record<string, any>,
  conversation?: Record<string, any>
): AvailableListActionFacts {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const managedApprovalPending = isRecord(
    nativeTakeover?.terminal_bridge_approval
  );
  const terminalBridgeReady = Boolean(
    conversation &&
    terminalListRuntime().terminalBridgeEnabled(conversation) &&
    terminalListRuntime().terminalControlFromTakeover(nativeTakeover) !== undefined
  );
  const submission = terminalListRuntime().terminalBridgeSubmission(
    conversation
  );
  const renewEligible = Boolean(
    terminalBridgeReady &&
    task.status === "stalled" &&
    submission?.status !== "uncertain" &&
    !terminalListRuntime().isVerifiedDeadTerminalAgentProcess(conversation ?? {})
  );
  const callbackDelivery = isRecord(conversation?.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const retryCallbackEligible = Boolean(
    conversation &&
    conversation.legacy_callback_status_error === undefined &&
    terminalListRuntime().callbackRetryDisposition(callbackDelivery).state ===
      "retryable"
  );
  const retrySubmissionCandidate = Boolean(
    conversation &&
    executorForConversation(conversation as Conversation).kind === "codex" &&
    terminalBridgeReady &&
    task.status === "stalled" &&
    submission?.status === "uncertain" &&
    stringValue(submission.last_proven_stage) === "text_injected"
  );
  return {
    terminalBridgeReady,
    managedApprovalPending,
    renewEligible,
    retryCallbackEligible,
    retrySubmissionCandidate
  };
}

async function terminalControlledListEntry(
  session: ActiveTerminalProcess,
  activeSessions: ActiveTerminalProcess[],
  options,
  bridge: TerminalAgentBridge = terminalListRuntime().createTerminalAgentBridge(options)
) {
  const terminalControl = session.terminalControl;
  if (!terminalControl) {
    throw new Error(`process ${session.pid} is not terminal-controlled`);
  }
  const terminalState = await listStateForTerminal(
    session.agent,
    terminalControl,
    options,
    bridge,
    {
      pid: session.pid,
      cwd: session.cwd,
      // Raw Codex status and approval use the exact full terminal selector as
      // their runtime conversation identity. Use the same identity while
      // projecting list actions so a prompt-bound terminal token can be
      // revalidated by the later status/approve calls.
      ...(session.agent === "codex"
        ? { conversationId: bridge.terminalConversationId(session) }
        : { sessionId: session.sessionId }),
      terminalTarget: terminalControl.target
    }
  );
  const {
    orphanedDispatch,
    nativeIdentityObservation,
    nativeAgentIdentity,
    codexOpenRootRolloutInventory,
    nativeProcessUuid,
    nativeProcessBirth,
    nativeProcessEvidence
  } = await observeTerminalNativeListIdentity(
    session,
    terminalControl,
    options,
    bridge
  );
  const effectiveTerminalState = effectiveTerminalListState({
    session,
    terminalState,
    nativeIdentityObservation,
    nativeAgentIdentity,
    nativeProcessUuid,
    nativeProcessBirth
  });
  const terminalStatusSnapshot = effectiveTerminalState._terminal_status_snapshot
    ? terminalBridgeStatusWithActivity(
        effectiveTerminalState._terminal_status_snapshot,
        effectiveTerminalState.activity_state,
        effectiveTerminalState.activity_reason
      )
    : undefined;
  const statusCardObservation = session.agent === "codex" &&
      typeof effectiveTerminalState.screen_excerpt === "string"
    ? bridge.registry.require("codex").observeThreadLifecycle?.({
        operation: { kind: "new_thread" },
        phase: "before",
        screen: effectiveTerminalState.screen_excerpt
      })
    : undefined;
  const statusCardNativeThreadId =
    statusCardObservation?.status === "observed" &&
      effectiveTerminalState.activity_state === "idle" &&
      effectiveTerminalState.approval_state.blocked !== true &&
      isExactNativeThreadId(statusCardObservation.nativeThreadId)
      ? statusCardObservation.nativeThreadId
      : undefined;
  const agentVersion = terminalListRuntime().agentVersionForRunningProcess(
    session.agent,
    session.pid,
    options
  );
  const lifecycleCapability = bridge.registry.require(session.agent)
    .probeThreadLifecycle?.(agentVersion) ?? {
      status: "unsupported" as const,
      agentVersion,
      newThread: false,
      resumeExact: false,
      reason: "native thread lifecycle is unavailable"
    };
  const nativeInspectionCapability = bridge.registry.require(session.agent)
    .probeNativeInspection?.(agentVersion) ?? {
      status: "unsupported" as const,
      agentVersion,
      statusInspection: false,
      reason: "native inspection is unavailable"
    };
  const codexLatentClearResumeObservationValue = session.agent === "codex"
    ? terminalListRuntime().codexLatentClearResumeObservation({
        screen: effectiveTerminalState.screen_excerpt,
        agentVersion
      })
    : undefined;
  const lifecycleBindingToken = unmanagedTerminalBindingToken({
    terminalId: bridge.terminalConversationId(session),
    terminalControl,
    agent: session.agent,
    pid: session.pid,
    workspace: session.cwd ?? terminalControl.currentPath ?? cliCwd(),
    nativeThreadId: nativeAgentIdentity?.sessionId,
    processUuid: nativeProcessUuid,
    processBirth: nativeProcessBirth,
    rollout: nativeAgentIdentity?.rollout
  });
  const codexLifecycleIncarnationAvailable =
    session.agent !== "codex" ||
    Boolean(nativeProcessUuid && nativeProcessBirth);
  const terminalHasBlockingTurn = terminalIncarnationBlockingTurns(
    terminalListRuntime().storeDirFromOptions(options),
    terminalControl
  ).length > 0;
  const automatedInputComposerReady = await observeAutomatedInputComposerReady({
    session,
    terminalControl,
    terminalState: effectiveTerminalState,
    nativeIdentityObservation,
    codexOpenRootRolloutInventory,
    options
  });
  const entry = {
    id: bridge.terminalConversationId(session),
    short_ref: sessionShortRef(bridge.terminalConversationId(session)),
    source: "terminal",
    agent: session.agent,
    process_state: "active",
    pid: session.pid,
    child_pids: childProcessIdsForRoot(session, activeSessions),
    command: session.command,
    cwd: session.cwd,
    workspace: session.cwd,
    elapsed: session.elapsed,
    native_agent_session_id: nativeAgentIdentity?.sessionId,
    native_agent_status_card_session_id: statusCardNativeThreadId,
    native_agent_process_uuid: nativeProcessUuid,
    native_agent_process_birth: nativeProcessBirth,
    native_agent_rollout: nativeAgentIdentity?.rollout,
    native_agent_identity_evidence: nativeProcessEvidence,
    native_agent_identity_observation: {
      status: nativeIdentityObservation.status,
      ...(nativeIdentityObservation.status === "unavailable"
        ? { reason: nativeIdentityObservation.reason }
        : nativeIdentityObservation.status === "verified_absent"
          ? { evidence: nativeIdentityObservation.evidence }
          : {})
    },
    agent_version: agentVersion,
    native_thread_lifecycle: lifecycleCapability,
    native_inspection: nativeInspectionCapability,
    lifecycle_binding_token: lifecycleBindingToken,
    confidence: session.confidence,
    reason: session.reason,
    terminal_control: terminalControl,
    approval_state: effectiveTerminalState.approval_state,
    activity_state: effectiveTerminalState.activity_state,
    activity_reason: effectiveTerminalState.activity_reason,
    // Internal exact-observation evidence. The public projection strips this
    // object; raw terminal status reuses it so screen, approval, and activity
    // all describe the same capture.
    ...(terminalStatusSnapshot
      ? { _terminal_status_snapshot: terminalStatusSnapshot }
      : {}),
    // Internal action-projection evidence. terminalFirstListProjection strips
    // this field after gating every automated-input action that can follow a
    // human native-thread switch.
    _automated_input_composer_ready: automatedInputComposerReady,
    ...(codexLatentClearResumeObservationValue
      ? {
          _codex_latent_clear_resume: {
            source_native_thread_id:
              codexLatentClearResumeObservationValue.sourceNativeThreadId,
            fingerprint: codexLatentClearResumeObservationValue.fingerprint
          }
        }
      : {}),
    ...(codexOpenRootRolloutInventory
      ? {
          _codex_open_root_rollout_inventory:
            codexOpenRootRolloutInventory
        }
      : {}),
    ...(orphanedDispatch
      ? {
          orphaned_terminal_dispatch: {
            kind: stringValue(orphanedDispatch.kind) ?? "turn",
            status: orphanedDispatch.status,
            owner_conversation_id:
              stringValue(orphanedDispatch.conversation_id),
            message_id: stringValue(orphanedDispatch.message_id),
            transition_id: stringValue(orphanedDispatch.transition_id),
            recovery:
              `/akk close ${bridge.terminalConversationId(session)} ` +
              (orphanedDispatch.kind === "lifecycle"
                ? `--expected-transition-id ${String(
                    orphanedDispatch.transition_id
                  )}`
                : `--expected-message-id ${String(
                    orphanedDispatch.message_id
                  )}`)
          }
        }
      : {}),
    commands: terminalListCommands({
      agent: session.agent,
      terminalControl,
      terminalState: effectiveTerminalState,
      lifecycleCapability,
      nativeInspectionCapability,
      nativeAgentIdentity,
      nativeProcessUuid,
      nativeProcessBirth,
      codexLifecycleIncarnationAvailable,
      automatedInputComposerReady,
      hasOrphanedDispatch: orphanedDispatch !== undefined,
      terminalHasBlockingTurn
    })
  };
  const availableActions = renderAvailableListActions(entry);
  const { commands: _commands, ...publicEntry } = entry;
  return {
    ...publicEntry,
    available_actions: availableActions
  };
}

function terminalListCommands(input: {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  terminalState: TerminalListState;
  lifecycleCapability: {
    status: string;
    newThread: boolean;
    resumeExact: boolean;
  };
  nativeInspectionCapability: {
    status: string;
    statusInspection: boolean;
  };
  nativeAgentIdentity?: TerminalNativeIdentity;
  nativeProcessUuid?: string;
  nativeProcessBirth?: string;
  codexLifecycleIncarnationAvailable: boolean;
  automatedInputComposerReady: boolean;
  hasOrphanedDispatch: boolean;
  terminalHasBlockingTurn: boolean;
}) {
  const {
    agent,
    terminalControl,
    terminalState,
    lifecycleCapability,
    nativeInspectionCapability,
    nativeAgentIdentity,
    nativeProcessUuid,
    nativeProcessBirth,
    codexLifecycleIncarnationAvailable,
    automatedInputComposerReady,
    hasOrphanedDispatch,
    terminalHasBlockingTurn
  } = input;
  return {
    send: !terminalHasBlockingTurn,
    approve: terminalControl.capabilities.includes("terminal_approval") &&
      terminalState.approval_state.approvable === true,
    status: true,
    cancel: terminalControl.capabilities.includes("terminal_cancel"),
    close: hasOrphanedDispatch,
    new_thread:
      lifecycleCapability.status === "supported" &&
      lifecycleCapability.newThread === true &&
      codexLifecycleIncarnationAvailable &&
      !terminalHasBlockingTurn,
    list_resumable_threads:
      lifecycleCapability.status === "supported" &&
      lifecycleCapability.resumeExact === true &&
      codexLifecycleIncarnationAvailable,
    native_inspect:
      nativeInspectionCapability.status === "supported" &&
      nativeInspectionCapability.statusInspection === true &&
      terminalState.activity_state === "idle" &&
      automatedInputComposerReady &&
      terminalControl.capabilities.includes("send_keys") &&
      terminalControl.capabilities.includes("screen_status") &&
      (
        agent === "codex"
          ? codexLifecycleIncarnationAvailable
          : Boolean(
              nativeAgentIdentity?.sessionId &&
              nativeAgentIdentity.processUuid
            )
      ) &&
      !hasOrphanedDispatch &&
      !terminalHasBlockingTurn,
    watch:
      lifecycleCapability.status === "supported" &&
      (terminalState.activity_state === "working" ||
        terminalState.activity_state === "awaiting_approval") &&
      Boolean(nativeAgentIdentity?.sessionId) &&
      (agent !== "codex" || Boolean(nativeAgentIdentity?.rollout)) &&
      Boolean(nativeProcessUuid) &&
      Boolean(nativeProcessBirth) &&
      !hasOrphanedDispatch &&
      !terminalHasBlockingTurn
  };
}

interface TerminalListState {
  approval_state: TerminalBridgeStatus["approval_state"] & {
    screen_excerpt?: string;
    error?: string;
  };
  activity_state: TerminalBridgeStatus["activity_state"];
  activity_reason: string;
  capability_limitation?: string;
  screen_excerpt?: string;
  _terminal_status_snapshot?: TerminalBridgeStatus;
}

function effectiveTerminalListState(input: {
  session: ActiveTerminalProcess;
  terminalState: TerminalListState;
  nativeIdentityObservation: TerminalNativeIdentityObservation;
  nativeAgentIdentity?: TerminalNativeIdentity;
  nativeProcessUuid?: string;
  nativeProcessBirth?: string;
}): TerminalListState {
  const {
    session,
    terminalState,
    nativeIdentityObservation,
    nativeAgentIdentity,
    nativeProcessUuid,
    nativeProcessBirth
  } = input;
  if (
    session.agent !== "codex" ||
    terminalState.activity_state === "working" ||
    terminalState.activity_state === "awaiting_approval" ||
    terminalState.approval_state.blocked === true
  ) {
    return terminalState;
  }
  if (nativeIdentityObservation.status === "verified_absent") {
    return terminalState;
  }
  if (
    nativeIdentityObservation.status !== "resolved" ||
    !nativeAgentIdentity?.rollout ||
    !nativeAgentIdentity.sessionId ||
    !nativeProcessUuid ||
    !nativeProcessBirth
  ) {
    return terminalListStateWithUnavailableDurableActivity(
      terminalState,
      nativeIdentityObservation.status === "unavailable"
        ? nativeIdentityObservation.reason ??
          "exact Codex identity observation failed"
        : "exact Codex rollout/process identity is incomplete"
    );
  }
  const currentIdentity: CodexRolloutAcceptanceIdentity = {
    sessionId: nativeAgentIdentity.sessionId,
    processUuid: nativeProcessUuid,
    processBirth: nativeProcessBirth,
    rollout: nativeAgentIdentity.rollout
  };
  try {
    if (!captureCodexHumanStartedActiveTaskAnchor({ currentIdentity })) {
      return terminalState;
    }
    return {
      ...terminalState,
      activity_state: "working",
      activity_reason:
        "Codex rollout contains an exact unfinished human-started task"
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    runtimeLog("warn", "terminal_durable_activity_unavailable", {
      agent: session.agent,
      pid: session.pid,
      reason
    });
    return terminalListStateWithUnavailableDurableActivity(
      terminalState,
      reason
    );
  }
}

function terminalListStateWithUnavailableDurableActivity(
  terminalState: TerminalListState,
  reason: string
): TerminalListState {
  return {
    ...terminalState,
    activity_state: "unknown",
    activity_reason:
      `durable Codex activity evidence is unavailable: ${reason}`
  };
}

function terminalBridgeStatusWithActivity(
  status: TerminalBridgeStatus,
  activityState: TerminalBridgeStatus["activity_state"],
  activityReason: string
): TerminalBridgeStatus {
  const descriptors = Object.getOwnPropertyDescriptors(status);
  descriptors.activity_state = {
    configurable: true,
    enumerable: true,
    value: activityState,
    writable: true
  };
  descriptors.activity_reason = {
    configurable: true,
    enumerable: true,
    value: activityReason,
    writable: true
  };
  return Object.create(
    Object.getPrototypeOf(status),
    descriptors
  ) as TerminalBridgeStatus;
}

interface TerminalNativeListIdentityObservation {
  orphanedDispatch?: TerminalDispatchLedgerDocument;
  nativeIdentityObservation: TerminalNativeIdentityObservation;
  nativeAgentIdentity?: TerminalNativeIdentity;
  codexOpenRootRolloutInventory?: CodexOpenRootRolloutInventory;
  nativeProcessUuid?: string;
  nativeProcessBirth?: string;
  nativeProcessEvidence?: string;
}

async function observeTerminalNativeListIdentity(
  session: ActiveTerminalProcess,
  terminalControl: TerminalControlRef,
  options: TerminalListCliOptions,
  bridge: TerminalAgentBridge
): Promise<TerminalNativeListIdentityObservation> {
  const orphanedDispatch =
    terminalListRuntime().orphanedTerminalDispatchForRecovery(terminalControl);
  let codexIdentityContext:
    | ReturnType<TerminalListDiscoveryPorts["codexManagedIdentityResolutionContext"]>
    | undefined;
  if (session.agent === "codex") {
    try {
      codexIdentityContext = terminalListRuntime().codexManagedIdentityResolutionContext({
        storeDir: terminalListRuntime().storeDirFromOptions(options),
        terminal: {
          conversationId: bridge.terminalConversationId(session),
          agent: session.agent,
          pid: session.pid,
          terminalControl
        }
      });
    } catch (error) {
      // Preserve generic discovery when Store hints are unavailable. Once an
      // exact hint exists, however, the constrained resolver below must fail
      // closed rather than retrying without its managed lineage fences.
      runtimeLog("warn", "terminal_managed_identity_context_unavailable", {
        agent: session.agent,
        terminal_target: terminalControl.target,
        pid: session.pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const nativeIdentityObservation =
    await terminalListRuntime().observeCurrentNativeAgentSessionIdentity({
      options,
      agent: session.agent,
      pid: session.pid,
      cwd: session.cwd ?? terminalControl.currentPath,
      preferredSessionId: codexIdentityContext?.preferredSessionId,
      allowedCompanionIdentity: codexIdentityContext?.companions.primary,
      allowedAdditionalIdentities: codexIdentityContext?.companions.additional
    });
  const nativeAgentIdentity = nativeIdentityObservation.status === "resolved"
    ? nativeIdentityObservation.identity
    : undefined;
  let codexOpenRootRolloutInventory:
    | CodexOpenRootRolloutInventory
    | undefined;
  if (session.agent === "codex") {
    try {
      const inventory = await terminalListRuntime().inspectCodexOpenRootRolloutInventory({
        options,
        pid: session.pid,
        cwd: session.cwd ?? terminalControl.currentPath
      });
      if (inventory.roots.length > 0) {
        codexOpenRootRolloutInventory = inventory;
      }
    } catch (error) {
      runtimeLog("warn", "terminal_codex_open_root_inventory_unavailable", {
        terminal_target: terminalControl.target,
        pid: session.pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (nativeIdentityObservation.status === "unavailable") {
    runtimeLog("warn", "terminal_native_session_identity_unavailable", {
      agent: session.agent,
      terminal_target: terminalControl.target,
      pid: session.pid,
      error: nativeIdentityObservation.reason
    });
  }
  let nativeProcessUuid = nativeAgentIdentity?.processUuid;
  let nativeProcessBirth = nativeAgentIdentity?.processBirth;
  let nativeProcessEvidence = nativeAgentIdentity?.evidence;
  if (codexOpenRootRolloutInventory) {
    nativeProcessUuid = codexOpenRootRolloutInventory.processUuid;
    nativeProcessBirth = codexOpenRootRolloutInventory.processBirth;
    nativeProcessEvidence = "codex_open_root_rollout_inventory";
  }
  if (
    session.agent === "codex" &&
    (!nativeProcessUuid || !nativeProcessBirth)
  ) {
    try {
      const incarnation = terminalListRuntime().codexProcessIncarnationForPid(session.pid);
      nativeProcessUuid = incarnation.processUuid;
      nativeProcessBirth = incarnation.processBirth;
      nativeProcessEvidence = nativeProcessEvidence ?? incarnation.evidence;
    } catch (error) {
      runtimeLog("warn", "terminal_process_incarnation_unavailable", {
        agent: session.agent,
        terminal_target: terminalControl.target,
        pid: session.pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    orphanedDispatch,
    nativeIdentityObservation,
    nativeAgentIdentity,
    codexOpenRootRolloutInventory,
    nativeProcessUuid,
    nativeProcessBirth,
    nativeProcessEvidence
  };
}

async function observeAutomatedInputComposerReady({
  session,
  terminalControl,
  terminalState,
  nativeIdentityObservation,
  codexOpenRootRolloutInventory,
  options
}: {
  session: ActiveTerminalProcess;
  terminalControl: TerminalControlRef;
  terminalState: Awaited<ReturnType<typeof listStateForTerminal>>;
  nativeIdentityObservation: TerminalNativeIdentityObservation;
  codexOpenRootRolloutInventory?: CodexOpenRootRolloutInventory;
  options: TerminalListCliOptions;
}): Promise<boolean> {
  let ready = terminalListRuntime().nativeInspectionComposerEmpty(
    session.agent,
    terminalState.screen_excerpt
  );
  if (
    session.agent !== "codex" ||
    (
      terminalState.activity_state !== "idle" &&
      (
        terminalState.activity_state !== "unknown" ||
        (
          nativeIdentityObservation.status !== "verified_absent" &&
          codexOpenRootRolloutInventory === undefined
        )
      )
    ) ||
    terminalState.approval_state.blocked === true ||
    !terminalControl.capabilities.includes("send_keys") ||
    !terminalControl.capabilities.includes("screen_status")
  ) {
    return ready;
  }
  try {
    const provider = terminalListRuntime().createTerminalControlProvider(options);
    const resolvedTerminal = await provider.resolve(
      provider.endpoint(terminalControl)
    );
    const styledScreen = await provider.capture(
      resolvedTerminal,
      { scrollbackLines: 40, preserveEscapes: true }
    );
    ready = exactCodexReadyStyledComposerCapture(styledScreen) !== undefined;
  } catch {
    // Advertising an input action is optional. The action itself repeats the
    // same styled composer proof under the terminal lock before any input.
    ready = false;
  }
  return ready;
}

type TerminalFirstListContext = {
  storeDir: string;
  terminals: Record<string, any>[];
  managedSessions: ManagedSessionState[];
  sessionAuthorityRequired: boolean;
  allConversations: Conversation[];
  displayedConversations: Conversation[];
  includeAll: boolean;
  mutationsAllowed: boolean;
  nonterminalDeferredTransfers: ReturnType<
    typeof listDeferredForegroundTransfers
  >;
  conversationHasNonterminalDeferredTransfer: (
    conversation: Conversation
  ) => boolean;
};

function observeTerminalListBindingAuthority(
  terminal: Record<string, any>,
  context: TerminalFirstListContext
) {
  const {
    storeDir,
    managedSessions,
    allConversations,
    displayedConversations,
    mutationsAllowed,
    nonterminalDeferredTransfers
  } = context;
  const {
    _automated_input_composer_ready: automatedInputComposerReady,
    _codex_open_root_rollout_inventory: codexOpenRootRolloutInventoryValue,
    _codex_latent_clear_resume: codexLatentClearResumeValue,
    _terminal_status_snapshot: _terminalStatusSnapshot,
    ...publicTerminal
  } = terminal;
  const codexOpenRootRolloutInventory = isRecord(
    codexOpenRootRolloutInventoryValue
  )
    ? codexOpenRootRolloutInventoryValue as unknown as
        CodexOpenRootRolloutInventory
    : undefined;
  const terminalControl = isRecord(terminal.terminal_control)
    ? terminal.terminal_control as unknown as TerminalControlRef
    : undefined;
  const terminalHasNonterminalDeferredTransfer = Boolean(
    terminalControl && nonterminalDeferredTransfers.some((transfer) =>
      transfer.terminal_id === String(terminal.id) &&
      transfer.process_pid === Number(terminal.pid) &&
      terminalControlEvidenceMatches(
        transfer.terminal_endpoint,
        terminalControl
      )
    )
  );
  const allRelated = terminalControl
    ? allConversations.filter((conversation) =>
        terminalControlsShareIncarnation(
          terminalControlForManagedConversation(conversation),
          terminalControl
        )
      )
    : [];
  const displayedRelated = terminalControl
    ? displayedConversations.filter((conversation) =>
        terminalControlsShareIncarnation(
          terminalControlForManagedConversation(conversation),
          terminalControl
        )
      )
    : [];
  const relatedSessions = terminalControl
    ? managedSessions.filter((session) =>
        terminalControlsShareIncarnation(
          session.binding?.terminal_control,
          terminalControl
        )
      )
    : [];
  const matchingSessions = relatedSessions.filter((session) =>
    managedSessionMatchesLiveTerminalEntry(session, terminal, storeDir)
  );
  const conflictingBoundSessionClaims = relatedSessions.flatMap(
    (session): ConflictingManagedSessionClaim[] => {
      const kind = managedBindingConflictKindForLiveTerminalEntry({
        storeDir,
        session,
        terminal
      });
      return kind && kind !== "stale_process_incarnation"
        ? [{ session, kind }]
        : [];
    }
  );
  const unresolvedSessionClaims = relatedSessions.filter((session) =>
    ["transitioning", "quarantined"].includes(session.status) &&
    managedSessionClaimsLiveTerminalEntry(session, terminal)
  );
  const sessionAuthorityConflict = decideTerminalSessionAuthorityConflict({
    unresolvedSessionClaims,
    conflictingBoundSessionClaims,
    matchingSessions
  });
  const authoritativeSession = matchingSessions[0];
  const discoveredOwnership = terminalControl
    ? terminalDispatchOwnership(terminalControl)
    : { state: "none" as const };
  const localOwnership = discoveredOwnership.state === "current"
    ? localTerminalDispatchOwnership(
        discoveredOwnership.conversation,
        allRelated,
        terminal
      )
    : discoveredOwnership;
  const dispatchOwnerMismatch =
    !sessionAuthorityConflict &&
      localOwnership.state === "current" &&
      authoritativeSession &&
      sessionIdForConversation(localOwnership.conversation) !==
        authoritativeSession.session_id
      ? {
          ownerSessionId: sessionIdForConversation(
            discoveredOwnership.state === "current"
              ? discoveredOwnership.conversation
              : localOwnership.conversation
          )
        }
      : undefined;
  const ownership = applySessionAuthorityToDispatch({
    localOwnership,
    sessionAuthorityConflict,
    authoritativeSession,
    dispatchOwnerMismatch
  });
  const discoveredRawActions = isRecord(terminal.available_actions)
    ? terminal.available_actions
    : {};
  const rawActions = mutationsAllowed
    ? discoveredRawActions
    : readOnlyListActions(discoveredRawActions);
  const rawSendAction = isRecord(rawActions.send)
    ? rawActions.send
    : {};
  const bindingAwareRawActions = authoritativeSession
    ? actionsForManagedSessionBinding(
        rawActions,
        authoritativeSession
      )
    : rawActions;
  const sessionAwareRawActionsBase =
    authoritativeSession &&
      managedSessionHasUnresolvedNativeTransition(
        storeDir,
        authoritativeSession
      )
      ? Object.fromEntries(
          Object.entries(bindingAwareRawActions).filter(
            ([actionName]) => actionName !== "native_inspect"
          )
        )
      : bindingAwareRawActions;
  const sessionAwareRawActions = terminalHasNonterminalDeferredTransfer
    ? readOnlyListActions(sessionAwareRawActionsBase)
    : sessionAwareRawActionsBase;
  const soleBindingConflict = conflictingBoundSessionClaims.length === 1
    ? conflictingBoundSessionClaims[0]
    : undefined;
  const externalHandoffDetected = conflictingBoundSessionClaims.some(
    ({ kind }) => kind === "live_external_thread_change"
  );
  const conflictingSessionRevision = Number(
    soleBindingConflict?.session.revision
  );
  const conflictingSessionTurns = soleBindingConflict
    ? terminalListRuntime().managedTurnsForSession(
        storeDir,
        soleBindingConflict.session.session_id
      )
    : [];
  const expectedTerminalToken = stringValue(
    terminal.lifecycle_binding_token
  );
  const externalHandoffNativeThreadId = stringValue(
    terminal.native_agent_status_card_session_id
  ) ?? stringValue(terminal.native_agent_session_id);
  const resolvedNativeThreadId = stringValue(
    terminal.native_agent_session_id
  );
  const externalHandoffTerminalToken =
    terminalControl &&
    externalHandoffNativeThreadId &&
    isExactNativeThreadId(externalHandoffNativeThreadId)
      ? unmanagedTerminalBindingToken({
          terminalId: stringValue(terminal.id) as string,
          terminalControl,
          agent: terminal.agent,
          pid: Number(terminal.pid),
          workspace: terminal.workspace ?? terminal.cwd ?? cliCwd(),
          nativeThreadId: externalHandoffNativeThreadId,
          processUuid: stringValue(terminal.native_agent_process_uuid),
          processBirth: stringValue(terminal.native_agent_process_birth),
          rollout:
            resolvedNativeThreadId === externalHandoffNativeThreadId &&
            isRecord(terminal.native_agent_rollout)
              ? terminal.native_agent_rollout as any
              : undefined
        })
      : undefined;
  const externalHandoffTarget =
    soleBindingConflict?.kind === "live_external_thread_change" &&
    externalHandoffNativeThreadId &&
    isExactNativeThreadId(externalHandoffNativeThreadId)
      ? terminalListRuntime().observedHandoffTargetResolution({
          storeDir,
          agent: terminal.agent,
          workspace: terminal.workspace ?? terminal.cwd ?? cliCwd(),
          nativeThreadId: externalHandoffNativeThreadId.toLowerCase(),
          sourceSessionId: soleBindingConflict.session.session_id
        })
      : undefined;
  const externalHandoffSnapshotToken =
    externalHandoffTerminalToken &&
    soleBindingConflict?.kind === "live_external_thread_change" &&
    externalHandoffTarget?.status === "eligible"
      ? humanObservedHandoffBindingToken({
          terminal_token: externalHandoffTerminalToken,
          source_session_id: soleBindingConflict.session.session_id,
          source_revision: managedSessionRevision(
            soleBindingConflict.session
          ),
          source_binding_token: managedSessionBindingToken(
            soleBindingConflict.session
          ),
          target: externalHandoffTarget.snapshot
        })
      : undefined;
  const blockingHandoffTurns = conflictingSessionTurns.filter((turn) =>
    isSessionSendBlockingStatus(turn.status)
  );
  const terminalBlockingTurns = terminalControl
    ? terminalIncarnationBlockingTurns(
        storeDir,
        terminalControl,
        allRelated
      )
    : [];
  const externalHandoffSourceSessionIds = new Set(
    conflictingBoundSessionClaims
      .filter(({ kind }) => kind === "live_external_thread_change")
      .map(({ session }) => session.session_id)
  );
  const handoffSourceBlockingTurns = terminalBlockingTurns.filter((turn) =>
    externalHandoffSourceSessionIds.has(sessionIdForConversation(turn))
  );
  const nativeIdentityObservation = isRecord(
    terminal.native_agent_identity_observation
  )
    ? terminal.native_agent_identity_observation
    : undefined;
  const codexProcessUuid = stringValue(
    terminal.native_agent_process_uuid
  );
  const codexProcessBirth = stringValue(
    terminal.native_agent_process_birth
  );
  const codexWorkspace = stringValue(
    terminal.workspace ?? terminal.cwd
  );
  const codexSendAuthorityContext = terminalControl
    ? {
        terminalId: String(terminal.id),
        terminalControl,
        pid: Number(terminal.pid),
        workspace: codexWorkspace,
        liveProcessUuid: codexProcessUuid,
        liveProcessBirth: codexProcessBirth
      }
    : undefined;
  return {
    automatedInputComposerReady,
    codexOpenRootRolloutInventory,
    codexLatentClearResumeValue,
    publicTerminal,
    terminalControl,
    terminalHasNonterminalDeferredTransfer,
    allRelated,
    displayedRelated,
    relatedSessions,
    matchingSessions,
    conflictingBoundSessionClaims,
    unresolvedSessionClaims,
    sessionAuthorityConflict,
    authoritativeSession,
    discoveredOwnership,
    ownership,
    rawActions,
    rawSendAction,
    sessionAwareRawActions,
    soleBindingConflict,
    externalHandoffDetected,
    conflictingSessionRevision,
    conflictingSessionTurns,
    expectedTerminalToken,
    externalHandoffNativeThreadId,
    externalHandoffTarget,
    externalHandoffSnapshotToken,
    blockingHandoffTurns,
    terminalBlockingTurns,
    handoffSourceBlockingTurns,
    nativeIdentityObservation,
    codexProcessUuid,
    codexProcessBirth,
    codexWorkspace,
    codexSendAuthorityContext
  };
}

function observeVerifiedEmptyTerminalAuthority(
  terminal: Record<string, any>,
  context: TerminalFirstListContext,
  binding: ReturnType<typeof observeTerminalListBindingAuthority>
) {
  const { storeDir, terminals, mutationsAllowed } = context;
  const {
    automatedInputComposerReady,
    terminalControl,
    matchingSessions,
    unresolvedSessionClaims,
    discoveredOwnership,
    rawActions,
    soleBindingConflict,
    blockingHandoffTurns,
    terminalBlockingTurns,
    nativeIdentityObservation,
    codexProcessUuid,
    codexProcessBirth,
    codexWorkspace,
    codexSendAuthorityContext
  } = binding;
  const verifiedEmptySourceNativeThreadId = stringValue(
    soleBindingConflict?.session.binding?.native_thread_id
  )?.toLowerCase();
  const verifiedEmptySourceActiveElsewhere = Boolean(
    verifiedEmptySourceNativeThreadId &&
    terminals.some((candidate) =>
      candidate !== terminal &&
      candidate.agent === "codex" &&
      stringValue(candidate.native_agent_session_id)?.toLowerCase() ===
        verifiedEmptySourceNativeThreadId
    )
  );
  const verifiedEmptyRawSendAction = isRecord(rawActions.send)
    ? rawActions.send
    : {
        tool: "agent_knock_knock_send",
        arguments: { selector: stringValue(terminal.id) },
        missing_required: ["request"]
      };
  const verifiedEmptyCodexHandoffEligible = Boolean(
    mutationsAllowed &&
    terminal.agent === "codex" &&
    terminalControl &&
    discoveredOwnership.state === "none" &&
    unresolvedSessionClaims.length === 0 &&
    matchingSessions.length === 0 &&
    soleBindingConflict?.kind === "unverifiable" &&
    nativeIdentityObservation?.status === "verified_absent" &&
    codexSendAuthorityContext &&
    codexProcessUuid &&
    codexProcessBirth &&
    codexWorkspace &&
    exactBoundCodexSendSource({
      kind: "verified_empty",
      sourceSession: soleBindingConflict.session,
      context: codexSendAuthorityContext
    }) &&
    ["idle", "unknown"].includes(String(terminal.activity_state)) &&
    automatedInputComposerReady === true &&
    !(isRecord(terminal.approval_state) &&
      terminal.approval_state.blocked === true) &&
    blockingHandoffTurns.length === 0 &&
    terminalBlockingTurns.length === 0 &&
    !managedSessionHasUnresolvedNativeTransition(
      storeDir,
      soleBindingConflict.session
    ) &&
    !verifiedEmptySourceActiveElsewhere &&
    terminal.orphaned_terminal_dispatch === undefined &&
    terminalControl?.capabilities.includes("send_keys") &&
    terminalControl.capabilities.includes("screen_status")
  );
  const verifiedEmptyCodexSnapshotToken =
    verifiedEmptyCodexHandoffEligible &&
    codexSendAuthorityContext &&
    soleBindingConflict &&
    codexProcessUuid &&
    codexProcessBirth &&
    codexWorkspace
      ? verifiedEmptyCodexHandoffToken({
          terminalId: String(terminal.id),
          terminalControl: codexSendAuthorityContext.terminalControl,
          pid: Number(terminal.pid),
          workspace: codexWorkspace,
          processUuid: codexProcessUuid,
          processBirth: codexProcessBirth,
          sourceSession: soleBindingConflict.session
        })
      : undefined;
  return {
    ...binding,
    verifiedEmptyRawSendAction,
    verifiedEmptyCodexSnapshotToken
  };
}

function observeDeferredSourceAuthority(
  terminal: Record<string, any>,
  context: TerminalFirstListContext,
  observation: ReturnType<typeof observeVerifiedEmptyTerminalAuthority>
) {
  const { terminals } = context;
  const {
    codexLatentClearResumeValue,
    codexOpenRootRolloutInventory,
    authoritativeSession,
    matchingSessions,
    conflictingBoundSessionClaims,
    unresolvedSessionClaims,
    soleBindingConflict,
    nativeIdentityObservation
  } = observation;
  const deferredCodexCandidateInventory =
    codexOpenRootRolloutInventory &&
      codexOpenRootRolloutInventory.roots.length > 0
      ? codexOpenRootRolloutInventory
      : undefined;
  const abandonedConflictSource =
    !authoritativeSession &&
    soleBindingConflict?.kind === "unverifiable" &&
    matchingSessions.length === 0 &&
    conflictingBoundSessionClaims.length === 1 &&
    unresolvedSessionClaims.length === 0 &&
    terminal.agent === "codex"
      ? soleBindingConflict.session
      : undefined;
  const deferredCodexSource = (authoritativeSession ??
      abandonedConflictSource) &&
      terminal.agent === "codex" &&
      (
        nativeIdentityObservation?.status === "verified_absent" ||
        deferredCodexCandidateInventory !== undefined
      )
    ? authoritativeSession ?? abandonedConflictSource
    : undefined;
  const deferredCodexSourceNativeThreadId = stringValue(
    deferredCodexSource?.binding?.native_thread_id
  )?.toLowerCase();
  const deferredCodexLatentClearResumeFingerprint =
    isRecord(codexLatentClearResumeValue) &&
    stringValue(
      codexLatentClearResumeValue.source_native_thread_id
    )?.toLowerCase() === deferredCodexSourceNativeThreadId
      ? stringValue(codexLatentClearResumeValue.fingerprint)
      : undefined;
  if (deferredCodexLatentClearResumeFingerprint) {
    // The resume hint is useful operational context, but it is not durable
    // foreground authority: it can scroll away while the latent thread is
    // still current. Candidate routing and its token rely on the complete
    // rollout inventory and Store authority below instead.
    runtimeLog("info", "terminal_codex_latent_clear_hint_observed", {
      terminal_id: String(terminal.id),
      source_session_id: deferredCodexSource?.session_id,
      source_native_thread_id: deferredCodexSourceNativeThreadId
    });
  }
  const deferredCodexSourceActiveElsewhere = Boolean(
    deferredCodexSourceNativeThreadId &&
    terminals.some((candidate) =>
      candidate !== terminal &&
      candidate.agent === "codex" &&
      stringValue(candidate.native_agent_session_id)?.toLowerCase() ===
        deferredCodexSourceNativeThreadId
    )
  );
  return {
    ...observation,
    deferredCodexCandidateInventory,
    abandonedConflictSource,
    deferredCodexSource,
    deferredCodexSourceActiveElsewhere
  };
}

function observeDeferredTerminalAuthority(
  terminal: Record<string, any>,
  context: TerminalFirstListContext,
  observation: ReturnType<typeof observeDeferredSourceAuthority>
) {
  const { storeDir, mutationsAllowed } = context;
  const {
    automatedInputComposerReady,
    terminalControl,
    terminalHasNonterminalDeferredTransfer,
    matchingSessions,
    conflictingBoundSessionClaims,
    unresolvedSessionClaims,
    discoveredOwnership,
    terminalBlockingTurns,
    codexProcessUuid,
    codexProcessBirth,
    codexWorkspace,
    codexSendAuthorityContext,
    deferredCodexCandidateInventory,
    abandonedConflictSource,
    deferredCodexSource,
    deferredCodexSourceActiveElsewhere
  } = observation;
  const deferredCodexAuthority = codexSendAuthorityContext
    ? terminalListRuntime().observeDeferredCodexAuthority({
        mode: "list",
        storeDir,
        context: codexSendAuthorityContext,
        sourceSession: deferredCodexSource,
        candidateInventory: deferredCodexCandidateInventory,
        abandonment: abandonedConflictSource
          ? "missing_rollout"
          : "never",
        requireUnclaimedCandidate: true
      })
    : undefined;
  const deferredCodexSourceRolloutAuthority =
    deferredCodexAuthority?.sourceRolloutAuthority ?? "present";
  const deferredCodexDispatchSnapshot =
    deferredCodexAuthority?.dispatchSnapshot;
  const deferredCodexForegroundEligible = Boolean(
    mutationsAllowed &&
    !terminalHasNonterminalDeferredTransfer &&
    deferredCodexSource &&
    terminalControl &&
    hasCanonicalTerminalEndpoint(terminalControl) &&
    discoveredOwnership.state === "none" &&
    unresolvedSessionClaims.length === 0 &&
    (
      (matchingSessions.length === 1 &&
        conflictingBoundSessionClaims.length === 0) ||
      (deferredCodexSourceRolloutAuthority ===
          "explicitly_abandoned_predecessor" &&
        matchingSessions.length === 0 &&
        conflictingBoundSessionClaims.length === 1)
    ) &&
    codexProcessUuid &&
    codexProcessBirth &&
    codexWorkspace &&
    deferredCodexAuthority?.exactSource &&
    terminalBlockingTurns.length === 0 &&
    terminal.orphaned_terminal_dispatch === undefined &&
    deferredCodexDispatchSnapshot &&
    ["idle", "unknown"].includes(String(terminal.activity_state)) &&
    automatedInputComposerReady === true &&
    !(isRecord(terminal.approval_state) &&
      terminal.approval_state.blocked === true) &&
    !deferredCodexSourceActiveElsewhere &&
    terminalControl.capabilities.includes("send_keys") &&
    terminalControl.capabilities.includes("screen_status")
  );
  const deferredCodexForegroundToken =
    deferredCodexForegroundEligible &&
    deferredCodexSource &&
    terminalControl &&
    codexProcessUuid &&
    codexProcessBirth &&
    codexWorkspace &&
    deferredCodexDispatchSnapshot
      ? deferredCodexForegroundBindingToken({
          terminalId: String(terminal.id),
          terminalControl,
          pid: Number(terminal.pid),
          workspace: codexWorkspace,
          processUuid: codexProcessUuid,
          processBirth: codexProcessBirth,
          sourceSession: deferredCodexSource,
          dispatchSnapshot: deferredCodexDispatchSnapshot,
          sourceTurnHistory: deferredCodexAuthority?.sourceTurnHistory,
          sourceRolloutAuthority:
            deferredCodexSourceRolloutAuthority,
          sourceAbandonmentFingerprint:
            deferredCodexAuthority?.sourceAbandonmentFingerprint,
          ...(deferredCodexCandidateInventory
            ? { candidateInventory: deferredCodexCandidateInventory }
            : {})
        })
      : undefined;
  return {
    ...observation,
    deferredCodexSourceRolloutAuthority,
    deferredCodexForegroundToken
  };
}

function observeTerminalHandoffAuthority(
  terminal: Record<string, any>,
  context: TerminalFirstListContext,
  observation: ReturnType<typeof observeDeferredTerminalAuthority>
) {
  const {
    storeDir,
    mutationsAllowed,
    conversationHasNonterminalDeferredTransfer
  } = context;
  const {
    automatedInputComposerReady,
    terminalControl,
    matchingSessions,
    unresolvedSessionClaims,
    discoveredOwnership,
    rawActions,
    soleBindingConflict,
    conflictingSessionRevision,
    conflictingSessionTurns,
    expectedTerminalToken,
    externalHandoffNativeThreadId,
    externalHandoffTarget,
    externalHandoffSnapshotToken,
    blockingHandoffTurns,
    terminalBlockingTurns,
    handoffSourceBlockingTurns
  } = observation;
  const reconcileBindingAction =
    mutationsAllowed &&
    discoveredOwnership.state === "none" &&
    unresolvedSessionClaims.length === 0 &&
    matchingSessions.length === 0 &&
    soleBindingConflict &&
    soleBindingConflict.kind !== "unverifiable" &&
    Number.isSafeInteger(conflictingSessionRevision) &&
    conflictingSessionRevision > 0 &&
    expectedTerminalToken &&
    terminal.activity_state === "idle" &&
    !(isRecord(terminal.approval_state) &&
      terminal.approval_state.blocked === true) &&
    !conflictingSessionTurns.some((turn) =>
      isSessionSendBlockingStatus(turn.status)
    ) &&
    terminalBlockingTurns.length === 0 &&
    !managedSessionHasUnresolvedNativeTransition(
      storeDir,
      soleBindingConflict.session
    )
      ? projectReconcileBindingAction({
          terminalId: stringValue(terminal.id),
          conflictingSession: soleBindingConflict.session,
          conflictingSessionRevision,
          expectedTerminalToken
        })
      : undefined;
  const externalHandoffAdoptable = Boolean(
    mutationsAllowed &&
    discoveredOwnership.state === "none" &&
    unresolvedSessionClaims.length === 0 &&
    soleBindingConflict?.kind === "live_external_thread_change" &&
    terminal.activity_state === "idle" &&
    automatedInputComposerReady === true &&
    !(isRecord(terminal.approval_state) &&
      terminal.approval_state.blocked === true) &&
    !conflictingSessionTurns.some((turn) =>
      isSessionSendBlockingStatus(turn.status)
    ) &&
    terminalBlockingTurns.length === 0 &&
    !managedSessionHasUnresolvedNativeTransition(
      storeDir,
      soleBindingConflict.session
    ) &&
    externalHandoffTarget?.status === "eligible" &&
    isRecord(rawActions.send) &&
    Boolean(externalHandoffSnapshotToken)
  );
  const handoffDecisionTurn =
    mutationsAllowed &&
    soleBindingConflict?.kind === "live_external_thread_change" &&
    externalHandoffTarget?.status === "eligible" &&
    terminal.activity_state === "idle" &&
    !(isRecord(terminal.approval_state) &&
      terminal.approval_state.blocked === true) &&
    !managedSessionHasUnresolvedNativeTransition(
      storeDir,
      soleBindingConflict.session
    ) &&
    blockingHandoffTurns.length === 1 &&
    terminalBlockingTurns.every((turn) =>
      turn.conversation_id === blockingHandoffTurns[0].conversation_id
    )
      ? blockingHandoffTurns[0]
      : undefined;
  const handoffDecisionToken =
    handoffDecisionTurn &&
    externalHandoffSnapshotToken &&
    terminalControl
      ? terminalListRuntime().activeTurnHandoffDecisionToken({
          handoffToken: externalHandoffSnapshotToken,
          turn: handoffDecisionTurn,
          ledger: terminalListRuntime().loadTerminalBridgeDispatchLedger(terminalControl)
        })
      : undefined;
  const handoffDecision =
    handoffDecisionTurn &&
    handoffDecisionToken &&
    externalHandoffNativeThreadId
    ? projectHandoffDecision({
        sourceSessionId: soleBindingConflict?.session.session_id,
        sourceTurnId: turnIdForConversation(handoffDecisionTurn),
        liveNativeThreadId: externalHandoffNativeThreadId,
        handoffDecisionToken,
        actionTurnId: turnIdForConversation(handoffDecisionTurn)
      })
    : undefined;
  const blockingHandoffTurnIds = new Set(
    handoffSourceBlockingTurns.map((turn) => turn.conversation_id)
  );
  // A blocking managed Turn always remains explicitly closable. Close releases
  // AKK management only; it does not send input or stop the coding agent.
  const terminalRecoveryBlockingTurns = terminalBlockingTurns;
  return {
    ...observation,
    reconcileBindingAction,
    externalHandoffAdoptable,
    handoffDecision,
    blockingHandoffTurnIds,
    terminalRecoveryBlockingTurns
  };
}

function observeTerminalScopedApprovalAuthority(
  terminal: Record<string, any>,
  context: TerminalFirstListContext,
  observation: ReturnType<typeof observeTerminalHandoffAuthority>
) {
  const { storeDir, mutationsAllowed } = context;
  const {
    terminalControl,
    terminalHasNonterminalDeferredTransfer,
    conflictingBoundSessionClaims,
    unresolvedSessionClaims,
    sessionAuthorityConflict,
    authoritativeSession,
    discoveredOwnership,
    ownership,
    rawActions
  } = observation;
  let terminalScopedCodexApprovalAction: Record<string, any> | undefined;
  const terminalScopedCodexApprovalPrompt =
    terminalScopedCodexApprovalPromptSnapshot(terminal.approval_state);
  if (
    mutationsAllowed &&
    terminal.agent === "codex" &&
    terminalControl &&
    hasCanonicalTerminalEndpoint(terminalControl) &&
    authoritativeSession &&
    !sessionAuthorityConflict &&
    !terminalHasNonterminalDeferredTransfer &&
    unresolvedSessionClaims.length === 0 &&
    conflictingBoundSessionClaims.length === 0 &&
    terminalScopedCodexApprovalPrompt &&
    isRecord(rawActions.approve)
  ) {
    try {
      const ledger = terminalListRuntime().loadTerminalBridgeDispatchLedger(terminalControl);
      const boundary =
        ownership.state === "conflict" &&
          discoveredOwnership.state === "current" &&
          ledger
          ? terminalScopedCodexApprovalBoundary({
              storeDir,
              terminal,
              owner: discoveredOwnership.conversation,
              session: authoritativeSession,
              ledger,
              approval: terminalScopedCodexApprovalPrompt
            })
          : ownership.state === "none" &&
              discoveredOwnership.state === "none"
            ? terminalScopedCodexApprovalBoundary({
                storeDir,
                terminal,
                session: authoritativeSession,
                ledger,
                approval: terminalScopedCodexApprovalPrompt
              })
            : undefined;
      if (!boundary) {
        throw new Error(
          "terminal-scoped Codex approval has no eligible managed authority"
        );
      }
      terminalScopedCodexApprovalAction = {
        ...rawActions.approve,
        arguments: {
          conversation_id: String(terminal.id),
          expected_terminal_token: boundary.token
        },
        scope: "terminal_current_prompt",
        authority: boundary.authority.kind,
        managed_state_unchanged: true,
        automatic_approval_eligible: false,
        durable_dispatch_receipt: false,
        uncertain_outcome_recovery:
          "refresh status and inspect the live prompt; do not retry blindly"
      };
    } catch (error) {
      runtimeLog("info", "terminal_scoped_codex_approval_not_advertised", {
        terminal_id: String(terminal.id),
        terminal_target: terminalControl.target,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const rolloutBackedCodexSession = Boolean(
    authoritativeSession?.agent === "codex" &&
    isCompleteNativeRollout(
      authoritativeSession.binding?.native_process.rollout
    )
  );
  return {
    ...observation,
    terminalScopedCodexApprovalAction,
    rolloutBackedCodexSession
  };
}

function observeTerminalListActionAuthority(
  terminal: Record<string, any>,
  context: TerminalFirstListContext,
  binding: ReturnType<typeof observeTerminalListBindingAuthority>
) {
  return observeTerminalScopedApprovalAuthority(
    terminal,
    context,
    observeTerminalHandoffAuthority(
      terminal,
      context,
      observeDeferredTerminalAuthority(
        terminal,
        context,
        observeDeferredSourceAuthority(
          terminal,
          context,
          observeVerifiedEmptyTerminalAuthority(terminal, context, binding)
        )
      )
    )
  );
}

function renderTerminalFirstListEntry(
  terminal: Record<string, any>,
  context: TerminalFirstListContext,
  observation: ReturnType<typeof observeTerminalListActionAuthority>
): Record<string, any> {
  const {
    sessionAuthorityRequired,
    includeAll,
    mutationsAllowed,
    conversationHasNonterminalDeferredTransfer
  } = context;
  const {
    automatedInputComposerReady,
    publicTerminal,
    allRelated,
    displayedRelated,
    relatedSessions,
    authoritativeSession,
    ownership,
    rawSendAction,
    sessionAwareRawActions,
    externalHandoffDetected,
    externalHandoffSnapshotToken,
    handoffSourceBlockingTurns,
    verifiedEmptyRawSendAction,
    verifiedEmptyCodexSnapshotToken,
    deferredCodexSourceRolloutAuthority,
    deferredCodexForegroundToken,
    reconcileBindingAction,
    externalHandoffAdoptable,
    handoffDecision,
    blockingHandoffTurnIds,
    terminalRecoveryBlockingTurns,
    terminalScopedCodexApprovalAction,
    rolloutBackedCodexSession
  } = observation;
  const association = decideManagedTerminalAssociation({
    allRelated,
    displayedRelated,
    authoritativeSession,
    sessionAuthorityRequired,
    currentOwner: ownership.state === "current"
      ? ownership.conversation
      : undefined
  });
  const { managedSessionId, sessionIds, sessionAllRelated,
    sessionDisplayedRelated } = association;
  // History remains useful when a pane has restarted and therefore no
  // first-class Session is authoritative for the new process incarnation.
  // Keep that display-only association separate from the send target: under
  // protocol 3, only authoritativeSession may populate managedSessionId.
  const sessionBindingMatchesLiveTerminal = authoritativeSession
    ? true
    : Boolean(
        !sessionAuthorityRequired &&
        sessionAllRelated.some((turn) =>
          managedTurnMatchesLiveTerminal(turn, terminal)
        )
      );

  const currentTurnValue = ownership.state === "current"
    ? currentManagedTurnForTerminal(
        ownership.conversation,
        terminal,
        sessionAwareRawActions
      )
    : undefined;
  const currentTurnProjection = currentTurnValue
    ? !mutationsAllowed
      ? readOnlyManagedTurn(currentTurnValue)
      : ownership.state === "current" &&
          conversationHasNonterminalDeferredTransfer(ownership.conversation)
        ? userReleasableManagedTurn(currentTurnValue)
        : currentTurnValue
    : undefined;
  const currentTurn = currentTurnProjection
    ? withoutGenericHandoffSourceClose(
        currentTurnProjection,
        blockingHandoffTurnIds
      )
    : undefined;
  const nonOwnerRawActions = nonOwnerTerminalActions(
    sessionAwareRawActions as TerminalActionSet<Record<string, any>>,
    {
      hasAuthoritativeSession: Boolean(authoritativeSession),
      rolloutBackedCodexSession
    }
  );
  const { recentConversation, historyConversations } =
    selectManagedTerminalHistory({
      displayedRelated: sessionDisplayedRelated,
      currentConversationId: stringValue(currentTurn?.conversation_id),
      hasCurrentTurn: Boolean(currentTurn),
      includeAll
    });
  const recentTurnValue = recentConversation
    ? historicalManagedTurnForTerminal(recentConversation)
    : undefined;
  const recentTurnProjection = recentTurnValue
    ? !mutationsAllowed
      ? readOnlyManagedTurn(recentTurnValue)
      : recentConversation &&
          conversationHasNonterminalDeferredTransfer(recentConversation)
        ? userReleasableManagedTurn(recentTurnValue)
        : recentTurnValue
    : undefined;
  const recentTurn = recentTurnProjection
    ? withoutGenericHandoffSourceClose(
        recentTurnProjection,
        blockingHandoffTurnIds
      )
    : undefined;
  const history = historyConversations.map((conversation) => {
    const turn = historicalManagedTurnForTerminal(conversation);
    return withoutGenericHandoffSourceClose(
      !mutationsAllowed
        ? readOnlyManagedTurn(turn)
        : conversationHasNonterminalDeferredTransfer(conversation)
          ? userReleasableManagedTurn(turn)
          : turn,
      blockingHandoffTurnIds
    );
  });
  const visibleTurnIds = new Set(
    [currentTurn, recentTurn, ...history]
      .map((turn) => stringValue(turn?.conversation_id))
      .filter((id): id is string => id !== undefined)
  );
  const managedSessionShortReference = managedSessionId
    ? sessionShortRef(managedSessionId)
    : null;
  const management = projectTerminalManagement({
    managedSessionId,
    managedSessionShortRef: managedSessionShortReference,
    currentTurn,
    recentTurn,
    sessionAllRelatedCount: sessionAllRelated.length,
    hiddenTurnCount: sessionAllRelated.filter((conversation) =>
      !visibleTurnIds.has(conversation.conversation_id)
    ).length,
    sessionCount: new Set([
      ...sessionIds,
      ...relatedSessions.map((session) => session.session_id)
    ]).size,
    authoritativeSession,
    history: includeAll ? history : undefined
  });
  const sendAuthority = decideTerminalSendAuthority({
    ownership: ownership.state,
    verifiedEmptyToken: verifiedEmptyCodexSnapshotToken,
    externalToken: externalHandoffAdoptable
      ? externalHandoffSnapshotToken
      : undefined,
    deferredToken: ownership.state !== "conflict" ||
        deferredCodexSourceRolloutAuthority ===
          "explicitly_abandoned_predecessor"
      ? deferredCodexForegroundToken
      : undefined,
    managedSendSessionId:
      managedSessionId &&
        !rolloutBackedCodexSession &&
        sessionBindingMatchesLiveTerminal &&
        isRecord(sessionAwareRawActions.send)
        ? managedSessionId
        : undefined
  });
  const tokenSendAction = sendAuthority.mode === "external_handoff"
    ? rawSendAction
    : sendAuthority.mode === "verified_empty" ||
        sendAuthority.mode === "deferred"
      ? verifiedEmptyRawSendAction
      : undefined;
  const authoritativeSendAction =
    sendAuthority.mode === "managed" && isRecord(sessionAwareRawActions.send)
      ? sendActionForManagedSession(
          sessionAwareRawActions.send,
          sendAuthority.sessionId
        )
      : tokenSendAction &&
          "token" in sendAuthority &&
          sendAuthority.token
        ? {
            ...tokenSendAction,
            arguments: {
              ...(isRecord(tokenSendAction.arguments)
                ? tokenSendAction.arguments
                : {}),
              expected_terminal_token: sendAuthority.token
            }
          }
        : undefined;
  const availableActions = selectTerminalAvailableActions({
    ownership: ownership.state,
    currentActions: ownership.state === "current"
      ? currentTerminalActions(currentTurn)
      : {},
    sessionAwareRawActions:
      sessionAwareRawActions as TerminalActionSet<Record<string, any>>,
    nonOwnerRawActions,
    authoritativeSendAction,
    reconcileBindingAction,
    terminalScopedApprovalAction: terminalScopedCodexApprovalAction,
    isAction: isRecord
  });
  // An explicit undefined rollout prevents a lingering resolver rollout from
  // being presented as the authoritative status-card thread.
  const authoritativeIdentity = authoritativeTerminalIdentity(
    authoritativeSession
  );
  const publicManagementConflict = ownership.state === "conflict"
    ? projectPublicManagementConflict({
        conflict: ownership.conflict,
        verifiedEmptyToken: verifiedEmptyCodexSnapshotToken,
        deferredToken: deferredCodexForegroundToken,
        explicitlyAbandonedPredecessor:
          deferredCodexSourceRolloutAuthority ===
            "explicitly_abandoned_predecessor"
      })
    : undefined;
  const handoffPresentation = projectHandoffPresentation({
    externalHandoffDetected,
    externalHandoffAdoptable,
    recoveryBlockingTurnCount: terminalRecoveryBlockingTurns.length,
    hasHandoffDecision: Boolean(handoffDecision),
    sourceBlockingTurnCount: handoffSourceBlockingTurns.length,
    automatedInputComposerReady: automatedInputComposerReady === true,
    verifiedEmptyToken: verifiedEmptyCodexSnapshotToken
  });
  return {
    ...publicTerminal,
    ...authoritativeIdentity,
    management_state: ownership.state === "conflict"
      ? "conflict"
      : ownership.state === "current" || Boolean(authoritativeSession)
        ? "managed"
        : "unmanaged",
    ...(ownership.state === "conflict"
      ? { management_conflict: publicManagementConflict }
      : {}),
    ...handoffPresentation,
    ...(handoffDecision ? { handoff_decision: handoffDecision } : {}),
    ...(terminalRecoveryBlockingTurns.length > 0
      ? {
          blocking_turns: terminalRecoveryBlockingTurns.map((turn) =>
            projectBlockingTurn({
              sessionId: sessionIdForConversation(turn),
              turnId: turnIdForConversation(turn),
              status: turn.status,
              recoveryTurnId: turnIdForConversation(turn)
            })
          )
        }
      : {}),
    managed: management,
    available_actions: availableActions
  };
}

function terminalFirstListProjection({
  storeDir,
  terminals,
  managedSessions,
  sessionAuthorityRequired,
  allConversations,
  displayedConversations,
  includeAll,
  managedOnly,
  statusFilter,
  mutationsAllowed
}: {
  storeDir: string;
  terminals: Record<string, any>[];
  managedSessions: ManagedSessionState[];
  sessionAuthorityRequired: boolean;
  allConversations: Conversation[];
  displayedConversations: Conversation[];
  includeAll: boolean;
  managedOnly: boolean;
  statusFilter?: string;
  mutationsAllowed: boolean;
}): {
  terminals: Record<string, any>[];
  unavailableManagedTurns: Record<string, any>[];
} {
  const nonterminalDeferredTransfers = listDeferredForegroundTransfers(
    storeDir
  ).filter((transfer) =>
    !isFinalDeferredForegroundTransferStatus(transfer.status)
  );
  const nonterminalDeferredTransferIds = new Set(
    nonterminalDeferredTransfers.map((transfer) => transfer.transfer_id)
  );
  const nonterminalDeferredSourceTurnIds = new Set(
    nonterminalDeferredTransfers.flatMap((transfer) =>
      transfer.version === 2 &&
        transfer.source_kind === "candidate_rollout_quiescent"
        ? (transfer.source_turn_history ?? []).map((turn) => turn.turn_id)
        : []
    )
  );
  const conversationHasNonterminalDeferredTransfer = (
    conversation: Conversation
  ): boolean => {
    if (
      nonterminalDeferredSourceTurnIds.has(
        turnIdForConversation(conversation)
      )
    ) {
      return true;
    }
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const transferId = stringValue(takeover?.deferred_foreground_transfer_id);
    return Boolean(
      transferId && nonterminalDeferredTransferIds.has(transferId)
    );
  };
  const discoveredTerminalControls = terminals.flatMap((terminal) => {
    const control = isRecord(terminal.terminal_control)
      ? terminal.terminal_control as unknown as TerminalControlRef
      : undefined;
    return control ? [control] : [];
  });

  const projectionContext: TerminalFirstListContext = {
    storeDir,
    terminals,
    managedSessions,
    sessionAuthorityRequired,
    allConversations,
    displayedConversations,
    includeAll,
    mutationsAllowed,
    nonterminalDeferredTransfers,
    conversationHasNonterminalDeferredTransfer
  };
  const projectedTerminals = terminals.map((terminal) =>
    renderTerminalFirstListEntry(
      terminal,
      projectionContext,
      observeTerminalListActionAuthority(
        terminal,
        projectionContext,
        observeTerminalListBindingAuthority(terminal, projectionContext)
      )
    )
  );

  const unavailableManagedTurns = displayedConversations
    .filter((conversation) => {
      const managedControl = terminalControlForManagedConversation(conversation);
      if (discoveredTerminalControls.some((control) =>
        terminalControlsShareIncarnation(managedControl, control)
      )) {
        return false;
      }
      return (
        includeAll ||
        managedOnly ||
        statusFilter !== undefined ||
        managedTurnNeedsAttention(conversation)
      );
    })
    .sort(compareManagedConversationRecency)
    .map((conversation) => {
      const managedTurn = managedTurnListEntry(
        terminalListRuntime().summarizeConversation(conversation),
        {
          terminalBridge: terminalListRuntime().terminalBridgeEnabled(conversation),
          approvalState: managedListApprovalState(conversation),
          conversation
        }
      );
      return {
        ...managedTurn,
        available_actions: !mutationsAllowed
          ? readOnlyListActions(
              isRecord(managedTurn.available_actions)
                ? managedTurn.available_actions
                : {}
            )
          : conversationHasNonterminalDeferredTransfer(conversation)
            ? userReleaseListActions(
                isRecord(managedTurn.available_actions)
                  ? managedTurn.available_actions
                  : {},
                turnIdForConversation(conversation)
              )
            : safeUnavailableManagedTurnActions(
                isRecord(managedTurn.available_actions)
                  ? managedTurn.available_actions
                  : {}
              ),
        terminal_availability: {
          available: false,
          reason: managedOnly
            ? "terminal discovery was disabled by --managed-only"
            : "the referenced terminal pane is not currently available"
        }
      };
    });

  return {
    terminals: projectedTerminals,
    unavailableManagedTurns
  };
}

function managedSessionMatchesLiveTerminalEntry(
  session: ManagedSessionState,
  terminal: Record<string, any>,
  storeDir: string
): boolean {
  const binding = session.binding;
  const liveControl = isRecord(terminal.terminal_control)
    ? terminal.terminal_control as unknown as TerminalControlRef
    : undefined;
  if (
    session.status !== "bound" ||
    !binding ||
    session.agent !== terminal.agent ||
    binding.native_process.pid !== Number(terminal.pid)
  ) {
    return false;
  }
  const terminalAliasMatches = terminalControlAliasMatches(
    binding.terminal_id,
    binding.terminal_control,
    terminal.id,
    liveControl
  );
  if (!terminalAliasMatches) {
    return false;
  }
  const workspaceMatches = terminalListRuntime().matchesConfiguredWorkspace(
    session.workspace,
    terminal.workspace ?? terminal.cwd
  );
  if (!workspaceMatches) {
    return false;
  }
  const observation = terminalObservationFromListEntry(
    terminal,
    session.agent
  );
  const evidence = {
    terminalAliasMatches,
    workspaceMatches
  };
  let decision = decideTerminalBindingMatch(session, observation, evidence);
  if (
    decision.state === "not_exact" &&
    decision.reason === "native_identity_mismatch" &&
    session.agent === "codex" &&
    observation.nativeIdentity.status === "resolved"
  ) {
    decision = decideTerminalBindingMatch(session, observation, {
      ...evidence,
      codexLingeringBeforeMatches:
        terminalListRuntime().codexLingeringBeforeIdentityMatchesSession({
          storeDir,
          session,
          identity: observation.nativeIdentity.identity
        })
    });
  }
  return decision.state === "exact";
}

function managedSessionClaimsLiveTerminalEntry(
  session: ManagedSessionState,
  terminal: Record<string, any>
): boolean {
  const binding = session.binding;
  const liveControl = isRecord(terminal.terminal_control)
    ? terminal.terminal_control as unknown as TerminalControlRef
    : undefined;
  return Boolean(
    binding &&
    session.agent === terminal.agent &&
    binding.native_process.pid === Number(terminal.pid) &&
    terminalControlsShareIncarnation(binding.terminal_control, liveControl)
  );
}

function listedTerminalProcessIncarnation(
  terminal: Record<string, any>
): { processUuid?: string; processBirth?: string } {
  const processUuid = stringValue(terminal.native_agent_process_uuid);
  const processBirth = stringValue(terminal.native_agent_process_birth);
  if (
    terminal.agent !== "codex" ||
    (processUuid && processBirth)
  ) {
    return { processUuid, processBirth };
  }
  const pid = Number(terminal.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return { processUuid, processBirth };
  }
  try {
    const incarnation = terminalListRuntime().codexProcessIncarnationForPid(pid);
    return {
      processUuid: processUuid ?? incarnation.processUuid,
      processBirth: processBirth ?? incarnation.processBirth
    };
  } catch {
    return { processUuid, processBirth };
  }
}

function managedBindingConflictKindForLiveTerminalEntry({
  storeDir,
  session,
  terminal
}: {
  storeDir: string;
  session: ManagedSessionState;
  terminal: Record<string, any>;
}): ManagedBindingConflictKind | undefined {
  const binding = session.binding;
  if (
    session.status !== "bound" ||
    !binding ||
    !managedSessionClaimsLiveTerminalEntry(session, terminal) ||
    managedSessionMatchesLiveTerminalEntry(session, terminal, storeDir)
  ) {
    return undefined;
  }
  const livePid = Number(terminal.pid);
  const incarnation = listedTerminalProcessIncarnation(terminal);
  const relationship = processIncarnationRelationship({
    binding,
    livePid,
    liveProcessUuid: incarnation.processUuid,
    liveProcessBirth: incarnation.processBirth
  });
  if (relationship === "different") {
    return "stale_process_incarnation";
  }
  if (
    !terminalControlAliasMatches(
      binding.terminal_id,
      binding.terminal_control,
      terminal.id,
      isRecord(terminal.terminal_control)
        ? terminal.terminal_control
        : undefined
    ) ||
    !terminalListRuntime().matchesConfiguredWorkspace(
      session.workspace,
      terminal.workspace ?? terminal.cwd
    )
  ) {
    return "unverifiable";
  }
  return decideManagedBindingConflict({
    session,
    claimsTerminal: true,
    exactBinding: false,
    ownerConclusivelyInactive: false,
    processRelationship: relationship,
    liveNativeThreadId: stringValue(terminal.native_agent_session_id),
    statusCardNativeThreadId: stringValue(
      terminal.native_agent_status_card_session_id
    ),
    managedTurnCount: provisionalManagedBindingTurnCount(storeDir, session)
  });
}

function provisionalManagedBindingTurnCount(
  storeDir: string,
  session: ManagedSessionState
): number | undefined {
  const binding = session.binding;
  return binding && session.lineage.created_by === "attach" &&
      !session.last_transition_id &&
      !binding.native_thread_id &&
      !binding.native_process.rollout
    ? terminalListRuntime().managedTurnsForSession(storeDir, session.session_id).length
    : undefined;
}

function managedSessionHasUnresolvedNativeTransition(
  storeDir: string,
  session: ManagedSessionState
): boolean {
  const root = nativeThreadTransitionsDir(storeDir);
  if (!fs.existsSync(root)) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    let transition: NativeThreadTransition;
    try {
      transition = loadNativeThreadTransition(storeDir, entry.name);
    } catch {
      return true;
    }
    if (
      transition.source_session_id !== session.session_id &&
      transition.target_session_id !== session.session_id
    ) {
      continue;
    }
    if (!["committed", "aborted"].includes(transition.status)) {
      return true;
    }
  }
  return false;
}

function managedSessionHasAnyNativeTransition(
  storeDir: string,
  session: ManagedSessionState
): boolean {
  const root = nativeThreadTransitionsDir(storeDir);
  if (!fs.existsSync(root)) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    let transition: NativeThreadTransition;
    try {
      transition = loadNativeThreadTransition(storeDir, entry.name);
    } catch {
      return true;
    }
    if (
      transition.source_session_id === session.session_id ||
      transition.target_session_id === session.session_id
    ) {
      return true;
    }
  }
  return false;
}

function terminalControlForManagedConversation(
  conversation: Conversation
): TerminalControlRef | undefined {
  return terminalListRuntime().terminalControlFromTakeover(
    isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined
  );
}

function terminalIncarnationBlockingTurns(
  storeDir: string,
  terminalControl: TerminalControlRef,
  conversations: Conversation[] = listConversations(storeDir)
): Conversation[] {
  return conversations
    .filter(terminalListRuntime().isDiscoverableTmuxConversation)
    .filter((turn) =>
      terminalControlsShareIncarnation(
        terminalControlForManagedConversation(turn),
        terminalControl
      ) &&
      isSessionSendBlockingStatus(turn.status)
    )
    .sort(compareManagedConversationRecency);
}

function managedTurnNeedsAttention(conversation: Conversation): boolean {
  return terminalManagedTurnNeedsAttention({
    status: conversation.status,
    get callbackDeliveryStatus() {
      const delivery = isRecord(conversation.callback_delivery)
        ? conversation.callback_delivery
        : undefined;
      return String(delivery?.status ?? "");
    }
  });
}

function assertTerminalIncarnationCanStartTurn(
  storeDir: string,
  terminalControl: TerminalControlRef
): void {
  const blocker = terminalIncarnationBlockingTurns(
    storeDir,
    terminalControl
  )[0];
  if (!blocker) {
    return;
  }
  throw new Error(
    `terminal ${terminalControl.target} still has unresolved Turn ` +
    `${turnIdForConversation(blocker)} (${blocker.status})`
  );
}

function terminalDispatchOwnership(
  terminalControl: TerminalControlRef
):
  | { state: "none" }
  | { state: "current"; conversation: Conversation }
  | { state: "conflict"; conflict: Record<string, any> } {
  let ledger: Record<string, any> | undefined;
  try {
    ledger = terminalListRuntime().loadTerminalBridgeDispatchLedger(terminalControl);
  } catch (error) {
    const decision = dispatch.decideTerminalDispatchOwnership("unreadable");
    return {
      state: "conflict",
      conflict: {
        reason: decision.code === "ledger_unreadable"
          ? error instanceof Error ? error.message : String(error)
          : "terminal dispatch ledger is unreadable",
        recovery: "inspect the shared terminal pane before performing a side effect"
      }
    };
  }
  const ledgerAuthority: dispatch.TerminalDispatchLedgerAuthority = !ledger
    ? "absent"
    : ledger.status === "resolved"
      ? "resolved"
      : terminalListRuntime().terminalDispatchRecordMatchesControl(ledger, terminalControl, {
          requireProcessAnchor: false
        }) && !terminalListRuntime().terminalDispatchRecordMatchesControl(ledger, terminalControl)
        ? "stale_process_incarnation"
        : dispatch.isActiveTerminalDispatchStatus(String(ledger.status))
          ? "active"
          : "inactive_status";
  let decision = dispatch.decideTerminalDispatchOwnership(ledgerAuthority);
  if (decision.state === "none" || !ledger) return { state: "none" };
  const owner = terminalListRuntime().loadTerminalDispatchLedgerOwner(ledger);
  const ledgerMessageId = stringValue(ledger.message_id);
  const ownerAuthority: dispatch.TerminalDispatchOwnerAuthority = !owner
    ? "unavailable"
    : isTerminalDispatchOwnerReleasedStatus(owner.status)
      ? "released"
      : !terminalControlsShareIncarnation(
          terminalControlForManagedConversation(owner),
          terminalControl
        )
        ? "terminal_mismatch"
        : ledgerMessageId && stringValue(
          isRecord(owner.native_session_takeover)
            ? owner.native_session_takeover.terminal_bridge_message_id
            : undefined
        ) !== ledgerMessageId
          ? "generation_mismatch"
          : "current";
  decision = dispatch.decideTerminalDispatchOwnership(
    ledgerAuthority,
    ownerAuthority
  );
  if (decision.state === "none") return { state: "none" };
  if (decision.state === "current" && owner) {
    return { state: "current", conversation: owner };
  }
  const reason = decision.state === "conflict" &&
      decision.code === "owner_terminal_mismatch"
    ? "dispatch owner does not reference this terminal pane incarnation"
    : decision.state === "conflict" &&
        decision.code === "owner_generation_mismatch"
      ? "dispatch generation does not match the owner state"
      : "dispatch owner state is unavailable";
  return {
    state: "conflict",
    conflict: projectTerminalDispatchConflict({
      reason,
      dispatchStatus: stringValue(ledger.status),
      ownerConversationId: stringValue(ledger.conversation_id),
      messageId: stringValue(ledger.message_id)
    })
  };
}

function localTerminalDispatchOwnership(
  ledgerOwner: Conversation,
  localConversations: Conversation[],
  terminal: Record<string, any>
):
  | { state: "current"; conversation: Conversation }
  | { state: "conflict"; conflict: Record<string, any> } {
  const localOwner = localConversations.find((conversation) =>
    conversation.conversation_id === ledgerOwner.conversation_id &&
    sameCanonicalStatePath(conversation.state_path, ledgerOwner.state_path)
  );
  return decideLocalTerminalDispatchOwnership({
    ledgerOwnerId: ledgerOwner.conversation_id,
    localOwner,
    localOwnerMatchesLiveTerminal: localOwner
      ? managedTurnMatchesLiveTerminal(localOwner, terminal)
      : false
  });
}

function terminalScopedCodexApprovalBoundary({
  storeDir, terminal, session, ledger, approval, owner
}: {
  storeDir: string; terminal: unknown; session: ManagedSessionState;
  ledger?: TerminalDispatchLedgerDocument;
  approval?: TerminalScopedCodexApprovalPromptSnapshot;
  owner?: Conversation;
}): TerminalScopedCodexApprovalBoundary {
  const terminalRecord = isRecord(terminal) ? terminal : {};
  const terminalControl = isRecord(terminalRecord.terminal_control)
    ? terminalRecord.terminal_control as unknown as TerminalControlRef
    : undefined;
  const control = terminalControl as TerminalControlRef;
  const terminalId = String(terminalRecord.id);
  const relatedBoundSessionIds = () =>
    listManagedSessions(storeDir)
      .filter((candidate) =>
        candidate.status === "bound" &&
        candidate.agent === "codex" &&
        candidate.binding?.native_process.pid === Number(terminalRecord.pid) &&
        terminalControlsShareIncarnation(candidate.binding?.terminal_control, terminalControl)
      )
      .map((candidate) => candidate.session_id);
  const blockingTurnIds = () =>
    terminalIncarnationBlockingTurns(storeDir, control)
      .map((turn) => turnIdForConversation(turn));
  const hasDeferredRecovery = () =>
    listDeferredForegroundTransfers(storeDir).some((transfer) =>
      !isFinalDeferredForegroundTransferStatus(transfer.status) &&
      (transfer.source_session_id === session.session_id ||
       transfer.target_session_id === session.session_id ||
       (transfer.terminal_id === terminalId &&
        terminalControlEvidenceMatches(transfer.terminal_endpoint, control)))
    );
  const commonChecks = {
    relatedBoundSessionIds, blockingTurnIds,
    hasNativeTransition: () =>
      managedSessionHasAnyNativeTransition(storeDir, session),
    hasDeferredRecovery,
    ledgerMatchesTerminal: () =>
      terminalListRuntime().terminalDispatchRecordMatchesControl(ledger, control)
  };
  if (owner && ledger) {
    return decideTerminalScopedCodexApprovalAuthority({
      kind: "current_dispatch_owner", storeDir, terminal, owner, session,
      ledger, approval,
      checks: {
        ...commonChecks,
        assertDispatchOwner: () => terminalListRuntime().assertManagedTerminalDispatchOwner({
          storeDir, conversation: owner, terminalControl: control, action: "approve"
        }),
        ownerMatchesNativeIdentity: (identity) =>
          nativeAgentIdentityMatchesTurn(owner, identity
            ? { ...identity, evidence: "terminal_scoped_approval" }
            : undefined)
      }
    });
  }
  return decideTerminalScopedCodexApprovalAuthority({
    kind: "managed_session_no_dispatch_owner", storeDir, terminal, session,
    ledger, approval,
    checks: {
      ...commonChecks,
      dispatchOwnershipIsNone: () =>
        terminalDispatchOwnership(control).state === "none",
      hasOrphanedDispatch: () =>
        Boolean(terminalListRuntime().orphanedTerminalDispatchForRecovery(control))
    }
  });
}

async function resolveTerminalScopedCodexApproval({
  options,
  terminal,
  approvalSnapshot
}: {
  options: TerminalListCliOptions;
  terminal: ResolvedTerminalConversation;
  approvalSnapshot?: TerminalScopedCodexApprovalPromptSnapshot;
}): Promise<TerminalScopedCodexApprovalResolution> {
  if (terminal.agent !== "codex") {
    return { state: "blocked", reason: "raw Claude approval remains unsupported" };
  }
  const storeDir = path.resolve(terminalListRuntime().storeDirFromOptions(options));
  let ledger: Record<string, any> | undefined;
  try {
    ledger = terminalListRuntime().loadTerminalBridgeDispatchLedger(terminal.terminalControl);
  } catch (error) {
    return {
      state: "blocked",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const relatedSessions = listManagedSessions(storeDir).filter((session) =>
    session.binding?.native_process.pid === terminal.pid &&
    terminalControlsShareIncarnation(
      session.binding?.terminal_control,
      terminal.terminalControl
    )
  );
  const relatedTurns = listConversations(storeDir).filter((turn) =>
    terminalControlsShareIncarnation(
      terminalControlForManagedConversation(turn),
      terminal.terminalControl
    )
  );
  if (ledger?.status === "uncertain") {
    return {
      state: "blocked",
      reason:
        "terminal dispatch is uncertain; inspect the pane and do not retry approval"
    };
  }
  const ownership = terminalDispatchOwnership(terminal.terminalControl);
  if (ownership.state === "conflict") {
    return {
      state: "blocked",
      reason: stringValue(ownership.conflict.reason) ??
        "terminal dispatch ownership is conflicted"
    };
  }
  if (
    ownership.state === "none" &&
    relatedSessions.length === 0 &&
    relatedTurns.length === 0
  ) {
    return { state: "unmanaged" };
  }
  const owner = ownership.state === "current"
    ? ownership.conversation
    : undefined;
  if (owner) {
    const ownerStoreDir = terminalListRuntime().managedSessionStoreDirForConversation(owner);
    if (!ownerStoreDir || path.resolve(ownerStoreDir) !== storeDir) {
      return {
        state: "blocked",
        reason: "terminal dispatch owner belongs to another AKK Store"
      };
    }
  }
  const ownerSession = owner
    ? tryLoadManagedSession(storeDir, sessionIdForConversation(owner))
    : undefined;
  if (owner && !ownerSession) {
    return {
      state: "blocked",
      reason: "terminal dispatch owner has no current managed Session"
    };
  }
  let identityContext:
    | ReturnType<TerminalListDiscoveryPorts["codexManagedIdentityResolutionContext"]>
    | undefined;
  try {
    identityContext = terminalListRuntime().codexManagedIdentityResolutionContext({
      storeDir,
      terminal
    });
  } catch {
    // The terminal-scoped path deliberately tolerates an unavailable Codex
    // rollout resolver. Store, pane, process, owner, and prompt fences below
    // remain mandatory.
  }
  const observation = await terminalListRuntime().observeCurrentNativeAgentSessionIdentity({
    options,
    agent: "codex",
    pid: terminal.pid,
    cwd: terminal.terminalControl.currentPath,
    preferredSessionId: identityContext?.preferredSessionId,
    allowedCompanionIdentity: identityContext?.companions.primary,
    allowedAdditionalIdentities: identityContext?.companions.additional
  });
  let processIncarnation: ReturnType<
    TerminalListDiscoveryPorts["codexProcessIncarnationForPid"]
  >;
  try {
    processIncarnation = terminalListRuntime().codexProcessIncarnationForPid(terminal.pid);
  } catch (error) {
    return {
      state: "blocked",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const identity = observation.status === "resolved"
    ? observation.identity
    : undefined;
  let approval = approvalSnapshot;
  if (!approval) {
    try {
      const terminalStatus = await terminalListRuntime().terminalStatusForControl(
        "codex",
        terminal.terminalControl,
        options,
        {
          pid: terminal.pid,
          cwd: terminal.terminalControl.currentPath,
          conversationId: terminal.conversationId,
          terminalTarget: terminal.terminalControl.target
        }
      );
      approval = terminalScopedCodexApprovalPromptSnapshot(
        terminalStatus.approval_state
      );
    } catch (error) {
      return {
        state: "blocked",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }
  if (!approval) {
    return {
      state: "blocked",
      reason:
        "terminal-scoped Codex approval requires one fresh exact approval prompt"
    };
  }
  const terminalSnapshot: Record<string, any> = {
    id: terminal.conversationId,
    source: "terminal",
    agent: "codex",
    pid: terminal.pid,
    cwd: terminal.terminalControl.currentPath,
    workspace: terminal.terminalControl.currentPath,
    terminal_control: terminal.terminalControl,
    native_agent_session_id: identity?.sessionId,
    native_agent_process_uuid:
      identity?.processUuid ?? processIncarnation.processUuid,
    native_agent_process_birth:
      identity?.processBirth ?? processIncarnation.processBirth,
    native_agent_rollout: identity?.rollout,
    native_agent_identity_observation: { status: observation.status },
    approval_state: {
      approvable: true,
      fingerprint: approval.fingerprint,
      keys: approval.keys,
      decision_mode: "keys",
      request_id: approval.requestId
    }
  };
  try {
    if (owner && ownerSession && ledger) {
      return {
        state: "eligible",
        boundary: terminalScopedCodexApprovalBoundary({
          storeDir,
          terminal: terminalSnapshot,
          owner,
          session: ownerSession,
          ledger,
          approval
        })
      };
    }
    if (ownership.state !== "none") {
      throw new Error(
        "managed terminal approval has no current exact dispatch owner"
      );
    }
    if (ledger && ledger.status !== "resolved") {
      throw new Error(
        `terminal-scoped Codex approval cannot use ${String(ledger.status)} dispatch ownership`
      );
    }
    const matchingSessions = relatedSessions.filter((session) =>
      managedSessionMatchesLiveTerminalEntry(
        session,
        terminalSnapshot,
        storeDir
      )
    );
    if (matchingSessions.length !== 1) {
      throw new Error(
        "terminal-scoped Codex approval has no single exact managed Session"
      );
    }
    return {
      state: "eligible",
      boundary: terminalScopedCodexApprovalBoundary({
        storeDir,
        terminal: terminalSnapshot,
        session: matchingSessions[0],
        ledger,
        approval
      })
    };
  } catch (error) {
    return {
      state: "blocked",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function historicalManagedTurnForTerminal(
  conversation: Conversation
): Record<string, any> {
  return renderHistoricalManagedTurn(managedTurnListEntry(
    terminalListRuntime().summarizeConversation(conversation),
    {
      terminalBridge: terminalListRuntime().terminalBridgeEnabled(conversation),
      approvalState: managedListApprovalState(conversation),
      conversation
    }
  ));
}

function managedTurnMatchesLiveTerminal(
  conversation: Conversation,
  terminal: Record<string, any>
): boolean {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const liveControl = isRecord(terminal.terminal_control)
    ? terminal.terminal_control
    : undefined;
  const storedControl = terminalListRuntime().terminalControlFromTakeover(takeover);
  const livePid = Number(terminal.pid);
  const storedPid = Number(takeover?.terminal_agent_pid);
  if (
    executorForConversation(conversation).kind !== terminal.agent ||
    !Number.isSafeInteger(livePid) ||
    livePid <= 1 ||
    storedPid !== livePid ||
    !terminalControlAliasMatches(
      stringValue(takeover?.native_session_id),
      storedControl,
      stringValue(terminal.id),
      liveControl
    ) ||
    !terminalControlsShareIncarnation(storedControl, liveControl)
  ) {
    return false;
  }
  const liveSessionId = stringValue(terminal.native_agent_session_id);
  const liveProcessUuid = stringValue(terminal.native_agent_process_uuid);
  const liveProcessBirth = stringValue(terminal.native_agent_process_birth);
  const liveRollout = isRecord(terminal.native_agent_rollout)
    ? terminal.native_agent_rollout
    : undefined;
  const liveNativeIdentity = liveSessionId
    ? {
        sessionId: liveSessionId,
        ...(liveProcessUuid ? { processUuid: liveProcessUuid } : {}),
        ...(liveProcessBirth ? { processBirth: liveProcessBirth } : {}),
        ...(liveRollout
          ? {
              rollout: {
                fd: String(liveRollout.fd ?? ""),
                device: String(liveRollout.device ?? ""),
                inode: String(liveRollout.inode ?? ""),
                path: String(liveRollout.path ?? "")
              }
            }
          : {}),
        evidence: "live_terminal"
      }
    : undefined;
  if (!nativeAgentIdentityMatchesTurn(conversation, liveNativeIdentity)) {
    return false;
  }
  const liveWorkspace = terminal.workspace ?? terminal.cwd;
  if (!terminalListRuntime().matchesConfiguredWorkspace(conversation.workspace, liveWorkspace)) {
    return false;
  }
  const livePanePath = liveControl?.currentPath;
  if (
    livePanePath !== undefined &&
    !terminalListRuntime().matchesConfiguredWorkspace(conversation.workspace, livePanePath)
  ) {
    return false;
  }
  return true;
}

function currentManagedTurnForTerminal(
  conversation: Conversation,
  terminal: Record<string, any>,
  rawTerminalActions: Record<string, any>
): Record<string, any> {
  const managedTurn = managedTurnListEntry(
    terminalListRuntime().summarizeConversation(conversation),
    {
      terminalBridge: terminalListRuntime().terminalBridgeEnabled(conversation),
      approvalState: managedListApprovalState(conversation),
      conversation
    }
  );
  const rawApproval = isRecord(rawTerminalActions.approve)
    ? rawTerminalActions.approve
    : undefined;
  if (!rawApproval || executorForConversation(conversation).kind !== "codex") {
    return managedTurn;
  }
  return renderCurrentManagedTurn(managedTurn, {
    isCodex: true,
    ownerId: conversation.conversation_id,
    rawApproval,
    terminalApprovalState: () => isRecord(terminal.approval_state)
      ? terminal.approval_state
      : undefined
  });
}

async function listStateForTerminal(
  agent: ExecutorKind,
  terminalControl: TerminalControlRef,
  options,
  bridge: TerminalAgentBridge = terminalListRuntime().createTerminalAgentBridge(options),
  runtime?: TerminalRuntimeIdentity
): Promise<TerminalListState> {
  if (options.noApprovalScan) {
    return {
      approval_state: {
        scanned: false,
        blocked: false,
        approvable: false,
        reason: "approval scan disabled"
      },
      activity_state: "unknown",
      activity_reason: "terminal screen scan disabled"
    };
  }
  try {
    const status = await bridge.status(agent, terminalControl, {
      scrollbackLines: Number(options.scrollbackLines ?? 120),
      runtime
    });
    return {
      approval_state: {
        ...status.approval_state,
        screen_excerpt: status.approval_state.blocked ? status.screen.excerpt?.slice(-1000) : undefined
      },
      activity_state: status.activity_state,
      activity_reason: status.activity_reason,
      capability_limitation: status.capability_limitation,
      _terminal_status_snapshot: status,
      // Internal projection evidence; terminalControlledListEntry selects all
      // public fields explicitly and never exposes the pane excerpt itself.
      screen_excerpt: status.screen.excerpt
    };
  } catch (error) {
    return {
      approval_state: {
        scanned: false,
        blocked: false,
        approvable: false,
        error: error instanceof Error ? error.message : String(error)
      },
      activity_state: "unknown",
      activity_reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function managedListApprovalState(
  conversation
): Record<string, any> | undefined {
  if (
    !terminalListRuntime().terminalBridgeEnabled(conversation) ||
    !["waiting_for_agent", "waiting_for_openclaw"].includes(
      String(conversation.status)
    )
  ) {
    return undefined;
  }
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  if (
    !terminalListRuntime().terminalControlFromTakeover(nativeTakeover) ||
    !stringValue(nativeTakeover?.terminal_bridge_message_id)
  ) {
    return undefined;
  }
  const approval = isRecord(nativeTakeover?.terminal_bridge_approval)
    ? nativeTakeover.terminal_bridge_approval
    : undefined;
  const approvalState = isRecord(approval?.approval_state)
    ? approval.approval_state
    : undefined;
  const fingerprint = stringValue(approval?.fingerprint);
  const notifiedAt = stringValue(approval?.notified_at);
  const notifiedAtMs = validTimestampMs(notifiedAt);
  if (
    !approvalState ||
    !fingerprint ||
    notifiedAtMs === undefined ||
    cliNowMs() - notifiedAtMs > terminalListRuntime().approvalTtlMs
  ) {
    return undefined;
  }
  return {
    ...approvalState,
    fingerprint,
    notified_at: notifiedAt
  };
}

async function resolveConversationSelectorOption(commandName, options): Promise<void> {
  const sendOperation = commandName === "send";
  // Submission retry is already bound to one authoritative managed Turn.
  // Keep it out of ordinary-send selector discovery so an omitted Session
  // target cannot be inferred and mixed into the exact `send --turn` form.
  if (sendOperation && stringValue(options.turn)) {
    return;
  }
  if (stringValue(options.expectedTerminalToken)) {
    // Selector resolution may replace an alias (or an omitted selector) with a
    // discovered full terminal id. Preserve the caller's actual authority so
    // the handoff token fence cannot mistake that convenience resolution for
    // an exact selector supplied by the caller.
    terminalListRuntime().rememberOriginalExpectedTerminalSelector(
      options,
      stringValue(
        sendOperation
          ? options.session ?? options.conversation ?? options.conversationId
          : options.turn ?? options.conversation ?? options.conversationId
      )?.trim()
    );
  }
  if (
    !terminalListRuntime().selectorCommands.has(String(commandName ?? "")) ||
    options.state
  ) {
    return;
  }
  const supplied = stringValue(
    sendOperation
      ? options.session ?? options.conversation ?? options.conversationId
      : options.turn ?? options.conversation ?? options.conversationId
  )?.trim();
  if (supplied && !isSessionSelectorSyntax(supplied)) {
    // Full authoritative IDs keep their existing command-specific validation
    // path. This avoids a discovery scan before option validation and preserves
    // precise downstream errors for closed or currently non-actionable state.
    if (sendOperation) {
      options.session = supplied;
    } else {
      options.turn = supplied;
    }
    return;
  }
  const candidates = await sessionSelectorCandidates(commandName, options);
  const resolution = resolveSessionSelector(supplied, candidates, {
    operation: commandName
  });
  if (sendOperation) {
    options.session = resolution.id;
  } else {
    options.turn = resolution.id;
  }
  options.conversation = resolution.id;
  delete options.conversationId;
}

function isSessionSelectorSyntax(value: string): boolean {
  return (
    /^(?:only|latest|codex|claude|(?:codex|claude):latest)$/iu.test(value) ||
    /^@[0-9a-f]+$/iu.test(value)
  );
}

async function sessionSelectorCandidates(
  commandName,
  options
): Promise<SessionSelectorCandidate[]> {
  const storeDir = terminalListRuntime().storeDirFromOptions(options);
  const mutationsAllowed = inspectStoreCompatibility(storeDir).writable === true;
  const selectorStore = inspectStoreCompatibility(storeDir);
  const storedConversations = listConversations(storeDir);
  const workspaceConversations = storedConversations
    .filter((conversation) =>
      terminalListRuntime().matchesConfiguredWorkspace(options.workspace, conversation.workspace)
    );
  const discoverableWorkspaceConversations = workspaceConversations
    .filter(terminalListRuntime().isDiscoverableTmuxConversation);
  const managed = discoverableWorkspaceConversations.map((conversation) =>
      managedTurnListEntry(
        terminalListRuntime().summarizeConversation(conversation),
        {
          terminalBridge: terminalListRuntime().terminalBridgeEnabled(conversation),
          approvalState: managedListApprovalState(conversation),
          conversation
        }
      )
  );
  const terminalScan = await buildTerminalListGroup({
    options: {
      ...options,
      noApprovalScan: ["send", "approve", "cancel"].includes(commandName)
        ? options.noApprovalScan
        : true
    },
    agentFilter: undefined,
    statusFilter: undefined
  });
  const terminalProjection = terminalFirstListProjection({
    storeDir,
    terminals: terminalScan.terminalControlled.filter((entry) =>
      terminalListRuntime().matchesConfiguredWorkspace(
        options.workspace,
        entry.workspace ?? entry.cwd
      )
    ),
    managedSessions: selectorStore.readable
      ? listManagedSessions(storeDir).filter((session) =>
          terminalListRuntime().matchesConfiguredWorkspace(options.workspace, session.workspace)
        )
      : [],
    sessionAuthorityRequired:
      Number(selectorStore.writer_protocol) >= STORE_SESSION_AUTHORITY_PROTOCOL,
    allConversations: discoverableWorkspaceConversations,
    displayedConversations: discoverableWorkspaceConversations,
    includeAll: false,
    managedOnly: options.managedOnly === true,
    statusFilter: undefined,
    mutationsAllowed
  });
  const observedAtMs = cliNowMs();
  if (commandName === "send") {
    const sessionEntries = terminalProjection.terminals.flatMap((entry) => {
      const managedState = isRecord(entry.managed) ? entry.managed : undefined;
      const recentTurn = isRecord(managedState?.recent_turn)
        ? managedState.recent_turn
        : undefined;
      const currentTurn = isRecord(managedState?.current_turn)
        ? managedState.current_turn
        : undefined;
      const sessionId = stringValue(managedState?.session_id);
      const actions = isRecord(entry.available_actions)
        ? entry.available_actions
        : undefined;
      const sendAction = isRecord(actions?.send)
        ? actions.send
        : undefined;
      const sendArguments = isRecord(sendAction?.arguments)
        ? sendAction.arguments
        : undefined;
      if (
        !sessionId ||
        !sendAction ||
        stringValue(sendArguments?.session_id) !== sessionId
      ) {
        return [];
      }
      const commonEntry = {
        agent: entry.agent,
        status: "idle",
        workspace: entry.workspace ?? entry.cwd,
        updated_at:
          recentTurn?.updated_at ??
          currentTurn?.updated_at,
        available_actions: {
          send: sendAction
        }
      };
      return [
        {
          ...commonEntry,
          id: sessionId,
          short_ref: sessionShortRef(sessionId),
          source: "managed_session"
        },
        {
          ...commonEntry,
          id: String(entry.id),
          short_ref: stringValue(entry.short_ref) ??
            sessionShortRef(String(entry.id)),
          source: "managed_session_terminal_alias"
        }
      ];
    });
    const rawTerminalEntries = terminalProjection.terminals.filter((entry) => {
      const managedState = isRecord(entry.managed) ? entry.managed : undefined;
      const actions = isRecord(entry.available_actions)
        ? entry.available_actions
        : undefined;
      const sendAction = isRecord(actions?.send) ? actions.send : undefined;
      const sendArguments = isRecord(sendAction?.arguments)
        ? sendAction.arguments
        : undefined;
      return (
        !stringValue(managedState?.session_id) ||
        !stringValue(sendArguments?.session_id)
      );
    });
    return [
      ...managed.map((entry) =>
        projectSelectorCandidate(entry, commandName, observedAtMs, {
          defaultActionable: false,
          mutationsAllowed
        })
      ),
      ...sessionEntries.map((entry) =>
        projectSelectorCandidate(entry, commandName, observedAtMs, {
          // A managed terminal's full id/@short-ref is an explicit alias for
          // its Session send target. It must not duplicate the Session in
          // omitted, only, latest, or agent-name selection.
          defaultActionable:
            entry.source !== "managed_session_terminal_alias",
          mutationsAllowed
        })
      ),
      ...rawTerminalEntries.map((entry) =>
        projectSelectorCandidate(entry, commandName, observedAtMs, {
          defaultActionable: true,
          mutationsAllowed
        })
      )
    ];
  }
  return [
    ...managed.map((entry) =>
      projectSelectorCandidate(entry, commandName, observedAtMs, {
        defaultActionable: options.managedOnly === true,
        mutationsAllowed
      })
    ),
    ...terminalProjection.terminals.map((entry) =>
      projectSelectorCandidate(entry, commandName, observedAtMs, {
        defaultActionable: true,
        mutationsAllowed
      })
    )
  ];
}
