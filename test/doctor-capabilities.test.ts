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
  return ["node", "openclaw", "tmux", "herdr", "codex", "claude"]
    .map((command) => ({
      command,
      available: available.includes(command),
      ...(command === "node" ? { version_supported: true } : {})
    }));
}

test("doctor accepts a tmux installation with either supported coding agent", () => {
  const result = evaluateDoctorCapabilities(
    checks(["node", "openclaw", "tmux", "claude"])
  );

  assert.equal(result.coreOk, true);
  assert.equal(result.transportOk, true);
  assert.equal(result.tmux.available, true);
  assert.equal(result.tmux.status, "ready");
  assert.deepEqual(result.tmux.agents, ["claude"]);
  assert.deepEqual(result.available_transports, ["tmux"]);
  assert.equal(result.mode, "tmux");
  assert.equal(result.readiness, "ready");
});

test("doctor accepts exact Herdr 0.8.0 as the only terminal transport", () => {
  const result = evaluateDoctorCapabilities([
    { command: "node", available: true, version_supported: true },
    { command: "openclaw", available: true, status: "ok" },
    { command: "tmux", available: false, status: "not_found" },
    {
      command: "herdr",
      available: true,
      status: "ok",
      version_supported: true
    },
    { command: "codex", available: true, status: "ok" }
  ]);

  assert.equal(result.coreOk, true);
  assert.equal(result.transportOk, true);
  assert.equal(result.tmux.available, false);
  assert.equal(result.herdr.available, true);
  assert.equal(result.herdr.version_supported, true);
  assert.deepEqual(result.herdr.missing, []);
  assert.deepEqual(result.available_transports, ["herdr"]);
  assert.equal(result.mode, "tmux");
  assert.equal(result.readiness, "ready");
});

test("doctor fails closed for a non-exact Herdr version", () => {
  const result = evaluateDoctorCapabilities([
    { command: "node", available: true, version_supported: true },
    { command: "openclaw", available: true, status: "ok" },
    {
      command: "herdr",
      available: true,
      status: "ok",
      version_supported: false
    },
    { command: "claude", available: true, status: "ok" }
  ]);

  assert.equal(result.transportOk, false);
  assert.equal(result.herdr.available, false);
  assert.equal(result.herdr.version_supported, false);
  assert.equal(result.herdr.status, "partially_ready");
  assert.deepEqual(result.herdr.missing, ["herdr 0.8.0"]);
  assert.deepEqual(result.available_transports, []);
  assert.equal(result.readiness, "partially_ready");
});

test("doctor rejects missing tmux or a missing supported coding agent", () => {
  const withoutTmux = evaluateDoctorCapabilities(
    checks(["node", "openclaw", "codex"])
  );
  assert.equal(withoutTmux.transportOk, false);
  assert.equal(withoutTmux.tmux.available, false);
  assert.deepEqual(withoutTmux.tmux.missing, ["tmux"]);

  const withoutAgent = evaluateDoctorCapabilities(
    checks(["node", "openclaw", "tmux"])
  );
  assert.equal(withoutAgent.transportOk, false);
  assert.equal(withoutAgent.tmux.available, false);
  assert.deepEqual(withoutAgent.tmux.missing, ["codex or claude"]);
});

test("doctor reports tmux readiness", () => {
  const installed = checks(["node", "openclaw", "tmux", "codex"]);

  const tmux = evaluateDoctorCapabilities(installed);
  assert.equal(tmux.mode, "tmux");
  assert.equal(tmux.readiness, "ready");
  assert.deepEqual(tmux.tmux.missing, []);

  const nothing = evaluateDoctorCapabilities(checks(["node"]));
  assert.equal(nothing.readiness, "not_ready");
  assert.equal(nothing.tmux.status, "not_ready");
});

test("failed OpenClaw execution cannot produce a ready result", () => {
  const result = evaluateDoctorCapabilities([
    { command: "node", available: true, version_supported: true },
    { command: "openclaw", available: false, status: "version_failed" },
    { command: "tmux", available: true, status: "ok" },
    { command: "codex", available: true, status: "ok" }
  ]);

  assert.equal(result.coreOk, false);
  assert.equal(result.readiness, "partially_ready");
  assert.deepEqual(result.tmux.missing, ["openclaw"]);
});

