// Ordinary terminal dispatch transaction and transport orchestration.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import * as dispatchApplication from "./terminal-dispatch-application.js";
import * as dispatchReceipt from "./terminal-dispatch-receipt.js";
import * as deferredRecoveryAdapter from
  "./deferred-foreground-recovery-cli-adapter.js";
import * as monitorOwner from "./terminal-monitor-ownership-policy.js";
import {
  bindDeferredForegroundApplicationScope
} from "./deferred-foreground-capability.js";
import type { DeferredForegroundApplicationScope } from
  "./deferred-foreground-boundary.js";
import type { DeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import {
  deferredForegroundBoundaryProjection
} from "./deferred-foreground-preparation-cli-adapter.js";
import {
  executorForConversation,
  sessionIdForConversation,
  type AgentMessage,
  type Conversation
} from "./protocol.js";
import { messageEvent, type EventRecord } from "./store.js";
import {
  type TerminalControlRef
} from "./terminal-agent-adapter.js";
import {
  TerminalEnterDispatchNotAttemptedError,
  TerminalInputNotStartedError
} from "./terminal-agent-bridge.js";
import type { TerminalNativeIdentity as NativeAgentSessionIdentity } from
  "./terminal-binding-authority.js";
import {
  isCompleteNativeRollout,
  type CodexPreMaterializationIdentity
} from "./terminal-authority-policy.js";
import type { CodexForegroundProofAuthority } from
  "./terminal-command-foreground-proof.js";
import type {
  TerminalCommandPortView,
  TerminalMonitorProcess
} from "./terminal-command-cli-ports.js";
import {
  prepareTerminalControlSend,
  type PreparedTerminalControlSend,
  type TerminalDispatchPreparationDefaults,
  type TerminalDispatchPreparationPorts
} from "./terminal-command-dispatch-preparation.js";
import type { TerminalControlSendRequest } from
  "./terminal-dispatch-composition.js";
import {
  bindTerminalDispatchCapabilities,
  withExactTerminalDispatchRoute,
  type BoundTerminalDispatchRoute
} from "./terminal-dispatch-capability.js";
import type { TerminalDispatchExecutionService } from
  "./terminal-dispatch-execution.js";
import { sameCanonicalStatePath } from
  "./terminal-dispatch-ledger-codec.js";
import {
  presentTerminalCompleted,
  presentTerminalIdentityFailure,
  presentTerminalUncertain,
  presentTerminalZeroInputAbort as renderTerminalZeroInputAbort
} from "./terminal-dispatch-presenter.js";
import { positiveMilliseconds } from "./cli-command-runtime.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";

export type TerminalDispatchTransportCliPorts = TerminalCommandPortView<
  | "assertDeferredCodexForegroundBindingBoundary"
  | "assertNativeThreadHasExclusiveOwnership"
  | "assertObservedHandoffTransportBoundary"
  | "assertVerifiedEmptyCodexTransportBoundary"
  | "deferredForegroundApplication"
  | "deferredForegroundRecoveryAdapterPorts"
  | "managedSessionStoreDirForConversation"
  | "persistManagedSessionNativeIdentity"
  | "prepareManagedSessionNativeIdentityClaim"
  | "quarantineManagedSessionBinding"
  | "required"
  | "stallOtherTerminalBridgeConversationsForUncertainDispatch"
  | "startTerminalBridgeMonitorForConversation"
  | "terminalBindingLedgerFields"
  | "terminalBridgeRuntimeKey"
  | "terminalControlFromTakeover"
  | "terminalDispatchCapabilityRepositories"
  | "terminalRuntimeIdentityForConversation"
  | "withTerminalBridgeSubmission"
>;

export interface TerminalDispatchTransportRuntime {
  appendEvent(logPath: string, event: EventRecord): void;
  env(): NodeJS.ProcessEnv;
  exit(code: number): never;
  now(): Date;
  pid(): number;
  log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>
  ): void;
}

export interface TerminalDispatchTransportDependencies {
  ports: TerminalDispatchTransportCliPorts;
  prepare: typeof prepareTerminalControlSend;
  preparationPorts: TerminalDispatchPreparationPorts;
  defaults: TerminalDispatchPreparationDefaults & {
    acceptanceTimeoutMs: number;
    acceptancePollIntervalMs: number;
  };
  foregroundProofs: CodexForegroundProofAuthority;
  runtime: TerminalDispatchTransportRuntime;
}

const dispatchTransportContext =
  new AsyncLocalStorage<TerminalDispatchTransportDependencies>();

function dispatchTransportRuntime(): TerminalDispatchTransportDependencies {
  const runtime = dispatchTransportContext.getStore();
  if (!runtime) {
    throw new Error("Terminal dispatch transport runtime is unavailable");
  }
  return runtime;
}

type DispatchTransportFunctionPortName = {
  [Name in keyof TerminalDispatchTransportCliPorts]:
    TerminalDispatchTransportCliPorts[Name] extends
      (...arguments_: never[]) => unknown
      ? Name
      : never;
}[keyof TerminalDispatchTransportCliPorts];

function rawPort<Name extends DispatchTransportFunctionPortName>(
  name: Name
): TerminalDispatchTransportCliPorts[Name] {
  return ((...arguments_: unknown[]) => {
    const operation = dispatchTransportRuntime().ports[name];
    return (operation as (...values: unknown[]) => unknown)(...arguments_);
  }) as TerminalDispatchTransportCliPorts[Name];
}

const assertDeferredCodexForegroundBindingBoundary =
  rawPort("assertDeferredCodexForegroundBindingBoundary");
const assertNativeThreadHasExclusiveOwnership =
  rawPort("assertNativeThreadHasExclusiveOwnership");
const assertObservedHandoffTransportBoundary =
  rawPort("assertObservedHandoffTransportBoundary");
