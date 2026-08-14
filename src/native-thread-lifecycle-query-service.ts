import path from "node:path";
import {
  isExactNativeThreadId,
  type ManagedSessionState,
  type NativeThreadCandidate,
  type NativeThreadTransition
} from "./managed-session.js";
import {
  evaluateResumeCandidateAvailability,
  hasStrongCodexLifecycleIdentity
} from "./native-thread-lifecycle-policy.js";
import {
  decodeThreadCandidateToken,
  encodeThreadCandidateToken,
  sortNativeThreadCandidates,
  verifiedPreviousResumeCandidate
} from "./native-thread-resume-snapshot-policy.js";
import type {
  TerminalThreadLifecycleAgentRow,
  TerminalThreadLifecycleCandidateProvider,
  TerminalThreadLifecycleCandidateToken
} from "./terminal-agent-adapter.js";
import type { TerminalNativeIdentity } from "./terminal-binding-authority.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import { nonBlankString as stringValue } from "./value-guards.js";
import type { ExecutorKind } from "./executors.js";

export type NativeThreadLifecycleIdentity = TerminalNativeIdentity;
type VerifiedLifecycleCandidate = Omit<NativeThreadCandidate, "resumable">;

export interface LifecycleTerminalObservation {
  conversationId: string;
  agent: ExecutorKind;
  pid: number;
  terminalControl: TerminalControlRef;
}

export interface NativeThreadLifecycleQueryPorts {
  cwd(): string;
  listManagedSessions(): readonly ManagedSessionState[];
  loadNativeThreadTransition(transitionId: string): NativeThreadTransition;
  blockingTurns(sessionId: string): readonly { turnId: string; status: string }[];
  assertStoreAuthority(
    terminalControl: TerminalControlRef,
    nativeThreadId: string
  ): void;
  runningVersion(terminal: LifecycleTerminalObservation): string | undefined;
  candidateProvider(agent: ExecutorKind): TerminalThreadLifecycleCandidateProvider;
  sessionOwnerIsConclusivelyInactive(
    session: ManagedSessionState,
    terminal: LifecycleTerminalObservation,
    identity: NativeThreadLifecycleIdentity | undefined
  ): boolean;
  rootActiveProcesses(agent: ExecutorKind): Promise<readonly {
    pid: number;
    cwd?: string;
  }[]>;
  resolveProcessIdentity(
    agent: ExecutorKind,
    pid: number,
    cwd?: string
  ): Promise<NativeThreadLifecycleIdentity | undefined>;
  loadClaudeAgentRows(): readonly TerminalThreadLifecycleAgentRow[];
  workspaceRelationship(
    expected: unknown,
    actual: unknown
  ): "same" | "different" | "unknown";
}

export interface ActiveNativeThreadOwnerScan {
  owners: Map<string, number[]>;
  uncertaintyReasons: string[];
}

