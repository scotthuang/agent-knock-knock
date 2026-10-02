/** Reconcile startup receipts without sending terminal input; preserve terminal/Store/state lock order. */
import { createHash } from "node:crypto";
import path from "node:path";
import { validateCodexRolloutAcceptanceAnchor } from "./terminal-submission-acceptance.js";
import {
  deferredForegroundActiveEnterDispatchedAt,
  deferredForegroundActiveMessageId,
  deferredForegroundActivePreparedAt,
  deferredForegroundActiveTextInjectedAt,
  isDeferredForegroundSubmissionRetryPending,
  loadDeferredForegroundTransfer,
  saveDeferredForegroundTransfer,
  type DeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from "./deferred-foreground-transfer-policy.js";
import {
  executorForConversation,
  effectiveTurnStatus,
  isExplicitUserAbandonedManagementTurn,
  isTerminalDispatchOwnerReleasedStatus,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import {
  appendEvent,
  loadState,
  pathsForConversationDir,
  saveState,
  withStoreWriterLeaseAsync
} from "./store.js";
import type { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { cliPid } from "./cli-runtime-context.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { ResolvedTerminalConversation } from "./terminal-agent-bridge.js";
import { terminalControlFromTakeover } from "./terminal-runtime-cli-adapter.js";
import { terminalControlsShareIncarnation } from "./terminal-authority-policy.js";
import { terminalControlEvidenceMatches } from "./terminal-control-ref.js";
import {
  applyTerminalBridgeSubmission,
  terminalAcceptanceEvidenceForConversation,
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission
} from "./terminal-dispatch-receipt.js";
import { terminalMonitorDeadlineAt } from "./terminal-monitor-decision-policy.js";
import type { TerminalMonitorStatePaths } from "./terminal-monitor-state-reconciliation-service.js";
import {
  sameCanonicalStatePath,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import { terminalSubmissionPayload } from "./terminal-dispatch-execution.js";
import {
  loadTerminalSubmissionRetry,
  decideTerminalSubmissionRetryStartup,
  projectTerminalSubmissionRetryPending,
  saveTerminalSubmissionRetry,
  terminalSubmissionRetryLedgerFields,
  type TerminalSubmissionRetryRecord
} from "./terminal-submission-retry-service.js";
import {
  callbackExpectedForConversation,
  callbackRouteFingerprintForConversation
} from "./callback-route-authority.js";
import { canonicalJson } from "./canonical-json.js";
import { isRecord, nonBlankString } from "./value-guards.js";
import {
  type MonitorCliOptions,
  type TerminalMonitorStateCliDependencies,
  takeoverFor
} from "./terminal-monitor-state-contract.js";

type StartupRecoveryDependencies = {
  dispatch: Pick<TerminalMonitorStateCliDependencies["dispatch"], "repository">;
  authority: Pick<TerminalMonitorStateCliDependencies["authority"], "createBridge" | "handoff">;
};

export class TerminalMonitorStartupRecovery {
  readonly #dependencies: StartupRecoveryDependencies;
  readonly #stateFileLock: ReturnType<typeof createFileLockCliAdapter>;

  constructor(
    dependencies: StartupRecoveryDependencies,
    stateFileLock: ReturnType<typeof createFileLockCliAdapter>
  ) {
    this.#dependencies = dependencies;
    this.#stateFileLock = stateFileLock;
  }

  async recoverSubmissionRetry(
    storeDir: string,
    initialConversation: Conversation,
    paths: TerminalMonitorStatePaths
  ): Promise<Conversation> {
    const initialAttempt = loadTerminalSubmissionRetry(paths.statePath);
    if (!initialAttempt) {
      return initialConversation;
    }
    const initialTakeover = takeoverFor(initialConversation);
    const initialControl = terminalControlFromTakeover(initialTakeover);
    if (
      executorForConversation(initialConversation).kind !== "codex" ||
      !initialControl
    ) {
      throw new Error(
        "submission retry startup recovery lost its exact Codex terminal authority"
      );
    }
    const canonical = pathsForConversationDir(path.dirname(paths.statePath));
    if (
      path.resolve(canonical.storeDir) !== path.resolve(storeDir) ||
      path.resolve(canonical.statePath) !== path.resolve(paths.statePath) ||
      path.resolve(canonical.logPath) !== path.resolve(paths.logPath)
    ) {
      throw new Error(
        "submission retry startup recovery is outside its canonical Turn Store"
      );
    }
    const releaseTerminal = this.#dependencies.dispatch.repository.acquire(
      storeDir,
      initialControl,
      { timeoutMs: 30000 }
    );
    try {
      return await withStoreWriterLeaseAsync(storeDir, async () => {
        const releaseState = this.#stateFileLock.acquire(
          `${paths.statePath}.lock`
        );
        try {
          let conversation = loadState(paths.statePath);
          const takeover = takeoverFor(conversation);
          const control = terminalControlFromTakeover(takeover);
          const attempt = loadTerminalSubmissionRetry(paths.statePath);
          if (!attempt) {
            return conversation;
          }
          if (
            executorForConversation(conversation).kind !== "codex" ||
            !control ||
            !terminalControlsShareIncarnation(control, initialControl)
          ) {
            throw new Error(
              "submission retry startup recovery terminal authority changed"
            );
          }
          const callbackDelivery = isRecord(conversation.callback_delivery)
            ? conversation.callback_delivery
            : undefined;
          if (
            callbackDelivery?.status === "delivered" ||
            isTerminalDispatchOwnerReleasedStatus(
              effectiveTurnStatus(conversation)
            )
          ) {
            return conversation;
          }
          const submission = terminalBridgeSubmission(conversation);
          const ledger = this.#dependencies.dispatch.repository.load(control);
          if (!submission || !ledger) {
            throw new Error(
              "submission retry startup recovery lacks its Turn or ledger receipt"
            );
          }
          if (
            !["agent_accepted"].includes(String(submission.status)) &&
            !["agent_accepted"].includes(String(ledger.status)) &&
            !["enter_dispatched", "agent_accepted"].includes(attempt.state)
          ) {
            return conversation;
          }
          const authority = assertTerminalSubmissionRetryStartupAuthority({
            storeDir,
            paths,
            conversation,
            takeover,
            submission,
            ledger,
            attempt,
            control,
            ledgerMatchesControl: this.#dependencies.dispatch.repository
              .matchesControl(ledger, control)
          });
          const startup = decideTerminalSubmissionRetryStartup({
            attempt,
            submission,
            ledger
          });
          if (startup.action === "refuse") {
            throw new Error(startup.reason);
          }
          if (startup.action === "finalize_accepted") {
            return finalizeTerminalSubmissionRetryStartupAccepted({
              storeDir,
              paths,
              conversation,
              submission,
              ledger,
              attempt,
              control,
              authority,
              saveLedger: (next) => this.#dependencies.dispatch.repository
                .save(control, next)
            });
          }
          if (startup.action === "repair_terminal_ledger") {
            reconcileTerminalSubmissionRetryStartupTerminalLedger({
              paths,
              conversation,
              ledger,
              attempt,
              startup,
              saveLedger: (next) => this.#dependencies.dispatch.repository
                .save(control, next)
            });
            return conversation;
          }
          if (startup.action === "repair_terminal_state") {
            return reconcileTerminalSubmissionRetryStartupTerminalState({
              storeDir,
              paths,
              conversation,
              submission,
              attempt,
              control,
              authority,
              startup
            });
          }
          if (startup.action === "no_change") return conversation;
          const projection = authority.projection;
          if (!projection) {
            return conversation;
          }
          const receiptAlreadyPending =
            submission.status === "enter_dispatched";
          if (
            receiptAlreadyPending
              ? conversation.status !== "waiting_for_agent"
              : !["stalled", "waiting_for_agent"].includes(
                  String(conversation.status)
                )
          ) {
            return conversation;
          }
          let repairedTransfer = false;
          if (authority.deferredTransferId) {
            repairedTransfer = mirrorDeferredSubmissionRetryEnter({
              storeDir,
              transferId: authority.deferredTransferId,
              attempt,
              messageId: projection.messageId,
              preparedAt: projection.preparedAt,
              textInjectedAt: projection.textInjectedAt,
              requestHash: authority.requestHash,
              sessionId: sessionIdForConversation(conversation),
              turnId: turnIdForConversation(conversation),
              statePath: paths.statePath
            });
          }
          const stateNeedsRepair = !receiptAlreadyPending;
          if (receiptAlreadyPending && !terminalSubmissionRetryStateIsPending({
              conversation,
              submission,
              projection
          })) {
            return conversation;
          }
          if (stateNeedsRepair) {
            const epochConversation = terminalSubmissionRetryMonitorEpoch(
              conversation,
              projection.enterDispatchedAt
            );
            conversation = applyTerminalBridgeSubmission({
              conversation: epochConversation,
              messageId: projection.messageId,
              messageType: authority.messageType,
              requestText: authority.requestText,
              status: "enter_dispatched",
              preparedAt: projection.preparedAt,
              textInjectedAt: projection.textInjectedAt,
              enterDispatchedAt: projection.enterDispatchedAt,
              lastProvenStage: "enter_dispatched"
            }, {
              dispatcherPid: cliPid(),
              storeDir,
              terminalControl: control
            });
            saveState(paths.statePath, conversation);
          }
          const ledgerNeedsRepair =
              ledger.status !== "enter_dispatched" ||
            nonBlankString(ledger.text_injected_at) !==
              projection.textInjectedAt ||
            nonBlankString(ledger.enter_dispatched_at) !==
              projection.enterDispatchedAt ||
            ledger.submission_retry_state !== "enter_dispatched" ||
            ledger.submission_retry_revision !== attempt.revision;
          if (ledgerNeedsRepair) {
            this.#dependencies.dispatch.repository.save(control, {
              ...ledger,
              ...terminalSubmissionRetryLedgerFields(attempt),
              status: "enter_dispatched",
              text_injected_at: projection.textInjectedAt,
              enter_dispatched_at: projection.enterDispatchedAt,
              enter_not_attempted_at: undefined,
              enter_not_attempted_reason: undefined,
              uncertain_at: undefined,
              safe_to_retry: undefined,
              acceptance_evidence: undefined,
              agent_accepted_at: undefined,
              not_accepted_at: undefined,
              dispatcher_pid: null
            });
          }
          if (
            repairedTransfer || stateNeedsRepair || ledgerNeedsRepair
          ) {
            appendEvent(paths.logPath, {
              ts: projection.enterDispatchedAt,
              conversation_id: conversation.conversation_id,
              event: "terminal_submission_retry_startup_reconciled",
              message_id: projection.messageId,
              terminal_input_sent: false
            });
          }
          return loadState(paths.statePath);
        } finally {
          releaseState();
        }
      });
    } finally {
      releaseTerminal();
    }
  }

  async recoverDeferred(
    options: MonitorCliOptions,
    storeDir: string,
    initialConversation: Conversation,
    paths: TerminalMonitorStatePaths
  ): Promise<Conversation> {
    if (isExplicitUserAbandonedManagementTurn(initialConversation)) {
      return initialConversation;
    }
    const takeover = takeoverFor(initialConversation);
    const transferId = nonBlankString(
      takeover?.deferred_foreground_transfer_id
    );
    if (!transferId) {
      return initialConversation;
    }
    const initialControl = terminalControlFromTakeover(takeover);
    const initialPid = Number(takeover?.terminal_agent_pid);
    if (
      !initialControl ||
      !Number.isSafeInteger(initialPid) ||
      initialPid <= 1
    ) {
      throw new Error(
        `deferred foreground Turn ${initialConversation.conversation_id} ` +
        "lost its exact terminal process authority"
      );
    }
    const releaseTerminal = this.#dependencies.dispatch.repository.acquire(
      storeDir,
      initialControl,
      { timeoutMs: 30000 }
    );
    try {
      return await withStoreWriterLeaseAsync(storeDir, async () => {
        const releaseState = this.#stateFileLock.acquire(
          `${paths.statePath}.lock`
        );
        let conversation: Conversation;
        try {
          conversation = loadState(paths.statePath);
          if (isExplicitUserAbandonedManagementTurn(conversation)) {
            return conversation;
          }
        } finally {
          releaseState();
        }

        const currentTakeover = takeoverFor(conversation);
        const currentTransferId = nonBlankString(
          currentTakeover.deferred_foreground_transfer_id
        );
        const currentControl = terminalControlFromTakeover(currentTakeover);
        const currentPid = Number(currentTakeover.terminal_agent_pid);
        if (
          currentTransferId !== transferId ||
          !currentControl ||
          !terminalControlsShareIncarnation(currentControl, initialControl) ||
          !Number.isSafeInteger(currentPid) ||
          currentPid !== initialPid
        ) {
          throw new Error(
            `deferred foreground Turn ${conversation.conversation_id} ` +
            "changed its exact terminal process authority during recovery"
          );
        }
        const transfer = loadDeferredForegroundTransfer(
          storeDir,
          transferId
        );
        if (isFinalDeferredForegroundTransferStatus(transfer.status)) {
          return conversation;
        }
        const terminal = await this.#dependencies.authority
          .createBridge(options)
          .resolveStoredTerminal(
            "codex",
            currentPid,
            currentControl,
            { pid: currentPid }
          );
        await this.#dependencies.authority.handoff
          .recoverDeferredCodexForegroundTransferBeforeMutation({
            options,
            terminal: terminal as ResolvedTerminalConversation
          });
        const releaseFinalState = this.#stateFileLock.acquire(
          `${paths.statePath}.lock`
        );
        try {
          conversation = loadState(paths.statePath);
          this.#assertExactPendingDeferred(
            conversation,
            storeDir,
            transferId
          );
          return conversation;
        } finally {
          releaseFinalState();
        }
      });
    } finally {
      releaseTerminal();
    }
  }

  #assertExactPendingDeferred(
    conversation: Conversation,
    storeDir: string,
    transferId: string
  ): void {
    const transfer = loadDeferredForegroundTransfer(storeDir, transferId);
    if (isFinalDeferredForegroundTransferStatus(transfer.status)) {
      return;
    }
    const takeover = takeoverFor(conversation);
    const submission = terminalBridgeSubmission(conversation);
    const anchor = validateCodexRolloutAcceptanceAnchor(
      takeover?.codex_rollout_acceptance_anchor
    );
    const activeMessageId = deferredForegroundActiveMessageId(transfer);
    const exactRetryPending =
      isDeferredForegroundSubmissionRetryPending(transfer) &&
      activeMessageId === transfer.submission_retry_message_id &&
      nonBlankString(submission?.prepared_at) ===
        deferredForegroundActivePreparedAt(transfer) &&
      nonBlankString(submission?.text_injected_at) ===
        deferredForegroundActiveTextInjectedAt(transfer) &&
      nonBlankString(submission?.enter_dispatched_at) ===
        deferredForegroundActiveEnterDispatchedAt(transfer);
    if (
      anchor?.version !== 3 ||
      conversation.status !== "waiting_for_agent" ||
      submission?.status !== "enter_dispatched" ||
      nonBlankString(submission.message_id) !==
        nonBlankString(takeover?.terminal_bridge_message_id) ||
      nonBlankString(submission.message_id) !== activeMessageId ||
      !(transfer.status === "dispatch_started" || exactRetryPending)
    ) {
      throw new Error(
        `deferred foreground Turn ${conversation.conversation_id} ` +
        "is not an exact pending candidate-set acceptance"
      );
    }
  }
}

