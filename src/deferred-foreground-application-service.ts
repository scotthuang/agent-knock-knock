import { createHash } from "node:crypto";

import type { DeferredForegroundApplicationScope } from
  "./deferred-foreground-boundary.js";
import type {
  DeferredForegroundUserAbandonmentLedgerDisposition,
  DeferredForegroundUserAbandonmentOriginStatus,
  DeferredForegroundUserAbandonmentSessionDisposition,
  DeferredForegroundTransfer,
  DeferredForegroundTransferInputStage
} from "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import {
  isExactNativeThreadId,
  managedSessionRevision,
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedSessionState,
  type ManagedTerminalBinding
} from "./managed-session.js";
import {
  exactRolloutMatches,
  type TerminalNativeIdentity as NativeAgentSessionIdentity
} from "./terminal-binding-authority.js";
import {
  isCompleteNativeRollout,
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
import type {
  DeferredForegroundBindingBoundary as DeferredCodexForegroundBindingBoundary
} from "./deferred-foreground-boundary.js";

type CrashPoint =
  | "source_session_reserved"
  | "source_reserved"
  | "target_prepared"
  | "source_scrubbed"
  | "target_accepted"
  | "committed"
  | "source_detached"
  | "target_bound"
  | "user_abandonment_intent"
  | "user_abandonment_source_released"
  | "user_abandonment_target_released"
  | "user_abandonment_completed";

interface OwnershipRequest {
  processPid: number;
  nativeThreadId: string;
  excludedManagedSessionId?: string;
  allowedManagedSessionIds?: string[];
}

export interface DeferredForegroundApplicationPorts {
  authority: {
    verifyReservedSource(
      scope: DeferredForegroundApplicationScope,
      boundary: DeferredCodexForegroundBindingBoundary
    ): Promise<ManagedSessionState>;
    assertExclusive(
      scope: DeferredForegroundApplicationScope,
      boundary: DeferredCodexForegroundBindingBoundary,
      request: OwnershipRequest
    ): Promise<void>;
    assertFrozenPredecessor(
      scope: DeferredForegroundApplicationScope,
      boundary: DeferredCodexForegroundBindingBoundary,
      transfer: DeferredForegroundTransfer
    ): void;
    valuesMatch(left: unknown, right: unknown): boolean;
  };
  clock: {
    now(): Date;
  };
  runtime: {
    crashAt(point: CrashPoint): void;
    errorReceipt(reason: string): string;
    summary(value: string): unknown;
    log(
      level: "info" | "warn" | "error",
      event: string,
      fields: { [key: string]: unknown }
    ): void;
  };
}

export interface DeferredForegroundReservation {
  createdSession: ManagedSessionState;
  rollback(scope: DeferredForegroundApplicationScope): void;
}

interface ReserveRequest {
  scope: DeferredForegroundApplicationScope;
  boundary: DeferredCodexForegroundBindingBoundary;
  targetSession: ManagedSessionState;
  messageId: string;
  turnId: string;
}

interface CommitRequest {
  scope: DeferredForegroundApplicationScope;
  boundary: DeferredCodexForegroundBindingBoundary;
  identity: NativeAgentSessionIdentity;
  acceptedAt: string;
}

interface BeginUserAbandonmentRequest {
  scope: DeferredForegroundApplicationScope;
  transferId: string;
  turnId: string;
  turnFingerprint: string;
  requestedAt: string;
  closeReason: string;
  ledgerDisposition: DeferredForegroundUserAbandonmentLedgerDisposition;
  ledgerFingerprint: string;
}

export interface CompleteUserAbandonmentRequest {
  scope: DeferredForegroundApplicationScope;
  transferId: string;
  ledgerDisposition: DeferredForegroundUserAbandonmentLedgerDisposition;
  ledgerFingerprint: string;
  ensureCloseEvent(): void;
  assertCloseEvent(): void;
}

export function deferredForegroundTransferRevision(
  transfer: DeferredForegroundTransfer
): number {
  const revision = Number(transfer.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} has no valid revision`
    );
  }
  return revision;
}

export class DeferredForegroundApplicationService {
  readonly #ports: DeferredForegroundApplicationPorts;

  constructor(ports: DeferredForegroundApplicationPorts) {
    this.#ports = ports;
  }

  assertTransferAuthority(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer,
    boundary: DeferredCodexForegroundBindingBoundary
  ): void {
    scope.assertBoundary(boundary);
    const same = transfer.transfer_id === boundary.transferId &&
      transfer.source_session_id === boundary.sourceSessionId &&
      transfer.target_session_id === boundary.targetSessionId &&
      transfer.source_expected_revision === boundary.sourceBoundRevision &&
      transfer.source_binding_token === boundary.sourceBoundBindingToken &&
      transfer.previous_dispatch_status ===
        boundary.previousDispatchSnapshot.status &&
      transfer.previous_dispatch_fingerprint ===
        boundary.previousDispatchSnapshot.fingerprint &&
      (transfer.version === 1 ? "status_card_only" : transfer.source_kind) ===
        boundary.sourceKind &&
      (transfer.source_rollout_authority ?? "present") ===
        boundary.sourceRolloutAuthority &&
      transfer.source_abandonment_fingerprint ===
        boundary.sourceAbandonmentFingerprint &&
      this.#ports.authority.valuesMatch(
        transfer.source_turn_history,
        boundary.sourceTurnHistory
      ) &&
      transfer.source_previous_last_transition_id ===
        boundary.sourcePreviousLastTransitionId &&
      transfer.process_uuid === boundary.processUuid &&
      transfer.process_birth === boundary.processBirth &&
      scope.terminalMatches(transfer, boundary) &&
      scope.transferBelongsToTurn(transfer);
    if (!same) {
      throw new Error(
        `deferred foreground transfer ${boundary.transferId} authority changed`
      );
    }
  }

  beginUserAbandonment(
    request: BeginUserAbandonmentRequest
  ): DeferredForegroundTransfer {
    let transfer = request.scope.loadTransfer(request.transferId);
    assertUserAbandonmentRoute(request, transfer);
    if (transfer.status === "user_abandoned") {
      assertUserAbandonmentIdentity(request, transfer);
      return transfer;
    }
    assertUniqueUserAbandonmentAuthority(request.scope, transfer, request.turnId);
    if (transfer.status === "user_abandoning") {
      assertUserAbandonmentIdentity(request, transfer);
      userAbandonmentPlans(request.scope, transfer, this.#ports);
      return transfer;
    }
    if (isFinalDeferredForegroundTransferStatus(transfer.status)) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} is already final`
      );
    }
    if (![
      "target_prepared", "dispatch_started", "committed", "aborted",
      "uncertain"
    ].includes(transfer.status)) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} has no exact ` +
        "managed target Turn to abandon"
      );
    }
    userAbandonmentPlans(request.scope, transfer, this.#ports);
    const originStatus = transfer.status as
      DeferredForegroundUserAbandonmentOriginStatus;
    transfer = request.scope.saveTransfer({
      ...transfer,
      status: "user_abandoning",
      user_abandonment_disposition: "user_abandoned_management",
      user_abandonment_origin_status: originStatus,
      user_abandonment_origin_revision:
        deferredForegroundTransferRevision(transfer),
      user_abandonment_turn_id: request.turnId,
      user_abandonment_turn_fingerprint: request.turnFingerprint,
      user_abandonment_requested_at: request.requestedAt,
      user_abandonment_close_reason: request.closeReason,
      user_abandonment_ledger_disposition: request.ledgerDisposition,
      user_abandonment_ledger_fingerprint: request.ledgerFingerprint
    }, deferredForegroundTransferRevision(transfer));
    this.#ports.runtime.crashAt("user_abandonment_intent");
    return transfer;
  }

  completeUserAbandonment(
    request: CompleteUserAbandonmentRequest
  ): DeferredForegroundTransfer {
    let transfer = request.scope.loadTransfer(request.transferId);
    if (transfer.status === "user_abandoned") {
      if (
        transfer.user_abandonment_ledger_disposition !==
          request.ledgerDisposition ||
        transfer.user_abandonment_ledger_fingerprint !==
          request.ledgerFingerprint
      ) {
        throw new Error(
          `deferred foreground transfer ${transfer.transfer_id} final ` +
          "ledger abandonment receipt changed"
        );
      }
      const plans = userAbandonmentPlans(
        request.scope,
        transfer,
        this.#ports
      );
      if (
        plans.source.fingerprint !==
          transfer.user_abandonment_source_fingerprint ||
        plans.target.fingerprint !==
          transfer.user_abandonment_target_fingerprint
      ) {
        throw new Error(
          `deferred foreground transfer ${transfer.transfer_id} final ` +
          "Session abandonment receipts changed"
        );
      }
      request.assertCloseEvent();
      return transfer;
    }
    if (transfer.status !== "user_abandoning") {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} has no durable ` +
        "user abandonment intent"
      );
    }
    if (
      transfer.user_abandonment_ledger_disposition !==
        request.ledgerDisposition ||
      transfer.user_abandonment_ledger_fingerprint !==
        request.ledgerFingerprint
    ) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} ledger ` +
        "abandonment plan changed"
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(request.ledgerFingerprint)) {
      throw new Error("user abandonment ledger fingerprint is invalid");
    }
    assertUniqueUserAbandonmentAuthority(
      request.scope,
      transfer,
      transfer.user_abandonment_turn_id as string
    );
    const plans = userAbandonmentPlans(
      request.scope,
      transfer,
      this.#ports
    );
    const source = releaseUserAbandonmentSession(
      request.scope,
      plans.source,
      this.#ports.clock.now()
    );
    this.#ports.runtime.crashAt("user_abandonment_source_released");
    const target = releaseUserAbandonmentSession(
      request.scope,
      plans.target,
      this.#ports.clock.now()
    );
    this.#ports.runtime.crashAt("user_abandonment_target_released");
    request.ensureCloseEvent();
    const completedAt = this.#ports.clock.now().toISOString();
    transfer = request.scope.saveTransfer({
      ...transfer,
      status: "user_abandoned",
      user_abandonment_completed_at: completedAt,
      user_abandonment_source_disposition: source.disposition,
      user_abandonment_source_fingerprint: source.fingerprint,
      user_abandonment_target_disposition: target.disposition,
      user_abandonment_target_fingerprint: target.fingerprint
    }, deferredForegroundTransferRevision(transfer));
    this.#ports.runtime.crashAt("user_abandonment_completed");
    this.#ports.runtime.log(
      "info",
      "deferred_codex_foreground_transfer_user_abandoned",
      {
        transfer_id: transfer.transfer_id,
        turn_id: transfer.turn_id,
        source_session_id: transfer.source_session_id,
        target_session_id: transfer.target_session_id,
        source_disposition: source.disposition,
        target_disposition: target.disposition,
        ledger_disposition: request.ledgerDisposition,
        terminal_input_sent: false
      }
    );
    return transfer;
  }

  abortBeforeInput(options: {
    scope: DeferredForegroundApplicationScope;
    boundary: DeferredCodexForegroundBindingBoundary;
    reason: string;
    terminalInputNotStartedAt?: string;
  }): void {
    let transfer = options.scope.loadTransfer(options.boundary.transferId);
    this.assertTransferAuthority(options.scope, transfer, options.boundary);
    if (transfer.status === "abort_resolved") return;
    const zeroInput = provedDispatchDidNotStart(
      transfer,
      options.terminalInputNotStartedAt
    );
    assertCanAbort(transfer, zeroInput);
    if (transfer.status !== "aborted") {
      transfer = options.scope.saveTransfer({
        ...transfer,
        status: "aborted",
        aborted_at: this.#ports.clock.now().toISOString(),
        ...(zeroInput
          ? { terminal_input_not_started_at: options.terminalInputNotStartedAt }
          : {}),
        error: this.#ports.runtime.errorReceipt(options.reason)
      }, deferredForegroundTransferRevision(transfer));
    }
    transfer = this.finalizeAbort(options.scope, transfer);
    this.#ports.runtime.log(
      "info",
      "deferred_codex_foreground_transfer_aborted",
      {
        transfer_id: transfer.transfer_id,
        source_session_id: transfer.source_session_id,
        target_session_id: transfer.target_session_id,
        terminal_input_sent: false,
        reason: this.#ports.runtime.summary(options.reason)
      }
    );
  }

  finalizeAbort(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer
  ): DeferredForegroundTransfer {
    let current = scope.loadTransfer(transfer.transfer_id);
    if (current.status === "abort_resolved") return current;
    assertZeroInputAbortIntent(current);
    const target = this.#finalizeAbortedTarget(scope, current);
    const source = this.#finalizeAbortedSource(scope, current);
    const completedAt = this.#ports.clock.now().toISOString();
    current = scope.saveTransfer({
      ...current,
      status: "abort_resolved",
      abort_cleanup_completed_at: completedAt,
      abort_source_after_revision: managedSessionRevision(source),
      abort_source_after_status: "bound",
      abort_source_after_binding_token: managedSessionBindingToken(source),
      abort_source_after_binding: source.binding,
      abort_target_after_status: target ? "detached" : "absent",
      ...(target ? abortTargetReceipt(target) : {})
    }, deferredForegroundTransferRevision(current));
    return current;
  }

  async reserve(request: ReserveRequest): Promise<DeferredForegroundReservation> {
    let transfer = request.scope.loadTransfer(request.boundary.transferId);
    this.assertTransferAuthority(request.scope, transfer, request.boundary);
    if (transfer.status !== "prepared" || transfer.input_stage !== "none") {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} is already ` +
        transfer.status
      );
    }
    const source = await this.#ports.authority.verifyReservedSource(
      request.scope,
      request.boundary
    );
    try {
      return this.#reserveAfterVerification(request, transfer, source);
    } catch (error) {
      this.#abortFailedReservation(request, error);
      throw error;
    }
  }

  begin(options: {
    scope: DeferredForegroundApplicationScope;
    boundary: DeferredCodexForegroundBindingBoundary;
    at: string;
  }): DeferredForegroundTransfer {
    let transfer = options.scope.loadTransfer(options.boundary.transferId);
    this.assertTransferAuthority(options.scope, transfer, options.boundary);
    this.#assertPreparedTarget(options.scope, transfer);
    if (transfer.status !== "target_prepared" || transfer.input_stage !== "none") {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} cannot begin ` +
        `dispatch from ${transfer.status}/${transfer.input_stage}`
      );
    }
    transfer = options.scope.saveTransfer({
      ...transfer,
      status: "dispatch_started",
      input_stage: "dispatch_started",
      dispatch_started_at: options.at
    }, deferredForegroundTransferRevision(transfer));
    return transfer;
  }

  advance(options: {
    scope: DeferredForegroundApplicationScope;
    boundary: DeferredCodexForegroundBindingBoundary;
    stage: "text_injected" | "enter_dispatched";
    at: string;
  }): DeferredForegroundTransfer {
    let transfer = options.scope.loadTransfer(options.boundary.transferId);
    this.assertTransferAuthority(options.scope, transfer, options.boundary);
    this.#assertPreparedTarget(options.scope, transfer);
    this.#assertReservedSource(options.scope, transfer, options.boundary);
    assertStageTransition(transfer, options.stage);
    transfer = options.scope.saveTransfer({
      ...transfer,
      status: "dispatch_started",
      input_stage: options.stage,
      dispatch_started_at: transfer.dispatch_started_at ?? options.at,
      ...(options.stage === "text_injected"
        ? { text_injected_at: options.at }
        : { enter_dispatched_at: options.at })
    }, deferredForegroundTransferRevision(transfer));
    return transfer;
  }

  reserveSubmissionRetry(options: {
    scope: DeferredForegroundApplicationScope;
    boundary: DeferredCodexForegroundBindingBoundary;
    attemptId: string;
    mode: "exact_draft_enter" | "replacement_send";
    messageId: string;
    preparedAt: string;
    textReservedAt?: string;
    textInjectedAt?: string;
  }): DeferredForegroundTransfer {
    let transfer = options.scope.loadTransfer(options.boundary.transferId);
    this.assertTransferAuthority(options.scope, transfer, options.boundary);
    this.#assertPreparedTarget(options.scope, transfer);
    this.#assertReservedSource(options.scope, transfer, options.boundary);
    if (
      transfer.status !== "uncertain" ||
      transfer.input_stage !== "text_injected" ||
      transfer.submission_retry_attempt_id !== undefined ||
      options.messageId !== transfer.message_id ||
      options.preparedAt !== transfer.prepared_at
    ) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} cannot reserve ` +
        "a submission retry from its current generation"
      );
    }
    transfer = options.scope.saveTransfer({
      ...transfer,
      submission_retry_attempt_id: options.attemptId,
      submission_retry_mode: options.mode,
      submission_retry_message_id: options.messageId,
      submission_retry_prepared_at: options.preparedAt,
      ...(options.textReservedAt
        ? { submission_retry_text_reserved_at: options.textReservedAt }
        : {}),
      ...(options.textInjectedAt
        ? { submission_retry_text_injected_at: options.textInjectedAt }
        : {})
    }, deferredForegroundTransferRevision(transfer));
    return transfer;
  }

  advanceSubmissionRetry(options: {
    scope: DeferredForegroundApplicationScope;
    boundary: DeferredCodexForegroundBindingBoundary;
    attemptId: string;
    messageId: string;
    stage: "text_reserved" | "text_injected" | "enter_reserved" |
      "enter_dispatched";
    at: string;
  }): DeferredForegroundTransfer {
    let transfer = options.scope.loadTransfer(options.boundary.transferId);
    this.assertTransferAuthority(options.scope, transfer, options.boundary);
    this.#assertPreparedTarget(options.scope, transfer);
    this.#assertReservedSource(options.scope, transfer, options.boundary);
    if (
      transfer.status !== "uncertain" ||
      transfer.submission_retry_attempt_id !== options.attemptId ||
      transfer.submission_retry_message_id !== options.messageId
    ) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} retry authority changed`
      );
    }
    const exactDraft = transfer.submission_retry_mode === "exact_draft_enter";
    const invalidStage = options.stage === "text_reserved"
      ? exactDraft || transfer.submission_retry_text_reserved_at !== undefined
      : options.stage === "text_injected"
        ? exactDraft || !transfer.submission_retry_text_reserved_at ||
          transfer.submission_retry_text_injected_at !== undefined
        : options.stage === "enter_reserved"
          ? (exactDraft
              ? transfer.input_stage !== "text_injected"
              : !transfer.submission_retry_text_injected_at) ||
            transfer.submission_retry_enter_reserved_at !== undefined
        : (!exactDraft && !transfer.submission_retry_text_injected_at) ||
          !transfer.submission_retry_enter_reserved_at ||
          transfer.submission_retry_enter_dispatched_at !== undefined;
    if (invalidStage) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} cannot advance ` +
        `retry ${options.stage}`
      );
    }
    transfer = options.scope.saveTransfer({
      ...transfer,
      ...(options.stage === "text_reserved"
        ? { submission_retry_text_reserved_at: options.at }
        : options.stage === "text_injected"
          ? { submission_retry_text_injected_at: options.at }
          : options.stage === "enter_reserved"
            ? { submission_retry_enter_reserved_at: options.at }
          : {
            input_stage: "enter_dispatched" as const,
            enter_dispatched_at: transfer.enter_dispatched_at ?? options.at,
            submission_retry_enter_dispatched_at: options.at
          })
    }, deferredForegroundTransferRevision(transfer));
    return transfer;
  }

  async commit(request: CommitRequest): Promise<ManagedSessionState> {
    let transfer = request.scope.loadTransfer(request.boundary.transferId);
    this.assertTransferAuthority(request.scope, transfer, request.boundary);
    this.#ports.authority.assertFrozenPredecessor(
      request.scope,
      request.boundary,
      transfer
    );
    assertAcceptedIdentityAuthority(transfer, request.identity);
    let source = request.scope.loadSession(transfer.source_session_id);
    const sameNativeThread = request.identity.sessionId.toLowerCase() ===
      transfer.source_before_binding.native_thread_id?.toLowerCase();
    const sourceAlreadyScrubbed = sameNativeThread &&
      this.#isExactScrubbedSource(source, transfer);
    this.#assertCommittableSource(
      source,
      transfer,
      request.boundary,
      sourceAlreadyScrubbed
    );
    let target = request.scope.loadSession(transfer.target_session_id);
    const targetAlreadyAccepted = this.#isExactAcceptedTarget(
      target,
      transfer,
      request.identity
    );
    if (!targetAlreadyAccepted) {
      target = this.#assertPreparedTarget(request.scope, transfer);
    }
    await this.#assertCommitOwnership(
      request,
      transfer,
      sameNativeThread,
      targetAlreadyAccepted
    );
    if (sameNativeThread && !sourceAlreadyScrubbed) {
      source = this.#scrubSource(request.scope, transfer, source);
    }
    if (!targetAlreadyAccepted) {
      target = this.#acceptTarget(request, target);
    }
    transfer = this.#persistCommit(request, transfer, source, target,
      sameNativeThread);
    this.#ports.runtime.crashAt("committed");
    return this.resolve({
      scope: request.scope,
      boundary: request.boundary
    });
  }

  async resolve(options: {
    scope: DeferredForegroundApplicationScope;
    boundary: DeferredCodexForegroundBindingBoundary;
  }): Promise<ManagedSessionState> {
    let transfer = options.scope.loadTransfer(options.boundary.transferId);
    this.assertTransferAuthority(options.scope, transfer, options.boundary);
    if (transfer.status === "resolved") {
      return this.#resolvedTarget(options.scope, transfer);
    }
    assertCommittedReceipt(transfer);
    const source = this.#retireSource(options.scope, transfer);
    const target = this.#bindTarget(options.scope, transfer);
    await this.#ports.authority.assertExclusive(
      options.scope,
      options.boundary,
      {
        processPid: transfer.process_pid,
        nativeThreadId: transfer.target_native_thread_id as string,
        excludedManagedSessionId: target.session_id,
        allowedManagedSessionIds: abandonedSourceAllowance(transfer)
      }
    );
    transfer = options.scope.saveTransfer({
      ...transfer,
      status: "resolved",
      target_after_revision: managedSessionRevision(target),
      target_after_status: "bound",
      target_after_binding_token: managedSessionBindingToken(target),
      source_after_revision: managedSessionRevision(source),
      source_after_status: "detached",
      source_after_binding: source.binding,
      source_after_binding_token: managedSessionBindingToken(source),
      resolved_at: this.#ports.clock.now().toISOString()
    }, deferredForegroundTransferRevision(transfer));
    this.#logResolved(transfer, source, target);
    return target;
  }

  markUncertain(options: {
    scope: DeferredForegroundApplicationScope;
    boundary: DeferredCodexForegroundBindingBoundary;
    reason: string;
  }): DeferredForegroundTransfer {
    let transfer = options.scope.loadTransfer(options.boundary.transferId);
    this.assertTransferAuthority(options.scope, transfer, options.boundary);
    if (["committed", "resolved", "uncertain"].includes(transfer.status)) {
      return transfer;
    }
    if (!["target_prepared", "dispatch_started"].includes(transfer.status)) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} has no durable ` +
        "dispatch-start fence"
      );
    }
    const dispatchStartedAt = transfer.dispatch_started_at ??
      this.#ports.clock.now().toISOString();
    const uncertainAt = this.#ports.clock.now().toISOString();
    transfer = options.scope.saveTransfer({
      ...transfer,
      status: "uncertain",
      input_stage: transfer.input_stage === "none"
        ? "dispatch_started"
        : transfer.input_stage,
      dispatch_started_at: dispatchStartedAt,
      uncertain_at: uncertainAt,
      error: options.reason.slice(0, 2000),
      do_not_retry: true
    }, deferredForegroundTransferRevision(transfer));
    return transfer;
  }

  #finalizeAbortedTarget(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer
  ): ManagedSessionState | undefined {
    let target = scope.tryLoadSession(transfer.target_session_id);
    if (!target) return undefined;
    assertAbortTargetShape(target, transfer, this.#ports.authority.valuesMatch);
    if (target.status === "transitioning") {
      assertAbortTargetRevision(target, transfer);
      const detachedAt = this.#ports.clock.now().toISOString();
      target = scope.saveSession({
        ...target,
        status: "detached",
        detached_at: detachedAt,
        updated_at: detachedAt
      }, managedSessionRevision(target));
    } else {
      assertResolvedAbortTarget(target, transfer);
    }
    return target;
  }

  #finalizeAbortedSource(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer
  ): ManagedSessionState {
    let source = scope.loadSession(transfer.source_session_id);
    if (isRestorableAbortSource(
      source,
      transfer,
      this.#ports.authority.valuesMatch
    )) {
      const restoredAt = this.#ports.clock.now().toISOString();
      source = scope.saveSession({
        ...source,
        status: "bound",
        last_transition_id: transfer.source_previous_last_transition_id,
        updated_at: restoredAt
      }, managedSessionRevision(source));
    }
    assertResolvedAbortSource(
      source,
      transfer,
      this.#ports.authority.valuesMatch
    );
    return source;
  }

  #reserveAfterVerification(
    request: ReserveRequest,
    transfer: DeferredForegroundTransfer,
    source: ManagedSessionState
  ): DeferredForegroundReservation {
    const reservedAt = this.#ports.clock.now().toISOString();
    const reserved = request.scope.saveSession({
      ...source,
      status: "transitioning",
      last_transition_id: transfer.transfer_id,
      updated_at: reservedAt
    }, managedSessionRevision(source));
    this.#ports.runtime.crashAt("source_session_reserved");
    request.boundary.sourceReservedRevision = managedSessionRevision(reserved);
    request.boundary.sourceReservedBindingToken =
      managedSessionBindingToken(reserved);
    transfer = request.scope.saveTransfer({
      ...transfer,
      status: "source_reserved",
      source_reserved_at: reservedAt
    }, deferredForegroundTransferRevision(transfer));
    this.#ports.runtime.crashAt("source_reserved");
    const target = this.#prepareTarget(request, transfer);
    transfer = target.transfer;
    this.#ports.runtime.crashAt("target_prepared");
    const createdSession = request.scope.saveSession(
      target.provisional,
      null
    );
    assertCreatedTarget(createdSession, request.boundary);
    this.#logReserved(request.boundary, transfer, source);
    return {
      createdSession,
      rollback: (scope) => {
        if (!request.scope.sameInvocation(scope)) {
          throw new Error(
            "deferred foreground rollback escaped its exact mutation resources"
          );
        }
        this.abortBeforeInput({
          scope,
          boundary: request.boundary,
          reason: "terminal input was proved not to have started"
        });
      }
    };
  }

  #prepareTarget(
    request: ReserveRequest,
    transfer: DeferredForegroundTransfer
  ): {
    transfer: DeferredForegroundTransfer;
    provisional: ManagedSessionState;
  } {
    const provisional: ManagedSessionState = {
      ...request.targetSession,
      status: "transitioning",
      last_transition_id: transfer.transfer_id
    };
    request.boundary.targetPreparedRevision = 1;
    request.boundary.targetPreparedBindingToken =
      managedSessionBindingToken(provisional);
    const prepared = request.scope.withTurnStatePath({
      ...transfer,
      status: "target_prepared",
      target_prepared_at: this.#ports.clock.now().toISOString(),
      target_prepared_revision: 1,
      target_prepared_status: "transitioning",
      target_prepared_last_transition_id: transfer.transfer_id,
      target_prepared_binding_token: managedSessionBindingToken(provisional),
      target_before_binding: provisional.binding,
      message_id: request.messageId,
      turn_id: request.turnId
    });
    return {
      provisional,
      transfer: request.scope.saveTransfer(
        prepared,
        deferredForegroundTransferRevision(transfer)
      )
    };
  }

  #abortFailedReservation(request: ReserveRequest, error: unknown): void {
    try {
      this.abortBeforeInput({
        scope: request.scope,
        boundary: request.boundary,
        reason: error instanceof Error ? error.message : String(error)
      });
    } catch (abortError) {
      throw new Error(
        `deferred foreground reservation failed and could not be aborted: ${
          abortError instanceof Error ? abortError.message : String(abortError)
        }`,
        { cause: error }
      );
    }
  }

  #assertPreparedTarget(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer
  ): ManagedSessionState {
    const target = scope.loadSession(transfer.target_session_id);
    const matches = target.status === "transitioning" &&
      target.last_transition_id === transfer.transfer_id &&
      managedSessionRevision(target) === transfer.target_prepared_revision &&
      managedSessionBindingToken(target) ===
        transfer.target_prepared_binding_token &&
      this.#ports.authority.valuesMatch(
        target.binding,
        transfer.target_before_binding
      ) &&
      target.lineage.transition_id === transfer.transfer_id &&
      target.lineage.previous_session_id === transfer.source_session_id;
    if (!matches) {
      throw new Error(
        `deferred foreground target ${transfer.target_session_id} changed ` +
        "before terminal dispatch"
      );
    }
    return target;
  }

  #assertReservedSource(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer,
    boundary: DeferredCodexForegroundBindingBoundary
  ): void {
    const source = scope.loadSession(transfer.source_session_id);
    const matches = source.status === "transitioning" &&
      source.last_transition_id === transfer.transfer_id &&
      managedSessionRevision(source) === transfer.source_expected_revision + 1 &&
      managedSessionBindingToken(source) === boundary.sourceReservedBindingToken &&
      this.#ports.authority.valuesMatch(
        source.binding,
        transfer.source_before_binding
      );
    if (!matches) {
      throw new Error(
        `deferred foreground source ${transfer.source_session_id} changed ` +
        "during terminal dispatch"
      );
    }
  }

  #isExactScrubbedSource(
    source: ManagedSessionState,
    transfer: DeferredForegroundTransfer
  ): boolean {
    const before = transfer.source_before_binding;
    const after = source.binding;
    return Boolean(
      source.status === "transitioning" &&
      source.last_transition_id === transfer.transfer_id &&
      managedSessionRevision(source) === transfer.source_expected_revision + 2 &&
      after &&
      after.binding_id !== before.binding_id &&
      after.generation === before.generation + 1 &&
      after.terminal_id === before.terminal_id &&
      terminalControlsShareIncarnation(
        after.terminal_control,
        before.terminal_control
      ) &&
      after.native_thread_id === undefined &&
      after.native_process.rollout === undefined &&
      after.native_process.pid === transfer.process_pid &&
      after.native_process.process_uuid === transfer.process_uuid &&
      after.native_process.process_birth === transfer.process_birth &&
      after.native_process.evidence ===
        "deferred_predecessor_binding_scrubbed"
    );
  }

  #isExactAcceptedTarget(
    target: ManagedSessionState,
    transfer: DeferredForegroundTransfer,
    identity: NativeAgentSessionIdentity
  ): boolean {
    const before = transfer.target_before_binding;
    const after = target.binding;
    return Boolean(
      before && after && target.status === "transitioning" &&
      target.last_transition_id === transfer.transfer_id &&
      managedSessionRevision(target) ===
        Number(transfer.target_prepared_revision) + 1 &&
      after.binding_id === before.binding_id &&
      after.generation === before.generation &&
      after.native_thread_id === identity.sessionId &&
      after.native_process.pid === transfer.process_pid &&
      after.native_process.process_uuid === identity.processUuid &&
      after.native_process.process_birth === identity.processBirth &&
      exactRolloutMatches(after.native_process.rollout, identity.rollout)
    );
  }

  #assertCommittableSource(
    source: ManagedSessionState,
    transfer: DeferredForegroundTransfer,
    boundary: DeferredCodexForegroundBindingBoundary,
    alreadyScrubbed: boolean
  ): void {
    const reserved = source.status === "transitioning" &&
      source.last_transition_id === transfer.transfer_id &&
      managedSessionRevision(source) === transfer.source_expected_revision + 1 &&
      managedSessionBindingToken(source) === boundary.sourceReservedBindingToken &&
      this.#ports.authority.valuesMatch(
        source.binding,
        transfer.source_before_binding
      );
    if (!reserved && !alreadyScrubbed) {
      throw new Error(
        `deferred foreground source ${source.session_id} changed before commit`
      );
    }
  }

  async #assertCommitOwnership(
    request: CommitRequest,
    transfer: DeferredForegroundTransfer,
    sameNativeThread: boolean,
    targetAlreadyAccepted: boolean
  ): Promise<void> {
    await this.#ports.authority.assertExclusive(
      request.scope,
      request.boundary,
      {
        processPid: transfer.process_pid,
        nativeThreadId: request.identity.sessionId,
        excludedManagedSessionId: targetAlreadyAccepted
          ? transfer.target_session_id
          : sameNativeThread
            ? transfer.source_session_id
            : transfer.target_session_id,
        allowedManagedSessionIds: abandonedSourceAllowance(transfer)
      }
    );
  }

  #scrubSource(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer,
    source: ManagedSessionState
  ): ManagedSessionState {
    const scrubbedAt = this.#ports.clock.now();
    const scrubbedBinding = terminalBindingFrom({
      terminalId: transfer.source_before_binding.terminal_id,
      terminalControl: transfer.source_before_binding.terminal_control,
      pid: transfer.process_pid,
      processUuid: transfer.process_uuid,
      processBirth: transfer.process_birth,
      evidence: "deferred_predecessor_binding_scrubbed",
      generation: transfer.source_before_binding.generation + 1,
      now: scrubbedAt
    });
    const saved = scope.saveSession({
      ...source,
      binding: scrubbedBinding,
      updated_at: scrubbedAt.toISOString()
    }, managedSessionRevision(source));
    this.#ports.runtime.crashAt("source_scrubbed");
    return saved;
  }

  #acceptTarget(
    request: CommitRequest,
    target: ManagedSessionState
  ): ManagedSessionState {
    const acceptedBinding: ManagedTerminalBinding = {
      ...(target.binding as ManagedTerminalBinding),
      native_thread_id: request.identity.sessionId,
      native_process: {
        ...(target.binding as ManagedTerminalBinding).native_process,
        process_uuid: request.identity.processUuid,
        process_birth: request.identity.processBirth,
        rollout: request.identity.rollout,
        evidence: request.identity.evidence
      },
      last_verified_at: request.acceptedAt
    };
    const saved = request.scope.saveSession({
      ...target,
      binding: acceptedBinding,
      updated_at: request.acceptedAt
    }, managedSessionRevision(target));
    this.#ports.runtime.crashAt("target_accepted");
    return saved;
  }

  #persistCommit(
    request: CommitRequest,
    transfer: DeferredForegroundTransfer,
    source: ManagedSessionState,
    target: ManagedSessionState,
    sameNativeThread: boolean
  ): DeferredForegroundTransfer {
    const transportProofAt = transfer.dispatch_started_at ?? request.acceptedAt;
    return request.scope.saveTransfer({
      ...transfer,
      status: "committed",
      input_stage: "agent_accepted",
      dispatch_started_at: transfer.dispatch_started_at ?? transportProofAt,
      text_injected_at: transfer.text_injected_at ?? transportProofAt,
      enter_dispatched_at: transfer.enter_dispatched_at ?? transportProofAt,
      agent_accepted_at: request.acceptedAt,
      target_native_thread_id: request.identity.sessionId,
      target_accepted_revision: managedSessionRevision(target),
      target_accepted_status: "transitioning",
      target_accepted_binding_token: managedSessionBindingToken(target),
      target_accepted_binding: target.binding,
      source_pre_retirement_revision: managedSessionRevision(source),
      source_pre_retirement_status: "transitioning",
      source_pre_retirement_binding_token: managedSessionBindingToken(source),
      source_pre_retirement_binding: source.binding,
      source_retirement: sameNativeThread
        ? "binding_scrubbed_same_native_thread"
        : "binding_retained",
      committed_at: request.acceptedAt,
      ...(transfer.status === "uncertain"
        ? { recovered_at: request.acceptedAt }
        : {})
    }, deferredForegroundTransferRevision(transfer));
  }

  #resolvedTarget(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer
  ): ManagedSessionState {
    const target = scope.loadSession(transfer.target_session_id);
    if (
      target.status !== "bound" ||
      managedSessionRevision(target) !== transfer.target_after_revision ||
      managedSessionBindingToken(target) !== transfer.target_after_binding_token
    ) {
      throw new Error(`resolved deferred target ${target.session_id} changed`);
    }
    return target;
  }

  #retireSource(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer
  ): ManagedSessionState {
    let source = scope.loadSession(transfer.source_session_id);
    if (source.status === "transitioning") {
      assertSourceCommitReceipt(
        source,
        transfer,
        this.#ports.authority.valuesMatch
      );
      const detachedAt = this.#ports.clock.now().toISOString();
      source = scope.saveSession({
        ...source,
        status: "detached",
        last_transition_id: transfer.source_previous_last_transition_id,
        detached_at: detachedAt,
        updated_at: detachedAt
      }, managedSessionRevision(source));
      this.#ports.runtime.crashAt("source_detached");
    } else {
      assertRetiredSource(
        source,
        transfer,
        this.#ports.authority.valuesMatch
      );
    }
    return source;
  }

  #bindTarget(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer
  ): ManagedSessionState {
    let target = scope.loadSession(transfer.target_session_id);
    if (target.status === "transitioning") {
      assertTargetCommitReceipt(
        target,
        transfer,
        this.#ports.authority.valuesMatch
      );
      const boundAt = this.#ports.clock.now().toISOString();
      target = scope.saveSession({
        ...target,
        status: "bound",
        last_transition_id: undefined,
        updated_at: boundAt
      }, managedSessionRevision(target));
      this.#ports.runtime.crashAt("target_bound");
    } else {
      assertBoundTarget(
        target,
        transfer,
        this.#ports.authority.valuesMatch
      );
    }
    return target;
  }

  #logReserved(
    boundary: DeferredCodexForegroundBindingBoundary,
    transfer: DeferredForegroundTransfer,
    source: ManagedSessionState
  ): void {
    this.#ports.runtime.log(
      "info",
      "deferred_codex_foreground_source_reserved",
      {
        transfer_id: transfer.transfer_id,
        terminal_id: boundary.terminal.conversationId,
        source_session_id: source.session_id,
        native_thread_id: source.binding?.native_thread_id,
        process_uuid: boundary.processUuid,
        process_birth: boundary.processBirth,
        terminal_input_sent: false
      }
    );
  }

  #logResolved(
    transfer: DeferredForegroundTransfer,
    source: ManagedSessionState,
    target: ManagedSessionState
  ): void {
    this.#ports.runtime.log(
      "info",
      "deferred_codex_foreground_transfer_resolved",
      {
        transfer_id: transfer.transfer_id,
        source_session_id: source.session_id,
        target_session_id: target.session_id,
        native_thread_id: transfer.target_native_thread_id,
        source_retirement: transfer.source_retirement
      }
    );
  }
}

interface UserAbandonmentSessionPlan {
  session?: ManagedSessionState;
  action: "detach" | "keep";
  disposition: DeferredForegroundUserAbandonmentSessionDisposition;
  fingerprint: string;
}

function assertUserAbandonmentRoute(
  request: BeginUserAbandonmentRequest,
  transfer: DeferredForegroundTransfer
): void {
  if (
    !request.scope.transferMatchesTerminal(transfer) ||
    !request.scope.transferBelongsToTurn(transfer) ||
    transfer.turn_id !== request.turnId ||
    !/^[0-9a-f]{64}$/u.test(request.turnFingerprint)
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} does not match ` +
      "the exact managed target Turn/terminal authority"
    );
  }
}

