import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function loadEvidenceModule() {
  return import(
    pathToFileURL(path.join(repoRoot, "scripts", "refactor-evidence.js")).href
  );
}

async function loadDynamicEvidenceModule() {
  return import(
    pathToFileURL(
      path.join(repoRoot, "scripts", "subprocess-dynamic-evidence.js")
    ).href
  );
}

function loadJson(repositoryPath: string): any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, repositoryPath), "utf8"));
}

function loadTiers(): { fast: string[]; integration: string[] } {
  return loadJson("test/test-tiers.json");
}

test("package wires the standalone and architecture refactor evidence gates", () => {
  const packageJson = loadJson("package.json");
  assert.equal(
    packageJson.scripts["validate:refactor-evidence"],
    "node scripts/validate-refactor-evidence.js"
  );
  const architectureValidator = fs.readFileSync(
    path.join(repoRoot, "scripts", "validate-architecture.js"),
    "utf8"
  );
  assert.match(architectureValidator, /loadAndValidateRefactorEvidence/u);
});

test("final refactor evidence reproduces startup counts and historical selection", async () => {
  const evidenceModule = await loadEvidenceModule();
  const evidence = evidenceModule.loadAndValidateRefactorEvidence({
    repoRoot,
    tiers: loadTiers()
  });

  assert.equal(evidence.testEvidence.subprocess.baselineIncluded, 48);
  assert.equal(evidence.testEvidence.subprocess.currentIncluded, 19);
  assert.equal(evidence.testEvidence.subprocess.reductionBasisPoints, 6042);
  assert.equal(evidence.testEvidence.subprocess.targetRequired, true);
  assert.equal(evidence.testEvidence.subprocess.targetMet, true);
  assert.deepEqual(
    evidence.testEvidence.subprocess.currentCounts,
    {
      cli_process: 12,
      fake_node_process: 7,
      other_process_or_adapter: 12
    }
  );
  assert.equal(
    evidence.testEvidence.subprocess.baselineDiagnosticIncluded,
    0
  );
  assert.equal(
    evidence.testEvidence.subprocess.currentDiagnosticIncluded,
    10
  );
  assert.deepEqual(
    evidence.testEvidence.subprocess.currentDiagnosticCounts,
    {
      cli_process: 0,
      fake_node_process: 10,
      other_process_or_adapter: 1
    }
  );

  assert.equal(evidence.testEvidence.affectedReplay.scenario_count, 10);
  assert.equal(evidence.testEvidence.affectedReplay.full_count, 2);
  assert.equal(evidence.testEvidence.affectedReplay.targeted_count, 8);
  assert.equal(
    evidence.testEvidence.affectedReplay.full_rate_basis_points,
    2000
  );
  assert.equal(evidence.testEvidence.affectedReplay.targetRequired, true);
  assert.equal(evidence.testEvidence.affectedReplay.targetMet, true);
  assert.deepEqual(
    evidence.testEvidence.affectedReplay.results.filter(
      (result: { mode: string }) => result.mode === "full"
    ),
    [
      {
        commit: "d9e1a4cacde8e9cc65b44dd6bfae27ad2a877033",
        mode: "full"
      },
      {
        commit: "d0804039b5e1efd35ca1c716eb85019e48e7380f",
        mode: "full"
      }
    ]
  );

  assert.deepEqual(evidence.publicContracts, {
    contractCount: 5,
    witnessCount: 72,
    migrationCount: 11,
    hostBridgeToolCount: 16,
    openclawToolCount: 16,
    storeProtocolCount: 5
  });
});

