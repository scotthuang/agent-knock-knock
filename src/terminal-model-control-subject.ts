import type { ExecutorKind } from "./executors.js";
import {
  terminalModelControlProfileFor,
  type TerminalModelControlBehaviorProfile
} from "./terminal-model-control-profile.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalEndpointFromControlRef,
  terminalEndpointIdentityKey,
  type TerminalControlRef
} from "./terminal-control-ref.js";

export interface TerminalModelControlSubjectInput {
  readonly terminalId?: string;
  readonly terminalControl?: TerminalControlRef;
  readonly agent?: ExecutorKind;
  readonly pid?: number;
  readonly workspace?: string;
  readonly processUuid?: string;
  readonly processBirth?: string;
  readonly agentVersion?: string;
  readonly behaviorProfile?: string;
}

/** Canonical physical and profile identity shared by projection and mutation. */
export interface CanonicalTerminalModelControlSubject {
  readonly terminalId: string;
  readonly terminalControl: TerminalControlRef;
  readonly terminalEndpointIdentity: string;
  readonly terminalProcessAnchorPid: number;
  readonly agent: ExecutorKind;
  readonly pid: number;
  readonly workspace: string;
  readonly processUuid: string;
  readonly processBirth: string;
  readonly agentVersion: string;
  readonly behaviorProfile: TerminalModelControlBehaviorProfile;
}

/**
 * Normalize one model-control subject without granting an action. Invalid or
 * unsupported facts return undefined so read-only projection remains closed;
 * mutation callers may turn that result into an action-specific error.
 */
export function canonicalModelControlSubject(
  input: TerminalModelControlSubjectInput
): CanonicalTerminalModelControlSubject | undefined {
  const terminalId = nonBlank(input.terminalId);
  const terminalControl = input.terminalControl;
  const workspace = nonBlank(input.workspace);
  const processUuid = nonBlank(input.processUuid);
  const processBirth = nonBlank(input.processBirth);
  const agentVersion = nonBlank(input.agentVersion);
  const behaviorProfile = nonBlank(input.behaviorProfile);
  const pid = input.pid;
  if (
    !terminalId ||
    !terminalControl ||
    !input.agent ||
    !workspace ||
    !processUuid ||
    !processBirth ||
    !agentVersion ||
    !behaviorProfile ||
    !Number.isSafeInteger(pid) ||
    Number(pid) <= 1 ||
    !hasCanonicalTerminalEndpoint(terminalControl)
  ) {
    return undefined;
  }
  const profile = terminalModelControlProfileFor(input.agent, agentVersion);
  if (!profile || profile.behaviorProfile !== behaviorProfile) {
    return undefined;
  }
  const endpoint = terminalEndpointFromControlRef(terminalControl);
  if (
    !Number.isSafeInteger(endpoint.processAnchorPid) ||
    Number(endpoint.processAnchorPid) <= 1
  ) {
    return undefined;
  }
  return Object.freeze({
    terminalId,
    terminalControl,
    terminalEndpointIdentity: terminalEndpointIdentityKey(endpoint),
    terminalProcessAnchorPid: Number(endpoint.processAnchorPid),
    agent: input.agent,
    pid: Number(pid),
    workspace,
    processUuid,
    processBirth,
    agentVersion,
    behaviorProfile: profile.behaviorProfile
  });
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
