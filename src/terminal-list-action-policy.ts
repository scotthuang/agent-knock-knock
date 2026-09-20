import type { ExecutorKind } from "./executors.js";
import { terminalUserExplicitTerminalInputOwnerBlocked } from
  "./terminal-composer-classifier.js";
import {
  decideTerminalUserExplicitSendEligibility,
  type TerminalUserExplicitSendEligibility
} from "./terminal-user-explicit-send-policy.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import type { TerminalListTerminalFacts } from "./terminal-list-facts.js";
import {
  decideModelControlActionPolicy,
  type ModelControlActionPolicyDecision,
  type ModelControlActionPolicyFacts
} from "./terminal-model-control-action-policy.js";
import { isExactNativeThreadId } from "./managed-session.js";

export interface TerminalListActionSubject {
  readonly exactTerminalRow: boolean;
  readonly processState: string;
  readonly terminalControl: TerminalControlRef;
  readonly agent: ExecutorKind;
  readonly pid: number;
}

export interface TerminalListCommandDecisions {
  readonly send: boolean;
  readonly approve: boolean;
  readonly status: true;
  readonly cancel: boolean;
  readonly close: boolean;
  readonly new_thread: boolean;
  readonly list_resumable_threads: boolean;
  readonly native_inspect: boolean;
  readonly identify_foreground: boolean;
  readonly identify_and_send: boolean;
  readonly watch: boolean;
}

export interface TerminalListActionDecisions {
  readonly commands: TerminalListCommandDecisions;
  readonly terminalUserExplicitSend: TerminalUserExplicitSendEligibility;
  readonly modelControl: ModelControlActionPolicyDecision;
}

/**
 * Convert one immutable observation into semantic action decisions. This layer
 * performs no Store reads, terminal capture, private-token generation, or JSON
 * presentation. Mutation execution still re-observes under its terminal lock.
 */
export function decideTerminalListActions(input: {
  readonly subject: TerminalListActionSubject;
  readonly facts: TerminalListTerminalFacts;
}): TerminalListActionDecisions {
  const { subject, facts } = input;
  const state = facts.status.projected;
  const control = subject.terminalControl;
  const codexLifecycleIncarnationAvailable = subject.agent !== "codex" ||
    Boolean(
      facts.native.nativeProcessUuid && facts.native.nativeProcessBirth
    );
  const foregroundIdentificationEligible =
    subject.agent === "codex" &&
    facts.runtime.nativeInspectionCapability.status === "supported" &&
    facts.runtime.nativeInspectionCapability.statusInspection === true &&
    state.screen_state === "idle" &&
    state.native_identity_state !== "resolved" &&
    state.approval_state.scanned === true &&
    state.approval_state.blocked !== true &&
    facts.composer.automatedInputComposerReady &&
    codexLifecycleIncarnationAvailable &&
    hasTerminalTransport(control) &&
    !facts.status.hasInteraction &&
    !facts.store.hasOrphanedDispatch &&
    !facts.store.terminalHasBlockingTurn;
  const commands = decideTerminalListCommands({
    subject,
    facts,
    codexLifecycleIncarnationAvailable,
    foregroundIdentificationEligible
  });
  const sendFacts = {
    exactTerminalRow: subject.exactTerminalRow,
    terminalId: facts.physical.terminalId,
    processState: subject.processState,
    terminalControl: control,
    agent: subject.agent,
    pid: subject.pid,
    processUuid: facts.physical.processIncarnation?.processUuid,
    processBirth: facts.physical.processIncarnation?.processBirth,
    approvalScanned: state.approval_state.scanned === true,
    approvalBlocked: state.approval_state.blocked === true,
    interactionActive: facts.status.hasInteraction,
    inputOwnerBlocked: facts.composer.inputOwnerBlocked ||
      terminalUserExplicitTerminalInputOwnerBlocked(control) ||
      (facts.modelControlResidual?.state === "recoverable" &&
        facts.modelControlResidual.kind === "model_surface"),
    userExplicitComposerReady: facts.composer.userExplicitComposerReady
  };
  return Object.freeze({
    commands,
    terminalUserExplicitSend:
      decideTerminalUserExplicitSendEligibility(sendFacts),
    modelControl: decideModelControlActionPolicy(
      modelControlPolicyFacts(input)
    )
  });
}