test("static subprocess evidence isolates only canonical measurement probes and cannot hide product starts", async () => {
  const evidenceModule = await loadEvidenceModule();
  const startupCall = ["spawn", "Sync"].join("");
  const productSource = {
    path: "test/product-boundary.test.ts",
    source: `
import { ${startupCall} } from "node:child_process";
const cliPath = "dist/src/cli.js";
const invoke = () => ${startupCall}(process.execPath, [cliPath, "status"]);
invoke();
`
  };
  const diagnosticSource = {
    path: "test/refactor-evidence.test.ts",
    source: `
import { ${startupCall} } from "node:child_process";
${startupCall}(process.execPath, ["-e", ""]);
`
  };
  assert.deepEqual(
    evidenceModule.measureStaticSubprocessStartupSites([
      productSource,
      diagnosticSource
    ]),
    {
      product: {
        cli_process: 1,
        fake_node_process: 0,
        other_process_or_adapter: 0
      },
      diagnostic: {
        cli_process: 0,
        fake_node_process: 1,
        other_process_or_adapter: 0
      }
    }
  );

  const tiers = loadTiers();
  const manifest = loadJson("config/refactor-test-evidence.json");
  const weakenedThreshold = structuredClone(manifest);
  weakenedThreshold.subprocess_startup_sites.final_threshold
    .maximum_percent_of_baseline = 41;
  assert.throws(
    () => evidenceModule.validateTestEvidenceManifest({
      manifest: weakenedThreshold,
      repoRoot,
      tiers
    }),
    /maximum_percent_of_baseline must be 40/u
  );

  const disabledThreshold = structuredClone(manifest);
  disabledThreshold.subprocess_startup_sites.final_threshold.required = false;
  assert.throws(
    () => evidenceModule.validateTestEvidenceManifest({
      manifest: disabledThreshold,
      repoRoot,
      tiers
    }),
    /final_threshold required must be true/u
  );

  const replacedBaseline = structuredClone(manifest);
  replacedBaseline.subprocess_startup_sites.baseline.revision = "f".repeat(40);
  assert.throws(
    () => evidenceModule.validateTestEvidenceManifest({
      manifest: replacedBaseline,
      repoRoot,
      tiers
    }),
    /baseline revision must remain ea592a88d7af4a709e7a7a1b989dd29e61932935/u
  );

  const broadenedExclusion = structuredClone(manifest);
  broadenedExclusion.subprocess_startup_sites.measurement
    .diagnostic_excluded_paths = ["test/callback-cli.test.ts"];
  assert.throws(
    () => evidenceModule.validateTestEvidenceManifest({
      manifest: broadenedExclusion,
      repoRoot,
      tiers
    }),
    /diagnostic_excluded_paths must equal/u
  );

  const hiddenDiagnosticStart = structuredClone(manifest);
  hiddenDiagnosticStart.subprocess_startup_sites.current
    .diagnostic_counts.fake_node_process -= 1;
  hiddenDiagnosticStart.subprocess_startup_sites.current
    .diagnostic_included_total -= 1;
  assert.throws(
    () => evidenceModule.validateTestEvidenceManifest({
      manifest: hiddenDiagnosticStart,
      repoRoot,
      tiers
    }),
    /current diagnostic counts\.fake_node_process expected 9 but measured 10/u
  );

  const hiddenProductStart = structuredClone(manifest);
  hiddenProductStart.subprocess_startup_sites.current
    .counts.cli_process -= 1;
  hiddenProductStart.subprocess_startup_sites.current.included_total -= 1;
  assert.throws(
    () => evidenceModule.validateTestEvidenceManifest({
      manifest: hiddenProductStart,
      repoRoot,
      tiers
    }),
    /current counts\.cli_process expected 11 but measured 12/u
  );
});

test("dynamic subprocess evidence freezes the real full-tree measurement and retained boundaries", async () => {
  const evidenceModule = await loadDynamicEvidenceModule();
  const config = evidenceModule.loadDynamicSubprocessEvidenceConfig({ repoRoot });

  assert.equal(
    config.baseline.revision,
    "ea592a88d7af4a709e7a7a1b989dd29e61932935"
  );
  assert.deepEqual(Object.keys(config.baseline), ["revision"]);
  assert.equal(config.measurement.tier, "full");
  assert.equal(config.measurement.drain_poll_ms, 50);
  assert.equal(config.measurement.drain_timeout_ms, 30_000);
  assert.equal("drain_quiescence_ms" in config.measurement, false);
  assert.equal(config.final_threshold.maximum_percent_of_baseline, 40);
  assert.deepEqual(
    config.retained_boundaries.map((boundary: { id: string }) => boundary.id),
    [
      "argv_exit",
      "claude_adapter",
      "crash",
      "gateway",
      "lock",
      "pid",
      "terminal_adapters"
    ]
  );

  for (const field of ["path", "needle"] as const) {
    const mutated = structuredClone(config.retained_boundaries);
    mutated[1][field] = field === "path"
      ? "test/callback-cli.test.ts"
      : "CLI reports a multilingual multiline draft left in Codex after one Enter";
    assert.throws(() => evidenceModule.validateRetainedBoundaries(mutated, {
      repoRoot,
      integrationTests: new Set(loadTiers().integration)
    }), /must keep its canonical path and test name/u);
  }

  assert.equal(
    evidenceModule.repositoryContainsPath(`${repoRoot}${path.sep}`, path.join(repoRoot, "evidence.json")),
    true
  );
  assert.equal(
    evidenceModule.repositoryContainsPath(repoRoot, path.join(path.dirname(repoRoot), "outside-evidence.json")),
    false
  );
  const containmentDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-evidence-output-containment-")
  );
  try {
    const repositoryLink = path.join(containmentDirectory, "repository-link");
    fs.symlinkSync(repoRoot, repositoryLink, "dir");
    assert.equal(
      evidenceModule.repositoryContainsPath(
        repoRoot,
        path.join(repositoryLink, "evidence.json")
      ),
      true
    );
  } finally {
    fs.rmSync(containmentDirectory, { recursive: true, force: true });
  }
});