type TerminalSubmissionRetryStartupAuthorityInput = {
  storeDir: string;
  paths: TerminalMonitorStatePaths;
  conversation: Conversation;
  takeover: Record<string, unknown>;
  submission: Record<string, unknown>;
  ledger: Record<string, unknown>;
  attempt: TerminalSubmissionRetryRecord;
  control: TerminalControlRef;
  ledgerMatchesControl: boolean;
};

type TerminalSubmissionRetryStartupAuthorityContext = {
  sessionId: string;
  turnId: string;
  messageId?: string;
  requestText: string;
  requestHash?: string;
  messageType?: string;
  messageBodyHash: string;
  callbackFingerprint: string | null;
  deferredReferences: Array<string | undefined>;
  presentDeferredReferences: string[];
  deferredTransferId?: string;
  submissionTerminalEvidence: unknown;
  statePath?: string;
  logPath?: string;
  bindingId?: string;
  bindingGeneration: number;
};

type TerminalSubmissionRetryStartupAuthority = {
  requestText: string;
  requestHash: string;
  messageType: "task" | "answer";
  deferredTransferId?: string;
  projection?: ReturnType<typeof projectTerminalSubmissionRetryPending>;
};

function terminalSubmissionRetryStartupAuthorityContext(
  input: TerminalSubmissionRetryStartupAuthorityInput
): TerminalSubmissionRetryStartupAuthorityContext {
  const sessionId = sessionIdForConversation(input.conversation);
  const turnId = turnIdForConversation(input.conversation);
  const messageId = nonBlankString(input.submission.message_id);
  const requestText = terminalSubmissionPayload(
    nonBlankString(input.takeover.terminal_bridge_request_text) ?? ""
  );
  const requestHash = terminalBridgeRequestFingerprint(requestText);
  const messageType = nonBlankString(input.submission.message_type);
  const messageBodyHash = createHash("sha256")
    .update(requestText)
    .digest("hex");
  const callbackFingerprint =
    callbackRouteFingerprintForConversation(input.conversation) ?? null;
  const deferredReferences = [
    nonBlankString(input.takeover.deferred_foreground_transfer_id),
    nonBlankString(input.submission.deferred_foreground_transfer_id),
    nonBlankString(input.ledger.deferred_foreground_transfer_id),
    input.attempt.deferred_foreground_transfer_id ?? undefined
  ];
  const presentDeferredReferences = deferredReferences.filter(
    (value): value is string => value !== undefined
  );
  const deferredTransferId = presentDeferredReferences[0];
  const submissionTerminalEvidence =
    input.submission.terminal_endpoint !== undefined
      ? input.submission.terminal_endpoint
      : input.submission.terminal_control;
  const statePath = nonBlankString(input.conversation.state_path);
  const logPath = nonBlankString(input.conversation.event_log_path);
  const bindingId = nonBlankString(input.conversation.terminal_binding_id);
  const bindingGeneration = Number(
    input.conversation.terminal_binding_generation
  );
  return {
    sessionId,
    turnId,
    messageId,
    requestText,
    requestHash,
    messageType,
    messageBodyHash,
    callbackFingerprint,
    deferredReferences,
    presentDeferredReferences,
    deferredTransferId,
    submissionTerminalEvidence,
    statePath,
    logPath,
    bindingId,
    bindingGeneration
  };
}

