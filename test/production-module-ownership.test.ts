import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = path.join(
  repoRoot,
  "config",
  "production-module-ownership.json"
);

async function loadOwnershipModule() {
  return import(
    pathToFileURL(
      path.join(repoRoot, "scripts", "production-module-ownership.js")
    ).href
  );
}

function loadManifest(): any {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function loadTiers(): { fast: string[]; integration: string[] } {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, "test", "test-tiers.json"), "utf8")
  );
}

test("production ownership covers every source module and preserves architecture ratchets", async () => {
  const ownershipModule = await loadOwnershipModule();
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers: loadTiers()
  });
  const discovered = ownershipModule.discoverProductionModulePaths(repoRoot);
  assert.equal(Object.keys(ownership.modules).length, discovered.length);
  assert.deepEqual(Object.keys(ownership.modules).sort(), discovered);
  for (const mandatoryPath of ownershipModule.MANDATORY_FULL_PRODUCTION_PATHS) {
    assert.equal(ownership.modules[mandatoryPath]?.selection, "full", mandatoryPath);
  }
  assert.equal(ownershipModule.MAX_TARGETED_INTEGRATION_TESTS, 5);
  assert.equal(ownershipModule.CLI_CORE_HARD_MAX_PHYSICAL_LOC, 8_000);
  for (const [domainName, domain] of Object.entries(ownership.domains) as Array<[
    string,
    { selection: string; integrationTests: readonly string[] }
  ]>) {
    if (domain.selection === "targeted") {
      assert.ok(
        domain.integrationTests.length <= ownershipModule.MAX_TARGETED_INTEGRATION_TESTS,
        `${domainName} must keep at most five integration witnesses`
      );
    }
  }

  const architecture = ownershipModule.validateProductionArchitecture({
    ownership,
    repoRoot
  });
  assert.equal(architecture.productionModules, discovered.length);
  assert.ok(architecture.importEdges > 0);
  assert.equal(architecture.importCycles, 0);
  assert.ok(architecture.productionFunctions > 0);
  assert.deepEqual(architecture.productionFunctionHardLimits, {
    physicalLocExclusive: 500,
    approximateComplexityExclusive: 50
  });
  assert.equal(architecture.productionFunctionHardViolations, 0);
  assert.equal(architecture.canonicalStatusPolicies, 6);
  assert.equal(architecture.cliCoreHardMaxPhysicalLoc, 8_000);
  assert.deepEqual(architecture.productionFunctionDefaultLimits, {
    physicalLocExclusive: 100,
    approximateComplexityExclusive: 20
  });
  assert.ok(architecture.productionFunctionDefaultViolations.length > 0);
  assert.equal(
    architecture.cliCorePhysicalLoc,
    loadManifest().architecture.cli_core_max_physical_loc
  );
  assert.equal(
    architecture.productionPhysicalLoc,
    loadManifest().architecture.production_physical_loc
  );
  assert.deepEqual(architecture.cliCoreImporters, ["src/cli.ts"]);
  assert.equal(
    ownershipModule.DYNAMIC_IMPORT_POLICY,
    "literal-only-fail-closed"
  );
});

test("compiler AST enforces production function hard limits without exceptions", async () => {
  const ownershipModule = await loadOwnershipModule();
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers: loadTiers()
  });
  const originalSource = (modulePath: string) =>
    fs.readFileSync(path.join(repoRoot, modulePath), "utf8");
  const tooComplex = [
    "export function deliberatelyTooComplex(value: boolean) {",
    ...Array.from(
      { length: 49 },
      (_, index) => `  if (value) value = ${index % 2 === 0 ? "false" : "true"};`
    ),
    "  return value;",
    "}"
  ];
  const tooLong = [
    "export function deliberatelyTooLong() {",
    ...Array.from({ length: 498 }, () => "  void 0;"),
    "}"
  ];
  assert.throws(
    () => ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource(modulePath: string) {
        return modulePath === "src/runtime-log.ts"
          ? `${[...tooComplex, ...tooLong].join("\n")}\n`
          : originalSource(modulePath);
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /deliberatelyTooComplex spans 52 LOC with approximate complexity 50/u
      );
      assert.match(
        error.message,
        /deliberatelyTooLong spans 500 LOC with approximate complexity 1/u
      );
      return true;
    }
  );
});