test("dynamic subprocess comparison enforces the 60% gate and every retained process kind", async () => {
  const evidenceModule = await loadDynamicEvidenceModule();
  const config = evidenceModule.loadDynamicSubprocessEvidenceConfig({ repoRoot });
  const witnessName = (id: string) => config.retained_boundaries.find(
    (boundary: { id: string }) => boundary.id === id
  ).needle;
  const detail = (overrides: Record<string, unknown>) => ({
    action: "status",
    argumentCount: 1,
    childPid: 10,
    end: 200,
    exitCode: 0,
    method: "spawn",
    optionNames: [],
    originTest: "test/unused.test.ts",
    originTestName: null,
    signal: null,
    start: 100,
    ...overrides
  });
  const currentSummary = {
    outerCliStarts: 5,
    targetWithoutBoot: 0,
    unattributedCliStarts: 0,
    outerCliDetails: [
      detail({
        action: "doctor",
        exitCode: 1,
        optionNames: ["--openclaw-bin", "--timeout-ms"],
        originTest: "test/cli-ux.test.ts",
        originTestName: witnessName("argv_exit")
      }),
      detail({
        exitCode: 86,
        originTest: "test/codex-no-rollout-binding-cli.test.ts",
        originTestName: witnessName("crash")
      }),
      detail({
        childPid: 11,
        end: 400,
        originTest: "test/shards/agent-cli-control-locks.test.ts",
        originTestName: witnessName("lock"),
        start: 250
      }),
      detail({
        childPid: 12,
        end: 350,
        originTest: "test/shards/agent-cli-control-locks.test.ts",
        originTestName: witnessName("lock"),
        start: 300
      }),
      detail({
        childPid: 13,
        originTest: "test/shards/agent-cli-monitor-recovery.test.ts",
        originTestName: witnessName("pid"),
        signal: "SIGKILL"
      })
    ],
    processStarts: [
      ["openclaw", "test/callback-cli.test.ts", witnessName("gateway")],
      ["claude", "test/shards/agent-cli-composer-replay.test.ts", witnessName("claude_adapter")],
      ["tmux", "test/shards/agent-cli-composer-replay.test.ts", witnessName("terminal_adapters")],
      ["ps", "test/shards/agent-cli-composer-replay.test.ts", witnessName("terminal_adapters")],
      ["lsof", "test/shards/agent-cli-composer-replay.test.ts", witnessName("terminal_adapters")]
    ].map(([command, originTest, originTestName]) => ({
      command,
      originTest,
      originTestName,
      outerCliPid: 1_000,
      targetRole: "other"
    }))
  };
  const result = evidenceModule.compareDynamicSubprocessEvidence({
    baselineSummary: {
      outerCliStarts: 13,
      targetWithoutBoot: 0,
      unattributedCliStarts: 0
    },
    config,
    currentSummary
  });
  assert.equal(result.currentOuterCliStarts, 5);
  assert.equal(result.reductionBasisPoints, 6154);
  assert.equal(result.retainedBoundaries.every(
    (boundary: { met: boolean }) => boundary.met
  ), true);

  assert.throws(() => evidenceModule.compareDynamicSubprocessEvidence({
    baselineSummary: {
      outerCliStarts: 10,
      targetWithoutBoot: 0,
      unattributedCliStarts: 0
    },
    config,
    currentSummary
  }), /requires current <= 40% of baseline/u);

  assert.throws(() => evidenceModule.compareDynamicSubprocessEvidence({
    baselineSummary: {
      outerCliStarts: 13,
      targetWithoutBoot: 0,
      unattributedCliStarts: 0
    },
    config,
    currentSummary: {
      ...currentSummary,
      processStarts: currentSummary.processStarts.filter(
        (start) => start.command !== "lsof"
      )
    }
  }), /retained boundaries are missing: claude_adapter, terminal_adapters/u);

  const splitClaudeAndTerminal = structuredClone(currentSummary);
  splitClaudeAndTerminal.processStarts.find(
    (start) => start.command === "claude"
  )!.outerCliPid = 2_000;
  assert.throws(() => evidenceModule.compareDynamicSubprocessEvidence({
    baselineSummary: {
      outerCliStarts: 13,
      targetWithoutBoot: 0,
      unattributedCliStarts: 0
    },
    config,
    currentSummary: splitClaudeAndTerminal
  }), /retained boundaries are missing: claude_adapter, terminal_adapters/u);

  const splitAdapterCase = structuredClone(currentSummary);
  splitAdapterCase.processStarts.find(
    (start) => start.command === "lsof"
  )!.outerCliPid = 2_000;
  assert.throws(() => evidenceModule.compareDynamicSubprocessEvidence({
    baselineSummary: {
      outerCliStarts: 13,
      targetWithoutBoot: 0,
      unattributedCliStarts: 0
    },
    config,
    currentSummary: splitAdapterCase
  }), /retained boundaries are missing: claude_adapter, terminal_adapters/u);

  const splitArgvAndExit = structuredClone(currentSummary);
  splitArgvAndExit.outerCliDetails[0].exitCode = 0;
  splitArgvAndExit.outerCliDetails.push(detail({
    action: "status",
    exitCode: 1,
    originTest: "test/cli-ux.test.ts",
    originTestName: witnessName("argv_exit")
  }));
  splitArgvAndExit.outerCliStarts += 1;
  assert.throws(() => evidenceModule.compareDynamicSubprocessEvidence({
    baselineSummary: {
      outerCliStarts: 15,
      targetWithoutBoot: 0,
      unattributedCliStarts: 0
    },
    config,
    currentSummary: splitArgvAndExit
  }), /retained boundaries are missing: argv_exit/u);

  const wrongRuntimeTest = structuredClone(currentSummary);
  for (const start of wrongRuntimeTest.processStarts.filter(
    (candidate) => candidate.originTest ===
      "test/shards/agent-cli-composer-replay.test.ts"
  )) {
    start.originTestName =
      "CLI reports a multilingual multiline draft left in Codex after one Enter";
  }
  assert.throws(() => evidenceModule.compareDynamicSubprocessEvidence({
    baselineSummary: {
      outerCliStarts: 13,
      targetWithoutBoot: 0,
      unattributedCliStarts: 0
    },
    config,
    currentSummary: wrongRuntimeTest
  }), /retained boundaries are missing: claude_adapter, terminal_adapters/u);
});

