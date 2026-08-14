import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeTranscriptApprovalIdentity,
  decideTerminalMonitorAfterEffectsTimeout,
  decideTerminalMonitorApproval,
  decideTerminalMonitorVerifiedDeadCompletion,
  reduceTerminalMonitorDecision,
  terminalMonitorActivityPersistIntervalMs,
  terminalMonitorApprovalCandidate,
  terminalMonitorApprovalEffectOrder,
  terminalMonitorApprovalFingerprint
} from "../src/terminal-monitor-decision-policy.js";
import type { TerminalBridgeStatus } from "../src/terminal-agent-bridge.js";
import type { TerminalControlRef } from "../src/terminal-control-ref.js";

const terminalControl: TerminalControlRef = {
  kind: "tmux",
  target: "akk:0.1",
  session: "akk",
  window: 0,
  pane: 1,
  panePid: 4200,
  currentPath: "/repo/project",
  capabilities: ["screen_status", "terminal_approval"]
};

function terminalStatus(
  approval: Partial<TerminalBridgeStatus["approval_state"]> = {}
): TerminalBridgeStatus {
  return {
    provider: "tmux",
    target: terminalControl.target,
    agent: "claude",
    reachable: true,
    capabilities: {
      processDiscovery: true,
      screenStatus: true,
      terminalApproval: true,
      screenCompletion: true,
      durableCompletion: true,
      cancellation: true
    },
    activity_state: "awaiting_approval",
    activity_reason: "permission prompt",
    approval_state: {
      scanned: true,
      blocked: false,
      approvable: false,
      ...approval
    },
    screen: { excerpt: "Allow?", digest: "screen-current" }
  };
}

function approvalInput(overrides: Record<string, unknown> = {}) {
  return {
    executorKind: "claude" as const,
    executorDisplayName: "Claude Code",
    terminalReachable: true,
    approval: terminalStatus().approval_state,
    nativeTakeover: {},
    currentMessageId: "message-1",
    currentScreenFingerprint: "screen-current",
    currentScreenChangedSinceSend: true,
    ...overrides
  };
}

