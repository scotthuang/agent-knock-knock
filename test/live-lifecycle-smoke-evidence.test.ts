import test from "node:test";
import assert from "node:assert/strict";
import {
  createLiveLifecycleEvidence,
  serializeAttestation,
  validateLiveLifecycleEvidence
} from "../src/live-lifecycle-evidence.js";
import {
  lifecycleMatrixToEvidenceInput
} from "../src/live-lifecycle-smoke-evidence.js";
import type {
  LifecycleMatrixResult,
  LifecycleScenarioResult,
  LifecycleSmokeAgent,
  LifecycleTerminalEvidence
} from "../src/live-lifecycle-smoke.js";

const PACKAGE_NAME = "@scotthuang/agent-knock-knock";
const PACKAGE_VERSION = "0.10.0";
const COMMIT = "a".repeat(40);
const STARTED_AT = Date.now() - 120_000;
const STEP_NAMES = [
  "preflight",
  "new_thread",
  "send",
  "wait_completion",
  "list_resumable_threads",
  "resume_thread",
  "final_verify"
] as const;

test("core matrix conversion creates strict passing full-matrix evidence", () => {
  const matrix = passingMatrix();
  const input = lifecycleMatrixToEvidenceInput(matrix, sourceIdentity());
  const evidence = createLiveLifecycleEvidence({
    ...input,
    runId: "b".repeat(32),
    fingerprintSalt: "c".repeat(64)
  });

  assert.equal(input.scenarios.codex?.before?.sessionMaterialized, false);
  assert.equal(input.scenarios.codex?.before?.sessionId, null);
  assert.equal(input.scenarios.codex?.before?.bindingId, null);
  assert.equal(input.scenarios.codex?.before?.bindingGeneration, null);
  assert.equal(input.scenarios.codex?.resumeCandidate?.managedSessionId, null);
  assert.deepEqual(input.scenarios.codex?.turnDeltas, {
    newThread: 0,
    send: 1,
    resumeThread: 0
  });
  assert.equal(input.scenarios.claude?.before?.processBirth, undefined);

  const validated = validateLiveLifecycleEvidence(evidence, {
    expectedPackageName: PACKAGE_NAME,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedCommit: COMMIT,
    requireAgents: ["codex", "claude"],
    maxAgeHours: 72
  });
  assert.equal(validated.overall_status, "passed");
  assert.equal(
    validated.matrix.codex?.transitions.new_thread?.source_session_fingerprint,
    null
  );
  assert.equal(validated.matrix.codex?.snapshots.after_resume?.binding_generation, 1);
  assert.equal(
    validated.matrix.codex?.assertions.resume_session_relationship_valid,
    true
  );
  assert.equal(
    validated.matrix.codex?.resume_candidate?.managed_session_fingerprint,
    null
  );
  assert.doesNotMatch(JSON.stringify(validated), /fingerprint_salt/u);
  assert.doesNotMatch(
    serializeAttestation(validated),
    /session-a|binding-fence|candidate-token/u
  );
});

test("core conversion durably proves the managed resume candidate Session", () => {
  const matrix: LifecycleMatrixResult = {
    schema: "agent-knock-knock/live-lifecycle-smoke-core-matrix",
    version: 1,
    status: "passed",
    started_at_ms: STARTED_AT,
    finished_at_ms: STARTED_AT + 100_000,
    scenarios: [
      managedPassingScenario("codex"),
      managedPassingScenario("claude")
    ]
  };
  const input = lifecycleMatrixToEvidenceInput(matrix, sourceIdentity());
  const evidence = createLiveLifecycleEvidence({
    ...input,
    runId: "f".repeat(32),
    fingerprintSalt: "1".repeat(64)
  });

  assert.equal(
    input.scenarios.codex?.resumeCandidate?.managedSessionId,
    input.scenarios.codex?.before?.sessionId
  );
  assert.equal(
    evidence.matrix.codex?.resume_candidate?.managed_session_fingerprint,
    evidence.matrix.codex?.snapshots.before?.session_fingerprint
  );
  assert.equal(validateLiveLifecycleEvidence(evidence, {
    expectedPackageName: PACKAGE_NAME,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedCommit: COMMIT,
    requireAgents: ["codex", "claude"],
    maxAgeHours: 72
  }), evidence);
});

