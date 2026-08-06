import { randomUUID } from "node:crypto";

export type LifecycleSmokeAgent = "codex" | "claude";
export type LifecycleSmokeStatus = "passed" | "failed" | "uncertain";
export type AkkInvocationKind = "read" | "mutation";
export type AkkClientFailureKind =
  | "timeout"
  | "nonzero"
  | "malformed"
  | "transport";

export interface AkkInvocationOptions {
  kind: AkkInvocationKind;
  timeoutMs: number;
}

/**
 * Public-command boundary used by the live runner. Implementations must not
 * retry commands. They return parsed JSON or throw an AkkClientInvocationError.
 */
export interface AkkClient {
  invoke(
    command: string,
    args: readonly string[],
    options: AkkInvocationOptions
  ): Promise<unknown>;
}

export class AkkClientInvocationError extends Error {
  readonly failureKind: AkkClientFailureKind;

  constructor(failureKind: AkkClientFailureKind) {
    super(`AKK invocation ${failureKind}`);
    this.name = "AkkClientInvocationError";
    this.failureKind = failureKind;
  }
}

export interface LifecycleSmokeTimeouts {
  readMs: number;
  mutationMs: number;
  completionMs: number;
  monitorPollIntervalMs: number;
  agentInactivityMinutes: number;
  agentHardTimeoutMinutes: number;
}

export interface LifecycleScenarioConfig {
  agent: LifecycleSmokeAgent;
  target: string;
  expectedPanePid: number;
  /** Exact version explicitly approved by the maintainer for this run. */
  expectedAgentVersion: string;
  timeouts?: Partial<LifecycleSmokeTimeouts>;
}

export interface LifecycleSmokeDependencies {
  client: AkkClient;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  nonce?: () => string;
}

export type LifecycleSmokeStepName =
  | "preflight"
  | "new_thread"
  | "send"
  | "wait_completion"
  | "list_resumable_threads"
  | "resume_thread"
  | "final_verify";

export interface LifecycleSmokeStepResult {
  name: LifecycleSmokeStepName;
  status: LifecycleSmokeStatus;
  duration_ms: number;
}

export interface LifecycleTerminalEvidence {
  terminal_id: string;
  agent_pid: number;
  process_uuid: string;
  process_birth: string | null;
  workspace: string;
  native_thread_id: string;
  session_id: string | null;
  binding_id: string | null;
  binding_generation: number;
  /** Exact current binding fence; the evidence layer must fingerprint it. */
  binding_fence: string;
  turn_count: number;
  agent_version: string;
  behavior_profile: string;
}

export interface LifecycleTransitionEvidence {
  terminal_id: string;
  transition_id: string;
  operation: "new_thread" | "resume_thread";
  previous_session_id: string;
  session_id: string;
  previous_native_thread_id: string;
  native_thread_id: string;
  binding_id: string;
  binding_generation: number;
  turn_created: false;
}

export interface LifecycleTurnEvidence {
  session_id: string;
  turn_id: string;
  status: "idle";
  turn_count_before: number;
  turn_count_after: number;
}

export interface LifecycleResumeCandidateEvidence {
  native_thread_id: string;
  exact_candidate_count: 1;
  resumable: true;
  active_elsewhere: false;
  fresh_candidate_token_present: true;
}

export type LifecycleSmokeErrorCode =
  | "configuration_invalid"
  | "client_timeout"
  | "client_nonzero"
  | "client_malformed"
  | "client_transport"
  | "client_error"
  | "preflight_terminal_match"
  | "preflight_terminal_identity"
  | "preflight_agent_version"
  | "preflight_capability"
  | "preflight_process_identity"
  | "preflight_workspace"
  | "preflight_native_identity"
  | "preflight_not_idle"
  | "preflight_approval"
  | "preflight_unresolved_turn"
  | "preflight_management"
  | "preflight_action"
  | "new_thread_uncertain"
  | "new_thread_invalid"
  | "identity_drift"
  | "send_uncertain"
  | "send_invalid"
  | "monitor_uncertain"
  | "monitor_invalid"
  | "turn_verification_failed"
  | "candidate_invalid"
  | "resume_thread_uncertain"
  | "resume_thread_invalid"
  | "restore_verification_failed";

export interface LifecycleScenarioResult {
  schema: "agent-knock-knock/live-lifecycle-smoke-core-result";
  version: 1;
  agent: LifecycleSmokeAgent;
  target: string;
  pane_pid: number;
  expected_agent_version: string;
  status: LifecycleSmokeStatus;
  started_at_ms: number;
  finished_at_ms: number;
  steps: LifecycleSmokeStepResult[];
  error_code?: LifecycleSmokeErrorCode;
  recovery?: "inspect_selected_pane_do_not_retry";
  start?: LifecycleTerminalEvidence;
  new_thread?: LifecycleTransitionEvidence;
  active_after_new?: LifecycleTerminalEvidence;
  turn?: LifecycleTurnEvidence;
  resume_candidate?: LifecycleResumeCandidateEvidence;
  resume_thread?: LifecycleTransitionEvidence;
  final?: LifecycleTerminalEvidence;
}

