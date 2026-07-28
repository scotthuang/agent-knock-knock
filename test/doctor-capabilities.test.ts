import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DOCTOR_PROBE_COMMANDS,
  evaluateDoctorCapabilities,
  probeDoctorCommand,
  runDoctorCapabilityProbes
} from "../src/doctor-capabilities.js";

function checks(available: string[]) {
  return ["node", "openclaw", "tmux", "acpx", "codex", "claude", "cursor"]
    .map((command) => ({
      command,
      available: available.includes(command),
      ...(command === "node" ? { version_supported: true } : {})
    }));
}

test("doctor accepts a tmux-only installation without ACPX", () => {
  const result = evaluateDoctorCapabilities(
    checks(["node", "openclaw", "tmux", "claude"])
  );

  assert.equal(result.coreOk, true);
  assert.equal(result.transportOk, true);
  assert.equal(result.tmux.available, true);
  assert.equal(result.tmux.status, "ready");
  assert.deepEqual(result.tmux.agents, ["claude"]);
  assert.equal(result.acp.available, false);
  assert.equal(result.acpx, result.acp);
  assert.equal(result.readiness, "ready");
});

test("doctor accepts ACPX without tmux and rejects an unusable transport", () => {
  const acpOnly = evaluateDoctorCapabilities(
    checks(["node", "openclaw", "acpx", "cursor"])
  );
  assert.equal(acpOnly.transportOk, true);
  assert.equal(acpOnly.tmux.available, false);
  assert.equal(acpOnly.acp.available, true);
  assert.deepEqual(acpOnly.acp.agents, ["cursor"]);

  const unusable = evaluateDoctorCapabilities(
    checks(["node", "openclaw", "tmux", "cursor"])
  );
  assert.equal(unusable.transportOk, false);
  assert.equal(unusable.tmux.available, false);
  assert.equal(unusable.acp.available, false);
});

test("doctor reports readiness for the selected execution mode", () => {
  const installed = checks(["node", "openclaw", "tmux", "codex"]);

  const tmux = evaluateDoctorCapabilities(installed, "tmux");
  assert.equal(tmux.mode, "tmux");
  assert.equal(tmux.readiness, "ready");
  assert.deepEqual(tmux.tmux.missing, []);

  const acpx = evaluateDoctorCapabilities(installed, "acpx");
  assert.equal(acpx.readiness, "partially_ready");
  assert.deepEqual(acpx.acpx.missing, ["acpx"]);

  const nothing = evaluateDoctorCapabilities(checks(["node"]), "all");
  assert.equal(nothing.readiness, "not_ready");
  assert.equal(nothing.tmux.status, "not_ready");
  assert.equal(nothing.acpx.status, "not_ready");
});

test("failed OpenClaw execution cannot produce a ready result", () => {
  const result = evaluateDoctorCapabilities([
    { command: "node", available: true, version_supported: true },
    { command: "openclaw", available: false, status: "version_failed" },
    { command: "tmux", available: true, status: "ok" },
    { command: "codex", available: true, status: "ok" }
  ], "tmux");

  assert.equal(result.coreOk, false);
  assert.equal(result.readiness, "partially_ready");
  assert.deepEqual(result.tmux.missing, ["openclaw"]);
});

test("doctor capability evaluation fails closed without an explicit supported Node check", () => {
  const result = evaluateDoctorCapabilities([
    { command: "openclaw", available: true, status: "ok" },
    { command: "tmux", available: true, status: "ok" },
    { command: "codex", available: true, status: "ok" }
  ], "tmux");

  assert.equal(result.coreOk, false);
  assert.notEqual(result.readiness, "ready");
  assert.deepEqual(result.tmux.missing, ["node"]);
});