function terminalSubmissionRetryStartupIdentityMatches(
  input: TerminalSubmissionRetryStartupAuthorityInput,
  context: TerminalSubmissionRetryStartupAuthorityContext
): boolean {
  return !(
    !context.requestText || !context.requestHash || !context.messageId ||
    (context.messageType !== "task" && context.messageType !== "answer") ||
    nonBlankString(input.takeover.terminal_bridge_message_id) !==
      context.messageId ||
    input.attempt.session_id !== context.sessionId ||
    input.attempt.turn_id !== context.turnId ||
    input.attempt.original_message_id !== context.messageId ||
    input.attempt.active_message_id !== context.messageId ||
    input.attempt.request_hash !== context.requestHash ||
    input.attempt.terminal_target !== input.control.target ||
    input.attempt.callback_route_fingerprint !== context.callbackFingerprint
  );
}

function terminalSubmissionRetryStartupSubmissionPathMatches(
  input: TerminalSubmissionRetryStartupAuthorityInput
): boolean {
  return path.resolve(nonBlankString(input.submission.store_dir) ?? "") ===
    path.resolve(input.storeDir);
}

function terminalSubmissionRetryStartupSubmissionMatches(
  input: TerminalSubmissionRetryStartupAuthorityInput,
  context: TerminalSubmissionRetryStartupAuthorityContext
): boolean {
  return !(
    nonBlankString(input.submission.session_id) !== context.sessionId ||
    nonBlankString(input.submission.turn_id) !== context.turnId ||
    nonBlankString(input.submission.request_hash) !== context.requestHash ||
    nonBlankString(input.submission.message_body_hash) !==
      context.messageBodyHash ||
    nonBlankString(input.submission.executor_kind) !== "codex" ||
    !terminalSubmissionRetryStartupSubmissionPathMatches(input) ||
    (input.submission.callback_route_fingerprint ?? null) !==
      context.callbackFingerprint ||
    !terminalControlEvidenceMatches(
      context.submissionTerminalEvidence,
      input.control
    )
  );
}

