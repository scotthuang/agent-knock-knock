import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function loadHealthModule() {
  return import(
    pathToFileURL(path.join(repoRoot, "scripts", "architecture-health.js")).href
  );
}

async function loadOwnershipModule() {
  return import(
    pathToFileURL(
      path.join(repoRoot, "scripts", "production-module-ownership.js")
    ).href
  );
}

async function loadEvidenceModule() {
  return import(
    pathToFileURL(path.join(repoRoot, "scripts", "refactor-evidence.js")).href
  );
}

function loadJson(repositoryPath: string): any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, repositoryPath), "utf8"));
}

let currentInputsPromise: Promise<{
  architecture: any;
  publicContracts: any;
}> | undefined;

async function loadCurrentInputs() {
  const ownershipModule = await loadOwnershipModule();
  const evidenceModule = await loadEvidenceModule();
  const tiers = loadJson("test/test-tiers.json");
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers
  });
  return {
    architecture: ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot
    }),
    publicContracts: evidenceModule.loadAndValidateRefactorEvidence({
      repoRoot,
      tiers
    }).publicContracts
  };
}

function currentInputs() {
  currentInputsPromise ??= loadCurrentInputs();
  return currentInputsPromise;
}

test("architecture health dashboard stays within the 0.13.3 refactor baseline", async () => {
  const healthModule = await loadHealthModule();
  const health = healthModule.validateArchitectureHealth({
    ...(await currentInputs()),
    repoRoot
  });

  assert.equal(health.current.import_cycles, 0);
  assert.equal(health.current.hard_function_violations, 0);
  assert.ok(health.current.default_function_violations <= 332);
  assert.ok(health.current.files_over_2000_physical_loc <= 9);
  assert.ok(health.current.maximum_production_file_physical_loc < 5_000);
  assert.equal(health.policy.total_production_loc, "observed_only");
  assert.equal(health.policy.default_function_violations_maximum, 332);
  assert.equal(health.policy.large_production_files_maximum, 9);
  assert.equal(health.policy.production_file_physical_loc_maximum, 4_999);
  assert.equal(health.hotspots.length, 8);
  assert.deepEqual(health.contract_sync.semantic_tools, {
    openclaw: 22,
    host_bridge: 22
  });
  assert.equal(health.contract_sync.canonical_skill_sha256.length, 64);
  assert.equal(
    health.contract_sync.replicas.every(
      (replica: { matches_canonical: boolean }) => replica.matches_canonical
    ),
    true
  );
});

test("package exposes the architecture dashboard through the validated gate", () => {
  const packageJson = loadJson("package.json");
  assert.equal(
    packageJson.scripts["architecture:dashboard"],
    "node scripts/validate-architecture.js"
  );
});

test("architecture health budgets cannot be raised above the checked-in baseline", async () => {
  const healthModule = await loadHealthModule();
  const manifest = loadJson("config/architecture-health-budget.json");
  assert.deepEqual(manifest.snapshot, {
    git_commit: "0667537ac6efe116c5261fa33370a4190f2d2226",
    package_version: "0.13.3",
    measured_on: "2026-09-15",
    observations: {
      production_modules: 155,
      production_physical_loc: 144_726,
      production_functions: 5_926,
      import_edges: 1_004,
      default_function_violations: 338,
      files_over_2000_physical_loc: 19
    }
  });

  const softened = structuredClone(manifest);
  softened.budgets.max_default_function_violations = 339;
  assert.throws(
    () => healthModule.validateArchitectureHealthBudgetManifest(softened),
    /maxDefaultFunctionViolations cannot exceed baseline 338/u
  );

  const moreLargeFiles = structuredClone(manifest);
  moreLargeFiles.budgets.max_large_production_files = 20;
  assert.throws(
    () => healthModule.validateArchitectureHealthBudgetManifest(moreLargeFiles),
    /maxLargeProductionFiles cannot exceed baseline 19/u
  );

  const oversizedProductionFile = structuredClone(manifest);
  oversizedProductionFile.budgets.max_production_file_physical_loc = 5_000;
  assert.throws(
    () => healthModule.validateArchitectureHealthBudgetManifest(
      oversizedProductionFile
    ),
    /maxProductionFilePhysicalLoc cannot exceed baseline 4999/u
  );

  const grownHotspot = structuredClone(manifest);
  grownHotspot.budgets.hotspot_max_physical_loc[
    "src/terminal-command-cli-adapter.ts"
  ] = 10_422;
  assert.throws(
    () => healthModule.validateArchitectureHealthBudgetManifest(grownHotspot),
    /terminal-command-cli-adapter\.ts cannot exceed baseline 10421/u
  );
});

