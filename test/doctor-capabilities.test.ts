import test from "node:test";
import assert from "node:assert/strict";
import {
  doctorCodingAgentNativeProfile,
  evaluateDoctorCapabilities,
  runDoctorCapabilityProbes
} from "../src/doctor-capabilities.js";
import {
  codexRuntimeCompatibilityProfile,
  codexRuntimeLifecycleBehaviorProfile,
  codexUnsupportedDurableHistoryWarning
} from "../src/codex-lifecycle-compatibility.js";

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

test("doctor recognizes exact native profiles without gating ordinary readiness", () => {
  assert.equal(
    doctorCodingAgentNativeProfile("codex", "0.153.0"),
    "codex-tui-0.153.0"
  );
  assert.equal(
    doctorCodingAgentNativeProfile("codex", "0.153.4"),
    "codex-tui-0.153.4"
  );
  assert.equal(
    doctorCodingAgentNativeProfile("codex", "0.154.0"),
    "codex-tui-0.154.0"
  );
  assert.equal(
    doctorCodingAgentNativeProfile("codex", "0.155.1"),
    "codex-tui-0.155.1"
  );
  assert.equal(
    doctorCodingAgentNativeProfile("claude", "2.1.259"),
    "claude-code-2.1.259-native-status"
  );
  assert.equal(
    doctorCodingAgentNativeProfile("claude", "2.1.263"),
    "claude-code-2.1.263-native-status"
  );
  assert.equal(
    doctorCodingAgentNativeProfile("claude", "2.1.266"),
    "claude-code-2.1.266-native-status"
  );
  assert.equal(
    doctorCodingAgentNativeProfile("claude", "2.1.267"),
    "claude-code-2.1.267-native-status"
  );
  assert.equal(doctorCodingAgentNativeProfile("codex", "0.150.0"), undefined);
  assert.equal(doctorCodingAgentNativeProfile("codex", "0.153.1"), undefined);
  assert.equal(doctorCodingAgentNativeProfile("codex", "0.153.5"), undefined);
  assert.equal(doctorCodingAgentNativeProfile("codex", "0.154.1"), undefined);
  assert.equal(doctorCodingAgentNativeProfile("codex", "0.155.0"), undefined);
  assert.equal(doctorCodingAgentNativeProfile("claude", "2.1.260"), undefined);
  assert.equal(doctorCodingAgentNativeProfile("claude", "2.1.264"), undefined);
  assert.equal(doctorCodingAgentNativeProfile("claude", "2.1.265"), undefined);
  assert.equal(doctorCodingAgentNativeProfile("claude", "2.1.268"), undefined);

  const result = evaluateDoctorCapabilities([
    { command: "node", available: true, version_supported: true },
    { command: "openclaw", available: true, status: "ok" },
    { command: "tmux", available: true, status: "ok" },
    {
      command: "codex",
      available: true,
      status: "ok",
      native_profile_supported: false
    }
  ]);
  assert.equal(result.readiness, "ready");
  assert.deepEqual(result.tmux.agents, ["codex"]);
});

test("Codex 0.158 and 0.159 have verified profiles while older paginated and unknown versions keep their policy", () => {
  for (const version of ["0.157.0", "0.157.1"]) {
    assert.equal(codexRuntimeLifecycleBehaviorProfile(version), undefined);
    assert.equal(doctorCodingAgentNativeProfile("codex", version), undefined);
    const warning = codexUnsupportedDurableHistoryWarning(version);
    assert.match(warning ?? "", /paginated history/u);
    assert.match(warning ?? "", /Managed completion callbacks.*unavailable/u);
    assert.equal(
      codexRuntimeCompatibilityProfile(version)?.compatibilityWarning,
      warning
    );
  }
  assert.equal(
    codexRuntimeLifecycleBehaviorProfile("0.155.1"),
    "codex-tui-0.155.1"
  );
  assert.equal(
    codexRuntimeLifecycleBehaviorProfile("0.158.0"),
    "codex-tui-0.158.0"
  );
  assert.equal(codexRuntimeLifecycleBehaviorProfile("0.159.0"), "codex-tui-0.159.0");
  for (const version of ["0.158.0", "0.159.0"]) {
    assert.equal(codexUnsupportedDurableHistoryWarning(version), undefined);
  }
  assert.match(
    codexRuntimeCompatibilityProfile("0.160.0")?.compatibilityWarning ?? "",
    /not been regression-tested/u
  );
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