function terminalSubmissionRetryStartupLedgerPathMatches(
  input: TerminalSubmissionRetryStartupAuthorityInput,
  context: TerminalSubmissionRetryStartupAuthorityContext
): boolean {
  return !(
    path.resolve(nonBlankString(input.ledger.store_dir) ?? "") !==
      path.resolve(input.storeDir) ||
    !sameCanonicalStatePath(input.ledger.state_path, input.paths.statePath) ||
    !sameCanonicalStatePath(context.statePath, input.paths.statePath) ||
    !sameCanonicalStatePath(
      input.ledger.event_log_path,
      input.paths.logPath
    ) ||
    !sameCanonicalStatePath(context.logPath, input.paths.logPath)
  );
}

function terminalSubmissionRetryStartupLedgerMatches(
  input: TerminalSubmissionRetryStartupAuthorityInput,
  context: TerminalSubmissionRetryStartupAuthorityContext
): boolean {
  return !(
    nonBlankString(input.ledger.generation_id) !== context.messageId ||
    nonBlankString(input.ledger.message_id) !== context.messageId ||
    nonBlankString(input.ledger.conversation_id) !==
      input.conversation.conversation_id ||
    nonBlankString(input.ledger.session_id) !== context.sessionId ||
    nonBlankString(input.ledger.turn_id) !== context.turnId ||
    nonBlankString(input.ledger.message_type) !== context.messageType ||
    nonBlankString(input.ledger.message_body_hash) !==
      context.messageBodyHash ||
    nonBlankString(input.ledger.executor_kind) !== "codex" ||
    nonBlankString(input.ledger.request_hash) !== context.requestHash ||
    !terminalSubmissionRetryStartupLedgerPathMatches(input, context) ||
    (input.ledger.callback_route_fingerprint ?? null) !==
      context.callbackFingerprint ||
    input.ledger.callback_expected !==
      callbackExpectedForConversation(input.conversation) ||
    !input.ledgerMatchesControl ||
    (context.bindingId !== undefined &&
      nonBlankString(input.ledger.binding_id) !== context.bindingId) ||
    (Number.isSafeInteger(context.bindingGeneration) &&
      Number(input.ledger.binding_generation) !== context.bindingGeneration)
  );
}

