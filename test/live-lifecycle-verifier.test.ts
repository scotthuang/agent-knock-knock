import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  create,
  parseAttestation,
  type LiveLifecycleAgent,
  type LiveLifecycleStepName,
  type RawLiveLifecycleEvidenceInput,
  type RawLiveLifecycleScenarioResult,
  type RawLiveLifecycleSnapshot
} from "../src/live-lifecycle-evidence.js";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const VERIFIER = path.join(
  PACKAGE_ROOT,
  "scripts",
  "verify-lifecycle-smoke-evidence.js"
);
const PACKAGE_NAME = "@scotthuang/agent-knock-knock";
const PACKAGE_VERSION = "0.10.0";
const COMMIT = "a".repeat(40);
const RUN_ID = "b".repeat(32);
const FINGERPRINT_SALT = "c".repeat(64);
const RAW_TOKEN = "candidate-token-never-print-8f7ad13b";
const STEPS: readonly LiveLifecycleStepName[] = [
  "preflight",
  "new_thread",
  "send",
  "wait_completion",
  "list_resumable_threads",
  "resume_thread",
  "final_verify"
];

test("validates evidence, writes a private annotated-tag message, and round-trips it", (t) => {
  const directory = makeTempDirectory(t);
  const input = validInput();
  const evidence = create(input);
  const evidencePath = path.join(directory, "evidence.json");
  const tagPath = path.join(directory, "tag-message.txt");
  fs.writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });

  const written = runVerifier([
    "--evidence",
    evidencePath,
    "--expected-version",
    PACKAGE_VERSION,
    "--expected-commit",
    COMMIT,
    "--require-matrix",
    "--max-age-hours",
    "72",
    "--output",
    tagPath
  ]);
  assertVerifierStatus(written, 0);
  assert.match(written.stdout, /attestation written: passed digest=sha256:/u);
  assert.equal(written.stderr, "");
  assert.equal(fs.statSync(tagPath).mode & 0o777, 0o600);

  const tagMessage = fs.readFileSync(tagPath, "utf8");
  assert.equal(tagMessage.split("\n", 1)[0], `Release v${PACKAGE_VERSION}`);
  assert.deepEqual(parseAttestation(tagMessage), evidence);
  assertPrivateValuesAbsent(
    `${written.stdout}${written.stderr}${tagMessage}`,
    input
  );

  const verifiedAgain = runVerifier([
    "--attestation",
    tagPath,
    "--expected-version",
    PACKAGE_VERSION,
    "--expected-commit",
    COMMIT,
    "--require-matrix"
  ]);
  assertVerifierStatus(verifiedAgain, 0);
  assert.match(verifiedAgain.stdout, /matrix=claude,codex/u);
  assert.match(verifiedAgain.stdout, /digest=sha256:[0-9a-f]{64}/u);
  assertPrivateValuesAbsent(
    `${verifiedAgain.stdout}${verifiedAgain.stderr}`,
    input
  );
});

test("rejects missing, wrong, stale, incomplete, and failed evidence", async (t) => {
  const directory = makeTempDirectory(t);
  const cases: Array<{
    name: string;
    evidence?: ReturnType<typeof create>;
    expectedCode: string;
    expectedVersion?: string;
  }> = [
    {
      name: "missing file",
      expectedCode: "input_read_failed"
    },
    {
      name: "wrong release version",
      evidence: create(validInput()),
      expectedCode: "package_version_mismatch",
      expectedVersion: "9.9.9"
    },
    {
      name: "stale evidence",
      evidence: create(validInput(new Date(Date.now() - 96 * 60 * 60 * 1_000))),
      expectedCode: "stale_evidence"
    },
    {
      name: "incomplete matrix",
      evidence: create(incompleteInput()),
      expectedCode: "status_not_passed"
    },
    {
      name: "failed scenario",
      evidence: create(failedInput()),
      expectedCode: "status_not_passed"
    }
  ];

  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, () => {
      const evidencePath = path.join(directory, `case-${index}.json`);
      if (entry.evidence !== undefined) {
        fs.writeFileSync(evidencePath, JSON.stringify(entry.evidence), {
          mode: 0o600
        });
      }
      const result = runVerifier([
        "--evidence",
        evidencePath,
        "--expected-version",
        entry.expectedVersion ?? PACKAGE_VERSION,
        "--expected-commit",
        COMMIT,
        "--require-matrix"
      ]);
      assertVerifierStatus(result, 1);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        new RegExp(`verification failed \\[${entry.expectedCode}\\]\\.`)
      );
      assert.doesNotMatch(result.stderr, /case-\d+\.json|9\.9\.9/u);
    });
  }
});

