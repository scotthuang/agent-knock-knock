import path from "node:path";

import { canonicalJson } from "./canonical-json.js";
import {
  deterministicTerminalCallbackMessageId,
  type PreparedCallback
} from "./callback-outbox-service.js";
import {
  cliEnv,
  cliExit,
  cliNow,
  cliNowMs,
  cliPid,
  cliRuntimeLog,
  cliSleepSync
} from "./cli-runtime-context.js";
import { loadDeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import {
  executorForConversation,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import { tryLoadManagedSession } from "./session-store.js";
import {
  appendEvent,
  logPathForStatePath,
  loadState,
  pathsForConversationDir,
  saveState,
  withStoreWriterLease,
  withStoreWriterLeaseAsync
} from "./store.js";
import type {
  TerminalCompletionEvidence,
  TerminalControlRef
} from "./terminal-agent-adapter.js";
import { terminalControlsShareIncarnation } from
  "./terminal-authority-policy.js";
import {
  sameTerminalControlIncarnation,
  terminalEndpointFromControlRef
} from "./terminal-control-ref.js";
import {
  sameCanonicalStatePath,
  terminalDispatchLedgerLooksLifecycle,
  terminalDispatchReceiptHistory,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import type {
  TerminalDispatchRepositoryCliAdapter
} from "./terminal-dispatch-repository-cli-adapter.js";
import { isRecoverableTerminalDispatchStatus } from
  "./terminal-dispatch-policy.js";
import {
  TerminalDispatchRecoveryService,
  assertVerifiedDeadDispatchAuthorityFacts,
  decideLaggingDispatchRecovery,
  decidePreparedDispatchRecovery,
  type LaggingDispatchRecoveryInput,
  type LocalCompletionRecoveryContext,
  type LocalCompletionRecoveryResult,
  type PreparedDispatchOwnerFacts,
  type TerminalBindingLedgerFacts,
  type TerminalCompletionPreparation,
  type TerminalDispatchRecoveryPorts,
  type TerminalDispatchRecoveryScope,
  type TerminalSubmissionRecoveryFacts,
  type VerifiedDeadRecoveryContext,
  type VerifiedDeadRecoveryResult
} from "./terminal-dispatch-recovery-service.js";
import {
  applyTerminalBridgeSubmission,
  terminalAcceptanceEvidenceForConversation,
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission,
  terminalBridgeSubmissionReceipts
} from "./terminal-dispatch-receipt.js";
import type { TerminalSubmissionAcceptanceEvidence } from
  "./terminal-submission-facts.js";
import { readNdjsonLog, type TranscriptEvent } from "./transcript.js";
import {
  decideAcceptedTurnDeadAgentStall,
  reconcileVerifiedDeadAgentAuthority,
  selectVerifiedDeadAgentEvent,
  validateStoredVerifiedDeadAgentAuthority,
  validateVerifiedDeadAgentEventAuthority,
  verifiedDeadTerminalAgentProcessEvidenceId,
  type BoundTerminalAgentProcessObservation,
  type VerifiedDeadAgentAuthorityContext,
  type VerifiedDeadAgentAuthorityDecision,
  type VerifiedDeadAgentCompletionObservation,
  type VerifiedDeadTerminalAgentProcessProof
} from "./verified-dead-agent-policy.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export interface TerminalDispatchRecoveryCliDependencies {
  repository: TerminalDispatchRepositoryCliAdapter;
  authority: {
    terminalControl(value: unknown): TerminalControlRef | undefined;
    assertNoDeferredTransfer(input: {
      storeDir: string;
      conversation: Conversation;
      action: "approve" | "cancel";
    }): void;
    assertTurnBindingCurrent(conversation: Conversation, operation: string): void;
    storeDirForConversation(conversation: Conversation): string | undefined;
  };
  observation: {
    process(input: {
      options: Record<string, any>;
      conversation: Conversation;
      terminalControl: TerminalControlRef;
    }): Promise<BoundTerminalAgentProcessObservation>;
    completion(input: {
      options: Record<string, any>;
      conversation: Conversation;
      terminalControl: TerminalControlRef;
    }): Promise<VerifiedDeadAgentCompletionObservation<TerminalCompletionEvidence>>;
  };
  completion: {
    prepare(input: {
      options: Record<string, any>;
      statePath: string;
      logPath: string;
      conversation: Conversation;
      executor: ReturnType<typeof executorForConversation>;
      terminalControl: TerminalControlRef;
      terminalMessageId: string;
      completion: TerminalCompletionEvidence;
      allowSupersedeRecovery?: boolean;
      completionFingerprint?: string;
    }): TerminalCompletionPreparation<PreparedCallback>;
  };
  runtime: {
    isProcessAlive(pid: number): boolean;
  };
}

export interface TerminalDispatchRecoveryCliFacade {
  loadOwner(
    ledger: TerminalDispatchLedgerDocument
  ): Conversation | undefined;
  assertManagedOwner(input: {
    storeDir: string;
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    action: "approve" | "cancel";
  }): void;
  assertNativeThreadStoreAuthority(input: {
    terminalControl: TerminalControlRef;
    nativeThreadId: string;
    storeDir: string;
  }): void;
  orphanedForRecovery(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined;
  bindingFields(conversation: Conversation): TerminalDispatchLedgerDocument;
  reconcilePrepared(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument
  ): TerminalDispatchLedgerDocument | undefined;
  isVerifiedDead(conversation: Conversation | Record<string, any>): boolean;
  exactVerifiedDeadAuthority(input: {
    conversation: Conversation;
    storeDir: string;
    terminalControl: TerminalControlRef;
    logPath: string;
  }): VerifiedDeadAgentAuthorityDecision;
  ensureVerifiedDeadEvent(input: {
    logPath: string;
    proof: VerifiedDeadTerminalAgentProcessProof;
    action: "managed_close" | "monitor_reconciliation";
  }): {
    proof: VerifiedDeadTerminalAgentProcessProof;
    evidenceId: string;
    recordedAt: string;
  };
  ensureVerifiedDeadClosedEvent(input: {
    logPath: string;
    conversation: Conversation;
    evidenceId: string;
  }): void;
  assertVerifiedDeadDispatch(input: VerifiedDeadDispatchRequest): {
    ledger: TerminalDispatchLedgerDocument;
    resolved: boolean;
  };
  resolveVerifiedDeadDispatch(
    input: VerifiedDeadDispatchRequest & { reason: string }
  ): boolean;
  stallAccepted(input: {
    options: Record<string, any>;
    storeDir: string;
    statePath: string;
    logPath: string;
    expectedConversationId: string;
    expectedMessageId?: string;
  }): Promise<VerifiedDeadRecoveryResult<PreparedCallback>>;
  settleLocalCompletion(input: {
    storeDir: string;
    statePath: string;
    logPath: string;
  }): LocalCompletionRecoveryResult;
  prepareCompletion(input: {
    options: Record<string, any>;
    statePath: string;
    logPath: string;
    conversation: Conversation;
    executor: ReturnType<typeof executorForConversation>;
    terminalControl: TerminalControlRef;
    terminalMessageId: string;
    completion: TerminalCompletionEvidence;
    allowSupersedeRecovery?: boolean;
    completionFingerprint?: string;
  }): TerminalCompletionPreparation<PreparedCallback>;
  readEvents(logPath: string): TranscriptEvent[];
}

interface VerifiedDeadDispatchRequest {
  terminalControl: TerminalControlRef;
  conversation: Conversation;
  storeDir: string;
  statePath: string;
  logPath: string;
  expectedMessageId: string;
}

interface LocalClaimFacts {
  completionFingerprint: string;
  completionId: string;
  callbackMessageId: string;
  claimedAt: string;
  outcome: string;
  expectedMessageType: "done" | "error";
}

class ConcreteRecoveryScope implements TerminalDispatchRecoveryScope {
  active = true;
  stateReleased = false;
  localClaim?: LocalClaimFacts;

  constructor(
    readonly storeDir: string,
    readonly statePath: string,
    readonly logPath: string,
    readonly terminalControl: TerminalControlRef,
    readonly releaseState: () => void
  ) {}
}

/** Bind typed recovery decisions to the existing CLI transaction boundary. */
export function createTerminalDispatchRecoveryCliAdapter(
  dependencies: TerminalDispatchRecoveryCliDependencies
): TerminalDispatchRecoveryCliFacade {
  const application = new TerminalDispatchRecoveryCliApplication(dependencies);
  return Object.freeze({
    loadOwner: (ledger) => application.loadOwner(ledger),
    assertManagedOwner: (input) => application.assertManagedOwner(input),
    assertNativeThreadStoreAuthority: (input) =>
      application.assertNativeThreadStoreAuthority(input),
    orphanedForRecovery: (control) => application.orphanedForRecovery(control),
    bindingFields: (conversation) => application.bindingFields(conversation),
    reconcilePrepared: (control, ledger) =>
      application.reconcilePrepared(control, ledger),
    isVerifiedDead: (conversation) => application.isVerifiedDead(conversation),
    exactVerifiedDeadAuthority: (input) =>
      application.exactVerifiedDeadAuthority(input),
    ensureVerifiedDeadEvent: (input) =>
      application.ensureVerifiedDeadEvent(input),
    ensureVerifiedDeadClosedEvent: (input) =>
      application.ensureVerifiedDeadClosedEvent(input),
    assertVerifiedDeadDispatch: (input) =>
      application.assertVerifiedDeadDispatch(input),
    resolveVerifiedDeadDispatch: (input) =>
      application.resolveVerifiedDeadDispatch(input),
    stallAccepted: (input) => application.stallAccepted(input),
    settleLocalCompletion: (input) =>
      application.settleLocalCompletion(input),
    prepareCompletion: (input) => application.prepareCompletion(input),
    readEvents: (logPath) => application.readEvents(logPath)
  });
}

class TerminalDispatchRecoveryCliApplication {
  readonly #dependencies: TerminalDispatchRecoveryCliDependencies;
  readonly #stateFileLock = createFileLockCliAdapter({
    now: cliNow,
    nowMs: cliNowMs,
    pid: cliPid,
    sleepSync: cliSleepSync
  });
  readonly #optionsByRequest = new WeakMap<object, Record<string, any>>();
  readonly #optionsByScope =
    new WeakMap<ConcreteRecoveryScope, Record<string, any>>();
  readonly #service: TerminalDispatchRecoveryService<PreparedCallback>;

  constructor(dependencies: TerminalDispatchRecoveryCliDependencies) {
    this.#dependencies = dependencies;
    this.#service = new TerminalDispatchRecoveryService(
      this.#servicePorts()
    );
  }

  #servicePorts(): TerminalDispatchRecoveryPorts<PreparedCallback> {
    return {
      transaction: this.#transactionPorts(),
      authority: this.#authorityPorts(),
      evidence: this.#evidencePorts(),
      state: this.#statePorts(),
      completion: this.#completionPorts()
    };
  }

  #transactionPorts():
    TerminalDispatchRecoveryPorts<PreparedCallback>["transaction"] {
    return {
      verifiedDead: (request, operation) =>
        this.#withVerifiedDeadTransaction(request, operation),
      localCompletion: (request, operation) =>
        this.#withLocalCompletionTransaction(request, operation)
    };
  }

  #authorityPorts():
    TerminalDispatchRecoveryPorts<PreparedCallback>["authority"] {
    return {
      assertBinding: ({ scope, conversation }) => {
        this.#activeScope(scope);
        this.#dependencies.authority.assertTurnBindingCurrent(
          conversation,
          "stall a verified-dead agent Turn for"
        );
      },
      basicAcceptedDispatch: (context) =>
        this.#basicVerifiedDeadDispatchExact(context),
      assertAcceptedDispatch: (context) => {
        const scope = this.#activeScope(context.scope);
        this.assertVerifiedDeadDispatch({
          terminalControl: scope.terminalControl,
          conversation: context.conversation,
          storeDir: scope.storeDir,
          statePath: scope.statePath,
          logPath: scope.logPath,
          expectedMessageId: required(
            nonBlankString(context.messageId),
            "verified-dead stall has no terminal message id"
          )
        });
      },
      persistedDeath: (context) => this.exactVerifiedDeadAuthority({
        conversation: context.conversation,
        storeDir: this.#activeScope(context.scope).storeDir,
        terminalControl: context.terminalControl,
        logPath: this.#activeScope(context.scope).logPath
      }),
      observeDeath: (context) => this.#dependencies.observation.process({
        options: this.#scopeOptions(context.scope),
        conversation: context.conversation,
        terminalControl: context.terminalControl
      }),
      priorStall: ({ context, proof, evidenceId, reason }) =>
        this.#verifiedDeadStalledEventDecision({
          logPath: this.#activeScope(context.scope).logPath,
          proof,
          evidenceId,
          reason
        }),
      durableCompletion: (context) =>
        this.#dependencies.observation.completion({
          options: this.#scopeOptions(context.scope),
          conversation: context.conversation,
          terminalControl: context.terminalControl
        }),
      assertLocalCompletion: (context) =>
        this.#assertLocalCompletion(context)
    };
  }

  #evidencePorts():
    TerminalDispatchRecoveryPorts<PreparedCallback>["evidence"] {
    return {
      ensureDeath: ({ context, proof }) => this.ensureVerifiedDeadEvent({
        logPath: this.#activeScope(context.scope).logPath,
        proof,
        action: "monitor_reconciliation"
      }),
      ensureStall: (input) => this.#ensureVerifiedDeadStalledEvent({
        logPath: this.#activeScope(input.context.scope).logPath,
        proof: input.proof,
        evidenceId: input.evidenceId,
        reason: input.reason,
        terminalControl: input.context.terminalControl,
        completionObservation: input.completionObservation
      })
    };
  }

  #statePorts(): TerminalDispatchRecoveryPorts<PreparedCallback>["state"] {
    return {
      save: (context, conversation) => {
        const scope = this.#activeScope(context.scope);
        this.#assertStateHeld(scope);
        saveState(scope.statePath, conversation);
      },
      crashAfterStallEvents: () => {
        if (cliEnv().AKK_TEST_EXIT_AFTER_VERIFIED_DEAD_STALL_EVENTS === "1") {
          cliExit(86);
        }
      },
      logDeath: ({ context, proof, reason }) => {
        this.#activeScope(context.scope);
        cliRuntimeLog("warn", "terminal_agent_process_verified_dead", {
          conversation_id: context.conversation.conversation_id,
          terminal_target: context.terminalControl.target,
          pid: proof.pid,
          reason
        });
      },
      settleLocalCompletion: (context) =>
        this.#persistLocalCompletion(context)
    };
  }

  #completionPorts():
    TerminalDispatchRecoveryPorts<PreparedCallback>["completion"] {
    return {
      prepareAfterStateRelease: (context, completion) => {
        const scope = this.#activeScope(context.scope);
        this.#releaseStateClaim(scope);
        return this.#dependencies.completion.prepare({
          options: this.#scopeOptions(scope),
          statePath: scope.statePath,
          logPath: scope.logPath,
          conversation: context.conversation,
          executor: executorForConversation(context.conversation),
          terminalControl: context.terminalControl,
          terminalMessageId: required(
            nonBlankString(context.messageId),
            "verified-dead completion has no terminal message id"
          ),
          completion
        });
      }
    };
  }

  #scopeOptions(scope: TerminalDispatchRecoveryScope): Record<string, any> {
    return required(
      this.#optionsByScope.get(this.#activeScope(scope)),
      "verified-dead recovery options are unavailable"
    );
  }

  bindingFields(conversation: Conversation): TerminalDispatchLedgerDocument {
    return { ...this.#bindingFacts(conversation) };
  }

  assertNativeThreadStoreAuthority(input: {
    terminalControl: TerminalControlRef;
    nativeThreadId: string;
    storeDir: string;
  }): void {
    const ledger = this.#dependencies.repository.reconcileIncarnation(
      input.terminalControl,
      this.#dependencies.repository.load(input.terminalControl)
    );
    if (!ledger) return;
    if (!this.#dependencies.repository.matchesControl(
      ledger, input.terminalControl, { requireProcessAnchor: false }
    )) {
      throw new Error(
        `terminal ${input.terminalControl.target} dispatch ledger selector is invalid`
      );
    }
    const binding = isRecord(ledger.binding) ? ledger.binding : undefined;
    const authorityIds = new Set([
      nonBlankString(ledger.native_thread_id),
      nonBlankString(binding?.native_thread_id),
      nonBlankString(ledger.before_native_thread_id),
      nonBlankString(ledger.target_native_thread_id)
    ].filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()));
    const nativeThreadId = input.nativeThreadId.toLowerCase();
    if (!authorityIds.has(nativeThreadId)) return;
    const authorityStoreDir = this.#ledgerStoreDir(ledger);
    if (!authorityStoreDir) {
      throw new Error(
        `terminal ${input.terminalControl.target} has native-thread authority ` +
        `${nativeThreadId} whose Store cannot be verified`
      );
    }
    if (path.resolve(authorityStoreDir) !== path.resolve(input.storeDir)) {
      throw new Error(
        `terminal ${input.terminalControl.target} native thread ` +
        `${nativeThreadId} is authoritative in another Store ` +
        `${path.resolve(authorityStoreDir)}`
      );
    }
  }

  orphanedForRecovery(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined {
    try {
      const ledger = this.#dependencies.repository.load(terminalControl);
      const lifecycle = terminalDispatchLedgerLooksLifecycle(ledger);
      const recoveryIdentity = lifecycle
        ? nonBlankString(ledger?.transition_id)
        : nonBlankString(ledger?.message_id);
      if (
        !ledger ||
        !isRecoverableTerminalDispatchStatus(String(ledger.status)) ||
        !recoveryIdentity ||
        (!lifecycle && this.#dependencies.repository.matchesControl(
          ledger, terminalControl, { requireProcessAnchor: false }
        ) && !this.#dependencies.repository.matchesControl(ledger, terminalControl)) ||
        (!lifecycle && this.loadOwner(ledger))
      ) return undefined;
      return lifecycle ? { ...ledger, kind: "lifecycle" } : ledger;
    } catch {
      return undefined;
    }
  }

  #ledgerStoreDir(ledger: TerminalDispatchLedgerDocument): string | undefined {
    const stored = nonBlankString(ledger.store_dir);
    if (stored) return stored;
    const statePath = nonBlankString(ledger.state_path);
    if (!statePath) return undefined;
    try {
      return pathsForConversationDir(path.dirname(path.resolve(statePath))).storeDir;
    } catch {
      return undefined;
    }
  }

  loadOwner(
    ledger: TerminalDispatchLedgerDocument
  ): Conversation | undefined {
    const statePath = nonBlankString(ledger.state_path);
    if (!statePath) return undefined;
    try {
      const conversation = loadState(statePath);
      return conversation.conversation_id === nonBlankString(ledger.conversation_id)
        ? conversation
        : undefined;
    } catch {
      return undefined;
    }
  }

  assertManagedOwner(input: {
    storeDir: string;
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    action: "approve" | "cancel";
  }): void {
    this.#dependencies.authority.assertNoDeferredTransfer({
      storeDir: input.storeDir,
      conversation: input.conversation,
      action: input.action
    });
    this.#dependencies.authority.assertTurnBindingCurrent(
      input.conversation,
      input.action
    );
    const nativeTakeover = takeoverFor(input.conversation);
    const messageId = nonBlankString(
      nativeTakeover?.terminal_bridge_message_id
    );
    const ledger = this.#dependencies.repository.load(input.terminalControl);
    if (
      !messageId || !ledger ||
      !["submitted", "agent_accepted"].includes(String(ledger.status)) ||
      nonBlankString(ledger.conversation_id) !==
        input.conversation.conversation_id ||
      nonBlankString(ledger.message_id) !== messageId ||
      (
        nonBlankString(input.conversation.terminal_binding_id) &&
        (
          nonBlankString(ledger.binding_id) !==
            nonBlankString(input.conversation.terminal_binding_id) ||
          Number(ledger.binding_generation) !==
            Number(input.conversation.terminal_binding_generation) ||
          nonBlankString(ledger.native_thread_id) !==
            (
              nonBlankString(input.conversation.native_thread_id) ??
              nonBlankString(nativeTakeover?.terminal_agent_session_id)
            )
        )
      )
    ) {
      throw new Error(
        `refusing to ${input.action}: this AKK conversation does not own the ` +
        "current terminal dispatch generation; refresh status and operate on " +
        "the current task"
      );
    }
  }

  isVerifiedDead(conversation: Conversation | Record<string, any>): boolean {
    return processDisposition(conversation)?.status === "verified_dead";
  }

  stallAccepted(input: Parameters<
    TerminalDispatchRecoveryCliFacade["stallAccepted"]
  >[0]): Promise<VerifiedDeadRecoveryResult<PreparedCallback>> {
    this.#optionsByRequest.set(input, input.options);
    return this.#service.stallAcceptedForVerifiedDead(input).finally(() => {
      this.#optionsByRequest.delete(input);
    });
  }

  settleLocalCompletion(input: Parameters<
    TerminalDispatchRecoveryCliFacade["settleLocalCompletion"]
  >[0]): LocalCompletionRecoveryResult {
    return this.#service.settleLocalCompletion(input);
  }

  #bindingFacts(conversation: Conversation): TerminalBindingLedgerFacts {
    const takeover = takeoverFor(conversation);
    const bindingId = nonBlankString(conversation.terminal_binding_id);
    const generation = Number(conversation.terminal_binding_generation);
    const nativeThreadId = nonBlankString(conversation.native_thread_id) ??
      nonBlankString(takeover?.terminal_agent_session_id);
    const storeDir = this.#dependencies.authority.storeDirForConversation(conversation);
    const submission = terminalBridgeSubmission(conversation);
    const transferId = nonBlankString(takeover?.deferred_foreground_transfer_id);
    return {
      ...(bindingId ? { binding_id: bindingId } : {}),
      ...(Number.isSafeInteger(generation)
        ? { binding_generation: generation }
        : {}),
      ...(nativeThreadId ? { native_thread_id: nativeThreadId } : {}),
      ...(storeDir ? { store_dir: path.resolve(storeDir) } : {}),
      ...(nonBlankString(submission?.message_type)
        ? { message_type: nonBlankString(submission?.message_type) }
        : {}),
      ...(nonBlankString(submission?.message_body_hash)
        ? { message_body_hash: nonBlankString(submission?.message_body_hash) }
        : {}),
      ...(transferId
        ? { deferred_foreground_transfer_id: transferId }
        : {}),
      executor_kind: executorForConversation(conversation).kind,
      ...(conversation.openclaw_session
        ? { openclaw_session: conversation.openclaw_session }
        : {})
    };
  }

  reconcilePrepared(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument
  ): TerminalDispatchLedgerDocument | undefined {
    if (!ledger || terminalDispatchLedgerLooksLifecycle(ledger)) return ledger;
    if (ledger.status !== "prepared") {
      return this.#reconcileLagging(terminalControl, ledger);
    }
    const dispatcherPid = Number(ledger.dispatcher_pid);
    const dispatcherActive = Number.isSafeInteger(dispatcherPid) &&
      dispatcherPid > 1 && dispatcherPid !== cliPid() &&
      this.#dependencies.runtime.isProcessAlive(dispatcherPid);
    const statePath = nonBlankString(ledger.state_path);
    const messageId = nonBlankString(ledger.message_id);
    let owner: PreparedDispatchOwnerFacts = { status: "unreadable" };
    if (!dispatcherActive && statePath && messageId) {
      owner = this.#preparedOwnerFacts(terminalControl, ledger, statePath);
    }
    const decision = decidePreparedDispatchRecovery({
      ledger: {
        lifecycle: false,
        status: nonBlankString(ledger.status),
        dispatcherPid,
        dispatcherActive,
        statePath,
        eventLogPath: nonBlankString(ledger.event_log_path),
        messageId,
        conversationId: nonBlankString(ledger.conversation_id)
      },
      owner,
      now: () => cliNow().toISOString()
    });
    if (decision.action === "keep") return ledger;
    if (decision.action === "reconcile_lagging") {
      return this.#reconcileLagging(terminalControl, ledger);
    }
    this.#dependencies.repository.save(
      terminalControl,
      decision.action === "replace_ledger"
        ? decision.mutation
        : { ...ledger, ...decision.mutation }
    );
    return this.#dependencies.repository.load(terminalControl);
  }

  #preparedOwnerFacts(
    terminalControl: TerminalControlRef,
    ledger: TerminalDispatchLedgerDocument,
    statePath: string
  ): PreparedDispatchOwnerFacts {
    let conversation: Conversation;
    try {
      conversation = loadState(statePath);
    } catch (error) {
      const code = error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      return code === "ENOENT" ? { status: "missing" } : { status: "unreadable" };
    }
    const takeover = takeoverFor(conversation);
    const storedControl = this.#dependencies.authority.terminalControl(takeover);
    if (
      conversation.conversation_id !== nonBlankString(ledger.conversation_id) ||
      !storedControl ||
      !sameTerminalControlIncarnation(storedControl, terminalControl)
    ) {
      return { status: "mismatch" };
    }
    const submission = terminalBridgeSubmission(conversation);
    const requestText = String(
      takeover?.terminal_bridge_request_text ?? conversation.user_request ?? ""
    );
    return {
      status: "loaded",
      conversationId: conversation.conversation_id,
      updatedAt: nonBlankString(conversation.updated_at),
      storedMessageId: nonBlankString(takeover?.terminal_bridge_message_id),
      submission: submissionFacts(submission),
      binding: this.#bindingFacts(conversation),
      requestHash: terminalBridgeRequestFingerprint(requestText),
      statePath,
      eventLogPath: nonBlankString(ledger.event_log_path) ??
        logPathForStatePath(statePath),
      callbackExpected: Boolean(conversation.gateway_method)
    };
  }

  #reconcileLagging(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument
  ): TerminalDispatchLedgerDocument | undefined {
    const projection = this.#laggingProjection(terminalControl, ledger);
    if (!projection || !ledger) return ledger;
    const decision = decideLaggingDispatchRecovery(projection.input);
    if (decision.action === "keep") return ledger;
    if (decision.action === "save_turn_accepted") {
      const accepted = this.#applySubmissionMutation({
        conversation: projection.conversation,
        messageId: projection.messageId,
        requestText: projection.requestText,
        status: "agent_accepted",
        preparedAt: projection.submission.preparedAt ??
          nonBlankString(ledger.prepared_at) ?? decision.acceptedAt,
        textInjectedAt: projection.submission.textInjectedAt ??
          nonBlankString(ledger.text_injected_at),
        enterDispatchedAt: projection.submission.enterDispatchedAt ??
          nonBlankString(ledger.enter_dispatched_at),
        agentAcceptedAt: decision.acceptedAt,
        acceptanceEvidence: decision.acceptanceEvidence
      });
      saveState(projection.statePath, accepted);
      return ledger;
    }
    if (decision.action === "save_turn_uncertain_and_ledger") {
      const uncertain = this.#applySubmissionMutation({
        conversation: {
          ...projection.conversation,
          status: "stalled",
          stalled_at: decision.uncertainAt,
          stalled_reason: "stored native acceptance evidence is invalid",
          updated_at: decision.uncertainAt
        },
        messageId: projection.messageId,
        requestText: projection.requestText,
        status: "uncertain",
        preparedAt: projection.submission.preparedAt ??
          nonBlankString(ledger.prepared_at) ?? decision.uncertainAt,
        textInjectedAt: projection.submission.textInjectedAt ??
          nonBlankString(ledger.text_injected_at),
        enterDispatchedAt: projection.submission.enterDispatchedAt ??
          nonBlankString(ledger.enter_dispatched_at),
        uncertainAt: decision.uncertainAt,
        error: decision.reason,
        lastProvenStage: "enter_dispatched"
      });
      saveState(projection.statePath, uncertain);
      this.#dependencies.repository.save(terminalControl, {
        ...ledger,
        ...decision.ledger
      });
      return this.#dependencies.repository.load(terminalControl);
    }
    this.#dependencies.repository.save(terminalControl, {
      ...ledger,
      ...decision.mutation
    });
    return this.#dependencies.repository.load(terminalControl);
  }

  #laggingProjection(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument
  ): {
    input: LaggingDispatchRecoveryInput;
    conversation: Conversation;
    submission: TerminalSubmissionRecoveryFacts;
    statePath: string;
    messageId: string;
    requestText: string;
  } | undefined {
    if (!ledger || terminalDispatchLedgerLooksLifecycle(ledger) || ![
      "text_injected",
      "enter_dispatched",
      "submitted",
      "agent_accepted",
      "not_accepted",
      "uncertain"
    ].includes(String(ledger.status))) return undefined;
    const statePath = nonBlankString(ledger.state_path);
    const messageId = nonBlankString(ledger.message_id);
    if (!statePath || !messageId) return undefined;
    let conversation: Conversation;
    try {
      conversation = loadState(statePath);
    } catch {
      return undefined;
    }
    const takeover = takeoverFor(conversation);
    const rawSubmission = terminalBridgeSubmission(conversation);
    const storedControl = this.#dependencies.authority.terminalControl(takeover);
    if (
      conversation.conversation_id !== nonBlankString(ledger.conversation_id) ||
      nonBlankString(takeover?.terminal_bridge_message_id) !== messageId ||
      nonBlankString(rawSubmission?.message_id) !== messageId ||
      !storedControl ||
      !sameTerminalControlIncarnation(storedControl, terminalControl)
    ) return undefined;
    const requestText = String(
      takeover?.terminal_bridge_request_text ?? conversation.user_request ?? ""
    );
    const requestHash = terminalBridgeRequestFingerprint(requestText);
    if (
      nonBlankString(ledger.request_hash) !== requestHash ||
      nonBlankString(rawSubmission?.request_hash) !== requestHash
    ) return undefined;
    const binding = this.#bindingFacts(conversation);
    if (!bindingCompatible(ledger, binding)) return undefined;
    const submission = submissionFacts(rawSubmission);
    const acceptance = acceptanceProjection(
      conversation,
      requestText,
      String(ledger.status),
      rawSubmission,
      ledger
    );
    return {
      input: {
        eligible: true,
        ledgerStatus: String(ledger.status),
        stateStatus: submission.status,
        stateAcceptance: acceptance.state,
        ledgerAcceptance: acceptance.ledger,
        ledgerAcceptanceError: acceptance.ledgerError,
        ledgerAgentAcceptedAt: nonBlankString(ledger.agent_accepted_at),
        ledgerLastProvenStage: nonBlankString(ledger.last_proven_stage),
        submission,
        binding,
        now: cliNow().toISOString()
      },
      conversation,
      submission,
      statePath,
      messageId,
      requestText
    };
  }

  #withVerifiedDeadTransaction(
    request: {
      storeDir: string;
      statePath: string;
      logPath: string;
      expectedConversationId: string;
      expectedMessageId?: string;
    },
    operation: (
      context: VerifiedDeadRecoveryContext
    ) => Promise<VerifiedDeadRecoveryResult<PreparedCallback>>
  ): Promise<VerifiedDeadRecoveryResult<PreparedCallback>> {
    const canonicalStoreDir = pathsForConversationDir(
      path.dirname(request.statePath)
    ).storeDir;
    if (path.resolve(request.storeDir) !== path.resolve(canonicalStoreDir)) {
      return Promise.resolve(unchangedVerifiedDead(
        loadState(request.statePath),
        "dead_process_stall_store_mismatch"
      ));
    }
    const initial = loadState(request.statePath);
    const control = this.#dependencies.authority.terminalControl(takeoverFor(initial));
    if (
      initial.conversation_id !== request.expectedConversationId ||
      !control ||
      !acceptedTurnCanBeStalled(request.storeDir, initial)
    ) {
      return Promise.resolve(unchangedVerifiedDead(
        initial,
        "dead_process_stall_not_applicable"
      ));
    }
    return this.#withVerifiedDeadLocks(request, control, operation);
  }

  async #withVerifiedDeadLocks(
    request: {
      storeDir: string;
      statePath: string;
      logPath: string;
      expectedConversationId: string;
      expectedMessageId?: string;
    },
    control: TerminalControlRef,
    operation: (
      context: VerifiedDeadRecoveryContext
    ) => Promise<VerifiedDeadRecoveryResult<PreparedCallback>>
  ): Promise<VerifiedDeadRecoveryResult<PreparedCallback>> {
    const releaseTerminal = this.#dependencies.repository.acquire(
      request.storeDir,
      control,
      { timeoutMs: 30000 }
    );
    try {
      return await withStoreWriterLeaseAsync(request.storeDir, async () => {
        const releaseState = this.#stateFileLock.acquire(`${request.statePath}.lock`);
        let stateReleased = false;
        const releaseStateOnce = () => {
          if (stateReleased) return;
          releaseState();
          stateReleased = true;
        };
        try {
          const current = loadState(request.statePath);
          const takeover = takeoverFor(current);
          const currentControl =
            this.#dependencies.authority.terminalControl(takeover);
          const messageId = nonBlankString(takeover?.terminal_bridge_message_id);
          if (
            current.conversation_id !== request.expectedConversationId ||
            (request.expectedMessageId !== undefined &&
              messageId !== request.expectedMessageId) ||
            !currentControl ||
            !terminalControlsShareIncarnation(currentControl, control) ||
            !acceptedTurnCanBeStalled(request.storeDir, current)
          ) {
            return unchangedVerifiedDead(
              current,
              "dead_process_stall_generation_changed"
            );
          }
          const scope = new ConcreteRecoveryScope(
            request.storeDir,
            request.statePath,
            request.logPath,
            currentControl,
            releaseStateOnce
          );
          this.#optionsByScope.set(scope, required(
            this.#optionsByRequest.get(request),
            "verified-dead recovery options are unavailable"
          ));
          try {
            return await operation({
              scope,
              conversation: current,
              terminalControl: currentControl,
              messageId: messageId ?? ""
            });
          } finally {
            scope.active = false;
            if (!scope.stateReleased) this.#releaseStateClaim(scope);
            this.#optionsByScope.delete(scope);
          }
        } finally {
          releaseStateOnce();
        }
      });
    } finally {
      releaseTerminal();
    }
  }

  #withLocalCompletionTransaction(
    request: { storeDir: string; statePath: string; logPath: string },
    operation: (
      context: LocalCompletionRecoveryContext
    ) => LocalCompletionRecoveryResult
  ): LocalCompletionRecoveryResult {
    const initial = loadState(request.statePath);
    const claim = completionClaim(initial);
    if (
      nonBlankString(initial.gateway_method) ||
      !claim ||
      !["idle", "failed"].includes(String(initial.status))
    ) return localNotApplicable();
    const terminalControl = this.#dependencies.authority.terminalControl(
      takeoverFor(initial)
    );
    if (!terminalControl) {
      throw new Error(
        `local terminal completion ${initial.conversation_id} lost its terminal authority`
      );
    }
    const releaseTerminal = this.#dependencies.repository.acquire(
      request.storeDir,
      terminalControl,
      { timeoutMs: 30000 }
    );
    try {
      return withStoreWriterLease(request.storeDir, () => {
        const releaseState = this.#stateFileLock.acquire(`${request.statePath}.lock`);
        let stateReleased = false;
        const releaseStateOnce = () => {
          if (stateReleased) return;
          releaseState();
          stateReleased = true;
        };
        try {
          const conversation = loadState(request.statePath);
          const scope = new ConcreteRecoveryScope(
            request.storeDir,
            request.statePath,
            request.logPath,
            terminalControl,
            releaseStateOnce
          );
          try {
            const context = this.#localCompletionContext(scope, conversation);
            return operation(context);
          } finally {
            scope.active = false;
            if (!scope.stateReleased) this.#releaseStateClaim(scope);
          }
        } finally {
          releaseStateOnce();
        }
      });
    } finally {
      releaseTerminal();
    }
  }

  #localCompletionContext(
    scope: ConcreteRecoveryScope,
    conversation: Conversation
  ): LocalCompletionRecoveryContext {
    const takeover = takeoverFor(conversation);
    const claim = completionClaim(conversation);
    const control = this.#dependencies.authority.terminalControl(takeover);
    const terminalMessageId = nonBlankString(takeover?.terminal_bridge_message_id);
    const callbackMessageId = nonBlankString(claim?.callback_message_id);
    const completionFingerprint = nonBlankString(claim?.completion_fingerprint);
    const completionId = nonBlankString(claim?.completion_id);
    const claimedAt = nonBlankString(claim?.claimed_at);
    const outcome = nonBlankString(claim?.outcome);
    const expectedMessageType = outcome === "success"
      ? "done"
      : outcome === "failure" ? "error" : undefined;
    if (
      nonBlankString(conversation.gateway_method) ||
      conversation.callback_delivery !== undefined ||
      !claim ||
      !control ||
      !terminalControlsShareIncarnation(control, scope.terminalControl) ||
      !terminalMessageId || !callbackMessageId || !completionFingerprint ||
      !completionId || !claimedAt || !validTimestamp(claimedAt) ||
      !expectedMessageType ||
      (outcome === "success" && conversation.status !== "idle") ||
      (outcome === "failure" && conversation.status !== "failed") ||
      deterministicTerminalCallbackMessageId({
        conversationId: conversation.conversation_id,
        terminalMessageId,
        completionFingerprint,
        outcome: outcome!
      }) !== callbackMessageId
    ) {
      throw new Error(
        `local terminal completion ${conversation.conversation_id} has ` +
          "inconsistent claim, Turn phase, or callback authority"
      );
    }
    scope.localClaim = {
      completionFingerprint,
      completionId,
      callbackMessageId,
      claimedAt,
      outcome: outcome!,
      expectedMessageType
    };
    return {
      scope,
      conversation,
      terminalControl: control,
      terminalMessageId,
      completionId,
      callbackMessageId,
      outcome: outcome!
    };
  }

  #assertLocalCompletion(
    context: LocalCompletionRecoveryContext
  ): { ledgerResolved: boolean } {
    const scope = this.#activeScope(context.scope);
    this.#assertStateHeld(scope);
    const claim = required(scope.localClaim, "local completion claim is unavailable");
    const conversation = context.conversation;
    const submission = terminalBridgeSubmission(conversation);
    if (
      submission?.status !== "agent_accepted" ||
      nonBlankString(submission.message_id) !== context.terminalMessageId ||
      nonBlankString(submission.session_id) !== sessionIdForConversation(conversation) ||
      nonBlankString(submission.turn_id) !== turnIdForConversation(conversation)
    ) {
      throw new Error(
        `local terminal completion ${conversation.conversation_id} is ` +
          "not tied to one accepted terminal submission"
      );
    }
    this.#assertLocalCompletionEvents(scope, context, claim);
    const ledger = this.#dependencies.repository.load(context.terminalControl);
    if (!this.#localCompletionLedgerExact(scope, context, ledger)) {
      throw new Error(
        `local terminal completion ${conversation.conversation_id} has ` +
          "no exact accepted terminal ledger"
      );
    }
    return { ledgerResolved: ledger?.status === "resolved" };
  }

  #assertLocalCompletionEvents(
    scope: ConcreteRecoveryScope,
    context: LocalCompletionRecoveryContext,
    claim: LocalClaimFacts
  ): void {
    const events = this.readEvents(scope.logPath);
    const claimed = events.some((event) =>
      event.event === "terminal_bridge_completion_claimed" &&
      event.conversation_id === context.conversation.conversation_id &&
      event.terminal_bridge_message_id === context.terminalMessageId &&
      event.completion_fingerprint === claim.completionFingerprint &&
      event.completion_id === context.completionId &&
      event.callback_message_id === context.callbackMessageId &&
      event.outcome === context.outcome && event.ts === claim.claimedAt
    );
    const detected = events.some((event) =>
      event.event === "terminal_bridge_completion_detected" &&
      event.conversation_id === context.conversation.conversation_id &&
      event.terminal_bridge_message_id === context.terminalMessageId &&
      event.completion_id === context.completionId &&
      event.callback_message_id === context.callbackMessageId &&
      event.completion_outcome === context.outcome
    );
    const messageRecorded = events.some((event) => {
      const message = isRecord(event.message) ? event.message : undefined;
      const metadata = isRecord(message?.metadata) ? message.metadata : undefined;
      return event.event === "message" &&
        event.conversation_id === context.conversation.conversation_id &&
        event.session_id === sessionIdForConversation(context.conversation) &&
        event.turn_id === turnIdForConversation(context.conversation) &&
        message?.id === context.callbackMessageId &&
        message?.type === claim.expectedMessageType &&
        message?.to === "openclaw" && message?.requires_response === false &&
        metadata?.terminal_bridge_message_id === context.terminalMessageId;
    });
    if (!claimed || !detected || !messageRecorded) {
      throw new Error(
        `local terminal completion ${context.conversation.conversation_id} is ` +
          "missing exact claim, detection, or message evidence"
      );
    }
  }

  #localCompletionLedgerExact(
    scope: ConcreteRecoveryScope,
    context: LocalCompletionRecoveryContext,
    ledger?: TerminalDispatchLedgerDocument
  ): boolean {
    const conversation = context.conversation;
    const bindingId = nonBlankString(conversation.terminal_binding_id);
    const generation = Number(conversation.terminal_binding_generation);
    return Boolean(
      ledger && ["agent_accepted", "resolved"].includes(String(ledger.status)) &&
      this.#dependencies.repository.matchesControl(ledger, context.terminalControl) &&
      nonBlankString(ledger.conversation_id) === conversation.conversation_id &&
      nonBlankString(ledger.session_id) === sessionIdForConversation(conversation) &&
      nonBlankString(ledger.turn_id) === turnIdForConversation(conversation) &&
      nonBlankString(ledger.message_id) === context.terminalMessageId &&
      nonBlankString(ledger.native_thread_id) ===
        nonBlankString(conversation.native_thread_id) &&
      (bindingId === undefined || nonBlankString(ledger.binding_id) === bindingId) &&
      (!Number.isSafeInteger(generation) || Number(ledger.binding_generation) === generation) &&
      path.resolve(nonBlankString(ledger.store_dir) ?? "") === path.resolve(scope.storeDir) &&
      sameCanonicalStatePath(ledger.state_path, scope.statePath)
    );
  }

  #persistLocalCompletion(context: LocalCompletionRecoveryContext): void {
    const scope = this.#activeScope(context.scope);
    this.#assertStateHeld(scope);
    if (!this.#dependencies.repository.resolve(context.terminalControl, {
      conversation: context.conversation,
      expectedMessageId: context.terminalMessageId,
      reason: "callbackless terminal bridge task reached durable completion"
    })) {
      throw new Error(
        `local terminal completion ${context.conversation.conversation_id} ` +
          "changed before ledger settlement"
      );
    }
    appendEvent(scope.logPath, {
      ts: cliNow().toISOString(),
      conversation_id: context.conversation.conversation_id,
      event: "terminal_bridge_local_completion_settled",
      terminal_bridge_message_id: context.terminalMessageId,
      completion_id: context.completionId,
      callback_message_id: context.callbackMessageId,
      outcome: context.outcome
    });
  }

  exactVerifiedDeadAuthority(input: {
    conversation: Conversation;
    storeDir: string;
    terminalControl: TerminalControlRef;
    logPath: string;
  }): VerifiedDeadAgentAuthorityDecision {
    const stored = this.#storedVerifiedDeadAuthority(input);
    if (stored.status === "invalid") return stored;
    return reconcileVerifiedDeadAgentAuthority({
      stored,
      event: this.#eventVerifiedDeadAuthority(input)
    });
  }

  #storedVerifiedDeadAuthority(input: {
    conversation: Conversation;
    storeDir: string;
    terminalControl: TerminalControlRef;
  }): VerifiedDeadAgentAuthorityDecision {
    const disposition = processDisposition(input.conversation);
    if (disposition?.status !== "verified_dead") return { status: "absent" };
    return validateStoredVerifiedDeadAgentAuthority({
      disposition,
      context: this.#verifiedDeadAuthorityContext(input)
    });
  }

  #eventVerifiedDeadAuthority(input: {
    conversation: Conversation;
    storeDir: string;
    terminalControl: TerminalControlRef;
    logPath: string;
  }): VerifiedDeadAgentAuthorityDecision {
    const candidate = selectVerifiedDeadAgentEvent({
      events: this.readEvents(input.logPath),
      conversationId: input.conversation.conversation_id
    });
    if (candidate.status !== "candidate") return candidate;
    return validateVerifiedDeadAgentEventAuthority({
      candidate,
      context: this.#verifiedDeadAuthorityContext(input)
    });
  }

  #verifiedDeadAuthorityContext(input: {
    conversation: Conversation;
    storeDir: string;
    terminalControl: TerminalControlRef;
  }): VerifiedDeadAgentAuthorityContext {
    const { conversation } = input;
    const takeover = takeoverFor(conversation);
    const submission = terminalBridgeSubmission(conversation);
    const session = tryLoadManagedSession(
      input.storeDir,
      sessionIdForConversation(conversation)
    );
    const binding = session?.binding;
    return {
      terminalControl: input.terminalControl,
      conversation: {
        agent: executorForConversation(conversation).kind,
        conversationId: conversation.conversation_id,
        sessionId: sessionIdForConversation(conversation),
        turnId: turnIdForConversation(conversation),
        bindingId: nonBlankString(conversation.terminal_binding_id),
        bindingGeneration: Number(conversation.terminal_binding_generation)
      },
      ...(session ? { session: {
        status: session.status,
        agent: session.agent,
        workspaceMatchesConversation:
          path.resolve(session.workspace) === path.resolve(conversation.workspace),
        ...(binding ? { binding: {
          terminalControl: binding.terminal_control,
          pid: binding.native_process.pid,
          processUuid: binding.native_process.process_uuid,
          processBirth: binding.native_process.process_birth,
          bindingId: binding.binding_id,
          generation: binding.generation
        } } : {})
      } } : {}),
      ...(takeover ? { takeover: {
        pid: Number(takeover.terminal_agent_pid),
        processUuid: nonBlankString(takeover.terminal_agent_process_uuid),
        processBirth: nonBlankString(takeover.terminal_agent_process_birth),
        bindingId: nonBlankString(takeover.terminal_binding_id),
        bindingGeneration: Number(takeover.terminal_binding_generation),
        messageId: nonBlankString(takeover.terminal_bridge_message_id)
      } } : {}),
      ...(submission ? { submission: {
        status: nonBlankString(submission.status),
        sessionId: nonBlankString(submission.session_id),
        turnId: nonBlankString(submission.turn_id),
        messageId: nonBlankString(submission.message_id),
        bindingId: nonBlankString(submission.binding_id),
        bindingGeneration: Number(submission.binding_generation)
      } } : {})
    };
  }

  ensureVerifiedDeadEvent(input: {
    logPath: string;
    proof: VerifiedDeadTerminalAgentProcessProof;
    action: "managed_close" | "monitor_reconciliation";
  }) {
    const evidenceId = verifiedDeadTerminalAgentProcessEvidenceId(input.proof);
    const existing = this.readEvents(input.logPath).find((event) =>
      event.event === "terminal_agent_process_verified_dead" &&
      event.conversation_id === input.proof.conversation_id &&
      event.evidence_id === evidenceId
    );
    if (existing) {
      const proof = isRecord(existing.proof)
        ? existing.proof as VerifiedDeadTerminalAgentProcessProof
        : undefined;
      const recordedAt = nonBlankString(existing.ts);
      if (!proof || !recordedAt || !validTimestamp(recordedAt) ||
        proof.observed_at !== recordedAt ||
        verifiedDeadTerminalAgentProcessEvidenceId(proof) !== evidenceId) {
        throw new Error(`verified-dead process event ${evidenceId} is inconsistent`);
      }
      return { proof, evidenceId, recordedAt };
    }
    appendEvent(input.logPath, {
      ts: input.proof.observed_at,
      conversation_id: input.proof.conversation_id,
      event: "terminal_agent_process_verified_dead",
      evidence_id: evidenceId,
      status: "verified_dead",
      proof: input.proof,
      action: input.action
    });
    return {
      proof: input.proof,
      evidenceId,
      recordedAt: input.proof.observed_at
    };
  }

  #ensureVerifiedDeadStalledEvent(input: {
    logPath: string;
    proof: VerifiedDeadTerminalAgentProcessProof;
    evidenceId: string;
    reason: string;
    terminalControl: TerminalControlRef;
    completionObservation: "absent" | "unverifiable";
  }): void {
    const existing = this.readEvents(input.logPath).find((event) =>
      event.event === "conversation_stalled" &&
      event.conversation_id === input.proof.conversation_id &&
      event.evidence_id === input.evidenceId
    );
    if (existing) {
      if (existing.ts !== input.proof.observed_at ||
        existing.reason !== input.reason ||
        existing.disposition !== "verified_dead_agent_process" ||
        existing.completion_observation !== input.completionObservation) {
        throw new Error(
          `verified-dead stalled event ${input.evidenceId} is inconsistent`
        );
      }
      return;
    }
    appendEvent(input.logPath, {
      ts: input.proof.observed_at,
      conversation_id: input.proof.conversation_id,
      event: "conversation_stalled",
      evidence_id: input.evidenceId,
      status: "stalled",
      reason: input.reason,
      terminal_bridge: true,
      terminal_control: input.terminalControl,
      disposition: "verified_dead_agent_process",
      completion_observation: input.completionObservation
    });
  }

  #verifiedDeadStalledEventDecision(input: {
    logPath: string;
    proof: VerifiedDeadTerminalAgentProcessProof;
    evidenceId: string;
    reason: string;
  }):
    | { status: "absent" }
    | { status: "valid"; completionObservation: "absent" | "unverifiable" }
    | { status: "invalid"; reason: string } {
    const candidates = this.readEvents(input.logPath).filter((event) =>
      event.event === "conversation_stalled" &&
      event.conversation_id === input.proof.conversation_id &&
      event.evidence_id === input.evidenceId
    );
    if (candidates.length === 0) return { status: "absent" };
    if (candidates.length !== 1) return {
      status: "invalid",
      reason: "the verified-dead stalled event history is ambiguous"
    };
    const event = candidates[0];
    const observation = nonBlankString(event.completion_observation);
    if (event.ts !== input.proof.observed_at || event.status !== "stalled" ||
      event.reason !== input.reason ||
      event.disposition !== "verified_dead_agent_process" ||
      !["absent", "unverifiable"].includes(observation ?? "")) {
      return {
        status: "invalid",
        reason: "the verified-dead stalled event decision is inconsistent"
      };
    }
    return {
      status: "valid",
      completionObservation: observation as "absent" | "unverifiable"
    };
  }

  ensureVerifiedDeadClosedEvent(input: {
    logPath: string;
    conversation: Conversation;
    evidenceId: string;
  }): void {
    const closedAt = required(
      nonBlankString(input.conversation.closed_at),
      "verified-dead closed Turn has no closed_at timestamp"
    );
    const reason = required(
      nonBlankString(input.conversation.close_reason),
      "verified-dead closed Turn has no close reason"
    );
    if (input.conversation.status !== "closed" || !validTimestamp(closedAt)) {
      throw new Error("verified-dead closed Turn state is inconsistent");
    }
    const existing = this.readEvents(input.logPath).find((event) =>
      event.event === "conversation_closed" &&
      event.conversation_id === input.conversation.conversation_id &&
      event.evidence_id === input.evidenceId
    );
    if (existing) {
      if (existing.ts !== closedAt || existing.status !== "closed" ||
        existing.reason !== reason ||
        existing.disposition !== "verified_dead_agent_process") {
        throw new Error(
          `verified-dead close event ${input.evidenceId} is inconsistent`
        );
      }
      return;
    }
    appendEvent(input.logPath, {
      ts: closedAt,
      conversation_id: input.conversation.conversation_id,
      event: "conversation_closed",
      evidence_id: input.evidenceId,
      status: "closed",
      reason,
      disposition: "verified_dead_agent_process"
    });
  }

  #basicVerifiedDeadDispatchExact(
    context: VerifiedDeadRecoveryContext
  ): boolean {
    const scope = this.#activeScope(context.scope);
    const ledger = this.#dependencies.repository.load(context.terminalControl);
    return Boolean(
      ledger && nonBlankString(ledger.status) === "agent_accepted" &&
      sameCanonicalStatePath(ledger.state_path, scope.statePath) &&
      path.resolve(nonBlankString(ledger.store_dir) ?? "") ===
        path.resolve(scope.storeDir) &&
      path.resolve(nonBlankString(ledger.event_log_path) ?? "") ===
        path.resolve(scope.logPath) &&
      nonBlankString(ledger.conversation_id) ===
        context.conversation.conversation_id &&
      nonBlankString(ledger.session_id) ===
        sessionIdForConversation(context.conversation) &&
      nonBlankString(ledger.turn_id) ===
        turnIdForConversation(context.conversation) &&
      nonBlankString(ledger.message_id) === context.messageId &&
      this.#dependencies.repository.matchesControl(
        ledger,
        context.terminalControl,
        { requireProcessAnchor: true }
      ) &&
      this.#dependencies.repository.processAnchor(ledger) ===
        terminalEndpointFromControlRef(
          context.terminalControl
        ).processAnchorPid &&
      nonBlankString(ledger.binding_id) ===
        nonBlankString(context.conversation.terminal_binding_id) &&
      Number(ledger.binding_generation) ===
        Number(context.conversation.terminal_binding_generation)
    );
  }

  assertVerifiedDeadDispatch(
    input: VerifiedDeadDispatchRequest
  ): { ledger: TerminalDispatchLedgerDocument; resolved: boolean } {
    this.#dependencies.authority.assertTurnBindingCurrent(
      input.conversation,
      "resolve a verified-dead agent dispatch for"
    );
    const takeover = takeoverFor(input.conversation);
    const submission = terminalBridgeSubmission(input.conversation);
    const expected = acceptedDispatchExpectation(input, takeover, submission);
    if (!stateDispatchCoreAuthorityExact(input, submission, expected)) {
      throw stateDispatchAuthorityError(input.conversation.conversation_id);
    }
    const conversationStoreDir =
      this.#dependencies.authority.storeDirForConversation(input.conversation);
    if (
      path.resolve(conversationStoreDir ?? "") !== path.resolve(input.storeDir)
    ) {
      throw stateDispatchAuthorityError(input.conversation.conversation_id);
    }
    const ledger = this.#dependencies.repository.load(input.terminalControl);
    if (!ledgerDispatchCoreAuthorityExact(
      input,
      ledger,
      expected,
      this.#dependencies.repository
    )) {
      throw ledgerDispatchAuthorityError(input.conversation.conversation_id);
    }
    if (!stateDispatchReceiptAuthorityExact(input, submission)) {
      throw stateDispatchAuthorityError(input.conversation.conversation_id);
    }
    const ledgerReceipt = ledgerDispatchReceiptAuthority(
      input,
      required(ledger, "verified-dead dispatch ledger is unavailable"),
      expected,
      this.#dependencies.repository
    );
    if (!ledgerReceipt.exact) {
      throw ledgerDispatchAuthorityError(input.conversation.conversation_id);
    }
    const acceptance = acceptanceAgreement(
      input.conversation,
      expected.requestText,
      submission?.acceptance_evidence,
      ledger?.acceptance_evidence,
      ledgerReceipt.receipt?.acceptance_evidence
    );
    const result = assertVerifiedDeadDispatchAuthorityFacts({
      conversationId: input.conversation.conversation_id,
      stateAuthorityExact: true,
      ledgerAuthorityExact: true,
      ledgerResolved: ledger?.status === "resolved",
      acceptance
    });
    return {
      ledger: required(ledger, "verified-dead dispatch ledger is unavailable"),
      resolved: result.resolved
    };
  }

  resolveVerifiedDeadDispatch(
    input: VerifiedDeadDispatchRequest & { reason: string }
  ): boolean {
    const authority = this.assertVerifiedDeadDispatch(input);
    if (authority.resolved) return true;
    this.#dependencies.repository.save(input.terminalControl, {
      ...authority.ledger,
      status: "resolved",
      resolved_at: cliNow().toISOString(),
      reason: input.reason
    });
    if (!this.assertVerifiedDeadDispatch(input).resolved) {
      throw new Error(
        `verified-dead Turn ${input.conversation.conversation_id} dispatch did not resolve`
      );
    }
    return true;
  }

  readEvents(logPath: string): TranscriptEvent[] {
    try {
      return readNdjsonLog(logPath);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  prepareCompletion(input: Parameters<
    TerminalDispatchRecoveryCliFacade["prepareCompletion"]
  >[0]): TerminalCompletionPreparation<PreparedCallback> {
    const storeDir = pathsForConversationDir(path.dirname(input.statePath)).storeDir;
    const releaseTerminal = this.#dependencies.repository.acquire(
      storeDir,
      input.terminalControl,
      { timeoutMs: 30000 }
    );
    try {
      return withStoreWriterLease(storeDir, () =>
        this.#dependencies.completion.prepare(input)
      );
    } finally {
      releaseTerminal();
    }
  }


  #activeScope(
    scope: TerminalDispatchRecoveryScope
  ): ConcreteRecoveryScope {
    if (!(scope instanceof ConcreteRecoveryScope) || !scope.active) {
      throw new TypeError("terminal dispatch recovery scope is inactive or foreign");
    }
    return scope;
  }

  #assertStateHeld(scope: ConcreteRecoveryScope): void {
    if (scope.stateReleased) {
      throw new TypeError("terminal dispatch recovery state scope is released");
    }
  }

  #releaseStateClaim(scope: ConcreteRecoveryScope): void {
    if (scope.stateReleased) return;
    scope.releaseState();
    scope.stateReleased = true;
  }

  #applySubmissionMutation(
    mutation: Parameters<typeof applyTerminalBridgeSubmission>[0]
  ): Conversation {
    const takeover = takeoverFor(mutation.conversation);
    return applyTerminalBridgeSubmission(mutation, {
      dispatcherPid: cliPid(),
      storeDir: this.#dependencies.authority.storeDirForConversation(
        mutation.conversation
      ),
      terminalControl: this.#dependencies.authority.terminalControl(takeover)
    });
  }
}

