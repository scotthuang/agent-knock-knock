import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function loadEvidenceModule() {
  return import(
    pathToFileURL(path.join(repoRoot, "scripts", "refactor-evidence.js")).href
  );
}

function loadJson(repositoryPath: string): any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, repositoryPath), "utf8"));
}

function loadTiers(): { fast: string[]; integration: string[] } {
  return loadJson("test/test-tiers.json");
}

test("package wires the standalone and architecture refactor evidence gates", () => {
  const packageJson = loadJson("package.json");
  assert.equal(
    packageJson.scripts["validate:refactor-evidence"],
    "node scripts/validate-refactor-evidence.js"
  );
  const architectureValidator = fs.readFileSync(
    path.join(repoRoot, "scripts", "validate-architecture.js"),
    "utf8"
  );
  assert.match(architectureValidator, /loadAndValidateRefactorEvidence/u);
});

test("Phase 1 evidence reproduces startup counts and historical selection", async () => {
  const evidenceModule = await loadEvidenceModule();
  const evidence = evidenceModule.loadAndValidateRefactorEvidence({
    repoRoot,
    tiers: loadTiers()
  });

  assert.equal(evidence.testEvidence.subprocess.baselineIncluded, 48);
  assert.equal(evidence.testEvidence.subprocess.currentIncluded, 28);
  assert.equal(evidence.testEvidence.subprocess.reductionBasisPoints, 4167);
  assert.equal(evidence.testEvidence.subprocess.targetRequired, false);
  assert.equal(evidence.testEvidence.subprocess.targetMet, false);
  assert.deepEqual(
    evidence.testEvidence.subprocess.currentCounts,
    {
      cli_process: 18,
      fake_node_process: 10,
      other_process_or_adapter: 12
    }
  );

  assert.equal(evidence.testEvidence.affectedReplay.scenario_count, 10);
  assert.equal(evidence.testEvidence.affectedReplay.full_count, 9);
  assert.equal(evidence.testEvidence.affectedReplay.targeted_count, 1);
  assert.equal(
    evidence.testEvidence.affectedReplay.full_rate_basis_points,
    9000
  );
  assert.equal(evidence.testEvidence.affectedReplay.targetRequired, false);
  assert.equal(evidence.testEvidence.affectedReplay.targetMet, false);
  assert.deepEqual(
    evidence.testEvidence.affectedReplay.results.filter(
      (result: { mode: string }) => result.mode === "targeted"
    ),
    [{
      commit: "95bbed33d62bae946bb5163f4478141cdecf3acc",
      mode: "targeted"
    }]
  );

  assert.deepEqual(evidence.publicContracts, {
    contractCount: 4,
    witnessCount: 56,
    migrationCount: 10,
    openclawToolCount: 14,
    storeProtocolCount: 5
  });
});

test("one required flag turns an unmet final threshold into a hard failure", async () => {
  const evidenceModule = await loadEvidenceModule();
  assert.doesNotThrow(() => evidenceModule.enforceRequiredFinalThreshold({
    required: false,
    targetMet: false,
    label: "recording gate"
  }));
  assert.throws(
    () => evidenceModule.enforceRequiredFinalThreshold({
      required: true,
      targetMet: false,
      label: "release gate"
    }),
    /release gate final threshold is required but not met/u
  );
});

test("test evidence schema rejects incomplete or unreviewed top-level fields", async () => {
  const evidenceModule = await loadEvidenceModule();
  const missing = loadJson("config/refactor-test-evidence.json");
  delete missing.affected_selector_replay;
  assert.throws(
    () => evidenceModule.validateTestEvidenceManifest({
      manifest: missing,
      repoRoot,
      tiers: loadTiers()
    }),
    /missing keys: affected_selector_replay/u
  );

  const unknown = loadJson("config/refactor-test-evidence.json");
  unknown.unreviewed_escape_hatch = true;
  assert.throws(
    () => evidenceModule.validateTestEvidenceManifest({
      manifest: unknown,
      repoRoot,
      tiers: loadTiers()
    }),
    /unexpected keys: unreviewed_escape_hatch/u
  );
});

test("public contract evidence fails closed on missing witnesses and protocol drift", async () => {
  const evidenceModule = await loadEvidenceModule();
  const validate = (manifest: any) =>
    evidenceModule.validatePublicContractManifest({
      manifest,
      repoRoot,
      tiers: loadTiers()
    });

  const missingWitness = loadJson("config/public-contract-witnesses.json");
  missingWitness.witnesses[0].path = "test/missing-contract.test.ts";
  assert.throws(
    () => validate(missingWitness),
    /is not in the declared fast tier|missing/u
  );

  const missingContract = loadJson("config/public-contract-witnesses.json");
  delete missingContract.contracts.cli_json;
  assert.throws(() => validate(missingContract), /missing keys: cli_json/u);

  const protocolDrift = loadJson("config/public-contract-witnesses.json");
  protocolDrift.contracts.store_protocols.current_writer_protocol = 6;
  assert.throws(
    () => validate(protocolDrift),
    /Store format\/writer\/session-authority protocol contract changed/u
  );

  const duplicateTool = loadJson("config/public-contract-witnesses.json");
  duplicateTool.contracts.openclaw_tools.tools[13] =
    duplicateTool.contracts.openclaw_tools.tools[12];
  assert.throws(() => validate(duplicateTool), /OpenClaw tools must equal/u);
});
