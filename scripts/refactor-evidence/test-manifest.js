import {
  fail,
  assertExactKeys
} from "./common.js";
import {
  validateSubprocessEvidence
} from "./subprocess.js";
import {
  validateAffectedReplay
} from "./affected-replay.js";

const TEST_EVIDENCE_SCHEMA = "agent-knock-knock/refactor-test-evidence";

export function validateTestEvidenceManifest({ manifest, repoRoot, tiers }) {
  const root = assertExactKeys(manifest, [
    "affected_selector_replay",
    "schema",
    "subprocess_startup_sites",
    "version"
  ], "test evidence manifest");
  if (root.schema !== TEST_EVIDENCE_SCHEMA || root.version !== 1) {
    fail(`test evidence manifest must use ${TEST_EVIDENCE_SCHEMA} version 1`);
  }
  return {
    subprocess: validateSubprocessEvidence(
      root.subprocess_startup_sites,
      repoRoot
    ),
    affectedReplay: validateAffectedReplay(root.affected_selector_replay, {
      repoRoot,
      tiers
    })
  };
}
