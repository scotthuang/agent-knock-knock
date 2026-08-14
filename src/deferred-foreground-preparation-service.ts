import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import type {
  DeferredForegroundApplicationScope,
  DeferredForegroundBindingBoundary,
  DeferredForegroundDispatchSnapshot,
  DeferredForegroundTerminalFacts
} from "./deferred-foreground-boundary.js";
import {
  type DeferredForegroundTransfer,
  type DeferredForegroundTransferSourceKind,
  type DeferredForegroundTransferSourceRolloutAuthority,
  type DeferredForegroundTransferSourceTurnAuthority
} from "./deferred-foreground-transfer.js";
import {
  managedSessionBindingToken,
  managedSessionRevision,
  type ManagedSessionState
} from "./managed-session.js";
import { isCompleteNativeRollout } from "./terminal-authority-policy.js";
import type { CodexCandidateSetRolloutAcceptanceAnchor } from
  "./terminal-submission-acceptance.js";

export interface DeferredForegroundFreshAuthority {
  sourceKind: DeferredForegroundTransferSourceKind;
  sourceRolloutAuthority: DeferredForegroundTransferSourceRolloutAuthority;
  sourceTurnHistory?: DeferredForegroundTransferSourceTurnAuthority[];
  dispatchSnapshot?: DeferredForegroundDispatchSnapshot;
  sourceAbandonmentFingerprint?: string;
  exactSource: boolean;
}

export interface DeferredForegroundPreparationRequest {
  scope: DeferredForegroundApplicationScope;
  terminal: DeferredForegroundTerminalFacts;
  sourceSession?: ManagedSessionState;
  nativeIdentityVerifiedAbsent: boolean;
  candidateInventory?: CodexOpenRootRolloutInventory;
  requestText: string;
  expectedTerminalToken?: string;
  allowImplicitFreshAuthority: boolean;
}

export interface DeferredForegroundPreparationPorts {
  authority: {
    processIncarnation(pid: number): {
      processUuid: string;
      processBirth: string;
    };
    observeFresh(input: {
      sourceSession: ManagedSessionState;
      candidateInventory?: CodexOpenRootRolloutInventory;
      liveIncarnation: { processUuid: string; processBirth: string };
    }): DeferredForegroundFreshAuthority | undefined;
    revalidate(
      scope: DeferredForegroundApplicationScope,
      boundary: DeferredForegroundBindingBoundary
    ): Promise<void>;
    assertExclusive(
      scope: DeferredForegroundApplicationScope,
      boundary: DeferredForegroundBindingBoundary,
      nativeThreadId: string,
      excludedManagedSessionId?: string
    ): Promise<void>;
    candidateInventoryUnclaimed(input: {
      sourceSession: ManagedSessionState;
      inventory: CodexOpenRootRolloutInventory;
      includeDetached: boolean;
    }): boolean;
    abandonmentStillFresh(input: {
      sourceSession: ManagedSessionState;
      sourceTurnHistory?: DeferredForegroundTransferSourceTurnAuthority[];
      sourceAbandonmentFingerprint?: string;
      dispatchSnapshot: DeferredForegroundDispatchSnapshot;
    }): boolean;
    transferMatchesTerminal(
      transfer: DeferredForegroundTransfer,
    ): boolean;
  };
  identity: {
    targetSessionId(): string;
    transferId(): string;
    captureCandidateAnchor(
      inventory: CodexOpenRootRolloutInventory,
      now: Date
    ): CodexCandidateSetRolloutAcceptanceAnchor;
    bindingToken(input: {
      sourceSession: ManagedSessionState;
      authority: DeferredForegroundFreshAuthority;
      candidateInventory?: CodexOpenRootRolloutInventory;
    }): string;
    requestHash(requestText: string): string;
  };
  runtime: {
    now(): Date;
    pid(): number;
    log(
      level: "info" | "warn" | "error",
      event: string,
      fields: { [key: string]: unknown }
    ): void;
  };
}

