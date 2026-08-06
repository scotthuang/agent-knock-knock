import { createHash, randomBytes } from "node:crypto";

export const LIVE_LIFECYCLE_EVIDENCE_KIND =
  "agent-knock-knock/native-lifecycle-live-smoke" as const;
export const LIVE_LIFECYCLE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const LIVE_LIFECYCLE_ATTESTATION_BEGIN =
  "-----BEGIN AKK NATIVE LIFECYCLE LIVE SMOKE V1-----";
export const LIVE_LIFECYCLE_ATTESTATION_END =
  "-----END AKK NATIVE LIFECYCLE LIVE SMOKE V1-----";

const DEFAULT_MAX_AGE_HOURS = 72;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_RUN_DURATION_MS = 6 * 60 * 60 * 1_000;
const DIGEST_DOMAIN = "agent-knock-knock/live-lifecycle-evidence/v1";
const FINGERPRINT_DOMAIN =
  "agent-knock-knock/live-lifecycle-evidence/fingerprint/v1";
const AGENTS = ["codex", "claude"] as const;
const STEP_NAMES = [
  "preflight",
  "new_thread",
  "send",
  "wait_completion",
  "list_resumable_threads",
  "resume_thread",
  "final_verify"
] as const;

export type LiveLifecycleAgent = typeof AGENTS[number];
export type LiveLifecycleResultStatus = "passed" | "failed" | "uncertain";
export type LiveLifecycleStepName = typeof STEP_NAMES[number];
export type LiveLifecycleStepStatus = LiveLifecycleResultStatus;
export type LiveLifecycleTransitionStatus =
  | "committed"
  | "failed"
  | "uncertain";
export type LiveLifecycleTurnStatus = "completed" | "failed" | "uncertain";

export interface RawLiveLifecycleStepResult {
  name: LiveLifecycleStepName;
  status: LiveLifecycleStepStatus;
  durationMs: number;
}

export interface RawLiveLifecycleSnapshot {
  tmuxTarget: string;
  panePid: number;
  agentPid: number;
  processUuid: string;
  processBirth?: string;
  workspace: string;
  nativeThreadId: string;
  sessionId: string;
  bindingId: string;
  bindingGeneration: number;
  idle: boolean;
}

export interface RawLiveLifecycleResumeCandidateResult {
  nativeThreadId: string;
  exactCandidateCount: number;
  resumable: boolean;
  activeElsewhere: boolean;
  freshCandidateTokenPresent: boolean;
}

export interface RawLiveLifecycleTransitionResult {
  transitionId: string;
  status: LiveLifecycleTransitionStatus;
  sourceSessionId: string;
  targetSessionId: string;
  sourceBindingId: string;
  targetBindingId: string;
}

export interface RawLiveLifecycleTurnResult {
  status: LiveLifecycleTurnStatus;
  turnId: string;
  sessionId: string;
  bindingId: string;
  bindingGeneration: number;
}

export interface RawLiveLifecycleScenarioResult {
  status: LiveLifecycleResultStatus;
  failureStage?: LiveLifecycleStepName;
  reasonCode?: string;
  doNotRetry?: true;
  agentVersion?: string;
  tmuxTarget: string;
  panePid: number;
  startedAt: string;
  completedAt: string;
  before?: RawLiveLifecycleSnapshot;
  afterNew?: RawLiveLifecycleSnapshot;
  afterResume?: RawLiveLifecycleSnapshot;
  resumeCandidate?: RawLiveLifecycleResumeCandidateResult;
  send?: RawLiveLifecycleTurnResult;
  transitions?: {
    newThread?: RawLiveLifecycleTransitionResult;
    resumeThread?: RawLiveLifecycleTransitionResult;
  };
  turnDeltas?: {
    newThread?: number;
    send?: number;
    resumeThread?: number;
  };
  steps: RawLiveLifecycleStepResult[];
}

export interface RawLiveLifecycleEvidenceInput {
  packageName: string;
  packageVersion: string;
  commit: string;
  worktreeClean: boolean;
  startedAt: string;
  completedAt: string;
  scenarios: Partial<Record<LiveLifecycleAgent, RawLiveLifecycleScenarioResult>>;
  /** Tests and deterministic tooling may supply these; production callers omit them. */
  runId?: string;
  fingerprintSalt?: string;
}

export interface LiveLifecycleFingerprintSnapshot {
  tmux_target: string;
  pane_pid: number;
  agent_pid: number;
  process_uuid_fingerprint: string;
  process_birth_fingerprint?: string;
  workspace_fingerprint: string;
  native_thread_fingerprint: string;
  session_fingerprint: string;
  binding_fingerprint: string;
  binding_generation: number;
  idle: boolean;
}

export interface LiveLifecycleResumeCandidateEvidence {
  native_thread_fingerprint: string;
  exact_candidate_count: number;
  resumable: boolean;
  active_elsewhere: boolean;
  fresh_candidate_token_present: boolean;
}

export interface LiveLifecycleTransitionEvidence {
  status: LiveLifecycleTransitionStatus;
  transition_fingerprint: string;
  source_session_fingerprint: string;
  target_session_fingerprint: string;
  source_binding_fingerprint: string;
  target_binding_fingerprint: string;
}

export interface LiveLifecycleTurnEvidence {
  status: LiveLifecycleTurnStatus;
  turn_fingerprint: string;
  session_fingerprint: string;
  binding_fingerprint: string;
  binding_generation: number;
}

export interface LiveLifecycleStepEvidence {
  name: LiveLifecycleStepName;
  status: LiveLifecycleStepStatus;
  duration_ms: number;
}

export interface LiveLifecycleRelationshipAssertions {
  start_idle: boolean;
  new_idle: boolean;
  final_idle: boolean;
  new_native_thread_differs: boolean;
  final_native_thread_matches_start: boolean;
  resume_candidate_matches_start: boolean;
  new_session_differs: boolean;
  resumed_session_matches_start: boolean;
  original_binding_generation_advanced: boolean;
  binding_generations_exact: boolean;
  binding_fingerprints_distinct: boolean;
  send_bound_to_new_session: boolean;
  transitions_match_sessions: boolean;
  transitions_match_bindings: boolean;
  transitions_distinct: boolean;
  resume_candidate_safe: boolean;
  same_tmux_pane: boolean;
  same_process_incarnation: boolean;
  same_workspace: boolean;
}

export interface LiveLifecycleAgentEvidence {
  status: LiveLifecycleResultStatus;
  failure_stage?: LiveLifecycleStepName;
  reason_code?: string;
  do_not_retry?: true;
  agent_version?: string;
  tmux_target: string;
  pane_pid: number;
  started_at: string;
  completed_at: string;
  snapshots: {
    before?: LiveLifecycleFingerprintSnapshot;
    after_new?: LiveLifecycleFingerprintSnapshot;
    after_resume?: LiveLifecycleFingerprintSnapshot;
  };
  resume_candidate?: LiveLifecycleResumeCandidateEvidence;
  send?: LiveLifecycleTurnEvidence;
  transitions: {
    new_thread?: LiveLifecycleTransitionEvidence;
    resume_thread?: LiveLifecycleTransitionEvidence;
  };
  turn_deltas: {
    new_thread: number | null;
    send: number | null;
    resume_thread: number | null;
  };
  assertions: LiveLifecycleRelationshipAssertions;
  steps: LiveLifecycleStepEvidence[];
}

