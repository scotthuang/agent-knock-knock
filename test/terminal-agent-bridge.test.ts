import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as discoverySubmissionContracts from
  "./terminal-agent-bridge/discovery-submission.js";
import * as modelControlContracts from
  "./terminal-agent-bridge/model-control.js";
import * as explicitSendContracts from
  "./terminal-agent-bridge/explicit-send.js";
import * as composerRetryContracts from
  "./terminal-agent-bridge/composer-retry.js";
import * as approvalCoreContracts from
  "./terminal-agent-bridge/approval-core.js";
import * as monitorCapabilitiesContracts from
  "./terminal-agent-bridge/monitor-capabilities.js";
import * as hooklessApprovalContracts from
  "./terminal-agent-bridge/hookless-approval.js";
import * as transportFailuresContracts from
  "./terminal-agent-bridge/transport-failures.js";
import * as codexNativeInspectionContracts from
  "./terminal-agent-bridge/codex-native-inspection.js";
import * as claudeNativeInspectionContracts from
  "./terminal-agent-bridge/claude-native-inspection.js";
import * as nativeInspectionValidationContracts from
  "./terminal-agent-bridge/native-inspection-validation.js";

void [
  discoverySubmissionContracts,
  modelControlContracts,
  explicitSendContracts,
  composerRetryContracts,
  approvalCoreContracts,
  monitorCapabilitiesContracts,
  hooklessApprovalContracts,
  transportFailuresContracts,
  codexNativeInspectionContracts,
  claudeNativeInspectionContracts,
  nativeInspectionValidationContracts
];

const expectedTopLevelTestCount = 107;
const expectedSubtestCount = 59;
const expectedAssertionMinimum = 809;
const expectedDeclarationNameSha256 =
  "6e6d63a7c3b076b6c5e265f4ef650c46e16f2a91d1f607ceb641b059898da162";
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const splitSources = [
  "test/terminal-agent-bridge/discovery-submission.ts",
  "test/terminal-agent-bridge/model-control.ts",
  "test/terminal-agent-bridge/explicit-send.ts",
  "test/terminal-agent-bridge/composer-retry.ts",
  "test/terminal-agent-bridge/approval-core.ts",
  "test/terminal-agent-bridge/monitor-capabilities.ts",
  "test/terminal-agent-bridge/hookless-approval.ts",
  "test/terminal-agent-bridge/transport-failures.ts",
  "test/terminal-agent-bridge/codex-native-inspection.ts",
  "test/terminal-agent-bridge/claude-native-inspection.ts",
  "test/terminal-agent-bridge/native-inspection-validation.ts"
];
const supportSources = [
  "test/support/terminal-agent-bridge-contract-support.ts"
];
const splitText = splitSources.map((sourcePath) =>
  fs.readFileSync(path.join(repositoryRoot, sourcePath), "utf8")
);
const topLevelNames = splitText.flatMap((source) =>
  [...source.matchAll(/^test\("([^"]+)"/gmu)].map((match) => match[1] ?? "")
);
const subtestNames = splitText.flatMap((source) =>
  [...source.matchAll(/\bt\.test\("([^"]+)"/gu)].map((match) => match[1] ?? "")
);
const declarationNames = splitText.flatMap((source) =>
  [...source.matchAll(/(?:^test|\bt\.test)\("([^"]+)"/gmu)]
    .map((match) => match[1] ?? "")
);
const declarationNameSha256 = createHash("sha256")
  .update(declarationNames.join("\n"))
  .digest("hex");
if (topLevelNames.length !== expectedTopLevelTestCount ||
    subtestNames.length !== expectedSubtestCount ||
    declarationNameSha256 !== expectedDeclarationNameSha256) {
  throw new Error(
    "terminal bridge contract split changed the frozen test declaration baseline"
  );
}
const assertionCount = [...splitText, ...supportSources.map((sourcePath) =>
  fs.readFileSync(path.join(repositoryRoot, sourcePath), "utf8")
)].reduce((count, source) =>
  count + [...source.matchAll(/\bassert(?:\.[A-Za-z]+)?\s*\(/gu)].length,
0);
if (assertionCount < expectedAssertionMinimum) {
  throw new Error(
    "terminal bridge contract split dropped below the frozen assertion baseline"
  );
}
const entrySource = fs.readFileSync(
  path.join(repositoryRoot, "test/terminal-agent-bridge.test.ts"),
  "utf8"
);
if (entrySource.split(/\r?\n/u).length > 140 || /^test\("/mu.test(entrySource)) {
  throw new Error("the retired terminal bridge contract monolith must remain a thin entry");
}
