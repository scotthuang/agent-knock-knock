import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageRootDir } from "../src/cli-command-runtime.js";
import {
  runDoctor,
  runInstallOpenClaw,
  type InstallDoctorCommandOptions
} from "../src/install-doctor-command-adapter.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";

test("install adapter preserves force fallback, copy/restart order, verification, and JSON keys", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-install-adapter-"));
  const callsPath = path.join(tempDir, "calls.ndjson");
  const openclawBin = path.join(tempDir, "openclaw");
  const tmuxBin = path.join(tempDir, "tmux");
  const claudeBin = path.join(tempDir, "claude");
  const skillDest = path.join(tempDir, "skills", "agent-knock-knock", "SKILL.md");
  const root = packageRootDir();

  try {
    writeFakeOpenClaw(openclawBin, callsPath, skillDest);
    writeVersionExecutable(tmuxBin, "tmux 3.5a");
    writeVersionExecutable(claudeBin, "2.1.218 (Claude Code)");
    const options: InstallDoctorCommandOptions = {
      openclawBin,
      skillPath: skillDest,
      verify: true,
      timeoutMs: 10_000,
      tmuxBin,
      herdrBin: path.join(tempDir, "missing-herdr"),
      codexBin: path.join(tempDir, "missing-codex"),
      claudeBin
    };
    const execution = await runCliCommandExecution(
      "install-openclaw",
      options,
      { runtimeLog: () => undefined },
      async () => runInstallOpenClaw(options)
    );

    assert.equal(execution.exitCode, 0);
    const output = JSON.parse(execution.stdout);
    assert.deepEqual(Object.keys(output), [
      "installed",
      "ready",
      "pending_restart",
      "mode",
      "execution_mode",
      "terminal_providers",
      "package_root",
      "openclaw_bin",
      "steps",
      "verification",
      "next_actions"
    ]);
    assert.deepEqual(Object.keys(output.verification), [
      "ok",
      "readiness",
      "selected_mode",
      "available_transports",
      "live_terminal",
      "package_root",
      "checks",
      "package_files",
      "capabilities",
      "openclaw",
      "notes"
    ]);
    assert.equal(output.ready, true);
    assert.deepEqual(output.steps.map((step) => step.name), [
      "plugin_installed",
      "plugin_configured",
      "skill_installed",
      "gateway_restarted"
    ]);
    assert.equal(
      fs.readFileSync(skillDest, "utf8"),
      fs.readFileSync(
        path.join(root, "templates", "openclaw-skills", "agent-knock-knock", "SKILL.md"),
        "utf8"
      )
    );
    assert.deepEqual(readCalls(callsPath), [
      ["plugins", "install", "--link", root],
      ["plugins", "install", "--force", root],
      ["config", "set", "--batch-json", JSON.stringify([{
        path: "plugins.entries.agent-knock-knock.enabled",
        value: true
      }])],
      ["gateway", "restart"],
      ["--version"],
      ["config", "validate", "--json"],
      ["config", "get", "plugins.entries.agent-knock-knock", "--json"],
      ["plugins", "inspect", "agent-knock-knock", "--runtime", "--json"],
      ["skills", "info", "agent-knock-knock", "--json"],
      ["health", "--json", "--timeout", "10000"]
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("doctor adapter writes its report before setting a failing exit code", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-doctor-adapter-"));
  try {
    const missing = path.join(tempDir, "missing");
    const options: InstallDoctorCommandOptions = {
      openclawBin: missing,
      tmuxBin: missing,
      herdrBin: missing,
      codexBin: missing,
      claudeBin: missing,
      timeoutMs: 100
    };
    const execution = await runCliCommandExecution(
      "doctor",
      options,
      { runtimeLog: () => undefined },
      async () => runDoctor(options)
    );

    assert.equal(execution.exitCode, 1);
    assert.equal(JSON.parse(execution.stdout).ok, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeFakeOpenClaw(
  filePath: string,
  callsPath: string,
  skillDest: string
): void {
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "plugins" && args[1] === "install" && args[2] === "--link") {
  process.stderr.write("plugin already exists: agent-knock-knock");
  process.exit(1);
}
if (args[0] === "gateway" && args[1] === "restart") {
  if (!fs.existsSync(${JSON.stringify(skillDest)})) process.exit(7);
  process.exit(0);
}
if (args[0] === "--version") process.stdout.write("OpenClaw 2026.6.5\\n");
else if (args[0] === "config" && args[1] === "validate") process.stdout.write('{"valid":true}');
else if (args[0] === "config" && args[1] === "get") process.stdout.write('{"enabled":true}');
else if (args[0] === "plugins" && args[1] === "inspect") {
  process.stdout.write('{"plugin":{"id":"agent-knock-knock","source":"local","enabled":true,"status":"loaded"},"diagnostics":[]}');
} else if (args[0] === "skills" && args[1] === "info") {
  process.stdout.write('{"name":"agent-knock-knock","eligible":true,"disabled":false,"blockedByAllowlist":false,"blockedByAgentFilter":false}');
} else if (args[0] === "health") process.stdout.write('{"ok":true}');
`, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function writeVersionExecutable(filePath: string, version: string): void {
  fs.writeFileSync(filePath, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(version)}\n`, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function readCalls(filePath: string): string[][] {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
