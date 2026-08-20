import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexOpenRootRolloutInventory } from "./agent-session-provider.js";
import {
  executorDefinitionForKind,
  type ExecutorKind
} from "./executors.js";
import {
  executorForConversation,
  type Conversation
} from "./protocol.js";
import {
  humanObservedHandoffBindingToken,
  isExactNativeThreadId,
  managedSessionBindingToken,
  managedSessionRevision,
  unmanagedTerminalBindingToken,
  type HumanObservedHandoffTargetSnapshot,
  type ManagedSessionState,
  type ManagedTerminalBinding
} from "./managed-session.js";
import {
  hasCanonicalTerminalEndpoint,
  sameTerminalControlIncarnation,
  terminalEndpointFromControlRef,
  terminalEndpointIdentityKey,
  type TerminalControlRef
} from "./terminal-control-ref.js";
import type { TerminalBridgeStatus } from "./terminal-agent-bridge.js";
import type {
  DeferredForegroundTransferSourceRolloutAuthority,
  DeferredForegroundTransferSourceTurnAuthority
} from "./deferred-foreground-transfer.js";
import {
  candidateSourceRootAuthorityMatches,
  classifyTerminalBindingConflict,
  exactRolloutMatches,
  isCodexStatusCardEvidence,
  isCompleteNativeRollout,
  terminalNativeIdentityFence,
  terminalNativeIdentityMatchesFence,
  type ManagedBindingConflictKind,
  type TerminalCodexOpenRootIdentity,
  type TerminalNativeIdentity,
  type TerminalNativeIdentityFence,
  type TerminalNativeRolloutIdentity
} from "./terminal-binding-authority.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export {
  candidateSourceRootAuthorityMatches,
  classifyTerminalBindingConflict as classifyManagedBindingConflict,
  isCodexStatusCardEvidence,
  isCompleteNativeRollout,
  terminalNativeIdentityFence as codexIdentityFence,
  terminalNativeIdentityMatchesFence as nativeIdentityMatchesCodexPreMaterialization
};
export type {
  ManagedBindingConflictKind,
  TerminalCodexOpenRootIdentity,
  TerminalNativeIdentity,
  TerminalNativeRolloutIdentity
};

export type ProcessIncarnationRelationship =
  | "same"
  | "different"
  | "unverifiable";

export interface DeferredCodexForegroundDispatchSnapshot {
  status: "none" | "resolved";
  fingerprint: string;
}

export type CodexPreMaterializationIdentity = TerminalNativeIdentityFence;

export function assertSafeTerminalSend(
  agent: ExecutorKind,
  terminalStatus: TerminalBridgeStatus | undefined
): void {
  const displayName = executorDefinitionForKind(agent).displayName;
  const approval = isRecord(terminalStatus?.approval_state)
    ? terminalStatus.approval_state
    : undefined;
  if (terminalStatus?.reachable !== true) {
    throw new Error(`${displayName} terminal status is unavailable`);
  }
  if (approval?.blocked === true) {
    throw new Error(
      nonBlankString(approval.reason) ??
        `${displayName} is waiting at a permission dialog`
    );
  }
  if (terminalStatus.activity_state !== "idle") {
    throw new Error(
      `${displayName} terminal is ${
        nonBlankString(terminalStatus.activity_state) ?? "unknown"
      }, not idle`
    );
  }
}

export interface CodexAllowedCompanionSet {
  primary?: CodexPreMaterializationIdentity;
  additional: CodexPreMaterializationIdentity[];
}

export interface CodexSendAuthorityContext {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  workspace?: string;
  liveProcessUuid?: string;
  liveProcessBirth?: string;
}

export function terminalControlSelectorKey(
  control: unknown
): string | undefined {
  if (!isRecord(control)) return undefined;
  let endpoint: ReturnType<typeof terminalEndpointFromControlRef>;
  try {
    endpoint = terminalEndpointFromControlRef(
      control as unknown as TerminalControlRef
    );
  } catch {
    return undefined;
  }
  const processAnchorPid = Number(endpoint.processAnchorPid);
  if (!Number.isSafeInteger(processAnchorPid) || processAnchorPid <= 1) {
    return undefined;
  }
  return JSON.stringify({
    identity: terminalEndpointIdentityKey(endpoint),
    process_anchor_pid: processAnchorPid
  });
}

export function terminalControlsShareIncarnation(
  left: unknown,
  right: unknown
): boolean {
  if (!terminalControlSelectorKey(left) || !terminalControlSelectorKey(right)) {
    return false;
  }
  return sameTerminalControlIncarnation(
    left as TerminalControlRef,
    right as TerminalControlRef
  );
}

