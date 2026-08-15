import type { Conversation } from "./protocol.js";
import type {
  TerminalCompletionEvidence,
  TerminalControlRef
} from "./terminal-agent-adapter.js";
import type { TerminalSubmissionAcceptanceEvidence } from
  "./terminal-submission-facts.js";
import {
  decideVerifiedDeadAgentCompletion,
  decideVerifiedDeadAgentProcess,
  verifiedDeadTerminalAgentProcessEvidenceId,
  type BoundTerminalAgentProcessObservation,
  type VerifiedDeadAgentAuthorityDecision,
  type VerifiedDeadAgentCompletionObservation,
  type VerifiedDeadTerminalAgentProcessProof
} from "./verified-dead-agent-policy.js";

export interface TerminalBindingLedgerFacts {
  binding_id?: string;
  binding_generation?: number;
  native_thread_id?: string;
  store_dir?: string;
  message_type?: string;
  message_body_hash?: string;
  deferred_foreground_transfer_id?: string;
  executor_kind: string;
  openclaw_session?: string;
}

export interface TerminalSubmissionRecoveryFacts {
  status?: string;
  messageId?: string;
  preparedAt?: string;
  textInjectedAt?: string;
  enterDispatchedAt?: string;
  submittedAt?: string;
  agentAcceptedAt?: string;
  notAcceptedAt?: string;
  uncertainAt?: string;
  abortedAt?: string;
  lastProvenStage?: string;
  acceptanceEvidence?: TerminalSubmissionAcceptanceEvidence;
}

export interface TerminalDispatchLedgerMutation extends Record<string, unknown> {
  status: string;
  generation_id?: string;
  conversation_id?: string;
  message_id?: string;
  message_type?: string;
  request_hash?: string;
  prepared_at?: string;
  text_injected_at?: string;
  enter_dispatched_at?: string;
  submitted_at?: string;
  agent_accepted_at?: string;
  not_accepted_at?: string;
  uncertain_at?: string;
  aborted_at?: string;
  resolved_at?: string;
  acceptance_evidence?: TerminalSubmissionAcceptanceEvidence;
  last_proven_stage?: string;
  dispatcher_pid?: number | null;
  state_path?: string;
  event_log_path?: string;
  callback_expected?: boolean;
  reason: string;
  binding?: TerminalBindingLedgerFacts;
}

export type PreparedDispatchOwnerFacts =
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "mismatch" }
  | {
      status: "loaded";
      conversationId: string;
      updatedAt?: string;
      storedMessageId?: string;
      submission: TerminalSubmissionRecoveryFacts;
      binding: TerminalBindingLedgerFacts;
      requestHash?: string;
      statePath: string;
      eventLogPath: string;
      callbackExpected: boolean;
    };

export interface PreparedDispatchRecoveryInput {
  ledger: {
    lifecycle: boolean;
    status?: string;
    dispatcherPid?: number;
    dispatcherActive: boolean;
    statePath?: string;
    eventLogPath?: string;
    messageId?: string;
    conversationId?: string;
  };
  owner: PreparedDispatchOwnerFacts;
  now(): string;
}

export type PreparedDispatchRecoveryDecision =
  | { action: "keep" }
  | { action: "reconcile_lagging" }
  | { action: "save_ledger"; mutation: TerminalDispatchLedgerMutation }
  | { action: "replace_ledger"; mutation: TerminalDispatchLedgerMutation };

/** Decide prepared-ledger crash recovery without reading state or writing I/O. */
export function decidePreparedDispatchRecovery(
  input: PreparedDispatchRecoveryInput
): PreparedDispatchRecoveryDecision {
  const { ledger, owner } = input;
  if (ledger.lifecycle) return { action: "keep" };
  if (ledger.status !== "prepared") {
    return { action: "reconcile_lagging" };
  }
  if (ledger.dispatcherActive || !ledger.statePath || !ledger.messageId) {
    return { action: "keep" };
  }
  if (owner.status === "unreadable") return { action: "keep" };
  if (owner.status === "mismatch") return { action: "keep" };
  if (owner.status === "missing") {
    return resolvedPreparedMutation(
      input.now(),
      "dispatcher exited before the prepared owner state existed; no terminal input was possible"
    );
  }
  if (
    owner.storedMessageId === ledger.messageId &&
    owner.submission.messageId === ledger.messageId
  ) {
    return recoverCurrentPreparedGeneration(input, owner);
  }
  return recoverPreviousPreparedGeneration(input, owner);
}