test("cli-core hard maximum rejects coordinated source and ratchet tampering", async () => {
  const ownershipModule = await loadOwnershipModule();
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers: loadTiers()
  });
  const source = (modulePath: string) =>
    fs.readFileSync(path.join(repoRoot, modulePath), "utf8");
  const originalCore = source("src/cli-core.ts");
  const currentLoc = ownershipModule.physicalLineCount(originalCore);
  const tamperedLoc = ownershipModule.CLI_CORE_HARD_MAX_PHYSICAL_LOC + 1;
  const addedLoc = tamperedLoc - currentLoc;
  assert.ok(addedLoc > 0);
  const tamperedCore = originalCore +
    "// coordinated cli-core growth\n".repeat(addedLoc);
  assert.equal(ownershipModule.physicalLineCount(tamperedCore), tamperedLoc);
  const tamperedOwnership = {
    ...ownership,
    architecture: Object.freeze({
      ...ownership.architecture,
      cliCoreMaxPhysicalLoc: tamperedLoc,
      productionPhysicalLoc:
        ownership.architecture.productionPhysicalLoc + addedLoc
    })
  };

  assert.throws(
    () => ownershipModule.validateProductionArchitecture({
      ownership: tamperedOwnership,
      repoRoot,
      readSource(modulePath: string) {
        return modulePath === "src/cli-core.ts"
          ? tamperedCore
          : source(modulePath);
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /src\/cli-core\.ts physical LOC exceeds hard maximum 8000 \(actual 8001\)/u
      );
      assert.doesNotMatch(error.message, /does not match manifest ratchet/u);
      return true;
    }
  );
});

test("canonical status policies reject duplicate definitions and inline tables", async () => {
  const ownershipModule = await loadOwnershipModule();
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers: loadTiers()
  });
  const source = (modulePath: string) =>
    fs.readFileSync(path.join(repoRoot, modulePath), "utf8");
  const target = "src/runtime-log.ts";
  const original = source(target);
  const duplicate = [
    "function isSessionSendBlockingStatus(_status) { return false; }",
    "const DUPLICATE_FINAL_DEFERRED = [\"resolved\", \"abort_resolved\"];"
  ].join("\n") + "\n";
  const tampered = original + duplicate;
  const addedLoc = ownershipModule.physicalLineCount(tampered) -
    ownershipModule.physicalLineCount(original);
  const tamperedOwnership = {
    ...ownership,
    architecture: Object.freeze({
      ...ownership.architecture,
      productionPhysicalLoc:
        ownership.architecture.productionPhysicalLoc + addedLoc
    })
  };

  assert.throws(
    () => ownershipModule.validateProductionArchitecture({
      ownership: tamperedOwnership,
      repoRoot,
      readSource(modulePath: string) {
        return modulePath === target ? tampered : source(modulePath);
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /canonical status policy isSessionSendBlockingStatus must be defined exactly once/u
      );
      assert.match(
        error.message,
        /canonical status table deferred_foreground_final must occur exactly once/u
      );
      assert.doesNotMatch(error.message, /production physical LOC does not match/u);
      return true;
    }
  );
});