function assertUserAbandonmentIdentity(
  request: BeginUserAbandonmentRequest,
  transfer: DeferredForegroundTransfer
): void {
  if (
    transfer.user_abandonment_turn_id !== request.turnId ||
    transfer.user_abandonment_turn_fingerprint !== request.turnFingerprint ||
    transfer.user_abandonment_disposition !== "user_abandoned_management" ||
    transfer.user_abandonment_requested_at !== request.requestedAt ||
    transfer.user_abandonment_close_reason !== request.closeReason ||
    transfer.user_abandonment_ledger_disposition !==
      request.ledgerDisposition ||
    transfer.user_abandonment_ledger_fingerprint !== request.ledgerFingerprint
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} abandonment ` +
      "authority changed"
    );
  }
}

function assertUniqueUserAbandonmentAuthority(
  scope: DeferredForegroundApplicationScope,
  transfer: DeferredForegroundTransfer,
  turnId: string
): void {
  const nonfinal = scope.listTransfers().filter((candidate) =>
    !isFinalDeferredForegroundTransferStatus(candidate.status)
  );
  const sameTerminal = nonfinal.filter((candidate) =>
    scope.transferMatchesTerminal(candidate)
  );
  if (
    sameTerminal.length !== 1 ||
    sameTerminal[0]?.transfer_id !== transfer.transfer_id
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} is not the ` +
      "unique nonfinal transfer for its terminal"
    );
  }
  const sourceOwner = nonfinal.find((candidate) =>
    candidate.version === 2 &&
    candidate.source_kind === "candidate_rollout_quiescent" &&
    (candidate.source_turn_history ?? []).some((turn) => turn.turn_id === turnId)
  );
  if (sourceOwner) {
    throw new Error(
      `managed Turn ${turnId} is frozen source history for deferred ` +
      `foreground transfer ${sourceOwner.transfer_id}`
    );
  }
  const sessionConflict = nonfinal.find((candidate) =>
    candidate.transfer_id !== transfer.transfer_id &&
    [candidate.source_session_id, candidate.target_session_id].some(
      (sessionId) => [
        transfer.source_session_id,
        transfer.target_session_id
      ].includes(sessionId)
    )
  );
  if (sessionConflict) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} overlaps ` +
      `Sessions with nonfinal transfer ${sessionConflict.transfer_id}`
    );
  }
}

function userAbandonmentPlans(
  scope: DeferredForegroundApplicationScope,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): {
  source: UserAbandonmentSessionPlan;
  target: UserAbandonmentSessionPlan;
} {
  if (
    !scope.transferMatchesTerminal(transfer) ||
    !scope.transferBelongsToTurn(transfer)
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} escaped its ` +
      "exact target Turn/terminal release capability"
    );
  }
  const source = scope.loadSession(transfer.source_session_id);
  const target = scope.tryLoadSession(transfer.target_session_id);
  return {
    source: sourceUserAbandonmentPlan(source, transfer, ports),
    target: targetUserAbandonmentPlan(target, transfer, ports)
  };
}