export interface LifecycleMatrixResult {
  schema: "agent-knock-knock/live-lifecycle-smoke-core-matrix";
  version: 1;
  status: LifecycleSmokeStatus;
  started_at_ms: number;
  finished_at_ms: number;
  scenarios: LifecycleScenarioResult[];
}

const DEFAULT_TIMEOUTS: LifecycleSmokeTimeouts = {
  readMs: 60_000,
  mutationMs: 120_000,
  completionMs: 10 * 60_000,
  monitorPollIntervalMs: 500,
  agentInactivityMinutes: 5,
  agentHardTimeoutMinutes: 10
};

const NATIVE_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const UNRESOLVED_TURN_STATUSES = new Set([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "stalled",
  "callback_pending",
  "callback_failed",
  "cancelling"
]);

interface TerminalAction {
  terminalId: string;
  expectedBindingToken?: string;
  sessionId?: string;
}

interface InternalTerminalSnapshot {
  agent: LifecycleSmokeAgent;
  evidence: LifecycleTerminalEvidence;
  target: string;
  panePid: number;
  managementState: string;
  currentTurn: null;
  recentTurn?: Record<string, unknown> | null;
  newThreadAction?: TerminalAction;
  listResumableAction?: TerminalAction;
  sendAction?: TerminalAction;
}

interface ResumeCandidateAction {
  terminalId: string;
  nativeThreadId: string;
  expectedBindingToken: string;
  candidateToken: string;
  managedSessionId?: string;
  evidence: LifecycleResumeCandidateEvidence;
}

class SmokeAbort extends Error {
  readonly errorCode: LifecycleSmokeErrorCode;

  constructor(errorCode: LifecycleSmokeErrorCode) {
    super(errorCode);
    this.name = "SmokeAbort";
    this.errorCode = errorCode;
  }
}