test("uses deterministic usage exit codes for invalid arguments", async (t) => {
  const cases: Array<[string, string[]]> = [
    ["no input", []],
    ["both input forms", ["--evidence", "a", "--attestation", "b"]],
    ["non-positive age", ["--evidence", "a", "--max-age-hours", "0"]],
    ["not-a-number age", ["--evidence", "a", "--max-age-hours", "nope"]],
    ["unknown option", ["--evidence", "a", "--print-input"]],
    ["missing value", ["--evidence"]],
    ["duplicate option", ["--evidence", "a", "--evidence", "b"]]
  ];

  for (const [name, arguments_] of cases) {
    await t.test(name, () => {
      const result = runVerifier(arguments_);
      assertVerifierStatus(result, 64);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^Invalid lifecycle evidence verifier arguments\./u);
      assert.match(result.stderr, /Usage:/u);
    });
  }

  const help = runVerifier(["--help"]);
  assertVerifierStatus(help, 0);
  assert.match(help.stdout, /^Usage:/u);
  assert.equal(help.stderr, "");
});

test("never echoes rejected evidence, raw identifiers, salt, or token material", (t) => {
  const directory = makeTempDirectory(t);
  const input = validInput();
  const evidence = create(input) as unknown as Record<string, unknown>;
  evidence.token = RAW_TOKEN;
  const evidencePath = path.join(directory, "untrusted-evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });

  const result = runVerifier([
    "--evidence",
    evidencePath,
    "--expected-version",
    PACKAGE_VERSION,
    "--expected-commit",
    COMMIT
  ]);
  assertVerifierStatus(result, 1);
  assert.match(result.stderr, /\[sensitive_key\]/u);
  assertPrivateValuesAbsent(`${result.stdout}${result.stderr}`, input);
  assert.equal(result.stdout.includes(RAW_TOKEN), false);
  assert.equal(result.stderr.includes(RAW_TOKEN), false);
  assert.equal(result.stderr.includes(evidencePath), false);
});

test("refuses directory and symlink output targets without altering their referent", async (t) => {
  const directory = makeTempDirectory(t);
  const evidencePath = path.join(directory, "evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify(create(validInput())), {
    mode: 0o600
  });
  const targetPath = path.join(directory, "existing-target.txt");
  const symlinkPath = path.join(directory, "output-link.txt");
  fs.writeFileSync(targetPath, "must remain unchanged", { mode: 0o600 });
  fs.symlinkSync(targetPath, symlinkPath);

  const common = [
    "--evidence",
    evidencePath,
    "--expected-version",
    PACKAGE_VERSION,
    "--expected-commit",
    COMMIT,
    "--require-matrix",
    "--output"
  ];
  for (const [name, outputPath] of [
    ["directory", directory],
    ["symlink", symlinkPath]
  ] as const) {
    await t.test(name, () => {
      const result = runVerifier([...common, outputPath]);
      assertVerifierStatus(result, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /\[output_write_failed\]/u);
      assert.equal(result.stderr.includes(outputPath), false);
    });
  }
  assert.equal(fs.readFileSync(targetPath, "utf8"), "must remain unchanged");
});

function validInput(
  completedAt = new Date(Date.now() - 60_000)
): RawLiveLifecycleEvidenceInput {
  const startedAt = new Date(completedAt.getTime() - 10 * 60 * 1_000);
  return {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    commit: COMMIT,
    worktreeClean: true,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    runId: RUN_ID,
    fingerprintSalt: FINGERPRINT_SALT,
    scenarios: {
      codex: validScenario("codex", startedAt, 10_000, 4 * 60_000 + 50_000),
      claude: validScenario("claude", startedAt, 5 * 60_000, 9 * 60_000 + 50_000)
    }
  };
}

function incompleteInput(): RawLiveLifecycleEvidenceInput {
  const input = validInput();
  delete input.scenarios.claude;
  return input;
}

function failedInput(): RawLiveLifecycleEvidenceInput {
  const input = validInput();
  const codex = input.scenarios.codex!;
  input.scenarios.codex = {
    status: "failed",
    failureStage: "preflight",
    reasonCode: "pane_not_idle",
    tmuxTarget: codex.tmuxTarget,
    panePid: codex.panePid,
    startedAt: codex.startedAt,
    completedAt: codex.startedAt,
    steps: [{ name: "preflight", status: "failed", durationMs: 1 }]
  };
  return input;
}

