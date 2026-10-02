import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  packageRoot
} from "./paths.js";
import {
  run,
  runNpm,
  isolatedEnv,
  readJson,
  safeName,
  escapeRegex
} from "./command-runtime.js";

export function installHost(version, caseRoot, tempRoot) {
  const hostDir = path.join(caseRoot, "host");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(
    path.join(hostDir, "package.json"),
    `${JSON.stringify({
      name: `akk-openclaw-compat-${safeName(version)}`,
      private: true,
      version: "0.0.0"
    }, null, 2)}\n`,
    "utf8"
  );
  const env = isolatedEnv({
    // The matrix is sequential, so one run-private cache avoids downloading
    // the same large OpenClaw dependency tree independently for every target.
    npm_config_cache: path.join(tempRoot, "npm-cache"),
    npm_config_update_notifier: "false"
  });
  runNpm([
    "install",
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
    "--save-exact",
    `openclaw@${version}`
  ], {
    cwd: hostDir,
    env,
    timeoutMs: 20 * 60 * 1000
  });

  const openclawPackagePath = path.join(
    hostDir,
    "node_modules",
    "openclaw",
    "package.json"
  );
  const installedPackage = readJson(openclawPackagePath);
  assert.equal(
    installedPackage.version,
    version,
    "isolated host must contain the exact requested OpenClaw version"
  );
  const openclawBin = process.platform === "win32"
    ? path.join(hostDir, "node_modules", ".bin", "openclaw.cmd")
    : path.join(hostDir, "node_modules", ".bin", "openclaw");
  assert.equal(fs.existsSync(openclawBin), true, "OpenClaw CLI must exist");

  const versionResult = run(openclawBin, ["--version"], {
    cwd: hostDir,
    env,
    timeoutMs: 30_000
  });
  assert.match(
    `${versionResult.stdout}\n${versionResult.stderr}`,
    new RegExp(escapeRegex(version)),
    "OpenClaw CLI must report the exact candidate version"
  );

  return {
    dir: hostDir,
    env,
    openclawBin,
    packagePath: openclawPackagePath,
    version
  };
}

export function packArtifact(root) {
  const artifactDir = path.join(root, "artifact");
  fs.mkdirSync(artifactDir, { recursive: true });
  const packed = run("npm", [
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    artifactDir,
    "--silent"
  ], {
    cwd: packageRoot,
    env: isolatedEnv(),
    timeoutMs: 2 * 60 * 1000
  });
  const filename = packed.stdout.trim().split(/\r?\n/u).at(-1);
  const artifact = filename ? path.join(artifactDir, filename) : undefined;
  assert.equal(
    typeof artifact === "string" && fs.existsSync(artifact),
    true,
    "npm pack must create the AKK artifact"
  );
  return artifact;
}
