import { createHash } from "node:crypto";
import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import type { ExecutorKind } from "./executors.js";
import {
  executorForConversation,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import type {
  ManagedSessionState,
  NativeThreadTransition
} from "./managed-session.js";
import type {
  TerminalControlRef,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import { parseTerminalConversationId } from "./terminal-agent-adapter.js";
import {
  decideTerminalBindingMatch,
  isCompleteNativeRollout,
  terminalNativeIdentityFence as codexIdentityFence,
  terminalNativeIdentityMatchesFence as nativeIdentityMatchesCodexPreMaterialization,
  terminalObservationFromResolvedIdentity,
  type TerminalNativeIdentity
} from "./terminal-binding-authority.js";
import {
  codexCompanionsExcludingPreferred,
  codexCompanionsPresentInOpenRootInventory,
  isCodexStatusCardEvidence,
  nativeAgentIdentityMatchesTurn,
  processIncarnationRelationship,
  withCodexCompanionFences,
  type CodexAllowedCompanionSet,
  type ProcessIncarnationRelationship
} from "./terminal-authority-policy.js";
import type { TerminalDispatchAcceptance } from
  "./terminal-dispatch-application.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import * as dispatch from "./terminal-dispatch-policy.js";
import {
  terminalAcceptanceEvidenceExpectation,
  terminalSubmissionReplayReceipt
} from
  "./terminal-dispatch-receipt.js";
import {
  validateCodexRolloutAcceptanceAnchor,
  type CaptureCodexRolloutAcceptanceAnchorOptions,
  type CodexCandidateSetRolloutAcceptanceRequest,
  type CodexCandidateSetRolloutAcceptanceResult,
  type CodexCandidateSetRolloutAcceptanceAnchor,
  type CodexRolloutAcceptanceAnchor,
  type CodexRolloutAcceptanceRequest,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-facts.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export {
  managedSessionRevision,
  nativeThreadTransitionRevision
} from "./managed-session.js";
export { nativeAgentIdentityMatchesTurn };
export {
  codexIdentityFence,
  isCompleteNativeRollout,
  nativeIdentityMatchesCodexPreMaterialization
};

export type CodexPreMaterializationIdentity = NonNullable<
  TerminalRuntimeIdentity["allowedPreMaterializationNativeIdentity"]
>;
export type NativeAgentSessionIdentityObservation =
  | { status: "resolved"; identity: TerminalNativeIdentity }
  | {
      status: "verified_absent";
      evidence: "native_identity_resolver_verified_absent";
    }
  | { status: "unavailable"; reason: string };

interface ClaudeIdentityRow {
  pid?: number;
  sessionId?: string;
  startedAt?: number;
}

export interface NativeIdentityResolutionRequest {
  agent: ExecutorKind;
  pid: number;
  cwd?: string;
  preferredSessionId?: string;
  allowedCompanionIdentity?: CodexPreMaterializationIdentity;
  allowedAdditionalIdentities?: readonly CodexPreMaterializationIdentity[];
}

type BoundCodexAcceptanceAnchor = Exclude<
  CodexRolloutAcceptanceAnchor,
  CodexCandidateSetRolloutAcceptanceAnchor
>;

export interface TerminalDispatchExecutionPorts {
  clock: {
    now(): Date;
    nowMs(): number;
    sleep(milliseconds: number): Promise<void>;
  };
  native: {
    resolveCodex(
      request: Omit<NativeIdentityResolutionRequest, "agent">
    ): Promise<TerminalNativeIdentity | undefined>;
    inspectCodexOpenRoots(
      pid: number,
      cwd?: string
    ): Promise<CodexOpenRootRolloutInventory>;
    claudeRows(): readonly ClaudeIdentityRow[];
    codexProcessIncarnation(pid: number): {
      processUuid: string;
      processBirth: string;
    };
  };
  acceptance: {
    captureCodex(
      request: CaptureCodexRolloutAcceptanceAnchorOptions
    ): CodexRolloutAcceptanceAnchor;
    detectCodexCandidates(
      request: CodexCandidateSetRolloutAcceptanceRequest
    ): CodexCandidateSetRolloutAcceptanceResult;
    detectBoundCodex(
      request: CodexRolloutAcceptanceRequest
    ): TerminalSubmissionAcceptanceEvidence | undefined;
    detectClaude(
      conversation: Conversation,
      terminalControl: TerminalControlRef
    ): TerminalSubmissionAcceptanceEvidence | undefined;
  };
  terminal: {
    proveExactDraftStillPresent(input: {
      executor: ExecutorKind;
      conversation: Conversation;
      terminalControl: TerminalControlRef;
      requestText: string;
      scrollbackLines: number;
    }): Promise<boolean>;
  };
  authority: {
    assertTurnCurrent(conversation: Conversation, operation: string): void;
  };
}

export interface TerminalAcceptanceDetectionRequest {
  executor: ExecutorKind;
  conversation: Conversation;
  terminalControl: TerminalControlRef;
}

export interface TerminalAcceptancePollRequest
  extends TerminalAcceptanceDetectionRequest {
  timeoutMs: number;
  pollIntervalMs: number;
  scrollbackLines: number;
}

export interface NativeIdentityPollRequest {
  executor: ExecutorKind;
  terminalControl: TerminalControlRef;
  pid: number;
  expectedSessionId?: string;
  allowedPreMaterializationIdentity?: CodexPreMaterializationIdentity;
  allowedAdditionalIdentities?: CodexPreMaterializationIdentity[];
  requiredCodexAcceptance?: {
    anchor: CodexRolloutAcceptanceAnchor;
    requestHash: string;
  };
  attempts?: number;
  delayMs?: number;
}

export type TerminalDispatchExecutionPreflight =
  | { action: "proceed" }
  | {
      action: "replay";
      owner: Conversation;
      receipt: ReturnType<typeof terminalSubmissionReplayReceipt>;
      accepted: boolean;
      acceptanceInvalid: boolean;
      receiptConversationId: string;
      receiptMessageId: string;
      callbackExpected: boolean;
    };

export interface TerminalDispatchTransportLifecycle {
  requireExactComposerBeforeEnter: boolean;
  beforeText?: () => Promise<void>;
  beforeEnter?: () => Promise<void>;
  onTransportStage(input: {
    stage: "text_injected" | "enter_dispatched";
  }): Promise<void>;
}

interface RuntimeIdentityAssertion {
  runtime?: TerminalRuntimeIdentity;
  currentIdentity: TerminalNativeIdentity | undefined;
  agent: ExecutorKind;
  pid: number;
}

export function resolvedTerminalProcessIncarnation(input: {
  terminal: { agent: ExecutorKind; pid: number };
  identity?: TerminalNativeIdentity;
  codexProcessIncarnation(pid: number): {
    processUuid: string;
    processBirth: string;
  };
}): { processUuid?: string; processBirth?: string } {
  if (
    input.terminal.agent !== "codex" ||
    (input.identity?.processUuid && input.identity.processBirth)
  ) {
    return {
      processUuid: input.identity?.processUuid,
      processBirth: input.identity?.processBirth
    };
  }
  try {
    const incarnation = input.codexProcessIncarnation(input.terminal.pid);
    return {
      processUuid: input.identity?.processUuid ?? incarnation.processUuid,
      processBirth: input.identity?.processBirth ?? incarnation.processBirth
    };
  } catch {
    return {
      processUuid: input.identity?.processUuid,
      processBirth: input.identity?.processBirth
    };
  }
}

export function managedSessionOwnerIsInactive(input: {
  session: ManagedSessionState;
  terminal: { agent: ExecutorKind; pid: number };
  identity?: TerminalNativeIdentity;
  isProcessAlive(pid: number): boolean;
  codexProcessIncarnation(pid: number): {
    processUuid: string;
    processBirth: string;
  };
}): boolean {
  const binding = input.session.binding;
  if (!binding) {
    return false;
  }
  if (binding.native_process.pid !== input.terminal.pid) {
    if (!input.isProcessAlive(binding.native_process.pid)) {
      return true;
    }
    if (input.session.agent !== "codex") {
      return false;
    }
    try {
      const owner = input.codexProcessIncarnation(binding.native_process.pid);
      return processIncarnationRelationship({
        binding,
        livePid: binding.native_process.pid,
        liveProcessUuid: owner.processUuid,
        liveProcessBirth: owner.processBirth
      }) === "different";
    } catch {
      return false;
    }
  }
  const live = resolvedTerminalProcessIncarnation({
    terminal: input.terminal,
    identity: input.identity,
    codexProcessIncarnation: input.codexProcessIncarnation
  });
  return processIncarnationRelationship({
    binding,
    livePid: input.terminal.pid,
    liveProcessUuid: live.processUuid,
    liveProcessBirth: live.processBirth
  }) === "different";
}

export function managedBindingMatchesLiveTerminal(input: {
  session: ManagedSessionState;
  terminal: { agent: ExecutorKind; pid: number };
  identity?: TerminalNativeIdentity;
  processIncarnation: { processUuid?: string; processBirth?: string };
  claimMatches: boolean;
  codexLingeringBeforeMatches(): boolean;
}): boolean {
  if (!input.claimMatches) {
    return false;
  }
  const observation = terminalObservationFromResolvedIdentity({
    agent: input.terminal.agent,
    pid: input.terminal.pid,
    identity: input.identity,
    processIncarnation: input.processIncarnation
  });
  const evidence = { terminalAliasMatches: true, workspaceMatches: true };
  let decision = decideTerminalBindingMatch(
    input.session,
    observation,
    evidence
  );
  if (
    decision.state === "not_exact" &&
    decision.reason === "native_identity_mismatch" &&
    input.session.agent === "codex" && input.identity
  ) {
    decision = decideTerminalBindingMatch(input.session, observation, {
      ...evidence,
      codexLingeringBeforeMatches: input.codexLingeringBeforeMatches()
    });
  }
  return decision.state === "exact";
}

export function codexKnownBeforeIdentityForTransition(input: {
  session: ManagedSessionState;
  transition?: NativeThreadTransition;
  requireNewThread?: boolean;
}): TerminalNativeIdentity | undefined {
  const { session, transition } = input;
  const binding = session.binding;
  const after = transition?.after_binding;
  if (
    session.agent !== "codex" || session.status !== "bound" ||
    !binding?.native_thread_id || !binding.native_process.process_uuid ||
    !binding.native_process.process_birth || !session.last_transition_id ||
    !transition || transition.status !== "committed" ||
    (input.requireNewThread && ![
      "new_thread",
      "adopt_external_thread"
    ].includes(transition.operation)) ||
    transition.target_session_id !== session.session_id || !after ||
    after.binding_id !== binding.binding_id ||
    after.generation !== binding.generation ||
    after.native_thread_id !== binding.native_thread_id ||
    !transition.before_native_thread_id ||
    transition.before_native_thread_id === binding.native_thread_id ||
    !transition.before_process_uuid || !transition.before_process_birth ||
    !isCompleteNativeRollout(transition.before_process_rollout) ||
    transition.before_process_uuid !== binding.native_process.process_uuid ||
    transition.before_process_birth !== binding.native_process.process_birth
  ) {
    return undefined;
  }
  return {
    sessionId: transition.before_native_thread_id,
    processUuid: transition.before_process_uuid,
    processBirth: transition.before_process_birth,
    rollout: transition.before_process_rollout,
    evidence: transition.operation === "new_thread"
      ? "committed_new_thread_before_identity"
      : "committed_resume_thread_before_identity"
  };
}

export function codexLingeringIdentityMatches(input: {
  session: ManagedSessionState;
  identity?: TerminalNativeIdentity;
  transition?: NativeThreadTransition;
  companions: CodexAllowedCompanionSet;
}): boolean {
  const { session, identity, transition } = input;
  const binding = session.binding;
  const after = transition?.after_binding;
  if (
    session.agent !== "codex" || session.status !== "bound" ||
    !binding?.native_thread_id || binding.native_process.rollout ||
    !isCodexStatusCardEvidence(binding.native_process.evidence) || !identity ||
    !codexKnownBeforeIdentityForTransition({
      session,
      transition,
      requireNewThread: true
    }) ||
    !transition || transition.status !== "committed" ||
    !["new_thread", "adopt_external_thread"].includes(transition.operation) ||
    transition.target_session_id !== session.session_id || !after ||
    after.binding_id !== binding.binding_id ||
    after.generation !== binding.generation ||
    after.native_thread_id !== binding.native_thread_id ||
    after.native_process.rollout
  ) {
    return false;
  }
  return [input.companions.primary, ...input.companions.additional]
    .some((candidate) =>
      nativeIdentityMatchesCodexPreMaterialization(identity, candidate)
    );
}

export function logicalManagedSessionIdentity(input: {
  session: ManagedSessionState;
  observedIdentity?: TerminalNativeIdentity;
  lingeringBeforeMatches: boolean;
}): TerminalNativeIdentity | undefined {
  const binding = input.session.binding;
  if (!binding?.native_thread_id) {
    return input.observedIdentity;
  }
  const statusCardOnly =
    input.session.agent === "codex" &&
    isCodexStatusCardEvidence(binding.native_process.evidence) &&
    Boolean(binding.native_process.process_uuid) &&
    Boolean(binding.native_process.process_birth) &&
    (input.observedIdentity === undefined || input.lingeringBeforeMatches);
  return statusCardOnly
    ? {
        sessionId: binding.native_thread_id,
        processUuid: binding.native_process.process_uuid,
        processBirth: binding.native_process.process_birth,
        rollout: binding.native_process.rollout,
        evidence: binding.native_process.evidence
      }
    : input.observedIdentity;
}

export function terminalRuntimeForLiveIdentity(input: {
  terminal: {
    agent: ExecutorKind;
    pid: number;
    terminalControl: TerminalControlRef;
  };
  identity?: TerminalNativeIdentity;
  expectedEmptyNativeSession?: boolean;
  physicalOnly?: boolean;
  codexProcessIncarnation(pid: number): {
    processUuid: string;
    processBirth: string;
  };
}): TerminalRuntimeIdentity {
  const { terminal, identity, physicalOnly = false } = input;
  const expectedEmpty = input.expectedEmptyNativeSession ?? false;
  const incarnation = !physicalOnly && expectedEmpty &&
      terminal.agent === "codex"
    ? input.codexProcessIncarnation(terminal.pid)
    : undefined;
  return {
    pid: terminal.pid,
    nativeSessionId: physicalOnly ? undefined : identity?.sessionId,
    nativeProcessUuid: physicalOnly
      ? undefined
      : identity?.processUuid ?? incarnation?.processUuid,
    nativeProcessBirth: physicalOnly
      ? undefined
      : identity?.processBirth ?? incarnation?.processBirth,
    nativeRollout: physicalOnly ? undefined : identity?.rollout,
    requireNativeProcessUuid:
      !physicalOnly && terminal.agent === "claude" && !expectedEmpty,
    requireNativeRolloutIdentity:
      !physicalOnly && terminal.agent === "codex" && !expectedEmpty,
    expectedEmptyNativeSession: physicalOnly ? false : expectedEmpty,
    cwd: terminal.terminalControl.currentPath,
    terminalTarget: terminal.terminalControl.target
  };
}

export function terminalRuntimeIdentityBase(
  conversation: Conversation,
  terminalControl: TerminalControlRef
): TerminalRuntimeIdentity {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const nativeSessionId = nonBlankString(takeover?.native_session_id);
  const terminalIdentity = parseTerminalConversationId(nativeSessionId);
  const explicitSessionId =
    nonBlankString(takeover?.terminal_agent_session_id) ??
    (terminalIdentity ? undefined : nativeSessionId);
  const rollout = isRecord(takeover?.terminal_agent_rollout)
    ? takeover.terminal_agent_rollout
    : undefined;
  const strict =
    Number(takeover?.terminal_agent_identity_protocol) === 1;
  const expectedSessionId = nonBlankString(
    takeover?.terminal_agent_expected_session_id
  );
  const agent = executorForConversation(conversation).kind;
  return {
    pid: Number.isInteger(Number(takeover?.terminal_agent_pid))
      ? Number(takeover?.terminal_agent_pid)
      : terminalIdentity?.pid,
    sessionId: explicitSessionId,
    nativeSessionId: nonBlankString(takeover?.terminal_agent_session_id),
    nativeProcessUuid: nonBlankString(takeover?.terminal_agent_process_uuid),
    nativeProcessBirth: nonBlankString(takeover?.terminal_agent_process_birth),
    requireNativeProcessUuid: strict && agent === "claude",
    requireNativeRolloutIdentity: strict && agent === "codex",
    ...(rollout
      ? {
          nativeRollout: {
            fd: String(rollout.fd ?? ""),
            device: String(rollout.device ?? ""),
            inode: String(rollout.inode ?? ""),
            path: String(rollout.path ?? "")
          }
        }
      : {}),
    expectedEmptyNativeSession:
      strict && !nonBlankString(takeover?.terminal_agent_session_id),
    expectedNativeSessionId:
      strict && !nonBlankString(takeover?.terminal_agent_session_id)
        ? expectedSessionId
        : undefined,
    cwd: nonBlankString(takeover?.source_cwd) ?? terminalControl.currentPath,
    conversationId: conversation.conversation_id,
    messageId: nonBlankString(takeover?.terminal_bridge_message_id),
    terminalTarget: terminalControl.target
  };
}

export function migratedTerminalBindingMatches(input: {
  session: ManagedSessionState;
  agent: ExecutorKind;
  terminalAliasMatches: boolean;
  terminalIncarnationMatches: boolean;
  workspaceMatches: boolean;
  terminalId?: string;
  pid: number;
  nativeThreadId?: string;
  processUuid?: string;
  processBirth?: string;
  rollout?: unknown;
}): boolean {
  const binding = input.session.binding;
  if (
    input.session.status !== "bound" || !binding ||
    !binding.native_thread_id || input.session.agent !== input.agent ||
    !input.workspaceMatches || !input.terminalId ||
    !input.terminalAliasMatches || !input.terminalIncarnationMatches ||
    !Number.isSafeInteger(input.pid) ||
    binding.native_process.pid !== input.pid ||
    !input.nativeThreadId ||
    binding.native_thread_id !== input.nativeThreadId
  ) {
    return false;
  }
  const bindingProcess = binding.native_process;
  const uuidMatches = optionalValueMatches(
    input.processUuid,
    bindingProcess.process_uuid
  );
  const birthMatches = optionalValueMatches(
    input.processBirth,
    bindingProcess.process_birth
  );
  const rolloutMatches = input.rollout === undefined &&
      bindingProcess.rollout === undefined ||
    Boolean(
      input.rollout && bindingProcess.rollout &&
      sameRollout(input.rollout, bindingProcess.rollout)
    );
  if (!uuidMatches || !birthMatches || !rolloutMatches) {
    return false;
  }
  return input.agent === "claude"
    ? Boolean(input.processUuid && bindingProcess.process_uuid)
    : Boolean(
        input.processBirth && bindingProcess.process_birth &&
        isCompleteNativeRollout(input.rollout) && bindingProcess.rollout
      );
}

export function selectBoundManagedSessionForTerminal(input: {
  sessions: readonly ManagedSessionState[];
  agent: ExecutorKind;
  pid: number;
  terminalTarget: string;
  aliasMatches(session: ManagedSessionState): boolean;
  exactMatches(session: ManagedSessionState): boolean;
  sameIncarnation(session: ManagedSessionState): boolean;
  ownerIsInactive(session: ManagedSessionState): boolean;
}): ManagedSessionState | undefined {
  const unresolved = input.sessions.filter((session) =>
    ["transitioning", "quarantined"].includes(session.status) &&
    session.binding && session.agent === input.agent &&
    input.aliasMatches(session)
  );
  if (unresolved[0]) {
    const session = unresolved[0];
    throw new Error(
      "terminal " + input.terminalTarget + " is still claimed by " +
      session.status + " managed Session " + session.session_id +
      (session.last_transition_id
        ? " (" + session.last_transition_id + ")"
        : "") +
      "; complete lifecycle recovery before attaching or sending"
    );
  }
  const exact = input.sessions.filter(input.exactMatches);
  if (exact.length > 1) {
    throw new Error(
      "terminal " + input.terminalTarget +
      " matches multiple managed Session bindings"
    );
  }
  const conflicting = input.sessions.some((session) =>
    session.status === "bound" && session.binding &&
    session.agent === input.agent && input.sameIncarnation(session) &&
    session.binding.native_process.pid === input.pid &&
    !input.ownerIsInactive(session) && !exact.includes(session)
  );
  if (conflicting) {
    throw new Error(
      "terminal " + input.terminalTarget +
      " changed native thread outside AKK; its managed binding must be " +
      "reconciled explicitly before control"
    );
  }
  return exact[0];
}

export function selectSoleBoundManagedSessionClaim(input: {
  sessions: readonly ManagedSessionState[];
  terminalTarget: string;
  claims(session: ManagedSessionState): boolean;
  ownerIsInactive(session: ManagedSessionState): boolean;
}): ManagedSessionState | undefined {
  const claims = input.sessions.filter((session) =>
    input.claims(session) && !input.ownerIsInactive(session)
  );
  if (claims.length > 1) {
    throw new Error(
      "terminal " + input.terminalTarget +
      " has multiple bound managed Session claims"
    );
  }
  return claims[0];
}

export function managedTurnMatchesTerminal(input: {
  conversation: Conversation;
  terminal: {
    conversationId: string;
    agent: ExecutorKind;
    pid: number;
  };
  currentIdentity?: TerminalNativeIdentity;
  storedControlExists: boolean;
  terminalIncarnationMatches: boolean;
  workspaceMatches: boolean;
}): boolean {
  const takeover = isRecord(input.conversation.native_session_takeover)
    ? input.conversation.native_session_takeover
    : undefined;
  const storedTerminal = parseTerminalConversationId(
    nonBlankString(takeover?.native_session_id)
  );
  const currentTerminal = parseTerminalConversationId(
    input.terminal.conversationId
  );
  return Boolean(
    input.storedControlExists && storedTerminal && currentTerminal &&
    executorForConversation(input.conversation).kind === input.terminal.agent &&
    storedTerminal.agent === currentTerminal.agent &&
    storedTerminal.pid === currentTerminal.pid &&
    Number(takeover?.terminal_agent_pid) === input.terminal.pid &&
    nativeAgentIdentityMatchesTurn(
      input.conversation,
      input.currentIdentity
    ) &&
    input.terminalIncarnationMatches && input.workspaceMatches
  );
}

export function assertManagedSessionCanStartTurnPolicy(
  turns: readonly Conversation[],
  isBlocking: (conversation: Conversation) => boolean
): void {
  const owner = turns.find(isBlocking);
  if (!owner) {
    return;
  }
  throw new Error(
    "session " + sessionIdForConversation(owner) +
    " already has active turn " + turnIdForConversation(owner) +
    " (" + owner.status + "); wait for its callback, respond to it if it is " +
    "waiting for OpenClaw, cancel it, or close it before sending another turn"
  );
}

export function terminalSubmissionPayload(payload: string): string {
  const firstLine = payload.split(/\r\n?|\n/u)
    .find((line) => line.trim().length > 0)?.trimStart();
  const reserved = /^\/([a-z][a-z0-9_-]*)(?=\s|$)/iu.exec(firstLine ?? "");
  if (reserved) {
    throw new Error(
      "ordinary send/respond cannot invoke native slash command /" +
      reserved[1].toLowerCase() +
      "; use an advertised dedicated native action when one exists, or enter " +
      "the unsupported native command manually in the terminal UI"
    );
  }
  return payload.trimEnd();
}

export class TerminalDispatchExecutionService {
  readonly #syntheticAcceptanceOutcome: string | undefined;
  readonly #ports: TerminalDispatchExecutionPorts;

  constructor(
    syntheticAcceptanceOutcome: string | undefined,
    ports: TerminalDispatchExecutionPorts
  ) {
    this.#syntheticAcceptanceOutcome = syntheticAcceptanceOutcome;
    this.#ports = ports;
  }

  preflightRequiresOwner(
    ledger: TerminalDispatchLedgerDocument | undefined,
    lifecycle: boolean
  ): boolean {
    return dispatch.terminalDispatchPreflightRequiresOwner({
      status: nonBlankString(ledger?.status),
      lifecycle
    });
  }

  evaluatePreflight(input: {
    ledger?: TerminalDispatchLedgerDocument;
    owner?: Conversation;
    conversation: Conversation;
    requestHash: string;
    requestText: string;
    messageId: string;
    terminalTarget: string;
    ledgerLifecycle: boolean;
    statePathMatches: boolean;
    continuingTurnResponse: boolean;
  }): TerminalDispatchExecutionPreflight {
    const ledger = input.ledger;
    const owner = input.owner;
    const ownerReleased = Boolean(owner && [
      "idle",
      "failed",
      "closed",
      "cancelled"
    ].includes(owner.status));
    const continuingSameTurn = Boolean(
      owner && input.continuingTurnResponse &&
      sessionIdForConversation(owner) ===
        sessionIdForConversation(input.conversation) &&
      turnIdForConversation(owner) ===
        turnIdForConversation(input.conversation) &&
      input.statePathMatches
    );
    const exactReplay = Boolean(
      owner && !ownerReleased && !continuingSameTurn &&
      nonBlankString(ledger?.request_hash) === input.requestHash &&
      nonBlankString(ledger?.conversation_id) ===
        input.conversation.conversation_id &&
      nonBlankString(ledger?.message_id) === input.messageId &&
      input.statePathMatches
    );
    const decision = dispatch.decideTerminalDispatchPreflight({
      ledger: {
        status: nonBlankString(ledger?.status),
        lifecycle: input.ledgerLifecycle,
        transitionId: nonBlankString(ledger?.transition_id),
        ownerConversationId: nonBlankString(ledger?.conversation_id)
      },
      owner: owner
        ? {
            conversationId: owner.conversation_id,
            status: owner.status,
            released: ownerReleased,
            continuingSameTurn,
            exactReplay
          }
        : undefined
    });
    if (decision.action === "reject") {
      throw terminalDispatchPreflightError(decision, input.terminalTarget);
    }
    if (decision.action !== "replay") {
      return { action: "proceed" };
    }
    const replayOwner = owner!;
    const receipt = terminalSubmissionReplayReceipt({
      proofLevel: decision.proofLevel,
      evidence: ledger!.acceptance_evidence,
      expected: terminalAcceptanceEvidenceExpectation(
        replayOwner,
        input.requestText
      )
    });
    const replay = dispatch.decideTerminalDispatchReplayAcceptance({
      delivered: receipt.delivered,
      submissionOutcome: receipt.submission_outcome
    });
    return {
      action: "replay",
      owner: replayOwner,
      receipt,
      accepted: replay.accepted,
      acceptanceInvalid: replay.invalid,
      receiptConversationId:
        nonBlankString(ledger?.conversation_id) ??
        replayOwner.conversation_id,
      receiptMessageId: nonBlankString(ledger?.message_id) ?? input.messageId,
      callbackExpected: !replay.invalid && Boolean(
        replayOwner.gateway_method ?? ledger?.callback_expected
      )
    };
  }

  transportLifecycle(input: {
    observedHandoff?: {
      verify(requireEmptyComposer: boolean): Promise<unknown>;
    };
    verifiedEmptyHandoff?: {
      verify(requireEmptyComposer: boolean): Promise<unknown>;
    };
    deferredBinding?: {
      verify(requireEmptyComposer: boolean): Promise<unknown>;
      begin(at: string): unknown;
      advance(
        stage: "text_injected" | "enter_dispatched",
        at: string
      ): unknown;
    };
    recordStage(
      stage: "text_injected" | "enter_dispatched",
      at: string,
      afterDurable: () => Promise<void>
    ): Promise<void>;
  }): TerminalDispatchTransportLifecycle {
    const selected = input.observedHandoff ??
      input.verifiedEmptyHandoff ??
      input.deferredBinding;
    const verify = (requireEmptyComposer: boolean) =>
      selected!.verify(requireEmptyComposer);
    return {
      requireExactComposerBeforeEnter: selected !== undefined,
      ...(selected
        ? {
            beforeText: async () => {
              await verify(true);
              if (input.deferredBinding === selected) {
                input.deferredBinding.begin(
                  this.#ports.clock.now().toISOString()
                );
              }
            },
            beforeEnter: async () => {
              await verify(false);
            }
          }
        : {}),
      onTransportStage: async ({ stage }) => {
        const at = this.#ports.clock.now().toISOString();
        await input.recordStage(stage, at, async () => {
          input.deferredBinding?.advance(stage, at);
          if (stage === "text_injected") {
            await input.observedHandoff?.verify(false);
            await input.verifiedEmptyHandoff?.verify(false);
            await input.deferredBinding?.verify(false);
          }
        });
      }
    };
  }

  captureCodexAcceptanceAnchor(input: {
    currentIdentity?: TerminalNativeIdentity;
    expectedNativeThreadId?: string;
    boundProcessUuid?: string;
    boundProcessBirth?: string;
    allowedPreMaterializationIdentity?: CodexPreMaterializationIdentity;
    needsPostSendNativeBinding: boolean;
    candidateSetAnchor?: CodexCandidateSetRolloutAcceptanceAnchor;
  }): CodexRolloutAcceptanceAnchor | undefined {
    if (this.#syntheticEnabled()) {
      return undefined;
    }
    if (input.candidateSetAnchor) {
      return input.candidateSetAnchor;
    }
    const threadId = input.needsPostSendNativeBinding
      ? input.expectedNativeThreadId
      : input.currentIdentity?.sessionId;
    const processUuid = input.currentIdentity?.processUuid ??
      input.allowedPreMaterializationIdentity?.processUuid ??
      input.boundProcessUuid;
    const processBirth = input.currentIdentity?.processBirth ??
      input.allowedPreMaterializationIdentity?.processBirth ??
      input.boundProcessBirth;
    if (!processUuid || !processBirth) {
      throw new Error(
        "Codex native acceptance anchor requires an exact process incarnation"
      );
    }
    if (!threadId && !input.needsPostSendNativeBinding) {
      throw new Error("Codex native acceptance anchor requires an exact thread");
    }
    const now = this.#ports.clock.now();
    if (!input.needsPostSendNativeBinding && input.currentIdentity?.rollout) {
      return this.#ports.acceptance.captureCodex({
        nativeThreadId: threadId as string,
        processUuid,
        processBirth,
        now,
        mode: "existing",
        rollout: input.currentIdentity.rollout
      });
    }
    const common = {
      processUuid,
      processBirth,
      now,
      mode: "pre_materialization" as const,
      expectedEmptyNativeSession: true as const
    };
    return this.#ports.acceptance.captureCodex(
      threadId ? { ...common, nativeThreadId: threadId } : common
    );
  }

  async resolveCurrentNativeIdentity(
    request: NativeIdentityResolutionRequest
  ): Promise<TerminalNativeIdentity | undefined> {
    if (request.agent === "codex") {
      const { agent: _agent, ...resolution } = request;
      return this.#ports.native.resolveCodex(resolution);
    }
    return resolveClaudeIdentity(request.pid, this.#ports.native.claudeRows());
  }

  async observeCurrentNativeIdentity(
    request: NativeIdentityResolutionRequest
  ): Promise<NativeAgentSessionIdentityObservation> {
    try {
      const identity = await this.resolveCurrentNativeIdentity(request);
      return identity
        ? { status: "resolved", identity }
        : {
            status: "verified_absent",
            evidence: "native_identity_resolver_verified_absent"
          };
    } catch (error) {
      return { status: "unavailable", reason: errorText(error) };
    }
  }

  inspectCodexOpenRootInventory(
    pid: number,
    cwd?: string
  ): Promise<CodexOpenRootRolloutInventory> {
    return this.#ports.native.inspectCodexOpenRoots(pid, cwd);
  }

  async detectAcceptance(
    request: TerminalAcceptanceDetectionRequest
  ): Promise<TerminalSubmissionAcceptanceEvidence | undefined> {
    const takeover = isRecord(request.conversation.native_session_takeover)
      ? request.conversation.native_session_takeover
      : undefined;
    const requestHash = nonBlankString(
      takeover?.terminal_bridge_request_hash
    );
    if (!requestHash) {
      throw new Error("terminal acceptance request hash is unavailable");
    }
    this.#ports.authority.assertTurnCurrent(request.conversation, "monitor");
    const synthetic = this.#syntheticEvidence(
      request.executor,
      request.conversation,
      requestHash
    );
    if (synthetic || this.#syntheticEnabled()) {
      return synthetic;
    }
    if (request.executor === "claude") {
      return this.#ports.acceptance.detectClaude(
        request.conversation,
        request.terminalControl
      );
    }
    const anchor = takeover?.codex_rollout_acceptance_anchor;
    if (!isRecord(anchor)) {
      throw new Error("Codex rollout acceptance anchor is unavailable");
    }
    const validated = validateCodexRolloutAcceptanceAnchor(anchor);
    const pid = Number(takeover?.terminal_agent_pid);
    if (validated.version === 3) {
      const result = this.#ports.acceptance.detectCodexCandidates({
        anchor: validated,
        currentInventory: await this.inspectCodexOpenRootInventory(
          pid,
          request.terminalControl.currentPath
        ),
        requestHash
      });
      if (result.status === "uncertain") {
        throw candidateAcceptanceError(result);
      }
      return result.status === "accepted" ? result.evidence : undefined;
    }
    const identity = await this.resolveCurrentNativeIdentity({
      agent: "codex",
      pid,
      cwd: request.terminalControl.currentPath,
      preferredSessionId: nonBlankString(validated.native_thread_id)
    });
    if (!identity) {
      return undefined;
    }
    return this.#ports.acceptance.detectBoundCodex({
      anchor: validated,
      currentIdentity: identity,
      requestHash
    });
  }

  async pollAcceptance(
    request: TerminalAcceptancePollRequest
  ): Promise<TerminalDispatchAcceptance> {
    const deadline = this.#ports.clock.nowMs() + request.timeoutMs;
    while (true) {
      try {
        const evidence = await this.detectAcceptance(request);
        if (evidence) {
          return { outcome: "agent_accepted", evidence };
        }
      } catch (error) {
        return { outcome: "uncertain", reason: errorText(error) };
      }
      if (this.#ports.clock.nowMs() >= deadline) {
        break;
      }
      await this.#ports.clock.sleep(request.pollIntervalMs);
    }
    if (this.#syntheticAcceptanceOutcome === "not_accepted") {
      return draftNotAccepted();
    }
    try {
      const takeover = isRecord(request.conversation.native_session_takeover)
        ? request.conversation.native_session_takeover
        : undefined;
      if (await this.#ports.terminal.proveExactDraftStillPresent({
        executor: request.executor,
        conversation: request.conversation,
        terminalControl: request.terminalControl,
        requestText: String(
          takeover?.terminal_bridge_request_text ?? ""
        ),
        scrollbackLines: request.scrollbackLines
      })) {
        return draftNotAccepted();
      }
    } catch {
      // Exact native acceptance remains authoritative when draft proof fails.
    }
    return { outcome: "pending_acceptance" };
  }

  assertRuntimeIdentity(input: RuntimeIdentityAssertion): void {
    if (input.runtime?.expectedEmptyNativeSession === true) {
      this.#assertExpectedEmptyRuntime(input);
      return;
    }
    this.#assertBoundRuntime(input);
  }

  assertTurnIdentity(input: {
    conversation: Conversation;
    currentIdentity: TerminalNativeIdentity | undefined;
    operation: string;
  }): void {
    const { conversation, currentIdentity, operation } = input;
    this.#ports.authority.assertTurnCurrent(conversation, operation);
    if (nativeAgentIdentityMatchesTurn(conversation, currentIdentity)) {
      return;
    }
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const strictClaude =
      Number(takeover?.terminal_agent_identity_protocol) === 1 &&
      executorForConversation(conversation).kind === "claude";
    if (
      strictClaude &&
      (!nonBlankString(takeover?.terminal_agent_process_uuid) ||
        !currentIdentity?.processUuid)
    ) {
      throw new Error(
        "cannot " + operation + " Turn " + turnIdForConversation(conversation) +
        ": native Claude process incarnation cannot be verified; this Claude " +
        "CLI must report both sessionId and startedAt before AKK can control it"
      );
    }
    const expected = nonBlankString(takeover?.terminal_agent_session_id) ??
      "unavailable";
    const observed = currentIdentity?.sessionId ?? "unverifiable";
    throw new Error(
      "cannot " + operation + " Turn " + turnIdForConversation(conversation) +
      ": native agent session identity changed or cannot be verified " +
      "(expected " + expected + ", observed " + observed + ")"
    );
  }

  withNativeIdentity(
    conversation: Conversation,
    identity: TerminalNativeIdentity
  ): Conversation {
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : {};
    return {
      ...conversation,
      native_thread_id: identity.sessionId,
      native_session_takeover: {
        ...takeover,
        terminal_agent_identity_protocol: 1,
        terminal_agent_session_id: identity.sessionId,
        terminal_agent_process_uuid: identity.processUuid,
        terminal_agent_process_birth: identity.processBirth,
        terminal_agent_rollout: identity.rollout,
        terminal_agent_identity_evidence: identity.evidence,
        terminal_agent_identity_bound_at: this.#ports.clock.now().toISOString()
      }
    };
  }

  async pollNativeIdentity(
    request: NativeIdentityPollRequest
  ): Promise<TerminalNativeIdentity | undefined> {
    const attempts = request.attempts ?? 40;
    const delayMs = request.delayMs ?? 50;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const identity = await this.#pollNativeIdentityAttempt(request);
      if (identity !== "pending") {
        return identity;
      }
      if (attempt + 1 < attempts) {
        await this.#ports.clock.sleep(delayMs);
      }
    }
    return undefined;
  }

  async #pollNativeIdentityAttempt(
    request: NativeIdentityPollRequest
  ): Promise<TerminalNativeIdentity | "pending"> {
    const required = request.requiredCodexAcceptance;
    if (required?.anchor.version === 3) {
      const result = this.#ports.acceptance.detectCodexCandidates({
        anchor: required.anchor,
        currentInventory: await this.inspectCodexOpenRootInventory(
          request.pid,
          request.terminalControl.currentPath
        ),
        requestHash: required.requestHash
      });
      if (result.status === "uncertain") {
        throw candidateAcceptanceError(result);
      }
      return result.status === "accepted" ? result.identity : "pending";
    }
    const identity = await this.resolveCurrentNativeIdentity({
      agent: request.executor,
      pid: request.pid,
      cwd: request.terminalControl.currentPath,
      preferredSessionId: request.allowedPreMaterializationIdentity
        ? request.expectedSessionId
        : undefined,
      allowedCompanionIdentity: request.allowedPreMaterializationIdentity,
      allowedAdditionalIdentities: request.allowedAdditionalIdentities
    });
    if (!identity) {
      return "pending";
    }
    if (
      request.expectedSessionId &&
      identity.sessionId !== request.expectedSessionId
    ) {
      if (nativeIdentityMatchesCodexPreMaterialization(
        identity,
        request.allowedPreMaterializationIdentity
      )) {
        return "pending";
      }
      throw new Error(
        "native agent materialized unexpected thread " + identity.sessionId +
        "; expected " + request.expectedSessionId
      );
    }
    if (!required) {
      return identity;
    }
    const acceptance = this.#ports.acceptance.detectBoundCodex({
      anchor: required.anchor as BoundCodexAcceptanceAnchor,
      currentIdentity: identity,
      requestHash: required.requestHash
    });
    return acceptance ? identity : "pending";
  }

  #syntheticEnabled(): boolean {
    return this.#syntheticAcceptanceOutcome !== undefined;
  }

  #syntheticEvidence(
    executor: ExecutorKind,
    conversation: Conversation,
    requestHash: string
  ): TerminalSubmissionAcceptanceEvidence | undefined {
    const outcome = this.#syntheticAcceptanceOutcome;
    if (
      outcome === undefined || outcome === "pending" ||
      outcome === "not_accepted"
    ) {
      return undefined;
    }
    if (outcome === "identity_drift" || outcome === "uncertain") {
      throw new Error("injected terminal acceptance identity drift");
    }
    if (outcome !== "accepted") {
      throw new Error("unsupported injected terminal acceptance outcome " + outcome);
    }
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const nativeThreadId =
      nonBlankString(takeover?.terminal_agent_session_id) ??
      nonBlankString(takeover?.terminal_agent_expected_session_id) ??
      sessionIdForConversation(conversation);
    const base = {
      source: executor === "codex"
        ? "codex_rollout" as const
        : "claude_transcript" as const,
      kind: "native_user_turn" as const,
      nativeThreadId,
      requestHash,
      acceptanceId: "test-" + turnIdForConversation(conversation),
      anchorFingerprint: sha256(
        "test-anchor:" + nativeThreadId + ":" + requestHash
      )
    };
    return { ...base, evidenceFingerprint: sha256(JSON.stringify(base)) };
  }

  #assertExpectedEmptyRuntime(input: RuntimeIdentityAssertion): void {
    const runtime = input.runtime!;
    if (
      input.agent === "codex" &&
      (runtime.expectedNativeSessionId || runtime.nativeProcessUuid ||
        runtime.nativeProcessBirth)
    ) {
      this.#assertCodexProcessIncarnation(runtime, input.pid, input.agent);
    }
    if (
      !input.currentIdentity ||
      runtimeMatchesIdentity(
        runtime,
        input.currentIdentity,
        runtime.expectedNativeSessionId
      )
    ) {
      return;
    }
    const exactCompanion = [
      runtime.allowedPreMaterializationNativeIdentity,
      ...(runtime.allowedAdditionalNativeIdentities ?? [])
    ].find((candidate) =>
      candidate?.sessionId !== runtime.expectedNativeSessionId &&
      candidate?.processUuid === runtime.nativeProcessUuid &&
      candidate?.processBirth === runtime.nativeProcessBirth &&
      nativeIdentityMatchesCodexPreMaterialization(
        input.currentIdentity,
        candidate
      )
    );
    if (
      input.agent === "codex" &&
      runtime.expectedNativeSessionId &&
      exactCompanion
    ) {
      return;
    }
    throw new Error(
      "native " + input.agent + " session appeared for process " + input.pid +
      " during terminal control"
    );
  }

  #assertCodexProcessIncarnation(
    runtime: TerminalRuntimeIdentity,
    pid: number,
    agent: ExecutorKind
  ): void {
    if (!runtime.nativeProcessUuid || !runtime.nativeProcessBirth) {
      throw nativeIdentityRefreshError(agent, pid, "cannot be verified");
    }
    let incarnation: { processUuid: string; processBirth: string };
    try {
      incarnation = this.#ports.native.codexProcessIncarnation(pid);
    } catch (error) {
      throw new Error(
        "native " + agent +
        " process incarnation cannot be verified for process " + pid + "; " +
        errorText(error)
      );
    }
    if (
      incarnation.processUuid !== runtime.nativeProcessUuid ||
      incarnation.processBirth !== runtime.nativeProcessBirth
    ) {
      throw nativeIdentityRefreshError(agent, pid, "changed");
    }
  }

  #assertBoundRuntime(input: RuntimeIdentityAssertion): void {
    const { runtime, currentIdentity, agent, pid } = input;
    if (
      runtime?.requireNativeRolloutIdentity === true &&
      (!runtime.nativeSessionId || !runtime.nativeProcessUuid ||
        !runtime.nativeProcessBirth ||
        !isCompleteNativeRollout(runtime.nativeRollout) ||
        !currentIdentity?.sessionId || !currentIdentity.processUuid ||
        !currentIdentity.processBirth ||
        !isCompleteNativeRollout(currentIdentity.rollout))
    ) {
      throw new Error(
        "native " + agent +
        " rollout incarnation cannot be verified for process " + pid +
        "; refresh list before controlling the terminal"
      );
    }
    if (
      runtime?.requireNativeProcessUuid === true &&
      (!runtime.nativeProcessUuid ||
        currentIdentity?.processUuid !== runtime.nativeProcessUuid)
    ) {
      throw nativeIdentityRefreshError(agent, pid, "cannot be verified");
    }
    if (
      runtime?.nativeProcessStartedAt !== undefined &&
      (!Number.isSafeInteger(runtime.nativeProcessStartedAt) ||
        Number(runtime.nativeProcessStartedAt) <= 0 ||
        currentIdentity?.processStartedAt !== runtime.nativeProcessStartedAt)
    ) {
      throw new Error(
        "native " + agent + " process start changed for process " + pid +
        "; refresh list before controlling the terminal"
      );
    }
    if (
      runtime?.nativeSessionId &&
      !runtimeMatchesIdentity(runtime, currentIdentity)
    ) {
      throw new Error(
        "native " + agent + " session identity changed for process " + pid +
        "; refresh list before controlling the terminal"
      );
    }
  }
}