function sourceUserAbandonmentPlan(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): UserAbandonmentSessionPlan {
  if (exactReleasedSource(session, transfer, ports)) {
    return keepSessionPlan(session, "already_released");
  }
  if (exactTransferOwnedSource(session, transfer, ports)) {
    return detachSessionPlan(session);
  }
  if (provablySupersededSession(session, transfer, "source")) {
    return keepSessionPlan(session, "superseded");
  }
  throw new Error(
    `deferred foreground source ${session.session_id} is neither exact ` +
    "transfer authority nor a provably newer replacement"
  );
}

function targetUserAbandonmentPlan(
  session: ManagedSessionState | undefined,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): UserAbandonmentSessionPlan {
  if (!session) {
    if (!targetMayBeAbsent(transfer)) {
      throw new Error(
        `deferred foreground target ${transfer.target_session_id} is missing ` +
        "after terminal input may have advanced"
      );
    }
    return {
      action: "keep",
      disposition: "absent",
      fingerprint: abandonmentFingerprint({
        session_id: transfer.target_session_id,
        status: "absent"
      })
    };
  }
  if (exactReleasedTarget(session, transfer, ports)) {
    return keepSessionPlan(session, "already_released");
  }
  if (exactTransferOwnedTarget(session, transfer, ports)) {
    return detachSessionPlan(session);
  }
  if (provablySupersededSession(session, transfer, "target")) {
    return keepSessionPlan(session, "superseded");
  }
  throw new Error(
    `deferred foreground target ${session.session_id} is neither exact ` +
    "transfer authority nor a provably newer replacement"
  );
}