const assertVerifiedEmptyCodexTransportBoundary =
  rawPort("assertVerifiedEmptyCodexTransportBoundary");
const deferredForegroundApplication = rawPort("deferredForegroundApplication");
const deferredForegroundRecoveryAdapterPorts =
  rawPort("deferredForegroundRecoveryAdapterPorts");
const managedSessionStoreDirForConversation =
  rawPort("managedSessionStoreDirForConversation");
const persistManagedSessionNativeIdentity =
  rawPort("persistManagedSessionNativeIdentity");
const quarantineManagedSessionBinding =
  rawPort("quarantineManagedSessionBinding");
const required = rawPort("required");
const stallOtherTerminalBridgeConversationsForUncertainDispatch =
  rawPort("stallOtherTerminalBridgeConversationsForUncertainDispatch");
const startTerminalBridgeMonitorForConversation =
  rawPort("startTerminalBridgeMonitorForConversation");
const terminalBindingLedgerFields = rawPort("terminalBindingLedgerFields");
const terminalBridgeRuntimeKey = rawPort("terminalBridgeRuntimeKey");
const terminalControlFromTakeover = rawPort("terminalControlFromTakeover");
const terminalDispatchCapabilityRepositories =
  rawPort("terminalDispatchCapabilityRepositories");
const terminalRuntimeIdentityForConversation =
  rawPort("terminalRuntimeIdentityForConversation");
const withTerminalBridgeSubmission = rawPort("withTerminalBridgeSubmission");

const foregroundIdentificationAuthority = new Proxy({}, {
  get: (_target, property) => dispatchTransportRuntime().foregroundProofs[
    property as keyof CodexForegroundProofAuthority
  ]
}) as CodexForegroundProofAuthority;

const cliEnv = () => dispatchTransportRuntime().runtime.env();
const cliExit = (code: number): never =>
  dispatchTransportRuntime().runtime.exit(code);
const cliNow = () => dispatchTransportRuntime().runtime.now();
const cliPid = () => dispatchTransportRuntime().runtime.pid();
const runtimeLog = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>
) => dispatchTransportRuntime().runtime.log(level, event, fields);

