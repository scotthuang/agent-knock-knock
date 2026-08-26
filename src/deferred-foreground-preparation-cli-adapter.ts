import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import type {
  DeferredForegroundApplicationScope,
  DeferredForegroundBindingBoundary,
  DeferredForegroundTerminalFacts
} from
  "./deferred-foreground-boundary.js";
import type { DeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import type { DeferredForegroundFreshAuthority } from
  "./deferred-foreground-preparation-service.js";
import {
  managedSessionBindingToken,
  managedSessionRevision,
  type ManagedSessionState
} from "./managed-session.js";
import { loadManagedSession } from "./session-store.js";
import {
  exactCodexCandidateInventoryForDeferredSend
} from "./terminal-authority-policy.js";
import type {
  DeferredCodexForegroundBindingBoundary,
  TerminalDispatchTerminal
} from "./terminal-dispatch-composition.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalControlEvidence,
  terminalControlEvidenceMatches,
  terminalRuntimeResourceKey
} from "./terminal-control-ref.js";

interface NativeIdentityObservation {
  status: "resolved" | "verified_absent" | "unavailable";
  identity?: { sessionId: string };
  reason?: string;
}

interface NormalizedTerminalStatus {
  reachable: boolean;
  approvalBlocked: boolean;
  activityState: string;
  activityReason: string;
}

const deferredForegroundProjectionByConcrete = new WeakMap<
  DeferredCodexForegroundBindingBoundary,
  DeferredForegroundBindingBoundary
>();

export function projectDeferredForegroundTerminalFacts(
  terminal: TerminalDispatchTerminal
): DeferredForegroundTerminalFacts {
  const canonicalEndpoint = hasCanonicalTerminalEndpoint(
    terminal.terminalControl
  );
  return Object.freeze({
    conversationId: terminal.conversationId,
    agent: terminal.agent,
    pid: terminal.pid,
    workspace: terminal.terminalControl.currentPath,
    target: terminal.terminalControl.target,
    resourceKey: terminalRuntimeResourceKey(terminal.terminalControl),
    canonicalEndpoint,
    ...(canonicalEndpoint
      ? { endpoint: terminalControlEvidence(terminal.terminalControl) }
      : {})
  });
}

export function deferredForegroundTransferMatchesTerminal(
  transfer: DeferredForegroundTransfer,
  terminal: TerminalDispatchTerminal
): boolean {
  return transfer.terminal_id === terminal.conversationId &&
    terminalControlEvidenceMatches(
      transfer.terminal_endpoint,
      terminal.terminalControl
    );
}

export function deferredForegroundBoundaryProjection(
  boundary: DeferredCodexForegroundBindingBoundary
): DeferredForegroundBindingBoundary {
  const existing = deferredForegroundProjectionByConcrete.get(boundary);
  if (existing) return existing;
  const projected: DeferredForegroundBindingBoundary = {
    terminal: projectDeferredForegroundTerminalFacts(boundary.terminal),
    transferId: boundary.transferId,
    preparedAt: boundary.preparedAt,
    targetSessionId: boundary.targetSessionId,
    sourceSessionId: boundary.sourceSessionId,
    sourceBoundRevision: boundary.sourceBoundRevision,
    sourceBoundBindingToken: boundary.sourceBoundBindingToken,
    processUuid: boundary.processUuid,
    processBirth: boundary.processBirth,
    previousDispatchSnapshot: boundary.previousDispatchSnapshot,
    candidateAcceptanceAnchor: boundary.candidateAcceptanceAnchor,
    sourceKind: boundary.sourceKind,
    sourceRolloutAuthority: boundary.sourceRolloutAuthority,
    sourceAbandonmentFingerprint: boundary.sourceAbandonmentFingerprint,
    sourceTurnHistory: boundary.sourceTurnHistory,
    sourcePreviousLastTransitionId: boundary.sourcePreviousLastTransitionId,
    sourceReservedRevision: boundary.sourceReservedRevision,
    sourceReservedBindingToken: boundary.sourceReservedBindingToken,
    targetPreparedRevision: boundary.targetPreparedRevision,
    targetPreparedBindingToken: boundary.targetPreparedBindingToken
  };
  deferredForegroundProjectionByConcrete.set(boundary, projected);
  return projected;
}

