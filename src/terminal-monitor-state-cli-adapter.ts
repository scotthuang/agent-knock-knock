import { randomUUID } from "node:crypto";
import path from "node:path";

import { validateCodexRolloutAcceptanceAnchor } from
  "./terminal-submission-acceptance.js";
import {
  listDeferredForegroundTransfers,
  loadDeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import {
  executorForConversation,
  createMessage,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation,
  type ConversationStatus
} from "./protocol.js";
import { executorDefinitionForKind } from "./executors.js";
import { redactString } from "./runtime-log.js";
import {
  appendEvent,
  listConversations,
  loadState,
  logPathForStatePath,
  pathsForConversationDir,
  saveState,
  statePathForConversationId,
  withStoreWriterLease,
  withStoreWriterLeaseAsync
} from "./store.js";
import { readNdjsonLog } from "./transcript.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import {
  cliEnv,
  cliExit,
  cliNow,
  cliNowMs,
  cliPid,
  cliRuntimeLog,
  cliSleepSync
} from "./cli-runtime-context.js";
import { expandHome } from "./cli-command-runtime.js";
import {
  type TerminalCompletionEvidence,
  type TerminalControlRef
} from "./terminal-agent-adapter.js";
import {
  type ResolvedTerminalConversation,
  type TerminalAgentBridge,
  type TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import { terminalControlFromTakeover } from "./terminal-runtime-cli-adapter.js";
import {
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
import {
  applyTerminalBridgeSubmission,
  terminalBridgeEnabled,
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission
} from "./terminal-dispatch-receipt.js";
import {
  terminalMonitorActivityPersistIntervalMs,
  terminalMonitorApprovalCandidate,
  validTerminalMonitorTimestampMs
} from "./terminal-monitor-decision-policy.js";
import {
  runTerminalMonitor as runTerminalMonitorService,
  type MonitorVerifiedDeadResult,
  type TerminalMonitorDeferralPorts,
  type TerminalMonitorServicePorts
} from "./terminal-monitor-application-service.js";
import {
  pollTerminalMonitor,
  presentTerminalMonitor,
  reconcileMonitorAcceptance,
  recordMonitorApprovalNotification,
  recoverPreparedMonitorSubmission,
  type ApprovalNotificationAdapterPorts,
  terminalMonitorStoreLeaseTimeout,
  terminalMonitorStoreOperationTimeout
} from "./terminal-monitor-cli-adapter.js";
import {
  terminalMonitorReconciliationEligibility,
  type TerminalMonitorEligibility
} from "./terminal-monitor-reconciliation-eligibility.js";
import {
  reconcileTerminalMonitorStateCandidate,
  type TerminalMonitorStatePaths,
  type TerminalMonitorStateReconciliation,
  type TerminalMonitorStateReconciliationPorts
} from "./terminal-monitor-state-reconciliation-service.js";
import type {
  TerminalDispatchRepositoryCliAdapter
} from "./terminal-dispatch-repository-cli-adapter.js";
import type {
  TerminalDispatchRecoveryCliFacade
} from "./terminal-dispatch-recovery-cli-adapter.js";
import type {
  TerminalAcceptanceCliFacade
} from "./terminal-acceptance-cli-adapter.js";
import type {
  TerminalHandoffCliFacade
} from "./terminal-handoff-cli-adapter.js";
import type { createTerminalIdentityAuthorityCliAdapter } from
  "./terminal-identity-authority-cli-adapter.js";
import type { CallbackCliFacade } from "./callback-cli-adapter.js";
import { isRecord, nonBlankString } from "./value-guards.js";

type MonitorCliOptions = Record<string, unknown>;
type IdentityAuthority = ReturnType<
  typeof createTerminalIdentityAuthorityCliAdapter
>;
type Release = () => void;

const COLLATERAL_STALL_REASON =
  "a newer terminal submission has an uncertain outcome; inspect the shared terminal pane before continuing";
const FINAL_DEFERRED_STATUSES = new Set(["resolved", "abort_resolved"]);
const SEND_BLOCKING_STATUSES = new Set<ConversationStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "stalled",
  "callback_pending",
  "callback_failed",
  "cancelling"
]);

export interface TerminalMonitorStateCliDependencies {
  dispatch: {
    repository: TerminalDispatchRepositoryCliAdapter;
    recovery: TerminalDispatchRecoveryCliFacade;
  };
  acceptance: Pick<
    TerminalAcceptanceCliFacade,
    "markUncertain" | "reconcileMonitor" | "recoverVirgin" |
      "storeDirForConversation"
  >;
  authority: {
    identity: Pick<
      IdentityAuthority,
      "migrateLegacyTerminalAgentIdentity" |
        "terminalRuntimeIdentityForConversation" |
        "terminalDurableRequestForConversation"
    >;
    handoff: Pick<
      TerminalHandoffCliFacade,
      "recoverDeferredCodexForegroundTransferBeforeMutation"
    >;
    assertBindingCurrent(
      conversation: Conversation,
      operation: string
    ): void;
    terminalControlForConversation(
      conversation: Conversation
    ): TerminalControlRef | undefined;
    createBridge(options: MonitorCliOptions): TerminalAgentBridge;
  };
  callbacks: Pick<
    CallbackCliFacade,
    "reconcileDelivery" | "prepareApprovalNotification" | "runPrepared" |
      "emitPreparedResult" | "deliverGatewayMethod" | "deliverChatSend"
  >;
  runtime: {
    isProcessAlive(pid: number): boolean;
    storeDir(options: MonitorCliOptions): string;
    print(value: Record<string, unknown>): void;
    bindingSuperseded(error: unknown):
      | { code: string; message: string }
      | undefined;
    approvalTtlMs: number;
    callbackRetryLimit: number;
  };
}

export interface TerminalMonitorStateCliAdapter {
  runService(input: {
    options: MonitorCliOptions;
    statePath: string;
    logPath: string;
    initialConversation: Conversation;
    expectedTerminalMessageId: string;
    lifecycle: { startedRecorded: boolean };
    configuration(): {
      pollIntervalMs: number;
      timeoutMinutes: number;
      hardTimeoutMinutes: number;
    };
    terminalBridge(): TerminalAgentBridge;
  }): Promise<void>;
  deferralPorts(paths: TerminalMonitorStatePaths): TerminalMonitorDeferralPorts;
  reconcileCollateral(storeDir: string, conversationId?: string): Promise<
    TerminalBridgeCollateralStallReconciliation
  >;
  stallOther(input: {
    storeDir: string;
    terminalControl: TerminalControlRef;
    currentConversationId: string;
    uncertainMessageId: string;
  }): string[];
  statePaths(
    listed: Conversation,
    storeDir: string
  ): TerminalMonitorStatePaths;
  reconcileState(input: {
    options: MonitorCliOptions;
    storeDir: string;
    listed: Conversation;
    paths: TerminalMonitorStatePaths;
    includeCallbackRecovery: boolean;
  }): Promise<TerminalMonitorStateReconciliation>;
  eligibility(conversation: Conversation): TerminalMonitorEligibility;
  prepareLaunch(input: {
    statePath: string;
    expectedMessageId: string;
    requireWaitingForAgentStatus?: boolean;
    activeOwner(
      statePath: string,
      terminalMessageId: string
    ): { ownerPid?: number } | undefined;
    monitorLockVersion: number;
  }): TerminalMonitorLaunchPreparation;
}

export type TerminalMonitorLaunchPreparation =
  | {
      prepared: false;
      alreadyRunning: boolean;
      reason: string;
      ownerPid?: number;
    }
  | {
      prepared: true;
      conversation: Conversation;
      terminalControl: TerminalControlRef;
      inactivityTimeoutMinutes: number;
      hardTimeoutMinutes: number;
    };

interface TerminalBridgeCollateralStallReconciliation {
  checked: number;
  repaired: number;
  skipped: number;
  errors: string[];
  items: Record<string, unknown>[];
}

interface TerminalBridgeCollateralRepairEvidence {
  uncertainMessageId: string;
  ownerConversationId: string;
  restoredStatus: "idle";
}

interface CollateralOwnerVerificationInput {
  conversation: Conversation;
  takeover: Record<string, unknown>;
  ownMessageId: string;
  completionClaim: Record<string, unknown>;
  callbackMessage: Record<string, unknown>;
  callbackMessageId: string;
  deliveredAt: string;
  claimedAt: string;
  fenceObservedAt: string;
  fenceAtMs: number;
  uncertainMessageId: string;
  control: TerminalControlRef;
  ownerListed: Conversation;
}

type ApprovalRecordRequest = Parameters<
  ApprovalNotificationAdapterPorts["record"]
>[0];

interface ApprovalPersistenceContext {
  input: ApprovalRecordRequest & TerminalMonitorStatePaths;
  conversation: Conversation;
  nativeTakeover: Record<string, unknown>;
  approvalScreenDigest?: string;
  previousApproval?: Record<string, unknown>;
  previousNotifiedAt?: number;
  previousCallbackMessageId?: string;
  matchingApprovalOutbox: boolean;
  conflictingActiveOutbox: boolean;
}

interface TerminalMonitorActivityInput {
  conversation: Conversation;
  statePath: string;
  logPath: string;
  observedAtMs: number;
  reason: string;
  activityState: string;
  timeoutMinutes: number;
  hardTimeoutMinutes: number;
}

