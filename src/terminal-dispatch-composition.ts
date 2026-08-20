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
  deferredCodexForegroundBinding?: DeferredCodexForegroundBindingBoundary;
  continuingTurnResponse?: boolean;
}
