import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_MODEL_CONTROL_AGENT_VERSION,
  CODEX_MODEL_CONTROL_AGENT_VERSION,
  TERMINAL_MODEL_CONTROL_PROFILE_IDS,
  canonicalModelControlSubject,
  isTerminalModelControlPlanForAgent,
  planTerminalModelControl,
  probeTerminalModelControl,
  terminalModelControlPlanConforms,
  terminalModelControlProfiles,
  terminalModelControlAllowsStyledSlashPopupWithoutViewportPaint,
  terminalModelControlSlashCompletionRows,
  terminalUserExplicitModelControlBindingToken,
  terminalUserExplicitModelControlRepairBindingToken,
  terminalUserExplicitModelControlResidualEntryBindingToken,
  type TerminalModelControlCapabilities
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

test("model-control registry is the canonical verified profile catalog", () => {
  assert.deepEqual(
    terminalModelControlProfiles().map((profile) => ({
      agent: profile.agent,
      agentVersion: profile.agentVersion,
      behaviorProfile: profile.behaviorProfile,
      plan: profile.plan,
      zeroRollout: profile.supportsZeroRolloutPhysicalAuthority,
      residualContinuation: profile.supportsResidualContinuation,
      residualRepair: profile.supportsResidualRepair,
      slashCompletionRows: profile.slashCompletionRows,
      styledPopupWithoutViewportPaint:
        profile.allowsStyledSlashPopupWithoutViewportPaint
    })),
    [
      {
        agent: "codex",
        agentVersion: CODEX_MODEL_CONTROL_AGENT_VERSION,
        behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex,
        plan: {
          behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex,
          command: "/model",
          scope: "current_and_new_sessions",
          requiresIdle: true,
          requiresExactEmptyComposer: true
        },
        zeroRollout: true,
        residualContinuation: true,
        residualRepair: true,
        slashCompletionRows: [
          "  /model  choose what model and reasoning effort to use"
        ],
        styledPopupWithoutViewportPaint: false
      },
      {
        agent: "codex",
        agentVersion: "0.155.1",
        behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex01551,
        plan: {
          behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex01551,
          command: "/model",
          scope: "current_and_new_sessions",
          requiresIdle: true,
          requiresExactEmptyComposer: true
        },
        zeroRollout: true,
        residualContinuation: true,
        residualRepair: true,
        slashCompletionRows: [
          "  /model  choose what model and reasoning effort to use"
        ],
        styledPopupWithoutViewportPaint: true
      },
      {
        agent: "claude",
        agentVersion: CLAUDE_MODEL_CONTROL_AGENT_VERSION,
        behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.claude,
        plan: {
          behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.claude,
          command: "/model",
          scope: "current_session",
          requiresIdle: true,
          requiresExactEmptyComposer: true
        },
        zeroRollout: false,
        residualContinuation: false,
        residualRepair: false,
        slashCompletionRows: [],
        styledPopupWithoutViewportPaint: false
      }
    ]
  );
});

test("probe, planning, slash conformance, and execution conformance share the registry", () => {
  for (const profile of terminalModelControlProfiles()) {
    const capabilities = probeTerminalModelControl(
      profile.agent,
      profile.agentVersion
    );
    const plan = planTerminalModelControl(capabilities);
    assert.strictEqual(plan, profile.plan);
    assert.equal(isTerminalModelControlPlanForAgent(plan, profile.agent), true);
    assert.equal(terminalModelControlPlanConforms({
      agent: profile.agent,
      agentVersion: profile.agentVersion,
      plan
    }), true);
    assert.deepEqual(
      terminalModelControlSlashCompletionRows(plan),
      profile.slashCompletionRows
    );
    assert.equal(
      terminalModelControlAllowsStyledSlashPopupWithoutViewportPaint(plan),
      profile.allowsStyledSlashPopupWithoutViewportPaint
    );
  }

  assert.equal(probeTerminalModelControl("codex", "0.154.1").status,
    "unsupported");
  assert.equal(probeTerminalModelControl("codex", "0.155.0").status,
    "unsupported");
  assert.equal(probeTerminalModelControl("codex", "0.155.2").status,
    "unsupported");
  assert.equal(probeTerminalModelControl("claude", "2.1.267").status,
    "unsupported");
  assert.equal(probeTerminalModelControl("codex", "  ").status, "unknown");
  const { agentVersion: _agentVersion, ...legacyCapabilities } =
    probeTerminalModelControl("codex", CODEX_MODEL_CONTROL_AGENT_VERSION);
  assert.strictEqual(
    planTerminalModelControl(legacyCapabilities),
    terminalModelControlProfiles()[0].plan,
    "legacy callers without the additive agentVersion retain canonical planning"
  );
  assert.throws(
    () => planTerminalModelControl({
      status: "supported",
      agentVersion: CODEX_MODEL_CONTROL_AGENT_VERSION,
      behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.claude,
      scope: "current_session",
      modelSelection: true,
      reasoningEffortSelection: true,
      reason: "spoofed cross-agent profile"
    } satisfies TerminalModelControlCapabilities),
    /unprofiled terminal model-control plan/u
  );
});