function exactReleasedSource(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): boolean {
  if (session.status !== "detached") return false;
  const priorRevision = managedSessionRevision(session) - 1;
  const transitioning = {
    ...session,
    revision: priorRevision,
    status: "transitioning" as const
  };
  const bound = { ...session, revision: priorRevision, status: "bound" as const };
  if (
    exactTransferOwnedSource(transitioning, transfer, ports) ||
    exactTransferOwnedSource(bound, transfer, ports)
  ) {
    return true;
  }
  return userAbandonmentOriginStatus(transfer) === "committed" &&
    session.last_transition_id === transfer.source_previous_last_transition_id &&
    managedSessionRevision(session) ===
      Number(transfer.source_pre_retirement_revision) + 1 &&
    managedSessionBindingToken(session) === managedSessionBindingToken({
      session_id: transfer.source_session_id,
      status: "detached",
      binding: transfer.source_pre_retirement_binding
    }) &&
    ports.authority.valuesMatch(
      session.binding,
      transfer.source_pre_retirement_binding
    );
}

function exactReleasedTarget(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): boolean {
  if (session.status !== "detached") return false;
  const priorRevision = managedSessionRevision(session) - 1;
  return exactTransferOwnedTarget({
    ...session,
    revision: priorRevision,
    status: "transitioning"
  }, transfer, ports) || exactTransferOwnedTarget({
    ...session,
    revision: priorRevision,
    status: "bound"
  }, transfer, ports);
}

