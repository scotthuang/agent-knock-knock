import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compareDynamicSubprocessEvidence,
  loadDynamicSubprocessEvidenceConfig,
  repositoryContainsPath,
  summarizeDynamicSubprocessTrace,
  waitForDynamicSubprocessTreeCompletion
} from "./subprocess-dynamic-evidence.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

function fail(message) {
  throw new Error(message);
}

function parseArguments(arguments_) {
  let output;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--output") {
      fail(`unknown argument ${JSON.stringify(argument)}`);
    }
    if (output !== undefined) {
      fail("--output may be supplied only once");
    }
    output = arguments_[index + 1];
    if (!output || output.startsWith("--")) {
      fail("--output requires a path");
    }
    index += 1;
  }
  return { output };
}

function run(command, arguments_, options, label) {
  const result = spawnSync(command, arguments_, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`${label} failed with status ${result.status ?? "unknown"}`);
  }
  return result;
}

function runDetached(command, arguments_, options, label) {
  const child = spawn(command, arguments_, options);
  const childPid = child.pid;
  if (!Number.isSafeInteger(childPid) || childPid < 1) {
    child.kill();
    fail(`${label} did not expose its root process group`);
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (status !== 0 || signal !== null) {
        reject(new Error(
          `${label} failed with ${signal ? `signal ${signal}` : `status ${status ?? "unknown"}`}`
        ));
        return;
      }
      resolve({ pid: childPid });
    });
  });
}

function gitText(worktree, arguments_, label) {
  return String(run("git", arguments_, {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  }, label).stdout).trim();
}

function cleanCurrentRevision() {
  const status = gitText(
    repoRoot,
    ["status", "--porcelain", "--untracked-files=normal"],
    "current worktree status"
  );
  if (status) {
    fail(
      "dynamic subprocess evidence requires a clean current worktree; " +
      "commit or remove every tracked and untracked change first"
    );
  }
  return gitText(repoRoot, ["rev-parse", "HEAD"], "current revision");
}

function revisionFile(revision, repositoryPath) {
  return run("git", ["show", `${revision}:${repositoryPath}`], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024
  }, `read ${repositoryPath} at ${revision}`).stdout;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function appendNodePreload(existing, preloadPath) {
  if (/\s/u.test(preloadPath)) {
    fail("dynamic subprocess evidence preload path must not contain whitespace");
  }
  const option = `--require=${preloadPath}`;
  const current = typeof existing === "string" ? existing.trim() : "";
  return current.includes(option)
    ? current
    : [current, option].filter(Boolean).join(" ");
}

function buildWorktree(worktree, label) {
  process.stdout.write(`\nBuilding ${label} evidence worktree...\n`);
  run("npm", ["run", "build"], {
    cwd: worktree,
    env: process.env,
    stdio: "inherit"
  }, `${label} build`);
}

async function measureWorktree({
  config,
  label,
  preloadPath,
  runId,
  traceDirectory,
  worktree
}) {
  process.stdout.write(`\nMeasuring ${label} full test process tree...\n`);
  const startedAt = Date.now();
  const environment = {
    ...process.env,
    AKK_TEST_CONCURRENCY: String(config.measurement.concurrency),
    AKK_SUBPROCESS_EVIDENCE_DIR: traceDirectory,
    AKK_SUBPROCESS_EVIDENCE_ROOT: worktree,
    AKK_SUBPROCESS_EVIDENCE_RUN_ID: runId,
    AKK_SUBPROCESS_EVIDENCE_PRELOAD: preloadPath,
    NODE_OPTIONS: appendNodePreload(process.env.NODE_OPTIONS, preloadPath)
  };
  delete environment.AKK_SUBPROCESS_EVIDENCE_PARENT_CALL_ID;
  delete environment.AKK_SUBPROCESS_EVIDENCE_ORIGIN_TEST;
  delete environment.AKK_SUBPROCESS_EVIDENCE_TEST_NAME;
  const result = await runDetached(process.execPath, [
    path.join(worktree, config.measurement.runner),
    config.measurement.tier
  ], {
    cwd: worktree,
    detached: true,
    env: environment,
    stdio: "inherit"
  }, `${label} full test tier`);
  const events = await waitForDynamicSubprocessTreeCompletion({
    traceDirectory,
    runId,
    rootProcessGroup: result.pid,
    pollMs: config.measurement.drain_poll_ms,
    timeoutMs: config.measurement.drain_timeout_ms
  });
  return {
    durationMs: Date.now() - startedAt,
    summary: summarizeDynamicSubprocessTrace(events, { runId })
  };
}