test("approval decision table preserves clear, suppression, question, and error precedence", () => {
  const cases = [
    {
      name: "resolved prompt clears once",
      input: approvalInput({
        nativeTakeover: {
          terminal_bridge_last_approval_message_id: "message-1",
          terminal_bridge_approval_resolved_at: "2026-08-14T03:04:05.000Z"
        }
      }),
      expected: {
        markPromptCleared: true,
        suppressions: [],
        notification: { kind: "none" }
      }
    },
    {
      name: "unchanged Claude key screen suppresses",
      input: approvalInput({
        approval: terminalStatus({
          blocked: true,
          approvable: true,
          decision_mode: "keys",
          fingerprint: "approval-1"
        }).approval_state,
        currentScreenChangedSinceSend: false,
        observedFingerprint: "approval-1"
      }),
      expected: {
        markPromptCleared: false,
        suppressions: [{ kind: "screen_not_new" }],
        notification: { kind: "none" }
      }
    },
    {
      name: "consumed transcript request suppresses",
      input: approvalInput({
        approval: terminalStatus({
          blocked: true,
          approvable: true,
          decision_mode: "keys",
          prompt_kind: "claude_permission",
          fingerprint: "approval-2"
        }).approval_state,
        nativeTakeover: {
          terminal_bridge_last_approval_message_id: "message-1",
          terminal_bridge_last_approval_request_id: "request-1"
        },
        transcriptIdentity: {
          requestId: "request-1",
          evidenceFingerprint: "evidence-1"
        },
        observedFingerprint: "approval-2"
      }),
      expected: {
        markPromptCleared: false,
        suppressions: [{
          kind: "consumed_screen",
          reason: "same_transcript_request",
          fingerprint: "approval-2",
          screenDigest: "screen-current"
        }],
        notification: { kind: "none" }
      }
    },
    {
      name: "same unrepainted consumed screen suppresses",
      input: approvalInput({
        approval: terminalStatus({
          blocked: true,
          approvable: true,
          decision_mode: "keys",
          prompt_kind: "claude_permission",
          fingerprint: "approval-2"
        }).approval_state,
        nativeTakeover: {
          terminal_bridge_last_approval_message_id: "message-1",
          terminal_bridge_last_approval_screen_digest: "screen-current"
        },
        observedFingerprint: "approval-2"
      }),
      expected: {
        markPromptCleared: false,
        suppressions: [{
          kind: "consumed_screen",
          reason: "same_unrepainted_screen",
          fingerprint: "approval-2",
          screenDigest: "screen-current"
        }],
        notification: { kind: "none" }
      }
    },
    {
      name: "uncleared consumed fingerprint suppresses",
      input: approvalInput({
        approval: terminalStatus({
          blocked: true,
          approvable: true,
          decision_mode: "keys",
          prompt_kind: "claude_permission",
          fingerprint: "approval-2"
        }).approval_state,
        nativeTakeover: {
          terminal_bridge_last_approval_message_id: "message-1",
          terminal_bridge_last_approval_request_id: "request-old",
          terminal_bridge_last_approval_fingerprint: "approval-old"
        },
        observedFingerprint: "approval-2"
      }),
      expected: {
        markPromptCleared: false,
        suppressions: [{
          kind: "consumed_screen",
          reason: "prompt_not_observed_cleared",
          fingerprint: "approval-2",
          screenDigest: "screen-current"
        }],
        notification: { kind: "none" }
      }
    },
    {
      name: "legacy consumed fingerprint suppresses",
      input: approvalInput({
        approval: terminalStatus({
          blocked: true,
          approvable: true,
          decision_mode: "keys",
          prompt_kind: "claude_permission",
          fingerprint: "approval-legacy"
        }).approval_state,
        nativeTakeover: {
          terminal_bridge_last_approval_message_id: "message-1",
          terminal_bridge_last_approval_fingerprint: "approval-legacy"
        },
        observedFingerprint: "approval-legacy"
      }),
      expected: {
        markPromptCleared: false,
        suppressions: [{
          kind: "consumed_screen",
          reason: "legacy_consumed_approval",
          fingerprint: "approval-legacy",
          screenDigest: "screen-current"
        }],
        notification: { kind: "none" }
      }
    },
    {
      name: "approvable prompt becomes question",
      input: approvalInput({
        executorKind: "codex",
        executorDisplayName: "Codex",
        approval: terminalStatus({
          blocked: true,
          approvable: true,
          fingerprint: "approval-3"
        }).approval_state
      }),
      expected: {
        markPromptCleared: false,
        suppressions: [],
        notification: { kind: "question" }
      }
    },
    {
      name: "unapprovable prompt becomes explicit error",
      input: approvalInput({
        approval: terminalStatus({
          blocked: true,
          approvable: false,
          reason: "manual review required"
        }).approval_state
      }),
      expected: {
        markPromptCleared: false,
        suppressions: [],
        notification: { kind: "error", reason: "manual review required" }
      }
    },
    {
      name: "truthy non-boolean approvable fails closed",
      input: approvalInput({
        approval: {
          blocked: true,
          approvable: "true",
          reason: "malformed approval evidence"
        }
      }),
      expected: {
        markPromptCleared: false,
        suppressions: [],
        notification: {
          kind: "error",
          reason: "malformed approval evidence"
        }
      }
    },
    {
      name: "missing exact key evidence fails closed as error",
      input: approvalInput({
        approval: terminalStatus({
          blocked: true,
          approvable: true,
          decision_mode: "keys"
        }).approval_state
      }),
      expected: {
        markPromptCleared: false,
        suppressions: [],
        notification: {
          kind: "error",
          reason: "Claude Code approval prompt lacks exact prompt-region evidence"
        }
      }
    }
  ];
  for (const row of cases) {
    assert.deepEqual(decideTerminalMonitorApproval(row.input), row.expected, row.name);
  }
});

test("approval effect plans retain branch-specific durable order", () => {
  assert.deepEqual(terminalMonitorApprovalEffectOrder("error"), [
    "event",
    "fingerprint",
    "record"
  ]);
  assert.deepEqual(terminalMonitorApprovalEffectOrder("question"), [
    "fingerprint",
    "event",
    "record"
  ]);
});