function detachSessionPlan(
  session: ManagedSessionState
): UserAbandonmentSessionPlan {
  return {
    session,
    action: "detach",
    disposition: "detached",
    fingerprint: abandonmentFingerprint(session)
  };
}

function keepSessionPlan(
  session: ManagedSessionState,
  disposition: "already_released" | "superseded"
): UserAbandonmentSessionPlan {
  return {
    session,
    action: "keep",
    disposition,
    fingerprint: abandonmentFingerprint(session)
  };
}

function releaseUserAbandonmentSession(
  scope: DeferredForegroundApplicationScope,
  plan: UserAbandonmentSessionPlan,
  now: Date
): UserAbandonmentSessionPlan {
  if (plan.action !== "detach" || !plan.session) return plan;
  const at = now.toISOString();
  const detached = scope.saveSession({
    ...plan.session,
    status: "detached",
    detached_at: at,
    updated_at: at
  }, managedSessionRevision(plan.session));
  return {
    session: detached,
    action: "keep",
    disposition: "detached",
    fingerprint: abandonmentFingerprint(detached)
  };
}

function exactTransferOwnedSource(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): boolean {
  const origin = userAbandonmentOriginStatus(transfer);
  if (["target_prepared", "dispatch_started", "uncertain"].includes(origin)) {
    if (exactReservedSource(session, transfer, ports)) return true;
    if (
      ["dispatch_started", "uncertain"].includes(origin) &&
      exactScrubbedSource(session, transfer)
    ) {
      return true;
    }
  }
  if (origin === "committed") {
    return exactCommittedSource(session, transfer, ports);
  }
  if (origin === "aborted") {
    return exactReservedSource(session, transfer, ports) ||
      exactRestoredAbortSource(session, transfer, ports);
  }
  return false;
}

