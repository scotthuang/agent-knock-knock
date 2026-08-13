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

test("production ownership covers every source module and preserves architecture ceilings", async () => {
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
  assert.ok(architecture.cliCorePhysicalLoc <= 38_005);
  assert.deepEqual(architecture.cliCoreImporters, ["src/cli.ts"]);
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
});

test("architecture checks reject cli-core growth and unapproved reverse imports", async () => {
  const ownershipModule = await loadOwnershipModule();
  const ownership = ownershipModule.loadAndValidateProductionModuleOwnership({
    repoRoot,
    tiers: loadTiers()
  });
  const source = (modulePath: string) =>
    fs.readFileSync(path.join(repoRoot, modulePath), "utf8");

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
    /exceeding manifest ceiling 38005/u
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

test("production import cycles fail unless the exact cycle is explicitly reviewed", async () => {
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

  manifest.architecture.allow_import_cycles = [[
    "src/runtime-log.ts",
    "src/transcript.ts"
  ]];
  const reviewedOwnership =
    ownershipModule.validateProductionModuleOwnershipManifest({
      manifest,
      productionPaths,
      integrationTests
    });
  const reviewed = ownershipModule.validateProductionArchitecture({
    ownership: reviewedOwnership,
    repoRoot,
    readSource
  });
  assert.equal(reviewed.importCycles, 1);
});