function terminalSubmissionRetryStartupDeferredMatches(
  input: TerminalSubmissionRetryStartupAuthorityInput,
  context: TerminalSubmissionRetryStartupAuthorityContext
): boolean {
  return !(
    (context.deferredTransferId !== undefined &&
      (context.presentDeferredReferences.length !==
          context.deferredReferences.length ||
        new Set(context.presentDeferredReferences).size !== 1)) ||
    (context.deferredTransferId === undefined &&
      input.attempt.deferred_foreground_transfer_id !== null)
  );
}

function terminalSubmissionRetryStartupProjectionFields(
  input: TerminalSubmissionRetryStartupAuthorityInput
): Pick<TerminalSubmissionRetryStartupAuthority, "projection"> | object {
  if (
    input.attempt.state === "agent_accepted" ||
    ["agent_accepted", "not_accepted"].includes(
      String(input.submission.status)
    ) ||
    ["agent_accepted", "not_accepted"].includes(String(input.ledger.status))
  ) {
    return {};
  }
  return {
    projection: projectTerminalSubmissionRetryPending({
      attempt: input.attempt,
      submission: input.submission,
      ledger: input.ledger
    })
  };
}

function assertTerminalSubmissionRetryStartupAuthority(
  input: TerminalSubmissionRetryStartupAuthorityInput
): TerminalSubmissionRetryStartupAuthority {
  const context = terminalSubmissionRetryStartupAuthorityContext(input);
  if (
    !terminalSubmissionRetryStartupIdentityMatches(input, context) ||
    !terminalSubmissionRetryStartupSubmissionMatches(input, context) ||
    !terminalSubmissionRetryStartupLedgerMatches(input, context) ||
    !terminalSubmissionRetryStartupDeferredMatches(input, context)
  ) {
    throw new Error(
      "submission retry startup recovery authority disagrees across Turn and ledger"
    );
  }
  return {
    requestText: context.requestText,
    requestHash: context.requestHash as string,
    messageType: context.messageType as "task" | "answer",
    deferredTransferId: context.deferredTransferId,
    ...terminalSubmissionRetryStartupProjectionFields(input)
  };
}