export async function runLifecycleScenario(
  config: LifecycleScenarioConfig,
  dependencies: LifecycleSmokeDependencies
): Promise<LifecycleScenarioResult> {
  const now = dependencies.now ?? Date.now;
  // Kept injectable for callers that coordinate multiple bounded scenarios.
  // The current golden path uses one foreground monitor and therefore sleeps
  // inside AKK rather than in this orchestration layer.
  const _sleep = dependencies.sleep ?? defaultSleep;
  void _sleep;
  const nonceFactory = dependencies.nonce ?? randomUUID;
  const startedAt = safeNow(now);
  const steps: LifecycleSmokeStepResult[] = [];
  const partial: {
    start?: LifecycleTerminalEvidence;
    newThread?: LifecycleTransitionEvidence;
    activeAfterNew?: LifecycleTerminalEvidence;
    turn?: LifecycleTurnEvidence;
    resumeCandidate?: LifecycleResumeCandidateEvidence;
    resumeThread?: LifecycleTransitionEvidence;
    final?: LifecycleTerminalEvidence;
  } = {};
  let mutationAttempted = false;
  let currentStep: LifecycleSmokeStepName = "preflight";
  let currentStepStartedAt = startedAt;

  const result = (
    status: LifecycleSmokeStatus,
    errorCode?: LifecycleSmokeErrorCode
  ): LifecycleScenarioResult => ({
    schema: "agent-knock-knock/live-lifecycle-smoke-core-result",
    version: 1,
    agent: config.agent,
    target: config.target,
    pane_pid: config.expectedPanePid,
    expected_agent_version: config.expectedAgentVersion,
    status,
    started_at_ms: startedAt,
    finished_at_ms: safeNow(now),
    steps: [...steps],
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(status === "uncertain"
      ? { recovery: "inspect_selected_pane_do_not_retry" as const }
      : {}),
    ...(partial.start ? { start: partial.start } : {}),
    ...(partial.newThread ? { new_thread: partial.newThread } : {}),
    ...(partial.activeAfterNew
      ? { active_after_new: partial.activeAfterNew }
      : {}),
    ...(partial.turn ? { turn: partial.turn } : {}),
    ...(partial.resumeCandidate
      ? { resume_candidate: partial.resumeCandidate }
      : {}),
    ...(partial.resumeThread
      ? { resume_thread: partial.resumeThread }
      : {}),
    ...(partial.final ? { final: partial.final } : {})
  });

  const runStep = async <T>(
    name: LifecycleSmokeStepName,
    kind: AkkInvocationKind,
    operation: () => Promise<T>
  ): Promise<T> => {
    currentStep = name;
    currentStepStartedAt = safeNow(now);
    try {
      const value = await operation();
      steps.push({
        name,
        status: "passed",
        duration_ms: elapsed(currentStepStartedAt, safeNow(now))
      });
      return value;
    } catch (error) {
      const status: LifecycleSmokeStatus =
        mutationAttempted ? "uncertain" : "failed";
      steps.push({
        name,
        status,
        duration_ms: elapsed(currentStepStartedAt, safeNow(now))
      });
      throw new ScenarioStopped(status, errorCodeFor(error));
    }
  };

  try {
    const prepared = await runStep("preflight", "read", async () => {
      validateConfig(config);
      const timeouts = normalizedTimeouts(config.timeouts);
      const initialList = await invoke(
        dependencies.client,
        "list",
        ["--all", "--terminal-debug"],
        { kind: "read", timeoutMs: timeouts.readMs }
      );
      return {
        timeouts,
        start: selectTerminalSnapshot(initialList, config, {
          requireNewThread: true,
          requireListResumable: true,
          requireSend: false
        })
      };
    });
    const { timeouts, start } = prepared;
    partial.start = start.evidence;

    const newPhase = await runStep("new_thread", "mutation", async () => {
      const action = start.newThreadAction;
      if (!action?.expectedBindingToken) {
        abort("preflight_action");
      }
      mutationAttempted = true;
      const output = await invoke(
        dependencies.client,
        "new-thread",
        [
          "--terminal",
          action.terminalId,
          "--expected-binding-token",
          action.expectedBindingToken
        ],
        { kind: "mutation", timeoutMs: timeouts.mutationMs }
      );
      const transition = parseTransition(output, "new_thread");
      if (transition.terminal_id !== start.evidence.terminal_id) {
        abort("new_thread_invalid");
      }
      const listed = await invoke(
        dependencies.client,
        "list",
        ["--all", "--terminal-debug"],
        { kind: "read", timeoutMs: timeouts.readMs }
      );
      const snapshot = selectTerminalSnapshot(listed, config, {
        requireNewThread: false,
        requireListResumable: true,
        requireSend: true
      });
      assertSameTerminalIncarnation(start, snapshot);
      if (
        snapshot.evidence.native_thread_id === start.evidence.native_thread_id ||
        transition.previous_native_thread_id !==
          start.evidence.native_thread_id ||
        transition.native_thread_id !== snapshot.evidence.native_thread_id ||
        transition.session_id !== snapshot.evidence.session_id ||
        transition.session_id === transition.previous_session_id ||
        transition.binding_id !== snapshot.evidence.binding_id ||
        transition.binding_generation !==
          snapshot.evidence.binding_generation ||
        snapshot.evidence.binding_generation !== 1 ||
        transition.turn_created !== false ||
        snapshot.evidence.turn_count !== 0 ||
        snapshot.sendAction?.sessionId !== snapshot.evidence.session_id ||
        snapshot.evidence.binding_fence === start.evidence.binding_fence ||
        snapshot.evidence.binding_id ===
          (start.evidence.binding_id ?? start.evidence.binding_fence)
      ) {
        abort("new_thread_invalid");
      }
      if (
        start.evidence.session_id &&
        transition.previous_session_id !== start.evidence.session_id
      ) {
        abort("new_thread_invalid");
      }
      if (
        start.evidence.binding_id &&
        snapshot.evidence.binding_id === start.evidence.binding_id
      ) {
        abort("new_thread_invalid");
      }
      return { transition, snapshot };
    });
    const newThread = newPhase.transition;
    const afterNew = newPhase.snapshot;
    partial.newThread = newThread;
    partial.activeAfterNew = afterNew.evidence;

    const sent = await runStep("send", "mutation", async () => {
      const sessionId = afterNew.sendAction?.sessionId;
      if (!sessionId || sessionId !== afterNew.evidence.session_id) {
        abort("send_invalid");
      }
      const nonce = nonceFactory();
      if (typeof nonce !== "string" || nonce.trim() === "") {
        abort("configuration_invalid");
      }
      mutationAttempted = true;
      const output = await invoke(
        dependencies.client,
        "send",
        [
          "--session",
          sessionId,
          "--message",
          `AKK lifecycle smoke ${nonce}: reply with the nonce only and do not modify files.`,
          "--background",
          "--disable-terminal-bridge-monitor"
        ],
        { kind: "mutation", timeoutMs: timeouts.mutationMs }
      );
      return { ...parseSend(output, sessionId), nonce };
    });

    const monitored = await runStep("wait_completion", "mutation", async () => {
      mutationAttempted = true;
      const output = await invoke(
        dependencies.client,
        "monitor",
        [
          "--terminal-bridge",
          "--record-only",
          "--state",
          sent.statePath,
          "--log",
          sent.eventLogPath,
          "--poll-interval-ms",
          String(timeouts.monitorPollIntervalMs),
          "--agent-timeout-minutes",
          String(timeouts.agentInactivityMinutes),
          "--agent-hard-timeout-minutes",
          String(timeouts.agentHardTimeoutMinutes)
        ],
        { kind: "mutation", timeoutMs: timeouts.completionMs }
      );
      return parseMonitor(output, sent, sent.nonce);
    });

    const resumable = await runStep(
      "list_resumable_threads",
      "read",
      async () => {
      const listed = await invoke(
        dependencies.client,
        "list",
        ["--all", "--terminal-debug"],
        { kind: "read", timeoutMs: timeouts.readMs }
      );
      const snapshot = selectTerminalSnapshot(listed, config, {
        requireNewThread: false,
        requireListResumable: true,
        requireSend: true
      });
      assertSameTerminalIncarnation(afterNew, snapshot);
      if (
        snapshot.evidence.session_id !== afterNew.evidence.session_id ||
        snapshot.evidence.native_thread_id !==
          afterNew.evidence.native_thread_id ||
        snapshot.evidence.binding_id !== afterNew.evidence.binding_id ||
        snapshot.evidence.binding_generation !==
          afterNew.evidence.binding_generation ||
        snapshot.evidence.turn_count !== afterNew.evidence.turn_count + 1 ||
        !snapshot.recentTurn ||
        stringValue(snapshot.recentTurn.conversation_id) !== sent.turnId ||
        stringValue(snapshot.recentTurn.status) !== "idle"
      ) {
        abort("turn_verification_failed");
      }
      partial.turn = {
        session_id: sent.sessionId,
        turn_id: sent.turnId,
        status: monitored.status,
        turn_count_before: afterNew.evidence.turn_count,
        turn_count_after: snapshot.evidence.turn_count
      };
      const action = snapshot.listResumableAction;
      if (!action) {
        abort("candidate_invalid");
      }
      const output = await invoke(
        dependencies.client,
        "list-resumable-threads",
        ["--terminal", action.terminalId],
        { kind: "read", timeoutMs: timeouts.readMs }
      );
      const candidate = parseResumeCandidate(
        output,
        snapshot,
        start.evidence.native_thread_id,
        newThread.previous_session_id
      );
      return { snapshot, candidate };
      }
    );
    const afterTurn = resumable.snapshot;
    const candidate = resumable.candidate;
    partial.resumeCandidate = candidate.evidence;

    const resumed = await runStep("resume_thread", "mutation", async () => {
      mutationAttempted = true;
      const output = await invoke(
        dependencies.client,
        "resume-thread",
        [
          "--terminal",
          candidate.terminalId,
          "--native-thread",
          candidate.nativeThreadId,
          "--expected-binding-token",
          candidate.expectedBindingToken,
          "--candidate-token",
          candidate.candidateToken
        ],
        { kind: "mutation", timeoutMs: timeouts.mutationMs }
      );
      const transition = parseTransition(output, "resume_thread");
      if (transition.terminal_id !== afterTurn.evidence.terminal_id) {
        abort("resume_thread_invalid");
      }
      return transition;
    });
    partial.resumeThread = resumed;

    const final = await runStep("final_verify", "read", async () => {
      const listed = await invoke(
        dependencies.client,
        "list",
        ["--all", "--terminal-debug"],
        { kind: "read", timeoutMs: timeouts.readMs }
      );
      const snapshot = selectTerminalSnapshot(listed, config, {
        requireNewThread: true,
        requireListResumable: true,
        requireSend: true
      });
      assertSameTerminalIncarnation(start, snapshot);
      if (
        snapshot.evidence.native_thread_id !== start.evidence.native_thread_id ||
        resumed.previous_session_id !== afterTurn.evidence.session_id ||
        resumed.previous_native_thread_id !==
          afterTurn.evidence.native_thread_id ||
        resumed.native_thread_id !== start.evidence.native_thread_id ||
        resumed.session_id !== snapshot.evidence.session_id ||
        resumed.binding_id !== snapshot.evidence.binding_id ||
        resumed.binding_generation !== snapshot.evidence.binding_generation ||
        resumed.transition_id === newThread.transition_id ||
        resumed.turn_created !== false ||
        snapshot.evidence.binding_id === afterTurn.evidence.binding_id ||
        snapshot.evidence.binding_id ===
          (start.evidence.binding_id ?? start.evidence.binding_fence) ||
        snapshot.evidence.binding_fence === afterTurn.evidence.binding_fence ||
        snapshot.evidence.turn_count !== start.evidence.turn_count ||
        resumed.session_id !== candidate.managedSessionId
      ) {
        abort("restore_verification_failed");
      }
      if (
        resumed.session_id !== newThread.previous_session_id ||
        snapshot.evidence.session_id !== newThread.previous_session_id ||
        snapshot.evidence.binding_generation !==
          start.evidence.binding_generation + 1
      ) {
        abort("restore_verification_failed");
      }
      if (
        start.evidence.session_id &&
        newThread.previous_session_id !== start.evidence.session_id
      ) {
        abort("restore_verification_failed");
      }
      return snapshot;
    });
    partial.final = final.evidence;
    return result("passed");
  } catch (error) {
    if (error instanceof ScenarioStopped) {
      return result(error.status, error.errorCode);
    }
    const status: LifecycleSmokeStatus = mutationAttempted
      ? "uncertain"
      : "failed";
    if (!steps.some((step) => step.name === currentStep)) {
      steps.push({
        name: currentStep,
        status,
        duration_ms: elapsed(currentStepStartedAt, safeNow(now))
      });
    }
    return result(status, errorCodeFor(error));
  }
}

