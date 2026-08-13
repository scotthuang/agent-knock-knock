/**
 * Pure lifecycle transition decisions.
 *
 * Callers must collect and validate terminal, Store, process, token, and
 * candidate facts before invoking these reducers. This module deliberately
 * owns no I/O, lock acquisition, persistence, clocks, or user-facing text.
 */

import type {
  ManagedSessionState,
  ManagedTerminalBinding,
  NativeThreadCandidate,
  NativeThreadTransition
} from "./managed-session.js";
import type { TerminalNativeIdentity } from "./terminal-binding-authority.js";

export type NativeThreadCommandOperation = "new_thread" | "resume_thread";

export type NativeThreadTransitionEligibilityDecision =
  | { action: "proceed" }
  | {
      action: "reject";
      reason:
        | "binding_token_changed"
        | "lifecycle_status_not_supported"
        | "new_thread_not_supported"
        | "resume_thread_not_supported";
    };

export function decideNativeThreadTransitionEligibility(input: {
  operation: NativeThreadCommandOperation;
  bindingTokenMatches: boolean;
  capabilityStatus: "supported" | "unsupported" | "unknown";
  newThreadSupported: boolean;
  resumeExactSupported: boolean;
}): NativeThreadTransitionEligibilityDecision {
  if (!input.bindingTokenMatches) {
    return { action: "reject", reason: "binding_token_changed" };
  }
  if (input.capabilityStatus !== "supported") {
    return { action: "reject", reason: "lifecycle_status_not_supported" };
  }
  if (input.operation === "new_thread" && !input.newThreadSupported) {
    return { action: "reject", reason: "new_thread_not_supported" };
  }
  if (input.operation === "resume_thread" && !input.resumeExactSupported) {
    return { action: "reject", reason: "resume_thread_not_supported" };
  }
  return { action: "proceed" };
}

export type ResumeCandidateEligibilityDecision =
  | { action: "proceed"; candidate: NativeThreadCandidate }
  | {
      action: "reject";
      reason:
        | "candidate_not_found"
        | "candidate_not_resumable"
        | "candidate_token_changed";
    };

export function decideResumeCandidateEligibility(input: {
  candidate?: NativeThreadCandidate;
  expectedCandidateToken: string;
}): ResumeCandidateEligibilityDecision {
  if (input.candidate === undefined) {
    return { action: "reject", reason: "candidate_not_found" };
  }
  if (!input.candidate.resumable) {
    return { action: "reject", reason: "candidate_not_resumable" };
  }
  if (input.candidate.candidate_token !== input.expectedCandidateToken) {
    return { action: "reject", reason: "candidate_token_changed" };
  }
  return { action: "proceed", candidate: input.candidate };
}

export type ResumeTargetSessionDecision =
  | { action: "proceed" }
  | { action: "detach_stale_binding" }
  | {
      action: "reject";
      reason: "unresolved_turn" | "bound_owner_not_conclusively_inactive";
    };

export function decideResumeTargetSession(input: {
  hasUnresolvedTurn: boolean;
  loadedSession?: ManagedSessionState;
  boundOwnerConclusivelyInactive: boolean;
}): ResumeTargetSessionDecision {
  if (input.hasUnresolvedTurn) {
    return { action: "reject", reason: "unresolved_turn" };
  }
  if (input.loadedSession?.status !== "bound") {
    return { action: "proceed" };
  }
  if (input.boundOwnerConclusivelyInactive !== true) {
    return {
      action: "reject",
      reason: "bound_owner_not_conclusively_inactive"
    };
  }
  return { action: "detach_stale_binding" };
}

export type ManagedBindingConflictKind =
  | "stale_process_incarnation"
  | "live_external_thread_change"
  | "provisional_orphan"
  | "unverifiable";

export type BindingReconciliationDecision =
  | { action: "detach_conflicting_binding" }
  | {
      action: "reject";
      reason:
        | "stale_process_incarnation"
        | "already_exact"
        | "unverifiable";
    };

export function decideBindingReconciliation(
  conflictKind: ManagedBindingConflictKind | undefined
): BindingReconciliationDecision {
  if (
    conflictKind === "provisional_orphan" ||
    conflictKind === "live_external_thread_change"
  ) {
    return { action: "detach_conflicting_binding" };
  }
  if (conflictKind === "stale_process_incarnation") {
    return { action: "reject", reason: "stale_process_incarnation" };
  }
  if (conflictKind === undefined) {
    return { action: "reject", reason: "already_exact" };
  }
  return { action: "reject", reason: "unverifiable" };
}

