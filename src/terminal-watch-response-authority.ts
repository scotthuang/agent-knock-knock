/** Exact Watch responder arbitration; managed Turn and Watch ownership remain distinct. */
import path from "node:path";
import type { ExecutorKind } from "./executors.js";
import { executorForConversation, turnIdForConversation, type Conversation } from "./protocol.js";
import {
  selectTerminalInteractionResponder,
  type TerminalInteractionResponderClaim
} from "./terminal-interaction-authority.js";
import { validateAnyTerminalInteractionProjection } from "./terminal-interaction-protocol.js";
import {
  createTerminalWatchStore,
  isTerminalActivityWatch,
  isUserExplicitFallbackWatch,
  type TerminalWatch
} from "./terminal-watch-store.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import type {
  TerminalWatchCliOptions,
  TerminalWatchCliDependencies
} from "./terminal-watch-cli-contract.js";
import {
  terminalControlForWatch,
  terminalWatchCandidateMatchesLiveContext,
  sha256
} from "./terminal-watch-terminal-identity.js";

export function terminalWatchResponseDecision(
  watch: TerminalWatch,
  rawTerminal: Record<string, unknown>,
  surfaceId: string,
  promptFingerprint: string,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): { executable: boolean; suppress: boolean } {
  if (
    watch.status !== "active" ||
    watch.interaction_policy !== "respond_when_exact" ||
    isTerminalActivityWatch(watch) ||
    !terminalWatchCandidateMatchesLiveContext(watch, rawTerminal) ||
    (watch.callback_route !== undefined &&
      watch.callback_route.capabilities?.respond !== true)
  ) {
    return { executable: false, suppress: false };
  }
  const terminalControl = terminalControlForWatch(rawTerminal);
  let blockers: Conversation[];
  try {
    blockers = dependencies.terminalIncarnationBlockingTurns(
      dependencies.storeDirFromOptions(options),
      terminalControl
    );
  } catch {
    return { executable: false, suppress: false };
  }
  let storedWatches: TerminalWatch[];
  try {
    storedWatches = createTerminalWatchStore(
      dependencies.storeDirFromOptions(options),
      { acquire: dependencies.acquireFileLock }
    ).list();
  } catch {
    return { executable: false, suppress: false };
  }
  const currentIndex = storedWatches.findIndex((candidate) =>
    candidate.watch_id === watch.watch_id);
  if (currentIndex < 0) {
    storedWatches.push(watch);
  } else {
    storedWatches[currentIndex] = watch;
  }
  const candidates = storedWatches.flatMap((candidate) => {
    const surfaceCandidate = terminalWatchSurfaceCandidate(
      candidate,
      watch,
      rawTerminal,
      surfaceId,
      promptFingerprint
    );
    return surfaceCandidate ? [surfaceCandidate] : [];
  });
  const fences = [
    ...blockers.flatMap((turn) => {
      const fence = managedTerminalInteractionFence(
        turn,
        surfaceId,
        promptFingerprint,
        watch.agent
      );
      return fence ? [fence] : [];
    }),
    ...candidates
      .filter((candidate) => candidate.disposition === "fence")
      .map((candidate) => ({
        owner_session: candidate.watch.openclaw_session
      }))
  ];
  if (fences.length > 0) {
    return {
      executable: false,
      suppress: fences.some((fence) =>
        fence.owner_session === watch.openclaw_session)
    };
  }
  const claims: TerminalInteractionResponderClaim[] = [
    ...blockers.flatMap((turn) => {
      const claim = managedTerminalInteractionResponderClaim(
        turn,
        surfaceId,
        promptFingerprint,
        watch.agent
      );
      return claim ? [claim] : [];
    }),
    ...candidates
      .filter((candidate) => candidate.disposition === "responder")
      .map(({ watch: candidate }) => ({
        owner_id: candidate.watch_id,
        owner_session: candidate.openclaw_session,
        surface_id: surfaceId,
        responder_class: isUserExplicitFallbackWatch(candidate)
          ? "exact_request_watch" as const
          : "exact_task_watch" as const,
        response_authority: "executable" as const,
        created_at: candidate.created_at
      }))
  ];
  const winner = selectTerminalInteractionResponder(claims);
  const executable = winner?.owner_id === watch.watch_id;
  return {
    executable,
    suppress: Boolean(
      winner &&
      !executable &&
      winner.owner_session === watch.openclaw_session
    )
  };
}