export async function runLifecycleMatrix(
  configs: readonly LifecycleScenarioConfig[],
  dependencies: LifecycleSmokeDependencies
): Promise<LifecycleMatrixResult> {
  const now = dependencies.now ?? Date.now;
  const startedAt = safeNow(now);
  if (!matrixPanesAreExplicitlyDistinct(configs)) {
    const scenarios = configs.map((config): LifecycleScenarioResult => {
      const scenarioStartedAt = safeNow(now);
      const scenarioFinishedAt = safeNow(now);
      return {
        schema: "agent-knock-knock/live-lifecycle-smoke-core-result",
        version: 1,
        agent: config.agent,
        target: config.target,
        pane_pid: config.expectedPanePid,
        expected_agent_version: config.expectedAgentVersion,
        status: "failed",
        started_at_ms: scenarioStartedAt,
        finished_at_ms: scenarioFinishedAt,
        steps: [{
          name: "preflight",
          status: "failed",
          duration_ms: elapsed(scenarioStartedAt, scenarioFinishedAt)
        }],
        error_code: "configuration_invalid"
      };
    });
    return {
      schema: "agent-knock-knock/live-lifecycle-smoke-core-matrix",
      version: 1,
      status: "failed",
      started_at_ms: startedAt,
      finished_at_ms: safeNow(now),
      scenarios
    };
  }
  const scenarios: LifecycleScenarioResult[] = [];
  for (const config of configs) {
    scenarios.push(await runLifecycleScenario(config, dependencies));
  }
  const status: LifecycleSmokeStatus = scenarios.some((entry) =>
    entry.status === "uncertain"
  )
    ? "uncertain"
    : scenarios.length > 0 && scenarios.every((entry) =>
        entry.status === "passed"
      )
      ? "passed"
      : "failed";
  return {
    schema: "agent-knock-knock/live-lifecycle-smoke-core-matrix",
    version: 1,
    status,
    started_at_ms: startedAt,
    finished_at_ms: safeNow(now),
    scenarios
  };
}