export interface LiveLifecycleEvidence {
  schema_version: typeof LIVE_LIFECYCLE_EVIDENCE_SCHEMA_VERSION;
  kind: typeof LIVE_LIFECYCLE_EVIDENCE_KIND;
  run_id: string;
  package: {
    name: string;
    version: string;
  };
  source: {
    commit: string;
    worktree_clean: boolean;
  };
  started_at: string;
  completed_at: string;
  overall_status: LiveLifecycleResultStatus;
  matrix: Partial<Record<LiveLifecycleAgent, LiveLifecycleAgentEvidence>>;
  digest: string;
}

export interface LiveLifecycleEvidenceValidationOptions {
  expectedPackageName: string;
  expectedPackageVersion: string;
  expectedCommit: string;
  requireAgents?: readonly LiveLifecycleAgent[];
  maxAgeHours?: number;
  now?: Date | string | number;
}

export class LiveLifecycleEvidenceValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LiveLifecycleEvidenceValidationError";
  }
}

/**
 * Build an allowlisted evidence document from raw runtime results. Raw IDs are
 * used only to calculate per-run, domain-separated fingerprints and relationship
 * assertions; they are never copied into the returned document.
 */
export function create(input: RawLiveLifecycleEvidenceInput): LiveLifecycleEvidence {
  assertRawEnvelope(input);
  const runId = input.runId ?? randomBytes(16).toString("hex");
  const fingerprintSalt = input.fingerprintSalt ?? randomBytes(32).toString("hex");
  assertPattern(runId, /^[0-9a-f]{32}$/u, "invalid_run_id", "runId");
  assertPattern(
    fingerprintSalt,
    /^[0-9a-f]{64}$/u,
    "invalid_fingerprint_salt",
    "fingerprintSalt"
  );

  const matrix: Partial<Record<LiveLifecycleAgent, LiveLifecycleAgentEvidence>> = {};
  for (const agent of AGENTS) {
    const scenario = Object.prototype.hasOwnProperty.call(input.scenarios, agent)
      ? input.scenarios[agent]
      : undefined;
    if (scenario !== undefined) {
      matrix[agent] = createScenarioEvidence(scenario, fingerprintSalt);
    }
  }
  if (Object.keys(matrix).length === 0) {
    fail("matrix_empty", "At least one Codex or Claude scenario is required.");
  }

  const statuses = Object.values(matrix).map((scenario) => scenario!.status);
  const derivedStatus = deriveResultStatus(statuses);
  const unsigned: Omit<LiveLifecycleEvidence, "digest"> = {
    schema_version: LIVE_LIFECYCLE_EVIDENCE_SCHEMA_VERSION,
    kind: LIVE_LIFECYCLE_EVIDENCE_KIND,
    run_id: runId,
    package: {
      name: input.packageName,
      version: input.packageVersion
    },
    source: {
      commit: input.commit,
      worktree_clean: input.worktreeClean
    },
    started_at: input.startedAt,
    completed_at: input.completedAt,
    overall_status:
      Object.keys(matrix).length === AGENTS.length ? derivedStatus :
        derivedStatus === "uncertain" ? "uncertain" : "failed",
    matrix
  };
  // Creation is also a redaction boundary: even failed/uncertain evidence may
  // be written as machine-readable diagnostics, so unsafe plaintext must not
  // survive until release validation.
  scanForSensitiveMaterial(unsigned, "$", new Set());
  const evidence: LiveLifecycleEvidence = {
    ...unsigned,
    digest: digestUnsignedEvidence(unsigned)
  };
  return assertEvidence(evidence, [], {
    allowNonPassing: true,
    allowDirtyWorktree: true
  });
}

export const createLiveLifecycleEvidence = create;

/**
 * Validate an evidence document for release use. The default release matrix is
 * Codex plus Claude, and freshness defaults to 72 hours with five minutes of
 * allowed forward clock skew.
 */
export function validate(
  value: unknown,
  options: LiveLifecycleEvidenceValidationOptions
): LiveLifecycleEvidence {
  const evidence = assertEvidence(value, options.requireAgents ?? AGENTS);
  assertExpectedValue(
    evidence.package.name,
    options.expectedPackageName,
    "package_name_mismatch",
    "package.name"
  );
  assertExpectedValue(
    evidence.package.version,
    options.expectedPackageVersion,
    "package_version_mismatch",
    "package.version"
  );
  assertPattern(
    options.expectedCommit,
    /^[0-9a-f]{40}$/u,
    "invalid_expected_commit",
    "expectedCommit"
  );
  assertExpectedValue(
    evidence.source.commit,
    options.expectedCommit,
    "commit_mismatch",
    "source.commit"
  );

  const maxAgeHours = options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    fail("invalid_max_age", "maxAgeHours must be a positive finite number.");
  }
  const now = parseNow(options.now);
  const startedAt = parseTimestamp(evidence.started_at, "started_at");
  const completedAt = parseTimestamp(evidence.completed_at, "completed_at");
  if (completedAt < startedAt) {
    fail("invalid_time_order", "Evidence completed_at precedes started_at.");
  }
  if (completedAt - startedAt > MAX_RUN_DURATION_MS) {
    fail("run_duration_exceeded", "Evidence run duration exceeds six hours.");
  }
  if (completedAt > now + CLOCK_SKEW_MS) {
    fail("future_evidence", "Evidence completed_at is too far in the future.");
  }
  if (now - completedAt > maxAgeHours * 60 * 60 * 1_000) {
    fail("stale_evidence", `Evidence is older than ${maxAgeHours} hours.`);
  }
  for (const agent of AGENTS) {
    const scenario = evidence.matrix[agent];
    if (scenario === undefined) {
      continue;
    }
    const scenarioStartedAt = parseTimestamp(
      scenario.started_at,
      `matrix.${agent}.started_at`
    );
    const scenarioCompletedAt = parseTimestamp(
      scenario.completed_at,
      `matrix.${agent}.completed_at`
    );
    if (
      scenarioCompletedAt < scenarioStartedAt ||
      scenarioStartedAt < startedAt ||
      scenarioCompletedAt > completedAt
    ) {
      fail(
        "invalid_scenario_time_order",
        `${agent} scenario timestamps fall outside the evidence interval.`
      );
    }
    if (scenarioCompletedAt - scenarioStartedAt > MAX_RUN_DURATION_MS) {
      fail(
        "run_duration_exceeded",
        `${agent} scenario duration exceeds six hours.`
      );
    }
    if (scenarioCompletedAt > now + CLOCK_SKEW_MS) {
      fail("future_evidence", `${agent} scenario is too far in the future.`);
    }
    if (now - scenarioCompletedAt > maxAgeHours * 60 * 60 * 1_000) {
      fail(
        "stale_scenario",
        `${agent} scenario is older than ${maxAgeHours} hours.`
      );
    }
  }
  return evidence;
}

export const validateLiveLifecycleEvidence = validate;

/** Serialize canonical evidence into a block suitable for an annotated tag body. */
export function serializeAttestation(evidence: LiveLifecycleEvidence): string {
  const verified = assertEvidence(evidence, AGENTS);
  const canonical = canonicalJson(verified);
  const payload = Buffer.from(canonical, "utf8").toString("base64url");
  return [
    LIVE_LIFECYCLE_ATTESTATION_BEGIN,
    payload,
    LIVE_LIFECYCLE_ATTESTATION_END
  ].join("\n");
}

