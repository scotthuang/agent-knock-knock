import type {
  LifecycleMatrixResult,
  LifecycleScenarioResult,
  LifecycleTerminalEvidence
} from "./live-lifecycle-smoke.js";
import type {
  RawLiveLifecycleEvidenceInput,
  RawLiveLifecycleScenarioResult,
  RawLiveLifecycleSnapshot
} from "./live-lifecycle-evidence.js";

export interface LifecycleSmokeSourceIdentity {
  packageName: string;
  packageVersion: string;
  commit: string;
}

/**
 * Convert the in-memory core result to the evidence builder's strict raw
 * allowlist. Terminal paths used by the monitor are intentionally not copied.
 */
export function lifecycleMatrixToEvidenceInput(
  matrix: LifecycleMatrixResult,
  source: LifecycleSmokeSourceIdentity
): RawLiveLifecycleEvidenceInput {
  const scenarios: RawLiveLifecycleEvidenceInput["scenarios"] = {};
  for (const scenario of matrix.scenarios) {
    scenarios[scenario.agent] = lifecycleScenarioToEvidenceInput(scenario);
  }
  return {
    packageName: source.packageName,
    packageVersion: source.packageVersion,
    commit: source.commit,
    worktreeClean: true,
    startedAt: isoTimestamp(matrix.started_at_ms),
    completedAt: isoTimestamp(matrix.finished_at_ms),
    scenarios
  };
}

export function lifecycleScenarioToEvidenceInput(
  scenario: LifecycleScenarioResult
): RawLiveLifecycleScenarioResult {
  const startSessionId =
    scenario.start?.session_id ?? scenario.new_thread?.previous_session_id;
  const startBindingId =
    scenario.start?.binding_id ?? scenario.start?.binding_fence;
  const before = snapshotEvidence({
    snapshot: scenario.start,
    sessionId: startSessionId,
    bindingId: startBindingId,
    target: scenario.target,
    panePid: scenario.pane_pid
  });
  const afterNew = snapshotEvidence({
    snapshot: scenario.active_after_new,
    target: scenario.target,
    panePid: scenario.pane_pid
  });
  const afterResume = snapshotEvidence({
    snapshot: scenario.final,
    target: scenario.target,
    panePid: scenario.pane_pid
  });
  const steps = scenario.steps.map((step) => ({
    name: step.name,
    status: step.status,
    durationMs: step.duration_ms
  }));
  const failureStage = scenario.status === "passed"
    ? undefined
    : steps.at(-1)?.name ?? "preflight";
  const result: RawLiveLifecycleScenarioResult = {
    status: scenario.status,
    ...(scenario.status === "passed"
      ? {}
      : {
          failureStage,
          reasonCode: scenario.error_code ?? "runner_incomplete",
          ...(scenario.status === "uncertain" ? { doNotRetry: true as const } : {})
        }),
    ...(scenario.start?.agent_version
      ? { agentVersion: scenario.start.agent_version }
      : {}),
    tmuxTarget: scenario.target,
    panePid: scenario.pane_pid,
    startedAt: isoTimestamp(scenario.started_at_ms),
    completedAt: isoTimestamp(scenario.finished_at_ms),
    ...(before ? { before } : {}),
    ...(afterNew ? { afterNew } : {}),
    ...(afterResume ? { afterResume } : {}),
    ...(scenario.resume_candidate
      ? {
          resumeCandidate: {
            nativeThreadId: scenario.resume_candidate.native_thread_id,
            exactCandidateCount:
              scenario.resume_candidate.exact_candidate_count,
            resumable: scenario.resume_candidate.resumable,
            activeElsewhere: scenario.resume_candidate.active_elsewhere,
            freshCandidateTokenPresent:
              scenario.resume_candidate.fresh_candidate_token_present
          }
        }
      : {}),
    ...(scenario.turn && afterNew
      ? {
          send: {
            status: "completed" as const,
            turnId: scenario.turn.turn_id,
            sessionId: scenario.turn.session_id,
            bindingId: afterNew.bindingId,
            bindingGeneration: afterNew.bindingGeneration
          }
        }
      : {}),
    ...transitionEvidence(scenario, before, afterNew, afterResume),
    turnDeltas: {
      ...(scenario.active_after_new
        ? { newThread: scenario.active_after_new.turn_count }
        : {}),
      ...(scenario.turn
        ? {
            send:
              scenario.turn.turn_count_after -
              scenario.turn.turn_count_before
          }
        : {}),
      ...(scenario.start && scenario.final
        ? {
            resumeThread:
              scenario.final.turn_count - scenario.start.turn_count
          }
        : {})
    },
    steps
  };
  return result;
}

function transitionEvidence(
  scenario: LifecycleScenarioResult,
  before: RawLiveLifecycleSnapshot | undefined,
  afterNew: RawLiveLifecycleSnapshot | undefined,
  afterResume: RawLiveLifecycleSnapshot | undefined
): Pick<RawLiveLifecycleScenarioResult, "transitions"> | Record<string, never> {
  const transitions: NonNullable<RawLiveLifecycleScenarioResult["transitions"]> = {};
  if (scenario.new_thread && before && afterNew) {
    transitions.newThread = {
      transitionId: scenario.new_thread.transition_id,
      status: "committed",
      sourceSessionId: before.sessionId,
      targetSessionId: afterNew.sessionId,
      sourceBindingId: before.bindingId,
      targetBindingId: afterNew.bindingId
    };
  }
  if (scenario.resume_thread && afterNew && afterResume) {
    transitions.resumeThread = {
      transitionId: scenario.resume_thread.transition_id,
      status: "committed",
      sourceSessionId: afterNew.sessionId,
      targetSessionId: afterResume.sessionId,
      sourceBindingId: afterNew.bindingId,
      targetBindingId: afterResume.bindingId
    };
  }
  return Object.keys(transitions).length > 0 ? { transitions } : {};
}

function snapshotEvidence({
  snapshot,
  sessionId = snapshot?.session_id,
  bindingId = snapshot?.binding_id,
  target,
  panePid
}: {
  snapshot?: LifecycleTerminalEvidence;
  sessionId?: string | null;
  bindingId?: string | null;
  target: string;
  panePid: number;
}): RawLiveLifecycleSnapshot | undefined {
  if (!snapshot || !sessionId || !bindingId) {
    return undefined;
  }
  return {
    tmuxTarget: target,
    panePid,
    agentPid: snapshot.agent_pid,
    processUuid: snapshot.process_uuid,
    ...(snapshot.process_birth
      ? { processBirth: snapshot.process_birth }
      : {}),
    workspace: snapshot.workspace,
    nativeThreadId: snapshot.native_thread_id,
    sessionId,
    bindingId,
    bindingGeneration: snapshot.binding_generation,
    idle: true
  };
}

function isoTimestamp(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) {
    throw new Error("live lifecycle runner produced an invalid timestamp");
  }
  return new Date(milliseconds).toISOString();
}