interface TerminalWatchSurfaceCandidate {
  watch: TerminalWatch;
  disposition: "responder" | "fence";
}

function terminalWatchSurfaceCandidate(
  candidate: TerminalWatch,
  current: TerminalWatch,
  rawTerminal: Record<string, unknown>,
  surfaceId: string,
  promptFingerprint: string
): TerminalWatchSurfaceCandidate | undefined {
  if (
    candidate.status !== "active" ||
    candidate.interaction_policy !== "respond_when_exact" ||
    isTerminalActivityWatch(candidate) ||
    candidate.terminal.terminal_id !== current.terminal.terminal_id ||
    !terminalWatchCandidateMatchesLiveContext(candidate, rawTerminal) ||
    (candidate.callback_route !== undefined &&
      candidate.callback_route.capabilities?.respond !== true)
  ) {
    return undefined;
  }
  const persisted = candidate.current_interaction;
  const samePersistedSurface = Boolean(
    persisted &&
    persisted.projection.surface_id === surfaceId &&
    persisted.projection.prompt_fingerprint === promptFingerprint
  );
  if (candidate.watch_id !== current.watch_id) {
    if (
      !samePersistedSurface ||
      !terminalWatchesShareExactTask(candidate, current) ||
      (
        persisted!.aggregate.state === "pending" &&
        (
          persisted!.projection.response_authority !== "executable" ||
          persisted!.projection.capabilities.respond !== true ||
          persisted!.aggregate.response_authority !== "executable"
        )
      )
    ) {
      return undefined;
    }
  }
  return {
    watch: candidate,
    disposition: samePersistedSurface && persisted!.aggregate.state !== "pending"
      ? "fence"
      : "responder"
  };
}

function terminalWatchesShareExactTask(
  left: TerminalWatch,
  right: TerminalWatch
): boolean {
  const leftKey = terminalWatchExactTaskKey(left);
  const rightKey = terminalWatchExactTaskKey(right);
  return leftKey !== undefined && leftKey === rightKey;
}

