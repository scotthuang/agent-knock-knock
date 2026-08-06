import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(
  path.dirname(new URL("../src/cli.js", import.meta.url).pathname),
  "../.."
);

function readPackageFile(relativePath: string): string {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

function assertLifecycleAttestationGateBefore(
  workflowSource: string,
  publishMarker: string
): void {
  const testsIndex = workflowSource.indexOf("run: npm test");
  const extractIndex = workflowSource.indexOf(
    "Extract lifecycle smoke attestation from annotated tag"
  );
  const verifyIndex = workflowSource.indexOf(
    "node scripts/verify-lifecycle-smoke-evidence.js"
  );
  const publishIndex = workflowSource.indexOf(publishMarker);

  assert.notEqual(testsIndex, -1, "workflow must run the ordinary test suite");
  assert.notEqual(extractIndex, -1, "workflow must extract the tag attestation");
  assert.notEqual(verifyIndex, -1, "workflow must verify the tag attestation");
  assert.notEqual(publishIndex, -1, "workflow publish command must remain visible");
  assert.ok(testsIndex < extractIndex, "attestation extraction must follow npm test");
  assert.ok(extractIndex < verifyIndex, "attestation must be extracted before verification");
  assert.ok(verifyIndex < publishIndex, "attestation verification must precede publish");

  assert.match(workflowSource, /fetch-depth: 0/u);
  assert.match(workflowSource, /git cat-file -t "\$\{tag_ref\}"/u);
  assert.match(workflowSource, /\[\[ "\$\{tag_type\}" != "tag" \]\]/u);
  assert.match(
    workflowSource,
    /\["cat-file", "tag", process\.env\.TAG_REF\]/u
  );
  assert.match(
    workflowSource,
    /--attestation "\$\{RUNNER_TEMP\}\/akk-live-lifecycle-attestation\.txt"/u
  );
  assert.match(workflowSource, /--expected-commit "\$\{RELEASE_COMMIT\}"/u);
  assert.match(
    workflowSource,
    /--expected-version "\$\{GITHUB_REF_NAME#v\}"/u
  );
  assert.match(workflowSource, /--require-matrix/u);
  assert.match(workflowSource, /--max-age-hours 72/u);
  assert.doesNotMatch(
    workflowSource,
    /(?:cat|echo|printf)[^\n]*akk-live-lifecycle-attestation/u,
    "workflow must not print attestation evidence"
  );
}

test("ordinary npm test never opts into either live tmux smoke", () => {
  const packageJson = JSON.parse(readPackageFile("package.json"));
  const testScript = String(packageJson.scripts?.test ?? "");

  assert.doesNotMatch(testScript, /AKK_RUN_LIVE/u);
  assert.doesNotMatch(testScript, /smoke-(?:lifecycle-)?tmux\.js/u);
});

test("tag publish workflows verify annotated-tag lifecycle evidence before publishing", () => {
  const releaseWorkflow = readPackageFile(".github/workflows/release.yml");
  const clawHubWorkflow = readPackageFile(
    ".github/workflows/clawhub-publish.yml"
  );

  assertLifecycleAttestationGateBefore(releaseWorkflow, "npm publish \\");
  assertLifecycleAttestationGateBefore(
    clawHubWorkflow,
    './node_modules/.bin/clawhub "${publish_args[@]}"'
  );
  assert.equal(
    clawHubWorkflow.match(/verify-lifecycle-smoke-evidence\.js/gu)?.length,
    2,
    "ClawHub must reverify freshness in the independently rerunnable publish job"
  );
  assert.match(
    clawHubWorkflow,
    /Checkout, release tag, and prepared artifact commits do not match/u
  );
});

test("live tmux smoke refuses to run without both opt-ins", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, "scripts", "smoke-tmux.js"), "--confirm-live"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AKK_RUN_LIVE_TMUX_SMOKE: ""
      }
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to/u);
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

  assert.match(source, /AKK_RUN_LIVE_LIFECYCLE_SMOKE/u);
  assert.match(source, /options\.confirmLive !== true/u);
  assert.match(source, /MUTATION_COMMANDS\s*=\s*new Set/u);
  assert.match(source, /attemptedMutations\s*=\s*new Set/u);
  assert.match(source, /attemptedMutations\.has/u);
  assert.match(source, /attemptedMutations\.add/u);
  assert.match(source, /Refusing to retry lifecycle mutation/u);
  assert.match(source, /assertSourceIdentityUnchanged\(source\)/u);
  assert.match(source, /buildDigest: buildOutputDigest\(\)/u);
  assert.match(source, /actual\.buildDigest !== expected\.buildDigest/u);
  assert.match(source, /checkedGit\(\["status", "--porcelain"\]\)/u);
  assert.doesNotMatch(source, /--untracked-files=no/u);
  assert.match(
    source,
    /source identity changed during live lifecycle smoke; refusing evidence/u
  );
});