/** Extract and structurally verify one attestation block from an annotated tag. */
export function parseAttestation(message: string): LiveLifecycleEvidence {
  if (typeof message !== "string") {
    fail("invalid_attestation", "Attestation message must be a string.");
  }
  const normalized = message.replace(/\r\n?/gu, "\n");
  const beginMatches = countOccurrences(
    normalized,
    LIVE_LIFECYCLE_ATTESTATION_BEGIN
  );
  const endMatches = countOccurrences(
    normalized,
    LIVE_LIFECYCLE_ATTESTATION_END
  );
  if (beginMatches !== 1 || endMatches !== 1) {
    fail(
      "invalid_attestation_markers",
      "Annotated tag must contain exactly one complete live-smoke attestation block."
    );
  }
  const beginIndex = normalized.indexOf(LIVE_LIFECYCLE_ATTESTATION_BEGIN);
  const payloadStart = beginIndex + LIVE_LIFECYCLE_ATTESTATION_BEGIN.length;
  const endIndex = normalized.indexOf(
    LIVE_LIFECYCLE_ATTESTATION_END,
    payloadStart
  );
  if (endIndex < payloadStart) {
    fail("invalid_attestation_markers", "Attestation markers are out of order.");
  }
  const payload = normalized.slice(payloadStart, endIndex).trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) {
    fail("invalid_attestation_payload", "Attestation payload is not canonical base64url.");
  }
  let decoded: string;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) {
      fail("invalid_attestation_payload", "Attestation base64url is not canonical.");
    }
    decoded = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof LiveLifecycleEvidenceValidationError) {
      throw error;
    }
    fail("invalid_attestation_payload", "Attestation payload cannot be decoded.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    fail("invalid_attestation_json", "Attestation payload is not valid JSON.");
  }
  if (canonicalJson(parsed) !== decoded) {
    fail("noncanonical_attestation", "Attestation JSON is not canonical.");
  }
  return assertEvidence(parsed, AGENTS);
}

function createScenarioEvidence(
  raw: RawLiveLifecycleScenarioResult,
  salt: string
): LiveLifecycleAgentEvidence {
  assertRawScenario(raw);
  const before = raw.before === undefined ? undefined :
    createSnapshotEvidence(raw.before, salt);
  const afterNew = raw.afterNew === undefined ? undefined :
    createSnapshotEvidence(raw.afterNew, salt);
  const afterResume = raw.afterResume === undefined ? undefined :
    createSnapshotEvidence(raw.afterResume, salt);
  const fingerprint = (domain: FingerprintDomain, value: string) =>
    fingerprintValue(salt, domain, requireRawIdentifier(value, domain));
  const send: LiveLifecycleTurnEvidence | undefined = raw.send === undefined
    ? undefined
    : {
        status: raw.send.status,
        turn_fingerprint: fingerprint("turn", raw.send.turnId),
        session_fingerprint: fingerprint("session", raw.send.sessionId),
        binding_fingerprint: fingerprint("binding", raw.send.bindingId),
        binding_generation: raw.send.bindingGeneration
      };
  const newTransition = raw.transitions?.newThread === undefined ? undefined :
    createTransitionEvidence(raw.transitions.newThread, salt);
  const resumeTransition = raw.transitions?.resumeThread === undefined ? undefined :
    createTransitionEvidence(raw.transitions.resumeThread, salt);
  const resumeCandidate = raw.resumeCandidate === undefined
    ? undefined
    : {
        native_thread_fingerprint: fingerprint(
          "native_thread",
          raw.resumeCandidate.nativeThreadId
        ),
        exact_candidate_count: raw.resumeCandidate.exactCandidateCount,
        resumable: raw.resumeCandidate.resumable,
        active_elsewhere: raw.resumeCandidate.activeElsewhere,
        fresh_candidate_token_present:
          raw.resumeCandidate.freshCandidateTokenPresent
      };
  const steps = raw.steps.map((step) => ({
    name: step.name,
    status: step.status,
    duration_ms: step.durationMs
  }));
  const status = deriveResultStatus([
    raw.status,
    ...steps.map((step) => step.status),
    ...(raw.send === undefined
      ? []
      : [raw.send.status === "completed" ? "passed" as const : raw.send.status]),
    ...(raw.transitions?.newThread === undefined
      ? []
      : [raw.transitions.newThread.status === "committed"
          ? "passed" as const
          : raw.transitions.newThread.status]),
    ...(raw.transitions?.resumeThread === undefined
      ? []
      : [raw.transitions.resumeThread.status === "committed"
          ? "passed" as const
          : raw.transitions.resumeThread.status])
  ]);
  if (status === "passed") {
    if (
      raw.failureStage !== undefined ||
      raw.reasonCode !== undefined ||
      raw.doNotRetry !== undefined
    ) {
      fail(
        "unexpected_failure_detail",
        "Passing scenarios cannot carry failure details."
      );
    }
  } else {
    if (raw.failureStage === undefined) {
      fail("missing_failure_stage", "Non-passing scenarios require failureStage.");
    }
    requireReasonCode(raw.reasonCode, "reasonCode");
    if (status === "uncertain" && raw.doNotRetry !== true) {
      fail(
        "retry_guard_missing",
        "An uncertain lifecycle run must record doNotRetry=true."
      );
    }
  }
  const hasAllSnapshots =
    before !== undefined && afterNew !== undefined && afterResume !== undefined;
  const sameTmuxPane = hasAllSnapshots &&
    [before, afterNew, afterResume].every(
      (snapshot) =>
        snapshot.tmux_target === raw.tmuxTarget &&
        snapshot.pane_pid === raw.panePid
    );
  const sameProcess = hasAllSnapshots &&
    [before, afterNew, afterResume].every(
      (snapshot) =>
        snapshot.agent_pid === before.agent_pid &&
        snapshot.process_uuid_fingerprint === before.process_uuid_fingerprint &&
        snapshot.process_birth_fingerprint === before.process_birth_fingerprint
    );
  const sameWorkspace = hasAllSnapshots &&
    [before, afterNew, afterResume].every(
      (snapshot) => snapshot.workspace_fingerprint === before.workspace_fingerprint
    );
  const transitionsMatchSessions = hasAllSnapshots &&
    newTransition !== undefined &&
    resumeTransition !== undefined &&
    newTransition.source_session_fingerprint === before.session_fingerprint &&
    newTransition.target_session_fingerprint === afterNew.session_fingerprint &&
    resumeTransition.source_session_fingerprint === afterNew.session_fingerprint &&
    resumeTransition.target_session_fingerprint === afterResume.session_fingerprint;
  const transitionsMatchBindings = hasAllSnapshots &&
    newTransition !== undefined &&
    resumeTransition !== undefined &&
    newTransition.source_binding_fingerprint === before.binding_fingerprint &&
    newTransition.target_binding_fingerprint === afterNew.binding_fingerprint &&
    resumeTransition.source_binding_fingerprint === afterNew.binding_fingerprint &&
    resumeTransition.target_binding_fingerprint === afterResume.binding_fingerprint;

  return {
    status,
    ...(status === "passed" ? {} : {
      failure_stage: raw.failureStage,
      reason_code: raw.reasonCode,
      ...(raw.doNotRetry === true ? { do_not_retry: true as const } : {})
    }),
    ...(raw.agentVersion === undefined ? {} : { agent_version: raw.agentVersion }),
    tmux_target: raw.tmuxTarget,
    pane_pid: raw.panePid,
    started_at: raw.startedAt,
    completed_at: raw.completedAt,
    snapshots: {
      ...(before === undefined ? {} : { before }),
      ...(afterNew === undefined ? {} : { after_new: afterNew }),
      ...(afterResume === undefined ? {} : { after_resume: afterResume })
    },
    ...(resumeCandidate === undefined ? {} : {
      resume_candidate: resumeCandidate
    }),
    ...(send === undefined ? {} : { send }),
    transitions: {
      ...(newTransition === undefined ? {} : { new_thread: newTransition }),
      ...(resumeTransition === undefined ? {} : { resume_thread: resumeTransition })
    },
    turn_deltas: {
      new_thread: raw.turnDeltas?.newThread ?? null,
      send: raw.turnDeltas?.send ?? null,
      resume_thread: raw.turnDeltas?.resumeThread ?? null
    },
    assertions: {
      start_idle: before?.idle === true,
      new_idle: afterNew?.idle === true,
      final_idle: afterResume?.idle === true,
      new_native_thread_differs: before !== undefined && afterNew !== undefined &&
        afterNew.native_thread_fingerprint !== before.native_thread_fingerprint,
      final_native_thread_matches_start: before !== undefined && afterResume !== undefined &&
        afterResume.native_thread_fingerprint === before.native_thread_fingerprint,
      resume_candidate_matches_start: before !== undefined && resumeCandidate !== undefined &&
        resumeCandidate.native_thread_fingerprint === before.native_thread_fingerprint,
      new_session_differs: before !== undefined && afterNew !== undefined &&
        afterNew.session_fingerprint !== before.session_fingerprint,
      resumed_session_matches_start: before !== undefined && afterResume !== undefined &&
        afterResume.session_fingerprint === before.session_fingerprint,
      original_binding_generation_advanced: before !== undefined && afterResume !== undefined &&
        afterResume.binding_generation > before.binding_generation,
      binding_generations_exact: before !== undefined && afterNew !== undefined &&
        afterResume !== undefined &&
        afterNew.binding_generation === 1 &&
        afterResume.binding_generation === before.binding_generation + 1,
      binding_fingerprints_distinct: before !== undefined && afterNew !== undefined &&
        afterResume !== undefined &&
        new Set([
          before.binding_fingerprint,
          afterNew.binding_fingerprint,
          afterResume.binding_fingerprint
        ]).size === 3,
      send_bound_to_new_session: send !== undefined && afterNew !== undefined &&
        send.status === "completed" &&
        send.session_fingerprint === afterNew.session_fingerprint &&
        send.binding_fingerprint === afterNew.binding_fingerprint &&
        send.binding_generation === afterNew.binding_generation,
      transitions_match_sessions: transitionsMatchSessions,
      transitions_match_bindings: transitionsMatchBindings,
      transitions_distinct: newTransition !== undefined &&
        resumeTransition !== undefined &&
        newTransition.transition_fingerprint !==
          resumeTransition.transition_fingerprint,
      resume_candidate_safe: resumeCandidate !== undefined &&
        resumeCandidate.exact_candidate_count === 1 &&
        resumeCandidate.resumable === true &&
        resumeCandidate.active_elsewhere === false &&
        resumeCandidate.fresh_candidate_token_present === true,
      same_tmux_pane: sameTmuxPane,
      same_process_incarnation: sameProcess,
      same_workspace: sameWorkspace
    },
    steps
  };
}