export function deferredForegroundConcreteBoundary(
  boundary: DeferredForegroundBindingBoundary,
  terminal: TerminalDispatchTerminal
): DeferredCodexForegroundBindingBoundary {
  const projected = projectDeferredForegroundTerminalFacts(terminal);
  if (
    projected.conversationId !== boundary.terminal.conversationId ||
    projected.agent !== boundary.terminal.agent ||
    projected.pid !== boundary.terminal.pid ||
    projected.workspace !== boundary.terminal.workspace ||
    projected.target !== boundary.terminal.target ||
    projected.resourceKey !== boundary.terminal.resourceKey ||
    JSON.stringify(projected.endpoint) !==
      JSON.stringify(boundary.terminal.endpoint)
  ) {
    throw new Error(
      "deferred foreground data boundary escaped its canonical terminal"
    );
  }
  const concrete: DeferredCodexForegroundBindingBoundary = {
    terminal,
    transferId: boundary.transferId,
    preparedAt: boundary.preparedAt,
    targetSessionId: boundary.targetSessionId,
    sourceSessionId: boundary.sourceSessionId,
    sourceBoundRevision: boundary.sourceBoundRevision,
    sourceBoundBindingToken: boundary.sourceBoundBindingToken,
    processUuid: boundary.processUuid,
    processBirth: boundary.processBirth,
    previousDispatchSnapshot: boundary.previousDispatchSnapshot,
    candidateAcceptanceAnchor: boundary.candidateAcceptanceAnchor,
    sourceKind: boundary.sourceKind,
    sourceRolloutAuthority: boundary.sourceRolloutAuthority,
    sourceAbandonmentFingerprint: boundary.sourceAbandonmentFingerprint,
    sourceTurnHistory: boundary.sourceTurnHistory,
    sourcePreviousLastTransitionId: boundary.sourcePreviousLastTransitionId,
    sourceReservedRevision: boundary.sourceReservedRevision,
    sourceReservedBindingToken: boundary.sourceReservedBindingToken,
    targetPreparedRevision: boundary.targetPreparedRevision,
    targetPreparedBindingToken: boundary.targetPreparedBindingToken
  };
  deferredForegroundProjectionByConcrete.set(concrete, boundary);
  return concrete;
}

export interface DeferredForegroundBoundaryAdapterPorts {
  processIncarnation(pid: number): {
    processUuid: string;
    processBirth: string;
  };
  inventory(boundary: DeferredCodexForegroundBindingBoundary):
    Promise<CodexOpenRootRolloutInventory>;
  nativeIdentity(boundary: DeferredCodexForegroundBindingBoundary):
    Promise<NativeIdentityObservation>;
  authority(input: {
    boundary: DeferredCodexForegroundBindingBoundary;
    sourceAsBound: ManagedSessionState;
    candidateInventory?: CodexOpenRootRolloutInventory;
    expectedSourceStatus: "bound" | "transitioning";
  }): DeferredForegroundFreshAuthority | undefined;
  assertNoDispatch(
    scope: DeferredForegroundApplicationScope,
    boundary: DeferredCodexForegroundBindingBoundary
  ): void;
  dispatchSnapshot(
    boundary: DeferredCodexForegroundBindingBoundary
  ): DeferredCodexForegroundBindingBoundary["previousDispatchSnapshot"];
  status(
    boundary: DeferredCodexForegroundBindingBoundary
  ): Promise<NormalizedTerminalStatus>;
  assertComposerReady(
    boundary: DeferredCodexForegroundBindingBoundary
  ): Promise<void>;
  valuesMatch(left: unknown, right: unknown): boolean;
}

export async function assertDeferredForegroundBoundary(input: {
  scope: DeferredForegroundApplicationScope;
  storeDir: string;
  boundary: DeferredCodexForegroundBindingBoundary;
  applicationBoundary: DeferredForegroundBindingBoundary;
  expectedSourceStatus: "bound" | "transitioning";
  requireNoDispatch: boolean;
  requireEmptyComposer: boolean;
  ports: DeferredForegroundBoundaryAdapterPorts;
}): Promise<ManagedSessionState> {
  input.scope.assertBoundary(input.applicationBoundary);
  const source = loadManagedSession(
    input.storeDir,
    input.boundary.sourceSessionId
  );
  assertExpectedSource(source, input);
  const live = input.ports.processIncarnation(input.boundary.terminal.pid);
  if (
    live.processUuid !== input.boundary.processUuid ||
    live.processBirth !== input.boundary.processBirth
  ) {
    throw new Error(
      "the deferred Codex foreground process incarnation changed"
    );
  }
  const inventory = await observeNativeAuthority(source, input);
  const sourceAsBound: ManagedSessionState = {
    ...source,
    status: "bound",
    last_transition_id: input.boundary.sourcePreviousLastTransitionId
  };
  const authority = input.ports.authority({
    boundary: input.boundary,
    sourceAsBound,
    candidateInventory: inventory,
    expectedSourceStatus: input.expectedSourceStatus
  });
  assertSourceAuthority(authority, input);
  if (input.requireNoDispatch) {
    input.ports.assertNoDispatch(input.scope, input.boundary);
    const current = input.ports.dispatchSnapshot(input.boundary);
    if (
      current.status !== input.boundary.previousDispatchSnapshot.status ||
      current.fingerprint !==
        input.boundary.previousDispatchSnapshot.fingerprint
    ) {
      throw new Error(
        "the deferred Codex foreground dispatch history changed; refresh AKK list"
      );
    }
  }
  const status = await input.ports.status(input.boundary);
  if (
    !status.reachable || status.approvalBlocked ||
    !["idle", "unknown"].includes(status.activityState)
  ) {
    throw new Error(
      `terminal ${input.boundary.terminal.terminalControl.target} is not at ` +
      `a verified empty Codex prompt (${status.activityState}: ` +
      `${status.activityReason})`
    );
  }
  if (input.requireEmptyComposer) {
    await input.ports.assertComposerReady(input.boundary);
  }
  return source;
}

