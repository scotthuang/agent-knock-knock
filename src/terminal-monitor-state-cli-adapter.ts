import path from "node:path";
import { loadDeferredForegroundTransfer } from "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from "./deferred-foreground-transfer-policy.js";
import {
  executorForConversation,
  createMessage,
  isWaitingForAgentStatus,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import { retireAbsentAsyncQuestionNotification } from "./terminal-monitor-interaction-store.js";
import { redactString } from "./runtime-log.js";
import {
  appendEvent,
  loadState,
  logPathForStatePath,
  pathsForConversationDir,
  saveState,
  statePathForConversationId,
  withStoreWriterLease,
  withStoreWriterLeaseAsync
} from "./store.js";
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
import { terminalControlFromTakeover } from "./terminal-runtime-cli-adapter.js";
import { terminalControlsShareIncarnation } from "./terminal-authority-policy.js";
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
  recordMonitorInteractionNotification,
  repairLaggingAcceptedMonitorAuthority,
  recoverPreparedMonitorSubmission,
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
import type { PreparedCallback } from "./callback-outbox-service.js";
import { callbackExpectedForConversation } from "./callback-route-authority.js";
import { isRecord, nonBlankString } from "./value-guards.js";
import {
  type MonitorCliOptions,
  type TerminalMonitorStateCliDependencies,
  type TerminalMonitorStateCliAdapter,
  type TerminalMonitorLaunchPreparation,
  takeoverFor
} from "./terminal-monitor-state-contract.js";
import { TerminalMonitorStartupRecovery } from "./terminal-monitor-startup-recovery.js";
import { TerminalMonitorCollateralRecovery } from "./terminal-monitor-collateral-recovery.js";
import {
  TerminalMonitorAttentionStore,
  terminalBridgeApprovalInstructions
} from "./terminal-monitor-attention-store.js";

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
  readonly #startup: TerminalMonitorStartupRecovery;
  readonly #collateral: TerminalMonitorCollateralRecovery;
  readonly #attention: TerminalMonitorAttentionStore;

  readonly #dependencies: TerminalMonitorStateCliDependencies;

  readonly #stateFileLock = createFileLockCliAdapter({
    now: cliNow,
    nowMs: cliNowMs,
    pid: cliPid,
    sleepSync: cliSleepSync
  });

  constructor(dependencies: TerminalMonitorStateCliDependencies) {
    this.#dependencies = dependencies;
    this.#startup = new TerminalMonitorStartupRecovery(dependencies, this.#stateFileLock);
    this.#collateral = new TerminalMonitorCollateralRecovery(dependencies, this.#stateFileLock);
    this.#attention = new TerminalMonitorAttentionStore(dependencies, this.#stateFileLock);
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
          () => {
            const lifecycle = this.#dependencies.callbacks.reconcileDelivery({
              statePath: paths.statePath,
              logPath: paths.logPath,
              delayMs
            });
            const notification = this.#dependencies.callbacks.reconcileDelivery({
              statePath: paths.statePath,
              logPath: paths.logPath,
              delayMs,
              callbackOutboxLane: "notification"
            });
            return lifecycle.handled ? lifecycle : notification;
          }
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
        recoverSubmissionRetry: (storeDir, conversation, paths) =>
          this.#startup.recoverSubmissionRetry(
            storeDir,
            conversation,
            paths
          ),
        recoverDeferred: (storeDir, conversation, paths) =>
          this.#startup.recoverDeferred(options, storeDir, conversation, paths),
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
          if (!transfer || isFinalDeferredForegroundTransferStatus(transfer.status)) {
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

  prepareLaunch(
    input: Parameters<TerminalMonitorStateCliAdapter["prepareLaunch"]>[0]
  ): TerminalMonitorLaunchPreparation {
    const storeDir = pathsForConversationDir(path.dirname(input.statePath))
      .storeDir;
    return withStoreWriterLease(storeDir, () => {
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
    });
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
        retireAsyncInteractionNotification: (request) => retireAbsentAsyncQuestionNotification({
          ...request, statePath: input.statePath, logPath: input.logPath
        }),
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
              record: (recordRequest) => this.#attention.recordApprovalNotification({
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
          }),
        recordInteractionNotification: (request) =>
          recordMonitorInteractionNotification({
            ...request,
            ports: {
              record: (recordRequest) => this.#attention.recordInteractionNotification({
                ...recordRequest,
                statePath: input.statePath,
                logPath: input.logPath
              }),
              prepare: (prepareRequest) =>
                this.#dependencies.callbacks.prepareInteractionNotification({
                  options: { ...input.options, statePath: input.statePath },
                  statePath: input.statePath,
                  logPath: input.logPath,
                  ...prepareRequest
                })
            }
          })
      },
      authority: {
        initialize: () => { bridge(); },
        terminalControl: (conversation) =>
          terminalControlFromTakeover(takeoverFor(conversation)),
        submission: terminalBridgeSubmission,
        isWaitingForAgent: isWaitingForAgentStatus,
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
                this.#collateral.stallOther({
                  storeDir: stateStoreDir(),
                  ...stallRequest
                });
              }
            }
          }),
        repairLaggingAcceptedAuthority: (request) =>
          repairLaggingAcceptedMonitorAuthority({
            ...request,
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
              reconcileLedger:
                this.#dependencies.dispatch.recovery.reconcilePrepared,
              submission: terminalBridgeSubmission
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
            withWriter: (use) =>
              withStoreWriterLeaseAsync(stateStoreDir(), use),
            acquireState: () =>
              this.#stateFileLock.acquire(`${input.statePath}.lock`),
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
        if (!isWaitingForAgentStatus(current.status)) {
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
    let stalledNotification: PreparedCallback | undefined;
    let unchangedConversation: Conversation | undefined;
    withStoreWriterLease(storeDir, () => {
      const release = this.#stateFileLock.acquire(`${input.statePath}.lock`);
      try {
        const conversation = loadState(input.statePath);
        if (!isWaitingForAgentStatus(conversation.status)) {
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
        stalledNotification = stalled.prepared;
      } finally {
        release();
      }
    });
    if (unchangedConversation) {
      return unchangedConversation;
    }
    if (stalledNotification) {
      try {
        stalledConversation = this.#dependencies.callbacks.runPrepared(
          stalledNotification,
          { emit: false }
        ).conversation;
      } catch (error) {
        stalledConversation = loadState(input.statePath);
        cliRuntimeLog("warn", "stalled_notification_delivery_failed", {
          conversation_id: stalledConversation.conversation_id,
          message_id: stalledNotification.message.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return stalledConversation;
  }

  #stalledState(
    conversation: Conversation,
    input: { statePath: string; logPath: string; reason: string;
      detail: Record<string, unknown> }
  ): { conversation: Conversation; prepared?: PreparedCallback } {
    const now = cliNow().toISOString();
    const executor = executorForConversation(conversation);
    const terminalBridge = terminalBridgeEnabled(conversation);
    const notificationDelivery = isRecord(
      conversation.callback_notification_delivery
    ) ? conversation.callback_notification_delivery : undefined;
    const shouldNotify = callbackExpectedForConversation(conversation) &&
      !conversation.stalled_notification_sent_at &&
      !["pending", "failed"].includes(
        String(notificationDelivery?.status ?? "")
      );
    const message = shouldNotify
      ? stalledMessage(conversation, input.reason, executor, terminalBridge)
      : undefined;
    const nextConversation: Conversation = {
      ...conversation,
      status: "stalled",
      stalled_at: now,
      stalled_reason: input.reason,
      stalled_notification_message_id:
        message?.id ?? conversation.stalled_notification_message_id,
      updated_at: now
    };
    const prepared = message
      ? this.#dependencies.callbacks.prepareStallNotification({
          options: { statePath: input.statePath },
          statePath: input.statePath,
          logPath: input.logPath,
          conversation: nextConversation,
          message
        }).prepared
      : undefined;
    const persistedConversation = prepared?.conversation ?? nextConversation;
    if (!prepared) {
      saveState(input.statePath, persistedConversation);
    }
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
    return { conversation: persistedConversation, prepared };
  }

  reconcileCollateral(storeDir: string, conversationId?: string) {
    return this.#collateral.reconcileCollateral(storeDir, conversationId);
  }

  stallOther(input: Parameters<TerminalMonitorStateCliAdapter["stallOther"]>[0]) {
    return this.#collateral.stallOther(input);
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

function truncateText(value: unknown, maxLength: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export type { TerminalMonitorStateCliDependencies, TerminalMonitorStateCliAdapter, TerminalMonitorLaunchPreparation } from "./terminal-monitor-state-contract.js";