function matrixPanesAreExplicitlyDistinct(
  configs: readonly LifecycleScenarioConfig[]
): boolean {
  const targets = new Set<string>();
  const panePids = new Set<number>();
  for (const config of configs) {
    if (
      targets.has(config.target) ||
      panePids.has(config.expectedPanePid)
    ) {
      return false;
    }
    targets.add(config.target);
    panePids.add(config.expectedPanePid);
  }
  return true;
}

class ScenarioStopped extends Error {
  readonly status: LifecycleSmokeStatus;
  readonly errorCode: LifecycleSmokeErrorCode;

  constructor(
    status: LifecycleSmokeStatus,
    errorCode: LifecycleSmokeErrorCode
  ) {
    super(errorCode);
    this.name = "ScenarioStopped";
    this.status = status;
    this.errorCode = errorCode;
  }
}

async function invoke(
  client: AkkClient,
  command: string,
  args: readonly string[],
  options: AkkInvocationOptions
): Promise<unknown> {
  return await client.invoke(command, args, options);
}

function selectTerminalSnapshot(
  value: unknown,
  config: LifecycleScenarioConfig,
  requirements: {
    requireNewThread: boolean;
    requireListResumable: boolean;
    requireSend: boolean;
  }
): InternalTerminalSnapshot {
  const root = recordValue(value, "preflight_terminal_match");
  const terminals = Array.isArray(root.terminals) ? root.terminals : [];
  const matches = terminals.filter((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.terminal_control)) {
      return false;
    }
    return candidate.agent === config.agent &&
      candidate.terminal_control.target === config.target &&
      Number(candidate.terminal_control.panePid) === config.expectedPanePid;
  });
  if (matches.length !== 1) {
    abort("preflight_terminal_match");
  }
  const row = matches[0] as Record<string, unknown>;
  const terminalControl = recordValue(
    row.terminal_control,
    "preflight_terminal_identity"
  );
  const terminalId = requiredString(
    row.id,
    "preflight_terminal_identity"
  );
  const target = requiredString(
    terminalControl.target,
    "preflight_terminal_identity"
  );
  const panePid = positiveInteger(
    terminalControl.panePid,
    "preflight_terminal_identity"
  );
  if (
    row.source !== "terminal" ||
    row.agent !== config.agent ||
    row.process_state !== "active" ||
    target !== config.target ||
    panePid !== config.expectedPanePid
  ) {
    abort("preflight_terminal_identity");
  }
  const agentPid = positiveInteger(row.pid, "preflight_process_identity");
  const agentVersion = requiredString(
    row.agent_version,
    "preflight_agent_version"
  );
  if (agentVersion !== config.expectedAgentVersion) {
    abort("preflight_agent_version");
  }
  const lifecycle = recordValue(
    row.native_thread_lifecycle,
    "preflight_capability"
  );
  if (
    lifecycle.status !== "supported" ||
    lifecycle.agentVersion !== agentVersion ||
    lifecycle.newThread !== true ||
    lifecycle.resumeExact !== true ||
    lifecycle.candidateDiscovery !== true
  ) {
    abort("preflight_capability");
  }
  const behaviorProfile = requiredString(
    lifecycle.behaviorProfile,
    "preflight_capability"
  );
  const processUuid = requiredString(
    row.native_agent_process_uuid,
    "preflight_process_identity"
  );
  const processBirth = nullableString(
    row.native_agent_process_birth,
    "preflight_process_identity"
  );
  if (config.agent === "codex" && processBirth === null) {
    abort("preflight_process_identity");
  }
  const workspace = requiredString(
    row.workspace ?? row.cwd,
    "preflight_workspace"
  );
  const nativeThreadId = exactNativeThreadId(
    row.native_agent_session_id,
    "preflight_native_identity"
  );
  if (row.activity_state !== "idle") {
    abort("preflight_not_idle");
  }
  const approval = recordValue(row.approval_state, "preflight_approval");
  if (
    approval.scanned !== true ||
    approval.blocked !== false ||
    approval.approvable !== false
  ) {
    abort("preflight_approval");
  }
  if (
    row.unresolved_lifecycle_transition !== undefined &&
    row.unresolved_lifecycle_transition !== null
  ) {
    abort("preflight_management");
  }
  if (
    row.orphaned_terminal_dispatch !== undefined &&
    row.orphaned_terminal_dispatch !== null
  ) {
    abort("preflight_management");
  }
  const managementState = requiredString(
    row.management_state,
    "preflight_management"
  );
  if (
    managementState === "conflict" ||
    row.management_conflict !== undefined &&
      row.management_conflict !== null
  ) {
    abort("preflight_management");
  }
  const managed = recordValue(row.managed, "preflight_management");
  if (!("current_turn" in managed) || managed.current_turn !== null) {
    abort("preflight_unresolved_turn");
  }
  assertNoUnresolvedManagedTurns(managed);
  const sessionId = nullableString(managed.session_id, "preflight_management");
  const turnCount = nonNegativeInteger(
    managed.turn_count,
    "preflight_management"
  );
  let bindingId: string | null = null;
  let bindingGeneration: number | null = null;
  const bindingFence = requiredString(
    row.lifecycle_binding_token,
    "preflight_management"
  );
  if (sessionId) {
    if (
      managementState !== "managed" ||
      managed.binding_status !== "bound" ||
      managed.native_thread_id !== nativeThreadId
    ) {
      abort("preflight_management");
    }
    bindingId = requiredString(managed.binding_id, "preflight_management");
    bindingGeneration = positiveInteger(
      managed.binding_generation,
      "preflight_management"
    );
    if (
      managed.binding_token !== undefined &&
      managed.binding_token !== bindingFence
    ) {
      abort("preflight_management");
    }
  } else if (managementState !== "unmanaged") {
    abort("preflight_management");
  }

  const actions = recordValue(row.available_actions, "preflight_action");
  const newThreadAction = actionFor(actions, "new_thread", terminalId, {
    bindingToken: true,
    sessionId: false
  });
  const listResumableAction = actionFor(
    actions,
    "list_resumable_threads",
    terminalId,
    { bindingToken: false, sessionId: false }
  );
  // An unmanaged pane advertises Send with missing_required metadata, but it
  // cannot include a Session until New materializes the first binding. Do not
  // parse that intentionally incomplete action during the initial preflight.
  const sendAction = requirements.requireSend
    ? actionFor(actions, "send", terminalId, {
        bindingToken: false,
        sessionId: true
      })
    : undefined;
  if (
    (requirements.requireNewThread && !newThreadAction) ||
    (requirements.requireListResumable && !listResumableAction) ||
    (requirements.requireSend && !sendAction)
  ) {
    abort("preflight_action");
  }
  if (
    sendAction?.sessionId &&
    sessionId &&
    sendAction.sessionId !== sessionId
  ) {
    abort("preflight_action");
  }
  if (
    newThreadAction?.expectedBindingToken &&
    newThreadAction.expectedBindingToken !== bindingFence
  ) {
    abort("preflight_action");
  }

  return {
    agent: config.agent,
    evidence: {
      terminal_id: terminalId,
      agent_pid: agentPid,
      process_uuid: processUuid,
      process_birth: processBirth,
      workspace,
      native_thread_id: nativeThreadId,
      session_id: sessionId,
      binding_id: bindingId,
      // The first materialized binding generation is contractually one. An
      // unmanaged starting pane has not persisted that binding yet, but the
      // advertised lifecycle fence is the exact pre-materialization fence.
      binding_generation: bindingGeneration ?? 1,
      binding_fence: bindingFence,
      turn_count: turnCount,
      agent_version: agentVersion,
      behavior_profile: behaviorProfile
    },
    target,
    panePid,
    managementState,
    currentTurn: null,
    recentTurn: isRecord(managed.recent_turn)
      ? managed.recent_turn
      : managed.recent_turn === null
        ? null
        : undefined,
    ...(newThreadAction ? { newThreadAction } : {}),
    ...(listResumableAction ? { listResumableAction } : {}),
    ...(sendAction ? { sendAction } : {})
  };
}