function assertExpectedSource(
  source: ManagedSessionState,
  input: Parameters<typeof assertDeferredForegroundBoundary>[0]
): void {
  const boundary = input.applicationBoundary;
  const expectedRevision = input.expectedSourceStatus === "bound"
    ? boundary.sourceBoundRevision
    : boundary.sourceReservedRevision;
  const expectedToken = input.expectedSourceStatus === "bound"
    ? boundary.sourceBoundBindingToken
    : boundary.sourceReservedBindingToken;
  if (
    source.status !== input.expectedSourceStatus ||
    expectedRevision === undefined ||
    managedSessionRevision(source) !== expectedRevision ||
    expectedToken === undefined ||
    managedSessionBindingToken(source) !== expectedToken
  ) {
    throw new Error(
      "the deferred Codex foreground source changed; refresh AKK list"
    );
  }
  const expectedTransition = input.expectedSourceStatus === "bound"
    ? boundary.sourcePreviousLastTransitionId
    : boundary.transferId;
  if (source.last_transition_id !== expectedTransition) {
    throw new Error(
      "the deferred Codex foreground source transition authority changed"
    );
  }
}

async function observeNativeAuthority(
  source: ManagedSessionState,
  input: Parameters<typeof assertDeferredForegroundBoundary>[0]
): Promise<CodexOpenRootRolloutInventory | undefined> {
  const boundary = input.boundary;
  if (boundary.candidateAcceptanceAnchor) {
    const inventory = await input.ports.inventory(boundary);
    if (
      inventory.inventoryFingerprint !==
        boundary.candidateAcceptanceAnchor.inventory_fingerprint ||
      !exactCodexCandidateInventoryForDeferredSend({
        inventory,
        sourceSession: source,
        pid: boundary.terminal.pid,
        workspace: required(
          boundary.terminal.terminalControl.currentPath,
          "deferred Codex terminal workspace is unavailable"
        ),
        processUuid: boundary.processUuid,
        processBirth: boundary.processBirth,
        sourceRolloutAuthority: boundary.sourceRolloutAuthority
      })
    ) {
      throw new Error(
        "the exact Codex open-root inventory changed; refresh AKK list before sending"
      );
    }
    return inventory;
  }
  const observation = await input.ports.nativeIdentity(boundary);
  if (observation.status === "unavailable") {
    throw new Error(
      `Codex native identity observation is unavailable: ${observation.reason}`
    );
  }
  if (observation.status !== "verified_absent") {
    throw new Error(
      `Codex materialized native thread ${observation.identity?.sessionId}; ` +
      "refresh AKK list before sending"
    );
  }
  return undefined;
}

function assertSourceAuthority(
  authority: DeferredForegroundFreshAuthority | undefined,
  input: Parameters<typeof assertDeferredForegroundBoundary>[0]
): void {
  const boundary = input.boundary;
  if (boundary.sourceKind === "status_card_only") {
    if (!authority?.exactSource) {
      throw new Error(
        "the deferred Codex foreground source is no longer an isolated " +
        "status-card binding"
      );
    }
    return;
  }
  if (
    !boundary.candidateAcceptanceAnchor || !authority?.sourceTurnHistory ||
    !input.ports.valuesMatch(
      authority.sourceTurnHistory,
      boundary.sourceTurnHistory
    ) ||
    !authority.exactSource ||
    (boundary.sourceRolloutAuthority ===
        "explicitly_abandoned_predecessor" &&
      (
        !boundary.sourceAbandonmentFingerprint ||
        authority.sourceAbandonmentFingerprint !==
          boundary.sourceAbandonmentFingerprint ||
        boundary.previousDispatchSnapshot.status !== "resolved"
      ))
  ) {
    throw new Error(
      "the deferred Codex candidate source history or rollout authority changed"
    );
  }
}

function required<Value>(
  value: Value | null | undefined,
  message: string
): Value {
  if (value === null || value === undefined || value === "") {
    throw new Error(message);
  }
  return value;
}
