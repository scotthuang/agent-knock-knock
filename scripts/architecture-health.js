import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverProductionModulePaths,
  physicalLineCount
} from "./production-module-ownership.js";

export const ARCHITECTURE_HEALTH_SCHEMA =
  "agent-knock-knock/architecture-health-budget";
export const ARCHITECTURE_HEALTH_VERSION = 1;
export const ARCHITECTURE_HEALTH_BUDGET_PATH =
  "config/architecture-health-budget.json";
export const ARCHITECTURE_HEALTH_BASELINE_LIMITS = Object.freeze({
  maxImportCycles: 0,
  maxHardFunctionViolations: 0,
  maxDefaultFunctionViolations: 338,
  largeFileThresholdPhysicalLoc: 2_000,
  maxLargeProductionFiles: 19,
  hotspotMaxPhysicalLoc: Object.freeze({
    "src/claude-local-transcript-provider.ts": 3_534,
    "src/openclaw-plugin-command-adapter.ts": 3_817,
    "src/terminal-agent-bridge.ts": 7_409,
    "src/terminal-command-cli-adapter.ts": 10_421,
    "src/terminal-list-cli-adapter.ts": 5_093,
    "src/terminal-monitor-state-cli-adapter.ts": 3_478,
    "src/terminal-watch-cli-adapter.ts": 3_683,
    "src/terminal-watch-store.ts": 3_191
  })
});
export const ARCHITECTURE_HEALTH_CANONICAL_SKILL =
  "templates/openclaw-skills/agent-knock-knock/SKILL.md";