export async function activeNativeThreadOwners(
  request: {
    agent: ExecutorKind;
    currentPid: number;
    workspace?: string;
  },
  ports: NativeThreadLifecycleQueryPorts
): Promise<ActiveNativeThreadOwnerScan> {
  const { agent, currentPid, workspace } = request;
  const owners = new Map<string, number[]>();
  const uncertaintyReasons: string[] = [];
  const couldShareWorkspace = (candidate: unknown): boolean =>
    ports.workspaceRelationship(workspace, candidate) !== "different";
  if (agent === "claude") {
    const rowsByPid = new Map<number, TerminalThreadLifecycleAgentRow[]>();
    for (const row of ports.loadClaudeAgentRows()) {
      const pid = Number(row.pid);
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        uncertaintyReasons.push(
          "Claude agents JSON contains an invalid process identity"
        );
        continue;
      }
      if (pid === currentPid) continue;
      rowsByPid.set(pid, [...(rowsByPid.get(pid) ?? []), row]);
    }
    for (const [pid, rows] of rowsByPid) {
      const sessionIds = exactClaudeSessionIds(rows);
      for (const sessionId of sessionIds) {
        const current = owners.get(sessionId) ?? [];
        if (!current.includes(pid)) current.push(pid);
        owners.set(sessionId, current);
      }
      if (rows.length !== 1 || sessionIds.length > 1) {
        if (rows.some((row) => couldShareWorkspace(row.cwd))) {
          uncertaintyReasons.push(
            `Claude process ${pid} has ambiguous agents JSON ownership`
          );
        }
      } else if (
        !sessionIds[0] &&
        (rows[0].kind === undefined || rows[0].kind === "interactive") &&
        couldShareWorkspace(rows[0].cwd)
      ) {
        uncertaintyReasons.push(
          `Claude process ${pid} has no exact native thread identity`
        );
      }
    }
    return { owners, uncertaintyReasons };
  }

  for (const process of await ports.rootActiveProcesses(agent)) {
    if (process.pid === currentPid) continue;
    try {
      const identity = await ports.resolveProcessIdentity(
        agent,
        process.pid,
        undefined
      );
      if (!isExactNativeThreadId(identity?.sessionId)) {
        if (couldShareWorkspace(process.cwd)) {
          uncertaintyReasons.push(
            `Codex process ${process.pid} has no exact native thread identity`
          );
        }
        continue;
      }
      const nativeThreadId = identity.sessionId.toLowerCase();
      owners.set(nativeThreadId, [
        ...(owners.get(nativeThreadId) ?? []),
        process.pid
      ]);
      if (
        !hasStrongCodexLifecycleIdentity(identity) &&
        couldShareWorkspace(process.cwd)
      ) {
        uncertaintyReasons.push(
          `Codex process ${process.pid} has an incomplete native process identity`
        );
      }
    } catch (error) {
      if (couldShareWorkspace(process.cwd)) {
        uncertaintyReasons.push(
          `Codex process ${process.pid} ownership is unverifiable: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
  return { owners, uncertaintyReasons };
}

function exactClaudeSessionIds(
  rows: readonly TerminalThreadLifecycleAgentRow[]
): string[] {
  return [...new Set(rows.flatMap((row): string[] => {
    const sessionId = stringValue(row.sessionId)?.toLowerCase();
    return sessionId && isExactNativeThreadId(sessionId) ? [sessionId] : [];
  }))];
}

export async function assertNativeThreadHasExclusiveOwnership(
  request: {
    terminalControl: TerminalControlRef;
    agent: ExecutorKind;
    currentPid: number;
    nativeThreadId: string;
    excludedManagedSessionId?: string;
    allowedManagedSessionIds?: readonly string[];
  },
  ports: NativeThreadLifecycleQueryPorts
): Promise<void> {
  const nativeThreadId = request.nativeThreadId.toLowerCase();
  if (!isExactNativeThreadId(nativeThreadId)) {
    throw new Error("native thread ownership requires an exact thread UUID");
  }
  ports.assertStoreAuthority(request.terminalControl, nativeThreadId);
  const active = await activeNativeThreadOwners({
    agent: request.agent,
    currentPid: request.currentPid,
    workspace: stringValue(request.terminalControl.currentPath)
  }, ports);
  const otherOwnerPids = active.owners.get(nativeThreadId) ?? [];
  if (otherOwnerPids.length > 0) {
    throw new Error(
      `native thread ${nativeThreadId} is already active in another ` +
      `${request.agent} process (${otherOwnerPids.join(", ")})`
    );
  }
  if (active.uncertaintyReasons.length > 0) {
    throw new Error(
      `native thread ownership is unverifiable: ${
        active.uncertaintyReasons.join("; ")
      }`
    );
  }
  const allowed = request.allowedManagedSessionIds ?? [];
  const conflicts = ports.listManagedSessions().filter((session) =>
    session.session_id !== request.excludedManagedSessionId &&
    !allowed.includes(session.session_id) &&
    session.agent === request.agent &&
    session.binding?.native_thread_id?.toLowerCase() === nativeThreadId
  );
  if (conflicts.length > 0) {
    throw new Error(
      `native thread ${nativeThreadId} is already claimed by managed Session ` +
      conflicts.map((session) => session.session_id).join(", ")
    );
  }
}

export async function resumableNativeThreadCandidates(
  request: {
    terminal: LifecycleTerminalObservation;
    currentIdentity?: NativeThreadLifecycleIdentity;
  },
  ports: NativeThreadLifecycleQueryPorts
): Promise<NativeThreadCandidate[]> {
  const { terminal, currentIdentity } = request;
  const workspace = path.resolve(terminal.terminalControl.currentPath ?? ports.cwd());
  const active = await activeNativeThreadOwners({
    agent: terminal.agent,
    currentPid: terminal.pid,
    workspace
  }, ports);
  const managedByNativeId = new Map<string, ManagedSessionState[]>();
  for (const session of ports.listManagedSessions()) {
    const nativeThreadId = session.binding?.native_thread_id?.toLowerCase();
    if (session.agent === terminal.agent && nativeThreadId) {
      managedByNativeId.set(nativeThreadId, [
        ...(managedByNativeId.get(nativeThreadId) ?? []),
        session
      ]);
    }
  }
  const agentVersion = ports.runningVersion(terminal);
  if (!agentVersion) {
    throw new Error(
      `cannot list resumable ${terminal.agent} threads without the exact running version`
    );
  }
  const observed = await ports.candidateProvider(terminal.agent)
    .listThreadLifecycleCandidates({ cwd: workspace, agentVersion });
  const unique = new Map<string, VerifiedLifecycleCandidate>();
  for (const candidate of observed) {
    if (isExactNativeThreadId(candidate.nativeThreadId)) {
      const nativeThreadId = candidate.nativeThreadId.toLowerCase();
      unique.set(nativeThreadId, {
        native_thread_id: nativeThreadId,
        candidate_token: encodeThreadCandidateToken(candidate.candidateToken),
        agent: terminal.agent,
        workspace,
        title: candidate.title,
        preview: candidate.preview,
        updated_at_ms: candidate.updatedAtMs,
        archived: false
      });
    }
  }
  return sortNativeThreadCandidates([...unique.values()].map((candidate) => {
    const nativeThreadId = candidate.native_thread_id;
    const managed = managedByNativeId.get(nativeThreadId) ?? [];
    const activeElsewhere = (active.owners.get(nativeThreadId)?.length ?? 0) > 0;
    const availability = evaluateResumeCandidateAvailability({
      hasCandidateToken: Boolean(candidate.candidate_token),
      current: currentIdentity?.sessionId.toLowerCase() === nativeThreadId,
      activeElsewhere,
      activeOwnershipUnverifiable: active.uncertaintyReasons.length > 0,
      managedSessionCount: managed.length,
      managedSessionStatus: managed.length === 1 ? managed[0].status : undefined,
      managedSessionBindingInactive:
        managed.length === 1 &&
        managed[0].status === "bound" &&
        Boolean(managed[0].binding) &&
        ports.sessionOwnerIsConclusivelyInactive(
          managed[0],
          terminal,
          currentIdentity
        ),
      managedSessionWorkspaceMatches: managed.length === 1
        ? path.resolve(managed[0].workspace) === workspace
        : undefined,
      archived: candidate.archived === true
    });
    return {
      ...candidate,
      active_elsewhere: activeElsewhere,
      managed_session_id: managed.length === 1
        ? managed[0].session_id
        : undefined,
      resumable: availability.resumable,
      unavailable_reason: availability.unavailableReason,
      updated_at: Number.isFinite(candidate.updated_at_ms)
        ? new Date(Number(candidate.updated_at_ms)).toISOString()
        : undefined
    };
  }));
}

export async function revalidateNativeThreadCandidate(
  request: {
    terminal: LifecycleTerminalObservation;
    nativeThreadId: string;
    encodedToken: string;
    agentVersion: string;
  },
  ports: NativeThreadLifecycleQueryPorts
): Promise<TerminalThreadLifecycleCandidateToken> {
  const token = decodeThreadCandidateToken(request.encodedToken);
  const workspace = path.resolve(
    request.terminal.terminalControl.currentPath ?? ports.cwd()
  );
  if (
    token.agent !== request.terminal.agent ||
    token.nativeThreadId !== request.nativeThreadId ||
    path.resolve(token.cwd) !== workspace ||
    token.agentVersion !== request.agentVersion
  ) {
    throw new Error(
      "the resume candidate token does not match this terminal, workspace, " +
      "agent version, or native thread"
    );
  }
  const validation = await ports.candidateProvider(request.terminal.agent)
    .revalidateThreadLifecycleCandidate(token, {
      cwd: workspace,
      agentVersion: request.agentVersion
    });
  if (validation.status !== "valid") {
    throw new Error(
      "resume candidate changed or became unsafe after discovery: " +
      `${validation.reason ?? validation.status}`
    );
  }
  return token;
}

export function assertRestorableOriginSessionRelationship(
  request: {
    agent: ExecutorKind;
    nativeThreadId: string;
    currentSession?: ManagedSessionState;
  },
  ports: NativeThreadLifecycleQueryPorts
): void {
  const claimingSessions = ports.listManagedSessions().filter((session) =>
    session.agent === request.agent &&
    session.binding?.native_thread_id?.toLowerCase() === request.nativeThreadId
  );
  if (request.currentSession) {
    if (
      claimingSessions.length !== 1 ||
      claimingSessions[0].session_id !== request.currentSession.session_id
    ) {
      throw new Error(
        "the current native thread is not owned exclusively by its source Session"
      );
    }
    const blockers = ports.blockingTurns(request.currentSession.session_id);
    if (blockers.length > 0) {
      throw new Error(
        `the source Session has unresolved Turn ${blockers[0].turnId}`
      );
    }
    return;
  }
  if (claimingSessions.length !== 0) {
    throw new Error(
      "the unmanaged native thread is already claimed by a managed Session"
    );
  }
}

export async function requireRestorableLifecycleOrigin(
  request: {
    terminal: LifecycleTerminalObservation;
    currentIdentity: NativeThreadLifecycleIdentity;
    currentSession?: ManagedSessionState;
    agentVersion: string;
  },
  ports: NativeThreadLifecycleQueryPorts
): Promise<string> {
  const nativeThreadId = request.currentIdentity.sessionId.toLowerCase();
  const failure =
    "--require-restorable-origin could not prove that the current native " +
    "thread is a unique persisted resume candidate";
  try {
    if (!isExactNativeThreadId(nativeThreadId)) {
      throw new Error("the current native thread identity is not exact");
    }
    assertRestorableOriginSessionRelationship({
      agent: request.terminal.agent,
      nativeThreadId,
      currentSession: request.currentSession
    }, ports);
    await assertNativeThreadHasExclusiveOwnership({
      terminalControl: request.terminal.terminalControl,
      agent: request.terminal.agent,
      currentPid: request.terminal.pid,
      nativeThreadId,
      excludedManagedSessionId: request.currentSession?.session_id
    }, ports);
    const candidates = await resumableNativeThreadCandidates({
      terminal: request.terminal,
      currentIdentity: request.currentIdentity
    }, ports);
    const exactCandidates = candidates.filter(
      (candidate) => candidate.native_thread_id === nativeThreadId
    );
    if (exactCandidates.length !== 1) {
      throw new Error(
        `expected one exact candidate for ${nativeThreadId}, found ` +
        String(exactCandidates.length)
      );
    }
    const candidate = exactCandidates[0];
    const encodedToken = stringValue(candidate.candidate_token);
    if (!encodedToken) {
      throw new Error("the exact candidate has no revalidation token");
    }
    if (candidate.active_elsewhere !== false) {
      throw new Error("the exact candidate is active in another process");
    }
    if (
      candidate.resumable !== false ||
      candidate.unavailable_reason !== "already_active"
    ) {
      throw new Error(
        "the exact candidate is not the currently active native thread"
      );
    }
    if (
      (candidate.managed_session_id ?? undefined) !==
      request.currentSession?.session_id
    ) {
      throw new Error(
        "the exact candidate does not have the source Session relationship"
      );
    }
    await revalidateNativeThreadCandidate({
      terminal: request.terminal,
      nativeThreadId,
      encodedToken,
      agentVersion: request.agentVersion
    }, ports);
    return encodedToken;
  } catch (error) {
    throw new Error(
      `${failure}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function previousCommittedResumeCandidate(
  request: {
    terminal: LifecycleTerminalObservation;
    currentSession?: ManagedSessionState;
    candidates: NativeThreadCandidate[];
  },
  ports: NativeThreadLifecycleQueryPorts
): NativeThreadCandidate | undefined {
  if (!request.currentSession?.last_transition_id) return undefined;
  let transition: NativeThreadTransition;
  try {
    transition = ports.loadNativeThreadTransition(
      request.currentSession.last_transition_id
    );
  } catch {
    return undefined;
  }
  return verifiedPreviousResumeCandidate({
    terminalId: request.terminal.conversationId,
    agent: request.terminal.agent,
    workspace: request.terminal.terminalControl.currentPath ?? ports.cwd(),
    currentSession: request.currentSession,
    transition,
    candidates: request.candidates
  });
}