function recoverCurrentPreparedGeneration(
  input: PreparedDispatchRecoveryInput,
  owner: Extract<PreparedDispatchOwnerFacts, { status: "loaded" }>
): PreparedDispatchRecoveryDecision {
  const submission = owner.submission;
  if (![
    "submitted",
    "text_injected",
    "enter_dispatched",
    "agent_accepted"
  ].includes(submission.status ?? "")) {
    return {
      action: "save_ledger",
      mutation: {
        status: "uncertain",
        uncertain_at: input.now(),
        reason:
          "dispatcher exited after the prepared state became durable; terminal submission cannot be proven"
      }
    };
  }
  const at = submission.agentAcceptedAt ?? submission.enterDispatchedAt ??
    submission.textInjectedAt ?? submission.submittedAt ?? owner.updatedAt ??
    input.now();
  return {
    action: "save_ledger",
    mutation: {
      status: submission.status!,
      ...(submission.textInjectedAt
        ? { text_injected_at: submission.textInjectedAt }
        : {}),
      ...(submission.enterDispatchedAt
        ? { enter_dispatched_at: submission.enterDispatchedAt }
        : {}),
      ...(submission.status === "agent_accepted"
        ? {
            agent_accepted_at: at,
            acceptance_evidence: submission.acceptanceEvidence
          }
        : submission.status === "submitted"
          ? { submitted_at: at }
          : {}),
      reason: "recovered from the durable conversation submission receipt"
    }
  };
}

function recoverPreviousPreparedGeneration(
  input: PreparedDispatchRecoveryInput,
  owner: Extract<PreparedDispatchOwnerFacts, { status: "loaded" }>
): PreparedDispatchRecoveryDecision {
  const submission = owner.submission;
  const messageId = owner.storedMessageId;
  if (
    messageId &&
    submission.messageId === messageId &&
    ["submitted", "agent_accepted"].includes(submission.status ?? "")
  ) {
    return {
      action: "replace_ledger",
      mutation: {
        ...owner.binding,
        status: submission.status!,
        generation_id: messageId,
        conversation_id: owner.conversationId,
        message_id: messageId,
        ...(submission.status && owner.binding.message_type
          ? { message_type: owner.binding.message_type }
          : {}),
        request_hash: owner.requestHash,
        prepared_at: submission.preparedAt ?? owner.updatedAt,
        ...(submission.status === "agent_accepted"
          ? {
              agent_accepted_at: submission.agentAcceptedAt ?? owner.updatedAt,
              acceptance_evidence: submission.acceptanceEvidence
            }
          : { submitted_at: submission.submittedAt ?? owner.updatedAt }),
        dispatcher_pid: null,
        state_path: owner.statePath,
        event_log_path: input.ledger.eventLogPath ?? owner.eventLogPath,
        callback_expected: owner.callbackExpected,
        reason:
          "restored the prior durable generation after a pre-submit dispatcher exit"
      }
    };
  }
  return resolvedPreparedMutation(
    input.now(),
    "dispatcher exited before the prepared generation reached durable state; no terminal input was possible"
  );
}

function resolvedPreparedMutation(
  now: string,
  reason: string
): PreparedDispatchRecoveryDecision {
  return {
    action: "save_ledger",
    mutation: { status: "resolved", resolved_at: now, reason }
  };
}

export interface LaggingDispatchRecoveryInput {
  eligible: boolean;
  ledgerStatus?: string;
  stateStatus?: string;
  stateAcceptance?: TerminalSubmissionAcceptanceEvidence;
  ledgerAcceptance?: TerminalSubmissionAcceptanceEvidence;
  ledgerAcceptanceError?: string;
  ledgerAgentAcceptedAt?: string;
  ledgerLastProvenStage?: string;
  submission: TerminalSubmissionRecoveryFacts;
  binding: TerminalBindingLedgerFacts;
  now: string;
}