function submissionFacts(value: unknown): TerminalSubmissionRecoveryFacts {
  const submission = isRecord(value) ? value : undefined;
  return {
    status: nonBlankString(submission?.status),
    messageId: nonBlankString(submission?.message_id),
    preparedAt: nonBlankString(submission?.prepared_at),
    textInjectedAt: nonBlankString(submission?.text_injected_at),
    enterDispatchedAt: nonBlankString(submission?.enter_dispatched_at),
    submittedAt: nonBlankString(submission?.submitted_at),
    agentAcceptedAt: nonBlankString(submission?.agent_accepted_at),
    notAcceptedAt: nonBlankString(submission?.not_accepted_at),
    uncertainAt: nonBlankString(submission?.uncertain_at),
    abortedAt: nonBlankString(submission?.aborted_at),
    lastProvenStage: nonBlankString(submission?.last_proven_stage),
    acceptanceEvidence: submission?.acceptance_evidence as
      TerminalSubmissionAcceptanceEvidence | undefined
  };
}

function bindingCompatible(
  ledger: TerminalDispatchLedgerDocument,
  binding: TerminalBindingLedgerFacts
): boolean {
  for (const key of [
    "binding_id",
    "binding_generation",
    "native_thread_id",
    "store_dir"
  ] as const) {
    if (ledger[key] !== undefined && binding[key] !== undefined &&
      String(ledger[key]) !== String(binding[key])) return false;
  }
  return true;
}

