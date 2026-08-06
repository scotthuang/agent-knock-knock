#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  AkkClientInvocationError,
  runLifecycleMatrix
} from "../dist/src/live-lifecycle-smoke.js";
import {
  createLiveLifecycleEvidence,
  validateLiveLifecycleEvidence
} from "../dist/src/live-lifecycle-evidence.js";
import {
  lifecycleMatrixToEvidenceInput
} from "../dist/src/live-lifecycle-smoke-evidence.js";

const MUTATION_COMMANDS = new Set([
  "new-thread",
  "send",
  "monitor",
  "resume-thread"
]);
const BOOLEAN_OPTIONS = new Set(["confirmLive", "help"]);
const VALUE_OPTIONS = new Set([
  "codexTarget",
  "codexExpectedPanePid",
  "codexExpectedVersion",
  "claudeTarget",
  "claudeExpectedPanePid",
  "claudeExpectedVersion",
  "evidence",
  "storeDir",
  "readTimeoutSeconds",
  "mutationTimeoutSeconds",
  "completionTimeoutMinutes",
  "monitorPollIntervalMs",
  "agentInactivityMinutes",
  "agentHardTimeoutMinutes"
]);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const cliPath = path.join(packageRoot, "dist", "src", "cli.js");
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;

main().catch((error) => {
  if (error?.exitCode === 64 || process.exitCode === 64) {
    return;
  }
  process.stderr.write(
    "Lifecycle smoke failed before a complete safe result could be produced. No command was retried.\n"
  );
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) {
    usage();
    return;
  }
  if (
    process.env.AKK_RUN_LIVE_LIFECYCLE_SMOKE !== "1" ||
    options.confirmLive !== true
  ) {
    usageFail(
      "Refusing to mutate real coding-agent threads. Set " +
      "AKK_RUN_LIVE_LIFECYCLE_SMOKE=1 and pass --confirm-live."
    );
  }

  const configs = scenarioConfigs(options);
  const evidencePath = prepareEvidencePath(
    requiredString(options.evidence, "--evidence is required")
  );
  const source = exactSourceIdentity();
  const timeouts = timeoutOverrides(options);
  for (const config of configs) {
    config.timeouts = timeouts;
  }

  const evidenceFd = reservePrivateFile(evidencePath);
  let evidenceWritten = false;
  try {
    process.stderr.write(
      "LIVE NATIVE LIFECYCLE SMOKE: this uses existing Codex/Claude credentials, " +
      "may incur API cost, and will mutate only the explicitly selected panes.\n"
    );
    process.stderr.write(
      "Lifecycle mutations and the foreground monitor are single-attempt; an " +
      "uncertain result is never retried or automatically recovered.\n"
    );

    const client = createSubprocessClient({
      cliPath,
      storeDir: optionalString(options.storeDir)
    });
    const matrix = await runLifecycleMatrix(configs, {
      client,
      nonce: randomUUID
    });
    assertSourceIdentityUnchanged(source);
    const rawEvidence = lifecycleMatrixToEvidenceInput(matrix, source);
    const evidence = createLiveLifecycleEvidence(rawEvidence);

    if (matrix.status === "passed" && configs.length === 2) {
      validateLiveLifecycleEvidence(evidence, {
        expectedPackageName: source.packageName,
        expectedPackageVersion: source.packageVersion,
        expectedCommit: source.commit,
        requireAgents: configs.map((config) => config.agent),
        maxAgeHours: 72
      });
    }

    fs.writeFileSync(evidenceFd, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8"
    });
    fs.fsyncSync(evidenceFd);
    evidenceWritten = true;

    for (const scenario of matrix.scenarios) {
      process.stderr.write(
        `[${scenario.agent}] ${scenario.status}: ${scenario.target} ` +
        `(pane PID ${scenario.pane_pid}, expected ${scenario.expected_agent_version})` +
        `${scenario.error_code ? ` — ${scenario.error_code}` : ""}\n`
      );
    }
    process.stdout.write(`${JSON.stringify({
      status: matrix.status,
      release_status: evidence.overall_status,
      release_matrix_complete: configs.length === 2,
      package: evidence.package,
      commit: evidence.source.commit,
      agents: Object.keys(evidence.matrix),
      digest: evidence.digest
    }, null, 2)}\n`);

    if (matrix.status === "uncertain") {
      process.stderr.write(
        "UNCERTAIN: inspect the selected pane and run AKK list. Do not rerun " +
        "the lifecycle command or guess at recovery input.\n"
      );
      process.exitCode = 2;
    } else if (matrix.status !== "passed") {
      process.exitCode = 1;
    }
  } finally {
    fs.closeSync(evidenceFd);
    if (!evidenceWritten) {
      process.stderr.write(
        "Reserved evidence file is incomplete and cannot satisfy a release gate.\n"
      );
    }
  }
}