function createSnapshotEvidence(
  raw: RawLiveLifecycleSnapshot,
  salt: string
): LiveLifecycleFingerprintSnapshot {
  assertSafeInteger(raw.panePid, "invalid_pane_pid", "panePid", 2);
  assertSafeInteger(raw.agentPid, "invalid_agent_pid", "agentPid", 2);
  assertSafeInteger(
    raw.bindingGeneration,
    "invalid_binding_generation",
    "bindingGeneration",
    0
  );
  return {
    tmux_target: requireBoundedString(raw.tmuxTarget, "tmuxTarget", 512),
    pane_pid: raw.panePid,
    agent_pid: raw.agentPid,
    process_uuid_fingerprint: fingerprintValue(
      salt,
      "process_uuid",
      requireRawIdentifier(raw.processUuid, "process_uuid")
    ),
    ...(raw.processBirth === undefined ? {} : {
      process_birth_fingerprint: fingerprintValue(
        salt,
        "process_birth",
        requireRawIdentifier(raw.processBirth, "process_birth")
      )
    }),
    workspace_fingerprint: fingerprintValue(
      salt,
      "workspace",
      requireRawIdentifier(raw.workspace, "workspace")
    ),
    native_thread_fingerprint: fingerprintValue(
      salt,
      "native_thread",
      requireRawIdentifier(raw.nativeThreadId, "native_thread")
    ),
    session_fingerprint: fingerprintValue(
      salt,
      "session",
      requireRawIdentifier(raw.sessionId, "session")
    ),
    binding_fingerprint: fingerprintValue(
      salt,
      "binding",
      requireRawIdentifier(raw.bindingId, "binding")
    ),
    binding_generation: raw.bindingGeneration,
    idle: raw.idle === true
  };
}

function createTransitionEvidence(
  raw: RawLiveLifecycleTransitionResult,
  salt: string
): LiveLifecycleTransitionEvidence {
  return {
    status: raw.status,
    transition_fingerprint: fingerprintValue(
      salt,
      "transition",
      requireRawIdentifier(raw.transitionId, "transition")
    ),
    source_session_fingerprint: fingerprintValue(
      salt,
      "session",
      requireRawIdentifier(raw.sourceSessionId, "session")
    ),
    target_session_fingerprint: fingerprintValue(
      salt,
      "session",
      requireRawIdentifier(raw.targetSessionId, "session")
    ),
    source_binding_fingerprint: fingerprintValue(
      salt,
      "binding",
      requireRawIdentifier(raw.sourceBindingId, "binding")
    ),
    target_binding_fingerprint: fingerprintValue(
      salt,
      "binding",
      requireRawIdentifier(raw.targetBindingId, "binding")
    )
  };
}

type FingerprintDomain =
  | "process_uuid"
  | "process_birth"
  | "workspace"
  | "native_thread"
  | "session"
  | "turn"
  | "transition"
  | "binding";

