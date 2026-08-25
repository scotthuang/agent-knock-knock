import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  loadAndValidateProductionModuleOwnership
} from "./production-module-ownership.js";

// Non-production runtime surfaces remain exact here. Production modules use
// the independently validated ownership manifest below.
export const targetedIntegrationByPath = Object.freeze({
  "openclaw.plugin.json": [
    "test/openclaw-plugin-contract.test.ts",
    "test/install-openclaw-cli.test.ts"
  ],
  "scripts/bidirectional-delegate.sh": ["test/delegate-cli.test.ts"]
});

// Test helpers are not tier entries themselves. Each edge below is a direct
// consumer. Resolution is transitive, so changing the common in-process helper
// selects both its direct integration consumers and every integration consumer
// reached through the two narrower helpers.
export const testSupportImpactByPath = Object.freeze({
  "test/agent-cli-fixtures.ts": [
    "test/claude-native-inspection-cli.test.ts",
    "test/shards/agent-cli-claude-callback.test.ts",
    "test/shards/agent-cli-composer-replay.test.ts",
    "test/shards/agent-cli-control-locks.test.ts",
    "test/shards/agent-cli-dispatch-authority.test.ts",
    "test/shards/agent-cli-dispatch-recovery.test.ts",
    "test/shards/agent-cli-monitor-approval-context.test.ts",
    "test/shards/agent-cli-monitor-lifecycle.test.ts",
    "test/shards/agent-cli-monitor-recovery.test.ts",
    "test/shards/agent-cli-receipt-fences.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts",
    "test/shards/agent-cli-terminal-send-gates.test.ts"
  ],
  "test/codex-sticky-rollout-fixture.ts": [
    "test/codex-sticky-rollout-lifecycle-core.test.ts"
  ],
  "test/in-process-cli-fixtures.ts": [
    "test/agent-cli-fixtures.ts",
    "test/callback-cli.test.ts",
    "test/cli-core.test.ts",
    "test/cli-ux.test.ts",
    "test/codex-sticky-rollout-fixture.ts",
    "test/delegate-cli.test.ts",
    "test/human-handoff-adoption-cli.test.ts",
    "test/install-openclaw-cli.test.ts",
    "test/management-cli.test.ts",
    "test/native-lifecycle-command-guard-cli.test.ts",
    "test/native-thread-lifecycle-recovery-cli.test.ts",
    "test/native-thread-ownership-cli.test.ts",
    "test/session-selector-cli.test.ts",
    "test/shards/agent-cli-composer-replay.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts",
    "test/store-protocol-cli.test.ts",
    "test/turn-session-binding-cli.test.ts"
  ]
});

const alwaysFullSharedPaths = new Set([
  "tsconfig.json",
  "config/test-file-shards.json",
  "config/production-module-ownership.json",
  "scripts/production-module-ownership.js",
  "scripts/validate-architecture.js",
  "scripts/affected-test-selection.js",
  "scripts/run-affected-tests.js"
]);

const semanticSharedPaths = new Set([
  "package.json",
  "package-lock.json",
  "test/test-tiers.json"
]);
const reviewedChangeSemantics = new WeakSet();

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
  "templates/openclaw-skills/agent-knock-knock/SKILL.md"
]);

function isKnownNonRuntimePath(repositoryPath) {
  return knownNonRuntimePaths.has(repositoryPath) ||
    /^docs\/.*\.(?:md|png|jpe?g|gif|mp4)$/iu.test(repositoryPath);
}

export function normalizeRepositoryPath(changedPath) {
  return String(changedPath).replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
}