function terminalWatchExactTaskKey(watch: TerminalWatch): string | undefined {
  const anchor = watch.anchor;
  if (anchor.schema === "agent-knock-knock/codex-paginated-task-anchor") {
    const checkpoint = watch.observation_checkpoint;
    const turnId = "schema" in checkpoint && checkpoint.schema === "agent-knock-knock/codex-paginated-task-checkpoint"
      ? checkpoint.acceptance_evidence?.acceptanceId ?? anchor.turn_id : anchor.turn_id;
    return turnId ? sha256({ source: "codex_paginated", thread: anchor.native_thread_id,
      task: turnId, home: anchor.codex_home, process: anchor.process_uuid }) : undefined;
  }
  if (
    anchor.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
  ) {
    return codexWatchTaskKey({
      taskId: anchor.turn_id,
      nativeSessionId: anchor.native_thread_id,
      processUuid: anchor.process_uuid,
      processBirth: anchor.process_birth,
      rollout: anchor.rollout,
      requestHash: anchor.request_hash
    });
  }
  if (
    anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    const checkpoint = watch.observation_checkpoint;
    if (
      !("schema" in checkpoint) ||
      checkpoint.schema !==
        "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint" ||
      !checkpoint.accepted_identity ||
      !checkpoint.acceptance_evidence
    ) return undefined;
    return codexWatchTaskKey({
      taskId: checkpoint.acceptance_evidence.acceptanceId,
      nativeSessionId: checkpoint.accepted_identity.native_thread_id,
      processUuid: checkpoint.accepted_identity.process_uuid,
      processBirth: checkpoint.accepted_identity.process_birth,
      rollout: checkpoint.accepted_identity.rollout,
      requestHash: anchor.request_hash
    });
  }
  if (
    anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    return claudeWatchTaskKey({
      taskId: anchor.prompt_uuid,
      nativeSessionId: anchor.session_id,
      pid: anchor.pid,
      agentStartedAtMs: anchor.agent_started_at_ms,
      transcriptFileId: anchor.transcript_file_id,
      cwd: anchor.cwd,
      requestHash: anchor.request_hash
    });
  }
  if (
    anchor.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  ) {
    const checkpoint = watch.observation_checkpoint;
    if (
      !("schema" in checkpoint) ||
      checkpoint.schema !==
        "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint" ||
      !checkpoint.accepted_prompt_uuid ||
      !checkpoint.acceptance_evidence
    ) return undefined;
    const transcriptFileId = stringValue(
      checkpoint.acceptance_evidence.metadata?.transcript_file_id
    );
    if (!transcriptFileId) return undefined;
    return claudeWatchTaskKey({
      taskId: checkpoint.accepted_prompt_uuid,
      nativeSessionId: anchor.transcript_anchor.session_id,
      pid: anchor.transcript_anchor.pid,
      agentStartedAtMs: anchor.transcript_anchor.agent_started_at_ms,
      transcriptFileId,
      cwd: anchor.transcript_anchor.cwd,
      requestHash: anchor.request_hash
    });
  }
  return undefined;
}

function codexWatchTaskKey(input: {
  taskId: string;
  nativeSessionId: string;
  processUuid: string;
  processBirth: string;
  rollout: unknown;
  requestHash: string;
}): string | undefined {
  const rollout = isRecord(input.rollout) ? input.rollout : undefined;
  const device = stringValue(rollout?.device);
  const inode = stringValue(rollout?.inode);
  const rolloutPath = stringValue(rollout?.path);
  if (!device || !inode || !rolloutPath) return undefined;
  return sha256({
    agent: "codex",
    task_id: input.taskId,
    native_session_id: input.nativeSessionId.toLowerCase(),
    process_uuid: input.processUuid,
    process_birth: input.processBirth,
    rollout: { device, inode, path: rolloutPath },
    request_hash: input.requestHash
  });
}

function claudeWatchTaskKey(input: {
  taskId: string;
  nativeSessionId: string;
  pid: number;
  agentStartedAtMs: number;
  transcriptFileId: string;
  cwd: string;
  requestHash: string;
}): string | undefined {
  if (
    !Number.isSafeInteger(input.pid) || input.pid <= 0 ||
    !Number.isSafeInteger(input.agentStartedAtMs) ||
    input.agentStartedAtMs <= 0
  ) return undefined;
  return sha256({
    agent: "claude",
    task_id: input.taskId,
    native_session_id: input.nativeSessionId,
    pid: input.pid,
    agent_started_at_ms: input.agentStartedAtMs,
    transcript_file_id: input.transcriptFileId,
    cwd: input.cwd,
    request_hash: input.requestHash
  });
}

