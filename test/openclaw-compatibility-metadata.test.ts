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
const minimumHostVersion = "2026.5.12";
const minimumHostRange = `>=${minimumHostVersion}`;
const verifiedBuildVersion = "2026.9.1";
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

test("OpenClaw build metadata matches the installed and verified SDK", () => {
  const buildVersion = packageJson.devDependencies?.openclaw;
  assert.equal(buildVersion, verifiedBuildVersion);
  assert.notEqual(buildVersion, minimumApiVersion);
  assert.notEqual(buildVersion, minimumHostVersion);
  assert.equal(packageJson.openclaw?.build?.openclawVersion, buildVersion);
  assert.equal(packageJson.openclaw?.build?.pluginSdkVersion, buildVersion);
});

test("README states the supported floor and links installation boundary details", () => {
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
  const operations = fs.readFileSync(path.join(packageRoot, "docs/openclaw-operations.md"), "utf8");
  const tmuxQuickstart = fs.readFileSync(
    path.join(packageRoot, "docs", "quickstart-tmux.md"),
    "utf8"
  );

  assert.match(
    readme,
    new RegExp("You need OpenClaw `" + escapeRegex(minimumHostVersion) + "`\\+")
  );
  assert.match(readme, new RegExp(escapeRegex(minimumApiVersion)));
  assert.match(readme, /docs\/openclaw-operations\.md/u);
  assert.match(
    operations,
    new RegExp("Install floor.*OpenClaw `" + escapeRegex(minimumHostVersion) + "`")
  );
  assert.match(
    operations,
    new RegExp("API floor.*Gateway `" + escapeRegex(minimumApiVersion) + "`")
  );
  assert.match(operations, new RegExp(escapeRegex(boundaryVersion)));
  assert.match(
    tmuxQuickstart,
    new RegExp("^- OpenClaw `" + escapeRegex(minimumHostVersion) + "` or newer", "mu")
  );
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}


test("compatibility probes acknowledge reviewed legacy archives only when the Host supports it", async () => {
  const { openClawPluginInstallArgs } = await import(
    new URL("../../scripts/openclaw-compatibility/command-runtime.js", import.meta.url).href
  );
  const source = "npm-pack:/isolated/reviewed-akk.tgz";
  for (const [status, text, flags] of [
    [0, "--dangerously-force-unsafe-install", ["--force", "--dangerously-force-unsafe-install"]],
    [0, "--accept-capabilities --dangerously-force-unsafe-install", ["--force", "--accept-capabilities"]],
    [0, "--link --force", ["--force"]],
    [1, "--accept-capabilities --dangerously-force-unsafe-install", ["--force"]]
  ] as const) {
    assert.deepEqual(openClawPluginInstallArgs(() => ({ status, stdout: text }), source),
      ["plugins", "install", ...flags, source]);
  }
});
