#!/usr/bin/env node

import {
  loadAndValidateRefactorEvidence
} from "./refactor-evidence.js";
import {
  loadAndValidateTestTiers,
  repoRoot
} from "./test-tier-utils.js";

try {
  const evidence = loadAndValidateRefactorEvidence({
    repoRoot,
    tiers: loadAndValidateTestTiers()
  });
  const subprocess = evidence.testEvidence.subprocess;
  const replay = evidence.testEvidence.affectedReplay;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    subprocess_startup_sites: {
      baseline: subprocess.baselineIncluded,
      current: subprocess.currentIncluded,
      reduction_basis_points: subprocess.reductionBasisPoints,
      target_maximum_percent: subprocess.targetMaximumPercent,
      final_threshold_required: subprocess.targetRequired,
      target_met: subprocess.targetMet
    },
    affected_selector_replay: {
      scenario_count: replay.scenario_count,
      full_count: replay.full_count,
      targeted_count: replay.targeted_count,
      full_rate_basis_points: replay.full_rate_basis_points,
      target_max_full_fallback_count: replay.targetMaxFullFallbackCount,
      final_threshold_required: replay.targetRequired,
      target_met: replay.targetMet
    },
    public_contracts: evidence.publicContracts
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `Refactor evidence validation failed: ` +
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
