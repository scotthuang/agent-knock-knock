import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateCodexRolloutAcceptanceAnchor } from
  "./terminal-submission-acceptance.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import { loadDeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import {
  createFileLockCliAdapter,
  type FileLockAcquisitionOptions
} from "./file-lock-cli-adapter.js";
import {
  budgetAction,
  createMessage,
  isActiveConversationStatus,
  isTerminalDispatchOwnerReleasedStatus,
  type Conversation,
} from "./protocol.js";
import {
  EXECUTOR_KINDS,
  isExecutorKind,
  type ExecutorKind
} from "./executors.js";
import { formatTranscript, readNdjsonLog } from "./transcript.js";
import {
  appendEvent,
  assertStoreWriterCompatible,
  defaultStoreDir,
  inspectStoreCompatibility,
  listConversations,
  logPathForStatePath,
  loadConversationById,
  loadState,
  pathsForConversationDir,
  saveState,
  StoreLockTimeoutError,
  statePathForConversationId,
  withStoreWriterLease,
  withStoreWriterLeaseAsync
} from "./store.js";
import {
  probeCodexCurrentThread
} from "./native-thread-transition-verification-adapter.js";
import {
  loadManagedSession,
  saveManagedSession
} from "./session-store.js";
import {
  TerminalControlUnavailableError,
  type TerminalControlProvider,
  type TerminalControlProviderRegistry
} from "./terminal-control-provider.js";
import {
  type TerminalControlRef,
  type TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  terminalControlEvidenceMatches
} from "./terminal-control-ref.js";
import {
  TerminalAgentBridge,
  type ResolvedTerminalConversation,
  type TerminalBridgeStatus
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
  createTerminalListCliFacade,
  type TerminalListCliOptions
} from "./terminal-list-cli-adapter.js";
import {
  createTerminalStatusCliFacade
} from "./terminal-status-cli-adapter.js";
import { exactTerminalWatchAction } from "./terminal-list-renderer.js";
import {
  createTerminalWatchCliAdapter
} from "./terminal-watch-cli-adapter.js";
import {
  isDiscoverableTmuxConversation
} from "./terminal-status-facts.js";
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
import { createTerminalDelegateSendBindingRepository } from
  "./terminal-delegate-send-binding.js";
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
  createTerminalTurnBindingAuthorityCliAdapter
} from "./terminal-turn-binding-authority-cli-adapter.js";
import {
  type TerminalNativeIdentity as NativeAgentSessionIdentity
} from "./terminal-binding-authority.js";
import { assertSafeTerminalSend } from "./terminal-authority-policy.js";
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
import { terminalSubmissionPayload } from
  "./terminal-dispatch-execution.js";
import { createCallbackCliFacade } from "./callback-cli-adapter.js";
import { createOpenClawManagedCallbackCliAdapter } from
  "./openclaw-managed-callback-cli-adapter.js";
import { createTerminalMaintenanceCliFacade } from
  "./terminal-maintenance-cli-adapter.js";
import {
  terminalMonitorActivityPersistIntervalMs as terminalBridgeActivityPersistIntervalMs,
  terminalMonitorApprovalCandidate as terminalBridgeApprovalCandidate,
  terminalMonitorDeadlineAt as deadlineAt,
  validTerminalMonitorTimestampMs as validTimestampMs
} from "./terminal-monitor-decision-policy.js";
import {
  createTerminalMonitorStateCliAdapter
} from "./terminal-monitor-state-cli-adapter.js";
import {
  createTerminalMonitorSupervisionCliAdapter
} from "./terminal-monitor-supervision-cli-adapter.js";
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
import * as dispatchReceipt from "./terminal-dispatch-receipt.js";
import { openClawYieldNextAction } from
  "./terminal-dispatch-presenter.js";
