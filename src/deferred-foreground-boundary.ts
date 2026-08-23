import type {
  DeferredForegroundTransfer,
  DeferredForegroundTransferSourceKind,
  DeferredForegroundTransferSourceRolloutAuthority,
  DeferredForegroundTransferSourceTurnAuthority
} from "./deferred-foreground-transfer.js";
import type { ManagedSessionState } from "./managed-session.js";
import type { CodexCandidateSetRolloutAcceptanceAnchor } from
  "./terminal-submission-acceptance.js";

export interface DeferredForegroundDispatchSnapshot {
  status: "none" | "resolved";
  fingerprint: string;
}

/** Data-only projection of one canonical terminal authority. */
export interface DeferredForegroundTerminalFacts {
  conversationId: string;
  agent: string;
  pid: number;
  workspace?: string;
  target: string;
  resourceKey: string;
  endpoint?: DeferredForegroundTransfer["terminal_endpoint"];
  canonicalEndpoint: boolean;
}

/**
 * Service boundary for one deferred foreground application. It deliberately
 * excludes the resolved terminal, its adapter, and the concrete control.
 */
export interface DeferredForegroundBindingBoundary {
  terminal: DeferredForegroundTerminalFacts;
  transferId: string;
  targetSessionId: string;
  sourceSessionId: string;
  sourceBoundRevision: number;
  sourceBoundBindingToken: string;
  processUuid: string;
  processBirth: string;
  previousDispatchSnapshot: DeferredForegroundDispatchSnapshot;
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

/**
 * Narrow repository capability consumed by the deferred application services.
 * Concrete mutation scopes, Store paths, and terminal controls stay in the
 * infrastructure binder that implements this interface.
 */
export interface DeferredForegroundApplicationScope {
  loadTransfer(transferId: string): DeferredForegroundTransfer;
  listTransfers(): DeferredForegroundTransfer[];
  saveTransfer(
    transfer: DeferredForegroundTransfer,
    expectedRevision: number | null
  ): DeferredForegroundTransfer;
  loadSession(sessionId: string): ManagedSessionState;
  tryLoadSession(sessionId: string): ManagedSessionState | undefined;
  saveSession(
    session: ManagedSessionState,
    expectedRevision: number | null
  ): ManagedSessionState;
  assertBoundary(boundary: DeferredForegroundBindingBoundary): void;
  transferBelongsToTurn(transfer: DeferredForegroundTransfer): boolean;
  terminalMatches(
    transfer: DeferredForegroundTransfer,
    boundary: DeferredForegroundBindingBoundary
  ): boolean;
  withTurnStatePath(
    transfer: DeferredForegroundTransfer
  ): DeferredForegroundTransfer;
  sameInvocation(other: DeferredForegroundApplicationScope): boolean;
}
