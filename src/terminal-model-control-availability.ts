import type { ExecutorKind } from "./executors.js";
import {
  terminalUserExplicitModelControlBindingToken,
  terminalUserExplicitModelControlResidualEntryBindingToken,
  terminalUserExplicitModelControlRepairBindingToken,
  type TerminalModelControlResidualKind
} from "./terminal-model-control.js";
import {
  terminalModelControlProfileFor,
  type TerminalModelControlBehaviorProfile
} from "./terminal-model-control-profile.js";
import {
  decideModelControlActionPolicy,
  type ModelControlActionPolicyDecision
} from "./terminal-model-control-action-policy.js";
import { canonicalModelControlSubject } from
  "./terminal-model-control-subject.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";

export interface ModelControlSafetyFacts {
  readonly exactTerminalRow: boolean;
  readonly terminalId?: string;
  readonly processState?: string;
  readonly terminalControl?: TerminalControlRef;
  readonly agent?: ExecutorKind;
  readonly pid?: number;
  readonly processUuid?: string;
  readonly processBirth?: string;
  readonly agentVersion?: string;
  readonly behaviorProfile?: TerminalModelControlBehaviorProfile;
  readonly nativeAuthority:
    | {
        readonly kind: "exact_session";
        readonly ordinaryBindingToken: string;
      }
    | { readonly kind: "verified_zero_rollout" }
    | { readonly kind: "unavailable" };
  readonly modelControlSupported: boolean;
  readonly approvalScanned: boolean;
  readonly approvalBlocked: boolean;
  readonly terminalHasInteraction: boolean;
  readonly terminalHasBlockingTurn: boolean;
  readonly hasOrphanedDispatch: boolean;
  readonly surface:
    | {
        readonly kind: "idle_empty";
        readonly screenState?: string;
      }
    | {
        readonly kind: "residual";
        readonly residualKind: TerminalModelControlResidualKind;
        readonly residualFingerprint: string;
        readonly activityState?: string;
      }
    | { readonly kind: "unavailable" };
}

export type ModelControlAvailabilityDecision =
  | {
      readonly availability: "unavailable";
      readonly reason:
        | "invalid_subject"
        | "transport_unavailable"
        | "unsupported_profile"
        | "blocked"
        | "native_identity_unavailable"
        | "surface_unavailable";
    }
  | {
      readonly availability: "open_from_empty";
      readonly authority: "native_session" | "zero_rollout_physical";
      readonly terminalId: string;
      readonly expectedBindingToken: string;
    }
  | {
      readonly availability: "residual_continuation";
      readonly terminalId: string;
      readonly expectedBindingToken: string;
      readonly repairBindingToken: string;
    }
  | {
      readonly availability: "repair_only";
      readonly terminalId: string;
      readonly expectedBindingToken: string;
    };

/**
 * The single model-control availability policy shared by read-only projection
 * and mutation preparation. It grants no durable authority: execution must
 * independently sample these facts again while holding the terminal lock.
 */
export function decideModelControlAvailability(
  facts: ModelControlSafetyFacts
): ModelControlAvailabilityDecision {
  const policy = decideModelControlActionPolicy(policyFacts(facts));
  return materializeModelControlAvailability(facts, policy);
}

/** Bind one already-decided semantic action to its current private authority. */
export function materializeModelControlAvailability(
  facts: ModelControlSafetyFacts,
  policy: ModelControlActionPolicyDecision
): ModelControlAvailabilityDecision {
  if (policy.availability === "unavailable") return policy;
  const currentPolicy = decideModelControlActionPolicy(policyFacts(facts));
  if (!samePolicyDecision(currentPolicy, policy)) {
    return currentPolicy.availability === "unavailable"
      ? currentPolicy
      : { availability: "unavailable", reason: "surface_unavailable" };
  }
  const subject = canonicalModelControlSubject({
    terminalId: facts.terminalId,
    terminalControl: facts.terminalControl,
    agent: facts.agent,
    pid: facts.pid,
    workspace: facts.terminalControl?.currentPath,
    processUuid: facts.processUuid,
    processBirth: facts.processBirth,
    agentVersion: facts.agentVersion,
    behaviorProfile: facts.behaviorProfile
  });
  const profile = subject
    ? terminalModelControlProfileFor(subject.agent, subject.agentVersion)
    : undefined;
  if (!subject || !profile || subject.terminalId !== policy.terminalId) {
    return { availability: "unavailable", reason: "invalid_subject" };
  }
  if (policy.availability === "open_from_empty") {
    return materializeOpenFromEmpty(facts, policy, subject);
  }
  return materializeResidualAvailability(facts, policy, subject);
}

