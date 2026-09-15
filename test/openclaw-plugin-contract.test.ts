import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as schemaAuthorityContracts from
  "./openclaw-plugin-contract/schema-authority.js";
import * as manifestRegistrationContracts from
  "./openclaw-plugin-contract/manifest-registration.js";
import * as nativeLifecycleToolContracts from
  "./openclaw-plugin-contract/native-lifecycle-tools.js";
import * as routingSupervisionContracts from
  "./openclaw-plugin-contract/routing-supervision.js";
import * as commandResultContracts from
  "./openclaw-plugin-contract/command-results.js";
import * as callbackRelayContracts from
  "./openclaw-plugin-contract/callback-relay.js";
import * as modelInteractionContracts from
  "./openclaw-plugin-contract/model-interaction.js";

void [
  schemaAuthorityContracts,
  manifestRegistrationContracts,
  nativeLifecycleToolContracts,
  routingSupervisionContracts,
  commandResultContracts,
  callbackRelayContracts,
  modelInteractionContracts
];

const expectedTestCount = 36;
const expectedAssertionMinimum = 689;
const expectedTestNameSha256 =
  "d35c7639526c767042e7259fface71855075cfd2384859fa6e8e312ab7765947";
const publicContractWitness =
  "OpenClaw runtime registrations match the published manifest";
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const splitSources = [
  "test/openclaw-plugin-contract/schema-authority.ts",
  "test/openclaw-plugin-contract/manifest-registration.ts",
  "test/openclaw-plugin-contract/native-lifecycle-tools.ts",
  "test/openclaw-plugin-contract/routing-supervision.ts",
  "test/openclaw-plugin-contract/command-results.ts",
  "test/openclaw-plugin-contract/callback-relay.ts",
  "test/openclaw-plugin-contract/model-interaction.ts"
];
const supportSources = [
  "test/support/openclaw-plugin-contract-support.ts"
];
const splitText = splitSources.map((sourcePath) =>
  fs.readFileSync(path.join(repositoryRoot, sourcePath), "utf8")
);
const testNames = splitText.flatMap((source) =>
  [...source.matchAll(/^test\("([^"]+)"/gmu)].map((match) => match[1] ?? "")
);
const testNameSha256 = createHash("sha256")
  .update(testNames.join("\n"))
  .digest("hex");
if (!testNames.includes(publicContractWitness) ||
    testNames.length !== expectedTestCount ||
    testNameSha256 !== expectedTestNameSha256) {
  throw new Error(
    "OpenClaw plugin contract split changed the frozen test declaration baseline"
  );
}
const assertionCount = [...splitText, ...supportSources.map((sourcePath) =>
  fs.readFileSync(path.join(repositoryRoot, sourcePath), "utf8")
)].reduce((count, source) =>
  count + [...source.matchAll(/\bassert(?:\.[A-Za-z]+)?\s*\(/gu)].length,
0);
if (assertionCount < expectedAssertionMinimum) {
  throw new Error(
    "OpenClaw plugin contract split dropped below the frozen assertion baseline"
  );
}
const entrySource = fs.readFileSync(
  path.join(repositoryRoot, "test/openclaw-plugin-contract.test.ts"),
  "utf8"
);
if (entrySource.split(/\r?\n/u).length > 100 || /^test\("/mu.test(entrySource)) {
  throw new Error("the retired OpenClaw contract monolith must remain a thin entry");
}
