import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateDoctorCapabilities,
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

test("probe timeout must be positive and finite", () => {
  assert.throws(
    () => runDoctorCapabilityProbes({ timeoutMs: 0 }),
    /positive finite number/
  );
});