import {
  isProcessAlive,
  terminalProcessIncarnationForPid
} from "./terminal-process-source.js";
import {
  assertConfiguredWorkspace,
  canonicalWorkspace,
  expandHome,
  matchesConfiguredWorkspace,
  packageRootDir,
  parseJsonOption,
  positiveMinutes,
  redactCliOutput,
  required,
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
const terminalDispatchRepository =
  createTerminalDispatchRepositoryCliAdapter();
const terminalDelegateSendBindingRepository =
  createTerminalDelegateSendBindingRepository({
    runtimeDir: terminalDispatchRepository.runtimeDir,
    acquireLock: (lockPath) => acquireFileLock(lockPath, { timeoutMs: 30_000 })
  });
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

const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_AGENT_HARD_TIMEOUT_MINUTES = 720;
const CLAUDE_SCREEN_APPROVAL_TTL_MS = 10 * 60 * 1000;
const CALLBACK_ATTEMPT_LEASE_MS = 2 * 60 * 1000;
const CALLBACK_RETRY_DELAYS_MS = [5000, 15000, 60000, 60000];
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
function terminalWriterMutationLocks(
  storeDir: string,
  terminalControl: TerminalControlRef,
  options: { timeoutMs?: number; retryMs?: number } = {}
) {
  const canonicalStoreDir = path.resolve(storeDir);
  return {
    resources: {
      terminal: canonicalMutationResource(terminalBridgeRuntimeKey(terminalControl), terminalControl),
      storeWriter: canonicalMutationResource(canonicalStoreDir, canonicalStoreDir)
    },
    acquireTerminal: () => acquireTerminalBridgeSendLock(
      canonicalStoreDir,
      terminalControl,
      { timeoutMs: options.timeoutMs ?? 30_000, retryMs: options.retryMs }
    ),
    withStoreWriter: <Result>(operation: () => Promise<Result>) =>
      withStoreWriterLeaseAsync(canonicalStoreDir, operation, {
        timeoutMs: options.timeoutMs
      })
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
  ) => Promise<Result>,
  options: FileLockAcquisitionOptions = {}
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
        terminalDispatchStateLockPath(stateResource),
        options
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
const nativeThreadLifecycleLedger =
  createNativeThreadLifecycleLedgerCliAdapter({
    repository: terminalDispatchRepository,
    authority: {
      ordinaryOwnerIsReleased: (ledger) => {
        const owner = loadTerminalDispatchLedgerOwner(ledger);
        return Boolean(
          owner && isTerminalDispatchOwnerReleasedStatus(owner.status)
        );
      }
    }
  });
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
  "reconcile-watches",
  "watch-terminal",
  "unwatch-terminal",
  "close",
  "callback",
  "retry-callback",
  "monitor",
  "new-thread",
  "clear-thread",
  "resume-thread",
  "reconcile-binding"
]);

export type CliCommandOptions = Record<string, unknown>;
export type CliCommandDependencies = RuntimeCliCommandDependencies<CliCommandOptions>;

export interface ParsedCliCommand {
  command?: string;
  options: CliCommandOptions;
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
  if (
    ((commandName === "send" && !stringValue(options.turn)) ||
      commandName === "respond") &&
    typeof (options.message ?? options.request) === "string"
  ) {
    // This pure syntax fence must run before selector discovery. Native
    // lifecycle commands never need terminal, process, or Store observation.
    // runSend retains the same check at the execution boundary.
    terminalSubmissionPayload(options.message ?? options.request);
  }
  if (!(commandName === "send" && options.turn)) {
    await terminalListCliFacade.resolveConversationSelectorOption(commandName, options);
  }
  preflightStoreWriter(commandName, options);
  if (commandName === "help" || commandName === "--help" || commandName === "-h") {
    usage();
  } else if (commandName === "version" || commandName === "--version" || commandName === "-v") {
    printVersion();
  } else if (commandName === "delegate") {
    await terminalDelegateCliFacade.runDelegate(options);
  } else if (commandName === "list") {
    await terminalListCliFacade.runList(options);
  } else if (commandName === "watch-terminal") {
    await terminalWatchCliFacade.runWatch(options);
  } else if (commandName === "watch-status") {
    terminalWatchCliFacade.runWatchStatus(options);
  } else if (commandName === "unwatch-terminal") {
    await terminalWatchCliFacade.runUnwatch(options);
  } else if (commandName === "status") {
    await terminalStatusCliFacade.runStatus(options);
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
    await terminalMonitorSupervisionCliFacade.runReconcileMonitors(options);
  } else if (commandName === "reconcile-watches") {
    await terminalWatchCliFacade.runReconcileWatches(options);
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
    await terminalMonitorSupervisionCliFacade.runMonitor(options);
  } else {
    usage();
    setCliExitCode(commandName ? 1 : 0);
  }
}

