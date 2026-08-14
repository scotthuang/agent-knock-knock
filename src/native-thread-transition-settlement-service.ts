import type {
  TerminalNativeIdentityFence,
  TerminalThreadLifecycleOperation,
  TerminalThreadLifecyclePlan
} from "./terminal-agent-adapter.js";
import type { TerminalNativeIdentity } from "./terminal-binding-authority.js";
import {
  managedSessionRevision,
  nativeThreadTransitionRevision,
  type ManagedSessionState,
  type ManagedTerminalBinding,
  type NativeThreadTransition
} from "./managed-session.js";
import type {
  CanonicalMutationResources,
  CanonicalMutationScopes
} from "./mutation-transaction.js";
import {
  decideNativeThreadTransitionFailure,
  reduceNativeThreadTransitionPhase
} from "./native-thread-transition-policy.js";
import type {
  NativeThreadLifecycleLedgerPhase
} from "./terminal-dispatch-ledger-codec.js";

export type NativeThreadVerificationRequest = Readonly<{
  operation: TerminalThreadLifecycleOperation;
  plan: TerminalThreadLifecyclePlan;
  beforeIdentity?: TerminalNativeIdentity;
  physicalBeforeIdentity?: TerminalNativeIdentity;
  allowedCompanionIdentity?: TerminalNativeIdentityFence;
  allowedAdditionalIdentities?: readonly TerminalNativeIdentityFence[];
  initialScreenDigest?: string;
}>;
type ScopeArgs = [CanonicalMutationScopes, CanonicalMutationResources];
type Scoped<Args extends unknown[], Result> =
  (...args: [...ScopeArgs, ...Args]) => Result;

export type NativeThreadSettlementPresentation =
  | Readonly<{
      status: "committed";
      transition: NativeThreadTransition;
      identity: TerminalNativeIdentity;
      binding: ManagedTerminalBinding;
      committedTarget: ManagedSessionState;
    }>
  | Readonly<{
      status: "verified_recovery_required" | "uncertain";
      transitionId: string;
      reason: string;
    }>;

type SettlementPersistencePorts = Readonly<{
  saveLedger: Scoped<[
    transition: NativeThreadTransition,
    phase: NativeThreadLifecycleLedgerPhase,
    expectation: Readonly<{
      expectedTransitionId: string | null;
      expectedStatus?: "prepared" | "dispatching" | "submitted";
    }>
  ], void>;
  loadTransition: Scoped<[string], NativeThreadTransition>;
  saveTransition: Scoped<[
    NativeThreadTransition,
    Readonly<{ expectedRevision: number | null }>
  ], NativeThreadTransition>;
  saveSession: Scoped<[
    ManagedSessionState,
    Readonly<{ expectedRevision: number | null }>
  ], ManagedSessionState>;
  commitVerified: Scoped<[
    NativeThreadTransition,
    string
  ], ManagedSessionState>;
}>;

type SettlementEffectsPorts = Readonly<{
  finalizeIdentity: (
    observed: TerminalNativeIdentity,
    transition: NativeThreadTransition,
    verifiedAt: Date
  ) => Readonly<{
    identity: TerminalNativeIdentity;
    binding: ManagedTerminalBinding;
  }>;
  assertTargetOwnership: Scoped<[NativeThreadTransition], Promise<void>>;
  targetConflictWorkspace: () => string;
}>;

type SettlementRuntimePorts = Readonly<{
  now: () => Date;
  crashAfterVerified: () => void;
  injectTargetConflict: () => boolean;
  errorProvesInputNotStarted: (error: unknown) => boolean;
  summarizeError: (
    message: string
  ) => Readonly<{ length: number; preview?: string }>;
}>;

export type NativeThreadTransitionSettlementPorts = Readonly<{
  persistence: SettlementPersistencePorts;
  effects: SettlementEffectsPorts;
  runtime: SettlementRuntimePorts;
  verification: Scoped<[
    NativeThreadVerificationRequest
  ], Promise<TerminalNativeIdentity>>;
  present: (result: NativeThreadSettlementPresentation) => void;
}>;

export type NativeThreadSettlementRequest = Readonly<{
  transition: NativeThreadTransition;
  verification: NativeThreadVerificationRequest;
}>;