export function terminalControlAliasMatches(
  storedTerminalId: unknown,
  storedControl: unknown,
  currentTerminalId: unknown,
  currentControl: unknown
): boolean {
  if (!terminalControlsShareIncarnation(storedControl, currentControl)) {
    return false;
  }
  return Boolean(
    storedControl && typeof storedControl === "object" &&
    currentControl && typeof currentControl === "object" &&
    (
      (
        hasCanonicalTerminalEndpoint(storedControl as TerminalControlRef) &&
        hasCanonicalTerminalEndpoint(currentControl as TerminalControlRef)
      ) || nonBlankString(storedTerminalId) ===
        nonBlankString(currentTerminalId)
    )
  );
}

export function selectRootTerminalProcesses<Process extends {
  agent: ExecutorKind;
  pid: number;
  ppid?: number;
  terminalControl?: TerminalControlRef;
}>(processes: readonly Process[]): Process[] {
  const pids = new Set(
    processes.map((process) => `${process.agent}:${process.pid}`)
  );
  const roots = processes.filter((process) =>
    !process.ppid || !pids.has(`${process.agent}:${process.ppid}`)
  );
  const seenTerminalIncarnations = new Set<string>();
  return roots.filter((process) => {
    const endpoint = process.terminalControl
      ? terminalEndpointFromControlRef(process.terminalControl)
      : undefined;
    const incarnation = endpoint
      ? JSON.stringify({
          agent: process.agent,
          identity: terminalEndpointIdentityKey(endpoint),
          process_anchor_pid: endpoint.processAnchorPid ?? null
        })
      : undefined;
    if (!incarnation) return true;
    if (seenTerminalIncarnations.has(incarnation)) return false;
    seenTerminalIncarnations.add(incarnation);
    return true;
  });
}

export function childProcessIdsForRoot<Process extends {
  agent: ExecutorKind;
  pid: number;
  ppid?: number;
}>(root: Process, processes: readonly Process[]): number[] {
  return processes
    .filter((process) =>
      process.agent === root.agent && process.ppid === root.pid
    )
    .map((process) => process.pid);
}

export function processIncarnationRelationship({
  binding,
  livePid,
  liveProcessUuid,
  liveProcessBirth
}: {
  binding: ManagedTerminalBinding;
  livePid: number;
  liveProcessUuid?: string;
  liveProcessBirth?: string;
}): ProcessIncarnationRelationship {
  if (binding.native_process.pid !== livePid) return "different";
  const comparisons: boolean[] = [];
  if (binding.native_process.process_uuid && liveProcessUuid) {
    comparisons.push(binding.native_process.process_uuid === liveProcessUuid);
  }
  if (binding.native_process.process_birth && liveProcessBirth) {
    comparisons.push(binding.native_process.process_birth === liveProcessBirth);
  }
  if (comparisons.length === 0) return "unverifiable";
  if (comparisons.every(Boolean)) return "same";
  if (comparisons.every((value) => !value)) return "different";
  return "unverifiable";
}

export function decideManagedBindingConflict(facts: {
  session: ManagedSessionState;
  claimsTerminal: boolean;
  exactBinding: boolean;
  ownerConclusivelyInactive: boolean;
  processRelationship: ProcessIncarnationRelationship;
  liveNativeThreadId?: string;
  statusCardNativeThreadId?: string;
  managedTurnCount?: number;
}): ManagedBindingConflictKind | undefined {
  if (!facts.claimsTerminal || facts.exactBinding) return undefined;
  if (facts.ownerConclusivelyInactive) return "stale_process_incarnation";
  return classifyTerminalBindingConflict(facts);
}

export function codexCompanionsPresentInOpenRootInventory(
  companions: CodexAllowedCompanionSet,
  inventory: CodexOpenRootRolloutInventory
): CodexAllowedCompanionSet {
  const present = [companions.primary, ...companions.additional].filter(
    (candidate): candidate is CodexPreMaterializationIdentity => Boolean(
      candidate && inventory.roots.some((root) =>
        terminalNativeIdentityMatchesFence(root, candidate)
      )
    )
  );
  return { primary: present[0], additional: present.slice(1) };
}

export function withCodexCompanionFences<Runtime extends object>(
  runtime: Runtime,
  companions: CodexAllowedCompanionSet
): Runtime & {
  allowedPreMaterializationNativeIdentity?: CodexPreMaterializationIdentity;
  allowedAdditionalNativeIdentities: CodexPreMaterializationIdentity[];
} {
  return {
    ...runtime,
    allowedPreMaterializationNativeIdentity: companions.primary,
    allowedAdditionalNativeIdentities: companions.additional
  };
}

