#!/usr/bin/env node

import {
  loadAndValidateProductionModuleOwnership,
  validateProductionArchitecture
} from "./production-module-ownership.js";
import {
  loadAndValidateTestTiers,
  repoRoot
} from "./test-tier-utils.js";

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
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ownership_schema: ownership.schema,
    ownership_version: ownership.version,
    production_domains: Object.keys(ownership.domains).length,
    ...architecture
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `Architecture validation failed: ` +
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