function acceptanceProjection(
  conversation: Conversation,
  requestText: string,
  ledgerStatus: string,
  submission: TerminalDispatchLedgerDocument | undefined,
  ledger: TerminalDispatchLedgerDocument
): {
  state?: TerminalSubmissionAcceptanceEvidence;
  ledger?: TerminalSubmissionAcceptanceEvidence;
  ledgerError?: string;
} {
  let state: TerminalSubmissionAcceptanceEvidence | undefined;
  if (submission?.status === "agent_accepted") {
    try {
      state = terminalAcceptanceEvidenceForConversation(
        conversation,
        requestText,
        submission.acceptance_evidence
      );
    } catch {
      state = undefined;
    }
  }
  let durable: TerminalSubmissionAcceptanceEvidence | undefined;
  let ledgerError: string | undefined;
  if (ledgerStatus === "agent_accepted") {
    try {
      durable = terminalAcceptanceEvidenceForConversation(
        conversation,
        requestText,
        ledger.acceptance_evidence
      );
    } catch (error) {
      ledgerError = error instanceof Error ? error.message : String(error);
    }
  }
  return { state, ledger: durable, ledgerError };
}

function acceptedTurnCanBeStalled(
  storeDir: string,
  conversation: Conversation
): boolean {
  const takeover = takeoverFor(conversation);
  const submission = terminalBridgeSubmission(conversation);
  const messageId = nonBlankString(takeover?.terminal_bridge_message_id);
  const transferId = nonBlankString(takeover?.deferred_foreground_transfer_id);
  const base = {
    conversationStatus: conversation.status,
    terminalBridge: takeover?.terminal_bridge === true,
    messageId,
    submissionStatus: nonBlankString(submission?.status),
    submissionMessageId: nonBlankString(submission?.message_id),
    deferredTransferId: transferId
  };
  const decision = decideAcceptedTurnDeadAgentStall(base);
  if (decision.status !== "requires_deferred_transfer") {
    return decision.status === "applicable";
  }
  const transfer = loadDeferredForegroundTransfer(storeDir, decision.transferId);
  return decideAcceptedTurnDeadAgentStall({
    ...base,
    deferredTransferStatus: transfer.status
  }).status === "applicable";
}