test("monitor reduction orders activity, completion, and death before fresh timeout", () => {
  const base = {
    state: { previousScreenFingerprint: "screen-1" },
    completionPresent: true
  };
  const rows = [
    {
      name: "stable completion wins at hard deadline",
      input: {
        ...base,
        state: {
          previousScreenFingerprint: "screen-1",
          previousCompletionFingerprint: "completion-1"
        },
        completionFingerprint: "completion-1"
      },
      kind: "complete"
    },
    {
      name: "death verification precedes hard timeout",
      input: { ...base, completionPresent: false },
      kind: "verify_dead"
    },
    {
      name: "first completion prevents death but not inactivity",
      input: {
        ...base,
        completionFingerprint: "completion-1"
      },
      kind: "check_timeout"
    },
    {
      name: "fresh activity extends inactivity",
      input: {
        ...base,
        activityState: "working",
        activityReason: "agent is working",
        completionFingerprint: "completion-1"
      },
      kind: "check_timeout"
    },
    {
      name: "ordinary poll has no terminal action",
      input: {
        ...base,
        completionFingerprint: "completion-1"
      },
      kind: "check_timeout"
    }
  ];
  for (const row of rows) {
    const decision = reduceTerminalMonitorDecision(row.input);
    assert.equal(decision.next.kind, row.kind, row.name);
  }
});

test("fresh timeout classification happens only after verified-dead work returns", () => {
  const trace: string[] = [];
  const first = reduceTerminalMonitorDecision({
    state: { previousScreenFingerprint: undefined },
    completionPresent: false
  });
  assert.equal(first.next.kind, "verify_dead");
  trace.push("verified_dead_return");
  const timeout = decideTerminalMonitorAfterEffectsTimeout({
    nowMs: (() => {
      trace.push("read_now");
      return 60_000;
    })(),
    taskStartedAtMs: 0,
    lastActivityAtMs: 0,
    hardTimeoutMinutes: 1,
    inactivityTimeoutMinutes: 1
  });
  trace.push("timeout_decided");
  assert.deepEqual(trace, [
    "verified_dead_return",
    "read_now",
    "timeout_decided"
  ]);
  assert.equal(timeout.kind, "hard_timeout");
  assert.equal(decideTerminalMonitorAfterEffectsTimeout({
    nowMs: 60_000,
    taskStartedAtMs: 0,
    lastActivityAtMs: 30_000,
    hardTimeoutMinutes: 10,
    inactivityTimeoutMinutes: 0.5
  }).kind, "inactivity_timeout");
  assert.deepEqual(decideTerminalMonitorAfterEffectsTimeout({
    nowMs: 1,
    taskStartedAtMs: 0,
    lastActivityAtMs: 0,
    hardTimeoutMinutes: 10,
    inactivityTimeoutMinutes: 10
  }), { kind: "poll" });
});

test("verified-dead completion delegation preserves present, absent, and unverifiable outcomes", () => {
  assert.deepEqual(decideTerminalMonitorVerifiedDeadCompletion({
    status: "present",
    completion: "done"
  }), { action: "complete", completion: "done" });
  assert.deepEqual(decideTerminalMonitorVerifiedDeadCompletion({ status: "absent" }), {
    action: "stall",
    completionObservation: "absent",
    resultReason: "bound_agent_process_verified_dead"
  });
  assert.deepEqual(decideTerminalMonitorVerifiedDeadCompletion({
    status: "unverifiable",
    reason: "transcript unavailable"
  }), {
    action: "stall",
    completionObservation: "unverifiable",
    resultReason: "bound_agent_process_verified_dead_completion_unverifiable"
  });
});