/** Invocation-local monitor state and reconciliation CLI boundary. */
export function createTerminalMonitorStateCliAdapter(
  dependencies: TerminalMonitorStateCliDependencies
): TerminalMonitorStateCliAdapter {
  const application = new TerminalMonitorStateCliApplication(dependencies);
  return Object.freeze({
    runService: (input) => application.runService(input),
    deferralPorts: (paths) => application.deferralPorts(paths),
    reconcileCollateral: (storeDir, conversationId) =>
      application.reconcileCollateral(storeDir, conversationId),
    stallOther: (input) => application.stallOther(input),
    statePaths: (listed, storeDir) => application.statePaths(listed, storeDir),
    reconcileState: (input) => application.reconcileState(input),
    eligibility: (conversation) => application.eligibility(conversation),
    prepareLaunch: (input) => application.prepareLaunch(input)
  });
}

class TerminalMonitorStateCliApplication {
  readonly #dependencies: TerminalMonitorStateCliDependencies;
  readonly #stateFileLock = createFileLockCliAdapter({
    now: cliNow,
    nowMs: cliNowMs,
    pid: cliPid,
    sleepSync: cliSleepSync
  });

  constructor(dependencies: TerminalMonitorStateCliDependencies) {
    this.#dependencies = dependencies;
  }

  async runService(input: Parameters<TerminalMonitorStateCliAdapter["runService"]>[0]):
    Promise<void> {
    await runTerminalMonitorService({
      initialConversation: input.initialConversation,
      expectedTerminalMessageId: input.expectedTerminalMessageId,
      lifecycle: input.lifecycle,
      configuration: () => {
        const configuration = input.configuration();
        return {
          ...configuration,
          activityPersistIntervalMs: terminalMonitorActivityPersistIntervalMs(
            configuration.timeoutMinutes,
            configuration.pollIntervalMs
          )
        };
      },
      ports: this.#servicePorts(input)
    });
  }

  deferralPorts(paths: TerminalMonitorStatePaths): TerminalMonitorDeferralPorts {
    return {
      state: {
        load: () => loadState(paths.statePath),
        appendEvent: (event) => appendEvent(paths.logPath, event)
      },
      authority: {
        terminalControl: (conversation) =>
          terminalControlFromTakeover(takeoverFor(conversation)),
        bindingSuperseded: this.#dependencies.runtime.bindingSuperseded,
        storeOperationTimeout: terminalMonitorStoreOperationTimeout
      },
      runtime: monitorRuntimePort(),
      presentation: {
        emit: (result) => presentTerminalMonitor(
          result,
          this.#dependencies.runtime.print
        )
      }
    };
  }

  statePaths(listed: Conversation, storeDir: string): TerminalMonitorStatePaths {
    const statePath = expandHome(
      nonBlankString(listed.state_path) ??
        statePathForConversationId(listed.conversation_id, storeDir)
    );
    return {
      statePath,
      logPath: expandHome(
        nonBlankString(listed.event_log_path) ?? logPathForStatePath(statePath)
      )
    };
  }

  eligibility(conversation: Conversation): TerminalMonitorEligibility {
    const staged = terminalMonitorReconciliationEligibility(conversation);
    let step = staged.next();
    while (!step.done) {
      const request = step.value;
      step = staged.next(request.kind === "control"
        ? {
            kind: "control",
            terminalControl: terminalControlFromTakeover(request.nativeTakeover)
          }
        : request.kind === "dispatch"
          ? {
              kind: "dispatch",
              ledger: this.#dependencies.dispatch.repository.load(
                request.terminalControl
              )
            }
          : request.kind === "store"
            ? {
                kind: "store",
                storeDir: this.#dependencies.acceptance.storeDirForConversation(
                  conversation
                )
              }
            : request.kind === "runtime"
              ? {
                  kind: "runtime",
                  runtime: this.#dependencies.authority.identity
                    .terminalRuntimeIdentityForConversation(
                      conversation,
                      request.terminalControl
                    )
                }
              : {
                  kind: "deferred",
                  transfer: loadDeferredForegroundTransfer(
                    request.storeDir,
                    request.transferId
                  )
                });
    }
    return step.value;
  }

  async reconcileState(
    input: Parameters<TerminalMonitorStateCliAdapter["reconcileState"]>[0]
  ): Promise<TerminalMonitorStateReconciliation> {
    return reconcileTerminalMonitorStateCandidate({
      storeDir: input.storeDir,
      listed: input.listed,
      paths: input.paths,
      includeCallbackRecovery: input.includeCallbackRecovery,
      callbackRetryDelayMs: input.options.callbackRetryDelayMs,
      ports: this.#stateReconciliationPorts(input.options)
    });
  }

  #stateReconciliationPorts(
    options: MonitorCliOptions
  ): TerminalMonitorStateReconciliationPorts {
    return {
      state: {
        isTerminalBridge: terminalBridgeEnabled
      },
      completion: {
        settleLocal: (storeDir, paths) =>
          this.#dependencies.dispatch.recovery.settleLocalCompletion({
            storeDir,
            statePath: paths.statePath,
            logPath: paths.logPath
          }),
        verifiedDead: ({ storeDir, paths, conversation }) =>
          this.#dependencies.dispatch.recovery.stallAccepted({
            options,
            storeDir,
            statePath: paths.statePath,
            logPath: paths.logPath,
            expectedConversationId: conversation.conversation_id,
            expectedMessageId: nonBlankString(
              takeoverFor(conversation)?.terminal_bridge_message_id
            )
          }) as Promise<MonitorVerifiedDeadResult>
      },
      callbacks: {
        reconcile: (storeDir, paths, delayMs) => withStoreWriterLease(
          storeDir,
          () => this.#dependencies.callbacks.reconcileDelivery({
            statePath: paths.statePath,
            logPath: paths.logPath,
            delayMs
          })
        ),
        run: (prepared, callbackOptions) =>
          this.#dependencies.callbacks.runPrepared(prepared, callbackOptions)
      },
      authority: {
        migrateIdentity: (listed, paths) =>
          this.#dependencies.authority.identity
            .migrateLegacyTerminalAgentIdentity({
              conversation: loadState(paths.statePath),
              statePath: paths.statePath,
              logPath: paths.logPath,
              options
            }),
        recoverDeferred: (storeDir, conversation, paths) =>
          this.#recoverDeferred(options, storeDir, conversation, paths),
        recoverVirgin: async (conversation, paths) =>
          (await this.#dependencies.acceptance.recoverVirgin({
            options,
            conversation,
            statePath: paths.statePath,
            logPath: paths.logPath
          })).conversation,
        assertBindingCurrent: (storeDir, conversation) => {
          const transferId = nonBlankString(
            takeoverFor(conversation)?.deferred_foreground_transfer_id
          );
          const transfer = transferId
            ? loadDeferredForegroundTransfer(storeDir, transferId)
            : undefined;
          if (!transfer || FINAL_DEFERRED_STATUSES.has(transfer.status)) {
            this.#dependencies.authority.assertBindingCurrent(
              conversation,
              "reconcile monitor for"
            );
          }
        },
        eligibility: (conversation) => this.eligibility(conversation)
      }
    };
  }

  async #recoverDeferred(
    options: MonitorCliOptions,
    storeDir: string,
    initialConversation: Conversation,
    paths: TerminalMonitorStatePaths
  ): Promise<Conversation> {
    const takeover = takeoverFor(initialConversation);
    const transferId = nonBlankString(
      takeover?.deferred_foreground_transfer_id
    );
    if (!transferId) {
      return initialConversation;
    }
    const transfer = loadDeferredForegroundTransfer(storeDir, transferId);
    if (FINAL_DEFERRED_STATUSES.has(transfer.status)) {
      return initialConversation;
    }
    const control = terminalControlFromTakeover(takeover);
    const pid = Number(takeover?.terminal_agent_pid);
    if (!control || !Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(
        `deferred foreground Turn ${initialConversation.conversation_id} ` +
        "lost its exact terminal process authority"
      );
    }
    const terminal = await this.#dependencies.authority.createBridge(options)
      .resolveStoredTerminal("codex", pid, control, { pid });
    const release = this.#dependencies.dispatch.repository.acquire(
      storeDir,
      control,
      { timeoutMs: 30000 }
    );
    try {
      await this.#dependencies.authority.handoff
        .recoverDeferredCodexForegroundTransferBeforeMutation({
          options,
          terminal: terminal as ResolvedTerminalConversation
        });
    } finally {
      release();
    }
    const conversation = loadState(paths.statePath);
    this.#assertExactPendingDeferred(conversation, storeDir, transferId);
    return conversation;
  }

  #assertExactPendingDeferred(
    conversation: Conversation,
    storeDir: string,
    transferId: string
  ): void {
    const transfer = loadDeferredForegroundTransfer(storeDir, transferId);
    if (FINAL_DEFERRED_STATUSES.has(transfer.status)) {
      return;
    }
    const takeover = takeoverFor(conversation);
    const submission = terminalBridgeSubmission(conversation);
    const anchor = validateCodexRolloutAcceptanceAnchor(
      takeover?.codex_rollout_acceptance_anchor
    );
    if (
      anchor?.version !== 3 ||
      conversation.status !== "waiting_for_agent" ||
      submission?.status !== "enter_dispatched" ||
      nonBlankString(submission.message_id) !==
        nonBlankString(takeover?.terminal_bridge_message_id) ||
      transfer.status !== "dispatch_started"
    ) {
      throw new Error(
        `deferred foreground Turn ${conversation.conversation_id} ` +
        "is not an exact pending candidate-set acceptance"
      );
    }
  }

  prepareLaunch(
    input: Parameters<TerminalMonitorStateCliAdapter["prepareLaunch"]>[0]
  ): TerminalMonitorLaunchPreparation {
    const release = this.#stateFileLock.acquire(`${input.statePath}.lock`);
    try {
      const conversation = loadState(input.statePath);
      if (input.requireWaitingForAgentStatus &&
          conversation.status !== "waiting_for_agent") {
        return unprepared(
          `conversation_status_${String(conversation.status ?? "missing")}`
        );
      }
      const eligibility = this.eligibility(conversation);
      if (!eligibility.eligible) {
        return unprepared(eligibility.reason);
      }
      if (eligibility.terminalMessageId !== input.expectedMessageId) {
        return unprepared("terminal_bridge_task_replaced");
      }
      const owner = input.activeOwner(
        input.statePath,
        eligibility.terminalMessageId
      );
      if (owner) {
        return {
          prepared: false,
          alreadyRunning: true,
          reason: "monitor_lock_owner_alive",
          ownerPid: owner.ownerPid
        };
      }
      return this.#persistMonitorLockVersion(
        conversation,
        eligibility,
        input.monitorLockVersion,
        input.statePath
      );
    } finally {
      release();
    }
  }

  #persistMonitorLockVersion(
    conversation: Conversation,
    eligibility: Extract<TerminalMonitorEligibility, { eligible: true }>,
    lockVersion: number,
    statePath: string
  ): Extract<TerminalMonitorLaunchPreparation, { prepared: true }> {
    const needsSave =
      eligibility.nativeTakeover.terminal_bridge_monitor_lock_version !==
        lockVersion;
    const preparedConversation = needsSave
      ? {
          ...conversation,
          native_session_takeover: {
            ...eligibility.nativeTakeover,
            terminal_bridge_monitor_lock_version: lockVersion
          },
          updated_at: cliNow().toISOString()
        }
      : conversation;
    if (needsSave) {
      saveState(statePath, preparedConversation);
    }
    return {
      prepared: true,
      conversation: preparedConversation,
      terminalControl: eligibility.terminalControl,
      inactivityTimeoutMinutes: eligibility.inactivityTimeoutMinutes,
      hardTimeoutMinutes: eligibility.hardTimeoutMinutes
    };
  }

  #servicePorts(
    input: Parameters<TerminalMonitorStateCliAdapter["runService"]>[0]
  ): TerminalMonitorServicePorts {
    let resolvedStateStoreDir: string | undefined;
    const commandStoreDir = () =>
      this.#dependencies.runtime.storeDir(input.options);
    const stateStoreDir = () => resolvedStateStoreDir ??=
      pathsForConversationDir(path.dirname(input.statePath)).storeDir;
    const bridge = input.terminalBridge;
    return {
      state: {
        load: () => loadState(input.statePath),
        appendEvent: (event) => appendEvent(input.logPath, event),
        markStalled: (reason, detail) => {
          const conversation = this.#markStalled({
            statePath: input.statePath,
            logPath: input.logPath,
            reason,
            detail
          });
          if (!conversation) {
            throw new Error(
              "terminal monitor stall transaction returned no conversation"
            );
          }
          return conversation;
        },
        persistActivity: (request) => this.#persistActivity({
          ...request,
          statePath: input.statePath,
          logPath: input.logPath
        }),
        persistDetectorDiagnostic: (request) =>
          this.#persistDetectorDiagnostic({
            ...request,
            statePath: input.statePath,
            logPath: input.logPath
          }),
        markApprovalPromptCleared: (request) =>
          this.#markApprovalPromptCleared({
            ...request,
            statePath: input.statePath,
            logPath: input.logPath
          }),
        recordApprovalNotification: (request) =>
          recordMonitorApprovalNotification({
            ...request,
            ports: {
              record: (recordRequest) => this.#recordApprovalNotification({
                ...recordRequest,
                statePath: input.statePath,
                logPath: input.logPath
              }),
              prepare: (prepareRequest) =>
                this.#dependencies.callbacks.prepareApprovalNotification({
                    options: { ...input.options, statePath: input.statePath },
                    statePath: input.statePath,
                    logPath: input.logPath,
                    ...prepareRequest
                  }),
              approvalInstructions: terminalBridgeApprovalInstructions,
              approvalCandidate: terminalMonitorApprovalCandidate
            }
          })
      },
      authority: {
        initialize: () => { bridge(); },
        terminalControl: (conversation) =>
          terminalControlFromTakeover(takeoverFor(conversation)),
        submission: terminalBridgeSubmission,
        isWaitingForAgent,
        isProcessAlive: this.#dependencies.runtime.isProcessAlive,
        markAcceptanceUncertain: (request) =>
          this.#dependencies.acceptance.markUncertain({
            ...request,
            statePath: input.statePath,
            logPath: input.logPath
          }),
        reconcileAcceptance: (request) => reconcileMonitorAcceptance({
          terminalControl: request.terminalControl,
          acquireTerminal: (control) =>
            this.#dependencies.dispatch.repository.acquire(
              commandStoreDir(),
              control,
              { timeoutMs: 30000 }
            ),
          reconcile: () => this.#dependencies.acceptance.reconcileMonitor({
            ...request,
            options: input.options,
            statePath: input.statePath,
            logPath: input.logPath,
            terminalBridge: bridge()
          }),
          apply: request.apply,
          recover: request.recover
        }),
        recoverPreparedSubmission: (request) =>
          recoverPreparedMonitorSubmission({
            ...request,
            statePath: input.statePath,
            logPath: input.logPath,
            ports: {
              acquireTerminal: (control) =>
                this.#dependencies.dispatch.repository.acquire(
                  commandStoreDir(),
                  control,
                  { timeoutMs: 30000 }
                ),
              withWriter: (use) =>
                withStoreWriterLeaseAsync(stateStoreDir(), use),
              acquireState: () =>
                this.#stateFileLock.acquire(`${input.statePath}.lock`),
              loadConversation: () => loadState(input.statePath),
              loadLedger: this.#dependencies.dispatch.repository.load,
              saveLedger: this.#dependencies.dispatch.repository.save,
              saveConversation: (conversation) =>
                saveState(input.statePath, conversation),
              submission: terminalBridgeSubmission,
              applySubmission: (mutation) => applyTerminalBridgeSubmission(
                mutation,
                {
                  dispatcherPid: cliPid(),
                  storeDir: this.#dependencies.acceptance
                    .storeDirForConversation(mutation.conversation),
                  terminalControl: terminalControlFromTakeover(
                    takeoverFor(mutation.conversation)
                  )
                }
              ),
              requestFingerprint: terminalBridgeRequestFingerprint,
              now: cliNow,
              appendEvent: (event) => appendEvent(input.logPath, event),
              stallCollateral: (stallRequest) => {
                this.#stallOtherConversations({
                  storeDir: stateStoreDir(),
                  ...stallRequest
                });
              }
            }
          }),
        assertBindingCurrent: (conversation) =>
          this.#dependencies.authority.assertBindingCurrent(
            conversation,
            "monitor"
          ),
        bindingSuperseded: this.#dependencies.runtime.bindingSuperseded,
        storeOperationTimeout: terminalMonitorStoreOperationTimeout,
        storeLeaseTimeout: terminalMonitorStoreLeaseTimeout,
        poll: (request) => pollTerminalMonitor({
          ...request,
          terminalBridge: bridge(),
          scrollbackLines: Number(input.options.scrollbackLines ?? 120),
          ports: {
            acquireTerminal: (control) =>
              this.#dependencies.dispatch.repository.acquire(
                commandStoreDir(),
                control,
                { timeoutMs: 30000 }
              ),
            reconcileLedger:
              this.#dependencies.dispatch.recovery.reconcilePrepared,
            loadLedger: this.#dependencies.dispatch.repository.load,
            saveLedger: this.#dependencies.dispatch.repository.save,
            submission: terminalBridgeSubmission,
            loadConversation: () => loadState(input.statePath),
            terminalControl: (conversation) =>
              terminalControlFromTakeover(takeoverFor(conversation)),
            sameIncarnation: terminalControlsShareIncarnation,
            runtime: (conversation, control) =>
              this.#dependencies.authority.identity
                .terminalRuntimeIdentityForConversation(conversation, control),
            durableRequest: (conversation, control) =>
              this.#dependencies.authority.identity
                .terminalDurableRequestForConversation(conversation, control),
            appendEvent: (event) => appendEvent(input.logPath, event),
            now: cliNow
          }
        })
      },
      callbacks: {
        prepareCompletion: (request) =>
          this.#dependencies.dispatch.recovery.prepareCompletion({
            options: input.options,
            statePath: input.statePath,
            logPath: input.logPath,
            ...request
          }),
        verifiedDead: (request) =>
          this.#dependencies.dispatch.recovery.stallAccepted({
            options: input.options,
            storeDir: stateStoreDir(),
            statePath: input.statePath,
            logPath: input.logPath,
            expectedConversationId: request.conversationId,
            expectedMessageId: request.messageId
          }) as Promise<MonitorVerifiedDeadResult>,
        run: (prepared, callbackOptions) =>
          this.#dependencies.callbacks.runPrepared(prepared, callbackOptions),
        emit: this.#dependencies.callbacks.emitPreparedResult
      },
      runtime: monitorRuntimePort(),
      presentation: {
        emit: (result) => presentTerminalMonitor(
          result,
          this.#dependencies.runtime.print
        )
      }
    };
  }

  #stallOtherConversations(input: {
    storeDir: string;
    terminalControl: TerminalControlRef;
    currentConversationId: string;
    uncertainMessageId: string;
  }): string[] {
    const stalledConversationIds: string[] = [];
    for (const listed of listConversations(input.storeDir)) {
      if (
        listed.conversation_id === input.currentConversationId ||
        !SEND_BLOCKING_STATUSES.has(listed.status)
      ) {
        continue;
      }
      const listedTakeover = takeoverFor(listed);
      if (
        listedTakeover?.terminal_bridge !== true ||
        !terminalControlsShareIncarnation(
          terminalControlFromTakeover(listedTakeover),
          input.terminalControl
        )
      ) {
        continue;
      }
      const statePath = nonBlankString(listed.state_path);
      if (!statePath) {
        continue;
      }
      const release = this.#stateFileLock.acquire(`${statePath}.lock`);
      try {
        const current = loadState(statePath);
        const currentTakeover = takeoverFor(current);
        if (
          !SEND_BLOCKING_STATUSES.has(current.status) ||
          currentTakeover?.terminal_bridge !== true ||
          !terminalControlsShareIncarnation(
            terminalControlFromTakeover(currentTakeover),
            input.terminalControl
          )
        ) {
          continue;
        }
        const stalledAt = cliNow().toISOString();
        const stalledConversation: Conversation = {
          ...current,
          status: "stalled",
          stalled_at: stalledAt,
          stalled_reason: COLLATERAL_STALL_REASON,
          native_session_takeover: {
            ...currentTakeover,
            terminal_bridge_uncertain_dispatch_fence: {
              message_id: input.uncertainMessageId,
              observed_at: stalledAt,
              previous_status: current.status
            }
          },
          updated_at: stalledAt
        };
        saveState(statePath, stalledConversation);
        try {
          appendEvent(logPathForStatePath(statePath), {
            ts: stalledAt,
            conversation_id: current.conversation_id,
            event: "terminal_bridge_stalled_by_uncertain_dispatch",
            terminal_control: input.terminalControl,
            uncertain_message_id: input.uncertainMessageId
          });
        } catch {
          // State plus the terminal ledger are the authoritative fence.
        }
        stalledConversationIds.push(current.conversation_id);
      } finally {
        release();
      }
    }
    return stalledConversationIds;
  }

  stallOther(
    input: Parameters<TerminalMonitorStateCliAdapter["stallOther"]>[0]
  ): string[] {
    return this.#stallOtherConversations(input);
  }

  #exactCollateralRepairEvidence(
    conversation: Conversation,
    storeDir: string
  ): TerminalBridgeCollateralRepairEvidence | undefined {
    if (
      conversation.status !== "stalled" ||
      conversation.stalled_reason !== COLLATERAL_STALL_REASON
    ) {
      return undefined;
    }
    const takeover = takeoverFor(conversation);
    const fence = isRecord(takeover?.terminal_bridge_uncertain_dispatch_fence)
      ? takeover.terminal_bridge_uncertain_dispatch_fence
      : undefined;
    const uncertainMessageId = nonBlankString(fence?.message_id);
    const fenceObservedAt = nonBlankString(fence?.observed_at);
    const previousStatus = nonBlankString(fence?.previous_status);
    const ownMessageId = nonBlankString(takeover?.terminal_bridge_message_id);
    const ownSubmission = terminalBridgeSubmission(conversation);
    const completionClaim = isRecord(takeover?.terminal_bridge_completion_claim)
      ? takeover.terminal_bridge_completion_claim
      : undefined;
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    const callbackMessage = isRecord(callbackDelivery?.message)
      ? callbackDelivery.message
      : undefined;
    const idleSince = nonBlankString(conversation.idle_since);
    const deliveredAt = nonBlankString(callbackDelivery?.delivered_at);
    const claimedAt = nonBlankString(completionClaim?.claimed_at);
    const fenceAtMs = validTerminalMonitorTimestampMs(fenceObservedAt);
    const idleAtMs = validTerminalMonitorTimestampMs(idleSince);
    const deliveredAtMs = validTerminalMonitorTimestampMs(deliveredAt);
    const claimedAtMs = validTerminalMonitorTimestampMs(claimedAt);
    if (
      takeover?.terminal_bridge !== true ||
      !uncertainMessageId ||
      !fenceObservedAt ||
      fenceAtMs === undefined ||
      uncertainMessageId === ownMessageId ||
      (previousStatus !== undefined && previousStatus !== "idle") ||
      conversation.stalled_at !== fenceObservedAt ||
      conversation.updated_at !== fenceObservedAt ||
      !idleSince ||
      idleAtMs === undefined ||
      idleAtMs > fenceAtMs ||
      !ownMessageId ||
      ownSubmission?.status !== "agent_accepted" ||
      nonBlankString(ownSubmission.message_id) !== ownMessageId ||
      nonBlankString(ownSubmission.session_id) !==
        sessionIdForConversation(conversation) ||
      nonBlankString(ownSubmission.turn_id) !== turnIdForConversation(conversation) ||
      !completionClaim ||
      nonBlankString(completionClaim.terminal_bridge_message_id) !== ownMessageId ||
      completionClaim.outcome !== "success" ||
      !claimedAt ||
      claimedAtMs === undefined ||
      claimedAtMs > fenceAtMs ||
      callbackDelivery?.status !== "delivered" ||
      callbackDelivery.final_status !== "idle" ||
      callbackDelivery.preserve_conversation_status !== true ||
      !callbackMessage ||
      callbackMessage.type !== "done" ||
      callbackMessage.requires_response !== false ||
      nonBlankString(callbackMessage.id) !==
        nonBlankString(completionClaim.callback_message_id) ||
      nonBlankString(callbackMessage.conversation_id) !==
        conversation.conversation_id ||
      nonBlankString(callbackMessage.session_id) !==
        sessionIdForConversation(conversation) ||
      nonBlankString(callbackMessage.turn_id) !== turnIdForConversation(conversation) ||
      nonBlankString(
        isRecord(callbackMessage.metadata)
          ? callbackMessage.metadata.terminal_bridge_message_id
          : undefined
      ) !== ownMessageId ||
      !deliveredAt ||
      deliveredAtMs === undefined ||
      deliveredAtMs > fenceAtMs
    ) {
      return undefined;
    }
    const control = this.#dependencies.authority
      .terminalControlForConversation(conversation);
    if (!control) {
      return undefined;
    }
    const ownerCandidates = listConversations(storeDir).filter((candidate) => {
      if (candidate.conversation_id === conversation.conversation_id) {
        return false;
      }
      const candidateTakeover = takeoverFor(candidate);
      const candidateSubmission = terminalBridgeSubmission(candidate);
      return candidateTakeover?.terminal_bridge === true &&
        nonBlankString(candidateTakeover.terminal_bridge_message_id) ===
          uncertainMessageId &&
        nonBlankString(candidateSubmission?.message_id) === uncertainMessageId &&
        terminalControlsShareIncarnation(
          this.#dependencies.authority.terminalControlForConversation(candidate),
          control
        );
    });
    if (ownerCandidates.length !== 1) {
      return undefined;
    }
    return this.#verifyCollateralOwner({
      conversation,
      takeover,
      ownMessageId,
      completionClaim,
      callbackMessage,
      callbackMessageId: nonBlankString(callbackMessage.id) as string,
      deliveredAt,
      claimedAt,
      fenceObservedAt,
      fenceAtMs,
      uncertainMessageId,
      control,
      ownerListed: ownerCandidates[0]
    });
  }

  #verifyCollateralOwner(
    input: CollateralOwnerVerificationInput
  ): TerminalBridgeCollateralRepairEvidence | undefined {
    const ownerStatePath = nonBlankString(input.ownerListed.state_path);
    if (!ownerStatePath) {
      return undefined;
    }
    let owner: Conversation;
    let ownerEvents: Record<string, unknown>[];
    let events: Record<string, unknown>[];
    try {
      owner = loadState(ownerStatePath);
      ownerEvents = readNdjsonLog(
        nonBlankString(owner.event_log_path) ??
          logPathForStatePath(ownerStatePath)
      );
      const statePath = nonBlankString(input.conversation.state_path);
      if (!statePath) {
        return undefined;
      }
      events = readNdjsonLog(
        nonBlankString(input.conversation.event_log_path) ??
          logPathForStatePath(statePath)
      );
    } catch {
      return undefined;
    }
    const ownerTakeover = takeoverFor(owner);
    const ownerSubmission = terminalBridgeSubmission(owner);
    const ownerClosedAt = nonBlankString(owner.closed_at);
    const ownerClosedAtMs = validTerminalMonitorTimestampMs(ownerClosedAt);
    if (
      owner.conversation_id !== input.ownerListed.conversation_id ||
      owner.status !== "closed" ||
      !ownerClosedAt ||
      ownerClosedAtMs === undefined ||
      ownerClosedAtMs < input.fenceAtMs ||
      !nonBlankString(owner.close_reason) ||
      owner.updated_at !== ownerClosedAt ||
      ownerTakeover?.terminal_bridge !== true ||
      nonBlankString(ownerTakeover.terminal_bridge_message_id) !==
        input.uncertainMessageId ||
      ownerSubmission?.status !== "uncertain" ||
      nonBlankString(ownerSubmission.message_id) !== input.uncertainMessageId ||
      nonBlankString(ownerSubmission.session_id) !== sessionIdForConversation(owner) ||
      nonBlankString(ownerSubmission.turn_id) !== turnIdForConversation(owner) ||
      isRecord(ownerTakeover.terminal_bridge_uncertain_dispatch_fence) ||
      !terminalControlsShareIncarnation(
        this.#dependencies.authority.terminalControlForConversation(owner),
        input.control
      )
    ) {
      return undefined;
    }
    if (!this.#hasExactCollateralEvents(input, owner, ownerClosedAt, events,
      ownerEvents)) {
      return undefined;
    }
    return {
      uncertainMessageId: input.uncertainMessageId,
      ownerConversationId: owner.conversation_id,
      restoredStatus: "idle"
    };
  }

  #hasExactCollateralEvents(
    input: CollateralOwnerVerificationInput,
    owner: Conversation,
    ownerClosedAt: string,
    events: Record<string, unknown>[],
    ownerEvents: Record<string, unknown>[]
  ): boolean {
    const hasCompletionClaim = events.some((event) =>
      event.event === "terminal_bridge_completion_claimed" &&
      event.conversation_id === input.conversation.conversation_id &&
      event.terminal_bridge_message_id === input.ownMessageId &&
      event.callback_message_id === input.callbackMessageId &&
      event.completion_fingerprint === input.completionClaim.completion_fingerprint &&
      event.completion_id === input.completionClaim.completion_id &&
      event.outcome === "success" &&
      event.ts === input.claimedAt
    );
    const hasCompletionDetected = events.some((event) =>
      event.event === "terminal_bridge_completion_detected" &&
      event.conversation_id === input.conversation.conversation_id &&
      event.terminal_bridge_message_id === input.ownMessageId &&
      event.callback_message_id === input.callbackMessageId &&
      event.completion_id === input.completionClaim.completion_id &&
      event.completion_outcome === "success" &&
      validTerminalMonitorTimestampMs(event.ts) !== undefined &&
      (validTerminalMonitorTimestampMs(event.ts) as number) <= input.fenceAtMs
    );
    const hasDeliveredCallback = events.some((event) =>
      event.event === "callback_delivery_succeeded" &&
      event.conversation_id === input.conversation.conversation_id &&
      event.message_id === input.callbackMessageId &&
      event.status === "idle" &&
      event.ts === input.deliveredAt
    );
    const hasExactFence = events.some((event) =>
      event.event === "terminal_bridge_stalled_by_uncertain_dispatch" &&
      event.conversation_id === input.conversation.conversation_id &&
      event.uncertain_message_id === input.uncertainMessageId &&
      event.ts === input.fenceObservedAt
    );
    const hasExactOwnerClose = ownerEvents.some((event) =>
      event.event === "conversation_closed" &&
      event.conversation_id === owner.conversation_id &&
      event.status === "closed" &&
      event.ts === ownerClosedAt &&
      event.reason === owner.close_reason
    );
    return hasCompletionClaim && hasCompletionDetected &&
      hasDeliveredCallback && hasExactFence && hasExactOwnerClose;
  }

  async reconcileCollateral(
    storeDir: string,
    conversationId?: string
  ): Promise<TerminalBridgeCollateralStallReconciliation> {
    return withStoreWriterLeaseAsync(storeDir, async () =>
      this.#reconcileCollateralLocked(storeDir, conversationId));
  }

  #reconcileCollateralLocked(
    storeDir: string,
    conversationId?: string
  ): TerminalBridgeCollateralStallReconciliation {
    const reservedSourceTurnIds = new Set(
      listDeferredForegroundTransfers(storeDir)
        .filter((transfer) =>
          transfer.version === 2 &&
          transfer.source_kind === "candidate_rollout_quiescent" &&
          !FINAL_DEFERRED_STATUSES.has(transfer.status)
        )
        .flatMap((transfer) =>
          (transfer.source_turn_history ?? []).map((turn) => turn.turn_id)
        )
    );
    const candidates = listConversations(storeDir).filter((conversation) => {
      const takeover = takeoverFor(conversation);
      return (
        conversationId === undefined ||
        conversation.conversation_id === conversationId
      ) &&
        !reservedSourceTurnIds.has(turnIdForConversation(conversation)) &&
        conversation.status === "stalled" &&
        isRecord(takeover?.terminal_bridge_uncertain_dispatch_fence);
    });
    const result: TerminalBridgeCollateralStallReconciliation = {
      checked: candidates.length,
      repaired: 0,
      skipped: 0,
      errors: [],
      items: []
    };
    for (const listed of candidates) {
      this.#reconcileCollateralCandidate(storeDir, listed, result);
    }
    return result;
  }

  #reconcileCollateralCandidate(
    storeDir: string,
    listed: Conversation,
    result: TerminalBridgeCollateralStallReconciliation
  ): void {
    const statePath = nonBlankString(listed.state_path);
    if (!statePath) {
      result.skipped += 1;
      return;
    }
    let release: Release | undefined;
    try {
      release = this.#stateFileLock.acquire(`${statePath}.lock`);
      const current = loadState(statePath);
      const evidence = this.#exactCollateralRepairEvidence(current, storeDir);
      if (!evidence) {
        result.skipped += 1;
        return;
      }
      const repaired = this.#persistCollateralRepair(
        statePath,
        current,
        evidence
      );
      result.repaired += 1;
      result.items.push(repaired);
    } catch (error) {
      result.skipped += 1;
      const reason = error instanceof Error ? error.message : String(error);
      result.errors.push(`${listed.conversation_id}: ${reason}`);
      result.items.push({
        conversation_id: listed.conversation_id,
        status: "error",
        reason
      });
    } finally {
      release?.();
    }
  }

  #persistCollateralRepair(
    statePath: string,
    current: Conversation,
    evidence: TerminalBridgeCollateralRepairEvidence
  ): Record<string, unknown> {
    const takeover = { ...takeoverFor(current) };
    delete takeover.terminal_bridge_uncertain_dispatch_fence;
    const repairedAt = cliNow().toISOString();
    takeover.terminal_bridge_collateral_stall_repair = {
      repaired_at: repairedAt,
      uncertain_message_id: evidence.uncertainMessageId,
      uncertain_owner_conversation_id: evidence.ownerConversationId,
      restored_status: evidence.restoredStatus,
      evidence:
        "foreign_uncertain_fence+completion_claim+delivered_callback+closed_owner"
    };
    const conversation: Conversation = {
      ...current,
      status: evidence.restoredStatus,
      native_session_takeover: takeover,
      updated_at: repairedAt
    };
    delete conversation.stalled_at;
    delete conversation.stalled_reason;
    saveState(statePath, conversation);
    const eventWarning = this.#appendCollateralRepairEvent(
      statePath,
      current,
      evidence,
      repairedAt
    );
    return {
      conversation_id: current.conversation_id,
      status: "repaired",
      reason: "legacy_terminal_bridge_collateral_stall",
      uncertain_message_id: evidence.uncertainMessageId,
      uncertain_owner_conversation_id: evidence.ownerConversationId,
      restored_status: evidence.restoredStatus,
      ...(eventWarning ? { event_warning: eventWarning } : {})
    };
  }

  #appendCollateralRepairEvent(
    statePath: string,
    current: Conversation,
    evidence: TerminalBridgeCollateralRepairEvidence,
    repairedAt: string
  ): string | undefined {
    try {
      appendEvent(
        nonBlankString(current.event_log_path) ??
          logPathForStatePath(statePath),
        {
          ts: repairedAt,
          conversation_id: current.conversation_id,
          event: "terminal_bridge_collateral_stall_repaired",
          uncertain_message_id: evidence.uncertainMessageId,
          uncertain_owner_conversation_id: evidence.ownerConversationId,
          previous_status: "stalled",
          restored_status: evidence.restoredStatus,
          evidence:
            "foreign_uncertain_fence+completion_claim+delivered_callback+closed_owner"
        }
      );
      return undefined;
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      cliRuntimeLog(
        "warn",
        "terminal_bridge_collateral_stall_repair_event_failed",
        {
          conversation_id: current.conversation_id,
          uncertain_message_id: evidence.uncertainMessageId,
          error: warning
        }
      );
      return warning;
    }
  }

  #recordApprovalNotification(
    input: ApprovalRecordRequest & TerminalMonitorStatePaths
  ) {
    const storeDir = pathsForConversationDir(path.dirname(input.statePath))
      .storeDir;
    return withStoreWriterLease(storeDir, () => {
      const release = this.#stateFileLock.acquire(`${input.statePath}.lock`);
      try {
        const conversation = loadState(input.statePath);
        if (!this.#approvalSnapshotMatches(conversation, input)) {
          return {
            conversation,
            duplicate: false,
            stale: true,
            recorded: undefined
          };
        }
        return this.#recordMatchingApproval(
          this.#approvalPersistenceContext(conversation, input)
        );
      } finally {
        release();
      }
    });
  }

  #approvalSnapshotMatches(
    conversation: Conversation,
    input: ApprovalRecordRequest
  ): boolean {
    const takeover = takeoverFor(conversation);
    const currentControl = terminalControlFromTakeover(takeover);
    return isWaitingForAgent(conversation.status) &&
      conversation.conversation_id === input.expectedConversation.conversationId &&
      conversation.status === input.expectedConversation.status &&
      conversation.updated_at === input.expectedConversation.updatedAt &&
      takeover?.terminal_bridge === true &&
      nonBlankString(takeover.terminal_bridge_message_id) ===
        input.expectedConversation.messageId &&
      currentControl !== undefined &&
      terminalControlsShareIncarnation(currentControl, input.terminalControl);
  }

  #approvalPersistenceContext(
    conversation: Conversation,
    input: ApprovalRecordRequest & TerminalMonitorStatePaths
  ): ApprovalPersistenceContext {
    const nativeTakeover = { ...takeoverFor(conversation) };
    const screen = isRecord(input.terminalStatus.screen)
      ? input.terminalStatus.screen
      : undefined;
    const approvalScreenDigest = nonBlankString(screen?.digest);
    const previousApproval = isRecord(nativeTakeover.terminal_bridge_approval)
      ? nativeTakeover.terminal_bridge_approval
      : undefined;
    const previousNotifiedAt = validTerminalMonitorTimestampMs(
      previousApproval?.notified_at
    );
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    const callbackMessage = isRecord(callbackDelivery?.message)
      ? callbackDelivery.message
      : undefined;
    const previousCallbackMessageId = nonBlankString(
      previousApproval?.callback_message_id
    );
    const matchingApprovalOutbox =
      callbackDelivery?.kind === "approval_notification" &&
      previousCallbackMessageId !== undefined &&
      callbackMessage?.id === previousCallbackMessageId;
    const deliveryStatus = nonBlankString(callbackDelivery?.status);
    const deliveryAttempts = Number(callbackDelivery?.attempts ?? 0);
    const conflictingActiveOutbox = !matchingApprovalOutbox && (
      deliveryStatus === "pending" ||
      (
        deliveryStatus === "failed" &&
        Number.isFinite(deliveryAttempts) &&
        deliveryAttempts <= this.#dependencies.runtime.callbackRetryLimit
      )
    );
    return {
      input,
      conversation,
      nativeTakeover,
      approvalScreenDigest,
      previousApproval,
      previousNotifiedAt,
      previousCallbackMessageId,
      matchingApprovalOutbox,
      conflictingActiveOutbox
    };
  }

  #recordMatchingApproval(context: ApprovalPersistenceContext) {
    const duplicate =
      context.previousApproval?.fingerprint === context.input.fingerprint &&
      context.previousNotifiedAt !== undefined &&
      cliNowMs() - context.previousNotifiedAt <=
        this.#dependencies.runtime.approvalTtlMs;
    if (!duplicate) {
      return this.#recordNewApproval(context);
    }
    if (context.conflictingActiveOutbox) {
      return {
        conversation: context.conversation,
        duplicate: false,
        stale: true,
        deferred: true,
        previousApproval: context.previousApproval,
        recorded: undefined
      };
    }
    if (!context.matchingApprovalOutbox) {
      return this.#recoverApprovalOutbox(context);
    }
    return {
      conversation: context.conversation,
      duplicate: true,
      stale: false,
      previousApproval: context.previousApproval,
      recorded: undefined
    };
  }

  #recoverApprovalOutbox(context: ApprovalPersistenceContext) {
    const messageId = context.previousCallbackMessageId ?? `msg-${randomUUID()}`;
    const messageTs = nonBlankString(
      context.previousApproval?.callback_message_ts
    ) ?? nonBlankString(context.previousApproval?.notified_at) ??
      cliNow().toISOString();
    const conversation = context.previousCallbackMessageId
      ? context.conversation
      : {
          ...context.conversation,
          native_session_takeover: {
            ...context.nativeTakeover,
            terminal_bridge_approval: {
              ...context.previousApproval,
              callback_message_id: messageId,
              callback_message_ts: messageTs
            }
          }
        };
    if (!context.previousCallbackMessageId) {
      saveState(context.input.statePath, conversation);
    }
    const recorded = context.input.onRecorded(conversation, {
      recoverMissingOutbox: true
    });
    appendEvent(context.input.logPath, {
      ts: cliNow().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_approval_notification_outbox_recovered",
      terminal_control: context.input.terminalControl,
      fingerprint: context.input.fingerprint,
      callback_message_id: messageId
    });
    return {
      conversation: recorded.prepared?.conversation ?? conversation,
      duplicate: false,
      recovered: true,
      stale: false,
      previousApproval: context.previousApproval,
      recorded
    };
  }

  #recordNewApproval(context: ApprovalPersistenceContext) {
    const now = cliNow().toISOString();
    const callbackMessageId = `msg-${randomUUID()}`;
    const conversation: Conversation = {
      ...context.conversation,
      native_session_takeover: {
        ...context.nativeTakeover,
        terminal_bridge_approval: {
          fingerprint: context.input.fingerprint,
          screen_digest: context.approvalScreenDigest,
          notified_at: now,
          terminal_control: context.input.terminalControl,
          approval_state: context.input.terminalStatus.approval_state,
          callback_message_id: callbackMessageId,
          callback_message_ts: now
        }
      },
      updated_at: now
    };
    saveState(context.input.statePath, conversation);
    appendEvent(context.input.logPath, {
      ts: now,
      conversation_id: context.conversation.conversation_id,
      event: "terminal_bridge_approval_notification_recorded",
      terminal_control: context.input.terminalControl,
      fingerprint: context.input.fingerprint,
      screen_digest: context.approvalScreenDigest
    });
    const recorded = context.input.onRecorded(conversation);
    return {
      conversation: recorded.prepared?.conversation ?? conversation,
      duplicate: false,
      stale: false,
      recorded
    };
  }

  #markApprovalPromptCleared(input: {
    statePath: string;
    logPath: string;
    expectedConversationId: string;
    expectedMessageId?: string;
  }): { conversation: Conversation; marked: boolean } {
    const storeDir = pathsForConversationDir(path.dirname(input.statePath))
      .storeDir;
    return withStoreWriterLease(storeDir, () => {
      const release = this.#stateFileLock.acquire(`${input.statePath}.lock`);
      try {
        const conversation = loadState(input.statePath);
        const takeover = takeoverFor(conversation);
        if (!approvalCanBeCleared(conversation, takeover, input)) {
          return { conversation, marked: false };
        }
        const clearedAt = cliNow().toISOString();
        const nextConversation: Conversation = {
          ...conversation,
          native_session_takeover: {
            ...takeover,
            terminal_bridge_last_approval_prompt_cleared_at: clearedAt
          },
          updated_at: clearedAt
        };
        saveState(input.statePath, nextConversation);
        appendEvent(input.logPath, {
          ts: clearedAt,
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_approval_prompt_cleared",
          terminal_bridge_message_id: input.expectedMessageId
        });
        return { conversation: nextConversation, marked: true };
      } finally {
        release();
      }
    });
  }

  #persistActivity(input: TerminalMonitorActivityInput): Conversation {
    const storeDir = pathsForConversationDir(path.dirname(input.statePath))
      .storeDir;
    return withStoreWriterLease(storeDir, () => {
      const release = this.#stateFileLock.acquire(`${input.statePath}.lock`);
      try {
        const current = loadState(input.statePath);
        if (!isWaitingForAgent(current.status)) {
          return current;
        }
        const expectedTakeover = takeoverFor(input.conversation);
        const takeover = takeoverFor(current);
        if (takeover.terminal_bridge_message_id !==
            expectedTakeover.terminal_bridge_message_id) {
          return current;
        }
        return this.#persistMatchingActivity(input, current, takeover);
      } finally {
        release();
      }
    });
  }

  #persistMatchingActivity(
    input: TerminalMonitorActivityInput,
    current: Conversation,
    takeover: Record<string, unknown>
  ): Conversation {
    const previousActivityAtMs = validTerminalMonitorTimestampMs(
      takeover.terminal_bridge_last_activity_at
    );
    const observedAt = new Date(input.observedAtMs).toISOString();
    const inactivityDeadlineAt =
      Number.isFinite(input.timeoutMinutes) && input.timeoutMinutes > 0
        ? new Date(
            input.observedAtMs + input.timeoutMinutes * 60 * 1000
          ).toISOString()
        : undefined;
    const nextConversation: Conversation = {
      ...current,
      native_session_takeover: {
        ...takeover,
        terminal_bridge_last_activity_at: observedAt,
        terminal_bridge_last_activity_reason: input.reason,
        terminal_bridge_inactivity_deadline_at: inactivityDeadlineAt,
        terminal_bridge_inactivity_timeout_minutes: input.timeoutMinutes,
        terminal_bridge_hard_timeout_minutes: input.hardTimeoutMinutes
      },
      updated_at: observedAt
    };
    saveState(input.statePath, nextConversation);
    appendEvent(input.logPath, {
      ts: observedAt,
      conversation_id: current.conversation_id,
      event: "terminal_bridge_activity_observed",
      reason: input.reason,
      last_activity_at: observedAt,
      terminal_activity_state: input.activityState
    });
    if (inactivityDeadlineAt) {
      appendEvent(input.logPath, {
        ts: observedAt,
        conversation_id: current.conversation_id,
        event: "terminal_bridge_inactivity_deadline_extended",
        reason: input.reason,
        previous_last_activity_at: previousActivityAtMs === undefined
          ? null
          : new Date(previousActivityAtMs).toISOString(),
        last_activity_at: observedAt,
        inactivity_deadline_at: inactivityDeadlineAt,
        agent_timeout_minutes: input.timeoutMinutes
      });
    }
    return nextConversation;
  }

  #persistDetectorDiagnostic(input: {
    statePath: string;
    logPath: string;
    expectedConversationId: string;
    expectedMessageId?: string;
    limitation?: string;
    fingerprint?: string;
  }) {
    const storeDir = pathsForConversationDir(path.dirname(input.statePath))
      .storeDir;
    return withStoreWriterLease(storeDir, () => {
      const release = this.#stateFileLock.acquire(`${input.statePath}.lock`);
      try {
        const conversation = loadState(input.statePath);
        const takeover = takeoverFor(conversation);
        if (
          conversation.conversation_id !== input.expectedConversationId ||
          nonBlankString(takeover.terminal_bridge_message_id) !==
            input.expectedMessageId
        ) {
          return {
            persisted: false as const,
            conversation,
            reason: "terminal_bridge_task_replaced"
          };
        }
        return this.#persistMatchingDetectorDiagnostic(
          input,
          conversation,
          takeover
        );
      } finally {
        release();
      }
    });
  }

  #persistMatchingDetectorDiagnostic(
    input: {
      statePath: string;
      logPath: string;
      expectedMessageId?: string;
      limitation?: string;
      fingerprint?: string;
    },
    conversation: Conversation,
    takeover: Record<string, unknown>
  ) {
    const existing = isRecord(takeover.terminal_bridge_detector_diagnostic)
      ? takeover.terminal_bridge_detector_diagnostic
      : undefined;
    const now = cliNow().toISOString();
    const nextDiagnostic = detectorDiagnostic(input, existing, now);
    if (!nextDiagnostic || sameDetectorDiagnostic(existing, nextDiagnostic)) {
      return {
        persisted: false as const,
        conversation,
        diagnostic: existing,
        reason: "detector_diagnostic_unchanged"
      };
    }
    const nextConversation: Conversation = {
      ...conversation,
      native_session_takeover: {
        ...takeover,
        terminal_bridge_detector_diagnostic: nextDiagnostic
      },
      updated_at: now
    };
    saveState(input.statePath, nextConversation);
    this.#recordDetectorDiagnostic(
      input,
      conversation,
      nextDiagnostic,
      now
    );
    return {
      persisted: true as const,
      conversation: nextConversation,
      diagnostic: nextDiagnostic
    };
  }

  #recordDetectorDiagnostic(
    input: { logPath: string; expectedMessageId?: string },
    conversation: Conversation,
    diagnostic: Record<string, unknown>,
    now: string
  ): void {
    const event = diagnostic.status === "limited"
      ? "terminal_bridge_completion_detector_limited"
      : "terminal_bridge_completion_detector_recovered";
    appendEvent(input.logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event,
      terminal_bridge_message_id: input.expectedMessageId,
      detector_source: diagnostic.source,
      diagnostic_fingerprint: diagnostic.fingerprint,
      detail: diagnostic.status === "limited" ? diagnostic.detail : undefined
    });
    cliRuntimeLog(diagnostic.status === "limited" ? "warn" : "info", event, {
      conversation_id: conversation.conversation_id,
      terminal_bridge_message_id: input.expectedMessageId,
      detector_source: diagnostic.source,
      diagnostic_fingerprint: diagnostic.fingerprint
    });
  }

  #markStalled(input: {
    statePath: string;
    logPath: string;
    reason: string;
    detail: Record<string, unknown>;
  }): Conversation | undefined {
    const storeDir = pathsForConversationDir(path.dirname(input.statePath))
      .storeDir;
    let stalledConversation: Conversation | undefined;
    let stalledMessage: ReturnType<typeof createMessage> | undefined;
    let unchangedConversation: Conversation | undefined;
    withStoreWriterLease(storeDir, () => {
      const release = this.#stateFileLock.acquire(`${input.statePath}.lock`);
      try {
        const conversation = loadState(input.statePath);
        if (!isWaitingForAgent(conversation.status)) {
          cliRuntimeLog("info", "executor_monitor_finished", {
            conversation_id: conversation.conversation_id,
            status: conversation.status,
            reason: "conversation_changed_before_stall"
          });
          unchangedConversation = conversation;
          return;
        }
        const stalled = this.#stalledState(conversation, input);
        stalledConversation = stalled.conversation;
        stalledMessage = stalled.message;
      } finally {
        release();
      }
    });
    if (unchangedConversation) {
      return unchangedConversation;
    }
    if (stalledConversation && stalledMessage) {
      this.#deliverStalledNotification({
        statePath: input.statePath,
        logPath: input.logPath,
        conversation: stalledConversation,
        message: stalledMessage
      });
    }
    return stalledConversation;
  }

  #stalledState(
    conversation: Conversation,
    input: { statePath: string; logPath: string; reason: string;
      detail: Record<string, unknown> }
  ): { conversation: Conversation; message?: ReturnType<typeof createMessage> } {
    const now = cliNow().toISOString();
    const executor = executorForConversation(conversation);
    const terminalBridge = terminalBridgeEnabled(conversation);
    const shouldNotify = Boolean(
      conversation.gateway_method && !conversation.stalled_notification_sent_at
    );
    const message = shouldNotify
      ? stalledMessage(conversation, input.reason, executor, terminalBridge)
      : undefined;
    const nextConversation: Conversation = {
      ...conversation,
      status: "stalled",
      stalled_at: now,
      stalled_reason: input.reason,
      stalled_notification_sent_at: shouldNotify
        ? now
        : conversation.stalled_notification_sent_at,
      stalled_notification_message_id:
        message?.id ?? conversation.stalled_notification_message_id,
      updated_at: now
    };
    saveState(input.statePath, nextConversation);
    appendEvent(input.logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event: "conversation_stalled",
      status: "stalled",
      reason: input.reason,
      ...input.detail
    });
    cliRuntimeLog("warn", "conversation_stalled", {
      conversation_id: conversation.conversation_id,
      agent: executorForConversation(conversation).kind,
      executor_session: executorForConversation(conversation).session,
      state_path: input.statePath,
      event_log_path: input.logPath,
      reason: input.reason,
      ...input.detail
    });
    return { conversation: nextConversation, message };
  }

  #deliverStalledNotification(input: {
    statePath: string;
    logPath: string;
    conversation: Conversation;
    message: ReturnType<typeof createMessage>;
    eventPrefix?: string;
  }): void {
    if (!input.conversation.gateway_method) {
      return;
    }
    const eventPrefix = input.eventPrefix ?? "stalled";
    const token = input.conversation.gateway_token;
    const gatewayUrl = token ? input.conversation.gateway_url : undefined;
    const delivery = this.#dependencies.callbacks.deliverGatewayMethod({
      method: input.conversation.gateway_method,
      openclawBin: input.conversation.openclaw_bin,
      gatewayUrl,
      token,
      sessionKey: input.conversation.gateway_session ??
        input.conversation.openclaw_session,
      statePath: input.statePath,
      logPath: input.logPath,
      conversation: input.conversation,
      message: input.message
    });
    recordStalledDelivery(
      input,
      eventPrefix,
      "gateway_method_delivery",
      delivery,
      true
    );
    if (delivery.status !== 0) {
      return;
    }
    const payload = parseOptionalJson(delivery.stdout);
    const chatSend = isRecord(payload?.chat_send)
      ? payload.chat_send
      : undefined;
    if (!chatSend) {
      return;
    }
    const chatDelivery = this.#dependencies.callbacks.deliverChatSend({
      openclawBin: input.conversation.openclaw_bin,
      gatewayUrl,
      token,
      params: chatSend
    });
    recordStalledDelivery(
      input,
      eventPrefix,
      "chat_send_delivery",
      chatDelivery,
      false
    );
  }
}