export function codexCompanionsExcludingPreferred(
  roots: CodexAllowedCompanionSet,
  preferredSessionId: string
): CodexAllowedCompanionSet {
  const allowed = [roots.primary, ...roots.additional].filter(
    (candidate): candidate is CodexPreMaterializationIdentity =>
      Boolean(candidate && candidate.sessionId !== preferredSessionId)
  );
  return { primary: allowed[0], additional: allowed.slice(1) };
}

export interface StoredTurnNativeIdentityFacts {
  strictNativeIdentity: boolean;
  agent: ExecutorKind;
  storedSessionId?: string;
  storedProcessUuid?: string;
  storedProcessBirth?: string;
  storedRollout?: {
    fd?: string;
    device?: string;
    inode?: string;
    path?: string;
  };
}

export function nativeIdentityMatchesStoredTurn(
  facts: StoredTurnNativeIdentityFacts,
  currentIdentity: TerminalNativeIdentity | undefined
): boolean {
  const strictClaudeTurn = facts.strictNativeIdentity &&
    facts.agent === "claude";
  const strictCodexTurn = facts.strictNativeIdentity && facts.agent === "codex";
  const storedSessionId = facts.storedSessionId;
  if (
    facts.strictNativeIdentity &&
    (!storedSessionId || !currentIdentity?.sessionId)
  ) return false;
  const storedProcessUuid = facts.storedProcessUuid;
  if (
    strictClaudeTurn && (
      !storedProcessUuid || !currentIdentity?.processUuid ||
      storedProcessUuid !== currentIdentity.processUuid
    )
  ) return false;
  let storedProcessBirth: string | undefined;
  let storedRollout: StoredTurnNativeIdentityFacts["storedRollout"];
  if (
    strictCodexTurn
  ) {
    storedProcessBirth = facts.storedProcessBirth;
    if (!storedProcessUuid || !storedProcessBirth) return false;
    storedRollout = facts.storedRollout;
    if (
      !isCompleteNativeRollout(storedRollout) ||
      !currentIdentity?.processUuid || !currentIdentity.processBirth ||
      !isCompleteNativeRollout(currentIdentity.rollout)
    ) return false;
  }
  if (
    storedSessionId && storedSessionId !== currentIdentity?.sessionId
  ) return false;
  if (
    storedProcessUuid && storedProcessUuid !== currentIdentity?.processUuid
  ) return false;
  storedProcessBirth = strictCodexTurn
    ? storedProcessBirth
    : facts.storedProcessBirth;
  if (
    storedProcessBirth && storedProcessBirth !== currentIdentity?.processBirth
  ) return false;
  storedRollout = strictCodexTurn ? storedRollout : facts.storedRollout;
  return !storedRollout || sameNativeRolloutFields(
    storedRollout,
    currentIdentity?.rollout
  );
}

/** Project one stored Turn into the canonical native-identity matcher. */
export function nativeAgentIdentityMatchesTurn(
  conversation: Conversation,
  currentIdentity: TerminalNativeIdentity | undefined
): boolean {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const sessionId = nonBlankString(takeover?.terminal_agent_session_id);
  const processUuid = nonBlankString(takeover?.terminal_agent_process_uuid);
  const processBirth = nonBlankString(takeover?.terminal_agent_process_birth);
  const rollout = takeover?.terminal_agent_rollout;
  const strict = Number(takeover?.terminal_agent_identity_protocol) === 1;
  const agent = executorForConversation(conversation).kind;
  return nativeIdentityMatchesStoredTurn({
    strictNativeIdentity: strict,
    agent,
    storedSessionId: sessionId,
    storedProcessUuid: processUuid,
    storedProcessBirth: processBirth,
    get storedRollout() {
      return isRecord(rollout)
        ? {
            get fd() {
              return nonBlankString(rollout.fd);
            },
            get device() {
              return nonBlankString(rollout.device);
            },
            get inode() {
              return nonBlankString(rollout.inode);
            },
            get path() {
              return nonBlankString(rollout.path);
            }
          }
        : undefined;
    }
  }, currentIdentity);
}

