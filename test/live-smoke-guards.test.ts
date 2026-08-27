import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(new URL("../src/cli.js", import.meta.url).pathname),
  "../.."
);

function readPackageFile(relativePath: string): string {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

test("ordinary npm test stays non-live and the explicit live release tier is wired end to end", () => {
  const packageJson = JSON.parse(readPackageFile("package.json"));
  const testScript = String(packageJson.scripts?.test ?? "");
  const releaseScript = String(packageJson.scripts?.["test:release"] ?? "");
  const liveScript = String(packageJson.scripts?.["test:release:live"] ?? "");
  const runner = readPackageFile("scripts/run-release-tests.js");

  assert.doesNotMatch(testScript, /AKK_RUN_LIVE/u);
  assert.doesNotMatch(testScript, /smoke-(?:lifecycle-)?tmux\.js/u);
  assert.match(releaseScript, /run-release-tests\.js$/u);
  assert.match(liveScript, /run-release-tests\.js --live$/u);
  assert.doesNotMatch(releaseScript, /--live/u);
  assert.match(runner, /AKK_RUN_LIVE_LIFECYCLE_SMOKE/u);
  assert.match(runner, /"--confirm-live"/u);
  assert.match(runner, /"--codex-target"/u);
  assert.match(runner, /"--claude-target"/u);
  assert.match(runner, /runNpmScript\("smoke:lifecycle", invocation\.smokeArgs\)/u);
  assert.match(runner, /"smoke:lifecycle:attest"/u);
  assert.match(runner, /"--require-matrix"/u);
});

test("OpenClaw compatibility installs retry hard npm timeouts with stable authority", async () => {
  const { runNpmWithRetries } = await import(
    pathToFileURL(path.join(packageRoot, "scripts", "npm-command-retry.js")).href
  );
  const cwd = path.join(packageRoot, "compat-host");
  const env = { npm_config_cache: path.join(packageRoot, "compat-cache") };
  const calls: Array<{ cwd: string; env: object; allowNonzero: boolean }> = [];
  const messages: string[] = [];

  const result = runNpmWithRetries({
    args: ["install", "openclaw@example"],
    options: { cwd, env, timeoutMs: 1 },
    run: (_command: string, _args: string[], options: typeof calls[number]) => {
      calls.push(options);
      if (calls.length === 1) {
        throw new Error("spawnSync npm ETIMEDOUT");
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    writeRetry: (message: string) => messages.push(message)
  });

  assert.equal(result.status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.cwd, cwd);
  assert.equal(calls[1]?.cwd, cwd);
  assert.equal(calls[0]?.env, env);
  assert.equal(calls[1]?.env, env);
  assert.deepEqual(messages, ["npm network failure; retrying (1/3)...\n"]);
});

test("OpenClaw compatibility npm retry policy remains bounded and network-only", async () => {
  const { runNpmWithRetries } = await import(
    pathToFileURL(path.join(packageRoot, "scripts", "npm-command-retry.js")).href
  );
  let timeoutCalls = 0;
  assert.throws(
    () => runNpmWithRetries({
      args: ["install"],
      options: {},
      run: () => {
        timeoutCalls += 1;
        throw new Error("spawnSync npm ETIMEDOUT");
      },
      writeRetry: () => {}
    }),
    /ETIMEDOUT/u
  );
  assert.equal(timeoutCalls, 3);

  let resolutionCalls = 0;
  assert.throws(
    () => runNpmWithRetries({
      args: ["install"],
      options: {},
      run: () => {
        resolutionCalls += 1;
        throw new Error("npm ERESOLVE");
      },
      writeRetry: () => {}
    }),
    /ERESOLVE/u
  );
  assert.equal(resolutionCalls, 1);

  let statusCalls = 0;
  const recovered = runNpmWithRetries({
    args: ["install"],
    options: {},
    run: () => {
      statusCalls += 1;
      return statusCalls === 1
        ? { status: 1, stdout: "", stderr: "npm ETIMEDOUT" }
        : { status: 0, stdout: "", stderr: "" };
    },
    writeRetry: () => {}
  });
  assert.equal(recovered.status, 0);
  assert.equal(statusCalls, 2);
});

test("GitHub workflows stay suspended while Issue 126 refactoring is active", () => {
  const workflowsDirectory = path.join(packageRoot, ".github", "workflows");
  const workflowFiles = fs.existsSync(workflowsDirectory)
    ? fs.readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/u.test(name))
    : [];

  assert.deepEqual(workflowFiles, []);
});

test("live tmux smoke refuses to run without both opt-ins", async () => {
  const { assertLiveTmuxSmokeOptIn } = await import(
    pathToFileURL(path.join(packageRoot, "scripts", "smoke-tmux.js")).href
  );
  assert.throws(
    () => assertLiveTmuxSmokeOptIn(
      ["--confirm-live"],
      { ...process.env, AKK_RUN_LIVE_TMUX_SMOKE: "" }
    ),
    /Refusing to/u
  );
});

test("tmux smoke requires verified idle state and exact pane identity before send", () => {
  const source = readPackageFile("scripts/smoke-tmux.js");

  assert.match(source, /AKK_RUN_LIVE_TMUX_SMOKE/u);
  assert.match(source, /options\.confirmLive !== true/u);
  assert.match(source, /selected\.activity_state !== "idle"/u);
  assert.match(source, /expectedPanePid/u);
  assert.match(source, /terminal_control\?\.panePid/u);
  assert.match(source, /LIVE TMUX SMOKE: sending one real turn/u);
  assert.match(source, /"--background"/u);
});

test("lifecycle live smoke requires two opt-ins and never retries a mutation", () => {
  const source = readPackageFile("scripts/smoke-lifecycle-tmux.js");
  const coreSource = readPackageFile("src/live-lifecycle-smoke.ts");

  assert.match(source, /AKK_RUN_LIVE_LIFECYCLE_SMOKE/u);
  assert.match(source, /options\.confirmLive !== true/u);
  assert.match(source, /MUTATION_COMMANDS\s*=\s*new Set/u);
  assert.match(source, /attemptedMutations\s*=\s*new Set/u);
  assert.match(source, /attemptedMutations\.has/u);
  assert.match(source, /attemptedMutations\.add/u);
  assert.match(source, /Refusing to retry lifecycle mutation/u);
  assert.match(
    source,
    /assertSourceIdentityUnchanged\(source, matrix\.status\)/u
  );
  assert.match(source, /buildDigest: buildOutputDigest\(\)/u);
  assert.match(source, /actual\.buildDigest !== expected\.buildDigest/u);
  assert.match(source, /"--porcelain=v1"/u);
  assert.match(source, /"--untracked-files=all"/u);
  assert.match(source, /matrixStatus === "uncertain" \? 2 : 1/u);
  assert.match(
    source,
    /error\?\.exitCode === 2 \|\| process\.exitCode === 2 \? 2 : 1/u
  );
  assert.match(source, /process\.exitCode = matrix\.status === "uncertain"/u);
  assert.match(source, /catch \{\s*sourceIdentityChanged\(matrixStatus\);/u);
  assert.match(
    source,
    /source identity changed during live lifecycle smoke; refusing evidence/u
  );
  assert.match(source, /Inspect the selected panes and do not retry/u);
  assert.match(
    coreSource,
    /"--require-restorable-origin"/u,
    "the lifecycle smoke must prove A is resumable before New clears it"
  );
  assert.ok(
    source.indexOf("assertSourceIdentityUnchanged(source, matrix.status)") <
      source.indexOf("lifecycleMatrixToEvidenceInput(matrix, source)"),
    "final source identity must be proven before evidence conversion"
  );
});