test("dynamic completion includes a delayed shell descendant with a stripped env", async () => {
  if (process.env.AKK_SUBPROCESS_EVIDENCE_RUN_ID) {
    assert.ok(process.env.AKK_SUBPROCESS_EVIDENCE_PRELOAD);
    return;
  }
  const evidenceModule = await loadDynamicEvidenceModule();
  const traceDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-subprocess-evidence-probe-")
  );
  const preloadPath = path.join(
    repoRoot,
    "scripts",
    "subprocess-dynamic-hook.cjs"
  );
  const cliPath = path.join(repoRoot, "dist", "src", "cli.js");
  const runId = `probe-${process.pid}-${Date.now()}`;
  const witnessName = "dynamic shell descendant evidence probe";
  const readyPath = path.join(traceDirectory, "descendant-ready");
  const gatePath = path.join(traceDirectory, "release-descendant");
  const gatedCli = [
    `: > ${JSON.stringify(readyPath)} || exit 70`,
    `while [ ! -e ${JSON.stringify(gatePath)} ]; do ` +
      `[ -d ${JSON.stringify(traceDirectory)} ] || exit 71; ` +
      "sleep 0.01; done",
    `exec ${JSON.stringify(process.execPath)} ` +
      `${JSON.stringify(cliPath)} --version >/dev/null 2>&1`
  ].join("; ");
  const helper = `
const { spawn } = require("node:child_process");
const delayed = spawn(
  "/bin/sh",
  ["-c", ${JSON.stringify(gatedCli)}],
  { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } }
);
delayed.unref();
`;

  try {
    const preloadOption = `--require=${preloadPath}`;
    const child = spawn(process.execPath, ["-e", helper], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        AKK_SUBPROCESS_EVIDENCE_DIR: traceDirectory,
        AKK_SUBPROCESS_EVIDENCE_ROOT: repoRoot,
        AKK_SUBPROCESS_EVIDENCE_RUN_ID: runId,
        AKK_SUBPROCESS_EVIDENCE_PRELOAD: preloadPath,
        AKK_SUBPROCESS_EVIDENCE_ORIGIN_TEST:
          "test/refactor-evidence.test.ts",
        AKK_SUBPROCESS_EVIDENCE_TEST_NAME: witnessName,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, preloadOption]
          .filter(Boolean)
          .join(" ")
      }
    });
    assert.ok(child.pid);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(status, 0, stderr);

    const readyDeadline = Date.now() + 5_000;
    while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(readyPath), true);
    assert.equal(fs.existsSync(gatePath), false);

    let resolveFirstPoll!: () => void;
    const firstPoll = new Promise<void>((resolve) => {
      resolveFirstPoll = resolve;
    });
    let completionSettled = false;
    const completion = evidenceModule.waitForDynamicSubprocessTreeCompletion({
      traceDirectory,
      runId,
      rootProcessGroup: child.pid,
      pollMs: 10,
      timeoutMs: 5_000,
      sleep: async (milliseconds: number) => {
        resolveFirstPoll();
        await new Promise<void>((resolve) =>
          setTimeout(resolve, milliseconds)
        );
      }
    });
    void completion.then(
      () => { completionSettled = true; },
      () => { completionSettled = true; }
    );
    const firstObservation = await Promise.race([
      firstPoll.then(() => "poll" as const),
      completion.then(
        () => "settled" as const,
        () => "settled" as const
      )
    ]);
    assert.equal(firstObservation, "poll");
    assert.equal(completionSettled, false);
    assert.equal(fs.existsSync(gatePath), false);
    const gateFd = fs.openSync(gatePath, "wx", 0o600);
    fs.closeSync(gateFd);

    const events = await completion;
    const summary = evidenceModule.summarizeDynamicSubprocessTrace(events, {
      runId
    });
    assert.equal(summary.outerCliStarts, 1);
    assert.equal(summary.nestedCliStarts, 0);
    assert.equal(summary.targetedCliStarts, 0);
    assert.equal(summary.targetWithoutBoot, 0);
    assert.equal(summary.unattributedCliStarts, 0);
    assert.deepEqual(summary.outerCliByAction, { "--version": 1 });
    assert.deepEqual(summary.outerCliByTest, {
      "test/refactor-evidence.test.ts": 1
    });
    assert.equal(summary.outerCliDetails[0].originTestName, witnessName);

    const tampered = structuredClone(events);
    tampered[0].raw_argv = ["forbidden", "plaintext"];
    assert.throws(
      () => evidenceModule.summarizeDynamicSubprocessTrace(tampered, { runId }),
      /unexpected keys: raw_argv/u
    );
    const tamperedName = structuredClone(events);
    tamperedName[0].origin_test_name = "secret-token-must-not-enter-trace";
    assert.throws(
      () => evidenceModule.summarizeDynamicSubprocessTrace(tamperedName, { runId }),
      /origin_test_name is not allowlisted/u
    );

    const secretTestName = "secret-token-must-not-enter-trace";
    const rejected = spawnSync(process.execPath, ["-e", ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        AKK_SUBPROCESS_EVIDENCE_DIR: traceDirectory,
        AKK_SUBPROCESS_EVIDENCE_ROOT: repoRoot,
        AKK_SUBPROCESS_EVIDENCE_RUN_ID: runId,
        AKK_SUBPROCESS_EVIDENCE_PRELOAD: preloadPath,
        AKK_SUBPROCESS_EVIDENCE_TEST_NAME: secretTestName,
        NODE_OPTIONS: `--require=${preloadPath}`
      }
    });
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch(rejected.stderr, new RegExp(secretTestName, "u"));
    assert.doesNotMatch(
      fs.readdirSync(traceDirectory).map((name) =>
        fs.readFileSync(path.join(traceDirectory, name), "utf8")
      ).join("\n"),
      new RegExp(secretTestName, "u")
    );
  } finally {
    if (!fs.existsSync(gatePath)) {
      const gateFd = fs.openSync(gatePath, "wx", 0o600);
      fs.closeSync(gateFd);
    }
    fs.rmSync(traceDirectory, { recursive: true, force: true });
  }
});