export type LaggingDispatchRecoveryDecision =
  | { action: "keep" }
  | {
      action: "save_turn_accepted";
      acceptedAt: string;
      acceptanceEvidence: TerminalSubmissionAcceptanceEvidence;
    }
  | {
      action: "save_turn_uncertain_and_ledger";
      uncertainAt: string;
      reason: string;
      ledger: TerminalDispatchLedgerMutation;
    }
  | { action: "save_ledger"; mutation: TerminalDispatchLedgerMutation };

/** Select the strongest durable proof without authorizing terminal replay. */
export function decideLaggingDispatchRecovery(
  input: LaggingDispatchRecoveryInput
): LaggingDispatchRecoveryDecision {
  if (!input.eligible) return { action: "keep" };
  if (input.ledgerAcceptance) {
    if (input.stateAcceptance) return { action: "keep" };
    return {
      action: "save_turn_accepted",
      acceptedAt: input.ledgerAgentAcceptedAt ?? input.now,
      acceptanceEvidence: input.ledgerAcceptance
    };
  }
  if (input.stateAcceptance) {
    return {
      action: "save_ledger",
      mutation: acceptedLedgerMutation(input)
    };
  }
  if (input.ledgerStatus === "agent_accepted") {
    return invalidAcceptanceDecision(input);
  }
  return strongerStateDecision(input);
}

function acceptedLedgerMutation(
  input: LaggingDispatchRecoveryInput
): TerminalDispatchLedgerMutation {
  return {
    ...input.binding,
    status: "agent_accepted",
    text_injected_at: input.submission.textInjectedAt,
    enter_dispatched_at: input.submission.enterDispatchedAt,
    agent_accepted_at: input.submission.agentAcceptedAt ?? input.now,
    acceptance_evidence: input.stateAcceptance,
    dispatcher_pid: null,
    reason: "recovered the strongest durable native acceptance receipt"
  };
}

function invalidAcceptanceDecision(
  input: LaggingDispatchRecoveryInput
): LaggingDispatchRecoveryDecision {
  const reason = input.ledgerAcceptanceError ??
    "stored native acceptance evidence is invalid";
  return {
    action: "save_turn_uncertain_and_ledger",
    uncertainAt: input.now,
    reason,
    ledger: {
      ...input.binding,
      status: "uncertain",
      uncertain_at: input.now,
      dispatcher_pid: null,
      reason: "stored native acceptance evidence is invalid"
    }
  };
}

function strongerStateDecision(
  input: LaggingDispatchRecoveryInput
): LaggingDispatchRecoveryDecision {
  const stateStatus = input.stateStatus ?? "";
  const stateRank = terminalSubmissionProofRank(
    stateStatus,
    input.submission.lastProvenStage
  );
  const ledgerRank = terminalSubmissionProofRank(
    input.ledgerStatus ?? "",
    input.ledgerLastProvenStage
  );
  const terminal = ["not_accepted", "uncertain", "aborted"].includes(
    stateStatus
  );
  if ((!terminal && stateRank <= ledgerRank) || ![
    "text_injected",
    "enter_dispatched",
    "submitted",
    "not_accepted",
    "uncertain",
    "aborted"
  ].includes(stateStatus)) {
    return { action: "keep" };
  }
  return {
    action: "save_ledger",
    mutation: {
      ...input.binding,
      status: stateStatus,
      text_injected_at: input.submission.textInjectedAt,
      enter_dispatched_at: input.submission.enterDispatchedAt,
      submitted_at: input.submission.submittedAt,
      not_accepted_at: input.submission.notAcceptedAt,
      uncertain_at: input.submission.uncertainAt,
      aborted_at: input.submission.abortedAt,
      last_proven_stage: input.submission.lastProvenStage,
      ...(terminal ? { dispatcher_pid: null } : {}),
      reason: "recovered the strongest durable conversation proof level"
    }
  };
}

function terminalSubmissionProofRank(
  status: string,
  lastProven?: string
): number {
  if (status === "agent_accepted" || lastProven === "agent_accepted") return 3;
  if (
    ["enter_dispatched", "submitted", "not_accepted"].includes(status) ||
    lastProven === "enter_dispatched"
  ) return 2;
  return status === "text_injected" || lastProven === "text_injected" ? 1 : 0;
}

export interface VerifiedDeadDispatchAuthorityFacts {
  conversationId: string;
  stateAuthorityExact: boolean;
  ledgerAuthorityExact: boolean;
  ledgerResolved: boolean;
  acceptance:
    | { status: "valid"; allEqual: boolean }
    | { status: "invalid"; reason: string };
}