test("real probes accept supported version output without invoking a shell", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-doctor-probes-"));

  try {
    const versions = {
      openclaw: "OpenClaw 2026.7.1-2",
      tmux: "tmux 3.5a",
      acpx: "acpx 0.1.15",
      codex: "codex-cli 0.107.0",
      claude: "2.1.15 (Claude Code)",
      cursor: "Cursor 2.4.0"
    };
    const executables = Object.fromEntries(
      DOCTOR_PROBE_COMMANDS.map((command) => {
        const expectedArgument = command === "tmux" ? "-V" : "--version";
        return [
          command,
          writeFakeExecutable(
            tempDir,
            command,
            `
if (process.argv[2] !== ${JSON.stringify(expectedArgument)}) process.exit(23);
process.stdout.write(${JSON.stringify(versions[command])});
`
          )
        ];
      })
    );

    const probes = runDoctorCapabilityProbes({ executables });

    assert.deepEqual(probes.map((probe) => probe.command), DOCTOR_PROBE_COMMANDS);
    assert.equal(probes.every((probe) => probe.status === "ok"), true);
    assert.deepEqual(
      probes.map((probe) => probe.version),
      ["2026.7.1-2", "3.5a", "0.1.15", "0.107.0", "2.1.15", "2.4.0"]
    );
    assert.equal(probes.every((probe) => probe.available), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Cursor probes the ACP-capable cursor-agent binary by default", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-doctor-cursor-agent-"));
  const cursorAgent = writeFakeExecutable(
    tempDir,
    "cursor-agent",
    `process.stdout.write("2026.06.19-20-24-33-653a7fb");`
  );

  try {
    const probe = probeDoctorCommand("cursor", {
      env: {
        PATH: tempDir
      }
    });
    assert.equal(probe.executable, "cursor-agent");
    assert.equal(probe.status, "ok");
    assert.equal(probe.version, "2026.06.19-20-24-33-653a7fb");
    assert.equal(cursorAgent, path.join(tempDir, "cursor-agent"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("mode-specific probe runs skip unrelated transports and agents", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-doctor-mode-probes-"));
  const executables = {
    openclaw: writeFakeExecutable(tempDir, "openclaw", `process.stdout.write("2026.7.1-2");`),
    tmux: writeFakeExecutable(tempDir, "tmux", `process.stdout.write("tmux 3.5a");`),
    codex: writeFakeExecutable(tempDir, "codex", `process.stdout.write("0.107.0");`),
    claude: writeFakeExecutable(tempDir, "claude", `process.stdout.write("2.1.218");`),
    acpx: path.join(tempDir, "must-not-run-acpx"),
    cursor: path.join(tempDir, "must-not-run-cursor")
  };

  try {
    const probes = runDoctorCapabilityProbes({ executables }, "tmux");
    assert.deepEqual(
      probes.map((probe) => probe.command),
      ["openclaw", "tmux", "codex", "claude"]
    );
    assert.equal(probes.every((probe) => probe.status === "ok"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("real probes distinguish every required failure class", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-doctor-failures-"));

  try {
    const notExecutable = writeFakeExecutable(
      tempDir,
      "not-executable",
      `process.stdout.write("tmux 3.5");`,
      false
    );
    const versionFailed = writeShellExecutable(
      tempDir,
      "version-failed",
      `printf '%s' 'cannot load runtime' >&2
exit 9`
    );
    const timeout = writeShellExecutable(
      tempDir,
      "timeout",
      `while :; do :; done`
    );
    const malformed = writeShellExecutable(
      tempDir,
      "malformed",
      `printf '%s' 'Claude Code is installed'`
    );
    const working = writeShellExecutable(
      tempDir,
      "working",
      `printf '%s' 'Cursor 2.4.0'`
    );
    const probes = runDoctorCapabilityProbes({
      timeoutMs: 5_000,
      executables: {
        openclaw: path.join(tempDir, "missing-openclaw"),
        tmux: notExecutable,
        acpx: versionFailed,
        codex: working,
        claude: malformed,
        cursor: working
      }
    });
    const timeoutProbe = probeDoctorCommand("codex", {
      timeoutMs: 1_000,
      executables: { codex: timeout }
    });
    const byCommand = new Map(probes.map((probe) => [probe.command, probe]));

    assert.equal(byCommand.get("openclaw")?.status, "not_found");
    assert.equal(byCommand.get("tmux")?.status, "not_executable");
    assert.equal(byCommand.get("acpx")?.status, "version_failed");
    assert.equal(byCommand.get("codex")?.status, "ok");
    assert.equal(timeoutProbe.status, "timeout");
    assert.equal(byCommand.get("claude")?.status, "malformed_output");
    assert.equal(byCommand.get("cursor")?.status, "ok");
    assert.equal(probes.filter((probe) => probe.available).length, 2);
    assert.match(byCommand.get("acpx")?.error ?? "", /cannot load runtime/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("probe timeout must be positive and finite", () => {
  assert.throws(
    () => runDoctorCapabilityProbes({ timeoutMs: 0 }),
    /positive finite number/
  );
});

function writeFakeExecutable(
  directory: string,
  name: string,
  body: string,
  executable = true
): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `#!${process.execPath}\n${body}\n`, "utf8");
  fs.chmodSync(filePath, executable ? 0o755 : 0o644);
  return filePath;
}

function writeShellExecutable(
  directory: string,
  name: string,
  body: string
): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `#!/bin/sh\n${body}\n`, "utf8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}