function exactReservedSource(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): boolean {
  return session.status === "transitioning" &&
    session.last_transition_id === transfer.transfer_id &&
    managedSessionRevision(session) === transfer.source_expected_revision + 1 &&
    managedSessionBindingToken(session) === managedSessionBindingToken({
      session_id: transfer.source_session_id,
      status: "transitioning",
      binding: transfer.source_before_binding
    }) &&
    ports.authority.valuesMatch(
      session.binding,
      transfer.source_before_binding
    );
}

function exactScrubbedSource(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer
): boolean {
  const before = transfer.source_before_binding;
  const after = session.binding;
  return Boolean(
    session.status === "transitioning" &&
    session.last_transition_id === transfer.transfer_id &&
    managedSessionRevision(session) === transfer.source_expected_revision + 2 &&
    after && after.binding_id !== before.binding_id &&
    after.generation === before.generation + 1 &&
    after.terminal_id === before.terminal_id &&
    terminalControlsShareIncarnation(
      after.terminal_control,
      before.terminal_control
    ) &&
    after.native_thread_id === undefined &&
    after.native_process.rollout === undefined &&
    after.native_process.pid === transfer.process_pid &&
    after.native_process.process_uuid === transfer.process_uuid &&
    after.native_process.process_birth === transfer.process_birth &&
    after.native_process.evidence ===
      "deferred_predecessor_binding_scrubbed"
  );
}

