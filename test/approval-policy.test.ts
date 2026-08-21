import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  approvalCandidateFromMessage,
  attemptAutoApproval,
  autoApprovalCliArgs,
  evaluateApprovalPolicy,
  parseSimpleShellCommand
} from "../src/approval-policy.js";

const candidate = {
  agent: "codex",
  kind: "run_command",
  command: "git status",
  cwd: "/repo/project",
  fingerprint: "approval-123",
  terminalTarget: "codex-work:0.1"
};

const policy = {
  enabled: true,
  rules: [{
    id: "safe-status",
    agents: ["codex"],
    workspaces: ["/repo/project"],
    commands: [["pwd"], ["git", "status"], ["git", "diff", "--stat"]]
  }]
};

test("approval policy allows an exact command in an allowed workspace", () => {
  const decision = evaluateApprovalPolicy({ policy, candidate });
  assert.equal(decision.action, "approve");
  assert.equal(decision.ruleId, "safe-status");
  assert.deepEqual(decision.argv, ["git", "status"]);
  assert.equal(decision.policyFingerprint.length, 16);
});

test("approval policy allows one trusted rule to cover multiple workspaces", () => {
  const multiWorkspacePolicy = {
    ...policy,
    rules: [{
      ...policy.rules[0],
      workspaces: ["/repo/project-a", "/repo/project-b"]
    }]
  };

  for (const cwd of ["/repo/project-a", "/repo/project-b/nested"]) {
    const decision = evaluateApprovalPolicy({
      policy: multiWorkspacePolicy,
      candidate: { ...candidate, cwd }
    });
    assert.equal(decision.action, "approve", cwd);
    assert.equal(decision.ruleId, "safe-status", cwd);
  }

  assert.equal(evaluateApprovalPolicy({
    policy: multiWorkspacePolicy,
    candidate: { ...candidate, cwd: "/repo/project-c" }
  }).action, "ask");
});

test("approval policy defaults to asking when disabled or unmatched", () => {
  assert.equal(evaluateApprovalPolicy({ policy: {}, candidate }).action, "ask");
  assert.equal(evaluateApprovalPolicy({
    policy,
    candidate: { ...candidate, command: "git push" }
  }).action, "ask");
  assert.equal(evaluateApprovalPolicy({
    policy,
    candidate: { ...candidate, cwd: "/repo/other" }
  }).action, "ask");
});

test("approval policy rejects relative workspace roots", () => {
  const relativePolicy = {
    ...policy,
    rules: [{
      ...policy.rules[0],
      workspaces: ["."]
    }]
  };
  assert.equal(evaluateApprovalPolicy({
    policy: relativePolicy,
    candidate: {
      ...candidate,
      cwd: process.cwd()
    }
  }).action, "ask");
});

test("Claude auto approval requires keys-mode local transcript evidence", () => {
  const claudePolicy = {
    enabled: true,
    rules: [{
      ...policy.rules[0],
      agents: ["claude"]
    }]
  };
  const claudeCandidate = {
    ...candidate,
    agent: "claude"
  };
  const missingMode = evaluateApprovalPolicy({
    policy: claudePolicy,
    candidate: claudeCandidate
  });
  assert.equal(missingMode.action, "ask");
  assert.match(missingMode.reason, /verified local transcript evidence/u);
  const screenWithoutEvidence = evaluateApprovalPolicy({
    policy: claudePolicy,
    candidate: { ...claudeCandidate, decisionMode: "keys" }
  });
  assert.equal(screenWithoutEvidence.action, "ask");
  assert.match(screenWithoutEvidence.reason, /verified local transcript evidence/u);

  const verified = evaluateApprovalPolicy({
    policy: claudePolicy,
    candidate: {
      ...claudeCandidate,
      decisionMode: "keys",
      evidenceSource: "claude_transcript",
      evidenceFingerprint: "a".repeat(64)
    }
  });
  assert.equal(verified.action, "approve");
  assert.equal(verified.ruleId, "safe-status");

  const malformedFingerprint = evaluateApprovalPolicy({
    policy: claudePolicy,
    candidate: {
      ...claudeCandidate,
      decisionMode: "keys",
      evidenceSource: "claude_transcript",
      evidenceFingerprint: "not-a-sha256"
    }
  });
  assert.equal(malformedFingerprint.action, "ask");
});

test("approval policy rejects shell composition and paths outside workspace", () => {
  assert.match(
    evaluateApprovalPolicy({
      policy: {
        enabled: true,
        rules: [{ ...policy.rules[0], commands: [["git", "status", "&&", "rm", "-rf", "."]] }]
      },
      candidate: { ...candidate, command: "git status && rm -rf ." }
    }).reason,
    /shell composition/
  );
  assert.equal(evaluateApprovalPolicy({
    policy: {
      enabled: true,
      rules: [{ ...policy.rules[0], commands: [["cat", "../secret.txt"]] }]
    },
    candidate: { ...candidate, command: "cat ../secret.txt" }
  }).action, "ask");
});

