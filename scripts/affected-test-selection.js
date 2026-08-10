import { spawnSync } from "node:child_process";

const CODEX_STORAGE_INTEGRATION = [
  "test/codex-store-adapter.test.ts",
  "test/codex-no-rollout-binding-cli.test.ts",
  "test/stale-bound-resume-cli.test.ts"
];

const OPENCLAW_INTEGRATION = [
  "test/openclaw-plugin-contract.test.ts",
  "test/management-cli.test.ts"
];

// Keep this map deliberately exact. A new production path must make an
// explicit choice here; otherwise selection falls back to the full suite.
export const targetedIntegrationByPath = Object.freeze({
  "src/approval-policy.ts": [
    "test/shards/agent-cli-monitor-approval-context.test.ts",
    "test/openclaw-plugin-contract.test.ts"
  ],
  "src/codex-store-adapter.ts": CODEX_STORAGE_INTEGRATION,
  "src/doctor-capabilities.ts": [
    "test/cli-ux.test.ts",
    "test/management-cli.test.ts"
  ],
  "src/openclaw-doctor.ts": [
    "test/openclaw-plugin-contract.test.ts",
    "test/management-cli.test.ts"
  ],
  "src/openclaw-plugin-helpers.ts": OPENCLAW_INTEGRATION,
  "src/openclaw-plugin.ts": OPENCLAW_INTEGRATION,
  "src/runtime-log.ts": ["test/runtime-log.test.ts"],
  "src/session-selector.ts": [
    "test/delegate-cli.test.ts",
    "test/session-selector-cli.test.ts",
    "test/management-cli.test.ts"
  ],
  "src/transcript.ts": [
    "test/callback-cli.test.ts",
    "test/cli-ux.test.ts"
  ],
  "openclaw.plugin.json": [
    "test/openclaw-plugin-contract.test.ts",
    "test/install-openclaw-cli.test.ts"
  ],
  "scripts/bidirectional-delegate.sh": ["test/delegate-cli.test.ts"]
});

const sharedCorePaths = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "test/agent-cli-fixtures.ts",
  "test/test-tiers.json",
  "src/agent-session-provider.ts",
  "src/claude-local-transcript-provider.ts",
  "src/codex-local-session-provider.ts",
  "src/codex-session-provider.ts",
  "src/executors.ts",
  "src/managed-session.ts",
  "src/protocol.ts",
  "src/session-store.ts",
  "src/store.ts"
]);

const knownNonRuntimePaths = new Set([
  ".github/dependabot.yml",
  ".github/pull_request_template.md",
  ".gitignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "ROADMAP.md",
  "SECURITY.md",
  "SUPPORT.md",
  "TODO.md",
  "docs/testing.md",
  "scripts/affected-test-selection.js",
  "scripts/run-affected-tests.js"
]);

function isSharedCorePath(repositoryPath) {
  if (sharedCorePaths.has(repositoryPath)) {
    return true;
  }
  if (/^src\/cli(?:[./-]|$)/u.test(repositoryPath)) {
    return true;
  }
  return /^src\/(?:.*lifecycle.*|native-thread-.*|terminal-.*|.*-terminal-agent-adapter)\.ts$/u
    .test(repositoryPath);
}

function isKnownNonRuntimePath(repositoryPath) {
  return knownNonRuntimePaths.has(repositoryPath) ||
    /^docs\/.*\.(?:md|png|jpe?g|gif|mp4)$/iu.test(repositoryPath);
}

export function normalizeRepositoryPath(changedPath) {
  return String(changedPath).replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
}

export function selectAffectedTests(changedPaths, tiers) {
  const normalizedPaths = [...new Set(changedPaths.map(normalizeRepositoryPath))].sort();
  const fastTests = new Set(tiers.fast);
  const integrationTests = new Set(tiers.integration);
  const selectedIntegration = new Set();

  for (const repositoryPath of normalizedPaths) {
    if (isSharedCorePath(repositoryPath)) {
      return {
        mode: "full",
        changedPaths: normalizedPaths,
        reason: `shared core changed: ${repositoryPath}`
      };
    }

    if (integrationTests.has(repositoryPath)) {
      selectedIntegration.add(repositoryPath);
      continue;
    }
    if (fastTests.has(repositoryPath) || isKnownNonRuntimePath(repositoryPath)) {
      continue;
    }

    const mappedTests = Object.hasOwn(targetedIntegrationByPath, repositoryPath)
      ? targetedIntegrationByPath[repositoryPath]
      : undefined;
    if (mappedTests === undefined) {
      return {
        mode: "full",
        changedPaths: normalizedPaths,
        reason: `unmapped changed path: ${repositoryPath}`
      };
    }
    for (const testPath of mappedTests) {
      if (!integrationTests.has(testPath)) {
        return {
          mode: "full",
          changedPaths: normalizedPaths,
          reason: `affected-test map is stale: ${testPath} is not in the integration tier`
        };
      }
      selectedIntegration.add(testPath);
    }
  }

  return {
    mode: "targeted",
    changedPaths: normalizedPaths,
    integrationFiles: tiers.integration.filter((testPath) => selectedIntegration.has(testPath))
  };
}

export function parseAffectedArguments(args) {
  let base;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base") {
      if (base !== undefined) {
        throw new Error("--base may be supplied only once");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--base requires a git revision");
      }
      base = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--base=")) {
      if (base !== undefined) {
        throw new Error("--base may be supplied only once");
      }
      base = argument.slice("--base=".length);
      if (!base || base.startsWith("-")) {
        throw new Error("--base requires a git revision");
      }
      continue;
    }
    throw new Error(`unknown affected-test option ${JSON.stringify(argument)}`);
  }
  return { base };
}

function decodeNulSeparatedPaths(output) {
  return String(output).split("\0").filter(Boolean);
}

function checkedGitPaths(runGit, args, operation) {
  const result = runGit(args);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    throw new Error(`${operation} failed${detail ? `: ${detail}` : ""}`);
  }
  return decodeNulSeparatedPaths(result.stdout ?? "");
}

function resolveBaseRevision(runGit, base) {
  const result = runGit(["rev-parse", "--verify", `${base}^{commit}`]);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    throw new Error(`git base resolution failed${detail ? `: ${detail}` : ""}`);
  }
  const revision = String(result.stdout ?? "").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(revision)) {
    throw new Error("git base resolution returned an invalid commit id");
  }
  return revision;
}

export function collectChangedPaths({ repoRoot, base, runGit } = {}) {
  const invokeGit = runGit ?? ((args) => spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8"
  }));
  const comparison = base === undefined ? "HEAD" : resolveBaseRevision(invokeGit, base);
  const tracked = checkedGitPaths(
    invokeGit,
    ["diff", "--name-only", "-z", "--no-renames", comparison, "--"],
    `git diff against ${comparison}`
  );
  const untracked = checkedGitPaths(
    invokeGit,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "git untracked-file discovery"
  );
  return [...new Set([...tracked, ...untracked].map(normalizeRepositoryPath))].sort();
}

export function determineAffectedSelection({ tiers, repoRoot, base, runGit }) {
  try {
    return selectAffectedTests(
      collectChangedPaths({ repoRoot, base, runGit }),
      tiers
    );
  } catch (error) {
    return {
      mode: "full",
      reason: `affected-test selection failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function affectedTestRuns(selection) {
  if (selection.mode === "full") {
    return [{ tier: "full", files: [] }];
  }
  return [
    { tier: "fast", files: [] },
    ...(selection.integrationFiles.length > 0
      ? [{ tier: "integration", files: selection.integrationFiles }]
      : [])
  ];
}
