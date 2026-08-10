import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  affectedTestRuns,
  determineAffectedSelection,
  parseAffectedArguments
} from "./affected-test-selection.js";
import {
  loadAndValidateTestTiers,
  repoRoot,
  testProcessEnvironment
} from "./test-tier-utils.js";

const options = parseAffectedArguments(process.argv.slice(2));
let selection;
try {
  const tiers = loadAndValidateTestTiers();
  selection = determineAffectedSelection({ tiers, repoRoot, base: options.base });
} catch (error) {
  selection = {
    mode: "full",
    reason: `affected-test selection failed: ${error instanceof Error ? error.message : String(error)}`
  };
}

function runTier(tier, files = []) {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "run-test-tier.js"), tier, ...files],
    {
      cwd: repoRoot,
      env: testProcessEnvironment(),
      stdio: "inherit"
    }
  );
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (selection.mode === "full") {
  process.stdout.write(`AKK affected tests: full suite (${selection.reason})\n`);
} else {
  process.stdout.write(
    `AKK affected tests: ${selection.changedPaths.length} changed path(s), ` +
    `${selection.integrationFiles.length} targeted integration file(s)\n`
  );
}

for (const run of affectedTestRuns(selection)) {
  const status = runTier(run.tier, run.files);
  if (status !== 0) {
    process.exitCode = status;
    break;
  }
}