function parseJsonObject(text, label) {
  const value = JSON.parse(String(text));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function validatedTierSnapshot(text, label) {
  const value = parseJsonObject(text, label);
  if (
    !isDeepStrictEqual(Object.keys(value).sort(), ["fast", "integration"]) ||
    !Array.isArray(value.fast) ||
    !Array.isArray(value.integration)
  ) {
    throw new Error(`${label} must contain only fast and integration arrays`);
  }
  const entries = [...value.fast, ...value.integration];
  if (
    entries.some((entry) =>
      typeof entry !== "string" || !/^test\/.+\.test\.ts$/u.test(entry)
    ) ||
    new Set(entries).size !== entries.length
  ) {
    throw new Error(`${label} contains an invalid or duplicate test path`);
  }
  return { fast: value.fast, integration: value.integration };
}

function additiveTierManifestSemantics(beforeText, afterText, changedPaths) {
  const before = validatedTierSnapshot(beforeText, "base test tier manifest");
  const after = validatedTierSnapshot(afterText, "changed test tier manifest");
  const changed = new Set(changedPaths);
  const additions = [];
  for (const tier of ["fast", "integration"]) {
    const beforeSet = new Set(before[tier]);
    const added = after[tier].filter((testPath) => !beforeSet.has(testPath));
    const addedSet = new Set(added);
    if (!isDeepStrictEqual(
      after[tier].filter((testPath) => !addedSet.has(testPath)),
      before[tier]
    )) {
      return undefined;
    }
    for (const testPath of added) {
      if (!changed.has(testPath)) {
        return undefined;
      }
      additions.push(Object.freeze({ path: testPath, tier }));
    }
  }
  return additions.length > 0
    ? Object.freeze({ kind: "additive-test-tier-entries", entries: Object.freeze(additions) })
    : undefined;
}

function packageVersionOnlySemantics(packageBeforeText, packageAfterText,
  lockBeforeText, lockAfterText) {
  const packageBefore = parseJsonObject(packageBeforeText, "base package manifest");
  const packageAfter = parseJsonObject(packageAfterText, "changed package manifest");
  const lockBefore = parseJsonObject(lockBeforeText, "base package lock");
  const lockAfter = parseJsonObject(lockAfterText, "changed package lock");
  const beforeVersion = packageBefore.version;
  const afterVersion = packageAfter.version;
  if (
    typeof beforeVersion !== "string" || !beforeVersion ||
    typeof afterVersion !== "string" || !afterVersion ||
    beforeVersion === afterVersion ||
    lockBefore.version !== beforeVersion ||
    lockAfter.version !== afterVersion ||
    lockBefore.packages?.[""]?.version !== beforeVersion ||
    lockAfter.packages?.[""]?.version !== afterVersion
  ) {
    return undefined;
  }
  const packageBeforeRest = structuredClone(packageBefore);
  const packageAfterRest = structuredClone(packageAfter);
  const lockBeforeRest = structuredClone(lockBefore);
  const lockAfterRest = structuredClone(lockAfter);
  delete packageBeforeRest.version;
  delete packageAfterRest.version;
  delete lockBeforeRest.version;
  delete lockAfterRest.version;
  delete lockBeforeRest.packages[""].version;
  delete lockAfterRest.packages[""].version;
  if (
    !isDeepStrictEqual(packageBeforeRest, packageAfterRest) ||
    !isDeepStrictEqual(lockBeforeRest, lockAfterRest)
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "synchronized-package-version-only",
    beforeVersion,
    afterVersion
  });
}

export function analyzeChangedFileSemantics({
  changedPaths,
  readBeforePath,
  readAfterPath,
  pathExistsBefore
}) {
  const normalizedPaths = [...new Set(changedPaths.map(normalizeRepositoryPath))].sort();
  const changed = new Set(normalizedPaths);
  const semantics = {};
  if (changed.has("test/test-tiers.json")) {
    try {
      const tierProof = additiveTierManifestSemantics(
        readBeforePath("test/test-tiers.json"),
        readAfterPath("test/test-tiers.json"),
        normalizedPaths
      );
      if (tierProof && typeof pathExistsBefore === "function" &&
        tierProof.entries.every((entry) => {
          try {
            if (pathExistsBefore(entry.path) !== false) {
              return false;
            }
            const source = readAfterPath(entry.path);
            return typeof source === "string" && source.trim().length > 0;
          } catch {
            return false;
          }
        })) {
        semantics.testTierManifest = tierProof;
      }
    } catch {
      // An unreadable or structurally invalid manifest has no safe semantics.
    }
  }
  if (changed.has("package.json") && changed.has("package-lock.json")) {
    try {
      semantics.packageVersion = packageVersionOnlySemantics(
        readBeforePath("package.json"),
        readAfterPath("package.json"),
        readBeforePath("package-lock.json"),
        readAfterPath("package-lock.json")
      );
    } catch {
      // Any parse/read failure deliberately withholds the version-only proof.
    }
  }
  const reviewedSemantics = Object.freeze({ ...semantics });
  reviewedChangeSemantics.add(reviewedSemantics);
  return reviewedSemantics;
}