export function exactBoundCodexSendSource(facts: {
  kind: "verified_empty" | "status_card" | "candidate";
  sourceSession: ManagedSessionState;
  context: CodexSendAuthorityContext;
  inventory?: CodexOpenRootRolloutInventory;
  sourceRolloutAuthority?: DeferredForegroundTransferSourceRolloutAuthority;
}): boolean {
  const { sourceSession: session, context } = facts;
  const binding = session.binding;
  const sourceNativeThreadId = binding?.native_thread_id;
  const sourceRollout = binding?.native_process.rollout;
  const sourceRolloutAuthority = facts.sourceRolloutAuthority ?? "present";
  const exactSourceEvidence = facts.kind === "verified_empty"
    ? isCompleteNativeRollout(sourceRollout)
    : facts.kind === "status_card"
      ? Boolean(binding && !sourceRollout &&
          isCodexStatusCardEvidence(binding.native_process.evidence))
      : Boolean(facts.inventory && candidateSourceRootAuthorityMatches(
          facts.inventory.roots,
          sourceNativeThreadId,
          sourceRollout,
          sourceRolloutAuthority
        ));
  return Boolean(
    session.agent === "codex" && session.status === "bound" && binding &&
    isExactNativeThreadId(sourceNativeThreadId) && exactSourceEvidence &&
    (facts.kind === "candidate" ||
      binding.native_process.process_uuid &&
      binding.native_process.process_birth) &&
    binding.native_process.pid === context.pid &&
    terminalControlAliasMatches(
      binding.terminal_id,
      binding.terminal_control,
      context.terminalId,
      context.terminalControl
    ) &&
    context.workspace &&
    path.resolve(session.workspace) === path.resolve(context.workspace) &&
    processIncarnationRelationship({
      binding,
      livePid: context.pid,
      liveProcessUuid: context.liveProcessUuid,
      liveProcessBirth: context.liveProcessBirth
    }) === "same" && (
      facts.kind !== "candidate" || Boolean(
        facts.inventory && context.liveProcessUuid && context.liveProcessBirth &&
        exactCodexCandidateInventoryForDeferredSend({
          inventory: facts.inventory,
          sourceSession: session,
          pid: context.pid,
          workspace: context.workspace,
          processUuid: context.liveProcessUuid,
          processBirth: context.liveProcessBirth,
          sourceRolloutAuthority
        })
      )
    )
  );
}

export function exactCodexCandidateInventoryForDeferredSend({
  inventory,
  sourceSession,
  pid,
  workspace,
  processUuid,
  processBirth,
  sourceRolloutAuthority
}: {
  inventory: CodexOpenRootRolloutInventory;
  sourceSession: ManagedSessionState;
  pid: number;
  workspace: string;
  processUuid: string;
  processBirth: string;
  sourceRolloutAuthority: DeferredForegroundTransferSourceRolloutAuthority;
}): boolean {
  const sourceNativeThreadId = sourceSession.binding?.native_thread_id;
  const sourceRollout = sourceSession.binding?.native_process.rollout;
  const sourceRootPresent = Boolean(sourceNativeThreadId &&
    inventory.roots.some((root) =>
      root.sessionId.toLowerCase() === sourceNativeThreadId.toLowerCase()
    ));
  const sourceRolloutPresent = Boolean(sourceRollout &&
    inventory.roots.some((root) =>
      exactRolloutMatches(root.rollout, sourceRollout)
    ));
  return Boolean(
    inventory.roots.length > 0 && inventory.pid === pid &&
    inventory.processUuid === processUuid &&
    inventory.processBirth === processBirth && inventory.cwd &&
    path.resolve(inventory.cwd) === path.resolve(workspace) &&
    /^[0-9a-f]{64}$/u.test(inventory.inventoryFingerprint) &&
    (sourceRolloutAuthority === "explicitly_abandoned_predecessor"
      ? isExactNativeThreadId(sourceNativeThreadId) &&
        isCompleteNativeRollout(sourceRollout) &&
        !sourceRootPresent && !sourceRolloutPresent
      : sourceRollout === undefined || sourceRootPresent)
  );
}