function resolveClaudeIdentity(
  pid: number,
  rows: readonly ClaudeIdentityRow[]
): TerminalNativeIdentity | undefined {
  const matching = rows.filter((row) => row.pid === pid);
  if (matching.length === 0) {
    return undefined;
  }
  const sessionIds = unique(
    matching.map((row) => nonBlankString(row.sessionId))
  );
  if (sessionIds.length > 1) {
    throw new Error(
      "Claude process " + pid + " has conflicting exact session identities"
    );
  }
  if (!sessionIds[0]) {
    throw new Error(
      "Claude process " + pid +
      " is visible but its exact sessionId is unavailable"
    );
  }
  const startedAtValues = [...new Set(
    matching.map((row) => Number(row.startedAt))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  )];
  if (startedAtValues.length > 1) {
    throw new Error(
      "Claude process " + pid +
      " has conflicting process-incarnation timestamps"
    );
  }
  const startedAt = startedAtValues[0];
  if (!startedAt) {
    throw new Error(
      "Claude process " + pid +
      " is visible but its process-incarnation startedAt is unavailable"
    );
  }
  return {
    sessionId: sessionIds[0],
    processStartedAt: startedAt,
    processUuid: "claude-pid:" + pid + ":started:" + startedAt,
    evidence: "claude_agents_exact_pid"
  };
}

