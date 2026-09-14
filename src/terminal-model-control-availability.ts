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
  if (
    !facts.exactTerminalRow ||
    facts.processState !== "active" ||
    !subject ||
    !profile
  ) {
    return { availability: "unavailable", reason: "invalid_subject" };
  }
  if (
    !subject.terminalControl.capabilities.includes("send_keys") ||
    !subject.terminalControl.capabilities.includes("screen_status")
  ) {
    return { availability: "unavailable", reason: "transport_unavailable" };
  }
  if (!facts.modelControlSupported) {
    return { availability: "unavailable", reason: "unsupported_profile" };
  }
  if (
    !facts.approvalScanned ||
    facts.approvalBlocked ||
    facts.terminalHasInteraction ||
    facts.terminalHasBlockingTurn ||
    facts.hasOrphanedDispatch
  ) {
    return { availability: "unavailable", reason: "blocked" };
  }

  const ordinaryBindingToken = facts.nativeAuthority.kind === "exact_session"
    ? nonBlank(facts.nativeAuthority.ordinaryBindingToken)
    : undefined;
  const exactIdentity = facts.nativeAuthority.kind === "exact_session" &&
    ordinaryBindingToken !== undefined;
  const zeroRollout = facts.nativeAuthority.kind ===
      "verified_zero_rollout" &&
    subject.agent === "codex" &&
    profile.supportsZeroRolloutPhysicalAuthority;
  if (!exactIdentity && !zeroRollout) {
    return {
      availability: "unavailable",
      reason: "native_identity_unavailable"
    };
  }

  if (facts.surface.kind === "residual") {
    const residualFingerprint = nonBlank(facts.surface.residualFingerprint);
    const residualKind = facts.surface.residualKind;
    if (
      subject.agent !== "codex" ||
      !profile.supportsResidualRepair ||
      (
        residualKind !== "model_surface" &&
        (
          facts.surface.activityState === "working" ||
          facts.surface.activityState === "awaiting_approval"
        )
      ) ||
      !residualFingerprint ||
      (residualKind !== "profiled_command_popup" &&
        residualKind !== "bare_command" &&
        residualKind !== "model_surface")
    ) {
      return { availability: "unavailable", reason: "surface_unavailable" };
    }
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
    if (
      profile.supportsResidualContinuation &&
      (residualKind === "profiled_command_popup" ||
        residualKind === "bare_command")
    ) {
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

  if (
    facts.surface.kind !== "idle_empty" ||
    facts.surface.screenState !== "idle"
  ) {
    return { availability: "unavailable", reason: "surface_unavailable" };
  }
  if (exactIdentity && ordinaryBindingToken) {
    return {
      availability: "open_from_empty",
      authority: "native_session",
      terminalId: subject.terminalId,
      expectedBindingToken: ordinaryBindingToken
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

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