export function assertVerifiedDeadDispatchAuthorityFacts(
  facts: VerifiedDeadDispatchAuthorityFacts
): { resolved: boolean } {
  if (!facts.stateAuthorityExact) {
    throw new Error(
      `verified-dead Turn ${facts.conversationId} has no exact accepted submission authority`
    );
  }
  if (!facts.ledgerAuthorityExact) {
    throw new Error(
      `verified-dead Turn ${facts.conversationId} no longer owns one exact terminal dispatch receipt`
    );
  }
  if (facts.acceptance.status === "invalid") {
    throw new Error(
      `verified-dead Turn ${facts.conversationId} has invalid native acceptance evidence: ` +
        facts.acceptance.reason
    );
  }
  if (!facts.acceptance.allEqual) {
    throw new Error(
      `verified-dead Turn ${facts.conversationId} has conflicting native acceptance receipts`
    );
  }
  return { resolved: facts.ledgerResolved };
}

/** Opaque application-side transaction scope; adapters authenticate it. */
export interface TerminalDispatchRecoveryScope {}

export interface VerifiedDeadRecoveryContext {
  scope: TerminalDispatchRecoveryScope;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  messageId: string;
}

export type TerminalCompletionPreparation<Prepared> =
  | { claimed: true; conversation: Conversation; prepared: Prepared }
  | { claimed: false; conversation: Conversation; reason: string };

export interface VerifiedDeadRecoveryResult<Prepared> {
  stalled: boolean;
  conversation: Conversation;
  reason: string;
  completionPreparation?: TerminalCompletionPreparation<Prepared>;
}

export interface LocalCompletionRecoveryResult {
  handled: boolean;
  recovered: boolean;
  reason: string;
}

export interface LocalCompletionRecoveryContext {
  scope: TerminalDispatchRecoveryScope;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  terminalMessageId: string;
  completionId: string;
  callbackMessageId: string;
  outcome: string;
}

export interface TerminalDispatchRecoveryPorts<Prepared> {
  transaction: {
    verifiedDead(
      request: {
        storeDir: string;
        statePath: string;
        logPath: string;
        expectedConversationId: string;
        expectedMessageId?: string;
      },
      operation: (
        context: VerifiedDeadRecoveryContext
      ) => Promise<VerifiedDeadRecoveryResult<Prepared>>
    ): Promise<VerifiedDeadRecoveryResult<Prepared>>;
    localCompletion(
      request: { storeDir: string; statePath: string; logPath: string },
      operation: (
        context: LocalCompletionRecoveryContext
      ) => LocalCompletionRecoveryResult
    ): LocalCompletionRecoveryResult;
  };
  authority: {
    assertBinding(context: VerifiedDeadRecoveryContext): void;
    basicAcceptedDispatch(context: VerifiedDeadRecoveryContext): boolean;
    assertAcceptedDispatch(context: VerifiedDeadRecoveryContext): void;
    persistedDeath(
      context: VerifiedDeadRecoveryContext
    ): VerifiedDeadAgentAuthorityDecision;
    observeDeath(
      context: VerifiedDeadRecoveryContext
    ): Promise<BoundTerminalAgentProcessObservation>;
    priorStall(input: {
      context: VerifiedDeadRecoveryContext;
      proof: VerifiedDeadTerminalAgentProcessProof;
      evidenceId: string;
      reason: string;
    }):
      | { status: "absent" }
      | { status: "valid"; completionObservation: "absent" | "unverifiable" }
      | { status: "invalid"; reason: string };
    durableCompletion(
      context: VerifiedDeadRecoveryContext
    ): Promise<VerifiedDeadAgentCompletionObservation<TerminalCompletionEvidence>>;
    assertLocalCompletion(context: LocalCompletionRecoveryContext): {
      ledgerResolved: boolean;
    };
  };
  evidence: {
    ensureDeath(input: {
      context: VerifiedDeadRecoveryContext;
      proof: VerifiedDeadTerminalAgentProcessProof;
    }): {
      proof: VerifiedDeadTerminalAgentProcessProof;
      evidenceId: string;
      recordedAt: string;
    };
    ensureStall(input: {
      context: VerifiedDeadRecoveryContext;
      proof: VerifiedDeadTerminalAgentProcessProof;
      evidenceId: string;
      reason: string;
      completionObservation: "absent" | "unverifiable";
    }): void;
  };
  state: {
    save(
      context: VerifiedDeadRecoveryContext,
      conversation: Conversation
    ): void;
    crashAfterStallEvents(): void;
    logDeath(input: {
      context: VerifiedDeadRecoveryContext;
      proof: VerifiedDeadTerminalAgentProcessProof;
      reason: string;
    }): void;
    settleLocalCompletion(context: LocalCompletionRecoveryContext): void;
  };
  completion: {
    prepareAfterStateRelease(
      context: VerifiedDeadRecoveryContext,
      completion: TerminalCompletionEvidence
    ): TerminalCompletionPreparation<Prepared>;
  };
}