function exactCommittedSource(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): boolean {
  return session.status === "transitioning" &&
    session.last_transition_id === transfer.transfer_id &&
    managedSessionRevision(session) === transfer.source_pre_retirement_revision &&
    managedSessionBindingToken(session) ===
      transfer.source_pre_retirement_binding_token &&
    ports.authority.valuesMatch(
      session.binding,
      transfer.source_pre_retirement_binding
    );
}

function exactRestoredAbortSource(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): boolean {
  return session.status === "bound" &&
    session.last_transition_id === transfer.source_previous_last_transition_id &&
    managedSessionRevision(session) === transfer.source_expected_revision + 2 &&
    managedSessionBindingToken(session) === transfer.source_binding_token &&
    ports.authority.valuesMatch(
      session.binding,
      transfer.source_before_binding
    );
}

function exactTransferOwnedTarget(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): boolean {
  const origin = userAbandonmentOriginStatus(transfer);
  const provisional = exactProvisionalTarget(session, transfer, ports);
  if (origin === "target_prepared" || origin === "aborted") {
    return provisional;
  }
  if (["dispatch_started", "uncertain", "committed"].includes(origin)) {
    return provisional || exactAcceptedTargetForAbandonment(session, transfer) ||
      (origin === "committed" &&
        exactBoundCommittedTarget(session, transfer, ports));
  }
  return false;
}

function exactBoundCommittedTarget(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): boolean {
  return session.status === "bound" &&
    session.last_transition_id === undefined &&
    managedSessionRevision(session) ===
      Number(transfer.target_accepted_revision) + 1 &&
    ports.authority.valuesMatch(
      session.binding,
      transfer.target_accepted_binding
    ) &&
    managedSessionBindingToken(session) === managedSessionBindingToken({
      session_id: transfer.target_session_id,
      status: "bound",
      binding: transfer.target_accepted_binding
    });
}

function exactProvisionalTarget(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  ports: DeferredForegroundApplicationPorts
): boolean {
  return session.status === "transitioning" &&
    session.last_transition_id === transfer.transfer_id &&
    session.lineage.transition_id === transfer.transfer_id &&
    session.lineage.previous_session_id === transfer.source_session_id &&
    managedSessionRevision(session) === transfer.target_prepared_revision &&
    managedSessionBindingToken(session) === transfer.target_prepared_binding_token &&
    ports.authority.valuesMatch(session.binding, transfer.target_before_binding);
}

function exactAcceptedTargetForAbandonment(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer
): boolean {
  const before = transfer.target_before_binding;
  const after = session.binding;
  const acceptedRevision = Number(transfer.target_prepared_revision) + 1;
  return Boolean(
    before && after && session.status === "transitioning" &&
    session.last_transition_id === transfer.transfer_id &&
    session.lineage.transition_id === transfer.transfer_id &&
    session.lineage.previous_session_id === transfer.source_session_id &&
    managedSessionRevision(session) === acceptedRevision &&
    after.binding_id === before.binding_id &&
    after.generation === before.generation &&
    after.terminal_id === before.terminal_id &&
    terminalControlsShareIncarnation(
      after.terminal_control,
      before.terminal_control
    ) &&
    isExactNativeThreadId(after.native_thread_id) &&
    isCompleteNativeRollout(after.native_process.rollout) &&
    after.native_process.pid === transfer.process_pid &&
    after.native_process.process_uuid === transfer.process_uuid &&
    after.native_process.process_birth === transfer.process_birth
  );
}

function targetMayBeAbsent(transfer: DeferredForegroundTransfer): boolean {
  const origin = userAbandonmentOriginStatus(transfer);
  return origin === "target_prepared" || origin === "aborted" ||
    (origin === "uncertain" && transfer.input_stage === "dispatch_started");
}

function provablySupersededSession(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  kind: "source" | "target"
): boolean {
  const revision = managedSessionRevision(session);
  const knownRevision = kind === "source"
    ? Math.max(
        transfer.source_expected_revision + 2,
        Number(transfer.source_pre_retirement_revision ?? 0),
        Number(transfer.source_after_revision ?? 0),
        Number(transfer.abort_source_after_revision ?? 0)
      )
    : Math.max(
        Number(transfer.target_prepared_revision ?? 0) + 2,
        Number(transfer.target_accepted_revision ?? 0),
        Number(transfer.target_after_revision ?? 0),
        Number(transfer.abort_target_after_revision ?? 0)
      );
  const knownGeneration = kind === "source"
    ? Math.max(
        transfer.source_before_binding.generation + 1,
        Number(transfer.source_pre_retirement_binding?.generation ?? 0)
      )
    : Math.max(
        Number(transfer.target_before_binding?.generation ?? 0),
        Number(transfer.target_accepted_binding?.generation ?? 0)
      );
  return session.last_transition_id !== transfer.transfer_id &&
    (revision > knownRevision ||
      Number(session.binding?.generation ?? 0) > knownGeneration);
}

function userAbandonmentOriginStatus(
  transfer: DeferredForegroundTransfer
): string {
  return transfer.user_abandonment_origin_status ?? transfer.status;
}

function abandonmentFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function provedDispatchDidNotStart(
  transfer: DeferredForegroundTransfer,
  terminalInputNotStartedAt: string | undefined
): boolean {
  return transfer.status === "dispatch_started" &&
    transfer.input_stage === "dispatch_started" &&
    terminalInputNotStartedAt !== undefined &&
    Number.isFinite(Date.parse(terminalInputNotStartedAt));
}

function assertCanAbort(
  transfer: DeferredForegroundTransfer,
  provedZeroInput: boolean
): void {
  if (transfer.input_stage !== "none" && !provedZeroInput) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} may have started ` +
      "terminal input and cannot restore its source"
    );
  }
  const statusAllowed = [
    "prepared",
    "source_reserved",
    "target_prepared",
    "dispatch_started",
    "aborted"
  ].includes(transfer.status);
  if (!statusAllowed) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} cannot abort from ` +
      transfer.status
    );
  }
}