function publicSummary(measurement) {
  const summary = measurement.summary;
  return {
    duration_ms: measurement.durationMs,
    event_count: summary.eventCount,
    process_boot_count: summary.processBootCount,
    process_start_count: summary.processStartCount,
    outer_cli_starts: summary.outerCliStarts,
    nested_cli_starts: summary.nestedCliStarts,
    targeted_cli_starts: summary.targetedCliStarts,
    target_without_boot: summary.targetWithoutBoot,
    unattributed_cli_starts: summary.unattributedCliStarts,
    outer_cli_by_action: summary.outerCliByAction,
    outer_cli_by_test: summary.outerCliByTest,
    command_starts: summary.commandStarts
  };
}

function safeRemoveTemporaryWorktree(temporaryRoot, baselineWorktree) {
  const expectedPrefix = path.join(os.tmpdir(), "akk-dynamic-subprocess-");
  if (!temporaryRoot.startsWith(expectedPrefix)) {
    fail("refusing to clean an unexpected dynamic evidence temporary path");
  }
  const removal = spawnSync(
    "git",
    ["worktree", "remove", "--force", baselineWorktree],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (removal.error || removal.status !== 0) {
    process.stderr.write(
      `warning: baseline evidence worktree remains at ${baselineWorktree}\n`
    );
    return;
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

async function main() {
  if (process.platform === "win32") {
    fail("dynamic subprocess evidence requires POSIX process groups");
  }
  const { output } = parseArguments(process.argv.slice(2));
  const config = loadDynamicSubprocessEvidenceConfig({ repoRoot });
  const currentRevision = cleanCurrentRevision();
  const dependencyLockPath = config.measurement.dependency_lock;
  const currentLock = fs.readFileSync(path.join(repoRoot, dependencyLockPath));
  const baselineLock = revisionFile(config.baseline.revision, dependencyLockPath);
  if (!currentLock.equals(baselineLock)) {
    fail(
      `${dependencyLockPath} differs from the immutable baseline; refusing ` +
      "to measure both revisions with one dependency installation"
    );
  }
  const nodeModules = path.join(repoRoot, "node_modules");
  if (!fs.existsSync(nodeModules) || !fs.statSync(nodeModules).isDirectory()) {
    fail("node_modules is missing; this command never installs dependencies");
  }

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-dynamic-subprocess-")
  );
  const baselineWorktree = path.join(temporaryRoot, "baseline");
  const baselineTrace = path.join(temporaryRoot, "baseline-trace");
  const currentTrace = path.join(temporaryRoot, "current-trace");
  const preloadPath = path.join(repoRoot, config.measurement.preload);
  const baselineRunId = `baseline-${crypto.randomUUID()}`;
  const currentRunId = `current-${crypto.randomUUID()}`;
  let worktreeAdded = false;

  try {
    run("git", [
      "worktree",
      "add",
      "--detach",
      baselineWorktree,
      config.baseline.revision
    ], { cwd: repoRoot, stdio: "inherit" }, "baseline worktree creation");
    worktreeAdded = true;
    fs.symlinkSync(nodeModules, path.join(baselineWorktree, "node_modules"), "dir");
    fs.mkdirSync(baselineTrace);
    fs.mkdirSync(currentTrace);

    buildWorktree(baselineWorktree, "baseline");
    buildWorktree(repoRoot, "current");
    const baselineMeasurement = await measureWorktree({
      config,
      label: "baseline",
      preloadPath,
      runId: baselineRunId,
      traceDirectory: baselineTrace,
      worktree: baselineWorktree
    });
    const currentMeasurement = await measureWorktree({
      config,
      label: "current",
      preloadPath,
      runId: currentRunId,
      traceDirectory: currentTrace,
      worktree: repoRoot
    });
    const comparison = compareDynamicSubprocessEvidence({
      baselineSummary: baselineMeasurement.summary,
      config,
      currentSummary: currentMeasurement.summary
    });
    const report = {
      schema: "agent-knock-knock/dynamic-subprocess-attestation",
      version: 1,
      measured_at: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        concurrency: config.measurement.concurrency,
        dependency_lock_sha256: sha256(currentLock)
      },
      baseline: {
        revision: config.baseline.revision,
        ...publicSummary(baselineMeasurement)
      },
      current: {
        revision: currentRevision,
        ...publicSummary(currentMeasurement)
      },
      result: {
        current_percent_basis_points: comparison.currentPercentBasisPoints,
        reduction_basis_points: comparison.reductionBasisPoints,
        retained_boundaries: comparison.retainedBoundaries
      }
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (output) {
      const outputPath = path.resolve(output);
      if (repositoryContainsPath(repoRoot, outputPath)) {
        fail("--output must be outside the repository so the measured tree stays clean");
      }
      fs.writeFileSync(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
      process.stdout.write(`\nDynamic subprocess evidence: ${outputPath}\n`);
    } else {
      process.stdout.write(`\n${serialized}`);
    }
  } finally {
    if (worktreeAdded) {
      safeRemoveTemporaryWorktree(temporaryRoot, baselineWorktree);
    } else {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

await main();
