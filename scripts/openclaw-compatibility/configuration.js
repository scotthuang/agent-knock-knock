import path from "node:path";
import {
  packageRoot
} from "./paths.js";
import {
  readJson,
  exactFloor,
  requiredString
} from "./command-runtime.js";

export const packageJson = readJson(path.join(packageRoot, "package.json"));

export const manifest = readJson(path.join(packageRoot, "openclaw.plugin.json"));

export const minimumHostVersion = exactFloor(
  packageJson.openclaw?.install?.minHostVersion,
  "openclaw.install.minHostVersion"
);

export const minimumApiVersion = exactFloor(
  packageJson.openclaw?.compat?.pluginApi,
  "openclaw.compat.pluginApi"
);

export const buildVersion = requiredString(
  packageJson.openclaw?.build?.openclawVersion,
  "openclaw.build.openclawVersion"
);

export const boundaryVersion = "2026.5.10-beta.2";

const knownTargets = [
  "minimum",
  "current",
  "api-minimum",
  "api-boundary"
];

export function parseTargets(argv) {
  if (argv.length === 0) {
    return knownTargets;
  }
  const selected = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--target") {
      throw new Error(`Unexpected compatibility argument: ${argument}`);
    }
    const target = argv[index + 1];
    if (!target || !knownTargets.includes(target)) {
      throw new Error(
        `--target must be one of: ${knownTargets.join(", ")}`
      );
    }
    selected.push(target);
    index += 1;
  }
  return [...new Set(selected)];
}

export function versionForTarget(target) {
  if (target === "minimum") {
    return minimumHostVersion;
  }
  if (target === "current") {
    return buildVersion;
  }
  if (target === "api-minimum") {
    return minimumApiVersion;
  }
  return boundaryVersion;
}
