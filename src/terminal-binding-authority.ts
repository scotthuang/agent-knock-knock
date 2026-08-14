import type { ExecutorKind } from "./executors.js";
import {
  isExactNativeThreadId,
  type ManagedSessionState
} from "./managed-session.js";
import {
  nonBlankString as stringValue,
  recordValue
} from "./value-guards.js";

export interface TerminalNativeRolloutIdentity {
  fd: string;
  device: string;
  inode: string;
  path: string;
}

export interface TerminalNativeIdentity {
  sessionId: string;
  processStartedAt?: number;
  processUuid?: string;
  processBirth?: string;
  rollout?: TerminalNativeRolloutIdentity;
  evidence: string;
}

/** Exact adapter-neutral fence for one materialized native identity. */
export interface TerminalNativeIdentityFence {
  sessionId: string;
  processUuid: string;
  processBirth: string;
  rollout: TerminalNativeRolloutIdentity;
}

export function isCompleteNativeRollout(
  value: unknown
): value is TerminalNativeRolloutIdentity {
  const rollout = recordValue(value);
  return Boolean(
    rollout &&
    stringValue(rollout.fd) &&
    stringValue(rollout.device) &&
    stringValue(rollout.inode) &&
    stringValue(rollout.path)
  );
}

export function terminalNativeIdentityFence(
  identity: TerminalNativeIdentity | undefined
): TerminalNativeIdentityFence | undefined {
  const sessionId = stringValue(identity?.sessionId);
  const processUuid = stringValue(identity?.processUuid);
  const processBirth = stringValue(identity?.processBirth);
  return sessionId && processUuid && processBirth &&
      isCompleteNativeRollout(identity?.rollout)
    ? {
        sessionId,
        processUuid,
        processBirth,
        rollout: identity.rollout
      }
    : undefined;
}

export function terminalNativeIdentityMatchesFence(
  identity: TerminalNativeIdentity | TerminalNativeIdentityFence | undefined,
  expected: TerminalNativeIdentityFence | undefined
): boolean {
  const identitySessionId = stringValue(identity?.sessionId);
  const identityProcessUuid = stringValue(identity?.processUuid);
  const identityProcessBirth = stringValue(identity?.processBirth);
  const expectedSessionId = stringValue(expected?.sessionId);
  const expectedProcessUuid = stringValue(expected?.processUuid);
  const expectedProcessBirth = stringValue(expected?.processBirth);
  return Boolean(
    identity && expected &&
    identitySessionId && identitySessionId === expectedSessionId &&
    identityProcessUuid && identityProcessUuid === expectedProcessUuid &&
    identityProcessBirth && identityProcessBirth === expectedProcessBirth &&
    isCompleteNativeRollout(identity.rollout) &&
    isCompleteNativeRollout(expected.rollout) &&
    identity.rollout.fd === expected.rollout.fd &&
    identity.rollout.device === expected.rollout.device &&
    identity.rollout.inode === expected.rollout.inode &&
    identity.rollout.path === expected.rollout.path
  );
}

export type TerminalNativeIdentityObservation =
  | {
      status: "resolved";
      identity: TerminalNativeIdentity;
    }
  | {
      status: "verified_absent";
      evidence?: string;
    }
  | {
      status: "unavailable";
      reason?: string;
    }
  | {
      status: "not_observed";
    };

export interface TerminalCodexOpenRootIdentity {
  sessionId: string;
  processUuid: string;
  processBirth: string;
  rollout: TerminalNativeRolloutIdentity;
}

export interface TerminalCodexOpenRootInventory {
  pid: number;
  processUuid: string;
  processBirth: string;
  roots: readonly TerminalCodexOpenRootIdentity[];
}

/**
 * One ephemeral observation of a live terminal.
 *
 * The native identity and process incarnation are deliberately separate. A
 * list scan may supplement process-incarnation evidence without upgrading the
 * coding-agent identity returned by its native resolver. Callers must build a
 * fresh observation at each mutation boundary; this value is never durable
 * authorization.
 */
export interface TerminalObservation {
  agent: ExecutorKind;
  pid: number;
  nativeIdentity: TerminalNativeIdentityObservation;
  processIncarnation: {
    processUuid?: string;
    processBirth?: string;
  };
  statusCardNativeThreadId?: string;
  codexOpenRootInventory?: TerminalCodexOpenRootInventory;
}