function monitorRuntimePort(): TerminalMonitorServicePorts["runtime"] {
  return {
    now: cliNow,
    nowMs: cliNowMs,
    pid: cliPid,
    sleep: cliSleepSync,
    log: cliRuntimeLog,
    exitAfterApprovalCallback: () =>
      cliEnv().AKK_TEST_EXIT_AFTER_APPROVAL_CALLBACK_DELIVERED === "1",
    exit: cliExit
  };
}

function takeoverFor(conversation: Conversation): Record<string, unknown> {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
}

function isWaitingForAgent(status: ConversationStatus): boolean {
  return ["created", "running", "waiting_for_agent", "cancelling"]
    .includes(status);
}

function unprepared(reason: string): TerminalMonitorLaunchPreparation {
  return { prepared: false, alreadyRunning: false, reason };
}

function approvalCanBeCleared(
  conversation: Conversation,
  takeover: Record<string, unknown>,
  input: { expectedConversationId: string; expectedMessageId?: string }
): boolean {
  return conversation.conversation_id === input.expectedConversationId &&
    conversation.status === "waiting_for_agent" &&
    takeover.terminal_bridge === true &&
    nonBlankString(takeover.terminal_bridge_message_id) ===
      input.expectedMessageId &&
    nonBlankString(takeover.terminal_bridge_last_approval_message_id) ===
      input.expectedMessageId &&
    validTerminalMonitorTimestampMs(
      takeover.terminal_bridge_approval_resolved_at
    ) !== undefined &&
    validTerminalMonitorTimestampMs(
      takeover.terminal_bridge_last_approval_prompt_cleared_at
    ) === undefined;
}

