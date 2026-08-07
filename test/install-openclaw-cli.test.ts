import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const packageRoot = path.resolve(path.dirname(binPath), "../..");
const skillSource = path.join(packageRoot, "templates", "openclaw-skills", "agent-knock-knock", "SKILL.md");

test("OpenClaw contract removes the top-level workspace and keeps rule-scoped approval workspaces", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "openclaw.plugin.json"), "utf8"));
  const configProperties = manifest.configSchema.properties;
  assert.equal("workspace" in configProperties, false);
  const autoApproveRule =
    configProperties.autoApprove.properties.rules.items;
  assert.equal(autoApproveRule.required.includes("workspaces"), true);
  assert.equal(autoApproveRule.properties.workspaces.type, "array");
  assert.equal(autoApproveRule.properties.workspaces.minItems, 1);
  assert.equal("maxItems" in autoApproveRule.properties.workspaces, false);
  assert.equal(autoApproveRule.properties.workspaces.items.type, "string");
  assert.equal(autoApproveRule.properties.workspaces.items.minLength, 1);
  assert.equal(manifest.configSchema.properties.agentTimeoutMinutes.type, "number");
  assert.equal(manifest.configSchema.properties.agentHardTimeoutMinutes.type, "number");
  assert.equal(manifest.configSchema.properties.agentHardTimeoutMinutes.exclusiveMinimum, 0);
  assert.equal(manifest.contracts.tools.includes("agent_knock_knock_renew"), true);
  assert.equal(manifest.toolMetadata.agent_knock_knock_renew.optional, true);
  assert.equal(manifest.contracts.tools.includes("agent_knock_knock_respond"), true);
  assert.equal(manifest.toolMetadata.agent_knock_knock_respond.optional, true);
  for (const lifecycleTool of [
    "agent_knock_knock_list_resumable_threads",
    "agent_knock_knock_new_thread",
    "agent_knock_knock_resume_thread"
  ]) {
    assert.equal(manifest.contracts.tools.includes(lifecycleTool), true);
    assert.equal(manifest.toolMetadata[lifecycleTool].optional, true);
  }

  const pluginSource = fs.readFileSync(path.join(packageRoot, "src", "openclaw-plugin.ts"), "utf8");
  assert.match(pluginSource, /const sendParameters =[\s\S]*?agentTimeoutMinutes:[\s\S]*?agentHardTimeoutMinutes:/u);
  assert.match(
    pluginSource,
    /const approveParameters =[\s\S]*?required: \["expected_approval_fingerprint"\][\s\S]*?anyOf: \[[\s\S]*?required: \["turn_id"\][\s\S]*?required: \["conversation_id"\]/u
  );
  assert.match(pluginSource, /--expected-approval-fingerprint/u);
  assert.match(pluginSource, /name: "agent_knock_knock_renew"/u);
  assert.match(pluginSource, /name: "agent_knock_knock_new_thread"/u);
  assert.match(pluginSource, /name: "agent_knock_knock_list_resumable_threads"/u);
  assert.match(pluginSource, /name: "agent_knock_knock_resume_thread"/u);
  assert.match(
    pluginSource,
    /Managed approval uses exact turn_id[\s\S]*?Claude Code uses no Hooks:[\s\S]*?exact one-time Bash permission screen[\s\S]*?trusted default-disabled plugin configuration[\s\S]*?auto-approve[\s\S]*?durable completion[\s\S]*?local Claude transcript/u
  );
  assert.doesNotMatch(pluginSource, /structured one-time Hook|pending structured permission/u);
  assert.doesNotMatch(pluginSource, /install-claude-hooks/u);
  assert.match(pluginSource, /createMonitorReconciliationService[\s\S]*?agent-knock-knock-monitor-reconciliation/u);
  assert.match(pluginSource, /const args = \["reconcile-monitors", "--reason", reason\][\s\S]*?--terminal-monitors-only[\s\S]*?catch \(error\)[\s\S]*?logger\.warn/u);
  assert.match(fs.readFileSync(skillSource, "utf8"), /agent_knock_knock_renew/u);
  assert.match(
    fs.readFileSync(skillSource, "utf8"),
    /agent_knock_knock_list_resumable_threads/u
  );
});

