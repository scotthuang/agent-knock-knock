import assert from "node:assert/strict";
import test from "node:test";

import {
  ManagedTurnRecoveryService,
  type ManagedTurnRecoveryPorts,
  type VirginCodexRecoveryFacts
} from "../src/managed-turn-recovery-service.js";
import type { TerminalNativeIdentity } from
  "../src/terminal-binding-authority.js";

const CONTROL = {
  kind: "tmux" as const,
  target: "akk:0.0",
  session: "akk",
  window: 0,
  pane: 0,
  panePid: 42,
  currentPath: "/workspace",
  capabilities: []
};
const ROLLOUT = {
  fd: "7",
  device: "1",
  inode: "2",
  path: "/tmp/rollout.jsonl"
};
const IDENTITY: TerminalNativeIdentity = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  processUuid: "codex-pid:42:birth:1",
  processBirth: "1",
  rollout: ROLLOUT,
  evidence: "codex_rollout_fd"
};

function facts(
  overrides: Partial<VirginCodexRecoveryFacts> = {}
): VirginCodexRecoveryFacts {
  return {
    agent: "codex",
    anchorVersion: 2,
    anchorNativeThreadBinding: "post_submission",
    anchorProcessUuid: IDENTITY.processUuid,
    anchorProcessBirth: IDENTITY.processBirth,
    terminalControl: CONTROL,
    initialTerminalIncarnationMatches: true,
    submissionStatus: "enter_dispatched",
    messageId: "msg-1",
    takeoverMessageId: "msg-1",
    requestHash: "a".repeat(64),
    computedRequestHash: "a".repeat(64),
    bindingId: "binding-1",
    bindingGeneration: 3,
    pid: 42,
    sessionId: "session-1",
    sessionAgent: "codex",
    sessionStatus: "bound",
    sessionBinding: {
      bindingId: "binding-1",
      generation: 3,
      pid: 42,
      terminalIncarnationMatches: true,
      processUuid: IDENTITY.processUuid,
      processBirth: IDENTITY.processBirth
    },
    turnProcessUuid: IDENTITY.processUuid,
    turnProcessBirth: IDENTITY.processBirth,
    ...overrides
  };
}

function recordingPorts(
  events: string[],
  accepted = true
): ManagedTurnRecoveryPorts {
  return {
    identity: {
      resolve: async ({ preferredSessionId }) => {
        events.push(`resolve:${preferredSessionId ?? "fresh"}`);
        return IDENTITY;
      },
      resolveCandidate: async ({ requestHash }) => {
        events.push(`resolve-candidate:${requestHash}`);
        return IDENTITY;
      }
    },
    acceptance: {
      detect: (_identity, requestHash) => {
        events.push(`detect:${requestHash}`);
        return accepted;
      }
    },
    authority: {
      prepareIdentityClaim: async ({ sessionId }) => {
        events.push(`exclusive:${sessionId}`);
      },
      assertTurn: (identity) => {
        events.push(`assert:${identity?.sessionId ?? "durable"}`);
      }
    },
    persistence: {
      persistSessionIdentity: (identity) => {
        events.push("persist:session");
        return {
          nativeThreadId: identity.sessionId,
          processUuid: identity.processUuid,
          processBirth: identity.processBirth,
          rollout: identity.rollout
        };
      },
      persistTurnIdentity: () => {
        events.push("persist:turn");
      }
    }
  };
}

test("virgin recovery proves acceptance before ownership and Session/Turn CAS", async () => {
  const events: string[] = [];
  const result = await new ManagedTurnRecoveryService(recordingPorts(events))
    .recover(facts());
  assert.equal(result.state, "recovered");
  assert.deepEqual(events, [
    "resolve:fresh",
    `detect:${"a".repeat(64)}`,
    "exclusive:session-1",
    "persist:session",
    "persist:turn",
    `assert:${IDENTITY.sessionId}`
  ]);
});

test("missing exact acceptance stays pending before ownership or persistence", async () => {
  const events: string[] = [];
  const result = await new ManagedTurnRecoveryService(
    recordingPorts(events, false)
  ).recover(facts());
  assert.deepEqual(result, { state: "pending" });
  assert.deepEqual(events, [
    "resolve:fresh",
    `detect:${"a".repeat(64)}`
  ]);
});

test("candidate-set recovery treats its uniquely accepted identity as acceptance proof", async () => {
  const events: string[] = [];
  const result = await new ManagedTurnRecoveryService(recordingPorts(events))
    .recover(facts({ anchorVersion: 3 }));
  assert.equal(result.state, "recovered");
  assert.deepEqual(events, [
    `resolve-candidate:${"a".repeat(64)}`,
    "exclusive:session-1",
    "persist:session",
    "persist:turn",
    `assert:${IDENTITY.sessionId}`
  ]);
});