/** Own verified-dead and callbackless completion effect ordering. */
export class TerminalDispatchRecoveryService<Prepared> {
  readonly #ports: TerminalDispatchRecoveryPorts<Prepared>;

  constructor(ports: TerminalDispatchRecoveryPorts<Prepared>) {
    this.#ports = ports;
  }

  stallAcceptedForVerifiedDead(request: {
    storeDir: string;
    statePath: string;
    logPath: string;
    expectedConversationId: string;
    expectedMessageId?: string;
  }): Promise<VerifiedDeadRecoveryResult<Prepared>> {
    return this.#ports.transaction.verifiedDead(
      request,
      (context) => this.#recoverVerifiedDead(context)
    );
  }

  settleLocalCompletion(request: {
    storeDir: string;
    statePath: string;
    logPath: string;
  }): LocalCompletionRecoveryResult {
    return this.#ports.transaction.localCompletion(request, (context) => {
      const authority = this.#ports.authority.assertLocalCompletion(context);
      if (authority.ledgerResolved) {
        return {
          handled: true,
          recovered: false,
          reason: "local_terminal_completion_already_settled"
        };
      }
      this.#ports.state.settleLocalCompletion(context);
      return {
        handled: true,
        recovered: true,
        reason: "local_terminal_completion_ledger_recovered"
      };
    });
  }

  async #recoverVerifiedDead(
    context: VerifiedDeadRecoveryContext
  ): Promise<VerifiedDeadRecoveryResult<Prepared>> {
    this.#ports.authority.assertBinding(context);
    if (!this.#ports.authority.basicAcceptedDispatch(context)) {
      return unchangedVerifiedDeadResult(
        context,
        "dead_process_stall_dispatch_changed"
      );
    }
    try {
      this.#ports.authority.assertAcceptedDispatch(context);
    } catch (error) {
      return unchangedVerifiedDeadResult(
        context,
        "dead_process_stall_dispatch_changed: " + errorMessage(error)
      );
    }
    const persisted = this.#ports.authority.persistedDeath(context);
    const processDecision = await this.#decideProcess(context, persisted);
    if (processDecision.status !== "verified_dead") {
      return unchangedVerifiedDeadResult(context, processDecision.reason);
    }
    return this.#recoverFromProof(context, persisted, processDecision.proof);
  }

  async #decideProcess(
    context: VerifiedDeadRecoveryContext,
    persisted: VerifiedDeadAgentAuthorityDecision
  ): Promise<
    | { status: "verified_dead"; proof: VerifiedDeadTerminalAgentProcessProof }
    | { status: "other"; reason: string }
  > {
    const persistedDecision = decideVerifiedDeadAgentProcess({
      persistedAuthority: persisted
    });
    if (persistedDecision.status === "invalid") {
      return {
        status: "other",
        reason: `bound_agent_process_evidence_invalid: ${persistedDecision.reason}`
      };
    }
    if (persistedDecision.status === "verified_dead") {
      return { status: "verified_dead", proof: persistedDecision.proof };
    }
    const observed = decideVerifiedDeadAgentProcess({
      persistedAuthority: { status: "absent" },
      observation: await this.#ports.authority.observeDeath(context)
    });
    if (observed.status === "verified_dead") {
      return { status: "verified_dead", proof: observed.proof };
    }
    return {
      status: "other",
      reason: observed.status === "alive"
        ? "bound_agent_process_alive"
        : `bound_agent_process_unverifiable: ${observed.reason}`
    };
  }

  async #recoverFromProof(
    context: VerifiedDeadRecoveryContext,
    persisted: VerifiedDeadAgentAuthorityDecision,
    proof: VerifiedDeadTerminalAgentProcessProof
  ): Promise<VerifiedDeadRecoveryResult<Prepared>> {
    const stalledReason = "bound terminal agent process is verified dead";
    const evidenceId = verifiedDeadTerminalAgentProcessEvidenceId(proof);
    const prior = this.#ports.authority.priorStall({
      context,
      proof,
      evidenceId,
      reason: stalledReason
    });
    if (prior.status === "invalid") {
      return unchangedVerifiedDeadResult(
        context,
        `bound_agent_process_evidence_invalid: ${prior.reason}`
      );
    }
    if (prior.status === "valid") {
      return this.#resumePriorStall(context, persisted, prior, stalledReason);
    }
    const completion = decideVerifiedDeadAgentCompletion(
      await this.#ports.authority.durableCompletion(context)
    );
    if (completion.action === "complete") {
      const prepared = this.#ports.completion.prepareAfterStateRelease(
        context,
        completion.completion
      );
      return {
        stalled: false,
        conversation: prepared.conversation,
        reason: prepared.claimed
          ? "bound_agent_process_dead_completion_prepared"
          : `bound_agent_process_dead_completion_${prepared.reason}`,
        completionPreparation: prepared
      };
    }
    return this.#persistFreshStall(
      context,
      proof,
      stalledReason,
      completion.completionObservation,
      completion.resultReason
    );
  }

  #resumePriorStall(
    context: VerifiedDeadRecoveryContext,
    persisted: VerifiedDeadAgentAuthorityDecision,
    prior: { status: "valid"; completionObservation: "absent" | "unverifiable" },
    reason: string
  ): VerifiedDeadRecoveryResult<Prepared> {
    if (persisted.status !== "valid") {
      return unchangedVerifiedDeadResult(
        context,
        "bound_agent_process_evidence_invalid: the stalled decision has no exact death event"
      );
    }
    const stalled = stalledConversation(
      context.conversation,
      persisted.proof,
      persisted.evidenceId,
      persisted.recordedAt,
      reason,
      prior.completionObservation
    );
    this.#ports.state.save(context, stalled);
    return {
      stalled: true,
      conversation: stalled,
      reason: prior.completionObservation === "unverifiable"
        ? "bound_agent_process_verified_dead_completion_unverifiable"
        : "bound_agent_process_verified_dead"
    };
  }

  #persistFreshStall(
    context: VerifiedDeadRecoveryContext,
    proof: VerifiedDeadTerminalAgentProcessProof,
    reason: string,
    completionObservation: "absent" | "unverifiable",
    resultReason: string
  ): VerifiedDeadRecoveryResult<Prepared> {
    const audit = this.#ports.evidence.ensureDeath({ context, proof });
    this.#ports.evidence.ensureStall({
      context,
      proof: audit.proof,
      evidenceId: audit.evidenceId,
      reason,
      completionObservation
    });
    this.#ports.state.crashAfterStallEvents();
    const stalled = stalledConversation(
      context.conversation,
      audit.proof,
      audit.evidenceId,
      audit.recordedAt,
      reason,
      completionObservation
    );
    this.#ports.state.save(context, stalled);
    this.#ports.state.logDeath({
      context,
      proof: audit.proof,
      reason
    });
    return { stalled: true, conversation: stalled, reason: resultReason };
  }
}

function stalledConversation(
  conversation: Conversation,
  proof: VerifiedDeadTerminalAgentProcessProof,
  evidenceId: string,
  recordedAt: string,
  reason: string,
  completionObservation: "absent" | "unverifiable"
): Conversation {
  return {
    ...conversation,
    status: "stalled",
    stalled_at: recordedAt,
    stalled_reason: reason,
    terminal_agent_process_disposition: {
      status: "verified_dead",
      proof,
      evidence_id: evidenceId,
      recorded_at: recordedAt,
      completion_observation: { status: completionObservation }
    },
    updated_at: recordedAt
  };
}

function unchangedVerifiedDeadResult<Prepared>(
  context: VerifiedDeadRecoveryContext,
  reason: string
): VerifiedDeadRecoveryResult<Prepared> {
  return { stalled: false, conversation: context.conversation, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