test("production ownership rejects missing, duplicate, unknown, and stale entries", async () => {
  const ownershipModule = await loadOwnershipModule();
  const productionPaths = ownershipModule.discoverProductionModulePaths(repoRoot);
  const integrationTests = loadTiers().integration;
  const validate = (manifest: any) =>
    ownershipModule.validateProductionModuleOwnershipManifest({
      manifest,
      productionPaths,
      integrationTests
    });

  const missing = loadManifest();
  missing.modules = missing.modules.slice(1);
  assert.throws(() => validate(missing), /production modules without owners/u);

  const duplicate = loadManifest();
  duplicate.modules.push({ ...duplicate.modules[0] });
  assert.throws(() => validate(duplicate), /declared more than once/u);

  const unknownOwner = loadManifest();
  unknownOwner.modules[0].owner = "missing-domain";
  assert.throws(() => validate(unknownOwner), /unknown owner/u);

  const staleTest = loadManifest();
  staleTest.domains["runtime-log"].integration_tests = ["test/protocol.test.ts"];
  assert.throws(() => validate(staleTest), /is not in the integration tier/u);

  const weakenedCore = loadManifest();
  weakenedCore.domains["store-protocol"] = {
    selection: "targeted",
    integration_tests: ["test/store.test.ts"]
  };
  assert.throws(() => validate(weakenedCore), /mandatory shared core module/u);

  const overbroadTarget = loadManifest();
  overbroadTarget.domains["cli-runtime"].integration_tests =
    integrationTests.slice(0, 6);
  assert.throws(
    () => validate(overbroadTarget),
    /declares 6 integration tests; maximum is 5/u
  );

  const raisedCliCoreCeiling = loadManifest();
  raisedCliCoreCeiling.architecture.cli_core_max_physical_loc = 8_001;
  assert.throws(
    () => validate(raisedCliCoreCeiling),
    /cli_core_max_physical_loc must not exceed hard maximum 8000/u
  );

  const missingCore = loadManifest();
  missingCore.modules = missingCore.modules.filter(
    (entry: { path: string }) => entry.path !== "src/protocol.ts"
  );
  assert.throws(
    () => ownershipModule.validateProductionModuleOwnershipManifest({
      manifest: missingCore,
      productionPaths: productionPaths.filter(
        (modulePath: string) => modulePath !== "src/protocol.ts"
      ),
      integrationTests
    }),
    /required production module is missing from disk: src\/protocol\.ts/u
  );

  const cycleEscapeHatch = loadManifest();
  cycleEscapeHatch.architecture.allow_import_cycles = [];
  assert.throws(() => validate(cycleEscapeHatch), /unexpected keys: allow_import_cycles/u);
});

test("architecture checks reject production LOC drift and unapproved reverse imports", async () => {
  const ownershipModule = await loadOwnershipModule();
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers: loadTiers()
  });
  const source = (modulePath: string) =>
    fs.readFileSync(path.join(repoRoot, modulePath), "utf8");
  const ratchet = loadManifest().architecture.cli_core_max_physical_loc;
  const productionRatchet = loadManifest().architecture.production_physical_loc;

  assert.throws(
    () => ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource(modulePath: string) {
        const original = source(modulePath);
        return modulePath === "src/cli-core.ts"
          ? `${original}// unapproved growth\n`
          : original;
      }
    }),
    new RegExp(`manifest ratchet ${ratchet} \\(actual ${ratchet + 1}\\)`, "u")
  );

  assert.throws(
    () => ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource(modulePath: string) {
        const original = source(modulePath);
        if (modulePath !== "src/cli-core.ts") {
          return original;
        }
        const lines = original.split(/\r?\n/u);
        if (lines.at(-1) === "") {
          lines.pop();
        }
        lines.pop();
        return `${lines.join("\n")}\n`;
      }
    }),
    new RegExp(`manifest ratchet ${ratchet} \\(actual ${ratchet - 1}\\)`, "u")
  );

  assert.throws(
    () => ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource(modulePath: string) {
        const original = source(modulePath);
        return modulePath === "src/runtime-log.ts"
          ? `${original}// unapproved production growth\n`
          : original;
      }
    }),
    new RegExp(
      `production physical LOC does not match manifest ratchet ` +
      `${productionRatchet} \\(actual ${productionRatchet + 1}\\)`,
      "u"
    )
  );

  assert.throws(
    () => ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource(modulePath: string) {
        const original = source(modulePath);
        if (modulePath !== "src/runtime-log.ts") {
          return original;
        }
        const lines = original.split(/\r?\n/u);
        if (lines.at(-1) === "") {
          lines.pop();
        }
        lines.pop();
        return `${lines.join("\n")}\n`;
      }
    }),
    new RegExp(
      `production physical LOC does not match manifest ratchet ` +
      `${productionRatchet} \\(actual ${productionRatchet - 1}\\)`,
      "u"
    )
  );

  assert.throws(
    () => ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource(modulePath: string) {
        return modulePath === "src/runtime-log.ts"
          ? 'import "./cli-core.js";\n'
          : source(modulePath);
      }
    }),
    /unapproved cli-core importers: src\/runtime-log\.ts/u
  );

  assert.doesNotThrow(
    () => ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource(modulePath: string) {
        const original = source(modulePath);
        if (modulePath !== "src/runtime-log.ts") {
          return original;
        }
        const lines = original.split(/\r?\n/u);
        lines[0] = 'const embedded = `import "./cli-core.js";`;';
        return lines.join("\n");
      }
    }),
    "import-like fixture text must not create an architecture edge"
  );
});