function createSubprocessClient({ cliPath: executable, storeDir }) {
  const attemptedMutations = new Set();
  return {
    async invoke(command, args, invocation) {
      const isMutation = MUTATION_COMMANDS.has(command);
      if ((invocation.kind === "mutation") !== isMutation) {
        throw new AkkClientInvocationError("transport");
      }
      if (isMutation) {
        const mutationKey = `${command}\0${mutationIdentity(args)}`;
        if (attemptedMutations.has(mutationKey)) {
          process.stderr.write(
            "Refusing to retry lifecycle mutation after a prior attempt.\n"
          );
          throw new AkkClientInvocationError("transport");
        }
        attemptedMutations.add(mutationKey);
      }

      const scopedArgs = [
        ...args,
        ...(storeDir && !args.includes("--store-dir")
          ? ["--store-dir", storeDir]
          : [])
      ];
      const child = spawnSync(
        process.execPath,
        [executable, command, ...scopedArgs],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: invocation.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          cwd: packageRoot,
          env: productionEnvironment()
        }
      );
      if (child.error) {
        const failureKind = child.error.code === "ETIMEDOUT"
          ? "timeout"
          : "transport";
        throw new AkkClientInvocationError(failureKind);
      }
      if (child.status !== 0) {
        throw new AkkClientInvocationError("nonzero");
      }
      try {
        return JSON.parse(child.stdout);
      } catch {
        throw new AkkClientInvocationError("malformed");
      }
    }
  };
}

function scenarioConfigs(options) {
  const configs = [];
  for (const agent of ["codex", "claude"]) {
    const prefix = agent;
    const values = {
      target: options[`${prefix}Target`],
      panePid: options[`${prefix}ExpectedPanePid`],
      version: options[`${prefix}ExpectedVersion`]
    };
    const supplied = Object.values(values).filter((value) => value !== undefined);
    if (supplied.length === 0) {
      continue;
    }
    if (supplied.length !== 3) {
      usageFail(`all three --${agent}-* selector arguments are required together`);
    }
    configs.push({
      agent,
      target: requiredString(values.target, `--${agent}-target is required`),
      expectedPanePid: positiveInteger(
        values.panePid,
        `--${agent}-expected-pane-pid must be an integer greater than one`
      ),
      expectedAgentVersion: requiredString(
        values.version,
        `--${agent}-expected-version is required`
      )
    });
  }
  if (configs.length === 0) {
    usageFail("provide an exact Codex pane, an exact Claude pane, or both");
  }
  return configs;
}

function timeoutOverrides(options) {
  const values = {};
  setScaledInteger(values, "readMs", options.readTimeoutSeconds, 1000);
  setScaledInteger(values, "mutationMs", options.mutationTimeoutSeconds, 1000);
  setScaledInteger(
    values,
    "completionMs",
    options.completionTimeoutMinutes,
    60_000
  );
  setScaledInteger(
    values,
    "monitorPollIntervalMs",
    options.monitorPollIntervalMs,
    1
  );
  setScaledInteger(
    values,
    "agentInactivityMinutes",
    options.agentInactivityMinutes,
    1
  );
  setScaledInteger(
    values,
    "agentHardTimeoutMinutes",
    options.agentHardTimeoutMinutes,
    1
  );
  return values;
}

function exactSourceIdentity() {
  const topLevel = checkedGit(["rev-parse", "--show-toplevel"]);
  if (path.resolve(topLevel) !== fs.realpathSync(packageRoot)) {
    usageFail("runner must execute from the Agent Knock Knock repository");
  }
  const commit = checkedGit(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    usageFail("git HEAD is not an exact commit");
  }
  const worktreeChanges = checkedGit(["status", "--porcelain"]);
  if (worktreeChanges !== "") {
    usageFail("worktree must be clean before live evidence");
  }
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
  );
  return {
    packageName: requiredString(packageJson.name, "package name is missing"),
    packageVersion: requiredString(
      packageJson.version,
      "package version is missing"
    ),
    commit,
    buildDigest: buildOutputDigest()
  };
}