export type DurableNativeThreadTransitionStatus =
  | "prepared"
  | "dispatching"
  | "submitted"
  | "uncertain"
  | "verified"
  | "committed"
  | "aborted";

export type NativeThreadTransitionFailureDecision =
  | { action: "report_committed_bookkeeping_failure" }
  | { action: "require_verified_recovery" }
  | { action: "abort_before_terminal_input" }
  | { action: "mark_uncertain" };

export function decideNativeThreadTransitionFailure(input: {
  durableStatus: DurableNativeThreadTransitionStatus;
  inputStarted: boolean;
  errorProvesInputNotStarted: boolean;
}): NativeThreadTransitionFailureDecision {
  if (input.durableStatus === "committed") {
    return { action: "report_committed_bookkeeping_failure" };
  }
  if (input.durableStatus === "verified") {
    return { action: "require_verified_recovery" };
  }
  if (!input.inputStarted && input.errorProvesInputNotStarted) {
    return { action: "abort_before_terminal_input" };
  }
  return { action: "mark_uncertain" };
}

export type NativeThreadTransitionPhaseEvent =
  | { type: "dispatch_started"; at: string }
  | { type: "submission_recorded"; at: string }
  | {
      type: "target_verified";
      at: string;
      afterBinding: ManagedTerminalBinding;
    }
  | { type: "commit_recorded"; at: string }
  | { type: "aborted_before_input"; at: string; error: string }
  | { type: "outcome_uncertain"; at: string; error: string };

export interface NativeThreadTransitionPreparation {
  transitionId: string;
  operation:
    | { kind: "new_thread" }
    | { kind: "resume_thread"; nativeThreadId: string };
  terminalId: string;
  agent: NativeThreadTransition["agent"];
  workspace: string;
  source?: {
    state: ManagedSessionState;
    revision: number;
  };
  targetSessionId: string;
  target?: {
    state: ManagedSessionState;
    revision: number;
  };
  candidateFileIdentity?:
    NativeThreadTransition["target_candidate_file_identity"];
  beforeIdentity: TerminalNativeIdentity;
  beforeProcessUuid: string;
  beforeBinding?: ManagedTerminalBinding;
  adapterVersion: string;
  commandFingerprint: string;
  dispatcherPid: number;
  preparedAt: string;
}

export function prepareNativeThreadTransition(
  input: NativeThreadTransitionPreparation
): NativeThreadTransition {
  return {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: input.transitionId,
    operation: input.operation.kind,
    status: "prepared",
    terminal_id: input.terminalId,
    agent: input.agent,
    workspace: input.workspace,
    source_session_id: input.source?.state.session_id,
    source_expected_revision: input.source?.revision,
    source_previous_last_transition_id:
      input.source?.state.last_transition_id,
    target_session_id: input.targetSessionId,
    target_expected_revision: input.target?.revision ?? null,
    target_native_thread_id: input.operation.kind === "resume_thread"
      ? input.operation.nativeThreadId
      : undefined,
    target_candidate_file_identity: input.candidateFileIdentity,
    before_native_thread_id: input.beforeIdentity.sessionId,
    before_process_uuid: input.beforeProcessUuid,
    before_process_started_at: input.beforeIdentity.processStartedAt,
    before_process_birth: input.beforeIdentity.processBirth,
    before_process_rollout: input.beforeIdentity.rollout,
    before_binding: input.beforeBinding,
    adapter_version: input.adapterVersion,
    command_fingerprint: input.commandFingerprint,
    dispatcher_pid: input.dispatcherPid,
    prepared_at: input.preparedAt
  };
}

/**
 * Builds the next in-memory transition value only. The caller retains the
 * revision CAS, durable write, ledger ordering, and crash fences.
 */
export function reduceNativeThreadTransitionPhase(
  transition: NativeThreadTransition,
  event: NativeThreadTransitionPhaseEvent
): NativeThreadTransition {
  switch (event.type) {
    case "dispatch_started":
      return {
        ...transition,
        status: "dispatching",
        dispatching_at: event.at
      };
    case "submission_recorded":
      return {
        ...transition,
        status: "submitted",
        submitted_at: event.at
      };
    case "target_verified":
      return {
        ...transition,
        status: "verified",
        after_binding: event.afterBinding,
        verified_at: event.at
      };
    case "commit_recorded":
      return {
        ...transition,
        status: "committed",
        committed_at: event.at
      };
    case "aborted_before_input":
      return {
        ...transition,
        status: "aborted",
        aborted_at: event.at,
        error: event.error
      };
    case "outcome_uncertain":
      return {
        ...transition,
        status: "uncertain",
        uncertain_at: event.at,
        error: event.error,
        do_not_retry: true
      };
  }
}
