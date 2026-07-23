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

test("Claude tmux approval never enters automatic approval", () => {
  const claudePolicy = {
    enabled: true,
    rules: [{
      ...policy.rules[0],
      agents: ["claude"]
    }]
  };
  const claudeCandidate = {
    ...candidate,
    agent: "claude",
    decisionMode: "structured" as const
  };
  const structured = evaluateApprovalPolicy({
    policy: claudePolicy,
    candidate: claudeCandidate
  });
  assert.equal(structured.action, "ask");
  assert.match(structured.reason, /explicit user confirmation/u);
  const screenFallback = evaluateApprovalPolicy({
    policy: claudePolicy,
    candidate: { ...claudeCandidate, decisionMode: "keys" }
  });
  assert.equal(screenFallback.action, "ask");
  assert.match(screenFallback.reason, /explicit user confirmation/u);
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
  assert.equal(result?.action, "ask");
  assert.match(result?.reason ?? "", /fingerprint changed/);
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