test("dynamic completion waits for detached process groups and fails closed", async () => {
  const evidenceModule = await loadDynamicEvidenceModule();
  const traceDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-subprocess-drain-probe-")
  );
  const runId = `drain-${process.pid}-${Date.now()}`;
  const originTest = "test/refactor-evidence.test.ts";
  const parentPid = 910_001;
  const childPid = 910_002;
  const rootProcessGroup = 910_000;
  const callId = `${parentPid}:1:deadbeef`;
  const event = (overrides: Record<string, unknown>) => ({
    schema: "agent-knock-knock/subprocess-trace",
    version: 1,
    run_id: runId,
    pid: parentPid,
    ppid: 1,
    timestamp_ms: 1,
    origin_test: originTest,
    origin_test_name: null,
    ...overrides
  });
  const parentBoot = event({
    event: "process_boot",
    entry: "dist/test/refactor-evidence.test.js",
    role: "test",
    parent_call_id: null,
    action: null,
    argument_count: 0,
    option_names: []
  });
  const childStart = event({
    event: "process_start",
    call_id: callId,
    method: "spawn",
    detached: true,
    started: true,
    child_pid: childPid,
    duration_ms: 1,
    target_role: "cli",
    command: "node",
    action: "--version",
    argument_count: 2,
    option_names: [],
    exit_code: null,
    signal: null,
    error_code: null
  });
  const childBoot = event({
    event: "process_boot",
    pid: childPid,
    ppid: parentPid,
    timestamp_ms: 2,
    entry: "dist/src/cli.js",
    role: "cli",
    parent_call_id: callId,
    action: "--version",
    argument_count: 1,
    option_names: []
  });
  const write = (pid: number, events: unknown[]) => {
    fs.writeFileSync(
      path.join(traceDirectory, `trace-${pid}.ndjson`),
      `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  };

  try {
    write(parentPid, [parentBoot, childStart]);
    write(childPid, [childBoot]);
    const aliveGroups = new Set([childPid]);
    let now = 0;
    let sleeps = 0;
    const events = await evidenceModule.waitForDynamicSubprocessTreeCompletion({
      traceDirectory,
      runId,
      rootProcessGroup,
      pollMs: 10,
      timeoutMs: 100,
      isProcessGroupAlive: (pid: number) => aliveGroups.has(pid),
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds;
        sleeps += 1;
        if (sleeps === 2) {
          aliveGroups.delete(childPid);
        }
      }
    });
    const summary = evidenceModule.summarizeDynamicSubprocessTrace(events, {
      runId
    });
    assert.equal(summary.outerCliStarts, 1);
    assert.equal(summary.targetWithoutBoot, 0);
    assert.equal(sleeps, 2);

    let timeoutNow = 0;
    await assert.rejects(
      evidenceModule.waitForDynamicSubprocessTreeCompletion({
        traceDirectory,
        runId,
        rootProcessGroup,
        pollMs: 10,
        timeoutMs: 30,
        isProcessGroupAlive: (pid: number) => pid === childPid,
        now: () => timeoutNow,
        sleep: async (milliseconds: number) => {
          timeoutNow += milliseconds;
        }
      }),
      /did not complete before timeout; live process groups: 910002/u
    );
  } finally {
    fs.rmSync(traceDirectory, { recursive: true, force: true });
  }
});

test("dynamic preload records one real child for every CJS and ESM launch API", async () => {
  if (process.env.AKK_SUBPROCESS_EVIDENCE_RUN_ID) {
    assert.ok(process.env.AKK_SUBPROCESS_EVIDENCE_PRELOAD);
    return;
  }
  const evidenceModule = await loadDynamicEvidenceModule();
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-subprocess-method-probe-")
  );
  const traceDirectory = path.join(temporaryDirectory, "trace");
  const forkTarget = path.join(temporaryDirectory, "fork-target.cjs");
  const preloadPath = path.join(
    repoRoot,
    "scripts",
    "subprocess-dynamic-hook.cjs"
  );
  const cliPath = path.join(repoRoot, "dist", "src", "cli.js");
  const runId = `methods-${process.pid}-${Date.now()}`;
  fs.mkdirSync(traceDirectory);
  fs.writeFileSync(forkTarget, "\"use strict\";\n", {
    encoding: "utf8",
    mode: 0o600
  });
  const commonBody = String.raw`
const stripped = { PATH: process.env.PATH };
const empty = ["-e", ""];
const command = JSON.stringify(process.execPath) + " -e \\\"\\\"";
const cliCommand = JSON.stringify(process.execPath) + " " +
  JSON.stringify(${JSON.stringify(cliPath)}) + " --version";
const wait = (child) => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0 && signal === null) resolve();
    else reject(new Error("child failed: " + code + "/" + signal));
  });
});
const callback = (start) => new Promise((resolve, reject) => {
  start((error) => error ? reject(error) : resolve());
});
const run = async () => {
  const syncSpawn = childProcess.spawnSync(process.execPath, empty, { env: stripped });
  if (syncSpawn.status !== 0 || !syncSpawn.pid) throw new Error("spawnSync failed");
  childProcess.execFileSync(process.execPath, empty, { env: stripped });
  childProcess.execSync(cliCommand, { env: stripped });
  const promisedExecFile = promisify(childProcess.execFile);
  const promised = promisedExecFile(process.execPath, empty, { env: stripped });
  if (!promised.child || !promised.child.pid) {
    throw new Error("promisified execFile lost its child process");
  }
  await Promise.all([
    wait(childProcess.spawn(process.execPath, empty, { env: stripped })),
    callback((done) => childProcess.execFile(
      process.execPath, empty, { env: stripped }, done
    )),
    callback((done) => childProcess.exec(command, { env: stripped }, done)),
    wait(childProcess.fork(
      process.env.AKK_EVIDENCE_FORK_TARGET,
      [],
      { env: stripped, silent: true }
    )),
    promised
  ]);
};
await run();
`;
  const cjsHelper = `
