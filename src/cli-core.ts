import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type {
  ActiveCodexProcess,
  ForkContextPackage
} from "./codex-session-provider.js";
import { validateCodexRolloutAcceptanceAnchor } from
  "./terminal-submission-acceptance.js";
import { buildConversationTrace } from "./conversation-trace.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import {
  listDeferredForegroundTransfers,
  loadDeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import {
  budgetAction,
  createMessage,
  effectiveTurnStatus,
  executorForConversation,
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
  ensureStoreWritable,
  inspectStoreCompatibility,
  listConversations,
  logPathForStatePath,
  loadConversationById,
  loadState,
  pathsForConversationDir,
  saveState,
  STORE_SESSION_AUTHORITY_PROTOCOL,
  StoreLockTimeoutError,
  statePathForConversationId,
  withStoreWriterLease,
  withStoreWriterLeaseAsync
} from "./store.js";
import {
  type ManagedSessionState
} from "./managed-session.js";
import {
  probeCodexCurrentThread
} from "./native-thread-transition-verification-adapter.js";
import {
  loadManagedSession,
  saveManagedSession,
  tryLoadManagedSession
} from "./session-store.js";
import {
  TerminalControlUnavailableError,
  type TerminalControlProvider,
  type TerminalControlProviderRegistry
} from "./terminal-control-provider.js";
import {
  parseTerminalConversationId,
  type TerminalControlRef,
  type TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  terminalControlEvidenceMatches
} from "./terminal-control-ref.js";
import {
  TerminalAgentBridge,
  type ResolvedTerminalConversation
} from "./terminal-agent-bridge.js";
import {
  createTerminalRuntimeCliAdapter,
  terminalControlFromTakeover
} from "./terminal-runtime-cli-adapter.js";
import { createTerminalDispatchCompletionCliAdapter } from
  "./terminal-dispatch-completion-cli-adapter.js";
import {
  decideVerifiedDeadAgentProcess,
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
  createTerminalAcceptanceCliFacade
} from "./terminal-acceptance-cli-adapter.js";
import { createTerminalHandoffCliFacade } from
  "./terminal-handoff-cli-adapter.js";
import { createTerminalDelegateCliFacade } from
  "./terminal-delegate-cli-adapter.js";