function runtimeMatchesIdentity(
  runtime: TerminalRuntimeIdentity,
  identity: TerminalNativeIdentity | undefined,
  expectedSession = runtime.nativeSessionId
): boolean {
  return Boolean(
    identity && expectedSession &&
    identity.sessionId === expectedSession &&
    (!runtime.nativeProcessUuid ||
      identity.processUuid === runtime.nativeProcessUuid) &&
    (!runtime.nativeProcessBirth ||
      identity.processBirth === runtime.nativeProcessBirth) &&
    (!runtime.nativeRollout ||
      sameRollout(identity.rollout, runtime.nativeRollout))
  );
}

function sameRollout(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right) &&
    nonBlankString(left.fd) === nonBlankString(right.fd) &&
    nonBlankString(left.device) === nonBlankString(right.device) &&
    nonBlankString(left.inode) === nonBlankString(right.inode) &&
    nonBlankString(left.path) === nonBlankString(right.path);
}

function optionalValueMatches(
  left: string | undefined,
  right: string | undefined
): boolean {
  return left === undefined && right === undefined ||
    Boolean(left && right && left === right);
}

function candidateAcceptanceError(result: {
  code: string;
  reason: string;
}): Error {
  return new Error(
    "Codex candidate-set acceptance is uncertain (" + result.code + "): " +
    result.reason
  );
}

