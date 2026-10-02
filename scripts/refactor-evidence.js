import {
  loadDynamicSubprocessEvidenceConfig
} from "./subprocess-dynamic-evidence.js";
import {
  readJson
} from "./refactor-evidence/common.js";
import {
  validateTestEvidenceManifest
} from "./refactor-evidence/test-manifest.js";
import {
  validatePublicContractManifest
} from "./refactor-evidence/public-contracts.js";

export const TEST_EVIDENCE_MANIFEST_PATH =
  "config/refactor-test-evidence.json";

export const PUBLIC_CONTRACT_MANIFEST_PATH =
  "config/public-contract-witnesses.json";

export function loadAndValidateRefactorEvidence({ repoRoot, tiers }) {
  const testEvidence = validateTestEvidenceManifest({
    manifest: readJson(repoRoot, TEST_EVIDENCE_MANIFEST_PATH),
    repoRoot,
    tiers
  });
  const publicContracts = validatePublicContractManifest({
    manifest: readJson(repoRoot, PUBLIC_CONTRACT_MANIFEST_PATH),
    repoRoot,
    tiers
  });
  const dynamicSubprocess = loadDynamicSubprocessEvidenceConfig({ repoRoot });
  return { dynamicSubprocess, testEvidence, publicContracts };
}

export {
  enforceRequiredFinalThreshold
} from "./refactor-evidence/common.js";

export {
  countStaticSubprocessStartupSites,
  measureStaticSubprocessStartupSites
} from "./refactor-evidence/subprocess.js";

export {
  validateTestEvidenceManifest
} from "./refactor-evidence/test-manifest.js";

export {
  validatePublicContractManifest
} from "./refactor-evidence/public-contracts.js";
