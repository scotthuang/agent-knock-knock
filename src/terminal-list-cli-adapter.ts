// Infrastructure composition for terminal list discovery and selector projection.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { CodexOpenRootRolloutInventory } from "./agent-session-provider.js";
import { listDeferredForegroundTransfers } from
  "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import {
  type ExecutorKind
} from "./executors.js";
import {
  isExactNativeThreadId,
  unmanagedTerminalBindingToken,
  type HumanObservedHandoffTargetSnapshot,
  type ManagedSessionState
} from "./managed-session.js";
import {
  executorForConversation,
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
  tryLoadManagedSession
} from "./session-store.js";
import {
  defaultStoreDir,
  ensureStoreWritable,
  inspectStoreCompatibility,
  listConversations,
  storeManifestPath,
  type StoreCompatibility,
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
  type TerminalBridgeStatus,
  type TerminalDurableActivityState,
  type TerminalNativeIdentityState
} from "./terminal-agent-bridge.js";
import {
  captureCodexHumanStartedActiveTaskAnchor,
  type CodexRolloutAcceptanceIdentity
} from "./terminal-submission-acceptance.js";
import {
  authoritativeTerminalIdentity,
  compareManagedConversationRecency,
  decideManagedTerminalAssociation,
  decideTerminalSendAuthority,
  decideTerminalUserExplicitSendAuthority,
  nonOwnerTerminalActions,
  projectBlockingTurn,
  projectHandoffPresentation,
  projectPublicManagementConflict,
  projectTerminalManagement,
  selectManagedTerminalHistory,
  selectTerminalAvailableActions,
  type TerminalActionSet,
  type TerminalDispatchOwnership
} from "./terminal-action-projection.js";
import { materializeModelControlAvailability } from
  "./terminal-model-control-availability.js";
import { terminalModelControlPlanConforms,
  type TerminalModelControlCapabilities,
  type TerminalModelControlProfile,
  type TerminalModelControlResidualObservation } from
  "./terminal-model-control.js";
import {
  childProcessIdsForRoot,
  terminalControlsShareIncarnation,
  type CodexAllowedCompanionSet,
  type CodexSendAuthorityContext
} from "./terminal-authority-policy.js";
import {
  type TerminalNativeIdentity,
  type TerminalNativeIdentityObservation
} from "./terminal-binding-authority.js";
import {
  terminalScopedCodexApprovalPromptSnapshot,
  type TerminalScopedCodexApprovalBoundary,
  type TerminalScopedCodexApprovalPromptSnapshot
} from "./terminal-scoped-approval-authority.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import {
  currentTerminalActions,
  listActionContracts,
  readOnlyListActions,
  readOnlyManagedTurn,
  userReleaseListActions,
  userReleasableManagedTurn,
  renderAvailableListActions,
  renderTerminalModelControlActions,
  renderCurrentManagedTurn,
  renderHistoricalManagedTurn,
  renderManagedTurnListEntry,
  safeUnavailableManagedTurnActions,
  sendActionForManagedSession,
  withoutGenericHandoffSourceClose,
  type AvailableListActionFacts
} from "./terminal-list-renderer.js";
import type { TerminalProcessSource } from "./terminal-process-source.js";
import type { TerminalControlProvider } from "./terminal-control-provider.js";
import {
  collectTerminalListInventory,
  type TerminalListInventoryEntry,
  type TerminalListInventoryScan
} from "./terminal-list-inventory.js";
import {
  collectTerminalListTerminalFacts,
  type EffectiveTerminalListState,
  type TerminalListPhysicalProcessIncarnation,
  type TerminalListState,
  type TerminalListTerminalFactPorts,
  type TerminalNativeListIdentityFacts
} from "./terminal-list-facts.js";
import {
  decideTerminalListActions,
  modelControlPolicyFacts,
  type TerminalListActionSubject
} from "./terminal-list-action-policy.js";
import {
  createTerminalListOwnershipService,
  type TerminalListOwnershipContext,
  type TerminalListOwnershipService
} from "./terminal-list-ownership-service.js";
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

export type TerminalListScanEntry = TerminalListInventoryEntry;
export type TerminalListScan = TerminalListInventoryScan;

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
  processIncarnationForPid(pid: number): {
    processUuid: string;
    processBirth: string;
    evidence: "process_birth";
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
  }): import("./terminal-list-ownership-service.js")
    .DeferredCodexAuthorityObservation | undefined;
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
  & TerminalListPolicyConfiguration
  & { ownershipService: TerminalListOwnershipService };

const terminalListRuntimeContext = new AsyncLocalStorage<TerminalListRuntime>();

function terminalListRuntime(): TerminalListRuntime {
  const runtime = terminalListRuntimeContext.getStore();
  if (!runtime) {
    throw new Error("Terminal list facade runtime is unavailable");
  }
  return runtime;
}