/** Build the list-side observation without importing CLI orchestration. */
export function terminalObservationFromListEntry(
  terminal: Record<string, unknown>,
  agent: ExecutorKind
): TerminalObservation {
  const liveThreadId = stringValue(terminal.native_agent_session_id);
  const liveRollout = isCompleteNativeRollout(terminal.native_agent_rollout)
    ? terminal.native_agent_rollout
    : undefined;
  let nativeIdentity: TerminalNativeIdentityObservation;
  if (liveThreadId) {
    nativeIdentity = {
      status: "resolved",
      identity: {
        sessionId: liveThreadId,
        processUuid: stringValue(terminal.native_agent_process_uuid),
        processBirth: stringValue(terminal.native_agent_process_birth),
        rollout: liveRollout,
        evidence:
          stringValue(terminal.native_agent_identity_evidence) ??
          "terminal_scan"
      }
    };
  } else {
    const identityObservation = recordValue(
      terminal.native_agent_identity_observation
    );
    nativeIdentity = identityObservation?.status === "verified_absent"
      ? {
          status: "verified_absent",
          evidence: stringValue(identityObservation.evidence)
        }
      : identityObservation?.status === "unavailable"
        ? {
            status: "unavailable",
            reason: stringValue(identityObservation.reason)
          }
        : { status: "not_observed" };
  }
  return {
    agent,
    pid: Number(terminal.pid),
    nativeIdentity,
    processIncarnation: {
      processUuid: stringValue(terminal.native_agent_process_uuid),
      processBirth: stringValue(terminal.native_agent_process_birth)
    },
    statusCardNativeThreadId: stringValue(
      terminal.native_agent_status_card_session_id
    ),
    codexOpenRootInventory: recordValue(
      terminal._codex_open_root_rollout_inventory
    ) as unknown as TerminalCodexOpenRootInventory | undefined
  };
}

/** Build the mutation-side observation from evidence freshly read under lock. */
export function terminalObservationFromResolvedIdentity({
  agent,
  pid,
  identity,
  processIncarnation
}: {
  agent: ExecutorKind;
  pid: number;
  identity: TerminalNativeIdentity | undefined;
  processIncarnation: TerminalObservation["processIncarnation"];
}): TerminalObservation {
  return {
    agent,
    pid,
    nativeIdentity: identity
      ? { status: "resolved", identity }
      : { status: "not_observed" },
    processIncarnation
  };
}

export interface TerminalBindingMatchEvidence {
  /** Result of the existing canonical/legacy terminal alias fence. */
  terminalAliasMatches: boolean;
  /** Result of the existing realpath-backed workspace fence. */
  workspaceMatches: boolean;
  /**
   * Store-backed committed-transition evidence. This is false until the
   * caller has performed that read at the same point as the legacy path.
   */
  codexLingeringBeforeMatches?: boolean;
}

export type ManagedBindingConflictKind =
  | "stale_process_incarnation"
  | "live_external_thread_change"
  | "provisional_orphan"
  | "unverifiable";

export function classifyTerminalBindingConflict(facts: {
  session: ManagedSessionState;
  processRelationship: "same" | "different" | "unverifiable";
  liveNativeThreadId?: string;
  statusCardNativeThreadId?: string;
  managedTurnCount?: number;
}): ManagedBindingConflictKind {
  const { session, processRelationship } = facts;
  const binding = session.binding;
  if (!binding || processRelationship === "different") {
    return "stale_process_incarnation";
  }
  const boundThreadId = exactThreadId(binding.native_thread_id);
  const liveThreadId = exactThreadId(facts.liveNativeThreadId);
  const statusCardThreadId = exactThreadId(facts.statusCardNativeThreadId);
  if (boundThreadId && statusCardThreadId &&
    boundThreadId !== statusCardThreadId) {
    return processRelationship === "same" && (
      liveThreadId === statusCardThreadId || liveThreadId === boundThreadId
    ) ? "live_external_thread_change" : "unverifiable";
  }
  if (
    session.lineage.created_by === "attach" &&
    !session.last_transition_id &&
    !binding.native_thread_id &&
    !binding.native_process.rollout &&
    facts.managedTurnCount === 0
  ) {
    return "provisional_orphan";
  }
  return processRelationship === "same" &&
      boundThreadId && liveThreadId && boundThreadId !== liveThreadId
    ? "live_external_thread_change"
    : "unverifiable";
}

function exactThreadId(value: string | undefined): string | undefined {
  return isExactNativeThreadId(value) ? value.toLowerCase() : undefined;
}

export type AuthorityDecision =
  | {
      state: "unrelated";
      reason:
        | "session_not_bound"
        | "missing_binding"
        | "agent_mismatch"
        | "pid_mismatch"
        | "terminal_alias_mismatch"
        | "workspace_mismatch";
    }
  | {
      state: "exact";
      basis:
        | "native_identity"
        | "codex_open_root_rollout"
        | "codex_status_card_process"
        | "codex_lingering_before";
    }
  | {
      state: "not_exact";
      reason:
        | "status_card_thread_mismatch"
        | "native_identity_absent"
        | "native_identity_mismatch";
    };

/**
 * Pure exact-binding policy shared by read-only projection and mutation
 * preparation. Store, process and filesystem evidence is gathered by the
 * caller and supplied explicitly so this function cannot widen authorization
 * or change I/O ordering.
 */