function actionFor(
  actions: Record<string, unknown>,
  name: string,
  terminalId: string,
  requirements: { bindingToken: boolean; sessionId: boolean }
): TerminalAction | undefined {
  const value = actions[name];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.arguments)) {
    abort("preflight_action");
  }
  const actionTerminalId = requirements.sessionId
    ? terminalId
    : requiredString(value.arguments.terminal_id, "preflight_action");
  if (!requirements.sessionId && actionTerminalId !== terminalId) {
    abort("preflight_action");
  }
  const expectedBindingToken = requirements.bindingToken
    ? requiredString(
        value.arguments.expected_binding_token,
        "preflight_action"
      )
    : undefined;
  const sessionId = requirements.sessionId
    ? requiredString(value.arguments.session_id, "preflight_action")
    : undefined;
  return {
    terminalId: actionTerminalId,
    ...(expectedBindingToken ? { expectedBindingToken } : {}),
    ...(sessionId ? { sessionId } : {})
  };
}

function assertNoUnresolvedManagedTurns(
  managed: Record<string, unknown>
): void {
  const recent = managed.recent_turn;
  if (recent !== null && recent !== undefined && !isRecord(recent)) {
    abort("preflight_unresolved_turn");
  }
  const history = managed.history;
  if (!Array.isArray(history)) {
    // Every smoke list uses --all, whose public contract includes history.
    abort("preflight_unresolved_turn");
  }
  const visible = [
    ...(isRecord(recent) ? [recent] : []),
    ...history
  ];
  for (const candidate of visible) {
    if (!isRecord(candidate)) {
      abort("preflight_unresolved_turn");
    }
    const status = requiredString(
      candidate.status,
      "preflight_unresolved_turn"
    );
    if (UNRESOLVED_TURN_STATUSES.has(status)) {
      abort("preflight_unresolved_turn");
    }
  }
}

