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

  assert.equal(input.scenarios.codex?.before?.sessionId, "codex-session-a");
  assert.equal(
    input.scenarios.codex?.before?.bindingId,
    "codex-unmanaged-binding-fence"
  );
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
  assert.doesNotMatch(JSON.stringify(validated), /fingerprint_salt/u);
  assert.doesNotMatch(
    serializeAttestation(validated),
    /session-a|binding-fence|candidate-token/u
  );
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
  const start = terminalEvidence(agent, nativeA, null, null, 1, 0);
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
    `${agent}-binding-a2`,
    2,
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
      previous_session_id: `${agent}-session-a`,
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
      binding_id: `${agent}-binding-a2`,
      binding_generation: 2,
      turn_created: false
    },
    final
  };
}

function terminalEvidence(
  agent: LifecycleSmokeAgent,
  nativeThreadId: string,
  sessionId: string | null,
  bindingId: string | null,
  bindingGeneration: number,
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
    agent_version: codex ? "0.146.0" : "2.1.218",
    behavior_profile: codex ? "codex-tui-0.146.0" : "claude-code-2.1.218"
  };
}

function sourceIdentity() {
  return {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    commit: COMMIT
  };
}