function finalizeTerminalSubmissionRetryStartupAccepted(input: {
  storeDir: string;
  paths: TerminalMonitorStatePaths;
  conversation: Conversation;
  submission: Record<string, unknown>;
  ledger: TerminalDispatchLedgerDocument;
  attempt: TerminalSubmissionRetryRecord;
  control: TerminalControlRef;
  authority: ReturnType<typeof assertTerminalSubmissionRetryStartupAuthority>;
  saveLedger(next: TerminalDispatchLedgerDocument): void;
}): Conversation {
  const stateAccepted = input.submission.status === "agent_accepted";
  const ledgerAccepted = input.ledger.status === "agent_accepted";
  if (!stateAccepted && !ledgerAccepted) {
    throw new Error(
      "accepted submission retry sidecar lacks native acceptance evidence"
    );
  }
  const stateEvidence = stateAccepted
    ? terminalAcceptanceEvidenceForConversation(
        input.conversation,
        input.authority.requestText,
        input.submission.acceptance_evidence
      )
    : undefined;
  const ledgerEvidence = ledgerAccepted
    ? terminalAcceptanceEvidenceForConversation(
        input.conversation,
        input.authority.requestText,
        input.ledger.acceptance_evidence
      )
    : undefined;
  if (
    stateEvidence && ledgerEvidence &&
    canonicalJson(stateEvidence) !== canonicalJson(ledgerEvidence)
  ) {
    throw new Error(
      "accepted submission retry evidence conflicts across Turn and ledger"
    );
  }
  const evidence = stateEvidence ?? ledgerEvidence;
  const stateAcceptedAt = stateAccepted
    ? nonBlankString(input.submission.agent_accepted_at)
    : undefined;
  const ledgerAcceptedAt = ledgerAccepted
    ? nonBlankString(input.ledger.agent_accepted_at)
    : undefined;
  if (
    !evidence || !stateAcceptedAt && !ledgerAcceptedAt ||
    stateAcceptedAt && ledgerAcceptedAt && stateAcceptedAt !== ledgerAcceptedAt
  ) {
    throw new Error(
      "accepted submission retry timestamp conflicts across Turn and ledger"
    );
  }
  const acceptedAt = (stateAcceptedAt ?? ledgerAcceptedAt) as string;
  if (input.authority.deferredTransferId) {
    const transfer = loadDeferredForegroundTransfer(
      input.storeDir,
      input.authority.deferredTransferId
    );
    if (transfer.status !== "resolved") {
      if (isFinalDeferredForegroundTransferStatus(transfer.status)) {
        throw new Error(
          "accepted submission retry conflicts with an aborted deferred transfer"
        );
      }
      return input.conversation;
    }
    if (
      transfer.agent_accepted_at !== acceptedAt ||
      transfer.message_id !== input.attempt.active_message_id
    ) {
      throw new Error(
        "accepted submission retry conflicts with its resolved deferred transfer"
      );
    }
  }
  if (
    input.attempt.state === "agent_accepted" &&
    input.attempt.agent_accepted_at !== acceptedAt
  ) {
    throw new Error(
      "accepted submission retry sidecar timestamp conflicts with native evidence"
    );
  }
  let conversation = input.conversation;
  const stateNeedsRepair = !stateAccepted;
  if (stateNeedsRepair) {
    const acceptedOwner: Conversation = {
      ...conversation,
      status: "waiting_for_agent",
      updated_at: acceptedAt
    };
    delete acceptedOwner.stalled_at;
    delete acceptedOwner.stalled_reason;
    delete acceptedOwner.failed_at;
    delete acceptedOwner.failure_reason;
    delete acceptedOwner.idle_since;
    conversation = applyTerminalBridgeSubmission({
      conversation: acceptedOwner,
      messageId: input.attempt.active_message_id,
      messageType: input.authority.messageType,
      requestText: input.authority.requestText,
      status: "agent_accepted",
      preparedAt: nonBlankString(input.submission.prepared_at) as string,
      textInjectedAt: nonBlankString(input.submission.text_injected_at) ??
        nonBlankString(input.ledger.text_injected_at),
      enterDispatchedAt: nonBlankString(input.submission.enter_dispatched_at) ??
        nonBlankString(input.ledger.enter_dispatched_at),
      agentAcceptedAt: acceptedAt,
      acceptanceEvidence: evidence,
      lastProvenStage: "agent_accepted"
    }, {
      dispatcherPid: cliPid(),
      storeDir: input.storeDir,
      terminalControl: input.control
    });
    saveState(input.paths.statePath, conversation);
  }
  let attempt = input.attempt;
  const attemptNeedsRepair = attempt.state !== "agent_accepted";
  if (attemptNeedsRepair) {
    attempt = saveTerminalSubmissionRetry(input.paths.statePath, {
      ...attempt,
      state: "agent_accepted",
      agent_accepted_at: acceptedAt,
      updated_at: acceptedAt
    }, attempt.revision);
  }
  const ledgerNeedsRepair = !ledgerAccepted ||
    input.ledger.submission_retry_state !== "agent_accepted" ||
    input.ledger.submission_retry_revision !== attempt.revision;
  if (ledgerNeedsRepair) {
    input.saveLedger({
      ...input.ledger,
      ...terminalSubmissionRetryLedgerFields(attempt),
      status: "agent_accepted",
      agent_accepted_at: acceptedAt,
      acceptance_evidence: evidence,
      not_accepted_at: undefined,
      uncertain_at: undefined,
      safe_to_retry: undefined,
      dispatcher_pid: null
    });
  }
  if (stateNeedsRepair || attemptNeedsRepair || ledgerNeedsRepair) {
    appendEvent(input.paths.logPath, {
      ts: acceptedAt,
      conversation_id: conversation.conversation_id,
      event: "terminal_submission_retry_startup_accepted_reconciled",
      message_id: input.attempt.active_message_id,
      terminal_input_sent: false
    });
  }
  return loadState(input.paths.statePath);
}