test("architecture health rejects complexity, hotspot, tool, and skill drift", async () => {
  const healthModule = await loadHealthModule();
  const inputs = await currentInputs();
  const defaultViolation =
    inputs.architecture.productionFunctionDefaultViolations[0];
  const defaultViolationBudget = loadJson(
    "config/architecture-health-budget.json"
  ).budgets.max_default_function_violations;
  const addedDefaultViolations = Array.from(
    {
      length: defaultViolationBudget -
        inputs.architecture.productionFunctionDefaultViolations.length + 1
    },
    () => defaultViolation
  );

  assert.throws(
    () => healthModule.validateArchitectureHealth({
      ...inputs,
      architecture: {
        ...inputs.architecture,
        productionFunctionDefaultViolations: [
          ...inputs.architecture.productionFunctionDefaultViolations,
          ...addedDefaultViolations
        ]
      },
      repoRoot
    }),
    new RegExp(
      `production default function violations ${defaultViolationBudget + 1} ` +
      `exceed budget ${defaultViolationBudget}`,
      "u"
    )
  );

  const realRead = (repositoryPath: string) =>
    fs.readFileSync(path.join(repoRoot, repositoryPath), "utf8");
  assert.throws(
    () => healthModule.validateArchitectureHealth({
      ...inputs,
      repoRoot,
      readRepositoryFile(repositoryPath: string) {
        const source = realRead(repositoryPath);
        if (repositoryPath !== "src/terminal-command-cli-adapter.ts") {
          return source;
        }
        const currentPhysicalLoc = source.split(/\r?\n/u).at(-1) === ""
          ? source.split(/\r?\n/u).length - 1
          : source.split(/\r?\n/u).length;
        return source + "// hotspot growth\n".repeat(1_916 - currentPhysicalLoc);
      }
    }),
    /terminal-command-cli-adapter\.ts has 1916 LOC; budget is 1915/u
  );

  assert.throws(
    () => healthModule.validateArchitectureHealth({
      ...inputs,
      publicContracts: {
        ...inputs.publicContracts,
        hostBridgeToolCount: 21
      },
      repoRoot
    }),
    /Host Bridge tool count 21 does not match OpenClaw tool count 22/u
  );

  assert.throws(
    () => healthModule.validateArchitectureHealth({
      ...inputs,
      repoRoot,
      readRepositoryFile(repositoryPath: string) {
        const source = realRead(repositoryPath);
        return repositoryPath ===
          "connectors/pi/skills/agent-knock-knock/SKILL.md"
          ? `${source}\nreplica drift\n`
          : source;
      }
    }),
    /bundled skill connectors\/pi\/skills\/agent-knock-knock\/SKILL\.md does not match/u
  );
});

test("architecture health rejects any production file at 5000 physical LOC", async () => {
  const healthModule = await loadHealthModule();
  const inputs = await currentInputs();
  const oversizedPath = "src/semantic-tool-runtime.ts";
  const realRead = (repositoryPath: string) =>
    fs.readFileSync(path.join(repoRoot, repositoryPath), "utf8");

  assert.throws(
    () => healthModule.validateArchitectureHealth({
      ...inputs,
      repoRoot,
      readRepositoryFile(repositoryPath: string) {
        const source = realRead(repositoryPath);
        if (repositoryPath !== oversizedPath) return source;
        const currentPhysicalLoc = source.split(/\r?\n/u).at(-1) === ""
          ? source.split(/\r?\n/u).length - 1
          : source.split(/\r?\n/u).length;
        return source + "// global production-file growth\n".repeat(
          5_000 - currentPhysicalLoc
        );
      }
    }),
    /largest production file src\/semantic-tool-runtime\.ts has 5000 LOC; budget is 4999/u
  );
});

test("total production LOC is observed without becoming a feature-growth gate", async () => {
  const healthModule = await loadHealthModule();
  const inputs = await currentInputs();
  const health = healthModule.validateArchitectureHealth({
    ...inputs,
    architecture: {
      ...inputs.architecture,
      productionPhysicalLoc: inputs.architecture.productionPhysicalLoc + 50_000
    },
    repoRoot
  });

  assert.equal(health.policy.total_production_loc, "observed_only");
  assert.equal(
    health.current.production_physical_loc,
    inputs.architecture.productionPhysicalLoc + 50_000
  );
});

test("a removed hotspot is retired without deleting its historical ceiling", async () => {
  const healthModule = await loadHealthModule();
  const ownershipModule = await loadOwnershipModule();
  const inputs = await currentInputs();
  const retiredPath = "src/terminal-command-cli-adapter.ts";
  const health = healthModule.validateArchitectureHealth({
    ...inputs,
    repoRoot,
    productionPaths: ownershipModule
      .discoverProductionModulePaths(repoRoot)
      .filter((repositoryPath: string) => repositoryPath !== retiredPath)
  });
  const retired = health.hotspots.find(
    (hotspot: { path: string }) => hotspot.path === retiredPath
  );

  assert.deepEqual(retired, {
    path: retiredPath,
    physical_loc: 0,
    maximum_physical_loc: 1_915,
    retired: true
  });
});