function fingerprintValue(
  salt: string,
  domain: FingerprintDomain,
  value: string
): string {
  const digest = createHash("sha256")
    .update(FINGERPRINT_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(salt, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function digestUnsignedEvidence(
  unsigned: Omit<LiveLifecycleEvidence, "digest">
): string {
  const digest = createHash("sha256")
    .update(DIGEST_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(unsigned), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function assertEvidence(
  value: unknown,
  requireAgents: readonly LiveLifecycleAgent[],
  policy: {
    allowNonPassing?: boolean;
    allowDirtyWorktree?: boolean;
  } = {}
): LiveLifecycleEvidence {
  scanForSensitiveMaterial(value, "$", new Set());
  const root = requireRecord(value, "$", [
    "schema_version",
    "kind",
    "run_id",
    "package",
    "source",
    "started_at",
    "completed_at",
    "overall_status",
    "matrix",
    "digest"
  ]);
  assertLiteral(
    root.schema_version,
    LIVE_LIFECYCLE_EVIDENCE_SCHEMA_VERSION,
    "unsupported_schema",
    "schema_version"
  );
  assertLiteral(
    root.kind,
    LIVE_LIFECYCLE_EVIDENCE_KIND,
    "invalid_kind",
    "kind"
  );
  assertPattern(root.run_id, /^[0-9a-f]{32}$/u, "invalid_run_id", "run_id");
  const packageRecord = requireRecord(root.package, "package", ["name", "version"]);
  requireBoundedString(packageRecord.name, "package.name", 256);
  requireBoundedString(packageRecord.version, "package.version", 128);
  const source = requireRecord(root.source, "source", [
    "commit",
    "worktree_clean"
  ]);
  assertPattern(
    source.commit,
    /^[0-9a-f]{40}$/u,
    "invalid_commit",
    "source.commit"
  );
  if (typeof source.worktree_clean !== "boolean") {
    fail("invalid_boolean", "source.worktree_clean must be boolean.");
  }
  if (source.worktree_clean !== true && policy.allowDirtyWorktree !== true) {
    fail("dirty_worktree", "Evidence source.worktree_clean must be true.");
  }
  const evidenceStartedAt = parseTimestamp(root.started_at, "started_at");
  const evidenceCompletedAt = parseTimestamp(root.completed_at, "completed_at");
  if (evidenceCompletedAt < evidenceStartedAt) {
    fail("invalid_time_order", "Evidence completed_at precedes started_at.");
  }
  if (evidenceCompletedAt - evidenceStartedAt > MAX_RUN_DURATION_MS) {
    fail("run_duration_exceeded", "Evidence run duration exceeds six hours.");
  }
  assertStatus(root.overall_status, "overall_status");
  assertPattern(
    root.digest,
    /^sha256:[0-9a-f]{64}$/u,
    "invalid_digest",
    "digest"
  );

  const matrix = requireRecord(root.matrix, "matrix", AGENTS, [], true);
  if (Object.keys(matrix).length === 0) {
    fail("matrix_empty", "Evidence matrix must contain at least one agent.");
  }
  const typedMatrix: Partial<Record<LiveLifecycleAgent, LiveLifecycleAgentEvidence>> = {};
  for (const agent of AGENTS) {
    if (matrix[agent] !== undefined) {
      typedMatrix[agent] = assertScenarioEvidence(matrix[agent], agent);
      const scenarioStartedAt = parseTimestamp(
        typedMatrix[agent]!.started_at,
        `matrix.${agent}.started_at`
      );
      const scenarioCompletedAt = parseTimestamp(
        typedMatrix[agent]!.completed_at,
        `matrix.${agent}.completed_at`
      );
      if (
        scenarioCompletedAt < scenarioStartedAt ||
        scenarioStartedAt < evidenceStartedAt ||
        scenarioCompletedAt > evidenceCompletedAt
      ) {
        fail(
          "invalid_scenario_time_order",
          `${agent} scenario timestamps fall outside the evidence interval.`
        );
      }
      if (scenarioCompletedAt - scenarioStartedAt > MAX_RUN_DURATION_MS) {
        fail(
          "run_duration_exceeded",
          `${agent} scenario duration exceeds six hours.`
        );
      }
    }
  }

  const evidence = root as unknown as LiveLifecycleEvidence;
  const statuses = Object.values(typedMatrix).map((scenario) => scenario!.status);
  const derivedStatus = deriveResultStatus(statuses);
  const expectedOverall = Object.keys(typedMatrix).length === AGENTS.length
    ? derivedStatus
    : derivedStatus === "uncertain" ? "uncertain" : "failed";
  if (expectedOverall !== evidence.overall_status) {
    fail("overall_status_mismatch", "Overall status does not match the matrix.");
  }

  const { digest, ...unsigned } = evidence;
  const expectedDigest = digestUnsignedEvidence(unsigned);
  if (digest !== expectedDigest) {
    fail("digest_mismatch", "Evidence canonical digest does not match its content.");
  }
  if (
    evidence.overall_status !== "passed" &&
    policy.allowNonPassing !== true
  ) {
    fail("status_not_passed", "Overall live-smoke status must be passed.");
  }
  for (const agent of requireAgents) {
    if (!AGENTS.includes(agent)) {
      fail("invalid_required_agent", `Unsupported required agent: ${agent}`);
    }
    if (typedMatrix[agent] === undefined) {
      fail("matrix_incomplete", `Evidence matrix is missing ${agent}.`);
    }
  }
  return evidence;
}

function assertScenarioEvidence(
  value: unknown,
  agent: LiveLifecycleAgent
): LiveLifecycleAgentEvidence {
  const path = `matrix.${agent}`;
  const scenario = requireRecord(value, path, [
    "status",
    "failure_stage",
    "reason_code",
    "do_not_retry",
    "agent_version",
    "tmux_target",
    "pane_pid",
    "started_at",
    "completed_at",
    "snapshots",
    "resume_candidate",
    "send",
    "transitions",
    "turn_deltas",
    "assertions",
    "steps"
  ], [
    "status",
    "tmux_target",
    "pane_pid",
    "started_at",
    "completed_at",
    "snapshots",
    "transitions",
    "turn_deltas",
    "assertions",
    "steps"
  ]);
  assertStatus(scenario.status, `${path}.status`);
  requireBoundedString(scenario.tmux_target, `${path}.tmux_target`, 512);
  assertSafeInteger(scenario.pane_pid, "invalid_pane_pid", `${path}.pane_pid`, 2);
  if (scenario.agent_version !== undefined) {
    requireBoundedString(scenario.agent_version, `${path}.agent_version`, 128);
  }
  parseTimestamp(scenario.started_at, `${path}.started_at`);
  parseTimestamp(scenario.completed_at, `${path}.completed_at`);
  if (scenario.status === "passed") {
    if (
      scenario.failure_stage !== undefined ||
      scenario.reason_code !== undefined ||
      scenario.do_not_retry !== undefined
    ) {
      fail("unexpected_failure_detail", `${path} cannot include failure details when passed.`);
    }
    if (scenario.agent_version === undefined) {
      fail("missing_key", `${path}.agent_version is required when passed.`);
    }
  } else {
    if (!STEP_NAMES.includes(scenario.failure_stage as LiveLifecycleStepName)) {
      fail("missing_failure_stage", `${path}.failure_stage is required.`);
    }
    requireReasonCode(scenario.reason_code, `${path}.reason_code`);
    if (scenario.do_not_retry !== undefined && scenario.do_not_retry !== true) {
      fail("invalid_boolean", `${path}.do_not_retry must be true when present.`);
    }
    if (scenario.status === "uncertain" && scenario.do_not_retry !== true) {
      fail(
        "retry_guard_missing",
        `${path} must record do_not_retry=true when uncertain.`
      );
    }
  }

  const snapshots = requireRecord(scenario.snapshots, `${path}.snapshots`, [
    "before",
    "after_new",
    "after_resume"
  ], [], true);
  const before = snapshots.before === undefined ? undefined :
    assertSnapshot(snapshots.before, `${path}.snapshots.before`);
  const afterNew = snapshots.after_new === undefined ? undefined :
    assertSnapshot(snapshots.after_new, `${path}.snapshots.after_new`);
  const afterResume = snapshots.after_resume === undefined ? undefined :
    assertSnapshot(snapshots.after_resume, `${path}.snapshots.after_resume`);
  const resumeCandidate = scenario.resume_candidate === undefined ? undefined :
    assertResumeCandidate(scenario.resume_candidate, `${path}.resume_candidate`);
  const send = scenario.send === undefined ? undefined :
    assertSend(scenario.send, `${path}.send`);
  const transitions = requireRecord(scenario.transitions, `${path}.transitions`, [
    "new_thread",
    "resume_thread"
  ], [], true);
  const newTransition = transitions.new_thread === undefined ? undefined :
    assertTransition(transitions.new_thread, `${path}.transitions.new_thread`);
  const resumeTransition = transitions.resume_thread === undefined ? undefined :
    assertTransition(transitions.resume_thread, `${path}.transitions.resume_thread`);
  const turnDeltas = requireRecord(scenario.turn_deltas, `${path}.turn_deltas`, [
    "new_thread",
    "send",
    "resume_thread"
  ]);
  for (const key of ["new_thread", "send", "resume_thread"] as const) {
    if (turnDeltas[key] !== null) {
      assertSafeInteger(
        turnDeltas[key],
        "turn_delta_invalid",
        `${path}.turn_deltas.${key}`,
        0
      );
    }
  }

  const assertions = assertAssertions(scenario.assertions, `${path}.assertions`);
  const steps = assertSteps(
    scenario.steps,
    `${path}.steps`,
    scenario.status as LiveLifecycleResultStatus,
    scenario.failure_stage as LiveLifecycleStepName | undefined
  );

  const typed = scenario as unknown as LiveLifecycleAgentEvidence;
  if (scenario.status !== "passed") {
    return typed;
  }
  if (
    before === undefined ||
    afterNew === undefined ||
    afterResume === undefined ||
    resumeCandidate === undefined ||
    send === undefined ||
    newTransition === undefined ||
    resumeTransition === undefined
  ) {
    fail("missing_pass_evidence", `${path} lacks complete passing lifecycle evidence.`);
  }
  assertExactInteger(turnDeltas.new_thread, 0, `${path}.turn_deltas.new_thread`);
  assertExactInteger(turnDeltas.send, 1, `${path}.turn_deltas.send`);
  assertExactInteger(turnDeltas.resume_thread, 0, `${path}.turn_deltas.resume_thread`);
  const recomputed: LiveLifecycleRelationshipAssertions = {
    start_idle: before.idle,
    new_idle: afterNew.idle,
    final_idle: afterResume.idle,
    new_native_thread_differs:
      afterNew.native_thread_fingerprint !== before.native_thread_fingerprint,
    final_native_thread_matches_start:
      afterResume.native_thread_fingerprint === before.native_thread_fingerprint,
    resume_candidate_matches_start:
      resumeCandidate.native_thread_fingerprint === before.native_thread_fingerprint,
    new_session_differs:
      afterNew.session_fingerprint !== before.session_fingerprint,
    resumed_session_matches_start:
      afterResume.session_fingerprint === before.session_fingerprint,
    original_binding_generation_advanced:
      afterResume.binding_generation > before.binding_generation,
    binding_generations_exact:
      afterNew.binding_generation === 1 &&
      afterResume.binding_generation === before.binding_generation + 1,
    binding_fingerprints_distinct:
      new Set([
        before.binding_fingerprint,
        afterNew.binding_fingerprint,
        afterResume.binding_fingerprint
      ]).size === 3,
    send_bound_to_new_session:
      send.status === "completed" &&
      send.session_fingerprint === afterNew.session_fingerprint &&
      send.binding_fingerprint === afterNew.binding_fingerprint &&
      send.binding_generation === afterNew.binding_generation,
    transitions_match_sessions:
      newTransition.source_session_fingerprint === before.session_fingerprint &&
      newTransition.target_session_fingerprint === afterNew.session_fingerprint &&
      resumeTransition.source_session_fingerprint === afterNew.session_fingerprint &&
      resumeTransition.target_session_fingerprint === afterResume.session_fingerprint,
    transitions_match_bindings:
      newTransition.source_binding_fingerprint === before.binding_fingerprint &&
      newTransition.target_binding_fingerprint === afterNew.binding_fingerprint &&
      resumeTransition.source_binding_fingerprint === afterNew.binding_fingerprint &&
      resumeTransition.target_binding_fingerprint === afterResume.binding_fingerprint,
    transitions_distinct:
      newTransition.transition_fingerprint !==
      resumeTransition.transition_fingerprint,
    resume_candidate_safe:
      resumeCandidate.exact_candidate_count === 1 &&
      resumeCandidate.resumable === true &&
      resumeCandidate.active_elsewhere === false &&
      resumeCandidate.fresh_candidate_token_present === true,
    same_tmux_pane: [afterNew, afterResume].every(
      (snapshot) =>
        snapshot.tmux_target === scenario.tmux_target &&
        snapshot.pane_pid === scenario.pane_pid
    ) &&
      before.tmux_target === scenario.tmux_target &&
      before.pane_pid === scenario.pane_pid,
    same_process_incarnation: [afterNew, afterResume].every(
      (snapshot) =>
        snapshot.agent_pid === before.agent_pid &&
        snapshot.process_uuid_fingerprint === before.process_uuid_fingerprint &&
        snapshot.process_birth_fingerprint === before.process_birth_fingerprint
    ),
    same_workspace: [afterNew, afterResume].every(
      (snapshot) => snapshot.workspace_fingerprint === before.workspace_fingerprint
    )
  };
  for (const key of Object.keys(recomputed) as Array<keyof typeof recomputed>) {
    if (assertions[key] !== recomputed[key] || recomputed[key] !== true) {
      fail(
        "relationship_invalid",
        `${path}.assertions.${key} is not proven by the evidence.`
      );
    }
  }
  if (send.status !== "completed") {
    fail("turn_not_completed", `${agent} sentinel Turn did not complete.`);
  }
  if (
    newTransition.status !== "committed" ||
    resumeTransition.status !== "committed"
  ) {
    fail("transition_not_committed", `${agent} lifecycle transition was not committed.`);
  }

  return {
    status: scenario.status as LiveLifecycleResultStatus,
    agent_version: scenario.agent_version as string,
    tmux_target: scenario.tmux_target as string,
    pane_pid: scenario.pane_pid as number,
    started_at: scenario.started_at as string,
    completed_at: scenario.completed_at as string,
    snapshots: { before, after_new: afterNew, after_resume: afterResume },
    resume_candidate: resumeCandidate,
    send,
    transitions: { new_thread: newTransition, resume_thread: resumeTransition },
    turn_deltas: { new_thread: 0, send: 1, resume_thread: 0 },
    assertions,
    steps
  };
}

function assertSnapshot(
  value: unknown,
  path: string
): LiveLifecycleFingerprintSnapshot {
  const snapshot = requireRecord(value, path, [
    "tmux_target",
    "pane_pid",
    "agent_pid",
    "process_uuid_fingerprint",
    "process_birth_fingerprint",
    "workspace_fingerprint",
    "native_thread_fingerprint",
    "session_fingerprint",
    "binding_fingerprint",
    "binding_generation",
    "idle"
  ], [
    "tmux_target",
    "pane_pid",
    "agent_pid",
    "process_uuid_fingerprint",
    "workspace_fingerprint",
    "native_thread_fingerprint",
    "session_fingerprint",
    "binding_fingerprint",
    "binding_generation",
    "idle"
  ]);
  requireBoundedString(snapshot.tmux_target, `${path}.tmux_target`, 512);
  assertSafeInteger(snapshot.pane_pid, "invalid_pane_pid", `${path}.pane_pid`, 2);
  assertSafeInteger(snapshot.agent_pid, "invalid_agent_pid", `${path}.agent_pid`, 2);
  assertFingerprint(
    snapshot.process_uuid_fingerprint,
    `${path}.process_uuid_fingerprint`
  );
  if (snapshot.process_birth_fingerprint !== undefined) {
    assertFingerprint(
      snapshot.process_birth_fingerprint,
      `${path}.process_birth_fingerprint`
    );
  }
  assertFingerprint(snapshot.workspace_fingerprint, `${path}.workspace_fingerprint`);
  assertFingerprint(
    snapshot.native_thread_fingerprint,
    `${path}.native_thread_fingerprint`
  );
  assertFingerprint(snapshot.session_fingerprint, `${path}.session_fingerprint`);
  assertFingerprint(snapshot.binding_fingerprint, `${path}.binding_fingerprint`);
  assertSafeInteger(
    snapshot.binding_generation,
    "invalid_binding_generation",
    `${path}.binding_generation`,
    0
  );
  if (typeof snapshot.idle !== "boolean") {
    fail("invalid_boolean", `${path}.idle must be boolean.`);
  }
  return snapshot as unknown as LiveLifecycleFingerprintSnapshot;
}

function assertResumeCandidate(
  value: unknown,
  path: string
): LiveLifecycleResumeCandidateEvidence {
  const candidate = requireRecord(value, path, [
    "native_thread_fingerprint",
    "exact_candidate_count",
    "resumable",
    "active_elsewhere",
    "fresh_candidate_token_present"
  ]);
  assertFingerprint(
    candidate.native_thread_fingerprint,
    `${path}.native_thread_fingerprint`
  );
  assertSafeInteger(
    candidate.exact_candidate_count,
    "invalid_candidate_count",
    `${path}.exact_candidate_count`,
    0
  );
  for (const key of [
    "resumable",
    "active_elsewhere",
    "fresh_candidate_token_present"
  ] as const) {
    if (typeof candidate[key] !== "boolean") {
      fail("invalid_boolean", `${path}.${key} must be boolean.`);
    }
  }
  return candidate as unknown as LiveLifecycleResumeCandidateEvidence;
}

function assertTransition(
  value: unknown,
  path: string
): LiveLifecycleTransitionEvidence {
  const transition = requireRecord(value, path, [
    "status",
    "transition_fingerprint",
    "source_session_fingerprint",
    "target_session_fingerprint",
    "source_binding_fingerprint",
    "target_binding_fingerprint"
  ]);
  if (!(["committed", "failed", "uncertain"] as unknown[]).includes(transition.status)) {
    fail("invalid_transition_status", `${path}.status is invalid.`);
  }
  for (const key of [
    "transition_fingerprint",
    "source_session_fingerprint",
    "target_session_fingerprint",
    "source_binding_fingerprint",
    "target_binding_fingerprint"
  ] as const) {
    assertFingerprint(transition[key], `${path}.${key}`);
  }
  return transition as unknown as LiveLifecycleTransitionEvidence;
}

function assertSend(value: unknown, path: string): LiveLifecycleTurnEvidence {
  const send = requireRecord(value, path, [
    "status",
    "turn_fingerprint",
    "session_fingerprint",
    "binding_fingerprint",
    "binding_generation"
  ]);
  if (!(["completed", "failed", "uncertain"] as unknown[]).includes(send.status)) {
    fail("invalid_turn_status", `${path}.status is invalid.`);
  }
  assertFingerprint(send.turn_fingerprint, `${path}.turn_fingerprint`);
  assertFingerprint(send.session_fingerprint, `${path}.session_fingerprint`);
  assertFingerprint(send.binding_fingerprint, `${path}.binding_fingerprint`);
  assertSafeInteger(
    send.binding_generation,
    "invalid_binding_generation",
    `${path}.binding_generation`,
    0
  );
  return send as unknown as LiveLifecycleTurnEvidence;
}

function assertAssertions(
  value: unknown,
  path: string
): LiveLifecycleRelationshipAssertions {
  const keys: Array<keyof LiveLifecycleRelationshipAssertions> = [
    "start_idle",
    "new_idle",
    "final_idle",
    "new_native_thread_differs",
    "final_native_thread_matches_start",
    "resume_candidate_matches_start",
    "new_session_differs",
    "resumed_session_matches_start",
    "original_binding_generation_advanced",
    "binding_generations_exact",
    "binding_fingerprints_distinct",
    "send_bound_to_new_session",
    "transitions_match_sessions",
    "transitions_match_bindings",
    "transitions_distinct",
    "resume_candidate_safe",
    "same_tmux_pane",
    "same_process_incarnation",
    "same_workspace"
  ];
  const assertions = requireRecord(value, path, keys);
  for (const key of keys) {
    if (typeof assertions[key] !== "boolean") {
      fail("invalid_boolean", `${path}.${key} must be boolean.`);
    }
  }
  return assertions as unknown as LiveLifecycleRelationshipAssertions;
}

function assertSteps(
  value: unknown,
  path: string,
  scenarioStatus: LiveLifecycleResultStatus,
  failureStage?: LiveLifecycleStepName
): LiveLifecycleStepEvidence[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > STEP_NAMES.length ||
    (scenarioStatus === "passed" && value.length !== STEP_NAMES.length)
  ) {
    fail(
      "steps_invalid",
      `${path} must contain a non-empty prefix of the fixed ${STEP_NAMES.length}-step sequence.`
    );
  }
  const steps = value.map((entry, index) => {
    const stepPath = `${path}[${index}]`;
    const step = requireRecord(entry, stepPath, ["name", "status", "duration_ms"]);
    assertLiteral(step.name, STEP_NAMES[index], "steps_invalid", `${stepPath}.name`);
    assertStatus(step.status, `${stepPath}.status`);
    assertSafeInteger(
      step.duration_ms,
      "invalid_step_duration",
      `${stepPath}.duration_ms`,
      0
    );
    return step as unknown as LiveLifecycleStepEvidence;
  });
  if (scenarioStatus === "passed") {
    if (steps.some((step) => step.status !== "passed")) {
      fail("status_not_passed", `${path} contains a non-passing step.`);
    }
  } else {
    const last = steps.at(-1)!;
    if (
      last.status !== scenarioStatus ||
      last.name !== failureStage ||
      steps.slice(0, -1).some((step) => step.status !== "passed")
    ) {
      fail(
        "failure_step_mismatch",
        `${path} must end at failure_stage with the scenario status.`
      );
    }
  }
  return steps;
}

function assertRawEnvelope(input: RawLiveLifecycleEvidenceInput): void {
  if (!isPlainRecord(input)) {
    fail("invalid_input", "Raw evidence input must be a plain object.");
  }
  requireBoundedString(input.packageName, "packageName", 256);
  requireBoundedString(input.packageVersion, "packageVersion", 128);
  assertPattern(input.commit, /^[0-9a-f]{40}$/u, "invalid_commit", "commit");
  if (typeof input.worktreeClean !== "boolean") {
    fail("invalid_boolean", "worktreeClean must be boolean.");
  }
  parseTimestamp(input.startedAt, "startedAt");
  parseTimestamp(input.completedAt, "completedAt");
  if (!isPlainRecord(input.scenarios)) {
    fail("invalid_input", "scenarios must be a plain object.");
  }
  for (const key of Object.keys(input.scenarios)) {
    if (!(AGENTS as readonly string[]).includes(key)) {
      fail("unknown_agent", `Unsupported live-smoke agent: ${key}`);
    }
  }
}

function assertRawScenario(raw: RawLiveLifecycleScenarioResult): void {
  if (!isPlainRecord(raw)) {
    fail("invalid_input", "Raw scenario must be a plain object.");
  }
  assertStatus(raw.status, "scenario.status", false);
  if (raw.agentVersion !== undefined) {
    requireBoundedString(raw.agentVersion, "agentVersion", 128);
  }
  if (raw.doNotRetry !== undefined && raw.doNotRetry !== true) {
    fail("invalid_boolean", "doNotRetry must be true when present.");
  }
  requireBoundedString(raw.tmuxTarget, "tmuxTarget", 512);
  assertSafeInteger(raw.panePid, "invalid_pane_pid", "panePid", 2);
  parseTimestamp(raw.startedAt, "scenario.startedAt");
  parseTimestamp(raw.completedAt, "scenario.completedAt");
  if (!Array.isArray(raw.steps)) {
    fail("steps_invalid", "Raw scenario steps must be an array.");
  }
  for (const step of raw.steps) {
    if (!isPlainRecord(step)) {
      fail("steps_invalid", "Raw scenario step must be an object.");
    }
    assertStatus(step.status, "scenario.step.status", false);
    assertSafeInteger(step.durationMs, "invalid_step_duration", "durationMs", 0);
  }
  for (const generation of [
    raw.before?.bindingGeneration,
    raw.afterNew?.bindingGeneration,
    raw.afterResume?.bindingGeneration,
    raw.send?.bindingGeneration
  ]) {
    if (generation === undefined) {
      continue;
    }
    assertSafeInteger(
      generation,
      "invalid_binding_generation",
      "bindingGeneration",
      0
    );
  }
  if (raw.resumeCandidate !== undefined) {
    requireRawIdentifier(
      raw.resumeCandidate.nativeThreadId,
      "resume_candidate_native_thread"
    );
    assertSafeInteger(
      raw.resumeCandidate.exactCandidateCount,
      "invalid_candidate_count",
      "exactCandidateCount",
      0
    );
    for (const value of [
      raw.resumeCandidate.resumable,
      raw.resumeCandidate.activeElsewhere,
      raw.resumeCandidate.freshCandidateTokenPresent
    ]) {
      if (typeof value !== "boolean") {
        fail("invalid_boolean", "Resume candidate flags must be boolean.");
      }
    }
  }
}

function requireReasonCode(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(value)
  ) {
    fail(
      "invalid_reason_code",
      `${path} must be a safe lowercase reason code, not a raw error message.`
    );
  }
  return value;
}

function deriveResultStatus(
  statuses: readonly (LiveLifecycleResultStatus | LiveLifecycleTurnStatus | LiveLifecycleTransitionStatus)[]
): LiveLifecycleResultStatus {
  if (statuses.includes("uncertain")) {
    return "uncertain";
  }
  if (statuses.includes("failed")) {
    return "failed";
  }
  return "passed";
}

function scanForSensitiveMaterial(
  value: unknown,
  path: string,
  seen: Set<unknown>
): void {
  if (typeof value === "string") {
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu.test(value)) {
      fail("raw_uuid", `Raw UUID-like value is forbidden at ${path}.`);
    }
    if (
      /(?:^|\b)(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/u.test(value) ||
      /(?:bearer\s+[A-Za-z0-9._~+\/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(value)
    ) {
      fail("secret_material", `Secret-like value is forbidden at ${path}.`);
    }
    if (/^(?:\/(?:Users|home|private|var|tmp)\/|[A-Za-z]:\\)/u.test(value)) {
      fail("raw_path", `Raw local path is forbidden at ${path}.`);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    fail("cyclic_value", `Cyclic value is forbidden at ${path}.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForSensitiveMaterial(entry, `${path}[${index}]`, seen)
    );
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(?:prompt|nonce|stdout|stderr|screen|callback|callback_payload|token|tokens|api_key|secret|password|raw|raw_.+|workspace|native_thread_id|session_id|turn_id|transition_id|binding_id|process_id)$/iu.test(key)
      ) {
        fail("sensitive_key", `Sensitive evidence key is forbidden at ${path}.${key}.`);
      }
      scanForSensitiveMaterial(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function requireRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
  allowMissingAllowed = false
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail("invalid_shape", `${path} must be a plain object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      fail("unknown_key", `Unknown evidence key: ${path}.${key}.`);
    }
  }
  if (!allowMissingAllowed) {
    for (const key of requiredKeys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        fail("missing_key", `Missing evidence key: ${path}.${key}.`);
      }
    }
  }
  return record;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertStatus(
  value: unknown,
  path: string,
  requirePassed = false
): asserts value is LiveLifecycleResultStatus {
  if (!(value === "passed" || value === "failed" || value === "uncertain")) {
    fail("invalid_status", `${path} has an invalid status.`);
  }
  if (requirePassed && value !== "passed") {
    fail("status_not_passed", `${path} must be passed.`);
  }
}

function assertFingerprint(value: unknown, path: string): asserts value is string {
  assertPattern(
    value,
    /^sha256:[0-9a-f]{64}$/u,
    "invalid_fingerprint",
    path
  );
}

function assertPattern(
  value: unknown,
  pattern: RegExp,
  code: string,
  path: string
): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(code, `${path} has an invalid format.`);
  }
}

function assertLiteral<T>(
  value: unknown,
  expected: T,
  code: string,
  path: string
): asserts value is T {
  if (value !== expected) {
    fail(code, `${path} must equal ${String(expected)}.`);
  }
}

function assertExpectedValue(
  actual: string,
  expected: string,
  code: string,
  path: string
): void {
  if (actual !== expected) {
    fail(code, `${path} does not match the expected release value.`);
  }
}

function assertSafeInteger(
  value: unknown,
  code: string,
  path: string,
  minimum: number
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(code, `${path} must be a safe integer >= ${minimum}.`);
  }
}

function assertExactInteger(value: unknown, expected: number, path: string): void {
  if (value !== expected) {
    fail("turn_delta_invalid", `${path} must equal ${expected}.`);
  }
}

function requireBoundedString(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail("invalid_string", `${path} must be a non-empty string <= ${max} characters.`);
  }
  return value;
}

function requireRawIdentifier(value: unknown, path: string): string {
  return requireBoundedString(value, `raw.${path}`, 4_096);
}

function parseTimestamp(value: unknown, path: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    fail("invalid_timestamp", `${path} must be an RFC3339 timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail("invalid_timestamp", `${path} must be an RFC3339 timestamp.`);
  }
  return parsed;
}

function parseNow(value: Date | string | number | undefined): number {
  if (value === undefined) {
    return Date.now();
  }
  const parsed = value instanceof Date ? value.getTime() :
    typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail("invalid_now", "Validation option now must be a valid date or epoch milliseconds.");
  }
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("noncanonical_value", "Canonical evidence cannot contain a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  fail("noncanonical_value", "Canonical evidence contains an unsupported value.");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

function fail(code: string, message: string): never {
  throw new LiveLifecycleEvidenceValidationError(code, message);
}