test("approval facts retain stable identity, privacy, and fallback fingerprint", () => {
  const evidenceFingerprint = "a".repeat(64);
  assert.deepEqual(claudeTranscriptApprovalIdentity({
    policy_evidence: {
      source: "claude_transcript",
      kind: "run_command",
      request_id: "request-1",
      evidence_fingerprint: evidenceFingerprint
    }
  }), { requestId: "request-1", evidenceFingerprint });
  assert.equal(claudeTranscriptApprovalIdentity({}), undefined);

  const local = terminalStatus({
    blocked: true,
    approvable: true,
    prompt_kind: "claude_permission",
    command: "secret command",
    policy_evidence: {
      source: "claude_transcript",
      kind: "run_command",
      command_sha256: "command-hash",
      evidence_fingerprint: evidenceFingerprint,
      request_id: "request-1"
    }
  });
  const candidate = terminalMonitorApprovalCandidate({
    executorKind: "claude",
    terminalControl,
    terminalStatus: local,
    fingerprint: "approval-1"
  });
  assert.deepEqual(candidate, {
    agent: "claude",
    kind: "run_command",
    command: undefined,
    tool_name: undefined,
    request_detail: undefined,
    cwd: "/repo/project",
    fingerprint: "approval-1",
    terminal_target: "akk:0.1",
    decision_mode: undefined,
    command_source: "executor_local",
    policy_evidence: {
      source: "claude_transcript",
      kind: "run_command",
      command_sha256: "command-hash",
      evidence_fingerprint: evidenceFingerprint,
      request_id: "request-1"
    }
  });
  assert.deepEqual(Object.keys(candidate ?? {}), [
    "agent",
    "kind",
    "command",
    "tool_name",
    "request_detail",
    "cwd",
    "fingerprint",
    "terminal_target",
    "decision_mode",
    "command_source",
    "policy_evidence"
  ]);
  assert.equal(JSON.stringify(candidate),
    '{"agent":"claude","kind":"run_command","cwd":"/repo/project",' +
    '"fingerprint":"approval-1","terminal_target":"akk:0.1",' +
    '"command_source":"executor_local","policy_evidence":{' +
    '"source":"claude_transcript","kind":"run_command",' +
    '"command_sha256":"command-hash","evidence_fingerprint":"' +
    evidenceFingerprint + '","request_id":"request-1"}}');

  const malformedEvidenceCandidate = terminalMonitorApprovalCandidate({
    executorKind: "claude",
    terminalControl,
    terminalStatus: terminalStatus({
      approvable: true,
      policy_evidence: {
        source: "claude_transcript",
        kind: "run_command",
        command_sha256: 123,
        evidence_fingerprint: "",
        request_id: 456
      } as unknown as NonNullable<TerminalBridgeStatus["approval_state"]>["policy_evidence"]
    })
  });
  assert.deepEqual(
    (malformedEvidenceCandidate?.policy_evidence as Record<string, unknown>),
    {
      source: "claude_transcript",
      kind: "run_command",
      command_sha256: undefined,
      evidence_fingerprint: undefined,
      request_id: undefined
    }
  );
  assert.equal(
    JSON.stringify(malformedEvidenceCandidate?.policy_evidence),
    '{"source":"claude_transcript","kind":"run_command"}'
  );

  assert.equal(terminalMonitorApprovalFingerprint({
    terminalControl,
    terminalStatus: terminalStatus({ fingerprint: "adapter-fingerprint" })
  }), "adapter-fingerprint");
  assert.equal(terminalMonitorApprovalFingerprint({
    terminalControl,
    terminalStatus: terminalStatus({ blocked: true, approvable: false })
  }), "21f07418e742da2b2c19b42337b46496cf9ce4a904a4811951068acbe3fe5287");
  assert.throws(() => terminalMonitorApprovalFingerprint({
    terminalControl: { ...terminalControl, panePid: 1 },
    terminalStatus: terminalStatus({ blocked: true, approvable: false })
  }), /stable process anchor/u);

  const malformed = {
    ...terminalStatus(),
    approval_state: { approvable: "truthy" },
    screen: "not-an-object"
  } as unknown as TerminalBridgeStatus;
  assert.equal(terminalMonitorApprovalCandidate({
    executorKind: "claude",
    terminalControl,
    terminalStatus: malformed
  }), undefined);
  assert.equal(terminalMonitorApprovalFingerprint({
    terminalControl,
    terminalStatus: malformed
  }), "8502e58d2ee687c4b424837d5ebafed7d6d6e5a1158aac78ef118118ac11f174");
});

test("activity persistence cadence keeps disabled and bounded policies", () => {
  assert.equal(terminalMonitorActivityPersistIntervalMs(0, 5000), 300_000);
  assert.equal(terminalMonitorActivityPersistIntervalMs(1, 5000), 30_000);
  assert.equal(terminalMonitorActivityPersistIntervalMs(60, 5000), 300_000);
});
