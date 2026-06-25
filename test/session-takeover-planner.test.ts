import test from "node:test";
import assert from "node:assert/strict";
import type {
  ActiveCodexProcess,
  CodexSessionSummary,
  ForkContextPackage
} from "../src/codex-session-provider.js";
import {
  matchingActiveProcesses,
  planFork,
  planTakeover
} from "../src/session-takeover-planner.js";

const session: CodexSessionSummary = {
  id: "019ee559-7bb8-7fd1-970c-0f7b6978c44e",
  cwd: "/repo/acpx",
  rolloutPath: "/rollout.jsonl",
  title: "inspect ACPX changes",
  updatedAtMs: 100,
  archived: false,
  capability: "full"
};

test("takeover requires an exact active session match before planning termination", () => {
  const plan = planTakeover(session, [
    activeCodex({
      pid: 100,
      ppid: 1,
      sessionId: session.id,
      cwd: session.cwd,
      command: `node bin/codex resume ${session.id}`
    }),
    activeCodex({
      pid: 101,
      ppid: 100,
      sessionId: session.id,
      cwd: session.cwd,
      command: `vendor/bin/codex resume ${session.id}`
    })
  ]);

  assert.equal(plan.allowed, true);
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.reason, "active_cli_conflict");
  assert.deepEqual(plan.targets, [{
    pid: 100,
    childPids: [101],
    cwd: session.cwd,
    command: `node bin/codex resume ${session.id}`,
    sessionId: session.id
  }]);
  assert.deepEqual(plan.resumeAfterExit, {
    sessionId: session.id,
    cwd: session.cwd
  });
});

test("takeover refuses cwd-only active matches because the session identity is ambiguous", () => {
  const plan = planTakeover(session, [
    activeCodex({
      pid: 200,
      cwd: session.cwd,
      command: "node bin/codex -- --full-auto"
    })
  ]);

  assert.equal(plan.allowed, false);
  assert.equal(plan.requiresConfirmation, false);
  assert.equal(plan.reason, "ambiguous_active_cli");
  assert.equal(plan.targets[0].pid, 200);
});

test("matching active processes ignores Codex ACP adapters for takeover targets", () => {
  const matches = matchingActiveProcesses(session, [
    activeCodex({
      pid: 1,
      cwd: session.cwd,
      sessionId: session.id
    }),
    {
      pid: 2,
      command: "codex-acp",
      cwd: session.cwd,
      kind: "codex_acp",
      sessionId: session.id,
      confidence: "medium",
      reason: "adapter"
    }
  ]);

  assert.deepEqual(matches.map((match) => match.pid), [1]);
});

test("fork plan uses OpenClaw summary confirmation instead of direct raw rollout injection", () => {
  const contextPackage: ForkContextPackage = {
    source: {
      agent: "codex",
      sessionId: session.id,
      cwd: session.cwd,
      title: session.title,
      updatedAtMs: session.updatedAtMs
    },
    messages: [{
      role: "user",
      text: "review latest ACPX changes"
    }],
    commands: [{
      command: "git pull",
      cwd: session.cwd,
      status: "0"
    }],
    truncated: false
  };

  const plan = planFork(session, contextPackage);

  assert.equal(plan.allowed, true);
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.requiresOpenClawSummary, true);
  assert.equal(plan.reason, "fork_context_ready");
  assert.equal(plan.source.sessionId, session.id);
  assert.equal(plan.contextPackage, contextPackage);
});

function activeCodex(overrides: Partial<ActiveCodexProcess>): ActiveCodexProcess {
  return {
    pid: 1,
    command: "codex",
    cwd: "/repo/acpx",
    kind: "codex_cli",
    confidence: "high",
    reason: "test",
    ...overrides
  };
}