test("failed and uncertain partial evidence retain only the candidate Session fingerprint", async (t) => {
  for (const status of ["failed", "uncertain"] as const) {
    await t.test(status, () => {
      const base = managedPassingScenario("codex");
      const scenario: LifecycleScenarioResult = {
        ...base,
        status,
        finished_at_ms: base.started_at_ms + 1_000,
        steps: [
          ...base.steps.slice(0, 5),
          { name: "resume_thread", status, duration_ms: 950 }
        ],
        error_code: status === "failed"
          ? "resume_thread_invalid"
          : "resume_thread_uncertain",
        recovery: "inspect_selected_pane_do_not_retry",
        resume_thread: undefined,
        final: undefined
      };
      const matrix: LifecycleMatrixResult = {
        schema: "agent-knock-knock/live-lifecycle-smoke-core-matrix",
        version: 1,
        status,
        started_at_ms: scenario.started_at_ms,
        finished_at_ms: scenario.finished_at_ms,
        scenarios: [scenario]
      };
      const evidence = createLiveLifecycleEvidence({
        ...lifecycleMatrixToEvidenceInput(matrix, sourceIdentity()),
        runId: status === "failed" ? "2".repeat(32) : "4".repeat(32),
        fingerprintSalt: "3".repeat(64)
      });
      const codex = evidence.matrix.codex!;

      assert.equal(codex.status, status);
      assert.equal(codex.do_not_retry, status === "uncertain" ? true : undefined);
      assert.equal(
        codex.resume_candidate?.managed_session_fingerprint,
        codex.snapshots.before?.session_fingerprint
      );
      assert.equal(JSON.stringify(evidence).includes("codex-session-a"), false);
      assert.throws(() => serializeAttestation(evidence), /must be passed/u);
    });
  }
});

test("core uncertain result converts to durable do-not-retry partial evidence", () => {
  const scenario = passingScenario("codex");
  const uncertain: LifecycleScenarioResult = {
    schema: scenario.schema,
    version: scenario.version,
    agent: scenario.agent,
    target: scenario.target,
    pane_pid: scenario.pane_pid,
    expected_agent_version: scenario.expected_agent_version,
    status: "uncertain",
    started_at_ms: scenario.started_at_ms,
    finished_at_ms: scenario.started_at_ms + 1000,
    steps: [
      { name: "preflight", status: "passed", duration_ms: 10 },
      { name: "new_thread", status: "uncertain", duration_ms: 990 }
    ],
    error_code: "new_thread_uncertain",
    recovery: "inspect_selected_pane_do_not_retry",
    start: scenario.start
  };
  const matrix: LifecycleMatrixResult = {
    schema: "agent-knock-knock/live-lifecycle-smoke-core-matrix",
    version: 1,
    status: "uncertain",
    started_at_ms: uncertain.started_at_ms,
    finished_at_ms: uncertain.finished_at_ms,
    scenarios: [uncertain]
  };

  const evidence = createLiveLifecycleEvidence({
    ...lifecycleMatrixToEvidenceInput(matrix, sourceIdentity()),
    runId: "d".repeat(32),
    fingerprintSalt: "e".repeat(64)
  });
  assert.equal(evidence.overall_status, "uncertain");
  assert.equal(evidence.matrix.codex?.failure_stage, "new_thread");
  assert.equal(evidence.matrix.codex?.reason_code, "new_thread_uncertain");
  assert.equal(evidence.matrix.codex?.do_not_retry, true);
  assert.equal(evidence.matrix.codex?.snapshots.before?.session_materialized, false);
  assert.equal(evidence.matrix.codex?.snapshots.before?.session_fingerprint, null);
  assert.equal(evidence.matrix.codex?.snapshots.before?.binding_fingerprint, null);
  assert.equal(evidence.matrix.codex?.snapshots.after_new, undefined);
  assert.throws(() => serializeAttestation(evidence), /must be passed/u);
});

function passingMatrix(): LifecycleMatrixResult {
  return {
    schema: "agent-knock-knock/live-lifecycle-smoke-core-matrix",
    version: 1,
    status: "passed",
    started_at_ms: STARTED_AT,
    finished_at_ms: STARTED_AT + 100_000,
    scenarios: [passingScenario("codex"), passingScenario("claude")]
  };
}