const childProcess = require("node:child_process");
const { promisify } = require("node:util");
(async () => {${commonBody}})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exitCode = 1;
});
`;
  const esmHelper = `
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
${commonBody}
`;
  const environment = {
    ...process.env,
    AKK_EVIDENCE_FORK_TARGET: forkTarget,
    AKK_SUBPROCESS_EVIDENCE_DIR: traceDirectory,
    AKK_SUBPROCESS_EVIDENCE_ROOT: repoRoot,
    AKK_SUBPROCESS_EVIDENCE_RUN_ID: runId,
    AKK_SUBPROCESS_EVIDENCE_PRELOAD: preloadPath,
    AKK_SUBPROCESS_EVIDENCE_ORIGIN_TEST: "test/refactor-evidence.test.ts",
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--require=${preloadPath}`
    ].filter(Boolean).join(" ")
  };

  try {
    for (const [label, arguments_] of [
      ["CJS", ["-e", cjsHelper]],
      ["ESM", ["--input-type=module", "-e", esmHelper]]
    ] as const) {
      const result = spawnSync(process.execPath, arguments_, {
        encoding: "utf8",
        env: environment,
        timeout: 20_000
      });
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    }
    const events = evidenceModule.readDynamicSubprocessTrace(
      traceDirectory,
      runId
    );
    const starts = events.filter((event: { event: string }) =>
      event.event === "process_start"
    );
    assert.equal(starts.length, 16);
    assert.equal(new Set(starts.map((event: { call_id: string }) =>
      event.call_id
    )).size, 16);
    const childBoots = events.filter((event: {
      event: string;
      parent_call_id: string | null;
    }) => event.event === "process_boot" && event.parent_call_id !== null);
    assert.equal(childBoots.length, 16);
    assert.equal(
      new Set(childBoots.map((event: { parent_call_id: string }) =>
        event.parent_call_id
      )).size,
      16,
      "every API call must own one directly correlated child boot"
    );
    assert.equal(starts.every((event: {
      started: boolean;
    }) => event.started), true);
    const concreteChildPids = starts.flatMap((event: {
      child_pid: number | null;
    }) => event.child_pid === null ? [] : [event.child_pid]);
    assert.equal(concreteChildPids.length, 12);
    assert.equal(new Set(concreteChildPids).size, 12);
    assert.deepEqual(
      Object.fromEntries([...new Set(starts.map((event: { method: string }) =>
        event.method
      ))].sort().map((method) => [
        method,
        starts.filter((event: { method: string }) => event.method === method)
          .length
      ])),
      {
        exec: 2,
        execFile: 4,
        execFileSync: 2,
        execSync: 2,
        fork: 2,
        spawn: 2,
        spawnSync: 2
      }
    );
    const summary = evidenceModule.summarizeDynamicSubprocessTrace(events, {
      runId
    });
    assert.equal(summary.processStartCount, 16);
    assert.equal(summary.processBootCount, 18);
    assert.equal(summary.targetedCliStarts, 2);
    assert.equal(summary.targetWithoutBoot, 0);
    assert.equal(summary.outerCliStarts, 2);
    assert.equal(summary.outerCliDetails.every((detail: { method: string }) =>
      detail.method === "execSync"
    ), true);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("sync launch correlation is isolated from concurrent trace writers", async () => {
  if (process.env.AKK_SUBPROCESS_EVIDENCE_RUN_ID) {
    assert.ok(process.env.AKK_SUBPROCESS_EVIDENCE_PRELOAD);
    return;
  }
  const evidenceModule = await loadDynamicEvidenceModule();
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-subprocess-sync-correlation-")
  );
  const traceDirectory = path.join(temporaryDirectory, "trace");
  const readyPath = path.join(temporaryDirectory, "ready");
  const preloadPath = path.join(
    repoRoot,
    "scripts",
    "subprocess-dynamic-hook.cjs"
  );
  const cliPath = path.join(repoRoot, "dist", "src", "cli.js");
  const runId = `sync-correlation-${process.pid}-${Date.now()}`;
  fs.mkdirSync(traceDirectory);
  const environment = {
    ...process.env,
    AKK_SUBPROCESS_EVIDENCE_DIR: traceDirectory,
    AKK_SUBPROCESS_EVIDENCE_ROOT: repoRoot,
    AKK_SUBPROCESS_EVIDENCE_RUN_ID: runId,
    AKK_SUBPROCESS_EVIDENCE_PRELOAD: preloadPath,
    AKK_SUBPROCESS_EVIDENCE_ORIGIN_TEST: "test/refactor-evidence.test.ts",
    NODE_OPTIONS: `--require=${preloadPath}`
  };
  const command = `sleep 0.5; ${JSON.stringify(process.execPath)} ` +
    `${JSON.stringify(cliPath)} --version >/dev/null`;
  const helper = `
const fs = require("node:fs");
const { execSync } = require("node:child_process");
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
execSync(${JSON.stringify(command)}, { env: { PATH: process.env.PATH } });
`;
  const waitForChild = (child: ReturnType<typeof spawn>) =>
    new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0 && signal === null) resolve();
        else reject(new Error(`child failed: ${String(code)}/${String(signal)}`));
      });
    });

  try {
    const synchronous = spawn(process.execPath, ["-e", helper], {
      env: environment,
      stdio: "ignore"
    });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(readyPath), true);
    assert.equal(synchronous.exitCode, null);
    const concurrent = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 120)"],
      { env: environment, stdio: "ignore" }
    );
    await Promise.all([waitForChild(synchronous), waitForChild(concurrent)]);

    const events = evidenceModule.readDynamicSubprocessTrace(
      traceDirectory,
      runId
    );
    const syncStart = events.find((event: {
      event: string;
      method?: string;
    }) => event.event === "process_start" && event.method === "execSync");
    assert.ok(syncStart);
    assert.equal(syncStart.child_pid, null);
    const matchingBoots = events.filter((event: {
      event: string;
      parent_call_id?: string | null;
    }) => event.event === "process_boot" &&
      event.parent_call_id === syncStart.call_id);
    assert.equal(matchingBoots.length, 1);
    const summary = evidenceModule.summarizeDynamicSubprocessTrace(events, {
      runId
    });
    assert.equal(summary.targetWithoutBoot, 0);
    assert.equal(summary.outerCliStarts, 1);
    assert.equal(summary.outerCliDetails[0].method, "execSync");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("one required flag turns an unmet final threshold into a hard failure", async () => {
  const evidenceModule = await loadEvidenceModule();
  assert.doesNotThrow(() => evidenceModule.enforceRequiredFinalThreshold({
    required: false,
    targetMet: false,
    label: "recording gate"
  }));
  assert.throws(
    () => evidenceModule.enforceRequiredFinalThreshold({
      required: true,
      targetMet: false,
      label: "release gate"
    }),
    /release gate final threshold is required but not met/u
  );
});