test("simple command parser supports quoted argv but rejects expansion", () => {
  assert.deepEqual(parseSimpleShellCommand("rg 'hello world' src").argv, ["rg", "hello world", "src"]);
  assert.equal(parseSimpleShellCommand("echo $(whoami)").ok, false);
  assert.equal(parseSimpleShellCommand("rg *.ts").ok, false);
  assert.equal(parseSimpleShellCommand("FOO=bar git status").ok, false);
  assert.equal(parseSimpleShellCommand("git status\nrm -rf .").ok, false);
  assert.equal(parseSimpleShellCommand("printf 'line one\nline two'").ok, false);
  assert.equal(parseSimpleShellCommand("echo \"!history\"").ok, false);
  assert.equal(parseSimpleShellCommand("echo {one,two}").ok, false);
  assert.equal(parseSimpleShellCommand("echo !history").ok, false);
});

test("approval candidate is read only from structured callback metadata", () => {
  assert.deepEqual(approvalCandidateFromMessage({
    type: "question",
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_candidate: {
        agent: "codex",
        kind: "run_command",
        command: "git status",
        cwd: "/repo/project",
        fingerprint: "approval-123",
        terminal_target: "codex-work:0.1"
      }
    }
  }), candidate);
  assert.equal(approvalCandidateFromMessage({ metadata: {} }), undefined);
  assert.equal(approvalCandidateFromMessage({
    type: "done",
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_candidate: candidate
    }
  }), undefined);

  assert.deepEqual(approvalCandidateFromMessage({
    type: "question",
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_candidate: {
        agent: "claude",
        kind: "run_command",
        cwd: "/repo/project",
        fingerprint: "claude-approval-123",
        terminal_target: "claude-work:0.1",
        decision_mode: "keys",
        policy_evidence: {
          source: "claude_transcript",
          kind: "run_command",
          command_sha256: "b".repeat(64),
          evidence_fingerprint: "c".repeat(64),
          request_id: "toolu_callback"
        }
      }
    }
  }), {
    agent: "claude",
    kind: "run_command",
    fingerprint: "claude-approval-123",
    decisionMode: "keys",
    command: undefined,
    cwd: "/repo/project",
    terminalTarget: "claude-work:0.1",
    evidenceSource: "claude_transcript",
    evidenceFingerprint: "c".repeat(64)
  });
});

test("auto approval CLI arguments carry the trusted policy for executor-side revalidation", () => {
  const decision = evaluateApprovalPolicy({ policy, candidate });
  assert.deepEqual(autoApprovalCliArgs({
    statePath: "/tmp/task/state.json",
    candidate,
    decision,
    policy
  }), [
    "approve",
    "--state",
    "/tmp/task/state.json",
    "--expected-approval-fingerprint",
    "approval-123",
    "--auto-approved",
    "--policy-rule-id",
    "safe-status",
    "--policy-fingerprint",
    decision.policyFingerprint,
    "--auto-approval-policy-json",
    JSON.stringify(policy)
  ]);
  assert.deepEqual(autoApprovalCliArgs({
    statePath: "/tmp/task/state.json",
    candidate,
    decision,
    policy,
    callbackAuthority: {
      conversationId: "turn-callback",
      sessionId: "session-callback",
      turnId: "turn-callback",
      messageId: "message-callback",
      openclawSession: "agent:main:callback"
    }
  })?.slice(-10), [
    "--expected-callback-conversation-id",
    "turn-callback",
    "--expected-callback-session-id",
    "session-callback",
    "--expected-callback-turn-id",
    "turn-callback",
    "--expected-callback-message-id",
    "message-callback",
    "--expected-callback-openclaw-session",
    "agent:main:callback"
  ]);
});

test("auto approval callback executes only a matching trusted policy", () => {
  const message = {
    type: "question",
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_candidate: {
        ...candidate,
        terminal_target: candidate.terminalTarget
      }
    }
  };
  const calls: string[][] = [];
  const approved = attemptAutoApproval({
    message,
    policy,
    statePath: "/tmp/task/state.json",
    execute: (args) => {
      calls.push(args);
      return { approved: true, monitor_pid: 42 };
    }
  });
  assert.equal(approved?.approved, true);
  assert.equal(approved?.handled, true);
  assert.equal(approved?.action, "approved");
  assert.equal(approved?.rule_id, "safe-status");
  assert.equal(approved?.monitor_pid, 42);
  assert.equal(calls.length, 1);

  const disabled = attemptAutoApproval({
    message,
    policy: { enabled: false },
    statePath: "/tmp/task/state.json",
    execute: (args) => {
      calls.push(args);
      return { approved: true };
    }
  });
  assert.equal(disabled?.approved, false);
  assert.equal(disabled?.handled, false);
  assert.equal(disabled?.action, "ask");
  assert.equal(calls.length, 1);
});