function detectorDiagnostic(
  input: { limitation?: string; fingerprint?: string },
  existing: Record<string, unknown> | undefined,
  now: string
): Record<string, unknown> | undefined {
  if (input.limitation && input.fingerprint) {
    return {
      status: "limited",
      source: "terminal_completion_detector",
      fingerprint: input.fingerprint,
      detail: truncateText(redactString(input.limitation), 1000),
      observed_at: now
    };
  }
  return existing && nonBlankString(existing.status) === "limited"
    ? { ...existing, status: "recovered", recovered_at: now }
    : undefined;
}

function sameDetectorDiagnostic(
  existing: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): boolean {
  return nonBlankString(existing?.status) === nonBlankString(next.status) &&
    nonBlankString(existing?.fingerprint) === nonBlankString(next.fingerprint);
}

function terminalBridgeApprovalInstructions(input: {
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  terminalStatus: TerminalBridgeStatus;
}): string {
  const approval: Record<string, unknown> =
    isRecord(input.terminalStatus.approval_state)
    ? input.terminalStatus.approval_state
    : {};
  const screen: Record<string, unknown> = isRecord(input.terminalStatus.screen)
    ? input.terminalStatus.screen
    : {};
  const executor = executorForConversation(input.conversation);
  const agentName = executorDefinitionForKind(executor.kind).displayName;
  const label = nonBlankString(approval.label) ??
    `the current ${agentName} approval prompt`;
  const keys = Array.isArray(approval.keys)
    ? approval.keys.filter((value): value is string => typeof value === "string")
    : [];
  const decisionMode = nonBlankString(approval.decision_mode);
  const keyDescription = keys.length > 0
    ? keys.join(" then ")
    : nonBlankString(approval.key) ?? "the detected approve key sequence";
  const fingerprint = nonBlankString(approval.fingerprint);
  const promptKind = nonBlankString(approval.prompt_kind);
  const command = nonBlankString(approval.command);
  const toolName = nonBlankString(approval.tool_name);
  const requestDetail = nonBlankString(approval.request_detail);
  const requestId = nonBlankString(approval.request_id);
  const excerpt = nonBlankString(screen.excerpt) ??
    "(No terminal excerpt was available.)";
  const directReview = executor.kind === "claude" && decisionMode === "keys";
  return approvalInstructionLines({
    ...input,
    approval,
    agentName,
    label,
    keyDescription,
    fingerprint,
    promptKind,
    command,
    toolName,
    requestDetail,
    requestId,
    excerpt,
    directReview
  }).filter((line): line is string => line !== undefined).join("\n");
}

