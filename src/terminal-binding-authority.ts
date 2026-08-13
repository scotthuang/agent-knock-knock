import type { ExecutorKind } from "./executors.js";
import {
  isExactNativeThreadId,
  type ManagedSessionState
} from "./managed-session.js";

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
  const liveRollout = completeRollout(terminal.native_agent_rollout)
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
    !completeRollout(boundRollout) ||
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

function exactRolloutMatches(
  left: TerminalNativeRolloutIdentity | undefined,
  right: TerminalNativeRolloutIdentity | undefined
): boolean {
  return Boolean(
    completeRollout(left) &&
    completeRollout(right) &&
    left.fd === right.fd &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.path === right.path
  );
}

function completeRollout(value: unknown): value is TerminalNativeRolloutIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rollout = value as Partial<TerminalNativeRolloutIdentity>;
  return [rollout.fd, rollout.device, rollout.inode, rollout.path].every(
    (field) => typeof field === "string" && field.trim().length > 0
  );
}

function statusCardEvidence(evidence: string): boolean {
  return evidence.split("+").includes("codex_status_card");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