test("auto approval callback falls back to asking when fingerprint execution is rejected", () => {
  const result = attemptAutoApproval({
    message: {
      type: "question",
      metadata: {
        source: "terminal_bridge",
        reason: "approval_required",
        approval_candidate: {
          ...candidate,
          terminal_target: candidate.terminalTarget
        }
      }
    },
    policy,
    statePath: "/tmp/task/state.json",
    execute: () => ({ approved: false, reason: "approval fingerprint changed before execution" })
  });
  assert.equal(result?.approved, false);
  assert.equal(result?.handled, false);
  assert.equal(result?.action, "ask");
  assert.match(result?.reason ?? "", /fingerprint changed/);
});

test("auto approval retries treat only a locally consumed fingerprint as handled", () => {
  const message = {
    type: "question",
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_candidate: {
        ...candidate,
        terminal_target: candidate.terminalTarget
      }
    }
  };
  const consumed = attemptAutoApproval({
    message,
    policy,
    statePath: "/tmp/task/state.json",
    execute: () => ({
      approved: false,
      already_approved: true,
      reason: "approval fingerprint was already consumed"
    })
  });
  assert.equal(consumed?.approved, false);
  assert.equal(consumed?.handled, true);
  assert.equal(consumed?.action, "already_approved");

  const missingNotification = attemptAutoApproval({
    message,
    policy,
    statePath: "/tmp/task/state.json",
    execute: () => ({
      approved: false,
      reason: "approval requires a current managed-turn notification"
    })
  });
  assert.equal(missingNotification?.handled, false);
  assert.equal(missingNotification?.action, "ask");
});

test("Claude callback defers raw command matching to the local executor", () => {
  const claudePolicy = {
    enabled: true,
    rules: [{
      id: "claude-safe-status",
      agents: ["claude"],
      workspaces: ["/repo/project"],
      commands: [["git", "status"]]
    }]
  };
  const message = {
    type: "question",
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_candidate: {
        agent: "claude",
        kind: "run_command",
        cwd: "/repo/project",
        fingerprint: "claude-approval-123",
        terminal_target: "claude-work:0.1",
        decision_mode: "keys",
        policy_evidence: {
          source: "claude_transcript",
          kind: "run_command",
          command_sha256: "b".repeat(64),
          evidence_fingerprint: "c".repeat(64),
          request_id: "toolu_callback"
        }
      }
    }
  };
  const calls: string[][] = [];
  const result = attemptAutoApproval({
    message,
    policy: claudePolicy,
    statePath: "/tmp/task/state.json",
    execute(args) {
      calls.push(args);
      return {
        approved: true,
        policy_rule_id: "claude-safe-status",
        policy_fingerprint: evaluateApprovalPolicy({
          policy: claudePolicy,
          candidate: {
            agent: "claude",
            kind: "run_command",
            decisionMode: "keys",
            command: "git status",
            cwd: "/repo/project",
            fingerprint: "claude-approval-123",
            evidenceSource: "claude_transcript",
            evidenceFingerprint: "c".repeat(64)
          }
        }).policyFingerprint,
        monitor_pid: 73
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "approve",
    "--state",
    "/tmp/task/state.json",
    "--expected-approval-fingerprint",
    "claude-approval-123",
    "--auto-approved",
    "--policy-fingerprint",
    result?.policy_fingerprint,
    "--auto-approval-policy-json",
    JSON.stringify(claudePolicy)
  ]);
  assert.equal(result?.approved, true);
  assert.equal(result?.rule_id, "claude-safe-status");
  assert.equal(result?.monitor_pid, 73);
  assert.equal(
    JSON.stringify(message).includes("git status"),
    false,
    "the callback carries no raw transcript command"
  );
});

test("approval policy rejects a workspace symlink that resolves outside the workspace", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-approval-policy-"));
  const workspace = path.join(tempDir, "workspace");
  const outside = path.join(tempDir, "outside");
  try {
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "linked-outside"));
    const command = "cat linked-outside/missing.txt";
    const decision = evaluateApprovalPolicy({
      policy: {
        enabled: true,
        rules: [{
          id: "read-file",
          agents: ["codex"],
          workspaces: [workspace],
          commands: [["cat", "linked-outside/missing.txt"]]
        }]
      },
      candidate: {
        agent: "codex",
        kind: "run_command",
        command,
        cwd: workspace,
        fingerprint: "approval-symlink"
      }
    });
    assert.equal(decision.action, "ask");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
