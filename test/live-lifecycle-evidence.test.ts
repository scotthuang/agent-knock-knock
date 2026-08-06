import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_LIFECYCLE_ATTESTATION_BEGIN,
  LiveLifecycleEvidenceValidationError,
  create,
  parseAttestation,
  serializeAttestation,
  validate,
  type LiveLifecycleAgent,
  type LiveLifecycleStepName,
  type RawLiveLifecycleEvidenceInput,
  type RawLiveLifecycleScenarioResult,
  type RawLiveLifecycleSnapshot
} from "../src/live-lifecycle-evidence.js";

const COMMIT = "a".repeat(40);
const RUN_ID = "b".repeat(32);
const TEST_SALT = "c".repeat(64);
const STARTED_AT = "2026-08-06T00:00:00.000Z";
const COMPLETED_AT = "2026-08-06T00:10:00.000Z";
const NOW = "2026-08-06T00:11:00.000Z";
const STEPS: LiveLifecycleStepName[] = [
  "preflight",
  "new_thread",
  "send",
  "wait_completion",
  "list_resumable_threads",
  "resume_thread",
  "final_verify"
];

test("creates redacted, domain-separated evidence and round-trips an annotated-tag attestation", () => {
  const input = validInput();
  (input.scenarios.codex as unknown as Record<string, unknown>).prompt =
    "raw prompt must be ignored";
  (input.scenarios.codex!.resumeCandidate as unknown as Record<string, unknown>)
    .candidateToken = "raw-candidate-token-must-be-ignored";
  const evidence = create(input);

  assert.equal(Object.hasOwn(evidence, "fingerprint_salt"), false);
  assert.equal(evidence.overall_status, "passed");
  assert.deepEqual(Object.keys(evidence.matrix).sort(), ["claude", "codex"]);
  assert.equal(validate(evidence, validationOptions()), evidence);

  const serialized = JSON.stringify(evidence);
  for (const raw of rawPrivateValues(input)) {
    assert.equal(serialized.includes(raw), false, `leaked raw value: ${raw}`);
  }
  assert.doesNotMatch(serialized, /prompt|nonce|stdout|stderr|callback_payload/u);
  assert.doesNotMatch(serialized, /"(?:candidate|binding)_token"/u);

  const codex = evidence.matrix.codex!;
  assert.match(codex.snapshots.before!.native_thread_fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(
    codex.snapshots.before!.native_thread_fingerprint,
    codex.snapshots.before!.session_fingerprint
  );
  assert.equal(
    codex.snapshots.before!.native_thread_fingerprint,
    codex.snapshots.after_resume!.native_thread_fingerprint
  );
  assert.equal(
    codex.resume_candidate!.managed_session_fingerprint,
    codex.snapshots.before!.session_fingerprint
  );

  const block = serializeAttestation(evidence);
  assert.match(block, new RegExp(`^${escapeRegex(LIVE_LIFECYCLE_ATTESTATION_BEGIN)}`));
  const decodedAttestation = Buffer.from(block.split("\n")[1], "base64url")
    .toString("utf8");
  assert.doesNotMatch(decodedAttestation, /fingerprint_salt/u);
  assert.doesNotMatch(decodedAttestation, /raw prompt|raw-candidate-token/u);
  for (const raw of rawPrivateValues(input)) {
    assert.equal(decodedAttestation.includes(raw), false);
  }
  const parsed = parseAttestation(`v0.11.0\n\n${block}\n`);
  assert.deepEqual(parsed, evidence);
  assert.equal(serializeAttestation(parsed), block);
});

test("uses an ephemeral per-run salt without making it recoverable from evidence", () => {
  const firstInput = validInput();
  const secondInput = validInput();
  delete firstInput.fingerprintSalt;
  delete secondInput.fingerprintSalt;
  const first = create(firstInput);
  const second = create(secondInput);

  assert.equal(Object.hasOwn(first, "fingerprint_salt"), false);
  assert.equal(Object.hasOwn(second, "fingerprint_salt"), false);
  assert.notEqual(
    first.matrix.codex!.snapshots.before!.workspace_fingerprint,
    second.matrix.codex!.snapshots.before!.workspace_fingerprint
  );
});

test("fingerprints separate identity domains even when raw values are identical", () => {
  const input = validInput();
  const scenario = input.scenarios.codex!;
  const sharedRawIdentity = scenario.before!.nativeThreadId;
  scenario.before!.sessionId = sharedRawIdentity;
  scenario.afterResume!.sessionId = sharedRawIdentity;
  scenario.resumeCandidate!.managedSessionId = sharedRawIdentity;
  scenario.transitions!.newThread!.sourceSessionId = sharedRawIdentity;
  scenario.transitions!.resumeThread!.targetSessionId = sharedRawIdentity;
  const evidence = create(input);

  assert.notEqual(
    evidence.matrix.codex!.snapshots.before!.native_thread_fingerprint,
    evidence.matrix.codex!.snapshots.before!.session_fingerprint
  );
  assert.equal(validate(evidence, validationOptions()), evidence);
});

test("models an unmanaged start without inventing a Session or binding", () => {
  const input = validInput();
  input.scenarios.codex = unmanagedScenario("codex");
  const evidence = create(input);
  const codex = evidence.matrix.codex!;

  assert.equal(codex.snapshots.before!.session_materialized, false);
  assert.equal(codex.snapshots.before!.session_fingerprint, null);
  assert.equal(codex.snapshots.before!.binding_fingerprint, null);
  assert.equal(codex.snapshots.before!.binding_generation, null);
  assert.equal(codex.resume_candidate!.managed_session_fingerprint, null);
  assert.equal(codex.transitions.new_thread!.source_session_fingerprint, null);
  assert.equal(codex.transitions.new_thread!.source_binding_fingerprint, null);
  assert.equal(codex.snapshots.after_new!.session_materialized, true);
  assert.equal(codex.snapshots.after_new!.binding_generation, 1);
  assert.equal(codex.snapshots.after_resume!.session_materialized, true);
  assert.equal(codex.snapshots.after_resume!.binding_generation, 1);
  assert.notEqual(
    codex.snapshots.after_resume!.session_fingerprint,
    codex.snapshots.after_new!.session_fingerprint
  );
  assert.equal(codex.assertions.resume_session_relationship_valid, true);
  assert.equal(validate(evidence, validationOptions()), evidence);
});

test("rejects contradictions in unmanaged Session materialization relationships", async (t) => {
  await t.test("unmanaged snapshot carrying a synthetic Session", () => {
    const input = validInput();
    const scenario = unmanagedScenario("codex");
    scenario.before!.sessionId = "synthetic-session-a";
    input.scenarios.codex = scenario;
    expectCode(() => create(input), "session_materialization_invalid");
  });
  await t.test("new transition claiming a source Session", () => {
    const input = validInput();
    const scenario = unmanagedScenario("codex");
    scenario.transitions!.newThread!.sourceSessionId = "synthetic-session-a";
    input.scenarios.codex = scenario;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("resume candidate claiming a managed Session", () => {
    const input = validInput();
    const scenario = unmanagedScenario("codex");
    scenario.resumeCandidate!.managedSessionId = "synthetic-session-a";
    input.scenarios.codex = scenario;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("after-new snapshot remaining unmanaged", () => {
    const input = validInput();
    const scenario = unmanagedScenario("codex");
    scenario.afterNew = {
      ...scenario.afterNew!,
      sessionMaterialized: false,
      sessionId: null,
      bindingId: null,
      bindingGeneration: null
    };
    input.scenarios.codex = scenario;
    expectCode(() => create(input), "session_materialization_invalid");
  });
  await t.test("resume materializing A at generation two", () => {
    const input = validInput();
    const scenario = unmanagedScenario("codex");
    scenario.afterResume!.bindingGeneration = 2;
    input.scenarios.codex = scenario;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("resume reusing B's Session for A", () => {
    const input = validInput();
    const scenario = unmanagedScenario("codex");
    scenario.afterResume!.sessionId = scenario.afterNew!.sessionId;
    scenario.transitions!.resumeThread!.targetSessionId =
      scenario.afterNew!.sessionId!;
    input.scenarios.codex = scenario;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
});

test("canonical digest rejects content tampering and strict schema rejects unknown or sensitive keys", () => {
  const evidence = create(validInput());
  const badDigest = structuredClone(evidence);
  badDigest.digest = `${badDigest.digest.slice(0, -1)}${
    badDigest.digest.endsWith("0") ? "1" : "0"
  }`;
  expectCode(() => validate(badDigest, validationOptions()), "digest_mismatch");

  const unknown = structuredClone(evidence) as unknown as Record<string, unknown>;
  unknown.extra = true;
  expectCode(() => validate(unknown, validationOptions()), "unknown_key");

  const sensitive = structuredClone(evidence) as unknown as Record<string, unknown>;
  sensitive.stdout = "harmless-looking but forbidden";
  expectCode(() => validate(sensitive, validationOptions()), "sensitive_key");

  const missingCandidateSession = structuredClone(evidence);
  delete (missingCandidateSession.matrix.codex!.resume_candidate as unknown as
    Record<string, unknown>).managed_session_fingerprint;
  expectCode(
    () => validate(missingCandidateSession, validationOptions()),
    "missing_key"
  );
});

test("validates exact package name, version, commit, and clean worktree", () => {
  const evidence = create(validInput());
  expectCode(() => validate(evidence, {
    ...validationOptions(),
    expectedPackageName: "@other/package"
  }), "package_name_mismatch");
  expectCode(() => validate(evidence, {
    ...validationOptions(),
    expectedPackageVersion: "9.9.9"
  }), "package_version_mismatch");
  expectCode(() => validate(evidence, {
    ...validationOptions(),
    expectedCommit: "d".repeat(40)
  }), "commit_mismatch");

  const dirtyInput = validInput();
  dirtyInput.worktreeClean = false;
  expectCode(
    () => validate(create(dirtyInput), validationOptions()),
    "dirty_worktree"
  );
});

test("enforces the 72-hour age and five-minute future clock-skew bounds", () => {
  const evidence = create(validInput());
  expectCode(() => validate(evidence, {
    ...validationOptions(),
    now: "2026-08-09T00:10:01.000Z"
  }), "stale_evidence");
  expectCode(() => validate(evidence, {
    ...validationOptions(),
    now: "2026-08-06T00:04:59.000Z"
  }), "future_evidence");
  assert.equal(validate(evidence, {
    ...validationOptions(),
    now: "2026-08-06T00:05:00.000Z"
  }), evidence);
});

test("enforces freshness per agent and bounds the overall run duration", () => {
  const perAgent = validInput();
  perAgent.startedAt = "2026-08-06T00:00:00.000Z";
  perAgent.completedAt = "2026-08-06T02:00:00.000Z";
  perAgent.scenarios.codex!.startedAt = "2026-08-06T00:10:00.000Z";
  perAgent.scenarios.codex!.completedAt = "2026-08-06T00:30:00.000Z";
  perAgent.scenarios.claude!.startedAt = "2026-08-06T01:00:00.000Z";
  perAgent.scenarios.claude!.completedAt = "2026-08-06T01:50:00.000Z";
  expectCode(() => validate(create(perAgent), {
    ...validationOptions(),
    now: "2026-08-06T02:01:00.000Z",
    maxAgeHours: 1
  }), "stale_scenario");

  const tooLong = validInput();
  tooLong.completedAt = "2026-08-06T07:00:00.001Z";
  expectCode(() => validate(create(tooLong), {
    ...validationOptions(),
    now: "2026-08-06T07:01:00.000Z"
  }), "run_duration_exceeded");
});

test("a preflight failure remains machine-readable but cannot become release attestation", () => {
  const input = validInput();
  input.scenarios.codex = failedPreflightScenario("codex");
  const evidence = create(input);

  assert.equal(evidence.overall_status, "failed");
  assert.equal(evidence.matrix.codex!.failure_stage, "preflight");
  assert.equal(evidence.matrix.codex!.reason_code, "pane_not_idle");
  assert.deepEqual(evidence.matrix.codex!.snapshots, {});
  assert.equal(evidence.matrix.codex!.send, undefined);
  assert.equal(evidence.matrix.codex!.steps.length, 1);
  expectCode(() => validate(evidence, validationOptions()), "status_not_passed");
  expectCode(() => serializeAttestation(evidence), "status_not_passed");
});

test("an uncertain new-thread submission records only safe partial progress and is rejected", () => {
  const input = validInput();
  input.scenarios.codex = uncertainNewScenario("codex");
  const evidence = create(input);
  const codex = evidence.matrix.codex!;

  assert.equal(evidence.overall_status, "uncertain");
  assert.equal(codex.failure_stage, "new_thread");
  assert.equal(codex.reason_code, "transition_outcome_uncertain");
  assert.equal(codex.do_not_retry, true);
  assert.ok(codex.snapshots.before);
  assert.equal(codex.snapshots.after_new, undefined);
  assert.equal(codex.transitions.new_thread!.status, "uncertain");
  assert.equal(codex.steps.at(-1)!.status, "uncertain");
  expectCode(() => validate(evidence, validationOptions()), "status_not_passed");
});

test("uncertain lifecycle mutation cannot omit the durable do-not-retry guard", () => {
  const input = validInput();
  const uncertain = uncertainNewScenario("codex");
  delete uncertain.doNotRetry;
  input.scenarios.codex = uncertain;
  expectCode(() => create(input), "retry_guard_missing");
});

test("an omitted not-run agent makes partial matrix evidence non-passing", () => {
  const input = validInput();
  delete input.scenarios.claude;
  const evidence = create(input);

  assert.equal(evidence.overall_status, "failed");
  assert.deepEqual(Object.keys(evidence.matrix), ["codex"]);
  expectCode(() => validate(evidence, {
    ...validationOptions(),
    requireAgents: ["codex"]
  }), "status_not_passed");
  expectCode(() => serializeAttestation(evidence), "status_not_passed");
});

test("rejects malformed fixed steps and incorrect Turn deltas", () => {
  const wrongSteps = validInput();
  [wrongSteps.scenarios.codex!.steps[1], wrongSteps.scenarios.codex!.steps[2]] =
    [wrongSteps.scenarios.codex!.steps[2], wrongSteps.scenarios.codex!.steps[1]];
  expectCode(
    () => validate(create(wrongSteps), validationOptions()),
    "steps_invalid"
  );

  const wrongDeltas = validInput();
  wrongDeltas.scenarios.codex!.turnDeltas!.send = 2;
  expectCode(
    () => validate(create(wrongDeltas), validationOptions()),
    "turn_delta_invalid"
  );
});

test("rejects A equals B, final differs from A, and candidate mismatch", async (t) => {
  await t.test("A equals B", () => {
    const input = validInput();
    const scenario = input.scenarios.codex!;
    scenario.afterNew!.nativeThreadId = scenario.before!.nativeThreadId;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("final differs from A", () => {
    const input = validInput();
    input.scenarios.codex!.afterResume!.nativeThreadId =
      "99999999-9999-4999-8999-999999999999";
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("resume candidate differs from A", () => {
    const input = validInput();
    input.scenarios.codex!.resumeCandidate!.nativeThreadId =
      input.scenarios.codex!.afterNew!.nativeThreadId;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("resume candidate points at another managed Session", () => {
    const input = validInput();
    input.scenarios.codex!.resumeCandidate!.managedSessionId =
      input.scenarios.codex!.afterNew!.sessionId;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
});

test("rejects Session, binding generation, send, and transition relationship violations", async (t) => {
  await t.test("resumed Session is not the original", () => {
    const input = validInput();
    input.scenarios.codex!.afterResume!.sessionId =
      "99999999-9999-4999-8999-999999999991";
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("original binding generation did not advance", () => {
    const input = validInput();
    input.scenarios.codex!.afterResume!.bindingGeneration = 1;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("new Session binding does not start at generation one", () => {
    const input = validInput();
    input.scenarios.codex!.afterNew!.bindingGeneration = 2;
    input.scenarios.codex!.send!.bindingGeneration = 2;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("original binding generation skips a generation", () => {
    const input = validInput();
    input.scenarios.codex!.afterResume!.bindingGeneration = 3;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("binding incarnations are not distinct", () => {
    const input = validInput();
    input.scenarios.codex!.afterResume!.bindingId =
      input.scenarios.codex!.before!.bindingId;
    input.scenarios.codex!.transitions!.resumeThread!.targetBindingId =
      input.scenarios.codex!.before!.bindingId!;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("send is bound to another Session", () => {
    const input = validInput();
    input.scenarios.codex!.send!.sessionId =
      input.scenarios.codex!.before!.sessionId!;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("resume transition targets the wrong binding", () => {
    const input = validInput();
    input.scenarios.codex!.transitions!.resumeThread!.targetBindingId =
      input.scenarios.codex!.afterNew!.bindingId!;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
  await t.test("new and resume share a transition identity", () => {
    const input = validInput();
    input.scenarios.codex!.transitions!.resumeThread!.transitionId =
      input.scenarios.codex!.transitions!.newThread!.transitionId;
    expectCode(
      () => validate(create(input), validationOptions()),
      "relationship_invalid"
    );
  });
});

test("rejects pane, process incarnation, and workspace drift", async (t) => {
  const cases: Array<[string, (scenario: RawLiveLifecycleScenarioResult) => void]> = [
    ["pane", (scenario) => { scenario.afterNew!.panePid += 1; }],
    ["reported target", (scenario) => { scenario.tmuxTarget = "tmux-test:9.9"; }],
    ["agent pid", (scenario) => { scenario.afterNew!.agentPid += 1; }],
    ["process", (scenario) => { scenario.afterNew!.processUuid = "restarted-process"; }],
    ["process birth", (scenario) => {
      scenario.afterNew!.processBirth = "reused-process-birth";
    }],
    ["workspace", (scenario) => { scenario.afterNew!.workspace = "/tmp/other-workspace"; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const input = validInput();
      mutate(input.scenarios.codex!);
      expectCode(
        () => validate(create(input), validationOptions()),
        "relationship_invalid"
      );
    });
  }
});

test("requires one safe exact resume candidate with fresh token evidence", async (t) => {
  const cases: Array<[string, (scenario: RawLiveLifecycleScenarioResult) => void]> = [
    ["count", (scenario) => { scenario.resumeCandidate!.exactCandidateCount = 2; }],
    ["resumable", (scenario) => { scenario.resumeCandidate!.resumable = false; }],
    ["active elsewhere", (scenario) => { scenario.resumeCandidate!.activeElsewhere = true; }],
    ["fresh token", (scenario) => {
      scenario.resumeCandidate!.freshCandidateTokenPresent = false;
    }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const input = validInput();
      mutate(input.scenarios.codex!);
      expectCode(
        () => validate(create(input), validationOptions()),
        "relationship_invalid"
      );
    });
  }
});

test("rejects raw UUIDs and secret-like strings even in allowlisted plaintext fields", () => {
  const uuidTarget = validInput();
  const rawUuid = "99999999-9999-4999-8999-999999999999";
  uuidTarget.scenarios.codex!.tmuxTarget = rawUuid;
  expectCode(
    () => validate(create(uuidTarget), validationOptions()),
    "raw_uuid"
  );

  const secretVersion = validInput();
  secretVersion.scenarios.codex!.agentVersion = `sk-${"x".repeat(32)}`;
  expectCode(
    () => validate(create(secretVersion), validationOptions()),
    "secret_material"
  );
});

test("attestation parser rejects duplicate markers and payload tampering", () => {
  const block = serializeAttestation(create(validInput()));
  expectCode(
    () => parseAttestation(`${block}\n${block}`),
    "invalid_attestation_markers"
  );

  const lines = block.split("\n");
  const payload = lines[1];
  const replacement = payload[0] === "A" ? "B" : "A";
  lines[1] = `${replacement}${payload.slice(1)}`;
  assert.throws(
    () => parseAttestation(lines.join("\n")),
    (error: unknown) => error instanceof LiveLifecycleEvidenceValidationError
  );
});

function validInput(): RawLiveLifecycleEvidenceInput {
  return {
    packageName: "@scotthuang/agent-knock-knock",
    packageVersion: "0.10.0",
    commit: COMMIT,
    worktreeClean: true,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    runId: RUN_ID,
    fingerprintSalt: TEST_SALT,
    scenarios: {
      codex: validScenario("codex"),
      claude: validScenario("claude")
    }
  };
}

function validScenario(agent: LiveLifecycleAgent): RawLiveLifecycleScenarioResult {
  const codex = agent === "codex";
  const target = codex ? "tmux-test:0.0" : "tmux-test:0.1";
  const panePid = codex ? 4101 : 4102;
  const aNative = codex
    ? "11111111-1111-4111-8111-111111111111"
    : "33333333-3333-4333-8333-333333333333";
  const bNative = codex
    ? "22222222-2222-4222-8222-222222222222"
    : "44444444-4444-4444-8444-444444444444";
  const aSession = `${agent}-session-a`;
  const bSession = `${agent}-session-b`;
  const aBinding1 = `${agent}-binding-a-generation-1`;
  const bBinding1 = `${agent}-binding-b-generation-1`;
  const aBinding2 = `${agent}-binding-a-generation-2`;
  const agentPid = codex ? 9101 : 9102;
  const processUuid = `${agent}-process-uuid`;
  const processBirth = `${agent}-birth-1786000000`;
  const workspace = `/Users/example/work/${agent}`;
  const base = {
    tmuxTarget: target,
    panePid,
    agentPid,
    processUuid,
    processBirth,
    workspace,
    idle: true
  };
  const before: RawLiveLifecycleSnapshot = {
    ...base,
    nativeThreadId: aNative,
    sessionMaterialized: true,
    sessionId: aSession,
    bindingId: aBinding1,
    bindingGeneration: 1
  };
  const afterNew: RawLiveLifecycleSnapshot = {
    ...base,
    nativeThreadId: bNative,
    sessionMaterialized: true,
    sessionId: bSession,
    bindingId: bBinding1,
    bindingGeneration: 1
  };
  const afterResume: RawLiveLifecycleSnapshot = {
    ...base,
    nativeThreadId: aNative,
    sessionMaterialized: true,
    sessionId: aSession,
    bindingId: aBinding2,
    bindingGeneration: 2
  };
  return {
    status: "passed",
    agentVersion: codex ? "0.146.1" : "2.1.218",
    tmuxTarget: target,
    panePid,
    startedAt: codex
      ? "2026-08-06T00:00:10.000Z"
      : "2026-08-06T00:05:00.000Z",
    completedAt: codex
      ? "2026-08-06T00:04:50.000Z"
      : "2026-08-06T00:09:50.000Z",
    before,
    afterNew,
    afterResume,
    resumeCandidate: {
      nativeThreadId: aNative,
      managedSessionId: aSession,
      exactCandidateCount: 1,
      resumable: true,
      activeElsewhere: false,
      freshCandidateTokenPresent: true
    },
    send: {
      status: "completed",
      turnId: `${agent}-turn-in-b`,
      sessionId: bSession,
      bindingId: bBinding1,
      bindingGeneration: 1
    },
    transitions: {
      newThread: {
        status: "committed",
        transitionId: `${agent}-transition-new`,
        sourceSessionId: aSession,
        targetSessionId: bSession,
        sourceBindingId: aBinding1,
        targetBindingId: bBinding1
      },
      resumeThread: {
        status: "committed",
        transitionId: `${agent}-transition-resume`,
        sourceSessionId: bSession,
        targetSessionId: aSession,
        sourceBindingId: bBinding1,
        targetBindingId: aBinding2
      }
    },
    turnDeltas: {
      newThread: 0,
      send: 1,
      resumeThread: 0
    },
    steps: STEPS.map((name, index) => ({
      name,
      status: "passed",
      durationMs: (index + 1) * 10
    }))
  };
}

function unmanagedScenario(
  agent: LiveLifecycleAgent
): RawLiveLifecycleScenarioResult {
  const scenario = validScenario(agent);
  scenario.resumeCandidate!.managedSessionId = null;
  scenario.before = {
    ...scenario.before!,
    sessionMaterialized: false,
    sessionId: null,
    bindingId: null,
    bindingGeneration: null
  };
  scenario.afterResume = {
    ...scenario.afterResume!,
    bindingGeneration: 1
  };
  scenario.transitions = {
    newThread: {
      ...scenario.transitions!.newThread!,
      sourceSessionId: null,
      sourceBindingId: null
    },
    resumeThread: {
      ...scenario.transitions!.resumeThread!,
      targetSessionId: scenario.afterResume.sessionId!,
      targetBindingId: scenario.afterResume.bindingId!
    }
  };
  return scenario;
}

function failedPreflightScenario(
  agent: LiveLifecycleAgent
): RawLiveLifecycleScenarioResult {
  const base = validScenario(agent);
  return {
    status: "failed",
    failureStage: "preflight",
    reasonCode: "pane_not_idle",
    tmuxTarget: base.tmuxTarget,
    panePid: base.panePid,
    startedAt: base.startedAt,
    completedAt: base.startedAt,
    steps: [{ name: "preflight", status: "failed", durationMs: 10 }]
  };
}

function uncertainNewScenario(
  agent: LiveLifecycleAgent
): RawLiveLifecycleScenarioResult {
  const base = validScenario(agent);
  return {
    status: "uncertain",
    failureStage: "new_thread",
    reasonCode: "transition_outcome_uncertain",
    doNotRetry: true,
    agentVersion: base.agentVersion,
    tmuxTarget: base.tmuxTarget,
    panePid: base.panePid,
    startedAt: base.startedAt,
    completedAt: base.completedAt,
    before: base.before,
    transitions: {
      newThread: {
        ...base.transitions!.newThread!,
        status: "uncertain"
      }
    },
    steps: [
      { name: "preflight", status: "passed", durationMs: 10 },
      { name: "new_thread", status: "uncertain", durationMs: 20 }
    ]
  };
}

function validationOptions() {
  return {
    expectedPackageName: "@scotthuang/agent-knock-knock",
    expectedPackageVersion: "0.10.0",
    expectedCommit: COMMIT,
    now: NOW
  };
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) =>
    error instanceof LiveLifecycleEvidenceValidationError && error.code === code
  );
}

function rawPrivateValues(input: RawLiveLifecycleEvidenceInput): string[] {
  const values: string[] = [];
  for (const scenario of Object.values(input.scenarios)) {
    if (scenario === undefined) {
      continue;
    }
    for (const snapshot of [scenario.before, scenario.afterNew, scenario.afterResume]) {
      if (snapshot !== undefined) {
        values.push(
          snapshot.processUuid,
          ...(snapshot.processBirth === undefined ? [] : [snapshot.processBirth]),
          snapshot.workspace,
          snapshot.nativeThreadId,
          ...(snapshot.sessionId === null ? [] : [snapshot.sessionId]),
          ...(snapshot.bindingId === null ? [] : [snapshot.bindingId])
        );
      }
    }
    if (scenario.send !== undefined) {
      values.push(
        scenario.send.turnId,
        scenario.send.sessionId,
        scenario.send.bindingId
      );
    }
    if (scenario.resumeCandidate !== undefined) {
      values.push(
        scenario.resumeCandidate.nativeThreadId,
        ...(scenario.resumeCandidate.managedSessionId === null
          ? []
          : [scenario.resumeCandidate.managedSessionId])
      );
    }
    for (const transition of [
      scenario.transitions?.newThread,
      scenario.transitions?.resumeThread
    ]) {
      if (transition !== undefined) {
        values.push(
          transition.transitionId,
          ...(transition.sourceSessionId === null
            ? []
            : [transition.sourceSessionId]),
          transition.targetSessionId,
          ...(transition.sourceBindingId === null
            ? []
            : [transition.sourceBindingId]),
          transition.targetBindingId
        );
      }
    }
  }
  return [...new Set(values)];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