test("doctor capability evaluation fails closed without an explicit supported Node check", () => {
  const result = evaluateDoctorCapabilities([
    { command: "openclaw", available: true, status: "ok" },
    { command: "tmux", available: true, status: "ok" },
    { command: "codex", available: true, status: "ok" }
  ]);

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
      herdr: "herdr 0.8.0",
      codex: "codex-cli 0.107.0",
      claude: "2.1.15 (Claude Code)"
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
      ["2026.7.1-2", "3.5a", "0.8.0", "0.107.0", "2.1.15"]
    );
    assert.equal(probes.every((probe) => probe.available), true);
    assert.equal(
      probes.find((probe) => probe.command === "herdr")?.version_supported,
      true
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("doctor probes both terminal transports and their supported coding agents", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-doctor-tmux-probes-"));
  const executables = {
    openclaw: writeFakeExecutable(tempDir, "openclaw", `process.stdout.write("2026.7.1-2");`),
    tmux: writeFakeExecutable(tempDir, "tmux", `process.stdout.write("tmux 3.5a");`),
    herdr: writeFakeExecutable(tempDir, "herdr", `process.stdout.write("herdr 0.8.0");`),
    codex: writeFakeExecutable(tempDir, "codex", `process.stdout.write("0.107.0");`),
    claude: writeFakeExecutable(tempDir, "claude", `process.stdout.write("2.1.218");`)
  };

  try {
    const probes = runDoctorCapabilityProbes({ executables });
    assert.deepEqual(
      probes.map((probe) => probe.command),
      ["openclaw", "tmux", "herdr", "codex", "claude"]
    );
    assert.equal(probes.every((probe) => probe.status === "ok"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Herdr probe marks only exact 0.8.0 as version supported", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-doctor-herdr-version-"));
  try {
    const exact = probeDoctorCommand("herdr", {
      executables: {
        herdr: writeFakeExecutable(
          tempDir,
          "herdr-exact",
          `process.stdout.write("herdr 0.8.0");`
        )
      }
    });
    const newer = probeDoctorCommand("herdr", {
      executables: {
        herdr: writeFakeExecutable(
          tempDir,
          "herdr-newer",
          `process.stdout.write("herdr 0.8.1");`
        )
      }
    });

    assert.equal(exact.status, "ok");
    assert.equal(exact.version_supported, true);
    assert.equal(newer.status, "ok");
    assert.equal(newer.available, true);
    assert.equal(newer.version_supported, false);
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
      `printf '%s' 'Codex 0.107.0'`
    );
    const probes = runDoctorCapabilityProbes({
      timeoutMs: 5_000,
      executables: {
        openclaw: path.join(tempDir, "missing-openclaw"),
        tmux: notExecutable,
        herdr: path.join(tempDir, "missing-herdr"),
        codex: working,
        claude: malformed
      }
    });
    const timeoutProbe = probeDoctorCommand("codex", {
      timeoutMs: 1_000,
      executables: { codex: timeout }
    });
    const versionFailedProbe = probeDoctorCommand("codex", {
      executables: { codex: versionFailed }
    });
    const byCommand = new Map(probes.map((probe) => [probe.command, probe]));

    assert.equal(byCommand.get("openclaw")?.status, "not_found");
    assert.equal(byCommand.get("tmux")?.status, "not_executable");
    assert.equal(byCommand.get("herdr")?.status, "not_found");
    assert.equal(byCommand.get("codex")?.status, "ok");
    assert.equal(timeoutProbe.status, "timeout");
    assert.equal(versionFailedProbe.status, "version_failed");
    assert.equal(byCommand.get("claude")?.status, "malformed_output");
    assert.equal(probes.filter((probe) => probe.available).length, 1);
    assert.match(versionFailedProbe.error ?? "", /cannot load runtime/);
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
