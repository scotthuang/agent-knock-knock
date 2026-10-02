#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  packageJson,
  minimumHostVersion,
  minimumApiVersion,
  buildVersion,
  boundaryVersion,
  parseTargets,
  versionForTarget
} from "./openclaw-compatibility/configuration.js";
import {
  installHost,
  packArtifact
} from "./openclaw-compatibility/host-install.js";
import {
  verifyApiBoundary
} from "./openclaw-compatibility/api-boundary.js";
import {
  verifyFullHost
} from "./openclaw-compatibility/full-host.js";
import {
  safeName
} from "./openclaw-compatibility/command-runtime.js";

const requestedTargets = parseTargets(process.argv.slice(2));
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-openclaw-compat-")
);
const summaries = [];
let artifactPath;

try {
  for (const target of requestedTargets) {
    const version = versionForTarget(target);
    process.stderr.write(
      `Verifying OpenClaw ${version} (${target})...\n`
    );
    const caseRoot = path.join(tempRoot, safeName(target));
    fs.mkdirSync(caseRoot, { recursive: true });
    const host = installHost(version, caseRoot, tempRoot);

    if (target === "api-minimum" || target === "api-boundary") {
      artifactPath ??= packArtifact(tempRoot);
      summaries.push(
        await verifyApiBoundary({
          artifactPath,
          caseRoot,
          expectSupported: target === "api-minimum",
          host,
          target,
          version
        })
      );
      continue;
    }

    artifactPath ??= packArtifact(tempRoot);
    summaries.push(
      await verifyFullHost({
        artifactPath,
        caseRoot,
        host,
        target,
        version
      })
    );
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    package: packageJson.name,
    package_version: packageJson.version,
    minimum_host_version: minimumHostVersion,
    minimum_plugin_api_version: minimumApiVersion,
    build_openclaw_version: buildVersion,
    api_boundary_version: boundaryVersion,
    results: summaries
  }, null, 2)}\n`);
} finally {
  if (process.env.AKK_KEEP_COMPAT_TEMP === "1") {
    process.stderr.write(`Compatibility temp retained at ${tempRoot}\n`);
  } else {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