function materializeOpenFromEmpty(
  facts: ModelControlSafetyFacts,
  policy: Extract<
    ModelControlActionPolicyDecision,
    { availability: "open_from_empty" }
  >,
  subject: NonNullable<ReturnType<typeof canonicalModelControlSubject>>
): ModelControlAvailabilityDecision {
  const ordinaryBindingToken = facts.nativeAuthority.kind === "exact_session"
    ? nonBlank(facts.nativeAuthority.ordinaryBindingToken)
    : undefined;
  if (policy.authority === "native_session") {
    return ordinaryBindingToken
      ? {
          availability: "open_from_empty",
          authority: "native_session",
          terminalId: subject.terminalId,
          expectedBindingToken: ordinaryBindingToken
        }
      : {
          availability: "unavailable",
          reason: "native_identity_unavailable"
        };
  }
  return {
    availability: "open_from_empty",
    authority: "zero_rollout_physical",
    terminalId: subject.terminalId,
    expectedBindingToken: terminalUserExplicitModelControlBindingToken({
      terminalId: subject.terminalId,
      terminalControl: subject.terminalControl,
      pid: subject.pid,
      workspace: subject.workspace,
      processUuid: subject.processUuid,
      processBirth: subject.processBirth,
      agentVersion: subject.agentVersion,
      behaviorProfile: subject.behaviorProfile
    })
  };
}

function materializeResidualAvailability(
  facts: ModelControlSafetyFacts,
  policy: Extract<
    ModelControlActionPolicyDecision,
    { availability: "residual_continuation" | "repair_only" }
  >,
  subject: NonNullable<ReturnType<typeof canonicalModelControlSubject>>
): ModelControlAvailabilityDecision {
  if (facts.surface.kind !== "residual") {
    return {
      availability: "unavailable",
      reason: "surface_unavailable"
    };
  }
  const residualFingerprint = nonBlank(facts.surface.residualFingerprint);
  if (!residualFingerprint) {
    return { availability: "unavailable", reason: "surface_unavailable" };
  }
  const residualKind = facts.surface.residualKind;
  const repairBindingToken =
    terminalUserExplicitModelControlRepairBindingToken({
      terminalId: subject.terminalId,
      terminalControl: subject.terminalControl,
      pid: subject.pid,
      workspace: subject.workspace,
      processUuid: subject.processUuid,
      processBirth: subject.processBirth,
      agentVersion: subject.agentVersion,
      behaviorProfile: subject.behaviorProfile,
      residualKind,
      residualFingerprint
    });
  if (policy.availability === "residual_continuation") {
    return {
      availability: "residual_continuation",
      terminalId: subject.terminalId,
      expectedBindingToken:
        terminalUserExplicitModelControlResidualEntryBindingToken({
          terminalId: subject.terminalId,
          terminalControl: subject.terminalControl,
          pid: subject.pid,
          workspace: subject.workspace,
          processUuid: subject.processUuid,
          processBirth: subject.processBirth,
          agentVersion: subject.agentVersion,
          behaviorProfile: subject.behaviorProfile,
          residualKind,
          residualFingerprint
        }),
      repairBindingToken
    };
  }
  return {
    availability: "repair_only",
    terminalId: subject.terminalId,
    expectedBindingToken: repairBindingToken
  };
}

function policyFacts(facts: ModelControlSafetyFacts) {
  const ordinaryBindingToken = facts.nativeAuthority.kind === "exact_session"
    ? nonBlank(facts.nativeAuthority.ordinaryBindingToken)
    : undefined;
  return {
    ...facts,
    nativeAuthority: facts.nativeAuthority.kind === "exact_session" &&
        ordinaryBindingToken
      ? { kind: "exact_session" as const }
      : facts.nativeAuthority.kind === "verified_zero_rollout"
        ? { kind: "verified_zero_rollout" as const }
        : { kind: "unavailable" as const }
  };
}

function samePolicyDecision(
  left: ModelControlActionPolicyDecision,
  right: ModelControlActionPolicyDecision
): boolean {
  return left.availability === right.availability &&
    (left.availability === "unavailable"
      ? right.availability === "unavailable" && left.reason === right.reason
      : right.availability !== "unavailable" &&
        left.terminalId === right.terminalId &&
        (
          left.availability !== "open_from_empty" ||
          right.availability === "open_from_empty" &&
            left.authority === right.authority
        ));
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