import {
  createNativeThreadLifecycleCliAdapter
} from "./native-thread-lifecycle-cli-adapter.js";
import {
  createNativeThreadLifecycleLedgerCliAdapter
} from "./native-thread-lifecycle-ledger-cli-adapter.js";
import {
  createNativeThreadTransitionApplication
} from "./native-thread-transition-application.js";
import {
  createTerminalIdentityAuthorityCliAdapter
} from "./terminal-identity-authority-cli-adapter.js";
import {
  type TerminalNativeIdentity as NativeAgentSessionIdentity
} from "./terminal-binding-authority.js";
import {
  terminalControlAliasMatches,
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
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
import { createCallbackCliFacade } from "./callback-cli-adapter.js";
import { createTerminalMaintenanceCliFacade } from
  "./terminal-maintenance-cli-adapter.js";
import {
  terminalMonitorActivityPersistIntervalMs as terminalBridgeActivityPersistIntervalMs,
  terminalMonitorApprovalCandidate as terminalBridgeApprovalCandidate,
  terminalMonitorDeadlineAt as deadlineAt,
  validTerminalMonitorTimestampMs as validTimestampMs
} from "./terminal-monitor-decision-policy.js";
import * as monitorLaunch from "./terminal-monitor-launch-plan.js";
import * as monitorOwner from "./terminal-monitor-ownership-policy.js";
import {
  runTerminalMonitorWithStoreDeferral
} from "./terminal-monitor-application-service.js";
import {
  createTerminalMonitorStateCliAdapter
} from "./terminal-monitor-state-cli-adapter.js";
import {
  terminalDispatchLedgerLooksLifecycle,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import {
  createTerminalDispatchRepositoryCliAdapter
} from "./terminal-dispatch-repository-cli-adapter.js";
import {
  createTerminalDispatchRecoveryCliAdapter
} from "./terminal-dispatch-recovery-cli-adapter.js";
import * as deferredRecoveryAdapter from
  "./deferred-foreground-recovery-cli-adapter.js";
import {
  migratedTerminalBindingMatches
} from "./terminal-dispatch-execution.js";
import * as dispatchReceipt from "./terminal-dispatch-receipt.js";
import {
  expandHome,
  packageRootDir,
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
const terminalDispatchRepository =
  createTerminalDispatchRepositoryCliAdapter();
const acquireTerminalBridgeSendLock = terminalDispatchRepository.acquire;
const terminalBridgeRuntimeKey = terminalDispatchRepository.runtimeKey;
const loadTerminalBridgeDispatchLedger = terminalDispatchRepository.load;
const saveTerminalBridgeDispatchLedger = terminalDispatchRepository.save;
const restoreTerminalBridgeDispatchLedger = terminalDispatchRepository.restore;
const resolveTerminalBridgeDispatchLedger = terminalDispatchRepository.resolve;
const resolveTerminalDispatchLedgerPaneIncarnation =
  terminalDispatchRepository.reconcileIncarnation;
const terminalDispatchRecordMatchesControl =
  terminalDispatchRepository.matchesControl;
const terminalDispatchRecordProcessAnchor =
  terminalDispatchRepository.processAnchor;

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10080;
const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_AGENT_HARD_TIMEOUT_MINUTES = 720;
const DEFAULT_MONITOR_POLL_INTERVAL_MS = 5000;
const CLAUDE_SCREEN_APPROVAL_TTL_MS = 10 * 60 * 1000;
const CALLBACK_ATTEMPT_LEASE_MS = 2 * 60 * 1000;
const CALLBACK_RETRY_DELAYS_MS = [5000, 15000, 60000, 60000];
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
  reconcile: (...args: Parameters<
    typeof nativeThreadLifecycleFacade.reconcileLedger
  >) => nativeThreadLifecycleFacade.reconcileLedger(...args),
  beforeMutation: (...args: Parameters<
    typeof nativeThreadLifecycleFacade.recoverBeforeMutation
  >) => nativeThreadLifecycleFacade.recoverBeforeMutation(...args)
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
const nativeThreadLifecycleLedger =
  createNativeThreadLifecycleLedgerCliAdapter({
    repository: terminalDispatchRepository,
    authority: {
      ordinaryOwnerIsReleased: (ledger) => {
        const owner = loadTerminalDispatchLedgerOwner(ledger);
        return Boolean(
          owner && TERMINAL_DISPATCH_RELEASE_STATUSES.has(owner.status)
        );
      }
    }
  });
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
    await terminalDelegateCliFacade.runDelegate(options);
  } else if (commandName === "list") {
    await terminalListCliFacade.runList(options);
  } else if (commandName === "status") {
    await runStatus(options);
  } else if (commandName === "send") {
    await terminalCommandCliFacade.runSend(options);
  } else if (commandName === "new-thread" || commandName === "clear-thread") {
    await nativeThreadLifecycleFacade.runNewThread(options);
  } else if (commandName === "list-resumable-threads" || commandName === "threads") {
    await runListResumableThreads(options);
  } else if (commandName === "native-inspect" || commandName === "native-status") {
    await runNativeInspect(options);
  } else if (commandName === "resume-thread") {
    await nativeThreadLifecycleFacade.runResumeThread(options);
  } else if (commandName === "reconcile-binding") {
    await nativeThreadLifecycleFacade.runReconcileBinding(options);
  } else if (commandName === "respond") {
    await terminalCommandCliFacade.runRespond(options);
  } else if (commandName === "approve") {
    await terminalCommandCliFacade.runApprove(options);
  } else if (commandName === "cancel") {
    await terminalMaintenanceCliFacade.runCancel(options);
  } else if (commandName === "renew") {
    await terminalMaintenanceCliFacade.runRenew(options);
  } else if (commandName === "reconcile-monitors") {
    await runReconcileMonitors(options);
  } else if (commandName === "close") {
    await terminalMaintenanceCliFacade.runClose(options);
  } else if (commandName === "transcript") {
    runTranscript(options);
  } else if (commandName === "install-openclaw") {
    runInstallOpenClaw(options);
  } else if (commandName === "doctor") {
    runDoctor(options);
  } else if (commandName === "callback") {
    callbackCliFacade.runCallback(options);
  } else if (commandName === "retry-callback") {
    callbackCliFacade.runRetryCallback(options);
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

function terminalRuntime(options: CliCommandOptions = {}) {
  return createTerminalRuntimeCliAdapter({
    options,
    dependencies: cliDependencies<CliCommandOptions>(),
    completion: {
      detectExactBound: ({ conversation, nativeTakeover, request, runtime }) =>
        terminalDispatchCompletion.detectExactBoundCodexCompletion({
          conversation, nativeTakeover, request, runtime
        }),
      loadCodexContexts: async (nativeTakeover) =>
        (await loadCodexTerminalContexts({ nativeTakeover, options })).map(
          ({ context, match, confidence }) => ({
            context, match,
            confidence: confidence as "high" | "medium" | "low"
          })
        )
    },
    identity: {
      resolveCurrent: (request) =>
        resolveCurrentNativeAgentSessionIdentity({ options, ...request }),
      assertRuntime: (input) =>
        terminalDispatchExecution(options).assertRuntimeIdentity({
          ...input, currentIdentity: input.currentIdentity as
            NativeAgentSessionIdentity | undefined
        })
    },
    workspace: { assertConfigured: assertConfiguredWorkspace }
  });
}

function createTerminalControlProvider(options,
  registry?: TerminalControlProviderRegistry): TerminalControlProvider {
  return terminalRuntime(options).createControlProvider(registry);
}

function createTerminalProcessSource(options) {
  return terminalRuntime(options).createProcessSource();
}

function loadClaudeAgentRows(options: CliCommandOptions = {},
  observation: { required?: boolean } = {}) {
  return terminalRuntime(options).loadClaudeAgentRows(observation);
}

function createRuntimeTerminalAgentRegistry(options) {
  return terminalRuntime(options).createAgentRegistry();
}

function createTerminalAgentBridge(
  options,
  terminalProvider: TerminalControlProvider = createTerminalControlProvider(options),
  registry = createRuntimeTerminalAgentRegistry(options)
): TerminalAgentBridge {
  return terminalRuntime(options).createBridge(terminalProvider, registry);
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

const terminalBridgeSubmission = dispatchReceipt.terminalBridgeSubmission;
const terminalDispatchCompletion = createTerminalDispatchCompletionCliAdapter({
  environment: {
    syntheticTerminalAcceptanceAllowed: () =>
      cliEnv().AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE === "1"
  }
});
const terminalIdentityAuthority = createTerminalIdentityAuthorityCliAdapter({
  runtime: {
    createBridge: (options) => terminalRuntime(options).createBridge(),
    createControlProvider: (options) =>
      terminalRuntime(options).createControlProvider(),
    createProcessSource: (options) =>
      terminalRuntime(options).createProcessSource(),
    createAgentRegistry: (options) =>
      terminalRuntime(options).createAgentRegistry(),
    observeNativeIdentity: (request) =>
      terminalAcceptanceCliFacade.observeNativeIdentity(request),
    probeCodexCurrentThread: (request) => probeCodexCurrentThread({
      terminal: request.terminal,
      currentIdentity: request.currentIdentity,
      runtimeOverride: request.runtimeOverride
    }, nativeThreadLifecycleFacade.verificationPorts(
      request.options,
      request.terminal
    ))
  },
  store: {
    terminalControlFromTakeover, storeDir: storeDirFromOptions,
    storeDirForConversation: (conversation) =>
      terminalAcceptanceCliFacade.storeDirForConversation(conversation),
    turnsForSession: (storeDir, sessionId) =>
      terminalAcceptanceCliFacade.turnsForSession(storeDir, sessionId),
    turnMatchesTerminal: (conversation, terminal, currentIdentity) =>
      terminalAcceptanceCliFacade.turnMatchesTerminal({
        conversation, terminal, currentIdentity
      }),
    isDiscoverableTurn: isDiscoverableTmuxConversation,
    readEvents: (logPath) => readExistingEvents(logPath),
    loadLedger: loadTerminalBridgeDispatchLedger,
    ledgerMatchesControl: terminalDispatchRecordMatchesControl,
    ledgerProcessAnchor: terminalDispatchRecordProcessAnchor,
    acquireStateLock: (statePath) => acquireFileLock(`${statePath}.lock`),
    loadTurn: loadState,
    saveTurn: saveState,
    appendEvent
  },
  authority: {
    assertTurnBindingCurrent,
    assertManagedSessionCanStartTurn: (turns) =>
      terminalAcceptanceCliFacade.assertSessionCanStartTurn(turns),
    assertNativeThreadHasExclusiveOwnership: (input) =>
      nativeThreadLifecycleFacade.assertExclusive(input),
    assertSafeTerminalSend,
    assertTerminalLifecycleReady: (input) =>
      nativeThreadLifecycleFacade.assertTerminalReady(input),
    provisionalManagedBindingTurnCount: (storeDir, session) =>
      terminalListCliFacade.provisionalManagedBindingTurnCount(storeDir, session),
    managedTurnNeedsAttention: (turn) =>
      terminalListCliFacade.managedTurnNeedsAttention(turn),
    hasUnresolvedNativeTransition: (storeDir, session) =>
      terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(
        storeDir, session),
    hasAnyNativeTransition: (storeDir, session) =>
      terminalListCliFacade.managedSessionHasAnyNativeTransition(storeDir, session)
  },
  environment: { cwd: cliCwd, now: cliNow, isProcessAlive,
    workspaceMatches: matchesConfiguredWorkspace },
  completion: {
    requiresExactBoundCodexCompletion:
      terminalDispatchCompletion.requiresExactBoundCodexCompletion
  }
});
const {
  resolveTerminalConversationFromOptions, refineTerminalTurnEndpoint,
  terminalRuntimeIdentityForConversation, terminalDurableRequestForConversation,
  migrateLegacyTerminalAgentIdentity, codexProcessIncarnationForPid,
  observeDurableCompletionBeforeDeadStall, observeBoundTerminalAgentProcess,
  codexLingeringBeforeIdentityMatchesSession, logicalIdentityForManagedSession,
  codexAllowedCompanionSetForManagedSession, codexManagedIdentityResolutionContext,
  codexPreMaterializationIdentityForManagedSession,
  assertCodexComposerReadyForAutomatedInput, verifyCodexPendingManagedSendStatus,
  terminalRuntimeForLiveIdentity, bindingMatchesLiveTerminal,
  managedBindingConflictKindForResolvedTerminal,
  soleBoundManagedSessionClaimForTerminal, createBoundManagedSession,
  materializeCurrentManagedSession, reattachManagedSessionForNativeIdentity,
  observeDeferredCodexAuthority
} = terminalIdentityAuthority;
const callbackCliFacade = createCallbackCliFacade({
  state: { acquireFileLock, loadConversation: loadConversationFromOptions,
    readEvents: (logPath) => terminalDispatchRecovery.readEvents(logPath),
    withWriter: withStoreWriterLease },
  authority: {
    assertNoDeferredTransfer: (input) =>
      terminalHandoffCliFacade.assertConversationHasNoNonterminalDeferredForegroundTransfer(input),
    assertBindingCurrent: assertTurnBindingCurrent,
    isDispatchReleased: (conversation) => TERMINAL_DISPATCH_RELEASE_STATUSES
      .has(effectiveTurnStatus(conversation)),
    isWaitingForAgent,
    isTerminalBridgeSupersedeStatus: (status) =>
      TERMINAL_BRIDGE_SUPERSEDE_STATUSES.has(status),
    resolveCompletionDispatch: ({
      terminalControl, conversation, expectedMessageId, reason
    }) => resolveTerminalBridgeDispatchLedger(terminalControl,
      { conversation, expectedMessageId, reason })
  },
  retry: { startMonitor: startCallbackRetryMonitor, isProcessAlive,
    attemptLeaseMs: CALLBACK_ATTEMPT_LEASE_MS,
    delaysMs: CALLBACK_RETRY_DELAYS_MS },
  runtime: { classifyProcessFailure, textSummary }
});
const terminalDispatchRecovery = createTerminalDispatchRecoveryCliAdapter({
  repository: terminalDispatchRepository,
  authority: {
    terminalControl: terminalControlFromTakeover,
    assertTurnBindingCurrent,
    storeDirForConversation: managedSessionStoreDirForConversation
  },
  observation: {
    process: observeBoundTerminalAgentProcess,
    completion: observeDurableCompletionBeforeDeadStall
  },
  completion: {
    prepare: ({
      options,
      statePath,
      logPath,
      conversation,
      executor,
      terminalControl,
      terminalMessageId,
      completion,
      allowSupersedeRecovery = false,
      completionFingerprint
    }) => callbackCliFacade.prepareTerminalCompletion({
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
    })
  },
  runtime: { isProcessAlive }
});
const terminalBindingLedgerFields = terminalDispatchRecovery.bindingFields;
const reconcilePreparedTerminalDispatchLedger =
  terminalDispatchRecovery.reconcilePrepared;
const isVerifiedDeadTerminalAgentProcess =
  terminalDispatchRecovery.isVerifiedDead;
const exactVerifiedDeadTerminalAgentProcessAuthority =
  terminalDispatchRecovery.exactVerifiedDeadAuthority;
const ensureVerifiedDeadTerminalAgentProcessEvent =
  terminalDispatchRecovery.ensureVerifiedDeadEvent;
const ensureVerifiedDeadConversationClosedEvent =
  terminalDispatchRecovery.ensureVerifiedDeadClosedEvent;
const assertVerifiedDeadTerminalBridgeDispatchAuthority =
  terminalDispatchRecovery.assertVerifiedDeadDispatch;
const resolveVerifiedDeadTerminalBridgeDispatchLedger =
  terminalDispatchRecovery.resolveVerifiedDeadDispatch;
const stallAcceptedTurnForVerifiedDeadAgent =
  terminalDispatchRecovery.stallAccepted;
const settleLocalTerminalBridgeCompletionClaim =
  terminalDispatchRecovery.settleLocalCompletion;
const prepareTerminalBridgeCompletionCallback =
  terminalDispatchRecovery.prepareCompletion;
const readExistingEvents = terminalDispatchRecovery.readEvents;

const terminalAcceptanceCliFacade = createTerminalAcceptanceCliFacade({
  native: {
    codexProvider: (options) =>
      terminalRuntime(options).createAgentSessionProvider("codex"),
    codexProcessIncarnation: codexProcessIncarnationForPid,
    assertExclusive: (input) =>
      nativeThreadLifecycleFacade.assertExclusive(input)
  },
  terminal: {
    runtime: (options) => terminalRuntime(options),
    durableRequest: terminalDurableRequestForConversation,
    runtimeIdentity: terminalRuntimeIdentityForConversation
  },
  authority: {
    assertTurnCurrent: assertTurnBindingCurrent,
    terminalControl: terminalControlFromTakeover,
    isDiscoverableTurn: isDiscoverableTmuxConversation,
    workspaceMatches: matchesConfiguredWorkspace,
    isSessionBlockingStatus: (status) =>
      SESSION_SEND_BLOCKING_STATUSES.has(status)
  },
  repository: {
    acquireStateLock: acquireFileLock,
    acquireTerminalLock: terminalDispatchRepository.acquire,
    loadLedger: terminalDispatchRepository.load,
    saveLedger: terminalDispatchRepository.save,
    reconcileLedger: terminalDispatchRecovery.reconcilePrepared,
    bindingFields: terminalDispatchRecovery.bindingFields
  },
  deferred: {
    isFinal: (status) => FINAL_DEFERRED_TRANSFER_STATUSES.has(status),
    recover: ({ options, terminal }) =>
      terminalHandoffCliFacade.recoverDeferredCodexForegroundTransferBeforeMutation({
        options,
        terminal: terminal as ResolvedTerminalConversation
      }),
    loadAuthority: (input) =>
      deferredRecoveryAdapter.loadDeferredForegroundTurnAuthority(
        terminalHandoffCliFacade.deferredForegroundRecoveryAdapterPorts(),
        input
      ),
    assertLedgerAuthority: (input) =>
      deferredRecoveryAdapter.assertDeferredForegroundLedgerAuthority(
        terminalHandoffCliFacade.deferredForegroundRecoveryAdapterPorts(),
        input
      ),
    loadTransfer: loadDeferredForegroundTransfer
  }
});

const terminalDispatchExecution = terminalAcceptanceCliFacade.execution;
const recoverVirginCodexPostSubmissionBinding =
  terminalAcceptanceCliFacade.recoverVirgin;
const reconcileTerminalAcceptanceInMonitor =
  terminalAcceptanceCliFacade.reconcileMonitor;
const markTerminalAcceptanceUncertain =
  terminalAcceptanceCliFacade.markUncertain;
const inspectCodexOpenRootRolloutInventory =
  terminalAcceptanceCliFacade.inspectCodexOpenRoots;
const resolveCurrentNativeAgentSessionIdentity =
  terminalAcceptanceCliFacade.resolveNativeIdentity;
const observeCurrentNativeAgentSessionIdentity =
  terminalAcceptanceCliFacade.observeNativeIdentity;
const assertNativeAgentIdentityForTurn =
  terminalAcceptanceCliFacade.assertTurnIdentity;
function managedSessionStoreDirForConversation(
  conversation: Conversation
): string | undefined {
  return terminalAcceptanceCliFacade.storeDirForConversation(conversation);
}
const refineManagedSessionNativeIdentity =
  terminalAcceptanceCliFacade.refineSessionIdentity;
const persistManagedSessionNativeIdentity =
  terminalAcceptanceCliFacade.persistSessionIdentity;
const quarantineManagedSessionBinding =
  terminalAcceptanceCliFacade.quarantineSession;
const managedTurnsForSession = terminalAcceptanceCliFacade.turnsForSession;
const assertManagedSessionCanStartTurn =
  terminalAcceptanceCliFacade.assertSessionCanStartTurn;
const createManagedTerminalTurn = terminalAcceptanceCliFacade.createManagedTurn;

const nativeThreadLifecycleQueryFacade = createNativeThreadLifecycleCliAdapter({
  runtime: {
    forOptions: (options) => terminalRuntime(options),
    sleep: cliSleep
  },
  identity: {
    resolveCurrent: (input) =>
      terminalAcceptanceCliFacade.resolveNativeIdentity(input),
    managedContext: (input) =>
      terminalIdentityAuthority.codexManagedIdentityResolutionContext(input),
    boundSession: (input) =>
      terminalIdentityAuthority.boundManagedSessionForTerminal(input),
    materializeSession: (input) =>
      terminalIdentityAuthority.materializeCurrentManagedSession(input),
    refineSession: (input) =>
      terminalAcceptanceCliFacade.refineSessionIdentity(input),
    logicalIdentity: (input) =>
      terminalIdentityAuthority.logicalIdentityForManagedSession(input),
    companionSet: (input) =>
      terminalIdentityAuthority.codexAllowedCompanionSetForManagedSession(input),
    processIncarnation: (pid) =>
      terminalIdentityAuthority.codexProcessIncarnationForPid(pid),
    runtimeForLiveIdentity: (input) =>
      terminalIdentityAuthority.terminalRuntimeForLiveIdentity(input),
    ownerIsInactive: (input) =>
      terminalIdentityAuthority.managedSessionOwnerIsConclusivelyInactive(input),
    assertCodexComposerReady: (input) =>
      terminalIdentityAuthority.assertCodexComposerReadyForAutomatedInput(input)
  },
  state: {
    storeDir: storeDirFromOptions,
    inspectStore: inspectStoreCompatibility,
    runtimeDir: terminalDispatchRepository.runtimeDir,
    acquireTerminal: terminalDispatchRepository.acquire,
    loadLedger: terminalDispatchRepository.load,
    managedTurns: (storeDir, sessionId) =>
      terminalAcceptanceCliFacade.turnsForSession(storeDir, sessionId),
    terminalBlockingTurns: (storeDir, terminalControl) =>
      terminalListCliFacade.terminalIncarnationBlockingTurns(
        storeDir, terminalControl
      ),
    hasUnresolvedTransition: (storeDir, session) =>
      terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(
        storeDir, session
      ),
    dispatchOwnership: (terminalControl) =>
      terminalListCliFacade.terminalDispatchOwnership(terminalControl),
    assertNativeThreadStoreAuthority: (input) =>
      terminalDispatchRecovery.assertNativeThreadStoreAuthority(input),
    orphanedForRecovery: (terminalControl) =>
      terminalDispatchRecovery.orphanedForRecovery(terminalControl)
  },
  terminalList: {
    isBlockingStatus: (status) => SESSION_SEND_BLOCKING_STATUSES.has(status)
  },
  output: { cwd: cliCwd, print: printJson }
});

const nativeThreadTransitionApplication =
  createNativeThreadTransitionApplication({
    runtime: {
      now: cliNow,
      nowMs: cliNowMs,
      pid: cliPid,
      cwd: cliCwd,
      sleep: cliSleep,
      env: (name) => cliEnv()[name],
      exit: cliExit,
      log: runtimeLog,
      print: printJson,
      summarizeError: textSummary
    },
    lifecycle: {
      facade: nativeThreadLifecycleQueryFacade,
      runtime: (options) => terminalRuntime(options),
      resolveIdentity: (input) =>
        terminalAcceptanceCliFacade.resolveNativeIdentity(input),
      runtimeForIdentity: (input) =>
        terminalIdentityAuthority.terminalRuntimeForLiveIdentity(input),
      exactIdentity: (terminal, identity) =>
        terminalIdentityAuthority.exactLifecycleProcessIdentity(
          terminal,
          identity
        ),
      assertComposerReady: (input) =>
        terminalIdentityAuthority.assertCodexComposerReadyForAutomatedInput(
          input
        )
    },
    state: {
      storeDir: storeDirFromOptions,
      runtimeDir: terminalDispatchRepository.runtimeDir,
      loadLedger: terminalDispatchRepository.load,
      reconcilePrepared: terminalDispatchRecovery.reconcilePrepared,
      reconcileIncarnation: terminalDispatchRepository.reconcileIncarnation,
      recordMatchesControl: terminalDispatchRepository.matchesControl,
      lifecycleLedger: nativeThreadLifecycleLedger,
      ordinaryOwnerStatus: (ledger) =>
        loadTerminalDispatchLedgerOwner(ledger)?.status,
      blockingTurns: (storeDir, terminalControl) =>
        terminalListCliFacade.terminalIncarnationBlockingTurns(
          storeDir,
          terminalControl
        ),
      managedTurns: (storeDir, sessionId) =>
        terminalAcceptanceCliFacade.turnsForSession(storeDir, sessionId),
      hasUnresolvedTransition: (storeDir, session) =>
        terminalListCliFacade.managedSessionHasUnresolvedNativeTransition(
          storeDir,
          session
        ),
      dispatchOwnership: (terminalControl) =>
        terminalListCliFacade.terminalDispatchOwnership(terminalControl)
    },
    authority: {
      sessionClaimsTerminal: (session, terminal) =>
        terminalIdentityAuthority.managedSessionClaimsResolvedTerminal(
          session,
          terminal
        ),
      conflictKind: (input) =>
        terminalIdentityAuthority
          .managedBindingConflictKindForResolvedTerminal(input),
      ownerIsInactive: (input) =>
        terminalIdentityAuthority
          .managedSessionOwnerIsConclusivelyInactive(input),
      observeExternal: (input) =>
        terminalHandoffCliFacade.observedExternalHandoffIdentity(input),
      recoverDeferred: (input) => terminalHandoffCliFacade
        .recoverDeferredCodexForegroundTransferWhileWriterLease(input),
      knownRoots: (input) =>
        terminalIdentityAuthority.codexKnownRootSetForLifecycleTransition(
          input
        ),
      codexProcessBirth: (pid) =>
        terminalIdentityAuthority.codexProcessBirthForLifecycle(pid),
      processAlive: isProcessAlive,
      workspaceMatches: matchesConfiguredWorkspace
    },
    mutation: {
      locks: terminalWriterMutationLocks,
      authenticate: authenticateLifecycleRecoveryResources,
      loadSession: mutationManagedSessions.load,
      saveSession: mutationManagedSessions.save
    }
  });

const nativeThreadLifecycleFacade = Object.freeze({
  ...nativeThreadLifecycleQueryFacade,
  ...nativeThreadTransitionApplication
});

const runListResumableThreads = nativeThreadLifecycleFacade.runList;
const runNativeInspect = nativeThreadLifecycleFacade.runInspect;
const codexLatentClearResumeObservation =
  nativeThreadLifecycleFacade.codexLatentClearResumeObservation;
const nativeInspectionComposerEmpty =
  nativeThreadLifecycleFacade.nativeInspectionComposerEmpty;

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
    inspectCodexOpenRootRolloutInventory: (input) =>
      terminalAcceptanceCliFacade.inspectCodexOpenRoots(input),
    nativeInspectionComposerEmpty,
    observeCurrentNativeAgentSessionIdentity: (input) =>
      terminalAcceptanceCliFacade.observeNativeIdentity(input),
    terminalStatusForControl
  },
  store: {
    callbackRetryDisposition: (delivery) =>
      callbackCliFacade.retryDisposition(delivery),
    codexLingeringBeforeIdentityMatchesSession,
    isActiveStatus,
    isDiscoverableTmuxConversation,
    isVerifiedDeadTerminalAgentProcess,
    loadTerminalBridgeDispatchLedger,
    loadTerminalDispatchLedgerOwner,
    managedSessionStoreDirForConversation: (conversation) =>
      terminalAcceptanceCliFacade.storeDirForConversation(conversation),
    managedTurnsForSession: (storeDir, sessionId) =>
      terminalAcceptanceCliFacade.turnsForSession(storeDir, sessionId),
    matchesConfiguredWorkspace,
    orphanedTerminalDispatchForRecovery:
      terminalDispatchRecovery.orphanedForRecovery,
    storeDirFromOptions,
    summarizeConversation,
    terminalBridgeEnabled,
    terminalBridgeSubmission,
    terminalControlFromTakeover,
    terminalDispatchRecordMatchesControl
  },
  authority: {
    activeTurnHandoffDecisionToken: (input) =>
      terminalHandoffCliFacade.activeTurnHandoffDecisionToken(input),
    assertManagedTerminalDispatchOwner,
    observeDeferredCodexAuthority,
    observedHandoffTargetResolution: (input) =>
      terminalHandoffCliFacade.observedHandoffTargetResolution(input)
  },
  policy: {
    activeTerminalDispatchStatuses: ACTIVE_TERMINAL_DISPATCH_STATUSES,
    approvalTtlMs: CLAUDE_SCREEN_APPROVAL_TTL_MS,
    finalDeferredTransferStatuses: FINAL_DEFERRED_TRANSFER_STATUSES,
    selectorCommands: SESSION_SELECTOR_COMMANDS,
    sessionSendBlockingStatuses: SESSION_SEND_BLOCKING_STATUSES,
    terminalDispatchReleaseStatuses: TERMINAL_DISPATCH_RELEASE_STATUSES,
    rememberOriginalExpectedTerminalSelector: (options, selector) => {
      terminalHandoffCliFacade.rememberOriginalExpectedTerminalSelector(
        options,
        selector
      );
    }
  }
});

const terminalHandoffCliFacade = createTerminalHandoffCliFacade({
  runtime: {
    storeDir: storeDirFromOptions,
    createBridge: createTerminalAgentBridge,
    agentVersion: agentVersionForRunningProcess,
    required,
    isStoreMutationLockTimeout
  },
  identity: terminalIdentityAuthority,
  acceptance: {
    inspectCodexOpenRoots: terminalAcceptanceCliFacade.inspectCodexOpenRoots,
    observeNativeIdentity: terminalAcceptanceCliFacade.observeNativeIdentity,
    resolveNativeIdentity: terminalAcceptanceCliFacade.resolveNativeIdentity,
    assertTurnIdentity: terminalAcceptanceCliFacade.assertTurnIdentity
  },
  authority: {
    assertTerminalCanStartTurn:
      terminalListCliFacade.assertTerminalIncarnationCanStartTurn,
    hasUnresolvedTransition:
      terminalListCliFacade.managedSessionHasUnresolvedNativeTransition,
    assertSessionCanStartTurn:
      terminalAcceptanceCliFacade.assertSessionCanStartTurn,
    turnsForSession: terminalAcceptanceCliFacade.turnsForSession,
    assertTerminalReady: nativeThreadLifecycleFacade.assertTerminalReady,
    assertSafeSend: assertSafeTerminalSend,
    assertExclusive: (input) =>
      nativeThreadLifecycleFacade.assertExclusive(input)
  },
  repository: {
    storeDirForConversation: terminalAcceptanceCliFacade.storeDirForConversation,
    loadLedger: loadTerminalBridgeDispatchLedger,
    saveLedger: saveTerminalBridgeDispatchLedger,
    ledgerMatchesControl: terminalDispatchRecordMatchesControl,
    bindingFields: terminalBindingLedgerFields,
    withNativeIdentity: terminalAcceptanceCliFacade.withNativeIdentity,
    withSubmission: withTerminalBridgeSubmission,
    saveLifecycleLedger: nativeThreadLifecycleLedger.save,
    mutationLocks: terminalWriterMutationLocks,
    withStateScope: withTerminalDispatchStateScope
  }
});
const {
  activeTurnHandoffDecisionToken,
  assertConversationHasNoNonterminalDeferredForegroundTransfer,
  assertDeferredCodexForegroundBindingBoundary,
  assertExpectedHandoffTokenUsesExactTerminalSelector,
  assertObservedHandoffTransportBoundary,
  assertSafeAbortedTerminalRetryBinding,
  assertTerminalHasNoNonterminalDeferredForegroundTransfer,
  assertVerifiedEmptyCodexTransportBoundary,
  deferredForegroundApplication,
  deferredForegroundRecoveryAdapterPorts,
  exactSafeAbortedRecoveredSessionMatches,
  maybeAdoptObservedExternalThread,
  maybeDetachVerifiedEmptyCodexSource,
  observedExternalHandoffIdentity,
  observedHandoffAuthorityToken,
  observedHandoffTargetResolution,
  prepareDeferredCodexForegroundBinding,
  recoverDeferredCodexForegroundTransferBeforeMutation
} = terminalHandoffCliFacade;

const terminalMonitorStateCliFacade = createTerminalMonitorStateCliAdapter({
  dispatch: {
    repository: terminalDispatchRepository,
    recovery: terminalDispatchRecovery
  },
  acceptance: terminalAcceptanceCliFacade,
  authority: {
    identity: terminalIdentityAuthority,
    handoff: terminalHandoffCliFacade,
    assertBindingCurrent: assertTurnBindingCurrent,
    terminalControlForConversation: (conversation) =>
      terminalListCliFacade.terminalControlForManagedConversation(conversation),
    createBridge: createTerminalAgentBridge
  },
  callbacks: callbackCliFacade,
  runtime: {
    isProcessAlive,
    storeDir: storeDirFromOptions,
    print: printJson,
    bindingSuperseded: (error) => error instanceof TurnBindingSupersededError
      ? { code: error.code, message: error.message }
      : undefined,
    approvalTtlMs: CLAUDE_SCREEN_APPROVAL_TTL_MS,
    callbackRetryLimit: CALLBACK_RETRY_DELAYS_MS.length
  }
});

const terminalMaintenanceCliFacade = createTerminalMaintenanceCliFacade({
  runtime: {
    defaultAgentTimeoutMinutes: DEFAULT_AGENT_TIMEOUT_MINUTES,
    defaultAgentHardTimeoutMinutes: DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
    loadConversation: loadConversationFromOptions,
    storeDir: storeDirFromOptions,
    createControlProvider: createTerminalControlProvider,
    createBridge: createTerminalAgentBridge,
    startMonitor: startTerminalBridgeMonitorForConversation,
    positiveMinutes,
    textSummary
  },
  identity: {
    resolveTerminalConversationFromOptions,
    migrateLegacyTerminalAgentIdentity,
    terminalRuntimeIdentityForConversation,
    codexAllowedCompanionSetForManagedSession,
    managedBindingConflictKindForResolvedTerminal,
    observeBoundTerminalAgentProcess,
    resolveNativeIdentity: terminalAcceptanceCliFacade.resolveNativeIdentity,
    observeNativeIdentity: terminalAcceptanceCliFacade.observeNativeIdentity
  },
  authority: {
    assertConversationHasNoNonterminalDeferredForegroundTransfer,
    assertTerminalHasNoNonterminalDeferredForegroundTransfer,
    observedExternalHandoffIdentity,
    observedHandoffAuthorityToken,
    observedHandoffTargetResolution,
    activeTurnHandoffDecisionToken,
    hasUnresolvedNativeTransition:
      terminalListCliFacade.managedSessionHasUnresolvedNativeTransition,
    assertExclusive: nativeThreadLifecycleFacade.assertExclusive,
    assertTurnBindingCurrent,
    assertManagedTerminalDispatchOwner,
    loadTerminalDispatchLedgerOwner,
    isSessionSendBlocking: (status) =>
      SESSION_SEND_BLOCKING_STATUSES.has(status),
    isRecoverableDispatchStatus: (status) =>
      RECOVERABLE_TERMINAL_DISPATCH_STATUSES.has(status),
    isFinalDeferredTransferStatus: (status) =>
      FINAL_DEFERRED_TRANSFER_STATUSES.has(status)
  },
  repository: {
    acquireFileLock,
    acquireTerminalLock: acquireTerminalBridgeSendLock,
    withStoreWriterLease: withStoreWriterLeaseAsync,
    resolveDispatch: resolveTerminalBridgeDispatchLedger,
    conversationLoad: mutationConversationStore.load,
    conversationSave: mutationConversationStore.save,
    conversationAppendEvent: mutationConversationStore.appendEvent,
    sessionLoad: mutationManagedSessions.load,
    ledgerLoad: mutationDispatchLedger.load,
    ledgerSave: mutationDispatchLedger.save,
    ledgerResolve: mutationDispatchLedger.resolve,
    ledgerReconcileIncarnation: mutationDispatchLedger.reconcileIncarnation,
    ledgerReconcile: mutationDispatchLedger.reconcile,
    terminalWriterLocks: terminalWriterMutationLocks,
    terminalWriterStateLocks: terminalWriterStateMutationLocks,
    isVerifiedDead: isVerifiedDeadTerminalAgentProcess,
    exactVerifiedDeadAuthority:
      exactVerifiedDeadTerminalAgentProcessAuthority,
    ensureVerifiedDeadEvent: ensureVerifiedDeadTerminalAgentProcessEvent,
    ensureVerifiedDeadClosedEvent:
      ensureVerifiedDeadConversationClosedEvent,
    assertVerifiedDeadDispatch:
      assertVerifiedDeadTerminalBridgeDispatchAuthority,
    resolveVerifiedDeadDispatch:
      resolveVerifiedDeadTerminalBridgeDispatchLedger
  }
});

function agentVersionForRunningProcess(
  agent: ExecutorKind,
  pid: number,
  options: Record<string, any>
): string | undefined {
  return terminalRuntime(options).agentVersionForRunningProcess(agent, pid);
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
  const collateralStalls = await terminalMonitorStateCliFacade
    .reconcileCollateral(storeDir, conversationId);
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
    const { statePath, logPath } = terminalMonitorStateCliFacade.statePaths(
      listedConversation,
      storeDir
    );

    try {
      const state = await terminalMonitorStateCliFacade.reconcileState({
        options,
        storeDir,
        listed: listedConversation,
        paths: { statePath, logPath },
        includeCallbackRecovery
      });
      if (state.kind === "ignored") {
        ignored += 1;
        continue;
      }
      if (state.kind === "handled") {
        if (state.counter === "launched") launched += 1;
        else if (state.counter === "alreadyRunning") alreadyRunning += 1;
        else skipped += 1;
        items.push({ ...state.item });
        continue;
      }
      const initialConversation = state.conversation;
      const initialEligibility = state.eligibility;

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

function latestTerminalBridgeMonitorLaunchPid(logPath: string): number | undefined {
  try {
    return monitorOwner.latestLaunchPid(readExistingEvents(logPath));
  } catch {
    return undefined;
  }
}

function prepareTerminalBridgeMonitorReconciliation(input: {
  statePath: string;
  expectedMessageId: string;
  requireWaitingForAgentStatus?: boolean;
}) {
  return terminalMonitorStateCliFacade.prepareLaunch({
    ...input,
    activeOwner: activeTerminalBridgeMonitorOwner,
    monitorLockVersion: monitorOwner.LOCK_VERSION
  });
}
function positiveMinutes(value, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return parsed;
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
  return callbackCliFacade.runRetryMonitor({
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

      const eligibility = terminalMonitorStateCliFacade.eligibility(conversation);
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
      ports: terminalMonitorStateCliFacade.deferralPorts({ statePath, logPath })
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
  await terminalMonitorStateCliFacade.runService({
    options,
    statePath,
    logPath,
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
      return { pollIntervalMs, timeoutMinutes, hardTimeoutMinutes };
    },
    terminalBridge: bridge
  });
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







const terminalBridgeRequestFingerprint =
  dispatchReceipt.terminalBridgeRequestFingerprint;

async function loadCodexTerminalContexts({ nativeTakeover, options }) {
  const provider = terminalRuntime(options).createAgentSessionProvider("codex");
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

function isStoreMutationLockTimeout(error: unknown): boolean {
  return error instanceof StoreLockTimeoutError ||
    (isRecord(error) && error.code === "LOCK_TIMEOUT");
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
    ? callbackCliFacade.retryDisposition(callbackDelivery)
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
  const provider = terminalRuntime(options).createAgentSessionProvider("codex");
  const activeSessions = await terminalRuntime(options)
    .listActiveSessionsWithTerminalControl(provider);
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
  const provider = terminalRuntime(options).createAgentSessionProvider("codex");
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
    assertNativeThreadHasExclusiveOwnership: (input) =>
      nativeThreadLifecycleFacade.assertExclusive(input),
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
    stallOtherTerminalBridgeConversationsForUncertainDispatch: (input) =>
      terminalMonitorStateCliFacade.stallOther(input),
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

const terminalDelegateCliFacade = createTerminalDelegateCliFacade({
  runtime: {
    canonicalWorkspace,
    required,
    storeDir: storeDirFromOptions
  },
  repository: {
    listConversations,
    readEvents: readNdjsonLog,
    storeDirForConversation: managedSessionStoreDirForConversation
  },
  authority: { assertSafeAbortedTerminalRetryBinding },
  terminalList: {
    buildTerminalListGroup: terminalListCliFacade.buildTerminalListGroup,
    terminalDispatchOwnership: terminalListCliFacade.terminalDispatchOwnership
  },
  terminalCommand: { runSend: terminalCommandCliFacade.runSend }
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