function reconcileTerminalSubmissionRetryStartupTerminalLedger(input: {
  paths: TerminalMonitorStatePaths;
  conversation: Conversation;
  ledger: TerminalDispatchLedgerDocument;
  attempt: TerminalSubmissionRetryRecord;
  startup: Extract<
    ReturnType<typeof decideTerminalSubmissionRetryStartup>,
    { action: "repair_terminal_ledger" }
  >;
  saveLedger(next: TerminalDispatchLedgerDocument): void;
}): void {
  const notAccepted = input.startup.outcome === "not_accepted";
  input.saveLedger({
    ...input.ledger,
    ...terminalSubmissionRetryLedgerFields(input.attempt),
    status: input.startup.outcome,
    ...(notAccepted
      ? {
          not_accepted_at: input.startup.at,
          uncertain_at: undefined,
          error: undefined,
          safe_to_retry: undefined
        }
      : {
          not_accepted_at: undefined,
          uncertain_at: input.startup.at,
          error: input.startup.reason,
          safe_to_retry: false
        }),
    acceptance_evidence: undefined,
    agent_accepted_at: undefined,
    dispatcher_pid: null
  });
  appendEvent(input.paths.logPath, {
    ts: input.startup.at,
    conversation_id: input.conversation.conversation_id,
    event: `terminal_submission_retry_startup_${input.startup.outcome}_reconciled`,
    message_id: input.attempt.active_message_id,
    terminal_input_sent: false,
    do_not_retry: true
  });
}

function reconcileTerminalSubmissionRetryStartupTerminalState(input: {
  storeDir: string;
  paths: TerminalMonitorStatePaths;
  conversation: Conversation;
  submission: Record<string, unknown>;
  attempt: TerminalSubmissionRetryRecord;
  control: TerminalControlRef;
  authority: ReturnType<typeof assertTerminalSubmissionRetryStartupAuthority>;
  startup: Extract<
    ReturnType<typeof decideTerminalSubmissionRetryStartup>,
    { action: "repair_terminal_state" }
  >;
}): Conversation {
  const stalled: Conversation = {
    ...input.conversation,
    status: "stalled",
    stalled_at: input.startup.at,
    stalled_reason: input.startup.reason ??
      "submission retry native acceptance became uncertain",
    updated_at: input.startup.at
  };
  const conversation = applyTerminalBridgeSubmission({
    conversation: stalled,
    messageId: input.attempt.active_message_id,
    messageType: input.authority.messageType,
    requestText: input.authority.requestText,
    status: "uncertain",
    preparedAt: nonBlankString(input.submission.prepared_at) as string,
    textInjectedAt: nonBlankString(input.submission.text_injected_at),
    enterDispatchedAt: nonBlankString(input.submission.enter_dispatched_at),
    uncertainAt: input.startup.at,
    error: input.startup.reason,
    safeToRetry: false,
    lastProvenStage: "enter_dispatched"
  }, {
    dispatcherPid: cliPid(),
    storeDir: input.storeDir,
    terminalControl: input.control
  });
  saveState(input.paths.statePath, conversation);
  appendEvent(input.paths.logPath, {
    ts: input.startup.at,
    conversation_id: conversation.conversation_id,
    event: "terminal_submission_retry_startup_uncertain_reconciled",
    message_id: input.attempt.active_message_id,
    terminal_input_sent: false,
    do_not_retry: true
  });
  return conversation;
}

function mirrorDeferredSubmissionRetryEnter(input: {
  storeDir: string;
  transferId: string;
  attempt: TerminalSubmissionRetryRecord;
  messageId: string;
  preparedAt: string;
  textInjectedAt: string;
  requestHash: string;
  sessionId: string;
  turnId: string;
  statePath: string;
}): boolean {
  const transfer = loadDeferredForegroundTransfer(
    input.storeDir,
    input.transferId
  );
  assertDeferredSubmissionRetryMirrorAuthority(transfer, input);
  if (isFinalDeferredForegroundTransferStatus(transfer.status)) {
    return false;
  }
  if (transfer.submission_retry_enter_dispatched_at) {
    if (!isDeferredForegroundSubmissionRetryPending(transfer)) {
      throw new Error(
        "deferred submission retry startup authority is not exactly pending"
      );
    }
    return false;
  }
  if (
    transfer.status !== "uncertain" ||
    transfer.input_stage !== "text_injected" ||
    transfer.enter_dispatched_at !== undefined
  ) {
    throw new Error(
      "deferred submission retry startup recovery found an unsafe stage lag"
    );
  }
  const repaired = saveDeferredForegroundTransfer(input.storeDir, {
    ...transfer,
    input_stage: "enter_dispatched",
    enter_dispatched_at: input.attempt.enter_dispatched_at,
    submission_retry_enter_dispatched_at:
      input.attempt.enter_dispatched_at
  }, {
    expectedRevision: Number(transfer.revision)
  });
  if (!isDeferredForegroundSubmissionRetryPending(repaired)) {
    throw new Error(
      "deferred submission retry startup recovery did not produce exact pending authority"
    );
  }
  return true;
}