test("install-openclaw replaces an existing plugin and installs its skill", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-install-openclaw-"));
  const callsPath = path.join(tempDir, "calls.ndjson");
  const fakeOpenClaw = path.join(tempDir, "openclaw");
  const skillDest = path.join(tempDir, "skills", "agent-knock-knock", "SKILL.md");

  try {
    writeFakeOpenClaw(fakeOpenClaw, callsPath);
    const result = runCli([
      "install-openclaw",
      "--openclaw-bin",
      fakeOpenClaw,
      "--skill-path",
      skillDest
    ]);

    assert.equal(result.mode, "full");
    assert.equal(result.ready, false);
    assert.equal(result.next_actions[0].action, "verify");
    assert.equal(result.steps[0].mode, "replaced");
    assert.deepEqual(readCalls(callsPath), [
      ["plugins", "install", "--link", packageRoot],
      ["plugins", "install", "--force", packageRoot],
      [
        "config",
        "set",
        "--batch-json",
        JSON.stringify([
          {
            path: "plugins.entries.agent-knock-knock.enabled",
            value: true
          }
        ])
      ],
      ["gateway", "restart"]
    ]);
    assert.equal(fs.readFileSync(skillDest, "utf8"), fs.readFileSync(skillSource, "utf8"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("install-openclaw confirms the trusted local source when OpenClaw requires force", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-install-openclaw-trust-"));
  const callsPath = path.join(tempDir, "calls.ndjson");
  const fakeOpenClaw = path.join(tempDir, "openclaw");
  const skillDest = path.join(tempDir, "skills", "agent-knock-knock", "SKILL.md");

  try {
    writeFakeOpenClaw(fakeOpenClaw, callsPath, "trust_required");
    const result = runCli([
      "install-openclaw",
      "--openclaw-bin",
      fakeOpenClaw,
      "--skill-path",
      skillDest
    ]);

    assert.equal(result.steps[0].mode, "replaced");
    assert.deepEqual(readCalls(callsPath), [
      ["plugins", "install", "--link", packageRoot],
      ["plugins", "install", "--force", packageRoot],
      [
        "config",
        "set",
        "--batch-json",
        JSON.stringify([
          {
            path: "plugins.entries.agent-knock-knock.enabled",
            value: true
          }
        ])
      ],
      ["gateway", "restart"]
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("install-openclaw without a top-level workspace preserves approval rules and is ready", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-install-openclaw-verify-"));
  const callsPath = path.join(tempDir, "calls.ndjson");
  const configPath = path.join(tempDir, "plugin-config.json");
  const fakeOpenClaw = path.join(tempDir, "openclaw");
  const fakeTmux = path.join(tempDir, "tmux");
  const fakeClaude = path.join(tempDir, "claude");
  const skillDest = path.join(tempDir, "skills", "agent-knock-knock", "SKILL.md");
  const workspace = fs.realpathSync(tempDir);
  const secondWorkspace = path.join(tempDir, "second-workspace");
  const approvalPolicy = {
    enabled: true,
    rules: [{
      id: "trusted-tests",
      agents: ["codex"],
      workspaces: [workspace, secondWorkspace],
      commands: [["npm", "test"]]
    }]
  };

  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: false,
        config: {
          autoApprove: approvalPolicy,
          idleTimeoutMinutes: 8
        }
      }),
      "utf8"
    );
    writeReadyFakeOpenClaw({
      filePath: fakeOpenClaw,
      callsPath,
      configPath
    });
    writeVersionExecutable(fakeTmux, "tmux 3.5a");
    writeVersionExecutable(fakeClaude, "2.1.218 (Claude Code)");

    const result = runCli([
      "install-openclaw",
      "--openclaw-bin",
      fakeOpenClaw,
      "--skill-path",
      skillDest,
      "--verify",
      "--tmux-bin",
      fakeTmux,
      "--codex-bin",
      path.join(tempDir, "missing-codex"),
      "--claude-bin",
      fakeClaude
    ]);

    assert.equal(result.installed, true);
    assert.equal(result.ready, true);
    assert.equal("workspace" in result, false);
    assert.equal(result.pending_restart, false);
    assert.equal(result.verification.ok, true);
    assert.equal(result.verification.capabilities.tmux.status, "ready");
    assert.deepEqual(result.verification.capabilities.tmux.agents, ["claude"]);
    assert.equal(result.verification.live_terminal.checked, false);
    assert.equal(
      result.verification.live_terminal.required_for_install_readiness,
      false
    );
    assert.equal("selected_agent" in result.verification, false);
    assert.equal(result.verification.openclaw.package_ready, true);
    assert.equal(result.verification.openclaw.gateway_ready, true);
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(saved.config.autoApprove, approvalPolicy);
    assert.deepEqual(
      saved.config.autoApprove.rules[0].workspaces,
      [workspace, secondWorkspace]
    );
    assert.equal(saved.config.idleTimeoutMinutes, 8);
    assert.equal("workspace" in saved.config, false);
    assert.equal("defaultAgent" in saved.config, false);
    assert.equal(saved.enabled, true);
    assert.equal(
      readCalls(callsPath)
        .filter((args) => args[0] === "gateway" && args[1] === "restart")
        .length,
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("install-openclaw never claims readiness while a restart is pending", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-install-openclaw-pending-"));
  const callsPath = path.join(tempDir, "calls.ndjson");
  const configPath = path.join(tempDir, "plugin-config.json");
  const fakeOpenClaw = path.join(tempDir, "openclaw");
  const skillDest = path.join(tempDir, "skills", "agent-knock-knock", "SKILL.md");

  try {
    fs.writeFileSync(configPath, JSON.stringify({ config: {} }), "utf8");
    writeReadyFakeOpenClaw({
      filePath: fakeOpenClaw,
      callsPath,
      configPath
    });
    const result = runCli([
      "install-openclaw",
      "--openclaw-bin",
      fakeOpenClaw,
      "--skill-path",
      skillDest,
      "--no-restart"
    ]);

    assert.equal(result.installed, true);
    assert.equal(result.ready, false);
    assert.equal(result.pending_restart, true);
    assert.equal(
      readCalls(callsPath)
        .some((args) => args[0] === "gateway" && args[1] === "restart"),
      false
    );
    assert.equal(result.next_actions[0].command, "openclaw gateway restart");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("install-openclaw skill-only can synchronize the skill without OpenClaw", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-install-skill-"));
  const skillDest = path.join(tempDir, "skills", "agent-knock-knock", "SKILL.md");

  try {
    const result = runCli([
      "install-openclaw",
      "--skill-only",
      "--no-restart",
      "--skill-path",
      skillDest
    ], {
      PATH: tempDir
    });

    assert.equal(result.mode, "skill_only");
    assert.equal(result.openclaw_bin, null);
    assert.deepEqual(result.steps.map((step) => step.name), ["skill_installed"]);
    assert.equal(fs.readFileSync(skillDest, "utf8"), fs.readFileSync(skillSource, "utf8"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeFakeOpenClaw(
  filePath: string,
  callsPath: string,
  linkFailure: "already_exists" | "trust_required" = "already_exists"
) {
  const failure = linkFailure === "trust_required"
    ? "Install cancelled; rerun with --force after reviewing the source.\n"
    : "plugin already exists: /tmp/agent-knock-knock (delete it first)\n";
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n", "utf8");
if (args[0] === "plugins" && args[1] === "install" && args.includes("--link")) {
  process.stderr.write(${JSON.stringify(failure)});
  process.exit(1);
}
if (args.includes("--link") && args.includes("--force")) {
  process.stderr.write("--force is not supported with --link\\n");
  process.exit(1);
}
`,
    "utf8"
  );
  fs.chmodSync(filePath, 0o755);
}

function writeReadyFakeOpenClaw({
  filePath,
  callsPath,
  configPath
}: {
  filePath: string;
  callsPath: string;
  configPath: string;
}): void {
  fs.writeFileSync(
    filePath,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n", "utf8");
const readConfig = () => JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const writeConfig = (value) => fs.writeFileSync(${JSON.stringify(configPath)}, JSON.stringify(value), "utf8");
const emit = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "--version") {
  process.stdout.write("OpenClaw 2026.7.1-2");
} else if (args[0] === "config" && args[1] === "set") {
  const config = readConfig();
  const operations = JSON.parse(args[args.indexOf("--batch-json") + 1]);
  for (const operation of operations) {
    const parts = operation.path.replace(/^plugins\\.entries\\.agent-knock-knock\\./, "").split(".");
    let target = config;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = operation.value;
  }
  writeConfig(config);
} else if (args[0] === "config" && args[1] === "validate") {
  emit({ valid: true, warnings: [] });
} else if (args[0] === "config" && args[1] === "get") {
  emit(readConfig());
} else if (args[0] === "plugins" && args[1] === "inspect") {
  emit({
    plugin: {
      id: "agent-knock-knock",
      source: "/plugin/dist/src/openclaw-plugin.js",
      enabled: true,
      status: "loaded"
    },
    diagnostics: []
  });
} else if (args[0] === "skills" && args[1] === "info") {
  emit({
    name: "agent-knock-knock",
    eligible: true,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false
  });
} else if (args[0] === "health") {
  emit({ ok: true });
}
`,
    "utf8"
  );
  fs.chmodSync(filePath, 0o755);
}

function writeVersionExecutable(filePath: string, version: string): void {
  fs.writeFileSync(
    filePath,
    `#!${process.execPath}
process.stdout.write(${JSON.stringify(version)});
`,
    "utf8"
  );
  fs.chmodSync(filePath, 0o755);
}

function readCalls(filePath: string): string[][] {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