function approvalInstructionLines(input: {
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  approval: Record<string, unknown>;
  agentName: string;
  label: string;
  keyDescription: string;
  fingerprint?: string;
  promptKind?: string;
  command?: string;
  toolName?: string;
  requestDetail?: string;
  requestId?: string;
  excerpt: string;
  directReview: boolean;
}): Array<string | undefined> {
  return [
    `${input.agentName} is waiting for approval in a terminal-controlled AKK session.`,
    "",
    `Conversation: ${input.conversation.conversation_id}`,
    `Terminal: ${input.terminalControl.kind}:${input.terminalControl.target}`,
    `Approval option: ${input.label} (${input.keyDescription})`,
    input.promptKind ? `Request kind: ${input.promptKind}` : undefined,
    input.toolName ? `Tool: ${input.toolName}` : undefined,
    input.requestDetail ? `Request: ${input.requestDetail}` : undefined,
    input.command ? `Command: ${input.command}` : undefined,
    input.requestId ? `Request id: ${input.requestId}` : undefined,
    "",
    "Safe terminal excerpt:",
    "```text",
    input.excerpt,
    "```",
    "",
    input.directReview
      ? `Before asking for approval, have the user personally inspect the live ${input.terminalControl.kind} pane ${input.terminalControl.target}.`
      : undefined,
    input.directReview
      ? "This hookless callback intentionally omits raw command details; do not approve from the hash or summary alone."
      : undefined,
    input.directReview ? "" : undefined,
    `Ask the user whether to approve or deny this ${input.agentName} request.`,
    "",
    "If the user approves, call `agent_knock_knock_approve` with:",
    `- conversation_id: ${input.conversation.conversation_id}`,
    `- expected_approval_fingerprint: ${input.fingerprint ?? "(missing; refresh status before approval)"}`,
    "",
    "Equivalent user command: `AKK approve " + input.conversation.conversation_id +
      (input.fingerprint
        ? ` --expected-approval-fingerprint ${input.fingerprint}`
        : "") + "`",
    "",
    "If the user denies or wants to stop this request, call `agent_knock_knock_cancel` with:",
    `- conversation_id: ${input.conversation.conversation_id}`,
    "",
    "Equivalent user command: `AKK cancel " + input.conversation.conversation_id + "`",
    "",
    "Do not use raw tmux, shell, or manual key presses for this approval. Do not approve without explicit user confirmation."
  ];
}