export function decideTerminalBindingMatch(
  session: ManagedSessionState,
  observation: TerminalObservation,
  evidence: TerminalBindingMatchEvidence
): AuthorityDecision {
  const binding = session.binding;
  if (session.status !== "bound") {
    return { state: "unrelated", reason: "session_not_bound" };
  }
  if (!binding) {
    return { state: "unrelated", reason: "missing_binding" };
  }
  if (session.agent !== observation.agent) {
    return { state: "unrelated", reason: "agent_mismatch" };
  }
  if (binding.native_process.pid !== observation.pid) {
    return { state: "unrelated", reason: "pid_mismatch" };
  }
  if (!evidence.terminalAliasMatches) {
    return { state: "unrelated", reason: "terminal_alias_mismatch" };
  }
  if (!evidence.workspaceMatches) {
    return { state: "unrelated", reason: "workspace_mismatch" };
  }

  const nativeIdentity = observation.nativeIdentity.status === "resolved"
    ? observation.nativeIdentity.identity
    : undefined;
  if (
    isExactNativeThreadId(binding.native_thread_id) &&
    isExactNativeThreadId(observation.statusCardNativeThreadId) &&
    binding.native_thread_id.toLowerCase() !==
      observation.statusCardNativeThreadId.toLowerCase()
  ) {
    return { state: "not_exact", reason: "status_card_thread_mismatch" };
  }

  if (!nativeIdentity) {
    if (codexOpenRootRolloutMatchesBinding(session, observation)) {
      return { state: "exact", basis: "codex_open_root_rollout" };
    }
    if (codexStatusCardProcessMatchesBinding(session, observation)) {
      return { state: "exact", basis: "codex_status_card_process" };
    }
    return { state: "not_exact", reason: "native_identity_absent" };
  }

  if (nativeIdentityMatchesBinding(session, nativeIdentity)) {
    return { state: "exact", basis: "native_identity" };
  }
  if (
    evidence.codexLingeringBeforeMatches === true &&
    session.agent === "codex" &&
    Boolean(binding.native_thread_id) &&
    !binding.native_process.rollout &&
    statusCardEvidence(binding.native_process.evidence)
  ) {
    return { state: "exact", basis: "codex_lingering_before" };
  }
  return { state: "not_exact", reason: "native_identity_mismatch" };
}

function nativeIdentityMatchesBinding(
  session: ManagedSessionState,
  identity: TerminalNativeIdentity
): boolean {
  const binding = session.binding;
  return Boolean(
    binding &&
    binding.native_thread_id === identity.sessionId &&
    (
      !binding.native_process.process_uuid ||
      binding.native_process.process_uuid === identity.processUuid
    ) &&
    (
      !binding.native_process.process_birth ||
      binding.native_process.process_birth === identity.processBirth
    ) &&
    (
      !binding.native_process.rollout ||
      exactRolloutMatches(binding.native_process.rollout, identity.rollout)
    )
  );
}

function codexOpenRootRolloutMatchesBinding(
  session: ManagedSessionState,
  observation: TerminalObservation
): boolean {
  const binding = session.binding;
  const inventory = observation.codexOpenRootInventory;
  const boundRollout = binding?.native_process.rollout;
  if (
    session.agent !== "codex" ||
    !binding?.native_thread_id ||
    !isCompleteNativeRollout(boundRollout) ||
    !inventory
  ) {
    return false;
  }
  const candidate = inventory.roots.find((root) =>
    root.sessionId.toLowerCase() === binding.native_thread_id?.toLowerCase()
  );
  return Boolean(
    candidate &&
    exactRolloutMatches(candidate.rollout, boundRollout) &&
    inventory.pid === binding.native_process.pid &&
    inventory.processUuid === binding.native_process.process_uuid &&
    inventory.processBirth === binding.native_process.process_birth
  );
}

function codexStatusCardProcessMatchesBinding(
  session: ManagedSessionState,
  observation: TerminalObservation
): boolean {
  const binding = session.binding;
  return Boolean(
    session.agent === "codex" &&
    binding?.native_thread_id &&
    statusCardEvidence(binding.native_process.evidence) &&
    binding.native_process.process_uuid &&
    binding.native_process.process_birth &&
    binding.native_process.process_uuid ===
      observation.processIncarnation.processUuid &&
    binding.native_process.process_birth ===
      observation.processIncarnation.processBirth
  );
}

export function exactRolloutMatches(
  left: unknown,
  right: TerminalNativeRolloutIdentity | undefined
): boolean {
  return Boolean(
    isCompleteNativeRollout(left) &&
    isCompleteNativeRollout(right) &&
    left.fd === right.fd &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.path === right.path
  );
}

export function candidateSourceRootAuthorityMatches(
  roots: readonly TerminalCodexOpenRootIdentity[],
  sourceThreadId: string | undefined,
  sourceRollout: TerminalNativeRolloutIdentity | undefined,
  authority: "present" | "explicitly_abandoned_predecessor"
): boolean {
  const sourceId = exactThreadId(sourceThreadId);
  if (!sourceId || !isCompleteNativeRollout(sourceRollout)) return false;
  const sameSource = (root: TerminalCodexOpenRootIdentity): boolean =>
    root.sessionId.toLowerCase() === sourceId;
  return authority === "explicitly_abandoned_predecessor"
    ? !roots.some(sameSource) &&
      !roots.some((root) =>
        exactRolloutMatches(root.rollout, sourceRollout)
      )
    : roots.some((root) =>
        sameSource(root) && exactRolloutMatches(root.rollout, sourceRollout)
      );
}

function statusCardEvidence(evidence: string): boolean {
  return evidence.split("+").includes("codex_status_card");
}