function assertDeferredSubmissionRetryMirrorAuthority(
  transfer: DeferredForegroundTransfer,
  input: {
    transferId: string;
    attempt: TerminalSubmissionRetryRecord;
    messageId: string;
    preparedAt: string;
    textInjectedAt: string;
    requestHash: string;
    sessionId: string;
    turnId: string;
    statePath: string;
  }
): void {
  const exactMode = input.attempt.mode === "exact_draft_enter";
  if (
    transfer.transfer_id !== input.transferId ||
    transfer.turn_id !== input.turnId ||
    transfer.target_session_id !== input.sessionId ||
    !sameCanonicalStatePath(transfer.state_path, input.statePath) ||
    transfer.request_hash !== input.requestHash ||
    transfer.message_id !== input.messageId ||
    transfer.prepared_at !== input.preparedAt ||
    transfer.submission_retry_attempt_id !== input.attempt.attempt_id ||
    transfer.submission_retry_mode !== input.attempt.mode ||
    transfer.submission_retry_message_id !== input.messageId ||
    transfer.submission_retry_prepared_at !== input.preparedAt ||
    transfer.submission_retry_enter_reserved_at !==
      input.attempt.enter_reserved_at ||
    transfer.submission_retry_enter_dispatched_at !== undefined &&
      transfer.submission_retry_enter_dispatched_at !==
        input.attempt.enter_dispatched_at ||
    transfer.submission_retry_enter_dispatched_at !== undefined &&
      (transfer.input_stage !== "enter_dispatched" ||
        transfer.enter_dispatched_at !== input.attempt.enter_dispatched_at) ||
    (exactMode
      ? transfer.submission_retry_text_reserved_at !== undefined ||
        transfer.submission_retry_text_injected_at !== undefined ||
        transfer.text_injected_at !== input.textInjectedAt
      : transfer.submission_retry_text_reserved_at !==
          input.attempt.replacement_text_reserved_at ||
        transfer.submission_retry_text_injected_at !==
          input.attempt.replacement_text_injected_at)
  ) {
    throw new Error(
      "deferred submission retry startup authority disagrees with its attempt"
    );
  }
}

function terminalSubmissionRetryMonitorEpoch(
  conversation: Conversation,
  at: string
): Conversation {
  const takeover = takeoverFor(conversation);
  const inactivityMinutes = Number(
    takeover.terminal_bridge_inactivity_timeout_minutes
  );
  const hardMinutes = Number(takeover.terminal_bridge_hard_timeout_minutes);
  const inactivityDeadlineAt = terminalMonitorDeadlineAt(
    at,
    inactivityMinutes
  );
  const hardDeadlineAt = terminalMonitorDeadlineAt(at, hardMinutes);
  if (!inactivityDeadlineAt || !hardDeadlineAt) {
    throw new Error(
      "submission retry startup recovery lacks its configured monitor timeouts"
    );
  }
  const next: Conversation = {
    ...conversation,
    status: "waiting_for_agent",
    native_session_takeover: {
      ...takeover,
      terminal_bridge_started_at: at,
      terminal_bridge_monitor_started_at: at,
      terminal_bridge_last_activity_at: at,
      terminal_bridge_last_activity_reason:
        "submission retry Enter dispatched",
      terminal_bridge_inactivity_deadline_at: inactivityDeadlineAt,
      terminal_bridge_hard_deadline_at: hardDeadlineAt
    },
    updated_at: at
  };
  delete next.stalled_at;
  delete next.stalled_reason;
  delete next.failed_at;
  delete next.failure_reason;
  delete next.idle_since;
  return next;
}

function terminalSubmissionRetryStateIsPending(input: {
  conversation: Conversation;
  submission: Record<string, unknown>;
  projection: ReturnType<typeof projectTerminalSubmissionRetryPending>;
}): boolean {
  return input.conversation.status === "waiting_for_agent" &&
    input.submission.status === "enter_dispatched" &&
    nonBlankString(input.submission.message_id) === input.projection.messageId &&
    nonBlankString(input.submission.prepared_at) ===
      input.projection.preparedAt &&
    nonBlankString(input.submission.text_injected_at) ===
      input.projection.textInjectedAt &&
    nonBlankString(input.submission.enter_dispatched_at) ===
      input.projection.enterDispatchedAt;
}
