import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  compiledTestFilesForTier,
  configuredTestConcurrency,
  parseProfileArguments,
  repoRoot,
  testProcessEnvironment
} from "./test-tier-utils.js";

const options = parseProfileArguments(process.argv.slice(2));
const tier = options.tier;
const outputPath = options.output === undefined
  ? undefined
  : path.resolve(repoRoot, options.output);
const files = compiledTestFilesForTier(tier);
const concurrency = configuredTestConcurrency();
const commit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8"
}).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain"], {
  cwd: repoRoot,
  encoding: "utf8"
}).stdout.trim().length > 0;
const reporterPath = path.join(repoRoot, "scripts", "test-profile-reporter.js");
if (!fs.existsSync(reporterPath)) {
  throw new Error(`profile reporter is missing: ${reporterPath}`);
}
const args = [
  "--test",
  `--test-reporter=${reporterPath}`,
  `--test-concurrency=${concurrency}`
];
args.push(...files);

process.stdout.write(`Profiling AKK test tier ${tier}: ${files.length} files\n`);
const result = spawnSync(process.execPath, args, {
  cwd: repoRoot,
  env: testProcessEnvironment({
    AKK_TEST_PROFILE_TIER: tier,
    AKK_TEST_PROFILE_COMMIT: commit,
    AKK_TEST_PROFILE_DIRTY: dirty ? "1" : "0",
    AKK_TEST_CONCURRENCY: String(concurrency),
    ...(outputPath ? { AKK_TEST_PROFILE_OUTPUT: outputPath } : {})
  }),
  stdio: "inherit"
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
