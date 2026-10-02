import {
  createHash
} from "node:crypto";
import {
  terminalPhysicalBindingToken
} from "./terminal-control-ref.js";
import type {
  TerminalModelControlPlan
} from "./terminal-model-control-profile.js";
import type {
  TerminalModelControlResidualKind
} from "./terminal-model-control-contract.js";
import type {
  ExecutorKind
} from "./executors.js";
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

/**
 * One action-specific physical authority token for fresh Codex model control.
 * The domain separator and exact profile keep this authority from being reused
 * as Send or native-lifecycle authority even though all bind the same pane.
 */
export function terminalUserExplicitModelControlBindingToken(value: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  workspace: string;
  processUuid: string;
  processBirth: string;
  agentVersion: string;
  behaviorProfile: TerminalModelControlPlan["behaviorProfile"];
}): string {
  const subject = requiredModelControlSubject({
    ...value,
    agent: "codex"
  });
  const physicalTerminalToken = terminalPhysicalBindingToken({
    terminalId: subject.terminalId,
    terminalControl: subject.terminalControl,
    agent: "codex",
    pid: subject.pid,
    workspace: subject.workspace,
    processUuid: subject.processUuid,
    processBirth: subject.processBirth
  });
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      authority: "terminal_user_explicit_model_control",
      physical_terminal_token: physicalTerminalToken,
      agent_version: subject.agentVersion,
      behavior_profile: subject.behaviorProfile
    }))
    .digest("hex");
}

function requiredModelControlSubject(
  input: TerminalModelControlSubjectInput
): NonNullable<ReturnType<typeof canonicalModelControlSubject>> {
  const subject = canonicalModelControlSubject(input);
  if (!subject) {
    throw new Error(
      "model-control authority requires one canonical supported terminal subject"
    );
  }
  return subject;
}

/**
 * Snapshot authority for adopting and cleaning one exact native `/model`
 * residual. The residual kind and normalized surface digest prevent a token
 * for one popup, pane generation, or bare Composer from authorizing another.
 */
export function terminalUserExplicitModelControlRepairBindingToken(value: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  workspace: string;
  processUuid: string;
  processBirth: string;
  agentVersion: string;
  behaviorProfile: TerminalModelControlPlan["behaviorProfile"];
  residualKind: TerminalModelControlResidualKind;
  residualFingerprint: string;
}): string {
  const modelControlToken = terminalUserExplicitModelControlBindingToken(value);
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      authority: "terminal_user_explicit_model_control_repair",
      model_control_token: modelControlToken,
      residual_kind: value.residualKind,
      residual_fingerprint: value.residualFingerprint
    }))
    .digest("hex");
}

/**
 * Snapshot authority for continuing one exact native `/model` residual into
 * the read-only catalog picker. This is deliberately domain-separated from
 * cleanup-only repair: a repair offer never authorizes Enter, while this
 * offer authorizes exactly one profiled slash-command dispatch.
 */
export function terminalUserExplicitModelControlResidualEntryBindingToken(value: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  workspace: string;
  processUuid: string;
  processBirth: string;
  agentVersion: string;
  behaviorProfile: TerminalModelControlPlan["behaviorProfile"];
  residualKind: TerminalModelControlResidualKind;
  residualFingerprint: string;
}): string {
  const modelControlToken = terminalUserExplicitModelControlBindingToken(value);
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      authority: "terminal_user_explicit_model_control_residual_entry",
      model_control_token: modelControlToken,
      residual_kind: value.residualKind,
      residual_fingerprint: value.residualFingerprint
    }))
    .digest("hex");
}
