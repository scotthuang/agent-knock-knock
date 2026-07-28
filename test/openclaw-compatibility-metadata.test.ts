import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
) as {
  peerDependencies?: { openclaw?: string };
  devDependencies?: { openclaw?: string };
  openclaw?: {
    install?: { minHostVersion?: string };
    compat?: {
      pluginApi?: string;
      minGatewayVersion?: string;
    };
    build?: {
      openclawVersion?: string;
      pluginSdkVersion?: string;
    };
  };
};

const minimumApiVersion = "2026.5.12";
const minimumApiRange = `>=${minimumApiVersion}`;
const minimumHostVersion = "2026.6.5";
const minimumHostRange = `>=${minimumHostVersion}`;
const boundaryVersion = "2026.5.10-beta.2";

test("OpenClaw compatibility metadata distinguishes the API and install floors", () => {
  assert.equal(packageJson.peerDependencies?.openclaw, minimumApiRange);
  assert.equal(
    packageJson.openclaw?.install?.minHostVersion,
    minimumHostRange
  );
  assert.equal(packageJson.openclaw?.compat?.pluginApi, minimumApiRange);
  assert.equal(
    packageJson.openclaw?.compat?.minGatewayVersion,
    minimumApiVersion
  );
});

test("OpenClaw build metadata describes the installed SDK instead of the runtime floor", () => {
  const buildVersion = packageJson.devDependencies?.openclaw;
  assert.equal(typeof buildVersion, "string");
  assert.notEqual(buildVersion, minimumApiVersion);
  assert.equal(packageJson.openclaw?.build?.openclawVersion, buildVersion);
  assert.equal(packageJson.openclaw?.build?.pluginSdkVersion, buildVersion);
});

test("user-facing installation docs state the supported floor and failing boundary", () => {
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
  const tmuxQuickstart = fs.readFileSync(
    path.join(packageRoot, "docs", "quickstart-tmux.md"),
    "utf8"
  );
  const acpxQuickstart = fs.readFileSync(
    path.join(packageRoot, "docs", "quickstart-managed-acpx.md"),
    "utf8"
  );

  assert.match(
    readme,
    new RegExp(`OpenClaw.*${escapeRegex(minimumHostVersion)}`)
  );
  assert.match(readme, new RegExp(escapeRegex(minimumApiVersion)));
  assert.match(readme, new RegExp(escapeRegex(boundaryVersion)));
  assert.match(tmuxQuickstart, new RegExp(escapeRegex(minimumHostVersion)));
  assert.match(acpxQuickstart, new RegExp(escapeRegex(minimumHostVersion)));
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
