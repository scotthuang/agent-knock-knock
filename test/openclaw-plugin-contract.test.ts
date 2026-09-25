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
const splitText = splitSources.map((sourcePath) =>
  fs.readFileSync(path.join(repositoryRoot, sourcePath), "utf8")
);
const testNames = splitText.flatMap((source) =>
  [...source.matchAll(/^test\("([^"]+)"/gmu)].map((match) => match[1] ?? "")
);
if (!testNames.includes(publicContractWitness)) {
  throw new Error(
    "OpenClaw plugin contract split lost its public contract witness"
  );
}
const entrySource = fs.readFileSync(
  path.join(repositoryRoot, "test/openclaw-plugin-contract.test.ts"),
  "utf8"
);
if (entrySource.split(/\r?\n/u).length > 100 || /^test\("/mu.test(entrySource)) {
  throw new Error("the retired OpenClaw contract monolith must remain a thin entry");
}
