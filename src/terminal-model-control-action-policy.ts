import type { ExecutorKind } from "./executors.js";
import {
  terminalModelControlProfileFor,
  type TerminalModelControlBehaviorProfile
} from "./terminal-model-control-profile.js";
import type { TerminalModelControlProfile } from
  "./terminal-model-control-profile.js";
import { canonicalModelControlSubject } from
  "./terminal-model-control-subject.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import type { TerminalModelControlResidualKind } from
  "./terminal-model-control.js";

export interface ModelControlActionPolicyFacts {
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
    | { readonly kind: "exact_session" }
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

export type ModelControlActionPolicyDecision =
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
    }
  | {
      readonly availability: "residual_continuation";
      readonly terminalId: string;
    }
  | {
      readonly availability: "repair_only";
      readonly terminalId: string;
    };

/**
 * Decide model-control semantics without minting private authority. Execution
 * and List projection both re-observe the same safety facts; a separate
 * materializer binds an allowed decision to the current physical subject.
 */
export function decideModelControlActionPolicy(
  facts: ModelControlActionPolicyFacts
): ModelControlActionPolicyDecision {
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
  const safetyReason = modelControlSafetyReason(facts, subject.terminalControl);
  if (safetyReason) return { availability: "unavailable", reason: safetyReason };
  const exactIdentity = facts.nativeAuthority.kind === "exact_session";
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
    return decideResidualModelControlAction(
      facts,
      facts.surface,
      subject.terminalId,
      profile
    );
  }
  if (
    facts.surface.kind !== "idle_empty" ||
    facts.surface.screenState !== "idle"
  ) {
    return { availability: "unavailable", reason: "surface_unavailable" };
  }
  return {
    availability: "open_from_empty",
    authority: exactIdentity ? "native_session" : "zero_rollout_physical",
    terminalId: subject.terminalId
  };
}

function modelControlSafetyReason(
  facts: ModelControlActionPolicyFacts,
  control: TerminalControlRef
): "transport_unavailable" | "unsupported_profile" | "blocked" | undefined {
  if (
    !control.capabilities.includes("send_keys") ||
    !control.capabilities.includes("screen_status")
  ) {
    return "transport_unavailable";
  }
  if (!facts.modelControlSupported) return "unsupported_profile";
  return !facts.approvalScanned ||
      facts.approvalBlocked ||
      facts.terminalHasInteraction ||
      facts.terminalHasBlockingTurn ||
      facts.hasOrphanedDispatch
    ? "blocked"
    : undefined;
}

function decideResidualModelControlAction(
  facts: ModelControlActionPolicyFacts,
  surface: Extract<
    ModelControlActionPolicyFacts["surface"],
    { kind: "residual" }
  >,
  terminalId: string,
  profile: TerminalModelControlProfile
): ModelControlActionPolicyDecision {
  const { residualKind } = surface;
  const fingerprint = nonBlank(surface.residualFingerprint);
  if (
    facts.agent !== "codex" ||
    !profile.supportsResidualRepair ||
    (
      residualKind !== "model_surface" &&
      (
        surface.activityState === "working" ||
        surface.activityState === "awaiting_approval"
      )
    ) ||
    !fingerprint ||
    (
      residualKind !== "profiled_command_popup" &&
      residualKind !== "bare_command" &&
      residualKind !== "model_surface"
    )
  ) {
    return { availability: "unavailable", reason: "surface_unavailable" };
  }
  return profile.supportsResidualContinuation &&
      (
        residualKind === "profiled_command_popup" ||
        residualKind === "bare_command"
      )
    ? { availability: "residual_continuation", terminalId }
    : { availability: "repair_only", terminalId };
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