function stalledMessage(
  conversation: Conversation,
  reason: string,
  executor: ReturnType<typeof executorForConversation>,
  terminalBridge: boolean
): ReturnType<typeof createMessage> {
  return createMessage({
    conversation,
    from: executor.actor,
    to: "openclaw",
    type: "error",
    requiresResponse: false,
    body: [
      `AKK marked this ${executor.display_name} task as stalled: ${reason}.`,
      "",
      `Turn: ${turnIdForConversation(conversation)}`,
      `AKK session: ${sessionIdForConversation(conversation)}`,
      `Agent session: ${executor.session}`,
      terminalBridge
        ? `Use \`AKK status --turn ${turnIdForConversation(conversation)}\` for details, \`AKK renew --turn ${turnIdForConversation(conversation)}\` to resume monitoring in this Turn, or \`AKK close --turn ${turnIdForConversation(conversation)}\` to close it. Start any independent retry with \`AKK send --session ${sessionIdForConversation(conversation)}\`.`
        : `Use \`AKK status --turn ${turnIdForConversation(conversation)}\` for details or \`AKK close --turn ${turnIdForConversation(conversation)}\` to close this Turn.`
    ].join("\n")
  });
}

type StalledNotificationInput = {
  logPath: string;
  conversation: Conversation;
  message: ReturnType<typeof createMessage>;
};
interface CallbackProcessDelivery {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

function recordStalledDelivery(
  input: StalledNotificationInput,
  eventPrefix: string,
  suffix: "gateway_method_delivery" | "chat_send_delivery",
  delivery: CallbackProcessDelivery,
  includeMethod: boolean
): void {
  appendEvent(input.logPath, {
    ts: cliNow().toISOString(),
    conversation_id: input.conversation.conversation_id,
    event: `${eventPrefix}_${suffix}`,
    ...(includeMethod ? { method: input.conversation.gateway_method } : {}),
    message_id: input.message.id,
    status: delivery.status,
    stdout: redactString(delivery.stdout),
    stderr: redactString(delivery.stderr)
  });
  cliRuntimeLog("info", `${eventPrefix}_${suffix}`, {
    conversation_id: input.conversation.conversation_id,
    ...(includeMethod ? { method: input.conversation.gateway_method } : {}),
    message_id: input.message.id,
    status: delivery.status,
    failure_kind: classifyProcessFailure(delivery),
    stdout: textSummary(delivery.stdout),
    stderr: textSummary(delivery.stderr)
  });
}

function parseOptionalJson(text: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(String(text));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function textSummary(text: unknown, maxLength = 240) {
  const value = String(text ?? "");
  return {
    length: value.length,
    preview: value ? value.slice(0, maxLength) : undefined
  };
}

function truncateText(value: unknown, maxLength: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function classifyProcessFailure(result: CallbackProcessDelivery) {
  const status = result.status ?? 0;
  const combined = [result.error?.message, result.stderr, result.stdout]
    .filter(Boolean).join("\n").toLowerCase();
  if (!combined && status === 0) return undefined;
  if (isRemoteCompactStreamDisconnect(combined)) {
    return "transient_remote_compact_failure";
  }
  if (combined.includes("agent needs reconnect") ||
      combined.includes("internal error")) {
    return "agent_reconnect_required";
  }
  if (combined.includes("permission denied") ||
      combined.includes("operation not permitted")) return "permission_denied";
  if (combined.includes("sandbox") || combined.includes("outside workspace")) {
    return "sandbox_denied";
  }
  if (combined.includes("timed out") || combined.includes("timeout")) {
    return "timeout";
  }
  return status !== 0 ? "nonzero_exit" : undefined;
}

function isRemoteCompactStreamDisconnect(text: unknown): boolean {
  const value = String(text ?? "").toLowerCase();
  return value.includes("error running remote compact task") &&
    value.includes("stream disconnected") &&
    value.includes("/codex/responses/compact");
}
