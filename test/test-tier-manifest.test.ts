import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function walkTests(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walkTests(absolutePath);
    }
    return entry.isFile() && entry.name.endsWith(".test.ts")
      ? [path.relative(repoRoot, absolutePath).split(path.sep).join("/")]
      : [];
  });
}

test("every test file belongs to exactly one documented tier", () => {
  const manifestPath = path.join(repoRoot, "test", "test-tiers.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.ok(Array.isArray(manifest.fast));
  assert.ok(Array.isArray(manifest.integration));
  const classified = [...manifest.fast, ...manifest.integration];
  assert.equal(new Set(classified).size, classified.length, "tier entries must be unique");
  assert.deepEqual(
    [...classified].sort(),
    walkTests(path.join(repoRoot, "test")).sort()
  );
});

test("npm test remains full while targeted integration selection fails closed", async () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
  );
  assert.equal(packageJson.scripts.test, "npm run test:full");
  assert.match(packageJson.scripts["test:fast"], /run-test-tier\.js fast/u);
  assert.match(packageJson.scripts["test:integration"], /run-test-tier\.js integration/u);
  assert.match(packageJson.scripts["test:full"], /run-test-tier\.js full/u);
  assert.equal(
    packageJson.scripts["test:profile"],
    "npm run build && node scripts/profile-test-tier.js"
  );
  assert.equal(typeof packageJson.scripts["test:release"], "string");

  const tierUtils = await import(
    pathToFileURL(path.join(repoRoot, "scripts", "test-tier-utils.js")).href
  );
  assert.deepEqual(
    tierUtils.compiledTestFilesForTier("integration", [
      "test/runtime-log.test.ts"
    ]),
    [path.join(repoRoot, "dist", "test", "runtime-log.test.js")]
  );
  const codexNoRolloutShards = tierUtils.compiledTestFilesForTier(
    "integration",
    ["test/codex-no-rollout-binding-cli.test.ts"]
  );
  assert.equal(codexNoRolloutShards.length, 8);
  assert.deepEqual(
    codexNoRolloutShards,
    Array.from({ length: 8 }, (_, shardIndex) => path.join(
      repoRoot,
      "dist",
      "test",
      "shards",
      `codex-no-rollout-binding-cli-${shardIndex}.shard.js`
    ))
  );
  const shardConfig = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "config", "test-file-shards.json"),
    "utf8"
  ));
  const validatedShardConfig =
    tierUtils.validateTestFileShardConfig(shardConfig);
  assert.equal(shardConfig.expansions[0].declaration_shards.length, 97);
  assert.throws(
    () => tierUtils.validateTestFileShardTierOwnership(
      validatedShardConfig,
      { integration: ["test/runtime-log.test.ts"] }
    ),
    /exact integration-tier manifest entries/u
  );
  assert.throws(
    () => tierUtils.validateTestFileShardConfig({
      ...shardConfig,
      expansions: [{
        ...shardConfig.expansions[0],
        declaration_shards: [8]
      }]
    }),
    /invalid shard/u
  );
  assert.throws(
    () => tierUtils.validateTestFileShardConfig({
      ...shardConfig,
      expansions: [{
        ...shardConfig.expansions[0],
        compiled_shards: [
          ...shardConfig.expansions[0].compiled_shards.slice(0, -1),
          shardConfig.expansions[0].compiled_shards[0]
        ]
      }]
    }),
    /repeats a compiled shard/u
  );
  assert.throws(
    () => tierUtils.validateTestFileShardConfig({
      ...shardConfig,
      expansions: [
        shardConfig.expansions[0],
        {
          ...shardConfig.expansions[0],
          canonical_source: "test/runtime-log.test.ts"
        }
      ]
    }),
    /reuses compiled shard/u
  );
  assert.throws(
    () => tierUtils.compiledTestFilesForTier("integration", [
      "test/runtime-log.test.ts",
      "test/runtime-log.test.ts"
    ]),
    /duplicates/u
  );
  assert.throws(
    () => tierUtils.compiledTestFilesForTier("integration", [
      "test/protocol.test.ts"
    ]),
    /not an exact integration-tier manifest entry/u
  );
  assert.throws(
    () => tierUtils.compiledTestFilesForTier("full", [
      "test/runtime-log.test.ts"
    ]),
    /only for the integration tier/u
  );
  assert.deepEqual(tierUtils.parseProfileArguments([]), {
    tier: "full",
    output: undefined
  });
  assert.deepEqual(
    tierUtils.parseProfileArguments([
      "integration",
      "--output",
      "/tmp/akk-profile.json"
    ]),
    { tier: "integration", output: "/tmp/akk-profile.json" }
  );
  assert.throws(
    () => tierUtils.parseProfileArguments(["--output"]),
    /requires a path/u
  );
  assert.throws(
    () => tierUtils.parseProfileArguments(["unknown"]),
    /unknown profile tier/u
  );
});