export async function prepareDeferredForegroundBinding(
  request: DeferredForegroundPreparationRequest,
  ports: DeferredForegroundPreparationPorts
): Promise<DeferredForegroundBindingBoundary | undefined> {
  const source = request.sourceSession;
  const candidateMode = Boolean(request.candidateInventory?.roots.length);
  if (!eligible(request, source, candidateMode)) return undefined;
  assertImplicitAuthority(request, source!, candidateMode);
  const processUuid = source!.binding!.native_process.process_uuid;
  const processBirth = source!.binding!.native_process.process_birth;
  const workspace = request.terminal.workspace;
  const liveIncarnation = ports.authority.processIncarnation(
    request.terminal.pid
  );
  const authority = ports.authority.observeFresh({
    sourceSession: source!,
    candidateInventory: request.candidateInventory,
    liveIncarnation
  });
  if (
    !processUuid || !processBirth || !workspace ||
    !request.terminal.canonicalEndpoint || !request.terminal.endpoint ||
    !authority?.exactSource || !authority.dispatchSnapshot ||
    (authority.sourceRolloutAuthority ===
        "explicitly_abandoned_predecessor" &&
      !authority.sourceAbandonmentFingerprint)
  ) {
    return undefined;
  }
  const token = ports.identity.bindingToken({
    sourceSession: source!,
    authority,
    ...(candidateMode ? { candidateInventory: request.candidateInventory } : {})
  });
  if (
    !request.allowImplicitFreshAuthority &&
    request.expectedTerminalToken !== token
  ) {
    throw new Error(
      "deferred Codex foreground binding requires the fresh exact terminal " +
      "token advertised by AKK list"
    );
  }
  logImplicitAuthority(request, source!, ports);
  const boundary = buildBoundary(request, source!, authority, ports);
  await revalidateBeforePublication(request, boundary, source!, authority,
    ports);
  assertNoExistingTransfer(request, source!, ports);
  request.scope.saveTransfer({
    schema: "agent-knock-knock/deferred-foreground-transfer",
    version: 2,
    transfer_id: boundary.transferId,
    status: "prepared",
    input_stage: "none",
    terminal_id: request.terminal.conversationId,
    terminal_endpoint: request.terminal.endpoint,
    process_pid: request.terminal.pid,
    process_uuid: processUuid,
    process_birth: processBirth,
    workspace,
    source_session_id: source!.session_id,
    source_expected_revision: managedSessionRevision(source!),
    source_binding_token: managedSessionBindingToken(source!),
    source_previous_last_transition_id: source!.last_transition_id,
    source_before_binding: source!.binding!,
    source_kind: authority.sourceKind,
    ...(authority.sourceRolloutAuthority ===
        "explicitly_abandoned_predecessor"
      ? { source_rollout_authority: authority.sourceRolloutAuthority }
      : {}),
    ...(authority.sourceAbandonmentFingerprint
      ? { source_abandonment_fingerprint:
          authority.sourceAbandonmentFingerprint }
      : {}),
    ...(authority.sourceTurnHistory
      ? { source_turn_history: authority.sourceTurnHistory }
      : {}),
    target_session_id: boundary.targetSessionId,
    target_expected_revision: null,
    previous_dispatch_status: authority.dispatchSnapshot.status,
    previous_dispatch_fingerprint: authority.dispatchSnapshot.fingerprint,
    request_hash: ports.identity.requestHash(request.requestText),
    dispatcher_pid: ports.runtime.pid(),
    prepared_at: ports.runtime.now().toISOString()
  }, null);
  return boundary;
}

function eligible(
  request: DeferredForegroundPreparationRequest,
  source: ManagedSessionState | undefined,
  candidateMode: boolean
): boolean {
  return request.terminal.agent === "codex" && Boolean(source?.binding) &&
    (request.nativeIdentityVerifiedAbsent || candidateMode) &&
    Boolean(request.expectedTerminalToken || request.allowImplicitFreshAuthority);
}

function assertImplicitAuthority(
  request: DeferredForegroundPreparationRequest,
  source: ManagedSessionState,
  candidateMode: boolean
): void {
  if (
    request.allowImplicitFreshAuthority &&
    (
      request.expectedTerminalToken !== undefined || !candidateMode ||
      !isCompleteNativeRollout(source.binding?.native_process.rollout)
    )
  ) {
    throw new Error(
      "implicit Codex candidate authority requires one fresh complete " +
      "nonempty rollout inventory for a rollout-backed source"
    );
  }
}