function parseTransition(
  value: unknown,
  operation: "new_thread" | "resume_thread"
): LifecycleTransitionEvidence {
  const record = recordValue(
    value,
    operation === "new_thread" ? "new_thread_invalid" : "resume_thread_invalid"
  );
  const status = stringValue(record.status);
  if (
    status === "uncertain" ||
    status === "verified_recovery_required" ||
    record.do_not_retry === true
  ) {
    abort(
      operation === "new_thread"
        ? "new_thread_uncertain"
        : "resume_thread_uncertain"
    );
  }
  const invalidCode: LifecycleSmokeErrorCode = operation === "new_thread"
    ? "new_thread_invalid"
    : "resume_thread_invalid";
  if (
    status !== "committed" ||
    record.operation !== operation ||
    record.turn_created !== false
  ) {
    abort(invalidCode);
  }
  return {
    terminal_id: requiredString(record.terminal_id, invalidCode),
    transition_id: requiredString(record.transition_id, invalidCode),
    operation,
    previous_session_id: requiredString(
      record.previous_session_id,
      invalidCode
    ),
    session_id: requiredString(record.session_id, invalidCode),
    previous_native_thread_id: exactNativeThreadId(
      record.previous_native_thread_id,
      invalidCode
    ),
    native_thread_id: exactNativeThreadId(record.native_thread_id, invalidCode),
    binding_id: requiredString(record.binding_id, invalidCode),
    binding_generation: positiveInteger(
      record.binding_generation,
      invalidCode
    ),
    turn_created: false
  };
}

function parseSend(value: unknown, expectedSessionId: string): {
  sessionId: string;
  turnId: string;
  statePath: string;
  eventLogPath: string;
} {
  const record = recordValue(value, "send_invalid");
  if (
    record.submission_outcome === "uncertain" ||
    record.do_not_retry === true ||
    record.delivered !== true ||
    record.bookkeeping_warning !== undefined &&
      record.bookkeeping_warning !== null
  ) {
    abort("send_uncertain");
  }
  const sessionId = requiredString(record.session_id, "send_invalid");
  const turnId = requiredString(record.turn_id, "send_invalid");
  const conversation = recordValue(record.conversation, "send_invalid");
  const statePath = requiredString(conversation.state_path, "send_invalid");
  const eventLogPath = requiredString(
    conversation.event_log_path,
    "send_invalid"
  );
  if (
    record.status !== "async_pending" ||
    record.delivery_receipt !== "submitted" ||
    record.replayed === true ||
    record.background !== true ||
    sessionId !== expectedSessionId ||
    conversation.session_id !== sessionId ||
    conversation.turn_id !== turnId
  ) {
    abort("send_invalid");
  }
  return { sessionId, turnId, statePath, eventLogPath };
}

function parseMonitor(
  value: unknown,
  sent: {
    sessionId: string;
    turnId: string;
    statePath: string;
    eventLogPath: string;
  },
  nonce: string
): { status: "idle" } {
  const record = recordValue(value, "monitor_invalid");
  if (
    record.submission_outcome === "uncertain" ||
    record.do_not_retry === true ||
    record.completed === false ||
    record.stalled === true ||
    record.awaiting_approval === true
  ) {
    abort("monitor_uncertain");
  }
  const conversation = recordValue(record.conversation, "monitor_invalid");
  const message = recordValue(record.message, "monitor_invalid");
  if (
    record.delivered !== false ||
    record.duplicate !== false ||
    message.type !== "done" ||
    typeof message.body !== "string" ||
    !message.body.includes(nonce) ||
    message.session_id !== sent.sessionId ||
    message.turn_id !== sent.turnId ||
    conversation.session_id !== sent.sessionId ||
    conversation.turn_id !== sent.turnId ||
    conversation.status !== "idle" ||
    conversation.state_path !== sent.statePath ||
    conversation.event_log_path !== sent.eventLogPath
  ) {
    abort("monitor_invalid");
  }
  return { status: "idle" };
}