function semanticSharedPathIsReviewed(repositoryPath, changedPaths, tiers,
  changeSemantics) {
  if (!reviewedChangeSemantics.has(changeSemantics)) {
    return false;
  }
  if (repositoryPath === "test/test-tiers.json") {
    const proof = changeSemantics?.testTierManifest;
    return proof?.kind === "additive-test-tier-entries" &&
      Array.isArray(proof.entries) && proof.entries.length > 0 &&
      proof.entries.every((entry) =>
        changedPaths.has(entry.path) &&
        (entry.tier === "fast" || entry.tier === "integration") &&
        tiers[entry.tier].includes(entry.path)
      );
  }
  if (repositoryPath === "package.json" || repositoryPath === "package-lock.json") {
    return changedPaths.has("package.json") &&
      changedPaths.has("package-lock.json") &&
      changeSemantics?.packageVersion?.kind ===
        "synchronized-package-version-only";
  }
  return false;
}

function addTestSupportImpact(repositoryPath, fastTests, integrationTests,
  selectedIntegration, visiting = new Set(), visited = new Set()) {
  if (visited.has(repositoryPath)) {
    return undefined;
  }
  if (visiting.has(repositoryPath)) {
    return `test support ownership contains a cycle: ${repositoryPath}`;
  }
  const consumers = testSupportImpactByPath[repositoryPath];
  if (!Array.isArray(consumers) || consumers.length === 0) {
    return `unmapped changed path: ${repositoryPath}`;
  }
  visiting.add(repositoryPath);
  for (const consumer of consumers) {
    if (integrationTests.has(consumer)) {
      selectedIntegration.add(consumer);
      continue;
    }
    if (fastTests.has(consumer)) {
      continue;
    }
    if (!Object.hasOwn(testSupportImpactByPath, consumer)) {
      return `test support ownership has unknown consumer: ${consumer}`;
    }
    const error = addTestSupportImpact(
      consumer,
      fastTests,
      integrationTests,
      selectedIntegration,
      visiting,
      visited
    );
    if (error) {
      return error;
    }
  }
  visiting.delete(repositoryPath);
  visited.add(repositoryPath);
  return undefined;
}