function assertZeroInputAbortIntent(
  transfer: DeferredForegroundTransfer
): void {
  const provedZeroInput = transfer.input_stage === "dispatch_started" &&
    transfer.terminal_input_not_started_at !== undefined &&
    Number.isFinite(Date.parse(transfer.terminal_input_not_started_at));
  if (
    transfer.status !== "aborted" ||
    (transfer.input_stage !== "none" && !provedZeroInput)
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} does not carry a ` +
      "zero-input abort intent"
    );
  }
}

function assertAbortTargetShape(
  target: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  valuesMatch: (left: unknown, right: unknown) => boolean
): void {
  if (
    target.lineage.transition_id !== transfer.transfer_id ||
    target.lineage.previous_session_id !== transfer.source_session_id ||
    target.binding?.native_thread_id ||
    target.binding?.native_process.rollout ||
    target.last_transition_id !== transfer.transfer_id ||
    !transfer.target_before_binding ||
    !valuesMatch(target.binding, transfer.target_before_binding)
  ) {
    throw new Error(
      `deferred foreground target ${target.session_id} changed before abort cleanup`
    );
  }
}

function assertAbortTargetRevision(
  target: ManagedSessionState,
  transfer: DeferredForegroundTransfer
): void {
  if (
    managedSessionRevision(target) !== transfer.target_prepared_revision ||
    managedSessionBindingToken(target) !== transfer.target_prepared_binding_token
  ) {
    throw new Error(
      `deferred foreground target ${target.session_id} changed before abort cleanup`
    );
  }
}

function assertResolvedAbortTarget(
  target: ManagedSessionState,
  transfer: DeferredForegroundTransfer
): void {
  const expectedToken = managedSessionBindingToken({
    session_id: transfer.target_session_id,
    status: "detached",
    binding: transfer.target_before_binding
  });
  if (
    target.status !== "detached" ||
    managedSessionRevision(target) !== Number(transfer.target_prepared_revision) + 1 ||
    managedSessionBindingToken(target) !== expectedToken
  ) {
    throw new Error(
      `deferred foreground target ${target.session_id} cannot finish abort ` +
      `cleanup from ${target.status}`
    );
  }
}

function isRestorableAbortSource(
  source: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  valuesMatch: (left: unknown, right: unknown) => boolean
): boolean {
  return source.status === "transitioning" &&
    source.last_transition_id === transfer.transfer_id &&
    managedSessionRevision(source) === transfer.source_expected_revision + 1 &&
    managedSessionBindingToken(source) === managedSessionBindingToken({
      session_id: transfer.source_session_id,
      status: "transitioning",
      binding: transfer.source_before_binding
    }) &&
    valuesMatch(source.binding, transfer.source_before_binding);
}

function assertResolvedAbortSource(
  source: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  valuesMatch: (left: unknown, right: unknown) => boolean
): void {
  const allowedRevisions = transfer.source_reserved_at
    ? [transfer.source_expected_revision + 2]
    : [transfer.source_expected_revision, transfer.source_expected_revision + 2];
  if (
    source.status !== "bound" ||
    source.last_transition_id !== transfer.source_previous_last_transition_id ||
    !allowedRevisions.includes(managedSessionRevision(source)) ||
    managedSessionBindingToken(source) !== transfer.source_binding_token ||
    !valuesMatch(source.binding, transfer.source_before_binding)
  ) {
    throw new Error(
      `deferred foreground source ${source.session_id} changed before abort cleanup`
    );
  }
}

function abortTargetReceipt(target: ManagedSessionState): {
  abort_target_after_revision: number;
  abort_target_after_binding_token: string;
  abort_target_after_binding: ManagedTerminalBinding | undefined;
} {
  return {
    abort_target_after_revision: managedSessionRevision(target),
    abort_target_after_binding_token: managedSessionBindingToken(target),
    abort_target_after_binding: target.binding
  };
}

function assertCreatedTarget(
  created: ManagedSessionState,
  boundary: DeferredCodexForegroundBindingBoundary
): void {
  if (
    managedSessionRevision(created) !== 1 ||
    managedSessionBindingToken(created) !== boundary.targetPreparedBindingToken
  ) {
    throw new Error(
      `deferred foreground target ${created.session_id} did not materialize ` +
      "at its prepared CAS authority"
    );
  }
}

function assertStageTransition(
  transfer: DeferredForegroundTransfer,
  stage: "text_injected" | "enter_dispatched"
): void {
  const expected: DeferredForegroundTransferInputStage = stage ===
      "text_injected"
    ? "dispatch_started"
    : "text_injected";
  if (transfer.status !== "dispatch_started" || transfer.input_stage !== expected) {
    const action = stage === "text_injected" ? "record text" : "record Enter";
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} cannot ${action} ` +
      `from ${transfer.status}/${transfer.input_stage}`
    );
  }
}

function assertAcceptedIdentityAuthority(
  transfer: DeferredForegroundTransfer,
  identity: NativeAgentSessionIdentity
): void {
  if (
    !["dispatch_started", "uncertain"].includes(transfer.status) ||
    transfer.input_stage === "none" ||
    identity.processUuid !== transfer.process_uuid ||
    identity.processBirth !== transfer.process_birth ||
    !isExactNativeThreadId(identity.sessionId) ||
    !isCompleteNativeRollout(identity.rollout)
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} lacks exact ` +
      "accepted identity authority"
    );
  }
}

function abandonedSourceAllowance(
  transfer: DeferredForegroundTransfer
): string[] {
  return transfer.source_rollout_authority ===
      "explicitly_abandoned_predecessor"
    ? [transfer.source_session_id]
    : [];
}

function assertCommittedReceipt(transfer: DeferredForegroundTransfer): void {
  if (
    transfer.status !== "committed" ||
    !transfer.source_pre_retirement_binding ||
    !transfer.source_pre_retirement_revision ||
    !transfer.source_pre_retirement_binding_token ||
    !transfer.target_accepted_binding ||
    !transfer.target_accepted_revision ||
    !transfer.target_accepted_binding_token ||
    !transfer.target_native_thread_id
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} is not committed`
    );
  }
}

function assertSourceCommitReceipt(
  source: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  valuesMatch: (left: unknown, right: unknown) => boolean
): void {
  if (
    source.last_transition_id !== transfer.transfer_id ||
    managedSessionRevision(source) !== transfer.source_pre_retirement_revision ||
    managedSessionBindingToken(source) !==
      transfer.source_pre_retirement_binding_token ||
    !valuesMatch(source.binding, transfer.source_pre_retirement_binding)
  ) {
    throw new Error(
      `deferred foreground source ${source.session_id} changed during commit recovery`
    );
  }
}

function assertRetiredSource(
  source: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  valuesMatch: (left: unknown, right: unknown) => boolean
): void {
  const token = managedSessionBindingToken({
    session_id: source.session_id,
    status: "detached",
    binding: transfer.source_pre_retirement_binding
  });
  if (
    source.status !== "detached" ||
    managedSessionRevision(source) !==
      Number(transfer.source_pre_retirement_revision) + 1 ||
    managedSessionBindingToken(source) !== token ||
    !valuesMatch(source.binding, transfer.source_pre_retirement_binding)
  ) {
    throw new Error(
      `deferred foreground source ${source.session_id} has no exact retired receipt`
    );
  }
}

function assertTargetCommitReceipt(
  target: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  valuesMatch: (left: unknown, right: unknown) => boolean
): void {
  if (
    target.last_transition_id !== transfer.transfer_id ||
    managedSessionRevision(target) !== transfer.target_accepted_revision ||
    managedSessionBindingToken(target) !== transfer.target_accepted_binding_token ||
    !valuesMatch(target.binding, transfer.target_accepted_binding)
  ) {
    throw new Error(
      `deferred foreground target ${target.session_id} changed during commit recovery`
    );
  }
}

function assertBoundTarget(
  target: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  valuesMatch: (left: unknown, right: unknown) => boolean
): void {
  const token = managedSessionBindingToken({
    session_id: target.session_id,
    status: "bound",
    binding: transfer.target_accepted_binding
  });
  if (
    target.status !== "bound" ||
    managedSessionRevision(target) !==
      Number(transfer.target_accepted_revision) + 1 ||
    managedSessionBindingToken(target) !== token ||
    !valuesMatch(target.binding, transfer.target_accepted_binding)
  ) {
    throw new Error(
      `deferred foreground target ${target.session_id} has no exact bound receipt`
    );
  }
}