function terminalListOwnershipService(): TerminalListOwnershipService {
  return terminalListRuntime().ownershipService;
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
  const ownershipService = createTerminalListOwnershipService({
    ...dependencies.store,
    ...dependencies.authority,
    codexProcessIncarnationForPid:
      dependencies.discovery.codexProcessIncarnationForPid,
    currentWorkingDirectory: cliCwd,
    runtimeLog
  });
  const runtime: TerminalListRuntime = {
    ...dependencies.reconciliation,
    ...dependencies.discovery,
    ...dependencies.store,
    ...dependencies.authority,
    ...dependencies.policy,
    ownershipService
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
  const store = inspectStoreCompatibilityForTerminalList(storeDir);
  let reconciliation: Record<string, unknown>;
  if (options.reconcile === true) {
    try {
      reconciliation = await reconcileStoreForList(storeDir, options);
    } catch (error) {
      reconciliation = {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error)
      };
      runtimeLog("warn", "terminal_list_reconciliation_failed", {
        store_dir: storeDir,
        error: reconciliation.reason
      });
    }
  } else {
    reconciliation = {
      status: "disabled",
      reason: "standalone list is read-only unless --reconcile is supplied"
    };
  }
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

function inspectStoreCompatibilityForTerminalList(
  storeDir: string
): StoreCompatibility {
  try {
    return inspectStoreCompatibility(storeDir);
  } catch (error) {
    return {
      status: "incompatible",
      store_dir: storeDir,
      manifest_path: storeManifestPath(storeDir),
      readable: false,
      writable: false,
      reason: `AKK Store metadata is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
}

function physicalOnlyTerminalProjection(
  terminals: TerminalListScanEntry[],
  reason: string
): ReturnType<typeof terminalFirstListProjection> {
  return {
    terminals: terminals.map((terminal) => {
      const {
        _automated_input_composer_ready: _composer,
        _user_explicit_composer_ready: _userComposer,
        _codex_open_root_rollout_inventory: _inventory,
        _codex_latent_clear_resume: _resume,
        _terminal_user_explicit_send_action: terminalUserExplicitSendAction,
        _terminal_status_snapshot: _status,
        ...publicTerminal
      } = terminal;
      const actions = isRecord(publicTerminal.available_actions)
        ? publicTerminal.available_actions
        : {};
      const send = isRecord(terminalUserExplicitSendAction)
        ? terminalUserExplicitSendAction
        : undefined;
      const status = isRecord(actions.status) ? actions.status : undefined;
      return {
        ...publicTerminal,
        management_state: "unavailable",
        management_unavailable: { reason },
        managed: {
          session_id: null,
          session_short_ref: null,
          current_turn: null,
          recent_turn: null,
          turn_count: 0,
          hidden_turn_count: 0,
          session_count: 0
        },
        available_actions: {
          ...(status ? { status } : {}),
          ...(send ? { send } : {})
        }
      };
    }),
    unavailableManagedTurns: []
  };
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
  const managementErrors: string[] = [];
  let allManagedConversations: Conversation[] = [];
  try {
    allManagedConversations = listConversations(storeDir)
      .filter(terminalListRuntime().isDiscoverableTmuxConversation);
  } catch (error) {
    managementErrors.push(
      `managed Turn inventory is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  let managedSessions: ManagedSessionState[] = [];
  if (store.readable) {
    try {
      managedSessions = listManagedSessions(storeDir);
    } catch (error) {
      managementErrors.push(
        `managed Session inventory is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
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
  let projection: ReturnType<typeof terminalFirstListProjection>;
  if (managementErrors.length === 0) {
    try {
      projection = terminalFirstListProjection({
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
    } catch (error) {
      managementErrors.push(
        `managed terminal projection is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      projection = physicalOnlyTerminalProjection(
        physicalTerminals,
        managementErrors.join("; ")
      );
    }
  } else {
    projection = physicalOnlyTerminalProjection(
      physicalTerminals,
      managementErrors.join("; ")
    );
  }
  const exactWatchScan = terminalListRuntime()
    .scanTerminalWatchesForExactObservation;
  let watchObservation: {
    watches: JsonObject[];
    activeOverlayTrusted: boolean;
  };
  try {
    watchObservation = tolerateInvalidWatchRecords && exactWatchScan
      ? exactWatchScan(storeDir, { includeAll })
      : {
          watches: terminalListRuntime().listTerminalWatches?.(
            storeDir,
            { includeAll }
          ) ?? [],
          activeOverlayTrusted: true
        };
  } catch (error) {
    runtimeLog("warn", "terminal_watch_inventory_unavailable", {
      store_dir: storeDir,
      error: error instanceof Error ? error.message : String(error)
    });
    watchObservation = { watches: [], activeOverlayTrusted: false };
  }
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
  return {
    includeAll,
    terminals: projection.terminals,
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
  const store = inspectStoreCompatibilityForTerminalList(storeDir);
  const scan = await buildTerminalListGroup({ options, terminalId });
  const matches = scan.terminalControlled.filter(
    (terminal) => stringValue(terminal.id) === terminalId
  );
  if (matches.length !== 1) {
    const state = scan.summary.error ? "unavailable" : "absent";
    runtimeLog("info", "terminal_exact_observation", {
      terminal_id: terminalId,
      state,
      matching_terminal_count: matches.length,
      observed_terminal_ids: scan.terminalControlled.map((terminal) => terminal.id),
      scan_summary: scan.summary
    });
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
    runtimeLog("info", "terminal_exact_observation", {
      terminal_id: terminalId,
      state: "unavailable",
      stage: "projection",
      matching_terminal_count: projectedMatches.length,
      scan_summary: scan.summary
    });
    return {
      state: "unavailable",
      reason: "the exact terminal could not be projected authoritatively",
      summary: scan.summary
    };
  }
  runtimeLog("info", "terminal_exact_observation", {
    terminal_id: terminalId,
    state: "available",
    matching_terminal_count: 1,
    scan_summary: scan.summary
  });
  return {
    state: "available",
    rawTerminal: matches[0],
    terminal: projectedMatches[0],
    summary: scan.summary
  };
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
  statusFilter: _statusFilter,
  terminalId
}: {
  options: TerminalListCliOptions;
  agentFilter?: ExecutorKind;
  statusFilter?: string;
  terminalId?: string;
}): Promise<TerminalListScan> {
  const runtime = terminalListRuntime();
  return collectTerminalListInventory({
    options,
    agentFilter,
    terminalId,
    ports: {
      createRegistry: (currentOptions) =>
        runtime.createRuntimeTerminalAgentRegistry(currentOptions),
      createBridge: (currentOptions, provider, registry) =>
        runtime.createTerminalAgentBridge(currentOptions, provider, registry),
      createProvider: (currentOptions) =>
        runtime.createTerminalControlProvider(currentOptions),
      createProcessSource: (currentOptions) =>
        runtime.createTerminalProcessSource(currentOptions),
      projectTerminal: ({ session, activeSessions, options: currentOptions,
        bridge }) => terminalControlledListEntry(
        session,
        activeSessions,
        currentOptions,
        bridge
      ),
      log: runtimeLog
    }
  });
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
  const facts = await collectTerminalFactsForList(
    session,
    activeSessions,
    options,
    bridge,
    terminalControl
  );
  const {
    orphanedDispatch,
    nativeIdentityObservation,
    nativeAgentIdentity,
    authorityNativeIdentityObservation,
    authorityNativeAgentIdentity,
    codexOpenRootRolloutInventory,
    nativeProcessUuid,
    nativeProcessBirth,
    nativeProcessEvidence
  } = facts.native;
  const {
    observed: _observedTerminalState,
    effective: effectiveTerminalState,
    projected: projectedTerminalState,
    snapshot: terminalStatusSnapshot,
    statusCardNativeThreadId
  } = facts.status;
  const {
    agentVersion,
    lifecycleCapability,
    nativeInspectionCapability,
    modelControlCapability,
    compatibilityWarnings
  } = facts.runtime;
  const {
    automatedInputComposerReady,
    userExplicitComposerReady
  } = facts.composer;
  const {
    terminalId,
    childPids,
    processIncarnation: physicalProcessIncarnation
  } = facts.physical;
  const {
    latentClearResume: codexLatentClearResumeObservationValue
  } = facts.codex;
  const lifecycleBindingToken = unmanagedTerminalBindingToken({
    terminalId,
    terminalControl,
    agent: session.agent,
    pid: session.pid,
    workspace: session.cwd ?? terminalControl.currentPath ?? cliCwd(),
    nativeThreadId: nativeAgentIdentity?.sessionId,
    processUuid: nativeProcessUuid,
    processBirth: nativeProcessBirth,
    rollout: nativeAgentIdentity?.rollout
  });
  const authorityLifecycleBindingToken = unmanagedTerminalBindingToken({
    terminalId,
    terminalControl,
    agent: session.agent,
    pid: session.pid,
    workspace: session.cwd ?? terminalControl.currentPath ?? cliCwd(),
    nativeThreadId: authorityNativeAgentIdentity?.sessionId,
    processUuid: nativeProcessUuid,
    processBirth: nativeProcessBirth,
    rollout: authorityNativeAgentIdentity?.rollout
  });
  const actionSubject: TerminalListActionSubject = {
    exactTerminalRow: true,
    processState: "active",
    agent: session.agent,
    terminalControl,
    pid: session.pid
  };
  const actionDecisions = decideTerminalListActions({
    subject: actionSubject,
    facts
  });
  const commands = actionDecisions.commands;
  const entry = {
    id: terminalId,
    short_ref: sessionShortRef(terminalId),
    source: "terminal",
    agent: session.agent,
    process_state: "active",
    pid: session.pid,
    child_pids: childPids,
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
    model_control: modelControlCapability,
    ...(compatibilityWarnings.length > 0
      ? { compatibility_warnings: compatibilityWarnings }
      : {}),
    lifecycle_binding_token: lifecycleBindingToken,
    confidence: session.confidence,
    reason: session.reason,
    terminal_control: terminalControl,
    approval_state: projectedTerminalState.approval_state,
    activity_state: projectedTerminalState.activity_state,
    activity_reason: projectedTerminalState.activity_reason,
    screen_state: projectedTerminalState.screen_state,
    screen_reason: projectedTerminalState.screen_reason,
    native_identity_state: projectedTerminalState.native_identity_state,
    durable_activity_state: projectedTerminalState.durable_activity_state,
    durable_activity_reason: projectedTerminalState.durable_activity_reason,
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
    _user_explicit_composer_ready: userExplicitComposerReady,
    _native_identity_authority: {
      observation: authorityNativeIdentityObservation,
      identity: authorityNativeAgentIdentity,
      lifecycle_binding_token: authorityLifecycleBindingToken
    },
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
              `/akk close ${terminalId} ` +
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
    commands
  };
  const renderedActions = renderAvailableListActions(entry);
  const terminalUserExplicitSendAuthority =
    actionDecisions.terminalUserExplicitSend.eligible
      ? decideTerminalUserExplicitSendAuthority({
      exactTerminalRow: true,
      terminalId: entry.id,
      processState: entry.process_state,
      terminalControl,
      agent: session.agent,
      pid: session.pid,
      processUuid: physicalProcessIncarnation?.processUuid,
      processBirth: physicalProcessIncarnation?.processBirth,
      approvalScanned: projectedTerminalState.approval_state.scanned === true,
      approvalBlocked: projectedTerminalState.approval_state.blocked === true,
      // Codex user-explicit Send treats this observation as advisory: an
      // off-screen or truncated composer must not hide the physical action.
      // Claude Code still consumes the exact-composer result in the shared
      // authority decision below.
      userExplicitComposerReady
      })
      : { eligible: false as const };
  const terminalUserExplicitSendAction =
    terminalUserExplicitSendAuthority.eligible
      ? {
          tool: "agent_knock_knock_send",
          arguments: {
            selector: terminalUserExplicitSendAuthority.terminalId,
            expected_terminal_token:
              terminalUserExplicitSendAuthority.expectedTerminalToken
          },
          missing_required: ["request"],
          scope: "terminal_user_explicit",
          ...(session.agent === "codex"
            ? {
                composer_policy:
                  "replace_current_composer_and_submit"
              }
            : {})
        }
      : undefined;
  const modelControlFacts = modelControlPolicyFacts({
    subject: actionSubject,
    facts
  });
  const modelControlAvailability = materializeModelControlAvailability({
    ...modelControlFacts,
    nativeAuthority: modelControlFacts.nativeAuthority.kind ===
        "exact_session" && lifecycleBindingToken
      ? {
          kind: "exact_session",
          ordinaryBindingToken: lifecycleBindingToken
        }
      : modelControlFacts.nativeAuthority.kind === "verified_zero_rollout"
        ? { kind: "verified_zero_rollout" }
        : { kind: "unavailable" }
  }, actionDecisions.modelControl);
  const modelControlActions = renderTerminalModelControlActions({
    renderedActions,
    availability: modelControlAvailability,
    mutationScope: modelControlCapability.scope
  });
  const foregroundIdentificationActions =
    terminalUserExplicitSendAuthority.eligible &&
      commands.identify_foreground === true
      ? {
          identify_foreground: {
            tool: "agent_knock_knock_identify_foreground",
            arguments: {
              terminal_id: entry.id,
              expected_terminal_token:
                terminalUserExplicitSendAuthority.expectedTerminalToken
            },
            scope: "ephemeral_diagnostic_only",
            grants_authority: false,
            requires_user_intent: true
          },
          identify_and_send: {
            tool: "agent_knock_knock_identify_and_send",
            arguments: {
              terminal_id: entry.id,
              expected_terminal_token:
                terminalUserExplicitSendAuthority.expectedTerminalToken
            },
            missing_required: ["request"],
            scope: "terminal_atomic_identify_and_send",
            requires_user_intent: true
          }
        }
      : {};
  const { commands: _commands, ...publicEntry } = entry;
  return {
    ...publicEntry,
    ...(terminalUserExplicitSendAction
      ? { _terminal_user_explicit_send_action: terminalUserExplicitSendAction }
      : {}),
    available_actions: {
      ...modelControlActions,
      ...foregroundIdentificationActions
    }
  };
}

async function collectTerminalFactsForList(
  session: ActiveTerminalProcess,
  activeSessions: ActiveTerminalProcess[],
  options: TerminalListCliOptions,
  bridge: TerminalAgentBridge,
  terminalControl: TerminalControlRef
) {
  const terminalId = bridge.terminalConversationId(session);
  const adapter = bridge.registry.require(session.agent);
  return collectTerminalListTerminalFacts({
    session,
    terminalControl,
    terminalId,
    childPids: childProcessIdsForRoot(session, activeSessions),
    adapter,
    ports: terminalListFactPortsFor({
      session,
      terminalControl,
      terminalId,
      options,
      bridge
    })
  });
}

function terminalListFactPortsFor(input: {
  session: ActiveTerminalProcess;
  terminalControl: TerminalControlRef;
  terminalId: string;
  options: TerminalListCliOptions;
  bridge: TerminalAgentBridge;
}): TerminalListTerminalFactPorts {
  const { session, terminalControl, terminalId, options, bridge } = input;
  return {
    observeStatus: () => listStateForTerminal(
      session.agent,
      terminalControl,
      options,
      bridge,
      {
        pid: session.pid,
        cwd: session.cwd,
        // Status and approval share this exact full terminal identity.
        ...(session.agent === "codex"
          ? { conversationId: terminalId }
          : { sessionId: session.sessionId }),
        terminalTarget: terminalControl.target
      }
    ),
    observeNativeIdentity: (observedTerminalId) =>
      observeTerminalNativeListIdentity(
        session,
        terminalControl,
        options,
        bridge,
        observedTerminalId
      ),
    projectEffectiveState: ({ terminalState, native }) =>
      effectiveTerminalListState({
        session,
        terminalState,
        nativeIdentityObservation: native.nativeIdentityObservation,
        nativeAgentIdentity: native.nativeAgentIdentity,
        nativeIdentityAuthorityObservation:
          native.authorityNativeIdentityObservation,
        codexOpenRootRolloutInventory: native.codexOpenRootRolloutInventory,
        nativeProcessUuid: native.nativeProcessUuid,
        nativeProcessBirth: native.nativeProcessBirth
      }),
    observeAgentVersion: () =>
      terminalListRuntime().agentVersionForRunningProcess(
        session.agent,
        session.pid,
        options
      ),
    observeTerminalHasBlockingTurn: () =>
      observeTerminalHasBlockingTurnForList(options, terminalControl),
    observeComposer: (terminalState) => observeAutomatedInputComposerReady({
      session,
      terminalControl,
      terminalState,
      options
    }),
    observePhysicalProcessIncarnation: () =>
      observePhysicalProcessIncarnationForList(session, terminalControl),
    observeLatentClearResume: (request) =>
      terminalListRuntime().codexLatentClearResumeObservation(request),
    observeModelControlResidual: ({
        agentVersion,
        modelControlCapability,
        modelControlProfile,
        native,
        zeroRolloutVerified,
        effectiveTerminalState,
        terminalHasInteraction,
        terminalHasBlockingTurn,
        hasOrphanedDispatch
      }) => observeModelControlResidualForList({
      bridge,
      session,
      terminalControl,
      agentVersion,
      modelControlCapability,
      modelControlProfile,
      nativeAgentIdentity: native.nativeAgentIdentity,
      zeroRolloutVerified,
      nativeIdentityEligible:
        (session.agent === "codex" &&
          isExactNativeThreadId(native.nativeAgentIdentity?.sessionId)) ||
        zeroRolloutVerified,
      effectiveTerminalState,
      terminalHasInteraction,
      terminalHasBlockingTurn,
      hasOrphanedDispatch
    }),
    projectStatusSnapshot: terminalBridgeStatusWithProjection
  };
}

function observeTerminalHasBlockingTurnForList(
  options: TerminalListCliOptions,
  terminalControl: TerminalControlRef
): boolean {
  try {
    return terminalIncarnationBlockingTurns(
      terminalListRuntime().storeDirFromOptions(options),
      terminalControl
    ).length > 0;
  } catch (error) {
    runtimeLog("warn", "terminal_managed_turn_inventory_unavailable", {
      terminal_target: terminalControl.target,
      error: error instanceof Error ? error.message : String(error)
    });
    return true;
  }
}

function observePhysicalProcessIncarnationForList(
  session: ActiveTerminalProcess,
  terminalControl: TerminalControlRef
): TerminalListPhysicalProcessIncarnation | undefined {
  try {
    return terminalListRuntime().processIncarnationForPid(session.pid);
  } catch (error) {
    runtimeLog("warn", "terminal_physical_process_incarnation_unavailable", {
      agent: session.agent,
      terminal_target: terminalControl.target,
      pid: session.pid,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

async function observeModelControlResidualForList(input: {
  bridge: TerminalAgentBridge;
  session: ActiveTerminalProcess;
  terminalControl: TerminalControlRef;
  agentVersion?: string;
  modelControlCapability: TerminalModelControlCapabilities;
  modelControlProfile?: TerminalModelControlProfile;
  nativeAgentIdentity?: TerminalNativeIdentity;
  zeroRolloutVerified: boolean;
  nativeIdentityEligible: boolean;
  effectiveTerminalState: EffectiveTerminalListState;
  terminalHasInteraction: boolean;
  terminalHasBlockingTurn: boolean;
  hasOrphanedDispatch: boolean;
}): Promise<TerminalModelControlResidualObservation | undefined> {
  const inspect = input.bridge.inspectModelControlResidual;
  const profile = input.modelControlProfile;
  if (
    typeof inspect !== "function" ||
    input.session.agent !== "codex" ||
    !profile?.supportsResidualRepair ||
    input.modelControlCapability.status !== "supported" ||
    input.modelControlCapability.behaviorProfile !==
      profile.behaviorProfile ||
    !input.nativeIdentityEligible ||
    input.effectiveTerminalState.activity_state === "working" ||
    input.effectiveTerminalState.activity_state === "awaiting_approval" ||
    input.effectiveTerminalState.approval_state.scanned !== true ||
    input.effectiveTerminalState.approval_state.blocked === true ||
    input.terminalHasInteraction ||
    input.terminalHasBlockingTurn ||
    input.hasOrphanedDispatch
  ) {
    return undefined;
  }
  const adapter = input.bridge.registry.require("codex");
  const plan = input.modelControlCapability.status === "supported"
    ? adapter.planModelControl?.(input.modelControlCapability)
    : undefined;
  if (!plan || !terminalModelControlPlanConforms({
    agent: input.session.agent,
    agentVersion: input.agentVersion,
    plan
  })) {
    return undefined;
  }
  const identity = input.nativeAgentIdentity;
  const runtime: TerminalRuntimeIdentity = {
    pid: input.session.pid,
    agentVersion: input.agentVersion,
    cwd: input.terminalControl.currentPath,
    terminalTarget: input.terminalControl.target,
    ...(input.zeroRolloutVerified
      ? { expectedEmptyNativeSession: true }
      : {}),
    ...(identity?.sessionId
      ? {
          nativeSessionId: identity.sessionId,
          expectedNativeSessionId: identity.sessionId
        }
      : {}),
    ...(identity?.processUuid
      ? { nativeProcessUuid: identity.processUuid }
      : {}),
    ...(identity?.processBirth
      ? { nativeProcessBirth: identity.processBirth }
      : {}),
    ...(identity?.rollout
      ? {
          requireNativeRolloutIdentity: true,
          nativeRollout: identity.rollout
        }
      : {})
  };
  try {
    return await inspect.call(
      input.bridge,
      "codex",
      input.terminalControl,
      profile.agentVersion,
      plan,
      { runtime, beforeInput: () => undefined }
    );
  } catch (error) {
    runtimeLog("warn", "terminal_model_control_residual_probe_unavailable", {
      terminal_target: input.terminalControl.target,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function effectiveTerminalListState(input: {
  session: ActiveTerminalProcess;
  terminalState: TerminalListState;
  nativeIdentityObservation: TerminalNativeIdentityObservation;
  nativeAgentIdentity?: TerminalNativeIdentity;
  nativeIdentityAuthorityObservation: TerminalNativeIdentityObservation;
  codexOpenRootRolloutInventory?: CodexOpenRootRolloutInventory;
  nativeProcessUuid?: string;
  nativeProcessBirth?: string;
}): EffectiveTerminalListState {
  const {
    session,
    terminalState,
    nativeIdentityObservation,
    nativeAgentIdentity,
    nativeIdentityAuthorityObservation,
    codexOpenRootRolloutInventory,
    nativeProcessUuid,
    nativeProcessBirth
  } = input;
  const nativeIdentityState = terminalNativeIdentityState({
    observation: nativeIdentityAuthorityObservation,
    codexOpenRootRolloutInventory
  });
  if (session.agent !== "codex") {
    return terminalListStateWithStatusAxes({
      terminalState,
      legacyState: terminalState,
      nativeIdentityState,
      durableActivityState: "unknown",
      durableActivityReason:
        `durable activity evidence is unavailable for ${session.agent} terminals`
    });
  }
  const liveScreenStateWins =
    terminalState.activity_state === "working" ||
    terminalState.activity_state === "awaiting_approval" ||
    terminalState.approval_state.blocked === true;
  if (nativeIdentityObservation.status === "verified_absent") {
    return terminalListStateWithStatusAxes({
      terminalState,
      legacyState: terminalState,
      nativeIdentityState,
      durableActivityState: "unknown",
      durableActivityReason:
        "durable Codex activity is unknown because no open native rollout was observed"
    });
  }
  if (
    nativeIdentityObservation.status !== "resolved" ||
    !nativeAgentIdentity?.rollout ||
    !nativeAgentIdentity.sessionId ||
    !nativeProcessUuid ||
    !nativeProcessBirth
  ) {
    const reason = nativeIdentityObservation.status === "unavailable"
      ? nativeIdentityObservation.reason ??
        "exact Codex identity observation failed"
      : nativeIdentityState === "ambiguous"
        ? "the foreground Codex native identity is ambiguous"
        : "exact Codex rollout/process identity is incomplete";
    const legacyState = liveScreenStateWins
      ? terminalState
      : terminalListStateWithUnavailableDurableActivity(
          terminalState,
          reason
        );
    return terminalListStateWithStatusAxes({
      terminalState,
      legacyState,
      nativeIdentityState,
      durableActivityState: "unknown",
      durableActivityReason:
        `durable Codex activity evidence is unavailable: ${reason}`
    });
  }
  const currentIdentity: CodexRolloutAcceptanceIdentity = {
    sessionId: nativeAgentIdentity.sessionId,
    processUuid: nativeProcessUuid,
    processBirth: nativeProcessBirth,
    rollout: nativeAgentIdentity.rollout
  };
  try {
    const activeTask = Boolean(
      captureCodexHumanStartedActiveTaskAnchor({ currentIdentity })
    );
    const activeTaskReason =
      "Codex rollout contains an exact unfinished human-started task";
    const durableActivityState = nativeIdentityState === "resolved"
      ? activeTask ? "working" : "idle"
      : "unknown";
    const durableActivityReason = nativeIdentityState !== "resolved"
      ? `durable Codex activity evidence is unavailable because the ` +
        `foreground native identity is ${nativeIdentityState}`
      : activeTask
        ? activeTaskReason
        : "exact Codex rollout contains no unfinished human-started task";
    const legacyState = liveScreenStateWins || !activeTask
      ? terminalState
      : {
          ...terminalState,
          activity_state: "working" as const,
          activity_reason: activeTaskReason
        };
    return terminalListStateWithStatusAxes({
      terminalState,
      legacyState,
      nativeIdentityState,
      durableActivityState,
      durableActivityReason
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    runtimeLog("warn", "terminal_durable_activity_unavailable", {
      agent: session.agent,
      pid: session.pid,
      reason
    });
    const legacyState = liveScreenStateWins
      ? terminalState
      : terminalListStateWithUnavailableDurableActivity(
          terminalState,
          reason
        );
    return terminalListStateWithStatusAxes({
      terminalState,
      legacyState,
      nativeIdentityState,
      durableActivityState: "unknown",
      durableActivityReason:
        `durable Codex activity evidence is unavailable: ${reason}`
    });
  }
}

function terminalNativeIdentityState(input: {
  observation: TerminalNativeIdentityObservation;
  codexOpenRootRolloutInventory?: CodexOpenRootRolloutInventory;
}): TerminalNativeIdentityState {
  if (input.observation.status === "resolved") {
    return "resolved";
  }
  if (input.codexOpenRootRolloutInventory?.status === "unbound") {
    return "ambiguous";
  }
  if (
    input.observation.status === "verified_absent" ||
    input.codexOpenRootRolloutInventory?.status === "verified_absent"
  ) {
    return "verified_absent";
  }
  return "unavailable";
}

function terminalListStateWithStatusAxes(input: {
  terminalState: TerminalListState;
  legacyState: TerminalListState;
  nativeIdentityState: TerminalNativeIdentityState;
  durableActivityState: TerminalDurableActivityState;
  durableActivityReason: string;
}): EffectiveTerminalListState {
  return {
    ...input.legacyState,
    screen_state: input.terminalState.screen_state,
    screen_reason: input.terminalState.screen_reason,
    native_identity_state: input.nativeIdentityState,
    durable_activity_state: input.durableActivityState,
    durable_activity_reason: input.durableActivityReason
  };
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

function terminalBridgeStatusWithProjection(
  status: TerminalBridgeStatus,
  projection: EffectiveTerminalListState
): TerminalBridgeStatus {
  const descriptors = Object.getOwnPropertyDescriptors(status);
  descriptors.activity_state = {
    configurable: true,
    enumerable: true,
    value: projection.activity_state,
    writable: true
  };
  descriptors.activity_reason = {
    configurable: true,
    enumerable: true,
    value: projection.activity_reason,
    writable: true
  };
  for (const [field, value] of Object.entries({
    screen_state: projection.screen_state,
    screen_reason: projection.screen_reason,
    native_identity_state: projection.native_identity_state,
    durable_activity_state: projection.durable_activity_state,
    durable_activity_reason: projection.durable_activity_reason
  })) {
    descriptors[field] = {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    };
  }
  return Object.create(
    Object.getPrototypeOf(status),
    descriptors
  ) as TerminalBridgeStatus;
}

async function observeTerminalNativeListIdentity(
  session: ActiveTerminalProcess,
  terminalControl: TerminalControlRef,
  options: TerminalListCliOptions,
  bridge: TerminalAgentBridge,
  terminalId: string
): Promise<TerminalNativeListIdentityFacts> {
  let orphanedDispatch: TerminalDispatchLedgerDocument | undefined;
  try {
    orphanedDispatch =
      terminalListRuntime().orphanedTerminalDispatchForRecovery(terminalControl);
  } catch (error) {
    runtimeLog("warn", "terminal_orphaned_dispatch_observation_unavailable", {
      terminal_target: terminalControl.target,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  let codexIdentityContext:
    | ReturnType<TerminalListDiscoveryPorts["codexManagedIdentityResolutionContext"]>
    | undefined;
  if (session.agent === "codex") {
    try {
      codexIdentityContext = terminalListRuntime().codexManagedIdentityResolutionContext({
        storeDir: terminalListRuntime().storeDirFromOptions(options),
        terminal: {
          conversationId: terminalId,
          agent: session.agent,
          pid: session.pid,
          terminalControl
        }
      });
    } catch (error) {
      // Preserve generic discovery when Store hints are unavailable. Once an
      // exact hint exists, the constrained resolver below still evaluates it;
      // a separate complete root inventory may later describe the physical
      // read-only identity without granting managed mutation authority.
      runtimeLog("warn", "terminal_managed_identity_context_unavailable", {
        agent: session.agent,
        terminal_target: terminalControl.target,
        pid: session.pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  let nativeIdentityObservation: TerminalNativeIdentityObservation;
  try {
    nativeIdentityObservation =
      await terminalListRuntime().observeCurrentNativeAgentSessionIdentity({
        options,
        agent: session.agent,
        pid: session.pid,
        cwd: session.cwd ?? terminalControl.currentPath,
        preferredSessionId: codexIdentityContext?.preferredSessionId,
        allowedCompanionIdentity: codexIdentityContext?.companions.primary,
        allowedAdditionalIdentities: codexIdentityContext?.companions.additional
      });
  } catch (error) {
    nativeIdentityObservation = {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const authorityNativeIdentityObservation = nativeIdentityObservation;
  const authorityNativeAgentIdentity =
    authorityNativeIdentityObservation.status === "resolved"
      ? authorityNativeIdentityObservation.identity
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
      // Keep a verified empty inventory in the private raw projection. It is
      // the exact pre-materialization boundary needed to attach a fallback
      // Watch when this physical Send creates the process's first rollout.
      codexOpenRootRolloutInventory = inventory;
    } catch (error) {
      runtimeLog("warn", "terminal_codex_open_root_inventory_unavailable", {
        terminal_target: terminalControl.target,
        pid: session.pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (
    session.agent === "codex" &&
    nativeIdentityObservation.status === "unavailable" &&
    codexOpenRootRolloutInventory?.status === "resolved" &&
    codexOpenRootRolloutInventory.pid === session.pid
  ) {
    const constrainedReason = nativeIdentityObservation.reason;
    const [identity] = codexOpenRootRolloutInventory.roots;
    if (
      identity.processUuid === codexOpenRootRolloutInventory.processUuid &&
      identity.processBirth === codexOpenRootRolloutInventory.processBirth
    ) {
      nativeIdentityObservation = {
        status: "resolved",
        identity
      };
      runtimeLog(
        "info",
        "terminal_native_session_identity_resolved_from_unique_root_inventory",
        {
          agent: session.agent,
          terminal_target: terminalControl.target,
          pid: session.pid,
          preferred_session_id: codexIdentityContext?.preferredSessionId,
          resolved_session_id: identity.sessionId,
          constrained_error: constrainedReason,
          inventory_fingerprint:
            codexOpenRootRolloutInventory.inventoryFingerprint
        }
      );
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
  const nativeAgentIdentity = nativeIdentityObservation.status === "resolved"
    ? nativeIdentityObservation.identity
    : undefined;
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
    authorityNativeIdentityObservation,
    authorityNativeAgentIdentity,
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
  options
}: {
  session: ActiveTerminalProcess;
  terminalControl: TerminalControlRef;
  terminalState: Awaited<ReturnType<typeof listStateForTerminal>>;
  options: TerminalListCliOptions;
}): Promise<{
  automatedInputComposerReady: boolean;
  userExplicitComposerReady: boolean;
}> {
  let ready = terminalListRuntime().nativeInspectionComposerEmpty(
    session.agent,
    terminalState.screen_excerpt
  );
  const userExplicitPromptSafe =
    terminalState.activity_state !== "awaiting_approval" &&
    terminalState.approval_state.blocked !== true;
  let userExplicitReady = session.agent === "codex"
    ? userExplicitPromptSafe
    : ready && userExplicitPromptSafe;
  if (
    session.agent !== "codex" ||
    terminalState.approval_state.blocked === true ||
    !terminalControl.capabilities.includes("send_keys") ||
    !terminalControl.capabilities.includes("screen_status")
  ) {
    return {
      automatedInputComposerReady: ready,
      userExplicitComposerReady: userExplicitReady
    };
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
    // Styled Composer evidence remains mandatory for managed/native input,
    // but is advisory for a user's physical Codex Send.
    userExplicitReady = userExplicitPromptSafe;
  } catch {
    // A failed styled capture suppresses managed/native input only. The
    // separately scanned approval state still authorizes physical Codex Send.
    ready = false;
    userExplicitReady = userExplicitPromptSafe;
  }
  return {
    automatedInputComposerReady: ready,
    userExplicitComposerReady: userExplicitReady
  };
}

type TerminalFirstListContext = TerminalListOwnershipContext & {
  sessionAuthorityRequired: boolean;
  includeAll: boolean;
};

function renderTerminalFirstListEntry(
  terminal: Record<string, any>,
  context: TerminalFirstListContext,
  observation: ReturnType<TerminalListOwnershipService["observeActionAuthority"]>
): Record<string, any> {
  const {
    sessionAuthorityRequired,
    includeAll,
    mutationsAllowed,
    conversationHasNonterminalDeferredTransfer
  } = context;
  const {
    automatedInputComposerReady,
    terminalUserExplicitSendAction,
    publicTerminal,
    terminalControl,
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
  const managedFastPathToken = "token" in sendAuthority
    ? sendAuthority.token
    : undefined;
  const prioritizedTerminalUserExplicitSendAction =
    terminalUserExplicitSendAction && managedFastPathToken
      ? {
          ...terminalUserExplicitSendAction,
          arguments: {
            ...(isRecord(terminalUserExplicitSendAction.arguments)
              ? terminalUserExplicitSendAction.arguments
              : {}),
            expected_managed_terminal_token: managedFastPathToken
          }
        }
      : terminalUserExplicitSendAction;
  const availableActions = selectTerminalAvailableActions({
    ownership: ownership.state,
    currentActions: ownership.state === "current"
      ? currentTerminalActions(currentTurn)
      : {},
    sessionAwareRawActions:
      sessionAwareRawActions as TerminalActionSet<Record<string, any>>,
    nonOwnerRawActions,
    authoritativeSendAction,
    terminalUserExplicitSendAction:
      prioritizedTerminalUserExplicitSendAction,
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
  const projectedTerminals = terminals.map((terminal) => {
    const binding = terminalListOwnershipService().observeBindingAuthority(
      terminal,
      projectionContext
    );
    return renderTerminalFirstListEntry(
      binding.authorityTerminal,
      projectionContext,
      terminalListOwnershipService().observeActionAuthority(
        binding.authorityTerminal,
        projectionContext,
        binding
      )
    );
  });

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
  return terminalListOwnershipService().managedSessionMatchesLiveTerminalEntry(
    session,
    terminal,
    storeDir
  );
}

function provisionalManagedBindingTurnCount(
  storeDir: string,
  session: ManagedSessionState
): number | undefined {
  return terminalListOwnershipService().provisionalManagedBindingTurnCount(
    storeDir,
    session
  );
}

function managedSessionHasUnresolvedNativeTransition(
  storeDir: string,
  session: ManagedSessionState
): boolean {
  return terminalListOwnershipService().managedSessionHasUnresolvedNativeTransition(
    storeDir,
    session
  );
}

function managedSessionHasAnyNativeTransition(
  storeDir: string,
  session: ManagedSessionState
): boolean {
  return terminalListOwnershipService().managedSessionHasAnyNativeTransition(
    storeDir,
    session
  );
}

function terminalControlForManagedConversation(
  conversation: Conversation
): TerminalControlRef | undefined {
  return terminalListOwnershipService().terminalControlForManagedConversation(
    conversation
  );
}

function terminalIncarnationBlockingTurns(
  storeDir: string,
  terminalControl: TerminalControlRef,
  conversations: Conversation[] = listConversations(storeDir)
): Conversation[] {
  return terminalListOwnershipService().terminalIncarnationBlockingTurns(
    storeDir,
    terminalControl,
    conversations
  );
}

function managedTurnNeedsAttention(conversation: Conversation): boolean {
  return terminalListOwnershipService().managedTurnNeedsAttention(conversation);
}

function assertTerminalIncarnationCanStartTurn(
  storeDir: string,
  terminalControl: TerminalControlRef
): void {
  return terminalListOwnershipService().assertTerminalIncarnationCanStartTurn(
    storeDir,
    terminalControl
  );
}

function terminalDispatchOwnership(
  terminalControl: TerminalControlRef
): TerminalDispatchOwnershipResult {
  return terminalListOwnershipService().terminalDispatchOwnership(
    terminalControl
  );
}

function terminalScopedCodexApprovalBoundary({
  storeDir, terminal, session, ledger, approval, owner
}: {
  storeDir: string; terminal: unknown; session: ManagedSessionState;
  ledger?: TerminalDispatchLedgerDocument;
  approval?: TerminalScopedCodexApprovalPromptSnapshot;
  owner?: Conversation;
}): TerminalScopedCodexApprovalBoundary {
  return terminalListOwnershipService().terminalScopedCodexApprovalBoundary({
    storeDir,
    terminal,
    session,
    ledger,
    approval,
    owner
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
  return terminalListOwnershipService().managedTurnMatchesLiveTerminal(
    conversation,
    terminal
  );
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
      activity_reason: "terminal screen scan disabled",
      screen_state: "unknown",
      screen_reason: "terminal screen scan disabled"
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
      screen_state: status.screen_state ?? status.activity_state,
      screen_reason: status.screen_reason ?? status.activity_reason,
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
      activity_reason: error instanceof Error ? error.message : String(error),
      screen_state: "unknown",
      screen_reason: error instanceof Error ? error.message : String(error)
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
  if (
    sendOperation &&
    options.managedOnly === true &&
    supplied?.startsWith("terminal:v") &&
    !stringValue(options.expectedTerminalToken)
  ) {
    // `--managed-only` is an explicit diagnostic/test request for the legacy
    // managed state machine. Keep an exact physical id on that path without
    // upgrading it to the default user-priority Send authority. Ordinary user
    // Send never sets this option and continues to discover and bind fresh
    // physical authority below.
    options.session = supplied;
    return;
  }
  if (
    supplied &&
    !isSessionSelectorSyntax(supplied) &&
    !(
      sendOperation &&
      supplied.startsWith("terminal:v") &&
      !stringValue(options.expectedTerminalToken)
    )
  ) {
    // Full authoritative IDs keep their existing command-specific validation
    // path. This avoids a discovery scan before option validation and preserves
    // precise downstream errors for closed or currently non-actionable state.
    if (sendOperation) {
      if (
        supplied.startsWith("terminal:v") &&
        stringValue(options.expectedTerminalToken)
      ) {
        try {
          const observed = await observeExactTerminal({
            options,
            terminalId: supplied
          });
          const actions = observed.state === "available" &&
              isRecord(observed.terminal.available_actions)
            ? observed.terminal.available_actions
            : {};
          const send = isRecord(actions.send) ? actions.send : {};
          const argumentsValue = isRecord(send.arguments)
            ? send.arguments
            : {};
          options.expectedManagedTerminalToken =
            stringValue(argumentsValue.expected_terminal_token) ===
                stringValue(options.expectedTerminalToken)
              ? stringValue(
                  argumentsValue.expected_managed_terminal_token
                )
              : undefined;
        } catch {
          // Managed fast-path discovery is optional. The physical Send token
          // is still revalidated by execution and may fall back without Store.
          options.expectedManagedTerminalToken = undefined;
        }
      }
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
    const physical = resolution.candidate.userExplicitTerminalSend;
    if (!physical) {
      throw new Error(
        "the selected terminal no longer advertises user-priority Send"
      );
    }
    // Preserve a token-bearing caller's original selector for the exact fence.
    if (!stringValue(options.expectedTerminalToken)) {
      terminalListRuntime().rememberOriginalExpectedTerminalSelector(
        options,
        physical.terminalId
      );
    }
    options.expectedTerminalToken = physical.expectedTerminalToken;
    options.expectedManagedTerminalToken =
      physical.expectedManagedTerminalToken;
    options.session = physical.terminalId;
    options.conversation = physical.terminalId;
  } else {
    options.turn = resolution.id;
    options.conversation = resolution.id;
  }
  delete options.conversationId;
}

function isSessionSelectorSyntax(value: string): boolean {
  return (
    /^(?:only|latest|codex|claude|(?:codex|claude):latest)$/iu.test(value) ||
    /^@[0-9a-f]+$/iu.test(value)
  );
}

interface UserExplicitSendSelectorCandidate extends SessionSelectorCandidate {
  userExplicitTerminalSend?: {
    terminalId: string;
    expectedTerminalToken: string;
    expectedManagedTerminalToken?: string;
  };
}

async function sessionSelectorCandidates(
  commandName,
  options
): Promise<UserExplicitSendSelectorCandidate[]> {
  const terminalScan = await buildTerminalListGroup({
    options: {
      ...options,
      noApprovalScan: commandName === "send"
        ? false
        : ["approve", "cancel"].includes(commandName)
          ? options.noApprovalScan
          : true
    },
    agentFilter: undefined,
    statusFilter: undefined
  });
  const observedAtMs = cliNowMs();
  if (commandName === "send") {
    return terminalScan.terminalControlled
      .filter((entry) => terminalListRuntime().matchesConfiguredWorkspace(
        options.workspace,
        entry.workspace ?? entry.cwd
      ))
      .flatMap((entry) => {
        const action = isRecord(entry._terminal_user_explicit_send_action)
          ? entry._terminal_user_explicit_send_action
          : undefined;
        const argumentsValue = isRecord(action?.arguments)
          ? action.arguments
          : undefined;
        const terminalId = stringValue(entry.id);
        const expectedTerminalToken = stringValue(
          argumentsValue?.expected_terminal_token
        );
        if (
          action?.scope !== "terminal_user_explicit" ||
          !terminalId ||
          stringValue(
            argumentsValue?.selector ?? argumentsValue?.terminal_id
          ) !== terminalId ||
          !expectedTerminalToken
        ) {
          return [];
        }
        const candidate = projectSelectorCandidate({
          ...entry,
          available_actions: { send: action }
        }, commandName, observedAtMs, {
          defaultActionable: true,
          // Physical Send authority is independent of Store writability.
          mutationsAllowed: true
        });
        return [{
          ...candidate,
          userExplicitTerminalSend: {
            terminalId,
            expectedTerminalToken,
            ...(stringValue(
              argumentsValue?.expected_managed_terminal_token
            ) === undefined
              ? {}
              : {
                  expectedManagedTerminalToken: stringValue(
                    argumentsValue?.expected_managed_terminal_token
                  )
                })
          }
        }];
      });
  }
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
