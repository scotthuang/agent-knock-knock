import {
  isExactNativeThreadId,
  type ManagedSessionStatus
} from "./managed-session.js";

export interface CodexLifecycleIdentityEvidence {
  sessionId: string;
  processUuid?: string;
  processBirth?: string;
  rollout?: {
    fd: string;
    device: string;
    inode: string;
    path: string;
  };
}

export function hasStrongCodexLifecycleIdentity(
  identity: CodexLifecycleIdentityEvidence
): boolean {
  return Boolean(
    isExactNativeThreadId(identity.sessionId) &&
    identity.processUuid &&
    identity.processBirth &&
    identity.rollout?.fd &&
    identity.rollout.device &&
    identity.rollout.inode &&
    identity.rollout.path
  );
}

export function codexIdentityVerifiesLifecyclePostcondition(input: {
  operation: "new_thread" | "resume_thread";
  parsedNativeThreadId: string;
  observationSucceeded: boolean;
  observedIdentity?: CodexLifecycleIdentityEvidence;
  beforeIdentity?: CodexLifecycleIdentityEvidence;
}): boolean {
  return classifyCodexLifecyclePostcondition(input) !== "invalid";
}

export type CodexLifecyclePostconditionEvidence =
  | "invalid"
  | "no_rollout"
  | "matching_after"
  | "lingering_before";

export function classifyCodexLifecyclePostcondition(input: {
  operation: "new_thread" | "resume_thread";
  parsedNativeThreadId: string;
  observationSucceeded: boolean;
  observedIdentity?: CodexLifecycleIdentityEvidence;
  beforeIdentity?: CodexLifecycleIdentityEvidence;
}): CodexLifecyclePostconditionEvidence {
  if (
    !input.observationSucceeded ||
    !isExactNativeThreadId(input.parsedNativeThreadId)
  ) {
    return "invalid";
  }
  if (input.observedIdentity === undefined) {
    // A clean no-rollout observation is valid only immediately after /clear;
    // exact resume must open and bind the requested historical rollout.
    return input.operation === "new_thread" ? "no_rollout" : "invalid";
  }
  if (
    input.observedIdentity.sessionId.toLowerCase() ===
      input.parsedNativeThreadId.toLowerCase() &&
    hasStrongCodexLifecycleIdentity(input.observedIdentity)
  ) {
    return "matching_after";
  }
  if (
    input.operation === "new_thread" &&
    input.beforeIdentity &&
    input.parsedNativeThreadId.toLowerCase() !==
      input.beforeIdentity.sessionId.toLowerCase() &&
    sameStrongCodexLifecycleIdentity(
      input.observedIdentity,
      input.beforeIdentity
    )
  ) {
    // Codex 0.146.x can keep the before-thread rollout FD open after /clear
    // even though a fresh /status card already proves a distinct current UUID.
    // The stale descriptor is useful process-incarnation evidence only; callers
    // must never attach its rollout tuple to the new UUID.
    return "lingering_before";
  }
  return "invalid";
}

function sameStrongCodexLifecycleIdentity(
  left: CodexLifecycleIdentityEvidence,
  right: CodexLifecycleIdentityEvidence
): boolean {
  return hasStrongCodexLifecycleIdentity(left) &&
    hasStrongCodexLifecycleIdentity(right) &&
    left.sessionId.toLowerCase() === right.sessionId.toLowerCase() &&
    left.processUuid === right.processUuid &&
    left.processBirth === right.processBirth &&
    left.rollout?.fd === right.rollout?.fd &&
    left.rollout?.device === right.rollout?.device &&
    left.rollout?.inode === right.rollout?.inode &&
    left.rollout?.path === right.rollout?.path;
}

export function isFreshCodexPostProbeScreen(input: {
  probeSent: boolean;
  screenDigest?: string;
  postProbeBaselineDigest?: string;
}): boolean {
  return Boolean(
    input.probeSent &&
    input.screenDigest &&
    input.postProbeBaselineDigest &&
    input.screenDigest !== input.postProbeBaselineDigest
  );
}

export interface ResumeCandidateAvailabilityInput {
  hasCandidateToken: boolean;
  current: boolean;
  activeElsewhere: boolean;
  activeOwnershipUnverifiable: boolean;
  managedSessionCount: number;
  managedSessionStatus?: ManagedSessionStatus;
  managedSessionBindingInactive?: boolean;
  managedSessionWorkspaceMatches?: boolean;
  archived: boolean;
}

export interface ResumeCandidateAvailability {
  resumable: boolean;
  unavailableReason?: string;
}

/**
 * Resume is permitted only for a free historical native thread. A first-class
 * Session is reusable after it was explicitly detached. A still-bound record
 * is also selectable when its recorded process is conclusively no longer
 * alive; the resume mutation must CAS-detach that stale binding before it
 * prepares terminal input. Every unverifiable/live status remains
 * authoritative and blocks implicit rebinding.
 */
export function evaluateResumeCandidateAvailability(
  input: ResumeCandidateAvailabilityInput
): ResumeCandidateAvailability {
  if (input.current) {
    return { resumable: false, unavailableReason: "already_active" };
  }
  if (input.activeElsewhere) {
    return {
      resumable: false,
      unavailableReason: "active_in_another_process"
    };
  }
  if (input.activeOwnershipUnverifiable) {
    return {
      resumable: false,
      unavailableReason: "active_thread_ownership_unverifiable"
    };
  }
  if (input.managedSessionCount > 1) {
    return {
      resumable: false,
      unavailableReason: "multiple_managed_sessions_reference_this_native_thread"
    };
  }
  if (
    input.managedSessionCount === 1 &&
    input.managedSessionStatus !== "detached" &&
    !(
      input.managedSessionStatus === "bound" &&
      input.managedSessionBindingInactive === true
    )
  ) {
    return {
      resumable: false,
      unavailableReason:
        `managed_session_${input.managedSessionStatus ?? "status_unavailable"}`
    };
  }
  if (
    input.managedSessionCount === 1 &&
    input.managedSessionWorkspaceMatches !== true
  ) {
    return {
      resumable: false,
      unavailableReason: "managed_session_workspace_mismatch"
    };
  }
  if (input.archived) {
    return { resumable: false, unavailableReason: "archived" };
  }
  if (!input.hasCandidateToken) {
    return {
      resumable: false,
      unavailableReason: "candidate_token_unavailable"
    };
  }
  return { resumable: true };
}