function unchangedVerifiedDead(
  conversation: Conversation,
  reason: string
): VerifiedDeadRecoveryResult<PreparedCallback> {
  return { stalled: false, conversation, reason };
}

function localNotApplicable(): LocalCompletionRecoveryResult {
  return {
    handled: false,
    recovered: false,
    reason: "local_completion_not_applicable"
  };
}

function takeoverFor(conversation: Conversation) {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
}

function completionClaim(conversation: Conversation) {
  const takeover = takeoverFor(conversation);
  return isRecord(takeover?.terminal_bridge_completion_claim)
    ? takeover.terminal_bridge_completion_claim
    : undefined;
}

function processDisposition(
  conversation: Conversation | Record<string, any>
) {
  return isRecord(conversation.terminal_agent_process_disposition)
    ? conversation.terminal_agent_process_disposition
    : undefined;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function required<Value>(
  value: Value | null | undefined,
  message: string
): Value {
  if (value === undefined || value === null || value === "") {
    throw new Error(message);
  }
  return value;
}

function acceptedDispatchExpectation(
  input: VerifiedDeadDispatchRequest,
  takeover: Record<string, unknown> | undefined,
  submission: TerminalDispatchLedgerDocument | undefined
) {
  const conversation = input.conversation;
  return {
    requestText: String(
      takeover?.terminal_bridge_request_text ?? conversation.user_request ?? ""
    ),
    sessionId: sessionIdForConversation(conversation),
    turnId: turnIdForConversation(conversation),
    bindingId: nonBlankString(conversation.terminal_binding_id),
    bindingGeneration: Number(conversation.terminal_binding_generation),
    nativeThreadId: nonBlankString(conversation.native_thread_id) ??
      nonBlankString(takeover?.terminal_agent_session_id),
    endpointAnchor: terminalEndpointFromControlRef(
      input.terminalControl
    ).processAnchorPid,
    submission
  };
}

function stateDispatchCoreAuthorityExact(
  input: VerifiedDeadDispatchRequest,
  submission: TerminalDispatchLedgerDocument | undefined,
  expected: ReturnType<typeof acceptedDispatchExpectation>
): boolean {
  const requestHash = terminalBridgeRequestFingerprint(expected.requestText);
  const takeover = takeoverFor(input.conversation);
  return Boolean(
    input.expectedMessageId &&
    nonBlankString(takeover?.terminal_bridge_message_id) === input.expectedMessageId &&
    submission?.status === "agent_accepted" &&
    nonBlankString(submission.message_id) === input.expectedMessageId &&
    nonBlankString(submission.session_id) === expected.sessionId &&
    nonBlankString(submission.turn_id) === expected.turnId &&
    nonBlankString(submission.binding_id) === expected.bindingId &&
    Number(submission.binding_generation) === expected.bindingGeneration &&
    requestHash && nonBlankString(submission.request_hash) === requestHash &&
    expected.bindingId && Number.isSafeInteger(expected.bindingGeneration) &&
    expected.bindingGeneration >= 1 && expected.nativeThreadId &&
    Number.isSafeInteger(expected.endpointAnchor) && Number(expected.endpointAnchor) >= 1 &&
    sameCanonicalStatePath(input.conversation.state_path, input.statePath) &&
    path.resolve(nonBlankString(input.conversation.event_log_path) ?? "") ===
      path.resolve(input.logPath)
  );
}

function stateDispatchReceiptAuthorityExact(
  input: VerifiedDeadDispatchRequest,
  submission: TerminalDispatchLedgerDocument | undefined
): boolean {
  const takeover = takeoverFor(input.conversation);
  const rawHistory = takeover?.terminal_bridge_submission_receipts;
  const rawReceipts = Array.isArray(rawHistory)
    ? rawHistory.filter((receipt) => isRecord(receipt) &&
        nonBlankString(receipt.message_id) === input.expectedMessageId)
    : [];
  const validatedReceipts = terminalBridgeSubmissionReceipts(
    input.conversation
  ).filter((receipt) =>
    nonBlankString(receipt.message_id) === input.expectedMessageId
  );
  return Boolean(
    Array.isArray(rawHistory) && rawReceipts.length === 1 &&
    validatedReceipts.length === 1 &&
    canonicalJson(rawReceipts[0]) === canonicalJson(submission) &&
    canonicalJson(validatedReceipts[0]) === canonicalJson(submission)
  );
}

function ledgerDispatchCoreAuthorityExact(
  input: VerifiedDeadDispatchRequest,
  ledger: TerminalDispatchLedgerDocument | undefined,
  expected: ReturnType<typeof acceptedDispatchExpectation>,
  repository: TerminalDispatchRepositoryCliAdapter
): boolean {
  return Boolean(
    ledger && !terminalDispatchLedgerLooksLifecycle(ledger) &&
    ["agent_accepted", "resolved"].includes(String(ledger.status)) &&
    ledgerDispatchRecordMatches(
      input,
      ledger,
      expected,
      repository,
      ledger.status === "resolved" ? "resolved" : "agent_accepted"
    ) &&
    (ledger.status !== "resolved" ||
      validTimestamp(nonBlankString(ledger.resolved_at) ?? ""))
  );
}

function ledgerDispatchReceiptAuthority(
  input: VerifiedDeadDispatchRequest,
  ledger: TerminalDispatchLedgerDocument,
  expected: ReturnType<typeof acceptedDispatchExpectation>,
  repository: TerminalDispatchRepositoryCliAdapter
): { exact: boolean; receipt?: TerminalDispatchLedgerDocument } {
  const rawHistory = ledger?.terminal_submission_receipts;
  const rawReceipts = Array.isArray(rawHistory)
    ? rawHistory.filter((receipt) => isRecord(receipt) &&
        nonBlankString(receipt.message_id) === input.expectedMessageId)
    : [];
  const validated = terminalDispatchReceiptHistory(ledger).filter((receipt) =>
    nonBlankString(receipt.message_id) === input.expectedMessageId
  );
  const receipt = rawReceipts[0];
  return {
    exact: Boolean(
      rawReceipts.length === 1 && validated.length === 1 &&
      canonicalJson(rawReceipts[0]) === canonicalJson(validated[0]) &&
      ledgerDispatchRecordMatches(
        input,
        receipt,
        expected,
        repository,
        "agent_accepted"
      )
    ),
    receipt
  };
}

function ledgerDispatchRecordMatches(
  input: VerifiedDeadDispatchRequest,
  record: TerminalDispatchLedgerDocument | undefined,
  expected: ReturnType<typeof acceptedDispatchExpectation>,
  repository: TerminalDispatchRepositoryCliAdapter,
  status: "agent_accepted" | "resolved"
): boolean {
  const requestHash = terminalBridgeRequestFingerprint(expected.requestText);
  return Boolean(record &&
      record.status === status &&
      nonBlankString(record.generation_id) === input.expectedMessageId &&
      nonBlankString(record.conversation_id) === input.conversation.conversation_id &&
      nonBlankString(record.session_id) === expected.sessionId &&
      nonBlankString(record.turn_id) === expected.turnId &&
      nonBlankString(record.message_id) === input.expectedMessageId &&
      nonBlankString(record.request_hash) === requestHash &&
      sameCanonicalStatePath(record.state_path, input.statePath) &&
      path.resolve(nonBlankString(record.store_dir) ?? "") === path.resolve(input.storeDir) &&
      path.resolve(nonBlankString(record.event_log_path) ?? "") === path.resolve(input.logPath) &&
      nonBlankString(record.binding_id) === expected.bindingId &&
      Number(record.binding_generation) === expected.bindingGeneration &&
      nonBlankString(record.native_thread_id) === expected.nativeThreadId &&
      nonBlankString(record.executor_kind) === executorForConversation(input.conversation).kind &&
      (nonBlankString(record.openclaw_session) ?? undefined) ===
        (nonBlankString(input.conversation.openclaw_session) ?? undefined) &&
      Boolean(record.callback_expected) === Boolean(input.conversation.gateway_method) &&
      (nonBlankString(record.message_type) ?? undefined) ===
        (nonBlankString(expected.submission?.message_type) ?? undefined) &&
      (nonBlankString(record.message_body_hash) ?? undefined) ===
        (nonBlankString(expected.submission?.message_body_hash) ?? undefined) &&
      isRecord(record.terminal_endpoint) &&
      repository.matchesControl(record, input.terminalControl, {
        requireProcessAnchor: true
      }) &&
      repository.processAnchor(record) === expected.endpointAnchor
  );
}

function stateDispatchAuthorityError(conversationId: string): Error {
  return new Error(
    `verified-dead Turn ${conversationId} has no exact accepted submission authority`
  );
}

function ledgerDispatchAuthorityError(conversationId: string): Error {
  return new Error(
    `verified-dead Turn ${conversationId} no longer owns one exact terminal dispatch receipt`
  );
}

function acceptanceAgreement(
  conversation: Conversation,
  requestText: string,
  stateValue: unknown,
  ledgerValue: unknown,
  receiptValue: unknown
): { status: "valid"; allEqual: boolean } | { status: "invalid"; reason: string } {
  try {
    const state = terminalAcceptanceEvidenceForConversation(
      conversation, requestText, stateValue
    );
    const ledger = terminalAcceptanceEvidenceForConversation(
      conversation, requestText, ledgerValue
    );
    const receipt = terminalAcceptanceEvidenceForConversation(
      conversation, requestText, receiptValue
    );
    return {
      status: "valid",
      allEqual: canonicalJson(state) === canonicalJson(ledger) &&
        canonicalJson(state) === canonicalJson(receipt)
    };
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