function preflightStoreWriter(commandName, options): void {
  if (!STORE_MUTATION_COMMANDS.has(String(commandName ?? ""))) {
    return;
  }
  const terminalSendSelector = stringValue(
    options.session ?? options.conversation ?? options.conversationId
  );
  if (
    commandName === "delegate" ||
    (commandName === "send" &&
    terminalSendSelector?.startsWith("terminal:v") &&
    stringValue(options.expectedTerminalToken))
  ) {
    // User-priority Send owns a Store-independent physical fallback; its managed
    // path checks Store state, but damaged Store state cannot veto terminal input.
    return;
  }
  const statePath = stringValue(options.state);
  const storeDir = statePath
    ? pathsForConversationDir(path.dirname(expandHome(statePath))).storeDir
    : storeDirFromOptions(options);
  assertStoreWriterCompatible(storeDir);
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
        (await terminalStatusCliFacade.loadCodexCompletionContexts({
          nativeTakeover,
          options
        })).map(
          ({ context, match, confidence }) => ({
            context,
            match,
            confidence
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

const terminalBridgeEnabled = dispatchReceipt.terminalBridgeEnabled;
const textSummary = dispatchReceipt.terminalDispatchTextSummary;

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
const terminalTurnBindingAuthority =
  createTerminalTurnBindingAuthorityCliAdapter({
    storeDirForConversation: (conversation) =>
      terminalAcceptanceCliFacade.storeDirForConversation(conversation)
  });
const assertTurnBindingCurrent = terminalTurnBindingAuthority.assertCurrent;
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
    storeDirForStatePath: (statePath) => pathsForConversationDir(
      path.dirname(statePath)
    ).storeDir,
    storeDirForConversation: (conversation) =>
      terminalAcceptanceCliFacade.storeDirForConversation(conversation),
    withWriter: withStoreWriterLease,
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

const managedOpenClawCallbackDelivery =
  createOpenClawManagedCallbackCliAdapter({
    now: cliNow,
    environment: cliEnv,
    redactConversation: redactCliOutput,
    textSummary,
    log: runtimeLog
  });

const callbackCliFacade = createCallbackCliFacade({
  state: { acquireFileLock, loadConversation: loadConversationFromOptions,
    readEvents: (logPath) => terminalDispatchRecovery.readEvents(logPath),
    withWriter: withStoreWriterLease },
  authority: {
    assertNoDeferredTransfer: (input) =>
      terminalHandoffCliFacade.assertConversationHasNoNonterminalDeferredForegroundTransfer(input),
    assertBindingCurrent: assertTurnBindingCurrent,
    resolveCompletionDispatch: ({
      terminalControl, conversation, expectedMessageId, reason
    }) => resolveTerminalBridgeDispatchLedger(terminalControl,
      { conversation, expectedMessageId, reason })
  },
  retry: { startMonitor: (input) =>
    terminalMonitorSupervisionCliFacade.startCallbackRetryMonitor(input),
    isProcessAlive,
    attemptLeaseMs: CALLBACK_ATTEMPT_LEASE_MS,
    delaysMs: CALLBACK_RETRY_DELAYS_MS },
  delivery: managedOpenClawCallbackDelivery,
  runtime: { textSummary }
});
const terminalDispatchRecovery = createTerminalDispatchRecoveryCliAdapter({
  repository: terminalDispatchRepository,
  authority: {
    terminalControl: terminalControlFromTakeover,
    assertNoDeferredTransfer: (input) =>
      terminalHandoffCliFacade
        .assertConversationHasNoNonterminalDeferredForegroundTransfer(input),
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
const loadTerminalDispatchLedgerOwner = terminalDispatchRecovery.loadOwner;
const assertManagedTerminalDispatchOwner =
  terminalDispatchRecovery.assertManagedOwner;
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
    workspaceMatches: matchesConfiguredWorkspace
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

const terminalStatusCliFacade = createTerminalStatusCliFacade({
  selection: {
    statusStoreSelection,
    resolveTerminalConversation: resolveTerminalConversationFromOptions,
    assertExpectedTerminalSelector: ({ options, terminal }) =>
      terminalHandoffCliFacade.assertExpectedHandoffTokenUsesExactTerminalSelector({
        options,
        terminal
      }),
    loadConversation: loadConversationFromOptions,
    terminalControlFromTakeover,
    terminalRuntimeIdentity: terminalRuntimeIdentityForConversation
  },
  observation: {
    readEvents: readExistingEvents,
    createCodexProvider: (options) =>
      terminalRuntime(options).createAgentSessionProvider("codex"),
    listActiveCodexSessions: (options, provider) =>
      terminalRuntime(options).listActiveSessionsWithTerminalControl(provider),
    createTerminalBridge: createTerminalAgentBridge,
    terminalAdapter: (options, agent) =>
      createRuntimeTerminalAgentRegistry(options).require(agent)
  },
  reconciliation: {
    reconcileMonitors: (options, request) =>
      terminalMonitorSupervisionCliFacade.reconcileMonitors(options, request),
    workspaceMatches: matchesConfiguredWorkspace,
    withStoreWriter: withStoreWriterLease,
    acquireStateLock: (statePath) => acquireFileLock(`${statePath}.lock`),
    terminalBridgeEnabled
  },
  watchAuthority: {
    terminalListObservation: async (options, terminalId) => {
      const observation = await terminalListCliFacade.observeExactTerminal({
        options: options as TerminalListCliOptions,
        terminalId
      });
      if (observation.state === "unavailable") {
        return {
          activityState: "unknown",
          activityReason:
            observation.reason ?? "authoritative terminal observation is unavailable",
          watchActionAvailable: false
        };
      }
      if (observation.state !== "available") {
        return {
          activityState: "unknown",
          activityReason:
            "the exact terminal is no longer available for authoritative observation",
          watchActionAvailable: false
        };
      }
      const terminal = observation.terminal;
      const rawTerminal = observation.rawTerminal;
      const activityState = terminal.activity_state;
      const activityReason = stringValue(terminal.activity_reason);
      if (
        (
          activityState !== "awaiting_approval" &&
          activityState !== "working" &&
          activityState !== "idle" &&
          activityState !== "unknown"
        ) ||
        !activityReason
      ) {
        return {
          activityState: "unknown",
          activityReason:
            "authoritative terminal activity evidence is incomplete",
          watchActionAvailable: false
        };
      }
      return {
        activityState,
        activityReason,
        watchActionAvailable: Boolean(
          exactTerminalWatchAction(terminal, terminalId)
        ),
        ...(isRecord(rawTerminal._terminal_status_snapshot)
          ? {
              terminalStatus:
                rawTerminal._terminal_status_snapshot as unknown as
                  TerminalBridgeStatus
            }
          : {})
      };
    }
  },
  projection: {
    callbackRetryDisposition: (delivery) =>
      callbackCliFacade.retryDisposition(delivery),
    textSummary
  }
});

const terminalListCliFacade = createTerminalListCliFacade({
  reconciliation: {
    reconcileIdleConversations:
      terminalStatusCliFacade.reconcileIdleConversations,
    reconcileMonitors: (options, request) =>
      terminalMonitorSupervisionCliFacade.reconcileMonitors(options, request)
  },
  discovery: {
    agentVersionForRunningProcess,
    codexLatentClearResumeObservation,
    codexManagedIdentityResolutionContext,
    codexProcessIncarnationForPid,
    processIncarnationForPid: (pid) =>
      terminalProcessIncarnationForPid(
        pid,
        cliDependencies().processBirthForPid ??
          cliDependencies().codexProcessBirthForPid
      ),
    createRuntimeTerminalAgentRegistry,
    createTerminalAgentBridge,
    createTerminalControlProvider,
    createTerminalProcessSource,
    inspectCodexOpenRootRolloutInventory: (input) =>
      terminalAcceptanceCliFacade.inspectCodexOpenRoots(input),
    nativeInspectionComposerEmpty,
    observeCurrentNativeAgentSessionIdentity: (input) =>
      terminalAcceptanceCliFacade.observeNativeIdentity(input),
    terminalStatusForControl:
      terminalStatusCliFacade.terminalStatusForControl
  },
  store: {
    callbackRetryDisposition: (delivery) =>
      callbackCliFacade.retryDisposition(delivery),
    codexLingeringBeforeIdentityMatchesSession,
    isActiveStatus: isActiveConversationStatus,
    isDiscoverableTmuxConversation,
    isVerifiedDeadTerminalAgentProcess,
    loadTerminalBridgeDispatchLedger,
    loadTerminalDispatchLedgerOwner,
    listTerminalWatches: (storeDir, options) =>
      terminalWatchCliFacade.listPublicWatches(storeDir, options),
    scanTerminalWatchesForExactObservation: (storeDir, options) =>
      terminalWatchCliFacade.scanPublicWatchesForExactObservation(
        storeDir,
        options
      ),
    managedSessionStoreDirForConversation: (conversation) =>
      terminalAcceptanceCliFacade.storeDirForConversation(conversation),
    managedTurnsForSession: (storeDir, sessionId) =>
      terminalAcceptanceCliFacade.turnsForSession(storeDir, sessionId),
    matchesConfiguredWorkspace,
    orphanedTerminalDispatchForRecovery:
      terminalDispatchRecovery.orphanedForRecovery,
    storeDirFromOptions,
    summarizeConversation: terminalStatusCliFacade.summarizeConversation,
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
    approvalTtlMs: CLAUDE_SCREEN_APPROVAL_TTL_MS,
    selectorCommands: SESSION_SELECTOR_COMMANDS,
    rememberOriginalExpectedTerminalSelector: (options, selector) => {
      terminalHandoffCliFacade.rememberOriginalExpectedTerminalSelector(
        options,
        selector
      );
    }
  }
});

const terminalWatchCliFacade = createTerminalWatchCliAdapter({
  acquireFileLock,
  acquireTerminalLock: (storeDir, terminalControl) =>
    acquireTerminalBridgeSendLock(storeDir, terminalControl, {
      timeoutMs: 30_000
    }),
  observeExactTerminal: terminalListCliFacade.observeExactTerminal,
  loadClaudeAgentRows,
  now: cliNow,
  randomUUID,
  storeDirFromOptions,
  terminalDispatchOwnership: (terminalControl) =>
    terminalListCliFacade.terminalDispatchOwnership(terminalControl),
  terminalIncarnationBlockingTurns: (storeDir, terminalControl) =>
    terminalListCliFacade.terminalIncarnationBlockingTurns(
      storeDir,
      terminalControl
    ),
  printJson
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
    bindingSuperseded: terminalTurnBindingAuthority.superseded,
    approvalTtlMs: CLAUDE_SCREEN_APPROVAL_TTL_MS,
    callbackRetryLimit: CALLBACK_RETRY_DELAYS_MS.length
  }
});
const terminalMonitorSupervisionCliFacade =
  createTerminalMonitorSupervisionCliAdapter({
    state: terminalMonitorStateCliFacade,
    callbacks: callbackCliFacade,
    authority: {
      migrateIdentity: migrateLegacyTerminalAgentIdentity,
      createBridge: createTerminalAgentBridge
    },
    io: {
      spawn,
      locks: cliFileLock,
      exists: fs.existsSync,
      loadState,
      listConversations,
      readEvents: readExistingEvents,
      appendEvent,
      logPathForStatePath
    },
    runtime: {
      executablePath: () => process.execPath,
      entryPath: cliEntryPath,
      cwd: cliCwd,
      environment: cliEnv,
      now: cliNow,
      sleepSync,
      isProcessAlive,
      storeDir: storeDirFromOptions,
      workspaceMatches: matchesConfiguredWorkspace,
      bindingSuperseded: (error) =>
        Boolean(terminalTurnBindingAuthority.superseded(error)),
      print: printJson,
      log: runtimeLog
    }
  });

const terminalMaintenanceCliFacade = createTerminalMaintenanceCliFacade({
  runtime: {
    defaultAgentTimeoutMinutes: DEFAULT_AGENT_TIMEOUT_MINUTES,
    defaultAgentHardTimeoutMinutes: DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
    monitorLockVersion: terminalMonitorSupervisionCliFacade.monitorLockVersion,
    loadConversation: loadConversationFromOptions,
    storeDir: storeDirFromOptions,
    createControlProvider: createTerminalControlProvider,
    createBridge: createTerminalAgentBridge,
    startMonitor: (input) => terminalMonitorSupervisionCliFacade
      .startTerminalBridgeMonitorForConversation(input),
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
    loadTerminalDispatchLedgerOwner
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
  options: CliCommandOptions
): string | undefined {
  return terminalRuntime(options).agentVersionForRunningProcess(agent, pid);
}

const terminalBridgeRequestFingerprint =
  dispatchReceipt.terminalBridgeRequestFingerprint;

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

function statusStoreSelection(options) {
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
  return { storeDir, reconciliationConversationId };
}

function storeDirFromOptions(options) {
  return expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(cliCwd()));
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
    ensureTerminalBridgeMonitorAfterApproval: (input) =>
      terminalMonitorSupervisionCliFacade
        .ensureTerminalBridgeMonitorAfterApproval(input),
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
    processIncarnationForPid: (pid) =>
      terminalProcessIncarnationForPid(
        pid,
        cliDependencies().processBirthForPid ??
          cliDependencies().codexProcessBirthForPid
      ),
    prepareDeferredCodexForegroundBinding,
    quarantineManagedSessionBinding,
    reattachManagedSessionForNativeIdentity,
    reconcilePreparedTerminalDispatchLedger,
    refineManagedSessionNativeIdentity,
    refineTerminalTurnEndpoint,
    required,
    resolveCurrentNativeAgentSessionIdentity,
    resolveTerminalBridgeDispatchLedger,
    resolveTerminalConversationFromOptions,
    resolveTerminalDispatchLedgerPaneIncarnation,
    soleBoundManagedSessionClaimForTerminal,
    stallOtherTerminalBridgeConversationsForUncertainDispatch: (input) =>
      terminalMonitorStateCliFacade.stallOther(input),
    startTerminalBridgeMonitorForConversation: (input) =>
      terminalMonitorSupervisionCliFacade
        .startTerminalBridgeMonitorForConversation(input),
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
  }
});

const terminalDelegateCliFacade = createTerminalDelegateCliFacade({
  runtime: {
    canonicalWorkspace,
    required,
    terminalRuntimeKey: terminalDispatchRepository.runtimeKey
  },
  terminalList: {
    buildTerminalListGroup: terminalListCliFacade.buildTerminalListGroup,
    observeExactTerminal: terminalListCliFacade.observeExactTerminal
  },
  sendBinding: terminalDelegateSendBindingRepository,
  terminalCommand: { runSend: terminalCommandCliFacade.runSend }
});

function usage() {
  const agentList = EXECUTOR_KINDS.join("|");
  writeCliStdout(`Usage:
  agent-knock-knock --help
  agent-knock-knock --version
  agent-knock-knock delegate --request <text> [--agent ${agentList}] [--workspace <path>] [--store-dir <dir>]
  agent-knock-knock list [--store-dir <dir>] [--agent ${agentList}] [--status <status>] [--all] [--reconcile] [--no-approval-scan] [--terminal-debug]
  agent-knock-knock watch-terminal --terminal <exact-terminal-id> --openclaw-session <session> [--hard-timeout-minutes <minutes>] [--store-dir <dir>] [--openclaw-bin <path>]
  agent-knock-knock watch-status --watch <terminal-watch-id> [--store-dir <dir>]
  agent-knock-knock unwatch-terminal --watch <terminal-watch-id> [--store-dir <dir>]
  agent-knock-knock reconcile-watches [--store-dir <dir>]
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
