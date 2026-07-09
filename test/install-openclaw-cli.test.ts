import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const packageRoot = path.resolve(path.dirname(binPath), "../..");
const skillSource = path.join(packageRoot, "templates", "openclaw-skills", "agent-knock-knock", "SKILL.md");

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
    assert.equal(result.steps[0].mode, "replaced");
    assert.deepEqual(readCalls(callsPath), [
      ["plugins", "install", "--link", packageRoot],
      ["plugins", "install", "--force", packageRoot],
      ["plugins", "enable", "agent-knock-knock"],
      ["gateway", "restart"]
    ]);
    assert.equal(fs.readFileSync(skillDest, "utf8"), fs.readFileSync(skillSource, "utf8"));
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

function writeFakeOpenClaw(filePath: string, callsPath: string) {
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n", "utf8");
if (args[0] === "plugins" && args[1] === "install" && args.includes("--link")) {
  process.stderr.write("plugin already exists: /tmp/agent-knock-knock (delete it first)\\n");
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