test("test evidence schema rejects incomplete or unreviewed top-level fields", async () => {
  const evidenceModule = await loadEvidenceModule();
  const validate = (manifest: any) =>
    evidenceModule.validateTestEvidenceManifest({
      manifest,
      repoRoot,
      tiers: loadTiers()
    });
  const missing = loadJson("config/refactor-test-evidence.json");
  delete missing.affected_selector_replay;
  assert.throws(
    () => validate(missing),
    /missing keys: affected_selector_replay/u
  );

  const unknown = loadJson("config/refactor-test-evidence.json");
  unknown.unreviewed_escape_hatch = true;
  assert.throws(
    () => validate(unknown),
    /unexpected keys: unreviewed_escape_hatch/u
  );

  const optionalSelector = loadJson("config/refactor-test-evidence.json");
  optionalSelector.affected_selector_replay.final_threshold.required = false;
  assert.throws(
    () => validate(optionalSelector),
    /affected selector final_threshold required must be true/u
  );

  const looseSelector = loadJson("config/refactor-test-evidence.json");
  looseSelector.affected_selector_replay.final_threshold
    .maximum_full_fallback_count = 100;
  assert.throws(
    () => validate(looseSelector),
    /affected selector final_threshold maximum_full_fallback_count must be 2/u
  );
});