export async function settleVerifiedNativeThreadTransition(
  request: NativeThreadSettlementRequest,
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  ports: NativeThreadTransitionSettlementPorts
): Promise<void> {
  const observed = await ports.verification(
    scopes,
    resources,
    request.verification
  );
  const verifiedAt = ports.runtime.now();
  const finalized = ports.effects.finalizeIdentity(
    observed,
    request.transition,
    verifiedAt
  );
  let transition = reduceNativeThreadTransitionPhase(request.transition, {
    type: "target_verified",
    at: verifiedAt.toISOString(),
    afterBinding: finalized.binding
  });
  transition = ports.persistence.saveTransition(
    scopes,
    resources,
    transition,
    { expectedRevision: nativeThreadTransitionRevision(transition) }
  );
  ports.runtime.crashAfterVerified();
  await ports.effects.assertTargetOwnership(scopes, resources, transition);
  if (ports.runtime.injectTargetConflict()) {
    ports.persistence.saveSession(scopes, resources, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: transition.target_session_id,
      agent: transition.agent,
      workspace: ports.effects.targetConflictWorkspace(),
      status: "detached",
      binding: finalized.binding,
      lineage: { created_by: "attach" },
      created_at: verifiedAt.toISOString(),
      updated_at: verifiedAt.toISOString(),
      last_transition_id: "injected-target-conflict"
    }, { expectedRevision: null });
  }
  const committedTarget = ports.persistence.commitVerified(
    scopes,
    resources,
    transition,
    verifiedAt.toISOString()
  );
  const committedAt = ports.runtime.now().toISOString();
  transition = reduceNativeThreadTransitionPhase(transition, {
    type: "commit_recorded",
    at: committedAt
  });
  transition = ports.persistence.saveTransition(
    scopes,
    resources,
    transition,
    { expectedRevision: nativeThreadTransitionRevision(transition) }
  );
  ports.persistence.saveLedger(
    scopes,
    resources,
    transition,
    {
      phase: "command_resolved",
      at: committedAt,
      binding: finalized.binding,
      reason: "native thread transition committed"
    },
    {
      expectedTransitionId: transition.transition_id,
      expectedStatus: "submitted"
    }
  );
  ports.present({
    status: "committed",
    transition,
    identity: finalized.identity,
    binding: finalized.binding,
    committedTarget
  });
}

export type NativeThreadSettlementFailureRequest = Readonly<{
  transitionId: string;
  inputStarted: boolean;
  sourceBefore?: ManagedSessionState;
  sourceTransitioning?: ManagedSessionState;
}>;

export async function settleFailedNativeThreadTransition(
  request: NativeThreadSettlementFailureRequest,
  error: unknown,
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  ports: NativeThreadTransitionSettlementPorts
): Promise<void> {
  const failedAt = ports.runtime.now().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const durable = ports.persistence.loadTransition(
    scopes,
    resources,
    request.transitionId
  );
  const decision = decideNativeThreadTransitionFailure({
    durableStatus: durable.status,
    inputStarted: request.inputStarted,
    errorProvesInputNotStarted:
      ports.runtime.errorProvesInputNotStarted(error)
  });
  if (decision.action === "report_committed_bookkeeping_failure") {
    throw new Error(
      `native thread transition ${request.transitionId} committed, but final ` +
      `bookkeeping failed: ${message}`
    );
  }
  if (decision.action === "require_verified_recovery") {
    ports.persistence.saveLedger(
      scopes,
      resources,
      durable,
      {
        phase: "uncertain_reason_error",
        at: failedAt,
        reason:
          "verified lifecycle commit was interrupted; recovery must revalidate before roll-forward",
        error: ports.runtime.summarizeError(message)
      },
      { expectedTransitionId: request.transitionId }
    );
    ports.present({
      status: "verified_recovery_required",
      transitionId: request.transitionId,
      reason: message
    });
    return;
  }
  if (decision.action === "abort_before_terminal_input") {
    let aborted = reduceNativeThreadTransitionPhase(durable, {
      type: "aborted_before_input",
      at: failedAt,
      error: message
    });
    aborted = ports.persistence.saveTransition(
      scopes,
      resources,
      aborted,
      { expectedRevision: nativeThreadTransitionRevision(durable) }
    );
    if (request.sourceBefore && request.sourceTransitioning) {
      ports.persistence.saveSession(scopes, resources, {
        ...request.sourceTransitioning,
        status: request.sourceBefore.status,
        last_transition_id: request.sourceBefore.last_transition_id,
        updated_at: failedAt
      }, {
        expectedRevision: managedSessionRevision(
          request.sourceTransitioning
        )
      });
    }
    ports.persistence.saveLedger(
      scopes,
      resources,
      aborted,
      {
        phase: "resolved",
        at: failedAt,
        reason: "native thread transition aborted before terminal input"
      },
      { expectedTransitionId: request.transitionId }
    );
    throw error;
  }
  let uncertain = reduceNativeThreadTransitionPhase(durable, {
    type: "outcome_uncertain",
    at: failedAt,
    error: message
  });
  uncertain = ports.persistence.saveTransition(
    scopes,
    resources,
    uncertain,
    { expectedRevision: nativeThreadTransitionRevision(durable) }
  );
  if (request.sourceBefore && request.sourceTransitioning) {
    ports.persistence.saveSession(scopes, resources, {
      ...request.sourceTransitioning,
      status: "quarantined",
      quarantine_reason: "native thread transition outcome is uncertain",
      last_transition_id: request.transitionId,
      updated_at: failedAt
    }, {
      expectedRevision: managedSessionRevision(request.sourceTransitioning)
    });
  }
  ports.persistence.saveLedger(
    scopes,
    resources,
    uncertain,
    {
      phase: "uncertain_error_reason",
      at: failedAt,
      error: ports.runtime.summarizeError(message),
      reason: "native thread transition could not be verified"
    },
    { expectedTransitionId: request.transitionId }
  );
  ports.present({
    status: "uncertain",
    transitionId: request.transitionId,
    reason: message
  });
}
