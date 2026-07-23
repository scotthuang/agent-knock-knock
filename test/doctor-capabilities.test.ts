import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDoctorCapabilities } from "../src/doctor-capabilities.js";

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
  assert.deepEqual(result.tmux.agents, ["claude"]);
  assert.equal(result.acp.available, false);
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
