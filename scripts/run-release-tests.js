import { spawnSync } from "node:child_process";
import { repoRoot, testProcessEnvironment } from "./test-tier-utils.js";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const invocation = parseInvocation(process.argv.slice(2));
const scripts = [
  "test:full",
  "compat:openclaw",
  "clawhub:validate",
  "clawhub:dry-run"
];

for (const script of scripts) {
  if (!runNpmScript(script)) {
    break;
  }
}

if (invocation.live && !process.exitCode) {
  const smokePassed = runNpmScript("smoke:lifecycle", invocation.smokeArgs);
  if (smokePassed) {
    runNpmScript("smoke:lifecycle:attest", [
      "--evidence",
      invocation.evidencePath,
      "--require-matrix"
    ]);
  }
}

if (!invocation.live && !process.exitCode) {
  process.stdout.write(
    "\nNative lifecycle smoke was not run. Opt in with npm run test:release:live " +
    "only when dedicated Codex and Claude tmux panes are prepared.\n"
  );
}

function runNpmScript(script, forwardedArgs = []) {
  process.stdout.write(`\nAKK release gate: npm run ${script}\n`);
  const result = spawnSync(
    npmCommand,
    ["run", script, ...(forwardedArgs.length > 0 ? ["--", ...forwardedArgs] : [])],
    {
      cwd: repoRoot,
      env: testProcessEnvironment(),
      stdio: "inherit"
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

function parseInvocation(args) {
  const liveIndexes = args.flatMap((argument, index) =>
    argument === "--live" ? [index] : []
  );
  if (liveIndexes.length === 0) {
    if (args.length > 0) {
      usageFail("release gate arguments are only accepted by test:release:live");
    }
    return { live: false, smokeArgs: [], evidencePath: undefined };
  }
  if (liveIndexes.length !== 1) {
    usageFail("--live must be supplied exactly once");
  }
  if (process.env.AKK_RUN_LIVE_LIFECYCLE_SMOKE !== "1") {
    usageFail(
      "live release gate requires AKK_RUN_LIVE_LIFECYCLE_SMOKE=1 in addition to --confirm-live"
    );
  }

  const smokeArgs = args.filter((_, index) => index !== liveIndexes[0]);
  if (smokeArgs.filter((argument) => argument === "--confirm-live").length !== 1) {
    usageFail("live release gate requires --confirm-live exactly once");
  }
  const requiredValues = [
    "--codex-target",
    "--codex-expected-pane-pid",
    "--codex-expected-version",
    "--claude-target",
    "--claude-expected-pane-pid",
    "--claude-expected-version",
    "--evidence"
  ];
  const values = new Map();
  for (const option of requiredValues) {
    const indexes = smokeArgs.flatMap((argument, index) =>
      argument === option ? [index] : []
    );
    if (indexes.length !== 1) {
      usageFail(`${option} must be supplied exactly once`);
    }
    const value = smokeArgs[indexes[0] + 1];
    if (!value || value.startsWith("--")) {
      usageFail(`${option} requires a value`);
    }
    values.set(option, value);
  }

  return {
    live: true,
    smokeArgs,
    evidencePath: values.get("--evidence")
  };
}

function usageFail(message) {
  process.stderr.write(`Invalid release gate invocation: ${message}.\n`);
  process.exit(64);
}