function passingScenario(agent: LifecycleSmokeAgent): LifecycleScenarioResult {
  const codex = agent === "codex";
  const target = codex ? "akk-live:0.0" : "akk-live:0.1";
  const panePid = codex ? 4101 : 4102;
  const nativeA = codex
    ? "11111111-1111-4111-8111-111111111111"
    : "33333333-3333-4333-8333-333333333333";
  const nativeB = codex
    ? "22222222-2222-4222-8222-222222222222"
    : "44444444-4444-4444-8444-444444444444";
  const start = terminalEvidence(agent, nativeA, null, null, null, 0);
  const afterNew = terminalEvidence(
    agent,
    nativeB,
    `${agent}-session-b`,
    `${agent}-binding-b1`,
    1,
    0
  );
  const final = terminalEvidence(
    agent,
    nativeA,
    `${agent}-session-a`,
    `${agent}-binding-a1`,
    1,
    0
  );
  return {
    schema: "agent-knock-knock/live-lifecycle-smoke-core-result",
    version: 1,
    agent,
    target,
    pane_pid: panePid,
    expected_agent_version: start.agent_version,
    status: "passed",
    started_at_ms: STARTED_AT + (codex ? 1000 : 50_000),
    finished_at_ms: STARTED_AT + (codex ? 45_000 : 95_000),
    steps: STEP_NAMES.map((name) => ({
      name,
      status: "passed" as const,
      duration_ms: 10
    })),
    start,
    new_thread: {
      terminal_id: start.terminal_id,
      transition_id: `${agent}-transition-new`,
      operation: "new_thread",
      previous_session_id: null,
      session_id: `${agent}-session-b`,
      previous_native_thread_id: nativeA,
      native_thread_id: nativeB,
      binding_id: `${agent}-binding-b1`,
      binding_generation: 1,
      turn_created: false
    },
    active_after_new: afterNew,
    turn: {
      session_id: `${agent}-session-b`,
      turn_id: `${agent}-turn-one`,
      status: "idle",
      turn_count_before: 0,
      turn_count_after: 1
    },
    resume_candidate: {
      native_thread_id: nativeA,
      managed_session_id: null,
      exact_candidate_count: 1,
      resumable: true,
      active_elsewhere: false,
      fresh_candidate_token_present: true
    },
    resume_thread: {
      terminal_id: start.terminal_id,
      transition_id: `${agent}-transition-resume`,
      operation: "resume_thread",
      previous_session_id: `${agent}-session-b`,
      session_id: `${agent}-session-a`,
      previous_native_thread_id: nativeB,
      native_thread_id: nativeA,
      binding_id: `${agent}-binding-a1`,
      binding_generation: 1,
      turn_created: false
    },
    final
  };
}

function managedPassingScenario(
  agent: LifecycleSmokeAgent
): LifecycleScenarioResult {
  const scenario = passingScenario(agent);
  const nativeA = scenario.start!.native_thread_id;
  const sessionA = `${agent}-session-a`;
  scenario.start = terminalEvidence(
    agent,
    nativeA,
    sessionA,
    `${agent}-binding-a1`,
    1,
    0
  );
  scenario.new_thread!.previous_session_id = sessionA;
  scenario.resume_candidate!.managed_session_id = sessionA;
  scenario.resume_thread = {
    ...scenario.resume_thread!,
    session_id: sessionA,
    binding_id: `${agent}-binding-a2`,
    binding_generation: 2
  };
  scenario.final = terminalEvidence(
    agent,
    nativeA,
    sessionA,
    `${agent}-binding-a2`,
    2,
    0
  );
  return scenario;
}

function terminalEvidence(
  agent: LifecycleSmokeAgent,
  nativeThreadId: string,
  sessionId: string | null,
  bindingId: string | null,
  bindingGeneration: number | null,
  turnCount: number
): LifecycleTerminalEvidence {
  const codex = agent === "codex";
  return {
    terminal_id:
      `terminal:v2:tmux:${agent}:akk-live:${codex ? "0.0" : "0.1"}:` +
      `${codex ? 5101 : 5102}`,
    agent_pid: codex ? 5101 : 5102,
    process_uuid: `${agent}-process-private`,
    process_birth: codex ? "codex-birth-private" : null,
    workspace: `/private/workspace/${agent}`,
    native_thread_id: nativeThreadId,
    session_id: sessionId,
    binding_id: bindingId,
    binding_generation: bindingGeneration,
    binding_fence: bindingId ?? `${agent}-unmanaged-binding-fence`,
    turn_count: turnCount,
    agent_version: codex ? "0.146.1" : "2.1.218",
    behavior_profile: codex ? "codex-tui-0.146.1" : "claude-code-2.1.218"
  };
}

function sourceIdentity() {
  return {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    commit: COMMIT
  };
}