function managedTerminalInteractionFence(
  turn: Conversation,
  surfaceId: string,
  promptFingerprint: string,
  agent: ExecutorKind
): { owner_session: string } | undefined {
  const ownerSession = stringValue(turn.openclaw_session);
  const takeover = isRecord(turn.native_session_takeover)
    ? turn.native_session_takeover
    : undefined;
  if (
    ownerSession &&
    executorForConversation(turn).kind === agent &&
    stringValue(takeover?.terminal_bridge_last_interaction_surface_id) ===
      surfaceId &&
    stringValue(takeover?.terminal_bridge_last_interaction_fingerprint) ===
      promptFingerprint &&
    stringValue(takeover?.terminal_bridge_last_interaction_id) !== undefined &&
    canonicalTimestamp(
      takeover?.terminal_bridge_last_interaction_at
    ) !== undefined
  ) {
    return { owner_session: ownerSession };
  }
  const evidence = managedTerminalInteractionEvidence(
    turn,
    surfaceId,
    promptFingerprint,
    agent
  );
  if (!evidence) return undefined;
  const dispatch = isRecord(
    evidence.takeover.terminal_bridge_interaction_dispatch
  )
    ? evidence.takeover.terminal_bridge_interaction_dispatch
    : undefined;
  const dispatchState = stringValue(dispatch?.state);
  const dispatchMatches =
    (dispatchState === "reserved" || dispatchState === "uncertain") &&
    stringValue(dispatch?.interaction_id) ===
      evidence.projection.interaction_id &&
    stringValue(dispatch?.interaction_prompt_fingerprint) ===
      promptFingerprint;
  return evidence.projection.state === "response_uncertain" || dispatchMatches
    ? { owner_session: evidence.ownerSession }
    : undefined;
}

function canonicalTimestamp(value: unknown): string | undefined {
  const timestamp = stringValue(value);
  return timestamp &&
      Number.isFinite(Date.parse(timestamp)) &&
      new Date(timestamp).toISOString() === timestamp
    ? timestamp
    : undefined;
}

function managedTerminalInteractionResponderClaim(
  turn: Conversation,
  surfaceId: string,
  promptFingerprint: string,
  agent: ExecutorKind
): TerminalInteractionResponderClaim | undefined {
  const evidence = managedTerminalInteractionEvidence(
    turn,
    surfaceId,
    promptFingerprint,
    agent
  );
  if (!evidence) return undefined;
  const createdAt = stringValue(evidence.notification.notified_at);
  if (
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) return undefined;
  if (
    evidence.projection.state !== "pending" ||
    evidence.projection.capabilities.respond !== true
  ) {
    return undefined;
  }
  return {
    owner_id: evidence.ownerId,
    owner_session: evidence.ownerSession,
    surface_id: surfaceId,
    responder_class: "managed_turn",
    response_authority: "executable",
    created_at: createdAt
  };
}

function managedTerminalInteractionEvidence(
  turn: Conversation,
  surfaceId: string,
  promptFingerprint: string,
  agent: ExecutorKind
): {
  ownerId: string;
  ownerSession: string;
  takeover: Record<string, unknown>;
  notification: Record<string, unknown>;
  projection: ReturnType<typeof validateAnyTerminalInteractionProjection>;
} | undefined {
  const takeover = isRecord(turn.native_session_takeover)
    ? turn.native_session_takeover
    : undefined;
  const notification = isRecord(
    takeover?.terminal_bridge_interaction_notification
  )
    ? takeover.terminal_bridge_interaction_notification
    : undefined;
  if (
    !takeover ||
    !notification ||
    stringValue(notification.surface_id) !== surfaceId ||
    stringValue(notification.prompt_fingerprint) !== promptFingerprint
  ) return undefined;
  let ownerId: string;
  try {
    ownerId = turnIdForConversation(turn);
  } catch {
    return undefined;
  }
  const ownerSession = stringValue(turn.openclaw_session);
  if (!ownerSession) return undefined;
  const projection = (() => {
    try {
      return validateAnyTerminalInteractionProjection(
        notification.interaction_state
      );
    } catch {
      return undefined;
    }
  })();
  if (
    !projection ||
    projection.interaction_id !== stringValue(notification.interaction_id) ||
    projection.agent !== agent ||
    projection.questions.length !== 1 ||
    projection.questions[0]?.question_id !==
      stringValue(notification.question_id) ||
    (
      projection.version === 1
        ? projection.turn_id !== ownerId
        : projection.subject.kind !== "managed_turn" ||
          projection.subject.turn_id !== ownerId
    )
  ) return undefined;
  return { ownerId, ownerSession, takeover, notification, projection };
}