function terminalDispatchPreflightError(
  decision: Extract<
    ReturnType<typeof dispatch.decideTerminalDispatchPreflight>,
    { action: "reject" }
  >,
  target: string
): Error {
  if (decision.reason === "unresolved_lifecycle") {
    return new Error(
      "terminal " + target + " has unresolved lifecycle transition " +
      (decision.transitionId ?? "with invalid identity") +
      "; refresh AKK list and use its exact recovery action"
    );
  }
  if (decision.reason === "terminal_level_dispatch") {
    return new Error(
      "terminal " + target + " has a terminal-level " +
      String(decision.status) + " dispatch owned by " +
      (decision.ownerConversationId ?? "an unknown conversation") +
      "; inspect the shared terminal pane and explicitly close that AKK " +
      "conversation before retrying"
    );
  }
  if (decision.reason === "owner_unavailable") {
    return new Error(
      "terminal " + target + " has a submitted dispatch whose owner state is " +
      "unavailable; inspect the shared terminal pane and repair or explicitly " +
      "resolve that conversation before sending another task"
    );
  }
  return new Error(
    "terminal " + target + " is still owned by active AKK conversation " +
    decision.ownerConversationId + " (" + decision.ownerStatus +
    "); wait for its callback, cancel it, or explicitly close it before " +
    "sending a different task"
  );
}

function draftNotAccepted(): TerminalDispatchAcceptance {
  return {
    outcome: "not_accepted",
    reason: "the exact managed draft remains in the terminal composer"
  };
}

function nativeIdentityRefreshError(
  agent: ExecutorKind,
  pid: number,
  state: "cannot be verified" | "changed"
): Error {
  return new Error(
    "native " + agent + " process incarnation " + state + " for process " +
    pid + "; refresh list before controlling the terminal"
  );
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(
    values.filter((value): value is string => value !== undefined)
  )];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
