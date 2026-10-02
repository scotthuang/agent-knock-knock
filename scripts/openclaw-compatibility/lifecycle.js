import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  openClawPluginInstallArgs,
  run,
  isolatedEnv
} from "./command-runtime.js";

export function verifyPluginLifecycle({
  artifact,
  caseRoot,
  host,
  workspace
}) {
  const stateDir = path.join(caseRoot, "lifecycle-state");
  const configPath = path.join(stateDir, "openclaw.json");
  const openclawHome = path.join(caseRoot, "lifecycle-home");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(openclawHome, { recursive: true });
  const env = isolatedEnv({
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_STATE_DIR: stateDir,
    npm_config_cache: path.join(caseRoot, "npm-cache"),
    npm_config_update_notifier: "false"
  });
  const openclaw = (args, options = {}) => run(host.openclawBin, args, {
    cwd: workspace,
    env,
    timeoutMs: options.timeoutMs ?? 90_000,
    ...options
  });
  const pluginInstallArgs = openClawPluginInstallArgs(openclaw, artifact);

  // A plain tarball is intentionally tracked as an archive. That lets the
  // candidate verify update CLI behavior without consulting npm, where the
  // previously published release still carries the old compatibility floor.
  openclaw(pluginInstallArgs, {
    timeoutMs: 4 * 60 * 1000
  });
  const update = openclaw([
    "plugins",
    "update",
    "agent-knock-knock",
    "--dry-run"
  ]);
  assert.match(
    `${update.stdout}\n${update.stderr}`,
    /Skipping "agent-knock-knock" \(source: archive\)/u
  );
  openclaw(pluginInstallArgs, {
    timeoutMs: 4 * 60 * 1000
  });
  openclaw([
    "plugins",
    "uninstall",
    "agent-knock-knock",
    "--dry-run"
  ]);
  openclaw([
    "plugins",
    "uninstall",
    "agent-knock-knock",
    "--force"
  ], {
    timeoutMs: 2 * 60 * 1000
  });
  const afterUninstall = openclaw([
    "plugins",
    "inspect",
    "agent-knock-knock",
    "--runtime",
    "--json"
  ], {
    allowNonzero: true
  });
  assert.notEqual(
    afterUninstall.status,
    0,
    "the plugin must no longer inspect successfully after uninstall"
  );
  return {
    update: "archive-skip-passed"
  };
}
