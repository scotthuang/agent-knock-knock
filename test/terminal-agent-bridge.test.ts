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

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const entrySource = fs.readFileSync(
  path.join(repositoryRoot, "test/terminal-agent-bridge.test.ts"),
  "utf8"
);
if (entrySource.split(/\r?\n/u).length > 140 || /^test\("/mu.test(entrySource)) {
  throw new Error("the retired terminal bridge contract monolith must remain a thin entry");
}