test("canonical model-control subject normalizes projection and mutation identity", () => {
  const subject = canonicalModelControlSubject({
    terminalId: "  terminal:v2:herdr:codex:default:w1:p4:42  ",
    terminalControl: control,
    agent: "codex",
    pid: 42,
    workspace: "  /workspace/project  ",
    processUuid: "  process-uuid  ",
    processBirth: "  process-birth  ",
    agentVersion: ` ${CODEX_MODEL_CONTROL_AGENT_VERSION} `,
    behaviorProfile: ` ${TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex} `
  });
  assert.ok(subject);
  assert.deepEqual({
    terminalId: subject.terminalId,
    agent: subject.agent,
    pid: subject.pid,
    workspace: subject.workspace,
    processUuid: subject.processUuid,
    processBirth: subject.processBirth,
    agentVersion: subject.agentVersion,
    behaviorProfile: subject.behaviorProfile,
    processAnchorPid: subject.terminalProcessAnchorPid
  }, {
    terminalId: "terminal:v2:herdr:codex:default:w1:p4:42",
    agent: "codex",
    pid: 42,
    workspace: "/workspace/project",
    processUuid: "process-uuid",
    processBirth: "process-birth",
    agentVersion: CODEX_MODEL_CONTROL_AGENT_VERSION,
    behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex,
    processAnchorPid: 41
  });

  const paddedToken = terminalUserExplicitModelControlBindingToken({
    terminalId: "  terminal:v2:herdr:codex:default:w1:p4:42  ",
    terminalControl: control,
    pid: 42,
    workspace: "  /workspace/project  ",
    processUuid: "  process-uuid  ",
    processBirth: "  process-birth  ",
    agentVersion: ` ${CODEX_MODEL_CONTROL_AGENT_VERSION} `,
    behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex
  });
  const canonicalToken = terminalUserExplicitModelControlBindingToken({
    terminalId: subject.terminalId,
    terminalControl: subject.terminalControl,
    pid: subject.pid,
    workspace: subject.workspace,
    processUuid: subject.processUuid,
    processBirth: subject.processBirth,
    agentVersion: subject.agentVersion,
    behaviorProfile: subject.behaviorProfile
  });
  assert.equal(paddedToken, canonicalToken);
});

test("canonical subject rejects profile, process, and endpoint mismatches closed", () => {
  const common = {
    terminalId: "terminal-1",
    terminalControl: control,
    agent: "codex" as const,
    pid: 42,
    workspace: "/workspace/project",
    processUuid: "process-uuid",
    processBirth: "process-birth",
    agentVersion: CODEX_MODEL_CONTROL_AGENT_VERSION,
    behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex
  };
  assert.equal(canonicalModelControlSubject({
    ...common,
    behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.claude
  }), undefined);
  assert.equal(canonicalModelControlSubject({ ...common, pid: 1 }), undefined);
  assert.equal(canonicalModelControlSubject({
    ...common,
    terminalControl: { ...control, socketPath: undefined }
  }), undefined);
  assert.throws(
    () => terminalUserExplicitModelControlBindingToken({
      ...common,
      agentVersion: "0.154.1"
    }),
    /canonical supported terminal subject/u
  );
});

test("ordinary, residual-entry, and repair authority remain domain-separated", () => {
  const common = {
    terminalId: "terminal-1",
    terminalControl: control,
    pid: 42,
    workspace: "/workspace/project",
    processUuid: "process-uuid",
    processBirth: "process-birth",
    agentVersion: CODEX_MODEL_CONTROL_AGENT_VERSION,
    behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex
  };
  const ordinary = terminalUserExplicitModelControlBindingToken(common);
  const residual = terminalUserExplicitModelControlResidualEntryBindingToken({
    ...common,
    residualKind: "bare_command",
    residualFingerprint: "surface-a"
  });
  const repair = terminalUserExplicitModelControlRepairBindingToken({
    ...common,
    residualKind: "bare_command",
    residualFingerprint: "surface-a"
  });
  assert.equal(new Set([ordinary, residual, repair]).size, 3);
});