export function deferredCodexForegroundBindingToken(facts: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  workspace: string;
  processUuid: string;
  processBirth: string;
  sourceSession: ManagedSessionState;
  dispatchSnapshot: DeferredCodexForegroundDispatchSnapshot;
  candidateInventory?: CodexOpenRootRolloutInventory;
  sourceTurnHistory?: DeferredForegroundTransferSourceTurnAuthority[];
  sourceRolloutAuthority?: DeferredForegroundTransferSourceRolloutAuthority;
  sourceAbandonmentFingerprint?: string;
}): string {
  const terminalToken = unmanagedTerminalBindingToken({
    terminalId: facts.terminalId,
    terminalControl: facts.terminalControl,
    agent: "codex",
    pid: facts.pid,
    workspace: facts.workspace,
    processUuid: facts.processUuid,
    processBirth: facts.processBirth
  });
  const candidateAuthority = facts.candidateInventory
    ? {
        inventory_pid: facts.candidateInventory.pid,
        inventory_cwd: facts.candidateInventory.cwd,
        inventory_fingerprint: facts.candidateInventory.inventoryFingerprint,
        candidate_native_thread_ids: facts.candidateInventory.roots.map(
          (root) => root.sessionId
        )
      }
    : undefined;
  const sourceTurnHistoryFingerprint = facts.sourceTurnHistory
    ? sha256(JSON.stringify(facts.sourceTurnHistory))
    : undefined;
  return sha256(JSON.stringify({
    version: candidateAuthority ? 5 : 2,
    kind: "deferred_codex_foreground_binding",
    terminal_token: terminalToken,
    composer_state: "styled_empty",
    source_session_id: facts.sourceSession.session_id,
    source_revision: managedSessionRevision(facts.sourceSession),
    source_binding_token: managedSessionBindingToken(facts.sourceSession),
    terminal_dispatch_snapshot: facts.dispatchSnapshot,
    observation: candidateAuthority
      ? "exact_open_root_inventory"
      : "verified_absent",
    ...(sourceTurnHistoryFingerprint
      ? { source_turn_history_fingerprint: sourceTurnHistoryFingerprint }
      : {}),
    ...(candidateAuthority
      ? { source_rollout_authority: facts.sourceRolloutAuthority ?? "present" }
      : {}),
    ...(facts.sourceAbandonmentFingerprint
      ? { source_abandonment_fingerprint: facts.sourceAbandonmentFingerprint }
      : {}),
    ...(candidateAuthority ?? {})
  }));
}

export function verifiedEmptyCodexHandoffToken(facts: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  workspace: string;
  processUuid: string;
  processBirth: string;
  sourceSession: ManagedSessionState;
}): string {
  const terminalToken = unmanagedTerminalBindingToken({
    terminalId: facts.terminalId,
    terminalControl: facts.terminalControl,
    agent: "codex",
    pid: facts.pid,
    workspace: facts.workspace,
    processUuid: facts.processUuid,
    processBirth: facts.processBirth
  });
  return sha256(JSON.stringify({
    version: 1,
    kind: "verified_empty_codex_handoff",
    terminal_token: terminalToken,
    source_session_id: facts.sourceSession.session_id,
    source_revision: managedSessionRevision(facts.sourceSession),
    source_binding_token: managedSessionBindingToken(facts.sourceSession),
    observation: "verified_absent"
  }));
}

export function observedHandoffAuthorityToken(facts: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  agent: ExecutorKind;
  pid: number;
  workspace: string;
  identity: TerminalNativeIdentity;
  sourceSession: ManagedSessionState;
  target: HumanObservedHandoffTargetSnapshot;
}): string {
  const terminalToken = unmanagedTerminalBindingToken({
    terminalId: facts.terminalId,
    terminalControl: facts.terminalControl,
    agent: facts.agent,
    pid: facts.pid,
    workspace: facts.workspace,
    nativeThreadId: facts.identity.sessionId,
    processUuid: facts.identity.processUuid,
    processBirth: facts.identity.processBirth,
    rollout: facts.identity.rollout
  });
  return humanObservedHandoffBindingToken({
    terminal_token: terminalToken,
    source_session_id: facts.sourceSession.session_id,
    source_revision: managedSessionRevision(facts.sourceSession),
    source_binding_token: managedSessionBindingToken(facts.sourceSession),
    target: facts.target
  });
}

export function activeTurnHandoffDecisionToken(facts: {
  handoffToken: string;
  sessionId: string;
  turnId: string;
  turnStatus: string;
  turnUpdatedAt: string | null;
  currentMessageId: string | null;
  ledgerGenerationId: string | null;
  ledgerMessageId: string | null;
  ledgerStatus: string | null;
}): string {
  return sha256(JSON.stringify({
    version: 1,
    kind: "active_turn_human_handoff",
    handoff_token: facts.handoffToken,
    session_id: facts.sessionId,
    turn_id: facts.turnId,
    turn_status: facts.turnStatus,
    turn_updated_at: facts.turnUpdatedAt,
    current_message_id: facts.currentMessageId,
    ledger_generation_id: facts.ledgerGenerationId,
    ledger_message_id: facts.ledgerMessageId,
    ledger_status: facts.ledgerStatus
  }));
}

function sameNativeRolloutFields(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right) &&
    nonBlankString(left.fd) === nonBlankString(right.fd) &&
    nonBlankString(left.device) === nonBlankString(right.device) &&
    nonBlankString(left.inode) === nonBlankString(right.inode) &&
    nonBlankString(left.path) === nonBlankString(right.path);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