function decideTerminalListCommands(input: {
  readonly subject: TerminalListActionSubject;
  readonly facts: TerminalListTerminalFacts;
  readonly codexLifecycleIncarnationAvailable: boolean;
  readonly foregroundIdentificationEligible: boolean;
}): TerminalListCommandDecisions {
  const { subject, facts } = input;
  const control = subject.terminalControl;
  const lifecycle = facts.runtime.lifecycleCapability;
  const state = facts.status.projected;
  const inputOwnerBlocked = facts.status.hasInteraction ||
    facts.composer.inputOwnerBlocked ||
    terminalUserExplicitTerminalInputOwnerBlocked(control) ||
    (facts.modelControlResidual?.state === "recoverable" &&
      facts.modelControlResidual.kind === "model_surface");
  const idleAndNotBlocked = state.activity_state === "idle" &&
    state.approval_state.blocked !== true &&
    !inputOwnerBlocked;
  return Object.freeze({
    send: !facts.store.terminalHasBlockingTurn && idleAndNotBlocked,
    approve: control.capabilities.includes("terminal_approval") &&
      facts.status.projected.approval_state.approvable === true,
    status: true as const,
    cancel: control.capabilities.includes("terminal_cancel"),
    close: facts.store.hasOrphanedDispatch,
    new_thread: lifecycle.status === "supported" &&
      lifecycle.newThread === true &&
      input.codexLifecycleIncarnationAvailable &&
      !facts.store.terminalHasBlockingTurn &&
      idleAndNotBlocked &&
      facts.composer.automatedInputComposerReady,
    list_resumable_threads: lifecycle.status === "supported" &&
      lifecycle.resumeExact === true &&
      input.codexLifecycleIncarnationAvailable,
    native_inspect: decideNativeInspect({
      subject,
      facts,
      codexLifecycleIncarnationAvailable:
        input.codexLifecycleIncarnationAvailable
    }),
    identify_foreground: input.foregroundIdentificationEligible,
    identify_and_send: input.foregroundIdentificationEligible,
    watch: control.capabilities.includes("screen_status") ||
      Boolean(
        facts.native.authorityNativeAgentIdentity?.sessionId &&
        (
          subject.agent !== "codex" ||
          facts.native.authorityNativeAgentIdentity.rollout
        )
      )
  });
}

export function modelControlPolicyFacts(input: {
  readonly subject: TerminalListActionSubject;
  readonly facts: TerminalListTerminalFacts;
}): ModelControlActionPolicyFacts {
  const { subject, facts } = input;
  const profile = facts.runtime.modelControlProfile;
  const capability = facts.runtime.modelControlCapability;
  const behaviorProfile = profile &&
      capability.behaviorProfile === profile.behaviorProfile
    ? profile.behaviorProfile
    : undefined;
  const identity = subject.agent === "codex"
    ? facts.native.nativeAgentIdentity
    : facts.native.authorityNativeAgentIdentity;
  const hasExactNativeIdentity =
    isExactNativeThreadId(identity?.sessionId) &&
    (subject.agent === "codex" || Boolean(identity?.processUuid));
  const residual = facts.modelControlResidual?.state === "recoverable"
    ? facts.modelControlResidual
    : undefined;
  return {
    exactTerminalRow: subject.exactTerminalRow,
    terminalId: facts.physical.terminalId,
    processState: subject.processState,
    terminalControl: subject.terminalControl,
    agent: subject.agent,
    pid: subject.pid,
    processUuid: facts.physical.processIncarnation?.processUuid,
    processBirth: facts.physical.processIncarnation?.processBirth,
    agentVersion: facts.runtime.agentVersion,
    behaviorProfile,
    nativeAuthority: hasExactNativeIdentity
      ? { kind: "exact_session" }
      : facts.codex.zeroRolloutModelControlVerified
        ? { kind: "verified_zero_rollout" }
        : { kind: "unavailable" },
    modelControlSupported:
      capability.status === "supported" &&
      capability.modelSelection === true &&
      capability.reasoningEffortSelection === true,
    approvalScanned: facts.status.effective.approval_state.scanned === true,
    approvalBlocked: facts.status.effective.approval_state.blocked === true,
    terminalHasInteraction: facts.status.hasInteraction,
    terminalHasBlockingTurn: facts.store.terminalHasBlockingTurn,
    hasOrphanedDispatch: facts.store.hasOrphanedDispatch,
    surface: residual
      ? {
          kind: "residual",
          residualKind: residual.kind,
          residualFingerprint: residual.fingerprint,
          activityState: facts.status.effective.activity_state
        }
      : facts.status.effective.activity_state === "idle" &&
          facts.composer.automatedInputComposerReady
        ? {
            kind: "idle_empty",
            screenState: facts.status.effective.screen_state
          }
        : { kind: "unavailable" }
  };
}

function decideNativeInspect(input: {
  readonly subject: TerminalListActionSubject;
  readonly facts: TerminalListTerminalFacts;
  readonly codexLifecycleIncarnationAvailable: boolean;
}): boolean {
  const { subject, facts } = input;
  const capability = facts.runtime.nativeInspectionCapability;
  return capability.status === "supported" &&
    capability.statusInspection === true &&
    facts.status.projected.activity_state === "idle" &&
    facts.status.projected.approval_state.blocked !== true &&
    facts.composer.automatedInputComposerReady &&
    hasTerminalTransport(subject.terminalControl) &&
    (
      subject.agent === "codex"
        ? input.codexLifecycleIncarnationAvailable
        : Boolean(
            facts.native.authorityNativeAgentIdentity?.sessionId &&
            facts.native.authorityNativeAgentIdentity.processUuid
          )
    ) &&
    !facts.store.hasOrphanedDispatch &&
    !facts.store.terminalHasBlockingTurn;
}

function hasTerminalTransport(control: TerminalControlRef): boolean {
  return control.capabilities.includes("send_keys") &&
    control.capabilities.includes("screen_status");
}