async function resolveTerminalDispatchSubmissionOwner(
  prepared: PreparedTerminalControlSend,
  request: TerminalControlSendRequest,
  application: dispatchApplication.TerminalDispatchApplication,
  stagedConversation: Conversation
) {
  const {
    transaction, options, executor, allowedPreMaterializationIdentity,
    allowedAdditionalIdentities = [],
    deferredCodexForegroundBinding: deferredBinding
  } = request;
  const {
    execution, needsPostSendNativeBinding,
    codexRolloutAcceptanceAnchor: acceptanceAnchor,
    terminalControl, terminalAgentPid, sendTakeover, terminalRequestHash,
    route
  } = prepared;
  const deferredForegroundScope = deferredBinding
    ? bindDeferredForegroundApplicationScope(
        transaction.scopes,
        transaction.resources
      )
    : undefined;
  const ready = (conversation: Conversation, pending = false) => ({
    conversation, deferredCandidateBindingPending: pending
  });
  if (!needsPostSendNativeBinding) {
    return ready(stagedConversation);
  }
  let boundIdentity: NativeAgentSessionIdentity | undefined;
  let boundConversation: Conversation | undefined;
  let bindingError: string | undefined;
  try {
    if (
      deferredBinding &&
      cliEnv().AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE !== "1" &&
      ![2, 3].includes(Number(acceptanceAnchor?.version))
    ) {
      throw new Error(
        "deferred Codex foreground binding requires a virgin rollout acceptance anchor"
      );
    }
    boundIdentity = await execution.pollNativeIdentity({
      executor: executor.kind,
      terminalControl,
      pid: terminalAgentPid,
      expectedSessionId: stringValue(
        sendTakeover?.terminal_agent_expected_session_id
      ),
      allowedPreMaterializationIdentity,
      allowedAdditionalIdentities,
      ...(acceptanceAnchor &&
          [2, 3].includes(acceptanceAnchor.version)
        ? {
            requiredCodexAcceptance: {
              anchor: acceptanceAnchor,
              requestHash: terminalRequestHash
            },
            attempts: Math.max(1, Math.ceil(
              dispatchTransportRuntime().defaults.acceptanceTimeoutMs /
                dispatchTransportRuntime().defaults.acceptancePollIntervalMs
            )),
            delayMs:
              dispatchTransportRuntime().defaults.acceptancePollIntervalMs
          }
        : {})
    });
  } catch (error) {
    bindingError = error instanceof Error ? error.message : String(error);
  }
  if (boundIdentity) {
    try {
      if (
        acceptanceAnchor &&
        (
          boundIdentity.processUuid !==
            acceptanceAnchor.process_uuid ||
          boundIdentity.processBirth !==
            acceptanceAnchor.process_birth
        )
      ) {
        throw new Error(
          "Codex process incarnation changed while its native thread materialized"
        );
      }
      const expectedNativeThreadId = stringValue(
        sendTakeover?.terminal_agent_expected_session_id
      );
      if (
        expectedNativeThreadId &&
        boundIdentity.sessionId !== expectedNativeThreadId
      ) {
        throw new Error(
          `native agent created thread ${boundIdentity.sessionId}, expected ` +
          `${expectedNativeThreadId}`
        );
      }
      const resolvedBoundConversation = execution.withNativeIdentity(
        stagedConversation, boundIdentity
      );
      boundConversation = resolvedBoundConversation;
      const bindingStoreDir =
        managedSessionStoreDirForConversation(resolvedBoundConversation);
      const bindingStatePath = stringValue(resolvedBoundConversation.state_path);
      if (!bindingStoreDir || !bindingStatePath) {
        throw new Error("managed Session Store is unavailable before native identity commit");
      }
      const identityRoute = withExactTerminalDispatchRoute(route, {
        terminalControl,
        terminalKey: terminalBridgeRuntimeKey(terminalControl),
        storeDir: bindingStoreDir,
        statePath: bindingStatePath,
        logPath: path.join(path.dirname(bindingStatePath), "events.ndjson")
      }, (exactRoute) => exactRoute);
      if (deferredBinding) {
        await deferredForegroundApplication(
          options,
          deferredBinding.terminal
        ).commit({
          scope: required(
            deferredForegroundScope,
            "deferred foreground mutation scope is unavailable"
          ),
          boundary: deferredForegroundBoundaryProjection(deferredBinding),
          identity: boundIdentity,
          acceptedAt: cliNow().toISOString()
        });
      } else {
        if (executor.kind === "codex") {
          await rawPort("prepareManagedSessionNativeIdentityClaim")({
            options,
            conversation: boundConversation,
            identity: boundIdentity,
            storeDir: identityRoute.storeDir,
            terminalControl
          });
        } else {
          await assertNativeThreadHasExclusiveOwnership({
            options,
            agent: executor.kind,
            currentPid: terminalAgentPid,
            nativeThreadId: boundIdentity.sessionId,
            storeDir: identityRoute.storeDir,
            terminalControl,
            excludedManagedSessionId: sessionIdForConversation(boundConversation)
          });
        }
        persistManagedSessionNativeIdentity({
          conversation: boundConversation,
          terminalControl,
          identity: boundIdentity,
          storeDir: identityRoute.storeDir
        });
      }
      if (
        acceptanceAnchor &&
        [2, 3].includes(acceptanceAnchor.version) &&
        cliEnv().AKK_TEST_EXIT_AFTER_VIRGIN_SESSION_BINDING === "1"
      ) {
        cliExit(86);
      }
      // Persist the observed identity before the full Turn-vs-Session check:
      // the provisional Turn and Session initially share only a binding id.
      execution.assertTurnIdentity({
        conversation: boundConversation,
        currentIdentity: boundIdentity,
        operation: "bind"
      });
    } catch (error) {
      bindingError = error instanceof Error ? error.message : String(error);
      boundIdentity = undefined;
      boundConversation = undefined;
    }
  }
  if (!boundIdentity && deferredBinding) {
    try {
      const deferredScope = required(
        deferredForegroundScope,
        "deferred foreground mutation scope is unavailable"
      );
      const transfer = deferredScope.loadTransfer(deferredBinding.transferId);
      if (["committed", "resolved"].includes(transfer.status)) {
        const recoveredTarget =
          await deferredForegroundApplication(
            options,
            deferredBinding.terminal
          ).resolve({
            scope: deferredScope,
            boundary: deferredForegroundBoundaryProjection(deferredBinding)
          });
        const binding = recoveredTarget.binding;
        if (
          !binding?.native_thread_id ||
          !binding.native_process.process_uuid ||
          !binding.native_process.process_birth ||
          !isCompleteNativeRollout(binding.native_process.rollout)
        ) {
          throw new Error("resolved deferred target lacks exact native identity");
        }
        const recoveredIdentity: NativeAgentSessionIdentity = {
          sessionId: binding.native_thread_id,
          processUuid: binding.native_process.process_uuid,
          processBirth: binding.native_process.process_birth,
          rollout: binding.native_process.rollout,
          evidence: binding.native_process.evidence
        };
        const recoveredConversation = execution.withNativeIdentity(
          stagedConversation, recoveredIdentity
        );
        execution.assertTurnIdentity({
          conversation: recoveredConversation,
          currentIdentity: recoveredIdentity,
          operation: "recover deferred foreground binding for"
        });
        boundIdentity = recoveredIdentity;
        boundConversation = recoveredConversation;
      }
    } catch (error) {
      bindingError = error instanceof Error ? error.message : String(error);
      boundIdentity = undefined;
      boundConversation = undefined;
    }
  }
  if (boundIdentity && boundConversation) {
    return ready(boundConversation);
  }
  if (
    acceptanceAnchor?.version === 3 &&
    bindingError === undefined
  ) {
    return ready(stagedConversation, true);
  }
  const bindingReason = bindingError
    ? `AKK dispatched terminal input but could not verify the new native agent session: ${bindingError}`
    : "AKK dispatched terminal input but no exact native agent session appeared within the binding window";
  if (deferredBinding) {
    try {
      deferredForegroundApplication(
        options,
        deferredBinding.terminal
      ).markUncertain({
        scope: required(
          deferredForegroundScope,
          "deferred foreground mutation scope is unavailable"
        ),
        boundary: deferredForegroundBoundaryProjection(deferredBinding),
        reason: bindingReason
      });
    } catch (error) {
      runtimeLog("error", "deferred_codex_foreground_uncertain_persist_failed", {
        transfer_id: deferredBinding.transferId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    conversation: application.applyIdentityFailure(
      cliNow().toISOString(),
      bindingReason,
      deferredBinding
        ? undefined
        : (current) => quarantineManagedSessionBinding({
            conversation: current,
            reason: bindingReason,
            storeDir: route.storeDir
          })
    ),
    failureReason: bindingReason
  };
}

function deferredTerminalInputNotStartedAt(
  transfer: DeferredForegroundTransfer,
  terminalInputNotStartedAt?: string
): string | undefined {
  if (
    terminalInputNotStartedAt === undefined ||
    transfer.input_stage === "none"
  ) {
    return undefined;
  }
  if (
    transfer.status === "dispatch_started" &&
    transfer.input_stage === "dispatch_started"
  ) {
    return terminalInputNotStartedAt;
  }
  throw new Error(
    `deferred foreground transfer ${transfer.transfer_id} has ` +
    `${transfer.input_stage} input evidence and cannot accept a ` +
    "terminal-input-not-started result"
  );
}

interface TerminalDispatchRollbackRepositories {
  rollbackBeforeInput(route: BoundTerminalDispatchRoute): boolean;
  restoreDeferred(
    route: BoundTerminalDispatchRoute,
    terminalInputNotStartedAt?: string
  ): boolean;
}

function terminalDispatchRollbackRepositories({
  request,
  prepared,
  deferredForegroundScope,
  preTransportRollback
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  deferredForegroundScope?: DeferredForegroundApplicationScope;
  preTransportRollback?: (route: BoundTerminalDispatchRoute) => void;
}): TerminalDispatchRollbackRepositories {
  const {
    options,
    conversation,
    deferredCodexForegroundBinding
  } = request;
  let rollbackPreTransportAttach = preTransportRollback;
  const rollbackBeforeInput = (
    route: BoundTerminalDispatchRoute
  ): boolean => {
    if (!rollbackPreTransportAttach) {
      return true;
    }
    const rollback = rollbackPreTransportAttach;
    rollbackPreTransportAttach = undefined;
    try {
      rollback(route);
      return true;
    } catch (error) {
      runtimeLog("error", "raw_attach_pre_transport_rollback_failed", {
        conversation_id: conversation.conversation_id,
        terminal_target: route.terminalControl.target,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  };
  const restoreDeferred = (
    route: BoundTerminalDispatchRoute,
    terminalInputNotStartedAt?: string
  ): boolean => {
    if (!deferredCodexForegroundBinding) {
      return false;
    }
    const deferredScope = required(
      deferredForegroundScope,
      "deferred foreground mutation scope is unavailable"
    );
    const transfer = deferredScope.loadTransfer(
      deferredCodexForegroundBinding.transferId
    );
    if (
      terminalBridgeRuntimeKey(route.terminalControl) !==
        terminalBridgeRuntimeKey(
          deferredCodexForegroundBinding.terminal.terminalControl
        ) ||
      (transfer.state_path !== undefined &&
        !sameCanonicalStatePath(transfer.state_path, route.statePath))
    ) {
      throw new Error(
        "deferred Codex pre-input abort escaped its exact mutation resources"
      );
    }
    const durableTerminalInputNotStartedAt =
      deferredTerminalInputNotStartedAt(
        transfer,
        terminalInputNotStartedAt
      );
    deferredRecoveryAdapter.abortPreparedDeferredForegroundTurn(
      deferredForegroundRecoveryAdapterPorts(), {
      options,
      scope: deferredScope,
      storeDir: route.storeDir,
      terminal: {
        ...deferredCodexForegroundBinding.terminal,
        terminalControl: route.terminalControl
      },
      transfer,
      boundary: deferredCodexForegroundBinding,
      terminalInputNotStartedAt: durableTerminalInputNotStartedAt
    });
    // The dedicated abort already durably restores the Turn, ledger,
    // transfer, and Sessions. Never invoke the attach rollback twice.
    rollbackPreTransportAttach = undefined;
    return true;
  };
  return { rollbackBeforeInput, restoreDeferred };
}

interface TerminalDispatchProgress {
  stagedConversation: Conversation;
  textInjectedAt?: string;
  enterDispatchedAt?: string;
  bookkeepingWarning?: string;
}

interface TerminalDispatchRuntime {
  application: dispatchApplication.TerminalDispatchApplication;
  terminalMessage: AgentMessage &
    dispatchApplication.TerminalDispatchMessage;
  progress: TerminalDispatchProgress;
  recordPostTransportBookkeepingFailure(
    phase: string,
    error: unknown
  ): void;
  validatePreparedMessageEvent(): void;
}

function createTerminalDispatchRuntime(
  request: TerminalControlSendRequest,
  prepared: PreparedTerminalControlSend,
  rollback: TerminalDispatchRollbackRepositories
): TerminalDispatchRuntime {
  const {
    transaction,
    conversation,
    nextConversation,
    executor,
    message,
    recordRawAttachmentAfterSend = false,
    postSendCodexDetachedSessionClaims
  } = request;
  const {
    bridge,
    terminalControl,
    lockedStoreDir,
    statePath,
    logPath,
    bridgeStartedAt,
    submissionPreparedAt,
    agentTimeoutMinutes,
    agentHardTimeoutMinutes,
    terminalPayload,
    terminalRequestHash,
    previousDispatchLedger,
    preSendScreenFingerprint,
    codexRolloutAcceptanceAnchor,
    claudeTranscriptAnchor,
    claudeHome
  } = prepared;
  const terminalMessage = message as typeof message &
    dispatchApplication.TerminalDispatchMessage;
  const bridgeConversation = bridge
    ? dispatchReceipt.withTerminalBridgeState({
        conversation: nextConversation,
        message: terminalMessage,
        requestText: terminalPayload,
        startedAt: bridgeStartedAt,
        agentTimeoutMinutes,
        agentHardTimeoutMinutes,
        monitorLockVersion: monitorOwner.LOCK_VERSION,
        preSendScreenFingerprint,
        codexRolloutAcceptanceAnchor,
        codexDetachedCandidateSessionClaims:
          postSendCodexDetachedSessionClaims,
        claudeTranscriptAnchor,
        claudeHome
      })
    : nextConversation;
  const preparedSubmissionConversation = withTerminalBridgeSubmission({
    conversation: bridgeConversation,
    messageId: message.id,
    messageType: terminalMessage.type,
    messageBody: String(message.body),
    requestText: terminalPayload,
    status: "prepared",
    preparedAt: submissionPreparedAt
  });
  // A deferred generation's receipt authority begins when its transfer is
  // prepared. Keep the newer bridge lifecycle timestamp at the Turn level so
  // creating the provisional Turn never moves its visible update time back.
  const preparedConversation = submissionPreparedAt === bridgeStartedAt
    ? preparedSubmissionConversation
    : { ...preparedSubmissionConversation, updated_at: bridgeStartedAt };
  const previousGenerationId = stringValue(previousDispatchLedger?.generation_id) ??
    stringValue(previousDispatchLedger?.message_id);
  const progress: TerminalDispatchProgress = {
    stagedConversation: preparedConversation
  };
  let preparedMessageEvent: EventRecord | undefined;
  const recordPostTransportBookkeepingFailure = (
    phase: string,
    error: unknown
  ): void => {
    const warning = error instanceof Error ? error.message : String(error);
    progress.bookkeepingWarning ??= warning;
    runtimeLog("warn", "terminal_message_post_transport_bookkeeping_failed", {
      conversation_id: conversation.conversation_id,
      terminal_target: terminalControl.target,
      phase,
      error: warning
    });
  };
  const { applicationPorts } = bindTerminalDispatchCapabilities({
    scopes: transaction.scopes,
    resources: transaction.resources,
    repositories: terminalDispatchCapabilityRepositories({
      previousLedger: previousDispatchLedger,
      preparedMessageEvent: () => {
        if (!preparedMessageEvent) {
          throw new Error("prepared message event was not validated");
        }
        return preparedMessageEvent;
      },
      restoreDeferred: rollback.restoreDeferred,
      rollbackBeforeInput: rollback.rollbackBeforeInput
    }),
    local: {
      synchronizeStageProgress: (current, stage, at) => {
        progress.stagedConversation = current;
        progress.textInjectedAt = stage === "text_injected"
          ? at
          : progress.textInjectedAt;
        progress.enterDispatchedAt = stage === "enter_dispatched"
          ? at
          : progress.enterDispatchedAt;
      },
      audit: {
        log: runtimeLog,
        recordBookkeepingFailure: recordPostTransportBookkeepingFailure,
        recordPersistenceFailure: (phase, error, current) => {
          runtimeLog("error", phase, {
            conversation_id: current.conversation_id,
            terminal_target: terminalControl.target,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  });
  const application = new dispatchApplication.TerminalDispatchApplication({
    originalConversation: conversation,
    preparedConversation,
    message: terminalMessage,
    executor,
    terminalControl,
    receiptTerminalControl: terminalControlFromTakeover(
      isRecord(preparedConversation.native_session_takeover)
        ? preparedConversation.native_session_takeover
        : undefined
    ),
    requestText: terminalPayload,
    requestHash: terminalRequestHash,
    preparedAt: submissionPreparedAt,
    statePath,
    eventLogPath: logPath,
    previousGenerationId,
    dispatcherPid: cliPid(),
    storeDir: lockedStoreDir,
    recordRawAttachmentAfterSend,
    ledgerBindingFields: terminalBindingLedgerFields
  }, applicationPorts);
  application.persistPrepared();
  return {
    application,
    terminalMessage,
    progress,
    recordPostTransportBookkeepingFailure,
    validatePreparedMessageEvent: () => {
      preparedMessageEvent = messageEvent(terminalMessage);
    }
  };
}

function terminalDispatchTransportLifecycle({
  request,
  prepared,
  application,
  deferredForegroundScope
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  application: dispatchApplication.TerminalDispatchApplication;
  deferredForegroundScope?: DeferredForegroundApplicationScope;
}): ReturnType<TerminalDispatchExecutionService["transportLifecycle"]> {
  const {
    options,
    observedHandoff,
    verifiedEmptyCodexHandoff,
    deferredCodexForegroundBinding
  } = request;
  const lifecycle = prepared.execution.transportLifecycle({
    ...(observedHandoff
      ? {
          observedHandoff: {
            verify: (requireEmptyComposer) =>
              assertObservedHandoffTransportBoundary({
                options,
                terminal: observedHandoff.terminal,
                transition: observedHandoff.transition,
                requireEmptyComposer
              })
          }
        }
      : {}),
    ...(verifiedEmptyCodexHandoff
      ? {
          verifiedEmptyHandoff: {
            verify: (requireEmptyComposer) =>
              assertVerifiedEmptyCodexTransportBoundary({
                options,
                boundary: verifiedEmptyCodexHandoff,
                requireEmptyComposer
              })
          }
        }
      : {}),
    ...(deferredCodexForegroundBinding
      ? {
          deferredBinding: {
            verify: (requireEmptyComposer) =>
              assertDeferredCodexForegroundBindingBoundary({
                options,
                scope: required(
                  deferredForegroundScope,
                  "deferred foreground mutation scope is unavailable"
                ),
                boundary: deferredCodexForegroundBinding,
                expectedSourceStatus: "transitioning",
                requireNoDispatch: false,
                requireEmptyComposer
              }),
            begin: (at) => deferredForegroundApplication(
                  options,
                  deferredCodexForegroundBinding.terminal
                ).begin({
                  scope: required(
                    deferredForegroundScope,
                    "deferred foreground mutation scope is unavailable"
                  ),
                  boundary: deferredForegroundBoundaryProjection(
                    deferredCodexForegroundBinding
                  ),
                  at
                }),
            advance: (stage, at) => deferredForegroundApplication(
                    options,
                    deferredCodexForegroundBinding.terminal
                  ).advance({
                    scope: required(
                      deferredForegroundScope,
                      "deferred foreground mutation scope is unavailable"
                    ),
                    boundary: deferredForegroundBoundaryProjection(
                      deferredCodexForegroundBinding
                    ),
                    stage,
                    at
                  })
          }
        }
      : {}),
    recordStage: (stage, at, afterDurable) =>
      application.recordTransportStage(stage, at, afterDurable)
  });
  const lifecycleBeforeText = lifecycle.beforeText;
  const guardedLifecycle = options.identifyForeground === true
    ? {
        ...lifecycle,
        beforeText: async () => {
          await lifecycleBeforeText?.();
          const proof = foregroundIdentificationAuthority.current(options);
          const status = await prepared.terminalBridge.status(
            request.executor.kind,
            prepared.terminalControl,
            {
              runtime: prepared.preSendRuntime,
              scrollbackLines:
                proof?.observationScrollbackLines ??
                dispatchTransportRuntime().defaults.foregroundScrollbackLines
            }
          );
          foregroundIdentificationAuthority.assertCurrent({
            options,
            executor: request.executor,
            terminalControl: prepared.terminalControl,
            terminalAgentPid: prepared.terminalAgentPid,
            status
          });
        }
      }
    : lifecycle;
  const userExplicitTerminalSend = Boolean(
    stringValue(options.expectedUserExplicitTerminalToken)
  );
  return userExplicitTerminalSend
    ? {
        ...guardedLifecycle,
        requireExactEmptyComposerBeforeText: true,
        ...(request.executor.kind === "codex"
          ? { userExplicitEnterAfterTextWithoutComposerVeto: true }
          : {})
      }
    : guardedLifecycle;
}

async function terminalDispatchAcceptance({
  request,
  prepared,
  conversation
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  conversation: Conversation;
}): Promise<dispatchApplication.TerminalDispatchAcceptance> {
  const { options, executor } = request;
  const { execution, terminalControl } = prepared;
  const timeoutMs = positiveMilliseconds(
    options.terminalAcceptanceTimeoutMs ??
      dispatchTransportRuntime().defaults.acceptanceTimeoutMs,
    "--terminal-acceptance-timeout-ms"
  );
  return execution.pollAcceptance({
    executor: executor.kind,
    conversation,
    terminalControl,
    ...terminalAcceptanceCompanionFences(conversation, terminalControl),
    timeoutMs,
    pollIntervalMs: Math.max(10, Math.min(
      timeoutMs,
      Number(options.terminalAcceptancePollIntervalMs ??
        dispatchTransportRuntime().defaults.acceptancePollIntervalMs)
    )),
    scrollbackLines: Number(options.scrollbackLines ?? 240)
  });
}

function terminalAcceptanceCompanionFences(
  conversation: Conversation,
  terminalControl: TerminalControlRef
): {
  allowedCompanionIdentity?: CodexPreMaterializationIdentity;
  allowedAdditionalIdentities?: CodexPreMaterializationIdentity[];
} {
  if (executorForConversation(conversation).kind !== "codex") {
    return {};
  }
  const runtime = terminalRuntimeIdentityForConversation(
    conversation,
    terminalControl
  );
  return {
    allowedCompanionIdentity:
      runtime.allowedPreMaterializationNativeIdentity,
    allowedAdditionalIdentities:
      runtime.allowedAdditionalNativeIdentities
  };
}

function launchAcceptedTerminalMonitor({
  request,
  prepared,
  conversation,
  acceptance,
  recordFailure
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  conversation: Conversation;
  acceptance: dispatchApplication.TerminalDispatchAcceptance;
  recordFailure(phase: string, error: unknown): void;
}): TerminalMonitorProcess | undefined {
  const { options } = request;
  const {
    bridge,
    statePath,
    logPath,
    terminalControl,
    agentTimeoutMinutes,
    agentHardTimeoutMinutes
  } = prepared;
  if (
    !bridge ||
    !(
      acceptance.outcome === "agent_accepted" ||
      acceptance.outcome === "pending_acceptance"
    )
  ) {
    return undefined;
  }
  try {
    const monitor = startTerminalBridgeMonitorForConversation({
      conversation,
      statePath,
      logPath,
      options
    });
    if (monitor) {
      dispatchTransportRuntime().runtime.appendEvent(logPath, {
        ts: cliNow().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: monitor.pid ?? null,
        terminal_control: terminalControl,
        phase: acceptance.outcome,
        agent_timeout_minutes: agentTimeoutMinutes,
        agent_hard_timeout_minutes: agentHardTimeoutMinutes
      });
    }
    return monitor;
  } catch (error) {
    recordFailure("monitor_launch", error);
    return undefined;
  }
}

function presentTerminalDispatchTransportFailure({
  error,
  request,
  prepared,
  application,
  progress,
  deferredForegroundScope,
  bridgeMonitor,
  deferZeroInputFailurePresentation
}: {
  error: unknown;
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  application: dispatchApplication.TerminalDispatchApplication;
  progress: TerminalDispatchProgress;
  deferredForegroundScope?: DeferredForegroundApplicationScope;
  bridgeMonitor?: TerminalMonitorProcess;
  deferZeroInputFailurePresentation: boolean;
}): "zero_input" | "input_started" {
  const {
    options,
    executor,
    message,
    deferredCodexForegroundBinding
  } = request;
  const {
    lockedStoreDir,
    terminalControl,
    presentationContext,
    presentationPorts
  } = prepared;
  if (
    !progress.textInjectedAt &&
    error instanceof TerminalInputNotStartedError
  ) {
    let aborted: ReturnType<typeof application.recordZeroInputAbort> |
      undefined;
    try {
      aborted = application.recordZeroInputAbort({
        failureKind: "transport",
        error,
        abortedAt: cliNow().toISOString()
      });
    } catch (persistenceError) {
      if (!deferZeroInputFailurePresentation) throw persistenceError;
      runtimeLog("warn", "terminal_user_explicit_zero_input_abort_unavailable", {
        terminal_target: prepared.terminalControl.target,
        error: persistenceError instanceof Error
          ? persistenceError.message
          : String(persistenceError)
      });
    }
    if (!deferZeroInputFailurePresentation && aborted) {
      renderTerminalZeroInputAbort(
        aborted,
        presentationContext,
        presentationPorts,
        bridgeMonitor?.pid
      );
    }
    return "zero_input";
  }
  const uncertainAt = cliNow().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (deferredCodexForegroundBinding) {
    try {
      deferredForegroundApplication(
        options,
        deferredCodexForegroundBinding.terminal
      ).markUncertain({
        scope: required(
          deferredForegroundScope,
          "deferred foreground mutation scope is unavailable"
        ),
        boundary: deferredForegroundBoundaryProjection(
          deferredCodexForegroundBinding
        ),
        reason: errorMessage
      });
    } catch (transferError) {
      runtimeLog("error", "deferred_codex_foreground_uncertain_persist_failed", {
        transfer_id: deferredCodexForegroundBinding.transferId,
        error: transferError instanceof Error
          ? transferError.message
          : String(transferError)
      });
    }
  }
  const uncertainConversation = application.applyUncertain(
    uncertainAt,
    error,
    progress.textInjectedAt && !progress.enterDispatchedAt &&
      error instanceof TerminalEnterDispatchNotAttemptedError
      ? {
          enterNotAttemptedAt: uncertainAt,
          enterNotAttemptedReason: "pre_key_failure"
        }
      : {}
  );
  const stalledConversationIds =
    stallOtherTerminalBridgeConversationsForUncertainDispatch({
      storeDir: lockedStoreDir,
      terminalControl,
      currentConversationId: uncertainConversation.conversation_id,
      uncertainMessageId: message.id
    });
  runtimeLog("error", "terminal_message_submit_uncertain", {
    conversation_id: uncertainConversation.conversation_id,
    agent: executor.kind,
    terminal_target: terminalControl.target,
    error: errorMessage,
    do_not_retry: true,
    stalled_conversation_ids: stalledConversationIds
  });
  presentTerminalUncertain({
    conversation: uncertainConversation,
    stalledConversationIds,
    textInjected: progress.textInjectedAt !== undefined,
    enterDispatched: progress.enterDispatchedAt !== undefined,
    monitorPid: bridgeMonitor?.pid
  }, presentationContext, presentationPorts);
  return "input_started";
}

type TerminalDispatchTransportResult =
  | {
      outcome: "handled";
      terminalInput: "zero_input" | "input_started";
      enterDispatched: boolean;
      failure?: unknown;
    }
  | {
      outcome: "completed";
      conversation: Conversation;
      acceptance: dispatchApplication.TerminalDispatchAcceptance;
      bridgeMonitor?: TerminalMonitorProcess;
    };

async function runTerminalDispatchTransport({
  request,
  prepared,
  application,
  progress,
  recordPostTransportBookkeepingFailure,
  deferredForegroundScope,
  deferZeroInputFailurePresentation
}: {
  request: TerminalControlSendRequest;
  prepared: PreparedTerminalControlSend;
  application: dispatchApplication.TerminalDispatchApplication;
  progress: TerminalDispatchProgress;
  recordPostTransportBookkeepingFailure(phase: string, error: unknown): void;
  deferredForegroundScope?: DeferredForegroundApplicationScope;
  deferZeroInputFailurePresentation: boolean;
}): Promise<TerminalDispatchTransportResult> {
  const { executor } = request;
  const {
    terminalBridge,
    terminalControl,
    terminalPayload,
    preSendRuntime,
    codexRolloutAcceptanceAnchor,
    presentationContext,
    presentationPorts
  } = prepared;
  let bridgeMonitor: TerminalMonitorProcess | undefined;
  try {
    const transportLifecycle = terminalDispatchTransportLifecycle({
      request,
      prepared,
      application,
      deferredForegroundScope
    });
    await terminalBridge.send(
      executor.kind,
      terminalControl,
      terminalPayload,
      { runtime: preSendRuntime, ...transportLifecycle }
    );
    if (!progress.enterDispatchedAt) {
      throw new Error(
        "terminal bridge returned without an enter_dispatched receipt"
      );
    }
    if (
      codexRolloutAcceptanceAnchor &&
      [2, 3].includes(codexRolloutAcceptanceAnchor.version) &&
      cliEnv().AKK_TEST_EXIT_AFTER_VIRGIN_ENTER_DISPATCHED === "1"
    ) {
      cliExit(86);
    }
    const submissionOwner = await resolveTerminalDispatchSubmissionOwner(
      prepared,
      request,
      application,
      progress.stagedConversation
    );
    if ("failureReason" in submissionOwner) {
      presentTerminalIdentityFailure(
        submissionOwner.conversation,
        submissionOwner.failureReason,
        presentationContext,
        presentationPorts,
        bridgeMonitor?.pid
      );
      return {
        outcome: "handled",
        terminalInput: "input_started",
        enterDispatched: true
      };
    }
    const acceptance = submissionOwner.deferredCandidateBindingPending
      ? { outcome: "pending_acceptance" } as const
      : await terminalDispatchAcceptance({
          request,
          prepared,
          conversation: submissionOwner.conversation
        });
    const deliveredConversation = application.applyAcceptance(
      submissionOwner.conversation,
      acceptance,
      cliNow().toISOString()
    ).conversation;
    bridgeMonitor = launchAcceptedTerminalMonitor({
      request,
      prepared,
      conversation: deliveredConversation,
      acceptance,
      recordFailure: recordPostTransportBookkeepingFailure
    });
    return {
      outcome: "completed",
      conversation: deliveredConversation,
      acceptance,
      bridgeMonitor
    };
  } catch (error) {
    const terminalInput = presentTerminalDispatchTransportFailure({
      error,
      request,
      prepared,
      application,
      progress,
      deferredForegroundScope,
      bridgeMonitor,
      deferZeroInputFailurePresentation
    });
    return {
      outcome: "handled",
      terminalInput,
      enterDispatched: progress.enterDispatchedAt !== undefined,
      failure: error
    };
  }
}

export type TerminalControlSendResult =
  | { outcome: "replayed" }
  | { outcome: "zero_input"; failure: unknown }
  | { outcome: "input_started"; enterDispatched: boolean };

async function runTerminalControlSendWithinContext(
  request: TerminalControlSendRequest
): Promise<TerminalControlSendResult> {
  const {
    transaction,
    recordMessageAfterSend = false,
    onTerminalPreflightVerified,
    deferredCodexForegroundBinding,
    deferZeroInputFailurePresentation = false
  } = request;
  let prepared: PreparedTerminalControlSend | undefined;
  try {
    prepared = await dispatchTransportRuntime().prepare(
      request,
      dispatchTransportRuntime().preparationPorts,
      dispatchTransportRuntime().defaults
    );
  } catch (error) {
    if (deferZeroInputFailurePresentation) {
      return { outcome: "zero_input", failure: error };
    }
    throw error;
  }
  if (!prepared) {
    return { outcome: "replayed" };
  }
  const { route, presentationContext, presentationPorts } = prepared;
  let deferredForegroundScope: DeferredForegroundApplicationScope | undefined;
  // A newly discovered raw terminal may not have an authoritative Session
  // yet. Commit that Session only after every pre-input terminal and native
  // acceptance check has passed, but before the Turn or dispatch ledger can
  // become durable. This prevents a failed virgin attach from leaving a
  // zero-identity `bound` Session that fences every later control action.
  let dispatch: TerminalDispatchRuntime;
  try {
    deferredForegroundScope = deferredCodexForegroundBinding
      ? bindDeferredForegroundApplicationScope(
          transaction.scopes,
          transaction.resources
        )
      : undefined;
    if (deferredCodexForegroundBinding) {
      deferredForegroundScope?.assertBoundary(
        deferredForegroundBoundaryProjection(deferredCodexForegroundBinding)
      );
    }
    const preTransportRollback =
      await onTerminalPreflightVerified?.(route);
    const rollback = terminalDispatchRollbackRepositories({
      request,
      prepared,
      deferredForegroundScope,
      preTransportRollback: typeof preTransportRollback === "function"
        ? preTransportRollback
        : undefined
    });
    dispatch = createTerminalDispatchRuntime(
      request,
      prepared,
      rollback
    );
  } catch (error) {
    if (deferZeroInputFailurePresentation) {
      return { outcome: "zero_input", failure: error };
    }
    throw error;
  }
  const {
    application,
    progress,
    recordPostTransportBookkeepingFailure,
    validatePreparedMessageEvent
  } = dispatch;
  try {
    // Preserve legacy argument-evaluation priority inside the setup catch:
    // validate once before raw-attach bookkeeping, then let the gated
    // repository consume only this cached immutable event.
    application.recordPreparedBookkeeping(
      recordMessageAfterSend,
      cliEnv().AKK_TEST_TERMINAL_SETUP_FAILURE === "1",
      recordMessageAfterSend
        ? validatePreparedMessageEvent
        : undefined
    );
  } catch (error) {
    let aborted: ReturnType<typeof application.recordZeroInputAbort> |
      undefined;
    try {
      aborted = application.recordZeroInputAbort({
        failureKind: "setup",
        error,
        abortedAt: cliNow().toISOString(),
        injectStatePersistenceFailure:
          cliEnv().AKK_TEST_ABORTED_STATE_PERSISTENCE_FAILURE === "1"
      });
    } catch (persistenceError) {
      if (!deferZeroInputFailurePresentation) throw persistenceError;
      runtimeLog("warn", "terminal_user_explicit_zero_input_abort_unavailable", {
        terminal_target: route.terminalControl.target,
        error: persistenceError instanceof Error
          ? persistenceError.message
          : String(persistenceError)
      });
    }
    if (!deferZeroInputFailurePresentation && aborted) {
      renderTerminalZeroInputAbort(
        aborted,
        presentationContext,
        presentationPorts,
        undefined
      );
    }
    return { outcome: "zero_input", failure: error };
  }

  const transport = await runTerminalDispatchTransport({
    request,
    prepared,
    application,
    progress,
    recordPostTransportBookkeepingFailure,
    deferredForegroundScope,
    deferZeroInputFailurePresentation
  });
  if (transport.outcome === "handled") {
    return transport.terminalInput === "zero_input"
      ? { outcome: "zero_input", failure: transport.failure }
      : {
          outcome: "input_started",
          enterDispatched: transport.enterDispatched
        };
  }
  const deliveredConversation = transport.conversation;
  const acceptanceResult = transport.acceptance;
  const bridgeMonitor = transport.bridgeMonitor;
  const nativeAccepted = acceptanceResult?.outcome === "agent_accepted";
  const postSubmissionWarning = application.recordPostSubmissionBookkeeping(
    deliveredConversation,
    nativeAccepted,
    () => cliNow().toISOString()
  );
  if (postSubmissionWarning !== undefined) {
    progress.bookkeepingWarning = postSubmissionWarning;
  }
  presentTerminalCompleted({
    conversation: deliveredConversation,
    acceptance: acceptanceResult,
    monitorPid: bridgeMonitor?.pid,
    bookkeepingWarning: progress.bookkeepingWarning
  }, presentationContext, presentationPorts);
  return { outcome: "input_started", enterDispatched: true };
}

export async function runTerminalControlSend(
  request: TerminalControlSendRequest,
  dependencies: TerminalDispatchTransportDependencies
): Promise<TerminalControlSendResult> {
  return dispatchTransportContext.run(
    dependencies,
    () => runTerminalControlSendWithinContext(request)
  );
}