test("candidate-set recovery follows a durable rollout across descriptor churn", async () => {
  const events: string[] = [];
  const reopenedIdentity: TerminalNativeIdentity = {
    ...IDENTITY,
    rollout: { ...ROLLOUT, fd: "91r" }
  };
  const ports = recordingPorts(events);
  ports.identity.resolveCandidate = async ({ requestHash, recoveryIdentity }) => {
    events.push(`resolve-candidate:${requestHash}`);
    assert.deepEqual(recoveryIdentity, IDENTITY);
    return reopenedIdentity;
  };
  const result = await new ManagedTurnRecoveryService(ports).recover(facts({
    anchorVersion: 3,
    sessionBinding: {
      bindingId: "binding-1",
      generation: 3,
      pid: 42,
      terminalIncarnationMatches: true,
      nativeThreadId: IDENTITY.sessionId,
      processUuid: IDENTITY.processUuid,
      processBirth: IDENTITY.processBirth,
      rollout: ROLLOUT
    }
  }));
  assert.equal(result.state, "recovered");
  assert.deepEqual(result.identity, reopenedIdentity);
  assert.deepEqual(events, [
    `resolve-candidate:${"a".repeat(64)}`,
    "exclusive:session-1",
    "persist:turn",
    `assert:${IDENTITY.sessionId}`
  ]);
});

test("candidate-set recovery accepts a stable persisted Session proof after descriptor churn", async () => {
  const events: string[] = [];
  const reopenedIdentity: TerminalNativeIdentity = {
    ...IDENTITY,
    rollout: { ...ROLLOUT, fd: "91r" }
  };
  const ports = recordingPorts(events);
  ports.identity.resolveCandidate = async ({ requestHash, recoveryIdentity }) => {
    events.push(`resolve-candidate:${requestHash}`);
    assert.deepEqual(recoveryIdentity, IDENTITY);
    return reopenedIdentity;
  };
  ports.persistence.persistSessionIdentity = () => {
    events.push("persist:session");
    return {
      nativeThreadId: IDENTITY.sessionId,
      processUuid: IDENTITY.processUuid,
      processBirth: IDENTITY.processBirth,
      rollout: ROLLOUT
    };
  };
  const result = await new ManagedTurnRecoveryService(ports).recover(facts({
    anchorVersion: 3,
    turnNativeThreadId: IDENTITY.sessionId,
    turnRollout: ROLLOUT
  }));
  assert.equal(result.state, "recovered");
  assert.deepEqual(events, [
    `resolve-candidate:${"a".repeat(64)}`,
    "exclusive:session-1",
    "persist:session",
    `assert:${IDENTITY.sessionId}`
  ]);
});

test("version 2 recovery keeps descriptor identity strict", async () => {
  const events: string[] = [];
  const ports = recordingPorts(events);
  ports.identity.resolve = async ({ preferredSessionId }) => {
    events.push(`resolve:${preferredSessionId ?? "fresh"}`);
    return {
      ...IDENTITY,
      rollout: { ...ROLLOUT, fd: "91r" }
    };
  };
  await assert.rejects(
    new ManagedTurnRecoveryService(ports).recover(facts({
      sessionBinding: {
        bindingId: "binding-1",
        generation: 3,
        pid: 42,
        terminalIncarnationMatches: true,
        nativeThreadId: IDENTITY.sessionId,
        processUuid: IDENTITY.processUuid,
        processBirth: IDENTITY.processBirth,
        rollout: ROLLOUT
      }
    })),
    /native identity changed before binding recovery/u
  );
  assert.deepEqual(events, [`resolve:${IDENTITY.sessionId}`]);
});

test("durable Session identity finishes only the missing Turn side", async () => {
  const events: string[] = [];
  const result = await new ManagedTurnRecoveryService(recordingPorts(events))
    .recover(facts({
      sessionBinding: {
        bindingId: "binding-1",
        generation: 3,
        pid: 42,
        terminalIncarnationMatches: true,
        nativeThreadId: IDENTITY.sessionId,
        processUuid: IDENTITY.processUuid,
        processBirth: IDENTITY.processBirth,
        rollout: ROLLOUT
      }
    }));
  assert.equal(result.state, "recovered");
  assert.deepEqual(events, [
    `resolve:${IDENTITY.sessionId}`,
    "exclusive:session-1",
    "persist:turn",
    `assert:${IDENTITY.sessionId}`
  ]);
});

test("already-bound recovery validates current Turn without native reads", async () => {
  const events: string[] = [];
  const result = await new ManagedTurnRecoveryService(recordingPorts(events))
    .recover(facts({
      turnNativeThreadId: IDENTITY.sessionId,
      turnRollout: ROLLOUT,
      sessionBinding: {
        bindingId: "binding-1",
        generation: 3,
        pid: 42,
        terminalIncarnationMatches: true,
        nativeThreadId: IDENTITY.sessionId,
        processUuid: IDENTITY.processUuid,
        processBirth: IDENTITY.processBirth,
        rollout: ROLLOUT
      }
    }));
  assert.deepEqual(result, { state: "already_bound" });
  assert.deepEqual(events, ["assert:durable"]);
});