export const ARCHITECTURE_HEALTH_SKILL_REPLICAS = Object.freeze([
  "connectors/deepseek-harness/skills/agent-knock-knock/SKILL.md",
  "connectors/pi/skills/agent-knock-knock/SKILL.md"
]);
const defaultRepoRoot = fileURLToPath(new URL("../", import.meta.url));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record, expectedKeys, label) {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `${label} must contain exactly: ${expected.join(", ")}`
    );
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function exactString(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} must remain ${JSON.stringify(expected)}`);
  }
  return value;
}

function exactArray(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `${label} must equal ${JSON.stringify(expected)}`
    );
  }
  return actual;
}

function normalizedRepositoryPath(repositoryPath, label) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    repositoryPath.includes("\\") ||
    path.posix.normalize(repositoryPath) !== repositoryPath ||
    repositoryPath.startsWith("../") ||
    path.posix.isAbsolute(repositoryPath)
  ) {
    throw new Error(`${label} must be a normalized repository path`);
  }
  return repositoryPath;
}

function validateSnapshot(snapshot) {
  if (!isRecord(snapshot)) {
    throw new Error("architecture health snapshot must be an object");
  }
  exactKeys(
    snapshot,
    ["git_commit", "measured_on", "observations", "package_version"],
    "architecture health snapshot"
  );
  if (
    typeof snapshot.git_commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(snapshot.git_commit)
  ) {
    throw new Error("architecture health snapshot git_commit must be a full SHA");
  }
  if (
    typeof snapshot.package_version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(snapshot.package_version)
  ) {
    throw new Error("architecture health snapshot package_version is invalid");
  }
  if (
    typeof snapshot.measured_on !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(snapshot.measured_on)
  ) {
    throw new Error("architecture health snapshot measured_on must be YYYY-MM-DD");
  }
  if (!isRecord(snapshot.observations)) {
    throw new Error("architecture health snapshot observations must be an object");
  }
  exactKeys(
    snapshot.observations,
    [
      "default_function_violations",
      "files_over_2000_physical_loc",
      "import_edges",
      "production_functions",
      "production_modules",
      "production_physical_loc"
    ],
    "architecture health snapshot observations"
  );
  for (const [key, value] of Object.entries(snapshot.observations)) {
    nonNegativeInteger(value, `architecture health observation ${key}`);
  }
  return Object.freeze({
    gitCommit: snapshot.git_commit,
    packageVersion: snapshot.package_version,
    measuredOn: snapshot.measured_on,
    observations: Object.freeze({ ...snapshot.observations })
  });
}

function validateBudgets(budgets) {
  if (!isRecord(budgets)) {
    throw new Error("architecture health budgets must be an object");
  }
  exactKeys(
    budgets,
    [
      "hotspot_max_physical_loc",
      "large_file_threshold_physical_loc",
      "max_default_function_violations",
      "max_hard_function_violations",
      "max_import_cycles",
      "max_large_production_files"
    ],
    "architecture health budgets"
  );
  const normalized = {
    maxImportCycles: nonNegativeInteger(
      budgets.max_import_cycles,
      "architecture health max_import_cycles"
    ),
    maxHardFunctionViolations: nonNegativeInteger(
      budgets.max_hard_function_violations,
      "architecture health max_hard_function_violations"
    ),
    maxDefaultFunctionViolations: nonNegativeInteger(
      budgets.max_default_function_violations,
      "architecture health max_default_function_violations"
    ),
    largeFileThresholdPhysicalLoc: positiveInteger(
      budgets.large_file_threshold_physical_loc,
      "architecture health large_file_threshold_physical_loc"
    ),
    maxLargeProductionFiles: nonNegativeInteger(
      budgets.max_large_production_files,
      "architecture health max_large_production_files"
    )
  };
  for (const [key, ceiling] of Object.entries(
    ARCHITECTURE_HEALTH_BASELINE_LIMITS
  )) {
    if (key === "hotspotMaxPhysicalLoc") continue;
    if (normalized[key] > ceiling) {
      throw new Error(
        `architecture health ${key} cannot exceed baseline ${ceiling}`
      );
    }
  }
  if (
    normalized.largeFileThresholdPhysicalLoc !==
      ARCHITECTURE_HEALTH_BASELINE_LIMITS.largeFileThresholdPhysicalLoc
  ) {
    throw new Error(
      "architecture health large file threshold must remain 2000 physical LOC"
    );
  }
  if (!isRecord(budgets.hotspot_max_physical_loc)) {
    throw new Error("architecture health hotspot budget must be an object");
  }
  exactKeys(
    budgets.hotspot_max_physical_loc,
    Object.keys(ARCHITECTURE_HEALTH_BASELINE_LIMITS.hotspotMaxPhysicalLoc),
    "architecture health hotspot budget"
  );
  const hotspotMaxPhysicalLoc = {};
  for (const [repositoryPath, ceiling] of Object.entries(
    ARCHITECTURE_HEALTH_BASELINE_LIMITS.hotspotMaxPhysicalLoc
  )) {
    const configured = positiveInteger(
      budgets.hotspot_max_physical_loc[repositoryPath],
      `architecture health hotspot ${repositoryPath}`
    );
    if (configured > ceiling) {
      throw new Error(
        `architecture health hotspot ${repositoryPath} cannot exceed baseline ${ceiling}`
      );
    }
    hotspotMaxPhysicalLoc[repositoryPath] = configured;
  }
  return Object.freeze({
    ...normalized,
    hotspotMaxPhysicalLoc: Object.freeze(hotspotMaxPhysicalLoc)
  });
}

function validateContractSync(contractSync) {
  if (!isRecord(contractSync)) {
    throw new Error("architecture health contract_sync must be an object");
  }
  exactKeys(
    contractSync,
    ["canonical_skill", "skill_replicas"],
    "architecture health contract_sync"
  );
  exactString(
    contractSync.canonical_skill,
    ARCHITECTURE_HEALTH_CANONICAL_SKILL,
    "architecture health canonical_skill"
  );
  exactArray(
    contractSync.skill_replicas,
    ARCHITECTURE_HEALTH_SKILL_REPLICAS,
    "architecture health skill_replicas"
  );
  return Object.freeze({
    canonicalSkill: contractSync.canonical_skill,
    skillReplicas: Object.freeze([...contractSync.skill_replicas])
  });
}

export function validateArchitectureHealthBudgetManifest(manifest) {
  if (!isRecord(manifest)) {
    throw new Error("architecture health budget must be a JSON object");
  }
  exactKeys(
    manifest,
    ["budgets", "contract_sync", "schema", "snapshot", "version"],
    "architecture health budget"
  );
  exactString(
    manifest.schema,
    ARCHITECTURE_HEALTH_SCHEMA,
    "architecture health schema"
  );
  if (manifest.version !== ARCHITECTURE_HEALTH_VERSION) {
    throw new Error(
      `architecture health version must be ${ARCHITECTURE_HEALTH_VERSION}`
    );
  }
  return Object.freeze({
    schema: manifest.schema,
    version: manifest.version,
    snapshot: validateSnapshot(manifest.snapshot),
    budgets: validateBudgets(manifest.budgets),
    contractSync: validateContractSync(manifest.contract_sync)
  });
}

export function readArchitectureHealthBudget({
  repoRoot = defaultRepoRoot,
  manifestPath = path.join(repoRoot, ARCHITECTURE_HEALTH_BUDGET_PATH)
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read architecture health budget ${manifestPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateArchitectureHealthBudgetManifest(manifest);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function architectureHealthErrors({
  architecture,
  budget,
  publicContracts,
  filePhysicalLoc,
  readRepositoryFile
}) {
  const errors = [];
  const softViolations = architecture.productionFunctionDefaultViolations.length;
  const largeFiles = [...filePhysicalLoc]
    .filter(([, physicalLoc]) =>
      physicalLoc > budget.budgets.largeFileThresholdPhysicalLoc
    )
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (architecture.importCycles > budget.budgets.maxImportCycles) {
    errors.push(
      `production import cycles ${architecture.importCycles} exceed budget ` +
      budget.budgets.maxImportCycles
    );
  }
  if (
    architecture.productionFunctionHardViolations >
      budget.budgets.maxHardFunctionViolations
  ) {
    errors.push(
      `production hard function violations ` +
      `${architecture.productionFunctionHardViolations} exceed budget ` +
      budget.budgets.maxHardFunctionViolations
    );
  }
  if (softViolations > budget.budgets.maxDefaultFunctionViolations) {
    errors.push(
      `production default function violations ${softViolations} exceed budget ` +
      budget.budgets.maxDefaultFunctionViolations
    );
  }
  if (largeFiles.length > budget.budgets.maxLargeProductionFiles) {
    errors.push(
      `production files over ${budget.budgets.largeFileThresholdPhysicalLoc} LOC ` +
      `${largeFiles.length} exceed budget ${budget.budgets.maxLargeProductionFiles}`
    );
  }
  const hotspotResults = [];
  for (const [repositoryPath, maximum] of Object.entries(
    budget.budgets.hotspotMaxPhysicalLoc
  )) {
    const current = filePhysicalLoc.get(repositoryPath);
    hotspotResults.push(Object.freeze({
      path: repositoryPath,
      physical_loc: current ?? 0,
      maximum_physical_loc: maximum,
      retired: current === undefined
    }));
    if (current !== undefined && current > maximum) {
      errors.push(
        `architecture hotspot ${repositoryPath} has ${current} LOC; ` +
        `budget is ${maximum}`
      );
    }
  }
  const hostBridgeToolCount = publicContracts.hostBridgeToolCount;
  const openClawToolCount = publicContracts.openclawToolCount;
  if (hostBridgeToolCount !== openClawToolCount) {
    errors.push(
      `Host Bridge tool count ${hostBridgeToolCount} does not match ` +
      `OpenClaw tool count ${openClawToolCount}`
    );
  }
  const canonicalSkill = readRepositoryFile(budget.contractSync.canonicalSkill);
  const canonicalSkillSha256 = sha256(canonicalSkill);
  const skillReplicas = [];
  for (const repositoryPath of budget.contractSync.skillReplicas) {
    const replica = readRepositoryFile(repositoryPath);
    const replicaSha256 = sha256(replica);
    skillReplicas.push(Object.freeze({
      path: repositoryPath,
      sha256: replicaSha256,
      matches_canonical: replica === canonicalSkill
    }));
    if (replica !== canonicalSkill) {
      errors.push(
        `bundled skill ${repositoryPath} does not match ` +
        budget.contractSync.canonicalSkill
      );
    }
  }
  return {
    errors,
    largeFiles,
    hotspotResults,
    softViolations,
    hostBridgeToolCount,
    openClawToolCount,
    canonicalSkillSha256,
    skillReplicas
  };
}

export function validateArchitectureHealth({
  architecture,
  publicContracts,
  repoRoot = defaultRepoRoot,
  budget = readArchitectureHealthBudget({ repoRoot }),
  productionPaths = discoverProductionModulePaths(repoRoot),
  readRepositoryFile = (repositoryPath) =>
    fs.readFileSync(path.join(repoRoot, repositoryPath), "utf8")
}) {
  if (!architecture || !publicContracts) {
    throw new Error(
      "validated architecture and public contracts are required for health checks"
    );
  }
  const filePhysicalLoc = new Map(
    productionPaths.map((repositoryPath) => [
      repositoryPath,
      physicalLineCount(readRepositoryFile(repositoryPath))
    ])
  );
  const result = architectureHealthErrors({
    architecture,
    budget,
    publicContracts,
    filePhysicalLoc,
    readRepositoryFile
  });
  if (result.errors.length > 0) {
    throw new Error(
      `architecture health budget failed: ${result.errors.join("; ")}`
    );
  }
  const baseline = budget.snapshot.observations;
  return Object.freeze({
    schema: budget.schema,
    version: budget.version,
    snapshot: Object.freeze({
      git_commit: budget.snapshot.gitCommit,
      package_version: budget.snapshot.packageVersion,
      measured_on: budget.snapshot.measuredOn
    }),
    current: Object.freeze({
      production_modules: architecture.productionModules,
      production_physical_loc: architecture.productionPhysicalLoc,
      production_functions: architecture.productionFunctions,
      import_edges: architecture.importEdges,
      import_cycles: architecture.importCycles,
      hard_function_violations: architecture.productionFunctionHardViolations,
      default_function_violations: result.softViolations,
      files_over_2000_physical_loc: result.largeFiles.length
    }),
    baseline_delta: Object.freeze({
      production_modules:
        architecture.productionModules - baseline.production_modules,
      production_physical_loc:
        architecture.productionPhysicalLoc - baseline.production_physical_loc,
      production_functions:
        architecture.productionFunctions - baseline.production_functions,
      import_edges: architecture.importEdges - baseline.import_edges,
      default_function_violations:
        result.softViolations - baseline.default_function_violations,
      files_over_2000_physical_loc:
        result.largeFiles.length - baseline.files_over_2000_physical_loc
    }),
    policy: Object.freeze({
      total_production_loc: "observed_only",
      import_cycles_maximum: budget.budgets.maxImportCycles,
      hard_function_violations_maximum:
        budget.budgets.maxHardFunctionViolations,
      default_function_violations_maximum:
        budget.budgets.maxDefaultFunctionViolations,
      large_file_threshold_physical_loc:
        budget.budgets.largeFileThresholdPhysicalLoc,
      large_production_files_maximum:
        budget.budgets.maxLargeProductionFiles
    }),
    hotspots: Object.freeze(result.hotspotResults),
    largest_production_files: Object.freeze(
      result.largeFiles.map(([repositoryPath, physicalLoc]) => Object.freeze({
        path: repositoryPath,
        physical_loc: physicalLoc
      }))
    ),
    contract_sync: Object.freeze({
      semantic_tools: Object.freeze({
        openclaw: result.openClawToolCount,
        host_bridge: result.hostBridgeToolCount
      }),
      canonical_skill: budget.contractSync.canonicalSkill,
      canonical_skill_sha256: result.canonicalSkillSha256,
      replicas: Object.freeze(result.skillReplicas)
    })
  });
}
