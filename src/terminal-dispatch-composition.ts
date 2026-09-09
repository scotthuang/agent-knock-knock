import type {
  DeferredForegroundTransferSourceKind,
  DeferredForegroundTransferSourceRolloutAuthority,
  DeferredForegroundTransferSourceTurnAuthority
} from "./deferred-foreground-transfer.js";
import type { NativeThreadTransition } from "./managed-session.js";
import type {
  CanonicalStateMutationResources,
  CanonicalStateMutationScopes
} from "./mutation-transaction.js";
import type { AgentMessage, Conversation, Executor } from "./protocol.js";
import type { ExecutorKind } from "./executors.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { CodexPreMaterializationIdentity } from
  "./terminal-authority-policy.js";
import type { BoundTerminalDispatchRoute } from
  "./terminal-dispatch-capability.js";
import type { CodexCandidateSetRolloutAcceptanceAnchor } from
  "./terminal-submission-facts.js";

/**
 * Store authority frozen before a source-less candidate Send.  The native
 * rollout remains only a candidate until it accepts the exact request; this
 * snapshot authorizes retiring one unchanged detached historical owner if
 * that exact rollout wins.
 */
export interface CodexDetachedCandidateSessionClaim {
  session_id: string;
  session_revision: number;
  session_binding_token: string;
  binding_id: string;
  binding_generation: number;
  native_thread_id: string;
  process_uuid: string;
  process_birth: string;
  source_rollout: {
    fd: string;
    device: string;
    inode: string;
    path: string;
  };
  candidate_rollout: {
    fd: string;
    device: string;
    inode: string;
    path: string;
  };
}

export interface CodexDetachedCandidateSessionClaimSet {
  schema: "agent-knock-knock/codex-detached-candidate-session-claims";
  version: 1;
  anchor_fingerprint: string;
  claims: CodexDetachedCandidateSessionClaim[];
  claims_fingerprint: string;
}

export interface DeferredCodexForegroundDispatchSnapshot {
  status: "none" | "resolved";
  fingerprint: string;
}

export interface TerminalDispatchTerminal {
  conversationId: string;
  agent: ExecutorKind;
  pid: number;
  terminalControl: TerminalControlRef;
}

export interface VerifiedEmptyCodexHandoffBoundary {
  terminal: TerminalDispatchTerminal;
  detachedSourceSessionId: string;
  detachedSourceRevision: number;
  detachedSourceBindingToken: string;
  processUuid: string;
  processBirth: string;
}

export interface DeferredCodexForegroundBindingBoundary {
  terminal: TerminalDispatchTerminal;
  transferId: string;
  /** Immutable prepared timestamp shared by the transfer and its submission. */
  preparedAt: string;
  targetSessionId: string;
  sourceSessionId: string;
  sourceBoundRevision: number;
  sourceBoundBindingToken: string;
  processUuid: string;
  processBirth: string;
  previousDispatchSnapshot: DeferredCodexForegroundDispatchSnapshot;
  candidateAcceptanceAnchor?: CodexCandidateSetRolloutAcceptanceAnchor;
  sourceKind: DeferredForegroundTransferSourceKind;
  sourceRolloutAuthority: DeferredForegroundTransferSourceRolloutAuthority;
  sourceAbandonmentFingerprint?: string;
  sourceTurnHistory?: DeferredForegroundTransferSourceTurnAuthority[];
  sourcePreviousLastTransitionId?: string;
  sourceReservedRevision?: number;
  sourceReservedBindingToken?: string;
  targetPreparedRevision?: number;
  targetPreparedBindingToken?: string;
}

export interface TerminalControlSendOptions extends Record<string, unknown> {
  agentHardTimeoutMinutes?: number | string;
  agentTimeoutMinutes?: number | string;
  claudeHome?: string;
  scrollbackLines?: number | string;
  terminalAcceptancePollIntervalMs?: number | string;
  terminalAcceptanceTimeoutMs?: number | string;
}

export interface TerminalControlSendRequest {
  transaction: {
    scopes: CanonicalStateMutationScopes;
    resources: CanonicalStateMutationResources;
  };
  options: TerminalControlSendOptions;
  conversation: Conversation;
  nextConversation: Conversation;
  executor: Executor;
  message: AgentMessage;
  recordMessageAfterSend?: boolean;
  recordRawAttachmentAfterSend?: boolean;
  /**
   * Let a caller with independent physical-terminal authority handle a proven
   * zero-input abort instead of presenting the managed-path failure.
   */
  deferZeroInputFailurePresentation?: boolean;
  onTerminalPreflightVerified?:
    (route: BoundTerminalDispatchRoute) =>
      Promise<((route: BoundTerminalDispatchRoute) => void) | void> |
      ((route: BoundTerminalDispatchRoute) => void) | void;
  allowedPreMaterializationIdentity?: CodexPreMaterializationIdentity;
  allowedAdditionalIdentities?: CodexPreMaterializationIdentity[];
  observedHandoff?: {
    terminal: TerminalDispatchTerminal;
    transition: NativeThreadTransition;
  };
  verifiedEmptyCodexHandoff?: VerifiedEmptyCodexHandoffBoundary;
  /**
   * Physical-terminal human Send may have no authoritative predecessor
   * Session while Codex exposes an ambiguous open-root set. Freeze that set
   * before input and bind the provisional raw-attach Session only after one
   * rollout durably accepts the exact request.
   */
  postSendCodexCandidateAnchor?: CodexCandidateSetRolloutAcceptanceAnchor;
  postSendCodexDetachedSessionClaims?:
    CodexDetachedCandidateSessionClaimSet;
  deferredCodexForegroundBinding?: DeferredCodexForegroundBindingBoundary;
  continuingTurnResponse?: boolean;
}