test("every production import cycle fails with no manifest escape hatch", async () => {
  const ownershipModule = await loadOwnershipModule();
  const manifest = loadManifest();
  const productionPaths = ownershipModule.discoverProductionModulePaths(repoRoot);
  const integrationTests = loadTiers().integration;
  const readSource = (modulePath: string) => {
    if (modulePath === "src/runtime-log.ts") {
      return 'export async function load() { return import("./transcript.js"); }\n';
    }
    if (modulePath === "src/transcript.ts") {
      return 'import "./runtime-log.js";\n';
    }
    return fs.readFileSync(path.join(repoRoot, modulePath), "utf8");
  };
  const ownership = ownershipModule.validateProductionModuleOwnershipManifest({
    manifest,
    productionPaths,
    integrationTests
  });
  assert.throws(
    () => ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource
    }),
    /production import graph contains cycles/u
  );
});

test("compiler AST finds semicolonless exports, regex-adjacent exports, and import-equals", async () => {
  const ownershipModule = await loadOwnershipModule();
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers: loadTiers()
  });
  const originalSource = (modulePath: string) =>
    fs.readFileSync(path.join(repoRoot, modulePath), "utf8");
  const cycleWithRuntimeLog = (runtimeLogSource: string) =>
    ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource(modulePath: string) {
        if (modulePath === "src/runtime-log.ts") {
          return runtimeLogSource;
        }
        if (modulePath === "src/transcript.ts") {
          return 'import "./runtime-log.js"\nexport const value = 1\n';
        }
        return originalSource(modulePath);
      }
    });

  assert.throws(
    () => cycleWithRuntimeLog(
      'import assert from "node:assert"\n' +
      'export { value } from "./transcript.js"\n'
    ),
    /production import graph contains cycles/u
  );
  assert.throws(
    () => cycleWithRuntimeLog(
      'const matcher = /\\{/u\n' +
      'export { value } from "./transcript.js"\n'
    ),
    /production import graph contains cycles/u
  );
  assert.throws(
    () => cycleWithRuntimeLog(
      'import transcript = require("./transcript.js");\n' +
      'export const value = transcript;\n'
    ),
    /production import graph contains cycles/u
  );
});

test("dynamic imports include literal edges and reject computed edges", async () => {
  const ownershipModule = await loadOwnershipModule();
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers: loadTiers()
  });
  const originalSource = (modulePath: string) =>
    fs.readFileSync(path.join(repoRoot, modulePath), "utf8");
  const validateRuntimeLog = (runtimeLogSource: string) =>
    ownershipModule.validateProductionArchitecture({
      ownership,
      repoRoot,
      readSource(modulePath: string) {
        if (modulePath === "src/runtime-log.ts") {
          return runtimeLogSource;
        }
        if (modulePath === "src/transcript.ts") {
          return 'import "./runtime-log.js";\nexport const value = 1;\n';
        }
        return originalSource(modulePath);
      }
    });

  assert.throws(
    () => validateRuntimeLog(
      'export async function load() { return import("./transcript.js"); }\n'
    ),
    /production import graph contains cycles/u
  );
  assert.throws(
    () => validateRuntimeLog(
      'const target = "./transcript.js";\n' +
      'export async function load() { return import(target); }\n'
    ),
    /dynamic import must use one literal specifier.*literal-only-fail-closed/u
  );
});
