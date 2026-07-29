import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOpenClawChainDiagnostics } from "../src/openclaw-doctor.js";

test("OpenClaw diagnostics are ready without a top-level workspace", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-doctor-"));
  const fakeOpenClaw = path.join(tempDir, "openclaw");

  try {
    writeFakeOpenClaw(fakeOpenClaw);

    const result = runOpenClawChainDiagnostics({
      openclawBin: fakeOpenClaw,
      env: {
        AKK_FAKE_SCENARIO: "ready"
      }
    });

    assert.equal(result.ready, true, JSON.stringify(result, null, 2));
    assert.equal(result.package_ready, true, JSON.stringify(result, null, 2));
    assert.equal(result.gateway_ready, true);
    assert.equal("workspace" in result, false);
    assert.equal("default_agent" in result, false);
    assert.equal(result.checks.length, 7);
    assert.equal(
      result.checks.some((check) => String(check.name) === "workspace"),
      false
    );
    assert.equal(result.checks.every((check) => check.ok), true);
    assert.doesNotMatch(JSON.stringify(result), /do-not-return-this-secret/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw diagnostics ignore the removed default-agent setting", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-doctor-agent-"));
  const fakeOpenClaw = path.join(tempDir, "openclaw");

  try {
    writeFakeOpenClaw(fakeOpenClaw);

    const claude = runOpenClawChainDiagnostics({
      openclawBin: fakeOpenClaw,
      env: {
        AKK_FAKE_AGENT: "claude",
        AKK_FAKE_WORKSPACE: "/legacy/project",
        AKK_FAKE_SCENARIO: "ready"
      }
    });
    assert.equal("default_agent" in claude, false);

    const unsupported = runOpenClawChainDiagnostics({
      openclawBin: fakeOpenClaw,
      env: {
        AKK_FAKE_AGENT: "unknown-agent",
        AKK_FAKE_WORKSPACE: "/legacy/project",
        AKK_FAKE_SCENARIO: "ready"
      }
    });
    assert.equal("default_agent" in unsupported, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw diagnostics keep package and Gateway readiness independent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-doctor-health-"));
  const fakeOpenClaw = path.join(tempDir, "openclaw");

  try {
    writeFakeOpenClaw(fakeOpenClaw);

    const result = runOpenClawChainDiagnostics({
      openclawBin: fakeOpenClaw,
      env: {
        AKK_FAKE_SCENARIO: "gateway_down"
      }
    });

    assert.equal(result.ready, false);
    assert.equal(result.package_ready, true);
    assert.equal(result.gateway_ready, false);
    const gateway = result.checks.find((check) => check.name === "gateway");
    assert.equal(gateway?.status, "unreachable");
    assert.deepEqual(gateway?.remediation, [
      "openclaw gateway restart",
      "openclaw health --json"
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw diagnostics fail closed for invalid config and a dirty runtime", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-doctor-fail-"));
  const fakeOpenClaw = path.join(tempDir, "openclaw");

  try {
    writeFakeOpenClaw(fakeOpenClaw);

    const result = runOpenClawChainDiagnostics({
      openclawBin: fakeOpenClaw,
      env: {
        AKK_FAKE_SCENARIO: "broken"
      }
    });

    assert.equal(result.ready, false);
    assert.equal(result.package_ready, false);
    assert.equal(
      result.checks.find((check) => check.name === "config")?.status,
      "invalid"
    );
    assert.equal(
      result.checks.find((check) => check.name === "plugin_runtime")?.ok,
      false
    );
    assert.equal(
      result.checks.find((check) => check.name === "skill")?.ok,
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw diagnostics ignore a legacy plugin workspace value", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-legacy-workspace-"));
  const fakeOpenClaw = path.join(tempDir, "openclaw");

  try {
    writeFakeOpenClaw(fakeOpenClaw);

    const result = runOpenClawChainDiagnostics({
      openclawBin: fakeOpenClaw,
      env: {
        AKK_FAKE_WORKSPACE: "relative/legacy-project",
        AKK_FAKE_SCENARIO: "ready"
      }
    });

    assert.equal(result.ready, true, JSON.stringify(result, null, 2));
    assert.equal(result.package_ready, true);
    assert.equal("workspace" in result, false);
    assert.equal(
      result.checks.some((check) => String(check.name) === "workspace"),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeFakeOpenClaw(filePath: string): void {
  fs.writeFileSync(
    filePath,
    `#!${process.execPath}
const args = process.argv.slice(2);
const agent = process.env.AKK_FAKE_AGENT || "codex";
const scenario = process.env.AKK_FAKE_SCENARIO;
const workspace = process.env.AKK_FAKE_WORKSPACE;
const emit = (value, status = 0) => {
  process.stdout.write(JSON.stringify(value));
  process.exit(status);
};
if (args[0] === "config" && args[1] === "validate") {
  if (scenario === "broken") emit({ valid: false, issues: [{ path: "plugins" }] }, 1);
  emit({ valid: true, warnings: [] });
}
if (args[0] === "config" && args[1] === "get") {
  emit({
    enabled: true,
    config: {
      workspace,
      defaultAgent: agent,
      gatewayToken: "do-not-return-this-secret",
      autoApprove: { enabled: true, rules: [] }
    }
  });
}
if (args[0] === "plugins" && args[1] === "inspect") {
  emit({
    plugin: {
      id: "agent-knock-knock",
      source: "/plugin/dist/src/openclaw-plugin.js",
      enabled: true,
      status: scenario === "broken" ? "error" : "loaded"
    },
    diagnostics: scenario === "broken" ? [{ message: "load failed" }] : []
  });
}
if (args[0] === "skills" && args[1] === "info") {
  emit({
    name: "agent-knock-knock",
    eligible: scenario !== "broken",
    disabled: false,
    blockedByAllowlist: scenario === "broken",
    blockedByAgentFilter: false
  });
}
if (args[0] === "health") {
  emit({ ok: scenario !== "gateway_down" }, scenario === "gateway_down" ? 1 : 0);
}
process.stderr.write("unexpected fake OpenClaw command");
process.exit(64);
`,
    "utf8"
  );
  fs.chmodSync(filePath, 0o755);
}
