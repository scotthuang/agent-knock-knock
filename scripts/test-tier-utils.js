import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const tierManifestPath = path.join(repoRoot, "test", "test-tiers.json");
export const testFileShardConfigPath = path.join(
  repoRoot,
  "config",
  "test-file-shards.json"
);

function failShardConfig(message) {
  throw new Error(`test file shard config ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failShardConfig(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    failShardConfig(
      `${label} keys must be exactly ${wanted.join(", ")}`
    );
  }
  return value;
}

export function validateTestFileShardConfig(value) {
  const config = exactKeys(
    value,
    ["schema", "version", "expansions"],
    "root"
  );
  if (
    config.schema !== "agent-knock-knock/test-file-shards" ||
    config.version !== 1 ||
    !Array.isArray(config.expansions) ||
    config.expansions.length === 0
  ) {
    failShardConfig("must use schema version 1 with non-empty expansions");
  }

  const canonicalSources = new Set();
  const globallyUsedCompiledShards = new Set();
  const expansions = config.expansions.map((unverified, expansionIndex) => {
    const expansion = exactKeys(
      unverified,
      ["canonical_source", "compiled_shards", "declaration_shards"],
      `expansion ${expansionIndex}`
    );
    const canonicalSource = expansion.canonical_source;
    if (
      typeof canonicalSource !== "string" ||
      !/^test\/[a-z0-9][a-z0-9/_-]*\.test\.ts$/u.test(canonicalSource) ||
      path.posix.normalize(canonicalSource) !== canonicalSource
    ) {
      failShardConfig(`expansion ${expansionIndex} canonical_source is invalid`);
    }
    if (canonicalSources.has(canonicalSource)) {
      failShardConfig(`duplicates canonical source ${canonicalSource}`);
    }
    canonicalSources.add(canonicalSource);

    if (
      !Array.isArray(expansion.compiled_shards) ||
      expansion.compiled_shards.length < 5
    ) {
      failShardConfig(
        `expansion ${canonicalSource} must declare at least five compiled shards`
      );
    }
    const compiledShards = expansion.compiled_shards.map(
      (compiledShard, shardIndex) => {
        if (
          typeof compiledShard !== "string" ||
          !/^dist\/test\/[a-z0-9][a-z0-9/_.-]*\.shard\.js$/u.test(
            compiledShard
          ) ||
          path.posix.normalize(compiledShard) !== compiledShard
        ) {
          failShardConfig(
            `expansion ${canonicalSource} compiled shard ${shardIndex} is invalid`
          );
        }
        return compiledShard;
      }
    );
    if (new Set(compiledShards).size !== compiledShards.length) {
      failShardConfig(`expansion ${canonicalSource} repeats a compiled shard`);
    }
    for (const compiledShard of compiledShards) {
      if (globallyUsedCompiledShards.has(compiledShard)) {
        failShardConfig(`reuses compiled shard ${compiledShard}`);
      }
      globallyUsedCompiledShards.add(compiledShard);
    }

    if (
      !Array.isArray(expansion.declaration_shards) ||
      expansion.declaration_shards.length === 0
    ) {
      failShardConfig(
        `expansion ${canonicalSource} must assign every test declaration`
      );
    }
    const declarationShards = expansion.declaration_shards.map(
      (shardIndex, declarationIndex) => {
        if (
          !Number.isSafeInteger(shardIndex) ||
          shardIndex < 0 ||
          shardIndex >= compiledShards.length
        ) {
          failShardConfig(
            `expansion ${canonicalSource} declaration ${declarationIndex} ` +
              "has an invalid shard"
          );
        }
        return shardIndex;
      }
    );
    const usedShards = new Set(declarationShards);
    if (usedShards.size !== compiledShards.length) {
      failShardConfig(
        `expansion ${canonicalSource} must assign at least one declaration ` +
          "to every compiled shard"
      );
    }
    return Object.freeze({
      canonicalSource,
      compiledShards: Object.freeze(compiledShards),
      declarationShards: Object.freeze(declarationShards)
    });
  });
  return Object.freeze({ expansions: Object.freeze(expansions) });
}

const testFileShardConfig = validateTestFileShardConfig(JSON.parse(
  fs.readFileSync(testFileShardConfigPath, "utf8")
));
const testFileShardExpansions = new Map(
  testFileShardConfig.expansions.map((expansion) => [
    expansion.canonicalSource,
    expansion.compiledShards
  ])
);

export function validateTestFileShardTierOwnership(config, tiers) {
  const integration = new Set(tiers.integration);
  const nonIntegrationShardSources = config.expansions
    .map((expansion) => expansion.canonicalSource)
    .filter((sourcePath) => !integration.has(sourcePath));
  if (nonIntegrationShardSources.length > 0) {
    throw new Error(
      "test file shard canonical sources must be exact integration-tier " +
        `manifest entries: ${nonIntegrationShardSources.join(", ")}`
    );
  }
}

function walkTestSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return walkTestSources(absolutePath);
      }
      return entry.isFile() && entry.name.endsWith(".test.ts")
        ? [path.relative(repoRoot, absolutePath).split(path.sep).join("/")]
        : [];
    });
}

export function loadAndValidateTestTiers() {
  const parsed = JSON.parse(fs.readFileSync(tierManifestPath, "utf8"));
  const fast = Array.isArray(parsed.fast) ? parsed.fast : [];
  const integration = Array.isArray(parsed.integration) ? parsed.integration : [];
  const classified = [...fast, ...integration];
  const duplicates = classified.filter((file, index) =>
    classified.indexOf(file) !== index
  );
  if (duplicates.length > 0) {
    throw new Error(`test tier manifest contains duplicates: ${[...new Set(duplicates)].join(", ")}`);
  }

  const discovered = walkTestSources(path.join(repoRoot, "test")).sort();
  const expected = [...classified].sort();
  const unclassified = discovered.filter((file) => !expected.includes(file));
  const missing = expected.filter((file) => !discovered.includes(file));
  if (unclassified.length > 0 || missing.length > 0) {
    throw new Error([
      unclassified.length > 0 ? `unclassified tests: ${unclassified.join(", ")}` : "",
      missing.length > 0 ? `manifest entries missing from disk: ${missing.join(", ")}` : ""
    ].filter(Boolean).join("; "));
  }
  validateTestFileShardTierOwnership(testFileShardConfig, { integration });

  return { fast, integration, full: classified };
}

export function compiledTestFilesForTier(tier, requestedSourcePaths = []) {
  const tiers = loadAndValidateTestTiers();
  if (!(tier in tiers)) {
    throw new Error(`unknown test tier ${JSON.stringify(tier)}; expected fast, integration, or full`);
  }
  if (requestedSourcePaths.length > 0 && tier !== "integration") {
    throw new Error("targeted file selection is permitted only for the integration tier");
  }
  const duplicates = requestedSourcePaths.filter((file, index) =>
    requestedSourcePaths.indexOf(file) !== index
  );
  if (duplicates.length > 0) {
    throw new Error(`targeted integration files contain duplicates: ${[...new Set(duplicates)].join(", ")}`);
  }
  for (const sourcePath of requestedSourcePaths) {
    if (!tiers.integration.includes(sourcePath)) {
      throw new Error(
        `targeted test ${JSON.stringify(sourcePath)} is not an exact integration-tier manifest entry`
      );
    }
  }
  const selected = requestedSourcePaths.length > 0
    ? requestedSourcePaths
    : tiers[tier];
  return selected.flatMap((sourcePath) => {
    const expanded = testFileShardExpansions.get(sourcePath);
    const compiledRelativePaths = expanded ?? [
      path.posix.join(
        "dist",
        sourcePath.replace(/^test\//u, "test/").replace(/\.ts$/u, ".js")
      )
    ];
    return compiledRelativePaths.map((compiledRelativePath) => {
      const compiledPath = path.join(repoRoot, compiledRelativePath);
      if (!fs.existsSync(compiledPath)) {
        throw new Error(
          `compiled test is missing: ${path.relative(repoRoot, compiledPath)}`
        );
      }
      return compiledPath;
    });
  });
}

export function configuredTestConcurrency() {
  const configured = process.env.AKK_TEST_CONCURRENCY;
  if (configured !== undefined) {
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error("AKK_TEST_CONCURRENCY must be a positive integer");
    }
    return parsed;
  }
  // The integration workers recursively spawn CLI and fake terminal processes.
  // More workers increase wall time and can starve bounded test-only gates on
  // maintainer hardware, so keep a conservative portable default.
  return Math.min(4, os.availableParallelism());
}

export function parseProfileArguments(args) {
  let tier = "full";
  let tierSeen = false;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") {
      if (output !== undefined) {
        throw new Error("--output may be supplied only once");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a path");
      }
      output = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`unknown profile option ${JSON.stringify(argument)}`);
    }
    if (tierSeen) {
      throw new Error(`unexpected profile argument ${JSON.stringify(argument)}`);
    }
    if (!["fast", "integration", "full"].includes(argument)) {
      throw new Error(
        `unknown profile tier ${JSON.stringify(argument)}; expected fast, integration, or full`
      );
    }
    tier = argument;
    tierSeen = true;
  }
  return { tier, output };
}

export function testProcessEnvironment(extra = {}) {
  const defaultCache = path.join(
    os.tmpdir(),
    `agent-knock-knock-node-compile-cache-${process.versions.modules}`
  );
  return {
    ...process.env,
    NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE || defaultCache,
    ...extra
  };
}
