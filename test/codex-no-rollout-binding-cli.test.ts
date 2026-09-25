import nodeTest from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as zeroRolloutBindingContracts from
  "./codex-no-rollout-binding-cli/zero-rollout-binding.js";
import * as deferredRecoveryContracts from
  "./codex-no-rollout-binding-cli/deferred-recovery.js";
import * as approvalAuthorityContracts from
  "./codex-no-rollout-binding-cli/approval-authority.js";
import * as candidateInventoryAcceptanceContracts from
  "./codex-no-rollout-binding-cli/candidate-inventory-acceptance.js";
import * as managedUserExplicitSendContracts from
  "./codex-no-rollout-binding-cli/managed-user-explicit-send.js";
import * as lifecycleIdentityInspectionContracts from
  "./codex-no-rollout-binding-cli/lifecycle-identity-inspection.js";
import {
  codexNoRolloutTestDefinitions
} from "./support/codex-no-rollout-binding-cli-support.js";

void [
  zeroRolloutBindingContracts,
  deferredRecoveryContracts,
  approvalAuthorityContracts,
  candidateInventoryAcceptanceContracts,
  managedUserExplicitSendContracts,
  lifecycleIdentityInspectionContracts
];

interface CodexNoRolloutShardExpansion {
  canonical_source: string;
  compiled_shards: string[];
  declaration_shards: number[];
}

interface TestFileShardConfig {
  schema: string;
  version: number;
  expansions: CodexNoRolloutShardExpansion[];
}

const shardConfig = JSON.parse(fs.readFileSync(
  new URL("../../config/test-file-shards.json", import.meta.url),
  "utf8"
)) as TestFileShardConfig;
if (
  shardConfig.schema !== "agent-knock-knock/test-file-shards" ||
  shardConfig.version !== 1 ||
  !Array.isArray(shardConfig.expansions)
) {
  throw new Error("Codex no-rollout test shard config is malformed");
}
const shardExpansion = shardConfig.expansions.find((candidate) =>
  candidate.canonical_source ===
    "test/codex-no-rollout-binding-cli.test.ts"
);
if (
  !shardExpansion ||
  !Array.isArray(shardExpansion.compiled_shards) ||
  shardExpansion.compiled_shards.length < 5 ||
  !Array.isArray(shardExpansion.declaration_shards)
) {
  throw new Error("Codex no-rollout canonical test shard expansion is missing");
}
const activeShardExpansion: CodexNoRolloutShardExpansion = shardExpansion;
const shardParameters = new URL(import.meta.url).searchParams;
const shardQueryValues = shardParameters.getAll("akk-shard");
if (
  shardQueryValues.length > 1 ||
  [...shardParameters.keys()].some((key) => key !== "akk-shard")
) {
  throw new Error("Codex no-rollout test shard query is malformed");
}
const shardQuery = shardQueryValues[0] ?? null;
if (shardQuery !== null && !/^(?:0|[1-9][0-9]*)$/u.test(shardQuery)) {
  throw new Error(`invalid Codex no-rollout test shard ${shardQuery}`);
}
const selectedShard = shardQuery === null ? undefined : Number(shardQuery);
if (
  selectedShard !== undefined &&
  (
    !Number.isSafeInteger(selectedShard) ||
    selectedShard < 0 ||
    selectedShard >= activeShardExpansion.compiled_shards.length
  )
) {
  throw new Error(`invalid Codex no-rollout test shard ${shardQuery}`);
}
const shardWorkerEntry = process.argv[1]
  ? path.relative(
      fileURLToPath(new URL("../../", import.meta.url)),
      path.resolve(process.argv[1])
    ).split(path.sep).join("/")
  : undefined;
const workerEntryShard = shardWorkerEntry === undefined
  ? -1
  : activeShardExpansion.compiled_shards.indexOf(shardWorkerEntry);
if (
  (selectedShard === undefined && workerEntryShard !== -1) ||
  (selectedShard !== undefined && workerEntryShard !== selectedShard)
) {
  throw new Error(
    `Codex no-rollout shard query ${String(selectedShard)} does not match ` +
      `worker entry ${String(shardWorkerEntry)}`
  );
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const entrySource = fs.readFileSync(
  path.join(repositoryRoot, "test/codex-no-rollout-binding-cli.test.ts"),
  "utf8"
);
if (
  entrySource.split(/\r?\n/u).length > 225 ||
  /^\s{0,2}test\(/mu.test(entrySource)
) {
  throw new Error(
    "the retired Codex no-rollout binding monolith must remain a thin entry"
  );
}

// These exact names remain in the canonical source for the public-contract and
// subprocess crash-boundary witness manifests.
const canonicalWitnesses = [
  "virgin raw Codex attach atomically refines the Session and Turn binding after send",
  "zero-input deferred source Session reservation before its transfer receipt recovery aborts safely before one refreshed retry"
];
void canonicalWitnesses;

const definitions = codexNoRolloutTestDefinitions();
const runtimeNameSha256 = createHash("sha256")
  .update(definitions.map((definition) => definition.name).join("\n"))
  .digest("hex");
if (definitions.length !== activeShardExpansion.declaration_shards.length) {
  throw new Error(
    "Codex no-rollout test shard plan covers " +
      `${activeShardExpansion.declaration_shards.length} declarations, ` +
      `but the canonical suite declares ${definitions.length}`
  );
}
if (
  runtimeNameSha256 !==
    "35d970ca1c8f39384b1c93452ee8ec3de1d72ef61283482903d1f3a2eb8c47af"
) {
  throw new Error(
    "Codex no-rollout split changed the frozen runtime test name order"
  );
}
definitions.forEach((definition, declarationIndex) => {
  const assignedShard =
    activeShardExpansion.declaration_shards[declarationIndex];
  if (
    !Number.isSafeInteger(assignedShard) ||
    assignedShard < 0 ||
    assignedShard >= activeShardExpansion.compiled_shards.length
  ) {
    throw new Error(
      `Codex no-rollout test declaration ${declarationIndex} has no valid shard`
    );
  }
  if (selectedShard === undefined || assignedShard === selectedShard) {
    void nodeTest(definition.name, definition.body);
  }
});