function buildBoundary(
  request: DeferredForegroundPreparationRequest,
  source: ManagedSessionState,
  authority: DeferredForegroundFreshAuthority,
  ports: DeferredForegroundPreparationPorts
): DeferredForegroundBindingBoundary {
  const targetSessionId = ports.identity.targetSessionId();
  const transferId = ports.identity.transferId();
  const inventory = request.candidateInventory;
  const candidateAcceptanceAnchor = inventory?.roots.length
    ? ports.identity.captureCandidateAnchor(inventory, ports.runtime.now())
    : undefined;
  return {
    terminal: request.terminal,
    transferId,
    targetSessionId,
    sourceSessionId: source.session_id,
    sourceBoundRevision: managedSessionRevision(source),
    sourceBoundBindingToken: managedSessionBindingToken(source),
    processUuid: source.binding!.native_process.process_uuid as string,
    processBirth: source.binding!.native_process.process_birth as string,
    previousDispatchSnapshot: authority.dispatchSnapshot!,
    sourceKind: authority.sourceKind,
    sourceRolloutAuthority: authority.sourceRolloutAuthority,
    ...(authority.sourceAbandonmentFingerprint
      ? { sourceAbandonmentFingerprint:
          authority.sourceAbandonmentFingerprint }
      : {}),
    ...(source.last_transition_id
      ? { sourcePreviousLastTransitionId: source.last_transition_id }
      : {}),
    ...(authority.sourceTurnHistory
      ? { sourceTurnHistory: authority.sourceTurnHistory }
      : {}),
    ...(candidateAcceptanceAnchor ? { candidateAcceptanceAnchor } : {})
  };
}

async function revalidateBeforePublication(
  request: DeferredForegroundPreparationRequest,
  boundary: DeferredForegroundBindingBoundary,
  source: ManagedSessionState,
  authority: DeferredForegroundFreshAuthority,
  ports: DeferredForegroundPreparationPorts
): Promise<void> {
  await ports.authority.revalidate(request.scope, boundary);
  await ports.authority.assertExclusive(
    request.scope,
    boundary,
    source.binding!.native_thread_id as string,
    source.session_id
  );
  const inventory = request.candidateInventory;
  if (
    inventory && !ports.authority.candidateInventoryUnclaimed({
      sourceSession: source,
      inventory,
      includeDetached: authority.sourceRolloutAuthority ===
        "explicitly_abandoned_predecessor"
    })
  ) {
    throw new Error(
      "a Codex rollout candidate is already claimed by another Session"
    );
  }
  if (
    inventory && authority.sourceRolloutAuthority ===
      "explicitly_abandoned_predecessor"
  ) {
    for (const root of inventory.roots) {
      await ports.authority.assertExclusive(
        request.scope,
        boundary,
        root.sessionId,
        root.sessionId.toLowerCase() ===
            source.binding!.native_thread_id?.toLowerCase()
          ? source.session_id
          : undefined
      );
    }
  }
  if (
    authority.sourceRolloutAuthority ===
      "explicitly_abandoned_predecessor" &&
    !ports.authority.abandonmentStillFresh({
      sourceSession: source,
      sourceTurnHistory: authority.sourceTurnHistory,
      sourceAbandonmentFingerprint: authority.sourceAbandonmentFingerprint,
      dispatchSnapshot: authority.dispatchSnapshot!
    })
  ) {
    throw new Error(
      "the explicitly abandoned Codex predecessor authority changed; " +
      "refresh AKK list"
    );
  }
}

function assertNoExistingTransfer(
  request: DeferredForegroundPreparationRequest,
  source: ManagedSessionState,
  ports: DeferredForegroundPreparationPorts
): void {
  const existing = request.scope.listTransfers().find((candidate) =>
    !["resolved", "abort_resolved"].includes(candidate.status) &&
    (
      candidate.source_session_id === source.session_id ||
      ports.authority.transferMatchesTerminal(candidate)
    )
  );
  if (existing) {
    throw new Error(
      `deferred foreground transfer ${existing.transfer_id} is still ` +
      `${existing.status}; refresh AKK list before sending`
    );
  }
}

function logImplicitAuthority(
  request: DeferredForegroundPreparationRequest,
  source: ManagedSessionState,
  ports: DeferredForegroundPreparationPorts
): void {
  if (!request.allowImplicitFreshAuthority) return;
  ports.runtime.log("info", "deferred_codex_implicit_candidate_authority", {
    terminal_id: request.terminal.conversationId,
    terminal_target: request.terminal.target,
    source_session_id: source.session_id,
    inventory_status: request.candidateInventory?.status,
    inventory_fingerprint: request.candidateInventory?.inventoryFingerprint,
    candidate_count: request.candidateInventory?.roots.length,
    authority_scope: "terminal_follow_current",
    terminal_input_sent: false
  });
}