function parseResumeCandidate(
  value: unknown,
  current: InternalTerminalSnapshot,
  nativeThreadId: string,
  expectedManagedSessionId: string
): ResumeCandidateAction {
  const record = recordValue(value, "candidate_invalid");
  if (
    record.terminal_id !== current.evidence.terminal_id ||
    record.agent !== current.agent
  ) {
    abort("candidate_invalid");
  }
  if (
    record.workspace !== current.evidence.workspace ||
    record.current_session_id !== current.evidence.session_id ||
    record.current_native_thread_id !== current.evidence.native_thread_id
  ) {
    abort("candidate_invalid");
  }
  const expectedBindingToken = requiredString(
    record.expected_binding_token,
    "candidate_invalid"
  );
  if (expectedBindingToken !== current.evidence.binding_fence) {
    abort("candidate_invalid");
  }
  const threads = Array.isArray(record.threads) ? record.threads : [];
  const matches = threads.filter((candidate) =>
    isRecord(candidate) && candidate.native_thread_id === nativeThreadId
  );
  if (matches.length !== 1) {
    abort("candidate_invalid");
  }
  const candidate = matches[0] as Record<string, unknown>;
  if (
    candidate.resumable !== true ||
    candidate.active_elsewhere !== false ||
    candidate.unavailable_reason !== undefined ||
    candidate.managed_session_id !== expectedManagedSessionId
  ) {
    abort("candidate_invalid");
  }
  const candidateToken = requiredString(
    candidate.candidate_token,
    "candidate_invalid"
  );
  const availableActions = recordValue(
    candidate.available_actions,
    "candidate_invalid"
  );
  const resume = recordValue(
    availableActions.resume_thread,
    "candidate_invalid"
  );
  const args = recordValue(resume.arguments, "candidate_invalid");
  if (
    args.terminal_id !== current.evidence.terminal_id ||
    args.native_thread_id !== nativeThreadId ||
    args.expected_binding_token !== expectedBindingToken ||
    args.candidate_token !== candidateToken
  ) {
    abort("candidate_invalid");
  }
  return {
    terminalId: current.evidence.terminal_id,
    nativeThreadId,
    expectedBindingToken,
    candidateToken,
    managedSessionId: expectedManagedSessionId,
    evidence: {
      native_thread_id: nativeThreadId,
      exact_candidate_count: 1,
      resumable: true,
      active_elsewhere: false,
      fresh_candidate_token_present: true
    }
  };
}

function assertSameTerminalIncarnation(
  expected: InternalTerminalSnapshot,
  actual: InternalTerminalSnapshot
): void {
  if (
    actual.agent !== expected.agent ||
    actual.evidence.terminal_id !== expected.evidence.terminal_id ||
    actual.target !== expected.target ||
    actual.panePid !== expected.panePid ||
    actual.evidence.agent_pid !== expected.evidence.agent_pid ||
    actual.evidence.process_uuid !== expected.evidence.process_uuid ||
    actual.evidence.process_birth !== expected.evidence.process_birth ||
    actual.evidence.workspace !== expected.evidence.workspace ||
    actual.evidence.agent_version !== expected.evidence.agent_version ||
    actual.evidence.behavior_profile !== expected.evidence.behavior_profile
  ) {
    abort("identity_drift");
  }
}

function normalizedTimeouts(
  configured: Partial<LifecycleSmokeTimeouts> | undefined
): LifecycleSmokeTimeouts {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(configured ?? {}) };
  for (const value of Object.values(timeouts)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      abort("configuration_invalid");
    }
  }
  if (timeouts.agentHardTimeoutMinutes < timeouts.agentInactivityMinutes) {
    abort("configuration_invalid");
  }
  return timeouts;
}

function validateConfig(config: LifecycleScenarioConfig): void {
  if (
    !["codex", "claude"].includes(config.agent) ||
    typeof config.target !== "string" ||
    config.target.trim() === "" ||
    !Number.isSafeInteger(config.expectedPanePid) ||
    config.expectedPanePid <= 1 ||
    typeof config.expectedAgentVersion !== "string" ||
    config.expectedAgentVersion.trim() === ""
  ) {
    abort("configuration_invalid");
  }
}

function errorCodeFor(error: unknown): LifecycleSmokeErrorCode {
  if (error instanceof SmokeAbort) {
    return error.errorCode;
  }
  if (error instanceof AkkClientInvocationError) {
    return `client_${error.failureKind}` as LifecycleSmokeErrorCode;
  }
  return "client_error";
}

function recordValue(
  value: unknown,
  errorCode: LifecycleSmokeErrorCode
): Record<string, unknown> {
  if (!isRecord(value)) {
    abort(errorCode);
  }
  return value;
}

function requiredString(
  value: unknown,
  errorCode: LifecycleSmokeErrorCode
): string {
  if (typeof value !== "string" || value.trim() === "") {
    abort(errorCode);
  }
  return value;
}

function nullableString(
  value: unknown,
  errorCode: LifecycleSmokeErrorCode
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requiredString(value, errorCode);
}

function exactNativeThreadId(
  value: unknown,
  errorCode: LifecycleSmokeErrorCode
): string {
  const result = requiredString(value, errorCode);
  if (!NATIVE_THREAD_ID_PATTERN.test(result)) {
    abort(errorCode);
  }
  return result.toLowerCase();
}

function positiveInteger(
  value: unknown,
  errorCode: LifecycleSmokeErrorCode
): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    abort(errorCode);
  }
  return result;
}

function nonNegativeInteger(
  value: unknown,
  errorCode: LifecycleSmokeErrorCode
): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    abort(errorCode);
  }
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function abort(errorCode: LifecycleSmokeErrorCode): never {
  throw new SmokeAbort(errorCode);
}

function safeNow(now: () => number): number {
  const value = now();
  return Number.isFinite(value) ? value : 0;
}

function elapsed(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
