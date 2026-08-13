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

  const architecture = ownershipModule.validateProductionArchitecture({
    ownership,
    repoRoot
  });
  assert.equal(architecture.productionModules, discovered.length);
  assert.ok(architecture.importEdges > 0);
  assert.equal(architecture.importCycles, 0);
  assert.equal(
    architecture.cliCorePhysicalLoc,
    loadManifest().architecture.cli_core_max_physical_loc
  );
  assert.deepEqual(architecture.cliCoreImporters, ["src/cli.ts"]);
  assert.equal(
    ownershipModule.DYNAMIC_IMPORT_POLICY,
    "literal-only-fail-closed"
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
  weakenedCore.domains["cli-runtime"] = {
    selection: "targeted",
    integration_tests: ["test/cli-ux.test.ts"]
  };
  assert.throws(() => validate(weakenedCore), /mandatory shared core module/u);

  const missingCore = loadManifest();
  missingCore.modules = missingCore.modules.filter(
    (entry: { path: string }) => entry.path !== "src/cli-core.ts"
  );
  assert.throws(
    () => ownershipModule.validateProductionModuleOwnershipManifest({
      manifest: missingCore,
      productionPaths: productionPaths.filter(
        (modulePath: string) => modulePath !== "src/cli-core.ts"
      ),
      integrationTests
    }),
    /required production module is missing from disk: src\/cli-core\.ts/u
  );

  const cycleEscapeHatch = loadManifest();
  cycleEscapeHatch.architecture.allow_import_cycles = [];
  assert.throws(() => validate(cycleEscapeHatch), /unexpected keys: allow_import_cycles/u);
});

test("architecture checks reject cli-core LOC drift and unapproved reverse imports", async () => {
  const ownershipModule = await loadOwnershipModule();
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers: loadTiers()
  });
  const source = (modulePath: string) =>
    fs.readFileSync(path.join(repoRoot, modulePath), "utf8");
  const ratchet = loadManifest().architecture.cli_core_max_physical_loc;

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
        return modulePath === "src/runtime-log.ts"
          ? 'const embedded = `\nimport "./cli-core.js";\n`;\n'
          : source(modulePath);
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