function validScenario(
  agent: LiveLifecycleAgent,
  envelopeStart: Date,
  startOffsetMs: number,
  completedOffsetMs: number
): RawLiveLifecycleScenarioResult {
  const codex = agent === "codex";
  const tmuxTarget = codex ? "akk-live:0.0" : "akk-live:0.1";
  const panePid = codex ? 4101 : 4102;
  const agentPid = codex ? 5101 : 5102;
  const nativeA = codex
    ? "11111111-1111-4111-8111-111111111111"
    : "33333333-3333-4333-8333-333333333333";
  const nativeB = codex
    ? "22222222-2222-4222-8222-222222222222"
    : "44444444-4444-4444-8444-444444444444";
  const sessionA = `${agent}-session-a-private`;
  const sessionB = `${agent}-session-b-private`;
  const bindingA1 = `${agent}-binding-a-generation-1-private`;
  const bindingB1 = `${agent}-binding-b-generation-1-private`;
  const bindingA2 = `${agent}-binding-a-generation-2-private`;
  const common = {
    tmuxTarget,
    panePid,
    agentPid,
    processUuid: `${agent}-process-incarnation-private`,
    processBirth: `${agent}-process-birth-private`,
    workspace: `/private/tmp/akk-live/${agent}`,
    idle: true
  };
  const before: RawLiveLifecycleSnapshot = {
    ...common,
    nativeThreadId: nativeA,
    sessionMaterialized: true,
    sessionId: sessionA,
    bindingId: bindingA1,
    bindingGeneration: 1
  };
  const afterNew: RawLiveLifecycleSnapshot = {
    ...common,
    nativeThreadId: nativeB,
    sessionMaterialized: true,
    sessionId: sessionB,
    bindingId: bindingB1,
    bindingGeneration: 1
  };
  const afterResume: RawLiveLifecycleSnapshot = {
    ...common,
    nativeThreadId: nativeA,
    sessionMaterialized: true,
    sessionId: sessionA,
    bindingId: bindingA2,
    bindingGeneration: 2
  };
  return {
    status: "passed",
    agentVersion: codex ? "0.146.0" : "2.1.218",
    tmuxTarget,
    panePid,
    startedAt: new Date(envelopeStart.getTime() + startOffsetMs).toISOString(),
    completedAt: new Date(envelopeStart.getTime() + completedOffsetMs).toISOString(),
    before,
    afterNew,
    afterResume,
    resumeCandidate: {
      nativeThreadId: nativeA,
      managedSessionId: sessionA,
      exactCandidateCount: 1,
      resumable: true,
      activeElsewhere: false,
      freshCandidateTokenPresent: true
    },
    send: {
      status: "completed",
      turnId: `${agent}-turn-private`,
      sessionId: sessionB,
      bindingId: bindingB1,
      bindingGeneration: 1
    },
    transitions: {
      newThread: {
        status: "committed",
        transitionId: `${agent}-new-transition-private`,
        sourceSessionId: sessionA,
        targetSessionId: sessionB,
        sourceBindingId: bindingA1,
        targetBindingId: bindingB1
      },
      resumeThread: {
        status: "committed",
        transitionId: `${agent}-resume-transition-private`,
        sourceSessionId: sessionB,
        targetSessionId: sessionA,
        sourceBindingId: bindingB1,
        targetBindingId: bindingA2
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
      durationMs: index + 1
    }))
  };
}

function makeTempDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-verifier-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runVerifier(arguments_: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [VERIFIER, ...arguments_], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env }
  });
}

function assertVerifierStatus(
  result: SpawnSyncReturns<string>,
  expected: number
): void {
  assert.equal(
    result.status,
    expected,
    JSON.stringify({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: (result.error as NodeJS.ErrnoException | undefined)?.code
    })
  );
}

function assertPrivateValuesAbsent(
  output: string,
  input: RawLiveLifecycleEvidenceInput
): void {
  const values = new Set<string>([FINGERPRINT_SALT, RAW_TOKEN]);
  for (const scenario of Object.values(input.scenarios)) {
    if (scenario === undefined) {
      continue;
    }
    for (const snapshot of [scenario.before, scenario.afterNew, scenario.afterResume]) {
      if (snapshot === undefined) {
        continue;
      }
      values.add(snapshot.processUuid);
      if (snapshot.processBirth !== undefined) {
        values.add(snapshot.processBirth);
      }
      values.add(snapshot.workspace);
      values.add(snapshot.nativeThreadId);
      if (snapshot.sessionId !== null) {
        values.add(snapshot.sessionId);
      }
      if (snapshot.bindingId !== null) {
        values.add(snapshot.bindingId);
      }
    }
    if (scenario.resumeCandidate !== undefined) {
      values.add(scenario.resumeCandidate.nativeThreadId);
      if (scenario.resumeCandidate.managedSessionId !== null) {
        values.add(scenario.resumeCandidate.managedSessionId);
      }
    }
    if (scenario.send !== undefined) {
      values.add(scenario.send.turnId);
      values.add(scenario.send.sessionId);
      values.add(scenario.send.bindingId);
    }
    for (const transition of [
      scenario.transitions?.newThread,
      scenario.transitions?.resumeThread
    ]) {
      if (transition === undefined) {
        continue;
      }
      values.add(transition.transitionId);
      if (transition.sourceSessionId !== null) {
        values.add(transition.sourceSessionId);
      }
      values.add(transition.targetSessionId);
      if (transition.sourceBindingId !== null) {
        values.add(transition.sourceBindingId);
      }
      values.add(transition.targetBindingId);
    }
  }
  for (const value of values) {
    assert.equal(output.includes(value), false, `private value leaked: ${value}`);
  }
}