function assertSourceIdentityUnchanged(expected) {
  const actual = exactSourceIdentity();
  if (
    actual.packageName !== expected.packageName ||
    actual.packageVersion !== expected.packageVersion ||
    actual.commit !== expected.commit ||
    actual.buildDigest !== expected.buildDigest
  ) {
    usageFail(
      "source identity changed during live lifecycle smoke; refusing evidence"
    );
  }
}

function buildOutputDigest() {
  const buildRoot = path.join(packageRoot, "dist", "src");
  let entries;
  try {
    entries = fs.readdirSync(buildRoot, { withFileTypes: true });
  } catch {
    usageFail("compiled runtime is missing; run the lifecycle smoke via npm");
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) {
    usageFail("compiled runtime is missing; run the lifecycle smoke via npm");
  }
  const digest = createHash("sha256");
  for (const name of files) {
    digest.update(name);
    digest.update("\0");
    digest.update(fs.readFileSync(path.join(buildRoot, name)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function prepareEvidencePath(value) {
  const requested = path.resolve(value);
  fs.mkdirSync(path.dirname(requested), { recursive: true, mode: 0o700 });
  const parent = fs.realpathSync(path.dirname(requested));
  const canonical = path.join(parent, path.basename(requested));
  if (isInside(packageRoot, canonical)) {
    usageFail("--evidence must point outside the repository");
  }
  return canonical;
}

function reservePrivateFile(filePath) {
  try {
    const fd = fs.openSync(
      filePath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        NO_FOLLOW_FLAG,
      PRIVATE_FILE_MODE
    );
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    return fd;
  } catch {
    usageFail("--evidence must name a new, writable, non-symlink file");
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      usageFail(`unexpected argument: ${argument}`);
    }
    const key = argument
      .slice(2)
      .replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (!BOOLEAN_OPTIONS.has(key) && !VALUE_OPTIONS.has(key)) {
      usageFail(`unknown option: ${argument}`);
    }
    if (Object.hasOwn(parsed, key)) {
      usageFail(`option may be supplied only once: ${argument}`);
    }
    if (BOOLEAN_OPTIONS.has(key)) {
      parsed[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      usageFail(`${argument} requires a value`);
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function productionEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AKK_TEST_"))
  );
}

function mutationIdentity(args) {
  for (const option of ["--terminal", "--session", "--state"]) {
    const index = args.indexOf(option);
    if (index >= 0 && args[index + 1]) {
      return `${option}:${args[index + 1]}`;
    }
  }
  return args.join("\0");
}

function setScaledInteger(target, key, value, scale) {
  if (value === undefined) {
    return;
  }
  const parsed = Number(value);
  const scaled = parsed * scale;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || !Number.isSafeInteger(scaled)) {
    usageFail(`--${camelToKebab(key)} must be a positive integer`);
  }
  target[key] = scaled;
}

function positiveInteger(value, message) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 1) {
    usageFail(message);
  }
  return parsed;
}

function requiredString(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    usageFail(message);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function checkedGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    usageFail("could not verify the exact git source identity");
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(fs.realpathSync(parent), candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function usage() {
  process.stdout.write(`Usage:
  AKK_RUN_LIVE_LIFECYCLE_SMOKE=1 npm run smoke:lifecycle -- --confirm-live \\
    [--codex-target <session:window.pane> --codex-expected-pane-pid <pid> --codex-expected-version <version>] \\
    [--claude-target <session:window.pane> --claude-expected-pane-pid <pid> --claude-expected-version <version>] \\
    --evidence </absolute/private/new-file.json> [--store-dir <dir>]

Runs the exact native lifecycle A -> new B -> one Send -> exact resume A.
At least one complete agent selector is required; release evidence requires both.
`);
}

function usageFail(message) {
  const error = new Error(message);
  error.exitCode = 64;
  process.stderr.write(`${message}\n`);
  process.exitCode = 64;
  throw error;
}
