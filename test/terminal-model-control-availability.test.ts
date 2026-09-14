import assert from "node:assert/strict";
import test from "node:test";

import {
  decideModelControlAvailability,
  type ModelControlSafetyFacts
} from "../src/terminal-model-control-availability.js";
import {
  TERMINAL_MODEL_CONTROL_PROFILE_IDS
} from "../src/terminal-model-control.js";
import type { TerminalControlRef } from
  "../src/terminal-control-ref.js";

const control: TerminalControlRef = {
  kind: "herdr",
  target: "default:w1:p4",
  socketPath: "/tmp/herdr.sock",
  session: "default",
  sessionDir: "/tmp/herdr-session",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-4",
  terminalId: "pty-4",
  panePid: 41,
  currentCommand: "codex",
  currentPath: "/workspace/project",
  capabilities: ["screen_status", "send_keys"]
};

function facts(
  overrides: Partial<ModelControlSafetyFacts> = {}
): ModelControlSafetyFacts {
  return {
    exactTerminalRow: true,
    terminalId: "terminal:v2:herdr:codex:default:w1:p4:42",
    processState: "active",
    terminalControl: control,
    agent: "codex",
    pid: 42,
    processUuid: "process-uuid",
    processBirth: "process-birth",
    agentVersion: "0.154.0",
    behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex,
    nativeAuthority: { kind: "verified_zero_rollout" },
    modelControlSupported: true,
    approvalScanned: true,
    approvalBlocked: false,
    terminalHasInteraction: false,
    terminalHasBlockingTurn: false,
    hasOrphanedDispatch: false,
    surface: { kind: "idle_empty", screenState: "idle" },
    ...overrides
  };
}

test("model-control availability characterizes every advertised surface", () => {
  const cases: Array<{
    name: string;
    facts: ModelControlSafetyFacts;
    expected: ModelControlSafetyFacts["surface"]["kind"] |
      "open_from_empty" | "residual_continuation" | "repair_only" |
      "unavailable";
  }> = [
    {
      name: "zero-rollout empty Codex",
      facts: facts(),
      expected: "open_from_empty"
    },
    {
      name: "exact-session empty Codex",
      facts: facts({
        nativeAuthority: {
          kind: "exact_session",
          ordinaryBindingToken: "ordinary-token"
        }
      }),
      expected: "open_from_empty"
    },
    {
      name: "profiled command popup",
      facts: facts({
        surface: {
          kind: "residual",
          residualKind: "profiled_command_popup",
          residualFingerprint: "a".repeat(64),
          activityState: "unknown"
        }
      }),
      expected: "residual_continuation"
    },
    {
      name: "bare command",
      facts: facts({
        surface: {
          kind: "residual",
          residualKind: "bare_command",
          residualFingerprint: "b".repeat(64),
          activityState: "idle"
        }
      }),
      expected: "residual_continuation"
    },
    {
      name: "open picker",
      facts: facts({
        surface: {
          kind: "residual",
          residualKind: "model_surface",
          residualFingerprint: "c".repeat(64),
          activityState: "unknown"
        }
      }),
      expected: "repair_only"
    },
    {
      name: "open picker owns input despite generic working classification",
      facts: facts({
        surface: {
          kind: "residual",
          residualKind: "model_surface",
          residualFingerprint: "d".repeat(64),
          activityState: "working"
        }
      }),
      expected: "repair_only"
    },
    {
      name: "unknown surface",
      facts: facts({ surface: { kind: "unavailable" } }),
      expected: "unavailable"
    }
  ];
  for (const row of cases) {
    assert.equal(
      decideModelControlAvailability(row.facts).availability,
      row.expected,
      row.name
    );
  }
});

test("exact Claude and Codex open-from-empty use current native authority", () => {
  const ordinaryBindingToken = "ordinary-token";
  const codex = decideModelControlAvailability(facts({
    nativeAuthority: { kind: "exact_session", ordinaryBindingToken }
  }));
  assert.deepEqual(codex, {
    availability: "open_from_empty",
    authority: "native_session",
    terminalId: "terminal:v2:herdr:codex:default:w1:p4:42",
    expectedBindingToken: ordinaryBindingToken
  });

  const claude = decideModelControlAvailability(facts({
    terminalId: "terminal:v2:herdr:claude:default:w1:p4:42",
    terminalControl: { ...control, currentCommand: "claude" },
    agent: "claude",
    agentVersion: "2.1.266",
    behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.claude,
    nativeAuthority: { kind: "exact_session", ordinaryBindingToken }
  }));
  assert.equal(claude.availability, "open_from_empty");
  if (claude.availability === "open_from_empty") {
    assert.equal(claude.authority, "native_session");
    assert.equal(claude.expectedBindingToken, ordinaryBindingToken);
  }
});

test("all empty-entry safety drift closes availability before input", () => {
  const cases: Array<[string, Partial<ModelControlSafetyFacts>]> = [
    ["terminal row", { exactTerminalRow: false }],
    ["process", { processState: "exited" }],
    ["profile", { agentVersion: "0.153.4" }],
    ["transport", {
      terminalControl: { ...control, capabilities: ["screen_status"] }
    }],
    ["native identity", { nativeAuthority: { kind: "unavailable" } }],
    ["screen", { surface: { kind: "idle_empty", screenState: "working" } }],
    ["composer", { surface: { kind: "unavailable" } }],
    ["approval scan", { approvalScanned: false }],
    ["approval", { approvalBlocked: true }],
    ["questionnaire", { terminalHasInteraction: true }],
    ["Turn", { terminalHasBlockingTurn: true }],
    ["input ownership", { hasOrphanedDispatch: true }]
  ];
  for (const [name, drift] of cases) {
    assert.equal(
      decideModelControlAvailability(facts(drift)).availability,
      "unavailable",
      name
    );
  }
});

test("fresh locked facts cannot inherit a stale List allowance", () => {
  const listed = decideModelControlAvailability(facts());
  assert.equal(listed.availability, "open_from_empty");

  const locked = decideModelControlAvailability(facts({
    approvalBlocked: true,
    surface: { kind: "unavailable" }
  }));
  assert.deepEqual(locked, {
    availability: "unavailable",
    reason: "blocked"
  });
});

test("continuation and repair tokens remain surface-bound and separated", () => {
  const first = decideModelControlAvailability(facts({
    surface: {
      kind: "residual",
      residualKind: "bare_command",
      residualFingerprint: "a".repeat(64),
      activityState: "idle"
    }
  }));
  assert.equal(first.availability, "residual_continuation");
  if (first.availability !== "residual_continuation") return;
  assert.notEqual(first.expectedBindingToken, first.repairBindingToken);

  const changed = decideModelControlAvailability(facts({
    surface: {
      kind: "residual",
      residualKind: "bare_command",
      residualFingerprint: "b".repeat(64),
      activityState: "idle"
    }
  }));
  assert.equal(changed.availability, "residual_continuation");
  if (changed.availability !== "residual_continuation") return;
  assert.notEqual(first.expectedBindingToken, changed.expectedBindingToken);
  assert.notEqual(first.repairBindingToken, changed.repairBindingToken);
});
