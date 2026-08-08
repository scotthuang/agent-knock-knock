import { spawnSync } from "node:child_process";
import {
  compiledTestFilesForTier,
  configuredTestConcurrency,
  repoRoot,
  testProcessEnvironment
} from "./test-tier-utils.js";

const tier = process.argv[2];
const requestedSourcePaths = process.argv.slice(3);
const files = compiledTestFilesForTier(tier, requestedSourcePaths);
const concurrency = configuredTestConcurrency();
const args = ["--test", `--test-concurrency=${concurrency}`];
if (process.env.AKK_TEST_REPORTER) {
  args.push(`--test-reporter=${process.env.AKK_TEST_REPORTER}`);
}
args.push(...files);

process.stdout.write(
  `AKK test tier ${tier}${requestedSourcePaths.length > 0 ? " (targeted)" : ""}: ` +
  `${files.length} files, concurrency=${concurrency}\n`
);
const result = spawnSync(process.execPath, args, {
  cwd: repoRoot,
  env: testProcessEnvironment(),
  stdio: "inherit"
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