test("public contract evidence fails closed on missing witnesses and protocol drift", async () => {
  const evidenceModule = await loadEvidenceModule();
  const validate = (manifest: any) =>
    evidenceModule.validatePublicContractManifest({
      manifest,
      repoRoot,
      tiers: loadTiers()
    });

  const missingWitness = loadJson("config/public-contract-witnesses.json");
  missingWitness.witnesses[0].path = "test/missing-contract.test.ts";
  assert.throws(
    () => validate(missingWitness),
    /is not in the declared fast tier|missing/u
  );

  const missingContract = loadJson("config/public-contract-witnesses.json");
  delete missingContract.contracts.cli_json;
  assert.throws(() => validate(missingContract), /missing keys: cli_json/u);

  const protocolDrift = loadJson("config/public-contract-witnesses.json");
  protocolDrift.contracts.store_protocols.current_writer_protocol = 6;
  assert.throws(
    () => validate(protocolDrift),
    /Store format\/writer\/session-authority protocol contract changed/u
  );

  const terminalWatchSchemaDrift =
    loadJson("config/public-contract-witnesses.json");
  terminalWatchSchemaDrift.contracts.store_protocols.terminal_watch_version = 2;
  assert.throws(
    () => validate(terminalWatchSchemaDrift),
    /Terminal Watch schema contract changed/u
  );

  const hostBridgeDrift = loadJson("config/public-contract-witnesses.json");
  hostBridgeDrift.contracts.host_bridge.callback_driver = "shell_v1";
  assert.throws(
    () => validate(hostBridgeDrift),
    /Host Bridge profile, transport, callback, or tool contract changed/u
  );

  const missingHostBridgeAuthority =
    loadJson("config/public-contract-witnesses.json");
  missingHostBridgeAuthority.contracts.host_bridge.authority_paths =
    missingHostBridgeAuthority.contracts.host_bridge.authority_paths.slice(1);
  assert.throws(
    () => validate(missingHostBridgeAuthority),
    /Host Bridge authority_paths must equal/u
  );

  const duplicateTool = loadJson("config/public-contract-witnesses.json");
  const duplicateTools = duplicateTool.contracts.openclaw_tools.tools;
  duplicateTools[duplicateTools.length - 1] =
    duplicateTools[duplicateTools.length - 2];
  assert.throws(() => validate(duplicateTool), /OpenClaw tools must equal/u);

  for (const missingAuthority of [
    "src/openclaw-plugin-command-adapter.ts",
    "src/openclaw-plugin-schemas.ts"
  ]) {
    const missingRole = loadJson("config/public-contract-witnesses.json");
    missingRole.contracts.openclaw_tools.authority_paths =
      missingRole.contracts.openclaw_tools.authority_paths.filter(
        (repositoryPath: string) => repositoryPath !== missingAuthority
      );
    assert.throws(
      () => validate(missingRole),
      /OpenClaw authority role paths must equal/u
    );
  }

  const existingWrongRole = loadJson("config/public-contract-witnesses.json");
  existingWrongRole.contracts.openclaw_tools.authority_paths =
    existingWrongRole.contracts.openclaw_tools.authority_paths
      .map((repositoryPath: string) =>
        repositoryPath === "src/openclaw-plugin-schemas.ts"
          ? "src/openclaw-callback-transport.ts"
          : repositoryPath
      )
      .sort();
  assert.throws(
    () => validate(existingWrongRole),
    /OpenClaw authority role paths must equal/u
  );
});
