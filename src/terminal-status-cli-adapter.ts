// Invocation-scoped CLI composition for status reads and explicit reconciliation.
import type { CodingAgentSessionProvider } from "./agent-session-provider.js";
import { buildConversationTrace } from "./conversation-trace.js";
import type {
  ActiveCodexProcess,
  CodexSessionSummary
} from "./codex-session-provider.js";
import { listDeferredForegroundTransfers } from
  "./deferred-foreground-transfer.js";
import type { ExecutorKind } from "./executors.js";
import { writeCliJson } from "./cli-command-runtime.js";
import { cliNow, cliRuntimeLog } from "./cli-runtime-context.js";
import {
  budgetAction,
  executorForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import type {
  ResolvedTerminalConversation,
  TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import type {
  TerminalControlRef,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  codexTerminalContextFromHistory,
  isDiscoverableTmuxConversation,
  managedConversationAbout,
  persistedExecutorLogFields,
  screenOnlyAbout,
  summarizeConversation,
  summarizeEvent,
  type CodexTerminalContext,
  type TerminalStatusJsonObject,
  type TerminalStatusSummaryPorts
} from "./terminal-status-facts.js";
import {
  appendEvent,
  ensureStoreWritable,
  inspectStoreCompatibility,
  listConversations,
  loadState,
  logPathForStatePath,
  saveState,
  statePathForConversationId
} from "./store.js";
import type { TranscriptEvent } from "./transcript.js";
import { isRecord } from "./value-guards.js";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10080;

export interface TerminalStatusCliOptions {
  conversation?: unknown;
  conversationId?: unknown;
  idleTimeoutMinutes?: unknown;
  logDir?: unknown;
  maxCommands?: unknown;
  maxMessages?: unknown;
  maxTextLength?: unknown;
  reconcile?: unknown;
  scrollbackLines?: unknown;
  state?: unknown;
  storeDir?: unknown;
  trace?: unknown;
  turn?: unknown;
  workspace?: unknown;
  [option: string]: unknown;
}

interface StatusStoreSelection {
  storeDir: string;
  reconciliationConversationId?: string;
}

interface LoadedStatusConversation {
  conversation: Conversation;
  statePath: string;
  logPath: string;
}

interface TerminalStatusMonitorItem {
  status?: string;
  [field: string]: unknown;
}

interface TerminalStatusMonitorReconciliation {
  checked: number;
  launched: number;
  repaired: number;
  collateral_stalls_checked: number;
  collateral_stalls_skipped: number;
  already_running: number;
  skipped: number;
  errors: number;
  items: TerminalStatusMonitorItem[];
}

export interface TerminalStatusSelectionPorts {
  statusStoreSelection(options: TerminalStatusCliOptions): StatusStoreSelection;
  resolveTerminalConversation(
    options: TerminalStatusCliOptions
  ): Promise<ResolvedTerminalConversation | undefined>;
  assertExpectedTerminalSelector(request: {
    options: TerminalStatusCliOptions;
    terminal: ResolvedTerminalConversation;
  }): void;
  loadConversation(options: TerminalStatusCliOptions): LoadedStatusConversation;
  terminalControlFromTakeover(value: unknown): TerminalControlRef | undefined;
  terminalRuntimeIdentity(
    conversation: Conversation,
    terminalControl: TerminalControlRef
  ): TerminalRuntimeIdentity;
}

export interface TerminalStatusObservationPorts {
  readEvents(logPath: string): TranscriptEvent[];
  createCodexProvider(
    options: TerminalStatusCliOptions
  ): CodingAgentSessionProvider;
  listActiveCodexSessions(
    options: TerminalStatusCliOptions,
    provider: CodingAgentSessionProvider
  ): Promise<ActiveCodexProcess[]>;
  createTerminalBridge(
    options: TerminalStatusCliOptions
  ): TerminalStatusBridgePort;
  terminalAdapter(
    options: TerminalStatusCliOptions,
    agent: ExecutorKind
  ): { readonly displayName: string };
}

export interface TerminalStatusBridgePort {
  status(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    options?: {
      scrollbackLines?: number;
      runtime?: TerminalRuntimeIdentity;
    }
  ): Promise<TerminalBridgeStatus>;
}

export interface TerminalStatusReconciliationPorts {
  reconcileMonitors(
    options: TerminalStatusCliOptions,
    request: {
      includeCallbackRecovery: false;
      reason: "status_reconciliation";
      conversationId?: string;
    }
  ): Promise<TerminalStatusMonitorReconciliation>;
  isFinalDeferredTransferStatus(status: string): boolean;
  workspaceMatches(configured: unknown, observed: unknown): boolean;
  acquireStateLock(statePath: string): () => void;
  terminalBridgeEnabled(conversation: Conversation): boolean;
}

export interface TerminalStatusCliDependencies {
  selection: TerminalStatusSelectionPorts;
  observation: TerminalStatusObservationPorts;
  reconciliation: TerminalStatusReconciliationPorts;
  projection: TerminalStatusSummaryPorts;
}

export interface TerminalStatusIdleReconciliation {
  checked: number;
  closed: number;
  skipped: number;
  idle_timeout_minutes: number;
}

export interface TerminalStatusCliFacade {
  runStatus(options: TerminalStatusCliOptions): Promise<void>;
  reconcileIdleConversations(
    storeDir: string,
    options?: TerminalStatusCliOptions,
    now?: Date,
    conversationId?: string
  ): TerminalStatusIdleReconciliation;
  terminalStatusForControl(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    options: TerminalStatusCliOptions,
    runtime?: TerminalRuntimeIdentity
  ): Promise<TerminalBridgeStatus>;
  activeCodexProcessForPid(
    options: TerminalStatusCliOptions,
    pid: number | undefined
  ): Promise<ActiveCodexProcess | undefined>;
  summarizeConversation(conversation: Conversation): TerminalStatusJsonObject;
}

interface ManagedStatusResult extends TerminalStatusJsonObject {
  conversation: Conversation;
  about: string;
  limitations: string[];
  terminal_control?: TerminalControlRef;
  terminal_status?: TerminalBridgeStatus;
  terminal_screen?: TerminalBridgeStatus["screen"];
}

interface TerminalDescription {
  confidence: string;
  about: string;
  limitations: string[];
}

type IdleCloseResult = "closed" | "unchanged" | "skipped";

export function createTerminalStatusCliFacade(
  dependencies: TerminalStatusCliDependencies
): TerminalStatusCliFacade {
  const facade: TerminalStatusCliFacade = Object.freeze({
    runStatus: (options) => runStatus(dependencies, facade, options),
    reconcileIdleConversations: (
      storeDir,
      options = {},
      now = cliNow(),
      conversationId
    ) => reconcileIdleConversations(
      dependencies, storeDir, options, now, conversationId),
    terminalStatusForControl: (agent, terminalControl, options, runtime) =>
      terminalStatusForControl(
        dependencies, agent, terminalControl, options, runtime),
    activeCodexProcessForPid: (options, pid) =>
      activeCodexProcessForPid(dependencies, options, pid),
    summarizeConversation: (conversation) => summarizeConversation(
      conversation, dependencies.projection)
  });
  return facade;
}

async function runStatus(
  dependencies: TerminalStatusCliDependencies,
  facade: TerminalStatusCliFacade,
  options: TerminalStatusCliOptions
): Promise<void> {
  const selection = dependencies.selection.statusStoreSelection(options);
  const reconciliation = options.reconcile === true
    ? await reconcileStoreForStatus(
        dependencies, facade, selection.storeDir, options,
        selection.reconciliationConversationId)
    : {
        status: "disabled",
        reason: "standalone status is read-only unless --reconcile is supplied"
      };
  const terminalConversation =
    await dependencies.selection.resolveTerminalConversation(options);
  if (terminalConversation) {
    await runTerminalControlStatus(
      dependencies, facade, options, selection.storeDir,
      reconciliation, terminalConversation);
    return;
  }
  await runManagedConversationStatus(
    dependencies, facade, options, selection.storeDir, reconciliation);
}

async function runTerminalControlStatus(
  dependencies: TerminalStatusCliDependencies,
  facade: TerminalStatusCliFacade,
  options: TerminalStatusCliOptions,
  storeDir: string,
  reconciliation: TerminalStatusJsonObject,
  terminalConversation: ResolvedTerminalConversation
): Promise<void> {
  dependencies.selection.assertExpectedTerminalSelector({
    options,
    terminal: terminalConversation
  });
  const terminalStatus = await facade.terminalStatusForControl(
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
    dependencies, facade, terminalConversation, terminalStatus, options);
  writeCliJson({
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
  cliRuntimeLog("info", "terminal_status_read", {
    conversation_id: terminalConversation.conversationId,
    terminal_target: terminalConversation.terminalControl.target,
    reachable: terminalStatus.reachable
  });
}

async function runManagedConversationStatus(
  dependencies: TerminalStatusCliDependencies,
  facade: TerminalStatusCliFacade,
  options: TerminalStatusCliOptions,
  storeDir: string,
  reconciliation: TerminalStatusJsonObject
): Promise<void> {
  const loaded = dependencies.selection.loadConversation(options);
  const { statePath, logPath, conversation } = loaded;
  const events = dependencies.observation.readEvents(logPath);
  const result: ManagedStatusResult = {
    conversation,
    store: inspectStoreCompatibility(storeDir),
    reconciliation,
    summary: facade.summarizeConversation(conversation),
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
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl =
    dependencies.selection.terminalControlFromTakeover(takeover);
  if (terminalControl) {
    const executor = executorForConversation(conversation);
    result.terminal_control = terminalControl;
    result.terminal_status = await facade.terminalStatusForControl(
      executor.kind,
      terminalControl,
      options,
      dependencies.selection.terminalRuntimeIdentity(
        conversation, terminalControl)
    );
    result.terminal_screen = result.terminal_status.screen;
    result.about = managedConversationAbout(
      conversation, events, result.terminal_status);
    result.limitations = result.terminal_status.reachable === false
      ? ["terminal status unavailable"]
      : [];
  } else {
    result.limitations = ["terminal control metadata is unavailable"];
  }
  writeCliJson(result);
  cliRuntimeLog("info", "task_status_read", {
    conversation_id: conversation.conversation_id,
    status: conversation.status,
    state_path: statePath,
    event_log_path: logPath,
    recent_event_count: Math.min(events.length, 10),
    trace: Boolean(options.trace)
  });
}

async function reconcileStoreForStatus(
  dependencies: TerminalStatusCliDependencies,
  facade: TerminalStatusCliFacade,
  storeDir: string,
  options: TerminalStatusCliOptions,
  conversationId?: string
): Promise<TerminalStatusJsonObject> {
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
  const monitors = await dependencies.reconciliation.reconcileMonitors(
    options,
    {
      includeCallbackRecovery: false,
      reason: "status_reconciliation",
      conversationId
    }
  );
  const idle = facade.reconcileIdleConversations(
    storeDir, options, cliNow(), conversationId);
  return {
    status: "completed",
    checked: Math.max(idle.checked, monitors.checked),
    changed: idle.closed + monitors.launched + monitors.repaired,
    closed: idle.closed,
    repaired: monitors.repaired,
    collateral_stalls_checked: monitors.collateral_stalls_checked,
    collateral_stalls_skipped: monitors.collateral_stalls_skipped,
    collateral_stall_repairs: monitors.items.filter((item) =>
      item.status === "repaired"),
    monitors_launched: monitors.launched,
    monitors_already_running: monitors.already_running,
    skipped: idle.skipped + monitors.skipped,
    errors: monitors.errors,
    idle_timeout_minutes: idle.idle_timeout_minutes
  };
}

async function terminalStatusContext(
  dependencies: TerminalStatusCliDependencies,
  facade: TerminalStatusCliFacade,
  terminalConversation: ResolvedTerminalConversation,
  terminalStatus: TerminalBridgeStatus,
  options: TerminalStatusCliOptions
): Promise<TerminalDescription> {
  if (terminalConversation.agent === "codex") {
    return codexTerminalDescription(
      dependencies, facade, terminalConversation, terminalStatus, options);
  }
  const adapter = dependencies.observation.terminalAdapter(
    options, terminalConversation.agent);
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

async function codexTerminalDescription(
  dependencies: TerminalStatusCliDependencies,
  facade: TerminalStatusCliFacade,
  terminalConversation: ResolvedTerminalConversation,
  terminalStatus: TerminalBridgeStatus,
  options: TerminalStatusCliOptions
): Promise<TerminalDescription> {
  try {
    const process = await facade.activeCodexProcessForPid(
      options, terminalConversation.pid);
    const description = await codexTerminalStatusContext(dependencies, {
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

async function terminalStatusForControl(
  dependencies: TerminalStatusCliDependencies,
  agent: ExecutorKind,
  terminalControl: TerminalControlRef,
  options: TerminalStatusCliOptions,
  runtime?: TerminalRuntimeIdentity
): Promise<TerminalBridgeStatus> {
  return dependencies.observation.createTerminalBridge(options).status(
    agent,
    terminalControl,
    {
      scrollbackLines: Number(options.scrollbackLines ?? 120),
      runtime
    }
  );
}

async function activeCodexProcessForPid(
  dependencies: TerminalStatusCliDependencies,
  options: TerminalStatusCliOptions,
  pid: number | undefined
): Promise<ActiveCodexProcess | undefined> {
  if (!Number.isInteger(pid)) {
    return undefined;
  }
  const provider = dependencies.observation.createCodexProvider(options);
  const activeSessions = await dependencies.observation.listActiveCodexSessions(
    options, provider);
  return activeSessions.find((process) => process.pid === pid);
}

async function codexTerminalStatusContext(
  dependencies: TerminalStatusCliDependencies,
  input: {
    id: string;
    process?: ActiveCodexProcess;
    options: TerminalStatusCliOptions;
    terminalControl?: TerminalControlRef;
    terminalStatus?: TerminalBridgeStatus;
  }
): Promise<CodexTerminalContext> {
  const { id, process, options, terminalControl, terminalStatus } = input;
  const provider = dependencies.observation.createCodexProvider(options);
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
    .sort((left, right) =>
      Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  if (sessions.length > 0) {
    const selected = sessions[0];
    const context = await provider.getForkContext({
      sessionId: selected.id,
      maxMessages: Number(options.maxMessages ?? 16),
      maxCommands: Number(options.maxCommands ?? 10),
      maxTextLength: Number(options.maxTextLength ?? 1200)
    });
    if (context) {
      return inferredCodexTerminalContext({
        id, process, terminalControl, terminalStatus, sessions, context
      });
    }
  }
  return screenOnlyCodexContext({
    id, process, terminalControl, terminalStatus, cwd
  });
}

function inferredCodexTerminalContext(input: {
  id: string;
  process?: ActiveCodexProcess;
  terminalControl?: TerminalControlRef;
  terminalStatus?: TerminalBridgeStatus;
  sessions: CodexSessionSummary[];
  context: NonNullable<Awaited<ReturnType<CodingAgentSessionProvider["getForkContext"]>>>;
}): CodexTerminalContext {
  const {
    id, process, terminalControl, terminalStatus, sessions, context
  } = input;
  return codexTerminalContextFromHistory({
    id,
    confidence: sessions.length === 1 ? "medium" : "low",
    match: sessions.length === 1 ? "cwd" : "cwd_latest",
    process,
    context,
    terminalControl,
    terminalStatus,
    limitations: sessions.length === 1
      ? [
          "Codex session inferred from matching cwd because the active process did not expose a session id."
        ]
      : [
          `Codex session inferred from the most recent of ${sessions.length} sessions with the same cwd.`
        ],
    candidates: sessions.slice(0, 5).map((session) => ({
      session_id: session.id,
      cwd: session.cwd,
      title: session.title ?? session.preview ?? session.firstUserMessage,
      updated_at_ms: session.updatedAtMs,
      capability: session.capability
    }))
  });
}

function screenOnlyCodexContext(input: {
  id: string;
  process?: ActiveCodexProcess;
  terminalControl?: TerminalControlRef;
  terminalStatus?: TerminalBridgeStatus;
  cwd?: string;
}): CodexTerminalContext {
  const { id, process, terminalControl, terminalStatus, cwd } = input;
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
      cwd
        ? "No matching Codex rollout history was found for this cwd."
        : "No process cwd was available for Codex history matching.",
      "Summary is limited to active process metadata and the visible terminal screen."
    ]
  };
}

function reconcileIdleConversations(
  dependencies: TerminalStatusCliDependencies,
  storeDir: string,
  options: TerminalStatusCliOptions,
  now: Date,
  conversationId?: string
): TerminalStatusIdleReconciliation {
  const timeoutMinutes = Number(
    options.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return idleReconciliation(0, 0, 0, timeoutMinutes);
  }
  ensureStoreWritable(storeDir);
  const conversations = listConversations(storeDir)
    .filter((conversation) =>
      (conversationId === undefined ||
        conversation.conversation_id === conversationId) &&
      dependencies.reconciliation.workspaceMatches(
        options.workspace, conversation.workspace));
  const reservedSourceTurnIds = reservedDeferredSourceTurnIds(
    dependencies, storeDir);
  let closed = 0;
  let skipped = 0;
  for (const conversation of conversations) {
    if (!expiredIdleConversation(conversation, now, timeoutMinutes)) {
      continue;
    }
    if (reservedSourceTurnIds.has(turnIdForConversation(conversation))) {
      skipped += 1;
      continue;
    }
    const result = closeExpiredIdleConversation(
      dependencies, storeDir, conversation, now, timeoutMinutes);
    if (result === "closed") {
      closed += 1;
    } else if (result === "skipped") {
      skipped += 1;
    }
  }
  return idleReconciliation(
    conversations.length, closed, skipped, timeoutMinutes);
}

function reservedDeferredSourceTurnIds(
  dependencies: TerminalStatusCliDependencies,
  storeDir: string
): Set<string> {
  return new Set(
    listDeferredForegroundTransfers(storeDir)
      .filter((transfer) =>
        transfer.version === 2 &&
        transfer.source_kind === "candidate_rollout_quiescent" &&
        !dependencies.reconciliation.isFinalDeferredTransferStatus(
          transfer.status))
      .flatMap((transfer) =>
        (transfer.source_turn_history ?? []).map((turn) => turn.turn_id))
  );
}

function expiredIdleConversation(
  conversation: Conversation,
  now: Date,
  timeoutMinutes: number
): boolean {
  if (conversation.status !== "idle" || !conversation.idle_since) {
    return false;
  }
  const idleSinceMs = Date.parse(conversation.idle_since);
  return Number.isFinite(idleSinceMs) &&
    now.getTime() - idleSinceMs >= timeoutMinutes * 60 * 1000;
}

function closeExpiredIdleConversation(
  dependencies: TerminalStatusCliDependencies,
  storeDir: string,
  listedConversation: Conversation,
  now: Date,
  timeoutMinutes: number
): IdleCloseResult {
  const statePath = listedConversation.state_path ??
    statePathForConversationId(listedConversation.conversation_id, storeDir);
  let releaseStateLock: (() => void) | undefined;
  try {
    releaseStateLock = dependencies.reconciliation.acquireStateLock(statePath);
  } catch (error) {
    if (isRecord(error) && error.code === "LOCK_TIMEOUT") {
      return "skipped";
    }
    throw error;
  }
  try {
    const conversation = loadState(statePath);
    if (conversation.status !== "idle" || !conversation.idle_since) {
      return "unchanged";
    }
    const idleSinceMs = Date.parse(conversation.idle_since);
    if (!Number.isFinite(idleSinceMs)) {
      return "unchanged";
    }
    const terminalBridge =
      dependencies.reconciliation.terminalBridgeEnabled(conversation) &&
      isRecord(conversation.native_session_takeover) &&
      typeof conversation.native_session_takeover
        .terminal_bridge_message_id === "string";
    if (now.getTime() - idleSinceMs < timeoutMinutes * 60 * 1000) {
      return "unchanged";
    }
    persistIdleConversationClose(
      dependencies, statePath, conversation, now, timeoutMinutes,
      terminalBridge);
    return "closed";
  } finally {
    releaseStateLock();
  }
}

function persistIdleConversationClose(
  dependencies: TerminalStatusCliDependencies,
  statePath: string,
  conversation: Conversation,
  now: Date,
  timeoutMinutes: number,
  terminalBridge: boolean
): void {
  const logPath = conversation.event_log_path ?? logPathForStatePath(statePath);
  const closeReason = `idle timeout after ${timeoutMinutes} minutes`;
  const closedConversation: Conversation = {
    ...conversation,
    status: "closed",
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
  cliRuntimeLog("info", "idle_conversation_closed", {
    conversation_id: conversation.conversation_id,
    ...executorLogFields,
    state_path: statePath,
    event_log_path: logPath,
    idle_since: conversation.idle_since,
    idle_timeout_minutes: timeoutMinutes,
    reason: closedConversation.close_reason
  });
}

function idleReconciliation(
  checked: number,
  closed: number,
  skipped: number,
  timeoutMinutes: number
): TerminalStatusIdleReconciliation {
  return {
    checked,
    closed,
    skipped,
    idle_timeout_minutes: timeoutMinutes
  };
}
