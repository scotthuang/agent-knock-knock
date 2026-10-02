import { hasCanonicalTerminalEndpoint, type TerminalControlRef } from
  "./terminal-control-ref.js";
import {
  terminalPermissionControlBindingToken,
  terminalPermissionControlProfileFor
} from "./terminal-permission-control.js";

export interface TerminalPermissionControlSafetyFacts {
  readonly exactTerminalRow: boolean;
  readonly terminalId: string;
  readonly processState: string;
  readonly agent: string;
  readonly pid: number;
  readonly terminalControl: TerminalControlRef;
  readonly processUuid?: string;
  readonly processBirth?: string;
  readonly agentVersion?: string;
  readonly approvalScanned: boolean;
  readonly approvalBlocked: boolean;
  readonly terminalHasInteraction: boolean;
  readonly terminalHasBlockingTurn: boolean;
  readonly hasOrphanedDispatch: boolean;
  readonly inputOwnerBlocked: boolean;
  readonly exactEmptyComposer: boolean;
  readonly screenState: string;
  readonly activityState: string;
}

export type TerminalPermissionControlAvailability =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly terminalId: string;
      readonly expectedBindingToken: string;
    };

/** Physical authority is separate from native task identity and model control. */
export function terminalPermissionControlAvailability(
  facts: TerminalPermissionControlSafetyFacts
): TerminalPermissionControlAvailability {
  const profile = facts.agentVersion
    ? terminalPermissionControlProfileFor(facts.agentVersion)
    : undefined;
  if (facts.agent !== "codex" || !profile) {
    return { available: false, reason: "unsupported_permission_profile" };
  }
  if (!permissionSubjectReady(facts)) {
    return { available: false, reason: "incomplete_physical_identity" };
  }
  if (!facts.terminalControl.capabilities.includes("send_keys") ||
      !facts.terminalControl.capabilities.includes("screen_status")) {
    return { available: false, reason: "terminal_transport_unavailable" };
  }
  if (!permissionSurfaceReady(facts)) {
    return { available: false, reason: "terminal_not_ready" };
  }
  return {
    available: true,
    terminalId: facts.terminalId,
    expectedBindingToken: terminalPermissionControlBindingToken({
      terminalId: facts.terminalId,
      terminalControl: facts.terminalControl,
      pid: facts.pid,
      workspace: facts.terminalControl.currentPath,
      processUuid: facts.processUuid,
      processBirth: facts.processBirth,
      agentVersion: profile.agentVersion,
      behaviorProfile: profile.behaviorProfile
    })
  };
}

function permissionSubjectReady(
  facts: TerminalPermissionControlSafetyFacts
): facts is TerminalPermissionControlSafetyFacts & {
  processUuid: string;
  processBirth: string;
  terminalControl: TerminalControlRef & { currentPath: string };
} {
  return facts.exactTerminalRow && facts.processState === "active" &&
    Boolean(facts.processUuid) && Boolean(facts.processBirth) &&
    Boolean(facts.terminalControl.currentPath) &&
    hasCanonicalTerminalEndpoint(facts.terminalControl) &&
    Number.isSafeInteger(facts.pid) && facts.pid > 0;
}

function permissionSurfaceReady(facts: TerminalPermissionControlSafetyFacts): boolean {
  return facts.approvalScanned && !facts.approvalBlocked &&
    !facts.terminalHasInteraction && !facts.terminalHasBlockingTurn &&
    !facts.hasOrphanedDispatch && !facts.inputOwnerBlocked &&
    facts.exactEmptyComposer && facts.screenState === "idle" &&
    facts.activityState === "idle";
}
