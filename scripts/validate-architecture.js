#!/usr/bin/env node

import {
  loadAndValidateProductionModuleOwnership,
  validateProductionArchitecture
} from "./production-module-ownership.js";
import {
  loadAndValidateTestTiers,
  repoRoot
} from "./test-tier-utils.js";
import {
  loadAndValidateRefactorEvidence
} from "./refactor-evidence.js";

try {
  const tiers = loadAndValidateTestTiers();
  const ownership = loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers
  });
  const architecture = validateProductionArchitecture({
    ownership,
    repoRoot
  });
  const evidence = loadAndValidateRefactorEvidence({ repoRoot, tiers });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ownership_schema: ownership.schema,
    ownership_version: ownership.version,
    production_domains: Object.keys(ownership.domains).length,
    ...architecture,
    refactor_evidence: {
      subprocess_current_sites:
        evidence.testEvidence.subprocess.currentIncluded,
      affected_replay_full_count:
        evidence.testEvidence.affectedReplay.full_count,
      public_contract_witnesses: evidence.publicContracts.witnessCount
    }
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `Architecture validation failed: ` +
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