export function selectAffectedTests(
  changedPaths,
  tiers,
  { productionOwnership, loadProductionOwnership, changeSemantics } = {}
) {
  const normalizedPaths = [...new Set(changedPaths.map(normalizeRepositoryPath))].sort();
  const normalizedPathSet = new Set(normalizedPaths);
  const fastTests = new Set(tiers.fast);
  const integrationTests = new Set(tiers.integration);
  const selectedIntegration = new Set();
  let ownership = productionOwnership;
  try {
    ownership ??= (loadProductionOwnership ?? loadAndValidateProductionModuleOwnership)({
      tiers
    });
  } catch (error) {
    return {
      mode: "full",
      changedPaths: normalizedPaths,
      reason: `production ownership unavailable: ` +
        `${error instanceof Error ? error.message : String(error)}`
    };
  }

  for (const repositoryPath of normalizedPaths) {
    if (alwaysFullSharedPaths.has(repositoryPath)) {
      return {
        mode: "full",
        changedPaths: normalizedPaths,
        reason: `shared test or architecture configuration changed: ${repositoryPath}`
      };
    }
    if (semanticSharedPaths.has(repositoryPath)) {
      if (semanticSharedPathIsReviewed(
        repositoryPath,
        normalizedPathSet,
        tiers,
        changeSemantics
      )) {
        continue;
      }
      return {
        mode: "full",
        changedPaths: normalizedPaths,
        reason: `shared configuration lacks a safe semantic proof: ${repositoryPath}`
      };
    }

    if (repositoryPath.startsWith("src/")) {
      const impact = ownership.modules[repositoryPath];
      if (!impact) {
        return {
          mode: "full",
          changedPaths: normalizedPaths,
          reason: `production module has no owner: ${repositoryPath}`
        };
      }
      if (impact.selection === "full") {
        return {
          mode: "full",
          changedPaths: normalizedPaths,
          reason: `production domain requires full suite: ` +
            `${impact.owner} (${repositoryPath})`
        };
      }
      for (const testPath of impact.integrationTests) {
        if (!integrationTests.has(testPath)) {
          return {
            mode: "full",
            changedPaths: normalizedPaths,
            reason: `production ownership is stale: ${testPath} ` +
              "is not in the integration tier"
          };
        }
        selectedIntegration.add(testPath);
      }
      continue;
    }

    if (integrationTests.has(repositoryPath)) {
      selectedIntegration.add(repositoryPath);
      continue;
    }
    if (fastTests.has(repositoryPath) || isKnownNonRuntimePath(repositoryPath)) {
      continue;
    }

    if (Object.hasOwn(testSupportImpactByPath, repositoryPath)) {
      const error = addTestSupportImpact(
        repositoryPath,
        fastTests,
        integrationTests,
        selectedIntegration
      );
      if (error) {
        return {
          mode: "full",
          changedPaths: normalizedPaths,
          reason: error
        };
      }
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

function checkedGitText(runGit, args, operation) {
  const result = runGit(args);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    throw new Error(`${operation} failed${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout ?? "");
}

function revisionContainsPath(runGit, revision, repositoryPath) {
  const matches = checkedGitPaths(
    runGit,
    ["ls-tree", "-z", "--name-only", revision, "--", repositoryPath],
    `checking ${repositoryPath} at ${revision}`
  );
  if (matches.length === 0) {
    return false;
  }
  if (
    matches.length !== 1 ||
    normalizeRepositoryPath(matches[0]) !== repositoryPath
  ) {
    throw new Error(
      `git tree lookup returned an unexpected path for ${repositoryPath} ` +
      `at ${revision}`
    );
  }
  return true;
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
  return collectChangedPathSet({ repoRoot, base, runGit }).changedPaths;
}

function collectChangedPathSet({ repoRoot, base, runGit } = {}) {
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
  return {
    changedPaths: [...new Set(
      [...tracked, ...untracked].map(normalizeRepositoryPath)
    )].sort(),
    comparison,
    invokeGit
  };
}

export function analyzeRevisionChangeSemantics({
  repoRoot,
  changedPaths,
  beforeRevision,
  afterRevision,
  runGit
}) {
  const invokeGit = runGit ?? ((args) => spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  }));
  const readRevisionPath = (revision, repositoryPath) => checkedGitText(
    invokeGit,
    ["show", `${revision}:${repositoryPath}`],
    `reading ${repositoryPath} at ${revision}`
  );
  return analyzeChangedFileSemantics({
    changedPaths,
    readBeforePath: (repositoryPath) =>
      readRevisionPath(beforeRevision, repositoryPath),
    readAfterPath: (repositoryPath) =>
      readRevisionPath(afterRevision, repositoryPath),
    pathExistsBefore: (repositoryPath) =>
      revisionContainsPath(invokeGit, beforeRevision, repositoryPath)
  });
}

export function determineAffectedSelection({ tiers, repoRoot, base, runGit }) {
  try {
    const changeSet = collectChangedPathSet({ repoRoot, base, runGit });
    const changeSemantics = analyzeChangedFileSemantics({
      changedPaths: changeSet.changedPaths,
      readBeforePath: (repositoryPath) => checkedGitText(
        changeSet.invokeGit,
        ["show", `${changeSet.comparison}:${repositoryPath}`],
        `reading ${repositoryPath} at ${changeSet.comparison}`
      ),
      readAfterPath: (repositoryPath) => fs.readFileSync(
        path.join(repoRoot, repositoryPath),
        "utf8"
      ),
      pathExistsBefore: (repositoryPath) => revisionContainsPath(
        changeSet.invokeGit,
        changeSet.comparison,
        repositoryPath
      )
    });
    return selectAffectedTests(
      changeSet.changedPaths,
      tiers,
      { changeSemantics }
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
